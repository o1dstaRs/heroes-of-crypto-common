import type { GameAction } from "../engine/actions";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import type { IEnumeratedCandidate } from "./candidates";
import { decisionFireWalls } from "./decision_fight_state";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

const COMPLEX_RIDERS = ["Fire Shield", "Devour Essence", "Petrifying Gaze", "Predatory Assimilation", "Borrowed Grace"];

/**
 * A bounded opportunity signal for choosing a melee stand, not a prediction of the whole exchange.
 * A supported counter must be able to kill the wielder. Count only additional, unshielded enemy bodies
 * touching the future corpse, and charge the wielder's entire remaining HP before reserving the trade.
 * Real-engine search still owns the primary hit, counter rolls, chain explosions, losses and terminal result.
 */
export function lastFuseCounterTradePotential(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
    fatalChanceByTarget?: Map<string, number>,
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
        // The primary hit precedes cleanup; its changing HP/shield is deliberately left to the rollout.
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
    if (additionalDamage <= hp) return 0;
    let fatalChance = fatalChanceByTarget?.get(target.getId());
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
        fatalChanceByTarget?.set(target.getId(), fatalChance);
    }
    return fatalChance * (additionalDamage - hp);
}

/** Keep the one marked stand in the horizon even when an immediate leaf dislikes the wounded unit's loss. */
export function reserveLastFuseShortlistCandidate(
    candidates: readonly IEnumeratedCandidate[],
    challengers: readonly IEnumeratedCandidate[],
): readonly IEnumeratedCandidate[] {
    const trade = candidates.find((candidate) => candidate.lastFuseCounterTradeReserved);
    return trade && !challengers.includes(trade) ? [...challengers, trade] : challengers;
}
