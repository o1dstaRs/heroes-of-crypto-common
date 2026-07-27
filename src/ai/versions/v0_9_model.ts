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

import {
    V09_CANDIDATE_FEATURE_NAMES,
    V09_FEATURE_SCHEMA,
    V09_FEATURE_SCHEMA_SHA256,
    V09_INPUT_FEATURE_NAMES,
    V09_RICH_FEATURE_NAMES,
} from "./v0_9_features";
import { IL_ACTION_FEATURE_NAMES } from "../../simulation/il_action_features";
import { VALUE_FEATURE_NAMES_V2 } from "../../simulation/value_features";
import type { V09ArtifactStatus } from "../ai_strategy";

export const V09_MODEL_SCHEMA = "hoc.ai.v0_9_model.v1" as const;
export const V09_MODEL_HASH_ALGORITHM = "sha256-canonical-inference-json-v1" as const;
export const V09_QUALIFICATION_RECEIPT_SCHEMA = "hoc.ai.v0_9_qualification_receipt.v2" as const;
export const V09_EMPTY_FAILURES_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" as const;

export interface IV09FeatureBlock {
    readonly name: "state" | "candidate" | "action" | "rich";
    readonly offset: number;
    readonly length: number;
}

export interface IV09FeatureContract {
    readonly schema: typeof V09_FEATURE_SCHEMA;
    /** SHA-256 of UTF-8 JSON.stringify({ schema, inputFeatureNames }). */
    readonly schemaSha256: string;
    readonly inputFeatureNames: readonly string[];
    readonly blocks: readonly IV09FeatureBlock[];
}

export interface IV09Normalization {
    /** Training-set center subtracted from each raw feature before quantization. */
    readonly offsets: readonly number[];
    /** Training-set multiplier applied after centering. Values must be finite and strictly positive. */
    readonly scales: readonly number[];
}

export interface IV09FixedPointContract {
    readonly inputScale: number;
    readonly inputClip: number;
    readonly weightDtype: "int8";
    readonly biasDtype: "int32";
    readonly activationDtype: "int16";
    readonly accumulatorDtype: "int32";
    readonly rounding: "half_away_from_zero";
    readonly saturation: "symmetric_int16";
}

export interface IV09DenseLayer {
    readonly inputSize: number;
    readonly outputSize: number;
    /** Hidden layers use relu; the scalar output layer is linear. */
    readonly activation: "relu" | "linear";
    /**
     * Accumulator rescale: output = roundHalfAwayFromZero(accumulator / 2**scaleShift).
     * Biases are expressed in pre-shift accumulator units.
     */
    readonly scaleShift: number;
    /** Row-major [output][input], signed int8 restricted to [-127, 127]. */
    readonly weights: readonly number[];
    /** One signed int32 pre-shift accumulator bias per output. */
    readonly biases: readonly number[];
}

export interface IV09Architecture {
    readonly kind: "dense_candidate_ranker";
    readonly inputSize: number;
    readonly hiddenSizes: readonly number[];
    readonly outputSize: 1;
}

export interface IV09ModelSource {
    readonly commonCommit: string | null;
    readonly rulesSha256: string | null;
    readonly rosterSha256: string | null;
    readonly trainingRunId: string | null;
}

/**
 * Immutable evidence binding a promoted inference function to its exact offline qualification run.
 * `researchArtifactSha256` hashes the unpromoted input artifact consumed by qualification; the promoted
 * TypeScript artifact cannot self-hash. `receiptSha256` hashes serializeV09QualificationReceiptPayload.
 */
