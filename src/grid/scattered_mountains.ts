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

import type { XY } from "../utils/math";

/** Inclusive barrel-count range for a scattered BLOCK_CENTER layout. */
export const SCATTERED_MOUNTAIN_MIN_COUNT = 9;
export const SCATTERED_MOUNTAIN_MAX_COUNT = 12;
/** @deprecated Use the explicit min/max constants; kept as the capacity upper bound for older consumers. */
export const SCATTERED_MOUNTAIN_COUNT = SCATTERED_MOUNTAIN_MAX_COUNT;
/** The neutral middle band the rocks land in: this many full-HEIGHT columns, centred horizontally.
 *  Every surface is SIDE-oriented now (owner call 2026-08-25: everything fights left-to-right) —
 *  deployment carves x 1-3 and x 12-14 over the full board height, so the vertical mid-board strip
 *  is the one band that collides with neither army. The sandbox's own roll follows the same
 *  orientation via FightProperties.isSideOrientedPlacement. */
export const SCATTERED_MOUNTAIN_BAND_ROWS = 4;
/**
 * Distinct obstacle art variants the client can draw (variant indices are 0..VARIANTS-1) — the nine-barrel
 * cemetery_obstacles_9x_256 atlas. Every board receives all nine authored variants once before the random
 * surplus slots repeat variants.
 */
export const SCATTERED_MOUNTAIN_VARIANTS = 9;

export interface ISeededScatteredMountain {
    cell: XY;
    /** Art variant for the client renderer; the engine ignores it. */
    variant: number;
}

/** Draw an inclusive 9..12 barrel count from any [0, 1) random source. */
export const randomScatteredMountainCount = (random: () => number = Math.random): number =>
    SCATTERED_MOUNTAIN_MIN_COUNT +
    Math.floor(random() * (SCATTERED_MOUNTAIN_MAX_COUNT - SCATTERED_MOUNTAIN_MIN_COUNT + 1));

/**
 * The scattered-mountain layout for one game, derived from its id.
 *
 * Deterministic on purpose — the same reasoning as synergyVariantsForSeed: the server, both clients and
 * every replay hash the SAME game id and land on the same rocks without a single extra wire field. This is
 * what finally lets RANKED play the scattered layout: the old sandbox-only roll used Math.random(), so
 * every seat saw different stones while the server still carved the classic two 2x2 mountains — invisible
 * walls for everyone and no stones at all for the seat that never rolled.
 *
 * Same drawing discipline as the sandbox roll (partial Fisher-Yates for distinct uniform cells; art
 * variants deal the full deck before repeating); both surfaces play the same side-oriented band.
 */
export const scatteredMountainsForSeed = (seed: string, gridSize = 16): ISeededScatteredMountain[] => {
    // FNV-1a seed hash (identical to synergyVariantsForSeed), then a mulberry32 stream for the draws —
    // both tiny and bit-stable across every JS runtime we ship to.
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let state = hash >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const free: XY[] = [];
    const bandStart = (gridSize >> 1) - (SCATTERED_MOUNTAIN_BAND_ROWS >> 1);
    // Middle COLUMNS, full height: deployment is side-oriented everywhere (left/right x-bands), so
    // the vertical mid-board strip is the one band that collides with neither army. A horizontal
    // band would cross both side zones and drop stones into the armies' laps.
    for (let x = bandStart; x < bandStart + SCATTERED_MOUNTAIN_BAND_ROWS; x++) {
        for (let y = 0; y < gridSize; y++) {
            free.push({ x, y });
        }
    }
    // Count is part of the seeded stream so the server, both seats and replays agree on the same 9..12
    // barrels without another protocol field.
    const wanted = Math.min(randomScatteredMountainCount(next), free.length);
    for (let i = 0; i < wanted; i++) {
        const j = i + Math.floor(next() * (free.length - i));
        const swap = free[i];
        free[i] = free[j];
        free[j] = swap;
    }
    const cells = free.slice(0, wanted);

    const deck: number[] = [];
    for (let v = 0; v < SCATTERED_MOUNTAIN_VARIANTS; v++) {
        deck.push(v);
    }
    while (deck.length < wanted) {
        deck.push(Math.floor(next() * SCATTERED_MOUNTAIN_VARIANTS));
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const swap = deck[i];
        deck[i] = deck[j];
        deck[j] = swap;
    }

    return cells.map((cell, index) => ({ cell, variant: deck[index] }));
};
