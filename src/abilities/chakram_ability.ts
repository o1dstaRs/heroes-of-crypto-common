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

import { MAX_UNIT_STACK_POWER, MIN_UNIT_STACK_POWER } from "../constants";
import type { Grid } from "../grid/grid";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

/**
 * The chakram bounces only between units that stand APART: the disc needs open air to curve through.
 * Separation is measured between unit footprints (Chebyshev, so diagonals count the same as straights):
 * 1 empty cell between two units keeps FULL bounce damage, 2 empty cells HALVES it AND ends the flight
 * there, and touching units or anything further apart are never bounced to.
 *
 * The wide bounce being terminal is what stops the disc from chaining an army at half price: it can
 * reach far or it can reach often, never both.
 */
export const CHAKRAM_FULL_DAMAGE_GAP = 1;
export const CHAKRAM_HALF_DAMAGE_GAP = 2;
export const CHAKRAM_HALF_DAMAGE_FACTOR = 0.5;
export const CHAKRAM_ABILITY_NAME = "Chakram";

/** Total enemies one throw may hit, INCLUDING the initially chosen target. */
export function chakramMaxTargets(stackPower: number): number {
    const normalized = Number.isFinite(stackPower) ? Math.round(stackPower) : MIN_UNIT_STACK_POWER;
    return Math.max(MIN_UNIT_STACK_POWER, Math.min(MAX_UNIT_STACK_POWER, normalized));
}

/** Fill the card's target-count placeholder with the same stack tier the trajectory enforces. */
export function chakramDescription(descriptionTemplate: string, stackPower: number): string {
    return descriptionTemplate.replace(/\{\}/g, chakramMaxTargets(stackPower).toString());
}

/**
 * One hop of the disc's flight, PRECOMPUTED by the engine so the client only replays it (identical in
 * sandbox and ranked). `circleCells` is the straight line of cells the disc travels for this hop —
 * the name (and the optional legacy fields) are kept from the ricochet-era wire shape so ranked
 * snapshots and the client replayer keep decoding without a protocol change.
 */
export interface IChakramStep {
    fromCell: XY;
    circleCells: XY[];
    hitUnitIds: string[];
    mountainCells: XY[];
}

export interface IChakramTrajectory {
    /** Flight hops, in order — the client flies the disc hop by hop and lands each hit AS it arrives. */
    steps: IChakramStep[];
    /** Every enemy the disc damages, unique, in flight order — fed into the shared range-AOE tail. */
    hitUnits: Unit[];
    /** Bounce damage factor per hit unit: 1 for a 1-cell gap, 0.5 for a 2-cell gap. */
    damageFactorByUnitId: Record<string, number>;
    /** Legacy ricochet-era field — the separation chakram never touches mountains. Always empty. */
    mountainCells: XY[];
}

/** What the throw actually did, once the dodges along the flight are rolled. */
export interface IChakramFlightOutcome {
    /** The hops the disc really flew — everything past a dodge is never flown. */
    trajectory: IChakramTrajectory;
    /**
     * Miss verdict for every unit the disc reached, the primary target included. The engine damages
     * these through the shared range-AOE tail, which must REUSE these verdicts instead of rolling its
     * own — a second roll would let the flight stop on one victim and damage the next anyway.
     */
    missByUnitId: Record<string, boolean>;
}

/**
 * Cut the flight short at the first victim that dodges.
 *
 * A chakram is ONE disc on ONE continuous path, so a victim it never touched is a victim it never left:
 * a dodge ends the throw where it happened and the disc drops and returns to Zena, instead of carrying
 * on to the enemy behind. Dodging the throw itself stops it before the first bounce.
 *
 * The dodging victim KEEPS its hop — the disc visibly flies at it and is dodged — and stays among the
 * affected units so the client can pop MISS over it. Only the hops beyond it are dropped.
 *
 * The roll is injected rather than taken here so {@link resolveChakramTrajectory} stays pure geometry:
 * the red hover preview calls it too, and a preview must neither consume the fight's RNG nor pretend to
 * know which way a dodge will land.
 */
