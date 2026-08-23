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

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { creatureIdForName } from "../ai/setup/creature_score";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import {
    buildV08BacklineProtectorIntent,
    buildV08BacklineWardIntent,
    isV08BacklineProtectionBeneficiary,
    preservesV08BacklineProtectorIntent,
    preservesV08BacklineWardIntent,
    v08BacklineProtectorCoverageRange,
    v08BacklineProtectorHasCatchUpRoute,
    type IV08BacklineProtectorIntent,
    type IV08BacklineWardIntent,
} from "../ai/versions/v0_8_backline_protector";
import { v08DominantFinishState } from "../ai/versions/v0_8_dominant_finish";
import { STRATEGY_V0_8 } from "../ai/versions/v0_8";
import {
    creaturesByLevel,
    hashSimulationParts,
    resolveStackAmount,
    DEFAULT_AMOUNT_BY_LEVEL,
    type IArmyUnitSpec,
} from "./army";
import {
    runMatch,
    type IDecisionObservation,
    type IMatchConfig,
    type IMatchResult,
    type ITurnExecutionObservation,
    type Side,
} from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import { SearchDriver } from "./search_driver";

export const V08_PROTECTOR_STRESS_SCHEMA = "hoc.v0_8_protector_stress.v1" as const;
export const V08_PROTECTOR_STRESS_DEFAULT_GAMES = 144;
export const V08_PROTECTOR_STRESS_DEFAULT_SEED = 80_813_441;
export const V08_PROTECTOR_STRESS_DEFAULT_CONCURRENCY = 12;
export const V08_PROTECTOR_STRESS_MATRIX_GAMES = 144;

export const V08_PROTECTOR_STRESS_PROTECTORS = ["abomination", "arachna_queen"] as const;
export const V08_PROTECTOR_STRESS_WARDS = ["range", "magic", "melee_magic", "depleted"] as const;
export const V08_PROTECTOR_STRESS_THREATS = ["flyer", "rusher", "mixed"] as const;
export const V08_PROTECTOR_STRESS_MAPS = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;

export type V08ProtectorStressProtector = (typeof V08_PROTECTOR_STRESS_PROTECTORS)[number];
export type V08ProtectorStressWard = (typeof V08_PROTECTOR_STRESS_WARDS)[number];
export type V08ProtectorStressThreat = (typeof V08_PROTECTOR_STRESS_THREATS)[number];

export interface IV08ProtectorStressOptions {
    games: number;
    baseSeed: number;
    concurrency: number;
    maxLaps: number;
}

const WARD_CREATURE: Readonly<Record<V08ProtectorStressWard, string>> = {
    range: "Arbalester",
    magic: "Healer",
    melee_magic: "Battle Mage",
    // A finite four-shot ward. It is draft-eligible at placement, then becomes a real depleted ward once
    // its ammunition reaches zero; the observer verifies that the protector releases it at that point.
    depleted: "Centaur",
};

const FRIENDLY_FILLERS = ["Squire", "Peasant", "Pikeman", "Wolf Rider"] as const;
const THREAT_CREATURES: Readonly<Record<V08ProtectorStressThreat, readonly string[]>> = {
    flyer: ["Griffin", "Manticore", "Squire", "Peasant", "Pikeman", "Champion"],
    rusher: ["Frenzied Boar", "Berserker", "Wolf Rider", "Squire", "Peasant", "Pikeman"],
    mixed: ["Frenzied Boar", "Griffin", "Berserker", "Arbalester", "Healer", "Squire"],
};

const enabledCreatureId = (name: string): number => {
    const id = creatureIdForName(name);
    if (id === undefined) throw new Error(`Protector stress creature is not enabled: ${name}`);
    return id;
};

const creatureSpec = (name: string): IArmyUnitSpec => {
    const entry = [1, 2, 3, 4]
        .flatMap((level) => creaturesByLevel(level))
        .find((candidate) => candidate.creatureName === name);
    if (!entry) throw new Error(`Protector stress creature is absent from the simulation catalog: ${name}`);
    return {
        faction: entry.faction,
        creatureName: entry.creatureName,
        level: entry.level,
        size: entry.size,
        amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
    };
};

const rosterCreatureIds = (roster: readonly IArmyUnitSpec[]): number[] =>
    roster.map((spec) => enabledCreatureId(spec.creatureName));

export interface IV08ProtectorStressGamePlan {
    game: number;
    matrixCycle: number;
    matrixCombination: number;
    seed: number;
    mapType: number;
    protector: V08ProtectorStressProtector;
    ward: V08ProtectorStressWard;
    wardCreatureName: string;
    threat: V08ProtectorStressThreat;
    protectorSide: Side;
    selectedProtectorName: "Abomination" | "Arachna Queen" | "Champion";
    queenDraftExpected: boolean;
    queenDrafted: boolean;
    greenRoster: IArmyUnitSpec[];
    redRoster: IArmyUnitSpec[];
    greenPublicOpponentCreatures: number[];
    redPublicOpponentCreatures: number[];
}

/**
 * A 144-game cycle is the exact Cartesian matrix:
 *   2 protector plans × 4 ward classes × 3 threat classes × 3 maps × 2 physical seats.
 *
 * Adjacent games are a seat swap with an identical combat seed. The first 48 games cover every
 * protector/ward/threat combination once; the two later passes rotate each combination over the other maps.
 */
