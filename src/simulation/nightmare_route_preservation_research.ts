/** Distinct offline follow-up. The original ground-wall checkpoint remains immutable. */
import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import { projectPostMoveActorAvailability } from "../engine/post_move_actor_availability";
import { FightStateManager } from "../fights/fight_state_manager";
import { getSweptFootprintCells, isCellWithinGrid } from "../grid/grid_math";
import { PathHelper } from "../grid/path_helper";
import { fireWallBurnPercentage, fireWallLitCells, FireWalls } from "../spells/fire_walls";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { hasBacklineApproachTargetOutput } from "./backline_approach_move_research";
import { proposeNightmareGroundWall } from "./nightmare_ground_wall_research";

export const NIGHTMARE_ROUTE_PRESERVATION_ID = "nightmare-route-preserving-wall-v1";
export const NIGHTMARE_WALL_PRODUCTIVE_MARGIN = 0.01;
const MAX_ROUTE_UNITS = 20;
const EPSILON = 1e-9;
type Proposal = NonNullable<ReturnType<typeof proposeNightmareGroundWall>>;

export interface INightmareWallRouteAudit {
    unitId: string;
    team: number;
    flyer: boolean;
    startDistance: number;
    baselineDistance: number;
    safeDistance: number;
    nativeRoutes: number;
    pricedRoutes: number;
    baselineAdvances: boolean;
    bestApproachPreserved: boolean;
}

const visible = (unit: Unit): boolean =>
    !unit.isDead() && !unit.hasBuffActive("Hidden") && !unit.hasAbilityActive("Hidden");
