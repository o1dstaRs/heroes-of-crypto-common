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

import { ObstacleType } from "../obstacles/obstacle_type";
import { TeamType } from "../units/unit_properties";
import { getRandomInt, matrixElement, shuffle } from "../utils/lib";
import { getDistance, intersect2D, Intersect2DResult, IXYDistance, matrixElementOrDefault, XY } from "../utils/math";
import { GridSettings } from "./grid_settings";
import { IWeightedRoute } from "./path_definitions";

export function getCellForPosition(gridSettings: GridSettings, position: XY): XY {
    return {
        x: Math.floor((position.x + gridSettings.getMaxX()) / gridSettings.getCellSize()),
        y: Math.floor(position.y / gridSettings.getCellSize()),
    };
}

export function getCellsAroundCell(gridSettings: GridSettings, cell: XY): XY[] {
    const cells: XY[] = [];
    if (!cell) {
        return cells;
    }

    const cellPosition = getPositionForCell(
        cell,
        gridSettings.getMinX(),
        gridSettings.getStep(),
        gridSettings.getHalfStep(),
    );
    const cellPositionUpLeft = {
        x: cellPosition.x - gridSettings.getHalfStep(),
        y: cellPosition.y + gridSettings.getHalfStep(),
    };
    const cellPositionUpRight = {
        x: cellPosition.x + gridSettings.getHalfStep(),
        y: cellPosition.y + gridSettings.getHalfStep(),
    };
    const cellPositionDownLeft = {
        x: cellPosition.x - gridSettings.getHalfStep(),
        y: cellPosition.y - gridSettings.getHalfStep(),
    };
    const cellPositionDownRight = {
        x: cellPosition.x + gridSettings.getHalfStep(),
        y: cellPosition.y - gridSettings.getHalfStep(),
    };

    const initialCellKey = (cell.x << 4) | cell.y;
    const cellKeys: number[] = [initialCellKey];

    for (const cp of [cellPositionUpLeft, cellPositionUpRight, cellPositionDownLeft, cellPositionDownRight]) {
        const cellsAroundPosition = getCellsAroundPosition(gridSettings, cp);
        for (const c of cellsAroundPosition) {
            const cellKey = (c.x << 4) | c.y;
            if (!cellKeys.includes(cellKey)) {
                cellKeys.push(cellKey);
                cells.push(c);
            }
        }
    }

    return cells;
}

export function projectLineToFieldEdge(gridSettings: GridSettings, x0: number, y0: number, x1: number, y1: number): XY {
    // Calculate direction vector
    const dx = x1 - x0;
    const dy = y1 - y0;

    // Calculate the maximum scalar multiplier needed to reach the field edge
    const scalarX =
        dx !== 0 ? Math.max((gridSettings.getMinX() - x1) / dx, (gridSettings.getMaxX() - x1) / dx) : Infinity;
    const scalarY =
        dy !== 0 ? Math.max((gridSettings.getMinY() - y1) / dy, (gridSettings.getMaxY() - y1) / dy) : Infinity;

    // Use the smaller of the two scalars to ensure we stop at the first edge we hit
    const scalar = Math.min(scalarX, scalarY);

    // Calculate the new end point
    const x = x1 + dx * scalar;
    const y = y1 + dy * scalar;

    // Clamp values to ensure they're within the field
    return {
        x: Math.max(gridSettings.getMinX(), Math.min(gridSettings.getMaxX(), x)),
        y: Math.max(gridSettings.getMinY(), Math.min(gridSettings.getMaxY(), y)),
    };
}

