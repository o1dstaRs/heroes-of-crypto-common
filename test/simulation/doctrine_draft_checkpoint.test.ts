import { describe, expect, test } from "bun:test";

import evidence from "../../src/ai/setup/doctrine_draft/doctrine_draft_v3_20261104/evidence.json";
import registration from "../../src/ai/setup/doctrine_draft/doctrine_draft_v3_20261104/registration.json";
import decisions from "../../src/ai/setup/doctrine_draft/doctrine_draft_v3_20261104/decision_regressions.json";
import overallRegistration from "../../docs/evidence/v0_9_locked_draft_overall_confirmation_20261105.json";
import continuationRegistration from "../../docs/evidence/v0_9_doctrine_draft_v4_registration_20261105.json";
import {
    LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
    lockedDoctrineDraftModel,
    lockedDoctrineDraftOverallConfirmation,
} from "../../src/simulation/doctrine_draft/doctrine_draft_checkpoint";
import { predictDoctrineDraftGain } from "../../src/ai/setup/doctrine_draft/doctrine_draft_model";
import { canonicalJsonSha256 } from "../../src/simulation/canonical_json";

describe("locked V3 doctrine draft benchmark", () => {
    test("preserves the exact fitted weights and their independently verified provenance", () => {
        const model = lockedDoctrineDraftModel();
        expect(canonicalJsonSha256(model)).toBe(LOCKED_DOCTRINE_DRAFT_MODEL_SHA256);
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

    test("ties fresh overall confirmation to the fixed model and excludes every original seed channel", () => {
        const confirmation = lockedDoctrineDraftOverallConfirmation();
        const { registrationSha256, ...registrationBody } = overallRegistration;
        expect(canonicalJsonSha256(registrationBody)).toBe(registrationSha256);
        expect(confirmation.result.registrationSha256).toBe(registrationSha256);
        expect(confirmation.result.evaluationRegistrationSha256).toBe(continuationRegistration.registrationSha256);
        expect(confirmation.result.sourceSha256).toBe(continuationRegistration.sourceSha256);
        expect(overallRegistration.boardSeeds).toEqual(continuationRegistration.banks.development);
        expect(confirmation.result.modelSha256).toBe(LOCKED_DOCTRINE_DRAFT_MODEL_SHA256);
        expect(confirmation.result.passed).toBe(true);
        expect(confirmation.independentVerification.passed).toBe(true);
        expect(confirmation.result.originalScoutingGatePassed).toBe(false);
        expect(confirmation.result.originalConfirmationBankOpened).toBe(false);
        expect(confirmation.productionPromotion).toBe(false);
        const priorChannels = new Set(
            Object.values(registration.banks).flatMap((bank) => bank.flatMap((seed) => [seed, seed + 1, seed + 2])),
        );
        const nextChannels = Object.values(continuationRegistration.banks).flatMap((bank) =>
            bank.flatMap((seed) => [seed, seed + 1, seed + 2]),
        );
        expect(nextChannels.some((seed) => priorChannels.has(seed))).toBe(false);
        confirmation.scoreDeltaEighths[0] += 8;
        expect(lockedDoctrineDraftOverallConfirmation().scoreDeltaEighths[0]).not.toBe(
            confirmation.scoreDeltaEighths[0],
        );
    });
});
