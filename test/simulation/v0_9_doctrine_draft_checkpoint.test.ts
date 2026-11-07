import { describe, expect, test } from "bun:test";

import evidence from "../../src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/evidence.json";
import registration from "../../src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/registration.json";
import decisions from "../../src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/decision_regressions.json";
import overallRegistration from "../../docs/evidence/v0_9_locked_draft_overall_confirmation_20261105.json";
import continuationRegistration from "../../docs/evidence/v0_9_doctrine_draft_v4_registration_20261105.json";
import { v09DoctrineBoard, V09_A19_DOCTRINES } from "../../src/simulation/v0_9/a19_doctrine_population";
import {
    LOCKED_DOCTRINE_DRAFT_MODEL_SHA256,
    lockedDoctrineDraftModel,
    lockedDoctrineDraftOverallConfirmation,
} from "../../src/simulation/v0_9/doctrine_draft_checkpoint";
import { predictDoctrineDraftGain } from "../../src/simulation/v0_9/doctrine_draft_model";
import {
    doctrineDraftEvaluationPassed,
    validateDoctrineDraftRegistration,
    pairedDoctrineDraftStatistics,
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

    test("ties fresh overall confirmation to the fixed model and excludes every original seed channel", () => {
        const confirmation = lockedDoctrineDraftOverallConfirmation();
        const { registrationSha256, ...registrationBody } = overallRegistration;
        expect(fingerprintV09(registrationBody)).toBe(registrationSha256);
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
        expect(() =>
            validateDoctrineDraftRegistration(continuationRegistration as IDoctrineDraftRegistration),
        ).not.toThrow();
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

    test("replays the independently verified confirmation intervals from all 1080 paired board scores", () => {
        const confirmation = lockedDoctrineDraftOverallConfirmation();
        expect(confirmation.scoreDeltaEighths).toHaveLength(overallRegistration.boards);
        const rows = confirmation.scoreDeltaEighths.map((score, board) => {
            const { candidateDoctrinePolicy, opponentDoctrinePolicy } = v09DoctrineBoard(
                board,
                "balanced-doctrines-v1",
            );
            if (candidateDoctrinePolicy === "ranked-variety" || opponentDoctrinePolicy === "ranked-variety")
                throw new Error("Confirmation doctrine schedule changed");
            expect(Number.isInteger(score) && Math.abs(score) <= 8).toBe(true);
            return {
                board,
                map: [1, 3, 4][board % 3],
                candidateDoctrinePolicy,
                opponentDoctrinePolicy,
                delta: score / 8,
            };
        });
        expect(pairedDoctrineDraftStatistics(rows)).toEqual(confirmation.result.pooled);
        for (const doctrine of V09_A19_DOCTRINES) {
            const selected = rows.filter((row) => row.candidateDoctrinePolicy === doctrine);
            expect(pairedDoctrineDraftStatistics(selected)).toEqual(confirmation.result.doctrines[doctrine]);
        }
        expect(rows.filter((row) => row.candidateDoctrinePolicy === "see-none").every((row) => row.delta === 0)).toBe(
            true,
        );
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