export function planV08ProtectorStressGame(
    options: Pick<IV08ProtectorStressOptions, "baseSeed">,
    game: number,
): IV08ProtectorStressGamePlan {
    if (!Number.isSafeInteger(game) || game < 0) throw new RangeError(`Invalid protector stress game ${game}`);
    const pair = Math.floor(game / 2);
    const matrixCycle = Math.floor(pair / 72);
    const withinMatrix = pair % 72;
    const mapPass = Math.floor(withinMatrix / 24);
    const matrixCombination = withinMatrix % 24;
    const protector = V08_PROTECTOR_STRESS_PROTECTORS[matrixCombination % 2];
    const ward = V08_PROTECTOR_STRESS_WARDS[Math.floor(matrixCombination / 2) % 4];
    const threat = V08_PROTECTOR_STRESS_THREATS[Math.floor(matrixCombination / 8) % 3];
    const mapType = V08_PROTECTOR_STRESS_MAPS[(mapPass + matrixCombination) % V08_PROTECTOR_STRESS_MAPS.length];
    const protectorSide: Side = game % 2 === 0 ? "green" : "red";
    const wardCreatureName = WARD_CREATURE[ward];
    const nonProtectorRoster = [wardCreatureName, ...FRIENDLY_FILLERS].map(creatureSpec);
    const enemyRoster = THREAT_CREATURES[threat].map(creatureSpec);
    const knownOpponentIds = rosterCreatureIds(enemyRoster);

    let selectedProtectorName: IV08ProtectorStressGamePlan["selectedProtectorName"] = "Abomination";
    let queenDrafted = false;
    const queenDraftExpected = protector === "arachna_queen" && threat !== "rusher";
    if (protector === "arachna_queen") {
        const queenId = enabledCreatureId("Arachna Queen");
        const championId = enabledCreatureId("Champion");
        const picked = SETUP_POLICY_V0.pickCreature(
            4,
            [queenId, championId],
            rosterCreatureIds(nonProtectorRoster),
            knownOpponentIds,
        );
        queenDrafted = picked === queenId;
        selectedProtectorName = queenDrafted ? "Arachna Queen" : "Champion";
    }
    const protectedRoster = [creatureSpec(selectedProtectorName), ...nonProtectorRoster];
    const greenRoster = protectorSide === "green" ? protectedRoster : enemyRoster;
    const redRoster = protectorSide === "green" ? enemyRoster : protectedRoster;
    return {
        game,
        matrixCycle,
        matrixCombination,
        seed: hashSimulationParts(
            "v0.8-protector-stress-v1",
            options.baseSeed,
            matrixCycle,
            matrixCombination,
            mapPass,
        ),
        mapType,
        protector,
        ward,
        wardCreatureName,
        threat,
        protectorSide,
        selectedProtectorName,
        queenDraftExpected,
        queenDrafted,
        greenRoster,
        redRoster,
        greenPublicOpponentCreatures: rosterCreatureIds(redRoster),
        redPublicOpponentCreatures: rosterCreatureIds(greenRoster),
    };
}

export interface IV08ProtectorStressMetrics {
    protectorTurns: number;
    constrainedTurns: number;
    summonedQueenTurns: number;
    summonedQueensCreated: number;
    queenNoFlyerReleaseTurns: number;
    queenNoFlyerConstraintViolations: number;
    depletedWardReleaseTurns: number;
    deadWardReleaseTurns: number;
    dominantFinishReleaseTurns: number;
    coveredAtDecision: number;
    coveredAfterAction: number;
    exactCoverageOpportunities: number;
    guardBreakingFinalActions: number;
    rushViolations: number;
    blockedCatchUpTurns: number;
    abominationExactRangeViolations: number;
    abominationCoverageGapTurns: number;
    wardConstrainedTurns: number;
    wardGuardBreakingFinalActions: number;
    wardRushViolations: number;
    usefulProtectorAttacks: number;
    usefulProtectorCasts: number;
    protectorMoves: number;
    protectorWaits: number;
    protectorDefends: number;
    wardTurns: number;
    wardAttacks: number;
    wardCasts: number;
    wardDamage: number;
    wardHealing: number;
    wardSurvived: number;
    nativeProtectorPlacements: number;
    initialExactCoverage: number;
    allDecisionLatencyMicros: number[];
    protectorDecisionLatencyMicros: number[];
}

export const emptyV08ProtectorStressMetrics = (): IV08ProtectorStressMetrics => ({
    protectorTurns: 0,
    constrainedTurns: 0,
    summonedQueenTurns: 0,
    summonedQueensCreated: 0,
    queenNoFlyerReleaseTurns: 0,
    queenNoFlyerConstraintViolations: 0,
    depletedWardReleaseTurns: 0,
    deadWardReleaseTurns: 0,
    dominantFinishReleaseTurns: 0,
    coveredAtDecision: 0,
    coveredAfterAction: 0,
    exactCoverageOpportunities: 0,
    guardBreakingFinalActions: 0,
    rushViolations: 0,
    blockedCatchUpTurns: 0,
    abominationExactRangeViolations: 0,
    abominationCoverageGapTurns: 0,
    wardConstrainedTurns: 0,
    wardGuardBreakingFinalActions: 0,
    wardRushViolations: 0,
    usefulProtectorAttacks: 0,
    usefulProtectorCasts: 0,
    protectorMoves: 0,
    protectorWaits: 0,
    protectorDefends: 0,
    wardTurns: 0,
    wardAttacks: 0,
    wardCasts: 0,
    wardDamage: 0,
    wardHealing: 0,
    wardSurvived: 0,
    nativeProtectorPlacements: 0,
    initialExactCoverage: 0,
    allDecisionLatencyMicros: [],
    protectorDecisionLatencyMicros: [],
});

