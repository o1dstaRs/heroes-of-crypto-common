/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Autonomous, evidence-preserving v0.7+RAWS policy search.
 *
 * This is a research optimizer. It never edits source, commits, pushes, bakes, or deploys a candidate.
 * It searches the simulation-only SearchDriver configuration/value leaf, freezes one candidate, and then
 * opens separately seeded final panels. See docs/v0_7_96h.md.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
    canonicalV0796hJson,
    createV0796hDistribution,
    expandV0796hPriorSeedSeries,
    fingerprintV0796h,
    fingerprintV0796hGenome,
    refitV0796hDistribution,
    sampleV0796hPopulation,
    scoreV0796hTrial,
    shouldPromoteV0796h,
    V07_96H_TEMPLATES,
    V07_96H_PAIR_SEED_STEP,
    v0796hProbeGenomes,
} from "./v0_7_96h_core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../../..");
const TRIAL = join(HERE, "v0_7_search_trial.ts");
const PAIR_SEED_STEP = V07_96H_PAIR_SEED_STEP;
const activeChildren = new Set();
const SMOKE = process.env.V07_96H_SMOKE === "1";

const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: false,
    strict: true,
    options: {
        out: { type: "string" },
        "initialize-only": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});
if (parsed.values.help) {
    process.stdout.write("usage: bun src/simulation/optimizer/v0_7_96h.mjs --out=DIR\n");
    process.exit(0);
}

function integer(name, fallback, minimum = 1) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
}

function positive(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    return value;
}

function evenGames(name, fallback) {
    const value = integer(name, fallback, 2);
    if (value % 2 !== 0) throw new Error(`${name} must be even for paired side swaps`);
    return value;
}

const outArgument = parsed.values.out ? resolve(parsed.values.out) : undefined;
const outEnvironment = process.env.V07_96H_OUT ? resolve(process.env.V07_96H_OUT) : undefined;
if (outArgument && outEnvironment && outArgument !== outEnvironment) {
    throw new Error(`--out and V07_96H_OUT disagree: ${outArgument} != ${outEnvironment}`);
}
const OUT = outArgument ?? outEnvironment;
if (!OUT) throw new Error("--out or V07_96H_OUT is required");

const CONFIG = {
    schemaVersion: 1,
    smoke: SMOKE,
    durationHours: positive("V07_96H_HOURS", SMOKE ? 1 : 96),
    finalReserveHours: positive("V07_96H_FINAL_RESERVE_HOURS", SMOKE ? 0.5 : 36),
    runSeed: integer("V07_96H_SEED", 9_607_2026, 0) >>> 0,
    population: integer("V07_96H_POP", SMOKE ? 4 : 12, 4),
    elite: integer("V07_96H_ELITE", SMOKE ? 2 : 3, 1),
    maxGenerations: integer("V07_96H_MAX_GENERATIONS", SMOKE ? 1 : 64, 1),
    evalParallel: integer("V07_96H_EVAL_PARALLEL", SMOKE ? 2 : 10, 1),
    workerBudget: integer("V07_96H_WORKERS", SMOKE ? 4 : 20, 1),
    coexistWorkerBudget: integer("V07_96H_COEXIST_WORKERS", 4, 1),
    checkpointGames: evenGames("V07_96H_CHECKPOINT_GAMES", 200),
    coexistPattern:
        process.env.V07_96H_COEXIST_PATTERN ??
        "simulation/(optimizer/)?(league_cycle|cem_league)\\.mjs|simulation/league_eval\\.ts",
    retryLimit: integer("V07_96H_RETRIES", 3, 1),
    target: positive("V07_96H_TARGET", 0.9),
    probe: {
        scoutGames: evenGames("V07_96H_PROBE_SCOUT_GAMES", SMOKE ? 2 : 16),
        midGames: evenGames("V07_96H_PROBE_MID_GAMES", SMOKE ? 2 : 64),
        deepGames: evenGames("V07_96H_PROBE_DEEP_GAMES", SMOKE ? 2 : 256),
        ceilingGames: evenGames("V07_96H_PROBE_CEILING_GAMES", SMOKE ? 2 : 1000),
        midKeep: integer("V07_96H_PROBE_MID_KEEP", 12, 2),
        deepKeep: integer("V07_96H_PROBE_DEEP_KEEP", 4, 2),
        ceilingKeep: integer("V07_96H_PROBE_CEILING_KEEP", 2, 1),
    },
    optimize: {
        scoutGames: evenGames("V07_96H_OPT_SCOUT_GAMES", SMOKE ? 2 : 16),
        midGames: evenGames("V07_96H_OPT_MID_GAMES", SMOKE ? 2 : 64),
        deepGames: evenGames("V07_96H_OPT_DEEP_GAMES", SMOKE ? 2 : 256),
        midKeep: integer("V07_96H_OPT_MID_KEEP", 6, 2),
        deepKeep: integer("V07_96H_OPT_DEEP_KEEP", 2, 1),
        minimumPromotionGain: positive("V07_96H_PROMOTION_GAIN", 0.005),
        maximumTemplateRegression: positive("V07_96H_MAX_TEMPLATE_REGRESSION", 0.01),
    },
    final: {
        championGames: evenGames("V07_96H_FINAL_GAMES", SMOKE ? 2 : 12_000),
        transitivityGames: evenGames("V07_96H_FINAL_V04_GAMES", SMOKE ? 2 : 2000),
    },
};

if (CONFIG.elite > CONFIG.population) throw new Error("V07_96H_ELITE must not exceed V07_96H_POP");
if (CONFIG.target !== 0.9) throw new Error("V07_96H_TARGET is fixed at 0.9 for this protocol");
if (CONFIG.finalReserveHours >= CONFIG.durationHours) {
    throw new Error("V07_96H_FINAL_RESERVE_HOURS must be below V07_96H_HOURS");
}

const RUN_PATH = join(OUT, "run.json");
const STATE_PATH = join(OUT, "state.json");
const SEED_MANIFEST_PATH = join(OUT, "seed-manifest.json");
const terminalMarker = process.env.V07_96H_TERMINAL_MARKER ?? "TERMINAL.json";
const TERMINAL_PATH = terminalMarker.startsWith("/") ? resolve(terminalMarker) : resolve(OUT, terminalMarker);
const HEARTBEAT_PATH = join(OUT, "heartbeat");
const LOG_PATH = join(OUT, "driver.log");
const ALLOW_DIRTY = process.env.V07_96H_ALLOW_DIRTY === "1";

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function atomicText(path, content) {
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, content, { flag: "wx" });
    const descriptor = openSync(temporary, "r");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    renameSync(temporary, path);
}

function atomicJson(path, value) {
    atomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function immutableJson(path, value) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
        if (readFileSync(path, "utf8") !== content) {
            throw new Error(`Immutable artifact conflicts with existing file: ${path}`);
        }
        return;
    }
    atomicText(path, content);
    chmodSync(path, 0o444);
}

