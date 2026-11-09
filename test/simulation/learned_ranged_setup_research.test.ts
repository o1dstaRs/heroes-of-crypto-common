import { expect, test } from "bun:test";
import {
    LEARNED_RANGED_SETUP_FEATURE_NAMES,
    LEARNED_RANGED_SETUP_FEATURE_SCHEMA,
    LEARNED_RANGED_SETUP_SCHEMA,
    learnedRangedSetupFeatures,
    predictLearnedRangedSetup,
    selectLearnedRangedSetup,
    validateLearnedRangedSetupModel,
    type ILearnedRangedSetupModel,
    type IPublicRangedSetupContext,
} from "../../src/simulation/learned_ranged_setup_research";

const context: IPublicRangedSetupContext = {
    ownCreatureIds: [47, 31, 15, 6, 50, 29],
    publicOpponentCreatureIds: [23, 49, 4, 15, 38, 42],
    budget: 6,
    map: 3,
    synergyVariants: { Life: 1, Nature: 2, Chaos: 1, Might: 2 },
};
const model = (): ILearnedRangedSetupModel => ({
    schema: LEARNED_RANGED_SETUP_SCHEMA,
    featureSchema: LEARNED_RANGED_SETUP_FEATURE_SCHEMA,
    features: [...LEARNED_RANGED_SETUP_FEATURE_NAMES],
    freeWeights: new Array(LEARNED_RANGED_SETUP_FEATURE_NAMES.length).fill(0),
    paidWeights: new Array(LEARNED_RANGED_SETUP_FEATURE_NAMES.length).fill(0),
    margin: 0.02,
    productionPromotion: false,
});

test("the effect model reads only public setup information and is invariant to roster ordering", () => {
    const features = learnedRangedSetupFeatures(context)!;
    expect(features.length).toBe(LEARNED_RANGED_SETUP_FEATURE_NAMES.length);
    expect(features.every(Number.isFinite)).toBe(true);
    expect(
        learnedRangedSetupFeatures({
            ...context,
            ownCreatureIds: [...context.ownCreatureIds].reverse(),
            publicOpponentCreatureIds: [...context.publicOpponentCreatureIds].reverse(),
        }),
    ).toEqual(features);
    const concealed = {
        ...context,
        enemyAugments: [{ kind: "Movement", value: 2 }],
        enemyPositions: [{ x: 5, y: 1 }],
        enemyAmounts: [10000],
    };
    expect(learnedRangedSetupFeatures(concealed)).toEqual(features);
    expect(learnedRangedSetupFeatures({ ...context, budget: 8 })).toBeUndefined();
    expect(learnedRangedSetupFeatures({ ...context, publicOpponentCreatureIds: [37] })).toBeUndefined();
});

test("heads choose funded reference policies with a real margin and retain current behavior on ties", () => {
    const m = model();
    validateLearnedRangedSetupModel(m);
    expect(selectLearnedRangedSetup(m, context)).toBe("control");
    const free = {
        ...m,
        freeWeights: m.freeWeights.map((_, index) => (index === 0 ? 0.1 : 0)),
        paidWeights: m.paidWeights.map((_, index) => (index === 0 ? 0.2 : 0)),
    };
    expect(selectLearnedRangedSetup(free, context)).toBe("free-spread");
    expect(selectLearnedRangedSetup(free, { ...context, publicOpponentCreatureIds: [23, 49, 4, 53, 37, 9] })).toBe(
        "placement1-sniper",
    );
    expect(predictLearnedRangedSetup(free, learnedRangedSetupFeatures(context)!)).toEqual({ free: 0.1, paid: 0.2 });
    expect(() => validateLearnedRangedSetupModel({ ...m, freeWeights: [NaN] })).toThrow();
    expect(() => predictLearnedRangedSetup(free, [1, NaN])).toThrow();
});
