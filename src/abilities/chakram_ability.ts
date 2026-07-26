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
 * and ranked, no client re-roll). The 1-cell disc traces the full circle `circleCells` from `fromCell`, and —
 * in the order it reaches them — damages `hitUnitIds` and chips `mountainCells`. The first NEW thing the circle
 * touched seeds the next leg; the chain ends the moment a circle finds nothing new (then the disc flies home).
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

/**
 * The rounded cells swept by ONE full circle the 1-cell disc traces from `originCell`, in travel order.
 *
 * Same circle the ricochet always used — centre half a diameter off the touch point, square to the travel
 * direction, on the chosen flank — but swept a FULL 360° (was 180°) so the disc loops all the way around and
 * back. `side` (+1/-1) is the flank the loop bulges to. The precise "who does it go through" test is pure cell
 * membership on this list, which is what lets the server clip only whoever the disc actually passes over.
 */
export function chakramCircleCells(originCell: XY, direction: XY, side: number, gridSettings: unknown): XY[] {
    const radius = CHAKRAM_ARC_DIAMETER / 2;
    const perpendicular = { x: -direction.y * side, y: direction.x * side };
    const centre = { x: originCell.x + perpendicular.x * radius, y: originCell.y + perpendicular.y * radius };
    const startAngle = Math.atan2(originCell.y - centre.y, originCell.x - centre.x);
    const sweep = 2 * Math.PI * side;

    const cells: XY[] = [];
    const seen = new Set<number>();
    for (let sample = 1; sample <= CIRCLE_SAMPLES; sample += 1) {
        const angle = startAngle + (sweep * sample) / CIRCLE_SAMPLES;
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
 * Starting from the unit the shot struck, the 1-cell disc traces a full circle (chakramCircleCells) and hits
 * EVERY enemy and chips EVERY mountain cell that circle passes through, in the order it reaches them. The FIRST
 * new thing it touches (enemy or mountain) seeds the next circle, so the disc walks from cluster to cluster;
 * the chain ends the moment a circle finds nothing new, and the caller then flies the disc home to Zena.
 *
 * Rules:
 *  - ALLIES ARE NEVER HIT.
 *  - A victim / mountain-cell is only ever counted once per throw.
 *  - Angel's "Arrows Wingshield Aura" owner is never hit and stops the chain the instant the disc reaches it
 *    (units the same circle already crossed before it still land — it blocks propagation past itself).
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

    // Hard bound so a pathological board can never loop forever; far above any real chain length.
    const MAX_LEGS = 64;
    for (let leg = 0; leg < MAX_LEGS; leg += 1) {
        const side = rollSide() < 0.5 ? 1 : -1;
        const circleCells = chakramCircleCells(originCell, direction, side, gridSettings);

        const stepUnitIds: string[] = [];
        const stepMountainCells: XY[] = [];
        let nextCell: XY | undefined;
        let stoppedByAngel = false;

        // Mountains: the ring rolls straight over them, so an exact cell hit is right (a mountain fills whole
        // cells). Chip each newly-touched mountain cell.
        for (const cell of circleCells) {
            if (grid.getOccupantUnitId(cell) !== MOUNTAIN_MARKER) {
                continue;
            }
            const key = (cell.x << 8) | cell.y;
            if (chippedMountains.has(key)) {
                continue;
            }
            chippedMountains.add(key);
            stepMountainCells.push({ x: cell.x, y: cell.y });
            mountainCells.push({ x: cell.x, y: cell.y });
        }

        // Units: whoever the 1-cell disc passes within CHAKRAM_CATCH_RADIUS of, in the order the ring reaches
        // them (its earliest cell that clips the unit) — so the disc slices a whole line, not just cells that
        // happen to land exactly on the rounded ring. An Angel is never hit and halts the disc where it sits:
        // units the ring reached BEFORE it still land, nothing past it does.
        const clipped: { unit: Unit; order: number; isAngel: boolean }[] = [];
        for (const unit of unitsHolder.getAllUnits().values()) {
            if (hitUnitIds.has(unit.getId()) || unit.isDead() || unit.getTeam() === attackerUnit.getTeam()) {
                continue;
            }
            const unitCells = unit.isSmallSize() ? [unit.getBaseCell()] : unit.getCells();
            let order = Number.POSITIVE_INFINITY;
            for (let i = 0; i < circleCells.length && order === Number.POSITIVE_INFINITY; i += 1) {
                const rc = circleCells[i];
                for (const uc of unitCells) {
                    if (Math.hypot(rc.x - uc.x, rc.y - uc.y) <= CHAKRAM_CATCH_RADIUS) {
                        order = i;
                        break;
                    }
                }
            }
            if (order !== Number.POSITIVE_INFINITY) {
                clipped.push({ unit, order, isAngel: unit.hasAbilityActive("Arrows Wingshield Aura") });
            }
        }
        clipped.sort((a, b) => a.order - b.order);

        for (const c of clipped) {
            if (c.isAngel) {
                stoppedByAngel = true;
                break;
            }
            hitUnitIds.add(c.unit.getId());
            hitUnits.push(c.unit);
            stepUnitIds.push(c.unit.getId());
            if (!nextCell) {
                nextCell = c.unit.getBaseCell();
            }
        }
        // A mountain seeds the next circle only if no enemy did.
        if (!nextCell && stepMountainCells.length) {
            nextCell = stepMountainCells[0];
        }

        if (stepUnitIds.length || stepMountainCells.length) {
            steps.push({
                fromCell: { x: originCell.x, y: originCell.y },
                circleCells,
                hitUnitIds: stepUnitIds,
                mountainCells: stepMountainCells,
            });
        }

        // Chain ends when the disc is blocked by an Angel or a circle finds nothing new.
        if (stoppedByAngel || !nextCell) {
            break;
        }
        direction = travelDirection(originCell, nextCell);
        originCell = nextCell;
    }

    return { steps, hitUnits, mountainCells };
}
