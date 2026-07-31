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

import { Grid } from "../grid/grid";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
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
 * The disc sweeps the whole SEPARATED CLUSTER around the shot's target: it repeatedly bounces to the
 * nearest not-yet-hit enemy standing apart from ANY unit already struck — 1 empty cell of separation
 * keeps full bounce damage, 2 empty cells halves it — until nobody within reach remains. Then it flies
 * home to Zena (the return leg is the client's to animate; it deals no damage).
 *
 * Rules:
 *  - ALLIES ARE NEVER HIT, and never relay the chain.
 *  - Touching units (no gap) and units more than 2 cells apart are never bounced to.
 *  - Each victim is struck at most once per throw; the primary target never takes a second hit.
 *  - Nearest-first: smallest separation to the struck cluster wins; ties break by base-cell distance
 *    to the LAST unit hit, then by unit id — the flight is byte-identical everywhere it is computed.
 *  - Angel's "Arrows Wingshield Aura" owner is never struck and STOPS the whole flight when it is the
 *    next nearest bounce — the shield catches the disc.
 */
export function resolveChakramTrajectory(
    attackerUnit: Unit,
    primaryTarget: Unit,
    unitsHolder: UnitsHolder,
    _grid: Grid,
): IChakramTrajectory {
    const empty: IChakramTrajectory = { steps: [], hitUnits: [], damageFactorByUnitId: {}, mountainCells: [] };
    if (!attackerUnit.getAbility("Chakram") || primaryTarget.isDead()) {
        return empty;
    }

    const steps: IChakramStep[] = [];
    const hitUnits: Unit[] = [];
    const damageFactorByUnitId: Record<string, number> = {};
    // The primary target is already damaged by the shot itself — it anchors the cluster but is never re-hit.
    const struck: Unit[] = [primaryTarget];
    const visited = new Set<string>([primaryTarget.getId()]);

    let last = primaryTarget;
    // Hard bound far above any real board's enemy count, so a pathological state can never loop forever.
    const MAX_HOPS = 64;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
        let next: Unit | undefined;
        let nextSeparation = Number.MAX_SAFE_INTEGER;
        let nextAnchor: Unit | undefined;
        let nextTieBreak = Number.MAX_SAFE_INTEGER;
        for (const unit of unitsHolder.getAllUnits().values()) {
            if (visited.has(unit.getId()) || unit.isDead() || unit.getTeam() === attackerUnit.getTeam()) {
                continue;
            }
            // Nearest qualifying separation to ANYONE already struck; that unit anchors the hop's visual.
            let separation = Number.MAX_SAFE_INTEGER;
            let anchor: Unit | undefined;
            for (const member of struck) {
                const memberSeparation = chakramSeparation(member, unit);
                if (memberSeparation < separation) {
                    separation = memberSeparation;
                    anchor = member;
                }
            }
            const gap = separation - 1;
            if (gap < CHAKRAM_FULL_DAMAGE_GAP || gap > CHAKRAM_HALF_DAMAGE_GAP) {
                continue;
            }
            const from = last.getBaseCell();
            const to = unit.getBaseCell();
            const tieBreak = (to.x - from.x) * (to.x - from.x) + (to.y - from.y) * (to.y - from.y);
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

        const fromCell = nextAnchor.getBaseCell();
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
