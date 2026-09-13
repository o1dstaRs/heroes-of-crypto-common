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
    applyV08FlyerBacklinePriority,
    V08_FLYER_BACKLINE_PRIORITY_ENV,
} from "../../src/ai/versions/v0_8_flyer_backline_priority";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
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
    `${V08_FLYER_BACKLINE_PRIORITY_ENV}_LEFT`,
    `${V08_FLYER_BACKLINE_PRIORITY_ENV}_RIGHT`,
    `${V08_FLYER_BACKLINE_PRIORITY_ENV}_LOWER`,
];

function nativeUnit(team: number, faction: string, name: string, amount: number = 5): Unit {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
}

function place(combat: CombatTestContext, unit: Unit, cell: XY): void {
    const position = getPositionForCells(testGridSettings, [cell]);
    if (!position) throw new Error(`Unable to place ${unit.getName()}`);
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells([cell], unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    combat.unitsHolder.addUnit(unit);
}

function board(actorName: "Efreet" | "Squire" = "Efreet") {
    const combat = createCombatTestContext();
    const actor = actorName === "Efreet" ? nativeUnit(LEFT, "Chaos", "Efreet") : nativeUnit(LEFT, "Life", "Squire");
    const squire = nativeUnit(RIGHT, "Life", "Squire");
    const arbalester = nativeUnit(RIGHT, "Life", "Arbalester");
    place(combat, actor, { x: 3, y: 3 });
    place(combat, squire, { x: 4, y: 3 });
    place(combat, arbalester, { x: 8, y: 7 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LEFT, 1);
    fightProperties.setTeamUnitsAlive(RIGHT, 2);
    fightProperties.startTurn(LEFT, 1_000);
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
        fightProperties,
        decisionOrigin: "root",
    };
    const hit = (target: Unit, from: XY): GameAction[] => [
        { type: "melee_attack", attackerId: actor.getId(), targetId: target.getId(), attackFrom: from },
    ];
    return { actor, squire, arbalester, context, hit };
}

const meleeTarget = (actions: readonly GameAction[]): string | undefined =>
    actions.find((action): action is Extract<GameAction, { type: "melee_attack" }> => action.type === "melee_attack")
        ?.targetId;

afterEach(() => {
    for (const key of SEAM_KEYS) delete process.env[key];
    resetLegacySeatEnvChecksForTests();
    FightStateManager.getInstance().reset();
});

describe("melee flyer backline priority seam", () => {
    test("is inert unless the flyer's own seat is on", () => {
        const { actor, squire, context, hit } = board();
        const chosen = hit(squire, actor.getBaseCell());
        expect(applyV08FlyerBacklinePriority(actor, context, chosen)).toBe(chosen);
        process.env[`${V08_FLYER_BACKLINE_PRIORITY_ENV}_RIGHT`] = "1";
        expect(applyV08FlyerBacklinePriority(actor, context, chosen)).toBe(chosen);
        expect(applyV08FlyerBacklinePriority(actor, undefined, chosen)).toBe(chosen);
    });

    test("swaps a front-line hit for a legal strike on a reachable shooter", () => {
        const { actor, squire, arbalester, context, hit } = board();
        process.env[`${V08_FLYER_BACKLINE_PRIORITY_ENV}_LEFT`] = "1";
        const decision = applyV08FlyerBacklinePriority(actor, context, hit(squire, actor.getBaseCell()));
        expect(meleeTarget(decision)).toBe(arbalester.getId());
    });

    test("keeps a decision that already strikes the backline, and never redirects a ground unit", () => {
        const flyer = board();
        process.env[`${V08_FLYER_BACKLINE_PRIORITY_ENV}_LEFT`] = "1";
        const already = flyer.hit(flyer.arbalester, { x: 7, y: 7 });
        expect(applyV08FlyerBacklinePriority(flyer.actor, flyer.context, already)).toBe(already);

        const ground = board("Squire");
        const groundHit = ground.hit(ground.squire, ground.actor.getBaseCell());
        expect(applyV08FlyerBacklinePriority(ground.actor, ground.context, groundHit)).toBe(groundHit);
    });

    test("refuses the pre-rename seat name loudly", () => {
        const { actor, squire, context, hit } = board();
        process.env[`${V08_FLYER_BACKLINE_PRIORITY_ENV}_LOWER`] = "1";
        expect(() => applyV08FlyerBacklinePriority(actor, context, hit(squire, actor.getBaseCell()))).toThrow(
            "LEFT/RIGHT",
        );
    });
});
