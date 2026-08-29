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

import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const numberBitsView = new DataView(new ArrayBuffer(8));

function numberBits(value: number): string {
    numberBitsView.setFloat64(0, value, false);
    return numberBitsView.getBigUint64(0, false).toString(16).padStart(16, "0");
}

function exactValue(value: unknown): unknown {
    if (typeof value === "number") {
        return { numberBits: numberBits(value) };
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(exactValue);
    }
    if (value instanceof Map) {
        return {
            map: Array.from(value, ([key, entry]) => [exactValue(key), exactValue(entry)]),
        };
    }
    if (value instanceof Set) {
        return { set: Array.from(value, exactValue) };
    }

    const record = value as Record<string, unknown>;
    return {
        type: Object.getPrototypeOf(value)?.constructor?.name ?? "Object",
        fields: Object.keys(record)
            .sort()
            .map((key) => [key, exactValue(record[key])]),
    };
}

function semanticBattleState(snapshot: ReturnType<typeof snapshotBattle>): unknown {
    const holder = { ...snapshot.holder };
    delete holder.auraRefreshFingerprint;

    return exactValue({
        units: snapshot.units,
        unitOrder: snapshot.unitOrder,
        grid: snapshot.grid,
        fight: snapshot.fight,
        holder,
    });
}

function positionForCell(cell: XY): XY {
    return getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
}

function compareWithForcedFullRefresh(
    unitsHolder: UnitsHolder,
    grid: ReturnType<typeof createCombatTestContext>["grid"],
): boolean {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const before = snapshotBattle(unitsHolder, grid, fightProperties);

    const changed = unitsHolder.refreshAuraEffectsIfNeeded();
    const candidateAfter = snapshotBattle(unitsHolder, grid, fightProperties);
    const candidateState = semanticBattleState(candidateAfter);

    restoreBattle(before, unitsHolder, grid, fightProperties);
    unitsHolder.refreshAuraEffectsForAllUnits();
    const oracleState = semanticBattleState(snapshotBattle(unitsHolder, grid, fightProperties));
    expect(candidateState).toEqual(oracleState);

    restoreBattle(candidateAfter, unitsHolder, grid, fightProperties);
    return changed;
}

