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

export const MAGIC_REFLECTION_ABILITY_NAME = "Magic Reflection";

/**
 * The Magic Dragon's passive rebound chance, as a percentage in 0..100.
 *
 * STACK-POWERED, like the game's other scaling percentages: the configured power is what a FULL stack
 * rebounds and a depleted one rebounds proportionally less — 15/30/45/60/75 across the five tiers at
 * power 75 — then the holder's luck shifts it, the way luck shifts every other chance in the game.
 *
 * Deliberately free of any Unit import (see spell_damage.ts for the same discipline): the engine calls it
 * through SpellHelper with a live Unit, while the client's ranked scene has nothing but a protobuf
 * snapshot and still has to print the identical number. A card that advertises 75% while the dragon
 * rebounds at 30% is worse than no card at all.
 */
export function magicReflectionPercent(basePower: number, stackPower: number, luck: number): number {
    const clampedStackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, stackPower));
    const scaled = (basePower / MAX_UNIT_STACK_POWER) * clampedStackPower + luck;

    return Math.max(0, Math.min(100, Math.floor(scaled)));
}

/** Fill a raw Magic Reflection description template's {} with the chance the stack currently rebounds at. */
export function magicReflectionDescription(
    descriptionTemplate: string,
    basePower: number,
    stackPower: number,
    luck: number,
): string {
    return descriptionTemplate.replace(/\{\}/g, magicReflectionPercent(basePower, stackPower, luck).toString());
}
