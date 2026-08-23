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
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    buildRoster,
    createCombatFactories,
    createUnitFromSpec,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    hashSimulationParts,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
    type StackAmountMode,
} from "./army";
import {
    GREEN_TEAM,
    runMatch,
    simulationGridSettings,
    type IDecisionObservation,
    type IMatchConfig,
    type ITurnExecutionObservation,
    type Side,
} from "./battle_engine";
import { liveTwinSetup } from "./livetwin";

export const V08_ALL_UNIT_COVERAGE_SCHEMA = "hoc.v0_8_all_unit_coverage.v1" as const;
export const V08_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP = 4;
export const V08_ALL_UNIT_COVERAGE_DEFAULT_SEED = 0xa11c_0de8;
export const V08_ALL_UNIT_COVERAGE_DEFAULT_MAX_LAPS = 60;

/** Water is not selectable by the live map reducer and must not enter ranked qualification evidence. */
export const V08_ALL_UNIT_LIVE_MAPS: readonly number[] = Object.freeze([
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
]);

export interface IV08AllUnitCatalogEntry {
    unit: string;
    faction: string;
    level: number;
    size: number;
    /**
     * Native, initially remaining spell charges after Unit has materialized both configured spellbooks and
     * castable ability cards. This includes ability spells such as Vine Throw, Castling, and Resurrection.
     */
    intrinsicSpells: Readonly<Record<string, number>>;
}

const compareCatalogEntries = (left: IV08AllUnitCatalogEntry, right: IV08AllUnitCatalogEntry): number =>
    left.level - right.level || left.unit.localeCompare(right.unit) || left.faction.localeCompare(right.faction);

/**
 * Enumerate the actual enabled roster pool, then instantiate each stack without doctrines, augments, synergies,
 * thefts, or battle effects. Unit construction is the authoritative intrinsic-spell boundary: raw JSON alone
 * misses spells contributed by castable ability cards, while observing a live fight would mix in grants.
 */
export function buildV08AllUnitCatalog(): IV08AllUnitCatalogEntry[] {
    const gridSettings = simulationGridSettings();
    return [1, 2, 3, 4]
        .flatMap((level) => creaturesByLevel(level))
        .map((entry) => {
            const factories = createCombatFactories();
            const unit = createUnitFromSpec(
                {
                    faction: entry.faction,
                    creatureName: entry.creatureName,
                    level: entry.level,
                    size: entry.size,
                    amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
                },
                GREEN_TEAM,
                gridSettings,
                factories.abilityFactory,
                factories.effectFactory,
            );
            const intrinsicSpells = Object.freeze(
                Object.fromEntries(
                    unit
                        .getSpells()
                        .filter((spell) => spell.getAmount() > 0)
                        .map((spell) => [spell.getName(), spell.getAmount()] as const)
                        .sort(([left], [right]) => left.localeCompare(right)),
                ),
            );
            return Object.freeze({
                unit: entry.creatureName,
                faction: entry.faction,
                level: entry.level,
                size: entry.size,
                intrinsicSpells,
            });
        })
        .sort(compareCatalogEntries);
}

const catalogFingerprint = (catalog: readonly IV08AllUnitCatalogEntry[]): string =>
    createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

export const V08_ALL_UNIT_CATALOG: readonly IV08AllUnitCatalogEntry[] = Object.freeze(buildV08AllUnitCatalog());
export const V08_ALL_UNIT_CATALOG_SHA256 = catalogFingerprint(V08_ALL_UNIT_CATALOG);

/**
 * Deliberately pinned. Adding/removing/enabling a creature, changing its roster level/footprint, or changing
 * its intrinsic spell kit stops the panel until this identity and its focused census tests are reviewed.
 */
export const V08_ALL_UNIT_EXPECTED_CATALOG_SHA256 =
    "591455f8a38c83302e082f1d650afca503342ca946cc95c70afa71565ad09858" as const;

export function assertV08AllUnitCatalogCurrent(
    catalog: readonly IV08AllUnitCatalogEntry[] = V08_ALL_UNIT_CATALOG,
): void {
    const names = new Set<string>();
    for (const entry of catalog) {
        if (
            !entry.unit ||
            !entry.faction ||
            !Number.isSafeInteger(entry.level) ||
            entry.level < 1 ||
            entry.level > 4 ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 1 ||
            entry.size > 2 ||
            names.has(entry.unit) ||
            Object.entries(entry.intrinsicSpells).some(
                ([spell, amount]) => !spell || !Number.isSafeInteger(amount) || amount < 1,
            )
        ) {
            throw new Error("Invalid or duplicate creature in v0.8 all-unit catalog");
        }
        names.add(entry.unit);
    }
    const fingerprint = catalogFingerprint(catalog);
    if (fingerprint !== V08_ALL_UNIT_EXPECTED_CATALOG_SHA256) {
        throw new Error(
            `v0.8 all-unit catalog drift: expected ${V08_ALL_UNIT_EXPECTED_CATALOG_SHA256}, got ${fingerprint}`,
        );
    }
}

export type V08AllUnitOwner = "candidate" | "opponent";

export interface IV08AllUnitCoverageLane {
    unit: string;
    faction: string;
    level: number;
    size: number;
    intrinsicSpells: Readonly<Record<string, number>>;
    controlUnit: string;
    owner: V08AllUnitOwner;
}

function controlForTarget(target: IV08AllUnitCatalogEntry): IV08AllUnitCatalogEntry {
    const control = V08_ALL_UNIT_CATALOG.find((entry) => entry.level === target.level && entry.unit !== target.unit);
    if (!control) {
        throw new Error(`No distinct enabled level-${target.level} control for ${target.unit}`);
    }
    return control;
}

export const V08_ALL_UNIT_COVERAGE_LANES: readonly IV08AllUnitCoverageLane[] = Object.freeze(
    V08_ALL_UNIT_CATALOG.flatMap((target) => {
        const controlUnit = controlForTarget(target).unit;
        const base = {
            unit: target.unit,
            faction: target.faction,
            level: target.level,
            size: target.size,
            intrinsicSpells: target.intrinsicSpells,
            controlUnit,
        };
        return [
            Object.freeze({ ...base, owner: "candidate" as const }),
            Object.freeze({ ...base, owner: "opponent" as const }),
        ];
    }),
);

