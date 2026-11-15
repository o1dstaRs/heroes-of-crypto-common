import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import evidence from "../../docs/evidence/chakram_screen_move_20261115.json";

describe("Chakram screen movement evidence", () => {
    test("preserves source identity, order-only audit correction and exact control replays", () => {
        const source = readFileSync(new URL(`../../${evidence.helperPath}`, import.meta.url));
        expect(createHash("sha256").update(source).digest("hex")).toBe(evidence.helperSha256);
        expect(evidence.registrationSha256).toBe("94405e2c05ef9853535a4c5dc4e1e69eae3ffcac0478c803a78122209d37d1d8");
        expect(evidence.sealedFileCount).toBe(2562);
        expect(evidence.preflight.passed).toBe(true);
        expect(evidence.preflight.executions).toBe(324);
        expect(evidence.preflight.exactOffObserverPairs).toBe(108);
        expect(evidence.preflight.coverage.eligibleDecisions).toBe(284);
        expect(evidence.preflight.coverage.chosenMoves).toBe(36);
        expect(evidence.coldProcessReplay.passed).toBe(true);
        expect(evidence.coldProcessReplay.cases).toBe(9);
        expect(evidence.fullControlReplay.matchedIndependentControls).toBe(648);
        expect(evidence.analysisCorrection.policyChanged).toBe(false);
        expect(evidence.analysisCorrection.casesChanged).toBe(false);
        expect(evidence.analysisCorrection.gatesChanged).toBe(false);
        expect(evidence.analysisCorrection.strengthAnalysisChanged).toBe(false);
        expect(evidence.analysisCorrection.outcomeAggregatesReadBeforeCorrection).toBe(false);
        expect(evidence.originalAnalyzerFailure.status).toBe("error");
        const counterexample = evidence.analysisCorrection.counterexampleReceipt;
        expect(counterexample.result).toBeNull();
        expect(counterexample.appended).toBe(false);
        const normalize = (actions: typeof counterexample.before) =>
            actions.map((sequence) =>
                sequence.map((action) => ({
                    ...action,
                    targetCells: [...action.targetCells].sort((a, b) => a.x - b.x || a.y - b.y),
                })),
            );
        expect(counterexample.before).not.toEqual(counterexample.after);
        expect(normalize(counterexample.before)).toEqual(normalize(counterexample.after));
    });

    test("retains every family, paired scores and independently verified development gate", () => {
        const result = evidence.development;
        expect(result.complete).toBe(true);
        expect(result.executions).toBe(1296);
        expect(result.families).toBe(162);
        expect(result.familyDeltas.length).toBe(162);
        expect(new Set(result.familyDeltas.map((row) => row.board)).size).toBe(162);
        expect(result.familyDeltas.map((row) => row.board)).toEqual(evidence.reusedFamilies.map((row) => row.board));
        const mean = result.familyDeltas.reduce((sum, row) => sum + row.difference, 0) / result.families;
        expect(mean).toBe(result.pairedGain);
        for (const arm of [result.arms.off, result.arms.treatment]) {
            expect(arm.wins + arm.draws + arm.losses).toBe(648);
            expect(arm.score).toBe((arm.wins + arm.draws / 2) / 648);
        }
        const ownBudgetsNonnegative = Object.values(result.byBudget).every((row) => row.gain >= 0);
        expect(result.gates).toEqual({
            gainAtLeastHalfPoint: mean >= 0.005,
            allOwnBudgetsNonnegative: ownBudgetsNonnegative,
            zeroQualityErrors: true,
        });
        expect(result.developmentGate).toBe(mean >= 0.005 && ownBudgetsNonnegative);
        expect(evidence.independentVerification.passed).toBe(true);
        expect(evidence.independentVerification.pairedGain).toBe(mean);
        expect(evidence.independentVerification.wholeFamilyInterval95).toEqual(result.wholeFamilyInterval95);
        expect(mean).toBe(-1 / 648);
        expect(result.wholeFamilyInterval95).toEqual([-9.5 / 648, 7.5 / 648]);
        expect(result.exactTwoSidedP).toBe(238120 / 262144);
        expect(result.developmentGate).toBe(false);
        expect(result.byBudget["6"].gain).toBe(-2.5 / 216);
        expect(result.arms.treatment.coverage.chosenMoves).toBe(141);
        expect(result.changedTrajectoryCases).toBe(122);
        expect(evidence.firstDifferenceDescription.allFirstChangesAreActionChoices).toBe(true);
        expect(evidence.firstDifferenceDescription.sameRawIncumbentAtEveryFirstChange).toBe(true);
        expect(evidence.firstDifferenceDescription.firstChoiceMechanisms.extra_move_selected).toBe(77);
    });

    test("keeps development evidence separate from independent qualification and serving behavior", () => {
        expect(evidence.newIndependentChannels).toBe(0);
        expect(evidence.freshQualificationOpened).toBe(false);
        expect(evidence.freshConfirmationOpened).toBe(false);
        expect(evidence.independentlyQualified).toBe(false);
        expect(evidence.productionTimingQualified).toBe(false);
        expect(evidence.defaultChanged).toBe(false);
        expect(evidence.development.productionPromotion).toBe(false);
        for (const path of ["src/simulation/search_driver.ts", "src/ai/candidates.ts"]) {
            const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
            expect(source).not.toContain("chakram_screen_move_research");
            expect(source).not.toContain("__chakramScreen");
        }
    });
});
