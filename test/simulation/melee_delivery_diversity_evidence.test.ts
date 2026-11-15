import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import evidence from "../../docs/evidence/melee_delivery_diversity_20261115.json";
import { MELEE_DELIVERY_DIVERSITY_RESEARCH_ID } from "../../src/simulation/melee_delivery_diversity_research";

describe("closed melee delivery diversity experiment", () => {
    test("retains the fixed candidate and the corrected, reproducible measurement provenance", () => {
        expect(evidence.policyId).toBe(MELEE_DELIVERY_DIVERSITY_RESEARCH_ID);
        expect(evidence.registrationSha256).toBe("9e8f698bc871d12fefc27984681051dd8ccd34abf526b42bba8df5cd5d6298ab");
        const helper = readFileSync(new URL(`../../${evidence.helper.path}`, import.meta.url));
        expect(createHash("sha256").update(helper).digest("hex")).toBe(evidence.helper.sha256);
        expect(evidence.initialAttempt.registrationSha256).toBe(
            "85a3c390325bcec343c2842fecf1d3dca97e790cdbfa9a15c4b3a44220cfcb07",
        );
        expect(evidence.initialAttempt.allOutcomeRowsExcluded).toBe(true);
        expect(evidence.initialAttempt.completedRawRows).toBeGreaterThan(0);
        expect(evidence.initialAttempt.distinctFormations).toBeGreaterThan(1);
        expect(evidence.correctedOpeningChecks).toEqual({ repetitions: 12, distinctFormations: 1, distinctConfigs: 1 });
        expect(evidence.admission.passed).toBe(true);
        expect(evidence.admission.executions).toBe(162);
        expect(evidence.admission.exactOffObserverPairs).toBe(54);
        expect(evidence.coldProcessReplay.passed).toBe(true);
        expect(evidence.coldProcessReplay.cases).toBe(9);
        expect(evidence.independentVerification.passed).toBe(true);
        expect(evidence.independentVerification.seals).toBe(2543);
    });

    test("preserves every family, the complete score contrast and the failed prospective gates", () => {
        const result = evidence.development;
        expect(result.complete).toBe(true);
        expect(result.families).toBe(162);
        expect(result.executions).toBe(1296);
        expect(result.familyDeltas).toHaveLength(162);
        expect(new Set(result.familyDeltas.map((row) => row.board)).size).toBe(162);
        const integers = result.familyDeltas.map((row) => row.difference * 8);
        expect(integers.every(Number.isInteger)).toBe(true);
        expect(integers.reduce((sum, value) => sum + value, 0) / (8 * integers.length)).toBe(result.pairedGain);
        for (const arm of [result.arms.off, result.arms.treatment]) {
            expect(arm.wins + arm.draws + arm.losses).toBe(648);
            expect((arm.wins + 0.5 * arm.draws) / 648).toBe(arm.score);
        }
        expect(result.pairedGain).toBeCloseTo(0.0007716049382716049, 14);
        expect(result.wholeFamilyInterval95).toEqual([-0.004629629629629629, 0.006944444444444444]);
        expect(result.exactTwoSidedP).toBe(1);
        expect(evidence.analysisDesign.fundingGate.gainAtLeast).toBe(0.005);
        expect(result.pairedGain >= 0.005).toBe(false);
        expect(Object.values(result.byBudget).every((row) => row.gain >= 0)).toBe(false);
        expect(Object.values(result.byBudget).map((row) => row.gamesPerArm)).toEqual([216, 216, 216]);
        expect(result.gates.zeroQualityErrors).toBe(true);
        expect(result.developmentGate).toBe(false);
        expect(result.changedTrajectoryCases).toBe(53);
        expect(result.improvedCases).toBe(3);
        expect(result.worsenedCases).toBe(3);
        expect(result.arms.treatment.coverage.changedCatalogs).toBe(655);
        expect(Object.keys(result.arms.treatment.coverage.names)).toHaveLength(31);
    });

    test("does not turn a development result into an opened fresh bank or a serving policy", () => {
        expect(evidence.newIndependentChannels).toBe(0);
        expect(evidence.freshQualificationOpened).toBe(false);
        expect(evidence.freshConfirmationOpened).toBe(false);
        expect(evidence.productionPromotion).toBe(false);
        expect(evidence.development.independentlyQualified).toBe(false);
        expect(evidence.development.productionPromotion).toBe(false);
        for (const path of ["src/ai/index.ts", "src/ai/candidates.ts", "src/simulation/search_driver.ts"]) {
            const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
            expect(source).not.toContain("melee_delivery_diversity_research");
            expect(source).not.toContain("researchMeleeDeliveryMode");
        }
    });
});
