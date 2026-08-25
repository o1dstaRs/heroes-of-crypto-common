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
import { GameActionEngine, type IGameActionEngineContext } from "../../src/engine/action_engine";
import type { MoveUnitAction } from "../../src/engine/post_move_actor_availability";
import {
    isMovePathFootprintOnly,
    resolveMoveTargetCells,
    resolveMoveTraversal,
} from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType, UnitLevelType } from "../../src/generated/protobuf/v1/types_gen";
import type { Grid } from "../../src/grid/grid";
import { getFootprintCellsForAnchor, getPositionForFootprintAnchor } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { GameEvent } from "../../src/engine/events";
import { Unit } from "../../src/units/unit";
import { UnitProperties } from "../../src/units/unit_properties";
import type { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, testGridSettings } from "../helpers/combat";

/**
 * GameActionEngine is the rule surface every shape has to get through, and until footprints it refused a
 * rectangle at every one of its gates: placement wanted "one cell or four in a square", the move fallback and
 * the split candidates each grew a hardcoded 2x2, the summon reserved four cells whatever it was summoning,
 * and the infested spawn matched a corpse by CELL COUNT — which cannot tell a 1x2 from a 2x1.
 *
 * Both halves matter equally here. A 1x2 and a 2x1 must now be placed, moved, summoned and split like any
 * other body, and 1x1 and 2x2 must come out of every one of those paths with exactly the cells, the cell
 * ORDER and the results they came out with before — the live game and every baked AI weight were measured on
 * them. So the legacy shapes are not spot-checked: they run the same assertions from the same table.
 */

const GRID_SIZE = testGridSettings.getGridSize();

interface IFootprintUnitOptions {
    name?: string;
    team?: TeamType;
    amountAlive?: number;
    abilities?: string[];
    spells?: string[];
    level?: UnitLevelType;
    summoned?: boolean;
}

/**
 * A unit of an arbitrary WxH footprint. The shared createTestUnit helper only knows the square `size`, and
 * footprint_width/height are constructor arguments rather than mutable state (a Unit owns a structuredClone
 * of its properties), so the whole property list is spelled out — the same approach test/units takes.
 */
function createFootprintUnit(width: number, height: number, options: IFootprintUnitOptions = {}): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    const team = options.team ?? PBTypes.TeamVals.LOWER;
    const abilities = options.abilities ?? [];
    const noStrings: string[] = [];
    const noNumbers: number[] = [];
    const noBooleans: boolean[] = [];

    return Unit.createUnit(
        new UnitProperties(
            PBTypes.FactionVals.MIGHT,
            options.name ?? `Body ${width}x${height}`,
            10,
            3,
            4,
            0,
            5,
            10,
            PBTypes.AttackVals.MELEE,
            10,
            1,
            1,
            1,
            0,
            16,
            0,
            PBTypes.MovementVals.WALK,
            0,
            // `size` stays the LEGACY SQUARE size — it picks the art tier and feeds the wire enum — while the
            // footprint below is the board geometry. size === max(W, H) so an un-migrated consumer draws a
            // rectangle BIG rather than tiny.
            Math.max(width, height),
            options.level ?? PBTypes.UnitLevelVals.FIRST,
            options.spells ?? noStrings,
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
            options.amountAlive ?? 1,
            0,
            team,
            PBTypes.UnitVals.CREATURE,
            "",
            "",
            1,
            "",
            [],
            false,
            width,
            height,
        ),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        options.summoned ?? false,
    );
}

const footprintCentre = (anchor: XY, width: number, height: number): XY =>
    getPositionForFootprintAnchor(testGridSettings, anchor, width, height);

const sortCells = (cells: readonly XY[]): XY[] => [...cells].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;

/**
 * Stand a unit on the board with its WHOLE body registered.
 *
 * Deliberately not the shared `placeUnit` helper: that one stamps a single cell whatever the unit's size, so
 * a multi-cell body ends up registered on one cell and the grid then refuses to re-register it anywhere —
 * an artefact of the fixture, not of the engine, that would make every move below fail for the wrong reason.
 */
