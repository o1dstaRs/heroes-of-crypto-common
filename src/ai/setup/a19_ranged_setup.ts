// Explicit user adoption does not change the saved model's historical qualification metadata.
import { createHash } from "node:crypto";
import savedModel from "../../simulation/checkpoints/learned_ranged_setup_20261109/model.json";
import { creatureInfo } from "./creature_score";
import type { RankedDraftSynergyVariants } from "./draft_synergy_variants";
import { rangedCounterThreats } from "./a19_ranged_formation";

export type RangedCounterArm = "control" | "free-spread" | "placement1-sniper";
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

export const A19_RANGED_SETUP_MODEL_ID = "public-ranged-setup-effects-d786f4e9-20261114-user-adoption";
export const A19_RANGED_SETUP_MODEL_SHA256 = "d786f4e9d90c321172021b65a81cb5b04f715aba5c203d388580007f93930007";
const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(",")}}`;
};
const model = savedModel as ILearnedRangedSetupModel;
validateLearnedRangedSetupModel(model);
if (createHash("sha256").update(canonical(model)).digest("hex") !== A19_RANGED_SETUP_MODEL_SHA256)
    throw new Error("Changed adopted A19 ranged setup checkpoint");
Object.freeze(model.features);
Object.freeze(model.freeWeights);
Object.freeze(model.paidWeights);
Object.freeze(model);

/** No hidden roster completion and no spending a partial remaining budget as if it were the full doctrine. */
export function selectA19RangedSetup(
    context: IPublicRangedSetupContext,
    options: { paidPlanAvailable: boolean },
): RangedCounterArm {
    const selected = selectLearnedRangedSetup(model, context);
    if (selected !== "placement1-sniper" || options.paidPlanAvailable) return selected;
    const features = learnedRangedSetupFeatures(context);
    return features && predictLearnedRangedSetup(model, features).free > model.margin ? "free-spread" : "control";
}

export function a19RangedSetupAugments(budget: number) {
    if (![5, 6, 7].includes(budget)) throw new RangeError("Expected a real doctrine budget");
    const armor = budget - 4;
    return [
        { kind: "Placement" as const, value: 1 },
        { kind: "Sniper" as const, value: 3 },
        { kind: "Armor" as const, value: armor },
    ];
}

export function hasA19RangedSetupAugments(
    budget: number,
    plan: Readonly<{
        Placement: number;
        Sniper: number;
        Armor: number;
        Might: number;
        Movement: number;
        Empower: number;
    }>,
): boolean {
    return (
        [5, 6, 7].includes(budget) &&
        plan.Placement === 1 &&
        plan.Sniper === 3 &&
        plan.Armor === budget - 4 &&
        plan.Might === 0 &&
        plan.Movement === 0 &&
        plan.Empower === 0
    );
}
