/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
    draftGenomeCreatureScore,
    LEAGUE_ROUND1_DRAFT_SPEC,
    LEAGUE_ROUND3_DRAFT_SPEC,
    parseDraftGenome,
    pickDraftGenomeCreature,
    projectDraftGenomeForShipping,
    RANKED_VERSATILE_DRAFT_SPEC,
} from "../ai/setup/draft_ship";
import { RANKED_A19_DRAFT_CANDIDATE, RANKED_A19_DRAFT_CANDIDATE_ID } from "../ai/setup/ranked_a19_draft_candidate";
import { pickCoherentDraftBundle } from "../ai/setup/draft_coherence";
import { isRankedDraftInteractionPrior, RANKED_DRAFT_INTERACTION_PRIOR_ID } from "../ai/setup/draft_interaction_prior";
import { isRankedDraftVarietyPolicy, RANKED_DRAFT_VARIETY_POLICY_ID } from "../ai/setup/draft_variety";
import { resolveSetupPolicy, type IResolvedSetupPolicy } from "../ai/setup/setup_ship";
import { creatureInfo } from "../ai/setup/creature_score";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { TIER1_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import { buildV08A19SearchEnvironment } from "../ai/versions/v0_8_a19_profile";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    getKnownOpponentCreatures,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionPickSim,
    type IPickSimState,
    type IPickTeamState,
    type PickAction,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { creaturesByLevel, DEFAULT_AMOUNT_BY_LEVEL, makeRng, resolveStackAmount, type IArmyUnitSpec } from "./army";
import {
    runMatch,
    type IMatchConfig,
    type IMatchResult,
    type ISetupAugment,
    type ISetupSynergy,
    type Side,
} from "./battle_engine";
import {
    createLeagueGenome,
    createMeleeLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_LAYOUT,
    RANKED_SPELL_RANGED_DRAFT_POLICY_ID,
    isRankedSpellRangedDraftPolicy,
    type ILeagueGenome,
} from "./league_genome";

const require = createRequire(import.meta.url);
const CREATURES = require("../configuration/creatures.json") as Record<
    string,
    Record<string, { attack_type?: string }>
>;
const ATTACK_TYPE_BY_NAME = new Map<string, string>();
for (const faction of Object.values(CREATURES)) {
    for (const [name, config] of Object.entries(faction ?? {})) {
        ATTACK_TYPE_BY_NAME.set(name, config?.attack_type ?? "");
    }
}

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const CURRENT_INCUMBENT_ID = "ranked-round1-incumbent";
const HEURISTIC_ID = "untrained-heuristic";
const DEFAULT_ID = "shipped-default-draft";
const ROUND3_ID = "league-round3-exploiter";
const UINT32_SPACE = 0x1_0000_0000;
const SEED_CHANNELS_PER_BOARD = 3;

export const RANKED_DRAFT_INTRINSIC_OFFSET = LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset;
export const RANKED_DRAFT_INTRINSIC_DIM = LEAGUE_GENOME_LAYOUT.draftIntrinsic.length;
export const RANKED_DRAFT_CURRENT_INCUMBENT_ID = CURRENT_INCUMBENT_ID;
export const RANKED_DRAFT_INTERACTION_PRIOR_CANDIDATE_ID = "ranked-interactions-a19-ranked-draft-10008-v1";
export const RANKED_DRAFT_VERSATILE_CANDIDATE_ID = RANKED_VERSATILE_DRAFT_SPEC;
export const RANKED_DRAFT_A19_CALIBRATED_CANDIDATE_ID = RANKED_A19_DRAFT_CANDIDATE_ID;
export const RANKED_DRAFT_A19_CASTER_REPLAY_CANDIDATE_ID = "ranked-a19-caster-replay-v1";
export const RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC = "all";
export const RANKED_DRAFT_LIVE_MAP_TYPES = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;

export type RankedDraftCohort = "ranged" | "mage" | "melee_magic" | "aura_heavy";
export type RankedDraftFightProfileId = "v0.7" | "a19";

export const RANKED_DRAFT_COHORT_DEFINITIONS: Readonly<Record<RankedDraftCohort, string>> = {
    ranged: "candidate roster contains at least one RANGE creature",
    mage: "candidate roster contains at least one MAGIC creature",
    melee_magic: "candidate roster contains at least one MELEE_MAGIC creature",
    aura_heavy: "candidate roster contains at least one creature carrying an aura",
};

interface IRankedDraftArmy {
    creatureIds: number[];
    revealedOpponentCreatures: number[];
    roster: IArmyUnitSpec[];
    doctrine: number;
    augments: ISetupAugment[];
    synergies: ISetupSynergy[];
    tier1Artifact: number;
    tier2Artifact: number;
}

export interface IRankedDraftPoolEntry extends ILeagueGenome {
    prior?: number;
}

export interface IRankedDraftGameRecord {
    opponentId: string;
    game: number;
    offerBoard: number;
    pickSeat: "candidate-lower" | "candidate-upper";
    battleMirror: 0 | 1;
    setupFingerprint: string;
    behaviorTraceSha256: string;
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
    gridType: number;
    candidateSide: Side;
    winner: Side | "draw";
    candidateResult: "win" | "loss" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    collisions: number;
    candidateCohorts: RankedDraftCohort[];
    decidedByArmageddon: boolean;
    rejectedCandidate: number;
    rejectedOpponent: number;
}

export interface IRankedDraftOpponentSummary {
    opponentId: string;
    games: number;
    offerBoards: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveGames: number;
    decisiveWinRate: number;
    confidence95: { low: number; high: number };
    clusteredLowerBound: number;
    drawOrArmageddonRate: number;
    rejectedCandidate: number;
    rejectedOpponent: number;
    avgLaps: number;
    endReasons: Record<IMatchResult["endReason"], number>;
}

export interface IRankedDraftCohortSummary {
    cohort: RankedDraftCohort;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveGames: number;
    decisiveWinRate: number;
    confidence95: { low: number; high: number } | null;
}

export interface IRankedDraftMapSummary {
    mapType: number;
    games: number;
    offerBoards: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveGames: number;
    decisiveWinRate: number;
    confidence95: { low: number; high: number };
    clusteredLowerBound: number;
    drawOrArmageddonRate: number;
    rejectedCandidate: number;
    rejectedOpponent: number;
    avgLaps: number;
    endReasons: Record<IMatchResult["endReason"], number>;
}

export interface IRankedDraftEvaluationReport {
    schemaVersion: 1;
    status: "research_only_no_bake";
    candidateId: string;
    totalGames: number;
    options: {
        gamesPerOpponent: number;
        baseSeed: number;
        concurrency: number;
        fightProfile: RankedDraftFightProfileId;
        fightVersion: "v0.7" | "v0.8";
        maxLaps: number;
        mapTypes: number[];
        setupRules: "all";
        candidateSetupPolicySpec: string;
        opponentSetupPolicySpec: string;
        draftDimensions: { offset: number; length: number };
        clusterSize: 4;
        seedAllocation: "indexed-bijective-v1";
        seedChannelsPerBoard: 3;
        commonBattleSeed: true;
        behaviorTrace: "canonical-sha256-v1";
        executedActionsRecorded: true;
    };
    opponents: IRankedDraftOpponentSummary[];
    maps: IRankedDraftMapSummary[];
    cohortDefinitions: Record<RankedDraftCohort, string>;
    cohorts: IRankedDraftCohortSummary[];
    aggregate: {
        fitness: number;
        worstCaseLowerBound: number;
        worstCaseOpponent: string;
        rejectedCandidate: number;
        rejectedOpponent: number;
        drawOrArmageddonRate: number;
        avgLaps: number;
        endReasons: Record<IMatchResult["endReason"], number>;
        behaviorTraceSetSha256: string;
    };
    qualification: string;
}

export interface IRankedDraftEvaluationOptions {
    gamesPerOpponent: number;
    baseSeed: number;
    concurrency?: number;
    mapTypes?: readonly number[];
    maxLaps?: number;
    fightProfile?: RankedDraftFightProfileId;
    candidateSetupPolicySpec?: string;
    opponentSetupPolicySpec?: string;
}

interface INormalizedOptions {
    gamesPerOpponent: number;
    baseSeed: number;
    concurrency: number;
    mapTypes: number[];
    maxLaps: number;
    fightProfile: RankedDraftFightProfileId;
    candidateSetupPolicySpec: string;
    opponentSetupPolicySpec: string;
}

interface IRankedDraftGameDependencies {
    matchRunner: (config: IMatchConfig) => IMatchResult;
}

const DEFAULT_DEPENDENCIES: IRankedDraftGameDependencies = { matchRunner: runMatch };

function canonicalRankedDraftValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalRankedDraftValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== undefined)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, canonicalRankedDraftValue(entry)]),
        );
    }
    return value;
}

