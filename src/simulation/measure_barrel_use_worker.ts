/*
 * Worker isolate for measure_barrel_use.ts.
 *
 * One game per task. Grid.placeArtifactBarrel is patched in this isolate only, because a patch in the
 * parent never sees worker games. Headless matches omit obstacle_attacked events, so a barrel strike is a
 * completed obstacle_attack whose target cell was recorded by that patch. Map cemetery stones never go
 * through placeArtifactBarrel, so they stay out of the barrel tally.
 */
import { createHash } from "node:crypto";
import { friendlyShotBlockingBarrels, projectBarrelShotTradeoff } from "../ai/artifact_barrel_tactics";
import { SearchDriver } from "./search_driver";
import { parentPort } from "node:worker_threads";

import { Tier1Artifact } from "../artifacts/artifact_properties";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { Grid } from "../grid/grid";
import {
    artifactBarrelPlacementCells,
    artifactBarrelShooterCells,
    autoPlaceArtifactBarrels,
} from "../grid/artifact_barrels";
import type { GridSettings } from "../grid/grid_settings";
import { getCellForPosition } from "../grid/grid_math";
import type { XY } from "../utils/math";
import type { GameAction } from "../engine/actions";
import { GREEN_TEAM, RED_TEAM, runMatch, type Side } from "./battle_engine";
import {
    AI_META_FIGHT_VERSION,
    aiMetaSynergyVariantsForPair,
    prepareMetaPair,
    type AiMetaCohort,
    type IAiMetaArmy,
    type AiMetaMap,
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
    /** Setup-only research probe; its response has kind=deployment-probe and is never a fight result. */
    deploymentOnly?: boolean;
    experiment?: {
        id: string;
        cluster: number;
        treatment: boolean;
        ownership: "both" | "candidate" | "opponent" | "neither" | "value-swap";
        map: 1 | 2 | 3 | 4;
        timing: "work" | "live";
        policy?: "exact" | "own" | "placement";
        study?: "artifact-value";
        competitorArtifact?: number;
        counterfactualShots?: boolean;
    };
}

