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

import {
    applyAttackDamageChain,
    projectAttackDamage,
    projectAttackDamageBand,
    projectKillBand,
    projectShotCost,
    reachableTopRoll,
    resolveAttackDamageChain,
} from "../../src/damage/damage_projection";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { AttackType } from "../../src/generated/protobuf/v1/types_gen";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import { createTestUnit, type TestUnitOptions } from "../helpers/combat";

const RED = PBTypes.TeamVals.UPPER;
const GREEN = PBTypes.TeamVals.LOWER;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;

/**
 * Pin HoCLib's randomness so getRandomInt(min, max) returns exactly `min + (offset % (max - min))`.
 * nextRaw53 builds its 53-bit value from two draws (21 high bits, 32 low bits), so a constant source of
 * `offset / 2^32` yields the raw value `offset` itself for any offset below 2^11.
 */
const MAX_PINNABLE_OFFSET = 2048;
const pinRoll = (offset: number): void => setDeterministicRandomSource(() => offset / 0x100000000);

afterEach(() => setDeterministicRandomSource(undefined));

/**
 * Unit.calculateAttackDamage EXACTLY as it read before the shared projection replaced its body
 * (git show HEAD:src/units/unit.ts). The refactor is pure de-duplication, so the engine must keep
 * returning this transcription's number for every scenario, roll for roll.
 */
const legacyCalculateAttackDamage = (
    attacker: Unit,
    enemyUnit: Unit,
    attackType: AttackType,
    synergyAbilityPowerIncrease: number,
    divisor = 1,
    abilityMultiplier = 1,
    decreaseNumberOfShots = true,
): number => {
    const min = attacker.calculateAttackDamageMin(
        attacker.getAttack(),
        enemyUnit,
        attackType === RANGE,
        synergyAbilityPowerIncrease,
        divisor,
    );
    const max = attacker.calculateAttackDamageMax(
        attacker.getAttack(),
        enemyUnit,
        attackType === RANGE,
        synergyAbilityPowerIncrease,
        divisor,
    );
    const attackingByMelee = attackType === MELEE || attackType === MELEE_MAGIC;
    if (!attackingByMelee && attackType === RANGE) {
        if (attacker.getRangeShots() <= 0) {
            return 0;
        }
        if (decreaseNumberOfShots) {
            attacker.spendShotsAgainst(enemyUnit);
        }
    }

    const attackTypeMultiplier =
        attackingByMelee && attacker.getAttackType() === RANGE && !attacker.hasAbilityActive("Handyman") ? 0.5 : 1;

    let deepWoundsMultiplier = 1;
    const deepWoundsPower = enemyUnit.getEffect("Deep Wounds")?.getPower() ?? 0;
    if (
        deepWoundsPower > 0 &&
        (attacker.getAbility("Deep Wounds Level 0") ||
            attacker.getAbility("Deep Wounds Level 1") ||
            attacker.getAbility("Deep Wounds Level 2") ||
            attacker.getAbility("Deep Wounds Level 3"))
    ) {
        deepWoundsMultiplier = 1 + deepWoundsPower / 100;
    }

    return Math.floor(
        getRandomInt(min, max) *
            attackTypeMultiplier *
            abilityMultiplier *
            deepWoundsMultiplier *
            attacker.getElementalDamageMultiplier(enemyUnit),
    );
};

interface UnitVariant {
    label: string;
    options: TestUnitOptions;
    /** "Deep Wounds" effect power to hang on the unit (targets only). */
    deepWoundsEffectPower?: number;
    /** Leather Armor / Wingshield only take effect once the derivation chain has run. */
    adjustStats?: boolean;
}

const withVariant = (variant: UnitVariant): Unit => {
    const unit = createTestUnit(variant.options);
    if (variant.deepWoundsEffectPower) {
        const effect = new EffectFactory().makeEffect("Deep Wounds");
        if (!effect) {
            throw new Error("Deep Wounds effect config is missing");
        }
        effect.setPower(variant.deepWoundsEffectPower);
        unit.applyEffect(effect);
    }
    if (variant.adjustStats) {
        unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
    }
    return unit;
};

