import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    selectPeasantFollowthrough,
    type IPeasantFollowthroughCandidate,
} from "../../src/simulation/peasant_followthrough_research";

const row = (distance: number): IPeasantFollowthroughCandidate => ({
    actions: [{ type: "melee_attack", attackerId: "p", targetId: "t", attackFrom: { x: distance, y: 2 } }],
    mean: 1,
    samples: [0, 1].map((repeat) => ({
        repeat,
        targetId: "t",
        targetDead: true,
        cheapResponse: true,
        immediateKey: `same-${repeat}`,
        othersKey: "unchanged",
        backlineDistance: distance,
        adjacentEnemies: [],
    })),
});
const clone = (candidate: IPeasantFollowthroughCandidate): any => structuredClone(candidate);

describe("Peasant same-kill follow-through research", () => {
    test("selects closer complete ties without mutating evidence", () => {
        const rows = [row(6), row(5), row(4), row(4)];
        const before = structuredClone(rows);
        expect(selectPeasantFollowthrough(rows, 0)).toBe(2);
        expect(rows).toEqual(before);
    });
    test("requires a full cell of improvement in both paired samples", () => {
        const near = clone(row(4));
        near.samples[1].backlineDistance = 5.5;
        expect(selectPeasantFollowthrough([row(6), near], 0)).toBe(0);
        expect(selectPeasantFollowthrough([row(6), row(5.01)], 0)).toBe(0);
    });
    test("retains native on worse scores or a nonmaximum selected score", () => {
        expect(selectPeasantFollowthrough([row(6), { ...row(4), mean: 0.99 }], 0)).toBe(0);
        expect(selectPeasantFollowthrough([{ ...row(6), mean: 0.5 }, row(4)], 0)).toBe(0);
    });
    test("rejects partial, duplicate, reordered and nonfinite evidence", () => {
        for (const change of [
            (r: any) => r.samples.pop(),
            (r: any) => (r.samples[1].repeat = 0),
            (r: any) => r.samples.reverse(),
            (r: any) => (r.samples[1].backlineDistance = NaN),
            (r: any) => (r.mean = -Infinity),
        ]) {
            const candidate = clone(row(4));
            change(candidate);
            expect(selectPeasantFollowthrough([row(6), candidate], 0)).toBe(0);
        }
    });
    test("preserves damage, armor, steps, support and response-price equivalence", () => {
        for (const key of ["immediateKey", "othersKey"] as const) {
            const candidate = clone(row(4));
            candidate.samples[1][key] = "changed";
            expect(selectPeasantFollowthrough([row(6), candidate], 0)).toBe(0);
        }
    });
    test("requires a killed identical target and supported cheap response in both samples", () => {
        for (const [key, value] of [
            ["targetDead", false],
            ["cheapResponse", false],
            ["targetId", "different"],
        ]) {
            const candidate = clone(row(4));
            candidate.samples[1][key as string] = value;
            expect(selectPeasantFollowthrough([row(6), candidate], 0)).toBe(0);
        }
        const different = clone(row(4));
        different.actions[0].targetId = "different";
        expect(selectPeasantFollowthrough([row(6), different], 0)).toBe(0);
    });
    test("rejects new enemy adjacency even if total adjacency is unchanged", () => {
        const baseline = clone(row(6));
        baseline.samples.forEach((s: any) => (s.adjacentEnemies = ["a"]));
        const candidate = clone(row(4));
        candidate.samples.forEach((s: any) => (s.adjacentEnemies = ["b"]));
        expect(selectPeasantFollowthrough([baseline, candidate], 0)).toBe(0);
        candidate.samples.forEach((s: any) => (s.adjacentEnemies = []));
        expect(selectPeasantFollowthrough([baseline, candidate], 0)).toBe(1);
    });
    test("declines composite, unsafe or foreign-actor action sequences", () => {
        const move = {
            type: "move_unit",
            unitId: "p",
            path: [
                { x: 6, y: 2 },
                { x: 4, y: 2 },
            ],
            targetCells: [{ x: 4, y: 2 }],
            hasLavaCell: false,
            hasWaterCell: false,
        };
        const candidate = clone(row(4));
        candidate.actions.unshift(move);
        expect(selectPeasantFollowthrough([row(6), candidate], 0)).toBe(1);
        for (const bad of [
            { ...move, hasWaterCell: true },
            { ...move, hasLavaCell: true },
            { ...move, unitId: "other" },
            { ...move, path: [] },
        ]) {
            candidate.actions[0] = bad;
            expect(selectPeasantFollowthrough([row(6), candidate], 0)).toBe(0);
        }
        candidate.actions = [...row(4).actions, ...row(4).actions];
        expect(selectPeasantFollowthrough([row(6), candidate], 0)).toBe(0);
    });
    test("is absent from the serving profile and search driver", () => {
        for (const name of ["../../src/simulation/search_driver.ts", "../../src/ai/versions/v0_8_a19_profile.ts"])
            expect(readFileSync(new URL(name, import.meta.url), "utf8")).not.toContain(
                "peasant_followthrough_research",
            );
    });
});
