/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
    buildV08CandidateInitialRunManifest,
    buildV08CandidateLevel4Invocation,
    buildV08CandidateTournamentInvocation,
    evaluateV08CandidateLevel4Qualification,
    evaluateV08CandidateTournamentQualification,
    normalizeV08CandidateMaps,
    prepareV08CandidateOutputDirectory,
    scanV08CandidateTournamentRawEvidence,
    verifyV08CandidateOperationalIdentity,
    type IV08CandidateOperationalIdentity,
    type IV08CandidateLevel4RecordEvidence,
    type IV08CandidateLevel4SummaryEvidence,
} from "../../src/simulation/run_v0_8_candidate";

const LEVEL4_LANES = ["Champion", "Arachna Queen", "Abomination", "Frenzied Boar"].flatMap((unit) => [
    { unit, owner: "candidate" },
    { unit, owner: "opponent" },
]);

const emptyTournamentRawEvidence = () => ({
    games: 6000,
    uniqueGames: 6000,
    armageddonReached: 0,
    rejectedCandidate: 0,
    candidateCompletedEndTurns: 0,
    candidateCompletedObstacleAttacks: 0,
    candidateCompletedDefendTurns: 0,
    candidateCompletedWaitTurns: 0,
    candidateWaitTurnsActedAgainSameLap: 0,
    candidateWaitTurnsWithoutSameLapAction: 0,
    candidateLateWaitTurns: 0,
    candidateLateWaitTurnsActedAgainSameLap: 0,
});

const sealedIdentityFixture = (): IV08CandidateOperationalIdentity => ({
    sourceFiles: Object.freeze({ "src/ai/versions/v0_8.ts": "a".repeat(64) }),
    sourceBundleSha256: "b".repeat(64),
    operationalEnvironmentSha256: "c".repeat(64),
    policySha256: "d".repeat(64),
});

