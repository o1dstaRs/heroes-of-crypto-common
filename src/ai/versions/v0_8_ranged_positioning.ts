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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../constants";
import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { getPositionForCells, getRangeAttackSideCenter, type RangeAttackCellSide } from "../../grid/grid_math";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import { canUnitLandAt } from "../ai";
import type { IDecisionContext } from "../ai_strategy";
import { estimatePrimaryMeleeDamage } from "../melee_damage_estimate";
import { otherTeam } from "./v0_1";
import { isV08DirectCombatDecision, v08DominantFinishState } from "./v0_8_dominant_finish";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;

const TURN_CONSUMING_NON_MELEE = new Set<GameAction["type"]>([
    "range_attack",
    "area_throw_attack",
    "obstacle_attack",
    "cast_spell",
]);

interface IProtection {
    readonly eligible: boolean;
    readonly reachableThreats: number;
    readonly screenedThreats: number;
}

interface IRouteView {
    readonly route: IWeightedRoute;
    readonly footprint: XY[];
    readonly position: XY;
    readonly protection: IProtection;
    readonly minEnemyDistance: number;
    readonly nearestFrontlineDistance: number;
    readonly futureDivisor: number;
}

const cellDistance = (left: readonly XY[], right: readonly XY[]): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const a of left) {
        for (const b of right) {
            best = Math.min(best, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
        }
    }
    return best;
};

const routeCost = (route: IWeightedRoute): number => route.weight ?? route.route.length;

const isFrontline = (unit: Unit): boolean => {
    const attackType = unit.getAttackType();
    return attackType === MELEE || attackType === MELEE_MAGIC;
};

const isHidden = (unit: Unit): boolean => unit.hasBuffActive("Hidden") || unit.hasAbilityActive("Hidden");

const rangedOutput = (units: readonly Unit[]): number =>
    units.reduce(
        (total, candidate) =>
            candidate.isDead() || !candidate.isRangeCapable()
                ? total
                : total +
                  Math.max(0, candidate.getRangeShots()) *
                      Math.max(0, candidate.getAttackDamageMax()) *
                      Math.max(0, candidate.getAmountAlive()),
        0,
    );

/**
 * A support screen is threat-relative: the ally must sit between the threatened shooter cell and that enemy,
 * remain within two empty-cell widths of the shooter, and be strictly closer to the enemy. This is deliberately
 * more demanding than the old "nearest melee ally" scalar. It is still a calculated-risk formation heuristic,
 * not a claim that one body blocks every path around it.
 */
function allyScreensThreat(destination: readonly XY[], ally: Unit, enemy: Unit): boolean {
    const allyCells = ally.getCells();
    const enemyCells = enemy.getCells();
    const shooterToEnemy = cellDistance(destination, enemyCells);
    const allyToEnemy = cellDistance(allyCells, enemyCells);
    const shooterToAlly = cellDistance(destination, allyCells);
    return allyToEnemy < shooterToEnemy && shooterToAlly <= 3 && allyToEnemy + shooterToAlly <= shooterToEnemy + 1;
}

function protectionAt(destination: readonly XY[], enemies: readonly Unit[], frontliners: readonly Unit[]): IProtection {
    let reachableThreats = 0;
    let screenedThreats = 0;
    for (const enemy of enemies) {
        if (enemy.hasAbilityActive("No Melee")) {
            continue;
        }
        const distance = cellDistance(destination, enemy.getCells());
        // Chebyshev is an optimistic enemy-reach bound: if even it cannot reach, pathing certainly cannot.
        if (distance > Math.ceil(Math.max(0, enemy.getSteps())) + 1) {
            continue;
        }
        reachableThreats += 1;
        if (frontliners.some((ally) => allyScreensThreat(destination, ally, enemy))) {
            screenedThreats += 1;
        }
    }
    return {
        eligible: reachableThreats === screenedThreats,
        reachableThreats,
        screenedThreats,
    };
}

function reachableRoutes(unit: Unit, context: IDecisionContext): IWeightedRoute[] {
    const enemyTeam = otherTeam(unit.getTeam());
    const base = unit.getBaseCell();
    const movePath = context.pathHelper.getMovePath(
        base,
        context.matrix,
        unit.getSteps(),
        context.grid.getAggrMatrixByTeam(enemyTeam),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );
    const routes: IWeightedRoute[] = [];
    for (const routeList of movePath.knownPaths.values()) {
        const route = routeList[0];
        if (
            !route?.route.length ||
            (route.cell.x === base.x && route.cell.y === base.y) ||
            route.hasLavaCell ||
            route.hasWaterCell ||
            !canUnitLandAt(unit, context.grid, route.cell)
        ) {
            continue;
        }
        routes.push(route);
    }
    return routes;
}

