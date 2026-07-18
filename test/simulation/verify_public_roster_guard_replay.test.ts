import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../../src/ai/setup/draft_ship";
import {
    V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_SETUP_SPEC,
} from "../../src/ai/setup/setup_ship";
import {
    publicRosterPlacementBoard,
    publicRosterPlacementDraftEvidence,
    PUBLIC_ROSTER_COHORT_SAFE_ARM,
    type IPublicRosterPlacementBoard,
    type IPublicRosterPlacementCluster,
    type IPublicRosterPlacementRecord,
} from "../../src/simulation/measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES } from "../../src/simulation/optimizer/v0_7_setup_overnight_core";
import {
    PUBLIC_ROSTER_GUARD_BASE_SEED,
    PUBLIC_ROSTER_GUARD_REPLAY_BOARDS,
    PUBLIC_ROSTER_GUARD_SOURCE_COMMIT,
    PUBLIC_ROSTER_GUARD_START_BOARD,
    verifyPublicRosterGuardReplay,
} from "../../src/simulation/verify_public_roster_guard_replay";

const FULL_BOARDS = 12;
const CONTROL_ARM = "control" as const;
const CANDIDATE_ARM = PUBLIC_ROSTER_COHORT_SAFE_ARM;
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
    arm: typeof CONTROL_ARM | typeof CANDIDATE_ARM,
    board: IPublicRosterPlacementBoard,
    game: 0 | 1 | 2 | 3,
): IPublicRosterPlacementRecord {
    const draft = publicRosterPlacementDraftEvidence(board);
    const pickedLower = game < 2;
    const seat = pickedLower ? draft.lower : draft.upper;
    const opponent = pickedLower ? draft.upper : draft.lower;
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
        candidateResult: "win",
        candidateCohort: seat.cohort,
        opponentCohort: opponent.cohort,
        incumbentAction: "unchanged",
        candidateAction: "unchanged",
        actionable: false,
        legitimateRevealCount: 0,
        addedPublicCount: 0,
        candidateRejections: 0,
        baselineRejections: 0,
        laps: 7,
        endReason: "elimination",
        decidedByArmageddon: false,
        setupFingerprint: sha256(`setup/${arm}/${board.pairSeed}/${game}`),
        behaviorTraceSha256: sha256(`trace/${board.pairSeed}/${game}`),
    };
}

function fixtureReport(boards: number): Record<string, unknown> {
    const boardLedger = Array.from({ length: boards }, (_, index) =>
        publicRosterPlacementBoard(PUBLIC_ROSTER_GUARD_BASE_SEED, "guard", PUBLIC_ROSTER_GUARD_START_BOARD + index),
    );
    const cluster = (
        arm: typeof CONTROL_ARM | typeof CANDIDATE_ARM,
        board: IPublicRosterPlacementBoard,
    ): IPublicRosterPlacementCluster => ({
        arm,
        board,
        records: ([0, 1, 2, 3] as const).map((game) => fixtureRecord(arm, board, game)) as [
            IPublicRosterPlacementRecord,
            IPublicRosterPlacementRecord,
            IPublicRosterPlacementRecord,
            IPublicRosterPlacementRecord,
        ],
    });
    return sealReport({
        schemaVersion: 1,
        status: "research_only_no_bake",
        question: "public final roster placement vs shipped legitimate pick reveals",
        setupSpec: V07_NONFIGHT_SETUP_SPEC,
        cohortSafeSetupSpec: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
        cohortSafeBehaviorSha256: V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        informationBoundary: "public ranked draft transcript only",
        arms: [CONTROL_ARM, CANDIDATE_ARM],
        panel: "guard",
        target: "natural",
        baseSeed: PUBLIC_ROSTER_GUARD_BASE_SEED,
        startBoard: PUBLIC_ROSTER_GUARD_START_BOARD,
        boards,
        scannedBoards: boards,
        games: boards * 8,
        maxLaps: 60,
        maps: SETUP_LIVE_GRID_TYPES,
        wallSeconds: 1,
        summaries: {},
        comparisons: {},
        boardLedger,
        clusters: boardLedger.flatMap((board) => [cluster(CONTROL_ARM, board), cluster(CANDIDATE_ARM, board)]),
    });
}