export function getCellsAroundPosition(gridSettings: GridSettings, position: XY): XY[] {
    const cells: XY[] = [];
    if (!position) {
        return cells;
    }

    const canGoLeft = position.x > gridSettings.getMinX();
    const canGoRight = position.x < gridSettings.getMaxX();
    const canGoDown = position.y > gridSettings.getMinY();
    const canGoUp = position.y < gridSettings.getMaxY();

    if (canGoLeft && canGoUp) {
        const c = getCellForPosition(gridSettings, {
            x: position.x - gridSettings.getHalfStep(),
            y: position.y + gridSettings.getHalfStep(),
        });
        if (c) {
            cells.push(c);
        }
    }
    if (canGoRight && canGoUp) {
        const c = getCellForPosition(gridSettings, {
            x: position.x + gridSettings.getHalfStep(),
            y: position.y + gridSettings.getHalfStep(),
        });
        if (c) {
            cells.push(c);
        }
    }
    if (canGoDown && canGoLeft) {
        const c = getCellForPosition(gridSettings, {
            x: position.x - gridSettings.getHalfStep(),
            y: position.y - gridSettings.getHalfStep(),
        });
        if (c) {
            cells.push(c);
        }
    }
    if (canGoDown && canGoRight) {
        const c = getCellForPosition(gridSettings, {
            x: position.x + gridSettings.getHalfStep(),
            y: position.y - gridSettings.getHalfStep(),
        });
        if (c) {
            cells.push(c);
        }
    }

    return cells;
}

export function isPositionWithinGrid(gridSettings: GridSettings, position: XY): boolean {
    if (!position) {
        return false;
    }

    return (
        position.x >= gridSettings.getMinX() &&
        position.x < gridSettings.getMaxX() &&
        position.y >= gridSettings.getMinY() &&
        position.y < gridSettings.getMaxY()
    );
}

export function isCellWithinGrid(gridSettings: GridSettings, cell: XY): boolean {
    return cell.x >= 0 && cell.x < gridSettings.getGridSize() && cell.y >= 0 && cell.y < gridSettings.getGridSize();
}

export function hasXY(desired: XY, list?: XY[]): boolean {
    if (!list?.length) {
        return false;
    }

    for (const p of list) {
        if (p.x === desired.x && p.y === desired.y) {
            return true;
        }
    }

    return false;
}

export function getPositionForCell(cell: XY, minX: number, step: number, halfStep: number): XY {
    return { x: minX + (1 + cell.x) * step - halfStep, y: cell.y * step + halfStep };
}

export function getPositionForCells(gridSettings: GridSettings, cells: XY[]): XY | undefined {
    if (cells.length === 1) {
        return getPositionForCell(cells[0], gridSettings.getMinX(), gridSettings.getStep(), gridSettings.getHalfStep());
    }

    if (cells.length !== 4) {
        return undefined;
    }

    let xMin = Number.MAX_SAFE_INTEGER;
    let xMax = Number.MIN_SAFE_INTEGER;
    let yMin = Number.MAX_SAFE_INTEGER;
    let yMax = Number.MIN_SAFE_INTEGER;

    for (const c of cells) {
        xMin = Math.min(xMin, c.x);
        xMax = Math.max(xMax, c.x);
        yMin = Math.min(yMin, c.y);
        yMax = Math.max(yMax, c.y);
    }

    return getPositionForCell(
        { x: xMin + (xMax - xMin) / 2, y: yMin + (yMax - yMin) / 2 },
        gridSettings.getMinX(),
        gridSettings.getStep(),
        gridSettings.getHalfStep(),
    );
}

