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

import { PBTypes } from "../generated/protobuf/v1/types";
import { Grid } from "../grid/grid";
import { ObstacleType } from "../obstacles/obstacle_type";
import * as HoCMath from "../utils/math";
import { PathHelper } from "../grid/path_helper";
import * as GridMath from "../grid/grid_math";
import type { IWeightedRoute } from "../grid/path_definitions";
import { Unit } from "../units/unit";
import type { IUnitAIRepr } from "./../units/unit";
import { UnitsHolder } from "../units/units_holder";
import * as HoCLib from "../utils/lib";
import * as EffectHelper from "../effects/effect_helper";
import { FightStateManager } from "../fights/fight_state_manager";
import type { GridSettings } from "../grid/grid_settings";

const DEBUG_AI = false;

export interface IAI {
    nextMovingTarget(): HoCMath.XY | undefined;

    decide(grid: Grid, currentTick: number, id: string, enemyTeam: number): void;

    getClosestEnemyDistance(currentTick: number): number;

    ownsTargetCell(grid: Grid): boolean;

    init(grid: Grid, currentTick: number, id: string, enemyTeam: number): void;

    canAttack(): boolean;

    startAttacking(): void;

    stopAttacking(): void;

    cleanAttackTarget(grid: Grid): void;

    action(unit: Unit, grid: Grid, matrix: number[][]): IAIAction;
}

const previousTargets: Map<string, string> = new Map<string, string>();

export enum AIActionType {
    MELEE_ATTACK,
    RANGE_ATTACK,
    MAGIC_ATTACK,
    MOVE,
    MOVE_AND_MELEE_ATTACK,
    // Break the destructible center mountain (BLOCK_CENTER map). cellToAttack = the struck center
    // cell, cellToMove = the (reachable) cell to strike from. The driver issues an obstacle_attack.
    OBSTACLE_ATTACK,
}

export interface IAIAction {
    actionType(): AIActionType;
    cellToMove(): HoCMath.XY | undefined;
    cellToAttack(): HoCMath.XY | undefined;
    currentActiveKnownPaths(): Map<number, IWeightedRoute[]>;
}

export class BasicAIAction implements IAIAction {
    private readonly type: AIActionType;
    private readonly cellToMoveTo: HoCMath.XY | undefined;
    private readonly cellToAttackTo: HoCMath.XY | undefined;
    private readonly activeKnownPaths: Map<number, IWeightedRoute[]>;
    public constructor(
        type: AIActionType,
        cellToMoveTo: HoCMath.XY | undefined,
        cellToAttackTo: HoCMath.XY | undefined,
        activeKnownPaths: Map<number, IWeightedRoute[]>,
    ) {
        this.type = type;
        this.cellToMoveTo = cellToMoveTo;
        this.cellToAttackTo = cellToAttackTo;
        this.activeKnownPaths = activeKnownPaths;
    }
    public actionType(): AIActionType {
        return this.type;
    }
    public cellToMove(): HoCMath.XY | undefined {
        return this.cellToMoveTo;
    }
    public cellToAttack(): HoCMath.XY | undefined {
        return this.cellToAttackTo;
    }
    public currentActiveKnownPaths(): Map<number, IWeightedRoute[]> {
        return this.activeKnownPaths;
    }
}

/**
 * take unit, grid, matrix and return action for the given unit
 */
export function findTarget(
    unit: IUnitAIRepr,
    grid: Grid,
    matrix: number[][], // matrix for big unit has 4 cells filled
    unitsHolder: UnitsHolder,
    pathHelper: PathHelper,
): BasicAIAction | undefined {
    if (DEBUG_AI) {
        console.group("Start AI check");
        console.time("AI step");
    }

    let action: BasicAIAction | undefined = undefined;
    let selectedEnemy: Unit | undefined = undefined;
    const unitCell = unit.getBaseCell();
    const unitTeam = unit.getTeam();
    const enemyTeam = unitTeam === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    // Exclude dead and UNTARGETABLE (Disguise Aura -> "Hidden") enemies up front: the random fallback
    // pick below otherwise selects them, and the engine rejects the resulting attack (attack_not_available).
    const enemiesAround = unitsHolder
        .allEnemiesAroundUnit(unit, false)
        .filter((e) => !e.isDead() && !e.hasBuffActive("Hidden"));
    const hasNoMelee = unit.hasAbilityActive("No Melee");
    for (const e of enemiesAround) {
        if (e.isDead() || e.hasBuffActive("Hidden")) {
            continue;
        }

        if (!GridMath.isPositionWithinGrid(grid.getSettings(), e.getPosition())) {
            continue;
        }

        if (unit.getTarget() && unit.getTarget() === e.getId()) {
            selectedEnemy = e;
            break;
        }

        const previousTarget = previousTargets.get(unit.getId());
        if (previousTarget && previousTarget === e.getId()) {
            selectedEnemy = e;
            break;
        }
    }

    if (!selectedEnemy && enemiesAround.length) {
        // pick random enemy
        selectedEnemy = enemiesAround[HoCLib.getRandomInt(0, enemiesAround.length)];
    }

    if (selectedEnemy && !hasNoMelee) {
        for (const ec of selectedEnemy.getCells()) {
            for (const uc of unit.getCells()) {
                if (Math.abs(ec.x - uc.x) <= 1 && Math.abs(ec.y - uc.y) <= 1) {
                    action = new BasicAIAction(
                        AIActionType.MELEE_ATTACK,
                        unit.getBaseCell(),
                        { x: ec.x, y: ec.y },
                        new Map(),
                    );
                    break;
                }
            }
            if (action) {
                break;
            }
        }
    }

    if (!action && unit.getAttackType() === PBTypes.AttackVals.RANGE && unit.getRangeShots() > 0) {
        action = findRangeAttackAction(unit, grid, matrix, unitsHolder);
    }

    // --- Team strategy + movement ---
    const engagement = analyzeEngagement(unit, matrix, unitsHolder);
    const isRangedUnit = unit.getAttackType() === PBTypes.AttackVals.RANGE;
    const isAlreadyEngaged = countMeleeThreatsToCell(unitCell, matrix, enemyTeam) > 0;

    if (!action && !isRangedUnit && unit.canMove() && !isAlreadyEngaged) {
        // Mountain strategy (BLOCK_CENTER maps): an otherwise-idle melee unit may break the center
        // mountain to open the melee lane (see evaluateMountainStrategy). Takes priority over the
        // hold/regroup strategies below — in the "we out-range them" case mining is exactly what idle
        // melee should do instead of holding.
        const mountainAction = evaluateMountainStrategy(unit, grid, matrix, unitsHolder, pathHelper, engagement);
        if (mountainAction) {
            action = mountainAction;
        } else {
            // Strategy 1: Ranged-heavy team → defensive posture. Melee units hold position
            //              and let the enemy come to them. Only released when enemies are pressing.
            if (
                engagement.totalRangedAllies > engagement.totalMeleeAllies &&
                engagement.totalRangedAllies >= 2 &&
                !engagement.enemiesPressing
            ) {
                if (DEBUG_AI) {
                    console.log(
                        `Melee holding (ranged-heavy defense): ${engagement.totalRangedAllies}R vs ${engagement.totalMeleeAllies}M, enemies not pressing`,
                    );
                }
                return undefined; // skip — let ranged units do their work
            }

            // Strategy 2: Group coordination. If this melee unit is isolated (nearest melee
            //              ally is > GROUP_REGROUP_DIST away) and no ally is engaged yet,
            //              don't advance alone — move toward the ally group center instead
            //              of rushing toward the nearest enemy.
            if (
                engagement.totalMeleeAllies > 0 &&
                engagement.nearestMeleeAllyDist > GROUP_REGROUP_DIST &&
                engagement.engagedMeleeAllies === 0 &&
                !engagement.enemiesPressing
            ) {
                // Override the movement target: go toward allies, not toward enemies.
                const center = engagement.allyMeleeCenter;
                if (center) {
                    action = doFindTarget(unit, unitsHolder, grid, matrix, pathHelper, DEBUG_AI);
                    // If doFindTarget returned a MOVE, redirect toward the ally center.
                    if (action && action.actionType() === AIActionType.MOVE && action.currentActiveKnownPaths()) {
                        const centerKey = (center.x << 4) | center.y;
                        const pathsToCenter = action.currentActiveKnownPaths()!.get(centerKey);
                        if (pathsToCenter && pathsToCenter.length > 0) {
                            const route = pathsToCenter[0];
                            const lastCell = route.route[route.route.length - 1];
                            if (lastCell) {
                                if (DEBUG_AI) {
                                    console.log(
                                        `Melee regrouping: nearest ally ${engagement.nearestMeleeAllyDist} cells away, moving toward group center ${cellToString(center)}`,
                                    );
                                }
                                action = new BasicAIAction(
                                    AIActionType.MOVE,
                                    lastCell,
                                    undefined,
                                    action.currentActiveKnownPaths(),
                                );
                            }
                        }
                    }
                } else {
                    action = doFindTarget(unit, unitsHolder, grid, matrix, pathHelper, DEBUG_AI);
                }
            } else {
                action = doFindTarget(unit, unitsHolder, grid, matrix, pathHelper, DEBUG_AI);
            }
        }
    } else if (!action && unit.canMove()) {
        action = doFindTarget(unit, unitsHolder, grid, matrix, pathHelper, DEBUG_AI);
    }

    // --- Post-decision movement safety ---
    if (action && action.actionType() === AIActionType.MOVE) {
        if (isRangedUnit) {
            // Ranged units: avoid melee range entirely.
            const saferCell = findSaferMoveCell(
                action.cellToMove(),
                action.currentActiveKnownPaths(),
                matrix,
                enemyTeam,
                true,
            );
            if (saferCell && saferCell !== action.cellToMove()) {
                action = new BasicAIAction(AIActionType.MOVE, saferCell, undefined, action.currentActiveKnownPaths());
            }
        } else {
            // Melee units: don't rush past the frontline into 2+ enemy threats
            // when allies are already tanking.
            const destCell = action.cellToMove();
            const destThreats = destCell ? countMeleeThreatsToCell(destCell, matrix, enemyTeam) : 0;

            if (!isAlreadyEngaged && engagement.engagedMeleeAllies > 0 && destThreats >= 2) {
                const saferCell = findSaferMoveCell(
                    destCell,
                    action.currentActiveKnownPaths(),
                    matrix,
                    enemyTeam,
                    true,
                );
                if (saferCell && saferCell !== destCell) {
                    action = new BasicAIAction(
                        AIActionType.MOVE,
                        saferCell,
                        undefined,
                        action.currentActiveKnownPaths(),
                    );
                }
            }

            // Ranged-heavy team + diving into 2+ enemies alone + no ally tanking → hold.
            if (
                !isAlreadyEngaged &&
                engagement.totalRangedAllies >= 2 &&
                engagement.totalRangedAllies > engagement.totalMeleeAllies &&
                destThreats >= 2 &&
                engagement.engagedMeleeAllies === 0
            ) {
                if (DEBUG_AI) {
                    console.log(
                        `Melee holding (surrounded dive): ${engagement.totalRangedAllies}R vs ${engagement.totalMeleeAllies}M, dest ${destThreats} threats`,
                    );
                }
                return undefined;
            }
        }
    }

    // Backstab units (Scavenger) prefer striking from the target's far side for the damage bonus.
    if (action) {
        action = preferBackstabAttackCell(unit, action, grid, matrix, pathHelper, unitsHolder);
    }

    if (DEBUG_AI) {
        logAction(action, DEBUG_AI);
        console.timeEnd("AI step");
        console.groupEnd();
    }
    return action;
}

