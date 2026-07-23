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
import type { Unit } from "../../src/units/unit";
import type { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function numberBits(value: number): string {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    return view.getBigUint64(0, false).toString(16).padStart(16, "0");
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

function semanticBattleState(
    unitsHolder: UnitsHolder,
    grid: ReturnType<typeof createCombatTestContext>["grid"],
): unknown {
    const snapshot = snapshotBattle(unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
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
    const candidateState = semanticBattleState(unitsHolder, grid);

    restoreBattle(before, unitsHolder, grid, fightProperties);
    unitsHolder.refreshAuraEffectsForAllUnits();
    const oracleState = semanticBattleState(unitsHolder, grid);
    expect(candidateState).toEqual(oracleState);

    restoreBattle(candidateAfter, unitsHolder, grid, fightProperties);
    return changed;
}

function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

describe("aura refresh dirty invalidation", () => {
    it("matches a forced full refresh through no-op, movement, cleanse, power, Break, and restore events", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const lowerEmitter = createTestUnit({
            name: "Lower Emitter",
            team: PBTypes.TeamVals.LOWER,
            luck: 4,
            stackPower: 3,
            auraEffects: ["Luck", "Flesh Shield", "Sharpened Weapons"],
        });
        const lowerLarge = createTestUnit({
            name: "Large Recipient",
            team: PBTypes.TeamVals.LOWER,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const upperEmitter = createTestUnit({
            name: "Upper Emitter",
            team: PBTypes.TeamVals.UPPER,
            auraEffects: ["Range Null Field", "Poison Cloud"],
        });
        const upperRanged = createTestUnit({
            name: "Upper Ranged",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
            luck: -2,
        });

        placeUnit(grid, unitsHolder, lowerEmitter, { x: 4, y: 4 });
        placeUnit(grid, unitsHolder, lowerLarge, { x: 6, y: 5 });
        placeUnit(grid, unitsHolder, upperEmitter, { x: 8, y: 5 });
        placeUnit(grid, unitsHolder, upperRanged, { x: 7, y: 5 });

        const compare = (expectedChanged: boolean): void => {
            expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(expectedChanged);
        };

        compare(true);
        compare(false);

        lowerLarge.deleteBuff("Luck Aura");
        compare(true);

        lowerEmitter.setStackPower(5);
        compare(true);

        lowerEmitter.getAuraEffect("Luck")!.extendRange();
        compare(true);

        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setSynergiesPerTeam(PBTypes.TeamVals.LOWER, ["Might:1:3"]);
        compare(true);
        fightProperties.setSynergiesPerTeam(PBTypes.TeamVals.LOWER, ["Might:2:3"]);
        compare(true);
        fightProperties.setSynergiesPerTeam(PBTypes.TeamVals.LOWER, []);
        compare(true);

        const movedLargePosition = positionForCell({ x: 5, y: 5 });
        lowerLarge.setPosition(movedLargePosition.x, movedLargePosition.y);
        compare(true);

        lowerEmitter.applyEffect(new EffectFactory().makeEffect("Break")!);
        compare(true);
        lowerEmitter.deleteEffect("Break");
        compare(true);

        const stable = snapshotBattle(unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
        const movedEmitterPosition = positionForCell({ x: 12, y: 12 });
        upperEmitter.setPosition(movedEmitterPosition.x, movedEmitterPosition.y);
        compare(true);
        restoreBattle(stable, unitsHolder, grid, FightStateManager.getInstance().getFightProperties());
        compare(false);

        upperEmitter.applyDamage(1_000_000, 0, new SceneLogMock());
        compare(false);
        expect(upperRanged.hasBuffActive("Poison Cloud Aura")).toBe(true);

        unitsHolder.deleteUnitById(upperEmitter.getId());
        compare(true);
        expect(upperRanged.hasBuffActive("Poison Cloud Aura")).toBe(false);

        const offGridPosition = positionForCell({ x: 30, y: 30 });
        upperRanged.setPosition(offGridPosition.x, offGridPosition.y);
        compare(true);
        compare(false);
    });

    it("fails closed to a full refresh for extended or malformed aura-property shapes", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const emitter = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
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
    });

    it("invalidates when an aura ability is stolen and restored at runtime", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const emitter = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            abilities: ["Flesh Shield Aura"],
            stackPower: 5,
        });
        const recipient = createTestUnit({ team: PBTypes.TeamVals.LOWER });
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
            team: PBTypes.TeamVals.LOWER,
            auraEffects: ["Luck"],
        });
        const recipient = createTestUnit({ team: PBTypes.TeamVals.LOWER });
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
            team: PBTypes.TeamVals.LOWER,
            auraEffects: ["Luck"],
        });
        const enemyEmitter = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            auraEffects: ["Range Null Field"],
        });
        const recipient = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
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
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const recipient = createTestUnit({ team: PBTypes.TeamVals.LOWER });
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

    it("matches the forced full oracle through deterministic mixed-event traces", () => {
        const deep = process.env.A13_AURA_ORACLE_DEEP === "1";
        const seedCount = deep ? 64 : 12;
        const stepsPerSeed = deep ? 192 : 64;

        for (let seed = 1; seed <= seedCount; seed++) {
            const { grid, unitsHolder } = createCombatTestContext();
            const units: Unit[] = [
                createTestUnit({
                    name: `Lower Aura ${seed}`,
                    team: PBTypes.TeamVals.LOWER,
                    stackPower: 2,
                    auraEffects: [
                        "Luck",
                        "Flesh Shield",
                        "Sharpened Weapons",
                        "Disguise",
                        "Tie up the Horses",
                        "War Anger",
                    ],
                }),
                createTestUnit({
                    name: `Lower Large ${seed}`,
                    team: PBTypes.TeamVals.LOWER,
                    size: PBTypes.UnitSizeVals.LARGE,
                    attackType: PBTypes.AttackVals.RANGE,
                    rangeShots: 3,
                }),
                createTestUnit({
                    name: `Lower Walker ${seed}`,
                    team: PBTypes.TeamVals.LOWER,
                }),
                createTestUnit({
                    name: `Upper Aura ${seed}`,
                    team: PBTypes.TeamVals.UPPER,
                    size: PBTypes.UnitSizeVals.LARGE,
                    stackPower: 4,
                    auraEffects: [
                        "Range Null Field",
                        "Poison Cloud",
                        "Web",
                        "Arrows Wingshield",
                        "Absorb Penalties",
                        "Pegasus Might",
                        "Wolf Trail",
                    ],
                }),
                createTestUnit({
                    name: `Upper Flyer ${seed}`,
                    team: PBTypes.TeamVals.UPPER,
                    movementType: PBTypes.MovementVals.FLY,
                }),
                createTestUnit({
                    name: `Upper Ranged ${seed}`,
                    team: PBTypes.TeamVals.UPPER,
                    attackType: PBTypes.AttackVals.RANGE,
                    rangeShots: 3,
                }),
            ];
            const initialCells = [
                { x: 3, y: 3 },
                { x: 5, y: 4 },
                { x: 7, y: 4 },
                { x: 10, y: 10 },
                { x: 8, y: 9 },
                { x: 6, y: 8 },
            ];
            for (let i = 0; i < units.length; i++) {
                placeUnit(grid, unitsHolder, units[i], initialCells[i]);
            }

            const random = makeRng(seed * 0x9e3779b1);
            expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);

            for (let step = 0; step < stepsPerSeed; step++) {
                const unit = units[Math.floor(random() * units.length)];
                const properties = unit.getUnitProperties() as {
                    attack_type: number;
                    luck: number;
                    movement_type: number;
                };

                switch (step % 10) {
                    case 0:
                        break;
                    case 1: {
                        const position = positionForCell({
                            x: 1 + Math.floor(random() * 14),
                            y: 1 + Math.floor(random() * 14),
                        });
                        unit.setPosition(position.x, position.y);
                        break;
                    }
                    case 2:
                        units[step % 2 === 0 ? 0 : 3].setStackPower(1 + Math.floor(random() * 5));
                        break;
                    case 3:
                        properties.luck = Math.floor(random() * 21) - 10;
                        break;
                    case 4:
                        if (unit.hasEffectActive("Break")) {
                            unit.deleteEffect("Break");
                        } else {
                            unit.applyEffect(new EffectFactory().makeEffect("Break")!);
                        }
                        break;
                    case 5: {
                        const aura = unit.getAuraEffects()[0];
                        if (aura) {
                            random() < 0.5 ? aura.extendRange() : aura.narrowRange();
                        }
                        break;
                    }
                    case 6: {
                        const auraBuff = unit.getBuffs().find((buff) => buff.getName().endsWith(" Aura"));
                        const auraDebuff = unit.getDebuffs().find((debuff) => debuff.getName().endsWith(" Aura"));
                        if (auraBuff) {
                            unit.deleteBuff(auraBuff.getName());
                        } else if (auraDebuff) {
                            unit.deleteDebuff(auraDebuff.getName());
                        }
                        break;
                    }
                    case 7:
                        properties.attack_type =
                            properties.attack_type === PBTypes.AttackVals.RANGE
                                ? PBTypes.AttackVals.MELEE
                                : PBTypes.AttackVals.RANGE;
                        break;
                    case 8:
                        properties.movement_type =
                            properties.movement_type === PBTypes.MovementVals.FLY
                                ? PBTypes.MovementVals.WALK
                                : PBTypes.MovementVals.FLY;
                        break;
                    case 9: {
                        const orderedUnits = unitsHolder.getAllUnits() as Map<string, Unit>;
                        orderedUnits.delete(unit.getId());
                        orderedUnits.set(unit.getId(), unit);
                        break;
                    }
                }

                compareWithForcedFullRefresh(unitsHolder, grid);
            }
        }
    });
});
