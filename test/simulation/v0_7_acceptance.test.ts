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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    aggregateAcceptanceCells,
    assessV07Acceptance,
    loadAcceptanceCheckpoint,
    parseV07AcceptanceArgs,
    runV07Acceptance,
    saveAcceptanceCheckpoint,
    summarizeAcceptanceCell,
    validateV07AcceptanceOptions,
    type IAcceptanceAggregate,
    type IAcceptanceCellSpec,
    type IRevisionProvenance,
    type IV07AcceptanceOptions,
} from "../../src/simulation/v0_7_acceptance";
import type { IGameRecord, ITournamentOptions, ITournamentSummary } from "../../src/simulation/tournament";

const BEHAVIOR_KEYS = [
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "AUGCA_NOVISION",
    "FORCE_CREATURES",
    "SIM_NO_ACTIONS",
    "V07_SEARCH",
    "V07_WAIT_SCORER",
    "V07_WAIT_WEIGHTS",
    "V07_WAIT_VERSIONS",
    "V07_WAIT_WEIGHTS_B",
    "V07_WAIT_VERSIONS_B",
] as const;
const originalEnvironment = new Map(BEHAVIOR_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const cleanRevision: IRevisionProvenance = {
    commit: "1234567890abcdef",
    commitDate: "2026-07-10T12:00:00Z",
    branch: "main",
    remote: "git@example.invalid:common.git",
    trackedClean: true,
    trackedDiffSha256: null,
};

function resultRecord(
    options: { candidate: string; opponent: string; games: number },
    game: number,
    winner: "candidate" | "opponent" | "draw",
    candidateRejections = 0,
    opponentRejections = 0,
    armageddon = false,
): IGameRecord {
    const candidateGreen = game % 2 === 0;
    const resultWinner =
        winner === "draw"
            ? "draw"
            : winner === "candidate"
              ? candidateGreen
                  ? "green"
                  : "red"
              : candidateGreen
                ? "red"
                : "green";
    return {
        game,
        greenEntrant: candidateGreen ? "a" : "b",
        greenVersion: candidateGreen ? options.candidate : options.opponent,
        redVersion: candidateGreen ? options.opponent : options.candidate,
        winnerVersion: winner === "draw" ? "draw" : winner === "candidate" ? options.candidate : options.opponent,
        result: {
            winner: resultWinner,
            endReason: winner === "draw" ? "turn_cap" : "elimination",
            attrition: { decidedByArmageddon: armageddon },
            rejectedGreen: candidateGreen ? candidateRejections : opponentRejections,
            rejectedRed: candidateGreen ? opponentRejections : candidateRejections,
        },
    } as IGameRecord;
}

function tournamentSummary(
    candidate: string,
    opponent: string,
    baseSeed: number,
    records: readonly IGameRecord[],
): ITournamentSummary {
    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    let armageddon = 0;
    for (const record of records) {
        if (record.winnerVersion === candidate) candidateWins += 1;
        else if (record.winnerVersion === opponent) opponentWins += 1;
        else draws += 1;
        if (record.result.attrition.decidedByArmageddon) armageddon += 1;
    }
    return {
        versionA: candidate,
        versionB: opponent,
        games: records.length,
        baseSeed,
        a: { version: candidate, wins: candidateWins, winsAsGreen: 0, winsAsRed: 0 },
        b: { version: opponent, wins: opponentWins, winsAsGreen: 0, winsAsRed: 0 },
        draws,
        winRateA: candidateWins + opponentWins > 0 ? candidateWins / (candidateWins + opponentWins) : 0.5,
        avgLaps: 4,
        endReasons: {},
        better: candidateWins === opponentWins ? "tie" : candidateWins > opponentWins ? candidate : opponent,
        armageddonDecided: armageddon,
        cleanWinRate: 1 - armageddon / records.length,
    };
}

function smallOptions(): IV07AcceptanceOptions {
    return {
        candidate: "v0.5",
        opponents: ["v0.6", "v0.4"],
        headlineSeeds: [101],
        gamesPerHeadlineSeed: 2,
        cohortSeeds: { melee: [201], mixed: [301], random: [401] },
        gamesPerCohortSeed: 2,
        concurrency: 4,
        seedsDeclaredFresh: false,
        seedManifest: null,
    };
}

function aggregate(winRate: number, drawOrArmageddonRate = 0): IAcceptanceAggregate {
    return {
        cells: 1,
        outcomes: { candidateWinRate: winRate } as IAcceptanceAggregate["outcomes"],
        integrity: {
            drawOrArmageddonRate,
            candidateRejections: 0,
            recordsMissingRejectionCounts: 0,
        } as IAcceptanceAggregate["integrity"],
    };
}

describe("v0.7 acceptance evidence harness", () => {
    it("computes uncertainty from paired clusters and attributes rejections after side swaps", () => {
        const spec: IAcceptanceCellSpec = {
            kind: "headline",
            cohort: "melee",
            candidate: "v0.5",
            opponent: "v0.4",
            baseSeed: 17,
            games: 4,
        };
        const records = [
            resultRecord(spec, 0, "candidate", 2, 7),
            resultRecord(spec, 1, "candidate", 3, 11),
            resultRecord(spec, 2, "opponent"),
            resultRecord(spec, 3, "opponent"),
        ];
        const cell = summarizeAcceptanceCell(
            spec,
            records,
            tournamentSummary(spec.candidate, spec.opponent, spec.baseSeed, records),
        );

        expect(cell.outcomes.candidateWinRate).toBe(0.5);
        expect(cell.outcomes.pairClusters).toBe(2);
        expect(cell.outcomes.standardErrorPp).toBeCloseTo(50);
        expect(cell.outcomes.confidence95).toEqual({ low: 0, high: 1 });
        expect(cell.integrity.candidateGamesAsGreen).toBe(2);
        expect(cell.integrity.candidateGamesAsRed).toBe(2);
        expect(cell.integrity.candidateRejections).toBe(5);
        expect(cell.integrity.opponentRejections).toBe(18);

        const doubled = aggregateAcceptanceCells([cell, cell]);
        expect(doubled.outcomes.games).toBe(8);
        expect(doubled.outcomes.pairClusters).toBe(4);
        expect(doubled.outcomes.standardErrorPp).toBeCloseTo(28.8675, 3);
    });

    it("runs headline and separate melee/mixed/random cells under sanitized LiveTwin settings", async () => {
        const calls: Array<{
            options: ITournamentOptions;
            concurrency: number;
            env: Record<string, string | undefined>;
        }> = [];
        let clock = 0;
        const report = await runV07Acceptance(smallOptions(), {
            now: () => new Date(clock++ === 0 ? "2026-07-10T12:00:00Z" : "2026-07-10T12:00:08Z"),
            revision: () => cleanRevision,
            command: () => ["bun", "v0_7_acceptance.ts", "v0.5"],
            cwd: () => "/repo",
            runTournament: (options, concurrency, onGame) => {
                calls.push({
                    options,
                    concurrency,
                    env: Object.fromEntries(BEHAVIOR_KEYS.map((key) => [key, process.env[key]])),
                });
                const records = Array.from({ length: options.games }, (_, game) =>
                    resultRecord(
                        { candidate: options.versionA, opponent: options.versionB, games: options.games },
                        game,
                        "candidate",
                    ),
                );
                records.forEach(onGame);
                return tournamentSummary(options.versionA, options.versionB, options.baseSeed, records);
            },
        });

        expect(calls).toHaveLength(8);
        expect(calls.map((call) => call.env.FIGHT_MELEE_ROSTERS)).toEqual(["1", "1", "0.5", "0", "1", "1", "0.5", "0"]);
        for (const call of calls) {
            expect(call.options.amountMode).toBe("expBudget");
            expect(call.options.randomizePicks).toBe(true);
            expect(call.options.lightweight).toBe(true);
            expect(call.concurrency).toBe(2);
            expect(call.env.LIVETWIN).toBe("1");
            expect(call.env.AUGCA_NOVISION).toBe("1");
            expect(call.env.SIM_NO_ACTIONS).toBe("1");
            expect(call.env.FORCE_CREATURES).toBeUndefined();
        }
        expect(process.env.LIVETWIN).toBe(originalEnvironment.get("LIVETWIN"));
        expect(report.elapsedSeconds).toBe(8);
        expect(report.headline.cells).toHaveLength(2);
        expect(report.cohortNonRegression.cells).toHaveLength(6);
        expect(report.effectiveConfig.cohorts.mixed.meleeDraftFraction).toBe(0.5);
        expect(report.assessment.evidenceVerdict).toBe("INCONCLUSIVE");
        expect(report.assessment.protocolCompletenessReasons).toContain(
            "headline seed count is 1; protocol requires 9",
        );
        expect(report.assessment.bakeDecision).toBe("NOT_EVALUATED");
        expect(report.assessment.ownerSignOff).toBe("NOT_EVALUATED");
        expect(report.assessment.journalReplayDecisionDivergence).toBe("NOT_EVALUATED");
        expect(report.assessment.releaseInstruction).toBe("NO_BAKE_FROM_THIS_REPORT");
    });

    it("only returns a statistical PASS for the complete powered shape and keeps bake external", () => {
        const options: IV07AcceptanceOptions = {
            candidate: "v0.5",
            opponents: ["v0.6", "v0.4"],
            headlineSeeds: [11, 22, 33, 44, 55, 66, 77, 88, 99],
            gamesPerHeadlineSeed: 3000,
            cohortSeeds: { melee: [1001], mixed: [2001], random: [3001] },
            gamesPerCohortSeed: 3000,
            concurrency: 12,
            seedsDeclaredFresh: true,
            seedManifest: {
                manifestId: "powered-panel",
                createdAt: "2026-07-10T12:00:00Z",
                sourcePath: "/tmp/powered-panel.json",
                sha256: "abc",
                declaration: "Preregistered and not previously evaluated.",
            },
        };
        const cohorts = {
            "v0.6": { melee: aggregate(0.51), mixed: aggregate(0.5), random: aggregate(0.52) },
            "v0.4": { melee: aggregate(0.7), mixed: aggregate(0.6), random: aggregate(0.55) },
        };
        const pass = assessV07Acceptance(
            options,
            cleanRevision,
            { "v0.6": aggregate(0.541, 0.009), "v0.4": aggregate(0.72, 0.001) },
            cohorts,
        );
        expect(pass.protocolPowered).toBe(true);
        expect(pass.evidenceVerdict).toBe("PASS");
        expect(pass.bakeDecision).toBe("NOT_EVALUATED");

        const regression = assessV07Acceptance(
            options,
            cleanRevision,
            { "v0.6": aggregate(0.541), "v0.4": aggregate(0.72) },
            { ...cohorts, "v0.6": { ...cohorts["v0.6"], random: aggregate(0.499) } },
        );
        expect(regression.protocolPowered).toBe(true);
        expect(regression.evidenceVerdict).toBe("FAIL");
        expect(regression.gates.find((gate) => gate.name === "non-regression-random-vs-v0.6")?.passed).toBe(false);

        const dirty = assessV07Acceptance(options, { ...cleanRevision, trackedClean: false }, {}, {});
        expect(dirty.protocolPowered).toBe(false);
        expect(dirty.evidenceVerdict).toBe("INCONCLUSIVE");
        expect(dirty.protocolCompletenessReasons).toContain("tracked working tree was dirty at evaluation time");
    });

    it("rejects overlapping derived seed streams and behavior-changing ambient flags", async () => {
        const overlapping = smallOptions();
        overlapping.gamesPerHeadlineSeed = 4;
        overlapping.cohortSeeds = { ...overlapping.cohortSeeds, melee: [(101 + 0x9e3779b1) >>> 0] };
        expect(() => validateV07AcceptanceOptions(overlapping)).toThrow("Seed streams overlap");

        process.env.V07_SEARCH = "1";
        await expect(
            runV07Acceptance(smallOptions(), {
                revision: () => cleanRevision,
                runTournament: () => {
                    throw new Error("must not run");
                },
            }),
        ).rejects.toThrow("Refusing acceptance under behavior-changing environment: V07_SEARCH");

        delete process.env.V07_SEARCH;
        for (const key of [
            "V07_WAIT_SCORER",
            "V07_WAIT_WEIGHTS",
            "V07_WAIT_VERSIONS",
            "V07_WAIT_WEIGHTS_B",
            "V07_WAIT_VERSIONS_B",
        ] as const) {
            process.env[key] = "synthetic-contamination";
            await expect(
                runV07Acceptance(smallOptions(), {
                    revision: () => cleanRevision,
                    runTournament: () => {
                        throw new Error("must not run");
                    },
                }),
            ).rejects.toThrow(key);
            delete process.env[key];
        }
    });

    it("resumes completed cells only when the revision-bound run fingerprint matches", async () => {
        const checkpointDir = mkdtempSync(join(tmpdir(), "hoc-v07-acceptance-"));
        try {
            let tournamentCalls = 0;
            const dependencies = {
                now: () => new Date("2026-07-10T12:00:00Z"),
                revision: () => cleanRevision,
                loadCheckpoint: (spec: IAcceptanceCellSpec, fingerprint: string) =>
                    loadAcceptanceCheckpoint(checkpointDir, spec, fingerprint),
                saveCheckpoint: (cell: ReturnType<typeof summarizeAcceptanceCell>, fingerprint: string) =>
                    saveAcceptanceCheckpoint(checkpointDir, cell, fingerprint),
                runTournament: (
                    options: ITournamentOptions,
                    _concurrency: number,
                    onGame: (record: IGameRecord) => void,
                ) => {
                    tournamentCalls += 1;
                    const records = Array.from({ length: options.games }, (_, game) =>
                        resultRecord(
                            { candidate: options.versionA, opponent: options.versionB, games: options.games },
                            game,
                            "candidate",
                        ),
                    );
                    records.forEach(onGame);
                    return tournamentSummary(options.versionA, options.versionB, options.baseSeed, records);
                },
            };
            const first = await runV07Acceptance(smallOptions(), dependencies);
            expect(tournamentCalls).toBe(8);
            expect(first.provenance.resumedCells).toBe(0);

            tournamentCalls = 0;
            const resumed = await runV07Acceptance(smallOptions(), dependencies);
            expect(tournamentCalls).toBe(0);
            expect(resumed.provenance.resumedCells).toBe(8);

            const changedRevision = { ...cleanRevision, commit: "different" };
            await runV07Acceptance(smallOptions(), { ...dependencies, revision: () => changedRevision });
            expect(tournamentCalls).toBe(8);
        } finally {
            rmSync(checkpointDir, { recursive: true, force: true });
        }
    });

    it("parses explicit seed provenance and remains reusable for reduced smoke batteries", () => {
        const parsed = parseV07AcceptanceArgs(
            [
                "v0.5",
                "--headline-seeds=1,2",
                "--melee-seeds=101",
                "--mixed-seeds=201",
                "--random-seeds=301",
                "--games=2",
                "--cohort-games=4",
                "--concurrency=3",
                "--fresh-seeds-confirmed",
                "--output=acceptance.json",
            ],
            "/tmp",
        );
        expect(parsed).toEqual({
            candidate: "v0.5",
            opponents: ["v0.6", "v0.4"],
            headlineSeeds: [1, 2],
            gamesPerHeadlineSeed: 2,
            cohortSeeds: { melee: [101], mixed: [201], random: [301] },
            gamesPerCohortSeed: 4,
            concurrency: 3,
            seedsDeclaredFresh: true,
            seedManifest: null,
            outputPath: "/tmp/acceptance.json",
            checkpointDir: "/tmp/acceptance.json.cells",
        });
        expect(() => parseV07AcceptanceArgs(["v0.7", "--headline-seeds=1"])).toThrow("--melee-seeds");
        expect(() =>
            parseV07AcceptanceArgs([
                "v9.9",
                "--headline-seeds=1",
                "--melee-seeds=2",
                "--mixed-seeds=3",
                "--random-seeds=4",
                "--games=2",
                "--cohort-games=2",
            ]),
        ).toThrow("Register it first");
    });

    it("loads an immutable seed manifest and records its digest", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-manifest-"));
        try {
            const manifestPath = join(directory, "panel.json");
            writeFileSync(
                manifestPath,
                JSON.stringify({
                    schemaVersion: 1,
                    manifestId: "v07-smoke-panel",
                    createdAt: "2026-07-10T12:00:00Z",
                    candidate: "v0.5",
                    opponents: ["v0.6", "v0.4"],
                    headline: { seeds: [1], gamesPerSeed: 2 },
                    cohorts: {
                        gamesPerSeed: 2,
                        seeds: { melee: [101], mixed: [201], random: [301] },
                    },
                    freshSeedsDeclared: true,
                    declaration: "Preregistered before outcomes were observed.",
                }),
            );
            const parsed = parseV07AcceptanceArgs(
                ["v0.5", `--manifest=${manifestPath}`, "--output=result.json"],
                directory,
            );
            expect(parsed.headlineSeeds).toEqual([1]);
            expect(parsed.seedManifest?.manifestId).toBe("v07-smoke-panel");
            expect(parsed.seedManifest?.sha256).toHaveLength(64);
            expect(parsed.seedManifest?.sourcePath).toBe(manifestPath);
            expect(parsed.seedsDeclaredFresh).toBe(true);
            expect(() =>
                parseV07AcceptanceArgs(["v0.5", `--manifest=${manifestPath}`, "--games=4"], directory),
            ).toThrow("cannot override the preregistered --manifest");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
