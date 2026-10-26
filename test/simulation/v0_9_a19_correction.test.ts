import { expect, test } from "bun:test";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import type { GameAction } from "../../src/engine/actions";
import { GREEN_TEAM, runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import {
    selectV09A19Correction,
    v09A19HasInferenceTime,
    withV09A19Correction,
} from "../../src/simulation/v0_9/a19_correction";

const candidates: { actions: GameAction[] }[] = [
    { actions: [{ type: "range_attack", attackerId: "a", targetId: "x" }] },
    { actions: [{ type: "range_attack", attackerId: "a", targetId: "y" }] },
    { actions: [{ type: "range_attack", attackerId: "a", targetId: "z" }] },
    { actions: [{ type: "defend_turn", unitId: "a" }] },
];
const evidence = {
    candidates,
    means: [1, 1, 0.5, 1],
    completed: [2, 2, 2, 2],
    selected: 0,
    policy: [0, 2, 100, 1000],
    minimumLogitGain: 1,
};

test("corrections stay among fully scored same-family primary ties", () => {
    expect(selectV09A19Correction(evidence)).toBe(1);
    expect(selectV09A19Correction({ ...evidence, completed: [2, 1, 2, 2] })).toBe(0);
    expect(selectV09A19Correction({ ...evidence, minimumLogitGain: 3 })).toBe(0);
    expect(selectV09A19Correction({ ...evidence, means: [0.5, 1, 0.5, 1] })).toBe(0);
    expect(() => selectV09A19Correction({ ...evidence, policy: [0, NaN, 1, 2] })).toThrow();
});

test("live inference reserves time inside the original A19 deadline", () => {
    expect(v09A19HasInferenceTime(974, 0, 1000)).toBe(true);
    expect(v09A19HasInferenceTime(975, 0, 1000)).toBe(false);
    expect(v09A19HasInferenceTime(1001, 0, 1000)).toBe(false);
});

const environment = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () => ({
    ...buildV08A19SearchEnvironment(),
    SEARCH_A19_MATERIAL_ARBITRATION: "ties",
}));
const match: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    seed: 24691,
    maxLaps: 4,
    roster: [{ faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 20 }],
    redRoster: [
        { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 },
        { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 },
    ],
    searchOfflineDeterministicWork: true,
    researchA19BaseSearchEnvironment: Object.fromEntries(
        Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
};

test("wall-clock abstention and a model fault preserve the actual stock controller path", () => {
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const liveMatch = { ...match, searchOfflineDeterministicWork: false };
            const stock = runMatch(liveMatch);
            const abstaining = withV09A19Correction(
                {
                    team: GREEN_TEAM,
                    minimumLogitGain: 1,
                    executionMode: "wall-clock",
                    model: {
                        predict: (observation) => ({
                            policy: observation.candidates.map(() => 0),
                            primary: observation.candidates.map(() => 0),
                            valueLogit: 0,
                        }),
                    },
                },
                () => runMatch(liveMatch),
            );
            expect(abstaining.value).toEqual(stock);
            expect(abstaining.statistics.inferred).toBeGreaterThan(0);
            const faulty = withV09A19Correction(
                {
                    team: GREEN_TEAM,
                    minimumLogitGain: 1,
                    executionMode: "wall-clock",
                    model: {
                        predict: () => {
                            throw new Error("live diagnostic fault");
                        },
                    },
                },
                () => runMatch(liveMatch),
            );
            expect(faulty.value).toEqual(stock);
            expect(faulty.statistics.modelErrors).toBeGreaterThan(0);
            expect(faulty.statistics.corrected).toBe(0);
        },
    );
}, 120_000);

test("disabled and abstaining correction arms preserve complete A19 engine results", () => {
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const original = SearchDriver.prototype.chooseDecision;
            const stock = runMatch(match);
            expect(
                withV09A19Correction({ team: GREEN_TEAM, model: null, minimumLogitGain: 1 }, () => runMatch(match))
                    .value,
            ).toEqual(stock);
            let calls = 0;
            const observed = withV09A19Correction(
                {
                    team: GREEN_TEAM,
                    minimumLogitGain: 1,
                    model: {
                        predict: (observation) => {
                            calls++;
                            return {
                                policy: observation.candidates.map(() => 0),
                                primary: observation.candidates.map(() => 0),
                                valueLogit: 0,
                            };
                        },
                    },
                },
                () => runMatch(match),
            );
            expect(observed.value).toEqual(stock);
            expect(observed.statistics.corrected).toBe(0);
            expect(calls).toBeGreaterThan(0);
            expect(observed.statistics.inferred).toBe(calls);
            expect(SearchDriver.prototype.chooseDecision).toBe(original);
        },
    );
}, 120_000);

test("a faulty model fails the research run and restores its hooks", () => {
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const original = SearchDriver.prototype.chooseDecision;
            expect(() =>
                withV09A19Correction(
                    {
                        team: GREEN_TEAM,
                        minimumLogitGain: 1,
                        model: {
                            predict: () => {
                                throw new Error("diagnostic model fault");
                            },
                        },
                    },
                    () => runMatch(match),
                ),
            ).toThrow("diagnostic model fault");
            expect(SearchDriver.prototype.chooseDecision).toBe(original);
        },
    );
}, 120_000);

test("an exercised correction plays complete legal real-engine actions", () => {
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const exercised = withV09A19Correction(
                {
                    team: GREEN_TEAM,
                    minimumLogitGain: 0.01,
                    model: {
                        predict: (observation) => ({
                            policy: observation.candidates.map((_, index) => index * 10),
                            primary: observation.candidates.map(() => 0),
                            valueLogit: 0,
                        }),
                    },
                },
                () => runMatch(match),
            );
            expect(exercised.statistics.corrected).toBeGreaterThan(0);
            expect(exercised.value.rejectedGreen).toBe(0);
            expect(exercised.value.rejectedRed).toBe(0);
            expect(exercised.statistics.fullTurnMs.length).toBe(exercised.statistics.decisions);
        },
    );
}, 120_000);