function moveAction(unit: Unit, route: IWeightedRoute, footprint: XY[]): GameAction {
    return {
        type: "move_unit",
        unitId: unit.getId(),
        path: route.route.map((cell) => ({ x: cell.x, y: cell.y })),
        targetCells: footprint.map((cell) => ({ x: cell.x, y: cell.y })),
        hasLavaCell: route.hasLavaCell,
        hasWaterCell: route.hasWaterCell,
    };
}

function routeView(
    unit: Unit,
    context: IDecisionContext,
    route: IWeightedRoute,
    enemies: readonly Unit[],
    frontliners: readonly Unit[],
): IRouteView | undefined {
    const attackHandler = context.attackHandler;
    if (!attackHandler) {
        return undefined;
    }
    const footprint = unit.isSmallSize()
        ? [{ x: route.cell.x, y: route.cell.y }]
        : (() => {
              const settings = context.grid.getSettings();
              const position = getPositionForCells(settings, [route.cell]);
              if (!position) return [];
              // StrategyV0_1's footprint convention treats a large unit's route.cell as its upper-right base.
              return [
                  { x: route.cell.x, y: route.cell.y },
                  { x: route.cell.x, y: route.cell.y - 1 },
                  { x: route.cell.x - 1, y: route.cell.y },
                  { x: route.cell.x - 1, y: route.cell.y - 1 },
              ];
          })();
    const position = getPositionForCells(context.grid.getSettings(), footprint);
    if (!footprint.length || !position) {
        return undefined;
    }
    const enemyAggro = context.grid.getEnemyAggrMatrixByUnitId(unit.getId());
    if (attackHandler.canBeAttackedByMelee(position, unit.isSmallSize(), enemyAggro)) {
        return undefined;
    }
    const protection = protectionAt(footprint, enemies, frontliners);
    const minEnemyDistance = enemies.length
        ? Math.min(...enemies.map((enemy) => cellDistance(footprint, enemy.getCells())))
        : Number.POSITIVE_INFINITY;
    const nearestFrontlineDistance = frontliners.length
        ? Math.min(...frontliners.map((ally) => cellDistance(footprint, ally.getCells())))
        : Number.POSITIVE_INFINITY;
    const futureDivisor = enemies.length
        ? Math.min(...enemies.map((enemy) => attackHandler.getRangeAttackDivisor(unit, enemy.getPosition(), position)))
        : 8;
    return {
        route,
        footprint,
        position,
        protection,
        minEnemyDistance,
        nearestFrontlineDistance,
        futureDivisor,
    };
}

function preferAdvance(left: IRouteView, leftDivisor: number, right: IRouteView, rightDivisor: number): boolean {
    if (left.protection.reachableThreats !== right.protection.reachableThreats) {
        return left.protection.reachableThreats < right.protection.reachableThreats;
    }
    if (leftDivisor !== rightDivisor) return leftDivisor < rightDivisor;
    if (routeCost(left.route) !== routeCost(right.route)) return routeCost(left.route) < routeCost(right.route);
    if (left.route.cell.y !== right.route.cell.y) return left.route.cell.y < right.route.cell.y;
    return left.route.cell.x < right.route.cell.x;
}

/**
 * An unpinned shooter may move and then fire in the same activation. Move only when the exact authoritative
 * target-edge divisor improves and the aimed target remains the first hit. Ordinarily a native melee ally must
 * be interposed; an all-ranged army may also cross a band when the target cannot counter and no enemy can reach
 * the destination next turn. The current shot stays untouched for Sniper/AOE/piercing geometry and exposed
 * destinations.
 */
