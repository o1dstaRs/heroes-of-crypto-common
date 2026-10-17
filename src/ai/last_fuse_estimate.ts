import { getDoubleShotAbility } from "../abilities/ability_helper";
import { lastFuseDamage } from "../abilities/last_fuse_ability";
import { applyAttackDamageChain, resolveAttackDamageChain } from "../damage/damage_projection";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Spell } from "../spells/spell";
import { projectSpellDamageAgainstUnit } from "../spells/spell_cast_projection";
import { mirroredDamageShare } from "../spells/spell_helper";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";
import { decisionFireWalls } from "./decision_fight_state";
import { estimatePrimaryMeleeDamage } from "./melee_damage_estimate";

export interface ILastFuseDamageEstimate {
    expectedNetDamage: number;
    expectedPrimaryDamage?: number;
    expectedFriendlyDamage: number;
    fatalChance: number;
    secureKill: boolean;
}

export type ILastFuseMeleeEstimate = ILastFuseDamageEstimate;

const touches = (left: readonly XY[], right: readonly XY[]): boolean =>
    left.some((a) => right.some((b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1));

function enemyBlastDamage(
    unit: Unit,
    target: Unit,
    context: Pick<IDecisionContext, "unitsHolder">,
): number | undefined {
    const enemies = context.unitsHolder
        .getAllEnemyUnits(unit.getTeam())
        .filter((enemy) => enemy.getId() !== target.getId() && !enemy.isDead())
        .map((enemy) => ({
            cells: enemy.getCells(),
            hp: enemy.getCumulativeHp(),
            shielded: enemy.willWaterShieldAbsorb(),
            resurrects: enemy.canSelfResurrect(),
        }));
    const power = unit.getStackPower();
    const percent = unit.getBuffPower("Last Fuse");
    let damage = 0;
    const detonate = (cells: readonly XY[], fatalDamage: number): boolean => {
        const blast = lastFuseDamage(fatalDamage, power, percent);
        const destroyed: Array<{ cells: readonly XY[]; fatalDamage: number }> = [];
        for (const enemy of enemies) {
            if (enemy.hp <= 0 || !touches(cells, enemy.cells)) continue;
            if (enemy.shielded) {
                enemy.shielded = false;
                continue;
            }
            const dealt = Math.min(blast, enemy.hp);
            enemy.hp -= dealt;
            damage += dealt;
            if (enemy.hp <= 0) {
                if (enemy.resurrects) return false;
                destroyed.push({ cells: enemy.cells, fatalDamage: dealt });
            }
        }
        return destroyed.every((enemy) => detonate(enemy.cells, enemy.fatalDamage));
    };
    return detonate(target.getCells(), target.getCumulativeHp()) ? damage : undefined;
}

const SECONDARY_RIDERS = ["Devour Essence", "Petrifying Gaze", "Predatory Assimilation", "Borrowed Grace"];

/**
 * Price one direct spell execution and the enemy corpse's blast. The caster must hold Last Fuse: the
 * victim's own buff does not explode, and allies beside the corpse are not damaged. A reflected cast, an
 * area impact, or a blast that would resurrect another enemy stays with engine search.
 */
export function estimateLastFuseSpellDamage(
    unit: Unit,
    target: Unit,
    spell: Spell,
    context: Pick<IDecisionContext, "unitsHolder">,
): ILastFuseDamageEstimate | undefined {
    if (
        target.isDead() ||
        target.getTeam() === unit.getTeam() ||
        !unit.hasBuffActive("Last Fuse") ||
        mirroredDamageShare(target) > 0
    )
        return undefined;
    const projected = projectSpellDamageAgainstUnit({ spell, caster: unit, target });
    if (projected.absorbedByWaterShield) {
        return { expectedNetDamage: 0, expectedFriendlyDamage: 0, fatalChance: 0, secureKill: false };
    }
    const applied = Math.min(projected.damage, target.getCumulativeHp());
    const fatal = projected.damage >= target.getCumulativeHp() && !target.canSelfResurrect();
    const splash = fatal ? enemyBlastDamage(unit, target, context) : 0;
    if (splash === undefined) return undefined;
    return {
        expectedNetDamage: applied + splash,
        expectedFriendlyDamage: 0,
        fatalChance: Number(fatal),
        secureKill: fatal,
    };
}

function canProjectMeleeResponse(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    actions: readonly GameAction[],
): boolean {
    if (!canUnitRespondToMelee(unit, target, context.fightProperties)) return true;
    if (
        (actions.some((action) => action.type === "move_unit") && target.hasAbilityActive("Backstab")) ||
        target.hasAbilityActive("Rapid Charge") ||
        unit.hasBuffActive("Flesh Shield Aura") ||
        unit.hasAbilityActive("Fire Shield") ||
        target.hasBuffActive("Fireforged Sword") ||
        SECONDARY_RIDERS.some((name) => target.hasAbilityActive(name)) ||
        (context.fightProperties?.getBreakChancePerTeam(target.getTeam()) ?? 0) > 0
    )
        return false;
    const response = estimatePrimaryMeleeDamage(target, unit, context, target.getBaseCell(), [
        {
            type: "melee_attack",
            attackerId: target.getId(),
            targetId: unit.getId(),
            attackFrom: target.getBaseCell(),
        },
    ]);
    if (!response) return false;
    if (response.hitChance <= 0 || unit.willWaterShieldAbsorb(target)) return true;
    return response.landedOutcomes.every((outcome) => outcome.damage < unit.getCumulativeHp());
}

/**
 * Price a supported direct melee hit and the enemy corpse's blast in the same HP units. The strike must
 * actually destroy the stack: a miss, nonfatal roll, absorbed hit or native resurrection buys no explosion.
 * Redirection, secondary damage, hazardous movement and chained resurrection stay with the real engine search.
 * No live HP, shields, positions or combat randomness are changed by this projection.
 */
export function estimateLastFuseMeleeDamage(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    standCell: XY,
    actions: readonly GameAction[],
): ILastFuseDamageEstimate | undefined {
    if (!unit.hasBuffActive("Last Fuse") || target.isDead() || target.getTeam() === unit.getTeam()) return undefined;
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
    if (fatalChance > 0 && !canProjectMeleeResponse(unit, target, context, actions)) return undefined;
    const splash = fatalChance > 0 ? enemyBlastDamage(unit, target, context) : 0;
    if (splash === undefined) return undefined;
    return {
        expectedNetDamage: damage.expectedEffectiveDamage + fatalChance * splash,
        expectedPrimaryDamage: damage.expectedEffectiveDamage,
        expectedFriendlyDamage: 0,
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
    if (
        !fight ||
        target.isDead() ||
        !unit.hasBuffActive("Last Fuse") ||
        target.getTeam() === unit.getTeam() ||
        unit.getRangeShots() <= 0
    )
        return undefined;
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
    const splash = fatalChance > 0 ? enemyBlastDamage(unit, target, context) : 0;
    if (splash === undefined) return undefined;
    return {
        expectedNetDamage: (absorbed ? 0 : hitChance * conditionalDamage) + fatalChance * splash,
        expectedPrimaryDamage: absorbed ? 0 : hitChance * conditionalDamage,
        expectedFriendlyDamage: 0,
        fatalChance,
        secureKill: firstKills && !resurrects,
    };
}
