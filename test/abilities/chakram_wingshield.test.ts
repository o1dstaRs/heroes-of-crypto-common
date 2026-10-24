import { afterEach, describe, expect, it } from "bun:test";

import { resolveChakramTrajectory } from "../../src/abilities/chakram_ability";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

const WINGSHIELD = "Arrows Wingshield Blessing";
afterEach(() => setDeterministicRandomSource(undefined));

function setup(team: TeamType, extraAbilities: string[] = [], counter = false) {
    const context = createCombatTestContext();
    const zena = createTestUnit({
        name: "Zena",
        team,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: ["Chakram", ...extraAbilities],
        amountAlive: 5,
        maxHp: 100,
        exp: 100,
        stackPower: 5,
    });
    const angel = createTestUnit({
        name: "Angel",
        team: zena.getOppositeTeam(),
        abilities: [WINGSHIELD],
        size: PBTypes.UnitSizeVals.LARGE,
        amountAlive: 5,
        maxHp: 100,
        attackType: counter ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: counter ? 8 : 0,
    });
    const next = createTestUnit({ name: "Next", team: angel.getTeam(), amountAlive: 5, maxHp: 100 });
    placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: 2 });
    placeUnit(context.grid, context.unitsHolder, angel, { x: 8, y: 8 });
    placeUnit(context.grid, context.unitsHolder, next, { x: 8, y: 10 });
    zena.calculateAttackDamage = angel.calculateAttackDamage = () => 20;
    zena.calculateMissChance = angel.calculateMissChance = () => 0;
    return { ...context, zena, angel, next };
}

describe("Chakram aimed at an active Wingshield owner", () => {
    it("stops the hover trajectory at the primary Angel, but permits bounces when Break disables the shield", () => {
        const f = setup(PBTypes.TeamVals.LEFT);
        expect(resolveChakramTrajectory(f.zena, f.angel, f.unitsHolder, f.grid)).toEqual({
            steps: [],
            hitUnits: [],
            damageFactorByUnitId: {},
            mountainCells: [],
        });
        f.angel.applyEffect(new EffectFactory().makeEffect("Break")!);
        expect(f.angel.hasAbilityActive(WINGSHIELD)).toBe(false);
        expect(resolveChakramTrajectory(f.zena, f.angel, f.unitsHolder, f.grid).hitUnits).toEqual([f.next]);
    });

    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const extra of [[], ["Double Shot"], ["Crafted Double Shot"]]) {
            it(`team ${team}, ${extra[0] ?? "single throw"}: the Angel takes the direct hit and never relays it`, () => {
                const f = setup(team, extra);
                const visible = createVisibleDamage(f.angel);
                setDeterministicRandomSource(() => 0);
                const result = f.attackHandler.handleRangeAttack(
                    f.unitsHolder,
                    [1],
                    1,
                    visible,
                    f.zena,
                    [[f.angel]],
                    undefined,
                    f.angel.getPosition(),
                );
                expect(result.completed).toBe(true);
                expect(f.angel.getCumulativeHp()).toBeLessThan(500);
                expect(f.next.getCumulativeHp()).toBe(500);
                expect(visible.chakramArcs ?? []).toEqual([]);
                expect(visible.chakramFlights).toHaveLength(extra.length ? 2 : 1);
                for (const flight of visible.chakramFlights ?? []) {
                    expect(flight.primaryTargetId).toBe(f.angel.getId());
                    expect(flight.arcs).toEqual([]);
                    expect(flight.splash.map((hit) => hit.unitId)).toEqual([f.angel.getId()]);
                    expect(flight.splash[0].amount).toBeGreaterThan(0);
                }
            });
        }

        it(`team ${team}: a counter-thrown Chakram also stops at the shielded shooter`, () => {
            const f = setup(team, [], true);
            const visible = createVisibleDamage(f.zena);
            setDeterministicRandomSource(() => 0);
            const result = f.attackHandler.handleRangeAttack(
                f.unitsHolder,
                [1],
                1,
                visible,
                f.angel,
                [[f.zena]],
                [f.angel],
                f.zena.getPosition(),
            );
            expect(result.completed).toBe(true);
            expect(f.angel.getCumulativeHp()).toBeLessThan(500);
            expect(f.next.getCumulativeHp()).toBe(500);
            const flight = visible.chakramFlights?.find((entry) => entry.response);
            expect(flight?.primaryTargetId).toBe(f.angel.getId());
            expect(flight?.arcs).toEqual([]);
            expect(flight?.splash.map((hit) => hit.unitId)).toEqual([f.angel.getId()]);
        });
    }
});
