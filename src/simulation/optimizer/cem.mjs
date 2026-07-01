/*
 * -----------------------------------------------------------------------------
 * AI reinforcement learning — Cross-Entropy Method (CEM) self-play trainer for v0.5.
 *
 * The battle engine has no board-state clone/rollback, so value-lookahead / MCTS is impossible. The RL
 * family that fits is black-box POLICY SEARCH: v0.5 scores its decisions with a weight vector, and we
 * search that vector by self-play. CEM — sample a population from a Gaussian, evaluate each by the
 * self-play decisive WIN RATE vs a frozen v0.4, keep the elite, refit the Gaussian, repeat.
 *
 * Determinism makes ranking clean: every candidate in a generation plays the SAME seed set, so their win
 * rates are directly comparable with no run-to-run noise.
 *
 * LONG-RUN MODE (set CEM_HOURS): after each GENS-generation pass the search RE-INFLATES sigma and restarts
 * from the best-so-far, repeating until the deadline — so a multi-hour run keeps exploring instead of
 * converging in the first hour. To stay HONEST over a long run, the global best is selected on a PANEL of
 * held-out seeds (CEM_VAL_SEEDS), never a single seed — this is the anti-overfit gate. Each candidate's
 * tournament output files are deleted after scoring so disk doesn't fill. The winning vector is written to
 * sim-out/cem/best.json (also a stamped best-<score>.json) for review/baking; nothing here edits source.
 *
 *   CEM_HOURS=12 nohup bun src/simulation/optimizer/cem.mjs &
 * Tunables (env): CEM_POP, CEM_ELITE, CEM_GENS, CEM_GAMES, CEM_VAL_GAMES, CEM_VAL_SEEDS, CEM_SEED,
 *                 CEM_SIGMA, CEM_MEAN (JSON), CEM_DIM, CEM_LO, CEM_HI, CEM_HOURS, OPT_VERSION, BASE_VERSION.
 * -----------------------------------------------------------------------------
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
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
const DEFAULT_MEAN = JSON.parse(process.env.CEM_MEAN ?? "[1.0,0.0,1.0,0.0,0.0,1.0]");
const DIM = Number(process.env.CEM_DIM ?? DEFAULT_MEAN.length);
const POP = Number(process.env.CEM_POP ?? 16);
const ELITE = Number(process.env.CEM_ELITE ?? 4);
const GENS = Number(process.env.CEM_GENS ?? 12); // generations per restart pass
const GAMES = Number(process.env.CEM_GAMES ?? 2200); // games per candidate (training)
const VAL_GAMES = Number(process.env.CEM_VAL_GAMES ?? 4000); // games per validation seed
const SEED0 = Number(process.env.CEM_SEED ?? 12345);
// Held-out PANEL for honest selection — distinct from the training seeds (SEED0 + pass*1e6 + gen*7919).
const VAL_SEEDS = (process.env.CEM_VAL_SEEDS ?? "9000011,9000017,9000019,9000023,9000029")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
const SIGMA0 = Number(process.env.CEM_SIGMA ?? 0.6);
const SIGMA_FLOOR = Number(process.env.CEM_SIGMA_FLOOR ?? 0.05);
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY ?? 0.92);
const LO = Number(process.env.CEM_LO ?? -3);
const HI = Number(process.env.CEM_HI ?? 6);
const HOURS = Number(process.env.CEM_HOURS ?? 0); // >0 => keep restarting until this many hours elapse
const DEADLINE = HOURS > 0 ? Date.now() + HOURS * 3600 * 1000 : 0;
// Freeze the leading dims [0, FREEZE_BELOW) at the mean (sigma 0) — search only the trailing dims. Used to
// bolt a NEW feature block onto a proven vector without disturbing it (e.g. mountain mining dims 26..32).
const FREEZE_BELOW = Number(process.env.CEM_FREEZE_BELOW ?? 0);
const maskFrozen = (s) => s.map((v, d) => (d < FREEZE_BELOW ? 0 : v));

// Seeded PRNG (mulberry32) + Box-Muller.
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

// Concurrency: the machine has CORES logical CPUs. Running candidates ONE at a time leaves cores idle
// (a single tournament doesn't saturate them, and each pays bun-startup serially). Instead run CEM_BATCH
// candidates at once, each tournament given CORES/BATCH worker concurrency, so the cores stay pinned and the
// startups overlap. Each concurrent eval writes to a UNIQUE temp dir to avoid summary-file races.
const CORES = Math.max(1, availableParallelism());
const BATCH = Math.max(1, Number(process.env.CEM_BATCH ?? 3));
const PER_CONC = Math.max(1, Math.floor(CORES / BATCH));
let evalUid = 0;

/** Run N items through fn in concurrent batches of BATCH; preserves order. */
async function mapBatched(items, fn) {
    const out = new Array(items.length);
    for (let i = 0; i < items.length; i += BATCH) {
        const slice = items.slice(i, i + BATCH);
        const res = await Promise.all(slice.map((it) => fn(it)));
        for (let j = 0; j < res.length; j += 1) out[i + j] = res[j];
    }
    return out;
}