export function getRandomGridCellAroundPosition(
    gridSettings: GridSettings,
    gridMatrix: number[][],
    teamType: TeamType,
    position: XY,
): XY | undefined {
    const cell = getCellForPosition(gridSettings, position);
    if (!cell) {
        return undefined;
    }

    let proposedCells: XY[] = [];
    let hasHashes: number[] = [];

    if (teamType === TeamType.LOWER) {
        if (!matrixElementOrDefault(gridMatrix, cell.x, cell.y + 1, 0)) {
            proposedCells.push({ x: cell.x, y: cell.y + 1 });
            hasHashes.push((cell.x << 4) | (cell.y + 1));
        }
        if (getRandomInt(0, 2)) {
            if (!matrixElementOrDefault(gridMatrix, cell.x + 1, cell.y + 1, 0)) {
                proposedCells.push({ x: cell.x + 1, y: cell.y + 1 });
                hasHashes.push(((cell.x + 1) << 4) | (cell.y + 1));
                proposedCells.push({ x: cell.x - 1, y: cell.y + 1 });
                hasHashes.push(((cell.x - 1) << 4) | (cell.y + 1));
            }
        } else if (!matrixElementOrDefault(gridMatrix, cell.x - 1, cell.y + 1, 0)) {
            proposedCells.push({ x: cell.x - 1, y: cell.y + 1 });
            hasHashes.push(((cell.x - 1) << 4) | (cell.y + 1));
            proposedCells.push({ x: cell.x + 1, y: cell.y + 1 });
            hasHashes.push(((cell.x + 1) << 4) | (cell.y + 1));
        }
    } else if (teamType === TeamType.UPPER) {
        if (!matrixElementOrDefault(gridMatrix, cell.x, cell.y - 1, 0)) {
            proposedCells.push({ x: cell.x, y: cell.y - 1 });
            hasHashes.push((cell.x << 4) | (cell.y - 1));
        }
        if (getRandomInt(0, 2)) {
            if (!matrixElementOrDefault(gridMatrix, cell.x + 1, cell.y - 1, 0)) {
                proposedCells.push({ x: cell.x + 1, y: cell.y - 1 });
                hasHashes.push(((cell.x + 1) << 4) | (cell.y - 1));
                proposedCells.push({ x: cell.x - 1, y: cell.y - 1 });
                hasHashes.push(((cell.x - 1) << 4) | (cell.y - 1));
            }
        } else if (!matrixElementOrDefault(gridMatrix, cell.x - 1, cell.y - 1, 0)) {
            proposedCells.push({ x: cell.x - 1, y: cell.y - 1 });
            hasHashes.push(((cell.x - 1) << 4) | (cell.y - 1));
            proposedCells.push({ x: cell.x + 1, y: cell.y - 1 });
            hasHashes.push(((cell.x + 1) << 4) | (cell.y - 1));
        }
    }

    for (const pc of proposedCells) {
        if (isCellWithinGrid(gridSettings, pc)) {
            return pc;
        }
    }

    if (!proposedCells.length) {
        proposedCells = [
            { x: cell.x + 1, y: cell.y + 1 },
            { x: cell.x - 1, y: cell.y - 1 },
            { x: cell.x - 1, y: cell.y + 1 },
            { x: cell.x + 1, y: cell.y - 1 },
            { x: cell.x + 1, y: cell.y },
            { x: cell.x, y: cell.y + 1 },
            { x: cell.x - 1, y: cell.y },
            { x: cell.x, y: cell.y - 1 },
        ];
        shuffle(proposedCells);
    }

    for (const pc of proposedCells) {
        if (!matrixElementOrDefault(gridMatrix, pc.x, pc.y, 0) && isCellWithinGrid(gridSettings, pc)) {
            return pc;
        }
    }

    return undefined;
}

