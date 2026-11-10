import { expect, test } from "bun:test";
import completed from "../../docs/evidence/ranged_counter_situational_results_20261109.json";
import learned from "../../docs/evidence/learned_ranged_setup_20261109.json";
import learnedResult from "../../docs/evidence/learned_ranged_setup_results_20261109.json";
import { LEARNED_RANGED_SETUP_MODEL_SHA256 } from "../../src/simulation/learned_ranged_setup_checkpoint";

test("the larger completed setup study retains its paired outcomes and failed qualification", () => {
    expect(completed.pairedBoardScores.length).toBe(1080);
    expect(completed.qualificationPassed).toBe(false);
    expect(completed.confirmationOpened).toBe(false);
    expect(completed.productionPromotion).toBe(false);
    const sum = (column: number): number => completed.pairedBoardScores.reduce((total, row) => total + row[column], 0);
    expect(sum(2)).toBe(2066.5);
    expect(sum(3)).toBe(2114);
    expect(sum(4)).toBe(2101.5);
    expect(((sum(3) - sum(2)) / 4320) * 100).toBeCloseTo(1.099537037037037, 12);
    expect(completed.result.comparisons.free.comparisons.current.familyAdjusted95Pp[0]).toBeLessThan(0);
    expect(completed.result.comparisons.situational.comparisons.current.familyAdjusted95Pp[0]).toBeLessThan(0);
});

test("internal fitting stays separate from the fixed independent learned-setup banks", () => {
    expect(learned.modelCanonicalSha256).toBe(LEARNED_RANGED_SETUP_MODEL_SHA256);
    expect(learned.fitReport.trainBoards).toBe(810);
    expect(learned.fitReport.internalDevelopmentBoards).toBe(270);
    expect(learned.fitReport.finalModelFitRows).toBe(2160);
    expect(learned.fitReport.candidates.length).toBe(12);
    expect(learned.fitReport.independentBattleStrengthClaim).toBe(false);
    expect(learned.productionPromotion).toBe(false);
    expect(learned.banks.qualification.length).toBe(1080);
    expect(learned.banks.confirmation.length).toBe(1512);
    expect(new Set(learned.reservedActualChannels).size).toBe(15552);
    expect(learned.priorChannelAudit.conflicts).toEqual([]);
});

test("the user-locked learned result keeps the baseline gain and failed stronger-control gates", () => {
    expect(learnedResult.modelCanonicalSha256).toBe(LEARNED_RANGED_SETUP_MODEL_SHA256);
    expect(learnedResult.pairedBoardScores.length).toBe(1080);
    expect(learnedResult.rawRowsVerified).toBe(17312);
    const total = (column: number): number =>
        learnedResult.pairedBoardScores.reduce((sum, row) => sum + Number(row[column]), 0);
    expect(total(3)).toBe(2031);
    expect(total(4)).toBe(2132);
    expect(total(5)).toBe(2091.5);
    expect(total(6)).toBe(2141);
    expect(learnedResult.result.comparisons.current.overall.familyAdjusted95Pp[0]).toBeGreaterThan(0);
    expect(learnedResult.result.comparisons.free.overall.familyAdjusted95Pp[0]).toBeLessThan(0);
    expect(learnedResult.result.observedFightTimeRatio).toBeLessThan(1.1);
    expect(learnedResult.qualificationPassed).toBe(false);
    expect(learnedResult.confirmationOpened).toBe(false);
    expect(learnedResult.productionPromotion).toBe(false);
});
