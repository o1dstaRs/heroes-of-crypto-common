/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Full-game league CEM for the anchored upstream genome. Every candidate goes through the exact common
 * pick reducer and then fights mirrored LiveTwin battles against every configured exploiter/champion.
 * Training fitness defaults to the minimum per-opponent 95% Wilson lower bound. `softmin` is available as
 * an entropy-regularized adversarial mixture, but is deliberately not described as a full Nash equilibrium:
 * that requires a complete entrant-by-entrant payoff matrix, not one candidate row.
 *
 *   CEM_GAMES=2000 CEM_POP=12 CEM_GENS=12 CEM_EVAL_PARALLEL=12 \
 *     bun src/simulation/optimizer/cem_league.mjs
 *
 * Optional: CEM_LEAGUE_POOL=/path/pool.json, CEM_AGGREGATE=worst-case|softmin, CEM_FIGHT_VERSION=v0.6,
 * CEM_MAPS=1,2,3,4, CEM_MATCH_CONC=1, CEM_REL_SIGMA=.25, CEM_ZERO_SIGMA=2.5, CEM_SEED=1, CEM_OUT=sim-out/....
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LEAGUE_ANCHOR_GENOME, LEAGUE_GENOME_DIM, LEAGUE_SCHEMA_VERSION } from "../league_genome.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, "..", "league_eval.ts");
const ANCHOR = [...LEAGUE_ANCHOR_GENOME];

const POP = Number(process.env.CEM_POP || 12);
const ELITE = Number(process.env.CEM_ELITE || 3);
const GENS = Number(process.env.CEM_GENS || 12);
const GAMES = Number(process.env.CEM_GAMES || 2000);
const VAL_GAMES = Number(process.env.CEM_VAL_GAMES || 5000);
const EVAL_PARALLEL = Number(process.env.CEM_EVAL_PARALLEL || 12);
const MATCH_CONC = Number(process.env.CEM_MATCH_CONC || 1);
const REL_SIGMA = Number(process.env.CEM_REL_SIGMA || 0.25);
const ZERO_SIGMA = Number(process.env.CEM_ZERO_SIGMA || 2.5);
const SIGMA_DECAY = Number(process.env.CEM_SIGMA_DECAY || 0.9);
const SIGMA_FLOOR_RATIO = Number(process.env.CEM_SIGMA_FLOOR_RATIO || 0.2);
const BASE_SEED = Number(process.env.CEM_SEED || 1) >>> 0;
const VAL_SEED = BASE_SEED ^ 0x5f356495;
const AGGREGATE = process.env.CEM_AGGREGATE || "worst-case";
const POOL = process.env.CEM_LEAGUE_POOL;
const FIGHT_VERSION = process.env.CEM_FIGHT_VERSION || "v0.6";
const MAPS = process.env.CEM_MAPS || "1";
const TEMPERATURE = process.env.CEM_SOFTMIN_TEMPERATURE || "0.025";
const OUT = process.env.CEM_OUT || join(process.cwd(), "sim-out", "cem_league");
const LOG = join(OUT, "trace.log");
const activeChildren = new Set();

if (ANCHOR.length !== LEAGUE_GENOME_DIM) throw new Error("League anchor dimension mismatch");
if (!Number.isInteger(POP) || POP < 2 || !Number.isInteger(ELITE) || ELITE < 1 || ELITE > POP) {
    throw new Error("CEM_POP/CEM_ELITE must define at least two candidates and 1 <= elite <= population");
}
if (!Number.isInteger(GENS) || GENS < 1 || !Number.isInteger(EVAL_PARALLEL) || EVAL_PARALLEL < 1) {
    throw new Error("CEM_GENS and CEM_EVAL_PARALLEL must be positive integers");
}
if (!Number.isInteger(MATCH_CONC) || MATCH_CONC < 1) {
    throw new Error("CEM_MATCH_CONC must be a positive integer");
}
if (
    !Number.isFinite(REL_SIGMA) ||
    REL_SIGMA <= 0 ||
    !Number.isFinite(ZERO_SIGMA) ||
    ZERO_SIGMA <= 0 ||
    !Number.isFinite(SIGMA_DECAY) ||
    SIGMA_DECAY <= 0 ||
    SIGMA_DECAY > 1 ||
    !Number.isFinite(SIGMA_FLOOR_RATIO) ||
    SIGMA_FLOOR_RATIO <= 0
) {
    throw new Error("CEM sigma controls must be finite and positive; CEM_SIGMA_DECAY must be <= 1");
}
if (!Number.isInteger(GAMES) || GAMES < 2 || GAMES % 2 || !Number.isInteger(VAL_GAMES) || VAL_GAMES % 2) {
    throw new Error("CEM_GAMES and CEM_VAL_GAMES must be positive even seat-mirrored counts");
}
if (AGGREGATE !== "worst-case" && AGGREGATE !== "softmin") {
    throw new Error("CEM_AGGREGATE must be worst-case or softmin");
}

mkdirSync(OUT, { recursive: true });
const log = (message) => {
    console.log(message);
    appendFileSync(LOG, `${message}\n`);
};

