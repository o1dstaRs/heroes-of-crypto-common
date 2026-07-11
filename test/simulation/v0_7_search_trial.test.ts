/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { IIntegrityStats, IPairClusterStats } from "../../src/simulation/v0_7_acceptance";
import { V07_96H_TEMPLATES, deriveV0796hSeed, type V0796hTemplate } from "../../src/simulation/optimizer/v0_7_96h_core";
import {
    buildV07SearchTrialCellSpecs,
    buildV07SearchTrialCellShards,
    buildV07SearchTrialReport,
    deriveV07SearchTrialSeed,
    parseV07SearchTrialArgs,
    runV07SearchTrial,
    snapshotV07SearchBehaviorEnvironment,
    summarizeV07SearchAuditRows,
    v07SearchTrialCellConcurrency,
    v07SearchTrialParallelCells,
    writeV07SearchTrialReportAtomic,
    type IV07SearchTrialGitRevision,
    type IV07SearchTrialOptions,
} from "../../src/simulation/optimizer/v0_7_search_trial";
import type {
    IActionTelemetry,
    IV07ArchetypeCellReport,
    IV07ArchetypeCellSpec,
} from "../../src/simulation/v0_7_archetype_battery";

const revision: IV07SearchTrialGitRevision = {
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitDate: "2026-07-11T00:00:00Z",
    branch: "main",
    remote: "git@example.invalid:common.git",
    trackedClean: true,
    trackedDiffSha256: null,
    worktreeClean: true,
    statusPorcelainSha256: "clean",
    untrackedPaths: [],
};

function options(
    templates: V0796hTemplate[] = V07_96H_TEMPLATES.map(({ template }) => template),
): IV07SearchTrialOptions {
    return {
        candidate: "v0.7",
        opponent: "v0.6",
        templates,
        gamesPerTemplate: 4,
        runId: "test-run",
        panelId: "train-000",
        baseSeed: null,
        seeds: null,
        concurrency: 12,
        outputPath: "/tmp/v0_7_search_trial.json",
        auditPath: null,
        auditTurns: false,
        checkpointDir: null,
        checkpointGames: 200,
    };
}

function telemetry(): IActionTelemetry {
    return { decisions: 0, actionTypes: {}, spells: {}, creatures: {}, creatureActions: {} };
}

function outcomes(candidateWins: number, opponentWins: number, draws: number): IPairClusterStats {
    const games = candidateWins + opponentWins + draws;
    const decisiveGames = candidateWins + opponentWins;
    const candidateWinRate = decisiveGames ? candidateWins / decisiveGames : 0.5;
    return {
        method: "paired-side-swap cluster sandwich",
        confidenceLevel: 0.95,
        games,
        pairClusters: games / 2,
        decisiveGames,
        candidateWins,
        opponentWins,
        draws,
        candidateWinRate,
        deltaFromParityPp: (candidateWinRate - 0.5) * 100,
        standardErrorPp: 1,
        confidence95: { low: Math.max(0, candidateWinRate - 0.05), high: Math.min(1, candidateWinRate + 0.05) },
        moments: {
            clusters: games / 2,
            sumWinSquared: candidateWins,
            sumWinDecisive: candidateWins,
            sumDecisiveSquared: decisiveGames,
        },
    };
}

function integrity(
    games: number,
    draws: number,
    candidateRejections = 0,
    missingRejectionCounts = 0,
    armageddonDecided = 0,
): IIntegrityStats {
    const drawOrArmageddon = draws + armageddonDecided;
    return {
        games,
        draws,
        armageddonDecided,
        drawOrArmageddon,
        drawOrArmageddonRate: drawOrArmageddon / games,
        candidateRejections,
        opponentRejections: 0,
        recordsMissingRejectionCounts: missingRejectionCounts,
        candidateGamesAsGreen: games / 2,
        candidateGamesAsRed: games / 2,
        candidateWinsAsGreen: 0,
        candidateWinsAsRed: 0,
        endReasons: { elimination: games - draws, turn_cap: draws },
    };
}

