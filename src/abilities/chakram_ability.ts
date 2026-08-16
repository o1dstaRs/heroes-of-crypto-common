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
 * 1 empty cell between two units keeps FULL bounce damage, 2 empty cells HALVES it, touching units and
 * anything further apart are never bounced to.
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
 */
function hasEmptyBridge(grid: Grid, a: Unit, b: Unit, gap: number): boolean {
    const aCells = a.isSmallSize() ? [a.getBaseCell()] : a.getCells();
    const bCells = b.isSmallSize() ? [b.getBaseCell()] : b.getCells();
    const isEmpty = (cell: XY): boolean => !grid.getOccupantUnitId(cell);
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
 * The disc sweeps the SEPARATED CLUSTER around the shot's target, up to the attacker's stack-power target
 * limit. It repeatedly bounces to the nearest not-yet-hit enemy standing apart from ANY unit already struck —
 * 1 empty cell of separation keeps full bounce damage, 2 empty cells halves it — until nobody within reach
 * remains. Then it flies home to Zena (the return leg is the client's to animate; it deals no damage).
 *
 * Rules:
 *  - ALLIES ARE NEVER HIT, and never relay the chain.
 *  - Touching units (no gap) and units more than 2 cells apart are never bounced to.
 *  - The separating cells must be EMPTY: a unit at the right distance whose gap is filled by another
 *    body (any team, or an obstacle) is a wall, not a bounce target.
 *  - Each victim is struck at most once per throw; the primary target never takes a second hit.
 *  - Total victims, INCLUDING the primary target, cannot exceed the attacker's stack power (1..5).
 *  - Nearest-first: smallest separation to the struck cluster wins; ties break by CHEBYSHEV base-cell
 *    distance to the LAST unit hit (see {@link chakramHopDistance}), then by unit id — the flight is
 *    byte-identical everywhere it is computed. Chebyshev throughout is what makes a straight, diagonal
 *    and knight-offset gap of one cell rank as the same distance rather than three different ones.
 *  - Angel's "Arrows Wingshield Aura" owner is never struck and STOPS the whole flight when it is the
 *    next nearest bounce — the shield catches the disc.
 *  - The flight is ONE CONTINUOUS PATH: eligibility for a hop is judged against the nearest member of the
 *    whole struck cluster, but each hop is always DRAWN flying from wherever the disc currently is (the
 *    unit it struck last), never snapping back to an earlier victim to launch from there. The disc never
 *    reappears at a point on its own already-flown path — it only ever moves forward, and its final leg
 *    (animated client-side) closes the loop back at Zena.
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
    // The primary target is already damaged by the shot itself — it anchors the cluster but is never re-hit.
    const struck: Unit[] = [primaryTarget];
    const visited = new Set<string>([primaryTarget.getId()]);

    let last = primaryTarget;
    // The primary shot already consumes one slot, leaving at most 0..4 secondary victims.
    const maxBounces = chakramMaxTargets(attackerUnit.getStackPower()) - 1;
    for (let hop = 0; hop < maxBounces; hop += 1) {
        let next: Unit | undefined;
        let nextSeparation = Number.MAX_SAFE_INTEGER;
        let nextAnchor: Unit | undefined;
        let nextTieBreak = Number.MAX_SAFE_INTEGER;
        for (const unit of unitsHolder.getAllUnits().values()) {
            if (visited.has(unit.getId()) || unit.isDead() || unit.getTeam() === attackerUnit.getTeam()) {
                continue;
            }
            // Anyone touching the struck cluster is part of the wall, never a bounce — checked FIRST so a
            // blocked bridge below can never promote a shoulder-to-shoulder unit through a farther anchor.
            let minSeparation = Number.MAX_SAFE_INTEGER;
            for (const member of struck) {
                minSeparation = Math.min(minSeparation, chakramSeparation(member, unit));
            }
            if (minSeparation - 1 < CHAKRAM_FULL_DAMAGE_GAP) {
                continue;
            }
            // Nearest qualifying separation to ANYONE already struck whose separating cells are actually
            // EMPTY; that unit anchors the hop's visual. Geometry alone is not enough: in a packed army a
            // diagonal neighbour's neighbour measures two apart with a third body in between, and the disc
            // cannot cut through a wall (the fight report that pinned this: a solid six-stack block still
            // got three units chained).
            let separation = Number.MAX_SAFE_INTEGER;
            let anchor: Unit | undefined;
            for (const member of struck) {
                const memberSeparation = chakramSeparation(member, unit);
                const memberGap = memberSeparation - 1;
                if (memberGap < CHAKRAM_FULL_DAMAGE_GAP || memberGap > CHAKRAM_HALF_DAMAGE_GAP) {
                    continue;
                }
                if (memberSeparation >= separation || !hasEmptyBridge(grid, member, unit, memberGap)) {
                    continue;
                }
                separation = memberSeparation;
                anchor = member;
            }
            if (!anchor) {
                continue;
            }
            const from = last.getBaseCell();
            const to = unit.getBaseCell();
            const tieBreak = chakramHopDistance(from, to);
            if (
                separation < nextSeparation ||
                (separation === nextSeparation && tieBreak < nextTieBreak) ||
                (separation === nextSeparation && tieBreak === nextTieBreak && next && unit.getId() < next.getId())
            ) {
                next = unit;
                nextSeparation = separation;
                nextAnchor = anchor;
                nextTieBreak = tieBreak;
            }
        }

        if (!next || !nextAnchor) {
            break;
        }

        // The disc is a single physical object with one current position: `last` (where the PREVIOUS hop
        // actually landed), never `nextAnchor`. Eligibility and the damage factor are judged against the
        // nearest member of the whole struck cluster (`nextAnchor` may be an earlier victim, not `last`),
        // but the flight itself must still fly FROM where it currently is — otherwise the animation snaps
        // back to an already-visited point before continuing, instead of tracing one continuous path.
        const fromCell = last.getBaseCell();
        const toCell = next.getBaseCell();
        if (next.hasAbilityActive("Arrows Wingshield Aura")) {
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
        struck.push(next);
        hitUnits.push(next);
        damageFactorByUnitId[next.getId()] =
            nextSeparation - 1 === CHAKRAM_FULL_DAMAGE_GAP ? 1 : CHAKRAM_HALF_DAMAGE_FACTOR;
        steps.push({
            fromCell: { x: fromCell.x, y: fromCell.y },
            circleCells: lineCells(fromCell, toCell),
            hitUnitIds: [next.getId()],
            mountainCells: [],
        });
        last = next;
    }

    return { steps, hitUnits, damageFactorByUnitId, mountainCells: [] };
}
