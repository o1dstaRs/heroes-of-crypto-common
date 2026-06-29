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

import type { IAIStrategy } from "../ai_strategy";
import { StrategyV0_3 } from "./v0_3";

/**
 * v0.4 — the active optimization target.
 *
 * Starts as an EXACT copy of v0.3 (the current champion and `DEFAULT_AI_VERSION`): it overrides nothing,
 * so it inherits every v0.3 behaviour (cornered-ranged + flyer-wing placement, army cohesion, ranged
 * focus-fire, boxed-shooter retreat, creature openers, …) unchanged. A fresh optimizer loop therefore
 * measures v0.4 ≈ v0.3 ≈ 50% until the first accepted change.
 *
 * Optimise THIS class — add overrides / guarded branches here. Never edit v0.3 during a run: it is the
 * frozen benchmark the loop measures against (just as v0.2 was for the v0.3 run). See
 * `src/simulation/optimizer/PROTOCOL.md` for the methodology and the lessons from the v0.3 run.
 */
export class StrategyV0_4 extends StrategyV0_3 {
    public override readonly version: string = "v0.4";
}

export const STRATEGY_V0_4: IAIStrategy = new StrategyV0_4();