/**
 * One self-play tournament of OPT(weights) vs BASE at a fixed seed -> decisive win rate of OPT.
 * Retries a flaky subprocess up to 3x; returns null on total failure. Deletes the tournament's output
 * files after scoring (disk hygiene for long runs).
 */
async function evalWeights(weights, seed, games) {
    const env = { ...process.env, V05_WEIGHTS: JSON.stringify(weights) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const dir = join(STATE_DIR, `eval_${process.pid}_${evalUid++}`);
        try {
            mkdirSync(dir, { recursive: true });
            // outDir = unique temp dir, concurrency = PER_CONC (6th positional). CEM_MAPS controls the layout
            // sample: default "--maps" = every layout; e.g. "--maps=block" to train a block-only feature.
            const mapsFlag = process.env.CEM_MAPS ?? "--maps";
            await new Promise((resolve, reject) => {
                const p = spawn(
                    "bun",
                    ["src/simulation/run_tournament.ts", OPT, BASE, String(games), String(seed), dir, String(PER_CONC), mapsFlag],
                    { cwd: REPO, env, stdio: "ignore" },
                );
                p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("exit " + code))));
                p.on("error", reject);
            });
            const f = readdirSync(dir).find((x) => x.endsWith(".summary.json"));
            if (!f) {
                throw new Error("no summary produced");
            }
            const sum = JSON.parse(readFileSync(join(dir, f), "utf8"));
            rmSync(dir, { recursive: true, force: true });
            const decisive = sum.a.wins + sum.b.wins;
            return decisive ? sum.a.wins / decisive : 0;
        } catch (e) {
            rmSync(dir, { recursive: true, force: true });
            console.log(`[cem] tournament failed (seed ${seed}, attempt ${attempt + 1}/3): ${String(e).slice(0, 120)}`);
        }
    }
    return null;
}

/** Honest selection metric: average win rate over the held-out seed PANEL (anti-overfit), panel runs concurrent. */
async function panelVal(weights) {
    const scores = (await mapBatched(VAL_SEEDS, (s) => evalWeights(weights, s, VAL_GAMES))).filter((x) => x != null);
    if (!scores.length) {
        return -1;
    }
    return scores.reduce((a, b) => a + b, 0) / scores.length;
}

if (!existsSync(LOG)) {
    writeFileSync(
        LOG,
        `# ${OPT} CEM self-play log (reward = decisive win% vs frozen ${BASE})\n\n` +
            `dim=${DIM} pop=${POP} elite=${ELITE} games/cand=${GAMES} panel=[${VAL_SEEDS.join(",")}]x${VAL_GAMES}` +
            `${HOURS ? ` hours=${HOURS}` : ""}\n\n` +
            `| pass | gen | traj win% | best-cand | panel best% | mean weights |\n|---|---|---|---|---|---|\n`,
    );
}

let globalMean = DEFAULT_MEAN.slice();
let globalBest = { panel: -1, weights: globalMean.slice(), pass: 0 };
const basePanel = await panelVal(DEFAULT_MEAN);
globalBest = { panel: basePanel, weights: DEFAULT_MEAN.slice(), pass: 0 };
writeFileSync(
    BEST,
    JSON.stringify({ ...globalBest, base: BASE, opt: OPT, valGames: VAL_GAMES, panelSeeds: VAL_SEEDS }, null, 2),
);
console.log(`[cem] start panel (default) over ${VAL_SEEDS.length} held-out seeds: ${(basePanel * 100).toFixed(2)}%`);

