import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
    validateV09ActorGameShards,
    validateV09ActorShardNames,
} from "../../src/simulation/v0_9/actor_output_validation";
import { V09GameRecorder } from "../../src/simulation/v0_9/recorder";

const shardName = (index: number, seed: number): string => `${String(index).padStart(6, "0")}-${seed}.jsonl`;

function validShard(path: string, seed: number): void {
    const identity = {
        runFingerprint: "a".repeat(64),
        sourceCommit: "b".repeat(40),
        rulesFingerprint: "c".repeat(64),
        anchorFingerprint: "d".repeat(64),
    };
    new V09GameRecorder(identity, {
        sourceCommit: identity.sourceCommit,
        rulesFingerprint: identity.rulesFingerprint,
        anchorFingerprint: identity.anchorFingerprint,
        phase: "wide_teacher",
        split: "train",
        cohort: "ranked-draft",
        map: "normal",
        seed,
        gameId: `wide_teacher_train:${seed}`,
        greenVersion: "v0.8+a13",
        redVersion: "v0.8+a13",
        winner: "draw",
        endReason: "stuck",
    }).finalize(path);
}

describe("v0.9 actor output shard-name validation", () => {
    it("accepts unordered exact coverage and returns canonical seed-lane order", () => {
        const seeds = [41, 73, 109];
        const files = [shardName(2, seeds[2]!), shardName(0, seeds[0]!), shardName(1, seeds[1]!)];

        expect(
            validateV09ActorShardNames({
                files,
                seeds,
                expected: seeds.length,
                purpose: "wide_teacher_train",
                binding: "v0.8-a13",
            }),
        ).toEqual([shardName(0, seeds[0]!), shardName(1, seeds[1]!), shardName(2, seeds[2]!)]);
    });

    it("preserves count-first and lowest-missing-lane failures", () => {
        const seeds = [41, 73, 109];
        const common = {
            seeds,
            expected: seeds.length,
            purpose: "wide_teacher_validation",
            binding: "v0.8-a13",
        };

        expect(() =>
            validateV09ActorShardNames({
                ...common,
                files: [shardName(0, seeds[0]!)],
            }),
        ).toThrow("wide_teacher_validation/v0.8-a13 has 1 complete shards; expected 3");

        expect(() =>
            validateV09ActorShardNames({
                ...common,
                files: ["unexpected-a.jsonl", shardName(1, seeds[1]!), "unexpected-b.jsonl"],
            }),
        ).toThrow("wide_teacher_validation/v0.8-a13 is missing exact seed lane 0");
    });

    it("handles the full wide-teacher train cardinality without changing canonical ordering", () => {
        const expected = 21_504;
        const seeds = Array.from({ length: expected }, (_, index) => (index * 2_654_435_761) >>> 0);
        const files = seeds.map((seed, index) => shardName(index, seed)).reverse();

        const ordered = validateV09ActorShardNames({
            files,
            seeds,
            expected,
            purpose: "wide_teacher_train",
            binding: "v0.8-a13",
        });

        expect(ordered).toHaveLength(expected);
        expect(ordered[0]).toBe(shardName(0, seeds[0]!));
        expect(ordered.at(-1)).toBe(shardName(expected - 1, seeds.at(-1)!));
    });

    it("parallel-validates large shard sets while retaining canonical result order", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-parallel-shards-"));
        const paths = Array.from({ length: 64 }, (_, index) => {
            const path = join(directory, shardName(index, index + 1));
            validShard(path, index + 1);
            return path;
        });

        const sequential = await validateV09ActorGameShards(paths, 1);
        const parallel = await validateV09ActorGameShards(paths, 4);

        expect(parallel).toEqual(sequential);
        expect(parallel.map((result) => result.index)).toEqual(
            Array.from({ length: paths.length }, (_, index) => index),
        );
        expect(parallel.every((result) => result.ok)).toBe(true);
    });

    it("returns parse failures by canonical lane instead of worker completion order", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-parallel-failures-"));
        const paths = Array.from({ length: 64 }, (_, index) => {
            const path = join(directory, shardName(index, index + 1));
            validShard(path, index + 1);
            return path;
        });
        writeFileSync(paths[7]!, "{bad-seven\n");
        writeFileSync(paths[51]!, "{bad-fifty-one\n");

        const results = await validateV09ActorGameShards(paths, 4);

        expect(results[7]).toMatchObject({ index: 7, ok: false });
        expect(results[51]).toMatchObject({ index: 51, ok: false });
        expect(results.find((result) => !result.ok)?.index).toBe(7);
    });
});
