import { describe, expect, it } from "bun:test";

import { chakramSeparation, resolveChakramTrajectory } from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const SHAPES = [
    { label: "1x1", width: 1, height: 1 },
    { label: "1x2", width: 1, height: 2 },
    { label: "2x1", width: 2, height: 1 },
    { label: "2x2", width: 2, height: 2 },
] as const;
const DIRECTIONS = [
    { label: "east", x: 1, y: 0 },
    { label: "north-east", x: 1, y: 1 },
    { label: "north", x: 0, y: 1 },
    { label: "north-west", x: -1, y: 1 },
    { label: "west", x: -1, y: 0 },
    { label: "south-west", x: -1, y: -1 },
    { label: "south", x: 0, y: -1 },
    { label: "south-east", x: 1, y: -1 },
] as const;

function setup(attackerTeam: PBTypes.TeamVals = PBTypes.TeamVals.LEFT) {
    const context = createCombatTestContext();
    const zena = createTestUnit({ name: "Zena", team: attackerTeam, abilities: ["Chakram"], stackPower: 5 });
    placeUnit(context.grid, context.unitsHolder, zena, { x: 1, y: 1 });
    return { ...context, zena };
}

function stand(
    context: ReturnType<typeof setup>,
    name: string,
    anchor: XY,
    width: number,
    height: number,
    ally = false,
): Unit {
    const team = ally
        ? context.zena.getTeam()
        : context.zena.getTeam() === PBTypes.TeamVals.LEFT
          ? PBTypes.TeamVals.RIGHT
          : PBTypes.TeamVals.LEFT;
    const unit = createTestUnit({ name, team, footprintWidth: width, footprintHeight: height });
    placeUnit(context.grid, context.unitsHolder, unit, anchor);
    for (const cell of unit.getCells()) {
        expect(context.grid.getOccupantUnitId(cell)).toBe(unit.getId());
    }
    return unit;
}

describe("Chakram rectangular footprint adjacency and reach", () => {
    for (const a of SHAPES) {
        for (const b of SHAPES) {
            for (const direction of DIRECTIONS) {
                for (const separation of [1, 2, 3, 4]) {
                    it(`${a.label} to ${b.label}, ${direction.label}, separation ${separation}`, () => {
                        // The rectangle's anchor is its top-right cell. Move the near EDGES apart by
                        // separation cells, independently of the implementation's cell-pair metric.
                        const anchor = {
                            x:
                                direction.x > 0
                                    ? 8 + separation + b.width - 1
                                    : direction.x < 0
                                      ? 8 - a.width + 1 - separation
                                      : 8,
                            y:
                                direction.y > 0
                                    ? 8 + separation + b.height - 1
                                    : direction.y < 0
                                      ? 8 - a.height + 1 - separation
                                      : 8,
                        };
                        // Mirroring the attacker team must not change geometry. Both primary choices
                        // matter: a rectangle's far anchor must not become a fake gap when it is struck.
                        for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                            const context = setup(team);
                            const first = stand(context, "First", { x: 8, y: 8 }, a.width, a.height);
                            const second = stand(context, "Second", anchor, b.width, b.height);
                            expect(chakramSeparation(first, second)).toBe(separation);
                            expect(chakramSeparation(second, first)).toBe(separation);
                            for (const [primary, candidate] of [
                                [first, second],
                                [second, first],
                            ]) {
                                const flight = resolveChakramTrajectory(
                                    context.zena,
                                    primary,
                                    context.unitsHolder,
                                    context.grid,
                                );
                                const eligible = separation === 2 || separation === 3;
                                expect(flight.hitUnits.map((unit) => unit.getId())).toEqual(
                                    eligible ? [candidate.getId()] : [],
                                );
                                expect(flight.damageFactorByUnitId).toEqual(
                                    eligible ? { [candidate.getId()]: separation === 2 ? 1 : 0.5 } : {},
                                );
                                expect(flight.hitUnits).not.toContain(primary);
                                expect(
                                    resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid),
                                ).toEqual(flight);
                            }
                        }
                    });
                }
            }
        }
    }

    for (const shape of SHAPES) {
        it(`a solid 3x3 formation of ${shape.label} bodies never relays from any selected primary`, () => {
            const context = setup();
            const army: Unit[] = [];
            for (let x = -1; x <= 1; x += 1) {
                for (let y = -1; y <= 1; y += 1) {
                    army.push(
                        stand(
                            context,
                            `${x}:${y}`,
                            { x: 8 + x * shape.width, y: 8 + y * shape.height },
                            shape.width,
                            shape.height,
                        ),
                    );
                }
            }
            for (const primary of army) {
                const flight = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
                expect(flight.hitUnits).toEqual([]);
                expect(flight.steps).toEqual([]);
            }
        });
    }
});

