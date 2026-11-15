/** Offline candidate-metadata experiment. No serving policy imports this module. */
import type { IDecisionContext } from "../ai/ai_strategy";
import { estimatePrimaryMeleeDamage } from "../ai/melee_damage_estimate";
import type { GameAction } from "../engine/actions";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";

export const STATIONARY_MELEE_VALUE_RESEARCH_ID = "stationary-melee-value-v1";

const SECONDARY_DAMAGE = [
    "Double Punch",
    "Lightning Spin",
    "Fire Breath",
    "Skewer Strike",
    "Chain Lightning",
    "Devour Essence",
    "Petrifying Gaze",
    "Predatory Assimilation",
    "Borrowed Grace",
    "Gravechain",
] as const;

/**
 * Price only a supported stationary, unanswered primary hit. Moving changes morale, terrain and aura state;
 * a response can change shields, stats and the victim before impact. Those sequences retain their original
 * metadata and real-engine search. This is immediate damage, not whole-turn value: breaking a shield or
 * applying a status can still be useful when the direct HP estimate is zero.
 */
export function stationaryMeleeValue(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
): { effective: number; kill: 0 | 1 } | undefined {
    const base = unit.getBaseCell();
    if (
        context.decisionOrigin !== "root" ||
        !context.fightProperties ||
        unit.isDead() ||
        target.isDead() ||
        unit.getTeam() === target.getTeam() ||
        standCell.x !== base.x ||
        standCell.y !== base.y ||
        actions.some((action) => action.type === "move_unit") ||
        canUnitRespondToMelee(unit, target, context.fightProperties) ||
        target.canSelfResurrect() ||
        target.hasBuffActive("Flesh Shield Aura") ||
        target.hasAbilityActive("Fire Shield") ||
        unit.hasBuffActive("Fireforged Sword") ||
        unit.hasBuffActive("Last Fuse") ||
        SECONDARY_DAMAGE.some((name) => unit.hasAbilityActive(name))
    )
        return undefined;
    const strike = actions.filter((action) => action.type === "melee_attack");
    if (
        strike.length !== 1 ||
        strike[0].attackerId !== unit.getId() ||
        strike[0].targetId !== target.getId() ||
        strike[0].attackFrom.x !== standCell.x ||
        strike[0].attackFrom.y !== standCell.y ||
        strike[0].path?.length ||
        actions.some((action) => action.type !== "select_attack_type" && action.type !== "melee_attack")
    )
        return undefined;
    const projected = estimatePrimaryMeleeDamage(unit, target, context, standCell, actions);
    if (!projected) return undefined;
    if (target.willAbsorbIncomingHit(unit)) return { effective: 0, kill: 0 };

    // The resolver compares an integer in [0,100) with this chance, so a fractional chance rounds up.
    const miss = unit.calculateMissChance(
        target,
        context.fightProperties.getAdditionalAbilityPowerPerTeam(target.getTeam()),
    );
    if (!Number.isFinite(miss)) return undefined;
    const hitChance = 1 - Math.min(100, Math.max(0, Math.ceil(miss))) / 100;
    const hp = target.getCumulativeHp();
    return {
        effective:
            hitChance *
            projected.landedOutcomes.reduce(
                (sum, outcome) => sum + outcome.probability * Math.min(hp, Math.max(0, outcome.damage)),
                0,
            ),
        kill: hitChance === 1 && projected.landedOutcomes.every((outcome) => outcome.damage >= hp) ? 1 : 0,
    };
}
