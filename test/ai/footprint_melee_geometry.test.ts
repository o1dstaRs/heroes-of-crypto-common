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

import { canUnitLandAt, getCellsForAttacker } from "../../src/ai/ai";
import { buildFirstMeleeTargetLayers, buildMeleeTargetLayers } from "../../src/ai/internal/melee_target_layers";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Grid } from "../../src/grid/grid";
import { GRID_SIZE, MAX_X, MAX_Y, MIN_X, MIN_Y, MOVEMENT_DELTA, UNIT_SIZE_DELTA } from "../../src/grid/grid_constants";
import { GridSettings } from "../../src/grid/grid_settings";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import type { IUnitAIRepr } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";

// The AI side of rectangular footprints. Everything here is about LEGALITY rather than play strength: a
// stand cell the AI proposes for a body that does not actually fit there, or one whose body does not
// actually touch the victim, comes back from the engine as a rejected action — which in a ranked match is
// the bot that "moves but does not attack". So each enumerator is checked against an independent brute
// force over every anchor on the board, and the two shipped square shapes are checked to be untouched.

const TEAM = PBTypes.TeamVals.LOWER;
const BOARD = 8;

const newGrid = (): Grid =>
    new Grid(
        new GridSettings(GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X, MOVEMENT_DELTA, UNIT_SIZE_DELTA),
        PBTypes.GridVals.NORMAL,
    );

const emptyMatrix = (): number[][] => Array.from({ length: BOARD }, () => new Array<number>(BOARD).fill(0));

/** An attacker of an arbitrary shape. The AI only ever asks these four questions about a body. */
const shapedUnit = (width: number, height: number, ownCells: XY[] = []): IUnitAIRepr =>
    ({
        getId: () => `${width}x${height}`,
        getCells: () => ownCells,
        isSmallSize: () => width === 1 && height === 1,
        getFootprintWidth: () => width,
        getFootprintHeight: () => height,
        canTraverseLava: () => false,
        hasAbilityActive: () => false,
    }) as unknown as IUnitAIRepr;

const key = (cell: XY): string => `${cell.x},${cell.y}`;
const chebyshev = (a: XY, b: XY): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * Every anchor whose WxH body fits on the board and stands exactly one cell from the target's body —
 * i.e. every stand cell from which the engine would accept a melee. Written the slow, obvious way so it
 * shares no arithmetic with the enumerators under test.
 */
const legalStandAnchors = (
    target: XY,
    targetWidth: number,
    targetHeight: number,
    attackerWidth: number,
    attackerHeight: number,
): Set<string> => {
    const targetCells = getFootprintCellsForAnchor(target, targetWidth, targetHeight);
    const anchors = new Set<string>();
    for (let x = -attackerWidth; x < BOARD + attackerWidth; x++) {
        for (let y = -attackerHeight; y < BOARD + attackerHeight; y++) {
            const body = getFootprintCellsForAnchor({ x, y }, attackerWidth, attackerHeight);
            if (body.some((cell) => cell.x < 0 || cell.y < 0 || cell.x >= BOARD || cell.y >= BOARD)) {
                continue;
            }
            if (body.some((cell) => targetCells.some((targetCell) => chebyshev(cell, targetCell) === 0))) {
                continue;
            }
            if (!body.some((cell) => targetCells.some((targetCell) => chebyshev(cell, targetCell) === 1))) {
                continue;
            }
            anchors.add(key({ x, y }));
        }
    }
    return anchors;
};

describe("canUnitLandAt asks for the unit's own footprint", () => {
    it("clears a 1x2 whose phantom left column is occupied, and refuses one whose real second cell is", () => {
        const anchor = { x: 5, y: 6 };
        const tall = shapedUnit(1, 2);

        const besideIt = newGrid();
        // (4, 6) belongs to the 2x2 block the legacy code demanded and to no part of a 1x2 body.
        besideIt.occupyCell({ x: 4, y: 6 }, "blocker", TEAM, 1, false, false);
        expect(canUnitLandAt(tall, besideIt, anchor)).toBe(true);

        const underIt = newGrid();
        underIt.occupyCell({ x: 5, y: 5 }, "blocker", TEAM, 1, false, false);
        expect(canUnitLandAt(tall, underIt, anchor)).toBe(false);
    });

    it("refuses an anchor whose body hangs off the board, per axis", () => {
        const grid = newGrid();
        const tall = shapedUnit(1, 2);
        const wide = shapedUnit(2, 1);

        // A 1x2 reaches one row DOWN and no columns left; a 2x1 the other way round.
        expect(canUnitLandAt(tall, grid, { x: 0, y: 5 })).toBe(true);
        expect(canUnitLandAt(tall, grid, { x: 5, y: 0 })).toBe(false);
        expect(canUnitLandAt(wide, grid, { x: 0, y: 5 })).toBe(false);
        expect(canUnitLandAt(wide, grid, { x: 5, y: 0 })).toBe(true);
    });

    it("still demands the whole 2x2 block of a large unit", () => {
        const grid = newGrid();
        grid.occupyCell({ x: 4, y: 6 }, "blocker", TEAM, 1, false, false);
        expect(canUnitLandAt(shapedUnit(2, 2), grid, { x: 5, y: 6 })).toBe(false);
    });
});

