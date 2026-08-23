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

import { AbilityPowerType } from "../abilities/ability_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { AttackType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";

/**
 * THE single source of truth for "how much damage will this attack deal".
 *
 * Unit.calculateAttackDamage RESOLVES an attack (it rolls, and a ranged volley spends its arrows);
 * everything that has to PREDICT one — the hover preview, a tooltip, an AI estimate — projects the
 * band instead. Both go through {@link resolveAttackDamageChain} + {@link applyAttackDamageChain}, so
 * the prediction cannot drift from the resolution: there is only one formula and one flooring order.
 *
 * The projection differs from the engine in exactly two ways, and in no others:
 *   - it does not roll (it returns the band's reachable ends), and
 *   - it does not spend shots (it only READS the quiver to know whether a volley can fly at all).
 */

/** Damage band (both ends REACHABLE by the engine) plus the stack losses each end inflicts. */
export interface IAttackDamageProjection {
    /** Lowest damage the engine can deal with this attack. */
    min: number;
    /** Highest damage the engine can deal with this attack (already max-exclusive corrected). */
    max: number;
    /** Units of the target's stack that `min` kills. */
    killsMin: number;
    /** Units of the target's stack that `max` kills. */
    killsMax: number;
}

export interface IAttackDamageProjectionInput {
    attacker: Unit;
    target: Unit;
    attackType: AttackType;
    /** Additional ability power for the ATTACKER's team (FightProperties.getAdditionalAbilityPowerPerTeam). */
    synergyAbilityPowerIncrease: number;
    /** Range falloff / melee-poke divisor. Defaults to 1, exactly like the engine's parameter. */
    divisor?: number;
    /** Post-roll ability multiplier (Through Shot, Area Throw, Double Shot's 2nd volley, ...). Defaults to 1. */
    abilityMultiplier?: number;
    /**
     * Attack rate to price the strike with. Defaults to `attacker.getAttack()`, which is what the engine
     * uses. A preview passes an override ONLY when the strike will happen from a different cell and the
     * attack rate is about to change there (War Anger aura), i.e. when getAttack() is not yet the rate
     * the engine will see at impact.
     */
    attackRate?: number;
    /** Stack size override for what-if previews. Defaults to the attacker's current amount_alive. */
    amountAliveOverride?: number;
}

/**
 * Everything Unit.calculateAttackDamage needs to produce its number, with the roll left out.
 *
 * `rollMaxExclusive` is the value handed to HoCLib.getRandomInt, which is documented and implemented as
 * EXCLUSIVE of max ("[min, max)"). The largest roll the engine can ever produce is therefore
 * `rollMaxExclusive - 1`, never `rollMaxExclusive` — see {@link reachableTopRoll}.
 */
export interface IAttackDamageChain {
    /** Inclusive lower bound handed to getRandomInt. */
    rollMin: number;
    /** EXCLUSIVE upper bound handed to getRandomInt. */
    rollMaxExclusive: number;
    /** 0.5 when a RANGE unit without Handyman is forced to swing in melee, else 1. */
    attackTypeMultiplier: number;
    /** The caller-supplied ability multiplier, applied AFTER the roll (never folded into min/max). */
    abilityMultiplier: number;
    /** 1 + power/100 when this attacker inflicts Deep Wounds and the victim already carries the effect. */
    deepWoundsMultiplier: number;
    /** Fire <-> Water affinity multiplier (Unit.getElementalDamageMultiplier). */
    elementalMultiplier: number;
    /** True for the volley path: a RANGE attack, which consumes arrows when the engine resolves it. */
    spendsShot: boolean;
    /** True when a RANGE attack cannot fly at all (empty quiver) — the engine returns a hard 0. */
    outOfShots: boolean;
}

/**
 * Resolve every term of Unit.calculateAttackDamage EXCEPT the roll itself. Pure: nothing is mutated,
 * no arrows are spent, no randomness is consumed.
 */
