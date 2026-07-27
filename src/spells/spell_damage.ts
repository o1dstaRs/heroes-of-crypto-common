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
 * The Battle Mage's Fire Strike and Meteorite are the first spells to deal damage rather than apply an
 * effect, and both read their number from here. This is deliberately the ONLY place the formula exists: the
 * spellbook prints the finished number on the card (RenderableSpell.getHoverInfo) and the engine deals it
 * (ActionEngine.fireStrikeCast / meteoriteCast), and the two must never be able to disagree — a card that
 * promises 152 and a cast that lands 91 is worse than no preview at all.
 *
 * Both inputs come off the LIVE caster, so the spell decays with the stack that carries it: a full stack
 * throws a real fireball, a nearly-dead one barely a spark. `stackPower` is clamped to the same 0..5 band
 * the rest of the engine uses (see MAX_UNIT_STACK_POWER and FightProperties.setUnitsCalculatedStacksPower)
 * so a stale or hand-built value can never inflate the damage.
 *
 * Returned pre-resistance: this is the number the card shows, before any particular target's magic
 * resistance is known. Per-target reduction is applied by applyMagicResistToSpellDamage.
 *
 * `empowerPercentage` is the caster team's Empower Augment (0 when unbought) — it multiplies the finished
 * figure, so the card and the cast pick it up together from this one place.
 */
export function calculateStackPoweredSpellDamage(
    spellPower: number,
    casterAmountAlive: number,
    casterStackPower: number,
    empowerPercentage = 0,
): number {
    const amountAlive = Math.max(0, Math.floor(casterAmountAlive));
    const stackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, Math.floor(casterStackPower)));

    return Math.max(0, Math.floor(amountAlive * stackPower * spellPower * empowerMultiplier(empowerPercentage)));
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