function standAt(grid: Grid, unitsHolder: UnitsHolder, unit: Unit, anchor: XY): void {
    const position = footprintCentre(anchor, unit.getFootprintWidth(), unit.getFootprintHeight());
    unit.setPosition(position.x, position.y);
    expect(
        grid.occupyCells(
            unit.getCells(),
            unit.getId(),
            unit.getTeam(),
            unit.getAttackRange(),
            unit.canTraverseLava(),
            unit.hasAbilityActive("Made of Water"),
        ),
    ).toBe(true);
    unitsHolder.addUnit(unit);
}

/** A pre-fight engine: placement, split and delete are legal, fight actions are not. */
function placementEngine(extra: Partial<IGameActionEngineContext> = {}) {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    const moveHandler = new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler,
        sceneLog: new SceneLogMock(),
        ...extra,
    });

    return { ...context, fightProperties, engine };
}

/** A started fight with `active` holding the turn, so move and cast actions are legal. */
function fightEngine(active: Unit, extra: Partial<IGameActionEngineContext> = {}) {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);
    const moveHandler = new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder);
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler,
        sceneLog: new SceneLogMock(),
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => active.getId(),
        ...extra,
    });

    return { ...context, fightProperties, engine };
}

/** The four shapes under test: the two shipped squares and the two rectangles that never fitted. */
const SHAPES: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [2, 2],
    [1, 2],
    [2, 1],
];

/** A shape that is NOT the unit's own, used to prove the gate rejects the wrong rectangle and not just the
 * wrong cell count: 1x2 and 2x1 have the SAME number of cells. */
const transposed = (width: number, height: number): readonly [number, number] =>
    width === height ? [width, height + 1] : [height, width];

