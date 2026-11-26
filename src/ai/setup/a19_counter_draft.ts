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

import { a19OpponentMeleeProbability } from "./a19_striker_matchup";
import { creatureInfo } from "./creature_score";
import MODEL_V1 from "./draft_models/a19_counter_draft_v1.json";
import MODEL_V2 from "./draft_models/a19_counter_draft_v2.json";
import { assertNoLegacySeatEnv, seatEnvName } from "../seat_env";

/**
 * a19-counter-draft-v1 (owner, 2026-11-22: "read what opponent is doing, what units are available to counter that ...
 * Or build something that is very hard to counter"). Once a seat sees at least two opposing creatures and their melee
 * probability is at least one half, it drafts with a matchup model instead of the striker heads: creature strength
 * plus creature-vs-creature counter terms, fitted on 40,040 production games. Each creature on offer is scored by
 * completing both armies: the opponent's unseen slots are filled from how often each creature appears in armies
 * (32 samples, "read") and by the opponent's best counter to this seat's army ("robust"); this seat's later picks are
 * its best answers. The score is the mean of the two. Only creatures this seat may legally see are used.
 * Against shooter armies the gate stays closed and the striker draft keeps the rush. See docs/counter_draft_adoption.md.
 */
export const A19_COUNTER_DRAFT_ID = "a19-counter-draft-v1";
/**
 * The model the counter draft and the closing pick score with. Profile v37 refits it on November 25 games
 * (a19-counter-model-v2, draft_models/a19_counter_draft_v2.json; docs/counter_model_v2_adoption.md);
 * A19_COUNTER_MODEL=v1 restores the v1 model for every seat of the process.
 */
export const A19_COUNTER_MODEL_ENV = "A19_COUNTER_MODEL";
export const A19_COUNTER_MODEL_IDS = Object.freeze({ v1: "a19-counter-draft-v1", v2: "a19-counter-model-v2" } as const);
type CounterModelVersion = keyof typeof A19_COUNTER_MODEL_IDS;
/** The fields the counter draft reads from a model file. */
interface IA19CounterModel {
    readonly policyId: string;
    readonly creatureIds: readonly number[];
    readonly strength: readonly number[];
    readonly counter: readonly (readonly number[])[];
    readonly prior: readonly number[];
}
/** The counter model for a selection ("v1" or "v2"; empty means the default, v2). */
export function a19CounterModelFor(selection: string | undefined): { id: string; model: IA19CounterModel } {
    const version = (selection?.trim().toLowerCase() || "v2") as CounterModelVersion;
    if (!(version in A19_COUNTER_MODEL_IDS)) throw new Error(`invalid_a19_counter_model:${selection}`);
    return { id: A19_COUNTER_MODEL_IDS[version], model: version === "v1" ? MODEL_V1 : MODEL_V2 };
}
const selected = a19CounterModelFor(typeof process === "undefined" ? undefined : process.env[A19_COUNTER_MODEL_ENV]);
/** The counter model this process scores with. */
export const A19_COUNTER_MODEL_ID: string = selected.id;
const MODEL = selected.model;
export const A19_COUNTER_DRAFT_ENV = "A19_COUNTER_DRAFT";
export const A19_COUNTER_DRAFT_MELEE_GATE = 0.5;
export const A19_COUNTER_DRAFT_MIN_SEEN = 2;
const ROLLOUTS = 32;
const QUOTA: Readonly<Record<number, number>> = { 1: 2, 2: 2, 3: 1, 4: 1 };

const IDS: readonly number[] = MODEL.creatureIds;
const COL = new Map<number, number>(IDS.map((id, index) => [id, index]));
const STRENGTH: readonly number[] = MODEL.strength;
const COUNTER: readonly (readonly number[])[] = MODEL.counter;
const PRIOR: readonly number[] = MODEL.prior;
const BY_LEVEL = new Map<number, number[]>();
for (const id of IDS) {
    const level = creatureInfo(id)?.level;
    if (level) BY_LEVEL.set(level, [...(BY_LEVEL.get(level) ?? []), id]);
}

export function a19CounterDraftEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_COUNTER_DRAFT_ENV);
    return process.env[seatEnvName(A19_COUNTER_DRAFT_ENV, team)] !== "0";
}

/** The read that opens the gate: enough visible opposing creatures, and the opponent probably ends melee. */
export function a19CounterDraftGateOpen(knownOpponentIds: readonly number[]): boolean {
    const known = [...new Set(knownOpponentIds)];
    return (
        known.length >= A19_COUNTER_DRAFT_MIN_SEEN && a19OpponentMeleeProbability(known) >= A19_COUNTER_DRAFT_MELEE_GATE
    );
}

const pair = (a: number, b: number): number => COUNTER[COL.get(a)!][COL.get(b)!];

