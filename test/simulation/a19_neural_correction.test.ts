import { expect, spyOn, test } from "bun:test";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import type { GameAction } from "../../src/engine/actions";
import { GREEN_TEAM, runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { selectV09A19Correction, withV09A19Correction } from "../../src/simulation/v0_9/a19_correction";
import type { V09A19CpuModel } from "../../src/simulation/v0_9/a19_inference";

const environment = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () => ({
    ...buildV08A19SearchEnvironment(),
    SEARCH_A19_MATERIAL_ARBITRATION: "ties",
    SEARCH_A19_NEURAL_TIES: "0",
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
    researchCaptureDecisionStart: true,
    searchOfflineDeterministicWork: false,
    researchA19BaseSearchEnvironment: Object.fromEntries(
        Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
};
function scope<T>(run: () => T) {
    return withScopedAIEnvironment(
        { ...environment, V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        run,
    );
}
function play(config = match) {
    const turns: unknown[] = [],
        events: unknown[] = [];
    const result = runMatch({
        ...config,
        headlessEvents: true,
        turnExecutionObserver: (row) => turns.push(row),
        committedEventsObserver: (row) => events.push(row),
    });
    return { result, turns, events };
}
const propose: Pick<V09A19CpuModel, "predict"> = {
    predict: (observation) => ({
        policy: observation.candidates.map((_, index) => index * 10),
        primary: [],
        valueLogit: 0,
    }),
};
function correct<T>(model: Pick<V09A19CpuModel, "predict"> | null, run: () => T) {
    return withV09A19Correction(
        {
            team: GREEN_TEAM,
            model,
            minimumLogitGain: 1,
            actionFamily: "all",
            executionMode: "wall-clock",
            chargeNativeDecision: true,
        },
        run,
    );
}

test("all-family correction requires two complete rollouts and an exact primary tie", () => {
    const evidence = {
        candidates: [
            { actions: [{ type: "range_attack", attackerId: "a", targetId: "x" }] as GameAction[] },
            { actions: [{ type: "defend_turn", unitId: "a" }] as GameAction[] },
        ],
        means: [1, 1],
        completed: [2, 2],
        selected: 0,
        policy: [0, 1],
        minimumLogitGain: 1,
    };
    expect(selectV09A19Correction(evidence)).toBe(0);
    expect(selectV09A19Correction({ ...evidence, actionFamily: "all" })).toBe(1);
    for (const change of [
        { completed: [2, 1] },
        { completed: [1, 2] },
        { means: [1, 1 - Number.EPSILON] },
        { means: [1 - Number.EPSILON, 1] },
        { policy: [0, 1 - Number.EPSILON] },
    ])
        expect(selectV09A19Correction({ ...evidence, actionFamily: "all", ...change })).toBe(0);
    expect(() => selectV09A19Correction({ ...evidence, actionFamily: "unknown" as "all" })).toThrow();
});

test(
    "all-family disabled and abstaining arms retain complete stock trajectories",
    () =>
        scope(() => {
            const clock = spyOn(performance, "now").mockReturnValue(0);
            const original = SearchDriver.prototype.chooseDecision;
            try {
                const stock = play();
                expect(correct(null, () => play()).value).toEqual(stock);
                const observed = correct(
                    {
                        predict: (observation) => ({
                            policy: observation.candidates.map(() => 0),
                            primary: [],
                            valueLogit: 0,
                        }),
                    },
                    () => play(),
                );
                expect(observed.value).toEqual(stock);
                expect(observed.statistics.inferred).toBeGreaterThan(0);
                expect(observed.statistics.corrected).toBe(0);
                expect(observed.statistics.missingStart).toBe(0);
                expect(SearchDriver.prototype.chooseDecision).toBe(original);
            } finally {
                clock.mockRestore();
            }
        }),
    120_000,
);

test(
    "missing native timestamps abstain without replacing the original action arrays",
    () =>
        scope(() => {
            const clock = spyOn(performance, "now").mockReturnValue(0);
            const original = SearchDriver.prototype.chooseDecision;
            const stockByContext = new WeakMap<object, GameAction[]>();
            let checked = 0;
            SearchDriver.prototype.chooseDecision = function (...args) {
                const value = original.apply(this, args);
                stockByContext.set(args[3]!, value);
                return value;
            };
            try {
                const config = { ...match, researchCaptureDecisionStart: false };
                const stock = play(config);
                const observed = correct(propose, () => {
                    const adapted = SearchDriver.prototype.chooseDecision;
                    SearchDriver.prototype.chooseDecision = function (...args) {
                        const value = adapted.apply(this, args);
                        expect(value).toBe(stockByContext.get(args[3]!));
                        checked++;
                        return value;
                    };
                    try {
                        return play(config);
                    } finally {
                        SearchDriver.prototype.chooseDecision = adapted;
                    }
                });
                expect(observed.value).toEqual(stock);
                expect(observed.statistics.missingStart).toBeGreaterThan(0);
                expect(observed.statistics.inferred).toBe(0);
                expect(checked).toBeGreaterThan(0);
            } finally {
                SearchDriver.prototype.chooseDecision = original;
                clock.mockRestore();
            }
        }),
    120_000,
);

test(
    "native decision cost cannot restart the inference allowance",
    () =>
        scope(() => {
            let now = 0;
            const clock = spyOn(performance, "now").mockImplementation(() => now);
            const original = StrategyV0_8.prototype.decideTurn;
            StrategyV0_8.prototype.decideTurn = function (unit, context) {
                const value = original.call(this, unit, context);
                if (context.decisionOrigin === "root" && unit.getTeam() === GREEN_TEAM) now += 1000;
                return value;
            };
            try {
                const stock = play();
                const observed = correct(
                    {
                        predict: () => {
                            throw new Error("must abstain before inference");
                        },
                    },
                    () => play(),
                );
                expect(observed.value).toEqual(stock);
                expect(observed.statistics.deadlineAbstentions).toBeGreaterThan(0);
                expect(observed.statistics.inferred).toBe(0);
                expect(observed.statistics.modelErrors).toBe(0);
            } finally {
                StrategyV0_8.prototype.decideTurn = original;
                clock.mockRestore();
            }
        }),
    120_000,
);

test(
    "future and nonfinite native timestamps cannot extend the turn allowance",
    () =>
        scope(() => {
            const clock = spyOn(performance, "now").mockReturnValue(0);
            try {
                const stock = play();
                for (const invalid of [1, NaN, Infinity]) {
                    const observed = correct(propose, () => {
                        const adapted = SearchDriver.prototype.chooseDecision;
                        SearchDriver.prototype.chooseDecision = function (...args) {
                            if (args[0].getTeam() === GREEN_TEAM) args[3]!.decisionStartedAtMs = invalid;
                            return adapted.apply(this, args);
                        };
                        try {
                            return play();
                        } finally {
                            SearchDriver.prototype.chooseDecision = adapted;
                        }
                    });
                    expect(observed.value).toEqual(stock);
                    expect(observed.statistics.missingStart).toBeGreaterThan(0);
                    expect(observed.statistics.inferred).toBe(0);
                }
            } finally {
                clock.mockRestore();
            }
        }),
    120_000,
);

test(
    "inference overruns and malformed predictions retain stock trajectories and restore hooks",
    () =>
        scope(() => {
            let now = 0;
            const clock = spyOn(performance, "now").mockImplementation(() => now);
            const original = SearchDriver.prototype.chooseDecision;
            try {
                const stock = play();
                const late = correct(
                    {
                        predict: (observation) => {
                            now += 1000;
                            return propose.predict(observation);
                        },
                    },
                    () => play(),
                );
                expect(late.value).toEqual(stock);
                expect(late.statistics.inferenceOverruns).toBeGreaterThan(0);
                expect(late.statistics.corrected).toBe(0);
                const malformed = correct({ predict: () => ({ policy: [NaN], primary: [], valueLogit: 0 }) }, () =>
                    play(),
                );
                expect(malformed.value).toEqual(stock);
                expect(malformed.statistics.modelErrors).toBeGreaterThan(0);
                expect(SearchDriver.prototype.chooseDecision).toBe(original);
            } finally {
                clock.mockRestore();
            }
        }),
    120_000,
);

test(
    "driver-local correction preserves stock play without changing other drivers or global hooks",
    () =>
        scope(() => {
            const clock = spyOn(performance, "now").mockReturnValue(0);
            const prototype = SearchDriver.prototype as any;
            const names = ["shortlistCandidates", "scoreCandidates", "rollout"] as const;
            const original = prototype.chooseDecision;
            const globalHooks = names.map((name) => prototype[name]);
            const unrelated = withSearchEnvironment(environment, () => new SearchDriver({} as any)) as any;
            let inferred = 0,
                corrected = 0;
            try {
                const stock = play();
                const run = (abstain: boolean) => {
                    prototype.chooseDecision = function (...args: Parameters<SearchDriver["chooseDecision"]>) {
                        const descriptor = Object.getOwnPropertyDescriptor(this, "chooseDecision");
                        Object.defineProperty(this, "chooseDecision", {
                            value: original,
                            writable: true,
                            configurable: true,
                        });
                        try {
                            const observed = withV09A19Correction(
                                {
                                    driver: this,
                                    team: GREEN_TEAM,
                                    minimumLogitGain: 1,
                                    actionFamily: "all",
                                    executionMode: "wall-clock",
                                    chargeNativeDecision: true,
                                    model: {
                                        predict: (observation) => {
                                            names.forEach((name, i) => {
                                                expect(prototype[name]).toBe(globalHooks[i]);
                                                expect(unrelated[name]).toBe(globalHooks[i]);
                                                expect(Object.hasOwn(unrelated, name)).toBe(false);
                                            });
                                            return abstain
                                                ? {
                                                      policy: observation.candidates.map(() => 0),
                                                      primary: [],
                                                      valueLogit: 0,
                                                  }
                                                : propose.predict(observation);
                                        },
                                    },
                                },
                                () => this.chooseDecision(...args),
                            );
                            inferred += observed.statistics.inferred;
                            corrected += observed.statistics.corrected;
                            names.forEach((name) => expect(Object.hasOwn(this, name)).toBe(false));
                            return observed.value;
                        } finally {
                            if (descriptor) Object.defineProperty(this, "chooseDecision", descriptor);
                            else Reflect.deleteProperty(this, "chooseDecision");
                        }
                    };
                    return play();
                };
                expect(run(true)).toEqual(stock);
                expect(inferred).toBeGreaterThan(0);
                expect(corrected).toBe(0);
                const active = run(false);
                expect(corrected).toBeGreaterThan(0);
                expect(active.result.rejectedGreen).toBe(0);
                expect(active.result.rejectedRed).toBe(0);
            } finally {
                prototype.chooseDecision = original;
                clock.mockRestore();
            }
        }),
    120_000,
);

test("a partially installed driver scope restores methods when installation fails", () => {
    const driver = withSearchEnvironment(environment, () => new SearchDriver({} as any));
    const original = (SearchDriver.prototype as any).shortlistCandidates;
    Object.defineProperty(driver, "shortlistCandidates", { value: original, writable: true, configurable: false });
    const before = Object.getOwnPropertyDescriptors(driver);
    Object.preventExtensions(driver);
    let ran = false;
    expect(() =>
        withV09A19Correction({ driver, team: GREEN_TEAM, model: propose, minimumLogitGain: 1 }, () => {
            ran = true;
        }),
    ).toThrow();
    expect(ran).toBe(false);
    expect(Object.getOwnPropertyDescriptors(driver)).toEqual(before);
    expect((driver as any).shortlistCandidates).toBe(original);
});
