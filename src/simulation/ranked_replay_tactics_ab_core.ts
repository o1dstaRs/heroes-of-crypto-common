/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { TIER1_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import {
    applyCreatureRoleFitMultiplier,
    creatureInfo,
    creatureRoleFitMultiplier,
    eligibleBacklineProtectorChoices,
} from "../ai/setup/creature_score";
import {
    draftGenomeCreatureScore,
    LEAGUE_ROUND1_DRAFT_SPEC,
    parseDraftGenome,
    pickDraftGenomeCreature,
    projectDraftGenomeForShipping,
} from "../ai/setup/draft_ship";
import { pickCoherentDraftBundle } from "../ai/setup/draft_coherence";
import { createPlacementSetupDecisionContext, createTier2ArtifactDecisionContext } from "../ai/setup/setup_strategy";
import {
    REPLAY_RAPID_CHARGE_AUGMENT_PLAN,
    RANKED_REPLAY_TACTICS_SETUP_SPEC,
    replayRapidChargeCoreEligible,
    replayTacticsArmyIdentity,
} from "../ai/setup/setup_replay_tactics";
import {
    resolveSetupPolicy,
    setupAugmentsForPlan,
    V07_NONFIGHT_SETUP_SPEC,
    type IResolvedSetupPolicy,
    type ISetupAugmentChoice,
    type ISetupSynergyChoice,
} from "../ai/setup/setup_ship";
import {
    applyTacticalSplitPlacement,
    planTacticalStackSplits,
    tacticalSplitUnitFromUnit,
    type TacticalSplitRole,
} from "../ai/tactical_split_placement";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai/ai_strategy";
import type { GameAction } from "../engine/actions";
import { CreatureFactions } from "../generated/protobuf/v1/creature_gen";
import { PBTypes } from "../generated/protobuf/v1/types";
import { GRID_SIZE } from "../grid/grid_constants";
import { getUpgradePoints, Doctrine } from "../doctrines/doctrine_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    getKnownOpponentCreatures,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionServerPersistedPickSim,
    type IPickSimState,
    type IPickTeamState,
    type PickAction,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { NatureSynergy } from "../synergies/synergy_properties";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { buildV08A13SearchEnvironment } from "../ai/versions/v0_8_a13_profile";
import { V07_WAIT_WEIGHTS_V2_MAX_INITIAL_RANGED_ENV } from "../ai/versions/v0_7";
import {
    MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11,
    V07_WAIT_WEIGHTS_V2_GRIDS_ENV,
    V07_WAIT_WEIGHTS_V2_VERSIONS_ENV,
} from "../ai/versions/wait_scorer";
import { StrategyV0_8 } from "../ai/versions/v0_8";
import { StrategyV0_8S } from "../ai/versions/v0_8s";
import {
    createCombatFactories,
    createUnitFromSpec,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    hashSimulationParts,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
} from "./army";
import { runMatch, simulationGridSettings, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import {
    AI_META_COHORTS,
    cohortMap,
    prepareMetaPair,
    rosterSignature,
    rostersAreStrictlyDistinct,
    type AiMetaCohort,
    type IAiMetaArmy,
} from "./ai_meta_cohorts_core";

export const RANKED_REPLAY_TACTICS_AB_SCHEMA = "hoc.ranked_replay_tactics_ab.v4" as const;
export const RANKED_REPLAY_TACTICS_AB_CLUSTER_SIZE = 4 as const;
export const RANKED_REPLAY_TACTICS_AB_LIVE_MAPS = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;
export const RANKED_REPLAY_TACTICS_AB_CONTROL = Object.freeze({
    draft: `${LEAGUE_ROUND1_DRAFT_SPEC}:pre-coherence-overlay`,
    setup: V07_NONFIGHT_SETUP_SPEC,
    splits: false,
    combat: "v0.8+a13-h12",
});

export const RANKED_REPLAY_TACTICS_AB_COMPONENTS = ["draft", "setup", "splits", "combat", "wait"] as const;
export type RankedReplayAbComponent = (typeof RANKED_REPLAY_TACTICS_AB_COMPONENTS)[number];
export type RankedReplayAbComponents = Readonly<Record<RankedReplayAbComponent, boolean>>;
export const RANKED_REPLAY_AB_COMBAT_SCOPES = ["all", "ranged-battery"] as const;
export type RankedReplayAbCombatScope = (typeof RANKED_REPLAY_AB_COMBAT_SCOPES)[number];
export const RANKED_REPLAY_AB_COMBAT_CANDIDATES = ["shortlist-3", "horizon-14", "horizon-16", "horizon-18"] as const;
export type RankedReplayAbCombatCandidate = (typeof RANKED_REPLAY_AB_COMBAT_CANDIDATES)[number];

export interface IRankedReplayAbOptions {
    cohort: AiMetaCohort;
    pairs: number;
    baseSeed: number;
    components: RankedReplayAbComponents;
    combatScope: RankedReplayAbCombatScope;
    combatCandidate: RankedReplayAbCombatCandidate;
    maxLaps?: number;
}

export interface IRankedReplayAbSplitRole {
    rosterIndex: number;
    role: TacticalSplitRole;
}

export interface IRankedReplayAbArmy {
    variant: "candidate" | "control";
    creatureIds: number[];
    roster: IArmyUnitSpec[];
    originalRoster: IArmyUnitSpec[];
    doctrine: number;
    artifactT1: number;
    artifactT2: number;
    augments: ISetupAugmentChoice[];
    synergies: ISetupSynergyChoice[];
    setupIdentity: ReturnType<typeof replayTacticsArmyIdentity>;
    splitRoles: IRankedReplayAbSplitRole[];
    revealedOpponentCreatures: number[];
}

export interface IRankedReplayAbGameOutcome {
    assignment: 0 | 1;
    battleMirror: 0 | 1;
    draftSeat: "candidate-lower" | "candidate-upper" | "candidate-roster-a" | "candidate-roster-b";
    candidateSide: Side;
    winner: Side | "draw";
    candidateResult: "win" | "loss" | "draw";
    candidateScore: number;
    laps: number;
    endReason: IMatchResult["endReason"];
    armageddonDecided: boolean;
    rejectedCandidate: number;
    rejectedControl: number;
    candidateHpMargin: number;
    candidateSurvivorMargin: number;
    candidateRosterSignature: string;
    controlRosterSignature: string;
    candidateSetupIdentity: IRankedReplayAbArmy["setupIdentity"];
    combatMatchupEligible: boolean;
    candidateSplitStacks: number;
    setupFingerprint: string;
}

export interface IRankedReplayAbClusterRecord {
    schema: typeof RANKED_REPLAY_TACTICS_AB_SCHEMA;
    cohort: AiMetaCohort;
    pair: number;
    pairSeed: number;
    pickSeed: number;
    combatSeed: number;
    map: number;
    components: RankedReplayAbComponents;
    combatScope: RankedReplayAbCombatScope;
    combatCandidate: RankedReplayAbCombatCandidate;
    games: [
        IRankedReplayAbGameOutcome,
        IRankedReplayAbGameOutcome,
        IRankedReplayAbGameOutcome,
        IRankedReplayAbGameOutcome,
    ];
}

export interface IRankedReplayAbMetricRow {
    key: string;
    clusters: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    scoreRate: number;
    liftPp: number;
    standardErrorPp: number | null;
    ciLow: number;
    ciHigh: number;
}

export interface IRankedReplayAbSummaryRows {
    overall: IRankedReplayAbMetricRow;
    cohorts: IRankedReplayAbMetricRow[];
    maps: IRankedReplayAbMetricRow[];
    cohortMaps: IRankedReplayAbMetricRow[];
    setupIdentities: IRankedReplayAbMetricRow[];
    splitTrigger: IRankedReplayAbMetricRow[];
    combatEligibility: IRankedReplayAbMetricRow[];
}

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const CONTROL_SETUP_POLICY = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);
const CANDIDATE_SETUP_POLICY = resolveSetupPolicy(RANKED_REPLAY_TACTICS_SETUP_SPEC);
const RANKED_GENOME = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));

