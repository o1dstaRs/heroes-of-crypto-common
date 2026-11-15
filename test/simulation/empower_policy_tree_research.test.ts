import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import registration from "../../docs/evidence/empower_policy_tree_registration_20261115.json";
import result from "../../docs/evidence/empower_policy_tree_results_20261115.json";

test("the failed direct policy study keeps its sealed implementation and null finalist", () => {
    expect(result.registrationSha256).toBe(registration.registrationSha256);
    expect(result.fit.scores).toHaveLength(18);
    expect(result.fit.scores.every((score) => !score.eligible)).toBe(true);
    expect(Math.max(...result.fit.scores.map((score) => score.gain))).toBeCloseTo(0.0019290123456790122, 12);
    expect(result.fit.model).toBeNull();
    expect(result.fit.selected).toBeNull();
    expect(result.modelActivated).toBe(false);
    expect(result.qualificationOpened).toBe(false);
    expect(result.confirmationOpened).toBe(false);
    expect(result.freshBanksAllocated).toBe(false);
    for (const path of ["src/ai/setup/empower_policy_tree.ts", "src/simulation/empower_policy_tree_training.ts"]) {
        const entry = registration.sources.find((source) => source.path.endsWith(path));
        expect(entry).toBeDefined();
        const hash = createHash("sha256")
            .update(readFileSync(new URL(`../../${path}`, import.meta.url)))
            .digest("hex");
        expect(hash).toBe(entry!.sha256);
    }
});
