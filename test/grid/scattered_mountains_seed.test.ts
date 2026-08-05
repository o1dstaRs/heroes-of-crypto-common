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

    it("drops the full count of distinct cells inside the neutral band", () => {
        const layout = scatteredMountainsForSeed("any-game");
        expect(layout.length).toBe(SCATTERED_MOUNTAIN_COUNT);
        const bandStart = 8 - (SCATTERED_MOUNTAIN_BAND_ROWS >> 1);
        const seen = new Set<string>();
        for (const rock of layout) {
            expect(rock.cell.x).toBeGreaterThanOrEqual(0);
            expect(rock.cell.x).toBeLessThan(16);
            expect(rock.cell.y).toBeGreaterThanOrEqual(bandStart);
            expect(rock.cell.y).toBeLessThan(bandStart + SCATTERED_MOUNTAIN_BAND_ROWS);
            expect(rock.variant).toBeGreaterThanOrEqual(0);
            expect(rock.variant).toBeLessThan(SCATTERED_MOUNTAIN_VARIANTS);
            seen.add(`${rock.cell.x},${rock.cell.y}`);
        }
        expect(seen.size).toBe(SCATTERED_MOUNTAIN_COUNT);
    });

    it("deals every art variant before repeating any", () => {
        const layout = scatteredMountainsForSeed("variant-spread-check");
        const variants = new Set(layout.map((rock) => rock.variant));
        // 9 rocks over 8 variants: at least the full set must appear.
        expect(variants.size).toBe(SCATTERED_MOUNTAIN_VARIANTS);
    });
});
