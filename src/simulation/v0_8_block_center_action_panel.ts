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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import { evaluateAffectedUnits } from "../abilities/aoe_range_ability";
import { AI_VERSIONS } from "../ai";
import {
    enumerateCandidates,
    evaluateRangeCandidateDamage,
    type ICandidateSet,
    type IEnumeratedCandidate,
} from "../ai/candidates";
import { decisionFireWalls } from "../ai/decision_fight_state";
import { decisionPathSource, type IReadonlyWeightedRoute } from "../ai/decision_path_catalog";
import { meleeAttackTypeSelectionPrefix } from "../ai/melee_attack_type";
import {
    buildV08BacklineProtectorIntent,
    buildV08BacklineWardIntent,
    isV08BacklineProtectorPureMoveMeaningful,
    isV08BacklineWardPureMoveMeaningful,
    preservesV08BacklineProtectorIntent,
    preservesV08BacklineWardIntent,
    type IV08BacklineProtectorIntent,
    type IV08BacklineWardIntent,
} from "../ai/versions/v0_8_backline_protector";
import { buildV08A13SearchEnvironment } from "../ai/versions/v0_8_a13_profile";
import { selectV08DamageSpellCandidate } from "../ai/versions/v0_8";
import type { IDecisionContext } from "../ai/ai_strategy";
import type { GameAction } from "../engine/actions";
import { projectPostMoveActorAvailability } from "../engine/post_move_actor_availability";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    getCellsAroundCell,
    getCellsAroundFootprint,
    getPositionForCell,
    getPositionForCells,
    getRangeAttackSideCenter,
    isCellWithinGrid,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
} from "../grid/grid_math";
import {
    canCastSpell,
    canMassCastSpell,
    isSpellUsableByCaster,
    isTargetedSpellLineOfSightClear,
} from "../spells/spell_helper";
import type { Spell } from "../spells/spell";
import {
    applyMagicResistToSpellDamage,
    calculateSpellDamage,
    isOffensiveSpellMultiplier,
} from "../spells/spell_damage";
import { SpellTargetType } from "../spells/spell_properties";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { buildRoster, DEFAULT_AMOUNT_BY_LEVEL, makeRng, type IArmyUnitSpec, type StackAmountMode } from "./army";
import {
    GREEN_TEAM,
    runMatch,
    type IDecisionObservation,
    type IMatchConfig,
    type ITurnExecutionObservation,
    type Side,
} from "./battle_engine";
import { liveTwinSetup } from "./livetwin";
import { withScopedAIEnvironment } from "./v0_8_a13_search";

export const V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA = "hoc.v0_8_block_center_action_panel.v3" as const;
export const V08_BLOCK_CENTER_ACTION_PANEL_DEFAULT_GAMES = 50_000;
export const V08_BLOCK_CENTER_ACTION_PANEL_DEFAULT_SEED = 2_607_280_041;
export const V08_BLOCK_CENTER_ACTION_PANEL_DEFAULT_CONCURRENCY = 12;
export const V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP = 9;
export const V08_BLOCK_CENTER_ACTION_PANEL_MAX_SAMPLES_PER_GAME = 32;
export const V08_BLOCK_CENTER_ACTION_PANEL_MAX_SUMMARY_SAMPLES = 100;

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
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
const URGENT_SAMPLE_ISSUES = new Set<V08BlockCenterIssue>([
    "catalog_missed_engine_valid_combat",
    "noncombat_with_direct_option",
    "mountain_adjacent_missed_attack",
    "non_progress_move",
    "urgent_mountain_terminal_jitter",
    "eligible_combat_drought",
    "lap9_direct_action_miss",
]);

/**
 * BattleEngine invokes the panel after SearchDriver commits, but intentionally exposes the same decision
 * context. Diagnostic reachability and enumeration use an observer-local context so they cannot mutate the live
 * one-shot path cache or its counters.
 */
const observerLocalDecisionContext = (context: IDecisionContext): IDecisionContext => ({
    ...context,
    decisionPathCatalog: undefined,
});

export type V08BlockCenterMountainState = "both_intact" | "left_only" | "right_only" | "cleared";
const V08_BLOCK_CENTER_MOUNTAIN_STATES = [
    "both_intact",
    "left_only",
    "right_only",
    "cleared",
] as const satisfies readonly V08BlockCenterMountainState[];
export type V08BlockCenterDirectKind = "melee" | "shot" | "area_throw" | "spell";
export type V08BlockCenterIssue =
    | "oracle_probe_rejection"
    | "catalog_probe_rejection"
    | "catalog_missed_engine_valid_combat"
    | "noncombat_with_direct_option"
    | "mountain_adjacent_missed_attack"
    | "non_progress_move"
    | "aba_oscillation"
    | "urgent_mountain_terminal_jitter"
    | "eligible_combat_drought"
    | "lap9_direct_action_miss";

export interface IV08BlockCenterActionPanelOptions {
    candidateVersion: string;
    opponentVersion: string;
    /** Must be positive and even: adjacent games are a physical-seat swap. */
    games: number;
    baseSeed: number;
    amountMode?: StackAmountMode;
    liveSetup?: boolean;
    maxLaps?: number;
    /**
     * Preserve a caller-supplied candidate/genome environment. Standalone qualification defaults false and
     * seals v0.8/v0.8s to a13; campaign child processes set true so the panel audits their finalist unchanged.
     */
    inheritCandidateEnvironment?: boolean;
    /** Exact source checkout used by the process. A production pass requires a clean 40-character SHA. */
    sourceCommit?: string;
    /** Set by the CLI from git status; a dirty source is recorded but can never pass qualification. */
    sourceDirty?: boolean;
}

export interface IV08BlockCenterActionPlan {
    game: number;
    pair: number;
    seed: number;
    mapType: typeof PBTypes.GridVals.BLOCK_CENTER;
    candidateSide: Side;
    greenRoster: IArmyUnitSpec[];
    redRoster: IArmyUnitSpec[];
}

export interface IV08BlockCenterDirectOption {
    kind: V08BlockCenterDirectKind;
    actions: GameAction[];
    targetId?: string;
    spellName?: string;
    standCell?: XY;
    aimCell?: XY;
}

export interface IV08BlockCenterMetrics {
    observedTurns: number;
    oracleDirectEligibleTurns: number;
    sharedCatalogDirectEligibleTurns: number;
    oracleProbeRejections: number;
    catalogProbeRejections: number;
    catalogMissedEngineValidCombat: number;
    urgentCatalogMisses: number;
    sharedCatalogEnumerationTruncations: number;
    chosenDirectActionTurns: number;
    noncombatWithDirectOptionTurns: number;
    nonDamagingSpellExemptions: number;
    mountainAdjacentTurns: number;
    mountainAdjacentDirectEligibleTurns: number;
    mountainAdjacentMissedAttacks: number;
    urgentMountainAdjacentMisses: number;
    pureMoveTurns: number;
    nonProgressMoves: number;
    urgentRepeatedNonProgressWithDirectOption: number;
    urgentMountainTerminalJitter: number;
    abaOscillations: number;
    eligibleCombatMisses: number;
    eligibleCombatDroughts: number;
    urgentCombatDroughts: number;
    lateDirectEligibleTurns: number;
    lateDirectActionMisses: number;
    strategyRejectedActions: number;
    recoveryTurns: number;
    observerPairingFaults: number;
}

export interface IV08BlockCenterFailureSample {
    issue: V08BlockCenterIssue;
    game: number;
    pair: number;
    seed: number;
    candidateSide: Side;
    unitId: string;
    creatureName: string;
    lap: number;
    mountainState: V08BlockCenterMountainState;
    actorCells: XY[];
    enemyCells: XY[];
    chosenDecision: GameAction[];
    oracleOption?: IV08BlockCenterDirectOption;
    stateSha256: string;
    detail: string;
}

export interface IV08BlockCenterActionRecord {
    schema: typeof V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA;
    sourceCommit: string | null;
    sourceDirty: boolean;
    game: number;
    pair: number;
    seed: number;
    mapType: typeof PBTypes.GridVals.BLOCK_CENTER;
    candidateVersion: string;
    opponentVersion: string;
    inheritCandidateEnvironment: boolean;
    candidateSide: Side;
    candidateRoster: string[];
    opponentRoster: string[];
    winner: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck" | "crash";
    crash?: string;
    candidateEngineRejections: number;
    metrics: IV08BlockCenterMetrics;
    byCreature: Record<string, IV08BlockCenterMetrics>;
    mountainStates: Record<V08BlockCenterMountainState, number>;
    failureSamples: IV08BlockCenterFailureSample[];
}

export interface IV08BlockCenterActionGate {
    pass: boolean;
    actual: number | string;
    expected: string;
}

export interface IV08BlockCenterActionSummary {
    schema: typeof V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA;
    sourceCommit: string | null;
    sourceDirty: boolean;
    candidateVersion: string;
    opponentVersion: string;
    options: {
        games: number;
        baseSeed: number;
        amountMode: StackAmountMode;
        liveSetup: boolean;
        maxLaps: number;
        inheritCandidateEnvironment: boolean;
    };
    planSha256: string;
    games: number;
    candidateSeats: Record<Side, number>;
    maps: Record<string, number>;
    endReasons: Record<string, number>;
    candidateEngineRejections: number;
    metrics: IV08BlockCenterMetrics;
    byCreature: Record<string, IV08BlockCenterMetrics>;
    mountainStates: Record<V08BlockCenterMountainState, number>;
    gates: {
        pass: boolean;
        failed: string[];
        checks: Record<string, IV08BlockCenterActionGate>;
    };
    failureSamples: IV08BlockCenterFailureSample[];
}

interface IV08BlockCenterRoleIntents {
    protector?: IV08BacklineProtectorIntent;
    ward?: IV08BacklineWardIntent;
}

interface IV08BlockCenterPendingDecision {
    unitId: string;
    creatureName: string;
    lap: number;
    mountainState: V08BlockCenterMountainState;
    mountainAdjacent: boolean;
    stationaryMountainAvailable: boolean;
    actorCells: XY[];
    enemyCells: XY[];
    enemyStateKey: string;
    stateSha256: string;
    oracleOption?: IV08BlockCenterDirectOption;
    catalogDirect: boolean;
    catalogMiss: boolean;
    damagingSpellNames: Set<string>;
    meleeOnly: boolean;
    terminalEscapeAvailable: boolean;
    meaningfulRoleMoveSignatures: Set<string>;
    probeFailures: Array<{
        source: "oracle" | "catalog";
        actions: GameAction[];
        failure: string;
    }>;
}

interface IV08BlockCenterMovementHistory {
    footprints: string[];
    enemyStateKey: string;
    eligibleCombatMisses: number;
    consecutiveNonDamageTurns: number;
    consecutiveUnproductiveMountainMoves: number;
}

const METRIC_KEYS = [
    "observedTurns",
    "oracleDirectEligibleTurns",
    "sharedCatalogDirectEligibleTurns",
    "oracleProbeRejections",
    "catalogProbeRejections",
    "catalogMissedEngineValidCombat",
    "urgentCatalogMisses",
    "sharedCatalogEnumerationTruncations",
    "chosenDirectActionTurns",
    "noncombatWithDirectOptionTurns",
    "nonDamagingSpellExemptions",
    "mountainAdjacentTurns",
    "mountainAdjacentDirectEligibleTurns",
    "mountainAdjacentMissedAttacks",
    "urgentMountainAdjacentMisses",
    "pureMoveTurns",
    "nonProgressMoves",
    "urgentRepeatedNonProgressWithDirectOption",
    "urgentMountainTerminalJitter",
    "abaOscillations",
    "eligibleCombatMisses",
    "eligibleCombatDroughts",
    "urgentCombatDroughts",
    "lateDirectEligibleTurns",
    "lateDirectActionMisses",
    "strategyRejectedActions",
    "recoveryTurns",
    "observerPairingFaults",
] as const satisfies readonly (keyof IV08BlockCenterMetrics)[];

const FAILURE_SAMPLE_METRIC = {
    oracle_probe_rejection: "oracleProbeRejections",
    catalog_probe_rejection: "catalogProbeRejections",
    catalog_missed_engine_valid_combat: "catalogMissedEngineValidCombat",
    noncombat_with_direct_option: "noncombatWithDirectOptionTurns",
    mountain_adjacent_missed_attack: "mountainAdjacentMissedAttacks",
    non_progress_move: "nonProgressMoves",
    aba_oscillation: "abaOscillations",
    urgent_mountain_terminal_jitter: "urgentMountainTerminalJitter",
    eligible_combat_drought: "eligibleCombatDroughts",
    lap9_direct_action_miss: "lateDirectActionMisses",
} as const satisfies Record<V08BlockCenterIssue, keyof IV08BlockCenterMetrics>;

const LATE_FAILURE_SAMPLE_METRIC = {
    catalog_missed_engine_valid_combat: "urgentCatalogMisses",
    noncombat_with_direct_option: "lateDirectActionMisses",
    mountain_adjacent_missed_attack: "urgentMountainAdjacentMisses",
    eligible_combat_drought: "urgentCombatDroughts",
} as const satisfies Partial<Record<V08BlockCenterIssue, keyof IV08BlockCenterMetrics>>;

