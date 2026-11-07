/** Offline outcome-trained scouting head. Importing this module never changes a shipped policy. */
import { PBTypes } from "../../generated/protobuf/v1/types";
import { creatureInfo } from "../../ai/setup/creature_score";
import { draftCreatureCoherenceAffinity } from "../../ai/setup/draft_coherence";
import {
    draftContextAfterCreature,
    draftCreatureContinuation,
    draftFactionContinuations,
    draftFutureSlots,
} from "../../ai/setup/draft_continuations";
import { rankedDraftStrengthV4LiftPp, rankedDraftUnitSynergyLiftPp } from "../../ai/setup/draft_strength_prior";
import type { IDraftScoutingContext } from "../../picks/draft_visibility";
import { CreatureLevelList } from "../../units/unit_properties";
import type { IDoctrineDraftContext as IRankedDraftResearchContext } from "../../ai/setup/doctrine_draft_policy";

export const DOCTRINE_DRAFT_FEATURES = [
    "spymaster_intercept",
    "scout_intercept",
    "bundle_intercept",
    "unit_strength_difference",
    "public_build_fit_difference",
    "hazard_flyers_difference",
    "native_terrain_difference",
    "hazard_slow_melee_difference",
    "block_flyers_difference",
    "block_large_melee_difference",
    "map_residual_difference",
    "advance_bans_blocked_factions_difference",
    "advance_bans_future_build_fit_difference",
    "advance_bans_ranged_capacity_difference",
] as const;

export const DOCTRINE_DRAFT_V2_FEATURES = [...DOCTRINE_DRAFT_FEATURES, "level_3_intercept"] as const;
const draftCreatures = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))].sort((a, b) => a - b);
export const DOCTRINE_DRAFT_V3_FEATURES = [
    ...DOCTRINE_DRAFT_V2_FEATURES,
    ...draftCreatures.map((id) => `unit_${id}_difference`),
    "advance_bans_four_ranged_capacity_difference",
    "advance_bans_faction_partner_strength_difference",
] as const;
const rankedMaps = [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER];
const factions = [1, 2, 3, 4];
const thresholds = [2, 4, 6];
export const DOCTRINE_DRAFT_V4_FEATURES = [
    ...DOCTRINE_DRAFT_V3_FEATURES,
    ...rankedMaps.flatMap((map) => draftCreatures.map((id) => `visible_map_${map}_unit_${id}_difference`)),
    ...factions.flatMap((faction) => thresholds.map((count) => `faction_${faction}_threshold_${count}_difference`)),
    ...factions.flatMap((faction) =>
        thresholds.map((count) => `advance_bans_faction_${faction}_threshold_${count}_reach_difference`),
    ),
] as const;
export type DoctrineDraftModelVersion = "v1" | "v2" | "v3" | "v4";
const featureNames = (version: DoctrineDraftModelVersion): readonly string[] =>
    version === "v4"
        ? DOCTRINE_DRAFT_V4_FEATURES
        : version === "v3"
          ? DOCTRINE_DRAFT_V3_FEATURES
          : version === "v2"
            ? DOCTRINE_DRAFT_V2_FEATURES
            : DOCTRINE_DRAFT_FEATURES;

export type ScoutingDoctrine = "see-all" | "three-reveals" | "see-none";
export interface IDoctrineDraftChoice {
    readonly creatureIds: readonly number[];
    readonly tier1ArtifactId?: number;
}
export interface IDoctrineDraftExample {
    readonly board: number;
    readonly features: readonly number[];
    /** Mean alternative score minus current-policy score, over both battle seats. */
    readonly gain: number;
}
export interface IDoctrineDraftModel {
    readonly schema: `hoc.ai.v0_9.doctrine_draft.${DoctrineDraftModelVersion}`;
    readonly features: readonly string[];
    readonly weights: readonly number[];
    readonly scales: readonly number[];
    readonly optimizerSteps: number;
    readonly examples: number;
    readonly initialLoss: number;
    readonly finalLoss: number;
    readonly switchMargin: number;
    readonly productionPromotion: false;
}

