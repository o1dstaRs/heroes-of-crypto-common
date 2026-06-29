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

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import {
    getClosestSideCenterDetailed,
    getPositionForCell,
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RangeAttackCellSide,
} from "../../src/grid/grid_math";
import { testGridSettings } from "../helpers/combat";

const GS = testGridSettings;
const HALF = GS.getHalfStep();
const STEP = GS.getStep();

const cellCenter = (x: number, y: number) => getPositionForCell({ x, y }, GS.getMinX(), STEP, GS.getHalfStep());

/** 16x16 zero matrix indexed [y][x] (matches matrixElement(matrix, x, y) === matrix[y][x]). */
const emptyMatrix = (): number[][] => Array.from({ length: 16 }, () => new Array<number>(16).fill(0));
const setCell = (m: number[][], x: number, y: number, value: number): void => {
    m[y][x] = value;
};

const UPPER = PBTypes.TeamVals.UPPER; // 1 (the attacker's team in these tests)
const LOWER = PBTypes.TeamVals.LOWER; // 2 (the enemy)

describe("range attack edge geometry (getRangeAttackSideCenter)", () => {
    it("places each side center on the matching edge of the cell", () => {
        const cell = { x: 8, y: 5 };
        const c = cellCenter(cell.x, cell.y);
        // Attacker far to the lower-left so the attacker-relative pixel nudge never crosses an axis.
        const attackerPos = cellCenter(1, 1);

        const left = getRangeAttackSideCenter(GS, cell, RangeAttackCellSide.LEFT, attackerPos);
        const right = getRangeAttackSideCenter(GS, cell, RangeAttackCellSide.RIGHT, attackerPos);
        const down = getRangeAttackSideCenter(GS, cell, RangeAttackCellSide.DOWN, attackerPos);
        const up = getRangeAttackSideCenter(GS, cell, RangeAttackCellSide.UP, attackerPos);

        // LEFT/RIGHT shift x by half a cell and keep y on the cell's row; DOWN/UP do the reverse.
        // A <=1px attacker-relative nudge is allowed (adjustClosestPointSideCenterPoint).
        expect(Math.abs(left.x - (c.x - HALF))).toBeLessThanOrEqual(1);
        expect(Math.abs(left.y - c.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(right.x - (c.x + HALF))).toBeLessThanOrEqual(1);
        expect(Math.abs(right.y - c.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(down.y - (c.y - HALF))).toBeLessThanOrEqual(1);
        expect(Math.abs(down.x - c.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(up.y - (c.y + HALF))).toBeLessThanOrEqual(1);
        expect(Math.abs(up.x - c.x)).toBeLessThanOrEqual(1);

        // The chosen edge is NOT the cell center — a ranged shot lands on the edge, not the middle.
        for (const edge of [left, right, down, up]) {
            expect(Math.hypot(edge.x - c.x, edge.y - c.y)).toBeGreaterThan(HALF - 2);
        }
    });
});

describe("range attack edge visibility (isRangeAttackSideObservable)", () => {
    const cell = { x: 8, y: 5 };

    it("treats an empty, friendly, lava or water neighbour as attackable", () => {
        const m = emptyMatrix();
        setCell(m, 7, 5, 0); // LEFT empty
        setCell(m, 6, 5, UPPER); // (friendly placed elsewhere for the friendly case below)
        setCell(m, 8, 6, UPPER); // UP friendly
        setCell(m, 8, 4, ObstacleType.LAVA); // DOWN lava
        setCell(m, 9, 5, ObstacleType.WATER); // RIGHT water

        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.LEFT, UPPER)).toBe(true); // empty
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.UP, UPPER)).toBe(true); // friendly
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.DOWN, UPPER)).toBe(true); // lava
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.RIGHT, UPPER)).toBe(true); // water
    });

    it("treats an enemy-covered edge as NOT attackable (non-through shot)", () => {
        const m = emptyMatrix();
        setCell(m, 7, 5, LOWER); // an enemy stands on the LEFT edge, hiding it
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.LEFT, UPPER)).toBe(false);
    });

    it("treats a mountain (BLOCK) edge as NOT attackable for a normal shot but passable for Through Shot", () => {
        const m = emptyMatrix();
        setCell(m, 9, 5, ObstacleType.BLOCK); // mountain on the RIGHT edge
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.RIGHT, UPPER, false)).toBe(false);
        // Through Shot only treats a hard BLOCK as occluding — every other neighbour is passable.
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.RIGHT, UPPER, true)).toBe(false);
        setCell(m, 9, 5, LOWER); // an enemy on the RIGHT edge does NOT block a Through Shot
        expect(isRangeAttackSideObservable(m, cell, RangeAttackCellSide.RIGHT, UPPER, true)).toBe(true);
    });
});

describe("range attack aim selection (getClosestSideCenterDetailed)", () => {
    it("aims at the visible edge facing the attacker", () => {
        const m = emptyMatrix();
        const attackerPos = cellCenter(1, 5);
        const target = { x: 8, y: 5 };
        const targetPos = cellCenter(target.x, target.y);

        const aim = getClosestSideCenterDetailed(m, GS, targetPos, attackerPos, targetPos, true, true, UPPER);
        expect(aim).toBeDefined();
        // Attacker is directly to the left, so the LEFT edge faces it.
        expect(aim!.side).toBe(RangeAttackCellSide.LEFT);
        expect(aim!.cell).toEqual(target);
    });

    it("skips a covered edge and picks another observable facing edge", () => {
        const m = emptyMatrix();
        // Diagonal approach: both the LEFT and the DOWN edges of the target face the attacker.
        const attackerPos = cellCenter(1, 1);
        const target = { x: 8, y: 8 };
        const targetPos = cellCenter(target.x, target.y);
        // Cover the DOWN edge with an enemy so only LEFT remains observable.
        setCell(m, 8, 7, LOWER);

        const aim = getClosestSideCenterDetailed(m, GS, targetPos, attackerPos, targetPos, true, true, UPPER);
        expect(aim).toBeDefined();
        expect(aim!.side).not.toBe(RangeAttackCellSide.DOWN);
        expect(aim!.side).toBe(RangeAttackCellSide.LEFT);
    });

    it("returns undefined when the only facing edge is covered (nothing legal to aim at)", () => {
        const m = emptyMatrix();
        const attackerPos = cellCenter(1, 5);
        const target = { x: 8, y: 5 };
        const targetPos = cellCenter(target.x, target.y);
        setCell(m, 7, 5, LOWER); // cover the LEFT edge — the only side facing a directly-left attacker
        const aim = getClosestSideCenterDetailed(m, GS, targetPos, attackerPos, targetPos, true, true, UPPER);
        expect(aim).toBeUndefined();
    });
});