export interface IV09QualificationReceipt {
    readonly schema: typeof V09_QUALIFICATION_RECEIPT_SCHEMA;
    /** Prevents a pre-v2 summary from being replayed after the reached-Armageddon qualification fix. */
    readonly qualificationSummarySchema: "hoc.ai.v0_9_qualification.v2";
    /** v2 gates entering an Armageddon lap, not only battles in which Armageddon damage killed a unit. */
    readonly armageddonMetric: "reached_armageddon_lap";
    readonly summarySha256: string;
    readonly journalSha256: string;
    readonly manifestSha256: string;
    readonly seedLedgerSha256: string;
    readonly researchArtifactSha256: string;
    readonly modelSha256: string;
    readonly modelId: string;
    readonly trainingRunId: string;
    readonly commonCommit: string;
    readonly rulesSha256: string;
    readonly rosterSha256: string;
    readonly runFingerprint: string;
    readonly combinedGames: 96_000;
    readonly confirmationGames: 48_000;
    readonly qualificationGames: 48_000;
    readonly failuresSha256: typeof V09_EMPTY_FAILURES_SHA256;
    readonly qualifiedAt: string;
    readonly receiptSha256: string;
}

export interface IV09ModelArtifact {
    readonly schema: typeof V09_MODEL_SCHEMA;
    readonly status: V09ArtifactStatus;
    /**
     * Qualification is an explicit, reviewed state transition. A trained research artifact remains inert until
     * this is true; the bootstrap anchor is permanently false.
     */
    readonly promoted: boolean;
    readonly modelId: string;
    /**
     * SHA-256 of serializeV09ModelHashPayload(artifact), or null for anchor-only artifacts. Promotion/provenance
     * are intentionally outside the payload so the same learned inference function retains one identity.
     */
    readonly modelSha256: string | null;
    /**
     * Null for anchor and research artifacts. A promoted artifact must carry a receipt whose exact
     * cryptographic identity is verified by the server before canary assignment.
     */
    readonly qualification: IV09QualificationReceipt | null;
    readonly hashAlgorithm: typeof V09_MODEL_HASH_ALGORITHM;
    readonly source: IV09ModelSource;
    readonly features: IV09FeatureContract;
    readonly normalization: IV09Normalization;
    readonly fixedPoint: IV09FixedPointContract;
    /** Minimum learned score improvement over candidate zero, in final integer output units. */
    readonly minOverrideMargin: number;
    readonly architecture: IV09Architecture;
    readonly layers: readonly IV09DenseLayer[];
    readonly notes: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/;
const INT8_ABS_MAX = 127;
const INT16_ABS_MAX = 32767;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

export const V09_FEATURE_BLOCKS: readonly IV09FeatureBlock[] = Object.freeze([
    Object.freeze({ name: "state", offset: 0, length: VALUE_FEATURE_NAMES_V2.length }),
    Object.freeze({
        name: "candidate",
        offset: VALUE_FEATURE_NAMES_V2.length,
        length: V09_CANDIDATE_FEATURE_NAMES.length,
    }),
    Object.freeze({
        name: "action",
        offset: VALUE_FEATURE_NAMES_V2.length + V09_CANDIDATE_FEATURE_NAMES.length,
        length: IL_ACTION_FEATURE_NAMES.length,
    }),
    Object.freeze({
        name: "rich",
        offset: VALUE_FEATURE_NAMES_V2.length + V09_CANDIDATE_FEATURE_NAMES.length + IL_ACTION_FEATURE_NAMES.length,
        length: V09_RICH_FEATURE_NAMES.length,
    }),
]);

const isIntegerIn = (value: number, minimum: number, maximum: number): boolean =>
    Number.isInteger(value) && value >= minimum && value <= maximum;

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Canonical inference-only payload. Hash exactly the UTF-8 bytes returned by this function with SHA-256.
 * Fixed key insertion order and array ordering are part of v1; callers must not pretty-print or re-sort it.
 */
export function serializeV09ModelHashPayload(artifact: IV09ModelArtifact): string {
    return JSON.stringify({
        schema: artifact.schema,
        hashAlgorithm: artifact.hashAlgorithm,
        features: {
            schema: artifact.features.schema,
            schemaSha256: artifact.features.schemaSha256,
            inputFeatureNames: [...artifact.features.inputFeatureNames],
            blocks: artifact.features.blocks.map(({ name, offset, length }) => ({ name, offset, length })),
        },
        normalization: {
            offsets: [...artifact.normalization.offsets],
            scales: [...artifact.normalization.scales],
        },
        fixedPoint: {
            inputScale: artifact.fixedPoint.inputScale,
            inputClip: artifact.fixedPoint.inputClip,
            weightDtype: artifact.fixedPoint.weightDtype,
            biasDtype: artifact.fixedPoint.biasDtype,
            activationDtype: artifact.fixedPoint.activationDtype,
            accumulatorDtype: artifact.fixedPoint.accumulatorDtype,
            rounding: artifact.fixedPoint.rounding,
            saturation: artifact.fixedPoint.saturation,
        },
        minOverrideMargin: artifact.minOverrideMargin,
        architecture: {
            kind: artifact.architecture.kind,
            inputSize: artifact.architecture.inputSize,
            hiddenSizes: [...artifact.architecture.hiddenSizes],
            outputSize: artifact.architecture.outputSize,
        },
        layers: artifact.layers.map(({ inputSize, outputSize, activation, scaleShift, weights, biases }) => ({
            inputSize,
            outputSize,
            activation,
            scaleShift,
            weights: [...weights],
            biases: [...biases],
        })),
    });
}

/** Canonical receipt payload; hash these exact UTF-8 bytes with SHA-256. */
export function serializeV09QualificationReceiptPayload(receipt: IV09QualificationReceipt): string {
    return JSON.stringify({
        schema: receipt.schema,
        qualificationSummarySchema: receipt.qualificationSummarySchema,
        armageddonMetric: receipt.armageddonMetric,
        summarySha256: receipt.summarySha256,
        journalSha256: receipt.journalSha256,
        manifestSha256: receipt.manifestSha256,
        seedLedgerSha256: receipt.seedLedgerSha256,
        researchArtifactSha256: receipt.researchArtifactSha256,
        modelSha256: receipt.modelSha256,
        modelId: receipt.modelId,
        trainingRunId: receipt.trainingRunId,
        commonCommit: receipt.commonCommit,
        rulesSha256: receipt.rulesSha256,
        rosterSha256: receipt.rosterSha256,
        runFingerprint: receipt.runFingerprint,
        combinedGames: receipt.combinedGames,
        confirmationGames: receipt.confirmationGames,
        qualificationGames: receipt.qualificationGames,
        failuresSha256: receipt.failuresSha256,
        qualifiedAt: receipt.qualifiedAt,
    });
}

/** Browser-safe structural verification; the server/exporter separately verifies modelSha256 cryptographically. */
export function validateV09ModelArtifact(artifact: IV09ModelArtifact): string[] {
    const errors: string[] = [];
    if (artifact.schema !== V09_MODEL_SCHEMA) errors.push(`schema must be ${V09_MODEL_SCHEMA}`);
    if (artifact.hashAlgorithm !== V09_MODEL_HASH_ALGORITHM) {
        errors.push(`hashAlgorithm must be ${V09_MODEL_HASH_ALGORITHM}`);
    }
    if (!artifact.modelId.trim()) errors.push("modelId must be non-empty");
    if (artifact.status !== "anchor_only" && artifact.status !== "trained") errors.push("status is invalid");
    if (artifact.promoted && artifact.status !== "trained") errors.push("only a trained artifact can be promoted");
    if (artifact.promoted !== (artifact.qualification !== null)) {
        errors.push("promotion and qualification receipt must transition together");
    }
    if (artifact.status === "anchor_only") {
        if (artifact.promoted) errors.push("anchor-only artifact cannot be promoted");
        if (artifact.modelSha256 !== null) errors.push("anchor-only artifact must not claim a model hash");
        if (
            artifact.source.commonCommit !== null ||
            artifact.source.rulesSha256 !== null ||
            artifact.source.rosterSha256 !== null ||
            artifact.source.trainingRunId !== null
        ) {
            errors.push("anchor-only artifact must not claim training provenance");
        }
    } else {
        if (!artifact.modelSha256 || !SHA256.test(artifact.modelSha256)) {
            errors.push("trained artifact requires a lowercase modelSha256");
        }
        if (!artifact.source.commonCommit || !GIT_COMMIT.test(artifact.source.commonCommit)) {
            errors.push("trained artifact requires a source commonCommit");
        }
        if (!artifact.source.rulesSha256 || !SHA256.test(artifact.source.rulesSha256)) {
            errors.push("trained artifact requires rulesSha256");
        }
        if (!artifact.source.rosterSha256 || !SHA256.test(artifact.source.rosterSha256)) {
            errors.push("trained artifact requires rosterSha256");
        }
        if (!artifact.source.trainingRunId?.trim()) errors.push("trained artifact requires trainingRunId");
    }
    const qualification = artifact.qualification;
    if (qualification) {
        if (qualification.schema !== V09_QUALIFICATION_RECEIPT_SCHEMA) {
            errors.push(`qualification.schema must be ${V09_QUALIFICATION_RECEIPT_SCHEMA}`);
        }
        if (qualification.qualificationSummarySchema !== "hoc.ai.v0_9_qualification.v2") {
            errors.push("qualification must bind the v2 qualification summary");
        }
        if (qualification.armageddonMetric !== "reached_armageddon_lap") {
            errors.push("qualification must bind reached-Armageddon-lap semantics");
        }
        for (const [name, value] of [
            ["summarySha256", qualification.summarySha256],
            ["journalSha256", qualification.journalSha256],
            ["manifestSha256", qualification.manifestSha256],
            ["seedLedgerSha256", qualification.seedLedgerSha256],
            ["researchArtifactSha256", qualification.researchArtifactSha256],
            ["modelSha256", qualification.modelSha256],
            ["rulesSha256", qualification.rulesSha256],
            ["rosterSha256", qualification.rosterSha256],
            ["runFingerprint", qualification.runFingerprint],
            ["receiptSha256", qualification.receiptSha256],
        ] as const) {
            if (!SHA256.test(value)) errors.push(`qualification.${name} must be a lowercase sha256`);
        }
        if (qualification.modelSha256 !== artifact.modelSha256) {
            errors.push("qualification.modelSha256 must match the inference model");
        }
        if (qualification.modelId !== artifact.modelId) {
            errors.push("qualification.modelId must match the artifact");
        }
        if (qualification.trainingRunId !== artifact.source.trainingRunId) {
            errors.push("qualification.trainingRunId must match source provenance");
        }
        if (qualification.commonCommit !== artifact.source.commonCommit) {
            errors.push("qualification.commonCommit must match source provenance");
        }
        if (!GIT_COMMIT.test(qualification.commonCommit)) {
            errors.push("qualification.commonCommit must be a git commit");
        }
        if (qualification.rulesSha256 !== artifact.source.rulesSha256) {
            errors.push("qualification.rulesSha256 must match source provenance");
        }
        if (qualification.rosterSha256 !== artifact.source.rosterSha256) {
            errors.push("qualification.rosterSha256 must match source provenance");
        }
        if (
            qualification.combinedGames !== 96_000 ||
            qualification.confirmationGames !== 48_000 ||
            qualification.qualificationGames !== 48_000
        ) {
            errors.push("qualification must bind the exact 48k+48k promotion sample");
        }
        if (qualification.failuresSha256 !== V09_EMPTY_FAILURES_SHA256) {
            errors.push("qualification must bind an empty failures array");
        }
        if (!qualification.qualifiedAt.trim() || !Number.isFinite(Date.parse(qualification.qualifiedAt))) {
            errors.push("qualification.qualifiedAt must be an ISO timestamp");
        }
    }

    if (artifact.features.schema !== V09_FEATURE_SCHEMA) {
        errors.push(`feature schema must be ${V09_FEATURE_SCHEMA}`);
    }
    if (artifact.features.schemaSha256 !== V09_FEATURE_SCHEMA_SHA256) {
        errors.push("feature schema hash does not match the embedded IL-v4 extractor");
    }
    if (!sameStrings(artifact.features.inputFeatureNames, V09_INPUT_FEATURE_NAMES)) {
        errors.push("inputFeatureNames do not match the embedded IL-v4 extractor");
    }
    if (new Set(artifact.features.inputFeatureNames).size !== artifact.features.inputFeatureNames.length) {
        errors.push("inputFeatureNames must be unique");
    }
    if (
        artifact.features.blocks.length !== V09_FEATURE_BLOCKS.length ||
        artifact.features.blocks.some((block, index) => {
            const expected = V09_FEATURE_BLOCKS[index];
            return (
                !expected ||
                block.name !== expected.name ||
                block.offset !== expected.offset ||
                block.length !== expected.length
            );
        })
    ) {
        errors.push("feature blocks do not match the IL-v4 state/candidate/action/rich layout");
    }

    const inputSize = V09_INPUT_FEATURE_NAMES.length;
    if (artifact.normalization.offsets.length !== inputSize || artifact.normalization.scales.length !== inputSize) {
        errors.push(`normalization must contain ${inputSize} offsets and scales`);
    }
    if (artifact.normalization.offsets.some((value) => !Number.isFinite(value))) {
        errors.push("normalization offsets must be finite");
    }
    if (artifact.normalization.scales.some((value) => !Number.isFinite(value) || value <= 0)) {
        errors.push("normalization scales must be finite and positive");
    }
    if (!isIntegerIn(artifact.fixedPoint.inputScale, 1, INT16_ABS_MAX)) {
        errors.push("fixedPoint.inputScale must be a positive int16");
    }
    if (!Number.isFinite(artifact.fixedPoint.inputClip) || artifact.fixedPoint.inputClip <= 0) {
        errors.push("fixedPoint.inputClip must be finite and positive");
    }
    if (
        artifact.fixedPoint.weightDtype !== "int8" ||
        artifact.fixedPoint.biasDtype !== "int32" ||
        artifact.fixedPoint.activationDtype !== "int16" ||
        artifact.fixedPoint.accumulatorDtype !== "int32" ||
        artifact.fixedPoint.rounding !== "half_away_from_zero" ||
        artifact.fixedPoint.saturation !== "symmetric_int16"
    ) {
        errors.push("fixedPoint metadata does not match the v1 runtime");
    }
    if (!isIntegerIn(artifact.minOverrideMargin, 0, INT32_MAX)) {
        errors.push("minOverrideMargin must be a non-negative int32");
    }

    if (
        artifact.architecture.kind !== "dense_candidate_ranker" ||
        artifact.architecture.inputSize !== inputSize ||
        artifact.architecture.outputSize !== 1
    ) {
        errors.push("architecture must be a scalar dense candidate ranker over the IL-v4 input");
    }
    if (!artifact.layers.length) errors.push("at least one dense layer is required");
    const expectedHidden = artifact.layers.slice(0, -1).map((layer) => layer.outputSize);
    if (!sameNumbers(artifact.architecture.hiddenSizes, expectedHidden)) {
        errors.push("architecture.hiddenSizes do not match dense layers");
    }

    let expectedLayerInput = inputSize;
    artifact.layers.forEach((layer, layerIndex) => {
        const final = layerIndex === artifact.layers.length - 1;
        if (!isIntegerIn(layer.inputSize, 1, 65_536) || layer.inputSize !== expectedLayerInput) {
            errors.push(`layers[${layerIndex}].inputSize is inconsistent`);
        }
        if (!isIntegerIn(layer.outputSize, 1, 65_536) || (final && layer.outputSize !== 1)) {
            errors.push(`layers[${layerIndex}].outputSize is invalid`);
        }
        if ((final && layer.activation !== "linear") || (!final && layer.activation !== "relu")) {
            errors.push(`layers[${layerIndex}].activation is invalid`);
        }
        if (!isIntegerIn(layer.scaleShift, 0, 30)) errors.push(`layers[${layerIndex}].scaleShift is invalid`);
        if (layer.weights.length !== layer.inputSize * layer.outputSize) {
            errors.push(`layers[${layerIndex}].weights has the wrong length`);
        }
        if (layer.biases.length !== layer.outputSize) {
            errors.push(`layers[${layerIndex}].biases has the wrong length`);
        }
        if (layer.weights.some((value) => !isIntegerIn(value, -INT8_ABS_MAX, INT8_ABS_MAX))) {
            errors.push(`layers[${layerIndex}].weights must be signed int8`);
        }
        if (layer.biases.some((value) => !isIntegerIn(value, INT32_MIN, INT32_MAX))) {
            errors.push(`layers[${layerIndex}].biases must be signed int32`);
        }
        for (let row = 0; row < layer.outputSize; row += 1) {
            let absoluteWeightSum = 0;
            const offset = row * layer.inputSize;
            for (let column = 0; column < layer.inputSize; column += 1) {
                absoluteWeightSum += Math.abs(layer.weights[offset + column] ?? 0);
            }
            const maximumAccumulator = INT16_ABS_MAX * absoluteWeightSum + Math.abs(layer.biases[row] ?? 0);
            if (!Number.isSafeInteger(maximumAccumulator) || maximumAccumulator > INT32_MAX) {
                errors.push(`layers[${layerIndex}].row[${row}] can exceed signed int32 accumulation`);
            }
        }
        expectedLayerInput = layer.outputSize;
    });
    return errors;
}

export const isV09ModelRunnable = (artifact: IV09ModelArtifact): boolean =>
    artifact.status === "trained" && artifact.promoted && validateV09ModelArtifact(artifact).length === 0;

const roundHalfAwayFromZero = (value: number): number =>
    value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);

