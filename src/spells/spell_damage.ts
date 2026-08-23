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

import { empowerMultiplier } from "../augments/augment_properties";
import { MAX_UNIT_STACK_POWER } from "../constants";
import { SpellElement, SpellMultiplierType } from "./spell_properties";

/** The bare minimum of a unit this module needs, so it stays free of a Unit import cycle. */
interface IEmpowerableCaster {
    getBuff(name: string): { getPower(): number } | undefined;
}

/**
 * The team's Empower Augment percentage, read off the unit that is about to deal the damage.
 *
 * UnitsHolder.applyAugments puts an "Empower Augment" buff on every unit of a team that bought the augment,
 * so the caster itself carries the number — no FightProperties lookup (and therefore no fight-singleton
 * dependency) is needed at the damage site, which is what lets the client's spellbook and the server's
 * engine agree while running off completely different fight state.
 */
export function getEmpowerPercentage(caster?: IEmpowerableCaster | null): number {
    if (!caster) {
        return 0;
    }
    const power = caster.getBuff("Empower Augment")?.getPower();
    return Number.isFinite(power) ? (power as number) : 0;
}

/**
 * Fireforged Sword's bonus-damage percentage after the holder team's Empower Augment.
 *
 * Both the stat maths (Unit.adjustBaseStats, which turns it into attack_mod) and the spellbook card read
 * this, so the "+10.7%" the card promises is the "+10.7%" the blade delivers. One decimal for the same
 * reason fireWallBurnPercentage rounds: 10 x 1.07 = 10.7 is a number, 10.700000000000001 is not.
 */
export function fireforgedSwordPower(basePower: number, empowerPercentage: number): number {
    if (!Number.isFinite(basePower) || basePower <= 0) {
        return 0;
    }
    if (!Number.isFinite(empowerPercentage) || empowerPercentage <= 0) {
        return basePower;
    }
    // (100 + pct)/100 rather than 1 + pct/100 — see fireWallBurnPercentage for why the arithmetic order
    // matters at the tenth.
    return Math.round(((basePower * (100 + empowerPercentage)) / 100) * 10) / 10;
}

/**
 * Damage of a stack-powered offensive spell (SpellMultiplierType.UNIT_AMOUNT_STACK_POWER):
 *
 *     creatures alive x stack power x the spell's own damage multiplier
 *
 * The Magic Dragon's Lightning Strike, Ring of Fire and Meteor Shower use this shape. This is deliberately
 * the ONLY place the formula exists: the spellbook, AI estimate and engine cast must never disagree.
 *
 * Both inputs come off the LIVE caster, so the spell decays with the stack that carries it: a full stack
 * throws a real fireball, a nearly-dead one barely a spark. `stackPower` is clamped to the same 0..5 band
 * the rest of the engine uses (see MAX_UNIT_STACK_POWER and FightProperties.setUnitsCalculatedStacksPower)
 * so a stale or hand-built value can never inflate the damage.
 *
 * Returned pre-resistance: this is the number the card shows, before any particular target's magic
 * resistance is known. Per-target reduction is applied by applyMagicResistToSpellDamage.
 *
 * `magicDamageBonusPercentage` is the caster's additive total from Empower, its cast buff, and allied auras.
 * It multiplies the finished figure so the card, AI estimate, aim preview, and cast share one calculation.
 */
export function calculateStackPoweredSpellDamage(
    spellPower: number,
    casterAmountAlive: number,
    casterStackPower: number,
    magicDamageBonusPercentage = 0,
): number {
    const amountAlive = Math.max(0, Math.floor(casterAmountAlive));
    const stackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, Math.floor(casterStackPower)));

    return Math.max(
        0,
        Math.floor(amountAlive * stackPower * spellPower * empowerMultiplier(magicDamageBonusPercentage)),
    );
}

/**
 * The stack-powered offensive spells that are THROWN at their target, as opposed to the ones CALLED DOWN out
 * of the sky.
 *
 * A thrown spell needs a clear line to what it is aimed at — the mountain or a wall of bodies stops it. A
 * called-down one (Lightning Strike, Meteor Shower) is stopped by nothing, which is the whole point of it.
 *
 * Shared for the same reason the damage formula above is: the engine's cast gate, the client's target
 * highlight and the AI's candidate search all have to agree on which spells need the line. A preview that
 * lights up a target the engine then refuses is the same class of bug as a card promising damage the cast
 * does not deal. Keep this in step with the cast handlers in GameActionEngine.
 */
