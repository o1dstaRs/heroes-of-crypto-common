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

import {
    ArmorAugment,
    DefaultPlacementLevel1,
    MightAugment,
    MovementAugment,
    PlacementAugment,
    SniperAugment,
} from "../../src/augments/augment_properties";
import {
    HITS_PER_MOUNTAIN,
    NUMBER_OF_LAPS_FIRST_ARMAGEDDON,
    NUMBER_OF_LAPS_TILL_NARROWING_NORMAL,
    STEPS_MORALE_MULTIPLIER,
} from "../../src/constants";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PlacementType } from "../../src/grid/placement_properties";
import {
    ChaosSynergy,
    LifeSynergy,
    MightSynergy,
    NatureSynergy,
    SynergyLevel,
} from "../../src/synergies/synergy_properties";
import type { Unit } from "../../src/units/unit";
import { createTestUnit, testGridSettings } from "../helpers/combat";

describe("FightProperties", () => {
    describe("lifecycle and queues", () => {
        it("tracks fight lifecycle, map state, and lap resets", () => {
            const fightProperties = new FightProperties();

            fightProperties.setGridType(PBTypes.GridVals.BLOCK_CENTER);

            expect(fightProperties.getGridType()).toBe(PBTypes.GridVals.BLOCK_CENTER);
            expect(fightProperties.getPlacementType()).toBe(PlacementType.RECTANGLE);
            expect(fightProperties.getObstacleHitsLeft()).toBe(2 * HITS_PER_MOUNTAIN);
            expect(fightProperties.hasFightStarted()).toBe(false);
            expect(fightProperties.hasFightFinished()).toBe(false);
            expect(fightProperties.getFirstTurnMade()).toBe(false);
            expect(fightProperties.getNumberOfLapsTillNarrowing()).toBe(4);

            fightProperties.markFirstTurn();
            fightProperties.startFight();
            fightProperties.setGridType(PBTypes.GridVals.NORMAL);
            fightProperties.finishFight();

            expect(fightProperties.getFirstTurnMade()).toBe(true);
            expect(fightProperties.hasFightStarted()).toBe(true);
            expect(fightProperties.hasFightFinished()).toBe(true);
            expect(fightProperties.getGridType()).toBe(PBTypes.GridVals.BLOCK_CENTER);

            fightProperties.enqueueUpNext("up-next");
            fightProperties.enqueueMoralePlus("morale-plus");
            fightProperties.enqueueMoraleMinus("morale-minus");
            fightProperties.enqueueHourglass("hourglass");
            fightProperties.addRepliedAttack("reply");
            fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LOWER, "done");
            fightProperties.increaseStepsMoraleMultiplier();
            fightProperties.encounterDamageDealFact();
            fightProperties.encounterObstacleHit(false);

            expect(fightProperties.hasDamageDealFactPerLap(1)).toBe(true);
            expect(fightProperties.getObstacleHitsLeft()).toBe(2 * HITS_PER_MOUNTAIN - 1);
            expect(fightProperties.hasAlreadyMadeTurn("done")).toBe(true);
            expect(fightProperties.getAlreadyMadeTurnSize()).toBe(1);
            expect(fightProperties.hasAlreadyHourglass("hourglass")).toBe(true);
            expect(fightProperties.hasAlreadyRepliedAttack("reply")).toBe(true);
            expect(fightProperties.getStepsMoraleMultiplier()).toBe(STEPS_MORALE_MULTIPLIER);

            fightProperties.flipLap();

            expect(fightProperties.getCurrentLap()).toBe(2);
            expect(fightProperties.hasAlreadyMadeTurn("done")).toBe(false);
            expect(fightProperties.hasAlreadyHourglass("hourglass")).toBe(false);
            expect(fightProperties.hasAlreadyRepliedAttack("reply")).toBe(false);
            expect(fightProperties.getUpNextQueueSize()).toBe(0);
            expect(fightProperties.getMoralePlusQueueSize()).toBe(0);
            expect(fightProperties.getMoraleMinusQueueSize()).toBe(0);
            expect(fightProperties.getHourglassQueueSize()).toBe(0);
        });

        it("restores the authoritative steps morale multiplier", () => {
            const fightProperties = new FightProperties();

            fightProperties.increaseStepsMoraleMultiplier();
            fightProperties.restoreStepsMoraleMultiplier(0.35);

            expect(fightProperties.getStepsMoraleMultiplier()).toBe(0.35);

            fightProperties.restoreStepsMoraleMultiplier(0);

            expect(fightProperties.getStepsMoraleMultiplier()).toBe(0);
        });

        it("rejects invalid authoritative steps morale multipliers without changing state", () => {
            const fightProperties = new FightProperties();

            fightProperties.restoreStepsMoraleMultiplier(0.2);

            for (const invalidValue of [-0.05, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
                expect(() => fightProperties.restoreStepsMoraleMultiplier(invalidValue)).toThrow(RangeError);
                expect(fightProperties.getStepsMoraleMultiplier()).toBe(0.2);
            }
        });

        it("adds, removes, and dequeues turn priority queues in order", () => {
            const fightProperties = new FightProperties();

            fightProperties.enqueueUpNext("one");
            fightProperties.enqueueUpNext("two");
            fightProperties.enqueueMoralePlus("plus");
            fightProperties.enqueueMoraleMinus("minus");
            fightProperties.enqueueHourglass("slow");

            expect(fightProperties.getUpNextQueueSize()).toBe(2);
            expect(fightProperties.upNextIncludes("one")).toBe(true);
            expect(Array.from(fightProperties.getUpNextQueueIterable())).toEqual(["one", "two"]);
            expect(fightProperties.moralePlusIncludes("plus")).toBe(true);
            expect(fightProperties.moraleMinusIncludes("minus")).toBe(true);
            expect(fightProperties.hourglassIncludes("slow")).toBe(true);

            expect(fightProperties.removeFromUpNext("missing")).toBe(false);
            expect(fightProperties.removeFromUpNext("one")).toBe(true);
            fightProperties.removeFromMoralePlusQueue("plus");
            fightProperties.removeFromMoraleMinusQueue("minus");
            fightProperties.removeFromHourglassQueue("slow");

            expect(fightProperties.dequeueNextUnitId()).toBe("two");
            expect(fightProperties.dequeueMoralePlus()).toBeUndefined();
            expect(fightProperties.dequeueMoraleMinus()).toBeUndefined();
            expect(fightProperties.dequeueHourglassQueue()).toBeUndefined();
        });

        it("allocates turn time and grants additional time once per team", () => {
            const fightProperties = new FightProperties();

            expect(fightProperties.requestAdditionalTurnTime()).toBe(0);

            fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 2);
            fightProperties.startTurn(PBTypes.TeamVals.LOWER);

            const originalStart = fightProperties.getCurrentTurnStart();
            const originalEnd = fightProperties.getCurrentTurnEnd();
            const justCheckedAdditionalTime = fightProperties.requestAdditionalTurnTime(PBTypes.TeamVals.LOWER, true);

            expect(originalStart).toBeGreaterThan(0);
            expect(originalEnd).toBeGreaterThan(originalStart);
            expect(justCheckedAdditionalTime).toBeGreaterThan(0);
            expect(fightProperties.getHasAdditionalTimeRequestedPerTeam().get(PBTypes.TeamVals.LOWER)).toBeUndefined();

            const grantedAdditionalTime = fightProperties.requestAdditionalTurnTime(PBTypes.TeamVals.LOWER);

            expect(grantedAdditionalTime).toBe(justCheckedAdditionalTime);
            expect(fightProperties.getCurrentTurnEnd()).toBe(originalEnd + grantedAdditionalTime);
            expect(fightProperties.getHasAdditionalTimeRequestedPerTeam().get(PBTypes.TeamVals.LOWER)).toBe(true);
            expect(fightProperties.requestAdditionalTurnTime(PBTypes.TeamVals.LOWER)).toBe(0);
        });

        it("detects narrowing, dry-center, and armageddon laps", () => {
            const fightProperties = new FightProperties();

            fightProperties.setGridType(PBTypes.GridVals.NORMAL);

            for (let i = 1; i < NUMBER_OF_LAPS_TILL_NARROWING_NORMAL + 1; i++) {
                fightProperties.flipLap();
            }

            expect(fightProperties.getCurrentLap()).toBe(NUMBER_OF_LAPS_TILL_NARROWING_NORMAL + 1);
            expect(fightProperties.isNarrowingLap()).toBe(true);
            expect(fightProperties.getLapsNarrowed()).toBe(1);

            fightProperties.encounterAdditionalNarrowingLap();

            expect(fightProperties.getAdditionalNarrowingLaps()).toBe(1);
            expect(fightProperties.getLapsNarrowed()).toBe(2);

            const lavaFightProperties = new FightProperties();
            lavaFightProperties.setGridType(PBTypes.GridVals.LAVA_CENTER);

            for (let i = 1; i < NUMBER_OF_LAPS_TILL_NARROWING_NORMAL ** 2 + 1; i++) {
                lavaFightProperties.flipLap();
            }

            expect(lavaFightProperties.isTimeToDryCenter()).toBe(true);

            const armageddonFightProperties = new FightProperties();
            for (let i = 1; i < NUMBER_OF_LAPS_FIRST_ARMAGEDDON; i++) {
                armageddonFightProperties.flipLap();
            }

            expect(armageddonFightProperties.getArmageddonWave()).toBe(1);
        });
    });

    describe("augments and synergies", () => {
        it("applies augment budget rules and placement defaults", () => {
            const fightProperties = new FightProperties();

            expect(fightProperties.getAugmentArmor(PBTypes.TeamVals.LOWER)).toBe(ArmorAugment.NO_AUGMENT);
            expect(fightProperties.getAugmentMight(PBTypes.TeamVals.LOWER)).toBe(MightAugment.NO_AUGMENT);
            expect(fightProperties.getAugmentSniper(PBTypes.TeamVals.LOWER)).toBe(SniperAugment.NO_AUGMENT);
            expect(fightProperties.getAugmentMovement(PBTypes.TeamVals.LOWER)).toBe(MovementAugment.NO_AUGMENT);
            expect(fightProperties.getAugmentPlacement(PBTypes.TeamVals.NO_TEAM)).toEqual([]);
            expect(() => fightProperties.getAugmentPlacement(PBTypes.TeamVals.UPPER)).toThrow(
                "Default placement not found",
            );

            fightProperties.setDefaultPlacementPerTeam(PBTypes.TeamVals.LOWER, DefaultPlacementLevel1.THREE_BY_THREE);

            expect(fightProperties.getAugmentPlacement(PBTypes.TeamVals.LOWER)).toEqual([3]);

            fightProperties.setDefaultPlacementPerTeam(PBTypes.TeamVals.LOWER, DefaultPlacementLevel1.FOUR_BY_FOUR);

            expect(fightProperties.getAugmentPlacement(PBTypes.TeamVals.LOWER)).toEqual([3]);
            expect(
                fightProperties.canAugment(PBTypes.TeamVals.NO_TEAM, { type: "Armor", value: ArmorAugment.LEVEL_1 }),
            ).toBe(false);
            expect(
                fightProperties.canAugment(PBTypes.TeamVals.LOWER, {
                    type: "Armor",
                    value: -1 as ArmorAugment,
                }),
            ).toBe(false);

            expect(
                fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                    type: "Placement",
                    value: PlacementAugment.LEVEL_3,
                }),
            ).toBe(true);
            expect(
                fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                    type: "Armor",
                    value: ArmorAugment.LEVEL_3,
                }),
            ).toBe(true);
            expect(
                fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                    type: "Might",
                    value: MightAugment.LEVEL_3,
                }),
            ).toBe(false);
            expect(
                fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
                    type: "Movement",
                    value: MovementAugment.LEVEL_2,
                }),
            ).toBe(true);

            expect(fightProperties.getAugmentPlacement(PBTypes.TeamVals.LOWER)).toEqual([5]);
            expect(fightProperties.getAugmentArmor(PBTypes.TeamVals.LOWER)).toBe(ArmorAugment.LEVEL_3);
            expect(fightProperties.getAugmentMovement(PBTypes.TeamVals.LOWER)).toBe(MovementAugment.LEVEL_2);
            expect(fightProperties.getNumberOfUnitsAvailableForPlacement(PBTypes.TeamVals.LOWER)).toBe(8);
        });

        it("exposes possible synergies and selected synergy bonuses", () => {
            const fightProperties = new FightProperties();
            const team = PBTypes.TeamVals.LOWER;

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.LIFE,
                    LifeSynergy.PLUS_MORALE_AND_LUCK,
                    SynergyLevel.LEVEL_1,
                ),
            ).toBe(false);

            fightProperties.setSynergyUnitsPerFactions(team, 6, 6, 6, 6);

            expect(fightProperties.getPossibleSynergies(team)).toContainEqual({
                faction: PBTypes.FactionVals.LIFE,
                synergy: "PLUS_MORALE_AND_LUCK",
                level: SynergyLevel.LEVEL_3,
            });
            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.LIFE,
                    LifeSynergy.PLUS_MORALE_AND_LUCK,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalMoralePerTeam(team)).toBe(20);
            expect(fightProperties.getAdditionalLuckPerTeam(team)).toBe(9);
            expect(fightProperties.getAdditionalSupplyPerTeam(team)).toBe(0);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.LIFE,
                    LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalSupplyPerTeam(team)).toBe(19);
            expect(fightProperties.getAdditionalMoralePerTeam(team)).toBe(0);
            expect(fightProperties.getAdditionalLuckPerTeam(team)).toBe(0);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.CHAOS,
                    ChaosSynergy.MOVEMENT,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalMovementStepsPerTeam(team)).toBe(3);
            expect(fightProperties.getBreakChancePerTeam(team)).toBe(0);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.CHAOS,
                    ChaosSynergy.BREAK_ON_ATTACK,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getBreakChancePerTeam(team)).toBe(19);
            expect(fightProperties.getAdditionalMovementStepsPerTeam(team)).toBe(0);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.MIGHT,
                    MightSynergy.PLUS_AURAS_RANGE,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalAuraRangePerTeam(team)).toBe(3);
            expect(fightProperties.getAdditionalAbilityPowerPerTeam(team)).toBe(0);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.MIGHT,
                    MightSynergy.PLUS_STACK_ABILITIES_POWER,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalAbilityPowerPerTeam(team)).toBe(12);
            expect(fightProperties.getAdditionalAuraRangePerTeam(team)).toBe(0);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.NATURE,
                    NatureSynergy.PLUS_FLY_ARMOR,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalFlyArmorPerTeam(team)).toBe(30);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.NATURE,
                    NatureSynergy.INCREASE_BOARD_UNITS,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(fightProperties.getAdditionalFlyArmorPerTeam(team)).toBe(0);
            expect(fightProperties.getNumberOfUnitsAvailableForPlacement(team)).toBe(9);

            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.NATURE,
                    NatureSynergy.INCREASE_BOARD_UNITS,
                    SynergyLevel.NO_SYNERGY,
                ),
            ).toBe(true);
            expect(fightProperties.getNumberOfUnitsAvailableForPlacement(team)).toBe(6);
            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.NATURE,
                    NatureSynergy.INCREASE_BOARD_UNITS,
                    -1,
                ),
            ).toBe(false);
            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.NATURE,
                    NatureSynergy.INCREASE_BOARD_UNITS,
                    4,
                ),
            ).toBe(false);
            expect(
                fightProperties.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.NO_FACTION,
                    NatureSynergy.INCREASE_BOARD_UNITS,
                    SynergyLevel.NO_SYNERGY,
                ),
            ).toBe(false);
        });

        it("restores a team's active synergies without sharing the input array", () => {
            const team = PBTypes.TeamVals.LOWER;
            const prior = new FightProperties();
            prior.setSynergyUnitsPerFactions(team, 6, 6, 6, 6);
            expect(
                prior.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.MIGHT,
                    MightSynergy.PLUS_AURAS_RANGE,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);

            const restored = new FightProperties();
            const synergies = prior.getSynergiesPerTeam(team);
            restored.setSynergiesPerTeam(team, synergies);
            synergies.length = 0;

            expect(restored.getAdditionalAuraRangePerTeam(team)).toBe(3);
            expect(restored.getSynergiesPerTeam(PBTypes.TeamVals.UPPER)).toEqual([]);

            restored.setSynergiesPerTeam(team, []);
            expect(restored.getAdditionalAuraRangePerTeam(team)).toBe(0);
        });

        it("setSynergiesPerTeam carries synergies across a fresh FightProperties (the ranked hydrate)", () => {
            const team = PBTypes.TeamVals.LOWER;
            // "prior" — the client's FightProperties holding a picked synergy, just before a snapshot hydrate.
            const prior = new FightProperties();
            prior.setSynergyUnitsPerFactions(team, 6, 6, 6, 6);
            expect(
                prior.updateSynergyPerTeam(
                    team,
                    PBTypes.FactionVals.MIGHT,
                    MightSynergy.PLUS_AURAS_RANGE,
                    SynergyLevel.LEVEL_3,
                ),
            ).toBe(true);
            expect(prior.getAdditionalAuraRangePerTeam(team)).toBe(3);

            // "fresh" — what FightStateManager.reset() builds on the client's fight-start hydrate: no
            // synergies, so the aura-range bonus is silently zero. This is the bug — the authoritative
            // snapshot re-seeds perk/artifacts/augments but never synergies.
            const fresh = new FightProperties();
            expect(fresh.getAdditionalAuraRangePerTeam(team)).toBe(0);

            // The hydrate preservation carries the synergy list wholesale, and the effect comes back.
            const carried = prior.getSynergiesPerTeam(team);
            expect(carried.length).toBeGreaterThan(0);
            fresh.setSynergiesPerTeam(team, carried);
            expect(fresh.getSynergiesPerTeam(team)).toEqual(carried);
            expect(fresh.getAdditionalAuraRangePerTeam(team)).toBe(3);

            // setSynergiesPerTeam REPLACES (doesn't append); an empty list clears — mirrors placement, where
            // the server intentionally broadcasts no synergies so it can't wipe the viewer's optimistic picks.
            fresh.setSynergiesPerTeam(team, []);
            expect(fresh.getSynergiesPerTeam(team)).toEqual([]);
            expect(fresh.getAdditionalAuraRangePerTeam(team)).toBe(0);

            // Isolation: restoring LOWER's synergies must not leak into UPPER.
            expect(prior.getAdditionalAuraRangePerTeam(PBTypes.TeamVals.UPPER)).toBe(0);
        });

        it("updates selected synergies when team faction counts change", () => {
            const fightProperties = new FightProperties();
            const team = PBTypes.TeamVals.LOWER;

            fightProperties.setSynergyUnitsPerFactions(team, 6, 6, 6, 6);
            fightProperties.updateSynergyPerTeam(
                team,
                PBTypes.FactionVals.LIFE,
                LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
                SynergyLevel.LEVEL_3,
            );
            fightProperties.updateSynergyPerTeam(
                team,
                PBTypes.FactionVals.CHAOS,
                ChaosSynergy.MOVEMENT,
                SynergyLevel.LEVEL_3,
            );
            fightProperties.updateSynergyPerTeam(
                team,
                PBTypes.FactionVals.MIGHT,
                MightSynergy.PLUS_STACK_ABILITIES_POWER,
                SynergyLevel.LEVEL_3,
            );
            fightProperties.updateSynergyPerTeam(
                team,
                PBTypes.FactionVals.NATURE,
                NatureSynergy.PLUS_FLY_ARMOR,
                SynergyLevel.LEVEL_3,
            );

            fightProperties.setSynergyUnitsPerFactions(team, 4.9, 2.9, 0, 0);

            expect(fightProperties.getAdditionalSupplyPerTeam(team)).toBe(12);
            expect(fightProperties.getAdditionalMovementStepsPerTeam(team)).toBe(1);
            expect(fightProperties.getAdditionalAbilityPowerPerTeam(team)).toBe(0);
            expect(fightProperties.getAdditionalFlyArmorPerTeam(team)).toBe(0);

            fightProperties.setSynergyUnitsPerFactions(PBTypes.TeamVals.NO_TEAM, 6, 6, 6, 6);

            expect(fightProperties.getPossibleSynergies(PBTypes.TeamVals.NO_TEAM)).toHaveLength(8);
            expect(
                fightProperties
                    .getPossibleSynergies(PBTypes.TeamVals.NO_TEAM)
                    .every((synergy) => synergy.level === SynergyLevel.NO_SYNERGY),
            ).toBe(true);
        });
    });

    describe("serialization and stack power", () => {
        it("serializes a fractional highest speed and fractional lap times (proto int fields)", () => {
            // Regression guard: speed buffs (augments/synergies) make the highest speed fractional
            // (e.g. 11.4) and per-lap time totals accumulate fractional ms; protobuf's serializer
            // asserts on non-integer int fields, which used to throw here and silently drop the whole
            // serialized fight (e.g. the ranked journal's FIGHT_INITIALIZED replay checkpoint).
            const fightProperties = new FightProperties();
            fightProperties.setHighestSpeedThisTurn(11.4);
            fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000.25);

            const restored = FightProperties.deserialize(fightProperties.serialize());
            expect(restored.getHighestSpeedThisTurn()).toBe(11);
        });

        it("roundtrips serialized fight state", () => {
            const fightProperties = new FightProperties();

            fightProperties.setGridType(PBTypes.GridVals.LAVA_CENTER);
            fightProperties.markFirstTurn();
            fightProperties.startFight();
            fightProperties.finishFight();
            fightProperties.updatePreviousTurnTeam(PBTypes.TeamVals.UPPER);
            fightProperties.setHighestSpeedThisTurn(7);
            fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 2);
            fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 3);
            fightProperties.startTurn(PBTypes.TeamVals.LOWER);
            fightProperties.requestAdditionalTurnTime(PBTypes.TeamVals.LOWER);
            fightProperties.enqueueUpNext("next");
            fightProperties.enqueueMoralePlus("plus");
            fightProperties.enqueueMoraleMinus("minus");
            fightProperties.enqueueHourglass("hourglass");
            fightProperties.addRepliedAttack("reply");
            fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LOWER, "done");
            fightProperties.increaseStepsMoraleMultiplier();
            fightProperties.flipLap();
            fightProperties.enqueueUpNext("after-flip");

            const restored = FightProperties.deserialize(fightProperties.serialize());

            expect(restored.getId()).toBe(fightProperties.getId());
            expect(restored.getCurrentLap()).toBe(fightProperties.getCurrentLap());
            expect(restored.getGridType()).toBe(PBTypes.GridVals.LAVA_CENTER);
            expect(restored.getFirstTurnMade()).toBe(true);
            expect(restored.hasFightStarted()).toBe(true);
            expect(restored.hasFightFinished()).toBe(true);
            expect(restored.getPreviousTurnTeam()).toBe(PBTypes.TeamVals.UPPER);
            expect(restored.getHighestSpeedThisTurn()).toBe(7);
            expect(restored.getTeamUnitsAlive(PBTypes.TeamVals.LOWER)).toBe(2);
            expect(restored.getTeamUnitsAlive(PBTypes.TeamVals.UPPER)).toBe(3);
            expect(restored.getStepsMoraleMultiplier()).toBe(STEPS_MORALE_MULTIPLIER);
            expect(restored.dequeueNextUnitId()).toBe("after-flip");
        });

        it("roundtrips already-made-turn team buckets", () => {
            const fightProperties = new FightProperties();

            fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LOWER, "lower-one");
            fightProperties.addAlreadyMadeTurn(PBTypes.TeamVals.LOWER, "lower-two");

            const restored = FightProperties.deserialize(fightProperties.serialize());

            expect(restored.hasAlreadyMadeTurn("lower-one")).toBe(true);
            expect(restored.hasAlreadyMadeTurn("lower-two")).toBe(true);
            expect(restored.getAlreadyMadeTurnSize()).toBe(2);
        });

        it("assigns stack power tiers from relative total experience", () => {
            const fightProperties = new FightProperties();
            const units = [
                createTestUnit({ amountAlive: 1, exp: 1 }),
                createTestUnit({ amountAlive: 2, exp: 1 }),
                createTestUnit({ amountAlive: 3, exp: 1 }),
                createTestUnit({ amountAlive: 4, exp: 1 }),
                createTestUnit({ amountAlive: 5, exp: 1 }),
            ];
            const allUnits = new Map<string, Unit>();

            for (let i = 0; i < units.length; i++) {
                units[i].setPosition(
                    testGridSettings.getMinX() + (i + 1) * testGridSettings.getStep(),
                    testGridSettings.getMinY() + (i + 1) * testGridSettings.getStep(),
                );
                allUnits.set(units[i].getId(), units[i]);
            }

            fightProperties.setUnitsCalculatedStacksPower(testGridSettings, allUnits);

            expect(units.map((unit) => unit.getStackPower())).toEqual([1, 2, 3, 4, 5]);
        });
    });

    describe("prefetchNextUnitsToTurn", () => {
        it("uses each team's own unit count when comparing average army morale", () => {
            const fightProperties = new FightProperties();
            const upperUnits = [
                createTestUnit({ team: PBTypes.TeamVals.UPPER, morale: 3 }),
                createTestUnit({ team: PBTypes.TeamVals.UPPER, morale: 3 }),
                createTestUnit({ team: PBTypes.TeamVals.UPPER, morale: 3 }),
            ];
            const lowerUnits = [createTestUnit({ team: PBTypes.TeamVals.LOWER, morale: 4 })];
            const allUnits = new Map([...upperUnits, ...lowerUnits].map((unit) => [unit.getId(), unit]));

            fightProperties.prefetchNextUnitsToTurn(allUnits, upperUnits, lowerUnits);

            expect(Array.from(fightProperties.getUpNextQueueIterable())[0]).toBe(lowerUnits[0].getId());
        });

        it("releases a living hourglass unit without counting an ineligible dead stack", () => {
            const fightProperties = new FightProperties();
            const waiter = createTestUnit({ team: PBTypes.TeamVals.UPPER });
            const completed = createTestUnit({ team: PBTypes.TeamVals.LOWER });
            const dead = createTestUnit({ team: PBTypes.TeamVals.LOWER, amountAlive: 0 });
            const allUnits = new Map([waiter, completed, dead].map((unit) => [unit.getId(), unit]));

            expect(dead.isDead()).toBe(true);
            fightProperties.addAlreadyMadeTurn(completed.getTeam(), completed.getId());
            fightProperties.enqueueHourglass(waiter.getId());

            fightProperties.prefetchNextUnitsToTurn(allUnits, [waiter], [completed]);

            expect(fightProperties.dequeueNextUnitId()).toBe(waiter.getId());
        });

        it("does not let stale dead up-next entries consume the living queue budget", () => {
            const fightProperties = new FightProperties();
            const upper = createTestUnit({ team: PBTypes.TeamVals.UPPER });
            const lower = createTestUnit({ team: PBTypes.TeamVals.LOWER });
            const dead = createTestUnit({ team: PBTypes.TeamVals.UPPER, amountAlive: 0 });
            const allUnits = new Map([upper, lower, dead].map((unit) => [unit.getId(), unit]));

            fightProperties.enqueueUpNext(dead.getId());
            fightProperties.prefetchNextUnitsToTurn(allUnits, [upper], [lower]);

            expect(Array.from(fightProperties.getUpNextQueueIterable())).toEqual(
                expect.arrayContaining([dead.getId(), upper.getId(), lower.getId()]),
            );
        });
    });

    describe("obstacle hit points per mountain (BLOCK_CENTER)", () => {
        it("setObstacleHitsPerMountain restores each mountain independently", () => {
            const fightProperties = new FightProperties();
            fightProperties.setObstacleHitsPerMountain(3, 1);
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(3);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(1);
            expect(fightProperties.getObstacleHitsLeft()).toBe(4);
        });

        it("encounterObstacleHit spends only the struck mountain's hit points", () => {
            const fightProperties = new FightProperties();
            fightProperties.setObstacleHitsPerMountain(3, 3);

            fightProperties.encounterObstacleHit(false); // left mountain struck
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(2);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(3);

            fightProperties.encounterObstacleHit(true); // right mountain struck
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(2);
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(2);
        });

        it("restoring from the TOTAL alone mis-routes the damage — why the event carries both sides", () => {
            // Regression guard for the bug: the left mountain took a hit (left 3->2, total 5), but a client
            // that restores from the TOTAL only re-splits it left-first (left=3, right=2), so the RIGHT
            // mountain visually loses the HP instead. The obstacle_attacked event now carries hitsAfterLeft/
            // Right so the client applies the loss to the mountain that was actually struck.
            const fightProperties = new FightProperties();
            fightProperties.setObstacleHitsPerMountain(2, 3); // left is the one that was hit
            const total = fightProperties.getObstacleHitsLeft(); // 5

            fightProperties.setObstacleHitsLeft(total); // total-only restore
            expect(fightProperties.getObstacleHitsLeftLeft()).toBe(3); // left wrongly back to full
            expect(fightProperties.getObstacleHitsLeftRight()).toBe(2); // loss wrongly moved to the right
        });
    });
});
