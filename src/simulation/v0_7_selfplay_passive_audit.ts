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

import { enumerateCandidates, type ICandidateSet, type IDecisionContext, type IEnumerateOptions } from "../ai";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import {
    GREEN_TEAM,
    runMatch,
    type IDecisionObservation,
    type IMatchConfig,
    type IMatchResult,
    type ITurnExecutionObservation,
    type Side,
} from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import {
    V07_ARCHETYPE_TEMPLATES,
    rosterSignature,
    v07ArchetypeTemplate,
    type V07Archetype,
    type V07ArchetypeTemplateName,
} from "./v0_7_archetype_battery";

export const V07_SELFPLAY_PASSIVE_AUDIT_VERSION = "v0.7";
export const V07_SELFPLAY_PASSIVE_AUDIT_GAMES_PER_TEMPLATE = 12_500;
export const V07_SELFPLAY_PASSIVE_AUDIT_TOTAL_GAMES =
    V07_ARCHETYPE_TEMPLATES.length * V07_SELFPLAY_PASSIVE_AUDIT_GAMES_PER_TEMPLATE;
export const V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN = "hoc:v0.7-selfplay-passive-audit:2026-07-16:v1";

export const V07_PASSIVE_DECISION_INTENTS = ["skip", "shield", "wait", "attack", "move", "spell", "other"] as const;
export type V07PassiveDecisionIntent = (typeof V07_PASSIVE_DECISION_INTENTS)[number];

export const V07_PASSIVE_LAP_BANDS = ["lap_1", "laps_2_3", "laps_4_6", "laps_7_10", "laps_11_plus", "unknown"] as const;
export type V07PassiveLapBand = (typeof V07_PASSIVE_LAP_BANDS)[number];

export type V07PassiveAttackKind = "melee" | "shot" | "area_throw";
export type V07PassiveMeleeRoute = "direct" | "move_assisted";

export type V07PassiveCandidateEnumerator = (
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    options?: IEnumerateOptions,
) => ICandidateSet;

export interface IV07PassiveAttackCounter {
    turnsWithCandidate: number;
    candidates: number;
    turnsWithPositiveExpectedDamage: number;
    positiveExpectedDamageCandidates: number;
    turnsWithExpectedKill: number;
    expectedKillCandidates: number;
    expectedDamageSum: number;
    bestExpectedDamageSum: number;
    maxExpectedDamage: number;
}

export interface IV07PassiveAlternativeCounter extends IV07PassiveAttackCounter {
    passiveTurns: number;
    alternativeCandidates: number;
    truncatedTurns: number;
    truncatedClasses: Record<string, number>;
    byAttackKind: Record<V07PassiveAttackKind, IV07PassiveAttackCounter>;
    byMeleeRoute: Record<V07PassiveMeleeRoute, IV07PassiveAttackCounter>;
}

export interface IV07PassiveExecutionCounter {
    observedTurns: number;
    actualUnitSkippedTurns: number;
    unitSkipReasons: Record<string, number>;
    explicitUnitDefendedTurns: number;
    recoveryDefendTurns: number;
    recoveryAdvanceTurns: number;
    recoveryFailedTurns: number;
    strategyNoOpTurns: number;
    rejectedTurns: number;
    rejectedActions: number;
    rejectionReasons: Record<string, number>;
}

export interface IV07PassiveDimensionTally {
    decisions: number;
    intents: Record<V07PassiveDecisionIntent, number>;
    skip: IV07PassiveAlternativeCounter;
    shield: IV07PassiveAlternativeCounter;
    execution: IV07PassiveExecutionCounter;
}

export interface IV07SelfplayPassiveAuditTally {
    games: number;
    ignoredStrategyTurns: number;
    global: IV07PassiveDimensionTally;
    byTemplate: Partial<Record<V07ArchetypeTemplateName, IV07PassiveDimensionTally>>;
    byArchetype: Partial<Record<V07Archetype, IV07PassiveDimensionTally>>;
    bySide: Partial<Record<Side, IV07PassiveDimensionTally>>;
    byLapBand: Partial<Record<V07PassiveLapBand, IV07PassiveDimensionTally>>;
    byCreature: Record<string, IV07PassiveDimensionTally>;
    outcomes: {
        greenWins: number;
        redWins: number;
        draws: number;
        totalLaps: number;
        endReasons: Record<string, number>;
        rejectedGreen: number;
        rejectedRed: number;
    };
    integrity: IV07SelfplayPassiveAuditIntegrity;
}

export interface IV07PassiveDecisionScope {
    template: V07ArchetypeTemplateName;
    archetype: V07Archetype;
    side: Side;
    lapBand: V07PassiveLapBand;
    creature: string;
    intent: V07PassiveDecisionIntent;
    unitId: string;
    lap: number;
    game: number;
    seed: number;
}

export interface IV07PassiveDecisionProvenance {
    game: number;
    seed: number;
}

export interface IV07SelfplayPassiveAuditIntegrityRepro {
    kind: "rejected_action" | "recovery";
    template: V07ArchetypeTemplateName;
    archetype: V07Archetype;
    game: number;
    seed: number;
    side: Side;
    lap: number;
    unitId: string;
    creature: string;
    intent: V07PassiveDecisionIntent;
    proposedActions: ReadonlyArray<Readonly<GameAction>>;
    rejectedAction?: Readonly<GameAction>;
    rejectionReason?: string;
    recoverySource?: "advance" | "defend";
    recoveryAttempts?: ReadonlyArray<{
        source: "advance" | "defend";
        completed: boolean;
        action?: Readonly<GameAction>;
        rejectionReason?: string;
    }>;
}

export interface IV07SelfplayPassiveAuditIntegrity {
    rejectedActions: number;
    recoveryTurns: number;
    reproSamples: IV07SelfplayPassiveAuditIntegrityRepro[];
}

