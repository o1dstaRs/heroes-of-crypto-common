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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    analyzeExternalWaitV2Run,
    externalDraftObservation,
    externalMirrorObservation,
    type IAnalyzeExternalWaitV2Options,
} from "../../src/simulation/analyze_v0_7_wait_v2_external";
import {
    WAIT_V2_WEIGHT_JSON,
    readWaitV2ProtocolManifest,
    type IWaitV2Cell,
    type IWaitV2Observation,
} from "../../src/simulation/v0_7_wait_v2_powered";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function write(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
}

function writeJson(path: string, value: unknown): void {
    write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(repo: string, args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function createExecutionRepo(root: string): { repo: string; commit: string } {
    const repo = join(root, "execution");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    write(join(repo, "frozen.txt"), "frozen external simulator\n");
    git(repo, ["add", "frozen.txt"]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
    return { repo, commit: git(repo, ["rev-parse", "HEAD"]) };
}

function gameSeed(cell: IWaitV2Cell, game: number): number {
    return (cell.baseSeed + Math.floor(game / 2) * 0x9e3779b1) >>> 0;
}

function armScore(arm: "control" | "v2", game: number): 0 | 1 {
    return arm === "v2" ? 1 : game % 2 === 0 ? 0 : 1;
}

function mirrorRecord(cell: IWaitV2Cell, arm: "control" | "v2", game: number): Record<string, unknown> {
    const candidateGreen = game % 2 === 0;
    const score = armScore(arm, game);
    return {
        game,
        seed: gameSeed(cell, game),
        greenVersion: candidateGreen ? "v0.7" : "v0.6",
        winnerVersion: score === 1 ? "v0.7" : "v0.6",
        laps: 5,
        endReason: "elimination",
        armageddon: false,
        rejectedGreen: 0,
        rejectedRed: 0,
    };
}

function draftRecord(cell: IWaitV2Cell, arm: "control" | "v2", game: number): Record<string, unknown> {
    const candidateGreen = game % 2 === 0;
    const score = armScore(arm, game);
    const candidateWon = score === 1;
    const winner = candidateWon === candidateGreen ? "green" : "red";
    return {
        game,
        greenEntrant: candidateGreen ? "a" : "b",
        greenVersion: candidateGreen ? "v0.7" : "v0.6",
        redVersion: candidateGreen ? "v0.6" : "v0.7",
        winnerVersion: candidateWon ? "v0.7" : "v0.6",
        result: {
            seed: gameSeed(cell, game),
            winner,
            attrition: { decidedByArmageddon: false },
            rejectedGreen: 0,
            rejectedRed: 0,
        },
    };
}

function shuffledGames(games: number): number[] {
    const result = Array.from({ length: games }, (_, game) => game);
    return result
        .filter((game) => game % 2 === 0)
        .reverse()
        .concat(result.filter((game) => game % 2 === 1));
}

function observations(records: readonly Record<string, unknown>[], kind: "mirror" | "draft"): IWaitV2Observation[] {
    return records.map((record) =>
        kind === "mirror" ? externalMirrorObservation(record) : externalDraftObservation(record),
    );
}

function mirrorSummary(cell: IWaitV2Cell, rows: readonly IWaitV2Observation[]): Record<string, unknown> {
    const wins = rows.filter((row) => row.score === 1).length;
    const losses = rows.filter((row) => row.score === 0).length;
    const draws = rows.filter((row) => row.score === 0.5).length;
    return {
        kind: "mirror_cohort_ab",
        cohort: cell.cohort,
        versions: { A: "v0.7", B: "v0.6" },
        games: rows.length,
        baseSeed: cell.baseSeed,
        amountMode: "expBudget",
        livetwin: true,
        zeroScorer: false,
        guard: "default(support)",
        pairedSideSwap: true,
        symmetricRosters: true,
        winsA: wins,
        winsB: losses,
        draws,
        winRateA: wins + losses === 0 ? 0.5 : wins / (wins + losses),
        armageddonDecided: rows.filter((row) => row.armageddon).length,
        rejectedActions: rows.reduce(
            (sum, row) => sum + (row.candidateRejections ?? 0) + (row.opponentRejections ?? 0),
            0,
        ),
    };
}

function draftSummary(cell: IWaitV2Cell, rows: readonly IWaitV2Observation[]): Record<string, unknown> {
    const wins = rows.filter((row) => row.score === 1).length;
    const losses = rows.filter((row) => row.score === 0).length;
    const draws = rows.filter((row) => row.score === 0.5).length;
    return {
        versionA: "v0.7",
        versionB: "v0.6",
        games: rows.length,
        baseSeed: cell.baseSeed,
        a: { version: "v0.7", wins },
        b: { version: "v0.6", wins: losses },
        draws,
        winRateA: wins + losses === 0 ? 0.5 : wins / (wins + losses),
        armageddonDecided: rows.filter((row) => row.armageddon).length,
    };
}

function writeArm(
    runDir: string,
    commit: string,
    cell: IWaitV2Cell,
    arm: "control" | "v2",
    phase: "mirror" | "draft" | "diag",
    games: number,
): void {
    const directory = join(runDir, arm, phase, String(cell.cohort));
    const kind = phase === "draft" ? "draft" : "mirror";
    const records = shuffledGames(games).map((game) =>
        kind === "mirror" ? mirrorRecord(cell, arm, game) : draftRecord(cell, arm, game),
    );
    const rows = observations(records, kind);
    const base = phase === "draft" ? join(directory, "v0.7_vs_v0.6_fixture") : join(directory, "result");
    const jsonl = phase === "draft" ? `${base}.jsonl` : `${base}.records.jsonl`;
    write(jsonl, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    writeJson(`${base}.summary.json`, kind === "mirror" ? mirrorSummary(cell, rows) : draftSummary(cell, rows));
    const fmr = phase === "draft" ? ` fmr=${String(cell.meleeDraftFraction)}` : "";
    write(
        join(directory, "DONE"),
        `schema=1 arm=${arm} phase=${phase} cohort=${String(cell.cohort)} games=${games} seed=${cell.baseSeed}${fmr} commit=${commit}\n`,
    );
}

interface IFixture {
    root: string;
    runDir: string;
    executionRepo: string;
    commit: string;
    runnerHash: string;
    options: IAnalyzeExternalWaitV2Options;
}

function createFixture(): IFixture {
    const root = mkdtempSync(join(tmpdir(), "wait-v2-external-"));
    temporaryRoots.push(root);
    const { repo: executionRepo, commit } = createExecutionRepo(root);
    const runDir = join(root, "run");
    mkdirSync(runDir, { recursive: true });
    const runner = "#!/bin/sh\nexit 0\n";
    const runnerHash = sha256(runner);
    write(join(runDir, "run_powered_v2.sh"), runner);
    write(join(runDir, "runner.sha256"), `${runnerHash}  run_powered_v2.sh\n`);
    const protocol = readWaitV2ProtocolManifest().manifest;
    writeJson(join(runDir, "run.json"), {
        schemaVersion: 1,
        status: "research_only",
        frozenCommit: commit,
        branch: "main",
        gamesPerPrimaryCellPerArm: 4,
        diagGamesPerMirrorCellPerArm: 2,
        concurrency: 1,
        v2WeightsSha256: protocol.v2WeightsSha256,
        pairedSideSwap: true,
        scoreMetric: "W=1,D=0.5,L=0",
        automaticBake: false,
        automaticDeploy: false,
    });
    write(join(runDir, "v2_weights.json"), `${WAIT_V2_WEIGHT_JSON}\n`);
    const completeTime = "2026-07-15T15:35:36Z";
    write(
        join(runDir, "RAW_COMPLETE"),
        `schema=1 status=raw_complete time=${completeTime} epoch=${Math.floor(Date.parse(completeTime) / 1000)} commit=${commit} v2sha=${protocol.v2WeightsSha256}\n`,
    );
    for (const cell of protocol.cells) {
        for (const arm of ["control", "v2"] as const) writeArm(runDir, commit, cell, arm, cell.kind, 4);
    }
    for (const cell of protocol.cells.filter((entry) => entry.kind === "mirror")) {
        for (const arm of ["control", "v2"] as const) writeArm(runDir, commit, cell, arm, "diag", 2);
    }
    return {
        root,
        runDir,
        executionRepo,
        commit,
        runnerHash,
        options: {
            runDir,
            executionRepo,
            outputPath: join(runDir, "analysis.json"),
            allowUnderpowered: true,
            expectedFrozenCommit: commit,
            expectedRunnerSha256: runnerHash,
            expectedDiagnosticGames: 2,
            expectedConcurrency: 1,
        },
    };
}

describe("external wait-V2 record conversion", () => {
    it("maps draw, Armageddon, entrant side, and rejection ownership without trusting summaries", () => {
        expect(
            externalMirrorObservation({
                game: 1,
                seed: 9,
                greenVersion: "v0.6",
                winnerVersion: "draw",
                armageddon: true,
                rejectedGreen: 2,
                rejectedRed: 3,
            }),
        ).toEqual({
            game: 1,
            seed: 9,
            score: 0.5,
            draw: true,
            armageddon: true,
            candidateRejections: 3,
            opponentRejections: 2,
        });

        expect(
            externalDraftObservation({
                game: 1,
                greenEntrant: "b",
                greenVersion: "v0.6",
                redVersion: "v0.7",
                winnerVersion: "v0.7",
                result: {
                    seed: 10,
                    winner: "red",
                    attrition: { decidedByArmageddon: false },
                    rejectedGreen: 4,
                    rejectedRed: 5,
                },
            }),
        ).toMatchObject({ score: 1, candidateRejections: 5, opponentRejections: 4 });

        expect(() =>
            externalDraftObservation({
                game: 0,
                greenEntrant: "a",
                greenVersion: "v0.7",
                redVersion: "v0.6",
                winnerVersion: "v0.7",
                result: {
                    seed: 10,
                    winner: "red",
                    attrition: { decidedByArmageddon: false },
                    rejectedGreen: 0,
                    rejectedRed: 0,
                },
            }),
        ).toThrow("winner version/side mismatch");
    });
});

describe("external wait-V2 run analysis", () => {
    it("sorts worker-completion records, validates all cells and diagnostics, and keeps smoke evidence inconclusive", async () => {
        const fixture = createFixture();
        const report = await analyzeExternalWaitV2Run(fixture.options);
        expect(report.cells.map((cell) => cell.cell.id)).toEqual(
            readWaitV2ProtocolManifest().manifest.cells.map((cell) => cell.id),
        );
        expect(report.cells.every((cell) => cell.matchedScoreDelta.mean === 0.5)).toBe(true);
        expect(report.diagnostics).toHaveLength(4);
        expect(report.artifacts).toHaveLength(73);
        expect(report.revisionStable).toBe(true);
        expect(report.assessment.evidenceVerdict).toBe("INCONCLUSIVE");
        expect(report.assessment.protocolPowered).toBe(false);
        expect(report.assessment.completenessReasons.join(" ")).toContain("gamesPerArm=4");
        expect(report.assessment.gates.filter((gate) => gate.tier === "research").every((gate) => gate.passed)).toBe(
            true,
        );
        const written = JSON.parse(readFileSync(fixture.options.outputPath!, "utf8")) as typeof report;
        expect(written.runnerSha256).toBe(fixture.runnerHash);
        expect(written.executionRevision.commit).toBe(fixture.commit);
    });

    it("fails closed on completion and run-identity mismatches", async () => {
        const badCompletion = createFixture();
        const completePath = join(badCompletion.runDir, "RAW_COMPLETE");
        write(completePath, readFileSync(completePath, "utf8").replace(badCompletion.commit, "0".repeat(40)));
        await expect(analyzeExternalWaitV2Run(badCompletion.options)).rejects.toThrow("RAW_COMPLETE identity");

        const badRun = createFixture();
        const runPath = join(badRun.runDir, "run.json");
        const identity = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
        identity.automaticDeploy = true;
        writeJson(runPath, identity);
        await expect(analyzeExternalWaitV2Run(badRun.options)).rejects.toThrow("behavior/scoring identity");
    });

    it("accepts only the runner's possible one-second completion-marker rollover", async () => {
        const rollover = createFixture();
        const rolloverPath = join(rollover.runDir, "RAW_COMPLETE");
        const rolloverMarker = readFileSync(rolloverPath, "utf8");
        const markerEpoch = Number(rolloverMarker.match(/ epoch=(\d+) /)?.[1]);
        write(rolloverPath, rolloverMarker.replace(` epoch=${markerEpoch} `, ` epoch=${markerEpoch + 1} `));
        await expect(analyzeExternalWaitV2Run(rollover.options)).resolves.toMatchObject({ revisionStable: true });

        for (const offset of [-1, 2]) {
            const invalid = createFixture();
            const invalidPath = join(invalid.runDir, "RAW_COMPLETE");
            const invalidMarker = readFileSync(invalidPath, "utf8");
            const invalidEpoch = Number(invalidMarker.match(/ epoch=(\d+) /)?.[1]);
            write(invalidPath, invalidMarker.replace(` epoch=${invalidEpoch} `, ` epoch=${invalidEpoch + offset} `));
            await expect(analyzeExternalWaitV2Run(invalid.options)).rejects.toThrow(
                "RAW_COMPLETE timestamp/epoch is invalid",
            );
        }
    });

    it("rejects duplicate games, wrong seeds, and missing rejection telemetry", async () => {
        const duplicate = createFixture();
        const duplicatePath = join(duplicate.runDir, "control/mirror/hybrid/result.records.jsonl");
        const duplicateRows = readFileSync(duplicatePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        duplicateRows[0] = { ...duplicateRows[1] };
        write(duplicatePath, `${duplicateRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        await expect(analyzeExternalWaitV2Run(duplicate.options)).rejects.toThrow("game index");

        const wrongSeed = createFixture();
        const seedPath = join(wrongSeed.runDir, "control/mirror/hybrid/result.records.jsonl");
        const seedRows = readFileSync(seedPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        seedRows[0].seed = Number(seedRows[0].seed) + 1;
        write(seedPath, `${seedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        await expect(analyzeExternalWaitV2Run(wrongSeed.options)).rejects.toThrow("seed");

        const missingRejections = createFixture();
        const draftPath = join(missingRejections.runDir, "control/draft/mixed/v0.7_vs_v0.6_fixture.jsonl");
        const draftRows = readFileSync(draftPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { result: Record<string, unknown> });
        delete draftRows[0].result.rejectedGreen;
        write(draftPath, `${draftRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        await expect(analyzeExternalWaitV2Run(missingRejections.options)).rejects.toThrow("rejectedGreen");
    });

    it("rejects a summary disagreement and ambiguous draft artifacts", async () => {
        const badSummary = createFixture();
        const summaryPath = join(badSummary.runDir, "v2/mirror/pure_ranged/result.summary.json");
        const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
        summary.winsA = 0;
        writeJson(summaryPath, summary);
        await expect(analyzeExternalWaitV2Run(badSummary.options)).rejects.toThrow("summary.winsA mismatch");

        const ambiguous = createFixture();
        write(join(ambiguous.runDir, "v2/draft/random/v0.7_vs_v0.6_extra.jsonl"), "{}\n");
        await expect(analyzeExternalWaitV2Run(ambiguous.options)).rejects.toThrow("exactly one JSONL");
    });
});