export interface IV08ProtectorStressRecord {
    schema: typeof V08_PROTECTOR_STRESS_SCHEMA;
    game: number;
    seed: number;
    mapType: number;
    matrixCycle: number;
    matrixCombination: number;
    protector: V08ProtectorStressProtector;
    ward: V08ProtectorStressWard;
    threat: V08ProtectorStressThreat;
    protectorSide: Side;
    selectedProtectorName: IV08ProtectorStressGamePlan["selectedProtectorName"];
    queenDraftExpected: boolean;
    queenDrafted: boolean;
    draftMismatch: number;
    winner: Side | "draw" | "crash";
    endReason: IMatchResult["endReason"] | "crash";
    laps: number;
    rejectedActions: number;
    protectedSideRejectedActions: number;
    rejectionsByCause: Record<string, number>;
    metrics: IV08ProtectorStressMetrics;
    crash?: string;
}

const sideForUnit = (unit: Unit): Side => (unit.getTeam() === PBTypes.TeamVals.LOWER ? "green" : "red");

const increment = (record: Record<string, number>, key: string, amount = 1): void => {
    record[key] = (record[key] ?? 0) + amount;
};

const footprintDistance = (left: readonly XY[], right: readonly XY[]): number => {
    let closest = Infinity;
    for (const a of left) {
        for (const b of right) {
            closest = Math.min(closest, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
        }
    }
    return closest;
};

const placementCells = (cell: XY, size: number): XY[] =>
    size === 1
        ? [{ ...cell }]
        : [{ ...cell }, { x: cell.x - 1, y: cell.y }, { x: cell.x, y: cell.y - 1 }, { x: cell.x - 1, y: cell.y - 1 }];

interface IPendingProtectorTurn {
    unit: Unit;
    context: IDecisionObservation["context"];
    intent?: IV08BacklineProtectorIntent;
    ward?: Unit;
    distanceBefore: number;
    coveredBefore: boolean;
    catchUpAvailable: boolean;
    localDiverIds: ReadonlySet<string>;
    coverageRange: number;
}

interface IPendingWardTurn {
    unit: Unit;
    context: IDecisionObservation["context"];
    intent: IV08BacklineWardIntent;
    distanceBefore: number;
    coveredBefore: boolean;
}

interface IDecisionTimingSink {
    all: number[];
    protector: number[];
    protectorSide: Side;
}

/**
 * Time the unmodified production methods in a worker-local wrapper. `decisionOrigin === "root"` excludes
 * the many strategy calls made inside a13 rollouts, so each sample is exactly one live root decision:
 * native v0.8 policy time + the bounded a13 SearchDriver arbitration time.
 */
function withV08DecisionTiming<T>(sink: IDecisionTimingSink, run: () => T): T {
    const originalDecideTurn = STRATEGY_V0_8.decideTurn;
    const originalChooseDecision = SearchDriver.prototype.chooseDecision;
    const nativeMicros = new Map<string, number>();
    STRATEGY_V0_8.decideTurn = function timedV08Decision(unit, context): GameAction[] {
        if (context.decisionOrigin !== "root") {
            return originalDecideTurn.call(STRATEGY_V0_8, unit, context);
        }
        const started = performance.now();
        try {
            return originalDecideTurn.call(STRATEGY_V0_8, unit, context);
        } finally {
            nativeMicros.set(unit.getId(), Math.max(0, Math.round((performance.now() - started) * 1_000)));
        }
    };
    SearchDriver.prototype.chooseDecision = function timedA13Decision(
        unit,
        version,
        incumbent,
        rootDecisionContext,
    ): GameAction[] {
        const started = performance.now();
        try {
            return originalChooseDecision.call(this, unit, version, incumbent, rootDecisionContext);
        } finally {
            const native = nativeMicros.get(unit.getId());
            nativeMicros.delete(unit.getId());
            if (native !== undefined && version === "v0.8") {
                const total = native + Math.max(0, Math.round((performance.now() - started) * 1_000));
                sink.all.push(total);
                if (
                    sideForUnit(unit) === sink.protectorSide &&
                    !unit.isSummoned() &&
                    (unit.getName() === "Abomination" || unit.getName() === "Arachna Queen")
                ) {
                    sink.protector.push(total);
                }
            }
        }
    };
    try {
        return run();
    } finally {
        STRATEGY_V0_8.decideTurn = originalDecideTurn;
        SearchDriver.prototype.chooseDecision = originalChooseDecision;
    }
}

const completedActionTypes = (observation: ITurnExecutionObservation): GameAction["type"][] => [
    ...observation.strategyActions.filter((entry) => entry.completed).map((entry) => entry.action.type),
    ...observation.recoveryAttempts
        .filter((entry) => entry.completed && entry.action)
        .map((entry) => entry.action!.type),
];

const attackDamage = (observation: ITurnExecutionObservation): number => {
    let total = 0;
    for (const event of observation.events) {
        if (event.type === "unit_attacked" && event.attackerId === observation.unitId) {
            total += event.damage.splash?.length
                ? event.damage.splash.reduce((sum, hit) => sum + hit.amount, 0)
                : event.damage.amount;
            total += event.damage.secondary?.reduce((sum, hit) => sum + hit.amount, 0) ?? 0;
        } else if (event.type === "area_attacked" && event.attackerId === observation.unitId) {
            total += event.damage.splash?.reduce((sum, hit) => sum + hit.amount, 0) ?? event.damage.amount;
        } else if (event.type === "spell_cast" && event.casterId === observation.unitId) {
            total += event.damaged?.reduce((sum, hit) => sum + (hit.rebounded ? 0 : hit.amount), 0) ?? 0;
            total += event.secondary?.reduce((sum, hit) => sum + (hit.rebounded ? 0 : hit.amount), 0) ?? 0;
        }
    }
    return total;
};

const healingOutput = (observation: ITurnExecutionObservation): number =>
    observation.events.reduce(
        (total, event) =>
            total +
            (event.type === "spell_cast" && event.casterId === observation.unitId
                ? (event.healed?.reduce((sum, hit) => sum + hit.amount, 0) ?? 0)
                : 0),
        0,
    );

const resultRejectionCauses = (result: IMatchResult): Record<string, number> => {
    const causes: Record<string, number> = {};
    for (const detail of result.rejectedDetails ?? []) {
        increment(causes, detail.cause ?? `${detail.type}:${detail.reason ?? "unknown"}`);
    }
    return causes;
};

/** One production v0.8+A19 game, with observers only; the engine and policies are not reimplemented. */
export function runV08ProtectorStressGame(
    options: Pick<IV08ProtectorStressOptions, "baseSeed" | "maxLaps">,
    game: number,
): IV08ProtectorStressRecord {
    const plan = planV08ProtectorStressGame(options, game);
    const metrics = emptyV08ProtectorStressMetrics();
    const pending = new Map<string, IPendingProtectorTurn>();
    const pendingWards = new Map<string, IPendingWardTurn>();
    let wardUnit: Unit | undefined;
    const nativeProtectorName = plan.queenDrafted
        ? "Arachna Queen"
        : plan.protector === "abomination"
          ? "Abomination"
          : undefined;

    const findTrackedUnits = (observation: IDecisionObservation): void => {
        if (wardUnit) return;
        wardUnit = [...observation.context.unitsHolder.getAllUnits().values()].find(
            (unit) =>
                sideForUnit(unit) === plan.protectorSide &&
                !unit.isSummoned() &&
                unit.getName() === plan.wardCreatureName,
        );
    };

    const observeDecision = (observation: IDecisionObservation): void => {
        findTrackedUnits(observation);
        const { unit, context } = observation;
        if (unit.getName() === "Arachna Queen" && unit.isSummoned()) {
            metrics.summonedQueenTurns += 1;
            return;
        }
        if (sideForUnit(unit) === plan.protectorSide && !unit.isSummoned() && wardUnit?.getId() === unit.getId()) {
            const wardIntent = buildV08BacklineWardIntent(unit, context);
            if (wardIntent) {
                metrics.wardConstrainedTurns += 1;
                const distanceBefore = footprintDistance(wardIntent.protector.getCells(), unit.getCells());
                pendingWards.set(unit.getId(), {
                    unit,
                    context,
                    intent: wardIntent,
                    distanceBefore,
                    coveredBefore: distanceBefore <= 1,
                });
            }
        }
        if (sideForUnit(unit) !== plan.protectorSide || unit.isSummoned() || unit.getName() !== nativeProtectorName) {
            return;
        }
        metrics.protectorTurns += 1;
        const liveFlyers = context.unitsHolder
            .getAllEnemyUnits(unit.getTeam())
            .filter((enemy) => !enemy.isDead() && enemy.canFly());
        const wardActive = !!wardUnit && !wardUnit.isDead() && isV08BacklineProtectionBeneficiary(wardUnit);
        const finishActive = v08DominantFinishState(
            context.unitsHolder,
            unit.getTeam(),
            context.fightProperties?.getCurrentLap() ?? 0,
        ).active;
        const intent = buildV08BacklineProtectorIntent(unit, context);
        if (intent) metrics.constrainedTurns += 1;
        if (unit.getName() === "Arachna Queen" && liveFlyers.length === 0) {
            metrics.queenNoFlyerReleaseTurns += 1;
            if (intent) metrics.queenNoFlyerConstraintViolations += 1;
        }
        if (!intent && wardUnit && !wardUnit.isDead() && !wardActive) {
            metrics.depletedWardReleaseTurns += 1;
        }
        if (!intent && wardUnit?.isDead()) metrics.deadWardReleaseTurns += 1;
        if (!intent && wardActive && finishActive) metrics.dominantFinishReleaseTurns += 1;
        const trackedWard = intent?.ward ?? wardUnit;
        const distanceBefore = trackedWard ? footprintDistance(unit.getCells(), trackedWard.getCells()) : Infinity;
        const coveredBefore = distanceBefore <= 1;
        if (intent) {
            metrics.exactCoverageOpportunities += 1;
            metrics.coveredAtDecision += Number(coveredBefore);
        }
        pending.set(unit.getId(), {
            unit,
            context,
            intent,
            ward: trackedWard,
            distanceBefore,
            coveredBefore,
            catchUpAvailable: !!intent && !coveredBefore && v08BacklineProtectorHasCatchUpRoute(intent, unit, context),
            localDiverIds: new Set(
                intent
                    ? context.unitsHolder
                          .getAllEnemyUnits(unit.getTeam())
                          .filter(
                              (enemy) =>
                                  !enemy.isDead() && footprintDistance(enemy.getCells(), intent.ward.getCells()) <= 1,
                          )
                          .map((enemy) => enemy.getId())
                    : [],
            ),
            coverageRange: intent ? v08BacklineProtectorCoverageRange(unit, context) : 0,
        });
    };

    const observeExecution = (observation: ITurnExecutionObservation): void => {
        for (const event of observation.events) {
            if (event.type === "unit_summoned" && event.unitName === "Arachna Queen") {
                metrics.summonedQueensCreated += 1;
            }
        }
        if (wardUnit && observation.unitId === wardUnit.getId()) {
            metrics.wardTurns += 1;
            const types = completedActionTypes(observation);
            metrics.wardAttacks += types.filter(
                (type) => type === "melee_attack" || type === "range_attack" || type === "area_throw_attack",
            ).length;
            metrics.wardCasts += types.filter((type) => type === "cast_spell").length;
            metrics.wardDamage += attackDamage(observation);
            metrics.wardHealing += healingOutput(observation);
        }
        const wardTurn = pendingWards.get(observation.unitId);
        if (wardTurn) {
            pendingWards.delete(observation.unitId);
            const distanceAfter = footprintDistance(wardTurn.intent.protector.getCells(), wardTurn.unit.getCells());
            const coveredAfter = distanceAfter <= 1;
            const allowed = preservesV08BacklineWardIntent(
                wardTurn.intent,
                wardTurn.unit,
                wardTurn.context,
                observation.chosenDecision,
            );
            const guardBreak =
                !allowed &&
                ((wardTurn.coveredBefore && !coveredAfter) ||
                    (!wardTurn.coveredBefore && distanceAfter > wardTurn.distanceBefore));
            if (guardBreak) {
                metrics.wardGuardBreakingFinalActions += 1;
                if (
                    observation.chosenDecision.some(
                        (action) => action.type === "move_unit" || action.type === "melee_attack",
                    )
                ) {
                    metrics.wardRushViolations += 1;
                }
            }
        }
        const turn = pending.get(observation.unitId);
        if (!turn) return;
        pending.delete(observation.unitId);
        const types = completedActionTypes(observation);
        metrics.usefulProtectorAttacks += types.filter(
            (type) => type === "melee_attack" || type === "range_attack" || type === "area_throw_attack",
        ).length;
        metrics.usefulProtectorCasts += types.filter((type) => type === "cast_spell").length;
        metrics.protectorMoves += types.filter((type) => type === "move_unit").length;
        metrics.protectorWaits += types.filter((type) => type === "wait_turn").length;
        metrics.protectorDefends += types.filter((type) => type === "defend_turn").length;
        if (!turn.intent || !turn.ward || turn.ward.isDead()) return;
        const distanceAfter = footprintDistance(turn.unit.getCells(), turn.ward.getCells());
        const coveredAfter = distanceAfter <= 1;
        metrics.coveredAfterAction += Number(coveredAfter);
        const chosenTargetId = [...observation.chosenDecision]
            .reverse()
            .find(
                (action): action is Extract<GameAction, { type: "melee_attack" | "range_attack" }> =>
                    action.type === "melee_attack" || action.type === "range_attack",
            )?.targetId;
        const localQueenIntercept =
            turn.intent.kind === "arachna_queen" &&
            !!chosenTargetId &&
            turn.localDiverIds.has(chosenTargetId) &&
            distanceAfter <= turn.coverageRange + 1;
        const helperAllows =
            localQueenIntercept ||
            preservesV08BacklineProtectorIntent(turn.intent, turn.unit, turn.context, observation.chosenDecision);
        const guardBreak =
            !helperAllows &&
            ((turn.coveredBefore && !coveredAfter) ||
                (!turn.coveredBefore &&
                    (distanceAfter > turn.distanceBefore ||
                        (distanceAfter >= turn.distanceBefore && turn.catchUpAvailable))));
        if (guardBreak) metrics.guardBreakingFinalActions += 1;
        if (
            !coveredAfter &&
            !turn.coveredBefore &&
            distanceAfter >= turn.distanceBefore &&
            !turn.catchUpAvailable &&
            !guardBreak
        ) {
            metrics.blockedCatchUpTurns += 1;
        }
        const movedOrCharged = observation.chosenDecision.some(
            (action) => action.type === "move_unit" || action.type === "melee_attack",
        );
        if (movedOrCharged && guardBreak) metrics.rushViolations += 1;
        if (plan.protector === "abomination" && !coveredAfter) {
            metrics.abominationCoverageGapTurns += 1;
            if (guardBreak) metrics.abominationExactRangeViolations += 1;
        }
    };

    try {
        const setup = liveTwinSetup();
        const config: IMatchConfig = {
            greenVersion: "v0.8",
            redVersion: "v0.8",
            roster: plan.greenRoster,
            redRoster: plan.redRoster,
            seed: plan.seed,
            maxLaps: options.maxLaps,
            gridType: plan.mapType,
            greenDoctrine: setup.doctrine,
            redDoctrine: setup.doctrine,
            greenAugments: setup.augments,
            redAugments: setup.augments,
            placementAugmentTiming: "setup-before-placement",
            greenPublicOpponentCreatures: plan.greenPublicOpponentCreatures,
            redPublicOpponentCreatures: plan.redPublicOpponentCreatures,
            decisionObserver: observeDecision,
            turnExecutionObserver: observeExecution,
        };
        const result = withV08DecisionTiming(
            {
                all: metrics.allDecisionLatencyMicros,
                protector: metrics.protectorDecisionLatencyMicros,
                protectorSide: plan.protectorSide,
            },
            () => runMatch(config),
        );
        metrics.wardSurvived = Number(!!wardUnit && !wardUnit.isDead());
        const placements = plan.protectorSide === "green" ? result.placements.green : result.placements.red;
        const protectorPlacement = nativeProtectorName
            ? placements.find((entry) => entry.creatureName === nativeProtectorName)
            : undefined;
        const wardPlacement = placements.find((entry) => entry.creatureName === plan.wardCreatureName);
        metrics.nativeProtectorPlacements = Number(!!protectorPlacement);
        if (protectorPlacement && wardPlacement) {
            metrics.initialExactCoverage = Number(
                footprintDistance(
                    placementCells(protectorPlacement.cell, protectorPlacement.size),
                    placementCells(wardPlacement.cell, wardPlacement.size),
                ) <= 1,
            );
        }
        const protectedSideRejectedActions =
            plan.protectorSide === "green" ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0);
        return {
            schema: V08_PROTECTOR_STRESS_SCHEMA,
            game,
            seed: plan.seed,
            mapType: plan.mapType,
            matrixCycle: plan.matrixCycle,
            matrixCombination: plan.matrixCombination,
            protector: plan.protector,
            ward: plan.ward,
            threat: plan.threat,
            protectorSide: plan.protectorSide,
            selectedProtectorName: plan.selectedProtectorName,
            queenDraftExpected: plan.queenDraftExpected,
            queenDrafted: plan.queenDrafted,
            draftMismatch: Number(plan.queenDraftExpected !== plan.queenDrafted),
            winner: result.winner,
            endReason: result.endReason,
            laps: result.laps,
            rejectedActions: (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0),
            protectedSideRejectedActions,
            rejectionsByCause: resultRejectionCauses(result),
            metrics,
        };
    } catch (error) {
        return {
            schema: V08_PROTECTOR_STRESS_SCHEMA,
            game,
            seed: plan.seed,
            mapType: plan.mapType,
            matrixCycle: plan.matrixCycle,
            matrixCombination: plan.matrixCombination,
            protector: plan.protector,
            ward: plan.ward,
            threat: plan.threat,
            protectorSide: plan.protectorSide,
            selectedProtectorName: plan.selectedProtectorName,
            queenDraftExpected: plan.queenDraftExpected,
            queenDrafted: plan.queenDrafted,
            draftMismatch: Number(plan.queenDraftExpected !== plan.queenDrafted),
            winner: "crash",
            endReason: "crash",
            laps: 0,
            rejectedActions: 0,
            protectedSideRejectedActions: 0,
            rejectionsByCause: {},
            metrics,
            crash: error instanceof Error ? (error.stack ?? error.message) : String(error),
        };
    }
}

