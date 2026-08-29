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

import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { AttackType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import type { Grid } from "../../src/grid/grid";
import { UPDATE_UP } from "../../src/grid/grid_constants";
import { getPositionForCell, getPositionForFootprintAnchor } from "../../src/grid/grid_math";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { MoveHandler } from "../../src/handlers/move_handler";
import { Unit } from "../../src/units/unit";
import { UnitProperties } from "../../src/units/unit_properties";
import { UnitsHolder } from "../../src/units/units_holder";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createVisibleDamage, testGridSettings } from "../helpers/combat";

/**
 * Rectangular footprints (1x2 / 2x1) through the two attack handlers.
 *
 * Both files used to fork on `isSmallSize()` and treat every "not small" unit as a 2x2 block: the melee
 * attack-from expansion, the position a unit lands on when it steps into contact, the aggro cells a shooter
 * is pinned by, and the cells a lap-narrowing shove carries. A rectangle came out of each of those as a
 * square, so it occupied cells it did not stand on, landed half a cell off the grid lines, read as pinned
 * where it was safe, and — in the shove — was destroyed outright.
 *
 * The invariant every case here checks is the same one: after the handler is done, the unit's own geometry
 * (getCells) and the board's registration agree, cell for cell.
 */

const cellKey = (cell: XY): string => `${cell.x},${cell.y}`;
const sortedKeys = (cells: readonly XY[]): string[] => cells.map(cellKey).sort();

const cellCenter = (cell: XY): XY =>
    getPositionForCell(cell, testGridSettings.getMinX(), testGridSettings.getStep(), testGridSettings.getHalfStep());

interface IFootprintUnitOptions {
    name: string;
    team: TeamType;
    width: number;
    height: number;
    attackType?: AttackType;
    abilities?: string[];
    amountAlive?: number;
    maxHp?: number;
    rangeShots?: number;
    shotDistance?: number;
}

/**
 * A unit of an arbitrary WxH footprint. The shared createTestUnit helper only knows the square `size`, and
 * footprint_width/height are constructor arguments rather than mutable state (a Unit owns a structuredClone
 * of its properties), so the whole property list has to be spelled out.
 */
