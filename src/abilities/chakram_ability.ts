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

import { LUCK_MAX_VALUE_TOTAL } from "../constants";
import { Grid } from "../grid/grid";
import { isCellWithinGrid } from "../grid/grid_math";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

/** Diameter, in cells, of the FULL circle the 1-cell chakram carves at each touch. (Was 5; tightened to 4.) */
export const CHAKRAM_ARC_DIAMETER = 4;

/** The circle is sampled this many times — dense enough that no cell the disc's 1-cell path crosses is skipped. */
const CIRCLE_SAMPLES = 96;

/**
 * How near a swept ring cell a unit must be, in cells, for the 1-cell disc to clip it. Exact-cell-only made the
 * chakram almost never connect (enemies are rarely sitting on the precise rounded ring), so the disc catches
 * whoever it passes within this much of — the physical reach of a 1-cell blade. Tune up for a wider bite.
 */
export const CHAKRAM_CATCH_RADIUS = 1;

/** grid.getOccupantUnitId returns this for a center-mountain cell (the only obstacle the disc can touch). */
const MOUNTAIN_MARKER = "B";

/**
 * One leg of the disc's flight, PRECOMPUTED by the engine so the client only replays it (identical in sandbox
 * and ranked, no client re-roll). The disc rides the arc `circleCells` from `fromCell`: on a normal ricochet
 * leg that's a ≤180° curve TRUNCATED at the one thing it met — `hitUnitIds` holds that enemy, or `mountainCells`
 * that chipped mountain cell — and the disc changes heading there. The final leg, a curve that met nothing, is
 * a FULL 360° flourish loop with empty hits, after which the caller flies the disc home to Zena.
 */
export interface IChakramStep {
    fromCell: XY;
    circleCells: XY[];
    hitUnitIds: string[];
    mountainCells: XY[];
}

export interface IChakramTrajectory {
    /** Flight legs, in order — the client flies the disc leg by leg and lands each hit AS the disc reaches it. */
    steps: IChakramStep[];
    /** Every enemy the disc damages, unique, in flight order — the caller feeds these to processRangeAOEAbility. */
    hitUnits: Unit[];
    /** Every mountain cell the disc chips, unique — the caller reduces the matching mountain's obstacle HP. */
    mountainCells: XY[];
}

/**
 * Damage a chakram hit deals, as a percentage of the primary: ~100%, swinging with luck between 90 and 110.
 */
export function chakramBounceDamagePercent(attackerUnit: Unit): number {
    const luck = Math.max(-LUCK_MAX_VALUE_TOTAL, Math.min(LUCK_MAX_VALUE_TOTAL, attackerUnit.getLuck()));
    return Math.max(90, Math.min(110, 100 + luck));
}

/** Unit-length travel direction between two cells; falls back to "up the board" for a degenerate pair. */
function travelDirection(from: XY, to: XY): XY {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.0001) {
        return { x: 0, y: 1 };
    }
    return { x: dx / length, y: dy / length };
}

/** A full 360° sweep — the disc's terminal flourish loop when a ricochet leg finds nothing. */
export const FULL_SWEEP = 2 * Math.PI;

/** A half (180°) sweep — the forward flank the disc searches on a normal ricochet leg (its "random 180°"). */
export const SEARCH_SWEEP = Math.PI;

/**
 * The rounded cells the 1-cell disc sweeps from `originCell`, in travel order, along an arc of `sweepRadians`.
 *
 * The centre sits half a diameter off the origin, square to the travel direction, on the chosen flank (`side`
 * +1/-1). A `SEARCH_SWEEP` (180°) arc is the curve the disc rides on a normal ricochet leg — it bulges out to
 * the flank and comes back around, redirecting the disc's heading — and the caller truncates it at the first
 * thing the disc meets. A `FULL_SWEEP` (360°) arc is the terminal flourish loop. The "who does it go through"
 * test is pure cell membership on this list, so the server clips only whoever the disc actually passes over.
 */
export function chakramCircleCells(
    originCell: XY,
    direction: XY,
    side: number,
    gridSettings: unknown,
    sweepRadians: number = FULL_SWEEP,
): XY[] {
    const radius = CHAKRAM_ARC_DIAMETER / 2;
    const perpendicular = { x: -direction.y * side, y: direction.x * side };
    const centre = { x: originCell.x + perpendicular.x * radius, y: originCell.y + perpendicular.y * radius };
    const startAngle = Math.atan2(originCell.y - centre.y, originCell.x - centre.x);
    const sweep = sweepRadians * side;
    // Keep the sample density constant regardless of arc length, so no cell a shorter arc crosses is skipped.
    const samples = Math.max(2, Math.round((CIRCLE_SAMPLES * sweepRadians) / FULL_SWEEP));

    const cells: XY[] = [];
    const seen = new Set<number>();
    for (let sample = 1; sample <= samples; sample += 1) {
        const angle = startAngle + (sweep * sample) / samples;
        const cell = {
            x: Math.round(centre.x + Math.cos(angle) * radius),
            y: Math.round(centre.y + Math.sin(angle) * radius),
        };
        const key = (cell.x << 8) | cell.y;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (isCellWithinGrid(gridSettings as never, cell)) {
            cells.push(cell);
        }
    }
    return cells;
}

