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

import CREATURES_JSON from "../../configuration/creatures.json";
import { Tier2Artifact } from "../../artifacts/artifact_properties";
import { creatureInfo } from "../../ai/setup/creature_score";
import {
    conditionalArtifactT2,
    conditionalAugments,
    parseConditionalRules,
    TIER2_ARTIFACT_WINRATE_MELEE,
    TIER2_ARTIFACT_WINRATE_RANGED,
} from "../../ai/setup/setup_conditional";
import { TIER2_ARTIFACT_WINRATE } from "../../ai/setup/setup_strategy";
import { pickSynergiesSituational, SYNERGY_ANCHOR_W, SYNERGY_OPTIONS } from "../../ai/setup/synergy_score";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { ISetupAugment, ISetupSynergy } from "../battle_engine";

export const V07_SETUP_OVERNIGHT_SCHEMA_VERSION = 3;
export const V07_SETUP_BUDGET = 7;
export const V07_SETUP_DRAFT_SPEC = "league-r1-br-57de5a2d";
export const V07_SETUP_CONDITIONAL_SPEC = "all";
export const V07_SETUP_FIGHT_VERSION = "v0.7";
export const SETUP_LIVE_GRID_TYPES = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;
export type SetupLiveGridType = (typeof SETUP_LIVE_GRID_TYPES)[number];

export const SETUP_COHORTS = [
    "ranged-4plus",
    "ranged-2to3",
    "ranged-1",
    "melee-magic",
    "mage",
    "aura-heavy",
    "melee-other",
] as const;
export type SetupCohort = (typeof SETUP_COHORTS)[number];

export const SETUP_DIAGNOSTIC_TAGS = ["aggregate", "ranged", "mage", "melee-magic", "aura-heavy"] as const;
export type SetupDiagnosticTag = (typeof SETUP_DIAGNOSTIC_TAGS)[number];
export const SETUP_NAMED_GUARD_TAGS = ["ranged", "mage", "melee-magic", "aura-heavy"] as const;

export const SETUP_GUARD_THRESHOLDS = {
    aggregateConfidence95LowGainPp: 0,
    namedPointWinRate: 0.495,
    namedConfidence95LowGainPp: -2,
    minimumNamedGames: 100,
    liveMapPointWinRate: 0.495,
    liveMapConfidence95LowGainPp: -2,
    minimumLiveMapGames: 1_000,
} as const;

export function setupLiveGridType(seed: number): SetupLiveGridType {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new RangeError(`invalid setup map seed ${seed}`);
    }
    return SETUP_LIVE_GRID_TYPES[seed % SETUP_LIVE_GRID_TYPES.length];
}

export interface ISetupRosterFeatures {
    total: number;
    ranged: number;
    mage: number;
    meleeMagic: number;
    flyers: number;
    auraCarriers: number;
}

type CreatureJson = Record<string, Record<string, { attack_type?: string } | undefined> | undefined>;

let attackTypeByName: Map<string, string> | undefined;

function creatureAttackType(name: string): string {
    if (!attackTypeByName) {
        attackTypeByName = new Map();
        for (const faction of Object.values(CREATURES_JSON as unknown as CreatureJson)) {
            for (const [creatureName, config] of Object.entries(faction ?? {})) {
                attackTypeByName.set(creatureName, config?.attack_type ?? "");
            }
        }
    }
    return attackTypeByName.get(name) ?? "";
}

export function setupRosterFeatures(creatureIds: readonly number[]): ISetupRosterFeatures {
    const features: ISetupRosterFeatures = {
        total: 0,
        ranged: 0,
        mage: 0,
        meleeMagic: 0,
        flyers: 0,
        auraCarriers: 0,
    };
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        if (!info) continue;
        features.total += 1;
        features.ranged += Number(info.ranged);
        features.flyers += Number(info.canFly);
        features.auraCarriers += Number(info.auraCount > 0);
        const attackType = creatureAttackType(info.name);
        features.mage += Number(attackType === "MAGIC");
        features.meleeMagic += Number(attackType === "MELEE_MAGIC");
    }
    return features;
}

export function setupCohort(creatureIds: readonly number[]): SetupCohort {
    const features = setupRosterFeatures(creatureIds);
    if (features.ranged >= 4) return "ranged-4plus";
    if (features.ranged >= 2) return "ranged-2to3";
    if (features.ranged === 1) return "ranged-1";
    if (features.meleeMagic > 0) return "melee-magic";
    if (features.mage > 0) return "mage";
    if (features.auraCarriers > 0) return "aura-heavy";
    return "melee-other";
}

