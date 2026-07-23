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
 * Build every melee landing layer without materializing the rejected border cells.
 *
 * The generation and occupancy-check order intentionally mirrors the former
 * getBorderCells_2 -> filterCells pipeline, including duplicate corner occurrences.
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
    if (isCurrentUnitSmall) {
        for (let distance = 1; distance < matrix.length / 2; distance++) {
            const layer: XY[] = [];
            const centerX = cellToAttack.x;
            const centerY = cellToAttack.y;
            appendSmallLayer(layer, centerX, centerY, distance, matrix, attacker);
            result[distance - 1] = layer;
        }
    } else {
        for (let distance = 1; distance < matrix.length / 2; distance++) {
            const layer: XY[] = [];
            const centerX = cellToAttack.x;
            const centerY = cellToAttack.y;
            appendBigLayer(layer, centerX, centerY, distance, matrix, attacker);
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
    if (isCurrentUnitSmall) {
        appendSmallLayer(layer, cellToAttack.x, cellToAttack.y, 1, matrix, attacker);
    } else {
        appendBigLayer(layer, cellToAttack.x, cellToAttack.y, 1, matrix, attacker);
    }
    return [layer];
}
