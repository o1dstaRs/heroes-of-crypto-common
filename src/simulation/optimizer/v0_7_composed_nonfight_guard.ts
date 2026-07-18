/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 * Exact research-only guard for composing the final overnight draft and setup
 * candidates. Seed selection is frozen before the first fight and cannot bake.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, Worker } from "node:worker_threads";

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../../ai/setup/draft_ship";
import { parseConditionalRules } from "../../ai/setup/setup_conditional";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { PickTeam } from "../../picks/pick_sim";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "../battle_engine";
import { runRankedConditionalPickGame, type IConditionalArmy } from "../measure_setup_conditional";
import type { ILeagueGenome } from "../league_genome";
import {
    classifyRankedDraftCohorts,
    clusteredRankedDraftConfidence95,
    permuteRankedDraftSeed,
    rankedDraftBehaviorTraceSha256,
    rankedDraftBehaviorTraceSetSha256,
    RANKED_DRAFT_COHORT_DEFINITIONS,
    RANKED_DRAFT_CURRENT_INCUMBENT_ID,
    RANKED_DRAFT_LIVE_MAP_TYPES,
    type IRankedDraftEvaluationReport,
    type IRankedDraftGameRecord,
    type RankedDraftCohort,
} from "../ranked_draft_eval";
import {
    createRankedDraftCandidateGenome,
    evaluateRankedDraftGuard,
    evaluateRankedDraftTargetedGuard,
    fingerprintRankedDraftArtifact,
    type IRankedDraftTargetedCohortInput,
} from "./ranked_draft_cem_core";
import {
    fingerprintV07NonfightCampaign,
    type IV07NonfightCampaignProvenance,
    type IV07NonfightCampaignRenderedLane,
} from "./v0_7_nonfight_campaign_core";
import {
    assertAugmentPlan,
    cloneNonFightPolicy,
    compileNonFightSetupPolicy,
    pairedSetupEstimate,
    SETUP_COHORTS,
    SETUP_GUARD_THRESHOLDS,
    SETUP_LIVE_GRID_TYPES,
    SETUP_NAMED_GUARD_TAGS,
    shippedNonFightPolicy,
    setupGuardPromotable,
    SYNERGY_POLICY_VARIANTS,
    T2_POLICY_VARIANTS,
    V07_SETUP_BUDGET,
    V07_SETUP_OVERNIGHT_SCHEMA_VERSION,
    type ISetupEvaluatedPair,
    type INonFightCandidatePolicy,
    type SetupCohort,
    type SetupLiveGridType,
} from "./v0_7_setup_overnight_core";

export const V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION = 1 as const;
export const V07_COMPOSED_NONFIGHT_GUARD_STATUS = "research_only_no_bake" as const;
export const V07_COMPOSED_NONFIGHT_COHORTS = ["ranged", "mage", "melee_magic", "aura"] as const;
export type V07ComposedNonfightCohort = (typeof V07_COMPOSED_NONFIGHT_COHORTS)[number];
export const V07_COMPOSED_NONFIGHT_COHORT_DEFINITIONS: Readonly<Record<V07ComposedNonfightCohort, string>> = {
    ranged: "candidate roster contains at least one RANGE creature",
    mage: "candidate roster contains at least one MAGIC creature",
    melee_magic: "candidate roster contains at least one MELEE_MAGIC creature",
    aura: "candidate roster contains at least one creature carrying an aura",
};

const TOP_BITS_11 = 3;
const LOWER = PBTypes.TeamVals.LOWER;
const RULES = parseConditionalRules("all");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const LIVE_MAPS = [...RANKED_DRAFT_LIVE_MAP_TYPES] as SetupLiveGridType[];
const COMPOSED_LOCK_DIRECTORY = ".composed-nonfight-guard.lock";
const DRAFT_TARGETED_COHORTS = ["ranged", "mage", "melee_magic", "aura_heavy"] as const;
export const V07_COMPOSED_GUARD_ALLOWED_DESCENDANT_PATHS = [
    "docs/v0_7_composed_nonfight_guard.md",
    "src/simulation/measure_setup_conditional.ts",
    "src/simulation/ranked_draft_eval.ts",
    "src/simulation/optimizer/v0_7_composed_nonfight_guard.ts",
    "src/simulation/optimizer/v0_7_composed_nonfight_guard_worker.ts",
    "test/simulation/v0_7_composed_nonfight_guard.test.ts",
] as const;
const PRODUCTION_PANEL_MINIMUMS = {
    naturalBoards: 8_000,
    cohortBoards: 2_500,
    cohortScanMaxBoards: 1_000_000,
    symmetryBoards: 64,
    replayBoards: 8,
    preflightReserveMs: 30 * 60 * 1_000,
} as const;
const SETUP_CAMPAIGN_MINIMUM_GUARD_PAIRS = 12_288;
const SETUP_CAMPAIGN_MINIMUM_DIAGNOSTIC_GUARD_PAIRS = 4_096;
export const V07_COMPOSED_MINIMUM_NAMED_GAMES = 100;
export const V07_COMPOSED_MINIMUM_NAMED_DECISIVE_GAMES = 50;
export const V07_COMPOSED_MAX_DRAW_OR_ARMAGEDDON_REGRESSION = 0.01;

export const V07_COMPOSED_EFFECTIVE_BEHAVIOR_ENVIRONMENT = {
    LIVETWIN: "1",
    V07_PLACEMENT_REVEAL: "on",
    V07_SEARCH: "0",
} as const;
export const V07_COMPOSED_RUNTIME_CONTROLS = {
    bunRuntimeTranspilerCachePath: "0",
    workerExecArgv: [] as string[],
    fightVersion: "v0.7",
    maxLaps: 60,
    maps: LIVE_MAPS,
} as const;

const RUNTIME_INJECTION_KEYS = new Set([
    "BUN_CONFIG",
    "BUN_OPTIONS",
    "BUN_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TS_NODE_PROJECT",
    "TS_NODE_TRANSPILE_ONLY",
]);
const BEHAVIOR_ENVIRONMENT_PATTERN = /^(?:V\d+_|SEARCH_|Q\d+_|CEM_|FIGHT_|ROSTER_|AUGCA_)/;
const EXPLICIT_BEHAVIOR_KEYS = new Set([
    "AUGCA_NOVISION",
    "BASE_VERSION",
    "FORCE_CREATURES",
    "LEAGUE_INITIAL_POOL",
    "LEAGUE_MATRIX_FIGHT_VERSION",
    "LEAGUE_MATRIX_MAPS",
    "LIVETWIN",
    "MAPS",
    "OPT_VERSION",
    "OPT_WEIGHTS_ENV",
    "PHASE_B_RUN_FINGERPRINT",
    "RANDOM",
    "SIM_NO_ACTIONS",
    "SYNERGY_DUMP",
    "TEAM_WR_RANDOM",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);

if (JSON.stringify(SETUP_LIVE_GRID_TYPES) !== JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES)) {
    throw new Error("composed non-fight guard live-map definitions disagree");
}

export const V07_COMPOSED_NONFIGHT_SEED_RANGES = {
    natural: { start: 3_610_000_000, endExclusive: 3_610_200_000 },
    symmetry: { start: 3_610_200_000, endExclusive: 3_610_400_000 },
    targeted: { start: 3_620_000_000, endExclusive: 3_700_000_000 },
    replay: { start: 4_100_000_000, endExclusive: 4_100_010_000 },
} as const;

type SeedPanelKind = "natural" | "symmetry-final" | "symmetry-old" | "targeted" | "replay";
type SeedChannel = "cluster" | "pick" | "battle";

export interface IV07ComposedSeedBoard {
    panel: SeedPanelKind;
    cohort: V07ComposedNonfightCohort | null;
    selectedIndex: number;
    scanIndex: number;
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
    gridType: SetupLiveGridType;
}

export interface IV07ComposedSeedLedgerEntry {
    index: number;
    panel: SeedPanelKind;
    cohort: V07ComposedNonfightCohort | null;
    preimage: number;
    seed: number;
    topBits: number;
    scanIndex: number | null;
    channel: SeedChannel | null;
    disposition: "burned_top_bits_not_11" | "burned_outcome_blind_roster_miss" | "selected";
}

export interface IV07ComposedSeedLedger {
    schemaVersion: 1;
    status: typeof V07_COMPOSED_NONFIGHT_GUARD_STATUS;
    runId: string;
    candidateFingerprint: string;
    selectionRule: "pick_roster_only_before_any_fight";
    ranges: typeof V07_COMPOSED_NONFIGHT_SEED_RANGES;
    requested: IV07ComposedGuardPanelSizes;
    entries: IV07ComposedSeedLedgerEntry[];
    boards: IV07ComposedSeedBoard[];
    ledgerSha256: string;
}

export interface IV07ComposedGuardPanelSizes {
    naturalBoards: number;
    cohortBoards: number;
    cohortScanMaxBoards: number;
    symmetryBoards: number;
    replayBoards: number;
}

interface IV07ComposedSeedPlanCohortState {
    cursor: number;
    scanIndex: number;
    selected: number;
}

export interface IV07ComposedSeedPlanCheckpoint {
    schemaVersion: 1;
    status: "building" | "complete";
    runId: string;
    candidateFingerprint: string;
    initializationSha256: string;
    requested: IV07ComposedGuardPanelSizes;
    nextCohortIndex: number;
    cohortStates: Record<V07ComposedNonfightCohort, IV07ComposedSeedPlanCohortState>;
    entries: IV07ComposedSeedLedgerEntry[];
    boards: IV07ComposedSeedBoard[];
    ledgerSha256?: string;
    updatedAt: string;
    checkpointSha256: string;
}

export interface IV07LoadedDraftCandidate {
    path: string;
    bytesSha256: string;
    artifactSha256: string;
    runId: string;
    runFingerprint: string;
    candidateId: string;
    candidateFingerprint: string;
    intrinsic: number[];
    genome: ILeagueGenome;
}

export interface IV07LoadedSetupCandidate {
    path: string;
    bytesSha256: string;
    artifactSha256: string;
    runId: string;
    policyFingerprint: string;
    policy: INonFightCandidatePolicy;
}

export interface IV07ComposedRuntimeEnvelope {
    effectiveBehaviorEnvironment: typeof V07_COMPOSED_EFFECTIVE_BEHAVIOR_ENVIRONMENT;
    behaviorEnvironmentSha256: string;
    runtimeControls: typeof V07_COMPOSED_RUNTIME_CONTROLS;
    runtimeControlsSha256: string;
    bunExecutable: string;
    bunExecutableSha256: string;
    bunVersion: string;
    bunRevision: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    return value;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
        throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
    }
    return value;
}

function requireTrue(value: unknown, label: string): void {
    if (value !== true) throw new Error(`${label} must be exactly true`);
}

function requireFalse(value: unknown, label: string): void {
    if (value !== false) throw new Error(`${label} must be exactly false`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    const missing = keys.filter((key) => !(key in value));
    const unexpected = actual.filter((key) => !expected.has(key));
    if (missing.length || unexpected.length) {
        throw new Error(
            `${label} keys differ (missing=${missing.sort().join(",") || "none"}; ` +
                `unexpected=${unexpected.sort().join(",") || "none"})`,
        );
    }
}

function sha256Bytes(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function isRuntimeInjectionKey(key: string): boolean {
    return RUNTIME_INJECTION_KEYS.has(key) || key.startsWith("DYLD_") || key.startsWith("BUN_PRELOAD_");
}

function isBehaviorEnvironmentKey(key: string): boolean {
    return BEHAVIOR_ENVIRONMENT_PATTERN.test(key) || EXPLICIT_BEHAVIOR_KEYS.has(key);
}

export function assertV07ComposedRuntimeInjectionAbsent(
    source: NodeJS.ProcessEnv = process.env,
    execArgv: readonly string[] = process.execArgv,
): void {
    const injected = Object.keys(source).filter(isRuntimeInjectionKey).sort();
    if (injected.length) {
        throw new Error(`Forbidden runtime injection environment key(s): ${injected.join(", ")}`);
    }
    const injectionArguments = execArgv.filter(
        (value) =>
            value === "-r" ||
            value === "--require" ||
            value === "--import" ||
            value === "--loader" ||
            /^(?:-r|--require=|--import=|--loader=|--preload=|--preload$)/.test(value),
    );
    if (injectionArguments.length) {
        throw new Error(`Forbidden runtime injection argument(s): ${injectionArguments.join(", ")}`);
    }
}

export function sanitizedV07ComposedWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    assertV07ComposedRuntimeInjectionAbsent(source, []);
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
        if (
            value !== undefined &&
            !isRuntimeInjectionKey(key) &&
            !isBehaviorEnvironmentKey(key) &&
            key !== "BUN_RUNTIME_TRANSPILER_CACHE_PATH"
        ) {
            environment[key] = value;
        }
    }
    Object.assign(environment, V07_COMPOSED_EFFECTIVE_BEHAVIOR_ENVIRONMENT);
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = V07_COMPOSED_RUNTIME_CONTROLS.bunRuntimeTranspilerCachePath;
    return environment;
}

export function v07ComposedEffectiveBehaviorEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(source)
            .filter(([key, value]) => value !== undefined && isBehaviorEnvironmentKey(key))
            .map(([key, value]) => [key, value!])
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

export function captureV07ComposedRuntimeEnvelope(workerEnvironment: NodeJS.ProcessEnv): IV07ComposedRuntimeEnvelope {
    const effective = v07ComposedEffectiveBehaviorEnvironment(workerEnvironment);
    if (
        fingerprintRankedDraftArtifact(effective) !==
        fingerprintRankedDraftArtifact(V07_COMPOSED_EFFECTIVE_BEHAVIOR_ENVIRONMENT)
    ) {
        throw new Error("sanitized worker behavior environment differs from the composed contract");
    }
    const runtimeControls = {
        ...V07_COMPOSED_RUNTIME_CONTROLS,
        maps: [...V07_COMPOSED_RUNTIME_CONTROLS.maps],
        workerExecArgv: [] as string[],
    };
    return {
        effectiveBehaviorEnvironment: { ...V07_COMPOSED_EFFECTIVE_BEHAVIOR_ENVIRONMENT },
        behaviorEnvironmentSha256: fingerprintRankedDraftArtifact(effective),
        runtimeControls,
        runtimeControlsSha256: fingerprintRankedDraftArtifact(runtimeControls),
        bunExecutable: realpathSync(process.execPath),
        bunExecutableSha256: sha256Bytes(readFileSync(realpathSync(process.execPath))),
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
    };
}

function readRegularArtifact(pathInput: string, label: string): { path: string; raw: string; parsed: unknown } {
    const path = resolve(pathInput);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    const canonicalPath = realpathSync(path);
    const raw = readFileSync(canonicalPath, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (error) {
        throw new SyntaxError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { path: canonicalPath, raw, parsed };
}

export function loadV07ComposedDraftCandidate(path: string, runId: string): IV07LoadedDraftCandidate {
    const source = readRegularArtifact(path, "draft verdict");
    const root = requireRecord(source.parsed, "draft verdict");
    if (root.schemaVersion !== 1 || root.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS) {
        throw new Error("draft verdict must be schema 1 research_only_no_bake");
    }
    if (root.runId !== runId) throw new Error(`draft verdict runId does not match ${runId}`);
    const runFingerprint = requireString(root.runFingerprint, "draft verdict runFingerprint");
    if (!SHA256_PATTERN.test(runFingerprint)) throw new Error("draft verdict runFingerprint is not SHA-256");
    requireTrue(root.eligibleForManualReview, "draft verdict eligibleForManualReview");
    const checks = requireRecord(root.checks, "draft verdict checks");
    for (const key of [
        "naturalGuardPassed",
        "targetedCohortGuardPassed",
        "deterministicReplayByteIdentical",
        "deterministicReplayBehaviorTraceIdentical",
    ]) {
        requireTrue(checks[key], `draft verdict checks.${key}`);
    }
    const candidate = requireRecord(root.candidate, "draft verdict candidate");
    const candidateId = requireString(candidate.candidateId, "draft verdict candidate.candidateId");
    const candidateFingerprint = requireString(
        candidate.candidateFingerprint,
        "draft verdict candidate.candidateFingerprint",
    );
    if (!SHA256_PATTERN.test(candidateFingerprint)) throw new Error("draft candidate fingerprint is not SHA-256");
    if (!Array.isArray(candidate.intrinsic) || candidate.intrinsic.length !== 15) {
        throw new Error("draft verdict candidate.intrinsic must contain exactly 15 values");
    }
    const intrinsic = candidate.intrinsic.map((value, index) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new TypeError(`draft verdict candidate.intrinsic[${index}] must be finite`);
        }
        return value;
    });
    const genome = createRankedDraftCandidateGenome(candidateId, intrinsic);
    const reconstructed = fingerprintRankedDraftArtifact({
        schemaVersion: genome.schemaVersion,
        weights: genome.weights,
    });
    if (candidateFingerprint !== reconstructed) {
        throw new Error("draft candidate fingerprint does not match reconstructed projected genome");
    }
    return {
        path: source.path,
        bytesSha256: sha256Bytes(source.raw),
        artifactSha256: fingerprintRankedDraftArtifact(root),
        runId,
        runFingerprint,
        candidateId,
        candidateFingerprint,
        intrinsic,
        genome,
    };
}

function parseSetupPolicy(value: unknown): INonFightCandidatePolicy {
    const policy = requireRecord(value, "setup final policy");
    assertExactKeys(
        policy,
        ["id", "augmentsByCohort", "tier2ByCohort", "synergy", "placement", "placementAugmentTiming"],
        "setup final policy",
    );
    const id = requireString(policy.id, "setup final policy.id");
    const augments = requireRecord(policy.augmentsByCohort, "setup final policy.augmentsByCohort");
    const tier2 = requireRecord(policy.tier2ByCohort, "setup final policy.tier2ByCohort");
    assertExactKeys(augments, [...SETUP_COHORTS], "setup final policy.augmentsByCohort");
    assertExactKeys(tier2, [...SETUP_COHORTS], "setup final policy.tier2ByCohort");
    const augmentsByCohort = {} as INonFightCandidatePolicy["augmentsByCohort"];
    const tier2ByCohort = {} as INonFightCandidatePolicy["tier2ByCohort"];
    for (const cohort of SETUP_COHORTS) {
        const plan = requireRecord(augments[cohort], `setup final policy.augmentsByCohort.${cohort}`);
        assertExactKeys(plan, ["placement", "armor", "might", "sniper", "movement"], `augment plan ${cohort}`);
        const normalized = {
            placement: plan.placement as number,
            armor: plan.armor as number,
            might: plan.might as number,
            sniper: plan.sniper as number,
            movement: plan.movement as number,
        };
        assertAugmentPlan(normalized);
        augmentsByCohort[cohort] = normalized;
        const tier2Variant = tier2[cohort];
        if (typeof tier2Variant !== "string" || !T2_POLICY_VARIANTS.includes(tier2Variant as never)) {
            throw new Error(`setup final policy has invalid Tier-2 variant for ${cohort}`);
        }
        tier2ByCohort[cohort] = tier2Variant as INonFightCandidatePolicy["tier2ByCohort"][SetupCohort];
    }
    if (typeof policy.synergy !== "string" || !SYNERGY_POLICY_VARIANTS.includes(policy.synergy as never)) {
        throw new Error("setup final policy has an invalid synergy variant");
    }
    if (
        policy.placement !== "baseline" &&
        policy.placement !== "legitimate-reveal" &&
        policy.placement !== "public-roster"
    ) {
        throw new Error("setup final policy has an invalid placement variant");
    }
    if (policy.placementAugmentTiming !== "setup-before-placement") {
        throw new Error("setup final policy must use setup-before-placement");
    }
    return {
        id,
        augmentsByCohort,
        tier2ByCohort,
        synergy: policy.synergy as INonFightCandidatePolicy["synergy"],
        placement: policy.placement,
        placementAugmentTiming: policy.placementAugmentTiming,
    };
}

export function loadV07ComposedSetupCandidate(path: string, runId: string): IV07LoadedSetupCandidate {
    const source = readRegularArtifact(path, "setup final");
    const root = requireRecord(source.parsed, "setup final");
    if (root.schemaVersion !== V07_SETUP_OVERNIGHT_SCHEMA_VERSION || root.status !== "measurement_only") {
        throw new Error(`setup final must be schema ${V07_SETUP_OVERNIGHT_SCHEMA_VERSION} measurement_only`);
    }
    if (root.runId !== runId) throw new Error(`setup final runId does not match ${runId}`);
    if (root.campaignPhase !== "complete") throw new Error("setup final campaignPhase must be complete");
    requireFalse(root.autoBaked, "setup final autoBaked");
    const decision = requireRecord(root.decision, "setup final decision");
    for (const key of ["promotable", "currentGuardComplete", "controlSymmetryPassed", "byteIdenticalReplay"]) {
        requireTrue(decision[key], `setup final decision.${key}`);
    }
    const policy = parseSetupPolicy(root.policy);
    return {
        path: source.path,
        bytesSha256: sha256Bytes(source.raw),
        artifactSha256: fingerprintRankedDraftArtifact(root),
        runId,
        policyFingerprint: fingerprintRankedDraftArtifact(policy),
        policy,
    };
}

