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

import { parentPort } from "node:worker_threads";

import { enumerateCandidates, type CandidateKind, type ICandidateSet } from "../ai";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult } from "./battle_engine";
import { createMisplayAuditTally, type IMisplayAuditTally } from "./misplay_audit";

/**
 * Worker half of measure_round1_misplay_census.ts. Deliberately does NOT import league_eval.ts (or
 * anything that does): that module has its own `if (!isMainThread) workerMain(...)` top-level side
 * effect, which — because `isMainThread` is a per-THREAD global, not a per-module one — would silently
 * register a second, wrongly-shaped message handler on this worker's parentPort the moment it was
 * imported here, racing the real handler below. The orchestrator resolves every pick_sim draft in the
 * MAIN thread (cheap — see measure_round1_draft_distribution.ts, ~2000 drafts in well under a second)
 * and ships each worker a fully-resolved, plain-JSON IMatchConfig; this file only ever runs fights.
 */

if (!parentPort) throw new Error("measure_round1_misplay_census_worker must be run as a worker thread");

FightStateManager.getInstance();

interface IOpportunityCounter {
    opportunityTurns: number;
    alternativeCandidates: number;
}
const emptyCounter = (): IOpportunityCounter => ({ opportunityTurns: 0, alternativeCandidates: 0 });
function counterFor(counters: Record<string, IOpportunityCounter>, key: string): IOpportunityCounter {
    return (counters[key] ??= emptyCounter());
}
function increment(record: Record<string, number>, key: string, amount = 1): void {
    record[key] = (record[key] ?? 0) + amount;
}
function incumbentClasses(actions: readonly GameAction[]): Set<string> {
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
function incumbentSpells(actions: readonly GameAction[]): Set<string> {
    return new Set(
        actions
            .filter((action) => action.type === "cast_spell")
            .map((action) => (action as Extract<GameAction, { type: "cast_spell" }>).spellName),
    );
}
function decisionShape(actions: readonly GameAction[]): string {
    const classes = [...incumbentClasses(actions)].sort();
    if (classes.length) return classes.join("+");
    if (actions.some((action) => action.type === "obstacle_attack")) return "obstacle";
    if (actions.some((action) => action.type === "end_turn")) return "end";
    return "none";
}
function creatureFor(tally: IMisplayAuditTally, name: string) {
    return (tally.creatures[name] ??= {
        actingTurns: 0,
        alternativeCandidates: 0,
        opportunities: {},
        opportunityCandidates: {},
        incumbentDecisionShapes: {},
    });
}

/** Same accounting rule as misplay_audit.ts's observeMisplayDecision, minus the version filter (both
 * seats always share one fightVersion in this census, so every observation is in-scope). */
function observeDecision(tally: IMisplayAuditTally, observation: IDecisionObservation): void {
    const incumbent = [...observation.incumbent];
    const candidateSet: ICandidateSet = enumerateCandidates(observation.unit, observation.context, incumbent);
    const alternatives = candidateSet.candidates.slice(1);
    const incumbentKindSet = incumbentClasses(incumbent);
    const incumbentSpellSet = incumbentSpells(incumbent);
    const missedCapabilities = new Set<string>();
    const shape = decisionShape(incumbent);
    const creature = creatureFor(tally, observation.unit.getName());

    tally.actingUnitTurns += 1;
    tally.alternativeCandidates += alternatives.length;
    increment(tally.incumbentDecisionShapes, shape);
    creature.actingTurns += 1;
    creature.alternativeCandidates += alternatives.length;
    increment(creature.incumbentDecisionShapes, shape);

    const alternativesByKind = new Map<CandidateKind, number>();
    const alternativesBySpell = new Map<string, number>();
    for (const candidate of alternatives) {
        alternativesByKind.set(candidate.kind, (alternativesByKind.get(candidate.kind) ?? 0) + 1);
        if (candidate.kind === "spell" && candidate.spellName) {
            alternativesBySpell.set(candidate.spellName, (alternativesBySpell.get(candidate.spellName) ?? 0) + 1);
        }
    }
    for (const [kind, count] of alternativesByKind) {
        if (kind === "incumbent") continue;
        const classCounter = counterFor(tally.classCounters, kind);
        classCounter.alternativeCandidates += count;
        if (!incumbentKindSet.has(kind)) {
            classCounter.opportunityTurns += 1;
            if (kind !== "spell") {
                const capability = counterFor(tally.capabilityCounters, kind);
                capability.opportunityTurns += 1;
                capability.alternativeCandidates += count;
                missedCapabilities.add(kind);
            }
        }
    }
    for (const [spellName, count] of alternativesBySpell) {
        const spellCounter = counterFor(tally.spellCounters, spellName);
        spellCounter.alternativeCandidates += count;
        if (!incumbentSpellSet.has(spellName)) {
            spellCounter.opportunityTurns += 1;
            const key = `spell:${spellName}`;
            const capability = counterFor(tally.capabilityCounters, key);
            capability.opportunityTurns += 1;
            capability.alternativeCandidates += count;
            missedCapabilities.add(key);
        }
    }
    for (const capability of missedCapabilities) {
        increment(creature.opportunities, capability);
        const candidateCount = capability.startsWith("spell:")
            ? (alternativesBySpell.get(capability.slice("spell:".length)) ?? 0)
            : (alternativesByKind.get(capability as CandidateKind) ?? 0);
        increment(creature.opportunityCandidates, capability, candidateCount);
    }
    if (candidateSet.truncated.length) {
        tally.truncatedTurns += 1;
        for (const kind of candidateSet.truncated) increment(tally.truncatedClasses, kind);
    }
}

function recordOutcome(tally: IMisplayAuditTally, result: IMatchResult): void {
    tally.games += 1;
    if (result.winner === "green") tally.outcomes.greenWins += 1;
    else if (result.winner === "red") tally.outcomes.redWins += 1;
    else tally.outcomes.draws += 1;
    tally.outcomes.totalLaps += result.laps;
    increment(tally.outcomes.endReasons, result.endReason);
}

function playGame(config: IMatchConfig): IMisplayAuditTally {
    const tally = createMisplayAuditTally();
    const result = runMatch({ ...config, decisionObserver: (observation) => observeDecision(tally, observation) });
    recordOutcome(tally, result);
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
