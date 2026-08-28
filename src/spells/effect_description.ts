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

const PLACEHOLDER = /\{\}/g;

/** A power as it should read in a tooltip: 25 stays "25", an amplified 1.5 stays "1.5". */
export const formatEffectPower = (power: number): string => String(Number(power.toFixed(4)));

/**
 * Fill the `{}` placeholders in an applied buff/debuff's tooltip body with the effect's own power.
 *
 * A stored description is `text;firstProperty;secondProperty`, and the client fills the text's
 * placeholders from those properties in order. Callers that HAVE such properties (the augments, the
 * artifact buffs, Battle Roar, an Armor Rune's running total) pass them, and the augments additionally
 * substitute their own text before applying — so those paths are already correct and must be left alone.
 *
 * Every spell CAST is the gap: massCastOnAllies/massCastOnFlyers and the single-target cast all apply the
 * buff with no properties at all, so nothing ever replaced their placeholders and the player read a
 * literal "Reflects {}% of consumed magical damage back to attacker" (owner report 2026-08-28). The
 * missing number is in every case the effect's own power — Magic Mirror reflects its power as a share and
 * mirrors a debuff on a roll against that same power (see isMirrored), Empower adds its power to magic
 * damage, Fireforged Sword burns for its power. So fill it here, at the one place that knows the power,
 * rather than at each cast site.
 *
 * Placeholders the caller fills positionally are skipped, so a caller supplying properties keeps them.
 *
 * @param positionalPropertyCount how many placeholders the caller's own properties will consume.
 */
export const fillEffectPowerPlaceholders = (body: string, power: number, positionalPropertyCount: number): string => {
    // A zero/unknown power is left alone: "0%" would be a worse tooltip than the untouched template, and
    // the effects that legitimately carry no power of their own already substitute their text upstream.
    if (!Number.isFinite(power) || power <= 0) {
        return body;
    }

    const text = formatEffectPower(power);
    let seen = 0;
    return body.replace(PLACEHOLDER, (match) => (seen++ < positionalPropertyCount ? match : text));
};

/** How many placeholders the caller's own spell properties will consume. */
export const positionalPropertyCount = (...properties: (number | undefined)[]): number =>
    properties.filter((property) => property !== undefined).length;
