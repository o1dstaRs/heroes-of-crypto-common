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

import type { AppliedAuraEffectProperties } from "../../src/effects/effect_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { UnitsHolder } from "../../src/units/units_holder";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

type AuraMaps = Map<number, AppliedAuraEffectProperties[]>;

function auraMapsForLower(unitsHolder: UnitsHolder): AuraMaps {
    const holder = unitsHolder as unknown as {
        teamsAuraEffects: Map<number, AuraMaps>;
    };
    const maps = holder.teamsAuraEffects.get(PBTypes.TeamVals.LOWER);
    if (!maps) throw new Error("Lower aura map is missing");
    return maps;
}

function aurasAt(maps: AuraMaps, x: number, y: number): AppliedAuraEffectProperties[] {
    const auras = maps.get((x << 4) | y);
    if (!auras) throw new Error(`Aura cell ${x};${y} is missing`);
    return auras;
}

describe("UnitsHolder aura-map aggregation", () => {
    it("keeps first-name order, replaces only with stronger sources, and preserves live aliases plus restore shape", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const first = createTestUnit({
            name: "First source",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 1,
            auraEffects: ["Luck", "Sharpened Weapons"],
        });
        const strongest = createTestUnit({
            name: "Strongest source",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            auraEffects: ["Sharpened Weapons"],
        });
        const equalLater = createTestUnit({
            name: "Equal later source",
            team: PBTypes.TeamVals.LOWER,
            stackPower: 5,
            auraEffects: ["Sharpened Weapons"],
        });
        const recipient = createTestUnit({
            name: "Recipient",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE,
        });

        placeUnit(grid, unitsHolder, first, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, strongest, { x: 5, y: 4 });
        placeUnit(grid, unitsHolder, equalLater, { x: 6, y: 4 });
        placeUnit(grid, unitsHolder, recipient, { x: 5, y: 5 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const beforeMaps = auraMapsForLower(unitsHolder);
        const targetAuras = aurasAt(beforeMaps, 5, 5);
        expect(targetAuras.map((aura) => aura.getAuraEffectProperties().name)).toEqual(["Luck", "Sharpened Weapons"]);

        const sharpened = targetAuras[1];
        expect(sharpened.getAuraEffectProperties().power).toBe(18);
        expect(sharpened.getSourceCellAsString()).toBe("5;4");
        expect(recipient.getBuff("Sharpened Weapons Aura")?.getPower()).toBe(18);
        expect(recipient.getBuff("Sharpened Weapons Aura")?.getFirstSpellProperty()).toBe(5);
        expect(recipient.getBuff("Sharpened Weapons Aura")?.getSecondSpellProperty()).toBe(4);

        const neighboringSharpened = aurasAt(beforeMaps, 5, 4).find(
            (aura) => aura.getAuraEffectProperties().name === "Sharpened Weapons",
        );
        expect(neighboringSharpened).toBeDefined();
        expect(neighboringSharpened).not.toBe(sharpened);
        expect(neighboringSharpened!.getAuraEffectProperties()).toBe(sharpened.getAuraEffectProperties());

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const snapshot = snapshotBattle(unitsHolder, grid, fightProperties);
        unitsHolder.refreshAuraEffectsForAllUnits();
        restoreBattle(snapshot, unitsHolder, grid, fightProperties);

        const restoredTargetAuras = aurasAt(auraMapsForLower(unitsHolder), 5, 5);
        expect(restoredTargetAuras.map((aura) => aura.getAuraEffectProperties().name)).toEqual([
            "Luck",
            "Sharpened Weapons",
        ]);
        expect(restoredTargetAuras[1].getAuraEffectProperties().power).toBe(18);
        expect(restoredTargetAuras[1].getSourceCellAsString()).toBe("5;4");
    });
});
