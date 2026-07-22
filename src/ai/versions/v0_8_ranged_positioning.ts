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
import {
    getPositionForCell,
    getPositionForCells,
    getRangeAttackSideCenter,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import type { IWeightedRoute } from "../../grid/path_definitions";
import { ObstacleType } from "../../obstacles/obstacle_type";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import { canUnitLandAt } from "../ai";
import type { IDecisionContext, V08SupportedPrepinEgressFunnelStage } from "../ai_strategy";
import { estimatePrimaryMeleeDamage } from "../melee_damage_estimate";
import { otherTeam } from "./v0_1";
import { isV08DirectCombatDecision, v08DominantFinishState } from "./v0_8_dominant_finish";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;

const SUPPORTED_PREPIN_EGRESS_ENABLED_ENV = "V08_SUPPORTED_PREPIN_EGRESS";
const SUPPORTED_PREPIN_EGRESS_VERSIONS_ENV = "V08_SUPPORTED_PREPIN_EGRESS_VERSIONS";

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

function footprintForAnchor(unit: Unit, anchor: XY): XY[] {
    if (unit.isSmallSize()) {
        return [{ x: anchor.x, y: anchor.y }];
    }
    return [
        { x: anchor.x, y: anchor.y },
        { x: anchor.x, y: anchor.y - 1 },
        { x: anchor.x - 1, y: anchor.y },
        { x: anchor.x - 1, y: anchor.y - 1 },
    ];
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
    const footprint = footprintForAnchor(unit, route.cell);
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

const sameCell = (left: XY, right: XY): boolean => left.x === right.x && left.y === right.y;

function canLandOnHypotheticalMatrix(unit: Unit, anchor: XY, matrix: readonly (readonly number[])[]): boolean {
    const current = unit.getCells();
    for (const cell of footprintForAnchor(unit, anchor)) {
        const value = matrix[cell.y]?.[cell.x];
        if (value === undefined) return false;
        if (current.some((occupied) => sameCell(occupied, cell))) continue;
        if (value === 0) continue;
        if (value === ObstacleType.LAVA && unit.hasAbilityActive("Made of Fire")) continue;
        if (value === ObstacleType.WATER && unit.hasAbilityActive("Made of Water")) continue;
        return false;
    }
    return true;
}

/**
 * Exact movement-catalog reach using the same PathHelper as the engine's melee candidate generator. Aggression
 * weights are deliberately omitted: proving safety against the more permissive geometric path is fail-closed.
 */
function canMeleeFootprintThisActivation(
    threat: Unit,
    targetFootprint: readonly XY[],
    matrix: number[][],
    context: IDecisionContext,
): boolean {
    const anchors: XY[] = [threat.getBaseCell()];
    if (threat.canMove()) {
        const movePath = context.pathHelper.getMovePath(
            threat.getBaseCell(),
            matrix,
            threat.getSteps(),
            undefined,
            threat.canFly(),
            threat.isSmallSize(),
            threat.canTraverseLava(),
        );
        for (const routes of movePath.knownPaths.values()) {
            const anchor = routes[0]?.cell;
            if (anchor && !anchors.some((known) => sameCell(known, anchor))) {
                anchors.push(anchor);
            }
        }
    }
    return anchors.some(
        (anchor) =>
            canLandOnHypotheticalMatrix(threat, anchor, matrix) &&
            context.grid.areCellsAdjacent(footprintForAnchor(threat, anchor), [...targetFootprint]),
    );
}

function pendingMeleeThreats(unit: Unit, context: IDecisionContext): Unit[] {
    const fightProperties = context.fightProperties!;
    return context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => {
        const pending =
            !fightProperties.hasAlreadyMadeTurn(enemy.getId()) ||
            fightProperties.hourglassIncludes(enemy.getId()) ||
            fightProperties.moralePlusIncludes(enemy.getId()) ||
            fightProperties.upNextIncludes(enemy.getId());
        return (
            !enemy.isDead() &&
            pending &&
            // Every attack class receives a legal melee option unless No Melee is active. In particular,
            // native shooters and casters may move in and pin this unit, so the safety proof must include them.
            !enemy.hasAbilityActive("No Melee")
        );
    });
}

function fixedNativeMeleeGuards(unit: Unit, context: IDecisionContext): Unit[] {
    const fightProperties = context.fightProperties!;
    return context.unitsHolder.getAllAllies(unit.getTeam()).filter((ally) => {
        const nativeAttackType = ally.getUnitProperties().attack_type;
        const actedWithoutQueuedReactivation =
            fightProperties.hasAlreadyMadeTurn(ally.getId()) &&
            !fightProperties.hourglassIncludes(ally.getId()) &&
            !fightProperties.moralePlusIncludes(ally.getId()) &&
            !fightProperties.upNextIncludes(ally.getId());
        return (
            ally.getId() !== unit.getId() &&
            !ally.isDead() &&
            (nativeAttackType === MELEE || nativeAttackType === MELEE_MAGIC) &&
            (!ally.canMove() || actedWithoutQueuedReactivation)
        );
    });
}

function canRestoreClearedCells(context: IDecisionContext, cells: readonly XY[]): boolean {
    const gridType = context.grid.getGridType();
    if (gridType !== PBTypes.GridVals.LAVA_CENTER && gridType !== PBTypes.GridVals.WATER_CENTER) return true;
    const terrainCells = context.grid.getCenterCells();
    return cells.every((cell) => !terrainCells.some((terrain) => sameCell(cell, terrain)));
}

function postMoveMatrix(unit: Unit, destination: readonly XY[], context: IDecisionContext): number[][] | undefined {
    const current = unit.getCells();
    if (!canRestoreClearedCells(context, current)) return undefined;
    const matrix = context.matrix.map((row) => row.slice());
    const terrain = context.grid.getMatrixNoUnits();
    for (const cell of current) matrix[cell.y]![cell.x] = terrain[cell.y]![cell.x]!;
    for (const cell of destination) matrix[cell.y]![cell.x] = unit.getTeam();
    return matrix;
}

function matrixWithoutGuard(
    withGuard: readonly (readonly number[])[],
    guard: Unit,
    context: IDecisionContext,
): number[][] | undefined {
    if (!canRestoreClearedCells(context, guard.getCells())) return undefined;
    const matrix = withGuard.map((row) => [...row]);
    const terrain = context.grid.getMatrixNoUnits();
    for (const cell of guard.getCells()) matrix[cell.y]![cell.x] = terrain[cell.y]![cell.x]!;
    return matrix;
}

function hasSameNonRegressingRangeSignature(
    current: ReturnType<NonNullable<IDecisionContext["attackHandler"]>["evaluateRangeAttack"]>,
    candidate: ReturnType<NonNullable<IDecisionContext["attackHandler"]>["evaluateRangeAttack"]>,
): boolean {
    if (
        current.attackObstacle ||
        candidate.attackObstacle ||
        current.affectedUnits.length !== candidate.affectedUnits.length ||
        current.rangeAttackDivisors.length !== candidate.rangeAttackDivisors.length ||
        current.affectedUnits.length !== current.rangeAttackDivisors.length
    ) {
        return false;
    }
    for (let index = 0; index < current.affectedUnits.length; index += 1) {
        const currentIds = current.affectedUnits[index]!.map((affected) => affected.getId());
        const candidateIds = candidate.affectedUnits[index]!.map((affected) => affected.getId());
        if (
            currentIds.length !== candidateIds.length ||
            currentIds.some((id, affectedIndex) => id !== candidateIds[affectedIndex])
        ) {
            return false;
        }
        const currentDivisor = current.rangeAttackDivisors[index];
        const candidateDivisor = candidate.rangeAttackDivisors[index];
        if (
            currentDivisor === undefined ||
            candidateDivisor === undefined ||
            !Number.isFinite(currentDivisor) ||
            !Number.isFinite(candidateDivisor) ||
            currentDivisor <= 0 ||
            candidateDivisor <= 0 ||
            candidateDivisor > currentDivisor
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Research-only pre-pin egress. The geometry catalog is intentionally computed for every baseline seat while the
 * global arm is enabled, including the catalog-only control, because PathHelper consumes seeded tie-break RNG.
 * Only the selector-scoped seat may retain the proposal.
 */
function supportedPrepinEgress(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    strategyVersion: string,
): GameAction[] {
    if (process.env[SUPPORTED_PREPIN_EGRESS_ENABLED_ENV] !== "1") return decision;
    const attackHandler = context.attackHandler;
    const fightProperties = context.fightProperties;
    const shot = decision[0];
    if (
        !attackHandler ||
        !fightProperties ||
        decision.length !== 1 ||
        shot?.type !== "range_attack" ||
        !shot.aimCell ||
        shot.aimSide === undefined
    ) {
        return decision;
    }
    const selectorVersions = (process.env[SUPPORTED_PREPIN_EGRESS_VERSIONS_ENV] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const selectorEnabled = selectorVersions.includes(strategyVersion);
    const emitFunnel = (stage: V08SupportedPrepinEgressFunnelStage): void => {
        if (!selectorEnabled) return;
        context.policyEventObserver?.({
            kind: "v0.8_supported_prepin_egress_funnel",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: fightProperties.getCurrentLap(),
            stage,
        });
    };
    emitFunnel("ordinary_shot");
    if (
        unit.getUnitProperties().attack_type !== RANGE ||
        !unit.isRangeCapable() ||
        !unit.canMove() ||
        unit.getRangeShots() <= 0 ||
        unit.hasAbilityActive("Sniper") ||
        unit.hasAbilityActive("Through Shot") ||
        unit.hasAbilityActive("Large Caliber") ||
        unit.hasAbilityActive("Area Throw") ||
        unit.hasAbilityActive("Double Shot") ||
        unit.hasDebuffActive("Range Null Field Aura") ||
        unit.hasDebuffActive("Rangebane") ||
        attackHandler.canBeAttackedByMelee(
            unit.getPosition(),
            unit.isSmallSize(),
            context.grid.getEnemyAggrMatrixByUnitId(unit.getId()),
        ) ||
        !attackHandler.canLandRangeAttack(unit, context.grid.getEnemyAggrMatrixByUnitId(unit.getId())) ||
        v08DominantFinishState(context.unitsHolder, unit.getTeam(), fightProperties.getCurrentLap()).active
    ) {
        return decision;
    }
    emitFunnel("eligible_shooter");
    const target = context.unitsHolder.getAllUnits().get(shot.targetId);
    if (!target || target.isDead() || isHidden(target)) return decision;
    const targetCanCounter =
        target.isRangeCapable() &&
        target.getRangeShots() > 0 &&
        !unit.canSkipResponse() &&
        !fightProperties.hasAlreadyRepliedAttack(target.getId()) &&
        target.canRespond(RANGE) &&
        !target.hasDebuffActive("Range Null Field Aura") &&
        !target.hasDebuffActive("Rangebane") &&
        !attackHandler.canBeAttackedByMelee(
            target.getPosition(),
            target.isSmallSize(),
            context.grid.getEnemyAggrMatrixByUnitId(target.getId()),
        );
    if (targetCanCounter) return decision;
    emitFunnel("target_no_counter");

    const threats = pendingMeleeThreats(unit, context);
    const currentThreats = threats.filter((threat) =>
        canMeleeFootprintThisActivation(threat, unit.getCells(), context.matrix, context),
    );
    if (!currentThreats.length) return decision;
    emitFunnel("current_threat");
    const guards = fixedNativeMeleeGuards(unit, context);
    if (!guards.length) return decision;
    emitFunnel("fixed_guard");

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
    if (currentEvaluation.affectedUnits[0]?.[0]?.getId() !== target.getId()) return decision;
    emitFunnel("current_signature");

    const proposals: Array<{ route: IWeightedRoute; footprint: XY[] }> = [];
    const routes = reachableRoutes(unit, context);
    if (routes.length) emitFunnel("reachable_route");
    let hasSafeRoute = false;
    let hasCausalGuardRoute = false;
    let hasRetainedSignatureRoute = false;
    for (const route of routes) {
        const footprint = footprintForAnchor(unit, route.cell);
        const matrix = postMoveMatrix(unit, footprint, context);
        const origin = getPositionForCells(settings, footprint);
        if (
            !matrix ||
            !origin ||
            threats.some((threat) => canMeleeFootprintThisActivation(threat, footprint, matrix, context))
        ) {
            continue;
        }
        hasSafeRoute = true;
        const hasCausalGuard = guards.some((guard) => {
            const withoutGuard = matrixWithoutGuard(matrix, guard, context);
            return (
                withoutGuard !== undefined &&
                currentThreats.every((threat) =>
                    canMeleeFootprintThisActivation(threat, footprint, withoutGuard, context),
                )
            );
        });
        if (!hasCausalGuard) continue;
        hasCausalGuardRoute = true;
        const targetPosition = getRangeAttackSideCenter(
            settings,
            shot.aimCell,
            shot.aimSide as RangeAttackCellSide,
            origin,
        );
        const candidateEvaluation = attackHandler.evaluateRangeAttack(
            context.unitsHolder.getAllUnits(),
            unit,
            origin,
            targetPosition,
            false,
            false,
            false,
        );
        if (
            candidateEvaluation.affectedUnits[0]?.[0]?.getId() === target.getId() &&
            hasSameNonRegressingRangeSignature(currentEvaluation, candidateEvaluation)
        ) {
            hasRetainedSignatureRoute = true;
            proposals.push({ route, footprint });
        }
    }
    if (hasSafeRoute) emitFunnel("safe_route");
    if (hasCausalGuardRoute) emitFunnel("causal_guard");
    if (hasRetainedSignatureRoute) emitFunnel("retained_signature");
    proposals.sort(
        (left, right) =>
            routeCost(left.route) - routeCost(right.route) ||
            left.route.cell.y - right.route.cell.y ||
            left.route.cell.x - right.route.cell.x,
    );
    const best = proposals[0];
    if (!best) return decision;

    if (!selectorEnabled) return decision;
    context.policyEventObserver?.({
        kind: "v0.8_supported_prepin_egress",
        unitId: unit.getId(),
        creatureName: unit.getName(),
        team: unit.getTeam(),
        lap: fightProperties.getCurrentLap(),
    });
    return [moveAction(unit, best.route, best.footprint), shot];
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
 * Conservative lower bound for the responder's divisor after the actor occupies `footprint`. The engine
 * measures the response at the first occupied point, not the destination centre, so use the closest point of
 * every destination cell. A lower divisor means a stronger response; taking the minimum is deliberately safe.
 */
function minimumFootprintResponseDivisor(target: Unit, footprint: readonly XY[], context: IDecisionContext): number {
    const attackHandler = context.attackHandler!;
    const settings = context.grid.getSettings();
    const source = target.getPosition();
    const halfStep = settings.getHalfStep();
    return Math.min(
        ...footprint.map((cell) => {
            const center = getPositionForCell(cell, settings.getMinX(), settings.getStep(), halfStep);
            const closest = {
                x: Math.max(center.x - halfStep, Math.min(source.x, center.x + halfStep)),
                y: Math.max(center.y - halfStep, Math.min(source.y, center.y + halfStep)),
            };
            return attackHandler.getRangeAttackDivisor(target, closest, source);
        }),
    );
}

/**
 * An unpinned shooter may move and then fire in the same activation. Move only when the exact authoritative
 * target-edge divisor improves and the aimed target remains the first hit. Ordinarily a native melee ally must
 * be interposed; an all-ranged army may also cross a band when the target cannot counter and no enemy can reach
 * the destination next turn. The current shot stays untouched for Sniper/AOE/piercing geometry and exposed
 * destinations.
 */
function protectedAdvanceShot(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    responseNeutralAdvance: boolean,
): GameAction[] {
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
    if (targetCanCounter && !responseNeutralAdvance) {
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

    let currentResponseDivisor: number | undefined;
    if (targetCanCounter) {
        // Special response geometry is intentionally outside this arm. For an ordinary shot, prove that the
        // current response directly hits the actor before considering any hypothetical destination.
        if (
            target.hasAbilityActive("Through Shot") ||
            target.hasAbilityActive("Large Caliber") ||
            target.hasAbilityActive("Area Throw")
        ) {
            return decision;
        }
        const response = attackHandler.evaluateRangeAttack(
            context.unitsHolder.getAllUnits(),
            target,
            target.getPosition(),
            unit.getPosition(),
            false,
            false,
            false,
        );
        if (response.affectedUnits[0]?.[0]?.getId() !== unit.getId()) {
            return decision;
        }
        currentResponseDivisor = response.rangeAttackDivisors[0];
        if (!Number.isFinite(currentResponseDivisor)) {
            return decision;
        }
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
        if (targetCanCounter && !screenedAdvance) {
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
        if (targetCanCounter) {
            // Trace the future counter-shot through the unchanged board to the empty destination. Any existing
            // unit or mountain on that ray makes the hypothetical ambiguous, so fail closed. If the ray is
            // clear, the moved actor must become its first hit; bound the worst footprint-edge divisor without
            // pretending the live unit/grid has already moved.
            const clearRay = attackHandler.evaluateRangeAttack(
                context.unitsHolder.getAllUnits(),
                target,
                target.getPosition(),
                view.position,
                false,
                false,
                false,
            );
            if (
                clearRay.attackObstacle ||
                clearRay.affectedUnits.some((affectedAtCell) => affectedAtCell.length > 0) ||
                minimumFootprintResponseDivisor(target, view.footprint, context) < currentResponseDivisor!
            ) {
                continue;
            }
        }
        if (!best || preferAdvance(view, divisor, best, bestDivisor)) {
            best = view;
            bestDivisor = divisor;
        }
    }
    if (!best) {
        return decision;
    }
    if (targetCanCounter) {
        context.policyEventObserver?.({
            kind: "v0.8_response_neutral_advance",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
        });
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
function pinnedRetreat(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    supportedDelta: boolean,
): GameAction[] {
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
    let weakMeleeTarget: Unit | undefined;
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
        weakMeleeTarget = target;
    }

    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    if (!enemies.length) {
        return decision;
    }
    const frontliners = context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((ally) => !ally.isDead() && ally.getId() !== unit.getId() && isFrontline(ally));
    const noMelee = unit.hasAbilityActive("No Melee");
    const currentProtection = protectionAt(unit.getCells(), enemies, frontliners);
    const currentUnscreened = currentProtection.reachableThreats - currentProtection.screenedThreats;
    let best: IRouteView | undefined;
    let bestUsesSupportedDelta = false;
    for (const route of reachableRoutes(unit, context)) {
        const view = routeView(unit, context, route, enemies, frontliners);
        if (!view) {
            continue;
        }
        const candidateUnscreened = view.protection.reachableThreats - view.protection.screenedThreats;
        const partialScreenImprovement =
            supportedDelta &&
            !noMelee &&
            weakMeleeTarget !== undefined &&
            frontliners.some((ally) => allyScreensThreat(view.footprint, ally, weakMeleeTarget!)) &&
            candidateUnscreened < currentUnscreened &&
            view.protection.reachableThreats <= currentProtection.reachableThreats;
        if (!noMelee && !view.protection.eligible && !partialScreenImprovement) {
            continue;
        }
        if (!best || preferRetreat(view, best)) {
            best = view;
            bestUsesSupportedDelta = !view.protection.eligible && partialScreenImprovement;
        }
    }
    if (!best) {
        return decision;
    }
    if (bestUsesSupportedDelta) {
        context.policyEventObserver?.({
            kind: "v0.8_supported_ranged_escape",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
        });
    }
    return [moveAction(unit, best.route, best.footprint)];
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
    const supportedDeltaVersions = (process.env.V08_SUPPORTED_RANGED_DELTA_VERSIONS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const supportedDelta = supportedDeltaVersions.includes(strategyVersion);
    const responseNeutralAdvanceVersions = (process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const responseNeutralAdvance = responseNeutralAdvanceVersions.includes(strategyVersion);
    const mode = process.env.V08_RANGED_POSITION_MODE ?? "both";
    const advanced =
        mode === "both" || mode === "advance"
            ? protectedAdvanceShot(unit, context, decision, responseNeutralAdvance)
            : decision;
    const retreated =
        mode === "both" || mode === "retreat" ? pinnedRetreat(unit, context, advanced, supportedDelta) : advanced;
    return supportedPrepinEgress(unit, context, retreated, strategyVersion);
}