export interface IV08AllUnitCoverageOptions {
    candidateVersion: string;
    opponentVersion: string;
    /** Each lane/map cell contains this many adjacent physical-seat-swapped pairs. */
    pairsPerMap: number;
    baseSeed: number;
    /** Defaults to ranked's per-creature 1,000-XP stack budget. */
    amountMode?: StackAmountMode;
    /** Defaults true: both teams receive the shipped blind doctrine/augment setup. */
    liveSetup?: boolean;
    /** Defaults to the battle engine's production-aligned 60-lap cap. */
    maxLaps?: number;
    /** Optional source provenance copied into the summary. */
    sourceCommit?: string;
}

export interface IV08AllUnitActionAudit {
    appearances: number;
    actingTurns: number;
    spellDecisionTurns: number;
    decisionPairingFaults: number;
    completedActions: number;
    completedStrategyActions: number;
    completedRecoveryActions: number;
    recoveryTurns: number;
    rejectedStrategyActions: number;
    rejectedRecoveryActions: number;
    turnsWithoutCompletedAction: number;
    productiveActions: number;
    turnsWithoutProductiveAction: number;
    completedPassiveActions: number;
    rawEndTurnDecisions: number;
    rawEmptyDecisions: number;
    rawPassiveTurnDecisions: number;
    actionTypes: Record<string, number>;
    productiveActionTypes: Record<string, number>;
    passiveActionTypes: Record<string, number>;
    rejectionReasons: Record<string, number>;
    activeIntrinsicSpellTurns: number;
    activeIntrinsicSpellChargesObserved: number;
    activeIntrinsicSpellsObserved: Record<string, number>;
    activeIntrinsicSpellChargesByName: Record<string, number>;
    intrinsicSpellCasts: Record<string, number>;
}

export const createV08AllUnitActionAudit = (): IV08AllUnitActionAudit => ({
    appearances: 0,
    actingTurns: 0,
    spellDecisionTurns: 0,
    decisionPairingFaults: 0,
    completedActions: 0,
    completedStrategyActions: 0,
    completedRecoveryActions: 0,
    recoveryTurns: 0,
    rejectedStrategyActions: 0,
    rejectedRecoveryActions: 0,
    turnsWithoutCompletedAction: 0,
    productiveActions: 0,
    turnsWithoutProductiveAction: 0,
    completedPassiveActions: 0,
    rawEndTurnDecisions: 0,
    rawEmptyDecisions: 0,
    rawPassiveTurnDecisions: 0,
    actionTypes: {},
    productiveActionTypes: {},
    passiveActionTypes: {},
    rejectionReasons: {},
    activeIntrinsicSpellTurns: 0,
    activeIntrinsicSpellChargesObserved: 0,
    activeIntrinsicSpellsObserved: {},
    activeIntrinsicSpellChargesByName: {},
    intrinsicSpellCasts: {},
});

const PRODUCTIVE_ACTION_TYPES: ReadonlySet<GameAction["type"]> = new Set([
    "move_unit",
    "melee_attack",
    "range_attack",
    "area_throw_attack",
    "obstacle_attack",
    "cast_spell",
]);
const PASSIVE_ACTION_TYPES: ReadonlySet<GameAction["type"]> = new Set(["wait_turn", "defend_turn"]);

const increment = (counts: Record<string, number>, key: string, amount = 1): void => {
    counts[key] = (counts[key] ?? 0) + amount;
};

/**
 * The decision/execution pair is stateful so a completed cast counts as intrinsic only when that exact
 * native card still had a remaining charge immediately before the action. Granted and exhausted cards cannot
 * satisfy caster exercise, and stolen-away native cards naturally disappear from the evidence.
 */
export class V08AllUnitTargetAuditor {
    public readonly audit = createV08AllUnitActionAudit();
    private readonly pendingIntrinsicSpells = new Map<string, ReadonlySet<string>>();
    public constructor(
        public readonly lane: IV08AllUnitCoverageLane,
        public readonly targetSide: Side,
    ) {}
    public observeDecision(observation: IDecisionObservation): void {
        const side: Side = observation.unit.getTeam() === GREEN_TEAM ? "green" : "red";
        if (observation.unit.getName() !== this.lane.unit || side !== this.targetSide) {
            return;
        }
        const unitId = observation.unit.getId();
        if (this.pendingIntrinsicSpells.has(unitId)) {
            this.audit.decisionPairingFaults += 1;
        }
        this.audit.spellDecisionTurns += 1;
        const intrinsicNames = new Set(Object.keys(this.lane.intrinsicSpells));
        const remaining = observation.unit
            .getSpells()
            .filter((spell) => intrinsicNames.has(spell.getName()) && spell.isRemaining() && spell.getAmount() > 0);
        this.pendingIntrinsicSpells.set(unitId, new Set(remaining.map((spell) => spell.getName())));
        if (remaining.length > 0) {
            this.audit.activeIntrinsicSpellTurns += 1;
        }
        for (const spell of remaining) {
            const amount = spell.getAmount();
            this.audit.activeIntrinsicSpellChargesObserved += amount;
            increment(this.audit.activeIntrinsicSpellsObserved, spell.getName());
            increment(this.audit.activeIntrinsicSpellChargesByName, spell.getName(), amount);
        }
    }
    public observeTurn(observation: ITurnExecutionObservation): void {
        if (observation.creatureName !== this.lane.unit || observation.side !== this.targetSide) {
            return;
        }
        this.audit.actingTurns += 1;
        const activeIntrinsic = this.pendingIntrinsicSpells.get(observation.unitId);
        if (!activeIntrinsic) {
            this.audit.decisionPairingFaults += 1;
        } else {
            this.pendingIntrinsicSpells.delete(observation.unitId);
        }

        const rawMeaningful = observation.rawIncumbent.filter(({ type }) => type !== "select_attack_type");
        if (rawMeaningful.length === 0) {
            this.audit.rawEmptyDecisions += 1;
        }
        if (rawMeaningful.some(({ type }) => type === "end_turn")) {
            this.audit.rawEndTurnDecisions += 1;
        }
        if (rawMeaningful.some(({ type }) => PASSIVE_ACTION_TYPES.has(type))) {
            this.audit.rawPassiveTurnDecisions += 1;
        }

        const strategyAttempts = observation.strategyActions.filter(
            ({ action }) => action.type !== "select_attack_type",
        );
        const recoveryAttempts = observation.recoveryAttempts.filter(({ action }) => action !== undefined);
        const completedStrategy = strategyAttempts.filter(({ completed }) => completed);
        const completedRecovery = recoveryAttempts.filter(({ completed }) => completed);
        const rejectedStrategy = strategyAttempts.filter(({ completed }) => !completed);
        const rejectedRecovery = recoveryAttempts.filter(({ completed }) => !completed);

        this.audit.completedStrategyActions += completedStrategy.length;
        this.audit.completedRecoveryActions += completedRecovery.length;
        this.audit.completedActions += completedStrategy.length + completedRecovery.length;
        this.audit.recoveryTurns += Number(recoveryAttempts.length > 0);
        this.audit.rejectedStrategyActions += rejectedStrategy.length;
        this.audit.rejectedRecoveryActions += rejectedRecovery.length;
        if (completedStrategy.length + completedRecovery.length === 0) {
            this.audit.turnsWithoutCompletedAction += 1;
        }
        for (const attempt of [...rejectedStrategy, ...rejectedRecovery]) {
            increment(this.audit.rejectionReasons, attempt.rejectionReason ?? "unknown");
        }

        let productive = 0;
        let passive = 0;
        for (const attempt of [...completedStrategy, ...completedRecovery]) {
            const action = attempt.action!;
            increment(this.audit.actionTypes, action.type);
            if (PRODUCTIVE_ACTION_TYPES.has(action.type)) {
                productive += 1;
                increment(this.audit.productiveActionTypes, action.type);
            }
            if (PASSIVE_ACTION_TYPES.has(action.type)) {
                passive += 1;
                increment(this.audit.passiveActionTypes, action.type);
            }
            if (action.type === "cast_spell" && activeIntrinsic?.has(action.spellName)) {
                increment(this.audit.intrinsicSpellCasts, action.spellName);
            }
        }
        this.audit.productiveActions += productive;
        this.audit.completedPassiveActions += passive;
        if (productive === 0) {
            this.audit.turnsWithoutProductiveAction += 1;
        }
    }
    public finish(): void {
        this.audit.decisionPairingFaults += this.pendingIntrinsicSpells.size;
        this.pendingIntrinsicSpells.clear();
    }
}

