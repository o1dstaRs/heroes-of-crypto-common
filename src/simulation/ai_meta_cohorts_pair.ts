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

import { FightStateManager } from "../fights/fight_state_manager";
import { runMatch, type IMatchResult, type Side } from "./battle_engine";
import {
    AI_META_FIGHT_VERSION,
    aiMetaSynergyVariantsForPair,
    prepareMetaPair,
    type IAiMetaArmy,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
    type IAiMetaRunOptions,
} from "./ai_meta_cohorts_core";
import { createAiMetaMatchStrategyOverrides, type AiMetaStrategyProfileId } from "./ai_meta_strategy_profile";
import { materializeReplayAbSplits } from "./ranked_replay_tactics_ab_core";
import { deterministicSimulationId } from "./army";
import { PBTypes } from "../generated/protobuf/v1/types";
import { validateAiMetaEvidence, type IAiMetaFightEvidence, type IAiMetaFormationEvidence } from "./ai_meta_evidence";
import { summarizePremiumParticipation } from "./ai_meta_participation";
import { summarizePremiumCombatMetrics } from "./ai_meta_combat_metrics";

export const aiMetaMatchConfig = (
    green: IAiMetaArmy,
    red: IAiMetaArmy,
    seed: number,
    map: number,
    strategyProfileId: AiMetaStrategyProfileId,
    synergyVariants: ReturnType<typeof aiMetaSynergyVariantsForPair>,
    rankedSides = false,
): Parameters<typeof runMatch>[0] => {
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
        seed,
        gridType: map,
        greenDoctrine: green.doctrine,
        redDoctrine: red.doctrine,
        greenAugments: green.augment.augments,
        redAugments: red.augment.augments,
        greenArtifactT1: green.artifactT1.id,
        redArtifactT1: red.artifactT1.id,
        greenArtifactT2: green.artifactT2.id,
        redArtifactT2: red.artifactT2.id,
        greenSynergies: green.synergies,
        redSynergies: red.synergies,
        synergyVariants,
        greenTacticalSplitStacks: greenSplit.splitRoles,
        redTacticalSplitStacks: redSplit.splitRoles,
        placementAugmentTiming: "setup-before-placement",
        headlessEvents: true,
        ...(rankedSides
            ? {
                  sideOrientedPlacement: true,
                  greenPublicOpponentCreatures: red.creatureIds,
                  redPublicOpponentCreatures: green.creatureIds,
              }
            : {}),
        ...createAiMetaMatchStrategyOverrides(strategyProfileId, {
            greenOpponentCreatureIds: red.creatureIds,
            redOpponentCreatureIds: green.creatureIds,
        }),
    };
};

const gameOutcome = (result: IMatchResult, aIsGreen: boolean): IAiMetaGameOutcome => {
    const sideA: Side = aIsGreen ? "green" : "red";
    const winner = result.winner === "draw" ? "draw" : result.winner === sideA ? "a" : "b";
    const outcomeA = aIsGreen ? result.outcome.green : result.outcome.red;
    const outcomeB = aIsGreen ? result.outcome.red : result.outcome.green;
    return {
        aIsGreen,
        winner,
        laps: result.laps,
        endReason: result.endReason,
        armageddonDecided: result.attrition.decidedByArmageddon,
        rejectedA: aIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
        rejectedB: aIsGreen ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0),
        hpA: outcomeA.hpRemaining,
        hpB: outcomeB.hpRemaining,
        survivorsA: outcomeA.unitsAlive,
        survivorsB: outcomeB.unitsAlive,
    };
};

