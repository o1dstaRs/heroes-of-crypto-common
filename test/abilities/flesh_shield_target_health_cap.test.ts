import { afterEach, describe, expect, it } from "bun:test";

import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { processFleshShieldAura } from "../../src/abilities/flesh_shield_aura_ability";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISecondaryDamage } from "../../src/scene/animations";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

function shieldedTarget(
    options: {
        targetAmount?: number;
        targetInjury?: number;
        targetArmor?: number;
        targetRanged?: boolean;
        ownerHp?: number;
        ownerAmount?: number;
        ownerInjury?: number;
        ownerArmor?: number;
        ownerStackPower?: number;
        ownerLuck?: number;
        ranged?: boolean;
        attackerAbilities?: string[];
    } = {},
) {
    const context = createCombatTestContext();
    const target = createTestUnit({
        name: "Leprechaun",
        team: PBTypes.TeamVals.LEFT,
        maxHp: 8,
        amountAlive: options.targetAmount ?? 1,
        armor: options.targetArmor ?? 20,
        attackType: options.targetRanged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: options.targetRanged ? 4 : 0,
    });
    const owner = createTestUnit({
        name: "Abomination",
        team: PBTypes.TeamVals.LEFT,
        maxHp: options.ownerHp ?? 1000,
        amountAlive: options.ownerAmount ?? 1,
        armor: options.ownerArmor ?? 20,
        stackPower: options.ownerStackPower ?? 5,
        luck: options.ownerLuck ?? 10,
        abilities: ["Flesh Shield Aura"],
        auraEffects: ["Flesh Shield"],
        auraRanges: [1],
        auraIsBuff: [true],
    });
    const attacker = createTestUnit({
        name: "Berserker",
        team: PBTypes.TeamVals.RIGHT,
        maxHp: 1000,
        attackType: options.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: options.ranged ? 4 : 0,
        abilities: options.attackerAbilities ?? [],
    });
    const sceneLog = new SceneLogMock();
    if (options.targetInjury) target.applyDamage(options.targetInjury, 0, sceneLog);
    if (options.ownerInjury) owner.applyDamage(options.ownerInjury, 0, sceneLog);
    placeUnit(context.grid, context.unitsHolder, owner, { x: 2, y: 2 });
    placeUnit(context.grid, context.unitsHolder, target, { x: 3, y: 2 });
    placeUnit(context.grid, context.unitsHolder, attacker, { x: options.ranged ? 8 : 4, y: 2 });
    context.unitsHolder.refreshAuraEffectsForAllUnits();
    return { ...context, target, owner, attacker, sceneLog };
}

function absorb(context: ReturnType<typeof shieldedTarget>, damage: number, ranged = false) {
    const secondary: ISecondaryDamage[] = [];
    const result = processFleshShieldAura(
        context.attacker,
        context.target,
        damage,
        ranged,
        context.grid,
        context.unitsHolder,
        context.sceneLog,
        context.damageStatisticHolder,
        secondary,
    );
    return { result, secondary };
}

function attackThroughEngine(
    context: ReturnType<typeof shieldedTarget>,
    ranged: boolean,
    attacker = context.attacker,
    target = context.target,
) {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 2);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(attacker.getTeam(), 1000);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: context.sceneLog,
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => attacker.getId(),
    });
    return engine.apply(
        ranged
            ? {
                  type: "range_attack",
                  attackerId: attacker.getId(),
                  targetId: target.getId(),
              }
            : {
                  type: "melee_attack",
                  attackerId: attacker.getId(),
                  targetId: target.getId(),
                  attackFrom: attacker.getBaseCell(),
              },
    );
}

