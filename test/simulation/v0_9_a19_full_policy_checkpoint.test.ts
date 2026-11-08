import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
    loadLockedA19FullPolicyPair,
    lockedA19FullPolicyCheckpoint,
    lockedA19FullPolicyInputs,
    LOCKED_A19_FULL_POLICY_PAIR_SHA256,
} from "../../src/simulation/v0_9/a19_full_policy_checkpoint";
import references from "../../src/simulation/v0_9/checkpoints/a19_full_policy_5036_20261108/numerical_references.json";
import { selectV09A19Correction } from "../../src/simulation/v0_9/a19_correction";
import type { IV09A19Observation } from "../../src/simulation/v0_9/a19_observation";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import type { GameAction } from "../../src/engine/actions";

describe("user-locked A19 full-policy checkpoint", () => {
    test("restores both exact original models and profile without rewriting historical metadata", () => {
        const checkpoint = lockedA19FullPolicyCheckpoint();
        const inputs = lockedA19FullPolicyInputs();
        for (const [file, bytes] of [
            ["pair-manifest.json", inputs.manifest],
            ["model.json", inputs.student],
            ["partner-model.json", inputs.partner],
            ["runtime-profile.json", inputs.runtimeProfile],
        ] as const)
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(checkpoint.artifactRawSha256[file]);
        expect(inputs.expectedPairSha256).toBe(LOCKED_A19_FULL_POLICY_PAIR_SHA256);
        expect(JSON.parse(inputs.manifest).promoted).toBe(false);
        expect(JSON.parse(inputs.student).checkpointEpoch).toBe(39);
        expect(JSON.parse(inputs.partner).checkpointEpoch).toBe(39);
        expect(JSON.parse(inputs.runtimeProfile).profile).toBeDefined();
        expect(checkpoint.productionActivation).toBe(false);
        expect(checkpoint.productionTimingQualified).toBe(false);
        expect(checkpoint.result.positiveAdvantageGatePassed).toBe(false);
    });

    test("preserves every consumed board and reconstructs the accepted 6048-game result", () => {
        const checkpoint = lockedA19FullPolicyCheckpoint();
        const evidence = JSON.parse(
            readFileSync(new URL("../../docs/evidence/a19_full_policy_5036_20261108.json", import.meta.url), "utf8"),
        ) as {
            sha256: string;
            boards: (number | string)[][];
            result: typeof checkpoint.result;
            consumedSeedChannels: number[];
        };
        const { sha256, ...body } = evidence;
        expect(sha256).toBe(checkpoint.evidenceSha256);
        expect(fingerprintV09(body)).toBe(sha256);
        expect(evidence.boards.length).toBe(1512);
        const counts = new Map<number, number>([
            [0, 0],
            [0.5, 0],
            [1, 0],
        ]);
        for (const row of evidence.boards) {
            expect(evidence.consumedSeedChannels.includes(row[0] as number)).toBe(true);
            expect(row[6]).toMatch(/^[0-9a-f]{64}$/);
            for (const score of row.slice(2, 6)) {
                expect(counts.has(score as number)).toBe(true);
                counts.set(score as number, counts.get(score as number)! + 1);
            }
        }
        expect(counts.get(1)).toBe(3014);
        expect(counts.get(0.5)).toBe(63);
        expect(counts.get(0)).toBe(2971);
        expect((counts.get(1)! + counts.get(0.5)! / 2) / 6048).toBe(checkpoint.result.score);
        expect(evidence.result).toEqual(checkpoint.result);
        expect(checkpoint.result.board95).toEqual([0.49421296296296297, 0.5127314814814815]);
    });

    test("reproduces original fitted numerical references and the real margin-one choices", () => {
        const checkpoint = lockedA19FullPolicyCheckpoint();
        expect(fingerprintV09(references)).toBe(checkpoint.regressionReferencesSha256);
        const pair = loadLockedA19FullPolicyPair();
        expect(pair.pairSha256).toBe(LOCKED_A19_FULL_POLICY_PAIR_SHA256);
        for (const row of references) {
            const observation = row.observation as IV09A19Observation;
            const members = pair.predictMembers(observation);
            for (let member = 0; member < 2; member++) {
                for (const key of ["policy", "primary"] as const)
                    for (let candidate = 0; candidate < observation.candidates.length; candidate++)
                        expect(
                            Math.abs(members[member][key][candidate] - row.members[member][key][candidate]),
                        ).toBeLessThan(1e-4);
                expect(Math.abs(members[member].valueLogit - row.members[member].valueLogit)).toBeLessThan(1e-4);
            }
            const choice = selectV09A19Correction({
                candidates: observation.candidates.map((candidate) => ({
                    actions: JSON.parse(candidate.signature) as GameAction[],
                })),
                selected: row.native,
                means: observation.candidates.map((_, index) => (row.eligible.includes(index) ? 0 : -1)),
                completed: observation.candidates.map((_, index) => (row.eligible.includes(index) ? 2 : 0)),
                policy: pair.predict(observation).policy,
                minimumLogitGain: 1,
                actionFamily: "all",
            });
            expect(choice).toBe(row.choice);
        }
    });
});
