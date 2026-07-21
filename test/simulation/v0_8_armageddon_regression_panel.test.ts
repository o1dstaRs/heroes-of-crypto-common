/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import type { IRecordedAction } from "../../src/simulation/battle_engine";
import {
    buildV08ArmageddonRegressionEnvironment,
    captureV08ArmageddonRegressionSourceIdentity,
    planV08ArmageddonRegressionGame,
    selectedV08ArmageddonRegressionIndices,
    summarizeV08ArmageddonActions,
    validateV08ArmageddonRegressionRecord,
    V08_ARMAGEDDON_BASELINE_INDICES,
    V08_ARMAGEDDON_REGRESSION_BASE_SEED,
    V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES,
    V08_ARMAGEDDON_REGRESSION_MAPS,
    V08_ARMAGEDDON_RESIDUAL_INDICES,
    type IV08ArmageddonRegressionRecordEvidence,
} from "../../src/simulation/v0_8_armageddon_regression_panel";

function recordFor(game: number, candidate: "v0.8" | "v0.8s" = "v0.8s"): IV08ArmageddonRegressionRecordEvidence {
    const plan = planV08ArmageddonRegressionGame(game, candidate);
    return {
        game,
        greenEntrant: plan.greenEntrant,
        greenVersion: plan.greenVersion,
        redVersion: plan.redVersion,
        result: { seed: plan.seed, gridType: plan.mapType },
    };
}

