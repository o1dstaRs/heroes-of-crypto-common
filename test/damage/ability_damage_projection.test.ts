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

import { processDoubleShotAbility } from "../../src/abilities/double_shot_ability";
import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import {
    applyAoeDamageTail,
    applyThroughShotDamageTail,
    aoeAttackAbility,
    aoeAttackAbilityMultiplier,
    attackerParalysisMultiplier,
    doubleShotAbility,
    doubleShotSecondVolleyMultiplier,
    projectAoeRangeAttack,
    projectDoubleShotAttack,
    projectDoubleShotSecondVolley,
    projectThroughShotAttack,
    throughShotAbilityMultiplier,
} from "../../src/damage/ability_damage_projection";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import {
    createCombatTestContext,
    createTestUnit,
    createVisibleDamage,
    placeUnit,
    type TestUnitOptions,
} from "../helpers/combat";

const RED = PBTypes.TeamVals.UPPER;
const GREEN = PBTypes.TeamVals.LOWER;
const RANGE = PBTypes.AttackVals.RANGE;

/** See damage_projection.test.ts: a constant source of `offset / 2^32` pins every roll to min + offset%span. */
const pinRoll = (offset: number): void => setDeterministicRandomSource(() => offset / 0x100000000);

afterEach(() => setDeterministicRandomSource(undefined));

const giveMarkerBuff = (unit: Unit, name: string, power: number): void => {
    const buff = new Spell({ spellProperties: getSpellConfig("System", name, NUMBER_OF_LAPS_TOTAL), amount: 1 });
    buff.setPower(power);
    unit.applyBuff(buff);
};

/* ------------------------------------------------------------------------------------------------ *
 *  AOE tail
 * ------------------------------------------------------------------------------------------------ */

interface AoeScenario {
    label: string;
    attacker?: Partial<TestUnitOptions>;
    victim?: Partial<TestUnitOptions>;
    maul?: number;
    aegis?: number;
    statusResist?: number;
    divisor?: number;
    perUnitDamageFactor?: number;
}

const AOE_SCENARIOS: AoeScenario[] = [
    { label: "plain Large Caliber shot" },
    { label: "Giant's Maul +40%", maul: 40 },
    { label: "Giant's Maul +60% at 1/2 range", maul: 60, divisor: 2 },
    { label: "victim's Broken Aegis -25%", aegis: 25 },
    { label: "victim's Amulet of Resolve (status resist 25)", statusResist: 25 },
    { label: "Maul + Aegis + resist together", maul: 40, aegis: 25, statusResist: 25 },
    { label: "Mechanism victim (fragile to physical AOE)", victim: { abilities: ["Mechanism"] } },
    { label: "Mechanism victim with the Maul", maul: 40, victim: { abilities: ["Mechanism"] } },
    { label: "Chakram half bounce", perUnitDamageFactor: 0.5 },
    { label: "Chakram half bounce under the Maul", perUnitDamageFactor: 0.5, maul: 40 },
    { label: "Area Throw thrower", attacker: { abilities: ["Area Throw"] } },
    { label: "Area Throw at 1/4 range", attacker: { abilities: ["Area Throw"] }, divisor: 4 },
    { label: "small stack Large Caliber (stack-powered dilution)", attacker: { stackPower: 1 } },
    { label: "lucky thrower", attacker: { luck: 12, abilities: ["Area Throw"] } },
    { label: "spanned damage band", attacker: { damageMin: 11, damageMax: 17 }, maul: 40 },
];

