#!/usr/bin/env bun

/*
 * Immutable A/B replay of the ranked server's real outer 300 ms bot-search wrapper.
 *
 * This tool deliberately imports an archived server source tree and aliases every
 * @heroesofcrypto/common import to one immutable common tree. It never edits either
 * repository or node_modules. The coordinator starts one fresh process per variant
 * because a Bun module graph cannot safely contain two implementations of the same
 * package singleton.
 *
 * Example:
 *   bun docs/evidence/tools/ranked_outer_300_replay.ts \
 *     --baseline-root /tmp/hoc-ray-f02e-baseline... \
 *     --candidate-root /tmp/hoc-ray-f02e-candidate... \
 *     --server-root /tmp/hoc-server-8519... \
 *     --server-sha 8519fbded3c200a159b2062d00ad5f1f929fe47f \
 *     --common-base-sha f02e8066cb454e74f28b2b95e29b41502fa0e048 \
 *     --scenario-count 3 --side-swaps 1 --full-states 0 \
 *     --out /tmp/ranked-outer-300.json
 */

import { plugin } from "bun";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA = "hoc.a13.ranked-outer-300-replay.v2";
const EXPECTED_COMMON_BASE_SHA = "f02e8066cb454e74f28b2b95e29b41502fa0e048";
const EXPECTED_SERVER_SHA = "8519fbded3c200a159b2062d00ad5f1f929fe47f";
const EXPECTED_OUTER_CIRCUIT_MS = 300;
const EXPECTED_INNER_DECISION_DEADLINE_MS = 175;
const EXPECTED_INNER_CIRCUIT_MS = 275;
const EXPECTED_INPUTS = {
    baselineSrc: {
        files: 365,
        bytes: 9_753_913,
        sha256: "d66eea6fadc27d259743269611e11a8c96c9eb285d5622217da06274f0ce5c29",
    },
    candidateSrc: {
        files: 366,
        bytes: 9_758_586,
        sha256: "bd8bb9fd5ff060fdf3d5092ed2351acdb55b4de46b94d440b85beaddaeecee02",
    },
    serverSrc: {
        files: 148,
        bytes: 1_385_958,
        sha256: "b8177d6920bb72f93b01896629fb1738b4e375bc9af1df22ee0623518d925c92",
    },
    commonPackageSha256: "990a779e01b64fab88bdb72cb7fd6fa790eabc66a2f550d1e3481d620e1cf001",
    commonWorkspaceLockSha256: "227ac3cc87c8488dea87841311baf509e361c22610ffc0ee21c553245e58ab54",
    serverPackageSha256: "487d4273b5365cfff122f279d4150911911cde416e5dd6c4f4522c5809f6125d",
    serverLockSha256: "0246f882a3e7d80a052fab325b6d47e06914d72c76977822bcd9c646f65eed75",
    delta: {
        added: ["grid/ray_traversal.ts"],
        removed: [],
        modified: ["handlers/attack_handler.ts"],
    },
} as const;
const DEFAULT_BASE_SEED = 930_722_001;
const DEFAULT_SCENARIOS = 1;
const DEFAULT_MAX_TICKS = 8_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type UnknownRecord = Record<string, unknown>;

interface ICli {
    mode: "coordinator" | "worker";
    baselineRoot?: string;
    candidateRoot?: string;
    commonRoot?: string;
    serverRoot: string;
    serverSha: string;
    commonBaseSha: string;
    output: string;
    workerOutput?: string;
    variant?: "baseline" | "candidate";
    scenarioCount: number;
    baseSeed: number;
    sideSwaps: boolean;
    fullStates: boolean;
    maxTicks: number;
}

interface IScenario {
    scenarioIndex: number;
    seed: number;
    gridType: number;
    rosterA: number[];
    rosterB: number[];
    artifactsA: { tier1: number; tier2: number };
    artifactsB: { tier1: number; tier2: number };
}

interface ICounterSnapshot {
    decisions: number;
    searched: number;
    overrides: number;
    illegalIncumbent: number;
    singleCandidate: number;
    candidatesTotal: number;
    scoredCandidatesTotal: number;
    deadlineFallbacks: number;
    rolloutTurnsTotal: number;
    circuitSkipped: number;
    msTotal: number;
}

type ISemanticCounterDelta = Omit<ICounterSnapshot, "msTotal">;

interface ISourceEntrySeal {
    path: string;
    bytes: number;
    sha256: string;
}

interface ISourceTreeSeal {
    root: string;
    files: number;
    bytes: number;
    sha256: string;
    entries: ISourceEntrySeal[];
}

interface IFileSeal {
    path: string;
    bytes: number;
    sha256: string;
}

interface IInnerDecisionTrace {
    ordinal: number;
    elapsedMs: number;
    unitId: string;
    unitName: string;
    lap: number;
    incumbent: JsonValue;
    chosen: JsonValue;
    overridden: boolean;
    circuitBefore: boolean;
    circuitAfter: boolean;
    countersBefore: ICounterSnapshot;
    countersAfter: ICounterSnapshot;
    counterDelta: ICounterSnapshot;
}

interface IOuterDecisionTrace {
    ordinal: number;
    wrapperElapsedPerformanceMs: number;
    wrapperElapsedDateMs: number;
    unitId: string;
    unitName: string;
    lap: number;
    incumbent: JsonValue;
    chosen: JsonValue;
    overridden: boolean;
    outerCircuitBefore: boolean;
    outerCircuitAfter: boolean;
    crossedOuterCircuit: boolean;
    restorableStateBeforeSha256: string;
    restorableStateAfterSha256: string;
    restorableStateRestored: boolean;
    restorableStateBefore?: JsonValue;
    restorableStateAfter?: JsonValue;
}

interface IStateTrace {
    sequence: number;
    lap: number;
    actionType: number;
    engineSha256: string;
    fullSha256: string;
    fullState?: JsonValue;
}

interface IMatchRecord {
    key: string;
    scenarioIndex: number;
    seed: number;
    swapped: boolean;
    gridType: number;
    lowerRoster: number[];
    upperRoster: number[];
    lowerArtifacts: { tier1: number; tier2: number };
    upperArtifacts: { tier1: number; tier2: number };
    finished: boolean;
    ticks: number;
    completeReplay: boolean;
    productionReplayComplete: boolean;
    captureComplete: boolean;
    stateTraceCaptureComplete: boolean;
    currentLap: number;
    journalEntries: number;
    eventEntries: number;
    retainedJournalEntries: number;
    retainedEventEntries: number;
    proposalRejects: number;
    serverErrors: number;
    driverCreations: number;
    driverCreationMs: number[];
    observedDriverConfiguration: {
        decisionDeadlineMs: number;
        circuitBreakerMs: number;
    };
    innerDecisions: IInnerDecisionTrace[];
    outerDecisions: IOuterDecisionTrace[];
    innerCountersFinal: ICounterSnapshot;
    innerCircuitOpened: boolean;
    outerCircuitOpened: boolean;
    outerCircuitWarningCount: number;
    chosenDecisionTraceSha256: string;
    counterDeltaTraceSha256: string;
    semanticDigestSha256: string;
    journalDigestSha256: string;
    eventDigestSha256: string;
    stateTraceDigestSha256: string;
    finalStateSha256: string;
    stateTrace: IStateTrace[];
    journal: JsonValue;
    events: JsonValue;
    finalSnapshot: JsonValue;
    logs: string[];
}

interface IVariantResult {
    schema: typeof SCHEMA;
    variant: "baseline" | "candidate";
    commonRoot: string;
    serverRoot: string;
    scenarioPlan: IScenario[];
    matches: IMatchRecord[];
    source: {
        commonBaseSha: string;
        serverSha: string;
        attackHandlerSha256: string;
        rayTraversalSha256: string | null;
        playSessionSha256: string;
        botSearchSha256: string;
    };
    runtime: {
        bun: string;
        platform: string;
        arch: string;
        importedOuterCircuitMs: number;
        observedInnerDecisionDeadlineMs: number;
        observedInnerCircuitBreakerMs: number;
        deterministicRandom: true;
    };
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    throw new Error(`${name} must be 0/1 or true/false`);
}

function parseInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} through ${max}; got ${String(raw)}`);
    }
    return value;
}

function parseRequiredCommit(name: string, raw: string | undefined, expected: string): string {
    if (!raw || raw === "unknown" || !/^[0-9a-f]{40}$/i.test(raw)) {
        throw new Error(`--${name} must be an explicit 40-character commit SHA`);
    }
    if (raw !== expected) {
        throw new Error(`--${name}=${raw} does not match the frozen expected identity ${expected}`);
    }
    return raw;
}

function parseArgs(argv: readonly string[]): ICli {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) throw new Error(`unexpected positional argument ${token}`);
        const equals = token.indexOf("=");
        if (equals >= 0) {
            values.set(token.slice(2, equals), token.slice(equals + 1));
        } else {
            const key = token.slice(2);
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
            values.set(key, value);
            index += 1;
        }
    }
    const mode = values.get("worker") === "1" ? "worker" : "coordinator";
    const serverRoot = resolve(values.get("server-root") ?? "");
    const output = resolve(values.get("out") ?? values.get("worker-out") ?? "");
    if (!values.get("server-root")) throw new Error("--server-root is required");
    if (!values.get("out") && !values.get("worker-out")) throw new Error("--out is required");
    const variantRaw = values.get("variant");
    const variant = variantRaw === "baseline" || variantRaw === "candidate" ? variantRaw : undefined;
    if (mode === "worker" && !variant) throw new Error("worker requires --variant baseline|candidate");
    if (mode === "worker" && !values.get("common-root")) throw new Error("worker requires --common-root");
    if (mode === "coordinator" && (!values.get("baseline-root") || !values.get("candidate-root"))) {
        throw new Error("coordinator requires --baseline-root and --candidate-root");
    }
    return {
        mode,
        baselineRoot: values.get("baseline-root") ? resolve(values.get("baseline-root")!) : undefined,
        candidateRoot: values.get("candidate-root") ? resolve(values.get("candidate-root")!) : undefined,
        commonRoot: values.get("common-root") ? resolve(values.get("common-root")!) : undefined,
        serverRoot,
        serverSha: parseRequiredCommit("server-sha", values.get("server-sha"), EXPECTED_SERVER_SHA),
        commonBaseSha: parseRequiredCommit("common-base-sha", values.get("common-base-sha"), EXPECTED_COMMON_BASE_SHA),
        output,
        workerOutput: values.get("worker-out") ? resolve(values.get("worker-out")!) : undefined,
        variant,
        scenarioCount: parseInteger("scenario-count", values.get("scenario-count"), DEFAULT_SCENARIOS, 1, 1_000),
        baseSeed: parseInteger("base-seed", values.get("base-seed"), DEFAULT_BASE_SEED, 0, 0xffffffff),
        sideSwaps: parseBoolean("side-swaps", values.get("side-swaps"), true),
        fullStates: parseBoolean("full-states", values.get("full-states"), false),
        maxTicks: parseInteger("max-ticks", values.get("max-ticks"), DEFAULT_MAX_TICKS, 10, 1_000_000),
    };
}

function sha256Text(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
    return createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function sealFile(path: string): Promise<IFileSeal> {
    const contents = await readFile(path);
    return { path, bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") };
}

async function sealSourceTree(root: string): Promise<ISourceTreeSeal> {
    const entries: ISourceEntrySeal[] = [];
    const walk = async (directory: string): Promise<void> => {
        const directoryEntries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
            compareText(left.name, right.name),
        );
        for (const entry of directoryEntries) {
            const absolute = join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
                continue;
            }
            if (!entry.isFile()) {
                throw new Error(`source seal rejects non-file entry ${absolute}`);
            }
            const contents = await readFile(absolute);
            entries.push({
                path: relative(root, absolute).replaceAll("\\", "/"),
                bytes: contents.byteLength,
                sha256: createHash("sha256").update(contents).digest("hex"),
            });
        }
    };
    await walk(root);
    return {
        root,
        files: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        sha256: sha256Text(JSON.stringify(entries)),
        entries,
    };
}

function treeSealSummary(seal: ISourceTreeSeal): Omit<ISourceTreeSeal, "entries"> {
    const { entries: _entries, ...summary } = seal;
    return summary;
}

function assertTreeSeal(
    label: string,
    actual: ISourceTreeSeal,
    expected: { files: number; bytes: number; sha256: string },
): void {
    if (actual.files !== expected.files || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error(
            `${label} source seal mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(treeSealSummary(actual))}`,
        );
    }
}

function sourceDelta(
    baseline: ISourceTreeSeal,
    candidate: ISourceTreeSeal,
): { added: string[]; removed: string[]; modified: string[] } {
    const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const candidateByPath = new Map(candidate.entries.map((entry) => [entry.path, entry]));
    return {
        added: candidate.entries
            .filter((entry) => !baselineByPath.has(entry.path))
            .map((entry) => entry.path)
            .sort(compareText),
        removed: baseline.entries
            .filter((entry) => !candidateByPath.has(entry.path))
            .map((entry) => entry.path)
            .sort(compareText),
        modified: baseline.entries
            .filter((entry) => candidateByPath.get(entry.path)?.sha256 !== entry.sha256)
            .filter((entry) => candidateByPath.has(entry.path))
            .map((entry) => entry.path)
            .sort(compareText),
    };
}

function assertExactJson(label: string, actual: unknown, expected: unknown): void {
    if (digestJson(actual) !== digestJson(expected)) {
        throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
    }
}

async function nearestAncestorFile(start: string, name: string): Promise<string | null> {
    let directory = resolve(start);
    for (;;) {
        const candidate = join(directory, name);
        if (await pathExists(candidate)) return candidate;
        const parent = dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}

async function verifyFrozenInputs(cli: ICli): Promise<UnknownRecord> {
    if (cli.mode !== "coordinator") throw new Error("frozen paired input verification is coordinator-only");
    const baselineRoot = cli.baselineRoot!;
    const candidateRoot = cli.candidateRoot!;
    const [baselineArchiveRealpath, candidateArchiveRealpath] = await Promise.all([
        realpath(baselineRoot),
        realpath(candidateRoot),
    ]);
    const identicalSourceControl = baselineArchiveRealpath === candidateArchiveRealpath;
    const [baselineSrc, candidateSrc, serverSrc] = await Promise.all([
        sealSourceTree(join(baselineRoot, "src")),
        sealSourceTree(join(candidateRoot, "src")),
        sealSourceTree(join(cli.serverRoot, "src")),
    ]);
    assertTreeSeal("baseline common", baselineSrc, EXPECTED_INPUTS.baselineSrc);
    assertTreeSeal(
        "candidate common",
        candidateSrc,
        identicalSourceControl ? EXPECTED_INPUTS.baselineSrc : EXPECTED_INPUTS.candidateSrc,
    );
    assertTreeSeal("server", serverSrc, EXPECTED_INPUTS.serverSrc);
    const delta = sourceDelta(baselineSrc, candidateSrc);
    assertExactJson(
        "common A/B source delta",
        delta,
        identicalSourceControl ? { added: [], removed: [], modified: [] } : EXPECTED_INPUTS.delta,
    );

    const [baselinePackage, candidatePackage, serverPackage, serverLock] = await Promise.all([
        sealFile(join(baselineRoot, "package.json")),
        sealFile(join(candidateRoot, "package.json")),
        sealFile(join(cli.serverRoot, "package.json")),
        sealFile(join(cli.serverRoot, "bun.lock")),
    ]);
    if (
        baselinePackage.sha256 !== EXPECTED_INPUTS.commonPackageSha256 ||
        candidatePackage.sha256 !== EXPECTED_INPUTS.commonPackageSha256
    ) {
        throw new Error("common package.json seal mismatch");
    }
    if (serverPackage.sha256 !== EXPECTED_INPUTS.serverPackageSha256) {
        throw new Error("server package.json seal mismatch");
    }
    if (serverLock.sha256 !== EXPECTED_INPUTS.serverLockSha256) throw new Error("server bun.lock seal mismatch");
    if ((await pathExists(join(baselineRoot, "bun.lock"))) || (await pathExists(join(candidateRoot, "bun.lock")))) {
        throw new Error("frozen common archives unexpectedly contain a lockfile");
    }

    const [baselineNodeModules, candidateNodeModules, serverNodeModules] = await Promise.all([
        realpath(join(baselineRoot, "node_modules")),
        realpath(join(candidateRoot, "node_modules")),
        realpath(join(cli.serverRoot, "node_modules")),
    ]);
    if (baselineNodeModules !== candidateNodeModules) {
        throw new Error("baseline/candidate common archives resolve different node_modules trees");
    }
    const [commonWorkspaceLockPath, serverResolvedLockPath] = await Promise.all([
        nearestAncestorFile(dirname(baselineNodeModules), "bun.lock"),
        nearestAncestorFile(dirname(serverNodeModules), "bun.lock"),
    ]);
    if (!commonWorkspaceLockPath || !serverResolvedLockPath) throw new Error("could not resolve dependency lockfiles");
    const [commonWorkspaceLock, serverResolvedLock] = await Promise.all([
        sealFile(commonWorkspaceLockPath),
        sealFile(serverResolvedLockPath),
    ]);
    if (commonWorkspaceLock.sha256 !== EXPECTED_INPUTS.commonWorkspaceLockSha256) {
        throw new Error("common workspace bun.lock seal mismatch");
    }
    if (serverResolvedLock.sha256 !== EXPECTED_INPUTS.serverLockSha256) {
        throw new Error("resolved server bun.lock seal mismatch");
    }

    return {
        commitLabels: { common: cli.commonBaseSha, server: cli.serverSha },
        mode: identicalSourceControl ? "identical-source-control" : "baseline-candidate",
        trees: { baselineSrc, candidateSrc, serverSrc },
        exactDelta: delta,
        packages: {
            baselinePackage,
            candidatePackage,
            commonArchiveLock: null,
            serverPackage,
            serverArchiveLock: serverLock,
        },
        dependencies: {
            baselineNodeModules,
            candidateNodeModules,
            serverNodeModules,
            commonWorkspaceLock,
            serverResolvedLock,
            nodeModulesContentSealed: false,
            limitation:
                "package.json and resolved bun.lock files are sealed, but the symlinked node_modules file contents are not recursively sealed; lock/install drift remains outside this source-equivalence proof",
        },
    };
}

function canonicalize(value: unknown, ancestors: WeakSet<object> = new WeakSet()): JsonValue {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isNaN(value)) return { $number: "NaN" };
        if (value === Number.POSITIVE_INFINITY) return { $number: "+Infinity" };
        if (value === Number.NEGATIVE_INFINITY) return { $number: "-Infinity" };
        if (Object.is(value, -0)) return { $number: "-0" };
        return value;
    }
    if (typeof value === "bigint") return { $bigint: value.toString() };
    if (typeof value === "undefined") return { $undefined: true };
    if (typeof value === "symbol") return { $symbol: String(value) };
    if (typeof value === "function") return { $function: value.name || "anonymous" };
    const objectValue = value as object;
    if (ancestors.has(objectValue)) return { $circular: true };
    ancestors.add(objectValue);
    try {
        if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
        if (value instanceof Map) {
            return {
                $map: [...value.entries()].map(([key, entry]) => [
                    canonicalize(key, ancestors),
                    canonicalize(entry, ancestors),
                ]),
            };
        }
        if (value instanceof Set) return { $set: [...value].map((entry) => canonicalize(entry, ancestors)) };
        if (value instanceof Date) return { $date: value.toISOString() };
        if (ArrayBuffer.isView(value)) {
            const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            return { $typedArray: value.constructor.name, bytes: [...bytes] };
        }
        const maybeQueue = value as { toArray?: () => unknown[] };
        if (typeof maybeQueue.toArray === "function" && value.constructor?.name === "Denque") {
            return { $class: "Denque", values: canonicalize(maybeQueue.toArray(), ancestors) };
        }
        const record = value as UnknownRecord;
        const output: Record<string, JsonValue> = {};
        const constructorName = value.constructor?.name;
        if (constructorName && constructorName !== "Object") output.$class = constructorName;
        for (const key of Object.keys(record).sort()) output[key] = canonicalize(record[key], ancestors);
        return output;
    } finally {
        ancestors.delete(objectValue);
    }
}

function digestJson(value: unknown): string {
    return sha256Text(JSON.stringify(canonicalize(value)));
}

function sanitizeSemantic(value: unknown): JsonValue {
    const canonical = canonicalize(value);
    const visit = (entry: JsonValue): JsonValue => {
        if (Array.isArray(entry)) return entry.map(visit);
        if (entry === null || typeof entry !== "object") return entry;
        const output: Record<string, JsonValue> = {};
        for (const [key, child] of Object.entries(entry)) {
            if (
                key === "actionId" ||
                key === "acceptedAtMs" ||
                key === "serverTimeMs" ||
                key === "placementDeadlineMs" ||
                key === "lastSeenMs" ||
                key === "currentTurnStartMs" ||
                key === "currentTurnEndMs" ||
                key === "currentTurnStart" ||
                key === "currentTurnEnd" ||
                key === "currentLapTotalTimePerTeam" ||
                key === "msTotal"
            ) {
                continue;
            }
            output[key] = visit(child);
        }
        return output;
    };
    return visit(canonical);
}

function actionSignature(actions: unknown): JsonValue {
    return sanitizeSemantic(actions);
}

function counterSnapshot(driver: UnknownRecord | undefined): ICounterSnapshot {
    const counters = (driver?.counters ?? {}) as UnknownRecord;
    const number = (key: string): number => {
        const value = counters[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    return {
        decisions: number("decisions"),
        searched: number("searched"),
        overrides: number("overrides"),
        illegalIncumbent: number("illegalIncumbent"),
        singleCandidate: number("singleCandidate"),
        candidatesTotal: number("candidatesTotal"),
        scoredCandidatesTotal: number("scoredCandidatesTotal"),
        deadlineFallbacks: number("deadlineFallbacks"),
        rolloutTurnsTotal: number("rolloutTurnsTotal"),
        circuitSkipped: number("circuitSkipped"),
        msTotal: number("msTotal"),
    };
}

function subtractCounters(after: ICounterSnapshot, before: ICounterSnapshot): ICounterSnapshot {
    return Object.fromEntries(
        Object.keys(after).map((key) => [
            key,
            after[key as keyof ICounterSnapshot] - before[key as keyof ICounterSnapshot],
        ]),
    ) as unknown as ICounterSnapshot;
}

function semanticCounterDelta(delta: ICounterSnapshot): ISemanticCounterDelta {
    const { msTotal: _msTotal, ...semantic } = delta;
    return semantic;
}

function installCommonAlias(commonRoot: string): void {
    plugin({
        name: `hoc-common-alias-${sha256Text(commonRoot).slice(0, 12)}`,
        setup(builder) {
            builder.onResolve({ filter: /^@heroesofcrypto\/common(?:\/.*)?$/ }, (args) => {
                const suffix = args.path.slice("@heroesofcrypto/common".length);
                return { path: suffix ? join(commonRoot, suffix) : join(commonRoot, "src/index.ts") };
            });
        },
    });
}

let deterministicUuidNamespace = "worker-bootstrap";
let deterministicUuidOrdinal = 0;
let deterministicCryptoBlockOrdinal = 0;

function resetDeterministicUuids(namespace: string): void {
    deterministicUuidNamespace = namespace;
    deterministicUuidOrdinal = 0;
    deterministicCryptoBlockOrdinal = 0;
}

function nextDeterministicUuid(): `${string}-${string}-${string}-${string}-${string}` {
    const chars = sha256Text(`${deterministicUuidNamespace}:${deterministicUuidOrdinal++}`).slice(0, 32).split("");
    chars[12] = "4";
    chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16], 16) & 3];
    const hex = chars.join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fillDeterministicRandomValues<T extends ArrayBufferView>(array: T): T {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let offset = 0; offset < bytes.length;) {
        const block = createHash("sha256")
            .update(`${deterministicUuidNamespace}:secure:${deterministicCryptoBlockOrdinal++}`)
            .digest();
        const length = Math.min(block.length, bytes.length - offset);
        bytes.set(block.subarray(0, length), offset);
        offset += length;
    }
    return array;
}

function installDeterministicUuids(): void {
    // Common's createSecureUuid()/getRandomInt production fallback and uuid.v4() consult these
    // functions at call time. This is test-process-only pairing: no server/common source is edited.
    // A per-match reset keeps each A/B pair independent of prior scenario control flow.
    const crypto = globalThis.crypto as Crypto & { randomUUID: () => string };
    crypto.randomUUID = nextDeterministicUuid;
    crypto.getRandomValues = fillDeterministicRandomValues as Crypto["getRandomValues"];
}

async function dynamicModule(root: string, relativePath: string): Promise<UnknownRecord> {
    return (await import(pathToFileURL(join(root, relativePath)).href)) as UnknownRecord;
}

function pickDistinct(rng: () => number, pool: readonly number[], count: number, excluded: Set<number>): number[] {
    const available = pool.filter((id) => Number.isInteger(id) && id > 0 && !excluded.has(id));
    const output: number[] = [];
    while (output.length < count) {
        if (!available.length) throw new Error(`not enough creatures to select ${count} distinct entries`);
        const [picked] = available.splice(Math.floor(rng() * available.length), 1);
        output.push(picked);
        excluded.add(picked);
    }
    return output;
}

function makeRoster(rng: () => number, creaturesByLevel: UnknownRecord, excluded = new Set<number>()): number[] {
    const level = (value: number): readonly number[] => {
        const entries = creaturesByLevel[String(value)] ?? creaturesByLevel[value];
        if (!Array.isArray(entries)) throw new Error(`CreatureByLevel is missing level ${value}`);
        return entries as number[];
    };
    return [
        ...pickDistinct(rng, level(1), 2, excluded),
        ...pickDistinct(rng, level(2), 2, excluded),
        ...pickDistinct(rng, level(3), 1, excluded),
        ...pickDistinct(rng, level(4), 1, excluded),
    ];
}

function pickArtifact(rng: () => number, list: unknown): number {
    if (!Array.isArray(list) || !list.length) return 0;
    const entry = list[Math.floor(rng() * list.length)] as UnknownRecord;
    return typeof entry.id === "number" ? entry.id : 0;
}

function buildScenarioPlan(
    count: number,
    baseSeed: number,
    common: UnknownRecord,
    army: UnknownRecord,
    creatureGen: UnknownRecord,
): IScenario[] {
    const makeRng = army.makeRng as (seed: number) => () => number;
    const hashParts = army.hashSimulationParts as (...parts: Array<string | number | boolean>) => number;
    const creatureByLevel = creatureGen.CreatureByLevel as UnknownRecord;
    const gridVals = common.GridVals as UnknownRecord;
    const artifact = common.Artifact as UnknownRecord;
    const maps = [gridVals.NORMAL, gridVals.LAVA_CENTER, gridVals.BLOCK_CENTER] as number[];
    return Array.from({ length: count }, (_, scenarioIndex) => {
        const seed = (baseSeed + scenarioIndex) >>> 0;
        const rng = makeRng(hashParts("ranked-outer-300", seed, scenarioIndex));
        const excluded = new Set<number>();
        const rosterA = makeRoster(rng, creatureByLevel, excluded);
        const rosterB = makeRoster(rng, creatureByLevel, excluded);
        return {
            scenarioIndex,
            seed,
            gridType: maps[scenarioIndex % maps.length],
            rosterA,
            rosterB,
            artifactsA: {
                tier1: pickArtifact(rng, artifact.TIER1_ARTIFACT_LIST),
                tier2: pickArtifact(rng, artifact.TIER2_ARTIFACT_LIST),
            },
            artifactsB: {
                tier1: pickArtifact(rng, artifact.TIER1_ARTIFACT_LIST),
                tier2: pickArtifact(rng, artifact.TIER2_ARTIFACT_LIST),
            },
        };
    });
}

interface ISessionInternals extends UnknownRecord {
    phase: number;
    latestSequence: number;
    placementStage: number;
    currentActiveUnitId: string;
    botSearchCircuitOpen: boolean;
    botSearchFightReady: boolean;
    botSearchMatchEnded: boolean;
    botSearchDriverVersion?: string;
    fightProperties: UnknownRecord;
    grid: UnknownRecord;
    unitsHolder: UnknownRecord;
    players: Map<string, UnknownRecord>;
    unitMetadata: Map<string, UnknownRecord>;
    sceneLog: { snapshot(): unknown };
    damageStatisticHolder: { snapshot(): unknown };
    journal: unknown[];
    events: unknown[];
    publishAccepted: (...args: unknown[]) => unknown;
    searchBotDecision: (...args: unknown[]) => unknown;
    getSnapshot(options?: UnknownRecord): UnknownRecord;
    getReplay(options?: UnknownRecord): UnknownRecord;
}

function battleSnapshotPayload(snapshot: UnknownRecord): UnknownRecord {
    const fight =
        snapshot.fight && typeof snapshot.fight === "object"
            ? { ...(snapshot.fight as UnknownRecord) }
            : snapshot.fight;
    if (fight && typeof fight === "object") {
        const fightRecord = fight as UnknownRecord;
        // These fields are generated from secure UUID/wall-clock sources and cannot alter a legal
        // decision. They are explicitly outside the exact semantic trace contract.
        delete fightRecord.id;
        delete fightRecord.currentTurnStart;
        delete fightRecord.currentTurnEnd;
        delete fightRecord.currentLapTotalTimePerTeam;
    }
    return {
        units: snapshot.units,
        unitOrder: snapshot.unitOrder,
        grid: snapshot.grid,
        fight,
        holder: snapshot.holder,
        aiTargetMemory: snapshot.aiTargetMemory,
    };
}

function serverSemanticProjection(session: ISessionInternals, rawDriver: UnknownRecord | undefined): UnknownRecord {
    const selectedSessionFields = [
        "phase",
        "latestSequence",
        "placementStage",
        "currentActiveUnitId",
        "pendingMoveFollowUp",
        "lowerPlacements",
        "upperPlacements",
        "synergyFactionBaselinePerTeam",
        "botSetupDoneTeams",
        "fightStartLowerUnits",
        "fightStartUpperUnits",
        "fightStartLowerHealth",
        "fightStartUpperHealth",
        "fightStartLowerRoster",
        "fightStartUpperRoster",
        "automatedTurnKeys",
        "consecutiveTurnTimeoutsByPlayer",
        "botSearchDriverVersion",
        "botSearchFightReady",
        "botSearchMatchEnded",
        "botSearchCircuitOpen",
    ] as const;
    const sessionState: UnknownRecord = {};
    for (const field of selectedSessionFields) sessionState[field] = session[field];
    return {
        session: sessionState,
        players: session.players,
        unitMetadata: session.unitMetadata,
        sceneLog: session.sceneLog.snapshot(),
        damageStatistics: session.damageStatisticHolder.snapshot(),
        search: rawDriver
            ? {
                  circuitOpen: rawDriver.circuitOpen,
                  decisionDeadlineMs: rawDriver.decisionDeadlineMs,
                  circuitBreakerMs: rawDriver.circuitBreakerMs,
                  pureRangedTerminalState: rawDriver.pureRangedTerminalState,
              }
            : null,
    };
}

function captureSemanticState(
    session: ISessionInternals,
    rawDriver: UnknownRecord | undefined,
    snapshotBattle: (unitsHolder: unknown, grid: unknown, fightProperties: unknown) => UnknownRecord,
): { engine: JsonValue; full: JsonValue; engineSha256: string; fullSha256: string } {
    const engine = sanitizeSemantic(
        battleSnapshotPayload(snapshotBattle(session.unitsHolder, session.grid, session.fightProperties)),
    );
    const full = sanitizeSemantic({ engine, server: serverSemanticProjection(session, rawDriver) });
    return {
        engine,
        full,
        engineSha256: sha256Text(JSON.stringify(engine)),
        fullSha256: sha256Text(JSON.stringify(full)),
    };
}

function captureRestorableState(
    session: ISessionInternals,
    rawDriver: UnknownRecord | undefined,
    snapshotBattle: (unitsHolder: unknown, grid: unknown, fightProperties: unknown) => UnknownRecord,
    deterministicRandomDraws: number,
): { state: JsonValue; sha256: string } {
    const commonEngine = sanitizeSemantic(
        battleSnapshotPayload(snapshotBattle(session.unitsHolder, session.grid, session.fightProperties)),
    );
    const state = sanitizeSemantic({
        commonEngine,
        damageStatistics: session.damageStatisticHolder.snapshot(),
        currentActiveUnitId: session.currentActiveUnitId,
        deterministicRandomDraws,
        wrapperRestoredServerState: {
            unitMetadata: session.unitMetadata,
            sceneLog: session.sceneLog.snapshot(),
        },
        searchStableState: rawDriver
            ? {
                  rolloutEnemyTeam: rawDriver.rolloutEnemyTeam,
                  finishPressureState: rawDriver.finishPressureState,
                  pureRangedTerminalState: rawDriver.pureRangedTerminalState,
                  finishedSim: rawDriver.finishedSim,
              }
            : null,
    });
    return { state, sha256: sha256Text(JSON.stringify(state)) };
}

function normalizedJournal(journal: unknown[]): JsonValue {
    return sanitizeSemantic(
        journal.map((raw) => {
            const entry = raw as UnknownRecord;
            const parse = (value: unknown): unknown => {
                if (typeof value !== "string") return value;
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            };
            return {
                sequence: entry.sequence,
                playerId: entry.playerId,
                team: entry.team,
                actionType: entry.actionType,
                action: parse(entry.actionJson),
                events: parse(entry.eventsJson),
            };
        }),
    );
}

function chosenDecisionTrace(decisions: IInnerDecisionTrace[]): JsonValue {
    return canonicalize(
        decisions.map((decision) => ({
            ordinal: decision.ordinal,
            unitId: decision.unitId,
            unitName: decision.unitName,
            lap: decision.lap,
            incumbent: decision.incumbent,
            chosen: decision.chosen,
            overridden: decision.overridden,
        })),
    );
}

function counterDeltaTrace(decisions: IInnerDecisionTrace[]): JsonValue {
    return canonicalize(
        decisions.map((decision) => ({
            ordinal: decision.ordinal,
            circuitBefore: decision.circuitBefore,
            circuitAfter: decision.circuitAfter,
            delta: semanticCounterDelta(decision.counterDelta),
        })),
    );
}

async function playOneMatch(
    scenario: IScenario,
    swapped: boolean,
    cli: ICli,
    modules: {
        common: UnknownRecord;
        randomLib: UnknownRecord;
        army: UnknownRecord;
        battleSnapshot: UnknownRecord;
        playSession: UnknownRecord;
        aiSeat: UnknownRecord;
        botSearch: UnknownRecord;
        creatureLookup: UnknownRecord;
    },
): Promise<IMatchRecord> {
    const key = `${scenario.scenarioIndex}:${scenario.seed}:${swapped ? "swap" : "native"}`;
    const logs: string[] = [];
    const originalConsole = { log: console.log, warn: console.warn, error: console.error };
    const formatLog = (level: string, args: unknown[]): string =>
        `${level} ${args
            .map((value) =>
                value instanceof Error
                    ? (value.stack ?? value.message)
                    : typeof value === "string"
                      ? value
                      : JSON.stringify(canonicalize(value)),
            )
            .join(" ")}`;
    console.log = (...args: unknown[]) => logs.push(formatLog("INFO", args));
    console.warn = (...args: unknown[]) => logs.push(formatLog("WARN", args));
    console.error = (...args: unknown[]) => logs.push(formatLog("ERROR", args));

    const setDeterministicRandomSource = modules.randomLib.setDeterministicRandomSource as (
        source: (() => number) | undefined,
    ) => void;
    const makeRng = modules.army.makeRng as (seed: number) => () => number;
    const hashParts = modules.army.hashSimulationParts as (...parts: Array<string | number | boolean>) => number;
    const snapshotBattle = modules.battleSnapshot.snapshotBattle as (
        unitsHolder: unknown,
        grid: unknown,
        fightProperties: unknown,
    ) => UnknownRecord;
    const PlaySessionManager = modules.playSession.PlaySessionManager as new (options: UnknownRecord) => UnknownRecord;
    const createAiSeatPlayerId = modules.aiSeat.createAiSeatPlayerId as (version: string, seat: string) => string;
    const createBotSearchDriver = modules.botSearch.createBotSearchDriver as (
        deps: unknown,
        match: unknown,
        version: string,
    ) => UnknownRecord;
    const amountForCreatureExperienceBudget = modules.creatureLookup.amountForCreatureExperienceBudget as (
        creatureId: number,
        budget: number,
        fallback: number,
    ) => number;
    const perk = modules.common.Perk as UnknownRecord;

    const innerDecisions: IInnerDecisionTrace[] = [];
    const outerDecisions: IOuterDecisionTrace[] = [];
    const stateTrace: IStateTrace[] = [];
    const driverCreationMs: number[] = [];
    const uncappedJournal: unknown[] = [];
    const uncappedEvents: unknown[] = [];
    const seenJournalSequences = new Set<number>();
    const seenEventSequences = new Set<number>();
    let rawDriver: UnknownRecord | undefined;
    let session: ISessionInternals;
    let observedDriverConfiguration: { decisionDeadlineMs: number; circuitBreakerMs: number } | undefined;
    let deterministicRandomDraws = 0;
    let driverCreations = 0;
    let innerOrdinal = 0;
    let outerOrdinal = 0;

    const factory = (deps: unknown, match: unknown, version: string): UnknownRecord => {
        const started = performance.now();
        const created = createBotSearchDriver(deps, match, version);
        driverCreationMs.push(performance.now() - started);
        driverCreations += 1;
        rawDriver = created;
        const observed = {
            decisionDeadlineMs: Number(created.decisionDeadlineMs),
            circuitBreakerMs: Number(created.circuitBreakerMs),
        };
        if (
            observed.decisionDeadlineMs !== EXPECTED_INNER_DECISION_DEADLINE_MS ||
            observed.circuitBreakerMs !== EXPECTED_INNER_CIRCUIT_MS
        ) {
            throw new Error(`unexpected imported SearchDriver limits ${JSON.stringify(observed)}`);
        }
        if (observedDriverConfiguration) {
            assertExactJson("per-match SearchDriver configuration", observed, observedDriverConfiguration);
        } else {
            observedDriverConfiguration = observed;
        }
        return {
            chooseDecision(unit: UnknownRecord, strategyVersion: string, incumbent: unknown): unknown {
                const before = counterSnapshot(created);
                const circuitBefore = created.circuitOpen === true;
                const startedAt = performance.now();
                const chosen = (created.chooseDecision as (...args: unknown[]) => unknown)(
                    unit,
                    strategyVersion,
                    incumbent,
                );
                const elapsedMs = performance.now() - startedAt;
                const after = counterSnapshot(created);
                innerDecisions.push({
                    ordinal: innerOrdinal++,
                    elapsedMs,
                    unitId: String((unit.getId as () => string)()),
                    unitName: String((unit.getName as () => string)()),
                    lap: Number((session.fightProperties.getCurrentLap as () => number)()),
                    incumbent: actionSignature(incumbent),
                    chosen: actionSignature(chosen),
                    overridden: chosen !== incumbent,
                    circuitBefore,
                    circuitAfter: created.circuitOpen === true,
                    countersBefore: before,
                    countersAfter: after,
                    counterDelta: subtractCounters(after, before),
                });
                return chosen;
            },
            onFightReady(): void {
                (created.onFightReady as () => void)();
            },
            onMatchEnd(winner?: string, endReason?: string): void {
                (created.onMatchEnd as (winner?: string, endReason?: string) => void)(winner, endReason);
            },
        };
    };

    const now = { value: 1_000_000 + scenario.scenarioIndex * 100_000 + Number(swapped) * 50_000 };
    resetDeterministicUuids(`ranked-outer-300:${scenario.seed}:${swapped ? "swap" : "native"}`);
    const manager = new PlaySessionManager({
        nowMillis: () => now.value,
        aiTakeoverMs: 0,
        persistJournal: false,
        startTimers: false,
        writeGameResult: () => Promise.resolve(true),
        rankedResultRecorder: () => Promise.resolve(),
        botSearchDriverFactory: factory,
    }) as UnknownRecord;
    const managerSessions = manager.sessions as Map<string, ISessionInternals>;
    const lowerRoster = swapped ? scenario.rosterB : scenario.rosterA;
    const upperRoster = swapped ? scenario.rosterA : scenario.rosterB;
    const lowerArtifacts = swapped ? scenario.artifactsB : scenario.artifactsA;
    const upperArtifacts = swapped ? scenario.artifactsA : scenario.artifactsB;
    const gameId = `outer300-${scenario.seed.toString(16)}-${swapped ? "s" : "n"}`;

    const matchRandom = makeRng(hashParts("ranked-outer-300-match", scenario.seed, swapped));
    setDeterministicRandomSource(() => {
        deterministicRandomDraws += 1;
        return matchRandom();
    });
    let ticks = 0;
    try {
        const created = (manager.createGame as (request: UnknownRecord) => UnknownRecord)({
            gameId,
            lowerPlayerId: createAiSeatPlayerId("v0.8", "outer-lower"),
            upperPlayerId: createAiSeatPlayerId("v0.8", "outer-upper"),
            lowerCreatureIds: lowerRoster,
            upperCreatureIds: upperRoster,
            lowerKnownOpponentCreatureIds: [],
            upperKnownOpponentCreatureIds: [],
            gridType: scenario.gridType,
            unitAmount: 7,
            unitAmountForCreature: (creatureId: number) => amountForCreatureExperienceBudget(creatureId, 1_000, 7),
            placementSeconds: 5,
            setupSeconds: 5,
            lowerArtifactTier1: lowerArtifacts.tier1,
            lowerArtifactTier2: lowerArtifacts.tier2,
            upperArtifactTier1: upperArtifacts.tier1,
            upperArtifactTier2: upperArtifacts.tier2,
            lowerPerk: perk.SEE_NONE,
            upperPerk: perk.SEE_NONE,
            lowerPersistentAi: true,
            upperPersistentAi: true,
        });
        const createdGameId = String(created.gameId);
        session = managerSessions.get(createdGameId)!;
        if (!session) throw new Error(`PlaySession ${createdGameId} was not created`);

        const drainRetainedReplay = (): void => {
            for (const raw of session.journal) {
                const sequence = Number((raw as UnknownRecord).sequence);
                if (!Number.isSafeInteger(sequence) || seenJournalSequences.has(sequence)) continue;
                seenJournalSequences.add(sequence);
                uncappedJournal.push(canonicalize(raw));
            }
            for (const raw of session.events) {
                const sequence = Number((raw as UnknownRecord).sequence);
                if (!Number.isSafeInteger(sequence) || seenEventSequences.has(sequence)) continue;
                seenEventSequences.add(sequence);
                uncappedEvents.push(canonicalize(raw));
            }
        };
        drainRetainedReplay();

        const originalSearchBotDecision = session.searchBotDecision.bind(session);
        session.searchBotDecision = (...args: unknown[]): unknown => {
            const unit = args[0] as UnknownRecord;
            const incumbent = args[2];
            const before = captureRestorableState(session, rawDriver, snapshotBattle, deterministicRandomDraws);
            const outerCircuitBefore = session.botSearchCircuitOpen;
            const dateStarted = Date.now();
            const perfStarted = performance.now();
            const chosen = originalSearchBotDecision(...args);
            const wrapperElapsedPerformanceMs = performance.now() - perfStarted;
            const wrapperElapsedDateMs = Date.now() - dateStarted;
            const after = captureRestorableState(session, rawDriver, snapshotBattle, deterministicRandomDraws);
            outerDecisions.push({
                ordinal: outerOrdinal++,
                wrapperElapsedPerformanceMs,
                wrapperElapsedDateMs,
                unitId: String((unit.getId as () => string)()),
                unitName: String((unit.getName as () => string)()),
                lap: Number((session.fightProperties.getCurrentLap as () => number)()),
                incumbent: actionSignature(incumbent),
                chosen: actionSignature(chosen),
                overridden: chosen !== incumbent,
                outerCircuitBefore,
                outerCircuitAfter: session.botSearchCircuitOpen,
                crossedOuterCircuit: !outerCircuitBefore && session.botSearchCircuitOpen,
                restorableStateBeforeSha256: before.sha256,
                restorableStateAfterSha256: after.sha256,
                restorableStateRestored: before.sha256 === after.sha256,
                ...(cli.fullStates ? { restorableStateBefore: before.state, restorableStateAfter: after.state } : {}),
            });
            return chosen;
        };

        const originalPublishAccepted = session.publishAccepted.bind(session);
        session.publishAccepted = (...args: unknown[]): unknown => {
            const published = originalPublishAccepted(...args);
            drainRetainedReplay();
            if ((session.fightProperties.hasFightStarted as () => boolean)()) {
                const state = captureSemanticState(session, rawDriver, snapshotBattle);
                const journalEntry = session.journal.at(-1) as UnknownRecord | undefined;
                stateTrace.push({
                    sequence: Number(journalEntry?.sequence ?? session.latestSequence),
                    lap: Number((session.fightProperties.getCurrentLap as () => number)()),
                    actionType: Number(journalEntry?.actionType ?? 0),
                    engineSha256: state.engineSha256,
                    fullSha256: state.fullSha256,
                    ...(cli.fullStates ? { fullState: state.full } : {}),
                });
            }
            return published;
        };

        for (; ticks < cli.maxTicks; ticks += 1) {
            const snapshot = session.getSnapshot({ fullJournal: true });
            if (snapshot.fightFinished === true || snapshot.phase === 3) break;
            if (snapshot.fightStarted !== true) {
                now.value = Math.max(now.value + 1, Number(snapshot.placementDeadlineMs ?? now.value) + 1);
            } else {
                now.value += 1;
            }
            (manager.tick as () => void)();
            drainRetainedReplay();
        }

        drainRetainedReplay();
        const replay = session.getReplay({}) as UnknownRecord;
        const finalSnapshot = session.getSnapshot({ fullJournal: true }) as UnknownRecord;
        const finalState = captureSemanticState(session, rawDriver, snapshotBattle);
        const journal = normalizedJournal(uncappedJournal);
        const events = sanitizeSemantic(uncappedEvents);
        const eventSequences = uncappedEvents.map((event) => Number((event as UnknownRecord).sequence));
        const journalSequences = uncappedJournal.map((entry) => Number((entry as UnknownRecord).sequence));
        const completeReplay =
            eventSequences.length === session.latestSequence &&
            eventSequences.every((sequence, index) => sequence === index + 1) &&
            journalSequences.every((sequence) => seenEventSequences.has(sequence));
        const fightStartJournalIndex = uncappedJournal.findIndex((entry) => {
            const eventsJson = (entry as UnknownRecord).eventsJson;
            if (typeof eventsJson !== "string") return false;
            try {
                const parsed = JSON.parse(eventsJson) as unknown;
                return (
                    Array.isArray(parsed) && parsed.some((event) => (event as UnknownRecord).type === "fight_started")
                );
            } catch {
                return false;
            }
        });
        const fightJournalSequences =
            fightStartJournalIndex < 0
                ? []
                : uncappedJournal
                      .slice(fightStartJournalIndex)
                      .map((entry) => Number((entry as UnknownRecord).sequence));
        const stateTraceCaptureComplete =
            fightStartJournalIndex >= 0 &&
            stateTrace.length === fightJournalSequences.length &&
            stateTrace.every((entry, index) => entry.sequence === fightJournalSequences[index]);
        const productionReplayComplete = replay.completeReplay === true;
        const captureComplete = completeReplay && productionReplayComplete && stateTraceCaptureComplete;
        const stateTraceSemantic = stateTrace.map(({ fullState: _fullState, ...entry }) => entry);
        const semanticPayload = {
            journal,
            events,
            stateTrace: stateTraceSemantic,
            finalStateSha256: finalState.fullSha256,
            finalSnapshot: sanitizeSemantic(finalSnapshot),
        };
        const proposalRejects = logs.filter((line) => line.includes("proposal declined")).length;
        const serverErrors = logs.filter((line) => line.startsWith("ERROR ")).length;
        const outerCircuitWarningCount = logs.filter((line) => line.includes("opening the per-match circuit")).length;
        if (!observedDriverConfiguration) throw new Error("ranked match did not construct a SearchDriver");
        const chosenTrace = chosenDecisionTrace(innerDecisions);
        const counterTrace = counterDeltaTrace(innerDecisions);
        return {
            key,
            scenarioIndex: scenario.scenarioIndex,
            seed: scenario.seed,
            swapped,
            gridType: scenario.gridType,
            lowerRoster,
            upperRoster,
            lowerArtifacts,
            upperArtifacts,
            finished: finalSnapshot.fightFinished === true || finalSnapshot.phase === 3,
            ticks,
            completeReplay,
            productionReplayComplete,
            captureComplete,
            stateTraceCaptureComplete,
            currentLap: Number(finalSnapshot.currentLap ?? 0),
            journalEntries: uncappedJournal.length,
            eventEntries: uncappedEvents.length,
            retainedJournalEntries: session.journal.length,
            retainedEventEntries: session.events.length,
            proposalRejects,
            serverErrors,
            driverCreations,
            driverCreationMs,
            observedDriverConfiguration,
            innerDecisions,
            outerDecisions,
            innerCountersFinal: counterSnapshot(rawDriver),
            innerCircuitOpened: rawDriver?.circuitOpen === true,
            outerCircuitOpened: session.botSearchCircuitOpen,
            outerCircuitWarningCount,
            chosenDecisionTraceSha256: digestJson(chosenTrace),
            counterDeltaTraceSha256: digestJson(counterTrace),
            semanticDigestSha256: digestJson(semanticPayload),
            journalDigestSha256: digestJson(journal),
            eventDigestSha256: digestJson(events),
            stateTraceDigestSha256: digestJson(stateTraceSemantic),
            finalStateSha256: finalState.fullSha256,
            stateTrace,
            journal,
            events,
            finalSnapshot: sanitizeSemantic(finalSnapshot),
            logs,
        };
    } finally {
        (manager.stop as () => void)();
        setDeterministicRandomSource(undefined);
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
    }
}

async function workerMain(cli: ICli): Promise<void> {
    const commonRoot = cli.commonRoot!;
    installCommonAlias(commonRoot);
    installDeterministicUuids();
    Bun.env.HOC_BOT_SEARCH = "1";
    Bun.env.HOC_JOURNAL_FULL = "1";

    const common = await dynamicModule(commonRoot, "src/index.ts");
    const randomLib = await dynamicModule(commonRoot, "src/utils/lib.ts");
    const army = await dynamicModule(commonRoot, "src/simulation/army.ts");
    const battleSnapshot = await dynamicModule(commonRoot, "src/simulation/battle_snapshot.ts");
    const creatureGen = await dynamicModule(commonRoot, "src/generated/protobuf/v1/creature_gen.ts");
    const playSession = await dynamicModule(cli.serverRoot, "src/api/game/v1/play_session.ts");
    const aiSeat = await dynamicModule(cli.serverRoot, "src/api/game/v1/ai_seat.ts");
    const botSearch = await dynamicModule(cli.serverRoot, "src/api/game/v1/bot_search.ts");
    const creatureLookup = await dynamicModule(cli.serverRoot, "src/simulation/creature_lookup.ts");
    const importedOuterCircuitMs = Number(botSearch.BOT_SEARCH_CIRCUIT_BREAKER_MS);
    if (importedOuterCircuitMs !== EXPECTED_OUTER_CIRCUIT_MS) {
        throw new Error(
            `imported BOT_SEARCH_CIRCUIT_BREAKER_MS=${importedOuterCircuitMs}, expected ${EXPECTED_OUTER_CIRCUIT_MS}`,
        );
    }

    const scenarioPlan = buildScenarioPlan(cli.scenarioCount, cli.baseSeed, common, army, creatureGen);
    const matches: IMatchRecord[] = [];
    for (const scenario of scenarioPlan) {
        matches.push(
            await playOneMatch(scenario, false, cli, {
                common,
                randomLib,
                army,
                battleSnapshot,
                playSession,
                aiSeat,
                botSearch,
                creatureLookup,
            }),
        );
        if (cli.sideSwaps) {
            matches.push(
                await playOneMatch(scenario, true, cli, {
                    common,
                    randomLib,
                    army,
                    battleSnapshot,
                    playSession,
                    aiSeat,
                    botSearch,
                    creatureLookup,
                }),
            );
        }
    }

    const attackHandler = join(commonRoot, "src/handlers/attack_handler.ts");
    const rayTraversal = join(commonRoot, "src/grid/ray_traversal.ts");
    const rayFile = Bun.file(rayTraversal);
    const observedConfigurations = matches.map((match) => match.observedDriverConfiguration);
    for (const observed of observedConfigurations) {
        assertExactJson("cross-match SearchDriver configuration", observed, observedConfigurations[0]);
    }
    const result: IVariantResult = {
        schema: SCHEMA,
        variant: cli.variant!,
        commonRoot,
        serverRoot: cli.serverRoot,
        scenarioPlan,
        matches,
        source: {
            commonBaseSha: cli.commonBaseSha,
            serverSha: cli.serverSha,
            attackHandlerSha256: await sha256File(attackHandler),
            rayTraversalSha256: (await rayFile.exists()) ? await sha256File(rayTraversal) : null,
            playSessionSha256: await sha256File(join(cli.serverRoot, "src/api/game/v1/play_session.ts")),
            botSearchSha256: await sha256File(join(cli.serverRoot, "src/api/game/v1/bot_search.ts")),
        },
        runtime: {
            bun: Bun.version,
            platform: process.platform,
            arch: process.arch,
            importedOuterCircuitMs,
            observedInnerDecisionDeadlineMs: observedConfigurations[0].decisionDeadlineMs,
            observedInnerCircuitBreakerMs: observedConfigurations[0].circuitBreakerMs,
            deterministicRandom: true,
        },
    };
    const output = cli.workerOutput ?? cli.output;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}

function childEnvironment(): Record<string, string> {
    const keep = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL"] as const;
    const environment: Record<string, string> = {};
    for (const key of keep) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
    }
    environment.NODE_ENV = "production";
    environment.TZ = "UTC";
    environment.LANG = "C";
    environment.LC_ALL = "C";
    environment.HOC_BOT_SEARCH = "1";
    environment.HOC_JOURNAL_FULL = "1";
    return environment;
}

async function runWorkerProcess(
    cli: ICli,
    variant: "baseline" | "candidate",
    commonRoot: string,
    workerOutput: string,
): Promise<{ result: IVariantResult; stdout: string; stderr: string }> {
    const args = [
        SCRIPT_PATH,
        "--worker",
        "1",
        "--variant",
        variant,
        "--common-root",
        commonRoot,
        "--server-root",
        cli.serverRoot,
        "--server-sha",
        cli.serverSha,
        "--common-base-sha",
        cli.commonBaseSha,
        "--scenario-count",
        String(cli.scenarioCount),
        "--base-seed",
        String(cli.baseSeed),
        "--side-swaps",
        cli.sideSwaps ? "1" : "0",
        "--full-states",
        cli.fullStates ? "1" : "0",
        "--max-ticks",
        String(cli.maxTicks),
        "--worker-out",
        workerOutput,
    ];
    const child = Bun.spawn([process.execPath, ...args], {
        cwd: dirname(SCRIPT_PATH),
        env: childEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(`${variant} worker exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    return { result: JSON.parse(await readFile(workerOutput, "utf8")) as IVariantResult, stdout, stderr };
}

