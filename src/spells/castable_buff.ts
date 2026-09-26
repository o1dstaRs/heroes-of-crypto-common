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
import { Spell } from "./spell";
import { SpellPowerType } from "./spell_properties";

const formatPower = (power: number): string => String(Number(power.toFixed(4)));

/**
 * Rewrite a cast buff's lines so a literal base power reads as the amplified one.
 *
 * The last line is the duration ("Lasts N laps") and is left alone, so a power of 3 cannot turn the
 * duration into the amplified number. Placeholders are not touched: the caller fills `{}` afterwards
 * with whatever number that spell actually prints.
 */
export function rewriteCastBuffPowerText(
    descriptions: readonly string[],
    sourcePower: number,
    amplifiedPower: number,
): string[] {
    const sourceText = formatPower(sourcePower);
    const amplifiedText = formatPower(amplifiedPower);
    if (sourceText === amplifiedText) {
        return descriptions.slice();
    }
    const sourcePattern = new RegExp(`\\b${sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    return descriptions.map((description, index) =>
        index === descriptions.length - 1 ? description : description.replace(sourcePattern, amplifiedText),
    );
}

/**
 * A cast buff's power after Tome of Amplification.
 *
 * 50% on a Fireforged Sword's 20 is 30. A missing or non-positive tome leaves the power alone.
 * Healing and resurrection never call this: the tome does not strengthen them.
 */
export function tomeAmplifiedBuffPower(basePower: number, tomePercent: number): number {
    if (!Number.isFinite(basePower) || basePower === 0) {
        return basePower;
    }
    if (!Number.isFinite(tomePercent) || tomePercent <= 0) {
        return basePower;
    }
    return Number((basePower * (1 + tomePercent / 100)).toFixed(4));
}

/**
 * Return the positive buff that should be applied for this concrete unit cast.
 *
 * Tome belongs to the caster's army, and only strengthens non-healing buffs the
 * caster applies to a friendly recipient. The source spell is never mutated:
 * mass casts reuse it for several recipients, and mutating it would amplify each
 * subsequent target again. System effects that are not cast by a unit never call
 * this helper, so artifacts, augments, auras, and passive buffs stay unchanged.
 */
export function amplifyCastBuffForTarget(spell: Spell, caster: Unit, target: Unit): Spell {
    if (
        !spell.isBuff() ||
        target.getTeam() !== caster.getTeam() ||
        spell.getPowerType() === SpellPowerType.HEAL ||
        spell.getPowerType() === SpellPowerType.RESURRECT
    ) {
        return spell;
    }

    const tome = caster.getBuff("Tome of Amplification");
    const sourcePower = spell.getPower();
    if (!tome || sourcePower === 0) {
        return spell;
    }

    const amplifiedPower = tomeAmplifiedBuffPower(sourcePower, tome.getPower());
    const amplified = new Spell({
        spellProperties: spell.getSpellProperties(),
        amount: spell.getAmount(),
    });
    amplified.setPower(amplifiedPower);
    amplified.setDesc(rewriteCastBuffPowerText(spell.getDesc(), sourcePower, amplifiedPower));

    return amplified;
}
