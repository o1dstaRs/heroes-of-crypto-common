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

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const FLY = PBTypes.MovementVals.FLY;

function makeGriffin(team: number): Unit {
    const ef = new EffectFactory();
    const af = new AbilityFactory(ef);
    return Unit.createUnit(
        getCreatureConfig(team, "Life", "Griffin", "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        af,
        ef,
        false,
    );
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
const meleeTargetId = (a: GameAction[]): string | undefined => {
    const m = a.find((x) => x.type === "melee_attack");
    return m && m.type === "melee_attack" ? m.targetId : undefined;
};

describe("v0.2 Griffin null-field dive", () => {
    it("dives the enemy range line and melees a shooter when it has flying support", () => {
        const c = createCombatTestContext();
        const griffin = makeGriffin(LOWER);
        const wingmate = createTestUnit({ team: LOWER, name: "Wingmate", attackType: MELEE, movementType: FLY });
        const r1 = createTestUnit({ team: UPPER, name: "R1", attackType: RANGE, rangeShots: 5 });
        const r2 = createTestUnit({ team: UPPER, name: "R2", attackType: RANGE, rangeShots: 5 });
        const r3 = createTestUnit({ team: UPPER, name: "R3", attackType: RANGE, rangeShots: 5 });
        placeUnit(c.grid, c.unitsHolder, griffin, { x: 4, y: 6 });
        placeUnit(c.grid, c.unitsHolder, wingmate, { x: 8, y: 5 });
        placeUnit(c.grid, c.unitsHolder, r1, { x: 3, y: 2 });
        placeUnit(c.grid, c.unitsHolder, r2, { x: 4, y: 2 });
        placeUnit(c.grid, c.unitsHolder, r3, { x: 5, y: 2 });

        const target = meleeTargetId(getAIStrategy("v0.2").decideTurn(griffin, ctxFor(c)));
        expect(target).toBeDefined();
        expect([r1.getId(), r2.getId(), r3.getId()]).toContain(target as string);
    });

    it("does not dive alone — without flying support it engages normally", () => {
        const c = createCombatTestContext();
        const griffin = makeGriffin(LOWER);
        // No other flyer. A front melee enemy is adjacent; ranged sit in the backline.
        const frontMelee = createTestUnit({ team: UPPER, name: "Front", attackType: MELEE, amountAlive: 5 });
        const ranged = createTestUnit({ team: UPPER, name: "Shooter", attackType: RANGE, rangeShots: 5 });
        placeUnit(c.grid, c.unitsHolder, griffin, { x: 4, y: 6 });
        placeUnit(c.grid, c.unitsHolder, frontMelee, { x: 4, y: 5 });
        placeUnit(c.grid, c.unitsHolder, ranged, { x: 4, y: 2 });

        const target = meleeTargetId(getAIStrategy("v0.2").decideTurn(griffin, ctxFor(c)));
        // It melees the adjacent front unit (normal behavior), not a solo dive onto the backline shooter.
        expect(target).not.toBe(ranged.getId());
    });

    it("with no enemy ranged units, behaves like a normal melee unit (no special dive)", () => {
        const c = createCombatTestContext();
        const griffin = makeGriffin(LOWER);
        const wingmate = createTestUnit({ team: LOWER, name: "Wingmate", attackType: MELEE, movementType: FLY });
        const enemy = createTestUnit({ team: UPPER, name: "Brute", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, griffin, { x: 4, y: 6 });
        placeUnit(c.grid, c.unitsHolder, wingmate, { x: 6, y: 6 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 4, y: 5 });

        // Adjacent melee enemy → it just attacks it (no ranged means the dive branch is skipped).
        expect(meleeTargetId(getAIStrategy("v0.2").decideTurn(griffin, ctxFor(c)))).toBe(enemy.getId());
    });
});
