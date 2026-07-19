/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { Unit } from "../../units/unit";
import type { IDecisionContext } from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";

const ARACHNA_QUEEN = "Arachna Queen";
const ENDLESS_QUIVER = "Endless Quiver";
const RANGE = PBTypes.AttackVals.RANGE;

const incumbentDealsDamage = (actions: readonly GameAction[]): boolean =>
    actions.some(
        (action) =>
            action.type === "melee_attack" ||
            action.type === "range_attack" ||
            action.type === "area_throw_attack" ||
            action.type === "obstacle_attack",
    );

const bestShot = (candidates: readonly IEnumeratedCandidate[]): IEnumeratedCandidate | undefined => {
    let best: IEnumeratedCandidate | undefined;
    for (const candidate of candidates) {
        if (candidate.kind === "shot" && (!best || candidate.features.expectedDamage > best.features.expectedDamage)) {
            best = candidate;
        }
    }
    return best;
};

/**
 * Predatory Assimilation can give the natively-melee Queen capabilities the frozen AI classifies from
 * `attack_type` only. Bridge that narrow runtime gap with the shared engine-legal candidate generator:
 *
 * - a remaining stolen spell may replace an otherwise non-damaging move/wait/defend turn;
 * - a stolen Endless Quiver may select RANGE and fire the highest-damage legal shot.
 *
 * Native creatures and a Queen without either runtime capability return the exact incumbent array.
 */
export function routeArachnaQueenAssimilation(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
): GameAction[] {
    if (unit.getName() !== ARACHNA_QUEEN) {
        return incumbent;
    }

    const hasRemainingSpell = unit.getSpells().some((spell) => spell.isRemaining());
    const hasStolenRange =
        unit.getAttackType() !== RANGE &&
        unit.hasAbilityActive(ENDLESS_QUIVER) &&
        unit.isRangeCapable() &&
        unit.getPossibleAttackTypes().includes(RANGE);
    if (!hasRemainingSpell && !hasStolenRange) {
        return incumbent;
    }

    const candidates = enumerateCandidates(unit, context, incumbent).candidates;
    const incumbentCasts = incumbent.some((action) => action.type === "cast_spell");
    if (hasRemainingSpell && !incumbentCasts && !incumbentDealsDamage(incumbent)) {
        const spell = candidates.find((candidate) => candidate.kind === "spell");
        if (spell) {
            return spell.actions;
        }
    }

    if (hasStolenRange && !incumbentCasts) {
        return bestShot(candidates)?.actions ?? incumbent;
    }

    return incumbent;
}
