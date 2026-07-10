// Q2 Gate-2 — ONE freeze-CEM pass over ONLY the wait-scorer dims (V07_WAIT_WEIGHTS: b + the
// WAIT_FEATURE_NAMES coefficients). The 56-dim fight vector, draft, setup and placement all stay at
// their shipped defaults — this is the structural equivalent of cem.mjs's CEM_FREEZE_BELOW applied to
// the Gate-2 seam: the only free parameters are the wait dims, so selection signal is not diluted
// across a converged vector (v0_7 roadmap, "restore selection signal above the 1pp floor").
//
// Fitness: decisive win share of v0.6s (scorer armed with the candidate) vs plain v0.6 on LIVETWIN,
// GAMES paired side-swap games per candidate, IDENTICAL deterministic seed base for every candidate in
// every iteration (candidates are compared on the same scenario set). The winner must then be re-A/B'd
// on FRESH seeds (the pre-registered 937001 cell) — a train-seed win is not evidence.
//
// Usage:
//   LIVETWIN=1 bun cem_wait.mjs <init_weights.json> [iters=4] [pop=6] [games=2200] [seedBase=947001] \
//       [concurrency=8] [sigma=0.25] [outDir=./cem_wait_out]
// init_weights.json = {"b":...,"w":[...]} (the distilled fit). Elites=2, sigma decays 0.7/iter.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WAIT_FEATURE_NAMES } from "../../ai/versions/wait_scorer";
import { runTournamentConcurrent } from "../concurrent_tournament";

const INIT_FILE = process.argv[2];
const ITERS = Number(process.argv[3] ?? 4);
const POP = Number(process.argv[4] ?? 6);
const GAMES = Number(process.argv[5] ?? 2200);
const SEED_BASE = Number(process.argv[6] ?? 947001);
const CONCURRENCY = Number(process.argv[7] ?? 8);
const SIGMA0 = Number(process.argv[8] ?? 0.25);
const OUT_DIR = process.argv[9] ?? join(process.cwd(), "cem_wait_out");
const ELITES = 2;
const SIGMA_DECAY = 0.7;

if (!INIT_FILE) {
    console.error(
        "usage: LIVETWIN=1 bun cem_wait.mjs <init_weights.json> [iters] [pop] [games] [seedBase] [conc] [sigma] [outDir]",
    );
    process.exit(1);
}
const init = JSON.parse(readFileSync(INIT_FILE, "utf8"));
const D = WAIT_FEATURE_NAMES.length;
if (typeof init.b !== "number" || !Array.isArray(init.w) || init.w.length !== D) {
    throw new Error(`init weights must be {b, w[${D}]} aligned with WAIT_FEATURE_NAMES`);
}
mkdirSync(OUT_DIR, { recursive: true });

// Deterministic RNG (mulberry32) so the pass is reproducible.
let rngState = 0x9e3779b9 ^ SEED_BASE;
const rng = () => {
    rngState |= 0;
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};

const vecOf = (b, w) => [b, ...w];
const weightsOf = (v) => ({ b: v[0], w: v.slice(1) });

async function evaluate(candidate, iter, index) {
    process.env.V07_WAIT_SCORER = "on";
    process.env.V07_WAIT_WEIGHTS = JSON.stringify(weightsOf(candidate));
    process.env.SIM_NO_ACTIONS = "1";
    const summary = await runTournamentConcurrent(
        { versionA: "v0.6s", versionB: "v0.6", games: GAMES, baseSeed: SEED_BASE },
        CONCURRENCY,
    );
    const decisive = summary.a.wins + summary.b.wins;
    const rate = decisive ? summary.a.wins / decisive : 0.5;
    console.log(
        `[iter ${iter} cand ${index}] winRate=${(100 * rate).toFixed(2)}% ` +
            `(${summary.a.wins}/${summary.b.wins}, draws ${summary.draws}, armageddon ${summary.armageddonDecided})`,
    );
    return rate;
}

let mean = vecOf(init.b, init.w);
let sigma = new Array(D + 1).fill(SIGMA0);
let best = { vec: [...mean], rate: -1, iter: -1 };

const startedAt = Date.now();
for (let iter = 0; iter < ITERS; iter += 1) {
    const population = [[...mean]]; // candidate 0 = the current mean (keeps the incumbent-fit comparable)
    while (population.length < POP) {
        population.push(mean.map((m, d) => m + sigma[d] * gauss()));
    }
    const rates = [];
    for (let i = 0; i < population.length; i += 1) {
        rates.push(await evaluate(population[i], iter, i));
    }
    const order = population.map((_, i) => i).sort((a, b) => rates[b] - rates[a]);
    const elites = order.slice(0, ELITES).map((i) => population[i]);
    if (rates[order[0]] > best.rate) {
        best = { vec: [...population[order[0]]], rate: rates[order[0]], iter };
    }
    mean = mean.map((_, d) => elites.reduce((s, e) => s + e[d], 0) / elites.length);
    sigma = sigma.map((s) => Math.max(s * SIGMA_DECAY, 0.02));
    writeFileSync(
        join(OUT_DIR, `iter_${iter}.json`),
        JSON.stringify({ iter, rates, bestRate: best.rate, mean: weightsOf(mean), best: weightsOf(best.vec) }, null, 2),
    );
    console.log(
        `== iter ${iter}: best so far ${(100 * best.rate).toFixed(2)}% (elapsed ${((Date.now() - startedAt) / 60000).toFixed(1)} min)`,
    );
}

writeFileSync(join(OUT_DIR, "best.json"), `${JSON.stringify(weightsOf(best.vec))}\n`);
console.log(
    `\nDONE. Best train-seed rate ${(100 * best.rate).toFixed(2)}% (iter ${best.iter}) -> ${join(OUT_DIR, "best.json")}`,
);
console.log("NEXT: re-A/B best.json on FRESH seeds (pre-registered 937001) before any verdict.");
