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
import type { Unit } from "../../units/unit";
import type { IAIStrategy, IDecisionContext } from "../ai_strategy";
import { StrategyV0_7 } from "./v0_7";

/**
 * Replace a terminal policy no-op with an explicit engine-valid action. Search still owns the stronger priority:
 * whenever v0.8 has a legal attack, spell, or move, that productive candidate overrides this last-resort defend.
 */
export function ensureExplicitV08Action(unitId: string, decision: GameAction[]): GameAction[] {
    const hasMeaningfulAction = decision.some(
        (action) => action.type !== "select_attack_type" && action.type !== "end_turn",
    );
    return hasMeaningfulAction ? decision : [{ type: "defend_turn", unitId }];
}

/** v0.8 starts from v0.7 but never emits an empty/end-turn-only strategy decision. */
export class StrategyV0_8 extends StrategyV0_7 {
    public override readonly version: string = "v0.8";
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return ensureExplicitV08Action(unit.getId(), super.decideTurn(unit, context));
    }
}

export const STRATEGY_V0_8: IAIStrategy = new StrategyV0_8();
