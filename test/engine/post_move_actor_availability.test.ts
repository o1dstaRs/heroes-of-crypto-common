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

import { GameActionEngine } from "../../src/engine/action_engine";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { FireWalls } from "../../src/spells/fire_walls";
import type { GameAction } from "../../src/engine/actions";
import {
    bodyCellsEnteredAlongPath,
    enteredFireWallCells,
    projectPostMoveActorAvailability,
    resolveMoveTraversal,
} from "../../src/engine/post_move_actor_availability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { projectStackDamage, type IStackHpState } from "../../src/units/stack_damage";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
    type TestUnitOptions,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

function placeLarge(combat: CombatTestContext, unit: Unit, base: XY): void {
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) throw new Error("invalid LARGE placement");
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("Made of Water"),
    );
    combat.unitsHolder.addUnit(unit);
}

function activatedMover(
    options: TestUnitOptions,
    gridType = PBTypes.GridVals.NORMAL,
    base: XY = { x: 3, y: 3 },
): {
    combat: CombatTestContext;
    unit: Unit;
    engine: GameActionEngine;
} {
    const combat = createCombatTestContext(gridType);
    const unit = createTestUnit({
        team: LOWER,
        name: "Projected mover",
        initiative: 12,
        ...options,
    });
    const enemy = createTestUnit({ team: UPPER, name: "Projection witness" });
    if (unit.isSmallSize()) {
        placeUnit(combat.grid, combat.unitsHolder, unit, base);
    } else {
        placeLarge(combat, unit, base);
    }
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 14, y: 14 });

    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, 1);
    fightProperties.setTeamUnitsAlive(UPPER, 1);
    fightProperties.startTurn(LOWER, 1_000);
    const engine = new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
    });
    return { combat, unit, engine };
}

function applyAndCompare(
    setup: ReturnType<typeof activatedMover>,
    action: Extract<GameAction, { type: "move_unit" }>,
): ReturnType<typeof projectPostMoveActorAvailability> {
    const fireWalls = FightStateManager.getInstance().getFightProperties().getFireWalls();
    const projected = projectPostMoveActorAvailability(setup.unit, fireWalls, action);
    const result = setup.engine.apply(action);

    expect(result.completed).toBe(true);
    expect(setup.combat.unitsHolder.getAllUnits().has(setup.unit.getId())).toBe(projected.availableAfterMove);
    expect({
        hp: setup.unit.getHp(),
        maxHp: setup.unit.getMaxHp(),
        amountAlive: setup.unit.getAmountAlive(),
        amountDied: setup.unit.getAmountDied(),
    }).toEqual(projected.stack);
    const burn = result.events.find((event) => event.type === "fire_wall_burned");
    expect(burn?.amount ?? 0).toBe(projected.totalAppliedDamage);
    return projected;
}

/** Local transcription of the pre-extraction Unit.applyDamage arithmetic. */
function legacyStackDamage(
    state: IStackHpState,
    requestedDamage: number,
): {
    state: IStackHpState;
    appliedDamage: number;
    animationDeaths: number;
} {
    const next = { ...state };
    if (requestedDamage <= 0) return { state: next, appliedDamage: 0, animationDeaths: 0 };
    if (requestedDamage < next.hp) {
        next.hp -= requestedDamage;
        return { state: next, appliedDamage: requestedDamage, animationDeaths: 0 };
    }
    next.amountDied += 1;
    next.amountAlive -= 1;
    const remainingDamage = requestedDamage - next.hp;
    const frontHp = next.hp;
    next.hp = next.maxHp;
    const amountDied = Math.floor(remainingDamage / next.maxHp);
    if (amountDied >= next.amountAlive) {
        next.amountDied += next.amountAlive;
        const wereAlive = next.amountAlive;
        next.amountAlive = 0;
        return {
            state: next,
            appliedDamage: Math.floor(wereAlive * next.maxHp) + frontHp,
            animationDeaths: wereAlive,
        };
    }
    next.amountDied += amountDied;
    next.amountAlive -= amountDied;
    next.hp -= remainingDamage % next.maxHp;
    return {
        state: next,
        appliedDamage: remainingDamage + frontHp,
        animationDeaths: amountDied + 1,
    };
}