/**
 * Precompute the WHOLE chakram flight, deterministically, on the engine — the client only replays it.
 *
 * The disc RICOCHETS. From the unit the shot struck it curves off along a ≤180° arc on a random flank; the
 * FIRST new enemy (or mountain) that arc crosses is struck, and the disc CHANGES DIRECTION there and curves off
 * again on a fresh random flank. It keeps bouncing this way — a new heading at every hit — until an arc finds
 * nothing new, at which point it flies ONE full circle (the flourish) and the caller returns it to Zena.
 *
 * Rules:
 *  - ALLIES ARE NEVER HIT.
 *  - A victim / mountain-cell is only ever counted once per throw.
 *  - The disc always makes at least one loop: a lone target's first arc finds nobody, so the flourish circle IS
 *    that one mandatory loop around the target (never an instant bounce home).
 *  - Angel's "Arrows Wingshield Aura" owner is never hit and halts the disc the instant its arc reaches it.
 *  - Only the center mountains ("B") are touchable; the disc flies over lava/water.
 */
export function resolveChakramTrajectory(
    attackerUnit: Unit,
    primaryTarget: Unit,
    unitsHolder: UnitsHolder,
    grid: Grid,
    rollSide: () => number,
): IChakramTrajectory {
    const empty: IChakramTrajectory = { steps: [], hitUnits: [], mountainCells: [] };
    if (!attackerUnit.getAbility("Chakram") || primaryTarget.isDead()) {
        return empty;
    }

    const gridSettings = grid.getSettings();
    const steps: IChakramStep[] = [];
    const hitUnits: Unit[] = [];
    const mountainCells: XY[] = [];
    // The primary target is already damaged by the shot itself, so it never re-arms a bounce or takes a second hit.
    const hitUnitIds = new Set<string>([primaryTarget.getId()]);
    const chippedMountains = new Set<number>();

    let originCell = primaryTarget.getBaseCell();
    let direction = travelDirection(attackerUnit.getBaseCell(), originCell);

    // Hard bound so a pathological board can never loop forever; far above any real ricochet chain.
    const MAX_LEGS = 64;
    for (let leg = 0; leg < MAX_LEGS; leg += 1) {
        const side = rollSide() < 0.5 ? 1 : -1;
        // The forward 180° flank the disc chose this bounce — a radius-2 arc it rides looking for its next hit.
        const searchArc = chakramCircleCells(originCell, direction, side, gridSettings, SEARCH_SWEEP);

        // Walk the arc in travel order and STOP at the first new thing it meets — that's where the disc
        // ricochets. A mountain on the exact cell, or an enemy within a cell of it (the 1-cell blade's reach).
        let hitOrder = -1;
        let hitEnemy: Unit | undefined;
        let hitMountainCell: XY | undefined;
        let hitIsAngel = false;
        for (let i = 0; i < searchArc.length; i += 1) {
            const cell = searchArc[i];
            const mountainKey = (cell.x << 8) | cell.y;
            if (grid.getOccupantUnitId(cell) === MOUNTAIN_MARKER && !chippedMountains.has(mountainKey)) {
                hitOrder = i;
                hitMountainCell = { x: cell.x, y: cell.y };
                break;
            }
            let foundEnemy: Unit | undefined;
            for (const unit of unitsHolder.getAllUnits().values()) {
                if (hitUnitIds.has(unit.getId()) || unit.isDead() || unit.getTeam() === attackerUnit.getTeam()) {
                    continue;
                }
                const unitCells = unit.isSmallSize() ? [unit.getBaseCell()] : unit.getCells();
                for (const uc of unitCells) {
                    if (Math.hypot(cell.x - uc.x, cell.y - uc.y) <= CHAKRAM_CATCH_RADIUS) {
                        foundEnemy = unit;
                        break;
                    }
                }
                if (foundEnemy) {
                    break;
                }
            }
            if (foundEnemy) {
                hitOrder = i;
                hitEnemy = foundEnemy;
                hitIsAngel = foundEnemy.hasAbilityActive("Arrows Wingshield Aura");
                break;
            }
        }

        if (hitOrder < 0) {
            // The 180° search met nothing new: the disc's chain is done. It flies ONE full circle from here (the
            // flourish — also a lone target's single mandatory loop), then the caller sends it home. No hits.
            const flourish = chakramCircleCells(originCell, direction, side, gridSettings, FULL_SWEEP);
            steps.push({
                fromCell: { x: originCell.x, y: originCell.y },
                circleCells: flourish,
                hitUnitIds: [],
                mountainCells: [],
            });
            break;
        }

        // The disc curves from its origin only as far as the thing it met, then ricochets off it.
        const arcCells = searchArc.slice(0, hitOrder + 1);

        if (hitIsAngel) {
            // The Angel halts the disc the instant its arc reaches it — never struck, no flourish. The curve up
            // to the Angel still flew, so record it (empty hits) for the visual, then stop.
            steps.push({
                fromCell: { x: originCell.x, y: originCell.y },
                circleCells: arcCells,
                hitUnitIds: [],
                mountainCells: [],
            });
            break;
        }

        let nextCell: XY;
        if (hitEnemy) {
            hitUnitIds.add(hitEnemy.getId());
            hitUnits.push(hitEnemy);
            nextCell = hitEnemy.getBaseCell();
            steps.push({
                fromCell: { x: originCell.x, y: originCell.y },
                circleCells: arcCells,
                hitUnitIds: [hitEnemy.getId()],
                mountainCells: [],
            });
        } else {
            const cell = hitMountainCell as XY;
            chippedMountains.add((cell.x << 8) | cell.y);
            mountainCells.push({ x: cell.x, y: cell.y });
            nextCell = { x: cell.x, y: cell.y };
            steps.push({
                fromCell: { x: originCell.x, y: originCell.y },
                circleCells: arcCells,
                hitUnitIds: [],
                mountainCells: [{ x: cell.x, y: cell.y }],
            });
        }

        // Ricochet: the next arc curves off from the thing just struck, on a fresh random flank.
        direction = travelDirection(originCell, nextCell);
        originCell = nextCell;
    }

    return { steps, hitUnits, mountainCells };
}