const runAoeScenario = (scenario: AoeScenario, rollOffset: number) => {
    const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Cyclops",
        team: RED,
        attackType: RANGE,
        attack: 21,
        damageMin: 17,
        damageMax: 17,
        amountAlive: 5,
        stackPower: 5,
        rangeShots: 20,
        shotDistance: 6.5,
        abilities: ["Large Caliber"],
        ...scenario.attacker,
    });
    // The miss roll is a separate concern; pin it off so the comparison is about damage only.
    attacker.calculateMissChance = () => 0;
    const victim = createTestUnit({
        name: "Victim",
        team: GREEN,
        armor: 20,
        maxHp: 1_000_000,
        amountAlive: 4,
        ...scenario.victim,
    });
    placeUnit(grid, unitsHolder, attacker, { x: 7, y: 7 });
    placeUnit(grid, unitsHolder, victim, { x: 2, y: 2 });

    if (scenario.maul) {
        giveMarkerBuff(attacker, "Giants Maul", scenario.maul);
    }
    if (scenario.aegis) {
        giveMarkerBuff(victim, "Broken Aegis", scenario.aegis);
    }
    if (scenario.statusResist) {
        giveMarkerBuff(victim, "Amulet of Resolve", scenario.statusResist);
    }

    const divisor = scenario.divisor ?? 1;
    const projection = projectAoeRangeAttack({
        attacker,
        victim,
        synergyAbilityPowerIncrease: 0,
        divisor,
        perUnitDamageFactor: scenario.perUnitDamageFactor,
    });

    pinRoll(rollOffset);
    const result = processRangeAOEAbility(
        attacker,
        [victim],
        attacker,
        divisor,
        unitsHolder,
        grid,
        new SceneLogMock(),
        damageStatisticHolder,
        true,
        [],
        scenario.perUnitDamageFactor !== undefined ? { [victim.getId()]: scenario.perUnitDamageFactor } : undefined,
    );

    return { projection, result, attacker, victim };
};

describe("projectAoeRangeAttack mirrors processRangeAOEAbility", () => {
    it("predicts the exact splash damage for every artifact / resistance combination", () => {
        for (const scenario of AOE_SCENARIOS) {
            const bottom = runAoeScenario(scenario, 0);
            expect(bottom.result.landed).toBe(true);
            expect({ scenario: scenario.label, damage: bottom.result.maxDamage }).toEqual({
                scenario: scenario.label,
                damage: bottom.projection.min,
            });
            expect(bottom.result.perUnitDamage[0]?.amount).toBe(bottom.projection.min);

            // An arbitrary roll must still land inside the projected band, wherever in it the engine
            // lands (the exact top is pinned by the spanned-band test below).
            const top = runAoeScenario(scenario, 4095);
            expect(top.result.maxDamage).toBeLessThanOrEqual(top.projection.max);
            expect(top.result.maxDamage).toBeGreaterThanOrEqual(top.projection.min);
        }
    });

    it("pins the top of a spanned AOE band exactly", () => {
        // A one-wide-per-step band: 11..17 damage over armor 20 with 5 alive gives a small, pinnable span.
        const scenario: AoeScenario = { label: "spanned", attacker: { damageMin: 11, damageMax: 17 }, maul: 40 };
        const reference = runAoeScenario(scenario, 0);
        const span =
            reference.attacker.calculateAttackDamageMax(reference.attacker.getAttack(), reference.victim, true, 0, 1) -
            reference.attacker.calculateAttackDamageMin(reference.attacker.getAttack(), reference.victim, true, 0, 1);
        expect(span).toBeGreaterThan(1);

        const top = runAoeScenario(scenario, span - 1);
        expect(top.result.maxDamage).toBe(top.projection.max);
        expect(top.projection.max).toBeGreaterThan(top.projection.min);
    });

    it("kills the same number of ranks the engine kills", () => {
        const scenario: AoeScenario = { label: "kills", maul: 40, victim: { maxHp: 40, amountAlive: 30 } };
        const run = runAoeScenario(scenario, 0);
        expect(run.result.perUnitDamage[0]?.unitsDied).toBe(run.projection.killsMin);
        expect(run.projection.killsMin).toBeGreaterThan(0);
    });

    it("applies the tail steps in the engine's flooring order", () => {
        const attacker = createTestUnit({ name: "Thrower", team: RED, attackType: RANGE, rangeShots: 5 });
        const victim = createTestUnit({ name: "Victim", team: GREEN });
        giveMarkerBuff(attacker, "Giants Maul", 40);
        giveMarkerBuff(victim, "Broken Aegis", 25);
        giveMarkerBuff(victim, "Amulet of Resolve", 25);

        // 101 -> x0.5 = 50 -> x1.4 = 70 -> x0.75 = 52 -> x0.75 = 39. Each step floors on its own; folding
        // the same four factors into one product would give floor(101 * 0.39375) = 39 here but 79 below,
        // where the engine deals 78 (141 -> 105 -> 78).
        expect(applyAoeDamageTail({ attacker, victim, damage: 101, perUnitDamageFactor: 0.5 })).toBe(39);
        expect(applyAoeDamageTail({ attacker, victim, damage: 101 })).toBe(78);
        expect(
            applyAoeDamageTail({ attacker, victim: createTestUnit({ name: "Bare", team: GREEN }), damage: 101 }),
        ).toBe(141);
    });

    it("looks the AOE ability up in the engine's order and folds Paralysis into its multiplier", () => {
        const thrower = createTestUnit({
            name: "Gargantuan",
            team: RED,
            attackType: RANGE,
            rangeShots: 5,
            stackPower: 5,
            abilities: ["Area Throw", "Large Caliber"],
        });
        expect(aoeAttackAbility(thrower)?.getName()).toBe("Area Throw");
        expect(aoeAttackAbility(createTestUnit({ name: "Plain", team: RED }))).toBeUndefined();
        expect(aoeAttackAbilityMultiplier(createTestUnit({ name: "Plain", team: RED }), 0)).toBe(1);
        expect(aoeAttackAbilityMultiplier(thrower, 0)).toBe(
            thrower.calculateAbilityMultiplier(thrower.getAbility("Area Throw")!, 0),
        );
        expect(attackerParalysisMultiplier(thrower)).toBe(1);
    });
});