function transform(cell: XY, turns: number, mirrored: boolean): XY {
    let x = cell.x - 8;
    let y = cell.y - 8;
    if (mirrored) {
        x = -x;
    }
    for (let turn = 0; turn < turns; turn += 1) {
        [x, y] = [-y, x];
    }
    return { x: x + 8, y: y + 8 };
}

function standCells(context: ReturnType<typeof setup>, name: string, cells: XY[]): Unit {
    const xs = cells.map((cell) => cell.x);
    const ys = cells.map((cell) => cell.y);
    return stand(
        context,
        name,
        { x: Math.max(...xs), y: Math.max(...ys) },
        Math.max(...xs) - Math.min(...xs) + 1,
        Math.max(...ys) - Math.min(...ys) + 1,
    );
}

describe("Chakram flight follows the empty bridge between rectangular bodies", () => {
    for (const separation of [2, 3]) {
        for (let turns = 0; turns < 4; turns += 1) {
            for (const mirrored of [false, true]) {
                const label = `${separation - 1}-cell gap, rotation ${turns * 90}, mirrored ${mirrored}`;
                it(`flies through the open edge instead of the adjacent blocker: ${label}`, () => {
                    const context = setup();
                    const map = (cell: XY) => transform(cell, turns, mirrored);
                    const primary = standCells(
                        context,
                        "Primary",
                        [
                            { x: 8, y: 8 },
                            { x: 8, y: 7 },
                        ].map(map),
                    );
                    const bounce = standCells(
                        context,
                        "Bounce",
                        [
                            { x: 8 + separation, y: 8 },
                            { x: 8 + separation, y: 7 },
                        ].map(map),
                    );
                    for (let x = 9; x < 8 + separation; x += 1) {
                        stand(context, `Blocker ${x}`, map({ x, y: 8 }), 1, 1, true);
                    }
                    const flight = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
                    expect(flight.hitUnits).toEqual([bounce]);
                    expect(flight.damageFactorByUnitId[bounce.getId()]).toBe(separation === 2 ? 1 : 0.5);
                    expect(flight.steps).toHaveLength(1);
                    const path = [flight.steps[0].fromCell, ...flight.steps[0].circleCells];
                    expect(primary.getCells()).toContainEqual(path[0]);
                    expect(bounce.getCells()).toContainEqual(path.at(-1));
                    // A footprint-edge departure and arrival leave exactly the promised EMPTY links.
                    // Using anchors here used to send the visible disc straight through the blocker,
                    // even though eligibility had found the real gap along the unit's other edge.
                    expect(path.slice(1, -1)).toHaveLength(separation - 1);
                    for (const cell of path.slice(1, -1)) {
                        expect(Boolean(context.grid.getOccupantUnitId(cell))).toBe(false);
                    }
                    for (let index = 1; index < path.length; index += 1) {
                        expect(
                            Math.max(
                                Math.abs(path[index].x - path[index - 1].x),
                                Math.abs(path[index].y - path[index - 1].y),
                            ),
                        ).toBe(1);
                    }
                    expect(resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid)).toEqual(
                        flight,
                    );
                    // Fill the remaining edge: the same footprint geometry is now a wall, so neither
                    // selecting the near nor the far rectangle may bounce through it.
                    for (let x = 9; x < 8 + separation; x += 1) {
                        stand(context, `Closing blocker ${x}`, map({ x, y: 7 }), 1, 1, true);
                    }
                    for (const target of [primary, bounce]) {
                        expect(
                            resolveChakramTrajectory(context.zena, target, context.unitsHolder, context.grid).hitUnits,
                        ).toEqual([]);
                    }
                });
            }
        }
    }
});