describe("melee target layers for a rectangular attacker", () => {
    const target = { x: 4, y: 4 };

    for (const [width, height] of [
        [1, 2],
        [2, 1],
        [2, 3],
    ] as const) {
        it(`offers exactly the legal stand anchors for a ${width}x${height} body`, () => {
            const layers = buildMeleeTargetLayers(target, emptyMatrix(), shapedUnit(width, height), false, true);
            const offered = new Set(layers[0].map(key));
            expect([...offered].sort()).toEqual([...legalStandAnchors(target, 1, 1, width, height)].sort());
        });
    }

    it("does not extend the ring along the axis the body does not span", () => {
        const tall = buildMeleeTargetLayers(target, emptyMatrix(), shapedUnit(1, 2), false, true)[0].map(key);
        // The 2x2 layer offers x = target.x + 2 because its body hangs one column to the left. A 1x2 has no
        // such column, so that anchor would attack from two cells away and be rejected.
        expect(tall).not.toContain(key({ x: target.x + 2, y: target.y }));
        expect(tall).toContain(key({ x: target.x, y: target.y + 2 }));

        const wide = buildMeleeTargetLayers(target, emptyMatrix(), shapedUnit(2, 1), false, true)[0].map(key);
        expect(wide).not.toContain(key({ x: target.x, y: target.y + 2 }));
        expect(wide).toContain(key({ x: target.x + 2, y: target.y }));
    });

    it("keeps the first-layer shortcut identical to the full build", () => {
        for (const [width, height] of [
            [1, 1],
            [2, 2],
            [1, 2],
            [2, 1],
        ] as const) {
            const attacker = shapedUnit(width, height);
            const isSmall = width === 1 && height === 1;
            expect(buildFirstMeleeTargetLayers(target, emptyMatrix(), attacker, isSmall, true)).toEqual(
                buildMeleeTargetLayers(target, emptyMatrix(), attacker, isSmall, true).slice(0, 1),
            );
        }
    });

    it("rejects a stand anchor only when a cell the body really needs is taken", () => {
        const occupied = emptyMatrix();
        occupied[5][4] = TEAM; // cell (4, 5)
        const tall = buildMeleeTargetLayers(target, occupied, shapedUnit(1, 2), false, true)[0].map(key);
        const wide = buildMeleeTargetLayers(target, occupied, shapedUnit(2, 1), false, true)[0].map(key);
        // (4, 5) is the lower cell of a 1x2 anchored at (4, 6) and the left cell of a 2x1 anchored at (5, 5).
        expect(tall).not.toContain(key({ x: 4, y: 6 }));
        expect(tall).toContain(key({ x: 3, y: 6 }));
        expect(wide).not.toContain(key({ x: 5, y: 5 }));
        expect(wide).toContain(key({ x: 6, y: 5 }));
    });

    it("does not let a cell only a 2x2 block would need reject a 1x2", () => {
        const occupied = emptyMatrix();
        occupied[6][3] = TEAM; // cell (3, 6): the left column of the 2x2 anchored at (4, 6), and nothing to a 1x2
        const tall = buildMeleeTargetLayers(target, occupied, shapedUnit(1, 2), false, true)[0].map(key);
        const square = buildMeleeTargetLayers(target, occupied, shapedUnit(2, 2), false, true)[0].map(key);
        expect(tall).toContain(key({ x: 4, y: 6 }));
        expect(square).not.toContain(key({ x: 4, y: 6 }));
    });
});

describe("getCellsForAttacker", () => {
    const target = { x: 4, y: 4 };

    it("enumerates the legal anchors for every rectangular attacker/target pairing", () => {
        for (const [attackerWidth, attackerHeight] of [
            [1, 2],
            [2, 1],
            [3, 2],
        ] as const) {
            for (const [targetWidth, targetHeight] of [
                [1, 1],
                [2, 2],
                [1, 2],
                [2, 1],
            ] as const) {
                const attacker = shapedUnit(attackerWidth, attackerHeight);
                const cells = getCellsForAttacker(
                    target,
                    emptyMatrix(),
                    attacker,
                    false,
                    targetWidth === 1 && targetHeight === 1,
                    targetWidth,
                    targetHeight,
                );
                expect([...new Set(cells.map(key))].sort()).toEqual(
                    [...legalStandAnchors(target, targetWidth, targetHeight, attackerWidth, attackerHeight)].sort(),
                );
            }
        }
    });

    it("leaves the shipped square shapes on their frozen ring", () => {
        const small = getCellsForAttacker(target, emptyMatrix(), shapedUnit(1, 1), true, true);
        expect(small).toHaveLength(8);
        expect(small).toContainEqual({ x: target.x - 1, y: target.y + 1 });

        // The 2x2 ring is the 12 anchors whose block touches the target without covering it.
        const large = getCellsForAttacker(target, emptyMatrix(), shapedUnit(2, 2), false, true);
        expect(new Set(large.map(key)).size).toBe(12);
    });
});
