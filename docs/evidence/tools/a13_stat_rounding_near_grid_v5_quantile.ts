/**
 * Shared Type-7 quantile interpolation for the sealed A13 near-grid campaign.
 *
 * Both the micro producer and the aggregate verifier import this exact helper.
 * Keeping the floating-point operation order in one file prevents the
 * algebraically equivalent, one-ULP producer/verifier split that invalidated
 * the predecessor v2 aggregation attempt.
 */

export const TYPE7_QUANTILE_SCHEMA = "heroes-of-crypto/a13-stat-rounding-near-grid-type7-quantile/v2" as const;

const ONE_ULP_FIXTURE = Object.freeze({
    probability: 0.025,
    lower: 0.200000005,
    upper: 0.2000000056,
    expected: 0.20000000501499998,
    expectedBitsHex: "3fc99999a45ea01a",
});

function float64BitsHex(value: number): string {
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat64(0, value, false);
    return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

/**
 * R Type-7 quantile using the campaign's single frozen interpolation order.
 *
 * Values must be finite. Callers may impose stricter domain requirements
 * (all campaign timing ratios are additionally required to be positive).
 */
export function type7Quantile(values: readonly number[], probability: number): number {
    if (
        values.length === 0 ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1 ||
        values.some((value) => !Number.isFinite(value))
    ) {
        throw new Error("Type-7 quantile requires a non-empty finite sample and probability in [0,1]");
    }
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;

    // This operation order is evidence-governed. Do not algebraically rewrite.
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function auditType7Quantile(): {
    schema: typeof TYPE7_QUANTILE_SCHEMA;
    oneUlpFixture: typeof ONE_ULP_FIXTURE;
    endpointAndEqualNeighborChecks: true;
    invalidInputChecks: readonly string[];
    passed: true;
} {
    const observed = type7Quantile([ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.upper], ONE_ULP_FIXTURE.probability);
    if (
        !Object.is(observed, ONE_ULP_FIXTURE.expected) ||
        float64BitsHex(observed) !== ONE_ULP_FIXTURE.expectedBitsHex
    ) {
        throw new Error(`Shared Type-7 one-ULP fixture drifted: value=${observed} bits=${float64BitsHex(observed)}`);
    }
    if (
        !Object.is(type7Quantile([ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.upper], 0), ONE_ULP_FIXTURE.lower) ||
        !Object.is(type7Quantile([ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.upper], 1), ONE_ULP_FIXTURE.upper) ||
        !Object.is(type7Quantile([ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.lower], 0.375), ONE_ULP_FIXTURE.lower)
    ) {
        throw new Error("Shared Type-7 endpoint/equal-neighbor fixture drifted");
    }

    const invalidInputs = [
        { label: "empty", values: [] as number[], probability: 0.5 },
        { label: "nonfinite-value", values: [ONE_ULP_FIXTURE.lower, Number.NaN], probability: 0.5 },
        {
            label: "nonfinite-probability",
            values: [ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.upper],
            probability: Number.NaN,
        },
        {
            label: "negative-probability",
            values: [ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.upper],
            probability: -0.01,
        },
        {
            label: "probability-above-one",
            values: [ONE_ULP_FIXTURE.lower, ONE_ULP_FIXTURE.upper],
            probability: 1.01,
        },
    ];
    for (const input of invalidInputs) {
        let rejected = false;
        try {
            type7Quantile(input.values, input.probability);
        } catch {
            rejected = true;
        }
        if (!rejected) throw new Error(`Shared Type-7 helper accepted invalid fixture: ${input.label}`);
    }

    return {
        schema: TYPE7_QUANTILE_SCHEMA,
        oneUlpFixture: ONE_ULP_FIXTURE,
        endpointAndEqualNeighborChecks: true,
        invalidInputChecks: invalidInputs.map((input) => input.label),
        passed: true,
    };
}
