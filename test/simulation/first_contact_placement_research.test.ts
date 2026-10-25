import { describe, expect, test } from "bun:test";

import {
    firstContactBodies,
    researchGroundedCarryDepthSwap,
    type IFirstContactBody,
} from "../../src/simulation/first_contact_placement_research";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { footprintCellsForRecord } from "../../src/simulation/footprint";
import { createTestUnit } from "../helpers/combat";

const body = (id: string, role: IFirstContactBody["role"], width = 1, height = 1): IFirstContactBody => ({
    id,
    name: id,
    role,
    width,
    height,
    buffAuraRanges: [],
});
const legal = new Set(Array.from({ length: 256 }, (_, i) => i));
const fixture = () => ({
    bodies: [body("Elf", "carry"), body("Pikeman", "guard")],
    placement: new Map([
        ["Elf", { x: 3, y: 7 }],
        ["Pikeman", { x: 1, y: 7 }],
    ]),
});
const occupied = (bodies: readonly IFirstContactBody[], p: Map<string, { x: number; y: number }>) =>
    bodies
        .flatMap((b) => footprintCellsForRecord(p.get(b.id)!, Math.max(b.width, b.height), b.width, b.height))
        .map((c) => (c.x << 4) | c.y)
        .sort((a, b) => a - b);

describe("research-only grounded carry depth swap", () => {
    test("puts the carry behind its guard without changing occupied cells", () => {
        const f = fixture();
        const result = researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true);
        expect(result.placement.get("Elf")).toEqual({ x: 1, y: 7 });
        expect(result.placement.get("Pikeman")).toEqual({ x: 3, y: 7 });
        expect(occupied(f.bodies, result.placement)).toEqual(occupied(f.bodies, f.placement));
        expect(f.placement.get("Elf")).toEqual({ x: 3, y: 7 });
        expect(result.retreatCells).toBe(2);
    });
    test("mirrors the forward direction for the right-hand army", () => {
        const f = fixture();
        const p = new Map([...f.placement].map(([id, c]) => [id, { x: 15 - c.x, y: c.y }]));
        const result = researchGroundedCarryDepthSwap(f.bodies, p, legal, -1, true, true);
        expect(result.placement.get("Elf")).toEqual({ x: 14, y: 7 });
        expect(result.retreatCells).toBe(2);
    });
    test("uses y for classic placement", () => {
        const f = fixture();
        const p = new Map([...f.placement].map(([id, c]) => [id, { x: c.y, y: c.x }]));
        expect(researchGroundedCarryDepthSwap(f.bodies, p, legal, 1, false, true).placement.get("Elf")).toEqual({
            x: 7,
            y: 1,
        });
    });
    test("never uses a hidden threat to activate the rule", () => {
        const f = fixture();
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, false).placement).toBe(
            f.placement,
        );
    });
    test("preserves an already correctly ordered screen", () => {
        const f = fixture();
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, -1, true, true).placement).toBe(
            f.placement,
        );
    });
    test("does not move a guard from a distant lane", () => {
        const f = fixture();
        f.placement.set("Pikeman", { x: 1, y: 2 });
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true).placement).toBe(f.placement);
    });
    test("refuses unequal footprint swaps", () => {
        const f = fixture();
        f.bodies[1].width = 2;
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true).placement).toBe(f.placement);
    });
    test("preserves rectangular footprints", () => {
        const f = fixture();
        f.bodies.forEach((b) => {
            b.width = 2;
            b.height = 1;
        });
        const result = researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true);
        expect(result.swapped.length).toBe(2);
        expect(occupied(f.bodies, result.placement)).toEqual(occupied(f.bodies, f.placement));
    });
    test("refuses to lose an existing buff aura recipient", () => {
        const f = fixture();
        f.bodies.push({ ...body("Aura", "other"), buffAuraRanges: [1] });
        f.placement.set("Aura", { x: 3, y: 8 });
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true).placement).toBe(f.placement);
    });
    test("rejects incomplete, overlapping, or illegal incumbent footprints", () => {
        const f = fixture();
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, new Set(), 1, true, true).placement).toBe(
            f.placement,
        );
        f.placement.set("Pikeman", { x: 3, y: 7 });
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true).placement).toBe(f.placement);
        f.placement.delete("Pikeman");
        expect(researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true).placement).toBe(f.placement);
    });
    test("makes at most one swap", () => {
        const f = fixture();
        f.bodies.push(body("Medusa", "carry"), body("Trent", "guard"));
        f.placement.set("Medusa", { x: 3, y: 12 });
        f.placement.set("Trent", { x: 1, y: 12 });
        const result = researchGroundedCarryDepthSwap(f.bodies, f.placement, legal, 1, true, true);
        expect([...result.placement].filter(([id, cell]) => cell !== f.placement.get(id))).toHaveLength(2);
    });
    test("excludes mindless, flying, and single-creature bait stacks from carry/guard roles", () => {
        const units = [
            createTestUnit({ name: "Berserker", abilities: ["AI Driven"], amountAlive: 20 }),
            createTestUnit({ name: "Elf", amountAlive: 1, attackType: PBTypes.AttackVals.RANGE }),
            createTestUnit({
                name: "Elf",
                amountAlive: 20,
                attackType: PBTypes.AttackVals.RANGE,
                movementType: PBTypes.MovementVals.FLY,
            }),
            createTestUnit({ name: "Elf", amountAlive: 20, attackType: PBTypes.AttackVals.RANGE }),
            createTestUnit({ name: "Pikeman", amountAlive: 20 }),
        ];
        expect(firstContactBodies(units).map((b) => b.role)).toEqual(["other", "other", "other", "carry", "guard"]);
    });
});