function summarizeVariant(result: IVariantResult): UnknownRecord {
    const matches = result.matches;
    const inner = matches.flatMap((match) => match.innerDecisions);
    const outer = matches.flatMap((match) => match.outerDecisions);
    const percentile = (values: number[], quantile: number): number | null => {
        if (!values.length) return null;
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.ceil(quantile * sorted.length) - 1];
    };
    const timings = (
        records: Array<{ elapsedMs?: number; wrapperElapsedPerformanceMs?: number }>,
        key: "elapsedMs" | "wrapperElapsedPerformanceMs",
    ) => {
        const values = records.map((record) => Number(record[key as keyof typeof record]));
        return {
            count: values.length,
            p50: percentile(values, 0.5),
            p95: percentile(values, 0.95),
            p99: percentile(values, 0.99),
            max: values.length ? Math.max(...values) : null,
        };
    };
    return {
        matches: matches.length,
        completed: matches.filter((match) => match.finished).length,
        completeReplays: matches.filter((match) => match.completeReplay).length,
        productionCompleteReplays: matches.filter((match) => match.productionReplayComplete).length,
        completeCaptures: matches.filter((match) => match.captureComplete).length,
        journalEntries: matches.reduce((sum, match) => sum + match.journalEntries, 0),
        eventEntries: matches.reduce((sum, match) => sum + match.eventEntries, 0),
        decisionCalls: matches.reduce((sum, match) => sum + match.innerCountersFinal.decisions, 0),
        searchedDecisions: matches.reduce((sum, match) => sum + match.innerCountersFinal.searched, 0),
        singleCandidateDecisions: matches.reduce((sum, match) => sum + match.innerCountersFinal.singleCandidate, 0),
        illegalIncumbentDecisions: matches.reduce((sum, match) => sum + match.innerCountersFinal.illegalIncumbent, 0),
        overrides: matches.reduce((sum, match) => sum + match.innerCountersFinal.overrides, 0),
        driverCreations: matches.reduce((sum, match) => sum + match.driverCreations, 0),
        proposalRejects: matches.reduce((sum, match) => sum + match.proposalRejects, 0),
        serverErrors: matches.reduce((sum, match) => sum + match.serverErrors, 0),
        innerDeadlineFallbacks: matches.reduce((sum, match) => sum + match.innerCountersFinal.deadlineFallbacks, 0),
        innerCircuitSkipped: matches.reduce((sum, match) => sum + match.innerCountersFinal.circuitSkipped, 0),
        innerCircuitOpenedMatches: matches.filter((match) => match.innerCircuitOpened).length,
        outerCircuitOpenedMatches: matches.filter((match) => match.outerCircuitOpened).length,
        outerCircuitWarnings: matches.reduce((sum, match) => sum + match.outerCircuitWarningCount, 0),
        unrestoredOuterDecisions: outer.filter((decision) => !decision.restorableStateRestored).length,
        innerChooseDecisionLatencyMs: timings(inner, "elapsedMs"),
        outerWrapperLatencyMs: timings(outer, "wrapperElapsedPerformanceMs"),
    };
}

