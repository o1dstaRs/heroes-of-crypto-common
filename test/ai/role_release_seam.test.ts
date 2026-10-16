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
import type { IDecisionContext, IPlacementContext } from "../../src/ai";
import { resetLegacySeatEnvChecksForTests } from "../../src/ai/seat_env";
import { prioritizeV08BlacksmithCraft, v08BlacksmithCraftPlacement } from "../../src/ai/versions/v0_8_blacksmith";
import { V08_ROLE_RELEASE_ENV } from "../../src/ai/versions/v0_8_role_release";
import { prioritizeV08HealerSustain, prioritizeV08WanderingMageSmoke } from "../../src/ai/versions/v0_8_support_roles";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const SEAM_KEYS = [`${V08_ROLE_RELEASE_ENV}_LEFT`, `${V08_ROLE_RELEASE_ENV}_RIGHT`, `${V08_ROLE_RELEASE_ENV}_LOWER`];

afterEach(() => {
    for (const key of SEAM_KEYS) delete process.env[key];
    resetLegacySeatEnvChecksForTests();
    FightStateManager.getInstance().reset();
});

function nativeUnit(team: number, faction: string, name: string, amount: number): Unit {
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

const decisionContext = (combat: ReturnType<typeof createCombatTestContext>): IDecisionContext => ({
    grid: combat.grid,
    matrix: combat.grid.getMatrix(),
    unitsHolder: combat.unitsHolder,
    pathHelper: new PathHelper(testGridSettings),
    attackHandler: combat.attackHandler,
    fightProperties: FightStateManager.getInstance().getFightProperties(),
});

const cast = (actions: readonly GameAction[]) =>
    actions.find((action): action is Extract<GameAction, { type: "cast_spell" }> => action.type === "cast_spell");

const blacksmith = (): Unit =>
    createTestUnit({
        team: LEFT,
        name: "Blacksmith",
        attackType: MELEE,
        attack: 9,
        damageMin: 2,
        damageMax: 3,
        amountAlive: 100,
        maxHp: 9,
        stackPower: 4,
        spells: ["System:Craft", "System:Armor Rune", "System:Weapon Rune"],
    });

/** Each router's native pick on a board where it fires, and the incoming decision it replaces. */
function routedBoard(role: "blacksmith_craft" | "healer_sustain" | "wandering_mage_smoke"): {
    route: () => GameAction[];
    incoming: GameAction[];
    spell: string;
} {
    const combat = createCombatTestContext();
    const place = (unit: Unit, x: number, y: number) => placeUnit(combat.grid, combat.unitsHolder, unit, { x, y });
    if (role === "blacksmith_craft") {
        const smith = blacksmith();
        place(smith, 2, 2);
        place(createTestUnit({ team: LEFT, name: "Craft first", damageMax: 10, amountAlive: 10 }), 7, 7);
        place(createTestUnit({ team: LEFT, name: "Craft second", damageMax: 10, amountAlive: 10 }), 8, 7);
        place(createTestUnit({ team: RIGHT, name: "Distant enemy" }), 13, 13);
        const incoming: GameAction[] = [{ type: "defend_turn", unitId: smith.getId() }];
        const context = decisionContext(combat);
        return { route: () => prioritizeV08BlacksmithCraft(smith, context, incoming), incoming, spell: "Craft" };
    }
    if (role === "healer_sustain") {
        const healer = createTestUnit({
            team: LEFT,
            name: "Healer",
            attackType: MELEE,
            damageMin: 10,
            damageMax: 10,
            amountAlive: 20,
            stackPower: 4,
            spells: ["Life:Heal"],
        });
        const abomination = nativeUnit(LEFT, "Chaos", "Abomination", 1);
        const target = createTestUnit({ team: RIGHT, name: "Fragile responder", attackType: MELEE, maxHp: 1 });
        place(healer, 3, 5);
        place(abomination, 3, 6);
        place(target, 4, 5);
        abomination.applyDamage(20, 0, new SceneLogMock());
        const incoming: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: healer.getId(),
                targetId: target.getId(),
                attackFrom: healer.getBaseCell(),
            },
        ];
        const context = decisionContext(combat);
        return { route: () => prioritizeV08HealerSustain(healer, context, incoming), incoming, spell: "Heal" };
    }
    const moth = nativeUnit(LEFT, "Chaos", "Wandering Mage", 50);
    place(moth, 2, 7);
    place(createTestUnit({ team: LEFT, name: "Screened melee", attackType: MELEE, amountAlive: 30 }), 2, 9);
    place(
        createTestUnit({
            team: RIGHT,
            name: "Enemy ranger",
            attackType: RANGE,
            rangeShots: 8,
            damageMax: 20,
            amountAlive: 20,
        }),
        13,
        8,
    );
    const incoming: GameAction[] = [{ type: "end_turn", unitId: moth.getId(), reason: "manual" }];
    const context = decisionContext(combat);
    return { route: () => prioritizeV08WanderingMageSmoke(moth, context, incoming), incoming, spell: "Smoke" };
}

