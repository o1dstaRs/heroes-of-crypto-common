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

export type UnitStatFractionDigits = 1 | 2;

const INTRINSIC_NUMBER = Number;
const INTRINSIC_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const INTRINSIC_TO_FIXED = Number.prototype.toFixed;
const INTRINSIC_APPLY = Reflect.apply;
const MAX_EXACT_SCALED_INTEGER = 2 ** 52;
const NEAR_GRID_SCALED_LIMIT = 2 ** 30;
const NEAR_GRID_MAX_DISTANCE = 0.25;

/**
 * Numeric equivalent of `Number(value.toFixed(fractionDigits))`.
 *
 * Unit stat refreshes repeatedly normalize values that are already exact on a
 * one- or two-decimal grid. Decimal string formatting cannot change those
 * values, so avoid it only when a safe scaled integer round-trips to the exact
 * same binary64 number. Every other value keeps the native conversion,
 * including rounding ties, subnormals, non-finite values, and the `1e21`
 * exponential-format boundary.
 *
 * The dynamic `toFixed` lookup preserves a replacement accessor/function. The
 * fast path is authorized only for the captured built-ins.
 *
 * Startup invariant: Number, Number.prototype.toFixed, Number.isSafeInteger,
 * and Reflect.apply are the realm's standard built-ins when this module is
 * evaluated. Runtime replacements after evaluation take the legacy path.
 *
 * @internal
 */
export function roundUnitStat(value: number, fractionDigits: UnitStatFractionDigits): number {
    // `Number(value.toFixed(...))` resolves Number before evaluating its
    // argument. Keep that observable order for replaced global intrinsics.
    const numberConstructor = Number;
    const toFixed = value.toFixed;
    if (
        typeof value !== "number" ||
        toFixed !== INTRINSIC_TO_FIXED ||
        numberConstructor !== INTRINSIC_NUMBER ||
        (fractionDigits !== 1 && fractionDigits !== 2)
    ) {
        return numberConstructor(INTRINSIC_APPLY(toFixed, value, [fractionDigits]));
    }

    const scale = fractionDigits === 1 ? 10 : 100;
    const scaled = value * scale;
    if (
        INTRINSIC_NUMBER_IS_SAFE_INTEGER(scaled) &&
        scaled >= -MAX_EXACT_SCALED_INTEGER &&
        scaled <= MAX_EXACT_SCALED_INTEGER &&
        scaled / scale === value
    ) {
        // Number((-0).toFixed(...)) is positive zero.
        return value === 0 ? 0 : value;
    }

    /*
     * Arithmetic that should land on the decimal grid often misses it by a few
     * binary64 ULPs. Recover only values whose scaled representation is within
     * 0.25 of an integer. At |scaled| < 2^30, multiplication rounding is less
     * than 2^-23, leaving more than 0.2499998 between an admitted value and the
     * nearest half-integer tie. The chosen integer is therefore exactly the one
     * required by toFixed. Dividing that exact int32 by 10 or 100 and parsing
     * the same decimal both correctly round the rational n / scale to binary64,
     * while all ambiguous values retain the native path.
     *
     * Adding or subtracting 0.5 and truncating through int32 implements
     * half-away-from-zero rounding inside this deliberately narrow range. A
     * negative result rounded to zero must retain the "-0.0" / "-0.00" parse
     * result; an input that is already -0 was handled by the exact-grid branch
     * above and intentionally normalizes to positive zero.
     */
    if (scaled > -NEAR_GRID_SCALED_LIMIT && scaled < NEAR_GRID_SCALED_LIMIT) {
        const nearestScaledInteger = scaled < 0 ? (scaled - 0.5) | 0 : (scaled + 0.5) | 0;
        const distance = scaled - nearestScaledInteger;
        if (distance > -NEAR_GRID_MAX_DISTANCE && distance < NEAR_GRID_MAX_DISTANCE) {
            if (nearestScaledInteger === 0) {
                return value < 0 ? -0 : 0;
            }
            return nearestScaledInteger / scale;
        }
    }

    return INTRINSIC_NUMBER(INTRINSIC_APPLY(toFixed, value, [fractionDigits]));
}
