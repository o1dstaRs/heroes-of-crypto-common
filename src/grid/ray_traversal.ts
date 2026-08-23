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

import type { XY } from "../utils/math";
import { getCellForPosition } from "./grid_math";
import type { GridSettings } from "./grid_settings";

export type GridRayCellIntersection = [cell: XY, firstPosition: XY];

/**
 * Return the displacement of one axis at major-axis step `step` for the symmetric integer Bresenham
 * rasterizer historically used by ranged attacks. The `(majorExtent - 1)` tie term is intentional:
 * it preserves the old strict `e2 > -dy` / `e2 < dx` corner choice in both directions.
 */
function axisDisplacement(axisExtent: number, majorExtent: number, step: number): number {
    if (axisExtent === 0) {
        return 0;
    }
    return Math.floor((2 * step * axisExtent + majorExtent - 1) / (2 * majorExtent));
}

/** Invert axisDisplacement: first major-axis step whose displacement is at least `required`. */
function firstStepForDisplacement(required: number, axisExtent: number, majorExtent: number): number {
    if (axisExtent === 0) {
        return Infinity;
    }
    return Math.max(0, Math.ceil((2 * majorExtent * required - majorExtent + 1) / (2 * axisExtent)));
}

/**
 * Find the first Bresenham step whose integer coordinate belongs to the next cell on one axis.
 * Positive travel enters at ceil(upper boundary); negative travel enters at ceil(lower boundary) - 1.
 * The latter is the legacy one-pixel asymmetry that determines the first obstacle position and, in
 * turn, can affect exact range-falloff thresholds.
 */
function firstStepOutsideCell(
    startCoordinate: number,
    direction: number,
    axisExtent: number,
    majorExtent: number,
    cellIndex: number,
    cellOrigin: number,
    cellSize: number,
): number {
    if (axisExtent === 0) {
        return Infinity;
    }
    const boundary = cellOrigin + (direction > 0 ? cellIndex + 1 : cellIndex) * cellSize;
    const firstCoordinate = direction > 0 ? Math.ceil(boundary) : Math.ceil(boundary) - 1;
    const required = direction > 0 ? firstCoordinate - startCoordinate : startCoordinate - firstCoordinate;
    return firstStepForDisplacement(required, axisExtent, majorExtent);
}

/**
 * Trace the grid cells visited by the ranked engine's discrete ranged-shot line.
 *
 * This is a compatibility-preserving grid DDA, not a mathematical corner supercover. A strict
 * supercover would add both side cells when a line touches their shared corner, changing which unit or
 * mountain intercepts existing shots. Instead, this function reproduces the former pipeline exactly:
 *
 * 1. round both world-space endpoints;
 * 2. rasterize the symmetric integer Bresenham line;
 * 3. map each pixel to a cell; and
 * 4. retain the first pixel in each entered cell.
 *
 * It computes Bresenham coordinates analytically and inverts them at each grid boundary, jumping from
 * one cell transition to the next. Runtime therefore scales with crossed cells (at most roughly twice
 * the grid width), rather than with the thousands of world pixels between the endpoints.
 */
export function traceGridRayCells(gridSettings: GridSettings, start: XY, end: XY): GridRayCellIntersection[] {
    const startX = Math.round(start.x);
    const startY = Math.round(start.y);
    const endX = Math.round(end.x);
    const endY = Math.round(end.y);
    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(endX) || !Number.isFinite(endY)) {
        return [];
    }

    const deltaX = Math.abs(endX - startX);
    const deltaY = Math.abs(endY - startY);
    const majorExtent = Math.max(deltaX, deltaY);
    const directionX = startX < endX ? 1 : -1;
    const directionY = startY < endY ? 1 : -1;
    const cellSize = gridSettings.getCellSize();
    const maxX = gridSettings.getMaxX();
    const xOrigin = -maxX;
    // getCellForPosition historically maps y as floor(y / cellSize), independent of GridSettings.minY.
    const yOrigin = 0;

    if (majorExtent === 0) {
        const position = { x: startX, y: startY };
        return [[getCellForPosition(gridSettings, position), position]];
    }

    const intersections: GridRayCellIntersection[] = [];
    // Preserve the legacy 16-wide packed key exactly, including its collisions for malformed/out-of-grid
    // cells. Legal in-grid cells are collision-free; retaining the historical key makes differential fuzzing
    // exact even for projected field-edge endpoints at x/y === gridSize.
    const seenCellKeys: number[] = [];
    let seenCellKeySet: Set<number> | undefined;
    let previousCellX: number | undefined;
    let previousCellY: number | undefined;
    let step = 0;
    while (step <= majorExtent) {
        const positionX = startX + directionX * axisDisplacement(deltaX, majorExtent, step);
        const positionY = startY + directionY * axisDisplacement(deltaY, majorExtent, step);
        // Keep the hot transition scan scalar. Objects are part of the public result, but constructing the
        // temporary position and cell for every examined boundary roughly doubles allocation in ranged-heavy
        // searches. These are exactly getCellForPosition's two historical formulas.
        const cellX = Math.floor((positionX + maxX) / cellSize);
        const cellY = Math.floor(positionY / cellSize);
        if (cellX !== previousCellX || cellY !== previousCellY) {
            const cellKey = (cellX << 4) | cellY;
            const isNewCell = seenCellKeySet ? !seenCellKeySet.has(cellKey) : !seenCellKeys.includes(cellKey);
            if (isNewCell) {
                intersections.push([
                    { x: cellX, y: cellY },
                    { x: positionX, y: positionY },
                ]);
                if (seenCellKeySet) {
                    seenCellKeySet.add(cellKey);
                } else {
                    seenCellKeys.push(cellKey);
                    // Legal 16x16 rays cross at most 31 unique cells. Keep their tiny membership list as an
                    // allocation-light array, but retain Set complexity for extreme custom/out-of-grid rays.
                    if (seenCellKeys.length === 32) {
                        seenCellKeySet = new Set(seenCellKeys);
                    }
                }
            }
            previousCellX = cellX;
            previousCellY = cellY;
        }

        const nextX = firstStepOutsideCell(startX, directionX, deltaX, majorExtent, cellX, xOrigin, cellSize);
        const nextY = firstStepOutsideCell(startY, directionY, deltaY, majorExtent, cellY, yOrigin, cellSize);
        const nextStep = Math.min(nextX, nextY);
        if (!Number.isFinite(nextStep) || nextStep > majorExtent) {
            break;
        }
        // The closed-form inverse should always advance. The one-step fallback keeps malformed or future
        // fractional GridSettings configurations terminating while the previous-cell guard preserves output.
        step = nextStep > step ? nextStep : step + 1;
    }

    return intersections;
}
