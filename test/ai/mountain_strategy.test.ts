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

import { describe, it, expect } from "bun:test";

import { AIActionType, findTarget } from "../../src/ai/ai";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

// A cell just left of the 4x4 center mountain (center is cells 6..9 on a 16-grid), so a unit standing
// here is adjacent to the mountain's outer ring and can strike it in place.
const NEXT_TO_MOUNTAIN: XY = { x: 5, y: 7 };

function setupMountain(hitsLeft?: number): CombatTestContext {
    const ctx = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(PBTypes.GridVals.BLOCK_CENTER); // syncs obstacleHitsLeft = MAX_HITS_MOUNTAIN
    if (hitsLeft !== undefined) {
        fp.setObstacleHitsLeft(hitsLeft);
    }
    return ctx;
}

function act(ctx: CombatTestContext, unit: Unit): AIActionType | undefined {
    const pathHelper = new PathHelper(testGridSettings);
    return findTarget(unit, ctx.grid, ctx.grid.getMatrix(), ctx.unitsHolder, pathHelper)?.actionType();
}

describe("AI mountain (BLOCK_CENTER) strategy", () => {
    it("we out-range the enemy → idle melee breaks the mountain", () => {
        const ctx = setupMountain();
        const melee = createTestUnit({ team: LOWER, attackType: MELEE, name: "Knight" });
        placeUnit(ctx.grid, ctx.unitsHolder, melee, NEXT_TO_MOUNTAIN);
        // A strong ranged ally makes us out-range them; enemy has no ranged firepower.
        const rangedAlly = createTestUnit({
            team: LOWER,
            attackType: RANGE,
            rangeShots: 5,
            damageMax: 10,
            name: "Archer",
        });
        placeUnit(ctx.grid, ctx.unitsHolder, rangedAlly, { x: 3, y: 3 });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE, name: "Orc" });
        placeUnit(ctx.grid, ctx.unitsHolder, enemy, { x: 12, y: 12 });

        expect(act(ctx, melee)).toBe(AIActionType.OBSTACLE_ATTACK);
    });

    it("they out-range us but we can clear it in a single lap (grouped) → break it", () => {
        const ctx = setupMountain(2); // only 2 hits left
        const melee = createTestUnit({ team: LOWER, attackType: MELEE, name: "Knight" });
        placeUnit(ctx.grid, ctx.unitsHolder, melee, NEXT_TO_MOUNTAIN);
        const meleeAlly = createTestUnit({ team: LOWER, attackType: MELEE, name: "Squire" });
        placeUnit(ctx.grid, ctx.unitsHolder, meleeAlly, { x: 5, y: 8 }); // grouped + also reaches mountain
        // Enemy out-ranges us (we have no ranged), placed far so they aren't pressing.
        const enemyRanged = createTestUnit({
            team: UPPER,
            attackType: RANGE,
            rangeShots: 5,
            damageMax: 10,
            name: "Sniper",
        });
        placeUnit(ctx.grid, ctx.unitsHolder, enemyRanged, { x: 12, y: 12 });

        expect(act(ctx, melee)).toBe(AIActionType.OBSTACLE_ATTACK);
    });

    it("they out-range us and our units are spread out → do NOT mine (advance/regroup)", () => {
        const ctx = setupMountain(2);
        const melee = createTestUnit({ team: LOWER, attackType: MELEE, name: "Knight" });
        placeUnit(ctx.grid, ctx.unitsHolder, melee, NEXT_TO_MOUNTAIN);
        const farAlly = createTestUnit({ team: LOWER, attackType: MELEE, name: "Straggler" });
        placeUnit(ctx.grid, ctx.unitsHolder, farAlly, { x: 1, y: 1 }); // spread out, can't reach mountain
        const enemyRanged = createTestUnit({
            team: UPPER,
            attackType: RANGE,
            rangeShots: 5,
            damageMax: 10,
            name: "Sniper",
        });
        placeUnit(ctx.grid, ctx.unitsHolder, enemyRanged, { x: 12, y: 12 });

        expect(act(ctx, melee)).not.toBe(AIActionType.OBSTACLE_ATTACK);
    });

    it("ranged units never mine (they hold/shoot)", () => {
        const ctx = setupMountain();
        const ranged = createTestUnit({ team: LOWER, attackType: RANGE, rangeShots: 5, damageMax: 10, name: "Archer" });
        placeUnit(ctx.grid, ctx.unitsHolder, ranged, NEXT_TO_MOUNTAIN);
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE, name: "Orc" });
        placeUnit(ctx.grid, ctx.unitsHolder, enemy, { x: 12, y: 12 });

        expect(act(ctx, ranged)).not.toBe(AIActionType.OBSTACLE_ATTACK);
    });

    it("no mountain on the map → never mine", () => {
        const ctx = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const melee = createTestUnit({ team: LOWER, attackType: MELEE, name: "Knight" });
        placeUnit(ctx.grid, ctx.unitsHolder, melee, NEXT_TO_MOUNTAIN);
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE, name: "Orc" });
        placeUnit(ctx.grid, ctx.unitsHolder, enemy, { x: 12, y: 12 });

        expect(act(ctx, melee)).not.toBe(AIActionType.OBSTACLE_ATTACK);
    });

    it("enemies pressing → engage/advance instead of mining", () => {
        const ctx = setupMountain();
        const melee = createTestUnit({ team: LOWER, attackType: MELEE, name: "Knight" });
        placeUnit(ctx.grid, ctx.unitsHolder, melee, NEXT_TO_MOUNTAIN);
        const rangedAlly = createTestUnit({
            team: LOWER,
            attackType: RANGE,
            rangeShots: 5,
            damageMax: 10,
            name: "Archer",
        });
        placeUnit(ctx.grid, ctx.unitsHolder, rangedAlly, { x: 3, y: 3 });
        // Enemy within the press radius (3 cells) of our melee unit but not adjacent (no melee target).
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE, name: "Orc" });
        placeUnit(ctx.grid, ctx.unitsHolder, enemy, { x: 5, y: 4 });

        expect(act(ctx, melee)).not.toBe(AIActionType.OBSTACLE_ATTACK);
    });
});
