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
    // Burn percentage this cell was lit with (magic-bonus boosted). Optional: an older snapshot replays at
    // the base percentage.
    p?: number;
}

// One burning cell with a remaining-laps counter. Mirrors Vine/SmokeCloud/AppliedSpell.minusLap() semantics:
// decrements per lap, never below 0. When lapsRemaining reaches 0 the FireWalls store deletes the entry.
//
// The cell also remembers HOW HOT it was lit: the caster's total magic bonus is baked in at cast time rather
// than looked up when somebody walks through, because by then the wall is just fire on the board — the
// Nightmare that raised it may be dead or out of its aura, and it burns friend and foe alike.
export class FireWall {
    public constructor(
        public readonly cell: XY,
        private lapsRemaining: number,
        public readonly burnPercentage: number = FIRE_WALL_BURN_PERCENTAGE,
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
    /** Changes whenever renderable fire state changes, so clients can reuse a snapshot between animation frames. */
    private revision = 0;
    public static key(cell: XY): number {
        return (cell.x << 8) | (cell.y & 0xff);
    }
    public size(): number {
        return this.walls.size;
    }
    public getRevision(): number {
        return this.revision;
    }
    public has(cell: XY): boolean {
        return this.walls.has(FireWalls.key(cell));
    }
    // Light a single cell with the given lap budget. Re-casting over a still-burning cell refreshes its
    // lifetime rather than stacking the burn — two walls on one cell would read as one on screen.
    public add(
        cell: XY,
        laps: number = FIRE_WALL_DEFAULT_LAPS,
        burnPercentage: number = FIRE_WALL_BURN_PERCENTAGE,
    ): void {
        this.walls.set(FireWalls.key(cell), new FireWall({ x: cell.x, y: cell.y }, laps, burnPercentage));
        this.revision += 1;
    }
    public addAll(
        cells: XY[],
        laps: number = FIRE_WALL_DEFAULT_LAPS,
        burnPercentage: number = FIRE_WALL_BURN_PERCENTAGE,
    ): void {
        for (const cell of cells) {
            this.add(cell, laps, burnPercentage);
        }
    }
    /** Burn share of the wall on this cell, or 0 when the cell is not alight. */
    public burnPercentageAt(cell: XY): number {
        return this.walls.get(FireWalls.key(cell))?.burnPercentage ?? 0;
    }
    public remove(cell: XY): boolean {
        const removed = this.walls.delete(FireWalls.key(cell));
        if (removed) this.revision += 1;
        return removed;
    }
    public clear(): void {
        if (!this.walls.size) return;
        this.walls.clear();
        this.revision += 1;
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
        let changed = false;
        for (const [key, wall] of this.walls) {
            changed = true;
            wall.minusLap();
            if (wall.getLapsRemaining() <= 0) {
                expired.push({ x: wall.cell.x, y: wall.cell.y });
                this.walls.delete(key);
            }
        }
        if (changed) this.revision += 1;
        return expired;
    }
    // Serialization for fight snapshots / journal replay. Compact shape: [{x,y,l}, ...].
    public toJSON(): IFireWallCellJSON[] {
        const out: IFireWallCellJSON[] = [];
        for (const wall of this.walls.values()) {
            out.push({
                x: wall.cell.x,
                y: wall.cell.y,
                l: wall.getLapsRemaining(),
                p: wall.burnPercentage,
            });
        }
        return out;
    }
    public static fromJSON(data: IFireWallCellJSON[] | undefined | null): FireWalls {
        const store = new FireWalls();
        if (Array.isArray(data)) {
            for (const c of data) {
                if (c && typeof c.x === "number" && typeof c.y === "number" && typeof c.l === "number") {
                    store.add(
                        { x: c.x, y: c.y },
                        c.l,
                        typeof c.p === "number" && c.p > 0 ? c.p : FIRE_WALL_BURN_PERCENTAGE,
                    );
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

/**
 * The share of maximum health a wall burns off per crossing: the base 25%, raised by the caster's total
 * additive magic-damage bonus. The spellbook card prints this exact figure and fireWallCast stores it on every
 * cell it lights, so what the card promises is what the flames take.
 *
 * Rounded to one decimal because 25 x 1.07 = 26.75 and a card reading "26.8%" is honest where "26.75%" is
 * noise — the engine uses the same rounded number, so the two cannot drift.
 */
export function fireWallBurnPercentage(empowerPercentage = 0): number {
    if (!Number.isFinite(empowerPercentage) || empowerPercentage <= 0) {
        return FIRE_WALL_BURN_PERCENTAGE;
    }
    // Scale by (100 + pct)/100 rather than (1 + pct/100): the latter makes 25 x 1.15 come out as
    // 28.749999999999996, which then rounds DOWN to 28.7 and the card under-promises by a tenth.
    return Math.round(((FIRE_WALL_BURN_PERCENTAGE * (100 + empowerPercentage)) / 100) * 10) / 10;
}

/**
 * Damage one crossing does to a stack, given its cumulative maximum health and the burn share of the cell it
 * walked into (FIRE_WALL_BURN_PERCENTAGE, raised by the caster's total magic bonus at cast time).
 */
export function fireWallBurnDamage(
    cumulativeMaxHp: number,
    burnPercentage: number = FIRE_WALL_BURN_PERCENTAGE,
): number {
    if (!Number.isFinite(cumulativeMaxHp) || cumulativeMaxHp <= 0) {
        return 0;
    }
    const share = Number.isFinite(burnPercentage) && burnPercentage > 0 ? burnPercentage : FIRE_WALL_BURN_PERCENTAGE;
    return Math.max(1, Math.floor((cumulativeMaxHp * share) / 100));
}
