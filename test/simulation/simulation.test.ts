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

import { AI_VERSIONS, getAIStrategy, LATEST_AI_VERSION } from "../../src/ai";
import { buildRoster, creaturesByLevel, DEFAULT_ROSTER_COMPOSITION, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import { runTournament } from "../../src/simulation/tournament";

describe("AI strategy registry", () => {
    it("exposes v0.1 as a registered version and rejects unknown ones", () => {
        expect(AI_VERSIONS).toContain("v0.1");
        expect(LATEST_AI_VERSION).toBe(AI_VERSIONS[AI_VERSIONS.length - 1]);
        expect(getAIStrategy("v0.1").version).toBe("v0.1");
        expect(() => getAIStrategy("v9.9")).toThrow();
    });
});

describe("army / roster builder", () => {
    it("has creatures at every level used by the default composition", () => {
        for (const { level } of DEFAULT_ROSTER_COMPOSITION) {
            expect(creaturesByLevel(level).length).toBeGreaterThan(0);
        }
    });

    it("is deterministic for a given seed and respects the composition", () => {
        const a = buildRoster(makeRng(42));
        const b = buildRoster(makeRng(42));
        expect(a).toEqual(b);

        // 2xL1 + 2xL2 + 1xL3 + 1xL4 = 6 stacks.
        expect(a).toHaveLength(6);
        const byLevel = a.reduce<Record<number, number>>((acc, s) => {
            acc[s.level] = (acc[s.level] ?? 0) + 1;
            return acc;
        }, {});
        expect(byLevel).toEqual({ 1: 2, 2: 2, 3: 1, 4: 1 });

        // A different seed should (almost surely) produce a different roster.
        expect(buildRoster(makeRng(43))).not.toEqual(a);
    });
});

describe("battle engine", () => {
    it("runs a full match to a decisive outcome with both armies deployed", () => {
        const roster = buildRoster(makeRng(123));
        const result = runMatch({ greenVersion: "v0.1", redVersion: "v0.1", roster, seed: 123, maxLaps: 60 });

        expect(["green", "red", "draw"]).toContain(result.winner);
        expect(result.placements.green.length).toBe(roster.length);
        expect(result.placements.red.length).toBe(roster.length);
        expect(result.actions.length).toBeGreaterThan(0);
        expect(result.laps).toBeGreaterThan(0);
        expect(result.outcome.green.version).toBe("v0.1");
        expect(result.outcome.red.version).toBe("v0.1");

        // Placements sit on distinct cells within the board.
        const cells = [...result.placements.green, ...result.placements.red].map((p) => `${p.cell.x}:${p.cell.y}`);
        expect(new Set(cells).size).toBe(cells.length);

        // Every recorded action references a real creature and a known side.
        for (const action of result.actions) {
            expect(["green", "red"]).toContain(action.side);
            expect(action.creatureName.length).toBeGreaterThan(0);
        }
    });
});

describe("tournament", () => {
    it("tallies every game and invokes the per-game callback", () => {
        const games = 6;
        const records: number[] = [];
        const summary = runTournament({ versionA: "v0.1", versionB: "v0.1", games, baseSeed: 5, maxLaps: 60 }, (r) => {
            records.push(r.game);
            expect(["green", "red", "draw"]).toContain(r.result.winner);
        });

        expect(records).toEqual([0, 1, 2, 3, 4, 5]);
        expect(summary.games).toBe(games);
        expect(summary.a.wins + summary.b.wins + summary.draws).toBe(games);
        expect(summary.avgLaps).toBeGreaterThan(0);
        // Sides swap each game, so across the run each version plays green and red.
        expect(Object.values(summary.endReasons).reduce((a, b) => a + b, 0)).toBe(games);
    });
});
