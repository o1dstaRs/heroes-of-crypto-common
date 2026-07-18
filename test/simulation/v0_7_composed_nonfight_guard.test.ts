import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    LEAGUE_ROUND1_DRAFT_SPEC,
    LEAGUE_ROUND3_DRAFT_SPEC,
    parseDraftGenome,
    projectDraftGenomeForShipping,
} from "../../src/ai/setup/draft_ship";
import { parseConditionalRules } from "../../src/ai/setup/setup_conditional";
import { runRankedConditionalPickGame } from "../../src/simulation/measure_setup_conditional";
import {
    permuteRankedDraftSeed,
    rankedDraftBehaviorTraceSetSha256,
    RANKED_DRAFT_COHORT_DEFINITIONS,
    RANKED_DRAFT_CURRENT_INCUMBENT_ID,
    RANKED_DRAFT_LIVE_MAP_TYPES,
    type IRankedDraftEvaluationReport,
    type IRankedDraftGameRecord,
    type RankedDraftCohort,
} from "../../src/simulation/ranked_draft_eval";
import {
    buildV07ComposedSeedLedger,
    buildOrResumeV07ComposedSeedLedger,
    captureV07ComposedRuntimeEnvelope,
    acquireV07ComposedOutputLock,
    estimateV07ComposedRecords,
    evaluateV07ComposedBoardsInSealedWorkers,
    evaluateV07ComposedCluster,
    parseV07ComposedGuardOptions,
    prepareV07ComposedMatch,
    releaseV07ComposedOutputLock,
    sanitizedV07ComposedWorkerEnvironment,
    assertV07ComposedRuntimeInjectionAbsent,
    v07ComposedDrawOrArmageddonPassed,
    v07ComposedLockOwnerCanBeReclaimed,
    v07ComposedNamedCoveragePassed,
    v07ComposedNamedDecisiveGamesPassed,
    v07ComposedNamedGamesPassed,
    assertV07ComposedGuardDescendantPaths,
    validateV07ComposedCampaignInputs,
    loadV07ComposedDraftCandidate,
    loadV07ComposedSetupCandidate,
    validateV07ComposedClusters,
    validateV07ComposedSeedLedger,
    V07_COMPOSED_NONFIGHT_COHORTS,
    V07_COMPOSED_NONFIGHT_SEED_RANGES,
    type IV07ComposedArm,
} from "../../src/simulation/optimizer/v0_7_composed_nonfight_guard";
import { fingerprintV07NonfightCampaign } from "../../src/simulation/optimizer/v0_7_nonfight_campaign_core";
import {
    createRankedDraftCandidateGenome,
    evaluateRankedDraftGuard,
    evaluateRankedDraftTargetedGuard,
    fingerprintRankedDraftArtifact,
} from "../../src/simulation/optimizer/ranked_draft_cem_core";
import {
    cloneNonFightPolicy,
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    pairedSetupEstimate,
    SETUP_COHORTS,
    SETUP_GUARD_THRESHOLDS,
    SETUP_LIVE_GRID_TYPES,
    SETUP_NAMED_GUARD_TAGS,
    setupLiveGridType,
    shippedNonFightPolicy,
} from "../../src/simulation/optimizer/v0_7_setup_overnight_core";

const temporaryDirectories: string[] = [];

afterEach(() => {
    while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "v07-composed-nonfight-"));
    temporaryDirectories.push(directory);
    return directory;
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonSha256(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function signedCampaign<T extends Record<string, unknown>, K extends string>(value: T, key: K): T & Record<K, string> {
    return { ...value, [key]: fingerprintV07NonfightCampaign(value) } as T & Record<K, string>;
}

function controlArm(id = "old-control"): IV07ComposedArm {
    return {
        id,
        genome: projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC)),
        policy: shippedNonFightPolicy(id),
    };
}

function rankedDraftGuardReport(candidateId: string, candidate: boolean): IRankedDraftEvaluationReport {
    const games = 8_000;
    const wins = candidate ? 4_400 : 4_000;
    const mapGames = [2_668, 2_668, 2_664];
    const mapWins = candidate ? [1_468, 1_468, 1_464] : [1_334, 1_334, 1_332];
    const summary = (ownWins: number, ownGames: number, low: number) => ({
        games: ownGames,
        offerBoards: ownGames / 4,
        wins: ownWins,
        losses: ownGames - ownWins,
        draws: 0,
        decisiveGames: ownGames,
        decisiveWinRate: ownWins / ownGames,
        confidence95: { low, high: 0.58 },
        clusteredLowerBound: low,
        drawOrArmageddonRate: 0,
        rejectedCandidate: 0,
        rejectedOpponent: 0,
        avgLaps: 10,
        endReasons: { elimination: ownGames, turn_cap: 0, stuck: 0 },
    });
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidateId,
        totalGames: games,
        options: {
            gamesPerOpponent: games,
            baseSeed: 0xc000_0000,
            concurrency: 6,
            fightVersion: "v0.7",
            maxLaps: 60,
            mapTypes: [...RANKED_DRAFT_LIVE_MAP_TYPES],
            setupRules: "all",
            draftDimensions: { offset: 0, length: 15 },
            clusterSize: 4,
            seedAllocation: "indexed-bijective-v1",
            seedChannelsPerBoard: 3,
            commonBattleSeed: true,
            behaviorTrace: "canonical-sha256-v1",
            executedActionsRecorded: true,
        },
        opponents: [
            {
                opponentId: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
                ...summary(wins, games, candidate ? 0.52 : 0.48),
            },
        ],
        maps: RANKED_DRAFT_LIVE_MAP_TYPES.map((mapType, index) => ({
            mapType,
            ...summary(mapWins[index], mapGames[index], candidate ? 0.5 : 0.48),
        })),
        cohortDefinitions: { ...RANKED_DRAFT_COHORT_DEFINITIONS },
        cohorts: (["ranged", "mage", "melee_magic", "aura_heavy"] as const).map((cohort) => ({
            cohort,
            games: 2_000,
            wins: candidate ? 1_100 : 1_000,
            losses: candidate ? 900 : 1_000,
            draws: 0,
            decisiveGames: 2_000,
            decisiveWinRate: candidate ? 0.55 : 0.5,
            confidence95: { low: candidate ? 0.5 : 0.48, high: 0.58 },
        })),
        aggregate: {
            fitness: candidate ? 0.52 : 0.5,
            worstCaseLowerBound: candidate ? 0.52 : 0.5,
            worstCaseOpponent: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
            rejectedCandidate: 0,
            rejectedOpponent: 0,
            drawOrArmageddonRate: 0,
            avgLaps: 10,
            endReasons: { elimination: games, turn_cap: 0, stuck: 0 },
            behaviorTraceSetSha256: (candidate ? "a" : "b").repeat(64),
        },
        qualification: "semantic composed guard fixture",
    };
}