export function resolveAttackDamageChain({
    attacker,
    target,
    attackType,
    synergyAbilityPowerIncrease,
    divisor = 1,
    abilityMultiplier = 1,
    attackRate,
    amountAliveOverride,
}: IAttackDamageProjectionInput): IAttackDamageChain {
    const isRangeAttack = attackType === PBTypes.AttackVals.RANGE;
    const rate = attackRate ?? attacker.getAttack();

    // The ability multiplier is deliberately NOT passed down here: the engine folds it in AFTER the roll,
    // under the single Math.floor below. Folding it into min/max instead would round it up (Math.ceil)
    // and over-report every fractional hit.
    const rollMin = attacker.calculateAttackDamageMin(
        rate,
        target,
        isRangeAttack,
        synergyAbilityPowerIncrease,
        divisor,
        1,
        amountAliveOverride,
    );
    const rollMaxExclusive = attacker.calculateAttackDamageMax(
        rate,
        target,
        isRangeAttack,
        synergyAbilityPowerIncrease,
        divisor,
        1,
        amountAliveOverride,
    );

    const attackingByMelee = attackType === PBTypes.AttackVals.MELEE || attackType === PBTypes.AttackVals.MELEE_MAGIC;
    const spendsShot = !attackingByMelee && isRangeAttack;

    // A RANGE unit swinging in melee lands a half-strength poke — applied to the ROLL and floored, never
    // folded into the band as a divisor (dividing inside the band ceils, and ceil(x/2) >= floor(ceil(x)/2)).
    const attackTypeMultiplier =
        attackingByMelee &&
        attacker.getAttackType() === PBTypes.AttackVals.RANGE &&
        !attacker.hasAbilityActive("Handyman")
            ? 0.5
            : 1;

    // Deep Wounds damage bonus: if THIS attacker inflicts Deep Wounds and the target already carries the
    // stacked "Deep Wounds" effect from a prior hit, this strike deals that % more damage. (calculate-
    // ActiveDeepWoundsEffect encoded this but was never wired into damage — this is where it applies, so it
    // works in ranked and sandbox alike since both run this same path.)
    let deepWoundsMultiplier = 1;
    const deepWoundsPower = target.getEffect("Deep Wounds")?.getPower() ?? 0;
    if (
        deepWoundsPower > 0 &&
        (attacker.getAbility("Deep Wounds Level 0") ||
            attacker.getAbility("Deep Wounds Level 1") ||
            attacker.getAbility("Deep Wounds Level 2") ||
            attacker.getAbility("Deep Wounds Level 3"))
    ) {
        deepWoundsMultiplier = 1 + deepWoundsPower / 100;
    }

    return {
        rollMin,
        rollMaxExclusive,
        attackTypeMultiplier,
        abilityMultiplier,
        deepWoundsMultiplier,
        elementalMultiplier: attacker.getElementalDamageMultiplier(target),
        spendsShot,
        outOfShots: spendsShot && attacker.getRangeShots() <= 0,
    };
}

/**
 * Turn one roll into the damage the engine deals. The multiplication order and the SINGLE Math.floor are
 * the engine's own — keep them byte-identical, since a reordered product can floor to a different integer.
 */
export function applyAttackDamageChain(chain: IAttackDamageChain, roll: number): number {
    return Math.floor(
        roll *
            chain.attackTypeMultiplier *
            chain.abilityMultiplier *
            chain.deepWoundsMultiplier *
            chain.elementalMultiplier,
    );
}

/**
 * The largest roll getRandomInt(min, max) can return. The bound is EXCLUSIVE, so it is `max - 1` — and
 * `min` when the band is a single point (getRandomInt returns min when max === min). Publishing `max`
 * as the top of a preview promises damage the engine can never deal.
 */
export function reachableTopRoll(chain: IAttackDamageChain): number {
    return Math.max(chain.rollMin, chain.rollMaxExclusive - 1);
}

/** Band (no kills) of the damage this attack can deal: both ends are values the engine can actually produce. */
export function projectAttackDamageBand(input: IAttackDamageProjectionInput): { min: number; max: number } {
    const chain = resolveAttackDamageChain(input);
    if (chain.outOfShots) {
        return { min: 0, max: 0 };
    }

    return {
        min: applyAttackDamageChain(chain, chain.rollMin),
        max: applyAttackDamageChain(chain, reachableTopRoll(chain)),
    };
}

/**
 * Attach the stack losses a damage band inflicts, through the SAME helper the engine uses when it
 * applies the hit (Unit.calculatePossibleLosses). Call this LAST — after every tail (AOE artifacts,
 * status resistance) has been applied — so the kill count is the count for the damage actually dealt.
 */
export function projectKillBand(target: Unit, min: number, max: number): IAttackDamageProjection {
    return {
        min,
        max,
        killsMin: target.calculatePossibleLosses(min),
        killsMax: target.calculatePossibleLosses(max),
    };
}

/**
 * Project one attack: the exact damage band Unit.calculateAttackDamage can produce, plus the kill band.
 *
 * Mirrors the engine's pipeline step for step — same min/max, same max-exclusive top, same
 * attackType/ability/DeepWounds/elemental chain, the same single Math.floor at the same point — and
 * returns a flat 0/0 for a ranged attacker with an empty quiver, exactly as the engine bails to 0.
 */
export function projectAttackDamage(input: IAttackDamageProjectionInput): IAttackDamageProjection {
    const band = projectAttackDamageBand(input);
    return projectKillBand(input.target, band.min, band.max);
}

/**
 * The arrows ONE volley against `target` costs — the pure half of Unit.spendShotsAgainst, which calls
 * this and then spends exactly this many. UNLIMITED_SUPPLIES shoots for free; Dense Flesh makes a volley
 * aimed at its owner cost its ability power instead of one.
 */
export function projectShotCost(attacker: Unit, target?: Unit): number {
    for (const ability of attacker.getAbilities()) {
        if (ability.getPowerType() === AbilityPowerType.UNLIMITED_SUPPLIES) {
            return 0;
        }
    }

    return target?.hasAbilityActive("Dense Flesh") === true
        ? Math.max(1, Math.floor(target.getAbility("Dense Flesh")?.getPower() ?? 1))
        : 1;
}