function integer(value: number, label: string, minimum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${label} must be >= ${minimum}`);
    return value;
}

function assertPanelSizes(value: IV07ComposedGuardPanelSizes): void {
    integer(value.naturalBoards, "naturalBoards", 2);
    integer(value.cohortBoards, "cohortBoards", 2);
    integer(value.cohortScanMaxBoards, "cohortScanMaxBoards", value.cohortBoards);
    integer(value.symmetryBoards, "symmetryBoards", 2);
    integer(value.replayBoards, "replayBoards", 1);
}

interface ISeedRange {
    start: number;
    endExclusive: number;
}

interface IPanelAllocator {
    cursor: number;
    scanIndex: number;
    entries: IV07ComposedSeedLedgerEntry[];
}

function nextSeed(
    allocator: IPanelAllocator,
    range: ISeedRange,
    panel: SeedPanelKind,
    cohort: V07ComposedNonfightCohort | null,
    channel: SeedChannel,
): number {
    while (allocator.cursor < range.endExclusive) {
        const preimage = allocator.cursor;
        allocator.cursor += 1;
        const seed = permuteRankedDraftSeed(preimage);
        const topBits = seed >>> 30;
        const entry: IV07ComposedSeedLedgerEntry = {
            index: allocator.entries.length,
            panel,
            cohort,
            preimage,
            seed,
            topBits,
            scanIndex: topBits === TOP_BITS_11 ? allocator.scanIndex : null,
            channel: topBits === TOP_BITS_11 ? channel : null,
            disposition: topBits === TOP_BITS_11 ? "selected" : "burned_top_bits_not_11",
        };
        allocator.entries.push(entry);
        if (topBits === TOP_BITS_11) return seed;
    }
    throw new Error(`${panel}${cohort ? `/${cohort}` : ""} exhausted its preregistered seed range`);
}

function allocateBoard(
    allocator: IPanelAllocator,
    range: ISeedRange,
    panel: SeedPanelKind,
    cohort: V07ComposedNonfightCohort | null,
    selectedIndex: number,
): IV07ComposedSeedBoard {
    const board: IV07ComposedSeedBoard = {
        panel,
        cohort,
        selectedIndex,
        scanIndex: allocator.scanIndex,
        pairSeed: nextSeed(allocator, range, panel, cohort, "cluster"),
        pickSeed: nextSeed(allocator, range, panel, cohort, "pick"),
        battleSeed: nextSeed(allocator, range, panel, cohort, "battle"),
        gridType: LIVE_MAPS[selectedIndex % LIVE_MAPS.length],
    };
    allocator.scanIndex += 1;
    return board;
}

function rejectAllocatedBoard(allocator: IPanelAllocator, board: IV07ComposedSeedBoard): void {
    let rejectedChannels = 0;
    for (let index = allocator.entries.length - 1; index >= 0 && rejectedChannels < 3; index -= 1) {
        const entry = allocator.entries[index];
        if (
            entry.panel === board.panel &&
            entry.cohort === board.cohort &&
            entry.scanIndex === board.scanIndex &&
            entry.disposition === "selected"
        ) {
            entry.disposition = "burned_outcome_blind_roster_miss";
            rejectedChannels += 1;
        }
    }
    if (rejectedChannels !== 3) throw new Error(`failed to burn all channels for rejected scan ${board.scanIndex}`);
}

function cohortRange(cohort: V07ComposedNonfightCohort): ISeedRange {
    const index = V07_COMPOSED_NONFIGHT_COHORTS.indexOf(cohort);
    const width =
        (V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.endExclusive - V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.start) /
        V07_COMPOSED_NONFIGHT_COHORTS.length;
    return {
        start: V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.start + index * width,
        endExclusive: V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.start + (index + 1) * width,
    };
}

export type V07ComposedOutcomeBlindSelector = (
    cohort: V07ComposedNonfightCohort,
    board: Readonly<IV07ComposedSeedBoard>,
) => boolean;

export function buildV07ComposedSeedLedger(
    runId: string,
    candidateFingerprint: string,
    requested: IV07ComposedGuardPanelSizes,
    outcomeBlindSelector: V07ComposedOutcomeBlindSelector,
): IV07ComposedSeedLedger {
    requireString(runId, "runId");
    if (!SHA256_PATTERN.test(candidateFingerprint)) throw new Error("candidateFingerprint must be SHA-256");
    assertPanelSizes(requested);
    const entries: IV07ComposedSeedLedgerEntry[] = [];
    const boards: IV07ComposedSeedBoard[] = [];
    const allocateUnfiltered = (panel: SeedPanelKind, range: ISeedRange, count: number): void => {
        const allocator: IPanelAllocator = { cursor: range.start, scanIndex: 0, entries };
        for (let index = 0; index < count; index += 1) {
            boards.push(allocateBoard(allocator, range, panel, null, index));
        }
    };
    allocateUnfiltered("natural", V07_COMPOSED_NONFIGHT_SEED_RANGES.natural, requested.naturalBoards);

    const symmetryAllocator: IPanelAllocator = {
        cursor: V07_COMPOSED_NONFIGHT_SEED_RANGES.symmetry.start,
        scanIndex: 0,
        entries,
    };
    for (const panel of ["symmetry-final", "symmetry-old"] as const) {
        for (let index = 0; index < requested.symmetryBoards; index += 1) {
            boards.push(
                allocateBoard(symmetryAllocator, V07_COMPOSED_NONFIGHT_SEED_RANGES.symmetry, panel, null, index),
            );
        }
    }

    for (const cohort of V07_COMPOSED_NONFIGHT_COHORTS) {
        const range = cohortRange(cohort);
        const allocator: IPanelAllocator = { cursor: range.start, scanIndex: 0, entries };
        let selected = 0;
        while (selected < requested.cohortBoards && allocator.scanIndex < requested.cohortScanMaxBoards) {
            const board = allocateBoard(allocator, range, "targeted", cohort, selected);
            if (outcomeBlindSelector(cohort, board)) {
                boards.push(board);
                selected += 1;
            } else {
                rejectAllocatedBoard(allocator, board);
            }
        }
        if (selected !== requested.cohortBoards) {
            throw new Error(
                `targeted ${cohort} found ${selected}/${requested.cohortBoards} qualified boards after ` +
                    `${allocator.scanIndex}/${requested.cohortScanMaxBoards} outcome-blind scans`,
            );
        }
    }

    allocateUnfiltered("replay", V07_COMPOSED_NONFIGHT_SEED_RANGES.replay, requested.replayBoards);
    const selectedSeeds = entries.filter((entry) => entry.disposition === "selected").map((entry) => entry.seed);
    if (new Set(selectedSeeds).size !== selectedSeeds.length) throw new Error("composed seed ledger reused a seed");
    if (selectedSeeds.some((seed) => seed >>> 30 !== TOP_BITS_11)) {
        throw new Error("composed seed ledger selected a seed outside top bits 11");
    }
    const unsigned = {
        schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
        status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
        runId,
        candidateFingerprint,
        selectionRule: "pick_roster_only_before_any_fight" as const,
        ranges: V07_COMPOSED_NONFIGHT_SEED_RANGES,
        requested: { ...requested },
        entries,
        boards,
    };
    return { ...unsigned, ledgerSha256: fingerprintRankedDraftArtifact(unsigned) };
}

export function validateV07ComposedSeedLedger(ledger: IV07ComposedSeedLedger): void {
    const { ledgerSha256, ...unsigned } = ledger;
    if (
        ledger.schemaVersion !== V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION ||
        ledger.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        ledger.selectionRule !== "pick_roster_only_before_any_fight" ||
        !SHA256_PATTERN.test(ledger.candidateFingerprint) ||
        fingerprintRankedDraftArtifact(ledger.ranges) !==
            fingerprintRankedDraftArtifact(V07_COMPOSED_NONFIGHT_SEED_RANGES) ||
        ledgerSha256 !== fingerprintRankedDraftArtifact(unsigned)
    ) {
        throw new Error("seed ledger identity or self-hash mismatch");
    }
    assertPanelSizes(ledger.requested);
    const preimages = new Set<number>();
    const allSeeds = new Set<number>();
    const panelKinds = new Set<SeedPanelKind>(["natural", "symmetry-final", "symmetry-old", "targeted", "replay"]);
    ledger.entries.forEach((entry, index) => {
        if (
            !panelKinds.has(entry.panel) ||
            (entry.panel === "targeted") !== (entry.cohort !== null) ||
            (entry.cohort !== null && !V07_COMPOSED_NONFIGHT_COHORTS.includes(entry.cohort)) ||
            !["burned_top_bits_not_11", "burned_outcome_blind_roster_miss", "selected"].includes(entry.disposition) ||
            (entry.channel !== null && !["cluster", "pick", "battle"].includes(entry.channel)) ||
            (entry.scanIndex !== null && (!Number.isInteger(entry.scanIndex) || entry.scanIndex < 0))
        ) {
            throw new Error(`seed ledger entry ${index} has an invalid panel/cohort identity`);
        }
        const range =
            entry.panel === "natural"
                ? V07_COMPOSED_NONFIGHT_SEED_RANGES.natural
                : entry.panel === "symmetry-final" || entry.panel === "symmetry-old"
                  ? V07_COMPOSED_NONFIGHT_SEED_RANGES.symmetry
                  : entry.panel === "replay"
                    ? V07_COMPOSED_NONFIGHT_SEED_RANGES.replay
                    : entry.cohort
                      ? cohortRange(entry.cohort)
                      : undefined;
        if (
            entry.index !== index ||
            !range ||
            entry.preimage < range.start ||
            entry.preimage >= range.endExclusive ||
            entry.seed !== permuteRankedDraftSeed(entry.preimage) ||
            entry.topBits !== entry.seed >>> 30 ||
            preimages.has(entry.preimage) ||
            allSeeds.has(entry.seed)
        ) {
            throw new Error(`seed ledger entry ${index} failed contiguous permutation integrity`);
        }
        preimages.add(entry.preimage);
        allSeeds.add(entry.seed);
        if (entry.disposition === "burned_top_bits_not_11") {
            if (entry.topBits === TOP_BITS_11 || entry.channel !== null || entry.scanIndex !== null) {
                throw new Error(`seed ledger burned entry ${index} is malformed`);
            }
        } else if (entry.topBits !== TOP_BITS_11 || entry.channel === null || entry.scanIndex === null) {
            throw new Error(`seed ledger accepted entry ${index} is malformed`);
        }
    });
    const streams = new Map<string, { start: number; entries: IV07ComposedSeedLedgerEntry[] }>([
        ["natural", { start: V07_COMPOSED_NONFIGHT_SEED_RANGES.natural.start, entries: [] }],
        ["symmetry", { start: V07_COMPOSED_NONFIGHT_SEED_RANGES.symmetry.start, entries: [] }],
        ["replay", { start: V07_COMPOSED_NONFIGHT_SEED_RANGES.replay.start, entries: [] }],
    ]);
    for (const cohort of V07_COMPOSED_NONFIGHT_COHORTS) {
        streams.set(`targeted/${cohort}`, { start: cohortRange(cohort).start, entries: [] });
    }
    for (const entry of ledger.entries) {
        const key =
            entry.panel === "symmetry-final" || entry.panel === "symmetry-old"
                ? "symmetry"
                : entry.panel === "targeted"
                  ? `targeted/${entry.cohort}`
                  : entry.panel;
        streams.get(key)!.entries.push(entry);
    }
    for (const [stream, value] of streams) {
        value.entries.forEach((entry, index) => {
            if (entry.preimage !== value.start + index) {
                throw new Error(`seed ledger stream ${stream} omitted or reordered preimage ${value.start + index}`);
            }
        });
    }
    const selected = ledger.entries.filter((entry) => entry.disposition === "selected");
    const selectedBySeed = new Map(selected.map((entry) => [entry.seed, entry]));
    const boardSeeds = ledger.boards.flatMap((board) => [board.pairSeed, board.pickSeed, board.battleSeed]);
    if (
        selected.length !== boardSeeds.length ||
        selectedBySeed.size !== selected.length ||
        new Set(boardSeeds).size !== boardSeeds.length ||
        boardSeeds.some((seed) => !selectedBySeed.has(seed))
    ) {
        throw new Error("seed ledger selected entries do not exactly bind its boards");
    }
    const expectedBoards =
        ledger.requested.naturalBoards +
        ledger.requested.symmetryBoards * 2 +
        ledger.requested.cohortBoards * V07_COMPOSED_NONFIGHT_COHORTS.length +
        ledger.requested.replayBoards;
    if (ledger.boards.length !== expectedBoards) throw new Error("seed ledger board count is incomplete");
    const expectedByGroup = new Map<string, number>([
        ["natural", ledger.requested.naturalBoards],
        ["symmetry-final", ledger.requested.symmetryBoards],
        ["symmetry-old", ledger.requested.symmetryBoards],
        ["replay", ledger.requested.replayBoards],
        ...V07_COMPOSED_NONFIGHT_COHORTS.map(
            (cohort) => [`targeted/${cohort}`, ledger.requested.cohortBoards] as const,
        ),
    ]);
    for (const [group, count] of expectedByGroup) {
        const boards = ledger.boards.filter((board) =>
            group.startsWith("targeted/")
                ? board.panel === "targeted" && board.cohort === group.slice("targeted/".length)
                : board.panel === group,
        );
        if (
            boards.length !== count ||
            boards.some(
                (board, index) =>
                    board.selectedIndex !== index ||
                    board.gridType !== LIVE_MAPS[index % LIVE_MAPS.length] ||
                    (board.panel === "targeted") !== (board.cohort !== null),
            )
        ) {
            throw new Error(`seed ledger group ${group} is incomplete or non-contiguous`);
        }
        for (const board of boards) {
            for (const [channel, seed] of [
                ["cluster", board.pairSeed],
                ["pick", board.pickSeed],
                ["battle", board.battleSeed],
            ] as const) {
                const entry = selectedBySeed.get(seed);
                if (
                    !entry ||
                    entry.panel !== board.panel ||
                    entry.cohort !== board.cohort ||
                    entry.scanIndex !== board.scanIndex ||
                    entry.channel !== channel
                ) {
                    throw new Error(`seed ledger board ${board.pairSeed} does not bind its ${channel} channel`);
                }
            }
        }
    }
}

function seedPlanWithHash(
    value: Omit<IV07ComposedSeedPlanCheckpoint, "checkpointSha256">,
): IV07ComposedSeedPlanCheckpoint {
    return { ...value, checkpointSha256: fingerprintRankedDraftArtifact(value) };
}

function saveSeedPlan(path: string, checkpoint: IV07ComposedSeedPlanCheckpoint): void {
    const unsigned = { ...checkpoint };
    delete (unsigned as Partial<IV07ComposedSeedPlanCheckpoint>).checkpointSha256;
    Object.assign(checkpoint, seedPlanWithHash({ ...unsigned, updatedAt: new Date().toISOString() }));
    atomicJson(path, checkpoint);
}

function validateSeedPlan(
    checkpoint: IV07ComposedSeedPlanCheckpoint,
    runId: string,
    candidateFingerprint: string,
    initializationSha256: string,
    requested: IV07ComposedGuardPanelSizes,
): void {
    const { checkpointSha256, ...unsigned } = checkpoint;
    if (
        checkpoint.schemaVersion !== 1 ||
        !["building", "complete"].includes(checkpoint.status) ||
        checkpoint.runId !== runId ||
        checkpoint.candidateFingerprint !== candidateFingerprint ||
        checkpoint.initializationSha256 !== initializationSha256 ||
        fingerprintRankedDraftArtifact(checkpoint.requested) !== fingerprintRankedDraftArtifact(requested) ||
        checkpointSha256 !== fingerprintRankedDraftArtifact(unsigned) ||
        !Number.isInteger(checkpoint.nextCohortIndex) ||
        checkpoint.nextCohortIndex < 0 ||
        checkpoint.nextCohortIndex > V07_COMPOSED_NONFIGHT_COHORTS.length
    ) {
        throw new Error("seed-plan checkpoint identity or self-hash mismatch");
    }
    const preimages = new Set<number>();
    const seeds = new Set<number>();
    checkpoint.entries.forEach((entry, index) => {
        if (
            entry.index !== index ||
            preimages.has(entry.preimage) ||
            seeds.has(entry.seed) ||
            entry.seed !== permuteRankedDraftSeed(entry.preimage)
        ) {
            throw new Error(`seed-plan checkpoint entry ${index} is duplicated or malformed`);
        }
        preimages.add(entry.preimage);
        seeds.add(entry.seed);
    });
    const boardSeeds = checkpoint.boards.flatMap((board) => [board.pairSeed, board.pickSeed, board.battleSeed]);
    if (new Set(boardSeeds).size !== boardSeeds.length || boardSeeds.some((seed) => !seeds.has(seed))) {
        throw new Error("seed-plan checkpoint boards are not bound to unique recorded seed entries");
    }
    for (const [index, cohort] of V07_COMPOSED_NONFIGHT_COHORTS.entries()) {
        const state = checkpoint.cohortStates[cohort];
        const range = cohortRange(cohort);
        const selected = checkpoint.boards.filter((board) => board.panel === "targeted" && board.cohort === cohort);
        if (
            !state ||
            !Number.isInteger(state.cursor) ||
            state.cursor < range.start ||
            state.cursor > range.endExclusive ||
            !Number.isInteger(state.scanIndex) ||
            state.scanIndex < 0 ||
            state.scanIndex > requested.cohortScanMaxBoards ||
            state.selected !== selected.length ||
            state.selected > requested.cohortBoards ||
            selected.some((board, selectedIndex) => board.selectedIndex !== selectedIndex) ||
            (index < checkpoint.nextCohortIndex && state.selected !== requested.cohortBoards) ||
            (index > checkpoint.nextCohortIndex && state.scanIndex !== 0)
        ) {
            throw new Error(`seed-plan checkpoint cohort ${cohort} has invalid resumable progress`);
        }
    }
    if (checkpoint.status === "complete") {
        if (checkpoint.nextCohortIndex !== V07_COMPOSED_NONFIGHT_COHORTS.length || !checkpoint.ledgerSha256) {
            throw new Error("complete seed-plan checkpoint omitted its final ledger identity");
        }
    } else if (checkpoint.ledgerSha256 !== undefined) {
        throw new Error("building seed-plan checkpoint cannot claim a final ledger");
    }
}

function initializeSeedPlan(
    runId: string,
    candidateFingerprint: string,
    initializationSha256: string,
    requested: IV07ComposedGuardPanelSizes,
): IV07ComposedSeedPlanCheckpoint {
    const entries: IV07ComposedSeedLedgerEntry[] = [];
    const boards: IV07ComposedSeedBoard[] = [];
    const naturalAllocator: IPanelAllocator = {
        cursor: V07_COMPOSED_NONFIGHT_SEED_RANGES.natural.start,
        scanIndex: 0,
        entries,
    };
    for (let index = 0; index < requested.naturalBoards; index += 1) {
        boards.push(allocateBoard(naturalAllocator, V07_COMPOSED_NONFIGHT_SEED_RANGES.natural, "natural", null, index));
    }
    const symmetryAllocator: IPanelAllocator = {
        cursor: V07_COMPOSED_NONFIGHT_SEED_RANGES.symmetry.start,
        scanIndex: 0,
        entries,
    };
    for (const panel of ["symmetry-final", "symmetry-old"] as const) {
        for (let index = 0; index < requested.symmetryBoards; index += 1) {
            boards.push(
                allocateBoard(symmetryAllocator, V07_COMPOSED_NONFIGHT_SEED_RANGES.symmetry, panel, null, index),
            );
        }
    }
    const cohortStates = Object.fromEntries(
        V07_COMPOSED_NONFIGHT_COHORTS.map((cohort) => [
            cohort,
            { cursor: cohortRange(cohort).start, scanIndex: 0, selected: 0 },
        ]),
    ) as Record<V07ComposedNonfightCohort, IV07ComposedSeedPlanCohortState>;
    return seedPlanWithHash({
        schemaVersion: 1,
        status: "building",
        runId,
        candidateFingerprint,
        initializationSha256,
        requested: { ...requested },
        nextCohortIndex: 0,
        cohortStates,
        entries,
        boards,
        updatedAt: new Date().toISOString(),
    });
}

export async function buildOrResumeV07ComposedSeedLedger(
    path: string,
    runId: string,
    candidateFingerprint: string,
    initializationSha256: string,
    requested: IV07ComposedGuardPanelSizes,
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    workers: number,
    workerEnvironment: NodeJS.ProcessEnv,
    runtime: IV07ComposedRuntimeEnvelope,
    preflightDeadlineMs: number,
): Promise<{ checkpoint: IV07ComposedSeedPlanCheckpoint; ledger: IV07ComposedSeedLedger | null }> {
    let checkpoint = existsSync(path)
        ? parseJson<IV07ComposedSeedPlanCheckpoint>(path, "seed-plan checkpoint")
        : initializeSeedPlan(runId, candidateFingerprint, initializationSha256, requested);
    validateSeedPlan(checkpoint, runId, candidateFingerprint, initializationSha256, requested);
    if (!existsSync(path)) atomicJson(path, checkpoint);
    while (checkpoint.nextCohortIndex < V07_COMPOSED_NONFIGHT_COHORTS.length) {
        if (Date.now() >= preflightDeadlineMs) return { checkpoint, ledger: null };
        const cohort = V07_COMPOSED_NONFIGHT_COHORTS[checkpoint.nextCohortIndex];
        const state = checkpoint.cohortStates[cohort];
        const range = cohortRange(cohort);
        if (state.selected >= requested.cohortBoards) {
            checkpoint.nextCohortIndex += 1;
            saveSeedPlan(path, checkpoint);
            continue;
        }
        if (state.scanIndex >= requested.cohortScanMaxBoards) {
            throw new Error(
                `targeted ${cohort} found ${state.selected}/${requested.cohortBoards} qualified boards after ` +
                    `${state.scanIndex}/${requested.cohortScanMaxBoards} outcome-blind scans`,
            );
        }
        const count = Math.min(
            256,
            requested.cohortBoards - state.selected,
            requested.cohortScanMaxBoards - state.scanIndex,
        );
        const entryCountBefore = checkpoint.entries.length;
        const allocator: IPanelAllocator = {
            cursor: state.cursor,
            scanIndex: state.scanIndex,
            entries: checkpoint.entries,
        };
        const scanBoards = Array.from({ length: count }, () =>
            allocateBoard(allocator, range, "targeted", cohort, state.selected),
        );
        const inspections = await inspectBoardsInWorkers(
            candidate,
            baseline,
            scanBoards,
            workers,
            preflightDeadlineMs,
            workerEnvironment,
            runtime,
        );
        if (inspections.length !== scanBoards.length) {
            checkpoint.entries.length = entryCountBefore;
            return { checkpoint, ledger: null };
        }
        let selected = state.selected;
        for (const [index, board] of scanBoards.entries()) {
            if (inspections[index].includes(cohort)) {
                board.selectedIndex = selected;
                board.gridType = LIVE_MAPS[selected % LIVE_MAPS.length];
                checkpoint.boards.push(board);
                selected += 1;
            } else {
                rejectAllocatedBoard(allocator, board);
            }
        }
        state.cursor = allocator.cursor;
        state.scanIndex = allocator.scanIndex;
        state.selected = selected;
        saveSeedPlan(path, checkpoint);
    }
    if (checkpoint.status !== "complete") {
        const replayAllocator: IPanelAllocator = {
            cursor: V07_COMPOSED_NONFIGHT_SEED_RANGES.replay.start,
            scanIndex: 0,
            entries: checkpoint.entries,
        };
        for (let index = 0; index < requested.replayBoards; index += 1) {
            checkpoint.boards.push(
                allocateBoard(replayAllocator, V07_COMPOSED_NONFIGHT_SEED_RANGES.replay, "replay", null, index),
            );
        }
        const unsigned = {
            schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
            status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
            runId,
            candidateFingerprint,
            selectionRule: "pick_roster_only_before_any_fight" as const,
            ranges: V07_COMPOSED_NONFIGHT_SEED_RANGES,
            requested: { ...requested },
            entries: checkpoint.entries,
            boards: checkpoint.boards,
        };
        const ledger: IV07ComposedSeedLedger = {
            ...unsigned,
            ledgerSha256: fingerprintRankedDraftArtifact(unsigned),
        };
        validateV07ComposedSeedLedger(ledger);
        checkpoint.status = "complete";
        checkpoint.ledgerSha256 = ledger.ledgerSha256;
        saveSeedPlan(path, checkpoint);
        return { checkpoint, ledger };
    }
    const unsigned = {
        schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
        status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
        runId,
        candidateFingerprint,
        selectionRule: "pick_roster_only_before_any_fight" as const,
        ranges: V07_COMPOSED_NONFIGHT_SEED_RANGES,
        requested: { ...requested },
        entries: checkpoint.entries,
        boards: checkpoint.boards,
    };
    const ledger: IV07ComposedSeedLedger = { ...unsigned, ledgerSha256: fingerprintRankedDraftArtifact(unsigned) };
    validateV07ComposedSeedLedger(ledger);
    if (checkpoint.ledgerSha256 !== ledger.ledgerSha256) throw new Error("seed-plan final ledger identity changed");
    return { checkpoint, ledger };
}

export interface IV07ComposedArm {
    id: string;
    genome: ILeagueGenome;
    policy: INonFightCandidatePolicy;
}

export interface IV07ComposedGameRecord {
    panel: SeedPanelKind;
    cohort: V07ComposedNonfightCohort | null;
    boardIndex: number;
    game: number;
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
    gridType: SetupLiveGridType;
    pickSeat: "candidate-lower" | "candidate-upper";
    battleMirror: 0 | 1;
    candidateSide: Side;
    candidateResult: "win" | "loss" | "draw";
    winner: Side | "draw";
    candidateCohorts: V07ComposedNonfightCohort[];
    candidateRejections: number;
    baselineRejections: number;
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    setupFingerprint: string;
    behaviorTraceSha256: string;
}

export interface IV07ComposedCluster {
    board: IV07ComposedSeedBoard;
    records: [IV07ComposedGameRecord, IV07ComposedGameRecord, IV07ComposedGameRecord, IV07ComposedGameRecord];
}

export interface IV07ComposedEstimate {
    offerBoards: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveGames: number;
    decisiveWinRate: number;
    confidence95: { low: number; high: number };
    candidateRejections: number;
    baselineRejections: number;
    avgLaps: number;
    endReasons: Record<IMatchResult["endReason"], number>;
    drawOrArmageddonRate: number;
}

function composedCohorts(creatureIds: readonly number[]): V07ComposedNonfightCohort[] {
    return classifyRankedDraftCohorts(creatureIds).map((cohort) => (cohort === "aura_heavy" ? "aura" : cohort));
}

function armySetup(policy: INonFightCandidatePolicy, army: IConditionalArmy, opponent: IConditionalArmy) {
    const resolved = compileNonFightSetupPolicy(policy, policy.id);
    const placementUsesOpponentIds =
        resolved.placement === "legitimate-reveal" || resolved.placement === "public-roster";
    return {
        augments: resolved.pickAugments(V07_SETUP_BUDGET, army.creatureIds),
        synergies: resolved.pickSynergies(army.creatureIds),
        revealedCreatures: placementUsesOpponentIds ? army.revealedOpponentCreatures : undefined,
        ...(resolved.placement === "public-roster"
            ? { publicOpponentCreatures: [...new Set(opponent.creatureIds)] }
            : {}),
        placement: resolved.placement,
    };
}

function pickForAssignment(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    board: IV07ComposedSeedBoard,
    candidatePickedLower: boolean,
) {
    const lowerArm = candidatePickedLower ? candidate : baseline;
    const upperArm = candidatePickedLower ? baseline : candidate;
    const armForTeam = (team: PickTeam): IV07ComposedArm => (team === LOWER ? lowerArm : upperArm);
    const pick = runRankedConditionalPickGame(board.pickSeed, RULES, baseline.genome, {
        lowerGenome: lowerArm.genome,
        upperGenome: upperArm.genome,
        pickArtifactT2: (team, offered, ownCreatureIdsAtTier2) => {
            const policy = armForTeam(team).policy;
            return compileNonFightSetupPolicy(policy, policy.id).pickArtifactT2(offered, ownCreatureIdsAtTier2);
        },
    });
    return { pick, lowerArm, upperArm };
}

/** Targeted selection is based only on both candidate pick-seat rosters; it never starts a fight. */
export function inspectV07ComposedBoardCohorts(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    board: IV07ComposedSeedBoard,
): V07ComposedNonfightCohort[] {
    const cohorts = new Set<V07ComposedNonfightCohort>();
    for (const candidatePickedLower of [true, false]) {
        const { pick } = pickForAssignment(candidate, baseline, board, candidatePickedLower);
        const army = candidatePickedLower ? pick.lower : pick.upper;
        for (const cohort of composedCohorts(army.creatureIds)) cohorts.add(cohort);
    }
    return V07_COMPOSED_NONFIGHT_COHORTS.filter((cohort) => cohorts.has(cohort));
}

function resultForSide(result: IMatchResult, side: Side): IV07ComposedGameRecord["candidateResult"] {
    if (result.winner === "draw") return "draw";
    return result.winner === side ? "win" : "loss";
}

export interface IV07ComposedPreparedMatch {
    config: IMatchConfig;
    candidateSide: Side;
    candidateArmyCreatureIds: number[];
    baselineArmyCreatureIds: number[];
    candidateTier2Artifact: number;
    baselineTier2Artifact: number;
    candidateAugments: IMatchConfig["greenAugments"];
    baselineAugments: IMatchConfig["greenAugments"];
    candidateSynergies: IMatchConfig["greenSynergies"];
    baselineSynergies: IMatchConfig["greenSynergies"];
    candidateRevealedCreatures: IMatchConfig["greenRevealedCreatures"];
    baselineRevealedCreatures: IMatchConfig["greenRevealedCreatures"];
    candidatePublicOpponentCreatures: IMatchConfig["greenPublicOpponentCreatures"];
    baselinePublicOpponentCreatures: IMatchConfig["greenPublicOpponentCreatures"];
    setupFingerprint: string;
}

/** Outcome-blind setup preparation used by the guard and its end-to-end policy-wiring test. */
export function prepareV07ComposedMatch(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    board: IV07ComposedSeedBoard,
    candidatePickedLower: boolean,
    battleMirror: 0 | 1,
): IV07ComposedPreparedMatch {
    if (
        candidate.policy.placementAugmentTiming !== "setup-before-placement" ||
        baseline.policy.placementAugmentTiming !== "setup-before-placement"
    ) {
        throw new Error("composed guard entrants must both use setup-before-placement");
    }
    const { pick, lowerArm, upperArm } = pickForAssignment(candidate, baseline, board, candidatePickedLower);
    const lowerSetup = armySetup(lowerArm.policy, pick.lower, pick.upper);
    const upperSetup = armySetup(upperArm.policy, pick.upper, pick.lower);
    const greenArmy = battleMirror === 0 ? pick.lower : pick.upper;
    const redArmy = battleMirror === 0 ? pick.upper : pick.lower;
    const greenSetup = battleMirror === 0 ? lowerSetup : upperSetup;
    const redSetup = battleMirror === 0 ? upperSetup : lowerSetup;
    const candidateIsGreen = battleMirror === 0 ? candidatePickedLower : !candidatePickedLower;
    const candidateSide: Side = candidateIsGreen ? "green" : "red";
    const candidateArmy = candidatePickedLower ? pick.lower : pick.upper;
    const baselineArmy = candidatePickedLower ? pick.upper : pick.lower;
    const candidateSetup = candidatePickedLower ? lowerSetup : upperSetup;
    const baselineSetup = candidatePickedLower ? upperSetup : lowerSetup;
    const config: IMatchConfig = {
        greenVersion: "v0.7",
        redVersion: "v0.7",
        roster: greenArmy.roster,
        redRoster: redArmy.roster,
        seed: board.battleSeed,
        gridType: board.gridType,
        maxLaps: V07_COMPOSED_RUNTIME_CONTROLS.maxLaps,
        greenPerk: greenArmy.perk,
        redPerk: redArmy.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
        greenArtifactT1: greenArmy.tier1Artifact,
        redArtifactT1: redArmy.tier1Artifact,
        greenArtifactT2: greenArmy.tier2Artifact,
        redArtifactT2: redArmy.tier2Artifact,
        greenSynergies: greenSetup.synergies,
        redSynergies: redSetup.synergies,
        greenRevealedCreatures: greenSetup.revealedCreatures,
        redRevealedCreatures: redSetup.revealedCreatures,
        ...(greenSetup.publicOpponentCreatures
            ? { greenPublicOpponentCreatures: greenSetup.publicOpponentCreatures }
            : {}),
        ...(redSetup.publicOpponentCreatures ? { redPublicOpponentCreatures: redSetup.publicOpponentCreatures } : {}),
        greenSetupPlacementPolicy: greenSetup.placement,
        redSetupPlacementPolicy: redSetup.placement,
        placementAugmentTiming: "setup-before-placement",
    };
    return {
        config,
        candidateSide,
        candidateArmyCreatureIds: [...candidateArmy.creatureIds],
        baselineArmyCreatureIds: [...baselineArmy.creatureIds],
        candidateTier2Artifact: candidateArmy.tier2Artifact,
        baselineTier2Artifact: baselineArmy.tier2Artifact,
        candidateAugments: candidateSetup.augments,
        baselineAugments: baselineSetup.augments,
        candidateSynergies: candidateSetup.synergies,
        baselineSynergies: baselineSetup.synergies,
        candidateRevealedCreatures: candidateSetup.revealedCreatures,
        baselineRevealedCreatures: baselineSetup.revealedCreatures,
        candidatePublicOpponentCreatures: candidateSetup.publicOpponentCreatures,
        baselinePublicOpponentCreatures: baselineSetup.publicOpponentCreatures,
        setupFingerprint: fingerprintRankedDraftArtifact({
            lower: { army: pick.lower, setup: lowerSetup, policy: lowerArm.policy.id },
            upper: { army: pick.upper, setup: upperSetup, policy: upperArm.policy.id },
            gridType: board.gridType,
        }),
    };
}

function playBattleMirror(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    board: IV07ComposedSeedBoard,
    candidatePickedLower: boolean,
    battleMirror: 0 | 1,
): IV07ComposedGameRecord {
    const prepared = prepareV07ComposedMatch(candidate, baseline, board, candidatePickedLower, battleMirror);
    const { candidateSide, config } = prepared;
    FightStateManager.getInstance();
    const result = runMatch(config);
    if (result.gridType !== board.gridType) throw new Error(`battle ${board.pairSeed} changed its registered map`);
    if (result.rejectedGreen === undefined || result.rejectedRed === undefined) {
        throw new Error(`battle ${board.pairSeed} omitted rejection telemetry`);
    }
    const candidateRejections = candidateSide === "green" ? result.rejectedGreen : result.rejectedRed;
    const baselineRejections = candidateSide === "green" ? result.rejectedRed : result.rejectedGreen;
    return {
        panel: board.panel,
        cohort: board.cohort,
        boardIndex: board.selectedIndex,
        game: (candidatePickedLower ? 0 : 2) + battleMirror,
        pairSeed: board.pairSeed,
        pickSeed: board.pickSeed,
        battleSeed: board.battleSeed,
        gridType: board.gridType,
        pickSeat: candidatePickedLower ? "candidate-lower" : "candidate-upper",
        battleMirror,
        candidateSide,
        candidateResult: resultForSide(result, candidateSide),
        winner: result.winner,
        candidateCohorts: composedCohorts(prepared.candidateArmyCreatureIds),
        candidateRejections,
        baselineRejections,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        setupFingerprint: prepared.setupFingerprint,
        behaviorTraceSha256: rankedDraftBehaviorTraceSha256(result),
    };
}

export function evaluateV07ComposedCluster(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    board: IV07ComposedSeedBoard,
): IV07ComposedCluster {
    const records = ([true, false] as const).flatMap((candidatePickedLower) =>
        ([0, 1] as const).map((battleMirror) =>
            playBattleMirror(candidate, baseline, board, candidatePickedLower, battleMirror),
        ),
    ) as IV07ComposedCluster["records"];
    validateV07ComposedClusters([{ board, records }]);
    return { board, records };
}

export function validateV07ComposedClusters(clusters: readonly IV07ComposedCluster[]): void {
    const pairSeeds = new Set<number>();
    for (const cluster of clusters) {
        const { board, records } = cluster;
        if (pairSeeds.has(board.pairSeed)) throw new Error(`duplicate composed cluster seed ${board.pairSeed}`);
        pairSeeds.add(board.pairSeed);
        if (!Array.isArray(records) || records.length !== 4) {
            throw new Error(`composed cluster ${board.pairSeed} must contain exactly four games`);
        }
        const ordered = [...records].sort((left, right) => left.game - right.game);
        const expectedSeats = ["candidate-lower", "candidate-lower", "candidate-upper", "candidate-upper"];
        const expectedMirrors = [0, 1, 0, 1];
        const expectedSides = ["green", "red", "red", "green"];
        ordered.forEach((record, index) => {
            if (
                record.game !== index ||
                record.pairSeed !== board.pairSeed ||
                record.pickSeed !== board.pickSeed ||
                record.battleSeed !== board.battleSeed ||
                record.gridType !== board.gridType ||
                record.panel !== board.panel ||
                record.cohort !== board.cohort ||
                record.pickSeat !== expectedSeats[index] ||
                record.battleMirror !== expectedMirrors[index] ||
                record.candidateSide !== expectedSides[index]
            ) {
                throw new Error(`composed cluster ${board.pairSeed} failed pick-seat/battle-side integrity`);
            }
            const expectedResult =
                record.winner === "draw" ? "draw" : record.winner === record.candidateSide ? "win" : "loss";
            if (
                record.candidateResult !== expectedResult ||
                !SHA256_PATTERN.test(record.setupFingerprint) ||
                !SHA256_PATTERN.test(record.behaviorTraceSha256)
            ) {
                throw new Error(`composed cluster ${board.pairSeed} has malformed game evidence`);
            }
        });
        for (const start of [0, 2]) {
            if (
                ordered[start].setupFingerprint !== ordered[start + 1].setupFingerprint ||
                JSON.stringify(ordered[start].candidateCohorts) !== JSON.stringify(ordered[start + 1].candidateCohorts)
            ) {
                throw new Error(`composed cluster ${board.pairSeed} changed setup across a battle mirror`);
            }
        }
    }
}

export function estimateV07ComposedRecords(recordsInput: readonly IV07ComposedGameRecord[]): IV07ComposedEstimate {
    const records = [...recordsInput];
    const wins = records.filter((record) => record.candidateResult === "win").length;
    const losses = records.filter((record) => record.candidateResult === "loss").length;
    const decisiveGames = wins + losses;
    const endReasons = { elimination: 0, turn_cap: 0, stuck: 0 };
    for (const record of records) endReasons[record.endReason] += 1;
    return {
        offerBoards: new Set(records.map((record) => record.pairSeed)).size,
        games: records.length,
        wins,
        losses,
        draws: records.length - decisiveGames,
        decisiveGames,
        decisiveWinRate: decisiveGames ? wins / decisiveGames : 0.5,
        confidence95: clusteredRankedDraftConfidence95(records),
        candidateRejections: records.reduce((sum, record) => sum + record.candidateRejections, 0),
        baselineRejections: records.reduce((sum, record) => sum + record.baselineRejections, 0),
        avgLaps: records.length ? records.reduce((sum, record) => sum + record.laps, 0) / records.length : 0,
        endReasons,
        drawOrArmageddonRate: records.length
            ? records.filter((record) => record.candidateResult === "draw" || record.decidedByArmageddon).length /
              records.length
            : 0,
    };
}

function recordsFor(clusters: readonly IV07ComposedCluster[]): IV07ComposedGameRecord[] {
    validateV07ComposedClusters(clusters);
    return clusters
        .flatMap((cluster) => cluster.records)
        .sort((left, right) => left.pairSeed - right.pairSeed || left.game - right.game);
}

export interface IV07ComposedGuardOptions extends IV07ComposedGuardPanelSizes {
    out: string;
    campaignRun: string;
    campaignTerminal: string;
    campaignRunSha256: string;
    campaignTerminalSha256: string;
    campaignConfigSha256: string;
    campaignProvenanceSha256: string;
    campaignSourceCommit: string;
    guardSourceCommit: string;
    draftVerdict: string;
    draftVerdictSha256: string;
    draftRunFingerprint: string;
    setupFinal: string;
    setupFinalSha256: string;
    setupCheckpointSha256: string;
    workers: number;
    deadlineMs: number;
    preflightReserveMs: number;
    runId: string;
    smoke: boolean;
}

interface IV07ComposedProvenance {
    commit: string;
    tree: string;
    branch: string;
    originMain: string;
    statusPorcelainSha256: string;
    cleanIncludingUntracked: boolean;
    platform: NodeJS.Platform;
    arch: string;
    bunVersion: string;
    bunRevision: string;
    bunExecutableSha256: string;
    runtimeEnvelopeSha256: string;
    provenanceSha256: string;
}

interface IV07ComposedSourceLineage {
    campaignSourceCommit: string;
    guardSourceCommit: string;
    campaignIsAncestor: true;
    allowedDescendantPaths: readonly string[];
    changedPaths: string[];
    diffSha256: string;
    lineageSha256: string;
}

interface IV07CampaignRunArtifact {
    schemaVersion: 1;
    artifactKind: "v0_7_nonfight_campaign_run";
    status: "research_only_no_bake";
    automaticBake: false;
    automaticDeploy: false;
    runId: string;
    configSha256: string;
    outputDirectory: string;
    repositoryRoot: string;
    provenance: IV07NonfightCampaignProvenance;
    lanes: IV07NonfightCampaignRenderedLane[];
    runSha256: string;
    [key: string]: unknown;
}

interface IV07CampaignTerminalLane {
    lane: string;
    status: string;
    exitCode: number | null;
    signal: string | null;
    [key: string]: unknown;
}

interface IV07CampaignTerminalArtifact {
    schemaVersion: 1;
    artifactKind: "v0_7_nonfight_campaign_terminal";
    status: "complete_research_only";
    automaticBake: false;
    automaticDeploy: false;
    promotionAttempted: false;
    runId: string;
    runSha256: string;
    reason: "lanes_completed";
    signal: null;
    hardDeadlineKilledLanes: string[];
    lanes: IV07CampaignTerminalLane[];
    terminalSha256: string;
    [key: string]: unknown;
}

interface IV07ValidatedCampaignInputs {
    campaignRun: ReturnType<typeof readRegularArtifact>;
    campaignTerminal: ReturnType<typeof readRegularArtifact>;
    draftVerdict: ReturnType<typeof readRegularArtifact>;
    draftRun: ReturnType<typeof readRegularArtifact>;
    draftState: ReturnType<typeof readRegularArtifact>;
    draftReferences: Array<{ name: string; source: ReturnType<typeof readRegularArtifact> }>;
    setupFinal: ReturnType<typeof readRegularArtifact>;
    setupCheckpoint: ReturnType<typeof readRegularArtifact>;
    run: IV07CampaignRunArtifact;
    terminal: IV07CampaignTerminalArtifact;
    draftLane: IV07NonfightCampaignRenderedLane;
    setupLane: IV07NonfightCampaignRenderedLane;
    draft: IV07LoadedDraftCandidate;
    setup: IV07LoadedSetupCandidate;
}

interface IV07SealedInputReference {
    path: string;
    bytesSha256: string;
}

interface IV07ComposedManifest {
    schemaVersion: 1;
    status: typeof V07_COMPOSED_NONFIGHT_GUARD_STATUS;
    runId: string;
    deadlineMs: number;
    workers: number;
    smoke: boolean;
    preflightReserveMs: number;
    autoBake: false;
    maps: SetupLiveGridType[];
    cluster: "four_games_pick_seat_by_battle_side";
    panels: IV07ComposedGuardPanelSizes;
    campaign: {
        runSha256: string;
        terminalSha256: string;
        configSha256: string;
        provenanceSha256: string;
        sourceCommit: string;
        guardSourceCommit: string;
        sourceLineage: IV07ComposedSourceLineage;
        draftLane: string;
        setupLane: string;
    };
    sealedInputs: Record<string, IV07SealedInputReference>;
    artifacts: {
        draft: Omit<IV07LoadedDraftCandidate, "genome" | "intrinsic"> & { intrinsicSha256: string };
        setup: Omit<IV07LoadedSetupCandidate, "policy">;
    };
    candidate: {
        draftFingerprint: string;
        setupFingerprint: string;
        composedFingerprint: string;
    };
    baseline: {
        draftSpec: typeof LEAGUE_ROUND1_DRAFT_SPEC;
        draftFingerprint: string;
        setupPolicyId: string;
        setupFingerprint: string;
        composedFingerprint: string;
    };
    seedLedger: { path: "seed-ledger.json"; ledgerSha256: string; bytesSha256: string };
    seedPlan: { path: "seed-plan.checkpoint.json"; checkpointSha256: string; bytesSha256: string };
    runtime: IV07ComposedRuntimeEnvelope;
    provenance: IV07ComposedProvenance;
    qualification: string;
    manifestSha256: string;
}

type CheckpointPhase =
    | "natural"
    | "natural-baseline-control"
    | "targeted"
    | "symmetry-final"
    | "symmetry-old"
    | "replay-first"
    | "replay-second"
    | "complete";

const CHECKPOINT_PHASES = [
    "natural",
    "natural-baseline-control",
    "targeted",
    "symmetry-final",
    "symmetry-old",
    "replay-first",
    "replay-second",
] as const satisfies readonly Exclude<CheckpointPhase, "complete">[];

interface IV07ComposedCheckpoint {
    schemaVersion: 1;
    status: "running" | "complete";
    manifestSha256: string;
    phase: CheckpointPhase;
    clusters: IV07ComposedCluster[];
    naturalBaselineControl: IV07ComposedCluster[];
    replaySecond: IV07ComposedCluster[];
    updatedAt: string;
    completedAt?: string;
    checkpointSha256: string;
}

interface IV07ComposedWorkerData {
    v07ComposedNonfightGuardWorker: true;
    candidate: IV07ComposedArm;
    baseline: IV07ComposedArm;
    environmentSha256: string;
    runtimeControlsSha256: string;
}

type WorkerRequest =
    | { type: "job"; board: IV07ComposedSeedBoard }
    | { type: "inspect"; board: IV07ComposedSeedBoard }
    | { type: "stop" };
type WorkerReply =
    | {
          type: "ready";
          attestation: { environmentSha256: string; runtimeControlsSha256: string; execArgv: string[] };
      }
    | { type: "result"; cluster: IV07ComposedCluster }
    | { type: "inspection"; board: IV07ComposedSeedBoard; cohorts: V07ComposedNonfightCohort[] }
    | { type: "error"; error: string };

function gitText(args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: PACKAGE_ROOT, encoding: "utf8" }).trim();
}

function captureProvenance(runtime: IV07ComposedRuntimeEnvelope): IV07ComposedProvenance {
    const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
    const unsigned = {
        commit: gitText(["rev-parse", "HEAD"]),
        tree: gitText(["rev-parse", "HEAD^{tree}"]),
        branch: gitText(["branch", "--show-current"]),
        originMain: gitText(["rev-parse", "origin/main"]),
        statusPorcelainSha256: sha256Bytes(status),
        cleanIncludingUntracked: status.length === 0,
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        bunRevision: Bun.revision,
        bunExecutableSha256: runtime.bunExecutableSha256,
        runtimeEnvelopeSha256: fingerprintRankedDraftArtifact(runtime),
    };
    return { ...unsigned, provenanceSha256: fingerprintRankedDraftArtifact(unsigned) };
}

function assertLaunchableProvenance(provenance: IV07ComposedProvenance): void {
    const { provenanceSha256, ...unsigned } = provenance;
    if (provenanceSha256 !== fingerprintRankedDraftArtifact(unsigned)) throw new Error("provenance self-hash mismatch");
    if (provenance.branch !== "main") throw new Error(`composed guard must run on main, found ${provenance.branch}`);
    if (provenance.commit !== provenance.originMain) {
        throw new Error("composed guard HEAD must equal origin/main");
    }
    if (!provenance.cleanIncludingUntracked) {
        throw new Error("composed guard source checkout must be clean including untracked files");
    }
}

export function assertV07ComposedGuardDescendantPaths(changedPaths: readonly string[]): void {
    const allowed = new Set<string>(V07_COMPOSED_GUARD_ALLOWED_DESCENDANT_PATHS);
    if (new Set(changedPaths).size !== changedPaths.length) {
        throw new Error("campaign-to-guard diff contains duplicate paths");
    }
    const disallowed = changedPaths.filter(
        (path) => path.includes("\0") || path.startsWith("/") || path.includes("\\") || !allowed.has(path),
    );
    if (disallowed.length) {
        throw new Error(`campaign-to-guard diff changes non-allowlisted paths: ${disallowed.join(", ")}`);
    }
    for (const required of [
        "src/simulation/optimizer/v0_7_composed_nonfight_guard.ts",
        "src/simulation/optimizer/v0_7_composed_nonfight_guard_worker.ts",
    ]) {
        if (!changedPaths.includes(required)) {
            throw new Error(`campaign-to-guard diff omitted required harness path ${required}`);
        }
    }
}

function captureSourceLineage(
    options: IV07ComposedGuardOptions,
    provenance: IV07ComposedProvenance,
): IV07ComposedSourceLineage {
    if (provenance.commit !== options.guardSourceCommit || provenance.originMain !== options.guardSourceCommit) {
        throw new Error("clean pushed guard source does not match --guard-source-commit");
    }
    if (options.campaignSourceCommit === options.guardSourceCommit) {
        throw new Error("guard source commit must be a controlled descendant of the completed campaign commit");
    }
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", options.campaignSourceCommit, options.guardSourceCommit], {
            cwd: PACKAGE_ROOT,
            stdio: "ignore",
        });
    } catch {
        throw new Error("completed campaign source commit is not an ancestor of the guard source commit");
    }
    const nameBytes = execFileSync(
        "git",
        [
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            `${options.campaignSourceCommit}..${options.guardSourceCommit}`,
            "--",
        ],
        { cwd: PACKAGE_ROOT },
    );
    const changedPaths = nameBytes.toString("utf8").split("\0").filter(Boolean).sort();
    assertV07ComposedGuardDescendantPaths(changedPaths);
    const diffBytes = execFileSync(
        "git",
        [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            `${options.campaignSourceCommit}..${options.guardSourceCommit}`,
            "--",
        ],
        { cwd: PACKAGE_ROOT },
    );
    const unsigned = {
        campaignSourceCommit: options.campaignSourceCommit,
        guardSourceCommit: options.guardSourceCommit,
        campaignIsAncestor: true as const,
        allowedDescendantPaths: [...V07_COMPOSED_GUARD_ALLOWED_DESCENDANT_PATHS],
        changedPaths,
        diffSha256: sha256Bytes(diffBytes),
    };
    return { ...unsigned, lineageSha256: fingerprintRankedDraftArtifact(unsigned) };
}

function jsonContent(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function immutableJson(path: string, value: unknown): void {
    const content = jsonContent(value);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}`;
    try {
        try {
            unlinkSync(temporary);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        writeFileSync(temporary, content, { flag: "wx" });
        try {
            linkSync(temporary, path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const metadata = lstatSync(path);
            if (!metadata.isFile() || metadata.isSymbolicLink()) {
                throw new Error(`immutable artifact path is not a regular non-symlink file at ${path}`);
            }
            if (readFileSync(path, "utf8") !== content) throw new Error(`immutable artifact conflicts at ${path}`);
        }
    } finally {
        try {
            unlinkSync(temporary);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    if (readFileSync(path, "utf8") !== content) throw new Error(`immutable artifact was not published at ${path}`);
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}`;
    writeFileSync(temporary, jsonContent(value));
    renameSync(temporary, path);
}

function parseJson<T>(path: string, label: string): T {
    try {
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new Error(`${label} must be a regular non-symlink file`);
        }
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
        throw new Error(`${label} is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

interface IV07ComposedLockOwner {
    schemaVersion: 1;
    token: string;
    pid: number;
    hostname: string;
    processStartIdentity: string;
    createdAtMs: number;
    ownerSha256: string;
}

export interface IV07ComposedOutputLock {
    directory: string;
    owner: IV07ComposedLockOwner;
}

function processStartIdentity(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    if (process.platform === "linux") {
        try {
            const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
            const close = stat.lastIndexOf(")");
            if (!/^[0-9a-f-]{36}$/.test(bootId) || !stat.startsWith(`${pid} (`) || close < 0) return null;
            const fields = stat
                .slice(close + 1)
                .trim()
                .split(/\s+/);
            const startTicks = fields[19];
            if (!/^\d+$/.test(startTicks ?? "")) return null;
            return `linux:${bootId}:${startTicks}`;
        } catch (error) {
            if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
            throw error;
        }
    }
    try {
        const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return started ? `${process.platform}:${started}` : null;
    } catch {
        return null;
    }
}

type ProcessProbe = "dead" | "live_or_unknown";

function probeProcess(pid: number): ProcessProbe {
    try {
        process.kill(pid, 0);
        return "live_or_unknown";
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "live_or_unknown";
    }
}

export function v07ComposedLockOwnerCanBeReclaimed(
    recordedIdentity: string,
    observedIdentity: string | null,
    processProbe: ProcessProbe,
): boolean {
    if (observedIdentity !== null) return observedIdentity !== recordedIdentity;
    return processProbe === "dead";
}

function validLockOwner(value: unknown): value is IV07ComposedLockOwner {
    if (!isRecord(value)) return false;
    const { ownerSha256, ...unsigned } = value;
    return (
        value.schemaVersion === 1 &&
        typeof value.token === "string" &&
        value.token.length > 0 &&
        Number.isSafeInteger(value.pid) &&
        (value.pid as number) > 0 &&
        typeof value.hostname === "string" &&
        typeof value.processStartIdentity === "string" &&
        Number.isSafeInteger(value.createdAtMs) &&
        typeof ownerSha256 === "string" &&
        ownerSha256 === fingerprintRankedDraftArtifact(unsigned)
    );
}

export function acquireV07ComposedOutputLock(outputDirectory: string): IV07ComposedOutputLock {
    mkdirSync(outputDirectory, { recursive: true });
    const directory = join(outputDirectory, COMPOSED_LOCK_DIRECTORY);
    const identity = processStartIdentity(process.pid);
    if (!identity) throw new Error("cannot establish the composed guard process start identity");
    const ownerUnsigned = {
        schemaVersion: 1 as const,
        token: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        processStartIdentity: identity,
        createdAtMs: Date.now(),
    };
    const owner: IV07ComposedLockOwner = {
        ...ownerUnsigned,
        ownerSha256: fingerprintRankedDraftArtifact(ownerUnsigned),
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const staging = `${directory}.acquire.${owner.token}.${attempt}`;
        mkdirSync(staging, { mode: 0o700 });
        try {
            writeFileSync(join(staging, "owner.json"), jsonContent(owner), { flag: "wx", mode: 0o600 });
            try {
                renameSync(staging, directory);
                return { directory, owner };
            } catch (error) {
                if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
            }
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }
        let existing: unknown;
        try {
            existing = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as unknown;
        } catch {
            throw new Error("composed output lock has no valid atomic owner record; refusing unsafe reclamation");
        }
        if (!validLockOwner(existing)) {
            throw new Error("composed output lock owner is invalid; refusing unsafe reclamation");
        }
        if (existing.hostname !== owner.hostname) {
            throw new Error(`composed output is locked by ${existing.hostname}:${existing.pid}`);
        }
        const observedIdentity = processStartIdentity(existing.pid);
        if (observedIdentity === existing.processStartIdentity) {
            throw new Error(`composed output is already locked by live process ${existing.pid}`);
        }
        const processProbe = observedIdentity === null ? probeProcess(existing.pid) : "live_or_unknown";
        if (!v07ComposedLockOwnerCanBeReclaimed(existing.processStartIdentity, observedIdentity, processProbe)) {
            throw new Error(`cannot prove composed output owner ${existing.pid} is stale; refusing unsafe reclamation`);
        }
        renameSync(directory, `${directory}.stale.${Date.now()}.${randomUUID()}`);
    }
    throw new Error("unable to acquire composed output lock after safe stale-owner reclamation");
}

export function releaseV07ComposedOutputLock(lock: IV07ComposedOutputLock): void {
    try {
        const current = JSON.parse(readFileSync(join(lock.directory, "owner.json"), "utf8")) as unknown;
        if (
            validLockOwner(current) &&
            current.token === lock.owner.token &&
            current.processStartIdentity === lock.owner.processStartIdentity
        ) {
            rmSync(lock.directory, { recursive: true });
        }
    } catch {
        // Never remove ownership that cannot be proven to be ours.
    }
}

function immutableText(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || readFileSync(path, "utf8") !== content) {
            throw new Error(`immutable input conflicts at ${path}`);
        }
        return;
    }
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, content, { flag: "wx", mode: 0o440 });
    try {
        linkSync(temporary, path);
    } finally {
        unlinkSync(temporary);
    }
    if (readFileSync(path, "utf8") !== content) throw new Error(`immutable input was not sealed at ${path}`);
}

function unsignedWithout(value: Record<string, unknown>, key: string): Record<string, unknown> {
    const unsigned = { ...value };
    delete unsigned[key];
    return unsigned;
}

function assertExpectedSha256(value: string, expected: string, label: string): void {
    if (!SHA256_PATTERN.test(expected)) throw new Error(`${label} expected hash must be lowercase SHA-256`);
    if (value !== expected) throw new Error(`${label} hash ${value} does not match expected ${expected}`);
}

function commandRuns(lane: IV07NonfightCampaignRenderedLane, sourceName: string): boolean {
    return lane.command.some((argument) => argument.replaceAll("\\", "/").endsWith(`/${sourceName}`));
}

function commandOption(lane: IV07NonfightCampaignRenderedLane, name: string): string | undefined {
    const inline = lane.command.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = lane.command.indexOf(name);
    return index >= 0 ? lane.command[index + 1] : undefined;
}

function oneCampaignLane(
    lanes: readonly IV07NonfightCampaignRenderedLane[],
    sourceName: string,
): IV07NonfightCampaignRenderedLane {
    const matched = lanes.filter((lane) => commandRuns(lane, sourceName));
    if (matched.length !== 1) throw new Error(`campaign must contain exactly one ${sourceName} lane`);
    return matched[0];
}

function withinDirectory(root: string, path: string): boolean {
    const relation = relative(root, path);
    return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !relation.startsWith(sep));
}

