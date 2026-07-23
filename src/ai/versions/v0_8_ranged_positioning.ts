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
    RangeAttackCellSide,
} from "../../grid/grid_math";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import { canUnitLandAt } from "../ai";
import type {
    IAIPolicyEvent,
    IDecisionContext,
    IV08SupportedBandAdvanceDetails,
    IV08SupportedBandDominanceComparisonDetails,
    IV08SupportedBandScreenedCloserComparisonDetails,
    IV08SupportedBandDuelDecisionSummary,
    V08ProtectedAdvanceGuardrailMode,
    V08ProtectedAdvanceGuardrailReason,
    V08SupportedBandDominanceReason,
    V08SupportedBandScreenedCloserReason,
    V08SupportedBandDuelDifference,
    V08SupportedBandAdvanceFunnelStage,
    V08SupportedPrepinEgressFunnelStage,
    V08SupportedRangedEscapeFunnelStage,
} from "../ai_strategy";
import { decisionPathSource, type IReadonlyWeightedRoute } from "../decision_path_catalog";
import { estimatePrimaryMeleeDamage } from "../melee_damage_estimate";
import { otherTeam } from "./v0_1";
import {
    isV08DirectCombatDecision,
    V08_DOMINANT_FINISH_START_LAP,
    v08DominantFinishState,
} from "./v0_8_dominant_finish";

const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;

const SUPPORTED_RANGED_DELTA_VERSIONS_ENV = "V08_SUPPORTED_RANGED_DELTA_VERSIONS";
const SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS_ENV = "V08_SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS";
const SUPPORTED_RANGED_DELTA_LIVE_ONLY_ENV = "V08_SUPPORTED_RANGED_DELTA_LIVE_ONLY";
const SUPPORTED_PREPIN_EGRESS_ENABLED_ENV = "V08_SUPPORTED_PREPIN_EGRESS";
const SUPPORTED_PREPIN_EGRESS_VERSIONS_ENV = "V08_SUPPORTED_PREPIN_EGRESS_VERSIONS";
const SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS_ENV = "V08_SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS";
const SUPPORTED_PREPIN_EGRESS_LIVE_ONLY_ENV = "V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY";
const SUPPORTED_BAND_ADVANCE_ENABLED_ENV = "V08_SUPPORTED_BAND_ADVANCE";
const SUPPORTED_BAND_ADVANCE_VERSIONS_ENV = "V08_SUPPORTED_BAND_ADVANCE_VERSIONS";
const SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS_ENV = "V08_SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS";
const SUPPORTED_BAND_ADVANCE_LIVE_ONLY_ENV = "V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY";
const SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS_ENV = "V08_SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS";
const SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS_ENV = "V08_SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS";
const SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS_ENV = "V08_SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS";
const SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS_ENV = "V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS";
const SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS_ENV =
    "V08_SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS";
const SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS_ENV = "V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS";
const SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS_ENV =
    "V08_SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS";
const SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS_ENV =
    "V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS";
const SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS_ENV =
    "V08_SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS";
const PROTECTED_ADVANCE_GUARDRAILS_ENABLED_ENV = "V08_PROTECTED_ADVANCE_GUARDRAILS";
const PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY_ENV = "V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY";
const PROTECTED_ADVANCE_GUARDRAILS_MODE_ENV = "V08_PROTECTED_ADVANCE_GUARDRAILS_MODE";
const PROTECTED_ADVANCE_GUARDRAILS_VERSIONS_ENV = "V08_PROTECTED_ADVANCE_GUARDRAILS_VERSIONS";

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
    readonly route: IReadonlyWeightedRoute;
    readonly footprint: XY[];
    readonly position: XY;
    readonly protection: IProtection;
    readonly minEnemyDistance: number;
    readonly nearestFrontlineDistance: number;
    readonly futureDivisor: number;
}

export interface IV08ProtectedAdvanceCatalogMetadata {
    readonly fromCell: XY;
    readonly toCell: XY;
    readonly targetId: string;
    readonly targetCreatureName: string;
    readonly divisorBefore: number;
    readonly divisorAfter: number;
    readonly ownRangedOutput: number;
    readonly enemyRangedOutput: number;
    readonly finishActive: boolean;
    readonly reachableThreatsAfter: number;
    readonly targetDistanceBefore: number;
    readonly targetDistanceAfter: number;
    readonly targetScreenedAfter: boolean;
    readonly screeningGuardId: string | null;
    readonly retainedSignatureAfter: boolean;
}

