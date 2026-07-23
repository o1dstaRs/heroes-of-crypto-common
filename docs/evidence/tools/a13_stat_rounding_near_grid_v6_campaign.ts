#!/usr/bin/env bun

/**
 * Sealed, zero-retry campaign driver for the A13 stat-rounding qualification.
 *
 * This process is the only authorized producer of qualifying artifacts. It launches every producer in a
 * minimal environment, records an append-only hash-chained attempt ledger, refuses resume/retry, and invokes
 * the deterministic aggregate only after all thirteen empirical inputs are closed.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    realpathSync,
    statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, hostname, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { auditType7Quantile, TYPE7_QUANTILE_SCHEMA } from "./a13_stat_rounding_near_grid_v5_quantile";
import {
    A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR,
    A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE,
    A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA,
    a13NearGridSourceManifestIdentity,
    assertA13NearGridSourceManifestIdentity,
    sealA13NearGridSourceManifest,
} from "./a13_stat_rounding_near_grid_v6_source_manifest";

const SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-campaign/v3" as const;
const LEDGER_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-attempt-ledger/v4" as const;
const PROTOCOL_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-replication-protocol/v4" as const;
const PAIR_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-pair/v3" as const;
const MICRO_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-micro/v5" as const;
const PROFILE_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-profile/v3" as const;
const REPLICATION_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-replication/v4" as const;
const CAMPAIGN_ID = "a13-stat-rounding-near-grid-77ee4616-20260723-v6";
const RUNNER_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const PROTOCOL_PATH = resolve(
    dirname(RUNNER_PATH),
    "../a13_stat_rounding_near_grid_v6_replication_protocol_2026-07-23.json",
);
const PAIR_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_v6_pair.ts");
const MICRO_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_v6_micro.ts");
const PROFILE_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_v5_profile.ts");
const REPLICATION_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_v6_replication.ts");
const QUANTILE_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_v5_quantile.ts");
const SOURCE_MANIFEST_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_v6_source_manifest.ts");
const INCIDENT_PATH = resolve(
    dirname(RUNNER_PATH),
    "../a13_stat_rounding_near_grid_v5_infrastructure_incident_2026-07-23.json",
);
const GIT_EXECUTABLE = "/usr/bin/git";
const PROTOCOL_STATUS = "prepared-before-zero-retry-thirteen-stage-qualification";
const BASELINE_COMMIT = "188452cad6ec718540b7c452a579ac3cea73a67f";
const CANDIDATE_COMMIT = "77ee4616688f764fcfe49d4a1b15ec19e1ef384e";
const BASELINE_ARCHIVE_SHA256 = "bd8de4690d92d6c0a952ded8fb8f66c3dafec404bb47a4f9b2c597b757cc5e2a";
const CANDIDATE_ARCHIVE_SHA256 = "d39e824171255bd67fdf5f4f2b91d72b8bcea278b889003990c03feff33bb76b";
const BASELINE_SRC_MANIFEST_SHA256 = "076d0689decdfbb071c9632a05103d10bc7181e34500f980bae3c58433398370";
const CANDIDATE_SRC_MANIFEST_SHA256 = "1532611d2da05f628b92f3e51101bfdd0149089deadad25836da7dc51d4d8b9f";
const BASELINE_ROOT = "/private/tmp/hoc-stat-rounding-near-grid-v6-qualification.wfNoyf/baseline";
const CANDIDATE_ROOT = "/private/tmp/hoc-stat-rounding-near-grid-v6-qualification.wfNoyf/candidate";
const COMMON_NODE_MODULES_PATH =
    "/Users/zolotukhin/Workplace/heroes-of-crypto-client/game/heroes-of-crypto-common/node_modules";
const WORKSPACE_LOCK_PATH = "/Users/zolotukhin/Workplace/heroes-of-crypto-client/bun.lock";
const SOURCE_DEPENDENCY_PREFLIGHT_SCHEMA =
    "heroes-of-crypto/a13-stat-rounding-near-grid-source-dependency-preflight/v2";
const V5_INCIDENT_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-v5-infrastructure-incident/v1";
const EXPECTED_DEPENDENCIES = Object.freeze({
    denque: {
        rootRealPath:
            "/Users/zolotukhin/Workplace/heroes-of-crypto-client/node_modules/.bun/denque@2.1.0/node_modules/denque",
        entryPointRealPath:
            "/Users/zolotukhin/Workplace/heroes-of-crypto-client/node_modules/.bun/denque@2.1.0/node_modules/denque/index.js",
        entryCount: 6,
        bytes: 30_361,
        treeManifestSha256: "5e0b1bdea78fe558d60970724651524e978fdc1274dc41c29dbadc0d794bf535",
        packageJson: {
            bytes: 1_758,
            sha256: "b84d3e7e26500d9a9ebbe103b627bda007049fa7f0672ceae96533992cc2fc9c",
        },
    },
    "google-protobuf": {
        rootRealPath:
            "/Users/zolotukhin/Workplace/heroes-of-crypto-client/node_modules/.bun/google-protobuf@4.0.2/node_modules/google-protobuf",
        entryPointRealPath:
            "/Users/zolotukhin/Workplace/heroes-of-crypto-client/node_modules/.bun/google-protobuf@4.0.2/node_modules/google-protobuf/google-protobuf.js",
        entryCount: 17,
        bytes: 927_462,
        treeManifestSha256: "7cab1a735c0deac1b4fa7411e858f848f4ce579c9f1de86b0f7d46cda8b0431d",
        packageJson: {
            bytes: 1_015,
            sha256: "15b51e85ce5451f600ce64b2fab5f6cba5482bd86f345cc69e0039fd26aeaa8d",
        },
    },
});
const SOURCE_DEPENDENCY_PREFLIGHT = Object.freeze({
    schema: SOURCE_DEPENDENCY_PREFLIGHT_SCHEMA,
    executionBoundary:
        "Must pass after the committed frozen prelude and before output-root creation, log creation, attempt-ID allocation, ledger attempt-start, or producer spawn.",
    expectedRoots: {
        baseline: BASELINE_ROOT,
        candidate: CANDIDATE_ROOT,
    },
    sourceArchives: {
        baseline: {
            path: `${BASELINE_ROOT}.tar`,
            sha256: BASELINE_ARCHIVE_SHA256,
            srcTreeManifestSha256: BASELINE_SRC_MANIFEST_SHA256,
        },
        candidate: {
            path: `${CANDIDATE_ROOT}.tar`,
            sha256: CANDIDATE_ARCHIVE_SHA256,
            srcTreeManifestSha256: CANDIDATE_SRC_MANIFEST_SHA256,
        },
    },
    microSourceManifest: {
        helperPath: "docs/evidence/tools/a13_stat_rounding_near_grid_v6_source_manifest.ts",
        audit: {
            mode: "source-preflight-only",
            command: [
                "/Users/zolotukhin/.bun/bin/bun",
                "docs/evidence/tools/a13_stat_rounding_near_grid_v6_micro.ts",
                "--source-preflight-only",
            ],
            executionEnvironment: {
                BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
                LANG: "C.UTF-8",
                LC_ALL: "C",
                TZ: "UTC",
            },
            reportSchema: "heroes-of-crypto/a13-stat-rounding-near-grid-micro-source-preflight/v1",
            stdoutBytes: 8274,
            stdoutSha256: "01bf86f8fa431fc620dbb7a7d82d05faa37b95ab4c2938c353843b50b13fdd4c",
            stderrBytes: 0,
            stderrSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            nonEmpirical: true,
            noAttemptIdOutputArtifactCandidateImportCorrectnessWarmupCalibrationOrTiming: true,
            requiredBeforeOutputRootCreation: true,
        },
        baseline: {
            schema: A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA,
            pathScope: A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE,
            comparator: A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR,
            entryCount: 371,
            bytes: 10_004_717,
            manifestSha256: "076d0689decdfbb071c9632a05103d10bc7181e34500f980bae3c58433398370",
        },
        candidate: {
            schema: A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA,
            pathScope: A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE,
            comparator: A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR,
            entryCount: 372,
            bytes: 10_011_554,
            manifestSha256: "1532611d2da05f628b92f3e51101bfdd0149089deadad25836da7dc51d4d8b9f",
        },
        liveCommonRootMustEqualCandidate: true,
    },
    nodeModules: {
        requiredLiteralLinkTarget: COMMON_NODE_MODULES_PATH,
        requiredRealPath: COMMON_NODE_MODULES_PATH,
    },
    workspaceLock: {
        path: WORKSPACE_LOCK_PATH,
        realPath: WORKSPACE_LOCK_PATH,
        bytes: 438_981,
        sha256: "227ac3cc87c8488dea87841311baf509e361c22610ffc0ee21c553245e58ab54",
    },
    manifestCodec: "heroes-of-crypto/type-tagged-canonical-value/v1",
    runtimeDependencies: EXPECTED_DEPENDENCIES,
    requireEqualBaselineCandidateDependencyIdentity: true,
    requireCreateRequireResolutionWithinPinnedDependencyRoot: true,
});
const NATURAL_SEEDS = Object.freeze(Array.from({ length: 40 }, (_, index) => index + 1));
const NATURAL_GRID_TYPES = Object.freeze([1, 2, 3, 4]);
const CAPTURE_EXECUTION_ORDER = Object.freeze(["r0", "r1", "r3", "r2", "r4", "r5", "r7", "r6", "r8", "r9"]);
const EMPIRICAL_STAGE_ORDER = Object.freeze(["semantic", "micro", "profile", ...CAPTURE_EXECUTION_ORDER]);
const HOST_MONITOR_INTERVAL_MILLISECONDS = 30_000;
const HOST_MONITOR_SCHEDULING_TOLERANCE_MILLISECONDS = 5_000;
const HOST_MONITORING = Object.freeze({
    intervalMilliseconds: HOST_MONITOR_INTERVAL_MILLISECONDS,
    maximumSchedulingDelayMilliseconds: HOST_MONITOR_SCHEDULING_TOLERANCE_MILLISECONDS,
    policy: "Full pinned-host/runtime attestation before and after each producer; lightweight overlap, AC-power, and thermal-pressure checks every 30 seconds while it is alive.",
    invalidation:
        "The active producer receives SIGTERM and its sole attempt is rejected after any failed periodic sample.",
    signalHandling:
        "SIGINT or SIGTERM terminates the active producer process group, escalates to SIGKILL after 10 seconds if needed, and records an adjacent rejected completion.",
});
const REQUIRED_EXECUTION_ENVIRONMENT = Object.freeze({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
});
const FORBIDDEN_INJECTION_ENVIRONMENT_KEYS = Object.freeze([
    "BUN_PRELOAD",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "HOC_BREAK_DEBUG",
    "MALLOC_CONF",
    "GLIBC_TUNABLES",
    "UV_THREADPOOL_SIZE",
    "XDG_CONFIG_HOME",
]);
const FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES = Object.freeze([
    "DYLD_",
    "BUN_JSC_",
    "JSC_",
    "BUN_GC_",
    "Malloc",
    "MALLOC_",
]);
const EXPECTED_HOST_IDENTITY = Object.freeze({
    hostname: "Stepans-Mac-Studio.local",
    platform: "darwin",
    release: "24.6.0",
    arch: "arm64",
    cpuModel: "Apple M4 Max",
    logicalCpus: 16,
    hardwareModel: "Mac16,9",
    physicalCpus: 16,
    bootTime: "{ sec = 1784430937, usec = 167473 }",
    bunVersion: "1.3.14",
    bunRevision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    bunExecutableSha256: "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233",
});
const OVERLAP_MARKERS = Object.freeze([
    "a13_stat_rounding",
    "a13_stat_rounding_near_grid_v6_pair",
    "a13_stat_rounding_near_grid_v6_micro",
    "a13_stat_rounding_near_grid_v5_profile",
    "a13_stat_rounding_near_grid_v6_replication",
    "a13_stat_rounding_near_grid_v6_campaign",
    "run_tournament.ts",
    "run_match.ts",
    "measure_mirror_cohorts",
    "run_v0_8_candidate",
]);

interface IFileSeal {
    path: string;
    realPath: string;
    bytes: number;
    sha256: string;
}

interface IHostAttestation {
    schema: "heroes-of-crypto/a13-stat-rounding-near-grid-host-attestation/v1";
    observedAt: string;
    identity: {
        hostname: string;
        platform: string;
        release: string;
        arch: string;
        cpuModel: string;
        logicalCpus: number;
        hardwareModel: string;
        physicalCpus: number;
        bootTime: string;
        bunVersion: string;
        bunRevision: string;
        bunExecutableSha256: string;
    };
    power: { ac: true; rawSha256: string; raw: string };
    thermal: { nominal: true; rawSha256: string; raw: string };
    overlap: { passed: true; markers: readonly string[]; matchingProcesses: [] };
    passed: true;
}

interface IHostHealthSample {
    schema: "heroes-of-crypto/a13-stat-rounding-near-grid-host-health/v1";
    observedAt: string;
    power: { ac: true; rawSha256: string; raw: string };
    thermal: { nominal: true; rawSha256: string; raw: string };
    overlap: { passed: true; markers: readonly string[]; matchingProcesses: [] };
    passed: true;
}

interface IDirectorySeal {
    path: string;
    realPath: string;
    entryCount: number;
    bytes: number;
    manifestSha256: string;
}

interface ILedgerRecord {
    schema: typeof LEDGER_SCHEMA;
    campaignId: typeof CAMPAIGN_ID;
    sequence: number;
    previousRecordSha256: string | null;
    recordedAt: string | null;
    event: string;
    [key: string]: unknown;
}

interface IStage {
    id: string;
    runnerPath: string;
    runnerSchema: string;
    artifactPath: string;
    args: string[];
}

interface ICompletedStage {
    stage: string;
    completionRecordSha256: string;
    artifact: IFileSeal;
    stdout: IFileSeal;
    stderr: IFileSeal;
    profileSidecars?: IDirectorySeal;
}

interface IStageArtifactValidation {
    timestamp: string;
    profileSidecars?: IDirectorySeal;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function ledgerCanonicalize(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(ledgerCanonicalize);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, child]) => [key, ledgerCanonicalize(child)]),
        );
    }
    throw new Error(`Attempt ledger cannot encode ${typeof value}`);
}

const ledgerJson = (value: unknown): string => JSON.stringify(ledgerCanonicalize(value));

function jsonEqual(left: unknown, right: unknown): boolean {
    return ledgerJson(left) === ledgerJson(right);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
    return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
    const timestamp = requireString(value, label);
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
        throw new Error(`${label} must be a canonical ISO timestamp`);
    }
    return timestamp;
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
    if (!jsonEqual(actual, expected)) {
        throw new Error(`${label} mismatch: expected=${ledgerJson(expected)} actual=${ledgerJson(actual)}`);
    }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
    assertJsonEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function fileSeal(pathInput: string): IFileSeal {
    const path = resolve(pathInput);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Expected a regular non-symlink file: ${path}`);
    const bytes = readFileSync(path);
    return { path, realPath: realpathSync(path), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

interface IPairTreeEntry {
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256: string;
}

function pairTreeSeal(pathInput: string): {
    path: string;
    realPath: string;
    entryCount: number;
    bytes: number;
    manifestSha256: string;
} {
    const path = resolve(pathInput);
    const realPath = realpathSync(path);
    const entries: IPairTreeEntry[] = [];
    const visit = (directory: string): void => {
        for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        )) {
            const child = join(directory, item.name);
            const stats = lstatSync(child);
            if (stats.isDirectory()) {
                visit(child);
            } else if (stats.isFile()) {
                const contents = readFileSync(child);
                entries.push({
                    path: relative(realPath, child).split(sep).join("/"),
                    kind: "file",
                    bytes: contents.byteLength,
                    sha256: sha256(contents),
                });
            } else if (stats.isSymbolicLink()) {
                const target = readlinkSync(child);
                entries.push({
                    path: relative(realPath, child).split(sep).join("/"),
                    kind: "symlink",
                    bytes: Buffer.byteLength(target),
                    sha256: sha256(target),
                });
            } else {
                throw new Error(`Unsupported source/dependency manifest entry: ${child}`);
            }
        }
    };
    visit(realPath);
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    // This is the exact projection of the pair runner's type-tagged canonical codec for this
    // acyclic array of plain four-field entries. Object IDs are assigned in producer traversal order.
    const encoded = [
        "array",
        0,
        entries.map((entry, index) => [
            "object",
            index + 1,
            [
                ["bytes", ["number", entry.bytes]],
                ["kind", ["string", entry.kind]],
                ["path", ["string", entry.path]],
                ["sha256", ["string", entry.sha256]],
            ],
        ]),
        [],
    ];
    return {
        path,
        realPath,
        entryCount: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        manifestSha256: sha256(JSON.stringify(encoded)),
    };
}

function pathWithin(path: string, root: string): boolean {
    const relation = relative(root, path);
    return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function assertSourceAndDependencyPreflight(baselineRoot: string, candidateRoot: string): void {
    if (baselineRoot !== BASELINE_ROOT || candidateRoot !== CANDIDATE_ROOT) {
        throw new Error("Source/dependency preflight roots differ from the preregistered fresh v6 extraction");
    }
    const lock = fileSeal(WORKSPACE_LOCK_PATH);
    assertJsonEqual(lock, SOURCE_DEPENDENCY_PREFLIGHT.workspaceLock, "Preflight workspace lock");
    const microSourceManifest = SOURCE_DEPENDENCY_PREFLIGHT.microSourceManifest;
    assertA13NearGridSourceManifestIdentity(
        a13NearGridSourceManifestIdentity(sealA13NearGridSourceManifest(baselineRoot)),
        microSourceManifest.baseline,
        "Preflight baseline micro source manifest",
    );
    assertA13NearGridSourceManifestIdentity(
        a13NearGridSourceManifestIdentity(sealA13NearGridSourceManifest(candidateRoot)),
        microSourceManifest.candidate,
        "Preflight candidate micro source manifest",
    );
    assertA13NearGridSourceManifestIdentity(
        a13NearGridSourceManifestIdentity(sealA13NearGridSourceManifest(ROOT)),
        microSourceManifest.candidate,
        "Preflight live micro source manifest",
    );
    const dependencyIdentities: Record<string, unknown>[] = [];
    for (const [label, root, archiveSha256, srcManifestSha256] of [
        ["baseline", baselineRoot, BASELINE_ARCHIVE_SHA256, BASELINE_SRC_MANIFEST_SHA256],
        ["candidate", candidateRoot, CANDIDATE_ARCHIVE_SHA256, CANDIDATE_SRC_MANIFEST_SHA256],
    ] as const) {
        const rootStats = lstatSync(root);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || realpathSync(root) !== root) {
            throw new Error(`${label} source root must be a canonical regular directory: ${root}`);
        }
        const archive = fileSeal(`${root}.tar`);
        if (archive.sha256 !== archiveSha256) {
            throw new Error(`${label} source archive mismatch: ${archive.sha256} != ${archiveSha256}`);
        }
        const source = sealA13NearGridSourceManifest(root);
        if (source.manifestSha256 !== srcManifestSha256) {
            throw new Error(`${label} source manifest mismatch: ${source.manifestSha256} != ${srcManifestSha256}`);
        }
        const nodeModulesPath = join(root, "node_modules");
        const nodeModulesStats = lstatSync(nodeModulesPath);
        if (
            !nodeModulesStats.isSymbolicLink() ||
            readlinkSync(nodeModulesPath) !== COMMON_NODE_MODULES_PATH ||
            realpathSync(nodeModulesPath) !== COMMON_NODE_MODULES_PATH
        ) {
            throw new Error(`${label} node_modules must link literally and canonically to ${COMMON_NODE_MODULES_PATH}`);
        }
        const requireFromRoot = createRequire(join(root, "package.json"));
        const dependencies: Record<string, unknown> = {};
        for (const [name, expected] of Object.entries(EXPECTED_DEPENDENCIES)) {
            const dependencyRoot = join(nodeModulesPath, name);
            const tree = pairTreeSeal(dependencyRoot);
            if (
                tree.realPath !== expected.rootRealPath ||
                tree.entryCount !== expected.entryCount ||
                tree.bytes !== expected.bytes ||
                tree.manifestSha256 !== expected.treeManifestSha256
            ) {
                throw new Error(
                    `${label} ${name} dependency root/manifest mismatch: ${ledgerJson({ expected, actual: tree })}`,
                );
            }
            const packageJson = fileSeal(join(dependencyRoot, "package.json"));
            if (
                packageJson.realPath !== join(expected.rootRealPath, "package.json") ||
                packageJson.bytes !== expected.packageJson.bytes ||
                packageJson.sha256 !== expected.packageJson.sha256
            ) {
                throw new Error(`${label} ${name} package manifest mismatch`);
            }
            const resolution = realpathSync(requireFromRoot.resolve(name));
            if (resolution !== expected.entryPointRealPath || !pathWithin(resolution, tree.realPath)) {
                throw new Error(`${label} ${name} resolved outside its pinned dependency root: ${resolution}`);
            }
            dependencies[name] = {
                rootRealPath: tree.realPath,
                entryCount: tree.entryCount,
                bytes: tree.bytes,
                treeManifestSha256: tree.manifestSha256,
                packageJson: {
                    realPath: packageJson.realPath,
                    bytes: packageJson.bytes,
                    sha256: packageJson.sha256,
                },
                entryPointRealPath: resolution,
            };
        }
        dependencyIdentities.push({
            nodeModulesLiteralTarget: readlinkSync(nodeModulesPath),
            nodeModulesRealPath: realpathSync(nodeModulesPath),
            workspaceLock: lock,
            dependencies,
        });
    }
    assertJsonEqual(
        dependencyIdentities[1],
        dependencyIdentities[0],
        "Baseline/candidate dependency preflight identity",
    );
}

function assertMicroSourcePreflight(ledgerPath: string, outputRoot: string): void {
    if (existsSync(outputRoot)) throw new Error("Micro source preflight requires an absent output root");
    const ledgerBefore = readFileSync(ledgerPath);
    const audit = SOURCE_DEPENDENCY_PREFLIGHT.microSourceManifest.audit;
    const result = Bun.spawnSync([process.execPath, MICRO_PATH, "--source-preflight-only"], {
        cwd: ROOT,
        env: minimalEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = Buffer.from(result.stdout);
    const stderr = Buffer.from(result.stderr);
    if (result.exitCode !== 0 || result.signalCode !== undefined || stderr.byteLength !== audit.stderrBytes) {
        throw new Error(
            `Micro source preflight failed: exit=${result.exitCode} signal=${result.signalCode} ` +
                `stderr=${stderr.toString("utf8")}`,
        );
    }
    if (sha256(stderr) !== audit.stderrSha256) throw new Error("Micro source preflight stderr seal mismatch");
    if (stdout.byteLength !== audit.stdoutBytes || sha256(stdout) !== audit.stdoutSha256) {
        throw new Error(
            `Micro source preflight stdout seal mismatch: bytes=${stdout.byteLength} sha256=${sha256(stdout)}`,
        );
    }
    const report = requireRecord(JSON.parse(stdout.toString("utf8")), "micro source preflight report");
    if (
        report.schema !== audit.reportSchema ||
        report.passed !== true ||
        report.nonEmpirical !== true ||
        report.noAttemptId !== true ||
        report.noOutputPathOrArtifactWrite !== true ||
        report.noCandidateImportCorrectnessWarmupCalibrationOrTiming !== true
    ) {
        throw new Error("Micro source preflight report is not the frozen non-empirical audit");
    }
    const sourceSeal = requireRecord(report.sourceSeal, "micro source preflight source seal");
    assertA13NearGridSourceManifestIdentity(
        {
            schema: sourceSeal.manifestSchema as typeof A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA,
            pathScope: sourceSeal.manifestPathScope as typeof A13_NEAR_GRID_SOURCE_MANIFEST_PATH_SCOPE,
            comparator: sourceSeal.manifestComparator as typeof A13_NEAR_GRID_SOURCE_MANIFEST_COMPARATOR,
            entryCount: sourceSeal.entries as number,
            bytes: sourceSeal.bytes as number,
            manifestSha256: sourceSeal.manifestSha256 as string,
        },
        SOURCE_DEPENDENCY_PREFLIGHT.microSourceManifest.candidate,
        "Micro source preflight report identity",
    );
    assertJsonEqual(
        report.runner,
        { ...fileSeal(MICRO_PATH), path: relative(ROOT, MICRO_PATH).split(sep).join("/") },
        "Micro source preflight runner seal",
    );
    assertJsonEqual(
        report.sourceManifestHelper,
        {
            ...fileSeal(SOURCE_MANIFEST_PATH),
            path: relative(ROOT, SOURCE_MANIFEST_PATH).split(sep).join("/"),
        },
        "Micro source preflight helper seal",
    );
    assertA13NearGridSourceManifestIdentity(
        a13NearGridSourceManifestIdentity(sealA13NearGridSourceManifest(ROOT)),
        SOURCE_DEPENDENCY_PREFLIGHT.microSourceManifest.candidate,
        "Post-subprocess live micro source manifest",
    );
    if (!ledgerBefore.equals(readFileSync(ledgerPath))) throw new Error("Micro source preflight mutated the ledger");
    if (existsSync(outputRoot)) throw new Error("Micro source preflight created the output root");
}

function expectedV5IncidentBinding(): Record<string, unknown> {
    const incident = requireRecord(JSON.parse(readFileSync(INCIDENT_PATH, "utf8")), "v5 incident");
    if (incident.schema !== V5_INCIDENT_SCHEMA) throw new Error("V5 infrastructure incident schema mismatch");
    const seal = fileSeal(INCIDENT_PATH);
    return {
        schema: V5_INCIDENT_SCHEMA,
        incident: {
            path: "docs/evidence/a13_stat_rounding_near_grid_v5_infrastructure_incident_2026-07-23.json",
            sha256: seal.sha256,
        },
        outcome: "infrastructure-invalid-after-accepted-semantic-before-micro-measurement",
        semanticEvidenceAcceptedAsLimitedCorrectness: true,
        semanticTimingAcceptedForQualification: false,
        performanceVerdictExists: false,
        v4OrV5EvidenceAcceptedAsV6QualificationInputOrPooled: false,
        v6Policy: "All semantic, micro, profile, and macro timing evidence must be freshly produced by v6.",
    };
}

function directorySeal(pathInput: string): IDirectorySeal {
    const path = resolve(pathInput);
    const rootStats = lstatSync(path);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw new Error(`Expected a regular non-symlink directory: ${path}`);
    }
    const realPath = realpathSync(path);
    const entries: Array<{ path: string; kind: "file"; bytes: number; sha256: string }> = [];
    const visit = (directory: string): void => {
        for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        )) {
            const child = join(directory, item.name);
            const stats = lstatSync(child);
            if (stats.isDirectory()) {
                visit(child);
            } else if (stats.isFile()) {
                const contents = readFileSync(child);
                entries.push({
                    path: relative(realPath, child).split(sep).join("/"),
                    kind: "file",
                    bytes: contents.byteLength,
                    sha256: sha256(contents),
                });
            } else {
                throw new Error(`Profile sidecar entries must be regular non-symlink files/directories: ${child}`);
            }
        }
    };
    visit(realPath);
    return {
        path,
        realPath,
        entryCount: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        manifestSha256: sha256(JSON.stringify(entries)),
    };
}

function runText(executable: string, args: readonly string[]): string {
    const result = Bun.spawnSync([executable, ...args], {
        cwd: ROOT,
        env: minimalEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(
            `${basename(executable)} ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString("utf8")}`,
        );
    }
    return Buffer.from(result.stdout).toString("utf8").trim();
}

function gitBytes(args: readonly string[]): Buffer {
    const result = Bun.spawnSync([GIT_EXECUTABLE, ...args], {
        cwd: ROOT,
        env: minimalEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString("utf8")}`);
    }
    return Buffer.from(result.stdout);
}

function minimalEnvironment(home?: string, temporary?: string): Record<string, string> {
    return {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home ?? "/private/tmp",
        TMPDIR: temporary ?? "/private/tmp",
        ...REQUIRED_EXECUTION_ENVIRONMENT,
    };
}

function auditRuntimeInjection(): void {
    const presentEnvironmentKeys = Object.keys(process.env)
        .sort()
        .filter(
            (key) =>
                FORBIDDEN_INJECTION_ENVIRONMENT_KEYS.includes(
                    key as (typeof FORBIDDEN_INJECTION_ENVIRONMENT_KEYS)[number],
                ) || FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)),
        );
    const governedEnvironment = Object.fromEntries(
        Object.keys(REQUIRED_EXECUTION_ENVIRONMENT)
            .sort()
            .map((key) => [key, process.env[key] ?? null]),
    );
    if (
        presentEnvironmentKeys.length > 0 ||
        process.execArgv.length > 0 ||
        !jsonEqual(governedEnvironment, REQUIRED_EXECUTION_ENVIRONMENT)
    ) {
        throw new Error(
            `Campaign runtime injection audit failed: environment=${presentEnvironmentKeys.join(",")} ` +
                `execArgv=${process.execArgv.join(",")} governed=${ledgerJson(governedEnvironment)}`,
        );
    }
}

function auditConfigurationAbsence(home: string): Record<string, unknown> {
    const rootDynamic = readdirSync(ROOT)
        .filter((name) => name.startsWith(".env"))
        .map((name) => join(ROOT, name));
    const candidates = [
        ...[".env", ".env.local", ".env.development", ".env.production", ".env.test"].map((name) => join(ROOT, name)),
        ...rootDynamic,
        join(ROOT, ".bunfig.toml"),
        join(ROOT, "bunfig.local.toml"),
        join(home, ".bunfig.toml"),
        join(home, ".config/bunfig.toml"),
        join(home, ".config/bun/bunfig.toml"),
    ];
    const uniqueCandidates = [...new Set(candidates)].sort();
    const present = uniqueCandidates.filter((path) => existsSync(path));
    if (present.length > 0) throw new Error(`Forbidden runtime configuration is present: ${present.join(",")}`);
    return {
        passed: true,
        checked: uniqueCandidates,
        present: [],
        rootEnvironmentGlob: ".env*",
        bunConfigurationCandidatesAbsent: true,
    };
}

function parseLedger(path: string): { records: ILedgerRecord[]; lines: string[] } {
    const raw = readFileSync(path, "utf8");
    if (!raw.endsWith("\n")) throw new Error("Attempt ledger must end with a newline");
    const lines = raw.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) throw new Error("Attempt ledger contains a blank line");
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    const records = lines.map((line, index) => {
        const parsed = JSON.parse(line) as ILedgerRecord;
        if (ledgerJson(parsed) !== line) throw new Error(`Ledger record ${index} is not canonical compact JSON`);
        if (
            parsed.schema !== LEDGER_SCHEMA ||
            parsed.campaignId !== CAMPAIGN_ID ||
            parsed.sequence !== index ||
            parsed.previousRecordSha256 !== (index === 0 ? null : sha256(lines[index - 1]))
        ) {
            throw new Error(`Ledger hash-chain or identity mismatch at sequence ${index}`);
        }
        if (index === 0) {
            if (parsed.recordedAt !== null) throw new Error("Ledger genesis timestamp must be null");
        } else {
            const timestamp = Date.parse(requireIsoTimestamp(parsed.recordedAt, `Ledger record ${index} timestamp`));
            if (timestamp <= previousTimestamp) {
                throw new Error(`Ledger timestamps must increase strictly at sequence ${index}`);
            }
            previousTimestamp = timestamp;
        }
        return parsed;
    });
    return { records, lines };
}

function appendLedger(
    path: string,
    payload: Record<string, unknown> & { event: string; recordedAt?: string | null },
): { record: ILedgerRecord; line: string; sha256: string } {
    const ledger = parseLedger(path);
    let recordedAt = payload.recordedAt;
    if (recordedAt === undefined) {
        const previous = ledger.records.at(-1)?.recordedAt;
        const previousMilliseconds =
            previous === null || previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous);
        const nextMilliseconds = Math.max(Date.now(), previousMilliseconds + 1);
        recordedAt = new Date(nextMilliseconds).toISOString();
    }
    const record: ILedgerRecord = {
        schema: LEDGER_SCHEMA,
        campaignId: CAMPAIGN_ID,
        sequence: ledger.records.length,
        previousRecordSha256: sha256(ledger.lines.at(-1)!),
        ...payload,
        recordedAt,
    };
    const line = ledgerJson(record);
    appendFileSync(path, `${line}\n`, { encoding: "utf8" });
    const descriptor = openSync(path, "r");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
    const verified = parseLedger(path);
    if (verified.records.length !== ledger.records.length + 1 || verified.lines[verified.lines.length - 1] !== line) {
        throw new Error(`Attempt ledger append was not exclusive at sequence ${record.sequence}`);
    }
    return { record, line, sha256: sha256(line) };
}

function processTable(): Array<{ pid: number; ppid: number; command: string }> {
    return runText("/bin/ps", ["-axo", "pid=,ppid=,command="])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (!match) throw new Error(`Cannot parse process row: ${line}`);
            return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
        });
}

function ancestorPids(rows: readonly { pid: number; ppid: number }[]): Set<number> {
    const byPid = new Map(rows.map((row) => [row.pid, row.ppid]));
    const output = new Set<number>([process.pid]);
    let current = process.pid;
    while (byPid.has(current)) {
        current = byPid.get(current)!;
        if (current <= 1 || output.has(current)) break;
        output.add(current);
    }
    return output;
}

function descendantPids(rows: readonly { pid: number; ppid: number }[], roots: readonly number[]): Set<number> {
    const output = new Set(roots);
    let changed = true;
    while (changed) {
        changed = false;
        for (const row of rows) {
            if (output.has(row.ppid) && !output.has(row.pid)) {
                output.add(row.pid);
                changed = true;
            }
        }
    }
    return output;
}

function hostHealthSample(allowedDescendantRoots: readonly number[] = []): IHostHealthSample {
    const rows = processTable();
    const excluded = ancestorPids(rows);
    for (const pid of descendantPids(rows, allowedDescendantRoots)) excluded.add(pid);
    const matchingProcesses = rows.filter(
        (row) => !excluded.has(row.pid) && OVERLAP_MARKERS.some((marker) => row.command.includes(marker)),
    );
    if (matchingProcesses.length > 0) {
        throw new Error(`Overlapping benchmark process: ${JSON.stringify(matchingProcesses)}`);
    }
    const powerRaw = runText("/usr/bin/pmset", ["-g", "batt"]);
    if (!powerRaw.includes("Now drawing from 'AC Power'")) throw new Error(`Host is not on AC power: ${powerRaw}`);
    const thermalRaw = runText("/usr/bin/pmset", ["-g", "therm"]);
    const thermalNominal =
        thermalRaw.includes("No thermal warning level has been recorded") &&
        thermalRaw.includes("No performance warning level has been recorded") &&
        thermalRaw.includes("No CPU power status has been recorded");
    if (!thermalNominal) throw new Error(`Host has thermal or performance pressure: ${thermalRaw}`);
    return {
        schema: "heroes-of-crypto/a13-stat-rounding-near-grid-host-health/v1",
        observedAt: new Date().toISOString(),
        power: { ac: true, rawSha256: sha256(powerRaw), raw: powerRaw },
        thermal: { nominal: true, rawSha256: sha256(thermalRaw), raw: thermalRaw },
        overlap: { passed: true, markers: OVERLAP_MARKERS, matchingProcesses: [] },
        passed: true,
    };
}

function hostAttestation(allowedDescendantRoots: readonly number[] = []): IHostAttestation {
    const health = hostHealthSample(allowedDescendantRoots);
    const bootTimeRaw = runText("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
    const bootTimeMatch = /^\{ sec = (\d+), usec = (\d+) \}/.exec(bootTimeRaw);
    if (!bootTimeMatch) throw new Error(`Cannot normalize kern.boottime: ${bootTimeRaw}`);
    const cpuModel = cpus()[0]?.model ?? "unknown";
    const identity = {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel,
        logicalCpus: cpus().length,
        hardwareModel: runText("/usr/sbin/sysctl", ["-n", "hw.model"]),
        physicalCpus: Number(runText("/usr/sbin/sysctl", ["-n", "hw.physicalcpu"])),
        bootTime: `{ sec = ${bootTimeMatch[1]}, usec = ${bootTimeMatch[2]} }`,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        bunExecutableSha256: fileSeal(process.execPath).sha256,
    };
    if (!jsonEqual(identity, EXPECTED_HOST_IDENTITY)) {
        throw new Error(`Unexpected qualification host: ${JSON.stringify(identity)}`);
    }
    return {
        schema: "heroes-of-crypto/a13-stat-rounding-near-grid-host-attestation/v1",
        observedAt: health.observedAt,
        identity,
        power: health.power,
        thermal: health.thermal,
        overlap: health.overlap,
        passed: true,
    };
}

function stableHostIdentity(before: IHostAttestation, after: IHostAttestation): boolean {
    return JSON.stringify(before.identity) === JSON.stringify(after.identity) && before.passed && after.passed;
}

function validateStageArtifact(stage: IStage, attemptId: string, artifact: IFileSeal): IStageArtifactValidation {
    const report = requireRecord(JSON.parse(readFileSync(artifact.path, "utf8")), `${stage.id} report`);
    if (report.schema !== stage.runnerSchema || report.attemptId !== attemptId) {
        throw new Error(`${stage.id} report schema/attempt binding failed`);
    }
    const timestampKey = stage.id === "semantic" || stage.id.startsWith("r") ? "generatedAt" : "createdAt";
    const timestamp = requireIsoTimestamp(report[timestampKey], `${stage.id} report ${timestampKey}`);
    if (stage.id === "semantic" || stage.id.startsWith("r")) {
        const command = requireRecord(report.command, `${stage.id} command`);
        const exactness = requireRecord(report.exactness, `${stage.id} exactness`);
        const protocol = requireRecord(report.protocol, `${stage.id} protocol binding`);
        const schedule =
            stage.id === "semantic"
                ? {
                      seeds: [...NATURAL_SEEDS],
                      gridTypes: [...NATURAL_GRID_TYPES],
                      invertOrder: false,
                      maxLaps: 8,
                  }
                : { ...captureSchedules()[stage.id], maxLaps: 2 };
        assertJsonEqual(
            command,
            {
                captureId: stage.id,
                smoke: false,
                invertOrder: schedule.invertOrder,
                seeds: schedule.seeds,
                gridTypes: schedule.gridTypes,
                maxLaps: schedule.maxLaps,
                warmupSeed: 4_294_967_295,
            },
            `${stage.id} exact command`,
        );
        if (
            protocol.scheduleExact !== true ||
            protocol.unchanged !== true ||
            exactness.passed !== true ||
            exactness.taskCount !== 160 ||
            exactness.semanticMismatchCount !== 0 ||
            exactness.rejectedActions !== 0 ||
            exactness.stuckMatches !== 0 ||
            exactness.exceptions !== 0
        ) {
            throw new Error(`${stage.id} report is not an exact non-smoke protocol-bound artifact`);
        }
        if (!Array.isArray(report.rows) || report.rows.length !== 160) {
            throw new Error(`${stage.id} report must retain exactly 160 task rows`);
        }
        return { timestamp };
    }
    const gates = requireRecord(report.gates, `${stage.id} gates`);
    if (
        report.mode !== "evidence" ||
        gates.qualified !== true ||
        gates.smokeNeverQualifies !== false ||
        (stage.id === "micro" ? gates.measurementPassed !== true : gates.measurementGatesPassed !== true)
    ) {
        throw new Error(`${stage.id} report did not pass its preregistered evidence gates`);
    }
    if (stage.id !== "profile") return { timestamp };
    const sidecarPath = `${artifact.path}.profiles`;
    const expectedSidecars = [
        "baseline-telemetry.workload.json",
        "candidate-telemetry.workload.json",
        ...["baseline", "candidate"].flatMap((variant) =>
            Array.from({ length: 4 }, (_, index) => [
                `${variant}-capture-${index + 1}.cpuprofile`,
                `${variant}-capture-${index + 1}.workload.json`,
            ]).flat(),
        ),
    ].sort();
    const actualSidecars = readdirSync(sidecarPath).sort();
    assertJsonEqual(actualSidecars, expectedSidecars, "Profile sidecar file set");
    for (const name of actualSidecars) {
        const stats = lstatSync(join(sidecarPath, name));
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new Error(`Profile sidecar must be a regular non-symlink file: ${name}`);
        }
    }
    const sidecars = directorySeal(sidecarPath);
    if (sidecars.entryCount !== 18) {
        throw new Error(`Profile evidence must retain exactly 18 regular sidecar files, got ${sidecars.entryCount}`);
    }
    return { timestamp, profileSidecars: sidecars };
}

async function executeStage(
    stage: IStage,
    ledgerPath: string,
    cleanHome: string,
    temporary: string,
    usedAttemptIds: Set<string>,
): Promise<ICompletedStage> {
    if (existsSync(stage.artifactPath)) throw new Error(`Refusing to overwrite ${stage.artifactPath}`);
    const stdoutPath = `${stage.artifactPath}.stdout.log`;
    const stderrPath = `${stage.artifactPath}.stderr.log`;
    if (existsSync(stdoutPath) || existsSync(stderrPath)) throw new Error(`Stage log already exists for ${stage.id}`);
    const runner = fileSeal(stage.runnerPath);
    let stdoutDescriptor: number;
    let stderrDescriptor: number;
    stdoutDescriptor = openSync(stdoutPath, "wx");
    try {
        stderrDescriptor = openSync(stderrPath, "wx");
    } catch (error) {
        closeSync(stdoutDescriptor);
        throw error;
    }
    let configurationBefore: Record<string, unknown>;
    let before: IHostAttestation;
    try {
        configurationBefore = auditConfigurationAbsence(cleanHome);
        before = hostAttestation();
    } catch (error) {
        closeSync(stdoutDescriptor);
        closeSync(stderrDescriptor);
        throw error;
    }
    const attemptId = randomUUID();
    if (usedAttemptIds.has(attemptId)) {
        closeSync(stdoutDescriptor);
        closeSync(stderrDescriptor);
        throw new Error(`Duplicate random attempt ID: ${attemptId}`);
    }
    usedAttemptIds.add(attemptId);
    const args = [...stage.args, `--attempt-id=${attemptId}`];
    let started: ReturnType<typeof appendLedger>;
    try {
        started = appendLedger(ledgerPath, {
            event: "attempt-started",
            stage: stage.id,
            attempt: 1,
            attemptId,
            runner: { ...runner, schema: stage.runnerSchema },
            argv: [process.execPath, stage.runnerPath, ...args],
            artifactPath: stage.artifactPath,
            configurationAbsence: configurationBefore,
            hostAttestation: before,
        });
    } catch (error) {
        closeSync(stdoutDescriptor);
        closeSync(stderrDescriptor);
        throw error;
    }
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let executionError: string | null = null;
    const monitorSamples: IHostHealthSample[] = [];
    let monitorError: string | null = null;
    let interruptedSignal: "SIGINT" | "SIGTERM" | null = null;
    let producerClosedAt: string | null = null;
    const recordProducerClose = () => {
        const startMilliseconds = Date.parse(
            requireIsoTimestamp(started.record.recordedAt, `${stage.id} start timestamp`),
        );
        const lastSampleMilliseconds =
            monitorSamples.length === 0
                ? Number.NEGATIVE_INFINITY
                : Date.parse(monitorSamples[monitorSamples.length - 1].observedAt);
        producerClosedAt = new Date(
            Math.max(Date.now() + 1, startMilliseconds + 1, lastSampleMilliseconds + 1),
        ).toISOString();
    };
    try {
        const child = spawn(process.execPath, [stage.runnerPath, ...args], {
            cwd: ROOT,
            env: minimalEnvironment(cleanHome, temporary),
            detached: true,
            stdio: ["ignore", stdoutDescriptor, stderrDescriptor],
        });
        let escalation: ReturnType<typeof setTimeout> | null = null;
        const terminateGroup = () => {
            const childPid = child.pid;
            if (childPid === undefined) return;
            try {
                process.kill(-childPid, "SIGTERM");
            } catch {
                child.kill("SIGTERM");
            }
            escalation ??= setTimeout(() => {
                try {
                    process.kill(-childPid, "SIGKILL");
                } catch {
                    child.kill("SIGKILL");
                }
            }, 10_000);
        };
        const stopForSignal = (received: "SIGINT" | "SIGTERM") => {
            interruptedSignal ??= received;
            terminateGroup();
        };
        const onSigint = () => stopForSignal("SIGINT");
        const onSigterm = () => stopForSignal("SIGTERM");
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
        const monitor = setInterval(() => {
            if (monitorError !== null) return;
            try {
                if (child.pid === undefined) throw new Error("Active producer has no process ID");
                monitorSamples.push(hostHealthSample([child.pid]));
            } catch (error) {
                monitorError = error instanceof Error ? (error.stack ?? error.message) : String(error);
                terminateGroup();
            }
        }, HOST_MONITOR_INTERVAL_MILLISECONDS);
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: string | null }>(
            (resolvePromise) => {
                let settled = false;
                const finish = (value: {
                    code: number | null;
                    signal: NodeJS.Signals | null;
                    error: string | null;
                }) => {
                    if (settled) return;
                    settled = true;
                    resolvePromise(value);
                };
                child.once("error", (error) => finish({ code: null, signal: null, error: String(error) }));
                child.once("close", (code, childSignal) => finish({ code, signal: childSignal, error: null }));
            },
        );
        clearInterval(monitor);
        let cleanupError: string | null = null;
        if (escalation && child.pid !== undefined) {
            const childPid = child.pid;
            const deadline = Date.now() + 12_000;
            const groupExists = () => {
                try {
                    process.kill(-childPid, 0);
                    return true;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
                    throw error;
                }
            };
            while (groupExists() && Date.now() < deadline) {
                await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
            }
            if (groupExists()) cleanupError = `Producer process group ${childPid} survived SIGKILL escalation`;
            clearTimeout(escalation);
        }
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
        exitCode = outcome.code;
        signal = outcome.signal;
        executionError = outcome.error ?? cleanupError;
        recordProducerClose();
    } catch (error) {
        executionError = error instanceof Error ? (error.stack ?? error.message) : String(error);
        recordProducerClose();
    } finally {
        closeSync(stdoutDescriptor);
        closeSync(stderrDescriptor);
    }
    let after: IHostAttestation | null = null;
    let hostError: string | null = null;
    let configurationAfter: Record<string, unknown> | null = null;
    let configurationError: string | null = null;
    try {
        configurationAfter = auditConfigurationAbsence(cleanHome);
    } catch (error) {
        configurationError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    try {
        after = hostAttestation();
    } catch (error) {
        hostError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    const monitorPassed =
        monitorSamples.every((sample) => sample.passed) && monitorError === null && interruptedSignal === null;
    const unchanged = after !== null && stableHostIdentity(before, after) && monitorPassed;
    let artifact: IFileSeal | null = null;
    let artifactTimestamp: string | null = null;
    let profileSidecars: IDirectorySeal | undefined;
    let validationError: string | null = null;
    try {
        if (existsSync(stage.artifactPath)) artifact = fileSeal(stage.artifactPath);
        if (stage.id === "profile" && existsSync(`${stage.artifactPath}.profiles`)) {
            profileSidecars = directorySeal(`${stage.artifactPath}.profiles`);
        }
        if (
            exitCode !== 0 ||
            signal !== null ||
            executionError !== null ||
            monitorError !== null ||
            interruptedSignal !== null
        ) {
            throw new Error(
                `producer process failed: code=${exitCode} signal=${signal} error=${executionError} ` +
                    `monitor=${monitorError} interrupted=${interruptedSignal}`,
            );
        }
        if (!artifact) throw new Error("producer did not create its declared regular artifact");
        const artifactValidation = validateStageArtifact(stage, attemptId, artifact);
        artifactTimestamp = artifactValidation.timestamp;
        profileSidecars = artifactValidation.profileSidecars;
        if (!unchanged) throw new Error(`host attestation failed: ${hostError ?? "identity changed"}`);
        if (!configurationAfter || !jsonEqual(configurationBefore, configurationAfter)) {
            throw new Error(`runtime configuration changed: ${configurationError ?? "seal drift"}`);
        }
        const startHostTime = Date.parse(before.observedAt);
        const startRecordTime = Date.parse(requireIsoTimestamp(started.record.recordedAt, `${stage.id} start time`));
        const reportTime = Date.parse(artifactTimestamp);
        const producerCloseTime = Date.parse(
            requireIsoTimestamp(producerClosedAt, `${stage.id} producer close timestamp`),
        );
        const afterHostTime = Date.parse(after!.observedAt);
        const monitorTimes = monitorSamples.map((sample) => Date.parse(sample.observedAt));
        const monitorTimesOrdered = monitorTimes.every(
            (time, index) =>
                startRecordTime < time && time < producerCloseTime && (index === 0 || monitorTimes[index - 1] < time),
        );
        const cadencePoints = [startRecordTime, ...monitorTimes, producerCloseTime];
        const monitorCadencePassed = cadencePoints.slice(1).every((time, index) => {
            const gap = time - cadencePoints[index];
            return (
                gap > 0 && gap <= HOST_MONITOR_INTERVAL_MILLISECONDS + HOST_MONITOR_SCHEDULING_TOLERANCE_MILLISECONDS
            );
        });
        if (!(
            startHostTime <= startRecordTime &&
            startRecordTime <= reportTime &&
            reportTime <= producerCloseTime &&
            producerCloseTime <= afterHostTime &&
            monitorTimesOrdered &&
            monitorCadencePassed
        )) {
            throw new Error(
                `${stage.id} temporal binding failed: ${[
                    startHostTime,
                    startRecordTime,
                    ...monitorTimes,
                    reportTime,
                    producerCloseTime,
                    afterHostTime,
                ].join(" <= ")}`,
            );
        }
    } catch (error) {
        validationError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    let stdout: IFileSeal | null = null;
    let stderr: IFileSeal | null = null;
    try {
        stdout = fileSeal(stdoutPath);
        stderr = fileSeal(stderrPath);
    } catch (error) {
        validationError ??= error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    const accepted = validationError === null && artifact !== null && stdout !== null && stderr !== null && unchanged;
    const completionMinimumTime = Math.max(
        Date.now(),
        Date.parse(requireIsoTimestamp(started.record.recordedAt, `${stage.id} start timestamp`)) + 1,
        after ? Date.parse(after.observedAt) + 1 : Number.NEGATIVE_INFINITY,
    );
    const completion = appendLedger(ledgerPath, {
        event: "attempt-completed",
        stage: stage.id,
        attempt: 1,
        attemptId,
        startRecordSha256: started.sha256,
        exitCode,
        signal,
        artifact,
        stdout,
        stderr,
        configurationAbsence: {
            before: configurationBefore,
            after: configurationAfter,
            unchanged: configurationAfter !== null && jsonEqual(configurationBefore, configurationAfter),
            error: configurationError,
        },
        hostAttestation: {
            before,
            monitor: {
                intervalMilliseconds: HOST_MONITOR_INTERVAL_MILLISECONDS,
                maximumSchedulingDelayMilliseconds: HOST_MONITOR_SCHEDULING_TOLERANCE_MILLISECONDS,
                producerClosedAt,
                samples: monitorSamples,
                error: monitorError,
                passed: monitorPassed,
            },
            after,
            unchanged,
        },
        validation: {
            passed: accepted,
            executionError,
            hostError,
            monitorError,
            interruptedSignal,
            artifactError: validationError,
            artifactTimestamp,
            profileSidecars: profileSidecars ?? null,
        },
        profileSidecars: profileSidecars ?? null,
        accepted,
        recordedAt: new Date(completionMinimumTime).toISOString(),
    });
    if (!accepted || !artifact || !stdout || !stderr) {
        throw new Error(
            `Zero-retry campaign stopped at ${stage.id}: code=${exitCode} signal=${signal} ` +
                `host=${unchanged} validation=${validationError}`,
        );
    }
    return {
        stage: stage.id,
        completionRecordSha256: completion.sha256,
        artifact,
        stdout,
        stderr,
        profileSidecars,
    };
}

function rotate<T>(values: readonly T[], offset: number): T[] {
    return [...values.slice(offset), ...values.slice(0, offset)];
}

function captureSchedules(): Record<string, { seeds: number[]; gridTypes: number[]; invertOrder: boolean }> {
    const seedOffsets = [0, 7, 14, 21, 28];
    const gridOffsets = [0, 1, 2, 3, 0];
    return Object.fromEntries(
        seedOffsets.flatMap((offset, pairIndex) => {
            const seeds = rotate(NATURAL_SEEDS, offset);
            const gridTypes = rotate(NATURAL_GRID_TYPES, gridOffsets[pairIndex]);
            return [
                [`r${pairIndex * 2}`, { seeds, gridTypes, invertOrder: false }],
                [
                    `r${pairIndex * 2 + 1}`,
                    { seeds: [...seeds].reverse(), gridTypes: [...gridTypes].reverse(), invertOrder: true },
                ],
            ];
        }),
    );
}

function stagePlan(baselineRoot: string, candidateRoot: string, outputRoot: string): IStage[] {
    const rootArguments = [`--baseline-root=${baselineRoot}`, `--candidate-root=${candidateRoot}`];
    const semanticPath = join(outputRoot, "semantic.json");
    const microPath = join(outputRoot, "micro.json");
    const profilePath = join(outputRoot, "profile.json");
    const stages: IStage[] = [
        {
            id: "semantic",
            runnerPath: PAIR_PATH,
            runnerSchema: PAIR_SCHEMA,
            artifactPath: semanticPath,
            args: [
                ...rootArguments,
                "--capture-id=semantic",
                `--out=${semanticPath}`,
                `--seeds=${NATURAL_SEEDS.join(",")}`,
                `--grid-types=${NATURAL_GRID_TYPES.join(",")}`,
                "--max-laps=8",
                "--warmup-seed=4294967295",
            ],
        },
        {
            id: "micro",
            runnerPath: MICRO_PATH,
            runnerSchema: MICRO_SCHEMA,
            artifactPath: microPath,
            args: [`--out=${microPath}`],
        },
        {
            id: "profile",
            runnerPath: PROFILE_PATH,
            runnerSchema: PROFILE_SCHEMA,
            artifactPath: profilePath,
            args: [...rootArguments, `--out=${profilePath}`],
        },
    ];
    const schedules = captureSchedules();
    for (const id of CAPTURE_EXECUTION_ORDER) {
        const schedule = schedules[id];
        const artifactPath = join(outputRoot, `${id}.json`);
        stages.push({
            id,
            runnerPath: PAIR_PATH,
            runnerSchema: PAIR_SCHEMA,
            artifactPath,
            args: [
                ...rootArguments,
                `--capture-id=${id}`,
                `--out=${artifactPath}`,
                `--seeds=${schedule.seeds.join(",")}`,
                `--grid-types=${schedule.gridTypes.join(",")}`,
                "--max-laps=2",
                "--warmup-seed=4294967295",
                ...(schedule.invertOrder ? ["--invert-order"] : []),
            ],
        });
    }
    return stages;
}

function assertFrozenPrelude(
    ledgerPath: string,
    baselineRoot: string,
    candidateRoot: string,
    outputRoot: string,
    stages: readonly IStage[],
): void {
    const { records, lines } = parseLedger(ledgerPath);
    if (records.length !== 2 || records[0].event !== "harness-prepared" || records[1].event !== "protocol-frozen") {
        throw new Error("Campaign requires exactly the committed genesis and protocol-frozen ledger records");
    }
    assertJsonEqual(
        records[0],
        {
            schema: LEDGER_SCHEMA,
            campaignId: CAMPAIGN_ID,
            sequence: 0,
            previousRecordSha256: null,
            recordedAt: null,
            event: "harness-prepared",
            stageOrder: EMPIRICAL_STAGE_ORDER,
            zeroRetry: true,
        },
        "Ledger genesis",
    );
    const freeze = records[1];
    assertExactKeys(
        freeze,
        [
            "schema",
            "campaignId",
            "sequence",
            "previousRecordSha256",
            "recordedAt",
            "event",
            "status",
            "protocolCommit",
            "protocol",
            "genesisLedgerSha256",
            "zeroRetry",
            "stageOrder",
            "runners",
            "archives",
            "roots",
            "outputRoot",
            "hostIdentity",
            "executionEnvironment",
            "overlapMarkers",
            "hostMonitoring",
            "sourceDependencyPreflight",
            "v5InfrastructureIncident",
        ],
        "Protocol-frozen record",
    );
    if (
        freeze.status !== "authorized" ||
        JSON.stringify(freeze.stageOrder) !== JSON.stringify(EMPIRICAL_STAGE_ORDER) ||
        freeze.zeroRetry !== true ||
        (freeze.roots as { baseline?: string; candidate?: string } | undefined)?.baseline !== baselineRoot ||
        (freeze.roots as { baseline?: string; candidate?: string } | undefined)?.candidate !== candidateRoot ||
        freeze.outputRoot !== outputRoot ||
        freeze.genesisLedgerSha256 !== sha256(lines[0]) ||
        !jsonEqual(freeze.hostIdentity, EXPECTED_HOST_IDENTITY) ||
        !jsonEqual(freeze.executionEnvironment, REQUIRED_EXECUTION_ENVIRONMENT) ||
        !jsonEqual(freeze.overlapMarkers, OVERLAP_MARKERS) ||
        !jsonEqual(freeze.hostMonitoring, HOST_MONITORING) ||
        !jsonEqual(freeze.sourceDependencyPreflight, SOURCE_DEPENDENCY_PREFLIGHT) ||
        !jsonEqual(freeze.v5InfrastructureIncident, fileSeal(INCIDENT_PATH))
    ) {
        throw new Error("Protocol-frozen record does not authorize the exact campaign inputs and environment");
    }
    const protocolSeal = fileSeal(PROTOCOL_PATH);
    assertJsonEqual(freeze.protocol, protocolSeal, "Frozen protocol seal");
    const protocol = requireRecord(JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")), "protocol");
    if (protocol.schema !== PROTOCOL_SCHEMA || protocol.status !== PROTOCOL_STATUS) {
        throw new Error("Campaign protocol identity/status mismatch");
    }
    assertJsonEqual(
        protocol.sourceDependencyPreflight,
        SOURCE_DEPENDENCY_PREFLIGHT,
        "Protocol source/dependency preflight",
    );
    assertJsonEqual(
        protocol.v5InfrastructureIncident,
        expectedV5IncidentBinding(),
        "Protocol v5 infrastructure incident",
    );
    const protocolCampaign = requireRecord(protocol.campaign, "protocol campaign");
    assertJsonEqual(
        protocolCampaign,
        {
            id: CAMPAIGN_ID,
            runnerSchema: SCHEMA,
            stageOrder: EMPIRICAL_STAGE_ORDER,
            zeroRetry: true,
            outputRoot,
            executionEnvironment: REQUIRED_EXECUTION_ENVIRONMENT,
            hostIdentity: EXPECTED_HOST_IDENTITY,
            overlapMarkers: OVERLAP_MARKERS,
            hostMonitoring: HOST_MONITORING,
        },
        "Protocol campaign",
    );
    const protocolRunners = protocol.runners as Record<string, { schema: string; sha256: string }> | undefined;
    const expectedRunners = {
        campaign: { path: RUNNER_PATH, schema: SCHEMA },
        pair: { path: PAIR_PATH, schema: PAIR_SCHEMA },
        micro: { path: MICRO_PATH, schema: MICRO_SCHEMA },
        profile: { path: PROFILE_PATH, schema: PROFILE_SCHEMA },
        replication: { path: REPLICATION_PATH, schema: REPLICATION_SCHEMA },
        quantile: { path: QUANTILE_PATH, schema: TYPE7_QUANTILE_SCHEMA },
        sourceManifest: { path: SOURCE_MANIFEST_PATH, schema: A13_NEAR_GRID_SOURCE_MANIFEST_SCHEMA },
    };
    for (const [name, expected] of Object.entries(expectedRunners)) {
        const actual = protocolRunners?.[name];
        const seal = fileSeal(expected.path);
        if (!actual || !jsonEqual(actual, { schema: expected.schema, sha256: seal.sha256 })) {
            throw new Error(`Frozen ${name} runner mismatch`);
        }
        assertJsonEqual(
            requireRecord(requireRecord(freeze.runners, "frozen runners")[name], `frozen ${name} runner`),
            { ...seal, schema: expected.schema },
            `Ledger frozen ${name} runner`,
        );
    }
    assertJsonEqual(protocol.captureRunner, protocolRunners?.pair, "Protocol pair runner alias");
    assertJsonEqual(protocol.microRunner, protocolRunners?.micro, "Protocol micro runner alias");
    assertJsonEqual(protocol.profileRunner, protocolRunners?.profile, "Protocol profile runner alias");
    assertJsonEqual(protocol.aggregationRunner, protocolRunners?.replication, "Protocol replication runner alias");
    const baseline = requireRecord(protocol.baseline, "protocol baseline");
    const candidate = requireRecord(protocol.candidate, "protocol candidate");
    assertJsonEqual(
        freeze.archives,
        {
            baseline: {
                commit: BASELINE_COMMIT,
                archiveSha256: BASELINE_ARCHIVE_SHA256,
                srcManifestSha256: BASELINE_SRC_MANIFEST_SHA256,
            },
            candidate: {
                commit: CANDIDATE_COMMIT,
                archiveSha256: CANDIDATE_ARCHIVE_SHA256,
                srcManifestSha256: CANDIDATE_SRC_MANIFEST_SHA256,
            },
        },
        "Ledger frozen archives",
    );
    if (
        baseline.commit !== BASELINE_COMMIT ||
        baseline.archiveSha256 !== BASELINE_ARCHIVE_SHA256 ||
        baseline.srcTreeManifestSha256 !== BASELINE_SRC_MANIFEST_SHA256 ||
        candidate.commit !== CANDIDATE_COMMIT ||
        candidate.archiveSha256 !== CANDIDATE_ARCHIVE_SHA256 ||
        candidate.srcTreeManifestSha256 !== CANDIDATE_SRC_MANIFEST_SHA256
    ) {
        throw new Error("Protocol archive/source identities drifted");
    }
    const protocolCommit = requireString(freeze.protocolCommit, "frozen protocol commit");
    if (!/^[0-9a-f]{40}$/.test(protocolCommit)) throw new Error("Frozen protocol commit must be a full SHA-1");
    if (
        gitBytes(["rev-parse", `${protocolCommit}^{commit}`])
            .toString("utf8")
            .trim() !== protocolCommit
    ) {
        throw new Error("Frozen protocol commit does not resolve exactly");
    }
    const governedFiles = [
        protocolSeal,
        fileSeal(INCIDENT_PATH),
        ...Object.values(expectedRunners).map(({ path }) => fileSeal(path)),
    ];
    for (const governed of governedFiles) {
        const repositoryPath = relative(ROOT, governed.path);
        if (repositoryPath.startsWith("..") || isAbsolute(repositoryPath)) {
            throw new Error(`Governed file is outside the common repository: ${governed.path}`);
        }
        const committed = gitBytes(["show", `${protocolCommit}:${repositoryPath}`]);
        if (committed.byteLength !== governed.bytes || sha256(committed) !== governed.sha256) {
            throw new Error(`Governed file is not the exact protocol-commit version: ${repositoryPath}`);
        }
    }
    const ledgerRepositoryPath = relative(ROOT, ledgerPath);
    if (ledgerRepositoryPath.startsWith("..") || isAbsolute(ledgerRepositoryPath)) {
        throw new Error("Attempt ledger is outside the common repository");
    }
    if (gitBytes(["show", `${protocolCommit}:${ledgerRepositoryPath}`]).toString("utf8") !== `${lines[0]}\n`) {
        throw new Error("Protocol commit does not contain the exact ledger genesis");
    }
    if (gitBytes(["show", `HEAD:${ledgerRepositoryPath}`]).toString("utf8") !== `${lines.join("\n")}\n`) {
        throw new Error("Protocol-frozen ledger prelude must be committed before the first empirical stage");
    }
    const plannedStages = stages.map((stage) => stage.id);
    if (JSON.stringify(plannedStages) !== JSON.stringify(EMPIRICAL_STAGE_ORDER)) {
        throw new Error("Internal empirical stage order drift");
    }
}

function commandLine(): {
    baselineRoot: string;
    candidateRoot: string;
    outputRoot: string;
    ledgerPath: string;
} {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            "baseline-root": { type: "string" },
            "candidate-root": { type: "string" },
            output: { type: "string" },
            ledger: { type: "string" },
        },
    });
    if (!values["baseline-root"] || !values["candidate-root"] || !values.output || !values.ledger) {
        throw new Error("--baseline-root, --candidate-root, --output, and --ledger are required");
    }
    const baselineRoot = realpathSync(resolve(values["baseline-root"]));
    const candidateRoot = realpathSync(resolve(values["candidate-root"]));
    const requestedOutputRoot = resolve(values.output);
    const requestedParent = dirname(requestedOutputRoot);
    const parentStats = lstatSync(requestedParent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
        throw new Error(`Output parent must be a regular non-symlink directory: ${requestedParent}`);
    }
    const outputRoot = join(realpathSync(requestedParent), basename(requestedOutputRoot));
    if (outputRoot !== requestedOutputRoot) {
        throw new Error(`Output root must use its canonical parent path: ${outputRoot}`);
    }
    const ledgerPath = realpathSync(resolve(values.ledger));
    if (baselineRoot === candidateRoot) throw new Error("Baseline and candidate roots must differ");
    for (const governedRoot of [baselineRoot, candidateRoot, ROOT]) {
        for (const [container, child] of [
            [governedRoot, outputRoot],
            [outputRoot, governedRoot],
        ] as const) {
            const fromContainer = relative(container, child);
            const contained =
                fromContainer === "" ||
                (fromContainer !== ".." && !fromContainer.startsWith(`..${sep}`) && !isAbsolute(fromContainer));
            if (contained) {
                throw new Error(`Output root and governed root must not contain one another: ${governedRoot}`);
            }
        }
    }
    if (existsSync(outputRoot)) throw new Error(`Zero-retry output root already exists: ${outputRoot}`);
    return { baselineRoot, candidateRoot, outputRoot, ledgerPath };
}

async function main(): Promise<void> {
    auditType7Quantile();
    auditRuntimeInjection();
    const cli = commandLine();
    const stages = stagePlan(cli.baselineRoot, cli.candidateRoot, cli.outputRoot);
    assertFrozenPrelude(cli.ledgerPath, cli.baselineRoot, cli.candidateRoot, cli.outputRoot, stages);
    assertSourceAndDependencyPreflight(cli.baselineRoot, cli.candidateRoot);
    assertMicroSourcePreflight(cli.ledgerPath, cli.outputRoot);
    mkdirSync(cli.outputRoot, { recursive: false });
    const runtimeRoot = join(cli.outputRoot, "runtime");
    mkdirSync(runtimeRoot);
    const completed: ICompletedStage[] = [];
    const usedAttemptIds = new Set<string>();
    for (const stage of stages) {
        const stageRuntime = join(runtimeRoot, stage.id);
        const cleanHome = join(stageRuntime, "home");
        const temporary = join(stageRuntime, "tmp");
        mkdirSync(stageRuntime);
        mkdirSync(cleanHome);
        mkdirSync(temporary);
        console.log(`[campaign] starting ${stage.id}`);
        completed.push(await executeStage(stage, cli.ledgerPath, cleanHome, temporary, usedAttemptIds));
        console.log(`[campaign] accepted ${stage.id}`);
    }
    for (const stage of completed) {
        assertJsonEqual(fileSeal(stage.artifact.path), stage.artifact, `${stage.stage} artifact completion/closure`);
        assertJsonEqual(fileSeal(stage.stdout.path), stage.stdout, `${stage.stage} stdout completion/closure`);
        assertJsonEqual(fileSeal(stage.stderr.path), stage.stderr, `${stage.stage} stderr completion/closure`);
    }
    const profileArtifact = completed.find((stage) => stage.stage === "profile")?.artifact;
    const profileCompletionSidecars = completed.find((stage) => stage.stage === "profile")?.profileSidecars;
    if (!profileArtifact || !profileCompletionSidecars) {
        throw new Error("Profile stage did not produce a sealed artifact and sidecar set");
    }
    const profileSidecars = directorySeal(`${profileArtifact.path}.profiles`);
    assertJsonEqual(profileSidecars, profileCompletionSidecars, "Profile completion/closure sidecar seal");
    const closure = appendLedger(cli.ledgerPath, {
        event: "qualification-inputs-closed",
        stageOrder: EMPIRICAL_STAGE_ORDER,
        zeroRetry: true,
        noShadowAttemptsAttestation: true,
        acceptedStages: Object.fromEntries(
            completed.map((stage) => [
                stage.stage,
                { completionRecordSha256: stage.completionRecordSha256, artifact: stage.artifact },
            ]),
        ),
        profileSidecars,
    });
    const aggregatePath = join(cli.outputRoot, "aggregate.json");
    const byStage = new Map(completed.map((stage) => [stage.stage, stage]));
    const aggregateArgs = [
        REPLICATION_PATH,
        `--ledger=${cli.ledgerPath}`,
        `--semantic=${byStage.get("semantic")!.artifact.path}`,
        `--micro=${byStage.get("micro")!.artifact.path}`,
        `--profile=${byStage.get("profile")!.artifact.path}`,
        `--profile-dir=${byStage.get("profile")!.artifact.path}.profiles`,
        ...Array.from({ length: 10 }, (_, index) => `--r${index}=${byStage.get(`r${index}`)!.artifact.path}`),
        `--out=${aggregatePath}`,
    ];
    const aggregateRuntime = join(runtimeRoot, "aggregate");
    const aggregateHome = join(aggregateRuntime, "home");
    const aggregateTemporary = join(aggregateRuntime, "tmp");
    mkdirSync(aggregateRuntime);
    mkdirSync(aggregateHome);
    mkdirSync(aggregateTemporary);
    const aggregateConfigurationBefore = auditConfigurationAbsence(aggregateHome);
    const aggregateAttemptId = randomUUID();
    if (usedAttemptIds.has(aggregateAttemptId)) {
        throw new Error(`Duplicate aggregation attempt ID: ${aggregateAttemptId}`);
    }
    usedAttemptIds.add(aggregateAttemptId);
    const aggregateStarted = appendLedger(cli.ledgerPath, {
        event: "aggregation-attempt-started",
        attempt: 1,
        attemptId: aggregateAttemptId,
        closureRecordSha256: closure.sha256,
        runner: { ...fileSeal(REPLICATION_PATH), schema: REPLICATION_SCHEMA },
        argv: [process.execPath, ...aggregateArgs],
        artifactPath: aggregatePath,
        configurationAbsence: aggregateConfigurationBefore,
        zeroRetry: true,
        noRetryAfterAnyOutcome: true,
    });

    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let executionError: string | null = null;
    try {
        const aggregate = spawn(process.execPath, aggregateArgs, {
            cwd: ROOT,
            env: minimalEnvironment(aggregateHome, aggregateTemporary),
            stdio: "inherit",
        });
        const aggregateOutcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolvePromise, reject) => {
                aggregate.once("error", reject);
                aggregate.once("exit", (code, childSignal) => resolvePromise({ code, signal: childSignal }));
            },
        );
        exitCode = aggregateOutcome.code;
        signal = aggregateOutcome.signal;
    } catch (error) {
        executionError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }

    let aggregateConfigurationAfter: Record<string, unknown> | null = null;
    let configurationError: string | null = null;
    try {
        aggregateConfigurationAfter = auditConfigurationAbsence(aggregateHome);
        assertJsonEqual(
            aggregateConfigurationAfter,
            aggregateConfigurationBefore,
            "Aggregate runtime configuration pre/post",
        );
        auditRuntimeInjection();
    } catch (error) {
        configurationError = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }

    let aggregateSeal: IFileSeal | null = null;
    let aggregateQualified: boolean | null = null;
    let aggregateValidationError: string | null = null;
    if (existsSync(aggregatePath)) {
        try {
            aggregateSeal = fileSeal(aggregatePath);
            const aggregateReport = requireRecord(JSON.parse(readFileSync(aggregatePath, "utf8")), "aggregate report");
            const aggregateProtocol = requireRecord(aggregateReport.protocol, "aggregate protocol");
            const aggregateQualification = requireRecord(aggregateReport.qualification, "aggregate qualification");
            if (
                aggregateReport.schema !== REPLICATION_SCHEMA ||
                aggregateProtocol.baselineCommit !== BASELINE_COMMIT ||
                aggregateProtocol.candidateCommit !== CANDIDATE_COMMIT ||
                typeof aggregateQualification.passed !== "boolean"
            ) {
                throw new Error("Aggregate report identity or qualification result is invalid");
            }
            aggregateQualified = aggregateQualification.passed;
        } catch (error) {
            aggregateValidationError = error instanceof Error ? (error.stack ?? error.message) : String(error);
        }
    } else {
        aggregateValidationError = "aggregate artifact was not written";
    }

    const configurationUnchanged =
        aggregateConfigurationAfter !== null &&
        jsonEqual(aggregateConfigurationBefore, aggregateConfigurationAfter) &&
        configurationError === null;
    const validQualified =
        exitCode === 0 &&
        signal === null &&
        executionError === null &&
        configurationUnchanged &&
        aggregateValidationError === null &&
        aggregateQualified === true;
    const validUnqualified =
        exitCode === 1 &&
        signal === null &&
        executionError === null &&
        configurationUnchanged &&
        aggregateValidationError === null &&
        aggregateQualified === false;
    const validAggregate = validQualified || validUnqualified;
    const outcome = validQualified ? "valid-qualified" : validUnqualified ? "valid-unqualified" : "invalid-aggregation";
    const aggregateCompleted = appendLedger(cli.ledgerPath, {
        event: "aggregation-attempt-completed",
        attempt: 1,
        attemptId: aggregateAttemptId,
        startRecordSha256: aggregateStarted.sha256,
        closureRecordSha256: closure.sha256,
        exitCode,
        signal,
        aggregate: aggregateSeal,
        configurationAbsence: {
            before: aggregateConfigurationBefore,
            after: aggregateConfigurationAfter,
            unchanged: configurationUnchanged,
            error: configurationError,
        },
        validation: {
            executionError,
            aggregateError: aggregateValidationError,
            reportQualified: aggregateQualified,
            validQualified,
            validUnqualified,
            passed: validAggregate,
        },
        outcome,
        accepted: validAggregate,
        qualified: aggregateQualified,
        zeroRetry: true,
        noRetryAfterAnyOutcome: true,
    });
    if (!validAggregate || !aggregateSeal) {
        throw new Error(
            `Invalid aggregation after ledger closure ${closure.sha256}; terminal=${aggregateCompleted.sha256} ` +
                `code=${exitCode} signal=${signal} execution=${executionError} ` +
                `configuration=${configurationError} aggregate=${aggregateValidationError}`,
        );
    }

    console.log(
        JSON.stringify({
            schema: SCHEMA,
            campaignId: CAMPAIGN_ID,
            aggregate: aggregateSeal,
            ledger: fileSeal(cli.ledgerPath),
            closureRecordSha256: closure.sha256,
            aggregationStartRecordSha256: aggregateStarted.sha256,
            aggregationTerminalRecordSha256: aggregateCompleted.sha256,
            outcome,
            qualified: aggregateQualified,
        }),
    );
    if (validUnqualified) process.exitCode = 1;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