describe("action engine footprints — placement", () => {
    for (const [width, height] of SHAPES) {
        const label = `${width}x${height}`;
        // Far from every edge, so nothing in these cases is decided by clipping.
        const anchor: XY = { x: 6, y: 6 };

        it(`${label}: places a stack on exactly its own footprint`, () => {
            const setup = placementEngine();
            const unit = createFootprintUnit(width, height);
            setup.unitsHolder.addUnit(unit);
            const cells = getFootprintCellsForAnchor(anchor, width, height);

            const result = setup.engine.apply({
                type: "place_unit",
                unitId: unit.getId(),
                team: unit.getTeam(),
                unitName: unit.getName(),
                cells,
            });

            expect(result.completed).toBe(true);
            expect(unit.getBaseCell()).toEqual(anchor);
            expect(unit.getPosition()).toEqual(footprintCentre(anchor, width, height));
            expect(sortCells(unit.getCells())).toEqual(sortCells(cells));
            // The grid marks exactly W*H cells and agrees with the unit about every one of them.
            expect(setup.grid.getRegisteredCells(unit.getId())).toHaveLength(width * height);
            for (const cell of cells) {
                expect(setup.grid.getOccupantUnitId(cell)).toBe(unit.getId());
            }
            expect(result.events).toEqual([
                {
                    type: "unit_placed",
                    unitId: unit.getId(),
                    team: unit.getTeam(),
                    position: unit.getPosition(),
                    cells,
                },
            ]);
        });

        it(`${label}: refuses a footprint of a different shape`, () => {
            const setup = placementEngine();
            const unit = createFootprintUnit(width, height);
            setup.unitsHolder.addUnit(unit);
            const [otherWidth, otherHeight] = transposed(width, height);

            const result = setup.engine.apply({
                type: "place_unit",
                unitId: unit.getId(),
                team: unit.getTeam(),
                unitName: unit.getName(),
                cells: getFootprintCellsForAnchor(anchor, otherWidth, otherHeight),
            });

            expect(result).toEqual({
                completed: false,
                events: [],
                rejectionReason: "invalid_placement",
                message: undefined,
            });
            expect(setup.grid.getRegisteredCells(unit.getId())).toHaveLength(0);
        });

        it(`${label}: refuses a footprint that repeats a cell instead of tiling the rectangle`, () => {
            const setup = placementEngine();
            const unit = createFootprintUnit(width, height);
            setup.unitsHolder.addUnit(unit);
            const cells = getFootprintCellsForAnchor(anchor, width, height);
            // W*H entries covering fewer than W*H cells. A count-and-extents test passes this; the body it
            // describes would occupy a hole.
            const repeated = cells.map((cell, index) => (index ? { ...cells[0] } : cell));

            const result = setup.engine.apply({
                type: "place_unit",
                unitId: unit.getId(),
                team: unit.getTeam(),
                unitName: unit.getName(),
                cells: repeated,
            });

            expect(result.completed).toBe(width * height === 1);
        });

        it(`${label}: refuses a footprint hanging off the board`, () => {
            const setup = placementEngine();
            const unit = createFootprintUnit(width, height);
            setup.unitsHolder.addUnit(unit);
            // One column short of the room the body needs: its leftmost cell is x === -1.
            const offBoard = getFootprintCellsForAnchor({ x: width - 2, y: 6 }, width, height);

            const result = setup.engine.apply({
                type: "place_unit",
                unitId: unit.getId(),
                team: unit.getTeam(),
                unitName: unit.getName(),
                cells: offBoard,
            });

            expect(result.completed).toBe(false);
            expect(setup.grid.getRegisteredCells(unit.getId())).toHaveLength(0);
        });

        it(`${label}: refuses a placement that would overlap another stack`, () => {
            const setup = placementEngine();
            const blocker = createFootprintUnit(1, 1, { name: "Blocker", team: PBTypes.TeamVals.UPPER });
            standAt(setup.grid, setup.unitsHolder, blocker, anchor);
            const unit = createFootprintUnit(width, height);
            setup.unitsHolder.addUnit(unit);

            const result = setup.engine.apply({
                type: "place_unit",
                unitId: unit.getId(),
                team: unit.getTeam(),
                unitName: unit.getName(),
                cells: getFootprintCellsForAnchor(anchor, width, height),
            });

            expect(result.rejectionReason).toBe("placement_blocked");
            expect(setup.grid.getOccupantUnitId(anchor)).toBe(blocker.getId());
        });
    }
});

/**
 * Where a move with no explicit `targetCells` puts the body.
 *
 * A 1x1 lands on the route's last cell and a rectangle hangs its body off it as an anchor, but the LARGE
 * fallback reads that cell as the block's BOTTOM-LEFT corner — the opposite anchor from the one the rest of
 * the engine uses. That is kept deliberately (every large unit that ever moved through this branch landed on
 * this reading, so re-anchoring it is a live change to take on its own), and pinning it here is what stops it
 * being "tidied up" while rectangles are being added around it.
 */
/** A walk with no explicit targetCells lands the body ANCHORED on the route's last cell, for every shape. */
const walkDestinationCells = (destination: XY, width: number, height: number): XY[] =>
    getFootprintCellsForAnchor(destination, width, height);