export interface IV08AllUnitForcedRosters {
    targetIndex: number;
    targetRoster: IArmyUnitSpec[];
    controlRoster: IArmyUnitSpec[];
}

function catalogEntry(unit: string): IV08AllUnitCatalogEntry {
    const entry = V08_ALL_UNIT_CATALOG.find((candidate) => candidate.unit === unit);
    if (!entry) {
        throw new Error(`Unknown enabled all-unit coverage creature: ${unit}`);
    }
    return entry;
}

function creatureSpec(
    entry: Pick<IV08AllUnitCatalogEntry, "unit" | "faction" | "level" | "size">,
    amountMode: StackAmountMode,
): IArmyUnitSpec {
    return {
        faction: entry.faction,
        creatureName: entry.unit,
        level: entry.level,
        size: entry.size,
        amount: resolveStackAmount(entry.unit, entry.level, DEFAULT_AMOUNT_BY_LEVEL, amountMode),
    };
}

/** Build a one-variable target/control roster pair and remove every incidental copy of the target. */
export function forceV08AllUnitCoverageUnit(
    roster: readonly IArmyUnitSpec[],
    unit: string,
    amountMode: StackAmountMode = "expBudget",
): IV08AllUnitForcedRosters {
    assertV08AllUnitCatalogCurrent();
    const target = catalogEntry(unit);
    const control = controlForTarget(target);
    const sanitized = roster.map((spec) =>
        spec.creatureName === target.unit ? creatureSpec(control, amountMode) : { ...spec },
    );
    const targetIndex = sanitized.findIndex((spec) => spec.level === target.level);
    if (targetIndex < 0) {
        throw new Error(`All-unit coverage roster has no level-${target.level} slot for ${target.unit}`);
    }
    const controlRoster = sanitized.map((spec) => ({ ...spec }));
    controlRoster[targetIndex] = creatureSpec(control, amountMode);
    const targetRoster = controlRoster.map((spec) => ({ ...spec }));
    targetRoster[targetIndex] = creatureSpec(target, amountMode);

    const targetAppearances = targetRoster.filter(({ creatureName }) => creatureName === target.unit).length;
    const controlAppearances = controlRoster.filter(({ creatureName }) => creatureName === target.unit).length;
    if (targetAppearances !== 1 || controlAppearances !== 0) {
        throw new Error(
            `Expected target/control ${target.unit} appearances 1/0, got ${targetAppearances}/${controlAppearances}`,
        );
    }
    return { targetIndex, targetRoster, controlRoster };
}

function validateOptions(options: IV08AllUnitCoverageOptions): void {
    assertV08AllUnitCatalogCurrent();
    if (!Number.isSafeInteger(options.pairsPerMap) || options.pairsPerMap < 1) {
        throw new Error("pairsPerMap must be a positive integer");
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0 || options.baseSeed > 0xffffffff) {
        throw new Error("baseSeed must be a uint32 integer");
    }
    const maxLaps = options.maxLaps ?? V08_ALL_UNIT_COVERAGE_DEFAULT_MAX_LAPS;
    if (!Number.isSafeInteger(maxLaps) || maxLaps < 1) {
        throw new Error("maxLaps must be a positive integer");
    }
}

export function getV08AllUnitCoverageGameCount(options: IV08AllUnitCoverageOptions): number {
    validateOptions(options);
    return options.pairsPerMap * V08_ALL_UNIT_COVERAGE_LANES.length * V08_ALL_UNIT_LIVE_MAPS.length * 2;
}

interface IV08AllUnitScheduleCell {
    game: number;
    pair: number;
    repetition: number;
    seed: number;
    mapType: number;
    lane: IV08AllUnitCoverageLane;
    candidateSide: Side;
    targetSide: Side;
}

