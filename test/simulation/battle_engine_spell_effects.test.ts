/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch, SIM_RECORD_SPELL_EFFECTS_ENV, type IRecordedAction } from "../../src/simulation/battle_engine";

const savedForce = process.env.FORCE_CREATURES;
const savedSwitch = process.env[SIM_RECORD_SPELL_EFFECTS_ENV];
afterEach(() => {
    if (savedForce === undefined) delete process.env.FORCE_CREATURES;
    else process.env.FORCE_CREATURES = savedForce;
    if (savedSwitch === undefined) delete process.env[SIM_RECORD_SPELL_EFFECTS_ENV];
    else process.env[SIM_RECORD_SPELL_EFFECTS_ENV] = savedSwitch;
});

const SPELL_FIELDS = ["spellName", "spellDamage", "spellHealed", "spellResurrectedHp"] as const;

/** A short heuristic match with a caster forced into both rosters. */
const play = (recordSpellEffects: boolean) => {
    process.env.FORCE_CREATURES = "2:Healer";
    if (recordSpellEffects) process.env[SIM_RECORD_SPELL_EFFECTS_ENV] = "1";
    else delete process.env[SIM_RECORD_SPELL_EFFECTS_ENV];
    return runMatch({ greenVersion: "v0.4", redVersion: "v0.4", roster: buildRoster(makeRng(7)), seed: 7, maxLaps: 8 });
};

const withoutSpellFields = (actions: readonly IRecordedAction[]) =>
    actions.map((action) => {
        const copy: Record<string, unknown> = { ...action };
        for (const field of SPELL_FIELDS) delete copy[field];
        return copy;
    });

describe("recorded spell effects", () => {
    it("are off by default, so the action log and everything hashed from it stay byte-identical", () => {
        const plain = play(false);
        expect(plain.actions.some((action) => SPELL_FIELDS.some((field) => field in action))).toBe(false);
        const recorded = play(true);
        expect(withoutSpellFields(recorded.actions)).toEqual(withoutSpellFields(plain.actions));
        expect(recorded.winner).toBe(plain.winner);
        expect(recorded.laps).toBe(plain.laps);
    });

    it("name each cast's spell and total what it dealt, healed and raised", () => {
        const recorded = play(true);
        const casts = recorded.actions.filter((action) => action.actionType === "cast_spell" && action.completed);
        expect(casts.length).toBeGreaterThan(0);
        expect(casts.some((cast) => cast.spellName === "Heal" && (cast.spellHealed ?? 0) > 0)).toBe(true);
        for (const cast of casts) {
            expect(typeof cast.spellName).toBe("string");
            for (const field of ["spellDamage", "spellHealed", "spellResurrectedHp"] as const) {
                expect(cast[field]).toBeGreaterThanOrEqual(0);
            }
        }
        const others = recorded.actions.filter((action) => action.actionType !== "cast_spell");
        expect(others.some((action) => SPELL_FIELDS.some((field) => field in action))).toBe(false);
    });
});
