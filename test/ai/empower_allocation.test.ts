import { expect, test } from "bun:test";
import { empowerSetupPlan } from "../../src/ai/setup/empower_setup";
import {
    EMPOWER_ALLOCATION_FEATURES,
    EMPOWER_ALLOCATION_SCHEMA,
    empowerAllocationPlan,
    selectEmpowerAllocation,
    type IEmpowerAllocationModel,
} from "../../src/ai/setup/empower_allocation";
import type { IPlacementSetupDecisionContext } from "../../src/ai/setup/setup_strategy";

const own = [49, 1, 55, 4, 8, 57];
const context: IPlacementSetupDecisionContext = {
    decisionPhase: "placement",
    opponentRosterVisibility: "complete",
    publicOpponentCreatureIds: [2, 3, 14, 5, 18, 9],
    gridType: 1,
    gridSize: 16,
    ownDoctrine: 3,
    ownArtifactIds: [1, 1],
    synergyVariants: { Life: 1, Chaos: 1, Might: 1, Nature: 1 },
};
const model: IEmpowerAllocationModel = {
    schema: EMPOWER_ALLOCATION_SCHEMA,
    features: EMPOWER_ALLOCATION_FEATURES,
    margin: 0.03,
    heads: Array.from({ length: 6 }, (_, index) => ({
        b: index === 5 ? 0.2 : -0.1,
        w: EMPOWER_ALLOCATION_FEATURES.map(() => 0),
    })),
};

test("all six Empower choices pay their full cost and preserve unrelated builds", () => {
    for (const budget of [5, 6, 7]) {
        const base = empowerSetupPlan(budget, own, 0);
        for (let arm = 1; arm <= 6; arm++) {
            const plan = empowerAllocationPlan(budget, own, base, arm);
            expect(plan.reduce((sum, entry) => sum + entry.value, 0)).toBe(budget);
            expect(plan.find((entry) => entry.kind === "Empower")?.value).toBe(((arm - 1) % 3) + 1);
            expect(plan.every((entry) => entry.value >= 1 && entry.value <= 3)).toBe(true);
        }
        const paid = [
            { kind: "Placement" as const, value: 1 },
            { kind: "Sniper" as const, value: 3 },
            { kind: "Armor" as const, value: budget - 4 },
        ];
        expect(empowerAllocationPlan(budget, own, paid, 6)).toEqual(paid);
        expect(empowerAllocationPlan(budget, own, base.slice(0, 1), 6)).toEqual(base.slice(0, 1));
    }
});

test("allocation inference respects public setup and the full doctrine budget", () => {
    const base = empowerSetupPlan(7, own, 0);
    expect(selectEmpowerAllocation(model, 7, own, context, base)).toBe(6);
    expect(selectEmpowerAllocation(model, 7, own, { ...context, opponentRosterVisibility: "partial" }, base)).toBe(0);
    expect(selectEmpowerAllocation(model, 6, own, context, empowerSetupPlan(6, own, 0))).toBe(0);
    expect(selectEmpowerAllocation(model, 7, own, { ...context, synergyVariants: undefined }, base)).toBe(0);
});
