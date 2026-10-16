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
    V08_PROTECTOR_RELEASE_ENV,
} from "../../src/ai/versions/v0_8_backline_protector";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const SEAM_KEYS = [
    `${V08_PROTECTOR_RELEASE_ENV}_LEFT`,
    `${V08_PROTECTOR_RELEASE_ENV}_RIGHT`,
    `${V08_PROTECTOR_RELEASE_ENV}_LOWER`,
];

function nativeUnit(team: number, faction: string, name: string): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 3),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

function board(kind: "angel" | "arachna_queen"): { protector: Unit; context: IDecisionContext } {
    const combat = createCombatTestContext();
    const protector =
        kind === "angel" ? nativeUnit(LEFT, "Life", "Angel") : nativeUnit(LEFT, "Nature", "Arachna Queen");
    const place = (unit: Unit, x: number, y: number) => placeUnit(combat.grid, combat.unitsHolder, unit, { x, y });
    place(protector, 6, 6);
    place(nativeUnit(LEFT, "Life", "Arbalester"), 6, 8);
    if (kind === "angel") {
        // Angel screens a real firing line: two allied shooters/casters facing a live enemy shooter.
        place(nativeUnit(LEFT, "Nature", "Elf"), 7, 8);
        place(nativeUnit(RIGHT, "Nature", "Elf"), 12, 12);
    } else {
        // Queen intercepts flyers: a ward to protect and a live enemy flyer.
        place(nativeUnit(RIGHT, "Might", "Harpy"), 12, 12);
    }
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

describe("protector release seam", () => {
    test.each(["angel", "arachna_queen"] as const)("releases only the listed kind for its own seat (%s)", (kind) => {
        const { protector, context } = board(kind);
        expect(buildV08BacklineProtectorIntent(protector, context)?.kind).toBe(kind);

        process.env[`${V08_PROTECTOR_RELEASE_ENV}_RIGHT`] = kind;
        expect(buildV08BacklineProtectorIntent(protector, context)?.kind).toBe(kind);

        process.env[`${V08_PROTECTOR_RELEASE_ENV}_LEFT`] = kind === "angel" ? "arachna_queen" : "angel";
        expect(buildV08BacklineProtectorIntent(protector, context)?.kind).toBe(kind);

        process.env[`${V08_PROTECTOR_RELEASE_ENV}_LEFT`] = "angel, arachna_queen";
        expect(buildV08BacklineProtectorIntent(protector, context)).toBeUndefined();
    });

    test("refuses unknown kinds and the pre-rename seat name loudly", () => {
        const { protector, context } = board("arachna_queen");
        process.env[`${V08_PROTECTOR_RELEASE_ENV}_LEFT`] = "queen";
        expect(() => buildV08BacklineProtectorIntent(protector, context)).toThrow("unknown protector kinds");
        delete process.env[`${V08_PROTECTOR_RELEASE_ENV}_LEFT`];
        // The legacy-name check runs once per process for a clean base; the read above already ran it.
        resetLegacySeatEnvChecksForTests();
        process.env[`${V08_PROTECTOR_RELEASE_ENV}_LOWER`] = "arachna_queen";
        expect(() => buildV08BacklineProtectorIntent(protector, context)).toThrow("LEFT/RIGHT");
    });
});
