/** User-accepted research reference. Importing this module never changes the live AI profile. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// The inference contract reaches Unit through an engine import cycle. Initialize the catalog first:
// its captured Unit prototypes must be ready in compiled JS as well as Bun's source execution.
import "../../ai/decision_path_catalog";

import savedCheckpoint from "./checkpoints/a19_full_policy_5036_20261108/checkpoint.json";
import savedBundle from "./checkpoints/a19_full_policy_5036_20261108/pair_bundle.json";
import { loadA19PolicyHeadPair } from "./a19_policy_head_pair";
import { fingerprintV09 } from "./protocol";

export const LOCKED_A19_FULL_POLICY_CHECKPOINT_ID = "a19-full-policy-5036-20261108";
export const LOCKED_A19_FULL_POLICY_CHECKPOINT_SHA256 =
    "20432dc1c9a99c6bfe0322c6875087591930dca06f09429bdb242edbe5d94307";
export const LOCKED_A19_FULL_POLICY_PAIR_SHA256 = "675b438406b6ee3aa313feb1e382843a0442bc9970bc28810abc19d30d26aa68";
export const LOCKED_A19_FULL_POLICY_BUNDLE_SHA256 = "f8f4aca1b792a02d4d72fa2208459ba33247455fb754222f54d43c6a6f45da99";

/** Acceptance is separate from the unchanged original statistical and production-timing gates. */
export function lockedA19FullPolicyCheckpoint() {
    const { sha256, ...body } = savedCheckpoint;
    if (
        sha256 !== LOCKED_A19_FULL_POLICY_CHECKPOINT_SHA256 ||
        fingerprintV09(body) !== sha256 ||
        body.id !== LOCKED_A19_FULL_POLICY_CHECKPOINT_ID ||
        body.pairManifestSha256 !== LOCKED_A19_FULL_POLICY_PAIR_SHA256 ||
        body.bundleSha256 !== LOCKED_A19_FULL_POLICY_BUNDLE_SHA256 ||
        body.status !== "user-accepted-research-baseline" ||
        body.productionActivation !== false ||
        body.productionTimingQualified !== false ||
        body.result.positiveAdvantageGatePassed !== false ||
        body.subsequentExperimentsMayOverwrite !== false
    )
        throw new Error("Locked A19 full-policy checkpoint changed");
    return structuredClone(savedCheckpoint);
}

/** Original model and profile bytes, including their original unpromoted metadata. */
export function lockedA19FullPolicyInputs() {
    const checkpoint = lockedA19FullPolicyCheckpoint();
    if (
        savedBundle.schema !== "hoc.ai.a19.locked-pair-bytes.v1" ||
        savedBundle.encoding !== "gzip-base64" ||
        fingerprintV09(savedBundle) !== LOCKED_A19_FULL_POLICY_BUNDLE_SHA256
    )
        throw new Error("Locked A19 full-policy bundle changed");
    const decode = (name: keyof typeof savedBundle.files) => {
        const bytes = gunzipSync(Buffer.from(savedBundle.files[name], "base64"));
        if (createHash("sha256").update(bytes).digest("hex") !== checkpoint.artifactRawSha256[name])
            throw new Error("Locked A19 full-policy bytes changed: " + name);
        return bytes.toString("utf8");
    };
    return Object.freeze({
        manifest: decode("pair-manifest.json"),
        student: decode("model.json"),
        partner: decode("partner-model.json"),
        runtimeProfile: decode("runtime-profile.json"),
        expectedPairSha256: LOCKED_A19_FULL_POLICY_PAIR_SHA256,
        purpose: "strength" as const,
    });
}

/** Use as a fixed comparator in a newly registered research campaign. */
export function loadLockedA19FullPolicyPair() {
    return loadA19PolicyHeadPair(lockedA19FullPolicyInputs());
}

if (import.meta.main) {
    const checkpoint = lockedA19FullPolicyCheckpoint();
    const pair = loadLockedA19FullPolicyPair();
    console.log(
        JSON.stringify({
            checkpoint: checkpoint.id,
            status: checkpoint.status,
            pairSha256: pair.pairSha256,
            result: checkpoint.result,
            settings: checkpoint.settings,
            productionActivation: checkpoint.productionActivation,
        }),
    );
}