function requiredCli(output: string): string[] {
    const sha = "a".repeat(64);
    return [
        "--out",
        output,
        "--campaign-run",
        join(output, "campaign", "run.json"),
        "--campaign-terminal",
        join(output, "campaign", "TERMINAL.json"),
        "--campaign-run-sha256",
        sha,
        "--campaign-terminal-sha256",
        sha,
        "--campaign-config-sha256",
        sha,
        "--campaign-provenance-sha256",
        sha,
        "--campaign-source-commit",
        "b".repeat(40),
        "--guard-source-commit",
        "c".repeat(40),
        "--draft-verdict",
        join(output, "draft", "guard", "verdict.json"),
        "--draft-verdict-sha256",
        sha,
        "--draft-run-fingerprint",
        sha,
        "--setup-final",
        join(output, "setup", "final.json"),
        "--setup-final-sha256",
        sha,
        "--setup-checkpoint-sha256",
        sha,
        "--deadline-ms",
        String(Date.now() + 60 * 60 * 1_000),
        "--run-id",
        "strict-cli-test",
    ];
}

function validArtifacts(runId: string) {
    const directory = temporaryDirectory();
    const candidateId = "draft-final-test";
    const incumbent = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
    const intrinsic = incumbent.weights.slice(0, 15);
    const candidate = createRankedDraftCandidateGenome(candidateId, intrinsic);
    const candidateFingerprint = fingerprintRankedDraftArtifact({
        schemaVersion: candidate.schemaVersion,
        weights: candidate.weights,
    });
    const draft = {
        schemaVersion: 1,
        status: "research_only_no_bake",
        runFingerprint: "d".repeat(64),
        runId,
        eligibleForManualReview: true,
        checks: {
            naturalGuardPassed: true,
            targetedCohortGuardPassed: true,
            deterministicReplayByteIdentical: true,
            deterministicReplayBehaviorTraceIdentical: true,
        },
        candidate: { candidateId, candidateFingerprint, intrinsic },
    };
    const setup = {
        schemaVersion: 3,
        status: "measurement_only",
        autoBaked: false,
        campaignPhase: "complete",
        runId,
        policy: shippedNonFightPolicy("setup-final-test"),
        decision: {
            promotable: true,
            currentGuardComplete: true,
            controlSymmetryPassed: true,
            byteIdenticalReplay: true,
        },
    };
    const draftPath = join(directory, "verdict.json");
    const setupPath = join(directory, "final.json");
    writeJson(draftPath, draft);
    writeJson(setupPath, setup);
    return { draft, setup, draftPath, setupPath, candidateFingerprint };
}

describe("ranked conditional dual-genome compatibility", () => {
    test("retains the positional genome default while allowing independent lower and upper policies", () => {
        const rules = parseConditionalRules("all");
        const round1 = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
        const round3 = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND3_DRAFT_SPEC));
        const historical = runRankedConditionalPickGame(1, rules, round1);
        const explicitDefault = runRankedConditionalPickGame(1, rules, round1, {
            lowerGenome: round1,
            upperGenome: round1,
        });
        expect(explicitDefault).toEqual(historical);

        const mixed = runRankedConditionalPickGame(1, rules, round1, {
            lowerGenome: round3,
            upperGenome: round1,
        });
        expect(mixed.lower.creatureIds).not.toEqual(historical.lower.creatureIds);
        expect(mixed.lower.creatureIds).toEqual([22, 36, 23, 26, 38, 40]);
    });
});

