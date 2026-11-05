import { describe, expect, test } from "bun:test";

import evidence from "../../src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/evidence.json";
import registration from "../../src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/registration.json";
import decisions from "../../src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/decision_regressions.json";
import {
    LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
    lockedDoctrineDraftModel,
} from "../../src/simulation/v0_9/doctrine_draft_checkpoint";
import { predictDoctrineDraftGain } from "../../src/simulation/v0_9/doctrine_draft_model";
import {
    doctrineDraftEvaluationPassed,
    validateDoctrineDraftRegistration,
    type IDoctrineDraftRegistration,
} from "../../src/simulation/v0_9/doctrine_draft_training";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";

describe("locked V3 doctrine draft benchmark", () => {
    test("preserves the exact fitted weights and their independently verified provenance", () => {
        const model = lockedDoctrineDraftModel();
        expect(fingerprintV09(model)).toBe(LOCKED_DOCTRINE_DRAFT_MODEL_SHA256);
        expect(evidence.fit.modelSha256).toBe(LOCKED_DOCTRINE_DRAFT_MODEL_SHA256);
        expect(evidence.trainingVerification.maximumWeightError).toBe(0);
        expect(evidence.developmentVerification.verified).toBe(true);
        expect(evidence.development.comparisons.current.pooled.lower95).toBeGreaterThan(0);
        expect(evidence.development.comparisons.masked.pooled.lower95).toBe(0);
        expect(evidence.development.passed).toBe(false);
        expect(evidence.confirmationOpened).toBe(false);
        expect(model.productionPromotion).toBe(false);
        expect(Object.isFrozen(model.weights)).toBe(true);
        expect(Object.isFrozen(model.scales)).toBe(true);
        expect(() => validateDoctrineDraftRegistration(registration as IDoctrineDraftRegistration)).not.toThrow();
    });

    test("reproduces saved evaluation choices at every learned decision level and in both information conditions", () => {
        const model = lockedDoctrineDraftModel();
        expect(decisions).toHaveLength(32);
        for (const row of decisions) {
            const gain = predictDoctrineDraftGain(model, row.features);
            expect(gain).toBeCloseTo(row.predictedGain, 12);
            expect(gain > model.switchMargin).toBe(row.switches);
        }
    });

    test("further iterations must improve over the locked model as well as both original controls", () => {
        const score = { boards: 1080, gain: 0.03, lower95: 0.01, upper95: 0.05 };
        const comparison = {
            pooled: score,
            doctrines: { "see-all": score, "three-reveals": score, "see-none": { ...score, gain: 0 } },
        };
        const original = { current: comparison, masked: comparison };
        expect(doctrineDraftEvaluationPassed("v3", original)).toBe(true);
        expect(doctrineDraftEvaluationPassed("v4", original)).toBe(false);
        expect(doctrineDraftEvaluationPassed("v4", { ...original, locked: comparison })).toBe(true);
        expect(
            doctrineDraftEvaluationPassed("v4", {
                ...original,
                locked: { ...comparison, pooled: { ...score, lower95: 0 } },
            }),
        ).toBe(false);
        expect(
            doctrineDraftEvaluationPassed("v4", {
                ...original,
                locked: { ...comparison, doctrines: { ...comparison.doctrines, "see-all": { ...score, gain: -0.01 } } },
            }),
        ).toBe(false);
    });
});
