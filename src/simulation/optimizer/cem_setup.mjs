/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 * Cross-Entropy Method trainer for the SETUP policy weight vector (perk + augment spend). Mirrors cem.mjs but
 * fitness = the weighted policy's win rate vs the frozen heuristic anchor in a `cemSetup` self-play tournament.
 *
 * Population members are evaluated as PARALLEL SUBPROCESSES (cem_setup_eval.ts), one per candidate — this is
 * how the WSL2 node is saturated, since its in-process worker pool caps at ~5 cores (see notes). Run POP≈12
 * with low per-eval concurrency so POP × concurrency ≈ core count.
 *
 *   CEM_POP=12 CEM_GENS=12 CEM_GAMES=4000 CEM_CONC=4 bun src/simulation/optimizer/cem_setup.mjs
 *
 * Tunables (env): CEM_POP, CEM_ELITE, CEM_GENS, CEM_GAMES, CEM_VAL_GAMES, CEM_CONC, CEM_SIGMA, CEM_SIGMA_DECAY,
 * CEM_SIGMA_FLOOR, CEM_SEED, CEM_DIM. Writes best.json + a per-generation log under sim-out/cem_setup/.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, "..", "cem_setup_eval.ts"); // src/simulation/cem_setup_eval.ts

const DIM = Number(process.env.CEM_DIM || 7);
const POP = Number(process.env.CEM_POP || 12);
const ELITE = Number(process.env.CEM_ELITE || 3);
const GENS = Number(process.env.CEM_GENS || 12);
const GAMES = Number(process.env.CEM_GAMES || 4000);
const VAL_GAMES = Number(process.env.CEM_VAL_GAMES || 8000);
const CONC = Number(process.env.CEM_CONC || 4);
const SIGMA0 = Number(process.env.CEM_SIGMA || 2.5);
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY || 0.9);
const SIGMA_FLOOR = Number(process.env.CEM_SIGMA_FLOOR || 0.15);
const BASE_SEED = Number(process.env.CEM_SEED || 1);
const VAL_SEED = BASE_SEED ^ 0x5f356495;

const OUT = join(process.cwd(), "sim-out", "cem_setup");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "trace.log");
const log = (m) => {
    console.log(m);
    appendFileSync(LOG, m + "\n");
};

// Deterministic-ish RNG (seedable) so a run reproduces; Math.random is fine here (training, not the sim).
let rngState = (BASE_SEED >>> 0) || 1;
const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
};
const gauss = () => {
    // Box-Muller
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Evaluate one weight vector as a subprocess → decisive win rate of the weighted policy. */
const evaluate = (weights, games, seed) =>
    new Promise((resolve) => {
        const child = spawn("bun", [EVAL, String(games), String(seed), String(CONC)], {
            env: { ...process.env, V05_SETUP_WEIGHTS: JSON.stringify(weights) },
            cwd: process.cwd(),
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => process.stderr.write(d));
        child.on("close", () => {
            try {
                const last = out.trim().split("\n").pop();
                resolve(JSON.parse(last).winRate);
            } catch {
                resolve(0); // a crashed eval scores 0 (drops out of the elite)
            }
        });
    });

const mean = new Array(DIM).fill(0);
let sigma = new Array(DIM).fill(SIGMA0);

async function main() {
    writeFileSync(LOG, "");
    log(
        `CEM setup: DIM=${DIM} POP=${POP} ELITE=${ELITE} GENS=${GENS} GAMES=${GAMES} CONC=${CONC} ` +
            `sigma0=${SIGMA0} seed=${BASE_SEED} -> ${OUT}`,
    );
    let bestVal = -1;
    let bestVec = mean.slice();

    for (let gen = 0; gen < GENS; gen += 1) {
        const genSeed = (BASE_SEED + gen * 0x9e3779b1) >>> 0;
        // Candidate 0 is always the current mean (incumbency: the anchor mean reproduces the heuristic, so
        // the elite can never drop below it). The rest are Gaussian samples around the mean.
        const cands = [mean.slice()];
        for (let i = 1; i < POP; i += 1) {
            cands.push(mean.map((m, d) => m + sigma[d] * gauss()));
        }
        // Evaluate the whole population in parallel (process fan-out — saturates the node).
        const scores = await Promise.all(cands.map((w) => evaluate(w, GAMES, genSeed)));
        const ranked = cands
            .map((w, i) => ({ w, s: scores[i] }))
            .sort((a, b) => b.s - a.s);
        const elite = ranked.slice(0, ELITE);
        // Refit mean/sigma from the elite.
        for (let d = 0; d < DIM; d += 1) {
            const vals = elite.map((e) => e.w[d]);
            const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
            const varr = vals.reduce((a, b) => a + (b - mu) * (b - mu), 0) / vals.length;
            mean[d] = mu;
            sigma[d] = Math.max(SIGMA_FLOOR, Math.max(Math.sqrt(varr), sigma[d] * SIGMA_DECAY));
        }
        const genBest = ranked[0];
        log(
            `gen ${gen}: best=${(genBest.s * 100).toFixed(2)}% mean=${(ranked.reduce((a, r) => a + r.s, 0) / POP * 100).toFixed(2)}% ` +
                `elite=[${elite.map((e) => (e.s * 100).toFixed(1)).join(",")}] w*=[${genBest.w.map((x) => x.toFixed(2)).join(",")}]`,
        );
        if (genBest.s > bestVal) {
            bestVal = genBest.s;
            bestVec = genBest.w.slice();
        }
        writeFileSync(join(OUT, "best.json"), JSON.stringify({ weights: bestVec, trainWinRate: bestVal, gen }, null, 2));
    }

    // Honest validation of the best vector on a held-out seed.
    const valWin = await evaluate(bestVec, VAL_GAMES, VAL_SEED);
    log(`VALIDATION best on held-out seed: ${(valWin * 100).toFixed(2)}% (train ${(bestVal * 100).toFixed(2)}%)`);
    writeFileSync(
        join(OUT, "best.json"),
        JSON.stringify({ weights: bestVec, trainWinRate: bestVal, valWinRate: valWin }, null, 2),
    );
    log(`DONE. best.json -> ${join(OUT, "best.json")}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
