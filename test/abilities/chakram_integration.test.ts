import { describe, expect, it } from "bun:test";

import { resolveChakramTrajectory } from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

const GREEN = PBTypes.TeamVals.LEFT;
const RED = PBTypes.TeamVals.RIGHT;
const INITIAL_HP = 300;

function packedRectangleSetup(width: number, height: number, team: TeamType, primaryIsShooter = false) {
    const context = createCombatTestContext();
    const zena = createTestUnit({
        name: "Zena",
        team,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: ["Chakram"],
        stackPower: 5,
        amountAlive: 3,
        maxHp: 100,
    });
    const victimTeam = team === GREEN ? RED : GREEN;
    const primary = createTestUnit({
        name: "Primary",
        team: victimTeam,
        footprintWidth: width,
        footprintHeight: height,
        ...(primaryIsShooter ? { attackType: PBTypes.AttackVals.RANGE, rangeShots: 8 } : {}),
        amountAlive: 3,
        maxHp: 100,
    });
    const touching = createTestUnit({
        name: "Touching",
        team: victimTeam,
        footprintWidth: width,
        footprintHeight: height,
        amountAlive: 3,
        maxHp: 100,
    });
    placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: team === GREEN ? 2 : 14 });
    placeUnit(context.grid, context.unitsHolder, primary, { x: 8, y: 8 });
    placeUnit(context.grid, context.unitsHolder, touching, width === 1 ? { x: 9, y: 8 } : { x: 8, y: 9 });
    zena.calculateAttackDamage = () => 10;
    return { ...context, zena, primary, touching };
}

