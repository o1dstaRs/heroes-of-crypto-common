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
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { getRandomInt, matrixElement, shuffle } from "../utils/lib";
import { getDistance, intersect2D, Intersect2DResult, matrixElementOrDefault, type XY } from "../utils/math";
import { GridSettings } from "./grid_settings";
import type { IWeightedRoute } from "./path_definitions";

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

/**
 * Every cell touching a unit's whole FOOTPRINT, with the footprint itself removed.
 *
 * getCellsAroundCell rings ONE cell, which is right for a 1x1 creature and wrong for a 2x2 one: ringing only
 * its base cell both misses half the block's real neighbours and returns three cells the creature itself
 * stands on. Unioning the per-cell rings and then subtracting the footprint gives the shape that actually
 * hugs the creature — the 8 cells around a small unit, the 12 around a large one.
 */
export function getCellsAroundFootprint(gridSettings: GridSettings, footprint: readonly XY[]): XY[] {
    // Same packed key the ring helper above uses.
    const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;
    const occupied = new Set<number>();
    for (const cell of footprint) {
        if (cell) {
            occupied.add(cellKey(cell));
        }
    }

    const ring: XY[] = [];
    const seen = new Set<number>();
    for (const cell of footprint) {
        if (!cell) {
            continue;
        }
        for (const around of getCellsAroundCell(gridSettings, cell)) {
            const key = cellKey(around);
            if (occupied.has(key) || seen.has(key)) {
                continue;
            }
            seen.add(key);
            ring.push(around);
        }
    }

    return ring;
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

    // This routine sits beneath both Unit.getCells and adjacent-cell evaluation, so avoid constructing four
    // temporary world positions only to immediately map them back to cells. The scalar formulas below are the
    // exact getCellForPosition transform and still return fresh caller-owned cell objects in legacy order.
    const minX = gridSettings.getMinX();
    const maxX = gridSettings.getMaxX();
    const minY = gridSettings.getMinY();
    const maxY = gridSettings.getMaxY();
    const halfStep = gridSettings.getHalfStep();
    const cellSize = gridSettings.getCellSize();
    const canGoLeft = position.x > minX;
    const canGoRight = position.x < maxX;
    const canGoDown = position.y > minY;
    const canGoUp = position.y < maxY;
    const leftCellX = canGoLeft ? Math.floor((position.x - halfStep + maxX) / cellSize) : 0;
    const rightCellX = canGoRight ? Math.floor((position.x + halfStep + maxX) / cellSize) : 0;
    const downCellY = canGoDown ? Math.floor((position.y - halfStep) / cellSize) : 0;
    const upCellY = canGoUp ? Math.floor((position.y + halfStep) / cellSize) : 0;

    if (canGoLeft && canGoUp) {
        cells.push({
            x: leftCellX,
            y: upCellY,
        });
    }
    if (canGoRight && canGoUp) {
        cells.push({
            x: rightCellX,
            y: upCellY,
        });
    }
    if (canGoDown && canGoLeft) {
        cells.push({
            x: leftCellX,
            y: downCellY,
        });
    }
    if (canGoDown && canGoRight) {
        cells.push({
            x: rightCellX,
            y: downCellY,
        });
    }

    return cells;
}

/**
 * Footprint geometry — the ONE place the WxH rectangle rule lives.
 *
 * A unit occupies a `width` x `height` block of cells. Its ANCHOR (what `Unit.getBaseCell()` returns) is
 * the block's TOP-RIGHT cell, so the block extends towards -x and -y. That is not a new convention: it is
 * the one the 2x2 code already used everywhere (`getCellsAroundPosition` off a corner position, the
 * `cur.x - 1 / cur.y - 1` occupancy probes in PathHelper, `attackerBodyCellTopRight` here). 1x1 and 2x2 are
 * simply the W == H instances of it.
 *
 * The unit's continuous `position` is the block's geometric CENTRE, which is what makes
 * `getCellForPosition(position)` land on the anchor for every W and H (for an even side the centre sits
 * exactly on the grid line and `floor` picks the upper cell; for an odd side it sits mid-cell).
 */