let pass = 0;
do {
    pass += 1;
    let mean = globalBest.weights.slice(); // each pass restarts from the best-so-far
    let sigma = maskFrozen(new Array(DIM).fill(SIGMA0)); // re-inflated so the search keeps exploring (frozen dims: 0)
    for (let gen = 1; gen <= GENS; gen += 1) {
        const seed = SEED0 + pass * 1_000_003 + gen * 7919; // distinct from the held-out panel seeds
        const popW = [mean.slice()];
        for (let k = 1; k < POP; k += 1) {
            popW.push(mean.map((m, d) => clip(m + sigma[d] * gauss())));
        }
        const fits = await mapBatched(popW, (w) => evalWeights(w, seed, GAMES));
        const scored = popW.map((w, i) => ({ w, fit: fits[i] ?? -1 }));
        scored.sort((a, b) => b.fit - a.fit);
        const elite = scored.slice(0, ELITE);
        const newMean = new Array(DIM).fill(0);
        for (const e of elite) for (let d = 0; d < DIM; d += 1) newMean[d] += e.w[d] / ELITE;
        const newSigma = new Array(DIM).fill(0);
        for (const e of elite) for (let d = 0; d < DIM; d += 1) newSigma[d] += (e.w[d] - newMean[d]) ** 2 / ELITE;
        mean = newMean;
        sigma = maskFrozen(newSigma.map((v) => Math.max(SIGMA_FLOOR, Math.sqrt(v) * SIGMA_DECAY)));
        // Cheap per-gen trajectory on one rotating panel seed (full panel is too costly every gen).
        const trajSeed = VAL_SEEDS[gen % VAL_SEEDS.length];
        const traj = (await evalWeights(mean, trajSeed, VAL_GAMES)) ?? -1;
        appendFileSync(
            LOG,
            `| ${pass} | ${gen} | ${(traj * 100).toFixed(2)}% | ${(elite[0].fit * 100).toFixed(2)}% | ${(globalBest.panel * 100).toFixed(2)}% | ${fmt(mean)} |\n`,
        );
        console.log(
            `[cem] pass ${pass} gen ${gen}/${GENS}: best-cand ${(elite[0].fit * 100).toFixed(2)}% | ` +
                `traj ${(traj * 100).toFixed(2)}% | global-best(panel) ${(globalBest.panel * 100).toFixed(2)}%`,
        );
        writeFileSync(STATE, JSON.stringify({ pass, gen, mean, sigma, globalBest, base: BASE, opt: OPT }, null, 2));
    }
    // End of pass: rigorously validate this pass's mean on the full held-out panel.
    const passPanel = await panelVal(mean);
    if (passPanel > globalBest.panel) {
        globalBest = { panel: passPanel, weights: mean.slice(), pass };
        writeFileSync(
            BEST,
            JSON.stringify(
                { ...globalBest, base: BASE, opt: OPT, valGames: VAL_GAMES, panelSeeds: VAL_SEEDS },
                null,
                2,
            ),
        );
        writeFileSync(
            join(STATE_DIR, `best-${(passPanel * 100).toFixed(2)}-pass${pass}.json`),
            JSON.stringify(globalBest),
        );
        console.log(`[cem] pass ${pass} IMPROVED -> panel ${(passPanel * 100).toFixed(2)}% (new global best).`);
    } else {
        console.log(
            `[cem] pass ${pass} panel ${(passPanel * 100).toFixed(2)}% <= global best ${(globalBest.panel * 100).toFixed(2)}% — restart from best.`,
        );
    }
    globalMean = globalBest.weights;
    appendFileSync(
        LOG,
        `| ${pass} | END | panel ${(passPanel * 100).toFixed(2)}% | | ${(globalBest.panel * 100).toFixed(2)}% | ${fmt(globalMean)} |\n`,
    );
} while (DEADLINE && Date.now() < DEADLINE);

console.log(
    `\n[cem] DONE after ${pass} pass(es). global best panel ${(globalBest.panel * 100).toFixed(2)}% (pass ${globalBest.pass}).`,
);
console.log(`[cem] best weights: ${fmt(globalBest.weights)}`);
console.log(`[cem] saved to ${BEST}.`);
