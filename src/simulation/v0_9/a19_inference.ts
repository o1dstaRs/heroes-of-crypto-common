/** Research-only CPU counterpart of a19_model.py. No policy or runtime hook is installed by importing it. */
import {
    V09_A19_OBSERVATION_CONTRACT as contract,
    V09_A19_OBSERVATION_SHA256,
    type IV09A19Observation,
} from "./a19_observation";

interface IDense {
    input: number;
    output: number;
    weights: Float32Array;
    bias: Float32Array;
}
export interface IV09A19Prediction {
    policy: number[];
    primary: number[];
    valueLogit: number;
}

function dense(weights: Record<string, unknown>, name: string, input: number, output: number): IDense {
    const matrix = weights[`${name}.weight`];
    const bias = weights[`${name}.bias`];
    if (
        !Array.isArray(matrix) ||
        matrix.length !== output ||
        !matrix.every((row) => Array.isArray(row) && row.length === input && row.every(Number.isFinite)) ||
        !Array.isArray(bias) ||
        bias.length !== output ||
        !bias.every(Number.isFinite)
    )
        throw new Error(`Invalid research model layer: ${name}`);
    const packed = new Float32Array(matrix.flat());
    const packedBias = new Float32Array(bias);
    if (!packed.every(Number.isFinite) || !packedBias.every(Number.isFinite))
        throw new Error(`Research model layer exceeds float32: ${name}`);
    return { input, output, weights: packed, bias: packedBias };
}

function apply(layer: IDense, input: ArrayLike<number>, relu = false): Float64Array {
    const result = new Float64Array(layer.output);
    for (let row = 0; row < layer.output; row++) {
        let value = layer.bias[row];
        const offset = row * layer.input;
        for (let column = 0; column < layer.input; column++) value += layer.weights[offset + column] * input[column];
        result[row] = relu ? Math.max(0, value) : value;
    }
    return result;
}

function validateObservation(observation: IV09A19Observation): void {
    const n = observation.entities.length;
    if (
        observation.schema !== contract.schema ||
        observation.contractSha256 !== V09_A19_OBSERVATION_SHA256 ||
        n < 1 ||
        n > contract.maximumEntities ||
        !Number.isInteger(observation.actorIndex) ||
        observation.actorIndex < 0 ||
        observation.actorIndex >= n ||
        observation.globals.length !== contract.globals.length ||
        !observation.globals.every(Number.isFinite) ||
        observation.terrain.length !== 256 ||
        !observation.terrain.every((x) => Number.isInteger(x) && x >= 0 && x < 5) ||
        !observation.entities.every((row) => row.length === contract.entities.length && row.every(Number.isFinite)) ||
        observation.candidates.length < 1 ||
        observation.candidates.length > contract.maximumCandidates ||
        !observation.candidates.every(
            (candidate) =>
                candidate.features.length === contract.candidates.length &&
                candidate.features.every(Number.isFinite) &&
                Number.isInteger(candidate.targetIndex) &&
                candidate.targetIndex >= -1 &&
                candidate.targetIndex < n,
        )
    )
        throw new Error("Invalid or incompatible research observation");
}

