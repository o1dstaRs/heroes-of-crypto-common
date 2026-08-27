/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, test } from "bun:test";

import {
    aggregateRaceObservations,
    buildRaceKeepSchedule,
    JOINT_VECTOR_DIMENSIONS,
    jointBlockForGeneration,
    jointCoordinateIsActive,
    parseJointBlockOptions,
    parsePositiveIntegerList,
    rankRaceCandidates,
    refitDiagonalDistribution,
    wilsonScore,
} from "./side_cem_core";

describe("side CEM racing", () => {
    test("pools decisive counts instead of averaging panel rates", () => {
        const score = aggregateRaceObservations([
            { wins: 9, decisive: 10 },
            { wins: 10, decisive: 90 },
        ]);
        expect(score.wins).toBe(19);
        expect(score.decisive).toBe(100);
        expect(score.rate).toBeCloseTo(0.19);
    });

    test("Wilson score handles empty and ordinary panels", () => {
        expect(wilsonScore(0, 0)).toEqual({ wins: 0, decisive: 0, rate: 0, lo: 0, hi: 1 });
        const score = wilsonScore(60, 100);
        expect(score.rate).toBe(0.6);
        expect(score.lo).toBeCloseTo(0.502, 2);
        expect(score.hi).toBeCloseTo(0.691, 2);
    });

    test("ranking is deterministic and confidence-bound first", () => {
        const ranked = rankRaceCandidates([
            { index: 7, observations: [{ wins: 6, decisive: 10 }] },
            { index: 4, observations: [{ wins: 60, decisive: 100 }] },
            { index: 2, observations: [{ wins: 60, decisive: 100 }] },
        ]);
        expect(ranked.map(({ candidate }) => candidate.index)).toEqual([2, 4, 7]);
    });

    test("successive-halving defaults never cut below the elite count", () => {
        expect(buildRaceKeepSchedule(20, 5, 3)).toEqual([10, 5]);
        expect(buildRaceKeepSchedule(6, 5, 4)).toEqual([5, 5, 5]);
        expect(buildRaceKeepSchedule(20, 5, 3, [12, 6])).toEqual([12, 6]);
        expect(() => buildRaceKeepSchedule(20, 5, 3, [4])).toThrow("between elite");
    });

    test("integer-list parsing rejects ambiguous schedules", () => {
        expect(parsePositiveIntegerList("12, 24,48", "pairs")).toEqual([12, 24, 48]);
        expect(parsePositiveIntegerList(undefined, "pairs")).toEqual([]);
        expect(() => parsePositiveIntegerList("12,0", "pairs")).toThrow("pairs[1]");
    });
});

describe("side CEM joint blocks", () => {
    test("alternates leaf and wait blocks at the configured generation span", () => {
        const options = parseJointBlockOptions("alternate", "2", "leaf");
        expect([0, 1, 2, 3, 4].map((generation) => jointBlockForGeneration(options, generation))).toEqual([
            "leaf",
            "leaf",
            "wait",
            "wait",
            "leaf",
        ]);
    });

    test("uses the exact 61/42 joint boundary", () => {
        expect(JOINT_VECTOR_DIMENSIONS).toBe(103);
        expect(jointCoordinateIsActive("leaf", 60)).toBe(true);
        expect(jointCoordinateIsActive("leaf", 61)).toBe(false);
        expect(jointCoordinateIsActive("wait", 60)).toBe(false);
        expect(jointCoordinateIsActive("wait", 61)).toBe(true);
        expect(jointCoordinateIsActive("wait", 102)).toBe(true);
    });

    test("keeps legacy all-coordinate mode as the default", () => {
        const options = parseJointBlockOptions(undefined, undefined, undefined);
        expect(jointBlockForGeneration(options, 50)).toBe("all");
        expect(jointCoordinateIsActive("all", 0)).toBe(true);
        expect(jointCoordinateIsActive("all", 102)).toBe(true);
    });
});

describe("side CEM diagonal refit", () => {
    test("alpha zero exactly preserves legacy sigma decay", () => {
        const refit = refitDiagonalDistribution(
            { mean: [10, 20], sigma: [2, 4] },
            [
                [1, 30],
                [3, 50],
            ],
            { active: [true, true], sigmaFloor: 0.1, sigmaDecay: 0.5, eliteVarianceAlpha: 0 },
        );
        expect(refit).toEqual({ mean: [2, 40], sigma: [1, 2] });
    });

    test("blends elite variance and leaves inactive coordinates byte-stable", () => {
        const refit = refitDiagonalDistribution(
            { mean: [10, 20], sigma: [2, 4] },
            [
                [1, 30],
                [5, 50],
            ],
            { active: [true, false], sigmaFloor: 0.1, sigmaDecay: 0.5, eliteVarianceAlpha: 0.25 },
        );
        // active dim: elite mean=3, elite variance=4, decayed prior variance=1 -> 0.75*1 + 0.25*4
        expect(refit.mean).toEqual([3, 20]);
        expect(refit.sigma[0]).toBeCloseTo(Math.sqrt(1.75));
        expect(refit.sigma[1]).toBe(4);
    });
});
