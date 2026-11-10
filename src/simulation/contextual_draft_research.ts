/** Outcome-trained map/synergy draft research. This module does not activate a serving policy. */
import { creatureInfo, type ICreatureInfo } from "../ai/setup/creature_score";
import {
    DRAFT_BATTLEFIELD_FACTIONS,
    draftBattlefieldSummary,
    validDraftBattlefieldContext,
    type IDraftBattlefieldContext,
} from "../ai/setup/draft_battlefield_context";
import { draftCreatureCoherenceAffinity } from "../ai/setup/draft_coherence";
import { tier1ArtifactFitScoreV4, tier1ArtifactFitScoreV7 } from "../ai/setup/artifact_fit";
import { TIER1_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import { draftContextAfterCreature } from "../ai/setup/draft_continuations";
import { rankedDraftStrengthV4LiftPp } from "../ai/setup/draft_strength_prior";
import { PBTypes } from "../generated/protobuf/v1/types";
import { CreatureLevelList } from "../units/unit_properties";
import type { IDoctrineDraftChoice } from "./v0_9/doctrine_draft_model";
import type { IRankedDraftResearchContext } from "./ranked_draft_eval";

export const CONTEXTUAL_DRAFT_SCHEMA = "hoc.contextual-draft.v1";
export const CONTEXTUAL_DRAFT_FEATURE_SCHEMA = "public-map-synergy-effects-v1";
const IDS = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))].sort((a, b) => a - b);
const ROLES = [
    "ranged",
    "melee",
    "flyer",
    "caster",
    "spellbook",
    "auras",
    "abilities",
    "slowMelee",
    "wideMelee",
] as const;
const MAPS = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
];
export const CONTEXTUAL_DRAFT_BASE_FEATURES = [
    "bias",
    ...[0, 1, 2, 3, 4].map((level) => `phase:${level}`),
    ...[5, 6, 7].map((budget) => `budget:${budget}`),
    ...IDS.map((id) => `unitDifference:${id}`),
    ...ROLES.map((role) => `roleDifference:${role}`),
    "strengthDifference",
    "buildFitDifference",
    "artifactFitDifference",
    "stepsDifference",
    "initiativeDifference",
    ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction) =>
        [1, 2, 3].map((level) => `thresholdDifference:${faction}:${level}`),
    ),
] as const;
export const CONTEXTUAL_DRAFT_CONTEXT_FEATURES = [
    ...MAPS.flatMap((map) => ROLES.map((role) => `visibleMap:${map}:${role}`)),
    "nativeTerrainDifference",
    ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction) =>
        [1, 2].flatMap((variant) => ROLES.map((role) => `availableVariant:${faction}:${variant}:${role}`)),
    ),
    ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction) =>
        [1, 2].flatMap((variant) => ["level", "reachableLevel"].map((name) => `synergy:${faction}:${variant}:${name}`)),
    ),
    "ownMovementMelee",
    "ownBoardUnitsSpellbooks",
    "ownBoardUnitsAuras",
    "ownBoardUnitsRanged",
    "ownFlyArmorFlyers",
    "ownAuraRangeCarriers",
    "ownAbilityPowerCarriers",
    "ownSupply",
    "ownMorale",
    "ownLuck",
    "ownBreak",
    "enemyMovementAgainstRanged",
    "enemyMovementAgainstCasters",
    "enemyAuraNullAgainstRanged",
    "enemyFlyArmorAgainstMelee",
    "enemyKnownInitiativeAgainstRanged",
] as const;
export const CONTEXTUAL_DRAFT_FEATURE_NAMES = [
    ...CONTEXTUAL_DRAFT_BASE_FEATURES,
    ...CONTEXTUAL_DRAFT_CONTEXT_FEATURES,
] as const;

export interface IContextualDraftContext extends IRankedDraftResearchContext, IDraftBattlefieldContext {
    readonly budget: number;
}
export interface IContextualDraftModel {
    readonly schema: typeof CONTEXTUAL_DRAFT_SCHEMA;
    readonly featureSchema: typeof CONTEXTUAL_DRAFT_FEATURE_SCHEMA;
    readonly features: readonly string[];
    readonly weights: readonly number[];
    readonly margin: number;
    readonly information: "full" | "without-map-synergies";
    readonly productionPromotion: false;
}

function roles(units: readonly ICreatureInfo[]): number[] {
    const count = (matches: (unit: ICreatureInfo) => boolean) => units.filter(matches).length / 6;
    return [
        count((u) => u.ranged),
        count((u) => u.melee && !u.ranged),
        count((u) => u.canFly),
        count((u) => u.caster),
        count((u) => u.nativeSpellbook),
        units.reduce((sum, u) => sum + u.auraCount, 0) / 12,
        units.reduce((sum, u) => sum + u.abilityCount, 0) / 24,
        count((u) => u.melee && !u.canFly && (u.movementSteps ?? 0) <= 4),
        count((u) => u.melee && !u.canFly && u.footprintWidth * u.footprintHeight > 1),
    ];
}

