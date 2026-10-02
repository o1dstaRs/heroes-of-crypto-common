import { afterEach, describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

describe("Assimilating Chakram direct-hit verdicts", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const response of [false, true]) {
            for (const missed of [false, true]) {
                it(`team ${team}: ${response ? "counter" : "initiating double"} ${missed ? "MISS cannot" : "HIT can"} steal despite the AOE routing flag`, () => {
                    const context = createCombatTestContext();
                    const thief = createTestUnit({
                        name: "Arachna Queen",
                        team,
                        attackType: PBTypes.AttackVals.RANGE,
                        rangeShots: 8,
                        abilities: ["Chakram", "Predatory Assimilation", ...(response ? [] : ["Crafted Double Shot"])],
                        stackPower: 5,
                        amountAlive: 5,
                        maxHp: 1000,
                        exp: 100,
                    });
                    const donor = createTestUnit({
                        name: "Primary donor",
                        team: thief.getOppositeTeam(),
                        attackType: response ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                        rangeShots: response ? 8 : 0,
                        abilities: ["Heavy Armor"],
                        amountAlive: 5,
                        maxHp: 1000,
                        exp: 100,
                    });
                    const bounce = createTestUnit({
                        name: "Bounce donor",
                        team: donor.getTeam(),
                        abilities: ["Heavy Armor"],
                        footprintWidth: 1,
                        footprintHeight: 2,
                        amountAlive: 5,
                        maxHp: 1000,
                        exp: 100,
                    });
                    placeUnit(context.grid, context.unitsHolder, thief, { x: 8, y: 2 });
                    placeUnit(context.grid, context.unitsHolder, donor, { x: 8, y: 8 });
                    placeUnit(context.grid, context.unitsHolder, bounce, { x: 10, y: 8 });
                    thief.calculateAttackDamage = () => 10;
                    thief.calculateMissChance = () => (missed ? 100 : 0);
                    thief.calculateAbilityApplyChance = () => 100;
                    donor.calculateAttackDamage = () => 10;
                    donor.calculateMissChance = () => 0;
                    const attacker = response ? donor : thief;
                    const target = response ? thief : donor;
                    const visible = createVisibleDamage(target);
                    setDeterministicRandomSource(() => 0);

                    const result = context.attackHandler.handleRangeAttack(
                        context.unitsHolder,
                        [1],
                        1,
                        visible,
                        attacker,
                        [[target]],
                        response ? [donor] : undefined,
                        target.getPosition(),
                    );

                    expect(result.completed).toBe(true);
                    expect(visible.chakramFlights).toHaveLength(response ? 1 : 2);
                    expect(visible.chakramFlights?.every((flight) => flight.missed === missed)).toBe(true);
                    expect(result.abilityStolen ?? []).toEqual(
                        missed ? [] : [{ thiefId: thief.getId(), targetId: donor.getId(), abilityName: "Heavy Armor" }],
                    );
                    expect(thief.hasAbilityActive("Heavy Armor")).toBe(!missed);
                    expect(donor.hasAbilityActive("Heavy Armor")).toBe(missed);
                    expect(donor.getCumulativeHp()).toBe(5000 - (missed ? 0 : response ? 10 : 20));
                    // Bounces still damage their own target and never assimilate that target's card.
                    expect(bounce.getCumulativeHp()).toBe(5000 - (missed ? 0 : response ? 10 : 20));
                    expect(bounce.hasAbilityActive("Heavy Armor")).toBe(true);
                });
            }
        }

        it(`team ${team}: a bounce MISS preserves the primary's landed assimilation`, () => {
            const context = createCombatTestContext();
            const thief = createTestUnit({
                team,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 8,
                abilities: ["Chakram", "Predatory Assimilation"],
                stackPower: 5,
                amountAlive: 5,
                maxHp: 1000,
                exp: 100,
            });
            const primary = createTestUnit({
                team: thief.getOppositeTeam(),
                abilities: ["Heavy Armor"],
                amountAlive: 5,
                maxHp: 1000,
                exp: 100,
            });
            const bounce = createTestUnit({ team: primary.getTeam(), amountAlive: 5, maxHp: 1000, exp: 100 });
            placeUnit(context.grid, context.unitsHolder, thief, { x: 8, y: 2 });
            placeUnit(context.grid, context.unitsHolder, primary, { x: 8, y: 8 });
            placeUnit(context.grid, context.unitsHolder, bounce, { x: 10, y: 8 });
            thief.calculateAttackDamage = () => 10;
            thief.calculateMissChance = (victim) => (victim.getId() === bounce.getId() ? 100 : 0);
            thief.calculateAbilityApplyChance = () => 100;
            const visible = createVisibleDamage(primary);
            setDeterministicRandomSource(() => 0);

            const result = context.attackHandler.handleRangeAttack(
                context.unitsHolder,
                [1],
                1,
                visible,
                thief,
                [[primary]],
                undefined,
                primary.getPosition(),
            );

            expect(result.abilityStolen).toEqual([
                { thiefId: thief.getId(), targetId: primary.getId(), abilityName: "Heavy Armor" },
            ]);
            expect(primary.getCumulativeHp()).toBe(4990);
            expect(bounce.getCumulativeHp()).toBe(5000);
            expect(visible.chakramFlights?.[0].splash).toContainEqual(
                expect.objectContaining({ unitId: bounce.getId(), amount: 0, missed: true }),
            );
        });

        it(`team ${team}: Through Shot takes precedence over a coexisting Chakram without recording a disc`, () => {
            const context = createCombatTestContext();
            const attacker = createTestUnit({
                team,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 8,
                abilities: ["Through Shot", "Chakram"],
                stackPower: 5,
                amountAlive: 5,
                maxHp: 1000,
            });
            const target = createTestUnit({ team: attacker.getOppositeTeam(), amountAlive: 5, maxHp: 1000 });
            placeUnit(context.grid, context.unitsHolder, attacker, { x: 8, y: 2 });
            placeUnit(context.grid, context.unitsHolder, target, { x: 8, y: 8 });
            attacker.calculateAttackDamage = () => 10;
            attacker.calculateMissChance = () => 0;
            const visible = createVisibleDamage(target);
            setDeterministicRandomSource(() => 0);

            const result = context.attackHandler.handleRangeAttack(
                context.unitsHolder,
                [1],
                1,
                visible,
                attacker,
                [[target]],
                undefined,
                target.getPosition(),
            );

            expect(result.completed).toBe(true);
            expect(result.animationData).toHaveLength(1);
            expect(target.getCumulativeHp()).toBe(4990);
            expect(visible.chakramFlights).toEqual([]);
            expect(visible.chakramArcs ?? []).toEqual([]);
        });
    }
});