const THROWN_OFFENSIVE_SPELLS: ReadonlySet<string> = new Set(["Fire Strike", "Ring of Fire"]);

export function isThrownOffensiveSpell(spellName: string): boolean {
    return THROWN_OFFENSIVE_SPELLS.has(spellName);
}

/**
 * A damaging spell is a MAGICAL hit: it ignores armor entirely (armor only divides melee/ranged damage in
 * calculateAttackDamageMin/Max) and is instead cut down by the target's magic resistance, the same
 * proportional reduction Fire Shield uses. 100% magic resistance therefore absorbs the spell completely,
 * which matches canCastSpell refusing to target such a unit in the first place.
 */
export function applyMagicResistToSpellDamage(damage: number, targetMagicResist: number): number {
    const resist = Math.max(0, Math.min(100, targetMagicResist));

    return Math.max(0, Math.floor(damage * (1 - resist / 100)));
}

/**
 * Damage of an offensive spell, dispatched on its multiplier shape so the engine's cast, the client's card
 * and the AI's estimate all price it identically.
 *  - UNIT_AMOUNT_DAMAGE: creatures alive x power — the Battle Mage's flat-per-caster spells.
 *  - UNIT_AMOUNT_STACK_POWER: creatures alive x stack power x power — the Magic Dragon's.
 */
export function calculateSpellDamage(
    multiplierType: SpellMultiplierType,
    spellPower: number,
    casterAmountAlive: number,
    casterStackPower: number,
    magicDamageBonusPercentage = 0,
): number {
    if (multiplierType === SpellMultiplierType.UNIT_AMOUNT_DAMAGE) {
        const amountAlive = Math.max(0, Math.floor(casterAmountAlive));
        return Math.max(0, Math.floor(amountAlive * spellPower * empowerMultiplier(magicDamageBonusPercentage)));
    }
    if (multiplierType === SpellMultiplierType.UNIT_AMOUNT_STACK_POWER) {
        return calculateStackPoweredSpellDamage(
            spellPower,
            casterAmountAlive,
            casterStackPower,
            magicDamageBonusPercentage,
        );
    }
    return 0;
}

/**
 * An offensive spell's raw damage after the TARGET's own two defences: its element answers the spell first,
 * then its magic resistance cuts what is left. Split out of the engine's per-victim step so the client's
 * hover projection runs the identical arithmetic instead of a re-implementation that can drift.
 */
export function applyElementAndResistToSpellDamage(
    rawDamage: number,
    elementMultiplier: number,
    targetMagicResist: number,
): number {
    if (elementMultiplier <= 0) {
        return 0;
    }
    const scaled = elementMultiplier === 1 ? rawDamage : Math.floor(rawDamage * elementMultiplier);
    return applyMagicResistToSpellDamage(scaled, targetMagicResist);
}

/**
 * What ONE target actually takes from an offensive spell: the spell's own damage shape, then that target's
 * element and magic resistance.
 *
 * This is the whole projection in one call, and it exists because the hover preview used to hard-code the
 * UNIT_AMOUNT_STACK_POWER shape for every spell. That silently multiplied the Battle Mage's flat-per-caster
 * book (Fire Strike, Meteorite) by its stack power — up to 5x the damage the cast would really deal — while
 * the Magic Dragon's stack-powered book happened to read correctly. Dispatching here means a new spell in
 * either shape is projected right without touching the client.
 *
 * Per TARGET by construction: an AOE must call this once per caught unit, because resistances and elements
 * differ across the units under one blast even though the raw damage does not.
 */
export function offensiveSpellDamageAgainstTarget(
    multiplierType: SpellMultiplierType,
    spellPower: number,
    casterAmountAlive: number,
    casterStackPower: number,
    casterMagicDamageBonusPercentage: number,
    targetMagicResist: number,
    elementMultiplier = 1,
): number {
    return applyElementAndResistToSpellDamage(
        calculateSpellDamage(
            multiplierType,
            spellPower,
            casterAmountAlive,
            casterStackPower,
            casterMagicDamageBonusPercentage,
        ),
        elementMultiplier,
        targetMagicResist,
    );
}

/** Whether a spell's multiplier is one of the OFFENSIVE shapes calculateSpellDamage can price. */
export function isOffensiveSpellMultiplier(multiplierType: SpellMultiplierType): boolean {
    return (
        multiplierType === SpellMultiplierType.UNIT_AMOUNT_STACK_POWER ||
        multiplierType === SpellMultiplierType.UNIT_AMOUNT_DAMAGE
    );
}

