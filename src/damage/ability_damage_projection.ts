/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { withDualStrikeCharm } from "../abilities/ability_helper";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Ability } from "../abilities/ability";
import type { Unit } from "../units/unit";

import {
    projectAttackDamageBand,
    projectKillBand,
    type IAttackDamageProjection,
    type IAttackDamageProjectionInput,
} from "./damage_projection";

/**
 * The ability TAILS: the extra steps two ability paths run on top of Unit.calculateAttackDamage.
 *
 * A preview that stops at calculateAttackDamage prices a Large Caliber shot as if Giant's Maul, Broken
 * Aegis and status resistance did not exist, and a Double Shot as a flat "x2" the engine never deals.
 * Each helper below mirrors its engine counterpart step for step, INCLUDING the flooring order — the
 * tails floor after every single step, so applying them in one product would land on other integers.
 */

/** Zero band — a volley that cannot fly (empty quiver, missing ability) deals nothing at all. */
const NO_DAMAGE: IAttackDamageProjection = { min: 0, max: 0, killsMin: 0, killsMax: 0 };

/**
 * The attacker's Paralysis penalty as a multiplier (1 when unparalysed). Every damage path folds this
 * same block into its abilityMultiplier — the plain shot, the AOE splash and Double Shot's second volley
 * — so a preview that omits it over-promises exactly while the attacker is paralysed.
 */
export function attackerParalysisMultiplier(attacker: Unit): number {
    const paralysisAttackerEffect = attacker.getEffect("Paralysis");
    return paralysisAttackerEffect ? (100 - paralysisAttackerEffect.getPower()) / 100 : 1;
}

/* ------------------------------------------------------------------------------------------------ *
 *  AOE tail (aoe_range_ability.processRangeAOEAbility)
 * ------------------------------------------------------------------------------------------------ */

/**
 * The AOE ability whose splash the attacker's shot routes through, in the engine's own lookup order.
 * Being one of these is what earns a shot the whole AOE package below.
 */
export function aoeAttackAbility(attacker: Unit): Ability | undefined {
    return attacker.getAbility("Area Throw") ?? attacker.getAbility("Large Caliber") ?? attacker.getAbility("Chakram");
}

/**
 * The abilityMultiplier processRangeAOEAbility hands to calculateAttackDamage: the AOE ability's own
 * multiplier, then the attacker's Paralysis penalty. 1 when the attacker has no AOE ability.
 */
export function aoeAttackAbilityMultiplier(
    attacker: Unit,
    synergyAbilityPowerIncrease: number,
    aoeAbility?: Ability,
): number {
    const ability = aoeAbility ?? aoeAttackAbility(attacker);
    if (!ability) {
        return 1;
    }

    return (
        attacker.calculateAbilityMultiplier(ability, synergyAbilityPowerIncrease) *
        attackerParalysisMultiplier(attacker)
    );
}

export interface IAoeDamageTailInput {
    attacker: Unit;
    /** The unit this particular sub-hit lands on — the primary target or any splashed bystander. */
    victim: Unit;
    /** The hit as calculateAttackDamage produced it, before artifacts and resistances. */
    damage: number;
    /** Zena's Chakram halves a bounce onto a target two cells removed (0.5). Undefined/1 = untouched. */
    perUnitDamageFactor?: number;
}

/**
 * Everything processRangeAOEAbility does to a hit AFTER calculateAttackDamage returns it:
 * per-victim bounce factor, ARTIFACT Giant's Maul (+%), ARTIFACT Broken Aegis on the victim (-%), then
 * the victim's physical-AOE status resistance (Mechanisms take extra). Each step floors on its own.
 */
export function applyAoeDamageTail({ attacker, victim, damage, perUnitDamageFactor }: IAoeDamageTailInput): number {
    let damageFromAttack = damage;

    if (perUnitDamageFactor !== undefined && perUnitDamageFactor !== 1) {
        damageFromAttack = Math.floor(damageFromAttack * perUnitDamageFactor);
    }

    const giantsMaulBuff = attacker.getBuff("Giants Maul");
    if (giantsMaulBuff) {
        damageFromAttack = Math.floor(damageFromAttack * (1 + giantsMaulBuff.getPower() / 100));
    }

    const aegisShieldBuff = victim.getBuff("Broken Aegis");
    if (aegisShieldBuff) {
        damageFromAttack = Math.floor(damageFromAttack * (1 - aegisShieldBuff.getPower() / 100));
    }

    return Math.floor(damageFromAttack * victim.getPhysicalAoeDamageMultiplier());
}

export interface IAoeRangeAttackProjectionInput {
    attacker: Unit;
    /** The unit whose damage is being projected. Project each splashed unit separately: the tail is per-victim. */
    victim: Unit;
    /** Additional ability power for the ATTACKER's team — the value processRangeAOEAbility passes down. */
    synergyAbilityPowerIncrease: number;
    /** The shot's range divisor (falloff / smoke), as evaluateRangeAttack resolved it. */
    divisor?: number;
    /** Chakram bounce factor for this victim (chakram_ability.damageFactorByUnitId). */
    perUnitDamageFactor?: number;
    /** Pre-resolved AOE ability, when the caller already looked it up. */
    aoeAbility?: Ability;
    /** Stack size override for what-if previews. */
    amountAliveOverride?: number;
    /** Attack rate override (War Anger). Defaults to attacker.getAttack(), as the engine uses. */
    attackRate?: number;
}

