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

export interface IRidgeModel {
    b: number;
    w: number[];
}

function dot(left: readonly number[], right: readonly number[]): number {
    let value = 0;
    for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
    return value;
}

/** Deterministic Jacobi-preconditioned conjugate-gradient solve of the ridge normal equations. */
export function fitStableRidge<T>(
    rows: readonly T[],
    dimensions: number,
    featuresOf: (row: T) => readonly number[],
    targetOf: (row: T) => number,
    maximumIterations: number,
    l2: number,
    relativeTolerance = 1e-8,
): IRidgeModel {
    if (!rows.length) throw new Error("Ridge regression requires at least one row");
    if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error("Ridge dimensions must be positive");
    if (!Number.isInteger(maximumIterations) || maximumIterations <= 0) {
        throw new Error("Ridge maximum iterations must be a positive integer");
    }
    if (!Number.isFinite(l2) || l2 < 0) throw new Error("Ridge L2 must be finite and nonnegative");
    if (!Number.isFinite(relativeTolerance) || relativeTolerance <= 0 || relativeTolerance >= 1) {
        throw new Error("Ridge relative tolerance must be in (0, 1)");
    }

    const systemDimensions = dimensions + 1;
    const rightHandSide = new Array<number>(systemDimensions).fill(0);
    const diagonal = new Array<number>(systemDimensions).fill(0);
    const prepared = rows.map((row, rowIndex) => {
        const features = featuresOf(row);
        if (features.length !== dimensions) {
            throw new Error(`Ridge row ${rowIndex} has ${features.length} features; expected ${dimensions}`);
        }
        const target = targetOf(row);
        if (!Number.isFinite(target)) throw new Error(`Ridge row ${rowIndex} has a non-finite target`);
        rightHandSide[0] += target;
        diagonal[0] += 1;
        for (let index = 0; index < dimensions; index += 1) {
            const feature = features[index];
            if (!Number.isFinite(feature)) throw new Error(`Ridge row ${rowIndex} has a non-finite feature`);
            rightHandSide[index + 1] += target * feature;
            diagonal[index + 1] += feature * feature;
        }
        if (
            rightHandSide.some((value) => !Number.isFinite(value)) ||
            diagonal.some((value) => !Number.isFinite(value))
        ) {
            throw new Error(`Ridge row ${rowIndex} overflowed the normal equations`);
        }
        return { features };
    });

    const inverseRows = 1 / prepared.length;
    for (let index = 0; index < systemDimensions; index += 1) {
        rightHandSide[index] *= inverseRows;
        diagonal[index] = diagonal[index] * inverseRows + (index === 0 ? 0 : l2);
    }
    const multiplyNormalMatrix = (vector: readonly number[]): number[] => {
        const result = new Array<number>(systemDimensions).fill(0);
        for (const { features } of prepared) {
            let prediction = vector[0];
            for (let index = 0; index < dimensions; index += 1) {
                prediction += vector[index + 1] * features[index];
            }
            result[0] += prediction;
            for (let index = 0; index < dimensions; index += 1) {
                result[index + 1] += prediction * features[index];
            }
        }
        result[0] *= inverseRows;
        for (let index = 1; index < systemDimensions; index += 1) {
            result[index] = result[index] * inverseRows + l2 * vector[index];
        }
        if (result.some((value) => !Number.isFinite(value))) {
            throw new Error("Ridge normal-matrix product became non-finite");
        }
        return result;
    };
    const precondition = (residual: readonly number[]): number[] =>
        residual.map((value, index) => (diagonal[index] > 0 ? value / diagonal[index] : 0));

    const solution = new Array<number>(systemDimensions).fill(0);
    let residual = [...rightHandSide];
    let preconditionedResidual = precondition(residual);
    let direction = [...preconditionedResidual];
    let residualDotPreconditioned = dot(residual, preconditionedResidual);
    const rightHandSideSquaredNorm = dot(rightHandSide, rightHandSide);
    if (!Number.isFinite(rightHandSideSquaredNorm)) throw new Error("Ridge normal-equation norm is non-finite");
    const rightHandSideNorm = Math.sqrt(rightHandSideSquaredNorm);
    if (rightHandSideNorm === 0) {
        return { b: 0, w: new Array<number>(dimensions).fill(0) };
    }
    const tolerance = relativeTolerance * rightHandSideNorm;

    for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
        const normalDirection = multiplyNormalMatrix(direction);
        const curvature = dot(direction, normalDirection);
        if (!Number.isFinite(curvature) || curvature <= 0) {
            throw new Error(`Ridge conjugate-gradient curvature is not positive at iteration ${iteration + 1}`);
        }
        const alpha = residualDotPreconditioned / curvature;
        for (let index = 0; index < systemDimensions; index += 1) {
            solution[index] += alpha * direction[index];
            residual[index] -= alpha * normalDirection[index];
        }
        if (solution.some((value) => !Number.isFinite(value)) || residual.some((value) => !Number.isFinite(value))) {
            throw new Error(`Ridge conjugate-gradient state became non-finite at iteration ${iteration + 1}`);
        }
        if (Math.sqrt(dot(residual, residual)) <= tolerance) {
            return { b: solution[0], w: solution.slice(1) };
        }
        preconditionedResidual = precondition(residual);
        const nextResidualDotPreconditioned = dot(residual, preconditionedResidual);
        if (!Number.isFinite(nextResidualDotPreconditioned) || nextResidualDotPreconditioned <= 0) {
            throw new Error(`Ridge conjugate-gradient residual stalled at iteration ${iteration + 1}`);
        }
        const beta = nextResidualDotPreconditioned / residualDotPreconditioned;
        direction = preconditionedResidual.map((value, index) => value + beta * direction[index]);
        residualDotPreconditioned = nextResidualDotPreconditioned;
    }
    throw new Error(`Ridge conjugate-gradient solve did not converge in ${maximumIterations} iterations`);
}
