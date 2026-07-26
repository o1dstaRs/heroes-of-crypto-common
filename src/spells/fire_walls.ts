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

// Default lifetime of a freshly laid fire wall, in laps. Matches the Fire Wall spell's `laps: 3` config —
// the spell is the only thing that lights walls today, so the two are intentionally coupled. If more sources
// ever create fire, prefer passing an explicit lap count at the call site instead of this default.
export const FIRE_WALL_DEFAULT_LAPS = 3;

// Extra steps a creature pays to enter a burning cell. A plain orthogonal step costs 1, so the penalty is
// what makes crossing the wall cost double. Unlike a vine, the flames do NOT spare flyers: the wall is a
// sheet of fire, not something to step over.
export const FIRE_WALL_CROSS_PENALTY = 1;

// Share of the crossing stack's CUMULATIVE maximum health burned off per burning cell entered. Stack-scaled
// on purpose, the same way armageddonDamage scales off max_hp * unitsTotal — a flat per-creature slice would
// be noise to any real stack and the wall would read as decorative.
export const FIRE_WALL_BURN_PERCENTAGE = 25;

// Cells a single cast lights, always in a straight line.
export const FIRE_WALL_LENGTH = 3;

/**
 * The four ways a 3-cell wall can lie on the board. HORIZONTAL is the default the aim preview opens on;
 * the player cycles forward through this list with Shift while aiming (see Sandbox.rotateFireWallAim).
 *
 * The order is a quarter-turn each time, so holding Shift sweeps the wall around like a clock hand rather
 * than jumping between unrelated shapes.
 */
export enum FireWallOrientation {
    HORIZONTAL = 0,
    DIAGONAL_DOWN = 1,
    VERTICAL = 2,
    DIAGONAL_UP = 3,
}

export const FIRE_WALL_ORIENTATIONS: readonly FireWallOrientation[] = [
    FireWallOrientation.HORIZONTAL,
    FireWallOrientation.DIAGONAL_DOWN,
    FireWallOrientation.VERTICAL,
    FireWallOrientation.DIAGONAL_UP,
];

/** Step vector the wall extends along, one entry per FireWallOrientation. */
const ORIENTATION_STEPS: Readonly<Record<FireWallOrientation, XY>> = {
    [FireWallOrientation.HORIZONTAL]: { x: 1, y: 0 },
    [FireWallOrientation.DIAGONAL_DOWN]: { x: 1, y: -1 },
    [FireWallOrientation.VERTICAL]: { x: 0, y: 1 },
    [FireWallOrientation.DIAGONAL_UP]: { x: 1, y: 1 },
};

/** Normalize any integer to a valid orientation, so a malformed action can't index off the end. */
export function normalizeFireWallOrientation(value: number | undefined | null): FireWallOrientation {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return FireWallOrientation.HORIZONTAL;
    }
    const count = FIRE_WALL_ORIENTATIONS.length;
    return (((Math.trunc(value) % count) + count) % count) as FireWallOrientation;
}

/** Advance one quarter-turn — what a Shift press does while aiming. */
export function nextFireWallOrientation(current: FireWallOrientation): FireWallOrientation {
    return normalizeFireWallOrientation(current + 1);
}

/**
 * The three cells a wall anchored on `anchor` covers, in order along the wall.
 *
 * The anchor is the MIDDLE cell, not a corner: the wall rotates about the cursor, so the cell under the
 * mouse stays put as the player cycles orientations. (Smoke and Craft anchor their 2x2 at a corner instead
 * — those footprints never rotate, so there is nothing to pivot around.)
 */
export function fireWallCells(anchor: XY, orientation: FireWallOrientation): XY[] {
    const step = ORIENTATION_STEPS[normalizeFireWallOrientation(orientation)];
    const cells: XY[] = [];
    const half = Math.floor(FIRE_WALL_LENGTH / 2);
    for (let i = -half; i <= half; i++) {
        cells.push({ x: anchor.x + step.x * i, y: anchor.y + step.y * i });
    }
    return cells;
}

interface IFireWallCellJSON {
    x: number;
    y: number;
    l: number;
}

