import { nextStandingTargets } from "../abilities/ability_helper";
import { applyAttackDamageChain, resolveAttackDamageChain } from "../damage/damage_projection";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import { SpellElement } from "../spells/spell_properties";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import type { IDecisionContext } from "./ai_strategy";

/** Research-only whole-impact rank for a direct melee strike plus its Fire Breath tail. */
export function estimateFireBreathMeleePotential(
    unit: Unit,
    target: Unit,
    context: IDecisionContext,
    stand: XY,
    actions: readonly GameAction[],
): { netDamage: number; securePrimaryKill: boolean } | undefined {
    const ability = unit.getAbility("Fire Breath"),
        fight = context.fightProperties;
    if (!ability || !unit.hasAbilityActive("Fire Breath") || !fight) return;
    if (
        [
            "Lightning Spin",
            "Skewer Strike",
            "Chain Lightning",
            "Double Punch",
            "Lucky Strike",
            "Penetrating Bite",
            "Rapid Charge",
            "Backstab",
        ].some((name) => unit.getAbility(name))
    )
        return;
    if (target.hasBuffActive("Flesh Shield Aura")) return;
    const move = actions.find((a) => a.type === "move_unit");
    if (move?.type === "move_unit" && (move.hasLavaCell || move.hasWaterCell)) return;
    const power = fight.getAdditionalAbilityPowerPerTeam(unit.getTeam());
    const attackRate =
        Math.max(unit.getBaseAttack(), unit.getAttack() - unit.getCurrentAttackModIncrease()) +
        context.unitsHolder.getUnitAuraAttackMod(unit, unit.getFootprintCellsForAnchor(stand));
    const meanDamage = (
        victim: Unit,
        multiplier: number,
        breath: boolean,
    ): { mean: number; minimum: number } | undefined => {
        const chain = resolveAttackDamageChain({
            attacker: unit,
            target: victim,
            attackType: PBTypes.AttackVals.MELEE,
            synergyAbilityPowerIncrease: power,
            attackRate,
            abilityMultiplier: multiplier,
        });
        const rolls = Math.max(1, chain.rollMaxExclusive - chain.rollMin);
        if (!Number.isSafeInteger(rolls) || rolls > 10000) return;
        let sum = 0,
            minimum = Infinity;
        for (let raw = chain.rollMin; raw < chain.rollMin + rolls; raw++) {
            let damage = applyAttackDamageChain(chain, raw);
            if (breath) {
                damage = Math.floor(
                    damage * (1 - victim.getMagicResist() / 100) * victim.getMagicDamageTakenMultiplier(),
                );
                const aegis = victim.getBuff("Broken Aegis");
                if (aegis) damage = Math.floor(damage * (1 - aegis.getPower() / 100));
            }
            if (victim.willAbsorbIncomingHit(unit, breath ? SpellElement.FIRE : undefined)) damage = 0;
            const effective = Math.min(victim.getCumulativeHp(), Math.max(0, damage));
            sum += effective;
            minimum = Math.min(minimum, effective);
        }
        return { mean: sum / rolls, minimum };
    };
    let netDamage = 0;
    for (const victim of nextStandingTargets(unit, target, context.grid, context.unitsHolder, stand)) {
        if (victim.isDead()) continue;
        // An immune body stops the canonical breath, including every victim further behind it.
        if (victim.getMagicResist() >= 100 || victim.hasAbilityActive("Fire Element")) break;
        const projected = meanDamage(victim, unit.calculateAbilityMultiplier(ability, power), true);
        if (!projected) return;
        netDamage += (victim.getTeam() === unit.getTeam() ? -1 : 1) * projected.mean;
    }
    const paralysis = unit.getEffect("Paralysis");
    const primary = meanDamage(target, paralysis ? (100 - paralysis.getPower()) / 100 : 1, false);
    if (!primary) return;
    const hitChance =
        1 -
        Math.min(
            100,
            Math.max(
                0,
                Math.ceil(unit.calculateMissChance(target, fight.getAdditionalAbilityPowerPerTeam(target.getTeam()))),
            ),
        ) /
            100;
    return {
        netDamage: netDamage + primary.mean * hitChance,
        securePrimaryKill: hitChance === 1 && primary.minimum >= target.getCumulativeHp(),
    };
}
