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

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { AI_VERSIONS } from "../ai";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    buildRoster,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
    type StackAmountMode,
} from "./army";
import {
    GREEN_TEAM,
    runMatch,
    type IDecisionObservation,
    type IMatchConfig,
    type ITurnExecutionObservation,
    type Side,
} from "./battle_engine";
import { liveTwinSetup } from "./livetwin";

/**
 * Research-only coverage panel for every playable creature added after the A13 source boundary.
 *
 * The list is deliberately explicit and frozen. A source diff or a changing random roster must never silently
 * redefine this panel. Every target is compared with a fixed, pre-A13 creature of the same level.
 */
export const V08_POST_A13_COVERAGE_TARGETS = Object.freeze([
    Object.freeze({ unit: "Mermaid", level: 1, controlUnit: "Peasant" }),
    Object.freeze({ unit: "Dryad", level: 1, controlUnit: "Peasant" }),
    Object.freeze({ unit: "Blacksmith", level: 1, controlUnit: "Peasant" }),
    Object.freeze({ unit: "Ash Moth", level: 1, controlUnit: "Peasant" }),
    Object.freeze({ unit: "Zena", level: 3, controlUnit: "Crusader" }),
    Object.freeze({ unit: "Wyvern", level: 2, controlUnit: "Pikeman" }),
    Object.freeze({ unit: "Trent", level: 2, controlUnit: "Pikeman" }),
    Object.freeze({ unit: "Manticore", level: 2, controlUnit: "Pikeman" }),
    Object.freeze({ unit: "Monk", level: 3, controlUnit: "Crusader" }),
    Object.freeze({ unit: "Battle Mage", level: 2, controlUnit: "Pikeman" }),
    Object.freeze({ unit: "Nightmare", level: 3, controlUnit: "Crusader" }),
    Object.freeze({ unit: "Magic Dragon", level: 4, controlUnit: "Black Dragon" }),
] as const);

export type V08PostA13CoverageTarget = (typeof V08_POST_A13_COVERAGE_TARGETS)[number];
export type V08PostA13CoverageUnit = V08PostA13CoverageTarget["unit"];
export type V08PostA13CoverageLevel = V08PostA13CoverageTarget["level"];
export type V08PostA13ControlUnit = V08PostA13CoverageTarget["controlUnit"];
export type V08PostA13Owner = "candidate" | "opponent";

export const V08_POST_A13_COVERAGE_UNITS: readonly V08PostA13CoverageUnit[] = Object.freeze(
    V08_POST_A13_COVERAGE_TARGETS.map(({ unit }) => unit),
);

/** Water is disabled in the live map selector, so it is intentionally absent from this rotation. */
export const V08_POST_A13_LIVE_MAPS: readonly number[] = Object.freeze([
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
]);

export const V08_POST_A13_COVERAGE_SCHEMA = "hoc.v0_8_post_a13_coverage.v1";

export interface IV08PostA13CoverageLane {
    unit: V08PostA13CoverageUnit;
    level: V08PostA13CoverageLevel;
    controlUnit: V08PostA13ControlUnit;
    owner: V08PostA13Owner;
}

export const V08_POST_A13_COVERAGE_LANES: readonly IV08PostA13CoverageLane[] = Object.freeze(
    V08_POST_A13_COVERAGE_TARGETS.flatMap((target) => [
        Object.freeze({ ...target, owner: "candidate" as const }),
        Object.freeze({ ...target, owner: "opponent" as const }),
    ]),
);

export interface IV08PostA13CoverageOptions {
    candidateVersion: string;
    opponentVersion: string;
    /** One pair is two games with identical armies/randomness and candidate/opponent physical seats swapped. */
    pairsPerLane: number;
    baseSeed: number;
    targetUnits?: readonly V08PostA13CoverageUnit[];
    /** Defaults to the live exp-budget stack sizing. */
    amountMode?: StackAmountMode;
    /** Defaults true: both sides receive the shipped SEE_NONE + Armor/Might/Sniper setup. */
    liveSetup?: boolean;
}