export const allRankedReplayAbComponents = (): RankedReplayAbComponents => ({
    draft: true,
    setup: true,
    splits: true,
    combat: true,
    wait: true,
});

export const noRankedReplayAbComponents = (): RankedReplayAbComponents => ({
    draft: false,
    setup: false,
    splits: false,
    combat: false,
    wait: false,
});

export function parseRankedReplayAbComponents(raw: string | undefined): RankedReplayAbComponents {
    if (!raw || raw.trim().toLowerCase() === "all") return allRankedReplayAbComponents();
    if (raw.trim().toLowerCase() === "none") return noRankedReplayAbComponents();
    const selected = new Set(
        raw
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
    );
    const legal = new Set<string>(RANKED_REPLAY_TACTICS_AB_COMPONENTS);
    for (const value of selected) {
        if (!legal.has(value)) {
            throw new Error(
                `Unknown replay A/B component ${JSON.stringify(value)}; expected ${RANKED_REPLAY_TACTICS_AB_COMPONENTS.join(",")}`,
            );
        }
    }
    return Object.fromEntries(
        RANKED_REPLAY_TACTICS_AB_COMPONENTS.map((component) => [component, selected.has(component)]),
    ) as unknown as RankedReplayAbComponents;
}

export function parseRankedReplayAbCombatScope(raw: string | undefined): RankedReplayAbCombatScope {
    const scope = (raw ?? "all").trim().toLowerCase();
    if (!(RANKED_REPLAY_AB_COMBAT_SCOPES as readonly string[]).includes(scope)) {
        throw new Error(`combat-scope must be ${RANKED_REPLAY_AB_COMBAT_SCOPES.join(" or ")}`);
    }
    return scope as RankedReplayAbCombatScope;
}

export function parseRankedReplayAbCombatCandidate(raw: string | undefined): RankedReplayAbCombatCandidate {
    const candidate = (raw ?? "horizon-18").trim().toLowerCase();
    if (!(RANKED_REPLAY_AB_COMBAT_CANDIDATES as readonly string[]).includes(candidate)) {
        throw new Error(`combat-candidate must be ${RANKED_REPLAY_AB_COMBAT_CANDIDATES.join(", ")}`);
    }
    return candidate as RankedReplayAbCombatCandidate;
}

/** Full-crossover exposure: retain both candidate assignments whenever either roster can receive a scoped arm. */
export function rankedReplayCombatClusterEligible(
    components: RankedReplayAbComponents,
    combatScope: RankedReplayAbCombatScope,
    candidateIdentities: readonly IRankedReplayAbArmy["setupIdentity"][],
): boolean {
    return (
        components.combat &&
        (combatScope === "all" || candidateIdentities.some((identity) => identity === "ranged-battery"))
    );
}

const stableBestIndex = (scores: readonly number[]): number => {
    let bestIndex = 0;
    let bestScore = -Infinity;
    scores.forEach((score, index) => {
        if (score > bestScore) {
            bestIndex = index;
            bestScore = score;
        }
    });
    return bestIndex;
};

const preCoherenceBundle = (bundles: readonly (readonly [number, number, number])[]): number =>
    stableBestIndex(
        bundles.map(
            ([level1, level2, artifact]) =>
                draftGenomeCreatureScore(RANKED_GENOME, level1) +
                draftGenomeCreatureScore(RANKED_GENOME, level2) +
                (TIER1_ARTIFACT_WINRATE[artifact] ?? 50),
        ),
    );

const coherentBundle = (bundles: readonly (readonly [number, number, number])[]): number =>
    pickCoherentDraftBundle(
        bundles,
        (creatureId) => draftGenomeCreatureScore(RANKED_GENOME, creatureId),
        (artifactId) => TIER1_ARTIFACT_WINRATE[artifactId] ?? 50,
    );

