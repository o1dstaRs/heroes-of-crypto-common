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

import { describe, expect, it } from "bun:test";

import { getPositionForCell } from "../../src/grid/grid_math";
import { PlacementPositionType, PlacementType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SquarePlacement } from "../../src/grid/square_placement";
import { testGridSettings } from "../helpers/combat";

describe("placements", () => {
    it("computes square placement cells and allowed positions for all corners", () => {
        const leftBottom = new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 3);
        const rightBottom = new SquarePlacement(testGridSettings, PlacementPositionType.RIGHT_BOTTOM, 4);
        const leftTop = new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_TOP, 5);
        const rightTop = new SquarePlacement(testGridSettings, PlacementPositionType.RIGHT_TOP, 3);

        expect(leftBottom.getType()).toBe(PlacementType.SQUARE);
        expect(leftBottom.getSize()).toBe(3);
        expect(leftBottom.possibleCellPositions()).toHaveLength(9);
        expect(leftBottom.possibleCellPositions(false)).toHaveLength(4);
        expect(leftBottom.possibleCellHashes().size).toBe(9);
        expect(leftBottom.isAllowed(positionFor({ x: 1, y: 1 }))).toBe(true);
        expect(leftBottom.isAllowed(positionFor({ x: 8, y: 8 }))).toBe(false);

        expect(rightBottom.possibleCellPositions()).toHaveLength(16);
        expect(leftTop.possibleCellPositions()).toHaveLength(25);
        expect(rightTop.possibleCellPositions()[0]).toEqual({ x: 14, y: 14 });
    });

    it("computes rectangle placement cells and allowed positions for all corners", () => {
        const leftBottom = new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 3);
        const rightBottom = new RectanglePlacement(testGridSettings, PlacementPositionType.RIGHT_BOTTOM, 4);
        const leftTop = new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_TOP, 5);
        const rightTop = new RectanglePlacement(testGridSettings, PlacementPositionType.RIGHT_TOP, 3);

        expect(leftBottom.getType()).toBe(PlacementType.RECTANGLE);
        expect(leftBottom.getSize()).toBe(3);
        expect(leftBottom.possibleCellPositions()).toHaveLength(42);
        expect(leftBottom.possibleCellPositions(false)).toHaveLength(26);
        expect(leftBottom.possibleCellHashes().size).toBe(42);
        expect(leftBottom.isAllowed(positionFor({ x: 1, y: 1 }))).toBe(true);
        expect(leftBottom.isAllowed(positionFor({ x: 8, y: 8 }))).toBe(false);

        expect(rightBottom.possibleCellPositions()).toHaveLength(64);
        expect(leftTop.possibleCellPositions()).toHaveLength(80);
        expect(rightTop.possibleCellPositions()[0]).toEqual({ x: 1, y: 14 });
    });

    it("height 6 (Placement LEVEL_3) opens the board's edge line", () => {
        const left = new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 6);
        const right = new RectanglePlacement(testGridSettings, PlacementPositionType.RIGHT_TOP, 6);

        // 16 columns x 6 rows, INCLUDING the edge row that heights 3-5 stop short of.
        expect(left.possibleCellPositions()).toHaveLength(96);
        expect(left.possibleCellPositions().some((c) => c.y === 0)).toBe(true);
        expect(left.isAllowed(positionFor({ x: 4, y: 0 }))).toBe(true);
        expect(left.isAllowed(positionFor({ x: 4, y: 6 }))).toBe(false);

        expect(right.possibleCellPositions()).toHaveLength(96);
        expect(right.possibleCellPositions()[0]).toEqual({ x: 0, y: 15 });
        expect(right.isAllowed(positionFor({ x: 11, y: 15 }))).toBe(true);
        expect(right.isAllowed(positionFor({ x: 11, y: 9 }))).toBe(false);

        // Large (2x2) anchors stay inside the zone: lowest anchor row keeps the footprint on rows 0-5.
        const largeAnchors = left.possibleCellPositions(false);
        expect(largeAnchors.some((c) => c.y === 1)).toBe(true);
        expect(largeAnchors.every((c) => c.y >= 1 && c.y <= 5)).toBe(true);
    });

    it("rejects unsupported placement sizes and position types", () => {
        expect(() => new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 2)).toThrow();
        expect(() => new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 2)).toThrow();
        expect(() => new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 7)).toThrow();
        expect(() => new SquarePlacement(testGridSettings, PlacementPositionType.NO_TYPE, 3)).toThrow();
        expect(() => new RectanglePlacement(testGridSettings, PlacementPositionType.NO_TYPE, 3)).toThrow();
    });
});

function positionFor(cell: { x: number; y: number }): { x: number; y: number } {
    return getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
}