export interface IV07SelfplayPassiveAuditOptions {
    gamesPerTemplate?: number;
    seedDomain?: string;
    maxLaps?: number;
    deniedSeeds?: ReadonlySet<number> | readonly number[];
}

export interface IV07SelfplayPassiveAuditNormalizedOptions {
    gamesPerTemplate: number;
    seedDomain: string;
    maxLaps?: number;
    deniedSeeds: ReadonlySet<number>;
}

export interface IV07SelfplayPassiveAuditGameSpec {
    template: V07ArchetypeTemplateName;
    game: number;
    seed: number;
    maxLaps?: number;
}

export interface IV07SelfplayPassiveAuditSeedSchedule {
    schemaVersion: 1;
    algorithm: string;
    domain: string;
    gamesPerTemplate: number;
    totalGames: number;
    collisionRejections: number;
    deniedSeedCount: number;
    freshnessClaim: "unique_within_run_only" | "unique_within_run_and_excludes_supplied_denyset";
    corpusLabel: string;
    specs: IV07SelfplayPassiveAuditGameSpec[];
}

export type V07SelfplayPassiveAuditSeedProtocol = Omit<IV07SelfplayPassiveAuditSeedSchedule, "specs">;

export interface IV07SelfplayPassiveAuditCluster {
    template: V07ArchetypeTemplateName;
    archetype: V07Archetype;
    game: number;
    seed: number;
    winner: IMatchResult["winner"];
    laps: number;
    endReason: IMatchResult["endReason"];
    decisions: number;
    skipIntents: number;
    shieldIntents: number;
    passiveTurnsWithAttackCandidate: number;
    passiveTurnsWithPositiveExpectedDamage: number;
    actualUnitSkippedTurns: number;
    explicitUnitDefendedTurns: number;
    recoveryTurns: number;
    recoveryDefendTurns: number;
    recoveryAdvanceTurns: number;
    recoveryFailedTurns: number;
    rejectedTurns: number;
    rejectedActions: number;
}

export interface IV07SelfplayPassiveAuditGameResult {
    tally: IV07SelfplayPassiveAuditTally;
    cluster: IV07SelfplayPassiveAuditCluster;
}

export interface IV07SelfplayPassiveAuditGameDependencies {
    enumerate?: V07PassiveCandidateEnumerator;
    matchRunner?: (config: IMatchConfig) => IMatchResult;
}

export interface IV07PassiveAttackSummary extends IV07PassiveAttackCounter {
    shareOfPassiveTurns: number;
    positiveDamageShareOfPassiveTurns: number;
    expectedKillShareOfPassiveTurns: number;
    avgCandidatesPerPassiveTurn: number;
    avgBestExpectedDamage: number;
}

export interface IV07PassiveAlternativeSummary extends Omit<
    IV07PassiveAlternativeCounter,
    "byAttackKind" | "byMeleeRoute"
> {
    shareOfAllDecisions: number;
    attack: IV07PassiveAttackSummary;
    byAttackKind: Record<V07PassiveAttackKind, IV07PassiveAttackSummary>;
    byMeleeRoute: Record<V07PassiveMeleeRoute, IV07PassiveAttackSummary>;
}

export interface IV07PassiveDimensionSummary {
    key: string;
    decisions: number;
    intents: Record<V07PassiveDecisionIntent, number>;
    skipShare: number;
    shieldShare: number;
    skipToShieldRatio: number | null;
    passiveShare: number;
    skip: IV07PassiveAlternativeSummary;
    shield: IV07PassiveAlternativeSummary;
    execution: IV07PassiveExecutionCounter & {
        actualSkipShare: number;
        explicitDefendShare: number;
        recoveryDefendShare: number;
        rejectedTurnShare: number;
    };
}

export interface IV07SelfplayPassiveAuditReport {
    schemaVersion: 1;
    status: "v0.7_selfplay_passive_turn_diagnostic";
    auditedVersion: typeof V07_SELFPLAY_PASSIVE_AUDIT_VERSION;
    games: number;
    effectiveConfig: {
        templates: typeof V07_ARCHETYPE_TEMPLATES;
        gamesPerTemplate: number;
        plannedTotalGames: number;
        rosters: "same fixed template roster in both seats";
        setup: ReturnType<typeof liveTwinSetup> & { noVision: true };
        map: "NORMAL";
        candidateEnumeration: "F4 complete and uncapped, only on skip/shield intents";
        decisionObservation: "after decideTurn, before search/apply/recovery";
        executionObservation: "after strategy apply, recovery, and final end-turn close";
    };
    seedProtocol: Omit<IV07SelfplayPassiveAuditSeedSchedule, "specs">;
    outcomes: {
        greenWins: number;
        redWins: number;
        draws: number;
        avgLaps: number;
        endReasons: Record<string, number>;
        rejectedGreen: number;
        rejectedRed: number;
    };
    aggregate: IV07PassiveDimensionSummary;
    byTemplate: IV07PassiveDimensionSummary[];
    byArchetypeCohort: IV07PassiveDimensionSummary[];
    bySide: IV07PassiveDimensionSummary[];
    byLapBand: IV07PassiveDimensionSummary[];
    byCreature: IV07PassiveDimensionSummary[];
    ignoredStrategyTurns: number;
    integrity: IV07SelfplayPassiveAuditIntegrity & { smoothExecutionPass: boolean };
    limitations: string[];
}

const INTEGRITY_REPRO_SAMPLE_LIMIT = 64;

const emptyAttackCounter = (): IV07PassiveAttackCounter => ({
    turnsWithCandidate: 0,
    candidates: 0,
    turnsWithPositiveExpectedDamage: 0,
    positiveExpectedDamageCandidates: 0,
    turnsWithExpectedKill: 0,
    expectedKillCandidates: 0,
    expectedDamageSum: 0,
    bestExpectedDamageSum: 0,
    maxExpectedDamage: 0,
});

