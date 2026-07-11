/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Evidence-preserving iterative league driver:
 *   1. freeze an initial deployable pool;
 *   2. train one CEM best response at a time against the accumulated pool;
 *   3. freeze each distinct champion and its provenance;
 *   4. measure a separately seeded complete payoff matrix;
 *   5. report a finite-iteration zero-sum mixture with exploitability/regret.
 *
 * This produces measurement artifacts only. It does not run or imply the v0.7 bake protocol.
 *
 * Tiny deterministic smoke:
 *   LEAGUE_SMOKE=1 LEAGUE_OUT=sim-out/league-cycle-smoke \
 *     bun src/simulation/optimizer/league_cycle.mjs
 *
 * Explicit larger measurement (still not the v0.7 acceptance matrix):
 *   LEAGUE_ROUNDS=3 CEM_GAMES=2000 CEM_VAL_GAMES=5000 CEM_POP=12 CEM_ELITE=3 \
 *   CEM_GENS=12 CEM_EVAL_PARALLEL=12 LEAGUE_MATRIX_GAMES=5000 LEAGUE_MATRIX_PARALLEL=3 \
 *   LEAGUE_OUT=sim-out/league-cycle bun src/simulation/optimizer/league_cycle.mjs
 *
 * Production-sized settings must be explicitly chosen. Useful controls:
 *   LEAGUE_ROUNDS, LEAGUE_INITIAL_POOL, LEAGUE_OUT, LEAGUE_MATRIX_GAMES,
 *   LEAGUE_MATRIX_SEED, LEAGUE_MATRIX_PARALLEL, LEAGUE_NASH_ITERS, plus the
 *   CEM_* controls accepted by cem_league.mjs.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LEAGUE_ANCHOR_GENOME, LEAGUE_SCHEMA_VERSION } from "../league_genome.ts";
import { loadLeaguePool } from "../league_eval.ts";
import {
    buildEmpiricalLeaguePayoff,
    canonicalJson,
    leagueFingerprint,
    leagueGenomeFingerprint,
    normalizeLeagueSeed,
    solveApproximateZeroSumLeague,
} from "./league_cycle_core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../../..");
const CEM = join(HERE, "cem_league.mjs");
const EVALUATOR = join(HERE, "..", "league_eval.ts");
const ROUND_SEED_STEP = 0x9e3779b1;
const MATRIX_SEED_MASK = 0xa511e9b3;
const activeChildren = new Set();

const integer = (name, fallback, minimum = 1) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
};

const positive = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    return value;
};

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const semanticEqual = (left, right) => canonicalJson(left) === canonicalJson(right);
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const relativeToOutput = (path) => relative(OUT, path) || ".";

function immutableJson(path, value) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    try {
        writeFileSync(path, content, { flag: "wx", mode: 0o444 });
    } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (readFileSync(path, "utf8") !== content) {
            throw new Error(`Immutable league artifact conflicts with existing file: ${path}`);
        }
    }
    chmodSync(path, 0o444);
}