const preCoherenceCreature = (
    available: readonly number[],
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
): number | undefined => {
    const eligible = eligibleBacklineProtectorChoices(available, ownCreatureIds, knownOpponentCreatureIds);
    if (!eligible.length) return undefined;
    return eligible[
        stableBestIndex(
            eligible.map((creatureId) =>
                applyCreatureRoleFitMultiplier(
                    draftGenomeCreatureScore(RANKED_GENOME, creatureId),
                    creatureRoleFitMultiplier(creatureId, ownCreatureIds, knownOpponentCreatureIds),
                ),
            ),
        )
    ];
};

const coherentCreature = (
    available: readonly number[],
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
    tier1ArtifactId: number | undefined,
): number | undefined => {
    const eligible = eligibleBacklineProtectorChoices(available, ownCreatureIds, knownOpponentCreatureIds);
    if (!eligible.length) return undefined;
    return pickDraftGenomeCreature(RANKED_GENOME, eligible, ownCreatureIds, knownOpponentCreatureIds, tier1ArtifactId);
};

const randomInt = (seed: number): PickRandomInt => {
    const rng = makeRng(seed);
    return (maxExclusive) => Math.floor(rng() * maxExclusive);
};

const applyAccepted = (state: IPickSimState, action: PickAction, rng: PickRandomInt): IPickSimState => {
    const result = transitionServerPersistedPickSim(state, action, rng);
    if (result.status !== "accepted") {
        throw new Error(`Replay A/B pick ${action.type} was ${result.status}: ${result.reason}`);
    }
    return result.state;
};

const teamState = (state: IPickSimState, team: PickTeam): IPickTeamState => (team === LEFT ? state.left : state.right);

const setupPolicyForTeam = (
    team: PickTeam,
    candidateTeam: PickTeam,
    components: RankedReplayAbComponents,
): IResolvedSetupPolicy => (team === candidateTeam && components.setup ? CANDIDATE_SETUP_POLICY : CONTROL_SETUP_POLICY);

/** Drive the exact persisted ranked reducer with candidate/control assigned to opposite draft seats. */
export function resolveRankedReplayAbPick(
    seed: number,
    map: number,
    candidateTeam: PickTeam,
    components: RankedReplayAbComponents,
): IPickSimState {
    const rng = randomInt(seed);
    let state = createPickSimState(rng);
    state = applyAccepted(state, { type: "select_doctrine", team: LEFT, doctrine: Doctrine.SEE_NONE }, rng);
    state = applyAccepted(state, { type: "select_doctrine", team: RIGHT, doctrine: Doctrine.SEE_NONE }, rng);

    // Simultaneous choices consume the same pre-commit offer board.
    const leftBundles = state.left.bundles;
    const rightBundles = state.right.bundles;
    const bundleFor = (team: PickTeam, bundles: readonly (readonly [number, number, number])[]): number =>
        team === candidateTeam && components.draft ? coherentBundle(bundles) : preCoherenceBundle(bundles);
    const leftBundle = bundleFor(LEFT, leftBundles);
    const rightBundle = bundleFor(RIGHT, rightBundles);
    state = applyAccepted(state, { type: "select_bundle", team: LEFT, bundleIndex: leftBundle }, rng);
    state = applyAccepted(state, { type: "select_bundle", team: RIGHT, bundleIndex: rightBundle }, rng);

    let guard = 0;
    while (!isPickSimComplete(state)) {
        if ((guard += 1) > 60) throw new Error("Replay A/B ranked pick exceeded collision guard");
        const phase = getCurrentPickPhase(state);
        if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
            for (const team of [LEFT, RIGHT] as const) {
                const own = teamState(state, team);
                const policy = setupPolicyForTeam(team, candidateTeam, components);
                const artifactId = policy.pickArtifactT2(
                    own.tier2Offers,
                    own.creatures,
                    createTier2ArtifactDecisionContext({
                        publicOpponentCreatureIds: getKnownOpponentCreatures(state, team),
                        gridType: map,
                        gridSize: GRID_SIZE,
                        ownDoctrine: own.doctrine,
                        ownArtifactIds: own.tier1Artifact === undefined ? [] : [own.tier1Artifact],
                    }),
                );
                state = applyAccepted(state, { type: "select_tier2", team, artifactId }, rng);
            }
            continue;
        }
        if (phase.phase !== PBTypes.PickPhaseVals.PICK || phase.actors.length !== 1) {
            throw new Error(`Unexpected replay A/B pick phase ${phase.phase} at ${state.phaseSequence}`);
        }
        const team = phase.actors[0];
        const own = teamState(state, team);
        const available = getVisibleCreatureChoices(state, team);
        const known = getKnownOpponentCreatures(state, team);
        const creatureId =
            team === candidateTeam && components.draft
                ? coherentCreature(available, own.creatures, known, own.tier1Artifact)
                : preCoherenceCreature(available, own.creatures, known);
        if (creatureId === undefined) throw new Error(`Replay A/B found no L${phase.creatureLevel} creature`);
        const result = transitionServerPersistedPickSim(state, { type: "pick_creature", team, creatureId }, rng);
        if (result.status === "rejected") {
            throw new Error(`Replay A/B creature ${creatureId} was rejected as ${result.reason}`);
        }
        state = result.state;
    }
    return state;
}

