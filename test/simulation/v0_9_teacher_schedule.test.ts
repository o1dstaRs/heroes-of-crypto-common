import { describe, expect, it } from "bun:test";

import { V09_DEFAULT_SEED_COUNTS } from "../../src/simulation/v0_9/campaign";
import {
    V09_DAGGER_TRAJECTORY_PATTERNS,
    V09_TEACHER_COHORTS,
    V09_TEACHER_MAP_NAMES,
} from "../../src/simulation/v0_9/protocol";
import {
    V09_TEACHER_WORK_ASSIGNMENT,
    v09TeacherWorkerForIndex,
    v09TeacherWorkerIndices,
} from "../../src/simulation/v0_9/teacher_schedule";

const lane = (totalGames: number, workerIndex: number, workers: number): number[] => [
    ...v09TeacherWorkerIndices(totalGames, workerIndex, workers),
];

const cohortForIndex = (index: number): string => V09_TEACHER_COHORTS[index % V09_TEACHER_COHORTS.length]!;
const patternForIndex = (index: number): string =>
    V09_DAGGER_TRAJECTORY_PATTERNS[index % V09_DAGGER_TRAJECTORY_PATTERNS.length]!;
const mapForIndex = (index: number): string =>
    V09_TEACHER_MAP_NAMES[Math.floor(index / V09_TEACHER_COHORTS.length) % V09_TEACHER_MAP_NAMES.length]!;

describe("v0.9 teacher worker schedule", () => {
    it("covers every immutable index exactly once with balanced deterministic lanes", () => {
        for (const [totalGames, workers] of [
            [0, 20],
            [1, 20],
            [19, 20],
            [20, 20],
            [21, 20],
            [1_024, 20],
            [7_168, 23],
            [21_504, 24],
        ] as const) {
            const first = Array.from({ length: workers }, (_, workerIndex) => lane(totalGames, workerIndex, workers));
            const second = Array.from({ length: workers }, (_, workerIndex) => lane(totalGames, workerIndex, workers));
            expect(second).toEqual(first);

            const flattened = first.flat();
            expect(flattened).toHaveLength(totalGames);
            expect(new Set(flattened)).toHaveLength(totalGames);
            expect(flattened.toSorted((left, right) => left - right)).toEqual(
                Array.from({ length: totalGames }, (_, index) => index),
            );

            const laneSizes = first.map((indices) => indices.length);
            expect(Math.max(...laneSizes) - Math.min(...laneSizes)).toBeLessThanOrEqual(1);
            for (const [workerIndex, indices] of first.entries()) {
                expect(indices).toEqual(indices.toSorted((left, right) => left - right));
                for (const index of indices) {
                    expect(v09TeacherWorkerForIndex(index, workers)).toBe(workerIndex);
                }
            }
        }
    });

    it("keeps the first round contiguous for existing limit-one smoke semantics", () => {
        const workers = 20;
        for (const totalGames of [1, workers - 1, workers, workers + 1, 1_024]) {
            const firstIndices = Array.from(
                { length: workers },
                (_, workerIndex) => lane(totalGames, workerIndex, workers)[0],
            )
                .filter((index): index is number => index !== undefined)
                .toSorted((left, right) => left - right);
            expect(firstIndices).toEqual(Array.from({ length: Math.min(totalGames, workers) }, (_, index) => index));
        }
    });

    it("breaks the legacy 20-worker cohort and DAgger-pattern aliasing", () => {
        const workers = 20;
        const totalGames = V09_DEFAULT_SEED_COUNTS.dagger_1_validation;

        for (let workerIndex = 0; workerIndex < workers; workerIndex += 1) {
            const indices = lane(totalGames, workerIndex, workers);
            expect(new Set(indices.map(cohortForIndex))).toEqual(new Set(V09_TEACHER_COHORTS));
            expect(new Set(indices.map(patternForIndex))).toEqual(new Set(V09_DAGGER_TRAJECTORY_PATTERNS));
            expect(new Set(indices.map(mapForIndex))).toEqual(new Set(V09_TEACHER_MAP_NAMES));

            const legacyIndices = Array.from(
                { length: Math.ceil(Math.max(0, totalGames - workerIndex) / workers) },
                (_, offset) => workerIndex + offset * workers,
            ).filter((index) => index < totalGames);
            expect(new Set(legacyIndices.map(cohortForIndex))).toHaveLength(3);
            expect(new Set(legacyIndices.map(patternForIndex))).toHaveLength(1);
        }
    });

    it("balances every production stream across 20-worker cohort and pattern lanes", () => {
        const workers = 20;
        for (const totalGames of Object.values(V09_DEFAULT_SEED_COUNTS)) {
            const lanes = Array.from({ length: workers }, (_, workerIndex) => lane(totalGames, workerIndex, workers));
            for (const cohort of V09_TEACHER_COHORTS) {
                const counts = lanes.map(
                    (indices) => indices.filter((index) => cohortForIndex(index) === cohort).length,
                );
                expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
            }
            for (const pattern of V09_DAGGER_TRAJECTORY_PATTERNS) {
                const counts = lanes.map(
                    (indices) => indices.filter((index) => patternForIndex(index) === pattern).length,
                );
                expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
            }
        }
        expect(V09_TEACHER_WORK_ASSIGNMENT).toBe("rotating-round-robin-v1");
    });

    it("rejects invalid game and worker identities", () => {
        expect(() => v09TeacherWorkerForIndex(-1, 20)).toThrow(RangeError);
        expect(() => v09TeacherWorkerForIndex(0, 0)).toThrow(RangeError);
        expect(() => lane(-1, 0, 20)).toThrow(RangeError);
        expect(() => lane(10, -1, 20)).toThrow(RangeError);
        expect(() => lane(10, 20, 20)).toThrow(RangeError);
    });
});