function firstChosenDecisionDifferenceOrdinal(baseline: IMatchRecord, candidate: IMatchRecord): number | null {
    const count = Math.max(baseline.innerDecisions.length, candidate.innerDecisions.length);
    for (let index = 0; index < count; index += 1) {
        const project = (decision: IInnerDecisionTrace | undefined): JsonValue =>
            decision
                ? canonicalize({
                      unitId: decision.unitId,
                      unitName: decision.unitName,
                      lap: decision.lap,
                      incumbent: decision.incumbent,
                      chosen: decision.chosen,
                      overridden: decision.overridden,
                  })
                : null;
        if (
            digestJson(project(baseline.innerDecisions[index])) !== digestJson(project(candidate.innerDecisions[index]))
        ) {
            return index;
        }
    }
    return null;
}

function firstCounterDeltaDifferenceOrdinal(baseline: IMatchRecord, candidate: IMatchRecord): number | null {
    const count = Math.max(baseline.innerDecisions.length, candidate.innerDecisions.length);
    for (let index = 0; index < count; index += 1) {
        const project = (decision: IInnerDecisionTrace | undefined): JsonValue =>
            decision
                ? canonicalize({
                      circuitBefore: decision.circuitBefore,
                      circuitAfter: decision.circuitAfter,
                      delta: semanticCounterDelta(decision.counterDelta),
                  })
                : null;
        if (
            digestJson(project(baseline.innerDecisions[index])) !== digestJson(project(candidate.innerDecisions[index]))
        ) {
            return index;
        }
    }
    return null;
}

