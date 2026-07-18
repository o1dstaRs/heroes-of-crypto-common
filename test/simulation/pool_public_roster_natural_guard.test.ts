import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../../src/ai/setup/draft_ship";
import { SETUP_COHORTS, V07_NONFIGHT_SETUP_SPEC } from "../../src/ai/setup/setup_ship";
import {
    publicRosterPlacementBoard,
    publicRosterPlacementDraftEvidence,
    type IPublicRosterPlacementBoard,
    type IPublicRosterPlacementDelta,
    type IPublicRosterPlacementRecord,
} from "../../src/simulation/measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES } from "../../src/simulation/optimizer/v0_7_setup_overnight_core";
import {
    evaluatePublicRosterNaturalGate,
    poolPublicRosterNaturalGuardShards,
    type IPublicRosterNaturalArmSafety,
    type IPublicRosterNaturalGateInput,
    type IPublicRosterNaturalSlice,
} from "../../src/simulation/pool_public_roster_natural_guard";

const BASE_SEED = 367271678;
const SOURCE_COMMIT = "69fc030000000000000000000000000000000000";
const temporaryDirectories: string[] = [];
afterAll(() => temporaryDirectories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const sha256 = (value: unknown): string =>
    createHash("sha256")
        .update(typeof value === "string" ? value : JSON.stringify(value))
        .digest("hex");

function sealReport(report: Record<string, unknown>): Record<string, unknown> {
    const withoutHash = { ...report };
    delete withoutHash.reportSha256;
    return { ...withoutHash, reportSha256: sha256(withoutHash) };
}

function fixtureRecord(
    arm: "control" | "both",
    board: IPublicRosterPlacementBoard,
    game: 0 | 1 | 2 | 3,
): IPublicRosterPlacementRecord {
    const draft = publicRosterPlacementDraftEvidence(board);
    const pickedLower = game < 2;
    const seat = pickedLower ? draft.lower : draft.upper;
    const opponent = pickedLower ? draft.upper : draft.lower;
    const actionable = arm === "both" && game % 2 === 0;
    const candidateAction = actionable ? (game === 0 ? "flyer-screen" : "corner-shift") : "unchanged";
    const candidateResult = arm === "both" ? (game === 1 ? "draw" : "win") : "loss";
    return {
        arm,
        boardIndex: board.index,
        game,
        pairSeed: board.pairSeed,
        pickSeed: board.pickSeed,
        battleSeed: board.battleSeed,
        gridType: board.gridType,
        pickSeat: pickedLower ? "candidate-lower" : "candidate-upper",
        battleMirror: (game % 2) as 0 | 1,
        candidateSide: game === 0 || game === 3 ? "green" : "red",
        candidateResult,
        candidateCohort: seat.cohort,
        opponentCohort: opponent.cohort,
        incumbentAction: "unchanged",
        candidateAction,
        actionable,
        legitimateRevealCount: 0,
        addedPublicCount: arm === "both" ? 5 : 0,
        candidateRejections: 0,
        baselineRejections: 0,
        laps: arm === "both" ? 8 : 7,
        endReason: arm === "both" && game === 1 ? "turn_cap" : "elimination",
        decidedByArmageddon: arm === "both" && game === 3,
        setupFingerprint: sha256(`setup/${arm}/${board.pairSeed}/${game}`),
        behaviorTraceSha256: sha256(`trace/${arm}/${board.pairSeed}/${game}`),
    };
}

function writeShard(globalStartIndex: number, boards: number): string {
    const directory = mkdtempSync(join(tmpdir(), "public-roster-natural-shard-"));
    temporaryDirectories.push(directory);
    const path = join(directory, `shard-${globalStartIndex}.json`);
    const reportBaseSeed = publicRosterPlacementBoard(BASE_SEED, "guard", globalStartIndex).pairSeed;
    const boardLedger = Array.from({ length: boards }, (_, localIndex) =>
        publicRosterPlacementBoard(reportBaseSeed, "guard", localIndex),
    );
    const cluster = (arm: "control" | "both", board: IPublicRosterPlacementBoard) => ({
        arm,
        board,
        records: ([0, 1, 2, 3] as const).map((game) => fixtureRecord(arm, board, game)),
    });
    const report = sealReport({
        schemaVersion: 1,
        status: "research_only_no_bake",
        setupSpec: V07_NONFIGHT_SETUP_SPEC,
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        arms: ["control", "both"],
        panel: "guard",
        target: "natural",
        baseSeed: reportBaseSeed,
        boards,
        scannedBoards: boards,
        games: boards * 8,
        maxLaps: 60,
        maps: SETUP_LIVE_GRID_TYPES,
        wallSeconds: 1,
        summaries: {},
        comparisons: {},
        boardLedger,
        clusters: boardLedger.flatMap((board) => [cluster("control", board), cluster("both", board)]),
    });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
}

function mutateShard(
    path: string,
    name: string,
    mutate: (report: Record<string, unknown>) => void,
    reseal = true,
): string {
    const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    mutate(report);
    const output = join(path, "..", name);
    writeFileSync(output, `${JSON.stringify(reseal ? sealReport(report) : report, null, 2)}\n`);
    return output;
}

function safety(games: number, overrides: Partial<IPublicRosterNaturalArmSafety> = {}): IPublicRosterNaturalArmSafety {
    return {
        games,
        draws: 0,
        drawRate: 0,
        armageddonDecided: 0,
        armageddonRate: 0,
        drawOrArmageddon: 0,
        drawOrArmageddonRate: 0,
        turnCaps: 0,
        turnCapRate: 0,
        totalLaps: games * 10,
        avgLaps: 10,
        candidateRejections: 0,
        opposingRejections: 0,
        endReasons: { elimination: games, turn_cap: 0, stuck: 0 },
        ...overrides,
    };
}

function delta(games: number, boards: number, gainPp: number, lowGainPp: number): IPublicRosterPlacementDelta {
    return {
        boards,
        games,
        candidateDecisiveWinRate: 0.5 + gainPp / 100,
        controlDecisiveWinRate: 0.5,
        scoreGainPp: gainPp,
        clusteredSePp: 0.1,
        confidence95GainPp: { low: lowGainPp, high: gainPp + 0.2 },
        outcomeChanges: games,
    };
}

function slice(
    games: number,
    boards: number,
    gainPp: number,
    lowGainPp: number,
    excess: Partial<IPublicRosterNaturalSlice["matchedExcess"]> = {},
): IPublicRosterNaturalSlice {
    return {
        matchedControlDelta: delta(games, boards, gainPp, lowGainPp),
        candidate: safety(games),
        control: safety(games),
        matchedExcess: {
            drawPp: 0,
            armageddonPp: 0,
            drawOrArmageddonPp: 0,
            turnCapPp: 0,
            avgLaps: 0,
            candidateRejections: 0,
            opposingRejections: 0,
            ...excess,
        },
    };
}

function passingGateInput(): IPublicRosterNaturalGateInput {
    const natural = slice(20_000, 5_000, 0.5, 0.000_001, { drawPp: 1, armageddonPp: 1, avgLaps: 1 });
    const actionable = slice(5_000, 2_000, 2, 0.000_001);
    const byMap = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [gridType, slice(6_000, 1_500, 0, -0.249_999)]),
    ) as IPublicRosterNaturalGateInput["byMap"];
    return { completeInput: true, totalBoards: 5_000, natural, actionable, byMap };
}