const METRIC_SCALARS = [
    "protectorTurns",
    "constrainedTurns",
    "summonedQueenTurns",
    "summonedQueensCreated",
    "queenNoFlyerReleaseTurns",
    "queenNoFlyerConstraintViolations",
    "depletedWardReleaseTurns",
    "deadWardReleaseTurns",
    "dominantFinishReleaseTurns",
    "coveredAtDecision",
    "coveredAfterAction",
    "exactCoverageOpportunities",
    "guardBreakingFinalActions",
    "rushViolations",
    "blockedCatchUpTurns",
    "abominationExactRangeViolations",
    "abominationCoverageGapTurns",
    "wardConstrainedTurns",
    "wardGuardBreakingFinalActions",
    "wardRushViolations",
    "usefulProtectorAttacks",
    "usefulProtectorCasts",
    "protectorMoves",
    "protectorWaits",
    "protectorDefends",
    "wardTurns",
    "wardAttacks",
    "wardCasts",
    "wardDamage",
    "wardHealing",
    "wardSurvived",
    "nativeProtectorPlacements",
    "initialExactCoverage",
] as const satisfies readonly (keyof IV08ProtectorStressMetrics)[];

export const percentileMs = (micros: readonly number[], quantile: number): number | null => {
    if (!micros.length) return null;
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
        throw new RangeError(`Quantile must be within [0,1], got ${quantile}`);
    }
    const values = [...micros].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(quantile * values.length) - 1);
    return Number((values[index] / 1_000).toFixed(3));
};

