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

/**
 * Craft's outcome odds, kept in their own module because BOTH the roll and the printed card need them and
 * they must never drift apart.
 *
 * It lives here rather than in craft_ability because config_provider builds the ability cards and
 * craft_ability constructs an EffectFactory at module scope — importing it from the config layer would close
 * the loop config_provider -> craft_ability -> effect_factory -> config_provider at module-init time. This
 * function depends on nothing at all, so both sides can reach it safely.
 */
export interface ICraftChances {
    /** Percent chances (0-100); always sum to 100. */
    stun: number;
    nothing: number;
    double: number;
    frozen: number;
}

/**
 * The luck-weighted Craft outcome percentages for a caster's luck. Luck shifts probability 1:1 from the bad
 * Stun outcome to the good Frozen outcome (each clamped to 0-20); Nothing and Double stay at 40. Sums to 100.
 * Single source of truth for both the rolls (processCraftAbility) and the ability/spell descriptions.
 */
export function getCraftChances(luck: number): ICraftChances {
    const stun = Math.max(0, Math.min(20, 10 - luck));
    return { stun, nothing: 40, double: 40, frozen: 20 - stun };
}
