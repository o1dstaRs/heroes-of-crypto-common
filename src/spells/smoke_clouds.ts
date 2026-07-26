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

// Default lifetime of a freshly placed smoke cloud, in laps. Matches the Smoke spell's `laps: 3` config — the
// spell is the only thing that creates smoke today, so the two are intentionally coupled. If more sources
// ever create smoke, prefer passing an explicit lap count at the call site instead of this default.
export const SMOKE_CLOUD_DEFAULT_LAPS = 3;

interface ISmokeCloudCell {
    x: number;
    y: number;
    l: number;
}

// One smoke-occupied cell with a remaining-laps counter. Mirrors AppliedSpell.minusLap() semantics: decrements
// per lap, never below 0. When lapsRemaining reaches 0 the SmokeClouds store deletes the entry.
export class SmokeCloud {
    public constructor(
        public readonly cell: XY,
        private lapsRemaining: number,
    ) {}
    public getLapsRemaining(): number {
        return this.lapsRemaining;
    }
    public minusLap(): void {
        if (this.lapsRemaining > 0) {
            this.lapsRemaining -= 1;
        }
    }
}

// Cell-resident smoke store. The grid carries terrain (lava/water/mountain) as fixed markers that cannot
// expire; the unit-bound AppliedSpell cannot live on a cell. Smoke is the first transient, cell-scoped
// effect in the engine, so it gets its own small store keyed by a packed (x,y) integer for O(1) lookup on
// the hot path of range-attack damage halving.
//
// Lives on FightProperties so it serializes with the rest of the fight state and survives a server restart
// (the ranked server replays from snapshots). The turn engine decrements all clouds on lap transition, and
// the move handler dispels a cell the moment a creature occupies it.
export class SmokeClouds {
    private readonly clouds = new Map<number, SmokeCloud>();
    public static key(cell: XY): number {
        return (cell.x << 8) | (cell.y & 0xff);
    }
    public size(): number {
        return this.clouds.size;
    }
    public has(cell: XY): boolean {
        return this.clouds.has(SmokeClouds.key(cell));
    }
    // Place a cloud on a single cell with the given lap budget. Replacing an existing cloud refreshes its
    // lifetime (a re-cast over a still-smoking cell top-ups the laps rather than stacking).
    public add(cell: XY, laps: number = SMOKE_CLOUD_DEFAULT_LAPS): void {
        this.clouds.set(SmokeClouds.key(cell), new SmokeCloud({ x: cell.x, y: cell.y }, laps));
    }
    public dispel(cell: XY): boolean {
        return this.clouds.delete(SmokeClouds.key(cell));
    }
    public clear(): void {
        this.clouds.clear();
    }
    // Snapshot of every active smoked cell (for client rendering + AI evaluation). Returns plain XY copies so
    // callers can't mutate the stored cells.
    public cells(): XY[] {
        const out: XY[] = [];
        for (const cloud of this.clouds.values()) {
            out.push({ x: cloud.cell.x, y: cloud.cell.y });
        }
        return out;
    }
    // Decrement every cloud by one lap and drop expired ones. Returns the cells whose smoke dispersed this
    // tick (so the engine can emit a `smoke_expired` event for the client to remove the visuals).
    public minusAllLaps(): XY[] {
        const expired: XY[] = [];
        for (const [key, cloud] of this.clouds) {
            cloud.minusLap();
            if (cloud.getLapsRemaining() <= 0) {
                expired.push({ x: cloud.cell.x, y: cloud.cell.y });
                this.clouds.delete(key);
            }
        }
        return expired;
    }
    // Serialization for fight snapshots / journal replay. Compact shape: [{x,y,l}, ...].
    public toJSON(): ISmokeCloudCell[] {
        const out: ISmokeCloudCell[] = [];
        for (const cloud of this.clouds.values()) {
            out.push({ x: cloud.cell.x, y: cloud.cell.y, l: cloud.getLapsRemaining() });
        }
        return out;
    }
    public static fromJSON(data: ISmokeCloudCell[] | undefined | null): SmokeClouds {
        const store = new SmokeClouds();
        if (Array.isArray(data)) {
            for (const c of data) {
                if (c && typeof c.x === "number" && typeof c.y === "number" && typeof c.l === "number") {
                    store.add({ x: c.x, y: c.y }, c.l);
                }
            }
        }
        return store;
    }
}
