/*
 * Worker isolate for measure_barrel_use.ts.
 *
 * One game per task. Grid.placeArtifactBarrel is patched in this isolate only, because a patch in the
 * parent never sees worker games. Headless matches omit obstacle_attacked events, so a barrel strike is a
 * completed obstacle_attack whose target cell was recorded by that patch. Map cemetery stones never go
 * through placeArtifactBarrel, so they stay out of the barrel tally.
 */
import { parentPort } from "node:worker_threads";

import { Tier1Artifact } from "../artifacts/artifact_properties";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { Grid } from "../grid/grid";
import type { GridSettings } from "../grid/grid_settings";
import { getCellForPosition } from "../grid/grid_math";
import type { XY } from "../utils/math";
import type { GameAction } from "../engine/actions";
import { GREEN_TEAM, runMatch, type Side } from "./battle_engine";
import {
    AI_META_FIGHT_VERSION,
    aiMetaSynergyVariantsForPair,
    prepareMetaPair,
    type AiMetaCohort,
    type IAiMetaArmy,
} from "./ai_meta_cohorts_core";
import {
    AI_META_REGISTERED_VERSION_STRATEGY_PROFILE,
    createAiMetaMatchStrategyOverrides,
} from "./ai_meta_strategy_profile";
import { materializeReplayAbSplits } from "./ranked_replay_tactics_ab_core";
import { startPersistentWorker } from "./persistent_worker_pool";

process.env.SIM_NO_ACTIONS = "1";
process.env.LIVETWIN = "1";
process.env.FIGHT_MELEE_ROSTERS = "0";

export interface BarrelFightRequest {
    cohort: AiMetaCohort;
    pair: number;
    /** generateMetaMatchup's game count: two per pair, even when this worker plays only one seat. */
    matchupGames: number;
    baseSeed: number;
    greenIsArmyA: boolean;
}

export interface BarrelFightResult {
    cohort: AiMetaCohort;
    pair: number;
    map: number;
    placed: number;
    placedGreen: number;
    placedRed: number;
    greenRanged: number;
    redRanged: number;
    barrelStrikes: number;
    ownBarrelStrikes: number;
    enemyBarrelStrikes: number;
    barrelRejections: number;
    otherObstacleStrikes: number;
    otherObstacleRejections: number;
    otherRejections: number;
    engineRejections: number;
    unclassifiedRejections: number;
    endReason: string;
    laps: number;
    barrelRejectionCounts: Record<string, number>;
    otherRejectionCounts: Record<string, number>;
    barrelRejectionSamples: string[];
}

interface LiveBarrels {
    settings?: GridSettings;
    cells: Set<string>;
    teamByCell: Map<string, number>;
    bySlot: Map<string, number>;
}

const live: LiveBarrels = {
    cells: new Set(),
    teamByCell: new Map(),
    bySlot: new Map(),
};

const originalPlace = Grid.prototype.placeArtifactBarrel;
Grid.prototype.placeArtifactBarrel = function (this: Grid, team: TeamType, index: number, cell: XY): boolean {
    const placed = originalPlace.call(this, team, index, cell);
    if (!placed) return placed;
    live.settings = this.getSettings();
    const key = `${cell.x},${cell.y}`;
    live.cells.add(key);
    if (!live.teamByCell.has(key)) live.teamByCell.set(key, team);
    live.bySlot.set(`${team}:${index}`, team);
    return placed;
};

// Deployment reconcile removes a barrel through unplace. Combat destruction does not: it clears the
// scattered stone directly, so a strike later in the same turn still matches the cell recorded here.
const originalUnplace = Grid.prototype.unplaceArtifactBarrel;
Grid.prototype.unplaceArtifactBarrel = function (this: Grid, team: TeamType, index: number): boolean {
    const previous = this.getArtifactBarrels(team).find((barrel) => barrel.index === index);
    const removed = originalUnplace.call(this, team, index);
    if (!removed) return removed;
    live.bySlot.delete(`${team}:${index}`);
    if (previous) {
        const key = `${previous.cell.x},${previous.cell.y}`;
        live.cells.delete(key);
        live.teamByCell.delete(key);
    }
    return removed;
};

function resetLive(): void {
    live.settings = undefined;
    live.cells.clear();
    live.teamByCell.clear();
    live.bySlot.clear();
}

function cellKey(position: XY): string | undefined {
    if (!live.settings) return undefined;
    const cell = getCellForPosition(live.settings, position);
    return `${cell.x},${cell.y}`;
}

