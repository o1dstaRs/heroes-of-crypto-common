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

import { SETUP_OPTIMIZED_BUDGET, setupRosterFeatures, type PlacementAugmentTiming } from "../../ai/setup/setup_ship";
import { PBTypes } from "../../generated/protobuf/v1/types";

export {
    augmentPlanCost,
    augmentPlanId,
    assertAugmentPlan,
    canonicalSetupPolicyBehavior,
    cloneNonFightPolicy,
    compileNonFightSetupPolicy,
    enumerateFullBudgetAugmentPlans,
    parseSetupPolicyArtifact,
    parseSetupPolicyBehavior,
    pickSynergiesForVariant,
    pickTier2ForVariant,
    resolveSetupPolicy,
    SETUP_COHORTS,
    SETUP_OPTIMIZED_BUDGET,
    SETUP_POLICY_V0_RESOLVED,
    setupAugmentsForPlan,
    setupCohort,
    setupRosterFeatures,
    shippedAugmentPlan,
    shippedNonFightPolicy,
    SYNERGY_POLICY_VARIANTS,
    T2_POLICY_VARIANTS,
    V07_NONFIGHT_BEHAVIOR_SHA256,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
} from "../../ai/setup/setup_ship";
export type {
    IAugmentPlan,
    INonFightCandidatePolicy,
    IResolvedSetupPolicy,
    ISetupAugmentChoice,
    ISetupPolicyArtifact,
    ISetupPolicyBehavior,
    ISetupRosterFeatures,
    ISetupSynergyChoice,
    PlacementAugmentTiming,
    PlacementPolicyVariant,
    ResolvedSetupPolicyMode,
    SetupCohort,
    SynergyPolicyVariant,
    T2PolicyVariant,
} from "../../ai/setup/setup_ship";

export const V07_SETUP_OVERNIGHT_SCHEMA_VERSION = 3;
export const V07_SETUP_BUDGET = SETUP_OPTIMIZED_BUDGET;
export const V07_SETUP_DRAFT_SPEC = "league-r1-br-57de5a2d";
export const V07_SETUP_CONDITIONAL_SPEC = "all";
export const V07_SETUP_FIGHT_VERSION = "v0.7";
export const SETUP_LIVE_GRID_TYPES = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
] as const;
export type SetupLiveGridType = (typeof SETUP_LIVE_GRID_TYPES)[number];

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

export function setupDiagnosticTags(creatureIds: readonly number[]): SetupDiagnosticTag[] {
    const features = setupRosterFeatures(creatureIds);
    const tags: SetupDiagnosticTag[] = ["aggregate"];
    if (features.ranged > 0) tags.push("ranged");
    if (features.mage > 0) tags.push("mage");
    if (features.meleeMagic > 0) tags.push("melee-magic");
    if (features.auraCarriers > 0) tags.push("aura-heavy");
    return tags;
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
