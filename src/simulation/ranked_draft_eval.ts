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
    pickRankedLiveDraftCreature,
    projectDraftGenomeForShipping,
    RANKED_VERSATILE_DRAFT_SPEC,
} from "../ai/setup/draft_ship";
import { RANKED_A19_DRAFT_CANDIDATE, RANKED_A19_DRAFT_CANDIDATE_ID } from "../ai/setup/ranked_a19_draft_candidate";
import { pickCoherentDraftBundle } from "../ai/setup/draft_coherence";
import { isRankedDraftInteractionPrior, RANKED_DRAFT_INTERACTION_PRIOR_ID } from "../ai/setup/draft_interaction_prior";
import { isRankedDraftVarietyPolicy, RANKED_DRAFT_VARIETY_POLICY_ID } from "../ai/setup/draft_variety";
import {
    rankedDraftUsesCorrectedTier1Table,
    isRankedDraftStrengthPolicy,
    type RankedDraftStrengthPolicyId,
} from "../ai/setup/draft_strength_prior";
import { resolveSetupPolicy, type IResolvedSetupPolicy } from "../ai/setup/setup_ship";
import { creatureInfo } from "../ai/setup/creature_score";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { TIER1_ARTIFACT_WINRATE, TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED } from "../ai/setup/setup_strategy";
import { buildV08A19SearchEnvironment } from "../ai/versions/v0_8_a19_profile";
import { pickRankedAIDoctrine } from "../ai/setup/doctrine_variety";
import { PBTypes } from "../generated/protobuf/v1/types";
import { Doctrine, getUpgradePoints } from "../doctrines/doctrine_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    getKnownOpponentCreatures,
    getVisibleCreatureChoices,
    isPickSimComplete,
    LIVE_TIER1_ARTIFACT_IDS,
    LIVE_TIER2_ARTIFACT_IDS,
    transitionPickSim,
    type IPickSimState,
    type IPickTeamState,
    type PickAction,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { CreatureFactions } from "../generated/protobuf/v1/creature_gen";
import { ToFactionName } from "../factions/faction_type";
import {
    NatureSynergy,
    SynergyKeysToPower,
    synergyVariantsForSeed,
    type SpecificSynergy,
} from "../synergies/synergy_properties";
import { creaturesByLevel, DEFAULT_AMOUNT_BY_LEVEL, makeRng, resolveStackAmount, type IArmyUnitSpec } from "./army";
import { materializeTacticalSplitRoster } from "./ranked_replay_tactics_ab_core";
import {
    GREEN_TEAM,
    RED_TEAM,
    runMatch,
    type IMatchConfig,
    type ITacticalSplitRosterStack,
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
/** The draft the ranked server runs today (HOC_DRAFT_WEIGHTS unset), under this panel's own id. */
export const RANKED_DRAFT_LIVE_INCUMBENT_ID = "ranked-live-incumbent";
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

/**
 * How a seat takes its scouting doctrine: always one doctrine, or the live bot's per-match variety
 * (`pickRankedAIDoctrine`). Every panel before this option gave both seats `SETUP_POLICY_V0.pickDoctrine()`,
 * which is `see-none`, so that stays the default.
 */
export type RankedDraftDoctrinePolicy = "see-none" | "see-all" | "three-reveals" | "ranked-variety";
export const RANKED_DRAFT_DOCTRINE_POLICIES: readonly RankedDraftDoctrinePolicy[] = [
    "see-none",
    "see-all",
    "three-reveals",
    "ranked-variety",
];
export const RANKED_DRAFT_DEFAULT_DOCTRINE_POLICY: RankedDraftDoctrinePolicy = "see-none";

/** The doctrine a seat takes on one board. The board's pick seed stands in for the live match id. */
export function resolveRankedDraftDoctrine(
    policy: RankedDraftDoctrinePolicy,
    pickSeed: number,
    team: PickTeam,
): Doctrine {
    switch (policy) {
        case "see-none":
            return Doctrine.SEE_NONE;
        case "see-all":
            return Doctrine.SEE_ALL;
        case "three-reveals":
            return Doctrine.THREE_REVEALS;
        case "ranked-variety":
            return pickRankedAIDoctrine({ matchId: String(pickSeed), team, aiVersion: "v0.8" });
    }
}

const rankedDraftDoctrinePolicy = (value: string | undefined): RankedDraftDoctrinePolicy => {
    const policy = value ?? RANKED_DRAFT_DEFAULT_DOCTRINE_POLICY;
    if (!(RANKED_DRAFT_DOCTRINE_POLICIES as readonly string[]).includes(policy)) {
        throw new RangeError(`doctrine policy must be one of ${RANKED_DRAFT_DOCTRINE_POLICIES.join(", ")}`);
    }
    return policy as RankedDraftDoctrinePolicy;
};

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
    /** Only when the panel records armies: what each seat drafted, for unit-strength fitting. */
    armies?: { candidate: IRankedDraftRecordedArmy; opponent: IRankedDraftRecordedArmy };
    /** Only with live synergy variants: the variant each faction fielded on this board (faction name -> id). */
    synergyVariants?: { [factionName: string]: SpecificSynergy };
    /** Only with the live split pass: how many one-model stacks each seat split off. */
    splitStacks?: { candidate: number; opponent: number };
}

