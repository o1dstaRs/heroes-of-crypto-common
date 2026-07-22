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
    collectPublicRosterPlacementBoards,
    publicRosterPlacementDraftEvidence,
    PUBLIC_ROSTER_COHORT_SAFE_ARM,
    type IPublicRosterPlacementBoard,
    type IPublicRosterPlacementRecord,
    type PublicRosterPlacementTarget,
} from "../../src/simulation/measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES } from "../../src/simulation/optimizer/v0_7_setup_overnight_core";
import {
    evaluatePublicRosterTargetGate,
    PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS,
    summarizePublicRosterTargetDiagnostics,
    summarizePublicRosterTargetEvidence,
} from "../../src/simulation/summarize_public_roster_target_evidence";

const TEST_BASE_SEED = 232221694;
const TEST_SOURCE_COMMIT = "3585b7c07e1249ee6d671f9e9f397af72e090804";
const temporaryDirectories: string[] = [];
const CANDIDATE_ARM = PUBLIC_ROSTER_COHORT_SAFE_ARM;
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
    arm: "control" | typeof CANDIDATE_ARM,
    board: IPublicRosterPlacementBoard,
    game: 0 | 1 | 2 | 3,
    target: Exclude<PublicRosterPlacementTarget, "natural">,
): IPublicRosterPlacementRecord {
    const draft = publicRosterPlacementDraftEvidence(board);
    const pickedLower = game < 2;
    const seat = pickedLower ? draft.lower : draft.upper;
    const opponent = pickedLower ? draft.upper : draft.lower;
    const selected = seat.targets.includes(target);
    const secondMirror = game % 2 === 1;
    const treated = arm === CANDIDATE_ARM && seat.cohort !== "melee-other";
    const candidateResult = selected
        ? treated
            ? secondMirror
                ? "draw"
                : "win"
            : secondMirror
              ? "win"
              : "loss"
        : "loss";
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
        candidateAction: treated && selected ? "corner-shift" : "unchanged",
        actionable: treated && selected,
        legitimateRevealCount: 0,
        addedPublicCount: treated ? 1 : 0,
        candidateRejections: 0,
        baselineRejections: 0,
        laps: selected ? (treated ? (secondMirror ? 7 : 5) : secondMirror ? 6 : 4) : 3,
        endReason: candidateResult === "draw" ? "turn_cap" : "elimination",
        decidedByArmageddon: treated && selected && secondMirror,
        setupFingerprint: sha256(`setup/${arm}/${board.pairSeed}/${game}`),
        behaviorTraceSha256: sha256(`trace/${treated ? CANDIDATE_ARM : "control"}/${board.pairSeed}/${game}`),
    };
}

function writeFixture(target: Exclude<PublicRosterPlacementTarget, "natural"> = "ranged"): string {
    const directory = mkdtempSync(join(tmpdir(), "public-roster-target-evidence-"));
    temporaryDirectories.push(directory);
    const path = join(directory, `${target}.json`);
    const collected = collectPublicRosterPlacementBoards(TEST_BASE_SEED, "guard", 1, target);
    const board = collected.boards[0];
    const cluster = (arm: "control" | typeof CANDIDATE_ARM) => ({
        arm,
        board,
        records: ([0, 1, 2, 3] as const).map((game) => fixtureRecord(arm, board, game, target)),
    });
    const report = sealReport({
        schemaVersion: 1,
        status: "research_only_no_bake",
        question: "public final roster placement vs shipped legitimate pick reveals",
        setupSpec: V07_NONFIGHT_SETUP_SPEC,
        cohortSafeSetupSpec: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
        cohortSafeBehaviorSha256: V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        arms: ["control", CANDIDATE_ARM],
        startBoard: 0,
        panel: "guard",
        target,
        baseSeed: TEST_BASE_SEED,
        boards: 1,
        scannedBoards: collected.scannedBoards,
        games: 8,
        maxLaps: 60,
        maps: SETUP_LIVE_GRID_TYPES,
        wallSeconds: 1,
        summaries: {},
        comparisons: {},
        boardLedger: [board],
        clusters: [cluster("control"), cluster(CANDIDATE_ARM)],
    });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
}