function logAction(action: BasicAIAction | undefined, debug: boolean) {
    if (!debug) {
        return;
    }
    if (!action) {
        console.log("Action is undefined");
        return;
    }
    const actionType = action.actionType();
    console.log("Do action:" + AIActionType[actionType] + " unit to move to " + cellToString(action.cellToMove()));
}

/**
 * Pick the best range-attack target for a ranged unit.
 *
 * Scoring accounts for the unit's passive abilities:
 * - Sniper: ignores distance penalty
 * - Large Caliber / Area Throw (Cyclops, Gargantuan): bonus for clustered enemies around the target
 * - Through Shot (Tsar Cannon): bonus for enemies lined up beyond the target
 * - Double Shot (Gargantuan, other double shotters): flat damage multiplier
 *
 * Returns undefined when no enemy is in range; callers fall back to movement.
 */
function findRangeAttackAction(
    unit: IUnitAIRepr,
    grid: Grid,
    matrix: number[][],
    unitsHolder: UnitsHolder,
): BasicAIAction | undefined {
    if (unit.getRangeShots() <= 0) {
        return undefined;
    }
    // A unit inside an enemy's Range Null Field (or carrying Rangebane) can't fire — don't propose a
    // range attack the engine will reject (and never animate a shot that can't happen).
    if (unit.hasDebuffActive("Range Null Field Aura") || unit.hasDebuffActive("Rangebane")) {
        return undefined;
    }

    const unitCell = unit.getBaseCell();
    const unitTeam = unit.getTeam();
    const enemyTeam = unitTeam === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;

    const isAOEAttacker = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
    const isThroughShot = unit.hasAbilityActive("Through Shot");
    const isDoubleShot = unit.hasAbilityActive("Double Shot");
    const isSniper = unit.hasAbilityActive("Sniper");
    const shotDistance = unit.getRangeShotDistance();
    if (shotDistance <= 0 && !isSniper) {
        return undefined;
    }

    // Range attacks cap the divisor at 8x (every additional shotDistance beyond the 3rd is wasted).
    const maxRangeCells = isSniper ? Infinity : shotDistance * 4;

    let bestTarget: HoCMath.XY | undefined;
    let bestScore = -1;

    const numRows = matrix.length;
    const numCols = matrix[0].length;

    for (let y = 0; y < numRows; y++) {
        for (let x = 0; x < numCols; x++) {
            if (matrix[y][x] !== enemyTeam) {
                continue;
            }

            const targetCell = { x: x, y: y };
            const distanceCells = HoCMath.getDistance(unitCell, targetCell);

            if (!isSniper && distanceCells > maxRangeCells) {
                continue;
            }

            // Skip targets whose line of sight is blocked by a mountain — the shot
            // would hit the obstacle instead of the unit (wasted turn).
            // Units with Area Throw or Large Caliber ignore mountains (AOE shot passes through).
            if (!isAOEAttacker && isLineBlockedByObstacle(unitCell, targetCell, matrix)) {
                continue;
            }

            // A normal (non-AOE, non-Through-Shot) shot stops at the FIRST unit on its line. If that unit
            // is a friendly, the shot is wasted — you can't damage your own unit — and the engine rejects
            // it as attack_not_available. An enemy blocker is fine (the shot just strikes that nearer
            // enemy), and Through Shot pierces, so only guard plain shots against a friendly screen.
            if (
                !isAOEAttacker &&
                !isThroughShot &&
                isLineBlockedByFriendlyUnit(unitCell, targetCell, matrix, unitTeam)
            ) {
                continue;
            }

            // Skip untargetable enemies: a unit hidden by Disguise Aura (no enemy within its aura range)
            // carries the "Hidden" buff and the engine rejects ANY shot at it (attack_not_available) —
            // AOE (Large Caliber) and Through Shot included, since a Hidden unit can never be the primary
            // target. Unlike the friendly-block occlusion above (which pierce/splash legitimately ignore),
            // this applies to every attack kind. Defensive optional-call for method-less test mocks.
            const rangeOccupantId = grid.getOccupantUnitId(targetCell);
            if (rangeOccupantId && unitsHolder.getAllUnits().get(rangeOccupantId)?.hasBuffActive?.("Hidden")) {
                continue;
            }

            let divisor = 1;
            if (!isSniper && shotDistance > 0) {
                let d = distanceCells;
                while (d >= shotDistance) {
                    d -= shotDistance;
                    divisor *= 2;
                }
                if (divisor > 8) {
                    divisor = 8;
                }
            }

            // Base score: damage scales inversely with the range divisor.
            let score = 1 / divisor;

            if (isAOEAttacker) {
                // AOE (Large Caliber / Area Throw) hits all units adjacent to the target cell.
                // Score by unique enemies in the splash zone, minus friendly fire penalty.
                const splash = countAOESplashValue(targetCell, matrix, enemyTeam, unit.getTeam());
                // Each enemy in splash adds full-damage potential. Allies in splash subtract.
                score *= splash.enemyCount + 1; // +1 for the primary target
                if (splash.allyCount > 0) {
                    score *= Math.max(0.1, 1 - 0.3 * splash.allyCount);
                }
            }

            if (isThroughShot) {
                const beyondEnemies = countEnemiesBeyondInLine(unitCell, targetCell, matrix, enemyTeam);
                // Through Shot applies partial damage to units behind the target.
                score *= 1 + beyondEnemies * 0.5;
            }

            if (isDoubleShot) {
                score *= 2;
            }

            if (score > bestScore) {
                bestScore = score;
                bestTarget = targetCell;
            }
        }
    }

    if (!bestTarget) {
        return undefined;
    }

    const occupantUnitId = grid.getOccupantUnitId(bestTarget);
    if (occupantUnitId) {
        previousTargets.set(unit.getId(), occupantUnitId);
    }
    if (DEBUG_AI) {
        console.log(`Range attack: picked target ${cellToString(bestTarget)} score=${bestScore.toFixed(2)}`);
    }
    return new BasicAIAction(AIActionType.RANGE_ATTACK, undefined, bestTarget, new Map());
}

/**
 * Count unique enemy and ally units in the AOE splash zone around a target cell.
 *
 * The engine's `getCellsAroundCell` expands from the target's cell corners to find all
 * adjacent cells — for a small unit this is the 8 cells around it; for a large (2x2)
 * unit the zone is wider. We approximate this by:
 * 1. Detecting if the target is a large unit (4 cells with the same team value).
 * 2. Unioning all ±1 neighbors of all target cells.
 * 3. Deduplicating large enemy units (they occupy 4 cells — count once, not 4x).
 *
 * Returns { enemyCount, allyCount } — unique enemy/ally units in the splash zone,
 * NOT counting the primary target itself.
 */
