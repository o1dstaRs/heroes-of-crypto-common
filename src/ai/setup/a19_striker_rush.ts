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

import { isA19DeliveryMelee } from "./a19_revealed_ranged_draft";
import { creatureInfo } from "./creature_score";
import type { ISetupAugmentChoice } from "./setup_ship";
import type { XY } from "../../utils/math";

/**
 * Striker rush: draft melee strikers, and when the opposing army is not itself a melee army, buy the deepest
 * deployment zone and the most movement and start the strikers on the edge of that zone, spread over its rows.
 *
 * The idea is a player's, not a search result. A shooter cannot fire while an enemy body stands next to it, so
 * strikers that reach the firing line on their first move switch the opposing shooters off. Read
 * docs/striker_rush_research.md before changing any number here: the same setup loses against a melee army.
 */
export { A19_STRIKER_RUSH_MIXED_POLICY, A19_STRIKER_RUSH_POLICY } from "./a19_striker_rush_identity";
/** Own drafted creatures that must be strikers before the rush setup is used. */
export const A19_STRIKER_RUSH_MIN_OWN_STRIKERS = 4;
/** The rush is a counter to shooters and casters: an army with at most this many strikers is always rushed. */
export const A19_STRIKER_RUSH_MAX_ENEMY_STRIKERS = 3;
/**
 * A mixed army is rushed too: exactly this many strikers and at least `A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS` creatures
 * with a ranged attack. Its shooters shoot freely at a melee army that stays on its stock setup. With four strikers and
 * no shooter the army keeps its native setup against it, as it does against five or six strikers: that case was not
 * measured, and a rush loses to a melee army. See docs/striker_rush_mixed_adoption.md.
 */
export const A19_STRIKER_RUSH_MIXED_ENEMY_STRIKERS = 4;
export const A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS = 2;
/** Printed steps from which a ground striker counts as fast. Flyers always do. */
export const A19_STRIKER_RUSH_FAST_STEPS = 5;
export const A19_STRIKER_RUSH_PLACEMENT = 2;
export const A19_STRIKER_RUSH_MOVEMENT = 2;

const kinds = ["Placement", "Movement", "Armor", "Might", "Sniper", "Empower"] as const;
type Kind = (typeof kinds)[number];
const CAP: Readonly<Record<Kind, number>> = { Placement: 2, Movement: 2, Armor: 3, Might: 3, Sniper: 3, Empower: 3 };
/** Points are taken back in this order; Sniper keeps one level while the army still has a shooter. */
const REDUCE: readonly Kind[] = ["Sniper", "Empower", "Might", "Armor", "Sniper", "Movement", "Placement"];

export const isA19Striker = (creatureId: number): boolean => isA19DeliveryMelee(creatureId);

export function isA19FastStriker(creatureId: number): boolean {
    const unit = creatureInfo(creatureId);
    return (
        !!unit &&
        isA19DeliveryMelee(creatureId) &&
        (unit.canFly || (unit.movementSteps ?? 0) >= A19_STRIKER_RUSH_FAST_STEPS)
    );
}

const distinct = (ids: readonly number[]): number[] => [...new Set(ids)];
export const a19StrikerCount = (creatureIds: readonly number[]): number =>
    distinct(creatureIds).filter(isA19Striker).length;
/** Drafted creatures with a ranged attack: the units a body next to them switches off. */
export const a19ShooterCount = (creatureIds: readonly number[]): number =>
    distinct(creatureIds).filter((id) => creatureInfo(id)?.ranged).length;

/**
 * The creatures the draft head would rather take than `current`: fast strikers on offer, else any striker on
 * offer. Empty when `current` is already one of them or none is offered, which leaves the earlier choice alone.
 * The caller ranks the returned pool with the seat's own draft policy.
 */
export function a19StrikerRushDraftPool(current: number, available: readonly number[]): number[] {
    const strikers = available.filter(isA19Striker);
    const fast = strikers.filter(isA19FastStriker);
    const pool = fast.length ? fast : strikers;
    return pool.length && !pool.includes(current) ? pool : [];
}

/**
 * Opening bundle: the one with the most strikers, fast ones first. `current` is kept on a tie, so a seat whose
 * earlier choice is already as good keeps it; among other ties the first offered wins.
 */
export function a19StrikerRushBundle(bundles: readonly (readonly [number, number, number])[], current: number): number {
    const score = (index: number): number => {
        const creatures = bundles[index].slice(0, 2);
        return 2 * creatures.filter(isA19Striker).length + creatures.filter(isA19FastStriker).length;
    };
    let best = current;
    for (let index = 0; index < bundles.length; index++) if (score(index) > score(best)) best = index;
    return best;
}

/**
 * Complete public rosters only: the decision reads the whole opposing army, never its hidden setup.
 * `rushMixedArmies` false gives the rule before profile v18: at most three enemy strikers, nothing else.
 */
export function isA19StrikerRushSetup(
    ownIds: readonly number[],
    publicOpponentIds: readonly number[],
    rushMixedArmies = true,
): boolean {
    if (
        distinct(ownIds).length !== 6 ||
        distinct(publicOpponentIds).length !== 6 ||
        a19StrikerCount(ownIds) < A19_STRIKER_RUSH_MIN_OWN_STRIKERS
    )
        return false;
    const enemyStrikers = a19StrikerCount(publicOpponentIds);
    return (
        enemyStrikers <= A19_STRIKER_RUSH_MAX_ENEMY_STRIKERS ||
        (rushMixedArmies &&
            enemyStrikers === A19_STRIKER_RUSH_MIXED_ENEMY_STRIKERS &&
            a19ShooterCount(publicOpponentIds) >= A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS)
    );
}

