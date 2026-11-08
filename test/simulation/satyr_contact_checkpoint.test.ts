import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import evidence from "../../docs/evidence/satyr_contact_20261108.json";
import { lockedSatyrContactCheckpoint } from "../../src/simulation/satyr_contact_checkpoint";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";

describe("user-locked Satyr contact research checkpoint", () => {
    test("preserves the exact measured policy and original failed gate", () => {
        const checkpoint = lockedSatyrContactCheckpoint();
        const source = readFileSync(new URL("../../src/simulation/satyr_contact_policy.ts", import.meta.url));
        expect(createHash("sha256").update(source).digest("hex")).toBe(checkpoint.policySha256);
        expect(checkpoint.productionActivation).toBe(false);
        expect(checkpoint.productionTimingQualified).toBe(false);
        expect(checkpoint.originalProgressionGatePassed).toBe(false);
        checkpoint.primary.pairedGainPp = 0;
        expect(lockedSatyrContactCheckpoint().primary.pairedGainPp).toBeGreaterThan(4);
    });

    test("reconstructs every arm from all 72 independent boards and retains consumed seeds", () => {
        const checkpoint = lockedSatyrContactCheckpoint();
        const { sha256, ...body } = evidence;
        expect(fingerprintV09(body)).toBe(sha256);
        expect(sha256).toBe(checkpoint.evidenceSha256);
        expect(evidence.boards).toHaveLength(72);
        expect(new Set(evidence.consumedSeedChannels).size).toBe(150);
        for (const arm of ["stock", "candidate", "locked"] as const) {
            const scores = evidence.boards.flatMap((board) => board.scores[arm]);
            expect(scores).toHaveLength(144);
            expect(scores.filter((score) => score === 1)).toHaveLength(evidence.arms[arm].wins);
            expect(scores.filter((score) => score === 0.5)).toHaveLength(evidence.arms[arm].draws);
            expect(scores.filter((score) => score === 0)).toHaveLength(evidence.arms[arm].losses);
        }
        for (const board of evidence.boards) {
            expect(evidence.consumedSeedChannels).toContain(board.setupSeed);
            expect(evidence.consumedSeedChannels).toContain(board.combatSeed);
        }
        const gain = evidence.boards.reduce(
            (sum, board) =>
                sum +
                board.scores.candidate[0] +
                board.scores.candidate[1] -
                board.scores.stock[0] -
                board.scores.stock[1],
            0,
        );
        expect((100 * gain) / 144).toBeCloseTo(checkpoint.primary.pairedGainPp, 12);
        expect(checkpoint.primary.wholeBoard95Pp).toEqual([-2.0833333333333335, 11.458333333333334]);
    });
});