export class V09A19CpuModel {
    private readonly entity0: IDense;
    private readonly entity2: IDense;
    private readonly terrain: IDense;
    private readonly context: IDense;
    private readonly candidate0: IDense;
    private readonly candidate2: IDense;
    private readonly policy: IDense;
    private readonly primary: IDense;
    private readonly value0: IDense;
    private readonly value2: IDense;
    public constructor(raw: unknown, expected: { manifestSha256: string; sourceSha256: string }) {
        const model = raw as {
            schema?: string;
            promoted?: boolean;
            manifestSha256?: string;
            sourceSha256?: string;
            observationSha256?: string;
            weights?: Record<string, unknown>;
        } | null;
        if (
            !model ||
            model.schema !== "hoc.ai.v0_9_a19_proposal_float.v2" ||
            model.promoted !== false ||
            !/^[0-9a-f]{64}$/.test(expected.manifestSha256) ||
            !/^[0-9a-f]{64}$/.test(expected.sourceSha256) ||
            model.manifestSha256 !== expected.manifestSha256 ||
            model.sourceSha256 !== expected.sourceSha256 ||
            model.observationSha256 !== V09_A19_OBSERVATION_SHA256 ||
            !model.weights ||
            typeof model.weights !== "object"
        )
            throw new Error("Research model identity or schema mismatch");
        const weights = model.weights;
        const names = [
            "entity.0",
            "entity.2",
            "terrain.0",
            "context.0",
            "candidate.0",
            "candidate.2",
            "policy",
            "primary",
            "value.0",
            "value.2",
        ];
        const expectedKeys = names.flatMap((name) => [`${name}.weight`, `${name}.bias`]).sort();
        if (JSON.stringify(Object.keys(weights).sort()) !== JSON.stringify(expectedKeys))
            throw new Error("Unexpected research model parameters");
        this.entity0 = dense(weights, "entity.0", contract.entities.length, 96);
        this.entity2 = dense(weights, "entity.2", 96, 96);
        this.terrain = dense(weights, "terrain.0", 256 * 5, 64);
        this.context = dense(weights, "context.0", 96 * 5 + contract.globals.length + 64, 128);
        this.candidate0 = dense(weights, "candidate.0", 128 + 96 + contract.candidates.length, 128);
        this.candidate2 = dense(weights, "candidate.2", 128, 64);
        this.policy = dense(weights, "policy", 64, 1);
        this.primary = dense(weights, "primary", 64, 1);
        this.value0 = dense(weights, "value.0", 128, 64);
        this.value2 = dense(weights, "value.2", 64, 1);
    }
    public predict(observation: IV09A19Observation): IV09A19Prediction {
        validateObservation(observation);
        // Torch collate materializes float32 inputs before its forward pass.
        const encoded = observation.entities.map((row) =>
            apply(this.entity2, apply(this.entity0, new Float32Array(row), true), true),
        );
        const pool = (own: boolean): number[] => {
            const selected = encoded.filter((_, index) => observation.entities[index][0] > 0.5 === own);
            if (!selected.length) return Array<number>(96 * 2).fill(0);
            const mean = Array<number>(96).fill(0),
                maximum = Array<number>(96).fill(-Infinity);
            for (const row of selected)
                for (let column = 0; column < 96; column++) {
                    mean[column] += row[column] / selected.length;
                    maximum[column] = Math.max(maximum[column], row[column]);
                }
            return [...mean, ...maximum];
        };
        // Exact sparse counterpart of the flattened 256 x 5 one-hot terrain input.
        const terrain = new Float64Array(64);
        for (let row = 0; row < 64; row++) {
            let value = this.terrain.bias[row];
            for (let cell = 0; cell < 256; cell++)
                value += this.terrain.weights[row * 1280 + cell * 5 + observation.terrain[cell]];
            terrain[row] = Math.max(0, value);
        }
        const context = apply(
            this.context,
            [
                ...pool(true),
                ...pool(false),
                ...encoded[observation.actorIndex],
                ...new Float32Array(observation.globals),
                ...terrain,
            ],
            true,
        );
        const valueLogit = apply(this.value2, apply(this.value0, context, true))[0];
        const policy: number[] = [],
            primary: number[] = [];
        for (const candidate of observation.candidates) {
            const target = candidate.targetIndex < 0 ? new Float64Array(96) : encoded[candidate.targetIndex];
            const features = apply(
                this.candidate2,
                apply(this.candidate0, [...context, ...target, ...new Float32Array(candidate.features)], true),
                true,
            );
            policy.push(apply(this.policy, features)[0]);
            primary.push(apply(this.primary, features)[0]);
        }
        if (![valueLogit, ...policy, ...primary].every(Number.isFinite))
            throw new Error("Non-finite research CPU prediction");
        return { policy, primary, valueLogit };
    }
}