describe("post-move actor availability projection", () => {
    it("keeps the extracted stack transition byte-equivalent across partial, boundary, and lethal damage", () => {
        for (let amountAlive = 1; amountAlive <= 7; amountAlive += 1) {
            for (let maxHp = 1; maxHp <= 13; maxHp += 3) {
                for (let hp = 1; hp <= maxHp; hp += 1) {
                    const state = { hp, maxHp, amountAlive, amountDied: 9 - amountAlive };
                    const cumulativeHp = (amountAlive - 1) * maxHp + hp;
                    for (const damage of [0, 1, hp, hp + 1, maxHp, cumulativeHp - 1, cumulativeHp, cumulativeHp + 9]) {
                        const expected = legacyStackDamage(state, damage);
                        const actual = projectStackDamage(state, damage);
                        expect(actual.state).toEqual(expected.state);
                        expect(actual.appliedDamage).toBe(expected.appliedDamage);
                        expect(actual.animationDeaths).toBe(expected.animationDeaths);
                    }
                }
            }
        }
    });

    it("matches sequential stored-per-cell burns and excludes the starting cell", () => {
        const setup = activatedMover({ amountAlive: 5, maxHp: 20 });
        const start = setup.unit.getBaseCell();
        const walls = FightStateManager.getInstance().getFightProperties().getFireWalls();
        walls.add(start, 3, 100);
        walls.add({ x: 4, y: 3 }, 3, 10);
        walls.add({ x: 5, y: 3 }, 3, 20);
        walls.add({ x: 6, y: 3 }, 3, 30);
        const action = {
            type: "move_unit" as const,
            unitId: setup.unit.getId(),
            path: [start, { x: 4, y: 3 }, { x: 5, y: 3 }, { x: 6, y: 3 }],
        };

        const projected = applyAndCompare(setup, action);

        expect(projected.burningCells).toEqual([
            { x: 4, y: 3 },
            { x: 5, y: 3 },
            { x: 6, y: 3 },
        ]);
        expect(projected.fireWallHits.map((hit) => hit.burnPercentage)).toEqual([10, 20, 30]);
        expect(projected.fireWallHits.map((hit) => hit.requestedDamage)).toEqual([10, 20, 24]);
        expect(projected.stack).toEqual({ hp: 6, maxHp: 20, amountAlive: 3, amountDied: 2 });
    });

    it("deduplicates crossed wall cells in first-intersection order", () => {
        const walls = FightStateManager.getInstance().getFightProperties().getFireWalls();
        walls.clear();
        walls.add({ x: 4, y: 3 }, 3, 11);
        walls.add({ x: 5, y: 3 }, 3, 22);

        expect(
            enteredFireWallCells(walls, [
                { x: 4, y: 3 },
                { x: 4, y: 3 },
                { x: 5, y: 3 },
                { x: 4, y: 3 },
            ]),
        ).toEqual([
            { x: 4, y: 3 },
            { x: 5, y: 3 },
        ]);
    });

    it("matches lethal cleanup when no Resurrection charge remains", () => {
        const setup = activatedMover({ amountAlive: 1, maxHp: 10 });
        setup.unit.applyDamage(9, 0, new SceneLogMock());
        const burning = { x: 4, y: 3 };
        FightStateManager.getInstance().getFightProperties().getFireWalls().add(burning, 3, 25);

        const projected = applyAndCompare(setup, {
            type: "move_unit",
            unitId: setup.unit.getId(),
            path: [setup.unit.getBaseCell(), burning],
        });

        expect(projected.availableAfterMove).toBe(false);
        expect(projected.resurrected).toBe(false);
        expect(projected.totalAppliedDamage).toBe(1);
    });

    it("absorbs only the first wall hit with Water Shield, then projects the lethal second hit", () => {
        const setup = activatedMover({ amountAlive: 1, maxHp: 10, abilities: ["Water Shield"] });
        setup.unit.applyDamage(9, 0, new SceneLogMock());
        setup.unit.trySeedWaterShield();
        const walls = FightStateManager.getInstance().getFightProperties().getFireWalls();
        walls.add({ x: 4, y: 3 }, 3, 25);
        walls.add({ x: 5, y: 3 }, 3, 25);

        const projected = applyAndCompare(setup, {
            type: "move_unit",
            unitId: setup.unit.getId(),
            path: [setup.unit.getBaseCell(), { x: 4, y: 3 }, { x: 5, y: 3 }],
        });

        expect(projected.waterShieldConsumed).toBe(true);
        expect(projected.fireWallHits.map((hit) => hit.absorbedByWaterShield)).toEqual([true, false]);
        expect(projected.availableAfterMove).toBe(false);
    });

    it("keeps a lethally burned self-Resurrector available, but removes the same exhausted stack", () => {
        const actionFor = (unit: Unit) => ({
            type: "move_unit" as const,
            unitId: unit.getId(),
            path: [unit.getBaseCell(), { x: 4, y: 3 }],
        });

        const charged = activatedMover({
            amountAlive: 1,
            maxHp: 10,
            abilities: ["Resurrection"],
            spells: ["System:Resurrection"],
        });
        charged.unit.applyDamage(9, 0, new SceneLogMock());
        FightStateManager.getInstance().getFightProperties().getFireWalls().add({ x: 4, y: 3 }, 3, 25);
        const raised = applyAndCompare(charged, actionFor(charged.unit));
        expect(raised).toMatchObject({
            availableAfterMove: true,
            survivedFireWall: false,
            resurrected: true,
            stack: { hp: 10, maxHp: 10, amountAlive: 1, amountDied: 0 },
        });
        expect(charged.unit.hasSpellRemaining("Resurrection")).toBe(false);

        const exhausted = activatedMover({
            amountAlive: 1,
            maxHp: 10,
            abilities: ["Resurrection"],
            spells: ["System:Resurrection"],
        });
        exhausted.unit.applyDamage(9, 0, new SceneLogMock());
        exhausted.unit.useSpell("Resurrection");
        FightStateManager.getInstance().getFightProperties().getFireWalls().add({ x: 4, y: 3 }, 3, 25);
        const removed = applyAndCompare(exhausted, actionFor(exhausted.unit));
        expect(removed.availableAfterMove).toBe(false);
        expect(removed.resurrected).toBe(false);
    });

    it("keeps a summoned thief available when its stolen Resurrection charge raises it as-is", () => {
        const setup = activatedMover({
            amountAlive: 1,
            maxHp: 10,
            summoned: true,
            abilities: ["Resurrection"],
            spells: ["System:Resurrection"],
        });
        setup.unit.applyDamage(9, 0, new SceneLogMock());
        const burning = { x: 4, y: 3 };
        FightStateManager.getInstance().getFightProperties().getFireWalls().add(burning, 3, 25);

        expect(setup.unit.canSelfResurrect()).toBe(true);
        const projected = applyAndCompare(setup, {
            type: "move_unit",
            unitId: setup.unit.getId(),
            path: [setup.unit.getBaseCell(), burning],
        });

        expect(projected.availableAfterMove).toBe(true);
        expect(projected.resurrected).toBe(true);
        expect(setup.combat.unitsHolder.getAllUnits().get(setup.unit.getId())?.isDead()).toBe(false);
        expect(setup.unit.hasSpellRemaining("Resurrection")).toBe(false);
    });

    it("applies the lava max-HP boost before deriving Fire Wall damage", () => {
        const setup = activatedMover(
            { amountAlive: 10, maxHp: 20, abilities: ["Made of Fire"] },
            PBTypes.GridVals.LAVA_CENTER,
            { x: 4, y: 6 },
        );
        const lava = { x: 6, y: 6 };
        FightStateManager.getInstance().getFightProperties().getFireWalls().add(lava, 3, 25);
        const projected = applyAndCompare(setup, {
            type: "move_unit",
            unitId: setup.unit.getId(),
            path: [setup.unit.getBaseCell(), { x: 5, y: 6 }, lava],
            hasLavaCell: true,
        });

        expect(projected.madeOfFireApplied).toBe(true);
        expect(projected.fireWallHits[0]).toMatchObject({ requestedDamage: 55, appliedDamage: 55 });
        expect(projected.stack.maxHp).toBe(22);
        expect(setup.unit.hasBuffActive("Made of Fire")).toBe(true);
    });

    it("passes a water-bearing route before a safe wall burn without inventing a missing water buff", () => {
        const setup = activatedMover({ amountAlive: 4, maxHp: 20 }, PBTypes.GridVals.WATER_CENTER, { x: 4, y: 6 });
        const water = { x: 6, y: 6 };
        FightStateManager.getInstance().getFightProperties().getFireWalls().add(water, 3, 10);
        const projected = applyAndCompare(setup, {
            type: "move_unit",
            unitId: setup.unit.getId(),
            path: [setup.unit.getBaseCell(), { x: 5, y: 6 }, water, { x: 5, y: 7 }],
            hasWaterCell: true,
        });

        expect(projected.madeOfWaterApplied).toBe(false);
        expect(projected.availableAfterMove).toBe(true);
        expect(setup.unit.hasBuffActive("Made of Water")).toBe(false);
    });

    it("matches LARGE footprint-only targetCells and skips route terrain modifiers", () => {
        const setup = activatedMover(
            {
                amountAlive: 4,
                maxHp: 20,
                size: PBTypes.UnitSizeVals.LARGE,
                abilities: ["Made of Fire"],
            },
            PBTypes.GridVals.NORMAL,
            { x: 3, y: 3 },
        );
        const targetCells = [
            { x: 7, y: 7 },
            { x: 8, y: 7 },
            { x: 7, y: 8 },
            { x: 8, y: 8 },
        ];
        const walls = FightStateManager.getInstance().getFightProperties().getFireWalls();
        walls.add(targetCells[0], 3, 20);
        walls.add(targetCells[3], 3, 30);
        const action = {
            type: "move_unit" as const,
            unitId: setup.unit.getId(),
            path: [...targetCells].reverse(),
            targetCells,
            hasLavaCell: true,
        };

        expect(resolveMoveTraversal(setup.unit, action).pathIsFootprintOnly).toBe(true);
        const projected = applyAndCompare(setup, action);
        expect(projected.burningCells).toEqual([targetCells[0], targetCells[3]]);
        expect(projected.madeOfFireApplied).toBe(false);
        expect(projected.stack.maxHp).toBe(20);
        expect(setup.unit.hasBuffActive("Made of Fire")).toBe(false);
    });
});

