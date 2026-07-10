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
import { routeUniversalCasterWithPolicy, V07_CASTER_ROUTER_POLICY } from "./caster_router";
import { StrategyV0_6 } from "./v0_6";
import { applyWaitScorerWeights, v07BakedWaitWeights } from "./wait_scorer";

/**
 * v0.7 — the shipped v0.7 program on top of the full v0.6 chain:
 * - S1: the Q2 Gate-2 distilled act-vs-wait scorer is baked in;
 * - S3: only the measured Resurrection + Wind Flow caster salvage is baked in, without Resurrection
 *   pre-emption. Castling and Wild Regeneration remain experimental-only.
 *
 * Weight resolution (wait_scorer.ts v07BakedWaitWeights): committed defaults, still overridable via
 * V07_WAIT_WEIGHTS for experiments; an ALL-ZERO override disables only the baked scorer. v0.6/v0.6s
 * behavior is untouched: their environment-gated caster/scorer stages and every experiment knob keep
 * working exactly as before.
 */
export class StrategyV0_7 extends StrategyV0_6 {
    public override readonly version: string = "v0.7";
    /** S3: bake only the measured non-pre-empting Resurrection + Wind Flow salvage. */
    protected override routeCasterDecision(
        unit: Unit,
        context: IDecisionContext,
        decision: GameAction[],
    ): GameAction[] {
        return routeUniversalCasterWithPolicy(unit, context, decision, V07_CASTER_ROUTER_POLICY);
    }
    /** v0.6's final-stage seam: replace the env-gated experiment stage with the committed baked scorer. */
    protected override finalizeDecision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        return applyWaitScorerWeights(unit, context, decision, v07BakedWaitWeights());
    }
}

export const STRATEGY_V0_7: IAIStrategy = new StrategyV0_7();
