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
    type IV08CandidateLevel4RecordEvidence,
    type IV08CandidateLevel4SummaryEvidence,
} from "../../src/simulation/run_v0_8_candidate";

const LEVEL4_LANES = ["Champion", "Arachna Queen", "Abomination", "Frenzied Boar"].flatMap((unit) => [
    { unit, owner: "candidate" },
    { unit, owner: "opponent" },
]);

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

    it("verifies the reviewed source/environment/policy pin and fails closed on source drift", () => {
        const identity = verifyV08CandidateOperationalIdentity();
        expect(identity.sourceBundleSha256).toHaveLength(64);
        expect(identity.operationalEnvironmentSha256).toHaveLength(64);
        expect(identity.policySha256).toHaveLength(64);
        expect(() => verifyV08CandidateOperationalIdentity("/unused", () => new TextEncoder().encode("drift"))).toThrow(
            "repin",
        );
    });

    it("builds a non-promotable manifest bound to exact identity, environment, source, and geometry", () => {
        const identity = verifyV08CandidateOperationalIdentity();
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
            raw: { games: 6000, uniqueGames: 6000, armageddonReached: 0, rejectedCandidate: 0 },
        });
        expect(verdict.status).toBe("passed");
        expect(verdict.operationalQualificationPassed).toBe(true);
        expect(verdict.promotionEligible).toBe(false);

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
        const record = (game: number, reachedArmageddon: boolean, rejectedGreen: number, rejectedRed: number) => {
            const candidateIsGreen = game % 2 === 0;
            return {
                game,
                greenEntrant: candidateIsGreen ? "a" : "b",
                greenVersion: candidateIsGreen ? "v0.8" : "v0.7",
                redVersion: candidateIsGreen ? "v0.7" : "v0.8",
                result: {
                    rejectedGreen,
                    rejectedRed,
                    attrition: { reachedArmageddon },
                },
            };
        };
        try {
            const path = join(root, "records.jsonl");
            const records = [
                record(2, true, 3, 7),
                record(0, false, 2, 11),
                record(3, false, 5, 13),
                record(1, true, 17, 19),
            ];
            writeFileSync(path, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

            await expect(scanV08CandidateTournamentRawEvidence(path, 4)).resolves.toEqual({
                games: 4,
                uniqueGames: 4,
                armageddonReached: 2,
                rejectedCandidate: 37,
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
        } finally {
            rmSync(root, { recursive: true });
        }
    });

    it("validates the exact L4 lane/seat/map census and rejects duplicates, skips, rejections, and Armageddon", () => {
        const baseSeed = 77;
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
                    target: { appearances: 1, actingTurns: 1, rawEndTurnDecisions: 0 },
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
                rejectedCandidate: 0,
                rawEndTurnDecisions: 0,
                armageddonReached: 0,
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

        const broken = structuredClone(records);
        broken[0].rejectedCandidate = 1;
        broken[0].target.rawEndTurnDecisions = 1;
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
        expect(failed.gates.armageddonReachedRate.passed).toBe(false);
    });
});