/**
 * Live report (test server, game 40a72b86): an Angel stood on a Fire Wall and took nothing.
 *
 * A walk is a route of ANCHOR cells, and for anything bigger than 1x1 the anchor is one CORNER of the
 * block. The move-path burn was handed those anchors, so a 2x2 gliding onto a wall that sits under any of
 * its other three cells crossed real fire and was charged nothing. The footprint-only branch always passed
 * the whole destination block, which is why a rectangle's one-step slide burned correctly and a walking
 * Angel did not — the two paths disagreed about what a large unit occupies.
 */
describe("bodyCellsEnteredAlongPath", () => {
    const cellNames = (cells: { x: number; y: number }[]) => cells.map((c) => `${c.x},${c.y}`).sort();

    it("reports the whole block a large unit walks into, not just its anchor", () => {
        const start = getFootprintCellsForAnchor({ x: 9, y: 8 }, 2, 2);
        const entered = bodyCellsEnteredAlongPath(start, [{ x: 8, y: 8 }], 2, 2);
        // The Angel's new block is {(8,8),(8,7),(7,8),(7,7)}; the two cells it already stood on are free.
        expect(cellNames(entered)).toEqual(["7,7", "7,8"]);
    });

    it("burns a wall under a NON-anchor part of the body — the reported case", () => {
        const walls = new FireWalls();
        walls.add({ x: 7, y: 7 }, 3, 20);
        const start = getFootprintCellsForAnchor({ x: 9, y: 8 }, 2, 2);

        // What the engine used to pass: the anchor route alone. It misses the wall entirely.
        expect(enteredFireWallCells(walls, [{ x: 8, y: 8 }])).toEqual([]);
        // What it passes now.
        const entered = bodyCellsEnteredAlongPath(start, [{ x: 8, y: 8 }], 2, 2);
        expect(enteredFireWallCells(walls, entered)).toEqual([{ x: 7, y: 7 }]);
    });

    it("still never charges a unit for the body it started on", () => {
        // Standing in the flames is free; only cells the walk moves INTO are charged.
        const start = getFootprintCellsForAnchor({ x: 8, y: 8 }, 2, 2);
        expect(bodyCellsEnteredAlongPath(start, [{ x: 8, y: 8 }], 2, 2)).toEqual([]);
    });

    it("is unchanged for a 1x1, whose body IS its anchor", () => {
        expect(
            bodyCellsEnteredAlongPath(
                [{ x: 5, y: 5 }],
                [
                    { x: 6, y: 5 },
                    { x: 7, y: 5 },
                ],
                1,
                1,
            ),
        ).toEqual([
            { x: 6, y: 5 },
            { x: 7, y: 5 },
        ]);
    });

    it("de-duplicates cells the body re-occupies across consecutive steps", () => {
        // A 2x2 stepping one cell keeps half its block; the wall charges per cell entered, once.
        const start = getFootprintCellsForAnchor({ x: 9, y: 8 }, 2, 2);
        const entered = bodyCellsEnteredAlongPath(
            start,
            [
                { x: 8, y: 8 },
                { x: 7, y: 8 },
            ],
            2,
            2,
        );
        expect(new Set(cellNames(entered)).size).toBe(entered.length);
        expect(cellNames(entered)).toEqual(["6,7", "6,8", "7,7", "7,8"]);
    });
});
