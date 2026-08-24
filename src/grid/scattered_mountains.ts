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

/** How many single-cell mountains a scattered BLOCK_CENTER layout drops. */
export const SCATTERED_MOUNTAIN_COUNT = 12;
/** The neutral middle band the rocks land in: this many full-HEIGHT columns, centred horizontally —
 *  the vertical strip between the left and right deployment fields of the side-oriented board. */
export const SCATTERED_MOUNTAIN_BAND_ROWS = 4;
/**
 * Distinct obstacle art variants the client can draw (variant indices are 0..VARIANTS-1) — the nine-barrel
 * cemetery_obstacles_9x_256 atlas. Fewer variants than COUNT, so the deal below hands out the full set
 * first and only then repeats — at 12 slots from 9 variants exactly three barrels repeat, spread by the
 * shuffle rather than clustered.
 */
export const SCATTERED_MOUNTAIN_VARIANTS = 9;

export interface ISeededScatteredMountain {
    cell: XY;
    /** Art variant for the client renderer; the engine ignores it. */
    variant: number;
}

/**
 * The scattered-mountain layout for one game, derived from its id.
 *
 * Deterministic on purpose — the same reasoning as synergyVariantsForSeed: the server, both clients and
 * every replay hash the SAME game id and land on the same rocks without a single extra wire field. This is
 * what finally lets RANKED play the scattered layout: the old sandbox-only roll used Math.random(), so
 * every seat saw different stones while the server still carved the classic two 2x2 mountains — invisible
 * walls for everyone and no stones at all for the seat that never rolled.
 *
 * The band/count mirror the sandbox roll exactly (middle SCATTERED_MOUNTAIN_BAND_ROWS columns, full height,
 * partial Fisher-Yates for distinct uniform cells; art variants deal the full deck before repeating).
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
    // Middle COLUMNS, full height: the side-oriented board deploys armies on the left/right flanks, so
    // the neutral strip runs vertically between them. The old horizontal band crossed both deployment
    // zones and dropped stones into the armies' laps (which is how "12 barrels" read as ~9 on a live
    // board). Mirrors the sandbox roll exactly.
    for (let x = bandStart; x < bandStart + SCATTERED_MOUNTAIN_BAND_ROWS; x++) {
        for (let y = 0; y < gridSize; y++) {
            free.push({ x, y });
        }
    }
    const wanted = Math.min(SCATTERED_MOUNTAIN_COUNT, free.length);
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