function countAOESplashValue(
    targetCell: HoCMath.XY,
    matrix: number[][],
    enemyTeam: number,
    allyTeam: number,
): { enemyCount: number; allyCount: number } {
    const numRows = matrix.length;
    const numCols = matrix[0].length;

    // Build the set of cells to check for splash — the union of ±1 neighbors of all
    // cells occupied by the target unit.
    const cellsToCheck = new Set<number>();
    const targetCells: HoCMath.XY[] = [{ x: targetCell.x, y: targetCell.y }];

    // Detect large unit: check if the 2x2 block around the target cell has the same team.
    const targetVal = matrix[targetCell.y]?.[targetCell.x];
    if (targetVal !== undefined && targetVal !== 0) {
        for (const [dx, dy] of [
            [0, 0],
            [-1, 0],
            [0, -1],
            [-1, -1],
        ]) {
            const nx = targetCell.x + dx;
            const ny = targetCell.y + dy;
            if (nx >= 0 && ny >= 0 && nx < numCols && ny < numRows && matrix[ny][nx] === targetVal) {
                targetCells.push({ x: nx, y: ny });
            }
        }
    }

    // Collect all cells in the splash zone (±1 around each target cell, excluding target cells).
    const targetCellKeys = new Set(targetCells.map((c) => (c.x << 4) | c.y));
    for (const tc of targetCells) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = tc.x + dx;
                const ny = tc.y + dy;
                if (nx < 0 || ny < 0 || nx >= numCols || ny >= numRows) continue;
                const key = (nx << 4) | ny;
                if (!targetCellKeys.has(key)) {
                    cellsToCheck.add(key);
                }
            }
        }
    }

    // Count unique enemy and ally cells in the splash zone.
    // For large units (2x2), deduplicate by detecting adjacent same-team cells.
    const enemyCells = new Set<number>();
    let allyCount = 0;
    const allyCellKeys = new Set<number>();

    for (const key of cellsToCheck) {
        const cx = (key >> 4) & 0xf;
        const cy = key & 0xf;
        const val = matrix[cy]?.[cx];
        if (val === undefined || val === 0) continue;

        if (val === enemyTeam) {
            enemyCells.add(key);
        } else if (val === allyTeam) {
            allyCellKeys.add(key);
        }
    }

    // Deduplicate large enemy units: if 4 adjacent cells have the same enemy team value,
    // count them as 1 unit instead of 4.
    const enemyCellList = [...enemyCells];
    const countedEnemies = new Set<number>();
    let enemyCount = 0;
    for (const key of enemyCellList) {
        if (countedEnemies.has(key)) continue;
        enemyCount++;
        countedEnemies.add(key);
        // Check if this is part of a 2x2 block — mark the other 3 cells as counted.
        const cx = (key >> 4) & 0xf;
        const cy = key & 0xf;
        for (const [dx, dy] of [
            [-1, 0],
            [0, -1],
            [-1, -1],
        ]) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nkey = (nx << 4) | ny;
            if (enemyCells.has(nkey)) {
                countedEnemies.add(nkey);
            }
        }
    }

    // Deduplicate allies the same way.
    const allyCellList = [...allyCellKeys];
    const countedAllies = new Set<number>();
    for (const key of allyCellList) {
        if (countedAllies.has(key)) continue;
        allyCount++;
        countedAllies.add(key);
        const cx = (key >> 4) & 0xf;
        const cy = key & 0xf;
        for (const [dx, dy] of [
            [-1, 0],
            [0, -1],
            [-1, -1],
        ]) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nkey = (nx << 4) | ny;
            if (allyCellKeys.has(nkey)) {
                countedAllies.add(nkey);
            }
        }
    }

    return { enemyCount, allyCount };
}

function countEnemiesBeyondInLine(
    fromCell: HoCMath.XY,
    targetCell: HoCMath.XY,
    matrix: number[][],
    enemyTeam: number,
): number {
    const numRows = matrix.length;
    const numCols = matrix[0].length;
    const dx = targetCell.x - fromCell.x;
    const dy = targetCell.y - fromCell.y;
    const len = Math.max(Math.abs(dx), Math.abs(dy));
    if (len === 0) {
        return 0;
    }
    const stepX = dx / len;
    const stepY = dy / len;

    let count = 0;
    let curX = targetCell.x + stepX;
    let curY = targetCell.y + stepY;

    for (let i = 0; i < len; i++) {
        const cx = Math.round(curX);
        const cy = Math.round(curY);
        if (cx < 0 || cy < 0 || cx >= numCols || cy >= numRows) {
            break;
        }
        if (matrix[cy][cx] === enemyTeam) {
            count++;
        }
        curX += stepX;
        curY += stepY;
    }
    return count;
}

/**
 * Trace the line from `fromCell` to `toCell` and return true if any intermediate
 * cell (excluding the endpoints) is a blocking obstacle (mountain). Uses the same
 * line-stepping approach as countEnemiesBeyondInLine.
 */
export function isLineBlockedByObstacle(fromCell: HoCMath.XY, toCell: HoCMath.XY, matrix: number[][]): boolean {
    const numRows = matrix.length;
    const numCols = matrix[0].length;
    const dx = toCell.x - fromCell.x;
    const dy = toCell.y - fromCell.y;
    const len = Math.max(Math.abs(dx), Math.abs(dy));
    if (len <= 1) {
        return false; // adjacent — nothing between them
    }
    const stepX = dx / len;
    const stepY = dy / len;

    let curX = fromCell.x + stepX;
    let curY = fromCell.y + stepY;

    for (let i = 1; i < len; i++) {
        const cx = Math.round(curX);
        const cy = Math.round(curY);
        if (cx >= 0 && cy >= 0 && cx < numCols && cy < numRows) {
            if (matrix[cy][cx] === ObstacleType.BLOCK) {
                return true;
            }
        }
        curX += stepX;
        curY += stepY;
    }
    return false;
}

/**
 * Whether the FIRST unit a straight shot from `fromCell` toward `toCell` meets is a friendly. A normal
 * (non-Through-Shot) projectile stops at the first body it hits; if that body is on the shooter's own
 * team the shot deals no damage and the engine rejects it. An enemy first means the shot still strikes
 * an enemy (just a nearer one), so that is not "blocked". Terrain/obstacles are flown over here — the
 * mountain block is handled separately by isLineBlockedByObstacle.
 */
export function isLineBlockedByFriendlyUnit(
    fromCell: HoCMath.XY,
    toCell: HoCMath.XY,
    matrix: number[][],
    friendlyTeam: number,
): boolean {
    const numRows = matrix.length;
    const numCols = matrix[0].length;
    const dx = toCell.x - fromCell.x;
    const dy = toCell.y - fromCell.y;
    const len = Math.max(Math.abs(dx), Math.abs(dy));
    if (len <= 1) {
        return false;
    }
    const enemyTeam = friendlyTeam === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    const stepX = dx / len;
    const stepY = dy / len;
    let curX = fromCell.x + stepX;
    let curY = fromCell.y + stepY;
    for (let i = 1; i < len; i++) {
        const cx = Math.round(curX);
        const cy = Math.round(curY);
        if (cx >= 0 && cy >= 0 && cx < numCols && cy < numRows) {
            const v = matrix[cy][cx];
            if (v === friendlyTeam) {
                return true;
            }
            if (v === enemyTeam) {
                return false;
            }
        }
        curX += stepX;
        curY += stepY;
    }
    return false;
}

/**
 * Count enemy units adjacent (within 1 cell) to a given cell — those that can
 * melee-attack a unit standing there next turn. Only melee proximity counts as
 * a "dangerous" threat for movement; ranged exchanges are normal gameplay.
 */
export function countMeleeThreatsToCell(cell: HoCMath.XY, matrix: number[][], enemyTeam: number): number {
    const numCols = matrix[0].length;
    const numRows = matrix.length;
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cell.x + dx;
            const ny = cell.y + dy;
            if (nx < 0 || ny < 0 || nx >= numCols || ny >= numRows) continue;
            if (matrix[ny][nx] === enemyTeam) count++;
        }
    }
    return count;
}

/**
 * Snapshot of the unit's team situation: how many allies are melee vs ranged,
 * how many melee allies are already adjacent to an enemy ("engaged" / tanking),
 * the centroid of melee allies (for grouping), the distance from this unit to
 * its nearest melee ally, and whether any enemy is within `pressRange` cells of
 * any ally (enemies "pressing" — if not, the team can hold position).
 */
export interface ITeamEngagement {
    totalAllies: number;
    totalMeleeAllies: number;
    totalRangedAllies: number;
    engagedMeleeAllies: number;
    allyMeleeCenter: HoCMath.XY | undefined;
    nearestMeleeAllyDist: number;
    enemiesPressing: boolean;
}

const ENEMY_PRESS_RADIUS = 3;
const GROUP_REGROUP_DIST = 4;

export function analyzeEngagement(unit: IUnitAIRepr, matrix: number[][], unitsHolder: UnitsHolder): ITeamEngagement {
    const team = unit.getTeam();
    const enemyTeam = team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    const allies = unitsHolder.getAllAllies(team);
    const unitCell = unit.getBaseCell();
    const numCols = matrix[0]?.length ?? 0;
    const numRows = matrix.length;

    let totalAllies = 0;
    let totalMeleeAllies = 0;
    let totalRangedAllies = 0;
    let engagedMeleeAllies = 0;
    let meleeSumX = 0;
    let meleeSumY = 0;
    let nearestMeleeAllyDist = Infinity;
    let enemiesPressing = false;

    for (const ally of allies) {
        if (ally.getId() === unit.getId() || ally.isDead()) continue;
        const allyCell = ally.getBaseCell();
        if (!allyCell) continue;
        totalAllies++;

        const isRanged = ally.getAttackType() === PBTypes.AttackVals.RANGE;
        if (isRanged) {
            totalRangedAllies++;
        } else {
            totalMeleeAllies++;
            meleeSumX += allyCell.x;
            meleeSumY += allyCell.y;
            if (unitCell) {
                nearestMeleeAllyDist = Math.min(nearestMeleeAllyDist, HoCMath.getDistance(unitCell, allyCell));
            }
            if (countMeleeThreatsToCell(allyCell, matrix, enemyTeam) > 0) {
                engagedMeleeAllies++;
            }
        }

        // Check if any enemy is within ENEMY_PRESS_RADIUS of this ally.
        if (!enemiesPressing) {
            for (let dy = -ENEMY_PRESS_RADIUS; dy <= ENEMY_PRESS_RADIUS; dy++) {
                for (let dx = -ENEMY_PRESS_RADIUS; dx <= ENEMY_PRESS_RADIUS; dx++) {
                    const nx = allyCell.x + dx;
                    const ny = allyCell.y + dy;
                    if (nx >= 0 && ny >= 0 && nx < numCols && ny < numRows && matrix[ny][nx] === enemyTeam) {
                        enemiesPressing = true;
                        break;
                    }
                }
                if (enemiesPressing) break;
            }
        }
    }

    return {
        totalAllies,
        totalMeleeAllies,
        totalRangedAllies,
        engagedMeleeAllies,
        allyMeleeCenter:
            totalMeleeAllies > 0
                ? { x: Math.round(meleeSumX / totalMeleeAllies), y: Math.round(meleeSumY / totalMeleeAllies) }
                : undefined,
        nearestMeleeAllyDist: nearestMeleeAllyDist === Infinity ? 0 : nearestMeleeAllyDist,
        enemiesPressing,
    };
}

