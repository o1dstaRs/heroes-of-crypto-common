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

/**
 * LEARNED army placement for v0.5 — the deployment counterpart to the learned per-turn scorer.
 *
 * Placement was the one AI seam CEM never touched: v0.5 inherited v0.4→v0.3's hand-coded layout, whose flyer
 * "flank wing" measurably costs flyer-heavy mirrors. This module makes placement a POLICY: each unit's cell is
 * chosen by a weighted sum of a few normalized features, greedily assigned. It is deliberately kept in its own
 * file + its own weight vector (separate from the 49/53-dim scoring vector) so it can be trained and baked
 * independently — the placement reward is orthogonal to the per-turn reward.
 *
 * ANCHORED like the scoring seams: an `incumbent` feature = "is this the cell v0.4 would give this unit", with a
 * dominant default weight. So DEFAULT_PLACE_W reproduces the inherited v0.4 placement EXACTLY (a strict no-op
 * extension); CEM only deviates when raising the role features / lowering the anchor wins on the self-play
 * reward. Injected at runtime via process.env.V05_PLACE_WEIGHTS (JSON number[]) — never read from disk, so the
 * browser client bundle is unaffected.
 */
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import { getDistance, type XY } from "../../utils/math";
import type { Unit } from "../../units/unit";
import type { IPlacementContext } from "../ai_strategy";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const placeCellKey = (cell: XY): number => (cell.x << 4) | cell.y;

/**
 * Weight layout. [0] is the v0.4 incumbency anchor; the rest are 3 features × 4 roles. Each feature is
 * normalized to [0,1] so weights are directly comparable:
 *   front    — depth toward the enemy (0 = own edge, 1 = frontmost legal row)
 *   edge     — distance from the deployment centre (0 = centred, 1 = flank)
 *   cohesion — closeness to the centroid of already-placed allies (1 = tight pack, 0 = far)
 * Keep in sync with DEFAULT_PLACE_W and the placement CEM's dimension.
 */
export const PLACEMENT_WEIGHT_KEYS = [
    "incumbent", // + 1 if the cell == v0.4's own pick for this unit (dominant default => byPolicy == v0.4)
    "meleeFront",
    "meleeEdge",
    "meleeCohesion",
    "flyerFront",
    "flyerEdge",
    "flyerCohesion",
    "rangedFront",
    "rangedEdge",
    "rangedCohesion",
    "supportFront",
    "supportEdge",
    "supportCohesion",
] as const;

/**
 * ANCHOR vector: incumbent dominates (10) and every learned feature is 0, so each unit picks v0.4's own cell
 * and byPolicy reproduces the inherited placement EXACTLY. This is the shipped no-op until a placement-CEM run
 * bakes a trained vector here. Length MUST equal PLACEMENT_WEIGHT_KEYS.length.
 */
export const DEFAULT_PLACE_W: readonly number[] = [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Resolve the active placement weights. Honours process.env.V05_PLACE_WEIGHTS for CEM training / A-B runs. */
export function loadPlaceWeights(): number[] {
    const raw = process.env.V05_PLACE_WEIGHTS;
    if (raw) {
        try {
            const arr = JSON.parse(raw);
            if (
                Array.isArray(arr) &&
                arr.length === DEFAULT_PLACE_W.length &&
                arr.every((x) => typeof x === "number" && Number.isFinite(x))
            ) {
                return arr as number[];
            }
        } catch {
            /* malformed -> fall through to the anchor */
        }
    }
    return DEFAULT_PLACE_W.slice();
}

type Role = "melee" | "flyer" | "ranged" | "support";
const roleOf = (u: Unit): Role => {
    if (u.getAttackType() === RANGE) {
        return "ranged";
    }
    if (u.getAttackType() === MELEE) {
        return u.canFly() ? "flyer" : "melee";
    }
    return "support";
};
// First weight index of each role's (front, edge, cohesion) triple within the vector.
const ROLE_BASE: Record<Role, number> = { melee: 1, flyer: 4, ranged: 7, support: 10 };

/**
 * Place `units` by the learned policy. `incumbent` is v0.4's own placement (super.placeArmy) — used as the
 * anchor feature. Greedy: units in a fixed role order (melee → flyer → ranged → support, large-first), each
 * taking the highest-scoring free+legal cell whose footprint fits. With DEFAULT_PLACE_W this returns exactly
 * `incumbent`; falls back to the incumbent cell (then any free cell) if scoring finds nothing.
 */
export function placeByPolicy(
    units: Unit[],
    context: IPlacementContext,
    incumbent: Map<string, XY>,
    weights: number[],
): Map<string, XY> {
    const placements = new Map<string, XY>();
    const legal = context.placement.possibleCellHashes();
    const baseCells = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
    if (!baseCells.length) {
        return placements;
    }

    const frontnessRaw = (c: XY): number => (context.team === PBTypes.TeamVals.LOWER ? c.y : GRID_SIZE - 1 - c.y);
    const xs = baseCells.map((c) => c.x);
    const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const maxFront = Math.max(1, ...baseCells.map(frontnessRaw));
    const maxEdge = Math.max(1, ...baseCells.map((c) => Math.abs(c.x - centreX)));
    const diag = Math.max(1, GRID_SIZE);

    const footprintFor = (u: Unit, base: XY): XY[] =>
        u.isSmallSize()
            ? [base]
            : [
                  { x: base.x, y: base.y },
                  { x: base.x - 1, y: base.y },
                  { x: base.x, y: base.y - 1 },
                  { x: base.x - 1, y: base.y - 1 },
              ];
    const fits = (u: Unit, base: XY, occ: Set<number>): boolean =>
        footprintFor(u, base).every((c) => legal.has(placeCellKey(c)) && !occ.has(placeCellKey(c)));

    const occupied = new Set<number>();
    const placed: XY[] = [];
    const bySizeLargeFirst = (a: Unit, b: Unit): number => (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1);
    const order: Unit[] = (["melee", "flyer", "ranged", "support"] as Role[]).flatMap((r) =>
        units.filter((u) => roleOf(u) === r).sort(bySizeLargeFirst),
    );

    for (const u of order) {
        const rb = ROLE_BASE[roleOf(u)];
        const inc = incumbent.get(u.getId());
        let best: XY | undefined;
        let bestScore = -Infinity;
        for (const base of baseCells) {
            if (!fits(u, base, occupied)) {
                continue;
            }
            const front = frontnessRaw(base) / maxFront;
            const edge = Math.abs(base.x - centreX) / maxEdge;
            let cohesion = 0;
            if (placed.length) {
                const cx = placed.reduce((s, c) => s + c.x, 0) / placed.length;
                const cy = placed.reduce((s, c) => s + c.y, 0) / placed.length;
                cohesion = 1 - Math.min(1, getDistance(base, { x: cx, y: cy }) / diag);
            }
            const isInc = inc && base.x === inc.x && base.y === inc.y ? 1 : 0;
            const score =
                weights[0] * isInc + weights[rb] * front + weights[rb + 1] * edge + weights[rb + 2] * cohesion;
            if (score > bestScore) {
                bestScore = score;
                best = base;
            }
        }
        if (!best && inc && fits(u, inc, occupied)) {
            best = inc;
        }
        if (!best) {
            best = baseCells.find((b) => fits(u, b, occupied));
        }
        if (!best) {
            continue;
        }
        for (const c of footprintFor(u, best)) {
            occupied.add(placeCellKey(c));
        }
        placements.set(u.getId(), { x: best.x, y: best.y });
        placed.push(best);
    }
    return placements;
}