function protectedAdvanceShot(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
    const attackHandler = context.attackHandler;
    const shot = decision.find((action) => action.type === "range_attack");
    if (
        !attackHandler ||
        !shot ||
        shot.type !== "range_attack" ||
        !shot.aimCell ||
        shot.aimSide === undefined ||
        decision.some((action) => action.type === "move_unit") ||
        !unit.canMove() ||
        unit.getRangeShots() <= 0 ||
        unit.hasAbilityActive("Sniper") ||
        unit.hasAbilityActive("Through Shot") ||
        unit.hasAbilityActive("Large Caliber") ||
        unit.hasAbilityActive("Area Throw") ||
        unit.hasDebuffActive("Range Null Field Aura") ||
        unit.hasDebuffActive("Rangebane") ||
        !attackHandler.canLandRangeAttack(unit, context.grid.getEnemyAggrMatrixByUnitId(unit.getId()))
    ) {
        return decision;
    }
    const target = context.unitsHolder.getAllUnits().get(shot.targetId);
    if (!target || target.isDead() || isHidden(target)) {
        return decision;
    }
    // Closing distance can also improve the target's immediate ranged response. Until that exchange is priced
    // exactly (including interception and special damage), keep the advance conservative: only close on a target
    // that cannot answer this shot. A spent response or a currently pinned/disabled shooter remains eligible.
    const targetCanCounter =
        target.isRangeCapable() &&
        target.getRangeShots() > 0 &&
        !unit.canSkipResponse() &&
        !(context.fightProperties?.hasAlreadyRepliedAttack(target.getId()) ?? false) &&
        target.canRespond(RANGE) &&
        !target.hasDebuffActive("Range Null Field Aura") &&
        !target.hasDebuffActive("Rangebane") &&
        !attackHandler.canBeAttackedByMelee(
            target.getPosition(),
            target.isSmallSize(),
            context.grid.getEnemyAggrMatrixByUnitId(target.getId()),
        );
    if (targetCanCounter) {
        return decision;
    }
    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    const enemyRangedOutput = rangedOutput(enemies);
    const finishActive = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        context.fightProperties?.getCurrentLap() ?? 0,
    ).active;
    // If our live ranged army already wins the distance battle, keep shooting from safety and make the weaker
    // side close. Once the commanding/universal finish sprint is armed, crossing a safe band is direct combat
    // rather than passive posture and must not be vetoed on the road to Armageddon.
    if (
        !finishActive &&
        enemyRangedOutput > 0 &&
        rangedOutput(context.unitsHolder.getAllAllies(unit.getTeam())) > enemyRangedOutput
    ) {
        return decision;
    }
    const frontliners = context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((ally) => !ally.isDead() && ally.getId() !== unit.getId() && isFrontline(ally));
    const settings = context.grid.getSettings();
    const currentOrigin = unit.getPosition();
    const currentTargetPosition = getRangeAttackSideCenter(
        settings,
        shot.aimCell,
        shot.aimSide as RangeAttackCellSide,
        currentOrigin,
    );
    const currentEvaluation = attackHandler.evaluateRangeAttack(
        context.unitsHolder.getAllUnits(),
        unit,
        currentOrigin,
        currentTargetPosition,
        false,
        false,
        false,
    );
    if (currentEvaluation.affectedUnits[0]?.[0]?.getId() !== target.getId()) {
        return decision;
    }
    const currentDivisor = currentEvaluation.rangeAttackDivisors[0] ?? 1;
    if (currentDivisor <= 1) {
        return decision;
    }

    let best: IRouteView | undefined;
    let bestDivisor = currentDivisor;
    for (const route of reachableRoutes(unit, context)) {
        const view = routeView(unit, context, route, enemies, frontliners);
        if (!view) {
            continue;
        }
        const screenedAdvance =
            view.protection.eligible && frontliners.some((ally) => allyScreensThreat(view.footprint, ally, target));
        const unreachableAdvance = view.protection.reachableThreats === 0;
        if (!screenedAdvance && !unreachableAdvance) {
            continue;
        }
        const targetPosition = getRangeAttackSideCenter(
            settings,
            shot.aimCell,
            shot.aimSide as RangeAttackCellSide,
            view.position,
        );
        const evaluation = attackHandler.evaluateRangeAttack(
            context.unitsHolder.getAllUnits(),
            unit,
            view.position,
            targetPosition,
            false,
            false,
            false,
        );
        if (evaluation.affectedUnits[0]?.[0]?.getId() !== target.getId()) {
            continue;
        }
        const divisor = evaluation.rangeAttackDivisors[0] ?? currentDivisor;
        if (divisor >= currentDivisor) {
            continue;
        }
        if (!best || preferAdvance(view, divisor, best, bestDivisor)) {
            best = view;
            bestDivisor = divisor;
        }
    }
    if (!best) {
        return decision;
    }
    return [moveAction(unit, best.route, best.footprint), ...decision];
}

