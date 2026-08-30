import { describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { spellRawDamage } from "../../src/spells/spell_cast_projection";
import { getSpellMoraleMultiplier } from "../../src/spells/spell_damage";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

type MoraleState = "neutral" | "morale" | "dismorale";

const statusSpell = (name: "Morale" | "Dismorale") =>
    new Spell({ spellProperties: getSpellConfig("System", name), amount: 1 });

const applyMoraleState = (unit: ReturnType<typeof createTestUnit>, state: MoraleState): void => {
    if (state === "morale") {
        unit.applyBuff(statusSpell("Morale"));
    } else if (state === "dismorale") {
        unit.applyDebuff(statusSpell("Dismorale"));
    }
    unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
};

const configuredSpell = (faction: string, name: string) =>
    new Spell({ spellProperties: getSpellConfig(faction, name), amount: 1 });

describe("Morale-scaled spells", () => {
    const offensiveSpells = [
        ["Nature", "Lightning Strike"],
        ["Nature", "Ring of Fire"],
        ["Nature", "Meteor Shower"],
        ["Life", "Meteorite"],
        ["Life", "Fire Strike"],
    ] as const;

    for (const [faction, spellName] of offensiveSpells) {
        it(`scales ${spellName} damage by the caster's current-lap multiplier`, () => {
            const rawDamage = (state: MoraleState): number => {
                const caster = createTestUnit({ amountAlive: 10, stackPower: 5 });
                applyMoraleState(caster, state);
                return spellRawDamage(configuredSpell(faction, spellName), caster);
            };

            const neutral = rawDamage("neutral");
            expect(rawDamage("morale")).toBe(Math.floor(neutral * 1.25));
            expect(rawDamage("dismorale")).toBe(Math.floor(neutral * 0.8));
        });
    }

    it("treats legacy projection adapters without an attack multiplier as neutral", () => {
        const spell = configuredSpell("Nature", "Lightning Strike");
        const caster = createTestUnit({ amountAlive: 10, stackPower: 5 });
        const adapter = {
            getAmountAlive: () => caster.getAmountAlive(),
            getStackPower: () => caster.getStackPower(),
            getMagicDamageBonusPercentage: () => caster.getMagicDamageBonusPercentage(),
        } as Unit;

        expect(spellRawDamage(spell, adapter)).toBe(spellRawDamage(spell, caster));
    });

    it("scales Heal by Morale and Dismorale without changing unrelated healing spells", () => {
        const healed = (state: MoraleState): number => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
                spells: ["Life:Heal"],
                amountAlive: 20,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LEFT, maxHp: 1_000 });
            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });
            target.applyDamage(500, 0, attackHandler.sceneLog);
            applyMoraleState(caster, state);

            const before = target.getCumulativeHp();
            const result = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                target,
            );

            expect(result.completed).toBe(true);
            return target.getCumulativeHp() - before;
        };

        const neutral = healed("neutral");
        expect(healed("morale")).toBe(Math.floor(neutral * 1.25));
        expect(healed("dismorale")).toBe(Math.floor(neutral * 0.8));
        expect(getSpellMoraleMultiplier("Mass Heal", 1.25)).toBe(1);
    });

    it("scales Resurrection's hit-point budget by Morale and Dismorale", () => {
        const restored = (state: MoraleState): number => {
            const { grid, unitsHolder, attackHandler } = createCombatTestContext();
            const caster = createTestUnit({
                team: PBTypes.TeamVals.LEFT,
                spells: ["System:Resurrection"],
                amountAlive: 10,
                maxHp: 10,
            });
            const target = createTestUnit({ team: PBTypes.TeamVals.LEFT, amountAlive: 5, maxHp: 100 });
            placeUnit(grid, unitsHolder, caster, { x: 1, y: 1 });
            placeUnit(grid, unitsHolder, target, { x: 2, y: 1 });
            target.applyDamage(400, 0, attackHandler.sceneLog);
            applyMoraleState(caster, state);

            const before = target.getCumulativeHp();
            const result = attackHandler.handleMagicAttack(
                grid.getMatrix(),
                unitsHolder,
                caster.getSpells()[0],
                caster,
                target,
            );

            expect(result.completed).toBe(true);
            return target.getCumulativeHp() - before;
        };

        const neutral = restored("neutral");
        expect(restored("morale")).toBe(Math.floor(neutral * 1.25));
        expect(restored("dismorale")).toBe(Math.floor(neutral * 0.8));
    });
});
