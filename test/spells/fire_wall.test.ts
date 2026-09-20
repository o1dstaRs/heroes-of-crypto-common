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
import { Grid } from "../../src/grid/grid";
import { PathHelper } from "../../src/grid/path_helper";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { NUMBER_OF_LAPS_TOTAL } from "../../src/constants";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Spell } from "../../src/spells/spell";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";
import {
    FIRE_WALL_ANCHOR_INDEX,
    FIRE_WALL_CROSS_PENALTY,
    FIRE_WALL_LENGTH,
    FIRE_WALL_ORIENTATIONS,
    FireWalls,
    FireWallOrientation,
    fireWallBurnDamage,
    fireWallBurnPercentage,
    fireWallCells,
    fireWallLitCells,
    isFireWallableCell,
    nextFireWallOrientation,
    normalizeFireWallOrientation,
} from "../../src/spells/fire_walls";

// A fire wall lays terrain, and terrain is priced in the pathfinder — so the numbers below ARE the feature.
// Entering a burning cell costs one extra step, which doubles the price of a plain step. Unlike a vine, the
// flames do not spare flyers.
describe("Fire Wall movement costs", () => {
    const settings = simulationGridSettings();
    const START = { x: 8, y: 8 };

    const fireWalls = () => FightStateManager.getInstance().getFightProperties().getFireWalls();

    afterEach(() => {
        fireWalls().clear();
    });

    // Cost of the cheapest route to `cell`, read out of the weighted route the pathfinder kept.
    const costTo = (cell: { x: number; y: number }, canFly: boolean): number | undefined => {
        const grid = new Grid(settings, PBTypes.GridVals.NORMAL);
        const path = new PathHelper(settings).getMovePath(
            START,
            grid.getMatrix(),
            /* maxSteps */ 8,
            /* aggrBoard */ undefined,
            canFly,
            /* isSmallUnit */ true,
            /* isMadeOfFire */ false,
            /* hasVineStride */ false,
        );
        const routes = path.knownPaths.get((cell.x << 4) | cell.y);
        if (!routes?.length) {
            return undefined;
        }
        return Math.min(...routes.map((r) => r.weight));
    };

    it("charges a walker one plain step for a clear cell", () => {
        expect(costTo({ x: 9, y: 8 }, false)).toBeCloseTo(1, 5);
    });

    it("doubles the cost of a plain step into a burning cell", () => {
        fireWalls().add({ x: 9, y: 8 });
        expect(costTo({ x: 9, y: 8 }, false)).toBeCloseTo(1 + FIRE_WALL_CROSS_PENALTY, 5);
    });

    // The difference from a vine, and the reason the penalty sits outside vineAdjustedCost's canFly check:
    // there is no stepping over a sheet of flame.
    it("charges a flyer the same toll as a walker", () => {
        fireWalls().add({ x: 9, y: 8 });
        expect(costTo({ x: 9, y: 8 }, true)).toBeCloseTo(1 + FIRE_WALL_CROSS_PENALTY, 5);
    });

    it("adds the toll on top of the diagonal surcharge", () => {
        const diagonal = { x: 9, y: 9 };
        expect(costTo(diagonal, false)).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST, 5);
        fireWalls().add(diagonal);
        expect(costTo(diagonal, false)).toBeCloseTo(PathHelper.DIAGONAL_MOVE_COST + FIRE_WALL_CROSS_PENALTY, 5);
    });

    it("charges once per burning cell along a route", () => {
        fireWalls().add({ x: 9, y: 8 });
        fireWalls().add({ x: 10, y: 8 });
        expect(costTo({ x: 10, y: 8 }, false)).toBeCloseTo(2 + 2 * FIRE_WALL_CROSS_PENALTY, 5);
    });

    it("leaves a clear cell alone while a wall burns elsewhere", () => {
        fireWalls().add({ x: 4, y: 4 });
        expect(costTo({ x: 9, y: 8 }, false)).toBeCloseTo(1, 5);
    });
});

