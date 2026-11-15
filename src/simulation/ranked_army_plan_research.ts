/** Offline, legal-information artifact/final-pick planning. Never imported by a serving default. */
import { creatureInfo, type ICreatureInfo } from "../ai/setup/creature_score";
import { draftSynergyEffects, DRAFT_BATTLEFIELD_FACTIONS } from "../ai/setup/draft_battlefield_context";
import { tier1ArtifactFitScoreV4, tier2ArtifactFitScoreV6 } from "../ai/setup/artifact_fit";
import type { RankedDraftSynergyVariants } from "../ai/setup/draft_synergy_variants";
import { createTier2ArtifactDecisionContext, TIER1_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import {
    ARTIFACT_POWER,
    TIER1_ARTIFACT_LIST,
    TIER2_ARTIFACT_LIST,
    Tier1Artifact,
    Tier2Artifact,
} from "../artifacts/artifact_properties";
import { Doctrine, getUpgradePoints } from "../doctrines/doctrine_properties";
import { CreatureLevelList } from "../units/unit_properties";

export const ARMY_PLAN_SCHEMA = "hoc.ranked-army-plan.v1";
export const ARMY_PLAN_MARGIN = 0.03;
const IDS = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))].sort((a, b) => a - b);
const T1 = TIER1_ARTIFACT_LIST.map((artifact) => artifact.id).sort((a, b) => a - b);
const T2 = TIER2_ARTIFACT_LIST.map((artifact) => artifact.id).sort((a, b) => a - b);
const ROLES = ["ranged", "melee", "flying", "magicDamage", "spellbook", "buff", "aura", "large"] as const;
const EFFECTS = [
    "movement",
    "boardUnits",
    "auraRange",
    "flyArmor",
    "abilityPower",
    "supply",
    "morale",
    "luck",
    "breakChance",
] as const;

export interface IArmyPlanContext {
    readonly ownCreatureIds: readonly number[];
    /** Exact current reveal projection. Unknown slots are represented separately, never filled from the seed. */
    readonly knownOpponentCreatureIds: readonly number[];
    readonly ownDoctrine: number;
    readonly tier1ArtifactId?: number;
    readonly map?: number;
    readonly synergyVariants: RankedDraftSynergyVariants;
}

export interface IArmyPlanChoice {
    readonly artifactId: number;
    /** Only a legal currently visible final-pick alternative. Absent at the earlier artifact decision. */
    readonly creatureId?: number;
}

const PROFILE_NAMES = [
    ...IDS.map((id) => `own:${id}`),
    ...ROLES.map((name) => `ownRole:${name}`),
    ...T1.flatMap((id) => ROLES.map((name) => `tier1:${id}:${name}`)),
    ...T2.map((id) => `tier2:${id}`),
    ...T2.flatMap((id) => ROLES.map((name) => `tier2:${id}:${name}`)),
    ...T2.flatMap((id) => ROLES.map((name) => `tier2:${id}:knownEnemy:${name}`)),
    ...ROLES.flatMap((own) => ROLES.map((enemy) => `matchup:${own}:${enemy}`)),
    ...[5, 6, 7].flatMap((budget) => ROLES.map((name) => `budget:${budget}:${name}`)),
    ...[1, 3, 4].flatMap((map) => ROLES.map((name) => `map:${map}:${name}`)),
    ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction) => [1, 2, 3].map((level) => `threshold:${faction}:${level}`)),
    ...EFFECTS.map((name) => `ownEffect:${name}`),
    "tier1Fit",
    "tier2Fit",
    "magicAmplification",
    "rangedContactPressure",
    "casterContactPressure",
    "enemyMagicAgainstImmune",
    "friendlyMagicAgainstKnownImmune",
    "movementMelee",
    "boardUnitsSupport",
    "auraCoverage",
    "flyingArmor",
    "attackDensity",
    "healthDensity",
    "initiative",
    "steps",
    "unknownEnemyRanged",
    "unknownEnemyMagic",
    "unrevealedMapRanged",
] as const;

export const ARMY_PLAN_FEATURE_NAMES = [
    "bias",
    "artifactPhase",
    "creaturePhase",
    "doctrine:1",
    "doctrine:2",
    "doctrine:3",
    "knownEnemyShare",
    ...PROFILE_NAMES.map((name) => `difference:${name}`),
] as const;

