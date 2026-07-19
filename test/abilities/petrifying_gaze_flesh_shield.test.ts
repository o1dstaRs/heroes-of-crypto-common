/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { AttackType } from "../../src/generated/protobuf/v1/types_gen";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    testGridSettings,
} from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

function createShieldedGazeFight(
    attackType: AttackType,
    attackerAbilities: string[],
    attackerCell: { x: number; y: number },
) {
    const context = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Gazer",
        team: PBTypes.TeamVals.UPPER,
        attackType,
        abilities: attackerAbilities,
        rangeShots: attackType === PBTypes.AttackVals.RANGE ? 4 : 0,
        stackPower: 5,
        luck: 10,
    });
    const target = createTestUnit({
        name: "Protected Target",
        team: PBTypes.TeamVals.LOWER,
        amountAlive: 3,
        maxHp: 100,
        armor: 20,
    });
    const abomination = createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.LOWER,
        amountAlive: 1,
        maxHp: 500,
        armor: 20,
        luck: 10,
        stackPower: 5,
        abilities: ["Dense Flesh", "Flesh Shield Aura"],
        auraEffects: ["Flesh Shield"],
        auraRanges: [1],
        auraIsBuff: [true],
    });

    attacker.calculateMissChance = () => 0;
    attacker.calculateAttackDamage = () => 10;

    placeUnit(context.grid, context.unitsHolder, attacker, attackerCell);
    placeUnit(context.grid, context.unitsHolder, target, { x: 8, y: 1 });
    placeUnit(context.grid, context.unitsHolder, abomination, { x: 8, y: 2 });
    context.unitsHolder.refreshAuraEffectsForAllUnits();

    expect(target.getBuff("Flesh Shield Aura")?.getPower()).toBe(100);
    return { ...context, attacker, target, abomination };
}

function expectSeparatedGazeAndShield(
    secondary: ISecondaryDamage[] | undefined,
    targetId: string,
    abominationId: string,
    expectedGazes: number,
): void {
    const shieldEntries = secondary?.filter((entry) => entry.source === "flesh_shield") ?? [];
    const gazeEntries = secondary?.filter((entry) => entry.source === "petrifying_gaze") ?? [];

    // Flesh Shield intentionally aggregates all transfers in the same attack animation; each Gaze stays
    // separate because each petrification is its own target-side effect.
    expect(shieldEntries).toEqual([expect.objectContaining({ unitId: abominationId, amount: expectedGazes * 10 })]);
    expect(gazeEntries).toHaveLength(expectedGazes);
    expect(gazeEntries.every((entry) => entry.unitId === targetId && entry.amount === 100)).toBe(true);
    expect(gazeEntries.some((entry) => entry.unitId === abominationId)).toBe(false);
}

describe("Petrifying Gaze through Flesh Shield", () => {
    it("keeps both direct and Double Shot gazes on the protected ranged target", () => {
        setDeterministicRandomSource(() => 0);
        const { unitsHolder, attackHandler, attacker, target, abomination } = createShieldedGazeFight(
            PBTypes.AttackVals.RANGE,
            ["Petrifying Gaze", "Double Shot"],
            { x: 1, y: 1 },
        );
        const damage = createVisibleDamage(target);

        const result = attackHandler.handleRangeAttack(
            unitsHolder,
            [1],
            1,
            damage,
            attacker,
            [[target]],
            undefined,
            target.getPosition(),
        );

        expect(result.completed).toBe(true);
        expect(target.getAmountAlive()).toBe(1);
        expect(target.getCumulativeHp()).toBe(100);
        expect(abomination.getCumulativeHp()).toBe(480);
        expectSeparatedGazeAndShield(damage.secondary, target.getId(), abomination.getId(), 2);
    });

    it("keeps both direct and Double Punch gazes on the protected melee target", () => {
        setDeterministicRandomSource(() => 0);
        const { unitsHolder, grid, attackHandler, attacker, target, abomination } = createShieldedGazeFight(
            PBTypes.AttackVals.MELEE,
            ["Petrifying Gaze", "Double Punch", "Shadow Touch"],
            { x: 7, y: 1 },
        );
        const damage = createVisibleDamage(target);
        damage.hits = [];

        const result = attackHandler.handleMeleeAttack(
            unitsHolder,
            new MoveHandler(testGridSettings, grid, unitsHolder),
            damage,
            undefined,
            attacker,
            target,
            { x: 7, y: 1 },
        );

        expect(result.completed).toBe(true);
        expect(target.getAmountAlive()).toBe(1);
        expect(target.getCumulativeHp()).toBe(100);
        expect(abomination.getCumulativeHp()).toBe(480);
        expectSeparatedGazeAndShield(damage.secondary, target.getId(), abomination.getId(), 2);
    });

    it("keeps an AOE gaze on the protected splash target when all base damage is absorbed", () => {
        setDeterministicRandomSource(() => 0);
        const { unitsHolder, grid, attackHandler, damageStatisticHolder, attacker, target, abomination } =
            createShieldedGazeFight(PBTypes.AttackVals.RANGE, ["Petrifying Gaze", "Area Throw"], { x: 1, y: 1 });
        const secondary: ISecondaryDamage[] = [];

        const result = processRangeAOEAbility(
            attacker,
            [target],
            attacker,
            1,
            unitsHolder,
            grid,
            attackHandler.sceneLog,
            damageStatisticHolder,
            true,
            secondary,
        );

        expect(result.landed).toBe(true);
        expect(target.getAmountAlive()).toBe(2);
        expect(target.getCumulativeHp()).toBe(200);
        expect(abomination.getCumulativeHp()).toBe(490);
        expectSeparatedGazeAndShield(secondary, target.getId(), abomination.getId(), 1);
    });
});
