/*
 * -----------------------------------------------------------------------------
 * Research-only A/B for opponent-roster-conditioned v0.7 placement.
 *
 * The incumbent receives only pick-phase reveals and uses `legitimate-reveal`.
 * The candidate receives the same reveals plus a declared subset of the final
 * opponent roster and uses `public-roster`. No positions, stack amounts, perks,
 * artifacts, augments, or synergies cross the policy boundary.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import CREATURES_JSON from "../configuration/creatures.json";
import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import { parseConditionalRules } from "../ai/setup/setup_conditional";
import { creatureInfo } from "../ai/setup/creature_score";
import {
    compileNonFightSetupPolicy,
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    SETUP_OPTIMIZED_BUDGET,
    setupCohort,
    V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    type PlacementPolicyVariant,
    type SetupCohort,
} from "../ai/setup/setup_ship";
import {
    CHARGER_ABILITY,
    classifyRevealedThreats,
    FLYER_SCREEN_THRESHOLD,
    selectOpponentCreatureIdsForPlacement,
    SPLASH_AOE_ABILITIES,
} from "../ai/versions/v0_7_placement_reveal";
import { FightStateManager } from "../fights/fight_state_manager";
import { runMatch, type IMatchConfig, type IMatchResult, type Side } from "./battle_engine";
import { runRankedConditionalPickGame, type IConditionalArmy } from "./measure_setup_conditional";
import { clusteredRankedDraftConfidence95, rankedDraftBehaviorTraceSha256 } from "./ranked_draft_eval";
import {
    SETUP_LIVE_GRID_TYPES,
    setupDiagnosticTags,
    setupLiveGridType,
    setupPanelSeed,
    type SetupLiveGridType,
    type SetupSeedPanel,
} from "./optimizer/v0_7_setup_overnight_core";

export const PUBLIC_ROSTER_COHORT_SAFE_ARM = "cohort-safe" as const;
export const PUBLIC_ROSTER_PLACEMENT_ARMS = [
    "control",
    "flyers",
    "chargers",
    "both",
    PUBLIC_ROSTER_COHORT_SAFE_ARM,
] as const;
export type PublicRosterPlacementArm = (typeof PUBLIC_ROSTER_PLACEMENT_ARMS)[number];
export type PublicRosterPlacementAction = "unchanged" | "flyer-screen" | "corner-shift";
export const PUBLIC_ROSTER_PLACEMENT_TARGETS = [
    "natural",
    "ranged",
    "mage",
    "melee-magic",
    "aura-heavy",
    "melee-other",
] as const;
export type PublicRosterPlacementTarget = (typeof PUBLIC_ROSTER_PLACEMENT_TARGETS)[number];

const RULES = parseConditionalRules("all");
const CURRENT_SETUP = compileNonFightSetupPolicy(V07_NONFIGHT_SETUP_ARTIFACT.policy, V07_NONFIGHT_SETUP_SPEC);
const SHIPPED_DRAFT = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
const MAX_SEED_INDEX = 0x3fffffff;
const TARGET_SCAN_OFFSETS: Record<PublicRosterPlacementTarget, number> = {
    natural: 0,
    ranged: 50_000_000,
    mage: 100_000_000,
    "melee-magic": 150_000_000,
    "aura-heavy": 200_000_000,
    "melee-other": 250_000_000,
};

type CreatureConfig = { attack_type?: string };
const ATTACK_TYPE_BY_NAME = new Map<string, string>();
for (const faction of Object.values(CREATURES_JSON as unknown as Record<string, Record<string, CreatureConfig>>)) {
    for (const [name, config] of Object.entries(faction ?? {})) {
        ATTACK_TYPE_BY_NAME.set(name, config.attack_type ?? "");
    }
}

export interface IPublicRosterPlacementContext {
    placementPolicy: PlacementPolicyVariant;
    revealedOpponentCreatureIds: number[];
    publicOpponentCreatureIds?: number[];
    addedPublicCreatureIds: number[];
    incumbentAction: PublicRosterPlacementAction;
    candidateAction: PublicRosterPlacementAction;
    actionable: boolean;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

function isArmThreat(arm: PublicRosterPlacementArm, creatureId: number): boolean {
    if (arm === "both" || arm === PUBLIC_ROSTER_COHORT_SAFE_ARM) return true;
    const info = creatureInfo(creatureId);
    if (!info || arm === "control") return false;
    if (arm === "flyers" && info.canFly) return true;
    return arm === "chargers" && info.abilities.includes(CHARGER_ABILITY);
}

function fieldsSplash(creatureIds: readonly number[]): boolean {
    return creatureIds.some((creatureId) => {
        const abilities = creatureInfo(creatureId)?.abilities ?? "";
        return SPLASH_AOE_ABILITIES.some((ability) => abilities.includes(ability));
    });
}

function placementAction(
    ownCreatureIds: readonly number[],
    opponentCreatureIds: readonly number[],
    visibleOpponentCreatureIds: readonly number[],
): PublicRosterPlacementAction {
    if (fieldsSplash(opponentCreatureIds)) return "unchanged";
    const threats = classifyRevealedThreats(visibleOpponentCreatureIds);
    const hasShooter = ownCreatureIds.some((id) => creatureInfo(id)?.ranged === true);
    const hasGroundMelee = ownCreatureIds.some((id) => {
        const info = creatureInfo(id);
        return !!info && !info.canFly && ATTACK_TYPE_BY_NAME.get(info.name) === "MELEE";
    });
    if (threats.flyers >= FLYER_SCREEN_THRESHOLD && hasShooter && hasGroundMelee) return "flyer-screen";
    if (threats.chargers > 0) return "corner-shift";
    return "unchanged";
}

/** Build the candidate's fair placement context without altering the incumbent reveal list. */
export function publicRosterPlacementContext(
    arm: PublicRosterPlacementArm,
    ownCreatureIds: readonly number[],
    opponentCreatureIds: readonly number[],
    legitimateReveals: readonly number[],
): IPublicRosterPlacementContext {
    const revealedOpponentCreatureIds = unique(legitimateReveals);
    const addedPublicCreatureIds = unique(opponentCreatureIds).filter(
        (id) => !revealedOpponentCreatureIds.includes(id) && isArmThreat(arm, id),
    );
    const incumbentAction = placementAction(ownCreatureIds, opponentCreatureIds, revealedOpponentCreatureIds);
    if (arm === "control") {
        return {
            placementPolicy: "legitimate-reveal",
            revealedOpponentCreatureIds,
            addedPublicCreatureIds,
            incumbentAction,
            candidateAction: incumbentAction,
            actionable: false,
        };
    }
    // `both` retains the historical global-public arm. `cohort-safe` supplies that same complete roster only
    // when the shared runtime selector authorizes it for the candidate's own exact setup cohort.
    const requestedPublicOpponentCreatureIds =
        arm === "both" || arm === PUBLIC_ROSTER_COHORT_SAFE_ARM
            ? unique(opponentCreatureIds)
            : unique([...revealedOpponentCreatureIds, ...addedPublicCreatureIds]);
    const placementPolicy =
        arm === PUBLIC_ROSTER_COHORT_SAFE_ARM ? COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT : ("public-roster" as const);
    const visibleOpponentCreatureIds = selectOpponentCreatureIdsForPlacement(
        placementPolicy,
        ownCreatureIds,
        revealedOpponentCreatureIds,
        requestedPublicOpponentCreatureIds,
    );
    const usesPublicRoster = visibleOpponentCreatureIds === requestedPublicOpponentCreatureIds;
    const publicOpponentCreatureIds = usesPublicRoster ? requestedPublicOpponentCreatureIds : undefined;
    const effectiveAddedPublicCreatureIds = usesPublicRoster ? addedPublicCreatureIds : [];
    const candidateAction = placementAction(
        ownCreatureIds,
        opponentCreatureIds,
        visibleOpponentCreatureIds ?? revealedOpponentCreatureIds,
    );
    return {
        placementPolicy,
        revealedOpponentCreatureIds,
        publicOpponentCreatureIds,
        addedPublicCreatureIds: effectiveAddedPublicCreatureIds,
        incumbentAction,
        candidateAction,
        actionable: candidateAction !== incumbentAction,
    };
}

