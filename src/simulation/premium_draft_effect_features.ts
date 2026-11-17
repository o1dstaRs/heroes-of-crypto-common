import type { IDraftMatchupModel } from "../ai/setup/draft_matchup_value";
import { createMatchedDraftFeatures, MATCHED_DRAFT_FEATURES } from "./premium_matched_draft_model";
import { premiumDraftSupportProfile, PREMIUM_SUPPORT_FEATURE_NAMES } from "./premium_draft_support_features";

const BASE = MATCHED_DRAFT_FEATURES.map((name, index) => ({ name, index })).filter(
    ({ name }) => !["bias", "historicalCurrent", "historicalAlternative"].includes(name),
);
const ACTION = [
    "hpPerExperience",
    "damagePerExperience",
    "movement",
    "flyers",
    "melee",
    "shooters",
    "casters",
    "resurrectionSources",
    "healingPowerPerExperience",
    "controlCharges",
    "damageSpellCharges",
] as const;
const ENEMY = [
    "shooters",
    "casters",
    "melee",
    "flyers",
    "bodyHp",
    "armor",
    "initiative",
    "movement",
    "resurrectionSources",
    "healingPowerPerExperience",
    "controlCharges",
    "damageSpellCharges",
] as const;
const ALLY = [
    "hpPerExperience",
    "shooters",
    "casters",
    "resurrectionSources",
    "healingPowerPerExperience",
    "controlCharges",
] as const;
const ALLY_PAIRS = ALLY.flatMap((first, i) => ALLY.slice(i + 1).map((second) => [first, second] as const));
const MAPS = [1, 3, 4] as const;

/** Unfitted research contract. Keep the old failed models and their feature identities unchanged. */
export const PREMIUM_DRAFT_EFFECT_SCHEMA = "premium-public-draft-effect-features-v1";
export const PREMIUM_DRAFT_EFFECT_FEATURES = [
    ...BASE.map(({ name }) => name),
    ...PREMIUM_SUPPORT_FEATURE_NAMES.map((name) => `support:${name}`),
    ...ACTION.flatMap((action) => ENEMY.map((enemy) => `enemyInteraction:${action}:${enemy}`)),
    ...ALLY_PAIRS.map(([first, second]) => `allyInteraction:${first}:${second}`),
    ...MAPS.flatMap((map) => ACTION.map((action) => `mapInteraction:${map}:${action}`)),
];

/**
 * Public-only replacement effects. Enemy capability multiplies the changed own capability,
 * so it survives subtraction. Ally products are differenced as whole-army potentials.
 * All terms are zero for no change and antisymmetric for reversing the same two choices.
 * These printed-capability features do not predict paid setup, actual damage or spell delivery.
 */
export function createPremiumDraftEffectFeatures(historical: IDraftMatchupModel) {
    const base = createMatchedDraftFeatures(historical);
    type Name = (typeof PREMIUM_SUPPORT_FEATURE_NAMES)[number];
    const index = (name: Name) => PREMIUM_SUPPORT_FEATURE_NAMES.indexOf(name);
    return (...args: Parameters<typeof base>) => {
        const [view, , incumbent, alternative] = args;
        const original = base(...args);
        if (!original) return null;
        try {
            const current = premiumDraftSupportProfile(
                [...view.creaturesPicked, incumbent],
                view.knownOpponentCreatures,
            ).values;
            const next = premiumDraftSupportProfile(
                [...view.creaturesPicked, alternative],
                view.knownOpponentCreatures,
            ).values;
            // ENEMY lists only intrinsic fields: none depends on the supplied opposing roster.
            const enemy = premiumDraftSupportProfile(view.knownOpponentCreatures, [
                ...view.creaturesPicked,
                incumbent,
            ]).values;
            const delta = (name: Name) => next[index(name)] - current[index(name)];
            const values = [
                ...BASE.map(({ index }) => original.features[index]),
                ...PREMIUM_SUPPORT_FEATURE_NAMES.map(delta),
                ...ACTION.flatMap((action) => ENEMY.map((name) => delta(action) * enemy[index(name)])),
                ...ALLY_PAIRS.map(
                    ([first, second]) =>
                        next[index(first)] * next[index(second)] - current[index(first)] * current[index(second)],
                ),
                ...MAPS.flatMap((map) => ACTION.map((action) => (view.revealedMap === map ? delta(action) : 0))),
            ];
            if (values.length !== PREMIUM_DRAFT_EFFECT_FEATURES.length || values.some((x) => !Number.isFinite(x)))
                return null;
            return { schema: PREMIUM_DRAFT_EFFECT_SCHEMA, priorGain: original.priorGain, values };
        } catch {
            return null;
        }
    };
}
