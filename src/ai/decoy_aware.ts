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
import type { IDecisionContext } from "./ai_strategy";
import { assertNoLegacySeatEnv, seatEnvName } from "./seat_env";

export const A19_DECOY_AWARE_ID = "a19-decoy-aware-v1";
/** Per-seat switch (seat_env): on unless `A19_DECOY_AWARE_<LEFT|RIGHT>=0`. */
export const A19_DECOY_AWARE_ENV = "A19_DECOY_AWARE";

export function a19DecoyAwareEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_DECOY_AWARE_ENV);
    return process.env[seatEnvName(A19_DECOY_AWARE_ENV, team)] !== "0";
}

/**
 * A one-model decoy: a one-creature stack whose creature also has a bigger living stack in its army (a split child).
 * The owner's checkerboard wall of single Fairies beat the brutal AI (game 9a1003ec); striking such a decoy while a real
 * stack is strikable wastes the strike. See docs/decoy_aware_adoption.md.
 */
export function isOneModelDecoy(context: IDecisionContext, targetId: string | undefined): boolean {
    const units = context.unitsHolder.getAllUnits();
    const target = targetId ? units.get(targetId) : undefined;
    if (!target || target.isDead() || target.getAmountAlive() > 1) {
        return false;
    }
    for (const other of units.values()) {
        if (
            other.getId() !== target.getId() &&
            !other.isDead() &&
            other.getTeam() === target.getTeam() &&
            other.getName() === target.getName() &&
            other.getAmountAlive() > 1
        ) {
            return true;
        }
    }
    return false;
}

export function meleeTargetOf(actions: readonly GameAction[]): string | undefined {
    const strike = actions.find((action) => action.type === "melee_attack") as { targetId?: string } | undefined;
    return strike?.targetId;
}

export function strikesOneModelDecoy(context: IDecisionContext, actions: readonly GameAction[]): boolean {
    return isOneModelDecoy(context, meleeTargetOf(actions));
}

export function strikesRealStack(context: IDecisionContext, actions: readonly GameAction[]): boolean {
    const target = meleeTargetOf(actions);
    return target !== undefined && !isOneModelDecoy(context, target);
}

/** The real-stack strike that hits the most cumulative HP, or undefined. */
export function bestRealStackStrike(
    context: IDecisionContext,
    candidates: readonly { actions: GameAction[] }[],
): GameAction[] | undefined {
    const units = context.unitsHolder.getAllUnits();
    let best: GameAction[] | undefined;
    let bestValue = -Infinity;
    for (const candidate of candidates) {
        if (!strikesRealStack(context, candidate.actions)) {
            continue;
        }
        const target = units.get(meleeTargetOf(candidate.actions)!);
        const value = target ? target.getCumulativeHp() : 0;
        if (value > bestValue) {
            best = candidate.actions;
            bestValue = value;
        }
    }
    return best;
}