export function resolveChakramFlightMisses(
    trajectory: IChakramTrajectory,
    primaryTarget: Unit,
    primaryMissed: boolean,
    rollMiss: (victim: Unit) => boolean,
): IChakramFlightOutcome {
    const missByUnitId: Record<string, boolean> = { [primaryTarget.getId()]: primaryMissed };
    if (primaryMissed) {
        return {
            trajectory: { steps: [], hitUnits: [], damageFactorByUnitId: {}, mountainCells: [] },
            missByUnitId,
        };
    }

    const hitUnits: Unit[] = [];
    const damageFactorByUnitId: Record<string, number> = {};
    // Nothing dodges: the disc flies the whole planned flight, trailing Angel-shield hop included.
    let flownSteps = trajectory.steps.length;
    for (let hop = 0; hop < trajectory.hitUnits.length; hop += 1) {
        const victim = trajectory.hitUnits[hop];
        hitUnits.push(victim);
        damageFactorByUnitId[victim.getId()] = trajectory.damageFactorByUnitId[victim.getId()];
        const missed = rollMiss(victim);
        missByUnitId[victim.getId()] = missed;
        if (missed) {
            flownSteps = hop + 1;
            break;
        }
    }

    return {
        trajectory: {
            steps: trajectory.steps.slice(0, flownSteps),
            hitUnits,
            damageFactorByUnitId,
            mountainCells: [],
        },
        missByUnitId,
    };
}

/**
 * How far the disc reckons one hop, base cell to base cell — Chebyshev, the same metric
 * {@link chakramSeparation} uses. Every arrangement with ONE cell in between is one hop, whether that
 * cell sits straight ahead, on the diagonal, or on a knight-style offset:
 *
 *   . . X      . . .      . . .
 *   . . .      . X .      . . .
 *   A . .      A . .      A . X
 *
 * All three read 2 here (one empty cell between), so none of them is "farther" than the others. Squared
 * Euclidean would rank the same three 4 / 5 / 8 and quietly bias the flight toward the straight gap.
 */
export function chakramHopDistance(from: XY, to: XY): number {
    return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
}

/** Direction from one cell to another, in radians. */
const chakramBearing = (from: XY, to: XY): number => Math.atan2(to.y - from.y, to.x - from.x);

/**
 * How far CLOCKWISE you must turn from `heading` to be looking at `bearing`, in [0, 2π).
 *
 * The grid is y-UP — the LOWER team sits at low y and the UPPER team at high y — so atan2 grows
 * counter-clockwise and turning clockwise means SUBTRACTING angle. Straight ahead is 0, so a target
 * directly in the disc's path is taken before it sweeps anywhere.
 */
export const chakramClockwiseSweep = (heading: number, bearing: number): number => {
    const turn = (heading - bearing) % (2 * Math.PI);
    return turn < 0 ? turn + 2 * Math.PI : turn;
};

/** Footprint-to-footprint Chebyshev distance: the number of empty cells between two units, plus one. */
export function chakramSeparation(a: Unit, b: Unit): number {
    const aCells = a.isSmallSize() ? [a.getBaseCell()] : a.getCells();
    const bCells = b.isSmallSize() ? [b.getBaseCell()] : b.getCells();
    let best = Number.MAX_SAFE_INTEGER;
    for (const ac of aCells) {
        for (const bc of bCells) {
            best = Math.min(best, Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y)));
        }
    }
    return best;
}

const CHAKRAM_NEIGHBOR_OFFSETS: readonly XY[] = [
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: -1, y: 1 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
];

/**
 * Whether the SEPARATING cells between two units are actually open air: an empty-cell chain of length
 * `gap` linking the two footprints, every link Chebyshev-adjacent. A packed army has the GEOMETRY of a
 * gap — a diagonal neighbour's neighbour measures two apart — but the cell in between holds a third
 * body, and the disc cannot cut through a wall: no empty bridge, no bounce. Anything standing there
 * blocks — enemy, ally, or an obstacle the grid tracks.
 *
 * Every link must also lie BETWEEN the two units — inside the box their footprints span — not beside
 * them. Otherwise a shoulder-to-shoulder row A B C bounced A -> C by curving through the empty cell
 * next to B, and a diagonal stair did the same: B fills the space between them, and a filled space is
 * not a gap, whichever way you walk around it.
 */
function hasEmptyBridge(grid: Grid, a: Unit, b: Unit, gap: number): boolean {
    const aCells = a.isSmallSize() ? [a.getBaseCell()] : a.getCells();
    const bCells = b.isSmallSize() ? [b.getBaseCell()] : b.getCells();
    const spanned = [...aCells, ...bCells];
    const minX = Math.min(...spanned.map((cell) => cell.x));
    const maxX = Math.max(...spanned.map((cell) => cell.x));
    const minY = Math.min(...spanned.map((cell) => cell.y));
    const maxY = Math.max(...spanned.map((cell) => cell.y));
    const isBetween = (cell: XY): boolean => cell.x >= minX && cell.x <= maxX && cell.y >= minY && cell.y <= maxY;
    const isEmpty = (cell: XY): boolean => isBetween(cell) && !grid.getOccupantUnitId(cell);
    const touches = (cell: XY, cells: XY[]): boolean =>
        cells.some((c) => Math.max(Math.abs(c.x - cell.x), Math.abs(c.y - cell.y)) === 1);

    // Empty cells hugging `a`'s footprint — every bridge starts on one of these.
    const starts: XY[] = [];
    const seen = new Set<string>();
    for (const ac of aCells) {
        for (const offset of CHAKRAM_NEIGHBOR_OFFSETS) {
            const cell = { x: ac.x + offset.x, y: ac.y + offset.y };
            const key = `${cell.x}:${cell.y}`;
            if (!seen.has(key) && isEmpty(cell)) {
                seen.add(key);
                starts.push(cell);
            }
        }
    }
    if (gap === 1) {
        return starts.some((cell) => touches(cell, bCells));
    }
    // gap === 2: one more empty link between a start cell and `b`.
    return starts.some((first) =>
        CHAKRAM_NEIGHBOR_OFFSETS.some((offset) => {
            const second = { x: first.x + offset.x, y: first.y + offset.y };
            return isEmpty(second) && touches(second, bCells);
        }),
    );
}

