/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../../ai/setup/draft_ship";
import { parseConditionalRules } from "../../ai/setup/setup_conditional";
import { V07_NONFIGHT_BEHAVIOR_SHA256, V07_NONFIGHT_SETUP_SPEC, resolveSetupPolicy } from "../../ai/setup/setup_ship";
import { getUpgradePoints } from "../../perks/perk_properties";
import { SERVER_PERSISTED_CREATURE_ORDER } from "../../picks/pick_sim";
import { creatureIdForName } from "../draft";
import { runRankedConditionalPickGame, shippedLeagueGenome, type IConditionalArmy } from "../measure_setup_conditional";
import type { IMatchConfig } from "../battle_engine";

export const V08_ALIGNED_V1_PROJECTED_DRAFT_GENOME_SHA256 =
    "a68d0ebf1a46d82ec4f7782368f91ab4df3a1980e90638b9482e8924d87aeb6d" as const;
export const V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256 =
    "98ac28d146df40d37404b9425071b1ba7a6d63fb08867e28547a5b8aa92dc4d2" as const;

export interface IV08AlignedV1NonfightBinding {
    schemaVersion: 1;
    artifactKind: "v0_8_aligned_96h_v1_nonfight_binding";
    draftSpec: typeof LEAGUE_ROUND1_DRAFT_SPEC;
    draftProjection: "ranked-intrinsic-only-zero-interaction-heads";
    projectedDraftGenomeSha256: typeof V08_ALIGNED_V1_PROJECTED_DRAFT_GENOME_SHA256;
    setupSpec: typeof V07_NONFIGHT_SETUP_SPEC;
    setupBehaviorSha256: typeof V07_NONFIGHT_BEHAVIOR_SHA256;
    rankedCellMode: "full-ranked";
    fixedCellMode: "combat-template-no-artifacts";
    fixedArtifacts: { tier1: 0; tier2: 0 };
    setupPolicy: "deployed-v0.7-roster-conditioned";
    rankedCreatureOrder: typeof SERVER_PERSISTED_CREATURE_ORDER;
    opponentPlacement: "legitimate-reveal";
    candidatePlacementControl: "genome-placementReveal";
    placementAugmentTiming: "setup-before-placement";
    nonfightBindingSha256: typeof V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256;
}

const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, canonicalValue(child)]),
        );
    }
    return value;
};

const fingerprint = (value: unknown): string =>
    createHash("sha256")
        .update(JSON.stringify(canonicalValue(value)))
        .digest("hex");

const projectedDraft = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
const projectedDraftGenomeSha256 = fingerprint({
    artifactKind: "v0_8_aligned_96h_v1_projected_draft_genome",
    schemaVersion: projectedDraft.schemaVersion,
    id: projectedDraft.id,
    omniscientDraft: projectedDraft.omniscientDraft ?? false,
    weights: projectedDraft.weights,
});
if (projectedDraftGenomeSha256 !== V08_ALIGNED_V1_PROJECTED_DRAFT_GENOME_SHA256) {
    throw new Error("v0.8 aligned projected v0.7 draft genome drifted from its frozen fingerprint");
}

const unsignedNonfightBinding = {
    schemaVersion: 1 as const,
    artifactKind: "v0_8_aligned_96h_v1_nonfight_binding" as const,
    draftSpec: LEAGUE_ROUND1_DRAFT_SPEC as typeof LEAGUE_ROUND1_DRAFT_SPEC,
    draftProjection: "ranked-intrinsic-only-zero-interaction-heads" as const,
    projectedDraftGenomeSha256: V08_ALIGNED_V1_PROJECTED_DRAFT_GENOME_SHA256,
    setupSpec: V07_NONFIGHT_SETUP_SPEC as typeof V07_NONFIGHT_SETUP_SPEC,
    setupBehaviorSha256: V07_NONFIGHT_BEHAVIOR_SHA256 as typeof V07_NONFIGHT_BEHAVIOR_SHA256,
    rankedCellMode: "full-ranked" as const,
    fixedCellMode: "combat-template-no-artifacts" as const,
    fixedArtifacts: { tier1: 0 as const, tier2: 0 as const },
    setupPolicy: "deployed-v0.7-roster-conditioned" as const,
    rankedCreatureOrder: SERVER_PERSISTED_CREATURE_ORDER,
    opponentPlacement: "legitimate-reveal" as const,
    candidatePlacementControl: "genome-placementReveal" as const,
    placementAugmentTiming: "setup-before-placement" as const,
} as const;
if (fingerprint(unsignedNonfightBinding) !== V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256) {
    throw new Error("v0.8 aligned non-fight binding drifted from its frozen fingerprint");
}

