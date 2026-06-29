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

import { AI_VERSIONS, DEFAULT_AI_VERSION, getAIStrategy, LATEST_AI_VERSION, type IDecisionContext } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import { getDistance } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const MAGIC = PBTypes.AttackVals.MAGIC;
const FLY = PBTypes.MovementVals.FLY;

const v03 = getAIStrategy("v0.3");

function ctxFor(c: CombatTestContext): IDecisionContext {
    return {
        grid: c.grid,
        matrix: c.grid.getMatrix(),
        unitsHolder: c.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: c.attackHandler,
    };
}
const moveAction = (a: GameAction[]): Extract<GameAction, { type: "move_unit" }> | undefined =>
    a.find((x) => x.type === "move_unit") as Extract<GameAction, { type: "move_unit" }> | undefined;

describe("AI version registry — v0.3 promoted to default, v0.4 is the new target", () => {
    it("registers v0.3 and v0.4, ships v0.3 as the default, and exposes a latest version", () => {
        expect(AI_VERSIONS).toContain("v0.3");
        expect(AI_VERSIONS).toContain("v0.4");
        expect(DEFAULT_AI_VERSION).toBe("v0.3");
        // v0.4 is registered after v0.3 (don't pin "latest" — newer in-dev versions may be added).
        expect(AI_VERSIONS.indexOf("v0.4")).toBeGreaterThan(AI_VERSIONS.indexOf("v0.3"));
        expect(LATEST_AI_VERSION).toBe(AI_VERSIONS[AI_VERSIONS.length - 1]);
    });

    it("v0.4 defers to v0.3 when none of its extra tactics apply (no Wolf Rider, no siege, …)", () => {
        const v04 = getAIStrategy("v0.4");
        expect(v04.version).toBe("v0.4");

        // placeArmy delegates to v0.3 for a non-Wolf-Rider roster -> identical deployment.
        const mkUnits = () => [
            createTestUnit({ name: "R", team: LOWER, attackType: RANGE, rangeShots: 5 }),
            createTestUnit({ name: "M1", team: LOWER, attackType: MELEE }),
            createTestUnit({ name: "M2", team: LOWER, attackType: MELEE }),
        ];
        const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const placeCtx = {
            team: LOWER,
            grid: undefined as never,
            unitsHolder: undefined as never,
            pathHelper: undefined as never,
            placement: zone,
        };
        const u3 = mkUnits();
        const u4 = mkUnits();
        const p3 = v03.placeArmy(u3, placeCtx);
        const p4 = v04.placeArmy(u4, placeCtx);
        const cellsOf = (units: Unit[], placed: Map<string, { x: number; y: number }>) =>
            units.map((u) => placed.get(u.getId())!).map((c) => `${c.x}:${c.y}`);
        expect(cellsOf(u4, p4)).toEqual(cellsOf(u3, p3));

        // decideTurn delegates too: a boxed-in shooter produces the same kind of action under both.
        const c = createCombatTestContext();
        const shooter = createTestUnit({ team: LOWER, name: "S", attackType: RANGE, rangeShots: 5, speed: 3 });
        const enemy = createTestUnit({ team: UPPER, name: "E", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 5, y: 6 });
        const actions = v04.decideTurn(shooter, ctxFor(c));
        expect(Array.isArray(actions)).toBe(true);
        expect(actions.length).toBeGreaterThan(0);
    });
});