/**
 * One AOE sub-hit, end to end: the RANGE damage band Unit.calculateAttackDamage would produce with the
 * AOE ability's multiplier, then the AOE tail on BOTH ends, then the kill band recomputed from the
 * post-tail numbers. This is the number a Large Caliber / Area Throw / Chakram victim actually takes.
 */
export function projectAoeRangeAttack(input: IAoeRangeAttackProjectionInput): IAttackDamageProjection {
    const { attacker, victim, synergyAbilityPowerIncrease, divisor, perUnitDamageFactor, aoeAbility } = input;

    const band = projectAttackDamageBand({
        attacker,
        target: victim,
        attackType: PBTypes.AttackVals.RANGE,
        synergyAbilityPowerIncrease,
        divisor,
        abilityMultiplier: aoeAttackAbilityMultiplier(attacker, synergyAbilityPowerIncrease, aoeAbility),
        attackRate: input.attackRate,
        amountAliveOverride: input.amountAliveOverride,
    });

    return projectKillBand(
        victim,
        applyAoeDamageTail({ attacker, victim, damage: band.min, perUnitDamageFactor }),
        applyAoeDamageTail({ attacker, victim, damage: band.max, perUnitDamageFactor }),
    );
}

/* ------------------------------------------------------------------------------------------------ *
 *  Through Shot's line tail (through_shot_ability.processThroughShotAbility)
 * ------------------------------------------------------------------------------------------------ */

/**
 * The abilityMultiplier a pierced hit lands with: the Through Shot ability's own multiplier (scaled by
 * the ATTACKER's team power), then the volley multiplier when this pierce belongs to Double Shot's
 * second arrow, then the attacker's Paralysis — in that order.
 */
export function throughShotAbilityMultiplier(
    attacker: Unit,
    attackerSynergyAbilityPowerIncrease: number,
    volleyMultiplier = 1,
): number {
    const ability = attacker.getAbility("Through Shot");
    if (!ability) {
        return 1;
    }

    return (
        attacker.calculateAbilityMultiplier(ability, attackerSynergyAbilityPowerIncrease) *
        volleyMultiplier *
        attackerParalysisMultiplier(attacker)
    );
}

/**
 * Through Shot's own tail: ARTIFACT Giant's Maul at impact, then the pierced unit's physical-AOE status
 * resistance. It is the AOE tail MINUS the Broken Aegis step — the line attack deliberately does not read
 * the victim's Aegis — so it gets its own helper rather than a flag.
 */
export function applyThroughShotDamageTail({
    attacker,
    victim,
    damage,
}: Omit<IAoeDamageTailInput, "perUnitDamageFactor">): number {
    let damageFromAttack = damage;

    const giantsMaulBuff = attacker.getBuff("Giants Maul");
    if (giantsMaulBuff) {
        damageFromAttack = Math.floor(damageFromAttack * (1 + giantsMaulBuff.getPower() / 100));
    }

    return Math.floor(damageFromAttack * victim.getPhysicalAoeDamageMultiplier());
}

export interface IThroughShotProjectionInput {
    attacker: Unit;
    /** The pierced unit whose damage is being projected — project every unit on the ray separately. */
    victim: Unit;
    /**
     * ATTACKER team's additional ability power. It scales the Through Shot ability itself AND — through
     * calculateAttackDamage's getEnemyArmor — the shooter's Piercing Spear armor-ignore. Both slots take
     * the attacker's team, exactly like every other damage path.
     */
    attackerSynergyAbilityPowerIncrease: number;
    /**
     * @deprecated Ignored. The engine used to hand the DEFENDER's team power to calculateAttackDamage on
     * this path, which silently dropped the shooter's own synergy from its armor-ignore; that was an
     * engine defect and is fixed. The field is kept so existing callers still compile.
     */
    targetSynergyAbilityPowerIncrease?: number;
    /** THIS pierce's own divisor — hoverRangeAttackDivisors[i], never the first unit's. */
    divisor?: number;
    /** Double Shot's second-volley multiplier when this pierce belongs to that volley. */
    volleyMultiplier?: number;
    /** Stack size override for what-if previews. */
    amountAliveOverride?: number;
    /** Attack rate override (War Anger). */
    attackRate?: number;
}