const OTHER_ROLE = {
    blacksmith_craft: "healer_sustain",
    healer_sustain: "wandering_mage_smoke",
    wandering_mage_smoke: "blacksmith_craft",
} as const;

describe("v0.8 role release seam", () => {
    test.each(["blacksmith_craft", "healer_sustain", "wandering_mage_smoke"] as const)(
        "releases only the listed role for its own seat (%s)",
        (role) => {
            const { route, incoming, spell } = routedBoard(role);
            expect(cast(route())?.spellName).toBe(spell);

            process.env[`${V08_ROLE_RELEASE_ENV}_RIGHT`] = role;
            expect(cast(route())?.spellName).toBe(spell);

            process.env[`${V08_ROLE_RELEASE_ENV}_LEFT`] = OTHER_ROLE[role];
            expect(cast(route())?.spellName).toBe(spell);

            process.env[`${V08_ROLE_RELEASE_ENV}_LEFT`] = `${OTHER_ROLE[role]}, ${role}`;
            expect(route()).toBe(incoming);
        },
    );

    test("releases the Blacksmith Craft opening cluster for its own seat only", () => {
        const combat = createCombatTestContext();
        const units = [
            blacksmith(),
            createTestUnit({
                team: LEFT,
                name: "Artillery",
                attackType: RANGE,
                damageMax: 20,
                amountAlive: 10,
                rangeShots: 8,
            }),
            createTestUnit({
                team: LEFT,
                name: "Archer",
                attackType: RANGE,
                damageMax: 12,
                amountAlive: 10,
                rangeShots: 6,
            }),
            createTestUnit({ team: LEFT, name: "Bruiser", damageMax: 20, amountAlive: 20 }),
            createTestUnit({ team: LEFT, name: "Guard", damageMax: 10, amountAlive: 20 }),
        ];
        for (const unit of units) combat.unitsHolder.addUnit(unit);
        const cells: XY[] = [
            { x: 0, y: 1 },
            { x: 3, y: 1 },
            { x: 6, y: 1 },
            { x: 9, y: 1 },
            { x: 12, y: 1 },
        ];
        const inherited = new Map(units.map((unit, index) => [unit.getId(), cells[index]]));
        const context: IPlacementContext = {
            team: LEFT,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 5),
            publicOpponentCreatureIds: [PBTypes.CreatureVals.SQUIRE],
            setupPlacementPolicy: "public-roster",
        };

        expect(v08BlacksmithCraftPlacement(units, context, inherited)).not.toBe(inherited);
        process.env[`${V08_ROLE_RELEASE_ENV}_RIGHT`] = "blacksmith_craft";
        expect(v08BlacksmithCraftPlacement(units, context, inherited)).not.toBe(inherited);
        process.env[`${V08_ROLE_RELEASE_ENV}_LEFT`] = "blacksmith_craft";
        expect(v08BlacksmithCraftPlacement(units, context, inherited)).toBe(inherited);
    });

    test("refuses unknown roles and the pre-rename seat name loudly", () => {
        const { route } = routedBoard("blacksmith_craft");
        process.env[`${V08_ROLE_RELEASE_ENV}_LEFT`] = "craft";
        expect(route).toThrow("unknown roles");
        delete process.env[`${V08_ROLE_RELEASE_ENV}_LEFT`];
        // The legacy-name check runs once per process for a clean base; the read above already ran it.
        resetLegacySeatEnvChecksForTests();
        process.env[`${V08_ROLE_RELEASE_ENV}_LOWER`] = "blacksmith_craft";
        expect(route).toThrow("LEFT/RIGHT");
    });
});