const emptyAlternativeCounter = (): IV07PassiveAlternativeCounter => ({
    ...emptyAttackCounter(),
    passiveTurns: 0,
    alternativeCandidates: 0,
    truncatedTurns: 0,
    truncatedClasses: {},
    byAttackKind: { melee: emptyAttackCounter(), shot: emptyAttackCounter(), area_throw: emptyAttackCounter() },
    byMeleeRoute: { direct: emptyAttackCounter(), move_assisted: emptyAttackCounter() },
});

const emptyExecutionCounter = (): IV07PassiveExecutionCounter => ({
    observedTurns: 0,
    actualUnitSkippedTurns: 0,
    unitSkipReasons: {},
    explicitUnitDefendedTurns: 0,
    recoveryDefendTurns: 0,
    recoveryAdvanceTurns: 0,
    recoveryFailedTurns: 0,
    strategyNoOpTurns: 0,
    rejectedTurns: 0,
    rejectedActions: 0,
    rejectionReasons: {},
});

const emptyIntents = (): Record<V07PassiveDecisionIntent, number> => ({
    skip: 0,
    shield: 0,
    wait: 0,
    attack: 0,
    move: 0,
    spell: 0,
    other: 0,
});

const emptyDimension = (): IV07PassiveDimensionTally => ({
    decisions: 0,
    intents: emptyIntents(),
    skip: emptyAlternativeCounter(),
    shield: emptyAlternativeCounter(),
    execution: emptyExecutionCounter(),
});

export function createV07SelfplayPassiveAuditTally(): IV07SelfplayPassiveAuditTally {
    return {
        games: 0,
        ignoredStrategyTurns: 0,
        global: emptyDimension(),
        byTemplate: {},
        byArchetype: {},
        bySide: {},
        byLapBand: {},
        byCreature: {},
        outcomes: {
            greenWins: 0,
            redWins: 0,
            draws: 0,
            totalLaps: 0,
            endReasons: {},
            rejectedGreen: 0,
            rejectedRed: 0,
        },
        integrity: { rejectedActions: 0, recoveryTurns: 0, reproSamples: [] },
    };
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
    record[key] = (record[key] ?? 0) + amount;
}

function normalizeOptions(options: IV07SelfplayPassiveAuditOptions = {}): IV07SelfplayPassiveAuditNormalizedOptions {
    const gamesPerTemplate = options.gamesPerTemplate ?? V07_SELFPLAY_PASSIVE_AUDIT_GAMES_PER_TEMPLATE;
    if (!Number.isSafeInteger(gamesPerTemplate) || gamesPerTemplate < 1) {
        throw new Error(`gamesPerTemplate must be a positive integer; got ${gamesPerTemplate}`);
    }
    if (options.maxLaps !== undefined && (!Number.isSafeInteger(options.maxLaps) || options.maxLaps < 1)) {
        throw new Error(`maxLaps must be a positive integer; got ${options.maxLaps}`);
    }
    const seedDomain = options.seedDomain ?? V07_SELFPLAY_PASSIVE_AUDIT_SEED_DOMAIN;
    if (!seedDomain.trim()) throw new Error("seedDomain must not be empty");
    const deniedSeeds = options.deniedSeeds instanceof Set ? options.deniedSeeds : new Set(options.deniedSeeds ?? []);
    for (const seed of deniedSeeds) {
        if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
            throw new Error(`denied seed must be a uint32; got ${seed}`);
        }
    }
    return { gamesPerTemplate, seedDomain, maxLaps: options.maxLaps, deniedSeeds };
}

/** Build the full deterministic schedule so collision rejection is global across all eight cohorts. */
export function createV07SelfplayPassiveAuditSeedSchedule(
    options: IV07SelfplayPassiveAuditOptions = {},
): IV07SelfplayPassiveAuditSeedSchedule {
    const normalized = normalizeOptions(options);
    const used = new Set<number>();
    const specs: IV07SelfplayPassiveAuditGameSpec[] = [];
    let collisionRejections = 0;
    for (const template of V07_ARCHETYPE_TEMPLATES) {
        for (let game = 0; game < normalized.gamesPerTemplate; game += 1) {
            let nonce = 0;
            let seed: number;
            do {
                const digest = createHash("sha256")
                    .update(normalized.seedDomain)
                    .update("\0")
                    .update(template.name)
                    .update("\0")
                    .update(String(game))
                    .update("\0")
                    .update(String(nonce))
                    .digest();
                seed = digest.readUInt32BE(0);
                if (used.has(seed) || normalized.deniedSeeds.has(seed)) {
                    collisionRejections += 1;
                    nonce += 1;
                } else {
                    break;
                }
            } while (true);
            used.add(seed);
            specs.push({ template: template.name, game, seed, maxLaps: normalized.maxLaps });
        }
    }
    return {
        schemaVersion: 1,
        algorithm: "SHA-256 domain coordinates, uint32-be, nonce rejection",
        domain: normalized.seedDomain,
        gamesPerTemplate: normalized.gamesPerTemplate,
        totalGames: specs.length,
        collisionRejections,
        deniedSeedCount: normalized.deniedSeeds.size,
        freshnessClaim: normalized.deniedSeeds.size
            ? "unique_within_run_and_excludes_supplied_denyset"
            : "unique_within_run_only",
        corpusLabel: normalized.deniedSeeds.size
            ? "deterministic v0.7 self-play passive-turn diagnostic, unique in-run and checked against supplied denyset"
            : "deterministic v0.7 self-play passive-turn diagnostic, unique in-run; no formal freshness claim",
        specs,
    };
}

