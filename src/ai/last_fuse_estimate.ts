import { getDoubleShotAbility } from "../abilities/ability_helper";
import { applyAttackDamageChain, resolveAttackDamageChain } from "../damage/damage_projection";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import { decisionFireWalls } from "./decision_fight_state";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

export interface ILastFuseDamageEstimate {
    expectedNetDamage: number;
    expectedFriendlyDamage: number;
    fatalChance: number;
    secureKill: boolean;
}

export type ILastFuseMeleeEstimate = ILastFuseDamageEstimate;

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
        (actions.some((action) => action.type === "move_unit") && target.hasAbilityActive("Backstab")) ||
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
): ILastFuseDamageEstimate | undefined {
    if (!target.hasBuffActive("Last Fuse")) return undefined;
    if (
        target.hasBuffActive("Flesh Shield Aura") ||
        target.hasAbilityActive("Fire Shield") ||
        unit.hasBuffActive("Fireforged Sword") ||
        SECONDARY_RIDERS.some((name) => unit.hasAbilityActive(name)) ||
        (actions.some((action) => action.type === "move_unit") &&
            (decisionFireWalls(context).size() > 0 ||
                [...context.unitsHolder.getAllUnits().values()].some((other) => other.getAuraEffects().length > 0)))
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

/**
 * A stationary, ordinary shot with one possible impact. Native/Echo volleys are supported only when the
 * first hit certainly destroys the only stack on the ray, or a certain hit spends the last ammunition.
 * Otherwise later hits can change the fatal-hit basis, stack power, auras and shield state; leave that
 * sequence to engine search rather than substituting the stack's original HP for its final blow.
 */
export function estimateLastFuseRangedDamage(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    divisor: number,
): ILastFuseDamageEstimate | undefined {
    const fight = context.fightProperties;
    if (!fight || target.isDead() || !target.hasBuffActive("Last Fuse") || unit.getRangeShots() <= 0) return undefined;
    if (
        target.hasBuffActive("Flesh Shield Aura") ||
        unit.hasBuffActive("Fireforged Sword") ||
        [...SECONDARY_RIDERS, "Through Shot", "Area Throw", "Large Caliber", "Chakram", "Absolving Arrow"].some(
            (name) => unit.hasAbilityActive(name),
        )
    )
        return undefined;
    // A possible counter can change the shooter's health, shield, stats or ability to finish the shot.
    // This conservative gate intentionally does not try to reconstruct its response trajectory.
    if (
        target.isRangeCapable() &&
        target.getRangeShots() > 0 &&
        !unit.canSkipResponse() &&
        !fight.hasAlreadyRepliedAttack(target.getId()) &&
        target.canRespond(PBTypes.AttackVals.RANGE)
    )
        return undefined;
    const resurrects = target.canSelfResurrect();
    if (resurrects && fight.getBreakChancePerTeam(unit.getTeam()) > 0) return undefined;

    const abilityPower = fight.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const chain = resolveAttackDamageChain({
        attacker: unit,
        target,
        attackType: PBTypes.AttackVals.RANGE,
        synergyAbilityPowerIncrease: abilityPower,
        divisor,
        abilityMultiplier: (100 - (unit.getEffect("Paralysis")?.getPower() ?? 0)) / 100,
    });
    if (
        !Number.isSafeInteger(chain.rollMin) ||
        !Number.isSafeInteger(chain.rollMaxExclusive) ||
        chain.rollMaxExclusive < chain.rollMin
    )
        return undefined;
    const rollCount = Math.max(1, chain.rollMaxExclusive - chain.rollMin);
    if (!Number.isSafeInteger(rollCount) || rollCount > 10_000) return undefined;
    const lucky = unit.getAbility("Lucky Strike");
    // The resolver compares an integer [0, 100) roll with the chance, so 8.8% procs on nine outcomes.
    const luckyChance = lucky
        ? Math.min(100, Math.max(0, Math.ceil(unit.calculateAbilityApplyChance(lucky, abilityPower)))) / 100
        : 0;
    const luckyMultiplier = lucky ? unit.calculateAbilityMultiplier(lucky, abilityPower) : 1;
    const hitChance =
        1 -
        Math.min(
            100,
            Math.max(0, unit.calculateMissChance(target, fight.getAdditionalAbilityPowerPerTeam(target.getTeam()))),
        ) /
            100;
    const hp = target.getCumulativeHp();
    let conditionalDamage = 0;
    let conditionalFatalChance = 0;
    let minimum = Number.POSITIVE_INFINITY;
    for (let raw = chain.rollMin; raw < chain.rollMin + rollCount; raw++) {
        const ordinary = applyAttackDamageChain(chain, raw);
        for (const [damage, probability] of [
            [ordinary, (1 - luckyChance) / rollCount],
            [Math.floor(ordinary * luckyMultiplier), luckyChance / rollCount],
        ]) {
            if (probability <= 0) continue;
            minimum = Math.min(minimum, damage);
            conditionalDamage += probability * Math.min(hp, Math.max(0, damage));
            if (damage >= hp) conditionalFatalChance += probability;
        }
    }
    const absorbed = target.willWaterShieldAbsorb(unit);
    const firstKills = hitChance === 1 && minimum >= hp && !absorbed;
    const mayFollow = !!getDoubleShotAbility(unit) || unit.getBonusRangedAttackChance() > 0;
    if (mayFollow && !firstKills && !(hitChance === 1 && unit.projectRangeShotsAfterVolleys(target) <= 0))
        return undefined;

    const fatalChance = resurrects || absorbed ? 0 : hitChance * conditionalFatalChance;
    let friendlyDamage = 0;
    if (fatalChance > 0) {
        const blast = target.getLastFuseDamage();
        for (const ally of context.unitsHolder.getAllAllies(unit.getTeam())) {
            if (ally.isDead() || ally.willWaterShieldAbsorb() || !touches(target.getCells(), ally.getCells())) continue;
            if (blast >= ally.getCumulativeHp() && ally.hasBuffActive("Last Fuse") && !ally.canSelfResurrect())
                return undefined;
            friendlyDamage += Math.min(blast, ally.getCumulativeHp());
        }
    }
    const expectedFriendlyDamage = fatalChance * friendlyDamage;
    return {
        expectedNetDamage: (absorbed ? 0 : hitChance * conditionalDamage) - expectedFriendlyDamage,
        expectedFriendlyDamage,
        fatalChance,
        secureKill: firstKills && !resurrects,
    };
}
