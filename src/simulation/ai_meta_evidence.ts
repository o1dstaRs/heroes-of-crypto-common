import {
    assertPremiumAugmentPlan,
    premiumAugmentPlanCost,
    premiumAugmentPlanId,
    premiumSetupAugmentsForPlan,
    enumeratePremiumAugmentPlans,
} from "../ai/setup/premium_augment_plans";
import { enumerateFullBudgetAugmentPlans } from "../ai/setup/setup_ship";
import { getUpgradePoints, type Doctrine } from "../doctrines/doctrine_properties";
import {
    PREMIUM_META_FULL_AUGMENTS_STUDY,
    PREMIUM_META_FULL_AUGMENTS_SCHEMA,
    isPublicSetupStudy,
    PREMIUM_META_EVIDENCE_SCHEMA,
    isPremiumMetaStudy,
    type AiMetaStudy,
} from "./ai_meta_study";
import type { ISetupAugmentChoice } from "../ai/setup/setup_ship";
import type { TacticalSplitRole } from "../ai/tactical_split_placement";
import {
    createPickSimState,
    getPickTeamView,
    getKnownOpponentCreatures,
    getVisibleCreatureChoices,
    transitionServerPersistedPickSim,
    isPickSimComplete,
    type IPickSimState,
    type PickAction,
    type PickTranscriptEntry,
} from "../picks/pick_sim";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { synergyVariantsForSeed } from "../synergies/synergy_properties";
import { hashSimulationParts, makeRng, type IArmyUnitSpec } from "./army";
import type { IMatchResult, IPlacementRecord, IRecordedAction, ITurnExecutionObservation } from "./battle_engine";
import type { IAiMetaPairRecord } from "./ai_meta_cohorts_core";
import { GRID_SIZE } from "../grid/grid_constants";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { GameEvent } from "../engine/events";
import type { ArtifactBarrel } from "../grid/grid";
import type { UnitProperties } from "../units/unit_properties";
import { footprintCellsForRecord } from "./footprint";
import { summarizePremiumParticipation, type IPremiumCombatParticipation } from "./ai_meta_participation";
import { summarizePremiumCombatMetrics, type IPremiumCombatMetrics } from "./ai_meta_combat_metrics";
import { validatePremiumHealthLedger, type IPremiumHealthObservation } from "./ai_meta_health_ledger";

/** Additive archive extension: legacy schema-1 balance readers may continue to ignore this field. */
export const AI_META_EVIDENCE_SCHEMA = "premium-cohort-evidence-v1";
export const AI_META_EVIDENCE_ENV = "AI_META_COLLECT_EVIDENCE";

export interface IAiMetaChoiceEvidence {
    /** Full behavior probability, including BOTH epsilon-greedy paths for the greedy action. */
    behaviorProbability: number;
    branchProbability: number;
    conditionalProbability: number;
    candidates: { key: string; score: number; probability: number }[];
}

export function aiMetaChoiceEvidence(
    candidates: readonly { key: string; score: number }[],
    greedyKey: string,
    selectedKey: string,
    mode: "explore" | "exploit",
    epsilon: number,
): IAiMetaChoiceEvidence {
    if (
        !candidates.length ||
        !Number.isFinite(epsilon) ||
        epsilon < 0 ||
        epsilon > 1 ||
        new Set(candidates.map(({ key }) => key)).size !== candidates.length ||
        !candidates.some(({ key }) => key === greedyKey) ||
        !candidates.some(({ key }) => key === selectedKey) ||
        candidates.some(({ score }) => !Number.isFinite(score)) ||
        (mode === "exploit" && (selectedKey !== greedyKey || epsilon === 1)) ||
        (mode === "explore" && epsilon === 0)
    )
        throw new Error("Invalid AI meta selection distribution");
    const distribution = candidates.map(({ key, score }) => ({
        key,
        score,
        probability: epsilon / candidates.length + (key === greedyKey ? 1 - epsilon : 0),
    }));
    return {
        behaviorProbability: distribution.find(({ key }) => key === selectedKey)!.probability,
        branchProbability: mode === "explore" ? epsilon : 1 - epsilon,
        conditionalProbability: mode === "explore" ? 1 / candidates.length : 1,
        candidates: distribution,
    };
}