// The wall pivots about the cell under the cursor: four cells has no middle one, so the anchor is the cell
// just past the middle — two cells lie before it along the wall and one after (owner call 2026-09-19: 4x1).
describe("fireWallCells", () => {
    it("is four cells long, anchored on the third", () => {
        expect(FIRE_WALL_LENGTH).toBe(4);
        expect(FIRE_WALL_ANCHOR_INDEX).toBe(2);
    });

    it("lays four cells horizontally by default, two before the anchor and one after", () => {
        expect(fireWallCells({ x: 5, y: 5 }, FireWallOrientation.HORIZONTAL)).toEqual([
            { x: 3, y: 5 },
            { x: 4, y: 5 },
            { x: 5, y: 5 },
            { x: 6, y: 5 },
        ]);
    });

    it("lays four cells vertically", () => {
        expect(fireWallCells({ x: 5, y: 5 }, FireWallOrientation.VERTICAL)).toEqual([
            { x: 5, y: 3 },
            { x: 5, y: 4 },
            { x: 5, y: 5 },
            { x: 5, y: 6 },
        ]);
    });

    it("lays both diagonals", () => {
        expect(fireWallCells({ x: 5, y: 5 }, FireWallOrientation.DIAGONAL_UP)).toEqual([
            { x: 3, y: 3 },
            { x: 4, y: 4 },
            { x: 5, y: 5 },
            { x: 6, y: 6 },
        ]);
        expect(fireWallCells({ x: 5, y: 5 }, FireWallOrientation.DIAGONAL_DOWN)).toEqual([
            { x: 3, y: 7 },
            { x: 4, y: 6 },
            { x: 5, y: 5 },
            { x: 6, y: 4 },
        ]);
    });

    it("keeps the anchor cell at the same place in the line in every orientation", () => {
        for (const orientation of FIRE_WALL_ORIENTATIONS) {
            const cells = fireWallCells({ x: 7, y: 3 }, orientation);
            expect(cells).toHaveLength(FIRE_WALL_LENGTH);
            expect(cells[FIRE_WALL_ANCHOR_INDEX]).toEqual({ x: 7, y: 3 });
        }
    });
});

describe("fire wall orientation cycling", () => {
    it("returns to the start after a full turn", () => {
        let orientation = FireWallOrientation.HORIZONTAL;
        for (let i = 0; i < FIRE_WALL_ORIENTATIONS.length; i++) {
            orientation = nextFireWallOrientation(orientation);
        }
        expect(orientation).toBe(FireWallOrientation.HORIZONTAL);
    });

    // A malformed or absent value from the wire must fall back to the default lay, never index off the end.
    it("normalizes junk to the default horizontal lay", () => {
        expect(normalizeFireWallOrientation(undefined)).toBe(FireWallOrientation.HORIZONTAL);
        expect(normalizeFireWallOrientation(Number.NaN)).toBe(FireWallOrientation.HORIZONTAL);
        expect(normalizeFireWallOrientation(4)).toBe(FireWallOrientation.HORIZONTAL);
        expect(normalizeFireWallOrientation(-1)).toBe(FireWallOrientation.DIAGONAL_UP);
        expect(normalizeFireWallOrientation(7)).toBe(FireWallOrientation.DIAGONAL_UP);
    });
});

describe("fireWallBurnDamage", () => {
    it("takes a quarter of the stack's cumulative maximum health", () => {
        expect(fireWallBurnDamage(1200)).toBe(300);
        expect(fireWallBurnDamage(60)).toBe(15);
    });

    it("always lands at least one point on a living stack", () => {
        expect(fireWallBurnDamage(2)).toBe(1);
    });

    it("burns nothing off an empty or nonsense stack", () => {
        expect(fireWallBurnDamage(0)).toBe(0);
        expect(fireWallBurnDamage(-10)).toBe(0);
        expect(fireWallBurnDamage(Number.NaN)).toBe(0);
    });
});