export function getLargeUnitAttackCells(
    gridSettings: GridSettings,
    attackFromCell: XY,
    attackerBodyCellTopRight: XY,
    enemyCell: XY,
    currentActiveKnownPaths?: Map<number, IWeightedRoute[]>,
    fromPathHashes?: Set<number>,
): XY[] {
    const attackCells: XY[] = [];

    if (!fromPathHashes?.size) {
        return attackCells;
    }

    const verifyAndPush = (cell: XY) => {
        const cellsToCheck: XY[] = [cell];
        const isSelfCell = cell.x === attackerBodyCellTopRight.x && cell.y === attackerBodyCellTopRight.y;
        if (!isSelfCell && !currentActiveKnownPaths?.has((cell.x << 4) | cell.y)) {
            return;
        }

        cellsToCheck.push({ x: cell.x - 1, y: cell.y });
        cellsToCheck.push({ x: cell.x - 1, y: cell.y - 1 });
        cellsToCheck.push({ x: cell.x, y: cell.y - 1 });

        let allCellsCompliant = true;
        for (const ctc of cellsToCheck) {
            if (ctc.x === enemyCell.x && ctc.y === enemyCell.y) {
                allCellsCompliant = false;
                break;
            }
            if (
                ctc.x < 0 ||
                ctc.x >= gridSettings.getGridSize() ||
                ctc.y < 0 ||
                ctc.y >= gridSettings.getGridSize() ||
                !fromPathHashes.has((ctc.x << 4) | ctc.y)
            ) {
                allCellsCompliant = false;
                break;
            }
        }
        if (allCellsCompliant) {
            attackCells.push(cell);
        }
    };

    if (attackFromCell.x < enemyCell.x && attackFromCell.y < enemyCell.y) {
        verifyAndPush(attackFromCell);
        verifyAndPush({ x: attackFromCell.x, y: attackFromCell.y + 1 });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y });
        return attackCells;
    }
    if (attackFromCell.x > enemyCell.x && attackFromCell.y > enemyCell.y) {
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y + 1 });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y });
        verifyAndPush({ x: attackFromCell.x, y: attackFromCell.y + 1 });
        return attackCells;
    }
    if (attackFromCell.x < enemyCell.x && attackFromCell.y > enemyCell.y) {
        verifyAndPush(attackFromCell);
        verifyAndPush({ x: attackFromCell.x, y: attackFromCell.y + 1 });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y + 1 });
        return attackCells;
    }
    if (attackFromCell.x > enemyCell.x && attackFromCell.y < enemyCell.y) {
        verifyAndPush(attackFromCell);
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y + 1 });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y });
        return attackCells;
    }

    if (attackFromCell.x < enemyCell.x) {
        verifyAndPush(attackFromCell);
        verifyAndPush({ x: attackFromCell.x, y: attackFromCell.y + 1 });
        return attackCells;
    }
    if (attackFromCell.y > enemyCell.y) {
        verifyAndPush({ x: attackFromCell.x, y: attackFromCell.y + 1 });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y + 1 });
        return attackCells;
    }
    if (attackFromCell.y < enemyCell.y) {
        verifyAndPush({ x: attackFromCell.x, y: attackFromCell.y });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y });
        return attackCells;
    }
    if (attackFromCell.x > enemyCell.x) {
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y });
        verifyAndPush({ x: attackFromCell.x + 1, y: attackFromCell.y + 1 });
        return attackCells;
    }
    return attackCells;
}

export function arePointsConnected(gridSettings: GridSettings, pointA: XY, pointB: XY): boolean {
    const xDiff = Math.abs(pointA.x - pointB.x);
    const yDiff = Math.abs(pointA.y - pointB.y);
    const xSame = xDiff <= gridSettings.getMovementDelta();
    const ySame = yDiff <= gridSettings.getMovementDelta();
    if (xSame) {
        if (yDiff <= gridSettings.getStep() + gridSettings.getMovementDelta()) {
            return true;
        }
    } else if (ySame) {
        if (xDiff <= gridSettings.getStep() + gridSettings.getMovementDelta()) {
            return true;
        }
    } else {
        return getDistance(pointA, pointB) <= gridSettings.getDiagonalStep() + gridSettings.getMovementDelta();
    }
    return false;
}

export function getClosestCrossingPoint(position: XY, crossingPoints: XY[]): XY | undefined {
    let currentClosestPoint;
    let currentClosestDistance = Number.MAX_SAFE_INTEGER;
    for (const point of crossingPoints) {
        if (point.x != null && point.y != null) {
            const pt = { x: point.x, y: point.y };
            const distance = getDistance(position, pt);
            if (distance < currentClosestDistance) {
                currentClosestDistance = distance;
                currentClosestPoint = pt;
            }
        }
    }

    return currentClosestPoint;
}

