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

import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    CombatTestContext,
} from "../helpers/combat";

const UPPER = PBTypes.TeamVals.UPPER;
const LOWER = PBTypes.TeamVals.LOWER;
const MELEE = PBTypes.AttackVals.MELEE;

function makeCreature(name: string, faction: string, team: number): Unit {
    const ef = new EffectFactory();
    const af = new AbilityFactory(ef);
    // A large amount so the caster has enough stack power for its high-level opener.
    const props = getCreatureConfig(team, faction, name, "", 1000);
    return Unit.createUnit(props, testGridSettings, team, PBTypes.UnitVals.CREATURE, af, ef, false);
}

function ctxFor(c: CombatTestContext): IDecisionContext {
    return {
        grid: c.grid,
        matrix: c.grid.getMatrix(),
        unitsHolder: c.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: c.attackHandler,
    };
}

const castSpellName = (actions: GameAction[]): string | undefined => {
    const a = actions.find((x) => x.type === "cast_spell");
    return a && a.type === "cast_spell" ? a.spellName : undefined;
};
const hasMelee = (actions: GameAction[]): boolean => actions.some((a) => a.type === "melee_attack");

describe("v0.2 creature openers", () => {
    it("Ogre Mage casts Mass Riot when no enemy is adjacent", () => {
        const c = createCombatTestContext();
        const ogre = makeCreature("Ogre Mage", "Might", UPPER);
        const ally = createTestUnit({ team: UPPER, name: "Ally", attackType: MELEE });
        const enemy = createTestUnit({ team: LOWER, name: "FarEnemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, ogre, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 1, y: 1 });

        expect(castSpellName(getAIStrategy("v0.2").decideTurn(ogre, ctxFor(c)))).toBe("Mass Riot");
    });

    it("Ogre Mage melees instead of casting when an enemy is adjacent", () => {
        const c = createCombatTestContext();
        const ogre = makeCreature("Ogre Mage", "Might", UPPER);
        const enemy = createTestUnit({ team: LOWER, name: "Adjacent", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, ogre, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 5, y: 6 });

        const actions = getAIStrategy("v0.2").decideTurn(ogre, ctxFor(c));
        expect(castSpellName(actions)).toBeUndefined();
        expect(hasMelee(actions)).toBe(true);
    });

    it("Behemoth casts Battle Roar on its opening turn", () => {
        const c = createCombatTestContext();
        const behemoth = makeCreature("Behemoth", "Might", UPPER);
        const ally = createTestUnit({ team: UPPER, name: "Ally", attackType: MELEE });
        const enemy = createTestUnit({ team: LOWER, name: "FarEnemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, behemoth, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 1, y: 1 });

        expect(castSpellName(getAIStrategy("v0.2").decideTurn(behemoth, ctxFor(c)))).toBe("Battle Roar");
    });
});