const ATTACKER_VARIANTS: UnitVariant[] = [
    { label: "plain melee", options: { name: "Pikeman", team: RED, attack: 12, damageMin: 6, damageMax: 6 } },
    {
        label: "melee stack of 20",
        options: { name: "Squire", team: RED, attack: 22, damageMin: 9, damageMax: 9, amountAlive: 20, stackPower: 5 },
    },
    {
        label: "melee spanned band",
        options: { name: "Berserk", team: RED, attack: 14, damageMin: 5, damageMax: 12, amountAlive: 8, stackPower: 5 },
    },
    {
        label: "lucky melee",
        options: { name: "Rogue", team: RED, attack: 9, damageMin: 3, damageMax: 7, amountAlive: 6, luck: 12 },
    },
    {
        label: "ranged shooter",
        options: {
            name: "Archer",
            team: RED,
            attackType: RANGE,
            attack: 21,
            damageMin: 17,
            damageMax: 17,
            amountAlive: 5,
            rangeShots: 500,
            shotDistance: 6.5,
        },
    },
    {
        label: "ranged spanned band",
        options: {
            name: "Arbalester",
            team: RED,
            attackType: RANGE,
            attack: 11,
            damageMin: 9,
            damageMax: 12,
            amountAlive: 2,
            rangeShots: 500,
        },
    },
    {
        label: "ranged with Handyman",
        options: {
            name: "Handyman",
            team: RED,
            attackType: RANGE,
            attack: 13,
            damageMin: 7,
            damageMax: 7,
            amountAlive: 4,
            rangeShots: 500,
            abilities: ["Handyman"],
        },
    },
    {
        label: "empty quiver",
        options: {
            name: "Dry Quiver",
            team: RED,
            attackType: RANGE,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            rangeShots: 0,
        },
    },
    {
        label: "Piercing Spear",
        options: {
            name: "Spearman",
            team: RED,
            attack: 10,
            damageMin: 7,
            damageMax: 7,
            amountAlive: 5,
            stackPower: 5,
            abilities: ["Piercing Spear"],
        },
    },
    {
        label: "Deep Wounds Level 2",
        options: {
            name: "White Tiger",
            team: RED,
            attack: 10,
            damageMin: 7,
            damageMax: 7,
            amountAlive: 5,
            abilities: ["Deep Wounds Level 2"],
        },
    },
    {
        label: "Fire Element",
        options: {
            name: "Efreet",
            team: RED,
            attack: 22,
            damageMin: 18,
            damageMax: 18,
            amountAlive: 9,
            abilities: ["Fire Element"],
        },
    },
    {
        label: "Water Element",
        options: {
            name: "Mermaid",
            team: RED,
            attack: 16,
            damageMin: 6,
            damageMax: 9,
            amountAlive: 12,
            abilities: ["Water Element"],
        },
    },
];

const TARGET_VARIANTS: UnitVariant[] = [
    { label: "plain", options: { name: "Dummy", team: GREEN, armor: 10, maxHp: 40, amountAlive: 30 } },
    { label: "thin armor", options: { name: "Thin", team: GREEN, armor: 3, maxHp: 12, amountAlive: 8 } },
    { label: "thick armor", options: { name: "Thick", team: GREEN, armor: 41, maxHp: 150, amountAlive: 40 } },
    { label: "lucky", options: { name: "Lucky", team: GREEN, armor: 13, maxHp: 30, amountAlive: 12, luck: 30 } },
    {
        label: "unlucky",
        options: { name: "Unlucky", team: GREEN, armor: 17, maxHp: 22, amountAlive: 15, luck: -20 },
    },
    {
        label: "Leather Armor",
        options: {
            name: "Leathered",
            team: GREEN,
            armor: 20,
            maxHp: 40,
            amountAlive: 30,
            abilities: ["Leather Armor"],
        },
        adjustStats: true,
    },
    {
        label: "Water Element",
        options: {
            name: "Water Elemental",
            team: GREEN,
            armor: 9,
            maxHp: 11,
            amountAlive: 91,
            abilities: ["Water Element"],
        },
    },
    {
        label: "Fire Element",
        options: {
            name: "Fire Elemental",
            team: GREEN,
            armor: 15,
            maxHp: 20,
            amountAlive: 20,
            abilities: ["Fire Element"],
        },
    },
    {
        label: "Deep Wounds carrier",
        options: { name: "Wounded", team: GREEN, armor: 12, maxHp: 40, amountAlive: 30 },
        deepWoundsEffectPower: 30,
    },
    {
        label: "Dense Flesh",
        options: {
            name: "Abomination",
            team: GREEN,
            armor: 18,
            maxHp: 60,
            amountAlive: 10,
            abilities: ["Dense Flesh"],
        },
    },
];

