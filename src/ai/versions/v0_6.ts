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

import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { StrategyV0_5 } from "./v0_5";
import { DEFAULT_V05_W } from "./v0_5_weights";

const RANGE = PBTypes.AttackVals.RANGE;

/**
 * v0.6's OWN fight-weight vector, kept SEPARATE from v0.5's so v0.6 can be trained further while v0.5 stays
 * byte-for-byte frozen. It starts identical to the v0.5 champion (DEFAULT_V05_W) — so an untrained v0.6 fights
 * exactly like v0.5 — and a co-evolution CEM (OPT=v0.6 vs BASE=v0.5, injecting V06_WEIGHTS) bakes a
 * best-response champion here without ever touching DEFAULT_V05_W. Read from process.env.V06_WEIGHTS during a
 * sim; falls back to this default (== v0.5) on any malformed input so a bad env can never crash live play.
 */
export const DEFAULT_V06_W: readonly number[] = DEFAULT_V05_W.slice();

export function loadV06Weights(): number[] {
    const raw = process.env.V06_WEIGHTS;
    if (raw) {
        try {
            const arr = JSON.parse(raw);
            if (
                Array.isArray(arr) &&
                arr.length === DEFAULT_V06_W.length &&
                arr.every((x) => typeof x === "number" && Number.isFinite(x))
            ) {
                return arr as number[];
            }
        } catch {
            /* malformed -> fall through to default (== frozen v0.5 champion) */
        }
    }
    return DEFAULT_V06_W.slice();
}
const COMBAT_ACTIONS = new Set(["melee_attack", "range_attack", "cast_spell", "obstacle_attack", "area_throw_attack"]);

/**
 * v0.6 — the FULL-GAME AI generation, built on the v0.5 fight champion. Adds a trained DRAFT + setup (baked as
 * weight defaults) and a PROACTIVE RANGED KITE that v0.5 lacks: v0.5 only disengages a shooter once it is
 * already pinned, so a ranged unit out of range ADVANCES into melee (fallbackTurn minimises distance to the
 * enemy) and gets meleed before its range pays off. The kite makes a ranged unit that would walk into an
 * enemy's melee reach HOLD instead, so the enemy enters ITS shooting range first. Gated (V06_KITE=off →
 * byte-for-byte v0.5 fight). v0.6 is now the shipped DEFAULT_AI_VERSION; its draft + setup weights are the
 * live enhancement over the frozen v0.5 baseline.
 */
export class StrategyV0_6 extends StrategyV0_5 {
    public override readonly version: string = "v0.6";
    /** Load v0.6's OWN fight weights (V06_WEIGHTS env or DEFAULT_V06_W) — decoupled from v0.5's V05_WEIGHTS. */
    public constructor() {
        super(loadV06Weights());
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const decision = super.decideTurn(unit, context);
        // Kite is OPT-IN (V06_KITE=on). The minimal "hold instead of advance" version measured neutral-to-slightly
        // negative (melee 64.8%→66.2% vs ranged) — too crude; a real kite needs advance-to-range→shoot→retreat.
        // Default off keeps v0.6's fight byte-for-byte v0.5 (only the draft/setup weights differ).
        if (process.env.V06_KITE !== "on") {
            return decision;
        }
        return this.rangedKite(unit, context, decision);
    }
    /**
     * Proactive kite: if a RANGED unit's chosen turn is a pure ADVANCE (a move with no attack/shot) and it can't
     * land a shot this turn, and advancing would put it inside an enemy's melee reach, HOLD position instead —
     * wait for the enemy to walk into shooting range rather than marching into melee. Never overrides a real
     * shot/melee/cast; only converts a self-destructive advance into a hold.
     */
    private rangedKite(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (unit.getAttackType() !== RANGE || !unit.canMove()) {
            return decision;
        }
        if (decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // already shooting/attacking — leave it
        }
        if (this.canLandRange(unit, context)) {
            return decision; // it can shoot from here; don't interfere
        }
        const move = decision.find((a) => a.type === "move_unit");
        if (!move || move.type !== "move_unit" || !move.path?.length) {
            return decision; // no advance to fix (a hold / non-move) — leave it
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = context.unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const distTo = (fp: XY[]): number =>
            Math.min(
                ...enemies.flatMap((e) =>
                    e
                        .getCells()
                        .map((ec) => Math.min(...fp.map((fc) => Math.abs(fc.x - ec.x) + Math.abs(fc.y - ec.y)))),
                ),
            );
        // Only intervene when the base decision ADVANCES toward the enemy (v0.1 fallbackTurn minimising distance
        // — the self-destructive march). A retreat/disengage (v0.5 noMeleeRetreat) or lateral move is left alone.
        const base = unit.getBaseCell();
        const baseDist = distTo(this.footprintForCell(unit, base, context));
        const destDist = distTo(this.footprintForCell(unit, move.path[move.path.length - 1], context));
        if (destDist >= baseDist) {
            return decision;
        }
        // Enemy melee reach next turn = its move range + one step onto an adjacent cell. Staying strictly beyond
        // it keeps the shooter safe for a turn while it closes to firing range.
        const maxEnemyReach = Math.max(...enemies.map((e) => e.getSteps())) + 1;
        const { grid, matrix, pathHelper } = context;
        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        if (!movePath.knownPaths.size) {
            return decision;
        }
        // Kite target = the reachable cell CLOSEST to the enemy that is still outside melee reach (the "safe
        // frontier"). Advance as far as we safely can so the enemy walks into our shot range next turn, instead
        // of marching into melee (base's advance) OR sitting still out of range (the old crude hold).
        let best: IWeightedRoute | undefined;
        let bestDist = Infinity;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            const dist = distTo(this.footprintForCell(unit, route.cell, context));
            if (dist <= maxEnemyReach) {
                continue; // enemy could reach melee here next turn — not a safe firing perch
            }
            if (dist < bestDist) {
                bestDist = dist;
                best = route;
            }
        }
        if (!best || (best.cell.x === base.x && best.cell.y === base.y)) {
            // No safe cell closer than we already are — don't march into melee; hold and let the enemy approach.
            return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.hasLavaCell,
                hasWaterCell: best.hasWaterCell,
            },
        ];
    }
}

export const STRATEGY_V0_6: IAIStrategy = new StrategyV0_6();
