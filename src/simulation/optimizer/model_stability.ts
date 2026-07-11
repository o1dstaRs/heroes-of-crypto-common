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
 * Phase-B features are normalized or small capped counts, and deployed weights are order-one. A
 * coefficient above one million is already six orders beyond that scale and produces a saturated,
 * numerically uninformative policy while leaving ample headroom for experimental fits.
 */
export const MAX_PHASE_B_MODEL_COEFFICIENT = 1_000_000;

export interface IPhaseBLinearModel {
    b: number;
    w: readonly number[];
}

export function phaseBModelStabilityIssue(
    label: string,
    model: IPhaseBLinearModel,
    maxMagnitude = MAX_PHASE_B_MODEL_COEFFICIENT,
): string | null {
    if (!Number.isFinite(maxMagnitude) || maxMagnitude <= 0) {
        throw new Error("Phase-B model coefficient limit must be finite and positive");
    }
    const coefficients = [model.b, ...model.w];
    const invalidIndex = coefficients.findIndex((coefficient) => !Number.isFinite(coefficient));
    if (invalidIndex >= 0) {
        const name = invalidIndex === 0 ? "bias" : `weight ${invalidIndex - 1}`;
        return `${label} produced a non-finite ${name}`;
    }
    const largestMagnitude = coefficients.reduce((largest, coefficient) => Math.max(largest, Math.abs(coefficient)), 0);
    if (largestMagnitude > maxMagnitude) {
        return `${label} coefficient magnitude ${largestMagnitude.toExponential(3)} exceeds ${maxMagnitude.toExponential(3)}`;
    }
    return null;
}
