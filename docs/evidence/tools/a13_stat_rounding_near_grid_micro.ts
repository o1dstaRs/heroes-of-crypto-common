#!/usr/bin/env bun

/**
 * A13 stat-rounding exactness oracle and paired microbenchmark.
 *
 * Evidence:
 *   bun docs/evidence/tools/a13_stat_rounding_near_grid_micro.ts \
 *     --out=/tmp/a13-stat-rounding-near-grid-micro.json
 *
 * Short performance smoke (the full deterministic correctness corpus still runs):
 *   bun docs/evidence/tools/a13_stat_rounding_near_grid_micro.ts \
 *     --smoke --out=/tmp/a13-stat-rounding-near-grid-micro-smoke.json
 *
 * This runner deliberately imports the candidate only after verifying the realm-startup contract that
 * stat_rounding.ts relies on. Correctness mutation probes and production-trace capture are untimed and are
 * restored before warmup. Evidence timing uses 60 paired blocks with a balanced four-block ABBA/BAAB schedule.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { arch, cpus, homedir, platform, release } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { auditType7Quantile, type7Quantile, TYPE7_QUANTILE_SCHEMA } from "./a13_stat_rounding_near_grid_quantile";

const SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-micro/v3" as const;
const RUNNER_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(RUNNER_PATH), "../../..");
const SOURCE_ROOT = join(ROOT, "src");
const WORKSPACE_ROOT = resolve(ROOT, "../..");
const WORKSPACE_LOCK_PATH = join(WORKSPACE_ROOT, "bun.lock");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const TSCONFIG_JSON_PATH = join(ROOT, "tsconfig.json");
const BUNFIG_TOML_PATH = join(ROOT, "bunfig.toml");
const CREATURES_PATH = join(ROOT, "src/configuration/creatures.json");
const QUANTILE_HELPER_PATH = resolve(dirname(RUNNER_PATH), "a13_stat_rounding_near_grid_quantile.ts");
const EXPECTED_CANDIDATE_COMMIT = "77ee4616688f764fcfe49d4a1b15ec19e1ef384e";
const EXPECTED_SOURCE_MANIFEST_SHA256 = "ce24e407ee41f2e0c90954345a05ddfc0281b65080f152b80a6fd269a8a6f234";
const EXPECTED_PACKAGE_JSON_SHA256 = "990a779e01b64fab88bdb72cb7fd6fa790eabc66a2f550d1e3481d620e1cf001";
const EXPECTED_TSCONFIG_JSON_SHA256 = "013d77997ebb76aabe5f12044db25f7eadf57565d2cd7670f2320b073972c383";
const EXPECTED_BUNFIG_TOML_SHA256 = "4a55c242db51f5ab64ce7df1ef8401f7815bd10ef28e42bf1a7d4f68168aa3cc";
const EXPECTED_WORKSPACE_LOCK_SHA256 = "227ac3cc87c8488dea87841311baf509e361c22610ffc0ee21c553245e58ab54";
const EXPECTED_BUN_EXECUTABLE_SHA256 = "e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233";
const MICRO_MANIFEST_CODEC = "heroes-of-crypto/a13-stat-rounding-near-grid-micro-manifest/type-tagged-v1" as const;
const RUNTIME_DEPENDENCY_NAMES = Object.freeze(["denque", "google-protobuf"] as const);
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
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
const RUNTIME_PATHS = Object.freeze([
    join(ROOT, "src/units/stat_rounding.ts"),
    join(ROOT, "src/units/unit.ts"),
    CREATURES_PATH,
]);

const RAW_FLOAT64_PATTERNS = 1_000_000;
const RAW_FLOAT64_SEED = 0x9e37_79b9_7f4a_7c15n;
const RAW_FLOAT64_MASK = (1n << 64n) - 1n;
const MAX_EXACT_SCALED_INTEGER = 2 ** 52;
const NEAR_GRID_SCALED_LIMIT = 2 ** 30;
const NEAR_GRID_MAX_DISTANCE = 0.25;
const NEAR_GRID_RANDOM_CASES = 50_000;
const EVIDENCE_BLOCKS = 60;
const EVIDENCE_TARGET_MS = 35;
const EVIDENCE_TIMED_ARM_FLOOR_MS = 17.5;
const EVIDENCE_WARMUP_MS = 750;
const EVIDENCE_BOOTSTRAP_SAMPLES = 20_000;
const SMOKE_BLOCKS = 8;
const SMOKE_TARGET_MS = 8;
const SMOKE_TIMED_ARM_FLOOR_MS = 4;
const SMOKE_WARMUP_MS = 150;
const SMOKE_BOOTSTRAP_SAMPLES = 2_000;
const BOOTSTRAP_SEED = 0xa135_7a71;
const MAX_CYCLES_PER_BLOCK = 10_000_000;
const BOOTSTRAP_SUPERBLOCK_SIZE = 4;
const EXACT_GRID_RATIO_UPPER_95_GATE = 0.45;
const ACTUAL_TRACE_RATIO_UPPER_95_GATE = 0.7;
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
    "MALLOC_",
    "Malloc",
]);
const REQUIRED_EXECUTION_ENVIRONMENT = Object.freeze({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
});
const FORBIDDEN_EXEC_ARGV_FLAGS = Object.freeze([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--preload",
]);
const EXPECTED_NATIVE_FUNCTIONS = Object.freeze([
    {
        label: "Function.prototype.toString",
        name: "toString",
        length: 0,
        nativeSourceSha256: "14e89f65c8f615e78a921e427745d694c9be449421207ad27860575741ce6068",
    },
    {
        label: "Number",
        name: "Number",
        length: 1,
        nativeSourceSha256: "9a6eb610f91809c3ae9bb04ab9cbc0a97e471f64d02099e6993f1c981cabd8e5",
    },
    {
        label: "Number.prototype.toFixed",
        name: "toFixed",
        length: 1,
        nativeSourceSha256: "6fd2e7ec90562d96c2c0c3f428c78efb40938ac9dcd224ae2033edf6a676501e",
    },
    {
        label: "Number.isSafeInteger",
        name: "isSafeInteger",
        length: 1,
        nativeSourceSha256: "08f8fa7d0b5e9c917873a97efab3d3dc30e6e1fc8aa846edf32d3508de99735a",
    },
    {
        label: "Reflect.apply",
        name: "apply",
        length: 3,
        nativeSourceSha256: "ecf1a1a012a3f06a7dd0c0267e1f2be429aab7d64d29fc318e6acf733e554332",
    },
    {
        label: "process.hrtime",
        name: "hrtime",
        length: 0,
        nativeSourceSha256: "8d7372efb0cec13469e60491554ce3777647371afb42eaa2452e8991b961e64a",
    },
    {
        label: "process.hrtime.bigint",
        name: "bigint",
        length: 0,
        nativeSourceSha256: "dcd68afd0903329bfbd866993a686ea597de8bb3ce75d2d1bd4902d2e01fe723",
    },
]);

type ArmName = "legacy" | "candidate";
type WorkloadName = "exactGrid" | "actualTrace";
type RunMode = "evidence" | "smoke";
type FractionDigits = 1 | 2;
type Round = (value: number, fractionDigits: FractionDigits) => number;
type RuntimeRound = (value: unknown, fractionDigits: unknown) => number;
type MonotonicClock = () => bigint;
type RuntimeDependencyName = (typeof RUNTIME_DEPENDENCY_NAMES)[number];
type FastEligibilityKind = "exactGrid" | "nearGrid" | "numericFallback";

interface IFastEligibility {
    kind: FastEligibilityKind;
    scaled: number;
    nearestScaledInteger: number | null;
    resultNegativeZero: boolean;
}

interface ICli {
    mode: RunMode;
    attemptId: string;
    out: string;
    blocks: number;
    targetMs: number;
    timedArmFloorMs: number;
    warmupMs: number;
    bootstrapSamples: number;
}

interface IRoundCase {
    value: number;
    fractionDigits: FractionDigits;
}

interface ITraceCase extends IRoundCase {
    faction: string;
    creature: string;
    scenario: string;
    ordinal: number;
}

type AdjustBaseStatsArgs = [
    hasFightStarted: boolean,
    currentLap: number,
    synergyAbilityPowerIncrease: number,
    synergyMovementStepsIncrease: number,
    synergyFlyArmorIncrease: number,
    synergyMoraleIncrease: number,
    synergyLuckIncrease: number,
    stepsMoraleMultiplier: number,
];

interface IMeasurement {
    durationNs: number;
    operations: number;
    nanosecondsPerOperation: number;
    checksum: number;
}

interface IRawBlock {
    block: number;
    armOrder: ArmName[];
    workloadOrder: WorkloadName[];
    workloads: Record<WorkloadName, Record<ArmName, IMeasurement>>;
}

interface ISourceEntry {
    path: string;
    kind: "file" | "symlink";
    bytes: number;
    sha256: string;
}

interface IFileSeal {
    path: string;
    realPath: string;
    bytes: number;
    sha256: string;
}

interface IDirectorySeal {
    root: string;
    realRoot: string;
    entryCount: number;
    bytes: number;
    manifestCodec: typeof MICRO_MANIFEST_CODEC;
    manifestSha256: string;
}

interface IRunSeal {
    root: string;
    realRoot: string;
    workspaceRoot: string;
    realWorkspaceRoot: string;
    gitHead: string;
    gitTree: string;
    source: {
        entries: number;
        bytes: number;
        manifestSha256: string;
        runtimeSha256: Record<string, string>;
    };
    runner: IFileSeal;
    quantileHelper: IFileSeal;
    packageJson: IFileSeal;
    tsconfigJson: IFileSeal;
    bunfigToml: IFileSeal;
    workspaceLock: IFileSeal;
    runtimeDependencies: Record<RuntimeDependencyName, IDirectorySeal>;
    runtimeResolution: Record<
        RuntimeDependencyName,
        { resolvedPath: string; realPath: string; withinSealedRoot: true }
    >;
    bunExecutable: IFileSeal;
    dependencies: {
        recursivelySealed: true;
        manifestCodec: typeof MICRO_MANIFEST_CODEC;
        commonNodeModulesRealPath: string;
        workspaceNodeModulesRealPath: string;
        limitation: string;
    };
    identitySha256: string;
}

interface IStartupIntrinsics {
    number: NumberConstructor;
    numberDescriptor: PropertyDescriptor;
    numberIsSafeInteger: typeof Number.isSafeInteger;
    numberIsSafeIntegerDescriptor: PropertyDescriptor;
    toFixed: typeof Number.prototype.toFixed;
    toFixedDescriptor: PropertyDescriptor;
    reflectApply: typeof Reflect.apply;
    reflectApplyDescriptor: PropertyDescriptor;
    functionToString: typeof Function.prototype.toString;
    hrtime: typeof process.hrtime;
    hrtimeDescriptor: PropertyDescriptor;
    hrtimeBigint: typeof process.hrtime.bigint;
    hrtimeBigintDescriptor: PropertyDescriptor;
    report: Record<string, unknown>;
}

interface INativeFunctionLocation {
    label: string;
    owner: object;
    key: PropertyKey;
    value: Function;
}

interface IInterval {
    lower95: number;
    median: number;
    upper95: number;
    samples: number;
}

// Every arm occupies each position twice over four blocks; both transition directions are balanced.
const BALANCED_ARM_ORDERS: readonly (readonly ArmName[])[] = [
    ["legacy", "candidate"],
    ["candidate", "legacy"],
    ["candidate", "legacy"],
    ["legacy", "candidate"],
];

const WORKLOAD_NAMES: readonly WorkloadName[] = ["exactGrid", "actualTrace"];

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const normalizedPath = (path: string): string => path.split(sep).join("/");

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) result[key] = canonicalize(item);
        }
        return result;
    }
    return value;
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const digest = (value: unknown): string => sha256(canonicalJson(value));
const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

interface IMicroManifestCanonicalState {
    nextObjectId: number;
    objectIds: WeakMap<object, number>;
}

function microManifestCanonicalize(value: unknown, state: IMicroManifestCanonicalState): unknown {
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
        throw new Error(`Micro manifest codec does not support ${typeof value} values`);
    }
    if (typeof value !== "object") {
        throw new Error(`Micro manifest codec does not support ${typeof value} values`);
    }

    const existingId = state.objectIds.get(value);
    if (existingId !== undefined) return ["reference", existingId];
    const objectId = state.nextObjectId++;
    state.objectIds.set(value, objectId);

    if (Array.isArray(value)) {
        const slots = Array.from({ length: value.length }, (_, index) =>
            Object.hasOwn(value, index) ? microManifestCanonicalize(value[index], state) : ["array-hole"],
        );
        const extraKeys = Object.keys(value)
            .filter((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
            .sort(compareStrings)
            .map((key) => [key, microManifestCanonicalize((value as unknown as Record<string, unknown>)[key], state)]);
        const allowedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
        for (const key of Reflect.ownKeys(value)) {
            if (
                typeof key === "symbol" ||
                (typeof key === "string" &&
                    !allowedKeys.has(key) &&
                    !extraKeys.some(([candidate]) => candidate === key))
            ) {
                throw new Error("Micro manifest codec encountered an unsupported array property");
            }
        }
        return ["array", objectId, slots, extraKeys];
    }
    if (value instanceof Map) {
        if (Reflect.ownKeys(value).length > 0) {
            throw new Error("Micro manifest codec does not support custom Map properties");
        }
        return [
            "map",
            objectId,
            [...value.entries()].map(([key, child]) => [
                microManifestCanonicalize(key, state),
                microManifestCanonicalize(child, state),
            ]),
        ];
    }
    if (value instanceof Set) {
        if (Reflect.ownKeys(value).length > 0) {
            throw new Error("Micro manifest codec does not support custom Set properties");
        }
        return ["set", objectId, [...value.values()].map((child) => microManifestCanonicalize(child, state))];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Micro manifest codec does not support ${prototype?.constructor?.name ?? "unknown"} objects`);
    }
    const keys = Object.keys(value).sort(compareStrings);
    const ownKeys = Reflect.ownKeys(value);
    if (
        ownKeys.some((key) => typeof key === "symbol") ||
        ownKeys.some((key) => typeof key === "string" && !keys.includes(key))
    ) {
        throw new Error("Micro manifest codec requires enumerable string-keyed plain objects");
    }
    return [
        prototype === null ? "null-prototype-object" : "object",
        objectId,
        keys.map((key) => [key, microManifestCanonicalize((value as Record<string, unknown>)[key], state)]),
    ];
}

const microManifestJson = (value: unknown): string =>
    JSON.stringify(
        microManifestCanonicalize(value, {
            nextObjectId: 0,
            objectIds: new WeakMap<object, number>(),
        }),
    );
const microManifestDigest = (value: unknown): string => sha256(microManifestJson(value));

function requiredDescriptor(object: object, key: PropertyKey, context: string): PropertyDescriptor {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) throw new Error(`Missing startup descriptor: ${context}`);
    return descriptor;
}

function assertStandardDataDescriptor(
    descriptor: PropertyDescriptor,
    expectedValue: unknown,
    context: string,
    expectedEnumerable = false,
): void {
    if (
        descriptor.value !== expectedValue ||
        descriptor.writable !== true ||
        descriptor.enumerable !== expectedEnumerable ||
        descriptor.configurable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
    ) {
        throw new Error(`${context} is not the standard writable, non-enumerable data property`);
    }
}

function auditRuntimeInjection(): Record<string, unknown> {
    const environmentKeys = Object.keys(process.env).sort();
    const presentEnvironmentKeys = environmentKeys.filter(
        (key) =>
            FORBIDDEN_INJECTION_ENVIRONMENT_KEYS.includes(
                key as (typeof FORBIDDEN_INJECTION_ENVIRONMENT_KEYS)[number],
            ) || FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    const execArgv = [...process.execArgv];
    const governedEnvironment = Object.fromEntries(
        Object.keys(REQUIRED_EXECUTION_ENVIRONMENT)
            .sort()
            .map((key) => [key, process.env[key] ?? null]),
    );
    if (
        presentEnvironmentKeys.length > 0 ||
        execArgv.length > 0 ||
        canonicalJson(governedEnvironment) !== canonicalJson(REQUIRED_EXECUTION_ENVIRONMENT)
    ) {
        throw new Error(
            `Runtime injection audit failed: environment=${presentEnvironmentKeys.join(",")} ` +
                `execArgv=${execArgv.join(",")} governed=${canonicalJson(governedEnvironment)}`,
        );
    }
    return {
        passed: true,
        forbiddenEnvironmentKeys: FORBIDDEN_INJECTION_ENVIRONMENT_KEYS,
        forbiddenEnvironmentPrefixes: FORBIDDEN_INJECTION_ENVIRONMENT_PREFIXES,
        presentEnvironmentKeys,
        forbiddenExecArgvFlags: FORBIDDEN_EXEC_ARGV_FLAGS,
        execArgv,
        execArgvExactlyEmpty: true,
        requiredExecutionEnvironment: REQUIRED_EXECUTION_ENVIRONMENT,
        governedEnvironment,
    };
}

function auditStandardNumericRealm(): Record<string, unknown> {
    const locations: INativeFunctionLocation[] = [
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
        { label: "process.hrtime", owner: process, key: "hrtime", value: process.hrtime },
        {
            label: "process.hrtime.bigint",
            owner: process.hrtime,
            key: "bigint",
            value: process.hrtime.bigint,
        },
    ];
    const functions = locations.map((location, index) => {
        const expected = EXPECTED_NATIVE_FUNCTIONS[index];
        if (location.label !== expected.label) throw new Error(`Realm audit definition drift at ${location.label}`);
        const descriptor = requiredDescriptor(location.owner, location.key, location.label);
        const expectedEnumerable = location.label.startsWith("process.hrtime");
        assertStandardDataDescriptor(descriptor, location.value, location.label, expectedEnumerable);
        if (location.value.name !== expected.name || location.value.length !== expected.length) {
            throw new Error(`Non-standard name/length for ${location.label}`);
        }
        const nativeSource = Function.prototype.toString.call(location.value);
        const nativeSourceSha256 = sha256(nativeSource);
        if (!nativeSource.includes("[native code]") || nativeSourceSha256 !== expected.nativeSourceSha256) {
            throw new Error(`Non-standard native implementation for ${location.label}`);
        }
        return {
            label: location.label,
            name: location.value.name,
            length: location.value.length,
            descriptor: { writable: true, enumerable: expectedEnumerable, configurable: true, data: true },
            nativeMarker: true,
            nativeSourceSha256,
        };
    });
    return {
        passed: true,
        standardDescriptorsVerified: true,
        nativeFunctionNamesAndLengthsVerified: true,
        nativeFunctionSourcesVerified: true,
        functions,
    };
}

function assertUnmodifiedRealmStartup(): IStartupIntrinsics {
    const number = Number;
    const numberIsSafeInteger = Number.isSafeInteger;
    const toFixed = Number.prototype.toFixed;
    const reflectApply = Reflect.apply;
    const functionToString = Function.prototype.toString;
    const hrtime = process.hrtime;
    const hrtimeBigint = hrtime.bigint;
    const numberDescriptor = requiredDescriptor(globalThis, "Number", "globalThis.Number");
    const numberIsSafeIntegerDescriptor = requiredDescriptor(Number, "isSafeInteger", "Number.isSafeInteger");
    const toFixedDescriptor = requiredDescriptor(Number.prototype, "toFixed", "Number.prototype.toFixed");
    const reflectApplyDescriptor = requiredDescriptor(Reflect, "apply", "Reflect.apply");
    const hrtimeDescriptor = requiredDescriptor(process, "hrtime", "process.hrtime");
    const hrtimeBigintDescriptor = requiredDescriptor(hrtime, "bigint", "process.hrtime.bigint");

    assertStandardDataDescriptor(numberDescriptor, number, "globalThis.Number");
    assertStandardDataDescriptor(numberIsSafeIntegerDescriptor, numberIsSafeInteger, "Number.isSafeInteger");
    assertStandardDataDescriptor(toFixedDescriptor, toFixed, "Number.prototype.toFixed");
    assertStandardDataDescriptor(reflectApplyDescriptor, reflectApply, "Reflect.apply");
    assertStandardDataDescriptor(hrtimeDescriptor, hrtime, "process.hrtime", true);
    assertStandardDataDescriptor(hrtimeBigintDescriptor, hrtimeBigint, "process.hrtime.bigint", true);

    const numericAudit = auditStandardNumericRealm();

    return {
        number,
        numberDescriptor,
        numberIsSafeInteger,
        numberIsSafeIntegerDescriptor,
        toFixed,
        toFixedDescriptor,
        reflectApply,
        reflectApplyDescriptor,
        functionToString,
        hrtime,
        hrtimeDescriptor,
        hrtimeBigint,
        hrtimeBigintDescriptor,
        report: {
            passed: true,
            checkedBeforeCandidateImport: true,
            contract:
                "Number, Number.prototype.toFixed, Number.isSafeInteger, Reflect.apply, and " +
                "Function.prototype.toString plus process.hrtime and process.hrtime.bigint are the realm's " +
                "standard native built-ins before stat_rounding.ts loads",
            descriptorPolicy:
                "writable/configurable data properties with exact identities; numeric intrinsics are " +
                "non-enumerable and Bun's process.hrtime properties are enumerable",
            monotonicClockCapturedBeforeCandidateImport: true,
            exactNativeAudit: numericAudit,
        },
    };
}

function assertRealmRestored(startup: IStartupIntrinsics, context: string): void {
    assertStandardDataDescriptor(
        requiredDescriptor(globalThis, "Number", `${context}/globalThis.Number`),
        startup.number,
        `${context}/globalThis.Number`,
    );
    assertStandardDataDescriptor(
        requiredDescriptor(startup.number, "isSafeInteger", `${context}/Number.isSafeInteger`),
        startup.numberIsSafeInteger,
        `${context}/Number.isSafeInteger`,
    );
    assertStandardDataDescriptor(
        requiredDescriptor(startup.number.prototype, "toFixed", `${context}/Number.prototype.toFixed`),
        startup.toFixed,
        `${context}/Number.prototype.toFixed`,
    );
    assertStandardDataDescriptor(
        requiredDescriptor(Reflect, "apply", `${context}/Reflect.apply`),
        startup.reflectApply,
        `${context}/Reflect.apply`,
    );
    assertStandardDataDescriptor(
        requiredDescriptor(process, "hrtime", `${context}/process.hrtime`),
        startup.hrtime,
        `${context}/process.hrtime`,
        true,
    );
    assertStandardDataDescriptor(
        requiredDescriptor(startup.hrtime, "bigint", `${context}/process.hrtime.bigint`),
        startup.hrtimeBigint,
        `${context}/process.hrtime.bigint`,
        true,
    );
}

function commandLine(): ICli {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
            out: { type: "string" },
            "attempt-id": { type: "string" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(
            "Usage: bun docs/evidence/tools/a13_stat_rounding_near_grid_micro.ts " +
                "--attempt-id=UUID --out=REPORT.json [--smoke]",
        );
        process.exit(0);
    }
    if (
        !values["attempt-id"] ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values["attempt-id"])
    ) {
        throw new Error("--attempt-id must be a lowercase UUIDv4");
    }
    if (!values.out?.trim()) throw new Error("--out is required");
    const out = resolve(values.out);
    if (existsSync(out)) throw new Error(`Refusing to overwrite report: ${out}`);
    const mode: RunMode = values.smoke ? "smoke" : "evidence";
    return {
        mode,
        attemptId: values["attempt-id"],
        out,
        blocks: mode === "evidence" ? EVIDENCE_BLOCKS : SMOKE_BLOCKS,
        targetMs: mode === "evidence" ? EVIDENCE_TARGET_MS : SMOKE_TARGET_MS,
        timedArmFloorMs: mode === "evidence" ? EVIDENCE_TIMED_ARM_FLOOR_MS : SMOKE_TIMED_ARM_FLOOR_MS,
        warmupMs: mode === "evidence" ? EVIDENCE_WARMUP_MS : SMOKE_WARMUP_MS,
        bootstrapSamples: mode === "evidence" ? EVIDENCE_BOOTSTRAP_SAMPLES : SMOKE_BOOTSTRAP_SAMPLES,
    };
}

function collectSourceEntries(directory: string, root: string, entries: ISourceEntry[]): void {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        const path = join(directory, item.name);
        const relativePath = normalizedPath(relative(root, path));
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            collectSourceEntries(path, root, entries);
        } else if (stats.isSymbolicLink()) {
            const target = readlinkSync(path);
            entries.push({
                path: relativePath,
                kind: "symlink",
                bytes: Buffer.byteLength(target),
                sha256: sha256(target),
            });
        } else if (stats.isFile()) {
            entries.push({
                path: relativePath,
                kind: "file",
                bytes: stats.size,
                sha256: sha256(readFileSync(path)),
            });
        }
    }
}

function collectMicroManifestEntries(directory: string, root: string, entries: ISourceEntry[]): void {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        compareStrings(left.name, right.name),
    )) {
        const path = join(directory, item.name);
        const stats = lstatSync(path);
        if (stats.isDirectory()) {
            collectMicroManifestEntries(path, root, entries);
        } else if (stats.isFile()) {
            const bytes = readFileSync(path);
            entries.push({
                path: normalizedPath(relative(root, path)),
                kind: "file",
                bytes: bytes.byteLength,
                sha256: sha256(bytes),
            });
        } else if (stats.isSymbolicLink()) {
            const target = readlinkSync(path);
            entries.push({
                path: normalizedPath(relative(root, path)),
                kind: "symlink",
                bytes: Buffer.byteLength(target),
                sha256: sha256(target),
            });
        } else {
            throw new Error(`Unsupported micro manifest entry: ${path}`);
        }
    }
}

function fileSeal(pathInput: string): IFileSeal {
    const path = resolve(pathInput);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Expected a regular non-symlink file: ${path}`);
    const bytes = readFileSync(path);
    return { path, realPath: realpathSync(path), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function directorySeal(pathInput: string): IDirectorySeal {
    const root = resolve(pathInput);
    const realRoot = realpathSync(root);
    const entries: ISourceEntry[] = [];
    collectMicroManifestEntries(realRoot, realRoot, entries);
    entries.sort((left, right) => compareStrings(left.path, right.path));
    return {
        root,
        realRoot,
        entryCount: entries.length,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        manifestCodec: MICRO_MANIFEST_CODEC,
        manifestSha256: microManifestDigest(entries),
    };
}

function isPathWithin(path: string, root: string): boolean {
    const resolvedPath = resolve(path);
    const resolvedRoot = resolve(root);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function auditBunConfigFiles(): Record<string, unknown> {
    const realRoot = realpathSync(ROOT);
    if (realpathSync(process.cwd()) !== realRoot) {
        throw new Error(`Micro runner must start with cwd exactly ${realRoot}`);
    }
    const paths = [
        { label: "runner/bunfig.local.toml", path: join(ROOT, "bunfig.local.toml") },
        { label: "runner/.bunfig.toml", path: join(ROOT, ".bunfig.toml") },
        { label: "home/.bunfig.toml", path: join(homedir(), ".bunfig.toml") },
        { label: "home/.config/bunfig.toml", path: join(homedir(), ".config/bunfig.toml") },
        { label: "home/.config/bun/bunfig.toml", path: join(homedir(), ".config/bun/bunfig.toml") },
    ];
    const present = paths.filter((entry) => existsSync(entry.path)).map((entry) => entry.label);
    if (present.length > 0) throw new Error(`Forbidden Bun config files are present: ${present.join(",")}`);
    return {
        passed: true,
        cwd: process.cwd(),
        realCwd: realpathSync(process.cwd()),
        requiredCwd: realRoot,
        checked: paths.map((entry) => entry.label),
        present,
        xdgConfig: {
            environmentKey: "XDG_CONFIG_HOME",
            environmentValue: process.env.XDG_CONFIG_HOME ?? null,
            effectiveLocation: "home/.config",
            bunConfigCandidatesAbsent: true,
        },
    };
}

function gitValue(...args: string[]): string {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function runSeal(): IRunSeal {
    for (const path of RUNTIME_PATHS) {
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Required source is missing: ${path}`);
    }
    for (const path of [PACKAGE_JSON_PATH, TSCONFIG_JSON_PATH, BUNFIG_TOML_PATH, WORKSPACE_LOCK_PATH]) {
        if (!existsSync(path) || !statSync(path).isFile())
            throw new Error(`Required runtime input is missing: ${path}`);
    }
    const entries: ISourceEntry[] = [];
    collectSourceEntries(SOURCE_ROOT, ROOT, entries);
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const commonNodeModulesRealPath = realpathSync(join(ROOT, "node_modules"));
    const workspaceNodeModulesRealPath = realpathSync(join(WORKSPACE_ROOT, "node_modules"));
    const runtimeDependencies = Object.fromEntries(
        RUNTIME_DEPENDENCY_NAMES.map((name) => [name, directorySeal(join(ROOT, "node_modules", name))]),
    ) as Record<RuntimeDependencyName, IDirectorySeal>;
    const requireFromRoot = createRequire(PACKAGE_JSON_PATH);
    const runtimeResolution = Object.fromEntries(
        RUNTIME_DEPENDENCY_NAMES.map((name) => {
            const resolvedPath = requireFromRoot.resolve(name);
            const realPath = realpathSync(resolvedPath);
            if (!isPathWithin(realPath, runtimeDependencies[name].realRoot)) {
                throw new Error(`${name} resolved outside its recursively sealed dependency root: ${realPath}`);
            }
            return [name, { resolvedPath, realPath, withinSealedRoot: true as const }];
        }),
    ) as IRunSeal["runtimeResolution"];
    const runner = fileSeal(RUNNER_PATH);
    const quantileHelper = fileSeal(QUANTILE_HELPER_PATH);
    const workspaceLock = fileSeal(WORKSPACE_LOCK_PATH);
    const sealWithoutIdentity = {
        root: ROOT,
        realRoot: realpathSync(ROOT),
        workspaceRoot: WORKSPACE_ROOT,
        realWorkspaceRoot: realpathSync(WORKSPACE_ROOT),
        gitHead: gitValue("rev-parse", "HEAD"),
        gitTree: gitValue("rev-parse", "HEAD^{tree}"),
        source: {
            entries: entries.length,
            bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
            manifestSha256: digest(entries),
            runtimeSha256: Object.fromEntries(
                RUNTIME_PATHS.map((path) => [normalizedPath(relative(ROOT, path)), sha256(readFileSync(path))]),
            ),
        },
        runner: {
            ...runner,
            path: normalizedPath(relative(ROOT, RUNNER_PATH)),
        },
        quantileHelper: {
            ...quantileHelper,
            path: normalizedPath(relative(ROOT, QUANTILE_HELPER_PATH)),
        },
        packageJson: fileSeal(PACKAGE_JSON_PATH),
        tsconfigJson: fileSeal(TSCONFIG_JSON_PATH),
        bunfigToml: fileSeal(BUNFIG_TOML_PATH),
        workspaceLock: {
            ...workspaceLock,
            path: normalizedPath(relative(ROOT, WORKSPACE_LOCK_PATH)),
        },
        runtimeDependencies,
        runtimeResolution,
        bunExecutable: fileSeal(process.execPath),
        dependencies: {
            recursivelySealed: true as const,
            manifestCodec: MICRO_MANIFEST_CODEC,
            commonNodeModulesRealPath,
            workspaceNodeModulesRealPath,
            limitation:
                "The denque and google-protobuf trees resolved by this workload are recursively sealed; " +
                "installed dependency trees not reachable from this micro workload are outside this seal.",
        },
    };
    return { ...sealWithoutIdentity, identitySha256: digest(sealWithoutIdentity) };
}

function assertExpectedRuntimeInputs(seal: IRunSeal, context: string): Record<string, unknown> {
    const observed = {
        packageJsonSha256: seal.packageJson.sha256,
        tsconfigJsonSha256: seal.tsconfigJson.sha256,
        bunfigTomlSha256: seal.bunfigToml.sha256,
        workspaceLockSha256: seal.workspaceLock.sha256,
        bunExecutableSha256: seal.bunExecutable.sha256,
    };
    const expected = {
        packageJsonSha256: EXPECTED_PACKAGE_JSON_SHA256,
        tsconfigJsonSha256: EXPECTED_TSCONFIG_JSON_SHA256,
        bunfigTomlSha256: EXPECTED_BUNFIG_TOML_SHA256,
        workspaceLockSha256: EXPECTED_WORKSPACE_LOCK_SHA256,
        bunExecutableSha256: EXPECTED_BUN_EXECUTABLE_SHA256,
    };
    if (canonicalJson(observed) !== canonicalJson(expected)) {
        throw new Error(`${context}: pinned runtime input mismatch: ${canonicalJson({ expected, observed })}`);
    }
    for (const name of RUNTIME_DEPENDENCY_NAMES) {
        const actual = seal.runtimeDependencies[name];
        const expectedDependency = EXPECTED_RUNTIME_DEPENDENCIES[name];
        if (
            actual.manifestCodec !== MICRO_MANIFEST_CODEC ||
            actual.entryCount !== expectedDependency.entryCount ||
            actual.bytes !== expectedDependency.bytes ||
            actual.manifestSha256 !== expectedDependency.manifestSha256
        ) {
            throw new Error(
                `${context}: ${name} dependency seal mismatch: ` +
                    canonicalJson({ expected: expectedDependency, actual }),
            );
        }
        if (!seal.runtimeResolution[name].withinSealedRoot) {
            throw new Error(`${context}: ${name} resolution is outside its sealed root`);
        }
    }
    return {
        passed: true,
        expected,
        observed,
        manifestCodec: MICRO_MANIFEST_CODEC,
        runtimeDependencies: Object.fromEntries(
            RUNTIME_DEPENDENCY_NAMES.map((name) => [
                name,
                {
                    expected: EXPECTED_RUNTIME_DEPENDENCIES[name],
                    observed: seal.runtimeDependencies[name],
                    resolution: seal.runtimeResolution[name],
                },
            ]),
        ),
    };
}

function assertExpectedSourceIdentity(seal: IRunSeal, context: string): Record<string, unknown> {
    const resolvedExpectedCommit = gitValue("rev-parse", `${EXPECTED_CANDIDATE_COMMIT}^{commit}`);
    const committedSourceDelta = gitValue("diff", "--name-only", `${EXPECTED_CANDIDATE_COMMIT}..HEAD`, "--", "src");
    const unstagedSourceDelta = gitValue("diff", "--name-only", "--", "src");
    const stagedSourceDelta = gitValue("diff", "--cached", "--name-only", "--", "src");
    const sourceStatus = gitValue("status", "--porcelain=v1", "--untracked-files=all", "--", "src");
    if (resolvedExpectedCommit !== EXPECTED_CANDIDATE_COMMIT) {
        throw new Error(`${context}: expected candidate commit does not resolve exactly`);
    }
    if (seal.source.manifestSha256 !== EXPECTED_SOURCE_MANIFEST_SHA256) {
        throw new Error(
            `${context}: src manifest mismatch: ${seal.source.manifestSha256} != ${EXPECTED_SOURCE_MANIFEST_SHA256}`,
        );
    }
    if (committedSourceDelta || unstagedSourceDelta || stagedSourceDelta || sourceStatus) {
        throw new Error(
            `${context}: governed src is not the exact clean ${EXPECTED_CANDIDATE_COMMIT} state: ` +
                canonicalJson({ committedSourceDelta, unstagedSourceDelta, stagedSourceDelta, sourceStatus }),
        );
    }
    return {
        passed: true,
        expectedCandidateCommit: EXPECTED_CANDIDATE_COMMIT,
        resolvedExpectedCommit,
        currentHead: seal.gitHead,
        committedSourceDeltaFromExpectedCommit: [],
        unstagedSourceDelta: [],
        stagedSourceDelta: [],
        sourceStatus: [],
        expectedSrcManifestSha256: EXPECTED_SOURCE_MANIFEST_SHA256,
        observedSrcManifestSha256: seal.source.manifestSha256,
        note: "HEAD may advance only through commits that leave src byte-identical to the frozen candidate",
    };
}

function assertSameSeal(before: IRunSeal, after: IRunSeal): void {
    if (before.identitySha256 !== after.identitySha256) {
        throw new Error(`Source/runner/lock drift: ${before.identitySha256} -> ${after.identitySha256}`);
    }
}

function writeJsonAtomicExclusive(path: string, value: unknown): void {
    const resolved = resolve(path);
    mkdirSync(dirname(resolved), { recursive: true });
    if (existsSync(resolved)) throw new Error(`Refusing to overwrite report: ${resolved}`);
    const temporary = join(dirname(resolved), `.${basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    try {
        linkSync(temporary, resolved);
    } finally {
        unlinkSync(temporary);
    }
}

const floatBuffer = new ArrayBuffer(8);
const floatView = new DataView(floatBuffer);

function floatBits(value: number): bigint {
    floatView.setFloat64(0, value);
    return floatView.getBigUint64(0);
}

function floatFromBits(bits: bigint): number {
    floatView.setBigUint64(0, bits);
    return floatView.getFloat64(0);
}

function nextUp(value: number): number {
    if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value;
    if (value === 0) return Number.MIN_VALUE;
    const bits = floatBits(value);
    return floatFromBits(value > 0 ? bits + 1n : bits - 1n);
}

function nextDown(value: number): number {
    if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return value;
    if (value === 0) return -Number.MIN_VALUE;
    const bits = floatBits(value);
    return floatFromBits(value > 0 ? bits - 1n : bits + 1n);
}

function legacyRound(value: number, fractionDigits: FractionDigits): number {
    return Number(value.toFixed(fractionDigits));
}

function legacyRoundRuntime(value: unknown, fractionDigits: unknown): number {
    return Number((value as { toFixed: (digits: unknown) => string }).toFixed(fractionDigits));
}

function assertExact(candidate: Round, value: number, fractionDigits: FractionDigits, context: string): number {
    const expected = legacyRound(value, fractionDigits);
    const actual = candidate(value, fractionDigits);
    if (!Object.is(actual, expected)) {
        throw new Error(
            `${context}: mismatch for bits=0x${floatBits(value).toString(16).padStart(16, "0")} ` +
                `digits=${fractionDigits}; legacy=${String(expected)}, candidate=${String(actual)}`,
        );
    }
    return actual;
}

function rawFloat64Correctness(candidate: Round): Record<string, unknown> {
    let state = RAW_FLOAT64_SEED;
    let finite = 0;
    let nonFinite = 0;
    const eligibilityCounts: Record<FastEligibilityKind, number> = {
        exactGrid: 0,
        nearGrid: 0,
        numericFallback: 0,
    };
    let checksum = 0x811c_9dc5;
    for (let index = 0; index < RAW_FLOAT64_PATTERNS; index++) {
        state ^= state << 13n;
        state ^= state >> 7n;
        state ^= state << 17n;
        state &= RAW_FLOAT64_MASK;
        const value = floatFromBits(state);
        if (Number.isFinite(value)) finite++;
        else nonFinite++;
        for (const fractionDigits of [1, 2] as const) {
            const result = assertExact(candidate, value, fractionDigits, `raw-float64/${index}`);
            eligibilityCounts[fastEligibility(value, fractionDigits).kind]++;
            const bits = floatBits(result);
            checksum = Math.imul(checksum ^ Number(bits & 0xffff_ffffn), 0x0100_0193) >>> 0;
            checksum = Math.imul(checksum ^ Number(bits >> 32n), 0x0100_0193) >>> 0;
        }
    }
    return {
        passed: true,
        seedHex: `0x${RAW_FLOAT64_SEED.toString(16)}`,
        patterns: RAW_FLOAT64_PATTERNS,
        digitsPerPattern: [1, 2],
        comparisons: RAW_FLOAT64_PATTERNS * 2,
        finite,
        nonFinite,
        independentlyCalculatedEligibility: eligibilityCounts,
        independentlyCalculatedFastEligible: eligibilityCounts.exactGrid + eligibilityCounts.nearGrid,
        finalStateHex: `0x${state.toString(16).padStart(16, "0")}`,
        resultChecksumHex: `0x${checksum.toString(16).padStart(8, "0")}`,
    };
}

function curatedCorrectness(candidate: Round): Record<string, unknown> {
    const boundaryValues = [
        0,
        -0,
        Number.MIN_VALUE,
        -Number.MIN_VALUE,
        2 ** -1022,
        -(2 ** -1022),
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        0.1,
        -0.1,
        0.05,
        -0.05,
        0.005,
        -0.005,
        1.005,
        -1.005,
        2.675,
        -2.675,
        6.3,
        7.75,
        44,
        1e21,
        -1e21,
        nextDown(1e21),
        nextUp(1e21),
        nextDown(-1e21),
        nextUp(-1e21),
        -226_801_603_510_430.12,
        -776_169_524_486.2999,
        2_251_799_813_685_249 / 4,
        562_949_953_421_313 / 8,
        MAX_EXACT_SCALED_INTEGER / 10,
        -MAX_EXACT_SCALED_INTEGER / 10,
        MAX_EXACT_SCALED_INTEGER / 100,
        -MAX_EXACT_SCALED_INTEGER / 100,
    ];
    let boundaryComparisons = 0;
    for (const original of boundaryValues) {
        const values = Number.isFinite(original) ? [nextDown(original), original, nextUp(original)] : [original];
        for (const value of values) {
            for (const fractionDigits of [1, 2] as const) {
                assertExact(candidate, value, fractionDigits, `curated-boundary/${boundaryComparisons}`);
                boundaryComparisons++;
            }
        }
    }

    let gridComparisons = 0;
    const gridEligibility: Record<FastEligibilityKind, number> = {
        exactGrid: 0,
        nearGrid: 0,
        numericFallback: 0,
    };
    for (let scaled = -100_000; scaled <= 100_000; scaled += 37) {
        for (const fractionDigits of [1, 2] as const) {
            const scale = fractionDigits === 1 ? 10 : 100;
            const value = scaled / scale;
            for (const neighbor of [nextDown(value), value, nextUp(value)]) {
                assertExact(candidate, neighbor, fractionDigits, `curated-grid/${scaled}/${fractionDigits}`);
                gridComparisons++;
                gridEligibility[fastEligibility(neighbor, fractionDigits).kind]++;
            }
        }
    }

    return {
        passed: true,
        boundaries: {
            sourceValues: boundaryValues.length,
            includesImmediateFiniteNeighbors: true,
            comparisons: boundaryComparisons,
        },
        decimalGrids: {
            scaledStartInclusive: -100_000,
            scaledEndInclusive: 100_000,
            scaledStep: 37,
            scales: [10, 100],
            includesImmediateNeighbors: true,
            comparisons: gridComparisons,
            independentlyCalculatedEligibility: gridEligibility,
            independentlyCalculatedFastEligible: gridEligibility.exactGrid + gridEligibility.nearGrid,
        },
        comparisons: boundaryComparisons + gridComparisons,
    };
}

function nearGridCorrectness(candidate: Round): Record<string, unknown> {
    const counts: Record<FastEligibilityKind, number> = {
        exactGrid: 0,
        nearGrid: 0,
        numericFallback: 0,
    };
    let comparisons = 0;
    let expectedNegativeZero = 0;
    let observedNegativeZero = 0;

    const check = (value: number, fractionDigits: FractionDigits, context: string): void => {
        const eligibility = fastEligibility(value, fractionDigits);
        const result = assertExact(candidate, value, fractionDigits, context);
        counts[eligibility.kind]++;
        comparisons++;
        if (eligibility.resultNegativeZero) expectedNegativeZero++;
        if (Object.is(result, -0)) observedNegativeZero++;
        if (Object.is(result, -0) !== eligibility.resultNegativeZero) {
            throw new Error(
                `${context}: independent signed-zero prediction differs for ${eligibility.kind}: ` +
                    `expectedNegativeZero=${eligibility.resultNegativeZero}`,
            );
        }
    };

    const offsets = [
        -0.5,
        nextUp(-0.5),
        nextDown(-NEAR_GRID_MAX_DISTANCE),
        -NEAR_GRID_MAX_DISTANCE,
        nextUp(-NEAR_GRID_MAX_DISTANCE),
        -Number.EPSILON,
        0,
        Number.EPSILON,
        nextDown(NEAR_GRID_MAX_DISTANCE),
        NEAR_GRID_MAX_DISTANCE,
        nextUp(NEAR_GRID_MAX_DISTANCE),
        nextDown(0.5),
        0.5,
    ];
    const scaledIntegers = [
        -NEAR_GRID_SCALED_LIMIT,
        -NEAR_GRID_SCALED_LIMIT + 1,
        -(2 ** 24) - 1,
        -(2 ** 24) + 1,
        -1_000_003,
        -101,
        -3,
        -1,
        0,
        1,
        3,
        101,
        1_000_003,
        2 ** 24 - 1,
        2 ** 24 + 1,
        NEAR_GRID_SCALED_LIMIT - 1,
        NEAR_GRID_SCALED_LIMIT,
        2 ** 31 - 1,
    ];
    let boundaryComparisons = 0;
    for (const scale of [10, 100] as const) {
        const fractionDigits: FractionDigits = scale === 10 ? 1 : 2;
        for (const scaledInteger of scaledIntegers) {
            for (const offset of offsets) {
                const value = (scaledInteger + offset) / scale;
                for (const neighbor of [nextDown(value), value, nextUp(value)]) {
                    check(neighbor, fractionDigits, `near-grid-boundary/${scale}/${scaledInteger}/${offset}`);
                    boundaryComparisons++;
                }
            }
        }
    }

    const deterministicOffsets = [
        -0.500001, -0.499999, -0.250001, -0.249999, 0, 0.249999, 0.250001, 0.499999, 0.500001,
    ];
    let randomState = 0x6d2b_79f5;
    let randomComparisons = 0;
    for (let index = 0; index < NEAR_GRID_RANDOM_CASES; index++) {
        randomState = (randomState * 1_664_525 + 1_013_904_223) >>> 0;
        const scaledInteger = (randomState % (2 ** 31 - 1)) - (NEAR_GRID_SCALED_LIMIT - 1);
        const offset = deterministicOffsets[randomState % deterministicOffsets.length];
        for (const scale of [10, 100] as const) {
            const fractionDigits: FractionDigits = scale === 10 ? 1 : 2;
            const value = (scaledInteger + offset) / scale;
            for (const neighbor of [nextDown(value), value, nextUp(value)]) {
                check(neighbor, fractionDigits, `near-grid-random/${index}/${scale}`);
                randomComparisons++;
            }
        }
    }

    const signedZeroValues = [-0, -Number.MIN_VALUE, -0.000_000_000_000_001, -0.004, -0.006] as const;
    const signedZeroCases = signedZeroValues.flatMap((value) =>
        ([1, 2] as const).map((fractionDigits) => {
            const eligibility = fastEligibility(value, fractionDigits);
            const result = assertExact(candidate, value, fractionDigits, `near-grid-signed-zero/${value}`);
            return {
                value: Object.is(value, -0) ? "-0" : value,
                fractionDigits,
                eligibility: eligibility.kind,
                expectedNegativeZero: eligibility.resultNegativeZero,
                observedNegativeZero: Object.is(result, -0),
            };
        }),
    );
    if (!signedZeroCases.some((item) => item.eligibility === "nearGrid" && item.observedNegativeZero)) {
        throw new Error("Near-grid correctness corpus did not exercise the admitted negative-zero result");
    }
    if (!signedZeroCases.some((item) => item.value === "-0" && !item.observedNegativeZero)) {
        throw new Error("Near-grid correctness corpus did not prove exact -0 normalization to +0");
    }

    const strictPredicateChecks = ([10, 100] as const).map((scale) => {
        const fractionDigits: FractionDigits = scale === 10 ? 1 : 2;
        const cases = {
            negativeLimitInside: fastEligibility((-NEAR_GRID_SCALED_LIMIT + 0.125) / scale, fractionDigits).kind,
            negativeLimitOutside: fastEligibility((-NEAR_GRID_SCALED_LIMIT - 0.125) / scale, fractionDigits).kind,
            positiveLimitInside: fastEligibility((NEAR_GRID_SCALED_LIMIT - 0.125) / scale, fractionDigits).kind,
            positiveLimitOutside: fastEligibility((NEAR_GRID_SCALED_LIMIT + 0.125) / scale, fractionDigits).kind,
            negativeDistanceInside: fastEligibility((-123 - 0.249) / scale, fractionDigits).kind,
            negativeDistanceBoundary: fastEligibility((-123 - NEAR_GRID_MAX_DISTANCE) / scale, fractionDigits).kind,
            positiveDistanceInside: fastEligibility((123 + 0.249) / scale, fractionDigits).kind,
            positiveDistanceBoundary: fastEligibility((123 + NEAR_GRID_MAX_DISTANCE) / scale, fractionDigits).kind,
        };
        const expected = {
            negativeLimitInside: "nearGrid",
            negativeLimitOutside: "numericFallback",
            positiveLimitInside: "nearGrid",
            positiveLimitOutside: "numericFallback",
            negativeDistanceInside: "nearGrid",
            negativeDistanceBoundary: "numericFallback",
            positiveDistanceInside: "nearGrid",
            positiveDistanceBoundary: "numericFallback",
        };
        if (canonicalJson(cases) !== canonicalJson(expected)) {
            throw new Error(`Strict near-grid predicate fixture drifted at scale ${scale}: ${canonicalJson(cases)}`);
        }
        return { scale, cases };
    });

    if (counts.nearGrid === 0 || counts.numericFallback === 0 || expectedNegativeZero !== observedNegativeZero) {
        throw new Error(
            `Near-grid correctness coverage is incomplete: ${canonicalJson({ counts, expectedNegativeZero, observedNegativeZero })}`,
        );
    }
    return {
        passed: true,
        predicate: {
            scaledLowerExclusive: -NEAR_GRID_SCALED_LIMIT,
            scaledUpperExclusive: NEAR_GRID_SCALED_LIMIT,
            distanceLowerExclusive: -NEAR_GRID_MAX_DISTANCE,
            distanceUpperExclusive: NEAR_GRID_MAX_DISTANCE,
            exactGridEvaluatedFirst: true,
            signedZeroPolicy:
                "exact -0 normalizes to +0; an admitted negative near-grid value whose nearest integer is zero returns -0",
        },
        boundary: {
            scaledIntegers,
            offsets,
            includesImmediateValueNeighbors: true,
            comparisons: boundaryComparisons,
        },
        deterministicRandom: {
            seedHex: "0x6d2b79f5",
            cases: NEAR_GRID_RANDOM_CASES,
            offsets: deterministicOffsets,
            comparisons: randomComparisons,
            finalStateHex: `0x${randomState.toString(16).padStart(8, "0")}`,
        },
        strictPredicateChecks,
        signedZeroCases,
        independentlyClassified: counts,
        expectedNegativeZero,
        observedNegativeZero,
        comparisons,
    };
}

function outcome(call: () => unknown): Record<string, unknown> {
    try {
        const value = call();
        return {
            type: "return",
            value: typeof value === "number" && value !== value ? "NaN" : value,
            negativeZero: typeof value === "number" && Object.is(value, -0),
        };
    } catch (error) {
        return {
            type: "throw",
            name: error instanceof Error ? error.name : typeof error,
        };
    }
}

function assertSameOutcome(left: Record<string, unknown>, right: Record<string, unknown>, context: string): void {
    if (canonicalJson(left) !== canonicalJson(right)) {
        throw new Error(`${context}: outcomes differ: ${canonicalJson(left)} != ${canonicalJson(right)}`);
    }
}

function withRestoredIntrinsics<T>(startup: IStartupIntrinsics, call: () => T): T {
    try {
        return call();
    } finally {
        Object.defineProperty(globalThis, "Number", startup.numberDescriptor);
        Object.defineProperty(startup.number, "isSafeInteger", startup.numberIsSafeIntegerDescriptor);
        Object.defineProperty(startup.number.prototype, "toFixed", startup.toFixedDescriptor);
        Object.defineProperty(Reflect, "apply", startup.reflectApplyDescriptor);
    }
}

function accessorProbe(
    arm: RuntimeRound,
    startup: IStartupIntrinsics,
): { outcome: Record<string, unknown>; events: string[]; receiverWasPrimitive: boolean } {
    return withRestoredIntrinsics(startup, () => {
        const events: string[] = [];
        let receiverWasPrimitive = false;
        Object.defineProperty(startup.number.prototype, "toFixed", {
            configurable: true,
            get() {
                events.push("get toFixed");
                return function (this: unknown, fractionDigits: unknown): string {
                    "use strict";
                    events.push(`call toFixed/${String(fractionDigits)}`);
                    receiverWasPrimitive = typeof this === "number" && this === 1.2;
                    return "7.7";
                };
            },
        });
        return { outcome: outcome(() => arm(1.2, 1)), events, receiverWasPrimitive };
    });
}

function orderProbe(
    arm: RuntimeRound,
    startup: IStartupIntrinsics,
): { outcome: Record<string, unknown>; events: string[] } {
    return withRestoredIntrinsics(startup, () => {
        const events: string[] = [];
        Object.defineProperty(startup.number.prototype, "toFixed", {
            configurable: true,
            get() {
                events.push("get toFixed");
                return function (): string {
                    events.push("call toFixed");
                    return "8.8";
                };
            },
        });
        Object.defineProperty(globalThis, "Number", {
            configurable: true,
            enumerable: false,
            get() {
                events.push("get Number");
                return startup.number;
            },
        });
        return { outcome: outcome(() => arm(1.2, 1)), events };
    });
}

function callableProxyProbe(
    arm: RuntimeRound,
    startup: IStartupIntrinsics,
): {
    outcome: Record<string, unknown>;
    events: string[];
    applyReceiverWasPrimitive: boolean;
    targetReceiverWasPrimitive: boolean;
} {
    return withRestoredIntrinsics(startup, () => {
        const events: string[] = [];
        let applyReceiverWasPrimitive = false;
        let targetReceiverWasPrimitive = false;
        const target = function (this: unknown, fractionDigits: unknown): string {
            "use strict";
            events.push(`target/${String(fractionDigits)}`);
            targetReceiverWasPrimitive = typeof this === "number" && this === 1.2;
            return "9.9";
        };
        const proxy = new Proxy(target, {
            apply(callable, thisArg, args) {
                events.push(`apply/${String(args[0])}`);
                applyReceiverWasPrimitive = typeof thisArg === "number" && thisArg === 1.2;
                return startup.reflectApply(callable, thisArg, args);
            },
        });
        Object.defineProperty(startup.number.prototype, "toFixed", {
            configurable: true,
            value: proxy,
        });
        return {
            outcome: outcome(() => arm(1.2, 1)),
            events,
            applyReceiverWasPrimitive,
            targetReceiverWasPrimitive,
        };
    });
}

function customObjectProbe(arm: RuntimeRound): {
    outcome: Record<string, unknown>;
    toFixedCalls: number;
    valueOfCalls: number;
    receiverMatched: boolean;
    observedDigits: unknown[];
} {
    let toFixedCalls = 0;
    let valueOfCalls = 0;
    let receiverMatched = false;
    const observedDigits: unknown[] = [];
    const value = {
        toFixed(this: unknown, fractionDigits: unknown): string {
            toFixedCalls++;
            receiverMatched = this === value;
            observedDigits.push(fractionDigits);
            return "12.5";
        },
        valueOf(): never {
            valueOfCalls++;
            throw new Error("custom object valueOf must not run");
        },
    };
    return {
        outcome: outcome(() => arm(value, 1)),
        toFixedCalls,
        valueOfCalls,
        receiverMatched,
        observedDigits,
    };
}

function dynamicMutationAndBoxedCorrectness(candidate: Round, startup: IStartupIntrinsics): Record<string, unknown> {
    const runtimeCandidate = candidate as RuntimeRound;
    const cases: Record<string, unknown> = {};

    const legacyAccessor = accessorProbe(legacyRoundRuntime, startup);
    const candidateAccessor = accessorProbe(runtimeCandidate, startup);
    assertSameOutcome(legacyAccessor.outcome, candidateAccessor.outcome, "dynamic/accessor");
    if (
        canonicalJson(legacyAccessor.events) !== canonicalJson(candidateAccessor.events) ||
        !legacyAccessor.receiverWasPrimitive ||
        !candidateAccessor.receiverWasPrimitive
    ) {
        throw new Error("dynamic/accessor lookup, call, or receiver behavior differs");
    }
    cases.replacedToFixedAccessor = { legacy: legacyAccessor, candidate: candidateAccessor };

    const legacyOrder = orderProbe(legacyRoundRuntime, startup);
    const candidateOrder = orderProbe(runtimeCandidate, startup);
    assertSameOutcome(legacyOrder.outcome, candidateOrder.outcome, "dynamic/order");
    if (
        canonicalJson(legacyOrder.events) !== canonicalJson(candidateOrder.events) ||
        legacyOrder.events.join(",") !== "get Number,get toFixed,call toFixed"
    ) {
        throw new Error(`dynamic/order differs: ${canonicalJson({ legacyOrder, candidateOrder })}`);
    }
    cases.numberBeforeToFixed = { legacy: legacyOrder, candidate: candidateOrder };

    const replacementNumber = (value?: unknown): number => startup.number(value) + 100;
    const numberReplacement = withRestoredIntrinsics(startup, () => {
        Object.defineProperty(globalThis, "Number", {
            ...startup.numberDescriptor,
            value: replacementNumber,
        });
        const legacy = outcome(() => legacyRoundRuntime(1.25, 1));
        const actual = outcome(() => runtimeCandidate(1.25, 1));
        assertSameOutcome(legacy, actual, "dynamic/Number replacement");
        return { legacy, candidate: actual };
    });
    cases.replacedNumber = numberReplacement;

    const nonCallableToFixed = withRestoredIntrinsics(startup, () => {
        Object.defineProperty(startup.number.prototype, "toFixed", {
            configurable: true,
            value: 42,
        });
        const legacy = outcome(() => legacyRoundRuntime(1.25, 1));
        const actual = outcome(() => runtimeCandidate(1.25, 1));
        assertSameOutcome(legacy, actual, "dynamic/non-callable toFixed");
        return { legacy, candidate: actual };
    });
    cases.nonCallableToFixed = nonCallableToFixed;

    const unsupportedDigits = [0, 3, 100, 101].map((fractionDigits) => {
        const legacy = outcome(() => legacyRoundRuntime(1.25, fractionDigits));
        const actual = outcome(() => runtimeCandidate(1.25, fractionDigits));
        assertSameOutcome(legacy, actual, `dynamic/runtime digits ${fractionDigits}`);
        return { fractionDigits, legacy, candidate: actual };
    });
    cases.runtimeFractionDigits = unsupportedDigits;

    class NumberWithThrowingValueOf extends Number {
        public override valueOf(): number {
            throw new Error("boxed valueOf must not run");
        }
    }
    const boxedValues: unknown[] = [new Number(1.25), new NumberWithThrowingValueOf(6.3)];
    const boxed = boxedValues.flatMap((value, valueIndex) =>
        [1, 2].map((fractionDigits) => {
            const legacy = outcome(() => legacyRoundRuntime(value, fractionDigits));
            const actual = outcome(() => runtimeCandidate(value, fractionDigits));
            assertSameOutcome(legacy, actual, `dynamic/boxed ${valueIndex}/${fractionDigits}`);
            return { valueIndex, fractionDigits, legacy, candidate: actual };
        }),
    );
    cases.boxedNumberFallback = boxed;

    const proxiedBoxedNumber = new Proxy(new startup.number(1.25), {});
    const proxiedBoxedLegacy = outcome(() => legacyRoundRuntime(proxiedBoxedNumber, 1));
    const proxiedBoxedCandidate = outcome(() => runtimeCandidate(proxiedBoxedNumber, 1));
    assertSameOutcome(proxiedBoxedLegacy, proxiedBoxedCandidate, "dynamic/proxy-wrapped boxed Number");
    if (proxiedBoxedLegacy.type !== "throw" || proxiedBoxedLegacy.name !== "TypeError") {
        throw new Error(
            `dynamic/proxy-wrapped boxed Number did not preserve native TypeError: ${canonicalJson({
                proxiedBoxedLegacy,
                proxiedBoxedCandidate,
            })}`,
        );
    }
    cases.proxyWrappedBoxedNumberFallback = {
        legacy: proxiedBoxedLegacy,
        candidate: proxiedBoxedCandidate,
    };

    const customObjectLegacy = customObjectProbe(legacyRoundRuntime);
    const customObjectCandidate = customObjectProbe(runtimeCandidate);
    assertSameOutcome(customObjectLegacy.outcome, customObjectCandidate.outcome, "dynamic/custom object");
    if (
        canonicalJson(customObjectLegacy) !== canonicalJson(customObjectCandidate) ||
        customObjectLegacy.toFixedCalls !== 1 ||
        customObjectLegacy.valueOfCalls !== 0 ||
        !customObjectLegacy.receiverMatched ||
        customObjectLegacy.observedDigits.join(",") !== "1"
    ) {
        throw new Error(
            `dynamic/custom object call or coercion differs: ${canonicalJson({
                customObjectLegacy,
                customObjectCandidate,
            })}`,
        );
    }
    cases.customObjectFallback = {
        legacy: customObjectLegacy,
        candidate: customObjectCandidate,
    };

    const callableProxyLegacy = callableProxyProbe(legacyRoundRuntime, startup);
    const callableProxyCandidate = callableProxyProbe(runtimeCandidate, startup);
    assertSameOutcome(callableProxyLegacy.outcome, callableProxyCandidate.outcome, "dynamic/callable proxy");
    if (
        canonicalJson(callableProxyLegacy) !== canonicalJson(callableProxyCandidate) ||
        callableProxyLegacy.events.join(",") !== "apply/1,target/1" ||
        !callableProxyLegacy.applyReceiverWasPrimitive ||
        !callableProxyLegacy.targetReceiverWasPrimitive
    ) {
        throw new Error(
            `dynamic/callable proxy apply behavior differs: ${canonicalJson({
                callableProxyLegacy,
                callableProxyCandidate,
            })}`,
        );
    }
    cases.callableProxyToFixed = {
        legacy: callableProxyLegacy,
        candidate: callableProxyCandidate,
    };

    assertRealmRestored(startup, "after dynamic mutation probes");
    return {
        passed: true,
        deliberatelyUntimed: true,
        cases,
    };
}

function fastEligibility(value: number, fractionDigits: FractionDigits): IFastEligibility {
    const scale = fractionDigits === 1 ? 10 : 100;
    const scaled = value * scale;
    const exactGrid =
        Number.isSafeInteger(scaled) &&
        scaled >= -MAX_EXACT_SCALED_INTEGER &&
        scaled <= MAX_EXACT_SCALED_INTEGER &&
        scaled / scale === value;
    if (exactGrid) {
        return {
            kind: "exactGrid",
            scaled,
            nearestScaledInteger: scaled,
            // The production exact-grid branch intentionally normalizes -0.
            resultNegativeZero: false,
        };
    }

    if (scaled > -NEAR_GRID_SCALED_LIMIT && scaled < NEAR_GRID_SCALED_LIMIT) {
        const nearestScaledInteger = scaled < 0 ? (scaled - 0.5) | 0 : (scaled + 0.5) | 0;
        const distance = scaled - nearestScaledInteger;
        if (distance > -NEAR_GRID_MAX_DISTANCE && distance < NEAR_GRID_MAX_DISTANCE) {
            return {
                kind: "nearGrid",
                scaled,
                nearestScaledInteger,
                resultNegativeZero: nearestScaledInteger === 0 && value < 0,
            };
        }
    }

    return {
        kind: "numericFallback",
        scaled,
        nearestScaledInteger: null,
        resultNegativeZero: Object.is(legacyRound(value, fractionDigits), -0),
    };
}

function isFastEligible(value: number, fractionDigits: FractionDigits): boolean {
    return fastEligibility(value, fractionDigits).kind !== "numericFallback";
}

function makeExactGridCorpus(): IRoundCase[] {
    const result: IRoundCase[] = [];
    const configuredLikeValues = [
        0, 0.05, 0.1, 0.15, 0.25, 0.5, 0.75, 1, 1.25, 2, 2.5, 3.1, 3.3, 3.6, 4, 4.2, 5, 6.3, 7.75, 8, 9, 10, 12, 15, 20,
        22.5, 44, 50, 75, 100, 125, 170, 500, 1_000,
    ];
    for (const value of configuredLikeValues) {
        for (const fractionDigits of [1, 2] as const) {
            if (isFastEligible(value, fractionDigits)) result.push({ value, fractionDigits });
        }
    }
    for (let scaled = -20_000; scaled <= 80_000; scaled += 29) {
        for (const fractionDigits of [1, 2] as const) {
            const scale = fractionDigits === 1 ? 10 : 100;
            const value = scaled / scale;
            if (isFastEligible(value, fractionDigits)) result.push({ value, fractionDigits });
        }
    }
    if (!result.length || result.some((item) => !isFastEligible(item.value, item.fractionDigits))) {
        throw new Error("Exact-grid timing corpus contains an ineligible value");
    }
    return result;
}

interface ICreatureJsonEntry {
    name: string;
}

type CreaturesJson = Record<string, number | Record<string, ICreatureJsonEntry>>;

async function captureActualStatTrace(
    startup: IStartupIntrinsics,
): Promise<{ cases: ITraceCase[]; report: Record<string, unknown> }> {
    const [
        { AbilityFactory },
        { getCreatureConfig },
        { EffectFactory },
        { PBTypes },
        gridConstants,
        { GridSettings },
        { Unit },
    ] = await Promise.all([
        import("../../../src/abilities/ability_factory"),
        import("../../../src/configuration/config_provider"),
        import("../../../src/effects/effect_factory"),
        import("../../../src/generated/protobuf/v1/types"),
        import("../../../src/grid/grid_constants"),
        import("../../../src/grid/grid_settings"),
        import("../../../src/units/unit"),
    ]);
    const creatures = JSON.parse(readFileSync(CREATURES_PATH, "utf8")) as CreaturesJson;
    const gridSettings = new GridSettings(
        gridConstants.GRID_SIZE,
        gridConstants.MAX_Y,
        gridConstants.MIN_Y,
        gridConstants.MAX_X,
        gridConstants.MIN_X,
        gridConstants.MOVEMENT_DELTA,
        gridConstants.UNIT_SIZE_DELTA,
    );
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    const units = Object.entries(creatures)
        .filter((entry): entry is [string, Record<string, ICreatureJsonEntry>] => entry[0] !== "version")
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([faction, entries]) =>
            Object.keys(entries)
                .sort((left, right) => left.localeCompare(right))
                .map((creature) => {
                    const texture = `${creature.toLowerCase().replaceAll(" ", "_")}_128`;
                    return {
                        faction,
                        creature,
                        unit: Unit.createUnit(
                            getCreatureConfig(PBTypes.TeamVals.LOWER, faction, creature, texture, 1),
                            gridSettings,
                            PBTypes.TeamVals.LOWER,
                            PBTypes.UnitVals.CREATURE,
                            abilityFactory,
                            effectFactory,
                            false,
                        ),
                    };
                }),
        );
    const scenarios: { name: string; args: AdjustBaseStatsArgs }[] = [
        {
            name: "placement/base",
            args: [false, 1, 0, 0, 0, 0, 0, 0] as const,
        },
        {
            name: "placement/synergy-and-morale",
            args: [false, 2, 7, 1, 4, 2, 1, 0.05] as const,
        },
    ];
    const contextKey = (faction: string, creature: string, scenario: string): string =>
        canonicalJson([faction, creature, scenario]);
    const expectedContexts = units.flatMap((item) =>
        scenarios.map((scenario) => ({
            faction: item.faction,
            creature: item.creature,
            scenario: scenario.name,
            key: contextKey(item.faction, item.creature, scenario.name),
        })),
    );
    const expectedContextKeys = new Set(expectedContexts.map((item) => item.key));

    const cases: ITraceCase[] = [];
    let context: { faction: string; creature: string; scenario: string } | undefined;
    let ordinal = 0;
    const tracingToFixed = function (this: unknown, fractionDigits?: number): string {
        "use strict";
        const stack = new Error().stack ?? "";
        if (context && stack.includes("roundUnitStat")) {
            if (typeof this !== "number" || (fractionDigits !== 1 && fractionDigits !== 2)) {
                throw new Error(`Unexpected production round trace receiver/digits: ${typeof this}/${fractionDigits}`);
            }
            cases.push({
                ...context,
                ordinal: ordinal++,
                value: this,
                fractionDigits,
            });
        }
        return startup.reflectApply(startup.toFixed, this, [fractionDigits]);
    };

    withRestoredIntrinsics(startup, () => {
        Object.defineProperty(startup.number.prototype, "toFixed", {
            ...startup.toFixedDescriptor,
            value: tracingToFixed,
        });
        for (const item of units) {
            for (const scenario of scenarios) {
                context = {
                    faction: item.faction,
                    creature: item.creature,
                    scenario: scenario.name,
                };
                item.unit.adjustBaseStats(...scenario.args);
            }
        }
        context = undefined;
    });
    assertRealmRestored(startup, "after actual stat trace capture");
    if (!cases.length) throw new Error("Production adjustBaseStats trace capture was empty");
    const contextCounts = new Map(expectedContexts.map((item) => [item.key, 0]));
    for (const item of cases) {
        const key = contextKey(item.faction, item.creature, item.scenario);
        if (!expectedContextKeys.has(key)) throw new Error(`Unexpected production trace context: ${key}`);
        contextCounts.set(key, (contextCounts.get(key) ?? 0) + 1);
    }
    const missingContexts = expectedContexts.filter((item) => (contextCounts.get(item.key) ?? 0) === 0);
    if (missingContexts.length > 0) {
        throw new Error(`Production trace contexts without entries: ${canonicalJson(missingContexts)}`);
    }
    const contextCountRows = expectedContexts.map((item) => ({
        faction: item.faction,
        creature: item.creature,
        scenario: item.scenario,
        entries: contextCounts.get(item.key) ?? 0,
    }));
    const entriesPerContext = contextCountRows.map((item) => item.entries);

    const eligibilityCounts: Record<FastEligibilityKind, number> = {
        exactGrid: 0,
        nearGrid: 0,
        numericFallback: 0,
    };
    for (const item of cases) eligibilityCounts[fastEligibility(item.value, item.fractionDigits).kind]++;
    const fastEligible = eligibilityCounts.exactGrid + eligibilityCounts.nearGrid;
    const digitCounts = {
        "1": cases.filter((item) => item.fractionDigits === 1).length,
        "2": cases.filter((item) => item.fractionDigits === 2).length,
    };
    return {
        cases,
        report: {
            passed: true,
            deliberatelyUntimedCapture: true,
            captureMethod:
                "54 configured creature Units execute production adjustBaseStats under two deterministic " +
                "placement scenarios; a temporary toFixed wrapper records only stacks containing roundUnitStat",
            creatureCount: units.length,
            scenarios: scenarios.map((scenario) => ({ name: scenario.name, args: scenario.args })),
            expectedCreatureScenarioContexts: expectedContexts.length,
            contextsWithEntries: contextCountRows.length,
            missingContexts: [],
            minimumEntriesPerContext: Math.min(...entriesPerContext),
            maximumEntriesPerContext: Math.max(...entriesPerContext),
            contextCounts: contextCountRows,
            entries: cases.length,
            digitCounts,
            independentlyCalculatedFastEligible: fastEligible,
            independentlyCalculatedEligibility: eligibilityCounts,
            fastEligibleFraction: fastEligible / cases.length,
            traceSha256: digest(
                cases.map((item) => [
                    item.faction,
                    item.creature,
                    item.scenario,
                    item.ordinal,
                    Object.is(item.value, -0) ? "-0" : item.value,
                    item.fractionDigits,
                ]),
            ),
            trace: cases.map((item) => ({
                faction: item.faction,
                creature: item.creature,
                scenario: item.scenario,
                ordinal: item.ordinal,
                value: Object.is(item.value, -0) ? "-0" : item.value,
                fractionDigits: item.fractionDigits,
            })),
        },
    };
}

function finitePositive(value: number, context: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${context} must be finite and positive, got ${value}`);
    return value;
}

function positiveSafeInteger(value: number, context: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${context} must be a positive safe integer, got ${value}`);
    }
    return value;
}

function checkedMeasurement(durationNs: number, operations: number, checksum: number, context: string): IMeasurement {
    finitePositive(durationNs, `${context}/durationNs`);
    positiveSafeInteger(operations, `${context}/operations`);
    if (!Number.isFinite(checksum)) throw new Error(`${context}/checksum must be finite, got ${checksum}`);
    const nanosecondsPerOperation = durationNs / operations;
    finitePositive(nanosecondsPerOperation, `${context}/nanosecondsPerOperation`);
    return { durationNs, operations, nanosecondsPerOperation, checksum };
}

function assertKernelInputs(corpus: readonly IRoundCase[], cycles: number, context: string): void {
    positiveSafeInteger(corpus.length, `${context}/corpus length`);
    positiveSafeInteger(cycles, `${context}/cycles`);
}

function runLegacyKernel(corpus: readonly IRoundCase[], cycles: number, clock: MonotonicClock): IMeasurement {
    assertKernelInputs(corpus, cycles, "legacy kernel");
    let checksum = 0;
    const started = clock();
    for (let cycle = 0; cycle < cycles; cycle++) {
        for (let index = 0; index < corpus.length; index++) {
            const item = corpus[index];
            checksum += Number(item.value.toFixed(item.fractionDigits));
        }
    }
    const durationNs = Number(clock() - started);
    const operations = cycles * corpus.length;
    return checkedMeasurement(durationNs, operations, checksum, "legacy kernel");
}

function runCandidateKernel(
    candidate: Round,
    corpus: readonly IRoundCase[],
    cycles: number,
    clock: MonotonicClock,
): IMeasurement {
    assertKernelInputs(corpus, cycles, "candidate kernel");
    let checksum = 0;
    const started = clock();
    for (let cycle = 0; cycle < cycles; cycle++) {
        for (let index = 0; index < corpus.length; index++) {
            const item = corpus[index];
            checksum += candidate(item.value, item.fractionDigits);
        }
    }
    const durationNs = Number(clock() - started);
    const operations = cycles * corpus.length;
    return checkedMeasurement(durationNs, operations, checksum, "candidate kernel");
}

function timeArm(
    arm: ArmName,
    candidate: Round,
    corpus: readonly IRoundCase[],
    cycles: number,
    clock: MonotonicClock,
): IMeasurement {
    return arm === "legacy"
        ? runLegacyKernel(corpus, cycles, clock)
        : runCandidateKernel(candidate, corpus, cycles, clock);
}

function assertSameMeasurementWork(legacy: IMeasurement, candidate: IMeasurement, context: string): void {
    if (legacy.operations !== candidate.operations || !Object.is(legacy.checksum, candidate.checksum)) {
        throw new Error(
            `${context}: timed work differs: legacy=${canonicalJson(legacy)}, candidate=${canonicalJson(candidate)}`,
        );
    }
}

function warmUp(
    candidate: Round,
    corpora: Readonly<Record<WorkloadName, readonly IRoundCase[]>>,
    warmupMs: number,
    clock: MonotonicClock,
): Record<string, unknown> {
    finitePositive(warmupMs, "warmup target milliseconds");
    const started = clock();
    const deadline = started + BigInt(Math.ceil(warmupMs * 1_000_000));
    let rounds = 0;
    while (clock() < deadline) {
        const armOrder = BALANCED_ARM_ORDERS[rounds % BALANCED_ARM_ORDERS.length];
        const workloadOrder = rounds % 2 === 0 ? WORKLOAD_NAMES : [...WORKLOAD_NAMES].reverse();
        for (const workload of workloadOrder) {
            for (const arm of armOrder) timeArm(arm, candidate, corpora[workload], 1, clock);
        }
        rounds++;
    }
    positiveSafeInteger(rounds, "warmup balanced rounds");
    const actualMilliseconds = Number(clock() - started) / 1_000_000;
    finitePositive(actualMilliseconds, "warmup actual milliseconds");
    return {
        targetMilliseconds: warmupMs,
        actualMilliseconds,
        balancedRounds: rounds,
    };
}

function calibrateWorkload(
    candidate: Round,
    corpus: readonly IRoundCase[],
    targetMs: number,
    clock: MonotonicClock,
): Record<string, unknown> & { cyclesPerBlock: number } {
    finitePositive(targetMs, "calibration target milliseconds");
    let pilotCycles = 1;
    let legacy = runLegacyKernel(corpus, pilotCycles, clock);
    let actual = runCandidateKernel(candidate, corpus, pilotCycles, clock);
    const minimumPilotDurationNs = 5_000_000;
    while (Math.min(legacy.durationNs, actual.durationNs) < minimumPilotDurationNs) {
        if (pilotCycles >= MAX_CYCLES_PER_BLOCK) {
            throw new Error(
                `Calibration cannot reach ${minimumPilotDurationNs}ns before the ${MAX_CYCLES_PER_BLOCK}-cycle cap`,
            );
        }
        pilotCycles = Math.min(MAX_CYCLES_PER_BLOCK, pilotCycles * 2);
        legacy = runLegacyKernel(corpus, pilotCycles, clock);
        actual = runCandidateKernel(candidate, corpus, pilotCycles, clock);
    }
    if (Math.min(legacy.durationNs, actual.durationNs) < minimumPilotDurationNs) {
        throw new Error("Calibration pilot duration remained insufficient after the cycle search");
    }
    assertSameMeasurementWork(legacy, actual, "calibration");
    const fasterNanosecondsPerCorpus =
        Math.min(legacy.nanosecondsPerOperation, actual.nanosecondsPerOperation) * corpus.length;
    finitePositive(fasterNanosecondsPerCorpus, "calibration faster nanoseconds per corpus");
    const requiredCycles = Math.max(1, Math.ceil((targetMs * 1_000_000) / fasterNanosecondsPerCorpus));
    positiveSafeInteger(requiredCycles, "calibration required cycles");
    if (requiredCycles > MAX_CYCLES_PER_BLOCK) {
        throw new Error(`Calibration requires ${requiredCycles} cycles, above the ${MAX_CYCLES_PER_BLOCK}-cycle cap`);
    }
    const cyclesPerBlock = requiredCycles;
    return {
        targetMinimumMillisecondsPerArm: targetMs,
        minimumPilotMillisecondsPerArm: minimumPilotDurationNs / 1_000_000,
        pilotCycles,
        pilot: { legacy, candidate: actual },
        fasterNanosecondsPerCorpus,
        cyclesPerBlock,
        maximumCyclesPerBlock: MAX_CYCLES_PER_BLOCK,
        capWasSufficient: true,
    };
}

function runBlocks(
    candidate: Round,
    corpora: Readonly<Record<WorkloadName, readonly IRoundCase[]>>,
    cycles: Readonly<Record<WorkloadName, number>>,
    blocks: number,
    timedArmFloorMs: number,
    clock: MonotonicClock,
): IRawBlock[] {
    positiveSafeInteger(blocks, "timed blocks");
    if (blocks % BOOTSTRAP_SUPERBLOCK_SIZE !== 0) {
        throw new Error(`Timed block count must be divisible by ${BOOTSTRAP_SUPERBLOCK_SIZE}`);
    }
    finitePositive(timedArmFloorMs, "timed arm floor milliseconds");
    const timedArmFloorNs = timedArmFloorMs * 1_000_000;
    const rows: IRawBlock[] = [];
    for (let block = 0; block < blocks; block++) {
        const armOrder = [...BALANCED_ARM_ORDERS[block % BALANCED_ARM_ORDERS.length]];
        const workloadOrder = block % 2 === 0 ? [...WORKLOAD_NAMES] : [...WORKLOAD_NAMES].reverse();
        const workloads = {} as Record<WorkloadName, Record<ArmName, IMeasurement>>;
        for (const workload of workloadOrder) {
            const measurements = {} as Record<ArmName, IMeasurement>;
            for (const arm of armOrder) {
                measurements[arm] = timeArm(arm, candidate, corpora[workload], cycles[workload], clock);
                if (measurements[arm].durationNs < timedArmFloorNs) {
                    throw new Error(
                        `${workload}/block-${block}/${arm} duration ${measurements[arm].durationNs}ns ` +
                            `is below the preregistered ${timedArmFloorNs}ns floor`,
                    );
                }
            }
            assertSameMeasurementWork(measurements.legacy, measurements.candidate, `${workload}/block-${block}`);
            workloads[workload] = measurements;
        }
        rows.push({ block, armOrder, workloadOrder, workloads });
    }
    if (rows.length !== blocks) throw new Error(`Timed row count mismatch: ${rows.length} != ${blocks}`);
    return rows;
}

function mean(values: readonly number[]): number {
    if (!values.length || values.some((value) => !Number.isFinite(value))) {
        throw new Error("Mean requires a non-empty finite sample");
    }
    const result = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (!Number.isFinite(result)) throw new Error(`Mean is not finite: ${result}`);
    return result;
}

function quantile(values: readonly number[], probability: number): number {
    if (
        !values.length ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1 ||
        values.some((value) => !Number.isFinite(value) || value <= 0)
    ) {
        throw new Error("Ratio quantile requires a non-empty finite-positive sample and probability in [0,1]");
    }
    return finitePositive(type7Quantile(values, probability), `ratio quantile ${probability}`);
}

function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function ratioOfTotals(rows: readonly IRawBlock[], workload: WorkloadName): number {
    if (!rows.length) throw new Error(`ratioOfTotals/${workload} requires rows`);
    const legacy = finitePositive(
        rows.reduce((sum, row) => sum + row.workloads[workload].legacy.durationNs, 0),
        `ratioOfTotals/${workload}/legacy`,
    );
    const candidate = finitePositive(
        rows.reduce((sum, row) => sum + row.workloads[workload].candidate.durationNs, 0),
        `ratioOfTotals/${workload}/candidate`,
    );
    return finitePositive(candidate / legacy, `ratioOfTotals/${workload}/ratio`);
}

function pairedLogRatio(rows: readonly IRawBlock[], workload: WorkloadName): number {
    if (!rows.length) throw new Error(`pairedLogRatio/${workload} requires rows`);
    return finitePositive(
        Math.exp(
            mean(
                rows.map((row) =>
                    Math.log(row.workloads[workload].candidate.durationNs / row.workloads[workload].legacy.durationNs),
                ),
            ),
        ),
        `pairedLogRatio/${workload}`,
    );
}

function pairedBootstrap(
    rows: readonly IRawBlock[],
    workload: WorkloadName,
    samples: number,
    seed: number,
    selector: (sample: readonly IRawBlock[], workload: WorkloadName) => number,
): IInterval {
    positiveSafeInteger(samples, "bootstrap samples");
    if (!rows.length || rows.length % BOOTSTRAP_SUPERBLOCK_SIZE !== 0) {
        throw new Error(`Bootstrap rows must contain complete ${BOOTSTRAP_SUPERBLOCK_SIZE}-block superblocks`);
    }
    for (let index = 0; index < rows.length; index++) {
        if (
            rows[index].block !== index ||
            canonicalJson(rows[index].armOrder) !==
                canonicalJson(BALANCED_ARM_ORDERS[index % BOOTSTRAP_SUPERBLOCK_SIZE])
        ) {
            throw new Error(`Bootstrap input schedule drift at row ${index}`);
        }
    }
    const superblocks = Array.from({ length: rows.length / BOOTSTRAP_SUPERBLOCK_SIZE }, (_, index) =>
        rows.slice(index * BOOTSTRAP_SUPERBLOCK_SIZE, (index + 1) * BOOTSTRAP_SUPERBLOCK_SIZE),
    );
    const random = makeRng(seed);
    const estimates: number[] = [];
    for (let sample = 0; sample < samples; sample++) {
        const resampled = Array.from(
            { length: superblocks.length },
            () => superblocks[Math.floor(random() * superblocks.length)],
        ).flat();
        estimates.push(finitePositive(selector(resampled, workload), `bootstrap/${workload}/sample-${sample}`));
    }
    return {
        lower95: quantile(estimates, 0.025),
        median: quantile(estimates, 0.5),
        upper95: quantile(estimates, 0.975),
        samples,
    };
}

function performanceReport(
    rows: readonly IRawBlock[],
    bootstrapSamples: number,
): Record<WorkloadName, Record<string, unknown>> {
    const workloadReport = (workload: WorkloadName, index: number): Record<string, unknown> => {
        const legacyNs = rows.map((row) => row.workloads[workload].legacy.nanosecondsPerOperation);
        const candidateNs = rows.map((row) => row.workloads[workload].candidate.nanosecondsPerOperation);
        return {
            point: {
                ratioOfTotals: ratioOfTotals(rows, workload),
                pairedLogRatio: pairedLogRatio(rows, workload),
                legacyMeanNanosecondsPerOperation: mean(legacyNs),
                candidateMeanNanosecondsPerOperation: mean(candidateNs),
            },
            ratioOfTotalsBootstrap95: pairedBootstrap(
                rows,
                workload,
                bootstrapSamples,
                BOOTSTRAP_SEED ^ Math.imul(index + 1, 0x45d9_f3b),
                ratioOfTotals,
            ),
            pairedLogRatioBootstrap95: pairedBootstrap(
                rows,
                workload,
                bootstrapSamples,
                BOOTSTRAP_SEED ^ Math.imul(index + 1, 0x27d4_eb2d),
                pairedLogRatio,
            ),
        };
    };
    return {
        exactGrid: workloadReport("exactGrid", 0),
        actualTrace: workloadReport("actualTrace", 1),
    };
}

async function main(): Promise<void> {
    // These must precede candidate import: the candidate captures numeric intrinsics during module evaluation,
    // and every timing read must use this exact preregistered monotonic-clock identity.
    const quantileAudit = auditType7Quantile();
    const runtimeInjectionBefore = auditRuntimeInjection();
    const startup = assertUnmodifiedRealmStartup();
    const clock = startup.hrtimeBigint;
    const realmBefore = startup.report.exactNativeAudit as Record<string, unknown>;
    const bunConfigBefore = auditBunConfigFiles();
    const cli = commandLine();
    const sealBefore = runSeal();
    const governedSourceBefore = assertExpectedSourceIdentity(sealBefore, "before");
    const governedRuntimeInputsBefore = assertExpectedRuntimeInputs(sealBefore, "before");
    const { roundUnitStat } = await import("../../../src/units/stat_rounding");
    const candidate = roundUnitStat as Round;

    const rawFloat64 = rawFloat64Correctness(candidate);
    const curated = curatedCorrectness(candidate);
    const nearGrid = nearGridCorrectness(candidate);
    const dynamic = dynamicMutationAndBoxedCorrectness(candidate, startup);
    const actualTrace = await captureActualStatTrace(startup);
    for (const item of actualTrace.cases) {
        assertExact(candidate, item.value, item.fractionDigits, `actual-trace/${item.ordinal}`);
    }
    assertRealmRestored(startup, "before performance warmup");

    const exactGrid = makeExactGridCorpus();
    const corpora: Record<WorkloadName, readonly IRoundCase[]> = {
        exactGrid,
        actualTrace: actualTrace.cases,
    };
    const warmup = warmUp(candidate, corpora, cli.warmupMs, clock);
    const calibration = {
        exactGrid: calibrateWorkload(candidate, corpora.exactGrid, cli.targetMs, clock),
        actualTrace: calibrateWorkload(candidate, corpora.actualTrace, cli.targetMs, clock),
    };
    const cycles = {
        exactGrid: calibration.exactGrid.cyclesPerBlock,
        actualTrace: calibration.actualTrace.cyclesPerBlock,
    };
    const rawBlocks = runBlocks(candidate, corpora, cycles, cli.blocks, cli.timedArmFloorMs, clock);
    const performance = performanceReport(rawBlocks, cli.bootstrapSamples);
    assertRealmRestored(startup, "after performance timing");
    const realmAfter = auditStandardNumericRealm();
    if (canonicalJson(realmBefore) !== canonicalJson(realmAfter)) {
        throw new Error("Numeric/monotonic-clock realm native audit changed during the microbenchmark");
    }
    const sealAfter = runSeal();
    const governedSourceAfter = assertExpectedSourceIdentity(sealAfter, "after");
    const governedRuntimeInputsAfter = assertExpectedRuntimeInputs(sealAfter, "after");
    assertSameSeal(sealBefore, sealAfter);
    const bunConfigAfter = auditBunConfigFiles();
    if (canonicalJson(bunConfigBefore) !== canonicalJson(bunConfigAfter)) {
        throw new Error("Bun configuration envelope changed during the microbenchmark");
    }
    const runtimeInjectionAfter = auditRuntimeInjection();
    if (canonicalJson(runtimeInjectionBefore) !== canonicalJson(runtimeInjectionAfter)) {
        throw new Error("Runtime execution environment changed during the microbenchmark");
    }

    const exactGridInterval = performance.exactGrid.ratioOfTotalsBootstrap95 as IInterval;
    const actualTraceInterval = performance.actualTrace.ratioOfTotalsBootstrap95 as IInterval;
    const exactGridPassed = exactGridInterval.upper95 <= EXACT_GRID_RATIO_UPPER_95_GATE;
    const actualTracePassed = actualTraceInterval.upper95 <= ACTUAL_TRACE_RATIO_UPPER_95_GATE;
    const measurementPassed = exactGridPassed && actualTracePassed;
    const qualified = cli.mode === "evidence" && measurementPassed;
    const report = {
        schema: SCHEMA,
        attemptId: cli.attemptId,
        createdAt: new Date().toISOString(),
        mode: cli.mode,
        protocol: {
            purpose: "Exactness oracle and paired local primitive benchmark for Number(value.toFixed(d)) replacement",
            startupContract: "The candidate is dynamically imported only after standard realm built-ins are verified",
            quantile: {
                schema: TYPE7_QUANTILE_SCHEMA,
                sharedProducerVerifierImplementation: true,
                helper: sealBefore.quantileHelper,
                audit: quantileAudit,
            },
            correctness: {
                rawFloat64Patterns: RAW_FLOAT64_PATTERNS,
                comparisonsPerRawPattern: 2,
                numericComparisonSemantics:
                    "Object.is over JavaScript numeric results; NaN payload-bit identity is outside the numeric-result contract",
                curatedBoundariesGridsAndImmediateNeighbors: true,
                strictNearGridBoundariesRandomInt32ValuesAndSignedZero: true,
                dynamicMutationAndBoxedFallbackDeliberatelyUntimed: true,
                productionAdjustBaseStatsTraceDeliberatelyCapturedUntimed: true,
            },
            timing: {
                clock:
                    "The exact audited startup process.hrtime.bigint function is captured before imports and " +
                    "is the only clock used by warmup, calibration, and timed arms",
                evidenceBlocks: EVIDENCE_BLOCKS,
                blocks: cli.blocks,
                schedule: BALANCED_ARM_ORDERS,
                candidateFirstBlocks: rawBlocks.filter((row) => row.armOrder[0] === "candidate").length,
                legacyFirstBlocks: rawBlocks.filter((row) => row.armOrder[0] === "legacy").length,
                workloadTraversalReversedEveryBlock: true,
                targetMinimumMillisecondsPerArmBlock: cli.targetMs,
                minimumRequiredMillisecondsPerTimedArmBlock: cli.timedArmFloorMs,
                minimumObservedMillisecondsPerTimedArmBlock:
                    Math.min(
                        ...rawBlocks.flatMap((row) =>
                            WORKLOAD_NAMES.flatMap((workload) =>
                                (["legacy", "candidate"] as const).map(
                                    (arm) => row.workloads[workload][arm].durationNs,
                                ),
                            ),
                        ),
                    ) / 1_000_000,
                checksumsAndOperationCountsMustMatch: true,
            },
            bootstrap: {
                method:
                    "paired nonparametric bootstrap; whole contiguous four-block ABBA/BAAB superblocks " +
                    "resampled with replacement",
                unit: "contiguous four-block balanced arm-order superblock",
                blocksPerSuperblock: BOOTSTRAP_SUPERBLOCK_SIZE,
                superblocks: cli.blocks / BOOTSTRAP_SUPERBLOCK_SIZE,
                samples: cli.bootstrapSamples,
                seedHex: `0x${BOOTSTRAP_SEED.toString(16)}`,
                intervals: "percentile 95%",
            },
        },
        source: {
            before: sealBefore,
            after: sealAfter,
            unchanged: true,
            frozenCandidateIdentity: {
                before: governedSourceBefore,
                after: governedSourceAfter,
                unchanged: canonicalJson(governedSourceBefore) === canonicalJson(governedSourceAfter),
            },
            frozenRuntimeInputs: {
                before: governedRuntimeInputsBefore,
                after: governedRuntimeInputsAfter,
                unchanged: canonicalJson(governedRuntimeInputsBefore) === canonicalJson(governedRuntimeInputsAfter),
            },
            bunConfiguration: {
                before: bunConfigBefore,
                after: bunConfigAfter,
                unchanged: true,
            },
        },
        runtime: {
            platform: platform(),
            release: release(),
            arch: arch(),
            cpuModel: cpus()[0]?.model ?? "unknown",
            logicalCpus: cpus().length,
            bunVersion: Bun.version,
            bunRevision: Bun.revision,
            bunExecutableSha256: sealBefore.bunExecutable.sha256,
        },
        realm: {
            startupInvariant:
                "Fresh Bun realm with exact audited native Number, Number.prototype.toFixed, " +
                "Number.isSafeInteger, Reflect.apply, Function.prototype.toString, process.hrtime, and " +
                "process.hrtime.bigint; all timing uses the captured startup bigint clock",
            preloadHooksAbsent: true,
            runtimeInjection: {
                before: runtimeInjectionBefore,
                after: runtimeInjectionAfter,
                unchanged: true,
            },
            startupContract: startup.report,
            before: realmBefore,
            after: realmAfter,
            unchanged: true,
        },
        correctness: {
            passed: true,
            rawFloat64,
            curated,
            nearGrid,
            dynamicMutationAndBoxedFallback: dynamic,
            actualRepresentativeStatTrace: actualTrace.report,
            actualTraceComparisons: actualTrace.cases.length,
        },
        workloads: {
            exactGrid: {
                entries: exactGrid.length,
                independentlyVerifiedFastEligibleEntries: exactGrid.filter((item) =>
                    isFastEligible(item.value, item.fractionDigits),
                ).length,
                independentlyVerifiedEligibility: exactGrid.reduce(
                    (counts, item) => {
                        counts[fastEligibility(item.value, item.fractionDigits).kind]++;
                        return counts;
                    },
                    { exactGrid: 0, nearGrid: 0, numericFallback: 0 } as Record<FastEligibilityKind, number>,
                ),
                corpusSha256: digest(
                    exactGrid.map((item) => [Object.is(item.value, -0) ? "-0" : item.value, item.fractionDigits]),
                ),
            },
            actualTrace: {
                entries: actualTrace.cases.length,
                corpusSha256: actualTrace.report.traceSha256 as string,
            },
        },
        warmup,
        calibration,
        performance,
        gates: {
            exactGrid: {
                metric: "paired-bootstrap upper 95% bound of candidate/legacy ratio of total durations",
                thresholdInclusive: EXACT_GRID_RATIO_UPPER_95_GATE,
                observedUpper95: exactGridInterval.upper95,
                passed: exactGridPassed,
            },
            actualTrace: {
                metric: "paired-bootstrap upper 95% bound of candidate/legacy ratio of total durations",
                thresholdInclusive: ACTUAL_TRACE_RATIO_UPPER_95_GATE,
                observedUpper95: actualTraceInterval.upper95,
                passed: actualTracePassed,
            },
            measurementPassed,
            qualified,
            smokeNeverQualifies: cli.mode === "smoke",
        },
        rawBlocks,
    };
    writeJsonAtomicExclusive(cli.out, report);
    console.log(
        JSON.stringify(
            {
                out: cli.out,
                mode: cli.mode,
                rawFloat64Comparisons: RAW_FLOAT64_PATTERNS * 2,
                curatedComparisons: curated.comparisons as number,
                nearGridComparisons: nearGrid.comparisons as number,
                actualTraceEntries: actualTrace.cases.length,
                exactGridRatioUpper95: exactGridInterval.upper95,
                actualTraceRatioUpper95: actualTraceInterval.upper95,
                qualified,
            },
            null,
            2,
        ),
    );
    if (cli.mode === "evidence" && !measurementPassed) {
        throw new Error(
            `Stat-rounding micro gates failed: exactGrid=${exactGridInterval.upper95}, ` +
                `actualTrace=${actualTraceInterval.upper95}`,
        );
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
}