export interface IV08PostA13ActionAudit {
    appearances: number;
    actingTurns: number;
    completedActions: number;
    completedStrategyActions: number;
    completedRecoveryActions: number;
    rejectedStrategyActions: number;
    rejectedRecoveryActions: number;
    productiveActions: number;
    turnsWithoutProductiveAction: number;
    rawEndTurnDecisions: number;
    actionTypes: Record<string, number>;
    rejectionReasons: Record<string, number>;
    /** Target decisions observed before search/recovery. */
    spellDecisionTurns: number;
    /** Target decisions on which at least one spell still had a charge. */
    activeSpellTurns: number;
    /** Sum of remaining charges across all active spells at each observed target decision. */
    activeSpellChargesObserved: number;
    /** Number of target decisions on which each spell was still active. */
    activeSpellsObserved: Record<string, number>;
    /** Remaining charges for each spell, summed over target decision observations. */
    activeSpellChargesByName: Record<string, number>;
    /** Successfully completed casts by spell name. */
    spellCasts: Record<string, number>;
}

export interface IV08PostA13CoverageRecord {
    schema: typeof V08_POST_A13_COVERAGE_SCHEMA;
    game: number;
    cycle: number;
    seed: number;
    mapType: number;
    lane: IV08PostA13CoverageLane;
    candidateVersion: string;
    opponentVersion: string;
    candidateSide: Side;
    targetSide: Side;
    winner: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck";
    rejectedCandidate: number;
    rejectedOpponent: number;
    target: IV08PostA13ActionAudit;
    armageddon: {
        reached: boolean;
        waves: number;
        decided: boolean;
        unitsKilled: number;
    };
}

export interface IV08PostA13CoverageCellSummary extends IV08PostA13ActionAudit {
    lane: IV08PostA13CoverageLane;
    games: number;
    candidateGreenGames: number;
    candidateRedGames: number;
    mapCensus: IV08PostA13CoverageMapCensus[];
    candidateWins: number;
    opponentWins: number;
    draws: number;
    rejectedCandidate: number;
    rejectedOpponent: number;
    armageddonReached: number;
    armageddonDecided: number;
}

export interface IV08PostA13CoverageMapCensus {
    mapType: number;
    games: number;
    candidateGreenGames: number;
    candidateRedGames: number;
}

export interface IV08PostA13CoverageSummary {
    schema: typeof V08_POST_A13_COVERAGE_SCHEMA;
    candidateVersion: string;
    opponentVersion: string;
    baseSeed: number;
    pairsPerLane: number;
    maps: readonly number[];
    /** Hash of the exact game/lane/seed/map/seat schedule, independent of worker completion order. */
    planSha256: string;
    games: number;
    lanes: IV08PostA13CoverageCellSummary[];
}

export interface IV08PostA13ForcedRosters {
    targetIndex: number;
    targetRoster: IArmyUnitSpec[];
    controlRoster: IArmyUnitSpec[];
}

export interface IV08PostA13CoverageGamePlan {
    game: number;
    cycle: number;
    seed: number;
    mapType: number;
    lane: IV08PostA13CoverageLane;
    candidateSide: Side;
    targetSide: Side;
    targetIndex: number;
    greenRoster: IArmyUnitSpec[];
    redRoster: IArmyUnitSpec[];
}

const POST_A13_UNITS: ReadonlySet<string> = new Set(V08_POST_A13_COVERAGE_UNITS);
const PRODUCTIVE_ACTIONS: ReadonlySet<GameAction["type"]> = new Set([
    "move_unit",
    "melee_attack",
    "range_attack",
    "cast_spell",
]);

const increment = (counts: Record<string, number>, key: string, amount = 1): void => {
    counts[key] = (counts[key] ?? 0) + amount;
};

export const createV08PostA13ActionAudit = (): IV08PostA13ActionAudit => ({
    appearances: 0,
    actingTurns: 0,
    completedActions: 0,
    completedStrategyActions: 0,
    completedRecoveryActions: 0,
    rejectedStrategyActions: 0,
    rejectedRecoveryActions: 0,
    productiveActions: 0,
    turnsWithoutProductiveAction: 0,
    rawEndTurnDecisions: 0,
    actionTypes: {},
    rejectionReasons: {},
    spellDecisionTurns: 0,
    activeSpellTurns: 0,
    activeSpellChargesObserved: 0,
    activeSpellsObserved: {},
    activeSpellChargesByName: {},
    spellCasts: {},
});

function targetDefinition(unit: V08PostA13CoverageUnit): V08PostA13CoverageTarget {
    const target = V08_POST_A13_COVERAGE_TARGETS.find((candidate) => candidate.unit === unit);
    if (!target) {
        throw new Error(`Unknown post-A13 coverage unit: ${unit}`);
    }
    return target;
}

