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

import { getFootprintCellsForAnchor, normalizeFootprintSide } from "../../grid/grid_math";
import type { IUnitAIRepr } from "../../units/unit";
import { matrixElementOrDefault, type XY } from "../../utils/math";

function isFreeAt(x: number, y: number, matrix: number[][], attacker: IUnitAIRepr): boolean {
    if (matrixElementOrDefault(matrix, x, y, 0) != 0) {
        for (const atCell of attacker.getCells()) {
            if (atCell.x === x && atCell.y === y) {
                return true;
            }
        }
        return false;
    }
    return x >= 0 && x < matrix[0].length && y >= 0 && y < matrix.length;
}

function appendSmallLayer(
    layer: XY[],
    centerX: number,
    centerY: number,
    distance: number,
    matrix: number[][],
    attacker: IUnitAIRepr,
): void {
    const span = distance * 2 + 1;
    for (let offset = 0; offset < span; offset++) {
        const x = centerX - distance + offset;
        const y = centerY - distance;
        if (isFreeAt(x, y, matrix, attacker)) {
            layer.push({ x, y });
        }
    }
    for (let offset = 0; offset < span; offset++) {
        const x = centerX - distance + offset;
        const y = centerY + distance;
        if (isFreeAt(x, y, matrix, attacker)) {
            layer.push({ x, y });
        }
    }
    for (let offset = 0; offset < span; offset++) {
        const x = centerX - distance;
        const y = centerY - distance + offset;
        if (isFreeAt(x, y, matrix, attacker)) {
            layer.push({ x, y });
        }
    }
    for (let offset = 0; offset < span; offset++) {
        const x = centerX + distance;
        const y = centerY - distance + offset;
        if (isFreeAt(x, y, matrix, attacker)) {
            layer.push({ x, y });
        }
    }
}

function appendBigLayer(
    layer: XY[],
    centerX: number,
    centerY: number,
    distance: number,
    matrix: number[][],
    attacker: IUnitAIRepr,
): void {
    const span = distance * 2 + 1;
    for (let offset = 0; offset < span; offset++) {
        const x = centerX - distance + offset;
        const y = centerY - distance;
        if (
            isFreeAt(x, y, matrix, attacker) &&
            isFreeAt(x - 1, y, matrix, attacker) &&
            isFreeAt(x - 1, y - 1, matrix, attacker) &&
            isFreeAt(x, y - 1, matrix, attacker)
        ) {
            layer.push({ x, y });
        }
    }
    for (let offset = 0; offset < span; offset++) {
        const x = centerX - distance + offset;
        const y = centerY + distance + 1;
        if (
            isFreeAt(x, y, matrix, attacker) &&
            isFreeAt(x - 1, y, matrix, attacker) &&
            isFreeAt(x - 1, y - 1, matrix, attacker) &&
            isFreeAt(x, y - 1, matrix, attacker)
        ) {
            layer.push({ x, y });
        }
    }
    for (let offset = 0; offset < span; offset++) {
        const x = centerX - distance;
        const y = centerY - distance + offset;
        if (
            isFreeAt(x, y, matrix, attacker) &&
            isFreeAt(x - 1, y, matrix, attacker) &&
            isFreeAt(x - 1, y - 1, matrix, attacker) &&
            isFreeAt(x, y - 1, matrix, attacker)
        ) {
            layer.push({ x, y });
        }
    }
    for (let offset = 0; offset < span; offset++) {
        const x = centerX + distance + 1;
        const y = centerY - distance + offset;
        if (
            isFreeAt(x, y, matrix, attacker) &&
            isFreeAt(x - 1, y, matrix, attacker) &&
            isFreeAt(x - 1, y - 1, matrix, attacker) &&
            isFreeAt(x, y - 1, matrix, attacker)
        ) {
            layer.push({ x, y });
        }
    }
    const x = centerX + distance + 1;
    const y = centerY + distance + 1;
    if (
        isFreeAt(x, y, matrix, attacker) &&
        isFreeAt(x - 1, y, matrix, attacker) &&
        isFreeAt(x - 1, y - 1, matrix, attacker) &&
        isFreeAt(x, y - 1, matrix, attacker)
    ) {
        layer.push({ x, y });
    }
}

/**
 * The same ring for a body that is not a square.
 *
 * The two hand-written layers above are this formula with W == H substituted in, and they stay where they
 * are because the frozen differential tests pin their exact `isFreeAt` probe ORDER, not just their cells.
 * Read as geometry, both say the same thing: an anchor is at layer `distance` from the target cell when its
 * WxH body — which hangs down and to the LEFT of the anchor — reaches exactly that far. So the anchors form
 * the perimeter of the box `[cx - d, cx + d + (W - 1)] x [cy - d, cy + d + (H - 1)]`: the `+ (W - 1)` and
 * `+ (H - 1)` are the `distance + 1` terms the 2x2 layer spells out, taken one axis at a time. That
 * per-axis split is the whole point — a 1x2 has no left column to hang, so extending the ring in x would
 * offer anchors whose body never touches the target and whose melee the engine then rejects.
 */
