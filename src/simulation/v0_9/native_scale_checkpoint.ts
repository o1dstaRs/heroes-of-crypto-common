/** Fixed native research reference; importing never activates a live policy. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// The model contract reaches Unit through an import cycle; compiled consumers need the catalog first.
import "../../ai/decision_path_catalog";

import savedBundle from "./checkpoints/native_scale_20261108/model_bundle.json";
import savedManifest from "./checkpoints/native_scale_20261108/manifest.json";
import savedReferences from "./checkpoints/native_scale_20261108/numerical_references.json";
import type { IV09ModelArtifact } from "../../ai/versions/v0_9_model";
import { verifyV09ResearchArtifact } from "./parity";
import { fingerprintV09 } from "./protocol";

export const NATIVE_V09_SCALE_CHECKPOINT_ID = "native-v09-scale-20261108";
export const NATIVE_V09_SCALE_MODEL_SHA256 = "4749da06ec07bfd08db7ec6c2bbe03ba6dc4e73847e67585804dbccc253e7bb9";
export const NATIVE_V09_SCALE_CHECKPOINT_SHA256 = "40b243333e4d6963650bf87877afd8ba8ec151cb89af2cbf2c46f6f5783b50b0";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function nativeV09ScaleCheckpoint() {
    if (
        fingerprintV09(savedManifest) !== NATIVE_V09_SCALE_CHECKPOINT_SHA256 ||
        savedManifest.checkpointId !== NATIVE_V09_SCALE_CHECKPOINT_ID ||
        savedManifest.modelSha256 !== NATIVE_V09_SCALE_MODEL_SHA256 ||
        savedManifest.promoted ||
        savedManifest.productionActivation ||
        savedManifest.productionTimingQualified ||
        savedManifest.result.stockA19ScoreTargetPassed
    ) {
        throw new Error("Native v0.9 scale checkpoint metadata changed");
    }
    return structuredClone(savedManifest);
}

/** Exact original model bytes, including the original unpromoted metadata; each caller gets a new buffer. */
export function nativeV09ScaleCheckpointBytes(): Buffer {
    const manifest = nativeV09ScaleCheckpoint();
    if (savedBundle.encoding !== "gzip-base64" || savedBundle.rawSha256 !== manifest.sourceArtifactRawSha256) {
        throw new Error("Native v0.9 scale checkpoint encoding changed");
    }
    // Keep the original metadata and weights byte-for-byte; formatting the surrounding bundle must not
    // rewrite provenance or pretend this is a newly qualified live model.
    const bytes = gunzipSync(Buffer.from(savedBundle.data, "base64"), { maxOutputLength: 2 * 1024 * 1024 });
    if (bytes.byteLength !== savedBundle.rawBytes || sha(bytes) !== manifest.sourceArtifactRawSha256) {
        throw new Error("Native v0.9 scale checkpoint bytes changed");
    }
    return bytes;
}

/** Loading a reference is separate from qualification and explicit offline strategy activation. */
export function loadNativeV09ScaleResearchModel(): IV09ModelArtifact {
    const manifest = nativeV09ScaleCheckpoint();
    const model = JSON.parse(nativeV09ScaleCheckpointBytes().toString("utf8")) as IV09ModelArtifact;
    verifyV09ResearchArtifact(model);
    if (
        model.modelSha256 !== NATIVE_V09_SCALE_MODEL_SHA256 ||
        model.promoted ||
        model.qualification !== null ||
        model.source.commonCommit !== manifest.sourceCommonCommit ||
        model.source.rulesSha256 !== manifest.rulesSha256 ||
        model.source.rosterSha256 !== manifest.rosterSha256 ||
        model.source.trainingRunId !== manifest.trainingRunId
    ) {
        throw new Error("Native v0.9 scale checkpoint identity changed");
    }
    return model;
}

/** Synthetic input recipes and exact scores for this fixed model, not additional strength observations. */
export function nativeV09ScaleNumericalReferences() {
    const manifest = nativeV09ScaleCheckpoint();
    if (fingerprintV09(savedReferences) !== manifest.numericalReferencesSha256) {
        throw new Error("Native v0.9 scale numerical references changed");
    }
    return structuredClone(savedReferences);
}
