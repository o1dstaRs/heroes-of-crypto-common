import { expect, spyOn, test } from "bun:test";
import { A19_NEURAL_POLICY } from "../../src/ai/versions/v0_8_a19_neural_policy";
import { attachA19NeuralCorrection, getA19NeuralState } from "../../src/simulation/a19_neural";
import { getA19NeuralModel } from "../../src/simulation/a19_neural_model";
import { GREEN_TEAM, RED_TEAM, runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { withV09A19Correction } from "../../src/simulation/v0_9/a19_correction";
import type { V09A19CpuModel } from "../../src/simulation/v0_9/a19_inference";

const match: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    seed: 24691,
    maxLaps: 6,
    roster: [{ faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 20 }],
    redRoster: [
        { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 },
        { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 },
    ],
    headlessEvents: true,
    researchCaptureDecisionStart: true,
    searchOfflineDeterministicWork: false,
};
function scope<T>(enabled: boolean, run: () => T): T {
    return withScopedAIEnvironment(
        {
            V08_A13_SEARCH: undefined,
            V08_A19_SEARCH: "1",
            V08_A19_SEARCH_ENV_OVERRIDES: JSON.stringify({ SEARCH_A19_NEURAL_TIES: enabled ? "1" : "0" }),
        },
        run,
    );
}
function play(enabled = true) {
    const turns: unknown[] = [],
        events: unknown[] = [];
    const result = runMatch({
        ...match,
        researchA19BaseSearchEnvironment: { SEARCH_A19_NEURAL_TIES: enabled ? "1" : "0" },
        turnExecutionObserver: (row) => turns.push(row),
        committedEventsObserver: (row) => events.push(row),
    });
    expect(result.rejectedGreen + result.rejectedRed).toBe(0);
    return { result, turns, events };
}

test("the public default factory enables the frozen ensemble without changing global drivers", () => {
    const original = SearchDriver.prototype.chooseDecision;
    const driver = scope(true, () =>
        createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" }),
    );
    expect(getA19NeuralState(driver)?.policyId).toBe(A19_NEURAL_POLICY.id);
    const rollback = scope(false, () =>
        createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" }),
    );
    expect(getA19NeuralState(rollback)).toBeUndefined();
    const advice = scope(true, () =>
        createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" }, undefined, {
            neuralCorrection: false,
        }),
    );
    expect(getA19NeuralState(advice)).toBeUndefined();
    expect(SearchDriver.prototype.chooseDecision).toBe(original);
});

test("a cached driver follows restored and replaced base-method instrumentation", () => {
    const first: GameAction[] = [{ type: "wait_turn", unitId: "probe" }];
    const second: GameAction[] = [{ type: "defend_turn", unitId: "probe" }];
    const unit = {} as Parameters<SearchDriver["chooseDecision"]>[0];
    const initial = spyOn(SearchDriver.prototype, "chooseDecision").mockReturnValue(first);
    let replacement: ReturnType<typeof spyOn> | undefined;
    try {
        const driver = scope(true, () =>
            createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" }),
        );
        expect(driver.chooseDecision(unit, "v0.1", [])).toBe(first);
        initial.mockRestore();
        replacement = spyOn(SearchDriver.prototype, "chooseDecision").mockReturnValue(second);
        expect(driver.chooseDecision(unit, "v0.1", [])).toBe(second);
    } finally {
        replacement?.mockRestore();
        initial.mockRestore();
    }
});

test("the shipped packed ensemble reproduces the frozen correction policy through complete games", () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const model = getA19NeuralModel();
    try {
        const reference = scope(
            false,
            () =>
                withV09A19Correction(
                    {
                        team: GREEN_TEAM,
                        model,
                        minimumLogitGain: 1,
                        actionFamily: "all",
                        executionMode: "wall-clock",
                        chargeNativeDecision: true,
                    },
                    () =>
                        withV09A19Correction(
                            {
                                team: RED_TEAM,
                                model,
                                minimumLogitGain: 1,
                                actionFamily: "all",
                                executionMode: "wall-clock",
                                chargeNativeDecision: true,
                            },
                            () => play(false),
                        ).value,
                ).value,
        );
        expect(scope(true, () => play())).toEqual(reference);
    } finally {
        clock.mockRestore();
    }
}, 120_000);

test("the public default supplies native timestamps and actually runs both bundled models", () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const drivers = new Set<SearchDriver>();
    const original = SearchDriver.prototype.onFightReady;
    const ready = spyOn(SearchDriver.prototype, "onFightReady").mockImplementation(function (this: SearchDriver) {
        original.call(this);
        drivers.add(this);
    });
    try {
        scope(true, () => runMatch({ ...match, researchCaptureDecisionStart: false }));
        const states = [...drivers].map((driver) => getA19NeuralState(driver)).filter((state) => state !== undefined);
        expect(states.reduce((n, state) => n + state.inferred, 0)).toBeGreaterThan(0);
        expect(states.every((state) => state.missingStart === 0 && state.modelErrors === 0)).toBe(true);
    } finally {
        ready.mockRestore();
        clock.mockRestore();
    }
}, 120_000);

function injected(model: Pick<V09A19CpuModel, "predict">) {
    const drivers = new Set<SearchDriver>();
    const original = SearchDriver.prototype.onFightReady;
    const ready = spyOn(SearchDriver.prototype, "onFightReady").mockImplementation(function (this: SearchDriver) {
        original.call(this);
        attachA19NeuralCorrection(this, { offline: false, model });
        drivers.add(this);
    });
    try {
        const value = scope(false, () => play(false));
        const states = [...drivers].map((driver) => getA19NeuralState(driver)!);
        for (const driver of drivers)
            for (const key of ["shortlistCandidates", "scoreCandidates", "rollout"])
                expect(Object.hasOwn(driver, key)).toBe(false);
        return { value, states };
    } finally {
        ready.mockRestore();
    }
}

test("driver-local advice replaces a completed primary tie without leaving method overrides", () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    try {
        const stock = scope(false, () => play(false));
        const observed = injected({
            predict: (observation) => ({
                policy: observation.candidates.map((_, i) => i * 10),
                primary: [],
                valueLogit: 0,
            }),
        });
        expect(observed.states.reduce((n, state) => n + state.corrected, 0)).toBeGreaterThan(0);
        expect(observed.value).not.toEqual(stock);
    } finally {
        clock.mockRestore();
    }
}, 120_000);

test("model faults keep the complete stock trajectory and restore driver-local hooks", () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    try {
        const stock = scope(false, () => play(false));
        const observed = injected({
            predict: () => {
                throw new Error("model fault");
            },
        });
        expect(observed.value).toEqual(stock);
        expect(observed.states.reduce((n, state) => n + state.modelErrors, 0)).toBeGreaterThan(0);
        expect(observed.states.every((state) => state.corrected === 0)).toBe(true);
    } finally {
        clock.mockRestore();
    }
}, 120_000);

test("late inference keeps the complete stock trajectory within the original allowance", () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
        const stock = scope(false, () => play(false));
        const observed = injected({
            predict: (observation) => {
                now += 1000;
                return { policy: observation.candidates.map((_, i) => i * 10), primary: [], valueLogit: 0 };
            },
        });
        expect(observed.value).toEqual(stock);
        expect(observed.states.reduce((n, state) => n + state.inferenceOverruns, 0)).toBeGreaterThan(0);
        expect(observed.states.every((state) => state.corrected === 0)).toBe(true);
    } finally {
        clock.mockRestore();
    }
}, 120_000);
