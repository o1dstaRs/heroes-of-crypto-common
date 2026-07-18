import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../../src/ai/setup/draft_ship";
import { V07_NONFIGHT_SETUP_SPEC } from "../../src/ai/setup/setup_ship";
import {
    publicRosterPlacementBoard,
    publicRosterPlacementDraftEvidence,
    type IPublicRosterPlacementBoard,
    type IPublicRosterPlacementRecord,
    type PublicRosterPlacementTarget,
} from "../../src/simulation/measure_public_roster_placement";
import { SETUP_LIVE_GRID_TYPES } from "../../src/simulation/optimizer/v0_7_setup_overnight_core";
import {
    PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS,
    summarizePublicRosterTargetDiagnostics,
    summarizePublicRosterTargetEvidence,
} from "../../src/simulation/summarize_public_roster_target_evidence";

const TEST_BASE_SEED = 232221694;
const TEST_SOURCE_COMMIT = "3585b7c07e1249ee6d671f9e9f397af72e090804";
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

function singleSeatBoard(target: Exclude<PublicRosterPlacementTarget, "natural">): IPublicRosterPlacementBoard {
    for (let index = 0; index < 5_000; index += 1) {
        const board = publicRosterPlacementBoard(TEST_BASE_SEED, "guard", index);
        const draft = publicRosterPlacementDraftEvidence(board);
        const matches = Number(draft.lower.targets.includes(target)) + Number(draft.upper.targets.includes(target));
        if (matches === 1) return board;
    }
    throw new Error(`could not find a single-seat ${target} fixture board`);
}

function fixtureRecord(
    arm: "control" | "both",
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
    const candidateResult = selected
        ? arm === "both"
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
        candidateAction: arm === "both" ? "corner-shift" : "unchanged",
        actionable: arm === "both" && selected,
        legitimateRevealCount: 0,
        addedPublicCount: arm === "both" ? 1 : 0,
        candidateRejections: 0,
        baselineRejections: 0,
        laps: selected ? (arm === "both" ? (secondMirror ? 7 : 5) : secondMirror ? 6 : 4) : 3,
        endReason: candidateResult === "draw" ? "turn_cap" : "elimination",
        decidedByArmageddon: arm === "both" && selected && secondMirror,
        setupFingerprint: sha256(`setup/${arm}/${board.pairSeed}/${game}`),
        behaviorTraceSha256: sha256(`trace/${arm}/${board.pairSeed}/${game}`),
    };
}

function writeFixture(target: Exclude<PublicRosterPlacementTarget, "natural"> = "ranged"): string {
    const directory = mkdtempSync(join(tmpdir(), "public-roster-target-evidence-"));
    temporaryDirectories.push(directory);
    const path = join(directory, `${target}.json`);
    const board = singleSeatBoard(target);
    const cluster = (arm: "control" | "both") => ({
        arm,
        board,
        records: ([0, 1, 2, 3] as const).map((game) => fixtureRecord(arm, board, game, target)),
    });
    const report = sealReport({
        schemaVersion: 1,
        status: "research_only_no_bake",
        question: "public final roster placement vs shipped legitimate pick reveals",
        setupSpec: V07_NONFIGHT_SETUP_SPEC,
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        arms: ["control", "both"],
        panel: "guard",
        target,
        baseSeed: TEST_BASE_SEED,
        boards: 1,
        scannedBoards: 1,
        games: 8,
        maxLaps: 60,
        maps: SETUP_LIVE_GRID_TYPES,
        wallSeconds: 1,
        summaries: {},
        comparisons: {},
        boardLedger: [board],
        clusters: [cluster("control"), cluster("both")],
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
        const wrongBasePaths = paths.map((path, index) =>
            mutateFixture(path, `wrong-base-${index}.json`, (report) => {
                report.baseSeed = TEST_BASE_SEED + 1;
            }),
        );
        expect(() => summarizePublicRosterTargetEvidence(wrongBasePaths, TEST_SOURCE_COMMIT, TEST_BASE_SEED)).toThrow(
            `promotion evidence requires caller-attested base seed ${TEST_BASE_SEED}`,
        );

        const summary = summarizePublicRosterTargetEvidence([...paths].reverse(), TEST_SOURCE_COMMIT, TEST_BASE_SEED);
        expect(summary.status).toBe("derived_evidence_no_fights_rerun");
        expect(summary.completeTargetSet).toBe(true);
        expect(summary.baseSeed).toBe(TEST_BASE_SEED);
        expect(summary.sourceBinding).toEqual({
            sourceCommit: TEST_SOURCE_COMMIT,
            expectedBaseSeed: TEST_BASE_SEED,
            provenance: "caller-attested; source commit is not embedded in raw reports",
        });
        expect(summary.targets.map(({ target }) => target)).toEqual(PUBLIC_ROSTER_TARGET_EVIDENCE_TARGETS);
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
                mutateFixture(path, "arms.json", (report) => {
                    report.arms = ["both", "control"];
                }),
            ]),
        ).toThrow("must pair exactly control with candidate arm both");
        expect(() =>
            summarizePublicRosterTargetDiagnostics([
                mutateFixture(path, "pairing.json", (report) => {
                    const clusters = report.clusters as Array<{ arm: string; records: Array<Record<string, unknown>> }>;
                    const control = clusters.find((cluster) => cluster.arm === "control")!;
                    control.records[0].candidateCohort =
                        control.records[0].candidateCohort === "mage" ? "melee-other" : "mage";
                }),
            ]),
        ).toThrow("cohort mismatch for reconstructed game");
    });
});