const rankedRoster = (creatureIds: readonly number[]): IArmyUnitSpec[] =>
    creatureIds.map((creatureId) => {
        const info = creatureInfo(creatureId);
        if (!info) throw new Error(`Replay A/B selected unknown creature ${creatureId}`);
        const catalog = creaturesByLevel(info.level).find((entry) => entry.creatureName === info.name);
        if (!catalog) throw new Error(`Replay A/B selected disabled creature ${info.name}`);
        return {
            faction: catalog.faction,
            creatureName: catalog.creatureName,
            level: catalog.level,
            size: catalog.size,
            amount: resolveStackAmount(catalog.creatureName, catalog.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });

interface IBaseArmy {
    creatureIds: number[];
    roster: IArmyUnitSpec[];
    doctrine: number;
    artifactT1: number;
    artifactT2: number;
    revealedOpponentCreatures: number[];
}

const rankedBaseArmy = (team: IPickTeamState, opponentReveals: readonly number[]): IBaseArmy => {
    if (team.tier1Artifact === undefined || team.tier2Artifact === undefined) {
        throw new Error("Replay A/B complete pick omitted an artifact");
    }
    return {
        creatureIds: [...team.creatures],
        roster: rankedRoster(team.creatures),
        doctrine: team.doctrine,
        artifactT1: team.tier1Artifact,
        artifactT2: team.tier2Artifact,
        revealedOpponentCreatures: [...opponentReveals],
    };
};

const metaBaseArmy = (army: IAiMetaArmy): IBaseArmy => ({
    creatureIds: [...army.creatureIds],
    roster: army.roster.map((unit) => ({ ...unit })),
    doctrine: army.doctrine,
    artifactT1: army.artifactT1.id,
    artifactT2: army.artifactT2.id,
    revealedOpponentCreatures: [],
});

const maximumStacks = (
    creatureIds: readonly number[],
    augments: readonly ISetupAugmentChoice[],
    synergies: readonly ISetupSynergyChoice[],
): number => {
    const placement = augments.find((augment) => augment.kind === "Placement")?.value ?? 0;
    const natureCount = creatureIds.filter(
        (creatureId) => CreatureFactions[creatureId] === PBTypes.FactionVals.NATURE,
    ).length;
    const boardUnits = synergies.some(
        (synergy) =>
            synergy.faction === PBTypes.FactionVals.NATURE && synergy.synergy === NatureSynergy.INCREASE_BOARD_UNITS,
    )
        ? Math.min(3, Math.floor(natureCount / 2))
        : 0;
    return 6 + placement + boardUnits;
};

/**
 * Materialize the post-action split state without touching battle_engine. Amounts, abilities and fresh-stack
 * semantics match the authoritative split result; accepted-action/journal routing remains covered on server.
 */
export function materializeReplayAbSplits(
    roster: readonly IArmyUnitSpec[],
    creatureIds: readonly number[],
    augments: readonly ISetupAugmentChoice[],
    synergies: readonly ISetupSynergyChoice[],
): { roster: IArmyUnitSpec[]; splitRoles: IRankedReplayAbSplitRole[] } {
    const factories = createCombatFactories();
    const gridSettings = simulationGridSettings();
    const units = roster.map((spec, index) =>
        createUnitFromSpec(
            spec,
            LEFT,
            gridSettings,
            factories.abilityFactory,
            factories.effectFactory,
            false,
            `replay-ab-source-${index}`,
        ),
    );
    const plans = planTacticalStackSplits(
        units.map(tacticalSplitUnitFromUnit),
        maximumStacks(creatureIds, augments, synergies),
    );
    if (!plans.length) return { roster: roster.map((unit) => ({ ...unit })), splitRoles: [] };

    const sourceIndex = new Map(units.map((unit, index) => [unit.getId(), index]));
    const childCount = new Map<number, number>();
    for (const plan of plans) {
        const index = sourceIndex.get(plan.sourceUnitId);
        if (index === undefined) throw new Error(`Replay A/B split source ${plan.sourceUnitId} disappeared`);
        childCount.set(index, (childCount.get(index) ?? 0) + 1);
    }
    const expanded = roster.map((unit, index) => ({ ...unit, amount: unit.amount - (childCount.get(index) ?? 0) }));
    const splitRoles: IRankedReplayAbSplitRole[] = [];
    for (const plan of plans) {
        const index = sourceIndex.get(plan.sourceUnitId)!;
        if (expanded[index].amount < 1) throw new Error("Replay A/B split exhausted its source stack");
        expanded.push({ ...roster[index], amount: 1 });
        splitRoles.push({ rosterIndex: expanded.length - 1, role: plan.role });
    }
    return { roster: expanded, splitRoles };
}

/** Placement is worth buying only when every slot it opens becomes an independent tactical utility stack. */
export function replayUtilitySplitGate(
    augments: readonly ISetupAugmentChoice[],
    splitRoles: readonly IRankedReplayAbSplitRole[],
): boolean {
    const placement = augments.find((augment) => augment.kind === "Placement")?.value ?? 0;
    return (
        placement > 0 &&
        splitRoles.length >= placement &&
        splitRoles.slice(0, placement).every((split) => split.role !== "bait")
    );
}

const setupPolicyForVariant = (
    variant: IRankedReplayAbArmy["variant"],
    components: RankedReplayAbComponents,
    ownCreatureIds: readonly number[],
): IResolvedSetupPolicy =>
    variant === "candidate" && components.setup && replayRapidChargeCoreEligible(ownCreatureIds)
        ? CANDIDATE_SETUP_POLICY
        : CONTROL_SETUP_POLICY;

export function materializeReplayAbArmy(
    base: IBaseArmy,
    opponentCreatureIds: readonly number[],
    map: number,
    variant: IRankedReplayAbArmy["variant"],
    components: RankedReplayAbComponents,
): IRankedReplayAbArmy {
    const policy = setupPolicyForVariant(variant, components, base.creatureIds);
    const context = createPlacementSetupDecisionContext({
        publicOpponentCreatureIds: opponentCreatureIds,
        gridType: map,
        gridSize: GRID_SIZE,
        ownDoctrine: base.doctrine,
        ownArtifactIds: [base.artifactT1, base.artifactT2].filter((artifact) => artifact > 0),
    });
    const rapidChargeTreatment =
        variant === "candidate" && components.setup && replayRapidChargeCoreEligible(base.creatureIds);
    let augments = rapidChargeTreatment
        ? setupAugmentsForPlan(REPLAY_RAPID_CHARGE_AUGMENT_PLAN)
        : policy.pickAugments(getUpgradePoints(base.doctrine), base.creatureIds, context);
    let synergies = policy.pickSynergies(base.creatureIds, context);
    let split =
        variant === "candidate" && components.splits
            ? materializeReplayAbSplits(base.roster, base.creatureIds, augments, synergies)
            : { roster: base.roster.map((unit) => ({ ...unit })), splitRoles: [] };
    if (
        variant === "candidate" &&
        components.setup &&
        components.splits &&
        !replayUtilitySplitGate(augments, split.splitRoles)
    ) {
        augments = CONTROL_SETUP_POLICY.pickAugments(getUpgradePoints(base.doctrine), base.creatureIds, context);
        synergies = CONTROL_SETUP_POLICY.pickSynergies(base.creatureIds, context);
        split = { roster: base.roster.map((unit) => ({ ...unit })), splitRoles: [] };
    }
    return {
        variant,
        creatureIds: [...base.creatureIds],
        roster: split.roster,
        originalRoster: base.roster.map((unit) => ({ ...unit })),
        doctrine: base.doctrine,
        artifactT1: base.artifactT1,
        artifactT2: base.artifactT2,
        augments,
        synergies,
        setupIdentity: replayTacticsArmyIdentity(base.creatureIds),
        splitRoles: split.splitRoles,
        revealedOpponentCreatures: [...base.revealedOpponentCreatures],
    };
}

class ReplayAbPlacementStrategy implements IAIStrategy {
    public readonly version: string;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly splitRoles: readonly IRankedReplayAbSplitRole[],
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        if (!this.splitRoles.length) return incumbent;
        return applyTacticalSplitPlacement(
            incumbent,
            units.map((unit) => ({
                id: unit.getId(),
                small: unit.isSmallSize(),
                footprintWidth: unit.getFootprintWidth(),
                footprintHeight: unit.getFootprintHeight(),
            })),
            {
                team: context.team,
                gridType: context.grid.getGridType(),
                legalCellHashes: context.placement.possibleCellHashes(),
                splitStacks: this.splitRoles.flatMap((split) => {
                    const unit = units[split.rosterIndex];
                    return unit ? [{ unitId: unit.getId(), role: split.role }] : [];
                }),
            },
        );
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

const strategyFor = (army: IRankedReplayAbArmy): IAIStrategy =>
    army.variant === "candidate"
        ? new ReplayAbPlacementStrategy(new StrategyV0_8(), army.splitRoles)
        : new ReplayAbPlacementStrategy(new StrategyV0_8S(), []);

const matchConfig = (
    green: IRankedReplayAbArmy,
    red: IRankedReplayAbArmy,
    seed: number,
    map: number,
    maxLaps: number,
): IMatchConfig => ({
    greenVersion: green.variant === "candidate" ? "v0.8" : "v0.8s",
    redVersion: red.variant === "candidate" ? "v0.8" : "v0.8s",
    greenStrategyOverride: strategyFor(green),
    redStrategyOverride: strategyFor(red),
    roster: green.roster,
    redRoster: red.roster,
    seed,
    gridType: map,
    maxLaps,
    headlessEvents: true,
    greenDoctrine: green.doctrine,
    redDoctrine: red.doctrine,
    greenArtifactT1: green.artifactT1,
    redArtifactT1: red.artifactT1,
    greenArtifactT2: green.artifactT2,
    redArtifactT2: red.artifactT2,
    greenAugments: green.augments,
    redAugments: red.augments,
    greenSynergies: green.synergies,
    redSynergies: red.synergies,
    placementAugmentTiming: "setup-before-placement",
    greenSetupPlacementPolicy: "public-roster",
    redSetupPlacementPolicy: "public-roster",
    greenPublicOpponentCreatures: red.creatureIds,
    redPublicOpponentCreatures: green.creatureIds,
    greenRevealedCreatures: green.revealedOpponentCreatures,
    redRevealedCreatures: red.revealedOpponentCreatures,
});

/** Complete dual-seat a13 environment; only the candidate alias receives the selected research treatment. */
export function buildRankedReplayAbEnvironment(
    components: RankedReplayAbComponents,
    combatEpsilon = 0.002,
    combatScope: RankedReplayAbCombatScope = "all",
    combatCandidate: RankedReplayAbCombatCandidate = "horizon-18",
): Record<string, string> {
    if (!Number.isFinite(combatEpsilon) || combatEpsilon < 0 || combatEpsilon > 0.05) {
        throw new RangeError("replay combat epsilon must be between 0 and 0.05");
    }
    if (!RANKED_REPLAY_AB_COMBAT_SCOPES.includes(combatScope)) {
        throw new RangeError(`replay combat scope must be ${RANKED_REPLAY_AB_COMBAT_SCOPES.join(" or ")}`);
    }
    if (!RANKED_REPLAY_AB_COMBAT_CANDIDATES.includes(combatCandidate)) {
        throw new RangeError(`replay combat candidate must be ${RANKED_REPLAY_AB_COMBAT_CANDIDATES.join(", ")}`);
    }
    if (components.combat && combatScope === "ranged-battery" && combatCandidate === "shortlist-3") {
        throw new RangeError("shortlist-3 is a version-scoped broad candidate and cannot use ranged-battery scope");
    }
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(buildV08A13SearchEnvironment("v0.8"))) {
        if (value !== undefined) environment[key] = value === "v0.8" ? "v0.8,v0.8s" : value;
    }
    environment.SEARCH_VERSIONS = "v0.8,v0.8s";
    // Freeze the historical control independently of the profile's current default. This prevents a future
    // H18/S3 promotion from silently turning a rerun into identity evidence.
    environment.SEARCH_HORIZON = "12";
    environment.SEARCH_SHORTLIST = "2";
    // Production v0.8 enables its shipped ranged-positioning layer by default while the historical v0.8s
    // measurement alias does not. This experiment is about the replay components, so both seats must carry
    // the same incumbent production policy before the candidate-only treatment is applied.
    environment.V08_RANGED_POSITION_VERSIONS = "v0.8,v0.8s";
    // Rejected replay priors and the charger reservation remain explicitly disabled in both seats. The current
    // combat arm changes only one bounded a13 search control in the candidate seat.
    environment.SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON = "0";
    environment.SEARCH_V08_RANKED_REPLAY_TIEBREAK_VERSIONS = "";
    environment.SEARCH_V08_RANKED_REPLAY_TIEBREAK_GRIDS = "";
    environment.SEARCH_V08_RAPID_CHARGE_RESERVATION = "0";
    environment.SEARCH_V08_RAPID_CHARGE_RESERVATION_VERSIONS = "";
    if (components.combat) {
        if (combatCandidate === "shortlist-3") {
            environment.SEARCH_RESEARCH_SHORTLIST = "3";
            environment.SEARCH_RESEARCH_SHORTLIST_VERSIONS = "v0.8";
        } else {
            environment.SEARCH_RESEARCH_HORIZON = combatCandidate.slice("horizon-".length);
            environment.SEARCH_RESEARCH_HORIZON_VERSIONS = "v0.8";
            if (combatScope === "ranged-battery") {
                environment.SEARCH_RESEARCH_HORIZON_MIN_RANGED_TYPES = "2";
            }
        }
    }
    environment.V07_WAIT_WEIGHTS_V2 = components.wait ? JSON.stringify(MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11) : "";
    environment[V07_WAIT_WEIGHTS_V2_VERSIONS_ENV] = components.wait ? "v0.8" : "";
    environment[V07_WAIT_WEIGHTS_V2_GRIDS_ENV] = components.wait ? String(PBTypes.GridVals.NORMAL) : "";
    environment[V07_WAIT_WEIGHTS_V2_MAX_INITIAL_RANGED_ENV] = components.wait ? "1" : "";
    environment.V08_RANKED_REPLAY_TACTICS_VERSIONS = "";
    environment.LIVETWIN = "1";
    environment.FIGHT_MELEE_ROSTERS = "0";
    environment.SIM_NO_ACTIONS = "1";
    return environment;
}

export const rankedReplayAbEnvironmentSha256 = (
    components: RankedReplayAbComponents,
    combatEpsilon = 0.002,
    combatScope: RankedReplayAbCombatScope = "all",
    combatCandidate: RankedReplayAbCombatCandidate = "horizon-18",
): string =>
    createHash("sha256")
        .update(
            JSON.stringify(
                Object.entries(
                    buildRankedReplayAbEnvironment(components, combatEpsilon, combatScope, combatCandidate),
                ).sort(([a], [b]) => a.localeCompare(b)),
            ),
        )
        .digest("hex");

interface IAssignment {
    candidate: IRankedReplayAbArmy;
    control: IRankedReplayAbArmy;
    draftSeat: IRankedReplayAbGameOutcome["draftSeat"];
}

const setupFingerprint = (candidate: IRankedReplayAbArmy, control: IRankedReplayAbArmy, map: number): string =>
    createHash("sha256")
        .update(
            JSON.stringify({
                candidate: {
                    roster: candidate.roster,
                    doctrine: candidate.doctrine,
                    t1: candidate.artifactT1,
                    t2: candidate.artifactT2,
                    augments: candidate.augments,
                    synergies: candidate.synergies,
                    splits: candidate.splitRoles,
                },
                control: {
                    roster: control.roster,
                    doctrine: control.doctrine,
                    t1: control.artifactT1,
                    t2: control.artifactT2,
                    augments: control.augments,
                    synergies: control.synergies,
                },
                map,
            }),
        )
        .digest("hex");

const outcome = (
    result: IMatchResult,
    assignment: 0 | 1,
    battleMirror: 0 | 1,
    draftSeat: IRankedReplayAbGameOutcome["draftSeat"],
    candidate: IRankedReplayAbArmy,
    control: IRankedReplayAbArmy,
    candidateIsGreen: boolean,
    fingerprint: string,
    combatMatchupEligible: boolean,
): IRankedReplayAbGameOutcome => {
    const candidateSide: Side = candidateIsGreen ? "green" : "red";
    const candidateResult = result.winner === "draw" ? "draw" : result.winner === candidateSide ? "win" : "loss";
    const own = candidateIsGreen ? result.outcome.green : result.outcome.red;
    const opposing = candidateIsGreen ? result.outcome.red : result.outcome.green;
    return {
        assignment,
        battleMirror,
        draftSeat,
        candidateSide,
        winner: result.winner,
        candidateResult,
        candidateScore: candidateResult === "win" ? 1 : candidateResult === "draw" ? 0.5 : 0,
        laps: result.laps,
        endReason: result.endReason,
        armageddonDecided: result.attrition.decidedByArmageddon,
        rejectedCandidate: (candidateIsGreen ? result.rejectedGreen : result.rejectedRed) ?? 0,
        rejectedControl: (candidateIsGreen ? result.rejectedRed : result.rejectedGreen) ?? 0,
        candidateHpMargin: own.hpRemaining - opposing.hpRemaining,
        candidateSurvivorMargin: own.unitsAlive - opposing.unitsAlive,
        candidateRosterSignature: rosterSignature(candidate.originalRoster),
        controlRosterSignature: rosterSignature(control.originalRoster),
        candidateSetupIdentity: candidate.setupIdentity,
        combatMatchupEligible,
        candidateSplitStacks: candidate.splitRoles.length,
        setupFingerprint: fingerprint,
    };
};

const playAssignment = (
    assignment: IAssignment,
    assignmentIndex: 0 | 1,
    combatSeed: number,
    map: number,
    maxLaps: number,
    combatMatchupEligible: boolean,
): [IRankedReplayAbGameOutcome, IRankedReplayAbGameOutcome] => {
    const fingerprint = setupFingerprint(assignment.candidate, assignment.control, map);
    const candidateGreen = runMatch(matchConfig(assignment.candidate, assignment.control, combatSeed, map, maxLaps));
    const candidateRed = runMatch(matchConfig(assignment.control, assignment.candidate, combatSeed, map, maxLaps));
    return [
        outcome(
            candidateGreen,
            assignmentIndex,
            0,
            assignment.draftSeat,
            assignment.candidate,
            assignment.control,
            true,
            fingerprint,
            combatMatchupEligible,
        ),
        outcome(
            candidateRed,
            assignmentIndex,
            1,
            assignment.draftSeat,
            assignment.candidate,
            assignment.control,
            false,
            fingerprint,
            combatMatchupEligible,
        ),
    ];
};

const rankedAssignments = (
    pickSeed: number,
    map: number,
    components: RankedReplayAbComponents,
): [IAssignment, IAssignment] =>
    ([LEFT, RIGHT] as const).map((candidateTeam): IAssignment => {
        const pick = resolveRankedReplayAbPick(pickSeed, map, candidateTeam, components);
        const left = rankedBaseArmy(pick.left, getKnownOpponentCreatures(pick, LEFT));
        const right = rankedBaseArmy(pick.right, getKnownOpponentCreatures(pick, RIGHT));
        const candidateBase = candidateTeam === LEFT ? left : right;
        const controlBase = candidateTeam === LEFT ? right : left;
        if (!rostersAreStrictlyDistinct(candidateBase.roster, controlBase.roster)) {
            throw new Error("Replay A/B ranked assignment produced overlapping rosters");
        }
        return {
            candidate: materializeReplayAbArmy(candidateBase, controlBase.creatureIds, map, "candidate", components),
            control: materializeReplayAbArmy(controlBase, candidateBase.creatureIds, map, "control", components),
            draftSeat: candidateTeam === LEFT ? "candidate-lower" : "candidate-upper",
        };
    }) as [IAssignment, IAssignment];

const syntheticAssignments = (
    options: IRankedReplayAbOptions,
    pair: number,
    map: number,
): [IAssignment, IAssignment] => {
    const prepared = prepareMetaPair(
        { cohort: options.cohort, games: options.pairs * 2, baseSeed: options.baseSeed },
        pair,
    );
    const baseA = metaBaseArmy(prepared.armyA);
    const baseB = metaBaseArmy(prepared.armyB);
    if (!rostersAreStrictlyDistinct(baseA.roster, baseB.roster)) {
        throw new Error("Replay A/B synthetic assignment produced overlapping rosters");
    }
    return (
        [
            [baseA, baseB, "candidate-roster-a"],
            [baseB, baseA, "candidate-roster-b"],
        ] as const
    ).map(([candidateBase, controlBase, draftSeat]): IAssignment => ({
        candidate: materializeReplayAbArmy(
            candidateBase,
            controlBase.creatureIds,
            map,
            "candidate",
            options.components,
        ),
        control: materializeReplayAbArmy(controlBase, candidateBase.creatureIds, map, "control", options.components),
        draftSeat,
    })) as [IAssignment, IAssignment];
};

export function playRankedReplayAbCluster(options: IRankedReplayAbOptions, pair: number): IRankedReplayAbClusterRecord {
    if (!AI_META_COHORTS.includes(options.cohort)) throw new Error(`Unknown replay A/B cohort ${options.cohort}`);
    if (!Number.isInteger(options.pairs) || options.pairs < 1)
        throw new RangeError("Replay A/B pairs must be positive");
    if (!Number.isInteger(pair) || pair < 0 || pair >= options.pairs) {
        throw new RangeError(`Replay A/B pair ${pair} is outside [0, ${options.pairs})`);
    }
    const map = cohortMap(options.cohort, pair);
    const pairSeed = hashSimulationParts("ranked-replay-ab-pair", options.baseSeed, options.cohort, pair);
    const pickSeed = hashSimulationParts("ranked-replay-ab-pick", options.baseSeed, options.cohort, pair);
    const combatSeed = hashSimulationParts("ranked-replay-ab-combat", options.baseSeed, options.cohort, pair);
    const assignments =
        options.cohort === "ranked-draft"
            ? rankedAssignments(pickSeed, map, options.components)
            : syntheticAssignments(options, pair, map);
    // The exposure label belongs to the complete four-game crossover cluster. Conditioning on only the
    // candidate-ranged assignment would discard the same roster's control assignment and confound policy with
    // roster strength. A ranged-battery cluster is exposed when either roster receives the scoped treatment in its
    // candidate assignment; every game retains the shared cluster label.
    const combatMatchupEligible = rankedReplayCombatClusterEligible(
        options.components,
        options.combatScope,
        assignments.map(({ candidate }) => candidate.setupIdentity),
    );
    const first = playAssignment(assignments[0], 0, combatSeed, map, options.maxLaps ?? 60, combatMatchupEligible);
    const second = playAssignment(assignments[1], 1, combatSeed, map, options.maxLaps ?? 60, combatMatchupEligible);
    return {
        schema: RANKED_REPLAY_TACTICS_AB_SCHEMA,
        cohort: options.cohort,
        pair,
        pairSeed,
        pickSeed,
        combatSeed,
        map,
        components: { ...options.components },
        combatScope: options.combatScope,
        combatCandidate: options.combatCandidate,
        games: [first[0], first[1], second[0], second[1]],
    };
}

const metricRow = (
    key: string,
    clusters: readonly (readonly IRankedReplayAbGameOutcome[])[],
): IRankedReplayAbMetricRow => {
    const exposedClusters = clusters.filter((games) => games.length > 0);
    const allGames = exposedClusters.flatMap((games) => games);
    const scoreRate = allGames.length
        ? allGames.reduce((sum, game) => sum + game.candidateScore, 0) / allGames.length
        : 0.5;
    let standardError: number | null = null;
    if (exposedClusters.length >= 2) {
        // Cluster-robust ratio variance. The primary panels have four equally weighted games per cluster;
        // conditional setup/split panels may expose only two. Weighting observations estimates the score of
        // a game with that property, while summing residuals inside each offer-board cluster preserves the
        // paired dependence and reduces to the ordinary cluster-mean SE when every cluster has equal size.
        const residualSquares = exposedClusters.reduce((sum, games) => {
            const clusterResidual = games.reduce((clusterSum, game) => clusterSum + game.candidateScore - scoreRate, 0);
            return sum + clusterResidual ** 2;
        }, 0);
        standardError =
            Math.sqrt((exposedClusters.length / (exposedClusters.length - 1)) * residualSquares) / allGames.length;
    }
    const margin = standardError === null ? 1 : 1.959963984540054 * standardError;
    return {
        key,
        clusters: exposedClusters.length,
        games: allGames.length,
        wins: allGames.filter((game) => game.candidateResult === "win").length,
        losses: allGames.filter((game) => game.candidateResult === "loss").length,
        draws: allGames.filter((game) => game.candidateResult === "draw").length,
        scoreRate,
        liftPp: (scoreRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        ciLow: Math.max(0, scoreRate - margin),
        ciHigh: Math.min(1, scoreRate + margin),
    };
};

const groupedMetrics = (
    records: readonly IRankedReplayAbClusterRecord[],
    keys: readonly string[],
    gamesFor: (record: IRankedReplayAbClusterRecord, key: string) => readonly IRankedReplayAbGameOutcome[],
): IRankedReplayAbMetricRow[] =>
    keys.map((key) =>
        metricRow(
            key,
            records.flatMap((record) => {
                const games = gamesFor(record, key);
                return games.length ? [games] : [];
            }),
        ),
    );

/** Fixed-allocation variance for the preregistered equal cohort-by-map primary estimand. */
const fixedStratifiedOverallMetric = (records: readonly IRankedReplayAbClusterRecord[]): IRankedReplayAbMetricRow => {
    const strata = new Map<string, IRankedReplayAbClusterRecord[]>();
    for (const record of records) {
        const key = `${record.cohort}:map-${record.map}`;
        const existing = strata.get(key);
        if (existing) existing.push(record);
        else strata.set(key, [record]);
    }
    const allGames = records.flatMap((record) => record.games);
    if (!strata.size || !allGames.length) return metricRow("overall", []);

    const stratumMeans = [...strata.values()].map((stratum) => {
        const scores = stratum.map(
            (record) => record.games.reduce((sum, game) => sum + game.candidateScore, 0) / record.games.length,
        );
        return { scores, mean: scores.reduce((sum, score) => sum + score, 0) / scores.length };
    });
    const scoreRate = stratumMeans.reduce((sum, stratum) => sum + stratum.mean, 0) / stratumMeans.length;
    let standardError: number | null = null;
    if (stratumMeans.every((stratum) => stratum.scores.length >= 2)) {
        const variance = stratumMeans.reduce((sum, stratum) => {
            const sampleVariance =
                stratum.scores.reduce((squareSum, score) => squareSum + (score - stratum.mean) ** 2, 0) /
                (stratum.scores.length - 1);
            return sum + sampleVariance / stratum.scores.length;
        }, 0);
        standardError = Math.sqrt(variance / stratumMeans.length ** 2);
    }
    const margin = standardError === null ? 1 : 1.959963984540054 * standardError;
    return {
        key: "overall",
        clusters: records.length,
        games: allGames.length,
        wins: allGames.filter((game) => game.candidateResult === "win").length,
        losses: allGames.filter((game) => game.candidateResult === "loss").length,
        draws: allGames.filter((game) => game.candidateResult === "draw").length,
        scoreRate,
        liftPp: (scoreRate - 0.5) * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        ciLow: Math.max(0, scoreRate - margin),
        ciHigh: Math.min(1, scoreRate + margin),
    };
};

export function summarizeRankedReplayAbRecords(
    records: readonly IRankedReplayAbClusterRecord[],
): IRankedReplayAbSummaryRows {
    const cohorts = [...new Set(records.map((record) => record.cohort))].sort();
    const maps = [...new Set(records.map((record) => record.map))].sort((left, right) => left - right);
    const identities = ["ranged-battery", "fast-mobile-melee", "healer-durable-carry", "ordinary"];
    return {
        overall: fixedStratifiedOverallMetric(records),
        cohorts: groupedMetrics(records, cohorts, (record, key) => (record.cohort === key ? record.games : [])),
        maps: groupedMetrics(records, maps.map(String), (record, key) =>
            String(record.map) === key ? record.games : [],
        ),
        cohortMaps: groupedMetrics(
            records,
            cohorts.flatMap((cohort) => maps.map((map) => `${cohort}:map-${map}`)),
            (record, key) => (key === `${record.cohort}:map-${record.map}` ? record.games : []),
        ),
        setupIdentities: groupedMetrics(records, identities, (record, key) =>
            record.games.filter((game) => game.candidateSetupIdentity === key),
        ),
        splitTrigger: groupedMetrics(records, ["split", "no-split"], (record, key) =>
            record.games.filter((game) => (game.candidateSplitStacks > 0 ? "split" : "no-split") === key),
        ),
        // Retain the complete treatment/control crossover. Conditioning on only one candidate army drops that
        // roster's control assignment and confounds policy effect with roster strength.
        combatEligibility: groupedMetrics(records, ["eligible-matchup", "ineligible-matchup"], (record, key) => {
            const trigger = record.games.some((game) => game.combatMatchupEligible)
                ? "eligible-matchup"
                : "ineligible-matchup";
            return trigger === key ? record.games : [];
        }),
    };
}
