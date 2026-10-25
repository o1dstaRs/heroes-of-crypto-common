import { afterEach, describe, expect, test } from "bun:test";

import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { makeSearchChanceStream } from "../../src/simulation/search_chance_sampling";
import { SearchDriver } from "../../src/simulation/search_driver";

interface IReferenceDriver {
    deps: ILookaheadDeps;
    rollouts: number;
    rollout(unit: Unit, candidate: unknown, seed: number, index: number, mode: string, ...rest: unknown[]): number;
    scoreCandidates(
        unit: Unit,
        candidates: readonly unknown[],
        seed: number,
        mode: string,
        ...rest: unknown[]
    ): number[];
}

const savedOverride = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
const prototype = SearchDriver.prototype as unknown as IReferenceDriver;
const originalRollout = prototype.rollout;
const originalScore = prototype.scoreCandidates;

afterEach(() => {
    prototype.rollout = originalRollout;
    prototype.scoreCandidates = originalScore;
    if (savedOverride === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    else process.env.V08_A19_SEARCH_ENV_OVERRIDES = savedOverride;
});

const match: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    roster: [
        { faction: "Might", creatureName: "Harpy", level: 2, size: 1, amount: 20 },
        { faction: "Nature", creatureName: "Trent", level: 2, size: 1, amount: 24 },
    ],
    seed: 92501,
    maxLaps: 4,
    searchOfflineDeterministicWork: true,
};

describe("complementary R2 integration", () => {
    test("uses the first complementary stream for single samples and independent higher-budget references", () => {
        delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
        for (const budget of [1, 8]) {
            let issued = false;
            let referenceActive = false;
            const flags: boolean[] = [];
            const sampledIndices: number[] = [];
            prototype.rollout = function (...args) {
                if (referenceActive) {
                    flags.push(args[7] === true);
                    sampledIndices.push(args[3]);
                }
                return originalRollout.apply(this, args);
            };
            prototype.scoreCandidates = function (...args) {
                if (!issued && args[3] === "turns") {
                    issued = true;
                    referenceActive = true;
                    try {
                        const cache =
                            budget > 2
                                ? new Map(args[1].map((candidate) => [candidate, new Map([[0, { score: 0.5 }]])]))
                                : undefined;
                        return originalScore.call(
                            this,
                            args[0],
                            args[1],
                            args[2],
                            args[3],
                            budget,
                            null,
                            0,
                            false,
                            cache,
                        );
                    } finally {
                        referenceActive = false;
                    }
                }
                return originalScore.apply(this, args);
            };
            runMatch({ ...match, maxLaps: 1 });
            expect(issued).toBe(true);
            expect(flags.length).toBeGreaterThanOrEqual(budget);
            expect(flags.every((flag) => flag === (budget === 1))).toBe(true);
            expect(sampledIndices).toContain(0);
        }
    }, 120_000);

    test("matches the measured first-action interception across all live maps", () => {
        for (const gridType of [1, 3, 4]) {
            const config = { ...match, gridType };
            delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
            const integrated = runMatch(config);
            let intercepted = 0;
            const caches = new WeakMap<object, { hashes: Map<string, number> }>();
            process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_COMPLEMENTARY_R2: "0" });
            // Independent reference: the measured candidate installed its stream immediately before apply.
            prototype.rollout = function (...args) {
                if (this.rollouts !== 2 || args[4] !== "turns") return originalRollout.apply(this, args);
                const engine = this.deps.engine;
                const apply = engine.apply;
                let first = true;
                engine.apply = (...actions: Parameters<typeof apply>) => {
                    if (first) {
                        first = false;
                        let cache = caches.get(engine);
                        if (!cache) {
                            cache = { hashes: new Map() };
                            caches.set(engine, cache);
                        }
                        setDeterministicRandomSource(
                            makeSearchChanceStream(args[2], args[3], "actor-antithetic", this.deps, cache),
                        );
                        intercepted++;
                    }
                    return apply.apply(engine, actions);
                };
                try {
                    return originalRollout.apply(this, args);
                } finally {
                    engine.apply = apply;
                }
            };
            const reference = runMatch(config);
            prototype.rollout = originalRollout;
            expect(intercepted).toBeGreaterThan(0);
            expect(integrated).toEqual(reference);
            expect(integrated.rejectedGreen ?? 0).toBe(0);
            expect(integrated.rejectedRed ?? 0).toBe(0);
        }
    }, 120_000);

    test("keeps explicit R4 actions and complete outcomes unchanged with the R2 switch present", () => {
        const results = ["0", "1"].map((flag) => {
            process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
                SEARCH_ROLLOUTS: "4",
                SEARCH_A19_COMPLEMENTARY_R2: flag,
            });
            return runMatch(match);
        });
        expect(results[0].actions.length).toBeGreaterThan(0);
        expect(results[0]).toEqual(results[1]);
    }, 120_000);
});