describe("v0.7 composed non-fight guard inputs", () => {
    test("loads only passing final artifacts and reconstructs the exact draft fingerprint", () => {
        const runId = "composed-input-test";
        const fixture = validArtifacts(runId);
        const draft = loadV07ComposedDraftCandidate(fixture.draftPath, runId);
        const setup = loadV07ComposedSetupCandidate(fixture.setupPath, runId);
        expect(draft.candidateFingerprint).toBe(fixture.candidateFingerprint);
        expect(draft.intrinsic).toHaveLength(15);
        expect(setup.policy).toEqual(fixture.setup.policy);
        expect(setup.policy.placementAugmentTiming).toBe("setup-before-placement");
    });

    test("accepts public-roster as an explicit completed setup candidate", () => {
        const runId = "composed-public-roster-input-test";
        const fixture = validArtifacts(runId);
        writeJson(fixture.setupPath, {
            ...fixture.setup,
            policy: { ...fixture.setup.policy, placement: "public-roster" },
        });

        expect(loadV07ComposedSetupCandidate(fixture.setupPath, runId).policy.placement).toBe("public-roster");
    });

    test("accepts the frozen cohort-safe placement candidate without changing its other setup behavior", () => {
        const runId = "composed-cohort-safe-input-test";
        const fixture = validArtifacts(runId);
        writeJson(fixture.setupPath, {
            ...fixture.setup,
            policy: { ...fixture.setup.policy, placement: COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT },
        });

        const loaded = loadV07ComposedSetupCandidate(fixture.setupPath, runId).policy;
        expect(loaded).toEqual({ ...fixture.setup.policy, placement: COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT });
    });

    test("fails closed on a reconstructed draft mismatch and a setup auto-bake marker", () => {
        const runId = "composed-rejection-test";
        const fixture = validArtifacts(runId);
        writeJson(fixture.draftPath, {
            ...fixture.draft,
            candidate: { ...fixture.draft.candidate, candidateFingerprint: "0".repeat(64) },
        });
        expect(() => loadV07ComposedDraftCandidate(fixture.draftPath, runId)).toThrow("does not match reconstructed");
        writeJson(fixture.setupPath, { ...fixture.setup, autoBaked: true });
        expect(() => loadV07ComposedSetupCandidate(fixture.setupPath, runId)).toThrow("autoBaked");
    });

    test("accepts only a signed completed campaign graph and catches post-terminal candidate mutation", () => {
        const root = temporaryDirectory();
        const campaignOutput = join(root, "campaign");
        const draftOutput = join(campaignOutput, "lanes", "draft", "output");
        const setupOutput = join(campaignOutput, "lanes", "setup", "output");
        const campaignRepositoryRoot = join(root, "campaign-source");
        const composedOutput = join(root, "composed");
        for (const directory of [
            draftOutput,
            setupOutput,
            composedOutput,
            join(draftOutput, "guard", "replay"),
            join(draftOutput, "guard", "cohorts"),
            campaignRepositoryRoot,
        ]) {
            mkdirSync(directory, { recursive: true });
        }
        const runId = "strict-cli-test";
        const commit = "b".repeat(40);
        const incumbentGenome = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
        const incumbentFingerprint = fingerprintRankedDraftArtifact({
            schemaVersion: incumbentGenome.schemaVersion,
            weights: incumbentGenome.weights,
        });
        const intrinsic = incumbentGenome.weights.slice(0, 15);
        const candidateGenome = createRankedDraftCandidateGenome("signed-final", intrinsic);
        const candidateFingerprint = fingerprintRankedDraftArtifact({
            schemaVersion: candidateGenome.schemaVersion,
            weights: candidateGenome.weights,
        });
        const draftRunUnsigned = {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runId,
            code: { revision: commit, originMain: commit, branch: "main", sourceFingerprint: "3".repeat(64) },
            options: {
                guardGamesPerOpponent: 8_000,
                cohortBoardsPerOpponent: 625,
                cohortScanMaxBoards: 1_000_000,
                replayGamesPerOpponent: 8,
                maxLaps: 60,
            },
        };
        const draftRunFingerprint = fingerprintRankedDraftArtifact(draftRunUnsigned);
        const draftRun = { ...draftRunUnsigned, runFingerprint: draftRunFingerprint };
        writeJson(join(draftOutput, "run.json"), draftRun);
        writeJson(join(draftOutput, "state.json"), {
            schemaVersion: 1,
            status: "complete",
            runFingerprint: draftRunFingerprint,
            best: { candidateId: "signed-final", candidateFingerprint, intrinsic },
        });
        const candidateEvaluation = rankedDraftGuardReport("signed-final", true);
        const incumbentEvaluation = rankedDraftGuardReport(RANKED_DRAFT_CURRENT_INCUMBENT_ID, false);
        const guardPanel = {
            purpose: "final_guard",
            baseSeed: candidateEvaluation.options.baseSeed,
            endSeedExclusive: candidateEvaluation.options.baseSeed + 6_000,
            seedChannels: 6_000,
            gamesPerOpponent: candidateEvaluation.options.gamesPerOpponent,
            mapTypes: [...RANKED_DRAFT_LIVE_MAP_TYPES],
        };
        const guardEnvelope = (
            purpose: "final_guard_candidate" | "final_guard_incumbent",
            fingerprint: string,
            report: IRankedDraftEvaluationReport,
        ) => {
            const unsigned = {
                schemaVersion: 1,
                status: "research_only_no_bake",
                runFingerprint: draftRunFingerprint,
                purpose,
                generation: 0,
                candidateFingerprint: fingerprint,
                panel: guardPanel,
                report,
            };
            return { ...unsigned, artifactSha256: fingerprintRankedDraftArtifact(unsigned) };
        };
        const candidateEnvelope = guardEnvelope("final_guard_candidate", candidateFingerprint, candidateEvaluation);
        const candidateEnvelopePath = join(draftOutput, "guard", "candidate.json");
        writeJson(candidateEnvelopePath, candidateEnvelope);
        writeJson(
            join(draftOutput, "guard", "incumbent.json"),
            guardEnvelope("final_guard_incumbent", incumbentFingerprint, incumbentEvaluation),
        );
        const cohortBaseSeed = 0xd000_0000;
        const cohortScanMaxBoards = 1_000_000;
        const cohortRequiredBoards = 625;
        const cohortNames: RankedDraftCohort[] = ["ranged", "mage", "melee_magic", "aura_heavy"];
        const cohortCells = cohortNames.map((cohort, cohortIndex) => ({
            cohort,
            opponentIndex: 0,
            opponentId: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
            seedLaneIndex: cohortIndex,
            scannedOfferBoards: cohortRequiredBoards,
            acceptedOfferBoards: Array.from({ length: cohortRequiredBoards }, (_, index) => index),
            exhausted: false,
        }));
        const cohortTasks = cohortCells.flatMap((cell) =>
            cell.acceptedOfferBoards.flatMap((offerBoard) =>
                [0, 1, 2, 3].map((offset) => ({
                    opponentIndex: cell.opponentIndex,
                    seedLaneIndex: cell.seedLaneIndex,
                    game: offerBoard * 4 + offset,
                })),
            ),
        );
        const cohortUnsigned = {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runFingerprint: draftRunFingerprint,
            candidateFingerprint,
            selectionRule: "candidate_pick_roster_only_no_fight_outcomes",
            cohortDefinitions: { ...RANKED_DRAFT_COHORT_DEFINITIONS },
            panel: {
                purpose: "targeted_cohort_guard",
                baseSeed: cohortBaseSeed,
                endSeedExclusive: cohortBaseSeed + cohortScanMaxBoards * cohortNames.length * 3,
                seedChannels: cohortScanMaxBoards * cohortNames.length * 3,
                scanMaxBoardsPerCell: cohortScanMaxBoards,
                requiredBoardsPerOpponent: cohortRequiredBoards,
                mapTypes: [...RANKED_DRAFT_LIVE_MAP_TYPES],
            },
            cells: cohortCells,
            tasks: cohortTasks,
        };
        const cohortScan = { ...cohortUnsigned, manifestSha256: fingerprintRankedDraftArtifact(cohortUnsigned) };
        writeJson(join(draftOutput, "guard", "cohorts", "scan.json"), cohortScan);
        const targetedInputs = cohortNames.map((cohort, cohortIndex) => {
            const records: IRankedDraftGameRecord[] = [];
            for (let offerBoard = 0; offerBoard < cohortRequiredBoards; offerBoard += 1) {
                const firstPreimage = cohortBaseSeed + (cohortIndex * cohortScanMaxBoards + offerBoard) * 3;
                const pairSeed = permuteRankedDraftSeed(firstPreimage);
                const pickSeed = permuteRankedDraftSeed(firstPreimage + 1);
                const battleSeed = permuteRankedDraftSeed(firstPreimage + 2);
                for (let offset = 0; offset < 4; offset += 1) {
                    const candidateSide = (["green", "red", "red", "green"] as const)[offset];
                    records.push({
                        opponentId: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
                        game: offerBoard * 4 + offset,
                        offerBoard,
                        pickSeat: offset < 2 ? "candidate-lower" : "candidate-upper",
                        battleMirror: (offset % 2) as 0 | 1,
                        setupFingerprint: createHash("sha256")
                            .update(`${cohort}:${offerBoard}:${Math.floor(offset / 2)}`)
                            .digest("hex"),
                        behaviorTraceSha256: createHash("sha256")
                            .update(`${cohort}:${offerBoard}:${offset}`)
                            .digest("hex"),
                        pairSeed,
                        pickSeed,
                        battleSeed,
                        gridType:
                            RANKED_DRAFT_LIVE_MAP_TYPES[
                                (offerBoard + cohortIndex) % RANKED_DRAFT_LIVE_MAP_TYPES.length
                            ],
                        candidateSide,
                        winner: candidateSide,
                        candidateResult: "win",
                        laps: 10,
                        endReason: "elimination",
                        collisions: Math.floor(offset / 2),
                        candidateCohorts: [cohort],
                        decidedByArmageddon: false,
                        rejectedCandidate: 0,
                        rejectedOpponent: 0,
                    });
                }
            }
            const evidence = {
                schemaVersion: 1,
                status: "research_only_no_bake",
                runFingerprint: draftRunFingerprint,
                candidateFingerprint,
                cohort,
                cohortDefinition: RANKED_DRAFT_COHORT_DEFINITIONS[cohort],
                scanManifestSha256: cohortScan.manifestSha256,
                records,
                recordsSha256: jsonSha256(records),
            };
            writeJson(join(draftOutput, "guard", "cohorts", `${cohort}.json`), evidence);
            return {
                cohort,
                requiredOfferBoards: cohortRequiredBoards,
                scannedOfferBoards: cohortRequiredBoards,
                exhausted: false,
                records,
            };
        });
        const naturalGuard = evaluateRankedDraftGuard(candidateEvaluation, incumbentEvaluation);
        const targetedCohortGuard = evaluateRankedDraftTargetedGuard(targetedInputs);
        const replayRecords = [
            {
                opponentId: "control",
                game: 0,
                pairSeed: 1,
                pickSeed: 2,
                battleSeed: 3,
                setupFingerprint: "7".repeat(64),
                behaviorTraceSha256: "8".repeat(64),
            },
        ];
        const replayReport = { deterministic: true };
        const replayRecordsSha256 = jsonSha256(replayRecords);
        const replayReportSha256 = jsonSha256(replayReport);
        const behaviorTraceSetSha256 = rankedDraftBehaviorTraceSetSha256(
            replayRecords as Parameters<typeof rankedDraftBehaviorTraceSetSha256>[0],
        );
        for (const label of ["first", "second"] as const) {
            writeJson(join(draftOutput, "guard", "replay", `${label}.json`), {
                schemaVersion: 1,
                status: "research_only_no_bake",
                runFingerprint: draftRunFingerprint,
                candidateFingerprint,
                label,
                records: replayRecords,
                report: replayReport,
                recordsSha256: replayRecordsSha256,
                reportSha256: replayReportSha256,
                behaviorTraceSetSha256,
            });
        }
        const replayIdentity = {
            recordsSha256: replayRecordsSha256,
            reportSha256: replayReportSha256,
            behaviorTraceSetSha256,
        };
        const replaySummary = {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runFingerprint: draftRunFingerprint,
            candidateFingerprint,
            first: replayIdentity,
            second: replayIdentity,
            byteIdentical: true,
            behaviorTraceIdentical: true,
        };
        writeJson(join(draftOutput, "guard", "replay", "summary.json"), replaySummary);
        const verdict = {
            schemaVersion: 1,
            status: "research_only_no_bake",
            runFingerprint: draftRunFingerprint,
            runId,
            eligibleForManualReview: true,
            checks: {
                naturalGuardPassed: true,
                targetedCohortGuardPassed: true,
                deterministicReplayByteIdentical: true,
                deterministicReplayBehaviorTraceIdentical: true,
            },
            candidate: {
                candidateId: "signed-final",
                candidateFingerprint,
                intrinsic,
                guardReportPath: "guard/candidate.json",
            },
            incumbent: {
                candidateId: RANKED_DRAFT_CURRENT_INCUMBENT_ID,
                candidateFingerprint: incumbentFingerprint,
                guardReportPath: "guard/incumbent.json",
            },
            naturalGuard,
            targetedCohortGuard,
            cohortScan: { path: "guard/cohorts/scan.json", manifestSha256: cohortScan.manifestSha256 },
            deterministicReplay: { summaryPath: "guard/replay/summary.json" },
        };
        const draftVerdictPath = join(draftOutput, "guard", "verdict.json");
        writeJson(draftVerdictPath, verdict);

        const setupPolicy = shippedNonFightPolicy("signed-setup-final");
        const startedAt = new Date().toISOString();
        const completedAt = new Date(Date.now() + 1_000).toISOString();
        const setupPair = (seedOffset: number, symmetry: boolean) => {
            const seed = (0x8000_0000 + seedOffset) >>> 0;
            const game = (candidateSide: "green" | "red", candidateResult: "win" | "loss") => ({
                candidateSide,
                candidateResult,
                candidateRejections: 0,
                baselineRejections: 0,
                laps: 10,
                endReason: "elimination" as const,
                decidedByArmageddon: false,
                traceSha256: "9".repeat(64),
                tags: ["aggregate", ...SETUP_NAMED_GUARD_TAGS],
            });
            return {
                seed,
                gridType: setupLiveGridType(seed),
                games: [game("green", "win"), game("red", symmetry ? "loss" : "win")],
            } as const;
        };
        const guardPairs = Array.from({ length: 12_288 }, (_, index) => setupPair(index, false));
        const diagnosticPairsByTag = Object.fromEntries(
            SETUP_NAMED_GUARD_TAGS.map((tag, tagIndex) => [
                tag,
                Array.from({ length: 4_096 }, (_, index) => setupPair(100_000 + tagIndex * 10_000 + index, false)),
            ]),
        ) as Record<(typeof SETUP_NAMED_GUARD_TAGS)[number], ReturnType<typeof setupPair>[]>;
        const symmetryControlPairs = Array.from({ length: 4 }, (_, index) => setupPair(200_000 + index, true));
        const aggregateEstimate = pairedSetupEstimate(guardPairs);
        const diagnosticEstimates = Object.fromEntries(
            SETUP_NAMED_GUARD_TAGS.map((tag) => [tag, pairedSetupEstimate(diagnosticPairsByTag[tag], tag)]),
        );
        const liveMapEstimates = Object.fromEntries(
            SETUP_LIVE_GRID_TYPES.map((gridType) => [gridType, pairedSetupEstimate(guardPairs, "aggregate", gridType)]),
        );
        const symmetryEstimate = pairedSetupEstimate(symmetryControlPairs);
        const setupReplayOriginalSha256 = createHash("sha256")
            .update(JSON.stringify([...guardPairs].sort((left, right) => left.seed - right.seed).slice(0, 4)))
            .digest("hex");
        const setupReplay = {
            samplePairs: 4,
            seeds: guardPairs.slice(0, 4).map((pair) => pair.seed),
            serialization: "JSON.stringify pairs sorted by uint32 seed",
            originalSha256: setupReplayOriginalSha256,
            replaySha256: setupReplayOriginalSha256,
            byteIdentical: true,
            completedAt,
        };
        const setupCheckpoint = {
            schemaVersion: 3,
            status: "complete",
            phase: "complete",
            runId,
            startedAt,
            completedAt,
            config: {
                out: setupOutput,
                smoke: false,
                guardPairs: guardPairs.length,
                diagnosticGuardPairs: diagnosticPairsByTag.ranged.length,
            },
            incumbent: setupPolicy,
            guardPairs,
            diagnosticGuardPairs: diagnosticPairsByTag,
            symmetryControlPairs,
            replay: setupReplay,
        };
        const setupCheckpointPath = join(setupOutput, "checkpoint.json");
        writeJson(setupCheckpointPath, setupCheckpoint);
        const setupFinal = {
            schemaVersion: 3,
            status: "measurement_only",
            autoBaked: false,
            campaignPhase: "complete",
            runId,
            startedAt,
            completedAt,
            policy: setupPolicy,
            decision: {
                promotable: true,
                currentGuardComplete: true,
                controlSymmetryPassed: true,
                byteIdenticalReplay: true,
                thresholds: SETUP_GUARD_THRESHOLDS,
            },
            panels: {
                guard: {
                    pairs: guardPairs.length,
                    diagnosticPairs: Object.fromEntries(
                        SETUP_NAMED_GUARD_TAGS.map((tag) => [tag, diagnosticPairsByTag[tag].length]),
                    ),
                },
            },
            guard: { aggregate: aggregateEstimate, ...diagnosticEstimates },
            liveMapGuard: {
                NORMAL: liveMapEstimates[1],
                LAVA_CENTER: liveMapEstimates[3],
                BLOCK_CENTER: liveMapEstimates[4],
            },
            controlSymmetry: {
                targetPairs: 4,
                passed: true,
                seeds: symmetryControlPairs.map((pair) => pair.seed),
                estimate: symmetryEstimate,
            },
            deterministicReplay: setupReplay,
        };
        const setupFinalPath = join(setupOutput, "final.json");
        writeJson(setupFinalPath, setupFinal);

        const provenanceUnsigned = {
            schemaVersion: 1,
            commit,
            tree: commit,
            branch: "main",
            originMain: commit,
            originUrl: "git@example.invalid:heroes-of-crypto-common.git",
            cleanIncludingUntracked: true,
            statusPorcelainSha256: "5".repeat(64),
            capturedAtMs: Date.now(),
            platform: process.platform,
            arch: process.arch,
            hostname: "test-host",
            logicalCpuCount: 12,
            bunVersion: Bun.version,
            bunRevision: Bun.revision,
        };
        const provenance = {
            ...provenanceUnsigned,
            provenanceSha256: fingerprintV07NonfightCampaign(provenanceUnsigned),
        };
        const setupGuardPairs = String(guardPairs.length);
        const setupDiagnosticPairs = String(diagnosticPairsByTag.ranged.length);
        const lanes = [
            {
                name: "draft",
                workers: 6,
                command: [
                    "bun",
                    "src/simulation/optimizer/ranked_draft_cem.ts",
                    "--out",
                    draftOutput,
                    "--run-id",
                    runId,
                ],
                cwd: campaignRepositoryRoot,
                env: {},
                restartPolicy: "on-failure" as const,
                maxRestarts: 1,
                restartBackoffMs: 1_000,
                outputDirectory: draftOutput,
            },
            {
                name: "setup",
                workers: 6,
                command: [
                    "bun",
                    "src/simulation/optimizer/v0_7_setup_overnight.ts",
                    "--out",
                    setupOutput,
                    "--run-id",
                    runId,
                    "--guard-pairs",
                    setupGuardPairs,
                    "--diagnostic-guard-pairs",
                    setupDiagnosticPairs,
                ],
                cwd: campaignRepositoryRoot,
                env: {},
                restartPolicy: "on-failure" as const,
                maxRestarts: 1,
                restartBackoffMs: 1_000,
                outputDirectory: setupOutput,
            },
        ];
        const startAtMs = Date.now();
        const durationMs = 11 * 60 * 60 * 1_000;
        const hardDeadlineAtMs = startAtMs + durationMs;
        const laneDeadlineAtMs = hardDeadlineAtMs - 30 * 60 * 1_000;
        const configSha256 = "6".repeat(64);
        const campaignRun = signedCampaign(
            {
                schemaVersion: 1,
                artifactKind: "v0_7_nonfight_campaign_run",
                status: "research_only_no_bake",
                automaticBake: false,
                automaticDeploy: false,
                runId,
                configSha256,
                outputDirectory: campaignOutput,
                repositoryRoot: campaignRepositoryRoot,
                hours: 11,
                durationMs,
                totalWorkers: 12,
                heartbeatMs: 1_000,
                stopGraceMs: 1_000,
                laneStopGraceMs: 30 * 60 * 1_000,
                startAtMs,
                laneDeadlineAtMs,
                hardDeadlineAtMs,
                provenance,
                lanes,
            },
            "runSha256",
        );
        const campaignRunPath = join(campaignOutput, "run.json");
        writeJson(campaignRunPath, campaignRun);
        const campaignTerminal = signedCampaign(
            {
                schemaVersion: 1,
                artifactKind: "v0_7_nonfight_campaign_terminal",
                status: "complete_research_only",
                automaticBake: false,
                automaticDeploy: false,
                promotionAttempted: false,
                runId,
                runSha256: campaignRun.runSha256,
                reason: "lanes_completed",
                signal: null,
                completedAtMs: startAtMs + 1_000,
                startAtMs,
                laneDeadlineAtMs,
                hardDeadlineAtMs,
                hardDeadlineKilledLanes: [],
                lanes: lanes.map((lane) => ({ lane: lane.name, status: "completed", exitCode: 0, signal: null })),
            },
            "terminalSha256",
        );
        const campaignTerminalPath = join(campaignOutput, "TERMINAL.json");
        writeJson(campaignTerminalPath, campaignTerminal);

        const options = parseV07ComposedGuardOptions(requiredCli(composedOutput));
        Object.assign(options, {
            campaignRun: campaignRunPath,
            campaignTerminal: campaignTerminalPath,
            campaignRunSha256: campaignRun.runSha256,
            campaignTerminalSha256: campaignTerminal.terminalSha256,
            campaignConfigSha256: configSha256,
            campaignProvenanceSha256: provenance.provenanceSha256,
            campaignSourceCommit: commit,
            draftVerdict: draftVerdictPath,
            draftVerdictSha256: createHash("sha256").update(readFileSync(draftVerdictPath)).digest("hex"),
            draftRunFingerprint,
            setupFinal: setupFinalPath,
            setupFinalSha256: createHash("sha256").update(readFileSync(setupFinalPath)).digest("hex"),
            setupCheckpointSha256: createHash("sha256").update(readFileSync(setupCheckpointPath)).digest("hex"),
        });
        expect(validateV07ComposedCampaignInputs(options).draft.candidateFingerprint).toBe(candidateFingerprint);
        const withinCampaignDeadline = options.deadlineMs;
        options.deadlineMs = hardDeadlineAtMs + 1;
        expect(() => validateV07ComposedCampaignInputs(options)).toThrow("exceeds the signed campaign hard deadline");
        options.deadlineMs = withinCampaignDeadline;
        const rangedEvidencePath = join(draftOutput, "guard", "cohorts", "ranged.json");
        const rangedEvidence = JSON.parse(readFileSync(rangedEvidencePath, "utf8")) as {
            records: Array<Record<string, unknown>>;
            recordsSha256: string;
        };
        rangedEvidence.records[0].candidateResult = "loss";
        rangedEvidence.recordsSha256 = jsonSha256(rangedEvidence.records);
        writeJson(rangedEvidencePath, rangedEvidence);
        expect(() => validateV07ComposedCampaignInputs(options)).toThrow("result integrity");
        rangedEvidence.records[0].candidateResult = "win";
        rangedEvidence.recordsSha256 = jsonSha256(rangedEvidence.records);
        writeJson(rangedEvidencePath, rangedEvidence);
        const candidateEnvelopeUnsigned: Partial<typeof candidateEnvelope> = { ...candidateEnvelope };
        delete candidateEnvelopeUnsigned.artifactSha256;
        const emptyReportEnvelopeUnsigned = {
            ...candidateEnvelopeUnsigned,
            report: { status: "research_only_no_bake" },
        };
        writeJson(candidateEnvelopePath, {
            ...emptyReportEnvelopeUnsigned,
            artifactSha256: fingerprintRankedDraftArtifact(emptyReportEnvelopeUnsigned),
        });
        expect(() => validateV07ComposedCampaignInputs(options)).toThrow("options");
        writeJson(candidateEnvelopePath, candidateEnvelope);
        writeJson(setupCheckpointPath, {
            ...setupCheckpoint,
            replay: { ...setupReplay, originalSha256: "f".repeat(64), replaySha256: "f".repeat(64) },
        });
        options.setupCheckpointSha256 = createHash("sha256").update(readFileSync(setupCheckpointPath)).digest("hex");
        expect(() => validateV07ComposedCampaignInputs(options)).toThrow("deterministic replay");
        writeJson(setupCheckpointPath, setupCheckpoint);
        options.setupCheckpointSha256 = createHash("sha256").update(readFileSync(setupCheckpointPath)).digest("hex");
        writeJson(draftVerdictPath, { ...verdict, eligibleForManualReview: false });
        expect(() => validateV07ComposedCampaignInputs(options)).toThrow("draft verdict bytes hash");
    });
});