function creatureSpec(
    creatureName: V08PostA13CoverageUnit | V08PostA13ControlUnit,
    level: V08PostA13CoverageLevel,
    amountMode: StackAmountMode,
): IArmyUnitSpec {
    const entry = creaturesByLevel(level).find((candidate) => candidate.creatureName === creatureName);
    if (!entry) {
        throw new Error(`Enabled level-${level} coverage creature not found: ${creatureName}`);
    }
    return {
        faction: entry.faction,
        creatureName: entry.creatureName,
        level: entry.level,
        size: entry.size,
        amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, amountMode),
    };
}

function controlForLevel(level: number): V08PostA13ControlUnit {
    if (level === 1) return "Peasant";
    if (level === 2) return "Pikeman";
    if (level === 3) return "Crusader";
    if (level === 4) return "Black Dragon";
    throw new Error(`Post-A13 coverage does not support roster level ${level}`);
}

/**
 * Build a one-variable target/control pair.
 *
 * Every incidental post-A13 random pick is first replaced by its same-level pre-A13 control. The first slot
 * at the target's level is then fixed to the requested target in one roster and its control in the other.
 * Consequently exactly one post-A13 stack exists across the two rosters, and every other slot is identical.
 */
export function forceV08PostA13CoverageUnit(
    roster: readonly IArmyUnitSpec[],
    unit: V08PostA13CoverageUnit,
    amountMode: StackAmountMode = "expBudget",
): IV08PostA13ForcedRosters {
    const target = targetDefinition(unit);
    const sanitized = roster.map((spec) =>
        POST_A13_UNITS.has(spec.creatureName)
            ? creatureSpec(controlForLevel(spec.level), spec.level as V08PostA13CoverageLevel, amountMode)
            : { ...spec },
    );
    const targetIndex = sanitized.findIndex((spec) => spec.level === target.level);
    if (targetIndex < 0) {
        throw new Error(`Post-A13 coverage roster has no level-${target.level} slot for ${target.unit}`);
    }
    const controlRoster = sanitized.map((spec) => ({ ...spec }));
    controlRoster[targetIndex] = creatureSpec(target.controlUnit, target.level, amountMode);
    const targetRoster = controlRoster.map((spec) => ({ ...spec }));
    targetRoster[targetIndex] = creatureSpec(target.unit, target.level, amountMode);

    const present = [...targetRoster, ...controlRoster]
        .filter((spec) => POST_A13_UNITS.has(spec.creatureName))
        .map((spec) => spec.creatureName);
    if (present.length !== 1 || present[0] !== target.unit) {
        throw new Error(`Expected exactly one ${target.unit} post-A13 stack; found ${present.join(", ") || "none"}`);
    }
    return { targetIndex, targetRoster, controlRoster };
}

export function getV08PostA13CoverageGameCount(options: IV08PostA13CoverageOptions): number {
    if (!Number.isSafeInteger(options.pairsPerLane) || options.pairsPerLane < 1) {
        throw new Error("pairsPerLane must be a positive integer");
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0 || options.baseSeed > 0xffffffff) {
        throw new Error("baseSeed must be a uint32 integer");
    }
    return options.pairsPerLane * getV08PostA13CoverageLanes(options).length * 2;
}

export function getV08PostA13CoverageLanes(options: IV08PostA13CoverageOptions): readonly IV08PostA13CoverageLane[] {
    if (options.targetUnits === undefined) {
        return V08_POST_A13_COVERAGE_LANES;
    }
    if (!options.targetUnits.length) {
        throw new Error("targetUnits must include at least one post-A13 unit");
    }
    const requested = new Set(options.targetUnits);
    if (requested.size !== options.targetUnits.length) {
        throw new Error("targetUnits must not repeat a post-A13 unit");
    }
    const known = new Set<V08PostA13CoverageUnit>(V08_POST_A13_COVERAGE_UNITS);
    for (const unit of requested) {
        if (!known.has(unit)) {
            throw new Error(`Unknown post-A13 coverage unit: ${unit}`);
        }
    }
    return V08_POST_A13_COVERAGE_LANES.filter((lane) => requested.has(lane.unit));
}

interface IV08PostA13CoverageScheduleCell {
    game: number;
    cycle: number;
    seed: number;
    mapType: number;
    lane: IV08PostA13CoverageLane;
    candidateSide: Side;
    targetSide: Side;
}