describe("FireWalls store", () => {
    it("burns out a cell once its laps run down", () => {
        const walls = new FireWalls();
        walls.addAll(fireWallCells({ x: 5, y: 5 }, FireWallOrientation.HORIZONTAL), 2);
        expect(walls.size()).toBe(FIRE_WALL_LENGTH);

        expect(walls.minusAllLaps()).toEqual([]);
        expect(walls.size()).toBe(FIRE_WALL_LENGTH);

        const expired = walls.minusAllLaps();
        expect(expired).toHaveLength(FIRE_WALL_LENGTH);
        expect(walls.size()).toBe(0);
    });

    // Unlike smoke, fire is not put out by whoever is standing in it — that is the whole point of a wall.
    it("keeps burning under a creature", () => {
        const walls = new FireWalls();
        walls.add({ x: 2, y: 2 }, 3);
        expect(walls.has({ x: 2, y: 2 })).toBe(true);
        expect(walls.minusAllLaps()).toEqual([]);
        expect(walls.has({ x: 2, y: 2 })).toBe(true);
    });

    it("refreshes rather than stacks when re-cast over a burning cell", () => {
        const walls = new FireWalls();
        walls.add({ x: 2, y: 2 }, 1);
        walls.add({ x: 2, y: 2 }, 3);
        expect(walls.size()).toBe(1);
        expect(walls.minusAllLaps()).toEqual([]);
    });

    it("round-trips through JSON for the fight snapshot", () => {
        const walls = new FireWalls();
        walls.addAll(fireWallCells({ x: 6, y: 6 }, FireWallOrientation.VERTICAL), 3);
        const restored = FireWalls.fromJSON(walls.toJSON());
        expect(restored.cells().sort((a, b) => a.y - b.y)).toEqual(
            fireWallCells({ x: 6, y: 6 }, FireWallOrientation.VERTICAL),
        );
    });
});

describe("isFireWallableCell", () => {
    const grid = (occupant?: string) => ({ getOccupantUnitId: () => occupant });

    it("refuses anything off the board", () => {
        expect(isFireWallableCell(grid(), false, { x: 0, y: 0 })).toBe(false);
    });

    it("takes an empty cell", () => {
        expect(isFireWallableCell(grid(), true, { x: 3, y: 3 })).toBe(true);
    });

    it("sits over lava and water", () => {
        expect(isFireWallableCell(grid("L"), true, { x: 3, y: 3 })).toBe(true);
        expect(isFireWallableCell(grid("W"), true, { x: 3, y: 3 })).toBe(true);
    });

    // Refusing an occupied cell is what stops the wall from being dropped on a body for free damage.
    it("refuses a cell with a creature, the mountain or a narrowed-away cell", () => {
        expect(isFireWallableCell(grid("some-unit-id"), true, { x: 3, y: 3 })).toBe(false);
        expect(isFireWallableCell(grid("B"), true, { x: 3, y: 3 })).toBe(false);
        expect(isFireWallableCell(grid("H"), true, { x: 3, y: 3 })).toBe(false);
    });
});