export interface IPublicRosterPlacementBoard {
    index: number;
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
    gridType: SetupLiveGridType;
}

/** Three disjoint seed channels per offer board: cluster id, picks, and combat. */
export function publicRosterPlacementBoard(
    baseSeed: number,
    panel: SetupSeedPanel,
    index: number,
): IPublicRosterPlacementBoard {
    if (!Number.isInteger(index) || index < 0 || index * 3 + 2 > MAX_SEED_INDEX) {
        throw new RangeError(`board index must fit three setup-panel seed channels; got ${index}`);
    }
    const pairSeed = setupPanelSeed(baseSeed, panel, index * 3);
    const pickSeed = setupPanelSeed(baseSeed, panel, index * 3 + 1);
    const battleSeed = setupPanelSeed(baseSeed, panel, index * 3 + 2);
    return { index, pairSeed, pickSeed, battleSeed, gridType: setupLiveGridType(battleSeed) };
}

function rankedPick(board: IPublicRosterPlacementBoard) {
    return runRankedConditionalPickGame(board.pickSeed, RULES, SHIPPED_DRAFT, {
        pickArtifactT2: (_team, offered, ownCreatureIds) => CURRENT_SETUP.pickArtifactT2(offered, ownCreatureIds),
    });
}

export interface IPublicRosterPlacementDraftSeat {
    creatureIds: number[];
    cohort: SetupCohort;
    targets: PublicRosterPlacementTarget[];
}