export interface BarrelFightResult {
    cohort: AiMetaCohort;
    pair: number;
    map: number;
    experiment?: BarrelFightRequest["experiment"];
    winner: Side | "draw";
    candidateSide: Side;
    candidateScore: number;
    elapsedMs: number;
    ownBarrelStrikesBySide: Record<Side, number>;
    artifacts?: Record<Side, number>;
    diagnostics?: {
        actionSha256: string;
        ownClears: Record<Side, { opensShot: number; removesCover: number; neither: number; both: number }>;
        searchTiming: Record<Side, { decisions: number; p95Ms: number; maxMs: number; over1000Ms: number }>;
        deployment?: Record<Side, { cells: XY[]; blockedShooterFiles: number; blockedShots: number }>;
        counterfactualOwnClears?: Record<
            Side,
            {
                clears: number;
                friendlyDamageGain: number;
                enemyDamageGain: number;
                actingUnitShotForgone: number;
                firstBlockerWithoutGain: number;
                coverLostWithoutGain: number;
            }
        >;
    };
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

export interface BarrelDeploymentProbeResult {
    kind: "deployment-probe";
    request: BarrelFightRequest;
    legacy: Record<Side, XY[]>;
    clearLanes: Record<Side, XY[]>;
    changedSides: Side[];
}

class CompletedDeploymentProbe extends Error {
    public constructor(public readonly result: BarrelDeploymentProbeResult) {
        super("Deployment probe complete");
    }
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

// Worker-local, observational timing: no callback runs inside the timed production selector.
let decisionTimes: Record<Side, number[]> | undefined;
const originalChoose = SearchDriver.prototype.chooseDecision;
SearchDriver.prototype.chooseDecision = function (...args: Parameters<typeof originalChoose>) {
    if (!decisionTimes) return originalChoose.apply(this, args);
    const start = performance.now();
    try {
        return originalChoose.apply(this, args);
    } finally {
        decisionTimes[args[0].getTeam() === GREEN_TEAM ? "green" : "red"].push(performance.now() - start);
    }
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
    const started = performance.now();
    const experiment = request.experiment;
    const candidateSide: Side = request.greenIsArmyA ? "green" : "red";
    const candidateTeam = request.greenIsArmyA ? GREEN_TEAM : RED_TEAM;
    const ownBarrelStrikesBySide = { green: 0, red: 0 };
    const ownClears = {
        green: { opensShot: 0, removesCover: 0, neither: 0, both: 0 },
        red: { opensShot: 0, removesCover: 0, neither: 0, both: 0 },
    };
    let shotBlockers: Record<Side, ReadonlySet<string>> = { green: new Set(), red: new Set() };
    let shotTradeoffs = new Map<string, ReturnType<typeof projectBarrelShotTradeoff>>();
    let actingUnitId = "";
    const counterfactualOwnClears = {
        green: {
            clears: 0,
            friendlyDamageGain: 0,
            enemyDamageGain: 0,
            actingUnitShotForgone: 0,
            firstBlockerWithoutGain: 0,
            coverLostWithoutGain: 0,
        },
        red: {
            clears: 0,
            friendlyDamageGain: 0,
            enemyDamageGain: 0,
            actingUnitShotForgone: 0,
            firstBlockerWithoutGain: 0,
            coverLostWithoutGain: 0,
        },
    };
    const actionHash = createHash("sha256");
    const times: Record<Side, number[]> = { green: [], red: [] };
    let deployment: NonNullable<BarrelFightResult["diagnostics"]>["deployment"];
    decisionTimes = experiment ? times : undefined;
    const prepared = prepareMetaPair(
        { cohort: request.cohort, games: request.matchupGames, baseSeed: request.baseSeed },
        request.pair,
        // Water is an explicit qualification map, outside the ordinary three-map meta schedule.
        experiment?.map as AiMetaMap | undefined,
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
            if (barrelSide === side) {
                ownBarrelStrikes += 1;
                ownBarrelStrikesBySide[side] += 1;
                const opensShot = shotBlockers[side].has(key!);
                const removesCover = shotBlockers[side === "green" ? "red" : "green"].has(key!);
                if (opensShot) ownClears[side].opensShot += 1;
                if (removesCover) ownClears[side].removesCover += 1;
                if (opensShot && removesCover) ownClears[side].both += 1;
                if (!opensShot && !removesCover) ownClears[side].neither += 1;
                const tradeoff = shotTradeoffs.get(key!);
                if (tradeoff) {
                    const stats = counterfactualOwnClears[side];
                    const friendlyGain = tradeoff
                        .filter((row) => row.team === team)
                        .reduce((sum, row) => sum + row.gain, 0);
                    const enemyGain = tradeoff
                        .filter((row) => row.team !== team)
                        .reduce((sum, row) => sum + row.gain, 0);
                    stats.clears++;
                    stats.friendlyDamageGain += friendlyGain;
                    stats.enemyDamageGain += enemyGain;
                    stats.actingUnitShotForgone += tradeoff.find((row) => row.unitId === actingUnitId)?.before ?? 0;
                    stats.firstBlockerWithoutGain += Number(opensShot && friendlyGain <= 1e-9);
                    stats.coverLostWithoutGain += Number(enemyGain > 1e-9 && friendlyGain <= 1e-9);
                }
            } else enemyBarrelStrikes += 1;
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

    const hasBarrels = (side: Side): boolean =>
        !experiment ||
        experiment.ownership === "both" ||
        (experiment.ownership === "candidate" && side === candidateSide) ||
        (experiment.ownership === "opponent" && side !== candidateSide);
    // Swap only Tier-1 between the same two armies; setup, Tier-2 and combat RNG stay fixed.
    const artifactFor = (side: Side): number =>
        experiment?.study === "artifact-value"
            ? (side === candidateSide) === experiment.treatment
                ? Tier1Artifact.BARREL_BARRICADE
                : experiment.competitorArtifact!
            : hasBarrels(side)
              ? Tier1Artifact.BARREL_BARRICADE
              : 0;
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
            greenArtifactT1: artifactFor("green"),
            redArtifactT1: artifactFor("red"),
            greenArtifactT2: green.artifactT2.id,
            redArtifactT2: red.artifactT2.id,
            greenSynergies: green.synergies,
            redSynergies: red.synergies,
            synergyVariants,
            greenTacticalSplitStacks: greenSplit.splitRoles,
            redTacticalSplitStacks: redSplit.splitRoles,
            placementAugmentTiming: "setup-before-placement" as const,
            sideOrientedPlacement: true,
            searchOfflineDeterministicWork: experiment?.timing !== "live",
            ...(experiment?.treatment && !experiment.study && experiment.policy !== "placement"
                ? { searchEnvOverrideTeams: [candidateTeam as TeamType] }
                : {}),
            headlessEvents: true,
            ...createAiMetaMatchStrategyOverrides(AI_META_REGISTERED_VERSION_STRATEGY_PROFILE, {
                greenOpponentCreatureIds: red.creatureIds,
                redOpponentCreatureIds: green.creatureIds,
            }),
        };
    };