/** The straight run of cells from `from` to `to` (exclusive of `from`), for the hop's flight visual. */
function lineCells(from: XY, to: XY): XY[] {
    const cells: XY[] = [];
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    for (let i = 1; i <= steps; i += 1) {
        cells.push({
            x: Math.round(from.x + ((to.x - from.x) * i) / steps),
            y: Math.round(from.y + ((to.y - from.y) * i) / steps),
        });
    }
    return cells;
}

/**
 * Precompute the WHOLE chakram flight, deterministically, on the engine — the client only replays it,
 * and the hover preview calls the same function to show exactly who will be struck.
 *
 * The disc flies ONE CONTINUOUS PATH — a directed cycle, Zena -> primary target -> bounce -> bounce ->
 * ... -> home to Zena (the return leg is the client's to animate; it deals no damage). It is a single
 * physical object with one position at a time, so every hop is reckoned from WHERE IT CURRENTLY IS: it
 * bounces to the nearest not-yet-hit enemy standing apart from the unit it struck LAST — 1 empty cell of
 * separation keeps full bounce damage, 2 empty cells halves it AND is the last hop — and stops the moment
 * nothing is in reach of that spot. A chain that walks into a dead end simply ends there and comes home.
 *
 * Reckoning from the last victim (rather than from anything already struck) is what keeps the flight a
 * cycle instead of a zigzag: a unit that merely stands near an EARLIER victim is NOT eligible, because
 * reaching it would fly the disc back across ground it has already covered — fanning out to one side of
 * the target and then cutting back through it to the other. The disc never re-appears at a point on its
 * own already-flown path; it only ever moves forward, then closes the loop at Zena.
 *
 * Rules:
 *  - ALLIES ARE NEVER HIT, and never relay the chain.
 *  - Touching units (no gap) and units more than 2 cells apart are never bounced to.
 *  - The separating cells must be EMPTY: a unit at the right distance whose gap is filled by another
 *    body (any team, or an obstacle) is a wall, not a bounce target.
 *  - A 2-empty-cell (half damage) bounce ENDS the flight: the disc spends itself on that stretch, strikes
 *    that victim and returns to Zena. Only 1-cell bounces relay onward, so a throw reaches far or reaches
 *    often, never both.
 *  - Each victim is struck at most once per throw; the primary target never takes a second hit.
 *  - Total victims, INCLUDING the primary target, cannot exceed the attacker's stack power (1..5).
 *  - CLOCKWISE, not nearest-first: of the enemies in reach, the disc takes whichever it meets first
 *    sweeping clockwise from the direction it is already travelling. It leaves Zena's hand aimed at the
 *    primary target, and every bounce sets the heading for the next, so the flight keeps turning the
 *    same way instead of jumping to whatever happens to be closest. Nothing is rolled: the board's
 *    geometry alone decides the order, and the flight is byte-identical everywhere it is computed.
 *    Reach is still governed by separation (a 1- or 2-cell gap of open air); clockwise only decides
 *    WHICH of the reachable enemies comes next. Two enemies on the exact same bearing break the tie by
 *    the nearer one first, then by unit id.
 *  - Angel's "Arrows Wingshield Blessing" owner is never struck and STOPS the whole flight when it is the
 *    next bounce clockwise — the shield catches the disc.
 */