function referencedArtifact(root: string, pathValue: unknown, label: string): ReturnType<typeof readRegularArtifact> {
    const relativePath = requireString(pathValue, label);
    if (relativePath.includes("\0") || resolve(relativePath) === relativePath) {
        throw new Error(`${label} must be a relative path`);
    }
    const canonicalRoot = realpathSync(root);
    const source = readRegularArtifact(resolve(canonicalRoot, relativePath), label);
    if (!withinDirectory(canonicalRoot, source.path)) throw new Error(`${label} escapes its campaign lane output`);
    return source;
}

function finiteNumber(value: unknown, label: string, minimum = -Infinity, maximum = Infinity): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new TypeError(`${label} must be a finite number in [${minimum}, ${maximum}]`);
    }
    return value;
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new TypeError(`${label} must be a safe integer in [${minimum}, ${maximum}]`);
    }
    return value as number;
}

function validateDraftSummary(value: unknown, label: string, expectedGames?: number): Record<string, unknown> {
    const summary = requireRecord(value, label);
    const games = safeInteger(summary.games, `${label}.games`, 1);
    if (expectedGames !== undefined && games !== expectedGames) {
        throw new Error(`${label}.games differs from its fixed panel`);
    }
    const offerBoards = safeInteger(summary.offerBoards, `${label}.offerBoards`, 1);
    const wins = safeInteger(summary.wins, `${label}.wins`);
    const losses = safeInteger(summary.losses, `${label}.losses`);
    const draws = safeInteger(summary.draws, `${label}.draws`);
    const decisiveGames = safeInteger(summary.decisiveGames, `${label}.decisiveGames`);
    const decisiveWinRate = finiteNumber(summary.decisiveWinRate, `${label}.decisiveWinRate`, 0, 1);
    const confidence = requireRecord(summary.confidence95, `${label}.confidence95`);
    const low = finiteNumber(confidence.low, `${label}.confidence95.low`, 0, 1);
    const high = finiteNumber(confidence.high, `${label}.confidence95.high`, 0, 1);
    if (
        wins + losses + draws !== games ||
        wins + losses !== decisiveGames ||
        offerBoards * 4 !== games ||
        (decisiveGames ? decisiveWinRate !== wins / decisiveGames : decisiveWinRate !== 0.5) ||
        low > high ||
        summary.clusteredLowerBound !== low
    ) {
        throw new Error(`${label} counters or clustered confidence are inconsistent`);
    }
    finiteNumber(summary.drawOrArmageddonRate, `${label}.drawOrArmageddonRate`, 0, 1);
    safeInteger(summary.rejectedCandidate, `${label}.rejectedCandidate`);
    safeInteger(summary.rejectedOpponent, `${label}.rejectedOpponent`);
    finiteNumber(summary.avgLaps, `${label}.avgLaps`, 0);
    const endReasons = requireRecord(summary.endReasons, `${label}.endReasons`);
    const endReasonTotal = ["elimination", "turn_cap", "stuck"].reduce(
        (sum, reason) => sum + safeInteger(endReasons[reason], `${label}.endReasons.${reason}`),
        0,
    );
    if (endReasonTotal !== games) throw new Error(`${label} end reasons do not sum to games`);
    return summary;
}