function scheduleV08PostA13CoverageGame(
    options: IV08PostA13CoverageOptions,
    game: number,
): IV08PostA13CoverageScheduleCell {
    const totalGames = getV08PostA13CoverageGameCount(options);
    if (!Number.isSafeInteger(game) || game < 0 || game >= totalGames) {
        throw new Error(`Coverage game index ${game} is outside [0, ${totalGames})`);
    }
    const pair = Math.floor(game / 2);
    const lanes = getV08PostA13CoverageLanes(options);
    const lane = lanes[pair % lanes.length]!;
    const cycle = Math.floor(pair / lanes.length);
    const seed = (options.baseSeed + cycle * 0x9e3779b1) >>> 0;
    const candidateSide: Side = game % 2 === 0 ? "green" : "red";
    const targetSide = lane.owner === "candidate" ? candidateSide : candidateSide === "green" ? "red" : "green";
    return {
        game,
        cycle,
        seed,
        mapType: V08_POST_A13_LIVE_MAPS[cycle % V08_POST_A13_LIVE_MAPS.length],
        lane,
        candidateSide,
        targetSide,
    };
}

const scheduleIdentity = ({
    game,
    cycle,
    seed,
    mapType,
    lane,
    candidateSide,
    targetSide,
}: IV08PostA13CoverageScheduleCell): IV08PostA13CoverageScheduleCell => ({
    game,
    cycle,
    seed,
    mapType,
    lane,
    candidateSide,
    targetSide,
});

/** Fingerprint the complete deterministic panel schedule so persisted evidence proves maps and physical seats. */
export function fingerprintV08PostA13CoveragePlan(options: IV08PostA13CoverageOptions): string {
    const total = getV08PostA13CoverageGameCount(options);
    const schedule = Array.from({ length: total }, (_, game) =>
        scheduleIdentity(scheduleV08PostA13CoverageGame(options, game)),
    );
    return createHash("sha256").update(JSON.stringify(schedule)).digest("hex");
}

/**
 * Derive a game entirely from its index, so concurrency and worker completion order cannot alter the panel.
 * Adjacent games are physical-seat swaps. A complete 24-lane cycle advances both the seed and live map.
 */
export function planV08PostA13CoverageGame(
    options: IV08PostA13CoverageOptions,
    game: number,
): IV08PostA13CoverageGamePlan {
    const schedule = scheduleV08PostA13CoverageGame(options, game);
    const { lane, seed } = schedule;
    const amountMode = options.amountMode ?? "expBudget";
    const baseRoster = buildRoster(makeRng(seed), undefined, DEFAULT_AMOUNT_BY_LEVEL, undefined, amountMode);
    const { targetIndex, targetRoster, controlRoster } = forceV08PostA13CoverageUnit(baseRoster, lane.unit, amountMode);
    const candidateRoster = lane.owner === "candidate" ? targetRoster : controlRoster;
    const opponentRoster = lane.owner === "opponent" ? targetRoster : controlRoster;
    return {
        ...schedule,
        targetIndex,
        greenRoster: schedule.candidateSide === "green" ? candidateRoster : opponentRoster,
        redRoster: schedule.candidateSide === "green" ? opponentRoster : candidateRoster,
    };
}

/** Record only spells with remaining charges; exhausted/stolen-away spells are intentionally absent. */
export function auditV08PostA13Decision(
    audit: IV08PostA13ActionAudit,
    observation: IDecisionObservation,
    unit: V08PostA13CoverageUnit,
    side: Side,
): void {
    const observationSide: Side = observation.unit.getTeam() === GREEN_TEAM ? "green" : "red";
    if (observation.unit.getName() !== unit || observationSide !== side) {
        return;
    }
    audit.spellDecisionTurns += 1;
    const activeSpells = observation.unit.getSpells().filter((spell) => spell.isRemaining());
    if (activeSpells.length) {
        audit.activeSpellTurns += 1;
    }
    for (const spell of activeSpells) {
        const amount = spell.getAmount();
        audit.activeSpellChargesObserved += amount;
        increment(audit.activeSpellsObserved, spell.getName());
        increment(audit.activeSpellChargesByName, spell.getName(), amount);
    }
}

