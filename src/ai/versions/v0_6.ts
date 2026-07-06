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
import type { Unit } from "../../units/unit";
import type { IAIStrategy, IDecisionContext } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { StrategyV0_5 } from "./v0_5";

const RANGE = PBTypes.AttackVals.RANGE;
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
        const move = decision.find((a) => a.type === "move_unit");
        if (!move || move.type !== "move_unit" || !move.path?.length) {
            return decision; // not a pure move
        }
        if (this.canLandRange(unit, context)) {
            return decision; // it can shoot from here; don't interfere
        }
        const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const dest = move.path[move.path.length - 1];
        const distToNearest = Math.min(
            ...enemies.map((e) => {
                const ec = e.getBaseCell();
                return Math.abs(dest.x - ec.x) + Math.abs(dest.y - ec.y);
            }),
        );
        const maxEnemyReach = Math.max(...enemies.map((e) => e.getSteps())) + 1;
        if (distToNearest <= maxEnemyReach) {
            // Advancing walks into melee reach → hold and shoot as the enemy approaches instead.
            return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
        }
        return decision;
    }
}

export const STRATEGY_V0_6: IAIStrategy = new StrategyV0_6();