const roles = (units: readonly ICreatureInfo[]): number[] => [
    units.filter((u) => u.ranged).length / 6,
    units.filter((u) => u.melee && !u.ranged).length / 6,
    units.filter((u) => u.canFly).length / 6,
    units.filter((u) => u.dealsMagicDamage).length / 6,
    units.filter((u) => u.nativeSpellbook).length / 6,
    units.filter((u) => u.castsAmplifiableBuff).length / 6,
    units.reduce((sum, u) => sum + u.auraCount, 0) / 12,
    units.filter((u) => u.footprintWidth * u.footprintHeight > 1).length / 6,
];

function validate(context: IArmyPlanContext, choice: IArmyPlanChoice): void {
    for (const ids of [context.ownCreatureIds, context.knownOpponentCreatureIds]) {
        if (
            ids.length > 6 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !Number.isSafeInteger(id) || !creatureInfo(id))
        )
            throw new Error("Army-plan input has an invalid legal roster projection");
    }
    if (
        ![Doctrine.THREE_REVEALS, Doctrine.SEE_ALL, Doctrine.SEE_NONE].includes(context.ownDoctrine) ||
        DRAFT_BATTLEFIELD_FACTIONS.some((faction) => ![1, 2].includes(context.synergyVariants[faction])) ||
        (context.map !== undefined && ![1, 3, 4].includes(context.map)) ||
        (context.tier1ArtifactId !== undefined && !T1.includes(context.tier1ArtifactId)) ||
        !T2.includes(choice.artifactId)
    )
        throw new Error("Invalid army-plan public context or artifact");
    if (
        choice.creatureId !== undefined &&
        (context.ownCreatureIds.length !== 5 ||
            !CreatureLevelList[4].includes(choice.creatureId) ||
            context.ownCreatureIds.includes(choice.creatureId) ||
            context.knownOpponentCreatureIds.includes(choice.creatureId))
    )
        throw new Error("Army-plan final choice must be a new legal level-four identity");
    if (choice.creatureId === undefined && context.ownCreatureIds.length !== 5)
        throw new Error("Army-plan artifact choice precedes the final creature pick");
}

function profile(context: IArmyPlanContext, choice: IArmyPlanChoice): number[] {
    validate(context, choice);
    const ids = [...context.ownCreatureIds, ...(choice.creatureId === undefined ? [] : [choice.creatureId])];
    const units = ids.map((id) => creatureInfo(id)!);
    const enemies = context.knownOpponentCreatureIds.map((id) => creatureInfo(id)!);
    const own = roles(units),
        enemy = roles(enemies);
    const effects = draftSynergyEffects(ids, context.synergyVariants);
    const enemyEffects = draftSynergyEffects(context.knownOpponentCreatureIds, context.synergyVariants);
    const artifactContext = createTier2ArtifactDecisionContext({
        publicOpponentCreatureIds: context.knownOpponentCreatureIds,
        ownDoctrine: context.ownDoctrine,
        ...(context.map === undefined ? {} : { gridType: context.map, gridSize: 16 }),
        ownArtifactIds: context.tier1ArtifactId === undefined ? [] : [context.tier1ArtifactId],
    });
    const pressure =
        enemies.reduce(
            (sum, u) => sum + (u.melee ? (((u.movementSteps ?? 0) + enemyEffects.movement) * u.initiative) / 100 : 0),
            0,
        ) / 6;
    const magicBoost =
        (context.tier1ArtifactId === Tier1Artifact.MAGES_RING ? ARTIFACT_POWER.MAGES_RING_MAGIC_PERCENT : 0) +
        (choice.artifactId === Tier2Artifact.ARCHMAGES_RING ? ARTIFACT_POWER.ARCHMAGES_RING_MAGIC_PERCENT : 0);
    const value = [
        ...IDS.map((id) => Number(ids.includes(id))),
        ...own,
        ...T1.flatMap((id) => own.map((value) => (context.tier1ArtifactId === id ? value : 0))),
        ...T2.map((id) => Number(choice.artifactId === id)),
        ...T2.flatMap((id) => own.map((value) => (choice.artifactId === id ? value : 0))),
        ...T2.flatMap((id) => enemy.map((value) => (choice.artifactId === id ? value : 0))),
        ...own.flatMap((a) => enemy.map((b) => a * b)),
        ...[5, 6, 7].flatMap((budget) =>
            own.map((value) => (getUpgradePoints(context.ownDoctrine) === budget ? value : 0)),
        ),
        ...[1, 3, 4].flatMap((map) => own.map((value) => (context.map === map ? value : 0))),
        ...effects.levels.flatMap((level) => [1, 2, 3].map((threshold) => Number(level >= threshold))),
        ...EFFECTS.map((name) => effects[name] / 35),
        context.tier1ArtifactId === undefined
            ? 0
            : tier1ArtifactFitScoreV4(
                  context.tier1ArtifactId,
                  ids,
                  TIER1_ARTIFACT_WINRATE[context.tier1ArtifactId] ?? 50,
              ) / 100,
        tier2ArtifactFitScoreV6(choice.artifactId, ids, artifactContext) / 100,
        (magicBoost * own[3]) / 100,
        pressure * own[0],
        pressure * own[4],
        (enemy[3] * units.filter((u) => u.magicImmune).length) / 6,
        (own[3] * enemies.filter((u) => u.magicImmune).length) / 6,
        (effects.movement * own[1]) / 3,
        (effects.boardUnits * (own[4] + own[5] + own[6])) / 4,
        (effects.auraRange * own[6]) / 3,
        (effects.flyArmor * own[2]) / 35,
        units.reduce((sum, u) => sum + u.maxDamage / Math.max(1, u.exp), 0) / 6,
        units.reduce((sum, u) => sum + u.hp / Math.max(1, u.exp), 0) / 6,
        units.reduce((sum, u) => sum + u.initiative, 0) / 60,
        units.reduce((sum, u) => sum + (u.movementSteps ?? 0), 0) / 60,
        (1 - enemies.length / 6) * own[0],
        (1 - enemies.length / 6) * own[3],
        context.map === undefined ? own[0] : 0,
    ];
    if (value.length !== PROFILE_NAMES.length || value.some((x) => !Number.isFinite(x)))
        throw new Error("Invalid army-plan feature profile");
    return value;
}