function validateDraftEvaluationReport(
    value: unknown,
    label: string,
    expectedCandidateId: string,
    panelValue: unknown,
): IRankedDraftEvaluationReport {
    const report = requireRecord(value, label);
    const panel = requireRecord(panelValue, `${label} panel`);
    const options = requireRecord(report.options, `${label}.options`);
    const gamesPerOpponent = safeInteger(options.gamesPerOpponent, `${label}.options.gamesPerOpponent`, 8_000);
    const baseSeed = safeInteger(options.baseSeed, `${label}.options.baseSeed`, 0, 0xffff_ffff);
    if (
        report.schemaVersion !== 1 ||
        report.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        report.candidateId !== expectedCandidateId ||
        gamesPerOpponent % 4 !== 0 ||
        safeInteger(options.concurrency, `${label}.options.concurrency`, 1) < 1 ||
        options.fightVersion !== "v0.7" ||
        options.maxLaps !== V07_COMPOSED_RUNTIME_CONTROLS.maxLaps ||
        JSON.stringify(options.mapTypes) !== JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES) ||
        options.setupRules !== "all" ||
        fingerprintRankedDraftArtifact(options.draftDimensions) !==
            fingerprintRankedDraftArtifact({ offset: 0, length: 15 }) ||
        options.clusterSize !== 4 ||
        options.seedAllocation !== "indexed-bijective-v1" ||
        options.seedChannelsPerBoard !== 3 ||
        options.commonBattleSeed !== true ||
        options.behaviorTrace !== "canonical-sha256-v1" ||
        options.executedActionsRecorded !== true ||
        panel.gamesPerOpponent !== gamesPerOpponent ||
        panel.baseSeed !== baseSeed ||
        JSON.stringify(panel.mapTypes) !== JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES)
    ) {
        throw new Error(`${label} shape, options, or fixed panel contract is invalid`);
    }
    requireString(panel.purpose, `${label} panel.purpose`);
    const endSeedExclusive = safeInteger(panel.endSeedExclusive, `${label} panel.endSeedExclusive`, 1, 0x1_0000_0000);
    const seedChannels = safeInteger(panel.seedChannels, `${label} panel.seedChannels`, 1);
    if (endSeedExclusive - baseSeed !== seedChannels) throw new Error(`${label} panel seed range is inconsistent`);
    if (!Array.isArray(report.opponents) || report.opponents.length < 1) {
        throw new Error(`${label}.opponents must be a non-empty array`);
    }
    const opponentIds = new Set<string>();
    let opponentRejectedCandidate = 0;
    let opponentRejectedOpponent = 0;
    for (const [index, value] of report.opponents.entries()) {
        const summary = validateDraftSummary(value, `${label}.opponents[${index}]`, gamesPerOpponent);
        const opponentId = requireString(summary.opponentId, `${label}.opponents[${index}].opponentId`);
        if (opponentIds.has(opponentId)) throw new Error(`${label} repeats opponent ${opponentId}`);
        opponentIds.add(opponentId);
        opponentRejectedCandidate += summary.rejectedCandidate as number;
        opponentRejectedOpponent += summary.rejectedOpponent as number;
    }
    const totalGames = safeInteger(report.totalGames, `${label}.totalGames`, 1);
    if (
        totalGames !== gamesPerOpponent * opponentIds.size ||
        seedChannels !== (gamesPerOpponent / 4) * opponentIds.size * 3 ||
        !opponentIds.has(RANKED_DRAFT_CURRENT_INCUMBENT_ID)
    ) {
        throw new Error(`${label} opponent panel totals are inconsistent`);
    }
    if (!Array.isArray(report.maps) || report.maps.length !== RANKED_DRAFT_LIVE_MAP_TYPES.length) {
        throw new Error(`${label}.maps does not contain the exact live map panel`);
    }
    let mapGames = 0;
    for (const [index, mapType] of RANKED_DRAFT_LIVE_MAP_TYPES.entries()) {
        const summary = validateDraftSummary(report.maps[index], `${label}.maps[${index}]`);
        if (summary.mapType !== mapType) throw new Error(`${label}.maps order or type changed`);
        mapGames += summary.games as number;
    }
    if (mapGames !== totalGames) throw new Error(`${label} map games do not sum to totalGames`);
    if (
        fingerprintRankedDraftArtifact(report.cohortDefinitions) !==
        fingerprintRankedDraftArtifact(RANKED_DRAFT_COHORT_DEFINITIONS)
    ) {
        throw new Error(`${label} cohort definitions changed`);
    }
    if (!Array.isArray(report.cohorts) || report.cohorts.length !== DRAFT_TARGETED_COHORTS.length) {
        throw new Error(`${label}.cohorts must contain each named cohort exactly once`);
    }
    for (const [index, cohort] of DRAFT_TARGETED_COHORTS.entries()) {
        const summary = requireRecord(report.cohorts[index], `${label}.cohorts[${index}]`);
        const games = safeInteger(summary.games, `${label}.cohorts[${index}].games`);
        const wins = safeInteger(summary.wins, `${label}.cohorts[${index}].wins`);
        const losses = safeInteger(summary.losses, `${label}.cohorts[${index}].losses`);
        const draws = safeInteger(summary.draws, `${label}.cohorts[${index}].draws`);
        const decisiveGames = safeInteger(summary.decisiveGames, `${label}.cohorts[${index}].decisiveGames`);
        if (
            summary.cohort !== cohort ||
            wins + losses + draws !== games ||
            wins + losses !== decisiveGames ||
            summary.decisiveWinRate !== (decisiveGames ? wins / decisiveGames : 0.5)
        ) {
            throw new Error(`${label}.cohorts[${index}] counters are inconsistent`);
        }
        if (summary.confidence95 !== null) {
            const confidence = requireRecord(summary.confidence95, `${label}.cohorts[${index}].confidence95`);
            const low = finiteNumber(confidence.low, `${label}.cohorts[${index}].confidence95.low`, 0, 1);
            const high = finiteNumber(confidence.high, `${label}.cohorts[${index}].confidence95.high`, 0, 1);
            if (low > high) throw new Error(`${label}.cohorts[${index}] confidence is inverted`);
        }
    }
    const aggregate = requireRecord(report.aggregate, `${label}.aggregate`);
    finiteNumber(aggregate.fitness, `${label}.aggregate.fitness`);
    finiteNumber(aggregate.worstCaseLowerBound, `${label}.aggregate.worstCaseLowerBound`, 0, 1);
    if (!opponentIds.has(requireString(aggregate.worstCaseOpponent, `${label}.aggregate.worstCaseOpponent`))) {
        throw new Error(`${label}.aggregate.worstCaseOpponent is outside its panel`);
    }
    if (
        aggregate.rejectedCandidate !== opponentRejectedCandidate ||
        aggregate.rejectedOpponent !== opponentRejectedOpponent ||
        !SHA256_PATTERN.test(String(aggregate.behaviorTraceSetSha256))
    ) {
        throw new Error(`${label}.aggregate rejection or trace evidence is inconsistent`);
    }
    finiteNumber(aggregate.drawOrArmageddonRate, `${label}.aggregate.drawOrArmageddonRate`, 0, 1);
    finiteNumber(aggregate.avgLaps, `${label}.aggregate.avgLaps`, 0);
    const aggregateEndReasons = requireRecord(aggregate.endReasons, `${label}.aggregate.endReasons`);
    if (
        ["elimination", "turn_cap", "stuck"].reduce(
            (sum, reason) => sum + safeInteger(aggregateEndReasons[reason], `${label}.aggregate.endReasons.${reason}`),
            0,
        ) !== totalGames
    ) {
        throw new Error(`${label}.aggregate end reasons do not sum to totalGames`);
    }
    requireString(report.qualification, `${label}.qualification`);
    return report as unknown as IRankedDraftEvaluationReport;
}

function validateDraftReferenceEnvelope(
    source: ReturnType<typeof readRegularArtifact>,
    runFingerprint: string,
    candidateFingerprint: string,
    purpose: "final_guard_candidate" | "final_guard_incumbent",
    expectedCandidateId: string,
): IRankedDraftEvaluationReport {
    const root = requireRecord(source.parsed, purpose);
    if (
        root.schemaVersion !== 1 ||
        root.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        root.runFingerprint !== runFingerprint ||
        root.candidateFingerprint !== candidateFingerprint ||
        root.purpose !== purpose ||
        root.artifactSha256 !== fingerprintRankedDraftArtifact(unsignedWithout(root, "artifactSha256"))
    ) {
        throw new Error(`${purpose} report failed its signed identity contract`);
    }
    return validateDraftEvaluationReport(root.report, `${purpose} report`, expectedCandidateId, root.panel);
}

interface IValidatedDraftCohortScanCell {
    cohort: RankedDraftCohort;
    opponentIndex: number;
    opponentId: string;
    seedLaneIndex: number;
    scannedOfferBoards: number;
    acceptedOfferBoards: number[];
    exhausted: boolean;
}

interface IValidatedDraftCohortScan {
    root: Record<string, unknown>;
    panel: Record<string, unknown>;
    cells: IValidatedDraftCohortScanCell[];
    opponentCount: number;
}