export interface IPublicRosterPlacementDraftEvidence {
    pickSeed: number;
    lower: IPublicRosterPlacementDraftSeat;
    upper: IPublicRosterPlacementDraftSeat;
}

/** Inclusive public setup tags for one roster; melee-other deliberately remains the exact fallback cohort. */
export function publicRosterPlacementRosterTargets(creatureIds: readonly number[]): PublicRosterPlacementTarget[] {
    const targets: PublicRosterPlacementTarget[] = ["natural"];
    for (const tag of setupDiagnosticTags(creatureIds)) {
        if (tag !== "aggregate") targets.push(tag);
    }
    if (setupCohort(creatureIds) === "melee-other") targets.push("melee-other");
    return targets;
}

/** Reconstruct only the ranked draft for a report board; no placement or fight is evaluated. */
export function publicRosterPlacementDraftEvidence(
    board: IPublicRosterPlacementBoard,
): IPublicRosterPlacementDraftEvidence {
    const pick = rankedPick(board);
    const evidenceForArmy = (army: IConditionalArmy): IPublicRosterPlacementDraftSeat => ({
        creatureIds: [...army.creatureIds],
        cohort: setupCohort(army.creatureIds),
        targets: publicRosterPlacementRosterTargets(army.creatureIds),
    });
    return {
        pickSeed: board.pickSeed,
        lower: evidenceForArmy(pick.lower),
        upper: evidenceForArmy(pick.upper),
    };
}

function armyMatchesTarget(creatureIds: readonly number[], target: PublicRosterPlacementTarget): boolean {
    return publicRosterPlacementRosterTargets(creatureIds).includes(target);
}

export interface ICollectedPublicRosterBoards {
    boards: IPublicRosterPlacementBoard[];
    scannedBoards: number;
}

/** Outcome-blind roster targeting. Every rejected pick board is burned by advancing the target's seed lane. */
export function collectPublicRosterPlacementBoards(
    baseSeed: number,
    panel: SetupSeedPanel,
    count: number,
    target: PublicRosterPlacementTarget,
    startBoard: number = 0,
): ICollectedPublicRosterBoards {
    if (!Number.isInteger(startBoard) || startBoard < 0) {
        throw new RangeError(`start board must be a non-negative integer; got ${startBoard}`);
    }
    const boards: IPublicRosterPlacementBoard[] = [];
    const start = TARGET_SCAN_OFFSETS[target] + startBoard;
    const maximumScans = target === "natural" ? count : Math.max(20_000, count * 2_000);
    let scannedBoards = 0;
    while (boards.length < count && scannedBoards < maximumScans) {
        const board = publicRosterPlacementBoard(baseSeed, panel, start + scannedBoards);
        scannedBoards += 1;
        if (target === "natural") {
            boards.push(board);
            continue;
        }
        const pick = rankedPick(board);
        if (armyMatchesTarget(pick.lower.creatureIds, target) || armyMatchesTarget(pick.upper.creatureIds, target)) {
            boards.push(board);
        }
    }
    if (boards.length !== count) {
        throw new Error(`target ${target} found ${boards.length}/${count} boards after ${scannedBoards} scans`);
    }
    return { boards, scannedBoards };
}

interface IArmySetup {
    augments: ReturnType<typeof CURRENT_SETUP.pickAugments>;
    synergies: ReturnType<typeof CURRENT_SETUP.pickSynergies>;
}

function armySetup(army: IConditionalArmy): IArmySetup {
    return {
        augments: CURRENT_SETUP.pickAugments(SETUP_OPTIMIZED_BUDGET, army.creatureIds),
        synergies: CURRENT_SETUP.pickSynergies(army.creatureIds),
    };
}

