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

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { enumerateCandidates } from "../ai";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult } from "./battle_engine";
import { createKitOmissionTally, recordKitTurn, type IKitOmissionTally } from "./kit_omission_tally";

/**
 * Worker half of kit_omission_census.ts (W14 settlement instrument). Same two-file split as
 * measure_round1_misplay_census_worker.ts and for the same reason: the orchestrator needs league_eval.ts
 * (resolveLeaguePick) in the MAIN thread only — that module's top-level `if (!isMainThread)` side effect
 * would double-register a message handler on any worker that imports it. Workers receive fully-resolved,
 * plain-JSON IMatchConfigs and only run fights.
 *
 * Per-worker dataset shards arrive via workerData (NOT env, so shard paths cannot leak to the main
 * thread or to a nested SearchDriver in another worker):
 *   kitDatasetShard — per-turn legality/choice JSONL rows (the KIT_OMISSION_DATASET dump, env-gated in
 *                     the orchestrator; absent = tally only, no dump — no default impact).
 *   ilDatasetShard  — when the orchestrator runs under V07_SEARCH=1 + SEARCH_IL_DATASET (the EV-pricing
 *                     mode), each worker must write its own IL shard; this worker re-points its own
 *                     process.env copy at the shard before any match runs.
 */

if (!parentPort) throw new Error("kit_omission_census_worker must be run as a worker thread");

FightStateManager.getInstance();

const shardData = (workerData ?? {}) as { kitDatasetShard?: string; ilDatasetShard?: string };
if (shardData.ilDatasetShard) {
    // worker_threads copies the parent env per-thread; this mutation is local to this worker.
    process.env.SEARCH_IL_DATASET = shardData.ilDatasetShard;
}
if (shardData.kitDatasetShard) {
    mkdirSync(dirname(shardData.kitDatasetShard), { recursive: true });
}

function chosenClasses(actions: readonly GameAction[]): Set<string> {
    const classes = new Set<string>();
    for (const action of actions) {
        if (action.type === "wait_turn") classes.add("wait");
        else if (action.type === "defend_turn") classes.add("defend");
        else if (action.type === "move_unit") classes.add("move");
        else if (action.type === "melee_attack") classes.add("melee");
        else if (action.type === "range_attack") classes.add("shot");
        else if (action.type === "area_throw_attack") classes.add("area_throw");
        else if (action.type === "cast_spell") classes.add("spell");
    }
    return classes;
}

function chosenSpells(actions: readonly GameAction[]): Set<string> {
    return new Set(
        actions
            .filter((action) => action.type === "cast_spell")
            .map((action) => (action as Extract<GameAction, { type: "cast_spell" }>).spellName),
    );
}

function decisionShape(actions: readonly GameAction[]): string {
    const classes = [...chosenClasses(actions)].sort();
    if (classes.length) return classes.join("+");
    if (actions.some((action) => action.type === "obstacle_attack")) return "obstacle";
    if (actions.some((action) => action.type === "end_turn")) return "end";
    return "none";
}

/**
 * Extract per-turn capability sets from the live observation (enumerateCandidates as the legality
 * source, F4 complete and uncapped) and feed them to the pure accounting rule (recordKitTurn, see
 * kit_omission_tally.ts). This differs from misplay_audit.ts's census in keeping the CHOSEN side, so
 * the conditional omission rate (omitted / legal) and the live-comparable cast share (chosen / acting)
 * both exist.
 */
function observeDecision(tally: IKitOmissionTally, observation: IDecisionObservation, dumpRows: string[]): void {
    const incumbent = [...observation.incumbent];
    const candidateSet = enumerateCandidates(observation.unit, observation.context, incumbent);
    const alternatives = candidateSet.candidates.slice(1);
    const shape = decisionShape(incumbent);
    const creatureName = observation.unit.getName();

    // Capability key -> number of legal candidates this turn (0 allowed for a chosen-but-not-regenerated
    // capability: the generated twin dedupes into candidate 0, the incumbent anchor).
    const legalCaps = new Map<string, number>();
    for (const candidate of alternatives) {
        if (candidate.kind === "incumbent") continue;
        const key = candidate.kind === "spell" && candidate.spellName ? `spell:${candidate.spellName}` : candidate.kind;
        legalCaps.set(key, (legalCaps.get(key) ?? 0) + 1);
    }
    const chosenCaps = new Set<string>();
    for (const kind of chosenClasses(incumbent)) {
        if (kind !== "spell") chosenCaps.add(kind);
    }
    for (const spellName of chosenSpells(incumbent)) chosenCaps.add(`spell:${spellName}`);
    for (const key of chosenCaps) {
        if (!legalCaps.has(key)) legalCaps.set(key, 0);
    }

    const omittedCaps = recordKitTurn(tally, creatureName, shape, chosenCaps, legalCaps);
    if (candidateSet.truncated.length) {
        tally.truncatedTurns += 1;
    }

    if (shardData.kitDatasetShard) {
        dumpRows.push(
            JSON.stringify({
                t: "turn",
                seed: tally.currentSeed,
                lap: observation.context.fightProperties?.getCurrentLap() ?? 0,
                side: observation.unit.getTeam() === PBTypes.TeamVals.LOWER ? "green" : "red",
                unit: creatureName,
                shape,
                chosen: [...chosenCaps].sort(),
                legal: Object.fromEntries([...legalCaps.entries()].sort(([a], [b]) => a.localeCompare(b))),
                omitted: omittedCaps,
            }),
        );
    }
}

function recordOutcome(tally: IKitOmissionTally, result: IMatchResult): void {
    tally.games += 1;
    if (result.winner === "green") tally.outcomes.greenWins += 1;
    else if (result.winner === "red") tally.outcomes.redWins += 1;
    else tally.outcomes.draws += 1;
    tally.outcomes.totalLaps += result.laps;
    tally.outcomes.endReasons[result.endReason] = (tally.outcomes.endReasons[result.endReason] ?? 0) + 1;
}

function playGame(config: IMatchConfig): IKitOmissionTally {
    const tally = createKitOmissionTally();
    tally.currentSeed = config.seed;
    const dumpRows: string[] = [];
    const result = runMatch({
        ...config,
        decisionObserver: (observation) => observeDecision(tally, observation, dumpRows),
    });
    recordOutcome(tally, result);
    if (shardData.kitDatasetShard && dumpRows.length) {
        // One append per game keeps rows game-contiguous inside a shard; shards are per-worker files.
        appendFileSync(shardData.kitDatasetShard, `${dumpRows.join("\n")}\n`);
    }
    return tally;
}

parentPort.on("message", (message: { type: "game"; game: number; config: IMatchConfig } | { type: "stop" }) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({ type: "result", tally: playGame(message.config) });
    } catch (error) {
        parentPort!.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
    }
});

parentPort.postMessage({ type: "ready" });
