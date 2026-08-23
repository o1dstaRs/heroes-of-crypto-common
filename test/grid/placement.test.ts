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
        const lowerLeft = new SquarePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const upperLeft = new SquarePlacement(testGridSettings, PlacementPositionType.UPPER_LEFT, 4);
        const lowerRight = new SquarePlacement(testGridSettings, PlacementPositionType.LOWER_RIGHT, 5);
        const upperRight = new SquarePlacement(testGridSettings, PlacementPositionType.UPPER_RIGHT, 3);

        expect(lowerLeft.getType()).toBe(PlacementType.SQUARE);
        expect(lowerLeft.getSize()).toBe(3);
        expect(lowerLeft.possibleCellPositions()).toHaveLength(9);
        expect(lowerLeft.possibleCellPositions(false)).toHaveLength(4);
        expect(lowerLeft.possibleCellHashes().size).toBe(9);
        expect(lowerLeft.isAllowed(positionFor({ x: 1, y: 1 }))).toBe(true);
        expect(lowerLeft.isAllowed(positionFor({ x: 8, y: 8 }))).toBe(false);

        expect(upperLeft.possibleCellPositions()).toHaveLength(16);
        expect(lowerRight.possibleCellPositions()).toHaveLength(25);
        expect(upperRight.possibleCellPositions()[0]).toEqual({ x: 14, y: 14 });
    });

    it("computes rectangle placement cells and allowed positions for all corners", () => {
        const lowerLeft = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const upperLeft = new RectanglePlacement(testGridSettings, PlacementPositionType.UPPER_LEFT, 4);
        const lowerRight = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_RIGHT, 5);
        const upperRight = new RectanglePlacement(testGridSettings, PlacementPositionType.UPPER_RIGHT, 3);

        expect(lowerLeft.getType()).toBe(PlacementType.RECTANGLE);
        expect(lowerLeft.getSize()).toBe(3);
        expect(lowerLeft.possibleCellPositions()).toHaveLength(42);
        expect(lowerLeft.possibleCellPositions(false)).toHaveLength(26);
        expect(lowerLeft.possibleCellPositions(false, 2, 1)).toHaveLength(28);
        expect(lowerLeft.possibleCellPositions(false, 2, 1).every((cell) => cell.x >= 2 && cell.y >= 1)).toBe(true);
        expect(lowerLeft.possibleCellHashes().size).toBe(42);
        expect(lowerLeft.isAllowed(positionFor({ x: 1, y: 1 }))).toBe(true);
        expect(lowerLeft.isAllowed(positionFor({ x: 8, y: 8 }))).toBe(false);

        expect(upperLeft.possibleCellPositions()).toHaveLength(64);
        expect(lowerRight.possibleCellPositions()).toHaveLength(80);
        expect(upperRight.possibleCellPositions()[0]).toEqual({ x: 14, y: 1 });
        expect(lowerLeft.isAllowed(positionFor({ x: 3, y: 8 }))).toBe(true);
        expect(lowerLeft.isAllowed(positionFor({ x: 4, y: 8 }))).toBe(false);
        expect(upperRight.isAllowed(positionFor({ x: 12, y: 8 }))).toBe(true);
        expect(upperRight.isAllowed(positionFor({ x: 11, y: 8 }))).toBe(false);
    });

    it("depth 6 (Placement LEVEL_3) opens the board's edge line", () => {
        const lower = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 6);
        const upper = new RectanglePlacement(testGridSettings, PlacementPositionType.UPPER_RIGHT, 6);

        // 6 columns x 16 rows, INCLUDING the edge column that depths 3-5 stop short of.
        expect(lower.possibleCellPositions()).toHaveLength(96);
        expect(lower.possibleCellPositions().some((c) => c.x === 0)).toBe(true);
        expect(lower.isAllowed(positionFor({ x: 0, y: 4 }))).toBe(true);
        expect(lower.isAllowed(positionFor({ x: 6, y: 4 }))).toBe(false);

        expect(upper.possibleCellPositions()).toHaveLength(96);
        expect(upper.possibleCellPositions()[0]).toEqual({ x: 15, y: 0 });
        expect(upper.isAllowed(positionFor({ x: 15, y: 11 }))).toBe(true);
        expect(upper.isAllowed(positionFor({ x: 9, y: 11 }))).toBe(false);

        // Large (2x2) anchors stay inside the zone: leftmost anchor column keeps the footprint in columns 0-5.
        const largeAnchors = lower.possibleCellPositions(false);
        expect(largeAnchors.some((c) => c.x === 1)).toBe(true);
        expect(largeAnchors.every((c) => c.x >= 1 && c.x <= 5)).toBe(true);
    });

    it("rejects unsupported placement sizes and position types", () => {
        expect(() => new SquarePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 2)).toThrow();
        expect(() => new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 2)).toThrow();
        expect(() => new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 7)).toThrow();
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