export function classifyV07PassiveDecisionIntent(actions: readonly Readonly<GameAction>[]): V07PassiveDecisionIntent {
    const substantive = actions.filter((action) => action.type !== "select_attack_type" && action.type !== "end_turn");
    if (!substantive.length) return "skip";
    if (substantive.some((action) => action.type === "defend_turn")) return "shield";
    if (substantive.some((action) => action.type === "wait_turn")) return "wait";
    if (
        substantive.some(
            (action) =>
                action.type === "melee_attack" ||
                action.type === "range_attack" ||
                action.type === "area_throw_attack" ||
                action.type === "obstacle_attack",
        )
    )
        return "attack";
    if (substantive.some((action) => action.type === "cast_spell")) return "spell";
    if (substantive.some((action) => action.type === "move_unit")) return "move";
    return "other";
}

export function v07PassiveLapBand(lap: number): V07PassiveLapBand {
    if (!Number.isFinite(lap) || lap < 1) return "unknown";
    if (lap === 1) return "lap_1";
    if (lap <= 3) return "laps_2_3";
    if (lap <= 6) return "laps_4_6";
    if (lap <= 10) return "laps_7_10";
    return "laps_11_plus";
}

function scopeDimensions(
    tally: IV07SelfplayPassiveAuditTally,
    scope: IV07PassiveDecisionScope,
): IV07PassiveDimensionTally[] {
    return [
        tally.global,
        (tally.byTemplate[scope.template] ??= emptyDimension()),
        (tally.byArchetype[scope.archetype] ??= emptyDimension()),
        (tally.bySide[scope.side] ??= emptyDimension()),
        (tally.byLapBand[scope.lapBand] ??= emptyDimension()),
        (tally.byCreature[scope.creature] ??= emptyDimension()),
    ];
}

interface IAttackView {
    kind: V07PassiveAttackKind;
    meleeRoute?: V07PassiveMeleeRoute;
    expectedDamage: number;
    expectedKill: boolean;
}

function attackViews(candidateSet: ICandidateSet): IAttackView[] {
    return candidateSet.candidates.slice(1).flatMap((candidate): IAttackView[] => {
        if (candidate.kind !== "melee" && candidate.kind !== "shot" && candidate.kind !== "area_throw") return [];
        const meleeAction = candidate.actions.find((action) => action.type === "melee_attack");
        const moveAssisted =
            candidate.kind === "melee" &&
            (candidate.actions.some((action) => action.type === "move_unit") ||
                (meleeAction?.type === "melee_attack" && Boolean(meleeAction.path?.length)));
        return [
            {
                kind: candidate.kind,
                meleeRoute: candidate.kind === "melee" ? (moveAssisted ? "move_assisted" : "direct") : undefined,
                expectedDamage: candidate.features.expectedDamage,
                expectedKill: candidate.features.expectedKill === 1,
            },
        ];
    });
}

function addAttackViews(counter: IV07PassiveAttackCounter, attacks: readonly IAttackView[]): void {
    if (!attacks.length) return;
    const hadCandidates = counter.candidates > 0;
    counter.turnsWithCandidate += 1;
    counter.candidates += attacks.length;
    const positive = attacks.filter((attack) => attack.expectedDamage > 0);
    const kills = attacks.filter((attack) => attack.expectedKill);
    if (positive.length) counter.turnsWithPositiveExpectedDamage += 1;
    if (kills.length) counter.turnsWithExpectedKill += 1;
    counter.positiveExpectedDamageCandidates += positive.length;
    counter.expectedKillCandidates += kills.length;
    counter.expectedDamageSum += attacks.reduce((sum, attack) => sum + attack.expectedDamage, 0);
    const best = Math.max(...attacks.map((attack) => attack.expectedDamage));
    counter.bestExpectedDamageSum += best;
    counter.maxExpectedDamage = hadCandidates ? Math.max(counter.maxExpectedDamage, best) : best;
}

function observeAlternatives(counter: IV07PassiveAlternativeCounter, candidateSet: ICandidateSet): void {
    const alternatives = candidateSet.candidates.slice(1);
    const attacks = attackViews(candidateSet);
    counter.passiveTurns += 1;
    counter.alternativeCandidates += alternatives.length;
    addAttackViews(counter, attacks);
    for (const kind of ["melee", "shot", "area_throw"] as const) {
        addAttackViews(
            counter.byAttackKind[kind],
            attacks.filter((attack) => attack.kind === kind),
        );
    }
    for (const route of ["direct", "move_assisted"] as const) {
        addAttackViews(
            counter.byMeleeRoute[route],
            attacks.filter((attack) => attack.meleeRoute === route),
        );
    }
    if (candidateSet.truncated.length) {
        counter.truncatedTurns += 1;
        for (const kind of candidateSet.truncated) increment(counter.truncatedClasses, kind);
    }
}

/** Reduce one pre-execution strategy decision and return the stable scope needed by the execution hook. */
export function observeV07SelfplayPassiveDecision(
    tally: IV07SelfplayPassiveAuditTally,
    observation: IDecisionObservation,
    templateName: V07ArchetypeTemplateName,
    enumerate: V07PassiveCandidateEnumerator = enumerateCandidates,
    provenance: IV07PassiveDecisionProvenance = { game: -1, seed: 0 },
): IV07PassiveDecisionScope | undefined {
    if (observation.strategyVersion !== V07_SELFPLAY_PASSIVE_AUDIT_VERSION) {
        tally.ignoredStrategyTurns += 1;
        return undefined;
    }
    const template = v07ArchetypeTemplate(templateName);
    const side: Side = observation.unit.getTeam() === GREEN_TEAM ? "green" : "red";
    const intent = classifyV07PassiveDecisionIntent(observation.incumbent);
    const lap = observation.context.fightProperties?.getCurrentLap() ?? 0;
    const scope: IV07PassiveDecisionScope = {
        template: template.name,
        archetype: template.archetype,
        side,
        lapBand: v07PassiveLapBand(lap),
        creature: observation.unit.getName(),
        intent,
        unitId: observation.unit.getId(),
        lap,
        game: provenance.game,
        seed: provenance.seed,
    };
    const dimensions = scopeDimensions(tally, scope);
    for (const dimension of dimensions) {
        dimension.decisions += 1;
        dimension.intents[intent] += 1;
    }
    if (intent === "skip" || intent === "shield") {
        const candidateSet = enumerate(observation.unit, observation.context, [...observation.incumbent], {});
        for (const dimension of dimensions) observeAlternatives(dimension[intent], candidateSet);
    }
    return scope;
}

