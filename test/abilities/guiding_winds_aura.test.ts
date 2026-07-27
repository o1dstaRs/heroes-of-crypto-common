/*
 * -----------------------------------------------------------------------------
 * The Dryad's Guiding Winds Aura: ranged allies standing in range shoot further, by a
 * percentage of their OWN base shot distance.
 *
 * The aura replaced the Dryad's Poison Cloud. Unlike Rallying Volley (a one-off grant
 * tracked on the unit), this one is recomputed off initialUnitProperties on every stat
 * pass, so it must neither compound across refreshes nor survive leaving the aura.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getAbilityConfig, getAuraEffectConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { AuraEffect } from "../../src/effects/aura_effect";
import { GUIDING_WINDS_MAX_PERCENT } from "../../src/constants";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const AURA_PERCENT = getAbilityConfig("Guiding Winds Aura").power;
const ARCHER_SHOT_DISTANCE = 6.5;
// The engine rounds the boosted distance to two decimals (roundUnitStat), so compute the expectation the
// same way rather than comparing against an unrounded ideal.
const BOOSTED_SHOT_DISTANCE =
    Math.round((ARCHER_SHOT_DISTANCE + (ARCHER_SHOT_DISTANCE / 100) * AURA_PERCENT) * 100) / 100;

const makeDryad = () =>
    createTestUnit({
        name: "Dryad",
        team: PBTypes.TeamVals.LOWER,
        // Guiding Winds is stack-powered: a FULL stack projects exactly the configured percent, which is
        // what the shot-distance expectations below are written against.
        stackPower: 5,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        shotDistance: ARCHER_SHOT_DISTANCE,
        abilities: ["Guiding Winds Aura"],
        auraEffects: ["Guiding Winds"],
        auraRanges: [2],
        auraIsBuff: [true],
    });

const makeArcher = (name: string) =>
    createTestUnit({
        name,
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 5,
        shotDistance: ARCHER_SHOT_DISTANCE,
    });

describe("Guiding Winds Aura", () => {
    it("is a stack-powered 2-cell buff aura whose full stack projects the configured percent", () => {
        const aura = getAuraEffectConfig("Guiding Winds");
        expect(aura?.range).toBe(2);
        expect(aura?.is_buff).toBe(true);
        // 5/10/15/20/25 across the stack tiers, plus the owner's luck, held to GUIDING_WINDS_MAX_PERCENT.
        expect(AURA_PERCENT).toBe(25);
    });

    it("scales with the owner's stack and luck, floored at 0 and capped", () => {
        const projected = (stackPower: number, luck: number) => {
            const owner = createTestUnit({ name: "Dryad", team: PBTypes.TeamVals.LOWER, stackPower, luck });
            return Math.round(owner.calculateAuraPower(new AuraEffect(getAuraEffectConfig("Guiding Winds")!)));
        };
        expect([1, 2, 3, 4, 5].map((stack) => projected(stack, 0))).toEqual([5, 10, 15, 20, 25]);
        // Luck lifts it, and a full stack at maximum luck lands exactly on the cap rather than past it.
        expect(projected(5, 10)).toBe(GUIDING_WINDS_MAX_PERCENT);
        expect(projected(3, 5)).toBe(20);
        // Never negative, however unlucky the owner.
        expect(projected(1, -10)).toBe(0);
    });

    it("extends the shot distance of a ranged ally in range, and only that ally", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const dryad = makeDryad();
        const nearArcher = makeArcher("Near Archer");
        const farArcher = makeArcher("Far Archer");
        const meleeAlly = createTestUnit({
            name: "Melee Ally",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE,
            shotDistance: ARCHER_SHOT_DISTANCE,
        });

        placeUnit(grid, unitsHolder, dryad, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, nearArcher, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, meleeAlly, { x: 2, y: 3 });
        placeUnit(grid, unitsHolder, farArcher, { x: 9, y: 9 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        expect(nearArcher.getAppliedAuraEffect("Guiding Winds Aura")?.getPower()).toBe(AURA_PERCENT);
        expect(nearArcher.getRangeShotDistance()).toBe(BOOSTED_SHOT_DISTANCE);
        // Shot range means nothing to a unit that cannot shoot, so melee allies are skipped entirely.
        expect(meleeAlly.getAppliedAuraEffect("Guiding Winds Aura")).toBeUndefined();
        // Out of range: no aura, no extra distance.
        expect(farArcher.getRangeShotDistance()).toBe(ARCHER_SHOT_DISTANCE);
        // The Dryad stands in its own aura.
        expect(dryad.getRangeShotDistance()).toBe(BOOSTED_SHOT_DISTANCE);
    });

    it("does not compound across aura refreshes", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const dryad = makeDryad();
        const archer = makeArcher("Archer");
        placeUnit(grid, unitsHolder, dryad, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });

        for (let refresh = 0; refresh < 4; refresh += 1) {
            unitsHolder.refreshAuraEffectsForAllUnits();
            unitsHolder.refreshStackPowerForAllUnits();
        }

        expect(archer.getRangeShotDistance()).toBe(BOOSTED_SHOT_DISTANCE);
    });

    it("is given up when the archer walks out of the aura", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const dryad = makeDryad();
        const archer = makeArcher("Archer");
        placeUnit(grid, unitsHolder, dryad, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 2 });

        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();
        expect(archer.getRangeShotDistance()).toBe(BOOSTED_SHOT_DISTANCE);

        grid.cleanupAll(archer.getId(), archer.getAttackRange(), archer.isSmallSize());
        placeUnit(grid, unitsHolder, archer, { x: 9, y: 9 });
        unitsHolder.refreshAuraEffectsForAllUnits();
        unitsHolder.refreshStackPowerForAllUnits();

        expect(archer.getAppliedAuraEffect("Guiding Winds Aura")).toBeUndefined();
        expect(archer.getRangeShotDistance()).toBe(ARCHER_SHOT_DISTANCE);
    });
});

describe("Dryad", () => {
    it("carries Guiding Winds instead of the poison aura", () => {
        const dryad = getCreatureConfig(PBTypes.TeamVals.LOWER, "Nature", "Dryad", "dryad_512", 1, 0);
        expect(dryad.abilities).toEqual(["Guiding Winds Aura", "Hamstring"]);
    });
});
