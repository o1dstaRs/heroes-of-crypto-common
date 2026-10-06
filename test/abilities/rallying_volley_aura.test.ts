/*
 * -----------------------------------------------------------------------------
 * Zena's Rallying Volley Blessing: every ranged ally, including Zena, receives a
 * once-only flat top-up anywhere on the board.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getAbilityConfig } from "../../src/configuration/config_provider";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";
import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { MAX_UNIT_STACK_POWER } from "../../src/constants";
import { Unit } from "../../src/units/unit";

const BLESSING_SHOTS = getAbilityConfig("Rallying Volley Blessing").power;

const makeZena = () =>
    createTestUnit({
        name: "Zena",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: ["Rallying Volley Blessing"],
    });

const makeArcher = (name: string) =>
    createTestUnit({
        name,
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 5,
    });

describe("Rallying Volley Blessing", () => {
    it("is configured as a flat, non-stack-powered grant", () => {
        expect(BLESSING_SHOTS).toBe(2);
        expect(getAbilityConfig("Rallying Volley Blessing").stack_powered).toBe(false);
    });

    it("tops up every ranged ally, including the bearer and distant allies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = makeZena();
        const nearArcher = makeArcher("Near Archer");
        const farArcher = makeArcher("Far Archer");
        const meleeAlly = createTestUnit({
            name: "Melee Ally",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
        });

        placeUnit(grid, unitsHolder, zena, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, nearArcher, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, meleeAlly, { x: 2, y: 3 });
        placeUnit(grid, unitsHolder, farArcher, { x: 9, y: 9 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        // The board-wide marker carries the flat configured shot count.
        expect(nearArcher.getBuff("Rallying Volley Blessing")?.getPower()).toBe(BLESSING_SHOTS);
        expect(nearArcher.getRangeShots()).toBe(5 + BLESSING_SHOTS);
        // Every ally carries the marker, but melee-only units receive no ammunition.
        expect(meleeAlly.getBuff("Rallying Volley Blessing")?.getPower()).toBe(BLESSING_SHOTS);
        expect(meleeAlly.getRangeShots()).toBe(0);
        // Board-wide reach, and the source receives its own top-up.
        expect(farArcher.getRangeShots()).toBe(5 + BLESSING_SHOTS);
        expect(zena.getRangeShots()).toBe(8 + BLESSING_SHOTS);
    });

    it("tops the quiver up once, however many times blessings refresh", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = makeZena();
        const archer = makeArcher("Archer");
        placeUnit(grid, unitsHolder, zena, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });

        for (let refresh = 0; refresh < 4; refresh += 1) {
            unitsHolder.refreshAuraEffectsForAllUnits();
            unitsHolder.refreshStackPowerForAllUnits();
        }

        // The ledger prevents any refresh from handing out another pair of arrows.
        expect(archer.getRangeShots()).toBe(5 + BLESSING_SHOTS);
        expect(archer.getUnitProperties().rallying_volley_granted).toBe(BLESSING_SHOTS);
    });

    it("never refills shots that were already fired", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = makeZena();
        const archer = makeArcher("Archer");
        placeUnit(grid, unitsHolder, zena, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(5 + BLESSING_SHOTS);

        // Spend the granted shots, then refresh: the quiver is topped up once, never refilled.
        archer.decreaseNumberOfShots();
        archer.decreaseNumberOfShots();
        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(5);
    });
});

// A Limited Supply archer only carries a stack-power fraction of its own quiver, and that ceiling is derived
// from maxRangeShots — the archer's OWN arrows. The rally's arrows are not the archer's, so they belong on
// top of the cap. Before this, the blessing handed an Arbalester two arrows and the cap clamped them straight
// back off, while rallying_volley_granted still recorded the grant as spent — and because the top-up is
// once-only, it could never be handed over again. That is what "Rallying Volley does nothing" looked like.
//
// Built from the real creature configs rather than the synthetic helper: only a real Ability carries the
// Limited Supply power type the clamp keys off, so the synthetic path cannot reproduce this at all.
describe("Rallying Volley Blessing vs Limited Supply", () => {
    it("adds its shots on top of Arbalester's supply cap instead of being clamped away", () => {
        const ctx = createCombatTestContext();
        const effectFactory = new EffectFactory();
        const abilityFactory = new AbilityFactory(effectFactory);
        const build = (faction: string, name: string, texture: string, amount: number) =>
            Unit.createUnit(
                getCreatureConfig(PBTypes.TeamVals.LEFT, faction, name, texture, amount, 0),
                ctx.grid.getSettings(),
                PBTypes.TeamVals.LEFT,
                PBTypes.UnitVals.CREATURE,
                abilityFactory,
                effectFactory,
                false,
            );

        const zena = build("Might", "Zena", "zena_512", 15);
        const arbalester = build("Life", "Arbalester", "arbalester_512", 50);
        ctx.unitsHolder.addUnit(zena);
        ctx.unitsHolder.addUnit(arbalester);
        placeUnit(ctx.grid, ctx.unitsHolder, zena, { x: 3, y: 3 });
        placeUnit(ctx.grid, ctx.unitsHolder, arbalester, { x: 4, y: 3 });

        const ownQuiver = arbalester.getRangeShots();
        expect(arbalester.hasAbilityActive("Limited Supply")).toBe(true);

        ctx.unitsHolder.refreshAuraEffectsForAllUnits();
        ctx.unitsHolder.refreshStackPowerForAllUnits();

        const granted = getAbilityConfig("Rallying Volley Blessing").power;
        const cap = Math.floor((ownQuiver * arbalester.getStackPower()) / MAX_UNIT_STACK_POWER);
        // The archer keeps its capped share of its OWN arrows and the rally's on top — never fewer than the
        // cap alone, which is what the clamp used to leave it with.
        expect(arbalester.getRangeShots()).toBe(cap + granted);
        expect(arbalester.getRangeShots()).toBeGreaterThan(cap);
    });
});