// ──────────────────────────── Mountain (BLOCK_CENTER) strategy ────────────────────────────
// On a BLOCK_CENTER map a destructible 4x4 mountain sits in the middle of the board, splitting it
// and lengthening every melee route to the enemy. Clearing it opens a direct lane. The AI weighs
// breaking it against advancing, driven by which side has the stronger RANGED army:
//   • We out-range them  → our ranged army wins the long game, so keep idle melee productive by
//                          mining the mountain (ranged units hold/shoot as usual).
//   • They out-range us  → only mine when we can finish it FAST — units grouped and enough melee to
//                          clear it in a single lap — so it actually accelerates our rush instead of
//                          wasting turns chipping rock while we're shot at. Otherwise just advance.
// Either way we only mine before contact (enemies not pressing) and never trade away a real attack.

/** Total potential ranged firepower of a team: Σ remaining shots × max per-shot damage. */
export function teamRangedFirepower(team: number, unitsHolder: UnitsHolder): number {
    let firepower = 0;
    for (const u of unitsHolder.getAllAllies(team)) {
        if (u.isDead() || u.getAttackType() !== PBTypes.AttackVals.RANGE) {
            continue;
        }
        const shots = u.getRangeShots();
        if (shots <= 0) {
            continue;
        }
        firepower += shots * Math.max(1, u.getAttackDamageMax());
    }
    return firepower;
}

/** Remaining hits on the center mountain, or 0 when the map has none / it's already cleared. */
export function mountainHitsLeft(grid: Grid): number {
    if (grid.getGridType() !== PBTypes.GridVals.BLOCK_CENTER) {
        return 0;
    }
    return FightStateManager.getInstance().getFightProperties().getObstacleHitsLeft();
}

/**
 * For a melee unit, find a reachable cell to strike the mountain from this turn: the cheapest-to-reach
 * cell (or its current cell) that is adjacent to the mountain's outer ring. Returns the strike cell,
 * the struck center cell, and the unit's reachable paths — or undefined if it can't reach the mountain.
 */
export function findMountainMeleeStrike(
    unit: IUnitAIRepr,
    grid: Grid,
    matrix: number[][],
    pathHelper: PathHelper,
): { attackFrom: HoCMath.XY; targetCell: HoCMath.XY; knownPaths: Map<number, IWeightedRoute[]> } | undefined {
    const outerCells = grid.getCenterCells(true);
    if (!outerCells.length) {
        return undefined;
    }
    const unitCell = unit.getBaseCell();
    const enemyTeam = unit.getTeam() === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    const movePath = pathHelper.getMovePath(
        unitCell,
        matrix,
        unit.getSteps(),
        grid.getAggrMatrixByTeam(enemyTeam),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );
    const knownPaths = movePath.knownPaths;

    let best: { attackFrom: HoCMath.XY; targetCell: HoCMath.XY; weight: number } | undefined;
    const consider = (standCell: HoCMath.XY, weight: number): void => {
        for (const oc of outerCells) {
            if (Math.abs(standCell.x - oc.x) <= 1 && Math.abs(standCell.y - oc.y) <= 1) {
                if (!best || weight < best.weight) {
                    best = { attackFrom: standCell, targetCell: oc, weight };
                }
                break;
            }
        }
    };

    // Striking in place (already adjacent) is cheapest — no move needed.
    consider(unitCell, 0);
    for (const [key, routes] of knownPaths) {
        const standCell = { x: (key >> 4) & 0xf, y: key & 0xf };
        consider(standCell, routes?.[0]?.weight ?? Infinity);
    }

    if (!best) {
        return undefined;
    }
    return { attackFrom: best.attackFrom, targetCell: best.targetCell, knownPaths };
}

/**
 * Decide whether this (melee) unit should break the center mountain this turn. Returns an
 * OBSTACLE_ATTACK action when it should and can reach the mountain, otherwise undefined (caller
 * falls back to normal movement). See the strategy comment above for the two firepower cases.
 */
function evaluateMountainStrategy(
    unit: IUnitAIRepr,
    grid: Grid,
    matrix: number[][],
    unitsHolder: UnitsHolder,
    pathHelper: PathHelper,
    engagement: ITeamEngagement,
): BasicAIAction | undefined {
    if (mountainHitsLeft(grid) <= 0) {
        return undefined;
    }
    // Only melee units mine; ranged units stay on shooting/holding duty. Never mine with enemies
    // pressing — deal with the incoming fight (or reach safety) first.
    if (unit.getAttackType() === PBTypes.AttackVals.RANGE || !unit.canMove() || engagement.enemiesPressing) {
        return undefined;
    }

    // If the melee army is spread out — a melee ally is too far to reach the fight and nobody is
    // engaged yet — regrouping beats chipping the mountain alone (even in place). Defer to the
    // group-coordination movement (Strategy 2 in findTarget) so the army opens the lane together
    // instead of one unit picking at rock while stragglers are stuck across the map.
    if (
        engagement.totalMeleeAllies > 0 &&
        engagement.nearestMeleeAllyDist > GROUP_REGROUP_DIST &&
        engagement.engagedMeleeAllies === 0 &&
        !engagement.enemiesPressing
    ) {
        return undefined;
    }

    const strike = findMountainMeleeStrike(unit, grid, matrix, pathHelper);
    if (!strike) {
        return undefined; // can't reach the mountain this turn — advance normally instead
    }

    const team = unit.getTeam();
    const enemyTeam = team === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
    const weOutRange = teamRangedFirepower(team, unitsHolder) > teamRangedFirepower(enemyTeam, unitsHolder);

    // Striking the mountain IN PLACE (already adjacent — no move, no change in exposure) is free progress
    // toward opening the lane, so an otherwise-idle melee unit should always take it, regardless of the
    // firepower balance. Only a MOVE to reach the mountain is weighed against advancing.
    const unitCell = unit.getBaseCell();
    const inPlace = !!unitCell && strike.attackFrom.x === unitCell.x && strike.attackFrom.y === unitCell.y;
    if (!weOutRange && !inPlace) {
        // They out-range us and reaching the block costs a move: only commit when the melee is GROUPED, so
        // the army opens the lane together instead of a lone unit chipping rock in the open. (Previously
        // this also demanded a full single-lap clear — 5 units in reach at once — which a melee-heavy army
        // rushing ranged shooters essentially never met, so it detoured the whole way round instead.)
        const grouped = engagement.nearestMeleeAllyDist <= GROUP_REGROUP_DIST;
        if (!grouped) {
            return undefined;
        }
    }

    return new BasicAIAction(AIActionType.OBSTACLE_ATTACK, strike.attackFrom, strike.targetCell, strike.knownPaths);
}

// ──────────────────────────────── Backstab positioning ────────────────────────────────
// Backstab (Scavenger) deals bonus damage only when the attacker strikes from the target's far side.
// Mirror the engine's trigger (getAbilitiesWithPosisionCoefficient): a LOWER-team attacker must stand
// at a HIGHER y than the target, an UPPER-team attacker at a LOWER y. (Small targets only here, so no
// large-unit margin.)
function isBackstabCell(team: number, fromCell: HoCMath.XY, targetCell: HoCMath.XY): boolean {
    if (team === PBTypes.TeamVals.LOWER) {
        return fromCell.y > targetCell.y;
    }
    return fromCell.y < targetCell.y;
}

/**
 * When a Backstab unit has decided to melee a (small) enemy, try to route to a reachable cell on the
 * target's backstab side instead of the nearest one — so the Scavenger always lands the bonus when it
 * can. Falls back to the original action when no backstab-side cell is reachable this turn (we never
 * give up the attack just to chase the bonus). Only re-targets the stand cell; the victim is unchanged.
 */
