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

import { a19CounterDraftGateOpen, a19CounterDraftScore } from "./a19_counter_draft";
import { creatureInfo } from "./creature_score";

/**
 * a19-closing-pick-synergy-v1, "closing pick v2" (the owner: "We need a stronger AI that is able to catch and close
 * picks"; "Draft is super important. Especially last lvl4 pick").
 *
 * At the seat's level-4 pick, its last creature pick, when the counter-draft gate is shut but the seat sees at least one
 * opposing creature (only legally visible creatures may be passed), every creature on offer is scored with the counter
 * draft's matchup model (a19CounterDraftScore) plus a synergy bonus. The best replaces the current choice when it scores
 * at least A19_CLOSING_PICK_MARGIN above it, bonus included; otherwise the current choice stands. The Queen counter keeps
 * priority: the caller applies it after this rule. See docs/closing_pick_adoption.md.
 */
export const A19_CLOSING_PICK_POLICY = "a19-closing-pick-synergy-v1" as const;
/** Predicted win probability the best offer must add over the current choice. */
export const A19_CLOSING_PICK_MARGIN = 0.05;
/** Bonus when the creature would be its faction's second distinct creature in the army. */
export const A19_CLOSING_PICK_SECOND_OF_FACTION = 0.04;
/** Bonus when it would be the faction's fourth distinct creature, by faction (Chaos 1, Might 2, Nature 3, Life 4). */
export const A19_CLOSING_PICK_FOURTH_OF_FACTION: Readonly<Record<number, number>> = Object.freeze({
    1: 0.005,
    2: 0.0175,
    3: 0.0075,
    4: 0.045,
});
const LEVEL = 4;
const QUOTA: Readonly<Record<number, number>> = { 1: 2, 2: 2, 3: 1, 4: 1 };

export interface IA19ClosingPickInput {
    level: number;
    available: readonly number[];
    /** The earlier draft layers' choice. */
    current: number | undefined;
    ownCreatureIds: readonly number[];
    knownOpponentCreatureIds: readonly number[];
    bannedCreatureIds?: readonly number[];
    /** Stable per decision: `${gameId}:${team}`. Seeds the matchup model's read samples. */
    seed: string;
}

/** The synergy bonus of adding `id` to an army of `own` creatures. */
export function a19ClosingPickSynergyBonus(own: readonly number[], id: number): number {
    const faction = creatureInfo(id)?.faction;
    if (!faction || own.includes(id)) return 0;
    const distinct = new Set(own.filter((other) => creatureInfo(other)?.faction === faction)).size;
    return (
        (distinct === 1 ? A19_CLOSING_PICK_SECOND_OF_FACTION : 0) +
        (distinct === 3 ? (A19_CLOSING_PICK_FOURTH_OF_FACTION[faction] ?? 0) : 0)
    );
}

/** The closing pick when the rule replaces the current choice, else undefined (keep the current choice). */
export function a19ClosingPickCreature(input: IA19ClosingPickInput): number | undefined {
    if (input.level !== LEVEL || input.current === undefined) return undefined;
    const seen = input.knownOpponentCreatureIds;
    if (!seen.length || a19CounterDraftGateOpen(seen)) return undefined;
    const own = input.ownCreatureIds;
    const have: Record<number, number> = {};
    for (const id of own) {
        const level = creatureInfo(id)?.level;
        if (level) have[level] = (have[level] ?? 0) + 1;
    }
    const future: number[] = [];
    for (const level of [1, 2, 3, 4])
        for (let k = (have[level] ?? 0) + (level === input.level ? 1 : 0); k < QUOTA[level]; k++) future.push(level);
    const banned = new Set<number>(input.bannedCreatureIds ?? []);
    const score = (id: number): number =>
        a19CounterDraftScore([...own, id], seen, banned, future, `${input.seed}:${LEVEL}:${id}`) +
        a19ClosingPickSynergyBonus(own, id);
    const currentScore = score(input.current);
    let best: number | undefined;
    let bestScore = -Infinity;
    for (const id of [...input.available].sort((a, b) => a - b)) {
        const value = score(id);
        if (value > bestScore + 1e-12) {
            best = id;
            bestScore = value;
        }
    }
    return best !== undefined && best !== input.current && bestScore - currentScore >= A19_CLOSING_PICK_MARGIN
        ? best
        : undefined;
}
