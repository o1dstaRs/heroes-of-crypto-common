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
import { StrategyV0_8 } from "./v0_8";

/** Measurement alias retained for replaying the frozen a13 source binding. */
export class StrategyV0_8S extends StrategyV0_8 {
    public override readonly version: string = "v0.8s";
}

export const STRATEGY_V0_8S: IAIStrategy = new StrategyV0_8S();