export interface IV08AllUnitCoverageGamePlan extends IV08AllUnitScheduleCell {
    targetIndex: number;
    greenRoster: IArmyUnitSpec[];
    redRoster: IArmyUnitSpec[];
}

function scheduleV08AllUnitCoverageGame(options: IV08AllUnitCoverageOptions, game: number): IV08AllUnitScheduleCell {
    const total = getV08AllUnitCoverageGameCount(options);
    if (!Number.isSafeInteger(game) || game < 0 || game >= total) {
        throw new Error(`All-unit coverage game index ${game} is outside [0, ${total})`);
    }
    const pair = Math.floor(game / 2);
    const cell = Math.floor(pair / options.pairsPerMap);
    const repetition = pair % options.pairsPerMap;
    const mapIndex = cell % V08_ALL_UNIT_LIVE_MAPS.length;
    const laneIndex = Math.floor(cell / V08_ALL_UNIT_LIVE_MAPS.length);
    const lane = V08_ALL_UNIT_COVERAGE_LANES[laneIndex]!;
    const mapType = V08_ALL_UNIT_LIVE_MAPS[mapIndex]!;
    const seed = hashSimulationParts(
        "v0.8-all-unit-coverage",
        options.baseSeed,
        V08_ALL_UNIT_CATALOG_SHA256,
        lane.unit,
        lane.owner,
        mapType,
        repetition,
    );
    const candidateSide: Side = game % 2 === 0 ? "green" : "red";
    const targetSide: Side = lane.owner === "candidate" ? candidateSide : candidateSide === "green" ? "red" : "green";
    return { game, pair, repetition, seed, mapType, lane, candidateSide, targetSide };
}

const scheduleIdentity = ({
    game,
    pair,
    repetition,
    seed,
    mapType,
    lane,
    candidateSide,
    targetSide,
}: IV08AllUnitScheduleCell): IV08AllUnitScheduleCell => ({
    game,
    pair,
    repetition,
    seed,
    mapType,
    lane,
    candidateSide,
    targetSide,
});

/** Hash the complete target/owner/map/seed/physical-seat schedule, independent of worker completion order. */
export function fingerprintV08AllUnitCoveragePlan(options: IV08AllUnitCoverageOptions): string {
    const total = getV08AllUnitCoverageGameCount(options);
    return createHash("sha256")
        .update(
            JSON.stringify(
                Array.from({ length: total }, (_, game) =>
                    scheduleIdentity(scheduleV08AllUnitCoverageGame(options, game)),
                ),
            ),
        )
        .digest("hex");
}

export function planV08AllUnitCoverageGame(
    options: IV08AllUnitCoverageOptions,
    game: number,
): IV08AllUnitCoverageGamePlan {
    const schedule = scheduleV08AllUnitCoverageGame(options, game);
    const amountMode = options.amountMode ?? "expBudget";
    const baseRoster = buildRoster(makeRng(schedule.seed), undefined, DEFAULT_AMOUNT_BY_LEVEL, undefined, amountMode);
    const { targetIndex, targetRoster, controlRoster } = forceV08AllUnitCoverageUnit(
        baseRoster,
        schedule.lane.unit,
        amountMode,
    );
    const candidateRoster = schedule.lane.owner === "candidate" ? targetRoster : controlRoster;
    const opponentRoster = schedule.lane.owner === "opponent" ? targetRoster : controlRoster;
    return {
        ...schedule,
        targetIndex,
        greenRoster: schedule.candidateSide === "green" ? candidateRoster : opponentRoster,
        redRoster: schedule.candidateSide === "green" ? opponentRoster : candidateRoster,
    };
}

export interface IV08AllUnitCoverageRecord {
    schema: typeof V08_ALL_UNIT_COVERAGE_SCHEMA;
    catalogSha256: string;
    game: number;
    pair: number;
    repetition: number;
    seed: number;
    mapType: number;
    lane: IV08AllUnitCoverageLane;
    candidateVersion: string;
    opponentVersion: string;
    candidateSide: Side;
    targetSide: Side;
    targetIndex: number;
    greenRoster: string[];
    redRoster: string[];
    winner: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck" | "crash";
    crash?: string;
    rejectedCandidate: number;
    rejectedOpponent: number;
    target: IV08AllUnitActionAudit;
}

const rosterNames = (roster: readonly IArmyUnitSpec[]): string[] => roster.map(({ creatureName }) => creatureName);

export function runV08AllUnitCoverageGame(
    options: IV08AllUnitCoverageOptions,
    game: number,
): IV08AllUnitCoverageRecord {
    const plan = planV08AllUnitCoverageGame(options, game);
    const targetRoster = plan.targetSide === "green" ? plan.greenRoster : plan.redRoster;
    const auditor = new V08AllUnitTargetAuditor(plan.lane, plan.targetSide);
    auditor.audit.appearances = targetRoster.filter(({ creatureName }) => creatureName === plan.lane.unit).length;
    const recordBase = {
        schema: V08_ALL_UNIT_COVERAGE_SCHEMA,
        catalogSha256: V08_ALL_UNIT_CATALOG_SHA256,
        game,
        pair: plan.pair,
        repetition: plan.repetition,
        seed: plan.seed,
        mapType: plan.mapType,
        lane: plan.lane,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        candidateSide: plan.candidateSide,
        targetSide: plan.targetSide,
        targetIndex: plan.targetIndex,
        greenRoster: rosterNames(plan.greenRoster),
        redRoster: rosterNames(plan.redRoster),
    };
    if (auditor.audit.appearances !== 1) {
        throw new Error(`All-unit coverage plan expected one ${plan.lane.unit}; found ${auditor.audit.appearances}`);
    }

    try {
        const setup = options.liveSetup === false ? undefined : liveTwinSetup();
        const config: IMatchConfig = {
            greenVersion: plan.candidateSide === "green" ? options.candidateVersion : options.opponentVersion,
            redVersion: plan.candidateSide === "green" ? options.opponentVersion : options.candidateVersion,
            roster: plan.greenRoster,
            redRoster: plan.redRoster,
            seed: plan.seed,
            maxLaps: options.maxLaps ?? V08_ALL_UNIT_COVERAGE_DEFAULT_MAX_LAPS,
            gridType: plan.mapType,
            greenDoctrine: setup?.doctrine,
            redDoctrine: setup?.doctrine,
            greenAugments: setup?.augments,
            redAugments: setup?.augments,
            decisionObserver: (observation) => auditor.observeDecision(observation),
            turnExecutionObserver: (observation) => auditor.observeTurn(observation),
        };
        const result = runMatch(config);
        auditor.finish();
        const winner =
            result.winner === "draw" ? "draw" : result.winner === plan.candidateSide ? "candidate" : "opponent";
        const candidateIsGreen = plan.candidateSide === "green";
        return {
            ...recordBase,
            winner,
            laps: result.laps,
            endReason: result.endReason,
            rejectedCandidate: candidateIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
            rejectedOpponent: candidateIsGreen ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0),
            target: auditor.audit,
        };
    } catch (error) {
        auditor.finish();
        return {
            ...recordBase,
            winner: "draw",
            laps: 0,
            endReason: "crash",
            crash: error instanceof Error ? (error.stack ?? error.message) : String(error),
            rejectedCandidate: 0,
            rejectedOpponent: 0,
            target: auditor.audit,
        };
    }
}