function canonicalRankedDraftSha256(value: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(canonicalRankedDraftValue(value)))
        .digest("hex");
}

/** Digest the complete executed fight behavior without retaining the large raw trace in natural-run artifacts. */
export function rankedDraftBehaviorTraceSha256(result: IMatchResult): string {
    return canonicalRankedDraftSha256({
        seed: result.seed,
        gridType: result.gridType,
        placements: result.placements,
        actions: result.actions,
        totalActions: result.totalActions,
        laps: result.laps,
        outcome: result.outcome,
        attrition: result.attrition,
        winner: result.winner,
        endReason: result.endReason,
        rejections: {
            green: result.rejectedGreen ?? 0,
            red: result.rejectedRed ?? 0,
            details: result.rejectedDetails ?? [],
        },
    });
}

/** Stable digest of an ordered panel's per-game behavior digests. */
export function rankedDraftBehaviorTraceSetSha256(records: readonly IRankedDraftGameRecord[]): string {
    const traces = [...records]
        .sort(
            (left, right) =>
                left.opponentId.localeCompare(right.opponentId) ||
                left.pairSeed - right.pairSeed ||
                left.game - right.game,
        )
        .map((record) => ({
            opponentId: record.opponentId,
            game: record.game,
            pairSeed: record.pairSeed,
            pickSeed: record.pickSeed,
            battleSeed: record.battleSeed,
            setupFingerprint: record.setupFingerprint,
            behaviorTraceSha256: record.behaviorTraceSha256,
        }));
    return canonicalRankedDraftSha256(traces);
}

export function normalizeRankedDraftGenome(genome: ILeagueGenome, id: string = genome.id): ILeagueGenome {
    const projected = projectDraftGenomeForShipping(genome);
    return createLeagueGenome(id, projected.weights, false, {
        ...(projected.draftInteractionPrior ? { draftInteractionPrior: projected.draftInteractionPrior } : {}),
        ...(projected.draftVarietyPolicy ? { draftVarietyPolicy: projected.draftVarietyPolicy } : {}),
        ...(projected.draftSpellRangedPolicy ? { draftSpellRangedPolicy: projected.draftSpellRangedPolicy } : {}),
    });
}

export function rankedDraftCurrentIncumbent(): ILeagueGenome {
    return normalizeRankedDraftGenome(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC), CURRENT_INCUMBENT_ID);
}

/** Frozen incumbent weights plus the candidate-only, fair-information interaction evidence overlay. */
export function rankedDraftInteractionPriorCandidate(): ILeagueGenome {
    const incumbent = rankedDraftCurrentIncumbent();
    return createLeagueGenome(RANKED_DRAFT_INTERACTION_PRIOR_CANDIDATE_ID, incumbent.weights, false, {
        draftInteractionPrior: RANKED_DRAFT_INTERACTION_PRIOR_ID,
    });
}

/** Frozen incumbent plus public interaction evidence and score-bounded deterministic archetype variety. */
export function rankedDraftVersatileCandidate(): ILeagueGenome {
    const incumbent = rankedDraftCurrentIncumbent();
    return createLeagueGenome(RANKED_DRAFT_VERSATILE_CANDIDATE_ID, incumbent.weights, false, {
        draftInteractionPrior: RANKED_DRAFT_INTERACTION_PRIOR_ID,
        draftVarietyPolicy: RANKED_DRAFT_VARIETY_POLICY_ID,
    });
}

export function rankedDraftA19CalibratedCandidate(): ILeagueGenome {
    return normalizeRankedDraftGenome(RANKED_A19_DRAFT_CANDIDATE, RANKED_DRAFT_A19_CALIBRATED_CANDIDATE_ID);
}

export function rankedDraftA19CasterReplayCandidate(): ILeagueGenome {
    const incumbent = rankedDraftCurrentIncumbent();
    return createLeagueGenome(RANKED_DRAFT_A19_CASTER_REPLAY_CANDIDATE_ID, incumbent.weights, false, {
        draftSpellRangedPolicy: RANKED_SPELL_RANGED_DRAFT_POLICY_ID,
    });
}

export function defaultRankedDraftPool(): IRankedDraftPoolEntry[] {
    return [
        { ...rankedDraftCurrentIncumbent(), prior: 1 },
        {
            ...normalizeRankedDraftGenome(createLeagueGenome(HEURISTIC_ID, LEAGUE_ANCHOR_GENOME), HEURISTIC_ID),
            prior: 1,
        },
        { ...normalizeRankedDraftGenome(createMeleeLeagueGenome(DEFAULT_ID), DEFAULT_ID), prior: 1 },
        { ...normalizeRankedDraftGenome(parseDraftGenome(LEAGUE_ROUND3_DRAFT_SPEC), ROUND3_ID), prior: 1 },
    ];
}