/** Fold one detached target turn into action, rejection, and completed-cast telemetry. */
export function auditV08PostA13Turn(
    audit: IV08PostA13ActionAudit,
    observation: ITurnExecutionObservation,
    unit: V08PostA13CoverageUnit,
    side: Side,
): void {
    if (observation.creatureName !== unit || observation.side !== side) {
        return;
    }
    audit.actingTurns += 1;
    if (observation.rawIncumbent.some((action) => action.type === "end_turn")) {
        audit.rawEndTurnDecisions += 1;
    }

    const strategyAttempts = observation.strategyActions.filter(({ action }) => action.type !== "select_attack_type");
    const recoveryAttempts = observation.recoveryAttempts.filter(({ action }) => action !== undefined);
    const completedStrategy = strategyAttempts.filter(({ completed }) => completed);
    const completedRecovery = recoveryAttempts.filter(({ completed }) => completed);
    const rejectedStrategy = strategyAttempts.filter(({ completed }) => !completed);
    const rejectedRecovery = recoveryAttempts.filter(({ completed }) => !completed);

    audit.completedStrategyActions += completedStrategy.length;
    audit.completedRecoveryActions += completedRecovery.length;
    audit.completedActions += completedStrategy.length + completedRecovery.length;
    audit.rejectedStrategyActions += rejectedStrategy.length;
    audit.rejectedRecoveryActions += rejectedRecovery.length;

    for (const attempt of [...rejectedStrategy, ...rejectedRecovery]) {
        increment(audit.rejectionReasons, attempt.rejectionReason ?? "unknown");
    }

    let productive = 0;
    for (const attempt of [...completedStrategy, ...completedRecovery]) {
        const action = attempt.action!;
        increment(audit.actionTypes, action.type);
        if (PRODUCTIVE_ACTIONS.has(action.type)) {
            productive += 1;
        }
        if (action.type === "cast_spell") {
            increment(audit.spellCasts, action.spellName);
        }
    }
    audit.productiveActions += productive;
    if (productive === 0) {
        audit.turnsWithoutProductiveAction += 1;
    }
}

/** Play one forced post-A13 coverage game. Intended for the dedicated worker and focused smoke tests. */
export function runV08PostA13CoverageGame(
    options: IV08PostA13CoverageOptions,
    game: number,
): IV08PostA13CoverageRecord {
    const plan = planV08PostA13CoverageGame(options, game);
    const target = createV08PostA13ActionAudit();
    target.appearances = (plan.targetSide === "green" ? plan.greenRoster : plan.redRoster).filter(
        (spec) => spec.creatureName === plan.lane.unit,
    ).length;
    if (target.appearances !== 1) {
        throw new Error(`Coverage plan expected one ${plan.lane.unit}; found ${target.appearances}`);
    }

    const setup = options.liveSetup === false ? undefined : liveTwinSetup();
    const config: IMatchConfig = {
        greenVersion: plan.candidateSide === "green" ? options.candidateVersion : options.opponentVersion,
        redVersion: plan.candidateSide === "green" ? options.opponentVersion : options.candidateVersion,
        roster: plan.greenRoster,
        redRoster: plan.redRoster,
        seed: plan.seed,
        gridType: plan.mapType,
        greenDoctrine: setup?.doctrine,
        redDoctrine: setup?.doctrine,
        greenAugments: setup?.augments,
        redAugments: setup?.augments,
        decisionObserver: (observation) =>
            auditV08PostA13Decision(target, observation, plan.lane.unit, plan.targetSide),
        turnExecutionObserver: (observation) =>
            auditV08PostA13Turn(target, observation, plan.lane.unit, plan.targetSide),
    };
    const result = runMatch(config);
    const winner = result.winner === "draw" ? "draw" : result.winner === plan.candidateSide ? "candidate" : "opponent";
    const candidateIsGreen = plan.candidateSide === "green";
    return {
        schema: V08_POST_A13_COVERAGE_SCHEMA,
        game,
        cycle: plan.cycle,
        seed: plan.seed,
        mapType: plan.mapType,
        lane: plan.lane,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        candidateSide: plan.candidateSide,
        targetSide: plan.targetSide,
        winner,
        laps: result.laps,
        endReason: result.endReason,
        rejectedCandidate: candidateIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
        rejectedOpponent: candidateIsGreen ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0),
        target,
        armageddon: {
            reached: result.attrition.reachedArmageddon,
            waves: result.attrition.armageddonWaves,
            decided: result.attrition.decidedByArmageddon,
            unitsKilled: result.attrition.unitsKilledByArmageddon,
        },
    };
}

