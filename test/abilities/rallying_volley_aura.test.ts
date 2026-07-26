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
