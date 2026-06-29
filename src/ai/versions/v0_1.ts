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

import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import { getCellsAroundPosition, getPositionForCell } from "../../grid/grid_math";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import { findTarget, AIActionType, type IAIAction } from "../ai";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";

export const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;

export const otherTeam = (team: number): number =>
    team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;

/**
 * v0.1 — the frozen baseline. Decision-making is exactly today's shipping heuristic AI
 * (`AI.findTarget` + the same action mapping the live server runs in runServerAiTurn), so a v0.2 vs
 * v0.1 tournament measures real improvement against what currently ships. Placement is a simple,
 * deterministic role-based layout (melee in front, ranged/casters behind) — there was no AI placement
 * before, so this is the baseline placement to beat. Magic/aura play is intentionally NOT included in
 * v0.1; a caster simply advances/holds, leaving headroom for v0.2 to add spellcasting.
 */
export class StrategyV0_1 implements IAIStrategy {
    public readonly version: string = "v0.1";
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const placements = new Map<string, XY>();
        const occupied = new Set<number>();
        const legal = context.placement.possibleCellHashes();

        // "Frontness" grows toward the enemy: LOWER deploys on the low-Y rows and faces up, UPPER
        // deploys on the high-Y rows and faces down. Melee wants the highest frontness, ranged the
        // lowest, so the squishy shooters sit behind the wall.
        const frontness = (cell: XY): number =>
            context.team === PBTypes.TeamVals.LOWER ? cell.y : GRID_SIZE - 1 - cell.y;

        const baseCells: XY[] = [];
        for (const hash of legal) {
            baseCells.push({ x: hash >> 4, y: hash & 0xf });
        }

        const footprintFor = (unit: Unit, base: XY): XY[] =>
            unit.isSmallSize()
                ? [base]
                : [
                      { x: base.x, y: base.y },
                      { x: base.x - 1, y: base.y },
                      { x: base.x, y: base.y - 1 },
                      { x: base.x - 1, y: base.y - 1 },
                  ];

        const tryPlace = (unit: Unit, preferFront: boolean): boolean => {
            const ordered = [...baseCells].sort((a, b) =>
                preferFront ? frontness(b) - frontness(a) : frontness(a) - frontness(b),
            );
            for (const base of ordered) {
                const footprint = footprintFor(unit, base);
                if (footprint.some((c) => !legal.has(cellKey(c)) || occupied.has(cellKey(c)))) {
                    continue;
                }
                for (const c of footprint) {
                    occupied.add(cellKey(c));
                }
                placements.set(unit.getId(), { x: base.x, y: base.y });
                return true;
            }
            return false;
        };

        // Melee front-to-back first (they form the wall), then ranged/other back-to-front.
        const isMelee = (unit: Unit): boolean => unit.getAttackType() === PBTypes.AttackVals.MELEE;
        const ordered = [...units].sort((a, b) => {
            const sizeDelta = (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1); // large first (harder to fit)
            if (sizeDelta !== 0) {
                return sizeDelta;
            }
            return (isMelee(b) ? 1 : 0) - (isMelee(a) ? 1 : 0);
        });
        for (const unit of ordered) {
            tryPlace(unit, isMelee(unit));
        }

        return placements;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const aiAction = findTarget(unit, grid, matrix, unitsHolder, pathHelper);
        if (!aiAction) {
            return this.fallbackTurn(unit, context);
        }

        const type = aiAction.actionType();

        if (type === AIActionType.RANGE_ATTACK) {
            const targetCell = aiAction.cellToAttack();
            const targetId = targetCell ? grid.getOccupantUnitId(targetCell) : undefined;
            if (!targetId) {
                return this.fallbackTurn(unit, context);
            }
            const actions: GameAction[] = [];
            if (unit.getAttackTypeSelection() !== PBTypes.AttackVals.RANGE) {
                actions.push({
                    type: "select_attack_type",
                    unitId: unit.getId(),
                    attackType: PBTypes.AttackVals.RANGE,
                });
            }
            // No aim is sent: the engine deterministically aims at the target's nearest visible edge.
            actions.push({ type: "range_attack", attackerId: unit.getId(), targetId });
            return actions;
        }