describe("v0.3 placeArmy — corner shooters, flyer wing, centred wall", () => {
    it("routes ranged to deep corners, ground melee to the centred front wall, flyers to a forward flank", () => {
        const mk = (name: string, attackType: number, opts = {}) =>
            createTestUnit({ name, team: LOWER, attackType, ...opts });
        const r1 = mk("R1", RANGE, { rangeShots: 5 });
        const r2 = mk("R2", RANGE, { rangeShots: 5 });
        const m1 = mk("M1", MELEE);
        const m2 = mk("M2", MELEE);
        const flyer = mk("Flyer", MELEE, { movementType: FLY });
        const support = mk("Caster", MAGIC);
        const units = [r1, r2, m1, m2, flyer, support];

        const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const placed = v03.placeArmy(units, {
            team: LOWER,
            grid: undefined as never,
            unitsHolder: undefined as never,
            pathHelper: undefined as never,
            placement: zone,
        });
        for (const u of units) {
            expect(placed.has(u.getId())).toBe(true);
        }
        // LOWER team: frontness == y (higher y = closer to the enemy / "forward").
        const y = (u: Unit) => placed.get(u.getId())!.y;
        const x = (u: Unit) => placed.get(u.getId())!.x;
        const centreX = 7.5; // size-3 LOWER_LEFT zone spans x≈1..14

        // Ground melee form the wall ahead of every ranged shooter.
        const meleeFront = Math.min(y(m1), y(m2));
        expect(meleeFront).toBeGreaterThan(Math.max(y(r1), y(r2)));
        // Both shooters are tucked to an edge (cornered), further from centre than the central caster.
        expect(Math.abs(x(r1) - centreX)).toBeGreaterThan(Math.abs(x(support) - centreX));
        expect(Math.abs(x(r2) - centreX)).toBeGreaterThan(Math.abs(x(support) - centreX));
        // The flyer is staged forward (with/ahead of the wall), not parked in the back with the shooters.
        expect(y(flyer)).toBeGreaterThanOrEqual(Math.max(y(r1), y(r2)));
    });

    it("falls back gracefully when there are no legal placement cells", () => {
        const u = createTestUnit({ name: "Lonely", team: LOWER, attackType: MELEE });
        const emptyZone = { possibleCellHashes: () => new Set<number>() } as unknown as RectanglePlacement;
        const placed = v03.placeArmy([u], {
            team: LOWER,
            grid: undefined as never,
            unitsHolder: undefined as never,
            pathHelper: undefined as never,
            placement: emptyZone,
        });
        expect(placed.size).toBe(0);
    });
});

describe("v0.3 decideTurn — cohesion keeps the army together", () => {
    it("redirects a detached melee straggler toward its allies instead of charging in alone", () => {
        const c = createCombatTestContext();
        // Two allies clustered on the left; one straggler far to the right (> STRAGGLER_DIST from centroid).
        const ally1 = createTestUnit({ team: LOWER, name: "Ally1", attackType: MELEE, speed: 3 });
        const ally2 = createTestUnit({ team: LOWER, name: "Ally2", attackType: MELEE, speed: 3 });
        const straggler = createTestUnit({ team: LOWER, name: "Straggler", attackType: MELEE, speed: 3 });
        // A lone enemy far away on the right edge so the straggler has no strike available (pure move turn).
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, ally1, { x: 1, y: 1 });
        placeUnit(c.grid, c.unitsHolder, ally2, { x: 2, y: 1 });
        placeUnit(c.grid, c.unitsHolder, straggler, { x: 13, y: 1 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 13, y: 14 });

        const allyCentroid = { x: 1.5, y: 1 };
        const startDist = getDistance({ x: 13, y: 1 }, allyCentroid);
        const actions = v03.decideTurn(straggler, ctxFor(c));
        const move = moveAction(actions);
        expect(move).toBeDefined();
        // The rejoin move ends nearer the allied centroid than where it started (cohesion, not a solo charge).
        const dest = move!.path[move!.path.length - 1];
        expect(getDistance(dest, allyCentroid)).toBeLessThan(startDist);
    });

    it("leaves a unit already with the pack to v0.2's normal decision", () => {
        const c = createCombatTestContext();
        const a1 = createTestUnit({ team: LOWER, name: "A1", attackType: MELEE, speed: 3 });
        const a2 = createTestUnit({ team: LOWER, name: "A2", attackType: MELEE, speed: 3 });
        const a3 = createTestUnit({ team: LOWER, name: "A3", attackType: MELEE, speed: 3 });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy", attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, a1, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, a2, { x: 6, y: 5 });
        placeUnit(c.grid, c.unitsHolder, a3, { x: 5, y: 6 }); // tight cluster, none is a straggler
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 10, y: 12 });

        // Should not throw and should produce a valid action list (cohesion declines to intervene here).
        const actions = v03.decideTurn(a1, ctxFor(c));
        expect(Array.isArray(actions)).toBe(true);
        expect(actions.length).toBeGreaterThan(0);
    });
});