export const V08_ALIGNED_V1_NONFIGHT_BINDING: Readonly<IV08AlignedV1NonfightBinding> = Object.freeze({
    ...unsignedNonfightBinding,
    fixedArtifacts: Object.freeze({ ...unsignedNonfightBinding.fixedArtifacts }),
    nonfightBindingSha256: V08_ALIGNED_V1_NONFIGHT_BINDING_SHA256,
});

export function cloneV08AlignedV1NonfightBinding(): IV08AlignedV1NonfightBinding {
    return {
        ...V08_ALIGNED_V1_NONFIGHT_BINDING,
        fixedArtifacts: { ...V08_ALIGNED_V1_NONFIGHT_BINDING.fixedArtifacts },
    };
}

export function validateV08AlignedV1NonfightBinding(value: IV08AlignedV1NonfightBinding): IV08AlignedV1NonfightBinding {
    const expectedKeys = [
        "schemaVersion",
        "artifactKind",
        "draftSpec",
        "draftProjection",
        "projectedDraftGenomeSha256",
        "setupSpec",
        "setupBehaviorSha256",
        "rankedCellMode",
        "fixedCellMode",
        "fixedArtifacts",
        "setupPolicy",
        "rankedCreatureOrder",
        "opponentPlacement",
        "candidatePlacementControl",
        "placementAugmentTiming",
        "nonfightBindingSha256",
    ].sort();
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
        !value.fixedArtifacts ||
        typeof value.fixedArtifacts !== "object" ||
        Array.isArray(value.fixedArtifacts) ||
        JSON.stringify(Object.keys(value.fixedArtifacts).sort()) !== JSON.stringify(["tier1", "tier2"])
    ) {
        throw new Error("v0.8 aligned non-fight binding fields are not exact");
    }
    if (JSON.stringify(canonicalValue(value)) !== JSON.stringify(canonicalValue(V08_ALIGNED_V1_NONFIGHT_BINDING))) {
        throw new Error("v0.8 aligned non-fight binding does not match the frozen deployed-v0.7 policy");
    }
    return value;
}

const DEPLOYED_SETUP = resolveSetupPolicy(V07_NONFIGHT_SETUP_SPEC);
const CONDITIONAL_RULES = parseConditionalRules("all");

export const pickV08AlignedV1BoundArtifactT2 = (
    offered: readonly number[],
    ownCreatureIdsAtTier2: readonly number[],
): number => DEPLOYED_SETUP.pickArtifactT2(offered, ownCreatureIdsAtTier2);

export const pickV08AlignedV1BoundAugments = (perk: number, ownCreatureIds: readonly number[]) =>
    DEPLOYED_SETUP.pickAugments(getUpgradePoints(perk), ownCreatureIds);

export const pickV08AlignedV1BoundSynergies = (ownCreatureStackIds: readonly number[]) =>
    DEPLOYED_SETUP.pickSynergies(ownCreatureStackIds);

function bindArmySetup(army: IConditionalArmy): IConditionalArmy {
    return {
        ...army,
        creatureIds: [...army.creatureIds],
        revealedOpponentCreatures: [...army.revealedOpponentCreatures],
        roster: army.roster.map((unit) => ({ ...unit })),
        augments: pickV08AlignedV1BoundAugments(army.perk, army.creatureIds),
        synergies: pickV08AlignedV1BoundSynergies(army.creatureIds),
    };
}