export function loadRankedDraftPool(specifier?: string, cwd: string = process.cwd()): IRankedDraftPoolEntry[] {
    if (!specifier || specifier === "default") return defaultRankedDraftPool();
    const parsed = JSON.parse(readFileSync(resolve(cwd, specifier), "utf8")) as unknown;
    const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown[] }).entries)
          ? (parsed as { entries: unknown[] }).entries
          : undefined;
    if (!entries) throw new TypeError("Ranked draft pool must be an array or { entries: [...] }");
    return entries.map((entry, index) => {
        if (!entry || typeof entry !== "object") throw new TypeError(`Invalid ranked draft pool entry ${index}`);
        const value = entry as {
            id?: unknown;
            weights?: unknown;
            prior?: unknown;
            draftInteractionPrior?: unknown;
            draftVarietyPolicy?: unknown;
            draftSpellRangedPolicy?: unknown;
        };
        const id = typeof value.id === "string" && value.id.trim() ? value.id : `opponent-${index}`;
        if (!Array.isArray(value.weights)) throw new TypeError(`Ranked draft pool entry ${id} omitted weights`);
        if (value.draftInteractionPrior !== undefined && !isRankedDraftInteractionPrior(value.draftInteractionPrior)) {
            throw new TypeError(`Ranked draft pool entry ${id} has an unsupported interaction prior`);
        }
        if (value.draftVarietyPolicy !== undefined && !isRankedDraftVarietyPolicy(value.draftVarietyPolicy)) {
            throw new TypeError(`Ranked draft pool entry ${id} has an unsupported variety policy`);
        }
        if (
            value.draftSpellRangedPolicy !== undefined &&
            !isRankedSpellRangedDraftPolicy(value.draftSpellRangedPolicy)
        ) {
            throw new TypeError(`Ranked draft pool entry ${id} has an unsupported spell-ranged policy`);
        }
        return {
            ...normalizeRankedDraftGenome(
                createLeagueGenome(id, value.weights as number[], false, {
                    ...(value.draftInteractionPrior ? { draftInteractionPrior: value.draftInteractionPrior } : {}),
                    ...(value.draftVarietyPolicy ? { draftVarietyPolicy: value.draftVarietyPolicy } : {}),
                    ...(value.draftSpellRangedPolicy ? { draftSpellRangedPolicy: value.draftSpellRangedPolicy } : {}),
                }),
                id,
            ),
            ...(value.prior === undefined ? {} : { prior: Number(value.prior) }),
        };
    });
}

function normalizeOptions(options: IRankedDraftEvaluationOptions, poolSize: number): INormalizedOptions {
    if (!Number.isInteger(options.gamesPerOpponent) || options.gamesPerOpponent < 8 || options.gamesPerOpponent % 4) {
        throw new RangeError("gamesPerOpponent must be a multiple of four and at least eight");
    }
    if (!Number.isInteger(options.baseSeed) || options.baseSeed < 0 || options.baseSeed > 0xffffffff) {
        throw new RangeError("baseSeed must be an integer in [0, 4294967295]");
    }
    const total = options.gamesPerOpponent * poolSize;
    const seedChannels = (total / 4) * SEED_CHANNELS_PER_BOARD;
    if (options.baseSeed + seedChannels > UINT32_SPACE) {
        throw new RangeError(
            `baseSeed ${options.baseSeed} leaves insufficient 32-bit indexed seed space for ${seedChannels} channels`,
        );
    }
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be positive");
    const mapTypes = options.mapTypes?.length ? [...options.mapTypes] : [...RANKED_DRAFT_LIVE_MAP_TYPES];
    const liveMaps = new Set<number>(RANKED_DRAFT_LIVE_MAP_TYPES);
    if (
        !mapTypes.every((map) => Number.isInteger(map) && liveMaps.has(map)) ||
        new Set(mapTypes).size !== mapTypes.length
    ) {
        throw new RangeError("mapTypes must contain unique live GridVals ids from [1, 3, 4]; WATER (2) is not live");
    }
    const maxLaps = options.maxLaps ?? 60;
    if (!Number.isInteger(maxLaps) || maxLaps < 1) throw new RangeError("maxLaps must be positive");
    const fightProfile = options.fightProfile ?? "v0.7";
    if (fightProfile !== "v0.7" && fightProfile !== "a19") {
        throw new RangeError('fightProfile must be "v0.7" or "a19"');
    }
    const candidateSetupPolicySpec = resolveSetupPolicy(
        options.candidateSetupPolicySpec ?? RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC,
    ).spec;
    const opponentSetupPolicySpec = resolveSetupPolicy(
        options.opponentSetupPolicySpec ?? RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC,
    ).spec;
    return {
        gamesPerOpponent: options.gamesPerOpponent,
        baseSeed: options.baseSeed >>> 0,
        concurrency: Math.min(concurrency, total),
        mapTypes,
        maxLaps,
        fightProfile,
        candidateSetupPolicySpec,
        opponentSetupPolicySpec,
    };
}

/** Bijective Murmur-style finalizer over uint32; unique preimages therefore produce unique simulation seeds. */
export function permuteRankedDraftSeed(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_SPACE) {
        throw new RangeError("Ranked draft seed preimage must be a uint32");
    }
    let mixed = value >>> 0;
    mixed ^= mixed >>> 16;
    mixed = Math.imul(mixed, 0x85ebca6b) >>> 0;
    mixed ^= mixed >>> 13;
    mixed = Math.imul(mixed, 0xc2b2ae35) >>> 0;
    return (mixed ^ (mixed >>> 16)) >>> 0;
}

interface IRankedDraftBoardSeeds {
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
}

export interface IRankedDraftEvaluationTask {
    opponentIndex: number;
    game: number;
    /** Separates targeted guard cells while still indexing the configured opponent pool. */
    seedLaneIndex?: number;
}

export interface IRankedDraftBoardInspection {
    offerBoard: number;
    pairSeed: number;
    pickSeed: number;
    assignments: {
        candidatePickedLeft: boolean;
        candidateCohorts: RankedDraftCohort[];
    }[];
}

function rankedDraftBoardSeeds(
    options: INormalizedOptions,
    opponentIndex: number,
    offerBoard: number,
): IRankedDraftBoardSeeds {
    const boardsPerOpponent = options.gamesPerOpponent / 4;
    const globalBoard = opponentIndex * boardsPerOpponent + offerBoard;
    const firstPreimage = options.baseSeed + globalBoard * SEED_CHANNELS_PER_BOARD;
    if (!Number.isSafeInteger(firstPreimage) || firstPreimage + 2 >= UINT32_SPACE) {
        throw new RangeError("Ranked draft board exceeds its allocated uint32 seed range");
    }
    return {
        pairSeed: permuteRankedDraftSeed(firstPreimage),
        pickSeed: permuteRankedDraftSeed(firstPreimage + 1),
        battleSeed: permuteRankedDraftSeed(firstPreimage + 2),
    };
}

function validateEntrants(candidate: ILeagueGenome, pool: readonly IRankedDraftPoolEntry[]): void {
    normalizeRankedDraftGenome(candidate);
    if (!pool.length) throw new RangeError("Ranked draft pool must not be empty");
    const ids = new Set<string>();
    for (const opponent of pool) {
        normalizeRankedDraftGenome(opponent);
        if (ids.has(opponent.id)) throw new Error(`Duplicate ranked draft opponent ${opponent.id}`);
        if (opponent.prior !== undefined && (!Number.isFinite(opponent.prior) || opponent.prior <= 0)) {
            throw new RangeError(`Ranked draft opponent ${opponent.id} has a non-positive prior`);
        }
        ids.add(opponent.id);
    }
}

