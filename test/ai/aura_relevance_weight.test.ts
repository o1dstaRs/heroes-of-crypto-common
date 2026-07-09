/*
 * -----------------------------------------------------------------------------
 * v0.6 aura-relevance weighting: Griffin's Range Null Field aura (DISABLE_RANGE_ATTACK) only silences enemy
 * SHOOTERS, so the bearer should value covering ranged enemies (by stack size) and ignore melee enemies.
 * Other auras (War Anger etc.) keep the flat +1-per-target count.
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "bun:test";

import { auraRelevanceWeight } from "../../src/ai/ai";
import { AbilityPowerType } from "../../src/abilities/ability_properties";
import type { AuraEffect } from "../../src/effects/aura_effect";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createTestUnit } from "../helpers/combat";

const rangeNullAura = { getPowerType: () => AbilityPowerType.DISABLE_RANGE_ATTACK } as unknown as AuraEffect;
const warAngerAura = {
    getPowerType: () => AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE,
} as unknown as AuraEffect;

const shooter = createTestUnit({
    name: "Shooter",
    team: PBTypes.TeamVals.UPPER,
    attackType: PBTypes.AttackVals.RANGE,
    amountAlive: 12,
});
const meleeEnemy = createTestUnit({
    name: "Bruiser",
    team: PBTypes.TeamVals.UPPER,
    attackType: PBTypes.AttackVals.MELEE,
    amountAlive: 30,
});

describe("auraRelevanceWeight (v0.6 aura positioning)", () => {
    it("range-null aura: values a shooter by its stack size, ignores melee", () => {
        expect(auraRelevanceWeight(shooter, rangeNullAura)).toBe(12);
        expect(auraRelevanceWeight(meleeEnemy, rangeNullAura)).toBe(0);
    });

    it("non-range auras (War Anger etc.) keep the flat count", () => {
        expect(auraRelevanceWeight(shooter, warAngerAura)).toBe(1);
        expect(auraRelevanceWeight(meleeEnemy, warAngerAura)).toBe(1);
    });
});
