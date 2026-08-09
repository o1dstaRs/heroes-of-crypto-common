import { describe, expect, test } from "bun:test";

import type { IAIPolicyEvent } from "../../src/ai/ai_strategy";
import { selectV09RankedCandidate, v09FallbackRequiresCircuitBreaker } from "../../src/ai/versions/v0_9";
import { v09TeacherStudentActivationFailure } from "../../src/simulation/v0_9/teacher_actor";

type V09Decision = Extract<IAIPolicyEvent, { kind: "v0.9_decision" }>;

const MODEL_SHA = "a".repeat(64);

const decision = (overrides: Partial<V09Decision["details"]> = {}): V09Decision => ({
    kind: "v0.9_decision",
    team: 1,
    unitId: "unit-1",
    creatureName: "Archer",
    lap: 4,
    details: {
        artifactStatus: "trained",
        modelId: "v0.9-research",
        modelSha256: MODEL_SHA,
        selectedCandidateIndex: 0,
        selectedCandidateSignature: "[]",
        candidateCount: 1,
        anchorScore: 0,
        selectedScore: 0,
        margin: 0,
        elapsedMicros: 1,
        fallbackReason: null,
        circuitBreakerRecommended: false,
        ...overrides,
    },
});

describe("v0.9 DAgger student activation", () => {
    test("records a guarded learned-policy abstention without treating the legal anchor action as a circuit fault", () => {
        expect(selectV09RankedCandidate([0, 25], [false, false], 1)).toEqual({
            index: 0,
            fallbackReason: "no_safe_candidate",
        });
        expect(v09FallbackRequiresCircuitBreaker("no_safe_candidate")).toBe(false);
        expect(
            v09TeacherStudentActivationFailure(
                decision({ fallbackReason: "no_safe_candidate", circuitBreakerRecommended: false }),
                { studentTeams: [1], modelId: "v0.9-research", modelSha256: MODEL_SHA },
            ),
        ).toBeNull();
    });

    test("keeps genuine runtime faults strict and preserves actionable telemetry", () => {
        expect(v09FallbackRequiresCircuitBreaker("runtime_error")).toBe(true);
        const failure = v09TeacherStudentActivationFailure(
            decision({ fallbackReason: "runtime_error", circuitBreakerRecommended: true, candidateCount: 0 }),
            { studentTeams: [1], modelId: "v0.9-research", modelSha256: MODEL_SHA },
        );
        expect(failure).toEqual({
            team: 1,
            unitId: "unit-1",
            creatureName: "Archer",
            lap: 4,
            reasons: ["circuit_breaker_recommended", "selected_candidate_out_of_range"],
            fallbackReason: "runtime_error",
            circuitBreakerRecommended: true,
            candidateCount: 0,
            selectedCandidateIndex: 0,
        });
    });
});
