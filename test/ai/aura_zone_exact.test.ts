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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { auraCoverageScore } from "../../src/ai/ai";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;

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
 * What the AI thinks its aura covers, against what the engine actually stamps.
 *
 * `UnitsHolder.refreshAuraEffectsForAllUnits` unions the per-cell ball over the emitter's WHOLE body and
 * applies the aura when ANY cell of the recipient's body falls inside. `auraCoverageScore` asks a single
 * ball at the emitter's anchor and tests only the recipient's anchor, so it under-counts every multi-cell
 * emitter — at range 2, 5 of a 2x1's 30 cells and 11 of a 2x2's 36.
 *
 * The board below is built so the ONLY thing separating the two answers is that difference: the Nomad
 * stands in the column the anchor ball drops, so the engine buffs it and the AI scores it at zero.
 *
 * `AI_AURA_ZONE_EXACT` is default-OFF and this pins BOTH sides of it, because the flag is not a rectangle
 * repair — 2x2 emitters have been priced the same way since long before the mounted class, so switching it
 * on moves decisions for shipped squares and the weights above it were fitted against the current answer.
 */
describe("aura coverage priced the way the engine stamps it", () => {
    afterEach(() => {
        delete process.env.AI_AURA_ZONE_EXACT;
    });

    const build = () => {
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        // Wolf Rider is 2x1 and emits Wolf Trail (range 2, buff). Anchored at (5,5) its body is
        // {(5,5),(4,5)}, so the engine's zone spans x 2..7 while the anchor ball only reaches x 3..7.
        const rider = createConfiguredUnit("Might", "Wolf Rider", LOWER, 10);
        const nomad = createConfiguredUnit("Might", "Nomad", LOWER, 5);
        placeUnit(combat.grid, combat.unitsHolder, rider, { x: 5, y: 5 });
        // Anchor (2,5) sits in the engine's zone and outside the anchor ball — the whole disagreement.
        placeUnit(combat.grid, combat.unitsHolder, nomad, { x: 2, y: 5 });
        return { combat, rider, nomad };
    };

    it("the engine really does buff the ally the anchor ball misses", () => {
        const { combat, nomad } = build();
        combat.unitsHolder.refreshAuraEffectsForAllUnits();
        // Authority: not a restatement of either formula, but whether the buff landed.
        expect(nomad.getBuff("Wolf Trail Aura")).toBeDefined();
    });

    it("scores zero by default, which is what the anchor ball sees", () => {
        const { combat, rider } = build();
        combat.unitsHolder.refreshAuraEffectsForAllUnits();
        expect(auraCoverageScore(rider, rider.getBaseCell(), testGridSettings, combat.unitsHolder)).toBe(0);
    });

    it("counts that ally once the exact zone is armed", () => {
        process.env.AI_AURA_ZONE_EXACT = "1";
        const { combat, rider } = build();
        combat.unitsHolder.refreshAuraEffectsForAllUnits();
        expect(auraCoverageScore(rider, rider.getBaseCell(), testGridSettings, combat.unitsHolder)).toBe(1);
    });
});
