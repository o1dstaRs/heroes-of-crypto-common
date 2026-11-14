import { expect, test } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { protectedAxisEmpowerPlan } from "../../src/ai/setup/empower_protected_axis";
import { empowerSetupPlan } from "../../src/ai/setup/empower_setup";

const own = ["Wandering Mage", "Orc", "Healer", "Elf", "Nightmare", "Magic Dragon"].map((name) =>
    creatureIdForName(name)!,
);

test("one-point Empower retains Sniper at every doctrine budget and accounts for its actual donor", () => {
    for (const budget of [5, 6, 7]) {
        const baseline = empowerSetupPlan(budget, own, 0);
        const plan = protectedAxisEmpowerPlan(budget, own, 1);
        expect(plan.reduce((sum, entry) => sum + entry.value, 0)).toBe(budget);
        expect(plan.find((entry) => entry.kind === "Empower")?.value).toBe(1);
        expect(plan.find((entry) => entry.kind === "Sniper")).toEqual(
            baseline.find((entry) => entry.kind === "Sniper"),
        );
        const donor = baseline.some((entry) => entry.kind === "Might") ? "Might" : "Armor";
        expect(plan.find((entry) => entry.kind === donor)?.value ?? 0).toBe(
            baseline.find((entry) => entry.kind === donor)!.value - 1,
        );
        expect(protectedAxisEmpowerPlan(budget, own, 0)).toEqual(baseline);
    }
    expect(() => protectedAxisEmpowerPlan(5, own, 2)).toThrow();
});