export function setupDiagnosticTags(creatureIds: readonly number[]): SetupDiagnosticTag[] {
    const features = setupRosterFeatures(creatureIds);
    const tags: SetupDiagnosticTag[] = ["aggregate"];
    if (features.ranged > 0) tags.push("ranged");
    if (features.mage > 0) tags.push("mage");
    if (features.meleeMagic > 0) tags.push("melee-magic");
    if (features.auraCarriers > 0) tags.push("aura-heavy");
    return tags;
}

export interface IAugmentPlan {
    /** Placement uses its wire levels 0/1/2; 0 is the free default 3-wide zone. */
    placement: number;
    armor: number;
    might: number;
    sniper: number;
    movement: number;
}

const AUGMENT_CAPS: Readonly<IAugmentPlan> = { placement: 2, armor: 3, might: 3, sniper: 3, movement: 2 };

export function augmentPlanCost(plan: Readonly<IAugmentPlan>): number {
    return plan.placement + plan.armor + plan.might + plan.sniper + plan.movement;
}

export function assertAugmentPlan(plan: Readonly<IAugmentPlan>, budget: number = V07_SETUP_BUDGET): void {
    for (const key of Object.keys(AUGMENT_CAPS) as (keyof IAugmentPlan)[]) {
        const value = plan[key];
        if (!Number.isInteger(value) || value < 0 || value > AUGMENT_CAPS[key]) {
            throw new RangeError(`${key}=${value} is outside [0, ${AUGMENT_CAPS[key]}]`);
        }
    }
    if (augmentPlanCost(plan) > budget) {
        throw new RangeError(`augment plan costs ${augmentPlanCost(plan)} but budget is ${budget}`);
    }
}

export function augmentPlanId(plan: Readonly<IAugmentPlan>): string {
    assertAugmentPlan(plan);
    return `P${plan.placement}-A${plan.armor}-M${plan.might}-S${plan.sniper}-V${plan.movement}`;
}

/** All 96 full-spend legal SEE_NONE plans. Full spend is safe because Armor/Might/Sniper are monotone buffs. */
export function enumerateFullBudgetAugmentPlans(budget: number = V07_SETUP_BUDGET): IAugmentPlan[] {
    if (!Number.isInteger(budget) || budget < 0) throw new RangeError("budget must be a non-negative integer");
    const plans: IAugmentPlan[] = [];
    for (let placement = 0; placement <= AUGMENT_CAPS.placement; placement += 1) {
        for (let armor = 0; armor <= AUGMENT_CAPS.armor; armor += 1) {
            for (let might = 0; might <= AUGMENT_CAPS.might; might += 1) {
                for (let sniper = 0; sniper <= AUGMENT_CAPS.sniper; sniper += 1) {
                    for (let movement = 0; movement <= AUGMENT_CAPS.movement; movement += 1) {
                        const plan = { placement, armor, might, sniper, movement };
                        if (augmentPlanCost(plan) === budget) plans.push(plan);
                    }
                }
            }
        }
    }
    return plans.sort((left, right) => augmentPlanId(left).localeCompare(augmentPlanId(right)));
}

export function setupAugmentsForPlan(plan: Readonly<IAugmentPlan>): ISetupAugment[] {
    assertAugmentPlan(plan);
    const augments: ISetupAugment[] = [];
    if (plan.placement > 0) augments.push({ kind: "Placement", value: plan.placement });
    if (plan.armor > 0) augments.push({ kind: "Armor", value: plan.armor });
    if (plan.might > 0) augments.push({ kind: "Might", value: plan.might });
    if (plan.sniper > 0) augments.push({ kind: "Sniper", value: plan.sniper });
    if (plan.movement > 0) augments.push({ kind: "Movement", value: plan.movement });
    return augments;
}

const CONDITIONAL_ALL = parseConditionalRules(V07_SETUP_CONDITIONAL_SPEC);

export function shippedAugmentPlan(creatureIds: readonly number[]): IAugmentPlan {
    const plan: IAugmentPlan = { placement: 0, armor: 0, might: 0, sniper: 0, movement: 0 };
    for (const augment of conditionalAugments(V07_SETUP_BUDGET, creatureIds, CONDITIONAL_ALL)) {
        const key = augment.kind.toLowerCase() as "armor" | "might" | "sniper" | "movement";
        plan[key] = augment.value;
    }
    return plan;
}

export type T2PolicyVariant = "baseline" | "blind" | "melee-table" | "ranged-table" | `promote:${number}`;

export const T2_POLICY_VARIANTS: readonly T2PolicyVariant[] = [
    "baseline",
    "blind",
    "melee-table",
    "ranged-table",
    ...Array.from({ length: 12 }, (_, index) => `promote:${index + 1}` as const),
];