export interface IV08AllUnitMapCensus {
    mapType: number;
    games: number;
    candidateGreenGames: number;
    candidateRedGames: number;
}

export interface IV08AllUnitCoverageLaneSummary extends IV08AllUnitActionAudit {
    lane: IV08AllUnitCoverageLane;
    games: number;
    candidateGreenGames: number;
    candidateRedGames: number;
    mapCensus: IV08AllUnitMapCensus[];
    candidateWins: number;
    opponentWins: number;
    draws: number;
    endReasons: Record<string, number>;
    rejectedCandidate: number;
    rejectedOpponent: number;
}

export interface IV08AllUnitCoverageGate {
    pass: boolean;
    actual: number | string;
    expected: string;
}

export interface IV08AllUnitCoverageSummary {
    schema: typeof V08_ALL_UNIT_COVERAGE_SCHEMA;
    sourceCommit: string | null;
    catalogSha256: string;
    expectedCatalogSha256: typeof V08_ALL_UNIT_EXPECTED_CATALOG_SHA256;
    catalog: readonly IV08AllUnitCatalogEntry[];
    eligibleIntrinsicCasters: string[];
    candidateVersion: string;
    opponentVersion: string;
    options: {
        pairsPerMap: number;
        baseSeed: number;
        amountMode: StackAmountMode;
        liveSetup: boolean;
        maxLaps: number;
    };
    maps: readonly number[];
    planSha256: string;
    games: number;
    candidateSeats: Record<Side, number>;
    endReasons: Record<string, number>;
    rejectedCandidate: number;
    rejectedOpponent: number;
    lanes: IV08AllUnitCoverageLaneSummary[];
    gates: {
        pass: boolean;
        failed: string[];
        checks: Record<string, IV08AllUnitCoverageGate>;
    };
    failureSamples: Array<{
        game: number;
        unit: string;
        owner: V08AllUnitOwner;
        mapType: number;
        candidateSide: Side;
        issue: string;
    }>;
}

const AUDIT_SCALARS = [
    "appearances",
    "actingTurns",
    "spellDecisionTurns",
    "decisionPairingFaults",
    "completedActions",
    "completedStrategyActions",
    "completedRecoveryActions",
    "recoveryTurns",
    "rejectedStrategyActions",
    "rejectedRecoveryActions",
    "turnsWithoutCompletedAction",
    "productiveActions",
    "turnsWithoutProductiveAction",
    "completedPassiveActions",
    "rawEndTurnDecisions",
    "rawEmptyDecisions",
    "rawPassiveTurnDecisions",
    "activeIntrinsicSpellTurns",
    "activeIntrinsicSpellChargesObserved",
] as const satisfies readonly (keyof IV08AllUnitActionAudit)[];

const AUDIT_COUNTS = [
    "actionTypes",
    "productiveActionTypes",
    "passiveActionTypes",
    "rejectionReasons",
    "activeIntrinsicSpellsObserved",
    "activeIntrinsicSpellChargesByName",
    "intrinsicSpellCasts",
] as const satisfies readonly (keyof IV08AllUnitActionAudit)[];

const mergeAudit = (target: IV08AllUnitActionAudit, source: IV08AllUnitActionAudit): void => {
    for (const key of AUDIT_SCALARS) target[key] += source[key];
    for (const key of AUDIT_COUNTS) {
        for (const [name, count] of Object.entries(source[key])) increment(target[key], name, count);
    }
};

const laneKey = ({ unit, owner }: Pick<IV08AllUnitCoverageLane, "unit" | "owner">): string => `${unit}:${owner}`;

const gate = (pass: boolean, actual: number | string, expected: string): IV08AllUnitCoverageGate => ({
    pass,
    actual,
    expected,
});

const countValues = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((total, count) => total + count, 0);

function assertAuditConsistent(audit: IV08AllUnitActionAudit, lane: IV08AllUnitCoverageLane, game: number): void {
    if (
        AUDIT_SCALARS.some((key) => !Number.isSafeInteger(audit[key]) || audit[key] < 0) ||
        AUDIT_COUNTS.some((key) =>
            Object.entries(audit[key]).some(([name, count]) => !name || !Number.isSafeInteger(count) || count < 1),
        ) ||
        audit.completedActions !== audit.completedStrategyActions + audit.completedRecoveryActions ||
        countValues(audit.actionTypes) !== audit.completedActions ||
        countValues(audit.productiveActionTypes) !== audit.productiveActions ||
        countValues(audit.passiveActionTypes) !== audit.completedPassiveActions ||
        countValues(audit.rejectionReasons) !== audit.rejectedStrategyActions + audit.rejectedRecoveryActions ||
        countValues(audit.activeIntrinsicSpellChargesByName) !== audit.activeIntrinsicSpellChargesObserved ||
        audit.spellDecisionTurns > audit.actingTurns + audit.decisionPairingFaults ||
        audit.activeIntrinsicSpellTurns > audit.spellDecisionTurns ||
        audit.turnsWithoutCompletedAction > audit.actingTurns ||
        audit.turnsWithoutProductiveAction > audit.actingTurns ||
        [...Object.keys(audit.activeIntrinsicSpellsObserved), ...Object.keys(audit.intrinsicSpellCasts)].some(
            (spell) => !(spell in lane.intrinsicSpells),
        ) ||
        Object.entries(audit.activeIntrinsicSpellsObserved).some(
            ([spell, observations]) =>
                (audit.activeIntrinsicSpellChargesByName[spell] ?? 0) < observations ||
                (audit.intrinsicSpellCasts[spell] ?? 0) > observations,
        ) ||
        Object.entries(audit.intrinsicSpellCasts).some(
            ([spell, casts]) =>
                casts > (audit.activeIntrinsicSpellChargesByName[spell] ?? 0) ||
                casts > (audit.actionTypes.cast_spell ?? 0),
        )
    ) {
        throw new Error(`Inconsistent all-unit target audit in game ${game}`);
    }
}

