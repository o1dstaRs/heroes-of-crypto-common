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

import { parentPort, workerData } from "node:worker_threads";

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

interface IAiMetaWorkerData {
    options: IAiMetaRunOptions;
    strategyProfileId: AiMetaStrategyProfileId;
}

type WorkerRequest = { type: "pair"; pair: number } | { type: "stop" };
type WorkerResponse =
    { type: "ready" } | { type: "result"; record: IAiMetaPairRecord } | { type: "error"; error: string };

// Freeze the behavioral environment inside the isolate. Ambient experiment flags must not silently change a
// million-game balance run. SIM_NO_ACTIONS keeps worker messages small; all requested aggregate outcomes remain.
// The parent passes a sanitized Worker `env`, which takes effect before these static imports execute.
// Reassert the three fixed runtime controls as defense in depth.
process.env.SIM_NO_ACTIONS = "1";
process.env.LIVETWIN = "1";
process.env.FIGHT_MELEE_ROSTERS = "0";

const configFor = (
    green: IAiMetaArmy,
    red: IAiMetaArmy,
    seed: number,
    map: number,
    strategyProfileId: AiMetaStrategyProfileId,
    synergyVariants: ReturnType<typeof aiMetaSynergyVariantsForPair>,
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
        greenPerk: green.perk,
        redPerk: red.perk,
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
        ...createAiMetaMatchStrategyOverrides(strategyProfileId, {
            greenOpponentCreatureIds: red.creatureIds,
            redOpponentCreatureIds: green.creatureIds,
        }),
    };
};

function gameOutcome(result: IMatchResult, aIsGreen: boolean): IAiMetaGameOutcome {
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
}

export function playMetaPair(
    options: IAiMetaRunOptions,
    pair: number,
    strategyProfileId: AiMetaStrategyProfileId,
): IAiMetaPairRecord {
    const prepared = prepareMetaPair(options, pair);
    const synergyVariants = aiMetaSynergyVariantsForPair(prepared.setupSeed, prepared.combatSeed);
    FightStateManager.getInstance();
    const aGreen = runMatch(
        configFor(
            prepared.armyA,
            prepared.armyB,
            prepared.combatSeed,
            prepared.map,
            strategyProfileId,
            synergyVariants,
        ),
    );
    const bGreen = runMatch(
        configFor(
            prepared.armyB,
            prepared.armyA,
            prepared.combatSeed,
            prepared.map,
            strategyProfileId,
            synergyVariants,
        ),
    );
    return {
        ...prepared,
        games: [gameOutcome(aGreen, true), gameOutcome(bGreen, false)],
    };
}

if (!parentPort) throw new Error("ai_meta_cohorts_worker must run in a worker thread");
const { options, strategyProfileId } = workerData as IAiMetaWorkerData;

parentPort.on("message", (message: WorkerRequest) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({
            type: "result",
            record: playMetaPair(options, message.pair, strategyProfileId),
        } satisfies WorkerResponse);
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
        } satisfies WorkerResponse);
    }
});

parentPort.postMessage({ type: "ready" } satisfies WorkerResponse);