const randomInt = (seed: number): PickRandomInt => {
    const rng = makeRng(seed);
    return (maxExclusive) => Math.floor(rng() * maxExclusive);
};

function applyAccepted(state: IPickSimState, action: PickAction, rng: PickRandomInt): IPickSimState {
    const result = transitionPickSim(state, action, rng);
    if (result.status !== "accepted") {
        throw new Error(`Ranked draft policy emitted ${action.type} rejected as ${result.reason}`);
    }
    return result.state;
}

/**
 * Drive the exact ranked pick sequence while restricting each policy difference to the deployable 15-value
 * intrinsic draft head. Tier-2 is selected at live phase sequence 8, when each team has five creatures;
 * recomputing it after the level-4 pick would leak future roster information into the setup policy.
 */
export interface IRankedDraftSetupPolicySpecs {
    left?: string;
    right?: string;
}

export function resolveRankedDraftPick(
    seed: number,
    leftInput: ILeagueGenome,
    rightInput: ILeagueGenome,
    setupPolicySpecs: IRankedDraftSetupPolicySpecs = {},
): IPickSimState {
    const leftGenome = normalizeRankedDraftGenome(leftInput);
    const rightGenome = normalizeRankedDraftGenome(rightInput);
    const leftSetupPolicy = resolveSetupPolicy(setupPolicySpecs.left ?? RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC);
    const rightSetupPolicy = resolveSetupPolicy(setupPolicySpecs.right ?? RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC);
    const rng = randomInt(seed);
    let state = createPickSimState(rng);
    const teamState = (team: PickTeam): IPickTeamState => (team === LEFT ? state.left : state.right);

    const doctrine = SETUP_POLICY_V0.pickDoctrine();
    state = applyAccepted(state, { type: "select_doctrine", team: LEFT, doctrine }, rng);
    state = applyAccepted(state, { type: "select_doctrine", team: RIGHT, doctrine }, rng);

    // Both simultaneous policies decide from the same pre-commit state.
    const leftBundle = pickCoherentDraftBundle(
        state.left.bundles,
        (creatureId) => draftGenomeCreatureScore(leftGenome, creatureId),
        (artifactId) => TIER1_ARTIFACT_WINRATE[artifactId] ?? 50,
        {
            ...(leftGenome.draftSpellRangedPolicy ? { draftSpellRangedPolicy: leftGenome.draftSpellRangedPolicy } : {}),
        },
    );
    const rightBundle = pickCoherentDraftBundle(
        state.right.bundles,
        (creatureId) => draftGenomeCreatureScore(rightGenome, creatureId),
        (artifactId) => TIER1_ARTIFACT_WINRATE[artifactId] ?? 50,
        {
            ...(rightGenome.draftSpellRangedPolicy
                ? { draftSpellRangedPolicy: rightGenome.draftSpellRangedPolicy }
                : {}),
        },
    );
    state = applyAccepted(state, { type: "select_bundle", team: LEFT, bundleIndex: leftBundle }, rng);
    state = applyAccepted(state, { type: "select_bundle", team: RIGHT, bundleIndex: rightBundle }, rng);

    let transitions = 0;
    while (!isPickSimComplete(state)) {
        if ((transitions += 1) > 40) throw new Error("Ranked draft pick exceeded the collision retry guard");
        const phase = getCurrentPickPhase(state);
        if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
            const left = teamState(LEFT);
            const right = teamState(RIGHT);
            const leftArtifact = leftSetupPolicy.pickArtifactT2(left.tier2Offers, left.creatures);
            const rightArtifact = rightSetupPolicy.pickArtifactT2(right.tier2Offers, right.creatures);
            state = applyAccepted(state, { type: "select_tier2", team: LEFT, artifactId: leftArtifact }, rng);
            state = applyAccepted(state, { type: "select_tier2", team: RIGHT, artifactId: rightArtifact }, rng);
            continue;
        }
        if (phase.phase !== PBTypes.PickPhaseVals.PICK || phase.actors.length !== 1) {
            throw new Error(`Unexpected live ranked pick phase ${phase.phase} at sequence ${state.phaseSequence}`);
        }
        const team = phase.actors[0];
        const own = teamState(team);
        const creatureId = pickDraftGenomeCreature(
            team === LEFT ? leftGenome : rightGenome,
            getVisibleCreatureChoices(state, team),
            own.creatures,
            getKnownOpponentCreatures(state, team),
            own.tier1Artifact,
        );
        if (creatureId === undefined) {
            throw new Error(`Ranked draft creature policy found no visible L${phase.creatureLevel} creature`);
        }
        const result = transitionPickSim(state, { type: "pick_creature", team, creatureId }, rng);
        if (result.status === "rejected") {
            throw new Error(`Ranked draft creature policy was rejected as ${result.reason}`);
        }
        state = result.state;
    }
    return state;
}