const bestFromTable = (offered: readonly number[], table: Readonly<Record<number, number>>): number | undefined => {
    let best: number | undefined;
    let score = -Infinity;
    for (const artifact of offered) {
        const candidate = table[artifact];
        if (candidate !== undefined && candidate > score) {
            score = candidate;
            best = artifact;
        }
    }
    return best;
};

export function pickTier2ForVariant(
    offered: readonly number[],
    creatureIds: readonly number[],
    variant: T2PolicyVariant,
): number {
    if (!offered.length) return Tier2Artifact.NO_ARTIFACT;
    const baseline = conditionalArtifactT2(offered, creatureIds, CONDITIONAL_ALL);
    if (variant === "baseline") return baseline;
    if (variant === "blind") return bestFromTable(offered, TIER2_ARTIFACT_WINRATE) ?? baseline;
    if (variant === "melee-table") return bestFromTable(offered, TIER2_ARTIFACT_WINRATE_MELEE) ?? baseline;
    if (variant === "ranged-table") return bestFromTable(offered, TIER2_ARTIFACT_WINRATE_RANGED) ?? baseline;
    const promoted = Number(variant.slice("promote:".length));
    return Number.isInteger(promoted) && offered.includes(promoted) ? promoted : baseline;
}

export const SYNERGY_POLICY_VARIANTS = [
    "baseline",
    "beneficiary",
    "beneficiary-with-anchor",
    "flip-life",
    "flip-chaos",
    "flip-might",
    "flip-nature",
] as const;
export type SynergyPolicyVariant = (typeof SYNERGY_POLICY_VARIANTS)[number];

function synergyWeights(variant: SynergyPolicyVariant): number[] {
    if (variant === "baseline") return [...SYNERGY_ANCHOR_W];
    if (variant === "beneficiary" || variant === "beneficiary-with-anchor") {
        return SYNERGY_OPTIONS.flatMap((option) => [
            variant === "beneficiary-with-anchor" && option.tablePick ? 0.25 : 0,
            1,
        ]);
    }
    const factionName = variant.slice("flip-".length);
    const factionByLabel: Record<string, number> = {
        life: PBTypes.FactionVals.LIFE,
        chaos: PBTypes.FactionVals.CHAOS,
        might: PBTypes.FactionVals.MIGHT,
        nature: PBTypes.FactionVals.NATURE,
    };
    const faction = factionByLabel[factionName];
    return SYNERGY_OPTIONS.flatMap((option) => {
        if (option.faction !== faction) return [option.tablePick ? 1 : 0, 0];
        return [option.tablePick ? 0 : 1, 0];
    });
}

export function pickSynergiesForVariant(
    creatureIds: readonly number[],
    variant: SynergyPolicyVariant,
): ISetupSynergy[] {
    return pickSynergiesSituational(creatureIds, synergyWeights(variant));
}

export type PlacementPolicyVariant = "baseline" | "legitimate-reveal";
export type PlacementAugmentTiming = "current-live" | "setup-before-placement";

export interface INonFightCandidatePolicy {
    id: string;
    augmentsByCohort: Record<SetupCohort, IAugmentPlan>;
    tier2ByCohort: Record<SetupCohort, T2PolicyVariant>;
    synergy: SynergyPolicyVariant;
    placement: PlacementPolicyVariant;
    placementAugmentTiming: PlacementAugmentTiming;
}

export function shippedNonFightPolicy(id: string = "shipped-round1-conditional-all"): INonFightCandidatePolicy {
    const augmentsByCohort = {} as Record<SetupCohort, IAugmentPlan>;
    const tier2ByCohort = {} as Record<SetupCohort, T2PolicyVariant>;
    for (const cohort of SETUP_COHORTS) {
        const ranged = cohort === "ranged-4plus" || cohort === "ranged-2to3";
        augmentsByCohort[cohort] = ranged
            ? { placement: 0, armor: 3, might: 1, sniper: 3, movement: 0 }
            : { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 };
        tier2ByCohort[cohort] = "baseline";
    }
    return {
        id,
        augmentsByCohort,
        tier2ByCohort,
        synergy: "baseline",
        placement: "baseline",
        placementAugmentTiming: "setup-before-placement",
    };
}

export function cloneNonFightPolicy(policy: Readonly<INonFightCandidatePolicy>): INonFightCandidatePolicy {
    return {
        ...policy,
        augmentsByCohort: Object.fromEntries(
            SETUP_COHORTS.map((cohort) => [cohort, { ...policy.augmentsByCohort[cohort] }]),
        ) as Record<SetupCohort, IAugmentPlan>,
        tier2ByCohort: { ...policy.tier2ByCohort },
    };
}

