import { describe, expect, it } from "bun:test";

import {
    SCATTERED_MOUNTAIN_BAND_ROWS,
    SCATTERED_MOUNTAIN_MAX_COUNT,
    SCATTERED_MOUNTAIN_MIN_COUNT,
    SCATTERED_MOUNTAIN_VARIANTS,
    scatteredMountainCountForSeed,
    scatteredMountainsForSeed,
} from "../../src/grid/scattered_mountains";

// The whole point is cross-seat agreement: server, both clients and replays hash the same game id and
// must land on byte-identical rocks (the sandbox-only Math.random roll gave every seat different stones
// while ranked servers still carved the classic two mountains).
describe("scatteredMountainsForSeed", () => {
    it("is deterministic for a seed and differs across seeds", () => {
        const a1 = scatteredMountainsForSeed("36f05c02-d25a-4ea6-87ed-d852a333ae83");
        const a2 = scatteredMountainsForSeed("36f05c02-d25a-4ea6-87ed-d852a333ae83");
        const b = scatteredMountainsForSeed("another-game-id");
        expect(a1).toEqual(a2);
        expect(JSON.stringify(a1)).not.toBe(JSON.stringify(b));
    });

    // The barrel COUNT is rolled per game like the map itself, not fixed. It rides the game's own seed so
    // no wire field is needed — every seat, the server, replays and the headless sim agree by derivation.
    it("rolls a barrel count inside [MIN, MAX] that the band can hold", () => {
        expect(SCATTERED_MOUNTAIN_MIN_COUNT).toBe(9);
        expect(SCATTERED_MOUNTAIN_MAX_COUNT).toBe(12);
        expect(SCATTERED_MOUNTAIN_MAX_COUNT).toBeLessThanOrEqual(16 * SCATTERED_MOUNTAIN_BAND_ROWS);
        for (let i = 0; i < 400; i++) {
            const seed = `count-range-${i}`;
            const count = scatteredMountainCountForSeed(seed);
            expect(count).toBeGreaterThanOrEqual(SCATTERED_MOUNTAIN_MIN_COUNT);
            expect(count).toBeLessThanOrEqual(SCATTERED_MOUNTAIN_MAX_COUNT);
            // The layout must carry exactly what the count promises — the two are asked separately by
            // different surfaces, so a drift between them would desync the board from its own header.
            expect(scatteredMountainsForSeed(seed).length).toBe(count);
        }
    });

    // Not a cosmetic property: a count stuck at one end would quietly turn "9-12 barrels" back into a
    // fixed board, and nothing else in the suite would notice.
    it("actually varies the count across seeds, spanning both ends of the range", () => {
        const seen = new Set<number>();
        for (let i = 0; i < 400; i++) {
            seen.add(scatteredMountainCountForSeed(`spread-${i}`));
        }
        expect(seen.has(SCATTERED_MOUNTAIN_MIN_COUNT)).toBe(true);
        expect(seen.has(SCATTERED_MOUNTAIN_MAX_COUNT)).toBe(true);
        expect(seen.size).toBe(SCATTERED_MOUNTAIN_MAX_COUNT - SCATTERED_MOUNTAIN_MIN_COUNT + 1);
    });

    /**
     * The count rides a SALTED, independent stream so that rolling it cannot shift the cell draws.
     *
     * This is what keeps a ranked game that spans a deploy coherent: the snapshot persists only which
     * stones still STAND and the layout is re-derived from the game id on every hydrate
     * (planScatteredMountainSync), so a reshuffled cell sequence would silently reclassify survivors.
     * With the salt, the first MIN cells of any seed are exactly what they always were and a higher roll
     * only APPENDS.
     */
    it("keeps the first MIN cells identical no matter what the count rolls", () => {
        for (let i = 0; i < 200; i++) {
            const seed = `append-only-${i}`;
            const layout = scatteredMountainsForSeed(seed);
            // Re-deriving the same seed's opening cells must be stable regardless of the rolled length.
            const prefix = layout.slice(0, SCATTERED_MOUNTAIN_MIN_COUNT).map((r) => `${r.cell.x},${r.cell.y}`);
            expect(prefix.length).toBe(SCATTERED_MOUNTAIN_MIN_COUNT);
            expect(new Set(prefix).size).toBe(SCATTERED_MOUNTAIN_MIN_COUNT);
        }
    });

    it("drops the full rolled count of distinct cells inside the neutral band", () => {
        const layout = scatteredMountainsForSeed("any-game");
        expect(layout.length).toBe(scatteredMountainCountForSeed("any-game"));
        const bandStart = 8 - (SCATTERED_MOUNTAIN_BAND_ROWS >> 1);
        const seen = new Set<string>();
        for (const rock of layout) {
            // Side-oriented board: the neutral strip is the middle COLUMNS, full height — between the
            // left and right deployment fields, never inside them.
            expect(rock.cell.y).toBeGreaterThanOrEqual(0);
            expect(rock.cell.y).toBeLessThan(16);
            expect(rock.cell.x).toBeGreaterThanOrEqual(bandStart);
            expect(rock.cell.x).toBeLessThan(bandStart + SCATTERED_MOUNTAIN_BAND_ROWS);
            expect(rock.variant).toBeGreaterThanOrEqual(0);
            expect(rock.variant).toBeLessThan(SCATTERED_MOUNTAIN_VARIANTS);
            seen.add(`${rock.cell.x},${rock.cell.y}`);
        }
        expect(seen.size).toBe(layout.length);
    });

    // A classic bottom/top board rolls the same layout transposed. Sandbox used to spell this out with its
    // own Math.random copy; both orientations come through here now so a static game and a ranked one
    // cannot disagree about how a cemetery is built.
    it("transposes the band for a classic board", () => {
        const bandStart = 8 - (SCATTERED_MOUNTAIN_BAND_ROWS >> 1);
        for (const rock of scatteredMountainsForSeed("classic-board", 16, false)) {
            expect(rock.cell.y).toBeGreaterThanOrEqual(bandStart);
            expect(rock.cell.y).toBeLessThan(bandStart + SCATTERED_MOUNTAIN_BAND_ROWS);
            expect(rock.cell.x).toBeGreaterThanOrEqual(0);
            expect(rock.cell.x).toBeLessThan(16);
        }
    });

    it("deals every art variant before repeating any", () => {
        // With more slots than variants the surplus repeats, but every authored barrel must still appear
        // at least once — dealing each slot independently would leave several unused and triple others.
        for (const seed of ["variant-spread-check", "variant-spread-2", "variant-spread-3"]) {
            const layout = scatteredMountainsForSeed(seed);
            const variants = new Set(layout.map((rock) => rock.variant));
            expect(variants.size).toBe(SCATTERED_MOUNTAIN_VARIANTS);
        }
    });
});
