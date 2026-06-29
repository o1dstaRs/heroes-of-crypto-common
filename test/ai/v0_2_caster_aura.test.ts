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
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
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
const RANGE = PBTypes.AttackVals.RANGE;

function makeCreature(name: string, faction: string, team: number): Unit {
    const ef = new EffectFactory();
    const af = new AbilityFactory(ef);
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
        fightProperties: FightStateManager.getInstance().getFightProperties(),
    };
}

const castName = (actions: GameAction[]): string | undefined => {
    const a = actions.find((x) => x.type === "cast_spell");
    return a && a.type === "cast_spell" ? a.spellName : undefined;
};

describe("v0.2 MAGIC caster (decideSpellTurn)", () => {
    it("Healer heals when an ally is wounded", () => {
        const c = createCombatTestContext();
        const healer = makeCreature("Healer", "Life", UPPER);
        const wounded = createTestUnit({ team: UPPER, name: "Wounded", maxHp: 100, amountAlive: 1, attackType: MELEE });
        // Enemy far (no imminent fight) so timed buffs are skipped and only the heal path applies.
        const enemy = createTestUnit({ team: LOWER, name: "Enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, healer, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, wounded, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 14, y: 14 });
        wounded.applyDamage(60, 0, new SceneLogMock());

        expect(castName(getAIStrategy("v0.2").decideTurn(healer, ctxFor(c)))).toMatch(/Heal/);
    });

    it("Healer with everyone at full HP and no imminent fight does not cast", () => {
        const c = createCombatTestContext();
        const healer = makeCreature("Healer", "Life", UPPER);
        const ally = createTestUnit({ team: UPPER, name: "Ally", maxHp: 100, amountAlive: 1, attackType: MELEE });
        // Enemy far away (> half board) so timed buffs aren't worth casting yet.
        const enemy = createTestUnit({ team: LOWER, name: "Far", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, healer, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 14, y: 14 });

        expect(castName(getAIStrategy("v0.2").decideTurn(healer, ctxFor(c)))).toBeUndefined();
    });

    it("Satyr summons wolves when our ranged army is superior", () => {
        const c = createCombatTestContext();
        const satyr = makeCreature("Satyr", "Nature", UPPER);
        const archer = createTestUnit({
            team: UPPER,
            name: "Archer",
            attackType: RANGE,
            rangeShots: 10,
            damageMax: 20,
        });
        const enemy = createTestUnit({ team: LOWER, name: "Grunt", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, satyr, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, archer, { x: 4, y: 4 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 7, y: 7 });

        expect(castName(getAIStrategy("v0.2").decideTurn(satyr, ctxFor(c)))).toBe("Summon Wolves");
    });
});

describe("v0.2 aura emitter (Pegasus, withAura)", () => {
    it("does not just advance into the enemy — holds, repositions, or waits to keep its aura up", () => {
        const c = createCombatTestContext();
        const pegasus = makeCreature("Pegasus", "Nature", UPPER);
        // Allies it should keep covered, all on its own side; the enemy is far (no imminent melee).
        const allyA = createTestUnit({ team: UPPER, name: "A", attackType: MELEE });
        const allyB = createTestUnit({ team: UPPER, name: "B", attackType: MELEE });
        const enemy = createTestUnit({ team: LOWER, name: "Far", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, pegasus, { x: 8, y: 12 });
        placeUnit(c.grid, c.unitsHolder, allyA, { x: 7, y: 13 });
        placeUnit(c.grid, c.unitsHolder, allyB, { x: 9, y: 13 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 8, y: 1 });

        const actions = getAIStrategy("v0.2").decideTurn(pegasus, ctxFor(c));
        // It produces a valid turn (move to better coverage / wait / hold) rather than crashing, and
        // never a melee/range attack from the back line.
        expect(actions.length).toBeGreaterThan(0);
        expect(actions.some((a) => a.type === "melee_attack" || a.type === "range_attack")).toBe(false);
    });
});