describe("Zena's Chakram — packed rectangle damage integration", () => {
    for (const [width, height] of [
        [1, 2],
        [2, 1],
    ]) {
        for (const team of [GREEN, RED]) {
            for (const missed of [true, false]) {
                it(`${width}x${height}, team ${team}: reuses the primary ${missed ? "miss" : "hit"} when touching units prevent every bounce`, () => {
                    const context = packedRectangleSetup(width, height, team);
                    const planned = resolveChakramTrajectory(
                        context.zena,
                        context.primary,
                        context.unitsHolder,
                        context.grid,
                    );
                    expect(planned.hitUnits).toEqual([]);
                    expect(planned.steps).toEqual([]);
                    let missRolls = 0;
                    // If the AOE tail incorrectly rerolls the primary, its verdict is the opposite.
                    context.zena.calculateMissChance = () =>
                        ++missRolls === 1 ? (missed ? 100 : 0) : missed ? 0 : 100;
                    const visible = createVisibleDamage(context.primary);
                    let randomDraws = 0;
                    setDeterministicRandomSource(() => {
                        randomDraws += 1;
                        return 0;
                    });
                    try {
                        const result = context.attackHandler.handleRangeAttack(
                            context.unitsHolder,
                            [1],
                            1,
                            visible,
                            context.zena,
                            [[context.primary]],
                            undefined,
                            context.primary.getPosition(),
                        );
                        expect(result.completed).toBe(true);
                    } finally {
                        setDeterministicRandomSource(undefined);
                    }
                    expect(context.primary.getCumulativeHp()).toBe(INITIAL_HP - (missed ? 0 : 10));
                    expect(missRolls).toBe(1);
                    // The shared RNG combines two source draws for one miss roll.
                    expect(randomDraws).toBe(2);
                    expect(context.touching.getCumulativeHp()).toBe(INITIAL_HP);
                    expect(visible.chakramArcs ?? []).toEqual([]);
                    expect(visible.splash).toEqual([
                        expect.objectContaining({
                            unitId: context.primary.getId(),
                            amount: missed ? 0 : 10,
                            ...(missed ? { missed: true } : {}),
                        }),
                    ]);
                    expect(visible.chakramFlights).toEqual([
                        {
                            attackerId: context.zena.getId(),
                            primaryTargetId: context.primary.getId(),
                            response: false,
                            hitIndex: 0,
                            missed,
                            arcs: [],
                            splash: visible.splash,
                        },
                    ]);
                });
            }
        }
    }

    for (const missed of [true, false]) {
        it(`${missed ? "drops" : "retains"} a shield-only terminal arc according to the primary verdict`, () => {
            const context = createCombatTestContext();
            const zena = createTestUnit({
                name: "Zena",
                team: GREEN,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 8,
                abilities: ["Chakram"],
                stackPower: 5,
            });
            const primary = createTestUnit({
                name: "Primary",
                team: RED,
                footprintWidth: 1,
                footprintHeight: 2,
                amountAlive: 3,
                maxHp: 100,
            });
            const angel = createTestUnit({
                name: "Angel",
                team: RED,
                abilities: ["Arrows Wingshield Blessing"],
                amountAlive: 3,
                maxHp: 100,
            });
            placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: 2 });
            placeUnit(context.grid, context.unitsHolder, primary, { x: 8, y: 8 });
            placeUnit(context.grid, context.unitsHolder, angel, { x: 8, y: 10 });
            const planned = resolveChakramTrajectory(zena, primary, context.unitsHolder, context.grid);
            expect(planned.hitUnits).toEqual([]);
            expect(planned.steps).toHaveLength(1);
            expect(planned.steps[0].hitUnitIds).toEqual([]);
            zena.calculateAttackDamage = () => 10;
            let missRolls = 0;
            zena.calculateMissChance = () => (++missRolls === 1 ? (missed ? 100 : 0) : missed ? 0 : 100);
            const visible = createVisibleDamage(primary);
            let randomDraws = 0;
            setDeterministicRandomSource(() => {
                randomDraws += 1;
                return 0;
            });
            try {
                const result = context.attackHandler.handleRangeAttack(
                    context.unitsHolder,
                    [1],
                    1,
                    visible,
                    zena,
                    [[primary]],
                    undefined,
                    primary.getPosition(),
                );
                expect(result.completed).toBe(true);
            } finally {
                setDeterministicRandomSource(undefined);
            }
            expect(visible.chakramArcs ?? []).toHaveLength(missed ? 0 : 1);
            expect(primary.getCumulativeHp()).toBe(INITIAL_HP - (missed ? 0 : 10));
            expect(angel.getCumulativeHp()).toBe(INITIAL_HP);
            expect(missRolls).toBe(1);
            expect(randomDraws).toBe(2);
        });
    }

    for (const missed of [true, false]) {
        it(`reuses a counter-throw's primary ${missed ? "miss" : "hit"} when its victim is beside another rectangle`, () => {
            const context = packedRectangleSetup(1, 2, RED, true);
            const shooter = context.primary;
            // This time Zena answers a ranged attack. The touching rectangle is on the shooter's team.
            shooter.calculateMissChance = () => 0;
            shooter.calculateAttackDamage = () => 10;
            let missRolls = 0;
            context.zena.calculateMissChance = () => (++missRolls === 1 ? (missed ? 100 : 0) : missed ? 0 : 100);
            const visible = createVisibleDamage(context.zena);
            let randomDraws = 0;
            setDeterministicRandomSource(() => {
                randomDraws += 1;
                return 0;
            });
            try {
                const result = context.attackHandler.handleRangeAttack(
                    context.unitsHolder,
                    [1],
                    1,
                    visible,
                    shooter,
                    [[context.zena]],
                    [shooter],
                    context.zena.getPosition(),
                );
                expect(result.completed).toBe(true);
            } finally {
                setDeterministicRandomSource(undefined);
            }
            expect(context.zena.getCumulativeHp()).toBe(INITIAL_HP - 10);
            expect(shooter.getCumulativeHp()).toBe(INITIAL_HP - (missed ? 0 : 10));
            expect(context.touching.getCumulativeHp()).toBe(INITIAL_HP);
            expect(missRolls).toBe(1);
            expect(randomDraws).toBe(4);
            expect(visible.chakramArcs ?? []).toEqual([]);
            expect(visible.splash).toEqual([
                expect.objectContaining({ unitId: context.zena.getId(), amount: 10, unitsDied: 0 }),
                expect.objectContaining({
                    unitId: shooter.getId(),
                    amount: missed ? 0 : 10,
                    unitsDied: 0,
                    ...(missed ? { missed: true } : {}),
                }),
            ]);
            expect(visible.chakramFlights).toEqual([
                {
                    attackerId: context.zena.getId(),
                    primaryTargetId: shooter.getId(),
                    response: true,
                    hitIndex: 0,
                    missed,
                    arcs: [],
                    splash: visible.splash?.slice(1),
                },
            ]);
        });
    }
});

