import { expect, test } from "bun:test";
import {
    fitActualContinuationRanker,
    selectActualContinuationRanker,
    type IActualRankerFamily,
} from "../../src/simulation/a19_continuation_ranker";
import type { IActualContinuationCandidate } from "../../src/simulation/a19_actual_continuation";
import { CONTINUATION_FEATURE_NAMES } from "../../src/simulation/measure_search_continuation";

const settings = { l2: 0.25, bootstrapSeed: 2720370000, models: 32, minimumMean: 0.05, minimumLowerDecile: 0.025 };
const candidate = (signature: string, damage: number): IActualContinuationCandidate => ({
    signature,
    actions: [],
    kind: "shot",
    returnedR2Score: 0.5,
    features: CONTINUATION_FEATURE_NAMES.map((name) => (name === "signedLogDamage" ? damage : 0)),
});
const families: IActualRankerFamily[] = Array.from({ length: 12 }, (_, index) => ({
    family: `family-${index}`,
    candidates: [candidate("baseline", 1), candidate("safer", 0), candidate("stronger", 2)],
    returns: [
        [0.5, 0.5],
        [0, 0],
        [1, 1],
    ],
}));

test("a family bootstrap learns matched action advantage and ignores irrelevant public columns", () => {
    const model = fitActualContinuationRanker(families, settings);
    const candidates = [candidate("baseline", 1), candidate("safer", 0), candidate("stronger", 2)];
    expect(selectActualContinuationRanker(model, candidates).signature).toBe("stronger");
    candidates[1].features![CONTINUATION_FEATURE_NAMES.indexOf("isNativeIncumbent")] = 100000;
    candidates[1].features![0] = -100000;
    expect(selectActualContinuationRanker(model, candidates).signature).toBe("stronger");
    expect(selectActualContinuationRanker(model, [candidates[0], candidates[2], candidates[1]]).signature).toBe(
        "stronger",
    );
});

test("family ordering and repeated terminal worlds do not alter the fitted model", () => {
    const original = fitActualContinuationRanker(families, settings);
    const repeated = [...families]
        .reverse()
        .map((family) => ({ ...family, returns: family.returns.map((values) => [...values, ...values]) }));
    expect(fitActualContinuationRanker(repeated, settings)).toEqual(original);
    const duplicatedActions = families.map((family) => ({
        ...family,
        candidates: [
            ...family.candidates,
            { ...family.candidates[1], signature: "same-return" },
            { ...family.candidates[2], signature: "same-return-2" },
        ],
        returns: [...family.returns, family.returns[1], family.returns[2]],
    }));
    const duplicateModel = fitActualContinuationRanker(duplicatedActions, settings);
    for (let index = 0; index < original.weights.length; index++)
        for (let column = 0; column < original.weights[index].length; column++)
            expect(duplicateModel.weights[index][column]).toBeCloseTo(original.weights[index][column], 10);
});

test("no counterfactual return signal and missing search evidence cause abstention", () => {
    const emptySignal = families.map((family) => ({ ...family, returns: family.returns.map(() => [0, 0]) }));
    const model = fitActualContinuationRanker(emptySignal, settings);
    expect(selectActualContinuationRanker(model, families[0].candidates).signature).toBeUndefined();
    expect(
        selectActualContinuationRanker(model, [
            { ...candidate("baseline", 1), returnedR2Score: null },
            candidate("other", 2),
        ]).signature,
    ).toBeUndefined();
});

test("corrupt models, duplicate families and unmatched or nonterminal labels fail closed", () => {
    expect(() => fitActualContinuationRanker([...families, families[0]], settings)).toThrow("unique");
    expect(() => fitActualContinuationRanker([{ ...families[0], returns: [[0, 0], [0], [1, 1]] }], settings)).toThrow(
        "matched terminal",
    );
    expect(() =>
        fitActualContinuationRanker(
            [
                {
                    ...families[0],
                    returns: [
                        [0, 0],
                        [0, 0],
                        [1, 0.25],
                    ],
                },
            ],
            settings,
        ),
    ).toThrow("matched terminal");
    const model = fitActualContinuationRanker(families, settings);
    expect(() => selectActualContinuationRanker({ ...model, scales: [] }, families[0].candidates)).toThrow("Invalid");
    expect(() =>
        selectActualContinuationRanker(model, [
            candidate("baseline", 1),
            { ...candidate("other", 2), features: [NaN] },
        ]),
    ).toThrow("complete finite");
});