function preferBackstabAttackCell(
    unit: IUnitAIRepr,
    action: BasicAIAction,
    grid: Grid,
    matrix: number[][],
    pathHelper: PathHelper,
    unitsHolder: UnitsHolder,
): BasicAIAction {
    const type = action.actionType();
    if (type !== AIActionType.MELEE_ATTACK && type !== AIActionType.MOVE_AND_MELEE_ATTACK) {
        return action;
    }
    if (!unit.isSmallSize() || !unit.hasAbilityActive("Backstab")) {
        return action;
    }

    const targetCell = action.cellToAttack();
    const currentFromCell = action.cellToMove();
    if (!targetCell || !currentFromCell) {
        return action;
    }

    // Restrict to small targets: keeps the y-condition exact and the 8-neighbour adjacency valid.
    const targetUnitId = grid.getOccupantUnitId(targetCell);
    const targetUnit = targetUnitId ? unitsHolder.getAllUnits().get(targetUnitId) : undefined;
    if (!targetUnit || !targetUnit.isSmallSize()) {
        return action;
    }

    const team = unit.getTeam();
    if (isBackstabCell(team, currentFromCell, targetCell)) {
        return action; // already striking from the backstab side
    }

    const unitCell = unit.getBaseCell();
    // A backstab stand cell is adjacent to the target — and therefore adjacent to the enemy, so the
    // team aggression weighting prices it out of the normal path even when the unit can physically step
    // there this turn. Recompute reachability with a zero aggression matrix to get true raw-movement
    // reach (the Scavenger accepts the slightly riskier step in exchange for the damage bonus).
    const zeroAggr = matrix.map((row) => row.map(() => 0));
    const knownPaths = pathHelper.getMovePath(
        unitCell,
        matrix,
        unit.getSteps(),
        zeroAggr,
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    ).knownPaths;

    // Among the cells adjacent to the target on the backstab side, pick the cheapest reachable one.
    let bestCell: HoCMath.XY | undefined;
    let bestWeight = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) {
                continue;
            }
            const cell = { x: targetCell.x + dx, y: targetCell.y + dy };
            if (!isBackstabCell(team, cell, targetCell)) {
                continue;
            }
            let weight: number;
            if (cell.x === unitCell.x && cell.y === unitCell.y) {
                weight = 0; // already standing on a backstab-side cell adjacent to the target
            } else {
                const routes = knownPaths.get(cellKey(cell));
                if (!routes?.length) {
                    continue; // unreachable this turn / not a valid standing cell
                }
                weight = routes[0].weight;
            }
            if (weight < bestWeight) {
                bestWeight = weight;
                bestCell = cell;
            }
        }
    }

    if (!bestCell) {
        return action;
    }
    const newType =
        bestCell.x === unitCell.x && bestCell.y === unitCell.y
            ? AIActionType.MELEE_ATTACK
            : AIActionType.MOVE_AND_MELEE_ATTACK;
    return new BasicAIAction(newType, bestCell, targetCell, knownPaths);
}

/**
 * For ranged units: if the preferred destination is adjacent to an enemy (melee
 * threat), scan reachable cells for a safer spot NOT in melee range. Prefers cells
 * close to the preferred destination. For melee units: overridden by team-aware logic
 * in findTarget instead.
 */
export function findSaferMoveCell(
    preferredCell: HoCMath.XY | undefined,
    knownPaths: Map<number, IWeightedRoute[]> | undefined,
    matrix: number[][],
    enemyTeam: number,
    isRangedUnit: boolean,
): HoCMath.XY | undefined {
    if (!preferredCell || !knownPaths || knownPaths.size === 0 || !isRangedUnit) {
        return preferredCell;
    }

    const preferredThreats = countMeleeThreatsToCell(preferredCell, matrix, enemyTeam);
    if (preferredThreats === 0) {
        return preferredCell;
    }

    let safestCell = preferredCell;
    let safestThreats = preferredThreats;
    let safestDist = Infinity;

    for (const [key] of knownPaths) {
        const cx = (key >> 4) & 0xf;
        const cy = key & 0xf;
        const candidateCell = { x: cx, y: cy };

        const val = HoCMath.matrixElementOrDefault(matrix, cx, cy, 0);
        if (val === ObstacleType.BLOCK || val === ObstacleType.HOLE || val === ObstacleType.LAVA) {
            continue;
        }
        if (val === enemyTeam) {
            continue;
        }

        const threats = countMeleeThreatsToCell(candidateCell, matrix, enemyTeam);
        const distToPreferred = HoCMath.getDistance(candidateCell, preferredCell);
        if (threats < safestThreats || (threats === safestThreats && distToPreferred < safestDist)) {
            safestThreats = threats;
            safestDist = distToPreferred;
            safestCell = candidateCell;
        }
    }

    return safestCell;
}

/**
 * How many relevant targets — allies for buff auras, enemies for debuff auras — a unit would cover with
 * its emitted auras if it stood at `fromCell`. Each aura counts its own targets, so a unit with two
 * buff auras that both reach an ally scores that ally twice; that's fine for relative comparison between
 * candidate cells. Large units are approximated as emitting from their base cell.
 */
export function auraCoverageScore(
    unit: Unit,
    fromCell: HoCMath.XY,
    gridSettings: GridSettings,
    unitsHolder: UnitsHolder,
): number {
    const auras = unit.getAuraEffects();
    if (!auras.length) {
        return 0;
    }
    const allies = unitsHolder.getAllAllies(unit.getTeam()).filter((u) => !u.isDead() && u.getId() !== unit.getId());
    const enemies = unitsHolder.getAllEnemyUnits(unit.getTeam()).filter((u) => !u.isDead());
    const teamAuraBonus = FightStateManager.getInstance()
        .getFightProperties()
        .getAdditionalAuraRangePerTeam(unit.getTeam());

    let score = 0;
    for (const aura of auras) {
        const range = aura.getRange() + teamAuraBonus;
        if (range < 0) {
            continue;
        }
        const cellKeys = new Set<number>();
        for (const c of EffectHelper.getAuraCells(gridSettings, fromCell, range)) {
            cellKeys.add((c.x << 4) | c.y);
        }
        const targets = aura.getProperties().is_buff ? allies : enemies;
        for (const t of targets) {
            const bc = t.getBaseCell();
            if (cellKeys.has((bc.x << 4) | bc.y)) {
                score += 1;
            }
        }
    }
    return score;
}

export interface IAuraMovePlan {
    // Reachable cell that maximizes aura coverage (may equal the unit's current cell).
    bestCell: HoCMath.XY;
    // Coverage from bestCell, and from where the unit currently stands.
    bestScore: number;
    currentScore: number;
    // Theoretical max coverage (every relevant target inside every relevant aura) — lets callers tell
    // "everyone reachable is already covered" from "some targets are still out of range".
    coverableTargets: number;
    // Melee threats adjacent to the current cell (so a caller won't sit still / hourglass into danger).
    currentThreats: number;
}

/**
 * Plan an aura-bearer's positioning: among the cells it can reach, the one that keeps the most allies
 * (buff auras) / enemies (debuff auras) inside its auras. Returns undefined when the unit emits no
 * auras. Callers use it to (a) move onto bestCell when it beats the current spot, or (b) hourglass to
 * reposition later in the round when no move helps yet but targets remain out of reach.
 */
export function planAuraMove(
    unit: Unit,
    knownPaths: Map<number, IWeightedRoute[]> | undefined,
    gridSettings: GridSettings,
    matrix: number[][],
    unitsHolder: UnitsHolder,
): IAuraMovePlan | undefined {
    const auras = unit.getAuraEffects();
    if (!auras.length) {
        return undefined;
    }
    const enemyTeam = unit.getOppositeTeam();
    const baseCell = unit.getBaseCell();
    const currentScore = auraCoverageScore(unit, baseCell, gridSettings, unitsHolder);

    const aliveAllies = unitsHolder
        .getAllAllies(unit.getTeam())
        .filter((u) => !u.isDead() && u.getId() !== unit.getId()).length;
    const aliveEnemies = unitsHolder.getAllEnemyUnits(unit.getTeam()).filter((u) => !u.isDead()).length;
    let coverableTargets = 0;
    for (const aura of auras) {
        coverableTargets += aura.getProperties().is_buff ? aliveAllies : aliveEnemies;
    }

    let bestCell = baseCell;
    let bestScore = currentScore;
    if (knownPaths) {
        for (const [key] of knownPaths) {
            const cx = (key >> 4) & 0xf;
            const cy = key & 0xf;
            const val = HoCMath.matrixElementOrDefault(matrix, cx, cy, 0);
            if (
                val === ObstacleType.BLOCK ||
                val === ObstacleType.HOLE ||
                val === ObstacleType.LAVA ||
                val === enemyTeam
            ) {
                continue;
            }
            const cell = { x: cx, y: cy };
            const score = auraCoverageScore(unit, cell, gridSettings, unitsHolder);
            // Higher coverage wins; on a tie prefer staying closer to the current cell (less exposure).
            if (
                score > bestScore ||
                (score === bestScore && HoCMath.getDistance(cell, baseCell) < HoCMath.getDistance(bestCell, baseCell))
            ) {
                bestScore = score;
                bestCell = cell;
            }
        }
    }

    return {
        bestCell,
        bestScore,
        currentScore,
        coverableTargets,
        currentThreats: countMeleeThreatsToCell(baseCell, matrix, enemyTeam),
    };
}

/**
 * Calculate the target to attack and the operation,
 * Use infinite path first, if it is not avaiable then use actual path
 * @param unit
 * @param unitsHolder
 * @param grid
 * @param matrix
 * @param pathHelper
 * @param debug
 * @returns the action
 */