/** Remove only advance scouting. Own doctrine, budgets and public opponent picks are unchanged. */
export function delayedDoctrineScouting(scouting: IDraftScoutingContext, level: number): IDraftScoutingContext {
    return {
        ...scouting,
        ...(level < 3 ? { map: undefined } : {}),
        knownBanLevels: scouting.knownBanLevels.filter((entry) => entry <= level),
        bannedCreatureIds: scouting.bannedCreatureIds.filter((id) => (creatureInfo(id)?.level ?? 0) <= level),
    };
}

function continuationFeatures(
    roster: readonly number[],
    context: IRankedDraftResearchContext,
    scouting: IDraftScoutingContext,
    artifact: number | undefined,
    includeQuality: boolean,
): number[] {
    const paths = draftFactionContinuations(roster, context.knownOpponentCreatureIds, scouting);
    const blocked = paths.filter((path) => path.count % 2 === 1 && !path.reachable).length;
    const ranged = draftCreatureContinuation(roster, context.knownOpponentCreatureIds, scouting, (unit) => unit.ranged);
    const slots = draftFutureSlots(roster, context.knownOpponentCreatureIds, scouting);
    const fit = slots.reduce((sum, slot) => {
        const best = Math.max(
            0,
            ...slot.creatureIds.map((id) =>
                draftCreatureCoherenceAffinity(id, {
                    ownCreatureIds: roster,
                    knownOpponentCreatureIds: context.knownOpponentCreatureIds,
                    tier1ArtifactId: artifact,
                    artifactFitVersion: context.artifactFitVersion,
                }),
            ),
        );
        return sum + best * slot.count;
    }, 0);
    const features = [
        blocked,
        fit / Math.max(1, scouting.remainingPickLevels.length),
        Math.min(2, ranged.maximumCount),
    ];
    if (includeQuality) {
        const partnerStrength = paths
            .filter((path) => path.count % 2 === 1)
            .reduce(
                (sum, path) =>
                    sum + Math.max(0, ...path.creatureIds.map((id) => 10 + rankedDraftStrengthV4LiftPp(id) / 10)),
                0,
            );
        features.push(Math.min(4, ranged.maximumCount), partnerStrength);
    }
    return features;
}

function choiceFeatures(
    context: IRankedDraftResearchContext,
    choice: IDoctrineDraftChoice,
    level: number,
    version: DoctrineDraftModelVersion,
): number[] {
    const added = choice.creatureIds.flatMap((id) => creatureInfo(id) ?? []);
    const roster = [...context.ownCreatureIds, ...choice.creatureIds];
    // Bundles supply two starter units, not either of the future level-1/level-2 pick slots.
    const scouting =
        level === 0 ? context.scouting : choice.creatureIds.reduce(draftContextAfterCreature, context.scouting);
    const artifact = choice.tier1ArtifactId ?? context.tier1ArtifactId;
    const includeQuality = version === "v3" || version === "v4";
    const full = continuationFeatures(roster, context, scouting, artifact, includeQuality);
    const delayed = continuationFeatures(
        roster,
        context,
        delayedDoctrineScouting(scouting, level),
        artifact,
        includeQuality,
    );
    const map = context.scouting.map;
    const hazard = map === PBTypes.GridVals.LAVA_CENTER || map === PBTypes.GridVals.WATER_CENTER;
    const block = map === PBTypes.GridVals.BLOCK_CENTER;
    return [
        added.reduce((sum, unit) => sum + rankedDraftStrengthV4LiftPp(unit.id), 0) / 10,
        added.reduce(
            (sum, unit) =>
                sum +
                draftCreatureCoherenceAffinity(unit.id, {
                    ownCreatureIds: context.ownCreatureIds,
                    knownOpponentCreatureIds: context.knownOpponentCreatureIds,
                    tier1ArtifactId: artifact,
                    artifactFitVersion: context.artifactFitVersion,
                }),
            0,
        ),
        hazard ? added.filter((unit) => unit.canFly).length : 0,
        added.filter(
            (unit) =>
                (map === PBTypes.GridVals.LAVA_CENTER && unit.abilities.includes("Made of Fire")) ||
                (map === PBTypes.GridVals.WATER_CENTER && unit.abilities.includes("Made of Water")),
        ).length,
        hazard
            ? added.reduce(
                  (sum, unit) => sum + (unit.melee && !unit.canFly ? 1 / Math.max(1, unit.movementSteps ?? 4) : 0),
                  0,
              )
            : 0,
        block ? added.filter((unit) => unit.canFly).length : 0,
        block
            ? added.filter((unit) => unit.melee && !unit.canFly && unit.footprintWidth * unit.footprintHeight > 1)
                  .length
            : 0,
        map === undefined
            ? 0
            : added.reduce(
                  (sum, unit) =>
                      sum +
                      Math.max(
                          -10,
                          Math.min(
                              10,
                              rankedDraftUnitSynergyLiftPp(unit.id, map) - rankedDraftUnitSynergyLiftPp(unit.id),
                          ),
                      ),
                  0,
              ) / 10,
        ...full.map((value, index) => value - delayed[index]),
    ];
}

