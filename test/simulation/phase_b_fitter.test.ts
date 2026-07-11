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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { WAIT_FEATURE_NAMES_V2_RAW } from "../../src/ai/versions/wait_scorer";
import type { IPhaseBQ2Row } from "../../src/simulation/phase_b_dataset";
import {
    MAX_PHASE_B_MODEL_COEFFICIENT,
    phaseBModelStabilityIssue,
} from "../../src/simulation/optimizer/model_stability";

const FINGERPRINT = "c".repeat(64);
const packageRoot = join(import.meta.dir, "../..");

function heldOut(seed: number): boolean {
    let x = seed >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff < 0.15;
}

const trainSeed = Array.from({ length: 100 }, (_, index) => index + 1).find((seed) => !heldOut(seed))!;
const testSeed = Array.from({ length: 100 }, (_, index) => index + 1).find(heldOut)!;

function row(seed: number, label: 0 | 1, delta: number, firstFeature = 0): IPhaseBQ2Row {
    const features = new Array(WAIT_FEATURE_NAMES_V2_RAW.length).fill(0);
    features[0] = firstFeature;
    return {
        t: "q2d",
        v: 2,
        runFingerprint: FINGERPRINT,
        seed,
        greenVersion: "v0.7",
        redVersion: "v0.6",
        lap: 1,
        unit: "Arbalester",
        incumbentKind: "shot",
        incumbentWait: 0,
        incumbentIllegal: 0,
        waitRejected: 0,
        label,
        delta,
        features,
        oracle: { gate: 0.01, rollouts: 3, horizon: "lap", leaf: "learned_v2", opponentModel: null },
    };
}

function writeRows(path: string, rows: readonly IPhaseBQ2Row[]): void {
    writeFileSync(path, `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function runFitter(args: string[]): ReturnType<typeof Bun.spawnSync> {
    return Bun.spawnSync({
        cmd: [process.execPath, "src/simulation/optimizer/fit_wait_v2.mjs", ...args],
        cwd: packageRoot,
        env: { ...process.env },
        stderr: "pipe",
        stdout: "pipe",
    });
}

describe("Phase-B fitter validation", () => {
    it("rejects non-finite and numerically divergent linear models", () => {
        expect(phaseBModelStabilityIssue("stable", { b: 0.1, w: [-2, MAX_PHASE_B_MODEL_COEFFICIENT] })).toBeNull();
        expect(phaseBModelStabilityIssue("nan", { b: Number.NaN, w: [0] })).toContain("non-finite bias");
        expect(
            phaseBModelStabilityIssue("diverged", {
                b: 0,
                w: [MAX_PHASE_B_MODEL_COEFFICIENT + 1],
            }),
        ).toContain("exceeds");
    });

    it("runs the wait fitter against self-describing rows and named arguments", () => {
        const directory = mkdtempSync(join(tmpdir(), "phase-b-wait-fit-"));
        try {
            const path = join(directory, "smoke.jsonl");
            writeRows(path, [row(trainSeed, 1, 0.02), row(testSeed, 0, -0.01)]);
            const result = runFitter([`fingerprint=${FINGERPRINT}`, `smoke=${path}`, "epochs=1", "lr=0.01", "l2=0"]);
            const stdout = new TextDecoder().decode(result.stdout);
            expect(new TextDecoder().decode(result.stderr)).toBe("");
            expect(result.exitCode).toBe(0);
            expect(stdout).toContain(`run fingerprint: ${FINGERPRINT}`);
            expect(stdout).toContain("split by seed: train 1 / test 1");
            expect(stdout).toContain("V07_WAIT_WEIGHTS_V2 JSON (C, delta regression 98, x100)");
            expect(stdout).not.toContain("C): REJECTED");
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("marks a divergent C fit rejected without suppressing A and B candidates", () => {
        const directory = mkdtempSync(join(tmpdir(), "phase-b-wait-divergence-"));
        try {
            const path = join(directory, "divergent.jsonl");
            writeRows(path, [row(trainSeed, 1, 0.02, 10), row(testSeed, 0, -0.01, 10)]);
            const result = runFitter([`fingerprint=${FINGERPRINT}`, `divergent=${path}`, "epochs=6", "lr=0.5", "l2=0"]);
            const stdout = new TextDecoder().decode(result.stdout);
            expect(result.exitCode).toBe(0);
            expect(stdout).toContain("C REJECTED before evaluation");
            expect(stdout).toContain("V07_WAIT_WEIGHTS_V2 JSON (A, linear49 padded): {");
            expect(stdout).toContain("V07_WAIT_WEIGHTS_V2 JSON (B, class-conditional 98): {");
            expect(stdout).toContain("V07_WAIT_WEIGHTS_V2 JSON (C): REJECTED");
            expect(stdout).not.toContain("V07_WAIT_WEIGHTS_V2 JSON (C, delta regression 98, x100): {");
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("rejects an empty train or test partition in every cohort", () => {
        const directory = mkdtempSync(join(tmpdir(), "phase-b-wait-split-"));
        try {
            const completePath = join(directory, "complete.jsonl");
            const trainOnlyPath = join(directory, "train-only.jsonl");
            writeRows(completePath, [row(trainSeed, 1, 0.02), row(testSeed, 0, -0.01)]);
            writeRows(trainOnlyPath, [row(trainSeed, 1, 0.02)]);
            const result = runFitter([
                `fingerprint=${FINGERPRINT}`,
                `complete=${completePath}`,
                `train_only=${trainOnlyPath}`,
                "epochs=1",
            ]);
            expect(result.exitCode).not.toBe(0);
            expect(new TextDecoder().decode(result.stderr)).toContain(
                "train_only: split must contain nonempty train and test rows",
            );
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });
});
