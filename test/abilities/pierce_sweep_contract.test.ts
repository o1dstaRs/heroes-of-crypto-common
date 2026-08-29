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
import { nextStandingTargets } from "../../src/abilities/ability_helper";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

const createConfiguredUnit = (factionName: string, creatureName: string, team: PBTypes.TeamVals, amount: number) => {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, factionName, creatureName, `${creatureName.toLowerCase()}_512`, amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
};

/**
 * `pierceLargeUnits` is the whole difference between the two sweep abilities, and the client's hover
 * preview mirrors it — see game/core/src/scenes/pierceSweepPreview.ts, which the preview reads its flags
 * from. Skewer Strike passes `false`: a spear does not carry through a 2x2 body, so a large primary
 * target yields NO secondary victims at all. Fire Breath takes the default `true` and burns straight on.
 *
 * The preview used to hardcode `true` for both, red-outlining units behind a large target that a Pikeman
 * then never damaged. Damage was always right; only the highlight lied. If these flags ever move, the
 * client test named above must move with them.
 */
describe("piercing sweep target contract", () => {
    const build = () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const pikeman = createConfiguredUnit("Life", "Pikeman", LEFT, 10);
        // A 2x2 anchored at (7,8) covers x 6..7, y 7..8, so it stands between the attacker and the unit behind.
        const large = createConfiguredUnit("Chaos", "Hydra", RIGHT, 10);
        const behind = createConfiguredUnit("Chaos", "Troglodyte", RIGHT, 10);
        placeUnit(combat.grid, combat.unitsHolder, pikeman, { x: 5, y: 8 });
        placeUnit(combat.grid, combat.unitsHolder, large, { x: 7, y: 8 });
        // (9,8) is where THIS helper's projection lands for a 2x2 primary — its own long-standing
        // geometry, which this test neither changes nor endorses. All that matters below is that the same
        // board answers differently depending on one flag.
        placeUnit(combat.grid, combat.unitsHolder, behind, { x: 9, y: 8 });
        return { combat, pikeman, large, behind };
    };

    it("Skewer Strike's flags spare everything behind a large primary target", () => {
        const { combat, pikeman, large } = build();
        const targets = nextStandingTargets(
            pikeman,
            large,
            combat.grid,
            combat.unitsHolder,
            pikeman.getBaseCell(),
            false, // pierceLargeUnits — skewer_strike_ability.ts
            true, // onlyOppositeTeam
        );
        expect(targets).toHaveLength(0);
    });

    it("Fire Breath's flags carry through that same large target", () => {
        const { combat, pikeman, large, behind } = build();
        const targets = nextStandingTargets(
            pikeman,
            large,
            combat.grid,
            combat.unitsHolder,
            pikeman.getBaseCell(),
            true, // pierceLargeUnits — fire_breath_ability.ts default
            false, // onlyOppositeTeam
        );
        // Same board, same primary: only the flag differs, and now the unit behind is swept.
        expect(targets.map((u) => u.getId())).toContain(behind.getId());
    });
});