/* ------------------------------------------------------------------------------------------------ *
 *  Through Shot
 * ------------------------------------------------------------------------------------------------ */

interface ThroughShotScenario {
    label: string;
    attacker?: Partial<TestUnitOptions>;
    victim?: Partial<TestUnitOptions>;
    maul?: number;
    statusResist?: number;
    /** Per-pierce divisors, in ray order (front, rear). */
    divisors?: [number, number];
    /** Synergy strings for the ATTACKER's team — the Might one raises additional ability power. */
    attackerSynergies?: string[];
}

const MIGHT_ABILITY_POWER_SYNERGY = "Might:2:3";

const THROUGH_SHOT_SCENARIOS: ThroughShotScenario[] = [
    { label: "plain pierce" },
    { label: "Giant's Maul +40%", maul: 40 },
    { label: "Giant's Maul +60%", maul: 60 },
    { label: "status resist 25", statusResist: 25 },
    { label: "Maul and resist together", maul: 40, statusResist: 25 },
    { label: "Mechanism victims", victim: { abilities: ["Mechanism"] } },
    { label: "different divisor per pierce", divisors: [1, 8] },
    { label: "Piercing Spear shooter", attacker: { abilities: ["Through Shot", "Piercing Spear"] } },
    { label: "small stack", attacker: { stackPower: 1 } },
    // A Piercing Spear shooter's own Might synergy reaches its armor-ignore, because the engine hands
    // calculateAttackDamage the ATTACKER's team power here like it does everywhere else. It used to hand
    // over the defender's, which dropped the synergy from the pierce.
    {
        label: "attacker-team Might synergy with Piercing Spear",
        attacker: { abilities: ["Through Shot", "Piercing Spear"] },
        victim: { armor: 20 },
        attackerSynergies: [MIGHT_ABILITY_POWER_SYNERGY],
    },
    { label: "attacker-team Might synergy, no Piercing Spear", attackerSynergies: [MIGHT_ABILITY_POWER_SYNERGY] },
];