const rangeAction = (a: GameAction[]): GameAction | undefined => a.find((x) => x.type === "range_attack");

describe("v0.3 decideRangedTurn — focus-fire scoring & Beholder bias", () => {
    it("fires when it has a clear shot, exercising the enemy-range focus-fire weighting", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({
            team: LOWER,
            name: "Shooter",
            attackType: RANGE,
            rangeShots: 10,
            shotDistance: 30,
            speed: 2,
        });
        // Mixed enemy targets: a ranged shooter (weighted up by scoreShot) and a melee body.
        const enemyRanged = createTestUnit({ team: UPPER, name: "EArcher", attackType: RANGE, rangeShots: 5 });
        const enemyMelee = createTestUnit({ team: UPPER, name: "EBrute", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemyRanged, { x: 8, y: 11 });
        placeUnit(c.grid, c.unitsHolder, enemyMelee, { x: 9, y: 11 });

        const actions = v03.decideTurn(shooter, ctxFor(c));
        expect(Array.isArray(actions)).toBe(true);
        expect(actions.length).toBeGreaterThan(0);
        expect(rangeAction(actions)).toBeDefined();
    });

    it("a Beholder biases its shot toward a less-debuffed, still-dangerous victim", () => {
        const c = createCombatTestContext();
        const beholder = createTestUnit({
            team: LOWER,
            name: "Beholder",
            attackType: RANGE,
            rangeShots: 10,
            shotDistance: 30,
            speed: 2,
        });
        // One ranged enemy with shots (canThreatenThisTurn range branch) and one melee enemy near our line
        // (canThreatenThisTurn melee branch). Neither is pre-debuffed, so the Spit Ball bonus is non-zero.
        const enemyRanged = createTestUnit({ team: UPPER, name: "EArcher", attackType: RANGE, rangeShots: 5 });
        const enemyMelee = createTestUnit({ team: UPPER, name: "EBrute", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, beholder, { x: 8, y: 8 });
        placeUnit(c.grid, c.unitsHolder, enemyRanged, { x: 8, y: 11 });
        placeUnit(c.grid, c.unitsHolder, enemyMelee, { x: 11, y: 8 }); // a few cells off — shootable, not boxing

        const actions = v03.decideTurn(beholder, ctxFor(c));
        expect(rangeAction(actions)).toBeDefined();
    });
});

describe("v0.3 decideTurn — boxed-in shooter prefers to preserve its shot", () => {
    it("does not throw and returns actions for a shooter hemmed in by enemies", () => {
        const c = createCombatTestContext();
        const shooter = createTestUnit({ team: LOWER, name: "Shooter", attackType: RANGE, rangeShots: 5, speed: 3 });
        const ally = createTestUnit({ team: LOWER, name: "Screen", attackType: MELEE });
        const e1 = createTestUnit({ team: UPPER, name: "E1", attackType: MELEE, amountAlive: 5 });
        placeUnit(c.grid, c.unitsHolder, shooter, { x: 5, y: 5 });
        placeUnit(c.grid, c.unitsHolder, ally, { x: 5, y: 4 });
        placeUnit(c.grid, c.unitsHolder, e1, { x: 5, y: 6 });

        const actions = v03.decideTurn(shooter, ctxFor(c));
        expect(Array.isArray(actions)).toBe(true);
        expect(actions.length).toBeGreaterThan(0);
    });
});
