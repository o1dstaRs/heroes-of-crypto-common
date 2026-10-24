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

function auraMapsForLeft(unitsHolder: UnitsHolder): AuraMaps {
    const holder = unitsHolder as unknown as {
        teamsAuraEffects: Map<number, AuraMaps>;
    };
    const maps = holder.teamsAuraEffects.get(PBTypes.TeamVals.LEFT);
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
            team: PBTypes.TeamVals.LEFT,
            stackPower: 1,
            auraEffects: ["Luck", "Absorb Penalties"],
        });
        const strongest = createTestUnit({
            name: "Strongest source",
            team: PBTypes.TeamVals.LEFT,
            stackPower: 5,
            auraEffects: ["Absorb Penalties"],
        });
        const equalLater = createTestUnit({
            name: "Equal later source",
            team: PBTypes.TeamVals.LEFT,
            stackPower: 5,
            auraEffects: ["Absorb Penalties"],
        });
        const recipient = createTestUnit({
            name: "Recipient",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
        });

        placeUnit(grid, unitsHolder, first, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, strongest, { x: 5, y: 4 });
        placeUnit(grid, unitsHolder, equalLater, { x: 6, y: 4 });
        placeUnit(grid, unitsHolder, recipient, { x: 5, y: 5 });
        unitsHolder.refreshAuraEffectsForAllUnits();

        const beforeMaps = auraMapsForLeft(unitsHolder);
        const targetAuras = aurasAt(beforeMaps, 5, 5);
        expect(targetAuras.map((aura) => aura.getAuraEffectProperties().name)).toEqual(["Luck", "Absorb Penalties"]);

        const absorb = targetAuras[1];
        expect(absorb.getAuraEffectProperties().power).toBe(50);
        expect(absorb.getSourceCellAsString()).toBe("5;4");
        expect(recipient.getBuff("Absorb Penalties Aura")?.getPower()).toBe(50);
        expect(recipient.getBuff("Absorb Penalties Aura")?.getFirstSpellProperty()).toBe(5);
        expect(recipient.getBuff("Absorb Penalties Aura")?.getSecondSpellProperty()).toBe(4);

        const neighboringAbsorb = aurasAt(beforeMaps, 5, 4).find(
            (aura) => aura.getAuraEffectProperties().name === "Absorb Penalties",
        );
        expect(neighboringAbsorb).toBeDefined();
        expect(neighboringAbsorb).not.toBe(absorb);
        expect(neighboringAbsorb!.getAuraEffectProperties()).toBe(absorb.getAuraEffectProperties());

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const snapshot = snapshotBattle(unitsHolder, grid, fightProperties);
        unitsHolder.refreshAuraEffectsForAllUnits();
        restoreBattle(snapshot, unitsHolder, grid, fightProperties);

        const restoredTargetAuras = aurasAt(auraMapsForLeft(unitsHolder), 5, 5);
        expect(restoredTargetAuras.map((aura) => aura.getAuraEffectProperties().name)).toEqual([
            "Luck",
            "Absorb Penalties",
        ]);
        expect(restoredTargetAuras[1].getAuraEffectProperties().power).toBe(50);
        expect(restoredTargetAuras[1].getSourceCellAsString()).toBe("5;4");
    });
});
