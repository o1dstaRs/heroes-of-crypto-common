import { Tier1Artifact, Tier2Artifact } from "../../artifacts/artifact_properties";
import { CreatureLevels } from "../../generated/protobuf/v1/creature_gen";
import { getUpgradePoints } from "../../doctrines/doctrine_properties";
import { creatureInfo } from "./creature_score";
import { empowerSetupFeatures } from "./empower_setup";
import type { IPlacementSetupDecisionContext } from "./setup_strategy";

export const EMPOWER_CONTEXT_SCHEMA = "public-context-empower-v1";
const IDS = Array.from({ length: 127 }, (_, index) => index + 1).filter((id) => creatureInfo(id));
const numericIds = (values: object): number[] =>
    Object.values(values)
        .filter((value): value is number => typeof value === "number" && value > 0)
        .sort((a, b) => a - b);
const T1 = numericIds(Tier1Artifact),
    T2 = numericIds(Tier2Artifact);
const SUMMARY = [
    "ranged",
    "damageCasters",
    "magicAbilities",
    "magicAmplifiers",
    "melee",
    "flyers",
    "magicImmune",
    "mechanisms",
    "ward",
    "healing",
    "initiative",
    "armor",
    "hpPerExperience",
    "physicalDamagePerExperience",
    "movement",
    "life",
    "chaos",
    "might",
    "nature",
] as const;
export const EMPOWER_CONTEXT_FEATURES = [
    ...[5, 6, 7].map((budget) => `budget:${budget}`),
    ...[1, 3, 4].map((map) => `map:${map}`),
    ...IDS.map((id) => `own:${id}`),
    ...IDS.map((id) => `publicEnemy:${id}`),
    ...T1.map((id) => `ownTier1:${id}`),
    ...T2.map((id) => `ownTier2:${id}`),
    ...SUMMARY.map((name) => `own:${name}`),
    ...SUMMARY.map((name) => `publicEnemy:${name}`),
    ...[5, 6, 7].flatMap((budget) => SUMMARY.slice(0, 10).map((name) => `budget:${budget}:own:${name}`)),
    "magicXImmunity",
    "magicXMechanisms",
    "magicXWard",
    "rangedXEnemyArmor",
    "meleeXEnemyFlyers",
    "castersXEnemyFlyers",
    "initiativeDifference",
    "mobilityDifference",
] as const;

function summary(ids: readonly number[]): number[] {
    const infos = [...ids].sort((a, b) => a - b).map((id) => creatureInfo(id)!);
    const count = (predicate: (info: (typeof infos)[number]) => boolean) => infos.filter(predicate).length / 6;
    const mean = (read: (info: (typeof infos)[number]) => number) =>
        infos.reduce((sum, info) => sum + read(info), 0) / 6;
    return [
        count((info) => info.ranged),
        count((info) => info.rangedSpellDamage),
        count((info) => (!!info.dealsMagicDamage && !info.rangedSpellDamage) || info.name === "Nightmare"),
        count((info) => info.magicDamageAmplifier),
        count((info) => info.melee),
        count((info) => info.canFly),
        count((info) => info.magicImmune === true),
        count((info) => info.abilities.includes("Mechanism")),
        count((info) => info.name === "Squire"),
        count((info) => info.name === "Healer" || info.name === "Angel"),
        mean((info) => info.initiative / 10),
        mean((info) => info.armor / 10),
        mean((info) => Math.min(4, info.hp / Math.max(1, info.exp)) / 4),
        mean((info) => Math.min(2, info.maxDamage / Math.max(1, info.exp)) / 2),
        mean((info) => (info.movementSteps ?? 0) / 10),
        ...[4, 1, 2, 3].map((faction) => count((info) => info.faction === faction)),
    ];
}