export interface IPublicRosterPlacementRecord {
    arm: PublicRosterPlacementArm;
    boardIndex: number;
    game: number;
    pairSeed: number;
    pickSeed: number;
    battleSeed: number;
    gridType: SetupLiveGridType;
    pickSeat: "candidate-lower" | "candidate-upper";
    battleMirror: 0 | 1;
    candidateSide: Side;
    candidateResult: "win" | "loss" | "draw";
    candidateCohort: SetupCohort;
    opponentCohort: SetupCohort;
    incumbentAction: PublicRosterPlacementAction;
    candidateAction: PublicRosterPlacementAction;
    actionable: boolean;
    legitimateRevealCount: number;
    addedPublicCount: number;
    candidateRejections: number;
    baselineRejections: number;
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    setupFingerprint: string;
    behaviorTraceSha256: string;
}

export interface IPublicRosterPlacementCluster {
    arm: PublicRosterPlacementArm;
    board: IPublicRosterPlacementBoard;
    records: [
        IPublicRosterPlacementRecord,
        IPublicRosterPlacementRecord,
        IPublicRosterPlacementRecord,
        IPublicRosterPlacementRecord,
    ];
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function resultForSide(result: IMatchResult, side: Side): "win" | "loss" | "draw" {
    if (result.winner === "draw") return "draw";
    return result.winner === side ? "win" : "loss";
}

function playPublicRosterPlacementGame(
    arm: PublicRosterPlacementArm,
    board: IPublicRosterPlacementBoard,
    lower: IConditionalArmy,
    upper: IConditionalArmy,
    candidatePickedLower: boolean,
    battleMirror: 0 | 1,
    maxLaps: number,
): IPublicRosterPlacementRecord {
    const candidateArmy = candidatePickedLower ? lower : upper;
    const baselineArmy = candidatePickedLower ? upper : lower;
    const candidateContext = publicRosterPlacementContext(
        arm,
        candidateArmy.creatureIds,
        baselineArmy.creatureIds,
        candidateArmy.revealedOpponentCreatures,
    );
    const lowerSetup = armySetup(lower);
    const upperSetup = armySetup(upper);
    const lowerIsCandidate = candidatePickedLower;
    const lowerContext = lowerIsCandidate
        ? candidateContext
        : publicRosterPlacementContext(
              "control",
              lower.creatureIds,
              upper.creatureIds,
              lower.revealedOpponentCreatures,
          );
    const upperContext = lowerIsCandidate
        ? publicRosterPlacementContext("control", upper.creatureIds, lower.creatureIds, upper.revealedOpponentCreatures)
        : candidateContext;
    const greenArmy = battleMirror === 0 ? lower : upper;
    const redArmy = battleMirror === 0 ? upper : lower;
    const greenSetup = battleMirror === 0 ? lowerSetup : upperSetup;
    const redSetup = battleMirror === 0 ? upperSetup : lowerSetup;
    const greenContext = battleMirror === 0 ? lowerContext : upperContext;
    const redContext = battleMirror === 0 ? upperContext : lowerContext;
    const candidateIsGreen = battleMirror === 0 ? candidatePickedLower : !candidatePickedLower;
    const candidateSide: Side = candidateIsGreen ? "green" : "red";
    const config: IMatchConfig = {
        greenVersion: "v0.7",
        redVersion: "v0.7",
        roster: greenArmy.roster,
        redRoster: redArmy.roster,
        seed: board.battleSeed,
        gridType: board.gridType,
        maxLaps,
        greenPerk: greenArmy.perk,
        redPerk: redArmy.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
        greenArtifactT1: greenArmy.tier1Artifact,
        redArtifactT1: redArmy.tier1Artifact,
        greenArtifactT2: greenArmy.tier2Artifact,
        redArtifactT2: redArmy.tier2Artifact,
        greenSynergies: greenSetup.synergies,
        redSynergies: redSetup.synergies,
        greenRevealedCreatures: greenContext.revealedOpponentCreatureIds,
        redRevealedCreatures: redContext.revealedOpponentCreatureIds,
        greenPublicOpponentCreatures: greenContext.publicOpponentCreatureIds,
        redPublicOpponentCreatures: redContext.publicOpponentCreatureIds,
        greenSetupPlacementPolicy: greenContext.placementPolicy,
        redSetupPlacementPolicy: redContext.placementPolicy,
        placementAugmentTiming: "setup-before-placement",
    };
    FightStateManager.getInstance();
    const result = runMatch(config);
    if (result.rejectedGreen === undefined || result.rejectedRed === undefined) {
        throw new Error(`public-roster battle ${board.pairSeed} omitted rejection telemetry`);
    }
    return {
        arm,
        boardIndex: board.index,
        game: (candidatePickedLower ? 0 : 2) + battleMirror,
        pairSeed: board.pairSeed,
        pickSeed: board.pickSeed,
        battleSeed: board.battleSeed,
        gridType: board.gridType,
        pickSeat: candidatePickedLower ? "candidate-lower" : "candidate-upper",
        battleMirror,
        candidateSide,
        candidateResult: resultForSide(result, candidateSide),
        candidateCohort: setupCohort(candidateArmy.creatureIds),
        opponentCohort: setupCohort(baselineArmy.creatureIds),
        incumbentAction: candidateContext.incumbentAction,
        candidateAction: candidateContext.candidateAction,
        actionable: candidateContext.actionable,
        legitimateRevealCount: candidateContext.revealedOpponentCreatureIds.length,
        addedPublicCount: candidateContext.addedPublicCreatureIds.length,
        candidateRejections: candidateIsGreen ? result.rejectedGreen : result.rejectedRed,
        baselineRejections: candidateIsGreen ? result.rejectedRed : result.rejectedGreen,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        setupFingerprint: sha256({
            lower,
            upper,
            lowerSetup,
            upperSetup,
            lowerContext,
            upperContext,
            grid: board.gridType,
        }),
        behaviorTraceSha256: rankedDraftBehaviorTraceSha256(result),
    };
}

/** Four-game cluster: both pick seats crossed with both battle-side mirrors. */
export function evaluatePublicRosterPlacementCluster(
    arm: PublicRosterPlacementArm,
    board: IPublicRosterPlacementBoard,
    maxLaps: number = 60,
): IPublicRosterPlacementCluster {
    const pick = rankedPick(board);
    const records = ([true, false] as const).flatMap((candidatePickedLower) =>
        ([0, 1] as const).map((battleMirror) =>
            playPublicRosterPlacementGame(
                arm,
                board,
                pick.lower,
                pick.upper,
                candidatePickedLower,
                battleMirror,
                maxLaps,
            ),
        ),
    ) as IPublicRosterPlacementCluster["records"];
    return { arm, board, records };
}

export interface IPublicRosterPlacementEstimate {
    boards: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    decisiveWinRate: number;
    gainPp: number;
    confidence95: { low: number; high: number };
    confidence95LowGainPp: number;
    candidateRejections: number;
    baselineRejections: number;
    avgLaps: number;
}

export interface IPublicRosterPlacementDelta {
    boards: number;
    games: number;
    candidateDecisiveWinRate: number;
    controlDecisiveWinRate: number;
    scoreGainPp: number;
    clusteredSePp: number | null;
    confidence95GainPp: { low: number; high: number } | null;
    outcomeChanges: number;
}

export function publicRosterPlacementEstimate(
    records: readonly IPublicRosterPlacementRecord[],
): IPublicRosterPlacementEstimate {
    const wins = records.filter((record) => record.candidateResult === "win").length;
    const losses = records.filter((record) => record.candidateResult === "loss").length;
    const draws = records.length - wins - losses;
    const decisive = wins + losses;
    const decisiveWinRate = decisive ? wins / decisive : 0.5;
    const confidence95 = clusteredRankedDraftConfidence95(records);
    return {
        boards: new Set(records.map((record) => record.pairSeed)).size,
        games: records.length,
        wins,
        losses,
        draws,
        decisiveWinRate,
        gainPp: (decisiveWinRate - 0.5) * 100,
        confidence95,
        confidence95LowGainPp: (confidence95.low - 0.5) * 100,
        candidateRejections: records.reduce((sum, record) => sum + record.candidateRejections, 0),
        baselineRejections: records.reduce((sum, record) => sum + record.baselineRejections, 0),
        avgLaps: records.length ? records.reduce((sum, record) => sum + record.laps, 0) / records.length : 0,
    };
}

const gameScore = (result: IPublicRosterPlacementRecord["candidateResult"]): number =>
    result === "win" ? 1 : result === "draw" ? 0.5 : 0;

/** Same-board/game paired score delta. This is the correct comparison for composition-selected slices. */
export function pairedPublicRosterPlacementDelta(
    candidateRecords: readonly IPublicRosterPlacementRecord[],
    controlRecords: readonly IPublicRosterPlacementRecord[],
): IPublicRosterPlacementDelta {
    const controlByKey = new Map(controlRecords.map((record) => [`${record.pairSeed}/${record.game}`, record]));
    const clusters = new Map<number, number[]>();
    let candidateWins = 0;
    let candidateLosses = 0;
    let controlWins = 0;
    let controlLosses = 0;
    let outcomeChanges = 0;
    for (const candidate of candidateRecords) {
        const control = controlByKey.get(`${candidate.pairSeed}/${candidate.game}`);
        if (!control) throw new Error(`missing control record for ${candidate.pairSeed}/${candidate.game}`);
        if (
            candidate.pickSeed !== control.pickSeed ||
            candidate.battleSeed !== control.battleSeed ||
            candidate.pickSeat !== control.pickSeat ||
            candidate.battleMirror !== control.battleMirror ||
            candidate.candidateSide !== control.candidateSide ||
            candidate.candidateCohort !== control.candidateCohort ||
            candidate.opponentCohort !== control.opponentCohort
        ) {
            throw new Error(`candidate/control pairing mismatch for ${candidate.pairSeed}/${candidate.game}`);
        }
        candidateWins += Number(candidate.candidateResult === "win");
        candidateLosses += Number(candidate.candidateResult === "loss");
        controlWins += Number(control.candidateResult === "win");
        controlLosses += Number(control.candidateResult === "loss");
        outcomeChanges += Number(candidate.candidateResult !== control.candidateResult);
        const deltas = clusters.get(candidate.pairSeed) ?? [];
        deltas.push(gameScore(candidate.candidateResult) - gameScore(control.candidateResult));
        clusters.set(candidate.pairSeed, deltas);
    }
    const games = candidateRecords.length;
    const scoreGain = games ? [...clusters.values()].flat().reduce((sum, delta) => sum + delta, 0) / games : 0;
    let clusteredSe: number | null = null;
    if (clusters.size >= 2 && games > 0) {
        let residualSquares = 0;
        for (const deltas of clusters.values()) {
            const residual = deltas.reduce((sum, delta) => sum + delta - scoreGain, 0);
            residualSquares += residual * residual;
        }
        clusteredSe = Math.sqrt((clusters.size / (clusters.size - 1)) * residualSquares) / games;
    }
    const candidateDecisive = candidateWins + candidateLosses;
    const controlDecisive = controlWins + controlLosses;
    return {
        boards: clusters.size,
        games,
        candidateDecisiveWinRate: candidateDecisive ? candidateWins / candidateDecisive : 0.5,
        controlDecisiveWinRate: controlDecisive ? controlWins / controlDecisive : 0.5,
        scoreGainPp: scoreGain * 100,
        clusteredSePp: clusteredSe === null ? null : clusteredSe * 100,
        confidence95GainPp:
            clusteredSe === null
                ? null
                : {
                      low: (scoreGain - 1.959963984540054 * clusteredSe) * 100,
                      high: (scoreGain + 1.959963984540054 * clusteredSe) * 100,
                  },
        outcomeChanges,
    };
}

function summarizeArm(clusters: readonly IPublicRosterPlacementCluster[]) {
    const records = clusters.flatMap((cluster) => cluster.records);
    const byCohort = Object.fromEntries(
        ["ranged-4plus", "ranged-2to3", "ranged-1", "melee-magic", "mage", "aura-heavy", "melee-other"].map(
            (cohort) => [
                cohort,
                publicRosterPlacementEstimate(records.filter((record) => record.candidateCohort === cohort)),
            ],
        ),
    );
    const byMap = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [
            gridType,
            publicRosterPlacementEstimate(records.filter((record) => record.gridType === gridType)),
        ]),
    );
    return {
        natural: publicRosterPlacementEstimate(records),
        actionable: publicRosterPlacementEstimate(records.filter((record) => record.actionable)),
        flyerScreen: publicRosterPlacementEstimate(
            records.filter((record) => record.actionable && record.candidateAction === "flyer-screen"),
        ),
        cornerShift: publicRosterPlacementEstimate(
            records.filter((record) => record.actionable && record.candidateAction === "corner-shift"),
        ),
        byCohort,
        byMap,
    };
}