describe("v0.7 composed non-fight seed ledger", () => {
    test("records every burned preimage and selects only unique top-bit-11 seeds in disjoint domains", () => {
        const calls = new Map<string, number>();
        const ledger = buildV07ComposedSeedLedger(
            "ledger-test",
            "a".repeat(64),
            {
                naturalBoards: 2,
                cohortBoards: 2,
                cohortScanMaxBoards: 20,
                symmetryBoards: 2,
                replayBoards: 1,
            },
            (cohort) => {
                const count = calls.get(cohort) ?? 0;
                calls.set(cohort, count + 1);
                return count > 0;
            },
        );
        validateV07ComposedSeedLedger(ledger);
        expect([...calls.values()]).toEqual([3, 3, 3, 3]);
        expect(ledger.entries.some((entry) => entry.disposition === "burned_top_bits_not_11")).toBe(true);
        expect(ledger.entries.filter((entry) => entry.disposition === "burned_outcome_blind_roster_miss")).toHaveLength(
            12,
        );
        const selected = ledger.entries.filter((entry) => entry.disposition === "selected");
        expect(selected.every((entry) => entry.seed >>> 30 === 3)).toBe(true);
        expect(new Set(ledger.entries.map((entry) => entry.preimage)).size).toBe(ledger.entries.length);
        expect(new Set(ledger.entries.map((entry) => entry.seed)).size).toBe(ledger.entries.length);
        expect(new Set(selected.map((entry) => entry.seed)).size).toBe(selected.length);
        for (const cohort of V07_COMPOSED_NONFIGHT_COHORTS) {
            const cohortIndex = V07_COMPOSED_NONFIGHT_COHORTS.indexOf(cohort);
            const width =
                (V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.endExclusive -
                    V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.start) /
                V07_COMPOSED_NONFIGHT_COHORTS.length;
            const cohortEntries = ledger.entries.filter((entry) => entry.cohort === cohort);
            expect(
                cohortEntries.every(
                    (entry) =>
                        entry.preimage >= V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.start + cohortIndex * width &&
                        entry.preimage < V07_COMPOSED_NONFIGHT_SEED_RANGES.targeted.start + (cohortIndex + 1) * width,
                ),
            ).toBe(true);
        }
    });

    test("rejects ledger tampering", () => {
        const ledger = buildV07ComposedSeedLedger(
            "ledger-tamper-test",
            "b".repeat(64),
            {
                naturalBoards: 2,
                cohortBoards: 2,
                cohortScanMaxBoards: 10,
                symmetryBoards: 2,
                replayBoards: 1,
            },
            () => true,
        );
        ledger.boards[0].pickSeed ^= 1;
        expect(() => validateV07ComposedSeedLedger(ledger)).toThrow("self-hash mismatch");
    });
});