export interface IRankedDraftRecordedArmy {
    creatureIds: number[];
    tier1Artifact: number;
    tier2Artifact: number;
    /** With a Tier-2 override only: the three artifacts the draft offered and the one the setup policy took. */
    tier2Offers?: number[];
    policyTier2Artifact?: number;
    /** With a synergy override only: the synergies the candidate fought with and the ones its setup policy took. */
    synergies?: ISetupSynergy[];
    policySynergies?: ISetupSynergy[];
    /** With an augment override only: the augments the candidate fought with and the ones its setup policy took. */
    augments?: ISetupAugment[];
    policyAugments?: ISetupAugment[];
}

const RANKED_DRAFT_AUGMENT_KINDS: readonly ISetupAugment["kind"][] = [
    "Placement",
    "Armor",
    "Might",
    "Empower",
    "Sniper",
    "Movement",
];

/** Check an augment plan: known kinds, each once, levels 1..3, at most the largest doctrine budget (7 points). */
export function validateRankedDraftAugmentOverride(plan: readonly ISetupAugment[]): ISetupAugment[] {
    const kinds = new Set<string>();
    let total = 0;
    for (const augment of plan) {
        if (!RANKED_DRAFT_AUGMENT_KINDS.includes(augment.kind) || kinds.has(augment.kind)) {
            throw new RangeError(`augment override: unknown or repeated kind ${augment.kind}`);
        }
        if (!Number.isInteger(augment.value) || augment.value < 1 || augment.value > 3) {
            throw new RangeError(`augment override: ${augment.kind} level must be 1..3`);
        }
        kinds.add(augment.kind);
        total += augment.value;
    }
    if (!plan.length || total > getUpgradePoints(Doctrine.SEE_NONE)) {
        throw new RangeError(
            `augment override must spend 1..${getUpgradePoints(Doctrine.SEE_NONE)} points, got ${total}`,
        );
    }
    return plan.map((augment) => ({ kind: augment.kind, value: augment.value }));
}

/** Parse "Sniper:3,Armor:3,Empower:1" into a validated augment plan. */
export function parseRankedDraftAugmentOverride(spec: string): ISetupAugment[] {
    return validateRankedDraftAugmentOverride(
        spec
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
                const [kind, value] = entry.split(":");
                const match = RANKED_DRAFT_AUGMENT_KINDS.find(
                    (known) => known.toLowerCase() === kind?.trim().toLowerCase(),
                );
                if (!match) throw new RangeError(`augment override "${entry}" names no augment`);
                return { kind: match, value: Number(value) };
            }),
    );
}

/** The synergy factions and their two options (FactionVals id -> the faction's SpecificSynergy ids). */
export const RANKED_DRAFT_SYNERGY_OPTIONS: Readonly<Record<number, readonly number[]>> = {
    [PBTypes.FactionVals.LIFE]: [1, 2],
    [PBTypes.FactionVals.CHAOS]: [1, 2],
    [PBTypes.FactionVals.MIGHT]: [1, 2],
    [PBTypes.FactionVals.NATURE]: [1, 2],
};

/** Check a FactionVals id -> synergy option map against the options the fight can apply; returns a plain copy. */
export function validateRankedDraftSynergyOverride(override: Readonly<Record<number, number>>): Record<number, number> {
    const checked: Record<number, number> = {};
    for (const [key, option] of Object.entries(override)) {
        const faction = Number(key);
        if (!RANKED_DRAFT_SYNERGY_OPTIONS[faction]?.includes(option)) {
            throw new RangeError(`synergy override ${key}:${option} needs a synergy faction and option 1 or 2`);
        }
        checked[faction] = option;
    }
    if (!Object.keys(checked).length) throw new RangeError("synergy override is empty");
    return checked;
}