function summarizeComparison(
    candidateClusters: readonly IPublicRosterPlacementCluster[],
    controlClusters: readonly IPublicRosterPlacementCluster[],
) {
    const candidate = candidateClusters.flatMap((cluster) => cluster.records);
    const control = controlClusters.flatMap((cluster) => cluster.records);
    const compare = (records: readonly IPublicRosterPlacementRecord[]) =>
        pairedPublicRosterPlacementDelta(records, control);
    const byCohort = Object.fromEntries(
        ["ranged-4plus", "ranged-2to3", "ranged-1", "melee-magic", "mage", "aura-heavy", "melee-other"].map(
            (cohort) => [cohort, compare(candidate.filter((record) => record.candidateCohort === cohort))],
        ),
    );
    const byMap = Object.fromEntries(
        SETUP_LIVE_GRID_TYPES.map((gridType) => [
            gridType,
            compare(candidate.filter((record) => record.gridType === gridType)),
        ]),
    );
    return {
        natural: compare(candidate),
        actionable: compare(candidate.filter((record) => record.actionable)),
        flyerScreen: compare(
            candidate.filter((record) => record.actionable && record.candidateAction === "flyer-screen"),
        ),
        cornerShift: compare(
            candidate.filter((record) => record.actionable && record.candidateAction === "corner-shift"),
        ),
        byCohort,
        byMap,
    };
}

