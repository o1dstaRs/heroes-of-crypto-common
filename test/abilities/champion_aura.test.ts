import { expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

for (const amount of [1, 100]) {
    test(`Champion's default three-cell aura grants a fixed +2 to walking allies at stack size ${amount}`, () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const team = PBTypes.TeamVals.LEFT;
        const properties = getCreatureConfig(team, "Life", "Champion", "champion_512", amount);
        const effects = new EffectFactory();
        const champion = Unit.createUnit(
            properties,
            testGridSettings,
            team,
            properties.unit_type,
            new AbilityFactory(effects),
            effects,
            false,
        );
        const aura = "Tie up the Horses Aura";
        const index = properties.abilities.indexOf(aura);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(properties.abilities_auras[index]).toBe(true);
        expect(properties.abilities_stack_powered[index]).toBe(false);
        expect(properties.aura_ranges[index]).toBe(3);
        expect(champion.getAuraEffect("Tie up the Horses")?.getRange()).toBe(3);

        const edge = createTestUnit({ team });
        const oppositeEdge = createTestUnit({ team });
        const diagonal = createTestUnit({ team });
        const outside = createTestUnit({ team });
        const flyer = createTestUnit({ team, movementType: PBTypes.MovementVals.FLY });
        const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
        const baseSteps = edge.getSteps();
        placeUnit(grid, unitsHolder, champion, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, edge, { x: 8, y: 5 });
        placeUnit(grid, unitsHolder, oppositeEdge, { x: 1, y: 4 });
        placeUnit(grid, unitsHolder, diagonal, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, outside, { x: 9, y: 5 });
        placeUnit(grid, unitsHolder, flyer, { x: 7, y: 5 });
        placeUnit(grid, unitsHolder, enemy, { x: 6, y: 5 });

        for (let refresh = 0; refresh < 2; refresh++) {
            unitsHolder.refreshStackPowerForAllUnits();
            for (const ally of [edge, oppositeEdge, diagonal]) {
                expect(ally.getBuff(aura)?.getPower()).toBe(2);
                expect(ally.getSteps()).toBeCloseTo(baseSteps + 2);
            }
            for (const excluded of [outside, flyer, enemy]) {
                expect(excluded.hasBuffActive(aura)).toBe(false);
                expect(excluded.getSteps()).toBe(baseSteps);
            }
        }

        champion.applyEffect(effects.makeEffect("Break")!);
        unitsHolder.refreshStackPowerForAllUnits();
        expect(edge.hasBuffActive(aura)).toBe(false);
        expect(edge.getSteps()).toBe(baseSteps);
        champion.deleteEffect("Break");
        unitsHolder.refreshStackPowerForAllUnits();
        expect(edge.getBuff(aura)?.getPower()).toBe(2);
        expect(edge.getSteps()).toBeCloseTo(baseSteps + 2);
    });
}