function doFindTarget(
    unit: IUnitAIRepr,
    unitsHolder: UnitsHolder,
    grid: Grid,
    matrix: number[][],
    pathHelper: PathHelper,
    debug: boolean,
): BasicAIAction | undefined {
    const unitCell = unit.getBaseCell();
    const numRows = matrix.length;
    const numCols = matrix[0].length;
    if (numRows !== numCols) {
        return undefined;
    }
    // closest enemy unit
    let closestTarget: HoCMath.XY | undefined;
    let closestTargetDistance = Infinity;
    let cellsByDepthFromTarget: HoCMath.XY[][];
    let resultRoute: IWeightedRoute | undefined;
    let resultRouteIndex: number | undefined;
    let resultMovementDistance: number = Infinity;
    let resultDistanceLeftToTarget: number = Infinity;
    let resultDepthFromTarget: number = Infinity;
    let usedInfinitPath: boolean = true;

    // if not range or spell type then add BFS, similar is in pathhelper
    // get the cell to go or cell to go and target to attack
    // to see grid use grid.print(unit.getId());

    const max_steps = 100; // unit.steps
    const infiniteMovePath = pathHelper.getMovePath(
        unitCell,
        matrix,
        max_steps + unit.getSteps(),
        grid.getAggrMatrixByTeam(
            unit.getTeam() === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER,
        ),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );

    const actualMovePath = pathHelper.getMovePath(
        unitCell,
        matrix,
        unit.getSteps(),
        grid.getAggrMatrixByTeam(
            unit.getTeam() === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER,
        ),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    );

    let movePath = infiniteMovePath;

    if (debug) {
        console.log("just for debug: " + actualMovePath.knownPaths.size + " " + infiniteMovePath.knownPaths.size);
        grid.print(unit.getId());
    }

    /*
    Note:
    any big unit in matrix occupies 4 cells, the current unit is provided by upper right cell:
    3 ---- 0 0 0 0 0 0 0
    2 ---- 0 2 2 0 0 - x
    1 ---- 0 2 2 0 0 - -
    0 ---- 0 0 0 0 0 0 0
    ^      | | | | | | |
    |      | | | | | | |
    y/x->  0 1 2 3 4 5 6
    */
    if (debug) {
        console.log("currentUnit is at: " + cellToString(unitCell));
    }
    // go through every cell and check is it an enemy
    const pickTargetByActualPath = (): BasicAIAction | undefined => {
        if (debug) {
            console.log("Checking actual path");
        }
        movePath = actualMovePath;
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const element = HoCMath.matrixElementOrDefault(matrix, x, y, 0);
                if (element !== unit.getTeam() && element !== 0) {
                    if (
                        element === ObstacleType.BLOCK ||
                        element === ObstacleType.HOLE ||
                        element === ObstacleType.WATER ||
                        element === ObstacleType.LAVA
                    ) {
                        continue;
                    }

                    const occupantUnitId = grid.getOccupantUnitId({ x: x, y: y });
                    if (!occupantUnitId) {
                        continue;
                    }

                    // A Disguise-Aura unit with the "Hidden" buff is UNTARGETABLE — the engine rejects any
                    // melee/move+melee strike against it (attack_not_available). The candidate-pool filter
                    // above only guards the random fallback; this matrix scan picks enemy cells straight off
                    // the grid, so skip Hidden occupants here too or the AI keeps proposing doomed melees.
                    if (unitsHolder.getAllUnits().get(occupantUnitId)?.hasBuffActive?.("Hidden")) {
                        continue;
                    }

                    if (debug) {
                        console.log("Checking unit at cell: " + cellToString({ x: x, y: y }));
                    }

                    // get the list of cells that atacker can go to in order to attack the unit, return the layers, i.e bfs cells
                    cellsByDepthFromTarget = getLayersForAttacker_2(
                        { x: x, y: y },
                        matrix,
                        unit,
                        unit.isSmallSize(),
                        true,
                    );
                    if (debug) {
                        console.log(getLayersForAttacker({ x: x, y: y }, matrix, unit, unit.isSmallSize(), true));
                    }
                    // go through all cells in a layer, check the actual min distance for attcker unit and save
                    for (let depth = 0; depth < cellsByDepthFromTarget.length; depth++) {
                        if (debug) {
                            let cellsStr = "";
                            cellsByDepthFromTarget[depth].forEach(
                                (cell) => (cellsStr = cellsStr + " [" + cellToString(cell) + "]"),
                            );
                            console.log("checking layer cellsToMoveTo:" + cellsStr);
                        }
                        // let layerRouteIndiciesLeft: number = Infinity;
                        for (const layerCell of cellsByDepthFromTarget[depth]) {
                            const { knownPaths } = movePath;

                            if (depth === 0 && cellKey(layerCell) === cellKey(unitCell)) {
                                const occupantUnitId = grid.getOccupantUnitId({ x: x, y: y });
                                if (occupantUnitId) {
                                    previousTargets.set(unit.getId(), occupantUnitId);
                                }
                                return new BasicAIAction(
                                    AIActionType.MELEE_ATTACK,
                                    unitCell,
                                    { x: x, y: y },
                                    knownPaths,
                                );
                            }

                            const cellK = cellKey(layerCell);

                            if (!knownPaths.has(cellK)) {
                                if (debug) {
                                    console.log("No known path to layerCell:" + cellToString(layerCell));
                                }
                            } else {
                                if (debug) {
                                    console.log("Check path to layerCell:" + cellToString(layerCell));
                                }
                            }
                            const tmpRoute = knownPaths.get(cellK);
                            if (!tmpRoute) {
                                continue;
                            }

                            if (debug) {
                                console.log(
                                    "for the target cell " +
                                        cellToString({ x: x, y: y }) +
                                        " with mote to cell: " +
                                        cellToString(layerCell) +
                                        " avaiable routs: " +
                                        tmpRoute?.length,
                                );
                            }
                            // for (const currentRoute of tmpRoute) {
                            let currentRoute = tmpRoute?.at(0);

                            if (!currentRoute) {
                                continue;
                            }
                            if (debug) {
                                let routeStr = "";
                                currentRoute?.route.forEach(
                                    (cell: HoCMath.XY | undefined) =>
                                        (routeStr = routeStr + " [" + cellToString(cell) + "]"),
                                );
                                console.log("Checking route=" + routeStr);
                            }

                            let cellToMoveTo = layerCell;
                            let movementDistance = movePath.knownPaths?.get(cellKey(cellToMoveTo))?.at(0)?.weight;

                            let distanceLeftToTarget = HoCMath.getDistance(cellToMoveTo, { x: x, y: y });

                            if (debug) {
                                console.log(
                                    "Cell to move: " +
                                        cellToString(cellToMoveTo) +
                                        " elementNeighbor: " +
                                        cellToString(layerCell) +
                                        " distance to target: " +
                                        distanceLeftToTarget,
                                );
                            }

                            if (!movementDistance) {
                                if (debug) {
                                    console.log("skip cell: " + cellToString({ x: x, y: y }));
                                }
                                continue;
                            }
                            // if same indicies left till the target but clooser then prev cell then update the route and the cell to move to
                            if (
                                resultDepthFromTarget > depth || //&& distanceLeftToTarget < resultDistanceLeftToTarget) ||
                                (resultDepthFromTarget === depth &&
                                    (distanceLeftToTarget < resultDistanceLeftToTarget ||
                                        (distanceLeftToTarget === resultDistanceLeftToTarget &&
                                            movementDistance < resultMovementDistance)))
                            ) {
                                resultRoute = currentRoute;
                                resultMovementDistance = movementDistance;
                                resultDistanceLeftToTarget = distanceLeftToTarget;
                                resultDepthFromTarget = depth;
                                closestTarget = { x: x, y: y };
                                if (debug) {
                                    console.log("Set new cell to move to :" + cellToString(cellToMoveTo));
                                }
                            }
                        }
                    }
                }
            }
        }
        return undefined;
    };

    const pickTargetByInfinitPath = (): BasicAIAction | undefined => {
        if (debug) {
            console.log("Checking infinite path");
        }
        movePath = infiniteMovePath;
        for (let y = 0; y < numRows; y++) {
            for (let x = 0; x < numCols; x++) {
                const element = HoCMath.matrixElementOrDefault(matrix, x, y, 0);
                if (element !== unit.getTeam() && element !== 0) {
                    if (
                        element === ObstacleType.BLOCK ||
                        element === ObstacleType.HOLE ||
                        element === ObstacleType.WATER ||
                        element === ObstacleType.LAVA
                    ) {
                        continue;
                    }

                    const occupantUnitId = grid.getOccupantUnitId({ x: x, y: y });
                    if (!occupantUnitId) {
                        continue;
                    }

                    // Hidden (Disguise Aura) units are untargetable — skip so the AI never proposes a melee
                    // the engine rejects as attack_not_available (this scan reads enemy cells off the grid,
                    // bypassing the candidate-pool Hidden filter).
                    if (unitsHolder.getAllUnits().get(occupantUnitId)?.hasBuffActive?.("Hidden")) {
                        continue;
                    }

                    // get the list of cells that atacker can go to in order to attack the unit, return the layers, i.e bfs cells
                    cellsByDepthFromTarget = getLayersForAttacker_2(
                        { x: x, y: y },
                        matrix,
                        unit,
                        unit.isSmallSize(),
                        true,
                    );
                    // go through all cells in a layer, check the actual min distance for attcker unit and save
                    for (let depth = 0; depth < cellsByDepthFromTarget.length; depth++) {
                        if (debug) {
                            let cellsStr = "";
                            cellsByDepthFromTarget[depth].forEach(
                                (cell) => (cellsStr = cellsStr + " [" + cellToString(cell) + "]"),
                            );
                            console.log("checking layer cellsToMoveTo:" + cellsStr);
                        }
                        let layerRouteIndiciesLeft: number = Infinity;
                        for (const layerCell of cellsByDepthFromTarget[depth]) {
                            const { knownPaths } = movePath;

                            if (depth === 0 && cellKey(layerCell) === cellKey(unitCell)) {
                                const occupantUnitId = grid.getOccupantUnitId({ x: x, y: y });
                                if (occupantUnitId) {
                                    previousTargets.set(unit.getId(), occupantUnitId);
                                }
                                return new BasicAIAction(
                                    AIActionType.MELEE_ATTACK,
                                    unitCell,
                                    { x: x, y: y },
                                    knownPaths,
                                );
                            }

                            const cellK = cellKey(layerCell);

                            if (knownPaths.has(cellK)) {
                                const tmpRoute = knownPaths.get(cellK);
                                const weight = tmpRoute?.at(0)?.weight;
                                if (weight === undefined) {
                                    continue;
                                }
                                if (weight < closestTargetDistance) {
                                    if (debug) {
                                        console.log(
                                            "New min distance: " + weight + " layerCell:" + cellToString(layerCell),
                                        );
                                    }
                                    closestTargetDistance = weight;
                                    closestTarget = { x: x, y: y };
                                    let currentRoute = tmpRoute?.at(0);

                                    if (!currentRoute) {
                                        continue;
                                    }

                                    if (debug) {
                                        let routeStr = "";
                                        currentRoute?.route.forEach(
                                            (cell: HoCMath.XY | undefined) =>
                                                (routeStr = routeStr + " [" + cellToString(cell) + "]"),
                                        );
                                        console.log("Checking route=" + routeStr);
                                    }

                                    /**
                                     * Use "paths" to go through the board and calculate the end cell
                                     * since the "paths" take into account aggro board
                                     */
                                    let currentRouteIndex = 0;
                                    let nextCellDistance: number | undefined;
                                    do {
                                        const cell = currentRoute.route[currentRouteIndex];
                                        const nextCell = currentRoute.route[currentRouteIndex + 1];
                                        if (nextCell === undefined) {
                                            break;
                                        }
                                        if (isSameCell(cell, layerCell)) {
                                            break;
                                        }
                                        nextCellDistance = movePath.knownPaths?.get(cellKey(nextCell))?.at(0)?.weight;

                                        if (debug) {
                                            console.log("nextCellDistance: " + nextCellDistance);
                                        }
                                        if (nextCellDistance !== undefined && nextCellDistance > unit.getSteps()) {
                                            break;
                                        }
                                        currentRouteIndex += 1;
                                    } while (
                                        nextCellDistance !== undefined &&
                                        nextCellDistance <= unit.getSteps() &&
                                        currentRouteIndex < currentRoute.route.length
                                    );

                                    if (debug) {
                                        console.log("Set currentRouteIndex: " + currentRouteIndex);
                                    }

                                    while (currentRouteIndex >= 0) {
                                        const cellToGo = currentRoute?.route[currentRouteIndex];
                                        if (cellToGo) {
                                            if (unit.isSmallSize()) {
                                                if (!isFree(cellToGo, matrix, unit)) {
                                                    currentRouteIndex--;
                                                } else {
                                                    break;
                                                }
                                            } else if (
                                                !isFree(cellToGo, matrix, unit) ||
                                                !isFree({ x: cellToGo.x - 1, y: cellToGo.y }, matrix, unit) ||
                                                !isFree({ x: cellToGo.x - 1, y: cellToGo.y - 1 }, matrix, unit) ||
                                                !isFree({ x: cellToGo.x, y: cellToGo.y - 1 }, matrix, unit)
                                            ) {
                                                currentRouteIndex--;
                                            } else {
                                                break;
                                            }
                                        } else {
                                            break;
                                        }
                                    }
                                    let currentRouteIndiciesLeft = currentRoute.route.length - 1 - currentRouteIndex;
                                    let cellToMoveTo = currentRoute.route[currentRouteIndex];
                                    let currentDistance = movePath.knownPaths
                                        ?.get(cellKey(cellToMoveTo))
                                        ?.at(0)?.weight;
                                    if (debug) {
                                        console.log(
                                            "Cell to move :" +
                                                cellToString(cellToMoveTo) +
                                                " elementNeighbor:" +
                                                cellToString(layerCell),
                                        );
                                    }

                                    if (!currentDistance) {
                                        continue;
                                    }
                                    // if same indicies left till the target but clooser then prev cell then update the route and hte cell to move to
                                    if (
                                        currentRouteIndiciesLeft < layerRouteIndiciesLeft ||
                                        (currentRouteIndiciesLeft === layerRouteIndiciesLeft &&
                                            currentDistance < resultMovementDistance)
                                    ) {
                                        resultRoute = currentRoute;
                                        resultRouteIndex = currentRouteIndex;
                                        resultMovementDistance = currentDistance;
                                        layerRouteIndiciesLeft = currentRouteIndiciesLeft;
                                        if (debug) {
                                            console.log("Set new resultMovementDistance:" + resultMovementDistance);
                                        }
                                    }
                                }
                            } else {
                                if (debug) {
                                    console.log("No known path to layerCell:" + cellToString(layerCell));
                                }
                            }
                        }
                        // in current layer we found a cell to go to, use it
                        if (resultMovementDistance) {
                            break;
                        }
                    }
                }
            }
        }

        return undefined;
    };

    let actionDetermined = pickTargetByInfinitPath();
    if (actionDetermined) {
        return actionDetermined;
    }
    // if we can not move entire route with the infinite path then fallback to real one
    if (!resultRoute || resultRoute?.route.length - 1 !== resultRouteIndex) {
        actionDetermined = pickTargetByActualPath();
        usedInfinitPath = false;
        if (actionDetermined) {
            if (
                unit.hasAbilityActive("No Melee") &&
                (actionDetermined.actionType() === AIActionType.MELEE_ATTACK ||
                    actionDetermined.actionType() === AIActionType.MOVE_AND_MELEE_ATTACK)
            ) {
                // No-Melee ranged units (e.g. Tsar Cannon) cannot perform the melee strike this
                // actual-path target would queue. Reposition toward it instead of returning an
                // impossible melee (mirrors the closest-target No-Melee guard below).
                return new BasicAIAction(
                    AIActionType.MOVE,
                    actionDetermined.cellToMove(),
                    undefined,
                    actionDetermined.currentActiveKnownPaths(),
                );
            }
            return actionDetermined;
        }
    }

    if (debug) {
        console.log("СlosestTarget:" + cellToString(closestTarget));
    }

    if (closestTarget === undefined) {
        return undefined;
    }

    if (unit.getAttackType() === PBTypes.AttackVals.RANGE && unit.hasAbilityActive("No Melee")) {
        // No-Melee ranged units (e.g. Tsar Cannon) cannot perform the melee attack that
        // MOVE_AND_MELEE_ATTACK would queue. Replace it with a plain MOVE so they reposition
        // toward the target instead of attempting an impossible melee.
        const occupantUnitId = grid.getOccupantUnitId({ x: closestTarget.x, y: closestTarget.y });
        if (occupantUnitId) {
            previousTargets.set(unit.getId(), occupantUnitId);
        }
        return new BasicAIAction(
            AIActionType.MOVE,
            resultRoute?.route[resultRoute?.route.length - 1],
            undefined,
            movePath.knownPaths,
        );
    }

    if (resultRouteIndex === 0) {
        const occupantUnitId = grid.getOccupantUnitId({ x: closestTarget.x, y: closestTarget.y });
        if (occupantUnitId) {
            previousTargets.set(unit.getId(), occupantUnitId);
        }
        return new BasicAIAction(
            AIActionType.MELEE_ATTACK,
            resultRoute?.route[resultRoute?.route.length - 1],
            closestTarget,
            movePath.knownPaths,
        );
    }

    if (debug) {
        console.log(
            "usedInfinitPath=" +
                usedInfinitPath +
                ", closestTargetDistance=" +
                closestTargetDistance +
                ", unit.steps=" +
                unit.getSteps() +
                ", routeIndex=" +
                resultRouteIndex,
        );
        let routeStr = "";
        resultRoute?.route.forEach(
            (cell: HoCMath.XY | undefined) => (routeStr = routeStr + " [" + cellToString(cell) + "]"),
        );
        console.log("Route=" + routeStr);
    }
    if (
        (!usedInfinitPath && resultDepthFromTarget === 0) ||
        (usedInfinitPath && resultRoute && resultRoute?.route.length - 1 === resultRouteIndex)
    ) {
        const occupantUnitId = grid.getOccupantUnitId({ x: closestTarget.x, y: closestTarget.y });
        if (occupantUnitId) {
            previousTargets.set(unit.getId(), occupantUnitId);
        }
        return new BasicAIAction(
            AIActionType.MOVE_AND_MELEE_ATTACK,
            resultRoute?.route[resultRoute?.route.length - 1],
            closestTarget,
            movePath.knownPaths,
        );
    }
    let toMoveTo = resultRoute?.route[resultRoute?.route.length - 1];
    if (debug) {
        console.log("action MOVE with cell to move to x:" + toMoveTo?.x + " t:" + toMoveTo?.y);
    }
    previousTargets.delete(unit.getId());

    return new BasicAIAction(
        AIActionType.MOVE,
        resultRoute?.route[resultRoute?.route.length - 1],
        undefined,
        movePath.knownPaths,
    );
}

