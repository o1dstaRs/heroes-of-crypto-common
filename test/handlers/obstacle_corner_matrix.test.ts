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

import { describe, expect, test } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import type { IWeightedRoute } from "../../src/grid/path_definitions";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

/*
 * EXHAUSTIVE mountain-corner melee matrix: BOTH mountains x ALL exposed diagonal corners x
 * {small 1x1, large 2x2} x {stationary strike, move-then-strike} — through the real
 * GameActionEngine (move_unit + obstacle_attack), with real PathHelper routes for the moves.
 * Regression for "can't attack mountains from corner positions".
 */

const gs = testGridSettings;
const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const LARGE = PBTypes.UnitSizeVals.LARGE;

const worldOf = (cell: XY): XY => getPositionForCell(cell, gs.getMinX(), gs.getStep(), gs.getHalfStep());
const key = (cell: XY): number => (cell.x << 4) | cell.y;
const largeFootprint = (anchor: XY): XY[] => [
    { x: anchor.x - 1, y: anchor.y - 1 },
    { x: anchor.x - 1, y: anchor.y },
    { x: anchor.x, y: anchor.y - 1 },
    { x: anchor.x, y: anchor.y },
];

// 16-grid BLOCK_CENTER: left mountain x∈{5,6}, right x∈{9,10}, both y∈{7,8}.
// Every exposed corner: [the mountain cell struck, the diagonal landing cell for a small unit].
interface CornerCase {
    label: string;
    mountainCell: XY;
    smallLanding: XY;
    // 2x2 anchor whose footprint touches the corner diagonally without overlapping rock.
    largeAnchor: XY;
}
const CORNERS: CornerCase[] = [
    // left mountain
    { label: "L bottom-left", mountainCell: { x: 5, y: 7 }, smallLanding: { x: 4, y: 6 }, largeAnchor: { x: 4, y: 6 } },
    { label: "L top-left", mountainCell: { x: 5, y: 8 }, smallLanding: { x: 4, y: 9 }, largeAnchor: { x: 4, y: 10 } },
    {
        label: "L bottom-right",
        mountainCell: { x: 6, y: 7 },
        smallLanding: { x: 7, y: 6 },
        largeAnchor: { x: 8, y: 6 },
    },
    { label: "L top-right", mountainCell: { x: 6, y: 8 }, smallLanding: { x: 7, y: 9 }, largeAnchor: { x: 8, y: 10 } },
    // right mountain
    { label: "R bottom-left", mountainCell: { x: 9, y: 7 }, smallLanding: { x: 8, y: 6 }, largeAnchor: { x: 8, y: 6 } },
    { label: "R top-left", mountainCell: { x: 9, y: 8 }, smallLanding: { x: 8, y: 9 }, largeAnchor: { x: 8, y: 10 } },
    {
        label: "R bottom-right",
        mountainCell: { x: 10, y: 7 },
        smallLanding: { x: 11, y: 6 },
        largeAnchor: { x: 12, y: 6 },
    },
    {
        label: "R top-right",
        mountainCell: { x: 10, y: 8 },
        smallLanding: { x: 11, y: 9 },
        largeAnchor: { x: 12, y: 10 },
    },
];

interface Rig {
    engine: GameActionEngine;
    unit: Unit;
    setKnownPaths: (paths: Map<number, IWeightedRoute[]> | undefined) => void;
    pathHelper: PathHelper;
    matrix: () => number[][];
    hitsLeft: () => number;
}

