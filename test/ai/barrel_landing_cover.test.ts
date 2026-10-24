import { expect, test } from "bun:test";
import { planBarrelLandingCover, type IBarrelLandingCoverContext } from "../../src/ai/barrel_landing_cover";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getCellForPosition, getRangeAttackSideCenter, RANGE_ATTACK_CELL_SIDES } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function corner(): IBarrelLandingCoverContext {
    return {
        gridSize: 16,
        sideOriented: true,
        forwardSign: 1,
        allowedCells: Array.from({ length: 6 }, (_, y) => Array.from({ length: 4 }, (_, x) => ({ x, y }))).flat(),
        occupiedCells: [{ x: 0, y: 0 }],
        ownStacks: [{ cells: [{ x: 0, y: 0 }], spellcaster: true, blocksRangedShots: false, value: 100 }],
        currentBarrels: [
            { x: 3, y: 4 },
            { x: 3, y: 5 },
        ],
        threats: [{ width: 2, height: 2, weight: 1 }],
        hasLargeFlyingEnemy: true,
    };
}

test("landing cover requires the public flyer/caster population and a strict improvement over existing cover", () => {
    const c = corner();
    expect(planBarrelLandingCover({ ...c, hasLargeFlyingEnemy: false })).toBeUndefined();
    expect(planBarrelLandingCover({ ...c, ownStacks: [{ ...c.ownStacks[0], spellcaster: false }] })).toBeUndefined();
    expect(planBarrelLandingCover({ ...c, threats: [] })).toBeUndefined();
    const plan = planBarrelLandingCover(c)!;
    expect(plan).toHaveLength(2);
    expect(planBarrelLandingCover({ ...c, currentBarrels: plan })).toBeUndefined();
    expect(planBarrelLandingCover({ ...c, allowedCells: [c.allowedCells[0]] })).toBeUndefined();
});

for (const sideOriented of [false, true]) {
    for (const forwardSign of [1, -1] as const) {
        for (const [width, height] of [
            [1, 1],
            [1, 2],
            [2, 1],
            [2, 2],
        ]) {
            test(`landing cover preserves a ${width}x${height} ally and legal cells, side=${sideOriented}, sign=${forwardSign}`, () => {
                const transform = (cell: XY) => {
                    const x = forwardSign === 1 ? cell.x : 15 - cell.x;
                    return sideOriented ? { x, y: cell.y } : { x: cell.y, y: x };
                };
                const c = corner();
                const cells = Array.from({ length: height }, (_, y) =>
                    Array.from({ length: width }, (_, x) => transform({ x, y })),
                ).flat();
                const input = {
                    ...c,
                    sideOriented,
                    forwardSign,
                    allowedCells: c.allowedCells.map(transform),
                    occupiedCells: cells,
                    ownStacks: [{ ...c.ownStacks[0], cells }],
                    currentBarrels: c.currentBarrels.map(transform),
                };
                const before = structuredClone(input);
                const plan = planBarrelLandingCover(input)!;
                expect(plan).toHaveLength(2);
                expect(new Set(plan.map(({ x, y }) => `${x},${y}`)).size).toBe(2);
                for (const cell of plan) {
                    expect(input.allowedCells).toContainEqual(cell);
                    expect(input.occupiedCells).not.toContainEqual(cell);
                }
                expect(input).toEqual(before);
            });
        }
    }
}

for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
    for (const map of [1, 2, 3, 4]) {
        for (const [width, height] of [
            [1, 2],
            [2, 1],
            [2, 2],
        ]) {
            test(`engine denies every ${width}x${height} flyer contact while the protected caster keeps an exit, map=${map}, team=${team}`, () => {
                const c = createCombatTestContext(map);
                const transform = (cell: XY) => (team === PBTypes.TeamVals.LEFT ? cell : { x: 15 - cell.x, y: cell.y });
                const own = createTestUnit({ team });
                const enemy = createTestUnit({
                    team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
                    size: 2,
                    footprintWidth: width,
                    footprintHeight: height,
                    movementType: PBTypes.MovementVals.FLY,
                });
                const origin = transform({ x: 0, y: 0 });
                placeUnit(c.grid, c.unitsHolder, own, origin);
                placeUnit(c.grid, c.unitsHolder, enemy, { x: team === PBTypes.TeamVals.LEFT ? 14 : 2, y: 14 });
                const initial = corner();
                const input = {
                    ...initial,
                    forwardSign: team === PBTypes.TeamVals.LEFT ? (1 as const) : (-1 as const),
                    allowedCells: initial.allowedCells.map(transform),
                    occupiedCells: own.getCells(),
                    ownStacks: [{ ...initial.ownStacks[0], cells: own.getCells() }],
                    currentBarrels: initial.currentBarrels.map(transform),
                    threats: [{ width, height, weight: 1 }],
                };
                const path = new PathHelper(testGridSettings);
                const contacts = () => {
                    const paths = path.getMovePath(
                        enemy.getBaseCell(),
                        c.grid.getMatrix(),
                        64,
                        undefined,
                        true,
                        false,
                        false,
                        false,
                        width,
                        height,
                    );
                    return [...paths.knownPaths.values()]
                        .map((routes) => routes[0].cell)
                        .filter((anchor) => {
                            const cells = Array.from({ length: height }, (_, y) =>
                                Array.from({ length: width }, (_, x) => ({ x: anchor.x - x, y: anchor.y - y })),
                            ).flat();
                            return (
                                c.grid.areAllCellsEmpty(cells) &&
                                cells.some(
                                    (cell) => Math.max(Math.abs(cell.x - origin.x), Math.abs(cell.y - origin.y)) === 1,
                                )
                            );
                        });
                };
                expect(contacts().length).toBeGreaterThan(0);
                const plan = planBarrelLandingCover(input)!;
                expect(plan).toHaveLength(2);
                plan.forEach((cell, index) => expect(c.grid.placeArtifactBarrel(team, index, cell)).toBe(true));
                expect(contacts()).toHaveLength(0);
                expect(path.getMovePath(own.getBaseCell(), c.grid.getMatrix(), 1).cells.length).toBeGreaterThan(0);
            });
        }
    }
}

