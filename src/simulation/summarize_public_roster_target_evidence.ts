/*
 * Deterministic, fight-free reducer for the preregistered public-roster target reports.
 * It reconstructs only each board's ranked draft so target membership follows the
 * candidate's actual pick seat instead of the report-wide accepted-board predicate.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../ai/setup/draft_ship";
import {
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    SETUP_COHORTS,
    V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_SETUP_SPEC,
} from "../ai/setup/setup_ship";
import {
    collectPublicRosterPlacementBoards,
    pairedPublicRosterPlacementDelta,
    PUBLIC_ROSTER_COHORT_SAFE_ARM,
    PUBLIC_ROSTER_PLACEMENT_TARGETS,
    publicRosterPlacementDraftEvidence,
    type IPublicRosterPlacementBoard,
    type IPublicRosterPlacementRecord,
    type PublicRosterPlacementTarget,
} from "./measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES, type SetupLiveGridType } from "./optimizer/v0_7_setup_overnight_core";

export const PUBLIC_ROSTER_TARGET_EVIDENCE_SCHEMA_VERSION = 1;
export const PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS = PUBLIC_ROSTER_PLACEMENT_TARGETS.filter(
    (target): target is Exclude<PublicRosterPlacementTarget, "natural"> => target !== "natural",
);
export const PUBLIC_ROSTER_TARGET_GATE = {
    requiredBoardsPerTarget: 1_000,
    minimumScoreGainPp: 0,
    minimumConfidence95LowGainPpExclusive: -1.5,
    maximumDrawExcessPp: 1,
    maximumArmageddonExcessPp: 1,
    maximumAverageLapExcess: 1,
    maximumRejections: 0,
} as const;

const CANDIDATE_ARM = PUBLIC_ROSTER_COHORT_SAFE_ARM;
const CONTROL_ARM = "control";
const EXPECTED_ARMS = [CONTROL_ARM, CANDIDATE_ARM] as const;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{40}$/;
const PLACEMENT_ACTIONS = ["unchanged", "flyer-screen", "corner-shift"] as const;
const END_REASONS = ["elimination", "turn_cap", "stuck"] as const;

type TargetEvidenceTarget = (typeof PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS)[number];
type ReportArm = (typeof EXPECTED_ARMS)[number];

interface IArmSafety {
    games: number;
    draws: number;
    drawRate: number;
    armageddonDecided: number;
    armageddonRate: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
    totalLaps: number;
    avgLaps: number;
    candidateRejections: number;
    opposingRejections: number;
}

interface ILoadedTargetReport {
    target: TargetEvidenceTarget;
    sourceBytesSha256: string;
    sourceReportSha256: string;
    baseSeed: number;
    startBoard: number;
    boards: number;
    scannedBoards: number;
    maxLaps: number;
    maps: SetupLiveGridType[];
    boardLedger: IPublicRosterPlacementBoard[];
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
    const gridType = board.gridType;
    if (!SETUP_LIVE_GRID_TYPES.includes(gridType as SetupLiveGridType)) {
        throw new TypeError(`${label}.gridType must be a live setup map`);
    }
    return {
        index: asSafeInteger(board.index, `${label}.index`),
        pairSeed: asSafeInteger(board.pairSeed, `${label}.pairSeed`),
        pickSeed: asSafeInteger(board.pickSeed, `${label}.pickSeed`),
        battleSeed: asSafeInteger(board.battleSeed, `${label}.battleSeed`),
        gridType: gridType as SetupLiveGridType,
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
    if (record.boardIndex !== board.index || record.pairSeed !== board.pairSeed) {
        throw new Error(`${label} does not match its board identity`);
    }
    if (
        record.pickSeed !== board.pickSeed ||
        record.battleSeed !== board.battleSeed ||
        record.gridType !== board.gridType
    ) {
        throw new Error(`${label} does not match its board seeds/map`);
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
    if (!SETUP_COHORTS.includes(record.candidateCohort as never)) {
        throw new TypeError(`${label}.candidateCohort is invalid`);
    }
    if (!SETUP_COHORTS.includes(record.opponentCohort as never)) {
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

function loadTargetReport(path: string): ILoadedTargetReport {
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
    if (report.panel !== "guard") throw new Error(`${path} is not a guard-panel report`);
    if (report.setupSpec !== V07_NONFIGHT_SETUP_SPEC) {
        throw new Error(`${path} uses setup spec ${String(report.setupSpec)}, expected ${V07_NONFIGHT_SETUP_SPEC}`);
    }
    if (
        report.cohortSafeSetupSpec !== V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC ||
        report.cohortSafeBehaviorSha256 !== V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256
    ) {
        throw new Error(`${path} does not bind the frozen cohort-safe placement artifact`);
    }
    if (report.draftSpec !== LEAGUE_ROUND1_DRAFT_SPEC) {
        throw new Error(`${path} uses draft spec ${String(report.draftSpec)}, expected ${LEAGUE_ROUND1_DRAFT_SPEC}`);
    }
    if (report.fightVersion !== "v0.7") throw new Error(`${path} is not a v0.7 fight report`);
    const arms = report.arms;
    if (
        !Array.isArray(arms) ||
        arms.length !== EXPECTED_ARMS.length ||
        !EXPECTED_ARMS.every((arm, index) => arms[index] === arm)
    ) {
        throw new Error(`${path} must pair exactly ${CONTROL_ARM} with candidate arm ${CANDIDATE_ARM}`);
    }
    if (!PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.includes(report.target as TargetEvidenceTarget)) {
        throw new Error(`${path} target must be one of ${PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.join(",")}`);
    }
    const target = report.target as TargetEvidenceTarget;
    const baseSeed = asSafeInteger(report.baseSeed, `${path}.baseSeed`);
    const startBoard = asSafeInteger(report.startBoard, `${path}.startBoard`);
    const boards = asSafeInteger(report.boards, `${path}.boards`, 1);
    const scannedBoards = asSafeInteger(report.scannedBoards, `${path}.scannedBoards`, boards);
    const maxLaps = asSafeInteger(report.maxLaps, `${path}.maxLaps`, 1);
    if (maxLaps !== 60) throw new Error(`${path} must use the preregistered 60-lap cap`);
    const maps = asArray(report.maps, `${path}.maps`);
    if (
        maps.length !== SETUP_LIVE_GRID_TYPES.length ||
        !SETUP_LIVE_GRID_TYPES.every((gridType, index) => maps[index] === gridType)
    ) {
        throw new Error(`${path} does not name the exact live-map panel`);
    }
    const boardLedger = asArray(report.boardLedger, `${path}.boardLedger`).map((board, index) =>
        parseBoard(board, `${path}.boardLedger[${index}]`),
    );
    if (boardLedger.length !== boards) throw new Error(`${path} board count does not match its ledger`);
    const expectedCollection = collectPublicRosterPlacementBoards(baseSeed, "guard", boards, target, startBoard);
    if (scannedBoards !== expectedCollection.scannedBoards) {
        throw new Error(`${path} scanned-board count does not match the reconstructed outcome-blind target scan`);
    }
    for (const [index, board] of boardLedger.entries()) {
        if (!sameBoard(board, expectedCollection.boards[index])) {
            throw new Error(`${path} board ledger does not match the reconstructed outcome-blind target scan`);
        }
    }
    const boardByIndex = new Map<number, IPublicRosterPlacementBoard>();
    const boardByPairSeed = new Map<number, IPublicRosterPlacementBoard>();
    for (const board of boardLedger) {
        if (boardByIndex.has(board.index) || boardByPairSeed.has(board.pairSeed)) {
            throw new Error(`${path} has a duplicate board identity`);
        }
        boardByIndex.set(board.index, board);
        boardByPairSeed.set(board.pairSeed, board);
    }

    const recordsByArm: Record<ReportArm, IPublicRosterPlacementRecord[]> = {
        [CONTROL_ARM]: [],
        [CANDIDATE_ARM]: [],
    };
    const seenClusters = new Set<string>();
    const clusters = asArray(report.clusters, `${path}.clusters`);
    if (clusters.length !== boards * EXPECTED_ARMS.length) {
        throw new Error(`${path} must contain one control and one candidate cluster per board`);
    }
    for (const [clusterIndex, value] of clusters.entries()) {
        const label = `${path}.clusters[${clusterIndex}]`;
        const cluster = asRecord(value, label);
        if (cluster.arm !== CONTROL_ARM && cluster.arm !== CANDIDATE_ARM) {
            throw new Error(`${label}.arm is not ${CONTROL_ARM}/${CANDIDATE_ARM}`);
        }
        const arm = cluster.arm as ReportArm;
        const clusterBoard = parseBoard(cluster.board, `${label}.board`);
        const ledgerBoard = boardByIndex.get(clusterBoard.index);
        if (!ledgerBoard || !sameBoard(clusterBoard, ledgerBoard)) {
            throw new Error(`${label}.board does not match the board ledger`);
        }
        const clusterKey = `${arm}/${clusterBoard.index}`;
        if (seenClusters.has(clusterKey)) throw new Error(`${path} has duplicate cluster ${clusterKey}`);
        seenClusters.add(clusterKey);
        const records = asArray(cluster.records, `${label}.records`);
        if (records.length !== 4) throw new Error(`${label} must contain the four crossover games`);
        const parsedRecords = records.map((record, game) =>
            parseRecord(record, arm, clusterBoard, maxLaps, `${label}.records[${game}]`),
        );
        if (new Set(parsedRecords.map((record) => record.game)).size !== 4) {
            throw new Error(`${label} must contain each crossover game exactly once`);
        }
        recordsByArm[arm].push(...parsedRecords);
    }
    for (const board of boardLedger) {
        for (const arm of EXPECTED_ARMS) {
            if (!seenClusters.has(`${arm}/${board.index}`)) {
                throw new Error(`${path} is missing ${arm} cluster for board ${board.index}`);
            }
        }
    }
    const expectedGames = boards * EXPECTED_ARMS.length * 4;
    if (report.games !== expectedGames) throw new Error(`${path}.games must equal ${expectedGames}`);
    return {
        target,
        sourceBytesSha256: sha256Bytes(bytes),
        sourceReportSha256,
        baseSeed,
        startBoard,
        boards,
        scannedBoards,
        maxLaps,
        maps: maps as SetupLiveGridType[],
        boardLedger,
        candidateRecords: recordsByArm[CANDIDATE_ARM],
        controlRecords: recordsByArm.control,
    };
}

function armSafety(records: readonly IPublicRosterPlacementRecord[]): IArmSafety {
    const draws = records.filter((record) => record.candidateResult === "draw").length;
    const armageddonDecided = records.filter((record) => record.decidedByArmageddon).length;
    const drawOrArmageddon = records.filter(
        (record) => record.candidateResult === "draw" || record.decidedByArmageddon,
    ).length;
    const totalLaps = records.reduce((sum, record) => sum + record.laps, 0);
    return {
        games: records.length,
        draws,
        drawRate: records.length ? draws / records.length : 0,
        armageddonDecided,
        armageddonRate: records.length ? armageddonDecided / records.length : 0,
        drawOrArmageddon,
        drawOrArmageddonRate: records.length ? drawOrArmageddon / records.length : 0,
        totalLaps,
        avgLaps: records.length ? totalLaps / records.length : 0,
        candidateRejections: records.reduce((sum, record) => sum + record.candidateRejections, 0),
        opposingRejections: records.reduce((sum, record) => sum + record.baselineRejections, 0),
    };
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

function summarizeTarget(report: ILoadedTargetReport) {
    const candidateByKey = new Map(
        report.candidateRecords.map((record) => [`${record.pairSeed}/${record.game}`, record]),
    );
    const controlByKey = new Map(report.controlRecords.map((record) => [`${record.pairSeed}/${record.game}`, record]));
    if (candidateByKey.size !== report.candidateRecords.length || controlByKey.size !== report.controlRecords.length) {
        throw new Error(`target ${report.target} contains duplicate candidate/control game keys`);
    }
    const selectedCandidate: IPublicRosterPlacementRecord[] = [];
    const selectedControl: IPublicRosterPlacementRecord[] = [];
    const selectionRows: Array<{
        pairSeed: number;
        game: number;
        pickSeat: IPublicRosterPlacementRecord["pickSeat"];
        candidateCreatureIds: number[];
        candidateTargets: PublicRosterPlacementTarget[];
    }> = [];
    let candidateLowerGames = 0;
    let candidateUpperGames = 0;
    let bothSeatsMatchedBoards = 0;
    for (const board of report.boardLedger) {
        const draft = publicRosterPlacementDraftEvidence(board);
        if (draft.pickSeed !== board.pickSeed) throw new Error(`target ${report.target} draft seed mismatch`);
        const lowerMatches = draft.lower.targets.includes(report.target);
        const upperMatches = draft.upper.targets.includes(report.target);
        if (!lowerMatches && !upperMatches) {
            throw new Error(
                `target ${report.target} board ${board.pairSeed} no longer matches either reconstructed roster`,
            );
        }
        bothSeatsMatchedBoards += Number(lowerMatches && upperMatches);
        for (const game of [0, 1, 2, 3] as const) {
            const key = `${board.pairSeed}/${game}`;
            const candidate = candidateByKey.get(key);
            const control = controlByKey.get(key);
            if (!candidate || !control) throw new Error(`target ${report.target} missing paired game ${key}`);
            validateArmPair(candidate, control, `target ${report.target} game ${key}`);
            const seat = candidate.pickSeat === "candidate-lower" ? draft.lower : draft.upper;
            const opponent = candidate.pickSeat === "candidate-lower" ? draft.upper : draft.lower;
            if (
                candidate.candidateCohort !== seat.cohort ||
                control.candidateCohort !== seat.cohort ||
                candidate.opponentCohort !== opponent.cohort ||
                control.opponentCohort !== opponent.cohort
            ) {
                throw new Error(`target ${report.target} cohort mismatch for reconstructed game ${key}`);
            }
            if (seat.cohort === "melee-other") {
                const placementEquivalent =
                    !candidate.actionable &&
                    candidate.candidateAction === control.candidateAction &&
                    candidate.candidateAction === candidate.incumbentAction &&
                    candidate.addedPublicCount === 0;
                const behaviorEquivalent =
                    candidate.behaviorTraceSha256 === control.behaviorTraceSha256 &&
                    candidate.candidateResult === control.candidateResult &&
                    candidate.laps === control.laps &&
                    candidate.endReason === control.endReason &&
                    candidate.decidedByArmageddon === control.decidedByArmageddon &&
                    candidate.candidateRejections === control.candidateRejections &&
                    candidate.baselineRejections === control.baselineRejections;
                if (!placementEquivalent || !behaviorEquivalent) {
                    throw new Error(`target ${report.target} melee-other game ${key} is not incumbent-equivalent`);
                }
            }
            if (!seat.targets.includes(report.target)) continue;
            selectedCandidate.push(candidate);
            selectedControl.push(control);
            candidateLowerGames += Number(candidate.pickSeat === "candidate-lower");
            candidateUpperGames += Number(candidate.pickSeat === "candidate-upper");
            selectionRows.push({
                pairSeed: board.pairSeed,
                game,
                pickSeat: candidate.pickSeat,
                candidateCreatureIds: seat.creatureIds,
                candidateTargets: seat.targets,
            });
        }
    }
    const delta = pairedPublicRosterPlacementDelta(selectedCandidate, selectedControl);
    const candidateSafety = armSafety(selectedCandidate);
    const controlSafety = armSafety(selectedControl);
    const allCandidateSafety = armSafety(report.candidateRecords);
    const allControlSafety = armSafety(report.controlRecords);
    return {
        target: report.target,
        sourceBytesSha256: report.sourceBytesSha256,
        sourceReportSha256: report.sourceReportSha256,
        sourceBoards: report.boards,
        scannedBoards: report.scannedBoards,
        selectedBoards: new Set(selectedCandidate.map((record) => record.pairSeed)).size,
        selectedGames: selectedCandidate.length,
        selectedCandidateLowerGames: candidateLowerGames,
        selectedCandidateUpperGames: candidateUpperGames,
        bothSeatsMatchedBoards,
        selectionSha256: sha256Json(selectionRows),
        matchedControlDelta: delta,
        allRecordRejections: {
            candidateArmCandidate: allCandidateSafety.candidateRejections,
            candidateArmOpponent: allCandidateSafety.opposingRejections,
            controlArmCandidate: allControlSafety.candidateRejections,
            controlArmOpponent: allControlSafety.opposingRejections,
        },
        safety: {
            candidate: candidateSafety,
            control: controlSafety,
            matchedExcess: {
                drawPp: (candidateSafety.drawRate - controlSafety.drawRate) * 100,
                armageddonPp: (candidateSafety.armageddonRate - controlSafety.armageddonRate) * 100,
                drawOrArmageddonPp: (candidateSafety.drawOrArmageddonRate - controlSafety.drawOrArmageddonRate) * 100,
                avgLaps: candidateSafety.avgLaps - controlSafety.avgLaps,
                candidateRejections: candidateSafety.candidateRejections - controlSafety.candidateRejections,
                opposingRejections: candidateSafety.opposingRejections - controlSafety.opposingRejections,
            },
        },
    };
}

type PublicRosterTargetSummary = ReturnType<typeof summarizeTarget>;

export function evaluatePublicRosterTargetGate(targets: readonly PublicRosterTargetSummary[]) {
    const checksByTarget = Object.fromEntries(
        PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.map((target) => {
            const summary = targets.find((entry) => entry.target === target);
            const delta = summary?.matchedControlDelta;
            const excess = summary?.safety.matchedExcess;
            const allRecordRejections = summary?.allRecordRejections;
            const checks = {
                present: summary !== undefined,
                exactSourceBoards: summary?.sourceBoards === PUBLIC_ROSTER_TARGET_GATE.requiredBoardsPerTarget,
                hasMatchedGames: (summary?.selectedGames ?? 0) > 0,
                pointEstimate: (delta?.scoreGainPp ?? -Infinity) >= PUBLIC_ROSTER_TARGET_GATE.minimumScoreGainPp,
                confidence:
                    (delta?.confidence95GainPp?.low ?? -Infinity) >
                    PUBLIC_ROSTER_TARGET_GATE.minimumConfidence95LowGainPpExclusive,
                zeroRejections:
                    (allRecordRejections?.candidateArmCandidate ?? Infinity) <=
                        PUBLIC_ROSTER_TARGET_GATE.maximumRejections &&
                    (allRecordRejections?.candidateArmOpponent ?? Infinity) <=
                        PUBLIC_ROSTER_TARGET_GATE.maximumRejections &&
                    (allRecordRejections?.controlArmCandidate ?? Infinity) <=
                        PUBLIC_ROSTER_TARGET_GATE.maximumRejections &&
                    (allRecordRejections?.controlArmOpponent ?? Infinity) <=
                        PUBLIC_ROSTER_TARGET_GATE.maximumRejections,
                drawSafety: (excess?.drawPp ?? Infinity) <= PUBLIC_ROSTER_TARGET_GATE.maximumDrawExcessPp,
                armageddonSafety:
                    (excess?.armageddonPp ?? Infinity) <= PUBLIC_ROSTER_TARGET_GATE.maximumArmageddonExcessPp,
                averageLapSafety: (excess?.avgLaps ?? Infinity) <= PUBLIC_ROSTER_TARGET_GATE.maximumAverageLapExcess,
            };
            return [target, checks];
        }),
    ) as Record<
        TargetEvidenceTarget,
        {
            present: boolean;
            exactSourceBoards: boolean;
            hasMatchedGames: boolean;
            pointEstimate: boolean;
            confidence: boolean;
            zeroRejections: boolean;
            drawSafety: boolean;
            armageddonSafety: boolean;
            averageLapSafety: boolean;
        }
    >;
    return {
        thresholds: PUBLIC_ROSTER_TARGET_GATE,
        checksByTarget,
        passed: PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.every((target) =>
            Object.values(checksByTarget[target]).every(Boolean),
        ),
    };
}

function loadTargetReportSet(paths: readonly string[]): ILoadedTargetReport[] {
    if (!paths.length) throw new Error("at least one raw target report path is required");
    const reports = paths.map(loadTargetReport);
    const seenTargets = new Set<TargetEvidenceTarget>();
    for (const report of reports) {
        if (seenTargets.has(report.target)) throw new Error(`duplicate raw target report for ${report.target}`);
        seenTargets.add(report.target);
    }
    const first = reports[0];
    for (const report of reports.slice(1)) {
        if (
            report.baseSeed !== first.baseSeed ||
            report.startBoard !== first.startBoard ||
            report.boards !== first.boards ||
            report.maxLaps !== first.maxLaps ||
            JSON.stringify(report.maps) !== JSON.stringify(first.maps)
        ) {
            throw new Error(`target ${report.target} does not share the same guard protocol as ${first.target}`);
        }
    }
    reports.sort(
        (left, right) =>
            PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.indexOf(left.target) -
            PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.indexOf(right.target),
    );
    return reports;
}

function buildSummary(
    reports: readonly ILoadedTargetReport[],
    status: "diagnostic_only_non_qualifying" | "derived_evidence_no_fights_rerun",
    sourceBinding: null | {
        sourceCommit: string;
        expectedBaseSeed: number;
        expectedStartBoard: number;
        provenance: "caller-attested; source commit is not embedded in raw reports";
    },
) {
    const first = reports[0];
    const seenTargets = new Set(reports.map((report) => report.target));
    const targets = reports.map(summarizeTarget);
    const promotionGate = evaluatePublicRosterTargetGate(targets);
    const withoutHash = {
        schemaVersion: PUBLIC_ROSTER_TARGET_EVIDENCE_SCHEMA_VERSION,
        status,
        sourceBinding,
        draftReconstruction: "ranked pick only; candidate roster selected by actual pick seat",
        setupDiagnosticSemantics: "inclusive tags; melee-other is the exact fallback cohort",
        control: { setupSpec: V07_NONFIGHT_SETUP_SPEC, arm: CONTROL_ARM },
        candidate: {
            setupSpec: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
            behaviorSha256: V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
            placementPolicy: COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
            arm: CANDIDATE_ARM,
        },
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        panel: "guard",
        baseSeed: first.baseSeed,
        startBoard: first.startBoard,
        boardsPerTarget: first.boards,
        maxLaps: first.maxLaps,
        maps: first.maps,
        completeTargetSet: PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.every((target) => seenTargets.has(target)),
        targets,
        promotionGate,
    };
    return { ...withoutHash, summarySha256: sha256Json(withoutHash) };
}

/** Partial report reducer for debugging only. Its status is always explicitly non-qualifying. */
export function summarizePublicRosterTargetDiagnostics(paths: readonly string[]) {
    return buildSummary(loadTargetReportSet(paths), "diagnostic_only_non_qualifying", null);
}

