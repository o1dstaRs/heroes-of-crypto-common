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

/**
 * How many single-cell mountains ("barrels" on the Cemetery board) a scattered BLOCK_CENTER layout drops.
 *
 * OWNER CALL (2026-08-28): every cemetery board carries TWELVE barrels. The count briefly rolled per
 * game in [MIN, MAX] like the map itself; the owner asked for the fixed twelve back, so MIN is pinned to
 * MAX. The roll plumbing is deliberately kept — the count still rides the game's own seed, so no wire
 * field is needed and server, both seats, replays and the headless sim all agree by derivation — which
 * means restoring the variety later is a one-constant change (drop MIN back to 9) rather than a rewrite.
 */
export const SCATTERED_MOUNTAIN_MIN_COUNT = 12;
export const SCATTERED_MOUNTAIN_MAX_COUNT = 12;
/** The neutral middle band the rocks land in: this many full-HEIGHT columns, centred horizontally.
 *  Every surface is SIDE-oriented now (owner call 2026-08-25: everything fights left-to-right) —
 *  deployment carves x 1-3 and x 12-14 over the full board height, so the vertical mid-board strip
 *  is the one band that collides with neither army. A classic (bottom/top) board rolls the same layout
 *  transposed, which is what `sideOriented = false` is for. */
export const SCATTERED_MOUNTAIN_BAND_ROWS = 4;
/**
 * Distinct obstacle art variants the client can draw (variant indices are 0..VARIANTS-1) — the nine-barrel
 * cemetery_obstacles_9x_256 atlas. The roll deals this full deck FIRST and only then fills any surplus
 * slot with a repeat, so a 12-barrel board shows all nine authored barrels plus exactly three repeats
 * rather than dealing twelve independent draws and leaving several barrels unused.
 */
export const SCATTERED_MOUNTAIN_VARIANTS = 9;

export interface ISeededScatteredMountain {
    cell: XY;
    /** Art variant for the client renderer; the engine ignores it. */
    variant: number;
}

/** FNV-1a over the seed (identical to synergyVariantsForSeed), then a mulberry32 stream for the draws —
 *  both tiny and bit-stable across every JS runtime we ship to. `salt` opens an INDEPENDENT stream from
 *  the same seed. */
const streamFor = (seed: string, salt: string): (() => number) => {
    let hash = 0x811c9dc5;
    const material = `${salt}${seed}`;
    for (let i = 0; i < material.length; i++) {
        hash ^= material.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let state = hash >>> 0;
    return (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/**
 * How many barrels this game's cemetery carries, in [MIN, MAX].
 *
 * Deliberately drawn from a SALTED, independent stream rather than as the first draw of the layout
 * stream. Rolling it inline would shift every subsequent draw, so a board that used to be nine specific
 * cells would become nine DIFFERENT cells — and a ranked game persists only which stones still STAND,
 * re-deriving the layout from its id on every hydrate (planScatteredMountainSync). A separate stream
 * leaves the cell sequence untouched: the first nine cells of any seed are exactly what they were, and a
 * higher roll only APPENDS stones.
 */
export const scatteredMountainCountForSeed = (seed: string): number => {
    const span = SCATTERED_MOUNTAIN_MAX_COUNT - SCATTERED_MOUNTAIN_MIN_COUNT + 1;
    return SCATTERED_MOUNTAIN_MIN_COUNT + Math.floor(streamFor(seed, "barrel-count:")() * span);
};

/**
 * The scattered-mountain layout for one game, derived from its id.
 *
 * Deterministic on purpose — the same reasoning as synergyVariantsForSeed: the server, both clients and
 * every replay hash the SAME game id and land on the same rocks without a single extra wire field. This is
 * what finally lets RANKED play the scattered layout: the old sandbox-only roll used Math.random(), so
 * every seat saw different stones while the server still carved the classic two 2x2 mountains — invisible
 * walls for everyone and no stones at all for the seat that never rolled.
 *
 * `sideOriented` picks the band's axis: middle COLUMNS full height (the default, and what every shipped
 * surface plays) or the transposed middle ROWS for a classic bottom/top board. Sandbox and ranked both
 * come through here, so a static game rolls its barrels by exactly the same rule as a ranked one.
 *
 * Same drawing discipline throughout: partial Fisher-Yates for distinct uniform cells, and art variants
 * deal the full deck before repeating.
 */
export const scatteredMountainsForSeed = (
    seed: string,
    gridSize = 16,
    sideOriented = true,
): ISeededScatteredMountain[] => {
    const next = streamFor(seed, "");

    const free: XY[] = [];
    const bandStart = (gridSize >> 1) - (SCATTERED_MOUNTAIN_BAND_ROWS >> 1);
    // Middle COLUMNS, full height: deployment is side-oriented everywhere (left/right x-bands), so
    // the vertical mid-board strip is the one band that collides with neither army. A horizontal
    // band would cross both side zones and drop stones into the armies' laps.
    for (let major = bandStart; major < bandStart + SCATTERED_MOUNTAIN_BAND_ROWS; major++) {
        for (let minor = 0; minor < gridSize; minor++) {
            free.push(sideOriented ? { x: major, y: minor } : { x: minor, y: major });
        }
    }
    const wanted = Math.min(scatteredMountainCountForSeed(seed), free.length);
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