const MEANINGFUL_ACTION_TYPES = new Set<GameAction["type"]>([
    "wait_turn",
    "defend_turn",
    "move_unit",
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "obstacle_attack",
    "cast_spell",
]);

/** Reduce the detached post-turn view; no live battle object is read or mutated here. */
export function observeV07SelfplayTurnExecution(
    tally: IV07SelfplayPassiveAuditTally,
    observation: ITurnExecutionObservation,
    scope: IV07PassiveDecisionScope,
): void {
    if (observation.strategyVersion !== V07_SELFPLAY_PASSIVE_AUDIT_VERSION) return;
    const dimensions = scopeDimensions(tally, scope);
    const skippedEvents = observation.events.filter(
        (event) => event.type === "unit_skipped" && event.unitId === observation.unitId,
    );
    const explicitDefended = observation.strategyActions.some(
        (execution) =>
            execution.completed &&
            execution.action.type === "defend_turn" &&
            execution.events.some((event) => event.type === "unit_defended"),
    );
    const rejected = observation.strategyActions.filter((execution) => !execution.completed);
    const meaningfulCompleted = observation.strategyActions.some(
        (execution) => execution.completed && MEANINGFUL_ACTION_TYPES.has(execution.action.type),
    );
    const recoveryAttempts = observation.recoveryAttempts.length
        ? observation.recoveryAttempts
        : observation.recovery.source !== "none"
          ? [observation.recovery]
          : [];
    tally.integrity.rejectedActions += rejected.length;
    if (recoveryAttempts.length) tally.integrity.recoveryTurns += 1;
    for (const item of rejected) {
        addIntegrityRepro(tally, {
            kind: "rejected_action",
            template: scope.template,
            archetype: scope.archetype,
            game: scope.game,
            seed: scope.seed,
            side: scope.side,
            lap: scope.lap,
            unitId: scope.unitId,
            creature: scope.creature,
            intent: scope.intent,
            proposedActions: structuredClone(observation.chosenDecision),
            rejectedAction: structuredClone(item.action),
            ...(item.rejectionReason === undefined ? {} : { rejectionReason: item.rejectionReason }),
        });
    }
    if (recoveryAttempts.length) {
        addIntegrityRepro(tally, {
            kind: "recovery",
            template: scope.template,
            archetype: scope.archetype,
            game: scope.game,
            seed: scope.seed,
            side: scope.side,
            lap: scope.lap,
            unitId: scope.unitId,
            creature: scope.creature,
            intent: scope.intent,
            proposedActions: structuredClone(observation.chosenDecision),
            recoverySource: recoveryAttempts[recoveryAttempts.length - 1].source as "advance" | "defend",
            recoveryAttempts: recoveryAttempts.map((attempt) => ({
                source: attempt.source as "advance" | "defend",
                completed: attempt.completed,
                ...(attempt.action ? { action: structuredClone(attempt.action) } : {}),
                ...(attempt.rejectionReason === undefined ? {} : { rejectionReason: attempt.rejectionReason }),
            })),
        });
    }
    for (const dimension of dimensions) {
        const execution = dimension.execution;
        execution.observedTurns += 1;
        if (skippedEvents.length) {
            execution.actualUnitSkippedTurns += 1;
            for (const event of skippedEvents) {
                if (event.type === "unit_skipped") increment(execution.unitSkipReasons, event.reason);
            }
        }
        if (explicitDefended) execution.explicitUnitDefendedTurns += 1;
        if (recoveryAttempts.some((attempt) => attempt.source === "defend")) execution.recoveryDefendTurns += 1;
        if (recoveryAttempts.some((attempt) => attempt.source === "advance")) execution.recoveryAdvanceTurns += 1;
        if (recoveryAttempts.some((attempt) => !attempt.completed)) execution.recoveryFailedTurns += 1;
        if (!meaningfulCompleted) execution.strategyNoOpTurns += 1;
        if (rejected.length) execution.rejectedTurns += 1;
        execution.rejectedActions += rejected.length;
        for (const item of rejected) increment(execution.rejectionReasons, item.rejectionReason ?? "unknown");
    }
}

function addIntegrityRepro(tally: IV07SelfplayPassiveAuditTally, repro: IV07SelfplayPassiveAuditIntegrityRepro): void {
    if (tally.integrity.reproSamples.length < INTEGRITY_REPRO_SAMPLE_LIMIT) {
        tally.integrity.reproSamples.push(repro);
    }
}

function mergeNumbers(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
    for (const [key, value] of Object.entries(source)) increment(target, key, value);
}

function mergeAttackCounter(target: IV07PassiveAttackCounter, source: IV07PassiveAttackCounter): void {
    const targetHadCandidates = target.candidates > 0;
    target.turnsWithCandidate += source.turnsWithCandidate;
    target.candidates += source.candidates;
    target.turnsWithPositiveExpectedDamage += source.turnsWithPositiveExpectedDamage;
    target.positiveExpectedDamageCandidates += source.positiveExpectedDamageCandidates;
    target.turnsWithExpectedKill += source.turnsWithExpectedKill;
    target.expectedKillCandidates += source.expectedKillCandidates;
    target.expectedDamageSum += source.expectedDamageSum;
    target.bestExpectedDamageSum += source.bestExpectedDamageSum;
    if (source.candidates > 0) {
        target.maxExpectedDamage = targetHadCandidates
            ? Math.max(target.maxExpectedDamage, source.maxExpectedDamage)
            : source.maxExpectedDamage;
    }
}