function cellKey(xy: HoCMath.XY): number {
    return (xy.x << 4) | xy.y;
}

/*
find cells for the given cell that attacker can stand at

Current small
[0, 0, 0, 0, 0],
[0, 0, 2, 0, 0],
[0, 0, 0, 0, 0],
[0, 0, 0, 0, 0],
[0, 0, 0, 0, 0],

Current small, Attacker Big
[0, 0, 0, 0, 0],
[0, x, x, x, x],
[0, x, 0, 0, x],
[0, x, 2, 0, x],
[0, x, 0, 0, x],

Current big
[0, 0, 0, 0, 0],
[0, 0, 0, 0, 0],
[0, -, 2, 0, 0],
[0, -, -, 0, 0],
[0, 0, 0, 0, 0],

Current big, Attacker Big
[x, x, x, x, x],
[x, 0, 0, 0, x],
[x, 2, 2, 0, x],
[x, 2, 2, 0, x],
[x, 0, 0, 0, x],
*/
export function getCellsForAttacker(
    cellToAttack: HoCMath.XY,
    matrix: number[][],
    attacker: IUnitAIRepr,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): HoCMath.XY[] {
    const borderCells = filterCells(
        getBorderCells(cellToAttack, isCurrentUnitSmall),
        matrix,
        isCurrentUnitSmall,
        attacker,
    );
    if (isTargetUnitSmall) {
        return borderCells;
    }
    const cellsForBigAttacker: HoCMath.XY[] = [];
    for (const borderCell of borderCells) {
        if (borderCell.x <= cellToAttack.x && borderCell.y <= cellToAttack.y) {
            cellsForBigAttacker.push(borderCell);
        } else if (
            borderCell.x === cellToAttack.x + 1 &&
            borderCell.y === cellToAttack.y - (isCurrentUnitSmall ? 1 : 2)
        ) {
            cellsForBigAttacker.push(borderCell);
            cellsForBigAttacker.push({ x: borderCell.x + 1, y: borderCell.y });
        } else if (borderCell.x === cellToAttack.x + 1 && borderCell.y === cellToAttack.y + 1) {
            cellsForBigAttacker.push({ x: borderCell.x + 1, y: borderCell.y });
            cellsForBigAttacker.push({ x: borderCell.x + 1, y: borderCell.y + 1 });
            cellsForBigAttacker.push({ x: borderCell.x, y: borderCell.y + 1 });
        } else if (borderCell.x === cellToAttack.x + 1) {
            cellsForBigAttacker.push({ x: borderCell.x + 1, y: borderCell.y });
        } else if (
            borderCell.x === cellToAttack.x - (isCurrentUnitSmall ? 1 : 2) &&
            borderCell.y === cellToAttack.y + 1
        ) {
            cellsForBigAttacker.push({ x: borderCell.x, y: borderCell.y });
            cellsForBigAttacker.push({ x: borderCell.x, y: borderCell.y + 1 });
        } else if (borderCell.y === cellToAttack.y + 1) {
            cellsForBigAttacker.push({ x: borderCell.x, y: borderCell.y + 1 });
        }
    }
    return filterCells(cellsForBigAttacker, matrix, false, attacker);
}

