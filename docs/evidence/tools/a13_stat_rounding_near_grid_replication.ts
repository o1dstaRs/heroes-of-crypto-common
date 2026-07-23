#!/usr/bin/env bun

/**
 * Strict ten-capture aggregation gate for the combined A13 first-layer and unit-stat rounding candidate.
 *
 * The runner executes no matches. It accepts only the ten fresh pair reports preregistered in the companion
 * protocol, verifies their source/runner/profile/schedule/semantic identities, and evaluates the fixed
 * order-balanced robust estimator. Rejected first-layer evidence is never read or pooled.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    linkSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, hostname, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { auditType7Quantile, type7Quantile, TYPE7_QUANTILE_SCHEMA } from "./a13_stat_rounding_near_grid_quantile";

const SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-replication/v2" as const;
const CAPTURE_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-pair/v2" as const;
const PROTOCOL_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-replication-protocol/v2" as const;
const MICRO_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-micro/v3" as const;
const PROFILE_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-profile/v2" as const;
const PROFILE_CAPTURE_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-capture/v2" as const;
const PROFILE_TELEMETRY_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-telemetry/v2" as const;
const LEDGER_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-attempt-ledger/v2" as const;
const CAMPAIGN_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-campaign/v1" as const;
const CAMPAIGN_ID = "a13-stat-rounding-near-grid-77ee4616-20260723-v4" as const;
const PROTOCOL_DATE = "2026-07-23";
const BASELINE_COMMIT = "188452cad6ec718540b7c452a579ac3cea73a67f";
const CANDIDATE_COMMIT = "77ee4616688f764fcfe49d4a1b15ec19e1ef384e";
const BASELINE_GIT_TREE = "efa549a827ba1ef8d8321c2fa47219859a17ffca";
const CANDIDATE_GIT_TREE = "a21e23f17eb6ebdb7a679b9841850b28a2b85ffb";
const BASELINE_SRC_MANIFEST_SHA256 = "076d0689decdfbb071c9632a05103d10bc7181e34500f980bae3c58433398370";
const CANDIDATE_SRC_MANIFEST_SHA256 = "1532611d2da05f628b92f3e51101bfdd0149089deadad25836da7dc51d4d8b9f";
const PROFILE_BASELINE_SRC_MANIFEST_SHA256 = "73f78af822eace14fbe63c22115922732e0255b431a24403bc8ec794aaf98369";
const PROFILE_CANDIDATE_SRC_MANIFEST_SHA256 = "c7456047698a25c0c399ee8397b826615735df826bcc6713657a5b1cb08e7211";
const BASELINE_ARCHIVE_SHA256 = "bd8de4690d92d6c0a952ded8fb8f66c3dafec404bb47a4f9b2c597b757cc5e2a";
const CANDIDATE_ARCHIVE_SHA256 = "d39e824171255bd67fdf5f4f2b91d72b8bcea278b889003990c03feff33bb76b";
const PACKAGE_JSON_SHA256 = "990a779e01b64fab88bdb72cb7fd6fa790eabc66a2f550d1e3481d620e1cf001";
const BUNFIG_TOML_SHA256 = "4a55c242db51f5ab64ce7df1ef8401f7815bd10ef28e42bf1a7d4f68168aa3cc";
const TSCONFIG_JSON_SHA256 = "013d77997ebb76aabe5f12044db25f7eadf57565d2cd7670f2320b073972c383";
const WORKSPACE_LOCK_SHA256 = "227ac3cc87c8488dea87841311baf509e361c22610ffc0ee21c553245e58ab54";
const CAPTURE_RUNNER_SHA256 = "d0d1dfac4d7c172c58a833b56421c7b50c86c052b06dfe0178131da0f923d183";
const MICRO_RUNNER_SHA256 = "4fe62ead29e0f31ea0ef9facef5e3644880b1813d01c4de1a9ef356fb8f2dd69";
const PROFILE_RUNNER_SHA256 = "87fa5e023edd48b20034d5cc284a00252e6c0e3766b77e7c34b3d3c6a42d40fb";
const MICRO_SOURCE_MANIFEST_SHA256 = "ce24e407ee41f2e0c90954345a05ddfc0281b65080f152b80a6fd269a8a6f234";
const MICRO_MANIFEST_CODEC = "heroes-of-crypto/a13-stat-rounding-near-grid-micro-manifest/type-tagged-v1";
const PROFILE_RUNTIME_DEPENDENCIES = Object.freeze({
    denque: {
        entryCount: 6,
        bytes: 30_361,
        manifestSha256: "56e571f695d1a01729ed0f0688c9e51990fb467b1392973c77cc57927e605531",
    },
    "google-protobuf": {
        entryCount: 17,
        bytes: 927_462,
        manifestSha256: "4ef936752035903b763562107050b45e230062f512c78ff1900e38d5de53ae52",
    },
});
const PAIR_RUNTIME_DEPENDENCIES = Object.freeze({
    denque: {
        entryCount: 6,
        bytes: 30_361,
        manifestSha256: "5e0b1bdea78fe558d60970724651524e978fdc1274dc41c29dbadc0d794bf535",
    },
    "google-protobuf": {
        entryCount: 17,
        bytes: 927_462,
        manifestSha256: "7cab1a735c0deac1b4fa7411e858f848f4ce579c9f1de86b0f7d46cda8b0431d",
    },
});
const PRODUCER_MANIFESTS = Object.freeze({
    pair: {
        codec: "heroes-of-crypto/type-tagged-canonical-value/v1",
        sourceScope: "recursive src tree; paths relative to src root",
        baselineSrcManifestSha256: BASELINE_SRC_MANIFEST_SHA256,
        candidateSrcManifestSha256: CANDIDATE_SRC_MANIFEST_SHA256,
        runtimeDependencies: PAIR_RUNTIME_DEPENDENCIES,
    },
    micro: {
        sourceCodec: "heroes-of-crypto/a13-stat-rounding-near-grid-micro-source/sorted-json-v1",
        identityCodec: "heroes-of-crypto/a13-stat-rounding-near-grid-micro-run-seal/sorted-json-v1",
        runtimeDependencyCodec: MICRO_MANIFEST_CODEC,
        sourceScope: "recursive src tree; paths relative to common root",
        candidateSrcManifestSha256: MICRO_SOURCE_MANIFEST_SHA256,
        runtimeDependencies: {
            denque: {
                entryCount: 6,
                bytes: 30_361,
                manifestSha256: "5e0b1bdea78fe558d60970724651524e978fdc1274dc41c29dbadc0d794bf535",
            },
            "google-protobuf": {
                entryCount: 17,
                bytes: 927_462,
                manifestSha256: "7cab1a735c0deac1b4fa7411e858f848f4ce579c9f1de86b0f7d46cda8b0431d",
            },
        },
    },
    profile: {
        codec: "heroes-of-crypto/a13-stat-rounding-near-grid-profile-manifest/sorted-json-array-v1",
        identityCodec: "heroes-of-crypto/a13-stat-rounding-near-grid-profile-identity/type-tagged-v1",
        sourceScope: "recursive src tree; sorted projected {bytes,kind,path,sha256} entries relative to src root",
        baselineSrcManifestSha256: PROFILE_BASELINE_SRC_MANIFEST_SHA256,
        candidateSrcManifestSha256: PROFILE_CANDIDATE_SRC_MANIFEST_SHA256,
        runtimeDependencies: PROFILE_RUNTIME_DEPENDENCIES,
    },
});
const MAX_LAPS = 2;
const SEMANTIC_MAX_LAPS = 8;
const WARMUP_SEED = 0xffff_ffff;
const BOOTSTRAP_SEED = 0xa135_1a9e;
const BOOTSTRAP_SAMPLES = 20_000;
const NATURAL_SEEDS = Object.freeze(Array.from({ length: 40 }, (_, index) => index + 1));
const NATURAL_GRID_TYPES = Object.freeze([1, 2, 3, 4]);
const CAPTURE_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => `r${index}`));
const ORIGINAL_CAPTURE_IDS = Object.freeze(["r0", "r2", "r4", "r6", "r8"]);
const INVERTED_CAPTURE_IDS = Object.freeze(["r1", "r3", "r5", "r7", "r9"]);
const TASKS_PER_CAPTURE = 160;
const MICRO_BLOCKS = 60;
const MICRO_SUPERBLOCK_SIZE = 4;
const MICRO_BOOTSTRAP_SAMPLES = 20_000;
const MICRO_BOOTSTRAP_SEED = 0xa135_7a71;
const MICRO_TARGET_MS = 35;
const MICRO_TIMED_ARM_FLOOR_MS = 17.5;
const MICRO_WARMUP_MS = 750;
const MICRO_EXACT_GRID_UPPER_95_GATE = 0.45;
const MICRO_ACTUAL_TRACE_UPPER_95_GATE = 0.7;
const PROFILE_CAPTURES_PER_VARIANT = 4;
const PROFILE_REPEATS_PER_CAPTURE = 9;
const PROFILE_SEEDS = Object.freeze([1, 42, 43, 44, 45, 46]);
const PROFILE_MAX_LAPS = 4;
const PROFILE_INTERVAL_US = 500;
const PINNED_BUN_REVISION = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4";
const PINNED_BUN_EXECUTABLE_SHA256 = "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233";
const PINNED_BOOT_TIME = "{ sec = 1784430937, usec = 167473 }";
const PINNED_HOST = Object.freeze({
    hostname: "Stepans-Mac-Studio.local",
    platform: "darwin",
    release: "24.6.0",
    arch: "arm64",
    cpuModel: "Apple M4 Max",
    logicalCpus: 16,
    hardwareModel: "Mac16,9",
    physicalCpus: 16,
    bootTime: PINNED_BOOT_TIME,
    bunVersion: "1.3.14",
    bunRevision: PINNED_BUN_REVISION,
    bunExecutableSha256: PINNED_BUN_EXECUTABLE_SHA256,
});
const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_EXECUTABLE_SHA256 = "7f30f076d0e9c38f772a76449fca9da8cf97f6a3d43b94c90a00e4f9ce7ad39e";
const GIT_VERSION = "git version 2.39.5 (Apple Git-154)";
const RUNNER_PATH = fileURLToPath(import.meta.url);
const COMMON_ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const PROTOCOL_PATH = resolve(
    dirname(RUNNER_PATH),
    "../a13_stat_rounding_near_grid_replication_protocol_2026-07-23.json",
);
const PAIR_RUNNER_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_pair.ts");
const MICRO_RUNNER_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_micro.ts");
const PROFILE_RUNNER_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_profile.ts");
const CAMPAIGN_RUNNER_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_campaign.ts");
const QUANTILE_HELPER_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_quantile.ts");
const EXPECTED_RUNTIME_DELTA = Object.freeze([
    {
        path: "ai/ai.ts",
        change: "modified",
        baselineSha256: "02f56c80806b28b29e393c07d77a83ebeb532b780440bc59897673b8268efe7d",
        candidateSha256: "84b1dee9f7178c195ac25cbc5f01b62b093cce3981883f1543fec99165dbc9c4",
    },
    {
        path: "ai/decision_path_catalog.ts",
        change: "modified",
        baselineSha256: "03ca1f30bde3cf2177b1e6d0a5c86036fd08878f444b90fc497885c685096c7d",
        candidateSha256: "f10673fddaf8f09485aed7e272ec894bdb5f50261957895f4d4eb9072a3d502d",
    },
    {
        path: "ai/internal/melee_target_layers.ts",
        change: "modified",
        baselineSha256: "18114a5eb7205de721b2cd6788445b0c8ac352759d017b112813e177a9ebe069",
        candidateSha256: "5235aed52cecce8f6c3d9be89dcbc38f76dc46cdb4b34f9042270f05245ed99e",
    },
    {
        path: "units/stat_rounding.ts",
        change: "added",
        baselineSha256: null,
        candidateSha256: "4e1019add7bb31ebfa3a2179e4a49ab74071851e893d7ec4eb242c7bc7b5d533",
    },
    {
        path: "units/unit.ts",
        change: "modified",
        baselineSha256: "95222fe2565b85e5e071a6c4e94deb2c137a8e1eeb3b945e130cc8c0130885aa",
        candidateSha256: "805bad2354c5b68b0c9e342642a077269473ed6f2d1cded101695687f256263d",
    },
]);
const EXPECTED_RUNTIME_DELTA_PATHS = Object.freeze(
    EXPECTED_RUNTIME_DELTA.map(({ path, change }) => ({ path, change })),
);
const EXPECTED_GATES = Object.freeze({
    exactTaskPairs: 1_600,
    semanticMismatches: 0,
    rejectedActions: 0,
    stuckMatches: 0,
    exceptions: 0,
    totalRatioBootstrapUpper95Maximum: 0.99,
    geometricRatioBootstrapUpper95MaximumExclusive: 1,
    robustP50MaximumExclusive: 1,
    robustP99MaximumExclusive: 1,
    robustP99BootstrapUpper95Maximum: 1.05,
    minimumRobustFasterTasks: 158,
    robustMaximumRatio: 1.05,
    orderTotalBootstrapUpper95MaximumExclusive: 1,
    perMapTotalRatioMaximum: 1.05,
    minimumFasterCaptures: 9,
    captureTotalRatioMaximum: 1.05,
});
const EXPECTED_DEVELOPMENT_PROVENANCE = Object.freeze({
    predecessor: {
        candidateCommit: "4d8d94a65aeb77ca953e2ee410b40eaa81d236d8",
        campaignId: "a13-stat-rounding-4d8d94a-20260723-v3",
        sealedAggregateSha256: "bc98b5216e48c0d98ea72dd6e4c4681e265e4cfb147c424cdb253515470c5a61",
        outcome: "not-qualified",
        inspectedFinding:
            "The v3 sealed-input reanalysis missed only the robust-p99 bootstrap upper-95 gate: 1.052046478353611 > 1.05.",
    },
    adaptation: {
        sourceRevisedAfterInspectingPredecessor: true,
        candidateCommit: CANDIDATE_COMMIT,
        change: "Add a strict scaled-value interval (-2^30,2^30) and strict nearest-grid distance (-0.25,0.25) arithmetic fast path while preserving native fallback and signed zero.",
    },
    freshEvidencePolicy: {
        freshV4TimingsOnly: true,
        predecessorTimingReadByV4Runners: false,
        predecessorTimingPooled: false,
        predecessorArtifactsAcceptedAsInputs: false,
        macroScheduleIdenticalToPredecessorV2: true,
        macroGatesIdenticalToPredecessorV2: true,
        noOptionalStoppingOrThresholdRevision: true,
    },
});
const EXPECTED_INJECTION_EXEC_ARGV_FLAGS = Object.freeze([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--preload",
]);
const EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
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
const EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_PREFIXES = Object.freeze([
    "DYLD_",
    "BUN_JSC_",
    "JSC_",
    "BUN_GC_",
    "Malloc",
    "MALLOC_",
]);
const EXPECTED_MICRO_FORBIDDEN_ENVIRONMENT_PREFIXES = Object.freeze([
    "DYLD_",
    "BUN_JSC_",
    "JSC_",
    "BUN_GC_",
    "MALLOC_",
    "Malloc",
]);
const EXPECTED_PROFILE_FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
    "BUN_PRELOAD",
    "BUN_OPTIONS",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "HOC_BREAK_DEBUG",
]);
const EXPECTED_PAIR_ALLOWED_BUN_ENVIRONMENT_KEYS = Object.freeze(["BUN_INSTALL", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"]);
const EXPECTED_PAIR_GOVERNED_LOCALE_KEYS = Object.freeze([
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_COLLATE",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_MESSAGES",
    "LC_MONETARY",
    "LC_PAPER",
    "LC_NAME",
    "LC_ADDRESS",
    "LC_TELEPHONE",
    "LC_MEASUREMENT",
    "LC_IDENTIFICATION",
]);
const REQUIRED_RUNTIME_ENVIRONMENT = Object.freeze({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
});
const EXPECTED_OVERLAP_MARKERS = Object.freeze([
    "a13_stat_rounding",
    "a13_stat_rounding_near_grid_pair",
    "a13_stat_rounding_near_grid_micro",
    "a13_stat_rounding_near_grid_profile",
    "a13_stat_rounding_near_grid_replication",
    "a13_stat_rounding_near_grid_campaign",
    "run_tournament.ts",
    "run_match.ts",
    "measure_mirror_cohorts",
    "run_v0_8_candidate",
]);
const EXPECTED_NATIVE_FUNCTION_AUDIT = Object.freeze([
    {
        label: "Function.prototype.toString",
        name: "toString",
        length: 0,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "14e89f65c8f615e78a921e427745d694c9be449421207ad27860575741ce6068",
    },
    {
        label: "Number",
        name: "Number",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "9a6eb610f91809c3ae9bb04ab9cbc0a97e471f64d02099e6993f1c981cabd8e5",
    },
    {
        label: "Number.prototype.toFixed",
        name: "toFixed",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "6fd2e7ec90562d96c2c0c3f428c78efb40938ac9dcd224ae2033edf6a676501e",
    },
    {
        label: "Number.isSafeInteger",
        name: "isSafeInteger",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "08f8fa7d0b5e9c917873a97efab3d3dc30e6e1fc8aa846edf32d3508de99735a",
    },
    {
        label: "Reflect.apply",
        name: "apply",
        length: 3,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "ecf1a1a012a3f06a7dd0c0267e1f2be429aab7d64d29fc318e6acf733e554332",
    },
]);
const EXPECTED_PAIR_FUNCTION_AUDIT = Object.freeze([
    ...EXPECTED_NATIVE_FUNCTION_AUDIT,
    {
        label: "process.hrtime",
        name: "hrtime",
        length: 0,
        descriptor: { writable: true, enumerable: true, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "8d7372efb0cec13469e60491554ce3777647371afb42eaa2452e8991b961e64a",
    },
    {
        label: "process.hrtime.bigint",
        name: "bigint",
        length: 0,
        descriptor: { writable: true, enumerable: true, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "dcd68afd0903329bfbd866993a686ea597de8bb3ce75d2d1bd4902d2e01fe723",
    },
]);
const EXPECTED_AGGREGATOR_FUNCTION_AUDIT = Object.freeze([
    ...EXPECTED_NATIVE_FUNCTION_AUDIT,
    {
        label: "Math.floor",
        name: "floor",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "8a8aae60097110d2f3298a38f490c75b86ad83ea24c2d3e899fdcd97361a2fc9",
    },
    {
        label: "Math.log",
        name: "log",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "05f1bf177079c3a1aec85e24487e7631213ab7b0ab29e3b2de7104cabc6b1147",
    },
    {
        label: "Math.exp",
        name: "exp",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "0838e6be579f3deaaf7782408c260214a7973ef557415270062d33c49b98969a",
    },
    {
        label: "Math.imul",
        name: "imul",
        length: 2,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "2032018c1241f29dc436f0f6ab0d7aee03dcf884c301403124f6780ecec75b9c",
    },
    {
        label: "Math.sqrt",
        name: "sqrt",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "3b7c599f40ea148cc370d0cec513538e9e17ded9172f677491a68be18de91a8e",
    },
    {
        label: "Math.min",
        name: "min",
        length: 2,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "4ec98f1a4ec907bf55109f1c5ca616e0ec50fc5ff58ea298a696757df93f8abb",
    },
    {
        label: "Math.max",
        name: "max",
        length: 2,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "a13ccf7913a2236532597288f8f01623b859fcec719498092055d17f264d0aa3",
    },
    {
        label: "Object.hasOwn",
        name: "hasOwn",
        length: 2,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "cd1f1ea4688f205226124561f6529f613a6b1ed0331fd127a1f4c9b07cab17ff",
    },
    {
        label: "Object.keys",
        name: "keys",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "33df956d6ebe9537f26c6e8102bfd8674f4f05af85a932d10bf59b52fc42590d",
    },
    {
        label: "Object.getPrototypeOf",
        name: "getPrototypeOf",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "f7f83a1c12f88e62d2a90f0fbf36801c821f8b3088748fe6384bdc15b03e9de2",
    },
    {
        label: "Reflect.ownKeys",
        name: "ownKeys",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "3b26e49b344bc11cd4c91b44d6906871e40a98bc5a6fca81ce18b95302fb6285",
    },
    {
        label: "JSON.stringify",
        name: "stringify",
        length: 3,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "b8d85bccd78cd18bb3fa33dc504409a1d496416fc6318af8a430bdb30275e54b",
    },
    {
        label: "JSON.parse",
        name: "parse",
        length: 2,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "c89530f92ba8052fdfbc49a33058d191a0e758467540469aaa9beb7e1f2fbfa6",
    },
    {
        label: "Array.prototype.sort",
        name: "sort",
        length: 1,
        descriptor: { writable: true, enumerable: false, configurable: true, data: true },
        nativeMarker: true,
        nativeSourceSha256: "e811ada5a0f8c8af1d04381243ef6f3a3aed2c4718b7bb636a3203e46dd90809",
    },
    ...EXPECTED_PAIR_FUNCTION_AUDIT.slice(EXPECTED_NATIVE_FUNCTION_AUDIT.length),
]);
const EXPECTED_SHARED_INPUTS = Object.freeze({
    packageJson: true,
    tsconfigJson: true,
    bunfigToml: true,
    workspaceLock: true,
    dependencies: true,
    dependencyResolution: true,
    bunExecutable: true,
    runnerPackageJson: true,
    runnerTsconfigJson: true,
    runnerBunfigToml: true,
    runnerWorkspaceLock: true,
});
const MICRO_ARM_ORDERS = Object.freeze([
    Object.freeze(["legacy", "candidate"]),
    Object.freeze(["candidate", "legacy"]),
    Object.freeze(["candidate", "legacy"]),
    Object.freeze(["legacy", "candidate"]),
]);
const REQUIRED_LEDGER_STAGES = Object.freeze([
    "semantic",
    "micro",
    "profile",
    "r0",
    "r1",
    "r3",
    "r2",
    "r4",
    "r5",
    "r7",
    "r6",
    "r8",
    "r9",
]);
const HOST_MONITORING = Object.freeze({
    intervalMilliseconds: 30_000,
    maximumSchedulingDelayMilliseconds: 5_000,
    policy: "Full pinned-host/runtime attestation before and after each producer; lightweight overlap, AC-power, and thermal-pressure checks every 30 seconds while it is alive.",
    invalidation:
        "The active producer receives SIGTERM and its sole attempt is rejected after any failed periodic sample.",
    signalHandling:
        "SIGINT or SIGTERM terminates the active producer process group, escalates to SIGKILL after 10 seconds if needed, and records an adjacent rejected completion.",
});
const LEDGER_COMMON_KEYS = Object.freeze(["schema", "campaignId", "sequence", "previousRecordSha256", "recordedAt"]);

interface ICaptureSchedule {
    id: string;
    seeds: number[];
    gridTypes: number[];
    invertOrder: boolean;
}

interface IFileSeal {
    path: string;
    realPath: string;
    bytes: number;
    sha256: string;
}

interface IValidatedRow {
    order: "AB" | "BA";
    seed: number;
    gridType: number;
    baselineNs: number;
    candidateNs: number;
    ratio: number;
    semantics: Record<string, unknown>;
}

interface IValidatedCapture {
    id: string;
    file: IFileSeal;
    schedule: ICaptureSchedule;
    report: Record<string, unknown>;
    rows: IValidatedRow[];
    rowsByTask: Map<string, IValidatedRow>;
    sourceIdentity: unknown;
    profileIdentity: unknown;
    hostIdentity: unknown;
    semanticIdentityByTask: Map<string, unknown>;
}

interface IRobustTask {
    seed: number;
    gridType: number;
    abRatios: number[];
    baRatios: number[];
    medianAbRatio: number;
    medianBaRatio: number;
    robustRatio: number;
}

interface ICli {
    captures: Record<string, string>;
    ledger: string;
    semantic: string;
    micro: string;
    profile: string;
    profileDir: string;
    out: string;
}

interface IValidatedMicro {
    file: IFileSeal;
    report: Record<string, unknown>;
    hostIdentity: Record<string, unknown>;
    sourceIdentity: unknown;
    gates: {
        exactGridUpper95: number;
        actualTraceUpper95: number;
        passed: true;
    };
}

interface IValidatedProfile {
    file: IFileSeal;
    directory: {
        path: string;
        realPath: string;
        entryCount: number;
        bytes: number;
        files: IFileSeal[];
        manifestSha256: string;
        campaignManifestSha256: string;
    };
    report: Record<string, unknown>;
    hostIdentity: Record<string, unknown>;
    sourceIdentity: unknown;
    gates: { passed: true };
}

interface IValidatedLedger {
    file: IFileSeal;
    campaignId: string;
    protocolCommit: string;
    recordCount: number;
    lastSequence: number;
    chainTipSha256: string;
    outputRoot: string;
    roots: { baseline: string; candidate: string };
    stages: Array<{
        stage: string;
        attemptId: string;
        startSequence: number;
        completionSequence: number;
        startedAt: string;
        completedAt: string;
        hostObservedBeforeAt: string;
        hostObservedAfterAt: string;
        producerClosedAt: string;
        monitorSampleCount: number;
        artifactTimestamp: string;
        artifact: IFileSeal;
    }>;
    closure: Record<string, unknown>;
    aggregationAttempt: Record<string, unknown>;
}

interface IMicroMeasurement {
    durationNs: number;
    operations: number;
    nanosecondsPerOperation: number;
    checksum: number;
}

interface IMicroBlock {
    block: number;
    armOrder: string[];
    workloadOrder: string[];
    workloads: Record<string, Record<string, IMicroMeasurement>>;
}

function rotate<T>(values: readonly T[], offset: number): T[] {
    return [...values.slice(offset), ...values.slice(0, offset)];
}

function captureSchedules(): ICaptureSchedule[] {
    const offsets = [0, 7, 14, 21, 28];
    const gridOffsets = [0, 1, 2, 3, 0];
    return offsets.flatMap((offset, pairIndex) => {
        const seeds = rotate(NATURAL_SEEDS, offset);
        const gridTypes = rotate(NATURAL_GRID_TYPES, gridOffsets[pairIndex]);
        return [
            { id: `r${pairIndex * 2}`, seeds, gridTypes, invertOrder: false },
            {
                id: `r${pairIndex * 2 + 1}`,
                seeds: [...seeds].reverse(),
                gridTypes: [...gridTypes].reverse(),
                invertOrder: true,
            },
        ];
    });
}

const CAPTURE_SCHEDULES = Object.freeze(captureSchedules());

function sha256(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function ledgerCanonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ledgerCanonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, child]) => [key, ledgerCanonicalize(child)]),
        );
    }
    if (typeof value === "bigint") return value.toString();
    if (value === undefined) return null;
    return value;
}

const ledgerCompactJson = (value: unknown): string => JSON.stringify(ledgerCanonicalize(value));

function microOrdinaryCanonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(microOrdinaryCanonicalize);
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const child = (value as Record<string, unknown>)[key];
            if (child !== undefined) result[key] = microOrdinaryCanonicalize(child);
        }
        return result;
    }
    return value;
}

const microOrdinaryDigest = (value: unknown): string => sha256(JSON.stringify(microOrdinaryCanonicalize(value)));

function profileIdentityCanonicalize(value: unknown): unknown {
    if (value === null) return ["null"];
    if (typeof value === "string") return ["string", value];
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "number") {
        if (Number.isNaN(value)) return ["number", "NaN"];
        if (value === Number.POSITIVE_INFINITY) return ["number", "+Infinity"];
        if (value === Number.NEGATIVE_INFINITY) return ["number", "-Infinity"];
        if (Object.is(value, -0)) return ["number", "-0"];
        return ["number", value];
    }
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (typeof value === "undefined") return ["undefined"];
    if (Array.isArray(value)) return ["array", value.map(profileIdentityCanonicalize)];
    if (value instanceof Map) {
        return [
            "map",
            [...value.entries()]
                .map(([key, child]) => [profileIdentityCanonicalize(key), profileIdentityCanonicalize(child)])
                .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0]))),
        ];
    }
    if (value instanceof Set) {
        return [
            "set",
            [...value.values()]
                .map(profileIdentityCanonicalize)
                .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        ];
    }
    if (typeof value === "object") {
        return [
            "object",
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, profileIdentityCanonicalize((value as Record<string, unknown>)[key])]),
        ];
    }
    return [typeof value, String(value)];
}

const profileIdentityDigest = (value: unknown): string => sha256(JSON.stringify(profileIdentityCanonicalize(value)));

interface ICanonicalState {
    nextObjectId: number;
    objectIds: WeakMap<object, number>;
}

function canonicalize(value: unknown, state: ICanonicalState): unknown {
    if (value === null) return ["null"];
    if (typeof value === "string") return ["string", value];
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "number") {
        if (Number.isNaN(value)) return ["number", "NaN"];
        if (value === Number.POSITIVE_INFINITY) return ["number", "+Infinity"];
        if (value === Number.NEGATIVE_INFINITY) return ["number", "-Infinity"];
        if (Object.is(value, -0)) return ["number", "-0"];
        return ["number", value];
    }
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (typeof value === "undefined") return ["undefined"];
    if (typeof value === "symbol" || typeof value === "function") {
        throw new Error(`Canonical encoding does not support ${typeof value} values`);
    }
    if (typeof value !== "object") throw new Error(`Canonical encoding does not support ${typeof value} values`);

    const existingId = state.objectIds.get(value);
    if (existingId !== undefined) return ["reference", existingId];
    const objectId = state.nextObjectId++;
    state.objectIds.set(value, objectId);

    if (Array.isArray(value)) {
        const slots = Array.from({ length: value.length }, (_, index) =>
            Object.hasOwn(value, index) ? canonicalize(value[index], state) : ["array-hole"],
        );
        const extraKeys = Object.keys(value)
            .filter((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
            .sort()
            .map((key) => [key, canonicalize((value as unknown as Record<string, unknown>)[key], state)]);
        const allowedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
        for (const key of Reflect.ownKeys(value)) {
            if (
                typeof key === "symbol" ||
                (typeof key === "string" && !allowedKeys.has(key) && !extraKeys.some(([itemKey]) => itemKey === key))
            ) {
                throw new Error("Canonical encoding encountered an unsupported array property");
            }
        }
        return ["array", objectId, slots, extraKeys];
    }
    if (value instanceof Map) {
        if (Reflect.ownKeys(value).length > 0) {
            throw new Error("Canonical encoding does not support custom Map properties");
        }
        return [
            "map",
            objectId,
            [...value.entries()].map(([key, child]) => [canonicalize(key, state), canonicalize(child, state)]),
        ];
    }
    if (value instanceof Set) {
        if (Reflect.ownKeys(value).length > 0) {
            throw new Error("Canonical encoding does not support custom Set properties");
        }
        return ["set", objectId, [...value.values()].map((child) => canonicalize(child, state))];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Canonical encoding does not support ${prototype?.constructor?.name ?? "unknown"} objects`);
    }
    const keys = Object.keys(value).sort();
    const ownKeys = Reflect.ownKeys(value);
    if (
        ownKeys.some((key) => typeof key === "symbol") ||
        ownKeys.some((key) => typeof key === "string" && !keys.includes(key))
    ) {
        throw new Error("Canonical encoding requires enumerable string-keyed plain objects");
    }
    return [
        prototype === null ? "null-prototype-object" : "object",
        objectId,
        keys.map((key) => [key, canonicalize((value as Record<string, unknown>)[key], state)]),
    ];
}

const canonicalJson = (value: unknown): string =>
    JSON.stringify(canonicalize(value, { nextObjectId: 0, objectIds: new WeakMap<object, number>() }));
const digest = (value: unknown): string => sha256(canonicalJson(value));
const pairDigest = digest;

function auditCanonicalEncoding(): Record<string, unknown> {
    const shared: Record<string, never> = {};
    const collisionPairs: Array<{ label: string; left: unknown; right: unknown }> = [
        { label: "undefined/null", left: undefined, right: null },
        { label: "bigint/string", left: 1n, right: "1" },
        { label: "negative/positive zero", left: -0, right: 0 },
        { label: "NaN/null", left: Number.NaN, right: null },
        { label: "infinity/null", left: Number.POSITIVE_INFINITY, right: null },
        { label: "array hole/undefined", left: Array(1), right: [undefined] },
        { label: "Map/plain object", left: new Map([["value", 1]]), right: { value: 1 } },
        { label: "Set/array", left: new Set([1]), right: [1] },
        { label: "shared/copied reference", left: { a: shared, b: shared }, right: { a: {}, b: {} } },
    ];
    for (const pair of collisionPairs) {
        if (canonicalJson(pair.left) === canonicalJson(pair.right)) {
            throw new Error(`Aggregator canonical encoding collision: ${pair.label}`);
        }
    }
    if (canonicalJson({ a: 1, b: 2 }) !== canonicalJson({ b: 2, a: 1 })) {
        throw new Error("Aggregator canonical encoding is not key-order invariant");
    }
    return {
        schema: "heroes-of-crypto/type-tagged-canonical-value/v1",
        collisionPairsChecked: collisionPairs.map((pair) => pair.label),
        keyOrderInvariant: true,
        passed: true,
    };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const taskKey = (seed: number, gridType: number): string => `${seed}:${gridType}`;

function assertEqual(actual: unknown, expected: unknown, label: string): void {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`${label} mismatch: expected=${canonicalJson(expected)} actual=${canonicalJson(actual)}`);
    }
}

const assertPairEqual = assertEqual;

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
    assertEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
    return value;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
    return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer`);
    return value as number;
}

function requireFiniteNumber(value: unknown, label: string, minimum?: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
        throw new Error(`${label} must be finite${minimum === undefined ? "" : ` and >= ${minimum}`}`);
    }
    return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${label} must be positive and finite`);
    }
    return value;
}

function requireSha256(value: unknown, label: string): string {
    const parsed = requireString(value, label);
    if (!/^[0-9a-f]{64}$/.test(parsed)) throw new Error(`${label} is not SHA-256`);
    return parsed;
}

function requireIsoTimestamp(value: unknown, label: string): string {
    const timestamp = requireString(value, label);
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
        throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
    }
    return timestamp;
}

function requireUuidV4(value: unknown, label: string): string {
    const uuid = requireString(value, label);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
        throw new Error(`${label} must be a lowercase UUIDv4`);
    }
    return uuid;
}

function fileSeal(pathInput: string): IFileSeal {
    const path = resolve(pathInput);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing input file ${path}`);
    const bytes = readFileSync(path);
    return { path, realPath: realpathSync(path), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function nearestWorkspaceLock(start: string): string {
    let directory = resolve(start);
    while (true) {
        for (const name of ["bun.lock", "bun.lockb"]) {
            const path = join(directory, name);
            if (existsSync(path) && statSync(path).isFile()) return path;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error(`No workspace lock above ${start}`);
}

function auditAggregatorRealm(): Record<string, unknown> {
    const locations: Array<{ label: string; owner: object; key: string; value: Function }> = [
        {
            label: "Function.prototype.toString",
            owner: Function.prototype,
            key: "toString",
            value: Function.prototype.toString,
        },
        { label: "Number", owner: globalThis, key: "Number", value: Number },
        {
            label: "Number.prototype.toFixed",
            owner: Number.prototype,
            key: "toFixed",
            value: Number.prototype.toFixed,
        },
        {
            label: "Number.isSafeInteger",
            owner: Number,
            key: "isSafeInteger",
            value: Number.isSafeInteger,
        },
        { label: "Reflect.apply", owner: Reflect, key: "apply", value: Reflect.apply },
        { label: "Math.floor", owner: Math, key: "floor", value: Math.floor },
        { label: "Math.log", owner: Math, key: "log", value: Math.log },
        { label: "Math.exp", owner: Math, key: "exp", value: Math.exp },
        { label: "Math.imul", owner: Math, key: "imul", value: Math.imul },
        { label: "Math.sqrt", owner: Math, key: "sqrt", value: Math.sqrt },
        { label: "Math.min", owner: Math, key: "min", value: Math.min },
        { label: "Math.max", owner: Math, key: "max", value: Math.max },
        { label: "Object.hasOwn", owner: Object, key: "hasOwn", value: Object.hasOwn },
        { label: "Object.keys", owner: Object, key: "keys", value: Object.keys },
        {
            label: "Object.getPrototypeOf",
            owner: Object,
            key: "getPrototypeOf",
            value: Object.getPrototypeOf,
        },
        { label: "Reflect.ownKeys", owner: Reflect, key: "ownKeys", value: Reflect.ownKeys },
        { label: "JSON.stringify", owner: JSON, key: "stringify", value: JSON.stringify },
        { label: "JSON.parse", owner: JSON, key: "parse", value: JSON.parse },
        {
            label: "Array.prototype.sort",
            owner: Array.prototype,
            key: "sort",
            value: Array.prototype.sort,
        },
        { label: "process.hrtime", owner: process, key: "hrtime", value: process.hrtime },
        {
            label: "process.hrtime.bigint",
            owner: process.hrtime,
            key: "bigint",
            value: process.hrtime.bigint,
        },
    ];
    const functions = locations.map((location) => {
        const descriptor = Object.getOwnPropertyDescriptor(location.owner, location.key);
        if (!descriptor || descriptor.value !== location.value || descriptor.get || descriptor.set) {
            throw new Error(`Aggregator realm descriptor is not a direct data property for ${location.label}`);
        }
        const nativeSource = Function.prototype.toString.call(location.value);
        return {
            label: location.label,
            name: location.value.name,
            length: location.value.length,
            descriptor: {
                writable: descriptor.writable,
                enumerable: descriptor.enumerable,
                configurable: descriptor.configurable,
                data: true,
            },
            nativeMarker: nativeSource.includes("[native code]"),
            nativeSourceSha256: sha256(nativeSource),
        };
    });
    assertEqual(functions, EXPECTED_AGGREGATOR_FUNCTION_AUDIT, "aggregator native realm");
    return {
        passed: true,
        standardDescriptorsVerified: true,
        nativeFunctionSourcesVerified: true,
        functions,
    };
}

function auditAggregatorInjection(): Record<string, unknown> {
    const environmentKeys = Object.keys(process.env).sort();
    const presentEnvironmentKeys = environmentKeys.filter(
        (key) =>
            EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_KEYS.includes(
                key as (typeof EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_KEYS)[number],
            ) || EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    const unexpectedBunEnvironmentKeys = environmentKeys.filter(
        (key) => key.startsWith("BUN_") && !EXPECTED_PAIR_ALLOWED_BUN_ENVIRONMENT_KEYS.includes(key),
    );
    const unexpectedLocaleEnvironmentKeys = environmentKeys.filter(
        (key) => key.startsWith("LC_") && !EXPECTED_PAIR_GOVERNED_LOCALE_KEYS.includes(key),
    );
    const requiredEnvironment = Object.fromEntries(
        Object.entries(REQUIRED_RUNTIME_ENVIRONMENT).map(([key, expected]) => [
            key,
            { expected, observed: process.env[key] ?? null },
        ]),
    );
    const governedEnvironment = Object.fromEntries(
        Object.keys(REQUIRED_RUNTIME_ENVIRONMENT)
            .sort()
            .map((key) => [key, process.env[key] ?? null]),
    );
    const mismatchedRequiredEnvironment = Object.entries(REQUIRED_RUNTIME_ENVIRONMENT)
        .filter(([key, expected]) => process.env[key] !== expected)
        .map(([key]) => key);
    const execArgv = [...process.execArgv];
    const forbiddenExecArgv = execArgv.filter(isForbiddenExecArgv);
    const audit = {
        passed:
            presentEnvironmentKeys.length === 0 &&
            unexpectedBunEnvironmentKeys.length === 0 &&
            unexpectedLocaleEnvironmentKeys.length === 0 &&
            mismatchedRequiredEnvironment.length === 0 &&
            forbiddenExecArgv.length === 0 &&
            execArgv.length === 0,
        forbiddenEnvironmentKeys: EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_KEYS,
        forbiddenEnvironmentPrefixes: EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_PREFIXES,
        presentEnvironmentKeys,
        allowedBunEnvironmentKeys: EXPECTED_PAIR_ALLOWED_BUN_ENVIRONMENT_KEYS,
        unexpectedBunEnvironmentKeys,
        governedLocaleEnvironmentKeys: EXPECTED_PAIR_GOVERNED_LOCALE_KEYS,
        unexpectedLocaleEnvironmentKeys,
        requiredEnvironment,
        mismatchedRequiredEnvironment,
        forbiddenExecArgvFlags: EXPECTED_INJECTION_EXEC_ARGV_FLAGS,
        execArgv,
        forbiddenExecArgv,
        execArgvExactlyEmpty: execArgv.length === 0,
        requiredExecutionEnvironment: REQUIRED_RUNTIME_ENVIRONMENT,
        governedEnvironment,
    };
    validatePairInjection(audit, "aggregator runtime injection");
    return audit;
}

function auditAggregatorWorkspace(): Record<string, unknown> {
    const root = resolve(COMMON_ROOT);
    const realRoot = realpathSync(root);
    if (realpathSync(process.cwd()) !== realRoot) {
        throw new Error(`Aggregator must execute with cwd exactly ${realRoot}`);
    }
    const runtimeHome = process.env.HOME;
    if (!runtimeHome) throw new Error("Aggregator requires an explicit clean HOME");
    const rootDynamicEnvironment = readdirSync(root)
        .filter((name) => name.startsWith(".env"))
        .map((name) => join(root, name));
    const forbiddenConfigurationPaths = [
        ...[".env", ".env.local", ".env.development", ".env.production", ".env.test"].map((name) => join(root, name)),
        ...rootDynamicEnvironment,
        join(root, ".bunfig.toml"),
        join(root, "bunfig.local.toml"),
        join(runtimeHome, ".bunfig.toml"),
        join(runtimeHome, ".config/bunfig.toml"),
        join(runtimeHome, ".config/bun/bunfig.toml"),
    ]
        .filter((path, index, values) => values.indexOf(path) === index)
        .sort();
    const presentConfigurationPaths = forbiddenConfigurationPaths.filter((path) => existsSync(path));
    assertEqual(presentConfigurationPaths, [], "aggregator forbidden runtime configuration files");
    const payload = {
        root,
        realRoot,
        packageJson: fileSeal(join(root, "package.json")),
        tsconfigJson: fileSeal(join(root, "tsconfig.json")),
        bunfigToml: fileSeal(join(root, "bunfig.toml")),
        workspaceLock: fileSeal(nearestWorkspaceLock(root)),
        configurationAbsence: {
            passed: true,
            checked: forbiddenConfigurationPaths,
            present: presentConfigurationPaths,
            rootEnvironmentGlob: ".env*",
            bunConfigurationCandidatesAbsent: true,
        },
    };
    return { ...payload, identitySha256: pairDigest(payload) };
}

function commandText(executable: string, args: readonly string[]): string {
    return execFileSync(executable, [...args], { encoding: "utf8" }).trim();
}

function processTable(): Array<{ pid: number; ppid: number; command: string }> {
    return commandText("/bin/ps", ["-axo", "pid=,ppid=,command="])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (!match) throw new Error(`Cannot parse process row: ${line}`);
            return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
        });
}

function ancestorProcessIds(rows: readonly { pid: number; ppid: number }[]): Set<number> {
    const parentByPid = new Map(rows.map((row) => [row.pid, row.ppid]));
    const output = new Set<number>([process.pid]);
    let current = process.pid;
    while (parentByPid.has(current)) {
        current = parentByPid.get(current)!;
        if (current <= 1 || output.has(current)) break;
        output.add(current);
    }
    return output;
}

function auditAggregatorHost(): Record<string, unknown> {
    const processRows = processTable();
    const excludedProcessIds = ancestorProcessIds(processRows);
    const matchingProcesses = processRows.filter(
        (row) =>
            !excludedProcessIds.has(row.pid) && EXPECTED_OVERLAP_MARKERS.some((marker) => row.command.includes(marker)),
    );
    assertEqual(matchingProcesses, [], "aggregator overlapping benchmark processes");
    const powerRaw = commandText("/usr/bin/pmset", ["-g", "batt"]);
    if (!powerRaw.includes("Now drawing from 'AC Power'")) throw new Error("Aggregator host is not on AC power");
    const thermalRaw = commandText("/usr/bin/pmset", ["-g", "therm"]);
    const thermalNominal =
        thermalRaw.includes("No thermal warning level has been recorded") &&
        thermalRaw.includes("No performance warning level has been recorded") &&
        thermalRaw.includes("No CPU power status has been recorded");
    if (!thermalNominal) throw new Error("Aggregator host has thermal or performance pressure");
    const bunExecutable = fileSeal(process.execPath);
    const bootTimeRaw = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
    }).trim();
    const bootTimeMatch = /^\{ sec = (\d+), usec = (\d+) \}/.exec(bootTimeRaw);
    if (!bootTimeMatch) throw new Error(`Cannot normalize aggregator kern.boottime: ${bootTimeRaw}`);
    const observed = {
        hostname: hostname(),
        platform: platform(),
        release: release(),
        arch: arch(),
        cpuModel: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        hardwareModel: execFileSync("/usr/sbin/sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim(),
        physicalCpus: Number(execFileSync("/usr/sbin/sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8" }).trim()),
        bootTime: `{ sec = ${bootTimeMatch[1]}, usec = ${bootTimeMatch[2]} }`,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        bunExecutableSha256: bunExecutable.sha256,
    };
    assertEqual(observed, PINNED_HOST, "aggregator pinned host");
    return {
        pinned: true,
        observed,
        bunExecutable,
        power: { ac: true, rawSha256: sha256(powerRaw), raw: powerRaw },
        thermal: { nominal: true, rawSha256: sha256(thermalRaw), raw: thermalRaw },
        overlap: { passed: true, markers: EXPECTED_OVERLAP_MARKERS, matchingProcesses: [] },
        passed: true,
    };
}

function auditAggregatorRuntime(): Record<string, unknown> {
    const gitExecutable = fileSeal(GIT_EXECUTABLE);
    assertEqual(gitExecutable.sha256, GIT_EXECUTABLE_SHA256, "aggregator Git executable");
    const gitVersion = execFileSync(GIT_EXECUTABLE, ["--version"], { encoding: "utf8" }).trim();
    assertEqual(gitVersion, GIT_VERSION, "aggregator Git version");
    return {
        runner: fileSeal(RUNNER_PATH),
        git: { executable: gitExecutable, version: gitVersion },
        canonicalEncoding: auditCanonicalEncoding(),
        workspace: auditAggregatorWorkspace(),
        injection: auditAggregatorInjection(),
        realm: auditAggregatorRealm(),
        host: auditAggregatorHost(),
    };
}

function readJsonObject(path: string, label: string): Record<string, unknown> {
    return requireRecord(JSON.parse(readFileSync(path, "utf8")), label);
}

function pathIsWithin(pathInput: string, rootInput: string): boolean {
    const relation = relative(resolve(rootInput), resolve(pathInput));
    return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function commandLine(): ICli | undefined {
    const options = Object.fromEntries([
        ["help", { type: "boolean" as const, default: false }],
        ["out", { type: "string" as const }],
        ["ledger", { type: "string" as const }],
        ["semantic", { type: "string" as const }],
        ["micro", { type: "string" as const }],
        ["profile", { type: "string" as const }],
        ["profile-dir", { type: "string" as const }],
        ...CAPTURE_IDS.map((id) => [id, { type: "string" as const }]),
    ]);
    const parsed = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options,
    });
    const values = parsed.values as Record<string, string | boolean | undefined>;
    if (values.help) {
        console.log(
            "Usage: bun docs/evidence/tools/a13_stat_rounding_near_grid_replication.ts " +
                "--ledger=ATTEMPTS.jsonl --semantic=SEMANTIC.json --micro=MICRO.json " +
                "--profile=PROFILE.json --profile-dir=PROFILE.json.profiles " +
                CAPTURE_IDS.map((id) => `--${id}=REPORT.json`).join(" ") +
                " --out=AGGREGATE.json",
        );
        return undefined;
    }
    if (typeof values.out !== "string") throw new Error("--out is required");
    for (const option of ["ledger", "semantic", "micro", "profile", "profile-dir"] as const) {
        if (typeof values[option] !== "string") throw new Error(`--${option} is required`);
    }
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
    const outputParent = dirname(out);
    if (
        !existsSync(outputParent) ||
        !lstatSync(outputParent).isDirectory() ||
        lstatSync(outputParent).isSymbolicLink() ||
        realpathSync(outputParent) !== outputParent
    ) {
        throw new Error("Output parent must be an existing canonical non-symlink directory");
    }
    const captures: Record<string, string> = {};
    for (const id of CAPTURE_IDS) {
        const value = values[id];
        if (typeof value !== "string") throw new Error(`--${id} is required`);
        captures[id] = resolve(value);
    }
    const ledger = resolve(values.ledger as string);
    const semantic = resolve(values.semantic as string);
    const micro = resolve(values.micro as string);
    const profile = resolve(values.profile as string);
    const profileDir = resolve(values["profile-dir"] as string);
    if (!existsSync(profileDir) || !statSync(profileDir).isDirectory()) {
        throw new Error(`Missing profile directory ${profileDir}`);
    }
    const reportPaths = [ledger, semantic, micro, profile, ...Object.values(captures)];
    const realPaths = reportPaths.map((path) => fileSeal(path).realPath);
    if (new Set(realPaths).size !== reportPaths.length) {
        throw new Error("Ledger, semantic, micro, profile, and capture paths must all be distinct");
    }
    if (
        pathIsWithin(out, profileDir) ||
        pathIsWithin(out, COMMON_ROOT) ||
        reportPaths.some((path) => resolve(path) === out)
    ) {
        throw new Error("Evidence and output paths overlap a governed path");
    }
    return { captures, ledger, semantic, micro, profile, profileDir, out };
}

function loadProtocol(): { value: Record<string, unknown>; seal: IFileSeal } {
    const seal = fileSeal(PROTOCOL_PATH);
    const value = requireRecord(JSON.parse(readFileSync(PROTOCOL_PATH, "utf8")), "protocol");
    assertEqual(value.schema, PROTOCOL_SCHEMA, "protocol schema");
    assertEqual(value.protocolDate, PROTOCOL_DATE, "protocol date");
    assertEqual(value.status, "prepared-before-zero-retry-thirteen-stage-qualification", "protocol prepared status");
    const baseline = requireRecord(value.baseline, "protocol baseline");
    const candidate = requireRecord(value.candidate, "protocol candidate");
    assertEqual(baseline.commit, BASELINE_COMMIT, "baseline commit");
    assertEqual(candidate.commit, CANDIDATE_COMMIT, "candidate commit");
    assertEqual(baseline.gitTree, BASELINE_GIT_TREE, "baseline Git tree");
    assertEqual(candidate.gitTree, CANDIDATE_GIT_TREE, "candidate Git tree");
    assertEqual(baseline.archiveFormat, "git archive --format=tar", "baseline archive format");
    assertEqual(candidate.archiveFormat, "git archive --format=tar", "candidate archive format");
    assertEqual(baseline.archiveSha256, BASELINE_ARCHIVE_SHA256, "baseline archive hash");
    assertEqual(candidate.archiveSha256, CANDIDATE_ARCHIVE_SHA256, "candidate archive hash");
    assertEqual(baseline.srcTreeManifestSha256, BASELINE_SRC_MANIFEST_SHA256, "baseline src manifest");
    assertEqual(candidate.srcTreeManifestSha256, CANDIDATE_SRC_MANIFEST_SHA256, "candidate src manifest");
    assertEqual(value.runtimeDelta, EXPECTED_RUNTIME_DELTA, "protocol runtime delta");
    assertEqual(value.captures, CAPTURE_SCHEDULES, "protocol capture schedule");
    assertEqual(value.gates, EXPECTED_GATES, "protocol gates");
    assertEqual(
        value.developmentProvenance,
        EXPECTED_DEVELOPMENT_PROVENANCE,
        "protocol adaptive-development provenance",
    );
    assertEqual(
        value.quantileImplementation,
        {
            schema: TYPE7_QUANTILE_SCHEMA,
            helper: {
                path: "docs/evidence/tools/a13_stat_rounding_near_grid_quantile.ts",
                sha256: fileSeal(QUANTILE_HELPER_PATH).sha256,
            },
            producerVerifierSharedImplementation: true,
            interpolationExpression: "lower * (1 - fraction) + upper * fraction",
            deterministicAudit: auditType7Quantile(),
        },
        "protocol shared quantile implementation",
    );
    assertEqual(
        value.scheduleRule,
        {
            defaultOrder: "AB when (seed-list index + grid-list index) is even, otherwise BA",
            inversion:
                "Each odd capture is the exact traversal reverse of its preceding even capture and flips every AB/BA pair.",
            executionOrder: ["r0", "r1", "r3", "r2", "r4", "r5", "r7", "r6", "r8", "r9"],
            executionOrderRationale:
                "Alternate which member of each exact reverse pair runs first so wall-clock drift cannot stay aligned with one task-order stratum.",
            balance: "Every (seed,map) task has exactly five AB and five BA observations.",
            parityAlignment:
                "Even-capture seed rotations [0,7,14,21,28] align in parity with grid rotations [0,1,2,3,0]. Therefore every task stays in one order across the five even captures and in the opposite order across the five exact reverse/inverted captures, so every bootstrap resample always contains exactly five observations per order.",
            draftDifference:
                "This parity-aligned schedule intentionally supersedes the earlier uncommitted draft offsets [0,7,15,23,31], whose mixed parity could leave a bootstrap replicate with an order count other than five.",
        },
        "protocol schedule rule",
    );
    assertEqual(
        value.estimator,
        {
            perTask: "sqrt(median(five AB candidate/baseline ratios) * median(five BA candidate/baseline ratios))",
            quantile: "Type-7 linear interpolation at p50, p95, and p99",
            bootstrap:
                "20,000 deterministic replicates jointly resampling five exact even/odd capture-pair clusters and forty seed clusters; all four maps retained.",
            interval: "Type-7 percentile interval [2.5%, 97.5%]",
            rawDataPolicy: "Retain every observation. Do not trim, winsorize, selectively rerun, or remove a slow row.",
        },
        "protocol estimator",
    );
    assertEqual(
        value.stoppingRule,
        {
            validCaptures: "Run exactly r0 through r9; do not add a capture after inspecting performance.",
            hostInvalidation:
                "Any source, realm, runner, semantic, rejection, stuck, exception, micro, profile, or process failure, or any failed pinned-host preflight or postflight, or 30-second in-stage AC-power, thermal-pressure, or overlapping-benchmark check, ends this zero-retry campaign.",
            semanticOrSourceFailure:
                "A source, runner, profile, semantic, rejection, stuck, or exception failure ends the protocol and is not replaceable.",
            performanceFailure:
                "Any failed performance gate after r9 leaves this candidate unqualified. Never rerun only a slow task.",
            aggregationAttempt:
                "Append and fsync one canonical hash-chained aggregation-attempt-started record before invoking the replication runner.",
            aggregationTerminal:
                "Append and fsync one aggregation-attempt-completed record after every normal qualified, unqualified, spawn-error, validation-error, or thrown aggregation outcome.",
            validUnqualified:
                "A schema-valid aggregate written with qualification.passed=false and verifier exit 1 is retained as valid-unqualified evidence, then the campaign exits 1.",
            aggregationRetry:
                "Never invoke aggregation more than once and never delete or replace its output; any valid-unqualified or invalid outcome is terminal.",
            operatorAttestation:
                "Commit this protocol and all runners before the semantic corpus, then execute only the sealed campaign driver and append its hash-chained start/completion records to the attempt ledger.",
        },
        "protocol stopping rule",
    );
    const fixed = requireRecord(value.fixedWork, "protocol fixedWork");
    assertEqual(
        {
            aiVersion: fixed.aiVersion,
            captureCount: fixed.captureCount,
            tasksPerCapture: fixed.tasksPerCapture,
            totalTaskPairs: fixed.totalTaskPairs,
            measuredMatches: fixed.measuredMatches,
            maxLaps: fixed.maxLaps,
            warmupSeed: fixed.warmupSeed,
            warmupMatchesPerCapture: fixed.warmupMatchesPerCapture,
            bootstrapSeed: fixed.bootstrapSeed,
            bootstrapSamples: fixed.bootstrapSamples,
            bootstrapUnit: fixed.bootstrapUnit,
        },
        {
            aiVersion: "v0.8",
            captureCount: 10,
            tasksPerCapture: TASKS_PER_CAPTURE,
            totalTaskPairs: TASKS_PER_CAPTURE * 10,
            measuredMatches: TASKS_PER_CAPTURE * 10 * 2,
            maxLaps: MAX_LAPS,
            warmupSeed: WARMUP_SEED,
            warmupMatchesPerCapture: NATURAL_GRID_TYPES.length * 2,
            bootstrapSeed: BOOTSTRAP_SEED,
            bootstrapSamples: BOOTSTRAP_SAMPLES,
            bootstrapUnit:
                "joint resampling of five exact even/odd capture-pair clusters and forty seed clusters; all four maps retained",
        },
        "protocol fixed work",
    );
    const dependencies = requireRecord(value.dependencyInputs, "protocol dependencies");
    assertEqual(dependencies.packageJsonSha256, PACKAGE_JSON_SHA256, "protocol package hash");
    assertEqual(dependencies.tsconfigJsonSha256, TSCONFIG_JSON_SHA256, "protocol tsconfig hash");
    assertEqual(dependencies.bunfigTomlSha256, BUNFIG_TOML_SHA256, "protocol bunfig hash");
    assertEqual(dependencies.workspaceLockSha256, WORKSPACE_LOCK_SHA256, "protocol lock hash");
    assertEqual(dependencies.bunExecutableSha256, PINNED_BUN_EXECUTABLE_SHA256, "protocol Bun executable hash");
    assertEqual(dependencies.runtimeDependencies, PAIR_RUNTIME_DEPENDENCIES, "protocol pair runtime dependencies");
    assertEqual(value.producerManifests, PRODUCER_MANIFESTS, "protocol producer manifest domains");
    const aggregationRunner = requireRecord(value.aggregationRunner, "protocol aggregationRunner");
    assertEqual(aggregationRunner.schema, SCHEMA, "protocol aggregation schema");
    assertEqual(aggregationRunner.sha256, fileSeal(RUNNER_PATH).sha256, "protocol aggregation runner hash");
    const captureRunner = requireRecord(value.captureRunner, "protocol captureRunner");
    const microRunner = requireRecord(value.microRunner, "protocol microRunner");
    const profileRunner = requireRecord(value.profileRunner, "protocol profileRunner");
    assertEqual(captureRunner.schema, CAPTURE_SCHEMA, "capture schema");
    assertEqual(captureRunner.sha256, CAPTURE_RUNNER_SHA256, "capture runner hash");
    assertEqual(microRunner.schema, MICRO_SCHEMA, "micro schema");
    assertEqual(microRunner.sha256, MICRO_RUNNER_SHA256, "micro runner hash");
    assertEqual(profileRunner.schema, PROFILE_SCHEMA, "profile schema");
    assertEqual(profileRunner.sha256, PROFILE_RUNNER_SHA256, "profile runner hash");
    const expectedRunners = {
        campaign: { schema: CAMPAIGN_SCHEMA, sha256: fileSeal(CAMPAIGN_RUNNER_PATH).sha256 },
        pair: { schema: CAPTURE_SCHEMA, sha256: CAPTURE_RUNNER_SHA256 },
        micro: { schema: MICRO_SCHEMA, sha256: MICRO_RUNNER_SHA256 },
        profile: { schema: PROFILE_SCHEMA, sha256: PROFILE_RUNNER_SHA256 },
        replication: { schema: SCHEMA, sha256: fileSeal(RUNNER_PATH).sha256 },
        quantile: { schema: TYPE7_QUANTILE_SCHEMA, sha256: fileSeal(QUANTILE_HELPER_PATH).sha256 },
    };
    assertEqual(value.runners, expectedRunners, "protocol runner registry");
    assertEqual(captureRunner, expectedRunners.pair, "protocol pair runner alias");
    assertEqual(microRunner, expectedRunners.micro, "protocol micro runner alias");
    assertEqual(profileRunner, expectedRunners.profile, "protocol profile runner alias");
    assertEqual(aggregationRunner, expectedRunners.replication, "protocol replication runner alias");
    const semanticCorpus = requireRecord(value.semanticCorpus, "protocol semantic corpus");
    assertEqual(
        semanticCorpus,
        {
            runnerSchema: CAPTURE_SCHEMA,
            runnerSha256: captureRunner.sha256,
            timingDisposition: "untimed-correctness-only-never-pooled",
            seeds: "1-40",
            gridTypes: [1, 2, 3, 4],
            maxLaps: 8,
            taskPairs: 160,
            matches: 320,
            gates: {
                semanticMismatches: 0,
                rejectedActions: 0,
                stuckMatches: 0,
                exceptions: 0,
                exactFullResultsActionsPlacementsRostersEndReasonsAndActionCounts: true,
            },
        },
        "semantic corpus",
    );
    assertEqual(
        value.microQualification,
        {
            mode: "evidence",
            blocks: 60,
            targetMinimumMillisecondsPerArmBlock: 35,
            minimumMillisecondsPerTimedArmBlock: 17.5,
            warmupMilliseconds: 750,
            bootstrapSamples: 20_000,
            bootstrapSuperblockSize: 4,
            requiredSuperblocks: 15,
            correctness: {
                rawFloat64Patterns: 1_000_000,
                comparisonsPerPattern: 2,
                curatedBoundariesAndGridNeighbors: true,
                strictNearGridBoundariesRandomInt32ValuesAndSignedZero: true,
                dynamicMutationBoxedFallbackAndProductionTrace: true,
                mismatches: 0,
            },
            gates: {
                exactGridCandidateToLegacyBootstrapUpper95Maximum: 0.45,
                actualTraceCandidateToLegacyBootstrapUpper95Maximum: 0.7,
            },
        },
        "micro qualification",
    );
    assertEqual(
        value.profileQualification,
        {
            mode: "evidence",
            capturesPerVariant: 4,
            repeatsPerCapture: 9,
            seeds: [1, 42, 43, 44, 45, 46],
            maxLaps: 4,
            profilerIntervalMicroseconds: 500,
            gates: {
                exactSemantics: true,
                warmupSemantics: true,
                telemetrySemantics: true,
                parentAndChildRealm: true,
                oracleMismatches: 0,
                candidateTelemetryCallsMinimumExclusive: 0,
                candidateFastPathShareMinimum: 0.9,
                candidateNearGridFastCallsMinimumExclusive: 0,
                nearGridScaledBoundsExclusive: [-(2 ** 30), 2 ** 30],
                nearGridDistanceBoundsExclusive: [-0.25, 0.25],
                signedZeroTelemetryRetained: true,
                candidateDynamicFallbacks: 0,
                legacyConversionParity: true,
                candidateFallbackAccounting: true,
                baselineTelemetryClean: true,
                fullBuilderCandidateToBaselineMaximum: 0.5,
                baselineFirstBuilderCalls: 0,
                candidateFirstBuilderCallsMinimumExclusive: 0,
                fullBuilderUnderDoFindTargetReductionMinimum: 0.5,
                candidateCombinedBuilderShareMaximum: 0.03,
                adjustBaseStatsCandidateToBaselineMaximum: 0.9,
                nativeToFixedUnderAdjustCandidateToBaselineMaximum: 0.25,
                candidateNativeToFixedUnderAdjustShareMaximum: 0.01,
                perCaptureSignals: {
                    baselineFullBuilderUnderDoFindTargetMicrosecondsMinimum: 10_000,
                    baselineAdjustBaseStatsMicrosecondsMinimum: 50_000,
                    baselineNativeToFixedUnderAdjustMicrosecondsMinimum: 10_000,
                    nativeToFixedUnderAdjustCoverageMinimum: 0.85,
                    candidateRoundUnitStatMicrosecondsMinimumExclusive: 0,
                },
                perCaptureDirections: {
                    fullBuilderCandidateBelowBaseline: true,
                    adjustBaseStatsCandidateBelowBaseline: true,
                    nativeToFixedUnderAdjustCandidateBelowBaseline: true,
                    candidateCombinedBuilderShareMaximum: 0.03,
                },
            },
        },
        "profile qualification",
    );
    return { value, seal };
}

function validateAggregatorRuntimeBinding(
    runtime: Record<string, unknown>,
    protocol: Record<string, unknown>,
    label: string,
): void {
    const runner = requireRecord(runtime.runner, `${label} runner`);
    assertEqual(runner, fileSeal(RUNNER_PATH), `${label} runner seal`);
    assertEqual(
        runner.sha256,
        requireRecord(protocol.aggregationRunner, "protocol aggregation runner").sha256,
        `${label} protocol runner binding`,
    );
    const workspace = requireRecord(runtime.workspace, `${label} workspace`);
    const { identitySha256, ...identityPayload } = workspace;
    assertEqual(identitySha256, pairDigest(identityPayload), `${label} workspace identity arithmetic`);
    const dependencies = requireRecord(protocol.dependencyInputs, "protocol dependencies");
    assertEqual(
        {
            packageJson: requireRecord(workspace.packageJson, `${label} package`).sha256,
            tsconfigJson: requireRecord(workspace.tsconfigJson, `${label} tsconfig`).sha256,
            bunfigToml: requireRecord(workspace.bunfigToml, `${label} bunfig`).sha256,
            workspaceLock: requireRecord(workspace.workspaceLock, `${label} workspace lock`).sha256,
        },
        {
            packageJson: dependencies.packageJsonSha256,
            tsconfigJson: dependencies.tsconfigJsonSha256,
            bunfigToml: dependencies.bunfigTomlSha256,
            workspaceLock: dependencies.workspaceLockSha256,
        },
        `${label} workspace dependency binding`,
    );
    const host = requireRecord(runtime.host, `${label} host`);
    assertEqual(
        requireRecord(host.bunExecutable, `${label} Bun executable`).sha256,
        dependencies.bunExecutableSha256,
        `${label} Bun executable binding`,
    );
    validatePairInjection(runtime.injection, `${label} injection`);
    const realm = requireRecord(runtime.realm, `${label} realm`);
    assertEqual(realm.passed, true, `${label} realm passed`);
    assertEqual(realm.functions, EXPECTED_AGGREGATOR_FUNCTION_AUDIT, `${label} realm functions`);
}

function expectedOrder(schedule: ICaptureSchedule, seedIndex: number, gridIndex: number): "AB" | "BA" {
    const natural = (seedIndex + gridIndex) % 2 === 0 ? "AB" : "BA";
    return schedule.invertOrder ? (natural === "AB" ? "BA" : "AB") : natural;
}

function isForbiddenExecArgv(value: string): boolean {
    return EXPECTED_INJECTION_EXEC_ARGV_FLAGS.some(
        (flag) =>
            value === flag ||
            value.startsWith(`${flag}=`) ||
            (flag === "-r" && value.startsWith("-r") && value.length > 2),
    );
}

function validateInjection(
    value: unknown,
    label: string,
    expectedEnvironmentKeys: readonly string[] = EXPECTED_PROFILE_FORBIDDEN_ENVIRONMENT_KEYS,
    expectedEnvironmentPrefixes: readonly string[] = EXPECTED_MICRO_FORBIDDEN_ENVIRONMENT_PREFIXES,
): void {
    const injection = requireRecord(value, label);
    assertEqual(injection.passed, true, `${label} passed`);
    const forbiddenEnvironmentKeys = requireArray(injection.forbiddenEnvironmentKeys, `${label} environment keys`).map(
        (item, index) => requireString(item, `${label} environment key ${index}`),
    );
    assertEqual(forbiddenEnvironmentKeys, expectedEnvironmentKeys, `${label} exact environment keys`);
    const forbiddenEnvironmentPrefixes = requireArray(
        injection.forbiddenEnvironmentPrefixes,
        `${label} environment prefixes`,
    ).map((item, index) => requireString(item, `${label} environment prefix ${index}`));
    assertEqual(forbiddenEnvironmentPrefixes, expectedEnvironmentPrefixes, `${label} exact environment prefixes`);
    assertEqual(injection.forbiddenExecArgvFlags, EXPECTED_INJECTION_EXEC_ARGV_FLAGS, `${label} execArgv flags`);
    assertEqual(injection.presentEnvironmentKeys, [], `${label} present environment keys`);
    const execArgv = requireArray(injection.execArgv, `${label} execArgv`).map((item, index) =>
        requireString(item, `${label} execArgv ${index}`),
    );
    assertEqual(execArgv, [], `${label} exact empty execArgv`);
    assertEqual(injection.execArgvExactlyEmpty, true, `${label} execArgv exactness`);
    const requiredEnvironment = requireRecord(
        injection.requiredExecutionEnvironment,
        `${label} required execution environment`,
    );
    const governedEnvironment = requireRecord(injection.governedEnvironment, `${label} governed environment`);
    assertEqual(governedEnvironment, requiredEnvironment, `${label} governed environment`);
    assertEqual(requiredEnvironment.BUN_RUNTIME_TRANSPILER_CACHE_PATH, "0", `${label} transpiler cache`);
    assertEqual(requiredEnvironment.LANG, "C.UTF-8", `${label} LANG`);
    assertEqual(requiredEnvironment.TZ, "UTC", `${label} TZ`);
    assertEqual(requiredEnvironment.LC_ALL, "C", `${label} LC_ALL`);
}

function validatePairInjection(value: unknown, label: string): void {
    const injection = requireRecord(value, label);
    assertEqual(injection.passed, true, `${label} passed`);
    assertEqual(
        injection.forbiddenEnvironmentKeys,
        EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_KEYS,
        `${label} forbidden environment keys`,
    );
    assertEqual(
        injection.forbiddenEnvironmentPrefixes,
        EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_PREFIXES,
        `${label} forbidden environment prefixes`,
    );
    assertEqual(injection.presentEnvironmentKeys, [], `${label} present environment keys`);
    assertEqual(
        injection.allowedBunEnvironmentKeys,
        EXPECTED_PAIR_ALLOWED_BUN_ENVIRONMENT_KEYS,
        `${label} allowed Bun environment`,
    );
    assertEqual(injection.unexpectedBunEnvironmentKeys, [], `${label} unexpected Bun environment`);
    assertEqual(
        injection.governedLocaleEnvironmentKeys,
        EXPECTED_PAIR_GOVERNED_LOCALE_KEYS,
        `${label} governed locale environment`,
    );
    assertEqual(injection.unexpectedLocaleEnvironmentKeys, [], `${label} unexpected locale environment`);
    assertEqual(injection.mismatchedRequiredEnvironment, [], `${label} required environment mismatches`);
    assertEqual(injection.forbiddenExecArgvFlags, EXPECTED_INJECTION_EXEC_ARGV_FLAGS, `${label} execArgv flags`);
    assertEqual(injection.execArgv, [], `${label} exact empty execArgv`);
    assertEqual(injection.forbiddenExecArgv, [], `${label} forbidden execArgv`);
    assertEqual(injection.execArgvExactlyEmpty, true, `${label} execArgv exactness`);
    assertEqual(
        injection.requiredExecutionEnvironment,
        REQUIRED_RUNTIME_ENVIRONMENT,
        `${label} required execution environment`,
    );
    assertEqual(injection.governedEnvironment, REQUIRED_RUNTIME_ENVIRONMENT, `${label} governed environment`);
    const required = requireRecord(injection.requiredEnvironment, `${label} required environment`);
    for (const [key, expected] of [
        ["BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0"],
        ["LANG", "C.UTF-8"],
        ["TZ", "UTC"],
    ] as const) {
        const item = requireRecord(required[key], `${label} ${key}`);
        assertEqual(item.expected, expected, `${label} ${key} expected`);
        assertEqual(item.observed, expected, `${label} ${key} observed`);
    }
    const lcAll = requireRecord(required.LC_ALL, `${label} LC_ALL`);
    if (lcAll.expected !== "C" || lcAll.observed !== "C") {
        throw new Error(`${label} LC_ALL is not pinned to a C locale`);
    }
}

function validateRealmAudit(
    value: unknown,
    label: string,
    expectedFunctions: unknown = EXPECTED_NATIVE_FUNCTION_AUDIT,
): void {
    const realm = requireRecord(value, label);
    assertEqual(realm.passed, true, `${label} passed`);
    assertEqual(realm.standardDescriptorsVerified, true, `${label} descriptors`);
    assertEqual(realm.nativeFunctionSourcesVerified, true, `${label} native sources`);
    assertEqual(realm.functions, expectedFunctions, `${label} native functions`);
}

function validateHost(value: unknown, label: string): Record<string, unknown> {
    const host = requireRecord(value, label);
    const normalized = {
        platform: requireString(host.platform, `${label}.platform`),
        release: requireString(host.release, `${label}.release`),
        arch: requireString(host.arch, `${label}.arch`),
        cpuModel: requireString(host.cpuModel, `${label}.cpuModel`),
        logicalCpus: requireInteger(host.logicalCpus ?? host.logicalCpuCount, `${label}.logicalCpus`, 1),
        bunVersion: requireString(host.bunVersion ?? host.bun, `${label}.bunVersion`),
    };
    assertEqual(
        normalized,
        {
            platform: "darwin",
            release: "24.6.0",
            arch: "arm64",
            cpuModel: "Apple M4 Max",
            logicalCpus: 16,
            bunVersion: "1.3.14",
        },
        `${label} pinned host`,
    );
    return normalized;
}

function validateCapture(
    schedule: ICaptureSchedule,
    path: string,
    protocol: Record<string, unknown>,
    protocolSeal: IFileSeal,
    expectedMaxLaps = MAX_LAPS,
): IValidatedCapture {
    const file = fileSeal(path);
    const report = requireRecord(JSON.parse(readFileSync(path, "utf8")), `${schedule.id} report`);
    assertEqual(report.schema, CAPTURE_SCHEMA, `${schedule.id} schema`);
    requireUuidV4(report.attemptId, `${schedule.id} attempt ID`);
    const command = requireRecord(report.command, `${schedule.id} command`);
    assertEqual(
        {
            captureId: command.captureId,
            smoke: command.smoke,
            invertOrder: command.invertOrder,
            seeds: command.seeds,
            gridTypes: command.gridTypes,
            maxLaps: command.maxLaps,
            warmupSeed: command.warmupSeed,
        },
        {
            captureId: schedule.id,
            smoke: false,
            invertOrder: schedule.invertOrder,
            seeds: schedule.seeds,
            gridTypes: schedule.gridTypes,
            maxLaps: expectedMaxLaps,
            warmupSeed: WARMUP_SEED,
        },
        `${schedule.id} command`,
    );
    const protocolEvidence = requireRecord(report.protocol, `${schedule.id} protocol`);
    assertEqual(protocolEvidence.schema, PROTOCOL_SCHEMA, `${schedule.id} protocol schema`);
    assertEqual(protocolEvidence.before, protocolSeal, `${schedule.id} protocol before`);
    assertEqual(protocolEvidence.after, protocolSeal, `${schedule.id} protocol after`);
    assertEqual(protocolEvidence.unchanged, true, `${schedule.id} protocol unchanged`);
    assertEqual(protocolEvidence.schedule, schedule, `${schedule.id} protocol schedule`);
    assertEqual(protocolEvidence.scheduleExact, true, `${schedule.id} protocol schedule exact`);
    const protocolCaptureRunner = requireRecord(
        protocolEvidence.captureRunner,
        `${schedule.id} protocol capture runner`,
    );
    const captureRunner = requireRecord(protocol.captureRunner, "protocol captureRunner");
    assertEqual(protocolCaptureRunner, captureRunner, `${schedule.id} protocol capture runner`);
    const host = requireRecord(report.host, `${schedule.id} host`);
    assertEqual(host.pinned, true, `${schedule.id} pinned host`);
    assertEqual(
        requireRecord(host.bunExecutable, `${schedule.id} host Bun executable`).sha256,
        requireRecord(protocol.dependencyInputs, "protocol dependencies").bunExecutableSha256,
        `${schedule.id} host Bun executable`,
    );
    assertEqual(host.bunExecutable, fileSeal(process.execPath), `${schedule.id} host Bun executable seal`);
    const hostIdentity = {
        platform: requireString(host.platform, `${schedule.id} host platform`),
        release: requireString(host.release, `${schedule.id} host release`),
        arch: requireString(host.arch, `${schedule.id} host arch`),
        cpuModel: requireString(host.cpuModel, `${schedule.id} CPU`),
        logicalCpus: requireInteger(host.logicalCpus, `${schedule.id} logical CPUs`, 1),
        bunVersion: requireString(host.bunVersion, `${schedule.id} Bun`),
    };
    assertEqual(
        {
            ...hostIdentity,
            bunRevision: requireString(host.bunRevision, `${schedule.id} Bun revision`),
            bunExecutableSha256: requireSha256(host.bunExecutableSha256, `${schedule.id} Bun executable identity`),
        },
        {
            platform: PINNED_HOST.platform,
            release: PINNED_HOST.release,
            arch: PINNED_HOST.arch,
            cpuModel: PINNED_HOST.cpuModel,
            logicalCpus: PINNED_HOST.logicalCpus,
            bunVersion: PINNED_HOST.bunVersion,
            bunRevision: PINNED_HOST.bunRevision,
            bunExecutableSha256: PINNED_HOST.bunExecutableSha256,
        },
        `${schedule.id} pinned host identity`,
    );
    const realm = requireRecord(report.realm, `${schedule.id} realm`);
    assertEqual(realm.preloadHooksAbsent, true, `${schedule.id} preload hooks`);
    assertEqual(realm.standardDescriptorsAndNativeSourcesVerified, true, `${schedule.id} standard numeric realm`);
    const injection = requireRecord(realm.runtimeInjection, `${schedule.id} runtime injection audit`);
    assertEqual(injection.unchanged, true, `${schedule.id} runtime injection unchanged`);
    assertEqual(injection.before, injection.after, `${schedule.id} runtime injection pre/post`);
    validatePairInjection(injection.before, `${schedule.id} runtime injection`);
    assertEqual(realm.unchanged, true, `${schedule.id} realm unchanged`);
    assertEqual(realm.before, realm.after, `${schedule.id} realm pre/post`);
    const realmBefore = requireRecord(realm.before, `${schedule.id} realm before`);
    assertEqual(realmBefore.passed, true, `${schedule.id} realm audit passed`);
    assertEqual(realmBefore.standardDescriptorsVerified, true, `${schedule.id} standard descriptors`);
    assertEqual(realmBefore.nativeFunctionSourcesVerified, true, `${schedule.id} native sources`);
    assertEqual(realmBefore.functions, EXPECTED_PAIR_FUNCTION_AUDIT, `${schedule.id} native functions`);

    const environment = requireRecord(report.environment, `${schedule.id} environment`);
    assertEqual(environment.unchanged, true, `${schedule.id} environment unchanged`);
    assertEqual(environment.scrubbedStartupBehaviorKeys, [], `${schedule.id} scrubbed startup behavior environment`);
    assertEqual(environment.governedBefore, environment.governedAfter, `${schedule.id} governed environment pre/post`);
    const governed = requireRecord(environment.governedBefore, `${schedule.id} governed environment`);
    assertEqual(governed.behaviorEntries, [], `${schedule.id} governed behavior environment`);
    assertEqual(governed.hocBreakDebug, null, `${schedule.id} HOC_BREAK_DEBUG`);
    const expectedRuntimeEntries = Object.entries(REQUIRED_RUNTIME_ENVIRONMENT)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, expected]) => ({ key, expected, observed: expected }));
    assertEqual(governed.runtimeEntries, expectedRuntimeEntries, `${schedule.id} governed runtime environment`);
    assertEqual(
        governed.sha256,
        pairDigest({ behaviorEntries: [], runtimeEntries: expectedRuntimeEntries, hocBreakDebug: null }),
        `${schedule.id} governed environment SHA arithmetic`,
    );
    const requiredRuntimeEnvironment = requireRecord(
        environment.requiredRuntimeEnvironment,
        `${schedule.id} required runtime environment`,
    );
    assertEqual(
        requiredRuntimeEnvironment,
        REQUIRED_RUNTIME_ENVIRONMENT,
        `${schedule.id} required runtime environment`,
    );
    const bunConfig = requireRecord(environment.bunConfigFiles, `${schedule.id} Bun config files`);
    assertEqual(bunConfig.unchanged, true, `${schedule.id} Bun config unchanged`);
    assertEqual(bunConfig.before, bunConfig.after, `${schedule.id} Bun config pre/post`);
    const bunConfigBefore = requireRecord(bunConfig.before, `${schedule.id} Bun config`);
    assertEqual(bunConfigBefore.passed, true, `${schedule.id} Bun config audit`);
    assertEqual(
        bunConfigBefore.checked,
        [
            "runner/bunfig.local.toml",
            "runner/.bunfig.toml",
            "home/.bunfig.toml",
            "home/.config/bunfig.toml",
            "home/.config/bun/bunfig.toml",
        ],
        `${schedule.id} Bun config candidates`,
    );
    assertEqual(bunConfigBefore.present, [], `${schedule.id} Bun config presence`);
    assertEqual(
        bunConfigBefore.xdgConfig,
        {
            environmentKey: "XDG_CONFIG_HOME",
            environmentValue: null,
            effectiveLocation: "home/.config",
            bunConfigCandidatesAbsent: true,
        },
        `${schedule.id} XDG Bun configuration`,
    );
    const runnerCwd = requireRecord(environment.runnerCwd, `${schedule.id} runner cwd`);
    assertEqual(runnerCwd.unchanged, true, `${schedule.id} runner cwd unchanged`);
    assertEqual(runnerCwd.before, runnerCwd.after, `${schedule.id} runner cwd pre/post`);
    const runnerCwdBefore = requireRecord(runnerCwd.before, `${schedule.id} runner cwd before`);
    const { identitySha256: runnerCwdIdentity, ...runnerCwdIdentityPayload } = runnerCwdBefore;
    assertEqual(
        runnerCwdIdentity,
        pairDigest(runnerCwdIdentityPayload),
        `${schedule.id} runner cwd identity arithmetic`,
    );

    const source = requireRecord(report.source, `${schedule.id} source`);
    const runnerBefore = requireRecord(source.runnerBefore, `${schedule.id} runner before`);
    const runnerAfter = requireRecord(source.runnerAfter, `${schedule.id} runner after`);
    assertEqual(runnerBefore.sha256, captureRunner.sha256, `${schedule.id} pair runner hash`);
    assertEqual(runnerAfter, runnerBefore, `${schedule.id} runner pre/post`);
    assertEqual(source.runnerUnchanged, true, `${schedule.id} runner unchanged`);
    assertEqual(source.postflightUnchanged, true, `${schedule.id} source unchanged`);
    const baselineBefore = requireRecord(source.baselineBefore, `${schedule.id} baseline before`);
    const baselineAfter = requireRecord(source.baselineAfter, `${schedule.id} baseline after`);
    const candidateBefore = requireRecord(source.candidateBefore, `${schedule.id} candidate before`);
    const candidateAfter = requireRecord(source.candidateAfter, `${schedule.id} candidate after`);
    assertEqual(baselineAfter, baselineBefore, `${schedule.id} baseline pre/post`);
    assertEqual(candidateAfter, candidateBefore, `${schedule.id} candidate pre/post`);
    const pairManifests = requireRecord(
        requireRecord(protocol.producerManifests, "protocol producer manifests").pair,
        "protocol pair manifests",
    );
    for (const [label, sourceReport] of [
        ["baseline", baselineBefore],
        ["candidate", candidateBefore],
    ] as const) {
        const { identitySha256, ...identityPayload } = sourceReport;
        assertEqual(identitySha256, pairDigest(identityPayload), `${schedule.id} ${label} source identity arithmetic`);
        requireString(sourceReport.root, `${schedule.id} ${label} root`);
        requireString(sourceReport.realRoot, `${schedule.id} ${label} real root`);
        requireInteger(sourceReport.srcEntryCount, `${schedule.id} ${label} source entries`, 1);
        requireInteger(sourceReport.srcBytes, `${schedule.id} ${label} source bytes`, 1);
    }
    assertEqual(
        baselineBefore.srcTreeManifestSha256,
        pairManifests.baselineSrcManifestSha256,
        `${schedule.id} baseline manifest`,
    );
    assertEqual(
        candidateBefore.srcTreeManifestSha256,
        pairManifests.candidateSrcManifestSha256,
        `${schedule.id} candidate manifest`,
    );
    assertEqual(
        requireRecord(baselineBefore.packageJson, "baseline package").sha256,
        PACKAGE_JSON_SHA256,
        `${schedule.id} package hash`,
    );
    assertEqual(
        requireRecord(candidateBefore.packageJson, "candidate package").sha256,
        PACKAGE_JSON_SHA256,
        `${schedule.id} candidate package hash`,
    );
    assertEqual(
        requireRecord(baselineBefore.workspaceLock, "baseline lock").sha256,
        WORKSPACE_LOCK_SHA256,
        `${schedule.id} lock hash`,
    );
    assertEqual(
        requireRecord(candidateBefore.workspaceLock, "candidate lock").sha256,
        WORKSPACE_LOCK_SHA256,
        `${schedule.id} candidate lock hash`,
    );
    const dependencyInputs = requireRecord(protocol.dependencyInputs, "protocol dependency inputs");
    assertEqual(
        {
            packageJson: requireRecord(runnerCwdBefore.packageJson, `${schedule.id} runner package`).sha256,
            tsconfigJson: requireRecord(runnerCwdBefore.tsconfigJson, `${schedule.id} runner tsconfig`).sha256,
            bunfigToml: requireRecord(runnerCwdBefore.bunfigToml, `${schedule.id} runner bunfig`).sha256,
            workspaceLock: requireRecord(runnerCwdBefore.workspaceLock, `${schedule.id} runner lock`).sha256,
        },
        {
            packageJson: dependencyInputs.packageJsonSha256,
            tsconfigJson: dependencyInputs.tsconfigJsonSha256,
            bunfigToml: dependencyInputs.bunfigTomlSha256,
            workspaceLock: dependencyInputs.workspaceLockSha256,
        },
        `${schedule.id} runner cwd dependency identities`,
    );
    for (const [label, sourceReport] of [
        ["baseline", baselineBefore],
        ["candidate", candidateBefore],
    ] as const) {
        assertEqual(
            requireRecord(sourceReport.tsconfigJson, `${label} tsconfig`).sha256,
            dependencyInputs.tsconfigJsonSha256,
            `${schedule.id} ${label} tsconfig hash`,
        );
        assertEqual(
            requireRecord(sourceReport.bunfigToml, `${label} bunfig`).sha256,
            dependencyInputs.bunfigTomlSha256,
            `${schedule.id} ${label} bunfig hash`,
        );
        assertEqual(
            requireRecord(sourceReport.bunExecutable, `${label} Bun executable`).sha256,
            dependencyInputs.bunExecutableSha256,
            `${schedule.id} ${label} Bun executable hash`,
        );
        assertEqual(
            sourceReport.bunExecutable,
            fileSeal(process.execPath),
            `${schedule.id} ${label} Bun executable seal`,
        );
        const actualDependencies = requireRecord(sourceReport.runtimeDependencies, `${label} runtime dependencies`);
        const expectedDependencies = requireRecord(
            dependencyInputs.runtimeDependencies,
            "protocol runtime dependencies",
        );
        assertEqual(
            Object.keys(actualDependencies).sort(),
            ["denque", "google-protobuf"],
            `${schedule.id} ${label} dependency names`,
        );
        for (const dependencyName of ["denque", "google-protobuf"]) {
            const actual = requireRecord(actualDependencies[dependencyName], `${label} dependency ${dependencyName}`);
            const expected = requireRecord(
                expectedDependencies[dependencyName],
                `protocol dependency ${dependencyName}`,
            );
            assertEqual(
                {
                    entryCount: actual.entryCount,
                    bytes: actual.bytes,
                    manifestSha256: actual.manifestSha256,
                },
                expected,
                `${schedule.id} ${label} dependency ${dependencyName}`,
            );
            const dependencyRoot = requireString(
                actual.root,
                `${schedule.id} ${label} ${dependencyName} dependency root`,
            );
            const dependencyRealRoot = requireString(
                actual.realRoot,
                `${schedule.id} ${label} ${dependencyName} dependency real root`,
            );
            assertEqual(
                realpathSync(dependencyRoot),
                dependencyRealRoot,
                `${schedule.id} ${label} ${dependencyName} dependency real root`,
            );
        }
        const resolutions = requireRecord(sourceReport.runtimeResolution, `${label} runtime resolution`);
        assertEqual(
            Object.keys(resolutions).sort(),
            ["denque", "google-protobuf"],
            `${schedule.id} ${label} resolution names`,
        );
        for (const dependencyName of ["denque", "google-protobuf"]) {
            const resolution = requireRecord(
                resolutions[dependencyName],
                `${schedule.id} ${label} ${dependencyName} resolution`,
            );
            const resolutionPath = requireString(
                resolution.resolvedPath,
                `${schedule.id} ${label} ${dependencyName} resolved path`,
            );
            const resolutionRealPath = requireString(
                resolution.realPath,
                `${schedule.id} ${label} ${dependencyName} real path`,
            );
            const dependencyRealRoot = requireString(
                requireRecord(actualDependencies[dependencyName], `${label} dependency ${dependencyName}`).realRoot,
                `${schedule.id} ${label} ${dependencyName} dependency real root`,
            );
            if (!pathIsWithin(resolutionRealPath, dependencyRealRoot)) {
                throw new Error(`${schedule.id} ${label} ${dependencyName} resolves outside its sealed root`);
            }
            assertEqual(
                realpathSync(resolutionPath),
                resolutionRealPath,
                `${schedule.id} ${label} ${dependencyName} resolution real path`,
            );
            assertEqual(
                resolution.withinSealedRoot,
                true,
                `${schedule.id} ${label} ${dependencyName} sealed resolution`,
            );
        }
    }
    const delta = requireRecord(source.delta, `${schedule.id} delta`);
    assertEqual(delta.exactExpected, true, `${schedule.id} exact delta`);
    assertEqual(delta.expected, EXPECTED_RUNTIME_DELTA_PATHS, `${schedule.id} expected runtime paths`);
    assertEqual(delta.actual, EXPECTED_RUNTIME_DELTA_PATHS, `${schedule.id} actual runtime paths`);
    assertEqual(delta.changedEntryCount, EXPECTED_RUNTIME_DELTA.length, `${schedule.id} changed source count`);
    assertEqual(delta.differences, EXPECTED_RUNTIME_DELTA, `${schedule.id} runtime hashes`);
    assertEqual(
        delta.manifestSha256,
        pairDigest(EXPECTED_RUNTIME_DELTA),
        `${schedule.id} runtime delta manifest arithmetic`,
    );
    const sharedInputs = requireRecord(source.sharedInputs, `${schedule.id} shared inputs`);
    assertEqual(sharedInputs, EXPECTED_SHARED_INPUTS, `${schedule.id} exact shared inputs`);

    const profile = requireRecord(report.profile, `${schedule.id} profile`);
    assertEqual(profile.crossRootExact, true, `${schedule.id} profile exact`);
    assertEqual(profile.baseline, profile.candidate, `${schedule.id} profile cross-root`);
    const profileIdentity = profile.baseline;

    const warmup = requireRecord(report.warmup, `${schedule.id} warmup`);
    assertEqual(warmup.passed, true, `${schedule.id} warmup passed`);
    assertEqual(warmup.discarded, true, `${schedule.id} warmup discarded`);
    const warmupRows = requireArray(warmup.rows, `${schedule.id} warmup rows`);
    if (warmupRows.length !== 4) throw new Error(`${schedule.id} must contain four warmups`);
    for (let index = 0; index < warmupRows.length; index++) {
        const row = requireRecord(warmupRows[index], `${schedule.id} warmup ${index}`);
        assertEqual(row.gridType, schedule.gridTypes[index], `${schedule.id} warmup grid`);
        const natural = index % 2 === 0 ? "AB" : "BA";
        const order = schedule.invertOrder ? (natural === "AB" ? "BA" : "AB") : natural;
        assertEqual(row.order, order, `${schedule.id} warmup order`);
        assertEqual(row.exact, true, `${schedule.id} warmup exact`);
        assertEqual(row.timingDiscarded, true, `${schedule.id} warmup discarded timing`);
        requireSha256(row.resultSha256, `${schedule.id} warmup result`);
        requireInteger(row.actions, `${schedule.id} warmup actions`, 1);
        if (!row.search) throw new Error(`${schedule.id} warmup lacks search telemetry`);
    }

    const work = requireRecord(report.work, `${schedule.id} work`);
    assertEqual(
        {
            captureId: work.captureId,
            protocolScheduleExact: work.protocolScheduleExact,
            serial: work.serial,
            measuredTasks: work.measuredTasks,
            measuredMatchesPerVariant: work.measuredMatchesPerVariant,
            measuredMatchesTotal: work.measuredMatchesTotal,
            warmupMatchesPerVariant: work.warmupMatchesPerVariant,
            configuredMaxLaps: work.configuredMaxLaps,
            abTasks: work.abTasks,
            baTasks: work.baTasks,
        },
        {
            captureId: schedule.id,
            protocolScheduleExact: true,
            serial: true,
            measuredTasks: TASKS_PER_CAPTURE,
            measuredMatchesPerVariant: TASKS_PER_CAPTURE,
            measuredMatchesTotal: TASKS_PER_CAPTURE * 2,
            warmupMatchesPerVariant: NATURAL_GRID_TYPES.length,
            configuredMaxLaps: expectedMaxLaps,
            abTasks: TASKS_PER_CAPTURE / 2,
            baTasks: TASKS_PER_CAPTURE / 2,
        },
        `${schedule.id} fixed work`,
    );

    const exactness = requireRecord(report.exactness, `${schedule.id} exactness`);
    assertEqual(
        {
            passed: exactness.passed,
            taskCount: exactness.taskCount,
            semanticMismatchCount: exactness.semanticMismatchCount,
            rejectedActions: exactness.rejectedActions,
            stuckMatches: exactness.stuckMatches,
            exceptions: exactness.exceptions,
        },
        {
            passed: true,
            taskCount: TASKS_PER_CAPTURE,
            semanticMismatchCount: 0,
            rejectedActions: 0,
            stuckMatches: 0,
            exceptions: 0,
        },
        `${schedule.id} exactness`,
    );
    const rowsRaw = requireArray(report.rows, `${schedule.id} rows`);
    if (rowsRaw.length !== TASKS_PER_CAPTURE) throw new Error(`${schedule.id} must contain 160 rows`);
    const rows: IValidatedRow[] = [];
    const semanticIdentityByTask = new Map<string, unknown>();
    let ordinal = 0;
    for (let seedIndex = 0; seedIndex < schedule.seeds.length; seedIndex++) {
        for (let gridIndex = 0; gridIndex < schedule.gridTypes.length; gridIndex++) {
            const raw = requireRecord(rowsRaw[ordinal], `${schedule.id} row ${ordinal}`);
            const seed = schedule.seeds[seedIndex];
            const gridType = schedule.gridTypes[gridIndex];
            const order = expectedOrder(schedule, seedIndex, gridIndex);
            assertEqual(raw.ordinal, ordinal, `${schedule.id} ordinal`);
            assertEqual(raw.seed, seed, `${schedule.id} seed`);
            assertEqual(raw.gridType, gridType, `${schedule.id} grid`);
            assertEqual(raw.order, order, `${schedule.id} order`);
            assertEqual(raw.exact, true, `${schedule.id} row exact`);
            const baselineNs = requirePositiveNumber(raw.baselineNs, `${schedule.id} baseline ns`);
            const candidateNs = requirePositiveNumber(raw.candidateNs, `${schedule.id} candidate ns`);
            const ratio = requirePositiveNumber(raw.ratio, `${schedule.id} ratio`);
            assertEqual(ratio, candidateNs / baselineNs, `${schedule.id} ratio arithmetic`);
            const semanticPairs = [
                ["resultSha256", "candidateResultSha256"],
                ["actionsSha256", "candidateActionsSha256"],
                ["placementsSha256", "candidatePlacementsSha256"],
                ["rosterSha256", "candidateRosterSha256"],
                ["endReason", "candidateEndReason"],
                ["baselineTotalActions", "candidateTotalActions"],
            ] as const;
            for (const [left, right] of semanticPairs) {
                assertPairEqual(raw[left], raw[right], `${schedule.id} row ${ordinal} ${left}`);
            }
            for (const key of ["resultSha256", "actionsSha256", "placementsSha256", "rosterSha256"] as const) {
                requireSha256(raw[key], `${schedule.id} row ${ordinal} ${key}`);
            }
            const semantics = {
                resultSha256: raw.resultSha256,
                actionsSha256: raw.actionsSha256,
                placementsSha256: raw.placementsSha256,
                rosterSha256: raw.rosterSha256,
                endReason: requireString(raw.endReason, `${schedule.id} end reason`),
                totalActions: requireInteger(raw.baselineTotalActions, `${schedule.id} actions`, 1),
            };
            const key = taskKey(seed, gridType);
            if (semanticIdentityByTask.has(key)) throw new Error(`${schedule.id} duplicate task ${key}`);
            semanticIdentityByTask.set(key, semantics);
            rows.push({ order, seed, gridType, baselineNs, candidateNs, ratio, semantics });
            ordinal++;
        }
    }
    const semanticRows = rows.map((row) => ({
        seed: row.seed,
        gridType: row.gridType,
        resultSha256: row.semantics.resultSha256,
        actionsSha256: row.semantics.actionsSha256,
        placementsSha256: row.semantics.placementsSha256,
        rosterSha256: row.semantics.rosterSha256,
        endReason: row.semantics.endReason,
        totalActions: row.semantics.totalActions,
    }));
    assertEqual(exactness.rowsSha256, pairDigest(semanticRows), `${schedule.id} exactness rows digest`);
    assertEqual(
        exactness.canonicalEncodingSchema,
        "heroes-of-crypto/type-tagged-canonical-value/v1",
        `${schedule.id} canonical encoding schema`,
    );
    assertEqual(
        exactness.comparedCanonicalPayloadStringsBeforeHashing,
        true,
        `${schedule.id} canonical semantic comparison`,
    );
    const qualification = requireRecord(report.qualification, `${schedule.id} qualification`);
    assertEqual(qualification.eligible, false, `${schedule.id} standalone eligibility`);
    assertEqual(qualification.passed, false, `${schedule.id} standalone qualification`);
    return {
        id: schedule.id,
        file,
        schedule,
        report,
        rows,
        rowsByTask: new Map(rows.map((row) => [taskKey(row.seed, row.gridType), row])),
        sourceIdentity: {
            baseline: baselineBefore.identitySha256,
            candidate: candidateBefore.identitySha256,
            delta: delta.manifestSha256,
        },
        profileIdentity,
        hostIdentity,
        semanticIdentityByTask,
    };
}

function makeDeterministicRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function microRatioOfTotals(rows: readonly IMicroBlock[], workload: string): number {
    const legacy = sum(rows.map((row) => row.workloads[workload].legacy.durationNs));
    const candidate = sum(rows.map((row) => row.workloads[workload].candidate.durationNs));
    if (legacy <= 0 || candidate <= 0) throw new Error(`micro ${workload} has invalid duration totals`);
    return candidate / legacy;
}

function microBootstrapRatio(
    rows: readonly IMicroBlock[],
    workload: string,
    workloadIndex: number,
): { lower95: number; median: number; upper95: number; samples: number } {
    const superblocks = Array.from({ length: rows.length / MICRO_SUPERBLOCK_SIZE }, (_, index) =>
        rows.slice(index * MICRO_SUPERBLOCK_SIZE, (index + 1) * MICRO_SUPERBLOCK_SIZE),
    );
    const random = makeDeterministicRandom(MICRO_BOOTSTRAP_SEED ^ Math.imul(workloadIndex + 1, 0x45d9_f3b));
    const estimates = Array.from({ length: MICRO_BOOTSTRAP_SAMPLES }, () => {
        const sample = Array.from(
            { length: superblocks.length },
            () => superblocks[Math.floor(random() * superblocks.length)],
        ).flat();
        return microRatioOfTotals(sample, workload);
    });
    return {
        lower95: quantile(estimates, 0.025),
        median: quantile(estimates, 0.5),
        upper95: quantile(estimates, 0.975),
        samples: MICRO_BOOTSTRAP_SAMPLES,
    };
}

function validateMicro(path: string, protocol: Record<string, unknown>): IValidatedMicro {
    const file = fileSeal(path);
    const report = readJsonObject(path, "micro report");
    const microRunner = requireRecord(protocol.microRunner, "protocol micro runner");
    assertEqual(report.schema, microRunner.schema, "micro schema");
    assertEqual(report.mode, "evidence", "micro mode");
    requireUuidV4(report.attemptId, "micro attempt ID");

    const protocolReport = requireRecord(report.protocol, "micro protocol");
    const microQuantileBinding = requireRecord(protocolReport.quantile, "micro shared quantile binding");
    assertEqual(microQuantileBinding.schema, TYPE7_QUANTILE_SCHEMA, "micro shared quantile schema");
    assertEqual(
        microQuantileBinding.sharedProducerVerifierImplementation,
        true,
        "micro shared producer/verifier quantile",
    );
    assertEqual(microQuantileBinding.audit, auditType7Quantile(), "micro shared quantile audit");
    const correctnessProtocol = requireRecord(protocolReport.correctness, "micro correctness protocol");
    assertEqual(correctnessProtocol.rawFloat64Patterns, 1_000_000, "micro raw patterns protocol");
    assertEqual(correctnessProtocol.comparisonsPerRawPattern, 2, "micro comparisons per pattern");
    const timing = requireRecord(protocolReport.timing, "micro timing protocol");
    assertEqual(
        {
            evidenceBlocks: timing.evidenceBlocks,
            blocks: timing.blocks,
            schedule: timing.schedule,
            candidateFirstBlocks: timing.candidateFirstBlocks,
            legacyFirstBlocks: timing.legacyFirstBlocks,
            targetMinimumMillisecondsPerArmBlock: timing.targetMinimumMillisecondsPerArmBlock,
            minimumRequiredMillisecondsPerTimedArmBlock: timing.minimumRequiredMillisecondsPerTimedArmBlock,
            checksumsAndOperationCountsMustMatch: timing.checksumsAndOperationCountsMustMatch,
        },
        {
            evidenceBlocks: MICRO_BLOCKS,
            blocks: MICRO_BLOCKS,
            schedule: MICRO_ARM_ORDERS,
            candidateFirstBlocks: MICRO_BLOCKS / 2,
            legacyFirstBlocks: MICRO_BLOCKS / 2,
            targetMinimumMillisecondsPerArmBlock: MICRO_TARGET_MS,
            minimumRequiredMillisecondsPerTimedArmBlock: MICRO_TIMED_ARM_FLOOR_MS,
            checksumsAndOperationCountsMustMatch: true,
        },
        "micro timing protocol",
    );
    if (
        requireFiniteNumber(timing.minimumObservedMillisecondsPerTimedArmBlock, "micro minimum observed timed arm") <
        MICRO_TIMED_ARM_FLOOR_MS
    ) {
        throw new Error("micro timed-arm floor was not met");
    }
    const bootstrapProtocol = requireRecord(protocolReport.bootstrap, "micro bootstrap protocol");
    assertEqual(
        {
            blocksPerSuperblock: bootstrapProtocol.blocksPerSuperblock,
            superblocks: bootstrapProtocol.superblocks,
            samples: bootstrapProtocol.samples,
            seedHex: bootstrapProtocol.seedHex,
        },
        {
            blocksPerSuperblock: MICRO_SUPERBLOCK_SIZE,
            superblocks: MICRO_BLOCKS / MICRO_SUPERBLOCK_SIZE,
            samples: MICRO_BOOTSTRAP_SAMPLES,
            seedHex: `0x${MICRO_BOOTSTRAP_SEED.toString(16)}`,
        },
        "micro bootstrap protocol",
    );

    const source = requireRecord(report.source, "micro source");
    const microManifests = requireRecord(
        requireRecord(protocol.producerManifests, "protocol producer manifests").micro,
        "protocol micro manifests",
    );
    assertEqual(source.unchanged, true, "micro source unchanged");
    const sourceBefore = requireRecord(source.before, "micro source before");
    const sourceAfter = requireRecord(source.after, "micro source after");
    assertEqual(sourceAfter, sourceBefore, "micro source pre/post");
    assertEqual(
        requireRecord(sourceBefore.runner, "micro source runner").sha256,
        microRunner.sha256,
        "micro runner hash",
    );
    const microQuantileHelper = requireRecord(sourceBefore.quantileHelper, "micro quantile helper");
    assertEqual(microQuantileBinding.helper, microQuantileHelper, "micro protocol/source quantile helper");
    assertEqual(
        microQuantileHelper,
        {
            ...fileSeal(QUANTILE_HELPER_PATH),
            path: relative(COMMON_ROOT, QUANTILE_HELPER_PATH).split(sep).join("/"),
        },
        "micro quantile helper seal",
    );
    assertEqual(
        requireRecord(sourceBefore.source, "micro source manifest").manifestSha256,
        microManifests.candidateSrcManifestSha256,
        "micro source manifest",
    );
    assertEqual(
        requireRecord(sourceBefore.workspaceLock, "micro workspace lock").sha256,
        WORKSPACE_LOCK_SHA256,
        "micro workspace lock",
    );
    const { identitySha256: microIdentitySha256, ...microIdentityPayload } = sourceBefore;
    assertEqual(microIdentitySha256, microOrdinaryDigest(microIdentityPayload), "micro source identity arithmetic");
    assertEqual(resolve(requireString(sourceBefore.root, "micro source root")), COMMON_ROOT, "micro source root");
    assertEqual(
        requireString(sourceBefore.realRoot, "micro source real root"),
        realpathSync(COMMON_ROOT),
        "micro source real root",
    );
    assertEqual(
        resolve(requireString(sourceBefore.workspaceRoot, "micro workspace root")),
        resolve(COMMON_ROOT, "../.."),
        "micro workspace root",
    );
    assertEqual(
        {
            packageJson: requireRecord(sourceBefore.packageJson, "micro package").sha256,
            tsconfigJson: requireRecord(sourceBefore.tsconfigJson, "micro tsconfig").sha256,
            bunfigToml: requireRecord(sourceBefore.bunfigToml, "micro bunfig").sha256,
            workspaceLock: requireRecord(sourceBefore.workspaceLock, "micro workspace lock").sha256,
            bunExecutable: requireRecord(sourceBefore.bunExecutable, "micro Bun executable").sha256,
        },
        {
            packageJson: PACKAGE_JSON_SHA256,
            tsconfigJson: TSCONFIG_JSON_SHA256,
            bunfigToml: BUNFIG_TOML_SHA256,
            workspaceLock: WORKSPACE_LOCK_SHA256,
            bunExecutable: PINNED_BUN_EXECUTABLE_SHA256,
        },
        "micro pinned runtime input files",
    );
    assertEqual(sourceBefore.bunExecutable, fileSeal(process.execPath), "micro Bun executable seal");
    const microDependencies = requireRecord(sourceBefore.runtimeDependencies, "micro runtime dependencies");
    const microResolutions = requireRecord(sourceBefore.runtimeResolution, "micro runtime resolutions");
    const expectedMicroDependencies = requireRecord(
        microManifests.runtimeDependencies,
        "protocol micro runtime dependencies",
    );
    assertEqual(Object.keys(microDependencies).sort(), ["denque", "google-protobuf"], "micro dependency names");
    assertEqual(Object.keys(microResolutions).sort(), ["denque", "google-protobuf"], "micro resolution names");
    for (const dependencyName of ["denque", "google-protobuf"] as const) {
        const dependency = requireRecord(microDependencies[dependencyName], `micro ${dependencyName} dependency`);
        assertEqual(
            {
                entryCount: dependency.entryCount,
                bytes: dependency.bytes,
                manifestSha256: dependency.manifestSha256,
            },
            expectedMicroDependencies[dependencyName],
            `micro ${dependencyName} dependency identity`,
        );
        assertEqual(dependency.manifestCodec, MICRO_MANIFEST_CODEC, `micro ${dependencyName} manifest codec`);
        const dependencyRoot = requireString(dependency.root, `micro ${dependencyName} dependency root`);
        const dependencyRealRoot = requireString(dependency.realRoot, `micro ${dependencyName} dependency real root`);
        assertEqual(
            resolve(dependencyRoot),
            join(COMMON_ROOT, "node_modules", dependencyName),
            `micro ${dependencyName} dependency root`,
        );
        assertEqual(dependencyRealRoot, realpathSync(dependencyRoot), `micro ${dependencyName} dependency real root`);
        const resolution = requireRecord(microResolutions[dependencyName], `micro ${dependencyName} resolution`);
        const resolvedPath = requireString(resolution.resolvedPath, `micro ${dependencyName} resolved path`);
        const resolvedRealPath = requireString(resolution.realPath, `micro ${dependencyName} resolved real path`);
        assertEqual(realpathSync(resolvedPath), resolvedRealPath, `micro ${dependencyName} resolution real path`);
        if (!pathIsWithin(resolvedRealPath, dependencyRealRoot)) {
            throw new Error(`micro ${dependencyName} resolves outside its sealed dependency root`);
        }
        assertEqual(resolution.withinSealedRoot, true, `micro ${dependencyName} resolution containment`);
    }
    const microDependencyEnvelope = requireRecord(sourceBefore.dependencies, "micro dependency envelope");
    assertEqual(microDependencyEnvelope.recursivelySealed, true, "micro recursive dependency seal");
    assertEqual(microDependencyEnvelope.manifestCodec, MICRO_MANIFEST_CODEC, "micro dependency manifest codec");
    requireString(microDependencyEnvelope.commonNodeModulesRealPath, "micro common node_modules");
    requireString(microDependencyEnvelope.workspaceNodeModulesRealPath, "micro workspace node_modules");
    requireString(microDependencyEnvelope.limitation, "micro dependency limitation");
    const frozenRuntimeInputs = requireRecord(source.frozenRuntimeInputs, "micro frozen runtime inputs");
    assertEqual(frozenRuntimeInputs.unchanged, true, "micro frozen runtime inputs unchanged");
    assertEqual(frozenRuntimeInputs.before, frozenRuntimeInputs.after, "micro frozen runtime inputs pre/post");
    const frozenRuntimeBefore = requireRecord(frozenRuntimeInputs.before, "micro frozen runtime inputs before");
    assertEqual(frozenRuntimeBefore.passed, true, "micro frozen runtime inputs passed");
    assertEqual(
        frozenRuntimeBefore.expected,
        {
            packageJsonSha256: PACKAGE_JSON_SHA256,
            tsconfigJsonSha256: TSCONFIG_JSON_SHA256,
            bunfigTomlSha256: BUNFIG_TOML_SHA256,
            workspaceLockSha256: WORKSPACE_LOCK_SHA256,
            bunExecutableSha256: PINNED_BUN_EXECUTABLE_SHA256,
        },
        "micro expected runtime inputs",
    );
    assertEqual(frozenRuntimeBefore.expected, frozenRuntimeBefore.observed, "micro observed runtime inputs");
    assertEqual(frozenRuntimeBefore.manifestCodec, MICRO_MANIFEST_CODEC, "micro runtime manifest codec");
    const microBunConfiguration = requireRecord(source.bunConfiguration, "micro Bun configuration");
    assertEqual(microBunConfiguration.unchanged, true, "micro Bun configuration unchanged");
    assertEqual(microBunConfiguration.before, microBunConfiguration.after, "micro Bun configuration pre/post");
    const microBunConfigBefore = requireRecord(microBunConfiguration.before, "micro Bun configuration before");
    assertEqual(microBunConfigBefore.passed, true, "micro Bun configuration passed");
    assertEqual(microBunConfigBefore.present, [], "micro forbidden Bun configuration files");
    const frozenCandidate = requireRecord(source.frozenCandidateIdentity, "micro frozen candidate");
    assertEqual(frozenCandidate.unchanged, true, "micro frozen candidate unchanged");
    const frozenBefore = requireRecord(frozenCandidate.before, "micro frozen candidate before");
    const frozenAfter = requireRecord(frozenCandidate.after, "micro frozen candidate after");
    assertEqual(frozenAfter, frozenBefore, "micro frozen candidate pre/post");
    assertEqual(frozenBefore.passed, true, "micro frozen candidate passed");
    assertEqual(frozenBefore.expectedCandidateCommit, CANDIDATE_COMMIT, "micro candidate commit");
    assertEqual(frozenBefore.resolvedExpectedCommit, CANDIDATE_COMMIT, "micro resolved candidate commit");
    assertEqual(frozenBefore.expectedSrcManifestSha256, MICRO_SOURCE_MANIFEST_SHA256, "micro expected manifest");
    assertEqual(frozenBefore.observedSrcManifestSha256, MICRO_SOURCE_MANIFEST_SHA256, "micro observed manifest");
    const microRuntime = requireRecord(report.runtime, "micro runtime");
    assertEqual(microRuntime.bunRevision, PINNED_BUN_REVISION, "micro Bun revision");
    assertEqual(microRuntime.bunExecutableSha256, PINNED_BUN_EXECUTABLE_SHA256, "micro Bun executable identity");

    const realm = requireRecord(report.realm, "micro realm");
    assertEqual(realm.preloadHooksAbsent, true, "micro preload hooks");
    const microInjection = requireRecord(realm.runtimeInjection, "micro runtime injection envelope");
    assertEqual(microInjection.unchanged, true, "micro runtime injection unchanged");
    assertEqual(microInjection.before, microInjection.after, "micro runtime injection pre/post");
    validateInjection(
        microInjection.before,
        "micro runtime injection",
        EXPECTED_PAIR_FORBIDDEN_ENVIRONMENT_KEYS,
        EXPECTED_MICRO_FORBIDDEN_ENVIRONMENT_PREFIXES,
    );
    assertEqual(realm.unchanged, true, "micro realm unchanged");
    assertEqual(realm.before, realm.after, "micro realm pre/post");
    validateRealmAudit(realm.before, "micro realm audit", EXPECTED_PAIR_FUNCTION_AUDIT);

    const correctness = requireRecord(report.correctness, "micro correctness");
    assertEqual(correctness.passed, true, "micro correctness passed");
    const raw = requireRecord(correctness.rawFloat64, "micro raw correctness");
    assertEqual(
        {
            passed: raw.passed,
            patterns: raw.patterns,
            digitsPerPattern: raw.digitsPerPattern,
            comparisons: raw.comparisons,
        },
        { passed: true, patterns: 1_000_000, digitsPerPattern: [1, 2], comparisons: 2_000_000 },
        "micro raw correctness",
    );
    const curated = requireRecord(correctness.curated, "micro curated correctness");
    assertEqual(curated.passed, true, "micro curated correctness passed");
    requireInteger(curated.comparisons, "micro curated comparisons", 1);
    const nearGrid = requireRecord(correctness.nearGrid, "micro near-grid correctness");
    assertEqual(nearGrid.passed, true, "micro near-grid correctness passed");
    requireInteger(nearGrid.comparisons, "micro near-grid comparisons", 1);
    assertEqual(
        nearGrid.predicate,
        {
            scaledLowerExclusive: -(2 ** 30),
            scaledUpperExclusive: 2 ** 30,
            distanceLowerExclusive: -0.25,
            distanceUpperExclusive: 0.25,
            exactGridEvaluatedFirst: true,
            signedZeroPolicy:
                "exact -0 normalizes to +0; an admitted negative near-grid value whose nearest integer is zero returns -0",
        },
        "micro strict near-grid predicate",
    );
    const nearGridClassifications = requireRecord(
        nearGrid.independentlyClassified,
        "micro near-grid independent classifications",
    );
    requireInteger(nearGridClassifications.exactGrid, "micro near-grid exact classifications");
    requireInteger(nearGridClassifications.nearGrid, "micro near-grid fast classifications", 1);
    requireInteger(nearGridClassifications.numericFallback, "micro near-grid fallback classifications", 1);
    assertEqual(nearGrid.expectedNegativeZero, nearGrid.observedNegativeZero, "micro near-grid signed-zero parity");
    requireInteger(nearGrid.expectedNegativeZero, "micro near-grid signed-zero cases", 1);
    const dynamic = requireRecord(correctness.dynamicMutationAndBoxedFallback, "micro dynamic correctness");
    assertEqual(dynamic.passed, true, "micro dynamic correctness passed");
    assertEqual(dynamic.deliberatelyUntimed, true, "micro dynamic correctness timing");
    const trace = requireRecord(correctness.actualRepresentativeStatTrace, "micro representative trace");
    assertEqual(trace.passed, true, "micro representative trace passed");
    assertEqual(trace.missingContexts, [], "micro representative missing contexts");
    const traceEntries = requireInteger(trace.entries, "micro representative trace entries", 1);
    assertEqual(correctness.actualTraceComparisons, traceEntries, "micro trace comparisons");

    const warmup = requireRecord(report.warmup, "micro warmup");
    assertEqual(warmup.targetMilliseconds, MICRO_WARMUP_MS, "micro warmup target");
    if (requirePositiveNumber(warmup.actualMilliseconds, "micro warmup actual") < MICRO_WARMUP_MS) {
        throw new Error("micro warmup was shorter than preregistered");
    }
    requireInteger(warmup.balancedRounds, "micro warmup rounds", 1);

    const rawBlocks = requireArray(report.rawBlocks, "micro raw blocks");
    if (rawBlocks.length !== MICRO_BLOCKS) throw new Error("micro must contain exactly 60 raw blocks");
    const blocks: IMicroBlock[] = rawBlocks.map((rawBlock, blockIndex) => {
        const block = requireRecord(rawBlock, `micro block ${blockIndex}`);
        const expectedArmOrder = MICRO_ARM_ORDERS[blockIndex % MICRO_SUPERBLOCK_SIZE];
        const expectedWorkloadOrder =
            blockIndex % 2 === 0 ? ["exactGrid", "actualTrace"] : ["actualTrace", "exactGrid"];
        assertEqual(block.block, blockIndex, `micro block ${blockIndex} ordinal`);
        assertEqual(block.armOrder, expectedArmOrder, `micro block ${blockIndex} arm order`);
        assertEqual(block.workloadOrder, expectedWorkloadOrder, `micro block ${blockIndex} workload order`);
        const workloads = requireRecord(block.workloads, `micro block ${blockIndex} workloads`);
        const parsedWorkloads: Record<string, Record<string, IMicroMeasurement>> = {};
        for (const workload of ["exactGrid", "actualTrace"]) {
            const arms = requireRecord(workloads[workload], `micro block ${blockIndex} ${workload}`);
            const parsedArms: Record<string, IMicroMeasurement> = {};
            for (const arm of ["legacy", "candidate"]) {
                const measurement = requireRecord(arms[arm], `micro block ${blockIndex} ${workload} ${arm}`);
                const durationNs = requireInteger(
                    measurement.durationNs,
                    `micro block ${blockIndex} ${workload} ${arm} duration`,
                    1,
                );
                const operations = requireInteger(
                    measurement.operations,
                    `micro block ${blockIndex} ${workload} ${arm} operations`,
                    1,
                );
                const nanosecondsPerOperation = requirePositiveNumber(
                    measurement.nanosecondsPerOperation,
                    `micro block ${blockIndex} ${workload} ${arm} ns/op`,
                );
                assertEqual(
                    nanosecondsPerOperation,
                    durationNs / operations,
                    `micro block ${blockIndex} ${workload} ${arm} ns/op arithmetic`,
                );
                if (durationNs < MICRO_TIMED_ARM_FLOOR_MS * 1_000_000) {
                    throw new Error(`micro block ${blockIndex} ${workload} ${arm} is below timing floor`);
                }
                parsedArms[arm] = {
                    durationNs,
                    operations,
                    nanosecondsPerOperation,
                    checksum: requireFiniteNumber(
                        measurement.checksum,
                        `micro block ${blockIndex} ${workload} ${arm} checksum`,
                    ),
                };
            }
            assertEqual(
                parsedArms.legacy.operations,
                parsedArms.candidate.operations,
                `micro block ${blockIndex} ${workload} operation parity`,
            );
            assertEqual(
                parsedArms.legacy.checksum,
                parsedArms.candidate.checksum,
                `micro block ${blockIndex} ${workload} checksum parity`,
            );
            parsedWorkloads[workload] = parsedArms;
        }
        return {
            block: blockIndex,
            armOrder: [...expectedArmOrder],
            workloadOrder: expectedWorkloadOrder,
            workloads: parsedWorkloads,
        };
    });

    const performance = requireRecord(report.performance, "micro performance");
    const intervals: Record<string, { lower95: number; median: number; upper95: number; samples: number }> = {};
    for (const [workload, index] of [
        ["exactGrid", 0],
        ["actualTrace", 1],
    ] as const) {
        const workloadPerformance = requireRecord(performance[workload], `micro ${workload} performance`);
        const point = requireRecord(workloadPerformance.point, `micro ${workload} point`);
        assertEqual(point.ratioOfTotals, microRatioOfTotals(blocks, workload), `micro ${workload} ratio of totals`);
        const computed = microBootstrapRatio(blocks, workload, index);
        assertEqual(workloadPerformance.ratioOfTotalsBootstrap95, computed, `micro ${workload} bootstrap`);
        intervals[workload] = computed;
    }
    const gates = requireRecord(report.gates, "micro gates");
    const exactGridPassed = intervals.exactGrid.upper95 <= MICRO_EXACT_GRID_UPPER_95_GATE;
    const actualTracePassed = intervals.actualTrace.upper95 <= MICRO_ACTUAL_TRACE_UPPER_95_GATE;
    if (!exactGridPassed || !actualTracePassed) throw new Error("micro prerequisite performance gates failed");
    const exactGridGate = requireRecord(gates.exactGrid, "micro exact-grid gate");
    const actualTraceGate = requireRecord(gates.actualTrace, "micro actual-trace gate");
    assertEqual(
        {
            thresholdInclusive: exactGridGate.thresholdInclusive,
            observedUpper95: exactGridGate.observedUpper95,
            passed: exactGridGate.passed,
        },
        {
            thresholdInclusive: MICRO_EXACT_GRID_UPPER_95_GATE,
            observedUpper95: intervals.exactGrid.upper95,
            passed: true,
        },
        "micro exact-grid gate",
    );
    assertEqual(
        {
            thresholdInclusive: actualTraceGate.thresholdInclusive,
            observedUpper95: actualTraceGate.observedUpper95,
            passed: actualTraceGate.passed,
        },
        {
            thresholdInclusive: MICRO_ACTUAL_TRACE_UPPER_95_GATE,
            observedUpper95: intervals.actualTrace.upper95,
            passed: true,
        },
        "micro actual-trace gate",
    );
    assertEqual(gates.measurementPassed, true, "micro measurement gates");
    assertEqual(gates.qualified, true, "micro qualification");
    assertEqual(gates.smokeNeverQualifies, false, "micro smoke flag");

    return {
        file,
        report,
        hostIdentity: validateHost(microRuntime, "micro runtime"),
        sourceIdentity: sourceBefore.identitySha256,
        gates: {
            exactGridUpper95: intervals.exactGrid.upper95,
            actualTraceUpper95: intervals.actualTrace.upper95,
            passed: true,
        },
    };
}

function validateProfileSourceSeal(
    value: unknown,
    variant: "baseline" | "candidate",
    protocol: Record<string, unknown>,
): Record<string, unknown> {
    const seal = requireRecord(value, `profile ${variant} source seal`);
    const sourceRoot = resolve(requireString(seal.root, `profile ${variant} source root`));
    assertEqual(seal.realRoot, realpathSync(sourceRoot), `profile ${variant} source real root`);
    const profileManifests = requireRecord(
        requireRecord(protocol.producerManifests, "protocol producer manifests").profile,
        "protocol profile manifests",
    );
    assertEqual(
        seal.srcManifestSha256,
        variant === "baseline"
            ? profileManifests.baselineSrcManifestSha256
            : profileManifests.candidateSrcManifestSha256,
        `profile ${variant} source manifest`,
    );
    const expectedCommit = variant === "baseline" ? BASELINE_COMMIT : CANDIDATE_COMMIT;
    const gitHead = requireString(seal.gitHead, `profile ${variant} git head`);
    if (gitHead !== expectedCommit && gitHead !== "unavailable-source-root-without-git-metadata") {
        throw new Error(`profile ${variant} git head is not the frozen commit`);
    }
    const profileRunner = requireRecord(protocol.profileRunner, "protocol profile runner");
    assertEqual(seal.runnerSha256, profileRunner.sha256, `profile ${variant} runner hash`);
    const selected = requireRecord(seal.selectedSha256, `profile ${variant} selected source`);
    assertEqual(selected["package.json"], PACKAGE_JSON_SHA256, `profile ${variant} package hash`);
    assertEqual(
        requireRecord(seal.tsconfigJson, `profile ${variant} tsconfig`).sha256,
        requireRecord(protocol.dependencyInputs, "protocol dependencies").tsconfigJsonSha256,
        `profile ${variant} tsconfig hash`,
    );
    assertEqual(
        requireRecord(seal.bunfigToml, `profile ${variant} bunfig`).sha256,
        BUNFIG_TOML_SHA256,
        `profile ${variant} bunfig hash`,
    );
    assertEqual(
        requireRecord(seal.workspaceLock, `profile ${variant} lock`).sha256,
        WORKSPACE_LOCK_SHA256,
        `profile ${variant} lock hash`,
    );
    const dependencies = requireRecord(seal.runtimeDependencies, `profile ${variant} dependencies`);
    assertEqual(Object.keys(dependencies).sort(), ["denque", "google-protobuf"], `profile ${variant} dependency names`);
    const expectedProfileDependencies = requireRecord(
        profileManifests.runtimeDependencies,
        "protocol profile runtime dependencies",
    );
    for (const name of ["denque", "google-protobuf"]) {
        const actual = requireRecord(dependencies[name], `profile ${variant} dependency ${name}`);
        const expected = requireRecord(expectedProfileDependencies[name], `protocol profile dependency ${name}`);
        assertEqual(
            {
                entryCount: actual.entryCount,
                bytes: actual.bytes,
                manifestSha256: actual.manifestSha256,
            },
            expected,
            `profile ${variant} dependency ${name}`,
        );
        const dependencyRoot = requireString(actual.root, `profile ${variant} ${name} dependency root`);
        assertEqual(
            resolve(dependencyRoot),
            join(sourceRoot, "node_modules", name),
            `profile ${variant} ${name} dependency root`,
        );
        assertEqual(actual.realRoot, realpathSync(dependencyRoot), `profile ${variant} ${name} dependency real root`);
    }
    assertEqual(
        requireRecord(seal.bunExecutable, `profile ${variant} Bun executable`).sha256,
        requireRecord(protocol.dependencyInputs, "protocol dependencies").bunExecutableSha256,
        `profile ${variant} Bun executable`,
    );
    assertEqual(seal.bunExecutable, fileSeal(process.execPath), `profile ${variant} Bun executable seal`);
    const { identitySha256, ...identityPayload } = seal;
    assertEqual(identitySha256, profileIdentityDigest(identityPayload), `profile ${variant} identity arithmetic`);
    return seal;
}

function requireGatePassed(value: unknown, label: string): Record<string, unknown> {
    const gate = requireRecord(value, label);
    assertEqual(gate.passed, true, `${label} passed`);
    return gate;
}

function validateProfile(
    path: string,
    profileDirectoryInput: string,
    protocol: Record<string, unknown>,
): IValidatedProfile {
    const file = fileSeal(path);
    const report = readJsonObject(path, "profile report");
    const profileRunner = requireRecord(protocol.profileRunner, "protocol profile runner");
    assertEqual(report.schema, profileRunner.schema, "profile schema");
    assertEqual(report.mode, "evidence", "profile mode");
    const profileAttemptId = requireUuidV4(report.attemptId, "profile attempt ID");
    const profileRuntime = requireRecord(report.runtime, "profile runtime");
    assertEqual(
        profileRuntime.requiredExecutionEnvironment,
        REQUIRED_RUNTIME_ENVIRONMENT,
        "profile required runtime environment",
    );
    assertEqual(profileRuntime.governedEnvironment, REQUIRED_RUNTIME_ENVIRONMENT, "profile governed environment");
    assertEqual(
        resolve(requireString(profileRuntime.execPath, "profile Bun executable path")),
        process.execPath,
        "profile Bun path",
    );
    requireInteger(profileRuntime.pid, "profile process ID", 1);

    const profileProtocol = requireRecord(report.protocol, "profile protocol");
    assertEqual(profileProtocol.aiVersion, "v0.8", "profile AI version");
    assertEqual(profileProtocol.mirror, true, "profile mirror work");
    const immutableRoots = requireRecord(profileProtocol.immutableRoots, "profile immutable roots");
    const profileProducerManifests = requireRecord(
        requireRecord(protocol.producerManifests, "protocol producer manifests").profile,
        "protocol profile producer manifests",
    );
    assertEqual(immutableRoots.baselineCommit, BASELINE_COMMIT, "profile baseline commit");
    assertEqual(
        immutableRoots.baselineSrcManifestSha256,
        profileProducerManifests.baselineSrcManifestSha256,
        "profile baseline manifest",
    );
    assertEqual(immutableRoots.candidateCommit, CANDIDATE_COMMIT, "profile candidate commit");
    assertEqual(
        immutableRoots.candidateSrcManifestSha256,
        profileProducerManifests.candidateSrcManifestSha256,
        "profile candidate manifest",
    );
    const measured = requireRecord(profileProtocol.measured, "profile measured protocol");
    assertEqual(
        {
            seeds: measured.seeds,
            maxLaps: measured.maxLaps,
            repeatsPerCapture: measured.repeatsPerCapture,
            capturesPerVariant: measured.capturesPerVariant,
            totalCaptures: measured.totalCaptures,
            matchesPerCapture: measured.matchesPerCapture,
            profilerIntervalMicroseconds: measured.profilerIntervalMicroseconds,
        },
        {
            seeds: PROFILE_SEEDS,
            maxLaps: PROFILE_MAX_LAPS,
            repeatsPerCapture: PROFILE_REPEATS_PER_CAPTURE,
            capturesPerVariant: PROFILE_CAPTURES_PER_VARIANT,
            totalCaptures: PROFILE_CAPTURES_PER_VARIANT * 2,
            matchesPerCapture: PROFILE_SEEDS.length * PROFILE_REPEATS_PER_CAPTURE,
            profilerIntervalMicroseconds: PROFILE_INTERVAL_US,
        },
        "profile fixed measured work",
    );
    assertEqual(
        measured.captureVariantOrder,
        [
            { capture: 1, order: ["baseline", "candidate"] },
            { capture: 2, order: ["candidate", "baseline"] },
            { capture: 3, order: ["candidate", "baseline"] },
            { capture: 4, order: ["baseline", "candidate"] },
        ],
        "profile capture order",
    );

    const source = requireRecord(report.source, "profile source");
    assertEqual(source.unchanged, true, "profile source unchanged");
    const before = requireRecord(source.before, "profile source before");
    const after = requireRecord(source.after, "profile source after");
    assertEqual(after, before, "profile source pre/post");
    const baselineSource = validateProfileSourceSeal(before.baseline, "baseline", protocol);
    const candidateSource = validateProfileSourceSeal(before.candidate, "candidate", protocol);
    const preflight = requireRecord(source.crossRootInputPreflight, "profile cross-root preflight");
    assertEqual(preflight.passed, true, "profile cross-root preflight passed");
    assertEqual(preflight.packageJsonSha256, PACKAGE_JSON_SHA256, "profile preflight package");
    assertEqual(preflight.bunfigTomlSha256, BUNFIG_TOML_SHA256, "profile preflight bunfig");
    assertEqual(preflight.workspaceLockSha256, WORKSPACE_LOCK_SHA256, "profile preflight lock");
    const delta = requireRecord(source.delta, "profile delta");
    assertEqual(delta.exactExpected, true, "profile exact delta");
    assertEqual(delta.expected, EXPECTED_RUNTIME_DELTA_PATHS, "profile expected runtime delta");
    assertEqual(delta.actual, EXPECTED_RUNTIME_DELTA_PATHS, "profile actual runtime delta");
    assertEqual(delta.differences, EXPECTED_RUNTIME_DELTA, "profile runtime delta");
    assertEqual(
        delta.manifestSha256,
        profileIdentityDigest(EXPECTED_RUNTIME_DELTA),
        "profile runtime delta manifest arithmetic",
    );

    const realm = requireRecord(report.realm, "profile realm");
    assertEqual(realm.preloadHooksAbsent, true, "profile preload hooks");
    const parentInjection = requireRecord(realm.parentRuntimeInjection, "profile parent injection envelope");
    assertEqual(parentInjection.unchanged, true, "profile parent injection unchanged");
    assertEqual(parentInjection.before, parentInjection.after, "profile parent injection pre/post");
    validateInjection(parentInjection.before, "profile parent runtime injection");
    assertEqual(realm.parentUnchanged, true, "profile parent realm unchanged");
    assertEqual(realm.parentBefore, realm.parentAfter, "profile parent realm pre/post");
    validateRealmAudit(realm.parentBefore, "profile parent realm");
    assertEqual(realm.childEvidencePassed, true, "profile child realm evidence");

    const semantic = requireRecord(report.semantic, "profile semantics");
    assertEqual(
        {
            repeatsCompared: semantic.repeatsCompared,
            capturesCompared: semantic.capturesCompared,
            variantsCompared: semantic.variantsCompared,
            identicalAcrossRepeatsCapturesAndVariants: semantic.identicalAcrossRepeatsCapturesAndVariants,
            warmupsIdenticalAcrossCapturesAndVariants: semantic.warmupsIdenticalAcrossCapturesAndVariants,
            instrumentedTelemetryTraceIdenticalToUninstrumented:
                semantic.instrumentedTelemetryTraceIdenticalToUninstrumented,
            rejected: semantic.rejected,
            stuck: semantic.stuck,
        },
        {
            repeatsCompared: PROFILE_REPEATS_PER_CAPTURE * PROFILE_CAPTURES_PER_VARIANT * 2,
            capturesCompared: PROFILE_CAPTURES_PER_VARIANT * 2,
            variantsCompared: ["baseline", "candidate"],
            identicalAcrossRepeatsCapturesAndVariants: true,
            warmupsIdenticalAcrossCapturesAndVariants: true,
            instrumentedTelemetryTraceIdenticalToUninstrumented: true,
            rejected: 0,
            stuck: 0,
        },
        "profile exact semantics",
    );
    const actionDigest = requireSha256(semantic.actionDigest, "profile action digest");
    const resultDigest = requireSha256(semantic.resultDigest, "profile result digest");
    const warmupActionDigest = requireSha256(semantic.warmupActionDigest, "profile warmup action digest");
    const warmupResultDigest = requireSha256(semantic.warmupResultDigest, "profile warmup result digest");

    const telemetry = requireRecord(report.telemetry, "profile telemetry");
    const telemetryByVariant = {
        baseline: requireRecord(telemetry.baseline, "profile baseline telemetry"),
        candidate: requireRecord(telemetry.candidate, "profile candidate telemetry"),
    };
    for (const variant of ["baseline", "candidate"] as const) {
        const item = telemetryByVariant[variant];
        assertEqual(item.schema, PROFILE_TELEMETRY_SCHEMA, `profile ${variant} telemetry schema`);
        assertEqual(item.attemptId, profileAttemptId, `profile ${variant} telemetry attempt ID`);
        assertEqual(item.variant, variant, `profile ${variant} telemetry variant`);
        assertEqual(item.sourceUnchanged, true, `profile ${variant} telemetry source unchanged`);
        assertEqual(item.sourceAfter, item.sourceBefore, `profile ${variant} telemetry source pre/post`);
        validateProfileSourceSeal(item.sourceBefore, variant, protocol);
        const childRealm = requireRecord(item.realm, `profile ${variant} telemetry realm`);
        assertEqual(childRealm.unchanged, true, `profile ${variant} telemetry realm unchanged`);
        assertEqual(childRealm.before, childRealm.after, `profile ${variant} telemetry realm pre/post`);
        validateRealmAudit(childRealm.before, `profile ${variant} telemetry realm`);
        const childInjection = requireRecord(
            childRealm.runtimeInjection,
            `profile ${variant} telemetry injection envelope`,
        );
        assertEqual(childInjection.unchanged, true, `profile ${variant} telemetry injection unchanged`);
        assertEqual(childInjection.before, childInjection.after, `profile ${variant} telemetry injection pre/post`);
        validateInjection(childInjection.before, `profile ${variant} telemetry injection`);
        const workload = requireRecord(item.workload, `profile ${variant} telemetry workload`);
        assertEqual(workload.seeds, PROFILE_SEEDS, `profile ${variant} telemetry seeds`);
        assertEqual(workload.maxLaps, PROFILE_MAX_LAPS, `profile ${variant} telemetry maxLaps`);
        assertEqual(workload.actionDigest, actionDigest, `profile ${variant} telemetry actions`);
        assertEqual(workload.resultDigest, resultDigest, `profile ${variant} telemetry result`);
        assertEqual(workload.rejected, 0, `profile ${variant} telemetry rejects`);
        assertEqual(workload.stuck, 0, `profile ${variant} telemetry stuck`);
    }

    assertEqual(
        report.artifacts,
        {
            directory: basename(resolve(profileDirectoryInput)),
            rawChromeProfilesRetained: true,
            workloadMetadataRetained: true,
            telemetryMetadataRetained: true,
        },
        "profile retained artifacts",
    );
    const captures = requireRecord(report.captures, "profile captures");
    const profileDirectory = resolve(profileDirectoryInput);
    if (!lstatSync(profileDirectory).isDirectory() || lstatSync(profileDirectory).isSymbolicLink()) {
        throw new Error("profile sidecar directory must be a regular non-symlink directory");
    }
    const expectedNames = new Set<string>(["baseline-telemetry.workload.json", "candidate-telemetry.workload.json"]);
    const captureRows: Array<{ variant: "baseline" | "candidate"; value: Record<string, unknown> }> = [];
    for (const variant of ["baseline", "candidate"] as const) {
        const rows = requireArray(captures[variant], `profile ${variant} captures`);
        if (rows.length !== PROFILE_CAPTURES_PER_VARIANT) {
            throw new Error(`profile ${variant} must contain four captures`);
        }
        rows.forEach((value, index) => {
            const row = requireRecord(value, `profile ${variant} capture ${index + 1}`);
            assertEqual(row.variant, variant, `profile ${variant} capture variant`);
            assertEqual(row.capture, index + 1, `profile ${variant} capture ordinal`);
            const workloadName = requireString(row.workloadArtifact, `profile ${variant} workload artifact`);
            const profileName = requireString(row.profileArtifact, `profile ${variant} CPU artifact`);
            assertEqual(workloadName, `${variant}-capture-${index + 1}.workload.json`, "profile workload name");
            assertEqual(profileName, `${variant}-capture-${index + 1}.cpuprofile`, "profile CPU profile name");
            expectedNames.add(workloadName);
            expectedNames.add(profileName);
            requireSha256(row.workloadArtifactSha256, `profile ${variant} workload SHA`);
            requireSha256(row.profileArtifactSha256, `profile ${variant} CPU SHA`);
            assertEqual(row.actionDigest, actionDigest, `profile ${variant} capture actions`);
            assertEqual(row.resultDigest, resultDigest, `profile ${variant} capture result`);
            captureRows.push({ variant, value: row });
        });
    }
    const actualNames = readdirSync(profileDirectory).sort();
    assertEqual(actualNames, [...expectedNames].sort(), "profile sidecar file set");
    const sidecarFiles = actualNames.map((name) => {
        const sidecarPath = join(profileDirectory, name);
        if (!lstatSync(sidecarPath).isFile() || lstatSync(sidecarPath).isSymbolicLink()) {
            throw new Error(`profile sidecar must be a regular non-symlink file: ${name}`);
        }
        return fileSeal(sidecarPath);
    });
    if (sidecarFiles.length !== 18) throw new Error("profile sidecar directory must contain exactly 18 files");
    for (const variant of ["baseline", "candidate"] as const) {
        const telemetryPath = join(profileDirectory, `${variant}-telemetry.workload.json`);
        assertEqual(
            readJsonObject(telemetryPath, `profile ${variant} telemetry sidecar`),
            telemetryByVariant[variant],
            `profile ${variant} telemetry sidecar contents`,
        );
    }
    for (const capture of captureRows) {
        const row = capture.value;
        const workloadPath = join(profileDirectory, requireString(row.workloadArtifact, "profile workload name"));
        const cpuPath = join(profileDirectory, requireString(row.profileArtifact, "profile CPU profile name"));
        assertEqual(fileSeal(workloadPath).sha256, row.workloadArtifactSha256, "profile workload sidecar hash");
        assertEqual(fileSeal(cpuPath).sha256, row.profileArtifactSha256, "profile CPU sidecar hash");
        const metadata = readJsonObject(workloadPath, "profile workload metadata");
        assertEqual(metadata.schema, PROFILE_CAPTURE_SCHEMA, "profile workload metadata schema");
        assertEqual(metadata.attemptId, profileAttemptId, "profile workload metadata attempt ID");
        assertEqual(metadata.variant, capture.variant, "profile workload metadata variant");
        assertEqual(metadata.capture, row.capture, "profile workload metadata capture");
        assertEqual(metadata.sourceUnchanged, true, "profile workload source unchanged");
        assertEqual(metadata.sourceAfter, metadata.sourceBefore, "profile workload source pre/post");
        validateProfileSourceSeal(metadata.sourceBefore, capture.variant, protocol);
        const workload = requireRecord(metadata.workload, "profile workload metadata work");
        assertEqual(workload.seeds, PROFILE_SEEDS, "profile workload seeds");
        assertEqual(workload.maxLaps, PROFILE_MAX_LAPS, "profile workload maxLaps");
        assertEqual(workload.repeats, PROFILE_REPEATS_PER_CAPTURE, "profile workload repeats");
        assertEqual(workload.matches, PROFILE_SEEDS.length * PROFILE_REPEATS_PER_CAPTURE, "profile workload matches");
        assertEqual(workload.actionDigest, actionDigest, "profile workload action digest");
        assertEqual(workload.resultDigest, resultDigest, "profile workload result digest");
        assertEqual(workload.rejected, 0, "profile workload rejects");
        assertEqual(workload.stuck, 0, "profile workload stuck");
        const warmup = requireRecord(metadata.warmup, "profile workload warmup");
        assertEqual(warmup.actionDigest, warmupActionDigest, "profile warmup action digest");
        assertEqual(warmup.resultDigest, warmupResultDigest, "profile warmup result digest");
        const profileMetadata = requireRecord(metadata.profile, "profile workload CPU metadata");
        assertEqual(profileMetadata.sha256, row.profileArtifactSha256, "profile workload CPU hash");
        assertEqual(profileMetadata.bytes, fileSeal(cpuPath).bytes, "profile workload CPU bytes");
        const childRealm = requireRecord(metadata.realm, "profile workload child realm");
        assertEqual(childRealm.unchanged, true, "profile workload child realm unchanged");
        assertEqual(childRealm.before, childRealm.after, "profile workload child realm pre/post");
        validateRealmAudit(childRealm.before, "profile workload child realm");
        const injection = requireRecord(childRealm.runtimeInjection, "profile workload injection envelope");
        assertEqual(injection.unchanged, true, "profile workload injection unchanged");
        assertEqual(injection.before, injection.after, "profile workload injection pre/post");
        validateInjection(injection.before, "profile workload injection");
        const cpuProfile = readJsonObject(cpuPath, "raw CPU profile");
        const nodes = requireArray(cpuProfile.nodes, "CPU profile nodes");
        const samples = requireArray(cpuProfile.samples, "CPU profile samples");
        const deltas = requireArray(cpuProfile.timeDeltas, "CPU profile time deltas");
        if (nodes.length === 0 || samples.length === 0 || samples.length !== deltas.length) {
            throw new Error("raw CPU profile is incomplete");
        }
        assertEqual(nodes.length, profileMetadata.nodes, "CPU profile node count");
        assertEqual(samples.length, profileMetadata.samples, "CPU profile sample count");
    }

    const gates = requireRecord(report.gates, "profile gates");
    for (const key of [
        "exactSemanticsPassed",
        "warmupSemanticsPassed",
        "telemetrySemanticsPassed",
        "parentAndChildRealmPassed",
        "baselineSignalPassed",
    ]) {
        assertEqual(gates[key], true, `profile ${key}`);
    }
    const fullBuilder = requireGatePassed(gates.fullBuilderCalls, "profile full-builder calls");
    const fullBuilderBaseline = requireInteger(fullBuilder.baseline, "profile baseline full-builder calls", 1);
    const fullBuilderCandidate = requireInteger(fullBuilder.candidate, "profile candidate full-builder calls");
    assertEqual(
        fullBuilder.observedCandidateToBaselineRatio,
        fullBuilderCandidate / fullBuilderBaseline,
        "profile full-builder ratio",
    );
    if (fullBuilderCandidate / fullBuilderBaseline > 0.5) throw new Error("profile full-builder gate failed");
    const firstBuilder = requireGatePassed(gates.firstBuilderCalls, "profile first-builder calls");
    assertEqual(firstBuilder.baseline, 0, "profile baseline first-builder calls");
    requireInteger(firstBuilder.candidate, "profile candidate first-builder calls", 1);
    const infiniteReduction = requireGatePassed(gates.infiniteParentReduction, "profile parent reduction");
    if (requireFiniteNumber(infiniteReduction.observed, "profile parent reduction observed") < 0.5) {
        throw new Error("profile parent-reduction gate failed");
    }
    const combined = requireGatePassed(gates.candidateCombinedBuilderShare, "profile combined builder share");
    if (requireFiniteNumber(combined.observed, "profile combined builder observed", 0) > 0.03) {
        throw new Error("profile combined-builder gate failed");
    }
    const timingTelemetry = requireRecord(gates.timingExcludedTelemetry, "profile timing-excluded telemetry");
    for (const key of [
        "adjustCalls",
        "calls",
        "oracle",
        "classification",
        "nearGrid",
        "fastPathShare",
        "dynamicFallback",
        "legacyConversionParity",
        "candidateFallbackAccounting",
        "baselineClean",
    ]) {
        requireGatePassed(timingTelemetry[key], `profile telemetry ${key}`);
    }
    const oracle = requireRecord(timingTelemetry.oracle, "profile telemetry oracle");
    assertEqual(oracle.oracleChecks, oracle.calls, "profile oracle/call parity");
    assertEqual(oracle.mismatches, 0, "profile oracle mismatches");
    const fastPath = requireRecord(timingTelemetry.fastPathShare, "profile fast path");
    if (requireFiniteNumber(fastPath.observed, "profile fast-path share", 0) < 0.9) {
        throw new Error("profile fast-path gate failed");
    }
    const nearGridTelemetry = requireRecord(timingTelemetry.nearGrid, "profile near-grid telemetry");
    assertEqual(
        {
            scaledLowerExclusive: nearGridTelemetry.scaledLowerExclusive,
            scaledUpperExclusive: nearGridTelemetry.scaledUpperExclusive,
            distanceLowerExclusive: nearGridTelemetry.distanceLowerExclusive,
            distanceUpperExclusive: nearGridTelemetry.distanceUpperExclusive,
        },
        {
            scaledLowerExclusive: -(2 ** 30),
            scaledUpperExclusive: 2 ** 30,
            distanceLowerExclusive: -0.25,
            distanceUpperExclusive: 0.25,
        },
        "profile strict near-grid telemetry predicate",
    );
    requireInteger(nearGridTelemetry.observedFast, "profile near-grid fast calls", 1);
    const nearGridNegativeZero = requireInteger(
        nearGridTelemetry.observedNegativeZero,
        "profile near-grid negative-zero calls",
    );
    if (nearGridNegativeZero > (nearGridTelemetry.observedFast as number)) {
        throw new Error("profile near-grid negative-zero calls exceed near-grid fast calls");
    }
    const adjustRatio = requireGatePassed(gates.adjustBaseStatsFixedWorkRatio, "profile adjustBaseStats ratio");
    if (requireFiniteNumber(adjustRatio.observedCandidateToBaselineRatio, "profile adjustBaseStats ratio", 0) > 0.9) {
        throw new Error("profile adjustBaseStats gate failed");
    }
    const nativeRatio = requireGatePassed(gates.nativeToFixedUnderAdjustRatio, "profile native toFixed ratio");
    if (requireFiniteNumber(nativeRatio.observedCandidateToBaselineRatio, "profile native toFixed ratio", 0) > 0.25) {
        throw new Error("profile native-toFixed gate failed");
    }
    const nativeShare = requireGatePassed(
        gates.candidateNativeToFixedUnderAdjustShare,
        "profile candidate native toFixed share",
    );
    if (requireFiniteNumber(nativeShare.observed, "profile native toFixed share", 0) > 0.01) {
        throw new Error("profile native-toFixed share gate failed");
    }
    const perCapture = requireGatePassed(gates.perCaptureProfileSupport, "profile per-capture support");
    const perCaptureRows = requireArray(perCapture.captures, "profile per-capture support rows");
    if (perCaptureRows.length !== PROFILE_CAPTURES_PER_VARIANT) {
        throw new Error("profile per-capture support must contain four rows");
    }
    for (const [index, value] of perCaptureRows.entries()) {
        const row = requireRecord(value, `profile per-capture support ${index + 1}`);
        assertEqual(row.capture, index + 1, `profile support capture ${index + 1}`);
        assertEqual(row.signalsPassed, true, `profile support signals ${index + 1}`);
        assertEqual(row.directionsPassed, true, `profile support directions ${index + 1}`);
        assertEqual(row.passed, true, `profile support passed ${index + 1}`);
    }
    assertEqual(gates.measurementGatesPassed, true, "profile measurement gates");
    assertEqual(gates.qualified, true, "profile qualification");
    assertEqual(gates.smokeNeverQualifies, false, "profile smoke flag");

    return {
        file,
        directory: {
            path: profileDirectory,
            realPath: realpathSync(profileDirectory),
            entryCount: sidecarFiles.length,
            bytes: sum(sidecarFiles.map((sidecar) => sidecar.bytes)),
            files: sidecarFiles,
            manifestSha256: digest(
                sidecarFiles.map((sidecar) => ({
                    name: basename(sidecar.path),
                    bytes: sidecar.bytes,
                    sha256: sidecar.sha256,
                })),
            ),
            campaignManifestSha256: sha256(
                JSON.stringify(
                    sidecarFiles.map((sidecar) => ({
                        path: basename(sidecar.path),
                        kind: "file",
                        bytes: sidecar.bytes,
                        sha256: sidecar.sha256,
                    })),
                ),
            ),
        },
        report,
        hostIdentity: validateHost(profileRuntime, "profile runtime"),
        sourceIdentity: {
            baseline: baselineSource.identitySha256,
            candidate: candidateSource.identitySha256,
            delta: delta.manifestSha256,
        },
        gates: { passed: true },
    };
}

function validateRecordedFileSeal(value: unknown, actualPath: string, label: string): IFileSeal {
    const recorded = requireRecord(value, label);
    const actual = fileSeal(actualPath);
    assertEqual(
        {
            path: resolve(requireString(recorded.path, `${label}.path`)),
            realPath: requireString(recorded.realPath, `${label}.realPath`),
            bytes: requireInteger(recorded.bytes, `${label}.bytes`),
            sha256: requireSha256(recorded.sha256, `${label}.sha256`),
        },
        actual,
        label,
    );
    return actual;
}

function validateHostAttestation(
    value: unknown,
    label: string,
    expectedIdentity?: Record<string, unknown>,
): Record<string, unknown> {
    const attestation = requireRecord(value, label);
    assertExactKeys(attestation, ["schema", "observedAt", "identity", "power", "thermal", "overlap", "passed"], label);
    assertEqual(
        attestation.schema,
        "heroes-of-crypto/a13-stat-rounding-near-grid-host-attestation/v1",
        `${label} schema`,
    );
    requireIsoTimestamp(attestation.observedAt, `${label} observedAt`);
    const identity = requireRecord(attestation.identity, `${label} identity`);
    assertExactKeys(
        identity,
        [
            "hostname",
            "platform",
            "release",
            "arch",
            "cpuModel",
            "logicalCpus",
            "hardwareModel",
            "physicalCpus",
            "bootTime",
            "bunVersion",
            "bunRevision",
            "bunExecutableSha256",
        ],
        `${label} identity`,
    );
    const bootTime = requireString(identity.bootTime, `${label} boot time`);
    assertEqual(
        {
            hostname: requireString(identity.hostname, `${label} hostname`),
            platform: requireString(identity.platform, `${label} platform`),
            release: requireString(identity.release, `${label} release`),
            arch: requireString(identity.arch, `${label} arch`),
            cpuModel: requireString(identity.cpuModel, `${label} CPU model`),
            logicalCpus: requireInteger(identity.logicalCpus, `${label} logical CPUs`, 1),
            hardwareModel: requireString(identity.hardwareModel, `${label} hardware model`),
            physicalCpus: requireInteger(identity.physicalCpus, `${label} physical CPUs`, 1),
            bootTime,
            bunVersion: requireString(identity.bunVersion, `${label} Bun version`),
            bunRevision: requireString(identity.bunRevision, `${label} Bun revision`),
            bunExecutableSha256: requireSha256(identity.bunExecutableSha256, `${label} Bun executable`),
        },
        PINNED_HOST,
        `${label} pinned identity`,
    );
    if (expectedIdentity) assertEqual(identity, expectedIdentity, `${label} frozen host identity`);
    const power = requireRecord(attestation.power, `${label} power`);
    assertExactKeys(power, ["ac", "rawSha256", "raw"], `${label} power`);
    assertEqual(power.ac, true, `${label} AC power`);
    requireSha256(power.rawSha256, `${label} power raw SHA`);
    const powerRaw = requireString(power.raw, `${label} power raw`);
    assertEqual(power.rawSha256, sha256(powerRaw), `${label} power raw digest`);
    if (!powerRaw.includes("Now drawing from 'AC Power'")) {
        throw new Error(`${label} power raw output does not attest AC power`);
    }
    const thermal = requireRecord(attestation.thermal, `${label} thermal`);
    assertExactKeys(thermal, ["nominal", "rawSha256", "raw"], `${label} thermal`);
    assertEqual(thermal.nominal, true, `${label} thermal pressure`);
    requireSha256(thermal.rawSha256, `${label} thermal raw SHA`);
    const thermalRaw = requireString(thermal.raw, `${label} thermal raw`);
    assertEqual(thermal.rawSha256, sha256(thermalRaw), `${label} thermal raw digest`);
    if (
        !thermalRaw.includes("No thermal warning level has been recorded") ||
        !thermalRaw.includes("No performance warning level has been recorded") ||
        !thermalRaw.includes("No CPU power status has been recorded")
    ) {
        throw new Error(`${label} thermal raw output does not attest nominal thermal pressure`);
    }
    const overlap = requireRecord(attestation.overlap, `${label} overlap`);
    assertExactKeys(overlap, ["passed", "markers", "matchingProcesses"], `${label} overlap`);
    assertEqual(overlap.passed, true, `${label} overlap passed`);
    assertEqual(overlap.markers, EXPECTED_OVERLAP_MARKERS, `${label} overlap markers`);
    assertEqual(overlap.matchingProcesses, [], `${label} matching processes`);
    assertEqual(attestation.passed, true, `${label} passed`);
    return attestation;
}

function validateHostHealthSample(value: unknown, label: string): Record<string, unknown> {
    const sample = requireRecord(value, label);
    assertExactKeys(sample, ["schema", "observedAt", "power", "thermal", "overlap", "passed"], label);
    assertEqual(sample.schema, "heroes-of-crypto/a13-stat-rounding-near-grid-host-health/v1", `${label} schema`);
    requireIsoTimestamp(sample.observedAt, `${label} observedAt`);
    const power = requireRecord(sample.power, `${label} power`);
    assertExactKeys(power, ["ac", "rawSha256", "raw"], `${label} power`);
    assertEqual(power.ac, true, `${label} AC power`);
    requireSha256(power.rawSha256, `${label} power raw SHA`);
    const powerRaw = requireString(power.raw, `${label} power raw`);
    assertEqual(power.rawSha256, sha256(powerRaw), `${label} power raw digest`);
    if (!powerRaw.includes("Now drawing from 'AC Power'")) {
        throw new Error(`${label} power raw output does not attest AC power`);
    }
    const thermal = requireRecord(sample.thermal, `${label} thermal`);
    assertExactKeys(thermal, ["nominal", "rawSha256", "raw"], `${label} thermal`);
    assertEqual(thermal.nominal, true, `${label} thermal pressure`);
    requireSha256(thermal.rawSha256, `${label} thermal raw SHA`);
    const thermalRaw = requireString(thermal.raw, `${label} thermal raw`);
    assertEqual(thermal.rawSha256, sha256(thermalRaw), `${label} thermal raw digest`);
    if (
        !thermalRaw.includes("No thermal warning level has been recorded") ||
        !thermalRaw.includes("No performance warning level has been recorded") ||
        !thermalRaw.includes("No CPU power status has been recorded")
    ) {
        throw new Error(`${label} thermal raw output does not attest nominal thermal pressure`);
    }
    const overlap = requireRecord(sample.overlap, `${label} overlap`);
    assertExactKeys(overlap, ["passed", "markers", "matchingProcesses"], `${label} overlap`);
    assertEqual(overlap.passed, true, `${label} overlap passed`);
    assertEqual(overlap.markers, EXPECTED_OVERLAP_MARKERS, `${label} overlap markers`);
    assertEqual(overlap.matchingProcesses, [], `${label} matching processes`);
    assertEqual(sample.passed, true, `${label} passed`);
    return sample;
}

function expectedCampaignConfigurationAbsence(outputRoot: string, stage: string): Record<string, unknown> {
    const cleanHome = join(outputRoot, "runtime", stage, "home");
    return {
        passed: true,
        checked: [".env", ".env.local", ".env.development", ".env.production", ".env.test"]
            .map((name) => join(COMMON_ROOT, name))
            .concat([
                join(COMMON_ROOT, ".bunfig.toml"),
                join(COMMON_ROOT, "bunfig.local.toml"),
                join(cleanHome, ".bunfig.toml"),
                join(cleanHome, ".config/bunfig.toml"),
                join(cleanHome, ".config/bun/bunfig.toml"),
            ])
            .sort(),
        present: [],
        rootEnvironmentGlob: ".env*",
        bunConfigurationCandidatesAbsent: true,
    };
}

function validateLedger(
    path: string,
    protocolSeal: IFileSeal,
    protocol: Record<string, unknown>,
    stagePaths: Readonly<Record<string, string>>,
    profileDirectory: IValidatedProfile["directory"],
    aggregatePath: string,
): IValidatedLedger {
    const file = fileSeal(path);
    const text = readFileSync(path, "utf8");
    if (!text.endsWith("\n")) throw new Error("attempt ledger must end with a newline");
    const lines = text.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) throw new Error("attempt ledger may not contain blank lines");
    const expectedRecordCount = 2 + REQUIRED_LEDGER_STAGES.length * 2 + 1 + 1;
    if (lines.length !== expectedRecordCount) {
        throw new Error(`attempt ledger must contain exactly ${expectedRecordCount} records`);
    }
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    const records = lines.map((line, index) => {
        const record = requireRecord(JSON.parse(line), `ledger record ${index}`);
        if (line !== ledgerCompactJson(record)) {
            throw new Error(`ledger record ${index} is not exact canonical compact JSON`);
        }
        assertEqual(record.schema, LEDGER_SCHEMA, `ledger record ${index} schema`);
        assertEqual(record.campaignId, CAMPAIGN_ID, `ledger record ${index} campaign`);
        assertEqual(record.sequence, index, `ledger record ${index} sequence`);
        assertEqual(
            record.previousRecordSha256,
            index === 0 ? null : sha256(lines[index - 1]),
            `ledger record ${index} previous hash`,
        );
        if (index === 0) {
            assertEqual(record.recordedAt, null, "ledger genesis timestamp");
        } else {
            requireIsoTimestamp(record.recordedAt, `ledger record ${index} timestamp`);
            const timestamp = Date.parse(record.recordedAt as string);
            if (timestamp <= previousTimestamp) {
                throw new Error(`ledger timestamps are not strictly increasing at sequence ${index}`);
            }
            previousTimestamp = timestamp;
        }
        return record;
    });
    const genesis = records[0];
    assertExactKeys(genesis, [...LEDGER_COMMON_KEYS, "event", "stageOrder", "zeroRetry"], "ledger genesis");
    assertEqual(genesis.event, "harness-prepared", "ledger genesis event");
    assertEqual(genesis.zeroRetry, true, "ledger genesis zero-retry policy");
    assertEqual(genesis.stageOrder, REQUIRED_LEDGER_STAGES, "ledger genesis stage order");

    const frozen = records[1];
    assertExactKeys(
        frozen,
        [
            ...LEDGER_COMMON_KEYS,
            "event",
            "status",
            "protocolCommit",
            "protocol",
            "genesisLedgerSha256",
            "runners",
            "archives",
            "roots",
            "outputRoot",
            "stageOrder",
            "zeroRetry",
            "hostIdentity",
            "executionEnvironment",
            "overlapMarkers",
            "hostMonitoring",
        ],
        "ledger protocol freeze",
    );
    assertEqual(frozen.event, "protocol-frozen", "ledger protocol freeze event");
    assertEqual(frozen.status, "authorized", "ledger protocol freeze status");
    const protocolCommit = requireString(frozen.protocolCommit, "ledger protocol commit");
    if (!/^[0-9a-f]{40}$/.test(protocolCommit)) throw new Error("ledger protocol commit must be full SHA-1");
    const resolvedProtocolCommit = execFileSync(GIT_EXECUTABLE, ["rev-parse", `${protocolCommit}^{commit}`], {
        cwd: COMMON_ROOT,
        encoding: "utf8",
    }).trim();
    assertEqual(resolvedProtocolCommit, protocolCommit, "ledger protocol commit resolution");
    assertEqual(frozen.protocol, protocolSeal, "ledger protocol seal");
    assertEqual(frozen.genesisLedgerSha256, sha256(lines[0]), "ledger committed genesis hash");
    assertEqual(frozen.zeroRetry, true, "ledger protocol zero-retry policy");
    assertEqual(frozen.stageOrder, REQUIRED_LEDGER_STAGES, "ledger protocol stage order");
    const frozenHostIdentity = requireRecord(frozen.hostIdentity, "ledger frozen host identity");
    assertEqual(frozenHostIdentity, PINNED_HOST, "ledger frozen exact host identity");
    assertEqual(frozen.executionEnvironment, REQUIRED_RUNTIME_ENVIRONMENT, "ledger frozen execution environment");
    assertEqual(frozen.overlapMarkers, EXPECTED_OVERLAP_MARKERS, "ledger frozen overlap markers");
    assertEqual(frozen.hostMonitoring, HOST_MONITORING, "ledger frozen host monitoring");
    const frozenRunners = requireRecord(frozen.runners, "ledger frozen runners");
    const protocolRunners = requireRecord(protocol.runners, "protocol runner registry");
    for (const [name, expectedPath] of [
        ["campaign", CAMPAIGN_RUNNER_PATH],
        ["pair", PAIR_RUNNER_PATH],
        ["micro", MICRO_RUNNER_PATH],
        ["profile", PROFILE_RUNNER_PATH],
        ["replication", RUNNER_PATH],
        ["quantile", QUANTILE_HELPER_PATH],
    ] as const) {
        const runner = requireRecord(frozenRunners[name], `ledger frozen ${name} runner`);
        const declared = requireRecord(protocolRunners[name], `protocol ${name} runner`);
        assertEqual(runner.schema, declared.schema, `ledger frozen ${name} schema`);
        assertEqual(runner.sha256, declared.sha256, `ledger frozen ${name} SHA`);
        validateRecordedFileSeal(runner, expectedPath, `ledger frozen ${name} runner`);
    }
    for (const committedFile of [
        protocolSeal,
        ...["campaign", "pair", "micro", "profile", "replication", "quantile"].map((name) => {
            const value = requireRecord(frozenRunners[name], `ledger frozen ${name} runner`);
            return {
                path: resolve(requireString(value.path, `ledger frozen ${name} path`)),
                realPath: requireString(value.realPath, `ledger frozen ${name} realpath`),
                bytes: requireInteger(value.bytes, `ledger frozen ${name} bytes`, 1),
                sha256: requireSha256(value.sha256, `ledger frozen ${name} SHA`),
            };
        }),
    ]) {
        const repositoryPath = relative(COMMON_ROOT, committedFile.path);
        if (repositoryPath.startsWith(".."))
            throw new Error(`Frozen file is outside the common repository: ${repositoryPath}`);
        const committedBytes = execFileSync(GIT_EXECUTABLE, ["show", `${protocolCommit}:${repositoryPath}`], {
            cwd: COMMON_ROOT,
            encoding: "buffer",
            maxBuffer: 16 * 1024 * 1024,
        });
        assertEqual(committedBytes.byteLength, committedFile.bytes, `committed ${repositoryPath} bytes`);
        assertEqual(sha256(committedBytes), committedFile.sha256, `committed ${repositoryPath} SHA`);
    }
    const ledgerRepositoryPath = relative(COMMON_ROOT, file.path);
    if (ledgerRepositoryPath.startsWith("..")) throw new Error("Attempt ledger is outside the common repository");
    const committedLedger = execFileSync(GIT_EXECUTABLE, ["show", `${protocolCommit}:${ledgerRepositoryPath}`], {
        cwd: COMMON_ROOT,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
    });
    assertEqual(committedLedger, `${lines[0]}\n`, "committed ledger genesis prefix");
    const archives = requireRecord(frozen.archives, "ledger frozen archives");
    for (const [variant, commit, archiveSha256, srcManifestSha256] of [
        ["baseline", BASELINE_COMMIT, BASELINE_ARCHIVE_SHA256, BASELINE_SRC_MANIFEST_SHA256],
        ["candidate", CANDIDATE_COMMIT, CANDIDATE_ARCHIVE_SHA256, CANDIDATE_SRC_MANIFEST_SHA256],
    ] as const) {
        const archive = requireRecord(archives[variant], `ledger frozen ${variant} archive`);
        assertEqual(
            {
                commit: archive.commit,
                archiveSha256: archive.archiveSha256,
                srcManifestSha256: archive.srcManifestSha256,
            },
            { commit, archiveSha256, srcManifestSha256 },
            `ledger frozen ${variant} archive`,
        );
    }
    const roots = requireRecord(frozen.roots, "ledger frozen roots");
    const baselineRoot = resolve(requireString(roots.baseline, "ledger baseline root"));
    const candidateRoot = resolve(requireString(roots.candidate, "ledger candidate root"));
    if (
        !lstatSync(baselineRoot).isDirectory() ||
        lstatSync(baselineRoot).isSymbolicLink() ||
        realpathSync(baselineRoot) !== baselineRoot ||
        !lstatSync(candidateRoot).isDirectory() ||
        lstatSync(candidateRoot).isSymbolicLink() ||
        realpathSync(candidateRoot) !== candidateRoot ||
        realpathSync(baselineRoot) === realpathSync(candidateRoot)
    ) {
        throw new Error("ledger frozen roots must be canonical, non-symlink, and distinct");
    }
    const outputRoot = resolve(requireString(frozen.outputRoot, "ledger output root"));
    if (
        !lstatSync(outputRoot).isDirectory() ||
        lstatSync(outputRoot).isSymbolicLink() ||
        realpathSync(outputRoot) !== outputRoot ||
        pathIsWithin(outputRoot, baselineRoot) ||
        pathIsWithin(baselineRoot, outputRoot) ||
        pathIsWithin(outputRoot, candidateRoot) ||
        pathIsWithin(candidateRoot, outputRoot) ||
        pathIsWithin(outputRoot, COMMON_ROOT) ||
        pathIsWithin(COMMON_ROOT, outputRoot)
    ) {
        throw new Error("ledger output root is not a canonical, isolated directory");
    }
    assertEqual(
        protocol.campaign,
        {
            id: CAMPAIGN_ID,
            runnerSchema: CAMPAIGN_SCHEMA,
            stageOrder: REQUIRED_LEDGER_STAGES,
            zeroRetry: true,
            outputRoot,
            executionEnvironment: REQUIRED_RUNTIME_ENVIRONMENT,
            hostIdentity: PINNED_HOST,
            overlapMarkers: EXPECTED_OVERLAP_MARKERS,
            hostMonitoring: HOST_MONITORING,
        },
        "protocol exact campaign",
    );

    const stages: IValidatedLedger["stages"] = [];
    let cursor = 2;
    for (const stage of REQUIRED_LEDGER_STAGES) {
        const start = records[cursor];
        const completion = records[cursor + 1];
        assertExactKeys(
            start,
            [
                ...LEDGER_COMMON_KEYS,
                "event",
                "stage",
                "attempt",
                "attemptId",
                "runner",
                "argv",
                "artifactPath",
                "configurationAbsence",
                "hostAttestation",
            ],
            `ledger ${stage} start`,
        );
        assertExactKeys(
            completion,
            [
                ...LEDGER_COMMON_KEYS,
                "event",
                "stage",
                "attempt",
                "attemptId",
                "startRecordSha256",
                "exitCode",
                "signal",
                "artifact",
                "stdout",
                "stderr",
                "configurationAbsence",
                "hostAttestation",
                "validation",
                "profileSidecars",
                "accepted",
            ],
            `ledger ${stage} completion`,
        );
        assertEqual(start.event, "attempt-started", `ledger ${stage} start event`);
        assertEqual(start.stage, stage, `ledger ${stage} start stage`);
        assertEqual(start.attempt, 1, `ledger ${stage} start attempt`);
        const attemptId = requireUuidV4(start.attemptId, `ledger ${stage} attempt ID`);
        const runner = requireRecord(start.runner, `ledger ${stage} runner`);
        const expectedRunner =
            stage === "micro"
                ? requireRecord(protocol.microRunner, "protocol micro runner")
                : stage === "profile"
                  ? requireRecord(protocol.profileRunner, "protocol profile runner")
                  : requireRecord(protocol.captureRunner, "protocol pair runner");
        const expectedRunnerPath =
            stage === "micro" ? MICRO_RUNNER_PATH : stage === "profile" ? PROFILE_RUNNER_PATH : PAIR_RUNNER_PATH;
        assertEqual(runner.schema, expectedRunner.schema, `ledger ${stage} runner schema`);
        assertEqual(runner.sha256, expectedRunner.sha256, `ledger ${stage} runner hash`);
        validateRecordedFileSeal(runner, expectedRunnerPath, `ledger ${stage} runner`);
        const expectedPath = stagePaths[stage];
        if (!expectedPath) throw new Error(`ledger stage ${stage} has no CLI artifact mapping`);
        assertEqual(resolve(expectedPath), join(outputRoot, `${stage}.json`), `ledger ${stage} output namespace`);
        assertEqual(
            resolve(requireString(start.artifactPath, `ledger ${stage} artifact path`)),
            resolve(expectedPath),
            `ledger ${stage} planned artifact`,
        );
        let expectedArguments: string[];
        if (stage === "semantic") {
            expectedArguments = [
                `--baseline-root=${baselineRoot}`,
                `--candidate-root=${candidateRoot}`,
                "--capture-id=semantic",
                `--out=${expectedPath}`,
                `--seeds=${NATURAL_SEEDS.join(",")}`,
                `--grid-types=${NATURAL_GRID_TYPES.join(",")}`,
                `--max-laps=${SEMANTIC_MAX_LAPS}`,
                `--warmup-seed=${WARMUP_SEED}`,
            ];
        } else if (stage === "micro") {
            expectedArguments = [`--out=${expectedPath}`];
        } else if (stage === "profile") {
            expectedArguments = [
                `--baseline-root=${baselineRoot}`,
                `--candidate-root=${candidateRoot}`,
                `--out=${expectedPath}`,
            ];
        } else {
            const schedule = CAPTURE_SCHEDULES.find((item) => item.id === stage);
            if (!schedule) throw new Error(`No frozen schedule for ${stage}`);
            expectedArguments = [
                `--baseline-root=${baselineRoot}`,
                `--candidate-root=${candidateRoot}`,
                `--capture-id=${stage}`,
                `--out=${expectedPath}`,
                `--seeds=${schedule.seeds.join(",")}`,
                `--grid-types=${schedule.gridTypes.join(",")}`,
                `--max-laps=${MAX_LAPS}`,
                `--warmup-seed=${WARMUP_SEED}`,
                ...(schedule.invertOrder ? ["--invert-order"] : []),
            ];
        }
        assertEqual(
            start.argv,
            [process.execPath, expectedRunnerPath, ...expectedArguments, `--attempt-id=${attemptId}`],
            `ledger ${stage} exact argv`,
        );
        const expectedConfigurationAbsence = expectedCampaignConfigurationAbsence(outputRoot, stage);
        assertEqual(start.configurationAbsence, expectedConfigurationAbsence, `ledger ${stage} configuration absence`);
        const startHost = validateHostAttestation(
            start.hostAttestation,
            `ledger ${stage} start host`,
            frozenHostIdentity,
        );

        assertEqual(completion.event, "attempt-completed", `ledger ${stage} completion event`);
        assertEqual(completion.stage, stage, `ledger ${stage} completion stage`);
        assertEqual(completion.attempt, 1, `ledger ${stage} completion attempt`);
        assertEqual(completion.attemptId, attemptId, `ledger ${stage} completion attempt ID`);
        assertEqual(completion.startRecordSha256, sha256(lines[cursor]), `ledger ${stage} start binding`);
        assertEqual(completion.exitCode, 0, `ledger ${stage} exit code`);
        assertEqual(completion.signal, null, `ledger ${stage} signal`);
        assertEqual(completion.accepted, true, `ledger ${stage} accepted`);
        const artifact = validateRecordedFileSeal(completion.artifact, expectedPath, `ledger ${stage} artifact`);
        const expectedProfileSidecars =
            stage === "profile"
                ? {
                      path: profileDirectory.path,
                      realPath: profileDirectory.realPath,
                      entryCount: profileDirectory.entryCount,
                      bytes: profileDirectory.bytes,
                      manifestSha256: profileDirectory.campaignManifestSha256,
                  }
                : null;
        const completionConfiguration = requireRecord(
            completion.configurationAbsence,
            `ledger ${stage} completion configuration`,
        );
        assertEqual(
            completionConfiguration,
            {
                before: expectedConfigurationAbsence,
                after: expectedCampaignConfigurationAbsence(outputRoot, stage),
                unchanged: true,
                error: null,
            },
            `ledger ${stage} configuration pre/post`,
        );
        const artifactTimestamp = requireIsoTimestamp(
            requireRecord(completion.validation, `ledger ${stage} validation`).artifactTimestamp,
            `ledger ${stage} artifact timestamp`,
        );
        assertEqual(completion.profileSidecars, expectedProfileSidecars, `ledger ${stage} profile sidecars`);
        assertEqual(
            completion.validation,
            {
                passed: true,
                executionError: null,
                hostError: null,
                monitorError: null,
                interruptedSignal: null,
                artifactError: null,
                artifactTimestamp,
                profileSidecars: expectedProfileSidecars,
            },
            `ledger ${stage} producer validation`,
        );
        const stdout = requireRecord(completion.stdout, `ledger ${stage} stdout`);
        const stderr = requireRecord(completion.stderr, `ledger ${stage} stderr`);
        for (const [label, stream] of [
            ["stdout", stdout],
            ["stderr", stderr],
        ] as const) {
            const streamPath = resolve(requireString(stream.path, `ledger ${stage} ${label} path`));
            assertEqual(streamPath, `${expectedPath}.${label}.log`, `ledger ${stage} ${label} namespace`);
            validateRecordedFileSeal(stream, streamPath, `ledger ${stage} ${label}`);
        }
        const host = requireRecord(completion.hostAttestation, `ledger ${stage} completion host`);
        assertExactKeys(host, ["before", "monitor", "after", "unchanged"], `ledger ${stage} completion host`);
        assertEqual(host.unchanged, true, `ledger ${stage} host unchanged`);
        assertEqual(host.before, start.hostAttestation, `ledger ${stage} host preflight binding`);
        const hostBefore = validateHostAttestation(host.before, `ledger ${stage} host before`, frozenHostIdentity);
        const hostAfter = validateHostAttestation(host.after, `ledger ${stage} host after`, frozenHostIdentity);
        const monitor = requireRecord(host.monitor, `ledger ${stage} host monitor`);
        assertExactKeys(
            monitor,
            [
                "intervalMilliseconds",
                "maximumSchedulingDelayMilliseconds",
                "producerClosedAt",
                "samples",
                "error",
                "passed",
            ],
            `ledger ${stage} host monitor`,
        );
        assertEqual(
            {
                intervalMilliseconds: monitor.intervalMilliseconds,
                maximumSchedulingDelayMilliseconds: monitor.maximumSchedulingDelayMilliseconds,
                error: monitor.error,
                passed: monitor.passed,
            },
            {
                intervalMilliseconds: HOST_MONITORING.intervalMilliseconds,
                maximumSchedulingDelayMilliseconds: HOST_MONITORING.maximumSchedulingDelayMilliseconds,
                error: null,
                passed: true,
            },
            `ledger ${stage} host monitor policy`,
        );
        assertEqual(hostBefore, startHost, `ledger ${stage} start/completion host binding`);
        assertEqual(hostBefore.identity, hostAfter.identity, `ledger ${stage} host identity pre/post`);
        const startObservedAt = requireIsoTimestamp(hostBefore.observedAt, `ledger ${stage} host before observedAt`);
        const afterObservedAt = requireIsoTimestamp(hostAfter.observedAt, `ledger ${stage} host after observedAt`);
        const startedAt = requireIsoTimestamp(start.recordedAt, `ledger ${stage} start timestamp`);
        const producerClosedAt = requireIsoTimestamp(
            monitor.producerClosedAt,
            `ledger ${stage} producer close timestamp`,
        );
        const completedAt = requireIsoTimestamp(completion.recordedAt, `ledger ${stage} completion timestamp`);
        const monitorSamples = requireArray(monitor.samples, `ledger ${stage} host monitor samples`).map(
            (sample, index) => validateHostHealthSample(sample, `ledger ${stage} host monitor sample ${index}`),
        );
        const monitorObservedAt = monitorSamples.map((sample, index) =>
            requireIsoTimestamp(sample.observedAt, `ledger ${stage} host monitor sample ${index} observedAt`),
        );
        const cadenceMilliseconds = [startedAt, ...monitorObservedAt, producerClosedAt].map(Date.parse);
        for (let index = 1; index < cadenceMilliseconds.length; index += 1) {
            const gap = cadenceMilliseconds[index] - cadenceMilliseconds[index - 1];
            if (
                gap <= 0 ||
                gap > HOST_MONITORING.intervalMilliseconds + HOST_MONITORING.maximumSchedulingDelayMilliseconds
            ) {
                throw new Error(`ledger ${stage} host monitor cadence gap ${index - 1}->${index} is invalid: ${gap}ms`);
            }
        }
        if (
            Date.parse(startObservedAt) > Date.parse(startedAt) ||
            Date.parse(startedAt) > Date.parse(artifactTimestamp) ||
            Date.parse(artifactTimestamp) > Date.parse(producerClosedAt) ||
            Date.parse(producerClosedAt) > Date.parse(afterObservedAt) ||
            Date.parse(afterObservedAt) > Date.parse(completedAt)
        ) {
            throw new Error(`ledger ${stage} host/record timestamp chain is invalid`);
        }
        stages.push({
            stage,
            attemptId,
            startSequence: cursor,
            completionSequence: cursor + 1,
            startedAt,
            completedAt,
            hostObservedBeforeAt: startObservedAt,
            hostObservedAfterAt: afterObservedAt,
            producerClosedAt,
            monitorSampleCount: monitorSamples.length,
            artifactTimestamp,
            artifact,
        });
        cursor += 2;
    }
    if (new Set(stages.map((stage) => stage.attemptId)).size !== REQUIRED_LEDGER_STAGES.length) {
        throw new Error("ledger must contain thirteen unique stage attempt IDs");
    }
    const closure = records[cursor];
    assertExactKeys(
        closure,
        [
            ...LEDGER_COMMON_KEYS,
            "event",
            "stageOrder",
            "zeroRetry",
            "noShadowAttemptsAttestation",
            "acceptedStages",
            "profileSidecars",
        ],
        "ledger closure",
    );
    assertEqual(closure.event, "qualification-inputs-closed", "ledger closure event");
    assertEqual(closure.stageOrder, REQUIRED_LEDGER_STAGES, "ledger closure stages");
    assertEqual(closure.zeroRetry, true, "ledger closure zero-retry policy");
    assertEqual(closure.noShadowAttemptsAttestation, true, "ledger closure shadow-attempt attestation");
    const acceptedStages = requireRecord(closure.acceptedStages, "ledger closure accepted stages");
    const expectedAcceptedStages = Object.fromEntries(
        stages.map((stage) => [
            stage.stage,
            {
                completionRecordSha256: sha256(lines[stage.completionSequence]),
                artifact: stage.artifact,
            },
        ]),
    );
    assertEqual(acceptedStages, expectedAcceptedStages, "ledger closure accepted stages");
    assertEqual(
        closure.profileSidecars,
        {
            path: profileDirectory.path,
            realPath: profileDirectory.realPath,
            entryCount: profileDirectory.entryCount,
            bytes: profileDirectory.bytes,
            manifestSha256: profileDirectory.campaignManifestSha256,
        },
        "ledger closure profile sidecars",
    );
    cursor++;

    const aggregationAttempt = records[cursor];
    assertExactKeys(
        aggregationAttempt,
        [
            ...LEDGER_COMMON_KEYS,
            "event",
            "attempt",
            "attemptId",
            "closureRecordSha256",
            "runner",
            "argv",
            "artifactPath",
            "configurationAbsence",
            "zeroRetry",
            "noRetryAfterAnyOutcome",
        ],
        "ledger aggregation attempt",
    );
    assertEqual(aggregationAttempt.event, "aggregation-attempt-started", "ledger aggregation attempt event");
    assertEqual(aggregationAttempt.attempt, 1, "ledger aggregation attempt ordinal");
    const aggregationAttemptId = requireUuidV4(aggregationAttempt.attemptId, "ledger aggregation attempt ID");
    if (stages.some((stage) => stage.attemptId === aggregationAttemptId)) {
        throw new Error("ledger aggregation attempt ID duplicates a producer attempt ID");
    }
    assertEqual(
        aggregationAttempt.closureRecordSha256,
        sha256(lines[cursor - 1]),
        "ledger aggregation closure binding",
    );
    const aggregationRunner = requireRecord(aggregationAttempt.runner, "ledger aggregation runner");
    const protocolAggregationRunner = requireRecord(protocol.aggregationRunner, "protocol aggregation runner");
    assertEqual(
        {
            schema: aggregationRunner.schema,
            sha256: aggregationRunner.sha256,
        },
        protocolAggregationRunner,
        "ledger aggregation runner identity",
    );
    validateRecordedFileSeal(aggregationRunner, RUNNER_PATH, "ledger aggregation runner");
    const expectedAggregatePath = join(outputRoot, "aggregate.json");
    assertEqual(resolve(aggregatePath), expectedAggregatePath, "ledger aggregate CLI output namespace");
    assertEqual(
        resolve(requireString(aggregationAttempt.artifactPath, "ledger aggregation artifact path")),
        expectedAggregatePath,
        "ledger aggregation artifact path",
    );
    assertEqual(
        aggregationAttempt.argv,
        [
            process.execPath,
            RUNNER_PATH,
            `--ledger=${resolve(path)}`,
            `--semantic=${stagePaths.semantic}`,
            `--micro=${stagePaths.micro}`,
            `--profile=${stagePaths.profile}`,
            `--profile-dir=${profileDirectory.path}`,
            ...CAPTURE_IDS.map((id) => `--${id}=${stagePaths[id]}`),
            `--out=${expectedAggregatePath}`,
        ],
        "ledger aggregation exact argv",
    );
    assertEqual(
        aggregationAttempt.configurationAbsence,
        expectedCampaignConfigurationAbsence(outputRoot, "aggregate"),
        "ledger aggregation configuration absence",
    );
    assertEqual(aggregationAttempt.zeroRetry, true, "ledger aggregation zero-retry policy");
    assertEqual(aggregationAttempt.noRetryAfterAnyOutcome, true, "ledger aggregation terminal stopping policy");

    return {
        file,
        campaignId: CAMPAIGN_ID,
        protocolCommit,
        recordCount: records.length,
        lastSequence: records.length - 1,
        chainTipSha256: sha256(lines.at(-1)!),
        outputRoot,
        roots: { baseline: baselineRoot, candidate: candidateRoot },
        stages,
        closure,
        aggregationAttempt,
    };
}

function validateAttemptBinding(
    report: Record<string, unknown>,
    stage: IValidatedLedger["stages"][number],
    timestampField: "generatedAt" | "createdAt",
    label: string,
): void {
    assertEqual(report.attemptId, stage.attemptId, `${label} attempt ID`);
    const artifactTimestamp = requireIsoTimestamp(report[timestampField], `${label} ${timestampField}`);
    assertEqual(artifactTimestamp, stage.artifactTimestamp, `${label} ledger artifact timestamp`);
    const artifactMilliseconds = Date.parse(artifactTimestamp);
    if (
        artifactMilliseconds < Date.parse(stage.startedAt) ||
        artifactMilliseconds > Date.parse(stage.producerClosedAt) ||
        Date.parse(stage.producerClosedAt) > Date.parse(stage.hostObservedAfterAt) ||
        Date.parse(stage.hostObservedAfterAt) > Date.parse(stage.completedAt)
    ) {
        throw new Error(`${label} timestamp falls outside its start/artifact/host-after/completion chain`);
    }
}

function medianFive(values: readonly number[], label: string): number {
    if (values.length !== 5 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error(`${label} must contain five positive ratios`);
    }
    return [...values].sort((left, right) => left - right)[2];
}

function quantile(values: readonly number[], probability: number): number {
    return type7Quantile(values, probability);
}

function buildRobustTasks(captures: readonly IValidatedCapture[]): IRobustTask[] {
    return NATURAL_SEEDS.flatMap((seed) =>
        NATURAL_GRID_TYPES.map((gridType) => {
            const rows = captures.map((capture) => capture.rowsByTask.get(taskKey(seed, gridType))!);
            const abRatios = rows.filter((row) => row.order === "AB").map((row) => row.ratio);
            const baRatios = rows.filter((row) => row.order === "BA").map((row) => row.ratio);
            const medianAbRatio = medianFive(abRatios, `seed=${seed} map=${gridType} AB`);
            const medianBaRatio = medianFive(baRatios, `seed=${seed} map=${gridType} BA`);
            return {
                seed,
                gridType,
                abRatios,
                baRatios,
                medianAbRatio,
                medianBaRatio,
                robustRatio: Math.sqrt(medianAbRatio * medianBaRatio),
            };
        }),
    );
}

function bootstrap(captures: readonly IValidatedCapture[]): Record<string, number[]> {
    const byId = new Map(captures.map((capture) => [capture.id, capture]));
    const capturePairs = ORIGINAL_CAPTURE_IDS.map(
        (originalId, index) => [byId.get(originalId)!, byId.get(INVERTED_CAPTURE_IDS[index])!] as const,
    );
    let state = BOOTSTRAP_SEED >>> 0;
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
    const output: Record<string, number[]> = {
        totalRatio: [],
        geometricRatio: [],
        robustP99: [],
        abTotalRatio: [],
        baTotalRatio: [],
    };
    for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
        const sampledCaptures = Array.from(
            { length: 5 },
            () => capturePairs[Math.floor(random() * capturePairs.length)],
        ).flat();
        const sampledSeeds = Array.from(
            { length: NATURAL_SEEDS.length },
            () => NATURAL_SEEDS[Math.floor(random() * NATURAL_SEEDS.length)],
        );
        let baselineNs = 0;
        let candidateNs = 0;
        let logRatio = 0;
        let count = 0;
        let abBaselineNs = 0;
        let abCandidateNs = 0;
        let baBaselineNs = 0;
        let baCandidateNs = 0;
        const robustRatios: number[] = [];
        for (const seed of sampledSeeds) {
            for (const gridType of NATURAL_GRID_TYPES) {
                const rows = sampledCaptures.map((capture) => capture.rowsByTask.get(taskKey(seed, gridType))!);
                const ab: number[] = [];
                const ba: number[] = [];
                for (const row of rows) {
                    baselineNs += row.baselineNs;
                    candidateNs += row.candidateNs;
                    logRatio += Math.log(row.ratio);
                    count++;
                    if (row.order === "AB") {
                        ab.push(row.ratio);
                        abBaselineNs += row.baselineNs;
                        abCandidateNs += row.candidateNs;
                    } else {
                        ba.push(row.ratio);
                        baBaselineNs += row.baselineNs;
                        baCandidateNs += row.candidateNs;
                    }
                }
                robustRatios.push(Math.sqrt(medianFive(ab, "bootstrap AB") * medianFive(ba, "bootstrap BA")));
            }
        }
        output.totalRatio.push(candidateNs / baselineNs);
        output.geometricRatio.push(Math.exp(logRatio / count));
        output.robustP99.push(quantile(robustRatios, 0.99));
        output.abTotalRatio.push(abCandidateNs / abBaselineNs);
        output.baTotalRatio.push(baCandidateNs / baBaselineNs);
    }
    return output;
}

function interval(values: readonly number[]): { lower95: number; median: number; upper95: number } {
    return {
        lower95: quantile(values, 0.025),
        median: quantile(values, 0.5),
        upper95: quantile(values, 0.975),
    };
}

function writeJsonAtomicExclusive(pathInput: string, value: unknown): void {
    const path = resolve(pathInput);
    const parent = dirname(path);
    if (
        !existsSync(parent) ||
        !lstatSync(parent).isDirectory() ||
        lstatSync(parent).isSymbolicLink() ||
        realpathSync(parent) !== parent
    ) {
        throw new Error(`Output parent changed or is not canonical: ${parent}`);
    }
    if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
    const temporary = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
        linkSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

async function main(): Promise<void> {
    const quantileAudit = auditType7Quantile();
    if (process.argv.slice(2).includes("--help")) {
        commandLine();
        return;
    }
    const aggregatorRuntimeBefore = auditAggregatorRuntime();
    const cli = commandLine();
    if (!cli) return;
    const runnerBefore = fileSeal(RUNNER_PATH);
    const quantileHelperBefore = fileSeal(QUANTILE_HELPER_PATH);
    const loadedProtocol = loadProtocol();
    validateAggregatorRuntimeBinding(aggregatorRuntimeBefore, loadedProtocol.value, "aggregator preflight");
    const semanticSchedule: ICaptureSchedule = {
        id: "semantic",
        seeds: [...NATURAL_SEEDS],
        gridTypes: [...NATURAL_GRID_TYPES],
        invertOrder: false,
    };
    const semantic = validateCapture(
        semanticSchedule,
        cli.semantic,
        loadedProtocol.value,
        loadedProtocol.seal,
        SEMANTIC_MAX_LAPS,
    );
    const micro = validateMicro(cli.micro, loadedProtocol.value);
    const profile = validateProfile(cli.profile, cli.profileDir, loadedProtocol.value);
    const captures = CAPTURE_SCHEDULES.map((schedule) =>
        validateCapture(schedule, cli.captures[schedule.id], loadedProtocol.value, loadedProtocol.seal),
    );
    const stagePaths: Record<string, string> = {
        semantic: cli.semantic,
        micro: cli.micro,
        profile: cli.profile,
        ...Object.fromEntries(CAPTURE_IDS.map((id) => [id, cli.captures[id]])),
    };
    const ledger = validateLedger(
        cli.ledger,
        loadedProtocol.seal,
        loadedProtocol.value,
        stagePaths,
        profile.directory,
        cli.out,
    );
    assertEqual(cli.out, join(ledger.outputRoot, "aggregate.json"), "campaign aggregate output path");
    assertEqual(
        requireRecord(
            requireRecord(aggregatorRuntimeBefore.workspace, "aggregator workspace before").configurationAbsence,
            "aggregator configuration absence before",
        ),
        expectedCampaignConfigurationAbsence(ledger.outputRoot, "aggregate"),
        "aggregator campaign configuration namespace",
    );
    for (const immutableRoot of [ledger.roots.baseline, ledger.roots.candidate, COMMON_ROOT, cli.profileDir]) {
        if (pathIsWithin(cli.out, immutableRoot)) {
            throw new Error(`Aggregate output overlaps governed root ${immutableRoot}`);
        }
    }
    for (const capture of [semantic, ...captures]) {
        const source = requireRecord(capture.report.source, `${capture.id} output source`);
        assertEqual(
            resolve(
                requireString(
                    requireRecord(source.baselineBefore, `${capture.id} baseline source`).root,
                    `${capture.id} baseline root`,
                ),
            ),
            ledger.roots.baseline,
            `${capture.id} ledger baseline root`,
        );
        assertEqual(
            resolve(
                requireString(
                    requireRecord(source.candidateBefore, `${capture.id} candidate source`).root,
                    `${capture.id} candidate root`,
                ),
            ),
            ledger.roots.candidate,
            `${capture.id} ledger candidate root`,
        );
    }
    const profileSourceBefore = requireRecord(
        requireRecord(profile.report.source, "profile output source").before,
        "profile source before",
    );
    assertEqual(
        resolve(
            requireString(
                requireRecord(profileSourceBefore.baseline, "profile baseline source").root,
                "profile baseline root",
            ),
        ),
        ledger.roots.baseline,
        "profile ledger baseline root",
    );
    assertEqual(
        resolve(
            requireString(
                requireRecord(profileSourceBefore.candidate, "profile candidate source").root,
                "profile candidate root",
            ),
        ),
        ledger.roots.candidate,
        "profile ledger candidate root",
    );
    const ledgerStages = new Map(ledger.stages.map((stage) => [stage.stage, stage]));
    validateAttemptBinding(semantic.report, ledgerStages.get("semantic")!, "generatedAt", "semantic corpus");
    validateAttemptBinding(micro.report, ledgerStages.get("micro")!, "createdAt", "micro evidence");
    validateAttemptBinding(profile.report, ledgerStages.get("profile")!, "createdAt", "profile evidence");
    for (const capture of captures) {
        validateAttemptBinding(capture.report, ledgerStages.get(capture.id)!, "generatedAt", `${capture.id} capture`);
    }
    const reference = captures[0];
    assertEqual(semantic.sourceIdentity, reference.sourceIdentity, "semantic corpus source identity");
    assertEqual(semantic.profileIdentity, reference.profileIdentity, "semantic corpus profile identity");
    assertEqual(semantic.hostIdentity, reference.hostIdentity, "semantic corpus host identity");
    for (const capture of captures.slice(1)) {
        assertEqual(capture.sourceIdentity, reference.sourceIdentity, `${capture.id} source identity`);
        assertEqual(capture.profileIdentity, reference.profileIdentity, `${capture.id} profile identity`);
        assertEqual(capture.hostIdentity, reference.hostIdentity, `${capture.id} host identity`);
        for (const seed of NATURAL_SEEDS) {
            for (const gridType of NATURAL_GRID_TYPES) {
                const key = taskKey(seed, gridType);
                assertPairEqual(
                    capture.semanticIdentityByTask.get(key),
                    reference.semanticIdentityByTask.get(key),
                    `${capture.id} semantics ${key}`,
                );
            }
        }
    }
    assertEqual(micro.hostIdentity, reference.hostIdentity, "micro/macro host identity");
    assertEqual(profile.hostIdentity, reference.hostIdentity, "profile/macro host identity");
    const allRows = captures.flatMap((capture) => capture.rows);
    if (allRows.length !== EXPECTED_GATES.exactTaskPairs) throw new Error("Pooled task count mismatch");
    const robustTasks = buildRobustTasks(captures);
    const robustRatios = robustTasks.map((task) => task.robustRatio);
    const distribution = bootstrap(captures);
    const intervals = {
        totalRatio: interval(distribution.totalRatio),
        geometricRatio: interval(distribution.geometricRatio),
        robustP99: interval(distribution.robustP99),
        abTotalRatio: interval(distribution.abTotalRatio),
        baTotalRatio: interval(distribution.baTotalRatio),
    };
    const captureTotals = captures.map((capture) => ({
        id: capture.id,
        invertOrder: capture.schedule.invertOrder,
        baselineTotalMs: sum(capture.rows.map((row) => row.baselineNs)) / 1_000_000,
        candidateTotalMs: sum(capture.rows.map((row) => row.candidateNs)) / 1_000_000,
        totalRatio: sum(capture.rows.map((row) => row.candidateNs)) / sum(capture.rows.map((row) => row.baselineNs)),
    }));
    const perMap = NATURAL_GRID_TYPES.map((gridType) => {
        const rows = allRows.filter((row) => row.gridType === gridType);
        return {
            gridType,
            observations: rows.length,
            totalRatio: sum(rows.map((row) => row.candidateNs)) / sum(rows.map((row) => row.baselineNs)),
        };
    });
    const pooledTotalRatio = sum(allRows.map((row) => row.candidateNs)) / sum(allRows.map((row) => row.baselineNs));
    const gates = {
        totalRatioBootstrapUpper95: {
            threshold: EXPECTED_GATES.totalRatioBootstrapUpper95Maximum,
            observed: intervals.totalRatio.upper95,
            passed: intervals.totalRatio.upper95 <= EXPECTED_GATES.totalRatioBootstrapUpper95Maximum,
        },
        geometricRatioBootstrapUpper95: {
            threshold: EXPECTED_GATES.geometricRatioBootstrapUpper95MaximumExclusive,
            observed: intervals.geometricRatio.upper95,
            passed: intervals.geometricRatio.upper95 < EXPECTED_GATES.geometricRatioBootstrapUpper95MaximumExclusive,
        },
        robustP50: {
            threshold: EXPECTED_GATES.robustP50MaximumExclusive,
            observed: quantile(robustRatios, 0.5),
            passed: quantile(robustRatios, 0.5) < EXPECTED_GATES.robustP50MaximumExclusive,
        },
        robustP99: {
            threshold: EXPECTED_GATES.robustP99MaximumExclusive,
            observed: quantile(robustRatios, 0.99),
            passed: quantile(robustRatios, 0.99) < EXPECTED_GATES.robustP99MaximumExclusive,
        },
        robustP99BootstrapUpper95: {
            threshold: EXPECTED_GATES.robustP99BootstrapUpper95Maximum,
            observed: intervals.robustP99.upper95,
            passed: intervals.robustP99.upper95 <= EXPECTED_GATES.robustP99BootstrapUpper95Maximum,
        },
        robustFasterTasks: {
            threshold: EXPECTED_GATES.minimumRobustFasterTasks,
            observed: robustRatios.filter((ratio) => ratio < 1).length,
            passed: robustRatios.filter((ratio) => ratio < 1).length >= EXPECTED_GATES.minimumRobustFasterTasks,
        },
        robustMaximumRatio: {
            threshold: EXPECTED_GATES.robustMaximumRatio,
            observed: Math.max(...robustRatios),
            passed: Math.max(...robustRatios) <= EXPECTED_GATES.robustMaximumRatio,
        },
        abTotalRatioBootstrapUpper95: {
            threshold: EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
            observed: intervals.abTotalRatio.upper95,
            passed: intervals.abTotalRatio.upper95 < EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
        },
        baTotalRatioBootstrapUpper95: {
            threshold: EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
            observed: intervals.baTotalRatio.upper95,
            passed: intervals.baTotalRatio.upper95 < EXPECTED_GATES.orderTotalBootstrapUpper95MaximumExclusive,
        },
        perMapTotalRatio: {
            threshold: EXPECTED_GATES.perMapTotalRatioMaximum,
            observed: Math.max(...perMap.map((row) => row.totalRatio)),
            passed: perMap.every((row) => row.totalRatio <= EXPECTED_GATES.perMapTotalRatioMaximum),
        },
        fasterCaptures: {
            threshold: EXPECTED_GATES.minimumFasterCaptures,
            observed: captureTotals.filter((capture) => capture.totalRatio < 1).length,
            passed:
                captureTotals.filter((capture) => capture.totalRatio < 1).length >=
                EXPECTED_GATES.minimumFasterCaptures,
        },
        captureTotalRatioMaximum: {
            threshold: EXPECTED_GATES.captureTotalRatioMaximum,
            observed: Math.max(...captureTotals.map((capture) => capture.totalRatio)),
            passed: captureTotals.every((capture) => capture.totalRatio <= EXPECTED_GATES.captureTotalRatioMaximum),
        },
    };
    const prerequisiteEvidenceValid =
        semantic.rows.length === TASKS_PER_CAPTURE &&
        micro.gates.passed &&
        profile.gates.passed &&
        ledger.stages.length === REQUIRED_LEDGER_STAGES.length;
    const eligible = prerequisiteEvidenceValid;
    const qualified = eligible && Object.values(gates).every((gate) => gate.passed);
    const aggregatorRuntimeAfter = auditAggregatorRuntime();
    validateAggregatorRuntimeBinding(aggregatorRuntimeAfter, loadedProtocol.value, "aggregator postflight");
    assertEqual(aggregatorRuntimeAfter, aggregatorRuntimeBefore, "aggregator runtime pre/post");
    const runnerAfter = fileSeal(RUNNER_PATH);
    assertEqual(runnerAfter, runnerBefore, "aggregation runner pre/post");
    const quantileHelperAfter = fileSeal(QUANTILE_HELPER_PATH);
    assertEqual(quantileHelperAfter, quantileHelperBefore, "shared quantile helper pre/post");
    assertEqual(fileSeal(PROTOCOL_PATH), loadedProtocol.seal, "protocol pre/post");
    assertEqual(fileSeal(semantic.file.path), semantic.file, "semantic corpus file pre/post");
    assertEqual(fileSeal(micro.file.path), micro.file, "micro file pre/post");
    assertEqual(fileSeal(profile.file.path), profile.file, "profile file pre/post");
    assertEqual(fileSeal(ledger.file.path), ledger.file, "ledger file pre/post");
    if (
        !lstatSync(profile.directory.path).isDirectory() ||
        lstatSync(profile.directory.path).isSymbolicLink() ||
        realpathSync(profile.directory.path) !== profile.directory.realPath
    ) {
        throw new Error("profile sidecar directory changed identity");
    }
    const profileFilesAfter = readdirSync(profile.directory.path)
        .sort()
        .map((name) => {
            const path = join(profile.directory.path, name);
            if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
                throw new Error(`profile sidecar changed type: ${name}`);
            }
            return fileSeal(path);
        });
    const profileDirectoryAfter = {
        path: profile.directory.path,
        realPath: profile.directory.realPath,
        entryCount: profileFilesAfter.length,
        bytes: sum(profileFilesAfter.map((sidecar) => sidecar.bytes)),
        files: profileFilesAfter,
        manifestSha256: digest(
            profileFilesAfter.map((sidecar) => ({
                name: basename(sidecar.path),
                bytes: sidecar.bytes,
                sha256: sidecar.sha256,
            })),
        ),
        campaignManifestSha256: sha256(
            JSON.stringify(
                profileFilesAfter.map((sidecar) => ({
                    path: basename(sidecar.path),
                    kind: "file",
                    bytes: sidecar.bytes,
                    sha256: sidecar.sha256,
                })),
            ),
        ),
    };
    assertEqual(profileDirectoryAfter, profile.directory, "profile sidecar directory pre/post");
    for (const capture of captures) assertEqual(fileSeal(capture.file.path), capture.file, `${capture.id} file`);
    const failedGates = Object.entries(gates)
        .filter(([, gate]) => !gate.passed)
        .map(([name, gate]) => ({ name, observed: gate.observed, threshold: gate.threshold }));
    const report = {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        protocol: {
            file: loadedProtocol.seal,
            schema: PROTOCOL_SCHEMA,
            date: PROTOCOL_DATE,
            baselineCommit: BASELINE_COMMIT,
            candidateCommit: CANDIDATE_COMMIT,
            quantile: {
                schema: TYPE7_QUANTILE_SCHEMA,
                sharedProducerVerifierImplementation: true,
                audit: quantileAudit,
            },
        },
        aggregationRunner: { before: runnerBefore, after: runnerAfter, unchanged: true },
        quantileHelper: { before: quantileHelperBefore, after: quantileHelperAfter, unchanged: true },
        aggregationRuntime: {
            before: aggregatorRuntimeBefore,
            after: aggregatorRuntimeAfter,
            unchanged: true,
        },
        prerequisiteEvidence: {
            valid: prerequisiteEvidenceValid,
            ledger,
            semantic: {
                file: semantic.file,
                report: semantic.report,
                command: requireRecord(semantic.report.command, "semantic output command"),
                timingPooled: false,
                sourceIdentity: semantic.sourceIdentity,
                profileIdentity: semantic.profileIdentity,
                hostIdentity: semantic.hostIdentity,
                exactness: semantic.report.exactness,
                rows: semantic.rows,
                semanticIdentityByTask: Object.fromEntries(semantic.semanticIdentityByTask),
            },
            micro: {
                file: micro.file,
                report: micro.report,
                hostIdentity: micro.hostIdentity,
                sourceIdentity: micro.sourceIdentity,
                gates: micro.gates,
            },
            profile: {
                file: profile.file,
                report: profile.report,
                directory: profile.directory,
                hostIdentity: profile.hostIdentity,
                sourceIdentity: profile.sourceIdentity,
                gates: profile.gates,
                rawAttributionRecomputed: false,
                limitation:
                    "The producer's sealed sidecars and every derived gate are validated, but this aggregator " +
                    "does not independently reconstruct Chrome profile stacks.",
            },
        },
        captures: captures.map((capture) => ({
            id: capture.id,
            schedule: capture.schedule,
            file: capture.file,
            totalRatio: captureTotals.find((row) => row.id === capture.id)!.totalRatio,
            hostIdentity: capture.hostIdentity,
            sourceIdentity: capture.sourceIdentity,
            profileIdentity: capture.profileIdentity,
            semanticIdentityByTask: Object.fromEntries(capture.semanticIdentityByTask),
            rows: capture.report.rows,
            validatedRows: capture.rows,
        })),
        exactness: {
            passed: true,
            taskPairs: allRows.length,
            measuredMatches: allRows.length * 2,
            semanticMismatchCount: 0,
            rejectedActions: 0,
            stuckMatches: 0,
            exceptions: 0,
            semanticIdentitySha256: pairDigest(
                NATURAL_SEEDS.flatMap((seed) =>
                    NATURAL_GRID_TYPES.map((gridType) => reference.semanticIdentityByTask.get(taskKey(seed, gridType))),
                ),
            ),
        },
        performance: {
            pooledTotalRatio,
            bootstrapSamples: BOOTSTRAP_SAMPLES,
            bootstrapSeed: BOOTSTRAP_SEED,
            intervals,
            robust: {
                p50: quantile(robustRatios, 0.5),
                p95: quantile(robustRatios, 0.95),
                p99: quantile(robustRatios, 0.99),
                maximum: Math.max(...robustRatios),
                fasterTasks: robustRatios.filter((ratio) => ratio < 1).length,
                totalTasks: robustRatios.length,
            },
            captureTotals,
            perMap,
            gates,
            failedGates,
        },
        robustTasks,
        qualification: {
            eligible,
            passed: qualified,
            prerequisiteEvidenceValid,
            rejectedFirstLayerEvidencePooled: false,
            stoppingRule:
                "Exactly r0-r9; no selective rerun, added capture, trimming, winsorization, or threshold change.",
        },
    };
    writeJsonAtomicExclusive(cli.out, report);
    console.log(
        JSON.stringify({
            out: cli.out,
            qualified,
            pooledTotalRatio,
            robustP99: report.performance.robust.p99,
            failedGates,
        }),
    );
    if (!qualified) process.exitCode = 1;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