/**
 * The funded plan: Placement 2 and Movement 2, paid for out of the native plan (Sniper first, Armor last), with
 * any point the native plan left unspent going to Armor, then Might.
 */
export function a19StrikerRushAugments(
    base: readonly ISetupAugmentChoice[],
    budget: number,
    ownIds: readonly number[],
): ISetupAugmentChoice[] {
    const levels = Object.fromEntries(
        kinds.map((kind) => [kind, base.find((entry) => entry.kind === kind)?.value ?? 0]),
    ) as Record<Kind, number>;
    levels.Placement = Math.max(levels.Placement, A19_STRIKER_RUSH_PLACEMENT);
    levels.Movement = Math.max(levels.Movement, A19_STRIKER_RUSH_MOVEMENT);
    const hasShooter = distinct(ownIds).some((id) => creatureInfo(id)?.ranged);
    let over = kinds.reduce((sum, kind) => sum + levels[kind], 0) - budget;
    for (const kind of REDUCE) {
        // The second Sniper entry gives up the last level too, once every cheaper source is exhausted.
        const floor = kind === "Sniper" && hasShooter && levels.Sniper > 1 ? 1 : 0;
        while (over > 0 && levels[kind] > floor) {
            levels[kind]--;
            over--;
        }
    }
    for (const kind of ["Armor", "Might"] as const)
        while (over < 0 && levels[kind] < CAP[kind]) {
            levels[kind]++;
            over++;
        }
    return kinds.filter((kind) => levels[kind] > 0).map((kind) => ({ kind, value: levels[kind] }));
}

export interface IA19StrikerRushBody extends XY {
    id: string;
    width: number;
    height: number;
    /** A real striker stack. One-model split children and minor halves stay where the native formation put them. */
    striker: boolean;
}

const key = (x: number, y: number): string => `${x},${y}`;
/** A body is anchored at the top-right cell of its footprint. */
const footprint = (body: { width: number; height: number }, x: number, y: number): XY[] => {
    const cells: XY[] = [];
    for (let dx = 0; dx < body.width; dx++)
        for (let dy = 0; dy < body.height; dy++) cells.push({ x: x - dx, y: y - dy });
    return cells;
};

/**
 * Strikers take the column of the zone nearest the enemy, spread evenly over its rows in their native row order.
 * Every other body keeps its native cell, or the nearest free one (ties towards the back) when a striker took it.
 * `direction` is +1 when the enemy stands at higher x. No enemy placement is an input.
 */
export function a19StrikerRushFormation(
    input: readonly IA19StrikerRushBody[],
    allowed: readonly XY[],
    blocked: readonly XY[],
    direction: 1 | -1,
): IA19StrikerRushBody[] {
    const closed = new Set(blocked.map((cell) => key(cell.x, cell.y)));
    const legalCells = allowed.filter((cell) => !closed.has(key(cell.x, cell.y)));
    if (!legalCells.length) throw new Error("Striker rush formation has no legal cell");
    const legal = new Set(legalCells.map((cell) => key(cell.x, cell.y)));
    const xs = legalCells.map((cell) => cell.x);
    const ys = legalCells.map((cell) => cell.y);
    const front = direction > 0 ? Math.max(...xs) : Math.min(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const rows = yMax - yMin + 1;
    const taken = new Set<string>();
    const placed = new Map<string, XY>();
    const free = (body: IA19StrikerRushBody, x: number, y: number): boolean =>
        footprint(body, x, y).every((cell) => legal.has(key(cell.x, cell.y)) && !taken.has(key(cell.x, cell.y)));
    const put = (body: IA19StrikerRushBody, cell: XY): void => {
        for (const part of footprint(body, cell.x, cell.y)) taken.add(key(part.x, part.y));
        placed.set(body.id, { x: cell.x, y: cell.y });
    };
    const nearest = (body: IA19StrikerRushBody, cost: (cell: XY) => number): XY => {
        let best: XY | undefined;
        let low = Infinity;
        for (const cell of legalCells) {
            if (!free(body, cell.x, cell.y)) continue;
            const value = cost(cell);
            if (value < low) {
                low = value;
                best = cell;
            }
        }
        if (!best) throw new Error("Striker rush formation cannot place a body");
        return best;
    };
    const strikers = input
        .filter((body) => body.striker)
        .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    strikers.forEach((body, index) => {
        const centre = yMin + ((index + 0.5) * rows) / strikers.length - 0.5;
        const wantY = Math.min(yMax, Math.max(yMin + body.height - 1, Math.round(centre + (body.height - 1) / 2)));
        // The footprint's leading edge sits on the front column.
        const wantX = direction > 0 ? front : front + body.width - 1;
        put(
            body,
            nearest(body, (cell) => Math.abs(cell.x - wantX) * 4 + Math.abs(cell.y - wantY)),
        );
    });
    for (const body of input) {
        if (body.striker) continue;
        put(
            body,
            free(body, body.x, body.y)
                ? { x: body.x, y: body.y }
                : nearest(
                      body,
                      (cell) =>
                          (Math.abs(cell.x - body.x) + Math.abs(cell.y - body.y)) * 4 + direction * (cell.x - body.x),
                  ),
        );
    }
    return input.map((body) => ({ ...body, ...placed.get(body.id)! }));
}