const laneKey = ({ unit, owner }: IV08PostA13CoverageLane): string => `${unit}:${owner}`;

function mergeAudit(target: IV08PostA13ActionAudit, source: IV08PostA13ActionAudit): void {
    target.appearances += source.appearances;
    target.actingTurns += source.actingTurns;
    target.completedActions += source.completedActions;
    target.completedStrategyActions += source.completedStrategyActions;
    target.completedRecoveryActions += source.completedRecoveryActions;
    target.rejectedStrategyActions += source.rejectedStrategyActions;
    target.rejectedRecoveryActions += source.rejectedRecoveryActions;
    target.productiveActions += source.productiveActions;
    target.turnsWithoutProductiveAction += source.turnsWithoutProductiveAction;
    target.rawEndTurnDecisions += source.rawEndTurnDecisions;
    target.spellDecisionTurns += source.spellDecisionTurns;
    target.activeSpellTurns += source.activeSpellTurns;
    target.activeSpellChargesObserved += source.activeSpellChargesObserved;
    for (const [key, count] of Object.entries(source.actionTypes)) increment(target.actionTypes, key, count);
    for (const [key, count] of Object.entries(source.rejectionReasons)) increment(target.rejectionReasons, key, count);
    for (const [key, count] of Object.entries(source.activeSpellsObserved))
        increment(target.activeSpellsObserved, key, count);
    for (const [key, count] of Object.entries(source.activeSpellChargesByName))
        increment(target.activeSpellChargesByName, key, count);
    for (const [key, count] of Object.entries(source.spellCasts)) increment(target.spellCasts, key, count);
}

export function summarizeV08PostA13Coverage(
    options: IV08PostA13CoverageOptions,
    records: readonly IV08PostA13CoverageRecord[],
): IV08PostA13CoverageSummary {
    const expectedGames = getV08PostA13CoverageGameCount(options);
    if (records.length !== expectedGames) {
        throw new Error(`Expected ${expectedGames} post-A13 coverage records, got ${records.length}`);
    }
    const byLane = new Map<string, IV08PostA13CoverageCellSummary>(
        getV08PostA13CoverageLanes(options).map((lane) => [
            laneKey(lane),
            {
                lane,
                games: 0,
                candidateGreenGames: 0,
                candidateRedGames: 0,
                mapCensus: V08_POST_A13_LIVE_MAPS.map((mapType) => ({
                    mapType,
                    games: 0,
                    candidateGreenGames: 0,
                    candidateRedGames: 0,
                })),
                candidateWins: 0,
                opponentWins: 0,
                draws: 0,
                rejectedCandidate: 0,
                rejectedOpponent: 0,
                armageddonReached: 0,
                armageddonDecided: 0,
                ...createV08PostA13ActionAudit(),
            },
        ]),
    );
    const seenGames = new Set<number>();
    for (const record of records) {
        if (seenGames.has(record.game)) {
            throw new Error(`Duplicate post-A13 coverage game record: ${record.game}`);
        }
        seenGames.add(record.game);
        const expected = scheduleV08PostA13CoverageGame(options, record.game);
        if (
            record.schema !== V08_POST_A13_COVERAGE_SCHEMA ||
            record.candidateVersion !== options.candidateVersion ||
            record.opponentVersion !== options.opponentVersion ||
            JSON.stringify(scheduleIdentity(record)) !== JSON.stringify(scheduleIdentity(expected))
        ) {
            throw new Error(`Post-A13 coverage record ${record.game} does not match its deterministic plan`);
        }
        const cell = byLane.get(laneKey(record.lane));
        if (!cell) {
            throw new Error(`Unknown coverage lane in record: ${laneKey(record.lane)}`);
        }
        cell.games += 1;
        if (record.candidateSide === "green") cell.candidateGreenGames += 1;
        else cell.candidateRedGames += 1;
        const mapCell = cell.mapCensus.find(({ mapType }) => mapType === record.mapType);
        if (!mapCell) {
            throw new Error(`Non-live map ${record.mapType} in post-A13 coverage record ${record.game}`);
        }
        mapCell.games += 1;
        if (record.candidateSide === "green") mapCell.candidateGreenGames += 1;
        else mapCell.candidateRedGames += 1;
        if (record.winner === "candidate") cell.candidateWins += 1;
        else if (record.winner === "opponent") cell.opponentWins += 1;
        else cell.draws += 1;
        cell.rejectedCandidate += record.rejectedCandidate;
        cell.rejectedOpponent += record.rejectedOpponent;
        cell.armageddonReached += Number(record.armageddon.reached);
        cell.armageddonDecided += Number(record.armageddon.decided);
        mergeAudit(cell, record.target);
    }
    return {
        schema: V08_POST_A13_COVERAGE_SCHEMA,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        baseSeed: options.baseSeed,
        pairsPerLane: options.pairsPerLane,
        maps: V08_POST_A13_LIVE_MAPS,
        planSha256: fingerprintV08PostA13CoveragePlan(options),
        games: records.length,
        lanes: [...byLane.values()],
    };
}

