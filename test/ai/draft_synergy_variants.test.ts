import { describe, expect, it } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    RANKED_DRAFT_SYNERGY_VARIANT_PICK_SUCCESS,
    rankedDraftSynergyVariantMarginalPp,
} from "../../src/ai/setup/draft_synergy_variants";
import { rankedDraftStrengthScore, rankedDraftSynergyVariantScale } from "../../src/ai/setup/draft_strength_prior";
import { LifeSynergy, NatureSynergy } from "../../src/synergies/synergy_properties";

const id = (name: string): number => {
    const creatureId = creatureIdForName(name);
    if (creatureId === undefined) throw new Error(`unknown creature ${name}`);
    return creatureId;
};

// Life creatures: Peasant (L1), Battle Mage (L2), Monk (L3), Tsar Cannon (L4); Nature: Dryad (L1), Elf (L2).
const PEASANT = id("Peasant");
const BATTLE_MAGE = id("Battle Mage");
const MONK = id("Monk");
const TSAR_CANNON = id("Tsar Cannon");
const DRYAD = id("Dryad");
const ELF = id("Elf");

const TABLE = { [`Life:${LifeSynergy.PLUS_SUPPLY_PERCENTAGE}`]: [4, 10, 10] as const };
const SUPPLY = { Life: LifeSynergy.PLUS_SUPPLY_PERCENTAGE, Nature: NatureSynergy.PLUS_FLY_ARMOR };
const MORALE = { Life: LifeSynergy.PLUS_MORALE_AND_LUCK, Nature: NatureSynergy.PLUS_FLY_ARMOR };

describe("variant-aware synergy value (P16/P17, research, default off)", () => {
    it("is worth nothing without variants, off-table, or for a creature already drafted", () => {
        expect(rankedDraftSynergyVariantMarginalPp(BATTLE_MAGE, [PEASANT], undefined, TABLE)).toBe(0);
        expect(rankedDraftSynergyVariantMarginalPp(BATTLE_MAGE, [PEASANT], MORALE, TABLE)).toBe(0);
        expect(rankedDraftSynergyVariantMarginalPp(ELF, [DRYAD], SUPPLY, TABLE)).toBe(0);
        expect(rankedDraftSynergyVariantMarginalPp(PEASANT, [PEASANT], SUPPLY, TABLE)).toBe(0);
        // The shipped table is empty, so the default lookup changes no draft.
        expect(rankedDraftSynergyVariantMarginalPp(BATTLE_MAGE, [PEASANT], SUPPLY)).toBe(0);
    });

    it("pays a level's increment when the pick reaches it and option value one creature short", () => {
        // Second Life creature reaches level 1.
        expect(rankedDraftSynergyVariantMarginalPp(BATTLE_MAGE, [PEASANT], SUPPLY, TABLE)).toBe(4);
        // Fourth reaches level 2: the increment over level 1.
        expect(rankedDraftSynergyVariantMarginalPp(TSAR_CANNON, [PEASANT, BATTLE_MAGE, MONK], SUPPLY, TABLE)).toBe(6);
        // First Life creature with five picks left after it: level 1 times the chance they complete it.
        const five = 1 - (1 - RANKED_DRAFT_SYNERGY_VARIANT_PICK_SUCCESS) ** 5;
        expect(rankedDraftSynergyVariantMarginalPp(PEASANT, [], SUPPLY, TABLE)).toBeCloseTo(five * 4, 10);
        // Third Life creature (level 1 already held): the next increment, discounted by the remaining picks.
        const two = 1 - (1 - RANKED_DRAFT_SYNERGY_VARIANT_PICK_SUCCESS) ** 2;
        expect(rankedDraftSynergyVariantMarginalPp(MONK, [PEASANT, BATTLE_MAGE, DRYAD], SUPPLY, TABLE)).toBeCloseTo(
            two * 6,
            10,
        );
    });

    it("only the -sv ids read variants, and without variants they score like the base id", () => {
        expect(rankedDraftSynergyVariantScale("ranked-unit-strength-a19-side-v4-w16-r4-sv")).toBe(1);
        expect(rankedDraftSynergyVariantScale("ranked-unit-strength-a19-side-v4-w16-r4-sv2")).toBe(2);
        expect(rankedDraftSynergyVariantScale("ranked-unit-strength-a19-side-v4-w16-r4")).toBe(0);
        for (const creatureId of [PEASANT, BATTLE_MAGE, DRYAD, ELF]) {
            expect(
                rankedDraftStrengthScore(creatureId, "ranked-unit-strength-a19-side-v4-w16-r4-sv", {
                    ownCreatureIds: [PEASANT],
                }),
            ).toBe(
                rankedDraftStrengthScore(creatureId, "ranked-unit-strength-a19-side-v4-w16-r4", {
                    ownCreatureIds: [PEASANT],
                }),
            );
        }
    });
});
