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

export const PHASE_B_DATASET_VERSION = 2 as const;
export const PHASE_B_VALUE_ROW_TYPE = "phase_b_value" as const;
export const PHASE_B_Q2_ROW_TYPE = "q2d" as const;

const RUN_FINGERPRINT = /^[0-9a-f]{64}$/i;
const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;

type JsonRecord = Record<string, unknown>;

function recordOf(value: unknown, context: string): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${context}: expected an object row`);
    }
    return value as JsonRecord;
}

function nonEmptyString(value: unknown, context: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${context}: expected a non-empty string`);
    }
    return value;
}

function binary(value: unknown, context: string): 0 | 1 {
    if (value !== 0 && value !== 1) {
        throw new Error(`${context}: expected 0 or 1`);
    }
    return value;
}

function finiteNumber(value: unknown, context: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${context}: expected a finite number`);
    }
    return value;
}

function finiteFeatures(value: unknown, width: number, context: string): number[] {
    if (!Array.isArray(value) || value.length !== width) {
        throw new Error(`${context}: feature width ${Array.isArray(value) ? value.length : "non-array"} != ${width}`);
    }
    return value.map((feature, index) => finiteNumber(feature, `${context}[${index}]`));
}

export function requirePhaseBRunFingerprint(value: unknown, context = "PHASE_B_RUN_FINGERPRINT"): string {
    if (typeof value !== "string" || !RUN_FINGERPRINT.test(value)) {
        throw new Error(`${context} must be exactly 64 hexadecimal characters`);
    }
    return value.toLowerCase();
}

/** Accept signed-int32 or uint32 serialization and return one canonical uint32 game id. */
export function canonicalPhaseBSeed(value: unknown, context = "seed"): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < INT32_MIN || value > UINT32_MAX) {
        throw new Error(`${context} must be a signed int32 or uint32 integer`);
    }
    return value >>> 0;
}

export interface IPhaseBValueRow {
    t: typeof PHASE_B_VALUE_ROW_TYPE;
    v: typeof PHASE_B_DATASET_VERSION;
    runFingerprint: string;
    seed: number;
    greenVersion: string;
    redVersion: string;
    actingSide: "green" | "red";
    label: 0 | 1;
    features: number[];
}

export function parsePhaseBValueRow(
    value: unknown,
    featureWidth: number,
    expectedFingerprint: string,
    context = "Phase-B value row",
): IPhaseBValueRow {
    const row = recordOf(value, context);
    if (row.t !== PHASE_B_VALUE_ROW_TYPE || row.v !== PHASE_B_DATASET_VERSION) {
        throw new Error(`${context}: expected ${PHASE_B_VALUE_ROW_TYPE} v${PHASE_B_DATASET_VERSION}`);
    }
    const runFingerprint = requirePhaseBRunFingerprint(row.runFingerprint, `${context}.runFingerprint`);
    const expected = requirePhaseBRunFingerprint(expectedFingerprint, `${context}.expectedFingerprint`);
    if (runFingerprint !== expected) {
        throw new Error(`${context}: run fingerprint ${runFingerprint} does not match ${expected}`);
    }
    if (row.actingSide !== "green" && row.actingSide !== "red") {
        throw new Error(`${context}.actingSide: expected green or red`);
    }
    return {
        t: PHASE_B_VALUE_ROW_TYPE,
        v: PHASE_B_DATASET_VERSION,
        runFingerprint,
        seed: canonicalPhaseBSeed(row.seed, `${context}.seed`),
        greenVersion: nonEmptyString(row.greenVersion, `${context}.greenVersion`),
        redVersion: nonEmptyString(row.redVersion, `${context}.redVersion`),
        actingSide: row.actingSide,
        label: binary(row.label, `${context}.label`),
        features: finiteFeatures(row.features, featureWidth, `${context}.features`),
    };
}

export type PhaseBLeafKind = "learned_v2" | "learned" | "material";

export interface IPhaseBQ2Row {
    t: typeof PHASE_B_Q2_ROW_TYPE;
    v: typeof PHASE_B_DATASET_VERSION;
    runFingerprint: string;
    seed: number;
    greenVersion: string;
    redVersion: string;
    lap: number;
    unit: string;
    incumbentKind: string;
    incumbentWait: 0 | 1;
    incumbentIllegal: 0 | 1;
    waitRejected: 0 | 1;
    label: 0 | 1;
    delta: number | null;
    features: number[];
    oracle: {
        gate: number;
        rollouts: number;
        horizon: "lap";
        leaf: PhaseBLeafKind;
        opponentModel: string | null;
    };
}

export function parsePhaseBQ2Row(
    value: unknown,
    featureWidth: number,
    expectedFingerprint: string,
    context = "Phase-B Q2 row",
): IPhaseBQ2Row {
    const row = recordOf(value, context);
    if (row.t !== PHASE_B_Q2_ROW_TYPE || row.v !== PHASE_B_DATASET_VERSION) {
        throw new Error(`${context}: expected ${PHASE_B_Q2_ROW_TYPE} v${PHASE_B_DATASET_VERSION}`);
    }
    const runFingerprint = requirePhaseBRunFingerprint(row.runFingerprint, `${context}.runFingerprint`);
    const expected = requirePhaseBRunFingerprint(expectedFingerprint, `${context}.expectedFingerprint`);
    if (runFingerprint !== expected) {
        throw new Error(`${context}: run fingerprint ${runFingerprint} does not match ${expected}`);
    }
    const lap = finiteNumber(row.lap, `${context}.lap`);
    if (!Number.isInteger(lap) || lap < 0) {
        throw new Error(`${context}.lap: expected a non-negative integer`);
    }
    const incumbentWait = binary(row.incumbentWait, `${context}.incumbentWait`);
    const incumbentIllegal = binary(row.incumbentIllegal, `${context}.incumbentIllegal`);
    const waitRejected = binary(row.waitRejected, `${context}.waitRejected`);
    if (incumbentWait && (incumbentIllegal || waitRejected)) {
        throw new Error(`${context}: an incumbent-wait row cannot be illegal or wait-rejected`);
    }
    const label = binary(row.label, `${context}.label`);
    const delta = row.delta === null ? null : finiteNumber(row.delta, `${context}.delta`);
    if ((incumbentWait || incumbentIllegal || waitRejected) !== (delta === null ? 1 : 0)) {
        throw new Error(`${context}: delta must be null exactly for degenerate or rejected candidates`);
    }
    if (incumbentWait && label !== 1) {
        throw new Error(`${context}: an incumbent-wait row must have label 1`);
    }
    if (incumbentIllegal && !waitRejected && label !== 1) {
        throw new Error(`${context}: a legal wait against an illegal incumbent must have label 1`);
    }
    const oracle = recordOf(row.oracle, `${context}.oracle`);
    const gate = finiteNumber(oracle.gate, `${context}.oracle.gate`);
    if (gate < 0) {
        throw new Error(`${context}.oracle.gate: expected a non-negative number`);
    }
    const rollouts = finiteNumber(oracle.rollouts, `${context}.oracle.rollouts`);
    if (!Number.isInteger(rollouts) || rollouts < 1) {
        throw new Error(`${context}.oracle.rollouts: expected a positive integer`);
    }
    if (oracle.horizon !== "lap") {
        throw new Error(`${context}.oracle.horizon: expected lap`);
    }
    if (oracle.leaf !== "learned_v2" && oracle.leaf !== "learned" && oracle.leaf !== "material") {
        throw new Error(`${context}.oracle.leaf: unsupported leaf`);
    }
    const opponentModel =
        oracle.opponentModel === null ? null : nonEmptyString(oracle.opponentModel, `${context}.oracle.opponentModel`);
    return {
        t: PHASE_B_Q2_ROW_TYPE,
        v: PHASE_B_DATASET_VERSION,
        runFingerprint,
        seed: canonicalPhaseBSeed(row.seed, `${context}.seed`),
        greenVersion: nonEmptyString(row.greenVersion, `${context}.greenVersion`),
        redVersion: nonEmptyString(row.redVersion, `${context}.redVersion`),
        lap,
        unit: nonEmptyString(row.unit, `${context}.unit`),
        incumbentKind: nonEmptyString(row.incumbentKind, `${context}.incumbentKind`),
        incumbentWait,
        incumbentIllegal,
        waitRejected,
        label,
        delta,
        features: finiteFeatures(row.features, featureWidth, `${context}.features`),
        oracle: {
            gate,
            rollouts,
            horizon: "lap",
            leaf: oracle.leaf,
            opponentModel,
        },
    };
}

export interface IPhaseBFitterArgs {
    runFingerprint: string;
    files: Array<{ cohort: string; path: string }>;
    epochs: number;
    learningRate: number;
    l2: number;
}

/** Named hyperparameters are preferred; positional epochs/lr/l2 remain accepted for old invocations. */
export function parsePhaseBFitterArgs(
    args: readonly string[],
    defaults: { epochs: number; learningRate: number; l2: number },
): IPhaseBFitterArgs {
    const config = new Map<string, string>();
    const files: Array<{ cohort: string; path: string }> = [];
    const positional: number[] = [];
    for (const arg of args) {
        const eq = arg.indexOf("=");
        if (eq < 0) {
            const numeric = Number(arg);
            if (!Number.isFinite(numeric)) {
                throw new Error(`Unexpected fitter argument: ${arg}`);
            }
            positional.push(numeric);
            continue;
        }
        const key = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        if (["fingerprint", "epochs", "lr", "l2"].includes(key)) {
            if (config.has(key)) {
                throw new Error(`Duplicate fitter argument: ${key}`);
            }
            config.set(key, value);
            continue;
        }
        if (!key || !value) {
            throw new Error(`Dataset arguments must be <cohort>=<path>; got ${arg}`);
        }
        if (files.some((file) => file.cohort === key)) {
            throw new Error(`Duplicate cohort: ${key}`);
        }
        files.push({ cohort: key, path: value });
    }
    if (!files.length) {
        throw new Error("At least one <cohort>=<path> dataset is required");
    }
    if (positional.length > 3) {
        throw new Error("At most three positional hyperparameters are allowed: epochs, lr, l2");
    }
    const numberArg = (name: "epochs" | "lr" | "l2", index: number, fallback: number): number => {
        const raw = config.get(name);
        const value = raw === undefined ? (positional[index] ?? fallback) : Number(raw);
        if (!Number.isFinite(value)) {
            throw new Error(`${name} must be finite`);
        }
        return value;
    };
    const epochs = numberArg("epochs", 0, defaults.epochs);
    const learningRate = numberArg("lr", 1, defaults.learningRate);
    const l2 = numberArg("l2", 2, defaults.l2);
    if (!Number.isInteger(epochs) || epochs < 1) {
        throw new Error("epochs must be a positive integer");
    }
    if (learningRate <= 0) {
        throw new Error("lr must be positive");
    }
    if (l2 < 0) {
        throw new Error("l2 must be non-negative");
    }
    return {
        runFingerprint: requirePhaseBRunFingerprint(config.get("fingerprint"), "fingerprint"),
        files,
        epochs,
        learningRate,
        l2,
    };
}
