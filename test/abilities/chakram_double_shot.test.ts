import { afterEach, describe, expect, it } from "bun:test";

import { processDoubleShotAbility } from "../../src/abilities/double_shot_ability";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
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

const GREEN = PBTypes.TeamVals.LEFT;
const RED = PBTypes.TeamVals.RIGHT;
const INITIAL_HP = 5000;

afterEach(() => setDeterministicRandomSource(undefined));

function setup(options: TestUnitOptions = {}, primaryOptions: TestUnitOptions = {}) {
    const context = createCombatTestContext();
    const zena = createTestUnit({
        name: "Zena",
        team: GREEN,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: ["Chakram", "Crafted Double Shot"],
        stackPower: 5,
        amountAlive: 5,
        maxHp: 1000,
        exp: 100,
        ...options,
    });
    placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: 2 });
    zena.calculateMissChance = () => 0;
    // Preserve the live ability multiplier while fixing the base damage roll.
    zena.calculateAttackDamage = (_victim, _attack, _power, _divisor, multiplier = 1) => Math.floor(100 * multiplier);
    const enemy = (name: string, x: number, y: number, extra: TestUnitOptions = {}) => {
        const unit = createTestUnit({
            name,
            team: RED,
            footprintWidth: 1,
            footprintHeight: 2,
            stackPower: 5,
            amountAlive: 5,
            maxHp: 1000,
            exp: 100,
            ...extra,
        });
        placeUnit(context.grid, context.unitsHolder, unit, { x, y });
        return unit;
    };
    const primary = enemy("Primary", 8, 8, primaryOptions);
    return { ...context, zena, primary, enemy };
}

function throwDiscs(context: ReturnType<typeof setup>, response?: Unit[]) {
    const visible = createVisibleDamage(context.primary);
    setDeterministicRandomSource(() => 0);
    const result = context.attackHandler.handleRangeAttack(
        context.unitsHolder,
        [1],
        1,
        visible,
        context.zena,
        [[context.primary]],
        response,
        context.primary.getPosition(),
    );
    expect(result.completed).toBe(true);
    return { result, visible, flights: visible.chakramFlights ?? [] };
}