function innerOuterDecisionTraceExact(match: IMatchRecord): boolean {
    if (match.innerDecisions.length !== match.outerDecisions.length) return false;
    return match.innerDecisions.every((inner, index) => {
        const outer = match.outerDecisions[index];
        return (
            inner.ordinal === outer.ordinal &&
            inner.unitId === outer.unitId &&
            inner.unitName === outer.unitName &&
            inner.lap === outer.lap &&
            digestJson(inner.incumbent) === digestJson(outer.incumbent) &&
            digestJson(inner.chosen) === digestJson(outer.chosen) &&
            inner.overridden === outer.overridden
        );
    });
}

async function coordinatorMain(cli: ICli): Promise<void> {
    const sourceIntegrityPreflight = await verifyFrozenInputs(cli);
    const sourceIntegrityPreflightSha256 = digestJson(sourceIntegrityPreflight);
    const scratchBase = join(
        process.env.TMPDIR ?? "/tmp",
        `hoc-ranked-outer-300-${process.pid}-${Date.now().toString(36)}`,
    );
    await mkdir(scratchBase, { recursive: true });
    const baselinePath = join(scratchBase, "baseline.json");
    const candidatePath = join(scratchBase, "candidate.json");
    const baseline = await runWorkerProcess(cli, "baseline", cli.baselineRoot!, baselinePath);
    const candidate = await runWorkerProcess(cli, "candidate", cli.candidateRoot!, candidatePath);
    const sourceIntegrityPostflight = await verifyFrozenInputs(cli);
    const sourceIntegrityPostflightSha256 = digestJson(sourceIntegrityPostflight);
    if (sourceIntegrityPostflightSha256 !== sourceIntegrityPreflightSha256) {
        throw new Error(
            `source/dependency inputs changed during run: ${sourceIntegrityPreflightSha256} -> ${sourceIntegrityPostflightSha256}`,
        );
    }
    assertExactJson(
        "baseline/candidate imported runtime configuration",
        baseline.result.runtime,
        candidate.result.runtime,
    );
    const baselineByKey = new Map(baseline.result.matches.map((match) => [match.key, match]));
    const comparisons = candidate.result.matches.map((candidateMatch) => {
        const baselineMatch = baselineByKey.get(candidateMatch.key);
        if (!baselineMatch) throw new Error(`candidate produced unexpected match ${candidateMatch.key}`);
        const baselineDeadlineFallbacks = baselineMatch.innerCountersFinal.deadlineFallbacks;
        const candidateDeadlineFallbacks = candidateMatch.innerCountersFinal.deadlineFallbacks;
        const baselineInnerCircuitSkipped = baselineMatch.innerCountersFinal.circuitSkipped;
        const candidateInnerCircuitSkipped = candidateMatch.innerCountersFinal.circuitSkipped;
        const firstChosenDecisionDifference = firstChosenDecisionDifferenceOrdinal(baselineMatch, candidateMatch);
        const firstCounterDeltaDifference = firstCounterDeltaDifferenceOrdinal(baselineMatch, candidateMatch);
        const semanticExact = baselineMatch.semanticDigestSha256 === candidateMatch.semanticDigestSha256;
        const classification = semanticExact
            ? "exact"
            : baselineMatch.outerCircuitOpened !== candidateMatch.outerCircuitOpened
              ? "outer_circuit_divergence"
              : baselineMatch.innerCircuitOpened !== candidateMatch.innerCircuitOpened ||
                  baselineDeadlineFallbacks !== candidateDeadlineFallbacks ||
                  baselineInnerCircuitSkipped !== candidateInnerCircuitSkipped
                ? "inner_deadline_or_circuit_divergence"
                : baselineMatch.serverErrors !== candidateMatch.serverErrors ||
                    baselineMatch.proposalRejects !== candidateMatch.proposalRejects
                  ? "server_error_or_rejection_divergence"
                  : firstChosenDecisionDifference !== null || firstCounterDeltaDifference !== null
                    ? "bounded_search_decision_divergence"
                    : "authoritative_semantic_divergence";
        return {
            key: candidateMatch.key,
            classification,
            firstChosenDecisionDifferenceOrdinal: firstChosenDecisionDifference,
            firstCounterDeltaDifferenceOrdinal: firstCounterDeltaDifference,
            completed: baselineMatch.finished && candidateMatch.finished,
            completeReplay: baselineMatch.completeReplay && candidateMatch.completeReplay,
            productionReplayComplete: baselineMatch.productionReplayComplete && candidateMatch.productionReplayComplete,
            captureComplete: baselineMatch.captureComplete && candidateMatch.captureComplete,
            semanticExact,
            chosenDecisionTraceExact:
                baselineMatch.chosenDecisionTraceSha256 === candidateMatch.chosenDecisionTraceSha256,
            counterDeltaTraceExact: baselineMatch.counterDeltaTraceSha256 === candidateMatch.counterDeltaTraceSha256,
            journalExact: baselineMatch.journalDigestSha256 === candidateMatch.journalDigestSha256,
            eventsExact: baselineMatch.eventDigestSha256 === candidateMatch.eventDigestSha256,
            stateTraceExact: baselineMatch.stateTraceDigestSha256 === candidateMatch.stateTraceDigestSha256,
            finalStateExact: baselineMatch.finalStateSha256 === candidateMatch.finalStateSha256,
            baselineOuterCircuitOpened: baselineMatch.outerCircuitOpened,
            candidateOuterCircuitOpened: candidateMatch.outerCircuitOpened,
            baselineInnerCircuitOpened: baselineMatch.innerCircuitOpened,
            candidateInnerCircuitOpened: candidateMatch.innerCircuitOpened,
            baselineOuterCircuitWarnings: baselineMatch.outerCircuitWarningCount,
            candidateOuterCircuitWarnings: candidateMatch.outerCircuitWarningCount,
            baselineDriverCreations: baselineMatch.driverCreations,
            candidateDriverCreations: candidateMatch.driverCreations,
            baselineInnerDecisionCalls: baselineMatch.innerDecisions.length,
            candidateInnerDecisionCalls: candidateMatch.innerDecisions.length,
            baselineCounterDecisionCalls: baselineMatch.innerCountersFinal.decisions,
            candidateCounterDecisionCalls: candidateMatch.innerCountersFinal.decisions,
            baselineOuterDecisionCalls: baselineMatch.outerDecisions.length,
            candidateOuterDecisionCalls: candidateMatch.outerDecisions.length,
            baselineInnerOuterTraceExact: innerOuterDecisionTraceExact(baselineMatch),
            candidateInnerOuterTraceExact: innerOuterDecisionTraceExact(candidateMatch),
            baselineSearchedDecisions: baselineMatch.innerCountersFinal.searched,
            candidateSearchedDecisions: candidateMatch.innerCountersFinal.searched,
            baselineSingleCandidateDecisions: baselineMatch.innerCountersFinal.singleCandidate,
            candidateSingleCandidateDecisions: candidateMatch.innerCountersFinal.singleCandidate,
            baselineIllegalIncumbentDecisions: baselineMatch.innerCountersFinal.illegalIncumbent,
            candidateIllegalIncumbentDecisions: candidateMatch.innerCountersFinal.illegalIncumbent,
            baselineDeadlineFallbacks,
            candidateDeadlineFallbacks,
            baselineInnerCircuitSkipped,
            candidateInnerCircuitSkipped,
            baselineProposalRejects: baselineMatch.proposalRejects,
            candidateProposalRejects: candidateMatch.proposalRejects,
            baselineServerErrors: baselineMatch.serverErrors,
            candidateServerErrors: candidateMatch.serverErrors,
            baselineUnrestoredOuterDecisions: baselineMatch.outerDecisions.filter(
                (decision) => !decision.restorableStateRestored,
            ).length,
            candidateUnrestoredOuterDecisions: candidateMatch.outerDecisions.filter(
                (decision) => !decision.restorableStateRestored,
            ).length,
            baselineSemanticDigestSha256: baselineMatch.semanticDigestSha256,
            candidateSemanticDigestSha256: candidateMatch.semanticDigestSha256,
            baselineChosenDecisionTraceSha256: baselineMatch.chosenDecisionTraceSha256,
            candidateChosenDecisionTraceSha256: candidateMatch.chosenDecisionTraceSha256,
            baselineCounterDeltaTraceSha256: baselineMatch.counterDeltaTraceSha256,
            candidateCounterDeltaTraceSha256: candidateMatch.counterDeltaTraceSha256,
        };
    });
    const pass =
        comparisons.length === baseline.result.matches.length &&
        comparisons.every(
            (comparison) =>
                comparison.completed &&
                comparison.completeReplay &&
                comparison.productionReplayComplete &&
                comparison.captureComplete &&
                comparison.semanticExact &&
                comparison.firstChosenDecisionDifferenceOrdinal === null &&
                comparison.firstCounterDeltaDifferenceOrdinal === null &&
                comparison.chosenDecisionTraceExact &&
                comparison.counterDeltaTraceExact &&
                comparison.journalExact &&
                comparison.eventsExact &&
                comparison.stateTraceExact &&
                comparison.finalStateExact &&
                comparison.baselineProposalRejects === 0 &&
                comparison.candidateProposalRejects === 0 &&
                comparison.baselineServerErrors === 0 &&
                comparison.candidateServerErrors === 0 &&
                comparison.baselineDeadlineFallbacks === 0 &&
                comparison.candidateDeadlineFallbacks === 0 &&
                comparison.baselineInnerCircuitSkipped === 0 &&
                comparison.candidateInnerCircuitSkipped === 0 &&
                comparison.baselineDriverCreations === 1 &&
                comparison.candidateDriverCreations === 1 &&
                comparison.baselineInnerDecisionCalls === comparison.baselineOuterDecisionCalls &&
                comparison.candidateInnerDecisionCalls === comparison.candidateOuterDecisionCalls &&
                comparison.baselineInnerDecisionCalls === comparison.candidateInnerDecisionCalls &&
                comparison.baselineInnerDecisionCalls === comparison.baselineCounterDecisionCalls &&
                comparison.candidateInnerDecisionCalls === comparison.candidateCounterDecisionCalls &&
                comparison.baselineInnerOuterTraceExact &&
                comparison.candidateInnerOuterTraceExact &&
                comparison.baselineInnerDecisionCalls ===
                    comparison.baselineSearchedDecisions + comparison.baselineSingleCandidateDecisions &&
                comparison.candidateInnerDecisionCalls ===
                    comparison.candidateSearchedDecisions + comparison.candidateSingleCandidateDecisions &&
                comparison.baselineIllegalIncumbentDecisions === comparison.candidateIllegalIncumbentDecisions &&
                !comparison.baselineInnerCircuitOpened &&
                !comparison.candidateInnerCircuitOpened &&
                !comparison.baselineOuterCircuitOpened &&
                !comparison.candidateOuterCircuitOpened &&
                comparison.baselineOuterCircuitWarnings === 0 &&
                comparison.candidateOuterCircuitWarnings === 0 &&
                comparison.baselineUnrestoredOuterDecisions === 0 &&
                comparison.candidateUnrestoredOuterDecisions === 0,
        );
    const result = {
        schema: SCHEMA,
        generatedAt: new Date().toISOString(),
        status: pass ? "pass" : "fail",
        interpretation:
            "Executes the unchanged ranked PlaySession outer 300 ms wrapper against immutable common A/B trees. " +
            "Semantic digests exclude UUID action ids, FightProperties.id, wall-clock fields, and timing counters, " +
            "but include uncapped ordered accepted actions, their full GameEvent payloads, the uncapped server event " +
            "stream, and scoped per-action semantic state hashes. wrapperElapsedPerformanceMs surrounds the entire " +
            "private method, including metadata snapshot/restore; the production 300 ms classification comes only " +
            "from the unchanged method's circuit flag and matching log evidence.",
        protocol: {
            commonBaseSha: cli.commonBaseSha,
            serverSha: cli.serverSha,
            outerCircuitMs: baseline.result.runtime.importedOuterCircuitMs,
            innerDecisionDeadlineMs: baseline.result.runtime.observedInnerDecisionDeadlineMs,
            innerCircuitBreakerMs: baseline.result.runtime.observedInnerCircuitBreakerMs,
            thresholdEvidence:
                "300 is read from imported server BOT_SEARCH_CIRCUIT_BREAKER_MS; 175/275 are read from every constructed common SearchDriver and asserted for every match",
            baseSeed: cli.baseSeed,
            scenarioCount: cli.scenarioCount,
            sideSwaps: cli.sideSwaps,
            matchesPerVariant: cli.scenarioCount * (cli.sideSwaps ? 2 : 1),
            maps: ["NORMAL", "LAVA_CENTER", "BLOCK_CENTER"],
            roster: "non-overlapping random 2xL1 + 2xL2 + 1xL3 + 1xL4; 1000xp stack sizing",
            setup: "SEE_NONE + unchanged ranked setup policy + deterministic random Tier-1/Tier-2 artifacts",
            bothSeats: "persistent v0.8 bots; HOC_BOT_SEARCH=1",
            deterministicRandom: true,
            deterministicCrypto:
                "per-match deterministic crypto.randomUUID + crypto.getRandomValues reset; identical paired gameplay randomness and unit/summon ids without production edits",
            replayCapture: "drain retained journal/events after creation, every publication, and every manager tick",
            outerTiming:
                "wrapperElapsedPerformanceMs includes server metadata snapshot and finally-restore; circuit flag/log is authoritative for the production Date.now >300ms breaker",
            restoreValidation: {
                included: [
                    "complete semantic snapshotBattle common engine state (units/order/grid/fight/holder/AI target memory)",
                    "damage statistic snapshot",
                    "current active unit",
                    "paired common deterministic-RNG draw cursor",
                    "SearchDriver stable rollout/finish-pressure/terminal/finishedSim state",
                    "server unitMetadata and sceneLog explicitly restored by the production wrapper",
                ],
                excluded: [
                    "SearchDriver counters and circuit flag, which intentionally mutate as observability/safety state",
                    "console output, which is append-only observability rather than restorable match state",
                    "external crypto RNG cursor, which production does not expose or restore",
                    "server session fields not read or mutated by searchBotDecision",
                ],
                scope: "This is the complete authoritative restorable common state exposed by snapshotBattle plus damage/search-stable state and the server metadata/log state the wrapper explicitly restores; it is not a byte-for-byte snapshot of the entire PlaySession object",
            },
            semanticClockExclusions: [
                "FightProperties.id",
                "FightProperties.currentTurnStart",
                "FightProperties.currentTurnEnd",
                "FightProperties.currentLapTotalTimePerTeam",
                "serverTimeMs/placementDeadlineMs/currentTurn*Ms/lastSeenMs/acceptedAtMs",
                "SearchDriver.counters.msTotal",
            ],
            fullStatesRetained: cli.fullStates,
            maxTicks: cli.maxTicks,
            scriptSha256: await sha256File(SCRIPT_PATH),
        },
        source: {
            baseline: baseline.result.source,
            candidate: candidate.result.source,
        },
        sourceIntegrity: {
            frozenExpected: EXPECTED_INPUTS,
            preflightSha256: sourceIntegrityPreflightSha256,
            postflightSha256: sourceIntegrityPostflightSha256,
            unchangedDuringRun: sourceIntegrityPreflightSha256 === sourceIntegrityPostflightSha256,
            preflight: sourceIntegrityPreflight,
            postflight: sourceIntegrityPostflight,
        },
        summary: {
            baseline: summarizeVariant(baseline.result),
            candidate: summarizeVariant(candidate.result),
            comparedMatches: comparisons.length,
            semanticExactMatches: comparisons.filter((comparison) => comparison.semanticExact).length,
        },
        comparisons,
        baseline: baseline.result,
        candidate: candidate.result,
        processLogs: {
            baselineStdout: baseline.stdout,
            baselineStderr: baseline.stderr,
            candidateStdout: candidate.stdout,
            candidateStderr: candidate.stderr,
        },
        scratch: {
            directory: scratchBase,
            baselineRaw: baselinePath,
            candidateRaw: candidatePath,
        },
    };
    await mkdir(dirname(cli.output), { recursive: true });
    await writeFile(cli.output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
        `${result.status.toUpperCase()}: ${comparisons.length} paired server matches; ` +
            `${result.summary.semanticExactMatches}/${comparisons.length} semantic exact -> ${cli.output}`,
    );
    if (!pass) process.exitCode = 1;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.mode === "worker") await workerMain(cli);
else await coordinatorMain(cli);