function bump(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function play(request: BarrelFightRequest): BarrelFightResult {
    resetLive();
    const prepared = prepareMetaPair(
        { cohort: request.cohort, games: request.matchupGames, baseSeed: request.baseSeed },
        request.pair,
    );
    const greenArmy = request.greenIsArmyA ? prepared.armyA : prepared.armyB;
    const redArmy = request.greenIsArmyA ? prepared.armyB : prepared.armyA;
    const barrelRejectionCounts: Record<string, number> = {};
    const otherRejectionCounts: Record<string, number> = {};
    const barrelRejectionSamples: string[] = [];
    let barrelStrikes = 0;
    let ownBarrelStrikes = 0;
    let enemyBarrelStrikes = 0;
    let barrelRejections = 0;
    let otherObstacleStrikes = 0;
    let otherObstacleRejections = 0;
    let classifiedRejections = 0;

    const note = (
        side: Side,
        creature: string,
        action: GameAction,
        completed: boolean,
        reason: string | undefined,
        countsAsRejection: boolean,
    ): void => {
        if (action.type === "place_barrel" || action.type === "unplace_barrel") {
            if (!countsAsRejection || completed) return;
            barrelRejections += 1;
            classifiedRejections += 1;
            const key = `${action.type} :: ${reason ?? "?"}`;
            bump(barrelRejectionCounts, key);
            if (barrelRejectionSamples.length < 3) {
                barrelRejectionSamples.push(`${creature} ${key}`);
            }
            return;
        }
        if (action.type !== "obstacle_attack") {
            if (!countsAsRejection || completed) return;
            classifiedRejections += 1;
            bump(otherRejectionCounts, `${action.type} :: ${reason ?? "?"}`);
            return;
        }
        const key = cellKey(action.targetPosition);
        const barrel = key !== undefined && live.cells.has(key);
        if (!barrel) {
            if (completed) otherObstacleStrikes += 1;
            else if (countsAsRejection) {
                otherObstacleRejections += 1;
                classifiedRejections += 1;
                bump(otherRejectionCounts, `obstacle_attack :: ${reason ?? "?"} :: not-barrel`);
            }
            return;
        }
        if (completed) {
            barrelStrikes += 1;
            const team = live.teamByCell.get(key!);
            const barrelSide: Side = team === GREEN_TEAM ? "green" : "red";
            if (barrelSide === side) ownBarrelStrikes += 1;
            else enemyBarrelStrikes += 1;
            return;
        }
        if (!countsAsRejection) return;
        barrelRejections += 1;
        classifiedRejections += 1;
        const rejectionKey = `obstacle_attack :: ${reason ?? "?"} :: barrel`;
        bump(barrelRejectionCounts, rejectionKey);
        if (barrelRejectionSamples.length < 3) {
            barrelRejectionSamples.push(`${creature} ${rejectionKey} @ ${key}`);
        }
    };

    const synergyVariants = aiMetaSynergyVariantsForPair(prepared.setupSeed, prepared.combatSeed);
    const configFor = (green: IAiMetaArmy, red: IAiMetaArmy) => {
        const greenSplit = materializeReplayAbSplits(
            green.roster,
            green.creatureIds,
            green.augment.augments,
            green.synergies,
        );
        const redSplit = materializeReplayAbSplits(red.roster, red.creatureIds, red.augment.augments, red.synergies);
        return {
            greenVersion: AI_META_FIGHT_VERSION,
            redVersion: AI_META_FIGHT_VERSION,
            roster: greenSplit.roster,
            redRoster: redSplit.roster,
            seed: prepared.combatSeed,
            gridType: prepared.map,
            greenDoctrine: green.doctrine,
            redDoctrine: red.doctrine,
            greenAugments: green.augment.augments,
            redAugments: red.augment.augments,
            greenArtifactT1: Tier1Artifact.BARREL_BARRICADE,
            redArtifactT1: Tier1Artifact.BARREL_BARRICADE,
            greenArtifactT2: green.artifactT2.id,
            redArtifactT2: red.artifactT2.id,
            greenSynergies: green.synergies,
            redSynergies: red.synergies,
            synergyVariants,
            greenTacticalSplitStacks: greenSplit.splitRoles,
            redTacticalSplitStacks: redSplit.splitRoles,
            placementAugmentTiming: "setup-before-placement" as const,
            sideOrientedPlacement: true,
            searchOfflineDeterministicWork: true,
            headlessEvents: true,
            ...createAiMetaMatchStrategyOverrides(AI_META_REGISTERED_VERSION_STRATEGY_PROFILE, {
                greenOpponentCreatureIds: red.creatureIds,
                redOpponentCreatureIds: green.creatureIds,
            }),
        };
    };

    const result = runMatch({
        ...configFor(greenArmy, redArmy),
        turnExecutionObserver: (observation) => {
            for (const executed of observation.strategyActions) {
                note(
                    observation.side,
                    observation.creatureName,
                    executed.action,
                    executed.completed,
                    executed.rejectionReason,
                    !executed.completed,
                );
            }
            for (const recovery of observation.recoveryAttempts) {
                if (!recovery.action || recovery.source !== "v0.1_retry") continue;
                note(
                    observation.side,
                    observation.creatureName,
                    recovery.action,
                    recovery.completed,
                    recovery.rejectionReason,
                    !recovery.completed,
                );
            }
        },
    });

    let placedGreen = 0;
    let placedRed = 0;
    for (const team of live.bySlot.values()) {
        if (team === GREEN_TEAM) placedGreen += 1;
        else placedRed += 1;
    }
    const engineRejections = (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0);
    const otherRejections = Math.max(0, classifiedRejections - barrelRejections - otherObstacleRejections);
    return {
        cohort: request.cohort,
        pair: request.pair,
        map: prepared.map,
        placed: placedGreen + placedRed,
        placedGreen,
        placedRed,
        greenRanged: greenArmy.features.ranged,
        redRanged: redArmy.features.ranged,
        barrelStrikes,
        ownBarrelStrikes,
        enemyBarrelStrikes,
        barrelRejections,
        otherObstacleStrikes,
        otherObstacleRejections,
        otherRejections,
        engineRejections,
        unclassifiedRejections: engineRejections - classifiedRejections,
        endReason: result.endReason,
        laps: result.laps,
        barrelRejectionCounts,
        otherRejectionCounts,
        barrelRejectionSamples,
    };
}

if (!parentPort) throw new Error("measure_barrel_use_worker must run in a worker thread");
startPersistentWorker(play);
