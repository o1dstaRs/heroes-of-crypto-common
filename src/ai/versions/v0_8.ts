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
import { StrategyV0_7 } from "./v0_7";

/**
 * v0.8 candidate scaffold. It intentionally inherits v0.7 without behavioral overrides so every new training
 * cycle starts from the shipped policy under committed defaults, while retaining a distinct tournament id.
 */
export class StrategyV0_8 extends StrategyV0_7 {
    public override readonly version: string = "v0.8";
}

export const STRATEGY_V0_8: IAIStrategy = new StrategyV0_8();