function createFootprintUnit(options: IFootprintUnitOptions): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    const abilities = options.abilities ?? [];
    const noStrings: string[] = [];
    const noNumbers: number[] = [];
    const noBooleans: boolean[] = [];

    return Unit.createUnit(
        new UnitProperties(
            PBTypes.FactionVals.MIGHT,
            options.name,
            options.maxHp ?? 100,
            3,
            0,
            0,
            1,
            10,
            options.attackType ?? PBTypes.AttackVals.MELEE,
            10,
            10,
            10,
            1,
            options.rangeShots ?? 0,
            options.shotDistance ?? 16,
            0,
            PBTypes.MovementVals.WALK,
            0,
            // The legacy square `size` is what the texture and the unit card read; the footprint below is the
            // board geometry and is deliberately allowed to disagree with it (size = max(W, H), so an
            // un-migrated consumer draws a rectangle BIG rather than tiny).
            Math.max(options.width, options.height),
            PBTypes.UnitLevelVals.FIRST,
            noStrings,
            abilities,
            abilities.map(() => ""),
            abilities.map(() => false),
            abilities.map(() => false),
            noStrings,
            noStrings,
            noStrings,
            noNumbers,
            noNumbers,
            noNumbers,
            noStrings,
            noStrings,
            noStrings,
            noNumbers,
            noNumbers,
            noNumbers,
            noStrings,
            noNumbers,
            noBooleans,
            noStrings,
            options.amountAlive ?? 3,
            0,
            options.team,
            PBTypes.UnitVals.CREATURE,
            "",
            "",
            1,
            "",
            [],
            false,
            options.width,
            options.height,
        ),
        testGridSettings,
        options.team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

/**
 * Put a unit on the board at `anchor` — the footprint's TOP-RIGHT cell — the way the engine does it: the
 * body's position is the footprint's CENTRE, and a one-cell body registers through occupyCell because
 * occupyCells refuses a unit whose current registration is a single cell.
 */
function place(grid: Grid, unitsHolder: UnitsHolder, unit: Unit, anchor: XY): void {
    const position = getPositionForFootprintAnchor(
        testGridSettings,
        anchor,
        unit.getFootprintWidth(),
        unit.getFootprintHeight(),
    );
    unit.setPosition(position.x, position.y);
    const occupied = unit.isSmallSize()
        ? grid.occupyCell(anchor, unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false)
        : grid.occupyCells(unit.getCells(), unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
    expect(occupied).toBe(true);
    unitsHolder.addUnit(unit);
}

/** The body and the board must never disagree — that divergence is the failure mode this work exists to kill. */
function expectBodyMatchesBoard(grid: Grid, unit: Unit, expectedCells: readonly XY[]): void {
    expect(sortedKeys(unit.getCells())).toEqual(sortedKeys(expectedCells));
    expect(sortedKeys(grid.getRegisteredCells(unit.getId()))).toEqual(sortedKeys(expectedCells));
    for (const cell of expectedCells) {
        expect(grid.getOccupantUnitId(cell)).toBe(unit.getId());
    }
}

/** A one-step known path ending on `to`, which is all handleMeleeAttack needs to allow a move into contact. */
function knownPathTo(from: XY, to: XY): Map<number, IWeightedRoute[]> {
    return new Map<number, IWeightedRoute[]>([
        [
            (to.x << 4) | to.y,
            [
                {
                    cell: to,
                    route: [from, to],
                    weight: 1,
                    firstAggrMet: false,
                    hasLavaCell: false,
                    hasWaterCell: false,
                },
            ],
        ],
    ]);
}

describe("AttackHandler.canBeAttackedByMelee with a real footprint", () => {
    it("reads a 1x2 as one column, not as the 2x2 block the boolean forced it into", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        // The shooter's body is the column x=5, rows 5..6. Its position is a cell CENTRE on x (the axis it is
        // one cell wide), so the legacy expansion — which reads a position as a grid intersection — invents
        // the column to its RIGHT. The enemy is placed to threaten exactly that phantom column and nothing
        // the shooter actually stands on.
        const shooter = createFootprintUnit({
            name: "Tall Shooter",
            team: PBTypes.TeamVals.LOWER,
            width: 1,
            height: 2,
        });
        const enemy = createFootprintUnit({ name: "Pinner", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, shooter, { x: 5, y: 6 });
        place(grid, unitsHolder, enemy, { x: 7, y: 5 });

        const enemyAggr = grid.getEnemyAggrMatrixByUnitId(shooter.getId());

        expect(attackHandler.canBeAttackedByMelee(shooter.getPosition(), shooter, enemyAggr)).toBe(false);
        // The legacy boolean cannot say "one cell wide, two tall": read as a 2x2 the same shooter is pinned.
        // Kept in the test as the reason the parameter had to change, not as behaviour anyone should want.
        expect(attackHandler.canBeAttackedByMelee(shooter.getPosition(), false, enemyAggr)).toBe(true);
    });

    /**
     * The three-deep case, which fails in the OTHER direction. For a 1x2 the legacy 2x2 window is a strict
     * superset of the real body, so it can only invent a pin. A 1x3 is TALLER than the window, so the
     * window also MISSES the body's far cell: a threat that really touches the shooter goes unseen and the
     * AI proposes a shot the engine then refuses. Both directions matter, and only the unit-shaped form
     * gets either right.
     */
    it("reads a 1x3's far cell, which the legacy window cannot even see", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const shooter = createFootprintUnit({
            name: "Very Tall Shooter",
            team: PBTypes.TeamVals.LOWER,
            width: 1,
            height: 3,
        });
        // Body = column x=5, rows 4..6. The legacy window covers rows 6..7, so row 4 is outside it.
        const enemy = createFootprintUnit({ name: "Pinner", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, shooter, { x: 5, y: 6 });
        place(grid, unitsHolder, enemy, { x: 6, y: 3 });

        const enemyAggr = grid.getEnemyAggrMatrixByUnitId(shooter.getId());

        // The enemy rings rows 2..4 of columns 5..7, which really does touch the shooter's cell (5,4).
        expect(attackHandler.canBeAttackedByMelee(shooter.getPosition(), shooter, enemyAggr)).toBe(true);
        // The legacy boolean never looks that far down the body, so it reports the shooter free.
        expect(attackHandler.canBeAttackedByMelee(shooter.getPosition(), false, enemyAggr)).toBe(false);
    });

    it("reads a 2x1 as one row", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        // Body = row y=6, columns 4..5. The mirrored story: y is the cell centre here, so the legacy reading
        // invents the row ABOVE. The enemy at (4,8) rings rows 7..9, threatening only that phantom row.
        const shooter = createFootprintUnit({
            name: "Wide Shooter",
            team: PBTypes.TeamVals.LOWER,
            width: 2,
            height: 1,
        });
        const enemy = createFootprintUnit({ name: "Pinner", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, shooter, { x: 5, y: 6 });
        place(grid, unitsHolder, enemy, { x: 4, y: 8 });

        const enemyAggr = grid.getEnemyAggrMatrixByUnitId(shooter.getId());

        expect(attackHandler.canBeAttackedByMelee(shooter.getPosition(), shooter, enemyAggr)).toBe(false);
        expect(attackHandler.canBeAttackedByMelee(shooter.getPosition(), false, enemyAggr)).toBe(true);

        // ...and it does see a threat that really touches its row.
        const closeEnemy = createFootprintUnit({ name: "Close", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });
        place(grid, unitsHolder, closeEnemy, { x: 6, y: 6 });
        expect(
            attackHandler.canBeAttackedByMelee(
                shooter.getPosition(),
                shooter,
                grid.getEnemyAggrMatrixByUnitId(shooter.getId()),
            ),
        ).toBe(true);
    });

    it("answers exactly what the legacy boolean answered for the two shipped shapes", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const small = createFootprintUnit({ name: "Small", team: PBTypes.TeamVals.LOWER, width: 1, height: 1 });
        const large = createFootprintUnit({ name: "Large", team: PBTypes.TeamVals.LOWER, width: 2, height: 2 });
        const enemy = createFootprintUnit({ name: "Pinner", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, small, { x: 4, y: 4 });
        place(grid, unitsHolder, large, { x: 9, y: 9 });
        place(grid, unitsHolder, enemy, { x: 10, y: 10 });

        const aggr = grid.getEnemyAggrMatrixByUnitId(small.getId());
        for (const anchor of [
            { x: 3, y: 3 },
            { x: 4, y: 4 },
            { x: 9, y: 9 },
            { x: 11, y: 11 },
            { x: 12, y: 12 },
        ]) {
            const position = cellCenter(anchor);
            expect(attackHandler.canBeAttackedByMelee(position, small, aggr)).toBe(
                attackHandler.canBeAttackedByMelee(position, true, aggr),
            );
            const largePosition = getPositionForFootprintAnchor(testGridSettings, anchor, 2, 2);
            expect(attackHandler.canBeAttackedByMelee(largePosition, large, aggr)).toBe(
                attackHandler.canBeAttackedByMelee(largePosition, false, aggr),
            );
        }
    });

    it("does not throw when part of the footprint hangs off the board", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        // Footprint cells are deliberately UNCLIPPED, so a body parked against the edge reports cells with a
        // negative coordinate. The aggro board is only gridSize wide; indexing it with those used to throw.
        const edgeUnit = createFootprintUnit({ name: "Edge", team: PBTypes.TeamVals.LOWER, width: 2, height: 2 });
        const enemy = createFootprintUnit({ name: "Pinner", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, enemy, { x: 1, y: 1 });
        const offBoard = getPositionForFootprintAnchor(testGridSettings, { x: 0, y: 0 }, 2, 2);

        expect(() =>
            attackHandler.canBeAttackedByMelee(offBoard, edgeUnit, grid.getEnemyAggrMatrixByUnitId(enemy.getId())),
        ).not.toThrow();
    });
});

describe("AttackHandler.handleMeleeAttack with a rectangular body", () => {
    it("strikes a 1x1 from a 1x2 body, and is struck back by it", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const attacker = createFootprintUnit({
            name: "Tall Attacker",
            team: PBTypes.TeamVals.UPPER,
            width: 1,
            height: 2,
        });
        const target = createFootprintUnit({ name: "Small Target", team: PBTypes.TeamVals.LOWER, width: 1, height: 1 });
        attacker.calculateMissChance = () => 0;
        target.calculateMissChance = () => 0;

        // Attacker body = column 5, rows 5..6. The target touches its BOTTOM cell, which is the half of the
        // body a square reading would have got wrong first.
        place(grid, unitsHolder, attacker, { x: 5, y: 6 });
        place(grid, unitsHolder, target, { x: 5, y: 4 });

        const targetHpBefore = target.getCumulativeHp();
        const attackerHpBefore = attacker.getCumulativeHp();
        const damageForAnimation = createVisibleDamage(target);
        damageForAnimation.hits = [];

        setDeterministicRandomSource(() => 0);
        try {
            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                moveHandler,
                damageForAnimation,
                undefined,
                attacker,
                target,
                { x: 5, y: 6 },
            );

            expect(result.completed).toBe(true);
            expect(target.getCumulativeHp()).toBeLessThan(targetHpBefore);
            // Retaliation: the 1x1 answers the rectangle it can reach.
            expect(attacker.getCumulativeHp()).toBeLessThan(attackerHpBefore);
        } finally {
            setDeterministicRandomSource(undefined);
        }

        // A stationary strike still runs the whole "stand on the attack-from anchor" path, so it re-stamps
        // both the position and the occupancy. The position is the footprint's CENTRE; the legacy half-step
        // on BOTH axes put it half a cell left of that, which happened to round back to the same anchor here
        // and so hid the error from getCells() — assert the position itself, not just the cells it derives.
        expect(attacker.getPosition()).toEqual(getPositionForFootprintAnchor(testGridSettings, { x: 5, y: 6 }, 1, 2));
        expectBodyMatchesBoard(grid, attacker, [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
        ]);
        expect(grid.getOccupantUnitId({ x: 4, y: 5 })).toBeFalsy();
        expect(grid.getOccupantUnitId({ x: 4, y: 6 })).toBeFalsy();
    });

    it("is struck by a 1x1 in the other direction and retaliates from its whole body", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const attacker = createFootprintUnit({
            name: "Small Attacker",
            team: PBTypes.TeamVals.UPPER,
            width: 1,
            height: 1,
        });
        const target = createFootprintUnit({ name: "Tall Target", team: PBTypes.TeamVals.LOWER, width: 1, height: 2 });
        attacker.calculateMissChance = () => 0;
        target.calculateMissChance = () => 0;

        place(grid, unitsHolder, attacker, { x: 6, y: 5 });
        place(grid, unitsHolder, target, { x: 5, y: 6 });

        const targetHpBefore = target.getCumulativeHp();
        const attackerHpBefore = attacker.getCumulativeHp();
        const damageForAnimation = createVisibleDamage(target);
        damageForAnimation.hits = [];

        setDeterministicRandomSource(() => 0);
        try {
            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                moveHandler,
                damageForAnimation,
                undefined,
                attacker,
                target,
                { x: 6, y: 5 },
            );

            expect(result.completed).toBe(true);
            expect(target.getCumulativeHp()).toBeLessThan(targetHpBefore);
            expect(attacker.getCumulativeHp()).toBeLessThan(attackerHpBefore);
        } finally {
            setDeterministicRandomSource(undefined);
        }

        // The defender never moves, so its body and the board must still describe the same two cells.
        expectBodyMatchesBoard(grid, target, [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
        ]);
    });

    it("lands on its own two cells when a 1x2 steps into contact instead of on a 2x2 block", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const attacker = createFootprintUnit({
            name: "Tall Charger",
            team: PBTypes.TeamVals.UPPER,
            width: 1,
            height: 2,
        });
        const target = createFootprintUnit({ name: "Small Target", team: PBTypes.TeamVals.LOWER, width: 1, height: 1 });
        attacker.calculateMissChance = () => 0;
        target.calculateMissChance = () => 0;

        place(grid, unitsHolder, attacker, { x: 2, y: 6 });
        place(grid, unitsHolder, target, { x: 5, y: 7 });

        const damageForAnimation = createVisibleDamage(target);
        damageForAnimation.hits = [];
        const targetHpBefore = target.getCumulativeHp();

        setDeterministicRandomSource(() => 0);
        try {
            const result = attackHandler.handleMeleeAttack(
                unitsHolder,
                moveHandler,
                damageForAnimation,
                knownPathTo({ x: 2, y: 6 }, { x: 5, y: 6 }),
                attacker,
                target,
                { x: 5, y: 6 },
            );

            expect(result.completed).toBe(true);
            expect(target.getCumulativeHp()).toBeLessThan(targetHpBefore);
        } finally {
            setDeterministicRandomSource(undefined);
        }

        // The whole point: the anchor it was told to attack from is the anchor it now stands on. The legacy
        // arithmetic subtracted half a step on BOTH axes, which on the axis a 1x2 is one cell wide put the
        // body between columns and moved it into column 4.
        expect(attacker.getBaseCell()).toEqual({ x: 5, y: 6 });
        expect(attacker.getPosition()).toEqual(getPositionForFootprintAnchor(testGridSettings, { x: 5, y: 6 }, 1, 2));
        expectBodyMatchesBoard(grid, attacker, [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
        ]);
        expect(grid.getOccupantUnitId({ x: 4, y: 5 })).toBeFalsy();
        expect(grid.getOccupantUnitId({ x: 4, y: 6 })).toBeFalsy();
        // ...and it really left where it came from.
        expect(grid.getOccupantUnitId({ x: 2, y: 6 })).toBeFalsy();
        expect(grid.getOccupantUnitId({ x: 2, y: 5 })).toBeFalsy();
    });

    it("fights a 2x2 in both directions", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const rectangle = createFootprintUnit({ name: "Tall One", team: PBTypes.TeamVals.UPPER, width: 1, height: 2 });
        const square = createFootprintUnit({ name: "Square One", team: PBTypes.TeamVals.LOWER, width: 2, height: 2 });
        rectangle.calculateMissChance = () => 0;
        square.calculateMissChance = () => 0;

        // Rectangle = column 5, rows 7..8. Square = columns 6..7, rows 7..8. They share the whole edge.
        place(grid, unitsHolder, rectangle, { x: 5, y: 8 });
        place(grid, unitsHolder, square, { x: 7, y: 8 });

        const squareHpBefore = square.getCumulativeHp();
        const rectangleHpBefore = rectangle.getCumulativeHp();

        setDeterministicRandomSource(() => 0);
        try {
            const forward = createVisibleDamage(square);
            forward.hits = [];
            expect(
                attackHandler.handleMeleeAttack(unitsHolder, moveHandler, forward, undefined, rectangle, square, {
                    x: 5,
                    y: 8,
                }).completed,
            ).toBe(true);
            expect(square.getCumulativeHp()).toBeLessThan(squareHpBefore);
            // The square retaliated, so the rectangle took damage too.
            expect(rectangle.getCumulativeHp()).toBeLessThan(rectangleHpBefore);

            const squareHpMid = square.getCumulativeHp();
            const rectangleHpMid = rectangle.getCumulativeHp();
            const backward = createVisibleDamage(rectangle);
            backward.hits = [];
            expect(
                attackHandler.handleMeleeAttack(unitsHolder, moveHandler, backward, undefined, square, rectangle, {
                    x: 7,
                    y: 8,
                }).completed,
            ).toBe(true);
            expect(rectangle.getCumulativeHp()).toBeLessThan(rectangleHpMid);
            expect(square.getCumulativeHp()).toBeLessThan(squareHpMid);
        } finally {
            setDeterministicRandomSource(undefined);
        }

        expect(rectangle.getPosition()).toEqual(getPositionForFootprintAnchor(testGridSettings, { x: 5, y: 8 }, 1, 2));
        expect(square.getPosition()).toEqual(getPositionForFootprintAnchor(testGridSettings, { x: 7, y: 8 }, 2, 2));
        expectBodyMatchesBoard(grid, rectangle, [
            { x: 5, y: 7 },
            { x: 5, y: 8 },
        ]);
        expectBodyMatchesBoard(grid, square, [
            { x: 6, y: 7 },
            { x: 6, y: 8 },
            { x: 7, y: 7 },
            { x: 7, y: 8 },
        ]);
    });
});

