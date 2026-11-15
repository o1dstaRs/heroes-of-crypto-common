import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import evidence from "../../docs/evidence/stationary_melee_value_20261115.json";

test("the stationary melee screen preserves its failed coverage gate and immutable helper", () => {
    const source = readFileSync(new URL("../../src/simulation/stationary_melee_value_research.ts", import.meta.url));
    expect(createHash("sha256").update(source).digest("hex")).toBe(evidence.helperSha256);
    expect(evidence.qualityPassed).toBe(true);
    expect(evidence.supportedTreatmentEstimates).toBeLessThan(evidence.requiredSupportedEstimates);
    expect(evidence.coveragePassed).toBe(false);
    expect(evidence.developmentOpened).toBe(false);
    expect(evidence.developmentExecutions).toBe(0);
    expect(evidence.productionPromotion).toBe(false);
    expect(evidence.functionalExecutions).toBe(18);
    expect(evidence.changedCandidateTrajectories).toBe(0);
    for (const row of evidence.cases) {
        expect(row.traceSha256.off).toBe(row.traceSha256.observe);
        expect(row.traceSha256.observe).toBe(row.traceSha256.treatment);
    }
});

test("the research helper is absent from serving and candidate entry points", () => {
    for (const path of [
        "ai/candidates.ts",
        "ai/index.ts",
        "simulation/search_driver.ts",
        "simulation/battle_engine.ts",
    ]) {
        expect(readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")).not.toContain(
            "stationary_melee_value_research",
        );
    }
});