interface IPublicRosterWorkerJob {
    arm: PublicRosterPlacementArm;
    board: IPublicRosterPlacementBoard;
    maxLaps: number;
}

type PublicRosterWorkerReply =
    | { type: "ready" }
    | { type: "result"; cluster: IPublicRosterPlacementCluster }
    | { type: "error"; error: string };

async function runJobs(
    jobs: readonly IPublicRosterWorkerJob[],
    workers: number,
    onProgress?: (completed: number, total: number) => void,
): Promise<IPublicRosterPlacementCluster[]> {
    if (!jobs.length) return [];
    const results: IPublicRosterPlacementCluster[] = [];
    let cursor = 0;
    return new Promise((resolvePromise, rejectPromise) => {
        const pool: Worker[] = [];
        let settled = false;
        const stop = (): void => pool.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            stop();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (cursor >= jobs.length) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "job", job: jobs[cursor++] });
        };
        const poolSize = Math.max(1, Math.min(workers, jobs.length));
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(new URL(import.meta.url), { workerData: { publicRosterPlacementWorker: true } });
            pool.push(worker);
            worker.on("message", (message: PublicRosterWorkerReply) => {
                if (message.type === "error") return fail(new Error(message.error));
                if (message.type === "ready") return dispatch(worker);
                results.push(message.cluster);
                onProgress?.(results.length, jobs.length);
                if (results.length === jobs.length) {
                    settled = true;
                    stop();
                    resolvePromise(results);
                } else {
                    dispatch(worker);
                }
            });
            worker.on("error", fail);
        }
    });
}

