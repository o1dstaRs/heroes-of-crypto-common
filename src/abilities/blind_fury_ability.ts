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

export const BLIND_FURY_ABILITY_NAME = "Blind Fury";

/**
 * Blind Fury's live bonus: the share of the stack that has already fallen, as a percentage.
 *
 * The ability's configured `power` is 0 — the number is entirely a function of casualties — so every place
 * that prints it has to compute it, and they all have to compute it the same way. Unit.adjustBaseStats
 * turns this exact share into attack_mod, and both the sandbox card and the ranked card render it through
 * blindFuryDescription below. Keeping the expression in one function is what stops the card from promising
 * a bonus the attack does not deal.
 *
 * Deliberately free of any Unit import (see spell_damage.ts for the same discipline): the client's ranked
 * scene builds its cards from a protobuf snapshot with no Unit in sight, and it has to be able to call this.
 */
export function blindFuryPercent(amountAlive: number, amountDied: number): number {
    const alive = Math.max(0, amountAlive);
    const died = Math.max(0, amountDied);
    const total = alive + died;

    return total > 0 ? (1 - alive / total) * 100 : 0;
}

/** Fill a raw Blind Fury description template's {} with the bonus the stack is currently getting. */
export function blindFuryDescription(descriptionTemplate: string, amountAlive: number, amountDied: number): string {
    return descriptionTemplate.replace(/\{\}/g, blindFuryPercent(amountAlive, amountDied).toFixed(1));
}
