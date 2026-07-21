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
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import {
    getCellsAroundPosition,
    getPositionForCell,
    getRangeAttackSideCenter,
    isCellWithinGrid,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import { AIActionType, canUnitLandAt, findTarget, type IAIAction } from "../ai";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { meleeAttackTypeSelectionPrefix } from "../melee_attack_type";

export const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;

export const otherTeam = (team: number): number =>
    team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;

/**
 * v0.1 — the simple baseline. Decision-making is the shipping heuristic (`AI.findTarget` + the same
 * action mapping the live server uses), hardened to emit only engine-legal actions. Placement is a
 * deterministic role-based layout (melee in front, ranged/casters behind). Magic/aura play is
 * intentionally NOT included; a caster simply advances/holds.
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
            // Mirror the live server's ensureAiAttackType(RANGE) guard (dropped in the original port):
            // the engine is the source of truth for what a unit can do, and it removes RANGE from the
            // possible attack types when the unit is out of ammo or boxed in by melee. Proposing a range
            // shot anyway just gets rejected and wastes the turn — fall back instead.
            if (!unit.getPossibleAttackTypes().includes(PBTypes.AttackVals.RANGE)) {
                return this.fallbackTurn(unit, context);
            }
            const targetCell = aiAction.cellToAttack();
            const targetId = targetCell ? grid.getOccupantUnitId(targetCell) : undefined;
            if (!targetId) {
                return this.fallbackTurn(unit, context);
            }
            const shot = this.findLegalRangeAttack(unit, context, targetId);
            if (!shot) {
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
            actions.push(shot);
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
            let targetId = targetCell ? grid.getOccupantUnitId(targetCell) : undefined;
            if (!targetId || !attackFrom) {
                return this.fallbackTurn(unit, context);
            }

            const target = unitsHolder.getAllUnits().get(targetId);
            if (!target || !this.isLegalMeleeTarget(unit, target, context)) {
                return this.fallbackTurn(unit, context);
            }

            const attackFromCells = this.footprintForCell(unit, attackFrom, context);
            if (!grid.areCellsAdjacent(attackFromCells, target.getCells())) {
                return this.fallbackTurn(unit, context);
            }

            const base = unit.getBaseCell();
            const movesToAttack = attackFrom.x !== base.x || attackFrom.y !== base.y;
            if (movesToAttack && !unit.canMove()) {
                return this.fallbackTurn(unit, context);
            }
            const route = movesToAttack ? this.routeForCell(aiAction, attackFrom) : undefined;
            if (movesToAttack && !route?.route.length) {
                return this.fallbackTurn(unit, context);
            }

            if (this.version === "v0.1") {
                targetId = this.preferRespondedMeleeTarget(unit, context, targetId, attackFromCells);
            }

            const actions = meleeAttackTypeSelectionPrefix(unit);
            const selected = unit.getAttackTypeSelection();
            const alreadyMelee = selected === PBTypes.AttackVals.MELEE || selected === PBTypes.AttackVals.MELEE_MAGIC;
            if (!alreadyMelee && !actions.length) {
                return this.fallbackTurn(unit, context);
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

        if (type === AIActionType.OBSTACLE_ATTACK) {
            // Break the destructible centre mountain (BLOCK_CENTER map): cellToAttack = the struck centre
            // cell, cellToMove = the (reachable) cell to strike from. The engine wants the obstacle's pixel
            // POSITION, so convert the cell. (This mapping was previously missing in the headless path, so
            // the AI's mountain decision silently fell through to a plain advance.)
            const struckCell = aiAction.cellToAttack();
            const attackFrom = aiAction.cellToMove();
            if (!struckCell || !attackFrom) {
                return this.fallbackTurn(unit, context);
            }
            const gs = context.grid.getSettings();
            const targetPosition = getPositionForCell(struckCell, gs.getMinX(), gs.getStep(), gs.getHalfStep());
            const base = unit.getBaseCell();
            const movesToStrike = attackFrom.x !== base.x || attackFrom.y !== base.y;
            const route = movesToStrike ? this.routeForCell(aiAction, attackFrom) : undefined;
            if (movesToStrike && !route?.route.length) {
                return this.fallbackTurn(unit, context); // can't actually reach the strike cell
            }
            return [
                {
                    type: "obstacle_attack",
                    attackerId: unit.getId(),
                    targetPosition,
                    attackFrom: { x: attackFrom.x, y: attackFrom.y },
                    path: route?.route.map((c) => ({ x: c.x, y: c.y })),
                    hasLavaCell: route?.hasLavaCell,
                    hasWaterCell: route?.hasWaterCell,
                },
            ];
        }

        if (type === AIActionType.MOVE) {
            const targetCell = aiAction.cellToMove();
            if (!targetCell || !unit.canMove()) {
                return this.fallbackTurn(unit, context);
            }
            const route = this.routeForCell(aiAction, targetCell);
            if (!route || !this.isLegalMoveRoute(unit, context, targetCell, route)) {
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
    /**
     * Resolve v0.1's simple target choice into an exact engine-landable shot. The legacy no-aim shot stays
     * first so ordinary open-field behaviour is unchanged; if its default edge is occluded, try every
     * visible edge of that target, then the remaining live enemies, in deterministic roster order.
     */
    protected findLegalRangeAttack(
        unit: Unit,
        context: IDecisionContext,
        preferredTargetId: string,
    ): Extract<GameAction, { type: "range_attack" }> | undefined {
        const enemies = context.unitsHolder
            .getAllEnemyUnits(unit.getTeam())
            .filter((target) => !target.isDead() && !target.hasBuffActive("Hidden"));
        const preferred = enemies.find((target) => target.getId() === preferredTargetId);
        const orderedTargets = preferred
            ? [preferred, ...enemies.filter((target) => target.getId() !== preferredTargetId)]
            : enemies;

        for (const target of orderedTargets) {
            const defaultShot: Extract<GameAction, { type: "range_attack" }> = {
                type: "range_attack",
                attackerId: unit.getId(),
                targetId: target.getId(),
            };
            if (this.isRangeShotLandable(unit, context, defaultShot)) {
                return defaultShot;
            }

            if (!context.attackHandler) {
                continue;
            }
            const matrix = context.grid.getMatrix();
            const through = unit.hasAbilityActive("Through Shot");
            for (const cell of target.getCells()) {
                for (const side of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(matrix, cell, side, unit.getTeam(), through)) {
                        continue;
                    }
                    const aimedShot: Extract<GameAction, { type: "range_attack" }> = {
                        ...defaultShot,
                        aimCell: { x: cell.x, y: cell.y },
                        aimSide: side,
                    };
                    if (this.isRangeShotLandable(unit, context, aimedShot)) {
                        return aimedShot;
                    }
                }
            }
        }
        return undefined;
    }
    /** Mirror the range handler's pre-damage gates for this exact target cell/edge intent. */
    protected isRangeShotLandable(
        unit: Unit,
        context: IDecisionContext,
        action: Extract<GameAction, { type: "range_attack" }>,
    ): boolean {
        const target = context.unitsHolder.getAllUnits().get(action.targetId);
        if (!target || target.isDead() || target.getTeam() === unit.getTeam() || target.hasBuffActive("Hidden")) {
            return false;
        }

        const attackHandler = context.attackHandler;
        if (!attackHandler) {
            return true;
        }
        if (!attackHandler.canLandRangeAttack(unit, context.grid.getEnemyAggrMatrixByUnitId(unit.getId()))) {
            return false;
        }

        const gridSettings = context.grid.getSettings();
        const matrix = context.grid.getMatrix();
        const from = unit.getPosition();
        const through = unit.hasAbilityActive("Through Shot");
        const isAOE = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
        const closestCell = (cells: XY[]): XY | undefined => {
            let best: XY | undefined;
            let bestDistance = Number.MAX_VALUE;
            for (const cell of cells) {
                const distance = getDistance(
                    from,
                    getPositionForCell(
                        cell,
                        gridSettings.getMinX(),
                        gridSettings.getStep(),
                        gridSettings.getHalfStep(),
                    ),
                );
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = cell;
                }
            }
            return best;
        };
        const closestSide = (cell: XY, sides: readonly RangeAttackCellSide[]): RangeAttackCellSide => {
            let best = sides[0];
            let bestDistance = Number.MAX_VALUE;
            for (const side of sides) {
                const distance = getDistance(from, getRangeAttackSideCenter(gridSettings, cell, side, from));
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = side;
                }
            }
            return best;
        };

        const targetCells = target.getCells();
        const aimCell =
            (action.aimCell &&
                targetCells.find((cell) => cell.x === action.aimCell?.x && cell.y === action.aimCell?.y)) ??
            closestCell(targetCells);
        if (!aimCell) {
            return false;
        }
        const observableSides = RANGE_ATTACK_CELL_SIDES.filter((side) =>
            isRangeAttackSideObservable(matrix, aimCell, side, unit.getTeam(), through),
        );
        const to = !observableSides.length
            ? target.getPosition()
            : getRangeAttackSideCenter(
                  gridSettings,
                  aimCell,
                  action.aimSide !== undefined && observableSides.includes(action.aimSide as RangeAttackCellSide)
                      ? (action.aimSide as RangeAttackCellSide)
                      : closestSide(aimCell, observableSides),
                  from,
              );
        const evaluation = attackHandler.evaluateRangeAttack(
            context.unitsHolder.getAllUnits(),
            unit,
            from,
            to,
            through,
            false,
            isAOE,
        );
        const firstGroup = evaluation.affectedUnits[0];
        if (!firstGroup?.length || evaluation.rangeAttackDivisors.length !== evaluation.affectedUnits.length) {
            return false;
        }
        const firstHit = firstGroup[0];
        if (firstHit.isDead() || firstHit.getTeam() === unit.getTeam()) {
            return false;
        }
        if (evaluation.affectedUnits.length === 1 && firstHit.hasBuffActive("Hidden")) {
            return false;
        }
        const forcedTargetId = unit.getTarget();
        const forcedTarget = forcedTargetId ? context.unitsHolder.getAllUnits().get(forcedTargetId) : undefined;
        if (forcedTarget && !forcedTarget.isDead() && firstHit.getId() !== forcedTarget.getId()) {
            return false;
        }
        return through || !unit.hasDebuffActive("Cowardice") || unit.getCumulativeHp() >= firstHit.getCumulativeHp();
    }
    /** Mirror the target-side checks in AttackHandler.handleMeleeAttack. */
    protected isLegalMeleeTarget(unit: Unit, target: Unit, context: IDecisionContext): boolean {
        if (target.isDead() || target.getTeam() === unit.getTeam() || target.hasBuffActive("Hidden")) {
            return false;
        }
        if (unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < target.getCumulativeHp()) {
            return false;
        }
        const forcedTargetId = unit.getTarget();
        const forcedTarget = forcedTargetId ? context.unitsHolder.getAllUnits().get(forcedTargetId) : undefined;
        return !forcedTarget || forcedTarget.isDead() || forcedTarget.getId() === target.getId();
    }
    /**
     * Berserker-style v0.1 play stays deliberately simple: from the already-selected attack cell, prefer
     * an adjacent legal enemy that has spent its one melee response this lap. Position and route stay
     * unchanged, and a live Aggr target always wins.
     */
    protected preferRespondedMeleeTarget(
        unit: Unit,
        context: IDecisionContext,
        currentTargetId: string,
        attackFromCells: XY[],
    ): string {
        const fightProperties = context.fightProperties ?? FightStateManager.getInstance().getFightProperties();
        if (fightProperties.hasAlreadyRepliedAttack(currentTargetId)) {
            return currentTargetId;
        }

        const candidates = context.unitsHolder
            .getAllEnemyUnits(unit.getTeam())
            .filter(
                (target) =>
                    target.getId() !== currentTargetId &&
                    this.isLegalMeleeTarget(unit, target, context) &&
                    fightProperties.hasAlreadyRepliedAttack(target.getId()) &&
                    context.grid.areCellsAdjacent(attackFromCells, target.getCells()),
            )
            .sort((a, b) => {
                const threatA = Math.max(1, a.getAttackDamageMax()) * Math.max(1, a.getAmountAlive());
                const threatB = Math.max(1, b.getAttackDamageMax()) * Math.max(1, b.getAmountAlive());
                if (threatA !== threatB) {
                    return threatB - threatA;
                }
                const cellA = a.getBaseCell();
                const cellB = b.getBaseCell();
                return cellA.y - cellB.y || cellA.x - cellB.x || a.getName().localeCompare(b.getName());
            });
        return candidates[0]?.getId() ?? currentTargetId;
    }
    protected routeForCell(aiAction: IAIAction, cell: XY): IWeightedRoute | undefined {
        return aiAction.currentActiveKnownPaths().get(cellKey(cell))?.[0];
    }
    /** Keep MOVE proposals inside the same path, step-budget, continuity, and landing gates as the engine. */
    protected isLegalMoveRoute(unit: Unit, context: IDecisionContext, targetCell: XY, route: IWeightedRoute): boolean {
        if (!canUnitLandAt(unit, context.grid, targetCell)) {
            return false;
        }
        const destination = route.route.at(-1);
        if (!destination || destination.x !== targetCell.x || destination.y !== targetCell.y) {
            return false;
        }
        const base = unit.getBaseCell();
        const travelled =
            route.route[0]?.x === base.x && route.route[0]?.y === base.y ? route.route.slice(1) : route.route;
        if (!travelled.length || travelled.length > Math.max(1, Math.ceil(unit.getSteps()))) {
            return false;
        }
        let previous = base;
        for (const cell of travelled) {
            const dx = Math.abs(cell.x - previous.x);
            const dy = Math.abs(cell.y - previous.y);
            if (!isCellWithinGrid(context.grid.getSettings(), cell) || (dx === 0 && dy === 0) || dx > 1 || dy > 1) {
                return false;
            }
            previous = cell;
        }
        return true;
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
            unit.canTraverseLava(),
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
            if (!canUnitLandAt(unit, grid, cell)) {
                continue;
            }
            if (!this.isLegalMoveRoute(unit, context, cell, route)) {
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