const ATTACK_TYPES: AttackType[] = [MELEE, MELEE_MAGIC, RANGE];
const DIVISORS = [1, 2, 4, 8];
const ABILITY_MULTIPLIERS = [1, 0.5, 1.25, 2];
const SYNERGY = 12;

interface SweepCase {
    label: string;
    attackerVariant: UnitVariant;
    targetVariant: UnitVariant;
    attackType: AttackType;
    divisor: number;
    abilityMultiplier: number;
}

const sweepCases = (): SweepCase[] => {
    const cases: SweepCase[] = [];
    for (const attackerVariant of ATTACKER_VARIANTS) {
        for (const targetVariant of TARGET_VARIANTS) {
            for (const attackType of ATTACK_TYPES) {
                for (const divisor of DIVISORS) {
                    for (const abilityMultiplier of ABILITY_MULTIPLIERS) {
                        cases.push({
                            label: `${attackerVariant.label} vs ${targetVariant.label} [type ${attackType}, 1/${divisor}, x${abilityMultiplier}]`,
                            attackerVariant,
                            targetVariant,
                            attackType,
                            divisor,
                            abilityMultiplier,
                        });
                    }
                }
            }
        }
    }
    return cases;
};

describe("projectAttackDamage reproduces Unit.calculateAttackDamage exactly", () => {
    it("pins both ends of the band against the engine's own roll, across the whole sweep", () => {
        const cases = sweepCases();
        expect(cases.length).toBeGreaterThan(5000);

        let pinnedBothEnds = 0;
        let spannedBands = 0;
        let outOfShotsCases = 0;

        for (const testCase of cases) {
            const attacker = withVariant(testCase.attackerVariant);
            const target = withVariant(testCase.targetVariant);
            const input = {
                attacker,
                target,
                attackType: testCase.attackType,
                synergyAbilityPowerIncrease: SYNERGY,
                divisor: testCase.divisor,
                abilityMultiplier: testCase.abilityMultiplier,
            };

            const projection = projectAttackDamage(input);
            const chain = resolveAttackDamageChain(input);

            // The chain is wired to the engine's own min/max primitives, with the engine's argument order.
            expect(chain.rollMin).toBe(
                attacker.calculateAttackDamageMin(
                    attacker.getAttack(),
                    target,
                    testCase.attackType === RANGE,
                    SYNERGY,
                    testCase.divisor,
                ),
            );
            expect(chain.rollMaxExclusive).toBe(
                attacker.calculateAttackDamageMax(
                    attacker.getAttack(),
                    target,
                    testCase.attackType === RANGE,
                    SYNERGY,
                    testCase.divisor,
                ),
            );

            if (chain.outOfShots) {
                outOfShotsCases++;
                pinRoll(0);
                expect(
                    attacker.calculateAttackDamage(
                        target,
                        testCase.attackType,
                        SYNERGY,
                        testCase.divisor,
                        testCase.abilityMultiplier,
                    ),
                ).toBe(0);
                expect(projection).toEqual({ min: 0, max: 0, killsMin: 0, killsMax: 0 });
                continue;
            }

            const span = chain.rollMaxExclusive - chain.rollMin;
            if (span > 1) {
                spannedBands++;
            }
            if (span - 1 >= MAX_PINNABLE_OFFSET) {
                // Band too wide to pin the top exactly; still assert the engine stays inside the projection.
                pinRoll(0);
                const engineFloor = attacker.calculateAttackDamage(
                    target,
                    testCase.attackType,
                    SYNERGY,
                    testCase.divisor,
                    testCase.abilityMultiplier,
                );
                expect(engineFloor).toBe(projection.min);
                continue;
            }

            // Bottom of the band.
            pinRoll(0);
            expect(
                attacker.calculateAttackDamage(
                    target,
                    testCase.attackType,
                    SYNERGY,
                    testCase.divisor,
                    testCase.abilityMultiplier,
                ),
            ).toBe(projection.min);

            // Top of the band: getRandomInt is max-EXCLUSIVE, so the highest reachable roll is max - 1.
            pinRoll(Math.max(0, span - 1));
            expect(
                attacker.calculateAttackDamage(
                    target,
                    testCase.attackType,
                    SYNERGY,
                    testCase.divisor,
                    testCase.abilityMultiplier,
                ),
            ).toBe(projection.max);
            pinnedBothEnds++;
        }

        expect(pinnedBothEnds).toBeGreaterThan(4000);
        expect(spannedBands).toBeGreaterThan(500);
        expect(outOfShotsCases).toBeGreaterThan(50);
    });

    it("keeps the engine byte-identical to its pre-refactor body over the same sweep", () => {
        let compared = 0;
        for (const testCase of sweepCases()) {
            for (const offset of [0, 1, 7, 33]) {
                const attacker = withVariant(testCase.attackerVariant);
                const target = withVariant(testCase.targetVariant);
                const legacyAttacker = withVariant(testCase.attackerVariant);
                const legacyTarget = withVariant(testCase.targetVariant);

                pinRoll(offset);
                const current = attacker.calculateAttackDamage(
                    target,
                    testCase.attackType,
                    SYNERGY,
                    testCase.divisor,
                    testCase.abilityMultiplier,
                );
                pinRoll(offset);
                const legacy = legacyCalculateAttackDamage(
                    legacyAttacker,
                    legacyTarget,
                    testCase.attackType,
                    SYNERGY,
                    testCase.divisor,
                    testCase.abilityMultiplier,
                );
                expect(current).toBe(legacy);
                compared++;
            }
        }
        expect(compared).toBeGreaterThan(20000);
    });
});

