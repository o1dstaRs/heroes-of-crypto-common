/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLeagueGenome, LEAGUE_GENOME_DIM } from "../../src/simulation/league_genome";
import {
    buildEmpiricalLeaguePayoff,
    canonicalJson,
    leagueFingerprint,
    solveApproximateZeroSumLeague,
} from "../../src/simulation/optimizer/league_cycle_core";

describe("B1 iterative league core", () => {
    it("fingerprints objects canonically", () => {
        expect(canonicalJson({ z: 1, a: { d: 2, b: 3 } })).toBe('{"a":{"b":3,"d":2},"z":1}');
        expect(leagueFingerprint({ z: 1, a: [2, 3] })).toBe(leagueFingerprint({ a: [2, 3], z: 1 }));
    });

    it("builds a complete antisymmetric matrix while retaining directional disagreement", () => {
        const empirical = buildEmpiricalLeaguePayoff(
            ["a", "b"],
            [
                { candidateId: "a", opponentId: "a", wins: 2, losses: 2, draws: 0 },
                { candidateId: "a", opponentId: "b", wins: 7, losses: 3, draws: 0 },
                { candidateId: "b", opponentId: "a", wins: 4, losses: 6, draws: 0 },
                { candidateId: "b", opponentId: "b", wins: 1, losses: 1, draws: 2 },
            ],
        );
        expect(empirical.directionalScores).toEqual([
            [0.5, 0.7],
            [0.4, 0.5],
        ]);
        expect(empirical.payoffs[0][1]).toBeCloseTo(0.3, 12);
        expect(empirical.payoffs[1][0]).toBeCloseTo(-0.3, 12);
        expect(empirical.maxDirectionalResidual).toBeCloseTo(0.2, 12);
        expect(() => buildEmpiricalLeaguePayoff(["a", "b"], [])).toThrow("Missing payoff cell");
    });

    it("reports low regret and exploitability for an approximate zero-sum mixture", () => {
        const solution = solveApproximateZeroSumLeague(
            ["dominant", "other"],
            [
                [0, 1],
                [-1, 0],
            ],
            20_000,
        );
        expect(solution.symmetricMixture[0].weight).toBeGreaterThan(0.97);
        expect(solution.dualityGap).toBeLessThan(0.04);
        expect(solution.symmetricExploitability).toBeLessThan(0.02);
        expect(solution.rowExternalRegret + solution.adversaryExternalRegret).toBeCloseTo(solution.dualityGap, 10);
    });
});

describe("B1 iterative league smoke", () => {
    it("freezes rounds and a complete separately fingerprinted matrix, then resumes exactly", () => {
        const temporaryDirectory = mkdtempSync(join(tmpdir(), "hoc-league-cycle-"));
        const packageRoot = join(import.meta.dir, "../..");
        const outputPath = join(temporaryDirectory, "out");
        const poolPath = join(temporaryDirectory, "pool.json");
        writeFileSync(
            poolPath,
            JSON.stringify({ entries: [createLeagueGenome("seed-zero", new Array(LEAGUE_GENOME_DIM).fill(0))] }),
        );
        const env = {
            ...process.env,
            CEM_AGGREGATE: "worst-case",
            CEM_ELITE: "1",
            CEM_EVAL_PARALLEL: "1",
            CEM_GAMES: "8",
            CEM_GENS: "1",
            CEM_MAPS: "1",
            CEM_MATCH_CONC: "1",
            CEM_POP: "2",
            CEM_SEED: "17",
            CEM_UNFREEZE_PERK: "0",
            CEM_VAL_GAMES: "8",
            LEAGUE_INITIAL_POOL: poolPath,
            LEAGUE_MATRIX_GAMES: "8",
            LEAGUE_MATRIX_PARALLEL: "1",
            LEAGUE_MATRIX_SEED: "999",
            LEAGUE_NASH_ITERS: "1000",
            LEAGUE_OUT: outputPath,
            LEAGUE_ROUNDS: "1",
            LEAGUE_SMOKE: "1",
        };
        const run = (overrides: Record<string, string> = {}) =>
            Bun.spawnSync({
                cmd: [process.execPath, "src/simulation/optimizer/league_cycle.mjs"],
                cwd: packageRoot,
                env: { ...env, ...overrides },
                stderr: "pipe",
                stdout: "pipe",
            });
        try {
            const first = run();
            expect(new TextDecoder().decode(first.stderr)).toBe("");
            expect(first.exitCode).toBe(0);

            const state = JSON.parse(readFileSync(join(outputPath, "state.json"), "utf8")) as {
                rounds: { resultPath: string }[];
                latestMatrix: { panelFingerprint: string; reportPath: string };
            };
            expect(state.rounds).toHaveLength(1);
            const resultPath = join(outputPath, state.rounds[0].resultPath);
            const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
                provenance: { selectionPanelFingerprint: string };
            };
            const reportPath = join(outputPath, state.latestMatrix.reportPath);
            const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
                complete: boolean;
                totalCells: number;
                observations: unknown[];
                approximateZeroSum: { dualityGap: number; rowExternalRegret: number };
                pureWorstCaseSelection: { entrantId: string; worstCasePayoff: number };
                gateDecision: { verdict: string; acceptance: boolean; kill: boolean };
                qualification: string;
            };
            expect(report.complete).toBe(true);
            expect(report.totalCells).toBe(4);
            expect(report.observations).toHaveLength(4);
            expect(report.approximateZeroSum.dualityGap).toBeGreaterThanOrEqual(0);
            expect(report.approximateZeroSum.rowExternalRegret).toBeGreaterThanOrEqual(0);
            expect(report.pureWorstCaseSelection.entrantId).toBeTruthy();
            expect(report.pureWorstCaseSelection.worstCasePayoff).toBeLessThanOrEqual(0);
            expect(report.gateDecision).toEqual({
                verdict: "measurement_only_no_acceptance_or_kill",
                acceptance: false,
                kill: false,
                reason: "This league cycle is not the preregistered powered v0.7 acceptance matrix.",
            });
            expect(report.qualification).toContain("Approximate Nash");
            expect(state.latestMatrix.panelFingerprint).not.toBe(result.provenance.selectionPanelFingerprint);
            expect(statSync(resultPath).mode & 0o222).toBe(0);
            expect(statSync(reportPath).mode & 0o222).toBe(0);
            const resultModified = statSync(resultPath).mtimeMs;
            const reportModified = statSync(reportPath).mtimeMs;

            const resumed = run();
            expect(new TextDecoder().decode(resumed.stderr)).toBe("");
            expect(resumed.exitCode).toBe(0);
            expect(statSync(resultPath).mtimeMs).toBe(resultModified);
            expect(statSync(reportPath).mtimeMs).toBe(reportModified);

            const incompatible = run({ LEAGUE_MATRIX_SEED: "1001" });
            expect(incompatible.exitCode).not.toBe(0);
            expect(new TextDecoder().decode(incompatible.stderr)).toContain("does not match");
        } finally {
            rmSync(temporaryDirectory, { force: true, recursive: true });
        }
    }, 120_000);
});