/** Run one deterministic pair. Kept transport-free so thread and process pools execute identical combat code. */
export function playMetaPair(
    options: IAiMetaRunOptions,
    pair: number,
    strategyProfileId: AiMetaStrategyProfileId,
    offlineDeterministicWork = false,
): IAiMetaPairRecord {
    if (options.collectEvidence && !offlineDeterministicWork) {
        throw new Error("AI meta evidence requires a19-work: recording must not change a wall-clock search budget");
    }
    // runMatch is synchronous and workers have isolated environments. Restore even on an engine failure.
    const previousNoActions = process.env.SIM_NO_ACTIONS;
    const previousSpellEffects = process.env.SIM_RECORD_SPELL_EFFECTS;
    if (options.collectEvidence) {
        delete process.env.SIM_NO_ACTIONS;
        process.env.SIM_RECORD_SPELL_EFFECTS = "1";
    }
    try {
        const record = playMetaPairInner(options, pair, strategyProfileId, offlineDeterministicWork);
        if (options.collectEvidence) validateAiMetaEvidence(record);
        return record;
    } finally {
        if (previousNoActions === undefined) delete process.env.SIM_NO_ACTIONS;
        else process.env.SIM_NO_ACTIONS = previousNoActions;
        if (previousSpellEffects === undefined) delete process.env.SIM_RECORD_SPELL_EFFECTS;
        else process.env.SIM_RECORD_SPELL_EFFECTS = previousSpellEffects;
    }
}

function fightEvidence(
    result: IMatchResult,
    config: Parameters<typeof runMatch>[0],
    green: IAiMetaArmy,
    red: IAiMetaArmy,
    aIsGreen: boolean,
): IAiMetaFightEvidence {
    const formation = (side: Side, army: IAiMetaArmy): IAiMetaFormationEvidence => {
        const roster = side === "green" ? config.roster : config.redRoster;
        if (!roster) throw new Error("AI meta evidence requires both materialized rosters");
        const team = side === "green" ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
        return {
            expandedRoster: roster,
            unitIdsByStack: roster.map((spec, index) =>
                deterministicSimulationId(
                    "roster",
                    config.seed,
                    team,
                    index,
                    spec.faction,
                    spec.creatureName,
                    spec.amount,
                ),
            ),
            draftedCreatureIdsByStack: roster.map((unit) => {
                const index = army.roster.findIndex((drafted) => drafted.creatureName === unit.creatureName);
                if (index < 0) throw new Error("AI meta split has no drafted ancestor");
                return army.creatureIds[index];
            }),
            splitRoles: [
                ...((side === "green" ? config.greenTacticalSplitStacks : config.redTacticalSplitStacks) ?? []),
            ],
            placements: result.placements[side],
            augments: army.augment.augments,
        };
    };
    const greenFormation = formation("green", green);
    const redFormation = formation("red", red);
    return {
        aIsGreen,
        formations: { a: aIsGreen ? greenFormation : redFormation, b: aIsGreen ? redFormation : greenFormation },
        actions: result.actions,
        totalActions: result.totalActions,
        outcome: result.outcome,
        attrition: result.attrition,
        telemetryScope: "accepted-action-events-not-complete-damage-attribution",
    };
}

export function capturePremiumFight(config: Parameters<typeof runMatch>[0], enabled: boolean) {
    let captureTerminalState: (() => NonNullable<IAiMetaFightEvidence["terminalState"]>) | undefined;
    let firstDecisionState: IAiMetaFightEvidence["firstDecisionState"];
    const committedEventBatches: NonNullable<IAiMetaFightEvidence["committedEventBatches"]> = [];
    const healthLedger: NonNullable<IAiMetaFightEvidence["healthLedger"]> = [];
    const executionTrace: NonNullable<IAiMetaFightEvidence["executionTrace"]> = [];
    const result = runMatch(
        enabled
            ? {
                  ...config,
                  decisionObserver: ({ unit, context }) => {
                      if (firstDecisionState) return;
                      captureTerminalState = () => ({
                          stage: "after-simulation",
                          units: [...context.unitsHolder.getAllUnits().values()].map((member) => ({
                              properties: structuredClone(member.getUnitProperties()),
                              cells: structuredClone(member.getCells()),
                              cumulativeHp: member.getCumulativeHp(),
                              alive: !member.isDead(),
                          })),
                          damageStatistics: context.attackHandler
                              ? structuredClone(context.attackHandler.damageStatisticHolder.get())
                              : null,
                          damageScope: "engine-display-by-creature-team-lap-not-complete-attribution",
                      });
                      firstDecisionState = {
                          stage: "first-decision-after-start",
                          actingUnitId: unit.getId(),
                          lap: context.fightProperties?.getCurrentLap() ?? 0,
                          board: {
                              gridType: context.grid.getGridType(),
                              matrix: structuredClone(context.grid.getMatrix()),
                              artifactBarrels: context.grid.getArtifactBarrels(),
                              mountainsStanding: structuredClone(context.grid.getScatteredMountainsStanding()),
                          },
                          units: [...context.unitsHolder.getAllUnits().values()].map((member) => ({
                              properties: structuredClone(member.getUnitProperties()),
                              cells: structuredClone(member.getCells()),
                          })),
                      };
                  },
                  committedEventsObserver: (observation) => committedEventBatches.push(observation),
                  committedHealthObserver: (observation) => healthLedger.push(observation),
                  turnExecutionObserver: (observation) => {
                      executionTrace.push(structuredClone(observation));
                  },
              }
            : config,
    );
    return {
        result,
        ...(enabled
            ? {
                  firstDecisionState,
                  executionTrace,
                  committedEventBatches,
                  healthLedger,
                  terminalState: captureTerminalState?.(),
              }
            : {}),
    };
}