/** A Fireforged Sword blade burns 50% hotter against water. */
export const FIREFORGED_SWORD_WATER_MULTIPLIER = 1.5;

/** Fire against water, wherever it comes from: the same 50% edge the enchanted blade has. */
export const FIRE_AGAINST_WATER_MULTIPLIER = FIREFORGED_SWORD_WATER_MULTIPLIER;

/**
 * How much of an elemental spell a target actually takes, before magic resistance.
 *
 * The rules are not new — they are the ones already written into the abilities: a Fire Element IS the fire
 * and cannot be burned (Fire Shield, Fire Breath, the Fireforged blade all say so), a Water Element takes
 * fire half again as hard, and a Wind Element lets lightning pass straight through (Chain Lightning skips
 * it outright). Water spells wash over a Water Element for the same reason fire cannot burn a Fire Element.
 * An elementless spell — anything not explicitly tagged in configuration — is unaffected and returns 1.
 *
 * Pure and Unit-free so the spellbook card, the hover preview, the engine and the tests all price an
 * elemental hit identically.
 */
export function elementalSpellMultiplier(params: {
    element: SpellElement;
    targetIsFireElement: boolean;
    targetIsWaterElement: boolean;
    targetIsWindElement: boolean;
    /** Compatibility with callers that already report the fourth elemental flag. */
    targetIsEarthElement?: boolean;
}): number {
    const { element, targetIsFireElement, targetIsWaterElement, targetIsWindElement } = params;
    if (element === SpellElement.FIRE) {
        if (targetIsFireElement) {
            return 0;
        }
        return targetIsWaterElement ? FIRE_AGAINST_WATER_MULTIPLIER : 1;
    }
    if (element === SpellElement.WATER) {
        return targetIsWaterElement ? 0 : 1;
    }
    if (element === SpellElement.AIR) {
        return targetIsWindElement ? 0 : 1;
    }
    return 1;
}

/** Maximum pre-resist value an elemental spell can reach against any elemental target. */
export function maximumElementalSpellDamage(rawDamage: number, element: SpellElement): number {
    const elementFlags: Array<Partial<Parameters<typeof elementalSpellMultiplier>[0]>> = [
        {},
        { targetIsFireElement: true },
        { targetIsWaterElement: true },
        { targetIsWindElement: true },
        { targetIsEarthElement: true },
    ];

    return elementFlags.reduce((most, flags) => {
        const multiplier = elementalSpellMultiplier({
            element,
            targetIsFireElement: false,
            targetIsWaterElement: false,
            targetIsWindElement: false,
            ...flags,
        });
        return Math.max(most, applyElementAndResistToSpellDamage(rawDamage, multiplier, 0));
    }, 0);
}

/**
 * The FIRE damage a Fireforged Sword rider deals on top of the swing that carried it.
 *
 * The blade is enchanted, not sharpened: the bonus is magic damage riding on a physical hit, so unlike
 * the swing itself it ignores armour and is instead cut down by the target's magic resistance — and a
 * fully magic-immune target takes none of it at all. Fire Elements (Efreet, Black Dragon) are the fire
 * itself and shrug it off completely, the same immunity Fire Breath and Fire Shield already honour;
 * water creatures take half again as much.
 *
 * Pure and Unit-free so the spellbook card, the engine and the tests all price the blade identically.
 * `swordPercentage` is the buff's power AFTER the team's Empower Augment (see fireforgedSwordPower).
 */
export function fireforgedSwordDamage(params: {
    damageDealt: number;
    swordPercentage: number;
    targetMagicResist: number;
    targetIsFireElement: boolean;
    targetIsWaterElement: boolean;
    /** Accepted for compatibility; the current fire/water rules remain authoritative. */
    targetIsWindElement?: boolean;
    targetIsEarthElement?: boolean;
}): number {
    const { damageDealt, swordPercentage, targetMagicResist, targetIsFireElement, targetIsWaterElement } = params;
    if (targetIsFireElement || targetMagicResist >= 100) {
        return 0;
    }
    if (!(damageDealt > 0) || !(swordPercentage > 0)) {
        return 0;
    }

    const burn = (damageDealt * swordPercentage) / 100;
    const scaled = targetIsWaterElement ? burn * FIREFORGED_SWORD_WATER_MULTIPLIER : burn;

    return applyMagicResistToSpellDamage(Math.floor(scaled), targetMagicResist);
}