export function runV08PostA13CoverageConcurrent(
    options: IV08PostA13CoverageOptions,
    concurrency: number,
    onGame?: (record: IV08PostA13CoverageRecord) => void,
): Promise<IV08PostA13CoverageSummary> {
    const total = getV08PostA13CoverageGameCount(options);
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize === 1) {
        const records = Array.from({ length: total }, (_, game) => runV08PostA13CoverageGame(options, game));
        records.forEach(onGame ?? (() => undefined));
        return Promise.resolve(summarizeV08PostA13Coverage(options, records));
    }
    return new Promise((resolve, reject) => {
        const records: IV08PostA13CoverageRecord[] = [];
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched++ });
        };
        const workerUrl = new URL("./v0_8_post_a13_coverage_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(workerUrl, { workerData: { options } });
            workers.push(worker);
            worker.on(
                "message",
                (message: { type: "ready" } | { type: "result"; record: IV08PostA13CoverageRecord }) => {
                    if (settled) return;
                    if (message.type === "ready") {
                        dispatch(worker);
                        return;
                    }
                    records.push(message.record);
                    onGame?.(message.record);
                    completed += 1;
                    if (completed === total) {
                        settled = true;
                        cleanup();
                        resolve(summarizeV08PostA13Coverage(options, records));
                    } else {
                        dispatch(worker);
                    }
                },
            );
            worker.on("error", fail);
        }
    });
}

async function main(): Promise<void> {
    const [candidateVersion, opponentVersion, pairsArg, seedArg, outDirArg, concurrencyArg, targetUnitsArg] =
        process.argv.slice(2);
    if (!candidateVersion || !opponentVersion) {
        console.error(
            "usage: v0_8_post_a13_coverage <candidateVersion> <opponentVersion> [pairsPerLane] [baseSeed] [outDir] [concurrency] [targetUnits]",
        );
        process.exitCode = 1;
        return;
    }
    if (!AI_VERSIONS.includes(candidateVersion) || !AI_VERSIONS.includes(opponentVersion)) {
        throw new Error(`Unknown version; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    const pairsPerLane = pairsArg ? Number(pairsArg) : 100;
    const baseSeed = seedArg ? Number(seedArg) : 1;
    const outDir = outDirArg ?? join(process.cwd(), "sim-out");
    const targetUnits = targetUnitsArg
        ?.split(",")
        .map((unit) => unit.trim())
        .filter(Boolean) as V08PostA13CoverageUnit[] | undefined;
    const options: IV08PostA13CoverageOptions = {
        candidateVersion,
        opponentVersion,
        pairsPerLane,
        baseSeed,
        targetUnits,
    };
    const total = getV08PostA13CoverageGameCount(options);
    const laneCount = getV08PostA13CoverageLanes(options).length;
    const concurrency = Math.min(concurrencyArg ? Math.max(1, Number(concurrencyArg)) : availableParallelism(), total);
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `v08_post_a13_${candidateVersion}_vs_${opponentVersion}_${stamp}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const jsonlPath = join(outDir, `${base}.jsonl`);
    const summaryPath = join(outDir, `${base}.summary.json`);
    writeFileSync(jsonlPath, "");
    let completed = 0;
    const started = Date.now();
    console.log(
        `Running ${total} post-A13 coverage games (${pairsPerLane} pairs/lane across ${laneCount} lanes, concurrency ${concurrency}) -> ${jsonlPath}`,
    );
    const summary = await runV08PostA13CoverageConcurrent(options, concurrency, (record) => {
        appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
        completed += 1;
        if (completed % 100 === 0 || completed === total) console.log(`  ${completed}/${total} games...`);
    });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Summary -> ${summaryPath}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
