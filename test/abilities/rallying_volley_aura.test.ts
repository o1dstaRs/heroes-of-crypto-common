/*
 * -----------------------------------------------------------------------------
 * Zena's Rallying Volley Aura: ranged allies standing in range have their quiver
 * topped up ONCE by a flat number of shots.
 *
 * Regression guard: ADDITIONAL_RANGE_SHOTS was missing from calculateAuraPower, so
 * it fell through to that function's percentage tail and resolved to a power of 0.
 * The aura was applied to the right units and still granted them nothing.
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

const AURA_SHOTS = getAbilityConfig("Rallying Volley Aura").power;

const makeZena = () =>
    createTestUnit({
        name: "Zena",
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: ["Rallying Volley Aura"],
        auraEffects: ["Rallying Volley"],
        auraRanges: [2],
        auraIsBuff: [true],
    });

const makeArcher = (name: string) =>
    createTestUnit({
        name,
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 5,
    });

describe("Rallying Volley Aura", () => {
    it("is configured as a flat, non-stack-powered grant", () => {
        expect(AURA_SHOTS).toBe(2);
        expect(getAbilityConfig("Rallying Volley Aura").stack_powered).toBe(false);
    });

    it("tops up a ranged ally standing in range, and only that ally", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = makeZena();
        const nearArcher = makeArcher("Near Archer");
        const farArcher = makeArcher("Far Archer");
        const meleeAlly = createTestUnit({
            name: "Melee Ally",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE,
        });

        placeUnit(grid, unitsHolder, zena, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, nearArcher, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, meleeAlly, { x: 2, y: 3 });
        placeUnit(grid, unitsHolder, farArcher, { x: 9, y: 9 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        // The aura resolves to its configured power rather than the 0 the percentage tail produced.
        expect(nearArcher.getAppliedAuraEffect("Rallying Volley Aura")?.getPower()).toBe(AURA_SHOTS);
        expect(nearArcher.getRangeShots()).toBe(5 + AURA_SHOTS);
        // Extra shots mean nothing to a unit that cannot shoot, so melee allies are skipped entirely.
        expect(meleeAlly.getAppliedAuraEffect("Rallying Volley Aura")).toBeUndefined();
        // Out of range: no aura, no shots.
        expect(farArcher.getRangeShots()).toBe(5);
    });

    it("tops the quiver up once, however many times auras refresh", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = makeZena();
        const archer = makeArcher("Archer");
        placeUnit(grid, unitsHolder, zena, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });

        for (let refresh = 0; refresh < 4; refresh += 1) {
            unitsHolder.refreshAuraEffectsForAllUnits();
            unitsHolder.refreshStackPowerForAllUnits();
        }

        // A plain "+N while in range" would re-gift on every refresh; the grant is tracked instead.
        expect(archer.getRangeShots()).toBe(5 + AURA_SHOTS);
        expect(archer.getUnitProperties().rallying_volley_granted).toBe(AURA_SHOTS);
    });

    it("never refills shots that were already fired", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const zena = makeZena();
        const archer = makeArcher("Archer");
        placeUnit(grid, unitsHolder, zena, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(5 + AURA_SHOTS);

        // Spend the granted shots, then let the aura refresh again: the quiver is topped up, never refilled.
        archer.decreaseNumberOfShots();
        archer.decreaseNumberOfShots();
        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShots()).toBe(5);
    });
});

// A Limited Supply archer only carries a stack-power fraction of its own quiver, and that ceiling is derived
// from maxRangeShots — the archer's OWN arrows. The rally's arrows are not the archer's, so they belong on
// top of the cap. Before this, the aura handed an Arbalester two arrows and the cap clamped them straight
// back off, while rallying_volley_granted still recorded the grant as spent — and because the top-up is
// once-only, it could never be handed over again. That is what "Rallying Volley does nothing" looked like.
//
// Built from the real creature configs rather than the synthetic helper: only a real Ability carries the
// Limited Supply power type the clamp keys off, so the synthetic path cannot reproduce this at all.
describe("Rallying Volley Aura vs Limited Supply", () => {
    it("adds its shots on top of Arbalester's supply cap instead of being clamped away", () => {
        const ctx = createCombatTestContext();
        const effectFactory = new EffectFactory();
        const abilityFactory = new AbilityFactory(effectFactory);
        const build = (faction: string, name: string, texture: string, amount: number) =>
            Unit.createUnit(
                getCreatureConfig(PBTypes.TeamVals.LOWER, faction, name, texture, amount, 0),
                ctx.grid.getSettings(),
                PBTypes.TeamVals.LOWER,
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

        const granted = getAbilityConfig("Rallying Volley Aura").power;
        const cap = Math.floor((ownQuiver * arbalester.getStackPower()) / MAX_UNIT_STACK_POWER);
        // The archer keeps its capped share of its OWN arrows and the rally's on top — never fewer than the
        // cap alone, which is what the clamp used to leave it with.
        expect(arbalester.getRangeShots()).toBe(cap + granted);
        expect(arbalester.getRangeShots()).toBeGreaterThan(cap);
    });
});