function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    process.stdout.write(`${line}\n`);
    writeFileSync(LOG_PATH, `${line}\n`, { flag: "a" });
}

function heartbeat(phase, detail = {}) {
    atomicJson(HEARTBEAT_PATH, {
        schemaVersion: 1,
        pid: process.pid,
        at: new Date().toISOString(),
        phase,
        ...detail,
    });
}

function gitText(args) {
    return execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim();
}

function worktreeClean() {
    return gitText(["status", "--porcelain", "--untracked-files=all"]) === "";
}

function sourceTreeSha256() {
    const listed = execFileSync("git", ["ls-files", "-z"], { cwd: PACKAGE_ROOT });
    const files = listed.toString("utf8").split("\0").filter(Boolean).sort();
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(file);
        hash.update("\0");
        hash.update(readFileSync(join(PACKAGE_ROOT, file)));
        hash.update("\0");
    }
    return hash.digest("hex");
}

function bunVersion() {
    return execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
}

function installedDependencySnapshot() {
    const root = join(PACKAGE_ROOT, "node_modules");
    if (!existsSync(root)) throw new Error("node_modules is missing; install dependencies before starting the run");
    const packages = [];
    const isDirectory = (entry) => entry.isDirectory() || entry.isSymbolicLink();
    const visitPackage = (directory) => {
        const packagePath = join(directory, "package.json");
        if (!existsSync(packagePath)) throw new Error(`Installed dependency has no package.json: ${directory}`);
        const raw = readFileSync(packagePath, "utf8");
        const packageJson = JSON.parse(raw);
        if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
            throw new Error(`Installed dependency has no name/version: ${packagePath}`);
        }
        packages.push({
            location: relative(PACKAGE_ROOT, directory),
            name: packageJson.name,
            version: packageJson.version,
            packageJsonSha256: sha256(raw),
        });
        const nested = join(directory, "node_modules");
        if (existsSync(nested)) visitNodeModules(nested);
    };
    const visitNodeModules = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            if (entry.name.startsWith(".") || !isDirectory(entry)) continue;
            const entryPath = join(directory, entry.name);
            if (entry.name.startsWith("@")) {
                for (const scoped of readdirSync(entryPath, { withFileTypes: true }).sort((a, b) =>
                    a.name.localeCompare(b.name),
                )) {
                    if (isDirectory(scoped)) visitPackage(join(entryPath, scoped.name));
                }
            } else {
                visitPackage(entryPath);
            }
        }
    };
    visitNodeModules(root);
    packages.sort((left, right) => left.location.localeCompare(right.location));
    const manifest = { schemaVersion: 1, packages };
    return { ...manifest, sha256: sha256(canonicalV0796hJson(manifest)) };
}

function allocatePanel(runId, id, gamesPerTemplate, used) {
    const seeds = {};
    const nonces = {};
    for (const { template } of V07_96H_TEMPLATES) {
        let nonce = 0;
        for (;;) {
            const digest = createHash("sha256").update(`${runId}|${id}|${template}|${nonce}`).digest();
            const base = digest.readUInt32BE(0);
            const derived = [];
            let collides = false;
            for (let pair = 0; pair < gamesPerTemplate / 2; pair += 1) {
                const seed = (base + Math.imul(pair, PAIR_SEED_STEP)) >>> 0;
                if (used.has(seed)) {
                    collides = true;
                    break;
                }
                derived.push(seed);
            }
            if (!collides) {
                seeds[template] = base;
                nonces[template] = nonce;
                for (const seed of derived) used.add(seed);
                break;
            }
            nonce += 1;
        }
    }
    return { id, gamesPerTemplate, seeds, nonces };
}

function addSeedStream(used, base, games, label = "seed stream") {
    if (!Number.isSafeInteger(base) || base < 0 || base > 0xffffffff) {
        throw new Error(`${label} base must be a uint32`);
    }
    if (!Number.isSafeInteger(games) || games < 2 || games % 2 !== 0) {
        throw new Error(`${label} games must be an even integer >= 2`);
    }
    for (let pair = 0; pair < games / 2; pair += 1) {
        used.add((base + Math.imul(pair, PAIR_SEED_STEP)) >>> 0);
    }
}

