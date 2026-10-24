import { hasAnyDeepWoundsAbility } from "../abilities/deep_wounds_ability";
import { applyAttackDamageChain, resolveAttackDamageChain } from "../damage/damage_projection";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";

export interface ILightningSpinPotential {
    expectedDirectDamage: number;
    secureKill: boolean;
    /** Conservative kill opportunity times the recoverable front creature's HP, never resurrected bodies. */
    healingPotential: number;
}

/**
 * Pure catalog ranking for Hydra's whole radial impact. The real-engine search still owns reflection,
 * riders, deaths, Devour and the position's future safety. This estimate only prevents the melee cap from
 * throwing away a strong spin because its declared primary happens to be an unimportant stack.
 *
 * Shared Covenant is consumed by the first positive landed physical hit, not independently by each ally.
 * Personal Water Shields survive a Covenant absorb. A missed/zero hit spends neither shield.
 */
export function estimateLightningSpinPotential(
    unit: Unit,
    context: IDecisionContext,
    stand: XY,
    actions: readonly GameAction[],
): ILightningSpinPotential | undefined {
    const spin = unit.getAbility("Lightning Spin");
    const fight = context.fightProperties;
    const move = actions.find((action) => action.type === "move_unit");
    if (
        !spin ||
        !unit.hasAbilityActive("Lightning Spin") ||
        !fight ||
        (move?.type === "move_unit" && (move.hasLavaCell || move.hasWaterCell))
    )
        return;
    // Other replacement sweeps can depend on the declared primary; do not deduplicate inherited kits.
    if (
        ["Fire Breath", "Skewer Strike", "Chain Lightning", "Double Punch"].some((ability) =>
            unit.hasAbilityActive(ability),
        )
    )
        return;
    const enemies = context.unitsHolder
        .allEnemiesAroundUnit(unit, true, stand)
        .filter(
            (enemy) =>
                !enemy.isDead() &&
                !unit.cannotAttackUnitId(enemy.getId()) &&
                !(unit.hasStatusApplied("Cowardice") && unit.getCumulativeHp() < enemy.getCumulativeHp()),
        );
    // Redirection changes impact order, HP and kill credit. Leave those stands on their historical estimate.
    if (
        enemies.some((enemy) => enemy.hasAbilityActive("Flesh Shield Aura") || enemy.hasBuffActive("Flesh Shield Aura"))
    )
        return;
    const power = fight.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const aura = context.unitsHolder.getUnitAuraAttackMod(unit, unit.getFootprintCellsForAnchor(stand));
    const attackRate = Math.max(unit.getBaseAttack(), unit.getAttack() - unit.getCurrentAttackModIncrease()) + aura;
    let multiplier = unit.calculateAbilityMultiplier(spin, power);
    const charge = unit.getAbility("Rapid Charge");
    if (charge) {
        const coefficient = unit.calculateAbilityMultiplier(charge, power);
        if (coefficient >= 1) multiplier *= 1 + (coefficient - 1) * (move?.type === "move_unit" ? move.path.length : 1);
    }
    const paralysis = unit.getEffect("Paralysis");
    if (paralysis) multiplier *= (100 - paralysis.getPower()) / 100;
    const luck = unit.getAbility("Lucky Strike");
    const luckyChance = luck
        ? Math.min(1, Math.max(0, Math.ceil(unit.calculateAbilityApplyChance(luck, power)) / 100))
        : 0;
    const luckyMultiplier = luck ? unit.calculateAbilityMultiplier(luck, power) : 1;
    const maul = 1 + (unit.getBuff("Giants Maul")?.getPower() ?? 0) / 100;
    let covenantRemaining = enemies.some((enemy) => enemy.hasStatusBuffApplied("Ember Covenant Blessing")) ? 1 : 0;
    let expectedDirectDamage = 0;
    let secureKill = false;
    let killOpportunity = 0;
    for (const enemy of enemies) {
        const wounds = hasAnyDeepWoundsAbility(unit) ? 1 + (enemy.getEffect("Deep Wounds")?.getPower() ?? 0) / 100 : 1;
        const chain = resolveAttackDamageChain({
            attacker: unit,
            target: enemy,
            attackType: PBTypes.AttackVals.MELEE,
            synergyAbilityPowerIncrease: power,
            attackRate,
            abilityMultiplier: multiplier * wounds,
        });
        const rolls = Math.max(1, chain.rollMaxExclusive - chain.rollMin);
        if (!Number.isSafeInteger(rolls) || rolls > 10000) return;
        const bite = unit.getAbility("Penetrating Bite");
        const biteDamage = bite ? Math.floor((unit.calculateAbilityMultiplier(bite, power) - 1) * enemy.getMaxHp()) : 0;
        const aegis = 1 - (enemy.getBuff("Broken Aegis")?.getPower() ?? 0) / 100;
        let mean = 0;
        let positive = 0;
        let lethal = 0;
        const hp = enemy.getCumulativeHp();
        const resistance = enemy.getPhysicalAoeDamageMultiplier();
        const addOutcome = (damage: number, probability: number): void => {
            const impact = Math.floor(Math.floor(Math.floor((damage + biteDamage) * maul) * aegis) * resistance);
            mean += Math.min(hp, Math.max(0, impact)) * probability;
            if (impact > 0) positive += probability;
            if (impact >= hp) lethal += probability;
        };
        for (let roll = chain.rollMin; roll < chain.rollMin + rolls; roll++) {
            const ordinary = applyAttackDamageChain(chain, roll);
            if (luckyChance < 1) addOutcome(ordinary, (1 - luckyChance) / rolls);
            if (luckyChance > 0) addOutcome(Math.floor(ordinary * luckyMultiplier), luckyChance / rolls);
        }
        const hitChance =
            1 -
            Math.min(
                1,
                Math.max(
                    0,
                    Math.ceil(
                        unit.calculateMissChance(enemy, fight.getAdditionalAbilityPowerPerTeam(enemy.getTeam())),
                    ) / 100,
                ),
            );
        const covenant = enemy.hasStatusBuffApplied("Ember Covenant Blessing") ? covenantRemaining : 0;
        const blocked = enemy.willEmberCovenantBlock(unit) ? covenant : 0;
        const shield = enemy.willWaterShieldAbsorb(unit);
        const lands = hitChance * (1 - blocked) * (shield ? 0 : 1);
        expectedDirectDamage += lands * mean;
        const killChance = lands * lethal;
        if (killChance >= 1 - 1e-12) secureKill = true;
        if (!enemy.canSelfResurrect()) killOpportunity = Math.max(killOpportunity, killChance);
        if (covenant > 0) covenantRemaining *= 1 - hitChance * Math.min(1, positive);
    }
    const devour = unit.getAbility("Devour Essence");
    const healLimit = devour
        ? Math.ceil(
              unit.getMaxHp() * Math.min(1, Number(unit.calculateAbilityApplyChance(devour, power).toFixed(2)) / 100),
          )
        : 0;
    return {
        expectedDirectDamage,
        secureKill,
        healingPotential: Math.max(0, healLimit - unit.getHp()) * killOpportunity,
    };
}