export const emptyV08BlockCenterMetrics = (): IV08BlockCenterMetrics => ({
    observedTurns: 0,
    oracleDirectEligibleTurns: 0,
    sharedCatalogDirectEligibleTurns: 0,
    oracleProbeRejections: 0,
    catalogProbeRejections: 0,
    catalogMissedEngineValidCombat: 0,
    urgentCatalogMisses: 0,
    sharedCatalogEnumerationTruncations: 0,
    chosenDirectActionTurns: 0,
    noncombatWithDirectOptionTurns: 0,
    nonDamagingSpellExemptions: 0,
    mountainAdjacentTurns: 0,
    mountainAdjacentDirectEligibleTurns: 0,
    mountainAdjacentMissedAttacks: 0,
    urgentMountainAdjacentMisses: 0,
    pureMoveTurns: 0,
    nonProgressMoves: 0,
    urgentRepeatedNonProgressWithDirectOption: 0,
    urgentMountainTerminalJitter: 0,
    abaOscillations: 0,
    eligibleCombatMisses: 0,
    eligibleCombatDroughts: 0,
    urgentCombatDroughts: 0,
    lateDirectEligibleTurns: 0,
    lateDirectActionMisses: 0,
    strategyRejectedActions: 0,
    recoveryTurns: 0,
    observerPairingFaults: 0,
});

const emptyMountainStates = (): Record<V08BlockCenterMountainState, number> => ({
    both_intact: 0,
    left_only: 0,
    right_only: 0,
    cleared: 0,
});

const cloneCells = (cells: readonly XY[]): XY[] => cells.map((cell) => ({ x: cell.x, y: cell.y }));
const cellKey = (cell: XY): string => `${cell.x},${cell.y}`;
const footprintKey = (cells: readonly XY[]): string =>
    [...cells]
        .sort((left, right) => left.x - right.x || left.y - right.y)
        .map(cellKey)
        .join(";");
const enemyStateKey = (enemies: readonly Unit[]): string =>
    enemies
        .map((enemy) => `${enemy.getId()}:${footprintKey(enemy.getCells())}`)
        .sort()
        .join("|");
const isAdjacent = (left: XY, right: XY): boolean =>
    Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) <= 1;
const sideForUnit = (unit: Unit): Side => (unit.getTeam() === GREEN_TEAM ? "green" : "red");
const otherTeam = (team: number): number => (team === LOWER ? UPPER : LOWER);
const isHidden = (unit: Unit): boolean => unit.hasBuffActive("Hidden") || unit.hasAbilityActive("Hidden");

export function v08BlockCenterFootprintDistance(left: readonly XY[], right: readonly XY[]): number {
    let closest = Infinity;
    for (const a of left) {
        for (const b of right) {
            closest = Math.min(closest, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
        }
    }
    return closest;
}

export function v08BlockCenterFootprintManhattanDistance(left: readonly XY[], right: readonly XY[]): number {
    let closest = Infinity;
    for (const a of left) {
        for (const b of right) {
            closest = Math.min(closest, Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
        }
    }
    return closest;
}

export function isV08BlockCenterNonProgressMove(
    before: readonly XY[],
    after: readonly XY[],
    enemyCells: readonly XY[],
): boolean {
    if (!before.length || !after.length || !enemyCells.length) return false;
    return v08BlockCenterFootprintDistance(after, enemyCells) >= v08BlockCenterFootprintDistance(before, enemyCells);
}

/**
 * The hard terminal signal keeps the conservative Chebyshev plateau detector, but a remote move that closes
 * Manhattan distance is real route progress around the obstacle. An actor with an engine-valid stationary
 * mountain strike remains eligible: moving laterally away from that productive action is the cycle this gate
 * protects. Raw adjacency is insufficient because a live forced target can make the obstacle action illegal.
 */
export function isV08BlockCenterTerminalNonProgressMove(
    before: readonly XY[],
    after: readonly XY[],
    enemyCells: readonly XY[],
    stationaryMountainAvailable: boolean,
): boolean {
    return (
        isV08BlockCenterNonProgressMove(before, after, enemyCells) &&
        (stationaryMountainAvailable ||
            v08BlockCenterFootprintManhattanDistance(after, enemyCells) >=
                v08BlockCenterFootprintManhattanDistance(before, enemyCells))
    );
}

export function isV08BlockCenterABAOscillation(history: readonly string[], nextFootprint: string): boolean {
    if (history.length < 2) return false;
    const a = history[history.length - 2];
    const b = history[history.length - 1];
    return a !== b && nextFootprint === a;
}

/**
 * Keep every physical A-B-A return as an informational oscillation, but reserve the hard failure for a stable
 * tactical state or a return that still fails to close. An enemy that crosses the board between activations can
 * make the actor's old footprint the newly correct pursuit route; rejecting that response would punish motion,
 * not a stall. Identity is part of the caller's enemy-state key so a replacement stack at the same cells also
 * counts as a changed tactical state.
 */
export function isV08BlockCenterUrgentMountainABAOscillation(
    lap: number,
    mountainState: V08BlockCenterMountainState,
    meleeOnly: boolean,
    meaningfulRoleMove: boolean,
    abaOscillation: boolean,
    enemyStateChanged = false,
    closesCurrentEnemyDistance = false,
): boolean {
    return (
        lap >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP &&
        mountainState !== "cleared" &&
        meleeOnly &&
        !meaningfulRoleMove &&
        abaOscillation &&
        (!enemyStateChanged || !closesCurrentEnemyDistance)
    );
}

/**
 * A hard late-game stall signal independent of direct-action reachability. Requiring two consecutive
 * non-progressing pure moves by a melee-only stack, while an obstacle remains, rejects lateral jitter behind
 * BLOCK_CENTER without treating a single pathfinding sidestep as a policy failure. Role-preserving protector or
 * ward relocation and every move that closes enemy distance reset the sequence before this predicate is called.
 */
export function isV08BlockCenterUrgentMountainTerminalJitter(
    lap: number,
    mountainState: V08BlockCenterMountainState,
    meleeOnly: boolean,
    meaningfulRoleMove: boolean,
    nonProgress: boolean,
    precedingUnproductiveMountainMoves: number,
): boolean {
    return (
        lap >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP &&
        mountainState !== "cleared" &&
        meleeOnly &&
        !meaningfulRoleMove &&
        nonProgress &&
        precedingUnproductiveMountainMoves >= 1
    );
}

export const isV08BlockCenterNonDamagingSpellTurnExempt = (lap: number): boolean =>
    lap < V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP;

export function v08BlockCenterActionSignature(actions: readonly GameAction[]): string {
    const cell = (value?: XY): string => (value ? `${value.x},${value.y}` : "-");
    return actions
        .map((action) => {
            switch (action.type) {
                case "select_attack_type":
                    return `select:${action.attackType}`;
                case "move_unit":
                    return `move:${cell(action.path.at(-1))}:${footprintKey(action.targetCells ?? [])}`;
                case "melee_attack":
                    return `melee:${action.targetId}@${cell(action.attackFrom)}`;
                case "range_attack":
                    return `range:${action.targetId}@${cell(action.aimCell)}/${action.aimSide ?? "-"}`;
                case "area_throw_attack":
                    return `area:${cell(action.targetCell)}`;
                case "cast_spell":
                    return `spell:${action.spellName}>${action.targetId ?? "-"}@${cell(action.targetCell)}`;
                case "obstacle_attack":
                    return `obstacle:${cell(action.attackFrom)}>${cell(action.targetPosition)}`;
                default:
                    return action.type;
            }
        })
        .join("|");
}

const footprintForBase = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ x: base.x, y: base.y }]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

const routeMoveAction = (unit: Unit, route: IReadonlyWeightedRoute): Extract<GameAction, { type: "move_unit" }> => ({
    type: "move_unit",
    unitId: unit.getId(),
    path: route.route.map((cell) => ({ x: cell.x, y: cell.y })),
    targetCells: footprintForBase(unit, route.cell),
    hasLavaCell: route.hasLavaCell,
    hasWaterCell: route.hasWaterCell,
});

const landingIsValid = (unit: Unit, context: IDecisionContext, base: XY): boolean => {
    const cells = footprintForBase(unit, base);
    return (
        cells.length > 0 &&
        (context.grid.areAllCellsEmpty(cells, unit.getId()) ||
            context.grid.canOccupyCells(
                cells,
                unit.canTraverseLava(),
                unit.hasAbilityActive("Made of Water"),
                unit.getId(),
            ))
    );
};

const routesForUnit = (unit: Unit, context: IDecisionContext): IReadonlyWeightedRoute[] => {
    if (!unit.canMove()) return [];
    const movePath = decisionPathSource(context).getMovePath(
        unit.getBaseCell(),
        context.matrix,
        unit.getSteps(),
        context.grid.getAggrMatrixByTeam(otherTeam(unit.getTeam())),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("In Its Own World"),
    );
    const routes: IReadonlyWeightedRoute[] = [];
    const seen = new Set<string>();
    for (const routeList of movePath.knownPaths.values()) {
        for (const route of routeList) {
            if (!route?.route.length || !landingIsValid(unit, context, route.cell)) continue;
            const key = `${cellKey(route.cell)}:${route.route.map(cellKey).join(";")}`;
            if (seen.has(key)) continue;
            seen.add(key);
            routes.push(route);
        }
    }
    return routes;
};

const roleIntents = (unit: Unit, context: IDecisionContext): IV08BlockCenterRoleIntents => ({
    protector: buildV08BacklineProtectorIntent(unit, context),
    ward: buildV08BacklineWardIntent(unit, context),
});

const preservesRole = (
    intents: IV08BlockCenterRoleIntents,
    unit: Unit,
    context: IDecisionContext,
    actions: readonly GameAction[],
): boolean =>
    (!intents.protector || preservesV08BacklineProtectorIntent(intents.protector, unit, context, actions)) &&
    (!intents.ward || preservesV08BacklineWardIntent(intents.ward, unit, context, actions));

const physicalDamageCanLand = (
    attacker: Unit,
    target: Unit,
    ranged: boolean,
    context: IDecisionContext,
    divisor = 1,
): boolean => {
    const attackerAbilityPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(attacker.getTeam()) ?? 0;
    const targetAbilityPower = context.fightProperties?.getAdditionalAbilityPowerPerTeam(target.getTeam()) ?? 0;
    let maximum = attacker.calculateAttackDamageMax(
        attacker.getAttack(),
        target,
        ranged,
        attackerAbilityPower,
        divisor,
    );
    // Unit.calculateAttackDamage applies a native shooter's 0.5 melee penalty after the raw roll and floors
    // the result. Its raw helper clamps to at least one, so testing that helper alone manufactures a
    // "damaging" melee option when the only possible roll is 1 and the authoritative hit is always 0.
    if (!ranged && attacker.getAttackType() === RANGE && !attacker.hasAbilityActive("Handyman")) {
        maximum = Math.floor(maximum * 0.5);
    }
    const miss = attacker.calculateMissChance(target, targetAbilityPower);
    return maximum > 0 && miss < 100;
};

const liveForcedTargetId = (unit: Unit, context: IDecisionContext): string | undefined => {
    const forced = context.unitsHolder.getAllUnits().get(unit.getTarget());
    return forced && !forced.isDead() ? forced.getId() : undefined;
};

const legalEnemyTargets = (unit: Unit, context: IDecisionContext): Unit[] => {
    const forcedTargetId = liveForcedTargetId(unit, context);
    return context.unitsHolder
        .getAllEnemyUnits(unit.getTeam())
        .filter(
            (enemy) =>
                !enemy.isDead() &&
                !isHidden(enemy) &&
                (!forcedTargetId || forcedTargetId === enemy.getId()) &&
                !unit.cannotAttackUnitId(enemy.getId()),
        )
        .sort((left, right) => left.getId().localeCompare(right.getId()));
};

const canSelectMelee = (unit: Unit): boolean =>
    !unit.hasAbilityActive("No Melee") &&
    ([MELEE, MELEE_MAGIC] as number[]).some(
        (attackType) =>
            unit.getAttackTypeSelection() === attackType || unit.getPossibleAttackTypes().includes(attackType),
    );

const projectedCumulativeHp = (projection: ReturnType<typeof projectPostMoveActorAvailability>): number =>
    (projection.stack.amountAlive - 1) * projection.stack.maxHp + Math.max(0, projection.stack.hp);

const actorAfterRoute = (
    unit: Unit,
    context: IDecisionContext,
    route: IReadonlyWeightedRoute,
): ReturnType<typeof projectPostMoveActorAvailability> | undefined => {
    const projection = projectPostMoveActorAvailability(
        unit,
        decisionFireWalls(context),
        routeMoveAction(unit, route),
        route,
    );
    // GameActionEngine removes a killed mover before its suffix. A self-resurrected mover is deliberately
    // excluded too: candidate enumeration treats that cleanup edge as a standalone move, not a composite.
    return projection.availableAfterMove && !projection.resurrected ? projection : undefined;
};

/**
 * A lateral move is not an avoidable stall when congestion, terrain, and role constraints leave no closer
 * landing. Prove one exact alternative from uncapped reachability and the authoritative engine before a later
 * A-B-A or repeated non-progress move can become a hard policy fault.
 */
