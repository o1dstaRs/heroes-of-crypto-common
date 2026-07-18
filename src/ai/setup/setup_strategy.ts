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
import type { GridType } from "../../generated/protobuf/v1/types_gen";
import { LifeSynergy, ChaosSynergy, MightSynergy, NatureSynergy } from "../../synergies/synergy_properties";

/**
 * Fair, phase-local information that a ranked setup policy may use in addition to its decision's explicit
 * arguments. This is deliberately data-only: never pass the live Grid/UnitsHolder or opponent placement,
 * artifacts, perk, augments, synergies, stack sizes, or positions through this boundary.
 */
export interface ISetupDecisionContext {
    /**
     * Deduplicated opponent creature identities publicly known to this seat at the current phase. During
     * placement the complete drafted roster is public; during earlier picks this may be only a public subset.
     */
    readonly publicOpponentCreatureIds: readonly number[];
    /** Public map topology selected for this match. */
    readonly gridType: GridType;
    /** Number of cells along one side of the square combat grid. */
    readonly gridSize: number;
    /** This seat's selected perk, when the phase has one. Opponent perk information is intentionally absent. */
    readonly ownPerk?: number;
    /** This seat's selected artifact ids in pick/tier order. Opponent artifacts are intentionally absent. */
    readonly ownArtifactIds?: readonly number[];
}

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
 * Measured marginal win-rate per Tier-1 artifact: v0.7 self-play, 20,000 games, LIVETWIN=1 (live-faithful:
 * exp-budget stacks, melee-drafted current-distribution rosters, SEE_NONE + the shipped Armor3/Might3/Sniper1
 * augment spend), seed 84000710. See measure_artifacts.ts.
 *
 * REFRESHED 2026-07-15 (was: v0.5 self-play, 50k games, no augments/LiveTwin — that table predates the
 * LIVETWIN preset entirely, 1990c20). `b4b8b7e` fixed a sim-only bug where `battle_engine` silently dropped
 * every artifact from any sim game that ALSO fielded augments (all prior LIVETWIN-era artifact measurements
 * were null); this is the first correct remeasurement under the live config. Large reranks vs the stale
 * table: Veteran Helm #2(61.1%)->#5(49.3%), Wounding Charm #12(43.4%)->#2(51.5%), Broken Aegis
 * #5(50.2%)->#12(42.8%) — several artifacts interact very differently with the always-on live augment buffs
 * than they do in isolation. Full-game A/B bake (pick_sim -> v0.7 LiveTwin fights, both live draft
 * distributions + a melee/ranged/random cohort non-regression check, 4k games/cell, seeds
 * 84010710/84011710/84020710): pooled headline +3.36pp +/- 0.56 (bar >= +1pp), worst headline cell +2.58pp,
 * worst cohort cell +2.01pp, all controls exactly 50.00% — PASS. See measure_artifact_table_refresh.ts.
 */
export const TIER1_ARTIFACT_WINRATE: Record<number, number> = {
    [Tier1Artifact.CURSED_WARD]: 79.8,
    [Tier1Artifact.WOUNDING_CHARM]: 51.5,
    [Tier1Artifact.IRON_PLATE]: 51.4,
    [Tier1Artifact.KEEN_BLADE]: 49.7,
    [Tier1Artifact.VETERAN_HELM]: 49.3,
    [Tier1Artifact.DUAL_STRIKE_CHARM]: 47.2,
    [Tier1Artifact.SWIFT_BOOTS]: 46.6,
    [Tier1Artifact.HELM_OF_FOCUS]: 46.1,
    [Tier1Artifact.AMULET_OF_RESOLVE]: 45.4,
    [Tier1Artifact.HUNTERS_LONGBOW]: 45.0,
    [Tier1Artifact.WINGED_BOOTS]: 44.5,
    [Tier1Artifact.BROKEN_AEGIS]: 42.8,
};

/**
 * Measured marginal win-rate per Tier-2 artifact: v0.7 self-play, 20,000 games, LIVETWIN=1, seed 84001710.
 * See measure_artifacts.ts --tier=2. REFRESHED 2026-07-15 — see the TIER1_ARTIFACT_WINRATE docstring above
 * for the full provenance (same bugfix, same bake). Headline rerank: Tome of Amplification
 * #9(41.7%)->#1(68.8%) — it amplifies the always-on live augment buffs, invisible in the old no-augment
 * measurement; Farsight Quiver #4(62.5%)->#5(47.1%).
 */
export const TIER2_ARTIFACT_WINRATE: Record<number, number> = {
    [Tier2Artifact.TOME_OF_AMPLIFICATION]: 68.8,
    [Tier2Artifact.TITAN_PLATE]: 63.9,
    [Tier2Artifact.WARLORDS_EDGE]: 63.7,
    [Tier2Artifact.CLOVER_OF_FORTUNE]: 62.2,
    [Tier2Artifact.FARSIGHT_QUIVER]: 47.1,
    [Tier2Artifact.RIME_CHARM]: 46.3,
    [Tier2Artifact.HOLY_CROSS]: 46.1,
    [Tier2Artifact.LAVA_STRIDERS]: 45.4,
    [Tier2Artifact.GIANTS_MAUL]: 45.3,
    [Tier2Artifact.PENDANT_OF_VITALITY]: 41.5,
    [Tier2Artifact.BERSERKERS_BOND]: 40.2,
    [Tier2Artifact.CROWN_OF_COMMAND]: 29.7,
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