describe("Crafted Double Shot — independent Chakram flights", () => {
    for (const scenario of ["first primary", "second primary", "first bounce", "second bounce"] as const) {
        it(`stops only the ${scenario} dodge's own flight and rolls every reached victim once`, () => {
            const context = setup();
            const first = context.enemy("First", 10, 10);
            const second = context.enemy("Second", 12, 12);
            const calls = new Map<string, number>();
            context.zena.calculateMissChance = (victim) => {
                const count = (calls.get(victim.getId()) ?? 0) + 1;
                calls.set(victim.getId(), count);
                const dodgingId = scenario.includes("primary") ? context.primary.getId() : first.getId();
                return victim.getId() === dodgingId && count === (scenario.startsWith("first") ? 1 : 2) ? 100 : 0;
            };

            const { flights, visible } = throwDiscs(context);

            expect(flights).toHaveLength(2);
            const expected =
                scenario === "first primary"
                    ? [[context.primary], [context.primary, first, second]]
                    : scenario === "second primary"
                      ? [[context.primary, first, second], [context.primary]]
                      : scenario === "first bounce"
                        ? [
                              [context.primary, first],
                              [context.primary, first, second],
                          ]
                        : [
                              [context.primary, first, second],
                              [context.primary, first],
                          ];
            expect(flights.map((flight) => flight.splash.map((entry) => entry.unitId))).toEqual(
                expected.map((units) => units.map((unit) => unit.getId())),
            );
            expect(
                flights.map((flight) => ({
                    attackerId: flight.attackerId,
                    primaryTargetId: flight.primaryTargetId,
                    response: flight.response,
                    hitIndex: flight.hitIndex,
                })),
            ).toEqual([
                {
                    attackerId: context.zena.getId(),
                    primaryTargetId: context.primary.getId(),
                    response: false,
                    hitIndex: 0,
                },
                {
                    attackerId: context.zena.getId(),
                    primaryTargetId: context.primary.getId(),
                    response: false,
                    hitIndex: 1,
                },
            ]);
            const missedFlight = flights[scenario.startsWith("first") ? 0 : 1];
            expect(missedFlight.splash.at(-1)?.missed).toBe(true);
            expect(missedFlight.arcs).toHaveLength(scenario.includes("primary") ? 0 : 1);
            expect(missedFlight.missed).toBe(scenario.includes("primary"));
            expect(calls.get(context.primary.getId())).toBe(2);
            expect(calls.get(first.getId())).toBe(scenario.includes("primary") ? 1 : 2);
            expect(calls.get(second.getId())).toBe(1);
            expect(visible.splash).toEqual(flights.flatMap((flight) => flight.splash));
            expect(context.primary.getCumulativeHp()).toBe(INITIAL_HP - (scenario.includes("primary") ? 100 : 200));
            expect(second.getCumulativeHp()).toBe(INITIAL_HP - 100);
        });
    }

    it("never repeats a dead first-flight bounce and replans the next flight from the primary", () => {
        const context = setup();
        const first = context.enemy("Fragile", 10, 10, { amountAlive: 1, maxHp: 100 });
        const second = context.enemy("Second", 12, 12);

        const { flights } = throwDiscs(context);

        expect(first.isDead()).toBe(true);
        expect(flights[0].splash.map((entry) => entry.unitId)).toEqual([
            context.primary.getId(),
            first.getId(),
            second.getId(),
        ]);
        expect(flights[1].splash.map((entry) => entry.unitId)).toEqual([context.primary.getId()]);
        expect(flights[1].arcs).toEqual([]);
        expect(second.getCumulativeHp()).toBe(INITIAL_HP - 100);
    });

    it("crosses a killed relay's cleared cell on a fresh terminal half-damage hop", () => {
        const context = setup({}, { footprintWidth: 1, footprintHeight: 1 });
        // A straight row has only one bridge. The first throw hits the fragile relay; its neighbour
        // touches it and cannot be bounced to. The second throw now crosses the relay's dead grid entry.
        const primary = context.primary;
        const relay = context.enemy("Fragile relay", 10, 8, {
            footprintWidth: 1,
            footprintHeight: 1,
            amountAlive: 1,
            maxHp: 100,
        });
        const beyond = context.enemy("Beyond", 11, 8, { footprintWidth: 1, footprintHeight: 1 });

        const { flights } = throwDiscs(context);

        expect(relay.isDead()).toBe(true);
        expect(flights[0].splash.map((entry) => entry.unitId)).toEqual([primary.getId(), relay.getId()]);
        expect(flights[1].splash).toEqual([
            expect.objectContaining({ unitId: primary.getId(), amount: 100 }),
            expect.objectContaining({ unitId: beyond.getId(), amount: 50 }),
        ]);
        expect(flights[1].arcs[0].cells).toEqual([
            { x: 8, y: 8 },
            { x: 9, y: 8 },
            { x: 10, y: 8 },
            { x: 11, y: 8 },
        ]);
    });

    it("records a separate zero-bounce return for each disc in a packed pair", () => {
        const context = setup();
        const touching = context.enemy("Touching", 9, 8);

        const { flights } = throwDiscs(context);

        expect(flights.map((flight) => flight.arcs)).toEqual([[], []]);
        expect(flights.map((flight) => flight.splash.map((entry) => entry.unitId))).toEqual([
            [context.primary.getId()],
            [context.primary.getId()],
        ]);
        expect(touching.getCumulativeHp()).toBe(INITIAL_HP);
    });

    it("records each Angel shield catch without hitting the shield or relaying beyond it", () => {
        const context = setup();
        const angel = context.enemy("Angel", 10, 10, { abilities: ["Arrows Wingshield Blessing"] });
        const behind = context.enemy("Behind Angel", 12, 12);

        const { flights } = throwDiscs(context);

        expect(flights.map((flight) => flight.arcs.map((arc) => arc.hitUnitIds))).toEqual([[[]], [[]]]);
        expect(flights.map((flight) => flight.splash.map((entry) => entry.unitId))).toEqual([
            [context.primary.getId()],
            [context.primary.getId()],
        ]);
        expect(angel.getCumulativeHp()).toBe(INITIAL_HP);
        expect(behind.getCumulativeHp()).toBe(INITIAL_HP);
    });

    for (const rangeShots of [1, 2]) {
        it(`funds ${rangeShots} actual throws from ${rangeShots} incoming arrows`, () => {
            const context = setup({ rangeShots });
            context.enemy("First", 10, 10);

            const { flights, result } = throwDiscs(context);

            expect(flights).toHaveLength(rangeShots);
            expect(result.animationData).toHaveLength(rangeShots);
            expect(context.zena.getRangeShots()).toBe(0);
        });
    }

    for (const rangeShots of [2, 4]) {
        it(`prices Dense Flesh per volley with ${rangeShots} incoming arrows`, () => {
            const context = setup({ rangeShots });
            context.primary.grantAbility("Dense Flesh");

            const { flights, result } = throwDiscs(context);

            expect(flights).toHaveLength(rangeShots / 2);
            expect(result.animationData).toHaveLength(rangeShots / 2);
            expect(context.zena.getRangeShots()).toBe(0);
        });
    }

    it("retains recorded first-flight ownership after a counter applies Break and cancels the extra disc", () => {
        const context = setup({}, { attackType: PBTypes.AttackVals.RANGE, rangeShots: 8 });
        context.primary.calculateMissChance = () => 0;
        context.primary.calculateAttackDamage = () => {
            context.zena.applyEffect(new EffectFactory().makeEffect("Break")!);
            return 0;
        };

        const { flights } = throwDiscs(context, [context.zena]);

        expect(context.zena.hasAbilityActive("Chakram")).toBe(false);
        expect(flights).toHaveLength(1);
        expect(flights[0].attackerId).toBe(context.zena.getId());
        expect(flights[0].hitIndex).toBe(0);
        expect(flights[0].splash[0].amount).toBe(100);
    });

    it("keeps two initiating discs and a counter disc in distinct flights while preserving legacy splash order", () => {
        const context = setup({}, { attackType: PBTypes.AttackVals.RANGE, rangeShots: 8, abilities: ["Chakram"] });
        const redBounce = context.enemy("Red bounce", 10, 10);
        const greenBounce = context.enemy("Green bounce", 10, 4, { team: GREEN });
        context.primary.calculateMissChance = () => 0;
        context.primary.calculateAttackDamage = () => 25;

        const { flights, visible } = throwDiscs(context, [context.zena]);

        expect(flights.map((flight) => [flight.attackerId, flight.response, flight.hitIndex])).toEqual([
            [context.zena.getId(), false, 0],
            [context.primary.getId(), true, 0],
            [context.zena.getId(), false, 1],
        ]);
        expect(flights.map((flight) => flight.splash.map((entry) => [entry.unitId, entry.amount]))).toEqual([
            [
                [context.primary.getId(), 100],
                [redBounce.getId(), 100],
            ],
            [
                [context.zena.getId(), 25],
                [greenBounce.getId(), 25],
            ],
            [
                [context.primary.getId(), 100],
                [redBounce.getId(), 100],
            ],
        ]);
        expect(visible.splash).toEqual([...flights[0].splash, ...flights[2].splash, ...flights[1].splash]);
        expect(visible.chakramArcs).toEqual(flights.flatMap((flight) => flight.arcs));
    });
});