describe("aura refresh dirty invalidation", () => {
    it("matches a forced full refresh through no-op, movement, cleanse, power, Break, and restore events", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const leftEmitter = createTestUnit({
            name: "Lower Emitter",
            team: PBTypes.TeamVals.LEFT,
            luck: 4,
            stackPower: 3,
            auraEffects: ["Luck", "Flesh Shield", "Sharpened Weapons"],
        });
        const leftLarge = createTestUnit({
            name: "Large Recipient",
            team: PBTypes.TeamVals.LEFT,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const rightEmitter = createTestUnit({
            name: "Upper Emitter",
            team: PBTypes.TeamVals.RIGHT,
            auraEffects: ["Range Null Field", "Venom Cloud"],
        });
        const rightRanged = createTestUnit({
            name: "Upper Ranged",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
            luck: -2,
        });

        placeUnit(grid, unitsHolder, leftEmitter, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, leftLarge, { x: 6, y: 5 });
        placeUnit(grid, unitsHolder, rightEmitter, { x: 8, y: 5 });
        placeUnit(grid, unitsHolder, rightRanged, { x: 7, y: 5 });

        const compare = (expectedChanged: boolean): void => {
            expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(expectedChanged);
        };

        compare(true);
        compare(false);

        leftLarge.deleteBuff("Luck Aura");
        compare(true);

        leftEmitter.setStackPower(5);
        compare(true);

        leftEmitter.getAuraEffect("Luck")!.extendRange();
        compare(true);

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setSynergiesPerTeam(PBTypes.TeamVals.LEFT, ["Might:1:3"]);
        compare(true);
        fightProperties.setSynergiesPerTeam(PBTypes.TeamVals.LEFT, ["Might:2:3"]);
        compare(true);
        fightProperties.setSynergiesPerTeam(PBTypes.TeamVals.LEFT, []);
        compare(true);

        const movedLargePosition = positionForCell({ x: 5, y: 5 });
        leftLarge.setPosition(movedLargePosition.x, movedLargePosition.y);
        compare(true);

        leftEmitter.applyEffect(new EffectFactory().makeEffect("Break")!);
        compare(true);
        leftEmitter.deleteEffect("Break");
        compare(true);

        const stable = snapshotBattle(unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
        const movedEmitterPosition = positionForCell({ x: 12, y: 12 });
        rightEmitter.setPosition(movedEmitterPosition.x, movedEmitterPosition.y);
        compare(true);
        restoreBattle(stable, unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
        compare(false);

        rightEmitter.applyDamage(1_000_000, 0, new SceneLogMock());
        compare(false);
        expect(rightRanged.hasBuffActive("Venom Cloud Aura")).toBe(true);

        unitsHolder.deleteUnitById(rightEmitter.getId());
        compare(true);
        expect(rightRanged.hasBuffActive("Venom Cloud Aura")).toBe(false);

        const offGridPosition = positionForCell({ x: 30, y: 30 });
        rightRanged.setPosition(offGridPosition.x, offGridPosition.y);
        compare(true);
        compare(false);
    });

    it("fails closed to a full refresh for extended or malformed aura-property shapes", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const emitter = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            auraEffects: ["Luck"],
        });
        placeUnit(grid, unitsHolder, emitter, { x: 4, y: 4 });

        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(false);

        const defaultProperties = emitter.getAuraEffect("Luck")!.defaultProperties as unknown as Record<
            string,
            unknown
        >;
        defaultProperties.experimental = 1;

        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);

        delete defaultProperties.experimental;
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(false);

        // Object.keys only saw enumerable keys in the original exact-shape check. Keep failing closed when a
        // required field exists but is hidden and an enumerable extra field takes its place in the key count.
        Object.defineProperty(defaultProperties, "is_buff", { enumerable: false });
        defaultProperties.experimental = 1;
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);

        Object.defineProperty(defaultProperties, "is_buff", { enumerable: true });
        delete defaultProperties.experimental;
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(true);
        expect(unitsHolder.refreshAuraEffectsIfNeeded()).toBe(false);
    });

    it("invalidates when an aura ability is stolen and restored at runtime", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const emitter = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Flesh Shield Aura"],
            stackPower: 5,
        });
        const recipient = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, emitter, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, recipient, { x: 5, y: 4 });

        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(recipient.hasBuffActive("Flesh Shield Aura")).toBe(true);

        expect(emitter.disableAbilityAsStolen("Flesh Shield Aura")).toBeDefined();
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(recipient.hasBuffActive("Flesh Shield Aura")).toBe(false);

        emitter.grantStolenAbility("Flesh Shield Aura");
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(recipient.hasBuffActive("Flesh Shield Aura")).toBe(true);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(false);
    });

    it("keeps rebuilding while applied-effect property arrays are misaligned", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const emitter = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            auraEffects: ["Luck"],
        });
        const recipient = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, emitter, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, recipient, { x: 5, y: 4 });

        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        recipient.getUnitProperties().applied_buffs_descriptions.push("malformed-extra-description");
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
    });

    it("invalidates finite property rows that are changed to collide with permanent aura names", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const allyEmitter = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            auraEffects: ["Luck"],
        });
        const enemyEmitter = createTestUnit({
            team: PBTypes.TeamVals.RIGHT,
            auraEffects: ["Range Null Field"],
        });
        const recipient = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        placeUnit(grid, unitsHolder, allyEmitter, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, enemyEmitter, { x: 7, y: 4 });
        placeUnit(grid, unitsHolder, recipient, { x: 5, y: 4 });

        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        const initialProperties = recipient.getUnitProperties();
        initialProperties.applied_buffs.push("Other Buff");
        initialProperties.applied_buffs_laps.push(1);
        initialProperties.applied_buffs_descriptions.push("other buff");
        initialProperties.applied_buffs_powers.push(1);
        initialProperties.applied_debuffs.push("Other Debuff");
        initialProperties.applied_debuffs_laps.push(1);
        initialProperties.applied_debuffs_descriptions.push("other debuff");
        initialProperties.applied_debuffs_powers.push(1);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);

        const properties = recipient.getUnitProperties();
        properties.applied_buffs[properties.applied_buffs.indexOf("Other Buff")] = "Luck Aura";
        properties.applied_debuffs[properties.applied_debuffs.indexOf("Other Debuff")] = "Range Null Field Aura";
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(properties.applied_buffs.filter((name) => name === "Luck Aura")).toHaveLength(1);
        expect(properties.applied_debuffs.filter((name) => name === "Range Null Field Aura")).toHaveLength(1);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(false);
    });

    it("keeps the aura-free fast path exact and notices a manually injected permanent effect", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const unit = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const recipient = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, recipient, { x: 5, y: 4 });

        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(false);

        unit.getAuraEffects().push(new EffectFactory().makeAuraEffect("Luck")!);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(recipient.hasBuffActive("Luck Aura")).toBe(true);

        unit.applyAuraEffect("Manual Aura", "manual", true, 7, "4;4");
        expect(unit.hasBuffActive("Manual Aura")).toBe(true);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);
        expect(unit.hasBuffActive("Manual Aura")).toBe(false);
        expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(false);
    });
});