describe("v0.7 composed four-game evaluator", () => {
    test("executes both pick seats and both battle sides as one deterministic cluster", () => {
        const genome = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
        const arm: IV07ComposedArm = {
            id: "old-control",
            genome,
            policy: shippedNonFightPolicy("old-control"),
        };
        const ledger = buildV07ComposedSeedLedger(
            "cluster-test",
            "c".repeat(64),
            {
                naturalBoards: 2,
                cohortBoards: 2,
                cohortScanMaxBoards: 10,
                symmetryBoards: 2,
                replayBoards: 1,
            },
            () => true,
        );
        const board = ledger.boards.find((entry) => entry.panel === "natural")!;
        const first = evaluateV07ComposedCluster(arm, arm, board);
        const second = evaluateV07ComposedCluster(arm, arm, board);
        validateV07ComposedClusters([first]);
        expect(first).toEqual(second);
        expect(
            first.records.map(({ pickSeat, battleMirror, candidateSide }) => ({
                pickSeat,
                battleMirror,
                candidateSide,
            })),
        ).toEqual([
            { pickSeat: "candidate-lower", battleMirror: 0, candidateSide: "green" },
            { pickSeat: "candidate-lower", battleMirror: 1, candidateSide: "red" },
            { pickSeat: "candidate-upper", battleMirror: 0, candidateSide: "red" },
            { pickSeat: "candidate-upper", battleMirror: 1, candidateSide: "green" },
        ]);
        const estimate = estimateV07ComposedRecords(first.records);
        expect(estimate.offerBoards).toBe(1);
        expect(estimate.games).toBe(4);
        expect(estimate.candidateRejections).toBe(0);
        expect(estimate.baselineRejections).toBe(0);
        expect(estimate.wins).toBe(estimate.losses);
    });

    test("wires distinct candidate-only draft, Tier-2, augment, synergy, and reveal policies on both seats", () => {
        const baseline = controlArm();
        const policy = cloneNonFightPolicy(shippedNonFightPolicy("distinct-final-setup"));
        for (const cohort of SETUP_COHORTS) {
            policy.augmentsByCohort[cohort] = { placement: 2, armor: 0, might: 0, sniper: 3, movement: 2 };
            policy.tier2ByCohort[cohort] = "blind";
        }
        policy.synergy = "beneficiary";
        policy.placement = "legitimate-reveal";
        const candidate: IV07ComposedArm = {
            id: "distinct-final",
            genome: projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND3_DRAFT_SPEC)),
            policy,
        };
        const ledger = buildV07ComposedSeedLedger(
            "distinct-wiring",
            "e".repeat(64),
            {
                naturalBoards: 64,
                cohortBoards: 2,
                cohortScanMaxBoards: 10,
                symmetryBoards: 2,
                replayBoards: 1,
            },
            () => true,
        );
        const prepared = ledger.boards
            .filter((board) => board.panel === "natural")
            .flatMap((board) => [
                prepareV07ComposedMatch(candidate, baseline, board, true, 0),
                prepareV07ComposedMatch(candidate, baseline, board, false, 0),
            ]);
        expect(prepared.some((match) => match.candidateTier2Artifact !== match.baselineTier2Artifact)).toBe(true);
        expect(
            prepared.some(
                (match) => JSON.stringify(match.candidateSynergies) !== JSON.stringify(match.baselineSynergies),
            ),
        ).toBe(true);
        expect(
            prepared.every((match) =>
                match.candidateAugments?.some((augment) => augment.kind === "Placement" && augment.value === 2),
            ),
        ).toBe(true);
        expect(
            prepared.every((match) => !match.baselineAugments?.some((augment) => augment.kind === "Placement")),
        ).toBe(true);
        expect(prepared.every((match) => match.candidateRevealedCreatures !== undefined)).toBe(true);
        expect(prepared.every((match) => match.baselineRevealedCreatures === undefined)).toBe(true);
        expect(new Set(prepared.map((match) => match.candidateSide))).toEqual(new Set(["green", "red"]));
    });

    test("supplies the complete opposing roster only to a public-roster placement arm", () => {
        const baseline = controlArm();
        const policy = cloneNonFightPolicy(shippedNonFightPolicy("public-roster-final-setup"));
        policy.placement = "public-roster";
        const candidate: IV07ComposedArm = {
            id: "public-roster-final",
            genome: projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC)),
            policy,
        };
        const ledger = buildV07ComposedSeedLedger(
            "public-roster-wiring",
            "a".repeat(64),
            { naturalBoards: 2, cohortBoards: 2, cohortScanMaxBoards: 10, symmetryBoards: 2, replayBoards: 1 },
            () => true,
        );
        const board = ledger.boards.find((entry) => entry.panel === "natural")!;
        const prepared = prepareV07ComposedMatch(candidate, baseline, board, true, 0);

        expect(prepared.candidateSide).toBe("green");
        expect(prepared.candidatePublicOpponentCreatures).toEqual(prepared.baselineArmyCreatureIds);
        expect(prepared.baselinePublicOpponentCreatures).toBeUndefined();
        expect(prepared.config.greenPublicOpponentCreatures).toEqual(prepared.baselineArmyCreatureIds);
        expect(prepared.config.redPublicOpponentCreatures).toBeUndefined();
        expect(prepared.candidateRevealedCreatures).toBeDefined();
    });
});

