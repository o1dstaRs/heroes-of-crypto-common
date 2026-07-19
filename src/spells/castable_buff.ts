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

    const amplifiedPower = Number((sourcePower * (1 + tome.getPower() / 100)).toFixed(4));
    const amplified = new Spell({
        spellProperties: spell.getSpellProperties(),
        amount: spell.getAmount(),
    });
    amplified.setPower(amplifiedPower);

    const sourceText = formatPower(sourcePower);
    const amplifiedText = formatPower(amplifiedPower);
    const sourcePattern = new RegExp(`\\b${sourceText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const descriptions = spell.getDesc();
    amplified.setDesc(
        descriptions.map((description, index) =>
            index === descriptions.length - 1 ? description : description.replace(sourcePattern, amplifiedText),
        ),
    );

    return amplified;
}
