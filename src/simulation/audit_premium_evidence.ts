import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../artifacts/artifact_properties";
import { enumerateFullBudgetAugmentPlans, augmentPlanId } from "../ai/setup/setup_ship";
import { enumeratePremiumAugmentPlans, premiumAugmentPlanId } from "../ai/setup/premium_augment_plans";
import { DefaultPlacementLevel1, getPlacementSizes } from "../augments/augment_properties";
import { PlacementPositionType, PlacementType } from "../grid/placement_properties";
import { RectanglePlacement } from "../grid/rectangle_placement";
import { normalizeFootprintSide } from "../grid/grid_math";
import { simulationGridSettings } from "./battle_engine";
import { footprintCellsForRecord } from "./footprint";
import { aiMetaEvidencePartition, type IAiMetaFightEvidence } from "./ai_meta_evidence";
import { isPremiumMetaStudy, PREMIUM_META_FULL_AUGMENTS_STUDY } from "./ai_meta_study";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import { CreatureByLevel } from "../generated/protobuf/v1/creature_gen";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    AI_META_COHORTS,
    AI_META_SYNERGY_DEFINITIONS,
    AI_META_MAPS,
    aiMetaSynergyKey,
    aiMetaSynergyLevel,
    cohortMap,
    type IAiMetaPairRecord,
} from "./ai_meta_cohorts_core";
import { parsePairRecord } from "./reaggregate_ai_meta_summary";
import { PremiumEvidenceSnapshot, type IPremiumEvidenceQuery } from "./premium_evidence_snapshot";
import { summarizePremiumParticipation } from "./ai_meta_participation";
import { summarizePremiumCombatMetrics, PREMIUM_COMBAT_METRICS_SCHEMA } from "./ai_meta_combat_metrics";
import { summarizePremiumHealth } from "./ai_meta_health_ledger";

const increment = (map: Record<string, number>, key: string, amount = 1) => {
    map[key] = (map[key] ?? 0) + amount;
};
const quantile = (values: readonly number[], q: number): number | null =>
    values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)] : null;
const distribution = (values: readonly number[]) => ({
    count: values.length,
    min: quantile(values, 0),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
});
const coverage = (counts: Record<string, number>, catalog: readonly string[] = Object.keys(counts)) => {
    const support = catalog.map((id) => counts[id] ?? 0);
    return {
        ...distribution(support),
        missing: catalog.filter((id) => !counts[id]),
        below10: support.filter((n) => n < 10).length,
        below50: support.filter((n) => n < 50).length,
        support: counts,
    };
};

/** Reuse the live rectangle enumerator, including rectangular footprints and expanded side zones. */
export function auditPremiumFormationGeometry(fight: IAiMetaFightEvidence): string[] {
    const failures: string[] = [];
    const occupied = new Set<string>();
    const settings = simulationGridSettings();
    for (const [side, formation] of Object.entries(fight.formations)) {
        const left = side === "a" ? fight.aIsGreen : !fight.aIsGreen;
        const level = formation.augments.find(({ kind }) => kind === "Placement")?.value ?? 0;
        const size = getPlacementSizes(PlacementType.RECTANGLE, level, DefaultPlacementLevel1.THREE_BY_THREE)[0];
        const zone = new RectanglePlacement(
            settings,
            left ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
            size,
            true,
        );
        for (const placement of formation.placements) {
            const width = normalizeFootprintSide(placement.footprintWidth, placement.size);
            const height = normalizeFootprintSide(placement.footprintHeight, placement.size);
            if (
                !zone
                    .possibleCellPositions(width === 1 && height === 1, width, height)
                    .some(({ x, y }) => x === placement.cell.x && y === placement.cell.y)
            )
                failures.push(`${side}:${placement.unitId}:outside-deployment-zone`);
            for (const { x, y } of footprintCellsForRecord(placement.cell, placement.size, width, height)) {
                if (
                    !Number.isInteger(x) ||
                    !Number.isInteger(y) ||
                    x < 0 ||
                    y < 0 ||
                    x >= settings.getGridSize() ||
                    y >= settings.getGridSize()
                )
                    failures.push(`${side}:${placement.unitId}:outside-board`);
                if (occupied.has(`${x}:${y}`)) failures.push(`${side}:${placement.unitId}:overlap`);
                occupied.add(`${x}:${y}`);
            }
        }
    }
    return failures;
}