/** Opponent setup, stack amounts, positions and artifacts never enter this feature contract. */
export function empowerContextFeatures(
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
): number[] | undefined {
    if (
        !empowerSetupFeatures(budget, own) ||
        context?.decisionPhase !== "placement" ||
        context.opponentRosterVisibility !== "complete" ||
        context.ownDoctrine === undefined ||
        ![1, 2, 3].includes(context.ownDoctrine) ||
        getUpgradePoints(context.ownDoctrine) !== budget ||
        context.gridSize !== 16 ||
        ![1, 3, 4].includes(context.gridType) ||
        context.ownArtifactIds?.length !== 2 ||
        !T1.includes(context.ownArtifactIds[0]) ||
        !T2.includes(context.ownArtifactIds[1])
    )
        return undefined;
    const enemy = context.publicOpponentCreatureIds;
    if (
        enemy.length !== 6 ||
        new Set(enemy).size !== 6 ||
        enemy.some((id) => !Number.isSafeInteger(id) || !creatureInfo(id)) ||
        enemy
            .map((id) => CreatureLevels[id])
            .sort()
            .join(",") !== "1,1,2,2,3,4"
    )
        return undefined;
    const a = summary(own),
        b = summary(enemy);
    return [
        ...[5, 6, 7].map((value) => Number(budget === value)),
        ...[1, 3, 4].map((map) => Number(context.gridType === map)),
        ...IDS.map((id) => Number(own.includes(id))),
        ...IDS.map((id) => Number(enemy.includes(id))),
        ...T1.map((id) => Number(context.ownArtifactIds![0] === id)),
        ...T2.map((id) => Number(context.ownArtifactIds![1] === id)),
        ...a,
        ...b,
        ...[5, 6, 7].flatMap((value) => a.slice(0, 10).map((x) => (budget === value ? x : 0))),
        (a[1] + a[2]) * b[6],
        (a[1] + a[2]) * b[7],
        (a[1] + a[2]) * b[8],
        a[0] * b[11],
        a[4] * b[5],
        a[1] * b[5],
        a[10] - b[10],
        a[14] - b[14],
    ];
}

export type EmpowerEffectTree =
    { value: number } | { feature: number; threshold: number; left: EmpowerEffectTree; right: EmpowerEffectTree };
export interface IContextualEmpowerModel {
    schema: typeof EMPOWER_CONTEXT_SCHEMA;
    features: readonly string[];
    margin: number;
    estimator:
        { kind: "ridge"; b: number; w: readonly number[] } | { kind: "forest"; trees: readonly EmpowerEffectTree[] };
}

export function validateContextualEmpowerModel(model: IContextualEmpowerModel): void {
    if (
        model.schema !== EMPOWER_CONTEXT_SCHEMA ||
        model.features.join("\n") !== EMPOWER_CONTEXT_FEATURES.join("\n") ||
        !Number.isFinite(model.margin) ||
        model.margin < 0 ||
        model.margin > 1
    )
        throw new Error("Invalid contextual Empower model");
    const estimator = model.estimator;
    if (estimator.kind === "ridge") {
        if (
            !Number.isFinite(estimator.b) ||
            estimator.w.length !== model.features.length ||
            estimator.w.some((x) => !Number.isFinite(x))
        )
            throw new Error("Invalid contextual Empower ridge weights");
        return;
    }
    const check = (tree: EmpowerEffectTree, depth: number): void => {
        if (depth > 8) throw new Error("Contextual Empower tree exceeds its maximum depth");
        if ("value" in tree) {
            if (!Number.isFinite(tree.value)) throw new Error("Invalid contextual Empower leaf");
        } else {
            if (
                !Number.isInteger(tree.feature) ||
                tree.feature < 0 ||
                tree.feature >= model.features.length ||
                !Number.isFinite(tree.threshold)
            )
                throw new Error("Invalid contextual Empower split");
            check(tree.left, depth + 1);
            check(tree.right, depth + 1);
        }
    };
    if (estimator.kind !== "forest" || !estimator.trees.length || estimator.trees.length > 128)
        throw new Error("Invalid contextual Empower forest");
    for (const tree of estimator.trees) check(tree, 0);
}

export function predictContextualEmpower(model: IContextualEmpowerModel, features: readonly number[]): number {
    if (features.length !== EMPOWER_CONTEXT_FEATURES.length || features.some((x) => !Number.isFinite(x)))
        throw new Error("Invalid contextual Empower feature row");
    const estimator = model.estimator;
    if (estimator.kind === "ridge")
        return estimator.b + estimator.w.reduce((sum, value, i) => sum + value * features[i], 0);
    return (
        estimator.trees.reduce((sum, tree) => {
            let node = tree;
            while (!("value" in node)) node = features[node.feature] <= node.threshold ? node.left : node.right;
            return sum + node.value;
        }, 0) / estimator.trees.length
    );
}

export function selectContextualEmpower(
    model: IContextualEmpowerModel,
    budget: number,
    own: readonly number[],
    context: Readonly<IPlacementSetupDecisionContext> | undefined,
): 0 | 1 {
    const features = empowerContextFeatures(budget, own, context);
    return features && predictContextualEmpower(model, features) > model.margin ? 1 : 0;
}
