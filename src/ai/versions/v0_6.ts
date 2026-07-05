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
import { StrategyV0_5 } from "./v0_5";

/**
 * v0.6 — the FULL-GAME AI generation. It starts as an exact clone of the shipped v0.5 fight champion
 * (same learned fight policy, placement and every inherited guard) so registering it can never regress
 * anything: with no v0.6-specific weights it is byte-for-byte v0.5. Its purpose is to become the version
 * that plays the WHOLE experience — pick/ban, augment + perk spend, synergy-aware drafting, army placement
 * and the fight — each phase a self-play-trained seam layered on top of this clone. DEFAULT_AI_VERSION stays
 * v0.5 until a v0.6 seam clears the guard bar, exactly as v0.4/v0.5 were tournament-tested before shipping.
 */
export class StrategyV0_6 extends StrategyV0_5 {
    public override readonly version: string = "v0.6";
}

export const STRATEGY_V0_6: IAIStrategy = new StrategyV0_6();