export function getCrossingPoints(
    fromPosition: XY,
    toPosition: XY,
    closestVerticalAndHorizontal: XY[],
): Intersect2DResult[] {
    const ret: Intersect2DResult[] = [];
    let idx = 0;
    while (idx < closestVerticalAndHorizontal.length) {
        const pointA = closestVerticalAndHorizontal[idx++];
        const pointB = closestVerticalAndHorizontal[idx++];
        ret.push(intersect2D(pointA, pointB, fromPosition, toPosition));
    }

    return ret;
}

export function getClosestVH(gridSettings: GridSettings, fromPosition: XY, toPosition: XY): XY[] {
    const step = gridSettings.getStep();

    const vh: XY[] = [];
    let diff = fromPosition.x - toPosition.x;
    if (diff) {
        let x: number;
        if (diff < 0) {
            x = 2 * step + Math.floor(fromPosition.x / step) * step;
            vh.push(
                {
                    x,
                    y: gridSettings.getMinY(),
                },
                {
                    x,
                    y: gridSettings.getMaxY(),
                },
            );
        } else if (diff > 0) {
            x = Math.floor(fromPosition.x / step) * step - step;
            vh.push(
                {
                    x,
                    y: gridSettings.getMinY(),
                },
                {
                    x,
                    y: gridSettings.getMaxY(),
                },
            );
        }
    }

    diff = fromPosition.y - toPosition.y;
    if (diff) {
        let y: number;
        if (diff < 0) {
            y = 2 * step + Math.floor(fromPosition.y / step) * step;
            vh.push(
                {
                    x: gridSettings.getMinX(),
                    y,
                },
                {
                    x: gridSettings.getMaxX(),
                    y,
                },
            );
        } else if (diff > 0) {
            y = Math.floor(fromPosition.y / step) * step - step;
            vh.push(
                {
                    x: gridSettings.getMinX(),
                    y,
                },
                {
                    x: gridSettings.getMaxX(),
                    y,
                },
            );
        }
    }

    return vh;
}

export function adjustClosestPointSideCenterPoint(point: XY, unitPosition: XY): XY {
    let newX = point.x;
    let newY = point.y;
    if (point.x < unitPosition.x) {
        newX -= 1;
    }
    if (point.y < unitPosition.y) {
        newY -= 1;
    }
    return { x: newX, y: newY };
}

export function getDistanceToFurthestCorner(position: XY, gridSettings: GridSettings): number {
    return Math.max(
        getDistance(position, { x: gridSettings.getMinX(), y: gridSettings.getMinY() }),
        getDistance(position, { x: gridSettings.getMinX(), y: gridSettings.getMaxY() }),
        getDistance(position, { x: gridSettings.getMaxX(), y: gridSettings.getMinY() }),
        getDistance(position, { x: gridSettings.getMaxX(), y: gridSettings.getMaxY() }),
    );
}