function getLayersForAttacker_2(
    cellToAttack: HoCMath.XY,
    matrix: number[][],
    attacker: IUnitAIRepr,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): HoCMath.XY[][] {
    const result: HoCMath.XY[][] = [];
    for (let i = 1; i < matrix.length / 2; i++) {
        const borderCells = filterCells(
            getBorderCells_2(cellToAttack, isCurrentUnitSmall, i),
            matrix,
            isCurrentUnitSmall,
            attacker,
        );
        result[i - 1] = borderCells;
    }
    if (isTargetUnitSmall) {
        return result;
    } else {
        return [];
    }
}

function getBorderCells_2(currentCell: HoCMath.XY, isSmallUnit = true, distance = 1): HoCMath.XY[] {
    /*
    distance 1, current small:
    0 0 0 0 0 0 0
    0 0 0 0 0 0 0
    0 x x x 0 0 0
    0 x c x 0 0 0
    0 x x x 0 0 0
    distance 1, current big:
    0 0 0 0 0 0 0
    0 x x x x 0 0
    0 x 0 0 x 0 0
    0 x c 0 x 0 0
    0 x x x x 0 0
    distance 2, current small:
    0 0 0 0 0 0 0 0
    x x x x x 0 0 0
    x 0 0 0 x 0 0 0
    x 0 c 0 x 0 0 0
    x 0 0 0 x 0 0 0
    x x x x x 0 0 0
    distance 2, current big:
    x x x x x x 0 0
    x 0 0 0 0 x 0 0
    x 0 0 0 0 x 0 0
    x 0 c 0 0 x 0 0
    x 0 0 0 0 x 0 0
    x x x x x x 0 0
    */
    // we might add same cell few times but it is set so who cares
    const borderCells = new Set<HoCMath.XY>();
    // bottom line
    for (let i = 0; i < distance * 2 + 1; i++) {
        borderCells.add({ x: currentCell.x - distance + i, y: currentCell.y - distance });
    }
    // top line
    for (let i = 0; i < distance * 2 + 1; i++) {
        borderCells.add({ x: currentCell.x - distance + i, y: currentCell.y + distance + (isSmallUnit ? 0 : 1) });
    }
    // left line
    for (let i = 0; i < distance /*- 1*/ * 2 + 1; i++) {
        borderCells.add({ x: currentCell.x - distance, y: currentCell.y - distance + i });
    }
    // right line
    for (let i = 0; i < distance /*- 1*/ * 2 + 1; i++) {
        borderCells.add({ x: currentCell.x + distance + (isSmallUnit ? 0 : 1), y: currentCell.y - distance + i });
    }
    if (!isSmallUnit) {
        borderCells.add({ x: currentCell.x + distance + 1, y: currentCell.y + distance + 1 });
    }
    return Array.from(borderCells);
}

//return cells by distance from the cell to attack
function getLayersForAttacker(
    cellToAttack: HoCMath.XY,
    matrix: number[][],
    attacker: IUnitAIRepr,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): HoCMath.XY[][] {
    const result: HoCMath.XY[][] = [];
    for (let i = 1; i < matrix.length / 2; i++) {
        const borderCells = filterCells(
            getBorderCells(cellToAttack, isCurrentUnitSmall, i),
            matrix,
            isCurrentUnitSmall,
            attacker,
        );
        result[i - 1] = borderCells;
    }
    if (isTargetUnitSmall) {
        return result;
    } else {
        return [];
    }
}

// return border cells that the small or big unit has
function getBorderCells(currentCell: HoCMath.XY, isSmallUnit = true, distance = 1): HoCMath.XY[] {
    const borderCells = [];
    borderCells.push({ x: currentCell.x - distance, y: currentCell.y + distance });
    borderCells.push({ x: currentCell.x - distance, y: currentCell.y });
    borderCells.push({ x: currentCell.x - distance, y: currentCell.y - distance });
    borderCells.push({ x: currentCell.x, y: currentCell.y - distance });
    borderCells.push({ x: currentCell.x + distance, y: currentCell.y - distance });
    if (isSmallUnit) {
        borderCells.push({ x: currentCell.x + distance, y: currentCell.y });
        borderCells.push({ x: currentCell.x + distance, y: currentCell.y + distance });
        borderCells.push({ x: currentCell.x, y: currentCell.y + distance });
    } else {
        /*
        // big attacker, small target
        // possible cells that big attacker can be palces at (right up corner) to attack the cell
        0 0 0 0 0 0 0
        0 x x x x 0 0
        0 x 0 0 x 0 0
        0 x c 0 x 0 0
        0 x x x x 0 0
        */
        borderCells.push({ x: currentCell.x - distance, y: currentCell.y + distance + 1 });
        borderCells.push({ x: currentCell.x, y: currentCell.y + distance + 1 });
        borderCells.push({ x: currentCell.x + distance, y: currentCell.y + distance + 1 });
        borderCells.push({ x: currentCell.x + distance + 1, y: currentCell.y + distance + 1 });
        borderCells.push({ x: currentCell.x + distance + 1, y: currentCell.y + distance });
        borderCells.push({ x: currentCell.x + distance + 1, y: currentCell.y });
        borderCells.push({ x: currentCell.x + distance + 1, y: currentCell.y - distance });
    }
    return borderCells;
}

function filterCells(
    cells: HoCMath.XY[],
    matrix: number[][],
    isAttackerSmall = true,
    attacker: IUnitAIRepr,
): HoCMath.XY[] {
    const filtered = [];
    for (const cell of cells) {
        if (isFree(cell, matrix, attacker)) {
            if (isAttackerSmall) {
                filtered.push(cell);
            } else if (
                isFree({ x: cell.x - 1, y: cell.y }, matrix, attacker) &&
                isFree({ x: cell.x - 1, y: cell.y - 1 }, matrix, attacker) &&
                isFree({ x: cell.x, y: cell.y - 1 }, matrix, attacker)
            ) {
                filtered.push(cell);
            }
        }
    }
    return filtered;
}

function isFree(cell: HoCMath.XY, matrix: number[][], attacker: IUnitAIRepr): boolean {
    if (HoCMath.matrixElementOrDefault(matrix, cell.x, cell.y, 0) != 0) {
        for (const atCell of attacker.getCells()) {
            if (isSameCell(atCell, cell)) {
                return true;
            }
        }
        return false;
    }
    return cell.x >= 0 && cell.x < matrix[0].length && cell.y >= 0 && cell.y < matrix.length;
}

function isSameCell(first: HoCMath.XY, second: HoCMath.XY): boolean {
    return first.x === second.x && first.y === second.y;
}

function cellToString(cell: HoCMath.XY | undefined): string {
    if (cell === undefined) {
        return "undefined";
    } else {
        return "x:" + cell.x + " y:" + cell.y;
    }
}