function cell(
    spec: IV07ArchetypeCellSpec,
    result: [candidateWins: number, opponentWins: number, draws: number],
    candidateRejections = 0,
    missingRejectionCounts = 0,
    armageddonDecided = 0,
): IV07ArchetypeCellReport {
    const outcome = outcomes(...result);
    return {
        spec,
        outcomes: outcome,
        integrity: integrity(
            outcome.games,
            outcome.draws,
            candidateRejections,
            missingRejectionCounts,
            armageddonDecided,
        ),
        telemetry: { candidate: telemetry(), opponent: telemetry() },
    };
}

afterEach(() => {
    delete process.env.SEARCH_GATE;
    delete process.env.SEARCH_VERSIONS;
    delete process.env.V07_SEARCH;
});

describe("v0.7 search trial CLI and seeds", () => {
    it("parses run/panel ids, supports legacy base seeds, and derives order-independent template seeds", () => {
        const cwd = "/tmp/hoc-v07-trial";
        const parsed = parseV07SearchTrialArgs(
            [
                "--run-id=away-96h",
                "--panel-id=train-003",
                "--templates=mage_frontline,ranged_control",
                "--games=20",
                "--concurrency=7",
                "--output=report.json",
                "--audit=audit.jsonl",
            ],
            cwd,
        );
        expect(parsed.runId).toBe("away-96h");
        expect(parsed.panelId).toBe("train-003");
        expect(parsed.baseSeed).toBeNull();
        expect(parsed.templates).toEqual(["mage_frontline", "ranged_control"]);
        expect(parsed.outputPath).toBe(resolve(cwd, "report.json"));
        expect(parsed.auditPath).toBe(resolve(cwd, "audit.jsonl"));
        expect(parsed.auditTurns).toBe(false);
        expect(parsed.checkpointDir).toBeNull();
        expect(parsed.checkpointGames).toBe(200);
        expect(buildV07SearchTrialCellSpecs(parsed).map((spec) => spec.baseSeed)).toEqual([
            deriveV0796hSeed("away-96h", "train-003", "mage_frontline"),
            deriveV0796hSeed("away-96h", "train-003", "ranged_control"),
        ]);

        const manifestDriven = parseV07SearchTrialArgs(
            [
                "--run-id=away-96h",
                "--panel-id=train-003",
                "--templates=mage_frontline,ranged_control",
                "--games=20",
                '--seeds-json={"mage_frontline":123,"ranged_control":456}',
            ],
            cwd,
        );
        expect(buildV07SearchTrialCellSpecs(manifestDriven).map((spec) => spec.baseSeed)).toEqual([123, 456]);
        expect(manifestDriven.seeds).toEqual({ mage_frontline: 123, ranged_control: 456 });
        expect(() =>
            parseV07SearchTrialArgs(
                [
                    "--run-id=away-96h",
                    "--panel-id=train-003",
                    "--templates=mage_frontline,ranged_control",
                    "--games=20",
                    '--seeds-json={"mage_frontline":123}',
                ],
                cwd,
            ),
        ).toThrow("exactly every requested template");

        const legacy = parseV07SearchTrialArgs(["--base-seed=42", "--games=4"], cwd);
        expect(legacy.runId).toBe("base-seed:42");
        expect(legacy.panelId).toBe("search-trial");
        expect(legacy.baseSeed).toBe(42);
        expect(buildV07SearchTrialCellSpecs(legacy)[0].baseSeed).toBe(deriveV07SearchTrialSeed(42, "mage_frontline"));
        expect(() => parseV07SearchTrialArgs(["--run-id=incomplete"], cwd)).toThrow("--run-id and --panel-id");
    });

    it("allocates one total worker budget across concurrent template cells", () => {
        expect(v07SearchTrialParallelCells(40, 8)).toBe(4);
        expect(Array.from({ length: 8 }, (_, index) => v07SearchTrialCellConcurrency(40, 8, index))).toEqual(
            new Array(8).fill(10),
        );
        expect(v07SearchTrialParallelCells(12, 8)).toBe(4);
        expect(Array.from({ length: 8 }, (_, index) => v07SearchTrialCellConcurrency(12, 8, index))).toEqual(
            new Array(8).fill(3),
        );
        expect(v07SearchTrialParallelCells(20, 8)).toBe(4);
        expect(Array.from({ length: 8 }, (_, index) => v07SearchTrialCellConcurrency(20, 8, index))).toEqual(
            new Array(8).fill(5),
        );
        expect(v07SearchTrialParallelCells(4, 8)).toBe(2);
        expect(Array.from({ length: 8 }, (_, index) => v07SearchTrialCellConcurrency(4, 8, index))).toEqual(
            new Array(8).fill(2),
        );
        expect(v07SearchTrialParallelCells(5, 8)).toBe(2);
        expect(2 * v07SearchTrialCellConcurrency(5, 8, 0)).toBeLessThanOrEqual(5);
        expect(v07SearchTrialParallelCells(3, 8)).toBe(1);
        expect(Array.from({ length: 8 }, (_, index) => v07SearchTrialCellConcurrency(3, 8, index))).toEqual(
            new Array(8).fill(3),
        );
    });
});