export const SETUP_SEED_PANELS = ["train", "selection", "guard"] as const;
export type SetupSeedPanel = (typeof SETUP_SEED_PANELS)[number];
const PANEL_BITS: Record<SetupSeedPanel, number> = { train: 0, selection: 1, guard: 2 };
const PANEL_MASK = 0x3fffffff;
const PANEL_STEP = 0x1e3779b1; // odd, hence a full-period permutation modulo 2^30

/** Disjoint by construction: the top two seed bits identify train/selection/untouched guard. */
export function setupPanelSeed(baseSeed: number, panel: SetupSeedPanel, index: number): number {
    if (!Number.isSafeInteger(baseSeed)) throw new RangeError("baseSeed must be a safe integer");
    if (!Number.isInteger(index) || index < 0 || index > PANEL_MASK) {
        throw new RangeError(`seed index must be in [0, ${PANEL_MASK}]`);
    }
    const low = ((baseSeed & PANEL_MASK) + Math.imul(index, PANEL_STEP)) & PANEL_MASK;
    return (low | (PANEL_BITS[panel] << 30)) >>> 0;
}

export interface ISetupEvaluatedGame {
    candidateSide: "green" | "red";
    candidateResult: "win" | "loss" | "draw";
    candidateRejections: number;
    baselineRejections: number;
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck";
    decidedByArmageddon: boolean;
    traceSha256: string;
    tags: SetupDiagnosticTag[];
}

export interface ISetupEvaluatedPair {
    seed: number;
    gridType: SetupLiveGridType;
    games: [ISetupEvaluatedGame, ISetupEvaluatedGame];
}

export interface IPairedSetupEstimate {
    pairs: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveWinRate: number;
    gainPp: number;
    clusteredSePp: number | null;
    confidence95: { low: number; high: number } | null;
    confidence95LowGainPp: number | null;
    candidateRejections: number;
    baselineRejections: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    drawOrArmageddon: number;
    drawOrArmageddonRate: number;
}

