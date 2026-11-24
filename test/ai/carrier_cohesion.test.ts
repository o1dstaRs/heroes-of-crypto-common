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

import { afterEach, describe, expect, test } from "bun:test";

import {
    A19_ALIVE_BLESSINGS,
    A19_CARRIER_COHESION_RUSH_MOVEMENT,
    A19_CARRIER_COHESION_RUSH_PLACEMENT,
    a19CarrierCohesionEnabled,
    a19CarrierCohesionHoldsBack,
    a19CarriesAliveBlessing,
    a19IsEarlyIsolatingCarrierMove,
    a19IsPrincipalBlessingCarrier,
} from "../../src/ai/carrier_cohesion";
import { A19_STRIKER_RUSH_MOVEMENT, A19_STRIKER_RUSH_PLACEMENT } from "../../src/ai/setup/a19_striker_rush";
import abilities from "../../src/configuration/abilities.json";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT,
    RIGHT = PBTypes.TeamVals.RIGHT;

function board() {
    const combat = createCombatTestContext();
    const carrier = createTestUnit({
        team: LEFT,
        name: "Crusader",
        abilities: ["Sharpened Weapons Blessing"],
        amountAlive: 8,
    });
    placeUnit(combat.grid, combat.unitsHolder, carrier, { x: 2, y: 7 });
    const ally = createTestUnit({ team: LEFT, name: "Squire", amountAlive: 40 });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 1, y: 7 });
    const enemy = createTestUnit({ team: RIGHT, name: "Troll", amountAlive: 10 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 9, y: 7 });
    const id = carrier.getId();
    const moveTo = (x: number, y: number): GameAction => ({
        type: "move_unit",
        unitId: id,
        path: [{ x, y }],
        targetCells: [{ x, y }],
    });
    return { ...combat, carrier, ally, enemy, id, moveTo };
}