function appendFootprintLayer(
    layer: XY[],
    centerX: number,
    centerY: number,
    distance: number,
    width: number,
    height: number,
    matrix: number[][],
    attacker: IUnitAIRepr,
): void {
    const xMin = centerX - distance;
    const xMax = centerX + distance + width - 1;
    const yMin = centerY - distance;
    const yMax = centerY + distance + height - 1;
    const pushIfBodyFits = (x: number, y: number): void => {
        for (const cell of getFootprintCellsForAnchor({ x, y }, width, height)) {
            if (!isFreeAt(cell.x, cell.y, matrix, attacker)) {
                return;
            }
        }
        layer.push({ x, y });
    };
    for (let x = xMin; x <= xMax; x++) {
        pushIfBodyFits(x, yMin);
    }
    for (let x = xMin; x <= xMax; x++) {
        pushIfBodyFits(x, yMax);
    }
    // The corners already went out with the rows, so the columns walk their interior only. Unlike the two
    // legacy layers this emits no duplicate anchor, which is safe precisely because no shipped shape reaches
    // this branch and nothing downstream has ever seen a rectangle's layer.
    for (let y = yMin + 1; y < yMax; y++) {
        pushIfBodyFits(xMin, y);
        pushIfBodyFits(xMax, y);
    }
}

/**
 * The attacker's real footprint. The boolean the callers still pass is only a fallback: several of these
 * layers are exercised against objects that implement `getCells()` and nothing else, and for those
 * "small or large" remains the only shape information there is.
 */
function attackerFootprint(attacker: IUnitAIRepr, isCurrentUnitSmall: boolean): { height: number; width: number } {
    const fallback = isCurrentUnitSmall ? 1 : 2;
    return {
        height: normalizeFootprintSide(attacker.getFootprintHeight?.(), fallback),
        width: normalizeFootprintSide(attacker.getFootprintWidth?.(), fallback),
    };
}

/**
 * Build every melee landing layer without materializing the rejected border cells.
 *
 * The generation and occupancy-check order intentionally mirrors the former
 * getBorderCells_2 -> filterCells pipeline, including duplicate corner occurrences.
 *
 * `isCurrentUnitSmall` only decides between the two SQUARE layers; the attacker's own
 * width and height decide everything else, because a rectangle is neither of them.
 *
 * @internal
 */
export function buildMeleeTargetLayers(
    cellToAttack: XY,
    matrix: number[][],
    attacker: IUnitAIRepr,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): XY[][] {
    const result: XY[][] = [];
    // The two SHIPPED squares keep the legacy dispatch untouched, on the flag rather than on the measured
    // shape, so 1x1 and 2x2 cannot drift even if a caller ever disagrees with the unit about which of the
    // two it is. Everything else goes through the shape-aware layer — asking only `width !== height` sent a
    // SQUARE body of side 3 into appendBigLayer, which is 2x2 geometry written out longhand.
    const { height, width } = attackerFootprint(attacker, isCurrentUnitSmall);
    const usesLegacySquareLayer = (width === 1 && height === 1) || (width === 2 && height === 2);
    if (isCurrentUnitSmall && usesLegacySquareLayer) {
        for (let distance = 1; distance < matrix.length / 2; distance++) {
            const layer: XY[] = [];
            const centerX = cellToAttack.x;
            const centerY = cellToAttack.y;
            appendSmallLayer(layer, centerX, centerY, distance, matrix, attacker);
            result[distance - 1] = layer;
        }
    } else if (usesLegacySquareLayer) {
        for (let distance = 1; distance < matrix.length / 2; distance++) {
            const layer: XY[] = [];
            const centerX = cellToAttack.x;
            const centerY = cellToAttack.y;
            appendBigLayer(layer, centerX, centerY, distance, matrix, attacker);
            result[distance - 1] = layer;
        }
    } else {
        for (let distance = 1; distance < matrix.length / 2; distance++) {
            const layer: XY[] = [];
            appendFootprintLayer(layer, cellToAttack.x, cellToAttack.y, distance, width, height, matrix, attacker);
            result[distance - 1] = layer;
        }
    }
    if (isTargetUnitSmall) {
        return result;
    }
    return [];
}

/**
 * Build only the distance-one melee landing layer.
 *
 * This narrower internal helper is valid only when the caller has independently
 * proved that no later layer can be observed. Its emitted values, order,
 * duplicate occurrences, and ownership match
 * `buildMeleeTargetLayers(...).slice(0, 1)`.
 *
 * @internal
 */
export function buildFirstMeleeTargetLayers(
    cellToAttack: XY,
    matrix: number[][],
    attacker: IUnitAIRepr,
    isCurrentUnitSmall = true,
    isTargetUnitSmall = true,
): XY[][] {
    if (!isTargetUnitSmall || 1 >= matrix.length / 2) {
        return [];
    }
    const layer: XY[] = [];
    const { height, width } = attackerFootprint(attacker, isCurrentUnitSmall);
    // Same dispatch as buildMeleeTargetLayers — only 1x1 and 2x2 have a hand-written layer.
    if (!((width === 1 && height === 1) || (width === 2 && height === 2))) {
        appendFootprintLayer(layer, cellToAttack.x, cellToAttack.y, 1, width, height, matrix, attacker);
    } else if (isCurrentUnitSmall) {
        appendSmallLayer(layer, cellToAttack.x, cellToAttack.y, 1, matrix, attacker);
    } else {
        appendBigLayer(layer, cellToAttack.x, cellToAttack.y, 1, matrix, attacker);
    }
    return [layer];
}