function rankedDraftRoster(creatureIds: readonly number[]): IArmyUnitSpec[] {
    return creatureIds.map((creatureId) => {
        const info = creatureInfo(creatureId);
        if (!info) throw new Error(`Ranked draft selected unknown creature id ${creatureId}`);
        const catalog = creaturesByLevel(info.level).find((entry) => entry.creatureName === info.name);
        if (!catalog) throw new Error(`Ranked draft selected disabled creature ${info.name}`);
        return {
            faction: catalog.faction,
            creatureName: catalog.creatureName,
            level: catalog.level,
            size: catalog.size,
            amount: resolveStackAmount(catalog.creatureName, catalog.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

function materializeArmy(
    team: IPickTeamState,
    opponentReveals: readonly number[],
    setupPolicy: IResolvedSetupPolicy,
): IRankedDraftArmy {
    if (team.tier1Artifact === undefined) throw new Error("Complete ranked draft omitted Tier-1 artifact");
    if (team.tier2Artifact === undefined) throw new Error("Complete ranked draft omitted Tier-2 artifact");
    const budget = getUpgradePoints(team.doctrine);
    return {
        creatureIds: [...team.creatures],
        revealedOpponentCreatures: [...opponentReveals],
        roster: rankedDraftRoster(team.creatures),
        doctrine: team.doctrine,
        augments: setupPolicy.pickAugments(budget, team.creatures),
        synergies: setupPolicy.pickSynergies(team.creatures),
        tier1Artifact: team.tier1Artifact,
        tier2Artifact: team.tier2Artifact,
    };
}

export function classifyRankedDraftCohorts(creatureIds: readonly number[]): RankedDraftCohort[] {
    let ranged = 0;
    let mage = 0;
    let meleeMagic = 0;
    let aura = 0;
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        const attackType = info ? ATTACK_TYPE_BY_NAME.get(info.name) : undefined;
        if (attackType === "RANGE") ranged += 1;
        if (attackType === "MAGIC") mage += 1;
        if (attackType === "MELEE_MAGIC") meleeMagic += 1;
        if ((info?.auraCount ?? 0) > 0) aura += 1;
    }
    const cohorts: RankedDraftCohort[] = [];
    if (ranged >= 1) cohorts.push("ranged");
    if (mage >= 1) cohorts.push("mage");
    if (meleeMagic >= 1) cohorts.push("melee_magic");
    if (aura >= 1) cohorts.push("aura_heavy");
    return cohorts;
}

function matchConfig(
    green: IRankedDraftArmy,
    red: IRankedDraftArmy,
    seed: number,
    gridType: number,
    maxLaps: number,
    fightProfile: RankedDraftFightProfileId,
): IMatchConfig {
    return {
        greenVersion: fightProfile === "a19" ? "v0.8" : "v0.7",
        redVersion: fightProfile === "a19" ? "v0.8" : "v0.7",
        roster: green.roster,
        redRoster: red.roster,
        seed,
        gridType,
        maxLaps,
        greenDoctrine: green.doctrine,
        redDoctrine: red.doctrine,
        greenAugments: green.augments,
        redAugments: red.augments,
        greenSynergies: green.synergies,
        redSynergies: red.synergies,
        greenArtifactT1: green.tier1Artifact,
        redArtifactT1: red.tier1Artifact,
        greenArtifactT2: green.tier2Artifact,
        redArtifactT2: red.tier2Artifact,
        greenRevealedCreatures: green.revealedOpponentCreatures,
        redRevealedCreatures: red.revealedOpponentCreatures,
    };
}

export function playRankedDraftGame(
    candidateInput: ILeagueGenome,
    opponentInput: IRankedDraftPoolEntry,
    optionsInput: IRankedDraftEvaluationOptions,
    game: number,
    opponentIndex: number = 0,
    dependencies: Partial<IRankedDraftGameDependencies> = {},
    seedLaneIndex: number = opponentIndex,
): IRankedDraftGameRecord {
    const candidate = normalizeRankedDraftGenome(candidateInput);
    const opponent = normalizeRankedDraftGenome(opponentInput);
    if (
        !Number.isInteger(opponentIndex) ||
        opponentIndex < 0 ||
        !Number.isInteger(seedLaneIndex) ||
        seedLaneIndex < 0
    ) {
        throw new RangeError("opponentIndex and seedLaneIndex must be non-negative integers");
    }
    const options = normalizeOptions(optionsInput, seedLaneIndex + 1);
    if (!Number.isInteger(game) || game < 0 || game >= options.gamesPerOpponent) {
        throw new RangeError(`game must be in [0, ${options.gamesPerOpponent})`);
    }
    const offerBoard = Math.floor(game / 4);
    const withinBoard = game % 4;
    const pickAssignment = Math.floor(withinBoard / 2) as 0 | 1;
    const battleMirror = (withinBoard % 2) as 0 | 1;
    const { pairSeed, pickSeed, battleSeed } = rankedDraftBoardSeeds(options, seedLaneIndex, offerBoard);
    const candidatePickedLeft = pickAssignment === 0;
    const leftGenome = candidatePickedLeft ? candidate : opponent;
    const rightGenome = candidatePickedLeft ? opponent : candidate;
    const leftSetupPolicySpec = candidatePickedLeft
        ? options.candidateSetupPolicySpec
        : options.opponentSetupPolicySpec;
    const rightSetupPolicySpec = candidatePickedLeft
        ? options.opponentSetupPolicySpec
        : options.candidateSetupPolicySpec;
    const leftSetupPolicy = resolveSetupPolicy(leftSetupPolicySpec);
    const rightSetupPolicy = resolveSetupPolicy(rightSetupPolicySpec);
    const pick = resolveRankedDraftPick(pickSeed, leftGenome, rightGenome, {
        left: leftSetupPolicy.spec,
        right: rightSetupPolicy.spec,
    });
    const left = materializeArmy(pick.left, getKnownOpponentCreatures(pick, LEFT), leftSetupPolicy);
    const right = materializeArmy(pick.right, getKnownOpponentCreatures(pick, RIGHT), rightSetupPolicy);
    const green = battleMirror ? right : left;
    const red = battleMirror ? left : right;
    const candidateIsGreen = battleMirror ? !candidatePickedLeft : candidatePickedLeft;
    const candidateArmy = candidatePickedLeft ? left : right;
    const gridType = options.mapTypes[(offerBoard + seedLaneIndex) % options.mapTypes.length];
    const result = (dependencies.matchRunner ?? DEFAULT_DEPENDENCIES.matchRunner)(
        matchConfig(green, red, battleSeed, gridType, options.maxLaps, options.fightProfile),
    );
    const candidateSide: Side = candidateIsGreen ? "green" : "red";
    const candidateResult = result.winner === "draw" ? "draw" : result.winner === candidateSide ? "win" : "loss";
    return {
        opponentId: opponent.id,
        game,
        offerBoard,
        pickSeat: candidatePickedLeft ? "candidate-lower" : "candidate-upper",
        battleMirror,
        setupFingerprint: createHash("sha256").update(JSON.stringify({ left, right, gridType })).digest("hex"),
        behaviorTraceSha256: rankedDraftBehaviorTraceSha256(result),
        pairSeed,
        pickSeed,
        battleSeed,
        gridType,
        candidateSide,
        winner: result.winner,
        candidateResult,
        laps: result.laps,
        endReason: result.endReason,
        collisions: pick.transcript.filter((entry) => entry.type === "creature_collision").length,
        candidateCohorts: classifyRankedDraftCohorts(candidateArmy.creatureIds),
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        rejectedCandidate: (candidateIsGreen ? result.rejectedGreen : result.rejectedRed) ?? 0,
        rejectedOpponent: (candidateIsGreen ? result.rejectedRed : result.rejectedGreen) ?? 0,
    };
}

/** Inspect only the frozen candidate's picked rosters. No fight is run and no outcome can affect selection. */
export function inspectRankedDraftBoard(
    candidateInput: ILeagueGenome,
    opponentInput: IRankedDraftPoolEntry,
    optionsInput: IRankedDraftEvaluationOptions,
    offerBoard: number,
    seedLaneIndex: number,
): IRankedDraftBoardInspection {
    const candidate = normalizeRankedDraftGenome(candidateInput);
    const opponent = normalizeRankedDraftGenome(opponentInput);
    if (!Number.isInteger(seedLaneIndex) || seedLaneIndex < 0) {
        throw new RangeError("seedLaneIndex must be a non-negative integer");
    }
    const options = normalizeOptions(optionsInput, seedLaneIndex + 1);
    const boards = options.gamesPerOpponent / 4;
    if (!Number.isInteger(offerBoard) || offerBoard < 0 || offerBoard >= boards) {
        throw new RangeError(`offerBoard must be in [0, ${boards})`);
    }
    const { pairSeed, pickSeed } = rankedDraftBoardSeeds(options, seedLaneIndex, offerBoard);
    const assignments = ([true, false] as const).map((candidatePickedLeft) => {
        const leftGenome = candidatePickedLeft ? candidate : opponent;
        const rightGenome = candidatePickedLeft ? opponent : candidate;
        const pick = resolveRankedDraftPick(pickSeed, leftGenome, rightGenome, {
            left: candidatePickedLeft ? options.candidateSetupPolicySpec : options.opponentSetupPolicySpec,
            right: candidatePickedLeft ? options.opponentSetupPolicySpec : options.candidateSetupPolicySpec,
        });
        const candidateTeam = candidatePickedLeft ? pick.left : pick.right;
        return {
            candidatePickedLeft,
            candidateCohorts: classifyRankedDraftCohorts(candidateTeam.creatures),
        };
    });
    return { offerBoard, pairSeed, pickSeed, assignments };
}

export function clusteredRankedDraftConfidence95(
    records: readonly Pick<IRankedDraftGameRecord, "pairSeed" | "candidateResult">[],
): {
    low: number;
    high: number;
} {
    const wins = records.filter((record) => record.candidateResult === "win").length;
    const losses = records.filter((record) => record.candidateResult === "loss").length;
    const decisive = wins + losses;
    if (!decisive) return { low: 0, high: 1 };
    const point = wins / decisive;
    const clusters = new Map<number, Pick<IRankedDraftGameRecord, "pairSeed" | "candidateResult">[]>();
    for (const record of records) {
        const values = clusters.get(record.pairSeed) ?? [];
        values.push(record);
        clusters.set(record.pairSeed, values);
    }
    const decisiveClusters = [...clusters.values()].filter((cluster) =>
        cluster.some((record) => record.candidateResult !== "draw"),
    );
    if (decisiveClusters.length < 2) return { low: 0, high: 1 };
    let residualSquares = 0;
    for (const cluster of decisiveClusters) {
        const clusterWins = cluster.filter((record) => record.candidateResult === "win").length;
        const clusterLosses = cluster.filter((record) => record.candidateResult === "loss").length;
        residualSquares += (clusterWins - point * (clusterWins + clusterLosses)) ** 2;
    }
    const z = 1.96;
    const standardError =
        Math.sqrt((decisiveClusters.length / (decisiveClusters.length - 1)) * residualSquares) / decisive;
    const normal = { low: Math.max(0, point - z * standardError), high: Math.min(1, point + z * standardError) };
    const z2 = z * z;
    const effective = decisiveClusters.length;
    const center = point + z2 / (2 * effective);
    const spread = z * Math.sqrt((point * (1 - point) + z2 / (4 * effective)) / effective);
    const wilson = {
        low: Math.max(0, (center - spread) / (1 + z2 / effective)),
        high: Math.min(1, (center + spread) / (1 + z2 / effective)),
    };
    return { low: Math.min(normal.low, wilson.low), high: Math.max(normal.high, wilson.high) };
}

function validateRankedDraftRecords(
    pool: readonly IRankedDraftPoolEntry[],
    options: INormalizedOptions,
    records: readonly IRankedDraftGameRecord[],
): void {
    const expectedTotal = pool.length * options.gamesPerOpponent;
    if (records.length !== expectedTotal) {
        throw new Error(`Ranked draft panel has ${records.length}/${expectedTotal} games`);
    }
    const expectedOpponentIds = new Set(pool.map((opponent) => opponent.id));
    const simulationSeeds = new Set<number>();
    for (const record of records) {
        if (!expectedOpponentIds.has(record.opponentId)) {
            throw new Error(`Ranked draft panel contains unexpected opponent ${record.opponentId}`);
        }
        const expectedResult =
            record.winner === "draw" ? "draw" : record.winner === record.candidateSide ? "win" : "loss";
        if (record.candidateResult !== expectedResult) {
            throw new Error(`${record.opponentId} game ${record.game} has inconsistent winner attribution`);
        }
    }
    pool.forEach((opponent, opponentIndex) => {
        const own = records.filter((record) => record.opponentId === opponent.id);
        const boards = options.gamesPerOpponent / 4;
        for (let offerBoard = 0; offerBoard < boards; offerBoard += 1) {
            const cluster = own
                .filter((record) => record.offerBoard === offerBoard)
                .sort((left, right) => left.game - right.game);
            if (cluster.length !== 4) {
                throw new Error(`${opponent.id} offer board ${offerBoard} has ${cluster.length}/4 records`);
            }
            const expectedSeeds = rankedDraftBoardSeeds(options, opponentIndex, offerBoard);
            const expectedGridType = options.mapTypes[(offerBoard + opponentIndex) % options.mapTypes.length];
            const expectedSeats = ["candidate-lower", "candidate-lower", "candidate-upper", "candidate-upper"];
            const expectedMirrors = [0, 1, 0, 1];
            const expectedSides: Side[] = ["green", "red", "red", "green"];
            cluster.forEach((record, index) => {
                if (
                    record.game !== offerBoard * 4 + index ||
                    record.pairSeed !== expectedSeeds.pairSeed ||
                    record.pickSeed !== expectedSeeds.pickSeed ||
                    record.gridType !== expectedGridType ||
                    record.pickSeat !== expectedSeats[index] ||
                    record.battleMirror !== expectedMirrors[index] ||
                    record.candidateSide !== expectedSides[index] ||
                    record.battleSeed !== expectedSeeds.battleSeed
                ) {
                    throw new Error(`${opponent.id} offer board ${offerBoard} failed paired-mirror integrity`);
                }
            });
            for (const start of [0, 2]) {
                if (
                    cluster[start].setupFingerprint !== cluster[start + 1].setupFingerprint ||
                    cluster[start].collisions !== cluster[start + 1].collisions ||
                    JSON.stringify(cluster[start].candidateCohorts) !==
                        JSON.stringify(cluster[start + 1].candidateCohorts)
                ) {
                    throw new Error(`${opponent.id} offer board ${offerBoard} changed setup across battle mirror`);
                }
            }
            for (const seed of [expectedSeeds.pairSeed, expectedSeeds.pickSeed, expectedSeeds.battleSeed]) {
                if (simulationSeeds.has(seed)) {
                    throw new Error(`${opponent.id} offer board ${offerBoard} collided with another panel seed`);
                }
                simulationSeeds.add(seed);
            }
        }
    });
}

export function summarizeRankedDraftRecords(
    candidateInput: ILeagueGenome,
    poolInput: readonly IRankedDraftPoolEntry[],
    optionsInput: IRankedDraftEvaluationOptions,
    records: readonly IRankedDraftGameRecord[],
): IRankedDraftEvaluationReport {
    const candidate = normalizeRankedDraftGenome(candidateInput);
    const pool = poolInput.map((opponent) => ({ ...normalizeRankedDraftGenome(opponent), prior: opponent.prior }));
    validateEntrants(candidate, pool);
    const options = normalizeOptions(optionsInput, pool.length);
    validateRankedDraftRecords(pool, options, records);
    const opponents = pool.map((opponent): IRankedDraftOpponentSummary => {
        const own = records.filter((record) => record.opponentId === opponent.id);
        if (own.length !== options.gamesPerOpponent) {
            throw new Error(`Ranked draft opponent ${opponent.id} has ${own.length}/${options.gamesPerOpponent} games`);
        }
        const wins = own.filter((record) => record.candidateResult === "win").length;
        const losses = own.filter((record) => record.candidateResult === "loss").length;
        const draws = own.length - wins - losses;
        const decisiveGames = wins + losses;
        const confidence95 = clusteredRankedDraftConfidence95(own);
        const endReasons = { elimination: 0, turn_cap: 0, stuck: 0 };
        for (const record of own) endReasons[record.endReason] += 1;
        return {
            opponentId: opponent.id,
            games: own.length,
            offerBoards: own.length / 4,
            wins,
            losses,
            draws,
            decisiveGames,
            decisiveWinRate: decisiveGames ? wins / decisiveGames : 0.5,
            confidence95,
            clusteredLowerBound: confidence95.low,
            drawOrArmageddonRate:
                own.filter((record) => record.candidateResult === "draw" || record.decidedByArmageddon).length /
                own.length,
            rejectedCandidate: own.reduce((sum, record) => sum + record.rejectedCandidate, 0),
            rejectedOpponent: own.reduce((sum, record) => sum + record.rejectedOpponent, 0),
            avgLaps: own.reduce((sum, record) => sum + record.laps, 0) / own.length,
            endReasons,
        };
    });
    const maps = options.mapTypes.map((mapType): IRankedDraftMapSummary => {
        const own = records.filter((record) => record.gridType === mapType);
        const wins = own.filter((record) => record.candidateResult === "win").length;
        const losses = own.filter((record) => record.candidateResult === "loss").length;
        const decisiveGames = wins + losses;
        const confidence95 = clusteredRankedDraftConfidence95(own);
        const endReasons = { elimination: 0, turn_cap: 0, stuck: 0 };
        for (const record of own) endReasons[record.endReason] += 1;
        return {
            mapType,
            games: own.length,
            offerBoards: new Set(own.map((record) => record.pairSeed)).size,
            wins,
            losses,
            draws: own.length - decisiveGames,
            decisiveGames,
            decisiveWinRate: decisiveGames ? wins / decisiveGames : 0.5,
            confidence95,
            clusteredLowerBound: confidence95.low,
            drawOrArmageddonRate: own.length
                ? own.filter((record) => record.candidateResult === "draw" || record.decidedByArmageddon).length /
                  own.length
                : 0,
            rejectedCandidate: own.reduce((sum, record) => sum + record.rejectedCandidate, 0),
            rejectedOpponent: own.reduce((sum, record) => sum + record.rejectedOpponent, 0),
            avgLaps: own.length ? own.reduce((sum, record) => sum + record.laps, 0) / own.length : 0,
            endReasons,
        };
    });
    const cohortNames: RankedDraftCohort[] = ["ranged", "mage", "melee_magic", "aura_heavy"];
    const cohorts = cohortNames.map((cohort): IRankedDraftCohortSummary => {
        const own = records.filter((record) => record.candidateCohorts.includes(cohort));
        const wins = own.filter((record) => record.candidateResult === "win").length;
        const losses = own.filter((record) => record.candidateResult === "loss").length;
        const decisiveGames = wins + losses;
        return {
            cohort,
            games: own.length,
            wins,
            losses,
            draws: own.length - decisiveGames,
            decisiveGames,
            decisiveWinRate: decisiveGames ? wins / decisiveGames : 0.5,
            confidence95: own.length >= 8 ? clusteredRankedDraftConfidence95(own) : null,
        };
    });
    const worst = opponents.reduce((left, right) =>
        right.clusteredLowerBound < left.clusteredLowerBound ? right : left,
    );
    const aggregateEndReasons = { elimination: 0, turn_cap: 0, stuck: 0 };
    for (const record of records) aggregateEndReasons[record.endReason] += 1;
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidateId: candidate.id,
        totalGames: records.length,
        options: {
            gamesPerOpponent: options.gamesPerOpponent,
            baseSeed: options.baseSeed,
            concurrency: options.concurrency,
            fightProfile: options.fightProfile,
            fightVersion: options.fightProfile === "a19" ? "v0.8" : "v0.7",
            maxLaps: options.maxLaps,
            mapTypes: options.mapTypes,
            setupRules: "all",
            candidateSetupPolicySpec: options.candidateSetupPolicySpec,
            opponentSetupPolicySpec: options.opponentSetupPolicySpec,
            draftDimensions: { offset: RANKED_DRAFT_INTRINSIC_OFFSET, length: RANKED_DRAFT_INTRINSIC_DIM },
            clusterSize: 4,
            seedAllocation: "indexed-bijective-v1",
            seedChannelsPerBoard: 3,
            commonBattleSeed: true,
            behaviorTrace: "canonical-sha256-v1",
            executedActionsRecorded: true,
        },
        opponents,
        maps,
        cohortDefinitions: { ...RANKED_DRAFT_COHORT_DEFINITIONS },
        cohorts,
        aggregate: {
            fitness: worst.clusteredLowerBound,
            worstCaseLowerBound: worst.clusteredLowerBound,
            worstCaseOpponent: worst.opponentId,
            rejectedCandidate: opponents.reduce((sum, opponent) => sum + opponent.rejectedCandidate, 0),
            rejectedOpponent: opponents.reduce((sum, opponent) => sum + opponent.rejectedOpponent, 0),
            drawOrArmageddonRate:
                records.filter((record) => record.candidateResult === "draw" || record.decidedByArmageddon).length /
                records.length,
            avgLaps: records.reduce((sum, record) => sum + record.laps, 0) / records.length,
            endReasons: aggregateEndReasons,
            behaviorTraceSetSha256: rankedDraftBehaviorTraceSetSha256(records),
        },
        qualification: "Research-only exact ranked draft evaluation; no candidate is baked or promoted by this report.",
    };
}

interface IWorkerData {
    rankedDraftEvaluationWorker: true;
    candidate: ILeagueGenome;
    pool: IRankedDraftPoolEntry[];
    options: INormalizedOptions;
}

type WorkerMessage = { type: "ready" } | { type: "result"; record: IRankedDraftGameRecord };

/** Remove ambient experiment overrides before workers import fight-policy modules. */
export function sanitizedRankedDraftEnvironment(
    source: NodeJS.ProcessEnv = process.env,
    fightProfile: RankedDraftFightProfileId = "v0.7",
): NodeJS.ProcessEnv {
    const environment = { ...source };
    const explicitMeasurementKeys = new Set(["VALUE_DATA", "FORCE_CREATURES", "LIVETWIN", "SIM_NO_ACTIONS"]);
    for (const key of Object.keys(environment)) {
        if (/^(?:V\d+_|SEARCH_|Q\d+_|CEM_|FIGHT_|ROSTER_|AUGCA_)/.test(key) || explicitMeasurementKeys.has(key)) {
            delete environment[key];
        }
    }
    const profileEnvironment = fightProfile === "a19" ? buildV08A19SearchEnvironment() : {};
    return {
        ...environment,
        ...Object.fromEntries(Object.entries(profileEnvironment).filter(([, value]) => value !== undefined)),
    };
}

export function evaluateRankedDraftTasks(
    candidateInput: ILeagueGenome,
    poolInput: readonly IRankedDraftPoolEntry[],
    optionsInput: IRankedDraftEvaluationOptions,
    tasksInput: readonly IRankedDraftEvaluationTask[],
): Promise<IRankedDraftGameRecord[]> {
    const candidate = normalizeRankedDraftGenome(candidateInput);
    const pool = poolInput.map((opponent) => ({ ...normalizeRankedDraftGenome(opponent), prior: opponent.prior }));
    validateEntrants(candidate, pool);
    const tasks = tasksInput.map((task) => ({ ...task, seedLaneIndex: task.seedLaneIndex ?? task.opponentIndex }));
    const seedLaneCount = Math.max(pool.length, ...tasks.map((task) => task.seedLaneIndex + 1));
    const options = normalizeOptions(optionsInput, seedLaneCount);
    const identities = new Set<string>();
    for (const task of tasks) {
        if (
            !Number.isInteger(task.opponentIndex) ||
            task.opponentIndex < 0 ||
            task.opponentIndex >= pool.length ||
            !Number.isInteger(task.seedLaneIndex) ||
            task.seedLaneIndex < 0 ||
            !Number.isInteger(task.game) ||
            task.game < 0 ||
            task.game >= options.gamesPerOpponent
        ) {
            throw new RangeError("Ranked draft evaluation task is outside its pool, seed lane, or game range");
        }
        const identity = `${task.opponentIndex}:${task.seedLaneIndex}:${task.game}`;
        if (identities.has(identity)) throw new Error(`Duplicate ranked draft evaluation task ${identity}`);
        identities.add(identity);
    }
    if (!tasks.length) return Promise.resolve([]);
    return new Promise((resolvePromise, rejectPromise) => {
        const records: IRankedDraftGameRecord[] = [];
        const workers: Worker[] = [];
        const intentionallyDraining = new WeakSet<Worker>();
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= tasks.length) {
                intentionallyDraining.add(worker);
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", task: tasks[dispatched++] });
        };
        const environment = {
            ...sanitizedRankedDraftEnvironment(process.env, options.fightProfile),
            LIVETWIN: "1",
        };
        for (let index = 0; index < Math.min(options.concurrency, tasks.length); index += 1) {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: { rankedDraftEvaluationWorker: true, candidate, pool, options } satisfies IWorkerData,
                env: environment,
            });
            workers.push(worker);
            worker.on("message", (message: WorkerMessage) => {
                if (settled) return;
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                completed += 1;
                if (completed === tasks.length) {
                    settled = true;
                    cleanup();
                    records.sort(
                        (left, right) =>
                            left.opponentId.localeCompare(right.opponentId) ||
                            left.pairSeed - right.pairSeed ||
                            left.game - right.game,
                    );
                    resolvePromise(records);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && (!intentionallyDraining.has(worker) || code !== 0)) {
                    fail(new Error(`Ranked draft worker exited unexpectedly with code ${code}`));
                }
            });
        }
    });
}