function counterThrow(context: ReturnType<typeof packedRectangleSetup>) {
    const visible = createVisibleDamage(context.zena);
    setDeterministicRandomSource(() => 0);
    try {
        const result = context.attackHandler.handleRangeAttack(
            context.unitsHolder,
            [1],
            1,
            visible,
            context.primary,
            [[context.zena]],
            [context.primary],
            context.zena.getPosition(),
        );
        expect(result.completed).toBe(true);
        return { result, visible };
    } finally {
        setDeterministicRandomSource(undefined);
    }
}

describe("Zena's Chakram — counter-throw damage payload", () => {
    for (let stackPower = 1; stackPower <= 5; stackPower += 1) {
        it(`preserves the initiating arrow and every counter victim at the ${stackPower}-target cap`, () => {
            const context = packedRectangleSetup(1, 2, RED, true);
            // setStackPower accepts the live tier without rebuilding the stack's base stats.
            context.zena.setStackPower(stackPower);
            const moveTo = (unit: typeof context.primary, anchor: { x: number; y: number }) => {
                context.grid.cleanupAll(unit.getId());
                placeUnit(context.grid, context.unitsHolder, unit, anchor);
            };
            moveTo(context.zena, { x: 8, y: 0 });
            moveTo(context.primary, { x: 8, y: 4 });
            moveTo(context.touching, { x: 1, y: 14 });
            const victims = [context.primary];
            for (const [index, anchor] of [
                { x: 8, y: 7 },
                { x: 8, y: 10 },
                { x: 8, y: 13 },
                { x: 10, y: 13 },
            ].entries()) {
                const victim = createTestUnit({
                    name: `Counter victim ${index + 1}`,
                    team: GREEN,
                    footprintWidth: 1,
                    footprintHeight: 2,
                    amountAlive: 3,
                    maxHp: 100,
                });
                placeUnit(context.grid, context.unitsHolder, victim, anchor);
                victims.push(victim);
            }
            context.primary.calculateMissChance = context.zena.calculateMissChance = () => 0;
            context.primary.calculateAttackDamage = () => 10;

            const { visible } = counterThrow(context);

            expect(visible.splash?.map((entry) => entry.unitId)).toEqual([
                context.zena.getId(),
                ...victims.slice(0, stackPower).map((unit) => unit.getId()),
            ]);
            expect(visible.splash?.map((entry) => entry.amount)).toEqual(Array(stackPower + 1).fill(10));
            expect(visible.chakramArcs ?? []).toHaveLength(stackPower - 1);
            expect(visible.chakramFlights).toEqual([
                {
                    attackerId: context.zena.getId(),
                    primaryTargetId: context.primary.getId(),
                    response: true,
                    hitIndex: 0,
                    missed: false,
                    arcs: visible.chakramArcs ?? [],
                    splash: visible.splash?.slice(1),
                },
            ]);
            for (const [index, victim] of victims.entries()) {
                expect(victim.getCumulativeHp()).toBe(INITIAL_HP - (index < stackPower ? 10 : 0));
            }
        });
    }

    it("keeps both Zenas' initiating and counter splashes exactly once", () => {
        const context = packedRectangleSetup(1, 2, RED, true);
        context.primary.grantAbility("Chakram");
        context.primary.setStackPower(5);
        const enemyBounce = createTestUnit({ name: "Red bounce", team: RED, amountAlive: 3, maxHp: 100 });
        const allyBounce = createTestUnit({ name: "Green bounce", team: GREEN, amountAlive: 3, maxHp: 100 });
        placeUnit(context.grid, context.unitsHolder, enemyBounce, { x: 6, y: 14 });
        placeUnit(context.grid, context.unitsHolder, allyBounce, { x: 6, y: 8 });
        context.primary.calculateMissChance = context.zena.calculateMissChance = () => 0;
        context.primary.calculateAttackDamage = () => 10;

        const { visible } = counterThrow(context);

        expect(visible.splash?.map((entry) => entry.unitId)).toEqual([
            context.zena.getId(),
            enemyBounce.getId(),
            context.primary.getId(),
            allyBounce.getId(),
        ]);
        expect(visible.splash?.map((entry) => entry.amount)).toEqual([10, 10, 10, 10]);
        expect(visible.chakramArcs).toHaveLength(2);
        expect(visible.chakramFlights).toEqual([
            {
                attackerId: context.primary.getId(),
                primaryTargetId: context.zena.getId(),
                response: false,
                hitIndex: 0,
                missed: false,
                arcs: visible.chakramArcs?.slice(0, 1),
                splash: visible.splash?.slice(0, 2),
            },
            {
                attackerId: context.zena.getId(),
                primaryTargetId: context.primary.getId(),
                response: true,
                hitIndex: 0,
                missed: false,
                arcs: visible.chakramArcs?.slice(1),
                splash: visible.splash?.slice(2),
            },
        ]);
    });

    for (const missed of [true, false]) {
        it(`preserves both primary numbers with a ${missed ? "dodged" : "landed"} shield-only counter flight`, () => {
            const context = packedRectangleSetup(1, 2, RED, true);
            const angel = createTestUnit({
                name: "Angel",
                team: GREEN,
                abilities: ["Arrows Wingshield Blessing"],
                amountAlive: 3,
                maxHp: 100,
            });
            placeUnit(context.grid, context.unitsHolder, angel, { x: 8, y: 10 });
            context.primary.calculateMissChance = () => 0;
            context.primary.calculateAttackDamage = () => 10;
            context.zena.calculateMissChance = () => (missed ? 100 : 0);

            const { visible } = counterThrow(context);

            expect(visible.splash).toEqual([
                expect.objectContaining({ unitId: context.zena.getId(), amount: 10 }),
                expect.objectContaining({
                    unitId: context.primary.getId(),
                    amount: missed ? 0 : 10,
                    ...(missed ? { missed: true } : {}),
                }),
            ]);
            expect(visible.chakramArcs ?? []).toHaveLength(missed ? 0 : 1);
            expect(angel.getCumulativeHp()).toBe(INITIAL_HP);
        });
    }

    it("finalizes both hits when a lethal counter cancels Double Shot", () => {
        const context = packedRectangleSetup(1, 2, RED, true);
        context.primary.grantAbility("Double Shot");
        context.primary.calculateMissChance = context.zena.calculateMissChance = () => 0;
        context.primary.calculateAttackDamage = () => 10;
        context.zena.calculateAttackDamage = () => 1000;

        const { result, visible } = counterThrow(context);

        expect(context.primary.isDead()).toBe(true);
        expect(result.unitIdsDied).toContain(context.primary.getId());
        expect(visible.splash).toEqual([
            expect.objectContaining({ unitId: context.zena.getId(), amount: 10, unitsDied: 0 }),
            expect.objectContaining({ unitId: context.primary.getId(), amount: INITIAL_HP, unitsDied: 3 }),
        ]);
        expect(result.animationData).toHaveLength(2);
    });

    it("preserves the initiating kill and prior counter when the dead target cancels Double Shot", () => {
        const context = packedRectangleSetup(1, 2, RED, true);
        context.primary.grantAbility("Double Shot");
        context.primary.calculateMissChance = context.zena.calculateMissChance = () => 0;
        context.primary.calculateAttackDamage = () => 1000;

        const { result, visible } = counterThrow(context);

        expect(context.zena.isDead()).toBe(true);
        expect(result.unitIdsDied).toContain(context.zena.getId());
        expect(visible.splash).toEqual([
            expect.objectContaining({ unitId: context.zena.getId(), amount: INITIAL_HP, unitsDied: 3 }),
            expect.objectContaining({ unitId: context.primary.getId(), amount: 10, unitsDied: 0 }),
        ]);
        expect(result.animationData).toHaveLength(2);
    });

    for (const firstMissed of [false, true]) {
        it(`preserves both initiating arrows when the first ${firstMissed ? "misses" : "hits"} and the second hits`, () => {
            const context = packedRectangleSetup(1, 2, RED, true);
            context.primary.grantAbility("Double Shot");
            let shooterMissRolls = 0;
            context.primary.calculateMissChance = () => (++shooterMissRolls === 1 && firstMissed ? 100 : 0);
            context.primary.calculateAttackDamage = () => 10;
            context.zena.calculateMissChance = () => 0;

            const { visible } = counterThrow(context);

            expect(visible.splash).toEqual([
                expect.objectContaining({
                    unitId: context.zena.getId(),
                    amount: firstMissed ? 0 : 10,
                    ...(firstMissed ? { missed: true } : {}),
                }),
                expect.objectContaining({ unitId: context.zena.getId(), amount: 10 }),
                expect.objectContaining({ unitId: context.primary.getId(), amount: 10 }),
            ]);
            expect(context.zena.getCumulativeHp()).toBe(INITIAL_HP - (firstMissed ? 10 : 20));
            expect(shooterMissRolls).toBe(2);
        });
    }
});