function priorSeedState() {
    const directory = join(PACKAGE_ROOT, "src", "simulation", "manifests");
    const used = new Set();
    const manifests = [];
    for (const name of readdirSync(directory)
        .filter((entry) => /^v0_7.*\.json$/.test(entry))
        .sort()) {
        const path = join(directory, name);
        const raw = readFileSync(path, "utf8");
        const manifest = JSON.parse(raw);
        manifests.push({ path: relative(PACKAGE_ROOT, path), sha256: sha256(raw) });
        if (manifest.seedSeries !== undefined) {
            if (manifest.pairSeedStep !== PAIR_SEED_STEP || !Array.isArray(manifest.seedSeries)) {
                throw new Error(`Invalid compact prior-seed manifest: ${path}`);
            }
            const seeds = expandV0796hPriorSeedSeries(manifest.seedSeries);
            if (
                Number.isInteger(manifest.expectedDerivedScenarioSeeds) &&
                seeds.length !== manifest.expectedDerivedScenarioSeeds
            ) {
                throw new Error(`Prior-seed manifest count mismatch: ${path}`);
            }
            for (const seed of seeds) used.add(seed);
        }
        if (Number.isInteger(manifest.gamesPerCell) && manifest.cells) {
            const visit = (value) => {
                if (Number.isInteger(value)) addSeedStream(used, value, manifest.gamesPerCell);
                else if (value && typeof value === "object") Object.values(value).forEach(visit);
            };
            visit(manifest.cells);
        }
        if (manifest.headline?.seeds && Number.isInteger(manifest.headline.gamesPerSeed)) {
            for (const seed of manifest.headline.seeds) addSeedStream(used, seed, manifest.headline.gamesPerSeed);
        }
        if (manifest.cohorts?.seeds && Number.isInteger(manifest.cohorts.gamesPerSeed)) {
            for (const seeds of Object.values(manifest.cohorts.seeds)) {
                for (const seed of seeds) addSeedStream(used, seed, manifest.cohorts.gamesPerSeed);
            }
        }
    }
    const runParent = dirname(OUT);
    for (const entry of readdirSync(runParent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(runParent, entry.name, "seed-manifest.json");
        if (!existsSync(path) || resolve(path) === resolve(SEED_MANIFEST_PATH)) continue;
        try {
            const raw = readFileSync(path, "utf8");
            const manifest = JSON.parse(raw);
            if (
                manifest.schemaVersion !== 1 ||
                manifest.pairSeedStep !== PAIR_SEED_STEP ||
                !manifest.panels ||
                typeof manifest.panels !== "object" ||
                Array.isArray(manifest.panels) ||
                !Object.keys(manifest.panels).length
            ) {
                throw new Error("schemaVersion 1 with nonempty panels is required");
            }
            for (const [panelId, panel] of Object.entries(manifest.panels)) {
                const expectedTemplates = V07_96H_TEMPLATES.map(({ template }) => template).sort();
                const actualTemplates =
                    panel?.seeds && typeof panel.seeds === "object" && !Array.isArray(panel.seeds)
                        ? Object.keys(panel.seeds).sort()
                        : [];
                if (canonicalV0796hJson(actualTemplates) !== canonicalV0796hJson(expectedTemplates)) {
                    throw new Error(`${panelId} does not contain exactly the eight fixed-template seeds`);
                }
                for (const [template, seed] of Object.entries(panel.seeds)) {
                    addSeedStream(used, seed, panel.gamesPerTemplate, `${panelId}.${template}`);
                }
            }
            manifests.push({ path: resolve(path), sha256: sha256(raw), kind: "prior_96h_run" });
        } catch (error) {
            throw new Error(`Cannot validate prior 96h seed manifest ${path}: ${String(error)}`);
        }
    }
    return { used, manifests };
}

function buildSeedManifest(runId, bootstrap) {
    const prior = priorSeedState();
    const used = new Set(prior.used);
    const panels = {};
    const add = (id, games) => {
        panels[id] = allocatePanel(runId, id, games, used);
    };
    add("probe-scout", CONFIG.probe.scoutGames);
    add("probe-mid", CONFIG.probe.midGames);
    add("probe-deep", CONFIG.probe.deepGames);
    add("probe-ceiling", CONFIG.probe.ceilingGames);
    for (let generation = 0; generation < CONFIG.maxGenerations; generation += 1) {
        add(`g${generation}-scout`, CONFIG.optimize.scoutGames);
        add(`g${generation}-mid`, CONFIG.optimize.midGames);
        add(`g${generation}-deep`, CONFIG.optimize.deepGames);
    }
    add("final-v06", CONFIG.final.championGames);
    add("final-v04", CONFIG.final.transitivityGames);
    return {
        schemaVersion: 1,
        status: "research_only",
        runId,
        bootstrap,
        pairSeedStep: PAIR_SEED_STEP,
        priorManifests: prior.manifests,
        priorDerivedScenarioSeeds: prior.used.size,
        allocatedDerivedScenarioSeeds: used.size - prior.used.size,
        panels,
        declaration:
            "All train/selection/final pair streams were allocated before outcomes and are mutually disjoint and disjoint from committed v0.7 and sibling 96h manifests parsed above.",
    };
}

function processIsAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

function withSeedAllocationLock(callback) {
    const path = join(dirname(OUT), ".v0_7_96h_seed_allocation.lock");
    const owner = `${JSON.stringify({ pid: process.pid, out: OUT, createdAt: new Date().toISOString() })}\n`;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const waitStartedAt = Date.now();
    let descriptor;
    for (;;) {
        try {
            descriptor = openSync(path, "wx", 0o600);
            writeFileSync(descriptor, owner);
            fsyncSync(descriptor);
            break;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            let stale = false;
            try {
                const existing = JSON.parse(readFileSync(path, "utf8"));
                stale = !processIsAlive(existing.pid);
            } catch {
                try {
                    stale = Date.now() - statSync(path).mtimeMs > 30_000;
                } catch (statError) {
                    if (statError?.code === "ENOENT") continue;
                    throw statError;
                }
            }
            if (stale) {
                throw new Error(`Stale local seed allocation lock requires manual verification/removal: ${path}`);
            }
            if (Date.now() - waitStartedAt > 120_000) {
                throw new Error(`Timed out waiting for sibling seed allocation lock: ${path}`);
            }
            Atomics.wait(sleeper, 0, 0, 250);
        }
    }
    try {
        return callback();
    } finally {
        closeSync(descriptor);
        try {
            if (readFileSync(path, "utf8") === owner) rmSync(path, { force: true });
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
    }
}

mkdirSync(OUT, { recursive: true });
if (process.env.V07_96H_RESEARCH_ONLY !== "1") {
    throw new Error("V07_96H_RESEARCH_ONLY=1 is required; this optimizer may only run in research mode");
}
if (!worktreeClean() && !ALLOW_DIRTY) {
    throw new Error("Refusing v0.7 96h run from a dirty source tree");
}
if (!ALLOW_DIRTY && gitText(["branch", "--show-current"]) !== "main") {
    throw new Error("The 96h optimizer must run from main");
}
if (!ALLOW_DIRTY && gitText(["rev-parse", "HEAD"]) !== gitText(["rev-parse", "origin/main"])) {
    throw new Error("The 96h optimizer requires HEAD to equal pushed origin/main");
}
const dependencies = installedDependencySnapshot();
const seedAllocationLockPath = join(dirname(OUT), ".v0_7_96h_seed_allocation.flock");
if (!ALLOW_DIRTY && !existsSync(RUN_PATH) && process.env.V07_96H_SEED_LOCK_HELD !== "1") {
    execFileSync(
        "flock",
        [
            "-x",
            "-w",
            "120",
            seedAllocationLockPath,
            process.execPath,
            join(HERE, "v0_7_96h.mjs"),
            `--out=${OUT}`,
            "--initialize-only",
        ],
        {
            cwd: PACKAGE_ROOT,
            env: { ...process.env, V07_96H_SEED_LOCK_HELD: "1" },
            stdio: "inherit",
        },
    );
    if (!existsSync(RUN_PATH)) throw new Error("Locked seed initialization did not create run.json");
}

let run;
if (existsSync(RUN_PATH)) {
    run = readJson(RUN_PATH);
    if (canonicalV0796hJson(run.config) !== canonicalV0796hJson(CONFIG)) {
        throw new Error("Resume configuration differs from run.json; use a new output directory");
    }
    if (run.code.revision !== gitText(["rev-parse", "HEAD"])) {
        throw new Error("Resume revision differs from run.json; the source snapshot must stay frozen");
    }
    if (run.code.sourceTreeSha256 !== sourceTreeSha256()) {
        throw new Error("Resume source-tree hash differs from run.json");
    }
    if (canonicalV0796hJson(run.code.dependencies) !== canonicalV0796hJson(dependencies)) {
        throw new Error("Resume installed-dependency snapshot differs from run.json");
    }
} else {
    const revision = gitText(["rev-parse", "HEAD"]);
    const protocolFingerprint = fingerprintV0796h({ revision, config: CONFIG });
    let seedManifest;
    let bootstrap;
    let runId;
    if (existsSync(SEED_MANIFEST_PATH)) {
        seedManifest = readJson(SEED_MANIFEST_PATH);
        bootstrap = seedManifest.bootstrap;
        runId = seedManifest.runId;
        if (
            seedManifest.schemaVersion !== 1 ||
            !bootstrap ||
            bootstrap.protocolFingerprint !== protocolFingerprint ||
            runId !==
                fingerprintV0796h({
                    revision,
                    createdAt: bootstrap.createdAt,
                    config: CONFIG,
                })
        ) {
            throw new Error("Orphaned seed manifest is incompatible with this initialization");
        }
    } else {
        const createdAt = new Date();
        const requestedDeadline = process.env.V07_96H_DEADLINE_EPOCH
            ? Number(process.env.V07_96H_DEADLINE_EPOCH) * 1000
            : createdAt.getTime() + CONFIG.durationHours * 3_600_000;
        if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= createdAt.getTime()) {
            throw new Error("V07_96H_DEADLINE_EPOCH must name a future whole-second epoch");
        }
        bootstrap = {
            protocolFingerprint,
            createdAt: createdAt.toISOString(),
            deadlineAt: new Date(requestedDeadline).toISOString(),
        };
        runId = fingerprintV0796h({ revision, createdAt: bootstrap.createdAt, config: CONFIG });
        const allocate = () => {
            seedManifest = buildSeedManifest(runId, bootstrap);
            immutableJson(SEED_MANIFEST_PATH, seedManifest);
        };
        if (ALLOW_DIRTY) withSeedAllocationLock(allocate);
        else {
            if (process.env.V07_96H_SEED_LOCK_HELD !== "1") {
                throw new Error("Production seed allocation requires the parent flock");
            }
            allocate();
        }
    }
    const seedManifestContent = readFileSync(SEED_MANIFEST_PATH, "utf8");
    run = {
        schemaVersion: 1,
        status: "research_only",
        runId,
        createdAt: bootstrap.createdAt,
        deadlineAt: bootstrap.deadlineAt,
        code: {
            revision,
            branch: gitText(["branch", "--show-current"]),
            originMain: gitText(["rev-parse", "origin/main"]),
            sourceTreeSha256: sourceTreeSha256(),
            worktreeClean: worktreeClean(),
            bunVersion: bunVersion(),
            dependencies,
        },
        config: CONFIG,
        seedManifest: {
            path: relative(OUT, SEED_MANIFEST_PATH),
            sha256: sha256(seedManifestContent),
        },
        qualification:
            "Autonomous v0.7+RAWS research optimization only; no candidate is baked, shipped, or deployed by this run.",
    };
    immutableJson(RUN_PATH, run);
}
if (
    process.env.V07_96H_DEADLINE_EPOCH &&
    Date.parse(run.deadlineAt) !== Number(process.env.V07_96H_DEADLINE_EPOCH) * 1000
) {
    throw new Error("V07_96H_DEADLINE_EPOCH differs from the persisted run deadline");
}

const seedManifest = readJson(SEED_MANIFEST_PATH);
if (sha256(readFileSync(SEED_MANIFEST_PATH, "utf8")) !== run.seedManifest.sha256) {
    throw new Error("Seed manifest hash does not match run.json");
}
if (parsed.values["initialize-only"]) process.exit(0);

let state = existsSync(STATE_PATH)
    ? readJson(STATE_PATH)
    : {
          schemaVersion: 1,
          status: "research_only",
          runId: run.runId,
          phase: "probe-scout",
          generation: 0,
          promotions: 0,
          history: [],
      };
if (state.runId !== run.runId) throw new Error("state.json belongs to a different run");

function saveState() {
    state.updatedAt = new Date().toISOString();
    atomicJson(STATE_PATH, state);
}

function terminalDeadlineMs() {
    return Date.parse(run.deadlineAt);
}

function finalStartMs() {
    return terminalDeadlineMs() - CONFIG.finalReserveHours * 3_600_000;
}

function otherOptimizerActive() {
    if (!CONFIG.coexistPattern) return false;
    try {
        execFileSync("pgrep", ["-f", CONFIG.coexistPattern], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function cleanChildEnvironment(genome) {
    const environment = {};
    for (const key of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "LANG", "LC_ALL", "BUN_INSTALL", "NO_COLOR"]) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    environment.SIM_NO_ACTIONS = "1";
    if (genome.leafMode === "off") {
        environment.V07_SEARCH = "0";
        return environment;
    }
    environment.V07_SEARCH = "1";
    environment.SEARCH_VERSIONS = "v0.7";
    environment.SEARCH_GATE = String(genome.gate);
    environment.SEARCH_HORIZON = String(genome.horizon);
    environment.SEARCH_ROLLOUTS = String(genome.rollouts);
    environment.SEARCH_INCLUDE_MOVES = genome.includeMoves ? "1" : "0";
    environment.SEARCH_MAX_MELEE = String(genome.maxMelee);
    environment.SEARCH_MAX_SHOTS = String(genome.maxShots);
    environment.SEARCH_MAX_THROWS = String(genome.maxThrows);
    if (genome.leafMode === "material") environment.V07_VALUE_WEIGHTS = "material";
    else environment.V07_VALUE_WEIGHTS_V2 = JSON.stringify(genome.leaf);
    return environment;
}

function runChild(args, environment, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, args, {
            cwd: PACKAGE_ROOT,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
        });
        activeChildren.add(child);
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let killTimer;
        const timer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            activeChildren.delete(child);
            rejectPromise(error);
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            activeChildren.delete(child);
            if (timedOut) rejectPromise(new Error(`trial timeout after ${Math.round(timeoutMs / 1000)}s`));
            else if (code === 0) resolvePromise({ stdout, stderr });
            else rejectPromise(new Error(`trial exited ${code}: ${stderr.slice(-4000)}`));
        });
    });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        for (const child of activeChildren) child.kill(signal);
        heartbeat("interrupted", { signal });
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

