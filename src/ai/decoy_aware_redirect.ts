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
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import type { IDecisionContext } from "./ai_strategy";
import { enumerateCandidates } from "./candidates";
import { a19DecoyAwareEnabled, bestRealStackStrike, strikesOneModelDecoy } from "./decoy_aware";

/**
 * a19-decoy-aware-v1 root redirect: a native decision that strikes a one-model decoy becomes the real-stack strike that
 * hits the most cumulative HP, when one exists. Enumeration runs inside a private random stream, so a decision that keeps
 * its incumbent is unchanged. The server applies it at the start of a bot seat's search.
 */
export function decoyAwareIncumbent(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
): GameAction[] | undefined {
    if (!a19DecoyAwareEnabled(unit.getTeam()) || !strikesOneModelDecoy(context, incumbent)) {
        return undefined;
    }
    const saved = captureDeterministicRandomState();
    try {
        return bestRealStackStrike(context, enumerateCandidates(unit, context, incumbent).candidates.slice(1));
    } finally {
        restoreDeterministicRandomState(saved);
    }
}