function playMetaPairInner(
    options: IAiMetaRunOptions,
    pair: number,
    strategyProfileId: AiMetaStrategyProfileId,
    offlineDeterministicWork: boolean,
): IAiMetaPairRecord {
    const prepared = prepareMetaPair(options, pair);
    const synergyVariants = aiMetaSynergyVariantsForPair(prepared.setupSeed, prepared.combatSeed);
    // Finite search budgets replace the live move deadline, so outcomes stop depending on host speed and load.
    const searchBudget = offlineDeterministicWork ? { searchOfflineDeterministicWork: true } : {};
    FightStateManager.getInstance();
    const aConfig = {
        ...aiMetaMatchConfig(
            prepared.armyA,
            prepared.armyB,
            prepared.combatSeed,
            prepared.map,
            strategyProfileId,
            synergyVariants,
            prepared.evidence?.geometry.orientation === "ranked-sides",
        ),
        ...searchBudget,
        ...(options.collectEvidence ? { headlessEvents: false } : {}),
    };
    const aCapture = capturePremiumFight(aConfig, Boolean(options.studyProfile));
    const aGreen = aCapture.result;
    const bConfig = {
        ...aiMetaMatchConfig(
            prepared.armyB,
            prepared.armyA,
            prepared.combatSeed,
            prepared.map,
            strategyProfileId,
            synergyVariants,
            prepared.evidence?.geometry.orientation === "ranked-sides",
        ),
        ...searchBudget,
        ...(options.collectEvidence ? { headlessEvents: false } : {}),
    };
    const bCapture = capturePremiumFight(bConfig, Boolean(options.studyProfile));
    const bGreen = bCapture.result;
    const record: IAiMetaPairRecord = {
        ...prepared,
        games: [gameOutcome(aGreen, true), gameOutcome(bGreen, false)],
        ...(prepared.evidence
            ? {
                  evidence: {
                      ...prepared.evidence,
                      fights: [
                          {
                              ...fightEvidence(aGreen, aConfig, prepared.armyA, prepared.armyB, true),
                              firstDecisionState: aCapture.firstDecisionState,
                              committedEventBatches: aCapture.committedEventBatches,
                              healthLedger: aCapture.healthLedger,
                              terminalState: aCapture.terminalState,
                              executionTrace: aCapture.executionTrace,
                          },
                          {
                              ...fightEvidence(bGreen, bConfig, prepared.armyB, prepared.armyA, false),
                              firstDecisionState: bCapture.firstDecisionState,
                              committedEventBatches: bCapture.committedEventBatches,
                              healthLedger: bCapture.healthLedger,
                              terminalState: bCapture.terminalState,
                              executionTrace: bCapture.executionTrace,
                          },
                      ],
                  },
              }
            : {}),
    };
    for (const fight of record.evidence?.fights ?? [])
        if (fight.committedEventBatches) {
            fight.participation = summarizePremiumParticipation(fight);
            fight.combatMetrics = summarizePremiumCombatMetrics(fight);
        }
    return record;
}