function panelById(panelId) {
    const panel = seedManifest.panels[panelId];
    if (!panel) throw new Error(`Unknown immutable seed panel ${panelId}`);
    return panel;
}

function evaluationPath(panelId, genomeId, opponent) {
    return join(OUT, "evaluations", panelId, opponent, `${genomeId}.json`);
}

class EvaluationWindowClosed extends Error {}

function evaluationDeadlineMs(panelId) {
    const safetyMs = 10 * 60_000;
    return (panelId.startsWith("final-") ? terminalDeadlineMs() : finalStartMs()) - safetyMs;
}

function expectedBehaviorEnvironment(genome, auditPath) {
    const child = cleanChildEnvironment(genome);
    const expected = {};
    const behaviorKey = /^(?:V04_|V05_|V06_|V07_|SEARCH_|Q2_|CEM_)/;
    for (const [key, value] of Object.entries(child)) {
        if (
            behaviorKey.test(key) ||
            ["FIGHT_MELEE_ROSTERS", "LIVETWIN", "SIM_NO_ACTIONS", "VALUE_DATA", "VALUE_DATA_FEATURES"].includes(key)
        ) {
            expected[key] = value;
        }
    }
    expected.SEARCH_AUDIT = auditPath;
    return expected;
}

function validateTrialReport(report, genome, panelId, opponent, auditPath) {
    const panel = panelById(panelId);
    if (
        report?.schemaVersion !== 1 ||
        report.status !== "research_only" ||
        report.requested?.candidate !== "v0.7" ||
        report.requested?.opponent !== opponent ||
        report.requested?.runId !== run.runId ||
        report.requested?.panelId !== panelId ||
        report.requested?.gamesPerTemplate !== panel.gamesPerTemplate ||
        report.requested?.checkpointGames !== CONFIG.checkpointGames ||
        canonicalV0796hJson(report.requested?.seeds) !== canonicalV0796hJson(panel.seeds) ||
        !report.completeEightTemplatePanel ||
        report.templateMetrics?.length !== V07_96H_TEMPLATES.length
    ) {
        throw new Error(`Trial report protocol mismatch for ${panelId}/${opponent}`);
    }
    const provenance = report.provenance;
    if (
        !provenance?.revisionStable ||
        provenance.revision?.commit !== run.code.revision ||
        provenance.revisionAtCompletion?.commit !== run.code.revision ||
        provenance.revision?.trackedClean !== true ||
        provenance.revisionAtCompletion?.trackedClean !== true ||
        (!ALLOW_DIRTY &&
            (provenance.revision?.worktreeClean !== true ||
                provenance.revisionAtCompletion?.worktreeClean !== true ||
                provenance.revision?.branch !== "main" ||
                provenance.revisionAtCompletion?.branch !== "main"))
    ) {
        throw new Error(`Trial report source provenance mismatch for ${panelId}/${opponent}`);
    }
    const expectedEnvironment = expectedBehaviorEnvironment(genome, auditPath);
    if (canonicalV0796hJson(report.behaviorEnvironment) !== canonicalV0796hJson(expectedEnvironment)) {
        throw new Error(`Trial report behavior environment mismatch for ${panelId}/${opponent}`);
    }
    const searchEnabled = genome.leafMode !== "off";
    const audit = report.searchAudit;
    const expectedAuditGames = searchEnabled ? panel.gamesPerTemplate * V07_96H_TEMPLATES.length : 0;
    const auditComplete =
        audit?.enabled === true &&
        audit.path === auditPath &&
        audit.invalidJsonLines === 0 &&
        audit.validRows === expectedAuditGames &&
        audit.auditGames === expectedAuditGames &&
        audit.matchSearchLatencyMs?.count === expectedAuditGames &&
        (searchEnabled
            ? audit.modeCounts?.search === expectedAuditGames && Object.keys(audit.modeCounts).length === 1
            : Object.keys(audit.modeCounts ?? {}).length === 0);
    const latencyWithinBudget =
        !searchEnabled ||
        ((audit.matchSearchLatencyMs?.p95 ?? Infinity) <= 240_000 &&
            (audit.matchSearchLatencyMs?.max ?? Infinity) <= 240_000);
    return {
        auditComplete,
        latencyWithinBudget,
        operationalEligible: auditComplete && latencyWithinBudget,
        behaviorEnvironmentSha256: sha256(canonicalV0796hJson(report.behaviorEnvironment)),
        reportSha256: sha256(canonicalV0796hJson(report)),
    };
}

