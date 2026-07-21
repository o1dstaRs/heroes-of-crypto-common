/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import {
    buildV08TestCandidateEnvironment,
    V08_TEST_CANDIDATE_GENOME,
    V08_TEST_CANDIDATE_GENOME_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING,
    V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
    V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256,
    V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES,
    V08_TEST_CANDIDATE_PROFILE,
    V08_TEST_CANDIDATE_RESEARCH_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_SOURCE_ALIAS_OPERATIONAL_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
    V08_TEST_CANDIDATE_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_TEST_CANDIDATE_SOURCE_ID,
} from "../../src/ai/versions/v0_8_candidate_profile";
import {
    buildV08AlignedV1CandidateEnvironment,
    fingerprintV08AlignedV1,
    fingerprintV08AlignedV1CandidateGenome,
    type IV08AlignedV1CandidateGenome,
} from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const mutableCandidateGenome = (): IV08AlignedV1CandidateGenome =>
    structuredClone(V08_TEST_CANDIDATE_GENOME) as IV08AlignedV1CandidateGenome;

describe("v0.8 immutable cross-host test candidate", () => {
    it("freezes the exact shared c32 gate-0.02 genome", () => {
        expect(fingerprintV08AlignedV1CandidateGenome(mutableCandidateGenome())).toBe(V08_TEST_CANDIDATE_GENOME_SHA256);
        expect(V08_TEST_CANDIDATE_GENOME).toMatchObject({
            search: {
                leafMode: "model",
                gate: 0.02,
                horizon: 12,
                rollouts: 2,
                includeMoves: true,
                maxMelee: 6,
                maxShots: 4,
                maxThrows: 2,
            },
            controls: {
                activeChallengers: true,
                shortlist: 3,
                decisionDeadlineMs: 175,
                placementReveal: true,
                denseMeleeMagicIsolation: false,
                auraCasterMode: "off",
            },
        });
        expect(V08_TEST_CANDIDATE_GENOME.search.leaf.w).toHaveLength(60);
        expect(
            fingerprintV08AlignedV1(
                buildV08AlignedV1CandidateEnvironment(mutableCandidateGenome(), "<worker-audit-path>"),
            ),
        ).toBe(V08_TEST_CANDIDATE_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256);
        expect(Object.isFrozen(V08_TEST_CANDIDATE_PROFILE)).toBe(true);
        expect(Object.isFrozen(V08_TEST_CANDIDATE_GENOME.search.leaf.w)).toBe(true);
    });

    it("records both independent source identities without treating the candidate as deployable", () => {
        expect(V08_TEST_CANDIDATE_PROFILE).toMatchObject({
            schemaVersion: 2,
            id: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
            sourceCandidateId: V08_TEST_CANDIDATE_SOURCE_ID,
            status: "test_only_requires_bounded_qualification",
            sourceReplayVersion: "v0.8s",
            operationalCandidateVersion: "v0.8",
            opponentVersion: "v0.7",
            testOnly: true,
            automaticBake: false,
            automaticDeploy: false,
            aggressivePolicy: {
                enabled: true,
                environmentKey: "V08_AGGRESSIVE",
                environmentValue: "1",
            },
            timing: {
                research: {
                    mode: "research_unbounded",
                    decisionDeadlineMs: null,
                    circuitBreakerMs: null,
                },
                operational: {
                    mode: "operational_bounded",
                    decisionDeadlineMs: 175,
                    circuitBreakerMs: 275,
                    qualificationRequired: true,
                },
            },
        });
        expect(V08_TEST_CANDIDATE_PROFILE.provenance.sourceRuns).toEqual([
            expect.objectContaining({ host: "m4-max", candidateId: "a00", validationGames: 57_344 }),
            expect.objectContaining({ host: "ryzen-9800x3d", candidateId: "a18", validationGames: 31_744 }),
        ]);
        expect(
            new Set(V08_TEST_CANDIDATE_PROFILE.provenance.sourceRuns.map((run) => run.sourceBindingSha256)).size,
        ).toBe(2);
        expect(
            new Set(V08_TEST_CANDIDATE_PROFILE.provenance.sourceRuns.map(() => V08_TEST_CANDIDATE_GENOME_SHA256)).size,
        ).toBe(1);
        expect(V08_TEST_CANDIDATE_PROFILE.provenance.historicalTrainingCodeSha256).toMatchObject({
            v08Strategy: "f2ca25a57242dbccb0fa089b2c81d570343df0134312a8617b18e5ebfa70c876",
            searchDriver: "1b962b4281d22944417c79bb6c1276e6aad9798cbff27f73ff215f755df56e74",
        });
        expect(V08_TEST_CANDIDATE_PROFILE.operationalPolicy.repinRule).toContain("requires");
    });

    it("reproduces the cross-host unbounded effective environment hash", () => {
        const environment = buildV08TestCandidateEnvironment({
            auditPath: V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
            timingMode: "research_unbounded",
        });
        expect({ ...environment }).toMatchObject({
            LIVETWIN: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "0.02",
            SEARCH_HORIZON: "12",
            SEARCH_ROLLOUTS: "2",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_ACTIVE_CHALLENGERS: "1",
            SEARCH_DECISION_DEADLINE_MS: "",
            SEARCH_CIRCUIT_BREAKER_MS: "",
            V07_PLACEMENT_REVEAL: "on",
            V08_AGGRESSIVE: "1",
        });
        expect(fingerprintV08AlignedV1(environment)).toBe(V08_TEST_CANDIDATE_RESEARCH_ENVIRONMENT_SHA256);
        expect(Object.isFrozen(environment)).toBe(true);
    });

    it("changes only the timing envelope when constructing bounded operational evidence", () => {
        const research = buildV08TestCandidateEnvironment({
            auditPath: "audit.jsonl",
            timingMode: "research_unbounded",
        });
        const operational = buildV08TestCandidateEnvironment({
            auditPath: "audit.jsonl",
            timingMode: "operational_bounded",
        });
        expect(operational.SEARCH_DECISION_DEADLINE_MS).toBe("175");
        expect(operational.SEARCH_CIRCUIT_BREAKER_MS).toBe("275");
        expect(
            fingerprintV08AlignedV1(
                buildV08TestCandidateEnvironment({
                    auditPath: V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
                    timingMode: "operational_bounded",
                }),
            ),
        ).toBe(V08_TEST_CANDIDATE_SOURCE_ALIAS_OPERATIONAL_ENVIRONMENT_SHA256);
        expect(
            fingerprintV08AlignedV1({
                ...operational,
                SEARCH_DECISION_DEADLINE_MS: "",
                SEARCH_CIRCUIT_BREAKER_MS: "",
            }),
        ).toBe(fingerprintV08AlignedV1(research));

        const canonicalBounded = buildV08AlignedV1CandidateEnvironment(mutableCandidateGenome(), "audit.jsonl");
        const withoutCampaignIdentity = Object.fromEntries(
            Object.entries(operational).filter(([key]) => key !== "LIVETWIN" && key !== "V08_AGGRESSIVE"),
        );
        expect(withoutCampaignIdentity).toEqual(canonicalBounded);
    });

    it("rebinds every candidate-only scope to plain v0.8 for stable operational playtests", () => {
        const environment = buildV08TestCandidateEnvironment({
            auditPath: V08_TEST_CANDIDATE_SOURCE_AUDIT_PATH,
            timingMode: "operational_bounded",
            candidateVersion: "v0.8",
        });
        expect({ ...environment }).toMatchObject({
            SEARCH_VERSIONS: "v0.8",
            V07_AURA_CASTER_ROUTER_VERSIONS: "v0.8",
            V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS: "v0.8",
            V07_PLACEMENT_REVEAL_VERSIONS: "v0.8",
        });
        expect(fingerprintV08AlignedV1(environment)).toBe(V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256);
    });

    it("pins a composite operational revision separately from historical training provenance", () => {
        expect(fingerprintV08AlignedV1(V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_FILES)).toBe(
            V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256,
        );
        expect(fingerprintV08AlignedV1(V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING)).toBe(
            V08_TEST_CANDIDATE_OPERATIONAL_POLICY_SHA256,
        );
        expect(V08_TEST_CANDIDATE_OPERATIONAL_POLICY_BINDING).toMatchObject({
            revision: 1,
            id: V08_TEST_CANDIDATE_OPERATIONAL_POLICY_ID,
            sourceCandidateId: V08_TEST_CANDIDATE_SOURCE_ID,
            candidateVersion: "v0.8",
            opponentVersion: "v0.7",
            operationalEnvironmentSha256: V08_TEST_CANDIDATE_OPERATIONAL_ENVIRONMENT_SHA256,
            sourceBundleSha256: V08_TEST_CANDIDATE_OPERATIONAL_SOURCE_BUNDLE_SHA256,
        });
    });

    it("is a pure builder that rejects ambiguous input without touching process.env", () => {
        const before = sha256(
            JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right))),
        );
        const first = buildV08TestCandidateEnvironment({ auditPath: "a.jsonl", timingMode: "research_unbounded" });
        const second = buildV08TestCandidateEnvironment({ auditPath: "b.jsonl", timingMode: "operational_bounded" });
        expect(first).not.toBe(second);
        expect(first.SEARCH_AUDIT).toBe("a.jsonl");
        expect(second.SEARCH_AUDIT).toBe("b.jsonl");
        expect(() => buildV08TestCandidateEnvironment({ auditPath: " ", timingMode: "research_unbounded" })).toThrow(
            "auditPath",
        );
        expect(() =>
            buildV08TestCandidateEnvironment({
                auditPath: "audit.jsonl",
                timingMode: "invalid" as "research_unbounded",
            }),
        ).toThrow("timingMode");
        expect(
            sha256(JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)))),
        ).toBe(before);
    });
});