export function normalizeFootprintSide(side: number | undefined, fallback = 1): number {
    if (!Number.isFinite(side)) {
        return Math.max(1, Math.floor(fallback));
    }
    return Math.max(1, Math.floor(side as number));
}

/** The cells of a `width` x `height` footprint anchored (top-right) at `anchor`. Not clipped to the grid. */
export function getFootprintCellsForAnchor(anchor: XY, width: number, height: number): XY[] {
    const w = normalizeFootprintSide(width);
    const h = normalizeFootprintSide(height);
    if (w === 1 && h === 1) {
        return [{ x: anchor.x, y: anchor.y }];
    }
    const cells: XY[] = new Array(w * h);
    let index = 0;
    for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
            cells[index++] = { x: anchor.x - dx, y: anchor.y - dy };
        }
    }
    return cells;
}

/** The centre position of a `width` x `height` footprint anchored (top-right) at `anchor`. */
export function getPositionForFootprintAnchor(
    gridSettings: GridSettings,
    anchor: XY,
    width: number,
    height: number,
): XY {
    const anchorPosition = getPositionForCell(
        anchor,
        gridSettings.getMinX(),
        gridSettings.getStep(),
        gridSettings.getHalfStep(),
    );
    const halfStep = gridSettings.getHalfStep();
    return {
        x: anchorPosition.x - (normalizeFootprintSide(width) - 1) * halfStep,
        y: anchorPosition.y - (normalizeFootprintSide(height) - 1) * halfStep,
    };
}

/** Whether the whole `width` x `height` footprint anchored at `anchor` lies on the board. */
export function isFootprintWithinGrid(gridSettings: GridSettings, anchor: XY, width: number, height: number): boolean {
    const gridSize = gridSettings.getGridSize();
    return (
        anchor.x >= normalizeFootprintSide(width) - 1 &&
        anchor.x < gridSize &&
        anchor.y >= normalizeFootprintSide(height) - 1 &&
        anchor.y < gridSize
    );
}

/** The anchor (top-right cell) of an arbitrary set of footprint cells. */
export function getFootprintAnchorForCells(cells: readonly XY[]): XY | undefined {
    if (!cells?.length) {
        return undefined;
    }
    let x = Number.MIN_SAFE_INTEGER;
    let y = Number.MIN_SAFE_INTEGER;
    for (const cell of cells) {
        if (cell.x > x) {
            x = cell.x;
        }
        if (cell.y > y) {
            y = cell.y;
        }
    }
    return { x, y };
}

/**
 * The anchor (top-right cell) of the footprint whose CENTRE is `position`.
 *
 * For a side of 1 or 2 this is just `getCellForPosition(position)` — a 1-wide footprint centres mid-cell and
 * a 2-wide one centres exactly on the grid line, where `floor` picks the upper cell. It stops being true at
 * side 3, where the centre falls back into the middle cell, so derive the minimum corner from the centre
 * instead of leaning on `floor`: `position = min*step + (side/2)*step`, hence `min = position/step - side/2`.
 * The rounding only absorbs float noise; the division is exact for every shape.
 */
export function getFootprintAnchorForPosition(
    gridSettings: GridSettings,
    position: XY,
    width: number,
    height: number,
): XY {
    const w = normalizeFootprintSide(width);
    const h = normalizeFootprintSide(height);
    if (w <= 2 && h <= 2) {
        return getCellForPosition(gridSettings, position);
    }
    const step = gridSettings.getStep();
    return {
        x: Math.round((position.x - gridSettings.getMinX()) / step - w / 2) + w - 1,
        y: Math.round(position.y / step - h / 2) + h - 1,
    };
}