function mutateFixture(
    path: string,
    name: string,
    mutate: (report: Record<string, unknown>) => void,
    reseal = true,
): string {
    const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    mutate(report);
    const mutated = reseal ? sealReport(report) : report;
    const output = join(join(path, ".."), name);
    writeFileSync(output, `${JSON.stringify(mutated, null, 2)}\n`);
    return output;
}

describe("public-roster target evidence summarizer", () => {
    test("selects only the reconstructed matching candidate seat and computes exact paired safety", () => {
        const path = writeFixture();
        const first = summarizePublicRosterTargetDiagnostics([path]);
        const replay = summarizePublicRosterTargetDiagnostics([path]);

        expect(replay).toEqual(first);
        expect(first.status).toBe("diagnostic_only_non_qualifying");
        expect(first.sourceBinding).toBeNull();
        expect(first.completeTargetSet).toBe(false);
        expect(first.targets).toHaveLength(1);
        const target = first.targets[0];
        expect(target.target).toBe("ranged");
        expect(target.sourceBoards).toBe(1);
        expect(target.selectedBoards).toBe(1);
        expect(target.selectedGames).toBe(2);
        expect(target.selectedCandidateLowerGames + target.selectedCandidateUpperGames).toBe(2);
        expect([target.selectedCandidateLowerGames, target.selectedCandidateUpperGames].sort()).toEqual([0, 2]);
        expect(target.matchedControlDelta).toMatchObject({
            boards: 1,
            games: 2,
            scoreGainPp: 25,
            outcomeChanges: 2,
        });
        expect(target.safety.candidate).toMatchObject({
            games: 2,
            draws: 1,
            armageddonDecided: 1,
            drawOrArmageddon: 1,
            avgLaps: 6,
            candidateRejections: 0,
        });
        expect(target.safety.control).toMatchObject({
            games: 2,
            draws: 0,
            armageddonDecided: 0,
            avgLaps: 5,
            candidateRejections: 0,
        });
        expect(target.safety.matchedExcess).toMatchObject({
            drawPp: 50,
            armageddonPp: 50,
            drawOrArmageddonPp: 50,
            avgLaps: 1,
            candidateRejections: 0,
        });
        const { summarySha256, ...withoutHash } = first;
        expect(summarySha256).toBe(sha256(withoutHash));
    });

    test("requires the complete target set and binds it to the caller-attested replacement source", () => {
        const paths = PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS.map((target) => writeFixture(target));
        expect(() =>
            summarizePublicRosterTargetEvidence(paths.slice(0, -1), TEST_SOURCE_COMMIT, TEST_BASE_SEED),
        ).toThrow("promotion evidence requires all five targets");
        expect(() => summarizePublicRosterTargetEvidence(paths, "not-a-commit", TEST_BASE_SEED)).toThrow(
            "source commit must be exactly 40 lowercase hexadecimal characters",
        );
        expect(() => summarizePublicRosterTargetEvidence(paths, TEST_SOURCE_COMMIT, 1.5)).toThrow(
            "expected base seed must be a safe integer",
        );
        expect(() => summarizePublicRosterTargetEvidence(paths, TEST_SOURCE_COMMIT, TEST_BASE_SEED + 1)).toThrow(
            `promotion evidence requires caller-attested base seed ${TEST_BASE_SEED + 1}`,
        );
        const wrongBasePaths = paths.map((path, index) =>
            mutateFixture(path, `wrong-base-${index}.json`, (report) => {
                report.baseSeed = TEST_BASE_SEED + 1;
            }),
        );
        expect(() => summarizePublicRosterTargetEvidence(wrongBasePaths, TEST_SOURCE_COMMIT, TEST_BASE_SEED)).toThrow(
            "does not match the reconstructed outcome-blind target scan",
        );

        expect(() =>
            summarizePublicRosterTargetEvidence([...paths].reverse(), TEST_SOURCE_COMMIT, TEST_BASE_SEED),
        ).toThrow("requires exactly 1000 accepted boards per target");

        const summary = summarizePublicRosterTargetDiagnostics([...paths].reverse());
        expect(summary.status).toBe("diagnostic_only_non_qualifying");
        expect(summary.completeTargetSet).toBe(true);
        expect(summary.baseSeed).toBe(TEST_BASE_SEED);
        expect(summary.sourceBinding).toBeNull();
        expect(summary.targets.map(({ target }) => target)).toEqual(PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS);

        const passingTargets = structuredClone(summary.targets);
        for (const target of passingTargets) {
            target.sourceBoards = 1_000;
            target.matchedControlDelta.scoreGainPp = 0;
            target.matchedControlDelta.confidence95GainPp = { low: -1.499_999, high: 1 };
            target.safety.candidate.candidateRejections = 0;
            target.safety.candidate.opposingRejections = 0;
            target.safety.control.candidateRejections = 0;
            target.safety.control.opposingRejections = 0;
            target.safety.matchedExcess.drawPp = 1;
            target.safety.matchedExcess.armageddonPp = 1;
            target.safety.matchedExcess.avgLaps = 1;
        }
        expect(evaluatePublicRosterTargetGate(passingTargets).passed).toBe(true);
        passingTargets[0].matchedControlDelta.confidence95GainPp!.low = -1.5;
        expect(evaluatePublicRosterTargetGate(passingTargets).checksByTarget.ranged.confidence).toBe(false);
        passingTargets[0].matchedControlDelta.confidence95GainPp!.low = -1.499_999;
        passingTargets[0].safety.matchedExcess.drawPp = 1.000_001;
        expect(evaluatePublicRosterTargetGate(passingTargets).checksByTarget.ranged.drawSafety).toBe(false);
    });

    test("fails closed on raw hash, guard/spec/arm, and reconstructed control-pair tampering", () => {
        const path = writeFixture();
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(
                    path,
                    "raw-hash.json",
                    (report) => {
                        report.wallSeconds = 2;
                    },
                    false,
                ),
            ]),
        ).toThrow("self-hash mismatch");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "panel.json", (report) => {
                    report.panel = "selection";
                }),
            ]),
        ).toThrow("not a guard-panel report");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "spec.json", (report) => {
                    report.setupSpec = "setup-v0";
                }),
            ]),
        ).toThrow("expected v07-nonfight-4eda84635fe7");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "cohort-safe-artifact.json", (report) => {
                    report.cohortSafeSetupSpec = "v07-nonfight-unknown";
                }),
            ]),
        ).toThrow("does not bind the frozen cohort-safe placement artifact");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "arms.json", (report) => {
                    report.arms = ["both", "control"];
                }),
            ]),
        ).toThrow(`must pair exactly control with candidate arm ${CANDIDATE_ARM}`);
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "lap-cap.json", (report) => {
                    report.maxLaps = 59;
                }),
            ]),
        ).toThrow("must use the preregistered 60-lap cap");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "base-seed.json", (report) => {
                    report.baseSeed = TEST_BASE_SEED + 1;
                }),
            ]),
        ).toThrow("does not match the reconstructed outcome-blind target scan");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "pairing.json", (report) => {
                    const clusters = report.clusters as Array<{ arm: string; records: Array<Record<string, unknown>> }>;
                    const control = clusters.find((cluster) => cluster.arm === "control")!;
                    control.records[0].candidateCohort =
                        control.records[0].candidateCohort === "mage" ? "melee-other" : "mage";
                }),
            ]),
        ).toThrow("candidate/control metadata mismatch");

        const rejectedOffSlice = mutateFixture(path, "off-slice-rejection.json", (report) => {
            const clusters = report.clusters as Array<{ arm: string; records: Array<Record<string, unknown>> }>;
            const candidate = clusters.find((cluster) => cluster.arm === CANDIDATE_ARM)!;
            const offSlice = candidate.records.find((record) => record.actionable === false)!;
            offSlice.candidateRejections = 1;
        });
        const rejectedSummary = summarizePublicRosterTargetDiagnostics([rejectedOffSlice]);
        expect(rejectedSummary.targets[0].allRecordRejections.candidateArmCandidate).toBe(1);
        expect(rejectedSummary.promotionGate.checksByTarget.ranged.zeroRejections).toBe(false);
    });
});
