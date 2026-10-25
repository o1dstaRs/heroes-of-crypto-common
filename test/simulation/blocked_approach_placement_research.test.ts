import { beforeEach, describe, expect, test } from "bun:test";

import type { IPlacementContext } from "../../src/ai/ai_strategy";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { ObstacleType } from "../../src/obstacles/obstacle_type";
import {
    blockedApproachBodies,
    blockedApproachTerrain,
    researchBlockedMeleeApproach,
    type IApproachBody,
} from "../../src/simulation/blocked_approach_placement_research";
import { createTestUnit, testGridSettings } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());

const body = (id: string, walkMelee: boolean, width = 1, height = 1): IApproachBody => ({
    id,
    name: id,
    width,
    height,
    role: walkMelee ? "guard" : "other",
    buffAuraRanges: [],
    walkMelee,
    steps: 3,
    canTraverseLava: false,
    vineStride: false,
});
const fixture = () => ({
    bodies: [body("guard", true), body("blocker", false), body("partner", true)],
    placement: new Map([
        ["guard", { x: 0, y: 7 }],
        ["blocker", { x: 1, y: 7 }],
        ["partner", { x: 2, y: 14 }],
    ]),
    legal: new Set(Array.from({ length: 256 }, (_, i) => i)),
    terrain: Array.from({ length: 16 }, () => Array<number>(16).fill(0)),
});
const probe = (f: ReturnType<typeof fixture>, forward: 1 | -1 = 1, sideAxis = true) =>
    researchBlockedMeleeApproach(
        f.bodies,
        f.placement,
        f.legal,
        f.terrain,
        new PathHelper(testGridSettings),
        forward,
        sideAxis,
    );