describe("the projected top of the band is REACHABLE (getRandomInt is max-exclusive)", () => {
    const spannedAttack = () => {
        const attacker = createTestUnit({
            name: "Spanner",
            team: RED,
            attack: 5,
            damageMin: 12,
            damageMax: 19,
            amountAlive: 7,
        });
        const target = createTestUnit({ name: "Wall", team: GREEN, armor: 17, maxHp: 40, amountAlive: 30 });
        return { attacker, target };
    };

    it("never lets the engine exceed the projected max, and reaches it, over 4000 live rolls", () => {
        const { attacker, target } = spannedAttack();
        const input = { attacker, target, attackType: MELEE, synergyAbilityPowerIncrease: 0 };
        const projection = projectAttackDamage(input);

        let observedMin = Number.MAX_SAFE_INTEGER;
        let observedMax = 0;
        for (let i = 0; i < 4000; i++) {
            const dealt = attacker.calculateAttackDamage(target, MELEE, 0);
            observedMin = Math.min(observedMin, dealt);
            observedMax = Math.max(observedMax, dealt);
        }

        expect(observedMin).toBe(projection.min);
        expect(observedMax).toBe(projection.max);
    });

    it("is exactly one point below the naive calculateAttackDamageMax the hover used to print", () => {
        const { attacker, target } = spannedAttack();
        const naiveTop = attacker.calculateAttackDamageMax(attacker.getAttack(), target, false, 0, 1);
        const projection = projectAttackDamage({
            attacker,
            target,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });

        expect(projection.max).toBe(naiveTop - 1);
        expect(projection.min).toBe(attacker.calculateAttackDamageMin(attacker.getAttack(), target, false, 0, 1));
    });

    it("collapses to a single point when the band is one value wide", () => {
        const attacker = createTestUnit({ name: "Flat", team: RED, attack: 12, damageMin: 6, damageMax: 6 });
        const target = createTestUnit({ name: "Dummy", team: GREEN, armor: 20, maxHp: 40, amountAlive: 30 });
        const chain = resolveAttackDamageChain({
            attacker,
            target,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });

        expect(chain.rollMaxExclusive).toBe(chain.rollMin);
        expect(reachableTopRoll(chain)).toBe(chain.rollMin);
        const projection = projectAttackDamage({
            attacker,
            target,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });
        expect(projection.min).toBe(projection.max);
        expect(projection.max).toBe(attacker.calculateAttackDamage(target, MELEE, 0));
    });
});