export interface IV08ProtectorStressSummary {
    schema: typeof V08_PROTECTOR_STRESS_SCHEMA;
    options: IV08ProtectorStressOptions;
    games: number;
    crashes: number;
    endReasons: Record<string, number>;
    rejectedActions: number;
    protectedSideRejectedActions: number;
    rejectionsByCause: Record<string, number>;
    draftMismatches: number;
    metrics: Omit<IV08ProtectorStressMetrics, "allDecisionLatencyMicros" | "protectorDecisionLatencyMicros">;
    decisionLatencyMs: {
        samples: number;
        p50: number | null;
        p95: number | null;
        p99: number | null;
        protectorSamples: number;
        protectorP50: number | null;
        protectorP95: number | null;
        protectorP99: number | null;
    };
    coverageUptime: {
        atDecision: number | null;
        afterAction: number | null;
        initialPlacement: number | null;
        wardSurvival: number | null;
    };
    coverage: {
        uniqueCells: number;
        expectedCells: number;
        completeMatrix: boolean;
        gamesByProtector: Record<string, number>;
        gamesByWard: Record<string, number>;
        gamesByThreat: Record<string, number>;
        gamesByMap: Record<string, number>;
        gamesBySeat: Record<string, number>;
    };
    gates: {
        pass: boolean;
        failed: string[];
        noCrashes: boolean;
        noStuck: boolean;
        noTurnCaps: boolean;
        zeroRejections: boolean;
        draftDiscipline: boolean;
        noQueenNoFlyerConstraint: boolean;
        noGuardBreaks: boolean;
        noRushViolations: boolean;
        noWardGuardBreaks: boolean;
        noWardRushViolations: boolean;
        exactAbominationRange: boolean;
    };
    failureSamples: Array<{
        game: number;
        protector: V08ProtectorStressProtector;
        ward: V08ProtectorStressWard;
        threat: V08ProtectorStressThreat;
        mapType: number;
        protectorSide: Side;
        issue: string;
    }>;
}

