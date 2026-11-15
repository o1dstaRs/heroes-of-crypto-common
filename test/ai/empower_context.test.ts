import { expect, test } from "bun:test";
import {
    EMPOWER_CONTEXT_FEATURES,
    EMPOWER_CONTEXT_SCHEMA,
    empowerContextFeatures,
    selectContextualEmpower,
    validateContextualEmpowerModel,
    type IContextualEmpowerModel,
} from "../../src/ai/setup/empower_context";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import type { IPlacementSetupDecisionContext } from "../../src/ai/setup/setup_strategy";
import { inspectContextualEmpowerInput } from "../../src/simulation/empower_context_research";
import registration from "../../docs/evidence/empower_setup_registration_20261114.json";

const fixture = () => {
    const row = registration.banks.train[2];
    return inspectContextualEmpowerInput({ board: row[0], seed: row[1], game: 0, level: 0 });
};
const positiveModel = (): IContextualEmpowerModel => ({
    schema: EMPOWER_CONTEXT_SCHEMA,
    features: EMPOWER_CONTEXT_FEATURES,
    margin: 0.03,
    estimator: { kind: "ridge", b: 0.1, w: EMPOWER_CONTEXT_FEATURES.map(() => 0) },
});

test("public Empower context rejects concealed rosters, earlier phases and partial budgets", () => {
    const { own, budget, context, features } = fixture();
    expect(features).toHaveLength(EMPOWER_CONTEXT_FEATURES.length);
    expect(selectContextualEmpower(positiveModel(), budget, own, context)).toBe(1);
    expect(empowerContextFeatures(budget, own, { ...context, opponentRosterVisibility: "partial" })).toBeUndefined();
    expect(empowerContextFeatures(budget, own, { ...context, ownDoctrine: Doctrine.SEE_NONE })).toBeUndefined();
    expect(empowerContextFeatures(budget, own, { ...context, gridSize: 12 })).toBeUndefined();
    expect(empowerContextFeatures(budget, own, undefined)).toBeUndefined();
    expect(
        empowerContextFeatures(budget, own, {
            ...context,
            decisionPhase: "tier2-artifact",
        } as unknown as IPlacementSetupDecisionContext),
    ).toBeUndefined();
});

test("features use public identities and owned artifacts, independently of input order or hidden fields", () => {
    const { own, budget, context, features } = fixture();
    expect(
        empowerContextFeatures(budget, [...own].reverse(), {
            ...context,
            publicOpponentCreatureIds: [...context.publicOpponentCreatureIds].reverse(),
        }),
    ).toEqual(features);
    const hidden = {
        ...context,
        enemyAugments: [{ kind: "Empower", value: 3 }],
        enemyPositions: [{ x: 1, y: 9 }],
        enemyArtifactIds: [1, 2],
        enemyAmounts: [999],
    };
    expect(empowerContextFeatures(budget, own, hidden)).toEqual(features);
    expect(empowerContextFeatures(budget, own, { ...context, gridType: context.gridType === 1 ? 3 : 1 })).not.toEqual(
        features,
    );
    expect(
        empowerContextFeatures(budget, own, {
            ...context,
            publicOpponentCreatureIds: [...context.publicOpponentCreatureIds.slice(1)],
        }),
    ).toBeUndefined();
});

test("contextual model validation rejects invalid weights and unsafe trees", () => {
    expect(() => validateContextualEmpowerModel(positiveModel())).not.toThrow();
    const bad = positiveModel();
    bad.estimator = { kind: "ridge", b: Number.NaN, w: EMPOWER_CONTEXT_FEATURES.map(() => 0) };
    expect(() => validateContextualEmpowerModel(bad)).toThrow();
    bad.estimator = { kind: "forest", trees: [{ feature: -1, threshold: 0, left: { value: 1 }, right: { value: 0 } }] };
    expect(() => validateContextualEmpowerModel(bad)).toThrow();
});