describe("the multiplier chain matches the engine term by term", () => {
    it("halves a RANGE unit's melee poke AFTER the roll (floor), not inside the band (ceil)", () => {
        const attacker = createTestUnit({
            name: "Cyclops",
            team: RED,
            attackType: RANGE,
            attack: 6,
            damageMin: 9,
            damageMax: 9,
            rangeShots: 10,
            shotDistance: 5,
        });
        const target = createTestUnit({ name: "Dummy", team: GREEN, armor: 25, maxHp: 40, amountAlive: 30 });
        const chain = resolveAttackDamageChain({
            attacker,
            target,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });

        expect(chain.attackTypeMultiplier).toBe(0.5);
        // raw 9*6*1/25 = 2.16 -> ceil 3 -> floor(3 * 0.5) = 1. Dividing INSIDE the band would give ceil(2.16/2) = 2.
        expect(chain.rollMin).toBe(3);
        expect(projectAttackDamage({ attacker, target, attackType: MELEE, synergyAbilityPowerIncrease: 0 }).min).toBe(
            1,
        );
        expect(attacker.calculateAttackDamage(target, MELEE, 0)).toBe(1);
    });

    it("keeps a Handyman shooter at full strength in melee", () => {
        const attacker = createTestUnit({
            name: "Handy",
            team: RED,
            attackType: RANGE,
            attack: 6,
            damageMin: 9,
            damageMax: 9,
            rangeShots: 10,
            abilities: ["Handyman"],
        });
        const target = createTestUnit({ name: "Dummy", team: GREEN, armor: 25, maxHp: 40, amountAlive: 30 });

        expect(
            resolveAttackDamageChain({ attacker, target, attackType: MELEE, synergyAbilityPowerIncrease: 0 })
                .attackTypeMultiplier,
        ).toBe(1);
    });

    it("prices the enemy's RANGE armor for a shot and its melee armor for a swing", () => {
        const shooter = createTestUnit({
            name: "Elf",
            team: RED,
            attackType: RANGE,
            attack: 17,
            damageMin: 4,
            damageMax: 4,
            amountAlive: 10,
            rangeShots: 20,
        });
        const leathered = createTestUnit({
            name: "Arbalester",
            team: GREEN,
            armor: 8,
            maxHp: 100,
            amountAlive: 10,
            abilities: ["Leather Armor"],
        });
        leathered.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(leathered.getRangeArmor()).toBeLessThan(leathered.getArmor());

        const shot = projectAttackDamage({
            attacker: shooter,
            target: leathered,
            attackType: RANGE,
            synergyAbilityPowerIncrease: 0,
        });
        const swing = projectAttackDamage({
            attacker: shooter,
            target: leathered,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });

        pinRoll(0);
        expect(shooter.calculateAttackDamage(leathered, RANGE, 0)).toBe(shot.min);
        pinRoll(0);
        expect(shooter.calculateAttackDamage(leathered, MELEE, 0)).toBe(swing.min);
        // Leather Armor is a RANGED-only weakness: the shot must hurt more than the (halved) melee poke.
        expect(shot.min).toBeGreaterThan(swing.min);
    });

    it("multiplies by the elemental affinity, both directions", () => {
        const fire = createTestUnit({
            name: "Efreet",
            team: RED,
            attack: 12,
            damageMin: 6,
            damageMax: 6,
            amountAlive: 10,
            abilities: ["Fire Element"],
        });
        const water = createTestUnit({
            name: "Mermaid",
            team: GREEN,
            armor: 15,
            maxHp: 20,
            amountAlive: 20,
            abilities: ["Water Element"],
        });
        const plain = createTestUnit({ name: "Plain", team: GREEN, armor: 15, maxHp: 20, amountAlive: 20 });

        const elemental = resolveAttackDamageChain({
            attacker: fire,
            target: water,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        }).elementalMultiplier;
        expect(elemental).toBeGreaterThan(1);
        expect(elemental).toBe(fire.getElementalDamageMultiplier(water));

        pinRoll(0);
        expect(fire.calculateAttackDamage(water, MELEE, 0)).toBe(
            projectAttackDamage({ attacker: fire, target: water, attackType: MELEE, synergyAbilityPowerIncrease: 0 })
                .min,
        );
        expect(
            resolveAttackDamageChain({
                attacker: fire,
                target: plain,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
            }).elementalMultiplier,
        ).toBe(1);
    });

    it("applies Deep Wounds only when the attacker inflicts it AND the victim carries the effect", () => {
        const makeVictim = (power: number): Unit => {
            const victim = createTestUnit({ name: "Victim", team: GREEN, armor: 20, maxHp: 40, amountAlive: 30 });
            const effect = new EffectFactory().makeEffect("Deep Wounds");
            if (!effect) {
                throw new Error("Deep Wounds effect config is missing");
            }
            effect.setPower(power);
            victim.applyEffect(effect);
            return victim;
        };

        const wounder = createTestUnit({
            name: "Wounder",
            team: RED,
            attack: 12,
            damageMin: 8,
            damageMax: 8,
            amountAlive: 10,
            abilities: ["Deep Wounds Level 1"],
        });
        const plainAttacker = createTestUnit({
            name: "Plain",
            team: RED,
            attack: 12,
            damageMin: 8,
            damageMax: 8,
            amountAlive: 10,
        });

        const woundedVictim = makeVictim(30);
        expect(
            resolveAttackDamageChain({
                attacker: wounder,
                target: woundedVictim,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
            }).deepWoundsMultiplier,
        ).toBe(1.3);
        expect(
            resolveAttackDamageChain({
                attacker: plainAttacker,
                target: woundedVictim,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
            }).deepWoundsMultiplier,
        ).toBe(1);
        expect(
            resolveAttackDamageChain({
                attacker: wounder,
                target: createTestUnit({ name: "Clean", team: GREEN, armor: 20, maxHp: 40, amountAlive: 30 }),
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
            }).deepWoundsMultiplier,
        ).toBe(1);

        pinRoll(0);
        expect(wounder.calculateAttackDamage(woundedVictim, MELEE, 0)).toBe(
            projectAttackDamage({
                attacker: wounder,
                target: woundedVictim,
                attackType: MELEE,
                synergyAbilityPowerIncrease: 0,
            }).min,
        );
    });

    it("floors the product in the engine's own order", () => {
        const attacker = createTestUnit({
            name: "Fractional",
            team: RED,
            attack: 7,
            damageMin: 9,
            damageMax: 9,
            rangeShots: 20,
            attackType: RANGE,
        });
        const target = createTestUnit({ name: "Dummy", team: GREEN, armor: 7, maxHp: 500, amountAlive: 10 });
        const chain = resolveAttackDamageChain({
            attacker,
            target,
            attackType: RANGE,
            synergyAbilityPowerIncrease: 0,
            divisor: 8,
            abilityMultiplier: 1.37,
        });

        expect(applyAttackDamageChain(chain, chain.rollMin)).toBe(
            Math.floor(
                chain.rollMin *
                    chain.attackTypeMultiplier *
                    chain.abilityMultiplier *
                    chain.deepWoundsMultiplier *
                    chain.elementalMultiplier,
            ),
        );
        pinRoll(0);
        expect(attacker.calculateAttackDamage(target, RANGE, 0, 8, 1.37)).toBe(
            applyAttackDamageChain(chain, chain.rollMin),
        );
    });
});