function mergeAlternativeCounter(target: IV07PassiveAlternativeCounter, source: IV07PassiveAlternativeCounter): void {
    mergeAttackCounter(target, source);
    target.passiveTurns += source.passiveTurns;
    target.alternativeCandidates += source.alternativeCandidates;
    target.truncatedTurns += source.truncatedTurns;
    mergeNumbers(target.truncatedClasses, source.truncatedClasses);
    for (const kind of ["melee", "shot", "area_throw"] as const)
        mergeAttackCounter(target.byAttackKind[kind], source.byAttackKind[kind]);
    for (const route of ["direct", "move_assisted"] as const)
        mergeAttackCounter(target.byMeleeRoute[route], source.byMeleeRoute[route]);
}

function mergeExecutionCounter(target: IV07PassiveExecutionCounter, source: IV07PassiveExecutionCounter): void {
    target.observedTurns += source.observedTurns;
    target.actualUnitSkippedTurns += source.actualUnitSkippedTurns;
    target.explicitUnitDefendedTurns += source.explicitUnitDefendedTurns;
    target.recoveryDefendTurns += source.recoveryDefendTurns;
    target.recoveryAdvanceTurns += source.recoveryAdvanceTurns;
    target.recoveryFailedTurns += source.recoveryFailedTurns;
    target.strategyNoOpTurns += source.strategyNoOpTurns;
    target.rejectedTurns += source.rejectedTurns;
    target.rejectedActions += source.rejectedActions;
    mergeNumbers(target.unitSkipReasons, source.unitSkipReasons);
    mergeNumbers(target.rejectionReasons, source.rejectionReasons);
}

function mergeDimension(target: IV07PassiveDimensionTally, source: IV07PassiveDimensionTally): void {
    target.decisions += source.decisions;
    for (const intent of V07_PASSIVE_DECISION_INTENTS) target.intents[intent] += source.intents[intent];
    mergeAlternativeCounter(target.skip, source.skip);
    mergeAlternativeCounter(target.shield, source.shield);
    mergeExecutionCounter(target.execution, source.execution);
}

function mergeDimensions<K extends string>(
    target: Partial<Record<K, IV07PassiveDimensionTally>>,
    source: Partial<Record<K, IV07PassiveDimensionTally>>,
): void {
    for (const [key, value] of Object.entries(source) as [K, IV07PassiveDimensionTally][]) {
        mergeDimension((target[key] ??= emptyDimension()), value);
    }
}

export function mergeV07SelfplayPassiveAuditTallies(
    target: IV07SelfplayPassiveAuditTally,
    source: IV07SelfplayPassiveAuditTally,
): void {
    target.games += source.games;
    target.ignoredStrategyTurns += source.ignoredStrategyTurns;
    mergeDimension(target.global, source.global);
    mergeDimensions(target.byTemplate, source.byTemplate);
    mergeDimensions(target.byArchetype, source.byArchetype);
    mergeDimensions(target.bySide, source.bySide);
    mergeDimensions(target.byLapBand, source.byLapBand);
    mergeDimensions(target.byCreature, source.byCreature);
    target.outcomes.greenWins += source.outcomes.greenWins;
    target.outcomes.redWins += source.outcomes.redWins;
    target.outcomes.draws += source.outcomes.draws;
    target.outcomes.totalLaps += source.outcomes.totalLaps;
    target.outcomes.rejectedGreen += source.outcomes.rejectedGreen;
    target.outcomes.rejectedRed += source.outcomes.rejectedRed;
    mergeNumbers(target.outcomes.endReasons, source.outcomes.endReasons);
    target.integrity.rejectedActions += source.integrity.rejectedActions;
    target.integrity.recoveryTurns += source.integrity.recoveryTurns;
    target.integrity.reproSamples = [...target.integrity.reproSamples, ...source.integrity.reproSamples]
        .sort(
            (a, b) =>
                a.template.localeCompare(b.template) ||
                a.game - b.game ||
                a.seed - b.seed ||
                a.lap - b.lap ||
                a.side.localeCompare(b.side) ||
                a.unitId.localeCompare(b.unitId) ||
                a.kind.localeCompare(b.kind),
        )
        .slice(0, INTEGRITY_REPRO_SAMPLE_LIMIT);
}

function recordOutcome(tally: IV07SelfplayPassiveAuditTally, result: IMatchResult): void {
    tally.games += 1;
    if (result.winner === "green") tally.outcomes.greenWins += 1;
    else if (result.winner === "red") tally.outcomes.redWins += 1;
    else tally.outcomes.draws += 1;
    tally.outcomes.totalLaps += result.laps;
    tally.outcomes.rejectedGreen += result.rejectedGreen ?? 0;
    tally.outcomes.rejectedRed += result.rejectedRed ?? 0;
    increment(tally.outcomes.endReasons, result.endReason);
}