describe("public-roster natural guard shard pooler", () => {
    test("reconstructs one contiguous ordered stream and pools every raw slice without rerunning fights", () => {
        const paths = [writeShard(0, 2), writeShard(2, 2)];
        const first = poolPublicRosterNaturalGuardShards(paths, SOURCE_COMMIT, BASE_SEED, 4);
        const replay = poolPublicRosterNaturalGuardShards(paths, SOURCE_COMMIT, BASE_SEED, 4);

        expect(replay).toEqual(first);
        expect(first.status).toBe("failed");
        expect(first.integrity).toMatchObject({
            completeOrderedLedger: true,
            omittedBoards: 0,
            omittedCandidateGames: 0,
            omittedControlGames: 0,
            shardCount: 2,
        });
        expect(
            first.shards.map(({ globalStartIndex, globalEndIndexExclusive }) => [
                globalStartIndex,
                globalEndIndexExclusive,
            ]),
        ).toEqual([
            [0, 2],
            [2, 4],
        ]);
        expect(first.slices.natural.candidate.games).toBe(16);
        expect(first.slices.natural.control.games).toBe(16);
        expect(first.slices.actionable.candidate.games).toBe(8);
        expect(first.slices.flyerScreen.candidate.games).toBe(4);
        expect(first.slices.cornerShift.candidate.games).toBe(4);
        expect(first.slices.natural.candidate).toMatchObject({ turnCaps: 4, armageddonDecided: 4, avgLaps: 8 });
        expect(
            SETUP_LIVE_GRID_TYPES.reduce((sum, gridType) => sum + first.slices.byMap[gridType].candidate.games, 0),
        ).toBe(16);
        expect(SETUP_COHORTS.reduce((sum, cohort) => sum + first.slices.byCohort[cohort].candidate.games, 0)).toBe(16);
        const { reportSha256, ...withoutHash } = first;
        expect(reportSha256).toBe(sha256(withoutHash));
    });

    test("encodes every strict and inclusive preregistered natural threshold", () => {
        const passing = passingGateInput();
        expect(evaluatePublicRosterNaturalGate(passing).passed).toBe(true);

        const naturalBoundary = structuredClone(passing);
        naturalBoundary.natural.matchedControlDelta.confidence95GainPp!.low = 0;
        expect(evaluatePublicRosterNaturalGate(naturalBoundary).checks.naturalConfidence).toBe(false);

        const mapBoundary = structuredClone(passing);
        mapBoundary.byMap[SETUP_LIVE_GRID_TYPES[0]].matchedControlDelta.confidence95GainPp!.low = -0.25;
        expect(evaluatePublicRosterNaturalGate(mapBoundary).checks.everyMapConfidence).toBe(false);

        const drawFailure = structuredClone(passing);
        drawFailure.natural.matchedExcess.drawPp = 1.000_001;
        expect(evaluatePublicRosterNaturalGate(drawFailure).checks.drawSafety).toBe(false);

        const lapFailure = structuredClone(passing);
        lapFailure.natural.matchedExcess.avgLaps = 1.000_001;
        expect(evaluatePublicRosterNaturalGate(lapFailure).checks.averageLapSafety).toBe(false);

        const incomplete = structuredClone(passing);
        incomplete.completeInput = false;
        expect(evaluatePublicRosterNaturalGate(incomplete).passed).toBe(false);
    });

    test("fails closed on missing, reordered, hash-tampered, metadata-drifted, and incomplete shards", () => {
        const first = writeShard(0, 2);
        const second = writeShard(2, 2);
        expect(() => poolPublicRosterNaturalGuardShards([second, first], SOURCE_COMMIT, BASE_SEED, 4)).toThrow(
            "shard base does not continue",
        );
        expect(() => poolPublicRosterNaturalGuardShards([first], SOURCE_COMMIT, BASE_SEED, 4)).toThrow(
            "2/4 expected natural boards",
        );
        expect(() =>
            poolPublicRosterNaturalGuardShards(
                [
                    mutateShard(
                        first,
                        "hash.json",
                        (report) => {
                            report.wallSeconds = 2;
                        },
                        false,
                    ),
                ],
                SOURCE_COMMIT,
                BASE_SEED,
                2,
            ),
        ).toThrow("self-hash mismatch");
        expect(() =>
            poolPublicRosterNaturalGuardShards(
                [
                    mutateShard(first, "target.json", (report) => {
                        report.target = "ranged";
                    }),
                ],
                SOURCE_COMMIT,
                BASE_SEED,
                2,
            ),
        ).toThrow("not a natural-target report");
        const metadataCases: Array<{
            name: string;
            mutate: (report: Record<string, unknown>) => void;
            message: string;
        }> = [
            { name: "spec", mutate: (report) => void (report.setupSpec = "setup-v0"), message: "uses setup spec" },
            { name: "draft", mutate: (report) => void (report.draftSpec = "off"), message: "uses draft spec" },
            { name: "fight", mutate: (report) => void (report.fightVersion = "v0.6"), message: "not a v0.7" },
            { name: "panel", mutate: (report) => void (report.panel = "selection"), message: "not a guard-panel" },
            { name: "arms", mutate: (report) => void (report.arms = ["both", "control"]), message: "pair exactly" },
            { name: "maps", mutate: (report) => void (report.maps = [SETUP_LIVE_GRID_TYPES[0]]), message: "live-map" },
            { name: "laps", mutate: (report) => void (report.maxLaps = 59), message: "60-lap" },
        ];
        for (const metadata of metadataCases) {
            expect(() =>
                poolPublicRosterNaturalGuardShards(
                    [mutateShard(first, `${metadata.name}.json`, metadata.mutate)],
                    SOURCE_COMMIT,
                    BASE_SEED,
                    2,
                ),
            ).toThrow(metadata.message);
        }
        expect(() =>
            poolPublicRosterNaturalGuardShards(
                [
                    mutateShard(first, "ledger.json", (report) => {
                        const ledger = report.boardLedger as Array<Record<string, number>>;
                        ledger[0].pickSeed += 1;
                    }),
                ],
                SOURCE_COMMIT,
                BASE_SEED,
                2,
            ),
        ).toThrow("breaks the contiguous global seed ledger");
        expect(() =>
            poolPublicRosterNaturalGuardShards(
                [
                    mutateShard(first, "crossover.json", (report) => {
                        const clusters = report.clusters as Array<{
                            arm: string;
                            records: Array<Record<string, unknown>>;
                        }>;
                        clusters.find(({ arm }) => arm === "both")!.records[0].candidateSide = "red";
                    }),
                ],
                SOURCE_COMMIT,
                BASE_SEED,
                2,
            ),
        ).toThrow("invalid pick-seat/battle-side crossover");
        expect(() =>
            poolPublicRosterNaturalGuardShards(
                [
                    mutateShard(first, "game.json", (report) => {
                        const clusters = report.clusters as Array<{ arm: string; records: unknown[] }>;
                        clusters.find(({ arm }) => arm === "both")!.records.pop();
                    }),
                ],
                SOURCE_COMMIT,
                BASE_SEED,
                2,
            ),
        ).toThrow("four crossover games");
        expect(() => poolPublicRosterNaturalGuardShards([first], "bad", BASE_SEED, 2)).toThrow(
            "source commit must be exactly 40 lowercase hexadecimal characters",
        );
    });
});
