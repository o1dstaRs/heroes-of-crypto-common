/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { cpus } from "node:os";

import { describe, expect, it } from "bun:test";

import {
    captureV07OvernightExecutionHost,
    chooseV07OvernightDeepEvidence,
    compareV07OvernightCircuitEvidence,
    compareV07OvernightEvidence,
    qualifiesV07OvernightCircuit,
    summarizeV07OvernightCircuitAuditRows,
    type IV07OvernightEvidence,
} from "../../src/simulation/optimizer/v0_7_overnight_core";

function evidence(
    profileId: string,
    patch: {
        circuitQualified?: boolean;
        integrityQualified?: boolean;
        integrityUtility?: number;
        utilityDecisiveWinRate?: number;
        circuitOpenGameRate?: number;
        p95?: number | null;
        minimumTemplateRate?: number;
        maximumDrawOrArmageddonRate?: number;
    } = {},
): IV07OvernightEvidence {
    return {
        profileId,
        circuit: {
            circuitOpenGameRate: patch.circuitOpenGameRate ?? 0,
            turnLatencyMs: { p95: patch.p95 ?? 100 },
        },
        summary: {
            circuitQualified: patch.circuitQualified ?? true,
            integrityQualified: patch.integrityQualified ?? true,
            integrityUtility: patch.integrityUtility ?? 0.91,
            utilityDecisiveWinRate: patch.utilityDecisiveWinRate ?? 0.91,
            minimumTemplateRate: patch.minimumTemplateRate ?? 0.91,
            maximumDrawOrArmageddonRate: patch.maximumDrawOrArmageddonRate ?? 0,
        },
    };
}

describe("v0.7 overnight selection", () => {
    it("ranks both hard gates before continuous utility", () => {
        const clean = evidence("clean", { integrityUtility: 0.91, utilityDecisiveWinRate: 0.91 });
        const integrityFailure = evidence("integrity-failure", {
            integrityQualified: false,
            integrityUtility: 0.99,
            utilityDecisiveWinRate: 0.99,
        });
        const circuitFailure = evidence("circuit-failure", {
            circuitQualified: false,
            integrityUtility: 1,
            utilityDecisiveWinRate: 1,
        });

        expect(
            [integrityFailure, circuitFailure, clean]
                .sort(compareV07OvernightEvidence)
                .map(({ profileId }) => profileId),
        ).toEqual(["clean", "integrity-failure", "circuit-failure"]);
    });

    it("uses p95 latency to break equal circuit-open rates", () => {
        const slow = evidence("slow", { circuitOpenGameRate: 0.25, p95: 900 });
        const fast = evidence("fast", { circuitOpenGameRate: 0.25, p95: 200 });

        expect([slow, fast].sort(compareV07OvernightCircuitEvidence).map(({ profileId }) => profileId)).toEqual([
            "fast",
            "slow",
        ]);
    });

    it("keeps distinct overall, utility, and circuit representatives", () => {
        const overall = evidence("overall", { integrityUtility: 0.95, utilityDecisiveWinRate: 0.92 });
        const utility = evidence("utility", { integrityUtility: 0.9, utilityDecisiveWinRate: 0.99 });
        const circuit = evidence("circuit", {
            integrityUtility: 0.89,
            utilityDecisiveWinRate: 0.89,
            circuitOpenGameRate: 0,
            p95: 50,
        });
        overall.circuit.circuitOpenGameRate = 0.1;
        utility.circuit.circuitOpenGameRate = 0.2;

        expect(
            chooseV07OvernightDeepEvidence([utility, circuit, overall], 3).map(({ profileId }) => profileId),
        ).toEqual(["overall", "utility", "circuit"]);
    });

    it("keeps specialty representatives inside the best qualification stratum", () => {
        const overall = evidence("qualified-overall", { integrityUtility: 0.98, utilityDecisiveWinRate: 0.92 });
        const utility = evidence("qualified-utility", { integrityUtility: 0.9, utilityDecisiveWinRate: 0.97 });
        const circuit = evidence("qualified-circuit", {
            integrityUtility: 0.89,
            utilityDecisiveWinRate: 0.89,
            circuitOpenGameRate: 0.001,
            p95: 100,
        });
        overall.circuit.circuitOpenGameRate = 0.005;
        utility.circuit.circuitOpenGameRate = 0.006;
        const unqualifiedUtility = evidence("unqualified-utility", {
            integrityQualified: false,
            integrityUtility: 1,
            utilityDecisiveWinRate: 1,
        });
        const unqualifiedCircuit = evidence("unqualified-circuit", {
            circuitQualified: false,
            circuitOpenGameRate: 0,
            p95: 1,
        });

        expect(
            chooseV07OvernightDeepEvidence([unqualifiedUtility, utility, unqualifiedCircuit, circuit, overall], 3).map(
                ({ profileId }) => profileId,
            ),
        ).toEqual(["qualified-overall", "qualified-utility", "qualified-circuit"]);
    });

    it("orders a weighted deep arm after its same-envelope zero control", () => {
        const h12Control = evidence("h12-w0", { integrityUtility: 0.88 });
        const h12Weighted = evidence("h12-w2", { integrityUtility: 0.99, utilityDecisiveWinRate: 0.95 });
        const h8Control = evidence("h8-w0", { integrityUtility: 0.87 });
        const h8Weighted = evidence("h8-w4", { integrityUtility: 0.98, utilityDecisiveWinRate: 1 });
        const controls = new Map([
            [h12Weighted.profileId, h12Control.profileId],
            [h8Weighted.profileId, h8Control.profileId],
        ]);

        expect(
            chooseV07OvernightDeepEvidence([h8Weighted, h12Control, h8Control, h12Weighted], 3, controls).map(
                ({ profileId }) => profileId,
            ),
        ).toEqual(["h12-w0", "h12-w2", "h8-w0"]);
    });
});