export function playV07SelfplayPassiveAuditGame(
    spec: IV07SelfplayPassiveAuditGameSpec,
    dependencies: IV07SelfplayPassiveAuditGameDependencies = {},
): IV07SelfplayPassiveAuditGameResult {
    if (!Number.isSafeInteger(spec.game) || spec.game < 0)
        throw new Error(`game must be non-negative; got ${spec.game}`);
    if (!Number.isSafeInteger(spec.seed) || spec.seed < 0 || spec.seed > 0xffffffff) {
        throw new Error(`seed must be a uint32; got ${spec.seed}`);
    }
    if (spec.maxLaps !== undefined && (!Number.isSafeInteger(spec.maxLaps) || spec.maxLaps < 1)) {
        throw new Error(`maxLaps must be a positive integer; got ${spec.maxLaps}`);
    }
    const template = v07ArchetypeTemplate(spec.template);
    const tally = createV07SelfplayPassiveAuditTally();
    const pending = new Map<string, IV07PassiveDecisionScope[]>();
    const setup = liveTwinSetup();
    const roster = template.roster.map((unit) => ({ ...unit }));
    const redRoster = template.roster.map((unit) => ({ ...unit }));
    const matchRunner = dependencies.matchRunner ?? runMatch;
    const enumerator = dependencies.enumerate ?? enumerateCandidates;
    FightStateManager.getInstance();
    const result = matchRunner({
        greenVersion: V07_SELFPLAY_PASSIVE_AUDIT_VERSION,
        redVersion: V07_SELFPLAY_PASSIVE_AUDIT_VERSION,
        roster,
        redRoster,
        seed: spec.seed,
        maxLaps: spec.maxLaps,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: setup.perk,
        redPerk: setup.perk,
        greenAugments: setup.augments,
        redAugments: setup.augments,
        decisionObserver: (observation) => {
            const scope = observeV07SelfplayPassiveDecision(tally, observation, template.name, enumerator, {
                game: spec.game,
                seed: spec.seed,
            });
            if (scope) {
                const queue = pending.get(scope.unitId) ?? [];
                queue.push(scope);
                pending.set(scope.unitId, queue);
            }
        },
        turnExecutionObserver: (observation) => {
            const queue = pending.get(observation.unitId);
            const scope = queue?.shift();
            if (!scope) {
                throw new Error(`execution observation has no decision scope for ${observation.unitId}`);
            }
            if (!queue?.length) pending.delete(observation.unitId);
            observeV07SelfplayTurnExecution(tally, observation, scope);
        },
    });
    if (pending.size) throw new Error(`match ended with ${pending.size} unmatched decision scope(s)`);
    recordOutcome(tally, result);
    const aggregate = tally.global;
    return {
        tally,
        cluster: {
            template: template.name,
            archetype: template.archetype,
            game: spec.game,
            seed: spec.seed,
            winner: result.winner,
            laps: result.laps,
            endReason: result.endReason,
            decisions: aggregate.decisions,
            skipIntents: aggregate.intents.skip,
            shieldIntents: aggregate.intents.shield,
            passiveTurnsWithAttackCandidate: aggregate.skip.turnsWithCandidate + aggregate.shield.turnsWithCandidate,
            passiveTurnsWithPositiveExpectedDamage:
                aggregate.skip.turnsWithPositiveExpectedDamage + aggregate.shield.turnsWithPositiveExpectedDamage,
            actualUnitSkippedTurns: aggregate.execution.actualUnitSkippedTurns,
            explicitUnitDefendedTurns: aggregate.execution.explicitUnitDefendedTurns,
            recoveryTurns: tally.integrity.recoveryTurns,
            recoveryDefendTurns: aggregate.execution.recoveryDefendTurns,
            recoveryAdvanceTurns: aggregate.execution.recoveryAdvanceTurns,
            recoveryFailedTurns: aggregate.execution.recoveryFailedTurns,
            rejectedTurns: aggregate.execution.rejectedTurns,
            rejectedActions: aggregate.execution.rejectedActions,
        },
    };
}

function sortedNumbers(record: Readonly<Record<string, number>>): Record<string, number> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function attackSummary(counter: IV07PassiveAttackCounter, passiveTurns: number): IV07PassiveAttackSummary {
    return {
        ...counter,
        shareOfPassiveTurns: passiveTurns ? counter.turnsWithCandidate / passiveTurns : 0,
        positiveDamageShareOfPassiveTurns: passiveTurns ? counter.turnsWithPositiveExpectedDamage / passiveTurns : 0,
        expectedKillShareOfPassiveTurns: passiveTurns ? counter.turnsWithExpectedKill / passiveTurns : 0,
        avgCandidatesPerPassiveTurn: passiveTurns ? counter.candidates / passiveTurns : 0,
        avgBestExpectedDamage: counter.turnsWithCandidate
            ? counter.bestExpectedDamageSum / counter.turnsWithCandidate
            : 0,
    };
}

function alternativeSummary(counter: IV07PassiveAlternativeCounter, decisions: number): IV07PassiveAlternativeSummary {
    return {
        ...counter,
        truncatedClasses: sortedNumbers(counter.truncatedClasses),
        shareOfAllDecisions: decisions ? counter.passiveTurns / decisions : 0,
        attack: attackSummary(counter, counter.passiveTurns),
        byAttackKind: {
            melee: attackSummary(counter.byAttackKind.melee, counter.passiveTurns),
            shot: attackSummary(counter.byAttackKind.shot, counter.passiveTurns),
            area_throw: attackSummary(counter.byAttackKind.area_throw, counter.passiveTurns),
        },
        byMeleeRoute: {
            direct: attackSummary(counter.byMeleeRoute.direct, counter.passiveTurns),
            move_assisted: attackSummary(counter.byMeleeRoute.move_assisted, counter.passiveTurns),
        },
    };
}