        if (type === AIActionType.MELEE_ATTACK || type === AIActionType.MOVE_AND_MELEE_ATTACK) {
            // Mirror the live server's ensureAiAttackType guard: findTarget can hand back a melee even
            // for a unit that cannot melee (e.g. a "No Melee" shooter like Tsar Cannon, boxed in and
            // unable to shoot). Proposing it just gets rejected and wastes the turn — reposition instead.
            if (unit.hasAbilityActive("No Melee")) {
                return this.fallbackTurn(unit, context);
            }
            const targetCell = aiAction.cellToAttack();
            const attackFrom = aiAction.cellToMove() ?? unit.getBaseCell();
            const targetId = targetCell ? grid.getOccupantUnitId(targetCell) : undefined;
            if (!targetId || !attackFrom) {
                return this.fallbackTurn(unit, context);
            }
            const route =
                type === AIActionType.MOVE_AND_MELEE_ATTACK ? this.routeForCell(aiAction, attackFrom) : undefined;
            const actions: GameAction[] = [];
            if (unit.getAttackTypeSelection() !== PBTypes.AttackVals.MELEE) {
                actions.push({
                    type: "select_attack_type",
                    unitId: unit.getId(),
                    attackType: PBTypes.AttackVals.MELEE,
                });
            }
            actions.push({
                type: "melee_attack",
                attackerId: unit.getId(),
                targetId,
                attackFrom: { x: attackFrom.x, y: attackFrom.y },
                path: route?.route,
                hasLavaCell: route?.hasLavaCell,
                hasWaterCell: route?.hasWaterCell,
            });
            return actions;
        }

        if (type === AIActionType.MOVE) {
            const targetCell = aiAction.cellToMove();
            if (!targetCell || !unit.canMove()) {
                return this.fallbackTurn(unit, context);
            }
            const route = this.routeForCell(aiAction, targetCell);
            if (!route?.route.length) {
                return this.fallbackTurn(unit, context);
            }
            return [
                {
                    type: "move_unit",
                    unitId: unit.getId(),
                    path: route.route.map((c) => ({ x: c.x, y: c.y })),
                    targetCells: this.footprintForCell(unit, targetCell, context),
                    hasLavaCell: route.hasLavaCell,
                    hasWaterCell: route.hasWaterCell,
                },
            ];
        }

        // MAGIC_ATTACK (and anything else): v0.1 doesn't cast — just advance toward the enemy / hold.
        return this.fallbackTurn(unit, context);
    }
    protected routeForCell(aiAction: IAIAction, cell: XY): IWeightedRoute | undefined {
        return aiAction.currentActiveKnownPaths().get(cellKey(cell))?.[0];
    }
    protected footprintForCell(unit: Unit, cell: XY, context: IDecisionContext): XY[] {
        if (unit.isSmallSize()) {
            return [{ x: cell.x, y: cell.y }];
        }
        const gs = context.grid.getSettings();
        const position = getPositionForCell(cell, gs.getMinX(), gs.getStep(), gs.getHalfStep());
        return getCellsAroundPosition(gs, {
            x: position.x - gs.getHalfStep(),
            y: position.y - gs.getHalfStep(),
        });
    }
    /**
     * No reachable enemy/target: advance toward the nearest enemy along the best known route, mirroring
     * the live server's fallback. If the unit can't move, pass the turn.
     */
    protected fallbackTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const endTurn: GameAction = { type: "end_turn", unitId: unit.getId(), reason: "manual" };
        if (!unit.canMove()) {
            return [endTurn];
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
        );
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
        if (!enemies.length || !movePath.knownPaths.size) {
            return [endTurn];
        }

        const base = unit.getBaseCell();
        let bestRoute: IWeightedRoute | undefined;
        let bestScore = Infinity;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            const cell = route.cell;
            if (cell.x === base.x && cell.y === base.y) {
                continue;
            }
            const score = Math.min(
                ...enemies.map((enemy) => {
                    const ec = enemy.getBaseCell();
                    return Math.abs(cell.x - ec.x) + Math.abs(cell.y - ec.y);
                }),
            );
            if (score < bestScore) {
                bestScore = score;
                bestRoute = route;
            }
        }
        if (!bestRoute?.route.length) {
            return [endTurn];
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: bestRoute.route.map((c) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, bestRoute.cell, context),
                hasLavaCell: bestRoute.hasLavaCell,
                hasWaterCell: bestRoute.hasWaterCell,
            },
        ];
    }
}

export const STRATEGY_V0_1: IAIStrategy = new StrategyV0_1();
