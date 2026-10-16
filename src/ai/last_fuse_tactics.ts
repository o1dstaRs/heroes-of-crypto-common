import type { GameAction } from "../engine/actions";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import type { IEnumeratedCandidate } from "./candidates";
import { decisionFireWalls } from "./decision_fight_state";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

const COMPLEX_RIDERS = ["Fire Shield", "Devour Essence", "Petrifying Gaze", "Predatory Assimilation", "Borrowed Grace"];

export interface ILastFuseCounterTradeOptions {
    includePrimaryTarget?: boolean;
    fatalChanceByTarget?: Map<string, number>;
    primaryBlastByTarget?: Map<string, number>;
}

function minimumPrimaryBlastDamage(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
    cache?: Map<string, number>,
): number {
    if (target.canSelfResurrect() || unit.getAbility("Crafted Double Punch")) return 0;
    const cacheable =
        !unit.getAbility("Rapid Charge") && !unit.getAbility("Backstab") && !unit.getAuraEffect("War Anger");
    const cached = cacheable ? cache?.get(target.getId()) : undefined;
    if (cached !== undefined) return cached;
    const primary = estimatePrimaryMeleeDamage(unit, target, context, standCell, actions);
    let damage = 0;
    if (primary) {
        const blast = unit.getLastFuseDamage();
        const hp = target.getCumulativeHp();
        if (target.willWaterShieldAbsorb()) {
            // Only a certain positive, shield-absorbed opening guarantees the blast sees an unshielded body.
            // A fire hit bypasses Water Shield without spending it; a zero-damage hit does not spend it either.
            if (
                target.willWaterShieldAbsorb(unit) &&
                primary.hitChance === 1 &&
                primary.landedOutcomes.every((outcome) => outcome.damage > 0)
            )
                damage = Math.min(blast, hp);
        } else {
            const maximumOpening =
                primary.hitChance > 0
                    ? primary.landedOutcomes.reduce((maximum, outcome) => Math.max(maximum, outcome.damage), 0)
                    : 0;
            // Damage already dealt by the opening cannot be bought again by the explosion.
            damage = Math.min(blast, Math.max(0, hp - maximumOpening));
        }
    }
    if (cacheable) cache?.set(target.getId(), damage);
    return damage;
}

/**
 * A bounded opportunity signal for choosing a melee stand, not a prediction of the whole exchange.
 * A supported counter must be able to kill the wielder. Count additional, unshielded enemy bodies touching
 * the future corpse, and charge the wielder's entire remaining HP. The primary fallback counts only HP that
 * remains after every supported opening roll, with a guaranteed shield spend when required.
 * Real-engine search still owns the primary hit, counter rolls, chain explosions, losses and terminal result.
 */
export function lastFuseCounterTradePotential(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
    options: ILastFuseCounterTradeOptions = {},
): number {
    if (!unit.hasBuffActive("Last Fuse") || unit.isDead() || unit.canSelfResurrect()) return 0;
    if (
        ["Lightning Spin", "Fire Breath", "Skewer Strike", "Chain Lightning"].some((name) =>
            unit.hasAbilityActive(name),
        )
    )
        return 0;
    if (!canUnitRespondToMelee(unit, target, context.fightProperties) || unit.willWaterShieldAbsorb(target)) return 0;
    if (
        unit.hasBuffActive("Flesh Shield Aura") ||
        target.hasBuffActive("Flesh Shield Aura") ||
        unit.hasBuffActive("Fireforged Sword") ||
        target.hasBuffActive("Fireforged Sword") ||
        target.hasAbilityActive("Rapid Charge") ||
        COMPLEX_RIDERS.some((name) => unit.hasAbilityActive(name) || target.hasAbilityActive(name))
    )
        return 0;
    const move = actions.find((action) => action.type === "move_unit");
    if (
        move?.type === "move_unit" &&
        (move.hasLavaCell ||
            move.hasWaterCell ||
            target.hasAbilityActive("Backstab") ||
            decisionFireWalls(context).size() > 0 ||
            [...context.unitsHolder.getAllUnits().values()].some((other) => other.getAuraEffects().length > 0))
    )
        return 0;
    const hp = unit.getCumulativeHp();
    const cells = unit.getFootprintCellsForAnchor(standCell);
    const blast = unit.getLastFuseDamage();
    let additionalDamage = 0;
    for (const enemy of context.unitsHolder.getAllEnemyUnits(unit.getTeam())) {
        // The primary hit precedes cleanup; the opt-in fallback projects it separately below.
        if (
            enemy.getId() === target.getId() ||
            enemy.isDead() ||
            enemy.willWaterShieldAbsorb() ||
            enemy.canSelfResurrect()
        )
            continue;
        if (enemy.getCells().some((a) => cells.some((b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1))) {
            additionalDamage += Math.min(blast, enemy.getCumulativeHp());
        }
    }
    if (
        additionalDamage <= hp &&
        (!options.includePrimaryTarget || additionalDamage + Math.min(blast, target.getCumulativeHp()) <= hp)
    )
        return 0;
    let fatalChance = options.fatalChanceByTarget?.get(target.getId());
    if (fatalChance === undefined) {
        const response = estimatePrimaryMeleeDamage(target, unit, context, target.getBaseCell(), [
            {
                type: "melee_attack",
                attackerId: target.getId(),
                targetId: unit.getId(),
                attackFrom: target.getBaseCell(),
            },
        ]);
        fatalChance = response
            ? response.hitChance *
              response.landedOutcomes.reduce(
                  (sum, outcome) => sum + (outcome.damage >= hp ? outcome.probability : 0),
                  0,
              )
            : 0;
        options.fatalChanceByTarget?.set(target.getId(), fatalChance);
    }
    if (fatalChance <= 0) return 0;
    if (options.includePrimaryTarget) {
        additionalDamage += minimumPrimaryBlastDamage(
            unit,
            target,
            context,
            standCell,
            actions,
            options.primaryBlastByTarget,
        );
    }
    return fatalChance * Math.max(0, additionalDamage - hp);
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