function contextualChoiceFeatures(
    context: IRankedDraftResearchContext,
    choice: IDoctrineDraftChoice,
    level: number,
): number[] {
    const roster = [...context.ownCreatureIds, ...choice.creatureIds];
    const scouting =
        level === 0 ? context.scouting : choice.creatureIds.reduce(draftContextAfterCreature, context.scouting);
    const delayed = delayedDoctrineScouting(scouting, level);
    const paths = factions.map((faction) => ({
        full: draftCreatureContinuation(
            roster,
            context.knownOpponentCreatureIds,
            scouting,
            (unit) => unit.faction === faction,
        ),
        delayed: draftCreatureContinuation(
            roster,
            context.knownOpponentCreatureIds,
            delayed,
            (unit) => unit.faction === faction,
        ),
    }));
    return [
        ...rankedMaps.flatMap((map) =>
            draftCreatures.map((id) => Number(context.scouting.map === map && choice.creatureIds.includes(id))),
        ),
        ...paths.flatMap((path) => thresholds.map((count) => Number(path.full.count >= count))),
        ...paths.flatMap((path) =>
            thresholds.map(
                (count) => Number(path.full.maximumCount >= count) - Number(path.delayed.maximumCount >= count),
            ),
        ),
    ];
}

/** Context is already projected by the pick reducer. No state, RNG, hidden ban or future offer is accepted. */
export function doctrineDraftFeatures(
    doctrine: ScoutingDoctrine,
    context: IRankedDraftResearchContext,
    preferred: IDoctrineDraftChoice,
    alternative: IDoctrineDraftChoice,
    level: number,
    maskAdvanceInformation = false,
    version: DoctrineDraftModelVersion = "v1",
): number[] | undefined {
    if (doctrine === "see-none" || level > (version === "v1" ? 2 : 3)) return undefined;
    if (!Number.isInteger(level) || level < 0) throw new Error("Invalid scouting decision level");
    const visible = maskAdvanceInformation
        ? { ...context, scouting: delayedDoctrineScouting(context.scouting, level) }
        : context;
    const base = choiceFeatures(visible, preferred, level, version);
    const other = choiceFeatures(visible, alternative, level, version);
    const difference = other.map((value, index) => value - base[index]);
    const contextualBase = version === "v4" ? contextualChoiceFeatures(visible, preferred, level) : [];
    const contextualOther = version === "v4" ? contextualChoiceFeatures(visible, alternative, level) : [];
    // These three indicators and the public strength/build features survive the information ablation.
    // This prevents 'turn the new policy off' from masquerading as a causal information comparison.
    return [
        Number(doctrine === "see-all"),
        Number(doctrine === "three-reveals"),
        Number(level === 0),
        ...difference.slice(0, 11),
        ...(version !== "v1" ? [Number(level === 3)] : []),
        ...(version === "v3" || version === "v4"
            ? [
                  ...draftCreatures.map(
                      (id) => Number(alternative.creatureIds.includes(id)) - Number(preferred.creatureIds.includes(id)),
                  ),
                  ...difference.slice(11),
              ]
            : []),
        ...contextualOther.map((value, index) => value - contextualBase[index]),
    ];
}

function validateFeatures(features: readonly number[], version: DoctrineDraftModelVersion): void {
    if (features.length !== featureNames(version).length || !features.every(Number.isFinite))
        throw new Error("Invalid doctrine draft feature vector");
}

