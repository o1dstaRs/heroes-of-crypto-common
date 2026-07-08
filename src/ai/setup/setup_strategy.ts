/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { Tier1Artifact, Tier2Artifact } from "../../artifacts/artifact_properties";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { LifeSynergy, ChaosSynergy, MightSynergy, NatureSynergy } from "../../synergies/synergy_properties";

/**
 * The setup AI's decision contract — the draft/placement counterpart to the in-fight IAIStrategy. A policy
 * turns the visible draft/placement state into the next setup choice. Deterministic + self-contained so the
 * ranked server (authoritative) and the sim (measure/train) share one implementation, and vectorizable so a
 * later CEM pass can learn the scoring weights (mirrors the v0.5 combat path).
 *
 * Creatures/artifacts/synergies are addressed by their enum ids (what the ranked pick document stores).
 */
export interface ISetupPolicy {
    readonly version: string;
    /** Doctrine/perk (Perk enum id). */
    pickPerk(): number;
    /** Index (0-based) of the best starting bundle. Each bundle is [l1CreatureId, l2CreatureId, tier1ArtifactId]. */
    pickBundle(bundles: readonly (readonly [number, number, number])[]): number;
    /** Best creature id of the required level from the legal pool. */
    pickCreature(level: number, available: readonly number[]): number;
    /** Best Tier-2 artifact id from the offered set. */
    pickArtifactT2(offered: readonly number[]): number;
    /** One synergy per fielded faction (the measured-best of that faction's two), given the team's creatures. */
    pickSynergies(creatureIds: readonly number[]): { faction: number; synergy: number }[];
    /** The measured-best synergy id for a faction (FactionVals), or 0 if the faction has no synergy. Lets a
     * caller that already knows its faction composition (e.g. the server's refreshSynergies) pick directly. */
    bestSynergyForFaction(faction: number): number;
    /** Army augments to buy within the upgrade-point budget (kind + level). */
    pickAugments(budget: number): { kind: "Armor" | "Might" | "Sniper" | "Movement"; value: number }[];
}

/**
 * Measured marginal win-rate per Tier-1 artifact (v0.5 self-play, 50k games; Veteran Helm at its current 4%).
 * Used as the greedy score — higher is a better blind pick. See measure_artifacts.ts.
 */
export const TIER1_ARTIFACT_WINRATE: Record<number, number> = {
    [Tier1Artifact.CURSED_WARD]: 62.4,
    [Tier1Artifact.VETERAN_HELM]: 61.1,
    [Tier1Artifact.IRON_PLATE]: 53.3,
    [Tier1Artifact.KEEN_BLADE]: 53.2,
    [Tier1Artifact.BROKEN_AEGIS]: 50.2,
    [Tier1Artifact.HUNTERS_LONGBOW]: 49.5,
    [Tier1Artifact.SWIFT_BOOTS]: 47.1,
    [Tier1Artifact.WINGED_BOOTS]: 45.5,
    [Tier1Artifact.DUAL_STRIKE_CHARM]: 45.4,
    [Tier1Artifact.AMULET_OF_RESOLVE]: 44.4,
    [Tier1Artifact.HELM_OF_FOCUS]: 44.3,
    [Tier1Artifact.WOUNDING_CHARM]: 43.4,
};

/** Measured marginal win-rate per Tier-2 artifact (v0.5 self-play, 50k games). See measure_artifacts.ts --tier=2. */
export const TIER2_ARTIFACT_WINRATE: Record<number, number> = {
    [Tier2Artifact.TITAN_PLATE]: 71.0,
    [Tier2Artifact.WARLORDS_EDGE]: 68.3,
    [Tier2Artifact.CLOVER_OF_FORTUNE]: 65.4,
    [Tier2Artifact.FARSIGHT_QUIVER]: 62.5,
    [Tier2Artifact.GIANTS_MAUL]: 45.8,
    [Tier2Artifact.RIME_CHARM]: 44.5,
    [Tier2Artifact.CROWN_OF_COMMAND]: 43.1,
    [Tier2Artifact.LAVA_STRIDERS]: 42.0,
    [Tier2Artifact.TOME_OF_AMPLIFICATION]: 41.7,
    [Tier2Artifact.HOLY_CROSS]: 41.1,
    [Tier2Artifact.BERSERKERS_BOND]: 36.8,
    [Tier2Artifact.PENDANT_OF_VITALITY]: 36.6,
};

/**
 * Measured-best synergy per faction (head-to-head, v0.5 self-play, 15k games each; see measure_setup.ts
 * --synergy=<faction>). FactionVals id -> the winning SpecificSynergy id.
 */
export const BEST_SYNERGY_BY_FACTION: Record<number, number> = {
    [PBTypes.FactionVals.LIFE]: LifeSynergy.PLUS_SUPPLY_PERCENTAGE, // 60.9%
    [PBTypes.FactionVals.CHAOS]: ChaosSynergy.MOVEMENT, // 62.4%
    [PBTypes.FactionVals.MIGHT]: MightSynergy.PLUS_STACK_ABILITIES_POWER, // 60.0%
    [PBTypes.FactionVals.NATURE]: NatureSynergy.PLUS_FLY_ARMOR, // 69.7%
};

/**
 * Augment categories in spend priority (measured: Armor L3 68.6%, Might L3 66.7% are the top blind picks;
 * Sniper is ranged-conditional, Movement weak). The policy buys the highest affordable level of each in
 * this order until the perk's upgrade-point budget is exhausted. Movement caps at level 2 (no LEVEL_3).
 */
export const AUGMENT_PRIORITY: { kind: "Armor" | "Might" | "Sniper" | "Movement"; maxLevel: number }[] = [
    { kind: "Armor", maxLevel: 3 },
    { kind: "Might", maxLevel: 3 },
    { kind: "Sniper", maxLevel: 3 },
    { kind: "Movement", maxLevel: 2 },
];