function validateDraftCohortScan(
    root: Record<string, unknown>,
    runFingerprint: string,
    candidateFingerprint: string,
    expectedManifestSha256: unknown,
    draftOptions: Record<string, unknown>,
): IValidatedDraftCohortScan {
    if (
        root.schemaVersion !== 1 ||
        root.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        root.runFingerprint !== runFingerprint ||
        root.candidateFingerprint !== candidateFingerprint ||
        root.selectionRule !== "candidate_pick_roster_only_no_fight_outcomes" ||
        root.manifestSha256 !== fingerprintRankedDraftArtifact(unsignedWithout(root, "manifestSha256")) ||
        root.manifestSha256 !== expectedManifestSha256 ||
        fingerprintRankedDraftArtifact(root.cohortDefinitions) !==
            fingerprintRankedDraftArtifact(RANKED_DRAFT_COHORT_DEFINITIONS)
    ) {
        throw new Error("draft cohort scan manifest failed signed identity validation");
    }
    const panel = requireRecord(root.panel, "draft cohort scan panel");
    const requiredBoardsPerOpponent = safeInteger(
        panel.requiredBoardsPerOpponent,
        "draft cohort scan panel.requiredBoardsPerOpponent",
        625,
    );
    const scanMaxBoardsPerCell = safeInteger(
        panel.scanMaxBoardsPerCell,
        "draft cohort scan panel.scanMaxBoardsPerCell",
        1_000_000,
    );
    const baseSeed = safeInteger(panel.baseSeed, "draft cohort scan panel.baseSeed", 0, 0xffff_ffff);
    const endSeedExclusive = safeInteger(
        panel.endSeedExclusive,
        "draft cohort scan panel.endSeedExclusive",
        1,
        0x1_0000_0000,
    );
    const seedChannels = safeInteger(panel.seedChannels, "draft cohort scan panel.seedChannels", 1);
    requireString(panel.purpose, "draft cohort scan panel.purpose");
    if (
        requiredBoardsPerOpponent !== draftOptions.cohortBoardsPerOpponent ||
        scanMaxBoardsPerCell !== draftOptions.cohortScanMaxBoards ||
        JSON.stringify(panel.mapTypes) !== JSON.stringify(RANKED_DRAFT_LIVE_MAP_TYPES) ||
        endSeedExclusive - baseSeed !== seedChannels ||
        !Array.isArray(root.cells) ||
        root.cells.length < DRAFT_TARGETED_COHORTS.length ||
        root.cells.length % DRAFT_TARGETED_COHORTS.length !== 0
    ) {
        throw new Error("draft cohort scan panel is not the completed production protocol");
    }
    const opponentCount = root.cells.length / DRAFT_TARGETED_COHORTS.length;
    if (seedChannels !== scanMaxBoardsPerCell * opponentCount * DRAFT_TARGETED_COHORTS.length * 3) {
        throw new Error("draft cohort scan seed range does not cover its declared cells");
    }
    const cells: IValidatedDraftCohortScanCell[] = [];
    const opponentIds: string[] = [];
    for (const [cohortIndex, cohort] of DRAFT_TARGETED_COHORTS.entries()) {
        const cohortCells = (root.cells as unknown[])
            .map((value) => requireRecord(value, `draft cohort scan ${cohort} cell`))
            .filter((cell) => cell.cohort === cohort)
            .sort((left, right) => Number(left.opponentIndex) - Number(right.opponentIndex));
        if (cohortCells.length !== opponentCount) throw new Error(`draft cohort scan ${cohort} cell count changed`);
        for (let opponentIndex = 0; opponentIndex < opponentCount; opponentIndex += 1) {
            const cell = cohortCells[opponentIndex];
            const opponentId = requireString(
                cell.opponentId,
                `draft cohort scan ${cohort}[${opponentIndex}].opponentId`,
            );
            const scannedOfferBoards = safeInteger(
                cell.scannedOfferBoards,
                `draft cohort scan ${cohort}[${opponentIndex}].scannedOfferBoards`,
                1,
                scanMaxBoardsPerCell,
            );
            if (!Array.isArray(cell.acceptedOfferBoards)) {
                throw new Error(`draft cohort scan ${cohort}[${opponentIndex}] accepted boards are absent`);
            }
            const acceptedOfferBoards = cell.acceptedOfferBoards.map((value, index) =>
                safeInteger(
                    value,
                    `draft cohort scan ${cohort}[${opponentIndex}].acceptedOfferBoards[${index}]`,
                    0,
                    scannedOfferBoards - 1,
                ),
            );
            if (
                cell.opponentIndex !== opponentIndex ||
                cell.seedLaneIndex !== cohortIndex * opponentCount + opponentIndex ||
                acceptedOfferBoards.length > requiredBoardsPerOpponent ||
                new Set(acceptedOfferBoards).size !== acceptedOfferBoards.length ||
                acceptedOfferBoards.some((value, index) => index > 0 && value <= acceptedOfferBoards[index - 1]) ||
                cell.exhausted !== acceptedOfferBoards.length < requiredBoardsPerOpponent ||
                (cohortIndex > 0 && opponentIds[opponentIndex] !== opponentId)
            ) {
                throw new Error(`draft cohort scan ${cohort}[${opponentIndex}] is malformed or not frozen`);
            }
            if (cohortIndex === 0) opponentIds.push(opponentId);
            cells.push({
                cohort,
                opponentIndex,
                opponentId,
                seedLaneIndex: cell.seedLaneIndex as number,
                scannedOfferBoards,
                acceptedOfferBoards,
                exhausted: cell.exhausted as boolean,
            });
        }
    }
    if (new Set(opponentIds).size !== opponentIds.length) throw new Error("draft cohort scan repeats opponent IDs");
    const expectedTasks = cells.flatMap((cell) =>
        cell.acceptedOfferBoards.flatMap((offerBoard) =>
            [0, 1, 2, 3].map((offset) => ({
                opponentIndex: cell.opponentIndex,
                seedLaneIndex: cell.seedLaneIndex,
                game: offerBoard * 4 + offset,
            })),
        ),
    );
    if (fingerprintRankedDraftArtifact(root.tasks) !== fingerprintRankedDraftArtifact(expectedTasks)) {
        throw new Error("draft cohort scan tasks do not derive exactly from its accepted offer boards");
    }
    return { root, panel, cells, opponentCount };
}

function validateDraftGameRecord(
    value: unknown,
    label: string,
    cell: IValidatedDraftCohortScanCell,
    panel: Record<string, unknown>,
): IRankedDraftGameRecord {
    const record = requireRecord(value, label);
    const game = safeInteger(record.game, `${label}.game`);
    const offerBoard = safeInteger(record.offerBoard, `${label}.offerBoard`);
    const offset = game % 4;
    const expectedSeats = ["candidate-lower", "candidate-lower", "candidate-upper", "candidate-upper"];
    const expectedMirrors = [0, 1, 0, 1];
    const expectedSides = ["green", "red", "red", "green"];
    const baseSeed = panel.baseSeed as number;
    const boardsPerLane = panel.scanMaxBoardsPerCell as number;
    const firstPreimage = baseSeed + (cell.seedLaneIndex * boardsPerLane + offerBoard) * 3;
    const pairSeed = permuteRankedDraftSeed(firstPreimage);
    const pickSeed = permuteRankedDraftSeed(firstPreimage + 1);
    const battleSeed = permuteRankedDraftSeed(firstPreimage + 2);
    const gridType =
        RANKED_DRAFT_LIVE_MAP_TYPES[(offerBoard + cell.seedLaneIndex) % RANKED_DRAFT_LIVE_MAP_TYPES.length];
    if (!Array.isArray(record.candidateCohorts)) throw new Error(`${label}.candidateCohorts must be an array`);
    const candidateCohorts = record.candidateCohorts.map((cohort) => {
        if (!DRAFT_TARGETED_COHORTS.includes(cohort as RankedDraftCohort)) {
            throw new Error(`${label}.candidateCohorts contains an unknown cohort`);
        }
        return cohort as RankedDraftCohort;
    });
    const expectedResult = record.winner === "draw" ? "draw" : record.winner === record.candidateSide ? "win" : "loss";
    if (
        record.opponentId !== cell.opponentId ||
        game !== offerBoard * 4 + offset ||
        !cell.acceptedOfferBoards.includes(offerBoard) ||
        record.pickSeat !== expectedSeats[offset] ||
        record.battleMirror !== expectedMirrors[offset] ||
        record.candidateSide !== expectedSides[offset] ||
        !["green", "red", "draw"].includes(String(record.winner)) ||
        record.candidateResult !== expectedResult ||
        record.pairSeed !== pairSeed ||
        record.pickSeed !== pickSeed ||
        record.battleSeed !== battleSeed ||
        record.gridType !== gridType ||
        !SHA256_PATTERN.test(String(record.setupFingerprint)) ||
        !SHA256_PATTERN.test(String(record.behaviorTraceSha256)) ||
        new Set(candidateCohorts).size !== candidateCohorts.length ||
        typeof record.decidedByArmageddon !== "boolean" ||
        !["elimination", "turn_cap", "stuck"].includes(String(record.endReason))
    ) {
        throw new Error(`${label} failed paired task, seed, map, or result integrity`);
    }
    safeInteger(record.laps, `${label}.laps`);
    safeInteger(record.collisions, `${label}.collisions`);
    safeInteger(record.rejectedCandidate, `${label}.rejectedCandidate`);
    safeInteger(record.rejectedOpponent, `${label}.rejectedOpponent`);
    return record as unknown as IRankedDraftGameRecord;
}

function validateDraftCohortEvidence(
    source: ReturnType<typeof readRegularArtifact>,
    cohort: RankedDraftCohort,
    runFingerprint: string,
    candidateFingerprint: string,
    scan: IValidatedDraftCohortScan,
): IRankedDraftTargetedCohortInput {
    const root = requireRecord(source.parsed, `draft ${cohort} evidence`);
    if (
        root.schemaVersion !== 1 ||
        root.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        root.runFingerprint !== runFingerprint ||
        root.candidateFingerprint !== candidateFingerprint ||
        root.cohort !== cohort ||
        root.cohortDefinition !== RANKED_DRAFT_COHORT_DEFINITIONS[cohort] ||
        root.scanManifestSha256 !== scan.root.manifestSha256 ||
        !Array.isArray(root.records) ||
        root.recordsSha256 !== sha256Bytes(JSON.stringify(root.records))
    ) {
        throw new Error(`draft ${cohort} targeted evidence failed identity or record hash validation`);
    }
    const cells = scan.cells.filter((cell) => cell.cohort === cohort);
    const cellByOpponent = new Map(cells.map((cell) => [cell.opponentId, cell]));
    const expectedKeys = new Set(
        cells.flatMap((cell) =>
            cell.acceptedOfferBoards.flatMap((offerBoard) =>
                [0, 1, 2, 3].map((offset) => `${cell.opponentId}:${offerBoard * 4 + offset}`),
            ),
        ),
    );
    const seenKeys = new Set<string>();
    const records = root.records.map((value, index) => {
        const raw = requireRecord(value, `draft ${cohort} evidence.records[${index}]`);
        const opponentId = requireString(raw.opponentId, `draft ${cohort} evidence.records[${index}].opponentId`);
        const cell = cellByOpponent.get(opponentId);
        if (!cell) throw new Error(`draft ${cohort} evidence contains unexpected opponent ${opponentId}`);
        const record = validateDraftGameRecord(value, `draft ${cohort} evidence.records[${index}]`, cell, scan.panel);
        const key = `${record.opponentId}:${record.game}`;
        if (!expectedKeys.has(key) || seenKeys.has(key))
            throw new Error(`draft ${cohort} evidence repeats task ${key}`);
        seenKeys.add(key);
        return record;
    });
    if (seenKeys.size !== expectedKeys.size) throw new Error(`draft ${cohort} evidence omitted frozen scan tasks`);
    for (const cell of cells) {
        for (const offerBoard of cell.acceptedOfferBoards) {
            const cluster = records
                .filter((record) => record.opponentId === cell.opponentId && record.offerBoard === offerBoard)
                .sort((left, right) => left.game - right.game);
            if (
                cluster.length !== 4 ||
                !cluster.some((record) => record.candidateCohorts.includes(cohort)) ||
                cluster[0].setupFingerprint !== cluster[1].setupFingerprint ||
                cluster[2].setupFingerprint !== cluster[3].setupFingerprint ||
                cluster[0].collisions !== cluster[1].collisions ||
                cluster[2].collisions !== cluster[3].collisions ||
                JSON.stringify(cluster[0].candidateCohorts) !== JSON.stringify(cluster[1].candidateCohorts) ||
                JSON.stringify(cluster[2].candidateCohorts) !== JSON.stringify(cluster[3].candidateCohorts)
            ) {
                throw new Error(`draft ${cohort} evidence board ${offerBoard} broke paired-roster integrity`);
            }
        }
    }
    return {
        cohort,
        requiredOfferBoards: (scan.panel.requiredBoardsPerOpponent as number) * cells.length,
        scannedOfferBoards: cells.reduce((sum, cell) => sum + cell.scannedOfferBoards, 0),
        exhausted: cells.some((cell) => cell.exhausted),
        records,
    };
}

function validateDraftReplayReferences(
    draftOutput: string,
    summarySource: ReturnType<typeof readRegularArtifact>,
    runFingerprint: string,
    candidateFingerprint: string,
): Array<{ name: string; source: ReturnType<typeof readRegularArtifact> }> {
    const summary = requireRecord(summarySource.parsed, "draft replay summary");
    if (
        summary.schemaVersion !== 1 ||
        summary.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        summary.runFingerprint !== runFingerprint ||
        summary.candidateFingerprint !== candidateFingerprint ||
        summary.byteIdentical !== true ||
        summary.behaviorTraceIdentical !== true
    ) {
        throw new Error("draft replay summary failed identity or deterministic replay gates");
    }
    const replayDirectory = dirname(summarySource.path);
    if (!withinDirectory(realpathSync(draftOutput), replayDirectory))
        throw new Error("draft replay directory escaped lane");
    const first = readRegularArtifact(join(replayDirectory, "first.json"), "draft replay first");
    const second = readRegularArtifact(join(replayDirectory, "second.json"), "draft replay second");
    for (const [label, source] of [
        ["first", first],
        ["second", second],
    ] as const) {
        const run = requireRecord(source.parsed, `draft replay ${label}`);
        const records = run.records;
        const report = run.report;
        if (
            run.schemaVersion !== 1 ||
            run.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
            run.runFingerprint !== runFingerprint ||
            run.candidateFingerprint !== candidateFingerprint ||
            run.label !== label ||
            !Array.isArray(records) ||
            run.recordsSha256 !== sha256Bytes(JSON.stringify(records)) ||
            run.reportSha256 !== sha256Bytes(JSON.stringify(report)) ||
            run.behaviorTraceSetSha256 !==
                rankedDraftBehaviorTraceSetSha256(records as Parameters<typeof rankedDraftBehaviorTraceSetSha256>[0])
        ) {
            throw new Error(`draft replay ${label} failed content hash validation`);
        }
        const declared = requireRecord(summary[label], `draft replay summary.${label}`);
        for (const key of ["recordsSha256", "reportSha256", "behaviorTraceSetSha256"] as const) {
            if (declared[key] !== run[key]) throw new Error(`draft replay summary ${label}.${key} mismatch`);
        }
    }
    if (JSON.stringify(first.parsed) === JSON.stringify(second.parsed)) {
        throw new Error("draft replay labeled artifacts unexpectedly share their label bytes");
    }
    const firstRoot = requireRecord(first.parsed, "draft replay first");
    const secondRoot = requireRecord(second.parsed, "draft replay second");
    if (
        JSON.stringify(firstRoot.records) !== JSON.stringify(secondRoot.records) ||
        JSON.stringify(firstRoot.report) !== JSON.stringify(secondRoot.report)
    ) {
        throw new Error("draft replay evidence is not byte-identical after removing its run label");
    }
    return [
        { name: "draft-replay-first.json", source: first },
        { name: "draft-replay-second.json", source: second },
    ];
}