describe("Splash damage against a rectangular body", () => {
    it("hits a 1x2 once when the shot crosses both of its cells", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const shooter = createFootprintUnit({
            name: "Archer",
            team: PBTypes.TeamVals.LOWER,
            width: 1,
            height: 1,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        const victim = createFootprintUnit({ name: "Tall Victim", team: PBTypes.TeamVals.UPPER, width: 1, height: 2 });

        place(grid, unitsHolder, shooter, { x: 5, y: 1 });
        place(grid, unitsHolder, victim, { x: 5, y: 8 });

        // Straight up the column, so the ray walks the victim's lower cell and then its upper one.
        const evaluation = attackHandler.evaluateRangeAttack(
            unitsHolder.getAllUnits(),
            shooter,
            shooter.getPosition(),
            cellCenter({ x: 5, y: 8 }),
        );

        const hits = evaluation.affectedUnits.flat().filter((unit) => unit.getId() === victim.getId());
        expect(hits.length).toBe(1);
    });

    it("hits a 1x2 once when an Area Throw ring covers both of its cells", () => {
        const { grid, unitsHolder, attackHandler } = createCombatTestContext();
        const thrower = createFootprintUnit({
            name: "Thrower",
            team: PBTypes.TeamVals.LOWER,
            width: 1,
            height: 1,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
            abilities: ["Area Throw"],
        });
        const aimed = createFootprintUnit({ name: "Aimed", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });
        const splashed = createFootprintUnit({
            name: "Tall Bystander",
            team: PBTypes.TeamVals.UPPER,
            width: 1,
            height: 2,
        });

        place(grid, unitsHolder, thrower, { x: 10, y: 6 });
        place(grid, unitsHolder, aimed, { x: 6, y: 6 });
        // Column 5, rows 6..7 — BOTH cells sit inside the ring around the aimed cell (6,6).
        place(grid, unitsHolder, splashed, { x: 5, y: 7 });

        const evaluation = attackHandler.evaluateRangeAttack(
            unitsHolder.getAllUnits(),
            thrower,
            thrower.getPosition(),
            cellCenter({ x: 6, y: 6 }),
        );

        const splashHits = evaluation.affectedUnits.flat().filter((unit) => unit.getId() === splashed.getId());
        expect(splashHits.length).toBe(1);
        // The aimed unit is still hit, so the ring did not simply miss.
        expect(evaluation.affectedUnits.flat().some((unit) => unit.getId() === aimed.getId())).toBe(true);
    });
});

describe("MoveHandler with a rectangular body", () => {
    it("shoves a 1x2 one cell without turning it into a square or destroying it", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createFootprintUnit({ name: "Tall Walker", team: PBTypes.TeamVals.LOWER, width: 1, height: 2 });

        place(grid, unitsHolder, unit, { x: 5, y: 5 });

        // The lap sweep looks the occupant up by ONE of its cells; the shove has to carry the other one too.
        const result = moveHandler.moveUnitTowardsCenter({ x: 5, y: 4 }, UPDATE_UP, 0);

        expect(result.unitIdsDestroyed).toEqual([]);
        expect(result.log).toBe("");
        expect(result.unitIdToNewPosition.get(unit.getId())).toEqual(unit.getPosition());
        expect(unit.getBaseCell()).toEqual({ x: 5, y: 6 });
        expectBodyMatchesBoard(grid, unit, [
            { x: 5, y: 5 },
            { x: 5, y: 6 },
        ]);
        expect(grid.getOccupantUnitId({ x: 5, y: 4 })).toBeFalsy();
    });

    it("shifts a blocked 1x2 sideways rather than destroying it", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createFootprintUnit({ name: "Tall Walker", team: PBTypes.TeamVals.LOWER, width: 1, height: 2 });
        const blocker = createFootprintUnit({ name: "Blocker", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, unit, { x: 5, y: 5 });
        place(grid, unitsHolder, blocker, { x: 5, y: 6 });

        const result = moveHandler.moveUnitTowardsCenter({ x: 5, y: 4 }, UPDATE_UP, 0);

        // Before footprints this ended in "<name> destroyed": the 2x2 target cells never fit, every shift was
        // refused, and getPositionForCells could not answer for a two-cell body anyway.
        expect(result.unitIdsDestroyed).toEqual([]);
        expect(unit.getBaseCell()).toEqual({ x: 6, y: 6 });
        expectBodyMatchesBoard(grid, unit, [
            { x: 6, y: 5 },
            { x: 6, y: 6 },
        ]);
    });

    it("refuses a move loudly instead of moving the body off its own cells", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const moveHandler = new MoveHandler(testGridSettings, grid, unitsHolder);
        const unit = createFootprintUnit({ name: "Tall Walker", team: PBTypes.TeamVals.LOWER, width: 1, height: 2 });
        const blocker = createFootprintUnit({ name: "Blocker", team: PBTypes.TeamVals.UPPER, width: 1, height: 1 });

        place(grid, unitsHolder, unit, { x: 5, y: 5 });
        place(grid, unitsHolder, blocker, { x: 8, y: 8 });

        const positionBefore = { ...unit.getPosition() };
        const result = moveHandler.finishDirectedUnitMove(
            unit,
            [
                { x: 8, y: 7 },
                { x: 8, y: 8 },
            ],
            getPositionForFootprintAnchor(testGridSettings, { x: 8, y: 8 }, 1, 2),
        );

        expect(result.newPosition).toBeUndefined();
        expect(result.deleteUnit).toBe(false);
        expect(result.log).toContain("could not occupy");
        // The body stayed where the board says it is — the divergence this guard exists to prevent.
        expect(unit.getPosition()).toEqual(positionBefore);
        expectBodyMatchesBoard(grid, unit, [
            { x: 5, y: 4 },
            { x: 5, y: 5 },
        ]);
    });
});
