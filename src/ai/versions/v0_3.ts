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
import { StrategyV0_2 } from "./v0_2";

/**
 * v0.3 — continues from v0.2. It inherits ALL of v0.2 (placement, ranged best-shot, out-of-ammo
 * handling, aura repositioning, spell-casting) and is the place to add the next round of improvements
 * (e.g. late-game aggression to cut armageddon stalls). With no overrides yet it behaves exactly like
 * v0.2, so a v0.2-vs-v0.3 tournament starts from parity and isolates each change as it's added.
 */
class StrategyV0_3 extends StrategyV0_2 {
    public override readonly version: string = "v0.3";
}

export const STRATEGY_V0_3: IAIStrategy = new StrategyV0_3();