const clampInt16 = (value: number): number => Math.max(-INT16_ABS_MAX, Math.min(INT16_ABS_MAX, value));
const clampInt32 = (value: number): number => Math.max(INT32_MIN, Math.min(INT32_MAX, value));

/**
 * Deterministic synchronous CPU inference. Inputs are normalized once, then every learned multiply/accumulate
 * and comparison uses exact integers; no softmax, native addon, GPU, network request, or random source exists.
 */
export function scoreV09FixedPoint(artifact: IV09ModelArtifact, rawFeatures: readonly number[]): number {
    if (rawFeatures.length !== artifact.architecture.inputSize) {
        throw new Error(`v0.9 expected ${artifact.architecture.inputSize} features, received ${rawFeatures.length}`);
    }
    let activations = rawFeatures.map((raw, index) => {
        if (!Number.isFinite(raw)) throw new Error(`v0.9 feature ${index} is not finite`);
        const normalized =
            (raw - (artifact.normalization.offsets[index] ?? 0)) * (artifact.normalization.scales[index] ?? 1);
        const clipped = Math.max(-artifact.fixedPoint.inputClip, Math.min(artifact.fixedPoint.inputClip, normalized));
        return clampInt16(roundHalfAwayFromZero(clipped * artifact.fixedPoint.inputScale));
    });

    for (let layerIndex = 0; layerIndex < artifact.layers.length; layerIndex += 1) {
        const layer = artifact.layers[layerIndex];
        if (!layer || activations.length !== layer.inputSize) throw new Error("v0.9 dense layer shape mismatch");
        const output: number[] = [];
        const divisor = 2 ** layer.scaleShift;
        for (let row = 0; row < layer.outputSize; row += 1) {
            let accumulator = layer.biases[row] ?? 0;
            const offset = row * layer.inputSize;
            for (let column = 0; column < layer.inputSize; column += 1) {
                accumulator += activations[column] * (layer.weights[offset + column] ?? 0);
            }
            let value = roundHalfAwayFromZero(accumulator / divisor);
            if (layer.activation === "relu") value = Math.max(0, value);
            output.push(layer.activation === "linear" ? clampInt32(value) : clampInt16(value));
        }
        activations = output;
    }
    const score = activations[0];
    if (!Number.isInteger(score)) throw new Error("v0.9 produced a non-integer score");
    return score;
}