// One burning cell with a remaining-laps counter. Mirrors Vine/SmokeCloud/AppliedSpell.minusLap() semantics:
// decrements per lap, never below 0. When lapsRemaining reaches 0 the FireWalls store deletes the entry.
export class FireWall {
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

/**
 * Cell-resident fire store — the third transient, cell-scoped effect in the engine after SmokeClouds and
 * Vines, and deliberately built the same way: a Map keyed by a packed (x,y) integer for O(1) lookup, because
 * the hot path is the pathfinder asking "is this cell burning?" once per neighbour per expansion.
 *
 * Like a vine and unlike smoke, fire is NOT put out by a creature standing on it — the wall keeps burning
 * for its full lap budget and keeps charging everything that wades through.
 *
 * Lives on FightProperties so it serializes with the rest of the fight state and survives a server restart
 * (the ranked server replays from snapshots). The turn engine decrements every wall on lap transition.
 */
export class FireWalls {
    private readonly walls = new Map<number, FireWall>();
    public static key(cell: XY): number {
        return (cell.x << 8) | (cell.y & 0xff);
    }
    public size(): number {
        return this.walls.size;
    }
    public has(cell: XY): boolean {
        return this.walls.has(FireWalls.key(cell));
    }
    // Light a single cell with the given lap budget. Re-casting over a still-burning cell refreshes its
    // lifetime rather than stacking the burn — two walls on one cell would read as one on screen.
    public add(cell: XY, laps: number = FIRE_WALL_DEFAULT_LAPS): void {
        this.walls.set(FireWalls.key(cell), new FireWall({ x: cell.x, y: cell.y }, laps));
    }
    public addAll(cells: XY[], laps: number = FIRE_WALL_DEFAULT_LAPS): void {
        for (const cell of cells) {
            this.add(cell, laps);
        }
    }
    public remove(cell: XY): boolean {
        return this.walls.delete(FireWalls.key(cell));
    }
    public clear(): void {
        this.walls.clear();
    }
    // Snapshot of every burning cell (for client rendering + AI evaluation). Returns plain XY copies so
    // callers can't mutate the stored cells.
    public cells(): XY[] {
        const out: XY[] = [];
        for (const wall of this.walls.values()) {
            out.push({ x: wall.cell.x, y: wall.cell.y });
        }
        return out;
    }
    // Decrement every wall by one lap and drop the burnt-out ones. Returns the cells that went cold this
    // tick (so the engine can emit a `fire_wall_expired` event for the client to remove the visuals).
    public minusAllLaps(): XY[] {
        const expired: XY[] = [];
        for (const [key, wall] of this.walls) {
            wall.minusLap();
            if (wall.getLapsRemaining() <= 0) {
                expired.push({ x: wall.cell.x, y: wall.cell.y });
                this.walls.delete(key);
            }
        }
        return expired;
    }
    // Serialization for fight snapshots / journal replay. Compact shape: [{x,y,l}, ...].
    public toJSON(): IFireWallCellJSON[] {
        const out: IFireWallCellJSON[] = [];
        for (const wall of this.walls.values()) {
            out.push({ x: wall.cell.x, y: wall.cell.y, l: wall.getLapsRemaining() });
        }
        return out;
    }
    public static fromJSON(data: IFireWallCellJSON[] | undefined | null): FireWalls {
        const store = new FireWalls();
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

/** Minimal grid surface this module needs, so it stays free of a Grid import cycle. */
export interface IFireWallGrid {
    getOccupantUnitId(cell: XY): string | undefined;
}

/**
 * Whether a single cell can be set alight.
 *
 * Same rule as smoke: off-grid, the centre MOUNTAIN ("B"), a cell already NARROWED away ("H") and any cell a
 * creature stands on are all refused; lava ("L") and water ("W") are ground the flames sit over. Refusing an
 * occupied cell is what stops the wall from being cast straight through a body for free damage — it has to
 * be laid in the enemy's path, not on top of them.
 *
 * Shared by the engine's fireWallCast and the client's aim preview on purpose: the preview must highlight
 * exactly the placements the engine will accept, or it teaches the player a rule the game does not have.
 */
export function isFireWallableCell(grid: IFireWallGrid, withinGrid: boolean, cell: XY): boolean {
    if (!withinGrid) {
        return false;
    }
    const occupant = grid.getOccupantUnitId(cell);
    if (!occupant) {
        return true;
    }
    return occupant === "L" || occupant === "W";
}

/** Damage one crossing does to a stack, given its cumulative maximum health. */
export function fireWallBurnDamage(cumulativeMaxHp: number): number {
    if (!Number.isFinite(cumulativeMaxHp) || cumulativeMaxHp <= 0) {
        return 0;
    }
    return Math.max(1, Math.floor((cumulativeMaxHp * FIRE_WALL_BURN_PERCENTAGE) / 100));
}