function validateCachedEvaluation(cached, genome, panelId, opponent, auditPath) {
    const genomeId = fingerprintV0796hGenome(genome);
    if (
        cached?.schemaVersion !== 2 ||
        cached.status !== "research_only" ||
        cached.runId !== run.runId ||
        cached.genomeId !== genomeId ||
        cached.panelId !== panelId ||
        cached.opponent !== opponent ||
        fingerprintV0796hGenome(cached.genome) !== genomeId
    ) {
        throw new Error("Evaluation cache identity mismatch");
    }
    const validation = validateTrialReport(cached.report, genome, panelId, opponent, auditPath);
    if (canonicalV0796hJson(validation) !== canonicalV0796hJson(cached.validation)) {
        throw new Error("Evaluation cache validation mismatch");
    }
    const auditContent = existsSync(auditPath) ? readFileSync(auditPath) : Buffer.from("");
    if (sha256(auditContent) !== cached.auditSha256) throw new Error("Evaluation audit hash mismatch");
    return cached;
}

async function evaluateOne(genome, panelId, opponent, concurrency) {
    const genomeId = fingerprintV0796hGenome(genome);
    const path = evaluationPath(panelId, genomeId, opponent);
    const auditPath = `${path}.audit.jsonl`;
    if (existsSync(path)) {
        try {
            return validateCachedEvaluation(readJson(path), genome, panelId, opponent, auditPath);
        } catch (error) {
            const quarantine = `${path}.invalid.${Date.now()}`;
            renameSync(path, quarantine);
            log(`quarantined invalid evaluation cache ${path}: ${String(error).slice(0, 300)}`);
        }
    }
    const panel = panelById(panelId);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const rawPath = `${path}.raw.${process.pid}.json`;
    const checkpointDir = `${path}.cells`;
    const args = [
        TRIAL,
        "--candidate=v0.7",
        `--opponent=${opponent}`,
        `--run-id=${run.runId}`,
        `--panel-id=${panelId}`,
        `--games=${panel.gamesPerTemplate}`,
        `--seeds-json=${JSON.stringify(panel.seeds)}`,
        `--concurrency=${concurrency}`,
        `--output=${rawPath}`,
        `--audit=${auditPath}`,
        `--checkpoint-dir=${checkpointDir}`,
        `--checkpoint-games=${CONFIG.checkpointGames}`,
    ];
    let lastError;
    for (let attempt = 1; attempt <= CONFIG.retryLimit; attempt += 1) {
        rmSync(rawPath, { force: true });
        const calculatedTimeoutMs = Math.max(
            600_000,
            Math.ceil((V07_96H_TEMPLATES.length * panel.gamesPerTemplate * 60_000) / Math.max(1, concurrency)),
        );
        const remainingMs = evaluationDeadlineMs(panelId) - Date.now();
        if (remainingMs <= 60_000) throw new EvaluationWindowClosed(`Evaluation window closed for ${panelId}`);
        const timeoutMs = Math.min(calculatedTimeoutMs, remainingMs);
        try {
            heartbeat("evaluating", { panelId, opponent, genomeId, attempt, concurrency });
            await runChild(args, cleanChildEnvironment(genome), timeoutMs);
            const report = readJson(rawPath);
            const metrics = report.templateMetrics;
            const fitness = scoreV0796hTrial(metrics);
            const validation = validateTrialReport(report, genome, panelId, opponent, auditPath);
            const auditSha256 = sha256(existsSync(auditPath) ? readFileSync(auditPath) : Buffer.from(""));
            const envelope = {
                schemaVersion: 2,
                status: "research_only",
                runId: run.runId,
                panelId,
                opponent,
                genomeId,
                genome,
                fitness,
                validation,
                auditSha256,
                report,
            };
            atomicJson(path, envelope);
            rmSync(rawPath, { force: true });
            return envelope;
        } catch (error) {
            if (error instanceof EvaluationWindowClosed) throw error;
            lastError = error;
            log(
                `trial failed panel=${panelId} opponent=${opponent} genome=${genomeId.slice(0, 12)} ` +
                    `attempt=${attempt}/${CONFIG.retryLimit}: ${String(error).slice(0, 500)}`,
            );
        }
    }
    rmSync(rawPath, { force: true });
    return {
        schemaVersion: 2,
        status: "failed",
        runId: run.runId,
        panelId,
        opponent,
        genomeId,
        genome,
        fitness: { valid: false, fitness: -1, reason: String(lastError) },
    };
}