export function validateV07ComposedCampaignInputs(options: IV07ComposedGuardOptions): IV07ValidatedCampaignInputs {
    const campaignRun = readRegularArtifact(options.campaignRun, "campaign run");
    const campaignTerminal = readRegularArtifact(options.campaignTerminal, "campaign terminal");
    const runRoot = requireRecord(campaignRun.parsed, "campaign run");
    const terminalRoot = requireRecord(campaignTerminal.parsed, "campaign terminal");
    if (
        runRoot.schemaVersion !== 1 ||
        runRoot.artifactKind !== "v0_7_nonfight_campaign_run" ||
        runRoot.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        runRoot.automaticBake !== false ||
        runRoot.automaticDeploy !== false ||
        runRoot.runSha256 !== fingerprintV07NonfightCampaign(unsignedWithout(runRoot, "runSha256"))
    ) {
        throw new Error("campaign run is invalid or its signed identity changed");
    }
    if (
        terminalRoot.schemaVersion !== 1 ||
        terminalRoot.artifactKind !== "v0_7_nonfight_campaign_terminal" ||
        terminalRoot.status !== "complete_research_only" ||
        terminalRoot.automaticBake !== false ||
        terminalRoot.automaticDeploy !== false ||
        terminalRoot.promotionAttempted !== false ||
        terminalRoot.reason !== "lanes_completed" ||
        terminalRoot.signal !== null ||
        !Array.isArray(terminalRoot.hardDeadlineKilledLanes) ||
        terminalRoot.hardDeadlineKilledLanes.length !== 0 ||
        terminalRoot.terminalSha256 !== fingerprintV07NonfightCampaign(unsignedWithout(terminalRoot, "terminalSha256"))
    ) {
        throw new Error("campaign terminal is not a signed all-lanes-complete research terminal");
    }
    const run = runRoot as IV07CampaignRunArtifact;
    const terminal = terminalRoot as IV07CampaignTerminalArtifact;
    if (run.runId !== options.runId || terminal.runId !== options.runId || terminal.runSha256 !== run.runSha256) {
        throw new Error("campaign run/terminal/run-id identities disagree");
    }
    const startAtMs = runRoot.startAtMs;
    const laneDeadlineAtMs = runRoot.laneDeadlineAtMs;
    const hardDeadlineAtMs = runRoot.hardDeadlineAtMs;
    const durationMs = runRoot.durationMs;
    if (
        !Number.isSafeInteger(startAtMs) ||
        !Number.isSafeInteger(laneDeadlineAtMs) ||
        !Number.isSafeInteger(hardDeadlineAtMs) ||
        !Number.isSafeInteger(durationMs) ||
        (startAtMs as number) < 0 ||
        (laneDeadlineAtMs as number) <= (startAtMs as number) ||
        (hardDeadlineAtMs as number) <= (laneDeadlineAtMs as number) ||
        (hardDeadlineAtMs as number) - (startAtMs as number) !== durationMs ||
        terminalRoot.startAtMs !== startAtMs ||
        terminalRoot.laneDeadlineAtMs !== laneDeadlineAtMs ||
        terminalRoot.hardDeadlineAtMs !== hardDeadlineAtMs ||
        !Number.isSafeInteger(terminalRoot.completedAtMs) ||
        (terminalRoot.completedAtMs as number) < (startAtMs as number) ||
        typeof runRoot.hours !== "number" ||
        !Number.isFinite(runRoot.hours) ||
        runRoot.hours <= 0 ||
        !Number.isSafeInteger(runRoot.totalWorkers) ||
        (runRoot.totalWorkers as number) < 2 ||
        !Number.isSafeInteger(runRoot.heartbeatMs) ||
        (runRoot.heartbeatMs as number) < 1 ||
        !Number.isSafeInteger(runRoot.stopGraceMs) ||
        (runRoot.stopGraceMs as number) < 1 ||
        !Number.isSafeInteger(runRoot.laneStopGraceMs) ||
        (runRoot.laneStopGraceMs as number) < 1
    ) {
        throw new Error("campaign run/terminal timing and worker contract is malformed");
    }
    if (options.deadlineMs > (hardDeadlineAtMs as number)) {
        throw new Error("composed guard deadline exceeds the signed campaign hard deadline");
    }
    assertExpectedSha256(run.runSha256, options.campaignRunSha256, "campaign run signed");
    assertExpectedSha256(terminal.terminalSha256, options.campaignTerminalSha256, "campaign terminal signed");
    assertExpectedSha256(run.configSha256, options.campaignConfigSha256, "campaign config");
    if (!isRecord(run.provenance)) throw new Error("campaign run provenance is absent");
    const { provenanceSha256, ...unsignedProvenance } = run.provenance;
    if (
        provenanceSha256 !== fingerprintV07NonfightCampaign(unsignedProvenance) ||
        provenanceSha256 !== options.campaignProvenanceSha256 ||
        run.provenance.commit !== options.campaignSourceCommit ||
        run.provenance.originMain !== options.campaignSourceCommit ||
        run.provenance.branch !== "main" ||
        run.provenance.cleanIncludingUntracked !== true
    ) {
        throw new Error("campaign source provenance does not match the expected clean pushed main commit");
    }
    const outputRoot = realpathSync(run.outputDirectory);
    const campaignRepositoryRoot = realpathSync(run.repositoryRoot);
    if (
        campaignRun.path !== realpathSync(join(outputRoot, "run.json")) ||
        campaignTerminal.path !== realpathSync(join(outputRoot, "TERMINAL.json"))
    ) {
        throw new Error("campaign run and terminal must be the exact artifacts under run.outputDirectory");
    }
    if (!Array.isArray(run.lanes) || run.lanes.length !== 2 || !Array.isArray(terminal.lanes)) {
        throw new Error("campaign run/terminal must contain exactly two lane records");
    }
    const runLaneNames = [...run.lanes.map((lane) => lane.name)].sort();
    const terminalLaneNames = [...terminal.lanes.map((lane) => lane.lane)].sort();
    if (
        JSON.stringify(runLaneNames) !== JSON.stringify(terminalLaneNames) ||
        terminal.lanes.some((lane) => lane.status !== "completed" || lane.exitCode !== 0 || lane.signal !== null)
    ) {
        throw new Error("campaign terminal does not prove successful completion of both rendered lanes");
    }
    const draftLane = oneCampaignLane(run.lanes, "ranked_draft_cem.ts");
    const setupLane = oneCampaignLane(run.lanes, "v0_7_setup_overnight.ts");
    for (const lane of [draftLane, setupLane]) {
        const laneRoot = realpathSync(lane.outputDirectory);
        if (
            laneRoot !== realpathSync(join(outputRoot, "lanes", lane.name, "output")) ||
            realpathSync(lane.cwd) !== campaignRepositoryRoot ||
            commandOption(lane, "--run-id") !== options.runId ||
            realpathSync(resolve(commandOption(lane, "--out") ?? "")) !== laneRoot
        ) {
            throw new Error(
                `campaign lane ${lane.name} command/cwd/output does not match its signed run paths ` +
                    `(output=${laneRoot}, expectedOutput=${join(outputRoot, "lanes", lane.name, "output")}, ` +
                    `cwd=${lane.cwd}, runId=${String(commandOption(lane, "--run-id"))}, ` +
                    `out=${String(commandOption(lane, "--out"))})`,
            );
        }
    }

    const expectedDraftPath = realpathSync(join(realpathSync(draftLane.outputDirectory), "guard", "verdict.json"));
    const expectedSetupPath = realpathSync(join(realpathSync(setupLane.outputDirectory), "final.json"));
    const draftVerdict = readRegularArtifact(options.draftVerdict, "draft verdict");
    const setupFinal = readRegularArtifact(options.setupFinal, "setup final");
    if (draftVerdict.path !== expectedDraftPath || setupFinal.path !== expectedSetupPath) {
        throw new Error("candidate artifacts are not the exact final outputs of their completed campaign lanes");
    }
    assertExpectedSha256(sha256Bytes(draftVerdict.raw), options.draftVerdictSha256, "draft verdict bytes");
    assertExpectedSha256(sha256Bytes(setupFinal.raw), options.setupFinalSha256, "setup final bytes");
    const draft = loadV07ComposedDraftCandidate(draftVerdict.path, options.runId);
    const setup = loadV07ComposedSetupCandidate(setupFinal.path, options.runId);
    if (draft.runFingerprint !== options.draftRunFingerprint) {
        throw new Error("draft verdict runFingerprint differs from --draft-run-fingerprint");
    }

    const draftOutput = realpathSync(draftLane.outputDirectory);
    const draftRun = readRegularArtifact(join(draftOutput, "run.json"), "draft lane run");
    const draftRunRoot = requireRecord(draftRun.parsed, "draft lane run");
    if (
        draftRunRoot.runId !== options.runId ||
        draftRunRoot.runFingerprint !== draft.runFingerprint ||
        draftRunRoot.runFingerprint !== fingerprintRankedDraftArtifact(unsignedWithout(draftRunRoot, "runFingerprint"))
    ) {
        throw new Error("draft lane run artifact does not bind the verdict runFingerprint");
    }
    const draftCode = requireRecord(draftRunRoot.code, "draft lane code provenance");
    const draftOptions = requireRecord(draftRunRoot.options, "draft lane protocol options");
    if (
        draftCode.revision !== options.campaignSourceCommit ||
        draftCode.originMain !== options.campaignSourceCommit ||
        draftCode.branch !== "main" ||
        !Number.isSafeInteger(draftOptions.guardGamesPerOpponent) ||
        (draftOptions.guardGamesPerOpponent as number) < 8_000 ||
        !Number.isSafeInteger(draftOptions.cohortBoardsPerOpponent) ||
        (draftOptions.cohortBoardsPerOpponent as number) < 625 ||
        !Number.isSafeInteger(draftOptions.cohortScanMaxBoards) ||
        (draftOptions.cohortScanMaxBoards as number) < 1_000_000 ||
        !Number.isSafeInteger(draftOptions.replayGamesPerOpponent) ||
        (draftOptions.replayGamesPerOpponent as number) < 8 ||
        draftOptions.maxLaps !== V07_COMPOSED_RUNTIME_CONTROLS.maxLaps
    ) {
        throw new Error("draft lane protocol or source provenance is weaker than the production contract");
    }
    const draftState = readRegularArtifact(join(draftOutput, "state.json"), "draft lane state");
    const draftStateRoot = requireRecord(draftState.parsed, "draft lane state");
    const draftStateBest = requireRecord(draftStateRoot.best, "draft lane state.best");
    if (
        draftStateRoot.status !== "complete" ||
        draftStateRoot.runFingerprint !== draft.runFingerprint ||
        draftStateBest.candidateId !== draft.candidateId ||
        draftStateBest.candidateFingerprint !== draft.candidateFingerprint ||
        JSON.stringify(draftStateBest.intrinsic) !== JSON.stringify(draft.intrinsic)
    ) {
        throw new Error("draft final state is inconsistent with the passing verdict candidate");
    }
    const draftVerdictRoot = requireRecord(draftVerdict.parsed, "draft verdict");
    const draftCandidateRoot = requireRecord(draftVerdictRoot.candidate, "draft verdict candidate");
    const draftIncumbentRoot = requireRecord(draftVerdictRoot.incumbent, "draft verdict incumbent");
    const draftCohortScan = requireRecord(draftVerdictRoot.cohortScan, "draft verdict cohortScan");
    const draftReplay = requireRecord(draftVerdictRoot.deterministicReplay, "draft verdict deterministicReplay");
    const candidateReport = referencedArtifact(
        draftOutput,
        draftCandidateRoot.guardReportPath,
        "candidate guard report",
    );
    const incumbentReport = referencedArtifact(
        draftOutput,
        draftIncumbentRoot.guardReportPath,
        "incumbent guard report",
    );
    const candidateEvaluation = validateDraftReferenceEnvelope(
        candidateReport,
        draft.runFingerprint,
        draft.candidateFingerprint,
        "final_guard_candidate",
        draft.candidateId,
    );
    const incumbentCandidateId = requireString(draftIncumbentRoot.candidateId, "draft incumbent candidateId");
    if (incumbentCandidateId !== RANKED_DRAFT_CURRENT_INCUMBENT_ID) {
        throw new Error("draft verdict incumbent is not the current ranked draft incumbent");
    }
    const incumbentEvaluation = validateDraftReferenceEnvelope(
        incumbentReport,
        draft.runFingerprint,
        requireString(draftIncumbentRoot.candidateFingerprint, "draft incumbent fingerprint"),
        "final_guard_incumbent",
        incumbentCandidateId,
    );
    const naturalDecision = evaluateRankedDraftGuard(candidateEvaluation, incumbentEvaluation);
    if (
        !naturalDecision.eligibleForManualReview ||
        fingerprintRankedDraftArtifact(draftVerdictRoot.naturalGuard) !==
            fingerprintRankedDraftArtifact(naturalDecision)
    ) {
        throw new Error("draft natural guard verdict does not recompute from its signed reports");
    }
    const cohortScan = referencedArtifact(draftOutput, draftCohortScan.path, "draft cohort scan manifest");
    const cohortScanRoot = requireRecord(cohortScan.parsed, "draft cohort scan manifest");
    const validatedCohortScan = validateDraftCohortScan(
        cohortScanRoot,
        draft.runFingerprint,
        draft.candidateFingerprint,
        draftCohortScan.manifestSha256,
        draftOptions,
    );
    const cohortEvidence = DRAFT_TARGETED_COHORTS.map((cohort) => ({
        cohort,
        source: readRegularArtifact(join(draftOutput, "guard", "cohorts", `${cohort}.json`), `${cohort} evidence`),
    }));
    const targetedInputs = cohortEvidence.map(({ cohort, source }) =>
        validateDraftCohortEvidence(
            source,
            cohort,
            draft.runFingerprint,
            draft.candidateFingerprint,
            validatedCohortScan,
        ),
    );
    const targetedDecision = evaluateRankedDraftTargetedGuard(targetedInputs);
    if (
        !targetedDecision.eligibleForManualReview ||
        fingerprintRankedDraftArtifact(draftVerdictRoot.targetedCohortGuard) !==
            fingerprintRankedDraftArtifact(targetedDecision)
    ) {
        throw new Error("draft targeted cohort guard verdict does not recompute from fixed signed evidence");
    }
    const replaySummary = referencedArtifact(draftOutput, draftReplay.summaryPath, "draft replay summary");
    const replayReferences = validateDraftReplayReferences(
        draftOutput,
        replaySummary,
        draft.runFingerprint,
        draft.candidateFingerprint,
    );

    const setupOutput = realpathSync(setupLane.outputDirectory);
    const setupCheckpoint = readRegularArtifact(join(setupOutput, "checkpoint.json"), "setup checkpoint");
    assertExpectedSha256(sha256Bytes(setupCheckpoint.raw), options.setupCheckpointSha256, "setup checkpoint bytes");
    const setupCheckpointRoot = requireRecord(setupCheckpoint.parsed, "setup checkpoint");
    const setupConfig = requireRecord(setupCheckpointRoot.config, "setup checkpoint config");
    const setupFinalRoot = requireRecord(setupFinal.parsed, "setup final");
    const setupPanels = requireRecord(setupFinalRoot.panels, "setup final panels");
    const setupGuardPanel = requireRecord(setupPanels.guard, "setup final panels.guard");
    if (
        setupCheckpointRoot.status !== "complete" ||
        setupCheckpointRoot.phase !== "complete" ||
        setupCheckpointRoot.runId !== options.runId ||
        setupCheckpointRoot.completedAt !== setupFinalRoot.completedAt ||
        setupCheckpointRoot.startedAt !== setupFinalRoot.startedAt ||
        fingerprintRankedDraftArtifact(setupCheckpointRoot.incumbent) !==
            fingerprintRankedDraftArtifact(setup.policy) ||
        setupConfig.smoke !== false ||
        setupConfig.out !== setupLane.outputDirectory ||
        !Number.isSafeInteger(setupConfig.guardPairs) ||
        (setupConfig.guardPairs as number) < SETUP_CAMPAIGN_MINIMUM_GUARD_PAIRS ||
        !Number.isSafeInteger(setupConfig.diagnosticGuardPairs) ||
        (setupConfig.diagnosticGuardPairs as number) < SETUP_CAMPAIGN_MINIMUM_DIAGNOSTIC_GUARD_PAIRS ||
        Number(commandOption(setupLane, "--guard-pairs")) !== setupConfig.guardPairs ||
        Number(commandOption(setupLane, "--diagnostic-guard-pairs")) !== setupConfig.diagnosticGuardPairs ||
        !Array.isArray(setupCheckpointRoot.guardPairs) ||
        setupCheckpointRoot.guardPairs.length < (setupConfig.guardPairs as number) ||
        !isRecord(setupCheckpointRoot.diagnosticGuardPairs) ||
        !Array.isArray(setupCheckpointRoot.symmetryControlPairs) ||
        setupCheckpointRoot.symmetryControlPairs.length < 4 ||
        setupGuardPanel.pairs !== setupCheckpointRoot.guardPairs.length
    ) {
        throw new Error("setup final is inconsistent with its completed production checkpoint");
    }
    for (const tag of ["ranged", "mage", "melee-magic", "aura-heavy"] as const) {
        const pairs = setupCheckpointRoot.diagnosticGuardPairs[tag];
        if (!Array.isArray(pairs) || pairs.length < (setupConfig.diagnosticGuardPairs as number)) {
            throw new Error(`setup checkpoint diagnostic ${tag} is below its production contract`);
        }
    }
    const guardPairs = setupCheckpointRoot.guardPairs as ISetupEvaluatedPair[];
    const diagnosticsPairs = setupCheckpointRoot.diagnosticGuardPairs as Record<
        (typeof SETUP_NAMED_GUARD_TAGS)[number],
        ISetupEvaluatedPair[]
    >;
    const symmetryPairs = setupCheckpointRoot.symmetryControlPairs as ISetupEvaluatedPair[];
    const seedOwners = new Map<number, string>();
    for (const [owner, pairs] of [
        ["aggregate", guardPairs],
        ...SETUP_NAMED_GUARD_TAGS.map((tag) => [`diagnostic/${tag}`, diagnosticsPairs[tag]] as const),
        ["symmetry", symmetryPairs],
    ] as const) {
        for (const pair of pairs) {
            if (!Number.isSafeInteger(pair.seed) || pair.seed >>> 30 !== 2) {
                throw new Error(`setup ${owner} contains a seed outside the untouched top-bit-10 guard panel`);
            }
            const prior = seedOwners.get(pair.seed);
            if (prior) throw new Error(`setup guard seed ${pair.seed} is reused by ${prior} and ${owner}`);
            seedOwners.set(pair.seed, owner);
        }
    }
    const aggregateEstimate = pairedSetupEstimate(guardPairs);
    const diagnosticEstimates = Object.fromEntries(
        SETUP_NAMED_GUARD_TAGS.map((tag) => [tag, pairedSetupEstimate(diagnosticsPairs[tag], tag)]),
    ) as Record<(typeof SETUP_NAMED_GUARD_TAGS)[number], ReturnType<typeof pairedSetupEstimate>>;
    const liveMapEstimates = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [gridType, pairedSetupEstimate(guardPairs, "aggregate", gridType)]),
    ) as Record<SetupLiveGridType, ReturnType<typeof pairedSetupEstimate>>;
    const symmetryEstimate = pairedSetupEstimate(symmetryPairs);
    const controlSymmetryPassed =
        symmetryPairs.length >= 4 &&
        symmetryEstimate.wins + symmetryEstimate.losses > 0 &&
        symmetryEstimate.wins === symmetryEstimate.losses &&
        symmetryEstimate.decisiveWinRate === 0.5 &&
        symmetryEstimate.candidateRejections === 0 &&
        symmetryEstimate.baselineRejections === 0;
    const setupReplay = requireRecord(setupCheckpointRoot.replay, "setup checkpoint deterministic replay");
    const expectedReplayPairs = [...guardPairs]
        .sort((left, right) => left.seed - right.seed)
        .slice(0, Number(setupReplay.samplePairs));
    const expectedReplaySeeds = expectedReplayPairs.map((pair) => pair.seed);
    const expectedOriginalReplaySha256 = sha256Bytes(
        JSON.stringify([...expectedReplayPairs].sort((left, right) => left.seed - right.seed)),
    );
    if (
        setupReplay.samplePairs !== 4 ||
        !Array.isArray(setupReplay.seeds) ||
        setupReplay.seeds.length !== setupReplay.samplePairs ||
        new Set(setupReplay.seeds).size !== setupReplay.seeds.length ||
        fingerprintRankedDraftArtifact(setupReplay.seeds) !== fingerprintRankedDraftArtifact(expectedReplaySeeds) ||
        !SHA256_PATTERN.test(String(setupReplay.originalSha256)) ||
        setupReplay.originalSha256 !== expectedOriginalReplaySha256 ||
        setupReplay.originalSha256 !== setupReplay.replaySha256 ||
        setupReplay.byteIdentical !== true
    ) {
        throw new Error("setup deterministic replay is absent, malformed, or not byte-identical");
    }
    const promotable = setupGuardPromotable(
        setup.policy.placementAugmentTiming,
        aggregateEstimate,
        diagnosticEstimates,
        liveMapEstimates,
        true,
        controlSymmetryPassed,
        true,
    );
    const setupDecision = requireRecord(setupFinalRoot.decision, "setup final decision");
    const finalGuard = requireRecord(setupFinalRoot.guard, "setup final guard evidence");
    const finalLiveMaps = requireRecord(setupFinalRoot.liveMapGuard, "setup final live-map evidence");
    const finalControl = requireRecord(setupFinalRoot.controlSymmetry, "setup final control symmetry");
    const expectedGuard = {
        aggregate: aggregateEstimate,
        ...diagnosticEstimates,
    };
    const liveMapLabels: Record<SetupLiveGridType, "NORMAL" | "LAVA_CENTER" | "BLOCK_CENTER"> = {
        [PBTypes.GridVals.NORMAL]: "NORMAL",
        [PBTypes.GridVals.LAVA_CENTER]: "LAVA_CENTER",
        [PBTypes.GridVals.BLOCK_CENTER]: "BLOCK_CENTER",
    };
    const expectedLiveMaps = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [liveMapLabels[gridType], liveMapEstimates[gridType]]),
    );
    if (
        promotable !== true ||
        setupDecision.promotable !== promotable ||
        setupDecision.currentGuardComplete !== true ||
        setupDecision.controlSymmetryPassed !== controlSymmetryPassed ||
        setupDecision.byteIdenticalReplay !== true ||
        fingerprintRankedDraftArtifact(setupDecision.thresholds) !==
            fingerprintRankedDraftArtifact(SETUP_GUARD_THRESHOLDS) ||
        fingerprintRankedDraftArtifact(finalGuard) !== fingerprintRankedDraftArtifact(expectedGuard) ||
        fingerprintRankedDraftArtifact(finalLiveMaps) !== fingerprintRankedDraftArtifact(expectedLiveMaps) ||
        finalControl.targetPairs !== 4 ||
        finalControl.passed !== controlSymmetryPassed ||
        fingerprintRankedDraftArtifact(finalControl.seeds) !==
            fingerprintRankedDraftArtifact(symmetryPairs.map((pair) => pair.seed)) ||
        fingerprintRankedDraftArtifact(finalControl.estimate) !== fingerprintRankedDraftArtifact(symmetryEstimate) ||
        fingerprintRankedDraftArtifact(setupFinalRoot.deterministicReplay) !==
            fingerprintRankedDraftArtifact(setupReplay)
    ) {
        throw new Error("setup final decisions or reported evidence do not recompute from its checkpoint");
    }
    return {
        campaignRun,
        campaignTerminal,
        draftVerdict,
        draftRun,
        draftState,
        draftReferences: [
            { name: "draft-candidate-guard.json", source: candidateReport },
            { name: "draft-incumbent-guard.json", source: incumbentReport },
            { name: "draft-cohort-scan.json", source: cohortScan },
            ...cohortEvidence.map(({ cohort, source }) => ({ name: `draft-cohort-${cohort}.json`, source })),
            { name: "draft-replay-summary.json", source: replaySummary },
            ...replayReferences,
        ],
        setupFinal,
        setupCheckpoint,
        run,
        terminal,
        draftLane,
        setupLane,
        draft,
        setup,
    };
}

function sealCampaignInputs(
    outputDirectory: string,
    validated: IV07ValidatedCampaignInputs,
): Record<string, IV07SealedInputReference> {
    const inputDirectory = join(outputDirectory, "inputs");
    if (existsSync(inputDirectory)) {
        const metadata = lstatSync(inputDirectory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error("composed sealed-input directory must be a real directory, not a symlink");
        }
    } else {
        mkdirSync(inputDirectory, { mode: 0o700 });
    }
    const sources = new Map<string, ReturnType<typeof readRegularArtifact>>([
        ["campaign-run.json", validated.campaignRun],
        ["campaign-terminal.json", validated.campaignTerminal],
        ["draft-verdict.json", validated.draftVerdict],
        ["draft-run.json", validated.draftRun],
        ["draft-state.json", validated.draftState],
        ["setup-final.json", validated.setupFinal],
        ["setup-checkpoint.json", validated.setupCheckpoint],
        ...validated.draftReferences.map(({ name, source }) => [name, source] as const),
    ]);
    return Object.fromEntries(
        [...sources].map(([name, source]) => {
            const relativePath = join("inputs", name);
            immutableText(join(outputDirectory, relativePath), source.raw);
            return [name, { path: relativePath, bytesSha256: sha256Bytes(source.raw) }];
        }),
    );
}

function checkpointWithHash(value: Omit<IV07ComposedCheckpoint, "checkpointSha256">): IV07ComposedCheckpoint {
    return { ...value, checkpointSha256: fingerprintRankedDraftArtifact(value) };
}

function saveCheckpoint(path: string, checkpoint: IV07ComposedCheckpoint): void {
    const unsigned = { ...checkpoint };
    delete (unsigned as Partial<IV07ComposedCheckpoint>).checkpointSha256;
    Object.assign(checkpoint, checkpointWithHash({ ...unsigned, updatedAt: new Date().toISOString() }));
    atomicJson(path, checkpoint);
}

function validateCheckpoint(
    checkpoint: IV07ComposedCheckpoint,
    manifest: IV07ComposedManifest,
    ledger: IV07ComposedSeedLedger,
): void {
    const { checkpointSha256, ...unsigned } = checkpoint;
    if (
        checkpoint.schemaVersion !== 1 ||
        (checkpoint.status !== "running" && checkpoint.status !== "complete") ||
        (checkpoint.phase !== "complete" && !CHECKPOINT_PHASES.includes(checkpoint.phase)) ||
        checkpoint.manifestSha256 !== manifest.manifestSha256 ||
        checkpointSha256 !== fingerprintRankedDraftArtifact(unsigned)
    ) {
        throw new Error("composed checkpoint identity or self-hash mismatch");
    }
    validateV07ComposedClusters(checkpoint.clusters);
    validateV07ComposedClusters(checkpoint.naturalBaselineControl);
    validateV07ComposedClusters(checkpoint.replaySecond);
    const expected = new Map(ledger.boards.map((board) => [board.pairSeed, board]));
    const seen = new Set<number>();
    for (const cluster of checkpoint.clusters) {
        const board = expected.get(cluster.board.pairSeed);
        if (!board || fingerprintRankedDraftArtifact(board) !== fingerprintRankedDraftArtifact(cluster.board)) {
            throw new Error(`checkpoint cluster ${cluster.board.pairSeed} is outside the immutable seed ledger`);
        }
        if (seen.has(cluster.board.pairSeed)) throw new Error(`checkpoint repeats cluster ${cluster.board.pairSeed}`);
        seen.add(cluster.board.pairSeed);
    }
    const replaySeeds = new Set(
        ledger.boards.filter((board) => board.panel === "replay").map((board) => board.pairSeed),
    );
    const replaySecondSeeds = new Set<number>();
    for (const cluster of checkpoint.replaySecond) {
        if (!replaySeeds.has(cluster.board.pairSeed) || replaySecondSeeds.has(cluster.board.pairSeed)) {
            throw new Error(`checkpoint has invalid second replay cluster ${cluster.board.pairSeed}`);
        }
        replaySecondSeeds.add(cluster.board.pairSeed);
    }
    const naturalSeeds = new Set(
        ledger.boards.filter((board) => board.panel === "natural").map((board) => board.pairSeed),
    );
    const naturalControlSeeds = new Set<number>();
    for (const cluster of checkpoint.naturalBaselineControl) {
        if (!naturalSeeds.has(cluster.board.pairSeed) || naturalControlSeeds.has(cluster.board.pairSeed)) {
            throw new Error(`checkpoint has invalid matched natural control cluster ${cluster.board.pairSeed}`);
        }
        naturalControlSeeds.add(cluster.board.pairSeed);
    }
    if (checkpoint.status === "complete" && checkpoint.phase !== "complete") {
        throw new Error("complete checkpoint has a non-complete phase");
    }
    if (checkpoint.phase === "complete" && checkpoint.status !== "complete") {
        throw new Error("complete checkpoint phase has a non-complete status");
    }
    const phaseIndex =
        checkpoint.phase === "complete" ? CHECKPOINT_PHASES.length : CHECKPOINT_PHASES.indexOf(checkpoint.phase);
    for (const [index, phase] of CHECKPOINT_PHASES.entries()) {
        const expectedSeeds = new Set(phaseBoards(ledger, phase).map((board) => board.pairSeed));
        const destination =
            phase === "natural-baseline-control"
                ? checkpoint.naturalBaselineControl
                : phase === "replay-second"
                  ? checkpoint.replaySecond
                  : checkpoint.clusters;
        const actualBoards = destination.filter((cluster) => expectedSeeds.has(cluster.board.pairSeed)).length;
        const shouldBeComplete = phaseIndex > index;
        const isCurrent = phaseIndex === index;
        if (
            (shouldBeComplete && actualBoards !== expectedSeeds.size) ||
            (isCurrent && actualBoards > expectedSeeds.size) ||
            (!shouldBeComplete && !isCurrent && actualBoards !== 0)
        ) {
            throw new Error(`checkpoint phase ${checkpoint.phase} has invalid ${phase} progress`);
        }
    }
    if (checkpoint.status === "complete" && !checkpoint.completedAt) {
        throw new Error("complete checkpoint omitted completedAt");
    }
}

function baselineArm(): IV07ComposedArm {
    return {
        id: "round1-conditional-v1",
        genome: projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC)),
        policy: shippedNonFightPolicy("round1-conditional-v1"),
    };
}

function candidateArm(draft: IV07LoadedDraftCandidate, setup: IV07LoadedSetupCandidate): IV07ComposedArm {
    return {
        id: "final-draft-final-setup",
        genome: draft.genome,
        policy: cloneNonFightPolicy(setup.policy),
    };
}

function composedArmFingerprint(arm: IV07ComposedArm): string {
    return fingerprintRankedDraftArtifact({
        draft: { schemaVersion: arm.genome.schemaVersion, weights: arm.genome.weights },
        setup: arm.policy,
    });
}

