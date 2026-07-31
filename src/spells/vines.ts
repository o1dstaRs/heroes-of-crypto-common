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

// Default lifetime of a freshly thrown vine, in laps. Matches the Vine Throw spell's `laps: 2` config — the
// spell is the only thing that lays vines today, so the two are intentionally coupled. If more sources ever
// create vines, prefer passing an explicit lap count at the call site instead of this default.
export const VINE_DEFAULT_LAPS = 2;

// Extra steps a non-flying creature pays to enter a vined cell. Flying units step over the vine for free.
export const VINE_CROSS_PENALTY = 1;

// What a vined cell costs the vine's own kind (Trent, via "In Its Own World"): half a normal step instead of
// the usual one, and no sqrt(2) surcharge when crossing diagonally. Expressed as a multiplier of the plain
// orthogonal step so the passive's "50%" reads straight out of the config.
export const VINE_STRIDE_COST_MULTIPLIER = 0.5;

interface IVineCellJSON {
    x: number;
    y: number;
    l: number;
    /** Team of the creature that threw it — a vine only snares the OTHER side. */
    t: number;
}

// One vined cell with a remaining-laps counter. Mirrors SmokeCloud/AppliedSpell.minusLap() semantics:
// decrements per lap, never below 0. When lapsRemaining reaches 0 the Vines store deletes the entry.
export class Vine {
    public constructor(
        public readonly cell: XY,
        private lapsRemaining: number,
        /**
         * The thrower's team. Standing in your own side's vine is not a snare — Trent walks his own vines
         * for half price, and a vine that also punished his allies would fight its own passive.
         */
        public readonly team: number = 0,
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

/**
 * Cell-resident vine store — the second transient, cell-scoped effect in the engine after SmokeClouds, and
 * deliberately built the same way: a Map keyed by a packed (x,y) integer for O(1) lookup, because the hot
 * path here is the pathfinder asking "is this cell vined?" once per neighbour per expansion.
 *
 * Unlike smoke, a vine is NOT dispelled by a creature standing on it — the whole point is that units keep
 * paying to wade through it, and that Trent keeps its discount on cells its enemies are contesting.
 *
 * Lives on FightProperties so it serializes with the rest of the fight state and survives a server restart
 * (the ranked server replays from snapshots). The turn engine decrements every vine on lap transition.
 */
export class Vines {
    private readonly vines = new Map<number, Vine>();
    /** Changes whenever renderable vine state changes, so clients can reuse a snapshot between animation frames. */
    private revision = 0;
    public static key(cell: XY): number {
        return (cell.x << 8) | (cell.y & 0xff);
    }
    public size(): number {
        return this.vines.size;
    }
    public getRevision(): number {
        return this.revision;
    }
    public has(cell: XY): boolean {
        return this.vines.has(Vines.key(cell));
    }
    // Lay a vine on a single cell with the given lap budget. Re-throwing over a still-vined cell refreshes
    // its lifetime rather than stacking the penalty — two vines on one cell would read as one on screen.
    public add(cell: XY, laps: number = VINE_DEFAULT_LAPS, team = 0): void {
        this.vines.set(Vines.key(cell), new Vine({ x: cell.x, y: cell.y }, laps, team));
        this.revision += 1;
    }
    public addAll(cells: XY[], laps: number = VINE_DEFAULT_LAPS, team = 0): void {
        for (const cell of cells) {
            this.add(cell, laps, team);
        }
    }
    /** The team that laid the vine on this cell, or undefined when the cell carries none. */
    public teamAt(cell: XY): number | undefined {
        return this.vines.get(Vines.key(cell))?.team;
    }
    /**
     * Whether standing on this cell snares `team` — true only for a vine the other side laid. Shared by the
     * engine (which applies the debuff) and any UI that wants to warn before stepping in.
     */
    public snares(cell: XY, team: number): boolean {
        const owner = this.teamAt(cell);
        return owner !== undefined && owner !== team;
    }
    public remove(cell: XY): boolean {
        const removed = this.vines.delete(Vines.key(cell));
        if (removed) this.revision += 1;
        return removed;
    }
    public clear(): void {
        if (!this.vines.size) return;
        this.vines.clear();
        this.revision += 1;
    }
    // Snapshot of every vined cell (for client rendering + AI evaluation). Returns plain XY copies so
    // callers can't mutate the stored cells.
    public cells(): XY[] {
        const out: XY[] = [];
        for (const vine of this.vines.values()) {
            out.push({ x: vine.cell.x, y: vine.cell.y });
        }
        return out;
    }
    // Decrement every vine by one lap and drop the withered ones. Returns the cells that cleared this tick
    // (so the engine can emit a `vine_expired` event for the client to remove the visuals).
    public minusAllLaps(): XY[] {
        const expired: XY[] = [];
        let changed = false;
        for (const [key, vine] of this.vines) {
            changed = true;
            vine.minusLap();
            if (vine.getLapsRemaining() <= 0) {
                expired.push({ x: vine.cell.x, y: vine.cell.y });
                this.vines.delete(key);
            }
        }
        if (changed) this.revision += 1;
        return expired;
    }
    // Serialization for fight snapshots / journal replay. Compact shape: [{x,y,l}, ...].
    public toJSON(): IVineCellJSON[] {
        const out: IVineCellJSON[] = [];
        for (const vine of this.vines.values()) {
            out.push({ x: vine.cell.x, y: vine.cell.y, l: vine.getLapsRemaining(), t: vine.team });
        }
        return out;
    }
    public static fromJSON(data: IVineCellJSON[] | undefined | null): Vines {
        const store = new Vines();
        if (Array.isArray(data)) {
            for (const c of data) {
                if (c && typeof c.x === "number" && typeof c.y === "number" && typeof c.l === "number") {
                    store.add({ x: c.x, y: c.y }, c.l, typeof c.t === "number" ? c.t : 0);
                }
            }
        }
        return store;
    }
}

/**
 * The cells a thrown vine covers: every cell the throw crosses on its way to the target, plus the target's
 * own cell. Uses the same supercover walk the range-attack blocker check uses, so what the vine lands on is
 * exactly what the player saw the aim line pass over.
 *
 * The caster's own cell is excluded — Trent is holding the near end, not standing in the snare.
 */
export function vinePathCells(from: XY, to: XY): XY[] {
    const cells: XY[] = [];
    let x = Math.round(from.x);
    let y = Math.round(from.y);
    const targetX = Math.round(to.x);
    const targetY = Math.round(to.y);
    const dx = Math.abs(targetX - x);
    const dy = Math.abs(targetY - y);
    const stepX = x < targetX ? 1 : -1;
    const stepY = y < targetY ? 1 : -1;
    let error = dx - dy;
    // Bounded by the board diagonal; the guard is a belt-and-braces stop against a malformed target.
    const maxCells = dx + dy + 1;
    for (let guard = 0; guard <= maxCells; guard++) {
        if (!(x === Math.round(from.x) && y === Math.round(from.y))) {
            cells.push({ x, y });
        }
        if (x === targetX && y === targetY) {
            break;
        }
        const doubledError = error * 2;
        if (doubledError > -dy) {
            error -= dy;
            x += stepX;
        }
        if (doubledError < dx) {
            error += dx;
            y += stepY;
        }
    }
    return cells;
}

export interface IVineGrid {
    getOccupantUnitId(cell: XY): string | undefined;
}

/**
 * Whether the vine can creep across a single cell on its way to the target.
 *
 * Lava ("L") and water ("W") are ground the vine crosses; a body, the centre mountain ("B") or a narrowed
 * cell ("H") stops it, as does anything off-board.
 *
 * NOTE: this deliberately does NOT special-case the target's own cell, which is occupied by definition —
 * callers exclude it (see `vineThrowCast`, which checks `pathCells.slice(0, -1)`).
 *
 * Shared with the client's aim preview so a highlighted throw can never be one the engine then refuses —
 * the same contract `isSmokeableCell` holds for Smoke.
 */
export function isVineCrossableCell(grid: IVineGrid, withinGrid: boolean, cell: XY): boolean {
    if (!withinGrid) {
        return false;
    }
    const occupant = grid.getOccupantUnitId(cell);
    if (!occupant) {
        return true;
    }
    return occupant === "L" || occupant === "W";
}
