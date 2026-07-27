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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { AI_VERSIONS } from "../ai";
import { enumerateCandidates, type CandidateKind, type IEnumeratedCandidate } from "../ai/candidates";
import {
    buildV08BacklineProtectorIntent,
    buildV08BacklineWardIntent,
    isV08BacklineProtectorPureMoveMeaningful,
    isV08BacklineWardPureMoveMeaningful,
    preservesV08BacklineProtectorIntent,
    preservesV08BacklineWardIntent,
} from "../ai/versions/v0_8_backline_protector";
import { isV08DirectCombatDecision } from "../ai/versions/v0_8_dominant_finish";
import type { GameAction } from "../engine/actions";
import type { GameEvent } from "../engine/events";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import {
    buildRoster,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    makeRng,
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
import type { ISearchPassiveProductiveProbe } from "./search_driver";
import { V08_A13_SEARCH_OVERRIDE_ENV, withScopedAIEnvironment } from "./v0_8_a13_search";

export const V08_PASSIVE_TURN_PANEL_SCHEMA = "hoc.v0_8_passive_turn_panel.v1" as const;
export const V08_PASSIVE_TURN_PANEL_DEFAULT_GAMES = 4096;
export const V08_PASSIVE_TURN_PANEL_DEFAULT_SEED = 2_607_270_813;
export const V08_PASSIVE_TURN_PANEL_DEFAULT_CONCURRENCY = 12;
export const V08_PASSIVE_TURN_PANEL_DEFAULT_MIN_CREATURE_APPEARANCES = 250;
export const V08_PASSIVE_TURN_PANEL_MAX_DEFEND_SHARE = 0.01;
export const V08_PASSIVE_TURN_PANEL_MIN_WAIT_REACTIVATION_RATE = 0.95;
export const V08_PASSIVE_TURN_PANEL_MAPS: readonly number[] = Object.freeze([
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
]);

const PRODUCTIVE_ACTION_KINDS = new Set<CandidateKind>(["move", "melee", "shot", "area_throw", "spell"]);
const PRODUCTIVE_ACTION_TYPES = new Set<GameAction["type"]>([
    "move_unit",
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "cast_spell",
]);
const PASSIVE_ACTION_TYPES = new Set<GameAction["type"]>(["wait_turn", "defend_turn", "obstacle_attack"]);
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
const RANDOM_ROSTER_ENVIRONMENT_KEYS = [
    "COHORT",
    "FORCE_CREATURES",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_FLYER_MIN",
    "ROSTER_FLYER_MAX",
    "ROSTER_CASTER_MIN",
    "ROSTER_CASTER_MAX",
] as const;

export type V08PassiveDefendClass = "forced" | "protected" | "avoidable";

export interface IV08PassiveTurnPanelOptions {
    candidateVersion: string;
    opponentVersion: string;
    /** Must be positive and even: adjacent games are a physical-seat swap. */
    games: number;
    baseSeed: number;
    /** Defaults to ranked's per-creature 1,000-XP stack budget. */
    amountMode?: StackAmountMode;
    /** Defaults true: SEE_NONE plus the shipped blind Armor/Might/Sniper setup. */
    liveSetup?: boolean;
    maxLaps?: number;
    /** Defaults 250 for the 4,096-game qualification panel. */
    minCreatureAppearances?: number;
    /** Optional provenance copied into the summary. */
    sourceCommit?: string;
}

export interface IV08PassiveTurnPanelGamePlan {
    game: number;
    pair: number;
    seed: number;
    mapType: number;
    candidateSide: Side;
    greenRoster: IArmyUnitSpec[];
    redRoster: IArmyUnitSpec[];
}

export interface IV08PassiveTurnMetrics {
    appearances: number;
    turns: number;
    rawEndTurnTurns: number;
    chosenEndTurnTurns: number;
    strategyRejectedActions: number;
    recoveryTurns: number;
    recoveryAttempts: number;
    recoveryRejectedActions: number;
    incompleteTurns: number;
    observerPairingFaults: number;
    enumerationTruncations: number;
    rawDefendTurns: number;
    chosenDefendTurns: number;
    finalDefendTurns: number;
    introducedDefendTurns: number;
    forcedDefendTurns: number;
    protectedDefendTurns: number;
    avoidableDefendTurns: number;
    rawAvoidableDefendTurns: number;
    repairedRawAvoidableDefendTurns: number;
    waitTurns: number;
    sameLapWaitReactivations: number;
    repeatedSameLapWaits: number;
    missedSameLapWaitReactivations: number;
    waitsSkippedByEffectBeforeReactivation: number;
    waitsKilledBeforeReactivation: number;
    waitsCensoredByMatchEnd: number;
}

export interface IV08PassivePreparedDecision {
    unitId: string;
    creatureName: string;
    lap: number;
    rawIncumbent: readonly GameAction[];
    defendClass: V08PassiveDefendClass;
    /** Production v0.8 defend classifications must be confirmed by SearchDriver's real-engine probe. */
    requiresProductiveProbe?: boolean;
    enumerationTruncations?: number;
    isDead?: () => boolean;
}

interface IPendingDecision extends IV08PassivePreparedDecision {
    reactivatedFromWait: boolean;
    engineValidProductiveAlternative?: boolean;
}

interface IPendingWait {
    unitId: string;
    creatureName: string;
    lap: number;
    isDead?: () => boolean;
}

export interface IV08PassiveTurnPanelRecord {
    schema: typeof V08_PASSIVE_TURN_PANEL_SCHEMA;
    game: number;
    pair: number;
    seed: number;
    mapType: number;
    candidateVersion: string;
    opponentVersion: string;
    candidateSide: Side;
    candidateRoster: string[];
    opponentRoster: string[];
    winner: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck" | "crash";
    crash?: string;
    candidateEngineRejections: number;
    metrics: IV08PassiveTurnMetrics;
    byCreature: Record<string, IV08PassiveTurnMetrics>;
}

export interface IV08PassiveTurnGate {
    pass: boolean;
    actual: number | string;
    expected: string;
}

export interface IV08PassiveTurnPanelSummary {
    schema: typeof V08_PASSIVE_TURN_PANEL_SCHEMA;
    sourceCommit: string | null;
    candidateVersion: string;
    opponentVersion: string;
    options: {
        games: number;
        baseSeed: number;
        amountMode: StackAmountMode;
        liveSetup: boolean;
        maxLaps: number;
        minCreatureAppearances: number;
    };
    planSha256: string;
    games: number;
    candidateSeats: Record<Side, number>;
    maps: Record<string, number>;
    endReasons: Record<string, number>;
    candidateEngineRejections: number;
    metrics: IV08PassiveTurnMetrics;
    byCreature: Record<string, IV08PassiveTurnMetrics>;
    enabledCreatureAppearances: Record<string, number>;
    underrepresentedCreatures: string[];
    defendShare: number;
    eligibleWaitReactivationRate: number;
    allWaitReactivationRate: number;
    abominationFaults: number;
    arachnaQueenFaults: number;
    gates: {
        pass: boolean;
        failed: string[];
        checks: Record<string, IV08PassiveTurnGate>;
    };
    failureSamples: Array<{
        game: number;
        seed: number;
        mapType: number;
        candidateSide: Side;
        issue: string;
    }>;
}

const METRIC_KEYS = [
    "appearances",
    "turns",
    "rawEndTurnTurns",
    "chosenEndTurnTurns",
    "strategyRejectedActions",
    "recoveryTurns",
    "recoveryAttempts",
    "recoveryRejectedActions",
    "incompleteTurns",
    "observerPairingFaults",
    "enumerationTruncations",
    "rawDefendTurns",
    "chosenDefendTurns",
    "finalDefendTurns",
    "introducedDefendTurns",
    "forcedDefendTurns",
    "protectedDefendTurns",
    "avoidableDefendTurns",
    "rawAvoidableDefendTurns",
    "repairedRawAvoidableDefendTurns",
    "waitTurns",
    "sameLapWaitReactivations",
    "repeatedSameLapWaits",
    "missedSameLapWaitReactivations",
    "waitsSkippedByEffectBeforeReactivation",
    "waitsKilledBeforeReactivation",
    "waitsCensoredByMatchEnd",
] as const satisfies readonly (keyof IV08PassiveTurnMetrics)[];

export const emptyV08PassiveTurnMetrics = (): IV08PassiveTurnMetrics => ({
    appearances: 0,
    turns: 0,
    rawEndTurnTurns: 0,
    chosenEndTurnTurns: 0,
    strategyRejectedActions: 0,
    recoveryTurns: 0,
    recoveryAttempts: 0,
    recoveryRejectedActions: 0,
    incompleteTurns: 0,
    observerPairingFaults: 0,
    enumerationTruncations: 0,
    rawDefendTurns: 0,
    chosenDefendTurns: 0,
    finalDefendTurns: 0,
    introducedDefendTurns: 0,
    forcedDefendTurns: 0,
    protectedDefendTurns: 0,
    avoidableDefendTurns: 0,
    rawAvoidableDefendTurns: 0,
    repairedRawAvoidableDefendTurns: 0,
    waitTurns: 0,
    sameLapWaitReactivations: 0,
    repeatedSameLapWaits: 0,
    missedSameLapWaitReactivations: 0,
    waitsSkippedByEffectBeforeReactivation: 0,
    waitsKilledBeforeReactivation: 0,
    waitsCensoredByMatchEnd: 0,
});

const increment = (record: Record<string, number>, key: string, amount = 1): void => {
    record[key] = (record[key] ?? 0) + amount;
};

const hasAction = (actions: readonly Readonly<GameAction>[], type: GameAction["type"]): boolean =>
    actions.some((action) => action.type === type);

const isPureMoveCandidate = (candidate: Pick<IEnumeratedCandidate, "actions">): boolean =>
    candidate.actions.length > 0 && candidate.actions.every((action) => action.type === "move_unit");

/**
 * This is intentionally the same force-tier definition used by SearchDriver:
 * movement/support spells are productive, while a direct attack must have finite positive expected damage.
 */
export function isV08PassiveForceTierProductiveCandidate(
    candidate: Pick<IEnumeratedCandidate, "kind" | "actions" | "features">,
): boolean {
    const productive =
        candidate.kind === "incumbent"
            ? candidate.actions.some((action) => PRODUCTIVE_ACTION_TYPES.has(action.type)) &&
              !candidate.actions.some((action) => PASSIVE_ACTION_TYPES.has(action.type))
            : PRODUCTIVE_ACTION_KINDS.has(candidate.kind);
    if (!productive) return false;
    if (!isV08DirectCombatDecision(candidate.actions)) return true;
    return Number.isFinite(candidate.features.expectedDamage) && candidate.features.expectedDamage > 0;
}

/**
 * Preliminary classification against the complete, uncapped candidate set. The production panel subsequently
 * confirms every nominally avoidable v0.8 shield with SearchDriver's authoritative engine probe.
 * `preservesIntent` distinguishes a legitimate protector/ward hold from a shield that discarded a safe action.
 */
export function classifyV08PassiveDefendOpportunity(
    candidates: readonly Pick<IEnumeratedCandidate, "kind" | "actions" | "features">[],
    preservesIntent?: (candidate: Pick<IEnumeratedCandidate, "kind" | "actions" | "features">) => boolean,
): V08PassiveDefendClass {
    const productive = candidates.filter(isV08PassiveForceTierProductiveCandidate);
    if (!productive.length) return "forced";
    if (preservesIntent && !productive.some(preservesIntent)) return "protected";
    return "avoidable";
}

const sideForUnit = (unit: Unit): Side => (unit.getTeam() === GREEN_TEAM ? "green" : "red");

const destroyedUnitIds = (events: readonly GameEvent[]): Set<string> => {
    const ids = new Set<string>();
    for (const event of events) {
        if (event.type === "unit_destroyed") ids.add(event.unitId);
        if ("unitIdsDied" in event && Array.isArray(event.unitIdsDied)) {
            for (const unitId of event.unitIdsDied) ids.add(unitId);
        }
    }
    return ids;
};

/**
 * Stateful dual-hook reducer. Candidate ownership is based only on the physical side, never strategyVersion:
 * Berserker/Boar turns pinned to v0.1 therefore remain part of the v0.8 candidate audit.
 */
export class V08PassiveTurnAuditor {
    public readonly metrics = emptyV08PassiveTurnMetrics();
    public readonly byCreature: Record<string, IV08PassiveTurnMetrics> = {};
    private readonly pendingDecisions = new Map<string, IPendingDecision>();
    private readonly pendingWaits = new Map<string, IPendingWait>();
    private readonly destroyed = new Set<string>();
    public constructor(public readonly candidateSide: Side) {}
    private creatureMetrics(creatureName: string): IV08PassiveTurnMetrics {
        return (this.byCreature[creatureName] ??= emptyV08PassiveTurnMetrics());
    }
    private add(creatureName: string, key: keyof IV08PassiveTurnMetrics, amount = 1): void {
        this.metrics[key] += amount;
        this.creatureMetrics(creatureName)[key] += amount;
    }
    public recordAppearances(roster: readonly IArmyUnitSpec[]): void {
        for (const { creatureName } of roster) this.add(creatureName, "appearances");
    }
    private resolveWait(wait: IPendingWait, outcome: "effect" | "killed" | "missed" | "match_end"): void {
        this.pendingWaits.delete(wait.unitId);
        if (outcome === "effect") this.add(wait.creatureName, "waitsSkippedByEffectBeforeReactivation");
        else if (outcome === "killed") this.add(wait.creatureName, "waitsKilledBeforeReactivation");
        else if (outcome === "missed") this.add(wait.creatureName, "missedSameLapWaitReactivations");
        else this.add(wait.creatureName, "waitsCensoredByMatchEnd");
    }
    private expireWaitsBefore(lap: number): void {
        for (const wait of [...this.pendingWaits.values()]) {
            if (wait.lap >= lap) continue;
            this.resolveWait(wait, this.destroyed.has(wait.unitId) || wait.isDead?.() === true ? "killed" : "missed");
        }
    }
    public observePreparedDecision(prepared: IV08PassivePreparedDecision): void {
        this.expireWaitsBefore(prepared.lap);
        const previousDecision = this.pendingDecisions.get(prepared.unitId);
        if (previousDecision) {
            this.add(previousDecision.creatureName, "observerPairingFaults");
        }
        const waiting = this.pendingWaits.get(prepared.unitId);
        const reactivatedFromWait = waiting?.lap === prepared.lap;
        if (reactivatedFromWait) {
            this.pendingWaits.delete(prepared.unitId);
            this.add(prepared.creatureName, "sameLapWaitReactivations");
        }
        this.pendingDecisions.set(prepared.unitId, {
            ...prepared,
            rawIncumbent: [...prepared.rawIncumbent],
            reactivatedFromWait,
        });
        if (prepared.enumerationTruncations) {
            this.add(prepared.creatureName, "enumerationTruncations", prepared.enumerationTruncations);
        }
    }
    public observeDecision(observation: IDecisionObservation): void {
        if (sideForUnit(observation.unit) !== this.candidateSide) return;
        const { unit, context } = observation;
        const candidateSet = enumerateCandidates(unit, context, [...observation.incumbent], {
            // Uncapped enumeration still needs duplicate-generated melee/throw/spell metadata copied onto
            // candidate zero; otherwise a positive incumbent attack retains expectedDamage=0 and is falsely
            // treated as a forced shield alternative. This is the same enrichment production A13 requests.
            enrichIncumbentMetadata: true,
        });
        const protectorIntent = buildV08BacklineProtectorIntent(unit, context);
        const wardIntent = buildV08BacklineWardIntent(unit, context);
        const preservesIntent =
            protectorIntent || wardIntent
                ? (candidate: Pick<IEnumeratedCandidate, "actions">): boolean =>
                      (!protectorIntent ||
                          (preservesV08BacklineProtectorIntent(protectorIntent, unit, context, candidate.actions) &&
                              (!isPureMoveCandidate(candidate) ||
                                  isV08BacklineProtectorPureMoveMeaningful(
                                      protectorIntent,
                                      unit,
                                      context,
                                      candidate.actions,
                                  )))) &&
                      (!wardIntent ||
                          (preservesV08BacklineWardIntent(wardIntent, unit, context, candidate.actions) &&
                              (!isPureMoveCandidate(candidate) ||
                                  isV08BacklineWardPureMoveMeaningful(wardIntent, unit, context, candidate.actions))))
                : undefined;
        const defendClass = classifyV08PassiveDefendOpportunity(candidateSet.candidates, preservesIntent);
        this.observePreparedDecision({
            unitId: unit.getId(),
            creatureName: unit.getName(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
            rawIncumbent: observation.incumbent,
            defendClass,
            requiresProductiveProbe:
                observation.strategyVersion === "v0.8" &&
                defendClass === "avoidable" &&
                hasAction(observation.incumbent, "defend_turn"),
            enumerationTruncations: candidateSet.truncated.length,
            isDead: () => unit.isDead(),
        });
    }
    public observeProductiveProbe(probe: ISearchPassiveProductiveProbe): void {
        const pending = this.pendingDecisions.get(probe.unitId);
        // The shared SearchDriver also probes the opponent. Candidate-side decisions alone have pending rows.
        if (!pending) return;
        if (pending.engineValidProductiveAlternative !== undefined) {
            this.add(pending.creatureName, "observerPairingFaults");
        }
        pending.engineValidProductiveAlternative = probe.hasEngineValidProductiveAlternative;
    }
    public observeEvents(events: readonly GameEvent[]): void {
        for (const event of events) {
            if (event.type === "unit_skipped" && event.reason === "effect") {
                const wait = this.pendingWaits.get(event.unitId);
                if (wait) this.resolveWait(wait, "effect");
            }
        }
        for (const unitId of destroyedUnitIds(events)) {
            this.destroyed.add(unitId);
            const wait = this.pendingWaits.get(unitId);
            if (wait) this.resolveWait(wait, "killed");
        }
    }
    public observeExecution(observation: ITurnExecutionObservation): void {
        this.observeEvents(observation.events);
        if (observation.side !== this.candidateSide) return;
        const pending = this.pendingDecisions.get(observation.unitId);
        if (!pending) {
            this.add(observation.creatureName, "observerPairingFaults");
            return;
        }
        this.pendingDecisions.delete(observation.unitId);
        const creature = observation.creatureName;
        this.add(creature, "turns");

        const rawEnd = hasAction(pending.rawIncumbent, "end_turn");
        const chosenEnd = hasAction(observation.chosenDecision, "end_turn");
        const rawDefend = hasAction(pending.rawIncumbent, "defend_turn");
        const chosenDefend = hasAction(observation.chosenDecision, "defend_turn");
        let defendClass = pending.defendClass;
        if (pending.requiresProductiveProbe) {
            if (pending.engineValidProductiveAlternative === undefined) {
                this.add(observation.creatureName, "observerPairingFaults");
            }
            if (pending.engineValidProductiveAlternative !== true) defendClass = "forced";
        }
        if (rawEnd) this.add(creature, "rawEndTurnTurns");
        if (chosenEnd) this.add(creature, "chosenEndTurnTurns");
        if (rawDefend) this.add(creature, "rawDefendTurns");
        if (chosenDefend) this.add(creature, "chosenDefendTurns");
        if (rawDefend && defendClass === "avoidable") {
            this.add(creature, "rawAvoidableDefendTurns");
            if (!chosenDefend) this.add(creature, "repairedRawAvoidableDefendTurns");
        }

        const rejectedStrategy = observation.strategyActions.filter(({ completed }) => !completed);
        const recoveryAttempts = observation.recoveryAttempts.filter(({ action }) => action !== undefined);
        const rejectedRecovery = recoveryAttempts.filter(({ completed }) => !completed);
        if (rejectedStrategy.length) this.add(creature, "strategyRejectedActions", rejectedStrategy.length);
        if (recoveryAttempts.length) {
            this.add(creature, "recoveryTurns");
            this.add(creature, "recoveryAttempts", recoveryAttempts.length);
        }
        if (rejectedRecovery.length) this.add(creature, "recoveryRejectedActions", rejectedRecovery.length);

        const completedStrategy = observation.strategyActions.filter(({ completed }) => completed);
        const completedRecovery = recoveryAttempts.filter(({ completed }) => completed);
        const meaningful = [...completedStrategy, ...completedRecovery].some(
            ({ action }) => action !== undefined && MEANINGFUL_ACTION_TYPES.has(action.type),
        );
        if (!meaningful) this.add(creature, "incompleteTurns");

        const completedWait = completedStrategy.some(({ action }) => action.type === "wait_turn");
        if (completedWait) {
            this.add(creature, "waitTurns");
            if (pending.reactivatedFromWait) this.add(creature, "repeatedSameLapWaits");
            this.pendingWaits.set(observation.unitId, {
                unitId: observation.unitId,
                creatureName: creature,
                lap: pending.lap,
                isDead: pending.isDead,
            });
        }

        const completedDefend =
            completedStrategy.some(({ action }) => action.type === "defend_turn") ||
            completedRecovery.some(({ action }) => action?.type === "defend_turn");
        if (completedDefend) {
            this.add(creature, "finalDefendTurns");
            if (!rawDefend) this.add(creature, "introducedDefendTurns");
            if (defendClass === "forced") this.add(creature, "forcedDefendTurns");
            else if (defendClass === "protected") this.add(creature, "protectedDefendTurns");
            else this.add(creature, "avoidableDefendTurns");
        }
    }
    public finish(): void {
        for (const pending of this.pendingDecisions.values()) {
            this.add(pending.creatureName, "observerPairingFaults");
        }
        this.pendingDecisions.clear();
        for (const wait of [...this.pendingWaits.values()]) {
            this.resolveWait(
                wait,
                this.destroyed.has(wait.unitId) || wait.isDead?.() === true ? "killed" : "match_end",
            );
        }
    }
}

const withRandomRosterEnvironment = <T>(run: () => T): T => {
    const saved = new Map<string, string | undefined>();
    for (const key of RANDOM_ROSTER_ENVIRONMENT_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    try {
        return run();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const validateOptions = (options: IV08PassiveTurnPanelOptions): void => {
    if (!Number.isSafeInteger(options.games) || options.games <= 0 || options.games % 2 !== 0) {
        throw new RangeError(`Passive-turn panel games must be a positive even integer; got ${options.games}`);
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0) {
        throw new RangeError(`Passive-turn panel baseSeed must be a nonnegative safe integer; got ${options.baseSeed}`);
    }
    if (options.minCreatureAppearances !== undefined && options.minCreatureAppearances < 0) {
        throw new RangeError("Passive-turn panel minCreatureAppearances must be nonnegative");
    }
};

/** Adjacent games reuse both physical rosters and combat seed, then swap candidate/opponent seats. */
export function planV08PassiveTurnPanelGame(
    options: IV08PassiveTurnPanelOptions,
    game: number,
): IV08PassiveTurnPanelGamePlan {
    validateOptions(options);
    if (!Number.isSafeInteger(game) || game < 0 || game >= options.games) {
        throw new RangeError(`Invalid passive-turn panel game ${game}`);
    }
    const pair = Math.floor(game / 2);
    const seed = (options.baseSeed + pair * 0x9e3779b1) >>> 0;
    const amountMode = options.amountMode ?? "expBudget";
    const [greenRoster, redRoster] = withRandomRosterEnvironment(() => [
        buildRoster(makeRng(seed), undefined, DEFAULT_AMOUNT_BY_LEVEL, undefined, amountMode),
        buildRoster(makeRng((seed ^ 0x85ebca6b) >>> 0), undefined, DEFAULT_AMOUNT_BY_LEVEL, undefined, amountMode),
    ]);
    return {
        game,
        pair,
        seed,
        mapType: V08_PASSIVE_TURN_PANEL_MAPS[pair % V08_PASSIVE_TURN_PANEL_MAPS.length],
        candidateSide: game % 2 === 0 ? "green" : "red",
        greenRoster,
        redRoster,
    };
}

const rosterNames = (roster: readonly IArmyUnitSpec[]): string[] => roster.map(({ creatureName }) => creatureName);

const scheduleIdentity = (plan: IV08PassiveTurnPanelGamePlan): unknown => ({
    game: plan.game,
    pair: plan.pair,
    seed: plan.seed,
    mapType: plan.mapType,
    candidateSide: plan.candidateSide,
    greenRoster: rosterNames(plan.greenRoster),
    redRoster: rosterNames(plan.redRoster),
});

export function fingerprintV08PassiveTurnPanelPlan(options: IV08PassiveTurnPanelOptions): string {
    validateOptions(options);
    const identities = Array.from({ length: options.games }, (_, game) =>
        scheduleIdentity(planV08PassiveTurnPanelGame(options, game)),
    );
    return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

/** Run one production v0.8+a13 random-roster match with read-only decision and execution observers. */
export function runV08PassiveTurnPanelGame(
    options: IV08PassiveTurnPanelOptions,
    game: number,
): IV08PassiveTurnPanelRecord {
    const plan = planV08PassiveTurnPanelGame(options, game);
    const auditor = new V08PassiveTurnAuditor(plan.candidateSide);
    const candidateRoster = plan.candidateSide === "green" ? plan.greenRoster : plan.redRoster;
    const opponentRoster = plan.candidateSide === "green" ? plan.redRoster : plan.greenRoster;
    auditor.recordAppearances(candidateRoster);
    const setup = options.liveSetup === false ? undefined : liveTwinSetup();
    const config: IMatchConfig = {
        greenVersion: plan.candidateSide === "green" ? options.candidateVersion : options.opponentVersion,
        redVersion: plan.candidateSide === "green" ? options.opponentVersion : options.candidateVersion,
        roster: plan.greenRoster,
        redRoster: plan.redRoster,
        seed: plan.seed,
        gridType: plan.mapType,
        maxLaps: options.maxLaps,
        greenPerk: setup?.perk,
        redPerk: setup?.perk,
        greenAugments: setup?.augments,
        redAugments: setup?.augments,
        placementAugmentTiming: "setup-before-placement",
        decisionObserver: (observation) => auditor.observeDecision(observation),
        searchPassiveProductiveProbeObserver: (probe) => auditor.observeProductiveProbe(probe),
        turnExecutionObserver: (observation) => auditor.observeExecution(observation),
        turnActivationObserver: (events) => auditor.observeEvents(events),
    };
    try {
        // Fail closed against an inherited research shell: the panel always measures the promoted, sealed A13
        // driver for a production v0.8 seat, even when the caller has V07_SEARCH/Q2 variables in its environment.
        const result = withScopedAIEnvironment({ [V08_A13_SEARCH_OVERRIDE_ENV]: "1" }, () => runMatch(config));
        auditor.finish();
        const candidateIsGreen = plan.candidateSide === "green";
        return {
            schema: V08_PASSIVE_TURN_PANEL_SCHEMA,
            game,
            pair: plan.pair,
            seed: plan.seed,
            mapType: plan.mapType,
            candidateVersion: options.candidateVersion,
            opponentVersion: options.opponentVersion,
            candidateSide: plan.candidateSide,
            candidateRoster: rosterNames(candidateRoster),
            opponentRoster: rosterNames(opponentRoster),
            winner: result.winner === "draw" ? "draw" : result.winner === plan.candidateSide ? "candidate" : "opponent",
            laps: result.laps,
            endReason: result.endReason,
            candidateEngineRejections: candidateIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
            metrics: auditor.metrics,
            byCreature: auditor.byCreature,
        };
    } catch (error) {
        auditor.finish();
        return {
            schema: V08_PASSIVE_TURN_PANEL_SCHEMA,
            game,
            pair: plan.pair,
            seed: plan.seed,
            mapType: plan.mapType,
            candidateVersion: options.candidateVersion,
            opponentVersion: options.opponentVersion,
            candidateSide: plan.candidateSide,
            candidateRoster: rosterNames(candidateRoster),
            opponentRoster: rosterNames(opponentRoster),
            winner: "draw",
            laps: 0,
            endReason: "crash",
            crash: error instanceof Error ? (error.stack ?? error.message) : String(error),
            candidateEngineRejections: 0,
            metrics: auditor.metrics,
            byCreature: auditor.byCreature,
        };
    }
}

const mergeMetrics = (target: IV08PassiveTurnMetrics, source: IV08PassiveTurnMetrics): void => {
    for (const key of METRIC_KEYS) target[key] += source[key];
};

const cloneMetrics = (metrics: IV08PassiveTurnMetrics): IV08PassiveTurnMetrics => ({ ...metrics });

export function v08PassiveCreatureFaults(metrics: IV08PassiveTurnMetrics | undefined): number {
    if (!metrics) return 0;
    return (
        metrics.rawEndTurnTurns +
        metrics.chosenEndTurnTurns +
        metrics.strategyRejectedActions +
        metrics.recoveryAttempts +
        metrics.recoveryRejectedActions +
        metrics.incompleteTurns +
        metrics.observerPairingFaults +
        metrics.enumerationTruncations +
        metrics.introducedDefendTurns +
        metrics.avoidableDefendTurns +
        metrics.missedSameLapWaitReactivations +
        metrics.repeatedSameLapWaits
    );
}

const ratio = (numerator: number, denominator: number, emptyValue: number): number =>
    denominator > 0 ? Number((numerator / denominator).toFixed(6)) : emptyValue;

const gate = (pass: boolean, actual: number | string, expected: string): IV08PassiveTurnGate => ({
    pass,
    actual,
    expected,
});

const enabledCreatureNames = (): string[] =>
    [
        ...new Set([1, 2, 3, 4].flatMap((level) => creaturesByLevel(level).map(({ creatureName }) => creatureName))),
    ].sort();

export function summarizeV08PassiveTurnPanel(
    options: IV08PassiveTurnPanelOptions,
    records: readonly IV08PassiveTurnPanelRecord[],
): IV08PassiveTurnPanelSummary {
    validateOptions(options);
    const metrics = emptyV08PassiveTurnMetrics();
    const byCreature: Record<string, IV08PassiveTurnMetrics> = {};
    const candidateSeats: Record<Side, number> = { green: 0, red: 0 };
    const maps: Record<string, number> = {};
    const endReasons: Record<string, number> = {};
    const seenGames = new Set<number>();
    const failureSamples: IV08PassiveTurnPanelSummary["failureSamples"] = [];
    let candidateEngineRejections = 0;

    for (const record of records) {
        if (seenGames.has(record.game)) throw new Error(`Duplicate passive-turn panel game ${record.game}`);
        seenGames.add(record.game);
        const expected = planV08PassiveTurnPanelGame(options, record.game);
        const candidateRoster = expected.candidateSide === "green" ? expected.greenRoster : expected.redRoster;
        const opponentRoster = expected.candidateSide === "green" ? expected.redRoster : expected.greenRoster;
        if (
            record.schema !== V08_PASSIVE_TURN_PANEL_SCHEMA ||
            record.candidateVersion !== options.candidateVersion ||
            record.opponentVersion !== options.opponentVersion ||
            record.pair !== expected.pair ||
            record.seed !== expected.seed ||
            record.mapType !== expected.mapType ||
            record.candidateSide !== expected.candidateSide ||
            JSON.stringify(record.candidateRoster) !== JSON.stringify(rosterNames(candidateRoster)) ||
            JSON.stringify(record.opponentRoster) !== JSON.stringify(rosterNames(opponentRoster))
        ) {
            throw new Error(`Passive-turn panel record ${record.game} does not match its deterministic plan`);
        }
        candidateSeats[record.candidateSide] += 1;
        increment(maps, String(record.mapType));
        increment(endReasons, record.endReason);
        candidateEngineRejections += record.candidateEngineRejections;
        mergeMetrics(metrics, record.metrics);
        for (const [creatureName, source] of Object.entries(record.byCreature)) {
            mergeMetrics((byCreature[creatureName] ??= emptyV08PassiveTurnMetrics()), source);
        }
        const issues = [
            record.crash ? `crash: ${record.crash.split("\n")[0]}` : "",
            record.endReason === "stuck" ? "stuck" : "",
            record.endReason === "turn_cap" ? "turn cap" : "",
            record.candidateEngineRejections ? `${record.candidateEngineRejections} engine rejection(s)` : "",
            v08PassiveCreatureFaults(record.metrics)
                ? `${v08PassiveCreatureFaults(record.metrics)} passive fault(s)`
                : "",
        ].filter(Boolean);
        if (issues.length && failureSamples.length < 40) {
            failureSamples.push({
                game: record.game,
                seed: record.seed,
                mapType: record.mapType,
                candidateSide: record.candidateSide,
                issue: issues.join("; "),
            });
        }
    }

    const enabled = enabledCreatureNames();
    const enabledCreatureAppearances = Object.fromEntries(
        enabled.map((creatureName) => [creatureName, byCreature[creatureName]?.appearances ?? 0]),
    );
    const minAppearances = options.minCreatureAppearances ?? V08_PASSIVE_TURN_PANEL_DEFAULT_MIN_CREATURE_APPEARANCES;
    const underrepresentedCreatures = enabled.filter(
        (creatureName) => enabledCreatureAppearances[creatureName] < minAppearances,
    );
    const defendShare = ratio(metrics.finalDefendTurns, metrics.turns, 0);
    const eligibleWaits = metrics.sameLapWaitReactivations + metrics.missedSameLapWaitReactivations;
    const eligibleWaitReactivationRate = ratio(metrics.sameLapWaitReactivations, eligibleWaits, 1);
    const allWaitReactivationRate = ratio(metrics.sameLapWaitReactivations, metrics.waitTurns, 1);
    const abominationFaults = v08PassiveCreatureFaults(byCreature.Abomination);
    const arachnaQueenFaults = v08PassiveCreatureFaults(byCreature["Arachna Queen"]);
    const checks: Record<string, IV08PassiveTurnGate> = {
        exact_game_count: gate(records.length === options.games, records.length, `= ${options.games}`),
        unique_games: gate(seenGames.size === records.length, seenGames.size, `= ${records.length}`),
        balanced_candidate_seats: gate(
            candidateSeats.green === candidateSeats.red,
            `${candidateSeats.green}:${candidateSeats.red}`,
            "green = red",
        ),
        all_live_maps_present: gate(
            V08_PASSIVE_TURN_PANEL_MAPS.every((mapType) => (maps[String(mapType)] ?? 0) > 0),
            Object.keys(maps).length,
            `= ${V08_PASSIVE_TURN_PANEL_MAPS.length}`,
        ),
        crashes_zero: gate((endReasons.crash ?? 0) === 0, endReasons.crash ?? 0, "= 0"),
        stuck_zero: gate((endReasons.stuck ?? 0) === 0, endReasons.stuck ?? 0, "= 0"),
        turn_caps_zero: gate((endReasons.turn_cap ?? 0) === 0, endReasons.turn_cap ?? 0, "= 0"),
        engine_rejections_zero: gate(candidateEngineRejections === 0, candidateEngineRejections, "= 0"),
        raw_end_turn_zero: gate(metrics.rawEndTurnTurns === 0, metrics.rawEndTurnTurns, "= 0"),
        chosen_end_turn_zero: gate(metrics.chosenEndTurnTurns === 0, metrics.chosenEndTurnTurns, "= 0"),
        strategy_rejections_zero: gate(metrics.strategyRejectedActions === 0, metrics.strategyRejectedActions, "= 0"),
        recovery_turns_zero: gate(metrics.recoveryTurns === 0, metrics.recoveryTurns, "= 0"),
        recovery_attempts_zero: gate(metrics.recoveryAttempts === 0, metrics.recoveryAttempts, "= 0"),
        recovery_rejections_zero: gate(metrics.recoveryRejectedActions === 0, metrics.recoveryRejectedActions, "= 0"),
        incomplete_turns_zero: gate(metrics.incompleteTurns === 0, metrics.incompleteTurns, "= 0"),
        observer_pairing_faults_zero: gate(metrics.observerPairingFaults === 0, metrics.observerPairingFaults, "= 0"),
        candidate_enumeration_uncapped: gate(
            metrics.enumerationTruncations === 0,
            metrics.enumerationTruncations,
            "= 0",
        ),
        introduced_defends_zero: gate(metrics.introducedDefendTurns === 0, metrics.introducedDefendTurns, "= 0"),
        avoidable_defends_zero: gate(metrics.avoidableDefendTurns === 0, metrics.avoidableDefendTurns, "= 0"),
        raw_avoidable_defends_repaired: gate(
            metrics.repairedRawAvoidableDefendTurns === metrics.rawAvoidableDefendTurns,
            `${metrics.repairedRawAvoidableDefendTurns}/${metrics.rawAvoidableDefendTurns}`,
            "repaired = raw avoidable",
        ),
        final_defend_share: gate(
            defendShare <= V08_PASSIVE_TURN_PANEL_MAX_DEFEND_SHARE,
            defendShare,
            `<= ${V08_PASSIVE_TURN_PANEL_MAX_DEFEND_SHARE}`,
        ),
        missed_wait_reactivations_zero: gate(
            metrics.missedSameLapWaitReactivations === 0,
            metrics.missedSameLapWaitReactivations,
            "= 0",
        ),
        repeated_same_lap_waits_zero: gate(metrics.repeatedSameLapWaits === 0, metrics.repeatedSameLapWaits, "= 0"),
        eligible_wait_reactivation_rate: gate(
            eligibleWaitReactivationRate >= V08_PASSIVE_TURN_PANEL_MIN_WAIT_REACTIVATION_RATE,
            eligibleWaitReactivationRate,
            `>= ${V08_PASSIVE_TURN_PANEL_MIN_WAIT_REACTIVATION_RATE}`,
        ),
        enabled_creature_appearances: gate(
            underrepresentedCreatures.length === 0,
            underrepresentedCreatures.length,
            `all enabled creatures >= ${minAppearances}`,
        ),
        abomination_faults_zero: gate(abominationFaults === 0, abominationFaults, "= 0"),
        arachna_queen_faults_zero: gate(arachnaQueenFaults === 0, arachnaQueenFaults, "= 0"),
    };
    const failed = Object.entries(checks)
        .filter(([, check]) => !check.pass)
        .map(([name]) => name);
    return {
        schema: V08_PASSIVE_TURN_PANEL_SCHEMA,
        sourceCommit: options.sourceCommit ?? null,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        options: {
            games: options.games,
            baseSeed: options.baseSeed,
            amountMode: options.amountMode ?? "expBudget",
            liveSetup: options.liveSetup !== false,
            maxLaps: options.maxLaps ?? 60,
            minCreatureAppearances: minAppearances,
        },
        planSha256: fingerprintV08PassiveTurnPanelPlan(options),
        games: records.length,
        candidateSeats,
        maps,
        endReasons,
        candidateEngineRejections,
        metrics: cloneMetrics(metrics),
        byCreature,
        enabledCreatureAppearances,
        underrepresentedCreatures,
        defendShare,
        eligibleWaitReactivationRate,
        allWaitReactivationRate,
        abominationFaults,
        arachnaQueenFaults,
        gates: { pass: failed.length === 0, failed, checks },
        failureSamples,
    };
}

export function runV08PassiveTurnPanelConcurrent(
    options: IV08PassiveTurnPanelOptions,
    concurrency: number,
    onGame?: (record: IV08PassiveTurnPanelRecord) => void,
): Promise<IV08PassiveTurnPanelSummary> {
    validateOptions(options);
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, options.games));
    if (poolSize === 1) {
        const records = Array.from({ length: options.games }, (_, game) => runV08PassiveTurnPanelGame(options, game));
        records.forEach(onGame ?? (() => undefined));
        return Promise.resolve(summarizeV08PassiveTurnPanel(options, records));
    }
    return new Promise((resolve, reject) => {
        const records: IV08PassiveTurnPanelRecord[] = [];
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
            if (dispatched >= options.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched++ });
        };
        const workerUrl = new URL("./v0_8_passive_turn_panel_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(workerUrl, { workerData: { options } });
            workers.push(worker);
            worker.on(
                "message",
                (message: { type: "ready" } | { type: "result"; record: IV08PassiveTurnPanelRecord }) => {
                    if (settled) return;
                    if (message.type === "ready") {
                        dispatch(worker);
                        return;
                    }
                    records.push(message.record);
                    onGame?.(message.record);
                    completed += 1;
                    if (completed === options.games) {
                        settled = true;
                        cleanup();
                        resolve(summarizeV08PassiveTurnPanel(options, records));
                    } else {
                        dispatch(worker);
                    }
                },
            );
            worker.on("error", fail);
        }
    });
}

const readFlag = (args: readonly string[], name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return value;
};

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
        console.log(
            "usage: bun src/simulation/v0_8_passive_turn_panel.ts [--candidate v0.8] [--opponent v0.7] [--games 4096] [--seed 2607270813] [--concurrency 12] [--out-dir sim-out] [--min-appearances 250] [--source-commit SHA]",
        );
        return;
    }
    const candidateVersion = readFlag(args, "--candidate") ?? "v0.8";
    const opponentVersion = readFlag(args, "--opponent") ?? "v0.7";
    if (!AI_VERSIONS.includes(candidateVersion) || !AI_VERSIONS.includes(opponentVersion)) {
        throw new Error(`Unknown AI version; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    const options: IV08PassiveTurnPanelOptions = {
        candidateVersion,
        opponentVersion,
        games: Number(readFlag(args, "--games") ?? V08_PASSIVE_TURN_PANEL_DEFAULT_GAMES),
        baseSeed: Number(readFlag(args, "--seed") ?? V08_PASSIVE_TURN_PANEL_DEFAULT_SEED),
        minCreatureAppearances: Number(
            readFlag(args, "--min-appearances") ?? V08_PASSIVE_TURN_PANEL_DEFAULT_MIN_CREATURE_APPEARANCES,
        ),
        sourceCommit: readFlag(args, "--source-commit") ?? process.env.PASSIVE_PANEL_SOURCE_COMMIT,
    };
    validateOptions(options);
    const concurrency = Math.min(
        Number(readFlag(args, "--concurrency") ?? V08_PASSIVE_TURN_PANEL_DEFAULT_CONCURRENCY),
        availableParallelism(),
        options.games,
    );
    const outDir = readFlag(args, "--out-dir") ?? join(process.cwd(), "sim-out");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `v08_passive_${candidateVersion}_vs_${opponentVersion}_${options.games}_${stamp}`.replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
    );
    const recordsPath = join(outDir, `${base}.jsonl`);
    const summaryPath = join(outDir, `${base}.summary.json`);
    writeFileSync(recordsPath, "");
    process.env.SIM_NO_ACTIONS = "1";
    let completed = 0;
    const started = Date.now();
    console.log(`Running ${options.games} passive-turn games with ${concurrency} workers -> ${recordsPath}`);
    const summary = await runV08PassiveTurnPanelConcurrent(options, concurrency, (record) => {
        appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
        completed += 1;
        if (completed % 100 === 0 || completed === options.games) {
            console.log(`  ${completed}/${options.games} games`);
        }
    });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
        `Done in ${((Date.now() - started) / 1000).toFixed(1)}s; gates ${summary.gates.pass ? "PASS" : "FAIL"} -> ${summaryPath}`,
    );
    if (!summary.gates.pass) {
        console.error(`Failed gates: ${summary.gates.failed.join(", ")}`);
        process.exitCode = 1;
    }
}

if ((import.meta as unknown as { main?: boolean }).main) {
    void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