    const previousOverrides = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    if (experiment?.treatment && !experiment.study && experiment.policy !== "placement")
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
            SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION: experiment.policy === "own" ? "own" : "1",
        });
    else delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    let result: ReturnType<typeof runMatch>;
    try {
        result = runMatch({
            ...configFor(greenArmy, redArmy),
            beforeFightStart:
                request.deploymentOnly || experiment?.policy === "placement"
                    ? (context) => {
                          const { grid, fightProperties: fp, unitsHolder, attackHandler } = context;
                          if (request.deploymentOnly) {
                              const place = (policy: "legacy" | "clear-lanes") => {
                                  for (const team of [GREEN_TEAM, RED_TEAM]) grid.clearArtifactBarrels(team);
                                  for (const team of [GREEN_TEAM, RED_TEAM])
                                      autoPlaceArtifactBarrels(
                                          grid,
                                          fp,
                                          team,
                                          artifactBarrelPlacementCells(grid, fp, team),
                                          artifactBarrelShooterCells(grid, unitsHolder.getAllUnits().values(), team),
                                          policy,
                                      );
                                  return {
                                      green: grid.getArtifactBarrels(GREEN_TEAM).map((barrel) => barrel.cell),
                                      red: grid.getArtifactBarrels(RED_TEAM).map((barrel) => barrel.cell),
                                  };
                              };
                              const legacy = place("legacy");
                              const clearLanes = place("clear-lanes");
                              throw new CompletedDeploymentProbe({
                                  kind: "deployment-probe",
                                  request,
                                  legacy,
                                  clearLanes,
                                  changedSides: (["green", "red"] as const).filter(
                                      (side) => JSON.stringify(legacy[side]) !== JSON.stringify(clearLanes[side]),
                                  ),
                              });
                          }
                          for (const team of [GREEN_TEAM, RED_TEAM]) {
                              autoPlaceArtifactBarrels(
                                  grid,
                                  fp,
                                  team,
                                  artifactBarrelPlacementCells(grid, fp, team),
                                  artifactBarrelShooterCells(grid, unitsHolder.getAllUnits().values(), team),
                                  experiment!.treatment && team === candidateTeam ? "clear-lanes" : "legacy",
                              );
                          }
                          deployment = Object.fromEntries(
                              (["green", "red"] as const).map((side) => {
                                  const team = side === "green" ? GREEN_TEAM : RED_TEAM;
                                  const cells = grid.getArtifactBarrels(team).map((barrel) => barrel.cell);
                                  const shooters = artifactBarrelShooterCells(
                                      grid,
                                      unitsHolder.getAllUnits().values(),
                                      team,
                                  );
                                  const shots = friendlyShotBlockingBarrels(team, grid, unitsHolder, attackHandler!);
                                  return [
                                      side,
                                      {
                                          cells,
                                          blockedShooterFiles: cells.filter((barrel) =>
                                              shooters.some(
                                                  (shooter) =>
                                                      barrel.y === shooter.y &&
                                                      (team === GREEN_TEAM
                                                          ? barrel.x > shooter.x
                                                          : barrel.x < shooter.x),
                                              ),
                                          ).length,
                                          blockedShots: cells.filter((cell) => shots.has(`${cell.x},${cell.y}`)).length,
                                      },
                                  ];
                              }),
                          ) as NonNullable<BarrelFightResult["diagnostics"]>["deployment"];
                      }
                    : undefined,
            decisionObserver: experiment
                ? ({ context, unit }) => {
                      if (!context.attackHandler)
                          throw new Error("Barrel diagnostics require the combat attack handler");
                      shotBlockers = {
                          green: friendlyShotBlockingBarrels(
                              GREEN_TEAM,
                              context.grid,
                              context.unitsHolder,
                              context.attackHandler,
                          ),
                          red: friendlyShotBlockingBarrels(
                              RED_TEAM,
                              context.grid,
                              context.unitsHolder,
                              context.attackHandler,
                          ),
                      };
                      actingUnitId = unit.getId();
                      shotTradeoffs = experiment.counterfactualShots
                          ? new Map(
                                context.grid
                                    .getArtifactBarrels()
                                    .map(({ cell }) => [
                                        `${cell.x},${cell.y}`,
                                        projectBarrelShotTradeoff(context, cell),
                                    ]),
                            )
                          : new Map();
                  }
                : undefined,
            turnExecutionObserver: (observation) => {
                if (experiment)
                    actionHash.update(
                        JSON.stringify([
                            observation.side,
                            observation.creatureName,
                            observation.chosenDecision,
                            observation.strategyActions.map(({ completed, rejectionReason }) => [
                                completed,
                                rejectionReason,
                            ]),
                        ]),
                    );
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
    } finally {
        decisionTimes = undefined;
        if (previousOverrides === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
        else process.env.V08_A19_SEARCH_ENV_OVERRIDES = previousOverrides;
    }
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
        experiment,
        winner: result.winner,
        candidateSide,
        candidateScore: result.winner === "draw" ? 0.5 : Number(result.winner === candidateSide),
        elapsedMs: performance.now() - started,
        ownBarrelStrikesBySide,
        artifacts: { green: artifactFor("green"), red: artifactFor("red") },
        ...(experiment
            ? {
                  diagnostics: {
                      actionSha256: actionHash.digest("hex"),
                      ownClears,
                      deployment,
                      ...(experiment.counterfactualShots ? { counterfactualOwnClears } : {}),
                      searchTiming: Object.fromEntries(
                          (["green", "red"] as const).map((side) => {
                              const sorted = times[side].sort((a, b) => a - b);
                              return [
                                  side,
                                  {
                                      decisions: sorted.length,
                                      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
                                      maxMs: sorted.at(-1) ?? 0,
                                      over1000Ms: sorted.filter((ms) => ms > 1000).length,
                                  },
                              ];
                          }),
                      ) as NonNullable<BarrelFightResult["diagnostics"]>["searchTiming"],
                  },
              }
            : {}),
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
startPersistentWorker((request: BarrelFightRequest): BarrelFightResult | BarrelDeploymentProbeResult => {
    try {
        return play(request);
    } catch (error) {
        if (error instanceof CompletedDeploymentProbe) return error.result;
        throw error;
    }
});