describe("v0.7 composed runtime and ownership seal", () => {
    test("rejects preload injection and strips cached strategy knobs from an explicit worker environment", () => {
        expect(() => assertV07ComposedRuntimeInjectionAbsent({ NODE_OPTIONS: "" }, [])).toThrow(
            "Forbidden runtime injection",
        );
        const sanitized = sanitizedV07ComposedWorkerEnvironment({
            PATH: process.env.PATH,
            V04_FRONTMOVE: "off",
            V05_AURAFLY: "off",
            V07_WAIT_GUARD: "observe",
            LIVETWIN: "0",
        });
        expect(sanitized.V04_FRONTMOVE).toBeUndefined();
        expect(sanitized.V05_AURAFLY).toBeUndefined();
        expect(sanitized.V07_WAIT_GUARD).toBeUndefined();
        expect(sanitized.LIVETWIN).toBe("1");
        expect(sanitized.V07_SEARCH).toBe("0");
        expect(sanitized.V07_PLACEMENT_REVEAL).toBe("on");
        expect(sanitized.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0");
    });

    test("evaluates one board in a fresh worker and is byte-stable under caller V04/V05 contamination", async () => {
        const arm = controlArm();
        const ledger = buildV07ComposedSeedLedger(
            "sealed-worker",
            "f".repeat(64),
            { naturalBoards: 2, cohortBoards: 2, cohortScanMaxBoards: 10, symmetryBoards: 2, replayBoards: 1 },
            () => true,
        );
        const board = ledger.boards.find((entry) => entry.panel === "natural")!;
        const clean = await evaluateV07ComposedBoardsInSealedWorkers(arm, arm, [board], 1, { ...process.env });
        const contaminated = await evaluateV07ComposedBoardsInSealedWorkers(arm, arm, [board], 1, {
            ...process.env,
            V04_FRONTMOVE: "off",
            V05_AURAFLY: "off",
            V05_HEALPOLICY: "never",
        });
        expect(contaminated).toEqual(clean);
    });

    test("allows only one live owner of an output directory", () => {
        const directory = temporaryDirectory();
        const first = acquireV07ComposedOutputLock(directory);
        expect(existsSync(first.directory)).toBe(true);
        expect(() => acquireV07ComposedOutputLock(directory)).toThrow("already locked by live process");
        releaseV07ComposedOutputLock(first);
        const second = acquireV07ComposedOutputLock(directory);
        releaseV07ComposedOutputLock(second);
        expect(existsSync(second.directory)).toBe(false);
    });

    test("fails closed when a lock owner identity cannot be observed", () => {
        expect(v07ComposedLockOwnerCanBeReclaimed("recorded", null, "live_or_unknown")).toBe(false);
        expect(v07ComposedLockOwnerCanBeReclaimed("recorded", null, "dead")).toBe(true);
        expect(v07ComposedLockOwnerCanBeReclaimed("recorded", "recorded", "live_or_unknown")).toBe(false);
        expect(v07ComposedLockOwnerCanBeReclaimed("recorded", "replacement", "live_or_unknown")).toBe(true);
    });
});

describe("v0.7 composed production gates and resumability", () => {
    test("production CLI overrides cannot weaken preregistered panels while explicit smoke stays small", () => {
        const output = temporaryDirectory();
        expect(() => parseV07ComposedGuardOptions([...requiredCli(output), "--natural-boards", "2"])).toThrow(
            "--natural-boards must be >= 8000",
        );
        const smoke = parseV07ComposedGuardOptions([
            ...requiredCli(output),
            "--smoke",
            "--natural-boards",
            "2",
            "--preflight-reserve-ms",
            "0",
        ]);
        expect(smoke.smoke).toBe(true);
        expect(smoke.naturalBoards).toBe(2);
        expect(smoke.cohortBoards).toBe(2);
        expect(smoke.preflightReserveMs).toBe(0);
        expect(smoke.campaignSourceCommit).not.toBe(smoke.guardSourceCommit);
        expect(() =>
            assertV07ComposedGuardDescendantPaths([
                "src/simulation/optimizer/v0_7_composed_nonfight_guard.ts",
                "src/simulation/optimizer/v0_7_composed_nonfight_guard_worker.ts",
                "src/ai/v0_7.ts",
            ]),
        ).toThrow("non-allowlisted");
    });

    test("persists and reloads an incomplete outcome-blind seed-plan cursor without running a fight", async () => {
        const directory = temporaryDirectory();
        const path = join(directory, "seed-plan.checkpoint.json");
        const arm = controlArm();
        const environment = sanitizedV07ComposedWorkerEnvironment({ PATH: process.env.PATH });
        const runtime = captureV07ComposedRuntimeEnvelope(environment);
        const requested = {
            naturalBoards: 2,
            cohortBoards: 2,
            cohortScanMaxBoards: 10,
            symmetryBoards: 2,
            replayBoards: 1,
        };
        const first = await buildOrResumeV07ComposedSeedLedger(
            path,
            "seed-plan-resume",
            "1".repeat(64),
            "2".repeat(64),
            requested,
            arm,
            arm,
            1,
            environment,
            runtime,
            Date.now() + 1,
        );
        expect(first.ledger).toBeNull();
        expect(existsSync(path)).toBe(true);
        const bytes = readFileSync(path, "utf8");
        const second = await buildOrResumeV07ComposedSeedLedger(
            path,
            "seed-plan-resume",
            "1".repeat(64),
            "2".repeat(64),
            requested,
            arm,
            arm,
            1,
            environment,
            runtime,
            Date.now() - 1,
        );
        expect(second.ledger).toBeNull();
        expect(second.checkpoint.checkpointSha256).toBe(first.checkpoint.checkpointSha256);
        expect(readFileSync(path, "utf8")).toBe(bytes);
    });

    test("fails named coverage below either floor and draw/Armageddon above matched control +1pp", () => {
        expect(v07ComposedNamedCoveragePassed({ games: 99, decisiveGames: 99 })).toBe(false);
        expect(v07ComposedNamedCoveragePassed({ games: 100, decisiveGames: 49 })).toBe(false);
        expect(v07ComposedNamedCoveragePassed({ games: 100, decisiveGames: 50 })).toBe(true);
        expect(v07ComposedNamedGamesPassed({ games: 99 })).toBe(false);
        expect(v07ComposedNamedGamesPassed({ games: 100 })).toBe(true);
        expect(v07ComposedNamedDecisiveGamesPassed({ decisiveGames: 49 })).toBe(false);
        expect(v07ComposedNamedDecisiveGamesPassed({ decisiveGames: 50 })).toBe(true);
        expect(v07ComposedDrawOrArmageddonPassed(0.11, 0.1)).toBe(true);
        expect(v07ComposedDrawOrArmageddonPassed(0.110_001, 0.1)).toBe(false);
    });
});