describe("action engine footprints — movement", () => {
    for (const [width, height] of SHAPES) {
        const label = `${width}x${height}`;
        const from: XY = { x: 6, y: 6 };
        const step: XY = { x: 7, y: 6 };
        // Two steps for the explicit-footprint cases, so a two-cell body's route can never be mistaken for
        // its destination footprint — the one genuinely ambiguous encoding on the wire.
        const to: XY = { x: 8, y: 6 };

        it(`${label}: a one-step walk lands the whole body on its destination cells`, () => {
            const mover = createFootprintUnit(width, height);
            const setup = fightEngine(mover);
            standAt(setup.grid, setup.unitsHolder, mover, from);

            const result = setup.engine.apply({
                type: "move_unit",
                unitId: mover.getId(),
                path: [from, step],
            });

            expect(result.completed).toBe(true);
            const expected = walkDestinationCells(step, width, height);
            expect(sortCells(mover.getCells())).toEqual(sortCells(expected));
            expect(sortCells(setup.grid.getRegisteredCells(mover.getId()))).toEqual(sortCells(expected));
            expect(mover.getBaseCell()).toEqual({
                x: Math.max(...expected.map((cell) => cell.x)),
                y: Math.max(...expected.map((cell) => cell.y)),
            });
            // Nothing of the body is left behind on the cells it vacated.
            for (const cell of getFootprintCellsForAnchor(from, width, height)) {
                if (!expected.some((kept) => kept.x === cell.x && kept.y === cell.y)) {
                    expect(setup.grid.getOccupantUnitId(cell)).toBe("");
                }
            }
        });

        it(`${label}: honours an explicitly supplied target footprint`, () => {
            const mover = createFootprintUnit(width, height);
            const setup = fightEngine(mover);
            standAt(setup.grid, setup.unitsHolder, mover, from);
            const targetCells = getFootprintCellsForAnchor(to, width, height);

            const result = setup.engine.apply({
                type: "move_unit",
                unitId: mover.getId(),
                path: [from, step, to],
                targetCells,
            });

            expect(result.completed).toBe(true);
            expect(mover.getBaseCell()).toEqual(to);
            expect(sortCells(mover.getCells())).toEqual(sortCells(targetCells));
            expect(sortCells(setup.grid.getRegisteredCells(mover.getId()))).toEqual(sortCells(targetCells));
            expect(result.events[0]).toMatchObject({ type: "unit_moved", targetCells });
        });

        it(`${label}: refuses a step whose body would overlap another stack`, () => {
            const mover = createFootprintUnit(width, height);
            const setup = fightEngine(mover);
            standAt(setup.grid, setup.unitsHolder, mover, from);
            const targetCells = getFootprintCellsForAnchor(to, width, height);
            // Block a destination cell the body needs but is NOT anchored on wherever the shape has one:
            // that is precisely the cell an anchor-only check cannot see. Only a 1x1 has no such cell.
            const nonAnchorCells = targetCells.filter((cell) => cell.x !== to.x || cell.y !== to.y);
            const blockedCell = nonAnchorCells[nonAnchorCells.length - 1] ?? to;
            const blocker = createFootprintUnit(1, 1, { name: "Blocker", team: PBTypes.TeamVals.UPPER });
            standAt(setup.grid, setup.unitsHolder, blocker, blockedCell);

            const result = setup.engine.apply({
                type: "move_unit",
                unitId: mover.getId(),
                path: [from, step, to],
                targetCells,
            });

            expect(result.completed).toBe(false);
            expect(result.rejectionReason).toBe("move_blocked");
            expect(mover.getBaseCell()).toEqual(from);
            expect(sortCells(setup.grid.getRegisteredCells(mover.getId()))).toEqual(
                sortCells(getFootprintCellsForAnchor(from, width, height)),
            );
        });
    }

    it("resolveMoveTargetCells anchors every shape on the route's last cell", () => {
        const destination = { x: 4, y: 5 };
        const path = [{ x: 3, y: 5 }, destination];

        expect(resolveMoveTargetCells(true, path)).toEqual([destination]);
        // The route's last cell is an ANCHOR — moveUnit hands the same cell to resolveKnownMoveRoute, which
        // looks it up as a knownPaths key, and those keys are anchors. The large branch used to grow +dx/+dy
        // from it instead, i.e. read it as the block's bottom-left cell; nothing live ever took that path
        // because every move_unit producer supplies targetCells explicitly.
        expect(sortCells(resolveMoveTargetCells(false, path))).toEqual(
            sortCells(getFootprintCellsForAnchor(destination, 2, 2)),
        );
        expect(resolveMoveTargetCells(false, path, undefined, 2, 2)).toEqual(resolveMoveTargetCells(false, path));
    });

    it("resolveMoveTargetCells anchors a rectangle on the route's last cell", () => {
        const destination = { x: 4, y: 5 };
        const path = [{ x: 3, y: 5 }, destination];

        expect(sortCells(resolveMoveTargetCells(false, path, undefined, 1, 2))).toEqual(
            sortCells([
                { x: 4, y: 5 },
                { x: 4, y: 4 },
            ]),
        );
        expect(sortCells(resolveMoveTargetCells(false, path, undefined, 2, 1))).toEqual(
            sortCells([
                { x: 4, y: 5 },
                { x: 3, y: 5 },
            ]),
        );
        // A supplied footprint always wins, whatever the shape.
        const supplied = [
            { x: 9, y: 9 },
            { x: 9, y: 8 },
        ];
        expect(resolveMoveTargetCells(false, path, supplied, 1, 2)).toEqual(supplied);
    });

    it("isMovePathFootprintOnly stays false for a single-cell body and true for a matching footprint", () => {
        const cells = [
            { x: 4, y: 5 },
            { x: 4, y: 4 },
        ];
        expect(isMovePathFootprintOnly(true, [{ x: 4, y: 5 }], [{ x: 4, y: 5 }])).toBe(false);
        expect(isMovePathFootprintOnly(false, cells, cells, 1, 2)).toBe(true);
        expect(isMovePathFootprintOnly(false, [{ x: 4, y: 5 }], cells, 1, 2)).toBe(false);
        // A 1x1 declared through its real footprint is still not a footprint-only move.
        expect(isMovePathFootprintOnly(false, [{ x: 4, y: 5 }], [{ x: 4, y: 5 }], 1, 1)).toBe(false);
    });

    it("the move set comparison separates cells a packed 4-bit key would have merged", () => {
        // Footprint lists are UNCLIPPED, so an edge-anchored body reports off-board cells and a set keyed by
        // `(x << 4) | y` stops being one-to-one: (0, 16) and (1, 0) pack to the same number, and (-1, 15)
        // packs to -1 like nothing else does only by luck of the sign bit.
        expect(isMovePathFootprintOnly(false, [{ x: 1, y: 0 }], [{ x: 0, y: 16 }], 2, 1)).toBe(false);
        expect(isMovePathFootprintOnly(false, [{ x: 0, y: 16 }], [{ x: 0, y: 16 }], 2, 1)).toBe(true);
        expect(
            isMovePathFootprintOnly(
                false,
                [
                    { x: -1, y: 3 },
                    { x: 0, y: 3 },
                ],
                [
                    { x: -1, y: 3 },
                    { x: 0, y: 3 },
                ],
                2,
                1,
            ),
        ).toBe(true);
    });

    it("resolveMoveTraversal reads the mover's own footprint rather than its size bit", () => {
        const mover = createFootprintUnit(1, 2);
        const anchor = { x: 6, y: 6 };
        const position = footprintCentre(anchor, 1, 2);
        mover.setPosition(position.x, position.y);
        const action: MoveUnitAction = {
            type: "move_unit",
            unitId: mover.getId(),
            path: [anchor, { x: 7, y: 6 }],
        };

        const traversal = resolveMoveTraversal(mover, action);

        expect(sortCells(traversal.targetCells)).toEqual(
            sortCells([
                { x: 7, y: 6 },
                { x: 7, y: 5 },
            ]),
        );
        expect(traversal.pathIsFootprintOnly).toBe(false);
        expect(traversal.travelledPath).toEqual([{ x: 7, y: 6 }]);
    });
});

