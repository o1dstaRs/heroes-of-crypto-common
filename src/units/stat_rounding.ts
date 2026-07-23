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

    return INTRINSIC_NUMBER(INTRINSIC_APPLY(toFixed, value, [fractionDigits]));
}