const runThroughShotScenario = (scenario: ThroughShotScenario, rollOffset: number) => {
    const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
    if (scenario.attackerSynergies) {
        FightStateManager.getInstance().getFightProperties().setSynergiesPerTeam(RED, scenario.attackerSynergies);
    }
    const attacker = createTestUnit({
        name: "Piercer",
        team: RED,
        attackType: RANGE,
        attack: 10,
        damageMin: 7,
        damageMax: 7,
        amountAlive: 5,
        stackPower: 5,
        rangeShots: 9,
        shotDistance: 30,
        abilities: ["Through Shot"],
        ...scenario.attacker,
    });
    attacker.calculateMissChance = () => 0;
    const makeVictim = (name: string) =>
        createTestUnit({ name, team: GREEN, armor: 12, maxHp: 1_000_000, amountAlive: 4, ...scenario.victim });
    const front = makeVictim("Front");
    const rear = makeVictim("Rear");
    placeUnit(grid, unitsHolder, attacker, { x: 5, y: 9 });
    placeUnit(grid, unitsHolder, front, { x: 5, y: 7 });
    placeUnit(grid, unitsHolder, rear, { x: 5, y: 5 });

    if (scenario.maul) {
        giveMarkerBuff(attacker, "Giants Maul", scenario.maul);
    }
    if (scenario.statusResist) {
        giveMarkerBuff(front, "Amulet of Resolve", scenario.statusResist);
        giveMarkerBuff(rear, "Amulet of Resolve", scenario.statusResist);
    }

    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const attackerSynergyAbilityPowerIncrease = fightProperties.getAdditionalAbilityPowerPerTeam(RED);
    const targetSynergyAbilityPowerIncrease = fightProperties.getAdditionalAbilityPowerPerTeam(GREEN);

    const divisors = scenario.divisors ?? [1, 1];
    const projections = [front, rear].map((victim, index) =>
        projectThroughShotAttack({
            attacker,
            victim,
            attackerSynergyAbilityPowerIncrease,
            targetSynergyAbilityPowerIncrease,
            divisor: divisors[index],
        }),
    );

    pinRoll(rollOffset);
    const result = processThroughShotAbility(
        attacker,
        [[front], [rear], []],
        attacker,
        [...divisors, 1],
        rear.getPosition(),
        unitsHolder,
        grid,
        new SceneLogMock(),
        damageStatisticHolder,
    );

    return {
        projections,
        result,
        attacker,
        front,
        rear,
        attackerSynergyAbilityPowerIncrease,
        targetSynergyAbilityPowerIncrease,
    };
};

