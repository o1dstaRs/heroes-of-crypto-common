/** Research-only complete-pair loading. This module never installs a shipped policy. */
import { createHash } from "node:crypto";
import { meanA19Policy } from "../a19_neural_model";
import { V09A19CpuModel } from "./a19_inference";
import { V09_A19_OBSERVATION_SHA256, type IV09A19Observation } from "./a19_observation";

export const A19_HEAD_PAIR_SCHEMA = "hoc.ai.v0_9.a19.research-head-pair.v1";
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

interface IMember {
    file: string;
    sha256: string;
    initialHeadSha256: string;
    headSha256: string;
}
interface IManifest {
    schema: string;
    promoted: boolean;
    trainingMembers: "student" | "joint";
    registrationSha256: string;
    trainerSha256: string;
    observationSha256: string;
    initialStudentSha256: string;
    initialPartnerSha256: string;
    recipeOrdinal: number;
    checkpointEpoch: number;
    syntheticFunctionalFixture: boolean;
    members: { student: IMember; partner: IMember };
}

export function loadA19PolicyHeadPair(input: {
    manifest: string;
    student: string;
    partner: string;
    expectedPairSha256: string;
    purpose: "functional" | "strength";
}) {
    if (!digest(input.expectedPairSha256) || sha256(input.manifest) !== input.expectedPairSha256)
        throw new Error("Research pair manifest identity mismatch");
    if (input.purpose !== "functional" && input.purpose !== "strength")
        throw new Error("Choose an explicit research-pair purpose");
    const manifest = JSON.parse(input.manifest) as IManifest;
    if (
        !manifest ||
        manifest.schema !== A19_HEAD_PAIR_SCHEMA ||
        manifest.promoted !== false ||
        !["student", "joint"].includes(manifest.trainingMembers) ||
        ![
            manifest.registrationSha256,
            manifest.trainerSha256,
            manifest.initialStudentSha256,
            manifest.initialPartnerSha256,
        ].every(digest) ||
        manifest.observationSha256 !== V09_A19_OBSERVATION_SHA256 ||
        !Number.isInteger(manifest.recipeOrdinal) ||
        manifest.recipeOrdinal < 0 ||
        !Number.isInteger(manifest.checkpointEpoch) ||
        manifest.checkpointEpoch < -1 ||
        typeof manifest.syntheticFunctionalFixture !== "boolean" ||
        !manifest.members
    )
        throw new Error("Invalid research pair manifest");
    const changed: boolean[] = [];
    const models = (["student", "partner"] as const).map((role) => {
        const member = manifest.members[role];
        const bytes = input[role];
        if (
            !member ||
            member.file !== (role === "student" ? "model.json" : "partner-model.json") ||
            ![member.sha256, member.initialHeadSha256, member.headSha256].every(digest) ||
            sha256(bytes) !== member.sha256
        )
            throw new Error("Research pair member identity mismatch");
        const raw = JSON.parse(bytes);
        if (
            raw?.pairRole !== role ||
            raw.recipeOrdinal !== manifest.recipeOrdinal ||
            raw.checkpointEpoch !== manifest.checkpointEpoch ||
            raw.syntheticFunctionalFixture !== manifest.syntheticFunctionalFixture
        )
            throw new Error("Research pair members belong to different checkpoints");
        const model = new V09A19CpuModel(raw, {
            manifestSha256: manifest.registrationSha256,
            sourceSha256: manifest.trainerSha256,
        });
        const values = [...raw.weights["policy.weight"][0], ...raw.weights["policy.bias"]] as number[];
        const head = new DataView(new ArrayBuffer(values.length * 4));
        values.forEach((value, index) => head.setFloat32(index * 4, value, true));
        if (sha256(new Uint8Array(head.buffer)) !== member.headSha256)
            throw new Error("Research pair policy-head identity mismatch");
        changed.push(member.initialHeadSha256 !== member.headSha256);
        return model;
    });
    if (manifest.trainingMembers === "student" && changed[1])
        throw new Error("Frozen-partner control modified its partner");
    if (
        input.purpose === "strength" &&
        (manifest.syntheticFunctionalFixture ||
            manifest.checkpointEpoch < 0 ||
            !changed[0] ||
            (manifest.trainingMembers === "joint" && !changed[1]))
    )
        throw new Error("Functional or unchanged pair cannot consume strength games");
    return Object.freeze({
        pairSha256: input.expectedPairSha256,
        trainingMembers: manifest.trainingMembers,
        predictMembers: (observation: IV09A19Observation) => models.map((model) => model.predict(observation)),
        predict: (observation: IV09A19Observation) => meanA19Policy(models.map((model) => model.predict(observation))),
    });
}
