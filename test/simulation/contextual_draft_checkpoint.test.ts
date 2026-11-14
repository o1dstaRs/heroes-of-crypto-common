import { expect, test } from "bun:test";
import evidence from "../../docs/evidence/contextual_draft_results_20261110.json";
import checkpoint from "../../src/simulation/checkpoints/contextual_draft_20261110/checkpoint.json";
import {
    CONTEXTUAL_DRAFT_MODEL_SHA256,
    CONTEXTUAL_DRAFT_REGISTRATION_SHA256,
    lockedContextualDraftResearchModels,
} from "../../src/simulation/contextual_draft_checkpoint";
import { predictContextualDraft } from "../../src/simulation/contextual_draft_research";

test("both contextual draft research heads retain exact immutable weights and helper sources", () => {
    const models = lockedContextualDraftResearchModels();
    expect(models.full.weights.length).toBe(232);
    expect(models.ablated.weights.length).toBe(232);
    expect(models.full.information).toBe("full");
    expect(models.ablated.information).toBe("without-map-synergies");
    expect(Object.isFrozen(models.full)).toBe(true);
    expect(Object.isFrozen(models.full.weights)).toBe(true);
    expect(Object.isFrozen(models.ablated.weights)).toBe(true);
    expect(checkpoint.models.full.canonicalSha256).toBe(CONTEXTUAL_DRAFT_MODEL_SHA256.full);
    expect(checkpoint.models["without-map-synergies"].canonicalSha256).toBe(CONTEXTUAL_DRAFT_MODEL_SHA256.ablated);
    for (const row of checkpoint.numericCases) {
        expect(predictContextualDraft(models.full, row.features)).toBeCloseTo(row.predictions.full, 14);
        expect(predictContextualDraft(models.ablated, row.features)).toBeCloseTo(
            row.predictions["without-map-synergies"],
            14,
        );
    }
});

test("completed evidence preserves the overall gains and the narrowly failed ordinary-opponent safety gate", () => {
    expect(evidence.registrationSha256).toBe(CONTEXTUAL_DRAFT_REGISTRATION_SHA256);
    expect(evidence.verifiedRawRows).toBe(44968);
    expect(evidence.verifiedSourceFiles).toBe(709);
    expect(evidence.verifiedPairedTrainingExamples).toBe(4320);
    expect(evidence.pairedBoardScores.length).toBe(1728);
    const total = (column: number) => evidence.pairedBoardScores.reduce((sum, row) => sum + Number(row[column]), 0);
    expect(total(3)).toBe(3128);
    expect(total(4)).toBe(3244);
    expect(total(5)).toBe(3365);
    expect(total(6)).toBe(3362.5);
    expect(evidence.result.comparisons.current.overall.familyAdjusted95Pp[0]).toBeGreaterThan(0);
    expect(evidence.result.comparisons.locked.overall.familyAdjusted95Pp[0]).toBeGreaterThan(0);
    expect(evidence.result.comparisons.locked.current.familyAdjusted95Pp[0]).toBe(-1.0127314814814814);
    expect(evidence.independentlyReconstructedComparisons["locked:current"].passed).toBe(false);
    expect(evidence.result.observedTimeRatios.current.elapsedMs).toBeLessThan(1.1);
    expect(evidence.result.contextAblationDiagnostic.causalContextGainSupported).toBe(false);
    expect(evidence.qualificationPassed).toBe(false);
    expect(evidence.confirmationOpened).toBe(false);
    expect(evidence.productionPromotion).toBe(false);
});