function preferRetreat(left: IRouteView, right: IRouteView): boolean {
    const leftUnscreened = left.protection.reachableThreats - left.protection.screenedThreats;
    const rightUnscreened = right.protection.reachableThreats - right.protection.screenedThreats;
    if (leftUnscreened !== rightUnscreened) return leftUnscreened < rightUnscreened;
    if (left.protection.reachableThreats !== right.protection.reachableThreats) {
        return left.protection.reachableThreats < right.protection.reachableThreats;
    }
    if (left.minEnemyDistance !== right.minEnemyDistance) return left.minEnemyDistance > right.minEnemyDistance;
    if (left.nearestFrontlineDistance !== right.nearestFrontlineDistance) {
        return left.nearestFrontlineDistance < right.nearestFrontlineDistance;
    }
    if (left.futureDivisor !== right.futureDivisor) return left.futureDivisor < right.futureDivisor;
    return routeCost(left.route) < routeCost(right.route);
}

/** Correct inherited/late-finish weak melee only for a shooter that is genuinely pinned right now. */
function pinnedRetreat(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
    const attackHandler = context.attackHandler;
    if (
        !attackHandler ||
        unit.getAttackType() !== RANGE ||
        unit.getRangeShots() <= 0 ||
        !unit.canMove() ||
        unit.hasAbilityActive("Handyman") ||
        unit.hasDebuffActive("Range Null Field Aura") ||
        unit.hasDebuffActive("Rangebane") ||
        !attackHandler.canBeAttackedByMelee(
            unit.getPosition(),
            unit.isSmallSize(),
            context.grid.getEnemyAggrMatrixByUnitId(unit.getId()),
        ) ||
        decision.some((action) => TURN_CONSUMING_NON_MELEE.has(action.type))
    ) {
        return decision;
    }

    const melee = decision.find((action) => action.type === "melee_attack");
    if (melee?.type === "melee_attack") {
        const currentLap = context.fightProperties?.getCurrentLap() ?? 0;
        // Ranged preservation is an early/mid-fight positioning concern. Once v0.8 has armed its commanding-lead
        // or universal finish sprint, never undo the direct damage selected by that higher-priority policy.
        if (
            isV08DirectCombatDecision(decision) &&
            v08DominantFinishState(context.unitsHolder, unit.getTeam(), currentLap).active
        ) {
            return decision;
        }
        // With no later pre-wave activation left, retain real damage rather than manufacture Armageddon delay.
        if (currentLap >= NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1) {
            return decision;
        }
        const target = context.unitsHolder.getAllUnits().get(melee.targetId);
        if (!target) {
            return decision;
        }
        const estimate = estimatePrimaryMeleeDamage(
            unit,
            target,
            context,
            melee.attackFrom ?? unit.getBaseCell(),
            decision,
        );
        // Unsupported sequences fail closed; a truly secure stack kill is the one ranged melee worth preserving.
        if (!estimate || estimate.secureKill) {
            return decision;
        }
    }

    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    if (!enemies.length) {
        return decision;
    }
    const frontliners = context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((ally) => !ally.isDead() && ally.getId() !== unit.getId() && isFrontline(ally));
    const noMelee = unit.hasAbilityActive("No Melee");
    let best: IRouteView | undefined;
    for (const route of reachableRoutes(unit, context)) {
        const view = routeView(unit, context, route, enemies, frontliners);
        if (!view || (!noMelee && !view.protection.eligible)) {
            continue;
        }
        if (!best || preferRetreat(view, best)) {
            best = view;
        }
    }
    return best ? [moveAction(unit, best.route, best.footprint)] : decision;
}

/**
 * Browser-safe v0.8 ranged positioning. `v0.8s` deliberately remains the byte-policy control seat unless a
 * caller opts it in, so the M4 can measure this production candidate against an otherwise identical a13 alias.
 */
export function prioritizeV08RangedPositioning(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    strategyVersion: string,
): GameAction[] {
    const configured = process.env.V08_RANGED_POSITION_VERSIONS;
    const versions = configured === undefined ? ["v0.8"] : configured.split(",").map((value) => value.trim());
    if (!versions.includes(strategyVersion)) {
        return decision;
    }
    const mode = process.env.V08_RANGED_POSITION_MODE ?? "both";
    const advanced = mode === "both" || mode === "advance" ? protectedAdvanceShot(unit, context, decision) : decision;
    return mode === "both" || mode === "retreat" ? pinnedRetreat(unit, context, advanced) : advanced;
}