describe("pinned v0.8 candidate tournament runner", () => {
    it("rebinds the bounded candidate to v0.8 and scrubs inherited experiment drift", () => {
        const invocation = buildV08CandidateTournamentInvocation(
            {
                games: 6000,
                baseSeed: 82_608_001,
                output: "/tmp/hoc-v08-candidate-test",
                concurrency: 12,
                timingMode: "operational_bounded",
                maps: "normal,lava,block",
            },
            {
                HOME: "/unexpected/home",
                LANG: "en_US.UTF-8",
                NODE_OPTIONS: "--require=/tmp/hostile.js",
                PATH: "/bin",
                COHORT: "range",
                ROSTER_FLYER_MIN: "6",
                ROSTER_CASTER_MAX: "0",
                SEARCH_GATE: "99",
                V08_STALE: "1",
                SIM_NO_ACTIONS: "1",
                TOTALLY_UNKNOWN_BEHAVIOR_SWITCH: "1",
            },
        );

        expect(invocation.args.slice(1, 7)).toEqual([
            "v0.8",
            "v0.7",
            "6000",
            "82608001",
            "/tmp/hoc-v08-candidate-test",
            "12",
        ]);
        expect(invocation.args).toContain("--maps=normal,lava,block");
        expect(invocation.environment).toMatchObject({
            PATH: "/bin",
            LANG: "en_US.UTF-8",
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            LIVETWIN: "1",
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "0.02",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            V07_PLACEMENT_REVEAL_VERSIONS: "v0.8",
            V08_AGGRESSIVE: "1",
        });
        expect(invocation.environment.V08_STALE).toBeUndefined();
        expect(invocation.environment.SIM_NO_ACTIONS).toBeUndefined();
        expect(invocation.environment.COHORT).toBeUndefined();
        expect(invocation.environment.ROSTER_FLYER_MIN).toBeUndefined();
        expect(invocation.environment.ROSTER_CASTER_MAX).toBeUndefined();
        expect(invocation.environment.NODE_OPTIONS).toBeUndefined();
        expect(invocation.environment.HOME).toBeUndefined();
        expect(invocation.environment.TOTALLY_UNKNOWN_BEHAVIOR_SWITCH).toBeUndefined();
    });

    it("supports exact unbounded research replay without changing the pinned policy", () => {
        const invocation = buildV08CandidateTournamentInvocation({
            games: 2,
            baseSeed: 1,
            output: "/tmp/hoc-v08-candidate-research-test",
            concurrency: 12,
            timingMode: "research_unbounded",
            maps: "normal",
        });
        expect(invocation.args).toContain("2");
        expect(invocation.environment.SEARCH_DECISION_DEADLINE_MS).toBe("");
        expect(invocation.environment.SEARCH_CIRCUIT_BREAKER_MS).toBe("");
        expect(invocation.environment.SEARCH_GATE).toBe("0.02");
    });

    it("runs the identical bounded profile through the forced new-L4 matrix", () => {
        const invocation = buildV08CandidateLevel4Invocation({
            pairsPerLane: 32,
            baseSeed: 30_260_719,
            output: "/tmp/hoc-v08-candidate-l4-test",
            concurrency: 12,
            timingMode: "operational_bounded",
        });
        expect(invocation.args.slice(1)).toEqual([
            "v0.8",
            "v0.7",
            "32",
            "30260719",
            "/tmp/hoc-v08-candidate-l4-test",
            "12",
        ]);
        expect(invocation.environment.SEARCH_VERSIONS).toBe("v0.8");
        expect(invocation.environment.SEARCH_DECISION_DEADLINE_MS).toBe("175");
    });

    it("rejects invalid geometry before spawning", () => {
        expect(() =>
            buildV08CandidateTournamentInvocation({
                games: 0,
                baseSeed: 1,
                output: "/tmp/hoc-v08-invalid",
                concurrency: 1,
                timingMode: "operational_bounded",
                maps: "normal",
            }),
        ).toThrow("games");
        expect(() => normalizeV08CandidateMaps("normal,unknown")).toThrow("unknown map");
        expect(() => normalizeV08CandidateMaps("normal, normal")).toThrow("duplicate map");
        expect(normalizeV08CandidateMaps(" Normal, LAVA ,block ")).toBe("normal,lava,block");
    });

    it("keeps the sealed-r1 runner fail-closed while experimental r3 source is under qualification", () => {
        // The committed operational r1 identity is intentionally not repinned to unpromoted v0.8s work.
        expect(() => verifyV08CandidateOperationalIdentity()).toThrow("repin");
        expect(() => verifyV08CandidateOperationalIdentity("/unused", () => new TextEncoder().encode("drift"))).toThrow(
            "repin",
        );
    });

    it("builds a non-promotable manifest bound to exact identity, environment, source, and geometry", () => {
        const identity = sealedIdentityFixture();
        const invocation = buildV08CandidateTournamentInvocation({
            games: 6000,
            baseSeed: 99,
            output: "/tmp/hoc-v08-manifest-test",
            concurrency: 12,
            timingMode: "operational_bounded",
            maps: "normal,lava,block",
        });
        const manifest = buildV08CandidateInitialRunManifest({
            identity,
            invocation,
            timingMode: "operational_bounded",
            geometry: {
                kind: "tournament",
                games: 6000,
                baseSeed: 99,
                concurrency: 12,
                maps: ["normal", "lava", "block"],
            },
            startedAt: "2026-07-21T12:00:00.000Z",
            host: { hostname: "test", platform: "darwin", release: "test", arch: "arm64", bun: "test" },
        });
        expect(manifest).toMatchObject({
            schema: "hoc.v0_8_candidate_run.v1",
            status: "running",
            testOnly: true,
            automaticBake: false,
            automaticDeploy: false,
            identity: {
                operationalPolicyId: "v0.8-d1748882-operational-r1",
                operationalPolicyRevision: 1,
                operationalPolicySha256: identity.policySha256,
                sourceCandidateId: "v0.8-d1748882-test-candidate",
                candidateVersion: "v0.8",
                opponentVersion: "v0.7",
            },
            environment: {
                operationalIdentitySha256: identity.operationalEnvironmentSha256,
                executionSha256: invocation.candidateEnvironmentSha256,
                timingMode: "operational_bounded",
            },
            source: identity,
            geometry: { kind: "tournament", games: 6000, baseSeed: 99 },
            timestamps: { startedAt: "2026-07-21T12:00:00.000Z", completedAt: null },
            artifacts: null,
            qualification: null,
        });
    });

    it("creates only a fresh/empty evidence directory and refuses to contaminate an existing run", () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v08-output-contract-"));
        try {
            const output = join(root, "evidence");
            expect(prepareV08CandidateOutputDirectory(output)).toBe(output);
            writeFileSync(join(output, "old-evidence.json"), "{}\n");
            expect(() => prepareV08CandidateOutputDirectory(output)).toThrow("must be empty");
        } finally {
            rmSync(root, { recursive: true });
        }
    });

    it("evaluates bounded tournament evidence but never self-promotes the test artifact", () => {
        const verdict = evaluateV08CandidateTournamentQualification({
            timingMode: "operational_bounded",
            expectedGames: 6000,
            expectedBaseSeed: 123,
            summary: {
                versionA: "v0.8",
                versionB: "v0.7",
                games: 6000,
                baseSeed: 123,
                a: { version: "v0.8", wins: 3600 },
                b: { version: "v0.7", wins: 2398 },
                draws: 2,
                winRateA: 0.6002,
                endReasons: { elimination: 6000 },
                armageddonDecided: 0,
            },
            raw: {
                ...emptyTournamentRawEvidence(),
                candidateCompletedDefendTurns: 7,
                candidateCompletedWaitTurns: 9,
                candidateWaitTurnsActedAgainSameLap: 8,
                candidateWaitTurnsWithoutSameLapAction: 1,
                candidateLateWaitTurns: 3,
                candidateLateWaitTurnsActedAgainSameLap: 3,
            },
        });
        expect(verdict.status).toBe("passed");
        expect(verdict.operationalQualificationPassed).toBe(true);
        expect(verdict.promotionEligible).toBe(false);
        expect(verdict.diagnostics).toMatchObject({
            candidateCompletedActions: { endTurn: 0, obstacleAttack: 0, defendTurn: 7, waitTurn: 9 },
            candidateWaitInitiative: {
                actedAgainSameLap: 8,
                withoutSameLapAction: 1,
                lateLap9OrLater: 3,
                lateActedAgainSameLap: 3,
            },
        });

        const invalidActions = evaluateV08CandidateTournamentQualification({
            timingMode: "operational_bounded",
            expectedGames: 6000,
            expectedBaseSeed: 123,
            summary: {
                versionA: "v0.8",
                versionB: "v0.7",
                games: 6000,
                baseSeed: 123,
                a: { version: "v0.8", wins: 3600 },
                b: { version: "v0.7", wins: 2400 },
                draws: 0,
                winRateA: 0.6,
                endReasons: { elimination: 6000 },
                armageddonDecided: 0,
            },
            raw: {
                ...emptyTournamentRawEvidence(),
                candidateCompletedEndTurns: 1,
                candidateCompletedObstacleAttacks: 2,
            },
        });
        expect(invalidActions.status).toBe("failed");
        expect(invalidActions.gates.zeroCandidateCompletedEndTurns.passed).toBe(false);
        expect(invalidActions.gates.zeroCandidateCompletedObstacleAttacks.passed).toBe(false);

        const incomplete = evaluateV08CandidateTournamentQualification({
            timingMode: "operational_bounded",
            expectedGames: 6000,
            expectedBaseSeed: 123,
            summary: {
                versionA: "v0.8",
                versionB: "v0.7",
                games: 6000,
                baseSeed: 123,
                a: { version: "v0.8", wins: 3600 },
                b: { version: "v0.7", wins: 2400 },
                draws: 0,
                winRateA: 0.6,
                endReasons: { elimination: 6000 },
                armageddonDecided: 0,
            },
        });
        expect(incomplete.status).toBe("incomplete");
        expect(incomplete.gates.armageddonReachedRate.passed).toBeNull();
    });

    it("streams an exact raw tournament census and attributes rejections to the candidate seat", async () => {
        const root = mkdtempSync(join(tmpdir(), "hoc-v08-raw-census-"));
        type TestAction = {
            lap: number;
            side: "green" | "red";
            unitId: string;
            actionType: string;
        };
        const record = (
            game: number,
            reachedArmageddon: boolean,
            rejectedGreen: number,
            rejectedRed: number,
            rawActions: TestAction[] = [
                {
                    lap: 1,
                    side: game % 2 === 0 ? "green" : "red",
                    unitId: `candidate-${game}`,
                    actionType: "move_unit",
                },
            ],
        ) => {
            const candidateIsGreen = game % 2 === 0;
            const actions = rawActions.map((action, index) => ({
                index,
                ...action,
                creatureName: `unit-${action.unitId}`,
                fromCell: { x: 1, y: 1 },
                completed: true,
            }));
            return {
                game,
                greenEntrant: candidateIsGreen ? "a" : "b",
                greenVersion: candidateIsGreen ? "v0.8" : "v0.7",
                redVersion: candidateIsGreen ? "v0.7" : "v0.8",
                result: {
                    rejectedGreen,
                    rejectedRed,
                    totalActions: actions.length,
                    actions,
                    attrition: { reachedArmageddon },
                },
            };
        };
        try {
            const path = join(root, "records.jsonl");
            const records = [
                record(2, true, 3, 7, [
                    { lap: 8, side: "green", unitId: "candidate-2", actionType: "wait_turn" },
                    { lap: 8, side: "red", unitId: "opponent-2", actionType: "obstacle_attack" },
                    { lap: 8, side: "green", unitId: "candidate-2", actionType: "range_attack" },
                    { lap: 9, side: "green", unitId: "candidate-2b", actionType: "defend_turn" },
                    { lap: 9, side: "green", unitId: "candidate-2b", actionType: "obstacle_attack" },
                ]),
                record(0, false, 2, 11, [
                    { lap: 1, side: "green", unitId: "candidate-0", actionType: "end_turn" },
                    { lap: 1, side: "red", unitId: "opponent-0", actionType: "end_turn" },
                ]),
                record(3, false, 5, 13, [
                    { lap: 9, side: "red", unitId: "candidate-3", actionType: "wait_turn" },
                    { lap: 9, side: "green", unitId: "opponent-3", actionType: "defend_turn" },
                    { lap: 10, side: "red", unitId: "candidate-3", actionType: "move_unit" },
                ]),
                record(1, true, 17, 19, [
                    { lap: 9, side: "red", unitId: "candidate-1", actionType: "wait_turn" },
                    { lap: 9, side: "green", unitId: "opponent-1", actionType: "wait_turn" },
                    { lap: 9, side: "red", unitId: "candidate-1", actionType: "move_unit" },
                ]),
            ];
            writeFileSync(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

            await expect(scanV08CandidateTournamentRawEvidence(path, 4)).resolves.toEqual({
                games: 4,
                uniqueGames: 4,
                armageddonReached: 2,
                rejectedCandidate: 37,
                candidateCompletedEndTurns: 1,
                candidateCompletedObstacleAttacks: 1,
                candidateCompletedDefendTurns: 1,
                candidateCompletedWaitTurns: 3,
                candidateWaitTurnsActedAgainSameLap: 2,
                candidateWaitTurnsWithoutSameLapAction: 1,
                candidateLateWaitTurns: 2,
                candidateLateWaitTurnsActedAgainSameLap: 1,
            });

            writeFileSync(
                path,
                `${JSON.stringify(record(0, false, 0, 0))}\n${JSON.stringify(record(0, false, 0, 0))}\n`,
            );
            await expect(scanV08CandidateTournamentRawEvidence(path, 2)).rejects.toThrow("duplicate game 0");

            writeFileSync(path, `${JSON.stringify(record(0, false, 0, 0))}\n`);
            await expect(scanV08CandidateTournamentRawEvidence(path, 2)).rejects.toThrow("1/2 unique games");

            const wrongSeat = { ...record(0, false, 0, 0), greenVersion: "v0.7" };
            writeFileSync(path, `${JSON.stringify(wrongSeat)}\n`);
            await expect(scanV08CandidateTournamentRawEvidence(path, 1)).rejects.toThrow(
                "candidate side/version binding drifted",
            );

            const invalidActionSide = record(0, false, 0, 0, [
                { lap: 1, side: "green", unitId: "candidate", actionType: "move_unit" },
            ]);
            (invalidActionSide.result.actions[0] as { side: string }).side = "blue";
            writeFileSync(path, `${JSON.stringify(invalidActionSide)}\n`);
            await expect(scanV08CandidateTournamentRawEvidence(path, 1)).rejects.toThrow(
                "actions[0].side must be green or red",
            );

            const invalidActionType = record(0, false, 0, 0, [
                { lap: 1, side: "green", unitId: "candidate", actionType: "attack_mountain_via_unknown_schema" },
            ]);
            writeFileSync(path, `${JSON.stringify(invalidActionType)}\n`);
            await expect(scanV08CandidateTournamentRawEvidence(path, 1)).rejects.toThrow(
                "actions[0].actionType is unknown",
            );

            writeFileSync(path, `${JSON.stringify(record(0, false, 0, 0, []))}\n`);
            await expect(scanV08CandidateTournamentRawEvidence(path, 1)).rejects.toThrow("actions must not be empty");

            const opponentOnly = record(0, false, 0, 0, [
                { lap: 1, side: "red", unitId: "opponent", actionType: "move_unit" },
            ]);
            writeFileSync(path, `${JSON.stringify(opponentOnly)}\n`);
            await expect(scanV08CandidateTournamentRawEvidence(path, 1)).rejects.toThrow(
                "has no recorded candidate-side actions",
            );
        } finally {
            rmSync(root, { recursive: true });
        }
    });

    it("validates the exact L4 lane/seat/map census and rejects duplicates, skips, rejections, and Armageddon", () => {
        const baseSeed = 77;
        const targetActionTypes = (game: number): Record<string, number> => {
            if (game === 0) return { defend_turn: 1 };
            if (game === 2) return { obstacle_attack: 1 };
            return {};
        };
        const laneActionTypes = (lane: { unit: string; owner: string }): Record<string, number> => {
            if (lane.unit !== "Champion") return {};
            return lane.owner === "candidate" ? { defend_turn: 1 } : { obstacle_attack: 1 };
        };
        const records: IV08CandidateLevel4RecordEvidence[] = LEVEL4_LANES.flatMap((lane, laneIndex) =>
            [0, 1].map((seatOffset) => {
                const game = laneIndex * 2 + seatOffset;
                const candidateSide = seatOffset === 0 ? "green" : "red";
                return {
                    schema: "hoc.v0_8_l4_coverage.v1",
                    game,
                    cycle: 0,
                    seed: baseSeed,
                    mapType: 1,
                    lane,
                    candidateVersion: "v0.8",
                    opponentVersion: "v0.7",
                    candidateSide,
                    targetSide:
                        lane.owner === "candidate" ? candidateSide : candidateSide === "green" ? "red" : "green",
                    endReason: "elimination",
                    rejectedCandidate: 0,
                    target: {
                        appearances: 1,
                        actingTurns: 1,
                        completedActions: Object.values(targetActionTypes(game)).reduce(
                            (total, count) => total + count,
                            0,
                        ),
                        rawEndTurnDecisions: 0,
                        actionTypes: targetActionTypes(game),
                    },
                    armageddon: { reached: false },
                };
            }),
        );
        const summary: IV08CandidateLevel4SummaryEvidence = {
            schema: "hoc.v0_8_l4_coverage.v1",
            candidateVersion: "v0.8",
            opponentVersion: "v0.7",
            baseSeed,
            pairsPerLane: 1,
            games: 16,
            lanes: LEVEL4_LANES.map((lane) => ({
                lane,
                games: 2,
                appearances: 2,
                actingTurns: 2,
                completedActions: Object.values(laneActionTypes(lane)).reduce((total, count) => total + count, 0),
                rejectedCandidate: 0,
                rawEndTurnDecisions: 0,
                armageddonReached: 0,
                actionTypes: laneActionTypes(lane),
            })),
        };
        const passed = evaluateV08CandidateLevel4Qualification({
            timingMode: "operational_bounded",
            pairsPerLane: 1,
            baseSeed,
            summary,
            records,
        });
        expect(passed.status).toBe("passed");
        expect(passed.promotionEligible).toBe(false);
        expect(passed.diagnostics.candidateLevel4TargetCompletedActions).toEqual({
            defendTurn: 1,
            obstacleAttack: 0,
        });

        const omittedRecordActions = structuredClone(records);
        omittedRecordActions[0].target.actionTypes = {};
        const omittedVerdict = evaluateV08CandidateLevel4Qualification({
            timingMode: "operational_bounded",
            pairsPerLane: 1,
            baseSeed,
            summary,
            records: omittedRecordActions,
        });
        expect(omittedVerdict.gates.exactRecordCensus.passed).toBe(false);

        const unknownSummaryAction = structuredClone(summary);
        unknownSummaryAction.lanes[0].actionTypes.future_unreviewed_action = 1;
        unknownSummaryAction.lanes[0].completedActions += 1;
        const unknownVerdict = evaluateV08CandidateLevel4Qualification({
            timingMode: "operational_bounded",
            pairsPerLane: 1,
            baseSeed,
            summary: unknownSummaryAction,
            records,
        });
        expect(unknownVerdict.gates.exactLaneCoverage.passed).toBe(false);

        const broken = structuredClone(records);
        broken[0].rejectedCandidate = 1;
        broken[0].target.rawEndTurnDecisions = 1;
        broken[0].target.actionTypes.obstacle_attack = 1;
        broken[0].target.completedActions = 2;
        broken[0].armageddon.reached = true;
        broken[broken.length - 1] = structuredClone(broken[0]);
        const failed = evaluateV08CandidateLevel4Qualification({
            timingMode: "operational_bounded",
            pairsPerLane: 1,
            baseSeed,
            summary,
            records: broken,
        });
        expect(failed.status).toBe("failed");
        expect(failed.gates.exactRecordCensus.passed).toBe(false);
        expect(failed.gates.zeroCandidateRejections.passed).toBe(false);
        expect(failed.gates.zeroCandidateRawEndTurns.passed).toBe(false);
        expect(failed.gates.zeroCandidateTargetObstacleAttacks.passed).toBe(false);
        expect(failed.gates.armageddonReachedRate.passed).toBe(false);
    });
});