if (
    !isMainThread &&
    parentPort &&
    (workerData as { publicRosterPlacementWorker?: boolean }).publicRosterPlacementWorker
) {
    const port = parentPort;
    port.on("message", (message: { type: "job"; job: IPublicRosterWorkerJob } | { type: "stop" }) => {
        if (message.type === "stop") return port.close();
        try {
            const { arm, board, maxLaps } = message.job;
            port.postMessage({
                type: "result",
                cluster: evaluatePublicRosterPlacementCluster(arm, board, maxLaps),
            });
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    port.postMessage({ type: "ready" });
}

function parseArms(value: string): PublicRosterPlacementArm[] {
    const arms = value === "all" ? [...PUBLIC_ROSTER_PLACEMENT_ARMS] : value.split(",");
    for (const arm of arms) {
        if (!PUBLIC_ROSTER_PLACEMENT_ARMS.includes(arm as PublicRosterPlacementArm)) {
            throw new Error(`unknown arm ${arm}; expected all or ${PUBLIC_ROSTER_PLACEMENT_ARMS.join(",")}`);
        }
    }
    return unique(["control", ...arms]) as PublicRosterPlacementArm[];
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            arm: { type: "string", default: "all" },
            boards: { type: "string", default: "200" },
            "base-seed": { type: "string", default: "97071710" },
            "start-board": { type: "string", default: "0" },
            panel: { type: "string", default: "train" },
            target: { type: "string", default: "natural" },
            workers: { type: "string", default: String(Math.min(12, availableParallelism())) },
            "max-laps": { type: "string", default: "60" },
            output: { type: "string", default: "sim-out/public_roster_placement.json" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        console.log(
            "usage: bun src/simulation/measure_public_roster_placement.ts " +
                "[--arm all|control,flyers,chargers,both,cohort-safe] [--boards 200] [--base-seed N] " +
                "[--start-board N] " +
                "[--panel train|selection|guard] [--target natural|ranged|mage|melee-magic|aura-heavy|melee-other] " +
                "[--workers 12] [--max-laps 60] [--output path.json]",
        );
        return;
    }
    const arms = parseArms(values.arm);
    const boards = Number(values.boards);
    const workers = Number(values.workers);
    const maxLaps = Number(values["max-laps"]);
    const baseSeed = Number(values["base-seed"]);
    const startBoard = Number(values["start-board"]);
    const panel = values.panel as SetupSeedPanel;
    const target = values.target as PublicRosterPlacementTarget;
    if (!Number.isInteger(boards) || boards < 1) throw new RangeError("boards must be a positive integer");
    if (!Number.isInteger(workers) || workers < 1) throw new RangeError("workers must be a positive integer");
    if (!Number.isInteger(maxLaps) || maxLaps < 1) throw new RangeError("max-laps must be a positive integer");
    if (!Number.isSafeInteger(baseSeed)) throw new RangeError("base-seed must be a safe integer");
    if (!Number.isSafeInteger(startBoard) || startBoard < 0) {
        throw new RangeError("start-board must be a non-negative safe integer");
    }
    if (!["train", "selection", "guard"].includes(panel)) throw new Error("panel must be train, selection, or guard");
    if (!PUBLIC_ROSTER_PLACEMENT_TARGETS.includes(target)) {
        throw new Error(`target must be one of ${PUBLIC_ROSTER_PLACEMENT_TARGETS.join(",")}`);
    }
    process.env.LIVETWIN = "1";
    process.env.V07_SEARCH = "0";
    const collected = collectPublicRosterPlacementBoards(baseSeed, panel, boards, target, startBoard);
    const boardLedger = collected.boards;
    const jobs = arms.flatMap((arm) => boardLedger.map((board) => ({ arm, board, maxLaps })));
    const start = Date.now();
    let lastProgress = 0;
    const clusters = await runJobs(jobs, workers, (completed, total) => {
        if (completed === total || completed - lastProgress >= Math.max(1, Math.floor(total / 20))) {
            lastProgress = completed;
            console.error(`  ${completed}/${total} clusters (${completed * 4} games)`);
        }
    });
    clusters.sort((left, right) => left.arm.localeCompare(right.arm) || left.board.index - right.board.index);
    const summaries = Object.fromEntries(
        arms.map((arm) => [arm, summarizeArm(clusters.filter((cluster) => cluster.arm === arm))]),
    );
    const controlClusters = clusters.filter((cluster) => cluster.arm === "control");
    const comparisons = Object.fromEntries(
        arms
            .filter((arm) => arm !== "control")
            .map((arm) => [
                arm,
                summarizeComparison(
                    clusters.filter((cluster) => cluster.arm === arm),
                    controlClusters,
                ),
            ]),
    );
    const reportWithoutHash = {
        schemaVersion: 1,
        status: "research_only_no_bake",
        question: "public final roster placement vs shipped legitimate pick reveals",
        setupSpec: V07_NONFIGHT_SETUP_SPEC,
        cohortSafeSetupSpec: V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
        cohortSafeBehaviorSha256: V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
        draftSpec: LEAGUE_ROUND1_DRAFT_SPEC,
        fightVersion: "v0.7",
        informationBoundary:
            "opponent creature ids only; no positions, amounts, perk, artifacts, augments, synergies, or hidden state",
        arms,
        panel,
        target,
        baseSeed,
        startBoard,
        boards,
        scannedBoards: collected.scannedBoards,
        games: clusters.length * 4,
        maxLaps,
        maps: SETUP_LIVE_GRID_TYPES,
        wallSeconds: (Date.now() - start) / 1000,
        summaries,
        comparisons,
        boardLedger,
        clusters,
    };
    const report = { ...reportWithoutHash, reportSha256: sha256(reportWithoutHash) };
    const output = resolve(values.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`Report: ${output}`);
    for (const arm of arms) {
        const summary = summaries[arm];
        const comparison = arm === "control" ? undefined : comparisons[arm];
        console.error(
            `${arm}: natural ${(summary.natural.decisiveWinRate * 100).toFixed(2)}% ` +
                `(${summary.natural.gainPp >= 0 ? "+" : ""}${summary.natural.gainPp.toFixed(2)}pp, ` +
                `LCB ${summary.natural.confidence95LowGainPp.toFixed(2)}pp); actionable ` +
                `${(summary.actionable.decisiveWinRate * 100).toFixed(2)}% ` +
                `(${summary.actionable.games}/${summary.natural.games} games)` +
                (comparison
                    ? `; matched-control score ${comparison.natural.scoreGainPp >= 0 ? "+" : ""}${comparison.natural.scoreGainPp.toFixed(2)}pp`
                    : ""),
        );
    }
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