describe("projectThroughShotAttack mirrors processThroughShotAbility", () => {
    it("predicts every pierced unit's damage, per-pierce divisor and artifacts included", () => {
        for (const scenario of THROUGH_SHOT_SCENARIOS) {
            const run = runThroughShotScenario(scenario, 0);
            expect(run.result.landed).toBe(true);
            expect(run.result.perUnitDamage.length).toBe(2);
            for (const [index, entry] of run.result.perUnitDamage.entries()) {
                expect({ scenario: scenario.label, index, damage: entry.amount }).toEqual({
                    scenario: scenario.label,
                    index,
                    damage: run.projections[index].min,
                });
            }
        }
    });

    // REGRESSION (engine defect): processThroughShotAbility used to pass the DEFENDER's team power as
    // calculateAttackDamage's synergyAbilityPowerIncrease. That argument reaches getEnemyArmor ->
    // calculateAbilityMultiplier(Piercing Spear), so a shooter's own Might synergy never reached its
    // armor-ignore: the measurement saw 52 projected against 39 dealt (-25%) and an exact match only when
    // NEITHER team had a synergy — the tell that the wrong team was being read.
    it("scales the shooter's Piercing Spear by the ATTACKER's team synergy, not the defender's", () => {
        const scenario: ThroughShotScenario = {
            label: "synergy",
            attacker: { abilities: ["Through Shot", "Piercing Spear"] },
            victim: { armor: 20 },
            attackerSynergies: [MIGHT_ABILITY_POWER_SYNERGY],
        };
        const run = runThroughShotScenario(scenario, 0);

        // The synergy really is live on the attacker's team and absent on the defender's...
        expect(run.attackerSynergyAbilityPowerIncrease).toBeGreaterThan(0);
        expect(run.targetSynergyAbilityPowerIncrease).toBe(0);
        // ...the engine spends the ATTACKER's power on the armor-ignore, and the projection matches it.
        expect(run.result.perUnitDamage[0]?.amount).toBe(run.projections[0].min);

        // Feeding the defender's (zero) power into the attacker slot reproduces the OLD engine number, and
        // it is strictly smaller — the synergy is worth real damage rather than being a no-op both ways.
        const asIfDefenderTeam = projectThroughShotAttack({
            attacker: run.attacker,
            victim: run.front,
            attackerSynergyAbilityPowerIncrease: run.targetSynergyAbilityPowerIncrease,
        });
        expect(asIfDefenderTeam.min).toBeLessThan(run.projections[0].min);

        // And the same shot without the synergy lands exactly where that stand-in predicts: the ONLY thing
        // the synergy changes on this path is the Piercing Spear armor-ignore.
        const noSynergy = runThroughShotScenario({ ...scenario, attackerSynergies: undefined }, 0);
        expect(noSynergy.attackerSynergyAbilityPowerIncrease).toBe(0);
        expect(noSynergy.result.perUnitDamage[0]?.amount).toBe(asIfDefenderTeam.min);
    });

    it("does NOT read the victim's Broken Aegis — that step belongs to the splash tail only", () => {
        const attacker = createTestUnit({ name: "Piercer", team: RED, attackType: RANGE, rangeShots: 5 });
        const victim = createTestUnit({ name: "Victim", team: GREEN });
        giveMarkerBuff(attacker, "Giants Maul", 40);
        giveMarkerBuff(victim, "Broken Aegis", 25);

        expect(applyThroughShotDamageTail({ attacker, victim, damage: 101 })).toBe(141);
        expect(applyAoeDamageTail({ attacker, victim, damage: 101 })).toBe(105);
    });

    it("scales a Double Shot's second pierce by the volley multiplier", () => {
        const attacker = createTestUnit({
            name: "Piercer",
            team: RED,
            attackType: RANGE,
            rangeShots: 5,
            stackPower: 5,
            abilities: ["Through Shot"],
        });

        expect(throughShotAbilityMultiplier(attacker, 0, 0.5)).toBe(throughShotAbilityMultiplier(attacker, 0) * 0.5);
        expect(throughShotAbilityMultiplier(createTestUnit({ name: "Plain", team: RED }), 0)).toBe(1);
    });
});

/* ------------------------------------------------------------------------------------------------ *
 *  Double Shot's second volley
 * ------------------------------------------------------------------------------------------------ */

interface DoubleShotScenario {
    label: string;
    attacker?: Partial<TestUnitOptions>;
    victim?: Partial<TestUnitOptions>;
    dualStrikeCharm?: number;
    divisor?: number;
}

const DOUBLE_SHOT_SCENARIOS: DoubleShotScenario[] = [
    { label: "stack power 1" },
    { label: "stack power 2", attacker: { stackPower: 2 } },
    { label: "stack power 3", attacker: { stackPower: 3 } },
    { label: "stack power 4", attacker: { stackPower: 4 } },
    { label: "stack power 5", attacker: { stackPower: 5 } },
    { label: "full stack with +10 luck", attacker: { stackPower: 5, luck: 10 } },
    { label: "full stack with -5 luck", attacker: { stackPower: 5, luck: -5 } },
    { label: "Dual Strike Charm +50%", attacker: { stackPower: 5 }, dualStrikeCharm: 50 },
    { label: "Dual Strike Charm on a half stack", attacker: { stackPower: 2 }, dualStrikeCharm: 50 },
    { label: "fractional per-wave damage at 1/8", attacker: { attack: 7, damageMin: 9, damageMax: 9 }, divisor: 8 },
    { label: "1/2 falloff", divisor: 2 },
    { label: "Crafted Double Shot", attacker: { abilities: ["Crafted Double Shot"], stackPower: 5 } },
    { label: "big stack", attacker: { amountAlive: 10, stackPower: 5, attack: 17, damageMin: 4, damageMax: 4 } },
];