describe("a19-carrier-cohesion-v2", () => {
    afterEach(() => {
        delete process.env.A19_CARRIER_COHESION_LEFT;
        delete process.env.A19_CARRIER_COHESION_RIGHT;
    });

    test("the alive blessings are exactly the mass buffs that last while their unit lives", () => {
        const fromData = Object.values(abilities as Record<string, unknown>)
            .filter(
                (value): value is { name: string; type: string; desc: string[] } =>
                    typeof value === "object" && value !== null && "name" in value,
            )
            .filter(
                (ability) =>
                    ability.type === "MASS_BUFF" && ability.desc.join(" ").startsWith("While this unit is alive"),
            )
            .map((ability) => ability.name)
            .sort();
        expect([...A19_ALIVE_BLESSINGS].sort()).toEqual(fromData);
    });

    test("a carrier is a unit with an active alive blessing; the principal one is the largest stack of its creature", () => {
        const b = board();
        expect(a19CarriesAliveBlessing(b.carrier)).toBe(true);
        expect(a19CarriesAliveBlessing(b.ally)).toBe(false);
        expect(a19IsPrincipalBlessingCarrier(b.carrier, b.unitsHolder)).toBe(true);
        const split = createTestUnit({
            team: LEFT,
            name: "Crusader",
            abilities: ["Sharpened Weapons Blessing"],
            amountAlive: 1,
        });
        placeUnit(b.grid, b.unitsHolder, split, { x: 2, y: 9 });
        expect(a19IsPrincipalBlessingCarrier(b.carrier, b.unitsHolder)).toBe(true);
        expect(a19IsPrincipalBlessingCarrier(split, b.unitsHolder)).toBe(false);
    });

    test("a move from the army to 4+ cells from every ally isolates the carrier in laps 1-3 only", () => {
        const b = board();
        expect(a19IsEarlyIsolatingCarrierMove(b.carrier, b.unitsHolder, 1, [b.moveTo(6, 7)])).toBe(true);
        const attack: GameAction[] = [
            b.moveTo(8, 7),
            { type: "melee_attack", attackerId: b.id, targetId: b.enemy.getId(), attackFrom: { x: 8, y: 7 } },
        ];
        expect(a19IsEarlyIsolatingCarrierMove(b.carrier, b.unitsHolder, 3, attack)).toBe(true);
        expect(a19IsEarlyIsolatingCarrierMove(b.carrier, b.unitsHolder, 4, attack)).toBe(false);
        expect(a19IsEarlyIsolatingCarrierMove(b.carrier, b.unitsHolder, 1, [b.moveTo(4, 7)])).toBe(false);
        expect(a19IsEarlyIsolatingCarrierMove(b.carrier, b.unitsHolder, 1, [{ type: "wait_turn", unitId: b.id }])).toBe(
            false,
        );
        expect(a19IsEarlyIsolatingCarrierMove(b.ally, b.unitsHolder, 1, [b.moveTo(8, 1)])).toBe(false);
    });

    test("a flying carrier is not held back (v2)", () => {
        const b = board();
        const flyer = createTestUnit({
            team: LEFT,
            name: "Manticore",
            abilities: ["Warding Mane Blessing"],
            amountAlive: 30,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(b.grid, b.unitsHolder, flyer, { x: 2, y: 9 });
        const id = flyer.getId();
        const dive: GameAction = {
            type: "move_unit",
            unitId: id,
            path: [{ x: 8, y: 9 }],
            targetCells: [{ x: 8, y: 9 }],
        };
        expect(a19IsPrincipalBlessingCarrier(flyer, b.unitsHolder)).toBe(true);
        expect(a19IsEarlyIsolatingCarrierMove(flyer, b.unitsHolder, 1, [dive])).toBe(false);
        expect(a19IsEarlyIsolatingCarrierMove(b.carrier, b.unitsHolder, 1, [b.moveTo(8, 7)])).toBe(true);
    });

    test("a carrier already away from its army is not held back", () => {
        const far = createCombatTestContext();
        const carrier = createTestUnit({
            team: LEFT,
            name: "Crusader",
            abilities: ["Sharpened Weapons Blessing"],
            amountAlive: 8,
        });
        placeUnit(far.grid, far.unitsHolder, carrier, { x: 7, y: 7 });
        const ally = createTestUnit({ team: LEFT, name: "Squire", amountAlive: 40 });
        placeUnit(far.grid, far.unitsHolder, ally, { x: 1, y: 7 });
        const move: GameAction = {
            type: "move_unit",
            unitId: carrier.getId(),
            path: [{ x: 9, y: 7 }],
            targetCells: [{ x: 9, y: 7 }],
        };
        expect(a19IsEarlyIsolatingCarrierMove(carrier, far.unitsHolder, 1, [move])).toBe(false);
    });

    test("a seat that bought the striker rush keeps charging with its carriers", () => {
        expect([A19_CARRIER_COHESION_RUSH_PLACEMENT, A19_CARRIER_COHESION_RUSH_MOVEMENT]).toEqual([
            A19_STRIKER_RUSH_PLACEMENT,
            A19_STRIKER_RUSH_MOVEMENT,
        ]);
        const fight = (placement: number, movement: number) => ({
            getAugmentPlacementLevel: () => placement,
            getAugmentMovement: () => movement,
        });
        expect(a19CarrierCohesionHoldsBack(LEFT, fight(0, 0))).toBe(true);
        expect(a19CarrierCohesionHoldsBack(LEFT, fight(2, 1))).toBe(true);
        expect(a19CarrierCohesionHoldsBack(LEFT, fight(1, 2))).toBe(true);
        expect(a19CarrierCohesionHoldsBack(LEFT, fight(2, 2))).toBe(false);
        process.env.A19_CARRIER_COHESION_RIGHT = "0";
        expect(a19CarrierCohesionHoldsBack(RIGHT, fight(0, 0))).toBe(false);
    });

    test("the switch is per seat and on unless set to 0", () => {
        expect([a19CarrierCohesionEnabled(LEFT), a19CarrierCohesionEnabled(RIGHT)]).toEqual([true, true]);
        process.env.A19_CARRIER_COHESION_LEFT = "0";
        expect([a19CarrierCohesionEnabled(LEFT), a19CarrierCohesionEnabled(RIGHT)]).toEqual([false, true]);
        process.env.A19_CARRIER_COHESION_LEFT = "1";
        expect(a19CarrierCohesionEnabled(LEFT)).toBe(true);
    });
});