/** Complete frozen target evidence. Source provenance is caller-attested because raw reports omit it. */
export function summarizePublicRosterTargetEvidence(
    paths: readonly string[],
    sourceCommit: string,
    expectedBaseSeed: number,
    expectedStartBoard: number = 0,
) {
    if (!HEX_COMMIT.test(sourceCommit)) {
        throw new Error("source commit must be exactly 40 lowercase hexadecimal characters");
    }
    asSafeInteger(expectedBaseSeed, "expected base seed");
    asSafeInteger(expectedStartBoard, "expected start board");
    const reports = loadTargetReportSet(paths);
    if (
        reports.length !== PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.length ||
        !PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.every((target) => reports.some((report) => report.target === target))
    ) {
        throw new Error(
            `promotion evidence requires all five targets: ${PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.join(",")}`,
        );
    }
    if (reports.some((report) => report.baseSeed !== expectedBaseSeed)) {
        throw new Error(`promotion evidence requires caller-attested base seed ${expectedBaseSeed}`);
    }
    if (reports.some((report) => report.startBoard !== expectedStartBoard)) {
        throw new Error(`promotion evidence requires caller-attested start board ${expectedStartBoard}`);
    }
    if (reports.some((report) => report.boards !== PUBLIC_ROSTER_TARGET_GATE.requiredBoardsPerTarget)) {
        throw new Error(
            `promotion evidence requires exactly ${PUBLIC_ROSTER_TARGET_GATE.requiredBoardsPerTarget} accepted boards per target`,
        );
    }
    return buildSummary(reports, "derived_evidence_no_fights_rerun", {
        sourceCommit,
        expectedBaseSeed,
        expectedStartBoard,
        provenance: "caller-attested; source commit is not embedded in raw reports",
    });
}

export function main(): void {
    const { positionals, values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            "expected-base-seed": { type: "string" },
            "expected-start-board": { type: "string" },
            "source-commit": { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: true,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/summarize_public_roster_target_evidence.ts " +
                "--source-commit <40-hex> --expected-base-seed <integer> --expected-start-board <integer> " +
                "<five raw target reports>",
        );
        return;
    }
    if (!values["source-commit"]) throw new Error("--source-commit is required");
    if (!values["expected-base-seed"]) throw new Error("--expected-base-seed is required");
    if (!values["expected-start-board"]) throw new Error("--expected-start-board is required");
    const expectedBaseSeed = Number(values["expected-base-seed"]);
    console.log(
        JSON.stringify(
            summarizePublicRosterTargetEvidence(
                positionals,
                values["source-commit"],
                expectedBaseSeed,
                Number(values["expected-start-board"]),
            ),
            null,
            2,
        ),
    );
}

if ((import.meta as unknown as { main?: boolean }).main) main();