export interface IAiMetaDraftDecision {
    index: number;
    /** Viewer-safe pre-action state; never copy the opponent's private team object here. */
    observation: ReturnType<typeof getPickTeamView> & {
        availableCreatureIds: number[];
        revealedOpponentSlots: number[];
        revealedMap: number | null;
        synergyVariants: ReturnType<typeof synergyVariantsForSeed>;
    };
    action: PickAction;
    status: "accepted" | "collision";
    /** The legacy deterministic selector does not explore draft alternatives. */
    behaviorProbability: number;
    choice?: IAiMetaChoiceEvidence;
    scoreMeaning?: "baseline-policy-preference";
}

export interface IAiMetaDraftEvidence {
    seed: number;
    policy: string;
    /** Prevent treating a captured observation as proof the old selector used every feature. */
    unusedObservationFeatures: readonly ("synergyVariants" | "revealedMap")[];
    doctrines?: { a: Doctrine; b: Doctrine };
    knownOpponentCreatureIds?: { a: number[]; b: number[] };
    optionalBans?: "skipped";
    decisions: IAiMetaDraftDecision[];
    transcript: PickTranscriptEntry[];
    draftedArtifacts: {
        a: { tier1: number; tier2: number };
        b: { tier1: number; tier2: number };
    };
    /** Research setup replaces draft artifacts; these outcomes are not a live draft-policy evaluation. */
    outcomeContinuation:
        | "post-draft-artifact-and-augment-oracle"
        | "retained-draft-artifacts-private-setup-v1"
        | "retained-draft-artifacts-public-setup-v2";
}

export interface IAiMetaFormationEvidence {
    expandedRoster: IArmyUnitSpec[];
    draftedCreatureIdsByStack: number[];
    unitIdsByStack: string[];
    splitRoles: { rosterIndex: number; role: TacticalSplitRole }[];
    placements: IPlacementRecord[];
    augments: ISetupAugmentChoice[];
}

export interface IAiMetaFightEvidence {
    aIsGreen: boolean;
    formations: { a: IAiMetaFormationEvidence; b: IAiMetaFormationEvidence };
    /** Physical sides retained on actions and outcomes; aIsGreen supplies the logical-army mapping. */
    actions: IRecordedAction[];
    totalActions: number;
    outcome: IMatchResult["outcome"];
    attrition: IMatchResult["attrition"];
    executionTrace?: ITurnExecutionObservation[];
    /** V4 includes start/activation/environmental events absent from turn-only traces. */
    committedEventBatches?: { lap: number; events: readonly GameEvent[] }[];
    firstDecisionState?: {
        stage: "first-decision-after-start";
        actingUnitId: string;
        lap: number;
        /** V4 records actual terrain after automatic artifact barrels are placed. */
        board?: {
            gridType: number;
            matrix: number[][];
            artifactBarrels: ArtifactBarrel[];
            mountainsStanding: { x: number; y: number }[];
        };
        units: { properties: Readonly<UnitProperties>; cells: { x: number; y: number }[] }[];
    };
    /** Additive V4 capture: end-of-simulation survivors and the existing engine's display damage tally. */
    terminalState?: {
        stage: "after-simulation";
        units: {
            properties: Readonly<UnitProperties>;
            cells: { x: number; y: number }[];
            cumulativeHp: number;
            alive: boolean;
        }[];
        damageStatistics: IDamageStatistic[] | null;
        damageScope: "engine-display-by-creature-team-lap-not-complete-attribution";
    };
    telemetryScope: "accepted-action-events-not-complete-damage-attribution";
    participation?: IPremiumCombatParticipation;
    combatMetrics?: IPremiumCombatMetrics;
    healthLedger?: IPremiumHealthObservation[];
}