function atomicJson(path, value) {
    const temporary = `${path}.tmp.${process.pid}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function sourceFingerprint(root) {
    const files = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const metadata = statSync(path);
            if (metadata.isDirectory()) {
                walk(path);
            } else if (/\.(?:json|mjs|proto|ts|tsx)$/.test(name)) {
                files.push(path);
            }
        }
    };
    walk(join(root, "src"));
    const hash = createHash("sha256");
    for (const path of files) {
        hash.update(relative(root, path));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
    }
    return hash.digest("hex");
}

function gitText(args) {
    try {
        return execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim();
    } catch {
        return "unknown";
    }
}

function poolPayload(entries, fingerprint) {
    return {
        schemaVersion: 1,
        status: "measurement_only",
        fingerprint,
        entries,
        qualification: "League pool snapshot only; not a bake or acceptance verdict.",
    };
}

function writePoolSnapshot(entries) {
    const fingerprint = leagueFingerprint({ entries });
    const path = join(OUT, "pools", `pool.${fingerprint}.json`);
    immutableJson(path, poolPayload(entries, fingerprint));
    return { fingerprint, path };
}

function childEnvironment(overrides) {
    return {
        ...process.env,
        ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, String(value)])),
    };
}

function runChild(command, args, options = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            cwd: PACKAGE_ROOT,
            env: options.env ?? process.env,
            stdio: ["ignore", options.inheritStdout ? "inherit" : "pipe", "pipe"],
        });
        activeChildren.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            activeChildren.delete(child);
            rejectPromise(error);
        });
        child.on("close", (code) => {
            activeChildren.delete(child);
            if (code !== 0) {
                rejectPromise(new Error(`${command} exited ${code}: ${stderr.trim()}`));
            } else {
                if (stderr.trim()) process.stderr.write(stderr);
                resolvePromise(stdout);
            }
        });
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
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    return results;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        for (const child of activeChildren) child.kill(signal);
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

const SMOKE = process.env.LEAGUE_SMOKE === "1";
const OUT = resolve(process.env.LEAGUE_OUT || join(PACKAGE_ROOT, "sim-out", "league_cycle"));
const ROUNDS = integer("LEAGUE_ROUNDS", SMOKE ? 1 : 3);
const BASE_SEED = integer("CEM_SEED", 1, 0) >>> 0;
const INITIAL_POOL_SOURCE = process.env.LEAGUE_INITIAL_POOL || process.env.CEM_LEAGUE_POOL || "default";
const FREEZE_PERK = process.env.CEM_UNFREEZE_PERK !== "1";
const CEM_CONFIG = {
    aggregate: process.env.CEM_AGGREGATE || "worst-case",
    elite: integer("CEM_ELITE", SMOKE ? 1 : 3),
    evalParallel: integer("CEM_EVAL_PARALLEL", SMOKE ? 1 : 12),
    fightVersion: process.env.CEM_FIGHT_VERSION || "v0.6",
    freezePerk: FREEZE_PERK,
    gamesPerOpponent: integer("CEM_GAMES", SMOKE ? 8 : 2000),
    generations: integer("CEM_GENS", SMOKE ? 1 : 12),
    mapTypes: (process.env.CEM_MAPS || "1").split(",").map(Number),
    matchConcurrency: integer("CEM_MATCH_CONC", 1),
    population: integer("CEM_POP", SMOKE ? 2 : 12),
    relativeSigma: positive("CEM_REL_SIGMA", 0.25),
    sigmaDecay: positive("CEM_SIGMA_DECAY", 0.9),
    sigmaFloorRatio: positive("CEM_SIGMA_FLOOR_RATIO", 0.2),
    softminTemperature: positive("CEM_SOFTMIN_TEMPERATURE", 0.025),
    validationGamesPerOpponent: integer("CEM_VAL_GAMES", SMOKE ? 8 : 5000),
    zeroSigma: positive("CEM_ZERO_SIGMA", 2.5),
};
const MATRIX_CONFIG = {
    confidenceZ: positive("LEAGUE_MATRIX_CONFIDENCE_Z", 1.96),
    fightVersion: process.env.LEAGUE_MATRIX_FIGHT_VERSION || CEM_CONFIG.fightVersion,
    freezePerk: FREEZE_PERK,
    gamesPerCell: integer("LEAGUE_MATRIX_GAMES", SMOKE ? 8 : 2000),
    mapTypes: (process.env.LEAGUE_MATRIX_MAPS || CEM_CONFIG.mapTypes.join(",")).split(",").map(Number),
    maxLaps: integer("LEAGUE_MATRIX_MAX_LAPS", 60),
    seed: integer("LEAGUE_MATRIX_SEED", (BASE_SEED ^ MATRIX_SEED_MASK) >>> 0, 0) >>> 0,
};
const MATRIX_PARALLEL = integer("LEAGUE_MATRIX_PARALLEL", SMOKE ? 1 : 4);
const NASH_ITERATIONS = integer("LEAGUE_NASH_ITERS", SMOKE ? 2000 : 50_000);

if (CEM_CONFIG.elite > CEM_CONFIG.population || CEM_CONFIG.population < 2) {
    throw new Error("CEM population must be >= 2 and elite must not exceed population");
}
if (CEM_CONFIG.aggregate !== "worst-case" && CEM_CONFIG.aggregate !== "softmin") {
    throw new Error("CEM_AGGREGATE must be worst-case or softmin");
}
for (const [name, games] of [
    ["CEM_GAMES", CEM_CONFIG.gamesPerOpponent],
    ["CEM_VAL_GAMES", CEM_CONFIG.validationGamesPerOpponent],
    ["LEAGUE_MATRIX_GAMES", MATRIX_CONFIG.gamesPerCell],
]) {
    if (games < 8 || games % 4) throw new Error(`${name} must be a multiple of four and at least eight`);
}
for (const maps of [CEM_CONFIG.mapTypes, MATRIX_CONFIG.mapTypes]) {
    if (!maps.length || !maps.every((map) => Number.isInteger(map) && map >= 1 && map <= 4)) {
        throw new Error("League map ids must be integers in [1, 4]");
    }
}

mkdirSync(OUT, { recursive: true });
const initialEntries = loadLeaguePool(INITIAL_POOL_SOURCE, PACKAGE_ROOT);
const initialIds = new Set();
const initialGenomeFingerprints = new Set();
for (const entry of initialEntries) {
    if (entry.omniscientDraft) throw new Error(`Complete matrix cannot use non-deployable oracle entrant ${entry.id}`);
    if (initialIds.has(entry.id)) throw new Error(`Duplicate initial pool id ${entry.id}`);
    initialIds.add(entry.id);
    const fingerprint = leagueGenomeFingerprint(entry);
    if (initialGenomeFingerprints.has(fingerprint)) {
        throw new Error(`Initial pool contains duplicate policy weights at ${entry.id}`);
    }
    initialGenomeFingerprints.add(fingerprint);
}
const initialPool = writePoolSnapshot(initialEntries);
const revision = gitText(["rev-parse", "HEAD"]);
const sources = sourceFingerprint(PACKAGE_ROOT);
const runProtocol = {
    schemaVersion: 1,
    code: { revision, sourceFingerprint: sources },
    initialPoolFingerprint: initialPool.fingerprint,
    baseSeed: BASE_SEED,
    roundSeedStep: ROUND_SEED_STEP,
    cem: CEM_CONFIG,
    matrix: MATRIX_CONFIG,
    nash: { iterations: NASH_ITERATIONS, method: "simultaneous_multiplicative_weights" },
};
const runFingerprint = leagueFingerprint(runProtocol);
const runPath = join(OUT, "run.json");
const runArtifact = {
    ...runProtocol,
    status: "measurement_only",
    runFingerprint,
    initialPool: relativeToOutput(initialPool.path),
    initialPoolSource: INITIAL_POOL_SOURCE,
    qualification: "Iterative league measurement protocol; not a powered run, bake, or ship verdict.",
};
if (existsSync(runPath)) {
    const existing = json(runPath);
    if (existing.runFingerprint !== runFingerprint || !semanticEqual(existing, runArtifact)) {
        throw new Error(
            `League resume configuration does not match ${runPath}; use a new LEAGUE_OUT instead of mixing panels`,
        );
    }
} else {
    immutableJson(runPath, runArtifact);
}

const statePath = join(OUT, "state.json");
let state = existsSync(statePath)
    ? json(statePath)
    : {
          schemaVersion: 1,
          status: "measurement_only",
          runFingerprint,
          createdAt: new Date().toISOString(),
          rounds: [],
      };
if (state.runFingerprint !== runFingerprint || !Array.isArray(state.rounds)) {
    throw new Error(`League state does not belong to run ${runFingerprint}`);
}
if (ROUNDS < state.rounds.length) {
    throw new Error(`LEAGUE_ROUNDS=${ROUNDS} is below the ${state.rounds.length} already completed rounds`);
}

const entrants = initialEntries.map((entry) => ({
    entry,
    genomeFingerprint: leagueGenomeFingerprint(entry),
    origin: { type: "initial_pool", poolFingerprint: initialPool.fingerprint },
}));

function verifyRoundResult(result, roundConfigFingerprint) {
    if (
        result.schemaVersion !== 1 ||
        result.status !== "measurement_only" ||
        result.roundConfigFingerprint !== roundConfigFingerprint ||
        !result.champion ||
        result.genomeFingerprint !== leagueGenomeFingerprint(result.champion)
    ) {
        throw new Error(`Invalid or incompatible immutable result for league round ${result.round}`);
    }
    return result;
}

function addRoundEntrant(result) {
    const existing = entrants.find((entrant) => entrant.genomeFingerprint === result.genomeFingerprint);
    if (result.addedToPool) {
        if (existing) throw new Error(`Round ${result.round} claims duplicate champion was added`);
        if (entrants.some((entrant) => entrant.entry.id === result.champion.id)) {
            throw new Error(`Round ${result.round} champion id collides with the existing pool`);
        }
        entrants.push({
            entry: { ...result.champion, prior: 1 },
            genomeFingerprint: result.genomeFingerprint,
            origin: { type: "best_response", round: result.round, provenance: result.provenance },
        });
    } else if (!existing || result.duplicateOf !== existing.entry.id) {
        throw new Error(`Round ${result.round} duplicate provenance no longer matches the accumulated pool`);
    }
}

for (let index = 0; index < state.rounds.length; index += 1) {
    const expectedRound = index + 1;
    const record = state.rounds[index];
    if (record.round !== expectedRound) throw new Error("League state rounds must be contiguous");
    const resultPath = join(OUT, record.resultPath);
    const result = verifyRoundResult(json(resultPath), record.roundConfigFingerprint);
    if (result.genomeFingerprint !== record.genomeFingerprint || result.addedToPool !== record.addedToPool) {
        throw new Error(`League state disagrees with immutable result for round ${expectedRound}`);
    }
    addRoundEntrant(result);
}

async function executeRound(round) {
    const poolEntries = entrants.map(({ entry }) => entry);
    const pool = writePoolSnapshot(poolEntries);
    const mean = entrants.at(-1)?.entry.weights ?? [...LEAGUE_ANCHOR_GENOME];
    const seed = (BASE_SEED + Math.imul(round - 1, ROUND_SEED_STEP)) >>> 0;
    const roundConfig = {
        schemaVersion: 1,
        runFingerprint,
        round,
        seed,
        poolFingerprint: pool.fingerprint,
        meanFingerprint: leagueFingerprint(mean),
        cem: CEM_CONFIG,
    };
    const roundConfigFingerprint = leagueFingerprint(roundConfig);
    const roundDirectory = join(OUT, "rounds", `round-${String(round).padStart(3, "0")}`);
    const roundConfigPath = join(roundDirectory, "round.json");
    const resultPath = join(roundDirectory, "result.json");
    immutableJson(roundConfigPath, {
        ...roundConfig,
        status: "measurement_only",
        roundConfigFingerprint,
        pool: relativeToOutput(pool.path),
        qualification: "CEM best-response training panel; not a bake or acceptance verdict.",
    });
    if (existsSync(resultPath)) {
        return { result: verifyRoundResult(json(resultPath), roundConfigFingerprint), resultPath };
    }

    const cemOut = join(roundDirectory, "cem");
    process.stdout.write(
        `league round ${round}/${ROUNDS}: pool=${poolEntries.length} seed=${seed} panel=${roundConfigFingerprint.slice(0, 12)}\n`,
    );
    await runChild(process.execPath, [CEM], {
        inheritStdout: true,
        env: childEnvironment({
            CEM_AGGREGATE: CEM_CONFIG.aggregate,
            CEM_ELITE: CEM_CONFIG.elite,
            CEM_EVAL_PARALLEL: CEM_CONFIG.evalParallel,
            CEM_FIGHT_VERSION: CEM_CONFIG.fightVersion,
            CEM_GAMES: CEM_CONFIG.gamesPerOpponent,
            CEM_GENS: CEM_CONFIG.generations,
            CEM_LEAGUE_MEAN: JSON.stringify(mean),
            CEM_LEAGUE_POOL: pool.path,
            CEM_MAPS: CEM_CONFIG.mapTypes.join(","),
            CEM_MATCH_CONC: CEM_CONFIG.matchConcurrency,
            CEM_OUT: cemOut,
            CEM_POP: CEM_CONFIG.population,
            CEM_REL_SIGMA: CEM_CONFIG.relativeSigma,
            CEM_SEED: seed,
            CEM_SIGMA_DECAY: CEM_CONFIG.sigmaDecay,
            CEM_SIGMA_FLOOR_RATIO: CEM_CONFIG.sigmaFloorRatio,
            CEM_SOFTMIN_TEMPERATURE: CEM_CONFIG.softminTemperature,
            CEM_UNFREEZE_PERK: CEM_CONFIG.freezePerk ? "0" : "1",
            CEM_VAL_GAMES: CEM_CONFIG.validationGamesPerOpponent,
            CEM_ZERO_SIGMA: CEM_CONFIG.zeroSigma,
        }),
    });
    const bestPath = join(cemOut, "best.json");
    const validationPath = join(cemOut, "validation.json");
    const bestContent = readFileSync(bestPath, "utf8");
    const validationContent = readFileSync(validationPath, "utf8");
    const best = JSON.parse(bestContent);
    const validation = JSON.parse(validationContent);
    const heldOutSeed = normalizeLeagueSeed(validation.heldOutSeed);
    const reportBaseSeed = normalizeLeagueSeed(validation.report?.options?.baseSeed);
    const expectedHeldOutSeed = normalizeLeagueSeed(seed ^ 0x5f356495);
    const expectedSelectionPanel = {
        schemaVersion: 1,
        seed,
        gamesPerOpponent: CEM_CONFIG.gamesPerOpponent,
        fightVersion: CEM_CONFIG.fightVersion,
        maxLaps: 60,
        mapTypes: CEM_CONFIG.mapTypes,
        freezePerk: CEM_CONFIG.freezePerk,
        aggregate: CEM_CONFIG.aggregate,
        softminTemperature: CEM_CONFIG.softminTemperature,
        confidenceZ: 1.96,
        pool: poolEntries,
    };
    if (
        best.status !== "measurement_only" ||
        best.schemaVersion !== LEAGUE_SCHEMA_VERSION ||
        !Array.isArray(best.weights) ||
        !semanticEqual(best.selectionPanel, expectedSelectionPanel) ||
        best.train?.selectionPanelFingerprint !== sha256(JSON.stringify(best.selectionPanel)) ||
        !semanticEqual(validation.candidate?.weights, best.weights) ||
        heldOutSeed !== expectedHeldOutSeed ||
        validation.gamesPerOpponent !== CEM_CONFIG.validationGamesPerOpponent ||
        !semanticEqual(validation.report?.options?.mapTypes, CEM_CONFIG.mapTypes) ||
        reportBaseSeed !== expectedHeldOutSeed
    ) {
        throw new Error(`CEM output failed provenance validation for round ${round}`);
    }
    const genomeFingerprint = leagueGenomeFingerprint(best);
    const duplicate = entrants.find((entrant) => entrant.genomeFingerprint === genomeFingerprint);
    const champion = {
        schemaVersion: LEAGUE_SCHEMA_VERSION,
        id: duplicate?.entry.id ?? `br-${genomeFingerprint.slice(0, 16)}`,
        weights: [...best.weights],
    };
    const result = {
        schemaVersion: 1,
        status: "measurement_only",
        round,
        roundConfigFingerprint,
        champion,
        genomeFingerprint,
        addedToPool: !duplicate,
        ...(duplicate ? { duplicateOf: duplicate.entry.id } : {}),
        provenance: {
            algorithm: "cem_league_best_response",
            runFingerprint,
            code: runProtocol.code,
            poolBeforeFingerprint: pool.fingerprint,
            selectionPanelFingerprint: best.train.selectionPanelFingerprint,
            selectionSeed: best.train.selectionSeed,
            generationFound: best.train.generationFound,
            trainingFitness: best.train.fitness,
            trainingWorstCaseLowerBound: best.train.worstCaseLowerBound,
            trainingSoftminLowerBound: best.train.softminLowerBound,
            heldOutSeed,
            heldOutGamesPerOpponent: validation.gamesPerOpponent,
            heldOutAggregate: validation.report?.aggregate,
            bestArtifactSha256: sha256(bestContent),
            validationArtifactSha256: sha256(validationContent),
            qualification:
                "One best response on fixed training/validation panels; not powered acceptance or bake evidence.",
        },
    };
    immutableJson(resultPath, result);
    chmodSync(bestPath, 0o444);
    chmodSync(validationPath, 0o444);
    return { result, resultPath };
}

for (let round = state.rounds.length + 1; round <= ROUNDS; round += 1) {
    const { result, resultPath } = await executeRound(round);
    addRoundEntrant(result);
    state.rounds.push({
        round,
        resultPath: relativeToOutput(resultPath),
        roundConfigFingerprint: result.roundConfigFingerprint,
        genomeFingerprint: result.genomeFingerprint,
        championId: result.champion.id,
        addedToPool: result.addedToPool,
    });
    state.updatedAt = new Date().toISOString();
    atomicJson(statePath, state);
}

const usedTrainingSeeds = new Set();
for (let round = 1; round <= ROUNDS; round += 1) {
    const seed = (BASE_SEED + Math.imul(round - 1, ROUND_SEED_STEP)) >>> 0;
    usedTrainingSeeds.add(seed);
    usedTrainingSeeds.add(normalizeLeagueSeed(seed ^ 0x5f356495));
}
if (usedTrainingSeeds.has(MATRIX_CONFIG.seed)) {
    throw new Error("LEAGUE_MATRIX_SEED must be separate from every CEM selection and validation seed");
}

const matrixEntries = entrants.map(({ entry }) => entry);
const matrixPool = writePoolSnapshot(matrixEntries);
const matrixPanel = {
    schemaVersion: 1,
    status: "measurement_only",
    runFingerprint,
    code: runProtocol.code,
    purpose: "complete_entrant_payoff_matrix",
    entrants: entrants.map(({ entry, genomeFingerprint, origin }) => ({
        id: entry.id,
        genomeFingerprint,
        genome: entry,
        origin,
    })),
    options: MATRIX_CONFIG,
    payoff: { win: 1, draw: 0.5, loss: 0, zeroSumProjection: "antisymmetric_directional_average" },
};
const matrixPanelFingerprint = leagueFingerprint(matrixPanel);
const matrixDirectory = join(OUT, "matrices", matrixPanelFingerprint);
const matrixPanelPath = join(matrixDirectory, "panel.json");
const matrixReportPath = join(matrixDirectory, "report.json");
immutableJson(matrixPanelPath, {
    ...matrixPanel,
    panelFingerprint: matrixPanelFingerprint,
    pool: relativeToOutput(matrixPool.path),
    qualification: "Fresh complete matrix panel; distinct from every CEM selection/validation panel.",
});

async function evaluateMatrixRow(entrant) {
    const rowPath = join(matrixDirectory, "rows", `${entrant.genomeFingerprint}.json`);
    if (existsSync(rowPath)) {
        const envelope = json(rowPath);
        if (
            envelope.panelFingerprint !== matrixPanelFingerprint ||
            envelope.candidateGenomeFingerprint !== entrant.genomeFingerprint ||
            envelope.report?.candidateId !== entrant.entry.id
        ) {
            throw new Error(`Matrix resume row is incompatible for ${entrant.entry.id}`);
        }
        return envelope.report;
    }
    const stdout = await runChild(process.execPath, [
        EVALUATOR,
        "--candidate-json",
        JSON.stringify(entrant.entry),
        "--pool",
        matrixPool.path,
        "--games",
        String(MATRIX_CONFIG.gamesPerCell),
        "--seed",
        String(MATRIX_CONFIG.seed),
        "--concurrency",
        String(CEM_CONFIG.matchConcurrency),
        "--aggregate",
        "worst-case",
        "--fight-version",
        MATRIX_CONFIG.fightVersion,
        "--maps",
        MATRIX_CONFIG.mapTypes.join(","),
        "--max-laps",
        String(MATRIX_CONFIG.maxLaps),
        "--confidence-z",
        String(MATRIX_CONFIG.confidenceZ),
        ...(MATRIX_CONFIG.freezePerk ? [] : ["--unfreeze-perk"]),
    ]);
    const report = JSON.parse(stdout.slice(stdout.indexOf("{")));
    if (
        report.status !== "measurement_only" ||
        report.candidateId !== entrant.entry.id ||
        report.options?.baseSeed !== MATRIX_CONFIG.seed ||
        report.options?.gamesPerOpponent !== MATRIX_CONFIG.gamesPerCell ||
        report.opponents?.length !== entrants.length
    ) {
        throw new Error(`Evaluator output failed matrix provenance validation for ${entrant.entry.id}`);
    }
    immutableJson(rowPath, {
        schemaVersion: 1,
        status: "measurement_only",
        panelFingerprint: matrixPanelFingerprint,
        candidateGenomeFingerprint: entrant.genomeFingerprint,
        report,
    });
    return report;
}

let matrixReport;
if (existsSync(matrixReportPath)) {
    matrixReport = json(matrixReportPath);
    if (matrixReport.panelFingerprint !== matrixPanelFingerprint) {
        throw new Error("Existing matrix report belongs to a different panel");
    }
} else {
    process.stdout.write(
        `league matrix: entrants=${entrants.length} cells=${entrants.length ** 2} ` +
            `games/cell=${MATRIX_CONFIG.gamesPerCell} panel=${matrixPanelFingerprint.slice(0, 12)}\n`,
    );
    const rowReports = await mapLimit(entrants, MATRIX_PARALLEL, evaluateMatrixRow);
    const observations = rowReports.flatMap((report) =>
        report.opponents.map((opponent) => ({
            candidateId: report.candidateId,
            opponentId: opponent.opponentId,
            wins: opponent.wins,
            losses: opponent.losses,
            draws: opponent.draws,
        })),
    );
    const empirical = buildEmpiricalLeaguePayoff(
        entrants.map(({ entry }) => entry.id),
        observations,
    );
    const approximateZeroSum = solveApproximateZeroSumLeague(empirical.entrantIds, empirical.payoffs, NASH_ITERATIONS);
    const pureWorstCases = empirical.payoffs.map((row) => Math.min(...row));
    const pureWorstCaseIndex = pureWorstCases.reduce(
        (best, value, index) => (value > pureWorstCases[best] ? index : best),
        0,
    );
    matrixReport = {
        schemaVersion: 1,
        status: "measurement_only",
        generatedAt: new Date().toISOString(),
        panelFingerprint: matrixPanelFingerprint,
        complete: observations.length === entrants.length ** 2,
        totalCells: observations.length,
        totalGames: observations.reduce(
            (sum, observation) => sum + observation.wins + observation.losses + observation.draws,
            0,
        ),
        observations,
        empirical,
        approximateZeroSum,
        pureWorstCaseSelection: {
            entrantId: empirical.entrantIds[pureWorstCaseIndex],
            worstCasePayoff: pureWorstCases[pureWorstCaseIndex],
            opponentPayoffs: empirical.entrantIds.map((opponentId, index) => ({
                opponentId,
                payoff: empirical.payoffs[pureWorstCaseIndex][index],
            })),
            qualification: "Empirical pure-policy maximin on the antisymmetric point-estimate matrix.",
        },
        gateDecision: {
            verdict: "measurement_only_no_acceptance_or_kill",
            acceptance: false,
            kill: false,
            reason: "This league cycle is not the preregistered powered v0.7 acceptance matrix.",
        },
        qualification:
            "Approximate Nash/adversarial mixtures of this finite sampled pool only; not a powered run, bake, or ship verdict.",
        limitations: [
            "The solver uses empirical point estimates; clustered lower bounds are reported in row artifacts but do not form a zero-sum matrix.",
            "The antisymmetric projection is explicit; maxDirectionalResidual reports disagreement between independently measured directions.",
            "Duality gap, symmetric exploitability, and external regrets quantify finite-iteration solver error on this matrix, not sampling error or out-of-pool exploitability.",
            "Adding an entrant creates a new content-addressed panel and requires a new complete matrix.",
        ],
    };
    immutableJson(matrixReportPath, matrixReport);
}

state.latestMatrix = {
    panelFingerprint: matrixPanelFingerprint,
    panelPath: relativeToOutput(matrixPanelPath),
    reportPath: relativeToOutput(matrixReportPath),
    entrants: entrants.length,
    cells: entrants.length ** 2,
};
state.updatedAt = new Date().toISOString();
atomicJson(statePath, state);

process.stdout.write(
    `${JSON.stringify(
        {
            status: "measurement_only",
            runFingerprint,
            completedRounds: state.rounds.length,
            entrants: entrants.length,
            matrixPanelFingerprint,
            matrixReport: matrixReportPath,
            dualityGap: matrixReport.approximateZeroSum.dualityGap,
            symmetricExploitability: matrixReport.approximateZeroSum.symmetricExploitability,
            gateDecision: matrixReport.gateDecision,
            qualification: matrixReport.qualification,
        },
        null,
        2,
    )}\n`,
);