function createManifest(
    options: IV07ComposedGuardOptions,
    draft: IV07LoadedDraftCandidate,
    setup: IV07LoadedSetupCandidate,
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    ledger: IV07ComposedSeedLedger,
    ledgerBytesSha256: string,
    seedPlan: IV07ComposedSeedPlanCheckpoint,
    seedPlanBytesSha256: string,
    validated: IV07ValidatedCampaignInputs,
    sealedInputs: Record<string, IV07SealedInputReference>,
    runtime: IV07ComposedRuntimeEnvelope,
    provenance: IV07ComposedProvenance,
    sourceLineage: IV07ComposedSourceLineage,
): IV07ComposedManifest {
    const unsigned = {
        schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
        status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
        runId: options.runId,
        deadlineMs: options.deadlineMs,
        workers: options.workers,
        smoke: options.smoke,
        preflightReserveMs: options.preflightReserveMs,
        autoBake: false as const,
        maps: [...LIVE_MAPS],
        cluster: "four_games_pick_seat_by_battle_side" as const,
        panels: {
            naturalBoards: options.naturalBoards,
            cohortBoards: options.cohortBoards,
            cohortScanMaxBoards: options.cohortScanMaxBoards,
            symmetryBoards: options.symmetryBoards,
            replayBoards: options.replayBoards,
        },
        campaign: {
            runSha256: validated.run.runSha256,
            terminalSha256: validated.terminal.terminalSha256,
            configSha256: validated.run.configSha256,
            provenanceSha256: validated.run.provenance.provenanceSha256,
            sourceCommit: validated.run.provenance.commit,
            guardSourceCommit: options.guardSourceCommit,
            sourceLineage,
            draftLane: validated.draftLane.name,
            setupLane: validated.setupLane.name,
        },
        sealedInputs,
        artifacts: {
            draft: {
                path: draft.path,
                bytesSha256: draft.bytesSha256,
                artifactSha256: draft.artifactSha256,
                runId: draft.runId,
                runFingerprint: draft.runFingerprint,
                candidateId: draft.candidateId,
                candidateFingerprint: draft.candidateFingerprint,
                intrinsicSha256: fingerprintRankedDraftArtifact(draft.intrinsic),
            },
            setup: {
                path: setup.path,
                bytesSha256: setup.bytesSha256,
                artifactSha256: setup.artifactSha256,
                runId: setup.runId,
                policyFingerprint: setup.policyFingerprint,
            },
        },
        candidate: {
            draftFingerprint: draft.candidateFingerprint,
            setupFingerprint: setup.policyFingerprint,
            composedFingerprint: composedArmFingerprint(candidate),
        },
        baseline: {
            draftSpec: LEAGUE_ROUND1_DRAFT_SPEC as typeof LEAGUE_ROUND1_DRAFT_SPEC,
            draftFingerprint: fingerprintRankedDraftArtifact({
                schemaVersion: baseline.genome.schemaVersion,
                weights: baseline.genome.weights,
            }),
            setupPolicyId: baseline.policy.id,
            setupFingerprint: fingerprintRankedDraftArtifact(baseline.policy),
            composedFingerprint: composedArmFingerprint(baseline),
        },
        seedLedger: {
            path: "seed-ledger.json" as const,
            ledgerSha256: ledger.ledgerSha256,
            bytesSha256: ledgerBytesSha256,
        },
        seedPlan: {
            path: "seed-plan.checkpoint.json" as const,
            checkpointSha256: seedPlan.checkpointSha256,
            bytesSha256: seedPlanBytesSha256,
        },
        runtime,
        provenance,
        qualification:
            "Research-only composed guard. Passing permits manual review only; this harness cannot edit, bake, promote, or deploy a policy.",
    };
    return { ...unsigned, manifestSha256: fingerprintRankedDraftArtifact(unsigned) };
}

function validateManifest(
    manifest: IV07ComposedManifest,
    options: IV07ComposedGuardOptions,
    draft: IV07LoadedDraftCandidate,
    setup: IV07LoadedSetupCandidate,
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    ledger: IV07ComposedSeedLedger,
    ledgerBytesSha256: string,
    seedPlan: IV07ComposedSeedPlanCheckpoint,
    seedPlanBytesSha256: string,
    validated: IV07ValidatedCampaignInputs,
    sealedInputs: Record<string, IV07SealedInputReference>,
    runtime: IV07ComposedRuntimeEnvelope,
    sourceLineage: IV07ComposedSourceLineage,
): void {
    const { manifestSha256, ...unsigned } = manifest;
    if (
        manifest.schemaVersion !== V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION ||
        manifest.status !== V07_COMPOSED_NONFIGHT_GUARD_STATUS ||
        manifest.autoBake !== false ||
        manifest.cluster !== "four_games_pick_seat_by_battle_side" ||
        JSON.stringify(manifest.maps) !== JSON.stringify(LIVE_MAPS) ||
        manifest.seedLedger.path !== "seed-ledger.json" ||
        manifest.seedPlan.path !== "seed-plan.checkpoint.json" ||
        manifestSha256 !== fingerprintRankedDraftArtifact(unsigned)
    ) {
        throw new Error("manifest identity or self-hash mismatch");
    }
    if (
        manifest.runId !== options.runId ||
        manifest.deadlineMs !== options.deadlineMs ||
        manifest.workers !== options.workers ||
        manifest.smoke !== options.smoke ||
        manifest.preflightReserveMs !== options.preflightReserveMs ||
        fingerprintRankedDraftArtifact(manifest.panels) !==
            fingerprintRankedDraftArtifact({
                naturalBoards: options.naturalBoards,
                cohortBoards: options.cohortBoards,
                cohortScanMaxBoards: options.cohortScanMaxBoards,
                symmetryBoards: options.symmetryBoards,
                replayBoards: options.replayBoards,
            })
    ) {
        throw new Error("invocation differs from the immutable composed guard manifest");
    }
    if (
        manifest.campaign.runSha256 !== validated.run.runSha256 ||
        manifest.campaign.terminalSha256 !== validated.terminal.terminalSha256 ||
        manifest.campaign.configSha256 !== validated.run.configSha256 ||
        manifest.campaign.provenanceSha256 !== validated.run.provenance.provenanceSha256 ||
        manifest.campaign.sourceCommit !== validated.run.provenance.commit ||
        manifest.campaign.guardSourceCommit !== options.guardSourceCommit ||
        fingerprintRankedDraftArtifact(manifest.campaign.sourceLineage) !==
            fingerprintRankedDraftArtifact(sourceLineage) ||
        manifest.campaign.draftLane !== validated.draftLane.name ||
        manifest.campaign.setupLane !== validated.setupLane.name ||
        fingerprintRankedDraftArtifact(manifest.sealedInputs) !== fingerprintRankedDraftArtifact(sealedInputs) ||
        fingerprintRankedDraftArtifact(manifest.runtime) !== fingerprintRankedDraftArtifact(runtime)
    ) {
        throw new Error("completed campaign, sealed inputs, or runtime differs from the immutable manifest");
    }
    if (
        manifest.artifacts.draft.path !== draft.path ||
        manifest.artifacts.draft.bytesSha256 !== draft.bytesSha256 ||
        manifest.artifacts.draft.artifactSha256 !== draft.artifactSha256 ||
        manifest.artifacts.draft.runId !== draft.runId ||
        manifest.artifacts.draft.runFingerprint !== draft.runFingerprint ||
        manifest.artifacts.draft.candidateId !== draft.candidateId ||
        manifest.artifacts.draft.candidateFingerprint !== draft.candidateFingerprint ||
        manifest.artifacts.draft.intrinsicSha256 !== fingerprintRankedDraftArtifact(draft.intrinsic) ||
        manifest.artifacts.setup.path !== setup.path ||
        manifest.artifacts.setup.bytesSha256 !== setup.bytesSha256 ||
        manifest.artifacts.setup.artifactSha256 !== setup.artifactSha256 ||
        manifest.artifacts.setup.runId !== setup.runId ||
        manifest.artifacts.setup.policyFingerprint !== setup.policyFingerprint ||
        manifest.candidate.draftFingerprint !== draft.candidateFingerprint ||
        manifest.candidate.setupFingerprint !== setup.policyFingerprint ||
        manifest.candidate.composedFingerprint !== composedArmFingerprint(candidate) ||
        manifest.baseline.draftSpec !== LEAGUE_ROUND1_DRAFT_SPEC ||
        manifest.baseline.draftFingerprint !==
            fingerprintRankedDraftArtifact({
                schemaVersion: baseline.genome.schemaVersion,
                weights: baseline.genome.weights,
            }) ||
        manifest.baseline.setupPolicyId !== baseline.policy.id ||
        manifest.baseline.setupFingerprint !== fingerprintRankedDraftArtifact(baseline.policy) ||
        manifest.baseline.composedFingerprint !== composedArmFingerprint(baseline) ||
        ledger.runId !== manifest.runId ||
        ledger.candidateFingerprint !== manifest.candidate.composedFingerprint
    ) {
        throw new Error("candidate or baseline differs from the immutable composed guard manifest");
    }
    if (
        manifest.seedLedger.ledgerSha256 !== ledger.ledgerSha256 ||
        manifest.seedLedger.bytesSha256 !== ledgerBytesSha256 ||
        manifest.seedPlan.checkpointSha256 !== seedPlan.checkpointSha256 ||
        manifest.seedPlan.bytesSha256 !== seedPlanBytesSha256 ||
        seedPlan.ledgerSha256 !== ledger.ledgerSha256
    ) {
        throw new Error("seed ledger differs from the immutable composed guard manifest");
    }
    const current = captureProvenance(runtime);
    assertLaunchableProvenance(current);
    assertLaunchableProvenance(manifest.provenance);
    if (current.provenanceSha256 !== manifest.provenance.provenanceSha256) {
        throw new Error("source/runtime provenance changed after composed guard initialization");
    }
}

function phaseBoards(ledger: IV07ComposedSeedLedger, phase: Exclude<CheckpointPhase, "complete">) {
    const panelByPhase: Record<Exclude<CheckpointPhase, "complete">, SeedPanelKind> = {
        natural: "natural",
        "natural-baseline-control": "natural",
        targeted: "targeted",
        "symmetry-final": "symmetry-final",
        "symmetry-old": "symmetry-old",
        "replay-first": "replay",
        "replay-second": "replay",
    };
    return ledger.boards.filter((board) => board.panel === panelByPhase[phase]);
}

function armsForPhase(
    phase: Exclude<CheckpointPhase, "complete">,
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
): [IV07ComposedArm, IV07ComposedArm] {
    if (phase === "symmetry-final") return [candidate, candidate];
    if (phase === "symmetry-old" || phase === "natural-baseline-control") return [baseline, baseline];
    return [candidate, baseline];
}

async function runComposedWorkerPool(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    boards: readonly IV07ComposedSeedBoard[],
    workers: number,
    deadlineMs: number,
    requestType: "job" | "inspect",
    workerEnvironment: NodeJS.ProcessEnv,
    runtime: IV07ComposedRuntimeEnvelope,
    onResult: (message: Extract<WorkerReply, { type: "result" | "inspection" }>) => void,
    respectDeadline: boolean,
): Promise<boolean> {
    if (!boards.length) return true;
    const poolSize = Math.min(workers, boards.length);
    return await new Promise<boolean>((resolvePromise, rejectPromise) => {
        const active = new Set<Worker>();
        const intentionallyStopping = new WeakSet<Worker>();
        let next = 0;
        let completed = 0;
        let stopped = false;
        let settled = false;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
            for (const worker of active) void worker.terminate();
            active.clear();
        };
        const finish = (complete: boolean): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolvePromise(complete);
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (respectDeadline && Date.now() >= deadlineMs) stopped = true;
            if (stopped || next >= boards.length) {
                intentionallyStopping.add(worker);
                worker.postMessage({ type: "stop" } satisfies WorkerRequest);
                if (completed >= next && (stopped || next >= boards.length))
                    finish(!stopped && completed === boards.length);
                return;
            }
            worker.postMessage({ type: requestType, board: boards[next++] } satisfies WorkerRequest);
        };
        if (respectDeadline) {
            deadlineTimer = setTimeout(
                () => {
                    stopped = true;
                    finish(false);
                },
                Math.max(0, deadlineMs - Date.now()),
            );
        }
        for (let index = 0; index < poolSize; index += 1) {
            const data: IV07ComposedWorkerData = {
                v07ComposedNonfightGuardWorker: true,
                candidate,
                baseline,
                environmentSha256: runtime.behaviorEnvironmentSha256,
                runtimeControlsSha256: runtime.runtimeControlsSha256,
            };
            const worker = new Worker(new URL("./v0_7_composed_nonfight_guard_worker.ts", import.meta.url), {
                workerData: data,
                env: workerEnvironment,
                execArgv: [],
            });
            active.add(worker);
            worker.on("message", (message: WorkerReply) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    if (
                        message.attestation.environmentSha256 !== runtime.behaviorEnvironmentSha256 ||
                        message.attestation.runtimeControlsSha256 !== runtime.runtimeControlsSha256 ||
                        message.attestation.execArgv.length !== 0
                    ) {
                        fail(new Error("composed guard worker runtime attestation mismatch"));
                        return;
                    }
                    dispatch(worker);
                    return;
                }
                if (
                    (requestType === "job" && message.type !== "result") ||
                    (requestType === "inspect" && message.type !== "inspection")
                ) {
                    fail(new Error(`composed guard worker returned ${message.type} for ${requestType}`));
                    return;
                }
                try {
                    onResult(message);
                } catch (error) {
                    fail(error);
                    return;
                }
                completed += 1;
                if (completed === boards.length) finish(true);
                else dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                active.delete(worker);
                if (settled) return;
                if (code !== 0) fail(new Error(`composed guard worker exited with code ${code}`));
                else if (!intentionallyStopping.has(worker)) fail(new Error("composed guard worker exited early"));
                else if (active.size === 0 && completed < boards.length) finish(false);
            });
        }
    });
}

async function evaluateBoards(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    boards: readonly IV07ComposedSeedBoard[],
    workers: number,
    deadlineMs: number,
    workerEnvironment: NodeJS.ProcessEnv,
    runtime: IV07ComposedRuntimeEnvelope,
    onResult: (cluster: IV07ComposedCluster) => void,
): Promise<boolean> {
    return await runComposedWorkerPool(
        candidate,
        baseline,
        boards,
        workers,
        deadlineMs,
        "job",
        workerEnvironment,
        runtime,
        (message) => {
            if (message.type !== "result") throw new Error("evaluation worker returned an inspection");
            onResult(message.cluster);
        },
        true,
    );
}

async function inspectBoardsInWorkers(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    boards: readonly IV07ComposedSeedBoard[],
    workers: number,
    deadlineMs: number,
    workerEnvironment: NodeJS.ProcessEnv,
    runtime: IV07ComposedRuntimeEnvelope,
): Promise<V07ComposedNonfightCohort[][]> {
    if (Date.now() >= deadlineMs) return [];
    const bySeed = new Map<number, V07ComposedNonfightCohort[]>();
    const complete = await runComposedWorkerPool(
        candidate,
        baseline,
        boards,
        workers,
        deadlineMs,
        "inspect",
        workerEnvironment,
        runtime,
        (message) => {
            if (message.type !== "inspection") throw new Error("inspection worker returned a fight result");
            if (bySeed.has(message.board.pairSeed)) throw new Error(`worker repeated scan ${message.board.pairSeed}`);
            bySeed.set(message.board.pairSeed, message.cohorts);
        },
        true,
    );
    if (!complete) return [];
    if (bySeed.size !== boards.length) throw new Error("outcome-blind worker scan ended unexpectedly");
    return boards.map((board) => bySeed.get(board.pairSeed)!);
}

/** Testable public boundary proving that even a one-board/one-worker run never evaluates in the caller isolate. */
export async function evaluateV07ComposedBoardsInSealedWorkers(
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    boards: readonly IV07ComposedSeedBoard[],
    workers: number = 1,
    inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<IV07ComposedCluster[]> {
    const environment = sanitizedV07ComposedWorkerEnvironment(inheritedEnvironment);
    const runtime = captureV07ComposedRuntimeEnvelope(environment);
    const clusters: IV07ComposedCluster[] = [];
    const complete = await evaluateBoards(
        candidate,
        baseline,
        boards,
        workers,
        Date.now() + 10 * 60 * 1_000,
        environment,
        runtime,
        (cluster) => clusters.push(cluster),
    );
    if (!complete || clusters.length !== boards.length) throw new Error("sealed worker evaluation did not complete");
    const order = new Map(boards.map((board, index) => [board.pairSeed, index]));
    return clusters.sort((left, right) => order.get(left.board.pairSeed)! - order.get(right.board.pairSeed)!);
}

function replaySerialization(clusters: readonly IV07ComposedCluster[]): string {
    return JSON.stringify(
        [...clusters]
            .sort((left, right) => left.board.pairSeed - right.board.pairSeed)
            .map((cluster) => ({
                board: cluster.board,
                records: [...cluster.records].sort((left, right) => left.game - right.game),
            })),
    );
}

function symmetryPassed(estimate: IV07ComposedEstimate, expectedBoards: number): boolean {
    return (
        estimate.offerBoards === expectedBoards &&
        estimate.decisiveGames > 0 &&
        estimate.wins === estimate.losses &&
        estimate.decisiveWinRate === 0.5 &&
        estimate.candidateRejections === 0 &&
        estimate.baselineRejections === 0
    );
}

export function v07ComposedNamedCoveragePassed(
    estimate: Pick<IV07ComposedEstimate, "games" | "decisiveGames">,
): boolean {
    return (
        estimate.games >= V07_COMPOSED_MINIMUM_NAMED_GAMES &&
        estimate.decisiveGames >= V07_COMPOSED_MINIMUM_NAMED_DECISIVE_GAMES
    );
}

export function v07ComposedNamedGamesPassed(estimate: Pick<IV07ComposedEstimate, "games">): boolean {
    return estimate.games >= V07_COMPOSED_MINIMUM_NAMED_GAMES;
}

export function v07ComposedNamedDecisiveGamesPassed(estimate: Pick<IV07ComposedEstimate, "decisiveGames">): boolean {
    return estimate.decisiveGames >= V07_COMPOSED_MINIMUM_NAMED_DECISIVE_GAMES;
}

export function v07ComposedDrawOrArmageddonPassed(candidateRate: number, matchedBaselineRate: number): boolean {
    return (
        Number.isFinite(candidateRate) &&
        Number.isFinite(matchedBaselineRate) &&
        candidateRate <= matchedBaselineRate + V07_COMPOSED_MAX_DRAW_OR_ARMAGEDDON_REGRESSION
    );
}

export function buildV07ComposedGuardReport(
    manifest: IV07ComposedManifest,
    ledger: IV07ComposedSeedLedger,
    checkpoint: IV07ComposedCheckpoint,
) {
    validateCheckpoint(checkpoint, manifest, ledger);
    if (checkpoint.phase !== "complete" || checkpoint.status !== "complete") {
        throw new Error("cannot report an incomplete composed guard checkpoint");
    }
    const byPanel = (panel: SeedPanelKind): IV07ComposedCluster[] =>
        checkpoint.clusters.filter((cluster) => cluster.board.panel === panel);
    const naturalClusters = byPanel("natural");
    const naturalRecords = recordsFor(naturalClusters);
    const natural = estimateV07ComposedRecords(naturalRecords);
    const naturalBaselineControlRecords = recordsFor(checkpoint.naturalBaselineControl);
    const naturalBaselineControl = estimateV07ComposedRecords(naturalBaselineControlRecords);
    const sortedBoards = (clusters: readonly IV07ComposedCluster[]) =>
        clusters.map((cluster) => cluster.board).sort((left, right) => left.pairSeed - right.pairSeed);
    const naturalControlBoardsMatch =
        fingerprintRankedDraftArtifact(sortedBoards(naturalClusters)) ===
        fingerprintRankedDraftArtifact(sortedBoards(checkpoint.naturalBaselineControl));
    const naturalMaps = Object.fromEntries(
        LIVE_MAPS.map((map) => [
            map,
            estimateV07ComposedRecords(naturalRecords.filter((record) => record.gridType === map)),
        ]),
    ) as Record<SetupLiveGridType, IV07ComposedEstimate>;
    const naturalCohorts = Object.fromEntries(
        V07_COMPOSED_NONFIGHT_COHORTS.map((cohort) => [
            cohort,
            estimateV07ComposedRecords(naturalRecords.filter((record) => record.candidateCohorts.includes(cohort))),
        ]),
    ) as Record<V07ComposedNonfightCohort, IV07ComposedEstimate>;
    const targeted = Object.fromEntries(
        V07_COMPOSED_NONFIGHT_COHORTS.map((cohort) => {
            const clusters = byPanel("targeted").filter((cluster) => cluster.board.cohort === cohort);
            const qualified = recordsFor(clusters).filter((record) => record.candidateCohorts.includes(cohort));
            const estimate = estimateV07ComposedRecords(qualified);
            return [
                cohort,
                {
                    selectedOfferBoards: clusters.length,
                    qualifiedOfferBoards: new Set(qualified.map((record) => record.pairSeed)).size,
                    estimate,
                },
            ];
        }),
    ) as Record<
        V07ComposedNonfightCohort,
        { selectedOfferBoards: number; qualifiedOfferBoards: number; estimate: IV07ComposedEstimate }
    >;
    const finalSymmetry = estimateV07ComposedRecords(recordsFor(byPanel("symmetry-final")));
    const oldSymmetry = estimateV07ComposedRecords(recordsFor(byPanel("symmetry-old")));
    const replayFirst = byPanel("replay");
    const firstBytes = replaySerialization(replayFirst);
    const secondBytes = replaySerialization(checkpoint.replaySecond);
    const replay = {
        boards: replayFirst.length,
        firstSha256: sha256Bytes(firstBytes),
        secondSha256: sha256Bytes(secondBytes),
        byteIdentical: firstBytes === secondBytes,
    };
    const comparisonRecords = recordsFor([...naturalClusters, ...byPanel("targeted"), ...replayFirst]);
    const checks = {
        naturalPanelComplete: natural.offerBoards === manifest.panels.naturalBoards,
        naturalClusteredLower95AboveEven: natural.confidence95.low > 0.5,
        candidateRejectedActionsZero: comparisonRecords.every((record) => record.candidateRejections === 0),
        baselineRejectedActionsZero: comparisonRecords.every((record) => record.baselineRejections === 0),
        exactLiveMapPanel: JSON.stringify(manifest.maps) === JSON.stringify(LIVE_MAPS),
        allLiveMapsPointEstimateAtLeast49_5: LIVE_MAPS.every(
            (map) => naturalMaps[map].decisiveWinRate >= SETUP_GUARD_THRESHOLDS.liveMapPointWinRate,
        ),
        allLiveMapsClusteredLower95AtLeast48: LIVE_MAPS.every((map) => naturalMaps[map].confidence95.low >= 0.48),
        allLiveMapsHaveMinimumCoverage: LIVE_MAPS.every(
            (map) => naturalMaps[map].games >= SETUP_GUARD_THRESHOLDS.minimumLiveMapGames,
        ),
        targetedPanelsComplete: V07_COMPOSED_NONFIGHT_COHORTS.every(
            (cohort) =>
                targeted[cohort].selectedOfferBoards === manifest.panels.cohortBoards &&
                targeted[cohort].qualifiedOfferBoards === manifest.panels.cohortBoards,
        ),
        targetedCohortPointEstimatesAtLeast49_5: V07_COMPOSED_NONFIGHT_COHORTS.every(
            (cohort) => targeted[cohort].estimate.decisiveWinRate >= SETUP_GUARD_THRESHOLDS.namedPointWinRate,
        ),
        targetedCohortClusteredLower95AtLeast48: V07_COMPOSED_NONFIGHT_COHORTS.every(
            (cohort) => targeted[cohort].estimate.confidence95.low >= 0.48,
        ),
        targetedCohortsHaveMinimumNamedGames: V07_COMPOSED_NONFIGHT_COHORTS.every((cohort) =>
            v07ComposedNamedGamesPassed(targeted[cohort].estimate),
        ),
        targetedCohortsHaveMinimumDecisiveGames: V07_COMPOSED_NONFIGHT_COHORTS.every((cohort) =>
            v07ComposedNamedDecisiveGamesPassed(targeted[cohort].estimate),
        ),
        targetedCohortCandidateRejectionsZero: V07_COMPOSED_NONFIGHT_COHORTS.every(
            (cohort) => targeted[cohort].estimate.candidateRejections === 0,
        ),
        targetedCohortBaselineRejectionsZero: V07_COMPOSED_NONFIGHT_COHORTS.every(
            (cohort) => targeted[cohort].estimate.baselineRejections === 0,
        ),
        finalFinalSymmetry: symmetryPassed(finalSymmetry, manifest.panels.symmetryBoards),
        oldOldSymmetry: symmetryPassed(oldSymmetry, manifest.panels.symmetryBoards),
        matchedNaturalBaselineControlComplete:
            naturalControlBoardsMatch &&
            symmetryPassed(naturalBaselineControl, manifest.panels.naturalBoards) &&
            naturalBaselineControl.games === natural.games,
        naturalDrawOrArmageddonNonRegression: v07ComposedDrawOrArmageddonPassed(
            natural.drawOrArmageddonRate,
            naturalBaselineControl.drawOrArmageddonRate,
        ),
        deterministicReplayByteIdentical:
            replay.boards === manifest.panels.replayBoards &&
            checkpoint.replaySecond.length === manifest.panels.replayBoards &&
            replay.byteIdentical,
        immutableSeedLedgerVerified: true,
        immutableCandidateAndProvenanceVerified: true,
        productionPreregistrationFloorsLocked:
            !manifest.smoke &&
            manifest.panels.naturalBoards >= PRODUCTION_PANEL_MINIMUMS.naturalBoards &&
            manifest.panels.cohortBoards >= PRODUCTION_PANEL_MINIMUMS.cohortBoards &&
            manifest.panels.cohortScanMaxBoards >= PRODUCTION_PANEL_MINIMUMS.cohortScanMaxBoards &&
            manifest.panels.symmetryBoards >= PRODUCTION_PANEL_MINIMUMS.symmetryBoards &&
            manifest.panels.replayBoards >= PRODUCTION_PANEL_MINIMUMS.replayBoards,
    };
    const eligibleForManualReview = Object.values(checks).every(Boolean);
    const unsigned = {
        schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
        status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
        autoBaked: false as const,
        runId: manifest.runId,
        manifestSha256: manifest.manifestSha256,
        ledgerSha256: ledger.ledgerSha256,
        candidateFingerprint: manifest.candidate.composedFingerprint,
        baselineFingerprint: manifest.baseline.composedFingerprint,
        completedAt: checkpoint.completedAt,
        eligibleForManualReview,
        checks,
        thresholds: {
            naturalClusteredLower95: 0.5,
            liveMapDecisiveWinRate: SETUP_GUARD_THRESHOLDS.liveMapPointWinRate,
            liveMapClusteredLower95: 0.48,
            liveMapMinimumGames: SETUP_GUARD_THRESHOLDS.minimumLiveMapGames,
            namedDecisiveWinRate: SETUP_GUARD_THRESHOLDS.namedPointWinRate,
            namedClusteredLower95: 0.48,
            namedMinimumGames: V07_COMPOSED_MINIMUM_NAMED_GAMES,
            namedMinimumDecisiveGames: V07_COMPOSED_MINIMUM_NAMED_DECISIVE_GAMES,
            namedQualifiedOfferBoards: manifest.panels.cohortBoards,
            rejectedActions: 0,
            naturalDrawOrArmageddonMaximumRegression: V07_COMPOSED_MAX_DRAW_OR_ARMAGEDDON_REGRESSION,
        },
        cohortDefinitions: V07_COMPOSED_NONFIGHT_COHORT_DEFINITIONS,
        natural,
        naturalMaps,
        naturalCohorts,
        targetedCohorts: targeted,
        controls: {
            matchedNaturalOldOld: naturalBaselineControl,
            finalFinal: finalSymmetry,
            oldOld: oldSymmetry,
        },
        deterministicReplay: replay,
        qualification:
            "Passing permits manual review only. This composed guard does not edit, bake, promote, deploy, or automatically activate either candidate policy.",
    };
    return { ...unsigned, reportSha256: fingerprintRankedDraftArtifact(unsigned) };
}

function incompleteOutcome(manifest: IV07ComposedManifest, checkpoint: IV07ComposedCheckpoint) {
    return {
        schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
        status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
        autoBaked: false,
        runId: manifest.runId,
        manifestSha256: manifest.manifestSha256,
        completion: "incomplete_deadline",
        phase: checkpoint.phase,
        eligibleForManualReview: false,
        qualification:
            "Incomplete research evidence cannot promote or bake a policy; resume only under the same manifest.",
    };
}

function parseIntegerFlag(value: string | undefined, fallback: number, label: string, minimum: number): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new RangeError(`${label} must be >= ${minimum}`);
    return parsed;
}

