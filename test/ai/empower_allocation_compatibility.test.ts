import { expect, test } from "bun:test";
import {
    EMPOWER_ALLOCATION_FEATURES,
    EMPOWER_ALLOCATION_SCHEMA,
    type IEmpowerAllocationModel,
} from "../../src/ai/setup/empower_allocation";
import {
    compatibleEmpowerAllocation,
    compatibleEmpowerAllocationFormation,
} from "../../src/ai/setup/empower_allocation_compatibility";
import { empowerSetupPlan } from "../../src/ai/setup/empower_setup";
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

test("only the selected funded allocation inherits the measured baseline formation", () => {
    const base = empowerSetupPlan(7, own, 0);
    const selected = compatibleEmpowerAllocation(model, 7, own, context, base);
    expect(selected.arm).toBe(6);
    expect(selected.augments.reduce((sum, entry) => sum + entry.value, 0)).toBe(7);
    expect(compatibleEmpowerAllocationFormation(model, 7, own, context, base, selected.augments)).toEqual(base);
    const changed = selected.augments.map((entry) => ({
        ...entry,
        value: entry.kind === "Empower" ? entry.value - 1 : entry.value,
    }));
    expect(compatibleEmpowerAllocationFormation(model, 7, own, context, base, changed)).toEqual(changed);
    expect(compatibleEmpowerAllocationFormation(model, 7, own, undefined, base, selected.augments)).toEqual(
        selected.augments,
    );
});

test("paid Placement and a partial remaining budget retain their own formation context", () => {
    const paid = [
        { kind: "Placement" as const, value: 1 },
        { kind: "Sniper" as const, value: 3 },
        { kind: "Armor" as const, value: 3 },
    ];
    expect(compatibleEmpowerAllocation(model, 7, own, context, paid)).toEqual({
        arm: 0,
        augments: paid,
        formationAugments: paid,
    });
    const partial = empowerSetupPlan(6, own, 0);
    expect(compatibleEmpowerAllocation(model, 6, own, context, partial).arm).toBe(0);
    expect(compatibleEmpowerAllocationFormation(model, 6, own, context, partial, partial)).toEqual(partial);
});