interface IProtectedAdvanceCatalog {
    readonly decision: GameAction[];
    readonly metadata?: IV08ProtectedAdvanceCatalogMetadata;
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

const routeCost = (route: IReadonlyWeightedRoute): number => route.weight ?? route.route.length;

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

function withinMeleeHorizon(destination: readonly XY[], enemy: Unit): boolean {
    return (
        !enemy.hasAbilityActive("No Melee") &&
        cellDistance(destination, enemy.getCells()) <= Math.ceil(Math.max(0, enemy.getSteps())) + 1
    );
}

function protectionAt(destination: readonly XY[], enemies: readonly Unit[], frontliners: readonly Unit[]): IProtection {
    let reachableThreats = 0;
    let screenedThreats = 0;
    for (const enemy of enemies) {
        // Chebyshev is an optimistic enemy-reach bound: if even it cannot reach, pathing certainly cannot.
        if (!withinMeleeHorizon(destination, enemy)) {
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

function reachableRoutes(unit: Unit, context: IDecisionContext): IReadonlyWeightedRoute[] {
    const enemyTeam = otherTeam(unit.getTeam());
    const base = unit.getBaseCell();
    const movePath = decisionPathSource(context).getMovePath(
        base,
        context.matrix,
        unit.getSteps(),
        context.grid.getAggrMatrixByTeam(enemyTeam),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );
    const routes: IReadonlyWeightedRoute[] = [];
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

function moveAction(unit: Unit, route: IReadonlyWeightedRoute, footprint: XY[]): GameAction {
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
    route: IReadonlyWeightedRoute,
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

function nativeMeleeGuards(unit: Unit, context: IDecisionContext): Unit[] {
    return context.unitsHolder.getAllAllies(unit.getTeam()).filter((ally) => {
        const nativeAttackType = ally.getUnitProperties().attack_type;
        return (
            ally.getId() !== unit.getId() &&
            !ally.isDead() &&
            (nativeAttackType === MELEE || nativeAttackType === MELEE_MAGIC)
        );
    });
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
 * Research-only proactive screened reposition. The geometry catalog is intentionally computed for every baseline
 * seat while the global arm is enabled, including the catalog-only control, because PathHelper consumes seeded
 * tie-break RNG. Only the selector-scoped seat may retain the proposal.
 *
 * The front line is a calculated-risk next-activation screen. Immediate safety does not depend on that unit
 * surviving or staying put: every still-pending melee-capable enemy must be outside an optimistic Chebyshev reach
 * bound at the destination. The move must strictly reduce one-activation exposure and preserve the exact shot at
 * an equal-or-better divisor. A ranged-superior army never closes; a ranged-inferior army closes only across a real
 * damage band.
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
    const liveOnly = process.env[SUPPORTED_PREPIN_EGRESS_LIVE_ONLY_ENV] === "1";
    const selectorEnabled =
        selectorVersions.includes(strategyVersion) && (!liveOnly || context.decisionOrigin === "root");
    const funnelVersions = (
        process.env[SUPPORTED_PREPIN_EGRESS_FUNNEL_VERSIONS_ENV] ??
        process.env[SUPPORTED_PREPIN_EGRESS_VERSIONS_ENV] ??
        ""
    )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const funnelEnabled = funnelVersions.includes(strategyVersion);
    const emitFunnel = (stage: V08SupportedPrepinEgressFunnelStage): void => {
        if (!funnelEnabled) return;
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

    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    const threats = enemies.filter((enemy) => !enemy.hasAbilityActive("No Melee"));
    const futureThreats = threats.filter((threat) => withinMeleeHorizon(unit.getCells(), threat));
    if (!futureThreats.length) return decision;
    emitFunnel("future_exposure");
    const guards = nativeMeleeGuards(unit, context);
    if (!guards.length) return decision;
    emitFunnel("native_guard");

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
    const currentDivisor = currentEvaluation.rangeAttackDivisors[0];
    if (currentDivisor === undefined || !Number.isFinite(currentDivisor) || currentDivisor <= 0) return decision;

    const pendingThreats = pendingMeleeThreats(unit, context);
    const currentTargetDistance = cellDistance(unit.getCells(), target.getCells());
    const currentMinEnemyDistance = Math.min(
        ...enemies.map((enemy) => cellDistance(unit.getCells(), enemy.getCells())),
    );
    const rangedSuperior = rangedOutput(context.unitsHolder.getAllAllies(unit.getTeam())) > rangedOutput(enemies);

    const proposals: Array<{
        route: IReadonlyWeightedRoute;
        footprint: XY[];
        divisor: number;
        exposure: number;
        targetDistance: number;
        minEnemyDistance: number;
    }> = [];
    const routes = reachableRoutes(unit, context);
    if (routes.length) emitFunnel("reachable_route");
    let hasPendingDistanceSafeRoute = false;
    let hasScreenedRoute = false;
    let hasExposureImprovedRoute = false;
    let hasRetainedSignatureRoute = false;
    let hasPostureSafeRoute = false;
    for (const route of routes) {
        const footprint = footprintForAnchor(unit, route.cell);
        const origin = getPositionForCells(settings, footprint);
        if (
            !origin ||
            attackHandler.canBeAttackedByMelee(
                origin,
                unit.isSmallSize(),
                context.grid.getEnemyAggrMatrixByUnitId(unit.getId()),
            ) ||
            pendingThreats.some((threat) => withinMeleeHorizon(footprint, threat))
        ) {
            continue;
        }
        hasPendingDistanceSafeRoute = true;
        const destinationThreats = threats.filter((threat) => withinMeleeHorizon(footprint, threat));
        const preservesFrontlineFormation = guards.some((guard) =>
            futureThreats.some((threat) => allyScreensThreat(footprint, guard, threat)),
        );
        const screensEveryResidualThreat = destinationThreats.every((threat) =>
            guards.some((guard) => allyScreensThreat(footprint, guard, threat)),
        );
        if (!preservesFrontlineFormation || !screensEveryResidualThreat) {
            continue;
        }
        hasScreenedRoute = true;
        const exposure = destinationThreats.length;
        if (exposure >= futureThreats.length) continue;
        hasExposureImprovedRoute = true;
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
            const divisor = candidateEvaluation.rangeAttackDivisors[0]!;
            const targetDistance = cellDistance(footprint, target.getCells());
            const minEnemyDistance = Math.min(...enemies.map((enemy) => cellDistance(footprint, enemy.getCells())));
            const closes = targetDistance < currentTargetDistance || minEnemyDistance < currentMinEnemyDistance;
            if ((rangedSuperior && closes) || (!rangedSuperior && closes && divisor >= currentDivisor)) continue;
            hasPostureSafeRoute = true;
            proposals.push({
                route,
                footprint,
                divisor,
                exposure,
                targetDistance,
                minEnemyDistance,
            });
        }
    }
    if (hasPendingDistanceSafeRoute) emitFunnel("pending_distance_safe");
    if (hasScreenedRoute) emitFunnel("screened_route");
    if (hasExposureImprovedRoute) emitFunnel("exposure_improved");
    if (hasRetainedSignatureRoute) emitFunnel("retained_signature");
    if (hasPostureSafeRoute) emitFunnel("posture_safe");
    proposals.sort(
        (left, right) =>
            left.exposure - right.exposure ||
            left.divisor - right.divisor ||
            right.minEnemyDistance - left.minEnemyDistance ||
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
        details: {
            fromCell: { ...unit.getBaseCell() },
            toCell: { ...best.route.cell },
            targetId: target.getId(),
            targetCreatureName: target.getName(),
            exposureBefore: futureThreats.length,
            exposureAfter: best.exposure,
            divisorBefore: currentDivisor,
            divisorAfter: best.divisor,
            targetDistanceBefore: currentTargetDistance,
            targetDistanceAfter: best.targetDistance,
            minEnemyDistanceBefore: currentMinEnemyDistance,
            minEnemyDistanceAfter: best.minEnemyDistance,
            rangedSuperior,
        },
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

function supportedBandAdvanceActiveHere(context: IDecisionContext): boolean {
    if (process.env[SUPPORTED_BAND_ADVANCE_ENABLED_ENV] !== "1") return false;
    return process.env[SUPPORTED_BAND_ADVANCE_LIVE_ONLY_ENV] !== "1" || context.decisionOrigin === "root";
}

/**
 * Research-only replacement for the legacy protected advance at measured roots. Both experiment seats build the
 * same route catalog (and therefore consume the same seeded path tie-breaks); only the selector-scoped seat may
 * retain the proposal. A move is eligible only when a native melee guard remains interposed, every living enemy is
 * outside its optimistic next-activation melee horizon, the exact shot signature is unchanged, and the primary
 * target reaches the full-damage ranged band. The earlier 4x-to-2x trial created an Armageddon by lengthening a
 * losing fight; requiring a 1x destination keeps the observed 2x-to-1x tempo wins and removes that partial close.
 */
function supportedBandAdvance(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    strategyVersion: string,
): GameAction[] {
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

    const selectorVersions = (process.env[SUPPORTED_BAND_ADVANCE_VERSIONS_ENV] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const selectorEnabled = selectorVersions.includes(strategyVersion);
    const funnelVersions = (
        process.env[SUPPORTED_BAND_ADVANCE_FUNNEL_VERSIONS_ENV] ??
        process.env[SUPPORTED_BAND_ADVANCE_VERSIONS_ENV] ??
        ""
    )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const funnelEnabled = funnelVersions.includes(strategyVersion);
    const emitFunnel = (stage: V08SupportedBandAdvanceFunnelStage): void => {
        if (!funnelEnabled) return;
        context.policyEventObserver?.({
            kind: "v0.8_supported_band_advance_funnel",
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
        !attackHandler.canLandRangeAttack(unit, context.grid.getEnemyAggrMatrixByUnitId(unit.getId()))
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

    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    if (!enemies.length) return decision;
    const guards = nativeMeleeGuards(unit, context);
    if (!guards.length) return decision;
    emitFunnel("native_guard");

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
    const currentDivisor = currentEvaluation.rangeAttackDivisors[0];
    if (currentDivisor === undefined || !Number.isFinite(currentDivisor) || currentDivisor <= 1) return decision;
    emitFunnel("current_signature");

    const ownRangedOutput = rangedOutput(context.unitsHolder.getAllAllies(unit.getTeam()));
    const enemyRangedOutput = rangedOutput(enemies);
    const rangedSuperior = ownRangedOutput > enemyRangedOutput;
    const finishActive = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        fightProperties.getCurrentLap(),
    ).active;
    // The stronger ranged line should hold and force the opponent, even when the opponent has no ranged output.
    // A dominant/urgent finish sprint releases only this posture veto; every geometry and safety proof still applies.
    if (rangedSuperior && !finishActive) return decision;
    emitFunnel("ranged_posture");

    const currentTargetDistance = cellDistance(unit.getCells(), target.getCells());
    const currentMinEnemyDistance = Math.min(
        ...enemies.map((enemy) => cellDistance(unit.getCells(), enemy.getCells())),
    );
    const currentExposure = protectionAt(unit.getCells(), enemies, guards).reachableThreats;
    const routes = reachableRoutes(unit, context);
    if (routes.length) emitFunnel("reachable_route");

    let hasZeroExposureRoute = false;
    let hasTargetScreenedRoute = false;
    let hasStrictlyCloserRoute = false;
    let hasRetainedSignatureRoute = false;
    let hasImprovedBandRoute = false;
    let best: IRouteView | undefined;
    let bestDivisor = currentDivisor;
    let bestTargetDistance = currentTargetDistance;
    let bestScreeningGuardId: string | null = null;
    for (const route of routes) {
        const view = routeView(unit, context, route, enemies, guards);
        if (!view || view.protection.reachableThreats !== 0) continue;
        hasZeroExposureRoute = true;
        const screeningGuard = guards.find((guard) => allyScreensThreat(view.footprint, guard, target));
        if (!screeningGuard) continue;
        hasTargetScreenedRoute = true;
        const targetDistance = cellDistance(view.footprint, target.getCells());
        if (targetDistance >= currentTargetDistance) continue;
        hasStrictlyCloserRoute = true;
        const targetPosition = getRangeAttackSideCenter(
            settings,
            shot.aimCell,
            shot.aimSide as RangeAttackCellSide,
            view.position,
        );
        const candidateEvaluation = attackHandler.evaluateRangeAttack(
            context.unitsHolder.getAllUnits(),
            unit,
            view.position,
            targetPosition,
            false,
            false,
            false,
        );
        if (
            candidateEvaluation.affectedUnits[0]?.[0]?.getId() !== target.getId() ||
            !hasSameNonRegressingRangeSignature(currentEvaluation, candidateEvaluation)
        ) {
            continue;
        }
        hasRetainedSignatureRoute = true;
        const divisor = candidateEvaluation.rangeAttackDivisors[0];
        if (divisor === undefined || !Number.isFinite(divisor) || divisor >= currentDivisor || divisor !== 1) {
            continue;
        }
        hasImprovedBandRoute = true;
        if (!best || preferAdvance(view, divisor, best, bestDivisor)) {
            best = view;
            bestDivisor = divisor;
            bestTargetDistance = targetDistance;
            bestScreeningGuardId = screeningGuard.getId();
        }
    }
    if (hasZeroExposureRoute) emitFunnel("zero_exposure_route");
    if (hasTargetScreenedRoute) emitFunnel("target_screened");
    if (hasStrictlyCloserRoute) emitFunnel("strictly_closer");
    if (hasRetainedSignatureRoute) emitFunnel("retained_signature");
    if (hasImprovedBandRoute) emitFunnel("damage_band_improved");
    if (!best || !selectorEnabled) return decision;

    context.policyEventObserver?.({
        kind: "v0.8_supported_band_advance",
        unitId: unit.getId(),
        creatureName: unit.getName(),
        team: unit.getTeam(),
        lap: fightProperties.getCurrentLap(),
        details: {
            fromCell: { ...unit.getBaseCell() },
            toCell: { ...best.route.cell },
            targetId: target.getId(),
            targetCreatureName: target.getName(),
            exposureBefore: currentExposure,
            exposureAfter: best.protection.reachableThreats,
            divisorBefore: currentDivisor,
            divisorAfter: bestDivisor,
            targetDistanceBefore: currentTargetDistance,
            targetDistanceAfter: bestTargetDistance,
            minEnemyDistanceBefore: currentMinEnemyDistance,
            minEnemyDistanceAfter: best.minEnemyDistance,
            rangedSuperior,
            finishActive,
            targetScreenedAfter: bestScreeningGuardId !== null,
            screeningGuardId: bestScreeningGuardId,
            retainedSignatureAfter: true,
        },
    });
    return [moveAction(unit, best.route, best.footprint), shot];
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
function protectedAdvanceShotCatalog(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    responseNeutralAdvance: boolean,
): IProtectedAdvanceCatalog {
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
        return { decision };
    }
    const target = context.unitsHolder.getAllUnits().get(shot.targetId);
    if (!target || target.isDead() || isHidden(target)) {
        return { decision };
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
        return { decision };
    }
    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    const ownRangedOutput = rangedOutput(context.unitsHolder.getAllAllies(unit.getTeam()));
    const enemyRangedOutput = rangedOutput(enemies);
    const finishActive = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        context.fightProperties?.getCurrentLap() ?? 0,
    ).active;
    // If our live ranged army already wins the distance battle, keep shooting from safety and make the weaker
    // side close. Once the commanding/universal finish sprint is armed, crossing a safe band is direct combat
    // rather than passive posture and must not be vetoed on the road to Armageddon.
    if (!finishActive && enemyRangedOutput > 0 && ownRangedOutput > enemyRangedOutput) {
        return { decision };
    }
    const frontliners = context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((ally) => !ally.isDead() && ally.getId() !== unit.getId() && isFrontline(ally));
    const nativeGuards = nativeMeleeGuards(unit, context);
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
        return { decision };
    }
    const currentDivisor = currentEvaluation.rangeAttackDivisors[0] ?? 1;
    if (currentDivisor <= 1) {
        return { decision };
    }
    const currentTargetDistance = cellDistance(unit.getCells(), target.getCells());

    let currentResponseDivisor: number | undefined;
    if (targetCanCounter) {
        // Special response geometry is intentionally outside this arm. For an ordinary shot, prove that the
        // current response directly hits the actor before considering any hypothetical destination.
        if (
            target.hasAbilityActive("Through Shot") ||
            target.hasAbilityActive("Large Caliber") ||
            target.hasAbilityActive("Area Throw")
        ) {
            return { decision };
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
            return { decision };
        }
        currentResponseDivisor = response.rangeAttackDivisors[0];
        if (!Number.isFinite(currentResponseDivisor)) {
            return { decision };
        }
    }

    let best: IRouteView | undefined;
    let bestDivisor = currentDivisor;
    let bestTargetDistance = currentTargetDistance;
    let bestRetainedSignatureAfter = false;
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
        const targetDistance = cellDistance(view.footprint, target.getCells());
        const retainedSignatureAfter = hasSameNonRegressingRangeSignature(currentEvaluation, evaluation);
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
            bestTargetDistance = targetDistance;
            bestRetainedSignatureAfter = retainedSignatureAfter;
        }
    }
    if (!best) {
        return { decision };
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
    const screeningGuard = nativeGuards.find((guard) => allyScreensThreat(best.footprint, guard, target));
    return {
        decision: [moveAction(unit, best.route, best.footprint), ...decision],
        metadata: {
            fromCell: { ...unit.getBaseCell() },
            toCell: { ...best.route.cell },
            targetId: target.getId(),
            targetCreatureName: target.getName(),
            divisorBefore: currentDivisor,
            divisorAfter: bestDivisor,
            ownRangedOutput,
            enemyRangedOutput,
            finishActive,
            reachableThreatsAfter: best.protection.reachableThreats,
            targetDistanceBefore: currentTargetDistance,
            targetDistanceAfter: bestTargetDistance,
            targetScreenedAfter: screeningGuard !== undefined,
            screeningGuardId: screeningGuard?.getId() ?? null,
            retainedSignatureAfter: bestRetainedSignatureAfter,
        },
    };
}

function protectedAdvanceShot(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    responseNeutralAdvance: boolean,
): GameAction[] {
    return protectedAdvanceShotCatalog(unit, context, decision, responseNeutralAdvance).decision;
}

function supportedBandDuelDecisionSummary(decision: readonly GameAction[]): IV08SupportedBandDuelDecisionSummary {
    const move = decision.find(
        (action): action is Extract<GameAction, { type: "move_unit" }> => action.type === "move_unit",
    );
    const shot = decision.find(
        (action): action is Extract<GameAction, { type: "range_attack" }> => action.type === "range_attack",
    );
    return {
        actionTypes: decision.map((action) => action.type),
        movePath: move ? move.path.map((cell) => ({ ...cell })) : null,
        moveTargetCells: move?.targetCells ? move.targetCells.map((cell) => ({ ...cell })) : null,
        moveHasLavaCell: move?.hasLavaCell ?? null,
        moveHasWaterCell: move?.hasWaterCell ?? null,
        rangeTargetId: shot?.targetId ?? null,
        rangeAimCell: shot?.aimCell ? { ...shot.aimCell } : null,
        rangeAimSide: shot?.aimSide ?? null,
    };
}

const sameCells = (left: readonly XY[] | null, right: readonly XY[] | null): boolean =>
    left === right ||
    (left !== null &&
        right !== null &&
        left.length === right.length &&
        left.every((cell, index) => cell.x === right[index]!.x && cell.y === right[index]!.y));

const sameCellFootprint = (left: readonly XY[] | null, right: readonly XY[] | null): boolean => {
    if (left === right) return true;
    if (left === null || right === null || left.length !== right.length) return false;
    const canonical = (cells: readonly XY[]): XY[] => [...cells].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const canonicalLeft = canonical(left);
    const canonicalRight = canonical(right);
    return canonicalLeft.every((cell, index) => sameCell(cell, canonicalRight[index]!));
};

function sameSupportedBandDuelDecision(
    left: IV08SupportedBandDuelDecisionSummary,
    right: IV08SupportedBandDuelDecisionSummary,
): boolean {
    return (
        left.actionTypes.length === right.actionTypes.length &&
        left.actionTypes.every((type, index) => type === right.actionTypes[index]) &&
        sameCells(left.movePath, right.movePath) &&
        sameCells(left.moveTargetCells, right.moveTargetCells) &&
        left.moveHasLavaCell === right.moveHasLavaCell &&
        left.moveHasWaterCell === right.moveHasWaterCell &&
        left.rangeTargetId === right.rangeTargetId &&
        ((left.rangeAimCell === null && right.rangeAimCell === null) ||
            (left.rangeAimCell !== null &&
                right.rangeAimCell !== null &&
                left.rangeAimCell.x === right.rangeAimCell.x &&
                left.rangeAimCell.y === right.rangeAimCell.y)) &&
        left.rangeAimSide === right.rangeAimSide
    );
}

function supportedBandDuelDifference(
    strict: IV08SupportedBandDuelDecisionSummary,
    shipped: IV08SupportedBandDuelDecisionSummary,
): V08SupportedBandDuelDifference {
    const strictMoves = strict.movePath !== null;
    const shippedMoves = shipped.movePath !== null;
    if (!strictMoves && shippedMoves) return "strict_hold_shipped_advance";
    if (strictMoves && !shippedMoves) return "strict_advance_shipped_hold";
    if (strictMoves && shippedMoves) return "different_advance";
    return "other";
}

interface ISupportedBandDominanceComparison {
    dominant: boolean;
    metadataValid: boolean;
    reason: V08SupportedBandDominanceReason;
    strictDivisorAfter: number | null;
    strictReachableThreatsAfter: number | null;
    shippedDivisorAfter: number | null;
    shippedReachableThreatsAfter: number | null;
}

interface ISupportedBandScreenedCloserComparison {
    dominant: boolean;
    metadataValid: boolean;
    reason: V08SupportedBandScreenedCloserReason;
    strictFromCell: XY;
    strictToCell: XY;
    shippedFromCell: XY | null;
    shippedToCell: XY | null;
    strictDivisorBefore: number | null;
    strictDivisorAfter: number | null;
    strictReachableThreatsBefore: number | null;
    strictReachableThreatsAfter: number | null;
    strictTargetDistanceBefore: number | null;
    strictTargetDistanceAfter: number | null;
    strictTargetDistanceCompression: number | null;
    strictFinishActive: boolean | null;
    strictTargetScreenedAfter: boolean | null;
    strictScreeningGuardId: string | null;
    strictRetainedSignatureAfter: boolean | null;
    shippedDivisorBefore: number | null;
    shippedDivisorAfter: number | null;
    shippedReachableThreatsAfter: number | null;
    shippedTargetDistanceBefore: number | null;
    shippedTargetDistanceAfter: number | null;
    shippedTargetDistanceCompression: number | null;
    shippedFinishActive: boolean | null;
    shippedTargetScreenedAfter: boolean | null;
    shippedScreeningGuardId: string | null;
    shippedRetainedSignatureAfter: boolean | null;
}

const finiteNonnegativeCount = (value: unknown): number | null => {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const finitePositivePowerOfTwo = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && Number.isInteger(Math.log2(value))
        ? value
        : null;

const finiteBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const finiteCompression = (before: number | null, after: number | null): number | null => {
    if (before === null || after === null) return null;
    const compression = before - after;
    return Number.isSafeInteger(compression) ? compression : null;
};

const nonemptyString = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const isSafeGridCell = (value: unknown): value is XY => {
    if (typeof value !== "object" || value === null) return false;
    const cell = value as Partial<XY>;
    return (
        Number.isSafeInteger(cell.x) &&
        Number.isSafeInteger(cell.y) &&
        cell.x! >= 0 &&
        cell.x! < 16 &&
        cell.y! >= 0 &&
        cell.y! < 16
    );
};

const sameCell = (left: XY, right: XY): boolean => left.x === right.x && left.y === right.y;

const adjacentCell = (left: XY, right: XY): boolean =>
    Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) === 1;

const isMoveShotSummary = (summary: IV08SupportedBandDuelDecisionSummary): boolean =>
    summary.actionTypes.length === 2 &&
    summary.actionTypes[0] === "move_unit" &&
    summary.actionTypes[1] === "range_attack" &&
    summary.movePath !== null &&
    summary.movePath.length > 0 &&
    summary.moveTargetCells !== null &&
    summary.moveTargetCells.length > 0 &&
    summary.rangeTargetId !== null &&
    summary.rangeAimCell !== null &&
    summary.rangeAimSide !== null;

const isShotOnlySummary = (summary: IV08SupportedBandDuelDecisionSummary): boolean =>
    summary.actionTypes.length === 1 &&
    summary.actionTypes[0] === "range_attack" &&
    summary.movePath === null &&
    summary.moveTargetCells === null &&
    summary.rangeTargetId !== null &&
    summary.rangeAimCell !== null &&
    summary.rangeAimSide !== null;

const isValidatedShotOnlySummary = (summary: IV08SupportedBandDuelDecisionSummary): boolean =>
    isShotOnlySummary(summary) &&
    summary.moveHasLavaCell === null &&
    summary.moveHasWaterCell === null &&
    isSafeGridCell(summary.rangeAimCell) &&
    Number.isSafeInteger(summary.rangeAimSide) &&
    summary.rangeAimSide! >= RangeAttackCellSide.LEFT &&
    summary.rangeAimSide! <= RangeAttackCellSide.UP;

const hasSameRangeAim = (
    strict: IV08SupportedBandDuelDecisionSummary,
    shipped: IV08SupportedBandDuelDecisionSummary,
): boolean =>
    strict.rangeTargetId === shipped.rangeTargetId &&
    strict.rangeAimSide === shipped.rangeAimSide &&
    strict.rangeAimCell !== null &&
    shipped.rangeAimCell !== null &&
    strict.rangeAimCell.x === shipped.rangeAimCell.x &&
    strict.rangeAimCell.y === shipped.rangeAimCell.y;

const summaryMovesTo = (summary: IV08SupportedBandDuelDecisionSummary, destination: XY): boolean =>
    summary.moveTargetCells?.some((cell) => cell.x === destination.x && cell.y === destination.y) ?? false;

const hasUniqueCells = (cells: readonly XY[]): boolean =>
    cells.every(
        (cell, index) => cells.findIndex((candidate) => candidate.x === cell.x && candidate.y === cell.y) === index,
    );

const isValidatedMoveShotSummary = (
    summary: IV08SupportedBandDuelDecisionSummary,
    fromCell: XY,
    toCell: XY,
): boolean => {
    if (
        !isMoveShotSummary(summary) ||
        !isSafeGridCell(fromCell) ||
        !isSafeGridCell(toCell) ||
        summary.moveHasLavaCell !== false ||
        summary.moveHasWaterCell !== false ||
        !summary.movePath?.every(isSafeGridCell) ||
        !summary.moveTargetCells?.every(isSafeGridCell) ||
        !hasUniqueCells(summary.moveTargetCells) ||
        !isSafeGridCell(summary.rangeAimCell) ||
        !Number.isSafeInteger(summary.rangeAimSide) ||
        summary.rangeAimSide! < RangeAttackCellSide.LEFT ||
        summary.rangeAimSide! > RangeAttackCellSide.UP ||
        !summaryMovesTo(summary, toCell) ||
        !sameCell(summary.movePath[summary.movePath.length - 1]!, toCell)
    ) {
        return false;
    }
    const travelledPath = sameCell(summary.movePath[0]!, fromCell) ? summary.movePath.slice(1) : summary.movePath;
    if (!travelledPath.length || travelledPath.some((cell) => sameCell(cell, fromCell))) return false;
    let prior = fromCell;
    for (const cell of travelledPath) {
        if (!adjacentCell(prior, cell)) return false;
        prior = cell;
    }
    return true;
};

/** Apply the preregistered dominance rules in order and fail closed on malformed catalog metadata. */
function compareSupportedBandDominance(
    strictProposal: Extract<IAIPolicyEvent, { kind: "v0.8_supported_band_advance" }>,
    strictSummary: IV08SupportedBandDuelDecisionSummary,
    shippedMetadata: IV08ProtectedAdvanceCatalogMetadata | undefined,
    shippedSummary: IV08SupportedBandDuelDecisionSummary,
): ISupportedBandDominanceComparison {
    const strictDivisorBefore = finitePositivePowerOfTwo(strictProposal.details.divisorBefore);
    const strictDivisorAfter = finitePositivePowerOfTwo(strictProposal.details.divisorAfter);
    const strictReachableThreatsBefore = finiteNonnegativeCount(strictProposal.details.exposureBefore);
    const strictReachableThreatsAfter = finiteNonnegativeCount(strictProposal.details.exposureAfter);
    const strictDistanceBefore = finiteNonnegativeCount(strictProposal.details.targetDistanceBefore);
    const strictDistanceAfter = finiteNonnegativeCount(strictProposal.details.targetDistanceAfter);
    const shippedDivisorBefore =
        shippedMetadata === undefined ? null : finitePositivePowerOfTwo(shippedMetadata.divisorBefore);
    const shippedDivisorAfter =
        shippedMetadata === undefined ? null : finitePositivePowerOfTwo(shippedMetadata.divisorAfter);
    const shippedReachableThreatsAfter =
        shippedMetadata === undefined ? null : finiteNonnegativeCount(shippedMetadata.reachableThreatsAfter);
    const targetIdentityValid =
        strictProposal.details.targetId.length > 0 &&
        strictProposal.details.targetCreatureName.length > 0 &&
        strictSummary.rangeTargetId === strictProposal.details.targetId &&
        shippedSummary.rangeTargetId === strictProposal.details.targetId &&
        hasSameRangeAim(strictSummary, shippedSummary) &&
        (shippedMetadata === undefined ||
            (shippedMetadata.targetId === strictProposal.details.targetId &&
                shippedMetadata.targetCreatureName === strictProposal.details.targetCreatureName));
    const strictMetadataValid =
        strictDivisorBefore !== null &&
        strictDivisorAfter === 1 &&
        strictDivisorBefore > strictDivisorAfter &&
        strictReachableThreatsBefore !== null &&
        strictReachableThreatsAfter === 0 &&
        strictDistanceBefore !== null &&
        strictDistanceAfter !== null &&
        strictDistanceAfter < strictDistanceBefore &&
        isMoveShotSummary(strictSummary);
    const shippedMetadataValid =
        shippedMetadata === undefined
            ? isShotOnlySummary(shippedSummary)
            : shippedDivisorBefore !== null &&
              shippedDivisorAfter !== null &&
              shippedDivisorBefore === strictDivisorBefore &&
              shippedDivisorAfter < shippedDivisorBefore &&
              shippedReachableThreatsAfter !== null &&
              isMoveShotSummary(shippedSummary);
    const metadataValid = strictMetadataValid && shippedMetadataValid && targetIdentityValid;
    if (!metadataValid) {
        return {
            dominant: false,
            metadataValid: false,
            reason: "filtered",
            strictDivisorAfter,
            strictReachableThreatsAfter,
            shippedDivisorAfter,
            shippedReachableThreatsAfter,
        };
    }

    let reason: V08SupportedBandDominanceReason = "filtered";
    if (shippedMetadata === undefined) {
        reason = "no_shipped_advance";
    } else if (strictDivisorAfter < shippedDivisorAfter!) {
        reason = "lower_divisor";
    } else if (
        strictDivisorAfter === shippedDivisorAfter &&
        strictReachableThreatsAfter < shippedReachableThreatsAfter!
    ) {
        reason = "lower_reachable_threats";
    }
    return {
        dominant: reason !== "filtered",
        metadataValid: true,
        reason,
        strictDivisorAfter,
        strictReachableThreatsAfter,
        shippedDivisorAfter,
        shippedReachableThreatsAfter,
    };
}

/**
 * Compare the separately sealed screened-closer candidate. Structural validity is intentionally separate from
 * qualification: ordinary shipped fallbacks and well-formed, non-qualifying advances are valid filtered controls.
 * The selector changes the executable root only when both routes are full-damage and unreachable, strict alone has
 * a native-melee target screen, shipped really closes, both signatures are retained, and strict is strictly closer.
 * The separately named decisive selector further requires four cells of strict compression or a matched active finish.
 */
export function compareV08SupportedBandScreenedCloser(
    strictDetails: IV08SupportedBandAdvanceDetails,
    strictSummary: IV08SupportedBandDuelDecisionSummary,
    shippedMetadata: IV08ProtectedAdvanceCatalogMetadata | undefined,
    shippedSummary: IV08SupportedBandDuelDecisionSummary,
    candidateReason: Exclude<V08SupportedBandScreenedCloserReason, "filtered"> = "screened_closer",
): ISupportedBandScreenedCloserComparison {
    const requiresDecisiveGate = candidateReason === "decisive_screened_closer";
    const strictDivisorBefore = finitePositivePowerOfTwo(strictDetails.divisorBefore);
    const strictDivisorAfter = finitePositivePowerOfTwo(strictDetails.divisorAfter);
    const strictReachableThreatsBefore = finiteNonnegativeCount(strictDetails.exposureBefore);
    const strictReachableThreatsAfter = finiteNonnegativeCount(strictDetails.exposureAfter);
    const strictTargetDistanceBefore = finiteNonnegativeCount(strictDetails.targetDistanceBefore);
    const strictTargetDistanceAfter = finiteNonnegativeCount(strictDetails.targetDistanceAfter);
    const strictTargetDistanceCompression = finiteCompression(strictTargetDistanceBefore, strictTargetDistanceAfter);
    const strictFinishActive = finiteBoolean(strictDetails.finishActive);
    const strictTargetScreenedAfter = finiteBoolean(strictDetails.targetScreenedAfter);
    const strictScreeningGuardId = nonemptyString(strictDetails.screeningGuardId);
    const strictRetainedSignatureAfter = finiteBoolean(strictDetails.retainedSignatureAfter);
    const shippedDivisorBefore =
        shippedMetadata === undefined ? null : finitePositivePowerOfTwo(shippedMetadata.divisorBefore);
    const shippedDivisorAfter =
        shippedMetadata === undefined ? null : finitePositivePowerOfTwo(shippedMetadata.divisorAfter);
    const shippedReachableThreatsAfter =
        shippedMetadata === undefined ? null : finiteNonnegativeCount(shippedMetadata.reachableThreatsAfter);
    const shippedTargetDistanceBefore =
        shippedMetadata === undefined ? null : finiteNonnegativeCount(shippedMetadata.targetDistanceBefore);
    const shippedTargetDistanceAfter =
        shippedMetadata === undefined ? null : finiteNonnegativeCount(shippedMetadata.targetDistanceAfter);
    const shippedTargetDistanceCompression = finiteCompression(shippedTargetDistanceBefore, shippedTargetDistanceAfter);
    const shippedFinishActive = shippedMetadata === undefined ? null : finiteBoolean(shippedMetadata.finishActive);
    const shippedTargetScreenedAfter =
        shippedMetadata === undefined ? null : finiteBoolean(shippedMetadata.targetScreenedAfter);
    const shippedScreeningGuardId =
        shippedMetadata === undefined ? null : nonemptyString(shippedMetadata.screeningGuardId);
    const shippedRetainedSignatureAfter =
        shippedMetadata === undefined ? null : finiteBoolean(shippedMetadata.retainedSignatureAfter);
    const strictScreenMetadataValid = strictTargetScreenedAfter === true && strictScreeningGuardId !== null;
    const shippedScreenMetadataStructurallyValid =
        shippedMetadata !== undefined &&
        shippedTargetScreenedAfter !== null &&
        ((shippedTargetScreenedAfter === true && shippedScreeningGuardId !== null) ||
            (shippedTargetScreenedAfter === false && shippedMetadata.screeningGuardId === null));
    const targetIdentityValid =
        nonemptyString(strictDetails.targetId) !== null &&
        nonemptyString(strictDetails.targetCreatureName) !== null &&
        strictSummary.rangeTargetId === strictDetails.targetId &&
        shippedSummary.rangeTargetId === strictDetails.targetId &&
        hasSameRangeAim(strictSummary, shippedSummary) &&
        (shippedMetadata === undefined ||
            (shippedMetadata.targetId === strictDetails.targetId &&
                shippedMetadata.targetCreatureName === strictDetails.targetCreatureName));
    const strictMetadataValid =
        strictDivisorBefore !== null &&
        strictDivisorAfter === 1 &&
        strictDivisorBefore > strictDivisorAfter &&
        strictReachableThreatsBefore !== null &&
        strictReachableThreatsAfter === 0 &&
        strictTargetDistanceBefore !== null &&
        strictTargetDistanceAfter !== null &&
        strictTargetDistanceAfter < strictTargetDistanceBefore &&
        (!requiresDecisiveGate || strictFinishActive !== null) &&
        strictScreenMetadataValid &&
        strictRetainedSignatureAfter === true &&
        isValidatedMoveShotSummary(strictSummary, strictDetails.fromCell, strictDetails.toCell);
    const shippedMetadataValid =
        shippedMetadata === undefined
            ? isValidatedShotOnlySummary(shippedSummary)
            : shippedDivisorBefore !== null &&
              shippedDivisorAfter !== null &&
              shippedDivisorBefore === strictDivisorBefore &&
              shippedDivisorAfter < shippedDivisorBefore &&
              shippedReachableThreatsAfter !== null &&
              shippedTargetDistanceBefore === strictTargetDistanceBefore &&
              shippedTargetDistanceAfter !== null &&
              shippedFinishActive !== null &&
              (!requiresDecisiveGate || shippedFinishActive === strictFinishActive) &&
              shippedScreenMetadataStructurallyValid &&
              shippedRetainedSignatureAfter !== null &&
              typeof shippedMetadata.ownRangedOutput === "number" &&
              Number.isFinite(shippedMetadata.ownRangedOutput) &&
              shippedMetadata.ownRangedOutput >= 0 &&
              typeof shippedMetadata.enemyRangedOutput === "number" &&
              Number.isFinite(shippedMetadata.enemyRangedOutput) &&
              shippedMetadata.enemyRangedOutput >= 0 &&
              isValidatedMoveShotSummary(shippedSummary, shippedMetadata.fromCell, shippedMetadata.toCell) &&
              sameCell(shippedMetadata.fromCell, strictDetails.fromCell);
    const metadataValid = strictMetadataValid && shippedMetadataValid && targetIdentityValid;
    const routeDominant =
        metadataValid &&
        shippedMetadata !== undefined &&
        strictDivisorAfter === 1 &&
        shippedDivisorAfter === 1 &&
        strictReachableThreatsAfter === 0 &&
        shippedReachableThreatsAfter === 0 &&
        strictTargetScreenedAfter === true &&
        shippedTargetScreenedAfter === false &&
        strictRetainedSignatureAfter === true &&
        shippedRetainedSignatureAfter === true &&
        shippedTargetDistanceBefore !== null &&
        shippedTargetDistanceAfter !== null &&
        shippedTargetDistanceAfter < shippedTargetDistanceBefore &&
        strictTargetDistanceAfter! < shippedTargetDistanceAfter! &&
        !sameCellFootprint(strictSummary.moveTargetCells, shippedSummary.moveTargetCells) &&
        !sameSupportedBandDuelDecision(strictSummary, shippedSummary);
    const dominant =
        routeDominant &&
        (!requiresDecisiveGate ||
            strictFinishActive === true ||
            (strictTargetDistanceCompression !== null && strictTargetDistanceCompression >= 4));
    return {
        dominant,
        metadataValid,
        reason: dominant ? candidateReason : "filtered",
        strictFromCell: { ...strictDetails.fromCell },
        strictToCell: { ...strictDetails.toCell },
        shippedFromCell: shippedMetadata === undefined ? null : { ...shippedMetadata.fromCell },
        shippedToCell: shippedMetadata === undefined ? null : { ...shippedMetadata.toCell },
        strictDivisorBefore,
        strictDivisorAfter,
        strictReachableThreatsBefore,
        strictReachableThreatsAfter,
        strictTargetDistanceBefore,
        strictTargetDistanceAfter,
        strictTargetDistanceCompression,
        strictFinishActive,
        strictTargetScreenedAfter,
        strictScreeningGuardId,
        strictRetainedSignatureAfter,
        shippedDivisorBefore,
        shippedDivisorAfter,
        shippedReachableThreatsAfter,
        shippedTargetDistanceBefore,
        shippedTargetDistanceAfter,
        shippedTargetDistanceCompression,
        shippedFinishActive,
        shippedTargetScreenedAfter,
        shippedScreeningGuardId,
        shippedRetainedSignatureAfter,
    };
}

function protectedAdvanceGuardrailsMode(
    context: IDecisionContext,
    strategyVersion: string,
): V08ProtectedAdvanceGuardrailMode | undefined {
    if (
        process.env[PROTECTED_ADVANCE_GUARDRAILS_ENABLED_ENV] !== "1" ||
        process.env[PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY_ENV] !== "1" ||
        context.decisionOrigin !== "root"
    ) {
        return undefined;
    }
    const versionSelected = (process.env[PROTECTED_ADVANCE_GUARDRAILS_VERSIONS_ENV] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .includes(strategyVersion);
    if (!versionSelected) return undefined;
    const mode = process.env[PROTECTED_ADVANCE_GUARDRAILS_MODE_ENV] ?? "both";
    return mode === "both" || mode === "catalog_only" || mode === "partial_band" || mode === "ranged_superior_hold"
        ? mode
        : undefined;
}

/**
 * Live-root post-catalog guardrails for the shipped protected advance. The incumbent catalog is built exactly
 * once before version selection, preserving its incoming and outgoing seeded path stream. A pre-finish shooter
 * holds before the five-lap finishing runway when its ranged army is stronger (including against zero enemy
 * ranged output), and a pre-finish close must reach full damage. The ranged-superiority veto always releases at
 * the dominant-finish start lap, even without a two-to-one material lead; active dominant/urgent finish pressure
 * releases both vetoes. Every other proposal, including a zero-reach full-damage close without a native melee
 * screen, remains the exact incumbent decision.
 */
function protectedAdvanceShotWithGuardrails(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    responseNeutralAdvance: boolean,
    mode: V08ProtectedAdvanceGuardrailMode,
): GameAction[] {
    const legacyEvents: IAIPolicyEvent[] = [];
    const catalog = protectedAdvanceShotCatalog(
        unit,
        { ...context, policyEventObserver: (event) => legacyEvents.push(event) },
        decision,
        responseNeutralAdvance,
    );
    const metadata = catalog.metadata;
    // A deterministic factorial control: enter the same live-root wrapper and consume the same catalog/RNG,
    // but publish no veto proposal and return the incumbent catalog decision untouched.
    if (mode === "catalog_only") {
        for (const event of legacyEvents) context.policyEventObserver?.(event);
        return catalog.decision;
    }
    let reason: V08ProtectedAdvanceGuardrailReason | undefined;
    if (metadata && !metadata.finishActive) {
        const rangedSuperiorHold = metadata.ownRangedOutput > metadata.enemyRangedOutput;
        const beforeFinishingRunway = (context.fightProperties?.getCurrentLap() ?? 0) < V08_DOMINANT_FINISH_START_LAP;
        const partialBand = !Number.isFinite(metadata.divisorAfter) || metadata.divisorAfter !== 1;
        if ((mode === "both" || mode === "ranged_superior_hold") && rangedSuperiorHold && beforeFinishingRunway) {
            reason = "ranged_superior_hold";
        } else if ((mode === "both" || mode === "partial_band") && partialBand) {
            reason = "partial_band";
        }
    }
    if (!reason || !metadata) {
        for (const event of legacyEvents) context.policyEventObserver?.(event);
        return catalog.decision;
    }

    context.policyEventObserver?.({
        kind: "v0.8_protected_advance_guardrail",
        unitId: unit.getId(),
        creatureName: unit.getName(),
        team: unit.getTeam(),
        lap: context.fightProperties?.getCurrentLap() ?? 0,
        details: {
            reason,
            ...metadata,
            rangedSuperior: metadata.ownRangedOutput > metadata.enemyRangedOutput,
        },
    });
    return decision;
}

/**
 * Research-only direct duel between the strict full-damage close and the shipped protected advance. At a measured
 * root every participating version builds both catalogs, shipped legacy first and strict second, before its version
 * chooses a result. Legacy therefore receives the incumbent's incoming RNG state; both seats then share the same
 * total catalog consumption even when their chosen actions differ. The strict-replacement arm always selects strict
 * for its configured version. The original overlay treatment selects any real strict proposal. The separate
 * dominance overlay selects one only when its divisor/exposure metadata objectively improves shipped; equal-quality
 * alternate paths preserve shipped. Each matched selector-off control still computes both catalogs but always
 * selects legacy. Branch events are buffered and only the selected policy's events are published, while neutral
 * comparison funnel stages expose eligible/dominant/filtered counts in both matched arms. The independently
 * sealed screened-closer overlay changes a root only for a strict native-screened route that is objectively closer
 * than an unscreened shipped route at equal full damage and zero reach.
 */
function supportedBandAdvanceVsLegacy(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
    strategyVersion: string,
    responseNeutralAdvance: boolean,
): GameAction[] {
    const strictVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const legacyVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const overlayVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_OVERLAY_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const overlayControlVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_OVERLAY_CONTROL_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const dominanceOverlayVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const dominanceOverlayControlVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_DOMINANCE_OVERLAY_CONTROL_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const screenedCloserOverlayVersions = new Set(
        (process.env[SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const screenedCloserOverlayControlVersions = new Set(
        (process.env[SUPPORTED_BAND_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const decisiveScreenedCloserOverlayVersions = new Set(
        (process.env[SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const decisiveScreenedCloserOverlayControlVersions = new Set(
        (process.env[SUPPORTED_BAND_DECISIVE_SCREENED_CLOSER_OVERLAY_CONTROL_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const selectsStrict = strictVersions.has(strategyVersion);
    const selectsLegacy = legacyVersions.has(strategyVersion);
    if (!selectsStrict && !selectsLegacy) return decision;

    const strictEvents: IAIPolicyEvent[] = [];
    const legacyEvents: IAIPolicyEvent[] = [];
    const legacyCatalog = protectedAdvanceShotCatalog(
        unit,
        { ...context, policyEventObserver: (event) => legacyEvents.push(event) },
        decision,
        responseNeutralAdvance,
    );
    const legacyDecision = legacyCatalog.decision;
    const strictDecision = supportedBandAdvance(
        unit,
        { ...context, policyEventObserver: (event) => strictEvents.push(event) },
        decision,
        strategyVersion,
    );
    const strictProposal = strictEvents.find(
        (event): event is Extract<IAIPolicyEvent, { kind: "v0.8_supported_band_advance" }> =>
            event.kind === "v0.8_supported_band_advance",
    );
    const selectsStrictOverlay = selectsStrict && overlayVersions.has(strategyVersion);
    const selectsOverlayControl = selectsStrictOverlay && overlayControlVersions.has(strategyVersion);
    const selectsDominanceOverlay = selectsStrict && dominanceOverlayVersions.has(strategyVersion);
    const selectsDominanceOverlayControl =
        selectsDominanceOverlay && dominanceOverlayControlVersions.has(strategyVersion);
    const selectsOriginalScreenedCloserOverlay = selectsStrict && screenedCloserOverlayVersions.has(strategyVersion);
    const selectsDecisiveScreenedCloserOverlay =
        selectsStrict && decisiveScreenedCloserOverlayVersions.has(strategyVersion);
    const screenedCloserSelectorConflict = selectsOriginalScreenedCloserOverlay && selectsDecisiveScreenedCloserOverlay;
    const screenedCloserCandidateReason: Exclude<V08SupportedBandScreenedCloserReason, "filtered"> | undefined =
        screenedCloserSelectorConflict
            ? undefined
            : selectsDecisiveScreenedCloserOverlay
              ? "decisive_screened_closer"
              : selectsOriginalScreenedCloserOverlay
                ? "screened_closer"
                : undefined;
    const selectsScreenedCloserOverlay = selectsOriginalScreenedCloserOverlay || selectsDecisiveScreenedCloserOverlay;
    const selectsScreenedCloserOverlayControl =
        selectsScreenedCloserOverlay &&
        (screenedCloserSelectorConflict ||
            (selectsOriginalScreenedCloserOverlay && screenedCloserOverlayControlVersions.has(strategyVersion)) ||
            (selectsDecisiveScreenedCloserOverlay &&
                decisiveScreenedCloserOverlayControlVersions.has(strategyVersion)));
    const strictSummary = supportedBandDuelDecisionSummary(strictDecision);
    const shippedSummary = supportedBandDuelDecisionSummary(legacyDecision);
    const dominanceComparison =
        selectsDominanceOverlay && strictProposal
            ? compareSupportedBandDominance(strictProposal, strictSummary, legacyCatalog.metadata, shippedSummary)
            : undefined;
    const screenedCloserComparison =
        screenedCloserCandidateReason && strictProposal
            ? compareV08SupportedBandScreenedCloser(
                  strictProposal.details,
                  strictSummary,
                  legacyCatalog.metadata,
                  shippedSummary,
                  screenedCloserCandidateReason,
              )
            : undefined;
    const strictDominatesShipped = dominanceComparison?.dominant ?? false;
    const strictIsScreenedCloser = screenedCloserComparison?.dominant ?? false;
    const choosesStrict =
        selectsStrict &&
        (selectsScreenedCloserOverlay
            ? !selectsScreenedCloserOverlayControl && strictIsScreenedCloser
            : selectsDominanceOverlay
              ? !selectsDominanceOverlayControl && strictDominatesShipped
              : !selectsStrictOverlay || (!selectsOverlayControl && strictProposal !== undefined));
    const selectedDecision = choosesStrict ? strictDecision : legacyDecision;
    const selectedEvents = choosesStrict ? strictEvents : legacyEvents;
    for (const event of selectedEvents) context.policyEventObserver?.(event);
    if (strictProposal && dominanceComparison) {
        const dominanceDetails: IV08SupportedBandDominanceComparisonDetails = {
            selected: choosesStrict,
            dominant: dominanceComparison.dominant,
            metadataValid: dominanceComparison.metadataValid,
            reason: dominanceComparison.reason,
            targetId: strictProposal.details.targetId,
            targetCreatureName: strictProposal.details.targetCreatureName,
            strict: strictSummary,
            shipped: shippedSummary,
            strictDivisorAfter: dominanceComparison.strictDivisorAfter,
            strictReachableThreatsAfter: dominanceComparison.strictReachableThreatsAfter,
            shippedDivisorAfter: dominanceComparison.shippedDivisorAfter,
            shippedReachableThreatsAfter: dominanceComparison.shippedReachableThreatsAfter,
        };
        context.policyEventObserver?.({
            kind: "v0.8_supported_band_dominance_comparison",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
            details: dominanceDetails,
        });
        for (const stage of [
            "dominance_eligible",
            strictDominatesShipped ? "dominance_dominant" : "dominance_filtered",
        ] as const) {
            context.policyEventObserver?.({
                kind: "v0.8_supported_band_advance_funnel",
                unitId: unit.getId(),
                creatureName: unit.getName(),
                team: unit.getTeam(),
                lap: context.fightProperties?.getCurrentLap() ?? 0,
                stage,
            });
        }
    }
    if (strictProposal && screenedCloserComparison) {
        const screenedCloserDetails: IV08SupportedBandScreenedCloserComparisonDetails = {
            selected: choosesStrict,
            dominant: screenedCloserComparison.dominant,
            metadataValid: screenedCloserComparison.metadataValid,
            reason: screenedCloserComparison.reason,
            targetId: strictProposal.details.targetId,
            targetCreatureName: strictProposal.details.targetCreatureName,
            strict: strictSummary,
            shipped: shippedSummary,
            strictFromCell: { ...screenedCloserComparison.strictFromCell },
            strictToCell: { ...screenedCloserComparison.strictToCell },
            shippedFromCell:
                screenedCloserComparison.shippedFromCell === null
                    ? null
                    : { ...screenedCloserComparison.shippedFromCell },
            shippedToCell:
                screenedCloserComparison.shippedToCell === null ? null : { ...screenedCloserComparison.shippedToCell },
            strictDivisorBefore: screenedCloserComparison.strictDivisorBefore,
            strictDivisorAfter: screenedCloserComparison.strictDivisorAfter,
            strictReachableThreatsBefore: screenedCloserComparison.strictReachableThreatsBefore,
            strictReachableThreatsAfter: screenedCloserComparison.strictReachableThreatsAfter,
            strictTargetDistanceBefore: screenedCloserComparison.strictTargetDistanceBefore,
            strictTargetDistanceAfter: screenedCloserComparison.strictTargetDistanceAfter,
            strictTargetDistanceCompression: screenedCloserComparison.strictTargetDistanceCompression,
            strictFinishActive: screenedCloserComparison.strictFinishActive,
            strictTargetScreenedAfter: screenedCloserComparison.strictTargetScreenedAfter,
            strictScreeningGuardId: screenedCloserComparison.strictScreeningGuardId,
            strictRetainedSignatureAfter: screenedCloserComparison.strictRetainedSignatureAfter,
            shippedDivisorBefore: screenedCloserComparison.shippedDivisorBefore,
            shippedDivisorAfter: screenedCloserComparison.shippedDivisorAfter,
            shippedReachableThreatsAfter: screenedCloserComparison.shippedReachableThreatsAfter,
            shippedTargetDistanceBefore: screenedCloserComparison.shippedTargetDistanceBefore,
            shippedTargetDistanceAfter: screenedCloserComparison.shippedTargetDistanceAfter,
            shippedTargetDistanceCompression: screenedCloserComparison.shippedTargetDistanceCompression,
            shippedFinishActive: screenedCloserComparison.shippedFinishActive,
            shippedTargetScreenedAfter: screenedCloserComparison.shippedTargetScreenedAfter,
            shippedScreeningGuardId: screenedCloserComparison.shippedScreeningGuardId,
            shippedRetainedSignatureAfter: screenedCloserComparison.shippedRetainedSignatureAfter,
        };
        context.policyEventObserver?.({
            kind: "v0.8_supported_band_screened_closer_comparison",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
            details: screenedCloserDetails,
        });
        for (const stage of [
            "screened_closer_eligible",
            strictIsScreenedCloser ? "screened_closer_dominant" : "screened_closer_filtered",
        ] as const) {
            context.policyEventObserver?.({
                kind: "v0.8_supported_band_advance_funnel",
                unitId: unit.getId(),
                creatureName: unit.getName(),
                team: unit.getTeam(),
                lap: context.fightProperties?.getCurrentLap() ?? 0,
                stage,
            });
        }
    }
    if (selectsStrict && context.policyEventObserver) {
        const selectedSummary = supportedBandDuelDecisionSummary(selectedDecision);
        if (!sameSupportedBandDuelDecision(selectedSummary, shippedSummary)) {
            context.policyEventObserver({
                kind: "v0.8_supported_band_duel_difference",
                unitId: unit.getId(),
                creatureName: unit.getName(),
                team: unit.getTeam(),
                lap: context.fightProperties?.getCurrentLap() ?? 0,
                details: {
                    difference: supportedBandDuelDifference(selectedSummary, shippedSummary),
                    strict: selectedSummary,
                    shipped: shippedSummary,
                },
            });
        }
    }
    return selectedDecision;
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
    strategyVersion: string,
): GameAction[] {
    const selectorVersions = (process.env[SUPPORTED_RANGED_DELTA_VERSIONS_ENV] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const funnelVersions = (process.env[SUPPORTED_RANGED_DELTA_FUNNEL_VERSIONS_ENV] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const liveOnly = process.env[SUPPORTED_RANGED_DELTA_LIVE_ONLY_ENV] === "1";
    const selectorEnabled =
        selectorVersions.includes(strategyVersion) && (!liveOnly || context.decisionOrigin === "root");
    // Both the treatment and selector-off control build the same partial-screen catalog. Selection happens only
    // after the complete legacy/treatment catalogs exist, so PathHelper consumes the same seeded stream.
    const catalogEnabled = selectorVersions.length > 0 || funnelVersions.length > 0;
    const funnelEnabled = context.decisionOrigin === "root" && funnelVersions.includes(strategyVersion);
    const melee = decision.find((action) => action.type === "melee_attack");
    const emitFunnel = (stage: V08SupportedRangedEscapeFunnelStage): void => {
        if (!funnelEnabled || melee?.type !== "melee_attack") return;
        context.policyEventObserver?.({
            kind: "v0.8_supported_ranged_escape_funnel",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
            stage,
        });
    };
    if (melee?.type === "melee_attack") emitFunnel("melee_incumbent");

    const attackHandler = context.attackHandler;
    if (!attackHandler) return decision;
    emitFunnel("attack_context");
    if (unit.getAttackType() !== RANGE) return decision;
    emitFunnel("current_ranged_mode");
    if (unit.getRangeShots() <= 0) return decision;
    emitFunnel("ammo");
    if (!unit.canMove()) return decision;
    emitFunnel("mobile");
    if (unit.hasAbilityActive("Handyman")) return decision;
    emitFunnel("ordinary_shooter");
    if (unit.hasDebuffActive("Range Null Field Aura") || unit.hasDebuffActive("Rangebane")) return decision;
    emitFunnel("range_unsuppressed");
    if (
        !attackHandler.canBeAttackedByMelee(
            unit.getPosition(),
            unit.isSmallSize(),
            context.grid.getEnemyAggrMatrixByUnitId(unit.getId()),
        )
    ) {
        return decision;
    }
    emitFunnel("currently_pinned");
    if (decision.some((action) => TURN_CONSUMING_NON_MELEE.has(action.type))) return decision;
    emitFunnel("no_nonmelee_commitment");

    let weakMeleeTarget: Unit | undefined;
    let weakMeleeEstimate: NonNullable<ReturnType<typeof estimatePrimaryMeleeDamage>> | undefined;
    let incumbentAttackFromCell: XY | undefined;
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
        emitFunnel("finish_override_clear");
        // With no later pre-wave activation left, retain real damage rather than manufacture Armageddon delay.
        if (currentLap >= NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1) {
            return decision;
        }
        emitFunnel("armageddon_buffer_clear");
        const target = context.unitsHolder.getAllUnits().get(melee.targetId);
        if (!target) {
            return decision;
        }
        emitFunnel("target_found");
        incumbentAttackFromCell = melee.attackFrom ?? unit.getBaseCell();
        const estimate = estimatePrimaryMeleeDamage(unit, target, context, incumbentAttackFromCell, decision);
        // Unsupported sequences fail closed; a truly secure stack kill is the one ranged melee worth preserving.
        if (!estimate) return decision;
        emitFunnel("damage_supported");
        if (estimate.secureKill) return decision;
        emitFunnel("nonsecure_melee");
        weakMeleeTarget = target;
        weakMeleeEstimate = estimate;
    }

    const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((enemy) => !enemy.isDead());
    if (!enemies.length) {
        return decision;
    }
    emitFunnel("live_enemies");
    const frontliners = context.unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((ally) => !ally.isDead() && ally.getId() !== unit.getId() && isFrontline(ally));
    if (frontliners.length) emitFunnel("frontline_present");
    const noMelee = unit.hasAbilityActive("No Melee");
    const currentProtection = protectionAt(unit.getCells(), enemies, frontliners);
    const currentUnscreened = currentProtection.reachableThreats - currentProtection.screenedThreats;
    let legacyBest: IRouteView | undefined;
    let treatmentBest: IRouteView | undefined;
    let treatmentBestUsesSupportedDelta = false;
    let hasValidRoute = false;
    let hasLegacyRetreatRoute = false;
    let hasTargetScreenRoute = false;
    let hasUnscreenedReducedRoute = false;
    let hasExposureNonincreasingRoute = false;
    let hasPartialDeltaRoute = false;
    const routes = reachableRoutes(unit, context);
    if (routes.length) emitFunnel("reachable_route");
    for (const route of routes) {
        const view = routeView(unit, context, route, enemies, frontliners);
        if (!view) {
            continue;
        }
        hasValidRoute = true;
        const candidateUnscreened = view.protection.reachableThreats - view.protection.screenedThreats;
        const legacyEligible = noMelee || view.protection.eligible;
        if (legacyEligible) {
            hasLegacyRetreatRoute = true;
            if (!legacyBest || preferRetreat(view, legacyBest)) legacyBest = view;
        }
        // With the experiment unset, stop at the exact shipped catalog and comparator pass.
        if (!catalogEnabled) continue;
        const nonLegacyPartialRoute =
            catalogEnabled && !noMelee && weakMeleeTarget !== undefined && !view.protection.eligible;
        const targetScreened =
            nonLegacyPartialRoute &&
            frontliners.some((ally) => allyScreensThreat(view.footprint, ally, weakMeleeTarget!));
        if (targetScreened) hasTargetScreenRoute = true;
        const unscreenedReduced = targetScreened && candidateUnscreened < currentUnscreened;
        if (unscreenedReduced) hasUnscreenedReducedRoute = true;
        const exposureNonincreasing =
            unscreenedReduced && view.protection.reachableThreats <= currentProtection.reachableThreats;
        if (exposureNonincreasing) hasExposureNonincreasingRoute = true;
        const partialScreenImprovement =
            catalogEnabled &&
            !noMelee &&
            weakMeleeTarget !== undefined &&
            frontliners.some((ally) => allyScreensThreat(view.footprint, ally, weakMeleeTarget!)) &&
            candidateUnscreened < currentUnscreened &&
            view.protection.reachableThreats <= currentProtection.reachableThreats;
        if (!view.protection.eligible && partialScreenImprovement) hasPartialDeltaRoute = true;
        if (!legacyEligible && !partialScreenImprovement) {
            continue;
        }
        if (!treatmentBest || preferRetreat(view, treatmentBest)) {
            treatmentBest = view;
            treatmentBestUsesSupportedDelta = !view.protection.eligible && partialScreenImprovement;
        }
    }
    if (hasValidRoute) emitFunnel("valid_route");
    if (hasLegacyRetreatRoute) emitFunnel("legacy_retreat_route");
    if (hasTargetScreenRoute) emitFunnel("target_screen_route");
    if (hasUnscreenedReducedRoute) emitFunnel("unscreened_reduced_route");
    if (hasExposureNonincreasingRoute) emitFunnel("exposure_nonincreasing_route");
    if (hasPartialDeltaRoute) emitFunnel("partial_delta_route");
    if (treatmentBestUsesSupportedDelta) emitFunnel("delta_only_best");

    const best = selectorEnabled ? treatmentBest : legacyBest;
    if (!best) {
        return decision;
    }
    if (
        selectorEnabled &&
        treatmentBestUsesSupportedDelta &&
        weakMeleeTarget &&
        weakMeleeEstimate &&
        incumbentAttackFromCell
    ) {
        const screeningFrontliner = [...frontliners]
            .filter((ally) => allyScreensThreat(best.footprint, ally, weakMeleeTarget))
            .sort((left, right) => (left.getId() < right.getId() ? -1 : left.getId() > right.getId() ? 1 : 0))[0];
        const currentMinEnemyDistance = Math.min(
            ...enemies.map((enemy) => cellDistance(unit.getCells(), enemy.getCells())),
        );
        context.policyEventObserver?.({
            kind: "v0.8_supported_ranged_escape",
            unitId: unit.getId(),
            creatureName: unit.getName(),
            team: unit.getTeam(),
            lap: context.fightProperties?.getCurrentLap() ?? 0,
            details: {
                fromCell: { ...unit.getBaseCell() },
                toCell: { ...best.route.cell },
                incumbentAttackFromCell: { ...incumbentAttackFromCell },
                targetId: weakMeleeTarget.getId(),
                targetCreatureName: weakMeleeTarget.getName(),
                targetHp: weakMeleeTarget.getCumulativeHp(),
                meleeHitChance: weakMeleeEstimate.hitChance,
                expectedEffectiveMeleeDamage: weakMeleeEstimate.expectedEffectiveDamage,
                reachableThreatsBefore: currentProtection.reachableThreats,
                screenedThreatsBefore: currentProtection.screenedThreats,
                unscreenedThreatsBefore: currentUnscreened,
                reachableThreatsAfter: best.protection.reachableThreats,
                screenedThreatsAfter: best.protection.screenedThreats,
                unscreenedThreatsAfter: best.protection.reachableThreats - best.protection.screenedThreats,
                targetDistanceBefore: cellDistance(unit.getCells(), weakMeleeTarget.getCells()),
                targetDistanceAfter: cellDistance(best.footprint, weakMeleeTarget.getCells()),
                minEnemyDistanceBefore: currentMinEnemyDistance,
                minEnemyDistanceAfter: best.minEnemyDistance,
                nearestFrontlineDistanceAfter: best.nearestFrontlineDistance,
                screeningFrontlinerId: screeningFrontliner?.getId() ?? "",
                screeningFrontlinerCreatureName: screeningFrontliner?.getName() ?? "",
                routeCost: routeCost(best.route),
            },
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
    const responseNeutralAdvanceVersions = (process.env.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    const responseNeutralAdvance = responseNeutralAdvanceVersions.includes(strategyVersion);
    const mode = process.env.V08_RANGED_POSITION_MODE ?? "both";
    // A live-only treatment replaces (rather than follows) the legacy advance at explicit roots. The direct and
    // overlay duels compute shipped and strict catalogs in the same order for both seats before choosing by arm.
    // Rollouts and omitted-origin callers retain the incumbent policy.
    const bandAdvanceActiveHere = mode === "both" && supportedBandAdvanceActiveHere(context);
    const bandAdvanceLegacyControlVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_LEGACY_CONTROL_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const bandAdvanceSelectorVersions = new Set(
        (process.env[SUPPORTED_BAND_ADVANCE_VERSIONS_ENV] ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
    );
    const bandAdvanceVsLegacy =
        mode === "both" &&
        context.decisionOrigin === "root" &&
        process.env[SUPPORTED_BAND_ADVANCE_LIVE_ONLY_ENV] === "1" &&
        bandAdvanceLegacyControlVersions.size > 0 &&
        (bandAdvanceSelectorVersions.has(strategyVersion) || bandAdvanceLegacyControlVersions.has(strategyVersion));
    const protectedAdvanceGuardrailMode = protectedAdvanceGuardrailsMode(context, strategyVersion);
    const advanced = bandAdvanceVsLegacy
        ? supportedBandAdvanceVsLegacy(unit, context, decision, strategyVersion, responseNeutralAdvance)
        : !bandAdvanceActiveHere && (mode === "both" || mode === "advance")
          ? protectedAdvanceGuardrailMode
              ? protectedAdvanceShotWithGuardrails(
                    unit,
                    context,
                    decision,
                    responseNeutralAdvance,
                    protectedAdvanceGuardrailMode,
                )
              : protectedAdvanceShot(unit, context, decision, responseNeutralAdvance)
          : decision;
    const retreated =
        mode === "both" || mode === "retreat" ? pinnedRetreat(unit, context, advanced, strategyVersion) : advanced;
    const bandAdvanced =
        bandAdvanceActiveHere && !bandAdvanceVsLegacy
            ? supportedBandAdvance(unit, context, retreated, strategyVersion)
            : retreated;
    return supportedPrepinEgress(unit, context, bandAdvanced, strategyVersion);
}