export function parseV07ComposedGuardOptions(argv: readonly string[]): IV07ComposedGuardOptions {
    const { values } = parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: false,
        options: {
            out: { type: "string" },
            "campaign-run": { type: "string" },
            "campaign-terminal": { type: "string" },
            "campaign-run-sha256": { type: "string" },
            "campaign-terminal-sha256": { type: "string" },
            "campaign-config-sha256": { type: "string" },
            "campaign-provenance-sha256": { type: "string" },
            "campaign-source-commit": { type: "string" },
            "guard-source-commit": { type: "string" },
            "draft-verdict": { type: "string" },
            "draft-verdict-sha256": { type: "string" },
            "draft-run-fingerprint": { type: "string" },
            "setup-final": { type: "string" },
            "setup-final-sha256": { type: "string" },
            "setup-checkpoint-sha256": { type: "string" },
            workers: { type: "string", default: String(Math.min(12, Math.max(1, availableParallelism()))) },
            "deadline-ms": { type: "string" },
            "preflight-reserve-ms": { type: "string", default: String(PRODUCTION_PANEL_MINIMUMS.preflightReserveMs) },
            "run-id": { type: "string" },
            "natural-boards": { type: "string", default: "8000" },
            "cohort-boards": { type: "string", default: "2500" },
            "cohort-scan-max-boards": { type: "string", default: "1000000" },
            "symmetry-boards": { type: "string", default: "64" },
            "replay-boards": { type: "string", default: "8" },
            smoke: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/optimizer/v0_7_composed_nonfight_guard.ts --out <outside-repo-dir> " +
                "--campaign-run <run.json> --campaign-terminal <TERMINAL.json> " +
                "--campaign-run-sha256 <sha> --campaign-terminal-sha256 <sha> --campaign-config-sha256 <sha> " +
                "--campaign-provenance-sha256 <sha> --campaign-source-commit <commit> " +
                "--guard-source-commit <commit> " +
                "--draft-verdict <guard/verdict.json> --draft-verdict-sha256 <sha> --draft-run-fingerprint <sha> " +
                "--setup-final <final.json> --setup-final-sha256 <sha> --setup-checkpoint-sha256 <sha> " +
                "--deadline-ms <epoch-ms> --run-id <id> [--workers 12] [--smoke]",
        );
        process.exit(0);
    }
    if (
        !values.out ||
        !values["campaign-run"] ||
        !values["campaign-terminal"] ||
        !values["campaign-run-sha256"] ||
        !values["campaign-terminal-sha256"] ||
        !values["campaign-config-sha256"] ||
        !values["campaign-provenance-sha256"] ||
        !values["campaign-source-commit"] ||
        !values["guard-source-commit"] ||
        !values["draft-verdict"] ||
        !values["draft-verdict-sha256"] ||
        !values["draft-run-fingerprint"] ||
        !values["setup-final"] ||
        !values["setup-final-sha256"] ||
        !values["setup-checkpoint-sha256"] ||
        !values["deadline-ms"] ||
        !values["run-id"]
    ) {
        throw new Error("campaign, exact artifact hash, output, deadline, and run-id arguments are all required");
    }
    const runId = values["run-id"].trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
        throw new Error("--run-id must be 1..128 filesystem-safe characters");
    }
    const requestedOut = resolve(values.out);
    const out = existsSync(requestedOut)
        ? realpathSync(requestedOut)
        : resolve(realpathSync(dirname(requestedOut)), basename(requestedOut));
    if (out === PACKAGE_ROOT || out.startsWith(`${PACKAGE_ROOT}${sep}`)) {
        throw new Error("--out must remain outside the source checkout");
    }
    const smoke = values.smoke;
    for (const [flag, value] of [
        ["--campaign-run-sha256", values["campaign-run-sha256"]],
        ["--campaign-terminal-sha256", values["campaign-terminal-sha256"]],
        ["--campaign-config-sha256", values["campaign-config-sha256"]],
        ["--campaign-provenance-sha256", values["campaign-provenance-sha256"]],
        ["--draft-verdict-sha256", values["draft-verdict-sha256"]],
        ["--draft-run-fingerprint", values["draft-run-fingerprint"]],
        ["--setup-final-sha256", values["setup-final-sha256"]],
        ["--setup-checkpoint-sha256", values["setup-checkpoint-sha256"]],
    ] as const) {
        if (!SHA256_PATTERN.test(value)) throw new Error(`${flag} must be lowercase SHA-256`);
    }
    if (!GIT_COMMIT_PATTERN.test(values["campaign-source-commit"])) {
        throw new Error("--campaign-source-commit must be a lowercase git object id");
    }
    if (!GIT_COMMIT_PATTERN.test(values["guard-source-commit"])) {
        throw new Error("--guard-source-commit must be a lowercase git object id");
    }
    const options: IV07ComposedGuardOptions = {
        out,
        campaignRun: resolve(values["campaign-run"]),
        campaignTerminal: resolve(values["campaign-terminal"]),
        campaignRunSha256: values["campaign-run-sha256"],
        campaignTerminalSha256: values["campaign-terminal-sha256"],
        campaignConfigSha256: values["campaign-config-sha256"],
        campaignProvenanceSha256: values["campaign-provenance-sha256"],
        campaignSourceCommit: values["campaign-source-commit"],
        guardSourceCommit: values["guard-source-commit"],
        draftVerdict: resolve(values["draft-verdict"]),
        draftVerdictSha256: values["draft-verdict-sha256"],
        draftRunFingerprint: values["draft-run-fingerprint"],
        setupFinal: resolve(values["setup-final"]),
        setupFinalSha256: values["setup-final-sha256"],
        setupCheckpointSha256: values["setup-checkpoint-sha256"],
        workers: parseIntegerFlag(values.workers, 12, "--workers", 1),
        deadlineMs: parseIntegerFlag(values["deadline-ms"], 0, "--deadline-ms", 1),
        preflightReserveMs: smoke
            ? 0
            : parseIntegerFlag(
                  values["preflight-reserve-ms"],
                  PRODUCTION_PANEL_MINIMUMS.preflightReserveMs,
                  "--preflight-reserve-ms",
                  PRODUCTION_PANEL_MINIMUMS.preflightReserveMs,
              ),
        runId,
        naturalBoards: smoke
            ? 2
            : parseIntegerFlag(
                  values["natural-boards"],
                  PRODUCTION_PANEL_MINIMUMS.naturalBoards,
                  "--natural-boards",
                  PRODUCTION_PANEL_MINIMUMS.naturalBoards,
              ),
        cohortBoards: smoke
            ? 2
            : parseIntegerFlag(
                  values["cohort-boards"],
                  PRODUCTION_PANEL_MINIMUMS.cohortBoards,
                  "--cohort-boards",
                  PRODUCTION_PANEL_MINIMUMS.cohortBoards,
              ),
        cohortScanMaxBoards: smoke
            ? 10_000
            : parseIntegerFlag(
                  values["cohort-scan-max-boards"],
                  PRODUCTION_PANEL_MINIMUMS.cohortScanMaxBoards,
                  "--cohort-scan-max-boards",
                  PRODUCTION_PANEL_MINIMUMS.cohortScanMaxBoards,
              ),
        symmetryBoards: smoke
            ? 2
            : parseIntegerFlag(
                  values["symmetry-boards"],
                  PRODUCTION_PANEL_MINIMUMS.symmetryBoards,
                  "--symmetry-boards",
                  PRODUCTION_PANEL_MINIMUMS.symmetryBoards,
              ),
        replayBoards: smoke
            ? 1
            : parseIntegerFlag(
                  values["replay-boards"],
                  PRODUCTION_PANEL_MINIMUMS.replayBoards,
                  "--replay-boards",
                  PRODUCTION_PANEL_MINIMUMS.replayBoards,
              ),
        smoke,
    };
    assertPanelSizes(options);
    return options;
}

async function runPhases(
    options: IV07ComposedGuardOptions,
    manifest: IV07ComposedManifest,
    ledger: IV07ComposedSeedLedger,
    candidate: IV07ComposedArm,
    baseline: IV07ComposedArm,
    checkpointPath: string,
    checkpoint: IV07ComposedCheckpoint,
    workerEnvironment: NodeJS.ProcessEnv,
    runtime: IV07ComposedRuntimeEnvelope,
): Promise<boolean> {
    const phases = CHECKPOINT_PHASES;
    let phaseIndex = checkpoint.phase === "complete" ? phases.length : phases.indexOf(checkpoint.phase);
    if (phaseIndex < 0) throw new Error(`invalid checkpoint phase ${checkpoint.phase}`);
    while (phaseIndex < phases.length) {
        const phase = phases[phaseIndex];
        checkpoint.phase = phase;
        saveCheckpoint(checkpointPath, checkpoint);
        const boards = phaseBoards(ledger, phase);
        const destination =
            phase === "replay-second"
                ? checkpoint.replaySecond
                : phase === "natural-baseline-control"
                  ? checkpoint.naturalBaselineControl
                  : checkpoint.clusters;
        const expectedSeeds = new Set(boards.map((board) => board.pairSeed));
        const completedSeeds = new Set(
            destination
                .filter((cluster) => expectedSeeds.has(cluster.board.pairSeed))
                .map((cluster) => cluster.board.pairSeed),
        );
        const pending = boards.filter((board) => !completedSeeds.has(board.pairSeed));
        const [left, right] = armsForPhase(phase, candidate, baseline);
        let sinceSave = 0;
        const complete = await evaluateBoards(
            left,
            right,
            pending,
            options.workers,
            options.deadlineMs,
            workerEnvironment,
            runtime,
            (cluster) => {
                if (completedSeeds.has(cluster.board.pairSeed))
                    throw new Error(`worker repeated ${cluster.board.pairSeed}`);
                completedSeeds.add(cluster.board.pairSeed);
                destination.push(cluster);
                sinceSave += 1;
                if (sinceSave >= Math.max(256, options.workers * 16)) {
                    saveCheckpoint(checkpointPath, checkpoint);
                    sinceSave = 0;
                }
            },
        );
        saveCheckpoint(checkpointPath, checkpoint);
        if (!complete || completedSeeds.size !== boards.length) return false;
        phaseIndex += 1;
        if (phaseIndex === phases.length) {
            checkpoint.phase = "complete";
            checkpoint.status = "complete";
            checkpoint.completedAt ??= new Date().toISOString();
            saveCheckpoint(checkpointPath, checkpoint);
            return true;
        }
        checkpoint.phase = phases[phaseIndex];
        saveCheckpoint(checkpointPath, checkpoint);
    }
    return checkpoint.phase === "complete" && checkpoint.status === "complete";
}

async function main(): Promise<void> {
    assertV07ComposedRuntimeInjectionAbsent();
    const options = parseV07ComposedGuardOptions(process.argv.slice(2));
    const lock = acquireV07ComposedOutputLock(options.out);
    try {
        const workerEnvironment = sanitizedV07ComposedWorkerEnvironment(process.env);
        const runtime = captureV07ComposedRuntimeEnvelope(workerEnvironment);
        const validated = validateV07ComposedCampaignInputs(options);
        const sealedInputs = sealCampaignInputs(options.out, validated);
        const sealedDraftPath = join(options.out, sealedInputs["draft-verdict.json"].path);
        const sealedSetupPath = join(options.out, sealedInputs["setup-final.json"].path);
        const draft = loadV07ComposedDraftCandidate(sealedDraftPath, options.runId);
        const setup = loadV07ComposedSetupCandidate(sealedSetupPath, options.runId);
        const candidate = candidateArm(draft, setup);
        const baseline = baselineArm();
        const provenance = captureProvenance(runtime);
        assertLaunchableProvenance(provenance);
        const sourceLineage = captureSourceLineage(options, provenance);
        const panels: IV07ComposedGuardPanelSizes = {
            naturalBoards: options.naturalBoards,
            cohortBoards: options.cohortBoards,
            cohortScanMaxBoards: options.cohortScanMaxBoards,
            symmetryBoards: options.symmetryBoards,
            replayBoards: options.replayBoards,
        };
        const initializationSha256 = fingerprintRankedDraftArtifact({
            runId: options.runId,
            panels,
            campaign: {
                runSha256: validated.run.runSha256,
                terminalSha256: validated.terminal.terminalSha256,
                configSha256: validated.run.configSha256,
                provenanceSha256: validated.run.provenance.provenanceSha256,
            },
            sealedInputs,
            runtime,
            provenance,
            sourceLineage,
        });
        const ledgerPath = resolve(options.out, "seed-ledger.json");
        const seedPlanPath = resolve(options.out, "seed-plan.checkpoint.json");
        const manifestPath = resolve(options.out, "manifest.json");
        const checkpointPath = resolve(options.out, "checkpoint.json");
        const outcomePath = resolve(options.out, "outcome.json");
        let ledger: IV07ComposedSeedLedger;
        let seedPlan: IV07ComposedSeedPlanCheckpoint;
        let manifest: IV07ComposedManifest;
        if (existsSync(manifestPath)) {
            if (!existsSync(ledgerPath) || !existsSync(seedPlanPath)) {
                throw new Error("existing manifest omitted its immutable seed ledger or seed-plan checkpoint");
            }
            ledger = parseJson<IV07ComposedSeedLedger>(ledgerPath, "seed ledger");
            validateV07ComposedSeedLedger(ledger);
            seedPlan = parseJson<IV07ComposedSeedPlanCheckpoint>(seedPlanPath, "seed-plan checkpoint");
            validateSeedPlan(seedPlan, options.runId, composedArmFingerprint(candidate), initializationSha256, panels);
            manifest = parseJson<IV07ComposedManifest>(manifestPath, "manifest");
            validateManifest(
                manifest,
                options,
                draft,
                setup,
                candidate,
                baseline,
                ledger,
                sha256Bytes(readFileSync(ledgerPath)),
                seedPlan,
                sha256Bytes(readFileSync(seedPlanPath)),
                validated,
                sealedInputs,
                runtime,
                sourceLineage,
            );
        } else {
            if (options.deadlineMs <= Date.now()) throw new Error("--deadline-ms is already in the past");
            const planned = await buildOrResumeV07ComposedSeedLedger(
                seedPlanPath,
                options.runId,
                composedArmFingerprint(candidate),
                initializationSha256,
                panels,
                candidate,
                baseline,
                options.workers,
                workerEnvironment,
                runtime,
                options.deadlineMs - options.preflightReserveMs,
            );
            seedPlan = planned.checkpoint;
            if (!planned.ledger) {
                atomicJson(outcomePath, {
                    schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
                    status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
                    autoBaked: false,
                    runId: options.runId,
                    completion: "incomplete_preflight_deadline",
                    eligibleForManualReview: false,
                    seedPlanCheckpointSha256: seedPlan.checkpointSha256,
                    nextCohortIndex: seedPlan.nextCohortIndex,
                    cohortStates: seedPlan.cohortStates,
                    qualification:
                        "Outcome-blind seed planning is resumable but incomplete; no fight was run or policy promoted.",
                });
                process.exitCode = 2;
                return;
            }
            ledger = planned.ledger;
            immutableJson(ledgerPath, ledger);
            const ledgerBytesSha256 = sha256Bytes(readFileSync(ledgerPath));
            const seedPlanBytesSha256 = sha256Bytes(readFileSync(seedPlanPath));
            manifest = createManifest(
                options,
                draft,
                setup,
                candidate,
                baseline,
                ledger,
                ledgerBytesSha256,
                seedPlan,
                seedPlanBytesSha256,
                validated,
                sealedInputs,
                runtime,
                provenance,
                sourceLineage,
            );
            immutableJson(manifestPath, manifest);
        }

        let checkpoint: IV07ComposedCheckpoint;
        if (existsSync(checkpointPath)) {
            checkpoint = parseJson<IV07ComposedCheckpoint>(checkpointPath, "checkpoint");
            validateCheckpoint(checkpoint, manifest, ledger);
        } else {
            const initial = {
                schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
                status: "running" as const,
                manifestSha256: manifest.manifestSha256,
                phase: "natural" as const,
                clusters: [],
                naturalBaselineControl: [],
                replaySecond: [],
                updatedAt: new Date().toISOString(),
            };
            checkpoint = checkpointWithHash(initial);
            atomicJson(checkpointPath, checkpoint);
        }
        const complete =
            checkpoint.status === "complete" ||
            (await runPhases(
                options,
                manifest,
                ledger,
                candidate,
                baseline,
                checkpointPath,
                checkpoint,
                workerEnvironment,
                runtime,
            ));
        validateCheckpoint(checkpoint, manifest, ledger);
        if (!complete) {
            atomicJson(outcomePath, incompleteOutcome(manifest, checkpoint));
            process.exitCode = 2;
            return;
        }
        const finalDraft = loadV07ComposedDraftCandidate(sealedDraftPath, options.runId);
        const finalSetup = loadV07ComposedSetupCandidate(sealedSetupPath, options.runId);
        const finalCandidate = candidateArm(finalDraft, finalSetup);
        validateManifest(
            manifest,
            options,
            finalDraft,
            finalSetup,
            finalCandidate,
            baseline,
            ledger,
            sha256Bytes(readFileSync(ledgerPath)),
            seedPlan,
            sha256Bytes(readFileSync(seedPlanPath)),
            validated,
            sealedInputs,
            runtime,
            sourceLineage,
        );
        const report = buildV07ComposedGuardReport(manifest, ledger, checkpoint);
        immutableJson(resolve(options.out, "report.json"), report);
        const outcome = {
            schemaVersion: V07_COMPOSED_NONFIGHT_GUARD_SCHEMA_VERSION,
            status: V07_COMPOSED_NONFIGHT_GUARD_STATUS,
            autoBaked: false as const,
            runId: manifest.runId,
            completion: "complete" as const,
            eligibleForManualReview: report.eligibleForManualReview,
            manifestSha256: manifest.manifestSha256,
            ledgerSha256: ledger.ledgerSha256,
            reportSha256: report.reportSha256,
            reportPath: "report.json",
            qualification:
                "Research-only outcome. Even an eligible result requires owner review and a separate coordinated commit/deploy; no policy was auto-baked.",
        };
        atomicJson(outcomePath, outcome);
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    } finally {
        releaseV07ComposedOutputLock(lock);
    }
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
