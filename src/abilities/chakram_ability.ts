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

import { LUCK_MAX_VALUE_TOTAL, MAX_UNIT_STACK_POWER } from "../constants";
import { Grid } from "../grid/grid";
import { isCellWithinGrid } from "../grid/grid_math";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import type { XY } from "../utils/math";

/** Diameter, in cells, of the half circle a chakram carves between two victims (see chakramBounceCells). */
export const CHAKRAM_ARC_DIAMETER = 5;

/** The arc is sampled this many times; enough that no cell a 2.5-radius arc crosses is skipped. */
const ARC_SAMPLES = 64;

export interface IChakramBounce {
    /** The unit this bounce struck. */
    unit: Unit;
    /** Cells the chakram swept getting there — the client draws the arc through these. */
    arcCells: XY[];
}

/**
 * How many times the chakram may ricochet. Chakram is a STACK-POWERED ability, and the stack is what the
 * bounce count scales with (the damage stays ~100% — see chakramBounceDamagePercent), so a full-strength
 * Zena chains through a line while a battered one gets a single kickback.
 */
export function chakramBounceBudget(attackerUnit: Unit): number {
    const stackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, attackerUnit.getStackPower()));
    return Math.max(1, Math.round(stackPower));
}

/**
 * Damage a bounce deals, as a percentage of the primary hit: ~100%, swinging with luck between 90 and 110.
 * A lucky chakram comes back harder than it went out.
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
 * The cells swept by ONE half-circle bounce, in travel order.
 *
 * The chakram leaves the unit it just struck, curls through a half circle of CHAKRAM_ARC_DIAMETER cells and
 * comes out the far side — bulging in the direction it was already travelling, curving to whichever flank
 * `side` names. Geometrically: the circle's centre sits half a diameter off the impact, square to the
 * travel direction; the arc runs 180 degrees from the impact cell, through the forward bulge, to the point
 * a full diameter to the side. That is the shape a thrown chakram traces, and it is why a bounce can reach
 * a unit that is beside the victim rather than behind it.
 *
 * `side` is +1 or -1 — the two flanks. The caller rolls it, so a throw travelling up the board bounces left
 * or right, and one travelling across bounces up or down, exactly as the direction dictates.
 */
/**
 * The continuous sweep of the same half circle, as points rather than snapped cells. Target selection uses
 * this: a thrown disc clips whatever it passes CLOSE to, and testing "is a unit exactly on a rounded arc
 * cell" made the bounce miss roughly half the time even with enemies packed around the victim.
 */
export function chakramBouncePath(impactCell: XY, direction: XY, side: number): XY[] {
    const radius = CHAKRAM_ARC_DIAMETER / 2;
    const perpendicular = { x: -direction.y * side, y: direction.x * side };
    const centre = { x: impactCell.x + perpendicular.x * radius, y: impactCell.y + perpendicular.y * radius };
    const startAngle = Math.atan2(impactCell.y - centre.y, impactCell.x - centre.x);
    const sweep = Math.PI * side;

    const points: XY[] = [];
    for (let sample = 1; sample <= ARC_SAMPLES; sample += 1) {
        const angle = startAngle + (sweep * sample) / ARC_SAMPLES;
        points.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
    }
    return points;
}

/** How near the sweep a unit must be for the disc to clip it, in cells. */
export const CHAKRAM_CATCH_RADIUS = 1;

