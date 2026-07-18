/*
 * Read-only pooler for ordered public-roster natural-guard shards.
 * Raw fights are never rerun. Each shard-local board is bound to one position
 * in the caller-attested original seed stream before any outcome is scored.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../ai/setup/draft_ship";
import { SETUP_COHORTS, V07_NONFIGHT_SETUP_SPEC, type SetupCohort } from "../ai/setup/setup_ship";
import {
    pairedPublicRosterPlacementDelta,
    publicRosterPlacementBoard,
    publicRosterPlacementDraftEvidence,
    type IPublicRosterPlacementBoard,
    type IPublicRosterPlacementDelta,
    type IPublicRosterPlacementRecord,
} from "./measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES, type SetupLiveGridType } from "./optimizer/v0_7_setup_overnight_core";

export const PUBLIC_ROSTER_NATURAL_POOL_SCHEMA_VERSION = 1;
export const PUBLIC_ROSTER_NATURAL_GATE = {
    minimumBoards: 5_000,
    minimumGamesPerArm: 20_000,
    naturalGainPp: 0.5,
    naturalConfidence95LowGainPpExclusive: 0,
    minimumActionableGames: 5_000,
    actionableGainPp: 2,
    actionableConfidence95LowGainPpExclusive: 0,
    mapGainPp: 0,
    mapConfidence95LowGainPpExclusive: -0.25,
    maximumDrawExcessPp: 1,
    maximumArmageddonExcessPp: 1,
    maximumAverageLapExcess: 1,
    maximumRejections: 0,
} as const;

const CONTROL_ARM = "control";
const CANDIDATE_ARM = "both";
const EXPECTED_ARMS = [CONTROL_ARM, CANDIDATE_ARM] as const;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{40}$/;
const PANEL_MASK = 0x3fffffff;
const PLACEMENT_ACTIONS = ["unchanged", "flyer-screen", "corner-shift"] as const;
const END_REASONS = ["elimination", "turn_cap", "stuck"] as const;

type ReportArm = (typeof EXPECTED_ARMS)[number];

export interface IPublicRosterNaturalArmSafety {
    games: number;
    draws: number;
    drawRate: number;
    armageddonDecided: number;
    armageddonRate: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    turnCaps: number;
    turnCapRate: number;
    totalLaps: number;
    avgLaps: number;
    candidateRejections: number;
    opposingRejections: number;
    endReasons: Record<(typeof END_REASONS)[number], number>;
}

export interface IPublicRosterNaturalSlice {
    matchedControlDelta: IPublicRosterPlacementDelta;
    candidate: IPublicRosterNaturalArmSafety;
    control: IPublicRosterNaturalArmSafety;
    matchedExcess: {
        drawPp: number;
        armageddonPp: number;
        drawOrArmageddonPp: number;
        turnCapPp: number;
        avgLaps: number;
        candidateRejections: number;
        opposingRejections: number;
    };
}

export interface IPublicRosterNaturalGateInput {
    completeInput: boolean;
    totalBoards: number;
    natural: IPublicRosterNaturalSlice;
    actionable: IPublicRosterNaturalSlice;
    byMap: Readonly<Record<SetupLiveGridType, IPublicRosterNaturalSlice>>;
}

interface ILoadedShard {
    shardIndex: number;
    sourceBytesSha256: string;
    sourceReportSha256: string;
    reportBaseSeed: number;
    localBoards: number;
    globalStartIndex: number;
    globalEndIndexExclusive: number;
    candidateRecords: IPublicRosterPlacementRecord[];
    controlRecords: IPublicRosterPlacementRecord[];
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
};

const asArray = (value: unknown, label: string): unknown[] => {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
    return value;
};

const asSafeInteger = (value: unknown, label: string, minimum: number = 0): number => {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
    }
    return value as number;
};

const sha256Bytes = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const sha256Json = (value: unknown): string => sha256Bytes(JSON.stringify(value));

function parseBoard(value: unknown, label: string): IPublicRosterPlacementBoard {
    const board = asRecord(value, label);
    if (!SETUP_LIVE_GRID_TYPES.includes(board.gridType as SetupLiveGridType)) {
        throw new TypeError(`${label}.gridType must be a live setup map`);
    }
    return {
        index: asSafeInteger(board.index, `${label}.index`),
        pairSeed: asSafeInteger(board.pairSeed, `${label}.pairSeed`),
        pickSeed: asSafeInteger(board.pickSeed, `${label}.pickSeed`),
        battleSeed: asSafeInteger(board.battleSeed, `${label}.battleSeed`),
        gridType: board.gridType as SetupLiveGridType,
    };
}

function sameBoard(
    left: IPublicRosterPlacementBoard,
    right: IPublicRosterPlacementBoard,
    includeIndex = true,
): boolean {
    return (
        (!includeIndex || left.index === right.index) &&
        left.pairSeed === right.pairSeed &&
        left.pickSeed === right.pickSeed &&
        left.battleSeed === right.battleSeed &&
        left.gridType === right.gridType
    );
}

function parseRecord(
    value: unknown,
    arm: ReportArm,
    board: IPublicRosterPlacementBoard,
    maxLaps: number,
    label: string,
): IPublicRosterPlacementRecord {
    const record = asRecord(value, label);
    const game = asSafeInteger(record.game, `${label}.game`);
    if (game > 3) throw new TypeError(`${label}.game must be in [0, 3]`);
    const expectedPickSeat = game < 2 ? "candidate-lower" : "candidate-upper";
    const expectedBattleMirror = (game % 2) as 0 | 1;
    const expectedCandidateSide = game === 0 || game === 3 ? "green" : "red";
    if (record.arm !== arm) throw new Error(`${label}.arm does not match its ${arm} cluster`);
    if (
        record.boardIndex !== board.index ||
        record.pairSeed !== board.pairSeed ||
        record.pickSeed !== board.pickSeed ||
        record.battleSeed !== board.battleSeed ||
        record.gridType !== board.gridType
    ) {
        throw new Error(`${label} does not match its shard-local board`);
    }
    if (
        record.pickSeat !== expectedPickSeat ||
        record.battleMirror !== expectedBattleMirror ||
        record.candidateSide !== expectedCandidateSide
    ) {
        throw new Error(`${label} has an invalid pick-seat/battle-side crossover`);
    }
    if (record.candidateResult !== "win" && record.candidateResult !== "loss" && record.candidateResult !== "draw") {
        throw new TypeError(`${label}.candidateResult is invalid`);
    }
    if (!SETUP_COHORTS.includes(record.candidateCohort as SetupCohort)) {
        throw new TypeError(`${label}.candidateCohort is invalid`);
    }
    if (!SETUP_COHORTS.includes(record.opponentCohort as SetupCohort)) {
        throw new TypeError(`${label}.opponentCohort is invalid`);
    }
    if (!PLACEMENT_ACTIONS.includes(record.incumbentAction as never)) {
        throw new TypeError(`${label}.incumbentAction is invalid`);
    }
    if (!PLACEMENT_ACTIONS.includes(record.candidateAction as never)) {
        throw new TypeError(`${label}.candidateAction is invalid`);
    }
    if (typeof record.actionable !== "boolean") throw new TypeError(`${label}.actionable must be boolean`);
    asSafeInteger(record.legitimateRevealCount, `${label}.legitimateRevealCount`);
    asSafeInteger(record.addedPublicCount, `${label}.addedPublicCount`);
    asSafeInteger(record.candidateRejections, `${label}.candidateRejections`);
    asSafeInteger(record.baselineRejections, `${label}.baselineRejections`);
    const laps = asSafeInteger(record.laps, `${label}.laps`, 1);
    if (laps > maxLaps) throw new Error(`${label}.laps exceeds the report lap cap`);
    if (!END_REASONS.includes(record.endReason as never)) throw new TypeError(`${label}.endReason is invalid`);
    if (typeof record.decidedByArmageddon !== "boolean") {
        throw new TypeError(`${label}.decidedByArmageddon must be boolean`);
    }
    if (typeof record.setupFingerprint !== "string" || !HEX_SHA256.test(record.setupFingerprint)) {
        throw new TypeError(`${label}.setupFingerprint must be SHA-256`);
    }
    if (typeof record.behaviorTraceSha256 !== "string" || !HEX_SHA256.test(record.behaviorTraceSha256)) {
        throw new TypeError(`${label}.behaviorTraceSha256 must be SHA-256`);
    }
    return record as unknown as IPublicRosterPlacementRecord;
}

function validateReportHash(report: Record<string, unknown>, label: string): string {
    const reportSha256 = report.reportSha256;
    if (typeof reportSha256 !== "string" || !HEX_SHA256.test(reportSha256)) {
        throw new TypeError(`${label}.reportSha256 must be SHA-256`);
    }
    const withoutHash = { ...report };
    delete withoutHash.reportSha256;
    if (sha256Json(withoutHash) !== reportSha256) throw new Error(`${label} self-hash mismatch`);
    return reportSha256;
}

function validateArmPair(
    candidate: IPublicRosterPlacementRecord,
    control: IPublicRosterPlacementRecord,
    label: string,
): void {
    if (
        candidate.pickSeed !== control.pickSeed ||
        candidate.battleSeed !== control.battleSeed ||
        candidate.gridType !== control.gridType ||
        candidate.pickSeat !== control.pickSeat ||
        candidate.battleMirror !== control.battleMirror ||
        candidate.candidateSide !== control.candidateSide ||
        candidate.candidateCohort !== control.candidateCohort ||
        candidate.opponentCohort !== control.opponentCohort ||
        candidate.incumbentAction !== control.incumbentAction ||
        candidate.legitimateRevealCount !== control.legitimateRevealCount
    ) {
        throw new Error(`${label} candidate/control metadata mismatch`);
    }
    if (control.actionable || control.candidateAction !== control.incumbentAction || control.addedPublicCount !== 0) {
        throw new Error(`${label} control record is not the unchanged placement arm`);
    }
    if (candidate.actionable !== (candidate.candidateAction !== candidate.incumbentAction)) {
        throw new Error(`${label} candidate actionable flag does not match its placement action`);
    }
}

function loadShard(path: string, shardIndex: number, originalBaseSeed: number, globalStartIndex: number): ILoadedShard {
    const bytes = readFileSync(path);
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
        throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const report = asRecord(parsed, path);
    const sourceReportSha256 = validateReportHash(report, path);
    if (report.schemaVersion !== 1)
        throw new Error(`${path} has unsupported report schema ${String(report.schemaVersion)}`);
    if (report.setupSpec !== V07_NONFIGHT_SETUP_SPEC) {
        throw new Error(`${path} uses setup spec ${String(report.setupSpec)}, expected ${V07_NONFIGHT_SETUP_SPEC}`);
    }
    if (report.draftSpec !== LEAGUE_ROUND1_DRAFT_SPEC) {
        throw new Error(`${path} uses draft spec ${String(report.draftSpec)}, expected ${LEAGUE_ROUND1_DRAFT_SPEC}`);
    }
    if (report.fightVersion !== "v0.7") throw new Error(`${path} is not a v0.7 fight report`);
    if (report.panel !== "guard") throw new Error(`${path} is not a guard-panel report`);
    if (report.target !== "natural") throw new Error(`${path} is not a natural-target report`);
    const arms = report.arms;
    if (
        !Array.isArray(arms) ||
        arms.length !== EXPECTED_ARMS.length ||
        !EXPECTED_ARMS.every((arm, index) => arms[index] === arm)
    ) {
        throw new Error(`${path} must pair exactly ${CONTROL_ARM} with candidate arm ${CANDIDATE_ARM}`);
    }
    const maxLaps = asSafeInteger(report.maxLaps, `${path}.maxLaps`, 1);
    if (maxLaps !== 60) throw new Error(`${path} must use the preregistered 60-lap cap`);
    const maps = asArray(report.maps, `${path}.maps`);
    if (
        maps.length !== SETUP_LIVE_GRID_TYPES.length ||
        !SETUP_LIVE_GRID_TYPES.every((gridType, index) => maps[index] === gridType)
    ) {
        throw new Error(`${path} does not name the exact live-map panel`);
    }
    const reportBaseSeed = asSafeInteger(report.baseSeed, `${path}.baseSeed`);
    const localBoards = asSafeInteger(report.boards, `${path}.boards`, 1);
    if (report.scannedBoards !== localBoards) throw new Error(`${path} natural scan must accept every local board`);
    const expectedFirstBoard = publicRosterPlacementBoard(originalBaseSeed, "guard", globalStartIndex);
    if ((reportBaseSeed & PANEL_MASK) !== (expectedFirstBoard.pairSeed & PANEL_MASK)) {
        throw new Error(`${path} shard base does not continue the caller-attested global seed ledger`);
    }
    const boardLedger = asArray(report.boardLedger, `${path}.boardLedger`).map((value, localIndex) => {
        const board = parseBoard(value, `${path}.boardLedger[${localIndex}]`);
        const localExpected = publicRosterPlacementBoard(reportBaseSeed, "guard", localIndex);
        const globalExpected = publicRosterPlacementBoard(originalBaseSeed, "guard", globalStartIndex + localIndex);
        if (
            board.index !== localIndex ||
            !sameBoard(board, localExpected) ||
            !sameBoard(board, globalExpected, false)
        ) {
            throw new Error(`${path} board ${localIndex} breaks the contiguous global seed ledger`);
        }
        return board;
    });
    if (boardLedger.length !== localBoards) throw new Error(`${path} board count does not match its ledger`);

    const boardByIndex = new Map(boardLedger.map((board) => [board.index, board]));
    const recordsByArm: Record<ReportArm, IPublicRosterPlacementRecord[]> = { control: [], both: [] };
    const clusters = asArray(report.clusters, `${path}.clusters`);
    if (clusters.length !== localBoards * EXPECTED_ARMS.length) {
        throw new Error(`${path} must contain one control and candidate cluster per local board`);
    }
    const seenClusters = new Set<string>();
    for (const [clusterIndex, value] of clusters.entries()) {
        const label = `${path}.clusters[${clusterIndex}]`;
        const cluster = asRecord(value, label);
        if (cluster.arm !== CONTROL_ARM && cluster.arm !== CANDIDATE_ARM) {
            throw new Error(`${label}.arm is not ${CONTROL_ARM}/${CANDIDATE_ARM}`);
        }
        const arm = cluster.arm as ReportArm;
        const board = parseBoard(cluster.board, `${label}.board`);
        const ledgerBoard = boardByIndex.get(board.index);
        if (!ledgerBoard || !sameBoard(board, ledgerBoard))
            throw new Error(`${label}.board is not in the shard ledger`);
        const clusterKey = `${arm}/${board.index}`;
        if (seenClusters.has(clusterKey)) throw new Error(`${path} has duplicate cluster ${clusterKey}`);
        seenClusters.add(clusterKey);
        const records = asArray(cluster.records, `${label}.records`);
        if (records.length !== 4) throw new Error(`${label} must contain the four crossover games`);
        const parsedRecords = records.map((record, index) =>
            parseRecord(record, arm, board, maxLaps, `${label}.records[${index}]`),
        );
        if (new Set(parsedRecords.map((record) => record.game)).size !== 4) {
            throw new Error(`${label} must contain each crossover game exactly once`);
        }
        recordsByArm[arm].push(...parsedRecords);
    }
    const expectedGames = localBoards * EXPECTED_ARMS.length * 4;
    if (report.games !== expectedGames) throw new Error(`${path}.games must equal ${expectedGames}`);

    const candidateByKey = new Map(recordsByArm.both.map((record) => [`${record.pairSeed}/${record.game}`, record]));
    const controlByKey = new Map(recordsByArm.control.map((record) => [`${record.pairSeed}/${record.game}`, record]));
    if (candidateByKey.size !== localBoards * 4 || controlByKey.size !== localBoards * 4) {
        throw new Error(`${path} contains omitted or duplicate crossover games`);
    }
    for (const [localIndex, board] of boardLedger.entries()) {
        const draft = publicRosterPlacementDraftEvidence(board);
        for (const game of [0, 1, 2, 3] as const) {
            const key = `${board.pairSeed}/${game}`;
            const candidate = candidateByKey.get(key);
            const control = controlByKey.get(key);
            if (!candidate || !control) throw new Error(`${path} omitted paired game ${key}`);
            validateArmPair(candidate, control, `${path} game ${key}`);
            const seat = game < 2 ? draft.lower : draft.upper;
            const opponent = game < 2 ? draft.upper : draft.lower;
            if (
                candidate.candidateCohort !== seat.cohort ||
                control.candidateCohort !== seat.cohort ||
                candidate.opponentCohort !== opponent.cohort ||
                control.opponentCohort !== opponent.cohort
            ) {
                throw new Error(
                    `${path} cohort mismatch for reconstructed global board ${globalStartIndex + localIndex}`,
                );
            }
        }
    }
    return {
        shardIndex,
        sourceBytesSha256: sha256Bytes(bytes),
        sourceReportSha256,
        reportBaseSeed,
        localBoards,
        globalStartIndex,
        globalEndIndexExclusive: globalStartIndex + localBoards,
        candidateRecords: recordsByArm.both,
        controlRecords: recordsByArm.control,
    };
}

function armSafety(records: readonly IPublicRosterPlacementRecord[]): IPublicRosterNaturalArmSafety {
    const draws = records.filter((record) => record.candidateResult === "draw").length;
    const armageddonDecided = records.filter((record) => record.decidedByArmageddon).length;
    const drawOrArmageddon = records.filter(
        (record) => record.candidateResult === "draw" || record.decidedByArmageddon,
    ).length;
    const turnCaps = records.filter((record) => record.endReason === "turn_cap").length;
    const totalLaps = records.reduce((sum, record) => sum + record.laps, 0);
    const endReasons = Object.fromEntries(END_REASONS.map((reason) => [reason, 0])) as Record<
        (typeof END_REASONS)[number],
        number
    >;
    for (const record of records) endReasons[record.endReason] += 1;
    return {
        games: records.length,
        draws,
        drawRate: records.length ? draws / records.length : 0,
        armageddonDecided,
        armageddonRate: records.length ? armageddonDecided / records.length : 0,
        drawOrArmageddon,
        drawOrArmageddonRate: records.length ? drawOrArmageddon / records.length : 0,
        turnCaps,
        turnCapRate: records.length ? turnCaps / records.length : 0,
        totalLaps,
        avgLaps: records.length ? totalLaps / records.length : 0,
        candidateRejections: records.reduce((sum, record) => sum + record.candidateRejections, 0),
        opposingRejections: records.reduce((sum, record) => sum + record.baselineRejections, 0),
        endReasons,
    };
}

function summarizeSlice(
    candidateRecords: readonly IPublicRosterPlacementRecord[],
    controlByKey: ReadonlyMap<string, IPublicRosterPlacementRecord>,
): IPublicRosterNaturalSlice {
    const controls = candidateRecords.map((candidate) => {
        const control = controlByKey.get(`${candidate.pairSeed}/${candidate.game}`);
        if (!control) throw new Error(`pooled control omitted ${candidate.pairSeed}/${candidate.game}`);
        return control;
    });
    const candidate = armSafety(candidateRecords);
    const control = armSafety(controls);
    return {
        matchedControlDelta: pairedPublicRosterPlacementDelta(candidateRecords, controls),
        candidate,
        control,
        matchedExcess: {
            drawPp: (candidate.drawRate - control.drawRate) * 100,
            armageddonPp: (candidate.armageddonRate - control.armageddonRate) * 100,
            drawOrArmageddonPp: (candidate.drawOrArmageddonRate - control.drawOrArmageddonRate) * 100,
            turnCapPp: (candidate.turnCapRate - control.turnCapRate) * 100,
            avgLaps: candidate.avgLaps - control.avgLaps,
            candidateRejections: candidate.candidateRejections - control.candidateRejections,
            opposingRejections: candidate.opposingRejections - control.opposingRejections,
        },
    };
}

export function evaluatePublicRosterNaturalGate(input: Readonly<IPublicRosterNaturalGateInput>) {
    const natural = input.natural;
    const actionable = input.actionable;
    const allRejections =
        natural.candidate.candidateRejections +
        natural.candidate.opposingRejections +
        natural.control.candidateRejections +
        natural.control.opposingRejections;
    const mapChecks = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => {
            const delta = input.byMap[gridType].matchedControlDelta;
            return [
                gridType,
                {
                    pointPassed: delta.scoreGainPp >= PUBLIC_ROSTER_NATURAL_GATE.mapGainPp,
                    confidencePassed:
                        (delta.confidence95GainPp?.low ?? -Infinity) >
                        PUBLIC_ROSTER_NATURAL_GATE.mapConfidence95LowGainPpExclusive,
                },
            ];
        }),
    ) as Record<SetupLiveGridType, { pointPassed: boolean; confidencePassed: boolean }>;
    const checks = {
        completeInput: input.completeInput,
        noOmittedBoards: natural.matchedControlDelta.boards === input.totalBoards,
        noOmittedCandidateGames: natural.candidate.games === input.totalBoards * 4,
        noOmittedControlGames: natural.control.games === input.totalBoards * 4,
        noOmittedMatchedGames: natural.matchedControlDelta.games === input.totalBoards * 4,
        minimumBoards: natural.matchedControlDelta.boards >= PUBLIC_ROSTER_NATURAL_GATE.minimumBoards,
        minimumCandidateGames: natural.candidate.games >= PUBLIC_ROSTER_NATURAL_GATE.minimumGamesPerArm,
        minimumControlGames: natural.control.games >= PUBLIC_ROSTER_NATURAL_GATE.minimumGamesPerArm,
        naturalGain: natural.matchedControlDelta.scoreGainPp >= PUBLIC_ROSTER_NATURAL_GATE.naturalGainPp,
        naturalConfidence:
            (natural.matchedControlDelta.confidence95GainPp?.low ?? -Infinity) >
            PUBLIC_ROSTER_NATURAL_GATE.naturalConfidence95LowGainPpExclusive,
        minimumActionableGames: actionable.candidate.games >= PUBLIC_ROSTER_NATURAL_GATE.minimumActionableGames,
        actionableGain: actionable.matchedControlDelta.scoreGainPp >= PUBLIC_ROSTER_NATURAL_GATE.actionableGainPp,
        actionableConfidence:
            (actionable.matchedControlDelta.confidence95GainPp?.low ?? -Infinity) >
            PUBLIC_ROSTER_NATURAL_GATE.actionableConfidence95LowGainPpExclusive,
        everyMapPoint: SETUP_LIVE_GRID_TYPES.every((gridType) => mapChecks[gridType].pointPassed),
        everyMapConfidence: SETUP_LIVE_GRID_TYPES.every((gridType) => mapChecks[gridType].confidencePassed),
        zeroRejections: allRejections <= PUBLIC_ROSTER_NATURAL_GATE.maximumRejections,
        drawSafety: natural.matchedExcess.drawPp <= PUBLIC_ROSTER_NATURAL_GATE.maximumDrawExcessPp,
        armageddonSafety: natural.matchedExcess.armageddonPp <= PUBLIC_ROSTER_NATURAL_GATE.maximumArmageddonExcessPp,
        averageLapSafety: natural.matchedExcess.avgLaps <= PUBLIC_ROSTER_NATURAL_GATE.maximumAverageLapExcess,
    };
    return {
        thresholds: PUBLIC_ROSTER_NATURAL_GATE,
        checks,
        mapChecks,
        passed: Object.values(checks).every(Boolean),
    };
}

export function poolPublicRosterNaturalGuardShards(
    orderedPaths: readonly string[],
    sourceCommit: string,
    originalBaseSeed: number,
    expectedTotalBoards: number,
) {
    if (!orderedPaths.length) throw new Error("at least one ordered natural shard report is required");
    if (!HEX_COMMIT.test(sourceCommit)) {
        throw new Error("source commit must be exactly 40 lowercase hexadecimal characters");
    }
    asSafeInteger(originalBaseSeed, "expected original base seed");
    asSafeInteger(expectedTotalBoards, "expected total boards", 1);
    const shards: ILoadedShard[] = [];
    let globalIndex = 0;
    for (const [shardIndex, path] of orderedPaths.entries()) {
        const shard = loadShard(path, shardIndex, originalBaseSeed, globalIndex);
        shards.push(shard);
        globalIndex = shard.globalEndIndexExclusive;
    }
    if (globalIndex !== expectedTotalBoards) {
        throw new Error(`ordered shards contain ${globalIndex}/${expectedTotalBoards} expected natural boards`);
    }
    const candidateRecords = shards.flatMap((shard) => shard.candidateRecords);
    const controlRecords = shards.flatMap((shard) => shard.controlRecords);
    if (candidateRecords.length !== expectedTotalBoards * 4 || controlRecords.length !== expectedTotalBoards * 4) {
        throw new Error("ordered shards omit one or more candidate/control games");
    }
    const candidateKeys = new Set(candidateRecords.map((record) => `${record.pairSeed}/${record.game}`));
    const controlByKey = new Map(controlRecords.map((record) => [`${record.pairSeed}/${record.game}`, record]));
    if (candidateKeys.size !== candidateRecords.length || controlByKey.size !== controlRecords.length) {
        throw new Error("ordered shards contain duplicate candidate/control games");
    }
    const natural = summarizeSlice(candidateRecords, controlByKey);
    const actionable = summarizeSlice(
        candidateRecords.filter((record) => record.actionable),
        controlByKey,
    );
    const flyerScreen = summarizeSlice(
        candidateRecords.filter((record) => record.actionable && record.candidateAction === "flyer-screen"),
        controlByKey,
    );
    const cornerShift = summarizeSlice(
        candidateRecords.filter((record) => record.actionable && record.candidateAction === "corner-shift"),
        controlByKey,
    );
    const byMap = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [
            gridType,
            summarizeSlice(
                candidateRecords.filter((record) => record.gridType === gridType),
                controlByKey,
            ),
        ]),
    ) as Record<SetupLiveGridType, IPublicRosterNaturalSlice>;
    const byCohort = Object.fromEntries(
        SETUP_COHORTS.map((cohort) => [
            cohort,
            summarizeSlice(
                candidateRecords.filter((record) => record.candidateCohort === cohort),
                controlByKey,
            ),
        ]),
    ) as Record<SetupCohort, IPublicRosterNaturalSlice>;
    const gate = evaluatePublicRosterNaturalGate({
        completeInput: true,
        totalBoards: expectedTotalBoards,
        natural,
        actionable,
        byMap,
    });
    const withoutHash = {
        schemaVersion: PUBLIC_ROSTER_NATURAL_POOL_SCHEMA_VERSION,
        status: gate.passed ? "passed" : "failed",
        sourceBinding: {
            sourceCommit,
            expectedOriginalBaseSeed: originalBaseSeed,
            expectedTotalBoards,
            provenance: "caller-attested; source commit and original base seed are not embedded in raw reports",
        },
        protocol: {
            setupSpec: V07_NONFIGHT_SETUP_SPEC,
            draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
            fightVersion: "v0.7",
            panel: "guard",
            target: "natural",
            candidateArm: CANDIDATE_ARM,
            controlArm: CONTROL_ARM,
            maps: SETUP_LIVE_GRID_TYPES,
            maxLaps: 60,
        },
        integrity: {
            completeOrderedLedger: true,
            omittedBoards: 0,
            omittedCandidateGames: 0,
            omittedControlGames: 0,
            omittedFailedGames: 0,
            shardCount: shards.length,
            pooledRecordsSha256: sha256Json({ candidateRecords, controlRecords }),
        },
        shards: shards.map((shard) => ({
            shardIndex: shard.shardIndex,
            sourceBytesSha256: shard.sourceBytesSha256,
            sourceReportSha256: shard.sourceReportSha256,
            reportBaseSeed: shard.reportBaseSeed,
            localBoards: shard.localBoards,
            globalStartIndex: shard.globalStartIndex,
            globalEndIndexExclusive: shard.globalEndIndexExclusive,
        })),
        slices: { natural, actionable, flyerScreen, cornerShift, byMap, byCohort },
        gate,
    };
    return { ...withoutHash, reportSha256: sha256Json(withoutHash) };
}

export function main(): void {
    const { positionals, values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            "expected-original-base-seed": { type: "string" },
            "expected-total-boards": { type: "string" },
            "source-commit": { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: true,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/pool_public_roster_natural_guard.ts " +
                "--source-commit <40-hex> --expected-original-base-seed <integer> " +
                "--expected-total-boards <integer> <ordered shard reports>",
        );
        return;
    }
    if (!values["source-commit"]) throw new Error("--source-commit is required");
    if (!values["expected-original-base-seed"]) throw new Error("--expected-original-base-seed is required");
    if (!values["expected-total-boards"]) throw new Error("--expected-total-boards is required");
    const report = poolPublicRosterNaturalGuardShards(
        positionals,
        values["source-commit"],
        Number(values["expected-original-base-seed"]),
        Number(values["expected-total-boards"]),
    );
    console.log(JSON.stringify(report, null, 2));
}

if ((import.meta as unknown as { main?: boolean }).main) main();
