import { DOCTRINE_LIST, type Doctrine } from "../doctrines/doctrine_properties";
import { hashSimulationParts, makeRng } from "./army";
import { aiMetaChoiceEvidence } from "./ai_meta_evidence";

export const PREMIUM_META_PRIVATE_SETUP_STUDY = "premium-ranked-v1";
export const PREMIUM_META_STUDY = "premium-ranked-v2";
export const PREMIUM_META_FULL_AUGMENTS_STUDY = "premium-ranked-v3";
export const PREMIUM_META_STUDIES = [
    PREMIUM_META_PRIVATE_SETUP_STUDY,
    PREMIUM_META_STUDY,
    PREMIUM_META_FULL_AUGMENTS_STUDY,
] as const;
export const isPublicSetupStudy = (value: unknown): boolean =>
    value === PREMIUM_META_STUDY || value === PREMIUM_META_FULL_AUGMENTS_STUDY;
export const isPremiumMetaStudy = (value: unknown): value is AiMetaStudy =>
    PREMIUM_META_STUDIES.some((study) => study === value);
export const PREMIUM_META_DRAFT_SPEC = "ranked-unit-strength-a19-side-v4-w16-r4";
export const PREMIUM_META_EVIDENCE_SCHEMA = "premium-cohort-evidence-v4";
export const PREMIUM_META_FULL_AUGMENTS_SCHEMA = "premium-cohort-evidence-v5";
export const premiumStudyEvidenceSchema = (study: AiMetaStudy) =>
    study === PREMIUM_META_FULL_AUGMENTS_STUDY ? PREMIUM_META_FULL_AUGMENTS_SCHEMA : PREMIUM_META_EVIDENCE_SCHEMA;
export type AiMetaStudy = (typeof PREMIUM_META_STUDIES)[number];

export function aiMetaStudyFromEnvironment(): AiMetaStudy | undefined {
    const value = process.env.AI_META_STUDY_PROFILE;
    if (!value) return undefined;
    if (!isPremiumMetaStudy(value)) throw new Error(`Unknown AI_META_STUDY_PROFILE: ${value}`);
    return value;
}

/** Independent policy stream: exploration never consumes offer/collision RNG draws. */
export function premiumStudyChoice(ids: readonly number[], preferred: number, seed: number, epsilon = 0.2) {
    if (!ids.includes(preferred)) throw new Error("Study preference is outside the visible offer");
    const rng = makeRng(seed);
    const mode = rng() < epsilon ? "explore" : "exploit";
    const selected = mode === "explore" ? ids[Math.floor(rng() * ids.length)] : preferred;
    return {
        selected,
        evidence: aiMetaChoiceEvidence(
            ids.map((id) => ({ key: String(id), score: Number(id === preferred) })),
            String(preferred),
            String(selected),
            mode,
            epsilon,
        ),
    };
}

export function premiumStudyDoctrine(seed: number, side: string): Doctrine {
    const rng = makeRng(hashSimulationParts("premium-doctrine-v1", seed, side));
    return DOCTRINE_LIST[Math.floor(rng() * DOCTRINE_LIST.length)].id;
}
