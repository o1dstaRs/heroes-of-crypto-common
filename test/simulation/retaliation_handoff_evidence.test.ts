import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import evidence from "../../docs/evidence/retaliation_handoff_20261115.json";

describe("closed retaliation handoff evidence", () => {
    test("preserves the measured helper, native-filter correction and exact control provenance", () => {
        const source = readFileSync(new URL(`../../${evidence.helperPath}`, import.meta.url));
        expect(createHash("sha256").update(source).digest("hex")).toBe(evidence.helperSha256);
        expect(evidence.registrationSha256).toBe("5ddde8da61d439d9e135c0393b2c7886da61210c8e2d7b61155b2d5869412ed6");
        expect(evidence.preflight.passed).toBe(true);
        expect(evidence.preflight.exactOffObserverPairs).toBe(54);
        expect(evidence.preflight.coverage.eligibleDecisions).toBe(32);
        expect(evidence.preflight.coverage.nativeGuardVetoes).toBe(4);
        expect(evidence.coldProcessReplay.passed).toBe(true);
        expect(evidence.coldProcessReplay.cases).toBe(9);
        expect(evidence.fullControlReplay.matchedIndependentControls).toBe(648);
        expect(evidence.analysisCorrection.policyChanged).toBe(false);
        expect(evidence.analysisCorrection.gatesChanged).toBe(false);
        expect(evidence.analysisCorrection.outcomeAggregatesReadBeforeCorrection).toBe(false);
        expect(evidence.originalAnalyzerFailure.status).toBe("error");
    });

    test("retains every family and independently verified failed score gate", () => {
        const result = evidence.development;
        expect(result.complete).toBe(true);
        expect(result.executions).toBe(1296);
        expect(result.families).toBe(162);
        expect(result.familyDeltas.length).toBe(162);
        expect(new Set(result.familyDeltas.map((row) => row.board)).size).toBe(162);
        expect(result.familyDeltas.map((row) => row.board)).toEqual(evidence.reusedFamilies.map((row) => row.board));
        const mean = result.familyDeltas.reduce((sum, row) => sum + row.difference, 0) / result.families;
        expect(mean).toBe(1.5 / 648);
        expect(mean).toBe(result.pairedGain);
        for (const arm of [result.arms.off, result.arms.treatment]) {
            expect(arm.wins + arm.draws + arm.losses).toBe(648);
            expect(arm.score).toBe((arm.wins + arm.draws / 2) / 648);
        }
        expect(result.wholeFamilyInterval95).toEqual([-3 / 648, 6 / 648]);
        expect(result.exactTwoSidedP).toBe(44 / 64);
        expect(result.gates).toEqual({
            gainAtLeastHalfPoint: false,
            allOwnBudgetsNonnegative: true,
            zeroQualityErrors: true,
        });
        expect(result.developmentGate).toBe(false);
        expect(evidence.independentVerification.passed).toBe(true);
        expect(evidence.independentVerification.pairedGain).toBe(mean);
        expect(evidence.independentVerification.wholeFamilyInterval95).toEqual(result.wholeFamilyInterval95);
        expect(result.arms.treatment.coverage.chosenWaits).toBe(127);
        expect(result.changedTrajectoryCases).toBe(102);
    });

    test("does not reopen fresh banks or introduce the failed helper into serving search", () => {
        expect(evidence.newIndependentChannels).toBe(0);
        expect(evidence.freshQualificationOpened).toBe(false);
        expect(evidence.freshConfirmationOpened).toBe(false);
        expect(evidence.independentlyQualified).toBe(false);
        expect(evidence.productionTimingQualified).toBe(false);
        expect(evidence.defaultChanged).toBe(false);
        expect(evidence.development.productionPromotion).toBe(false);
        const driver = readFileSync(new URL("../../src/simulation/search_driver.ts", import.meta.url), "utf8");
        expect(driver).not.toContain("retaliation_handoff_research");
        expect(driver).not.toContain("retaliationHandoffOpportunity");
    });
});
