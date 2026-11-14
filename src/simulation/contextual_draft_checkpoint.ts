/** Frozen research models and provenance. Loading a checkpoint does not activate a serving policy. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "./checkpoints/contextual_draft_20261110/checkpoint.json";
import full from "./checkpoints/contextual_draft_20261110/full-model.json";
import ablated from "./checkpoints/contextual_draft_20261110/ablated-model.json";
import { validateContextualDraftModel, type IContextualDraftModel } from "./contextual_draft_research";

export const CONTEXTUAL_DRAFT_CHECKPOINT_ID = "contextual-draft-20261110";
export const CONTEXTUAL_DRAFT_REGISTRATION_SHA256 = "b3c86d9ed2b14858828a31f30f664dd3b8d7b3be42ff1e567f63b94a0d0ffc29";
export const CONTEXTUAL_DRAFT_MODEL_SHA256 = Object.freeze({
    full: "063a888e6e38fe4322e89385929ac8f21dcb7b7f0dd5db070cb46a44a95eeeba",
    ablated: "be2bf950866cbb139e8f7cd284302f41f4a3fc61361743310e0729202443072a",
});

/** Keep both fitted heads, the original failed gate and all four helper implementations unchanged. */
export function lockedContextualDraftResearchModels(): Readonly<{
    full: IContextualDraftModel;
    ablated: IContextualDraftModel;
}> {
    if (
        manifest.schema !== "hoc.contextual-draft-checkpoint.v1" ||
        manifest.id !== CONTEXTUAL_DRAFT_CHECKPOINT_ID ||
        manifest.registrationSha256 !== CONTEXTUAL_DRAFT_REGISTRATION_SHA256 ||
        manifest.qualificationPassed !== false ||
        manifest.confirmationOpened !== false ||
        manifest.productionPromotion !== false
    )
        throw new Error("Changed contextual draft checkpoint provenance");
    for (const [path, expected] of Object.entries(manifest.helperSourceSha256)) {
        const actual = createHash("sha256")
            .update(readFileSync(resolve(import.meta.dir, "../..", path)))
            .digest("hex");
        if (actual !== expected) throw new Error("Changed frozen contextual draft helper: " + path);
    }
    const checked = (value: unknown, information: IContextualDraftModel["information"], expected: string) => {
        const model = value as IContextualDraftModel;
        validateContextualDraftModel(model);
        const actual = createHash("sha256").update(JSON.stringify(model)).digest("hex");
        if (actual !== expected || model.information !== information)
            throw new Error("Changed contextual draft weights");
        Object.freeze(model.features);
        Object.freeze(model.weights);
        return Object.freeze(model);
    };
    return Object.freeze({
        full: checked(full, "full", CONTEXTUAL_DRAFT_MODEL_SHA256.full),
        ablated: checked(ablated, "without-map-synergies", CONTEXTUAL_DRAFT_MODEL_SHA256.ablated),
    });
}
