import { afterEach, describe, expect, it } from "bun:test";

import { getCraftChances, processCraftAbility } from "../../src/abilities/craft_ability";
import { ARTIFACT_POWER } from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createTestUnit } from "../helpers/combat";

const alwaysRoll = (value: number): void => {
    let call = 0;
    setDeterministicRandomSource(() => (call++ % 2 === 0 ? 0 : value / 0x1_0000_0000));
};

afterEach(() => setDeterministicRandomSource(undefined));

describe("Blacksmith Craft", () => {
    it("multiplies double and frozen outcomes by the Tome's 35% and lets luck preserve the stun risk", () => {
        const tome = ARTIFACT_POWER.TOME_BUFF_POWER_PERCENT;
        expect(getCraftChances(0, tome)).toEqual({ stun: 10, nothing: 22.5, double: 54, frozen: 13.5 });
        expect(getCraftChances(10, tome)).toEqual({ stun: 0, nothing: 19, double: 54, frozen: 27 });
        expect(getCraftChances(-10, tome)).toEqual({ stun: 20, nothing: 26, double: 54, frozen: 0 });
    });

    it("samples the Tome's fractional boundary for melee and ranged weapons", () => {
        const caster = createTestUnit({ name: "Blacksmith", luck: 0 });
        const tome = new Spell({ spellProperties: getSpellConfig("System", "Tome of Amplification"), amount: 1 });
        tome.setPower(ARTIFACT_POWER.TOME_BUFF_POWER_PERCENT);
        caster.applyBuff(tome);
        const melee = createTestUnit({ name: "Squire" });
        const ranged = createTestUnit({ name: "Arbalester", rangeShots: 5 });

        alwaysRoll(3249);
        expect(processCraftAbility(caster, [melee], new SceneLogMock())[0]?.outcome).toBe("nothing");
        alwaysRoll(3250);
        expect(processCraftAbility(caster, [melee, ranged], new SceneLogMock()).map((r) => r.grantedAbility)).toEqual([
            "Crafted Double Punch",
            "Crafted Double Shot",
        ]);
        const freshAlly = createTestUnit({ name: "Fresh ally" });
        alwaysRoll(8649);
        expect(processCraftAbility(caster, [freshAlly], new SceneLogMock())[0]?.outcome).toBe("double");
        alwaysRoll(8650);
        expect(processCraftAbility(caster, [melee, ranged], new SceneLogMock()).map((r) => r.grantedAbility)).toEqual([
            "Crafted Frozen Sword",
            "Crafted Frozen Bow",
        ]);
    });

    it("stuns each living ally when the backfire band is rolled", () => {
        alwaysRoll(0);
        const caster = createTestUnit({ name: "Blacksmith", luck: 0 });
        const melee = createTestUnit({ name: "Squire" });
        const ranged = createTestUnit({ name: "Arbalester", rangeShots: 5 });

        const results = processCraftAbility(caster, [melee, ranged], new SceneLogMock());

        expect(results).toEqual([
            { unitId: melee.getId(), outcome: "stun" },
            { unitId: ranged.getId(), outcome: "stun" },
        ]);
        expect(melee.hasEffectActive("Stun")).toBe(true);
        expect(ranged.hasEffectActive("Stun")).toBe(true);
    });

    it("leaves allies unchanged in the nothing band", () => {
        alwaysRoll(10);
        const caster = createTestUnit({ name: "Blacksmith", luck: 0 });
        const ally = createTestUnit({ name: "Squire" });

        expect(processCraftAbility(caster, [ally], new SceneLogMock())).toEqual([
            { unitId: ally.getId(), outcome: "nothing" },
        ]);
        expect(ally.hasEffectActive("Stun")).toBe(false);
        expect(ally.hasAbilityActive("Crafted Double Punch")).toBe(false);
        expect(ally.hasAbilityActive("Crafted Frozen Sword")).toBe(false);
    });

    it("grants the correct melee and ranged double-attack variants", () => {
        alwaysRoll(50);
        const caster = createTestUnit({ name: "Blacksmith", luck: 0 });
        const melee = createTestUnit({ name: "Squire" });
        const ranged = createTestUnit({ name: "Arbalester", rangeShots: 5 });

        expect(processCraftAbility(caster, [melee, ranged], new SceneLogMock())).toEqual([
            { unitId: melee.getId(), outcome: "double", grantedAbility: "Crafted Double Punch" },
            { unitId: ranged.getId(), outcome: "double", grantedAbility: "Crafted Double Shot" },
        ]);
        expect(melee.hasAbilityActive("Crafted Double Punch")).toBe(true);
        expect(melee.hasAbilityActive("Crafted Double Shot")).toBe(false);
        expect(ranged.hasAbilityActive("Crafted Double Shot")).toBe(true);
        expect(ranged.hasAbilityActive("Crafted Double Punch")).toBe(false);
    });

    it("does not turn an existing double attack into a triple attack", () => {
        alwaysRoll(50);
        const caster = createTestUnit({ name: "Blacksmith", luck: 0 });
        const melee = createTestUnit({ name: "Squire", abilities: ["Double Punch"] });
        const ranged = createTestUnit({ name: "Arbalester", rangeShots: 5, abilities: ["Double Shot"] });

        expect(processCraftAbility(caster, [melee, ranged], new SceneLogMock())).toEqual([
            { unitId: melee.getId(), outcome: "nothing" },
            { unitId: ranged.getId(), outcome: "nothing" },
        ]);
        expect(melee.hasAbilityActive("Crafted Double Punch")).toBe(false);
        expect(ranged.hasAbilityActive("Crafted Double Shot")).toBe(false);
    });

    it("grants the correct melee and ranged frozen-weapon variants", () => {
        alwaysRoll(90);
        const caster = createTestUnit({ name: "Blacksmith", luck: 0 });
        const melee = createTestUnit({ name: "Squire" });
        const ranged = createTestUnit({ name: "Arbalester", rangeShots: 5 });

        expect(processCraftAbility(caster, [melee, ranged], new SceneLogMock())).toEqual([
            { unitId: melee.getId(), outcome: "frozen", grantedAbility: "Crafted Frozen Sword" },
            { unitId: ranged.getId(), outcome: "frozen", grantedAbility: "Crafted Frozen Bow" },
        ]);
        expect(melee.hasAbilityActive("Crafted Frozen Sword")).toBe(true);
        expect(melee.hasAbilityActive("Crafted Frozen Bow")).toBe(false);
        expect(ranged.hasAbilityActive("Crafted Frozen Bow")).toBe(true);
        expect(ranged.hasAbilityActive("Crafted Frozen Sword")).toBe(false);
    });

    it("uses caster luck to move probability from stun into frozen weapons", () => {
        const lowLuckCaster = createTestUnit({ name: "Unlucky Blacksmith", luck: -10 });
        const highLuckCaster = createTestUnit({ name: "Lucky Blacksmith", luck: 10 });

        alwaysRoll(15);
        const unluckyAlly = createTestUnit({ name: "Unlucky ally" });
        expect(processCraftAbility(lowLuckCaster, [unluckyAlly], new SceneLogMock())[0]?.outcome).toBe("stun");

        alwaysRoll(95);
        const luckyAlly = createTestUnit({ name: "Lucky ally" });
        expect(processCraftAbility(highLuckCaster, [luckyAlly], new SceneLogMock())[0]).toEqual({
            unitId: luckyAlly.getId(),
            outcome: "frozen",
            grantedAbility: "Crafted Frozen Sword",
        });
    });
});
