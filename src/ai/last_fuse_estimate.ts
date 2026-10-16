import type { GameAction } from "../engine/actions";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import { decisionFireWalls } from "./decision_fight_state";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

export interface ILastFuseMeleeEstimate {
    expectedNetDamage: number;
    expectedFriendlyDamage: number;
    fatalChance: number;
    secureKill: boolean;
}

const touches = (left: readonly XY[], right: readonly XY[]): boolean =>
    left.some((a) => right.some((b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1));

const SECONDARY_RIDERS = ["Devour Essence", "Petrifying Gaze", "Predatory Assimilation", "Borrowed Grace"];

function actorBlastDamage(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    actions: readonly GameAction[],
    blast: number,
): { expected: number; minimumHp: number; mayBeUnshielded: boolean } | undefined {
    const hp = unit.getCumulativeHp();
    const shield = unit.willWaterShieldAbsorb();
    const ordinary = { expected: shield ? 0 : Math.min(blast, hp), minimumHp: hp, mayBeUnshielded: !shield };
    if (!canUnitRespondToMelee(unit, target, context.fightProperties)) return ordinary;
    if (
        (actions.some((action) => action.type === "move_unit") &&
            (target.hasAbilityActive("Backstab") ||
                [...context.unitsHolder.getAllUnits().values()].some((other) => other.getAuraEffects().length > 0))) ||
        target.hasAbilityActive("Rapid Charge") ||
        unit.hasBuffActive("Flesh Shield Aura") ||
        target.hasBuffActive("Fireforged Sword") ||
        SECONDARY_RIDERS.some((name) => target.hasAbilityActive(name)) ||
        (context.fightProperties?.getBreakChancePerTeam(target.getTeam()) ?? 0) > 0
    )
        return undefined;
    const response = estimatePrimaryMeleeDamage(target, unit, context, target.getBaseCell(), [
        {
            type: "melee_attack",
            attackerId: target.getId(),
            targetId: unit.getId(),
            attackFrom: target.getBaseCell(),
        },
    ]);
    if (!response) return undefined;
    if (response.hitChance <= 0) return ordinary;
    // The ordinary counter lands before the fatal strike is applied. It may spend Water Shield or
    // leave fewer HP for the blast; a fire counter bypasses the shield without spending it.
    if (unit.willWaterShieldAbsorb(target)) {
        const positive = response.landedOutcomes.reduce(
            (sum, outcome) => sum + (outcome.damage > 0 ? outcome.probability : 0),
            0,
        );
        return {
            expected: response.hitChance * positive * Math.min(blast, hp),
            minimumHp: hp,
            mayBeUnshielded: positive > 0,
        };
    }
    const minimumHp = hp - Math.max(...response.landedOutcomes.map((outcome) => Math.max(0, outcome.damage)));
    if (minimumHp <= 0) return undefined;
    const expected = shield
        ? 0
        : (1 - response.hitChance) * Math.min(blast, hp) +
          response.hitChance *
              response.landedOutcomes.reduce(
                  (sum, outcome) => sum + outcome.probability * Math.min(blast, hp - Math.max(0, outcome.damage)),
                  0,
              );
    return { expected, minimumHp, mayBeUnshielded: !shield };
}

/**
 * Price a supported direct melee hit and the enemy corpse's blast in the same HP units. The strike must
 * actually destroy the stack: a miss, nonfatal roll, absorbed hit or native resurrection buys no explosion.
 * Redirection, secondary damage, hazardous movement and chained deaths stay with the real engine search.
 * No live HP, shields, positions or combat randomness are changed by this projection.
 */
export function estimateLastFuseMeleeDamage(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
): ILastFuseMeleeEstimate | undefined {
    if (!target.hasBuffActive("Last Fuse")) return undefined;
    if (
        target.hasBuffActive("Flesh Shield Aura") ||
        target.hasAbilityActive("Fire Shield") ||
        unit.hasBuffActive("Fireforged Sword") ||
        SECONDARY_RIDERS.some((name) => unit.hasAbilityActive(name)) ||
        (actions.some((action) => action.type === "move_unit") && decisionFireWalls(context).size() > 0)
    )
        return undefined;
    const resurrects = target.canSelfResurrect();
    if (resurrects && (context.fightProperties?.getBreakChancePerTeam(unit.getTeam()) ?? 0) > 0) return undefined;
    const damage = estimatePrimaryMeleeDamage(unit, target, context, standCell, actions);
    if (!damage) return undefined;
    if (target.willWaterShieldAbsorb(unit)) {
        return { expectedNetDamage: 0, expectedFriendlyDamage: 0, fatalChance: 0, secureKill: false };
    }
    const fatalChance = resurrects
        ? 0
        : damage.hitChance *
          damage.landedOutcomes.reduce(
              (sum, outcome) => sum + (outcome.damage >= target.getCumulativeHp() ? outcome.probability : 0),
              0,
          );
    let friendlyDamage = 0;
    if (fatalChance > 0) {
        const blastDamage = target.getLastFuseDamage();
        const actorBlast = actorBlastDamage(unit, target, context, actions, blastDamage);
        if (!actorBlast) return undefined;
        const corpseCells = target.getCells();
        for (const ally of context.unitsHolder.getAllAllies(unit.getTeam())) {
            const actor = ally.getId() === unit.getId();
            if (ally.isDead() || (!actor && ally.willWaterShieldAbsorb())) continue;
            const cells = actor ? ally.getFootprintCellsForAnchor(standCell) : ally.getCells();
            if (!touches(corpseCells, cells)) continue;
            if (
                (actor
                    ? actorBlast.mayBeUnshielded && blastDamage >= actorBlast.minimumHp
                    : blastDamage >= ally.getCumulativeHp()) &&
                ally.hasBuffActive("Last Fuse") &&
                !ally.canSelfResurrect()
            ) {
                return undefined;
            }
            friendlyDamage += actor ? actorBlast.expected : Math.min(blastDamage, ally.getCumulativeHp());
        }
    }
    const expectedFriendlyDamage = fatalChance * friendlyDamage;
    return {
        expectedNetDamage: damage.expectedEffectiveDamage - expectedFriendlyDamage,
        expectedFriendlyDamage,
        fatalChance,
        secureKill: damage.secureKill && !resurrects,
    };
}
