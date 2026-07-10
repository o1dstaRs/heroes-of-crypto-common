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
import { StrategyV0_6 } from "./v0_6";
import {
    canWaitOnHourglassMirror,
    DISTILLED_WAIT_WEIGHTS_2026_07_10,
    extractWaitFeatures,
    waitScore,
} from "./wait_scorer";

/**
 * Apply v0.7's committed act-vs-wait candidate to v0.6's final decision. This path is deliberately
 * independent of the env-gated v0.6s experiment: tournaments selecting v0.7 always evaluate the same
 * weights, while selecting v0.6 continues to use the shipping policy unless its own explicit gates are armed.
 */
export function applyV07WaitCandidate(unit: Unit, context: IDecisionContext, incumbent: GameAction[]): GameAction[] {
    const fightProperties = context.fightProperties;
    if (
        !fightProperties ||
        incumbent.some((action) => action.type === "wait_turn") ||
        !canWaitOnHourglassMirror(unit, fightProperties)
    ) {
        return incumbent;
    }

    const features = extractWaitFeatures(unit, context.unitsHolder, fightProperties, incumbent);
    if (waitScore(DISTILLED_WAIT_WEIGHTS_2026_07_10, features) <= 0) {
        return incumbent;
    }
    return [{ type: "wait_turn", unitId: unit.getId() }];
}

/**
 * Explicit v0.7 tournament candidate: v0.6 plus the committed distilled wait decision as its final stage.
 * Registration does not promote it to the in-game default; acceptance and owner sign-off are still required.
 */
export class StrategyV0_7 extends StrategyV0_6 {
    public override readonly version: string = "v0.7";
    protected override finalizeDecision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        return applyV07WaitCandidate(unit, context, decision);
    }
}

export const STRATEGY_V0_7: IAIStrategy = new StrategyV0_7();
