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

import {
    nonRegressionStats,
    parseLiveTwinBatteryArgs,
    runLiveTwinBattery,
} from "../../src/simulation/livetwin_battery";
import type { ITournamentOptions, ITournamentSummary } from "../../src/simulation/tournament";

const ENV_KEYS = [
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "AUGCA_NOVISION",
    "FORCE_CREATURES",
    "SIM_NO_ACTIONS",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const [key, value] of originalEnv) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

const summary = (winsA: number, winsB: number, draws = 0): ITournamentSummary => ({
    versionA: "v0.6",
    versionB: "v0.4",
    games: winsA + winsB + draws,
    baseSeed: 17,
    a: { version: "v0.6", wins: winsA, winsAsGreen: Math.ceil(winsA / 2), winsAsRed: Math.floor(winsA / 2) },
    b: { version: "v0.4", wins: winsB, winsAsGreen: Math.ceil(winsB / 2), winsAsRed: Math.floor(winsB / 2) },
    draws,
    winRateA: winsA + winsB > 0 ? winsA / (winsA + winsB) : 0.5,
    avgLaps: 8,
    endReasons: { elimination: winsA + winsB + draws },
    better: winsA === winsB ? "tie" : winsA > winsB ? "v0.6" : "v0.4",
    armageddonDecided: 0,
    cleanWinRate: 1,
});

describe("LiveTwin cohort battery", () => {
    it("runs the three explicit cohorts with paired tournament options and restores the environment", async () => {
        process.env.LIVETWIN = "ambient-live";
        process.env.FIGHT_MELEE_ROSTERS = "ambient-melee";
        process.env.ROSTER_RANGED_MIN = "ambient-min";
        process.env.ROSTER_RANGED_MAX = "ambient-max";
        process.env.AUGCA_NOVISION = "ambient-vision";
        process.env.FORCE_CREATURES = "1:Peasant";
        process.env.SIM_NO_ACTIONS = "ambient-actions";

        const calls: Array<{
            options: ITournamentOptions;
            concurrency: number;
            env: Record<string, string | undefined>;
        }> = [];
        const results = [summary(60, 40), summary(49, 51), summary(45, 45, 10)];
        const report = await runLiveTwinBattery(
            { versionA: "v0.6", versionB: "v0.4", games: 100, baseSeed: 17, concurrency: 200 },
            {
                now: () => new Date("2026-07-10T12:00:00.000Z"),
                runTournament: (options, concurrency) => {
                    calls.push({
                        options,
                        concurrency,
                        env: Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])),
                    });
                    return results[calls.length - 1];
                },
            },
        );

        expect(calls).toHaveLength(3);
        for (const call of calls) {
            expect(call.options).toEqual({
                versionA: "v0.6",
                versionB: "v0.4",
                games: 100,
                baseSeed: 17,
                amountMode: "expBudget",
                randomizePicks: true,
                lightweight: true,
            });
            expect(call.concurrency).toBe(100);
            expect(call.env.LIVETWIN).toBe("1");
            expect(call.env.AUGCA_NOVISION).toBe("1");
            expect(call.env.FORCE_CREATURES).toBeUndefined();
            expect(call.env.SIM_NO_ACTIONS).toBe("1");
        }
        expect(calls.map((call) => call.env.FIGHT_MELEE_ROSTERS)).toEqual(["1", "0", "0"]);
        expect(calls.map((call) => call.env.ROSTER_RANGED_MIN)).toEqual([undefined, "3", undefined]);
        expect(calls.map((call) => call.env.ROSTER_RANGED_MAX)).toEqual([undefined, "6", undefined]);

        expect(process.env.LIVETWIN).toBe("ambient-live");
        expect(process.env.FIGHT_MELEE_ROSTERS).toBe("ambient-melee");
        expect(process.env.ROSTER_RANGED_MIN).toBe("ambient-min");
        expect(process.env.ROSTER_RANGED_MAX).toBe("ambient-max");
        expect(process.env.AUGCA_NOVISION).toBe("ambient-vision");
        expect(process.env.FORCE_CREATURES).toBe("1:Peasant");
        expect(process.env.SIM_NO_ACTIONS).toBe("ambient-actions");

        expect(report.generatedAt).toBe("2026-07-10T12:00:00.000Z");
        expect(report.totalGames).toBe(300);
        expect(report.effectiveConfig.amountMode).toBe("expBudget");
        expect(report.effectiveConfig.setup).toEqual({
            perk: 3,
            augments: [
                { kind: "Armor", value: 3 },
                { kind: "Might", value: 3 },
                { kind: "Sniper", value: 1 },
            ],
            noVision: true,
        });
        expect(report.cohorts.map((result) => result.cohort.name)).toEqual(["melee", "range", "random"]);
        expect(report.cohorts.map((result) => result.nonRegression.passed)).toEqual([true, false, true]);
        expect(report.allCohortsPassedNonRegression).toBe(false);
    });

    it("reports decisive-only non-regression statistics and uncertainty", () => {
        const stats = nonRegressionStats(summary(55, 45, 10));
        expect(stats.decisiveGames).toBe(100);
        expect(stats.draws).toBe(10);
        expect(stats.winRateA).toBe(0.55);
        expect(stats.deltaFromParityPp).toBeCloseTo(5);
        expect(stats.standardErrorPp).toBeCloseTo(4.9749, 3);
        expect(stats.winRate95.low).toBeLessThan(0.55);
        expect(stats.winRate95.high).toBeGreaterThan(0.55);
        expect(stats.passed).toBe(true);

        const noDecision = nonRegressionStats(summary(0, 0, 2));
        expect(noDecision.winRateA).toBe(0.5);
        expect(noDecision.winRate95).toEqual({ low: 0, high: 1 });
        expect(noDecision.passed).toBe(false);
    });

    it("restores the environment when a cohort tournament fails", async () => {
        process.env.LIVETWIN = "ambient-live";
        process.env.ROSTER_RANGED_MIN = "ambient-min";

        await expect(
            runLiveTwinBattery(
                { versionA: "v0.6", versionB: "v0.4", games: 2, baseSeed: 1, concurrency: 1 },
                {
                    runTournament: () => {
                        throw new Error("synthetic tournament failure");
                    },
                },
            ),
        ).rejects.toThrow("synthetic tournament failure");

        expect(process.env.LIVETWIN).toBe("ambient-live");
        expect(process.env.ROSTER_RANGED_MIN).toBe("ambient-min");
    });

    it("parses the CLI contract and rejects unpaired game counts", () => {
        expect(parseLiveTwinBatteryArgs(["v0.6", "v0.4", "20", "7", "4", "report.json"], "/tmp")).toEqual({
            versionA: "v0.6",
            versionB: "v0.4",
            games: 20,
            baseSeed: 7,
            concurrency: 4,
            outputPath: "/tmp/report.json",
        });
        expect(() => parseLiveTwinBatteryArgs(["v0.6", "v0.4", "21"])).toThrow("even integer");
        expect(() => parseLiveTwinBatteryArgs(["v9.9", "v0.4", "20"])).toThrow("Unknown candidate version");
        expect(() => parseLiveTwinBatteryArgs(["v0.6", "v0.6", "20"])).toThrow("must be different");
    });
});
