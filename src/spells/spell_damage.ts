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

import { MAX_UNIT_STACK_POWER } from "../constants";

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
 */
export function calculateStackPoweredSpellDamage(
    spellPower: number,
    casterAmountAlive: number,
    casterStackPower: number,
): number {
    const amountAlive = Math.max(0, Math.floor(casterAmountAlive));
    const stackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, Math.floor(casterStackPower)));

    return Math.max(0, Math.floor(amountAlive * stackPower * spellPower));
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