describe("v0.8 Armageddon regression panel", () => {
    it("seals the sorted 66-game baseline and named residual-14 subset", () => {
        expect(V08_ARMAGEDDON_REGRESSION_BASE_SEED).toBe(8_262_801);
        expect(V08_ARMAGEDDON_REGRESSION_BASELINE_GAMES).toBe(6_000);
        expect(V08_ARMAGEDDON_REGRESSION_MAPS).toEqual([
            { name: "normal", type: 1 },
            { name: "lava", type: 3 },
            { name: "block", type: 4 },
        ]);
        expect(V08_ARMAGEDDON_BASELINE_INDICES).toHaveLength(66);
        expect(new Set(V08_ARMAGEDDON_BASELINE_INDICES).size).toBe(66);
        expect([...V08_ARMAGEDDON_BASELINE_INDICES].sort((left, right) => left - right)).toEqual(
            V08_ARMAGEDDON_BASELINE_INDICES,
        );
        expect(V08_ARMAGEDDON_RESIDUAL_INDICES).toEqual([
            468, 586, 906, 1176, 2593, 2793, 3906, 4113, 4573, 4705, 5463, 5494, 5672, 5763,
        ]);
        expect(V08_ARMAGEDDON_RESIDUAL_INDICES.every((game) => V08_ARMAGEDDON_BASELINE_INDICES.includes(game))).toBe(
            true,
        );
        expect(selectedV08ArmageddonRegressionIndices()).toBe(V08_ARMAGEDDON_BASELINE_INDICES);
        expect(selectedV08ArmageddonRegressionIndices(true)).toBe(V08_ARMAGEDDON_RESIDUAL_INDICES);
    });

    it("reproduces exact baseline seed and map draws at golden even/odd indices", () => {
        expect(planV08ArmageddonRegressionGame(468)).toMatchObject({
            game: 468,
            pair: 234,
            seed: 2_670_940_251,
            mapName: "block",
            mapType: 4,
            candidateSide: "green",
        });
        expect(planV08ArmageddonRegressionGame(586)).toMatchObject({
            seed: 368_860_198,
            mapName: "lava",
            mapType: 3,
            candidateSide: "green",
        });
        expect(planV08ArmageddonRegressionGame(2793)).toMatchObject({
            seed: 3_338_776_005,
            mapName: "lava",
            mapType: 3,
            candidateSide: "red",
            greenEntrant: "b",
            greenVersion: "v0.7",
            redVersion: "v0.8s",
        });
        expect(planV08ArmageddonRegressionGame(5878)).toMatchObject({
            seed: 1_734_354_844,
            mapName: "lava",
            mapType: 3,
            candidateSide: "green",
        });
    });

    it("keeps pair geometry identical while swapping stable and experimental physical seats", () => {
        const experimentalEven = planV08ArmageddonRegressionGame(468, "v0.8s");
        const experimentalOdd = planV08ArmageddonRegressionGame(469, "v0.8s");
        expect(experimentalOdd.seed).toBe(experimentalEven.seed);
        expect(experimentalOdd.mapType).toBe(experimentalEven.mapType);
        expect(experimentalEven).toMatchObject({ candidateSide: "green", greenVersion: "v0.8s", redVersion: "v0.7" });
        expect(experimentalOdd).toMatchObject({ candidateSide: "red", greenVersion: "v0.7", redVersion: "v0.8s" });

        const stableEven = planV08ArmageddonRegressionGame(468, "v0.8");
        const stableOdd = planV08ArmageddonRegressionGame(469, "v0.8");
        expect(stableEven).toMatchObject({ candidateSide: "green", greenVersion: "v0.8", redVersion: "v0.7" });
        expect(stableOdd).toMatchObject({ candidateSide: "red", greenVersion: "v0.7", redVersion: "v0.8" });
        expect(stableEven.seed).toBe(experimentalEven.seed);
        expect(stableEven.mapType).toBe(experimentalEven.mapType);
    });

    it("fails closed on wrong selected index, seat, seed, or map evidence", () => {
        expect(validateV08ArmageddonRegressionRecord(recordFor(468))).toMatchObject({
            seed: 2_670_940_251,
            mapType: 4,
        });
        expect(validateV08ArmageddonRegressionRecord(recordFor(2793, "v0.8"), "v0.8")).toMatchObject({
            candidateSide: "red",
        });
        expect(() => validateV08ArmageddonRegressionRecord(recordFor(469))).toThrow("unselected game index");
        expect(() => validateV08ArmageddonRegressionRecord({ ...recordFor(468), greenVersion: "v0.7" })).toThrow(
            "seat/version",
        );
        expect(() =>
            validateV08ArmageddonRegressionRecord({
                ...recordFor(468),
                result: { ...recordFor(468).result, seed: 1 },
            }),
        ).toThrow("seed drifted");
        expect(() =>
            validateV08ArmageddonRegressionRecord({
                ...recordFor(468),
                result: { ...recordFor(468).result, gridType: 1 },
            }),
        ).toThrow("map drifted");
    });

    it("binds stable and experimental to their exact bounded scopes and scrubs inherited knobs", () => {
        const hostile = {
            PATH: "/bin",
            HOME: "/unexpected",
            NODE_OPTIONS: "--require=/tmp/hostile.js",
            SEARCH_GATE: "999",
            TOTALLY_UNKNOWN_BEHAVIOR_SWITCH: "1",
        };
        const stable = buildV08ArmageddonRegressionEnvironment("/tmp/stable-audit.jsonl", "stable", hostile);
        const experimental = buildV08ArmageddonRegressionEnvironment(
            "/tmp/experimental-audit.jsonl",
            "experimental",
            hostile,
        );
        expect(stable.candidateEnvironment).toMatchObject({
            SEARCH_VERSIONS: "v0.8",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            LIVETWIN: "1",
        });
        expect(experimental.candidateEnvironment).toMatchObject({
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_DECISION_DEADLINE_MS: "175",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
            LIVETWIN: "1",
        });
        expect(stable.frozenEnvironmentSha256).not.toBe(experimental.frozenEnvironmentSha256);
        expect(stable.environment.PATH).toBe("/bin");
        expect(stable.environment.HOME).toBeUndefined();
        expect(stable.environment.NODE_OPTIONS).toBeUndefined();
        expect(stable.environment.TOTALLY_UNKNOWN_BEHAVIOR_SWITCH).toBeUndefined();
        expect(stable.environment.SEARCH_GATE).toBe("0.02");
    });

    it("records the mutable source bundle and reports the sealed-r1 check independently", () => {
        const identity = captureV08ArmageddonRegressionSourceIdentity();
        expect(identity.workingTreeSourceBundleSha256).toHaveLength(64);
        expect(Object.keys(identity.sourceFiles)).toContain("src/ai/versions/v0_8s.ts");
        expect(Object.keys(identity.sourceFiles)).toContain("src/simulation/search_driver.ts");
        expect(typeof identity.sealedR1Pin.matched).toBe("boolean");
        if (!identity.sealedR1Pin.matched) expect(identity.sealedR1Pin.mismatch).toContain("repin");
    });

    it("reports exact named mountain/end/defend/wait action counts", () => {
        const action = (actionType: IRecordedAction["actionType"], side: "green" | "red" = "green", completed = true) =>
            ({ actionType, side, lap: 9, completed }) as IRecordedAction;
        const summary = summarizeV08ArmageddonActions(
            [
                action("obstacle_attack"),
                action("obstacle_attack", "green", false),
                action("end_turn"),
                action("defend_turn"),
                action("wait_turn"),
                action("wait_turn"),
                action("wait_turn", "red"),
            ],
            "green",
        );
        expect(summary.policyCounts).toEqual({
            attempted: { mountain: 2, end: 1, defend: 1, wait: 2 },
            completed: { mountain: 1, end: 1, defend: 1, wait: 2 },
        });
        expect(summary.recorded).toBe(6);
        expect(summary.completed).toBe(5);
        expect(summary.rejected).toBe(1);
        expect(summary.fromLap9AttemptedByType).toMatchObject({
            obstacle_attack: 2,
            end_turn: 1,
            defend_turn: 1,
            wait_turn: 2,
        });
        expect(summary.fromLap9CompletedByType).toMatchObject({
            obstacle_attack: 1,
            end_turn: 1,
            defend_turn: 1,
            wait_turn: 2,
        });
    });
});