describe("research-only blocked melee opening routes", () => {
    test("the trapped policy leaves a usable forward route alone", () => {
        const f = fixture();
        const result = researchBlockedMeleeApproach(
            f.bodies,
            f.placement,
            f.legal,
            f.terrain,
            new PathHelper(testGridSettings),
            1,
            true,
            undefined,
            "trapped",
        );
        expect(result.placement).toBe(f.placement);
        expect(result.beforeReach.guard).toBe(2);
    });
    test("the trapped policy frees a fully blocked melee stack, preserving other bodies", () => {
        const f = fixture();
        f.placement.set("guard", { x: 1, y: 7 });
        f.placement.set("blocker", { x: 2, y: 7 });
        for (const y of [6, 8]) {
            const id = "side" + y;
            f.bodies.push(body(id, false));
            f.placement.set(id, { x: 1, y });
        }
        const result = researchBlockedMeleeApproach(
            f.bodies,
            f.placement,
            f.legal,
            f.terrain,
            new PathHelper(testGridSettings),
            1,
            true,
            undefined,
            "trapped",
        );
        expect(result.beforeReach.guard).toBe(0);
        expect(result.movedIds).toEqual(["guard"]);
        expect(result.placement.get("guard")).toEqual({ x: 1, y: 5 });
        expect(result.afterReach.guard).toBeGreaterThanOrEqual(1);
        expect([...result.placement].filter(([id, c]) => c !== f.placement.get(id))).toHaveLength(1);
        f.bodies[0].nativeSpellbook = true;
        expect(
            researchBlockedMeleeApproach(
                f.bodies,
                f.placement,
                f.legal,
                f.terrain,
                new PathHelper(testGridSettings),
                1,
                true,
                undefined,
                "trapped",
            ).placement,
        ).toBe(f.placement);
    });
    test("opens a lateral route without advancing the unit or mutating the incumbent", () => {
        const f = fixture();
        const before = JSON.stringify([...f.placement]);
        const result = probe(f);
        expect(result.movedIds).toEqual(["guard"]);
        expect(result.placement.get("guard")).toEqual({ x: 0, y: 6 });
        expect(result.beforeReach.guard).toBe(2);
        expect(result.afterReach.guard).toBe(3);
        expect(result.forwardReachGain).toBe(1);
        expect(result.afterReach.partner).toBeGreaterThanOrEqual(result.beforeReach.partner);
        expect(JSON.stringify([...f.placement])).toBe(before);
    });
    test("mirrors right-side advance and transposes the classic placement axis", () => {
        const mirrored = fixture();
        mirrored.placement = new Map([...mirrored.placement].map(([id, c]) => [id, { x: 15 - c.x, y: c.y }]));
        expect(probe(mirrored, -1).placement.get("guard")).toEqual({ x: 15, y: 6 });
        const classic = fixture();
        classic.placement = new Map([...classic.placement].map(([id, c]) => [id, { x: c.y, y: c.x }]));
        expect(probe(classic, 1, false).placement.get("guard")).toEqual({ x: 6, y: 0 });
    });
    test("leaves an uncongested army and an isolated melee stack unchanged", () => {
        const f = fixture();
        f.placement.set("blocker", { x: 0, y: 12 });
        expect(probe(f).placement).toBe(f.placement);
        f.bodies[2].walkMelee = false;
        expect(probe(f).placement).toBe(f.placement);
    });
    test("declines proposals changed by a later placement pass", () => {
        const f = fixture();
        const result = researchBlockedMeleeApproach(
            f.bodies,
            f.placement,
            f.legal,
            f.terrain,
            new PathHelper(testGridSettings),
            1,
            true,
            () => false,
        );
        expect(result.blockedMelee).toBeGreaterThan(0);
        expect(result.placement).toBe(f.placement);
    });
    test("does not confuse terrain obstruction with friendly congestion", () => {
        const f = fixture();
        f.placement.set("blocker", { x: 0, y: 12 });
        f.terrain[7][1] = ObstacleType.BLOCK;
        expect(probe(f).blockedMelee).toBe(0);
        expect(probe(f).placement).toBe(f.placement);
    });
    test("rejects incomplete, overlapping, out-of-bounds, and forbidden placements", () => {
        const f = fixture();
        expect(
            researchBlockedMeleeApproach(
                f.bodies,
                f.placement,
                new Set(),
                f.terrain,
                new PathHelper(testGridSettings),
                1,
                true,
            ).placement,
        ).toBe(f.placement);
        f.placement.set("blocker", { x: 0, y: 7 });
        expect(probe(f).placement).toBe(f.placement);
        f.placement.set("blocker", { x: 16, y: 7 });
        expect(probe(f).placement).toBe(f.placement);
        f.placement.delete("blocker");
        expect(probe(f).placement).toBe(f.placement);
    });
    test("does not trade one blocked ally for another", () => {
        const f = fixture();
        f.placement.set("guard", { x: 1, y: 7 });
        f.placement.set("blocker", { x: 2, y: 7 });
        f.placement.set("partner", { x: 0, y: 6 });
        for (const y of [5, 8, 9]) f.legal.delete((1 << 4) | y);
        const result = probe(f);
        expect(result.blockedMelee).toBeGreaterThan(0);
        expect(result.placement).toBe(f.placement);
    });
    test("preserves every existing aura recipient", () => {
        const f = fixture();
        f.bodies.push({ ...body("aura", false), buffAuraRanges: [1] });
        f.placement.set("aura", { x: 0, y: 8 });
        for (const y of [5, 8, 9]) f.legal.delete(y);
        // Keep the source's own cell legal; the two-cell move upward would lose its guard recipient.
        f.legal.add(8);
        const result = probe(f);
        expect(result.blockedMelee).toBeGreaterThan(0);
        expect(result.placement).toBe(f.placement);
    });
    test("expands rectangular bodies and never uses an anchor-only gap", () => {
        const f = fixture();
        f.bodies[0].width = 2;
        f.bodies[0].height = 1;
        f.placement.set("guard", { x: 1, y: 7 });
        f.placement.set("blocker", { x: 2, y: 7 });
        const result = probe(f);
        expect(result.movedIds).toEqual(["guard"]);
        expect(result.placement.get("guard")?.x).toBe(1);
        const forbidden = fixture();
        forbidden.bodies[0].width = 2;
        forbidden.placement.set("guard", { x: 1, y: 7 });
        forbidden.placement.set("blocker", { x: 2, y: 7 });
        for (const y of [5, 6, 8, 9]) forbidden.legal.delete(y);
        expect(probe(forbidden).placement).toBe(forbidden.placement);
    });
    test("the probe consumes no RNG and changes at most one body", () => {
        const f = fixture();
        const originalRandom = Math.random;
        Math.random = () => {
            throw new Error("Geometry probe consumed combat RNG");
        };
        try {
            const result = probe(f);
            expect([...result.placement].filter(([id, c]) => c !== f.placement.get(id))).toHaveLength(1);
        } finally {
            Math.random = originalRandom;
        }
    });
    test("reconstructs terrain without reading enemy occupancy or hidden barrels", () => {
        const context = {
            team: PBTypes.TeamVals.LEFT,
            grid: {
                getGridType: () => PBTypes.GridVals.LAVA_CENTER,
                getCenterCells: () => [{ x: 7, y: 6 }],
                getArtifactBarrels: (team: number) => {
                    expect(team).toBe(PBTypes.TeamVals.LEFT);
                    return [{ cell: { x: 2, y: 5 } }];
                },
                getMatrix: () => {
                    throw new Error("Hidden occupancy read");
                },
                getMatrixNoUnits: () => {
                    throw new Error("Terrain underneath hidden units can disappear");
                },
            },
        } as unknown as IPlacementContext;
        const terrain = blockedApproachTerrain(context);
        expect(terrain[6][7]).toBe(ObstacleType.LAVA);
        expect(terrain[5][2]).toBe(ObstacleType.BLOCK);
        expect(terrain[7][6]).toBe(0);
    });
    test("excludes ranged, mage, AI Driven, flying, teleporting, and bait stacks", () => {
        const units = [
            createTestUnit({ name: "Pikeman", amountAlive: 20, movementType: PBTypes.MovementVals.WALK }),
            createTestUnit({ name: "Elf", amountAlive: 20, movementType: PBTypes.MovementVals.WALK }),
            createTestUnit({ name: "Wandering Mage", amountAlive: 20, movementType: PBTypes.MovementVals.WALK }),
            createTestUnit({
                name: "Berserker",
                amountAlive: 20,
                abilities: ["AI Driven"],
                movementType: PBTypes.MovementVals.WALK,
            }),
            createTestUnit({ name: "Pikeman", amountAlive: 20, movementType: PBTypes.MovementVals.FLY }),
            createTestUnit({ name: "Pikeman", amountAlive: 20, movementType: PBTypes.MovementVals.TELEPORT }),
            createTestUnit({ name: "Pikeman", amountAlive: 1, movementType: PBTypes.MovementVals.WALK }),
        ];
        expect(blockedApproachBodies(units).map((b) => b.walkMelee)).toEqual([
            true,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
    });
    test("native spellbooks are explicit own-army metadata", () => {
        const units = [
            createTestUnit({ name: "Ogre Mage", amountAlive: 10 }),
            createTestUnit({ name: "Pikeman", amountAlive: 20 }),
        ];
        expect(blockedApproachBodies(units).map((b) => b.nativeSpellbook)).toEqual([true, false]);
    });
});