export function pairedSetupEstimate(
    pairs: readonly ISetupEvaluatedPair[],
    tag: SetupDiagnosticTag = "aggregate",
    gridType?: SetupLiveGridType,
): IPairedSetupEstimate {
    const seenSeeds = new Set<number>();
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let candidateRejections = 0;
    let baselineRejections = 0;
    let totalLaps = 0;
    const endReasons: Record<string, number> = {};
    let armageddonDecided = 0;
    let drawOrArmageddon = 0;
    let sumWinSquared = 0;
    let sumWinDecisive = 0;
    let sumDecisiveSquared = 0;
    let activePairs = 0;
    for (const pair of pairs) {
        if (!Number.isInteger(pair.seed) || pair.seed < 0 || pair.seed > 0xffffffff) {
            throw new RangeError(`invalid paired setup seed ${pair.seed}`);
        }
        if (seenSeeds.has(pair.seed)) throw new Error(`duplicate paired setup seed ${pair.seed}`);
        seenSeeds.add(pair.seed);
        if (!Array.isArray(pair.games) || pair.games.length !== 2) {
            throw new Error(`paired setup seed ${pair.seed} must contain exactly two games`);
        }
        if (!SETUP_LIVE_GRID_TYPES.includes(pair.gridType)) {
            throw new Error(`paired setup seed ${pair.seed} has non-live grid type ${pair.gridType}`);
        }
        if (pair.gridType !== setupLiveGridType(pair.seed)) {
            throw new Error(`paired setup seed ${pair.seed} has a non-deterministic grid assignment`);
        }
        if (pair.games[0].candidateSide === pair.games[1].candidateSide) {
            throw new Error(`paired setup seed ${pair.seed} must swap candidate sides`);
        }
        if (gridType !== undefined && pair.gridType !== gridType) continue;
        let pairWins = 0;
        let pairDecisive = 0;
        let pairGames = 0;
        for (const game of pair.games) {
            if (!/^[0-9a-f]{64}$/.test(game.traceSha256)) {
                throw new Error(`paired setup seed ${pair.seed} has an invalid full-trace digest`);
            }
            if (!game.tags.includes(tag)) continue;
            pairGames += 1;
            candidateRejections += game.candidateRejections;
            baselineRejections += game.baselineRejections;
            totalLaps += game.laps;
            endReasons[game.endReason] = (endReasons[game.endReason] ?? 0) + 1;
            armageddonDecided += Number(game.decidedByArmageddon);
            drawOrArmageddon += Number(game.candidateResult === "draw" || game.decidedByArmageddon);
            if (game.candidateResult === "win") {
                wins += 1;
                pairWins += 1;
                pairDecisive += 1;
            } else if (game.candidateResult === "loss") {
                losses += 1;
                pairDecisive += 1;
            } else {
                draws += 1;
            }
        }
        if (!pairGames) continue;
        activePairs += 1;
        sumWinSquared += pairWins * pairWins;
        sumWinDecisive += pairWins * pairDecisive;
        sumDecisiveSquared += pairDecisive * pairDecisive;
    }
    const decisive = wins + losses;
    const games = decisive + draws;
    const rate = decisive ? wins / decisive : 0.5;
    let standardError: number | null = null;
    let confidence95: { low: number; high: number } | null = null;
    if (activePairs >= 2 && decisive > 0) {
        const residualSquares = sumWinSquared - 2 * rate * sumWinDecisive + rate * rate * sumDecisiveSquared;
        const finiteSample = activePairs / (activePairs - 1);
        standardError = Math.sqrt(Math.max(0, (finiteSample * residualSquares) / (decisive * decisive)));
        const z = 1.959963984540054;
        const normalLow = Math.max(0, rate - z * standardError);
        const normalHigh = Math.min(1, rate + z * standardError);
        // A deterministic paired panel can have zero empirical sandwich variance. Wilson with one effective
        // observation per active pair prevents that from being reported as infinite certainty.
        const denominator = 1 + (z * z) / activePairs;
        const center = (rate + (z * z) / (2 * activePairs)) / denominator;
        const margin =
            (z * Math.sqrt((rate * (1 - rate)) / activePairs + (z * z) / (4 * activePairs * activePairs))) /
            denominator;
        confidence95 = {
            low: Math.min(normalLow, Math.max(0, center - margin)),
            high: Math.max(normalHigh, Math.min(1, center + margin)),
        };
    }
    return {
        pairs: activePairs,
        games,
        wins,
        losses,
        draws,
        decisiveWinRate: rate,
        gainPp: (rate - 0.5) * 100,
        clusteredSePp: standardError === null ? null : standardError * 100,
        confidence95,
        confidence95LowGainPp: confidence95 === null ? null : (confidence95.low - 0.5) * 100,
        candidateRejections,
        baselineRejections,
        avgLaps: games ? totalLaps / games : 0,
        endReasons,
        armageddonDecided,
        drawOrArmageddon,
        drawOrArmageddonRate: games ? drawOrArmageddon / games : 0,
    };
}

export function setupGuardPromotable(
    placementAugmentTiming: PlacementAugmentTiming,
    aggregate: Readonly<IPairedSetupEstimate>,
    diagnostics: Readonly<Record<(typeof SETUP_NAMED_GUARD_TAGS)[number], IPairedSetupEstimate>>,
    liveMapDiagnostics: Readonly<Record<SetupLiveGridType, IPairedSetupEstimate>>,
    currentGuardComplete: boolean,
    controlSymmetryPassed: boolean,
    byteIdenticalReplay: boolean,
): boolean {
    return (
        currentGuardComplete &&
        controlSymmetryPassed &&
        byteIdenticalReplay &&
        placementAugmentTiming === "setup-before-placement" &&
        aggregate.games > 0 &&
        aggregate.candidateRejections === 0 &&
        (aggregate.confidence95LowGainPp ?? -Infinity) > SETUP_GUARD_THRESHOLDS.aggregateConfidence95LowGainPp &&
        SETUP_LIVE_GRID_TYPES.every((gridType) => {
            const estimate = liveMapDiagnostics[gridType];
            return (
                estimate.games >= SETUP_GUARD_THRESHOLDS.minimumLiveMapGames &&
                estimate.candidateRejections === 0 &&
                estimate.decisiveWinRate >= SETUP_GUARD_THRESHOLDS.liveMapPointWinRate &&
                (estimate.confidence95LowGainPp ?? -Infinity) >= SETUP_GUARD_THRESHOLDS.liveMapConfidence95LowGainPp
            );
        }) &&
        SETUP_NAMED_GUARD_TAGS.every((tag) => {
            const estimate = diagnostics[tag];
            return (
                estimate.games >= SETUP_GUARD_THRESHOLDS.minimumNamedGames &&
                estimate.candidateRejections === 0 &&
                estimate.decisiveWinRate >= SETUP_GUARD_THRESHOLDS.namedPointWinRate &&
                (estimate.confidence95LowGainPp ?? -Infinity) >= SETUP_GUARD_THRESHOLDS.namedConfidence95LowGainPp
            );
        })
    );
}