describe("Crafted Chakram bonus damage", () => {
    for (const stackPower of [1, 5]) {
        for (const charm of [0, 50]) {
            it(`uses the bonus ability's live tier ${stackPower} and charm ${charm}% on its own half-damage hop`, () => {
                const context = setup({ stackPower });
                const wide = context.enemy("Wide", 11, 11);
                if (charm) {
                    const buff = new Spell({
                        spellProperties: getSpellConfig("System", "Dual Strike Charm"),
                        amount: 1,
                    });
                    buff.setPower(charm);
                    context.zena.applyBuff(buff);
                }
                const visible = createVisibleDamage(context.primary);
                setDeterministicRandomSource(() => 0);
                const result = processDoubleShotAbility(
                    context.zena,
                    context.primary,
                    [context.primary, wide],
                    new SceneLogMock(),
                    context.unitsHolder,
                    context.grid,
                    1,
                    context.primary.getPosition(),
                    visible,
                    context.damageStatisticHolder,
                    false,
                    // A stale previous-wave factor must have no effect on the fresh Chakram.
                    { [context.primary.getId()]: 0.01, [wide.getId()]: 1 },
                );
                const flight = visible.chakramFlights?.[0];
                const primaryAmount = Math.floor(((100 * stackPower) / 5) * (stackPower / 5) * (1 + charm / 100));

                expect(result.applied).toBe(true);
                expect(flight?.splash[0].amount).toBe(primaryAmount);
                expect(flight?.splash).toHaveLength(stackPower === 1 ? 1 : 2);
                if (stackPower === 5)
                    expect(flight?.splash[1]).toEqual(
                        expect.objectContaining({ unitId: wide.getId(), amount: primaryAmount / 2 }),
                    );
            });
        }
    }

    it("applies Paralysis once and retains exact half-damage rounding after the bonus and charm", () => {
        const context = setup();
        const wide = context.enemy("Wide", 11, 11);
        const paralysis = new EffectFactory().makeEffect("Paralysis")!;
        paralysis.setPower(50);
        context.zena.applyEffect(paralysis);
        const buff = new Spell({ spellProperties: getSpellConfig("System", "Dual Strike Charm"), amount: 1 });
        buff.setPower(50);
        context.zena.applyBuff(buff);
        const visible = createVisibleDamage(context.primary);
        setDeterministicRandomSource(() => 0);

        processDoubleShotAbility(
            context.zena,
            context.primary,
            [context.primary],
            new SceneLogMock(),
            context.unitsHolder,
            context.grid,
            1,
            context.primary.getPosition(),
            visible,
            context.damageStatisticHolder,
            false,
        );

        expect(visible.chakramFlights?.[0].splash).toEqual([
            expect.objectContaining({ unitId: context.primary.getId(), amount: 75 }),
            expect.objectContaining({ unitId: wide.getId(), amount: 37 }),
        ]);
    });
});