// The wall goes anywhere; what it LIGHTS is the free part of the line (owner call 2026-09-19).
describe("fireWallLitCells", () => {
    const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
    const gridWith = (occupants: Record<string, string>) => ({
        getOccupantUnitId: (cell: { x: number; y: number }) => occupants[key(cell)],
    });
    const within = (c: { x: number; y: number }) => c.x >= 0 && c.y >= 0 && c.x < 16 && c.y < 16;

    it("lights the whole line when every cell is free", () => {
        expect(fireWallLitCells(gridWith({}), within, { x: 5, y: 5 }, FireWallOrientation.HORIZONTAL)).toEqual(
            fireWallCells({ x: 5, y: 5 }, FireWallOrientation.HORIZONTAL),
        );
    });

    it("skips a creature, the mountain and a narrowed cell but lights the rest, in wall order", () => {
        const grid = gridWith({ "3,5": "some-unit-id", "5,5": "B", "6,5": "H" });
        expect(fireWallLitCells(grid, within, { x: 5, y: 5 }, FireWallOrientation.HORIZONTAL)).toEqual([
            { x: 4, y: 5 },
        ]);
    });

    it("still burns over lava and water", () => {
        const grid = gridWith({ "4,5": "L", "5,5": "W" });
        expect(fireWallLitCells(grid, within, { x: 5, y: 5 }, FireWallOrientation.HORIZONTAL)).toHaveLength(
            FIRE_WALL_LENGTH,
        );
    });

    it("drops the part of the line that runs off the board", () => {
        expect(fireWallLitCells(gridWith({}), within, { x: 0, y: 5 }, FireWallOrientation.HORIZONTAL)).toEqual([
            { x: 0, y: 5 },
            { x: 1, y: 5 },
        ]);
    });

    it("is empty when nothing on the line can burn", () => {
        expect(fireWallLitCells(gridWith({}), within, { x: -5, y: 5 }, FireWallOrientation.HORIZONTAL)).toEqual([]);
        const bodies = gridWith({ "3,5": "u1", "4,5": "u2", "5,5": "u3", "6,5": "u4" });
        expect(fireWallLitCells(bodies, within, { x: 5, y: 5 }, FireWallOrientation.HORIZONTAL)).toEqual([]);
    });
});

/**
 * The whole feature end to end through the action engine: the cast that lays the wall, and the walk that
 * pays for crossing it. The unit tests above pin the geometry and the pathfinder price; these pin that the
 * engine actually wires them to a spell and to a move.
 */