function buildRig(isSmall: boolean, startCell: XY, occupyFootprint: boolean): Rig {
    const ctx = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const fp = FightStateManager.getInstance().getFightProperties();
    fp.setGridType(PBTypes.GridVals.BLOCK_CENTER);

    const unit = createTestUnit({
        team: LOWER,
        attackType: MELEE,
        name: isSmall ? "Knight" : "Ogre",
        speed: 8,
        ...(isSmall ? {} : { size: LARGE }),
    });
    if (isSmall) {
        placeUnit(ctx.grid, ctx.unitsHolder, unit, startCell);
    } else {
        // Large: occupy the full 2x2 footprint and center the body on the shared corner.
        const cells = largeFootprint(startCell);
        const anchorCenter = worldOf(startCell);
        unit.setPosition(anchorCenter.x - gs.getHalfStep(), anchorCenter.y - gs.getHalfStep());
        if (occupyFootprint) {
            ctx.grid.occupyCells(cells, unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
        }
        ctx.unitsHolder.addUnit(unit);
    }
    // An opposing unit far away so start_fight has both teams.
    const enemy = createTestUnit({ team: UPPER, attackType: MELEE, name: "Orc" });
    placeUnit(ctx.grid, ctx.unitsHolder, enemy, { x: 14, y: 14 });

    let knownPaths: Map<number, IWeightedRoute[]> | undefined;
    const moveHandler = new MoveHandler(gs, ctx.grid, ctx.unitsHolder);
    const engine = new GameActionEngine({
        fightProperties: fp,
        grid: ctx.grid,
        unitsHolder: ctx.unitsHolder,
        moveHandler,
        sceneLog: new SceneLogMock(),
        attackHandler: ctx.attackHandler,
        getCurrentActiveUnitId: () => unit.getId(),
        getCurrentActiveKnownPaths: () => knownPaths,
    });
    const started = engine.apply({ type: "start_fight" } as never);
    if (!started.completed) {
        throw new Error(`start_fight failed: ${started.rejectionReason}`);
    }
    return {
        engine,
        unit,
        setKnownPaths: (paths) => {
            knownPaths = paths;
        },
        pathHelper: new PathHelper(gs),
        matrix: () => ctx.grid.getMatrix(),
        hitsLeft: () => fp.getObstacleHitsLeft(),
    };
}

function strike(rig: Rig, mountainCell: XY, attackFrom: XY, path?: XY[]): { ok: boolean; reason?: string } {
    const hitsBefore = rig.hitsLeft();
    const result = rig.engine.apply({
        type: "obstacle_attack",
        attackerId: rig.unit.getId(),
        targetPosition: worldOf(mountainCell),
        attackFrom,
        path,
    } as never);
    return {
        ok: result.completed !== false && rig.hitsLeft() < hitsBefore,
        reason: result.rejectionReason,
    };
}

describe("mountain corner melee matrix (both mountains, all corners, small+large, stationary+move)", () => {
    for (const corner of CORNERS) {
        test(`small stationary: ${corner.label} strike from (${corner.smallLanding.x},${corner.smallLanding.y})`, () => {
            const rig = buildRig(true, corner.smallLanding, true);
            const res = strike(rig, corner.mountainCell, corner.smallLanding);
            expect(res.reason ?? "").toBe("");
            expect(res.ok).toBe(true);
        });

        test(`large stationary: ${corner.label} strike from anchor (${corner.largeAnchor.x},${corner.largeAnchor.y})`, () => {
            const rig = buildRig(false, corner.largeAnchor, true);
            const res = strike(rig, corner.mountainCell, corner.largeAnchor);
            expect(res.reason ?? "").toBe("");
            expect(res.ok).toBe(true);
        });

        test(`small move+strike: ${corner.label} lands on (${corner.smallLanding.x},${corner.smallLanding.y})`, () => {
            // Start 3 cells straight down/up from the landing cell (clamped on-board), walk in, strike.
            const start = {
                x: corner.smallLanding.x,
                y: corner.smallLanding.y < 8 ? corner.smallLanding.y - 3 : corner.smallLanding.y + 3,
            };
            const rig = buildRig(true, start, true);
            const movePath = rig.pathHelper.getMovePath(start, rig.matrix(), 8, undefined, false, true);
            rig.setKnownPaths(movePath.knownPaths);
            const route = movePath.knownPaths.get(key(corner.smallLanding))?.[0]?.route;
            expect(route?.length ?? 0).toBeGreaterThan(0);
            const moveRes = rig.engine.apply({
                type: "move_unit",
                unitId: rig.unit.getId(),
                path: route!,
                targetCells: [corner.smallLanding],
            } as never);
            expect(moveRes.rejectionReason ?? "").toBe("");
            expect(moveRes.completed).toBe(true);
            const res = strike(rig, corner.mountainCell, corner.smallLanding, route);
            expect(res.reason ?? "").toBe("");
            expect(res.ok).toBe(true);
        });

        test(`large move+strike: ${corner.label} lands on anchor (${corner.largeAnchor.x},${corner.largeAnchor.y})`, () => {
            const start = {
                x: corner.largeAnchor.x,
                y: corner.largeAnchor.y < 8 ? corner.largeAnchor.y - 3 : corner.largeAnchor.y + 3,
            };
            const rig = buildRig(false, start, true);
            const movePath = rig.pathHelper.getMovePath(start, rig.matrix(), 8, undefined, false, false);
            rig.setKnownPaths(movePath.knownPaths);
            const route = movePath.knownPaths.get(key(corner.largeAnchor))?.[0]?.route;
            expect(route?.length ?? 0).toBeGreaterThan(0);
            const moveRes = rig.engine.apply({
                type: "move_unit",
                unitId: rig.unit.getId(),
                path: route!,
                targetCells: largeFootprint(corner.largeAnchor),
            } as never);
            expect(moveRes.rejectionReason ?? "").toBe("");
            expect(moveRes.completed).toBe(true);
            const res = strike(rig, corner.mountainCell, corner.largeAnchor, route);
            expect(res.reason ?? "").toBe("");
            expect(res.ok).toBe(true);
        });
    }
});