export function summarizeV08AllUnitCoverage(
    options: IV08AllUnitCoverageOptions,
    records: readonly IV08AllUnitCoverageRecord[],
): IV08AllUnitCoverageSummary {
    validateOptions(options);
    const total = getV08AllUnitCoverageGameCount(options);
    const byLane = new Map<string, IV08AllUnitCoverageLaneSummary>(
        V08_ALL_UNIT_COVERAGE_LANES.map((lane) => [
            laneKey(lane),
            {
                lane,
                games: 0,
                candidateGreenGames: 0,
                candidateRedGames: 0,
                mapCensus: V08_ALL_UNIT_LIVE_MAPS.map((mapType) => ({
                    mapType,
                    games: 0,
                    candidateGreenGames: 0,
                    candidateRedGames: 0,
                })),
                candidateWins: 0,
                opponentWins: 0,
                draws: 0,
                endReasons: {},
                rejectedCandidate: 0,
                rejectedOpponent: 0,
                ...createV08AllUnitActionAudit(),
            },
        ]),
    );
    const seen = new Set<number>();
    const candidateSeats: Record<Side, number> = { green: 0, red: 0 };
    const endReasons: Record<string, number> = {};
    const failureSamples: IV08AllUnitCoverageSummary["failureSamples"] = [];
    let rejectedCandidate = 0;
    let rejectedOpponent = 0;

    for (const record of records) {
        if (seen.has(record.game)) {
            throw new Error(`Duplicate all-unit coverage game record: ${record.game}`);
        }
        seen.add(record.game);
        const expected = scheduleV08AllUnitCoverageGame(options, record.game);
        const plan = planV08AllUnitCoverageGame(options, record.game);
        if (
            record.schema !== V08_ALL_UNIT_COVERAGE_SCHEMA ||
            record.catalogSha256 !== V08_ALL_UNIT_CATALOG_SHA256 ||
            record.candidateVersion !== options.candidateVersion ||
            record.opponentVersion !== options.opponentVersion ||
            JSON.stringify(scheduleIdentity(record)) !== JSON.stringify(scheduleIdentity(expected)) ||
            record.targetIndex !== plan.targetIndex ||
            JSON.stringify(record.greenRoster) !== JSON.stringify(rosterNames(plan.greenRoster)) ||
            JSON.stringify(record.redRoster) !== JSON.stringify(rosterNames(plan.redRoster))
        ) {
            throw new Error(`All-unit coverage record ${record.game} does not match its deterministic plan`);
        }
        assertAuditConsistent(record.target, record.lane, record.game);
        const cell = byLane.get(laneKey(record.lane));
        if (!cell) {
            throw new Error(`Unknown all-unit coverage lane in record ${record.game}`);
        }
        cell.games += 1;
        candidateSeats[record.candidateSide] += 1;
        if (record.candidateSide === "green") cell.candidateGreenGames += 1;
        else cell.candidateRedGames += 1;
        const mapCell = cell.mapCensus.find(({ mapType }) => mapType === record.mapType);
        if (!mapCell) {
            throw new Error(`Non-live map ${record.mapType} in all-unit coverage record ${record.game}`);
        }
        mapCell.games += 1;
        if (record.candidateSide === "green") mapCell.candidateGreenGames += 1;
        else mapCell.candidateRedGames += 1;
        if (record.winner === "candidate") cell.candidateWins += 1;
        else if (record.winner === "opponent") cell.opponentWins += 1;
        else cell.draws += 1;
        increment(cell.endReasons, record.endReason);
        increment(endReasons, record.endReason);
        cell.rejectedCandidate += record.rejectedCandidate;
        cell.rejectedOpponent += record.rejectedOpponent;
        rejectedCandidate += record.rejectedCandidate;
        rejectedOpponent += record.rejectedOpponent;
        mergeAudit(cell, record.target);

        const issues = [
            record.crash ? `crash: ${record.crash.split("\n")[0]}` : "",
            record.endReason === "stuck" ? "stuck" : "",
            record.endReason === "turn_cap" ? "turn cap" : "",
            record.rejectedCandidate ? `${record.rejectedCandidate} candidate engine rejection(s)` : "",
            record.lane.owner === "candidate" && record.target.rejectedStrategyActions
                ? `${record.target.rejectedStrategyActions} target strategy rejection(s)`
                : "",
            record.lane.owner === "candidate" && record.target.rejectedRecoveryActions
                ? `${record.target.rejectedRecoveryActions} target recovery rejection(s)`
                : "",
            record.lane.owner === "candidate" && record.target.rawEndTurnDecisions + record.target.rawEmptyDecisions > 0
                ? `${record.target.rawEndTurnDecisions + record.target.rawEmptyDecisions} raw no-op(s)`
                : "",
        ].filter(Boolean);
        if (issues.length > 0 && failureSamples.length < 80) {
            failureSamples.push({
                game: record.game,
                unit: record.lane.unit,
                owner: record.lane.owner,
                mapType: record.mapType,
                candidateSide: record.candidateSide,
                issue: issues.join("; "),
            });
        }
    }

    const lanes = [...byLane.values()];
    const candidateLanes = lanes.filter(({ lane }) => lane.owner === "candidate");
    const eligibleIntrinsicCasters = V08_ALL_UNIT_CATALOG.filter(
        ({ intrinsicSpells }) => Object.keys(intrinsicSpells).length > 0,
    ).map(({ unit }) => unit);
    const casterLanes = candidateLanes.filter(({ lane }) => Object.keys(lane.intrinsicSpells).length > 0);
    const expectedLaneGames = options.pairsPerMap * V08_ALL_UNIT_LIVE_MAPS.length * 2;
    const exactLaneCensus = lanes.every(
        (lane) =>
            lane.games === expectedLaneGames &&
            lane.candidateGreenGames === expectedLaneGames / 2 &&
            lane.candidateRedGames === expectedLaneGames / 2,
    );
    const exactMapCensus = lanes.every((lane) =>
        lane.mapCensus.every(
            (map) =>
                map.games === options.pairsPerMap * 2 &&
                map.candidateGreenGames === options.pairsPerMap &&
                map.candidateRedGames === options.pairsPerMap,
        ),
    );
    const checks: Record<string, IV08AllUnitCoverageGate> = {
        exact_catalog: gate(
            V08_ALL_UNIT_CATALOG_SHA256 === V08_ALL_UNIT_EXPECTED_CATALOG_SHA256,
            V08_ALL_UNIT_CATALOG_SHA256,
            `= ${V08_ALL_UNIT_EXPECTED_CATALOG_SHA256}`,
        ),
        exact_schedule_count: gate(
            records.length === total && seen.size === total,
            `${records.length}:${seen.size}`,
            `= ${total}:${total}`,
        ),
        exact_lane_census: gate(
            exactLaneCensus,
            lanes.filter(({ games }) => games === expectedLaneGames).length,
            `= ${lanes.length}`,
        ),
        exact_map_census: gate(
            exactMapCensus,
            lanes.filter((lane) => lane.mapCensus.every(({ games }) => games === options.pairsPerMap * 2)).length,
            `= ${lanes.length}`,
        ),
        balanced_physical_seats: gate(
            candidateSeats.green === candidateSeats.red && candidateSeats.green + candidateSeats.red === total,
            `${candidateSeats.green}:${candidateSeats.red}`,
            `= ${total / 2}:${total / 2}`,
        ),
        exact_target_appearances: gate(
            lanes.every(({ appearances, games }) => appearances === games),
            lanes.filter(({ appearances, games }) => appearances === games).length,
            `= ${lanes.length}`,
        ),
        crashes_zero: gate((endReasons.crash ?? 0) === 0, endReasons.crash ?? 0, "= 0"),
        stuck_zero: gate((endReasons.stuck ?? 0) === 0, endReasons.stuck ?? 0, "= 0"),
        turn_caps_zero: gate((endReasons.turn_cap ?? 0) === 0, endReasons.turn_cap ?? 0, "= 0"),
        candidate_engine_rejections_zero: gate(rejectedCandidate === 0, rejectedCandidate, "= 0"),
        candidate_target_strategy_rejections_zero: gate(
            candidateLanes.every(({ rejectedStrategyActions }) => rejectedStrategyActions === 0),
            candidateLanes.reduce((sum, lane) => sum + lane.rejectedStrategyActions, 0),
            "= 0",
        ),
        candidate_target_recovery_zero: gate(
            candidateLanes.every(
                ({ recoveryTurns, completedRecoveryActions, rejectedRecoveryActions }) =>
                    recoveryTurns === 0 && completedRecoveryActions === 0 && rejectedRecoveryActions === 0,
            ),
            candidateLanes.reduce(
                (sum, lane) => sum + lane.recoveryTurns + lane.completedRecoveryActions + lane.rejectedRecoveryActions,
                0,
            ),
            "= 0",
        ),
        candidate_target_raw_no_op_zero: gate(
            candidateLanes.every(
                ({ rawEndTurnDecisions, rawEmptyDecisions }) => rawEndTurnDecisions + rawEmptyDecisions === 0,
            ),
            candidateLanes.reduce((sum, lane) => sum + lane.rawEndTurnDecisions + lane.rawEmptyDecisions, 0),
            "= 0",
        ),
        candidate_target_incomplete_turns_zero: gate(
            candidateLanes.every(
                ({ turnsWithoutCompletedAction, decisionPairingFaults }) =>
                    turnsWithoutCompletedAction === 0 && decisionPairingFaults === 0,
            ),
            candidateLanes.reduce(
                (sum, lane) => sum + lane.turnsWithoutCompletedAction + lane.decisionPairingFaults,
                0,
            ),
            "= 0",
        ),
        candidate_target_productivity: gate(
            candidateLanes.every(({ actingTurns, productiveActions }) => actingTurns > 0 && productiveActions > 0),
            candidateLanes.filter(({ actingTurns, productiveActions }) => actingTurns > 0 && productiveActions > 0)
                .length,
            `= ${candidateLanes.length}`,
        ),
        remaining_intrinsic_casters_exercised: gate(
            casterLanes.every(
                ({ activeIntrinsicSpellChargesObserved, intrinsicSpellCasts }) =>
                    activeIntrinsicSpellChargesObserved > 0 && countValues(intrinsicSpellCasts) > 0,
            ) && casterLanes.length === eligibleIntrinsicCasters.length,
            casterLanes.filter(
                ({ activeIntrinsicSpellChargesObserved, intrinsicSpellCasts }) =>
                    activeIntrinsicSpellChargesObserved > 0 && countValues(intrinsicSpellCasts) > 0,
            ).length,
            `= ${eligibleIntrinsicCasters.length}`,
        ),
    };
    const failed = Object.entries(checks)
        .filter(([, check]) => !check.pass)
        .map(([name]) => name);
    return {
        schema: V08_ALL_UNIT_COVERAGE_SCHEMA,
        sourceCommit: options.sourceCommit ?? null,
        catalogSha256: V08_ALL_UNIT_CATALOG_SHA256,
        expectedCatalogSha256: V08_ALL_UNIT_EXPECTED_CATALOG_SHA256,
        catalog: V08_ALL_UNIT_CATALOG,
        eligibleIntrinsicCasters,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        options: {
            pairsPerMap: options.pairsPerMap,
            baseSeed: options.baseSeed,
            amountMode: options.amountMode ?? "expBudget",
            liveSetup: options.liveSetup !== false,
            maxLaps: options.maxLaps ?? V08_ALL_UNIT_COVERAGE_DEFAULT_MAX_LAPS,
        },
        maps: V08_ALL_UNIT_LIVE_MAPS,
        planSha256: fingerprintV08AllUnitCoveragePlan(options),
        games: records.length,
        candidateSeats,
        endReasons,
        rejectedCandidate,
        rejectedOpponent,
        lanes,
        gates: { pass: failed.length === 0, failed, checks },
        failureSamples,
    };
}