function dimensionSummary(key: string, tally: IV07PassiveDimensionTally): IV07PassiveDimensionSummary {
    const passive = tally.intents.skip + tally.intents.shield;
    const observed = tally.execution.observedTurns;
    return {
        key,
        decisions: tally.decisions,
        intents: { ...tally.intents },
        skipShare: tally.decisions ? tally.intents.skip / tally.decisions : 0,
        shieldShare: tally.decisions ? tally.intents.shield / tally.decisions : 0,
        skipToShieldRatio: tally.intents.shield ? tally.intents.skip / tally.intents.shield : null,
        passiveShare: tally.decisions ? passive / tally.decisions : 0,
        skip: alternativeSummary(tally.skip, tally.decisions),
        shield: alternativeSummary(tally.shield, tally.decisions),
        execution: {
            ...tally.execution,
            unitSkipReasons: sortedNumbers(tally.execution.unitSkipReasons),
            rejectionReasons: sortedNumbers(tally.execution.rejectionReasons),
            actualSkipShare: observed ? tally.execution.actualUnitSkippedTurns / observed : 0,
            explicitDefendShare: observed ? tally.execution.explicitUnitDefendedTurns / observed : 0,
            recoveryDefendShare: observed ? tally.execution.recoveryDefendTurns / observed : 0,
            rejectedTurnShare: observed ? tally.execution.rejectedTurns / observed : 0,
        },
    };
}

function dimensionList<K extends string>(
    record: Partial<Record<K, IV07PassiveDimensionTally>>,
): IV07PassiveDimensionSummary[] {
    return (Object.entries(record) as [K, IV07PassiveDimensionTally][])
        .map(([key, value]) => dimensionSummary(key, value))
        .sort((a, b) => b.decisions - a.decisions || a.key.localeCompare(b.key));
}

export function finalizeV07SelfplayPassiveAudit(
    options: IV07SelfplayPassiveAuditOptions,
    tally: IV07SelfplayPassiveAuditTally,
    seedSchedule:
        | IV07SelfplayPassiveAuditSeedSchedule
        | V07SelfplayPassiveAuditSeedProtocol = createV07SelfplayPassiveAuditSeedSchedule(options),
): IV07SelfplayPassiveAuditReport {
    const normalized = normalizeOptions(options);
    const seedProtocol: V07SelfplayPassiveAuditSeedProtocol =
        "specs" in seedSchedule
            ? {
                  schemaVersion: seedSchedule.schemaVersion,
                  algorithm: seedSchedule.algorithm,
                  domain: seedSchedule.domain,
                  gamesPerTemplate: seedSchedule.gamesPerTemplate,
                  totalGames: seedSchedule.totalGames,
                  collisionRejections: seedSchedule.collisionRejections,
                  deniedSeedCount: seedSchedule.deniedSeedCount,
                  freshnessClaim: seedSchedule.freshnessClaim,
                  corpusLabel: seedSchedule.corpusLabel,
              }
            : seedSchedule;
    const setup = liveTwinSetup();
    return {
        schemaVersion: 1,
        status: "v0.7_selfplay_passive_turn_diagnostic",
        auditedVersion: V07_SELFPLAY_PASSIVE_AUDIT_VERSION,
        games: tally.games,
        effectiveConfig: {
            templates: V07_ARCHETYPE_TEMPLATES,
            gamesPerTemplate: normalized.gamesPerTemplate,
            plannedTotalGames: normalized.gamesPerTemplate * V07_ARCHETYPE_TEMPLATES.length,
            rosters: "same fixed template roster in both seats",
            setup: { ...setup, noVision: true },
            map: "NORMAL",
            candidateEnumeration: "F4 complete and uncapped, only on skip/shield intents",
            decisionObservation: "after decideTurn, before search/apply/recovery",
            executionObservation: "after strategy apply, recovery, and final end-turn close",
        },
        seedProtocol,
        outcomes: {
            greenWins: tally.outcomes.greenWins,
            redWins: tally.outcomes.redWins,
            draws: tally.outcomes.draws,
            avgLaps: tally.games ? tally.outcomes.totalLaps / tally.games : 0,
            endReasons: sortedNumbers(tally.outcomes.endReasons),
            rejectedGreen: tally.outcomes.rejectedGreen,
            rejectedRed: tally.outcomes.rejectedRed,
        },
        aggregate: dimensionSummary("aggregate", tally.global),
        byTemplate: dimensionList(tally.byTemplate),
        byArchetypeCohort: dimensionList(tally.byArchetype),
        bySide: dimensionList(tally.bySide),
        byLapBand: dimensionList(tally.byLapBand),
        byCreature: dimensionList(tally.byCreature),
        ignoredStrategyTurns: tally.ignoredStrategyTurns,
        integrity: {
            ...tally.integrity,
            smoothExecutionPass: tally.integrity.rejectedActions === 0 && tally.integrity.recoveryTurns === 0,
        },
        limitations: [
            "An attack opportunity means F4 found an engine-legal melee, shot, or area-throw candidate at the pre-execution state; legality does not establish that choosing it was strategically better.",
            "Positive expected damage and expected-kill flags are deterministic immediate-action estimates, not realized hit outcomes or full-fight counterfactual values.",
            "Move-assisted melee includes a movement action or a non-empty melee path; direct melee does not move before striking.",
            "Skip and shield intent are policy decisions. Actual unit_skipped events, explicit unit_defended events, simulator recovery, and rejected/no-op strategy turns are reported separately.",
            "Any rejected strategy action or simulator recovery turn fails smoothExecutionPass and must be fixed and rerun; recovery is never normalized into a v0.7 policy ratio.",
            "The fixed templates isolate mage, melee-mage, aura, and ranged cohorts; they are not a random sample of every legal roster or draft state.",
            seedProtocol.freshnessClaim === "unique_within_run_only"
                ? "Seeds are deterministically unique within this run, but no historical denyset was supplied, so this report makes no formal fresh-seed claim."
                : "Seeds are deterministically unique within this run and exclude the supplied denyset; completeness of that denyset remains an external provenance requirement.",
        ],
    };
}

/** Stable roster provenance string for shard/checkpoint writers. */
export function v07SelfplayPassiveAuditRosterSignature(template: V07ArchetypeTemplateName): string {
    return rosterSignature(v07ArchetypeTemplate(template).roster);
}