describe("Flesh Shield target health cap", () => {
    it.each([
        { targetArmor: 20, ownerArmor: 20, ownerHp: 1000, redirected: 8, absorbed: 8 },
        { targetArmor: 20, ownerArmor: 40, ownerHp: 1000, redirected: 8, absorbed: 4 },
        { targetArmor: 40, ownerArmor: 20, ownerHp: 1000, redirected: 4, absorbed: 8 },
        { targetArmor: 20, ownerArmor: 44, ownerHp: 1000, redirected: 8, absorbed: 4 },
        { targetArmor: 30, ownerArmor: 7, ownerHp: 1000, redirected: 1, absorbed: 5 },
        { targetArmor: 7, ownerArmor: 30, ownerHp: 1000, redirected: 8, absorbed: 2 },
        { targetArmor: 20, ownerArmor: 20, ownerHp: 5, redirected: 5, absorbed: 5 },
    ])("caps a lethal single-Leprechaun hit across armor and owner HP: %p", (testCase) => {
        const context = shieldedTarget(testCase);
        const { result, secondary } = absorb(context, 239);
        expect(result.remainingDamage).toBe(239 - testCase.redirected);
        expect(result.absorbedDamage).toBe(testCase.absorbed);
        expect(context.owner.getCumulativeHp()).toBe(testCase.ownerHp - testCase.absorbed);
        expect(secondary).toEqual([
            expect.objectContaining({
                source: "flesh_shield",
                unitId: context.owner.getId(),
                amount: testCase.absorbed,
            }),
        ]);
        expect(context.target.applyDamage(result.remainingDamage, 0, context.sceneLog)).toBe(8);
        expect(context.target.isDead()).toBe(true);
    });

    it("uses current cumulative HP, including the wounded top creature", () => {
        const context = shieldedTarget({ targetAmount: 3, targetInjury: 3 });
        expect(context.target.getCumulativeMaxHp()).toBe(24);
        expect(context.target.getCumulativeHp()).toBe(21);
        const { result } = absorb(context, 239);
        expect(result.absorbedDamage).toBe(21);
        expect(result.remainingDamage).toBe(218);
        context.target.applyDamage(result.remainingDamage, 0, context.sceneLog);
        expect(context.target.isDead()).toBe(true);
        const afterDeath = absorb(context, 239);
        expect(afterDeath.result.absorbedDamage).toBe(0);
        expect(afterDeath.result.remainingDamage).toBe(239);
        expect(afterDeath.secondary).toEqual([]);
    });

    it("uses ranged armor for a ranged transfer", () => {
        const context = shieldedTarget({ ranged: true, targetArmor: 40, ownerArmor: 20 });
        context.target.getUnitProperties().range_armor = 20;
        context.owner.getUnitProperties().range_armor = 40;
        const { result } = absorb(context, 239, true);
        expect(result.remainingDamage).toBe(231);
        expect(result.absorbedDamage).toBe(4);
    });

    it("does not round a fractional HP budget up into an extra redirected point", () => {
        const context = shieldedTarget({ ownerArmor: 40 });
        context.target.getUnitProperties().hp = 7.5;
        const { result } = absorb(context, 239);
        expect(result.remainingDamage).toBe(232);
        expect(result.absorbedDamage).toBe(4);
    });

    it("uses the owner's full remaining stack HP and reports its death exactly once", () => {
        const context = shieldedTarget({ targetAmount: 3, ownerAmount: 3, ownerHp: 8, ownerInjury: 3 });
        expect(context.owner.getCumulativeHp()).toBe(21);
        const { result, secondary } = absorb(context, 239);
        expect(result.absorbedDamage).toBe(21);
        expect(result.remainingDamage).toBe(218);
        expect(context.owner.isDead()).toBe(true);
        expect(result.unitIdsDied).toEqual([context.owner.getId()]);
        expect(secondary).toEqual([expect.objectContaining({ source: "flesh_shield", amount: 21, unitsDied: 3 })]);
    });

    it("keeps the full hit on the target when even one redirected point exceeds its HP after armor conversion", () => {
        const context = shieldedTarget({ targetArmor: 20, ownerArmor: 1 });
        const { result, secondary } = absorb(context, 239);
        expect(result.absorbedDamage).toBe(0);
        expect(result.remainingDamage).toBe(239);
        expect(context.owner.getCumulativeHp()).toBe(1000);
        expect(secondary).toEqual([]);
    });

    it.each([15, 16, 17])("returns the exact overflow at the lethal threshold: %p", (damage) => {
        const context = shieldedTarget();
        const { result } = absorb(context, damage);
        expect(result.absorbedDamage).toBe(8);
        expect(result.remainingDamage).toBe(damage - 8);
        context.target.applyDamage(result.remainingDamage, 0, context.sceneLog);
        expect(context.target.getCumulativeHp()).toBe(Math.max(0, 16 - damage));
    });

    it.each([false, true])(
        "satisfies health, percentage, armor, rounding and spillback bounds (ranged=%p)",
        (ranged) => {
            const powers = [
                { stackPower: 1, luck: -10, percentage: 8 },
                { stackPower: 1, luck: 0, percentage: 18 },
                { stackPower: 3, luck: 0, percentage: 54 },
                { stackPower: 5, luck: -10, percentage: 80 },
                { stackPower: 5, luck: 0, percentage: 90 },
                { stackPower: 5, luck: 10, percentage: 100 },
            ];
            for (const targetAmount of [1, 3]) {
                for (const targetInjury of [0, 3]) {
                    for (const ownerHp of [5, 500]) {
                        for (const [targetArmor, ownerArmor] of [
                            [20, 20],
                            [20, 40],
                            [40, 20],
                            [20, 44],
                            [30, 7],
                            [7, 30],
                        ]) {
                            for (const damage of [0, 1, 8, 16, 17, 239]) {
                                for (const power of powers) {
                                    const context = shieldedTarget({
                                        targetAmount,
                                        targetInjury,
                                        targetArmor,
                                        ownerArmor,
                                        ownerHp,
                                        ranged,
                                        ownerStackPower: power.stackPower,
                                        ownerLuck: power.luck,
                                    });
                                    const targetHp = context.target.getCumulativeHp();
                                    const { result } = absorb(context, damage, ranged);
                                    const redirected = damage - result.remainingDamage;
                                    const allowance = Math.min(targetHp, Math.floor((damage * power.percentage) / 100));
                                    expect(redirected).toBeGreaterThanOrEqual(0);
                                    expect(redirected).toBeLessThanOrEqual(allowance);
                                    expect(result.absorbedDamage).toBeLessThanOrEqual(Math.min(targetHp, ownerHp));
                                    expect(result.absorbedDamage).toBe(ownerHp - context.owner.getCumulativeHp());
                                    expect(
                                        context.damageStatisticHolder
                                            .get()
                                            .reduce((sum, entry) => sum + entry.damage, 0),
                                    ).toBe(result.absorbedDamage);
                                    if (redirected > 0) {
                                        expect(result.absorbedDamage).toBe(
                                            Math.ceil((redirected * targetArmor) / ownerArmor),
                                        );
                                    }
                                    if (redirected < allowance) {
                                        expect(
                                            Math.ceil(((redirected + 1) * targetArmor) / ownerArmor),
                                        ).toBeGreaterThan(Math.min(targetHp, ownerHp));
                                    }
                                    context.target.applyDamage(result.remainingDamage, 0, context.sceneLog);
                                    if (damage >= 2 * targetHp) expect(context.target.isDead()).toBe(true);
                                }
                            }
                        }
                    }
                }
            }
        },
    );

    it.each([false, true])(
        "records a lethal first hit and cancels the second hit in the authoritative engine (ranged=%p)",
        (ranged) => {
            setDeterministicRandomSource(() => 0);
            const context = shieldedTarget({ ranged, attackerAbilities: [ranged ? "Double Shot" : "Double Punch"] });
            context.attacker.calculateMissChance = () => 0;
            context.attacker.calculateAttackDamage = () => 239;
            const result = attackThroughEngine(context, ranged);
            expect(result.completed).toBe(true);
            const attack = result.events.find((event) => event.type === "unit_attacked");
            expect(attack?.type).toBe("unit_attacked");
            if (attack?.type !== "unit_attacked") throw new Error("Missing attack event");
            expect(attack.unitIdsDied).toContain(context.target.getId());
            expect(attack.damage.hits).toHaveLength(1);
            expect(attack.damage.secondary).toEqual([
                expect.objectContaining({ source: "flesh_shield", unitId: context.owner.getId(), amount: 8 }),
            ]);
            expect(context.target.isDead()).toBe(true);
            expect(context.owner.getCumulativeHp()).toBe(992);
        },
    );

    it.each([false, true])("caps a lethal retaliation against the protected attacker (ranged=%p)", (ranged) => {
        setDeterministicRandomSource(() => 0);
        const context = shieldedTarget({ ranged, targetRanged: ranged });
        context.target.calculateMissChance = () => 0;
        context.target.calculateAttackDamage = () => 1;
        context.attacker.calculateMissChance = () => 0;
        context.attacker.calculateAttackDamage = () => 239;
        const result = attackThroughEngine(context, ranged, context.target, context.attacker);
        expect(result.completed).toBe(true);
        expect(context.target.isDead()).toBe(true);
        expect(context.owner.getCumulativeHp()).toBe(992);
        const attack = result.events.find((event) => event.type === "unit_attacked");
        expect(attack?.type).toBe("unit_attacked");
        if (attack?.type !== "unit_attacked") throw new Error("Missing attack event");
        expect(attack.unitIdsDied).toContain(context.target.getId());
        expect(attack.damage.secondary).toEqual([
            expect.objectContaining({ source: "flesh_shield", unitId: context.owner.getId(), amount: 8 }),
        ]);
    });

    it("caps every AOE victim separately and reports real HP losses", () => {
        setDeterministicRandomSource(() => 0);
        const context = shieldedTarget({ ranged: true, attackerAbilities: ["Area Throw"] });
        const secondTarget = createTestUnit({
            name: "Second Leprechaun",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 8,
            armor: 20,
        });
        placeUnit(context.grid, context.unitsHolder, secondTarget, { x: 2, y: 3 });
        context.unitsHolder.refreshAuraEffectsForAllUnits();
        context.attacker.calculateMissChance = () => 0;
        context.attacker.calculateAttackDamage = () => 239;
        const secondary: ISecondaryDamage[] = [];
        const result = processRangeAOEAbility(
            context.attacker,
            [context.target, secondTarget],
            context.attacker,
            1,
            context.unitsHolder,
            context.grid,
            context.sceneLog,
            context.damageStatisticHolder,
            true,
            secondary,
        );
        expect(result.landed).toBe(true);
        expect(context.target.isDead()).toBe(true);
        expect(secondTarget.isDead()).toBe(true);
        expect(result.perUnitDamage.map((entry) => entry.amount)).toEqual([8, 8]);
        expect(context.owner.getCumulativeHp()).toBe(984);
        expect(secondary).toEqual([
            expect.objectContaining({ source: "flesh_shield", unitId: context.owner.getId(), amount: 16 }),
        ]);
        expect(context.damageStatisticHolder.get().reduce((sum, entry) => sum + entry.damage, 0)).toBe(32);
    });
});