describe("Crafted Chakram second-throw cancellation", () => {
    for (const isAOE of [false, true]) {
        for (const reason of ["dead shooter", "dead primary", "stunned", "forced target", "empty quiver"] as const) {
            it(`emits no disc or miss roll for ${reason} with the area flag ${isAOE}`, () => {
                const context = setup({
                    abilities: ["Chakram", "Crafted Double Shot", "Area Throw"],
                    rangeShots: reason === "empty quiver" ? 0 : 8,
                });
                const sceneLog = new SceneLogMock();
                if (reason === "dead shooter") context.zena.applyDamage(INITIAL_HP, 0, sceneLog);
                if (reason === "dead primary") context.primary.applyDamage(INITIAL_HP, 0, sceneLog);
                if (reason === "stunned") context.zena.applyEffect(new EffectFactory().makeEffect("Stun")!);
                if (reason === "forced target") context.zena.setTarget("another target");
                const visible = createVisibleDamage(context.primary);
                let rolls = 0;
                context.zena.calculateMissChance = () => {
                    rolls += 1;
                    return 0;
                };

                const result = processDoubleShotAbility(
                    context.zena,
                    context.primary,
                    [context.primary],
                    sceneLog,
                    context.unitsHolder,
                    context.grid,
                    1,
                    context.primary.getPosition(),
                    visible,
                    context.damageStatisticHolder,
                    isAOE,
                );

                expect(result.applied).toBe(false);
                expect(result.animationData).toEqual([]);
                expect(result.perUnitDamage).toEqual([]);
                expect(visible.chakramFlights ?? []).toEqual([]);
                expect(rolls).toBe(0);
            });
        }
    }

    it("reports a dodged primary as an actual missed second disc with one arrow spent", () => {
        const context = setup();
        const visible = createVisibleDamage(context.primary);
        let rolls = 0;
        context.zena.calculateMissChance = () => {
            rolls += 1;
            return 100;
        };
        setDeterministicRandomSource(() => 0);

        const result = processDoubleShotAbility(
            context.zena,
            context.primary,
            [context.primary],
            new SceneLogMock(),
            context.unitsHolder,
            context.grid,
            1,
            context.primary.getPosition(),
            visible,
            context.damageStatisticHolder,
            false,
        );

        expect(result.applied).toBe(false);
        expect(result.aoeRangeAttackLanded).toBe(true);
        expect(result.animationData).toHaveLength(1);
        expect(context.zena.getRangeShots()).toBe(7);
        expect(rolls).toBe(1);
        expect(visible.chakramFlights).toEqual([
            {
                attackerId: context.zena.getId(),
                primaryTargetId: context.primary.getId(),
                response: false,
                hitIndex: 1,
                missed: true,
                arcs: [],
                splash: [expect.objectContaining({ unitId: context.primary.getId(), amount: 0, missed: true })],
            },
        ]);
    });
});
