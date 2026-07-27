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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
    scoreV09FixedPoint,
    serializeV09ModelHashPayload,
    validateV09ModelArtifact,
    type IV09ModelArtifact,
} from "../../ai/versions/v0_9_model";

export interface IV09ParityVector {
    id: string;
    features: number[];
    expectedScore?: number;
}

export interface IV09ParityResult {
    id: string;
    score: number;
}

const BASELINE_PARITY_VECTORS = 64;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function verifyV09ResearchArtifact(artifact: IV09ModelArtifact): void {
    const errors = validateV09ModelArtifact(artifact);
    if (errors.length) throw new Error(`invalid v0.9 artifact: ${errors.join("; ")}`);
    if (artifact.status !== "trained" || artifact.promoted) {
        throw new Error("parity accepts an unpromoted trained research artifact");
    }
    if (!artifact.modelSha256 || sha256(serializeV09ModelHashPayload(artifact)) !== artifact.modelSha256) {
        throw new Error("v0.9 model hash mismatch");
    }
}

export function scoreV09ParityVectors(
    artifact: IV09ModelArtifact,
    vectors: readonly IV09ParityVector[],
): IV09ParityResult[] {
    verifyV09ResearchArtifact(artifact);
    return vectors.map((vector) => {
        if (!vector.id.trim()) throw new Error("parity vector id must be non-empty");
        const score = scoreV09FixedPoint(artifact, vector.features);
        if (vector.expectedScore !== undefined && vector.expectedScore !== score) {
            throw new Error(`parity vector ${vector.id} expected ${vector.expectedScore}, received ${score}`);
        }
        return { id: vector.id, score };
    });
}

/**
 * Corpus shared by the campaign parity gate. Besides broad deterministic values, it deliberately crosses input
 * half-rounding and clipping boundaries and drives every first-layer row toward its positive accumulator
 * envelope. Exact signed-int32 and post-accumulator half-rounding boundaries use sealed synthetic artifacts in
 * the focused test because an arbitrary learned model cannot be forced to land on those exact integers.
 */
export function buildV09ParityCorpus(artifact: IV09ModelArtifact): IV09ParityVector[] {
    verifyV09ResearchArtifact(artifact);
    const width = artifact.architecture.inputSize;
    const rawAtNormalized = (featureIndex: number, normalized: number): number => {
        const offset = artifact.normalization.offsets[featureIndex]!;
        const scale = artifact.normalization.scales[featureIndex]!;
        const raw = offset + normalized / scale;
        if (!Number.isFinite(raw)) {
            throw new Error(`v0.9 parity cannot represent boundary input for feature ${featureIndex}`);
        }
        return raw;
    };
    const atNormalized = (normalized: (featureIndex: number) => number): number[] =>
        Array.from({ length: width }, (_, featureIndex) => rawAtNormalized(featureIndex, normalized(featureIndex)));
    const vectors: IV09ParityVector[] = Array.from({ length: BASELINE_PARITY_VECTORS }, (_, vectorIndex) => ({
        id: `baseline-${vectorIndex}`,
        features: Array.from(
            { length: width },
            (_, featureIndex) => ((((vectorIndex + 1) * (featureIndex + 3)) % 37) - 18) / 7,
        ),
    }));
    const inputHalf = 0.5 / artifact.fixedPoint.inputScale;
    const beyondClip = artifact.fixedPoint.inputClip * 4;
    vectors.push(
        { id: "boundary-input-round-half-positive", features: atNormalized(() => inputHalf) },
        { id: "boundary-input-round-half-negative", features: atNormalized(() => -inputHalf) },
        { id: "boundary-input-clip-positive", features: atNormalized(() => beyondClip) },
        { id: "boundary-input-clip-negative", features: atNormalized(() => -beyondClip) },
        {
            id: "boundary-input-clip-alternating",
            features: atNormalized((featureIndex) => (featureIndex % 2 === 0 ? beyondClip : -beyondClip)),
        },
    );
    const firstLayer = artifact.layers[0]!;
    const rowCount = Math.min(firstLayer.outputSize, 8);
    for (let row = 0; row < rowCount; row += 1) {
        const rowOffset = row * firstLayer.inputSize;
        const biasSign = Math.sign(firstLayer.biases[row] ?? 0) || 1;
        vectors.push({
            id: `boundary-int32-accumulator-pressure-row-${row}`,
            features: atNormalized((featureIndex) => {
                const weightSign = Math.sign(firstLayer.weights[rowOffset + featureIndex] ?? 0);
                return beyondClip * (weightSign || biasSign);
            }),
        });
    }
    return vectors;
}

function parseVectors(contents: string): IV09ParityVector[] {
    return contents
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) => {
            const value = JSON.parse(line) as Partial<IV09ParityVector>;
            if (!value || typeof value !== "object" || !Array.isArray(value.features)) {
                throw new Error(`invalid parity vector on line ${index + 1}`);
            }
            return {
                id: typeof value.id === "string" ? value.id : `line-${index + 1}`,
                features: value.features,
                ...(value.expectedScore === undefined ? {} : { expectedScore: value.expectedScore }),
            };
        });
}

function main(): void {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            artifact: { type: "string" },
            vectors: { type: "string" },
        },
        strict: true,
    });
    if (!values.artifact || !values.vectors) {
        throw new Error("usage: bun parity.ts --artifact <research.json> --vectors <vectors.jsonl>");
    }
    const artifact = JSON.parse(readFileSync(values.artifact, "utf8")) as IV09ModelArtifact;
    const results = scoreV09ParityVectors(artifact, parseVectors(readFileSync(values.vectors, "utf8")));
    for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) main();
