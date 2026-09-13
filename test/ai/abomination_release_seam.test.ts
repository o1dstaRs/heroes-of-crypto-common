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

import { afterEach, describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import { resetLegacySeatEnvChecksForTests } from "../../src/ai/seat_env";
import {
    buildV08BacklineProtectorIntent,
    V08_ABOMINATION_RELEASE_ENV,
} from "../../src/ai/versions/v0_8_backline_protector";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, testGridSettings, type CombatTestContext } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const SEAM_KEYS = [
    `${V08_ABOMINATION_RELEASE_ENV}_LEFT`,
    `${V08_ABOMINATION_RELEASE_ENV}_RIGHT`,
    `${V08_ABOMINATION_RELEASE_ENV}_LOWER`,
];

function nativeUnit(team: number, faction: string, name: string): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 1),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

function place(combat: CombatTestContext, unit: Unit, anchor: XY): void {
    const cells = unit.isSmallSize()
        ? [{ ...anchor }]
        : [
              { ...anchor },
              { x: anchor.x - 1, y: anchor.y },
              { x: anchor.x, y: anchor.y - 1 },
              { x: anchor.x - 1, y: anchor.y - 1 },
          ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) throw new Error(`Unable to place ${unit.getName()}`);
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(cells, unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    combat.unitsHolder.addUnit(unit);
}

function protectorBoard(): { protector: Unit; context: IDecisionContext } {
    const combat = createCombatTestContext();
    const protector = nativeUnit(LEFT, "Chaos", "Abomination");
    place(combat, protector, { x: 6, y: 6 });
    place(combat, nativeUnit(LEFT, "Life", "Battle Mage"), { x: 6, y: 7 });
    place(combat, nativeUnit(RIGHT, "Life", "Squire"), { x: 12, y: 12 });
    return {
        protector,
        context: {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties: FightStateManager.getInstance().getFightProperties(),
            decisionOrigin: "root",
        },
    };
}

afterEach(() => {
    for (const key of SEAM_KEYS) delete process.env[key];
    resetLegacySeatEnvChecksForTests();
    FightStateManager.getInstance().reset();
});

describe("Abomination protector release seam", () => {
    test("keeps the protector contract unless the Abomination's own seat is released", () => {
        const { protector, context } = protectorBoard();
        expect(buildV08BacklineProtectorIntent(protector, context)?.kind).toBe("abomination");

        process.env[`${V08_ABOMINATION_RELEASE_ENV}_RIGHT`] = "1";
        expect(buildV08BacklineProtectorIntent(protector, context)?.kind).toBe("abomination");

        process.env[`${V08_ABOMINATION_RELEASE_ENV}_LEFT`] = "1";
        expect(buildV08BacklineProtectorIntent(protector, context)).toBeUndefined();
    });

    test("refuses the pre-rename seat name loudly", () => {
        const { protector, context } = protectorBoard();
        process.env[`${V08_ABOMINATION_RELEASE_ENV}_LOWER`] = "1";
        expect(() => buildV08BacklineProtectorIntent(protector, context)).toThrow("LEFT/RIGHT");
    });
});
