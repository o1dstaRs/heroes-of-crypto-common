/** Offline treatment-effect selector. Serving AI does not import this research model. */
import { creatureInfo } from "../ai/setup/creature_score";
import type { RankedDraftSynergyVariants } from "../ai/setup/draft_synergy_variants";
import type { RangedCounterArm } from "./measure_ranged_counter_research";
import { rangedCounterThreats } from "./ranged_counter_research";

export const LEARNED_RANGED_SETUP_SCHEMA = "hoc.learned-ranged-setup.v1";
export const LEARNED_RANGED_SETUP_FEATURE_SCHEMA = "public-roster-setup-effects-v1";
const IDS = Array.from({ length: 127 }, (_, index) => index + 1).filter((id) => creatureInfo(id));
const FACTIONS = ["Life", "Chaos", "Might", "Nature"] as const;
const SUMMARY_NAMES = [
    "ranged",
    "meleeFlyers",
    "casters",
    "offensiveCasters",
    "magicDamage",
    "rangeNull",
    "noFly",
    "shield",
    "mechanism",
    "wounds",
    "initiative",
    "steps",
    "hpPerExperience",
    "meanLevel",
    "nativeMelee",
] as const;
export const LEARNED_RANGED_SETUP_FEATURE_NAMES = [
    "bias",
    ...[5, 6, 7].map((budget) => `budget:${budget}`),
    ...[1, 3, 4].map((map) => `map:${map}`),
    ...FACTIONS.flatMap((faction) => [1, 2].map((variant) => `variant:${faction}:${variant}`)),
    ...IDS.map((id) => `own:${id}`),
    ...IDS.map((id) => `publicEnemy:${id}`),
    ...SUMMARY_NAMES.map((name) => `ownSummary:${name}`),
    ...SUMMARY_NAMES.map((name) => `publicEnemySummary:${name}`),
    "rangedXNull",
    "rangedXFlyers",
    "castersXFlyers",
    "magicXMechanism",
    "initiativeDifference",
    "mobilityDifference",
] as const;

export interface IPublicRangedSetupContext {
    ownCreatureIds: readonly number[];
    publicOpponentCreatureIds: readonly number[];
    budget: number;
    map: number;
    synergyVariants: RankedDraftSynergyVariants;
}

export interface ILearnedRangedSetupModel {
    schema: typeof LEARNED_RANGED_SETUP_SCHEMA;
    featureSchema: typeof LEARNED_RANGED_SETUP_FEATURE_SCHEMA;
    features: readonly string[];
    freeWeights: readonly number[];
    paidWeights: readonly number[];
    margin: number;
    productionPromotion: false;
}

function summary(ids: readonly number[]): number[] {
    const infos = ids.map((id) => creatureInfo(id)!);
    const count = (predicate: (info: (typeof infos)[number]) => boolean): number => infos.filter(predicate).length / 6;
    const mean = (read: (info: (typeof infos)[number]) => number): number =>
        infos.reduce((total, info) => total + read(info), 0) / 6;
    return [
        count((info) => info.ranged),
        count((info) => info.canFly && !info.ranged),
        count((info) => info.caster),
        count((info) => info.rangedSpellDamage),
        count((info) => info.dealsMagicDamage === true),
        count((info) => info.abilities.includes("Range Null Field")),
        count((info) => info.abilities.includes("No Fly")),
        count((info) => info.abilities.includes("Flesh Shield") || info.abilities.includes("Sanctuary")),
        count((info) => info.abilities.includes("Mechanism")),
        count((info) => info.abilities.includes("Deep Wounds")),
        mean((info) => info.initiative / 10),
        mean((info) => (info.movementSteps ?? 0) / 10),
        mean((info) => Math.min(2, info.hp / Math.max(1, info.exp)) / 2),
        mean((info) => info.level / 4),
        count((info) => info.melee === true && !info.ranged),
    ];
}

/** All opponent inputs are public creature identities; no enemy amount, position or selected upgrade is read. */
export function learnedRangedSetupFeatures(context: IPublicRangedSetupContext): number[] | undefined {
    const own = [...context.ownCreatureIds].sort((a, b) => a - b),
        enemy = [...context.publicOpponentCreatureIds].sort((a, b) => a - b);
    if (
        own.length !== 6 ||
        enemy.length !== 6 ||
        new Set(own).size !== 6 ||
        new Set(enemy).size !== 6 ||
        [...own, ...enemy].some((id) => !Number.isSafeInteger(id) || !creatureInfo(id)) ||
        ![5, 6, 7].includes(context.budget) ||
        ![1, 3, 4].includes(context.map) ||
        FACTIONS.some((faction) => ![1, 2].includes(context.synergyVariants[faction]))
    )
        return undefined;
    const a = summary(own),
        b = summary(enemy);
    return [
        1,
        ...[5, 6, 7].map((budget) => Number(context.budget === budget)),
        ...[1, 3, 4].map((map) => Number(context.map === map)),
        ...FACTIONS.flatMap((faction) => [1, 2].map((variant) => Number(context.synergyVariants[faction] === variant))),
        ...IDS.map((id) => Number(own.includes(id))),
        ...IDS.map((id) => Number(enemy.includes(id))),
        ...a,
        ...b,
        a[0] * b[5],
        a[0] * b[1],
        a[2] * b[1],
        a[4] * b[8],
        a[10] - b[10],
        a[11] - b[11],
    ];
}

export function validateLearnedRangedSetupModel(model: ILearnedRangedSetupModel): void {
    const dimension = LEARNED_RANGED_SETUP_FEATURE_NAMES.length;
    if (
        model.schema !== LEARNED_RANGED_SETUP_SCHEMA ||
        model.featureSchema !== LEARNED_RANGED_SETUP_FEATURE_SCHEMA ||
        model.productionPromotion !== false ||
        model.features.join("\n") !== LEARNED_RANGED_SETUP_FEATURE_NAMES.join("\n") ||
        !Number.isFinite(model.margin) ||
        model.margin < 0 ||
        model.margin > 1 ||
        [model.freeWeights, model.paidWeights].some(
            (weights) => weights.length !== dimension || weights.some((value) => !Number.isFinite(value)),
        )
    )
        throw new Error("Invalid learned ranged setup research model");
}

export function predictLearnedRangedSetup(model: ILearnedRangedSetupModel, features: readonly number[]) {
    if (
        features.length !== LEARNED_RANGED_SETUP_FEATURE_NAMES.length ||
        features.some((value) => !Number.isFinite(value))
    )
        throw new Error("Invalid ranged setup feature row");
    const score = (weights: readonly number[]): number =>
        features.reduce((total, value, index) => total + value * weights[index], 0);
    return { free: score(model.freeWeights), paid: score(model.paidWeights) };
}

export function selectLearnedRangedSetup(
    model: ILearnedRangedSetupModel,
    context: IPublicRangedSetupContext,
): RangedCounterArm {
    const features = learnedRangedSetupFeatures(context);
    if (!features || context.ownCreatureIds.filter((id) => creatureInfo(id)?.ranged).length < 3) return "control";
    const threats = rangedCounterThreats(context.publicOpponentCreatureIds);
    if (!threats.nullField && threats.flyers < 2 && !threats.area) return "control";
    const gains = predictLearnedRangedSetup(model, features);
    if ((threats.nullField || threats.flyers >= 2) && gains.paid > Math.max(0, gains.free) + model.margin)
        return "placement1-sniper";
    return gains.free > model.margin ? "free-spread" : "control";
}