describe("the projection is a pure read", () => {
    it("spends no arrows and consumes no randomness", () => {
        const attacker = createTestUnit({
            name: "Archer",
            team: RED,
            attackType: RANGE,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            rangeShots: 10,
        });
        const target = createTestUnit({ name: "Dummy", team: GREEN, armor: 10, maxHp: 400, amountAlive: 10 });

        for (let i = 0; i < 25; i++) {
            projectAttackDamage({ attacker, target, attackType: RANGE, synergyAbilityPowerIncrease: 0 });
        }
        expect(attacker.getRangeShots()).toBe(10);

        attacker.calculateAttackDamage(target, RANGE, 0);
        expect(attacker.getRangeShots()).toBe(9);
    });

    it("returns a flat zero band for an empty quiver, exactly as the engine bails", () => {
        const attacker = createTestUnit({
            name: "Dry",
            team: RED,
            attackType: RANGE,
            attack: 20,
            damageMin: 20,
            damageMax: 20,
            rangeShots: 0,
        });
        const target = createTestUnit({ name: "Dummy", team: GREEN, armor: 10, maxHp: 400, amountAlive: 10 });

        expect(projectAttackDamage({ attacker, target, attackType: RANGE, synergyAbilityPowerIncrease: 0 })).toEqual({
            min: 0,
            max: 0,
            killsMin: 0,
            killsMax: 0,
        });
        expect(attacker.calculateAttackDamage(target, RANGE, 0)).toBe(0);
        // A melee swing with the same empty quiver still lands (halved) — the bail is the volley's alone.
        expect(
            projectAttackDamageBand({ attacker, target, attackType: MELEE, synergyAbilityPowerIncrease: 0 }).min,
        ).toBeGreaterThan(0);
    });
});