const hasEngineValidStrictProgressMove = (
    unit: Unit,
    context: IDecisionContext,
    intents: IV08BlockCenterRoleIntents,
    enemyCells: readonly XY[],
    accept: (actions: readonly GameAction[]) => boolean,
): boolean => {
    const beforeDistance = v08BlockCenterFootprintDistance(unit.getCells(), enemyCells);
    if (!Number.isFinite(beforeDistance)) return false;
    for (const route of routesForUnit(unit, context)) {
        const action = routeMoveAction(unit, route);
        if (
            !actorAfterRoute(unit, context, route) ||
            v08BlockCenterFootprintDistance(action.targetCells ?? [], enemyCells) >= beforeDistance ||
            !preservesRole(intents, unit, context, [action])
        ) {
            continue;
        }
        if (accept([action])) return true;
    }
    return false;
};

function findIndependentMeleeOption(
    unit: Unit,
    context: IDecisionContext,
    intents: IV08BlockCenterRoleIntents,
    routes: readonly IReadonlyWeightedRoute[],
    accept: V08BlockCenterDirectOptionAcceptance,
): IV08BlockCenterDirectOption | undefined {
    if (!canSelectMelee(unit)) return undefined;
    const targets = legalEnemyTargets(unit, context).filter((target) =>
        physicalDamageCanLand(unit, target, false, context),
    );
    if (!targets.length) return undefined;
    const prefix = meleeAttackTypeSelectionPrefix(unit);
    const base = unit.getBaseCell();
    const stands: Array<{ base: XY; route?: IReadonlyWeightedRoute; cumulativeHp: number }> = [
        { base, cumulativeHp: unit.getCumulativeHp() },
    ];
    for (const route of routes) {
        if (route.cell.x === base.x && route.cell.y === base.y) {
            continue;
        }
        const projected = actorAfterRoute(unit, context, route);
        if (!projected) continue;
        stands.push({ base: route.cell, route, cumulativeHp: projectedCumulativeHp(projected) });
    }
    const seen = new Set<string>();
    for (const stand of stands) {
        const standKey = cellKey(stand.base);
        if (seen.has(standKey)) continue;
        seen.add(standKey);
        const footprint = footprintForBase(unit, stand.base);
        for (const target of targets) {
            if (unit.hasDebuffActive("Cowardice") && stand.cumulativeHp < target.getCumulativeHp()) continue;
            if (!footprint.some((mine) => target.getCells().some((enemy) => isAdjacent(mine, enemy)))) continue;
            const actions: GameAction[] = [...prefix];
            if (stand.route && (stand.base.x !== base.x || stand.base.y !== base.y)) {
                actions.push(routeMoveAction(unit, stand.route));
            }
            actions.push({
                type: "melee_attack",
                attackerId: unit.getId(),
                targetId: target.getId(),
                attackFrom: { x: stand.base.x, y: stand.base.y },
            });
            if (!preservesRole(intents, unit, context, actions)) continue;
            const option: IV08BlockCenterDirectOption = {
                kind: "melee",
                actions,
                targetId: target.getId(),
                standCell: { ...stand.base },
            };
            if (accept(option)) return option;
        }
    }
    return undefined;
}

interface IIndependentRangeOrigin {
    position: XY;
    route?: IReadonlyWeightedRoute;
    cumulativeHp: number;
    amountAlive: number;
}

type V08BlockCenterDirectOptionAcceptance = (option: IV08BlockCenterDirectOption) => boolean;
const acceptEveryDirectOption: V08BlockCenterDirectOptionAcceptance = () => true;

function findIndependentRangeOption(
    unit: Unit,
    context: IDecisionContext,
    intents: IV08BlockCenterRoleIntents,
    routes: readonly IReadonlyWeightedRoute[],
    accept: V08BlockCenterDirectOptionAcceptance,
): IV08BlockCenterDirectOption | undefined {
    const attackHandler = context.attackHandler;
    const canSelectRange = unit.getAttackTypeSelection() === RANGE || unit.getPossibleAttackTypes().includes(RANGE);
    if (
        !attackHandler ||
        !canSelectRange ||
        !unit.isRangeCapable() ||
        unit.getRangeShots() <= 0 ||
        unit.hasDebuffActive("Range Null Field Aura") ||
        unit.hasStatusApplied("Rangebane")
    ) {
        return undefined;
    }
    const enemyAggression = context.grid.getEnemyAggrMatrixByUnitId(unit.getId());
    const origins: IIndependentRangeOrigin[] = [];
    if (attackHandler.canLandRangeAttack(unit, enemyAggression)) {
        origins.push({
            position: unit.getPosition(),
            cumulativeHp: unit.getCumulativeHp(),
            amountAlive: unit.getAmountAlive(),
        });
    }
    const base = unit.getBaseCell();
    for (const route of routes) {
        if ((route.cell.x === base.x && route.cell.y === base.y) || route.hasLavaCell || route.hasWaterCell) {
            continue;
        }
        const projected = actorAfterRoute(unit, context, route);
        if (!projected) continue;
        const position = getPositionForCells(context.grid.getSettings(), footprintForBase(unit, route.cell));
        if (position && !attackHandler.canBeAttackedByMelee(position, unit.isSmallSize(), enemyAggression)) {
            origins.push({
                position,
                route,
                cumulativeHp: projectedCumulativeHp(projected),
                amountAlive: projected.stack.amountAlive,
            });
        }
    }
    if (!origins.length) return undefined;
    const enemies = legalEnemyTargets(unit, context);
    const forcedTargetId = liveForcedTargetId(unit, context);
    const isThrough = unit.hasAbilityActive("Through Shot");
    const isArea = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
    const shots = unit.getAbility("Double Shot") || unit.getAbility("Crafted Double Shot") ? 2 : 1;
    const prefix: GameAction[] =
        unit.getAttackTypeSelection() === RANGE
            ? []
            : [{ type: "select_attack_type", unitId: unit.getId(), attackType: RANGE }];
    for (const origin of origins) {
        for (const aimedEnemy of enemies) {
            for (const aimCell of aimedEnemy.getCells()) {
                for (const aimSide of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(context.matrix, aimCell, aimSide, unit.getTeam(), isThrough)) {
                        continue;
                    }
                    const targetPosition = getRangeAttackSideCenter(
                        context.grid.getSettings(),
                        aimCell,
                        aimSide,
                        origin.position,
                    );
                    const evaluation = attackHandler.evaluateRangeAttack(
                        context.unitsHolder.getAllUnits(),
                        unit,
                        origin.position,
                        targetPosition,
                        isThrough,
                        false,
                        isArea,
                    );
                    const primary = evaluation.affectedUnits[0]?.[0];
                    if (
                        !primary ||
                        primary.isDead() ||
                        primary.getTeam() === unit.getTeam() ||
                        isHidden(primary) ||
                        unit.cannotAttackUnitId(primary.getId()) ||
                        (forcedTargetId && forcedTargetId !== primary.getId()) ||
                        (!isThrough &&
                            unit.hasDebuffActive("Cowardice") &&
                            origin.cumulativeHp < primary.getCumulativeHp()) ||
                        evaluation.affectedUnits.length !== evaluation.rangeAttackDivisors.length
                    ) {
                        continue;
                    }
                    const divisor = evaluation.rangeAttackDivisors[0] ?? 1;
                    if (!physicalDamageCanLand(unit, primary, true, context, divisor)) continue;
                    const damage = evaluateRangeCandidateDamage(
                        unit,
                        context,
                        evaluation,
                        primary.getId(),
                        shots,
                        isArea,
                        aimedEnemy.getId(),
                        origin.amountAlive,
                    );
                    if (!(damage.value > 0)) continue;
                    const actions: GameAction[] = [];
                    if (origin.route) actions.push(routeMoveAction(unit, origin.route));
                    actions.push(...prefix, {
                        type: "range_attack",
                        attackerId: unit.getId(),
                        targetId: aimedEnemy.getId(),
                        aimCell: { ...aimCell },
                        aimSide,
                    });
                    if (!preservesRole(intents, unit, context, actions)) continue;
                    const option: IV08BlockCenterDirectOption = {
                        kind: "shot",
                        actions,
                        targetId: primary.getId(),
                        aimCell: { ...aimCell },
                    };
                    if (accept(option)) return option;
                }
            }
        }
    }
    return undefined;
}

function findIndependentAreaThrowOption(
    unit: Unit,
    context: IDecisionContext,
    intents: IV08BlockCenterRoleIntents,
    accept: V08BlockCenterDirectOptionAcceptance,
): IV08BlockCenterDirectOption | undefined {
    const attackHandler = context.attackHandler;
    const canSelectRange = unit.getAttackTypeSelection() === RANGE || unit.getPossibleAttackTypes().includes(RANGE);
    if (!attackHandler || !unit.hasAbilityActive("Area Throw") || unit.getRangeShots() <= 0 || !canSelectRange) {
        return undefined;
    }
    const settings = context.grid.getSettings();
    const prefix: GameAction[] =
        unit.getAttackTypeSelection() === RANGE
            ? []
            : [{ type: "select_attack_type", unitId: unit.getId(), attackType: RANGE }];
    const shots = unit.getAbility("Double Shot") || unit.getAbility("Crafted Double Shot") ? 2 : 1;
    const forcedTargetId = liveForcedTargetId(unit, context);
    for (let x = 0; x < settings.getGridSize(); x += 1) {
        for (let y = 0; y < settings.getGridSize(); y += 1) {
            const targetCell = { x, y };
            const occupant = context.grid.getOccupantUnitId(targetCell);
            if (occupant && occupant !== "L" && occupant !== "W") continue;
            const projected = attackHandler.projectAreaThrowTargetCell(
                context.unitsHolder.getAllUnits(),
                unit,
                targetCell,
            );
            const affected = evaluateAffectedUnits(
                [...getCellsAroundCell(settings, projected), projected],
                context.unitsHolder,
                context.grid,
            );
            const primary = affected?.[0]?.[0];
            if (
                !primary ||
                unit.cannotAttackUnitId(primary.getId()) ||
                (forcedTargetId && primary.getId() !== forcedTargetId)
            ) {
                continue;
            }
            const enemy = affected
                .flat()
                .find(
                    (target) =>
                        !target.isDead() &&
                        target.getTeam() !== unit.getTeam() &&
                        physicalDamageCanLand(unit, target, true, context),
                );
            if (!enemy) continue;
            const targetPosition = getPositionForCell(
                projected,
                settings.getMinX(),
                settings.getStep(),
                settings.getHalfStep(),
            );
            const divisor = attackHandler.getRangeAttackDivisor(unit, targetPosition);
            const damage = evaluateRangeCandidateDamage(
                unit,
                context,
                { affectedUnits: affected, rangeAttackDivisors: affected.map(() => divisor) },
                primary.getId(),
                shots,
                true,
            );
            if (!(damage.value > 0)) continue;
            const actions: GameAction[] = [
                ...prefix,
                { type: "area_throw_attack", attackerId: unit.getId(), targetCell: { ...targetCell } },
            ];
            if (!preservesRole(intents, unit, context, actions)) continue;
            const option: IV08BlockCenterDirectOption = {
                kind: "area_throw",
                actions,
                targetId: enemy.getId(),
                aimCell: { ...targetCell },
            };
            if (accept(option)) return option;
        }
    }
    return undefined;
}

const spellDamage = (caster: Unit, spell: Spell, target: Unit): number =>
    applyMagicResistToSpellDamage(
        calculateSpellDamage(
            spell.getMultiplierType(),
            spell.getPower(),
            caster.getAmountAlive(),
            caster.getStackPower(),
            caster.getMagicDamageBonusPercentage(),
        ),
        target.getMagicResist(),
    );

const canTargetOffensiveSpell = (caster: Unit, target: Unit, spell: Spell, context: IDecisionContext): boolean => {
    const settings = context.grid.getSettings();
    return (
        !target.isDead() &&
        target.getTeam() !== caster.getTeam() &&
        !isHidden(target) &&
        canCastSpell(
            false,
            settings,
            context.matrix,
            caster,
            target,
            spell,
            target.getBaseCell(),
            target.getMagicResist(),
            target.hasMindAttackResistance(),
            target.canBeHealed(),
            undefined,
        ) === true &&
        isTargetedSpellLineOfSightClear(
            spell.getName(),
            context.grid,
            (cell) => isCellWithinGrid(settings, cell),
            caster.getBaseCell(),
            target.getBaseCell(),
        )
    );
};

const ringOfFireNetDamage = (
    caster: Unit,
    target: Unit,
    spell: Spell,
    context: IDecisionContext,
): number | undefined => {
    const cells = getCellsAroundFootprint(
        context.grid.getSettings(),
        target.isSmallSize() ? [target.getBaseCell()] : target.getCells(),
    );
    const caught = (evaluateAffectedUnits(cells, context.unitsHolder, context.grid)?.[0] ?? []).filter(
        (victim) => !victim.isDead() && victim.getId() !== caster.getId() && victim.getId() !== target.getId(),
    );
    if (!caught.length) return undefined;
    const enemyTeam = caster.getTeam() === LOWER ? UPPER : LOWER;
    return caught.reduce((value, victim) => {
        const damage = Math.min(spellDamage(caster, spell, victim), victim.getCumulativeHp());
        return value + (victim.getTeam() === enemyTeam ? damage : -damage);
    }, 0);
};

