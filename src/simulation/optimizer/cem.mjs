/*
 * -----------------------------------------------------------------------------
 * AI reinforcement learning — Cross-Entropy Method (CEM) self-play trainer for v0.5.
 *
 * The battle engine has no board-state clone/rollback, so value-lookahead / MCTS is impossible. The RL
 * family that DOES fit is black-box POLICY SEARCH: v0.5 scores its decisions with a weight vector, and we
 * search that vector by self-play. CEM is the workhorse — sample a population of weight vectors from a
 * Gaussian, evaluate each by the self-play decisive WIN RATE vs a frozen v0.4, keep the top "elite",
 * refit the Gaussian to the elite, repeat. Reward = win rate; no gradients, no cloning.
 *
 * Determinism makes this clean: every candidate in a generation plays the SAME seed set (identical
 * rosters + maps), so their win rates are directly comparable with no run-to-run noise — the ranking is
 * exact. The seed ROTATES per generation (and a separate fixed VALIDATION seed tracks the mean's honest
 * trajectory) so the elite must generalise rather than overfit one scenario set.
 *
 * Weights reach the tournament workers via process.env.V05_WEIGHTS (a JSON number[]); v0_5_weights.ts
 * reads it. Nothing here edits source — the winning vector is printed and saved to sim-out/cem/best.json
 * for review, then baked into v0_5_weights.ts by hand.
 *
 *   node src/simulation/optimizer/cem.mjs
 * Tunables (env): CEM_POP, CEM_ELITE, CEM_GENS, CEM_GAMES, CEM_VAL_GAMES, CEM_SEED, CEM_SIGMA,
 *                 CEM_MEAN (JSON), CEM_DIM, CEM_LO, CEM_HI, OPT_VERSION, BASE_VERSION.
 * -----------------------------------------------------------------------------
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", ".."); // game/heroes-of-crypto-common
const OUT = join(REPO, "sim-out");
const STATE_DIR = join(OUT, "cem");
const LOG = join(STATE_DIR, "log.md");
const BEST = join(STATE_DIR, "best.json");
const STATE = join(STATE_DIR, "state.json");
mkdirSync(STATE_DIR, { recursive: true });

const OPT = process.env.OPT_VERSION ?? "v0.5";
const BASE = process.env.BASE_VERSION ?? "v0.4";
const DEFAULT_MEAN = JSON.parse(process.env.CEM_MEAN ?? "[1.0,0.0,1.0,0.0,0.0,1.0]"); // == v0.4 shot scoring
const DIM = Number(process.env.CEM_DIM ?? DEFAULT_MEAN.length);
const POP = Number(process.env.CEM_POP ?? 16);
const ELITE = Number(process.env.CEM_ELITE ?? 4);
const GENS = Number(process.env.CEM_GENS ?? 20);
const GAMES = Number(process.env.CEM_GAMES ?? 3000); // games per candidate evaluation
const VAL_GAMES = Number(process.env.CEM_VAL_GAMES ?? 6000); // games for the held-out mean trajectory
const SEED0 = Number(process.env.CEM_SEED ?? 12345);
const VAL_SEED = Number(process.env.CEM_VAL_SEED ?? 7000019);
const SIGMA0 = Number(process.env.CEM_SIGMA ?? 0.6);
const SIGMA_FLOOR = Number(process.env.CEM_SIGMA_FLOOR ?? 0.05);
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY ?? 0.92);
const LO = Number(process.env.CEM_LO ?? -3);
const HI = Number(process.env.CEM_HI ?? 6);

// Seeded PRNG (mulberry32) + Box-Muller, so a CEM run reproduces exactly from CEM_SEED.
function mulberry32(a) {
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32((SEED0 ^ 0x9e3779b9) >>> 0);
const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clip = (x) => Math.min(HI, Math.max(LO, x));
const fmt = (a) => "[" + a.map((x) => x.toFixed(3)).join(", ") + "]";

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: "pipe", ...opts });

/** Run one self-play tournament of OPT(weights) vs BASE at a fixed seed; return decisive win rate of OPT. */
function evalWeights(weights, seed, games) {
    const before = new Set(readdirSync(OUT).filter((f) => f.endsWith(".summary.json")));
    const env = { ...process.env, V05_WEIGHTS: JSON.stringify(weights) };
    // outDir is the last positional -> concurrency defaults to all cores. --maps samples every layout.
    sh(`bun src/simulation/run_tournament.ts ${OPT} ${BASE} ${games} ${seed} ${JSON.stringify(OUT)} --maps`, {
        stdio: "ignore",
        env,
    });
    const summaryPath = readdirSync(OUT)
        .filter((f) => f.startsWith(`${OPT}_vs_${BASE}_`) && f.endsWith(".summary.json") && !before.has(f))
        .map((f) => join(OUT, f))
        .sort()
        .pop();
    if (!summaryPath) {
        throw new Error("no summary produced");
    }
    const sum = JSON.parse(readFileSync(summaryPath, "utf8"));
    const decisive = sum.a.wins + sum.b.wins;
    return decisive ? sum.a.wins / decisive : 0;
}

