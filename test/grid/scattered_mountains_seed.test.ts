import { describe, expect, it } from "bun:test";

import {
    SCATTERED_MOUNTAIN_BAND_ROWS,
    SCATTERED_MOUNTAIN_COUNT,
    SCATTERED_MOUNTAIN_VARIANTS,
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

    // The Cemetery board's stone count is a design number, so pin it here: it drives both the ranked seeded
    // layout and the sandbox roll, and a silent change to either would alter every BLOCK_CENTER board.
    it("scatters nine stones, and the fixed 4x16 lane has room for them", () => {
        expect(SCATTERED_MOUNTAIN_COUNT).toBe(9);
        expect(SCATTERED_MOUNTAIN_COUNT).toBeLessThanOrEqual(16 * SCATTERED_MOUNTAIN_BAND_ROWS);
        expect(scatteredMountainsForSeed("count-pin").length).toBe(9);
    });

    it("drops the full count of distinct cells inside the neutral band", () => {
        const layout = scatteredMountainsForSeed("any-game");
        expect(layout.length).toBe(SCATTERED_MOUNTAIN_COUNT);
        const bandStart = 8 - (SCATTERED_MOUNTAIN_BAND_ROWS >> 1);
        const seen = new Set<string>();
        for (const rock of layout) {
            expect(rock.cell.x).toBeGreaterThanOrEqual(bandStart);
            expect(rock.cell.x).toBeLessThan(bandStart + SCATTERED_MOUNTAIN_BAND_ROWS);
            expect(rock.cell.y).toBeGreaterThanOrEqual(0);
            expect(rock.cell.y).toBeLessThan(16);
            expect(rock.variant).toBeGreaterThanOrEqual(0);
            expect(rock.variant).toBeLessThan(SCATTERED_MOUNTAIN_VARIANTS);
            seen.add(`${rock.cell.x},${rock.cell.y}`);
        }
        expect(seen.size).toBe(SCATTERED_MOUNTAIN_COUNT);
    });

    it("deals all nine art variants exactly once", () => {
        const layout = scatteredMountainsForSeed("variant-spread-check");
        const variants = new Set(layout.map((rock) => rock.variant));
        expect(layout.length).toBe(SCATTERED_MOUNTAIN_VARIANTS);
        expect(variants.size).toBe(SCATTERED_MOUNTAIN_VARIANTS);
    });
});
