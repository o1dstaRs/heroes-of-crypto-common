import { describe, expect, it } from "bun:test";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    premiumDraftSupportProfile,
    premiumDraftSupportDifference,
} from "../../src/simulation/premium_draft_support_features";

const c = PBTypes.CreatureVals;
const prefix = [c.PEASANT, c.ORC, c.HEALER, c.SATYR, c.ZENA];
const enemy = [c.SCAVENGER, c.ARBALESTER, c.HARPY, c.ELF, c.MONK, c.GARGANTUAN];
const fields = (ids: number[]) => {
    const p = premiumDraftSupportProfile(ids, enemy);
    return Object.fromEntries(p.featureNames.map((name, i) => [name, p.values[i]]));
};

describe("research draft support descriptors", () => {
    it("represents Angel's direct-cast resurrection separately from native healing and damage", () => {
        const angel = fields([...prefix, c.ANGEL]);
        const hydra = fields([...prefix, c.HYDRA]);
        expect(angel.resurrectionSources).toBe(1);
        expect(angel.resurrectionHpPerExperience).toBeCloseTo(180 / 500);
        expect(hydra.resurrectionSources).toBe(0);
        expect(hydra.resurrectableCasterHpPerExperience).toBe(0);
        expect(angel.resurrectableCasterHpPerExperience).toBeGreaterThan(0);
        expect(angel.healingCharges).toBeCloseTo(4 / 12);
        expect(angel.massHealingCharges).toBeCloseTo(3 / 12);
        expect(angel.damageSpellCharges).toBe(0);
    });

    it("counts front-creature healing opportunity without mistaking a machine or magic immunity for a recipient", () => {
        const base = [c.PEASANT, c.ORC, c.HEALER, c.SATYR, c.ANGEL];
        const cannon = fields([...base, c.TSAR_CANNON]);
        const blackDragon = fields([...base, c.BLACK_DRAGON]);
        const abomination = fields([...base, c.ABOMINATION]);
        expect(cannon.healRecipientBodyHp).toBeCloseTo(blackDragon.healRecipientBodyHp);
        // Use a recipient with more HP than the Angel already in the base roster. Hydra now ties it.
        expect(abomination.healRecipientBodyHp).toBeGreaterThan(cannon.healRecipientBodyHp);
        const cannonHp = creatureInfo(c.TSAR_CANNON)!.hp / creatureInfo(c.TSAR_CANNON)!.exp;
        const sumHp = [...base, c.TSAR_CANNON].reduce((s, id) => s + creatureInfo(id)!.hp / creatureInfo(id)!.exp, 0);
        expect(cannon.resurrectableAllyHpPerExperience).toBeCloseTo((sumHp - cannonHp) / 6);
    });

    it("preserves exact pair antisymmetry, no-change zero, roster permutation and input immutability", () => {
        const before = structuredClone({ prefix, enemy });
        const a = premiumDraftSupportDifference(prefix, enemy, c.ANGEL, c.HYDRA);
        const b = premiumDraftSupportDifference(prefix, enemy, c.HYDRA, c.ANGEL);
        a.values.forEach((v, i) => expect(v + b.values[i]).toBe(0));
        expect(premiumDraftSupportDifference(prefix, enemy, c.ANGEL, c.ANGEL).values.every((v) => v === 0)).toBe(true);
        expect(premiumDraftSupportDifference([...prefix].reverse(), [...enemy].reverse(), c.ANGEL, c.HYDRA)).toEqual(a);
        expect({ prefix, enemy }).toEqual(before);
    });

    it("rejects partial, duplicate or unknown rosters and covers every legal level-four kit", () => {
        expect(() => premiumDraftSupportProfile([...prefix, c.ANGEL], enemy.slice(0, 3))).toThrow();
        expect(() => premiumDraftSupportProfile([...prefix, c.PEASANT], enemy)).toThrow();
        expect(() => premiumDraftSupportProfile([...prefix, 9999], enemy)).toThrow();
        for (const id of CreatureLevelList[4].filter((id) => !enemy.includes(id))) {
            expect(fields([...prefix, id]).hpPerExperience).toBeGreaterThan(0);
        }
        const dragon = fields([...prefix, c.MAGIC_DRAGON]);
        expect(dragon.damageSpellCharges).toBeGreaterThan(0);
        expect(dragon.resurrectionSources).toBe(0);
    });
});
