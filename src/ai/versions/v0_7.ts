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
import { applyWaitScorerWeights, v07BakedWaitWeights } from "./wait_scorer";

/**
 * v0.7 — the WAIT-SCORER generation (S1 of the v0.7 program): the full v0.6 chain with the Q2 Gate-2
 * distilled act-vs-wait scorer BAKED IN. Where v0.6 only arms the scorer behind V07_WAIT_SCORER env gates
 * (the anchor pattern for A/Bs), v0.7 always evaluates the committed DISTILLED_WAIT_WEIGHTS_2026_07_10 —
 * the verified +18.82pp ± 0.42 LIVETWIN-melee artifact (12k games, seed 927001; mixed50 +16.21, random
 * +8.78; transitivity vs v0.4 81.10% vs plain v0.6's 73.17%).
 *
 * Weight resolution (wait_scorer.ts v07BakedWaitWeights): committed defaults, still overridable via
 * V07_WAIT_WEIGHTS for experiments; an ALL-ZERO override is the anchor escape hatch — v0.7 then plays
 * byte-for-byte v0.6. v0.6/v0.6s behavior is untouched: their env-gated finalizeDecision stage and every
 * experiment knob (v0.6s search alias, V07_WAIT_VERSIONS scopes) keep working exactly as before.
 */
export class StrategyV0_7 extends StrategyV0_6 {
    public override readonly version: string = "v0.7";
    /** v0.6's final-stage seam: replace the env-gated experiment stage with the committed baked scorer. */
    protected override finalizeDecision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        return applyWaitScorerWeights(unit, context, decision, v07BakedWaitWeights());
    }
}

export const STRATEGY_V0_7: IAIStrategy = new StrategyV0_7();