const runDoubleShotScenario = (scenario: DoubleShotScenario, rollOffset: number) => {
    const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Shooter",
        team: RED,
        attackType: RANGE,
        attack: 20,
        damageMin: 20,
        damageMax: 20,
        amountAlive: 1,
        rangeShots: 10,
        shotDistance: 10,
        abilities: ["Double Shot"],
        ...scenario.attacker,
    });
    attacker.calculateMissChance = () => 0;
    const victim = createTestUnit({
        name: "Victim",
        team: GREEN,
        armor: 10,
        maxHp: 1_000_000,
        amountAlive: 4,
        ...scenario.victim,
    });
    placeUnit(grid, unitsHolder, attacker, { x: 3, y: 3 });
    placeUnit(grid, unitsHolder, victim, { x: 9, y: 3 });
    if (scenario.dualStrikeCharm) {
        giveMarkerBuff(attacker, "Dual Strike Charm", scenario.dualStrikeCharm);
    }

    const divisor = scenario.divisor ?? 1;
    const projection = projectDoubleShotAttack({
        attacker,
        target: victim,
        synergyAbilityPowerIncrease: 0,
        divisor,
    });

    // The attack handler fires the FIRST volley itself (abilityMultiplier 1) and only then hands over.
    pinRoll(rollOffset);
    const firstVolley = attacker.calculateAttackDamage(victim, RANGE, 0, divisor, 1);
    const secondVolley = processDoubleShotAbility(
        attacker,
        victim,
        [victim],
        new SceneLogMock(),
        unitsHolder,
        grid,
        divisor,
        victim.getPosition(),
        createVisibleDamage(victim),
        damageStatisticHolder,
        false,
    );

    return { projection, firstVolley, secondVolley, attacker, victim };
};

