/** User-locked research reference; importing it never changes the live strategy. */
import checkpoint from "./checkpoints/satyr_contact_20261108/checkpoint.json";
import { fingerprintV09 } from "./v0_9/protocol";

export const LOCKED_SATYR_CONTACT_ID = "satyr-contact-support-20261108";
export const LOCKED_SATYR_CONTACT_SHA256 = "58a8da8d47be38cf2c024d6b8071a7acf8a226f6bced94ae027dfbb8f8bcfead";

/** Acceptance preserves the measured candidate, including its failed original progression gate. */
export function lockedSatyrContactCheckpoint() {
    const { sha256, ...body } = checkpoint;
    if (
        sha256 !== LOCKED_SATYR_CONTACT_SHA256 ||
        fingerprintV09(body) !== sha256 ||
        body.id !== LOCKED_SATYR_CONTACT_ID ||
        body.status !== "user-accepted-research-checkpoint" ||
        body.originalProgressionGatePassed !== false ||
        body.productionActivation !== false ||
        body.subsequentExperimentsMayOverwrite !== false
    )
        throw new Error("Locked Satyr contact checkpoint changed");
    return structuredClone(checkpoint);
}
