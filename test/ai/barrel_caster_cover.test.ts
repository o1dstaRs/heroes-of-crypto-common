import { expect, test } from "bun:test";
import { planBarrelCasterCover, type IBarrelCasterCoverContext } from "../../src/ai/barrel_caster_cover";
import type { XY } from "../../src/utils/math";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getCellForPosition, getRangeAttackSideCenter, RANGE_ATTACK_CELL_SIDES } from "../../src/grid/grid_math";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const context = (): IBarrelCasterCoverContext => ({
    gridSize: 16,
    sideOriented: true,
    forwardSign: 1,
    allowedCells: Array.from({ length: 16 }, (_, y) => Array.from({ length: 4 }, (_, x) => ({ x, y }))).flat(),
    occupiedCells: [{ x: 1, y: 10 }],
    ownStacks: [{ cells: [{ x: 1, y: 10 }], spellcaster: true, blocksRangedShots: false, value: 100 }],
});

for (const sideOriented of [true, false]) {
    for (const sign of [1, -1] as const) {
        for (const [width, height] of [
            [1, 1],
            [1, 2],
            [2, 1],
            [2, 2],
        ]) {
            test(`caster cover uses the full ${width}x${height} body on ${sideOriented ? "side" : "classic"} axis, sign ${sign}`, () => {
                const transform = (cell: XY) => {
                    const forward = sign === 1 ? cell.x : 15 - cell.x;
                    return sideOriented ? { x: forward, y: cell.y } : { x: cell.y, y: forward };
                };
                const original = context();
                const body = Array.from({ length: height }, (_, y) =>
                    Array.from({ length: width }, (_, x) => ({ x: 1 + x, y: 8 + y })),
                ).flat();
                const input = {
                    ...original,
                    sideOriented,
                    forwardSign: sign,
                    allowedCells: original.allowedCells.map(transform),
                    occupiedCells: body.map(transform),
                    ownStacks: [{ ...original.ownStacks[0], cells: body.map(transform) }],
                };
                const before = structuredClone(input);
                const plan = planBarrelCasterCover(input)!;
                expect(plan).toHaveLength(2);
                const allowed = new Set(input.allowedCells.map((cell) => `${cell.x},${cell.y}`));
                expect(new Set(plan.map((cell) => `${cell.x},${cell.y}`)).size).toBe(2);
                for (const cell of plan) {
                    expect(allowed.has(`${cell.x},${cell.y}`)).toBe(true);
                    expect(input.occupiedCells).not.toContainEqual(cell);
                    const f = sideOriented ? cell.x : cell.y;
                    expect(sign === 1 ? f : 15 - f).toBe(1 + width);
                }
                expect(input).toEqual(before);
            });
        }
    }
}

test("friendly shooters' possible opening shots take precedence over caster cover", () => {
    const c = context();
    const shooter = { cells: [{ x: 1, y: 8 }], spellcaster: false, blocksRangedShots: true, value: 100 };
    expect(
        planBarrelCasterCover({
            ...c,
            ownStacks: [...c.ownStacks, shooter],
            occupiedCells: [...c.occupiedCells, ...shooter.cells],
        }),
    ).toBeUndefined();
    const farShooter = { ...shooter, cells: [{ x: 1, y: 1 }] };
    expect(
        planBarrelCasterCover({
            ...c,
            ownStacks: [...c.ownStacks, farShooter],
            occupiedCells: [...c.occupiedCells, ...farShooter.cells],
        }),
    ).toHaveLength(2);
});

test("no caster, a full front, or only one safe free cell keeps stock deployment", () => {
    const c = context();
    expect(planBarrelCasterCover({ ...c, ownStacks: [{ ...c.ownStacks[0], spellcaster: false }] })).toBeUndefined();
    expect(
        planBarrelCasterCover({
            ...c,
            occupiedCells: [...c.occupiedCells, { x: 2, y: 9 }, { x: 2, y: 10 }, { x: 2, y: 11 }],
        }),
    ).toBeUndefined();
    expect(planBarrelCasterCover({ ...c, allowedCells: [{ x: 2, y: 10 }] })).toBeUndefined();
});

test("two barrels protect the more valuable caster without changing the army formation", () => {
    const c = context();
    const minor = { ...c.ownStacks[0], cells: [{ x: 1, y: 3 }], value: 10 };
    const plan = planBarrelCasterCover({
        ...c,
        ownStacks: [minor, ...c.ownStacks],
        occupiedCells: [...c.occupiedCells, ...minor.cells],
    })!;
    expect(plan.every((cell) => cell.y >= 9 && cell.y <= 11)).toBe(true);
});

for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT] as const) {
    for (const [width, height] of [
        [1, 1],
        [1, 2],
        [2, 1],
        [2, 2],
    ]) {
        test(`opening cone preserves actual engine rays for a ${width}x${height} friendly shooter, team ${team}`, () => {
            const c = createCombatTestContext();
            const other = team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
            const shooter = createTestUnit({
                team,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 5,
                size: width === 1 && height === 1 ? 1 : 2,
                footprintWidth: width,
                footprintHeight: height,
            });
            const caster = createTestUnit({ team });
            const enemy = createTestUnit({ team: other });
            placeUnit(c.grid, c.unitsHolder, shooter, { x: team === PBTypes.TeamVals.LEFT ? 1 : 14 + width - 1, y: 1 });
            placeUnit(c.grid, c.unitsHolder, caster, { x: team === PBTypes.TeamVals.LEFT ? 1 : 14, y: 10 });
            const allowedCells = Array.from({ length: 16 }, (_, y) =>
                Array.from({ length: 4 }, (_, x) => ({ x: team === PBTypes.TeamVals.LEFT ? x : 15 - x, y })),
            ).flat();
            const plan = planBarrelCasterCover({
                gridSize: 16,
                sideOriented: true,
                forwardSign: team === PBTypes.TeamVals.LEFT ? 1 : -1,
                allowedCells,
                occupiedCells: [...shooter.getCells(), ...caster.getCells()],
                ownStacks: [
                    { cells: shooter.getCells(), spellcaster: false, blocksRangedShots: true, value: 100 },
                    { cells: caster.getCells(), spellcaster: true, blocksRangedShots: false, value: 100 },
                ],
            })!;
            expect(plan).toHaveLength(2);
            plan.forEach((cell, index) => expect(c.grid.placeArtifactBarrel(team, index, cell)).toBe(true));
            const barrelKeys = new Set(plan.map((cell) => `${cell.x},${cell.y}`));
            for (let depth = 8; depth < 16; depth++) {
                for (let y = 0; y < 16; y++) {
                    const cell = { x: team === PBTypes.TeamVals.LEFT ? depth : 15 - depth, y };
                    c.grid.cleanupAll(enemy.getId(), enemy.getAttackRange(), enemy.isSmallSize());
                    placeUnit(c.grid, c.unitsHolder, enemy, cell);
                    for (const side of RANGE_ATTACK_CELL_SIDES) {
                        const aim = getRangeAttackSideCenter(c.grid.getSettings(), cell, side, shooter.getPosition());
                        const projection = c.attackHandler.evaluateRangeAttack(
                            c.unitsHolder.getAllUnits(),
                            shooter,
                            shooter.getPosition(),
                            aim,
                            false,
                            false,
                            false,
                        );
                        const blocked =
                            projection.attackObstacle &&
                            getCellForPosition(c.grid.getSettings(), projection.attackObstacle.position);
                        expect(blocked && barrelKeys.has(`${blocked.x},${blocked.y}`)).not.toBe(true);
                    }
                }
            }
        });
    }
}
