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

import { V09_FEATURE_SCHEMA, V09_FEATURE_SCHEMA_SHA256, V09_INPUT_FEATURE_NAMES } from "./v0_9_features";
import { V09_FEATURE_BLOCKS, V09_MODEL_HASH_ALGORITHM, V09_MODEL_SCHEMA, type IV09ModelArtifact } from "./v0_9_model";

export const V09_MODEL_ID = "v0.9-anchor-only-untrained" as const;
export const V09_MODEL_STATUS = "anchor_only" as const;
export const V09_MODEL_PROMOTED: boolean = false;
export const V09_MODEL_SHA256: string | null = null;

const INPUT_SIZE = V09_INPUT_FEATURE_NAMES.length;
const ZEROES = Object.freeze(Array<number>(INPUT_SIZE).fill(0));
const ONES = Object.freeze(Array<number>(INPUT_SIZE).fill(1));

/**
 * Safe bootstrap only. It contains no learned weights, no training provenance and no strength claim. Even if a
 * caller requests v0.9, StrategyV0_9 sees promoted=false and returns its private exact v0.8 decision unchanged.
 * A qualification workflow must replace this entire artifact in a reviewed commit; training tools never mutate it.
 */
export const V09_MODEL_ARTIFACT: IV09ModelArtifact = Object.freeze({
    schema: V09_MODEL_SCHEMA,
    status: V09_MODEL_STATUS,
    promoted: V09_MODEL_PROMOTED,
    modelId: V09_MODEL_ID,
    modelSha256: V09_MODEL_SHA256,
    qualification: null,
    hashAlgorithm: V09_MODEL_HASH_ALGORITHM,
    source: Object.freeze({
        commonCommit: null,
        rulesSha256: null,
        rosterSha256: null,
        trainingRunId: null,
    }),
    features: Object.freeze({
        schema: V09_FEATURE_SCHEMA,
        schemaSha256: V09_FEATURE_SCHEMA_SHA256,
        inputFeatureNames: V09_INPUT_FEATURE_NAMES,
        blocks: V09_FEATURE_BLOCKS,
    }),
    normalization: Object.freeze({
        offsets: ZEROES,
        scales: ONES,
    }),
    fixedPoint: Object.freeze({
        inputScale: 256,
        inputClip: 8,
        weightDtype: "int8",
        biasDtype: "int32",
        activationDtype: "int16",
        accumulatorDtype: "int32",
        rounding: "half_away_from_zero",
        saturation: "symmetric_int16",
    }),
    minOverrideMargin: 1,
    architecture: Object.freeze({
        kind: "dense_candidate_ranker",
        inputSize: INPUT_SIZE,
        hiddenSizes: Object.freeze([]),
        outputSize: 1,
    }),
    layers: Object.freeze([
        Object.freeze({
            inputSize: INPUT_SIZE,
            outputSize: 1,
            activation: "linear",
            scaleShift: 0,
            weights: ZEROES,
            biases: Object.freeze([0]),
        }),
    ]),
    notes:
        "UNTRAINED ANCHOR ONLY. No RTX 5090 training result is embedded and no performance claim is made. " +
        "Candidate zero reproduces the private v0.8 strategy.",
});
