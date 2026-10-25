import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
    firstContactAugments,
    firstContactBudgets,
    firstContactJobs,
    firstContactMeleeTargets,
    playFirstContactJob,
    summarizeFirstContact,
} from "../../src/simulation/measure_first_contact_placement";
import { AI_META_COHORTS } from "../../src/simulation/ai_meta_cohorts_core";
import {
    BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
    TRAPPED_MELEE_RESCUE_CANDIDATE,
} from "../../src/simulation/blocked_approach_placement_research";

const environmentKeys = ["SIM_NO_ACTIONS", "LIVETWIN", "FIGHT_MELEE_ROSTERS", "V08_A19_SEARCH", "V08_A13_SEARCH"];
let savedEnvironment: Map<string, string | undefined>;
beforeEach(() => {
    savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
});
afterEach(() => {
    for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("first-contact research design", () => {
    test("keeps the ordinary engine repair when a native formation omits a stack", () => {
        const job = {
            candidate: TRAPPED_MELEE_RESCUE_CANDIDATE,
            cohort: "uniform-mixed" as const,
            pair: 61,
            map: 1 as const,
            side: "green" as const,
            formation: "compact" as const,
            arm: "control" as const,
            mode: "audit" as const,
            baseSeed: 102520291,
            maxLaps: 60,
        };
        const control = playFirstContactJob(job);
        const candidate = playFirstContactJob({ ...job, arm: "candidate" });
        const broad = playFirstContactJob({
            ...job,
            arm: "candidate",
            candidate: BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
        });
        expect(control.incumbentFallback).toBe(true);
        expect(candidate.proposedChange).toBe(false);
        expect(broad.proposedChange).toBe(false);
        expect(candidate.ownPlacement).toEqual(control.ownPlacement);
        expect(broad.ownPlacement).toEqual(control.ownPlacement);
        expect(control.ownPlacement.every((unit) => Number.isInteger(unit.x) && Number.isInteger(unit.y))).toBe(true);
    });
    test("trapped rescue and passive observers preserve a real changed fight", () => {
        const job = {
            candidate: TRAPPED_MELEE_RESCUE_CANDIDATE,
            cohort: "uniform-mixed" as const,
            pair: 30,
            map: 1 as const,
            side: "red" as const,
            formation: "current" as const,
            arm: "candidate" as const,
            mode: "heuristic" as const,
            baseSeed: 102520282,
            maxLaps: 60,
        };
        const original = playFirstContactJob(job);
        let before = 0,
            decisions = 0,
            turns = 0;
        const observed = playFirstContactJob(job, {
            beforeFightStart(context) {
                before++;
                expect(context.unitsHolder.getAllUnits().size).toBeGreaterThan(1);
            },
            decisionObserver() {
                decisions++;
            },
            turnExecutionObserver() {
                turns++;
            },
        });
        expect(original.actualChange).toBe(true);
        expect(original.openingRoutes.find((route) => route.moved)?.before).toBe(0);
        expect(before).toBe(1);
        expect(decisions).toBeGreaterThan(0);
        expect(turns).toBeGreaterThan(0);
        const { elapsedMs: _a, ...a } = original;
        const { elapsedMs: _b, ...b } = observed;
        expect(a).toEqual(b);
    });
    test("the new candidate crosses all nine budget pairings and stays a distinct experiment", () => {
        expect(
            new Set(
                Array.from({ length: 9 }, (_, i) =>
                    firstContactBudgets(i, BLOCKED_APPROACH_PLACEMENT_CANDIDATE).join("/"),
                ),
            ).size,
        ).toBe(9);
        const jobs = firstContactJobs(64, 102520272, "heuristic", BLOCKED_APPROACH_PLACEMENT_CANDIDATE);
        expect(jobs).toHaveLength(16128);
        expect(jobs.every((job) => job.candidate === BLOCKED_APPROACH_PLACEMENT_CANDIDATE)).toBe(true);
        const baseline = playFirstContactJob({ ...jobs[0], mode: "audit" });
        expect(() =>
            summarizeFirstContact([baseline, { ...baseline, candidate: "grounded-carry-depth-swap-v1" }]),
        ).toThrow("different research candidates");
    });
    test("a congested red-side formation receives exactly one legal lateral move and reproduces", () => {
        const job = {
            candidate: BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
            cohort: "ranked-draft" as const,
            pair: 1,
            map: 3 as const,
            side: "red" as const,
            formation: "current" as const,
            arm: "candidate" as const,
            mode: "heuristic" as const,
            baseSeed: 102520270,
            maxLaps: 60,
        };
        const control = playFirstContactJob({ ...job, arm: "control" });
        const first = playFirstContactJob(job);
        const second = playFirstContactJob(job);
        expect(first.actualChange).toBe(true);
        expect(first.actualSwap).toBe(false);
        expect(first.forwardReachGain).toBeGreaterThanOrEqual(1);
        expect(first.rejected + first.opponentRejected).toBe(0);
        const changes = first.ownPlacement.flatMap((after, i) => {
            const before = control.ownPlacement[i];
            return before.x === after.x && before.y === after.y ? [] : [{ before, after }];
        });
        expect(changes).toHaveLength(1);
        expect(changes[0].before.x).toBe(changes[0].after.x);
        expect(Math.abs(changes[0].before.y - changes[0].after.y)).toBeLessThanOrEqual(2);
        expect(first.groundMeleeStacks).toBe(control.groundMeleeStacks);
        expect(first.groundMeleeStacks).toBeGreaterThanOrEqual(2);
        const { elapsedMs: _first, ...a } = first;
        const { elapsedMs: _second, ...b } = second;
        expect(a).toEqual(b);
    });
    test("the congestion proposal is invariant to hidden enemy deployment changes", () => {
        const variants = (["current", "compact", "spread"] as const).map((formation) =>
            playFirstContactJob({
                candidate: BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
                cohort: "ranked-draft",
                pair: 1,
                map: 3,
                side: "red",
                formation,
                arm: "candidate",
                mode: "audit",
                baseSeed: 102520270,
                maxLaps: 60,
            }),
        );
        expect(variants[0].actualChange).toBe(true);
        expect(variants.map((r) => r.forwardReachGain)).toEqual([
            variants[0].forwardReachGain,
            variants[0].forwardReachGain,
            variants[0].forwardReachGain,
        ]);
        expect(variants[1].ownPlacement).toEqual(variants[0].ownPlacement);
        expect(variants[2].ownPlacement).toEqual(variants[0].ownPlacement);
    });
    test("the final split pass cannot move a support companion as a side effect", () => {
        const job = {
            candidate: BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
            cohort: "ranked-draft" as const,
            pair: 21,
            map: 1 as const,
            side: "green" as const,
            formation: "current" as const,
            arm: "control" as const,
            mode: "audit" as const,
            baseSeed: 102520272,
            maxLaps: 60,
        };
        const control = playFirstContactJob(job);
        const candidate = playFirstContactJob({ ...job, arm: "candidate" });
        const changes = candidate.ownPlacement.filter((after, i) => {
            const before = control.ownPlacement[i];
            return after.x !== before.x || after.y !== before.y;
        });
        expect(changes).toHaveLength(Number(candidate.proposedChange));
        for (const companion of candidate.ownPlacement.filter((unit) => unit.amount === 1)) {
            expect(control.ownPlacement).toContainEqual(companion);
        }
    });
    test("counts accepted melee contact even when headless events omit attack animations", () => {
        expect(
            firstContactMeleeTargets(
                [
                    {
                        action: { type: "melee_attack", unitId: "enemy", targetId: "carry" },
                        completed: true,
                        events: [],
                    },
                    {
                        action: { type: "melee_attack", unitId: "enemy", targetId: "other" },
                        completed: true,
                        events: [],
                    },
                    {
                        action: { type: "melee_attack", unitId: "enemy", targetId: "carry" },
                        completed: false,
                        events: [],
                    },
                    {
                        action: { type: "range_attack", unitId: "enemy", targetId: "carry" },
                        completed: true,
                        events: [],
                    },
                ],
                new Set(["carry"]),
            ),
        ).toEqual(["carry"]);
    });
    test("crosses seven cohorts, maps, sides, formations and both paired arms", () => {
        const jobs = firstContactJobs(32, 102520262, "heuristic");
        expect(jobs).toHaveLength(8064);
        expect(new Set(jobs.map((j) => j.cohort)).size).toBe(7);
        for (const cohort of AI_META_COHORTS)
            for (const map of [1, 3, 4])
                for (const side of ["green", "red"])
                    for (const formation of ["current", "compact", "spread"]) {
                        const cell = jobs.filter(
                            (j) => j.cohort === cohort && j.map === map && j.side === side && j.formation === formation,
                        );
                        expect(cell.filter((j) => j.arm === "control")).toHaveLength(32);
                        expect(cell.filter((j) => j.arm === "candidate")).toHaveLength(32);
                    }
    });
    test("all stress builds spend their budget without buying Placement", () => {
        for (const names of [
            ["Elf", "Dryad", "Pikeman", "Troll"],
            ["Battle Mage", "Wandering Mage", "Pikeman", "Healer"],
            ["Peasant", "Pikeman", "Trent", "Goblin Knight"],
        ])
            for (const budget of [5, 6, 7])
                for (const fast of [false, true]) {
                    const plan = firstContactAugments(names, budget, fast);
                    expect(plan.reduce((sum, a) => sum + a.value, 0)).toBe(budget);
                    expect(plan.every((a) => a.kind !== "Placement" && a.value > 0 && a.value <= 3)).toBe(true);
                }
    });
    test("a changed real-engine case is reproducible and completes without rejected actions", () => {
        const job = {
            cohort: "ranked-draft" as const,
            pair: 18,
            map: 1 as const,
            side: "green" as const,
            formation: "current" as const,
            arm: "candidate" as const,
            mode: "heuristic" as const,
            baseSeed: 102520261,
            maxLaps: 60,
        };
        const a = playFirstContactJob(job);
        const b = playFirstContactJob(job);
        expect(a.actualSwap).toBe(true);
        expect(a.rejected + a.opponentRejected).toBe(0);
        expect(a.endReason).toBe("elimination");
        const { elapsedMs: _a, ...first } = a;
        const { elapsedMs: _b, ...second } = b;
        expect(first).toEqual(second);
    });
    test("records real melee contact in a headless fight", () => {
        const result = playFirstContactJob({
            cohort: "caster-support",
            pair: 2,
            map: 1,
            side: "red",
            formation: "current",
            arm: "control",
            mode: "heuristic",
            baseSeed: 102520262,
            maxLaps: 60,
        });
        expect(result.firstCarryContactLap).not.toBeNull();
        expect(result.firstCarryContactLap!).toBeGreaterThanOrEqual(1);
    });
    test("matched control/candidate outcomes are clustered by army rather than mirrored fight", () => {
        const jobs = firstContactJobs(1, 102520260, "audit").slice(0, 2);
        const records = jobs.flatMap((j) => {
            const control = playFirstContactJob(j);
            return [
                { ...control, mode: "heuristic" as const, arm: "control" as const, score: 0 },
                { ...control, mode: "heuristic" as const, arm: "candidate" as const, score: 1 },
            ];
        });
        const summary = summarizeFirstContact(records);
        expect(summary.outcomePairs).toBe(2);
        expect(summary.overall.clusters).toBe(1);
        expect(summary.overall.deltaPp).toBe(100);
    });
});