function choiceProfile(context: IContextualDraftContext, choice: IDoctrineDraftChoice, level: number) {
    const ids = [...context.ownCreatureIds, ...choice.creatureIds];
    const scouting =
        level === 0 ? context.scouting : choice.creatureIds.reduce(draftContextAfterCreature, context.scouting);
    const after = { ...context, ownCreatureIds: ids, scouting };
    if (!validDraftBattlefieldContext(after)) return undefined;
    const units = ids.map((id) => creatureInfo(id)!);
    const ownRoles = roles(units);
    const summary = draftBattlefieldSummary(after);
    const own = summary.own,
        enemy = summary.publicEnemyMinimum;
    // Baseline build fit intentionally has no map or synergy argument: the ablation cannot read them indirectly.
    const artifact = choice.tier1ArtifactId ?? context.tier1ArtifactId;
    const base = [
        ...IDS.map((id) => Number(ids.includes(id))),
        ...ownRoles,
        units.reduce((sum, u) => sum + rankedDraftStrengthV4LiftPp(u.id), 0) / 100,
        choice.creatureIds.reduce(
            (sum, id) =>
                sum +
                draftCreatureCoherenceAffinity(id, {
                    ownCreatureIds: context.ownCreatureIds,
                    knownOpponentCreatureIds: context.knownOpponentCreatureIds,
                    tier1ArtifactId: artifact,
                    artifactFitVersion: context.artifactFitVersion,
                }),
            0,
        ) / 6,
        artifact === undefined
            ? 0
            : (context.artifactFitVersion >= 7 ? tier1ArtifactFitScoreV7 : tier1ArtifactFitScoreV4)(
                  artifact,
                  ids,
                  TIER1_ARTIFACT_WINRATE[artifact] ?? 50,
              ) / 100,
        units.reduce((sum, u) => sum + (u.movementSteps ?? 0), 0) / 60,
        units.reduce((sum, u) => sum + u.initiative, 0) / 60,
        ...own.levels.flatMap((value) => [1, 2, 3].map((threshold) => Number(value >= threshold))),
    ];
    const enemyUnits = context.knownOpponentCreatureIds.map((id) => creatureInfo(id)!);
    const nullFields = enemyUnits.filter((u) => u.abilities.includes("Range Null Field")).length;
    const extended = [
        ...MAPS.flatMap((map) => ownRoles.map((value) => (context.scouting.map === map ? value : 0))),
        units.filter(
            (u) =>
                (context.scouting.map === PBTypes.GridVals.LAVA_CENTER && u.abilities.includes("Made of Fire")) ||
                (context.scouting.map === PBTypes.GridVals.WATER_CENTER && u.abilities.includes("Made of Water")),
        ).length / 6,
        ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction) =>
            [1, 2].flatMap((variant) =>
                ownRoles.map((value) => (context.synergyVariants[faction] === variant ? value : 0)),
            ),
        ),
        ...DRAFT_BATTLEFIELD_FACTIONS.flatMap((faction, index) =>
            [1, 2].flatMap((variant) =>
                context.synergyVariants[faction] === variant
                    ? [own.levels[index] / 3, summary.maximumReachableLevels[index] / 3]
                    : [0, 0],
            ),
        ),
        (own.movement * ownRoles[1]) / 3,
        (own.boardUnits * ownRoles[4]) / 4,
        (own.boardUnits * ownRoles[5]) / 4,
        (own.boardUnits * ownRoles[0]) / 4,
        (own.flyArmor * ownRoles[2]) / 35,
        (own.auraRange * ownRoles[5]) / 3,
        (own.abilityPower * ownRoles[6]) / 12,
        own.supply / 19,
        own.morale / 20,
        own.luck / 9,
        own.breakChance / 17,
        (enemy.movement * ownRoles[0]) / 3,
        (enemy.movement * ownRoles[3]) / 3,
        (enemy.auraRange * nullFields * ownRoles[0]) / 3,
        (enemy.flyArmor * ownRoles[1]) / 35,
        (enemyUnits.reduce((sum, u) => sum + u.initiative, 0) * ownRoles[0]) / 60,
    ];
    return { base, extended };
}

/** Differences between two legal offers using the acting seat's projection only. */
export function contextualDraftFeatures(
    context: IContextualDraftContext,
    preferred: IDoctrineDraftChoice,
    alternative: IDoctrineDraftChoice,
    level: number,
): number[] | undefined {
    if (
        !validDraftBattlefieldContext(context) ||
        ![5, 6, 7].includes(context.budget) ||
        !Number.isInteger(level) ||
        level < 0 ||
        level > 4
    )
        return undefined;
    if (
        [preferred, alternative].some(
            (choice) =>
                choice.creatureIds.length !== (level === 0 ? 2 : 1) ||
                choice.creatureIds.some((id) => !creatureInfo(id)),
        )
    )
        return undefined;
    const before = choiceProfile(context, preferred, level),
        after = choiceProfile(context, alternative, level);
    if (!before || !after) return undefined;
    return [
        1,
        ...[0, 1, 2, 3, 4].map((value) => Number(level === value)),
        ...[5, 6, 7].map((value) => Number(context.budget === value)),
        ...after.base.map((value, index) => value - before.base[index]),
        ...after.extended.map((value, index) => value - before.extended[index]),
    ];
}

export function validateContextualDraftModel(model: IContextualDraftModel): void {
    if (
        model.schema !== CONTEXTUAL_DRAFT_SCHEMA ||
        model.featureSchema !== CONTEXTUAL_DRAFT_FEATURE_SCHEMA ||
        model.productionPromotion !== false ||
        model.features.join("\n") !== CONTEXTUAL_DRAFT_FEATURE_NAMES.join("\n") ||
        !["full", "without-map-synergies"].includes(model.information) ||
        model.weights.length !== CONTEXTUAL_DRAFT_FEATURE_NAMES.length ||
        model.weights.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(model.margin) ||
        model.margin < 0 ||
        model.margin > 1
    )
        throw new Error("Invalid contextual draft model");
}

export function predictContextualDraft(model: IContextualDraftModel, features: readonly number[]): number {
    if (features.length !== CONTEXTUAL_DRAFT_FEATURE_NAMES.length || features.some((value) => !Number.isFinite(value)))
        throw new Error("Invalid contextual draft features");
    const count = model.information === "full" ? features.length : CONTEXTUAL_DRAFT_BASE_FEATURES.length;
    let score = 0;
    for (let index = 0; index < count; index++) score += features[index] * model.weights[index];
    return score;
}