describe("action engine footprints — summoning", () => {
    const summonAnchor: XY = { x: 6, y: 6 };

    const summonSetup = (width: number, height: number) => {
        const caster = createFootprintUnit(1, 1, { name: "Summoner", spells: ["Nature:Summon Wolves"] });
        let summoned: Unit | undefined;
        const setup = fightEngine(caster, {
            createSummonedUnit: ({ team, unitName, amount }) => {
                summoned = createFootprintUnit(width, height, {
                    name: unitName,
                    team,
                    amountAlive: amount,
                    summoned: true,
                });
                return summoned;
            },
        });
        standAt(setup.grid, setup.unitsHolder, caster, { x: 2, y: 2 });
        return { ...setup, caster, getSummoned: () => summoned };
    };

    for (const [width, height] of SHAPES) {
        const label = `${width}x${height}`;

        it(`${label}: a summoned body reserves its whole footprint and reports its anchor`, () => {
            const setup = summonSetup(width, height);

            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.caster.getId(),
                spellName: "Summon Wolves",
                targetCell: summonAnchor,
            });

            expect(result.completed).toBe(true);
            const summoned = setup.getSummoned()!;
            expect(summoned.getBaseCell()).toEqual(summonAnchor);
            const cells = getFootprintCellsForAnchor(summonAnchor, width, height);
            expect(sortCells(setup.grid.getRegisteredCells(summoned.getId()))).toEqual(sortCells(cells));
            for (const cell of cells) {
                expect(setup.grid.getOccupantUnitId(cell)).toBe(summoned.getId());
            }
            // The cast event names where the spell LANDED, which is the summoned body's anchor — never
            // whichever cell of the footprint happened to be listed first.
            expect(result.events).toContainEqual(
                expect.objectContaining({ type: "spell_cast", targetCell: summonAnchor }),
            );
            expect(result.events).toContainEqual(
                expect.objectContaining({ type: "unit_summoned", unitId: summoned.getId(), merged: false }),
            );
        });

        it(`${label}: refuses the cast when part of the body has nowhere to stand`, () => {
            const setup = summonSetup(width, height);
            const cells = getFootprintCellsForAnchor(summonAnchor, width, height);
            const blockedCell = cells[cells.length - 1];
            const blocker = createFootprintUnit(1, 1, { name: "Blocker", team: PBTypes.TeamVals.UPPER });
            standAt(setup.grid, setup.unitsHolder, blocker, blockedCell);

            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.caster.getId(),
                spellName: "Summon Wolves",
                targetCell: summonAnchor,
            });

            expect(result.completed).toBe(false);
            expect(result.rejectionReason).toBe("spell_not_available");
            // A refused cast spends nothing: the charge is still there and the turn is not over.
            expect(setup.caster.hasSpellRemaining("Summon Wolves")).toBe(true);
            expect(setup.fightProperties.hasAlreadyMadeTurn(setup.caster.getId())).toBe(false);
        });
    }
});