function findMeteorOption(
    caster: Unit,
    spell: Spell,
    context: IDecisionContext,
    intents: IV08BlockCenterRoleIntents,
    accept: V08BlockCenterDirectOptionAcceptance,
): IV08BlockCenterDirectOption | undefined {
    const settings = context.grid.getSettings();
    const spread = spell.getName() === "Meteor Shower" ? [-1, 0, 1] : [0, 1];
    for (let x = 0; x < settings.getGridSize(); x += 1) {
        for (let y = 0; y < settings.getGridSize(); y += 1) {
            const anchor = { x, y };
            const cells = spread.flatMap((dx) => spread.map((dy) => ({ x: x + dx, y: y + dy })));
            if (cells.some((cell) => !isCellWithinGrid(settings, cell))) continue;
            const victim = (evaluateAffectedUnits(cells, context.unitsHolder, context.grid)?.[0] ?? []).find(
                (unit) => unit.getTeam() !== caster.getTeam() && !unit.isDead() && spellDamage(caster, spell, unit) > 0,
            );
            if (!victim) continue;
            const actions: GameAction[] = [
                {
                    type: "cast_spell",
                    casterId: caster.getId(),
                    spellName: spell.getName(),
                    targetCell: { ...anchor },
                },
            ];
            if (!preservesRole(intents, caster, context, actions)) continue;
            const option: IV08BlockCenterDirectOption = {
                kind: "spell",
                actions,
                targetId: victim.getId(),
                spellName: spell.getName(),
                aimCell: anchor,
            };
            if (accept(option)) return option;
        }
    }
    return undefined;
}

function findIndependentSpellOption(
    unit: Unit,
    context: IDecisionContext,
    intents: IV08BlockCenterRoleIntents,
    accept: V08BlockCenterDirectOptionAcceptance,
): IV08BlockCenterDirectOption | undefined {
    for (const spell of unit.getSpells()) {
        if (!isSpellUsableByCaster(unit, spell) || !isOffensiveSpellMultiplier(spell.getMultiplierType())) {
            continue;
        }
        if (
            spell.getSpellTargetType() === SpellTargetType.FREE_CELL &&
            (spell.getName() === "Meteorite" || spell.getName() === "Meteor Shower")
        ) {
            const meteor = findMeteorOption(unit, spell, context, intents, accept);
            if (meteor) return meteor;
            continue;
        }
        if (spell.getSpellTargetType() === SpellTargetType.ANY_ENEMY) {
            for (const target of context.unitsHolder
                .getAllEnemyUnits(unit.getTeam())
                .sort((left, right) => left.getId().localeCompare(right.getId()))) {
                if (!canTargetOffensiveSpell(unit, target, spell, context)) continue;
                if (spell.getName() === "Ring of Fire") {
                    if ((ringOfFireNetDamage(unit, target, spell, context) ?? 0) <= 0) continue;
                } else if (spellDamage(unit, spell, target) <= 0) {
                    continue;
                }
                const actions: GameAction[] = [
                    {
                        type: "cast_spell",
                        casterId: unit.getId(),
                        spellName: spell.getName(),
                        targetId: target.getId(),
                    },
                ];
                if (!preservesRole(intents, unit, context, actions)) continue;
                const option: IV08BlockCenterDirectOption = {
                    kind: "spell",
                    actions,
                    targetId: target.getId(),
                    spellName: spell.getName(),
                };
                if (accept(option)) return option;
            }
            continue;
        }
        if (
            spell.getSpellTargetType() === SpellTargetType.ALL_ENEMIES &&
            canMassCastSpell(
                spell,
                context.unitsHolder.getAllTeamUnitsBuffs(unit.getTeam()),
                context.unitsHolder.getAllEnemyUnitsBuffs(unit.getTeam()),
                context.unitsHolder.getAllEnemyUnitsDebuffs(unit.getTeam()),
                context.unitsHolder.getAllTeamUnitsMagicResist(unit.getTeam()),
                context.unitsHolder.getAllEnemyUnitsMagicResist(unit.getTeam()),
                context.unitsHolder.getAllTeamUnitsHp(unit.getTeam()),
                context.unitsHolder.getAllTeamUnitsMaxHp(unit.getTeam()),
                context.unitsHolder.getAllTeamUnitsCanFly(unit.getTeam()),
                context.unitsHolder.getAllEnemyUnitsCanFly(unit.getTeam()),
            ) &&
            context.unitsHolder.getAllEnemyUnits(unit.getTeam()).some((target) => spellDamage(unit, spell, target) > 0)
        ) {
            const actions: GameAction[] = [{ type: "cast_spell", casterId: unit.getId(), spellName: spell.getName() }];
            if (preservesRole(intents, unit, context, actions)) {
                const option: IV08BlockCenterDirectOption = {
                    kind: "spell",
                    actions,
                    spellName: spell.getName(),
                };
                if (accept(option)) return option;
            }
        }
    }
    return undefined;
}

/**
 * Independent binary oracle for immediate enemy damage.
 *
 * This deliberately does not call enumerateCandidates. It walks authoritative path reachability, every
 * target/stand pair, every visible ranged edge, every Area Throw cell and every offensive spell target until
 * it proves one engine-valid, role-preserving action exists. It may stop after the first proof: the panel needs
 * availability, not another policy-ranked candidate list. Shared engine geometry/legality helpers are reused,
 * but candidate caps, ordering and omission bugs cannot hide an action from this scanner.
 */
export function findIndependentV08BlockCenterDirectOption(
    unit: Unit,
    context: IDecisionContext,
    accept: V08BlockCenterDirectOptionAcceptance = acceptEveryDirectOption,
): IV08BlockCenterDirectOption | undefined {
    const intents = roleIntents(unit, context);
    const routes = routesForUnit(unit, context);
    return (
        findIndependentMeleeOption(unit, context, intents, routes, accept) ??
        findIndependentRangeOption(unit, context, intents, routes, accept) ??
        findIndependentAreaThrowOption(unit, context, intents, accept) ??
        findIndependentSpellOption(unit, context, intents, accept)
    );
}

const hasConcreteCatalogDamageEstimate = (candidate: IEnumeratedCandidate): boolean =>
    candidate.kind !== "incumbent" ||
    candidate.targetId !== undefined ||
    candidate.pressureTargetId !== undefined ||
    candidate.shotFeatures !== undefined;

const isKnownNonPositiveCatalogDamage = (candidate: IEnumeratedCandidate): boolean =>
    hasConcreteCatalogDamageEstimate(candidate) &&
    Number.isFinite(candidate.features.expectedDamage) &&
    candidate.features.expectedDamage <= 0;

const isCatalogDirectCandidate = (unit: Unit, candidate: IEnumeratedCandidate): boolean => {
    const physical = candidate.actions.some(
        (action) =>
            action.type === "melee_attack" || action.type === "range_attack" || action.type === "area_throw_attack",
    );
    if (physical) return !isKnownNonPositiveCatalogDamage(candidate);
    return selectV08DamageSpellCandidate(unit, [candidate]) === candidate;
};

const isStationaryMountainCandidate = (unit: Unit, candidate: IEnumeratedCandidate): boolean => {
    if (candidate.kind !== "mine" || candidate.actions.length !== 1) return false;
    const action = candidate.actions[0];
    const base = unit.getBaseCell();
    return (
        action?.type === "obstacle_attack" &&
        action.attackerId === unit.getId() &&
        action.attackFrom?.x === base.x &&
        action.attackFrom.y === base.y &&
        !action.path?.length
    );
};

function sharedCatalogDirectCandidates(
    unit: Unit,
    context: IDecisionContext,
    incumbent: readonly GameAction[],
    intents: IV08BlockCenterRoleIntents,
): { set: ICandidateSet; direct: IEnumeratedCandidate[] } {
    const set = enumerateCandidates(unit, context, [...incumbent], {
        includeMountainAttacks: true,
        enrichIncumbentMetadata: true,
    });
    const catalogDirect = (candidate: IEnumeratedCandidate): boolean =>
        isCatalogDirectCandidate(unit, candidate) && preservesRole(intents, unit, context, candidate.actions);
    let direct = set.candidates.filter(catalogDirect);
    const urgentPureMove =
        (context.fightProperties?.getCurrentLap() ?? 0) >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP &&
        incumbent.length > 0 &&
        incumbent.every((action) => action.type === "move_unit");
    if (!direct.length && urgentPureMove) {
        // Mirror SearchDriver's private terminal escape hatch. This expansion is intentionally absent from
        // `set`: its top-two cap is a production policy bound, while `set.truncated` audits accidental caps in
        // the ordinary shared catalog. The independent oracle still fails qualification if both escapes miss.
        direct = enumerateCandidates(unit, context, [...incumbent], {
            includeMountainAttacks: true,
            enrichIncumbentMetadata: true,
            maxMoveShotComposites: 2,
            discoverMoveShotTargetsAfterMove: true,
        }).candidates.filter(
            (candidate) =>
                candidate.kind === "shot" &&
                candidate.actions.some((action) => action.type === "move_unit") &&
                catalogDirect(candidate),
        );
    }
    return {
        set,
        direct,
    };
}

function catalogCandidateAsDirectOption(candidate: IEnumeratedCandidate): IV08BlockCenterDirectOption {
    // Candidate zero is the incumbent and deliberately retains kind === "incumbent", even when the
    // incumbent contains a shot or a spell. Derive the diagnostic kind from the action that the engine must
    // actually complete so the authoritative probe cannot mistake a valid incumbent for a failed melee.
    const directAction = [...candidate.actions]
        .reverse()
        .find(
            (action) =>
                action.type === "melee_attack" ||
                action.type === "range_attack" ||
                action.type === "area_throw_attack" ||
                action.type === "cast_spell",
        );
    if (!directAction) {
        throw new Error(`Catalog direct candidate ${candidate.kind} contains no direct combat action`);
    }
    switch (directAction.type) {
        case "melee_attack":
            return {
                kind: "melee",
                actions: structuredClone(candidate.actions),
                targetId: candidate.targetId ?? directAction.targetId,
                standCell: candidate.standCell ? { ...candidate.standCell } : { ...directAction.attackFrom },
            };
        case "range_attack":
            return {
                kind: "shot",
                actions: structuredClone(candidate.actions),
                targetId: candidate.targetId ?? directAction.targetId,
                aimCell: directAction.aimCell ? { ...directAction.aimCell } : undefined,
            };
        case "area_throw_attack":
            return {
                kind: "area_throw",
                actions: structuredClone(candidate.actions),
                targetId: candidate.targetId,
                aimCell: { ...directAction.targetCell },
            };
        case "cast_spell":
            return {
                kind: "spell",
                actions: structuredClone(candidate.actions),
                targetId: candidate.targetId ?? directAction.targetId,
                spellName: candidate.spellName ?? directAction.spellName,
                aimCell: directAction.targetCell ? { ...directAction.targetCell } : undefined,
            };
    }
}

const expectedCompletedActionType = (option: IV08BlockCenterDirectOption): GameAction["type"] => {
    switch (option.kind) {
        case "melee":
            return "melee_attack";
        case "shot":
            return "range_attack";
        case "area_throw":
            return "area_throw_attack";
        case "spell":
            return "cast_spell";
    }
};

const mountainState = (context: IDecisionContext): V08BlockCenterMountainState => {
    const left = (context.fightProperties?.getObstacleHitsLeftLeft() ?? 0) > 0;
    const right = (context.fightProperties?.getObstacleHitsLeftRight() ?? 0) > 0;
    return left ? (right ? "both_intact" : "left_only") : right ? "right_only" : "cleared";
};