describe("v0.7 overnight execution host", () => {
    it("captures stable timing-host identity", () => {
        const host = captureV07OvernightExecutionHost();
        expect(host).toMatchObject({
            platform: process.platform,
            arch: process.arch,
            logicalCpuCount: cpus().length,
        });
        expect(host.osRelease.length).toBeGreaterThan(0);
        expect(host.cpuModel.length).toBeGreaterThan(0);
    });
});

describe("v0.7 overnight circuit diagnostics", () => {
    it("rejects one bad template even when aggregate evidence passes", () => {
        const expected = new Map<string, string>();
        const rows: Record<string, unknown>[] = [];
        const templates = ["aura", "mage", "melee", "melee_magic_utility", "ranged", "support", "tank", "utility"];
        for (const [templateIndex, template] of templates.entries()) {
            for (let game = 0; game < 16; game += 1) {
                const seed = templateIndex * 100 + game;
                const green = game % 2 === 0 ? "v0.7" : "v0.6";
                const red = game % 2 === 0 ? "v0.6" : "v0.7";
                const key = `${seed}|${green}|${red}`;
                const badGame = template === "melee_magic_utility" && game === 0;
                expected.set(key, template);
                rows.push({ t: "turn", seed, green, red, ms: badGame ? 300 : 10 });
                rows.push({
                    t: "game",
                    seed,
                    green,
                    red,
                    mode: "search",
                    searched: 1,
                    circuitBreakerMs: 275,
                    circuitOpened: badGame,
                    circuitSkipped: 0,
                });
            }
        }

        const diagnostics = summarizeV07OvernightCircuitAuditRows(rows, expected, 275);

        expect(diagnostics.auditGames).toBe(128);
        expect(diagnostics.circuitOpenGameRate).toBeLessThanOrEqual(0.01);
        expect(diagnostics.turnLatencyMs.p95).toBe(10);
        expect(diagnostics.byTemplate.melee_magic_utility).toMatchObject({
            auditGames: 16,
            circuitOpenGames: 1,
            circuitOpenGameRate: 1 / 16,
            overBudgetGames: 1,
        });
        expect(diagnostics.byTemplate.melee_magic_utility.turnLatencyMs.p95).toBe(300);
        expect(qualifiesV07OvernightCircuit(diagnostics, 0.01, 275)).toBeFalse();
    });

    it("qualifies when every template independently passes", () => {
        const expected = new Map([
            ["1|v0.7|v0.6", "mage"],
            ["2|v0.6|v0.7", "ranged"],
        ]);
        const rows = [
            { t: "turn", seed: 1, green: "v0.7", red: "v0.6", ms: 150 },
            {
                t: "game",
                seed: 1,
                green: "v0.7",
                red: "v0.6",
                mode: "search",
                searched: 1,
                circuitBreakerMs: 275,
                circuitOpened: false,
                circuitSkipped: 0,
            },
            { t: "turn", seed: 2, green: "v0.6", red: "v0.7", ms: 200 },
            {
                t: "game",
                seed: 2,
                green: "v0.6",
                red: "v0.7",
                mode: "search",
                searched: 1,
                circuitBreakerMs: 275,
                circuitOpened: false,
                circuitSkipped: 0,
            },
        ];

        const diagnostics = summarizeV07OvernightCircuitAuditRows(rows, expected, 275);

        expect(Object.keys(diagnostics.byTemplate)).toEqual(["mage", "ranged"]);
        expect(qualifiesV07OvernightCircuit(diagnostics, 0.01, 275)).toBeTrue();
    });

    it("strictly reconciles shortlist and deadline work from turns into each game summary", () => {
        const expected = new Map([["1|v0.7|v0.6", "mage"]]);
        const turns = [
            {
                t: "turn",
                seed: 1,
                green: "v0.7",
                red: "v0.6",
                ms: 100,
                nc: 5,
                ns: 2,
                inc: "wait",
                chosen: "melee",
                ov: 1,
                d: 0.2,
            },
            {
                t: "turn",
                seed: 1,
                green: "v0.7",
                red: "v0.6",
                ms: 240,
                nc: 4,
                ns: 0,
                inc: "spell",
                chosen: "spell",
                ov: 0,
                d: null,
                deadlineFallback: 1,
            },
        ];
        const game = {
            t: "game",
            seed: 1,
            green: "v0.7",
            red: "v0.6",
            mode: "search",
            searched: 2,
            candidatesTotal: 9,
            scoredCandidatesTotal: 2,
            shortlist: 2,
            decisionDeadlineMs: 240,
            deadlineFallbacks: 1,
            lateRangedFinishWeight: 2,
            initialBoardRangedness: 0.5,
            finishPressureLeaves: 10,
            finishPressureNonzeroLeaves: 2,
            finishPressureLogitSum: 1.25,
            circuitBreakerMs: 275,
            circuitOpened: false,
            circuitSkipped: 0,
        };
        const work = { shortlist: 2, decisionDeadlineMs: 240, lateRangedFinishWeight: 2 };

        const diagnostics = summarizeV07OvernightCircuitAuditRows([...turns, game], expected, 275, work);
        expect(diagnostics.work).toEqual({
            enumeratedCandidatesTotal: 9,
            scoredCandidatesTotal: 2,
            deadlineFallbacks: 1,
            finishPressureEligibleGames: 1,
            finishPressureLeaves: 10,
            finishPressureNonzeroLeaves: 2,
            finishPressureLogitSum: 1.25,
        });

        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [...turns, { ...game, scoredCandidatesTotal: undefined }],
                expected,
                275,
                work,
            ),
        ).toThrow("Invalid overnight circuit summary");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows([{ ...turns[0], ns: 3 }, turns[1], game], expected, 275, work),
        ).toThrow("Invalid overnight search-work turn row");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [turns[0], { ...turns[1], chosen: "melee" }, game],
                expected,
                275,
                work,
            ),
        ).toThrow("Invalid overnight search-work turn row");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows([...turns, { ...game, candidatesTotal: 8 }], expected, 275, work),
        ).toThrow("Overnight search-work totals mismatch");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows([...turns, { ...game, shortlist: null }], expected, 275, work),
        ).toThrow("Invalid overnight circuit summary");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [...turns, { ...game, decisionDeadlineMs: 239 }],
                expected,
                275,
                work,
            ),
        ).toThrow("Invalid overnight circuit summary");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [...turns, { ...game, lateRangedFinishWeight: 1 }],
                expected,
                275,
                work,
            ),
        ).toThrow("Invalid overnight circuit summary");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [...turns, { ...game, finishPressureLogitSum: 21 }],
                expected,
                275,
                work,
            ),
        ).toThrow("Invalid overnight circuit summary");
        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [
                    ...turns,
                    {
                        ...game,
                        initialBoardRangedness: 0,
                        finishPressureNonzeroLeaves: 1,
                        finishPressureLogitSum: 0.5,
                    },
                ],
                expected,
                275,
                work,
            ),
        ).toThrow("Invalid overnight circuit summary");
    });

    it("rejects unsupported rows and string-coerced game identities", () => {
        const expected = new Map([["1|v0.7|v0.6", "mage"]]);
        const game = {
            t: "game",
            seed: 1,
            green: "v0.7",
            red: "v0.6",
            mode: "search",
            searched: 0,
            circuitBreakerMs: 275,
            circuitOpened: false,
            circuitSkipped: 0,
        };

        expect(() =>
            summarizeV07OvernightCircuitAuditRows(
                [{ t: "bogus", seed: 1, green: "v0.7", red: "v0.6" }, game],
                expected,
                275,
            ),
        ).toThrow("Unsupported overnight audit row type");
        expect(() => summarizeV07OvernightCircuitAuditRows([{ ...game, seed: "1" }], expected, 275)).toThrow(
            "Invalid overnight audit game identity",
        );
    });

    it("requires search-mode game summaries and exact per-game turn counts", () => {
        const expected = new Map([["1|v0.7|v0.6", "mage"]]);
        const turn = { t: "turn", seed: 1, green: "v0.7", red: "v0.6", ms: 10 };
        const game = {
            t: "game",
            seed: 1,
            green: "v0.7",
            red: "v0.6",
            mode: "search",
            searched: 1,
            circuitBreakerMs: 275,
            circuitOpened: false,
            circuitSkipped: 0,
        };

        expect(() =>
            summarizeV07OvernightCircuitAuditRows([turn, { ...game, mode: "ablation" }], expected, 275),
        ).toThrow("Invalid overnight circuit summary");
        expect(() => summarizeV07OvernightCircuitAuditRows([turn, { ...game, searched: 2 }], expected, 275)).toThrow(
            "Overnight searched-turn count mismatch",
        );
    });

    it("rejects cross-template turn re-attribution even when the aggregate count matches", () => {
        const expected = new Map([
            ["1|v0.7|v0.6", "mage"],
            ["2|v0.6|v0.7", "ranged"],
        ]);
        const game = (seed: number, green: string, red: string) => ({
            t: "game",
            seed,
            green,
            red,
            mode: "search",
            searched: 1,
            circuitBreakerMs: 275,
            circuitOpened: false,
            circuitSkipped: 0,
        });
        const rows = [
            { t: "turn", seed: 2, green: "v0.6", red: "v0.7", ms: 10 },
            game(1, "v0.7", "v0.6"),
            { t: "turn", seed: 2, green: "v0.6", red: "v0.7", ms: 10 },
            game(2, "v0.6", "v0.7"),
        ];

        expect(rows.filter(({ t }) => t === "turn")).toHaveLength(2);
        expect(rows.filter(({ t }) => t === "game")).toHaveLength(2);
        expect(() => summarizeV07OvernightCircuitAuditRows(rows, expected, 275)).toThrow(
            "Overnight searched-turn count mismatch for 1|v0.7|v0.6",
        );
    });

    it("requires an over-budget searched turn to open its game circuit", () => {
        const expected = new Map([["1|v0.7|v0.6", "mage"]]);
        const rows = [
            { t: "turn", seed: 1, green: "v0.7", red: "v0.6", ms: 300 },
            {
                t: "game",
                seed: 1,
                green: "v0.7",
                red: "v0.6",
                mode: "search",
                searched: 1,
                circuitBreakerMs: 275,
                circuitOpened: false,
                circuitSkipped: 0,
            },
        ];

        expect(() => summarizeV07OvernightCircuitAuditRows(rows, expected, 275)).toThrow(
            "Overnight over-budget game did not open its circuit",
        );
    });
});