async function evaluateMany(genomes, panelId, opponent = "v0.6") {
    const unique = uniqueGenomes(genomes);
    const results = [];
    for (let offset = 0; offset < unique.length;) {
        const coexist = otherOptimizerActive();
        const budget = panelId.startsWith("final-")
            ? CONFIG.workerBudget
            : coexist
              ? CONFIG.coexistWorkerBudget
              : CONFIG.workerBudget;
        const parallel = Math.max(1, Math.min(CONFIG.evalParallel, budget, unique.length - offset));
        const concurrency = Math.max(1, Math.floor(budget / parallel));
        const batch = unique.slice(offset, offset + parallel);
        log(
            `panel ${panelId}: batch=${offset / parallel + 1} candidates=${batch.length}/${unique.length} ` +
                `opponent=${opponent} workers/candidate=${concurrency} coexist=${coexist}`,
        );
        results.push(
            ...(await Promise.all(batch.map((genome) => evaluateOne(genome, panelId, opponent, concurrency)))),
        );
        offset += batch.length;
    }
    return results;
}

function uniqueGenomes(genomes) {
    const byId = new Map();
    for (const genome of genomes) byId.set(fingerprintV0796hGenome(genome), genome);
    return [...byId.values()];
}

function ranked(evaluations) {
    return evaluations
        .filter((evaluation) => evaluation.fitness?.valid && evaluation.validation?.operationalEligible)
        .sort(
            (left, right) =>
                right.fitness.fitness - left.fitness.fitness ||
                right.fitness.minimumTemplateRate - left.fitness.minimumTemplateRate ||
                right.fitness.geometricMeanRate - left.fitness.geometricMeanRate,
        );
}

function genomesOf(evaluations, count) {
    return ranked(evaluations)
        .slice(0, count)
        .map((evaluation) => evaluation.genome);
}

function requireRanked(evaluations, context) {
    const result = ranked(evaluations);
    if (!result.length) throw new Error(`${context} produced no valid candidate`);
    return result;
}

function evidenceReference(evaluation) {
    const path = evaluationPath(evaluation.panelId, evaluation.genomeId, evaluation.opponent);
    if (!existsSync(path)) throw new Error(`Missing evaluation artifact for ${evaluation.genomeId}`);
    return {
        panelId: evaluation.panelId,
        opponent: evaluation.opponent,
        genomeId: evaluation.genomeId,
        fitness: evaluation.fitness,
        evaluationPath: relative(OUT, path),
        evaluationSha256: sha256(readFileSync(path)),
        reportSha256: evaluation.validation.reportSha256,
        behaviorEnvironmentSha256: evaluation.validation.behaviorEnvironmentSha256,
        auditSha256: evaluation.auditSha256,
    };
}

function validateFrozenCandidate(candidate) {
    const { candidateFingerprint, ...fingerprinted } = candidate ?? {};
    if (
        candidate?.schemaVersion !== 1 ||
        candidate.status !== "research_only_frozen" ||
        candidate.runId !== run.runId ||
        candidate.genomeId !== fingerprintV0796hGenome(candidate.genome) ||
        candidate.genomeId !== fingerprintV0796hGenome(state.champion) ||
        candidateFingerprint !== fingerprintV0796h(fingerprinted) ||
        canonicalV0796hJson(candidate.code) !== canonicalV0796hJson(run.code) ||
        canonicalV0796hJson(candidate.seedManifest) !== canonicalV0796hJson(run.seedManifest) ||
        canonicalV0796hJson(candidate.selectionEvidence) !== canonicalV0796hJson(state.championEvidence)
    ) {
        throw new Error("Frozen candidate identity or fingerprint is invalid");
    }
    const evidence = candidate.selectionEvidence;
    const expectedPath = evaluationPath(evidence.panelId, evidence.genomeId, evidence.opponent);
    if (resolve(join(OUT, evidence.evaluationPath)) !== resolve(expectedPath)) {
        throw new Error("Frozen candidate selection evidence path is invalid");
    }
    const selection = validateCachedEvaluation(
        readJson(expectedPath),
        candidate.genome,
        evidence.panelId,
        evidence.opponent,
        `${expectedPath}.audit.jsonl`,
    );
    if (
        canonicalV0796hJson(evidenceReference(selection)) !== canonicalV0796hJson(evidence) ||
        canonicalV0796hJson(candidate.selectionBehaviorEnvironment) !==
            canonicalV0796hJson(selection.report.behaviorEnvironment)
    ) {
        throw new Error("Frozen candidate selection evidence is invalid");
    }
    return candidate;
}

function finalizeProbeFrom(evaluations, assessment, modelCandidates = evaluations) {
    const rankedEvaluations = requireRanked(evaluations, "probe fallback");
    const champion = rankedEvaluations[0];
    const modelSeed = requireRanked(modelCandidates, "probe model seed").find(
        (evaluation) => evaluation.genome.leafMode === "model",
    );
    if (!modelSeed) throw new Error("Probe found no valid model leaf for CEM");
    state.probeAssessment = assessment;
    state.champion = champion.genome;
    state.championEvidence = evidenceReference(champion);
    state.distribution = createV0796hDistribution(modelSeed.genome);
    state.phase = Date.now() >= finalStartMs() - 10 * 60_000 ? "freeze" : "optimize";
    saveState();
    return champion;
}

function latestProbeEvidence() {
    return state.probe.ceiling ?? state.probe.deep ?? state.probe.mid ?? state.probe.scout ?? [];
}

function requireResearchWindow() {
    if (Date.now() >= finalStartMs() - 10 * 60_000) {
        throw new EvaluationWindowClosed("Research window closed; freeze the best completed candidate");
    }
}

