import { expect, test } from "bun:test";
import {
    EMPOWER_COST_FEATURES,
    EMPOWER_COST_SCHEMA,
    empowerCostFeatures,
    selectEmpowerCost,
    type IEmpowerCostModel,
} from "../../src/ai/setup/empower_cost";
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
const at = (row: number[], name: string) => row[EMPOWER_COST_FEATURES.indexOf(name)];

test("opportunity cost uses the actual marginal power and preserves the zero-cost reference", () => {
    const base = empowerSetupPlan(7, own, 0);
    const control = empowerCostFeatures(7, own, context, base, 0)!;
    expect(control.every((value) => value === 0)).toBe(true);
    const physical = empowerCostFeatures(7, own, context, base, 3)!;
    const armor = empowerCostFeatures(7, own, context, base, 6)!;
    expect(at(physical, "magicGain:constant")).toBe(1);
    expect(at(physical, "rangedAttackLost:constant")).toBeCloseTo(8 / 27);
    expect(at(physical, "meleeAttackLost:constant")).toBeCloseTo(19 / 27);
    expect(at(physical, "armorLost:constant")).toBe(0);
    expect(at(armor, "meleeAttackLost:constant")).toBe(0);
    expect(at(armor, "armorLost:constant")).toBeCloseTo(15 / 21);
});

test("Farsight removes lost falloff range from the cost, but retains the attack cost", () => {
    const base = empowerSetupPlan(7, own, 0);
    const ordinary = empowerCostFeatures(7, own, context, base, 1)!;
    const quiver = empowerCostFeatures(7, own, { ...context, ownArtifactIds: [1, 8] }, base, 1)!;
    expect(at(ordinary, "rangeLost:constant")).toBeCloseTo(20 / 70);
    expect(at(quiver, "rangeLost:constant")).toBe(0);
    expect(at(quiver, "rangedAttackLost:constant")).toBe(at(ordinary, "rangedAttackLost:constant"));
});

test("shared cost inference requires complete public context and an explicitly provided valid model", () => {
    const model: IEmpowerCostModel = {
        schema: EMPOWER_COST_SCHEMA,
        features: EMPOWER_COST_FEATURES,
        weights: EMPOWER_COST_FEATURES.map((name) => (name === "magicGain:constant" ? 0.1 : 0)),
        margin: 0.02,
    };
    const base = empowerSetupPlan(7, own, 0);
    expect(selectEmpowerCost(model, 7, own, context, base)).toBe(3);
    expect(selectEmpowerCost(model, 7, own, { ...context, opponentRosterVisibility: "partial" }, base)).toBe(0);
    expect(selectEmpowerCost(model, 6, own, context, empowerSetupPlan(6, own, 0))).toBe(0);
    expect(() => selectEmpowerCost({ ...model, weights: [Number.NaN] }, 7, own, context, base)).toThrow();
});
