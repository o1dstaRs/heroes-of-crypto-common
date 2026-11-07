import batch256 from "../ai/models/a19/batch256.json";
import lr0003 from "../ai/models/a19/lr0003.json";
import { A19_NEURAL_POLICY } from "../ai/versions/v0_8_a19_neural_policy";
import { V09A19CpuModel, type IV09A19Prediction, type IV09A19InferenceOptions } from "./v0_9/a19_inference";
import type { IV09A19Observation } from "./v0_9/a19_observation";

interface IPackedModel {
    schema: string;
    exportSha256: string;
    metadata: Record<string, unknown>;
    weights: Record<string, { shape: number[]; data: string }>;
}

export function unpackA19Model(
    packed: IPackedModel,
    expectedExport: string,
    options?: Readonly<IV09A19InferenceOptions>,
): V09A19CpuModel {
    if (packed.schema !== "hoc.ai.a19.packed-float32.v1" || packed.exportSha256 !== expectedExport)
        throw new Error("Wrong promoted A19 model package");
    const weights: Record<string, number[] | number[][]> = {};
    for (const [name, tensor] of Object.entries(packed.weights)) {
        if (
            tensor.shape.length < 1 ||
            tensor.shape.length > 2 ||
            tensor.shape.some((x) => !Number.isInteger(x) || x < 1 || x > 4096)
        )
            throw new Error("Invalid promoted A19 tensor shape");
        const size = tensor.shape.reduce((a, b) => a * b, 1);
        const raw = atob(tensor.data);
        if (raw.length !== size * 4 || size > 1_000_000) throw new Error("Invalid promoted A19 tensor length");
        const bytes = Uint8Array.from(raw, (x) => x.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const flat = Array.from({ length: size }, (_, i) => view.getFloat32(i * 4, true));
        weights[name] =
            tensor.shape.length === 1
                ? flat
                : Array.from({ length: tensor.shape[0] }, (_, row) =>
                      flat.slice(row * tensor.shape[1], (row + 1) * tensor.shape[1]),
                  );
    }
    return new V09A19CpuModel(
        { ...packed.metadata, weights },
        {
            manifestSha256: A19_NEURAL_POLICY.manifestSha256,
            sourceSha256: A19_NEURAL_POLICY.trainingSourceSha256,
        },
        options,
    );
}

export function meanA19Policy(predictions: readonly IV09A19Prediction[]): IV09A19Prediction {
    if (
        predictions.length !== 2 ||
        !predictions[0].policy.length ||
        predictions.some(
            (p) => p.policy.length !== predictions[0].policy.length || p.policy.some((x) => !Number.isFinite(x)),
        )
    )
        throw new Error("Invalid A19 ensemble predictions");
    const probabilities = predictions.map((p) => {
        const maximum = Math.max(...p.policy);
        const exp = p.policy.map((x) => Math.exp(x - maximum));
        const sum = exp.reduce((a, b) => a + b, 0);
        return exp.map((x) => x / sum);
    });
    return {
        policy: probabilities[0].map((x, i) => Math.log(Math.max(1e-30, (x + probabilities[1][i]) / 2))),
        primary: predictions[0].primary.map((x, i) => (x + predictions[1].primary[i]) / 2),
        valueLogit: (predictions[0].valueLogit + predictions[1].valueLogit) / 2,
    };
}

let cached: Pick<V09A19CpuModel, "predict"> | undefined;
export function getA19NeuralModel(): Pick<V09A19CpuModel, "predict"> {
    if (!cached) {
        const left = unpackA19Model(batch256, A19_NEURAL_POLICY.exports[0]);
        const right = unpackA19Model(lr0003, A19_NEURAL_POLICY.exports[1]);
        cached = {
            predict: (observation: IV09A19Observation) =>
                meanA19Policy([left.predict(observation), right.predict(observation)]),
        };
    }
    return cached;
}
