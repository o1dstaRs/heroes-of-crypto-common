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

import { FightStateManager } from "../fights/fight_state_manager";
import type { FireWalls } from "../spells/fire_walls";
import type { IDecisionContext } from "./ai_strategy";

/**
 * Authoritative Fire Wall store for a decision.
 *
 * Modern callers pass their session FightProperties explicitly. Legacy embeddings may omit that optional
 * context field while still binding the same state through FightStateManager, so fail over to the bound store
 * instead of silently projecting a wall-free board.
 */
export function decisionFireWalls(context: IDecisionContext): FireWalls {
    return (
        context.fightProperties?.getFireWalls() ?? FightStateManager.getInstance().getFightProperties().getFireWalls()
    );
}