export function runV08AllUnitCoverageConcurrent(
    options: IV08AllUnitCoverageOptions,
    concurrency: number,
    onGame?: (record: IV08AllUnitCoverageRecord) => void,
): Promise<IV08AllUnitCoverageSummary> {
    const total = getV08AllUnitCoverageGameCount(options);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new Error("All-unit coverage concurrency must be a positive integer");
    }
    const poolSize = Math.min(concurrency, total);
    if (poolSize === 1) {
        const records = Array.from({ length: total }, (_, game) => runV08AllUnitCoverageGame(options, game));
        records.forEach(onGame ?? (() => undefined));
        return Promise.resolve(summarizeV08AllUnitCoverage(options, records));
    }
    return new Promise((resolve, reject) => {
        const records: IV08AllUnitCoverageRecord[] = [];
        const liveWorkers = new Set<Worker>();
        const stoppingWorkers = new WeakSet<Worker>();
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): Promise<void> => {
            // Bun can leave terminate() unresolved when another worker in the pool already self-exited. Every
            // worker has a stop protocol, so close the remaining workers through it and wait for real exits.
            const pending = new Set(liveWorkers);
            if (pending.size === 0) return Promise.resolve();
            return new Promise((accept) => {
                for (const worker of pending) {
                    worker.once("exit", () => {
                        pending.delete(worker);
                        if (pending.size === 0) accept();
                    });
                    if (!stoppingWorkers.has(worker)) {
                        stoppingWorkers.add(worker);
                        worker.postMessage({ type: "stop" });
                    }
                }
            });
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            void cleanup().then(() => reject(error instanceof Error ? error : new Error(String(error))));
        };
        const succeed = (): void => {
            if (settled) return;
            settled = true;
            let summary: IV08AllUnitCoverageSummary;
            try {
                summary = summarizeV08AllUnitCoverage(options, records);
            } catch (error) {
                void cleanup().then(() => reject(error instanceof Error ? error : new Error(String(error))));
                return;
            }
            void cleanup().then(() => resolve(summary));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= total) {
                stoppingWorkers.add(worker);
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched++ });
        };
        const workerUrl = new URL("./v0_8_all_unit_coverage_worker.ts", import.meta.url);
        try {
            for (let index = 0; index < poolSize; index += 1) {
                const worker = new Worker(workerUrl, { workerData: { options } });
                liveWorkers.add(worker);
                worker.on(
                    "message",
                    (message: { type: "ready" } | { type: "result"; record: IV08AllUnitCoverageRecord }) => {
                        if (settled) return;
                        try {
                            if (message.type === "ready") {
                                dispatch(worker);
                                return;
                            }
                            records.push(message.record);
                            onGame?.(message.record);
                            completed += 1;
                            if (completed === total) {
                                succeed();
                            } else {
                                dispatch(worker);
                            }
                        } catch (error) {
                            fail(error);
                        }
                    },
                );
                worker.on("error", fail);
                worker.on("exit", (code) => {
                    liveWorkers.delete(worker);
                    if (!settled && (code !== 0 || !stoppingWorkers.has(worker))) {
                        fail(new Error(`All-unit coverage worker exited before completion with code ${code}`));
                    }
                });
            }
        } catch (error) {
            fail(error);
        }
    });
}