const distance = (body: readonly XY[], targets: readonly XY[]): number => {
    let best = Infinity;
    for (const a of body)
        for (const b of targets) best = Math.min(best, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
    return best;
};

/**
 * Price a proposed wall on the native CURRENT one-turn route bank, including rectangular sweeps,
 * existing fire, flying landings, shields and resistance. No hypothetical path search or live mutation.
 * The bank can omit detours a new search would find; this is a conservative route-coverage proxy,
 * not proof of future contact denial or an opponent's chosen action.
 */
export function auditNightmareWallRoute(
    mover: Unit,
    context: IDecisionContext,
    currentWalls: FireWalls,
    proposedWalls: FireWalls,
    targetCells: readonly XY[],
): INightmareWallRouteAudit {
    const startDistance = distance(mover.getCells(), targetCells);
    const audit: INightmareWallRouteAudit = {
        unitId: mover.getId(),
        team: mover.getTeam(),
        flyer: mover.canFly(),
        startDistance,
        baselineDistance: startDistance,
        safeDistance: startDistance,
        nativeRoutes: 0,
        pricedRoutes: 0,
        baselineAdvances: false,
        bestApproachPreserved: true,
    };
    if (!mover.canMove() || !Number.isFinite(startDistance)) return audit;
    const width = mover.getFootprintWidth();
    const height = mover.getFootprintHeight();
    const steps = mover.getSteps();
    const paths = new PathHelper(context.grid.getSettings()).getMovePath(
        mover.getBaseCell(),
        context.matrix,
        steps,
        context.grid.getAggrMatrixByTeam(mover.getTeam() === 2 ? 1 : 2),
        mover.canFly(),
        mover.isSmallSize(),
        mover.canTraverseLava(),
        mover.hasAbilityActive("In Its Own World"),
        width,
        height,
    );
    for (const routes of paths.knownPaths.values()) {
        for (const route of routes) {
            audit.nativeRoutes++;
            const cells = mover.getFootprintCellsForAnchor(route.cell);
            const remaining = distance(cells, targetCells);
            if (remaining >= startDistance || route.weight > steps + EPSILON) continue;
            const move: Extract<GameAction, { type: "move_unit" }> = {
                type: "move_unit",
                unitId: mover.getId(),
                path: route.route,
                targetCells: cells,
                hasLavaCell: route.hasLavaCell,
                hasWaterCell: route.hasWaterCell,
            };
            const before = projectPostMoveActorAvailability(mover, currentWalls, move);
            if (!before.availableAfterMove) continue;
            audit.baselineDistance = Math.min(audit.baselineDistance, remaining);
            audit.pricedRoutes++;
            let additionalSteps = 0;
            if (!mover.canFly()) {
                for (let i = 1; i < route.route.length; i++) {
                    for (const cell of getSweptFootprintCells(route.route[i - 1], route.route[i], width, height)) {
                        if (proposedWalls.has(cell) && !currentWalls.has(cell)) additionalSteps++;
                    }
                }
            }
            if (route.weight + additionalSteps > steps + EPSILON) continue;
            const after = projectPostMoveActorAvailability(mover, proposedWalls, move);
            if (after.availableAfterMove && after.totalAppliedDamage <= before.totalAppliedDamage) {
                audit.safeDistance = Math.min(audit.safeDistance, remaining);
            }
        }
    }
    audit.baselineAdvances = audit.baselineDistance < startDistance;
    audit.bestApproachPreserved = audit.safeDistance <= audit.baselineDistance + EPSILON;
    return audit;
}

export interface INightmareRouteWallAssessment {
    reason:
        | "unavailable"
        | "direct_attack"
        | "context"
        | "route_budget"
        | "friendly_route"
        | "no_enemy_pressure"
        | "proposed";
    original?: Proposal;
    proposal?: Proposal;
    routes: INightmareWallRouteAudit[];
}

/** Restrict the old proposal without changing its cells, features or any native alternative. */
export function assessNightmareRouteWall(
    unit: Unit,
    context: IDecisionContext,
    catalog: readonly IEnumeratedCandidate[],
): INightmareRouteWallAssessment {
    const original = proposeNightmareGroundWall(unit, context, catalog);
    const result: INightmareRouteWallAssessment = { reason: "unavailable", original, routes: [] };
    if (!original) return result;
    if (
        catalog.some(
            (candidate) =>
                candidate.features.expectedDamage > 0 &&
                candidate.actions.some((a) => ["melee_attack", "range_attack", "area_throw_attack"].includes(a.type)),
        )
    )
        return { ...result, reason: "direct_attack" };
    if (!context.fightProperties || FightStateManager.getInstance().getFightProperties() !== context.fightProperties)
        return { ...result, reason: "context" };
    const units = [...context.unitsHolder.getAllUnits().values()].filter((u) =>
        u.getTeam() === unit.getTeam() ? !u.isDead() : visible(u),
    );
    const eligible = units.filter(
        (u) =>
            (u.getTeam() === unit.getTeam() && !hasBacklineApproachTargetOutput(u)) ||
            original.groundEnemyIds.includes(u.getId()),
    );
    if (eligible.length > MAX_ROUTE_UNITS) return { ...result, reason: "route_budget" };
    const currentWalls = context.fightProperties.getFireWalls();
    const proposedWalls = FireWalls.fromJSON(currentWalls.toJSON());
    const action = original.candidate.actions[0];
    if (action.type !== "cast_spell" || !action.targetCell) return result;
    proposedWalls.addAll(
        fireWallLitCells(
            context.grid,
            (c) => isCellWithinGrid(context.grid.getSettings(), c),
            action.targetCell,
            action.targetOrientation ?? 0,
        ),
        3,
        fireWallBurnPercentage(unit.getMagicDamageBonusPercentage()),
    );
    for (const mover of eligible) {
        const targets = units.filter((u) => u.getTeam() !== mover.getTeam()).flatMap((u) => u.getCells());
        result.routes.push(auditNightmareWallRoute(mover, context, currentWalls, proposedWalls, targets));
    }
    if (result.routes.some((r) => r.team === unit.getTeam() && !r.bestApproachPreserved))
        return { ...result, reason: "friendly_route" };
    if (!result.routes.some((r) => r.team !== unit.getTeam() && r.baselineAdvances && !r.bestApproachPreserved))
        return { ...result, reason: "no_enemy_pressure" };
    return { ...result, reason: "proposed", proposal: original };
}

/** A selection mask, never a replacement forecast: require full R2 and a lead over attack/buff choices. */
export function nightmareWallOpportunityAllowed(
    candidates: readonly IEnumeratedCandidate[],
    means: readonly number[],
    completed: readonly number[],
    wallIndex: number,
): boolean {
    if (
        wallIndex < 0 ||
        wallIndex >= candidates.length ||
        means.length !== candidates.length ||
        completed.length !== candidates.length
    )
        return false;
    if (completed[wallIndex] !== 2 || !Number.isFinite(means[wallIndex])) return false;
    let best = -Infinity;
    let bestComplete = false;
    for (let i = 0; i < candidates.length; i++) {
        if (i === wallIndex || !Number.isFinite(means[i])) continue;
        const productive = candidates[i].actions.some(
            (a) =>
                ["melee_attack", "range_attack", "area_throw_attack"].includes(a.type) ||
                (a.type === "cast_spell" && a.spellName !== "Fire Wall"),
        );
        if (!productive || means[i] < best) continue;
        if (means[i] > best) {
            best = means[i];
            bestComplete = completed[i] === 2;
        } else bestComplete ||= completed[i] === 2;
    }
    return best === -Infinity || (bestComplete && means[wallIndex] > best + NIGHTMARE_WALL_PRODUCTIVE_MARGIN);
}