function writeReport(directory: string, name: string, report: Record<string, unknown>): string {
    const path = join(directory, name);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
}

function mutateReport(
    directory: string,
    sourcePath: string,
    name: string,
    mutate: (report: Record<string, unknown>) => void,
    reseal = true,
): string {
    const report = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    mutate(report);
    return writeReport(directory, name, reseal ? sealReport(report) : report);
}

function records(report: Record<string, unknown>, clusterIndex: number): Record<string, unknown>[] {
    const clusters = report.clusters as Record<string, unknown>[];
    return clusters[clusterIndex].records as Record<string, unknown>[];
}

function verify(fullPath: string, replayPath: string) {
    return verifyPublicRosterGuardReplay(fullPath, replayPath, {
        sourceCommit: PUBLIC_ROSTER_GUARD_SOURCE_COMMIT,
        expectedFullBoards: FULL_BOARDS,
    });
}

describe("public-roster natural guard replay verifier", () => {
    test("deterministically reproduces all complete fingerprints and behavior traces for the frozen 10-board prefix", () => {
        const directory = mkdtempSync(join(tmpdir(), "public-roster-guard-replay-"));
        temporaryDirectories.push(directory);
        const fullPath = writeReport(directory, "full.json", fixtureReport(FULL_BOARDS));
        const replayPath = writeReport(directory, "replay.json", fixtureReport(PUBLIC_ROSTER_GUARD_REPLAY_BOARDS));

        const first = verify(fullPath, replayPath);
        const second = verify(fullPath, replayPath);

        expect(second).toEqual(first);
        expect(first).toMatchObject({
            status: "verified",
            mode: "fight_free_raw_replay_comparison",
            recordsCompared: PUBLIC_ROSTER_GUARD_REPLAY_BOARDS * 2 * 4,
            sourceBinding: { sourceCommit: PUBLIC_ROSTER_GUARD_SOURCE_COMMIT },
            fullReport: { boards: FULL_BOARDS },
            replayReport: { boards: PUBLIC_ROSTER_GUARD_REPLAY_BOARDS },
        });
        expect(first.records).toHaveLength(80);
        expect(
            first.records.every(
                (record) => record.setupFingerprint.length === 64 && record.behaviorTraceSha256.length === 64,
            ),
        ).toBe(true);
        const { reportSha256, ...withoutHash } = first;
        expect(reportSha256).toBe(sha256(withoutHash));
    });

    test("fails closed on every frozen protocol and sample binding", () => {
        const directory = mkdtempSync(join(tmpdir(), "public-roster-guard-replay-bindings-"));
        temporaryDirectories.push(directory);
        const fullPath = writeReport(directory, "full.json", fixtureReport(FULL_BOARDS));
        const replayPath = writeReport(directory, "replay.json", fixtureReport(PUBLIC_ROSTER_GUARD_REPLAY_BOARDS));
        const cases: Array<[string, (report: Record<string, unknown>) => void, string]> = [
            ["setup-spec", (report) => (report.setupSpec = "wrong"), "uses setup spec"],
            ["artifact-spec", (report) => (report.cohortSafeSetupSpec = "wrong"), "does not bind the frozen"],
            [
                "artifact-hash",
                (report) => (report.cohortSafeBehaviorSha256 = sha256("wrong")),
                "does not bind the frozen",
            ],
            ["arms", (report) => (report.arms = [CANDIDATE_ARM, CONTROL_ARM]), "must pair exactly"],
            ["panel", (report) => (report.panel = "explore"), "not a guard-panel"],
            [
                "base-seed",
                (report) => (report.baseSeed = PUBLIC_ROSTER_GUARD_BASE_SEED + 1),
                "caller-attested original seed",
            ],
            [
                "start-board",
                (report) => (report.startBoard = PUBLIC_ROSTER_GUARD_START_BOARD + 1),
                "start board does not continue",
            ],
            ["max-laps", (report) => (report.maxLaps = 59), "60-lap cap"],
            [
                "board-ledger",
                (report) => (((report.boardLedger as Record<string, unknown>[])[0].pickSeed as number) += 1),
                "breaks the contiguous global seed ledger",
            ],
        ];
        for (const [name, mutate, message] of cases) {
            const path = mutateReport(directory, replayPath, `${name}.json`, mutate);
            expect(() => verify(fullPath, path), name).toThrow(message);
        }

        expect(() =>
            verifyPublicRosterGuardReplay(fullPath, replayPath, {
                sourceCommit: "0000000000000000000000000000000000000000",
                expectedFullBoards: FULL_BOARDS,
            }),
        ).toThrow("source commit must equal frozen");
        const shortReplay = writeReport(directory, "short-replay.json", fixtureReport(9));
        expect(() => verify(fullPath, shortReplay)).toThrow("9/10 expected natural boards");
        const tampered = mutateReport(
            directory,
            replayPath,
            "tampered.json",
            (report) => (report.wallSeconds = 2),
            false,
        );
        expect(() => verify(fullPath, tampered)).toThrow("self-hash mismatch");
    });

    test("rejects incomplete, duplicate, tampered, or non-reproducing record evidence", () => {
        const directory = mkdtempSync(join(tmpdir(), "public-roster-guard-replay-evidence-"));
        temporaryDirectories.push(directory);
        const fullPath = writeReport(directory, "full.json", fixtureReport(FULL_BOARDS));
        const replayPath = writeReport(directory, "replay.json", fixtureReport(PUBLIC_ROSTER_GUARD_REPLAY_BOARDS));

        const missingRecord = mutateReport(directory, replayPath, "missing-record.json", (report) => {
            records(report, 0).pop();
        });
        expect(() => verify(fullPath, missingRecord)).toThrow("must contain the four crossover games");

        const duplicateRecord = mutateReport(directory, replayPath, "duplicate-record.json", (report) => {
            const clusterRecords = records(report, 0);
            clusterRecords[3] = structuredClone(clusterRecords[0]);
        });
        expect(() => verify(fullPath, duplicateRecord)).toThrow("each crossover game exactly once");

        const missingCluster = mutateReport(directory, replayPath, "missing-cluster.json", (report) => {
            (report.clusters as unknown[]).pop();
        });
        expect(() => verify(fullPath, missingCluster)).toThrow("one control and candidate cluster");

        const duplicateCluster = mutateReport(directory, replayPath, "duplicate-cluster.json", (report) => {
            const clusters = report.clusters as Record<string, unknown>[];
            clusters[clusters.length - 1] = structuredClone(clusters[0]);
        });
        expect(() => verify(fullPath, duplicateCluster)).toThrow("duplicate cluster");

        const fingerprintMismatch = mutateReport(directory, replayPath, "fingerprint-mismatch.json", (report) => {
            records(report, 0)[0].setupFingerprint = sha256("different setup fingerprint");
        });
        expect(() => verify(fullPath, fingerprintMismatch)).toThrow("setupFingerprint mismatch");

        const traceMismatch = mutateReport(directory, replayPath, "trace-mismatch.json", (report) => {
            const changedTrace = sha256("different behavior trace");
            records(report, 0)[0].behaviorTraceSha256 = changedTrace;
            records(report, 1)[0].behaviorTraceSha256 = changedTrace;
        });
        expect(() => verify(fullPath, traceMismatch)).toThrow("behaviorTraceSha256 mismatch");

        const extraRecordKey = mutateReport(directory, replayPath, "extra-record-key.json", (report) => {
            records(report, 0)[0].unexpected = true;
        });
        expect(() => verify(fullPath, extraRecordKey)).toThrow("keys do not match the frozen raw schema");
    });
});