test("landing cover never seals a previously usable allied exit", () => {
    const c = corner();
    // A single open route through the ward's ring is its only exit; two cells there would seal it.
    const occupiedCells = [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 0 },
    ];
    expect(
        planBarrelLandingCover({
            ...c,
            occupiedCells,
            allowedCells: [
                { x: 1, y: 1 },
                { x: 1, y: 2 },
            ],
            ownStacks: [{ ...c.ownStacks[0], cells: [{ x: 0, y: 0 }] }],
        }),
    ).toBeUndefined();
});

test("landing cover respects friendly physical shooting cones", () => {
    const c = corner();
    const shooter = { cells: [{ x: 0, y: 1 }], spellcaster: false, blocksRangedShots: true, value: 100 };
    const plan = planBarrelLandingCover({
        ...c,
        ownStacks: [...c.ownStacks, shooter],
        occupiedCells: [...c.occupiedCells, ...shooter.cells],
    });
    expect(plan).toHaveLength(2);
    const combat = createCombatTestContext();
    const ranged = createTestUnit({ team: PBTypes.TeamVals.LEFT, attackType: PBTypes.AttackVals.RANGE, rangeShots: 5 });
    const ward = createTestUnit({ team: PBTypes.TeamVals.LEFT });
    const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
    placeUnit(combat.grid, combat.unitsHolder, ward, { x: 0, y: 0 });
    placeUnit(combat.grid, combat.unitsHolder, ranged, { x: 0, y: 1 });
    plan!.forEach((cell, index) =>
        expect(combat.grid.placeArtifactBarrel(PBTypes.TeamVals.LEFT, index, cell)).toBe(true),
    );
    const barrels = new Set(plan!.map(({ x, y }) => `${x},${y}`));
    for (let x = 8; x < 16; x++)
        for (let y = 0; y < 16; y++) {
            combat.grid.cleanupAll(enemy.getId(), enemy.getAttackRange(), enemy.isSmallSize());
            placeUnit(combat.grid, combat.unitsHolder, enemy, { x, y });
            for (const side of RANGE_ATTACK_CELL_SIDES) {
                const aim = getRangeAttackSideCenter(testGridSettings, { x, y }, side, ranged.getPosition());
                const projection = combat.attackHandler.evaluateRangeAttack(
                    combat.unitsHolder.getAllUnits(),
                    ranged,
                    ranged.getPosition(),
                    aim,
                    false,
                    false,
                    false,
                );
                if (projection.attackObstacle) {
                    const hit = getCellForPosition(testGridSettings, projection.attackObstacle.position);
                    expect(barrels.has(`${hit.x},${hit.y}`)).toBe(false);
                } else expect(projection.attackObstacle).toBeUndefined();
            }
        }
});

for (const sideOriented of [false, true])
    for (const forwardSign of [1, -1] as const)
        for (const [width, height] of [
            [2, 1],
            [2, 2],
        ]) {
            test(`landing cover preserves a real ${width}x${height} route at a diagonal corner, side=${sideOriented}, sign=${forwardSign}`, () => {
                const c = createCombatTestContext();
                const transform = (cell: XY) => {
                    const forward = forwardSign === 1 ? cell.x : 15 - cell.x;
                    return sideOriented ? { x: forward, y: cell.y } : { x: cell.y, y: forward };
                };
                const physicalWidth = sideOriented ? width : height;
                const physicalHeight = sideOriented ? height : width;
                const cells = Array.from({ length: height }, (_, y) =>
                    Array.from({ length: width }, (_, x) => transform({ x, y })),
                ).flat();
                const anchor = { x: Math.max(...cells.map((c) => c.x)), y: Math.max(...cells.map((c) => c.y)) };
                const unit = createTestUnit({
                    team: forwardSign === 1 ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT,
                    size: 2,
                    footprintWidth: physicalWidth,
                    footprintHeight: physicalHeight,
                });
                placeUnit(c.grid, c.unitsHolder, unit, anchor);
                const initial = corner();
                const currentBarrels = initial.currentBarrels.map(transform);
                const input = {
                    ...initial,
                    sideOriented,
                    forwardSign,
                    occupiedCells: unit.getCells(),
                    ownStacks: [{ ...initial.ownStacks[0], cells: unit.getCells() }],
                    currentBarrels,
                    allowedCells: [{ x: width, y: 0 }, { x: 0, y: height }, ...initial.currentBarrels].map(transform),
                };
                const path = new PathHelper(testGridSettings);
                const exits = () =>
                    path.getMovePath(
                        unit.getBaseCell(),
                        c.grid.getMatrix(),
                        2,
                        undefined,
                        false,
                        false,
                        false,
                        false,
                        physicalWidth,
                        physicalHeight,
                    ).cells;
                currentBarrels.forEach((cell, index) =>
                    expect(c.grid.placeArtifactBarrel(unit.getTeam(), index, cell)).toBe(true),
                );
                expect(exits().length).toBeGreaterThan(0);
                const plan = planBarrelLandingCover(input)!;
                expect(plan).toHaveLength(2);
                c.grid.clearArtifactBarrels(unit.getTeam());
                plan.forEach((cell, index) =>
                    expect(c.grid.placeArtifactBarrel(unit.getTeam(), index, cell)).toBe(true),
                );
                expect(exits().length).toBeGreaterThan(0);
            });
        }
