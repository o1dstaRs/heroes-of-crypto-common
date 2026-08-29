/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, test } from "bun:test";

import { AIActionType, canUnitLandAt, findSaferMoveCell, findTarget } from "../../src/ai/ai";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Spell } from "../../src/spells/spell";
import type { IUnitAIRepr } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const FLY = PBTypes.MovementVals.FLY;

describe("AI landing legality", () => {
    test("distinguishes hazard traversal from engine-legal endpoints", () => {
        const lava = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER).grid;
        const water = createCombatTestContext(PBTypes.GridVals.WATER_CENTER).grid;
        const hazardCell = { x: 7, y: 7 };

        const plain = createTestUnit({ team: LEFT, movementType: FLY });
        expect(canUnitLandAt(plain, lava, hazardCell)).toBe(false);

        // "All army units may move over AND STAND in lava" — the marker buff alone carries that, without
        // the artifact granting anyone the Made of Fire ability.
        const strider = createTestUnit({ team: LEFT });
        strider.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Lava Striders"), amount: 1 }));
        expect(strider.canTraverseLava()).toBe(true);
        expect(strider.hasAbilityActive("Made of Fire")).toBe(false);
        expect(canUnitLandAt(strider, lava, hazardCell)).toBe(true);

        const madeOfFire = createTestUnit({ team: LEFT, abilities: ["Made of Fire"] });
        expect(canUnitLandAt(madeOfFire, lava, hazardCell)).toBe(true);

        const madeOfWater = {
            getId: () => "made-of-water",
            isSmallSize: () => true,
            canTraverseLava: () => false,
            hasAbilityActive: (name: string) => name === "Made of Water",
        } as IUnitAIRepr;
        expect(canUnitLandAt(madeOfWater, water, hazardCell)).toBe(true);
    });

    test("checks every cell in a large unit footprint", () => {
        const lava = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER).grid;
        const largeFlyer = createTestUnit({ team: LEFT, movementType: FLY, size: PBTypes.UnitSizeVals.LARGE });

        // The anchor is clear, but the lower half of the 2x2 footprint clips the lava square.
        expect(lava.getOccupantUnitId({ x: 7, y: 10 })).toBe("");
        expect(lava.getOccupantUnitId({ x: 7, y: 9 })).toBe("L");
        expect(canUnitLandAt(largeFlyer, lava, { x: 7, y: 10 })).toBe(false);
    });

    test("rejects a large-unit anchor whose footprint crosses the board edge", () => {
        const normal = createCombatTestContext(PBTypes.GridVals.NORMAL).grid;
        const large = createTestUnit({ team: LEFT, size: PBTypes.UnitSizeVals.LARGE });

        expect(canUnitLandAt(large, normal, { x: 1, y: 1 })).toBe(true);
        expect(canUnitLandAt(large, normal, { x: 0, y: 0 })).toBe(false);
    });

    test("keeps a legal Made of Fire lava cell in ranged safety candidates", () => {
        const lava = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER).grid;
        const madeOfFire = createTestUnit({ team: LEFT, abilities: ["Made of Fire"] });
        const occupiedPreferred = { x: 5, y: 5 };
        const legalLavaCell = { x: 7, y: 7 };
        lava.occupyCell(occupiedPreferred, "enemy", RIGHT, 1, false, false);

        const safer = findSaferMoveCell(
            occupiedPreferred,
            new Map([[(legalLavaCell.x << 4) | legalLavaCell.y, []]]),
            lava.getMatrix(),
            RIGHT,
            true,
            (cell) => canUnitLandAt(madeOfFire, lava, cell),
        );

        expect(lava.getOccupantUnitId(legalLavaCell)).toBe("L");
        expect(safer).toEqual(legalLavaCell);
    });

    test("fallback can cross lava but chooses a legal far-side endpoint", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const flyer = createTestUnit({ team: LEFT, movementType: FLY, initiative: 6 });
        const enemy = createTestUnit({ team: RIGHT, initiative: 1 });
        placeUnit(combat.grid, combat.unitsHolder, flyer, { x: 5, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 11, y: 7 });

        const context = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
        };
        const decision = new StrategyV0_1()["fallbackTurn"](flyer, context);
        const move = decision.find((action) => action.type === "move_unit");

        expect(move?.type).toBe("move_unit");
        if (!move || move.type !== "move_unit") throw new Error("expected fallback move");
        expect(move.hasLavaCell).toBe(true);
        expect(move.path?.some((cell) => combat.grid.getOccupantUnitId(cell) === "L")).toBe(true);
        expect(canUnitLandAt(flyer, combat.grid, move.path![move.path!.length - 1])).toBe(true);
    });

    test("findTarget never emits an unlandable infinite-route endpoint", () => {
        const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const flyer = createTestUnit({ team: LEFT, movementType: FLY, initiative: 3 });
        const enemy = createTestUnit({ team: RIGHT, initiative: 1 });
        placeUnit(combat.grid, combat.unitsHolder, flyer, { x: 5, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 11, y: 7 });

        const action = findTarget(
            flyer,
            combat.grid,
            combat.grid.getMatrix(),
            combat.unitsHolder,
            new PathHelper(testGridSettings),
        );
        const endpoint = action?.cellToMove();

        expect(action?.actionType()).toBe(AIActionType.MOVE);
        expect(endpoint).toBeDefined();
        expect(canUnitLandAt(flyer, combat.grid, endpoint!)).toBe(true);
    });
});
