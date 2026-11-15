import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import evidence from "../../docs/evidence/magic_empower_joint_development_20261115.json";
import compatibility from "../../docs/evidence/a19_latest_compatibility_20261115.json";

test("the failed factorial comparison preserves all families and never becomes independent qualification", () => {
    const result = evidence.result;
    expect(result.rows).toHaveLength(72);
    expect(result.comparisonRows).toBe(576);
    expect(result.executedFights).toBe(556);
    const mean = (a: number, b: number) =>
        result.rows.reduce((sum, row) => sum + row.scores[a] - row.scores[b], 0) / result.rows.length;
    expect(mean(3, 0)).toBeCloseTo(-0.04513888888888889, 12);
    expect(mean(3, 2)).toBe(-0.0625);
    expect(mean(3, 1)).toBe(0);
    expect(result.gate).toBe(false);
    expect(result.newIndependentFamilies).toBe(0);
    expect(evidence.newSeedChannels).toEqual([]);
    expect(evidence.modelActivated).toBe(false);
    expect(evidence.qualificationOpened).toBe(false);
    expect(evidence.confirmationOpened).toBe(false);
    expect(evidence.preflight.observeOnlyComparisons).toBeGreaterThan(0);
    for (const path of ["src/simulation/magic_dragon_precision_research.ts", "src/ai/setup/empower_allocation.ts"]) {
        const expected = evidence.criticalSources.find((source) => source.path === `sources/common/${path}`);
        const hash = createHash("sha256")
            .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
            .digest("hex");
        expect(hash).toBe(expected!.sha256);
    }
});

test("latest-source and synthetic Champion compatibility are functional evidence only", () => {
    expect(compatibility.passed).toBe(true);
    expect(compatibility.executedFights).toBe(216);
    expect(compatibility.championStress.executedFights).toBe(36);
    expect(compatibility.totalExecutedFights).toBe(252);
    expect(compatibility.newIndependentStrengthGames).toBe(0);
    expect(compatibility.championStress.newIndependentStrengthGames).toBe(0);
    expect(compatibility.championStress.syntheticChampion).toBe(true);
    expect(compatibility.searchStatisticsUniqueCases.modelErrors).toBe(0);
    expect(compatibility.championStress.neuralStatisticsUniqueCases.modelErrors).toBe(0);
});
