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
import { canWaitOnHourglass } from "../../engine/hourglass";
import { projectPostMoveActorAvailability } from "../../engine/post_move_actor_availability";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import {
    getPositionForCell,
    getRangeAttackSideCenter,
    isCellWithinGrid,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import { VINE_STRIDE_COST_MULTIPLIER } from "../../spells/vines";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import { AIActionType, canUnitLandAt, findTarget, type IAIAction } from "../ai";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { decisionFireWalls } from "../decision_fight_state";
import { isMindlessAiUnit } from "../unit_ai_overrides";
import { decisionPathSource, type IReadonlyWeightedRoute } from "../decision_path_catalog";
import { meleeAttackTypeSelectionPrefix } from "../melee_attack_type";

export const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;

export const otherTeam = (team: number): number =>
    team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;

/** How many cells a unit's body covers. The packing difficulty every deployment layout orders by. */
export const footprintArea = (unit: Unit): number => unit.getFootprintWidth() * unit.getFootprintHeight();

/**
 * Deployment order: the biggest body first, because it has the fewest legal anchors and a greedy layout that
 * seats it last is the one that runs out of room.
 *
 * Every layout in this directory used to phrase this as `(b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1)`,
 * a boolean that puts a 2x1 in the same bucket as a 2x2 even though a 2x2 is strictly harder to place. Area
 * reproduces the shipped 1x1-vs-2x2 order exactly (1 before 4, both directions) and sorts a rectangle between
 * them; `Array.prototype.sort` is stable, so equal-area ties keep the caller's original sequence as before.
 */
export const byFootprintAreaLargestFirst = (a: Unit, b: Unit): number => footprintArea(b) - footprintArea(a);

/**
 * The GEOMETRIC CENTRE of a unit's body, in (possibly fractional) cell coordinates, for an anchor cell.
 *
 * Placement scorers compare formations by where the bodies actually sit, not by where their anchors are, so
 * the anchor has to be pulled back half a cell per extra column and row. The shipped shapes keep their exact
 * values — nothing for a 1x1, `-0.5` on both axes for a 2x2 — and a rectangle now leans only along its long
 * side instead of being displaced diagonally by a phantom second row or column.
 */
export const footprintCenterForAnchor = (unit: Unit, anchor: XY): XY => ({
    x: anchor.x - (unit.getFootprintWidth() - 1) / 2,
    y: anchor.y - (unit.getFootprintHeight() - 1) / 2,
});

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

        // "Frontness" grows toward the enemy: LEFT deploys on the low-Y rows and faces up, RIGHT
        // deploys on the high-Y rows and faces down. Melee wants the highest frontness, ranged the
        // lowest, so the squishy shooters sit behind the wall.
        const frontness = (cell: XY): number =>
            context.team === PBTypes.TeamVals.LEFT ? cell.y : GRID_SIZE - 1 - cell.y;

        const baseCells: XY[] = [];
        for (const hash of legal) {
            baseCells.push({ x: hash >> 4, y: hash & 0xf });
        }

        // The deployment test below is "does the whole BODY fit here", so it has to be the unit's real
        // footprint. This used to expand every non-small unit into a 2x2 block, which for a 2x1 both denied
        // it the zone's left column (a cell it never needed) and reserved a row it does not stand on, so a
        // legal layout was reported as impossible and the stack fell through to the engine's scatter.
        const footprintFor = (unit: Unit, base: XY): XY[] => footprintCellsForAnchor(unit, base);

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
            // Biggest body first, because it is the one with the fewest legal anchors. Area orders the two
            // shipped shapes exactly as the old small/large flag did (1 before 4) and additionally seats a
            // rectangle where it belongs: harder to fit than a 1x1, easier than a 2x2.
            const sizeDelta = byFootprintAreaLargestFirst(a, b);
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
        const { grid, matrix, unitsHolder } = context;
        const aiAction = findTarget(unit, grid, matrix, unitsHolder, decisionPathSource(context));
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

            const attackFromCells = this.footprintForCell(unit, attackFrom, context);
            if (this.version === "v0.1") {
                targetId = this.preferRespondedMeleeTarget(unit, context, targetId, attackFromCells);
                if (!targetId) {
                    return this.fallbackTurn(unit, context);
                }
            }

            const target = unitsHolder.getAllUnits().get(targetId);
            if (!target || !this.isLegalMeleeTarget(unit, target, context)) {
                return this.fallbackTurn(unit, context);
            }

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
            if (movesToAttack) {
                if (!route || !this.isLegalMoveRoute(unit, context, attackFrom, route)) {
                    return this.fallbackTurn(unit, context);
                }
                return this.completeMoveWithAdjacentMelee(unit, context, route, targetId);
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
                path: route?.route.map((cell) => ({ x: cell.x, y: cell.y })),
                hasLavaCell: route?.hasLavaCell,
                hasWaterCell: route?.hasWaterCell,
            });
            return actions;
        }

        if (type === AIActionType.OBSTACLE_ATTACK) {
            // A MINDLESS unit ("AI Driven": Berserker, Frenzied Boar) never spends its turn on the mountain.
            // These creatures are pinned to this strategy for flavour and balance (see ai/unit_ai_overrides),
            // and a berserk creature hammering a rock while an enemy stands next to it reads as a bug, not as
            // rage — v0.8 stopped taking mountain turns for the same reason. Fall through to the normal
            // decision so it charges instead; fallbackTurn still yields a wait when nothing else is legal.
            if (isMindlessAiUnit(unit)) {
                return this.fallbackTurn(unit, context);
            }
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
            return this.completeMoveWithAdjacentMelee(unit, context, route);
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
            .filter(
                (target) =>
                    !target.isDead() && !target.hasBuffActive("Hidden") && !unit.cannotAttackUnitId(target.getId()),
            );
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
        if (
            !target ||
            target.isDead() ||
            target.getTeam() === unit.getTeam() ||
            target.hasBuffActive("Hidden") ||
            unit.cannotAttackUnitId(target.getId())
        ) {
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
        if (firstHit.isDead() || firstHit.getTeam() === unit.getTeam() || unit.cannotAttackUnitId(firstHit.getId())) {
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
        return through || !unit.hasStatusApplied("Cowardice") || unit.getCumulativeHp() >= firstHit.getCumulativeHp();
    }
    /** Mirror the target-side checks in AttackHandler.handleMeleeAttack. */
    protected isLegalMeleeTarget(unit: Unit, target: Unit, context: IDecisionContext): boolean {
        return this.isLegalMeleeTargetAtHp(unit, target, context, unit.getCumulativeHp());
    }
    /** Mirror melee target gates after movement effects have changed the attacker's projected stack HP. */
    protected isLegalMeleeTargetAtHp(
        unit: Unit,
        target: Unit,
        context: IDecisionContext,
        attackerCumulativeHp: number,
    ): boolean {
        if (target.isDead() || target.getTeam() === unit.getTeam() || target.hasBuffActive("Hidden")) {
            return false;
        }
        if (unit.cannotAttackUnitId(target.getId())) {
            return false;
        }
        if (unit.hasStatusApplied("Cowardice") && attackerCumulativeHp < target.getCumulativeHp()) {
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
        attackerCumulativeHp = unit.getCumulativeHp(),
    ): string | undefined {
        const fightProperties = context.fightProperties ?? FightStateManager.getInstance().getFightProperties();
        const candidates = context.unitsHolder
            .getAllEnemyUnits(unit.getTeam())
            .filter(
                (target) =>
                    this.isLegalMeleeTargetAtHp(unit, target, context, attackerCumulativeHp) &&
                    context.grid.areCellsAdjacent(attackFromCells, target.getCells()),
            );
        const current = candidates.find((target) => target.getId() === currentTargetId);
        // Sandbox/server update FightProperties and Unit.responded together. Ranked snapshots restore the
        // authoritative per-unit `responded` flag (for the tag) but intentionally do not reconstruct every
        // FightProperties collection in the browser. Read either source so a client-controlled AI-Driven
        // Berserker/Boar gets the same response-spent preference as headless/server v0.1.
        const hasResponded = (target: Unit): boolean =>
            target.getResponded() || fightProperties.hasAlreadyRepliedAttack(target.getId());
        if (current && hasResponded(current)) {
            return currentTargetId;
        }

        const sortByThreat = (targets: Unit[]): Unit[] =>
            targets.sort((a, b) => {
                const threatA = Math.max(1, a.getAttackDamageMax()) * Math.max(1, a.getAmountAlive());
                const threatB = Math.max(1, b.getAttackDamageMax()) * Math.max(1, b.getAmountAlive());
                if (threatA !== threatB) {
                    return threatB - threatA;
                }
                const cellA = a.getBaseCell();
                const cellB = b.getBaseCell();
                return cellA.y - cellB.y || cellA.x - cellB.x || a.getName().localeCompare(b.getName());
            });
        const responded = sortByThreat(
            candidates.filter((target) => target.getId() !== currentTargetId && hasResponded(target)),
        );
        return responded[0]?.getId() ?? current?.getId() ?? sortByThreat(candidates)[0]?.getId();
    }
    protected routeForCell(aiAction: IAIAction, cell: XY): IReadonlyWeightedRoute | undefined {
        return aiAction.currentActiveKnownPaths().get(cellKey(cell))?.[0];
    }
    /** Keep MOVE proposals inside the same path, step-budget, continuity, and landing gates as the engine. */
    protected isLegalMoveRoute(
        unit: Unit,
        context: IDecisionContext,
        targetCell: XY,
        route: IReadonlyWeightedRoute,
    ): boolean {
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
        const vines =
            context.fightProperties?.getVines() ?? FightStateManager.getInstance().getFightProperties().getVines();
        const cheapestCellCost =
            unit.hasAbilityActive("In Its Own World") && vines.size() > 0 ? VINE_STRIDE_COST_MULTIPLIER : 1;
        const maxTravelledCells = Math.max(1, Math.ceil(unit.getSteps() / cheapestCellCost));
        if (
            !travelled.length ||
            travelled.length > maxTravelledCells ||
            !Number.isFinite(route.weight) ||
            route.weight < 0 ||
            route.weight > unit.getSteps() + 1e-9
        ) {
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
    /**
     * The cells `unit` would occupy standing on `cell` — the ONE footprint every strategy from v0.1 to v0.9
     * (and every a13/a19 decorator that inherits `decideTurn`) uses to build `move_unit.targetCells` and to
     * test a stand cell.
     *
     * It used to synthesise the block by shifting the cell centre half a step down-left and asking
     * `getCellsAroundPosition`, which can only ever describe a 2x2. A rectangle therefore proposed a body it
     * does not have: the engine rejected the move outright, and the adjacency tests fed from it were wrong on
     * both axes. Delegating to the shared expansion keeps 1x1 and 2x2 on exactly the cells they had and makes
     * every other shape correct for free.
     *
     * The 2x2 cells come out in the shared helper's order (anchor first) rather than `getCellsAroundPosition`'s
     * (top-left first). Nothing here or in the engine reads the list positionally — occupancy, adjacency and
     * `getPositionForCells` all treat it as a set — and it is now the same order the client already sends for a
     * human's large-unit move, so AI and human `move_unit` payloads finally agree.
     *
     * `context` stays in the signature because every subclass calls through it positionally; the grid is no
     * longer needed to answer the question.
     */
    protected footprintForCell(unit: Unit, cell: XY, _context: IDecisionContext): XY[] {
        return footprintCellsForAnchor(unit, cell);
    }
    /**
     * Finish an already validated movement route with a legal adjacent strike whenever possible.
     *
     * `findTarget` can describe this route as MOVE, or the mindless BLOCK_CENTER policy can reach it through
     * the obstacle fallback. Both paths must implement the same "run and attack" contract. Project movement
     * effects before testing Cowardice and actor availability so the suffix cannot manufacture a rejected hit.
     */
    protected completeMoveWithAdjacentMelee(
        unit: Unit,
        context: IDecisionContext,
        route: IReadonlyWeightedRoute,
        preferredTargetId?: string,
    ): GameAction[] {
        const targetCells = this.footprintForCell(unit, route.cell, context);
        const move: Extract<GameAction, { type: "move_unit" }> = {
            type: "move_unit",
            unitId: unit.getId(),
            path: route.route.map((cell) => ({ x: cell.x, y: cell.y })),
            targetCells,
            hasLavaCell: route.hasLavaCell,
            hasWaterCell: route.hasWaterCell,
        };
        if (unit.hasAbilityActive("No Melee")) {
            return [move];
        }

        const projection = projectPostMoveActorAvailability(unit, decisionFireWalls(context), move, route);
        if (!projection.availableAfterMove || projection.resurrected) {
            return [move];
        }
        const postMoveCumulativeHp =
            projection.stack.amountAlive <= 0
                ? 0
                : (projection.stack.amountAlive - 1) * projection.stack.maxHp + Math.max(0, projection.stack.hp);
        const adjacent = context.unitsHolder
            .getAllEnemyUnits(unit.getTeam())
            .filter(
                (enemy) =>
                    this.isLegalMeleeTargetAtHp(unit, enemy, context, postMoveCumulativeHp) &&
                    context.grid.areCellsAdjacent(targetCells, enemy.getCells()),
            );
        const preferred = adjacent.find((enemy) => enemy.getId() === preferredTargetId);
        const targetId = preferred ?? adjacent[0];
        const resolvedTargetId = targetId
            ? this.preferRespondedMeleeTarget(unit, context, targetId.getId(), targetCells, postMoveCumulativeHp)
            : undefined;
        if (!resolvedTargetId) {
            return [move];
        }

        const actions = meleeAttackTypeSelectionPrefix(unit);
        const selected = unit.getAttackTypeSelection();
        const alreadyMelee = selected === PBTypes.AttackVals.MELEE || selected === PBTypes.AttackVals.MELEE_MAGIC;
        if (!alreadyMelee && !actions.length) {
            return [move];
        }
        // Keep movement as its own authoritative action. Besides updating occupancy, the move handler owns
        // Fire Wall damage, Water Shield consumption, terrain buffs, vines, smoke and unit_moved events.
        // A path-bearing melee_attack uses the older integrated movement path and does not apply that complete
        // lifecycle, so folding this pair would let the simple AI bypass board hazards.
        actions.push(move);
        actions.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: resolvedTargetId,
            attackFrom: { x: route.cell.x, y: route.cell.y },
        });
        return actions;
    }
    /**
     * A mindless stack can be temporarily boxed in by its own army even though it is healthy and mobile.
     * Preserve its chance to charge later in the lap: hourglass once while a teammate can still clear a
     * lane, then defend when waiting is unavailable. A raw end_turn is both a morale-penalized skip and a
     * false "stuck" signal in the v0.8 coverage gates.
     *
     * Keep ordinary v0.1 callers unchanged. The non-mindless baseline (and strategies inheriting this
     * fallback) historically ends an idle turn; this special case belongs only to "AI Driven" creatures.
     */
    protected idleTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        if (!isMindlessAiUnit(unit)) {
            return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
        }
        const fightProperties = context.fightProperties;
        const canHourglass =
            !!fightProperties && canWaitOnHourglass(unit, fightProperties, context.unitsHolder.getAllUnits());
        return canHourglass
            ? [{ type: "wait_turn", unitId: unit.getId() }]
            : [{ type: "defend_turn", unitId: unit.getId() }];
    }
    /**
     * No reachable enemy/target: advance toward the nearest enemy along the best known route, mirroring
     * the live server's fallback. If the unit can't move, use its appropriate idle action.
     */
    protected fallbackTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const { grid, matrix, unitsHolder } = context;
        if (!unit.canMove()) {
            return this.idleTurn(unit, context);
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const movePath = decisionPathSource(context).getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
            unit.hasAbilityActive("In Its Own World"),
            unit.getFootprintWidth(),
            unit.getFootprintHeight(),
        );
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
        if (!enemies.length || !movePath.knownPaths.size) {
            return this.idleTurn(unit, context);
        }

        const base = unit.getBaseCell();
        let bestRoute: IReadonlyWeightedRoute | undefined;
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
            return this.idleTurn(unit, context);
        }
        return this.completeMoveWithAdjacentMelee(unit, context, bestRoute);
    }
}

export const STRATEGY_V0_1: IAIStrategy = new StrategyV0_1();
