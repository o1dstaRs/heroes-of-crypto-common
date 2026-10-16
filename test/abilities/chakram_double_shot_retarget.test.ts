import { afterEach, describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));

function setup(team: TeamType, transposed: boolean) {
    const context = createCombatTestContext();
    const map = (cell: XY): XY => (transposed ? { x: cell.y, y: cell.x } : cell);
    const zena = createTestUnit({
        name: "Zena",
        team,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 8,
        abilities: ["Chakram", "Crafted Double Shot"],
        stackPower: 5,
        amountAlive: 5,
        maxHp: 100,
        exp: 100,
    });
    placeUnit(context.grid, context.unitsHolder, zena, map({ x: 8, y: 2 }));
    zena.calculateMissChance = () => 0;
    zena.calculateAttackDamage = () => 10;
    return { ...context, zena, map, transposed };
}

function enemy(
    context: ReturnType<typeof setup>,
    name: string,
    anchor: XY,
    options: { shooter?: boolean; shield?: boolean; fragile?: boolean } = {},
): Unit {
    const unit = createTestUnit({
        name,
        team: context.zena.getOppositeTeam(),
        footprintWidth: context.transposed ? 2 : 1,
        footprintHeight: context.transposed ? 1 : 2,
        attackType: options.shooter ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: options.shooter ? 8 : 0,
        abilities: options.shield ? ["Arrows Wingshield Blessing"] : [],
        stackPower: 5,
        amountAlive: options.fragile ? 1 : 5,
        maxHp: options.fragile ? 5 : 100,
        exp: 100,
    });
    placeUnit(context.grid, context.unitsHolder, unit, context.map(anchor));
    unit.calculateMissChance = () => 0;
    return unit;
}

function throwDiscs(context: ReturnType<typeof setup>, groups: Unit[][], response?: Unit[]) {
    const visible = createVisibleDamage(groups[0][0]);
    setDeterministicRandomSource(() => 0);
    const result = context.attackHandler.handleRangeAttack(
        context.unitsHolder,
        groups.map((_, index) => index + 1),
        1,
        visible,
        context.zena,
        groups,
        response,
        groups.at(-1)![0].getPosition(),
    );
    expect(result.completed).toBe(true);
    return { visible, result };
}

describe("Chakram second throw follows the live stack and retargeted ray", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const transposed of [false, true]) {
            const shape = transposed ? "2x1" : "1x2";
            it(`${shape}, team ${team}: reduces the second flight's cap after the counter kills four of five Zenas`, () => {
                const context = setup(team, transposed);
                const primary = enemy(context, "Primary", { x: 8, y: 8 }, { shooter: true });
                primary.calculateAttackDamage = () => 400;
                const bounces = [
                    { x: 10, y: 8 },
                    { x: 12, y: 8 },
                    { x: 12, y: 5 },
                    { x: 10, y: 5 },
                ].map((anchor, index) => enemy(context, `Bounce ${index + 1}`, anchor));

                const { visible } = throwDiscs(context, [[primary]], [context.zena]);

                expect(context.zena.getAmountAlive()).toBe(1);
                expect(context.zena.getStackPower()).toBe(1);
                // The refreshed tier also reduces Crafted Double Shot to 20% of this fixture's raw hit.
                expect(primary.getCumulativeHp()).toBe(488);
                for (const bounce of bounces) expect(bounce.getCumulativeHp()).toBe(490);
                const first = visible.chakramFlights?.find((flight) => !flight.response && flight.hitIndex === 0);
                const second = visible.chakramFlights?.find((flight) => !flight.response && flight.hitIndex === 1);
                expect(first?.splash.map((hit) => hit.unitId).sort()).toEqual(
                    [primary, ...bounces].map((unit) => unit.getId()).sort(),
                );
                expect(second?.primaryTargetId).toBe(primary.getId());
                expect(second?.splash.map((hit) => hit.unitId)).toEqual([primary.getId()]);
                expect(second?.splash[0].amount).toBe(2);
                expect(second?.arcs).toEqual([]);
                expect(visible.chakramFlights).toHaveLength(2);
            });

            for (const shield of [false, true]) {
                it(`${shape}, team ${team}: replans around the next live ray screen after the first primary dies${shield ? ", stopping at its shielded neighbour" : ""}`, () => {
                    const context = setup(team, transposed);
                    const primary = enemy(context, "Fragile primary", { x: 8, y: 6 }, { fragile: true });
                    const originalBounce = enemy(context, "Original bounce", { x: 10, y: 6 });
                    const screen = enemy(context, "Next ray screen", { x: 8, y: 12 });
                    const nextBounce = enemy(context, "Next bounce", { x: 10, y: 12 }, { shield });

                    const { visible, result } = throwDiscs(context, [[primary], [screen]]);

                    expect(primary.isDead()).toBe(true);
                    expect(result.unitIdsDied).toContain(primary.getId());
                    expect(originalBounce.getCumulativeHp()).toBe(490);
                    expect(screen.getCumulativeHp()).toBe(490);
                    expect(nextBounce.getCumulativeHp()).toBe(shield ? 500 : 490);
                    expect(result.animationData.map((animation) => animation.affectedUnit?.getId())).toEqual([
                        primary.getId(),
                        screen.getId(),
                    ]);
                    expect(visible.chakramFlights).toHaveLength(2);
                    const second = visible.chakramFlights?.find((flight) => !flight.response && flight.hitIndex === 1);
                    expect(second?.attackerId).toBe(context.zena.getId());
                    expect(second?.primaryTargetId).toBe(screen.getId());
                    expect(second?.missed).toBe(false);
                    expect(second?.splash.map((hit) => hit.unitId)).toEqual(
                        shield ? [screen.getId()] : [screen.getId(), nextBounce.getId()],
                    );
                    expect(second?.arcs).toHaveLength(1);
                    expect(second?.arcs[0].hitUnitIds).toEqual(shield ? [] : [nextBounce.getId()]);
                    expect(second?.splash.some((hit) => hit.unitId === originalBounce.getId())).toBe(false);
                });
            }
        }
    }
});
