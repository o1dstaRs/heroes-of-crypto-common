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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import {
    canonicalPhaseBSeed,
    type IPhaseBQ2Row,
    type IPhaseBValueRow,
    parsePhaseBFitterArgs,
    parsePhaseBQ2Row,
    parsePhaseBValueRow,
    requirePhaseBRunFingerprint,
} from "../../src/simulation/phase_b_dataset";
import { VALUE_FEATURE_NAMES, VALUE_FEATURE_NAMES_V2_RAW } from "../../src/simulation/value_features";

const FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);
const VALUE_ENV_KEYS = ["VALUE_DATA", "VALUE_DATA_FEATURES", "PHASE_B_RUN_FINGERPRINT"] as const;
const savedEnv = Object.fromEntries(VALUE_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const key of VALUE_ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

const valueRow = (): IPhaseBValueRow => ({
    t: "phase_b_value",
    v: 2,
    runFingerprint: FINGERPRINT,
    seed: -1,
    greenVersion: "v0.7",
    redVersion: "v0.6",
    actingSide: "green",
    label: 1,
    features: [0.1, -0.2],
});

const q2Row = (): IPhaseBQ2Row => ({
    t: "q2d",
    v: 2,
    runFingerprint: FINGERPRINT,
    seed: 7,
    greenVersion: "v0.6s",
    redVersion: "v0.6",
    lap: 2,
    unit: "Arbalester",
    incumbentKind: "shot",
    incumbentWait: 0,
    incumbentIllegal: 0,
    waitRejected: 0,
    label: 1,
    delta: 0.02,
    features: [0.1, -0.2],
    oracle: { gate: 0.01, rollouts: 3, horizon: "lap", leaf: "learned_v2", opponentModel: null },
});

describe("Phase-B dataset contract", () => {
    it("normalizes fingerprints and signed/unsigned seed serializations", () => {
        expect(requirePhaseBRunFingerprint(FINGERPRINT.toUpperCase())).toBe(FINGERPRINT);
        expect(() => requirePhaseBRunFingerprint("abc")).toThrow("64 hexadecimal");
        expect(canonicalPhaseBSeed(-1)).toBe(0xffffffff);
        expect(canonicalPhaseBSeed(0xffffffff)).toBe(0xffffffff);
        expect(canonicalPhaseBSeed(-0x80000000)).toBe(0x80000000);
        expect(() => canonicalPhaseBSeed(0x100000000)).toThrow("signed int32 or uint32");
        expect(() => canonicalPhaseBSeed(1.5)).toThrow("signed int32 or uint32");
    });

    it("strictly validates value rows and rejects mixed provenance", () => {
        expect(parsePhaseBValueRow(valueRow(), 2, FINGERPRINT)).toEqual({
            ...valueRow(),
            seed: 0xffffffff,
        });
        expect(() => parsePhaseBValueRow(valueRow(), 2, OTHER_FINGERPRINT)).toThrow("does not match");
        expect(() => parsePhaseBValueRow({ ...valueRow(), label: 2 }, 2, FINGERPRINT)).toThrow("expected 0 or 1");
        expect(() => parsePhaseBValueRow({ ...valueRow(), features: [0.1, Number.NaN] }, 2, FINGERPRINT)).toThrow(
            "finite number",
        );
        expect(() => parsePhaseBValueRow({ ...valueRow(), v: 1 }, 2, FINGERPRINT)).toThrow("expected phase_b_value v2");
    });

    it("strictly validates Q2 flags and effective oracle provenance", () => {
        expect(parsePhaseBQ2Row(q2Row(), 2, FINGERPRINT).oracle).toEqual(q2Row().oracle);
        expect(() => parsePhaseBQ2Row({ ...q2Row(), incumbentWait: 1, delta: 0.02 }, 2, FINGERPRINT)).toThrow(
            "delta must be null",
        );
        expect(() =>
            parsePhaseBQ2Row({ ...q2Row(), oracle: { ...q2Row().oracle, rollouts: 0 } }, 2, FINGERPRINT),
        ).toThrow("positive integer");
        expect(() =>
            parsePhaseBQ2Row({ ...q2Row(), oracle: { ...q2Row().oracle, horizon: "turns" } }, 2, FINGERPRINT),
        ).toThrow("expected lap");
    });

    it("parses named fitter hyperparameters and requires an explicit fingerprint", () => {
        expect(
            parsePhaseBFitterArgs(
                [
                    `fingerprint=${FINGERPRINT}`,
                    "melee=/tmp/melee.jsonl",
                    "ranged=/tmp/ranged.jsonl",
                    "epochs=12",
                    "lr=0.25",
                    "l2=0.003",
                ],
                { epochs: 300, learningRate: 0.5, l2: 0.0001 },
            ),
        ).toEqual({
            runFingerprint: FINGERPRINT,
            files: [
                { cohort: "melee", path: "/tmp/melee.jsonl" },
                { cohort: "ranged", path: "/tmp/ranged.jsonl" },
            ],
            epochs: 12,
            learningRate: 0.25,
            l2: 0.003,
        });
        expect(() =>
            parsePhaseBFitterArgs(["melee=/tmp/melee.jsonl"], {
                epochs: 300,
                learningRate: 0.5,
                l2: 0.0001,
            }),
        ).toThrow("fingerprint");
    });

    it("resolves VALUE_DATA mode per match and preserves the legacy V1 row shape", () => {
        const dir = mkdtempSync(join(tmpdir(), "phase-b-value-"));
        const v2Path = join(dir, "v2.jsonl");
        const legacyPath = join(dir, "legacy.jsonl");
        const roster = buildRoster(makeRng(123));
        process.env.VALUE_DATA = v2Path;
        process.env.VALUE_DATA_FEATURES = "v2";
        process.env.PHASE_B_RUN_FINGERPRINT = FINGERPRINT;
        const config = { greenVersion: "v0.1", redVersion: "v0.1", roster, seed: 123, maxLaps: 60 };
        expect(runMatch(config).winner).not.toBe("draw");
        const v2Rows = readFileSync(v2Path, "utf8")
            .trim()
            .split("\n")
            .map((line, index) =>
                parsePhaseBValueRow(
                    JSON.parse(line),
                    VALUE_FEATURE_NAMES_V2_RAW.length,
                    FINGERPRINT,
                    `value row ${index}`,
                ),
            );
        expect(v2Rows.length).toBeGreaterThan(0);
        expect(v2Rows.every((row) => row.seed === 123 && row.greenVersion === "v0.1")).toBe(true);

        process.env.VALUE_DATA = legacyPath;
        delete process.env.VALUE_DATA_FEATURES;
        delete process.env.PHASE_B_RUN_FINGERPRINT;
        expect(runMatch(config).winner).not.toBe("draw");
        const legacyRows = readFileSync(legacyPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(legacyRows.length).toBeGreaterThan(0);
        expect(legacyRows.every((row) => Array.isArray(row) && row.length === VALUE_FEATURE_NAMES.length + 1)).toBe(
            true,
        );
    });

    it("fails before a V2 value-data match when the fingerprint is missing", () => {
        process.env.VALUE_DATA = join(mkdtempSync(join(tmpdir(), "phase-b-value-missing-")), "v2.jsonl");
        process.env.VALUE_DATA_FEATURES = "v2";
        delete process.env.PHASE_B_RUN_FINGERPRINT;
        expect(() =>
            runMatch({
                greenVersion: "v0.1",
                redVersion: "v0.1",
                roster: buildRoster(makeRng(123)),
                seed: 123,
            }),
        ).toThrow("PHASE_B_RUN_FINGERPRINT");
    });
});
