/*
 * Research-only overnight follow-up to the d68490a v0.7+RAWS run.
 *
 * This driver deliberately searches a small, preregistered profile set around the late b9ce genome. It
 * targets the three observed blockers: melee_magic_utility strength, fire/ranged attrition integrity, and
 * headroom below the ranked server's 300ms per-decision circuit. It never edits source, bakes weights, commits,
 * pushes, or deploys. Use scripts/run_v0_7_96h.sh as the lifetime supervisor.
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
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
    expandV0796hPriorSeedManifest,
    fingerprintV0796h,
    fingerprintV0796hGenome,
    V07_96H_PAIR_SEED_STEP,
    V07_96H_TEMPLATES,
} from "./v0_7_96h_core.ts";
import {
    captureV07OvernightExecutionHost,
    chooseV07OvernightDeepEvidence,
    compareV07OvernightEvidence,
    qualifiesV07OvernightCircuit,
    summarizeV07OvernightCircuitAuditRows,
} from "./v0_7_overnight_core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../../..");
const TRIAL = join(HERE, "v0_7_search_trial.ts");
const DEFAULT_ANCHOR = join(PACKAGE_ROOT, "src/simulation/results/v0_7_96h_d68490a_outcome.json");
const EXPECTED_ANCHOR_ID = "b9ce98a735b14c7e57a5b83b70b4bca6b2e45d6a23ce35dd27c2e5b914b1abaa";
const MIN_DECISION_HEADROOM_MS = 35;
const FOCUS_TEMPLATES = ["melee_magic_utility", "mage_fireline", "ranged_precision"];
const ALL_TEMPLATES = V07_96H_TEMPLATES.map(({ template }) => template);
const activeChildren = new Set();

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
    process.stdout.write("usage: bun src/simulation/optimizer/v0_7_overnight.mjs --out=DIR\n");
    process.exit(0);
}

function integer(name, fallback, minimum = 1) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
}

function evenGames(name, fallback) {
    const value = integer(name, fallback, 2);
    if (value % 2 !== 0) throw new Error(`${name} must be even for paired side swaps`);
    return value;
}

function positive(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
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
    protocol: "v0.7-overnight-active-circuit-v3",
    workers: integer("V07_OVERNIGHT_WORKERS", 12),
    checkpointGames: evenGames("V07_OVERNIGHT_CHECKPOINT_GAMES", 32),
    scoutGames: evenGames("V07_OVERNIGHT_SCOUT_GAMES", 32),
    deepGames: evenGames("V07_OVERNIGHT_DEEP_GAMES", 128),
    finalGames: evenGames("V07_OVERNIGHT_FINAL_GAMES", 256),
    deepKeep: integer("V07_OVERNIGHT_DEEP_KEEP", 3),
    finalReserveHours: positive("V07_OVERNIGHT_FINAL_RESERVE_HOURS", 4),
    circuitBreakerMs: positive("V07_OVERNIGHT_CIRCUIT_MS", 275),
    decisionDeadlineMs: positive("V07_OVERNIGHT_DECISION_DEADLINE_MS", 240),
    maximumCircuitOpenGameRate: positive("V07_OVERNIGHT_MAX_CIRCUIT_OPEN_RATE", 0.01),
    maximumDrawOrArmageddonRate: positive("V07_OVERNIGHT_MAX_DRAW_ARM_RATE", 0.01),
    target: positive("V07_OVERNIGHT_TARGET", 0.9),
    anchorPath: resolve(process.env.V07_OVERNIGHT_ANCHOR ?? DEFAULT_ANCHOR),
};
if (CONFIG.target !== 0.9) throw new Error("V07_OVERNIGHT_TARGET is fixed at 0.9");
if (CONFIG.maximumCircuitOpenGameRate > 1 || CONFIG.maximumDrawOrArmageddonRate > 1) {
    throw new Error("overnight rate gates must not exceed 1");
}
if (CONFIG.circuitBreakerMs > 275) {
    throw new Error("V07_OVERNIGHT_CIRCUIT_MS must be <= 275 to preserve headroom below the live 300ms wrapper");
}
if (CONFIG.circuitBreakerMs - CONFIG.decisionDeadlineMs < MIN_DECISION_HEADROOM_MS) {
    throw new Error(
        `V07_OVERNIGHT_DECISION_DEADLINE_MS must leave at least ${MIN_DECISION_HEADROOM_MS}ms below V07_OVERNIGHT_CIRCUIT_MS`,
    );
}

const RUN_PATH = join(OUT, "run.json");
const STATE_PATH = join(OUT, "state.json");
const SEED_MANIFEST_PATH = join(OUT, "seed-manifest.json");
const terminalMarker = process.env.V07_96H_TERMINAL_MARKER ?? "TERMINAL.json";
const TERMINAL_PATH = terminalMarker.startsWith("/") ? resolve(terminalMarker) : resolve(OUT, terminalMarker);
const HEARTBEAT_PATH = join(OUT, "heartbeat");
const LOG_PATH = join(OUT, "driver.log");

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function atomicText(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
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
    if (existsSync(path)) {
        if (readFileSync(path, "utf8") !== content) throw new Error(`Immutable artifact conflicts: ${path}`);
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
    atomicJson(HEARTBEAT_PATH, { schemaVersion: 1, pid: process.pid, at: new Date().toISOString(), phase, ...detail });
}

function gitText(args) {
    return execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim();
}

function sourceTreeSha256() {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: PACKAGE_ROOT })
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .sort();
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(file);
        hash.update("\0");
        hash.update(readFileSync(join(PACKAGE_ROOT, file)));
        hash.update("\0");
    }
    return hash.digest("hex");
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
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
            left.name.localeCompare(right.name),
        )) {
            if (entry.name.startsWith(".") || !isDirectory(entry)) continue;
            const entryPath = join(directory, entry.name);
            if (entry.name.startsWith("@")) {
                for (const scoped of readdirSync(entryPath, { withFileTypes: true }).sort((left, right) =>
                    left.name.localeCompare(right.name),
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
    return { ...manifest, sha256: sha256(canonicalJson(manifest)) };
}

function loadAnchor() {
    const raw = readFileSync(CONFIG.anchorPath, "utf8");
    const artifact = JSON.parse(raw);
    const genome = artifact?.lateResearchCandidate?.genome;
    const genomeId = artifact?.lateResearchCandidate?.genomeId;
    if (!genome || genomeId !== EXPECTED_ANCHOR_ID || fingerprintV0796hGenome(genome) !== EXPECTED_ANCHOR_ID) {
        throw new Error(`Overnight anchor must contain the exact ${EXPECTED_ANCHOR_ID.slice(0, 12)} late genome`);
    }
    return {
        path: relative(PACKAGE_ROOT, CONFIG.anchorPath),
        artifactSha256: sha256(raw),
        genomeId,
        genome,
    };
}

function profile(label, anchorGenome, overrides, activeChallengers = true, shortlist = null) {
    if (shortlist !== null && (!Number.isSafeInteger(shortlist) || shortlist < 2)) {
        throw new Error(`Invalid shortlist for ${label}`);
    }
    const genome = { ...anchorGenome, ...overrides, label };
    const behavior = {
        genome,
        activeChallengers,
        ...(shortlist === null ? {} : { shortlist }),
    };
    return { id: fingerprintV0796h(behavior), label, ...behavior };
}

function profilesFor(anchorGenome) {
    return [
        profile("b9ce-reference-h24-r4", anchorGenome, {}, false),
        profile("b9ce-h24-r2-c9-4-4", anchorGenome, { rollouts: 2 }, false),
        profile("b9ce-h24-r1-c9-4-4", anchorGenome, { rollouts: 1 }, false),
        profile("active-h24-r4-c9-4-4", anchorGenome, {}, true),
        profile("active-h24-r2-c9-4-4", anchorGenome, { rollouts: 2 }, true),
        profile("active-h24-r1-c9-4-4", anchorGenome, { rollouts: 1 }, true),
        profile("active-h24-r1-s3-c9-4-4", anchorGenome, { rollouts: 1 }, true, 3),
        profile("active-h24-r1-s4-c9-4-4", anchorGenome, { rollouts: 1 }, true, 4),
        profile(
            "active-h24-r1-c4-3-2",
            anchorGenome,
            { horizon: 24, rollouts: 1, maxMelee: 4, maxShots: 3, maxThrows: 2 },
            true,
        ),
        profile(
            "active-h16-r1-c7-4-3",
            anchorGenome,
            { horizon: 16, rollouts: 1, maxMelee: 7, maxShots: 4, maxThrows: 3 },
            true,
        ),
        profile(
            "active-h16-r1-s3-c7-4-3",
            anchorGenome,
            { horizon: 16, rollouts: 1, maxMelee: 7, maxShots: 4, maxThrows: 3 },
            true,
            3,
        ),
        profile(
            "active-h16-r1-c4-3-2",
            anchorGenome,
            { horizon: 16, rollouts: 1, maxMelee: 4, maxShots: 3, maxThrows: 2 },
            true,
        ),
        profile(
            "active-h16-r1-s4-c4-3-2",
            anchorGenome,
            { horizon: 16, rollouts: 1, maxMelee: 4, maxShots: 3, maxThrows: 2 },
            true,
            4,
        ),
        profile(
            "active-h12-r1-c6-4-2",
            anchorGenome,
            { horizon: 12, rollouts: 1, maxMelee: 6, maxShots: 4, maxThrows: 2 },
            true,
        ),
        profile(
            "active-h12-r1-s4-c6-4-2",
            anchorGenome,
            { horizon: 12, rollouts: 1, maxMelee: 6, maxShots: 4, maxThrows: 2 },
            true,
            4,
        ),
        profile(
            "active-h8-r1-c5-4-2",
            anchorGenome,
            { horizon: 8, rollouts: 1, maxMelee: 5, maxShots: 4, maxThrows: 2 },
            true,
        ),
        profile(
            "active-h8-r1-c4-3-2",
            anchorGenome,
            { horizon: 8, rollouts: 1, maxMelee: 4, maxShots: 3, maxThrows: 2 },
            true,
        ),
        profile(
            "active-h4-r1-c4-3-2",
            anchorGenome,
            { horizon: 4, rollouts: 1, maxMelee: 4, maxShots: 3, maxThrows: 2 },
            true,
        ),
    ];
}

function priorSeedState() {
    const used = new Set();
    const manifests = [];
    const committedDirectory = join(PACKAGE_ROOT, "src/simulation/manifests");
    const paths = readdirSync(committedDirectory)
        .filter((name) => /^v0_7.*\.json$/.test(name))
        .sort()
        .map((name) => join(committedDirectory, name));
    const parent = dirname(OUT);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(parent, entry.name, "seed-manifest.json");
        if (resolve(path) !== resolve(SEED_MANIFEST_PATH) && existsSync(path)) paths.push(path);
    }
    for (const path of paths) {
        const raw = readFileSync(path, "utf8");
        const manifest = JSON.parse(raw);
        for (const seed of expandV0796hPriorSeedManifest(manifest)) used.add(seed);
        manifests.push({
            path: path.startsWith(PACKAGE_ROOT) ? relative(PACKAGE_ROOT, path) : resolve(path),
            sha256: sha256(raw),
        });
    }
    return { used, manifests };
}

function allocatePanel(runId, id, gamesPerTemplate, used) {
    const seeds = {};
    const nonces = {};
    for (const template of ALL_TEMPLATES) {
        for (let nonce = 0; ; nonce += 1) {
            const base = createHash("sha256").update(`${runId}|${id}|${template}|${nonce}`).digest().readUInt32BE(0);
            const derived = Array.from(
                { length: gamesPerTemplate / 2 },
                (_, pair) => (base + Math.imul(pair, V07_96H_PAIR_SEED_STEP)) >>> 0,
            );
            if (derived.some((seed) => used.has(seed))) continue;
            seeds[template] = base;
            nonces[template] = nonce;
            for (const seed of derived) used.add(seed);
            break;
        }
    }
    return { id, gamesPerTemplate, seeds, nonces };
}

function initializationFingerprint(revision, anchor) {
    return fingerprintV0796h({
        protocol: CONFIG.protocol,
        revision,
        config: CONFIG,
        anchorId: anchor.genomeId,
        anchorArtifactSha256: anchor.artifactSha256,
        dependencySnapshotSha256: dependencies.sha256,
        executionHost,
    });
}

function initializedRunId(protocolFingerprint, createdAt, deadlineAt) {
    return fingerprintV0796h({ protocolFingerprint, createdAt, deadlineAt });
}

function validateSeedManifest(manifest, revision, anchor) {
    const protocolFingerprint = initializationFingerprint(revision, anchor);
    const bootstrap = manifest?.bootstrap;
    if (
        manifest?.schemaVersion !== 1 ||
        manifest.status !== "research_only" ||
        manifest.protocol !== CONFIG.protocol ||
        manifest.pairSeedStep !== V07_96H_PAIR_SEED_STEP ||
        bootstrap?.protocolFingerprint !== protocolFingerprint ||
        bootstrap.revision !== revision ||
        bootstrap.anchorId !== anchor.genomeId ||
        bootstrap.anchorArtifactSha256 !== anchor.artifactSha256 ||
        bootstrap.dependencySnapshotSha256 !== dependencies.sha256 ||
        canonicalJson(bootstrap.executionHost) !== canonicalJson(executionHost) ||
        !Number.isFinite(Date.parse(bootstrap.createdAt)) ||
        !Number.isFinite(Date.parse(bootstrap.deadlineAt)) ||
        Date.parse(bootstrap.deadlineAt) <= Date.parse(bootstrap.createdAt) ||
        manifest.runId !== initializedRunId(protocolFingerprint, bootstrap.createdAt, bootstrap.deadlineAt)
    ) {
        throw new Error("Orphaned overnight seed manifest has an invalid bootstrap identity");
    }
    const requestedDeadline = Number(process.env.V07_96H_DEADLINE_EPOCH) * 1000;
    if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline !== Date.parse(bootstrap.deadlineAt)) {
        throw new Error("Orphaned overnight seed manifest differs from the supervised deadline");
    }

    const priorSeeds = new Set();
    if (!Array.isArray(manifest.priorManifests)) throw new Error("Overnight prior manifest ledger is invalid");
    for (const reference of manifest.priorManifests) {
        if (typeof reference?.path !== "string" || typeof reference.sha256 !== "string") {
            throw new Error("Overnight prior manifest reference is invalid");
        }
        const path = resolve(PACKAGE_ROOT, reference.path);
        const raw = readFileSync(path, "utf8");
        if (sha256(raw) !== reference.sha256) throw new Error(`Overnight prior manifest drifted: ${path}`);
        for (const seed of expandV0796hPriorSeedManifest(JSON.parse(raw))) priorSeeds.add(seed);
    }
    if (manifest.priorDerivedScenarioSeeds !== priorSeeds.size) {
        throw new Error("Overnight prior seed count is invalid");
    }

    const expectedPanels = {
        scout: CONFIG.scoutGames,
        deep: CONFIG.deepGames,
        final: CONFIG.finalGames,
    };
    const allocatedSeeds = new Set();
    for (const [panelId, gamesPerTemplate] of Object.entries(expectedPanels)) {
        const panel = manifest.panels?.[panelId];
        if (
            panel?.id !== panelId ||
            panel.gamesPerTemplate !== gamesPerTemplate ||
            canonicalJson(Object.keys(panel.seeds ?? {}).sort()) !== canonicalJson([...ALL_TEMPLATES].sort()) ||
            canonicalJson(Object.keys(panel.nonces ?? {}).sort()) !== canonicalJson([...ALL_TEMPLATES].sort())
        ) {
            throw new Error(`Overnight ${panelId} seed panel is invalid`);
        }
        for (const template of ALL_TEMPLATES) {
            const base = panel.seeds[template];
            const nonce = panel.nonces[template];
            if (
                !Number.isSafeInteger(base) ||
                base < 0 ||
                base > 0xffff_ffff ||
                !Number.isSafeInteger(nonce) ||
                nonce < 0
            ) {
                throw new Error(`Overnight ${panelId}/${template} seed allocation is invalid`);
            }
            for (let pair = 0; pair < gamesPerTemplate / 2; pair += 1) {
                const seed = (base + Math.imul(pair, V07_96H_PAIR_SEED_STEP)) >>> 0;
                if (priorSeeds.has(seed) || allocatedSeeds.has(seed)) {
                    throw new Error(`Overnight seed collision at ${panelId}/${template}/${seed}`);
                }
                allocatedSeeds.add(seed);
            }
        }
    }
    if (manifest.allocatedDerivedScenarioSeeds !== allocatedSeeds.size) {
        throw new Error("Overnight allocated seed count is invalid");
    }
    return bootstrap;
}

function initializeRun() {
    const revision = gitText(["rev-parse", "HEAD"]);
    const anchor = loadAnchor();
    if (!existsSync(SEED_MANIFEST_PATH)) {
        const createdAt = new Date().toISOString();
        const deadlineEpoch = Number(process.env.V07_96H_DEADLINE_EPOCH);
        if (!Number.isSafeInteger(deadlineEpoch) || deadlineEpoch * 1000 <= Date.now()) {
            throw new Error("V07_96H_DEADLINE_EPOCH must name a future whole-second epoch");
        }
        const deadlineAt = new Date(deadlineEpoch * 1000).toISOString();
        const protocolFingerprint = initializationFingerprint(revision, anchor);
        const runId = initializedRunId(protocolFingerprint, createdAt, deadlineAt);
        const prior = priorSeedState();
        const used = new Set(prior.used);
        const panels = {
            scout: allocatePanel(runId, "scout", CONFIG.scoutGames, used),
            deep: allocatePanel(runId, "deep", CONFIG.deepGames, used),
            final: allocatePanel(runId, "final", CONFIG.finalGames, used),
        };
        immutableJson(SEED_MANIFEST_PATH, {
            schemaVersion: 1,
            status: "research_only",
            protocol: CONFIG.protocol,
            runId,
            bootstrap: {
                protocolFingerprint,
                revision,
                createdAt,
                deadlineAt,
                anchorId: anchor.genomeId,
                anchorArtifactSha256: anchor.artifactSha256,
                dependencySnapshotSha256: dependencies.sha256,
                executionHost,
            },
            pairSeedStep: V07_96H_PAIR_SEED_STEP,
            priorManifests: prior.manifests,
            priorDerivedScenarioSeeds: prior.used.size,
            allocatedDerivedScenarioSeeds: used.size - prior.used.size,
            panels,
            declaration:
                "All overnight scout/deep/final pair streams were allocated before outcomes and are disjoint from committed v0.7 and sibling run manifests.",
        });
    }
    const seedManifest = readJson(SEED_MANIFEST_PATH);
    const bootstrap = validateSeedManifest(seedManifest, revision, anchor);
    const manifestRaw = readFileSync(SEED_MANIFEST_PATH, "utf8");
    const run = {
        schemaVersion: 1,
        status: "research_only",
        runId: seedManifest.runId,
        createdAt: bootstrap.createdAt,
        deadlineAt: bootstrap.deadlineAt,
        code: {
            revision,
            branch: gitText(["branch", "--show-current"]),
            originMain: gitText(["rev-parse", "origin/main"]),
            sourceTreeSha256: sourceTreeSha256(),
            bunVersion: process.versions.bun,
            dependencies,
        },
        executionHost,
        config: CONFIG,
        anchor: { path: anchor.path, artifactSha256: anchor.artifactSha256, genomeId: anchor.genomeId },
        seedManifest: { path: "seed-manifest.json", sha256: sha256(manifestRaw) },
        qualification: "Bounded v0.7+RAWS research only; no bake, default change, commit, push, or deploy.",
    };
    immutableJson(RUN_PATH, run);
}

mkdirSync(OUT, { recursive: true });
if (process.env.V07_96H_RESEARCH_ONLY !== "1") throw new Error("V07_96H_RESEARCH_ONLY=1 is required");
if (gitText(["branch", "--show-current"]) !== "main") throw new Error("Overnight research must run from main");
if (gitText(["rev-parse", "HEAD"]) !== gitText(["rev-parse", "origin/main"])) {
    throw new Error("Overnight research requires HEAD to equal pushed origin/main");
}
if (gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("Overnight research refuses a dirty source tree");
}
const dependencies = installedDependencySnapshot();
const executionHost = captureV07OvernightExecutionHost();

const allocationLock = join(dirname(OUT), ".v0_7_96h_seed_allocation.flock");
if (!existsSync(RUN_PATH) && process.env.V07_OVERNIGHT_SEED_LOCK_HELD !== "1") {
    execFileSync(
        "flock",
        [
            "-x",
            "-w",
            "120",
            allocationLock,
            process.execPath,
            fileURLToPath(import.meta.url),
            `--out=${OUT}`,
            "--initialize-only",
        ],
        {
            cwd: PACKAGE_ROOT,
            env: { ...process.env, V07_OVERNIGHT_SEED_LOCK_HELD: "1" },
            stdio: "inherit",
        },
    );
} else if (!existsSync(RUN_PATH)) {
    initializeRun();
}
if (!existsSync(RUN_PATH)) throw new Error("Locked overnight initialization did not create run.json");

const run = readJson(RUN_PATH);
const anchor = loadAnchor();
const seedManifest = readJson(SEED_MANIFEST_PATH);
if (
    run.runId !== seedManifest.runId ||
    canonicalJson(run.config) !== canonicalJson(CONFIG) ||
    !Number.isFinite(Date.parse(run.createdAt)) ||
    !Number.isFinite(Date.parse(run.deadlineAt)) ||
    Date.parse(run.deadlineAt) <= Date.parse(run.createdAt) ||
    Number(process.env.V07_96H_DEADLINE_EPOCH) * 1000 !== Date.parse(run.deadlineAt) ||
    run.code.revision !== gitText(["rev-parse", "HEAD"]) ||
    run.code.sourceTreeSha256 !== sourceTreeSha256() ||
    run.code.bunVersion !== process.versions.bun ||
    canonicalJson(run.code.dependencies) !== canonicalJson(dependencies) ||
    canonicalJson(run.executionHost) !== canonicalJson(executionHost) ||
    run.anchor.artifactSha256 !== anchor.artifactSha256 ||
    run.seedManifest.sha256 !== sha256(readFileSync(SEED_MANIFEST_PATH))
) {
    throw new Error("Overnight run source, config, anchor, or seed manifest drifted on resume");
}
if (parsed.values["initialize-only"]) process.exit(0);

let state = existsSync(STATE_PATH)
    ? readJson(STATE_PATH)
    : {
          schemaVersion: 1,
          status: "research_only",
          runId: run.runId,
          phase: "scout",
          scout: [],
          deepSelection: [],
          deep: [],
      };
if (
    state?.schemaVersion !== 1 ||
    state.runId !== run.runId ||
    !["research_only", "complete_research_only"].includes(state.status) ||
    !["scout", "deep", "final", "complete"].includes(state.phase) ||
    !Array.isArray(state.scout) ||
    !Array.isArray(state.deep) ||
    !Array.isArray(state.deepSelection) ||
    (state.phase === "complete" && state.status !== "complete_research_only")
) {
    throw new Error("state.json has an invalid overnight identity or phase");
}
if (
    (state.phase !== "complete" && state.status !== "research_only") ||
    (state.phase === "scout" && (state.deepSelection.length !== 0 || state.deep.length !== 0)) ||
    (["deep", "final"].includes(state.phase) && state.scout.length === 0) ||
    state.deepSelection.length > CONFIG.deepKeep ||
    state.deepSelection.some((profileId) => typeof profileId !== "string")
) {
    throw new Error("state.json contents do not match its overnight phase");
}

function saveState() {
    state.updatedAt = new Date().toISOString();
    atomicJson(STATE_PATH, state);
}

function cleanChildEnvironment(candidate) {
    const environment = {};
    for (const key of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "LANG", "LC_ALL", "BUN_INSTALL", "NO_COLOR"]) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
    Object.assign(environment, {
        // Keep every profile on the source and environment observed by this process. This is the documented
        // Bun switch for disabling the runtime transpiler cache.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        SIM_NO_ACTIONS: "1",
        V07_SEARCH: "1",
        SEARCH_VERSIONS: "v0.7",
        SEARCH_GATE: String(candidate.genome.gate),
        SEARCH_HORIZON: String(candidate.genome.horizon),
        SEARCH_ROLLOUTS: String(candidate.genome.rollouts),
        SEARCH_INCLUDE_MOVES: "0",
        SEARCH_MAX_MOVES: "1",
        SEARCH_MAX_MELEE: String(candidate.genome.maxMelee),
        SEARCH_MAX_SHOTS: String(candidate.genome.maxShots),
        SEARCH_MAX_THROWS: String(candidate.genome.maxThrows),
        SEARCH_ACTIVE_CHALLENGERS: candidate.activeChallengers ? "1" : "0",
        ...(candidate.shortlist === undefined ? {} : { SEARCH_SHORTLIST: String(candidate.shortlist) }),
        SEARCH_DECISION_DEADLINE_MS: String(CONFIG.decisionDeadlineMs),
        SEARCH_CIRCUIT_BREAKER_MS: String(CONFIG.circuitBreakerMs),
        V07_VALUE_WEIGHTS_V2: JSON.stringify(candidate.genome.leaf),
    });
    return environment;
}

function expectedBehaviorEnvironment(candidate, auditPath) {
    const child = cleanChildEnvironment(candidate);
    return Object.fromEntries(
        [...Object.entries(child), ["SEARCH_AUDIT", auditPath], ["SEARCH_AUDIT_TURNS", "1"]]
            .filter(([key]) => /^(?:V04_|V05_|V06_|V07_|SEARCH_|Q2_|CEM_)/.test(key) || key === "SIM_NO_ACTIONS")
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function expectedAuditGames(templates, games, seeds) {
    const templateByGameKey = new Map();
    for (const template of templates) {
        for (let game = 0; game < games; game += 1) {
            const seed = (seeds[template] + Math.imul(Math.floor(game / 2), V07_96H_PAIR_SEED_STEP)) >>> 0;
            const candidateIsGreen = game % 2 === 0;
            const key = `${seed}|${candidateIsGreen ? "v0.7" : "v0.6"}|${candidateIsGreen ? "v0.6" : "v0.7"}`;
            if (templateByGameKey.has(key)) throw new Error(`Overnight expected audit key collision: ${key}`);
            templateByGameKey.set(key, template);
        }
    }
    return templateByGameKey;
}

function auditDiagnostics(path, expectedTemplateByGameKey, candidate) {
    let invalidJsonLines = 0;
    const rows = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            rows.push(JSON.parse(line));
        } catch {
            invalidJsonLines += 1;
        }
    }
    if (invalidJsonLines) throw new Error(`Overnight audit has ${invalidJsonLines} invalid JSON lines`);
    return summarizeV07OvernightCircuitAuditRows(rows, expectedTemplateByGameKey, CONFIG.circuitBreakerMs, {
        shortlist: candidate.shortlist ?? null,
        decisionDeadlineMs: CONFIG.decisionDeadlineMs,
    });
}

function metricMap(report) {
    return new Map(report.templateMetrics.map((metric) => [metric.template, metric]));
}

function summarizeEvaluation(report, circuit) {
    const metrics = metricMap(report);
    const utility = metrics.get("melee_magic_utility")?.decisiveWinRate ?? 0;
    const fire = metrics.get("mage_fireline");
    const ranged = metrics.get("ranged_precision");
    const minimumTemplateRate = Math.min(...report.templateMetrics.map((metric) => metric.decisiveWinRate));
    const maximumDrawOrArmageddonRate = Math.max(
        ...report.templateMetrics.map((metric) => metric.drawOrArmageddonRate),
    );
    const integrityUtility = Math.min(
        utility,
        fire?.decisiveWinRate ?? 0,
        ranged?.decisiveWinRate ?? 0,
        1 - (fire?.drawOrArmageddonRate ?? 1),
        1 - (ranged?.drawOrArmageddonRate ?? 1),
    );
    const candidateRejections = report.templateMetrics.reduce((sum, metric) => sum + metric.candidateRejections, 0);
    const missingRejectionCounts = report.templateMetrics.reduce(
        (sum, metric) => sum + metric.missingRejectionCounts,
        0,
    );
    return {
        minimumTemplateRate,
        maximumDrawOrArmageddonRate,
        integrityUtility,
        utilityDecisiveWinRate: utility,
        fireDecisiveWinRate: fire?.decisiveWinRate ?? null,
        fireDrawOrArmageddonRate: fire?.drawOrArmageddonRate ?? null,
        rangedDecisiveWinRate: ranged?.decisiveWinRate ?? null,
        rangedDrawOrArmageddonRate: ranged?.drawOrArmageddonRate ?? null,
        candidateRejections,
        missingRejectionCounts,
        circuitQualified: qualifiesV07OvernightCircuit(
            circuit,
            CONFIG.maximumCircuitOpenGameRate,
            CONFIG.circuitBreakerMs,
        ),
        integrityQualified:
            maximumDrawOrArmageddonRate <= CONFIG.maximumDrawOrArmageddonRate &&
            candidateRejections === 0 &&
            missingRejectionCounts === 0,
    };
}

function evaluationPaths(panelId, candidate) {
    const directory = join(OUT, "evaluations", panelId);
    return {
        directory,
        report: join(directory, `${candidate.id}.report.json`),
        audit: join(directory, `${candidate.id}.audit.jsonl`),
        envelope: join(directory, `${candidate.id}.json`),
        checkpoints: join(OUT, "checkpoints", panelId, candidate.id),
    };
}

function validateEvaluation(candidate, panelId, templates, games, paths, cutoffMs) {
    const report = readJson(paths.report);
    const panel = seedManifest.panels[panelId];
    const seeds = Object.fromEntries(templates.map((template) => [template, panel.seeds[template]]));
    const generatedAt = Date.parse(report?.generatedAt);
    const completedAt = Date.parse(report?.completedAt);
    if (
        report?.schemaVersion !== 1 ||
        report.status !== "research_only" ||
        report.requested?.candidate !== "v0.7" ||
        report.requested?.opponent !== "v0.6" ||
        report.requested?.runId !== run.runId ||
        report.requested?.panelId !== panelId ||
        report.requested?.gamesPerTemplate !== games ||
        report.requested?.auditTurns !== true ||
        report.requested?.checkpointGames !== CONFIG.checkpointGames ||
        canonicalJson(report.requested?.templates) !== canonicalJson(templates) ||
        canonicalJson(report.requested?.seeds) !== canonicalJson(seeds) ||
        canonicalJson(report.behaviorEnvironment) !==
            canonicalJson(expectedBehaviorEnvironment(candidate, paths.audit)) ||
        report.provenance?.revisionStable !== true ||
        report.provenance?.revision?.commit !== run.code.revision ||
        report.provenance?.revisionAtCompletion?.commit !== run.code.revision ||
        report.provenance?.revision?.worktreeClean !== true ||
        report.provenance?.revisionAtCompletion?.worktreeClean !== true ||
        report.templateMetrics?.length !== templates.length ||
        report.searchAudit?.auditGames !== templates.length * games ||
        report.searchAudit?.invalidJsonLines !== 0 ||
        report.searchAudit?.searchedTurnLatencyMs?.count !== report.searchAudit?.searchedTurns ||
        !Number.isFinite(generatedAt) ||
        !Number.isFinite(completedAt) ||
        generatedAt < Date.parse(run.createdAt) ||
        completedAt < generatedAt ||
        completedAt > cutoffMs
    ) {
        throw new Error(`Overnight report protocol mismatch for ${panelId}/${candidate.label}`);
    }
    const circuit = auditDiagnostics(paths.audit, expectedAuditGames(templates, games, seeds), candidate);
    const expectedAuditGameCount = templates.length * games;
    const expectedScoredRate = circuit.work.enumeratedCandidatesTotal
        ? circuit.work.scoredCandidatesTotal / circuit.work.enumeratedCandidatesTotal
        : null;
    const shortlistKey = candidate.shortlist === undefined ? "off" : String(candidate.shortlist);
    if (
        circuit.turnRows !== report.searchAudit.searchedTurns ||
        circuit.work.enumeratedCandidatesTotal !== report.searchAudit.enumeratedCandidatesTotal ||
        circuit.work.scoredCandidatesTotal !== report.searchAudit.scoredCandidatesTotal ||
        circuit.work.deadlineFallbacks !== report.searchAudit.deadlineFallbacks ||
        report.searchAudit.scoredCandidateRate !== expectedScoredRate ||
        canonicalJson(report.searchAudit.shortlistCounts) !==
            canonicalJson({ [shortlistKey]: expectedAuditGameCount }) ||
        canonicalJson(report.searchAudit.decisionDeadlineCounts) !==
            canonicalJson({ [String(CONFIG.decisionDeadlineMs)]: expectedAuditGameCount }) ||
        canonicalJson(report.searchAudit.modeCounts) !== canonicalJson({ search: expectedAuditGameCount })
    ) {
        throw new Error(`Overnight turn audit mismatch for ${panelId}/${candidate.label}`);
    }
    const summary = summarizeEvaluation(report, circuit);
    return { report, circuit, summary };
}

function evidenceReference(envelope, paths) {
    return {
        panelId: envelope.panelId,
        profileId: envelope.profile.id,
        label: envelope.profile.label,
        reportPath: relative(OUT, paths.report),
        reportSha256: envelope.reportSha256,
        auditPath: relative(OUT, paths.audit),
        auditSha256: envelope.auditSha256,
        circuit: envelope.circuit,
        summary: envelope.summary,
    };
}

function loadOrCreateEnvelope(candidate, panelId, templates, games, paths, cutoffMs) {
    const validated = validateEvaluation(candidate, panelId, templates, games, paths, cutoffMs);
    const envelope = {
        schemaVersion: 1,
        status: "research_only",
        runId: run.runId,
        panelId,
        profile: candidate,
        reportSha256: sha256(readFileSync(paths.report)),
        auditSha256: sha256(readFileSync(paths.audit)),
        circuit: validated.circuit,
        summary: validated.summary,
    };
    if (existsSync(paths.envelope)) {
        if (canonicalJson(readJson(paths.envelope)) !== canonicalJson(envelope)) {
            throw new Error(`Overnight evaluation envelope drifted: ${paths.envelope}`);
        }
    } else {
        atomicJson(paths.envelope, envelope);
    }
    return { envelope, reference: evidenceReference(envelope, paths) };
}

function runChild(args, environment, timeoutMs) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, env: environment, stdio: "inherit" });
        activeChildren.add(child);
        let timedOut = false;
        let settled = false;
        const settle = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            activeChildren.delete(child);
            if (error) rejectPromise(error);
            else resolvePromise();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
        }, timeoutMs);
        child.once("error", (error) => {
            settle(error);
        });
        child.once("close", (code) => {
            if (timedOut) settle(new Error("evaluation window closed"));
            else if (code === 0) settle();
            else settle(new Error(`search trial exited ${code}`));
        });
    });
}

async function evaluate(candidate, panelId, templates, cutoffMs) {
    const games = seedManifest.panels[panelId].gamesPerTemplate;
    const paths = evaluationPaths(panelId, candidate);
    if (existsSync(paths.report) && existsSync(paths.audit)) {
        return loadOrCreateEnvelope(candidate, panelId, templates, games, paths, cutoffMs).reference;
    }
    const remaining = cutoffMs - Date.now() - 5 * 60_000;
    if (remaining <= 60_000) throw new Error("evaluation window closed");
    mkdirSync(paths.directory, { recursive: true });
    const seeds = Object.fromEntries(
        templates.map((template) => [template, seedManifest.panels[panelId].seeds[template]]),
    );
    const args = [
        TRIAL,
        "--candidate=v0.7",
        "--opponent=v0.6",
        `--templates=${templates.join(",")}`,
        `--games=${games}`,
        `--run-id=${run.runId}`,
        `--panel-id=${panelId}`,
        `--seeds-json=${JSON.stringify(seeds)}`,
        `--concurrency=${CONFIG.workers}`,
        `--output=${paths.report}`,
        `--audit=${paths.audit}`,
        "--audit-turns",
        `--checkpoint-dir=${paths.checkpoints}`,
        `--checkpoint-games=${CONFIG.checkpointGames}`,
    ];
    heartbeat("evaluating", { panelId, profileId: candidate.id, label: candidate.label });
    log(`evaluate panel=${panelId} profile=${candidate.label} games=${games} templates=${templates.join(",")}`);
    await runChild(args, cleanChildEnvironment(candidate), remaining);
    return loadOrCreateEnvelope(candidate, panelId, templates, games, paths, cutoffMs).reference;
}

const compareEvidence = compareV07OvernightEvidence;
const chooseDeep = (evidence) => chooseV07OvernightDeepEvidence(evidence, CONFIG.deepKeep);

function profileById(profiles, id) {
    const candidate = profiles.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`Unknown overnight profile ${id}`);
    return candidate;
}

function rehydrateEvidenceList(references, panelId, templates, cutoffMs, profiles) {
    const games = seedManifest.panels[panelId].gamesPerTemplate;
    const seen = new Set();
    return references.map((reference) => {
        if (reference?.panelId !== panelId || seen.has(reference.profileId)) {
            throw new Error(`Invalid or duplicate ${panelId} state evidence reference`);
        }
        seen.add(reference.profileId);
        const candidate = profileById(profiles, reference.profileId);
        const paths = evaluationPaths(panelId, candidate);
        const rehydrated = loadOrCreateEnvelope(candidate, panelId, templates, games, paths, cutoffMs).reference;
        if (canonicalJson(rehydrated) !== canonicalJson(reference)) {
            throw new Error(`Mutable ${panelId} state evidence drifted for ${candidate.label}`);
        }
        return rehydrated;
    });
}

function rehydrateStateEvidence(profiles, researchCutoffMs) {
    state.scout = rehydrateEvidenceList(state.scout, "scout", FOCUS_TEMPLATES, researchCutoffMs, profiles);
    state.deep = rehydrateEvidenceList(state.deep, "deep", FOCUS_TEMPLATES, researchCutoffMs, profiles);
    const expectedDeepSelection = state.scout.length
        ? chooseDeep(state.scout).map((reference) => reference.profileId)
        : [];
    if (state.phase !== "scout" && canonicalJson(state.deepSelection) !== canonicalJson(expectedDeepSelection)) {
        throw new Error("state.json deep selection does not match rehydrated scout evidence");
    }
    const deepSelection = new Set();
    for (const profileId of state.deepSelection) {
        if (deepSelection.has(profileId) || !state.scout.some((reference) => reference.profileId === profileId)) {
            throw new Error("state.json has an invalid deep selection");
        }
        profileById(profiles, profileId);
        deepSelection.add(profileId);
    }
    if (state.deep.some((reference) => !deepSelection.has(reference.profileId))) {
        throw new Error("state.json contains deep evidence outside its declared selection");
    }
    if (state.selectedProfile) {
        const selectionPool = state.deep.length ? state.deep : state.scout;
        const selectedEvidence = [...selectionPool].sort(compareEvidence)[0];
        const selected = selectedEvidence ? profileById(profiles, selectedEvidence.profileId) : null;
        if (!selected || canonicalJson(selected) !== canonicalJson(state.selectedProfile)) {
            throw new Error("state.json selected profile drifted");
        }
    }
    if (
        state.phase === "complete" &&
        ((state.scout.length > 0 && !state.selectedProfile) || (state.scout.length === 0 && state.selectedProfile))
    ) {
        throw new Error("state.json complete phase has an invalid selected profile");
    }
}

function finalAssessment(reference, report) {
    const targetDiagnostics = report.targetDiagnostics ?? {};
    const strict90AllTemplates = targetDiagnostics.strict90AllTemplates === true;
    const observed90AllArchetypes = targetDiagnostics.observed90AllArchetypes === true;
    const certified90AllArchetypes = targetDiagnostics.certified90AllArchetypes === true;
    const simultaneousArchetypeLowerBounds = targetDiagnostics.simultaneousArchetypeLowerBounds ?? {};
    const matchBudgetQualified =
        (report.searchAudit.matchSearchLatencyMs.p95 ?? Infinity) <= 240_000 &&
        (report.searchAudit.matchSearchLatencyMs.max ?? Infinity) <= 240_000;
    const achieved =
        strict90AllTemplates &&
        observed90AllArchetypes &&
        certified90AllArchetypes &&
        reference.summary.integrityQualified &&
        reference.summary.circuitQualified &&
        matchBudgetQualified;
    return {
        target: CONFIG.target,
        achieved,
        strict90AllTemplates,
        observed90AllArchetypes,
        certified90AllArchetypes,
        simultaneousArchetypeLowerBounds,
        integrityQualified: reference.summary.integrityQualified,
        circuitQualified: reference.summary.circuitQualified,
        matchBudgetQualified,
    };
}

function writeTerminal(finalStatus, selected, finalReference = null, targetGate = null, reason = null) {
    const completedAt = new Date();
    if (finalStatus !== "final_incomplete_deadline" && completedAt.getTime() > Date.parse(run.deadlineAt)) {
        finalStatus = "final_incomplete_deadline";
        reason = "The persisted deadline passed before the research terminal could be emitted.";
        if (targetGate) targetGate = { ...targetGate, achieved: false, terminalBeforeDeadline: false };
    } else if (targetGate) {
        targetGate = { ...targetGate, terminalBeforeDeadline: true };
    }
    const terminalBase = {
        schemaVersion: 1,
        status: "complete_research_only",
        runId: run.runId,
        completedAt: completedAt.toISOString(),
        deadlineAt: run.deadlineAt,
        code: run.code,
        executionHost: run.executionHost,
        config: run.config,
        anchor: run.anchor,
        seedManifest: run.seedManifest,
        finalStatus,
        stages: { scout: state.scout, deep: state.deep },
        selectedProfile: selected,
        final: finalReference,
        targetGate,
        ...(reason ? { reason } : {}),
        gateDecision: {
            bake: false,
            deploy: false,
            productionDefaultChange: false,
            reason: "Research-only overnight evidence; owner review and committed-default acceptance remain required.",
        },
    };
    const terminal = { ...terminalBase, terminalSha256: sha256(canonicalJson(terminalBase)) };
    immutableJson(TERMINAL_PATH, terminal);
    state.phase = "complete";
    state.status = "complete_research_only";
    saveState();
    heartbeat("complete", { finalStatus, terminal: TERMINAL_PATH });
    log(`complete finalStatus=${finalStatus} -> ${TERMINAL_PATH}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
        for (const child of activeChildren) child.kill(signal);
        heartbeat("interrupted", { signal });
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

async function main() {
    const profiles = profilesFor(anchor.genome);
    const deadlineMs = Date.parse(run.deadlineAt);
    const researchCutoffMs = deadlineMs - CONFIG.finalReserveHours * 3_600_000;
    if (researchCutoffMs <= Date.parse(run.createdAt)) {
        throw new Error("V07_OVERNIGHT_FINAL_RESERVE_HOURS must be below the supervised run duration");
    }
    rehydrateStateEvidence(profiles, researchCutoffMs);
    if (existsSync(TERMINAL_PATH)) {
        const terminal = readJson(TERMINAL_PATH);
        const { terminalSha256, ...base } = terminal;
        if (
            terminal.schemaVersion !== 1 ||
            terminal.status !== "complete_research_only" ||
            terminal.runId !== run.runId ||
            !["qualified_research_candidate", "no_qualified_candidate", "final_incomplete_deadline"].includes(
                terminal.finalStatus,
            ) ||
            !Number.isFinite(Date.parse(terminal.completedAt)) ||
            (["qualified_research_candidate", "no_qualified_candidate"].includes(terminal.finalStatus) &&
                Date.parse(terminal.completedAt) > deadlineMs) ||
            canonicalJson(terminal.code) !== canonicalJson(run.code) ||
            canonicalJson(terminal.executionHost) !== canonicalJson(run.executionHost) ||
            canonicalJson(terminal.config) !== canonicalJson(run.config) ||
            canonicalJson(terminal.anchor) !== canonicalJson(run.anchor) ||
            canonicalJson(terminal.seedManifest) !== canonicalJson(run.seedManifest) ||
            canonicalJson(terminal.stages) !== canonicalJson({ scout: state.scout, deep: state.deep }) ||
            canonicalJson(terminal.selectedProfile) !== canonicalJson(state.selectedProfile ?? null) ||
            terminal.gateDecision?.bake !== false ||
            terminal.gateDecision?.deploy !== false ||
            terminal.gateDecision?.productionDefaultChange !== false ||
            terminalSha256 !== sha256(canonicalJson(base))
        ) {
            throw new Error("Existing overnight TERMINAL.json is invalid");
        }
        if (terminal.selectedProfile) {
            const selected = profileById(profiles, terminal.selectedProfile.id);
            if (canonicalJson(selected) !== canonicalJson(terminal.selectedProfile)) {
                throw new Error("Existing overnight terminal selected profile drifted");
            }
        }
        if (terminal.final) {
            const candidate = profileById(profiles, terminal.final.profileId);
            if (!terminal.selectedProfile || candidate.id !== terminal.selectedProfile.id) {
                throw new Error("Existing overnight final evidence is not bound to its selected profile");
            }
            const paths = evaluationPaths("final", candidate);
            const rehydrated = loadOrCreateEnvelope(
                candidate,
                "final",
                ALL_TEMPLATES,
                seedManifest.panels.final.gamesPerTemplate,
                paths,
                deadlineMs,
            ).reference;
            if (canonicalJson(rehydrated) !== canonicalJson(terminal.final)) {
                throw new Error("Existing overnight terminal evidence drifted");
            }
            const assessment = finalAssessment(rehydrated, readJson(paths.report));
            const terminalBeforeDeadline = Date.parse(terminal.completedAt) <= deadlineMs;
            const expectedGate = {
                ...assessment,
                achieved: assessment.achieved && terminalBeforeDeadline,
                terminalBeforeDeadline,
            };
            const expectedStatus = terminalBeforeDeadline
                ? assessment.achieved
                    ? "qualified_research_candidate"
                    : "no_qualified_candidate"
                : "final_incomplete_deadline";
            if (
                terminal.finalStatus !== expectedStatus ||
                canonicalJson(terminal.targetGate) !== canonicalJson(expectedGate)
            ) {
                throw new Error("Existing overnight terminal verdict does not match final evidence");
            }
        } else if (
            terminal.finalStatus !== "final_incomplete_deadline" ||
            terminal.targetGate !== null ||
            (state.scout.length === 0
                ? terminal.selectedProfile !== null || terminal.reason !== "No scout profile completed before reserve."
                : terminal.selectedProfile === null ||
                  terminal.reason !== "The fixed deadline closed before the final eight-template panel completed.")
        ) {
            throw new Error("Existing overnight incomplete terminal has invalid stage semantics");
        }
        heartbeat("complete", { resumed: true, terminal: TERMINAL_PATH });
        return;
    }
    log(
        `start/resume run=${run.runId.slice(0, 12)} phase=${state.phase} profiles=${profiles.length} ` +
            `deadline=${run.deadlineAt} researchCutoff=${new Date(researchCutoffMs).toISOString()}`,
    );

    if (state.phase === "scout") {
        for (const candidate of profiles) {
            if (state.scout.some((entry) => entry.profileId === candidate.id)) continue;
            if (Date.now() >= researchCutoffMs - 5 * 60_000) break;
            try {
                state.scout.push(await evaluate(candidate, "scout", FOCUS_TEMPLATES, researchCutoffMs));
                saveState();
            } catch (error) {
                if (String(error).includes("evaluation window closed")) break;
                throw error;
            }
        }
        if (!state.scout.length) {
            writeTerminal("final_incomplete_deadline", null, null, null, "No scout profile completed before reserve.");
            return;
        }
        state.deepSelection = chooseDeep(state.scout).map((entry) => entry.profileId);
        state.phase = "deep";
        saveState();
    }

    if (state.phase === "deep") {
        for (const profileId of state.deepSelection) {
            if (state.deep.some((entry) => entry.profileId === profileId)) continue;
            if (Date.now() >= researchCutoffMs - 5 * 60_000) break;
            try {
                state.deep.push(
                    await evaluate(profileById(profiles, profileId), "deep", FOCUS_TEMPLATES, researchCutoffMs),
                );
                saveState();
            } catch (error) {
                if (String(error).includes("evaluation window closed")) break;
                throw error;
            }
        }
        state.phase = "final";
        saveState();
    }

    if (state.phase === "final") {
        const selectionPool = state.deep.length ? state.deep : state.scout;
        const selectedEvidence = [...selectionPool].sort(compareEvidence)[0];
        const selected = profileById(profiles, selectedEvidence.profileId);
        state.selectedProfile = selected;
        saveState();
        try {
            const finalReference = await evaluate(selected, "final", ALL_TEMPLATES, deadlineMs);
            const finalReport = readJson(join(OUT, finalReference.reportPath));
            const targetGate = finalAssessment(finalReference, finalReport);
            writeTerminal(
                targetGate.achieved ? "qualified_research_candidate" : "no_qualified_candidate",
                selected,
                finalReference,
                targetGate,
            );
        } catch (error) {
            if (!String(error).includes("evaluation window closed")) throw error;
            writeTerminal(
                "final_incomplete_deadline",
                selected,
                null,
                null,
                "The fixed deadline closed before the final eight-template panel completed.",
            );
        }
    }
}

main().catch((error) => {
    heartbeat("error", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
});