if (!existsSync(LOG)) {
    writeFileSync(
        LOG,
        `# ${OPT} CEM self-play log (reward = decisive win% vs frozen ${BASE})\n\n` +
            `dim=${DIM} pop=${POP} elite=${ELITE} games/cand=${GAMES} val=${VAL_GAMES}\n\n` +
            `| gen | seed | mean win% (val) | best-cand win% | elite mean weights |\n|---|---|---|---|---|\n`,
    );
}

let mean = DEFAULT_MEAN.slice();
let sigma = new Array(DIM).fill(SIGMA0);
let bestEver = { winRate: -1, weights: mean.slice(), gen: -1 };

// Baseline: the default vector (== v0.4) on the validation seed. v0.5 vs v0.4 with identical weights is
// the mirror self-play floor (~50%); anything the search finds above this is a real learned edge.
const baseVal = evalWeights(DEFAULT_MEAN, VAL_SEED, VAL_GAMES);
console.log(`[cem] baseline (default==${BASE}) on val seed: ${(baseVal * 100).toFixed(2)}%`);

for (let gen = 1; gen <= GENS; gen += 1) {
    const seed = SEED0 + gen * 7919;
    // Population: the current mean (anchor) + POP-1 Gaussian samples around it.
    const pop = [mean.slice()];
    for (let k = 1; k < POP; k += 1) {
        pop.push(mean.map((m, d) => clip(m + sigma[d] * gauss())));
    }
    const scored = pop.map((w) => ({ w, fit: evalWeights(w, seed, GAMES) }));
    scored.sort((a, b) => b.fit - a.fit);
    const elite = scored.slice(0, ELITE);

    // Refit the Gaussian to the elite; decay + floor sigma so it converges but never collapses.
    const newMean = new Array(DIM).fill(0);
    for (const e of elite) {
        for (let d = 0; d < DIM; d += 1) newMean[d] += e.w[d] / ELITE;
    }
    const newSigma = new Array(DIM).fill(0);
    for (const e of elite) {
        for (let d = 0; d < DIM; d += 1) newSigma[d] += (e.w[d] - newMean[d]) ** 2 / ELITE;
    }
    mean = newMean;
    // sigma = elite std, decayed each gen, never below the floor (so the search keeps exploring).
    sigma = newSigma.map((v) => Math.max(SIGMA_FLOOR, Math.sqrt(v) * SIGMA_DECAY));

    // Honest trajectory: re-evaluate the refit MEAN on the fixed held-out validation seed.
    const valWin = evalWeights(mean, VAL_SEED, VAL_GAMES);
    if (valWin > bestEver.winRate) {
        bestEver = { winRate: valWin, weights: mean.slice(), gen };
        writeFileSync(BEST, JSON.stringify({ ...bestEver, base: BASE, opt: OPT, valGames: VAL_GAMES }, null, 2));
    }
    writeFileSync(STATE, JSON.stringify({ gen, seed, mean, sigma, bestEver, baseVal, opt: OPT, base: BASE }, null, 2));
    appendFileSync(
        LOG,
        `| ${gen} | ${seed} | ${(valWin * 100).toFixed(2)}% | ${(elite[0].fit * 100).toFixed(2)}% | ${fmt(mean)} |\n`,
    );
    console.log(
        `[cem] gen ${gen}/${GENS} seed ${seed}: best-cand ${(elite[0].fit * 100).toFixed(2)}% | ` +
            `mean(val) ${(valWin * 100).toFixed(2)}% | best-ever ${(bestEver.winRate * 100).toFixed(2)}% (gen ${bestEver.gen}) | mean ${fmt(mean)}`,
    );
}

console.log(
    `\n[cem] DONE. baseline ${(baseVal * 100).toFixed(2)}% -> best mean ${(bestEver.winRate * 100).toFixed(2)}% (gen ${bestEver.gen}).`,
);
console.log(`[cem] best weights: ${fmt(bestEver.weights)}`);
console.log(`[cem] saved to ${BEST}. Bake into src/ai/versions/v0_5_weights.ts (DEFAULT_V05_W) to ship.`);
