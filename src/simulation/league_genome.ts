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

import { getUpgradePoints, Perk } from "../perks/perk_properties";
import { creatureFeatures, creatureInfo, DRAFT_ANCHOR_W, DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import { TIER1_ARTIFACT_WINRATE, TIER2_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import {
    getKnownOpponentCreatures,
    getOmniscientCreatureChoices,
    getPickTeamView,
    getVisibleCreatureChoices,
    type IPickSimState,
    type PickBundle,
    type PickTeam,
} from "../picks/pick_sim";
import { PBTypes } from "../generated/protobuf/v1/types";

export const LEAGUE_SCHEMA_VERSION = 1;

export const LEAGUE_ROLE_NAMES = ["ranged", "flyer", "groundMelee"] as const;
export type LeagueRole = (typeof LEAGUE_ROLE_NAMES)[number];

export const LEAGUE_AUGMENT_KINDS = ["Armor", "Might", "Sniper", "Movement"] as const;
export type LeagueAugmentKind = (typeof LEAGUE_AUGMENT_KINDS)[number];

export type LeaguePlacementTemplate = "adaptive" | "tight";

const EXTRA_CREATURE_FEATURES = ["canFly", "hp", "armor", "speed"] as const;
const COMPOSITION_FEATURES = [
    "ownRanged",
    "ownFlyer",
    "ownGroundMelee",
    "opponentRanged",
    "opponentFlyer",
    "opponentGroundMelee",
] as const;
const SETUP_FEATURES = ["bias", ...COMPOSITION_FEATURES] as const;

export const LEAGUE_GENOME_LAYOUT = {
    draftIntrinsic: { offset: 0, length: DRAFT_ANCHOR_W.length + EXTRA_CREATURE_FEATURES.length },
    draftInteractions: {
        offset: DRAFT_ANCHOR_W.length + EXTRA_CREATURE_FEATURES.length,
        length: LEAGUE_ROLE_NAMES.length * COMPOSITION_FEATURES.length,
    },
    tier1: {
        offset:
            DRAFT_ANCHOR_W.length +
            EXTRA_CREATURE_FEATURES.length +
            LEAGUE_ROLE_NAMES.length * COMPOSITION_FEATURES.length,
        length: 12,
    },
    tier2: { offset: 45, length: 12 },
    augments: { offset: 57, length: LEAGUE_AUGMENT_KINDS.length * SETUP_FEATURES.length },
    placement: { offset: 85, length: SETUP_FEATURES.length },
    perks: { offset: 92, length: 3 },
} as const;

export const LEAGUE_GENOME_DIM = 95;

export const LEAGUE_GENOME_KEYS: readonly string[] = [
    ...[...DRAFT_ANCHOR_W.keys()].map((index) => `draft.intrinsic.${index}`),
    ...EXTRA_CREATURE_FEATURES.map((feature) => `draft.intrinsic.${feature}`),
    ...LEAGUE_ROLE_NAMES.flatMap((role) => COMPOSITION_FEATURES.map((feature) => `draft.${role}.${feature}`)),
    ...Array.from({ length: 12 }, (_, index) => `tier1.${index + 1}`),
    ...Array.from({ length: 12 }, (_, index) => `tier2.${index + 1}`),
    ...LEAGUE_AUGMENT_KINDS.flatMap((kind) => SETUP_FEATURES.map((feature) => `augment.${kind}.${feature}`)),
    ...SETUP_FEATURES.map((feature) => `placement.adaptive.${feature}`),
    "perk.threeReveals",
    "perk.seeAll",
    "perk.seeNone",
];

const artifactAnchor = (table: Readonly<Record<number, number>>): number[] =>
    Array.from({ length: 12 }, (_, index) => table[index + 1] ?? 50);

const augmentAnchor = (): number[] => {
    const base: Record<LeagueAugmentKind, number> = { Armor: 19, Might: 15, Sniper: 7, Movement: -5 };
    return LEAGUE_AUGMENT_KINDS.flatMap((kind) => [base[kind], ...new Array(COMPOSITION_FEATURES.length).fill(0)]);
};

/**
 * Absolute coefficients for the live setup-v0 anchor. The first eleven entries reproduce scoreCreature;
 * all new counter-draft interactions are zero, artifact heads reproduce the measured tables, augments spend
 * Armor3/Might3/Sniper1, adaptive v0.6 placement remains enabled, and SEE_NONE wins the perk head.
 */
export const LEAGUE_ANCHOR_GENOME: readonly number[] = [
    ...DRAFT_ANCHOR_W,
    0,
    0,
    0,
    0,
    ...new Array(LEAGUE_GENOME_LAYOUT.draftInteractions.length).fill(0),
    ...artifactAnchor(TIER1_ARTIFACT_WINRATE),
    ...artifactAnchor(TIER2_ARTIFACT_WINRATE),
    ...augmentAnchor(),
    1,
    ...new Array(COMPOSITION_FEATURES.length).fill(0),
    getUpgradePoints(Perk.THREE_REVEALS),
    getUpgradePoints(Perk.SEE_ALL),
    getUpgradePoints(Perk.SEE_NONE),
];

if (LEAGUE_ANCHOR_GENOME.length !== LEAGUE_GENOME_DIM || LEAGUE_GENOME_KEYS.length !== LEAGUE_GENOME_DIM) {
    throw new Error("League genome layout is internally inconsistent");
}

export interface ILeagueGenome {
    schemaVersion: typeof LEAGUE_SCHEMA_VERSION;
    id: string;
    weights: number[];
    /** Debug/oracle entrants may inspect hidden picks. Never enable this on a deployable champion. */
    omniscientDraft?: boolean;
}

export interface ILeagueAugment {
    kind: LeagueAugmentKind;
    value: number;
}

export interface ILeagueSetup {
    perk: Perk;
    artifactT1: number;
    artifactT2: number;
    augments: ILeagueAugment[];
    placementTemplate: LeaguePlacementTemplate;
}

export function assertLeagueWeights(weights: readonly number[]): void {
    if (weights.length !== LEAGUE_GENOME_DIM) {
        throw new RangeError(`League genome has ${weights.length} weights; expected ${LEAGUE_GENOME_DIM}`);
    }
    if (!weights.every((weight) => typeof weight === "number" && Number.isFinite(weight))) {
        throw new TypeError("League genome weights must all be finite numbers");
    }
}

export function createLeagueGenome(
    id: string,
    weights: readonly number[] = LEAGUE_ANCHOR_GENOME,
    omniscientDraft: boolean = false,
): ILeagueGenome {
    assertLeagueWeights(weights);
    if (!id.trim()) {
        throw new TypeError("League genome id must not be empty");
    }
    return {
        schemaVersion: LEAGUE_SCHEMA_VERSION,
        id,
        weights: [...weights],
        ...(omniscientDraft ? { omniscientDraft: true } : {}),
    };
}

/** Existing melee co-evolution draft champion embedded in the full-game anchor for a default exploiter pool. */
export function createMeleeLeagueGenome(id: string = "melee_coevo"): ILeagueGenome {
    const weights = [...LEAGUE_ANCHOR_GENOME];
    weights.splice(LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset, DEFAULT_DRAFT_W.length, ...DEFAULT_DRAFT_W);
    return createLeagueGenome(id, weights);
}

export function leagueRole(creatureId: number): LeagueRole {
    const info = creatureInfo(creatureId);
    if (info?.ranged) {
        return "ranged";
    }
    if (info?.canFly) {
        return "flyer";
    }
    return "groundMelee";
}

export function leagueComposition(creatureIds: readonly number[]): [number, number, number] {
    if (!creatureIds.length) {
        return [0, 0, 0];
    }
    const counts = [0, 0, 0];
    for (const creatureId of creatureIds) {
        counts[LEAGUE_ROLE_NAMES.indexOf(leagueRole(creatureId))] += 1;
    }
    return counts.map((count) => count / creatureIds.length) as [number, number, number];
}

const teamState = (state: IPickSimState, team: PickTeam) =>
    team === PBTypes.TeamVals.LOWER ? state.lower : state.upper;
const opponentState = (state: IPickSimState, team: PickTeam) =>
    team === PBTypes.TeamVals.LOWER ? state.upper : state.lower;

export function leagueOpponentCreatures(state: IPickSimState, team: PickTeam, omniscient: boolean): number[] {
    return omniscient ? [...opponentState(state, team).creatures] : getKnownOpponentCreatures(state, team);
}

const stateFeatures = (
    ownCreatures: readonly number[],
    opponentCreatures: readonly number[],
): [number, number, number, number, number, number] => [
    ...leagueComposition(ownCreatures),
    ...leagueComposition(opponentCreatures),
];

export function scoreLeagueCreature(
    creatureId: number,
    ownCreatures: readonly number[],
    opponentCreatures: readonly number[],
    weights: readonly number[],
): number {
    assertLeagueWeights(weights);
    const info = creatureInfo(creatureId);
    const intrinsic = [
        ...creatureFeatures(creatureId),
        info?.canFly ? 1 : 0,
        info?.hp ?? 0,
        info?.armor ?? 0,
        info?.speed ?? 0,
    ];
    let score = 0;
    for (let i = 0; i < intrinsic.length; i += 1) {
        score += intrinsic[i] * weights[LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset + i];
    }
    const role = LEAGUE_ROLE_NAMES.indexOf(leagueRole(creatureId));
    const features = stateFeatures(ownCreatures, opponentCreatures);
    const offset = LEAGUE_GENOME_LAYOUT.draftInteractions.offset + role * features.length;
    for (let i = 0; i < features.length; i += 1) {
        score += features[i] * weights[offset + i];
    }
    return score;
}

export function pickLeaguePerk(genome: ILeagueGenome, freezePerk: boolean = true): Perk {
    assertLeagueWeights(genome.weights);
    if (freezePerk) {
        return Perk.SEE_NONE;
    }
    const perks = [Perk.THREE_REVEALS, Perk.SEE_ALL, Perk.SEE_NONE] as const;
    let best: Perk = perks[0];
    for (let i = 1; i < perks.length; i += 1) {
        if (
            genome.weights[LEAGUE_GENOME_LAYOUT.perks.offset + i] >
            genome.weights[LEAGUE_GENOME_LAYOUT.perks.offset + perks.indexOf(best)]
        ) {
            best = perks[i];
        }
    }
    return best;
}

export function pickLeagueBundle(state: IPickSimState, team: PickTeam, genome: ILeagueGenome): 0 | 1 {
    const view = getPickTeamView(state, team);
    const own = teamState(state, team).creatures;
    const opponent = leagueOpponentCreatures(state, team, !!genome.omniscientDraft);
    let bestIndex: 0 | 1 = 0;
    let bestScore = -Infinity;
    view.bundles.forEach((bundle: PickBundle, index) => {
        const [level1, level2, artifact] = bundle;
        const bundleOwn = [...own, level1, level2];
        const score =
            scoreLeagueCreature(level1, bundleOwn, opponent, genome.weights) +
            scoreLeagueCreature(level2, bundleOwn, opponent, genome.weights) +
            genome.weights[LEAGUE_GENOME_LAYOUT.tier1.offset + artifact - 1];
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index as 0 | 1;
        }
    });
    return bestIndex;
}

export function pickLeagueCreature(state: IPickSimState, team: PickTeam, genome: ILeagueGenome): number {
    const choices = genome.omniscientDraft
        ? getOmniscientCreatureChoices(state, team)
        : getVisibleCreatureChoices(state, team);
    const own = teamState(state, team).creatures;
    const opponent = leagueOpponentCreatures(state, team, !!genome.omniscientDraft);
    let best = choices[0] ?? 0;
    let bestScore = -Infinity;
    for (const creatureId of choices) {
        const score = scoreLeagueCreature(creatureId, own, opponent, genome.weights);
        if (score > bestScore) {
            bestScore = score;
            best = creatureId;
        }
    }
    return best;
}

export function pickLeagueTier2(state: IPickSimState, team: PickTeam, genome: ILeagueGenome): number {
    const offers = getPickTeamView(state, team).tier2Offers;
    let best = offers[0] ?? 0;
    for (const artifact of offers.slice(1)) {
        if (
            genome.weights[LEAGUE_GENOME_LAYOUT.tier2.offset + artifact - 1] >
            genome.weights[LEAGUE_GENOME_LAYOUT.tier2.offset + best - 1]
        ) {
            best = artifact;
        }
    }
    return best;
}

const setupFeatures = (own: readonly number[], opponent: readonly number[]): number[] => [
    1,
    ...stateFeatures(own, opponent),
];

export function pickLeagueAugments(
    own: readonly number[],
    opponent: readonly number[],
    budget: number,
    genome: ILeagueGenome,
): ILeagueAugment[] {
    const features = setupFeatures(own, opponent);
    const maxLevel: Record<LeagueAugmentKind, number> = { Armor: 3, Might: 3, Sniper: 3, Movement: 2 };
    const scored = LEAGUE_AUGMENT_KINDS.map((kind, kindIndex) => {
        const offset = LEAGUE_GENOME_LAYOUT.augments.offset + kindIndex * features.length;
        return {
            kind,
            score: features.reduce((sum, feature, index) => sum + feature * genome.weights[offset + index], 0),
        };
    })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score);
    const augments: ILeagueAugment[] = [];
    let remaining = Math.max(0, Math.floor(budget));
    for (const { kind } of scored) {
        const value = Math.min(remaining, maxLevel[kind]);
        if (value > 0) {
            augments.push({ kind, value });
            remaining -= value;
        }
    }
    return augments;
}

export function pickLeaguePlacement(
    own: readonly number[],
    opponent: readonly number[],
    genome: ILeagueGenome,
): LeaguePlacementTemplate {
    const features = setupFeatures(own, opponent);
    const score = features.reduce(
        (sum, feature, index) => sum + feature * genome.weights[LEAGUE_GENOME_LAYOUT.placement.offset + index],
        0,
    );
    return score >= 0 ? "adaptive" : "tight";
}
