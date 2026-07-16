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

import { parseWaitWeightsV3, WAIT_FEATURE_NAMES_V2_RAW } from "../../src/ai/versions/wait_scorer";
import type { IPhaseBQ2Row } from "../../src/simulation/phase_b_dataset";
import {
    MAX_PHASE_B_MODEL_COEFFICIENT,
    phaseBModelStabilityIssue,
} from "../../src/simulation/optimizer/model_stability";
import {
    evaluateWaitV3HeldoutGates,
    WAIT_V3_MIN_RANGE_FIRED_SEEDS,
    WAIT_V3_MIN_RANGE_HELDOUT_SEEDS,
    WAIT_V3_MIN_RANGE_POSITIVE_DELTA_CAPTURE,
} from "../../src/simulation/optimizer/wait_v3_gates";

const FINGERPRINT = "c".repeat(64);
const packageRoot = join(import.meta.dir, "../..");

function heldOut(seed: number): boolean {
    let x = seed >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff < 0.15;
}

const trainSeed = Array.from({ length: 100 }, (_, index) => index + 1).find((seed) => !heldOut(seed))!;
const heldOutSeeds = Array.from({ length: 10_000 }, (_, index) => index + 1).filter(heldOut);
const testSeed = heldOutSeeds[0];

function row(
    seed: number,
    label: 0 | 1,
    delta: number,
    firstFeature = 0,
    options: { incumbentKind?: string; ranged?: boolean; caster?: boolean } = {},
): IPhaseBQ2Row {
    const features = new Array(WAIT_FEATURE_NAMES_V2_RAW.length).fill(0);
    features[0] = firstFeature;
    features[WAIT_FEATURE_NAMES_V2_RAW.indexOf("isRanged")] = options.ranged ? 1 : 0;
    features[WAIT_FEATURE_NAMES_V2_RAW.indexOf("isCaster")] = options.caster ? 1 : 0;
    return {
        t: "q2d",
        v: 2,
        runFingerprint: FINGERPRINT,
        seed,
        greenVersion: "v0.7",
        redVersion: "v0.6",
        lap: 1,
        unit: "Arbalester",
        incumbentKind: options.incumbentKind ?? "shot",
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
            expect(stdout).toContain("V3 GATE: REJECTED");
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("emits an action-aware V3 candidate only when held-out RANGE gates pass", () => {
        const directory = mkdtempSync(join(tmpdir(), "phase-b-wait-v3-pass-"));
        try {
            const path = join(directory, "v3-pass.jsonl");
            writeRows(path, [
                row(trainSeed, 1, 0.02, 0, { incumbentKind: "shot", ranged: true }),
                ...heldOutSeeds
                    .slice(0, WAIT_V3_MIN_RANGE_HELDOUT_SEEDS)
                    .map((seed) => row(seed, 1, 0.02, 0, { incumbentKind: "shot", ranged: true })),
            ]);
            const result = runFitter([`fingerprint=${FINGERPRINT}`, `ranged=${path}`, "epochs=1", "lr=0.01", "l2=0"]);
            const stdout = new TextDecoder().decode(result.stdout);
            expect(new TextDecoder().decode(result.stderr)).toBe("");
            expect(result.exitCode).toBe(0);
            expect(stdout).toContain("D: action-aware V3 delta regression 125");
            expect(stdout).toContain('"positiveDeltaCapture":"100.00%"');
            expect(stdout).toContain(`"rangeSeeds":${WAIT_V3_MIN_RANGE_HELDOUT_SEEDS}`);
            expect(stdout).toContain(`"firedSeeds":${WAIT_V3_MIN_RANGE_HELDOUT_SEEDS}`);
            expect(stdout).toContain('"kind":"shot"');
            expect(stdout).toContain("V3 GATE: PASS");
            expect(stdout).toContain("V07_WAIT_WEIGHTS_V3 JSON (D, action-aware delta regression 125, x100): {");
            expect(stdout).not.toContain("V07_WAIT_WEIGHTS_V3 JSON (D): REJECTED");
            const emitted = stdout
                .split("\n")
                .find((line) =>
                    line.startsWith("V07_WAIT_WEIGHTS_V3 JSON (D, action-aware delta regression 125, x100): "),
                )!;
            const weights = parseWaitWeightsV3(emitted.slice(emitted.indexOf("{")));
            expect(weights).not.toBeNull();
            expect(weights!.b !== 0 || weights!.w.some((value) => value !== 0)).toBe(true);
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("does not count protected action kinds as deployable V3 fires", () => {
        const directory = mkdtempSync(join(tmpdir(), "phase-b-wait-v3-protected-"));
        try {
            const path = join(directory, "v3-protected.jsonl");
            writeRows(path, [
                row(trainSeed, 1, 0.02, 0, { incumbentKind: "area_throw", ranged: true }),
                row(testSeed, 1, 0.02, 0, { incumbentKind: "area_throw", ranged: true }),
            ]);
            const result = runFitter([`fingerprint=${FINGERPRINT}`, `ranged=${path}`, "epochs=1", "lr=0.01", "l2=0"]);
            const stdout = new TextDecoder().decode(result.stdout);
            expect(result.exitCode).toBe(0);
            expect(stdout).toContain('"positiveDeltaCapture":"0.00%"');
            expect(stdout).toContain('"firedRows":0');
            expect(stdout).toContain("V3 GATE: REJECTED");
            expect(stdout).toContain("V07_WAIT_WEIGHTS_V3 JSON (D): REJECTED");
            expect(stdout).not.toContain("V07_WAIT_WEIGHTS_V3 JSON (D, action-aware delta regression 125, x100): {");
        } finally {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("requires >=10% RANGE positive-delta capture and positive net fired delta", () => {
        expect(WAIT_V3_MIN_RANGE_POSITIVE_DELTA_CAPTURE).toBe(0.1);
        expect(WAIT_V3_MIN_RANGE_HELDOUT_SEEDS).toBe(256);
        expect(WAIT_V3_MIN_RANGE_FIRED_SEEDS).toBe(32);
        const lowCapture = evaluateWaitV3HeldoutGates([
            { seed: 1, incumbentKind: "shot", isRanged: true, delta: 0.05, fired: true },
            { seed: 2, incumbentKind: "move", isRanged: true, delta: 0.95, fired: false },
        ]);
        expect(lowCapture.pass).toBe(false);
        expect(lowCapture.rangePositiveDeltaCapture).toBeCloseTo(0.05, 10);
        expect(lowCapture.reasons.some((reason) => reason.includes("distinct seeds"))).toBe(true);
        expect(lowCapture.reasons.some((reason) => reason.includes("V3 fires in 1 held-out RANGE seeds"))).toBe(true);
        expect(lowCapture.reasons.some((reason) => reason.includes("below 10.00%"))).toBe(true);

        const negativeFired = evaluateWaitV3HeldoutGates([
            { seed: 1, incumbentKind: "shot", isRanged: true, delta: 0.2, fired: true },
            { seed: 2, incumbentKind: "shot", isRanged: true, delta: -0.3, fired: true },
            { seed: 3, incumbentKind: "move", isRanged: true, delta: 0.8, fired: false },
        ]);
        expect(negativeFired.pass).toBe(false);
        expect(negativeFired.rangePositiveDeltaCapture).toBeCloseTo(0.2, 10);
        expect(negativeFired.rangeFiredDelta).toBeCloseTo(-0.1, 10);
        expect(negativeFired.reasons.some((reason) => reason.includes("must be positive"))).toBe(true);
    });

    it("rejects a negative RANGE action bucket even when pooled fired delta is positive", () => {
        const result = evaluateWaitV3HeldoutGates([
            { seed: 1, incumbentKind: "shot", isRanged: true, delta: 0.3, fired: true },
            { seed: 2, incumbentKind: "move", isRanged: true, delta: -0.1, fired: true },
            { seed: 3, incumbentKind: "defend", isRanged: true, delta: 0.1, fired: false },
            { seed: 4, incumbentKind: "spell", isRanged: false, delta: -10, fired: true },
        ]);
        expect(result.rangePositiveDeltaCapture).toBeCloseTo(0.75, 10);
        expect(result.rangeFiredDelta).toBeCloseTo(0.2, 10);
        expect(result.pass).toBe(false);
        expect(result.reasons).toContain("RANGE action bucket move has negative fired-row oracle delta -0.100000");
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