describe("action engine footprints — splitting", () => {
    const donorAnchor: XY = { x: 6, y: 6 };

    const splitSetup = (width: number, height: number) => {
        const donor = createFootprintUnit(width, height, { name: "Donor", amountAlive: 7 });
        let peeled: Unit | undefined;
        const setup = placementEngine({
            canSplitUnit: () => true,
            createSplitUnit: (sourceUnit, amount) => {
                peeled = createFootprintUnit(width, height, {
                    name: sourceUnit.getName(),
                    team: sourceUnit.getTeam(),
                    amountAlive: amount,
                });
                return peeled;
            },
        });
        standAt(setup.grid, setup.unitsHolder, donor, donorAnchor);
        return { ...setup, donor, getPeeled: () => peeled };
    };

    for (const [width, height] of SHAPES) {
        const label = `${width}x${height}`;

        it(`${label}: places the peeled stack on an explicitly named footprint`, () => {
            const setup = splitSetup(width, height);
            const target = { x: 10, y: 10 };
            const cells = getFootprintCellsForAnchor(target, width, height);

            const result = setup.engine.apply({
                type: "split_unit",
                unitId: setup.donor.getId(),
                amount: 3,
                cells,
            });

            expect(result.completed).toBe(true);
            const peeled = setup.getPeeled()!;
            expect(peeled.getBaseCell()).toEqual(target);
            expect(sortCells(setup.grid.getRegisteredCells(peeled.getId()))).toEqual(sortCells(cells));
            expect(setup.donor.getAmountAlive()).toBe(4);
            expect(result.events).toContainEqual(
                expect.objectContaining({ type: "unit_placed", unitId: peeled.getId(), cells }),
            );
        });

        it(`${label}: drops a cell-less split on a legal footprint touching the donor`, () => {
            const setup = splitSetup(width, height);

            const result = setup.engine.apply({ type: "split_unit", unitId: setup.donor.getId(), amount: 3 });

            expect(result.completed).toBe(true);
            const peeled = setup.getPeeled()!;
            const placed = result.events.find((event) => event.type === "unit_placed");
            expect(placed).toBeDefined();
            const cells = (placed as Extract<GameEvent, { type: "unit_placed" }>).cells;
            // The landing is the peeled stack's OWN rectangle, anchored the way the rest of the engine
            // anchors a body — not a block grown from the candidate towards +x/+y.
            expect(sortCells(cells)).toEqual(
                sortCells(getFootprintCellsForAnchor(peeled.getBaseCell(), width, height)),
            );
            expect(cells).toHaveLength(width * height);

            const donorKeys = new Set(setup.donor.getCells().map(cellKey));
            expect(cells.some((cell) => donorKeys.has(cellKey(cell)))).toBe(false);
            const touchesDonor = cells.some((cell) =>
                setup.donor
                    .getCells()
                    .some(
                        (donorCell) => Math.max(Math.abs(donorCell.x - cell.x), Math.abs(donorCell.y - cell.y)) === 1,
                    ),
            );
            expect(touchesDonor).toBe(true);
            for (const cell of cells) {
                expect(cell.x).toBeGreaterThanOrEqual(0);
                expect(cell.y).toBeGreaterThanOrEqual(0);
                expect(cell.x).toBeLessThan(GRID_SIZE);
                expect(cell.y).toBeLessThan(GRID_SIZE);
                expect(setup.grid.getOccupantUnitId(cell)).toBe(peeled.getId());
            }
        });

        it(`${label}: refuses an explicit split target of a different shape and keeps the donor whole`, () => {
            const setup = splitSetup(width, height);
            const [otherWidth, otherHeight] = transposed(width, height);

            const result = setup.engine.apply({
                type: "split_unit",
                unitId: setup.donor.getId(),
                amount: 3,
                cells: getFootprintCellsForAnchor({ x: 10, y: 10 }, otherWidth, otherHeight),
            });

            expect(result.completed).toBe(false);
            expect(result.rejectionReason).toBe("invalid_placement");
            expect(setup.donor.getAmountAlive()).toBe(7);
            expect(setup.unitsHolder.getAllUnits().size).toBe(1);
        });
    }
});