const stressCellKey = (record: IV08ProtectorStressRecord): string =>
    [record.protector, record.ward, record.threat, record.mapType, record.protectorSide].join(":");

const ratio = (numerator: number, denominator: number): number | null =>
    denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;

export function summarizeV08ProtectorStress(
    options: IV08ProtectorStressOptions,
    records: readonly IV08ProtectorStressRecord[],
): IV08ProtectorStressSummary {
    const metrics = emptyV08ProtectorStressMetrics();
    const endReasons: Record<string, number> = {};
    const rejectionsByCause: Record<string, number> = {};
    const dimensions = {
        gamesByProtector: {} as Record<string, number>,
        gamesByWard: {} as Record<string, number>,
        gamesByThreat: {} as Record<string, number>,
        gamesByMap: {} as Record<string, number>,
        gamesBySeat: {} as Record<string, number>,
    };
    const cells = new Set<string>();
    const failureSamples: IV08ProtectorStressSummary["failureSamples"] = [];
    let crashes = 0;
    let rejectedActions = 0;
    let protectedSideRejectedActions = 0;
    let draftMismatches = 0;
    for (const record of records) {
        cells.add(stressCellKey(record));
        increment(endReasons, record.endReason);
        increment(dimensions.gamesByProtector, record.protector);
        increment(dimensions.gamesByWard, record.ward);
        increment(dimensions.gamesByThreat, record.threat);
        increment(dimensions.gamesByMap, String(record.mapType));
        increment(dimensions.gamesBySeat, record.protectorSide);
        crashes += Number(record.endReason === "crash");
        rejectedActions += record.rejectedActions;
        protectedSideRejectedActions += record.protectedSideRejectedActions;
        draftMismatches += record.draftMismatch;
        for (const [cause, count] of Object.entries(record.rejectionsByCause)) {
            increment(rejectionsByCause, cause, count);
        }
        for (const key of METRIC_SCALARS) metrics[key] += record.metrics[key];
        metrics.allDecisionLatencyMicros.push(...record.metrics.allDecisionLatencyMicros);
        metrics.protectorDecisionLatencyMicros.push(...record.metrics.protectorDecisionLatencyMicros);
        const issues = [
            record.crash ? `crash: ${record.crash.split("\n")[0]}` : "",
            record.rejectedActions ? `${record.rejectedActions} rejected action(s)` : "",
            record.draftMismatch ? "Queen draft eligibility mismatch" : "",
            record.metrics.guardBreakingFinalActions
                ? `${record.metrics.guardBreakingFinalActions} guard break(s)`
                : "",
            record.metrics.rushViolations ? `${record.metrics.rushViolations} rush violation(s)` : "",
            record.metrics.wardGuardBreakingFinalActions
                ? `${record.metrics.wardGuardBreakingFinalActions} ward guard break(s)`
                : "",
            record.metrics.wardRushViolations ? `${record.metrics.wardRushViolations} ward rush violation(s)` : "",
            record.metrics.abominationExactRangeViolations
                ? `${record.metrics.abominationExactRangeViolations} Abomination range violation(s)`
                : "",
        ].filter(Boolean);
        if (issues.length && failureSamples.length < 40) {
            failureSamples.push({
                game: record.game,
                protector: record.protector,
                ward: record.ward,
                threat: record.threat,
                mapType: record.mapType,
                protectorSide: record.protectorSide,
                issue: issues.join("; "),
            });
        }
    }
    const publicMetrics = Object.fromEntries(METRIC_SCALARS.map((key) => [key, metrics[key]])) as unknown as Omit<
        IV08ProtectorStressMetrics,
        "allDecisionLatencyMicros" | "protectorDecisionLatencyMicros"
    >;
    const gateValues = {
        noCrashes: crashes === 0,
        noStuck: (endReasons.stuck ?? 0) === 0,
        noTurnCaps: (endReasons.turn_cap ?? 0) === 0,
        zeroRejections: rejectedActions === 0,
        draftDiscipline: draftMismatches === 0,
        noQueenNoFlyerConstraint: metrics.queenNoFlyerConstraintViolations === 0,
        noGuardBreaks: metrics.guardBreakingFinalActions === 0,
        noRushViolations: metrics.rushViolations === 0,
        noWardGuardBreaks: metrics.wardGuardBreakingFinalActions === 0,
        noWardRushViolations: metrics.wardRushViolations === 0,
        exactAbominationRange: metrics.abominationExactRangeViolations === 0,
    };
    const failed = Object.entries(gateValues)
        .filter(([, pass]) => !pass)
        .map(([name]) => name);
    return {
        schema: V08_PROTECTOR_STRESS_SCHEMA,
        options,
        games: records.length,
        crashes,
        endReasons,
        rejectedActions,
        protectedSideRejectedActions,
        rejectionsByCause,
        draftMismatches,
        metrics: publicMetrics,
        decisionLatencyMs: {
            samples: metrics.allDecisionLatencyMicros.length,
            p50: percentileMs(metrics.allDecisionLatencyMicros, 0.5),
            p95: percentileMs(metrics.allDecisionLatencyMicros, 0.95),
            p99: percentileMs(metrics.allDecisionLatencyMicros, 0.99),
            protectorSamples: metrics.protectorDecisionLatencyMicros.length,
            protectorP50: percentileMs(metrics.protectorDecisionLatencyMicros, 0.5),
            protectorP95: percentileMs(metrics.protectorDecisionLatencyMicros, 0.95),
            protectorP99: percentileMs(metrics.protectorDecisionLatencyMicros, 0.99),
        },
        coverageUptime: {
            atDecision: ratio(metrics.coveredAtDecision, metrics.exactCoverageOpportunities),
            afterAction: ratio(metrics.coveredAfterAction, metrics.exactCoverageOpportunities),
            initialPlacement: ratio(metrics.initialExactCoverage, metrics.nativeProtectorPlacements),
            wardSurvival: ratio(metrics.wardSurvived, records.length - crashes),
        },
        coverage: {
            uniqueCells: cells.size,
            expectedCells: 144,
            completeMatrix: cells.size === 144,
            ...dimensions,
        },
        gates: { pass: failed.length === 0, failed, ...gateValues },
        failureSamples,
    };
}