/** Potential artifact fit uses legal identities, never unknown enemy units, future outcomes or formations. */
export function armyPlanFeatures(
    context: IArmyPlanContext,
    incumbent: IArmyPlanChoice,
    alternative: IArmyPlanChoice,
): number[] {
    if ((incumbent.creatureId === undefined) !== (alternative.creatureId === undefined))
        throw new Error("Army-plan comparison crosses decision phases");
    if (incumbent.creatureId !== undefined && incumbent.artifactId !== alternative.artifactId)
        throw new Error("A final pick cannot change an already committed artifact");
    const before = profile(context, incumbent),
        after = profile(context, alternative);
    return [
        1,
        Number(incumbent.creatureId === undefined),
        Number(incumbent.creatureId !== undefined),
        ...[1, 2, 3].map((id) => Number(context.ownDoctrine === id)),
        context.knownOpponentCreatureIds.length / 6,
        ...after.map((value, i) => value - before[i]),
    ];
}

export interface IArmyPlanModel {
    readonly schema: typeof ARMY_PLAN_SCHEMA;
    readonly featureNames: readonly string[];
    readonly artifactWeights: readonly number[];
    readonly creatureWeights: readonly number[];
    readonly margin: typeof ARMY_PLAN_MARGIN;
    readonly lambda: number;
    readonly productionPromotion: false;
}

export function validateArmyPlanModel(model: IArmyPlanModel): void {
    if (
        model.schema !== ARMY_PLAN_SCHEMA ||
        model.productionPromotion !== false ||
        model.margin !== ARMY_PLAN_MARGIN ||
        model.featureNames.join("\n") !== ARMY_PLAN_FEATURE_NAMES.join("\n") ||
        ![1, 10, 100].includes(model.lambda) ||
        [model.artifactWeights, model.creatureWeights].some(
            (w) => w.length !== ARMY_PLAN_FEATURE_NAMES.length || w.some((x) => !Number.isFinite(x)),
        )
    )
        throw new Error("Invalid fixed army-plan model");
}

export function predictArmyPlan(
    model: IArmyPlanModel,
    kind: "artifact" | "creature",
    features: readonly number[],
): number {
    const weights = kind === "artifact" ? model.artifactWeights : model.creatureWeights;
    if (features.length !== ARMY_PLAN_FEATURE_NAMES.length || features.some((x) => !Number.isFinite(x)))
        throw new Error("Invalid army-plan inference vector");
    return features.reduce((sum, x, i) => sum + x * weights[i], 0);
}

/** Input order keeps incumbent at zero. Ties and non-finite values preserve the incumbent. */
export function armyPlanChoiceIndex(gains: readonly number[], margin = ARMY_PLAN_MARGIN): number {
    let best = 0;
    for (let index = 1; index < gains.length; index++) {
        if (Number.isFinite(gains[index]) && gains[index] > margin && (best === 0 || gains[index] > gains[best]))
            best = index;
    }
    return best;
}
