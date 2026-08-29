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

import { afterEach, describe, expect, it } from "bun:test";

import abilitiesJson from "../../src/configuration/abilities.json";
import { evaluateAffectedUnits } from "../../src/abilities/aoe_range_ability";
import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const RED = PBTypes.TeamVals.UPPER;
const GREEN = PBTypes.TeamVals.LOWER;
const RANGE = PBTypes.AttackVals.RANGE;
const WINGSHIELD = "Arrows Wingshield Blessing";

/**
 * The Angel's card promises two things beyond its army-wide buff: "The owner is immune to being shot through
 * and does not propagate AOE range damage." Both were written on the card long before anything enforced
 * them — a Gargantuan blast splashed straight past the Angel and a Tsar Cannon shot pierced clean
 * through him.
 */
describe("Arrows Wingshield — the Angel is a barrier, not just a buff", () => {
    it("still says so on the card", () => {
        const card = (abilitiesJson as unknown as Record<string, { desc: string[] }>)[WINGSHIELD];
        expect(card.desc.join(" ")).toContain("immune to being shot through");
        expect(card.desc.join(" ")).toContain("does not propagate AOE range damage");
    });

    it("soaks an area blast so nobody around him is splashed", () => {
        const context = createCombatTestContext();
        const angel = createTestUnit({ name: "Angel", team: RED, abilities: [WINGSHIELD] });
        const bystanderA = createTestUnit({ name: "BystanderA", team: RED });
        const bystanderB = createTestUnit({ name: "BystanderB", team: RED });
        placeUnit(context.grid, context.unitsHolder, angel, { x: 8, y: 8 });
        placeUnit(context.grid, context.unitsHolder, bystanderA, { x: 9, y: 8 });
        placeUnit(context.grid, context.unitsHolder, bystanderB, { x: 8, y: 9 });

        const blast = [
            { x: 8, y: 8 },
            { x: 9, y: 8 },
            { x: 8, y: 9 },
        ];
        const affected = evaluateAffectedUnits(blast, context.unitsHolder, context.grid);

        // He takes it; the blast goes no further.
        expect(affected?.[0]?.map((unit) => unit.getName())).toEqual(["Angel"]);
    });

    it("leaves an ordinary blast splashing everyone, so only the Angel changes it", () => {
        const context = createCombatTestContext();
        const first = createTestUnit({ name: "First", team: RED });
        const second = createTestUnit({ name: "Second", team: RED });
        placeUnit(context.grid, context.unitsHolder, first, { x: 8, y: 8 });
        placeUnit(context.grid, context.unitsHolder, second, { x: 9, y: 8 });

        const affected = evaluateAffectedUnits(
            [
                { x: 8, y: 8 },
                { x: 9, y: 8 },
            ],
            context.unitsHolder,
            context.grid,
        );

        expect(affected?.[0]?.map((unit) => unit.getName()).sort()).toEqual(["First", "Second"]);
    });

    it("two Angels in one blast both soak it and neither passes it on", () => {
        const context = createCombatTestContext();
        const angelA = createTestUnit({ name: "AngelA", team: RED, abilities: [WINGSHIELD] });
        const angelB = createTestUnit({ name: "AngelB", team: RED, abilities: [WINGSHIELD] });
        const bystander = createTestUnit({ name: "Bystander", team: RED });
        placeUnit(context.grid, context.unitsHolder, angelA, { x: 8, y: 8 });
        placeUnit(context.grid, context.unitsHolder, angelB, { x: 9, y: 8 });
        placeUnit(context.grid, context.unitsHolder, bystander, { x: 8, y: 9 });

        const affected = evaluateAffectedUnits(
            [
                { x: 8, y: 8 },
                { x: 9, y: 8 },
                { x: 8, y: 9 },
            ],
            context.unitsHolder,
            context.grid,
        );

        expect(affected?.[0]?.map((unit) => unit.getName()).sort()).toEqual(["AngelA", "AngelB"]);
    });

    describe("a Through Shot stops in his shield", () => {
        afterEach(() => setDeterministicRandomSource(undefined));

        /** Fire a pierce down a lane of `wall` then `behind`, and report who actually took damage. */
        const pierceThrough = (wallAbilities: string[]): string[] => {
            const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
            const shooter = createTestUnit({
                name: "TsarCannon",
                team: RED,
                attackType: RANGE,
                attack: 10,
                damageMin: 7,
                damageMax: 7,
                amountAlive: 5,
                stackPower: 5,
                rangeShots: 9,
                shotDistance: 30,
                abilities: ["Through Shot"],
            });
            shooter.calculateMissChance = () => 0;
            const wall = createTestUnit({
                name: "Wall",
                team: GREEN,
                armor: 20,
                maxHp: 1_000_000,
                amountAlive: 4,
                abilities: wallAbilities,
            });
            const behind = createTestUnit({ name: "Behind", team: GREEN, armor: 20, maxHp: 1_000_000, amountAlive: 4 });
            placeUnit(grid, unitsHolder, shooter, { x: 5, y: 9 });
            placeUnit(grid, unitsHolder, wall, { x: 5, y: 7 });
            placeUnit(grid, unitsHolder, behind, { x: 5, y: 5 });

            setDeterministicRandomSource(() => 0);
            const result = processThroughShotAbility(
                shooter,
                [[wall], [behind]],
                shooter,
                [1, 1],
                behind.getPosition(),
                unitsHolder,
                grid,
                new SceneLogMock(),
                damageStatisticHolder,
            );
            const byId = new Map([wall, behind].map((unit) => [unit.getId(), unit.getName()]));
            return result.perUnitDamage.map((entry) => byId.get(entry.unitId) ?? entry.unitId);
        };

        it("pierces clean through an ordinary unit to whatever stands behind it", () => {
            expect(pierceThrough([])).toEqual(["Wall", "Behind"]);
        });

        it("hits the Angel but spares what stands behind him", () => {
            // He is shot AT, so he takes this hit; the bolt just does not carry on down the lane.
            expect(pierceThrough([WINGSHIELD])).toEqual(["Wall"]);
        });
    });
});
