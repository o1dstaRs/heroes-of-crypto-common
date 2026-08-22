/*
 * -----------------------------------------------------------------------------
 * The poison-on-hit path must find its auras through the CONFIG, never by matching a
 * literal name.
 *
 * The bug this guards actually shipped: processPoisonAuraAbility looked the buff up as
 * the literal "Poison Cloud Aura", so when a second poison aura (Venom Cloud) arrived it
 * landed on the right allies, showed the right tooltip and then poisoned nobody. The fix
 * was POISON_ON_HIT_AURA_EFFECT_NAMES, derived by filtering aura_effects.json on
 * power_type.
 *
 * That derivation used to be covered incidentally: two poison auras were declared, so a
 * hard-coded name failed a fixture. Poison Cloud has since been removed (the Dryad traded
 * it for Guiding Winds and nothing ever picked it up), leaving ONE declared aura — and a
 * one-element set cannot catch a hard-coded name by behaviour alone. These tests guard the
 * derivation itself instead, so the protection does not depend on how many auras exist.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { processPoisonAuraAbility } from "../../src/abilities/poison_aura_ability";
import auraEffectsJson from "../../src/configuration/aura_effects.json";
import {
    getAuraEffectConfig,
    POISON_ON_HIT_AURA_BUFF_NAMES,
    POISON_ON_HIT_AURA_EFFECT_NAMES,
} from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const sceneLogMock = () => {
    const lines: string[] = [];
    return {
        getLog: () => lines.join("\n"),
        updateLog: (line?: string) => {
            if (line) lines.push(line);
        },
        hasBeenUpdated: () => lines.length > 0,
    };
};

const auraEffects = auraEffectsJson as unknown as Record<string, { power_type?: string }>;

describe("poison-on-hit auras are discovered from the config", () => {
    it("derives the effect set from power_type, not a hand-maintained list", () => {
        // Recomputed straight from the JSON: if someone replaces the filter in config_provider with a
        // literal array, it keeps working today and silently drops whatever is declared next.
        const expected = Object.keys(auraEffects)
            .filter((key) => key !== "version" && auraEffects[key]?.power_type === "POISON_ON_HIT")
            .sort();

        expect([...POISON_ON_HIT_AURA_EFFECT_NAMES].sort()).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
        // The buff each one leaves on an affected ally is always "<effect> Aura".
        expect([...POISON_ON_HIT_AURA_BUFF_NAMES].sort()).toEqual(expected.map((name) => `${name} Aura`).sort());
    });

    it("never names an aura literally in the on-hit path", () => {
        // The structural half, and the one that survives having a single aura declared: the source may
        // not mention ANY declared aura by name — it has to go through the set.
        const source = readFileSync(
            join(import.meta.dir, "..", "..", "src", "abilities", "poison_aura_ability.ts"),
            "utf-8",
        );
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (the docstring names Venom Cloud on purpose)
            .replace(/\/\/.*$/gm, "");

        for (const name of Object.keys(auraEffects).filter((key) => key !== "version")) {
            expect(code).not.toContain(`"${name}"`);
            expect(code).not.toContain(`"${name} Aura"`);
        }
    });

    it("poisons through every declared poison aura, whichever they are", () => {
        // Data-driven on purpose: a second poison aura is covered the moment it is declared, with no
        // new fixture to remember to write.
        for (const effectName of POISON_ON_HIT_AURA_EFFECT_NAMES) {
            const config = getAuraEffectConfig(effectName);
            expect(config).toBeDefined();
            const range = config!.range;

            const { grid, unitsHolder } = createCombatTestContext();
            const emitter = createTestUnit({
                name: `${effectName} Emitter`,
                team: PBTypes.TeamVals.LOWER,
                abilities: [`${effectName} Aura`],
                auraEffects: [effectName],
                auraRanges: [range],
                auraIsBuff: [true],
            });
            const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.LOWER, attack: 10 });
            const enemy = createTestUnit({ name: "Enemy", team: PBTypes.TeamVals.UPPER, maxHp: 2000 });

            placeUnit(grid, unitsHolder, emitter, { x: 3, y: 3 });
            placeUnit(grid, unitsHolder, ally, { x: 4, y: 3 });
            placeUnit(grid, unitsHolder, enemy, { x: 4, y: 4 });
            unitsHolder.refreshAuraEffectsForAllUnits();

            expect(ally.hasBuffActive(`${effectName} Aura`)).toBe(true);
            processPoisonAuraAbility(ally, enemy, 100, sceneLogMock());
            expect(enemy.getEffect("Poison")?.getPower()).toBeGreaterThan(0);
        }
    });
});
