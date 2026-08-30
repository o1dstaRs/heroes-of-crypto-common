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

import type { Unit } from "../units/unit";
import { projectMagicMirrorDamage, type IMagicMirrorDamageProjection } from "./magic_mirror_damage";
import type { Spell } from "./spell";
import {
    applyElementAndResistToSpellDamage,
    calculateSpellDamage,
    elementalSpellMultiplier,
    getSpellMoraleMultiplier,
} from "./spell_damage";
import { getMagicMirrorAbilityShare, getMagicMirrorPower } from "./spell_helper";

/**
 * THE single source of truth for "what will this spell actually do to that creature".
 *
 * spell_damage.ts prices a spell as arithmetic (head-count, stack power, element, resistance) and stays
 * deliberately free of any unit type. This module is the other half: the parts of the answer that can only be
 * read off a LIVE unit — its element abilities, its Water Shield, its stack's hit points, and the Magic
 * Reflection passive that sends a share of the hit straight back at the caster.
 *
 * GameActionEngine's cast path resolves through exactly these functions, so a preview built on them cannot
 * drift from the cast: there is one element step, one resistance step, one absorb rule and one rebound
 * formula, and both the hover and the engine call them.
 */

/** What one spell hit does to one creature. */
export interface ISpellDamageProjection {
    /**
     * Damage after the victim's element and magic resistance — the number the engine hands to
     * Unit.applyDamage, and the number a Magic Mirror reflects a share of. NOT what the stack loses: an
     * intact Water Shield eats this whole and still counts as a full hit for the rebound.
     */
    landed: number;
    /** What the victim's stack actually loses: `landed`, or 0 when a Water Shield absorbs the hit. */
    damage: number;
    /** Creatures of the victim's stack that `damage` kills. */
    kills: number;
    /** True when an intact Water Shield swallows the whole hit (and breaks doing it). */
    absorbedByWaterShield: boolean;
}

/** A rebound is the same projection, plus the share of the holder's landed damage it returns. */
export type ISpellReboundProjection = IMagicMirrorDamageProjection;

export interface ISpellDamageProjectionInput {
    spell: Spell;
    caster: Unit;
    target: Unit;
    /**
     * Pre-target damage to price. Defaults to {@link spellRawDamage} off the live caster, which is what every
     * cast handler does; pass it explicitly only when a tail has already reduced it (a mirror's share).
     */
    rawDamage?: number;
}

/**
 * How much of an elemental spell `unit` takes, before its magic resistance: 0 against the element it IS,
 * half again as much against the element it is COUNTERED by, unchanged for the rest of the book.
 */
export function spellElementMultiplierAgainst(spell: Spell, unit: Unit): number {
    return elementalSpellMultiplier({
        element: spell.getElement(),
        targetIsFireElement: unit.hasAbilityActive("Fire Element"),
        targetIsWaterElement: unit.hasAbilityActive("Water Element"),
        targetIsWindElement: unit.hasAbilityActive("Wind Element"),
        targetIsEarthElement: unit.hasAbilityActive("Earth Element"),
    });
}

/**
 * What `rawDamage` of `spell` does to `unit`: its element answers first, its magic resistance second.
 *
 * This IS the engine's per-victim step (GameActionEngine.elementalDamageAgainst is a call to it), which is
 * why a preview may use it without asking whether the two still agree.
 */
export function spellDamageAgainstUnit(spell: Spell, rawDamage: number, unit: Unit): number {
    return applyElementAndResistToSpellDamage(
        rawDamage,
        spellElementMultiplierAgainst(spell, unit),
        unit.getMagicResist(),
    );
}

/**
 * The spell's own damage off the LIVE caster, before any target is known — the figure every cast handler
 * computes and the spellbook card prints.
 */
export function spellRawDamage(spell: Spell, caster: Unit): number {
    return calculateSpellDamage(
        spell.getMultiplierType(),
        spell.getPower(),
        caster.getAmountAlive(),
        caster.getStackPower(),
        caster.getMagicDamageBonusPercentage(),
        getSpellMoraleMultiplier(spell.getName(), caster.getAttackMultiplier()),
    );
}

/**
 * Project ONE spell hit on ONE creature, all the way to the creatures it kills.
 *
 * Per target by construction — element, resistance, Water Shield and hit points all differ across the units
 * under a single blast — so an AOE calls this once per unit it catches.
 *
 * The Water Shield step is the one the hover used to miss entirely: Unit.applyDamage short-circuits on
 * willWaterShieldAbsorb and deals literally nothing, so a preview that skipped it promised a full hit and a
 * pile of kills for a cast that took the target's stack from full to full. Fire ignores the shield (a Fire
 * Element caster passes straight through it without even breaking it), and the shield is only consulted at
 * all once there is damage to absorb, exactly as applyDamage orders those two checks.
 *
 * `kills` is what `damage` costs the stack. Overkill is deliberately NOT trimmed to the stack's remaining hit
 * points: the number quoted is the hit the spell lands, and the kill count already says the stack dies.
 */
export function projectSpellDamageAgainstUnit({
    spell,
    caster,
    target,
    rawDamage,
}: ISpellDamageProjectionInput): ISpellDamageProjection {
    const landed = spellDamageAgainstUnit(spell, rawDamage ?? spellRawDamage(spell, caster), target);
    const absorbedByWaterShield = landed > 0 && target.willWaterShieldAbsorb(caster);
    const damage = absorbedByWaterShield ? 0 : landed;

    return {
        landed,
        damage,
        kills: damage > 0 ? target.calculatePossibleLosses(damage) : 0,
        absorbedByWaterShield,
    };
}

/**
 * What a Magic Mirror holder sends BACK at the caster, or undefined when it cannot reflect damage.
 *
 * A rebound is an EXTRA hit, not a redirection: the holder still takes the spell in full, and the caster then
 * takes the mirror's own share of what LANDED on the holder (pre-absorb — a shield that ate the hit does not
 * spare the caster), cut down by the caster's own element and magic resistance. The spell buffs return their
 * share every time; the Magic Reflection passive rolls separately before the engine calls this projection.
 *
 * The caster is never asked to rebound a spell onto itself, so a mirror-carrying caster caught in its own
 * blast cannot loop.
 */
export function projectSpellRebound(input: {
    spell: Spell;
    caster: Unit;
    /** The unit that would reflect — the one the spell landed on. */
    holder: Unit;
    /** Damage that landed on the holder, i.e. {@link ISpellDamageProjection.landed}. */
    landedOnHolder: number;
    /** A share already resolved by the engine. Omit when projecting the strongest advertised mirror. */
    reflectionPercent?: number;
}): ISpellReboundProjection | undefined {
    const { spell, caster, holder, landedOnHolder } = input;
    if (holder.getId() === caster.getId()) {
        return undefined;
    }
    const reflectionPercent =
        input.reflectionPercent ?? Math.max(getMagicMirrorPower(holder), getMagicMirrorAbilityShare(holder));
    if (reflectionPercent <= 0) {
        return undefined;
    }

    return projectMagicMirrorDamage({
        attacker: caster,
        holder,
        landedOnHolder,
        element: spell.getElement(),
        reflectionPercent,
    });
}