describe("Fire Wall through the action engine", () => {
    const setup = (opts: { casterSpells?: string[]; casterStackPower?: number; moverMaxHp?: number } = {}) => {
        const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.NORMAL);
        fightProperties.getFireWalls().clear();
        fightProperties.startFight();

        const caster = createTestUnit({
            name: "Nightmare",
            team: PBTypes.TeamVals.LEFT,
            initiative: 5,
            morale: 4,
            spells: opts.casterSpells ?? ["Chaos:Fire Wall"],
            // Fire Wall's minimal_caster_stack_power is 4.
            stackPower: opts.casterStackPower ?? 4,
        });
        const enemy = createTestUnit({
            name: "Upper",
            team: PBTypes.TeamVals.RIGHT,
            initiative: 3,
            morale: 4,
            maxHp: opts.moverMaxHp ?? 20,
            amountAlive: 10,
        });
        placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, enemy, { x: 9, y: 9 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

        let active = caster;
        const sceneLog = new SceneLogMock();
        const engine = new GameActionEngine({
            fightProperties,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
            sceneLog,
            attackHandler: context.attackHandler,
            getCurrentActiveUnitId: () => active.getId(),
            runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
        });
        return {
            ...context,
            fightProperties,
            caster,
            enemy,
            engine,
            sceneLog,
            setActive: (u: typeof caster) => {
                active = u;
            },
        };
    };

    afterEach(() => {
        FightStateManager.getInstance().getFightProperties().getFireWalls().clear();
    });

    it("lights the four cells of the requested orientation and reports them", () => {
        const s = setup();
        const anchor = { x: 6, y: 6 };

        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            spellName: "Fire Wall",
            targetCell: anchor,
            targetOrientation: FireWallOrientation.VERTICAL,
        });

        expect(result.completed).toBe(true);
        const expected = fireWallCells(anchor, FireWallOrientation.VERTICAL);
        for (const cell of expected) {
            expect(s.fightProperties.getFireWalls().has(cell)).toBe(true);
        }
        expect(result.events).toContainEqual(
            expect.objectContaining({ type: "fire_wall_placed", casterId: s.caster.getId(), cells: expected }),
        );
        expect(s.caster.hasSpellRemaining("Fire Wall")).toBe(false);
    });

    it("bakes the additive augment + Empower spell + Sylvan Focus bonus into every wall cell", () => {
        const s = setup();
        const satyr = createTestUnit({
            name: "Satyr",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Sylvan Focus Aura"],
            auraEffects: ["Sylvan Focus"],
            auraRanges: [2],
            auraIsBuff: [true],
        });
        placeUnit(s.grid, s.unitsHolder, satyr, { x: 2, y: 3 });
        s.unitsHolder.refreshAuraEffectsForAllUnits();

        const augment = new Spell({
            spellProperties: getSpellConfig("System", "Empower Augment", NUMBER_OF_LAPS_TOTAL),
            amount: 1,
        });
        augment.setPower(7);
        s.caster.applyBuff(augment);
        s.caster.applyBuff(
            new Spell({
                spellProperties: getSpellConfig("Chaos", "Empower", NUMBER_OF_LAPS_TOTAL),
                amount: 1,
            }),
        );
        expect(s.caster.getMagicDamageBonusPercentage()).toBe(47);

        const anchor = { x: 6, y: 6 };
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            spellName: "Fire Wall",
            targetCell: anchor,
        });
        expect(result.completed).toBe(true);
        expect(s.fightProperties.getFireWalls().burnPercentageAt(anchor)).toBe(fireWallBurnPercentage(47));
        expect(s.fightProperties.getFireWalls().burnPercentageAt(anchor)).toBe(36.8);
    });

    it("falls back to the default horizontal lay when no orientation is sent", () => {
        const s = setup();
        const anchor = { x: 6, y: 6 };

        expect(
            s.engine.apply({
                type: "cast_spell",
                casterId: s.caster.getId(),
                spellName: "Fire Wall",
                targetCell: anchor,
            }).completed,
        ).toBe(true);
        expect(
            s.fightProperties
                .getFireWalls()
                .cells()
                .sort((a, b) => a.x - b.x),
        ).toEqual(fireWallCells(anchor, FireWallOrientation.HORIZONTAL));
    });

    // Not all-or-nothing (owner call 2026-09-19): the wall goes anywhere and lights the free cells of its
    // line. A body under one cell leaves that cell unlit — the flames never land on a creature for free
    // damage — and the rest of the line burns. What the aim preview highlights is exactly what lands.
    it("lights the free cells of the line and skips the one a creature stands on", () => {
        const s = setup();
        // The enemy stands at (9,9); a horizontal wall anchored at (8,9) runs (6..9, 9) and covers it.
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            spellName: "Fire Wall",
            targetCell: { x: 8, y: 9 },
            targetOrientation: FireWallOrientation.HORIZONTAL,
        });

        expect(result.completed).toBe(true);
        const lit = [
            { x: 6, y: 9 },
            { x: 7, y: 9 },
            { x: 8, y: 9 },
        ];
        expect(s.fightProperties.getFireWalls().cells()).toEqual(lit);
        expect(s.fightProperties.getFireWalls().has({ x: 9, y: 9 })).toBe(false);
        expect(result.events).toContainEqual(
            expect.objectContaining({ type: "fire_wall_placed", casterId: s.caster.getId(), cells: lit }),
        );
        expect(s.caster.hasSpellRemaining("Fire Wall")).toBe(false);
    });

    it("lights the on-board part of a line that runs off the field edge", () => {
        const s = setup();
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            spellName: "Fire Wall",
            targetCell: { x: 0, y: 6 },
            targetOrientation: FireWallOrientation.HORIZONTAL,
        });

        expect(result.completed).toBe(true);
        expect(s.fightProperties.getFireWalls().cells()).toEqual([
            { x: 0, y: 6 },
            { x: 1, y: 6 },
        ]);
    });

    // The one placement still refused: a charge that would light nothing is a charge wasted.
    it("refuses a cast whose line lights nothing, and keeps the charge", () => {
        const s = setup();
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            spellName: "Fire Wall",
            targetCell: { x: 40, y: 40 },
            targetOrientation: FireWallOrientation.HORIZONTAL,
        });

        expect(result.completed).toBe(false);
        expect(s.fightProperties.getFireWalls().size()).toBe(0);
        expect(s.caster.hasSpellRemaining("Fire Wall")).toBe(true);
    });

    it("refuses the cast below the spell's minimal stack power", () => {
        const s = setup({ casterStackPower: 1 });
        const result = s.engine.apply({
            type: "cast_spell",
            casterId: s.caster.getId(),
            spellName: "Fire Wall",
            targetCell: { x: 6, y: 6 },
        });
        expect(result.completed).toBe(false);
        expect(s.fightProperties.getFireWalls().size()).toBe(0);
    });

    it("sears a creature that walks into the flames for a quarter of its maximum health", () => {
        const s = setup({ moverMaxHp: 20 });
        s.setActive(s.enemy);
        const burning = { x: 9, y: 8 };
        s.fightProperties.getFireWalls().add(burning, 3);

        const maxHp = s.enemy.getCumulativeMaxHp(); // 10 x 20 = 200
        const result = s.engine.apply({
            type: "move_unit",
            unitId: s.enemy.getId(),
            path: [burning],
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "fire_wall_burned",
                unitId: s.enemy.getId(),
                cells: [burning],
                amount: fireWallBurnDamage(maxHp),
            }),
        );
        expect(s.enemy.getCumulativeHp()).toBe(maxHp - fireWallBurnDamage(maxHp));
        // The wall keeps burning under whoever is standing in it — unlike smoke, it is not dispelled.
        expect(s.fightProperties.getFireWalls().has(burning)).toBe(true);
    });

    it("leaves a creature alone when its move never enters the flames", () => {
        const s = setup();
        s.setActive(s.enemy);
        s.fightProperties.getFireWalls().add({ x: 2, y: 2 }, 3);

        const result = s.engine.apply({
            type: "move_unit",
            unitId: s.enemy.getId(),
            path: [{ x: 9, y: 8 }],
        });

        expect(result.completed).toBe(true);
        expect(result.events.some((e) => e.type === "fire_wall_burned")).toBe(false);
        expect(s.enemy.getCumulativeHp()).toBe(s.enemy.getCumulativeMaxHp());
    });

    // An ATTACK carries its own move, and that move happens inside the attack handler rather than through
    // the move action — so the walls went unread and walking into the flames to swing was free (owner report
    // 2026-09-18 off staging game 0d3dc917: a Nightmare stepped into its own wall mid-attack, untouched).
    it("sears an attacker that walks into the flames to reach its target, before its blow lands", () => {
        const s = setup({ moverMaxHp: 20 });
        const victim = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 100,
            amountAlive: 10,
            // A harmless target keeps retaliation out of the health arithmetic below.
            damageMin: 0,
            damageMax: 0,
        });
        placeUnit(s.grid, s.unitsHolder, victim, { x: 7, y: 9 });
        s.setActive(s.enemy);
        const burning = { x: 8, y: 9 };
        s.fightProperties.getFireWalls().add(burning, 3);
        const maxHp = s.enemy.getCumulativeMaxHp(); // 10 x 20 = 200

        const result = s.engine.apply({
            type: "melee_attack",
            attackerId: s.enemy.getId(),
            targetId: victim.getId(),
            attackFrom: burning,
            path: [burning],
        });

        expect(result.completed).toBe(true);
        expect(result.events).toContainEqual(
            expect.objectContaining({
                type: "fire_wall_burned",
                unitId: s.enemy.getId(),
                cells: [burning],
                amount: fireWallBurnDamage(maxHp),
            }),
        );
        // Charged on ARRIVAL: the burn is reported before the blow the attacker walked in to deliver.
        const burnAt = result.events.findIndex((e) => e.type === "fire_wall_burned");
        const strikeAt = result.events.findIndex((e) => e.type === "unit_attacked");
        expect(burnAt).toBeGreaterThanOrEqual(0);
        expect(strikeAt).toBeGreaterThan(burnAt);
        // At least the burn: retaliation floors at one point however harmless the target is.
        expect(s.enemy.getCumulativeHp()).toBeLessThanOrEqual(maxHp - fireWallBurnDamage(maxHp));
    });

    it("lets a stack that dies crossing the wall land no blow at all", () => {
        const s = setup({ moverMaxHp: 20 });
        const victim = createTestUnit({ name: "Victim", team: PBTypes.TeamVals.LEFT, maxHp: 100, amountAlive: 10 });
        placeUnit(s.grid, s.unitsHolder, victim, { x: 7, y: 9 });
        s.setActive(s.enemy);
        const burning = { x: 8, y: 9 };
        s.fightProperties.getFireWalls().add(burning, 3);
        // The wall takes a quarter of the stack's CURRENT maximum (it shrinks as creatures die), so thin the
        // stack to one wounded creature: 20 max -> a 5-point burn against the 4 hit points left.
        s.enemy.applyDamage(s.enemy.getCumulativeMaxHp() - 4, 0, s.sceneLog);
        expect(s.enemy.getAmountAlive()).toBe(1);

        const result = s.engine.apply({
            type: "melee_attack",
            attackerId: s.enemy.getId(),
            targetId: victim.getId(),
            attackFrom: burning,
            path: [burning],
        });

        expect(result.completed).toBe(true);
        expect(result.events.some((e) => e.type === "fire_wall_burned")).toBe(true);
        expect(result.events.some((e) => e.type === "unit_attacked")).toBe(false);
        expect(s.enemy.isDead()).toBe(true);
        expect(victim.getCumulativeHp()).toBe(victim.getCumulativeMaxHp());
    });

    it("does not charge an attacker that was already standing in the fire and never moved", () => {
        const s = setup();
        const victim = createTestUnit({
            name: "Victim",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 100,
            amountAlive: 10,
            damageMin: 0,
            damageMax: 0,
        });
        placeUnit(s.grid, s.unitsHolder, victim, { x: 8, y: 9 });
        s.setActive(s.enemy);
        const standing = s.enemy.getBaseCell();
        s.fightProperties.getFireWalls().add(standing, 3);

        const result = s.engine.apply({
            type: "melee_attack",
            attackerId: s.enemy.getId(),
            targetId: victim.getId(),
            attackFrom: standing,
        });

        expect(result.completed).toBe(true);
        expect(result.events.some((e) => e.type === "fire_wall_burned")).toBe(false);
        // Only the one-point retaliation floor, nowhere near a quarter of maximum health.
        const maxHp = s.enemy.getCumulativeMaxHp();
        expect(maxHp - s.enemy.getCumulativeHp()).toBeLessThan(fireWallBurnDamage(maxHp));
    });

    // Standing in the fire at the start of a turn is not a crossing — only cells walked INTO are charged.
    it("does not re-burn a creature that starts its turn already in the fire", () => {
        const s = setup();
        s.setActive(s.enemy);
        const start = s.enemy.getBaseCell();
        s.fightProperties.getFireWalls().add({ x: start.x, y: start.y }, 3);

        const result = s.engine.apply({
            type: "move_unit",
            unitId: s.enemy.getId(),
            path: [
                { x: start.x, y: start.y },
                { x: start.x, y: start.y - 1 },
            ],
        });

        expect(result.completed).toBe(true);
        expect(result.events.some((e) => e.type === "fire_wall_burned")).toBe(false);
        expect(s.enemy.getCumulativeHp()).toBe(s.enemy.getCumulativeMaxHp());
    });
});