interface IWorkerMessage {
    type: "ready" | "result" | "fatal";
    record?: IV08ProtectorStressRecord;
    error?: string;
}

async function runProtectorStressPool(options: IV08ProtectorStressOptions): Promise<IV08ProtectorStressRecord[]> {
    const poolSize = Math.max(1, Math.min(options.concurrency, options.games));
    return new Promise<IV08ProtectorStressRecord[]>((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        const records: IV08ProtectorStressRecord[] = [];
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
            if (dispatched >= options.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched });
            dispatched += 1;
        };
        const workerUrl = new URL("./v0_8_protector_stress_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(workerUrl, { workerData: { options } });
            workers.push(worker);
            worker.on("message", (message: IWorkerMessage) => {
                if (settled) return;
                if (message.type === "fatal") {
                    fail(new Error(message.error ?? "Protector stress worker failed"));
                    return;
                }
                if (message.type === "ready") {
                    dispatch(worker);
                    return;
                }
                if (!message.record) {
                    fail(new Error("Protector stress worker returned no record"));
                    return;
                }
                records.push(message.record);
                completed += 1;
                if (completed % 100 === 0 || completed === options.games) {
                    console.error(`  ${completed}/${options.games} protector games...`);
                }
                if (completed >= options.games) {
                    settled = true;
                    cleanup();
                    records.sort((left, right) => left.game - right.game);
                    resolvePromise(records);
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`Protector stress worker exited ${code}`));
            });
        }
    });
}

