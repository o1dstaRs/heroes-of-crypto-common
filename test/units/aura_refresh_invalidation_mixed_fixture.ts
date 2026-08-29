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
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { Unit } from "../../src/units/unit";
import type { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const MIXED_EVENT_TRACE_SHARD_COUNT = 4;
const NORMAL_SEED_COUNT = 12;
const NORMAL_STEPS_PER_SEED = 64;
const DEEP_SEED_COUNT = 64;
const DEEP_STEPS_PER_SEED = 192;
// Deep mode intentionally executes 12,288 snapshot/full-refresh comparisons. Its four file shards run in
// parallel and can each cross Bun's 5-second default under contention, without being stuck or losing coverage.
const MIXED_EVENT_TRACE_TIMEOUT_MS = 30_000;

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

function seedOrdinalsForShard(seedCount: number, shardIndex: number): number[] {
    const seeds: number[] = [];
    for (let seed = shardIndex + 1; seed <= seedCount; seed += MIXED_EVENT_TRACE_SHARD_COUNT) {
        seeds.push(seed);
    }
    return seeds;
}

function fullSeedCensus(seedCount: number): number[] {
    return Array.from({ length: MIXED_EVENT_TRACE_SHARD_COUNT }, (_, shardIndex) =>
        seedOrdinalsForShard(seedCount, shardIndex),
    )
        .flat()
        .sort((left, right) => left - right);
}

export function registerAuraRefreshMixedEventTraceCensus(): void {
    describe("aura refresh dirty invalidation", () => {
        it("partitions every normal and deep mixed-event seed into one file isolate", () => {
            const normalSeeds = fullSeedCensus(NORMAL_SEED_COUNT);
            const deepSeeds = fullSeedCensus(DEEP_SEED_COUNT);

            expect(normalSeeds).toEqual(Array.from({ length: NORMAL_SEED_COUNT }, (_, index) => index + 1));
            expect(deepSeeds).toEqual(Array.from({ length: DEEP_SEED_COUNT }, (_, index) => index + 1));
            expect(new Set(normalSeeds).size).toBe(NORMAL_SEED_COUNT);
            expect(new Set(deepSeeds).size).toBe(DEEP_SEED_COUNT);
        });
    });
}

export function registerAuraRefreshMixedEventTraceShard(shardIndex: number): void {
    if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= MIXED_EVENT_TRACE_SHARD_COUNT) {
        throw new Error(`Unknown aura-refresh mixed-event shard ${shardIndex}`);
    }

    describe("aura refresh dirty invalidation", () => {
        it(
            `matches the forced full oracle through deterministic mixed-event traces in shard ${shardIndex + 1}`,
            () => {
                const deep = process.env.A13_AURA_ORACLE_DEEP === "1";
                const seedCount = deep ? DEEP_SEED_COUNT : NORMAL_SEED_COUNT;
                const stepsPerSeed = deep ? DEEP_STEPS_PER_SEED : NORMAL_STEPS_PER_SEED;
                const seeds = seedOrdinalsForShard(seedCount, shardIndex);

                for (const seed of seeds) {
                    const { grid, unitsHolder } = createCombatTestContext();
                    const units: Unit[] = [
                        createTestUnit({
                            name: `Lower Aura ${seed}`,
                            team: PBTypes.TeamVals.LEFT,
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
                            team: PBTypes.TeamVals.LEFT,
                            size: PBTypes.UnitSizeVals.LARGE,
                            attackType: PBTypes.AttackVals.RANGE,
                            rangeShots: 3,
                        }),
                        createTestUnit({
                            name: `Lower Walker ${seed}`,
                            team: PBTypes.TeamVals.LEFT,
                        }),
                        createTestUnit({
                            name: `Upper Aura ${seed}`,
                            team: PBTypes.TeamVals.RIGHT,
                            size: PBTypes.UnitSizeVals.LARGE,
                            stackPower: 4,
                            auraEffects: [
                                "Range Null Field",
                                "Venom Cloud",
                                "Web",
                                "Absorb Penalties",
                                "Pegasus Might",
                                "Wolf Trail",
                            ],
                        }),
                        createTestUnit({
                            name: `Upper Flyer ${seed}`,
                            team: PBTypes.TeamVals.RIGHT,
                            movementType: PBTypes.MovementVals.FLY,
                        }),
                        createTestUnit({
                            name: `Upper Ranged ${seed}`,
                            team: PBTypes.TeamVals.RIGHT,
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
                    for (let index = 0; index < units.length; index += 1) {
                        placeUnit(grid, unitsHolder, units[index], initialCells[index]);
                    }

                    const random = makeRng(seed * 0x9e3779b1);
                    expect(compareWithForcedFullRefresh(unitsHolder, grid)).toBe(true);

                    for (let step = 0; step < stepsPerSeed; step += 1) {
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
                                const auraDebuff = unit
                                    .getDebuffs()
                                    .find((debuff) => debuff.getName().endsWith(" Aura"));
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

                expect(seeds).toHaveLength(deep ? DEEP_SEED_COUNT / 4 : NORMAL_SEED_COUNT / 4);
            },
            MIXED_EVENT_TRACE_TIMEOUT_MS,
        );
    });
}