export class PremiumEvidenceAudit {
    private readonly seen = new Set<string>();
    private readonly queryCounts: Record<string, number> = {};
    public families = 0;
    public fights = 0;
    public readonly cohorts: Record<string, number> = {};
    public readonly maps: Record<string, number> = {};
    public readonly partitions: Record<string, number> = {};
    public readonly doctrines: Record<string, number> = {};
    public readonly studyProfiles = new Set<string>();
    public readonly budgets: Record<string, number> = {};
    public readonly variants: Record<string, number> = {};
    public readonly units: Record<string, number> = {};
    public readonly allies: Record<string, number> = {};
    public readonly counters: Record<string, number> = {};
    public readonly artifacts: Record<string, number> = {};
    public readonly randomizedArtifacts: Record<string, number> = {};
    public readonly plans: Record<string, number> = {};
    public readonly randomizedPlans: Record<string, number> = {};
    public readonly synergies: Record<string, number> = {};
    public readonly draftOffers: Record<string, number> = {};
    public readonly draftSelections: Record<string, number> = {};
    public readonly decisionKinds: Record<string, number> = {};
    public readonly committedEvents: Record<string, number> = {};
    /** Named mechanics are stratified before counting independent seat-paired families. */
    public readonly namedMechanics: Record<
        string,
        Record<string, Record<string, { occurrences: number; independentFamilies: number }>>
    > = {};
    public readonly events: Record<string, number> = {};
    public readonly actions: Record<string, number> = {};
    public readonly recoveries: Record<string, number> = {};
    public readonly roleCounts: Record<string, number> = {};
    public readonly endReasons: Record<string, number> = {};
    public readonly failures: string[] = [];
    public readonly validationDraftQueries: Parameters<PremiumEvidenceSnapshot["draftSupport"]>[0][] = [];
    public readonly validationQueries: { kind: string; query: IPremiumEvidenceQuery }[] = [];
    public readonly recordBytes: number[] = [];
    public effectiveStarts = 0;
    public effectiveBoards = 0;
    public fightsWithCommittedEvents = 0;
    public fightsWithTerminalState = 0;
    public fightsWithDisplayDamage = 0;
    public fightsWithParticipation = 0;
    public participationStacks = 0;
    public participationUnknownStacks = 0;
    public spellHealingHp = 0;
    public spellResurrectionHp = 0;
    public summonCreatures = 0;
    public healthFights = 0;
    public readonly healthTotals = summarizePremiumHealth([]);
    public readonly combatMetrics = {
        schema: PREMIUM_COMBAT_METRICS_SCHEMA,
        fights: 0,
        stacks: 0,
        unknownStacks: 0,
        activations: 0,
        effectSkips: 0,
        explicitMoves: 0,
        reportedDamageReceivedHp: 0,
        attributedDamageDealtHp: 0,
        damageWithoutSourceHp: 0,
        devourHealingHp: 0,
        waterShieldAbsorbedHp: 0,
        fleshShieldRedirectedHp: 0,
        poisonHp: 0,
        fireWallHp: 0,
        attackEvents: 0,
        attacksWithoutDetailedHp: 0,
        attacksWithUnassignedHp: 0,
    };
    public artifactBarrels = 0;
    public placementGeometryFailures = 0;
    public effectiveAmountIncreases = 0;
    public effectiveAmountDecreases = 0;
    public tracedFights = 0;
    public draftDecisions = 0;
    public collisions = 0;
    public unplacedStacks = 0;
    public placedStacks = 0;
    public splitStacks = 0;
    public rejectedActions = 0;
    public armyTurns = 0;
    public add(record: IAiMetaPairRecord, bytes = 0): void {
        const evidence = record.evidence;
        if (!evidence?.fights) throw new Error("Audit requires complete Premium evidence");
        if (this.seen.has(evidence.scenarioId)) throw new Error(`Duplicate family: ${evidence.scenarioId}`);
        this.seen.add(evidence.scenarioId);
        this.families++;
        this.fights += record.games.length;
        const mechanicScope = `${record.cohort}/${evidence.partition}`;
        const mechanicFamilies = new Set<string>();
        const mechanics = (kind: string, counts: Record<string, number>) => {
            const scope = (this.namedMechanics[mechanicScope] ??= {});
            const entries = (scope[kind] ??= {});
            for (const [name, occurrences] of Object.entries(counts)) {
                if (!occurrences) continue;
                const row = (entries[name] ??= { occurrences: 0, independentFamilies: 0 });
                row.occurrences += occurrences;
                const key = JSON.stringify([kind, name]);
                if (!mechanicFamilies.has(key)) {
                    mechanicFamilies.add(key);
                    row.independentFamilies++;
                }
            }
        };
        increment(this.cohorts, record.cohort);
        increment(this.maps, `${record.cohort}:${record.map}`);
        this.studyProfiles.add(evidence.studyProfile ?? "legacy-oracle");
        increment(this.partitions, `${record.cohort}:${evidence.partition}`);
        increment(
            this.variants,
            ["Life", "Chaos", "Might", "Nature"]
                .map(
                    (faction) =>
                        `${faction}=${evidence.synergyVariants[faction as keyof typeof evidence.synergyVariants]}`,
                )
                .join("/"),
        );
        if (record.map !== cohortMap(record.cohort, record.pair))
            this.failures.push(`${evidence.scenarioId}: map is outside the declared cycle`);
        this.recordBytes.push(bytes);
        const once = new Map<Record<string, number>, Set<string>>();
        const add = (table: Record<string, number>, key: string) => {
            if (!once.has(table)) once.set(table, new Set());
            once.get(table)!.add(key);
        };
        for (const [army, opponent] of [
            [record.armyA, record.armyB],
            [record.armyB, record.armyA],
        ]) {
            increment(this.doctrines, `${record.cohort}:${army.doctrine}`);
            const budget = getUpgradePoints(army.doctrine);
            increment(this.budgets, String(budget));
            add(this.plans, army.augment.planId);
            if (army.augment.mode === "explore") add(this.randomizedPlans, army.augment.planId);
            for (const [tier, artifact] of [
                [1, army.artifactT1],
                [2, army.artifactT2],
            ] as const) {
                add(this.artifacts, `${tier}:${artifact.id}`);
                if (artifact.mode === "explore") add(this.randomizedArtifacts, `${tier}:${artifact.id}`);
            }
            for (const choice of army.synergies)
                add(
                    this.synergies,
                    aiMetaSynergyKey(
                        choice.faction,
                        choice.synergy,
                        aiMetaSynergyLevel(army.creatureIds, choice.faction) as 1 | 2 | 3,
                    ),
                );
            for (const [index, id] of army.creatureIds.entries()) {
                add(this.units, String(id));
                for (const other of army.creatureIds.slice(index + 1))
                    add(this.allies, [id, other].sort((a, b) => a - b).join(":"));
                for (const other of opponent.creatureIds) add(this.counters, `${id}:${other}`);
            }
            if (evidence.partition === "validation" && (this.queryCounts[record.cohort] ?? 0) < 396) {
                const base: IPremiumEvidenceQuery = { cohort: record.cohort, partition: "train" };
                const own = army.creatureIds[0];
                const variantFilters = [
                    { faction: PBTypes.FactionVals.LIFE, synergy: evidence.synergyVariants.Life },
                    { faction: PBTypes.FactionVals.CHAOS, synergy: evidence.synergyVariants.Chaos },
                    { faction: PBTypes.FactionVals.MIGHT, synergy: evidence.synergyVariants.Might },
                    { faction: PBTypes.FactionVals.NATURE, synergy: evidence.synergyVariants.Nature },
                ];
                for (const [kind, query] of [
                    ["unit", { ...base, ownUnits: [own] }],
                    ["ally-pair", { ...base, ownUnits: army.creatureIds.slice(0, 2) }],
                    ["counter-pair", { ...base, ownUnits: [own], opponentUnits: opponent.creatureIds.slice(0, 1) }],
                    ["unit-artifact", { ...base, ownUnits: [own], artifactT1: army.artifactT1.id }],
                    ["unit-variants", { ...base, ownUnits: [own], variants: variantFilters }],
                    [
                        "setup-context",
                        {
                            ...base,
                            ownUnits: army.creatureIds,
                            artifactT1: army.artifactT1.id,
                            artifactT2: army.artifactT2.id,
                            doctrine: army.doctrine,
                            map: record.map,
                            variants: variantFilters,
                        },
                    ],
                ] as const)
                    this.validationQueries.push({ kind, query });
                increment(this.queryCounts, record.cohort, 6);
            }
        }
        for (const decision of evidence.rankedDraft?.decisions ?? []) {
            this.draftDecisions++;
            this.collisions += Number(decision.status === "collision");
            increment(this.decisionKinds, decision.action.type);
            const decisionKey = (key: string) =>
                decision.action.type === "select_bundle"
                    ? `select_bundle:${decision.observation.bundles[Number(key)].join(":")}`
                    : `${decision.action.type}:${decision.observation.phaseSequence}:${key}`;
            for (const candidate of decision.choice?.candidates ?? [])
                add(this.draftOffers, decisionKey(candidate.key));
            const action = decision.action;
            const selected =
                action.type === "select_bundle"
                    ? action.bundleIndex
                    : action.type === "select_doctrine"
                      ? action.doctrine
                      : action.type === "select_tier2"
                        ? action.artifactId
                        : action.creatureId;
            if (decision.status === "accepted") {
                add(this.draftSelections, decisionKey(String(selected)));
                if (evidence.partition === "validation" && this.validationDraftQueries.length < 600) {
                    const observation = decision.observation;
                    const draftQuery: Parameters<PremiumEvidenceSnapshot["draftSupport"]>[0] = {
                        kind: action.type,
                        phase: observation.phaseSequence,
                        ...(action.type === "select_bundle"
                            ? { bundle: observation.bundles[action.bundleIndex] }
                            : { actionKey: selected }),
                        ownUnits: observation.creaturesPicked,
                        knownOpponentUnits: observation.knownOpponentCreatures,
                        ...(observation.revealedMap === null ? {} : { map: observation.revealedMap }),
                        ...(observation.doctrine ? { doctrine: observation.doctrine } : {}),
                        partition: "train",
                    };
                    this.validationDraftQueries.push(draftQuery);
                }
            }
        }
        for (const [table, keys] of once) for (const key of keys) increment(table, key);
        for (const game of record.games) {
            increment(this.endReasons, game.endReason);
            this.rejectedActions += game.rejectedA + game.rejectedB;
        }
        for (const fight of evidence.fights!) {
            if (fight.healthLedger) {
                this.healthFights++;
                const totals = summarizePremiumHealth(fight.healthLedger);
                for (const key of Object.keys(totals) as (keyof typeof totals)[]) this.healthTotals[key] += totals[key];
            }
            if (fight.committedEventBatches) {
                const metrics = fight.combatMetrics ?? summarizePremiumCombatMetrics(fight);
                const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
                this.combatMetrics.fights++;
                this.combatMetrics.stacks += metrics.stacks.length;
                this.combatMetrics.unknownStacks += metrics.coverage.unknownStackIds.length;
                this.combatMetrics.attackEvents += metrics.coverage.attackEvents;
                this.combatMetrics.attacksWithoutDetailedHp += metrics.coverage.attacksWithoutDetailedHp;
                this.combatMetrics.attacksWithUnassignedHp += metrics.coverage.attacksWithUnassignedHp;
                this.combatMetrics.damageWithoutSourceHp += sum(metrics.damageWithoutSourceHp);
                for (const row of metrics.stacks) {
                    mechanics("spell-target-outcomes", row.spellOutcomes);
                    mechanics("ability-transfers", row.abilityTransfersGiven);
                    this.combatMetrics.activations += row.activations;
                    this.combatMetrics.effectSkips += row.skips.effect ?? 0;
                    this.combatMetrics.explicitMoves += row.explicitMoves;
                    this.combatMetrics.reportedDamageReceivedHp += sum(row.damageReceivedHp);
                    this.combatMetrics.attributedDamageDealtHp += sum(row.attributedDamageDealtHp);
                    this.combatMetrics.devourHealingHp += row.devourHealingHp;
                    this.combatMetrics.waterShieldAbsorbedHp += row.waterShieldAbsorbedHp;
                    this.combatMetrics.fleshShieldRedirectedHp += row.fleshShieldRedirectedHp;
                    this.combatMetrics.poisonHp += row.damageReceivedHp["environment:poison"] ?? 0;
                    this.combatMetrics.fireWallHp += row.damageReceivedHp["environment:fire_wall"] ?? 0;
                }
                const participation = fight.participation ?? summarizePremiumParticipation(fight);
                this.fightsWithParticipation++;
                this.participationStacks += participation.stacks.length;
                this.participationUnknownStacks += participation.unknownStackIds.length;
                for (const stack of participation.stacks) {
                    mechanics("spell-casts", stack.spells);
                    mechanics("applied-effects", stack.receivedEffects);
                    mechanics("resisted-effects", stack.resistedEffects);
                    this.spellHealingHp += stack.spellHealingGiven;
                    this.spellResurrectionHp += stack.spellResurrectionHpGiven;
                    this.summonCreatures += stack.summonedAmount;
                }
            }
            this.fightsWithTerminalState += Number(Boolean(fight.terminalState));
            this.fightsWithDisplayDamage += Number(Array.isArray(fight.terminalState?.damageStatistics));
            this.fightsWithCommittedEvents += Number(Boolean(fight.committedEventBatches?.length));
            for (const batch of fight.committedEventBatches ?? [])
                for (const event of batch.events) increment(this.committedEvents, event.type);
            const geometryFailures = auditPremiumFormationGeometry(fight);
            this.placementGeometryFailures += geometryFailures.length;
            if (this.failures.length < 100)
                this.failures.push(
                    ...geometryFailures
                        .map((failure) => `${evidence.scenarioId}:${failure}`)
                        .slice(0, 100 - this.failures.length),
                );
            this.effectiveBoards += Number(Boolean(fight.firstDecisionState?.board));
            this.artifactBarrels += fight.firstDecisionState?.board?.artifactBarrels.length ?? 0;
            const initialAmounts = new Map(
                [...Object.values(fight.formations)].flatMap((formation) =>
                    formation.unitIdsByStack.map((id, index) => [id, formation.expandedRoster[index].amount] as const),
                ),
            );
            for (const { properties } of fight.firstDecisionState?.units ?? []) {
                const spells: Record<string, number> = {};
                for (const entry of properties.spells ?? [])
                    increment(spells, entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : entry);
                mechanics("opening-spell-entries", spells);
                mechanics("opening-spell-stacks", Object.fromEntries(Object.keys(spells).map((name) => [name, 1])));
                mechanics(
                    "opening-ability-stacks",
                    Object.fromEntries([...new Set(properties.abilities ?? [])].map((name) => [name, 1])),
                );
                const original = initialAmounts.get(properties.id);
                if (original !== undefined) {
                    this.effectiveAmountIncreases += Number(properties.amount_alive > original);
                    this.effectiveAmountDecreases += Number(properties.amount_alive < original);
                }
            }
            this.effectiveStarts += Number(Boolean(fight.firstDecisionState?.units.length));
            this.tracedFights += Number(Boolean(fight.executionTrace?.length));
            for (const formation of [fight.formations.a, fight.formations.b]) {
                this.placedStacks += formation.placements.length;
                this.unplacedStacks += formation.expandedRoster.length - formation.placements.length;
                this.splitStacks += formation.splitRoles.length;
                for (const role of formation.splitRoles) increment(this.roleCounts, role.role);
            }
            for (const action of fight.actions) increment(this.actions, action.actionType);
            for (const turn of fight.executionTrace ?? []) {
                this.armyTurns++;
                increment(this.recoveries, turn.recovery.source);
                for (const event of turn.events) increment(this.events, event.type);
            }
        }
    }
    public result() {
        const creatures = CreatureByLevel.slice(1, 5).flat().map(String);
        const artifacts = [
            ...TIER1_ARTIFACT_LIST.map(({ id }) => `1:${id}`),
            ...TIER2_ARTIFACT_LIST.map(({ id }) => `2:${id}`),
        ];
        const livePlans = [5, 6, 7].flatMap((budget) => enumeratePremiumAugmentPlans(budget).map(premiumAugmentPlanId));
        const fullDomain = this.studyProfiles.size === 1 && this.studyProfiles.has(PREMIUM_META_FULL_AUGMENTS_STUDY);
        const plans = fullDomain
            ? livePlans
            : [5, 6, 7].flatMap((budget) => enumerateFullBudgetAugmentPlans(budget).map(augmentPlanId));
        return {
            families: this.families,
            fights: this.fights,
            cohorts: this.cohorts,
            mapPairs: this.maps,
            partitions: this.partitions,
            doctrineAssignments: this.doctrines,
            augmentBudgets: this.budgets,
            variantCombinations: this.variants,
            units: coverage(this.units, creatures),
            // Observed universe only: legal archetype/cohort constraints differ, so do not imply all pairs were eligible.
            allyPairs: { universe: "observed-pairs-only", ...coverage(this.allies) },
            directionalCounters: { universe: "observed-pairs-only", ...coverage(this.counters) },
            artifacts: coverage(this.artifacts, artifacts),
            randomizedArtifacts: coverage(this.randomizedArtifacts, artifacts),
            augmentDomain: fullDomain ? "six-axis-empower-v1" : "historical-five-axis",
            liveAugmentPlans: coverage(this.plans, livePlans),
            structuralMissingAugmentPlans: livePlans.filter((id) => !plans.includes(id)),
            augmentPlans: coverage(this.plans, plans),
            randomizedAugmentPlans: coverage(this.randomizedPlans, plans),
            activeSynergies: coverage(
                this.synergies,
                AI_META_SYNERGY_DEFINITIONS.flatMap(({ faction, synergy }) =>
                    ([1, 2, 3] as const).map((level) => aiMetaSynergyKey(faction, synergy, level)),
                ),
            ),
            draft: {
                decisions: this.draftDecisions,
                collisions: this.collisions,
                kinds: this.decisionKinds,
                offers: this.draftOffers,
                selections: this.draftSelections,
                offeredNeverSelected: Object.keys(this.draftOffers).filter((key) => !this.draftSelections[key]),
            },
            telemetry: {
                effectiveStarts: this.effectiveStarts,
                effectiveBoards: this.effectiveBoards,
                recordedArtifactBarrels: this.artifactBarrels,
                placementGeometryFailures: this.placementGeometryFailures,
                stacksWithOpeningAmountIncrease: this.effectiveAmountIncreases,
                stacksWithOpeningAmountDecrease: this.effectiveAmountDecreases,
                tracedFights: this.tracedFights,
                placedStacks: this.placedStacks,
                unplacedStacks: this.unplacedStacks,
                splitRoleStacks: this.splitStacks,
                roles: this.roleCounts,
                actions: this.actions,
                eventTypes: this.events,
                fightsWithCommittedEvents: this.fightsWithCommittedEvents,
                fightsWithTerminalState: this.fightsWithTerminalState,
                fightsWithDisplayDamage: this.fightsWithDisplayDamage,
                participation: {
                    fights: this.fightsWithParticipation,
                    stacks: this.participationStacks,
                    unknownStacks: this.participationUnknownStacks,
                    spellHealingHp: this.spellHealingHp,
                    spellResurrectionHp: this.spellResurrectionHp,
                    summonedCreatures: this.summonCreatures,
                    scope: "committed-event-participation-and-spell-support-only",
                },
                combatMetrics: this.combatMetrics,
                committedHealth: { fights: this.healthFights, ...this.healthTotals },
                committedEventTypes: this.committedEvents,
                namedMechanics: {
                    scopes: this.namedMechanics,
                    counting:
                        "Occurrences include both seats and all physical stacks; each family counts once per named mechanic within its cohort and partition.",
                    limitations: [
                        "Observed labels are not a complete mechanics catalog; an absent label means unobserved, not impossible or ineffective.",
                        "Applications are not effect duration, aura uptime, caster credit or causal benefit. Engine bookkeeping effects are excluded by the collector.",
                        "Cast counts and target outcomes have different denominators. Do not pool train, validation, test or different cohorts for serving claims.",
                        "Opening spell/ability entries show starting kit exposure, not legal casting opportunities, uses, triggers or permanent ownership. Later grants and summons are not starting exposure.",
                    ],
                },
                decidedTurns: this.armyTurns,
                recoverySources: this.recoveries,
                endReasons: this.endReasons,
            },
            recordBytes: distribution(this.recordBytes),
            failures: this.failures,
            rejectedActions: this.rejectedActions,
            limitations: [
                "Coverage pilot only; no causal alternative-arm comparisons or fitted advisor model.",
                "Unit, pair and artifact counts are observational, conditional on this policy mixture.",
                "Optional bans and alternate placement/split policies were not sampled.",
                "Event payloads are not a complete attributed damage/healing/mitigation ledger; V3 also lacks environmental/activation events outside decided turns.",
                "Placement proposals need runtime legality validation and controlled evaluation before automatic application.",
            ],
        };
    }
}

