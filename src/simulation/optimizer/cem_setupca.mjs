/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * CEM trainer for the VISION-GATED joint perk+augment setup policy (20-dim = 4 kinds x 5 features). Mirrors
 * cem_setup.mjs: mean starts at the all-zero anchor (which reproduces the value-only greedy {Armor,Might}),
 * scalar sigma (features are O(1) fractions), fitness = the weighted army-aware policy's decisive win rate vs
 * the frozen blind heuristic in a `cemAugCA` self-play tournament (cem_setupca_eval.ts), fanned out as subprocesses.
 *
 *   CEM_POP=12 CEM_GENS=12 CEM_GAMES=3000 CEM_CONC=4 bun src/simulation/optimizer/cem_augca.mjs
 * Tunables: CEM_POP, CEM_ELITE, CEM_GENS, CEM_GAMES, CEM_VAL_GAMES, CEM_CONC, CEM_SIGMA, CEM_SIGMA_DECAY,
 *           CEM_SIGMA_FLOOR, CEM_SEED, CEM_HOURS.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, "..", "cem_setupca_eval.ts");

const DIM = 23; // 3 vision-value + 4 augment kinds x 5 feats
const POP = Number(process.env.CEM_POP || 12);
const ELITE = Number(process.env.CEM_ELITE || 3);
const GENS = Number(process.env.CEM_GENS || 12);
const GAMES = Number(process.env.CEM_GAMES || 3000);
const VAL_GAMES = Number(process.env.CEM_VAL_GAMES || 8000);
const CONC = Number(process.env.CEM_CONC || 4);
const SIGMA0 = Number(process.env.CEM_SIGMA || 2.0);
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY || 0.9);
const SIGMA_FLOOR = Number(process.env.CEM_SIGMA_FLOOR || 0.1);
const BASE_SEED = Number(process.env.CEM_SEED || 1);
const VAL_SEED = BASE_SEED ^ 0x5f356495;
const HOURS = Number(process.env.CEM_HOURS || 0);
const DEADLINE = HOURS > 0 ? Date.now() + HOURS * 3600 * 1000 : 0;

const OUT = join(process.cwd(), "sim-out", "cem_setupca");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "trace.log");
const log = (m) => {
    console.log(m);
    appendFileSync(LOG, m + "\n");
};

let rngState = (BASE_SEED >>> 0) || 1;
const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
};
const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const evaluate = (weights, games, seed) =>
    new Promise((resolve) => {
        const child = spawn("bun", [EVAL, String(games), String(seed), String(CONC)], {
            env: { ...process.env, V05_SETUPCA_WEIGHTS: JSON.stringify(weights) },
            cwd: process.cwd(),
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => process.stderr.write(d));
        child.on("close", () => {
            try {
                resolve(JSON.parse(out.trim().split("\n").pop()).winRate);
            } catch {
                resolve(0);
            }
        });
    });

const mean = new Array(DIM).fill(0);
let sigma = new Array(DIM).fill(SIGMA0);

async function main() {
    writeFileSync(LOG, "");
    log(`CEM setupCA: DIM=${DIM} POP=${POP} ELITE=${ELITE} GENS=${GENS} GAMES=${GAMES} CONC=${CONC} sigma0=${SIGMA0} hours=${HOURS} -> ${OUT}`);
    let bestVal = -1;
    let bestVec = mean.slice();
    let pass = 0;
    do {
        for (let gen = 0; gen < GENS; gen += 1) {
            const genSeed = (BASE_SEED + pass * 1_000_003 + gen * 0x9e3779b1) >>> 0;
            const cands = [mean.slice()];
            for (let i = 1; i < POP; i += 1) {
                cands.push(mean.map((m, d) => m + sigma[d] * gauss()));
            }
            const scores = await Promise.all(cands.map((w) => evaluate(w, GAMES, genSeed)));
            const ranked = cands.map((w, i) => ({ w, s: scores[i] })).sort((a, b) => b.s - a.s);
            const elite = ranked.slice(0, ELITE);
            for (let d = 0; d < DIM; d += 1) {
                const vals = elite.map((e) => e.w[d]);
                const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
                const varr = vals.reduce((a, b) => a + (b - mu) * (b - mu), 0) / vals.length;
                mean[d] = mu;
                sigma[d] = Math.max(SIGMA_FLOOR, Math.max(Math.sqrt(varr), sigma[d] * SIGMA_DECAY));
            }
            const genBest = ranked[0];
            log(
                `pass ${pass} gen ${gen}: best=${(genBest.s * 100).toFixed(2)}% mean=${((ranked.reduce((a, r) => a + r.s, 0) / POP) * 100).toFixed(2)}% ` +
                    `elite=[${elite.map((e) => (e.s * 100).toFixed(1)).join(",")}]`,
            );
            if (genBest.s > bestVal) {
                bestVal = genBest.s;
                bestVec = genBest.w.slice();
            }
            writeFileSync(join(OUT, "best.json"), JSON.stringify({ weights: bestVec, trainWinRate: bestVal, pass, gen }, null, 2));
        }
        pass += 1;
        if (DEADLINE && Date.now() < DEADLINE) {
            for (let d = 0; d < DIM; d += 1) {
                mean[d] = bestVec[d];
                sigma[d] = SIGMA0;
            }
        }
    } while (DEADLINE && Date.now() < DEADLINE);

    const valWin = await evaluate(bestVec, VAL_GAMES, VAL_SEED);
    log(`VALIDATION best on held-out seed: ${(valWin * 100).toFixed(2)}% (train ${(bestVal * 100).toFixed(2)}%)`);
    writeFileSync(join(OUT, "best.json"), JSON.stringify({ weights: bestVec, trainWinRate: bestVal, valWinRate: valWin }, null, 2));
    log(`DONE. best.json -> ${join(OUT, "best.json")}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