export function predictDoctrineDraftGain(model: IDoctrineDraftModel, features: readonly number[]): number {
    const version =
        model.schema === "hoc.ai.v0_9.doctrine_draft.v4"
            ? "v4"
            : model.schema === "hoc.ai.v0_9.doctrine_draft.v3"
              ? "v3"
              : model.schema === "hoc.ai.v0_9.doctrine_draft.v2"
                ? "v2"
                : "v1";
    validateFeatures(features, version);
    if (
        model.schema !== `hoc.ai.v0_9.doctrine_draft.${version}` ||
        model.features.join("|") !== featureNames(version).join("|") ||
        model.weights.length !== features.length ||
        model.scales.length !== features.length ||
        !model.weights.every(Number.isFinite) ||
        !model.scales.every((scale) => Number.isFinite(scale) && scale >= 0.1)
    )
        throw new Error("Invalid doctrine draft model");
    return features.reduce((sum, value, index) => sum + (value / model.scales[index]) * model.weights[index], 0);
}

/** Fixed full-batch Adam fit to counterfactual battle outcomes; held-out rows never enter this function. */
export function fitDoctrineDraftModel(
    examples: readonly IDoctrineDraftExample[],
    version: DoctrineDraftModelVersion = "v1",
    warmStart?: IDoctrineDraftModel,
): IDoctrineDraftModel {
    if (version === "v4") {
        if (!warmStart || warmStart.schema !== "hoc.ai.v0_9.doctrine_draft.v3")
            throw new Error("V4 training requires the locked V3 starting model");
        predictDoctrineDraftGain(warmStart, new Array<number>(DOCTRINE_DRAFT_V3_FEATURES.length).fill(0));
    } else if (warmStart) throw new Error("Legacy model fitting does not accept a starting model");
    if (!examples.length) throw new Error("No counterfactual training examples");
    for (const example of examples) {
        validateFeatures(example.features, version);
        if (
            !Number.isSafeInteger(example.board) ||
            example.board < 0 ||
            !Number.isFinite(example.gain) ||
            Math.abs(example.gain) > 1
        )
            throw new Error("Invalid counterfactual training outcome");
    }
    const names = featureNames(version);
    const size = names.length;
    const scales = Array.from({ length: size }, (_, index) =>
        Math.max(0.1, Math.sqrt(examples.reduce((sum, row) => sum + row.features[index] ** 2, 0) / examples.length)),
    );
    const rows = examples.map((row) => ({ x: row.features.map((value, index) => value / scales[index]), y: row.gain }));
    const weights = new Array<number>(size).fill(0);
    if (warmStart)
        warmStart.weights.forEach((weight, index) => {
            weights[index] = (weight / warmStart.scales[index]) * scales[index];
        });
    const first = new Array<number>(size).fill(0),
        second = new Array<number>(size).fill(0);
    const loss = () =>
        rows.reduce(
            (sum, row) => sum + (row.x.reduce((value, x, index) => value + x * weights[index], 0) - row.y) ** 2,
            0,
        ) / rows.length;
    const initialLoss = loss();
    const optimizerSteps = 2_000;
    for (let step = 1; step <= optimizerSteps; step++) {
        const gradient = weights.map((weight) => 0.04 * weight);
        for (const row of rows) {
            const error = row.x.reduce((sum, x, index) => sum + x * weights[index], 0) - row.y;
            row.x.forEach((x, index) => {
                gradient[index] += (2 * error * x) / rows.length;
            });
        }
        for (let index = 0; index < size; index++) {
            first[index] = 0.9 * first[index] + 0.1 * gradient[index];
            second[index] = 0.999 * second[index] + 0.001 * gradient[index] ** 2;
            weights[index] -=
                (0.03 * (first[index] / (1 - 0.9 ** step))) / (Math.sqrt(second[index] / (1 - 0.999 ** step)) + 1e-8);
        }
    }
    return {
        schema: `hoc.ai.v0_9.doctrine_draft.${version}`,
        features: names,
        weights,
        scales,
        optimizerSteps,
        examples: examples.length,
        initialLoss,
        finalLoss: loss(),
        switchMargin: 0.02,
        productionPromotion: false,
    };
}