const stateFingerprint = (observation: IDecisionObservation): string => {
    const units = [...observation.context.unitsHolder.getAllUnits().values()]
        .filter((unit) => !unit.isDead())
        .map((unit) => ({
            id: unit.getId(),
            name: unit.getName(),
            team: unit.getTeam(),
            cells: cloneCells(unit.getCells()).sort((left, right) => left.x - right.x || left.y - right.y),
            hp: unit.getCumulativeHp(),
            shots: unit.getRangeShots(),
            remainingSpells: unit
                .getSpells()
                .filter((spell) => spell.isRemaining())
                .map((spell) => spell.getName())
                .sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    return createHash("sha256")
        .update(
            JSON.stringify({
                lap: observation.context.fightProperties?.getCurrentLap() ?? 0,
                mountain: mountainState(observation.context),
                units,
            }),
        )
        .digest("hex");
};

const isDirectExecution = (
    observation: ITurnExecutionObservation,
    damagingSpellNames: ReadonlySet<string>,
): boolean => {
    for (const execution of observation.strategyActions) {
        if (!execution.completed) continue;
        if (
            execution.action.type === "melee_attack" ||
            execution.action.type === "range_attack" ||
            execution.action.type === "area_throw_attack"
        ) {
            return true;
        }
        if (execution.action.type === "cast_spell" && damagingSpellNames.has(execution.action.spellName)) {
            return true;
        }
    }
    return observation.events.some(
        (event) =>
            (event.type === "unit_attacked" && event.attackerId === observation.unitId) ||
            (event.type === "area_attacked" && event.attackerId === observation.unitId) ||
            (event.type === "spell_cast" &&
                event.casterId === observation.unitId &&
                ((event.damaged?.length ?? 0) > 0 || (event.secondary?.length ?? 0) > 0)),
    );
};

const completedNonDamagingSpell = (
    observation: ITurnExecutionObservation,
    damagingSpellNames: ReadonlySet<string>,
): boolean =>
    observation.strategyActions.some(
        (execution) =>
            execution.completed &&
            execution.action.type === "cast_spell" &&
            !damagingSpellNames.has(execution.action.spellName),
    );

const completedPureMove = (observation: ITurnExecutionObservation): GameAction | undefined => {
    const completed = observation.strategyActions
        .filter((execution) => execution.completed)
        .map((execution) => execution.action)
        .filter((action) => action.type !== "select_attack_type");
    return completed.length === 1 && completed[0]?.type === "move_unit" ? completed[0] : undefined;
};

const movedFootprint = (observation: ITurnExecutionObservation, fallback: readonly XY[]): XY[] => {
    const event = [...observation.events]
        .reverse()
        .find(
            (candidate): candidate is Extract<(typeof observation.events)[number], { type: "unit_moved" }> =>
                candidate.type === "unit_moved" && candidate.unitId === observation.unitId,
        );
    return event?.targetCells.length ? cloneCells(event.targetCells) : cloneCells(fallback);
};

const mergeMetrics = (target: IV08BlockCenterMetrics, source: IV08BlockCenterMetrics): void => {
    for (const key of METRIC_KEYS) target[key] += source[key];
};

const isNonnegativeSafeCounter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const hasValidMetricCounterDomain = (metrics: IV08BlockCenterMetrics): boolean =>
    METRIC_KEYS.every((key) => isNonnegativeSafeCounter(metrics[key]));

const TURN_BOUNDED_METRICS = [
    "oracleDirectEligibleTurns",
    "sharedCatalogDirectEligibleTurns",
    "catalogMissedEngineValidCombat",
    "urgentCatalogMisses",
    "chosenDirectActionTurns",
    "noncombatWithDirectOptionTurns",
    "nonDamagingSpellExemptions",
    "mountainAdjacentTurns",
    "mountainAdjacentDirectEligibleTurns",
    "mountainAdjacentMissedAttacks",
    "urgentMountainAdjacentMisses",
    "pureMoveTurns",
    "nonProgressMoves",
    "urgentRepeatedNonProgressWithDirectOption",
    "urgentMountainTerminalJitter",
    "abaOscillations",
    "eligibleCombatMisses",
    "eligibleCombatDroughts",
    "urgentCombatDroughts",
    "lateDirectEligibleTurns",
    "lateDirectActionMisses",
    "recoveryTurns",
] as const satisfies readonly (keyof IV08BlockCenterMetrics)[];

const LATE_METRICS = [
    "urgentCatalogMisses",
    "urgentMountainAdjacentMisses",
    "urgentRepeatedNonProgressWithDirectOption",
    "urgentMountainTerminalJitter",
    "urgentCombatDroughts",
    "lateDirectEligibleTurns",
    "lateDirectActionMisses",
] as const satisfies readonly (keyof IV08BlockCenterMetrics)[];

const hasSemanticallyValidMetrics = (metrics: IV08BlockCenterMetrics, laps?: number): boolean =>
    TURN_BOUNDED_METRICS.every((key) => metrics[key] <= metrics.observedTurns) &&
    metrics.catalogMissedEngineValidCombat <= metrics.oracleDirectEligibleTurns &&
    metrics.urgentCatalogMisses <= metrics.catalogMissedEngineValidCombat &&
    metrics.noncombatWithDirectOptionTurns <= metrics.oracleDirectEligibleTurns &&
    metrics.nonDamagingSpellExemptions <= metrics.oracleDirectEligibleTurns &&
    metrics.mountainAdjacentDirectEligibleTurns <= metrics.mountainAdjacentTurns &&
    metrics.mountainAdjacentDirectEligibleTurns <= metrics.oracleDirectEligibleTurns &&
    metrics.mountainAdjacentMissedAttacks <= metrics.mountainAdjacentTurns &&
    metrics.mountainAdjacentMissedAttacks <= metrics.mountainAdjacentDirectEligibleTurns &&
    metrics.mountainAdjacentMissedAttacks <= metrics.noncombatWithDirectOptionTurns &&
    metrics.urgentMountainAdjacentMisses <= metrics.mountainAdjacentMissedAttacks &&
    metrics.nonProgressMoves <= metrics.pureMoveTurns &&
    metrics.urgentRepeatedNonProgressWithDirectOption <= metrics.nonProgressMoves &&
    metrics.urgentRepeatedNonProgressWithDirectOption <= metrics.noncombatWithDirectOptionTurns &&
    metrics.urgentMountainTerminalJitter <= metrics.pureMoveTurns &&
    metrics.abaOscillations <= metrics.pureMoveTurns &&
    metrics.eligibleCombatMisses === metrics.noncombatWithDirectOptionTurns &&
    metrics.eligibleCombatDroughts <= metrics.eligibleCombatMisses &&
    metrics.urgentCombatDroughts <= metrics.eligibleCombatDroughts &&
    metrics.lateDirectEligibleTurns <= metrics.oracleDirectEligibleTurns &&
    metrics.lateDirectActionMisses <= metrics.noncombatWithDirectOptionTurns &&
    metrics.lateDirectActionMisses <= metrics.lateDirectEligibleTurns &&
    (laps === undefined ||
        laps >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP ||
        LATE_METRICS.every((key) => metrics[key] === 0));

const hasValidMountainCounterDomain = (mountainStates: Record<V08BlockCenterMountainState, number>): boolean =>
    Object.keys(mountainStates).length === V08_BLOCK_CENTER_MOUNTAIN_STATES.length &&
    V08_BLOCK_CENTER_MOUNTAIN_STATES.every(
        (state) => Object.hasOwn(mountainStates, state) && isNonnegativeSafeCounter(mountainStates[state]),
    );

const hasValidResultDomain = (record: IV08BlockCenterActionRecord, maxLaps: number): boolean => {
    const validWinner = record.winner === "candidate" || record.winner === "opponent" || record.winner === "draw";
    const validEndReason =
        record.endReason === "elimination" ||
        record.endReason === "turn_cap" ||
        record.endReason === "stuck" ||
        record.endReason === "crash";
    const validLaps = Number.isSafeInteger(record.laps) && record.laps >= 0 && record.laps <= maxLaps;
    const validCrash =
        record.endReason === "crash"
            ? typeof record.crash === "string" && record.crash.length > 0
            : record.crash === undefined;
    const validElimination = record.endReason !== "elimination" || record.laps >= 1;
    return validWinner && validEndReason && validLaps && validCrash && validElimination;
};

const hasConsistentFailureSamples = (record: IV08BlockCenterActionRecord): boolean => {
    const counts = new Map<V08BlockCenterIssue, number>();
    const derivedMetrics = new Set<keyof IV08BlockCenterMetrics>();
    const byCreatureCounts = new Map<string, Map<V08BlockCenterIssue, number>>();
    const byCreatureDerivedMetrics = new Map<string, Set<keyof IV08BlockCenterMetrics>>();
    for (const sample of record.failureSamples) {
        if (
            !Object.hasOwn(FAILURE_SAMPLE_METRIC, sample.issue) ||
            sample.game !== record.game ||
            sample.pair !== record.pair ||
            sample.seed !== record.seed ||
            sample.candidateSide !== record.candidateSide ||
            !Number.isSafeInteger(sample.lap) ||
            sample.lap < 0 ||
            sample.lap > record.laps ||
            ((sample.issue === "urgent_mountain_terminal_jitter" || sample.issue === "lap9_direct_action_miss") &&
                sample.lap < V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP)
        ) {
            return false;
        }
        counts.set(sample.issue, (counts.get(sample.issue) ?? 0) + 1);
        const creatureCounts = byCreatureCounts.get(sample.creatureName) ?? new Map<V08BlockCenterIssue, number>();
        creatureCounts.set(sample.issue, (creatureCounts.get(sample.issue) ?? 0) + 1);
        byCreatureCounts.set(sample.creatureName, creatureCounts);
        if (
            sample.lap >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP &&
            Object.hasOwn(LATE_FAILURE_SAMPLE_METRIC, sample.issue)
        ) {
            const key = LATE_FAILURE_SAMPLE_METRIC[sample.issue as keyof typeof LATE_FAILURE_SAMPLE_METRIC];
            derivedMetrics.add(key);
            const creatureDerivedMetrics =
                byCreatureDerivedMetrics.get(sample.creatureName) ?? new Set<keyof IV08BlockCenterMetrics>();
            creatureDerivedMetrics.add(key);
            byCreatureDerivedMetrics.set(sample.creatureName, creatureDerivedMetrics);
        }
    }
    return (
        [...counts].every(([issue, count]) => count <= record.metrics[FAILURE_SAMPLE_METRIC[issue]]) &&
        [...derivedMetrics].every((key) => record.metrics[key] > 0) &&
        [...byCreatureCounts].every(([creatureName, creatureCounts]) => {
            const metrics = record.byCreature[creatureName];
            return (
                metrics !== undefined &&
                [...creatureCounts].every(([issue, count]) => count <= metrics[FAILURE_SAMPLE_METRIC[issue]])
            );
        }) &&
        [...byCreatureDerivedMetrics].every(([creatureName, keys]) => {
            const metrics = record.byCreature[creatureName];
            return metrics !== undefined && [...keys].every((key) => metrics[key] > 0);
        })
    );
};

const increment = (record: Record<string, number>, key: string, amount = 1): void => {
    record[key] = (record[key] ?? 0) + amount;
};

/**
 * Candidate ownership follows the physical side, not the strategy selected for an individual activation.
 * Mindless Berserker/Frenzied Boar turns are pinned to v0.1 but still belong to the v0.8 candidate army.
 */
export class V08BlockCenterActionAuditor {
    public readonly metrics = emptyV08BlockCenterMetrics();
    public readonly byCreature: Record<string, IV08BlockCenterMetrics> = {};
    public readonly mountainStates = emptyMountainStates();
    public readonly failureSamples: IV08BlockCenterFailureSample[] = [];
    private pending?: IV08BlockCenterPendingDecision;
    private readonly history = new Map<string, IV08BlockCenterMovementHistory>();
    public constructor(
        private readonly plan: Pick<IV08BlockCenterActionPlan, "game" | "pair" | "seed" | "candidateSide">,
    ) {}
    private creatureMetrics(creatureName: string): IV08BlockCenterMetrics {
        return (this.byCreature[creatureName] ??= emptyV08BlockCenterMetrics());
    }
    private bump(creatureName: string, key: keyof IV08BlockCenterMetrics, amount = 1): void {
        this.metrics[key] += amount;
        this.creatureMetrics(creatureName)[key] += amount;
    }
    private sample(
        pending: IV08BlockCenterPendingDecision,
        issue: V08BlockCenterIssue,
        chosenDecision: readonly GameAction[],
        detail: string,
    ): void {
        if (this.failureSamples.length >= V08_BLOCK_CENTER_ACTION_PANEL_MAX_SAMPLES_PER_GAME) return;
        this.failureSamples.push({
            issue,
            game: this.plan.game,
            pair: this.plan.pair,
            seed: this.plan.seed,
            candidateSide: this.plan.candidateSide,
            unitId: pending.unitId,
            creatureName: pending.creatureName,
            lap: pending.lap,
            mountainState: pending.mountainState,
            actorCells: cloneCells(pending.actorCells),
            enemyCells: cloneCells(pending.enemyCells),
            chosenDecision: structuredClone([...chosenDecision]),
            oracleOption: pending.oracleOption ? structuredClone(pending.oracleOption) : undefined,
            stateSha256: pending.stateSha256,
            detail,
        });
    }
    public observeDecision(observation: IDecisionObservation): void {
        if (sideForUnit(observation.unit) !== this.plan.candidateSide) {
            return;
        }
        if (this.pending) {
            this.bump(this.pending.creatureName, "observerPairingFaults");
            this.pending = undefined;
        }
        const unit = observation.unit;
        const context = observerLocalDecisionContext(observation.context);
        const intents = roleIntents(unit, context);
        if (!observation.probeActions) {
            throw new Error("BLOCK_CENTER action oracle requires the authoritative decision action probe");
        }
        const probeFailures: IV08BlockCenterPendingDecision["probeFailures"] = [];
        const probed = new Map<string, { pass: boolean; failure: string }>();
        const probeOption = (source: "oracle" | "catalog", option: IV08BlockCenterDirectOption): boolean => {
            // The human-readable signature intentionally collapses paths with the same destination. Probes may
            // not: two paths to one cell can cross different fire walls and have different engine outcomes.
            const probeKey = JSON.stringify(option.actions);
            const cached = probed.get(probeKey);
            if (cached) {
                if (!cached.pass) {
                    this.bump(unit.getName(), source === "oracle" ? "oracleProbeRejections" : "catalogProbeRejections");
                    if (probeFailures.length < 8) {
                        probeFailures.push({
                            source,
                            actions: structuredClone(option.actions),
                            failure: cached.failure,
                        });
                    }
                }
                return cached.pass;
            }
            const result = observation.probeActions!(option.actions);
            const expected = expectedCompletedActionType(option);
            const pass = result.failure === null && result.completedActionTypes.includes(expected);
            const failure =
                result.failure ??
                (pass ? "" : `probe completed [${result.completedActionTypes.join(",")}] without ${expected}`);
            probed.set(probeKey, { pass, failure });
            if (!pass) {
                this.bump(unit.getName(), source === "oracle" ? "oracleProbeRejections" : "catalogProbeRejections");
                if (probeFailures.length < 8) {
                    probeFailures.push({ source, actions: structuredClone(option.actions), failure });
                }
            }
            return pass;
        };
        const catalog = sharedCatalogDirectCandidates(unit, context, observation.incumbent, intents);
        const independent = findIndependentV08BlockCenterDirectOption(unit, context, (option) =>
            probeOption("oracle", option),
        );
        let catalogOption: IV08BlockCenterDirectOption | undefined;
        for (const candidate of catalog.direct) {
            const option = catalogCandidateAsDirectOption(candidate);
            if (probeOption("catalog", option)) {
                catalogOption = option;
                break;
            }
        }
        const catalogDirect = catalogOption !== undefined;
        const catalogMiss = independent !== undefined && catalog.direct.length === 0;
        const stationaryMountain = catalog.set.candidates.find((candidate) =>
            isStationaryMountainCandidate(unit, candidate),
        );
        let stationaryMountainAvailable = false;
        if (stationaryMountain) {
            const result = observation.probeActions(stationaryMountain.actions);
            stationaryMountainAvailable =
                result.failure === null && result.completedActionTypes.includes("obstacle_attack");
            if (!stationaryMountainAvailable) {
                this.bump(unit.getName(), "catalogProbeRejections");
                if (probeFailures.length < 8) {
                    probeFailures.push({
                        source: "catalog",
                        actions: structuredClone(stationaryMountain.actions),
                        failure:
                            result.failure ??
                            `probe completed [${result.completedActionTypes.join(",")}] without obstacle_attack`,
                    });
                }
            }
        }
        const state = mountainState(context);
        const actorCells = cloneCells(unit.getCells());
        const enemies = context.unitsHolder.getAllEnemyUnits(unit.getTeam()).filter((enemy) => !enemy.isDead());
        const enemyCells = enemies.flatMap((enemy) => cloneCells(enemy.getCells()));
        const lap = context.fightProperties?.getCurrentLap() ?? 0;
        const meleeOnly = !unit.isRangeCapable() && !unit.getCanCastSpells();
        const terminalEscapeAvailable =
            independent !== undefined ||
            stationaryMountainAvailable ||
            (lap >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP &&
                state !== "cleared" &&
                meleeOnly &&
                hasEngineValidStrictProgressMove(unit, context, intents, enemyCells, (actions) => {
                    const result = observation.probeActions!(actions);
                    return result.failure === null && result.completedActionTypes.includes("move_unit");
                }));
        const adjacentToMountain = actorCells.some((actorCell) =>
            context.grid.getCenterCells(true).some((centerCell) => isAdjacent(actorCell, centerCell)),
        );
        const meaningfulRoleMoveSignatures = new Set<string>();
        for (const candidate of [catalog.set.candidates[0], ...catalog.set.candidates].filter(
            (value): value is IEnumeratedCandidate => value !== undefined,
        )) {
            const meaningful =
                (intents.protector &&
                    isV08BacklineProtectorPureMoveMeaningful(intents.protector, unit, context, candidate.actions)) ||
                (intents.ward && isV08BacklineWardPureMoveMeaningful(intents.ward, unit, context, candidate.actions));
            if (meaningful) meaningfulRoleMoveSignatures.add(v08BlockCenterActionSignature(candidate.actions));
        }
        const damagingSpellNames = new Set(
            unit
                .getSpells()
                .filter((spell) => isOffensiveSpellMultiplier(spell.getMultiplierType()))
                .map((spell) => spell.getName()),
        );
        this.pending = {
            unitId: unit.getId(),
            creatureName: unit.getName(),
            lap,
            mountainState: state,
            mountainAdjacent: adjacentToMountain,
            stationaryMountainAvailable,
            actorCells,
            enemyCells,
            enemyStateKey: enemyStateKey(enemies),
            stateSha256: stateFingerprint(observation),
            // A catalog action completing in the engine proves that the action is legal, but not that its
            // physical attack deals positive enemy damage. Keep catalog-only coverage in catalogDirect; all
            // missed-action counters must share the independently damage-proven oracle denominator.
            oracleOption: independent,
            catalogDirect,
            catalogMiss,
            damagingSpellNames,
            meleeOnly,
            terminalEscapeAvailable,
            meaningfulRoleMoveSignatures,
            probeFailures,
        };
        this.bump(unit.getName(), "observedTurns");
        this.mountainStates[state] += 1;
        if (independent) this.bump(unit.getName(), "oracleDirectEligibleTurns");
        if (catalogDirect) this.bump(unit.getName(), "sharedCatalogDirectEligibleTurns");
        if (catalog.set.truncated.length) {
            this.bump(unit.getName(), "sharedCatalogEnumerationTruncations", catalog.set.truncated.length);
        }
        if (catalogMiss) {
            this.bump(unit.getName(), "catalogMissedEngineValidCombat");
            if ((context.fightProperties?.getCurrentLap() ?? 0) >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP) {
                this.bump(unit.getName(), "urgentCatalogMisses");
            }
        }
        if (adjacentToMountain) this.bump(unit.getName(), "mountainAdjacentTurns");
        if (adjacentToMountain && independent) {
            this.bump(unit.getName(), "mountainAdjacentDirectEligibleTurns");
        }
    }
    public observeExecution(observation: ITurnExecutionObservation): void {
        if (observation.side !== this.plan.candidateSide) {
            return;
        }
        const pending = this.pending;
        this.pending = undefined;
        if (!pending || pending.unitId !== observation.unitId || pending.creatureName !== observation.creatureName) {
            this.bump(observation.creatureName, "observerPairingFaults");
            return;
        }
        const rejected = observation.strategyActions.filter((execution) => !execution.completed).length;
        if (rejected) this.bump(pending.creatureName, "strategyRejectedActions", rejected);
        if (observation.recoveryAttempts.length) {
            this.bump(pending.creatureName, "recoveryTurns");
        }
        const directAvailable = pending.oracleOption !== undefined;
        const directAction = isDirectExecution(observation, pending.damagingSpellNames);
        const nonDamagingSpell = completedNonDamagingSpell(observation, pending.damagingSpellNames);
        const urgentTurn = pending.lap >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP;
        if (directAction) this.bump(pending.creatureName, "chosenDirectActionTurns");
        for (const failure of pending.probeFailures) {
            this.sample(
                pending,
                failure.source === "oracle" ? "oracle_probe_rejection" : "catalog_probe_rejection",
                observation.chosenDecision,
                `${failure.failure}; rejected option ${v08BlockCenterActionSignature(failure.actions)}`,
            );
        }
        if (pending.catalogMiss) {
            this.sample(
                pending,
                "catalog_missed_engine_valid_combat",
                observation.chosenDecision,
                "independent engine-valid direct option absent from the configured shared catalog",
            );
        }
        const history = this.history.get(pending.unitId) ?? {
            footprints: [footprintKey(pending.actorCells)],
            enemyStateKey: pending.enemyStateKey,
            eligibleCombatMisses: 0,
            consecutiveNonDamageTurns: 0,
            consecutiveUnproductiveMountainMoves: 0,
        };
        const nonDamagingSpellIsExempt = nonDamagingSpell && isV08BlockCenterNonDamagingSpellTurnExempt(pending.lap);
        const directMiss = directAvailable && !directAction && !nonDamagingSpellIsExempt;
        if (nonDamagingSpellIsExempt && directAvailable) {
            // Healing, buffs, control, summons and terrain spells are substantive tactical turns. A binary
            // damage oracle cannot prove them worse than a legal hit before the hard urgent-finish policy begins.
            this.bump(pending.creatureName, "nonDamagingSpellExemptions");
        }
        if (directMiss) {
            this.bump(pending.creatureName, "noncombatWithDirectOptionTurns");
            this.bump(pending.creatureName, "eligibleCombatMisses");
            history.eligibleCombatMisses += 1;
            this.sample(
                pending,
                "noncombat_with_direct_option",
                observation.chosenDecision,
                "role-preserving engine-valid enemy damage existed but the completed turn did not attempt it",
            );
            if (pending.mountainAdjacent) {
                this.bump(pending.creatureName, "mountainAdjacentMissedAttacks");
                if (urgentTurn) {
                    this.bump(pending.creatureName, "urgentMountainAdjacentMisses");
                }
                this.sample(
                    pending,
                    "mountain_adjacent_missed_attack",
                    observation.chosenDecision,
                    "actor touched an intact mountain while omitting an engine-valid direct attack",
                );
            }
            if (history.eligibleCombatMisses >= 2) {
                this.bump(pending.creatureName, "eligibleCombatDroughts");
                if (urgentTurn) {
                    this.bump(pending.creatureName, "urgentCombatDroughts");
                }
                this.sample(
                    pending,
                    "eligible_combat_drought",
                    observation.chosenDecision,
                    `${history.eligibleCombatMisses} eligible activations without a direct attack`,
                );
            }
            if (urgentTurn) {
                this.bump(pending.creatureName, "lateDirectActionMisses");
                this.sample(
                    pending,
                    "lap9_direct_action_miss",
                    observation.chosenDecision,
                    `lap ${pending.lap} direct action omitted`,
                );
            }
        } else if (directAction || nonDamagingSpellIsExempt) {
            history.eligibleCombatMisses = 0;
        }
        if (directAvailable && urgentTurn) {
            this.bump(pending.creatureName, "lateDirectEligibleTurns");
        }
        const pureMove = completedPureMove(observation);
        if (pureMove) {
            this.bump(pending.creatureName, "pureMoveTurns");
            const after = movedFootprint(observation, pending.actorCells);
            const afterKey = footprintKey(after);
            const meaningfulRoleMove = pending.meaningfulRoleMoveSignatures.has(
                v08BlockCenterActionSignature(observation.chosenDecision),
            );
            const nonProgress =
                pending.meleeOnly &&
                !meaningfulRoleMove &&
                isV08BlockCenterNonProgressMove(pending.actorCells, after, pending.enemyCells);
            const terminalNonProgress =
                pending.meleeOnly &&
                !meaningfulRoleMove &&
                isV08BlockCenterTerminalNonProgressMove(
                    pending.actorCells,
                    after,
                    pending.enemyCells,
                    pending.stationaryMountainAvailable,
                );
            if (nonProgress) {
                this.bump(pending.creatureName, "nonProgressMoves");
                if (urgentTurn && directAvailable && history.consecutiveNonDamageTurns >= 1) {
                    this.bump(pending.creatureName, "urgentRepeatedNonProgressWithDirectOption");
                }
                this.sample(
                    pending,
                    "non_progress_move",
                    observation.chosenDecision,
                    `enemy distance ${v08BlockCenterFootprintDistance(pending.actorCells, pending.enemyCells)} -> ${v08BlockCenterFootprintDistance(after, pending.enemyCells)}`,
                );
            }
            // Only uninterrupted, non-role pure movement can form a hard A-B-A stall. A productive attack,
            // spell, move-and-attack, or protector/ward relocation is a real decision boundary and must not
            // leave an older footprint behind for a later return move to match.
            const abaOscillation = !meaningfulRoleMove && isV08BlockCenterABAOscillation(history.footprints, afterKey);
            if (abaOscillation) {
                this.bump(pending.creatureName, "abaOscillations");
                this.sample(
                    pending,
                    "aba_oscillation",
                    observation.chosenDecision,
                    `${history.footprints.at(-2)} -> ${history.footprints.at(-1)} -> ${afterKey}`,
                );
            }
            // Keep raw oscillation/non-progress telemetry informational when the actor had no damage, stationary
            // mine, or engine-valid closer move. Forcing a wait, shield, or remote move-to-mine in that state
            // would punish temporary melee congestion rather than identify an avoidable production stall.
            const urgentMountainTerminalJitter =
                pending.terminalEscapeAvailable &&
                (isV08BlockCenterUrgentMountainTerminalJitter(
                    pending.lap,
                    pending.mountainState,
                    pending.meleeOnly,
                    meaningfulRoleMove,
                    terminalNonProgress,
                    history.consecutiveUnproductiveMountainMoves,
                ) ||
                    isV08BlockCenterUrgentMountainABAOscillation(
                        pending.lap,
                        pending.mountainState,
                        pending.meleeOnly,
                        meaningfulRoleMove,
                        abaOscillation,
                        history.enemyStateKey !== pending.enemyStateKey,
                        !nonProgress,
                    ));
            if (urgentMountainTerminalJitter) {
                this.bump(pending.creatureName, "urgentMountainTerminalJitter");
                this.sample(
                    pending,
                    "urgent_mountain_terminal_jitter",
                    observation.chosenDecision,
                    `${abaOscillation ? "A-B-A footprint return" : `${history.consecutiveUnproductiveMountainMoves + 1} consecutive non-progress mountain moves`}; enemy distance ${v08BlockCenterFootprintDistance(pending.actorCells, pending.enemyCells)} -> ${v08BlockCenterFootprintDistance(after, pending.enemyCells)}`,
                );
            }
            if (
                pending.mountainState !== "cleared" &&
                pending.meleeOnly &&
                !meaningfulRoleMove &&
                terminalNonProgress
            ) {
                history.consecutiveUnproductiveMountainMoves += 1;
            } else {
                history.consecutiveUnproductiveMountainMoves = 0;
            }
            if (meaningfulRoleMove) {
                history.footprints = [afterKey];
            } else if (history.footprints.at(-1) !== afterKey) {
                history.footprints.push(afterKey);
                if (history.footprints.length > 3) history.footprints.shift();
            }
        } else {
            history.consecutiveUnproductiveMountainMoves = 0;
            history.footprints = [footprintKey(movedFootprint(observation, pending.actorCells))];
        }
        if (directAction || nonDamagingSpellIsExempt) {
            history.consecutiveNonDamageTurns = 0;
        } else {
            history.consecutiveNonDamageTurns += 1;
        }
        history.enemyStateKey = pending.enemyStateKey;
        this.history.set(pending.unitId, history);
    }
    public finish(): void {
        if (this.pending) {
            this.bump(this.pending.creatureName, "observerPairingFaults");
            this.pending = undefined;
        }
    }
}

const validateOptions = (options: IV08BlockCenterActionPanelOptions): void => {
    if (!Number.isSafeInteger(options.games) || options.games <= 0 || options.games % 2 !== 0) {
        throw new RangeError(`BLOCK_CENTER action panel games must be a positive even integer; got ${options.games}`);
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0) {
        throw new RangeError(`BLOCK_CENTER action panel baseSeed must be a nonnegative safe integer`);
    }
    if (!AI_VERSIONS.includes(options.candidateVersion) || !AI_VERSIONS.includes(options.opponentVersion)) {
        throw new Error(`Unknown AI version; known versions: ${AI_VERSIONS.join(", ")}`);
    }
};

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

export function planV08BlockCenterActionGame(
    options: IV08BlockCenterActionPanelOptions,
    game: number,
): IV08BlockCenterActionPlan {
    validateOptions(options);
    if (!Number.isSafeInteger(game) || game < 0 || game >= options.games) {
        throw new RangeError(`Invalid BLOCK_CENTER action panel game ${game}`);
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
        mapType: PBTypes.GridVals.BLOCK_CENTER,
        candidateSide: game % 2 === 0 ? "green" : "red",
        greenRoster,
        redRoster,
    };
}

const rosterNames = (roster: readonly IArmyUnitSpec[]): string[] => roster.map(({ creatureName }) => creatureName);

const planIdentity = (plan: IV08BlockCenterActionPlan): unknown => ({
    game: plan.game,
    pair: plan.pair,
    seed: plan.seed,
    mapType: plan.mapType,
    candidateSide: plan.candidateSide,
    greenRoster: rosterNames(plan.greenRoster),
    redRoster: rosterNames(plan.redRoster),
});

export function fingerprintV08BlockCenterActionPlan(options: IV08BlockCenterActionPanelOptions): string {
    validateOptions(options);
    return createHash("sha256")
        .update(
            JSON.stringify({
                inheritCandidateEnvironment: options.inheritCandidateEnvironment === true,
                plans: Array.from({ length: options.games }, (_, game) =>
                    planIdentity(planV08BlockCenterActionGame(options, game)),
                ),
            }),
        )
        .digest("hex");
}

export function withV08BlockCenterCandidateEnvironment<T>(
    options: Pick<IV08BlockCenterActionPanelOptions, "candidateVersion" | "inheritCandidateEnvironment">,
    run: () => T,
): T {
    if (options.inheritCandidateEnvironment === true) {
        return run();
    }
    if (options.candidateVersion === "v0.8" || options.candidateVersion === "v0.8s") {
        return withScopedAIEnvironment(buildV08A13SearchEnvironment(options.candidateVersion), run);
    }
    return run();
}

export function runV08BlockCenterActionPanelGame(
    options: IV08BlockCenterActionPanelOptions,
    game: number,
): IV08BlockCenterActionRecord {
    const plan = planV08BlockCenterActionGame(options, game);
    const auditor = new V08BlockCenterActionAuditor(plan);
    const candidateRoster = plan.candidateSide === "green" ? plan.greenRoster : plan.redRoster;
    const opponentRoster = plan.candidateSide === "green" ? plan.redRoster : plan.greenRoster;
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
        turnExecutionObserver: (observation) => auditor.observeExecution(observation),
    };
    try {
        const result = withV08BlockCenterCandidateEnvironment(options, () => runMatch(config));
        auditor.finish();
        const candidateIsGreen = plan.candidateSide === "green";
        return {
            schema: V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
            sourceCommit: options.sourceCommit ?? null,
            sourceDirty: options.sourceDirty === true,
            game,
            pair: plan.pair,
            seed: plan.seed,
            mapType: plan.mapType,
            candidateVersion: options.candidateVersion,
            opponentVersion: options.opponentVersion,
            inheritCandidateEnvironment: options.inheritCandidateEnvironment === true,
            candidateSide: plan.candidateSide,
            candidateRoster: rosterNames(candidateRoster),
            opponentRoster: rosterNames(opponentRoster),
            winner: result.winner === "draw" ? "draw" : result.winner === plan.candidateSide ? "candidate" : "opponent",
            laps: result.laps,
            endReason: result.endReason,
            candidateEngineRejections: candidateIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
            metrics: auditor.metrics,
            byCreature: auditor.byCreature,
            mountainStates: auditor.mountainStates,
            failureSamples: auditor.failureSamples,
        };
    } catch (error) {
        auditor.finish();
        return {
            schema: V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
            sourceCommit: options.sourceCommit ?? null,
            sourceDirty: options.sourceDirty === true,
            game,
            pair: plan.pair,
            seed: plan.seed,
            mapType: plan.mapType,
            candidateVersion: options.candidateVersion,
            opponentVersion: options.opponentVersion,
            inheritCandidateEnvironment: options.inheritCandidateEnvironment === true,
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
            mountainStates: auditor.mountainStates,
            failureSamples: auditor.failureSamples,
        };
    }
}

const gate = (pass: boolean, actual: number | string, expected: string): IV08BlockCenterActionGate => ({
    pass,
    actual,
    expected,
});

export function summarizeV08BlockCenterActionPanel(
    options: IV08BlockCenterActionPanelOptions,
    records: readonly IV08BlockCenterActionRecord[],
): IV08BlockCenterActionSummary {
    validateOptions(options);
    const metrics = emptyV08BlockCenterMetrics();
    const byCreature: Record<string, IV08BlockCenterMetrics> = {};
    const mountainStates = emptyMountainStates();
    const candidateSeats: Record<Side, number> = { green: 0, red: 0 };
    const maps: Record<string, number> = {};
    const endReasons: Record<string, number> = {};
    const seenGames = new Set<number>();
    const urgentFailureSamples: IV08BlockCenterFailureSample[] = [];
    const diagnosticFailureSamples: IV08BlockCenterFailureSample[] = [];
    let candidateEngineRejections = 0;
    let recordsWithObservations = 0;
    let recordsWithConsistentMountainTurns = 0;
    let recordsWithConsistentCreatureTurns = 0;
    let recordsWithConsistentCreatureMetrics = 0;
    let recordsWithValidCounterDomain = 0;
    let recordsWithConsistentFailureSamples = 0;
    let recordsWithRejectionParity = 0;
    let recordsWithValidResultDomain = 0;
    let recordsWithSemanticallyValidMetrics = 0;
    // Worker completion order is scheduling-dependent. Game-order aggregation makes the capped reproduction
    // sample set and serialized summary stable across concurrency levels.
    for (const record of [...records].sort((left, right) => left.game - right.game)) {
        if (seenGames.has(record.game)) throw new Error(`Duplicate BLOCK_CENTER action game ${record.game}`);
        seenGames.add(record.game);
        const expected = planV08BlockCenterActionGame(options, record.game);
        const candidateRoster = expected.candidateSide === "green" ? expected.greenRoster : expected.redRoster;
        const opponentRoster = expected.candidateSide === "green" ? expected.redRoster : expected.greenRoster;
        if (
            record.schema !== V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA ||
            record.sourceCommit !== (options.sourceCommit ?? null) ||
            record.sourceDirty !== (options.sourceDirty === true) ||
            record.pair !== expected.pair ||
            record.seed !== expected.seed ||
            record.mapType !== PBTypes.GridVals.BLOCK_CENTER ||
            record.candidateSide !== expected.candidateSide ||
            record.candidateVersion !== options.candidateVersion ||
            record.opponentVersion !== options.opponentVersion ||
            record.inheritCandidateEnvironment !== (options.inheritCandidateEnvironment === true) ||
            JSON.stringify(record.candidateRoster) !== JSON.stringify(rosterNames(candidateRoster)) ||
            JSON.stringify(record.opponentRoster) !== JSON.stringify(rosterNames(opponentRoster))
        ) {
            throw new Error(`BLOCK_CENTER action record ${record.game} does not match its deterministic plan`);
        }
        candidateSeats[record.candidateSide] += 1;
        increment(maps, String(record.mapType));
        increment(endReasons, record.endReason);
        candidateEngineRejections += record.candidateEngineRejections;
        const recordMountainTurns = V08_BLOCK_CENTER_MOUNTAIN_STATES.reduce(
            (sum, state) => sum + record.mountainStates[state],
            0,
        );
        const recordCreatureTurns = Object.values(record.byCreature).reduce(
            (sum, creatureMetrics) => sum + creatureMetrics.observedTurns,
            0,
        );
        const recordCreatureMetrics = emptyV08BlockCenterMetrics();
        for (const creatureMetrics of Object.values(record.byCreature)) {
            mergeMetrics(recordCreatureMetrics, creatureMetrics);
        }
        if (
            isNonnegativeSafeCounter(record.candidateEngineRejections) &&
            hasValidMetricCounterDomain(record.metrics) &&
            Object.values(record.byCreature).every(hasValidMetricCounterDomain) &&
            hasValidMountainCounterDomain(record.mountainStates)
        ) {
            recordsWithValidCounterDomain += 1;
        }
        if (hasConsistentFailureSamples(record)) recordsWithConsistentFailureSamples += 1;
        if (record.metrics.strategyRejectedActions === record.candidateEngineRejections) {
            recordsWithRejectionParity += 1;
        }
        if (hasValidResultDomain(record, options.maxLaps ?? 60)) recordsWithValidResultDomain += 1;
        if (
            hasSemanticallyValidMetrics(record.metrics, record.laps) &&
            Object.values(record.byCreature).every((creatureMetrics) =>
                hasSemanticallyValidMetrics(creatureMetrics, record.laps),
            )
        ) {
            recordsWithSemanticallyValidMetrics += 1;
        }
        if (record.metrics.observedTurns > 0) recordsWithObservations += 1;
        if (recordMountainTurns === record.metrics.observedTurns) recordsWithConsistentMountainTurns += 1;
        if (recordCreatureTurns === record.metrics.observedTurns) recordsWithConsistentCreatureTurns += 1;
        if (METRIC_KEYS.every((key) => recordCreatureMetrics[key] === record.metrics[key])) {
            recordsWithConsistentCreatureMetrics += 1;
        }
        mergeMetrics(metrics, record.metrics);
        for (const [creatureName, source] of Object.entries(record.byCreature)) {
            mergeMetrics((byCreature[creatureName] ??= emptyV08BlockCenterMetrics()), source);
        }
        for (const state of V08_BLOCK_CENTER_MOUNTAIN_STATES) {
            mountainStates[state] += record.mountainStates[state];
        }
        for (const sample of record.failureSamples) {
            const target =
                sample.lap >= V08_BLOCK_CENTER_ACTION_PANEL_LATE_LAP && URGENT_SAMPLE_ISSUES.has(sample.issue)
                    ? urgentFailureSamples
                    : diagnosticFailureSamples;
            if (target.length < V08_BLOCK_CENTER_ACTION_PANEL_MAX_SUMMARY_SAMPLES) target.push(sample);
        }
    }
    const failureSamples = [...urgentFailureSamples, ...diagnosticFailureSamples].slice(
        0,
        V08_BLOCK_CENTER_ACTION_PANEL_MAX_SUMMARY_SAMPLES,
    );
    const sourceBound =
        options.sourceDirty !== true &&
        options.sourceCommit !== undefined &&
        SOURCE_SHA_PATTERN.test(options.sourceCommit);
    const mountainStateTurns = Object.values(mountainStates).reduce((sum, count) => sum + count, 0);
    const creatureObservedTurns = Object.values(byCreature).reduce(
        (sum, creatureMetrics) => sum + creatureMetrics.observedTurns,
        0,
    );
    const aggregateCreatureMetrics = emptyV08BlockCenterMetrics();
    for (const creatureMetrics of Object.values(byCreature)) {
        mergeMetrics(aggregateCreatureMetrics, creatureMetrics);
    }
    const aggregateCreatureMetricMismatches = METRIC_KEYS.filter(
        (key) => aggregateCreatureMetrics[key] !== metrics[key],
    );
    const aggregateCounterDomainValid =
        isNonnegativeSafeCounter(candidateEngineRejections) &&
        hasValidMetricCounterDomain(metrics) &&
        Object.values(byCreature).every(hasValidMetricCounterDomain) &&
        hasValidMountainCounterDomain(mountainStates);
    const aggregateMetricSemanticsValid =
        hasSemanticallyValidMetrics(metrics) &&
        Object.values(byCreature).every((creatureMetrics) => hasSemanticallyValidMetrics(creatureMetrics));
    const checks: Record<string, IV08BlockCenterActionGate> = {
        source_commit_bound: gate(
            sourceBound,
            options.sourceDirty ? `${options.sourceCommit ?? "missing"} (dirty)` : (options.sourceCommit ?? "missing"),
            "clean 40-character source SHA",
        ),
        exact_game_count: gate(records.length === options.games, records.length, `= ${options.games}`),
        unique_games: gate(seenGames.size === records.length, seenGames.size, `= ${records.length}`),
        balanced_candidate_seats: gate(
            candidateSeats.green === candidateSeats.red,
            `${candidateSeats.green}:${candidateSeats.red}`,
            "green = red",
        ),
        block_center_only: gate(
            Object.keys(maps).length === 1 && (maps[String(PBTypes.GridVals.BLOCK_CENTER)] ?? 0) === records.length,
            JSON.stringify(maps),
            `only map ${PBTypes.GridVals.BLOCK_CENTER}`,
        ),
        observed_turns_positive: gate(metrics.observedTurns > 0, metrics.observedTurns, "> 0"),
        every_record_has_observations: gate(
            recordsWithObservations === records.length,
            recordsWithObservations,
            `= ${records.length}`,
        ),
        mountain_state_turn_integrity: gate(
            recordsWithConsistentMountainTurns === records.length && mountainStateTurns === metrics.observedTurns,
            `${recordsWithConsistentMountainTurns}/${records.length} records; ${mountainStateTurns}/${metrics.observedTurns} total`,
            "every record and aggregate mountain-state sum = observed turns",
        ),
        creature_turn_integrity: gate(
            recordsWithConsistentCreatureTurns === records.length && creatureObservedTurns === metrics.observedTurns,
            `${recordsWithConsistentCreatureTurns}/${records.length} records; ${creatureObservedTurns}/${metrics.observedTurns} total`,
            "every record and aggregate by-creature observed turns = observed turns",
        ),
        creature_metric_integrity: gate(
            recordsWithConsistentCreatureMetrics === records.length && aggregateCreatureMetricMismatches.length === 0,
            `${recordsWithConsistentCreatureMetrics}/${records.length} records; aggregate mismatches: ${aggregateCreatureMetricMismatches.join(",") || "none"}`,
            "every record and aggregate by-creature metric sum = global metric",
        ),
        counter_domain_integrity: gate(
            recordsWithValidCounterDomain === records.length && aggregateCounterDomainValid,
            `${recordsWithValidCounterDomain}/${records.length} records; aggregate ${aggregateCounterDomainValid ? "valid" : "invalid"}`,
            "every record and aggregate counter is a nonnegative safe integer",
        ),
        failure_sample_integrity: gate(
            recordsWithConsistentFailureSamples === records.length,
            recordsWithConsistentFailureSamples,
            `= ${records.length} records with plan-bound samples backed by their counters`,
        ),
        record_result_integrity: gate(
            recordsWithValidResultDomain === records.length,
            recordsWithValidResultDomain,
            `= ${records.length} records with valid winner, laps, end reason, and crash fields`,
        ),
        metric_semantic_integrity: gate(
            recordsWithSemanticallyValidMetrics === records.length && aggregateMetricSemanticsValid,
            `${recordsWithSemanticallyValidMetrics}/${records.length} records; aggregate ${aggregateMetricSemanticsValid ? "valid" : "invalid"}`,
            "every record and aggregate metric obeys turn, subset, and late-lap invariants",
        ),
        mountain_state_coverage: gate(
            Object.values(mountainStates).every((count) => count > 0),
            Object.entries(mountainStates)
                .map(([state, count]) => `${state}:${count}`)
                .join(","),
            "every intact/partial/cleared state > 0",
        ),
        oracle_direct_exposure_positive: gate(
            metrics.oracleDirectEligibleTurns > 0,
            metrics.oracleDirectEligibleTurns,
            "> 0",
        ),
        mountain_adjacent_direct_exposure_positive: gate(
            metrics.mountainAdjacentDirectEligibleTurns > 0,
            metrics.mountainAdjacentDirectEligibleTurns,
            "> 0",
        ),
        late_direct_exposure_positive: gate(
            metrics.lateDirectEligibleTurns > 0,
            metrics.lateDirectEligibleTurns,
            "> 0",
        ),
        eliminations_only: gate(
            Object.keys(endReasons).length === 1 && (endReasons.elimination ?? 0) === records.length,
            JSON.stringify(endReasons),
            `elimination = ${records.length} and no other end reason`,
        ),
        crashes_zero: gate((endReasons.crash ?? 0) === 0, endReasons.crash ?? 0, "= 0"),
        stuck_zero: gate((endReasons.stuck ?? 0) === 0, endReasons.stuck ?? 0, "= 0"),
        turn_caps_zero: gate((endReasons.turn_cap ?? 0) === 0, endReasons.turn_cap ?? 0, "= 0"),
        engine_rejections_zero: gate(candidateEngineRejections === 0, candidateEngineRejections, "= 0"),
        strategy_rejections_zero: gate(metrics.strategyRejectedActions === 0, metrics.strategyRejectedActions, "= 0"),
        strategy_engine_rejection_parity: gate(
            recordsWithRejectionParity === records.length &&
                metrics.strategyRejectedActions === candidateEngineRejections,
            `${recordsWithRejectionParity}/${records.length} records; ${metrics.strategyRejectedActions}/${candidateEngineRejections} aggregate`,
            "strategy observer rejections = candidate engine rejections in every record and aggregate",
        ),
        observer_pairing_faults_zero: gate(metrics.observerPairingFaults === 0, metrics.observerPairingFaults, "= 0"),
        shared_catalog_enumeration_not_truncated: gate(
            metrics.sharedCatalogEnumerationTruncations === 0,
            metrics.sharedCatalogEnumerationTruncations,
            "= 0",
        ),
        oracle_probe_rejections_zero: gate(metrics.oracleProbeRejections === 0, metrics.oracleProbeRejections, "= 0"),
        catalog_probe_rejections_zero: gate(
            metrics.catalogProbeRejections === 0,
            metrics.catalogProbeRejections,
            "= 0",
        ),
        recovery_turns_zero: gate(metrics.recoveryTurns === 0, metrics.recoveryTurns, "= 0"),
        urgent_catalog_misses_zero: gate(metrics.urgentCatalogMisses === 0, metrics.urgentCatalogMisses, "= 0"),
        urgent_direct_action_misses_zero: gate(
            metrics.lateDirectActionMisses === 0,
            metrics.lateDirectActionMisses,
            "= 0",
        ),
        urgent_mountain_adjacent_misses_zero: gate(
            metrics.urgentMountainAdjacentMisses === 0,
            metrics.urgentMountainAdjacentMisses,
            "= 0",
        ),
        urgent_repeated_non_progress_with_direct_option_zero: gate(
            metrics.urgentRepeatedNonProgressWithDirectOption === 0,
            metrics.urgentRepeatedNonProgressWithDirectOption,
            "= 0",
        ),
        urgent_mountain_terminal_jitter_zero: gate(
            metrics.urgentMountainTerminalJitter === 0,
            metrics.urgentMountainTerminalJitter,
            "= 0",
        ),
        urgent_combat_droughts_zero: gate(metrics.urgentCombatDroughts === 0, metrics.urgentCombatDroughts, "= 0"),
    };
    const failed = Object.entries(checks)
        .filter(([, check]) => !check.pass)
        .map(([name]) => name);
    return {
        schema: V08_BLOCK_CENTER_ACTION_PANEL_SCHEMA,
        sourceCommit: options.sourceCommit ?? null,
        sourceDirty: options.sourceDirty === true,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        options: {
            games: options.games,
            baseSeed: options.baseSeed,
            amountMode: options.amountMode ?? "expBudget",
            liveSetup: options.liveSetup !== false,
            maxLaps: options.maxLaps ?? 60,
            inheritCandidateEnvironment: options.inheritCandidateEnvironment === true,
        },
        planSha256: fingerprintV08BlockCenterActionPlan(options),
        games: records.length,
        candidateSeats,
        maps,
        endReasons,
        candidateEngineRejections,
        metrics,
        byCreature,
        mountainStates,
        gates: { pass: failed.length === 0, failed, checks },
        failureSamples,
    };
}

export function runV08BlockCenterActionPanelConcurrent(
    options: IV08BlockCenterActionPanelOptions,
    concurrency: number,
    onGame?: (record: IV08BlockCenterActionRecord) => void,
): Promise<IV08BlockCenterActionSummary> {
    validateOptions(options);
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, options.games));
    if (poolSize === 1) {
        const records = Array.from({ length: options.games }, (_, game) =>
            runV08BlockCenterActionPanelGame(options, game),
        );
        records.forEach(onGame ?? (() => undefined));
        return Promise.resolve(summarizeV08BlockCenterActionPanel(options, records));
    }
    return new Promise((resolvePromise, rejectPromise) => {
        const records: IV08BlockCenterActionRecord[] = [];
        const callbackBuffer = new Map<number, IV08BlockCenterActionRecord>();
        const liveWorkers = new Set<Worker>();
        let dispatched = 0;
        let completed = 0;
        let nextCallbackGame = 0;
        let settled = false;
        const stopWorkers = (): void => {
            for (const worker of liveWorkers) worker.postMessage({ type: "stop" });
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            stopWorkers();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= options.games) {
                worker.postMessage({ type: "stop" });
            } else {
                worker.postMessage({ type: "game", game: dispatched++ });
            }
        };
        const emitReadyRecords = (record: IV08BlockCenterActionRecord): void => {
            if (!onGame) return;
            callbackBuffer.set(record.game, record);
            while (callbackBuffer.has(nextCallbackGame)) {
                const ready = callbackBuffer.get(nextCallbackGame)!;
                callbackBuffer.delete(nextCallbackGame);
                onGame(ready);
                nextCallbackGame += 1;
            }
        };
        const workerUrl = new URL("./v0_8_block_center_action_panel_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(workerUrl, { workerData: { options } });
            liveWorkers.add(worker);
            worker.on(
                "message",
                (message: { type: "ready" } | { type: "result"; record: IV08BlockCenterActionRecord }) => {
                    if (settled) return;
                    if (message.type === "ready") {
                        dispatch(worker);
                        return;
                    }
                    records.push(message.record);
                    completed += 1;
                    try {
                        emitReadyRecords(message.record);
                    } catch (error) {
                        fail(error);
                        return;
                    }
                    if (completed === options.games) {
                        stopWorkers();
                        try {
                            const summary = summarizeV08BlockCenterActionPanel(options, records);
                            settled = true;
                            resolvePromise(summary);
                        } catch (error) {
                            fail(error);
                        }
                    } else {
                        dispatch(worker);
                    }
                },
            );
            worker.on("exit", (code) => {
                liveWorkers.delete(worker);
                if (settled) return;
                if (code !== 0) {
                    fail(new Error(`BLOCK_CENTER action worker exited with code ${code}`));
                } else if (liveWorkers.size === 0 && completed < options.games) {
                    fail(new Error(`All BLOCK_CENTER action workers exited after ${completed}/${options.games} games`));
                }
            });
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

const captureSource = (): { commit: string; dirty: boolean } => {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
    }).trim();
    return { commit, dirty: status.length > 0 };
};

export function v08BlockCenterArtifactPrefix(
    candidateVersion: string,
    opponentVersion: string,
    games: number,
    stamp: string,
): string {
    return `v08_block_center_${candidateVersion}_vs_${opponentVersion}_${games}_${stamp}`.replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
    );
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
        console.log(
            "usage: bun src/simulation/v0_8_block_center_action_panel.ts [--candidate v0.8] [--opponent v0.7] [--games 50000] [--seed 2607280041] [--concurrency 12] [--out-dir sim-out] [--source-commit 40SHA] [--inherit-candidate-environment]",
        );
        return;
    }
    const candidateVersion = readFlag(args, "--candidate") ?? "v0.8";
    const opponentVersion = readFlag(args, "--opponent") ?? "v0.7";
    const source = captureSource();
    const requestedSource = readFlag(args, "--source-commit") ?? source.commit;
    if (requestedSource !== source.commit) {
        throw new Error(`--source-commit ${requestedSource} does not match checked-out HEAD ${source.commit}`);
    }
    const options: IV08BlockCenterActionPanelOptions = {
        candidateVersion,
        opponentVersion,
        games: Number(readFlag(args, "--games") ?? V08_BLOCK_CENTER_ACTION_PANEL_DEFAULT_GAMES),
        baseSeed: Number(readFlag(args, "--seed") ?? V08_BLOCK_CENTER_ACTION_PANEL_DEFAULT_SEED),
        inheritCandidateEnvironment: args.includes("--inherit-candidate-environment"),
        sourceCommit: source.commit,
        sourceDirty: source.dirty,
    };
    validateOptions(options);
    const requestedConcurrency = Number(
        readFlag(args, "--concurrency") ?? V08_BLOCK_CENTER_ACTION_PANEL_DEFAULT_CONCURRENCY,
    );
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency <= 0) {
        throw new RangeError(`--concurrency must be a positive integer; got ${requestedConcurrency}`);
    }
    const concurrency = Math.min(requestedConcurrency, availableParallelism(), options.games);
    const outDir = readFlag(args, "--out-dir") ?? join(process.cwd(), "sim-out");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = v08BlockCenterArtifactPrefix(candidateVersion, opponentVersion, options.games, stamp);
    const recordsPath = join(outDir, `${prefix}.records.jsonl`);
    const summaryPath = join(outDir, `${prefix}.summary.json`);
    writeFileSync(recordsPath, "");
    process.env.SIM_NO_ACTIONS = "1";
    let completed = 0;
    const started = Date.now();
    console.log(
        `Running ${options.games} BLOCK_CENTER action-oracle games with ${concurrency} workers -> ${recordsPath}`,
    );
    const summary = await runV08BlockCenterActionPanelConcurrent(options, concurrency, (record) => {
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
    await main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