/** The model's logit that army `own` beats army `opp`. */
export function a19CounterDraftLogit(own: readonly number[], opp: readonly number[]): number {
    let z = 0;
    for (const a of own) z += STRENGTH[COL.get(a)!];
    for (const b of opp) z -= STRENGTH[COL.get(b)!];
    for (const a of own) for (const b of opp) z += pair(a, b);
    return z;
}

const bestAgainst = (pool: readonly number[], against: readonly number[]): number => {
    let best = pool[0];
    let bestValue = -Infinity;
    for (const id of pool) {
        let value = STRENGTH[COL.get(id)!];
        for (const other of against) value += pair(id, other);
        if (value > bestValue + 1e-12) {
            best = id;
            bestValue = value;
        }
    }
    return best;
};

function complete(
    ownStart: readonly number[],
    seen: readonly number[],
    banned: ReadonlySet<number>,
    ourFuture: readonly number[],
    robust: boolean,
    random: () => number,
): number {
    const taken = new Set<number>([...ownStart, ...seen, ...banned]);
    const opp = [...seen];
    const known = new Map<number, number>();
    for (const id of seen) {
        const level = creatureInfo(id)!.level;
        known.set(level, (known.get(level) ?? 0) + 1);
    }
    for (const level of [1, 2, 3, 4]) {
        for (let k = known.get(level) ?? 0; k < QUOTA[level]; k++) {
            const pool = (BY_LEVEL.get(level) ?? []).filter((id) => !taken.has(id));
            if (!pool.length) continue;
            let chosen: number;
            if (robust) chosen = bestAgainst(pool, ownStart);
            else {
                const weights = pool.map((id) => PRIOR[COL.get(id)!] || 1);
                let r = random() * weights.reduce((a, b) => a + b, 0);
                chosen = pool[pool.length - 1];
                for (let x = 0; x < pool.length; x++) {
                    r -= weights[x];
                    if (r <= 0) {
                        chosen = pool[x];
                        break;
                    }
                }
            }
            opp.push(chosen);
            taken.add(chosen);
        }
    }
    const own = [...ownStart];
    for (const level of ourFuture) {
        const pool = (BY_LEVEL.get(level) ?? []).filter((id) => !taken.has(id));
        if (!pool.length) continue;
        const chosen = bestAgainst(pool, opp);
        own.push(chosen);
        taken.add(chosen);
    }
    return a19CounterDraftLogit(own, opp);
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

function seedOf(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return hash || 1;
}

/** Mean of the read value (32 prior samples) and the robust value (the opponent's best counters). */
export function a19CounterDraftScore(
    ownStart: readonly number[],
    seen: readonly number[],
    banned: ReadonlySet<number>,
    ourFuture: readonly number[],
    seedText: string,
): number {
    let state = seedOf(seedText);
    const random = (): number => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 4294967296;
    };
    let read = 0;
    for (let r = 0; r < ROLLOUTS; r++) read += sigmoid(complete(ownStart, seen, banned, ourFuture, false, random));
    return 0.5 * (read / ROLLOUTS) + 0.5 * sigmoid(complete(ownStart, seen, banned, ourFuture, true, () => 0));
}

export interface IA19CounterDraftInput {
    available: readonly number[];
    ownCreatureIds: readonly number[];
    knownOpponentCreatureIds: readonly number[];
    bannedCreatureIds?: readonly number[];
    /** This seat's remaining pick levels, the current one included (draft scouting context). */
    remainingPickLevels?: readonly number[];
    level: number;
    /** Stable per decision (game id, team): seeds the read samples. */
    seed: string;
}

/**
 * The counter-draft pick, or undefined when the gate is closed (the caller keeps its own choice). Picks only from
 * `available` and reads only the opposing creatures the seat may legally see.
 */
export function a19CounterDraftCreature(input: IA19CounterDraftInput): number | undefined {
    if (!a19CounterDraftGateOpen(input.knownOpponentCreatureIds)) return undefined;
    const banned = new Set<number>(input.bannedCreatureIds ?? []);
    const remaining = [...(input.remainingPickLevels ?? [])];
    const at = remaining.indexOf(input.level);
    const future = at >= 0 ? remaining.slice(at + 1) : remaining;
    let best: number | undefined;
    let bestValue = -Infinity;
    for (const id of [...input.available].sort((a, b) => a - b)) {
        if (!COL.has(id)) continue;
        const value = a19CounterDraftScore(
            [...input.ownCreatureIds, id],
            input.knownOpponentCreatureIds,
            banned,
            future,
            `${input.seed}:${input.level}:${id}`,
        );
        if (value > bestValue + 1e-12) {
            best = id;
            bestValue = value;
        }
    }
    return best;
}