export async function evaluateRankedDraftCandidate(
    candidateInput: ILeagueGenome,
    poolInput: readonly IRankedDraftPoolEntry[],
    optionsInput: IRankedDraftEvaluationOptions,
): Promise<IRankedDraftEvaluationReport> {
    const candidate = normalizeRankedDraftGenome(candidateInput);
    const pool = poolInput.map((opponent) => ({ ...normalizeRankedDraftGenome(opponent), prior: opponent.prior }));
    validateEntrants(candidate, pool);
    const options = normalizeOptions(optionsInput, pool.length);
    const tasks = Array.from({ length: options.gamesPerOpponent * pool.length }, (_, index) => ({
        opponentIndex: Math.floor(index / options.gamesPerOpponent),
        game: index % options.gamesPerOpponent,
    }));
    const records = await evaluateRankedDraftTasks(candidate, pool, options, tasks);
    return summarizeRankedDraftRecords(candidate, pool, options, records);
}

interface ICliOptions extends IRankedDraftEvaluationOptions {
    candidate: ILeagueGenome;
    pool: IRankedDraftPoolEntry[];
    outputPath?: string;
}

function parseCli(argv: readonly string[]): ICliOptions {
    const values = new Map<string, string>();
    const allowed = new Set([
        "candidate",
        "candidate-json",
        "pool",
        "games",
        "seed",
        "concurrency",
        "maps",
        "fight-profile",
        "candidate-setup",
        "opponent-setup",
        "output",
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument ${argument}`);
        const [key, inline] = argument.slice(2).split("=", 2);
        if (!allowed.has(key)) throw new Error(`Unknown option --${key}`);
        const value = inline ?? argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
        values.set(key, value);
    }
    const candidateJson = values.get("candidate-json");
    const candidateSpec = candidateJson ?? values.get("candidate");
    if (!candidateSpec) throw new Error("--candidate or --candidate-json is required");
    const candidate = normalizeRankedDraftGenome(parseDraftGenome(candidateSpec, "ranked-draft-candidate"));
    return {
        candidate,
        pool: loadRankedDraftPool(values.get("pool")),
        gamesPerOpponent: Number(values.get("games") ?? 4000),
        baseSeed: Number(values.get("seed") ?? 1),
        concurrency: Number(values.get("concurrency") ?? Math.max(1, availableParallelism() - 2)),
        mapTypes: (values.get("maps") ?? RANKED_DRAFT_LIVE_MAP_TYPES.join(",")).split(",").map(Number),
        ...(values.get("fight-profile")
            ? { fightProfile: values.get("fight-profile") as RankedDraftFightProfileId }
            : {}),
        ...(values.get("candidate-setup") ? { candidateSetupPolicySpec: values.get("candidate-setup") } : {}),
        ...(values.get("opponent-setup") ? { opponentSetupPolicySpec: values.get("opponent-setup") } : {}),
        ...(values.get("output") ? { outputPath: resolve(values.get("output")!) } : {}),
    };
}

async function cliMain(): Promise<void> {
    const options = parseCli(process.argv.slice(2));
    const report = await evaluateRankedDraftCandidate(options.candidate, options.pool, options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, json);
    }
    process.stdout.write(json);
}

function workerMain(data: IWorkerData): void {
    if (!parentPort) throw new Error("Ranked draft worker requires parentPort");
    parentPort.on(
        "message",
        (message: { type: "game"; task: Required<IRankedDraftEvaluationTask> } | { type: "stop" }) => {
            if (message.type === "stop") {
                parentPort!.close();
                return;
            }
            const { task } = message;
            const opponent = data.pool[task.opponentIndex];
            const record = playRankedDraftGame(
                data.candidate,
                opponent,
                data.options,
                task.game,
                task.opponentIndex,
                {},
                task.seedLaneIndex,
            );
            parentPort!.postMessage({ type: "result", record });
        },
    );
    parentPort.postMessage({ type: "ready" });
}

if (!isMainThread && (workerData as Partial<IWorkerData> | undefined)?.rankedDraftEvaluationWorker) {
    workerMain(workerData as IWorkerData);
} else if (import.meta.main) {
    cliMain().catch((error) => {
        console.error(error);
        process.exitCode = 2;
    });
}
