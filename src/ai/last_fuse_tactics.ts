import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import type { IEnumeratedCandidate } from "./candidates";
import { estimateLastFuseMeleeDamage } from "./last_fuse_estimate";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

export interface ILastFuseCounterTradeOptions {
    includePrimaryTarget?: boolean;
    fatalChanceByTarget?: Map<string, number>;
    primaryBlastByTarget?: Map<string, number>;
}

export function lastFuseCounterTradePotential(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
    _options: ILastFuseCounterTradeOptions = {},
): number {
    const blast = estimateLastFuseMeleeDamage(unit, target, context, standCell, actions);
    if (!blast || blast.fatalChance <= 0) return 0;
    const primary = estimatePrimaryMeleeDamage(unit, target, context, standCell, actions);
    return primary ? Math.max(0, blast.expectedNetDamage - primary.expectedEffectiveDamage) : 0;
}

/** Keep the one marked stand in the horizon even when an immediate leaf dislikes the wounded unit's loss. */
export function reserveLastFuseShortlistCandidate(
    candidates: readonly IEnumeratedCandidate[],
    challengers: readonly IEnumeratedCandidate[],
): readonly IEnumeratedCandidate[] {
    const trade = candidates.find((candidate) => candidate.lastFuseCounterTradeReserved);
    return trade && !challengers.includes(trade) ? [...challengers, trade] : challengers;
}

/** A reserved blast may cross an activity tier only after a strictly better complete engine comparison. */
export function includeImprovingLastFuseTrade(
    candidates: readonly IEnumeratedCandidate[],
    means: readonly number[],
    selection: readonly number[],
): readonly number[] {
    const index = candidates.findIndex((candidate) => candidate.lastFuseCounterTradeReserved);
    if (index <= 0 || selection.includes(index) || !Number.isFinite(means[index])) return selection;
    const baseline = Math.max(means[0], ...selection.map((other) => means[other]));
    return means[index] > baseline ? [...selection, index] : selection;
}