let rngState = BASE_SEED || 1;
const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
};
const gaussian = () => {
    let u = 0;
    let v = 0;
    while (!u) u = rand();
    while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const initialSigma = ANCHOR.map((coefficient) =>
    coefficient === 0 ? ZERO_SIGMA : REL_SIGMA * (Math.abs(coefficient) + 0.5),
);
const sigmaFloor = initialSigma.map((value) => value * SIGMA_FLOOR_RATIO);

const parseLastJson = (stdout) => {
    const start = stdout.indexOf("{");
    if (start < 0) throw new Error("league evaluator produced no JSON");
    return JSON.parse(stdout.slice(start));
};

const evaluate = (weights, games, seed) =>
    new Promise((resolvePromise, rejectPromise) => {
        const args = [
            EVAL,
            "--candidate-json",
            JSON.stringify({
                schemaVersion: LEAGUE_SCHEMA_VERSION,
                id: "cem-candidate",
                weights,
            }),
            "--games",
            String(games),
            "--seed",
            String(seed >>> 0),
            "--concurrency",
            String(MATCH_CONC),
            "--aggregate",
            AGGREGATE,
            "--temperature",
            TEMPERATURE,
            "--fight-version",
            FIGHT_VERSION,
            "--maps",
            MAPS,
        ];
        if (POOL) args.push("--pool", POOL);
        const child = spawn("bun", args, { cwd: process.cwd(), env: process.env });
        activeChildren.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            activeChildren.delete(child);
            rejectPromise(error);
        });
        child.on("close", (code) => {
            activeChildren.delete(child);
            if (code !== 0) {
                rejectPromise(new Error(`league evaluator exited ${code}: ${stderr.trim()}`));
                return;
            }
            try {
                const report = parseLastJson(stdout);
                resolvePromise({
                    fitness: report.aggregate.fitness,
                    worstCase: report.aggregate.worstCaseLowerBound,
                    softmin: report.aggregate.softminLowerBound,
                    report,
                });
            } catch (error) {
                rejectPromise(new Error(`invalid league evaluator output: ${error}\n${stdout}\n${stderr}`));
            }
        });
    });

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        for (const child of activeChildren) child.kill(signal);
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

async function mapLimit(values, limit, callback) {
    const results = new Array(values.length);
    let next = 0;
    const worker = async () => {
        while (next < values.length) {
            const index = next++;
            results[index] = await callback(values[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, limit)) }, worker));
    return results;
}

async function main() {
    writeFileSync(LOG, "");
    log(
        `CEM league: DIM=${LEAGUE_GENOME_DIM} POP=${POP} ELITE=${ELITE} GENS=${GENS} ` +
            `games/opponent=${GAMES} evalParallel=${EVAL_PARALLEL} matchConc=${MATCH_CONC} ` +
            `aggregate=${AGGREGATE} pool=${POOL || "default(anchor,melee_coevo)"} seed=${BASE_SEED}`,
    );
    const mean = process.env.CEM_LEAGUE_MEAN ? JSON.parse(process.env.CEM_LEAGUE_MEAN) : ANCHOR.slice();
    if (!Array.isArray(mean) || mean.length !== LEAGUE_GENOME_DIM || !mean.every(Number.isFinite)) {
        throw new Error(`CEM_LEAGUE_MEAN must contain ${LEAGUE_GENOME_DIM} finite coefficients`);
    }
    let sigma = initialSigma.slice();
    let best;

    for (let generation = 0; generation < GENS; generation += 1) {
        const generationSeed = (BASE_SEED + Math.imul(generation, 0x9e3779b1)) >>> 0;
        const candidates = [mean.slice()];
        for (let candidate = 1; candidate < POP; candidate += 1) {
            candidates.push(mean.map((value, dimension) => value + sigma[dimension] * gaussian()));
        }
        const scores = await mapLimit(candidates, EVAL_PARALLEL, (weights) => evaluate(weights, GAMES, generationSeed));
        const ranked = candidates
            .map((weights, index) => ({ weights, ...scores[index] }))
            .sort((left, right) => right.fitness - left.fitness);
        const elite = ranked.slice(0, ELITE);
        for (let dimension = 0; dimension < LEAGUE_GENOME_DIM; dimension += 1) {
            const values = elite.map((candidate) => candidate.weights[dimension]);
            const average = values.reduce((sum, value) => sum + value, 0) / values.length;
            const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
            mean[dimension] = average;
            sigma[dimension] = Math.max(sigmaFloor[dimension], Math.sqrt(variance), sigma[dimension] * SIGMA_DECAY);
        }
        if (!best || ranked[0].fitness > best.fitness) best = ranked[0];
        log(
            `gen ${generation}: fitness=${(ranked[0].fitness * 100).toFixed(2)}% ` +
                `worstLCB=${(ranked[0].worstCase * 100).toFixed(2)}% ` +
                `softminLCB=${(ranked[0].softmin * 100).toFixed(2)}% ` +
                `elite=[${elite.map((entry) => (entry.fitness * 100).toFixed(2)).join(",")}]`,
        );
        writeFileSync(
            join(OUT, "best.json"),
            JSON.stringify(
                {
                    schemaVersion: LEAGUE_SCHEMA_VERSION,
                    id: "league-cem-best",
                    weights: best.weights,
                    train: {
                        fitness: best.fitness,
                        worstCaseLowerBound: best.worstCase,
                        softminLowerBound: best.softmin,
                        generation,
                        seed: generationSeed,
                        gamesPerOpponent: GAMES,
                    },
                    pool: POOL || "default",
                    aggregate: AGGREGATE,
                },
                null,
                2,
            ),
        );
    }

    const validation = await evaluate(best.weights, VAL_GAMES, VAL_SEED);
    log(
        `held-out validation: fitness=${(validation.fitness * 100).toFixed(2)}% ` +
            `worstLCB=${(validation.worstCase * 100).toFixed(2)}% ` +
            `softminLCB=${(validation.softmin * 100).toFixed(2)}%`,
    );
    writeFileSync(
        join(OUT, "validation.json"),
        JSON.stringify(
            {
                candidate: {
                    schemaVersion: LEAGUE_SCHEMA_VERSION,
                    id: "league-cem-best",
                    weights: best.weights,
                },
                heldOutSeed: VAL_SEED,
                gamesPerOpponent: VAL_GAMES,
                report: validation.report,
            },
            null,
            2,
        ),
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