async function runProbe() {
    if (!state.probe) state.probe = {};
    const probes = v0796hProbeGenomes();
    const all = SMOKE
        ? [
              probes.find((genome) => genome.label === "v0.7-default-no-search"),
              probes.find(
                  (genome) =>
                      genome.label === "committed-20d" &&
                      genome.gate === 0.01 &&
                      genome.horizon === 12 &&
                      genome.rollouts === 1,
              ),
              probes.find(
                  (genome) =>
                      genome.label === "multicohort-60d" &&
                      genome.gate === 0.01 &&
                      genome.horizon === 12 &&
                      genome.rollouts === 1,
              ),
              probes.find(
                  (genome) =>
                      genome.label === "material" &&
                      genome.gate === 0.01 &&
                      genome.horizon === 12 &&
                      genome.rollouts === 1,
              ),
          ].filter(Boolean)
        : probes;
    if (!state.probe.scout) {
        requireResearchWindow();
        const evaluations = await evaluateMany(all, "probe-scout");
        state.probe.scout = requireRanked(evaluations, "probe scout");
        state.phase = "probe-mid";
        saveState();
    }
    if (!state.probe.mid) {
        requireResearchWindow();
        const candidates = genomesOf(state.probe.scout, CONFIG.probe.midKeep);
        const evaluations = await evaluateMany(candidates, "probe-mid");
        state.probe.mid = requireRanked(evaluations, "probe mid");
        state.phase = "probe-deep";
        saveState();
    }
    if (!state.probe.deep) {
        requireResearchWindow();
        const candidates = genomesOf(state.probe.mid, CONFIG.probe.deepKeep);
        const evaluations = await evaluateMany(candidates, "probe-deep");
        state.probe.deep = requireRanked(evaluations, "probe deep");
        state.phase = "probe-ceiling";
        saveState();
    }
    if (!state.probe.ceiling) {
        requireResearchWindow();
        const candidates = genomesOf(state.probe.deep, CONFIG.probe.ceilingKeep);
        const evaluations = await evaluateMany(candidates, "probe-ceiling");
        state.probe.ceiling = requireRanked(evaluations, "probe ceiling");
        const champion = state.probe.ceiling[0];
        const probeTemplateUpperBelowTarget = champion.report.templateMetrics.some(
            (metric) => metric.decisiveWinRate + 1.959963984540054 * (metric.standardErrorPp / 100) < CONFIG.target,
        );
        const assessment = {
            evaluatedAt: new Date().toISOString(),
            target: CONFIG.target,
            probeTemplateUpperBelowTarget,
            interpretation: probeTemplateUpperBelowTarget
                ? "The selected probe champion has a template-level 95% upper diagnostic below target; this does not bound later candidates or the search space."
                : "The selected probe champion has no template-level 95% upper diagnostic below target; continue autonomous max-min optimization.",
        };
        finalizeProbeFrom(state.probe.ceiling, assessment, [
            ...state.probe.ceiling,
            ...state.probe.deep,
            ...state.probe.mid,
        ]);
        log(
            `probe champion=${champion.genomeId.slice(0, 12)} min=${(
                100 * champion.fitness.minimumTemplateRate
            ).toFixed(2)}% probeTemplateUpperBelowTarget=${probeTemplateUpperBelowTarget}`,
        );
    }
}

function evaluationForGenome(evaluations, genome) {
    const id = fingerprintV0796hGenome(genome);
    return evaluations.find((evaluation) => evaluation.genomeId === id);
}

async function runGeneration(generation) {
    requireResearchWindow();
    const sampled = sampleV0796hPopulation(state.distribution, CONFIG.population, CONFIG.runSeed, generation);
    const probeAnchors = [state.champion, ...state.probe.ceiling.slice(0, 2).map((entry) => entry.genome)];
    const population = uniqueGenomes([...probeAnchors, ...sampled]).slice(0, CONFIG.population);
    const scoutPanel = `g${generation}-scout`;
    const scout = await evaluateMany(population, scoutPanel);
    requireResearchWindow();
    const midCandidates = uniqueGenomes([state.champion, ...genomesOf(scout, CONFIG.optimize.midKeep)]);
    const midPanel = `g${generation}-mid`;
    const mid = await evaluateMany(midCandidates, midPanel);
    requireResearchWindow();
    const deepCandidates = uniqueGenomes([state.champion, ...genomesOf(mid, CONFIG.optimize.deepKeep)]);
    const deepPanel = `g${generation}-deep`;
    const deep = await evaluateMany(deepCandidates, deepPanel);
    const deepRanked = requireRanked(deep, `generation ${generation} deep panel`);
    const incumbent = evaluationForGenome(deep, state.champion);
    if (!incumbent?.report) throw new Error(`generation ${generation} did not produce incumbent evidence`);
    const bestChallenger = deepRanked.find((evaluation) => evaluation.genomeId !== incumbent.genomeId);
    const challenger = deepRanked.find(
        (evaluation) =>
            evaluation.genomeId !== incumbent.genomeId &&
            evaluation.report &&
            shouldPromoteV0796h(
                evaluation.report.templateMetrics,
                incumbent.report.templateMetrics,
                CONFIG.optimize.minimumPromotionGain,
                CONFIG.optimize.maximumTemplateRegression,
            ) &&
            (evaluation.report.searchAudit.matchSearchLatencyMs.p95 ?? Infinity) <= 240_000,
    );
    let promoted = false;
    if (challenger) {
        state.champion = challenger.genome;
        state.championEvidence = evidenceReference(challenger);
        state.promotions += 1;
        promoted = true;
    }
    const elite = requireRanked(mid, `generation ${generation} mid panel`)
        .filter((evaluation) => evaluation.genome.leafMode === "model")
        .slice(0, CONFIG.elite)
        .map((evaluation) => evaluation.genome);
    if (elite.length) state.distribution = refitV0796hDistribution(state.distribution, elite);
    if ((generation + 1) % 8 === 0 && state.champion.leafMode === "model") {
        state.distribution = createV0796hDistribution(state.champion);
    }
    state.history.push({
        generation,
        completedAt: new Date().toISOString(),
        scoutPanel,
        midPanel,
        deepPanel,
        promoted,
        incumbent: incumbent.genomeId,
        bestChallenger: bestChallenger?.genomeId ?? null,
        promotedChallenger: challenger?.genomeId ?? null,
        champion: fingerprintV0796hGenome(state.champion),
        bestFitness: deepRanked[0].fitness,
    });
    state.generation = generation + 1;
    saveState();
    log(
        `generation ${generation} complete promoted=${promoted} champion=${fingerprintV0796hGenome(
            state.champion,
        ).slice(0, 12)} min=${(100 * state.championEvidence.fitness.minimumTemplateRate).toFixed(2)}%`,
    );
}

async function runOptimization() {
    try {
        while (Date.now() < finalStartMs() - 10 * 60_000 && state.generation < CONFIG.maxGenerations) {
            await runGeneration(state.generation);
        }
    } catch (error) {
        if (!(error instanceof EvaluationWindowClosed)) throw error;
        log(`research window closed during generation ${state.generation}; freezing current champion`);
    }
    state.phase = "freeze";
    saveState();
}

