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

/**
 * Pure tally primitives for the kit-omission census (see kit_omission_census.ts for the instrument's
 * contract). Kept in their own dependency-free module so BOTH the orchestrator (main thread) and the
 * worker can import them: the orchestrator must import league_eval.ts (resolveLeaguePick), whose
 * top-level `if (!isMainThread) workerMain(...)` side effect makes it unsafe to load on any worker
 * thread — the W13 census had to duplicate its accounting rule verbatim to dodge this; this module
 * removes the need to.
 */

export interface IKitCapabilityTally {
    legalTurns: number;
    chosenTurns: number;
    omittedTurns: number;
    /** Sum of generated candidates over legal turns (spell placements/targets multiply). */
    legalCandidates: number;
}

export interface IKitCreatureTally {
    actingTurns: number;
    anySpellLegalTurns: number;
    anySpellCastTurns: number;
    anySpellOmittedTurns: number;
    capabilities: Record<string, IKitCapabilityTally>;
    decisionShapes: Record<string, number>;
}

export interface IKitOmissionTally {
    games: number;
    actingUnitTurns: number;
    truncatedTurns: number;
    /** Seed of the game currently being played (worker-local bookkeeping for dump rows). */
    currentSeed: number;
    capabilities: Record<string, IKitCapabilityTally>;
    creatures: Record<string, IKitCreatureTally>;
    outcomes: {
        greenWins: number;
        redWins: number;
        draws: number;
        totalLaps: number;
        endReasons: Record<string, number>;
    };
}

export function createKitOmissionTally(): IKitOmissionTally {
    return {
        games: 0,
        actingUnitTurns: 0,
        truncatedTurns: 0,
        currentSeed: 0,
        capabilities: {},
        creatures: {},
        outcomes: { greenWins: 0, redWins: 0, draws: 0, totalLaps: 0, endReasons: {} },
    };
}

export function kitCapabilityFor(capabilities: Record<string, IKitCapabilityTally>, key: string): IKitCapabilityTally {
    return (capabilities[key] ??= { legalTurns: 0, chosenTurns: 0, omittedTurns: 0, legalCandidates: 0 });
}

export function kitCreatureFor(tally: IKitOmissionTally, name: string): IKitCreatureTally {
    return (tally.creatures[name] ??= {
        actingTurns: 0,
        anySpellLegalTurns: 0,
        anySpellCastTurns: 0,
        anySpellOmittedTurns: 0,
        capabilities: {},
        decisionShapes: {},
    });
}

/**
 * The W14-specced per-turn accounting rule, pure over pre-extracted capability sets:
 *   legal(cap)   = chosen OR generated as an alternative (candidate counts arrive in legalCapCounts;
 *                  a chosen capability whose generated twin deduped into the incumbent anchor is
 *                  entered with count 0 by the caller);
 *   chosen(cap)  = the incumbent decision used it;
 *   omitted(cap) = legal AND NOT chosen — at most once per acting turn per capability.
 * Returns the omitted keys (sorted) for the env-gated dump row.
 */
export function recordKitTurn(
    tally: IKitOmissionTally,
    creatureName: string,
    shape: string,
    chosenCaps: ReadonlySet<string>,
    legalCapCounts: ReadonlyMap<string, number>,
): string[] {
    const creature = kitCreatureFor(tally, creatureName);
    tally.actingUnitTurns += 1;
    creature.actingTurns += 1;
    creature.decisionShapes[shape] = (creature.decisionShapes[shape] ?? 0) + 1;

    let anySpellLegal = false;
    let anySpellChosen = false;
    const omitted: string[] = [];
    for (const [key, candidateCount] of legalCapCounts) {
        const chosen = chosenCaps.has(key);
        if (key.startsWith("spell:")) {
            anySpellLegal = true;
            if (chosen) anySpellChosen = true;
        }
        for (const capability of [
            kitCapabilityFor(tally.capabilities, key),
            kitCapabilityFor(creature.capabilities, key),
        ]) {
            capability.legalTurns += 1;
            capability.legalCandidates += candidateCount;
            if (chosen) capability.chosenTurns += 1;
            else capability.omittedTurns += 1;
        }
        if (!chosen) omitted.push(key);
    }
    if (anySpellLegal) {
        creature.anySpellLegalTurns += 1;
        if (anySpellChosen) creature.anySpellCastTurns += 1;
        else creature.anySpellOmittedTurns += 1;
    }
    return omitted.sort();
}

function mergeCapabilities(
    target: Record<string, IKitCapabilityTally>,
    source: Record<string, IKitCapabilityTally>,
): void {
    for (const [key, value] of Object.entries(source)) {
        const capability = kitCapabilityFor(target, key);
        capability.legalTurns += value.legalTurns;
        capability.chosenTurns += value.chosenTurns;
        capability.omittedTurns += value.omittedTurns;
        capability.legalCandidates += value.legalCandidates;
    }
}

function mergeNumbers(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

export function mergeKitOmissionTallies(target: IKitOmissionTally, source: IKitOmissionTally): void {
    target.games += source.games;
    target.actingUnitTurns += source.actingUnitTurns;
    target.truncatedTurns += source.truncatedTurns;
    mergeCapabilities(target.capabilities, source.capabilities);
    for (const [name, value] of Object.entries(source.creatures)) {
        const creature = kitCreatureFor(target, name);
        creature.actingTurns += value.actingTurns;
        creature.anySpellLegalTurns += value.anySpellLegalTurns;
        creature.anySpellCastTurns += value.anySpellCastTurns;
        creature.anySpellOmittedTurns += value.anySpellOmittedTurns;
        mergeCapabilities(creature.capabilities, value.capabilities);
        mergeNumbers(creature.decisionShapes, value.decisionShapes);
    }
    target.outcomes.greenWins += source.outcomes.greenWins;
    target.outcomes.redWins += source.outcomes.redWins;
    target.outcomes.draws += source.outcomes.draws;
    target.outcomes.totalLaps += source.outcomes.totalLaps;
    mergeNumbers(target.outcomes.endReasons, source.outcomes.endReasons);
}
