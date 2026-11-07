import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import batch256 from "../../src/ai/models/a19/batch256.json";
import lr0003 from "../../src/ai/models/a19/lr0003.json";
import { getA19NeuralModel } from "../../src/simulation/a19_neural_model";
import { loadA19PolicyHeadPair, A19_HEAD_PAIR_SCHEMA } from "../../src/simulation/v0_9/a19_policy_head_pair";
import {
    V09_A19_OBSERVATION_CONTRACT as contract,
    V09_A19_OBSERVATION_SHA256,
    type IV09A19Observation,
} from "../../src/simulation/v0_9/a19_observation";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Weights = Record<string, number[] | number[][]>;
function unpack(packed: {
    metadata: Record<string, unknown>;
    weights: Record<string, { data: string; shape: number[] }>;
}) {
    const weights: Weights = {};
    for (const [name, entry] of Object.entries(packed.weights)) {
        const raw = Buffer.from(entry.data, "base64");
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const flat = Array.from({ length: raw.length / 4 }, (_, index) => view.getFloat32(index * 4, true));
        weights[name] =
            entry.shape.length === 1
                ? flat
                : Array.from({ length: entry.shape[0] }, (_, row) =>
                      flat.slice(row * entry.shape[1], (row + 1) * entry.shape[1]),
                  );
    }
    return { ...packed.metadata, weights };
}
function head(weights: Weights) {
    const values = [...(weights["policy.weight"] as number[][])[0], ...(weights["policy.bias"] as number[])];
    const bytes = new DataView(new ArrayBuffer(values.length * 4));
    values.forEach((value, index) => bytes.setFloat32(index * 4, value, true));
    return sha(new Uint8Array(bytes.buffer));
}
const initial = { student: unpack(lr0003), partner: unpack(batch256) };
function bundle(options: { fixture?: boolean; changed?: boolean; mode?: "student" | "joint" } = {}) {
    const raw = structuredClone(initial);
    const members = {} as Record<
        "student" | "partner",
        { file: string; sha256: string; initialHeadSha256: string; headSha256: string }
    >;
    const files = {} as Record<"student" | "partner", string>;
    for (const role of ["student", "partner"] as const) {
        const initialHead = head(raw[role].weights);
        if (options.changed) (raw[role].weights["policy.weight"] as number[][])[0][0] += 0.01;
        files[role] = JSON.stringify({
            ...raw[role],
            manifestSha256: "a".repeat(64),
            sourceSha256: "b".repeat(64),
            pairRole: role,
            recipeOrdinal: 2,
            checkpointEpoch: 7,
            syntheticFunctionalFixture: options.fixture ?? false,
        });
        members[role] = {
            file: role === "student" ? "model.json" : "partner-model.json",
            sha256: sha(files[role]),
            initialHeadSha256: initialHead,
            headSha256: head(raw[role].weights),
        };
    }
    const manifest = {
        schema: A19_HEAD_PAIR_SCHEMA,
        promoted: false,
        trainingMembers: options.mode ?? "joint",
        registrationSha256: "a".repeat(64),
        trainerSha256: "b".repeat(64),
        observationSha256: V09_A19_OBSERVATION_SHA256,
        initialStudentSha256: "c".repeat(64),
        initialPartnerSha256: "d".repeat(64),
        recipeOrdinal: 2,
        checkpointEpoch: 7,
        syntheticFunctionalFixture: options.fixture ?? false,
        members,
    };
    return {
        manifest: JSON.stringify(manifest),
        student: files.student,
        partner: files.partner,
        expectedPairSha256: sha(JSON.stringify(manifest)),
        purpose: "functional" as const,
    };
}
function observation(): IV09A19Observation {
    return {
        schema: contract.schema,
        contractSha256: V09_A19_OBSERVATION_SHA256,
        entities: Array.from({ length: 2 }, (_, row) =>
            Array.from({ length: contract.entities.length }, (_, i) => (i === 0 ? 1 - row : ((i + row) % 7) / 7)),
        ),
        entityIds: ["own", "enemy"],
        actorIndex: 0,
        globals: Array.from({ length: contract.globals.length }, (_, i) => (i % 3) / 3),
        terrain: Array(256).fill(0),
        candidates: [0, 1, -1].map((targetIndex, row) => ({
            signature: "candidate-" + row,
            targetIndex,
            features: Array.from({ length: contract.candidates.length }, (_, i) => ((i + row) % 5) / 5),
        })),
    };
}

test("a complete warm-start pair reproduces the shipped ensemble exactly without installing a policy", () => {
    const input = observation(),
        before = getA19NeuralModel().predict(input);
    const pair = loadA19PolicyHeadPair(bundle());
    expect(pair.predict(input)).toEqual(before);
    expect(getA19NeuralModel().predict(input)).toEqual(before);
    expect(pair.predictMembers(input)).toHaveLength(2);
});

test("pair loading binds both complete files and detects corruption or swapped roles", () => {
    const data = bundle();
    expect(() => loadA19PolicyHeadPair({ ...data, student: data.student + " " })).toThrow("member identity");
    expect(() => loadA19PolicyHeadPair({ ...data, student: data.partner, partner: data.student })).toThrow(
        "member identity",
    );
    expect(() => loadA19PolicyHeadPair({ ...data, manifest: data.manifest + " " })).toThrow("manifest identity");
});

test("even correctly hashed members must share the declared recipe and checkpoint", () => {
    const data = bundle();
    const raw = JSON.parse(data.partner);
    raw.checkpointEpoch++;
    const partner = JSON.stringify(raw),
        manifest = JSON.parse(data.manifest);
    manifest.members.partner.sha256 = sha(partner);
    const bytes = JSON.stringify(manifest);
    expect(() => loadA19PolicyHeadPair({ ...data, partner, manifest: bytes, expectedPairSha256: sha(bytes) })).toThrow(
        "different checkpoints",
    );
});

test("functional, unchanged and frozen-partner control pairs cannot masquerade as trained joint finalists", () => {
    expect(() => loadA19PolicyHeadPair({ ...bundle(), purpose: "strength" })).toThrow("cannot consume strength");
    expect(() => loadA19PolicyHeadPair({ ...bundle({ changed: true, fixture: true }), purpose: "strength" })).toThrow(
        "cannot consume strength",
    );
    expect(() => loadA19PolicyHeadPair(bundle({ changed: true, mode: "student" }))).toThrow("modified its partner");
    // This checks only pair integrity. A caller still owns data, fit and strength admission.
    expect(loadA19PolicyHeadPair({ ...bundle({ changed: true }), purpose: "strength" }).trainingMembers).toBe("joint");
});

test("head fingerprints are checked independently of the enclosing file hash", () => {
    const data = bundle(),
        manifest = JSON.parse(data.manifest);
    manifest.members.student.headSha256 = "0".repeat(64);
    const bytes = JSON.stringify(manifest);
    expect(() => loadA19PolicyHeadPair({ ...data, manifest: bytes, expectedPairSha256: sha(bytes) })).toThrow(
        "policy-head identity",
    );
});
