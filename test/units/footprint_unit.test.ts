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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    getCellsAroundPosition,
    getPositionForCell,
    getPositionForCells,
    getPositionForFootprintAnchor,
} from "../../src/grid/grid_math";
import { Unit } from "../../src/units/unit";
import { UnitProperties } from "../../src/units/unit_properties";
import type { XY } from "../../src/utils/math";
import { testGridSettings } from "../helpers/combat";

/**
 * A unit of an arbitrary WxH footprint. createTestUnit in the shared helpers only knows the square
 * `size`, and footprint_width/height are constructor arguments rather than mutable state (a unit owns a
 * structuredClone of its properties), so the whole property list is spelled out here instead.
 */
function createFootprintUnit(footprintWidth: number, footprintHeight: number): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    const noStrings: string[] = [];
    const noNumbers: number[] = [];
    const noBooleans: boolean[] = [];

    return Unit.createUnit(
        new UnitProperties(
            PBTypes.FactionVals.MIGHT,
            `Footprint ${footprintWidth}x${footprintHeight}`,
            10,
            3,
            0,
            0,
            1,
            10,
            PBTypes.AttackVals.MELEE,
            10,
            1,
            1,
            1,
            0,
            16,
            0,
            PBTypes.MovementVals.WALK,
            0,
            // The legacy square size stays what the texture and the card read; the footprint below is the
            // board geometry and is deliberately allowed to disagree with it.
            Math.max(footprintWidth, footprintHeight),
            PBTypes.UnitLevelVals.FIRST,
            noStrings,
            noStrings,
            noStrings,
            noBooleans,
            noBooleans,
            noStrings,
            noStrings,
            noStrings,
            noNumbers,
            noNumbers,
            noNumbers,
            noStrings,
            noStrings,
            noStrings,
            noNumbers,
            noNumbers,
            noNumbers,
            noStrings,
            noNumbers,
            noBooleans,
            noStrings,
            1,
            0,
            PBTypes.TeamVals.UPPER,
            PBTypes.UnitVals.CREATURE,
            "",
            "",
            1,
            "",
            [],
            false,
            footprintWidth,
            footprintHeight,
        ),
        testGridSettings,
        PBTypes.TeamVals.UPPER,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

function sortCells(cells: readonly XY[]): XY[] {
    return [...cells].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
}

function cellPosition(cell: XY): XY {
    return getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
}

// Far enough from every edge that all four shapes fit around the same anchor, so the shapes differ only
// by their footprint and never by clipping.
const ANCHOR: XY = { x: 7, y: 6 };

const FOOTPRINTS: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
];

describe("unit footprint geometry", () => {
    for (const [width, height] of FOOTPRINTS) {
        const label = `${width}x${height}`;

        it(`${label}: occupies a rectangle anchored on its top-right cell`, () => {
            const unit = createFootprintUnit(width, height);
            const position = getPositionForFootprintAnchor(testGridSettings, ANCHOR, width, height);
            unit.setPosition(position.x, position.y);

            expect(unit.getFootprintWidth()).toBe(width);
            expect(unit.getFootprintHeight()).toBe(height);
            expect(unit.isSmallSize()).toBe(width === 1 && height === 1);

            const cells = unit.getCells();
            expect(cells).toHaveLength(width * height);
            expect(unit.getBaseCell()).toEqual(ANCHOR);

            const expectedCells: XY[] = [];
            for (let dx = 0; dx < width; dx++) {
                for (let dy = 0; dy < height; dy++) {
                    expectedCells.push({ x: ANCHOR.x - dx, y: ANCHOR.y - dy });
                }
            }
            expect(sortCells(cells)).toEqual(sortCells(expectedCells));
            // The anchor really is the maximum corner: nothing extends past it in either axis.
            expect(Math.max(...cells.map((c) => c.x))).toBe(ANCHOR.x);
            expect(Math.max(...cells.map((c) => c.y))).toBe(ANCHOR.y);
            expect(Math.min(...cells.map((c) => c.x))).toBe(ANCHOR.x - width + 1);
            expect(Math.min(...cells.map((c) => c.y))).toBe(ANCHOR.y - height + 1);

            // The same rectangle a caller gets when it asks where the unit WOULD stand.
            expect(sortCells(unit.getFootprintCellsForAnchor(ANCHOR))).toEqual(sortCells(expectedCells));
            expect(unit.getFootprintCellsForBase(ANCHOR)).toEqual(unit.getFootprintCellsForAnchor(ANCHOR));
        });

        it(`${label}: position is the footprint centre and round-trips through its cells`, () => {
            const unit = createFootprintUnit(width, height);
            const position = getPositionForFootprintAnchor(testGridSettings, ANCHOR, width, height);
            unit.setPosition(position.x, position.y);

            const cells = unit.getCells();
            // Independently: the centre of a rectangle is the average of its cells' centres.
            const centres = cells.map(cellPosition);
            const footprintCentre = {
                x: centres.reduce((sum, c) => sum + c.x, 0) / centres.length,
                y: centres.reduce((sum, c) => sum + c.y, 0) / centres.length,
            };
            expect(unit.getPosition()).toEqual(footprintCentre);
            expect(getPositionForCells(testGridSettings, cells)).toEqual(unit.getPosition());

            // Stable under cells -> position -> cells, which is the loop every placement and hydration path
            // walks: a footprint that drifted by half a cell per rebuild would slide off its anchor.
            const roundTripped = getPositionForCells(testGridSettings, cells)!;
            unit.setPosition(roundTripped.x, roundTripped.y);
            expect(unit.getCells()).toEqual(cells);
            expect(unit.getBaseCell()).toEqual(ANCHOR);
        });

        it(`${label}: getCenter is the centre of the anchor cell`, () => {
            const unit = createFootprintUnit(width, height);
            const position = getPositionForFootprintAnchor(testGridSettings, ANCHOR, width, height);
            unit.setPosition(position.x, position.y);

            // getCenter() has always returned the ANCHOR CELL's centre, not the footprint's — the footprint
            // centre is getPosition() itself (asserted above). For a 1x1 the two coincide, for a 2x2 the
            // anchor cell sits half a cell up and to the right, and a rectangle leans only along its long
            // side. unit.test.ts pins the shipped shapes' exact values.
            expect(unit.getCenter()).toEqual(cellPosition(ANCHOR));
            expect(unit.getCenter()).toEqual({
                x: unit.getPosition().x + (width - 1) * testGridSettings.getHalfStep(),
                y: unit.getPosition().y + (height - 1) * testGridSettings.getHalfStep(),
            });
        });
    }

    it("keeps the legacy cell ORDER for the two shipped shapes", () => {
        // Callers have always seen these exact orders (getCells feeds getPositionForCells, the renderers and
        // the aggro stamping), so the generic footprint path must not quietly reshuffle them.
        const small = createFootprintUnit(1, 1);
        const smallPosition = getPositionForFootprintAnchor(testGridSettings, ANCHOR, 1, 1);
        small.setPosition(smallPosition.x, smallPosition.y);
        expect(small.getCells()).toEqual([ANCHOR]);

        const large = createFootprintUnit(2, 2);
        const largePosition = getPositionForFootprintAnchor(testGridSettings, ANCHOR, 2, 2);
        large.setPosition(largePosition.x, largePosition.y);
        expect(large.getCells()).toEqual(getCellsAroundPosition(testGridSettings, large.getPosition()));
    });
});
