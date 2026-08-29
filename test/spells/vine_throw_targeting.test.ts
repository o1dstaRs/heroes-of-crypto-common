import { describe, expect, it } from "bun:test";

import { getSpellConfig } from "../../src/configuration/config_provider";
import { GRID_SIZE } from "../../src/grid/grid_constants";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Spell } from "../../src/spells/spell";
import { canCastSpell } from "../../src/spells/spell_helper";
import { createTestUnit, testGridSettings } from "../helpers/combat";

/**
 * Vine Throw against a magic-immune creature.
 *
 * Live report (owner): a Black Dragon could not be hit by Vine Throw — correct, its Enchanted Skin is
 * 100% magic armor — but the client still painted the green aim lane and hover over it, inviting a
 * click the engine then refused. The rule itself was always right; the aim preview simply never asked.
 * These pin the rule so the preview has something to keep agreeing with.
 */

const emptyMatrix = (): number[][] => Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(0));

const vineThrow = (): Spell => new Spell({ spellProperties: getSpellConfig("System", "Vine Throw"), amount: 1 });

const caster = () =>
    createTestUnit({
        name: "Trent",
        team: PBTypes.TeamVals.RIGHT,
        spells: ["System:Vine Throw"],
        stackPower: 4,
    });

const castAt = (target: ReturnType<typeof createTestUnit>, magicResist: number): boolean =>
    !!canCastSpell(
        false,
        testGridSettings,
        emptyMatrix(),
        caster(),
        target,
        vineThrow(),
        target.getBaseCell(),
        magicResist,
        target.hasMindAttackResistance(),
        target.canBeHealed(),
    );

describe("Vine Throw targeting", () => {
    it("refuses a target whose magic armor is total, and allows an ordinary one", () => {
        const immune = createTestUnit({ name: "Black Dragon", team: PBTypes.TeamVals.LEFT, magicResist: 100 });
        const ordinary = createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.LEFT, magicResist: 0 });

        expect(castAt(immune, 100)).toBe(false);
        expect(castAt(ordinary, 0)).toBe(true);
    });

    it("partial magic armor still allows the throw — only 100% is immunity", () => {
        const resistant = createTestUnit({ name: "Resistant", team: PBTypes.TeamVals.LEFT, magicResist: 99 });
        expect(castAt(resistant, 99)).toBe(true);
    });

    it("never targets an ally, immune or not", () => {
        const ally = createTestUnit({ name: "Ally", team: PBTypes.TeamVals.RIGHT, magicResist: 0 });
        expect(castAt(ally, 0)).toBe(false);
    });
});
