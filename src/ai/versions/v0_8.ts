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
import { enumerateCandidates, type CandidateKind, type IEnumeratedCandidate } from "../candidates";
import { StrategyV0_7 } from "./v0_7";
import { isV08DirectCombatDecision, v08DominantFinishState } from "./v0_8_dominant_finish";

const V08_DIRECT_COMBAT_KINDS = new Set<CandidateKind>(["melee", "shot", "area_throw"]);

/**
 * Replace a terminal policy no-op with an explicit engine-valid action. Search still owns the stronger priority:
 * whenever v0.8 has a legal attack, spell, or move, that productive candidate overrides this last-resort defend.
 */
export function ensureExplicitV08Action(unitId: string, decision: GameAction[]): GameAction[] {
    const hasMeaningfulAction = decision.some(
        (action) => action.type !== "select_attack_type" && action.type !== "end_turn",
    );
    return hasMeaningfulAction ? decision : [{ type: "defend_turn", unitId }];
}

/** Prefer immediate enemy damage, then the enumerator's nearest-to-enemy legal move. */
export function selectV08ProductiveCandidate(
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    return selectV08DirectCombatCandidate(candidates) ?? candidates.find((candidate) => candidate.kind === "move");
}

/** Direct enemy damage is the only action class that satisfies the late dominant-finish invariant. */
export function selectV08DirectCombatCandidate(
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    let best: IEnumeratedCandidate | undefined;
    for (const candidate of candidates) {
        if (!V08_DIRECT_COMBAT_KINDS.has(candidate.kind) || !isV08DirectCombatDecision(candidate.actions)) continue;
        if (!Number.isFinite(candidate.features.expectedDamage) || candidate.features.expectedDamage <= 0) continue;
        const candidateMoves = candidate.actions.some((action) => action.type === "move_unit");
        const bestMoves = best?.actions.some((action) => action.type === "move_unit") ?? false;
        if (
            !best ||
            candidate.features.expectedDamage > best.features.expectedDamage ||
            (candidate.features.expectedDamage === best.features.expectedDamage &&
                (candidate.features.expectedKill > best.features.expectedKill ||
                    (candidate.features.expectedKill === best.features.expectedKill && bestMoves && !candidateMoves)))
        ) {
            best = candidate;
        }
    }
    return best;
}

function enumerateV08BoundaryCandidates(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): readonly IEnumeratedCandidate[] {
    return enumerateCandidates(unit, context, decision, {
        // Bound the direct-policy repair to the same practical candidate census used by live search.
        maxMoveDestinations: 1,
        maxMeleePairs: 8,
        maxShotAims: 6,
        maxAreaThrowCells: 4,
    }).candidates;
}

/**
 * Keep direct v0.8 from spending a turn on a mountain when an immediately damaging enemy attack exists. Strategic
 * wait/Luck Shield choices require comparative search to judge safely, so SearchDriver owns those replacements.
 */
export function prioritizeV08ProductiveAction(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    // A mountain decision may be encoded as move-then-obstacle-attack. The setup move does not make the
    // consumed obstacle turn productive, so either encoding must trigger the replacement census.
    if (!decision.some((action) => action.type === "obstacle_attack")) {
        return decision;
    }

    // Without a rollout, an arbitrary advance/support cast is not proven better than opening a lane. Restrict
    // the direct-policy override to an immediately damaging enemy attack; SearchDriver can compare everything.
    const replacement = selectV08DirectCombatCandidate(enumerateV08BoundaryCandidates(unit, context, decision));
    return replacement?.actions ?? decision;
}

/**
 * In the conservative late two-to-one-HP window, deal enemy damage now whenever the enumerator-legal census
 * exposes it. Outside that window, or when no direct attack exists, retain the conservative direct policy.
 */
export function prioritizeV08Decision(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
    const dominantFinish = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        context.fightProperties?.getCurrentLap() ?? 0,
    ).active;
    if (dominantFinish && !isV08DirectCombatDecision(decision)) {
        const candidates = enumerateV08BoundaryCandidates(unit, context, decision);
        const directCombat = selectV08DirectCombatCandidate(candidates);
        if (directCombat) {
            return directCombat.actions;
        }
    }

    return prioritizeV08ProductiveAction(unit, context, decision);
}

/** v0.8 starts from v0.7, repairs mountain turns directly, and leaves comparative passive choices to search. */
export class StrategyV0_8 extends StrategyV0_7 {
    public override readonly version: string = "v0.8";
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const explicit = ensureExplicitV08Action(unit.getId(), super.decideTurn(unit, context));
        return prioritizeV08Decision(unit, context, explicit);
    }
}

export const STRATEGY_V0_8: IAIStrategy = new StrategyV0_8();