/** Parse "NATURE:1,CHAOS:2" (faction names) into a validated FactionVals id -> synergy option map. */
export function parseRankedDraftSynergyOverride(spec: string): Record<number, number> {
    const override: Record<number, number> = {};
    for (const part of spec
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        const [name, value] = part.split(":");
        const faction = (PBTypes.FactionVals as unknown as Record<string, unknown>)[name?.trim().toUpperCase() ?? ""];
        if (typeof faction !== "number") throw new RangeError(`synergy override "${part}" names no faction`);
        override[faction] = Number(value);
    }
    return validateRankedDraftSynergyOverride(override);
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
        /** Present only when a seat does not take the default `see-none`, so older reports reproduce exactly. */
        candidateDoctrinePolicy?: RankedDraftDoctrinePolicy;
        opponentDoctrinePolicy?: RankedDraftDoctrinePolicy;
        /** Present only when the candidate's Tier-2 artifact is forced. */
        candidateTier2Override?: number;
        /** Present only when the candidate's Tier-1 artifact is forced. */
        candidateTier1Override?: number;
        /** Present only when the candidate's synergy options are forced (FactionVals id -> option). */
        candidateSynergyOverride?: Record<number, number>;
        /** Present only when the candidate's augment plan is forced. */
        candidateAugmentsOverride?: ISetupAugment[];
        /** Present only when set, so older reports reproduce exactly. */
        liveSynergyVariants?: true;
        tacticalSplits?: true;
        candidateSkipsSplits?: true;
        candidateSearchEnvOverrides?: Record<string, string>;
        draftDimensions: { offset: number; length: number };
        clusterSize: 4;
        seedAllocation: "indexed-bijective-v1";
        seedChannelsPerBoard: 3;
        commonBattleSeed: true;
        behaviorTrace: "canonical-sha256-v1";
        executedActionsRecorded: true;
        liveDraftRules: boolean;
        sideBoard: boolean;
        deterministicSearch: boolean;
        explorationRate: number;
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
    /** Each seat's scouting doctrine; both default to `see-none`. */
    candidateDoctrinePolicy?: RankedDraftDoctrinePolicy;
    opponentDoctrinePolicy?: RankedDraftDoctrinePolicy;
    /**
     * Give the candidate this Tier-2 artifact after the draft, whatever was offered (measurement only). The
     * artifact is chosen after the level-3 picks and nothing later in the draft or setup reads it, so replacing
     * it after the draft leaves the drafted armies, augments and synergies exactly as they were.
     */
    candidateTier2Override?: number;
    candidateTier1Override?: number;
    /**
     * Give the candidate these synergy options (FactionVals id -> option) wherever its army qualifies for that
     * faction's synergy (measurement only). The level still follows the unit count, and nothing in the draft reads
     * the choice, so only the option changes.
     */
    candidateSynergyOverride?: Readonly<Record<number, number>>;
    /**
     * Give the candidate this augment plan instead of its setup policy's (measurement only). Augments are chosen after
     * the draft and nothing in the draft reads them. The plan must fit the candidate's doctrine budget.
     */
    candidateAugmentsOverride?: readonly ISetupAugment[];
    /**
     * Live synergies: every board draws one variant per faction from its pick seed (synergyVariantsForSeed, as the
     * ranked server draws them from the game id), and each faction an army fields at level 1 or more plays that
     * variant. Without it the fight keeps DEFAULT_SYNERGY_VARIANTS plus whatever the setup policy picked.
     */
    liveSynergyVariants?: boolean;
    /**
     * Live split pass (requires liveSynergyVariants): each seat fills the stack slots its Placement augment and a
     * Nature board-units synergy open with the server's tactical split planner, and a Placement augment re-deploys
     * in the widened zone (the server's setup-before-placement timing).
     */
    tacticalSplits?: boolean;
    /** Research, with tacticalSplits: the candidate leaves its extra stack slots empty (the opponent still splits). */
    candidateSkipsSplits?: boolean;
    /** Research: the candidate's promoted search runs with these V08_A19_SEARCH_ENV_OVERRIDES (key -> value). */
    candidateSearchEnvOverrides?: Readonly<Record<string, string>>;
    /** Draft creatures with the live server's rules (faction-diversity tax), not the League-era argmax. */
    liveDraftRules?: boolean;
    /** Fight on the side-oriented ranked board (side zones, seeded stones) instead of the classic board. */
    sideBoard?: boolean;
    /** Deterministic search work budgets, so results do not depend on host load or concurrency. */
    deterministicSearch?: boolean;
    /** Chance each bundle/creature decision becomes a uniform legal choice instead (data collection only). */
    explorationRate?: number;
    /** Keep both seats' drafted armies on every record. */
    recordArmies?: boolean;
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
    candidateDoctrinePolicy: RankedDraftDoctrinePolicy;
    opponentDoctrinePolicy: RankedDraftDoctrinePolicy;
    candidateTier2Override?: number;
    candidateTier1Override?: number;
    candidateSynergyOverride?: Record<number, number>;
    candidateAugmentsOverride?: ISetupAugment[];
    liveSynergyVariants: boolean;
    tacticalSplits: boolean;
    candidateSkipsSplits: boolean;
    candidateSearchEnvOverrides?: Record<string, string>;
    liveDraftRules: boolean;
    sideBoard: boolean;
    deterministicSearch: boolean;
    explorationRate: number;
    recordArmies: boolean;
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
        ...(projected.draftStrengthPolicy ? { draftStrengthPolicy: projected.draftStrengthPolicy } : {}),
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

/** The ranked server's deployed draft genome. Only a faithful live draft when paired with liveDraftRules. */
export function rankedDraftLiveIncumbent(): ILeagueGenome {
    return normalizeRankedDraftGenome(parseDraftGenome(RANKED_VERSATILE_DRAFT_SPEC), RANKED_DRAFT_LIVE_INCUMBENT_ID);
}

/** The live draft plus a battle-fitted unit-strength overlay at the weight the policy id names. */
export function rankedDraftStrengthCandidate(policy: RankedDraftStrengthPolicyId): ILeagueGenome {
    return normalizeRankedDraftGenome(parseDraftGenome(policy), policy);
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
    if (specifier === "live") return [{ ...rankedDraftLiveIncumbent(), prior: 1 }];
    // A strength policy as the incumbent, e.g. "policy:ranked-unit-strength-a19-side-v1-w1" once it has shipped.
    if (specifier.startsWith("policy:")) {
        const policy = specifier.slice("policy:".length);
        if (!isRankedDraftStrengthPolicy(policy)) throw new TypeError(`Unknown ranked draft strength policy ${policy}`);
        return [{ ...normalizeRankedDraftGenome(parseDraftGenome(policy), `incumbent:${policy}`), prior: 1 }];
    }
    // Fixed references for robustness checks: the untrained fallback and the League exploiter that punishes
    // hard-countering drafts. Candidate and incumbent face them on identical seeds.
    if (specifier === "reference") {
        return defaultRankedDraftPool().filter((entry) => entry.id === HEURISTIC_ID || entry.id === ROUND3_ID);
    }
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
            draftStrengthPolicy?: unknown;
        };
        const id = typeof value.id === "string" && value.id.trim() ? value.id : `opponent-${index}`;
        if (value.draftStrengthPolicy !== undefined && !isRankedDraftStrengthPolicy(value.draftStrengthPolicy)) {
            throw new TypeError(`Ranked draft pool entry ${id} has an unsupported strength policy`);
        }
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
                    ...(value.draftStrengthPolicy ? { draftStrengthPolicy: value.draftStrengthPolicy } : {}),
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
    const candidateTier2Override = options.candidateTier2Override;
    if (candidateTier2Override !== undefined && !LIVE_TIER2_ARTIFACT_IDS.includes(candidateTier2Override)) {
        throw new RangeError(`candidateTier2Override must be a live Tier-2 artifact id (${LIVE_TIER2_ARTIFACT_IDS})`);
    }
    const candidateTier1Override = options.candidateTier1Override;
    if (candidateTier1Override !== undefined && !LIVE_TIER1_ARTIFACT_IDS.includes(candidateTier1Override)) {
        throw new RangeError(`candidateTier1Override must be a live Tier-1 artifact id (${LIVE_TIER1_ARTIFACT_IDS})`);
    }
    const explorationRate = options.explorationRate ?? 0;
    if (!Number.isFinite(explorationRate) || explorationRate < 0 || explorationRate >= 1) {
        throw new RangeError("explorationRate must be in [0, 1)");
    }
    const liveSynergyVariants = options.liveSynergyVariants === true;
    const tacticalSplits = options.tacticalSplits === true;
    if (tacticalSplits && !liveSynergyVariants) {
        throw new RangeError(
            "tacticalSplits needs liveSynergyVariants: the Nature board-units slots follow the variant",
        );
    }
    const candidateSkipsSplits = options.candidateSkipsSplits === true;
    if (candidateSkipsSplits && !tacticalSplits) throw new RangeError("candidateSkipsSplits needs tacticalSplits");
    if (liveSynergyVariants && options.candidateSynergyOverride !== undefined) {
        throw new RangeError("candidateSynergyOverride has no meaning under live synergy variants");
    }
    const searchOverrides = options.candidateSearchEnvOverrides;
    if (searchOverrides !== undefined) {
        if (fightProfile !== "a19") throw new RangeError("candidateSearchEnvOverrides needs the a19 fight profile");
        if (!Object.keys(searchOverrides).length) throw new RangeError("candidateSearchEnvOverrides is empty");
        for (const [key, value] of Object.entries(searchOverrides)) {
            if (typeof value !== "string") throw new RangeError(`candidateSearchEnvOverrides.${key} must be a string`);
        }
    }
    return {
        gamesPerOpponent: options.gamesPerOpponent,
        baseSeed: options.baseSeed >>> 0,
        concurrency: Math.min(concurrency, total),
        mapTypes,
        maxLaps,
        fightProfile,
        candidateSetupPolicySpec,
        opponentSetupPolicySpec,
        candidateDoctrinePolicy: rankedDraftDoctrinePolicy(options.candidateDoctrinePolicy),
        opponentDoctrinePolicy: rankedDraftDoctrinePolicy(options.opponentDoctrinePolicy),
        ...(candidateTier2Override === undefined ? {} : { candidateTier2Override }),
        ...(candidateTier1Override === undefined ? {} : { candidateTier1Override }),
        ...(options.candidateSynergyOverride === undefined
            ? {}
            : { candidateSynergyOverride: validateRankedDraftSynergyOverride(options.candidateSynergyOverride) }),
        ...(options.candidateAugmentsOverride === undefined
            ? {}
            : { candidateAugmentsOverride: validateRankedDraftAugmentOverride(options.candidateAugmentsOverride) }),
        liveSynergyVariants,
        tacticalSplits,
        candidateSkipsSplits,
        ...(searchOverrides === undefined ? {} : { candidateSearchEnvOverrides: { ...searchOverrides } }),
        liveDraftRules: options.liveDraftRules === true,
        sideBoard: options.sideBoard === true,
        deterministicSearch: options.deterministicSearch === true,
        explorationRate,
        recordArmies: options.recordArmies === true,
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
    /** Each seat's scouting doctrine; unset seats take `SETUP_POLICY_V0.pickDoctrine()`. */
    leftDoctrine?: Doctrine;
    rightDoctrine?: Doctrine;
}

export interface IRankedDraftPickRules {
    /** Pick creatures exactly as the ranked server does (faction-diversity tax included). */
    liveDraftRules?: boolean;
    /** Replace each bundle/creature decision with a uniform legal choice at this rate. */
    explorationRate?: number;
    /** The board's map. Creature decisions see it from level 3 on, when the live pick phase reveals it. */
    gridType?: number;
}

/** Tier-1 bundle score for a seat: the composition-corrected table when that genome's policy opts in. */
function tier1ArtifactScore(genome: ILeagueGenome, artifactId: number): number {
    const table = rankedDraftUsesCorrectedTier1Table(genome.draftStrengthPolicy)
        ? TIER1_ARTIFACT_WINRATE_COMPOSITION_CORRECTED
        : TIER1_ARTIFACT_WINRATE;
    return table[artifactId] ?? 50;
}

export function resolveRankedDraftPick(
    seed: number,
    leftInput: ILeagueGenome,
    rightInput: ILeagueGenome,
    setupPolicySpecs: IRankedDraftSetupPolicySpecs = {},
    rules: IRankedDraftPickRules = {},
): IPickSimState {
    const leftGenome = normalizeRankedDraftGenome(leftInput);
    const rightGenome = normalizeRankedDraftGenome(rightInput);
    const pickCreature = rules.liveDraftRules ? pickRankedLiveDraftCreature : pickDraftGenomeCreature;
    const explorationRate = rules.explorationRate ?? 0;
    // Exploration draws from its own stream so the reducer's bans, offers and collisions stay on their seeds, and
    // a zero rate reproduces the policy draft exactly. Both draws are taken every time to keep the stream aligned.
    const explorationRng = makeRng((seed ^ 0x6a09e667) >>> 0);
    const explore = (choices: number): number | undefined => {
        if (explorationRate <= 0 || choices <= 0) return undefined;
        const roll = explorationRng();
        const index = Math.floor(explorationRng() * choices);
        return roll < explorationRate ? index : undefined;
    };
    const leftSetupPolicy = resolveSetupPolicy(setupPolicySpecs.left ?? RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC);
    const rightSetupPolicy = resolveSetupPolicy(setupPolicySpecs.right ?? RANKED_DRAFT_DEFAULT_SETUP_POLICY_SPEC);
    const rng = randomInt(seed);
    let state = createPickSimState(rng);
    const teamState = (team: PickTeam): IPickTeamState => (team === LEFT ? state.left : state.right);

    const leftDoctrine = setupPolicySpecs.leftDoctrine ?? SETUP_POLICY_V0.pickDoctrine();
    const rightDoctrine = setupPolicySpecs.rightDoctrine ?? SETUP_POLICY_V0.pickDoctrine();
    state = applyAccepted(state, { type: "select_doctrine", team: LEFT, doctrine: leftDoctrine }, rng);
    state = applyAccepted(state, { type: "select_doctrine", team: RIGHT, doctrine: rightDoctrine }, rng);

    // Both simultaneous policies decide from the same pre-commit state.
    const leftBundle =
        explore(state.left.bundles.length) ??
        pickCoherentDraftBundle(
            state.left.bundles,
            (creatureId) => draftGenomeCreatureScore(leftGenome, creatureId),
            (artifactId) => tier1ArtifactScore(leftGenome, artifactId),
            {
                ...(leftGenome.draftSpellRangedPolicy
                    ? { draftSpellRangedPolicy: leftGenome.draftSpellRangedPolicy }
                    : {}),
                ...(leftGenome.draftStrengthPolicy ? { draftStrengthPolicy: leftGenome.draftStrengthPolicy } : {}),
            },
        );
    const rightBundle =
        explore(state.right.bundles.length) ??
        pickCoherentDraftBundle(
            state.right.bundles,
            (creatureId) => draftGenomeCreatureScore(rightGenome, creatureId),
            (artifactId) => tier1ArtifactScore(rightGenome, artifactId),
            {
                ...(rightGenome.draftSpellRangedPolicy
                    ? { draftSpellRangedPolicy: rightGenome.draftSpellRangedPolicy }
                    : {}),
                ...(rightGenome.draftStrengthPolicy ? { draftStrengthPolicy: rightGenome.draftStrengthPolicy } : {}),
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
        const visible = getVisibleCreatureChoices(state, team);
        const explored = explore(visible.length);
        const creatureId =
            explored !== undefined
                ? visible[explored]
                : pickCreature(
                      team === LEFT ? leftGenome : rightGenome,
                      visible,
                      own.creatures,
                      getKnownOpponentCreatures(state, team),
                      own.tier1Artifact,
                      phase.creatureLevel >= 3 ? rules.gridType : undefined,
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
    options: Pick<INormalizedOptions, "maxLaps" | "fightProfile" | "sideBoard" | "deterministicSearch">,
    extras: Partial<IMatchConfig> = {},
): IMatchConfig {
    const { maxLaps, fightProfile } = options;
    return {
        greenVersion: fightProfile === "a19" ? "v0.8" : "v0.7",
        redVersion: fightProfile === "a19" ? "v0.8" : "v0.7",
        roster: green.roster,
        redRoster: red.roster,
        seed,
        gridType,
        maxLaps,
        ...(options.sideBoard ? { sideOrientedPlacement: true } : {}),
        ...(options.deterministicSearch ? { searchOfflineDeterministicWork: true } : {}),
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
        ...extras,
    };
}

/**
 * The synergies the ranked server fields under live variants: every faction an army holds two or more distinct
 * creatures of plays the board's drawn variant (the level then follows the count, as FightProperties computes it).
 */
export function liveRankedDraftSynergies(
    creatureIds: readonly number[],
    variants: { readonly [factionName: string]: SpecificSynergy },
): ISetupSynergy[] {
    const distinct = new Map<number, Set<number>>();
    for (const creatureId of creatureIds) {
        const faction = CreatureFactions[creatureId];
        if (faction === undefined) continue;
        const members = distinct.get(faction) ?? new Set<number>();
        members.add(creatureId);
        distinct.set(faction, members);
    }
    const synergies: ISetupSynergy[] = [];
    for (const faction of [
        PBTypes.FactionVals.LIFE,
        PBTypes.FactionVals.NATURE,
        PBTypes.FactionVals.CHAOS,
        PBTypes.FactionVals.MIGHT,
    ]) {
        const variant = variants[ToFactionName[faction]];
        if ((distinct.get(faction)?.size ?? 0) >= 2 && variant !== undefined) {
            synergies.push({ faction, synergy: variant });
        }
    }
    return synergies;
}

/**
 * FightProperties.getNumberOfUnitsAvailableForPlacement for a finished draft: six stacks, plus one per Placement
 * augment level, plus the Nature board-units bonus when the board fields that variant at level 1 or more.
 */
export function rankedDraftStackCapacity(
    creatureIds: readonly number[],
    augments: readonly ISetupAugment[],
    variants: { readonly [factionName: string]: SpecificSynergy },
): number {
    const placement = augments.find((augment) => augment.kind === "Placement")?.value ?? 0;
    const nature = new Set(
        creatureIds.filter((creatureId) => CreatureFactions[creatureId] === PBTypes.FactionVals.NATURE),
    ).size;
    const level = Math.min(Math.floor(nature / 2), 3);
    const boardUnits =
        variants.Nature === NatureSynergy.INCREASE_BOARD_UNITS && level >= 1
            ? (SynergyKeysToPower[`Nature:${NatureSynergy.INCREASE_BOARD_UNITS}:${level}`]?.[0] ?? 0)
            : 0;
    return 6 + placement + boardUnits;
}

const rankedDraftPickRules = (options: INormalizedOptions, gridType: number): IRankedDraftPickRules => ({
    liveDraftRules: options.liveDraftRules,
    explorationRate: options.explorationRate,
    gridType,
});

const rankedDraftSeatDoctrines = (
    options: INormalizedOptions,
    pickSeed: number,
    candidatePickedLeft: boolean,
): Pick<IRankedDraftSetupPolicySpecs, "leftDoctrine" | "rightDoctrine"> => {
    const leftPolicy = candidatePickedLeft ? options.candidateDoctrinePolicy : options.opponentDoctrinePolicy;
    const rightPolicy = candidatePickedLeft ? options.opponentDoctrinePolicy : options.candidateDoctrinePolicy;
    return {
        leftDoctrine: resolveRankedDraftDoctrine(leftPolicy, pickSeed, LEFT),
        rightDoctrine: resolveRankedDraftDoctrine(rightPolicy, pickSeed, RIGHT),
    };
};

const recordedArmy = (army: IRankedDraftArmy): IRankedDraftRecordedArmy => ({
    creatureIds: [...army.creatureIds],
    tier1Artifact: army.tier1Artifact,
    tier2Artifact: army.tier2Artifact,
});

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
    const synergyVariants = options.liveSynergyVariants
        ? synergyVariantsForSeed(`ranked-draft-${pickSeed}`)
        : undefined;
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
    // The map is fixed when the pick is created, and revealed to the draft before the level-3 picks.
    const gridType = options.mapTypes[(offerBoard + seedLaneIndex) % options.mapTypes.length];
    const pick = resolveRankedDraftPick(
        pickSeed,
        leftGenome,
        rightGenome,
        {
            left: leftSetupPolicy.spec,
            right: rightSetupPolicy.spec,
            ...rankedDraftSeatDoctrines(options, pickSeed, candidatePickedLeft),
        },
        rankedDraftPickRules(options, gridType),
    );
    const left = materializeArmy(pick.left, getKnownOpponentCreatures(pick, LEFT), leftSetupPolicy);
    const right = materializeArmy(pick.right, getKnownOpponentCreatures(pick, RIGHT), rightSetupPolicy);
    const candidatePolicyTier2 = (candidatePickedLeft ? left : right).tier2Artifact;
    if (options.candidateTier1Override !== undefined) {
        (candidatePickedLeft ? left : right).tier1Artifact = options.candidateTier1Override;
    }
    if (options.candidateTier2Override !== undefined) {
        (candidatePickedLeft ? left : right).tier2Artifact = options.candidateTier2Override;
    }
    const candidatePolicySynergies = [...(candidatePickedLeft ? left : right).synergies];
    const synergyOverride = options.candidateSynergyOverride;
    if (synergyOverride !== undefined) {
        const army = candidatePickedLeft ? left : right;
        army.synergies = army.synergies.map((entry) =>
            synergyOverride[entry.faction] === undefined
                ? entry
                : { ...entry, synergy: synergyOverride[entry.faction] },
        );
    }
    const candidatePolicyAugments = [...(candidatePickedLeft ? left : right).augments];
    if (options.candidateAugmentsOverride !== undefined) {
        const army = candidatePickedLeft ? left : right;
        const spent = options.candidateAugmentsOverride.reduce((total, augment) => total + augment.value, 0);
        if (spent > getUpgradePoints(army.doctrine)) {
            throw new RangeError(
                `augment override spends ${spent} points; the candidate's doctrine allows ${getUpgradePoints(army.doctrine)}`,
            );
        }
        army.augments = options.candidateAugmentsOverride.map((augment) => ({ ...augment }));
    }
    if (synergyVariants) {
        left.synergies = liveRankedDraftSynergies(left.creatureIds, synergyVariants);
        right.synergies = liveRankedDraftSynergies(right.creatureIds, synergyVariants);
    }
    const splitOf = (army: IRankedDraftArmy, candidateSeat: boolean) =>
        options.tacticalSplits && synergyVariants
            ? candidateSeat && options.candidateSkipsSplits
                ? { roster: army.roster.map((unit) => ({ ...unit })), splitRoles: [] }
                : materializeTacticalSplitRoster(
                      army.roster,
                      rankedDraftStackCapacity(army.creatureIds, army.augments, synergyVariants),
                  )
            : undefined;
    const leftSplit = splitOf(left, candidatePickedLeft);
    const rightSplit = splitOf(right, !candidatePickedLeft);
    const green = battleMirror ? right : left;
    const red = battleMirror ? left : right;
    const greenSplit = battleMirror ? rightSplit : leftSplit;
    const redSplit = battleMirror ? leftSplit : rightSplit;
    const candidateIsGreen = battleMirror ? !candidatePickedLeft : candidatePickedLeft;
    const candidateArmy = candidatePickedLeft ? left : right;
    const extras: Partial<IMatchConfig> = {
        ...(synergyVariants ? { synergyVariants } : {}),
        ...(greenSplit
            ? {
                  roster: greenSplit.roster,
                  greenTacticalSplitStacks: greenSplit.splitRoles as ITacticalSplitRosterStack[],
              }
            : {}),
        ...(redSplit
            ? { redRoster: redSplit.roster, redTacticalSplitStacks: redSplit.splitRoles as ITacticalSplitRosterStack[] }
            : {}),
        ...(options.tacticalSplits ? { placementAugmentTiming: "setup-before-placement" as const } : {}),
        ...(options.candidateSearchEnvOverrides
            ? { searchEnvOverrideTeams: [candidateIsGreen ? GREEN_TEAM : RED_TEAM] }
            : {}),
    };
    const previousSearchOverrides = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    if (options.candidateSearchEnvOverrides) {
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify(options.candidateSearchEnvOverrides);
    }
    let result: IMatchResult;
    try {
        result = (dependencies.matchRunner ?? DEFAULT_DEPENDENCIES.matchRunner)(
            matchConfig(green, red, battleSeed, gridType, options, extras),
        );
    } finally {
        if (options.candidateSearchEnvOverrides) {
            if (previousSearchOverrides === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
            else process.env.V08_A19_SEARCH_ENV_OVERRIDES = previousSearchOverrides;
        }
    }
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
        ...(synergyVariants ? { synergyVariants } : {}),
        ...(leftSplit && rightSplit
            ? {
                  splitStacks: {
                      candidate: (candidatePickedLeft ? leftSplit : rightSplit).splitRoles.length,
                      opponent: (candidatePickedLeft ? rightSplit : leftSplit).splitRoles.length,
                  },
              }
            : {}),
        ...(options.recordArmies
            ? {
                  armies: {
                      candidate: {
                          ...recordedArmy(candidateArmy),
                          ...(options.candidateTier1Override === undefined
                              ? {}
                              : { forcedTier1Artifact: options.candidateTier1Override }),
                          ...(options.candidateTier2Override === undefined
                              ? {}
                              : {
                                    tier2Offers: [...(candidatePickedLeft ? pick.left : pick.right).tier2Offers],
                                    policyTier2Artifact: candidatePolicyTier2,
                                }),
                          ...(options.candidateSynergyOverride === undefined
                              ? {}
                              : {
                                    synergies: [...candidateArmy.synergies],
                                    policySynergies: candidatePolicySynergies,
                                }),
                          ...(options.candidateAugmentsOverride === undefined
                              ? {}
                              : {
                                    augments: candidateArmy.augments.map((augment) => ({ ...augment })),
                                    policyAugments: candidatePolicyAugments,
                                }),
                      },
                      opponent: recordedArmy(candidatePickedLeft ? right : left),
                  },
              }
            : {}),
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
    const gridType = options.mapTypes[(offerBoard + seedLaneIndex) % options.mapTypes.length];
    const assignments = ([true, false] as const).map((candidatePickedLeft) => {
        const leftGenome = candidatePickedLeft ? candidate : opponent;
        const rightGenome = candidatePickedLeft ? opponent : candidate;
        const pick = resolveRankedDraftPick(
            pickSeed,
            leftGenome,
            rightGenome,
            {
                left: candidatePickedLeft ? options.candidateSetupPolicySpec : options.opponentSetupPolicySpec,
                right: candidatePickedLeft ? options.opponentSetupPolicySpec : options.candidateSetupPolicySpec,
                ...rankedDraftSeatDoctrines(options, pickSeed, candidatePickedLeft),
            },
            rankedDraftPickRules(options, gridType),
        );
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
            ...(options.candidateDoctrinePolicy !== RANKED_DRAFT_DEFAULT_DOCTRINE_POLICY ||
            options.opponentDoctrinePolicy !== RANKED_DRAFT_DEFAULT_DOCTRINE_POLICY
                ? {
                      candidateDoctrinePolicy: options.candidateDoctrinePolicy,
                      opponentDoctrinePolicy: options.opponentDoctrinePolicy,
                  }
                : {}),
            ...(options.candidateTier1Override === undefined
                ? {}
                : { candidateTier1Override: options.candidateTier1Override }),
            ...(options.candidateTier2Override === undefined
                ? {}
                : { candidateTier2Override: options.candidateTier2Override }),
            ...(options.candidateSynergyOverride === undefined
                ? {}
                : { candidateSynergyOverride: options.candidateSynergyOverride }),
            ...(options.candidateAugmentsOverride === undefined
                ? {}
                : { candidateAugmentsOverride: options.candidateAugmentsOverride }),
            ...(options.liveSynergyVariants ? { liveSynergyVariants: true as const } : {}),
            ...(options.tacticalSplits ? { tacticalSplits: true as const } : {}),
            ...(options.candidateSkipsSplits ? { candidateSkipsSplits: true as const } : {}),
            ...(options.candidateSearchEnvOverrides === undefined
                ? {}
                : { candidateSearchEnvOverrides: options.candidateSearchEnvOverrides }),
            draftDimensions: { offset: RANKED_DRAFT_INTRINSIC_OFFSET, length: RANKED_DRAFT_INTRINSIC_DIM },
            clusterSize: 4,
            seedAllocation: "indexed-bijective-v1",
            seedChannelsPerBoard: 3,
            commonBattleSeed: true,
            behaviorTrace: "canonical-sha256-v1",
            executedActionsRecorded: true,
            liveDraftRules: options.liveDraftRules,
            sideBoard: options.sideBoard,
            deterministicSearch: options.deterministicSearch,
            explorationRate: options.explorationRate,
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
    onProgress?: (completed: number, total: number) => void,
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
                onProgress?.(completed, tasks.length);
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
    return (await evaluateRankedDraftPanel(candidateInput, poolInput, optionsInput)).report;
}

/** Run a whole panel and keep its per-game records next to the summary. */
export async function evaluateRankedDraftPanel(
    candidateInput: ILeagueGenome,
    poolInput: readonly IRankedDraftPoolEntry[],
    optionsInput: IRankedDraftEvaluationOptions,
    onProgress?: (completed: number, total: number) => void,
): Promise<{ records: IRankedDraftGameRecord[]; report: IRankedDraftEvaluationReport }> {
    const candidate = normalizeRankedDraftGenome(candidateInput);
    const pool = poolInput.map((opponent) => ({ ...normalizeRankedDraftGenome(opponent), prior: opponent.prior }));
    validateEntrants(candidate, pool);
    const options = normalizeOptions(optionsInput, pool.length);
    const tasks = Array.from({ length: options.gamesPerOpponent * pool.length }, (_, index) => ({
        opponentIndex: Math.floor(index / options.gamesPerOpponent),
        game: index % options.gamesPerOpponent,
    }));
    const records = await evaluateRankedDraftTasks(candidate, pool, options, tasks, onProgress);
    return { records, report: summarizeRankedDraftRecords(candidate, pool, options, records) };
}

interface ICliOptions extends IRankedDraftEvaluationOptions {
    candidate: ILeagueGenome;
    pool: IRankedDraftPoolEntry[];
    outputPath?: string;
    recordsPath?: string;
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
        "candidate-doctrine",
        "opponent-doctrine",
        "candidate-t1",
        "candidate-t2",
        "candidate-synergy",
        "candidate-augments",
        "live-synergy-variants",
        "tactical-splits",
        "candidate-skips-splits",
        "candidate-search-env",
        "output",
        "live-draft-rules",
        "side-board",
        "deterministic-search",
        "exploration",
        "record-armies",
        "records",
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
    const flag = (key: string): boolean => {
        const value = values.get(key);
        if (value === undefined || value === "false" || value === "0") return false;
        if (value === "true" || value === "1") return true;
        throw new Error(`--${key} expects true or false`);
    };
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
        ...(values.get("candidate-doctrine")
            ? { candidateDoctrinePolicy: rankedDraftDoctrinePolicy(values.get("candidate-doctrine")) }
            : {}),
        ...(values.get("opponent-doctrine")
            ? { opponentDoctrinePolicy: rankedDraftDoctrinePolicy(values.get("opponent-doctrine")) }
            : {}),
        ...(values.get("candidate-t1") ? { candidateTier1Override: Number(values.get("candidate-t1")) } : {}),
        ...(values.get("candidate-t2") ? { candidateTier2Override: Number(values.get("candidate-t2")) } : {}),
        ...(values.get("candidate-synergy")
            ? { candidateSynergyOverride: parseRankedDraftSynergyOverride(values.get("candidate-synergy")!) }
            : {}),
        ...(values.get("candidate-augments")
            ? { candidateAugmentsOverride: parseRankedDraftAugmentOverride(values.get("candidate-augments")!) }
            : {}),
        ...(values.get("candidate-search-env")
            ? {
                  candidateSearchEnvOverrides: JSON.parse(values.get("candidate-search-env")!) as Record<
                      string,
                      string
                  >,
              }
            : {}),
        liveSynergyVariants: flag("live-synergy-variants"),
        tacticalSplits: flag("tactical-splits"),
        candidateSkipsSplits: flag("candidate-skips-splits"),
        ...(values.get("output") ? { outputPath: resolve(values.get("output")!) } : {}),
        liveDraftRules: flag("live-draft-rules"),
        sideBoard: flag("side-board"),
        deterministicSearch: flag("deterministic-search"),
        explorationRate: Number(values.get("exploration") ?? 0),
        recordArmies: flag("record-armies"),
        ...(values.get("records") ? { recordsPath: resolve(values.get("records")!) } : {}),
    };
}

async function cliMain(): Promise<void> {
    const options = parseCli(process.argv.slice(2));
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    const { records, report } = await evaluateRankedDraftPanel(
        options.candidate,
        options.pool,
        options,
        (completed, total) => {
            const now = Date.now();
            if (completed !== total && now - lastProgressAt < 30_000) return;
            lastProgressAt = now;
            const perSecond = completed / Math.max(1, (now - startedAt) / 1000);
            const etaMinutes = Math.round((total - completed) / Math.max(perSecond, 1e-9) / 60);
            process.stderr.write(
                `[ranked-draft] ${completed}/${total} games (${perSecond.toFixed(2)}/s, eta ${etaMinutes}m)\n`,
            );
        },
    );
    if (options.recordsPath) {
        mkdirSync(dirname(options.recordsPath), { recursive: true });
        writeFileSync(options.recordsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    }
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