async function runFinal() {
    const frozenPath = join(OUT, "frozen-candidate.json");
    if (!state.frozenCandidate) {
        if (existsSync(frozenPath)) {
            const existing = readJson(frozenPath);
            state.frozenCandidate = validateFrozenCandidate(existing);
        } else {
            const selectionArtifact = readJson(join(OUT, state.championEvidence.evaluationPath));
            const frozen = {
                schemaVersion: 1,
                status: "research_only_frozen",
                runId: run.runId,
                frozenAt: new Date().toISOString(),
                code: run.code,
                seedManifest: run.seedManifest,
                genomeId: fingerprintV0796hGenome(state.champion),
                genome: state.champion,
                selectionBehaviorEnvironment: selectionArtifact.report.behaviorEnvironment,
                selectionEvidence: state.championEvidence,
                qualification: "Frozen before either final panel was opened.",
            };
            frozen.candidateFingerprint = fingerprintV0796h(frozen);
            validateFrozenCandidate(frozen);
            immutableJson(frozenPath, frozen);
            state.frozenCandidate = frozen;
        }
        state.phase = "final-v06";
        saveState();
    } else {
        validateFrozenCandidate(state.frozenCandidate);
        immutableJson(frozenPath, state.frozenCandidate);
    }
    if (!state.finalV06) {
        try {
            const [evaluation] = await evaluateMany([state.frozenCandidate.genome], "final-v06", "v0.6");
            if (!evaluation?.report) throw new Error("Final v0.6 panel failed");
            state.finalV06 = evaluation;
        } catch (error) {
            if (!(error instanceof EvaluationWindowClosed)) throw error;
            state.finalV06 = {
                status: "not_evaluated_deadline",
                panelId: "final-v06",
                opponent: "v0.6",
                reason: error.message,
            };
        }
        state.phase = "final-v04";
        saveState();
    }
    if (!state.finalV04) {
        if (state.finalV06.status !== "research_only") {
            state.finalV04 = {
                status: "not_evaluated_primary_incomplete",
                reason: "The primary v0.6 final panel did not complete before its deadline.",
            };
        } else if (terminalDeadlineMs() - Date.now() <= 15 * 60_000) {
            state.finalV04 = {
                status: "not_evaluated_deadline",
                reason: "Less than 15 minutes remained after the primary v0.6 final panel.",
            };
        } else {
            try {
                const [evaluation] = await evaluateMany([state.frozenCandidate.genome], "final-v04", "v0.4");
                if (!evaluation?.report) throw new Error("Final v0.4 transitivity panel failed");
                state.finalV04 = evaluation;
            } catch (error) {
                if (!(error instanceof EvaluationWindowClosed)) throw error;
                state.finalV04 = { status: "not_evaluated_deadline", reason: error.message };
            }
        }
        saveState();
    }
    const primaryComplete = state.finalV06.status === "research_only";
    const metrics = primaryComplete ? state.finalV06.report.templateMetrics : null;
    const finalAssessment = primaryComplete ? (state.finalV06.report.targetDiagnostics ?? null) : null;
    const primaryIntegrity =
        primaryComplete && state.finalV06.fitness.valid && state.finalV06.fitness.maximumDrawOrArmageddonRate <= 0.01;
    const primaryOperational = primaryComplete && state.finalV06.validation.operationalEligible;
    const targetAchieved =
        primaryIntegrity &&
        primaryOperational &&
        finalAssessment?.observed90AllArchetypes === true &&
        finalAssessment?.certified90AllArchetypes === true &&
        finalAssessment?.strict90AllTemplates === true;
    const terminalBase = {
        schemaVersion: 1,
        status: "complete_research_only",
        runId: run.runId,
        completedAt: new Date().toISOString(),
        deadlineAt: run.deadlineAt,
        code: run.code,
        frozenCandidate: state.frozenCandidate,
        finalStatus: primaryComplete ? "primary_complete" : "primary_incomplete_deadline",
        finalV06: primaryComplete
            ? {
                  panelId: state.finalV06.panelId,
                  genomeId: state.finalV06.genomeId,
                  fitness: scoreV0796hTrial(metrics),
                  targetAssessment: finalAssessment,
                  integrityQualified: primaryIntegrity,
                  operationalQualified: primaryOperational,
                  reportPath: relative(OUT, evaluationPath("final-v06", state.finalV06.genomeId, "v0.6")),
                  evaluationSha256: sha256(readFileSync(evaluationPath("final-v06", state.finalV06.genomeId, "v0.6"))),
              }
            : {
                  ...state.finalV06,
                  targetAssessment: null,
                  integrityQualified: false,
                  operationalQualified: false,
              },
        finalV04:
            state.finalV04.status === "research_only"
                ? {
                      panelId: state.finalV04.panelId,
                      genomeId: state.finalV04.genomeId,
                      fitness: state.finalV04.fitness,
                      reportPath: relative(OUT, evaluationPath("final-v04", state.finalV04.genomeId, "v0.4")),
                  }
                : state.finalV04,
        promotions: state.promotions,
        generations: state.generation,
        probeAssessment: state.probeAssessment,
        targetGate: {
            target: CONFIG.target,
            achieved: targetAchieved,
            observed90AllArchetypes: finalAssessment?.observed90AllArchetypes === true,
            certified90AllArchetypes: finalAssessment?.certified90AllArchetypes === true,
            strict90AllTemplates: finalAssessment?.strict90AllTemplates === true,
            integrityQualified: primaryIntegrity,
            operationalQualified: primaryOperational,
        },
        gateDecision: {
            bake: false,
            deploy: false,
            reason: "Simulation-only v0.7+RAWS research output; owner review and committed-default acceptance remain required.",
        },
    };
    const terminal = { ...terminalBase, terminalSha256: sha256(canonicalV0796hJson(terminalBase)) };
    immutableJson(TERMINAL_PATH, terminal);
    state.phase = "complete";
    state.status = "complete_research_only";
    saveState();
    heartbeat("complete", { terminal: TERMINAL_PATH });
    log(`complete -> ${TERMINAL_PATH}`);
}

async function main() {
    if (existsSync(TERMINAL_PATH)) {
        const terminal = readJson(TERMINAL_PATH);
        const { terminalSha256, ...terminalBase } = terminal;
        if (
            terminal.schemaVersion !== 1 ||
            terminal.status !== "complete_research_only" ||
            terminal.runId !== run.runId ||
            terminalSha256 !== sha256(canonicalV0796hJson(terminalBase))
        ) {
            throw new Error("TERMINAL.json is invalid or belongs to another run");
        }
        heartbeat("complete", { terminal: TERMINAL_PATH, resumed: true });
        return;
    }
    log(
        `start/resume run=${run.runId.slice(0, 12)} revision=${run.code.revision.slice(0, 12)} ` +
            `phase=${state.phase} deadline=${run.deadlineAt}`,
    );
    heartbeat(state.phase);
    if (state.phase.startsWith("probe")) {
        try {
            await runProbe();
        } catch (error) {
            if (!(error instanceof EvaluationWindowClosed) || !latestProbeEvidence().length) throw error;
            finalizeProbeFrom(latestProbeEvidence(), {
                evaluatedAt: new Date().toISOString(),
                target: CONFIG.target,
                probeTemplateUpperBelowTarget: null,
                interpretation:
                    "Probe stopped at the research deadline; freeze the best completed panel without a target-feasibility claim.",
            });
        }
    }
    if (state.phase === "optimize") await runOptimization();
    if (["freeze", "final-v06", "final-v04"].includes(state.phase)) await runFinal();
    if (state.phase === "complete" && !existsSync(TERMINAL_PATH)) {
        throw new Error("state says complete but TERMINAL.json is missing");
    }
}

main().catch((error) => {
    heartbeat("error", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
});