export function resolveChakramTrajectory(
    attackerUnit: Unit,
    primaryTarget: Unit,
    unitsHolder: UnitsHolder,
    grid: Grid,
): IChakramTrajectory {
    const empty: IChakramTrajectory = { steps: [], hitUnits: [], damageFactorByUnitId: {}, mountainCells: [] };
    if (!attackerUnit.getAbility(CHAKRAM_ABILITY_NAME) || primaryTarget.isDead()) {
        return empty;
    }

    const steps: IChakramStep[] = [];
    const hitUnits: Unit[] = [];
    const damageFactorByUnitId: Record<string, number> = {};
    const visited = new Set<string>([primaryTarget.getId()]);

    // Where the disc physically IS. It starts on the primary target (already damaged by the throw itself,
    // never re-hit) and every bounce is reckoned from here — see the one-continuous-path rule above.
    let last = primaryTarget;
    // The direction the disc is travelling as it arrives. It leaves Zena's hand aimed at the primary
    // target, and after that each bounce sets the heading for the next one.
    let heading = chakramBearing(attackerUnit.getBaseCell(), primaryTarget.getBaseCell());
    // The primary shot already consumes one slot, leaving at most 0..4 secondary victims.
    const maxBounces = chakramMaxTargets(attackerUnit.getStackPower()) - 1;
    for (let hop = 0; hop < maxBounces; hop += 1) {
        let next: Unit | undefined;
        let nextSeparation = Number.MAX_SAFE_INTEGER;
        let nextSweep = Number.POSITIVE_INFINITY;
        for (const unit of unitsHolder.getAllUnits().values()) {
            if (visited.has(unit.getId()) || unit.isDead() || unit.getTeam() === attackerUnit.getTeam()) {
                continue;
            }
            // Reckoned from the disc's CURRENT position only. A unit that merely stands near an EARLIER
            // victim is out of reach: honouring it would fly the disc back across ground it has already
            // covered (fan out left, then cut back right through the primary), which is a zigzag, not a
            // chakram's flight. Touching units (gap 0) are the wall the disc cannot curve through, and
            // anything past 2 empty cells is simply too far.
            const separation = chakramSeparation(last, unit);
            const gap = separation - 1;
            if (gap < CHAKRAM_FULL_DAMAGE_GAP || gap > CHAKRAM_HALF_DAMAGE_GAP) {
                continue;
            }
            // Geometry alone is not enough: in a packed army a diagonal neighbour's neighbour measures two
            // apart with a third body in between, and the disc cannot cut through a wall (the fight report
            // that pinned this: a solid six-stack block still got three units chained).
            if (!hasEmptyBridge(grid, last, unit, gap)) {
                continue;
            }
            // CLOCKWISE, not nearest. The disc keeps turning the same way, so the flight reads as one
            // curving sweep rather than a scatter of shortest hops — and which target comes next is
            // decided by the board's geometry alone. Straight ahead sweeps 0, so a target already in the
            // disc's path is taken before it turns at all.
            const sweep = chakramClockwiseSweep(heading, chakramBearing(last.getBaseCell(), unit.getBaseCell()));
            if (
                sweep < nextSweep ||
                // Two enemies on the exact same bearing: the nearer one is in front, so it is struck
                // first. Unit id settles the last theoretical tie so the flight stays byte-identical.
                (sweep === nextSweep && separation < nextSeparation) ||
                (sweep === nextSweep && separation === nextSeparation && next && unit.getId() < next.getId())
            ) {
                next = unit;
                nextSeparation = separation;
                nextSweep = sweep;
            }
        }

        if (!next) {
            break;
        }

        const fromCell = last.getBaseCell();
        const toCell = next.getBaseCell();
        if (next.hasAbilityActive("Arrows Wingshield Blessing")) {
            // The shield catches the disc: the hop flies (for the visual) but lands no hit, and the
            // flight ends here — the disc drops and returns to Zena.
            steps.push({
                fromCell: { x: fromCell.x, y: fromCell.y },
                circleCells: lineCells(fromCell, toCell),
                hitUnitIds: [],
                mountainCells: [],
            });
            break;
        }

        visited.add(next.getId());
        hitUnits.push(next);
        const isWideBounce = nextSeparation - 1 !== CHAKRAM_FULL_DAMAGE_GAP;
        damageFactorByUnitId[next.getId()] = isWideBounce ? CHAKRAM_HALF_DAMAGE_FACTOR : 1;
        steps.push({
            fromCell: { x: fromCell.x, y: fromCell.y },
            circleCells: lineCells(fromCell, toCell),
            hitUnitIds: [next.getId()],
            mountainCells: [],
        });
        if (isWideBounce) {
            // Crossing TWO empty cells is the stretch that already costs half the damage — the disc
            // arrives spent. It strikes this victim and goes home: a wide bounce is always the last one,
            // so a throw can reach far or reach often, never both.
            break;
        }
        // The disc leaves this victim travelling the way it arrived, so the next sweep turns from here.
        heading = chakramBearing(fromCell, toCell);
        last = next;
    }

    return { steps, hitUnits, damageFactorByUnitId, mountainCells: [] };
}