/** Full ranked pick path: shipped draft plus deployed perk/T1/T2/augment/synergy behavior. */
export function runV08AlignedV1BoundRankedPick(seed: number): { lower: IConditionalArmy; upper: IConditionalArmy } {
    const picked = runRankedConditionalPickGame(
        seed,
        CONDITIONAL_RULES,
        shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC),
        {
            pickArtifactT2: (_team, offered, ownCreatureIdsAtTier2) =>
                pickV08AlignedV1BoundArtifactT2(offered, ownCreatureIdsAtTier2),
            rankedCreatureOrder: SERVER_PERSISTED_CREATURE_ORDER,
        },
    );
    return { lower: bindArmySetup(picked.lower), upper: bindArmySetup(picked.upper) };
}

export interface IV08AlignedV1MatchBindingOptions {
    candidateIsGreen: boolean;
    placementReveal: boolean;
    fixedTemplate: boolean;
}

const rosterCreatureIds = (roster: IMatchConfig["roster"]): number[] =>
    roster.map((unit) => creatureIdForName(unit.creatureName));

const sideBudget = (perk: number | undefined, side: "green" | "red"): number => {
    if (perk === undefined) throw new Error(`v0.8 aligned ${side} setup omitted its ranked perk`);
    return getUpgradePoints(perk);
};

/** Apply the exact non-fight contract immediately before the physical match is constructed. */
export function bindV08AlignedV1MatchConfig(
    config: IMatchConfig,
    options: IV08AlignedV1MatchBindingOptions,
): IMatchConfig {
    const greenCreatureIds = rosterCreatureIds(config.roster);
    const redCreatureIds = rosterCreatureIds(config.redRoster ?? config.roster);
    const greenBudget = sideBudget(config.greenPerk, "green");
    const redBudget = sideBudget(config.redPerk, "red");
    const candidatePlacement = options.placementReveal ? "legitimate-reveal" : "baseline";
    return {
        ...config,
        greenAugments: DEPLOYED_SETUP.pickAugments(greenBudget, greenCreatureIds),
        redAugments: DEPLOYED_SETUP.pickAugments(redBudget, redCreatureIds),
        greenSynergies: pickV08AlignedV1BoundSynergies(greenCreatureIds),
        redSynergies: pickV08AlignedV1BoundSynergies(redCreatureIds),
        ...(options.fixedTemplate
            ? {
                  greenArtifactT1: 0,
                  redArtifactT1: 0,
                  greenArtifactT2: 0,
                  redArtifactT2: 0,
              }
            : {}),
        greenSetupPlacementPolicy: options.candidateIsGreen ? candidatePlacement : "legitimate-reveal",
        redSetupPlacementPolicy: options.candidateIsGreen ? "legitimate-reveal" : candidatePlacement,
        placementAugmentTiming: "setup-before-placement",
    };
}

/** Physical setup identity excludes seat-scoped policy labels, which are bound separately above. */
export function v08AlignedV1PhysicalSetup(config: IMatchConfig): unknown {
    const army = (side: "green" | "red") => {
        const green = side === "green";
        const roster = green ? config.roster : (config.redRoster ?? config.roster);
        return {
            creatureIds: rosterCreatureIds(roster),
            revealedOpponentCreatures: [
                ...((green ? config.greenRevealedCreatures : config.redRevealedCreatures) ?? []),
            ],
            roster: roster.map((unit) => ({ ...unit })),
            perk: (green ? config.greenPerk : config.redPerk) ?? 0,
            augments: (green ? config.greenAugments : config.redAugments)?.map((augment) => ({ ...augment })) ?? [],
            synergies: (green ? config.greenSynergies : config.redSynergies)?.map((synergy) => ({ ...synergy })) ?? [],
            tier1Artifact: (green ? config.greenArtifactT1 : config.redArtifactT1) ?? 0,
            tier2Artifact: (green ? config.greenArtifactT2 : config.redArtifactT2) ?? 0,
        };
    };
    return { lower: army("green"), upper: army("red"), map: config.gridType };
}