export function chakramBounceCells(impactCell: XY, direction: XY, side: number, gridSettings: unknown): XY[] {
    const radius = CHAKRAM_ARC_DIAMETER / 2;
    // Perpendicular to travel, on the chosen flank.
    const perpendicular = { x: -direction.y * side, y: direction.x * side };
    const centre = { x: impactCell.x + perpendicular.x * radius, y: impactCell.y + perpendicular.y * radius };
    // Angle of the impact as seen from the arc's centre; sweep 180 degrees from there, bulging forward.
    const startAngle = Math.atan2(impactCell.y - centre.y, impactCell.x - centre.x);
    const sweep = Math.PI * side;

    const cells: XY[] = [];
    const seen = new Set<number>();
    for (let sample = 1; sample <= ARC_SAMPLES; sample += 1) {
        const angle = startAngle + (sweep * sample) / ARC_SAMPLES;
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
 * Resolve the whole ricochet chain for one chakram throw.
 *
 * Starting from the unit the shot actually hit, each bounce carves a half circle (chakramBounceCells) and
 * strikes the FIRST enemy along it that has not been hit yet; that victim becomes the origin of the next
 * arc, so the chakram walks from target to target the way it is thrown. The chain ends when the budget runs
 * out or an arc finds nobody.
 *
 * Rules baked in here:
 *  - ALLIES ARE NEVER HIT. The chakram is AOE for damage purposes, but it does not cut its own army.
 *  - Angel's "Arrows Wingshield Aura" owner does not propagate AOE range damage, so the chakram neither
 *    strikes it nor carries on past it — the chain simply stops, matching Large Caliber / Area Throw.
 *  - A victim is only ever struck once per throw.
 *
 * Returns the bounces in order. The caller feeds their units to processRangeAOEAbility, which is what makes
 * the bounce a real AOE hit (Giant's Maul, status resistance, Flesh Shield ordering, per-unit numbers).
 */
export function resolveChakramBounces(
    attackerUnit: Unit,
    primaryTarget: Unit,
    unitsHolder: UnitsHolder,
    grid: Grid,
    rollSide: () => number,
): IChakramBounce[] {
    const bounces: IChakramBounce[] = [];
    if (!attackerUnit.getAbility("Chakram") || primaryTarget.isDead()) {
        return bounces;
    }

    const gridSettings = grid.getSettings();
    const budget = chakramBounceBudget(attackerUnit);
    const alreadyHit = new Set<string>([primaryTarget.getId()]);

    let originCell = primaryTarget.getBaseCell();
    let direction = travelDirection(attackerUnit.getBaseCell(), originCell);

    for (let bounce = 0; bounce < budget; bounce += 1) {
        const side = rollSide() < 0.5 ? 1 : -1;
        const arcCells = chakramBounceCells(originCell, direction, side, gridSettings);
        const arcPath = chakramBouncePath(originCell, direction, side);

        // Whoever the sweep passes closest to FIRST. Walking the continuous path (rather than the rounded
        // cells) means the disc clips a unit standing beside its line, which is how a thrown chakram reads —
        // and is the difference between the bounce landing reliably and almost never connecting.
        let victim: Unit | undefined;
        let victimOrder = Number.POSITIVE_INFINITY;
        let blockedByAngel = false;
        for (const candidate of unitsHolder.getAllUnits().values()) {
            if (alreadyHit.has(candidate.getId()) || candidate.isDead()) {
                continue;
            }
            if (candidate.getTeam() === attackerUnit.getTeam()) {
                continue; // never cuts its own army
            }
            const cell = candidate.getBaseCell();
            for (let index = 0; index < arcPath.length; index += 1) {
                const point = arcPath[index];
                if (Math.hypot(point.x - cell.x, point.y - cell.y) > CHAKRAM_CATCH_RADIUS) {
                    continue;
                }
                if (index < victimOrder) {
                    victimOrder = index;
                    // Angel: its owner neither takes the bounce nor lets it travel on. Being the first thing
                    // the sweep reaches is what stops the chain — a further-along Angel doesn't shield others.
                    blockedByAngel = candidate.hasAbilityActive("Arrows Wingshield Aura");
                    victim = blockedByAngel ? undefined : candidate;
                }
                break;
            }
        }

        if (blockedByAngel || !victim) {
            return bounces;
        }

        bounces.push({ unit: victim, arcCells });
        alreadyHit.add(victim.getId());
        const nextCell = victim.getBaseCell();
        direction = travelDirection(originCell, nextCell);
        originCell = nextCell;
    }

    return bounces;
}