export function getFootprintCellsForPosition(
    gridSettings: GridSettings,
    position: XY,
    width: number,
    height: number,
): XY[] {
    const w = normalizeFootprintSide(width);
    const h = normalizeFootprintSide(height);
    // Byte-identical legacy paths for the two shipped shapes, including cell ORDER, which callers such as
    // getPositionForCells and the renderers have always seen.
    if (w === 2 && h === 2) {
        return getCellsAroundPosition(gridSettings, position);
    }
    const anchor = getFootprintAnchorForPosition(gridSettings, position, w, h);
    if (w === 1 && h === 1) {
        return anchor ? [anchor] : [];
    }
    // Deliberately UNCLIPPED, like the 1x1 branch above. A footprint is W*H cells or it is not a footprint:
    // dropping the off-board ones would make a rectangle standing on the board edge indistinguishable from a
    // genuinely smaller unit to every `cells.length` check in Grid. Callers that need "is this on the board"
    // ask isFootprintWithinGrid, and anything that packs a cell into an (x << 4) | y key must ask first.
    return getFootprintCellsForAnchor(anchor, w, h);
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

/**
 * The centre position of a set of footprint cells. Any axis-aligned rectangle is accepted (1x1, 2x2 and
 * every rectangular shape in between), which is what lets a WxH stack round-trip
 * cells -> position -> cells. A non-rectangular or empty set is rejected.
 */
export function getPositionForCells(gridSettings: GridSettings, cells: XY[]): XY | undefined {
    if (cells.length === 1) {
        return getPositionForCell(cells[0], gridSettings.getMinX(), gridSettings.getStep(), gridSettings.getHalfStep());
    }

    if (!cells.length) {
        return undefined;
    }

    // ONE branch for every count. The 4-cell case used to skip the tiling check and return a
    // bounding-box centre for ANY four cells — the last shape-validation hole in the position round
    // trip. A 2x2 block and a 1x4 line both tile their box and pass; an L/T tetromino now fails
    // closed instead of centring somewhere its body is not.
    let rxMin = Number.MAX_SAFE_INTEGER;
    let rxMax = Number.MIN_SAFE_INTEGER;
    let ryMin = Number.MAX_SAFE_INTEGER;
    let ryMax = Number.MIN_SAFE_INTEGER;
    for (const c of cells) {
        rxMin = Math.min(rxMin, c.x);
        rxMax = Math.max(rxMax, c.x);
        ryMin = Math.min(ryMin, c.y);
        ryMax = Math.max(ryMax, c.y);
    }
    if ((rxMax - rxMin + 1) * (ryMax - ryMin + 1) !== cells.length) {
        return undefined;
    }
    return getPositionForCell(
        { x: rxMin + (rxMax - rxMin) / 2, y: ryMin + (ryMax - ryMin) / 2 },
        gridSettings.getMinX(),
        gridSettings.getStep(),
        gridSettings.getHalfStep(),
    );
}

// ---------------------------------------------------------------------------------------------
// Axis of advance. Classic boards deploy bottom/top (LEFT advances +y); SIDE-oriented boards
// (the ranked Point-X layout) deploy left/right (LEFT advances +x). These two helpers are THE
// switch every direction-sensitive rule routes through — Backstab geometry, advance/depth
// features, forward-looking routers, placement frontness. Never compare raw .y by team again.
// ---------------------------------------------------------------------------------------------

/**
 * How deep into the board a cell sits for `team`, in cells: 0 = the team's own back edge,
 * gridSize-1 = the enemy's back edge.
 */
export function advanceDepthOfCell(team: TeamType, cell: XY, sideOriented: boolean, gridSize = 16): number {
    const along = sideOriented ? cell.x : cell.y;
    return team === PBTypes.TeamVals.LEFT ? along : gridSize - 1 - along;
}

/** Signed advance from `from` to `to` for `team`, in cells: positive = toward the enemy. */
export function advanceDeltaBetween(team: TeamType, from: XY, to: XY, sideOriented: boolean): number {
    const delta = sideOriented ? to.x - from.x : to.y - from.y;
    return team === PBTypes.TeamVals.LEFT ? delta : -delta;
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

    if (teamType === PBTypes.TeamVals.LEFT) {
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
    } else if (teamType === PBTypes.TeamVals.RIGHT) {
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
    footprintWidth = 2,
    footprintHeight = 2,
): XY[] {
    const attackCells: XY[] = [];

    if (!fromPathHashes?.size) {
        return attackCells;
    }

    const width = normalizeFootprintSide(footprintWidth, 2);
    const height = normalizeFootprintSide(footprintHeight, 2);

    const verifyAndPush = (cell: XY) => {
        const isSelfCell = cell.x === attackerBodyCellTopRight.x && cell.y === attackerBodyCellTopRight.y;
        if (!isSelfCell && !currentActiveKnownPaths?.has((cell.x << 4) | cell.y)) {
            return;
        }

        const cellsToCheck: XY[] =
            width === 2 && height === 2
                ? [cell, { x: cell.x - 1, y: cell.y }, { x: cell.x - 1, y: cell.y - 1 }, { x: cell.x, y: cell.y - 1 }]
                : getFootprintCellsForAnchor(cell, width, height);

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

    // A WxH attacker can strike from any anchor whose footprint COVERS `attackFromCell` (that is what makes
    // the body adjacent to the enemy). The anchor is the block's top-right cell, so those anchors are
    // attackFromCell + [0..W-1] x [0..H-1]. verifyAndPush then drops the ones that overlap the enemy, leave
    // the board, or are unreachable. The hand-written quadrant branches below are exactly this rule for the
    // 2x2 case; they are kept verbatim so the shipped shapes also keep their exact candidate ORDER, which
    // decides which attack-from anchor a caller picks first.
    if (width !== 2 || height !== 2) {
        for (let dx = 0; dx < width; dx++) {
            for (let dy = 0; dy < height; dy++) {
                verifyAndPush({ x: attackFromCell.x + dx, y: attackFromCell.y + dy });
            }
        }
        return attackCells;
    }

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

/**
 * The shot distance the BOARD works in: whole cells, floored. The unit STAT stays fractional (5.3,
 * 6.5, 9.5) and is calculated and displayed exactly as before on the unit card and the left sidebar —
 * only the in-game geometry rounds down, so "6.5" means a full-damage square six cells deep.
 */
export function getWholeCellShotDistance(shotDistance: number): number {
    if (!Number.isFinite(shotDistance) || shotDistance <= 0) {
        return 0;
    }

    return Math.floor(shotDistance);
}

/**
 * Chebyshev ("king move") distance, in whole cells, from an attacker's FOOTPRINT to a target position.
 * 0 means the target sits on the attacker's own cells, 1 means it is adjacent (diagonals included).
 *
 * This is what makes the ranged falloff bands SQUARES rather than circles: a diagonal cell is exactly
 * as far as a straight one, so the full-damage area is the square the board draws.
 *
 * The target is snapped to its cell first, so an aim point nudged onto a cell EDGE (the side centers
 * a real shot resolves to - see getRangeAttackSideCenter) measures the same as that cell's center.
 * The attacker keeps its raw position because a multi-cell body is centred between cells; its own
 * half-footprint is subtracted per axis instead, which is what makes the square hug the unit's cells.
 */
export function getShotCellDistance(
    gridSettings: GridSettings,
    attackerPosition: XY,
    attackerFootprintWidth: number,
    attackerFootprintHeight: number,
    targetPosition: XY,
): number {
    const step = gridSettings.getStep();
    const targetCellPosition = getPositionForCell(
        getCellForPosition(gridSettings, targetPosition),
        gridSettings.getMinX(),
        step,
        gridSettings.getHalfStep(),
    );
    // Half the attacker's own footprint, in pixels, PER AXIS: 0 for a side of 1 (centered on its cell),
    // half a cell for a side of 2 (centered on a grid line), a whole cell for a side of 3. One scalar
    // cannot describe a rectangle, and the shipped `size` is the square ART tier, not board geometry —
    // it survived only because Math.round rounds a half up, which cancels the 0.5 error a 2x1 introduces
    // on its 1-cell axis. This is bit-identical for 1x1, 2x2, 2x1 and 1x2, and right for the rest.
    const halfFootprintX = ((normalizeFootprintSide(attackerFootprintWidth) - 1) / 2) * step;
    const halfFootprintY = ((normalizeFootprintSide(attackerFootprintHeight) - 1) / 2) * step;
    const dx = Math.abs(targetCellPosition.x - attackerPosition.x) - halfFootprintX;
    const dy = Math.abs(targetCellPosition.y - attackerPosition.y) - halfFootprintY;

    return Math.max(0, Math.round(Math.max(dx, dy) / step));
}

/**
 * Half-width, in pixels, of the square a shooter covers at full 1/1 damage - the area the board
 * highlights. Whole cells out from the unit's own footprint, so the edge lands on a cell border
 * instead of cutting through one.
 */
export function getFullDamageSquareHalfExtent(shotDistance: number, unitSize: number, step: number): number {
    return (getWholeCellShotDistance(shotDistance) + Math.max(1, unitSize) / 2) * step;
}

/**
 * The same half-extents, per axis.
 *
 * The band reaches the same number of whole cells out from the BODY on both axes, so a body that is not
 * square does not cover a square: a 2x1 shooter reaches half a cell further on x than on y. Collapsing that
 * to one number (which is all the scalar form above can express) paints the overlay half a cell past the
 * band the engine actually enforces on the thin axis. Identical to the scalar form whenever W === H.
 */
export function getFullDamageHalfExtents(
    shotDistance: number,
    footprintWidth: number,
    footprintHeight: number,
    step: number,
): XY {
    const wholeCells = getWholeCellShotDistance(shotDistance);
    return {
        x: (wholeCells + normalizeFootprintSide(footprintWidth) / 2) * step,
        y: (wholeCells + normalizeFootprintSide(footprintHeight) / 2) * step,
    };
}

/**
 * Sides of a grid cell a ranged shot can be aimed at. The numeric values are part of the ranked
 * wire protocol (range_attack carries the chosen side as an int) and are persisted in replays, so
 * they MUST stay stable. Order matches the legacy push order in getClosestSideCenter.
 */
export enum RangeAttackCellSide {
    LEFT = 0,
    RIGHT = 1,
    DOWN = 2,
    UP = 3,
}

export const RANGE_ATTACK_CELL_SIDES: readonly RangeAttackCellSide[] = [
    RangeAttackCellSide.LEFT,
    RangeAttackCellSide.RIGHT,
    RangeAttackCellSide.DOWN,
    RangeAttackCellSide.UP,
];

/**
 * Raw center of a cell's side (cell center shifted half a cell toward that side), before the
 * attacker-relative pixel nudge. Pure geometry — no occlusion checks.
 */
function rangeAttackSideRawCenter(gridSettings: GridSettings, cellPosition: XY, side: RangeAttackCellSide): XY {
    const half = gridSettings.getHalfStep();
    switch (side) {
        case RangeAttackCellSide.LEFT:
            return { x: cellPosition.x - half, y: cellPosition.y };
        case RangeAttackCellSide.RIGHT:
            return { x: cellPosition.x + half, y: cellPosition.y };
        case RangeAttackCellSide.DOWN:
            return { x: cellPosition.x, y: cellPosition.y - half };
        case RangeAttackCellSide.UP:
        default:
            return { x: cellPosition.x, y: cellPosition.y + half };
    }
}

/**
 * Deterministic world-space center of a cell's side that a ranged shot lands on. Uses the exact same
 * math as getClosestSideCenter, so the server can reconstruct precisely what the client previewed
 * from just (cell, side) — no floats are ever trusted from the client. Pure, no randomness.
 */
export function getRangeAttackSideCenter(
    gridSettings: GridSettings,
    cell: XY,
    side: RangeAttackCellSide,
    attackerPosition: XY,
): XY {
    const cellPosition = getPositionForCell(
        cell,
        gridSettings.getMinX(),
        gridSettings.getStep(),
        gridSettings.getHalfStep(),
    );
    return adjustClosestPointSideCenterPoint(
        rangeAttackSideRawCenter(gridSettings, cellPosition, side),
        attackerPosition,
    );
}

/**
 * Whether a ranged shot fired by `fromTeamType` can see (is not blocked at) a given cell side. A
 * side is observable when the neighbouring cell is empty, holds a friendly unit, or is flat hazard
 * terrain (lava/water/hole — narrowing consumes cells as holes) — i.e. NOT an enemy unit hiding the edge. Through Shot only treats hard BLOCK obstacles as occluders.
 * This is the authoritative "visible edge" rule, shared by the client preview and the server engine.
 */
export function isRangeAttackSideObservable(
    gridMatrix: number[][],
    cell: XY,
    side: RangeAttackCellSide,
    fromTeamType: TeamType,
    isThroughShot = false,
): boolean {
    let neighbour: number;
    switch (side) {
        case RangeAttackCellSide.LEFT:
            neighbour = matrixElement(gridMatrix, cell.x - 1, cell.y);
            break;
        case RangeAttackCellSide.RIGHT:
            neighbour = matrixElement(gridMatrix, cell.x + 1, cell.y);
            break;
        case RangeAttackCellSide.DOWN:
            neighbour = matrixElement(gridMatrix, cell.x, cell.y - 1);
            break;
        case RangeAttackCellSide.UP:
        default:
            neighbour = matrixElement(gridMatrix, cell.x, cell.y + 1);
            break;
    }
    if (isThroughShot) {
        return neighbour !== ObstacleType.BLOCK;
    }
    return (
        !neighbour ||
        neighbour === fromTeamType ||
        neighbour === ObstacleType.LAVA ||
        neighbour === ObstacleType.WATER ||
        // A HOLE is flat terrain like lava/water — nothing stands up out of it to occlude a shot. It
        // matters because NARROWING marks the consumed ring with holes (occupyByHole): without this,
        // every unit backed against the shrunken board's edge read as "covered" on those sides, and a
        // packed late-game board turned whole armies unshootable (live report, game 36f3c899, lap 4+).
        neighbour === ObstacleType.HOLE
    );
}

export interface IClosestSideCenter {
    position: XY;
    cell: XY;
    side: RangeAttackCellSide;
}

/**
 * Every (cell, side) pair of `targetCells` a shot from `fromTeamType` can legally land on. A ranged shot
 * always flies to the center of a VISIBLE EDGE — never to the target's geometric center — so a unit whose
 * every edge is covered (boxed in by its own allies and/or BLOCK obstacles) offers no legal aim point and
 * simply cannot be shot.
 *
 * Scans ALL of the target's cells on purpose: a 2x2 whose nearest corner is walled in may still present an
 * open edge on a far cell, and that shot is legal. Checking only the closest cell would make such a unit
 * unshootable.
 */
export function observableRangeAttackEdges(
    gridMatrix: number[][],
    targetCells: readonly XY[],
    fromTeamType: TeamType,
    isThroughShot = false,
): Array<{ cell: XY; side: RangeAttackCellSide }> {
    const edges: Array<{ cell: XY; side: RangeAttackCellSide }> = [];
    for (const cell of targetCells) {
        for (const side of RANGE_ATTACK_CELL_SIDES) {
            if (isRangeAttackSideObservable(gridMatrix, cell, side, fromTeamType, isThroughShot)) {
                edges.push({ cell, side });
            }
        }
    }
    return edges;
}

/** Whether any edge of `targetCells` is visible to `fromTeamType` — i.e. whether a ranged shot is possible. */
export function hasObservableRangeAttackEdge(
    gridMatrix: number[][],
    targetCells: readonly XY[],
    fromTeamType: TeamType,
    isThroughShot = false,
): boolean {
    for (const cell of targetCells) {
        for (const side of RANGE_ATTACK_CELL_SIDES) {
            if (isRangeAttackSideObservable(gridMatrix, cell, side, fromTeamType, isThroughShot)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * The visible edge a shot resolves to, honoring the shooter's bounded intent (`aimCell` + `aimSide`) when
 * that pair is still legal and clamping to the observable edge nearest the attacker otherwise. Returns
 * undefined when the target presents NO visible edge, which callers must treat as "this shot is not
 * allowed" rather than falling back to the target's center.
 *
 * Shared by the client preview and the authoritative engine so the two can never disagree about which
 * shots exist.
 */
export function resolveRangeAttackAimEdge(
    gridMatrix: number[][],
    gridSettings: GridSettings,
    targetCells: readonly XY[],
    attackerPosition: XY,
    fromTeamType: TeamType,
    isThroughShot = false,
    aimCell?: XY,
    aimSide?: number,
): IClosestSideCenter | undefined {
    const edges = observableRangeAttackEdges(gridMatrix, targetCells, fromTeamType, isThroughShot);
    if (!edges.length) {
        return undefined;
    }

    const requested =
        aimCell && aimSide !== undefined
            ? edges.find((edge) => edge.cell.x === aimCell.x && edge.cell.y === aimCell.y && edge.side === aimSide)
            : undefined;
    if (requested) {
        return {
            position: getRangeAttackSideCenter(gridSettings, requested.cell, requested.side, attackerPosition),
            cell: requested.cell,
            side: requested.side,
        };
    }

    // Clamp: nearest observable edge to the attacker. Deterministic — ties keep the left side index, and
    // cells are walked in the target's own stable order.
    let best = edges[0];
    let bestPosition = getRangeAttackSideCenter(gridSettings, best.cell, best.side, attackerPosition);
    let bestDistance = getDistance(attackerPosition, bestPosition);
    for (let i = 1; i < edges.length; i += 1) {
        const position = getRangeAttackSideCenter(gridSettings, edges[i].cell, edges[i].side, attackerPosition);
        const distance = getDistance(attackerPosition, position);
        if (distance < bestDistance) {
            best = edges[i];
            bestPosition = position;
            bestDistance = distance;
        }
    }
    return { position: bestPosition, cell: best.cell, side: best.side };
}

/**
 * Resolve which visible edge of an enemy unit a ranged shot is aimed at, given the mouse position.
 * Deterministic (no shuffle): the player aims at a cell + the side of it nearest the cursor among the
 * up-to-two sides closest to the attacker. Returns the cell and side so the same choice can be sent
 * to the server as bounded ints and reconstructed there. Mirrors legacy test_heroes.ts targeting.
 */
export function getClosestSideCenterDetailed(
    gridMatrix: number[][],
    gridSettings: GridSettings,
    mousePosition: XY,
    fromPosition: XY,
    toPosition: XY,
    isSmallUnitFrom: boolean,
    isSmallUnitTo: boolean,
    fromTeamType: TeamType,
    isThroughShot = false,
): IClosestSideCenter | undefined {
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

    const points: Array<{ xy: XY; side: RangeAttackCellSide; distance: number }> = [];
    const half = gridSettings.getHalfStep();
    const step = gridSettings.getStep();

    const observableLeft = isRangeAttackSideObservable(
        gridMatrix,
        cell,
        RangeAttackCellSide.LEFT,
        fromTeamType,
        isThroughShot,
    );
    const observableRight = isRangeAttackSideObservable(
        gridMatrix,
        cell,
        RangeAttackCellSide.RIGHT,
        fromTeamType,
        isThroughShot,
    );
    const observableUp = isRangeAttackSideObservable(
        gridMatrix,
        cell,
        RangeAttackCellSide.UP,
        fromTeamType,
        isThroughShot,
    );
    const observableDown = isRangeAttackSideObservable(
        gridMatrix,
        cell,
        RangeAttackCellSide.DOWN,
        fromTeamType,
        isThroughShot,
    );

    if (
        observableLeft &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.x === toPosition.x - half) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.x < toPosition.x) ||
            (isSmallUnitFrom && !isSmallUnitTo && fromPosition.x - half < toPosition.x - (isSmallUnitTo ? half : step)))
    ) {
        points.push({
            xy: { x: cellPosition.x - half, y: cellPosition.y },
            side: RangeAttackCellSide.LEFT,
            distance: Number.MAX_VALUE,
        });
    }
    if (
        observableRight &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.x === toPosition.x + half) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.x > toPosition.x) ||
            (isSmallUnitFrom && !isSmallUnitTo && fromPosition.x + half > toPosition.x + (isSmallUnitTo ? half : step)))
    ) {
        points.push({
            xy: { x: cellPosition.x + half, y: cellPosition.y },
            side: RangeAttackCellSide.RIGHT,
            distance: Number.MAX_VALUE,
        });
    }
    if (
        observableDown &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.y === toPosition.y - half) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.y < toPosition.y) ||
            (isSmallUnitFrom && !isSmallUnitTo && fromPosition.y - half < toPosition.y - (isSmallUnitTo ? half : step)))
    ) {
        points.push({
            xy: { x: cellPosition.x, y: cellPosition.y - half },
            side: RangeAttackCellSide.DOWN,
            distance: Number.MAX_VALUE,
        });
    }
    if (
        observableUp &&
        !(isSmallUnitTo && !isSmallUnitFrom && fromPosition.y === toPosition.y + half) &&
        (((isSmallUnitFrom === isSmallUnitTo || !isSmallUnitFrom) && fromPosition.y > toPosition.y) ||
            (isSmallUnitFrom && !isSmallUnitTo && fromPosition.y + half > toPosition.y + (isSmallUnitTo ? half : step)))
    ) {
        points.push({
            xy: { x: cellPosition.x, y: cellPosition.y + half },
            side: RangeAttackCellSide.UP,
            distance: Number.MAX_VALUE,
        });
    }

    // Which edges are visible is decided by isRangeAttackSideObservable (the immediate-neighbour rule)
    // plus the geometry gate above. The full attacker -> edge trajectory occlusion — a mountain or a
    // second unit standing between the shooter and the target — is owned by the engine's
    // evaluateRangeAttack, which is authoritative and shared verbatim with the server. So we do NOT
    // raycast the line here. An earlier on-line raycast deleted every edge whose sampled line clipped a
    // BLOCK cell, which on the two-mountain BLOCK_CENTER map wrongly hid the edges of units standing
    // behind/beside a mountain and units reachable through the 2x2 corridor — making shots the engine
    // would happily land unselectable. Let the engine resolve unit-vs-mountain; keep the edge visible.
    const visiblePoints = points;

    for (const p of visiblePoints) {
        p.distance = getDistance(fromPosition, p.xy);
    }

    // Two sides closest to the attacker, deterministically ordered (distance, then side index) — the
    // legacy shuffle is removed so the trajectory is reproducible on the server and in replays.
    visiblePoints.sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : a.side - b.side));
    const twoClosestPoints = visiblePoints.slice(0, 2);
    if (!twoClosestPoints.length) {
        return undefined;
    }

    let chosen = twoClosestPoints[0];
    if (twoClosestPoints.length > 1 && mousePosition) {
        const distanceA = getDistance(twoClosestPoints[0].xy, mousePosition);
        const distanceB = getDistance(twoClosestPoints[1].xy, mousePosition);
        // Cursor picks between the two; ties keep the left side index (deterministic).
        if (distanceB < distanceA) {
            chosen = twoClosestPoints[1];
        }
    }

    return {
        position: adjustClosestPointSideCenterPoint(chosen.xy, fromPosition),
        cell,
        side: chosen.side,
    };
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
    return getClosestSideCenterDetailed(
        gridMatrix,
        gridSettings,
        mousePosition,
        fromPosition,
        toPosition,
        isSmallUnitFrom,
        isSmallUnitTo,
        fromTeamType,
        isThroughShot,
    )?.position;
}