export interface IAiMetaEvidence {
    schema:
        | typeof AI_META_EVIDENCE_SCHEMA
        | "premium-cohort-evidence-v2"
        | "premium-cohort-evidence-v3"
        | typeof PREMIUM_META_EVIDENCE_SCHEMA
        | typeof PREMIUM_META_FULL_AUGMENTS_SCHEMA;
    studyProfile?: AiMetaStudy;
    scenarioId: string;
    partition: "train" | "validation" | "test";
    lane: "baseline";
    synergyVariants: ReturnType<typeof synergyVariantsForSeed>;
    rankedDraft: IAiMetaDraftEvidence | null;
    setupVisibility: "post-draft-full-roster-oracle" | "draft-reveals-only" | "post-draft-public-roster";
    setupObservations?: Record<
        "a" | "b",
        { knownOpponentCreatureIds: number[]; opponentRosterVisibility: "partial" | "complete" }
    >;
    geometry: {
        gridType: number;
        orientation: "legacy-corners" | "ranked-sides";
        seed: number;
        recipe: "battle-engine-default-grid-v1" | "ranked-side-grid-sim-seed-v1";
        mountainCells?: { x: number; y: number }[];
    };
    /** Complete only after BOTH seat-swapped fights finish. */
    fights?: [IAiMetaFightEvidence, IAiMetaFightEvidence];
}

export function aiMetaEvidencePartition(baseSeed: number, cohort: string, pair: number): IAiMetaEvidence["partition"] {
    const bucket = hashSimulationParts("ai-meta-evidence-partition-v1", baseSeed, cohort, pair) % 100;
    return bucket < 80 ? "train" : bucket < 90 ? "validation" : "test";
}

/** Clone at decision time: simultaneous decisions must share the same pre-commit observation. */
export function cloneAiMetaDraftObservation<T>(value: T): T {
    return structuredClone(value);
}

export function aiMetaDraftArtifacts(state: IPickSimState): IAiMetaDraftEvidence["draftedArtifacts"] {
    const artifacts = (team: IPickSimState["left"]) => {
        if (!team.tier1Artifact || !team.tier2Artifact) throw new Error("Incomplete AI meta draft artifacts");
        return { tier1: team.tier1Artifact, tier2: team.tier2Artifact };
    };
    return { a: artifacts(state.left), b: artifacts(state.right) };
}

function validatePremiumDraft(record: IAiMetaPairRecord): void {
    const evidence = record.evidence!;
    const draft = evidence.rankedDraft;
    if (!draft) return;
    const rng = makeRng(draft.seed);
    const randomInt = (max: number) => Math.floor(rng() * max);
    let state = createPickSimState(randomInt);
    let phaseStart = state;
    for (const [index, decision] of draft.decisions.entries()) {
        if (state.phaseSequence !== phaseStart.phaseSequence) phaseStart = state;
        const observed = [0, 1, 8].includes(state.phaseSequence) ? phaseStart : state;
        const own = decision.action.team === PBTypes.TeamVals.LEFT ? observed.left : observed.right;
        const expected = {
            ...getPickTeamView(observed, decision.action.team),
            availableCreatureIds: getVisibleCreatureChoices(observed, decision.action.team),
            revealedOpponentSlots: [...own.revealedOpponentSlots],
            revealedMap: observed.phaseSequence >= 6 ? record.map : null,
            synergyVariants: evidence.synergyVariants,
        };
        if (decision.index !== index || JSON.stringify(decision.observation) !== JSON.stringify(expected))
            throw new Error("Premium draft observation does not match its viewer-safe replay");
        const action = decision.action;
        const offered =
            action.type === "pick_creature"
                ? expected.availableCreatureIds
                : action.type === "select_bundle"
                  ? expected.bundles.map((_, i) => i)
                  : action.type === "select_tier2"
                    ? expected.tier2Offers
                    : [1, 2, 3];
        if (
            JSON.stringify(decision.choice?.candidates.map(({ key }) => Number(key))) !== JSON.stringify(offered) ||
            decision.choice?.candidates.some(
                ({ probability, score }) =>
                    !Number.isFinite(probability) || probability <= 0 || probability > 1 || !Number.isFinite(score),
            )
        )
            throw new Error("Premium draft candidates differ from visible offers");
        const result = transitionServerPersistedPickSim(state, action, randomInt);
        if (result.status === "rejected" || result.status !== decision.status)
            throw new Error("Premium draft action cannot be replayed");
        state = result.state;
    }
    if (
        !isPickSimComplete(state) ||
        JSON.stringify(state.transcript) !== JSON.stringify(draft.transcript) ||
        JSON.stringify(state.left.creatures) !== JSON.stringify(record.armyA.creatureIds) ||
        JSON.stringify(state.right.creatures) !== JSON.stringify(record.armyB.creatureIds) ||
        JSON.stringify(aiMetaDraftArtifacts(state)) !== JSON.stringify(draft.draftedArtifacts) ||
        JSON.stringify({
            a: getKnownOpponentCreatures(state, PBTypes.TeamVals.LEFT),
            b: getKnownOpponentCreatures(state, PBTypes.TeamVals.RIGHT),
        }) !== JSON.stringify(draft.knownOpponentCreatureIds) ||
        JSON.stringify({ a: state.left.doctrine, b: state.right.doctrine }) !== JSON.stringify(draft.doctrines)
    )
        throw new Error("Premium draft replay did not reach the archived armies");
}