describe("action engine footprints — infested spawn on a corpse", () => {
    type CleanupHarness = { cleanupDeadUnits(unitIds: string[], attributions: Map<string, Unit>): GameEvent[] };

    const infestSetup = (corpse: readonly [number, number], spawn: readonly [number, number]) => {
        const killer = createFootprintUnit(1, 1, { name: "Infester", abilities: ["Infest"] });
        const victim = createFootprintUnit(corpse[0], corpse[1], {
            name: "Victim",
            team: PBTypes.TeamVals.UPPER,
            level: PBTypes.UnitLevelVals.FIRST,
        });
        let spawned: Unit | undefined;
        const setup = fightEngine(killer, {
            createSummonedUnit: ({ team, unitName }) => {
                spawned = createFootprintUnit(spawn[0], spawn[1], { name: unitName, team, summoned: true });
                return spawned;
            },
        });
        standAt(setup.grid, setup.unitsHolder, killer, { x: 2, y: 2 });
        standAt(setup.grid, setup.unitsHolder, victim, { x: 8, y: 8 });
        victim.applyDamage(1000, 0, new SceneLogMock());
        const cleanup = (setup.engine as unknown as CleanupHarness).cleanupDeadUnits.bind(setup.engine);
        return { ...setup, killer, victim, cleanup, getSpawned: () => spawned };
    };

    it("reuses the corpse's cells when the spawn is the same shape", () => {
        const setup = infestSetup([1, 2], [1, 2]);
        const corpseCells = sortCells(setup.victim.getCells());

        setup.cleanup([setup.victim.getId()], new Map([[setup.victim.getId(), setup.killer]]));

        const spawned = setup.getSpawned()!;
        expect(sortCells(setup.grid.getRegisteredCells(spawned.getId()))).toEqual(corpseCells);
    });

    it("re-anchors on the corpse's anchor when the shapes differ but the cell COUNT agrees", () => {
        // A 2x1 corpse and a 1x2 spawn both cover two cells, so the old length test called them the same
        // shape and handed the corpse's own cells to a body that cannot stand on them.
        const setup = infestSetup([2, 1], [1, 2]);
        const corpseAnchor = setup.victim.getBaseCell();

        setup.cleanup([setup.victim.getId()], new Map([[setup.victim.getId(), setup.killer]]));

        const spawned = setup.getSpawned()!;
        expect(spawned.getBaseCell()).toEqual(corpseAnchor);
        expect(sortCells(setup.grid.getRegisteredCells(spawned.getId()))).toEqual(
            sortCells(getFootprintCellsForAnchor(corpseAnchor, 1, 2)),
        );
    });

    it("anchors a single-cell spawn on a large corpse's anchor cell", () => {
        const setup = infestSetup([2, 2], [1, 1]);
        const corpseAnchor = setup.victim.getBaseCell();

        setup.cleanup([setup.victim.getId()], new Map([[setup.victim.getId(), setup.killer]]));

        const spawned = setup.getSpawned()!;
        expect(spawned.getBaseCell()).toEqual(corpseAnchor);
        expect(setup.grid.getOccupantUnitId(corpseAnchor)).toBe(spawned.getId());
    });
});