describe("the kill band comes from the engine's own loss helper", () => {
    it("matches what applyDamage actually removes from the stack, at both ends", () => {
        const attacker = createTestUnit({
            name: "Cleaver",
            team: RED,
            attack: 22,
            damageMin: 9,
            damageMax: 14,
            amountAlive: 20,
            stackPower: 5,
        });
        const makeTarget = (): Unit =>
            createTestUnit({ name: "Ranks", team: GREEN, armor: 20, maxHp: 40, amountAlive: 30 });

        const reference = makeTarget();
        const projection = projectAttackDamage({
            attacker,
            target: reference,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });
        expect(projection.killsMin).toBe(reference.calculatePossibleLosses(projection.min));
        expect(projection.killsMax).toBe(reference.calculatePossibleLosses(projection.max));
        expect(projection.killsMax).toBeGreaterThan(0);

        const chain = resolveAttackDamageChain({
            attacker,
            target: reference,
            attackType: MELEE,
            synergyAbilityPowerIncrease: 0,
        });
        const span = chain.rollMaxExclusive - chain.rollMin;

        for (const [offset, expectedDamage, expectedKills] of [
            [0, projection.min, projection.killsMin],
            [span - 1, projection.max, projection.killsMax],
        ] as const) {
            const victim = makeTarget();
            const before = victim.getAmountAlive();
            pinRoll(Math.max(0, offset));
            const dealt = attacker.calculateAttackDamage(victim, MELEE, 0);
            expect(dealt).toBe(expectedDamage);
            victim.applyDamage(dealt, 0, new SceneLogMock(), false, attacker);
            expect(before - victim.getAmountAlive()).toBe(expectedKills);
        }
    });

    it("recomputes kills for any post-tail damage through projectKillBand", () => {
        const target = createTestUnit({ name: "Ranks", team: GREEN, armor: 20, maxHp: 40, amountAlive: 30 });
        expect(projectKillBand(target, 39, 200)).toEqual({
            min: 39,
            max: 200,
            killsMin: target.calculatePossibleLosses(39),
            killsMax: target.calculatePossibleLosses(200),
        });
    });
});

describe("shot accounting is shared with spendShotsAgainst", () => {
    it("prices a plain volley at one arrow", () => {
        const attacker = createTestUnit({ name: "Archer", team: RED, attackType: RANGE, rangeShots: 10 });
        const target = createTestUnit({ name: "Dummy", team: GREEN });

        expect(projectShotCost(attacker, target)).toBe(1);
        expect(attacker.projectRangeShotsAfterVolleys(target, 1)).toBe(9);
        expect(attacker.spendShotsAgainst(target)).toBe(1);
        expect(attacker.getRangeShots()).toBe(9);
    });

    it("charges Dense Flesh's surcharge and predicts the emptied quiver", () => {
        const attacker = createTestUnit({ name: "Archer", team: RED, attackType: RANGE, rangeShots: 3 });
        const denseFlesh = createTestUnit({ name: "Abomination", team: GREEN, abilities: ["Dense Flesh"] });
        const cost = projectShotCost(attacker, denseFlesh);

        expect(cost).toBeGreaterThan(1);
        expect(attacker.projectRangeShotsAfterVolleys(denseFlesh, 1)).toBe(Math.max(0, 3 - cost));
        expect(attacker.spendShotsAgainst(denseFlesh)).toBe(cost);
        expect(attacker.getRangeShots()).toBe(Math.max(0, 3 - cost));
    });

    it("never runs an unlimited-supplies shooter dry", () => {
        const attacker = createTestUnit({
            name: "Endless",
            team: RED,
            attackType: RANGE,
            rangeShots: 4,
            abilities: ["Endless Quiver"],
        });
        const target = createTestUnit({ name: "Dummy", team: GREEN });

        expect(projectShotCost(attacker, target)).toBe(0);
        expect(attacker.projectRangeShotsAfterVolleys(target, 3)).toBe(attacker.getRangeShots());
        attacker.spendShotsAgainst(target);
        expect(attacker.getRangeShots()).toBe(4);
    });
});