/** Fail the archive write on incomplete captures, broken ancestry, or invalid sampling distributions. */
export function validateAiMetaEvidence(record: IAiMetaPairRecord): void {
    const evidence = record.evidence;
    if (
        !evidence ||
        ![
            AI_META_EVIDENCE_SCHEMA,
            "premium-cohort-evidence-v2",
            "premium-cohort-evidence-v3",
            PREMIUM_META_EVIDENCE_SCHEMA,
            PREMIUM_META_FULL_AUGMENTS_SCHEMA,
        ].includes(evidence.schema) ||
        evidence.fights?.length !== 2
    ) {
        throw new Error("AI meta evidence is missing its schema or seat-swapped fights");
    }
    if (
        evidence.geometry.gridType !== record.map ||
        (record.cohort === "ranked-draft") !== Boolean(evidence.rankedDraft)
    ) {
        throw new Error("AI meta evidence context does not match the pair");
    }
    if (evidence.schema !== AI_META_EVIDENCE_SCHEMA) {
        validatePremiumDraft(record);
        const publicSetup = isPublicSetupStudy(evidence.studyProfile);
        const fullAugments = evidence.studyProfile === PREMIUM_META_FULL_AUGMENTS_STUDY;
        if (fullAugments !== (evidence.schema === PREMIUM_META_FULL_AUGMENTS_SCHEMA))
            throw new Error("Premium augment domain does not match the evidence schema");
        if (
            !isPremiumMetaStudy(evidence.studyProfile) ||
            evidence.geometry.orientation !== "ranked-sides" ||
            evidence.setupVisibility !== (publicSetup ? "post-draft-public-roster" : "draft-reveals-only") ||
            !evidence.setupObservations
        ) {
            throw new Error("Premium evidence has incompatible study context");
        }
        for (const [side, army] of [
            ["a", record.armyA],
            ["b", record.armyB],
        ] as const) {
            const budget = getUpgradePoints(army.doctrine);
            assertPremiumAugmentPlan(army.augment.plan, budget);
            if (!fullAugments && army.augment.plan.empower)
                throw new Error("Historical Premium study cannot contain Empower allocations");
            const catalog = (
                fullAugments ? enumeratePremiumAugmentPlans(budget) : enumerateFullBudgetAugmentPlans(budget)
            )
                .map(premiumAugmentPlanId)
                .sort();
            if (
                army.augment.planId !== premiumAugmentPlanId(army.augment.plan) ||
                JSON.stringify(army.augment.augments) !==
                    JSON.stringify(premiumSetupAugmentsForPlan(army.augment.plan)) ||
                JSON.stringify(army.augment.evidence?.candidates.map(({ key }) => key).sort()) !==
                    JSON.stringify(catalog)
            )
                throw new Error("Premium augment choice does not match its legal domain");
            if (premiumAugmentPlanCost(army.augment.plan) !== budget)
                throw new Error("Premium evidence has wrong doctrine budget");
            const draft = evidence.rankedDraft;
            const expectedOpponent = publicSetup
                ? (side === "a" ? record.armyB : record.armyA).creatureIds
                : (draft?.knownOpponentCreatureIds?.[side] ?? []);
            if (
                JSON.stringify(evidence.setupObservations[side].knownOpponentCreatureIds) !==
                    JSON.stringify(expectedOpponent) ||
                evidence.setupObservations[side].opponentRosterVisibility !== (publicSetup ? "complete" : "partial")
            )
                throw new Error("Premium setup observation violates its study visibility contract");
            if (
                draft &&
                (draft.outcomeContinuation !==
                    (publicSetup
                        ? "retained-draft-artifacts-public-setup-v2"
                        : "retained-draft-artifacts-private-setup-v1") ||
                    draft.draftedArtifacts[side].tier1 !== army.artifactT1.id ||
                    draft.draftedArtifacts[side].tier2 !== army.artifactT2.id ||
                    draft.doctrines?.[side] !== army.doctrine)
            ) {
                throw new Error("Premium evidence did not retain its draft setup");
            }
        }
        for (const decision of evidence.rankedDraft?.decisions ?? []) {
            const action = decision.action;
            const key = String(
                action.type === "select_bundle"
                    ? action.bundleIndex
                    : action.type === "select_tier2"
                      ? action.artifactId
                      : action.type === "select_doctrine"
                        ? action.doctrine
                        : action.creatureId,
            );
            if (
                !decision.choice ||
                decision.choice.behaviorProbability !== decision.behaviorProbability ||
                decision.choice.candidates.find((candidate) => candidate.key === key)?.probability !==
                    decision.behaviorProbability ||
                Math.abs(decision.choice.candidates.reduce((sum, candidate) => sum + candidate.probability, 0) - 1) >
                    1e-9
            ) {
                throw new Error("Premium evidence has invalid draft probabilities");
            }
        }
    }
    for (const army of [record.armyA, record.armyB]) {
        for (const choice of [army.artifactT1, army.artifactT2, army.augment]) {
            const distribution = choice.evidence;
            const key = "id" in choice ? String(choice.id) : choice.planId;
            if (
                !distribution ||
                !distribution.candidates.length ||
                new Set(distribution.candidates.map((candidate) => candidate.key)).size !==
                    distribution.candidates.length ||
                distribution.candidates.some(
                    ({ probability, score }) =>
                        !Number.isFinite(score) || !Number.isFinite(probability) || probability < 0 || probability > 1,
                ) ||
                Math.abs(distribution.candidates.reduce((sum, item) => sum + item.probability, 0) - 1) > 1e-9 ||
                !(distribution.behaviorProbability > 0) ||
                distribution.candidates.find((item) => item.key === key)?.probability !==
                    distribution.behaviorProbability
            ) {
                throw new Error("AI meta evidence has an invalid behavior distribution");
            }
        }
    }
    for (const [index, fight] of evidence.fights.entries()) {
        if (fight.healthLedger) validatePremiumHealthLedger(fight.healthLedger, fight.committedEventBatches ?? []);
        if (
            fight.participation &&
            JSON.stringify(fight.participation) !== JSON.stringify(summarizePremiumParticipation(fight))
        )
            throw new Error("Premium participation summary disagrees with committed evidence");
        if (
            fight.combatMetrics &&
            JSON.stringify(fight.combatMetrics) !== JSON.stringify(summarizePremiumCombatMetrics(fight))
        )
            throw new Error("Premium combat metrics disagree with committed evidence");
        const game = record.games[index];
        const outcomeA = fight.aIsGreen ? fight.outcome.green : fight.outcome.red;
        const outcomeB = fight.aIsGreen ? fight.outcome.red : fight.outcome.green;
        if (
            outcomeA.hpRemaining !== game.hpA ||
            outcomeB.hpRemaining !== game.hpB ||
            outcomeA.unitsAlive !== game.survivorsA ||
            outcomeB.unitsAlive !== game.survivorsB ||
            fight.attrition.decidedByArmageddon !== game.armageddonDecided ||
            fight.totalActions !== fight.actions.length
        )
            throw new Error("Premium fight capture disagrees with paired outcome or action count");
        if (
            ["premium-cohort-evidence-v3", PREMIUM_META_EVIDENCE_SCHEMA, PREMIUM_META_FULL_AUGMENTS_SCHEMA].includes(
                evidence.schema,
            ) &&
            fight.totalActions > 0 &&
            (!fight.firstDecisionState?.units.length || !fight.executionTrace?.length)
        )
            throw new Error("Premium evidence is missing effective starting units or turn execution traces");
        if (
            [PREMIUM_META_EVIDENCE_SCHEMA, PREMIUM_META_FULL_AUGMENTS_SCHEMA].includes(evidence.schema) &&
            fight.totalActions > 0 &&
            (!fight.firstDecisionState?.board || !fight.committedEventBatches?.length)
        )
            throw new Error("Premium evidence is missing its effective starting board or committed events");
        if (fight.terminalState)
            for (const [team, outcome] of [
                [PBTypes.TeamVals.LEFT, fight.outcome.green],
                [PBTypes.TeamVals.RIGHT, fight.outcome.red],
            ] as const) {
                const alive = fight.terminalState.units.filter((unit) => unit.alive && unit.properties.team === team);
                if (
                    alive.length !== outcome.unitsAlive ||
                    alive.reduce((sum, unit) => sum + unit.properties.amount_alive, 0) !== outcome.creaturesAlive ||
                    Math.abs(alive.reduce((sum, unit) => sum + unit.cumulativeHp, 0) - outcome.hpRemaining) > 1e-6
                )
                    throw new Error("Premium terminal units disagree with fight outcome");
            }
        const board = fight.firstDecisionState?.board;
        if (
            board &&
            (board.gridType !== record.map ||
                board.matrix.length !== GRID_SIZE ||
                board.matrix.some((row) => row.length !== GRID_SIZE || row.some((value) => !Number.isFinite(value))))
        )
            throw new Error("Premium effective board does not match the declared grid");
        if (
            fight.committedEventBatches?.some(
                (batch) =>
                    !Number.isSafeInteger(batch.lap) ||
                    batch.lap < 0 ||
                    !Array.isArray(batch.events) ||
                    !batch.events.length,
            )
        )
            throw new Error("Invalid Premium committed event batch");
        if (
            fight.aIsGreen !== (index === 0) ||
            fight.aIsGreen !== record.games[index].aIsGreen ||
            (fight.totalActions > 0 && fight.actions.length === 0)
        ) {
            throw new Error("AI meta evidence has missing actions or incorrect seats");
        }
        for (const [side, army] of [
            ["a", record.armyA],
            ["b", record.armyB],
        ] as const) {
            const formation = fight.formations[side];
            if (
                formation.expandedRoster.length !== formation.unitIdsByStack.length ||
                formation.expandedRoster.length !== formation.draftedCreatureIdsByStack.length ||
                new Set(formation.unitIdsByStack).size !== formation.unitIdsByStack.length
            ) {
                throw new Error("AI meta evidence has inconsistent stack ancestry");
            }
            for (const [rosterIndex, stack] of formation.expandedRoster.entries()) {
                const ancestor = army.creatureIds.indexOf(formation.draftedCreatureIdsByStack[rosterIndex]);
                if (
                    ancestor < 0 ||
                    army.roster[ancestor].creatureName !== stack.creatureName ||
                    !Number.isSafeInteger(stack.amount) ||
                    stack.amount <= 0
                ) {
                    throw new Error("AI meta evidence contains an invalid split ancestor or amount");
                }
            }
            for (const [draftIndex, drafted] of army.roster.entries()) {
                const total = formation.expandedRoster.reduce(
                    (sum, stack, stackIndex) =>
                        sum +
                        (formation.draftedCreatureIdsByStack[stackIndex] === army.creatureIds[draftIndex]
                            ? stack.amount
                            : 0),
                    0,
                );
                if (total !== drafted.amount) throw new Error("AI meta evidence split does not conserve creatures");
            }
            const placed = new Set<string>();
            const occupied = new Set<string>();
            for (const placement of formation.placements) {
                if (!formation.unitIdsByStack.includes(placement.unitId) || placed.has(placement.unitId))
                    throw new Error("AI meta evidence placement has an unknown/duplicate stack");
                placed.add(placement.unitId);
                for (const { x, y } of footprintCellsForRecord(
                    placement.cell,
                    placement.size,
                    placement.footprintWidth,
                    placement.footprintHeight,
                )) {
                    const cell = `${x}:${y}`;
                    if (occupied.has(cell)) throw new Error("AI meta evidence placement overlaps");
                    occupied.add(cell);
                }
            }
        }
    }
}