describe("route-vs-footprint tie-break (the one ambiguous wire encoding)", () => {
    // A 2x1 stepping one cell along its anchor axis: the route [(current),(dest)] and the destination
    // footprint [(dest),(current)] are the same SET. The current anchor separates them — a route begins
    // at the mover's anchor, a footprint payload at the destination's — so route modifiers must run and
    // Fire Wall must charge only the ENTERED cell, never the one the body already stood on.
    it("classifies a 2x1's one-step anchor-axis move as a ROUTE, not a footprint payload", () => {
        const currentAnchor = { x: 5, y: 5 };
        const destination = { x: 6, y: 5 };
        const route = [currentAnchor, destination];
        const footprintPayload = getFootprintCellsForAnchor(destination, 2, 1);
        // Same set, different first element — precondition of the ambiguity.
        expect([...route].sort((a, b) => a.x - b.x)).toEqual([...footprintPayload].sort((a, b) => a.x - b.x));
        expect(isMovePathFootprintOnly(false, route, footprintPayload, 2, 1, currentAnchor)).toBe(false);
        // The genuine footprint-only encoding (payload used AS the path) keeps its legacy reading.
        expect(isMovePathFootprintOnly(false, footprintPayload, footprintPayload, 2, 1, currentAnchor)).toBe(true);
        // Without the anchor the legacy set reading is preserved for wire compatibility.
        expect(isMovePathFootprintOnly(false, route, footprintPayload, 2, 1)).toBe(true);
    });

    it("classifies a 1x2's one-step anchor-axis move as a ROUTE symmetrically", () => {
        const currentAnchor = { x: 5, y: 5 };
        const destination = { x: 5, y: 6 };
        const route = [currentAnchor, destination];
        const footprintPayload = getFootprintCellsForAnchor(destination, 1, 2);
        expect(isMovePathFootprintOnly(false, route, footprintPayload, 1, 2, currentAnchor)).toBe(false);
    });
});
