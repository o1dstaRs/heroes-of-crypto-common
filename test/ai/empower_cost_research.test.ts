import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import allocation from "../../docs/evidence/empower_allocation_results_20261115.json";
import cost from "../../docs/evidence/empower_cost_results_20261115.json";

test("the shared-cost inference source remains the registered research version", () => {
    const source = readFileSync(resolve(import.meta.dir, "../../src/ai/setup/empower_cost.ts"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(
        "71518eeb9e376358fe38870cc7d518b687f95ea1a0ce4ea41932dc07634e2618",
    );
});

test("both unsuccessful adopted-policy fits keep their independent banks closed", () => {
    for (const result of [allocation, cost]) {
        expect(result.status).toBe("no-development-finalist");
        expect(result.selected).toBeNull();
        expect(result.model).toBeNull();
        expect(result.qualificationOpened).toBe(false);
        expect(result.confirmationOpened).toBe(false);
        expect(result.productionPromotion).toBe(false);
        expect(result.recipes.every((recipe) => !recipe.eligible && recipe.gain < 0.005)).toBe(true);
    }
    expect(allocation.recipes).toHaveLength(24);
    expect(cost.recipes).toHaveLength(48);
});