export async function auditPremiumEvidence(summaryPath: string, snapshotPath?: string) {
    const summaryText = readFileSync(summaryPath, "utf8");
    const summary = JSON.parse(summaryText);
    if (
        summary.complete !== true ||
        !isPremiumMetaStudy(summary.provenance?.fightProfile?.studyProfile) ||
        !Array.isArray(summary.cohorts) ||
        !summary.cohorts.length
    )
        throw new Error("Audit requires a complete Premium summary");
    if (new Set(summary.cohorts.map((cohort: { cohort: string }) => cohort.cohort)).size !== summary.cohorts.length)
        throw new Error("Duplicate audit cohort");
    const sourceHashes = new Map<string, string>();
    const audit = new PremiumEvidenceAudit();
    let archiveBytes = 0;
    for (const cohort of summary.cohorts) {
        if (!AI_META_COHORTS.includes(cohort.cohort) || basename(cohort.rawPath) !== cohort.rawPath)
            throw new Error("Invalid audit source");
        const path = resolve(dirname(summaryPath), cohort.rawPath);
        archiveBytes += statSync(path).size;
        const input = createReadStream(path);
        const gzip = createGunzip();
        const hash = createHash("sha256");
        input.on("data", (chunk) => hash.update(chunk));
        input.on("error", (error) => gzip.destroy(error));
        const lines = createInterface({ input: input.pipe(gzip), crlfDelay: Infinity });
        let pairs = 0;
        const pairIndices = new Set<number>();
        const mapGames: Record<string, number> = {};
        try {
            for await (const line of lines) {
                const record = parsePairRecord(JSON.parse(line), cohort.cohort, [...AI_META_MAPS], cohort.rawPath);
                if (
                    record.evidence?.scenarioId !==
                        `ai-meta:${summary.provenance.baseSeed}:${record.cohort}:${record.pair}` ||
                    record.evidence.partition !==
                        aiMetaEvidencePartition(summary.provenance.baseSeed, record.cohort, record.pair)
                )
                    throw new Error("Audit scenario identity or partition mismatch");
                pairIndices.add(record.pair);
                increment(mapGames, String(record.map), record.games.length);
                audit.add(record, Buffer.byteLength(line));
                pairs++;
            }
            const start = summary.provenance.pairWindow?.start ?? 0;
            if (
                pairs !== cohort.pairs ||
                pairs * 2 !== cohort.games ||
                pairIndices.size !== pairs ||
                [...pairIndices].some((pair) => pair < start || pair >= start + pairs) ||
                AI_META_MAPS.some((map) => (mapGames[map] ?? 0) !== (cohort.mapGames[map] ?? 0))
            )
                throw new Error("Audit cohort/map counts or pair window mismatch");
            sourceHashes.set(cohort.rawPath, hash.digest("hex"));
        } finally {
            lines.close();
            input.destroy();
            gzip.destroy();
        }
    }
    if (audit.families !== summary.provenance.totalPairs || audit.fights !== summary.provenance.totalGames)
        throw new Error("Audit counts disagree with summary");
    const retrieval: Record<
        string,
        { supports: number[]; milliseconds: number[]; zero: number; limited: number; supported: number }
    > = {};
    if (snapshotPath) {
        const snapshot = new PremiumEvidenceSnapshot(snapshotPath, summary.provenance.sourceSha256, {
            allowDevelopment: true,
        });
        try {
            if (
                snapshot.manifest.families !== audit.families ||
                snapshot.manifest.fights !== audit.fights ||
                snapshot.manifest.sources.length !== sourceHashes.size ||
                snapshot.manifest.sources.some((source) => source.sha256 !== sourceHashes.get(source.name))
            )
                throw new Error("Audit snapshot does not match these raw archives");
            for (const { kind, query } of audit.validationQueries) {
                const bucket = (retrieval[kind] ??= {
                    supports: [],
                    milliseconds: [],
                    zero: 0,
                    limited: 0,
                    supported: 0,
                });
                const start = performance.now();
                const packet = snapshot.query(query);
                bucket.milliseconds.push(performance.now() - start);
                bucket.supports.push(packet.independentFamilies);
                if (packet.status === "no_evidence") bucket.zero++;
                else if (packet.status === "limited_evidence") bucket.limited++;
                else bucket.supported++;
            }
            if (snapshot.manifest.capabilities?.includes("draft-observations"))
                for (const query of audit.validationDraftQueries) {
                    const kind = `draft:${query.kind}`;
                    const bucket = (retrieval[kind] ??= {
                        supports: [],
                        milliseconds: [],
                        zero: 0,
                        limited: 0,
                        supported: 0,
                    });
                    const start = performance.now();
                    const packet = snapshot.draftSupport(query);
                    bucket.milliseconds.push(performance.now() - start);
                    bucket.supports.push(packet.independentFamilies);
                    if (packet.status === "no_evidence") bucket.zero++;
                    else if (packet.status === "limited_evidence") bucket.limited++;
                    else bucket.supported++;
                }
        } finally {
            snapshot.close();
        }
    }
    return {
        schema: "hoc-premium-readiness-audit-v1",
        sourceSha256: summary.provenance.sourceSha256,
        summarySha256: createHash("sha256").update(summaryText).digest("hex"),
        generatedAt: new Date().toISOString(),
        sources: Object.fromEntries(sourceHashes),
        ...audit.result(),
        archiveBytes,
        snapshotBytes: snapshotPath ? statSync(snapshotPath).size : null,
        retrieval: Object.fromEntries(
            Object.entries(retrieval).map(([kind, bucket]) => [
                kind,
                {
                    independentSupport: distribution(bucket.supports),
                    milliseconds: distribution(bucket.milliseconds),
                    noEvidence: bucket.zero,
                    limitedEvidence: bucket.limited,
                    supported: bucket.supported,
                },
            ]),
        ),
    };
}

if (import.meta.main) {
    const [summary, output, snapshot] = process.argv.slice(2);
    if (!summary || !output)
        throw new Error(
            "Usage: bun src/simulation/audit_premium_evidence.ts <summary.json> <fresh-audit.json> [snapshot.sqlite]",
        );
    const audit = await auditPremiumEvidence(resolve(summary), snapshot ? resolve(snapshot) : undefined);
    writeFileSync(resolve(output), `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx" });
    console.log(
        JSON.stringify(
            {
                families: audit.families,
                fights: audit.fights,
                failures: audit.failures,
                rejectedActions: audit.rejectedActions,
                retrieval: audit.retrieval,
                output,
            },
            null,
            2,
        ),
    );
}
