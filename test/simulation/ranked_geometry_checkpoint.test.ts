import { expect, test } from "bun:test";
import {
    lockedRankedGeometryCheckpoint,
    LOCKED_RANKED_GEOMETRY_ID,
} from "../../src/simulation/ranked_geometry_checkpoint";

test("the confirmed geometry checkpoint retains paired families and exact source bytes without serving activation", () => {
    const { evidence, policy } = lockedRankedGeometryCheckpoint();
    expect(evidence.checkpointId).toBe(LOCKED_RANKED_GEOMETRY_ID);
    expect(evidence.productionPromotion).toBe(false);
    expect(evidence.servingQualified).toBe(false);
    expect(new Set(evidence.familyScores.map((row) => row.task.id)).size).toBe(324);
    let current = 0;
    let candidate = 0;
    for (const row of evidence.familyScores) {
        expect(row.scores.map((scores) => scores.length)).toEqual([4, 4]);
        expect(row.scores.flat().every((score) => [0, 0.5, 1].includes(score))).toBe(true);
        current += row.scores[0].reduce((sum, value) => sum + value, 0);
        candidate += row.scores[1].reduce((sum, value) => sum + value, 0);
    }
    expect(current).toBe(588);
    expect(candidate).toBe(615);
    expect(((candidate - current) / 1296) * 100).toBe(evidence.primaryIndependentResult.contrast.gainPoints);
    expect(evidence.primaryIndependentResult.contrast.ci95Points[0]).toBeGreaterThan(0);
    expect(policy.files.map((source) => source.path)).toContain("plan.ts");
    expect(policy.files.map((source) => source.path)).toContain("native.ts");
    expect(policy.files.map((source) => source.path)).toContain("profiles.json");
});