async function main(): Promise<void> {
    const [candidateVersion, opponentVersion, pairsArg, seedArg, outDirArg, concurrencyArg, sourceCommitArg] =
        process.argv.slice(2);
    if (!candidateVersion || !opponentVersion) {
        console.error(
            "usage: v0_8_all_unit_coverage <candidateVersion> <opponentVersion> [pairsPerMap] [baseSeed] [outDir] [concurrency] [sourceCommit]",
        );
        process.exitCode = 1;
        return;
    }
    if (!AI_VERSIONS.includes(candidateVersion) || !AI_VERSIONS.includes(opponentVersion)) {
        throw new Error(`Unknown version; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    const options: IV08AllUnitCoverageOptions = {
        candidateVersion,
        opponentVersion,
        pairsPerMap: pairsArg ? Number(pairsArg) : V08_ALL_UNIT_COVERAGE_DEFAULT_PAIRS_PER_MAP,
        baseSeed: seedArg ? Number(seedArg) : V08_ALL_UNIT_COVERAGE_DEFAULT_SEED,
        sourceCommit: sourceCommitArg,
    };
    const total = getV08AllUnitCoverageGameCount(options);
    const requestedConcurrency = concurrencyArg ? Number(concurrencyArg) : availableParallelism();
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
        throw new Error("concurrency must be a positive integer");
    }
    const concurrency = Math.min(requestedConcurrency, total);
    const outDir = outDirArg ?? join(process.cwd(), "sim-out");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `v08_all_unit_${candidateVersion}_vs_${opponentVersion}_${stamp}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const jsonlPath = join(outDir, `${base}.jsonl`);
    const summaryPath = join(outDir, `${base}.summary.json`);
    writeFileSync(jsonlPath, "");
    let completed = 0;
    const started = Date.now();
    console.log(
        `Running ${total} all-unit coverage games (${options.pairsPerMap} pairs/lane/map, concurrency ${concurrency}) -> ${jsonlPath}`,
    );
    const summary = await runV08AllUnitCoverageConcurrent(options, concurrency, (record) => {
        appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
        completed += 1;
        if (completed % 100 === 0 || completed === total) console.log(`  ${completed}/${total} games...`);
    });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Summary -> ${summaryPath}`);
    if (!summary.gates.pass) {
        console.error(`Qualification failed: ${summary.gates.failed.join(", ")}`);
        process.exitCode = 1;
    }
}

if ((import.meta as unknown as { main?: boolean }).main) {
    // Keep module evaluation alive until worker termination settles. With a detached promise Bun can exit after
    // the last worker closes, before this CLI resumes to persist its summary.
    await main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
