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
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForFootprintAnchor } from "../../src/grid/grid_math";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, testGridSettings } from "../helpers/combat";
import type { XY } from "../../src/utils/math";

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
 * An aura must be applied to a unit ONCE, however many cells that unit's body covers.
 *
 * The pass walks the recipient's cells and applies whatever aura covers each of them. Its "only once"
 * guard compared the BARE effect name against a list it filled with the SUFFIXED one (`${name} Aura`) —
 * and no aura effect carries that suffix, so the test was never true. Every covering cell applied the aura
 * again, and `Unit.applyAuraEffect` deletes-then-pushes, so the surviving value was whichever cell came
 * LAST in `getCells()` rather than the strongest source covering the body.
 *
 * On a 1x1 recipient there is one cell and the defect cannot show. It needed a multi-cell body — which
 * meant 2x2 creatures only, until the mounted class shipped 2x1 and gave it thirteen more carriers.
 */
describe("auras on a body wider than one cell", () => {
    const place = (context: ReturnType<typeof createCombatTestContext>, unit: Unit, anchor: XY): void => {
        const position = getPositionForFootprintAnchor(
            context.grid.getSettings(),
            anchor,
            unit.getFootprintWidth(),
            unit.getFootprintHeight(),
        );
        unit.setPosition(position.x, position.y);
        expect(
            context.grid.occupyCells(
                unit.getCells(),
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.canTraverseLava(),
                false,
            ),
        ).toBe(true);
        context.unitsHolder.addUnit(unit);
    };

    /** Every applyAuraEffect call made on `unit` during `run`, in order. */
    const recordAuraApplications = (unit: Unit, run: () => void): Array<{ name: string; power: number }> => {
        const calls: Array<{ name: string; power: number }> = [];
        const original = unit.applyAuraEffect.bind(unit);
        (unit as unknown as { applyAuraEffect: unknown }).applyAuraEffect = (
            name: string,
            description: string,
            isBuff: boolean,
            power: number,
            sourceCell: string,
        ) => {
            calls.push({ name, power });
            original(name, description, isBuff, power, sourceCell);
        };
        try {
            run();
        } finally {
            (unit as unknown as { applyAuraEffect: unknown }).applyAuraEffect = original;
        }
        return calls;
    };

    it("applies one aura once to a 2x1 recipient, not once per body cell", () => {
        const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const team = PBTypes.TeamVals.LEFT;

        // Wolf Rider emits Wolf Trail; Nomad is a 2x1 that carries no aura of its own.
        const rider = createConfiguredUnit("Might", "Wolf Rider", team, 10);
        const nomad = createConfiguredUnit("Might", "Nomad", team, 5);
        place(context, rider, { x: 11, y: 8 });
        // Anchored so BOTH of the Nomad's cells sit inside the rider's aura. With only one cell covered the
        // fixture cannot discriminate — the old code would apply once too, for the wrong reason.
        place(context, nomad, { x: 9, y: 8 });

        // The premise: the recipient really does cover two cells, and both are inside the aura.
        expect(nomad.getCells()).toHaveLength(2);

        const calls = recordAuraApplications(nomad, () => context.unitsHolder.refreshAuraEffectsForAllUnits());
        const wolfTrail = calls.filter((call) => call.name === "Wolf Trail Aura");
        expect(wolfTrail).toHaveLength(1);
    });

    it("applies one aura once to a 2x2 recipient either — the same defect predated any rectangle", () => {
        const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const team = PBTypes.TeamVals.LEFT;

        const rider = createConfiguredUnit("Might", "Wolf Rider", team, 10);
        const behemoth = createConfiguredUnit("Might", "Behemoth", team, 2);
        place(context, rider, { x: 11, y: 8 });
        place(context, behemoth, { x: 9, y: 9 });

        expect(behemoth.getCells()).toHaveLength(4);

        const calls = recordAuraApplications(behemoth, () => context.unitsHolder.refreshAuraEffectsForAllUnits());
        const wolfTrail = calls.filter((call) => call.name === "Wolf Trail Aura");
        expect(wolfTrail).toHaveLength(1);
    });
});