describe("projectDoubleShotSecondVolley mirrors processDoubleShotAbility", () => {
    it("predicts both volleys exactly, at every stack power and with the charm", () => {
        for (const scenario of DOUBLE_SHOT_SCENARIOS) {
            const run = runDoubleShotScenario(scenario, 0);
            expect({ scenario: scenario.label, first: run.firstVolley }).toEqual({
                scenario: scenario.label,
                first: run.projection.first.min,
            });
            expect(run.secondVolley.applied).toBe(true);
            expect({ scenario: scenario.label, second: run.secondVolley.damage }).toEqual({
                scenario: scenario.label,
                second: run.projection.second.min,
            });
            expect(run.projection.total.min).toBe(run.firstVolley + run.secondVolley.damage);
        }
    });

    it("is NOT a flat 2x — the second volley dilutes across the stack", () => {
        const weak = runDoubleShotScenario({ label: "stack power 1" }, 0);
        const strong = runDoubleShotScenario({ label: "stack power 5", attacker: { stackPower: 5 } }, 0);

        expect(weak.projection.total.min).toBeLessThan(2 * weak.projection.first.min);
        expect(weak.secondVolley.damage).toBe(Math.floor(weak.projection.first.min * 0.2));
        expect(strong.projection.second.min).toBe(strong.projection.first.min);
        expect(strong.projection.total.min).toBe(2 * strong.projection.first.min);
    });

    it("ceils each volley separately instead of ceiling the doubled value", () => {
        // Per-wave raw X = (9*7*1)/7/8 = 1.125: the engine deals 2 * ceil(1.125) = 4, not ceil(2.25) = 3.
        const run = runDoubleShotScenario(
            {
                label: "fractional",
                attacker: { attack: 7, damageMin: 9, damageMax: 9, stackPower: 5, amountAlive: 1 },
                victim: { armor: 7 },
                divisor: 8,
            },
            0,
        );

        expect(run.firstVolley).toBe(2);
        expect(run.secondVolley.damage).toBe(2);
        expect(run.projection.total.min).toBe(4);
    });

    it("gives the last arrow in the quiver only ONE volley", () => {
        const run = runDoubleShotScenario({ label: "last arrow", attacker: { rangeShots: 1, stackPower: 5 } }, 0);

        expect(run.projection.second).toEqual({ min: 0, max: 0, killsMin: 0, killsMax: 0 });
        expect(run.secondVolley.damage).toBe(0);
        expect(run.projection.total.min).toBe(run.firstVolley);
    });

    it("respects Dense Flesh's shot surcharge when gating the second volley", () => {
        const run = runDoubleShotScenario(
            {
                label: "dense flesh",
                attacker: { rangeShots: 2, stackPower: 5 },
                victim: { abilities: ["Dense Flesh"] },
            },
            0,
        );

        expect(run.attacker.getRangeShots()).toBe(0);
        expect(run.projection.second.min).toBe(0);
        expect(run.secondVolley.damage).toBe(0);
    });

    it("keeps firing an unlimited-supplies shooter", () => {
        const run = runDoubleShotScenario(
            {
                label: "endless",
                attacker: { rangeShots: 1, stackPower: 5, abilities: ["Double Shot", "Endless Quiver"] },
            },
            0,
        );

        expect(run.projection.second.min).toBeGreaterThan(0);
        expect(run.secondVolley.damage).toBe(run.projection.second.min);
    });

    it("folds the Dual Strike Charm into the second volley only", () => {
        const bare = runDoubleShotScenario({ label: "bare", attacker: { stackPower: 5 } }, 0);
        const charmed = runDoubleShotScenario(
            { label: "charmed", attacker: { stackPower: 5 }, dualStrikeCharm: 50 },
            0,
        );

        expect(charmed.projection.first.min).toBe(bare.projection.first.min);
        expect(charmed.projection.second.min).toBe(Math.floor(bare.projection.second.min * 1.5));
        expect(charmed.secondVolley.damage).toBe(charmed.projection.second.min);
    });

    it("exposes the second volley's multiplier, and zero for a unit without the ability", () => {
        const shooter = createTestUnit({
            name: "Shooter",
            team: RED,
            attackType: RANGE,
            rangeShots: 5,
            stackPower: 5,
            abilities: ["Double Shot"],
        });
        const plain = createTestUnit({ name: "Plain", team: RED, attackType: RANGE, rangeShots: 5 });

        expect(doubleShotAbility(shooter)?.getName()).toBe("Double Shot");
        expect(doubleShotAbility(plain)).toBeUndefined();
        expect(doubleShotSecondVolleyMultiplier(plain, 0)).toBe(0);
        expect(doubleShotSecondVolleyMultiplier(shooter, 0)).toBe(
            shooter.calculateAbilityMultiplier(shooter.getAbility("Double Shot")!, 0),
        );
        expect(
            projectDoubleShotSecondVolley({
                attacker: plain,
                target: createTestUnit({ name: "Victim", team: GREEN }),
                synergyAbilityPowerIncrease: 0,
            }),
        ).toEqual({ min: 0, max: 0, killsMin: 0, killsMax: 0 });
    });

    it("pins both ends of a spanned Double Shot band against the engine", () => {
        const scenario: DoubleShotScenario = {
            label: "spanned",
            attacker: { damageMin: 14, damageMax: 21, stackPower: 5, amountAlive: 1 },
        };
        const bottom = runDoubleShotScenario(scenario, 0);
        const span =
            bottom.attacker.calculateAttackDamageMax(bottom.attacker.getAttack(), bottom.victim, true, 0, 1) -
            bottom.attacker.calculateAttackDamageMin(bottom.attacker.getAttack(), bottom.victim, true, 0, 1);
        expect(span).toBeGreaterThan(1);

        const top = runDoubleShotScenario(scenario, span - 1);
        expect(top.firstVolley).toBe(top.projection.first.max);
        expect(top.secondVolley.damage).toBe(top.projection.second.max);
        expect(top.projection.total.max).toBe(top.firstVolley + top.secondVolley.damage);
    });
});