export function getClosestSideCenter(
    gridMatrix: number[][],
    gridSettings: GridSettings,
    mousePosition: XY,
    fromPosition: XY,
    toPosition: XY,
    isSmallUnitFrom: boolean,
    isSmallUnitTo: boolean,
    fromTeamType: TeamType,
    isThroughShot = false,
): XY | undefined {
    const cell = getCellForPosition(gridSettings, mousePosition);
    if (!cell) {
        return undefined;
    }
    const cellPosition = getPositionForCell(
        cell,
        gridSettings.getMinX(),
        gridSettings.getStep(),
        gridSettings.getHalfStep(),
    );

    const points: IXYDistance[] = [];

    const me1 = matrixElement(gridMatrix, cell.x - 1, cell.y);
    const me2 = matrixElement(gridMatrix, cell.x + 1, cell.y);
    const me3 = matrixElement(gridMatrix, cell.x, cell.y + 1);
    const me4 = matrixElement(gridMatrix, cell.x, cell.y - 1);
    let observableLeft: boolean;
    let observableRight: boolean;
    let observableUp: boolean;
    let observableDown: boolean;
    if (isThroughShot) {
        observableLeft = me1 !== ObstacleType.BLOCK;
        observableRight = me2 !== ObstacleType.BLOCK;
        observableUp = me3 !== ObstacleType.BLOCK;
        observableDown = me4 !== ObstacleType.BLOCK;
    } else {
        observableLeft = !me1 || me1 === fromTeamType || me1 === ObstacleType.LAVA || me1 === ObstacleType.WATER;
        observableRight = !me2 || me2 === fromTeamType || me2 === ObstacleType.LAVA || me2 === ObstacleType.WATER;
        observableUp = !me3 || me3 === fromTeamType || me3 === ObstacleType.LAVA || me3 === ObstacleType.WATER;
        observableDown = !me4 || me4 === fromTeamType || me4 === ObstacleType.LAVA || me4 === ObstacleType.WATER;
    }

    if (
        observableLeft &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.x === toPosition.x - gridSettings.getHalfStep()) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.x < toPosition.x) ||
            (isSmallUnitFrom &&
                !isSmallUnitTo &&
                fromPosition.x - gridSettings.getHalfStep() <
                    toPosition.x - (isSmallUnitTo ? gridSettings.getHalfStep() : gridSettings.getStep())))
    ) {
        points.push({
            xy: { x: cellPosition.x - gridSettings.getHalfStep(), y: cellPosition.y },
            distance: Number.MAX_VALUE,
        });
    }
    if (
        observableRight &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.x === toPosition.x + gridSettings.getHalfStep()) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.x > toPosition.x) ||
            (isSmallUnitFrom &&
                !isSmallUnitTo &&
                fromPosition.x + gridSettings.getHalfStep() >
                    toPosition.x + (isSmallUnitTo ? gridSettings.getHalfStep() : gridSettings.getStep())))
    ) {
        points.push({
            xy: { x: cellPosition.x + gridSettings.getHalfStep(), y: cellPosition.y },
            distance: Number.MAX_VALUE,
        });
    }
    if (
        observableDown &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.y === toPosition.y - gridSettings.getHalfStep()) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.y < toPosition.y) ||
            (isSmallUnitFrom &&
                !isSmallUnitTo &&
                fromPosition.y - gridSettings.getHalfStep() <
                    toPosition.y - (isSmallUnitTo ? gridSettings.getHalfStep() : gridSettings.getStep())))
    ) {
        points.push({
            xy: { x: cellPosition.x, y: cellPosition.y - gridSettings.getHalfStep() },
            distance: Number.MAX_VALUE,
        });
    }

    if (
        observableUp &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.y === toPosition.y + gridSettings.getHalfStep()) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.y > toPosition.y) ||
            (isSmallUnitFrom &&
                !isSmallUnitTo &&
                fromPosition.y + gridSettings.getHalfStep() >
                    toPosition.y + (isSmallUnitTo ? gridSettings.getHalfStep() : gridSettings.getStep())))
    ) {
        points.push({
            xy: { x: cellPosition.x, y: cellPosition.y + gridSettings.getHalfStep() },
            distance: Number.MAX_VALUE,
        });
    }

    for (const p of points) {
        p.distance = getDistance(fromPosition, p.xy);
    }

    points.sort((a: IXYDistance, b: IXYDistance) => {
        if (a.distance < b.distance) return -1;
        if (a.distance > b.distance) return 1;
        return 0;
    });

    const twoClosestPoints = points.slice(0, 2);
    shuffle(twoClosestPoints);
    if (!twoClosestPoints.length) {
        return undefined;
    }
    if (twoClosestPoints.length === 1 || !mousePosition) {
        return adjustClosestPointSideCenterPoint(twoClosestPoints[0].xy, fromPosition);
    }

    const distanceA = getDistance(twoClosestPoints[0].xy, mousePosition);
    const distanceB = getDistance(twoClosestPoints[1].xy, mousePosition);
    if (distanceA === distanceB || distanceA < distanceB) {
        return adjustClosestPointSideCenterPoint(twoClosestPoints[0].xy, fromPosition);
    }

    return adjustClosestPointSideCenterPoint(twoClosestPoints[1].xy, fromPosition);
}
