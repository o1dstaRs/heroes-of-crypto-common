/*
 * Deterministic, fight-free comparison of a small cohort-safe natural rerun
 * against the corresponding prefix of the frozen full natural guard report.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../ai/setup/draft_ship";
import {
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_SETUP_SPEC,
} from "../ai/setup/setup_ship";
import {
    publicRosterPlacementBoard,
    PUBLIC_ROSTER_COHORT_SAFE_ARM,
    type IPublicRosterPlacementBoard,
} from "./measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES } from "./optimizer/v0_7_setup_overnight_core";
import { poolPublicRosterNaturalGuardShards } from "./pool_public_roster_natural_guard";

export const PUBLIC_ROSTER_GUARD_SOURCE_COMMIT = "ddeaffbf9daf8743d93bb9cd57975f9d74bb6c17";
export const PUBLIC_ROSTER_GUARD_BASE_SEED = 130_934_206;
export const PUBLIC_ROSTER_GUARD_START_BOARD = 2_000_000;
export const PUBLIC_ROSTER_GUARD_FULL_BOARDS = 5_000;
export const PUBLIC_ROSTER_GUARD_REPLAY_BOARDS = 10;
export const PUBLIC_ROSTER_GUARD_MAX_LAPS = 60;
export const PUBLIC_ROSTER_GUARD_REPLAY_SCHEMA_VERSION = 1;

const CONTROL_ARM = "control" as const;
const EXPECTED_ARMS = [CONTROL_ARM, PUBLIC_ROSTER_COHORT_SAFE_ARM] as const;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const RAW_REPORT_KEYS = [
    "schemaVersion",
    "status",
    "question",
    "setupSpec",
    "cohortSafeSetupSpec",
    "cohortSafeBehaviorSha256",
    "draftSpec",
    "fightVersion",
    "informationBoundary",
    "arms",
    "panel",
    "target",
    "baseSeed",
    "startBoard",
    "boards",
    "scannedBoards",
    "games",
    "maxLaps",
    "maps",
    "wallSeconds",
    "summaries",
    "comparisons",
    "boardLedger",
    "clusters",
    "reportSha256",
] as const;
const BOARD_KEYS = ["index", "pairSeed", "pickSeed", "battleSeed", "gridType"] as const;
const CLUSTER_KEYS = ["arm", "board", "records"] as const;
const RECORD_KEYS = [
    "arm",
    "boardIndex",
    "game",
    "pairSeed",
    "pickSeed",
    "battleSeed",
    "gridType",
    "pickSeat",
    "battleMirror",
    "candidateSide",
    "candidateResult",
    "candidateCohort",
    "opponentCohort",
    "incumbentAction",
    "candidateAction",
    "actionable",
    "legitimateRevealCount",
    "addedPublicCount",
    "candidateRejections",
    "baselineRejections",
    "laps",
    "endReason",
    "decidedByArmageddon",
    "setupFingerprint",
    "behaviorTraceSha256",
] as const;

type ReplayArm = (typeof EXPECTED_ARMS)[number];

interface IReplayRecordHashes {
    arm: ReplayArm;
    boardIndex: number;
    game: number;
    setupFingerprint: string;
    behaviorTraceSha256: string;
}

interface IReplayMaterial {
    sourceBytesSha256: string;
    sourceReportSha256: string;
    boards: IPublicRosterPlacementBoard[];
    records: Map<string, IReplayRecordHashes>;
}

export interface IPublicRosterGuardReplayExpectations {
    sourceCommit: string;
    expectedFullBoards?: number;
}

const sha256Bytes = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sha256Json = (value: unknown): string => sha256Bytes(JSON.stringify(value));

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    return value;
}

function asSafeInteger(value: unknown, label: string, minimum: number = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
    }
    return value as number;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new Error(`${label} keys do not match the frozen raw schema`);
    }
}

function parseBoard(value: unknown, label: string): IPublicRosterPlacementBoard {
    const board = asRecord(value, label);
    assertExactKeys(board, BOARD_KEYS, label);
    return {
        index: asSafeInteger(board.index, `${label}.index`),
        pairSeed: asSafeInteger(board.pairSeed, `${label}.pairSeed`),
        pickSeed: asSafeInteger(board.pickSeed, `${label}.pickSeed`),
        battleSeed: asSafeInteger(board.battleSeed, `${label}.battleSeed`),
        gridType: asSafeInteger(board.gridType, `${label}.gridType`) as IPublicRosterPlacementBoard["gridType"],
    };
}

function sameBoard(left: IPublicRosterPlacementBoard, right: IPublicRosterPlacementBoard): boolean {
    return (
        left.index === right.index &&
        left.pairSeed === right.pairSeed &&
        left.pickSeed === right.pickSeed &&
        left.battleSeed === right.battleSeed &&
        left.gridType === right.gridType
    );
}

function replayRecordKey(arm: ReplayArm, boardIndex: number, game: number): string {
    return `${arm}\u0000${boardIndex}\u0000${game}`;
}

function loadValidatedReplayMaterial(
    path: string,
    expectedBytesSha256: string,
    expectedReportSha256: string,
    expectedBoards: number,
    label: string,
): IReplayMaterial {
    const bytes = readFileSync(path);
    const sourceBytesSha256 = sha256Bytes(bytes);
    if (sourceBytesSha256 !== expectedBytesSha256) {
        throw new Error(`${label} bytes changed after structured validation`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const report = asRecord(parsed, label);
    assertExactKeys(report, RAW_REPORT_KEYS, label);
    if (report.reportSha256 !== expectedReportSha256) {
        throw new Error(`${label} semantic report hash changed after validation`);
    }
    const boardLedger = asArray(report.boardLedger, `${label}.boardLedger`).map((value, index) =>
        parseBoard(value, `${label}.boardLedger[${index}]`),
    );
    if (boardLedger.length !== expectedBoards)
        throw new Error(`${label} sample does not match ${expectedBoards} boards`);
    const records = new Map<string, IReplayRecordHashes>();
    for (const [clusterIndex, value] of asArray(report.clusters, `${label}.clusters`).entries()) {
        const clusterLabel = `${label}.clusters[${clusterIndex}]`;
        const cluster = asRecord(value, clusterLabel);
        assertExactKeys(cluster, CLUSTER_KEYS, clusterLabel);
        if (!EXPECTED_ARMS.includes(cluster.arm as ReplayArm)) throw new Error(`${clusterLabel}.arm is not frozen`);
        const arm = cluster.arm as ReplayArm;
        const board = parseBoard(cluster.board, `${clusterLabel}.board`);
        for (const [recordIndex, value] of asArray(cluster.records, `${clusterLabel}.records`).entries()) {
            const recordLabel = `${clusterLabel}.records[${recordIndex}]`;
            const record = asRecord(value, recordLabel);
            assertExactKeys(record, RECORD_KEYS, recordLabel);
            const boardIndex = asSafeInteger(record.boardIndex, `${recordLabel}.boardIndex`);
            const game = asSafeInteger(record.game, `${recordLabel}.game`);
            if (record.arm !== arm || boardIndex !== board.index || game > 3) {
                throw new Error(`${recordLabel} does not match its structured cluster`);
            }
            if (typeof record.setupFingerprint !== "string" || !HEX_SHA256.test(record.setupFingerprint)) {
                throw new TypeError(`${recordLabel}.setupFingerprint must be complete SHA-256`);
            }
            if (typeof record.behaviorTraceSha256 !== "string" || !HEX_SHA256.test(record.behaviorTraceSha256)) {
                throw new TypeError(`${recordLabel}.behaviorTraceSha256 must be complete SHA-256`);
            }
            const key = replayRecordKey(arm, boardIndex, game);
            if (records.has(key)) throw new Error(`${label} has duplicate replay record ${key}`);
            records.set(key, {
                arm,
                boardIndex,
                game,
                setupFingerprint: record.setupFingerprint,
                behaviorTraceSha256: record.behaviorTraceSha256,
            });
        }
    }
    if (records.size !== expectedBoards * EXPECTED_ARMS.length * 4) {
        throw new Error(`${label} has missing replay records`);
    }
    return { sourceBytesSha256, sourceReportSha256: expectedReportSha256, boards: boardLedger, records };
}

export function verifyPublicRosterGuardReplay(
    fullReportPath: string,
    replayReportPath: string,
    expectations: Readonly<IPublicRosterGuardReplayExpectations>,
) {
    if (expectations.sourceCommit !== PUBLIC_ROSTER_GUARD_SOURCE_COMMIT) {
        throw new Error(`source commit must equal frozen ${PUBLIC_ROSTER_GUARD_SOURCE_COMMIT}`);
    }
    const expectedFullBoards = expectations.expectedFullBoards ?? PUBLIC_ROSTER_GUARD_FULL_BOARDS;
    asSafeInteger(expectedFullBoards, "expected full boards", PUBLIC_ROSTER_GUARD_REPLAY_BOARDS);

    const fullValidation = poolPublicRosterNaturalGuardShards(
        [fullReportPath],
        expectations.sourceCommit,
        PUBLIC_ROSTER_GUARD_BASE_SEED,
        expectedFullBoards,
        PUBLIC_ROSTER_GUARD_START_BOARD,
    );
    const replayValidation = poolPublicRosterNaturalGuardShards(
        [replayReportPath],
        expectations.sourceCommit,
        PUBLIC_ROSTER_GUARD_BASE_SEED,
        PUBLIC_ROSTER_GUARD_REPLAY_BOARDS,
        PUBLIC_ROSTER_GUARD_START_BOARD,
    );
    const fullShard = fullValidation.shards[0];
    const replayShard = replayValidation.shards[0];
    if (!fullShard || fullValidation.shards.length !== 1) throw new Error("full natural report must be one raw report");
    if (!replayShard || replayValidation.shards.length !== 1) throw new Error("replay must be one raw report");
    const full = loadValidatedReplayMaterial(
        fullReportPath,
        fullShard.sourceBytesSha256,
        fullShard.sourceReportSha256,
        expectedFullBoards,
        "full natural report",
    );
    const replay = loadValidatedReplayMaterial(
        replayReportPath,
        replayShard.sourceBytesSha256,
        replayShard.sourceReportSha256,
        PUBLIC_ROSTER_GUARD_REPLAY_BOARDS,
        "10-board replay report",
    );

    for (let index = 0; index < PUBLIC_ROSTER_GUARD_REPLAY_BOARDS; index += 1) {
        const allocated = publicRosterPlacementBoard(
            PUBLIC_ROSTER_GUARD_BASE_SEED,
            "guard",
            PUBLIC_ROSTER_GUARD_START_BOARD + index,
        );
        if (!sameBoard(replay.boards[index], allocated) || !sameBoard(full.boards[index], allocated)) {
            throw new Error(`replay board ${index} does not match the frozen natural allocator`);
        }
    }

    const records: IReplayRecordHashes[] = [];
    for (let offset = 0; offset < PUBLIC_ROSTER_GUARD_REPLAY_BOARDS; offset += 1) {
        const boardIndex = PUBLIC_ROSTER_GUARD_START_BOARD + offset;
        for (const arm of EXPECTED_ARMS) {
            for (const game of [0, 1, 2, 3] as const) {
                const key = replayRecordKey(arm, boardIndex, game);
                const replayRecord = replay.records.get(key);
                const fullRecord = full.records.get(key);
                if (!replayRecord || !fullRecord) throw new Error(`missing corresponding full/replay record ${key}`);
                if (replayRecord.setupFingerprint !== fullRecord.setupFingerprint) {
                    throw new Error(`setupFingerprint mismatch for ${arm}/board-${boardIndex}/game-${game}`);
                }
                if (replayRecord.behaviorTraceSha256 !== fullRecord.behaviorTraceSha256) {
                    throw new Error(`behaviorTraceSha256 mismatch for ${arm}/board-${boardIndex}/game-${game}`);
                }
                records.push(replayRecord);
            }
        }
    }

    const withoutHash = {
        schemaVersion: PUBLIC_ROSTER_GUARD_REPLAY_SCHEMA_VERSION,
        status: "verified" as const,
        mode: "fight_free_raw_replay_comparison" as const,
        sourceBinding: {
            sourceCommit: expectations.sourceCommit,
            provenance: "caller-attested; raw reports do not embed the source commit",
        },
        protocol: {
            setupSpec: V07_NONFIGHT_SETUP_SPEC,
            draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
            fightVersion: "v0.7" as const,
            panel: "guard" as const,
            target: "natural" as const,
            baseSeed: PUBLIC_ROSTER_GUARD_BASE_SEED,
            startBoard: PUBLIC_ROSTER_GUARD_START_BOARD,
            maxLaps: PUBLIC_ROSTER_GUARD_MAX_LAPS,
            maps: SETUP_LIVE_GRID_TYPES,
            arms: EXPECTED_ARMS,
            candidateArm: PUBLIC_ROSTER_COHORT_SAFE_ARM,
            candidateSetupSpec: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
            candidateBehaviorSha256: V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
            candidatePlacementPolicy: COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
        },
        fullReport: {
            boards: expectedFullBoards,
            sourceBytesSha256: full.sourceBytesSha256,
            sourceReportSha256: full.sourceReportSha256,
        },
        replayReport: {
            boards: PUBLIC_ROSTER_GUARD_REPLAY_BOARDS,
            sourceBytesSha256: replay.sourceBytesSha256,
            sourceReportSha256: replay.sourceReportSha256,
        },
        recordsCompared: records.length,
        replayBoardLedgerSha256: sha256Json(replay.boards),
        recordsSha256: sha256Json(records),
        records,
    };
    return { ...withoutHash, reportSha256: sha256Json(withoutHash) };
}

export function main(): void {
    const { positionals, values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            "source-commit": { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: true,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/verify_public_roster_guard_replay.ts " +
                "--source-commit ddeaffbf9daf8743d93bb9cd57975f9d74bb6c17 " +
                "<full-5000-board-natural-report.json> <replay-10-board-natural-report.json>",
        );
        return;
    }
    if (!values["source-commit"]) throw new Error("--source-commit is required");
    if (positionals.length !== 2) throw new Error("exactly one full report and one replay report are required");
    console.log(
        JSON.stringify(
            verifyPublicRosterGuardReplay(positionals[0], positionals[1], {
                sourceCommit: values["source-commit"],
            }),
            null,
            2,
        ),
    );
}

if ((import.meta as unknown as { main?: boolean }).main) main();