/** One pierced hit, end to end: RANGE band with the Through Shot multiplier, its tail, then the kills. */
export function projectThroughShotAttack(input: IThroughShotProjectionInput): IAttackDamageProjection {
    const { attacker, victim } = input;
    const band = projectAttackDamageBand({
        attacker,
        target: victim,
        attackType: PBTypes.AttackVals.RANGE,
        synergyAbilityPowerIncrease: input.attackerSynergyAbilityPowerIncrease,
        divisor: input.divisor,
        abilityMultiplier: throughShotAbilityMultiplier(
            attacker,
            input.attackerSynergyAbilityPowerIncrease,
            input.volleyMultiplier,
        ),
        attackRate: input.attackRate,
        amountAliveOverride: input.amountAliveOverride,
    });

    return projectKillBand(
        victim,
        applyThroughShotDamageTail({ attacker, victim, damage: band.min }),
        applyThroughShotDamageTail({ attacker, victim, damage: band.max }),
    );
}

/* ------------------------------------------------------------------------------------------------ *
 *  Double Shot's second volley (double_shot_ability.processDoubleShotAbility)
 * ------------------------------------------------------------------------------------------------ */

/** Double Shot, or the Blacksmith-crafted variant that behaves identically. */
export function doubleShotAbility(attacker: Unit): Ability | undefined {
    return attacker.getAbility("Double Shot") ?? attacker.getAbility("Crafted Double Shot");
}

/**
 * The multiplier the SECOND volley lands at. It is NOT a flat 2x: Double Shot is a stack_powered
 * TOTAL_DAMAGE_PERCENTAGE ability, so calculateAbilityMultiplier dilutes it across the stack and folds
 * in the attacker's luck and the team's synergy — a stack of 1 throws its second arrow at a fifth
 * strength. ARTIFACT Dual Strike Charm boosts it, the attacker's Paralysis cuts it, in that order.
 */
export function doubleShotSecondVolleyMultiplier(attacker: Unit, synergyAbilityPowerIncrease: number): number {
    const ability = doubleShotAbility(attacker);
    if (!ability) {
        return 0;
    }

    return (
        withDualStrikeCharm(attacker.calculateAbilityMultiplier(ability, synergyAbilityPowerIncrease), attacker) *
        attackerParalysisMultiplier(attacker)
    );
}

export interface IDoubleShotProjectionInput {
    attacker: Unit;
    target: Unit;
    /** Additional ability power for the ATTACKER's team. */
    synergyAbilityPowerIncrease: number;
    /** The shot's range divisor (falloff / smoke). */
    divisor?: number;
    /** Stack size override for what-if previews. */
    amountAliveOverride?: number;
    /** Attack rate override (War Anger). */
    attackRate?: number;
}

/**
 * The second volley alone.
 *
 * Gated on AMMO, not just on owning the ability: the first volley spends its arrows inside
 * calculateAttackDamage, so the last arrow in the quiver fires ONCE — the second volley re-enters
 * calculateAttackDamage, finds getRangeShots() <= 0 and returns a hard 0.
 */
export function projectDoubleShotSecondVolley(input: IDoubleShotProjectionInput): IAttackDamageProjection {
    const { attacker, target, synergyAbilityPowerIncrease } = input;
    if (!doubleShotAbility(attacker) || attacker.projectRangeShotsAfterVolleys(target, 1) <= 0) {
        return { ...NO_DAMAGE };
    }

    return projectVolley(input, doubleShotSecondVolleyMultiplier(attacker, synergyAbilityPowerIncrease));
}

export interface IDoubleShotProjection {
    /** The ordinary shot: abilityMultiplier 1, exactly as the attack handler fires it. */
    first: IAttackDamageProjection;
    /** The Double Shot volley, 0 when the quiver ran dry on the first one. */
    second: IAttackDamageProjection;
    /** What the target takes from the whole attack — the number a hover should show. */
    total: IAttackDamageProjection;
}

/**
 * Both volleys of a single-target Double Shot attack, and their sum.
 *
 * The engine fires two INDEPENDENT shots — each ceils its own band and floors its own product — so the
 * total is `2 * ceil(x)`-shaped, never `ceil(2x)`. The kill band of the total is taken from the summed
 * damage, which is what sequential application costs the stack.
 */
export function projectDoubleShotAttack(input: IDoubleShotProjectionInput): IDoubleShotProjection {
    // The attack handler fires the FIRST volley at a hard abilityMultiplier of 1, cut only by Paralysis.
    const first = projectVolley(input, attackerParalysisMultiplier(input.attacker));
    const second = projectDoubleShotSecondVolley(input);

    return {
        first,
        second,
        total: projectKillBand(input.target, first.min + second.min, first.max + second.max),
    };
}

function projectVolley(input: IDoubleShotProjectionInput, abilityMultiplier: number): IAttackDamageProjection {
    const projectionInput: IAttackDamageProjectionInput = {
        attacker: input.attacker,
        target: input.target,
        attackType: PBTypes.AttackVals.RANGE,
        synergyAbilityPowerIncrease: input.synergyAbilityPowerIncrease,
        divisor: input.divisor,
        abilityMultiplier,
        attackRate: input.attackRate,
        amountAliveOverride: input.amountAliveOverride,
    };
    const band = projectAttackDamageBand(projectionInput);

    return projectKillBand(input.target, band.min, band.max);
}