describe("v0.7 search trial report", () => {
    it("runs through the injected evaluator and resumes revision-bound template checkpoints", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-trial-checkpoint-"));
        const trial = {
            ...options(),
            checkpointDir: join(directory, "cells"),
            outputPath: join(directory, "report.json"),
        };
        let calls = 0;
        const dependencies = {
            now: () => new Date("2026-07-11T00:00:00Z"),
            revision: () => revision,
            runCell: async (spec: IV07ArchetypeCellSpec) => {
                calls += 1;
                return cell(spec, [2, 2, 0]);
            },
            command: () => ["bun", "trial"],
            cwd: () => "/tmp/common",
        };
        try {
            const first = await runV07SearchTrial(trial, dependencies);
            expect(first.cells).toHaveLength(8);
            expect(calls).toBe(8);
            const resumed = await runV07SearchTrial(trial, {
                ...dependencies,
                runCell: async () => {
                    throw new Error("checkpoint was not resumed");
                },
            });
            expect(resumed.cells).toEqual(first.cells);
            expect(calls).toBe(8);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("resumes paired subshards and reconstructs or repairs their aggregate audit", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-trial-shards-"));
        const checkpointDir = join(directory, "cells");
        const auditPath = join(directory, "audit.jsonl");
        const trial = {
            ...options(["mage_frontline"]),
            gamesPerTemplate: 8,
            concurrency: 4,
            outputPath: join(directory, "report.json"),
            auditPath,
            checkpointDir,
            checkpointGames: 4,
        };
        const parentSpec = buildV07SearchTrialCellSpecs(trial)[0];
        const shards = buildV07SearchTrialCellShards(trial, parentSpec);
        const calls: IV07ArchetypeCellSpec[] = [];
        process.env.V07_SEARCH = "1";
        process.env.SEARCH_VERSIONS = "v0.7";
        const dependencies = {
            now: () => new Date("2026-07-11T00:00:00Z"),
            revision: () => revision,
            runCell: async (spec: IV07ArchetypeCellSpec) => {
                calls.push(spec);
                const rows = Array.from({ length: spec.games }, (_, game) => {
                    const seed = (spec.baseSeed + Math.floor(game / 2) * 0x9e3779b1) >>> 0;
                    const candidateIsGreen = game % 2 === 0;
                    return JSON.stringify({
                        t: "game",
                        mode: "search",
                        seed,
                        green: candidateIsGreen ? spec.candidate : spec.opponent,
                        red: candidateIsGreen ? spec.opponent : spec.candidate,
                        msTotal: 10 + game,
                        searched: 2,
                        overrides: 1,
                        overridesToKind: { wait: 1 },
                    });
                });
                appendFileSync(process.env.SEARCH_AUDIT!, `${rows.join("\n")}\n`);
                return cell(spec, [2, 2, 0]);
            },
            command: () => ["bun", "trial"],
            cwd: () => "/tmp/common",
        };
        try {
            const first = await runV07SearchTrial(trial, dependencies);
            expect(shards).toHaveLength(2);
            expect(calls.map(({ games }) => games)).toEqual([4, 4]);
            expect(calls.map(({ baseSeed }) => baseSeed)).toEqual(shards.map(({ spec }) => spec.baseSeed));
            expect(shards[1].spec.baseSeed).toBe((parentSpec.baseSeed + Math.imul(2, 0x9e3779b1)) >>> 0);
            expect(first.cells[0].spec).toEqual(parentSpec);
            expect(first.cells[0].outcomes.games).toBe(8);
            expect(first.searchAudit.auditGames).toBe(8);

            writeFileSync(auditPath, "truncated aggregate\n");
            const rebuilt = await runV07SearchTrial(trial, dependencies);
            expect(calls).toHaveLength(2);
            expect(rebuilt.searchAudit).toMatchObject({ auditGames: 8, invalidJsonLines: 0 });

            const firstFragment = join(checkpointDir, "mage_frontline", "games-000000-000004.audit.jsonl");
            writeFileSync(firstFragment, "corrupt fragment\n");
            const repaired = await runV07SearchTrial(trial, dependencies);
            expect(calls).toHaveLength(3);
            expect(calls[2]).toEqual(shards[0].spec);
            expect(repaired.searchAudit).toMatchObject({ auditGames: 8, invalidJsonLines: 0 });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("aggregates paired outcomes, integrity, all four archetypes, and core-compatible template metrics", () => {
        const trial = options();
        const specs = buildV07SearchTrialCellSpecs(trial);
        const cells = specs.map((spec, index) =>
            index === specs.length - 1
                ? cell(spec, [1, 2, 1])
                : cell(spec, [2, 1, 1], index === 0 ? 2 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0),
        );
        const searchAudit = summarizeV07SearchAuditRows([], null);
        const report = buildV07SearchTrialReport(trial, cells, {
            generatedAt: new Date("2026-07-11T00:00:00Z"),
            completedAt: new Date("2026-07-11T00:01:00Z"),
            behaviorEnvironment: { SEARCH_GATE: "0.01", V07_SEARCH: "1" },
            command: ["bun", "trial"],
            cwd: "/tmp/common",
            revision,
            revisionAtCompletion: revision,
            searchAudit,
        });
        expect(report.status).toBe("research_only");
        expect(report.completeEightTemplatePanel).toBe(true);
        expect(report.templates).toHaveLength(8);
        expect(report.archetypes.map(({ archetype }) => archetype)).toEqual(["mage", "meleeMage", "aura", "ranged"]);
        expect(report.allTemplates.games).toBe(32);
        expect(report.allTemplates.candidateWins).toBe(15);
        expect(report.allTemplates.opponentWins).toBe(9);
        expect(report.allTemplates.draws).toBe(8);
        expect(report.allTemplates.decisiveWinRate).toBeCloseTo(15 / 24);
        expect(report.allTemplates.winPlusHalfDrawScore).toBeCloseTo(19 / 32);
        expect(report.allTemplates.candidateRejections).toBe(2);
        expect(report.allTemplates.recordsMissingRejectionCounts).toBe(1);
        expect(report.allTemplates.drawOrArmageddon).toBe(9);
        expect(report.limitingTemplate).toEqual({ template: "ranged_control", decisiveWinRate: 1 / 3 });
        expect(report.limitingArchetype.archetype).toBe("ranged");
        expect(report.targetDiagnostics.observed90AllArchetypes).toBe(false);
        expect(report.targetDiagnostics.strict90AllTemplates).toBe(false);
        expect(report.templateMetrics).toHaveLength(8);
        expect(report.templateMetrics[0]).toMatchObject({
            template: "mage_frontline",
            archetype: "mage",
            games: 4,
            decisiveWinRate: 2 / 3,
            scoreRate: 0.625,
            candidateRejections: 2,
            missingRejectionCounts: 0,
        });

        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-trial-report-"));
        try {
            const output = join(directory, "nested", "report.json");
            writeV07SearchTrialReportAtomic(report, output);
            expect(JSON.parse(readFileSync(output, "utf8")).status).toBe("research_only");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("keeps the declared equal-template cohort estimand when draw rates differ", () => {
        const trial = options(["mage_frontline", "mage_fireline"]);
        const specs = buildV07SearchTrialCellSpecs(trial);
        const variable = cell(specs[0], [2, 2, 0]);
        variable.outcomes.moments = {
            clusters: 2,
            sumWinSquared: 4,
            sumWinDecisive: 4,
            sumDecisiveSquared: 8,
        };
        const report = buildV07SearchTrialReport(trial, [variable, cell(specs[1], [2, 0, 2])], {
            generatedAt: new Date("2026-07-11T00:00:00Z"),
            completedAt: new Date("2026-07-11T00:01:00Z"),
            behaviorEnvironment: {},
            command: ["bun", "trial"],
            cwd: "/tmp/common",
            revision,
            revisionAtCompletion: revision,
            searchAudit: summarizeV07SearchAuditRows([], null),
        });
        const mage = report.archetypes.find(({ archetype }) => archetype === "mage")!;
        const expectedSe =
            Math.sqrt(
                report.templates.reduce((sum, template) => sum + (template.metrics.standardErrorPp ?? 0) ** 2, 0),
            ) / 2;
        expect(mage.metrics?.decisiveWinRate).toBeCloseTo(2 / 3);
        expect(mage.equalTemplate?.decisiveWinRate).toBe(0.75);
        expect(expectedSe).toBeGreaterThan(0);
        expect(mage.equalTemplate?.standardErrorPp).toBeCloseTo(expectedSe);
        expect(report.limitingArchetype).toEqual({ archetype: "mage", decisiveWinRate: 0.75 });
        expect(report.targetDiagnostics).toMatchObject({
            observed90AllArchetypes: false,
            certified90AllArchetypes: false,
            strict90AllTemplates: false,
        });
    });

    it("summarizes searched-turn and match latency plus override quantiles", () => {
        const summary = summarizeV07SearchAuditRows(
            [
                ...[1, 2, 3, 4, 100].map((ms) => ({ t: "turn", ms })),
                { t: "game", mode: "search", msTotal: 20, searched: 10, overrides: 0, overridesToKind: {} },
                { t: "game", mode: "search", msTotal: 30, searched: 10, overrides: 1, overridesToKind: { wait: 1 } },
                { t: "game", mode: "search", msTotal: 40, searched: 10, overrides: 3, overridesToKind: { melee: 3 } },
                {
                    t: "game",
                    mode: "search",
                    msTotal: 200,
                    searched: 10,
                    overrides: 10,
                    overridesToKind: { wait: 4, defend: 6 },
                },
            ],
            "/tmp/audit.jsonl",
            2,
        );
        expect(summary.searchedTurnLatencyMs).toEqual({ count: 5, p50: 3, p95: 100, p99: 100, max: 100 });
        expect(summary.matchSearchLatencyMs).toEqual({ count: 4, p50: 30, p95: 200, p99: 200, max: 200 });
        expect(summary.overridesPerGame).toEqual({ count: 4, p50: 1, p95: 10, p99: 10, max: 10 });
        expect(summary.overridesTotal).toBe(14);
        expect(summary.overridesPerSearchedTurn).toBe(0.35);
        expect(summary.overridesToKind).toEqual({ wait: 5, melee: 3, defend: 6 });
        expect(summary.invalidJsonLines).toBe(2);
    });

    it("captures only behavior-changing environment variables", () => {
        process.env.V07_SEARCH = "1";
        process.env.SEARCH_GATE = "0.01";
        const snapshot = snapshotV07SearchBehaviorEnvironment({
            HOME: "/secret",
            V07_SEARCH: "1",
            SEARCH_GATE: "0.01",
            LIVETWIN: "1",
        });
        expect(snapshot).toEqual({ LIVETWIN: "1", SEARCH_GATE: "0.01", V07_SEARCH: "1" });
    });
});