const positiveInteger = (value: string, flag: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    }
    return parsed;
};

async function cliMain(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: String(V08_PROTECTOR_STRESS_DEFAULT_GAMES) },
            seed: { type: "string", default: String(V08_PROTECTOR_STRESS_DEFAULT_SEED) },
            concurrency: { type: "string", default: String(V08_PROTECTOR_STRESS_DEFAULT_CONCURRENCY) },
            output: { type: "string", default: "" },
        },
    });
    const games = positiveInteger(values.games!, "--games");
    if (games % 2 !== 0) throw new Error(`--games must be even so every scenario swaps seats; got ${games}`);
    const options: IV08ProtectorStressOptions = {
        games,
        baseSeed: positiveInteger(values.seed!, "--seed"),
        concurrency: Math.min(
            positiveInteger(values.concurrency!, "--concurrency"),
            Math.max(1, availableParallelism()),
        ),
        maxLaps: 60,
    };
    const outputPath = values.output
        ? resolve(process.cwd(), values.output)
        : resolve(
              process.cwd(),
              "sim-out",
              "v0.8-protector-stress",
              `v0.8-protector-stress-${options.games}-seed${options.baseSeed}.json`,
          );
    process.env.SIM_NO_ACTIONS = "1";
    console.error(
        `v0.8+A19 protector stress: ${options.games} games, seed ${options.baseSeed}, concurrency ${options.concurrency}`,
    );
    const started = performance.now();
    const records = await runProtectorStressPool(options);
    const summary = summarizeV08ProtectorStress(options, records);
    const report = {
        schema: V08_PROTECTOR_STRESS_SCHEMA,
        generatedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        gamesPerSecond: Number((records.length / Math.max(0.001, (performance.now() - started) / 1_000)).toFixed(3)),
        command:
            `bun src/simulation/v0_8_protector_stress.ts --games ${options.games} ` +
            `--seed ${options.baseSeed} --concurrency ${options.concurrency} --output ${outputPath}`,
        matrix: {
            protectors: V08_PROTECTOR_STRESS_PROTECTORS,
            wards: V08_PROTECTOR_STRESS_WARDS,
            threats: V08_PROTECTOR_STRESS_THREATS,
            maps: V08_PROTECTOR_STRESS_MAPS,
            seats: ["green", "red"],
            gamesForOneCompleteMatrix: V08_PROTECTOR_STRESS_MATRIX_GAMES,
        },
        summary,
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        `${summary.gates.pass ? "PASS" : "FAIL"}: ${summary.games} games; ` +
            `${summary.rejectedActions} rejections; ${summary.crashes} crashes; ` +
            `${summary.metrics.guardBreakingFinalActions} guard breaks; ` +
            `${summary.metrics.rushViolations} rushes; decision p95 ${summary.decisionLatencyMs.p95 ?? "n/a"} ms`,
    );
    if (summary.gates.failed.length) console.log(`failed gates: ${summary.gates.failed.join(", ")}`);
    console.log(`report -> ${outputPath}`);
    if (!summary.gates.pass) process.exitCode = 1;
}

if ((import.meta as unknown as { main?: boolean }).main) {
    cliMain().catch((error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : error);
        process.exit(1);
    });
}
