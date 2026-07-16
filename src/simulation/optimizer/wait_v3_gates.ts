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

import {
    normalizeWaitIncumbentKind,
    type WaitIncumbentKind,
    WAIT_INCUMBENT_KINDS,
} from "../../ai/versions/wait_scorer";

export const WAIT_V3_MIN_RANGE_POSITIVE_DELTA_CAPTURE = 0.1;
export const WAIT_V3_MIN_RANGE_HELDOUT_SEEDS = 256;
export const WAIT_V3_MIN_RANGE_FIRED_SEEDS = 32;

export interface IWaitV3HeldoutObservation {
    seed: number;
    incumbentKind: string;
    isRanged: boolean;
    delta: number;
    fired: boolean;
}

export interface IWaitV3ActionBucket {
    kind: WaitIncumbentKind;
    firedRows: number;
    firedDelta: number;
}

export interface IWaitV3HeldoutGateResult {
    pass: boolean;
    reasons: string[];
    rangeRows: number;
    rangeSeeds: number;
    rangePositiveDelta: number;
    rangePositiveDeltaCaptured: number;
    rangePositiveDeltaCapture: number | null;
    rangeFiredRows: number;
    rangeFiredSeeds: number;
    rangeFiredDelta: number;
    rangeFiredMeanDelta: number | null;
    actionBuckets: IWaitV3ActionBucket[];
}

/** Evaluate only the RANGE domain V3 is initially allowed to alter. */
export function evaluateWaitV3HeldoutGates(
    observations: readonly IWaitV3HeldoutObservation[],
): IWaitV3HeldoutGateResult {
    const ranged = observations.filter((observation) => observation.isRanged);
    const rangeSeeds = new Set(ranged.map((observation) => observation.seed));
    const rangeFiredSeeds = new Set<number>();
    const buckets = new Map<WaitIncumbentKind, IWaitV3ActionBucket>(
        WAIT_INCUMBENT_KINDS.map((kind) => [kind, { kind, firedRows: 0, firedDelta: 0 }]),
    );
    let rangePositiveDelta = 0;
    let rangePositiveDeltaCaptured = 0;
    let rangeFiredRows = 0;
    let rangeFiredDelta = 0;
    for (const observation of ranged) {
        if (!Number.isFinite(observation.delta)) {
            throw new Error("Wait V3 held-out observation has a non-finite oracle delta");
        }
        const positiveDelta = Math.max(0, observation.delta);
        rangePositiveDelta += positiveDelta;
        if (!observation.fired) {
            continue;
        }
        rangePositiveDeltaCaptured += positiveDelta;
        rangeFiredRows += 1;
        rangeFiredSeeds.add(observation.seed);
        rangeFiredDelta += observation.delta;
        const bucket = buckets.get(normalizeWaitIncumbentKind(observation.incumbentKind))!;
        bucket.firedRows += 1;
        bucket.firedDelta += observation.delta;
    }

    const rangePositiveDeltaCapture = rangePositiveDelta > 0 ? rangePositiveDeltaCaptured / rangePositiveDelta : null;
    const reasons: string[] = [];
    if (!ranged.length) {
        reasons.push("held-out set has no RANGE rows");
    }
    if (rangeSeeds.size < WAIT_V3_MIN_RANGE_HELDOUT_SEEDS) {
        reasons.push(
            `held-out RANGE evidence has ${rangeSeeds.size} distinct seeds; requires at least ${WAIT_V3_MIN_RANGE_HELDOUT_SEEDS}`,
        );
    }
    if (rangeFiredSeeds.size < WAIT_V3_MIN_RANGE_FIRED_SEEDS) {
        reasons.push(
            `V3 fires in ${rangeFiredSeeds.size} held-out RANGE seeds; requires at least ${WAIT_V3_MIN_RANGE_FIRED_SEEDS}`,
        );
    }
    if (rangePositiveDeltaCapture === null) {
        reasons.push("held-out RANGE rows have no positive oracle delta to capture");
    } else if (rangePositiveDeltaCapture < WAIT_V3_MIN_RANGE_POSITIVE_DELTA_CAPTURE) {
        reasons.push(
            `RANGE positive-delta capture ${(100 * rangePositiveDeltaCapture).toFixed(2)}% is below ${(100 * WAIT_V3_MIN_RANGE_POSITIVE_DELTA_CAPTURE).toFixed(2)}%`,
        );
    }
    if (rangeFiredDelta <= 0) {
        reasons.push(`RANGE fired-row oracle delta must be positive; got ${rangeFiredDelta.toFixed(6)}`);
    }
    const actionBuckets = [...buckets.values()];
    for (const bucket of actionBuckets) {
        if (bucket.firedRows > 0 && bucket.firedDelta < 0) {
            reasons.push(
                `RANGE action bucket ${bucket.kind} has negative fired-row oracle delta ${bucket.firedDelta.toFixed(6)}`,
            );
        }
    }

    return {
        pass: reasons.length === 0,
        reasons,
        rangeRows: ranged.length,
        rangeSeeds: rangeSeeds.size,
        rangePositiveDelta,
        rangePositiveDeltaCaptured,
        rangePositiveDeltaCapture,
        rangeFiredRows,
        rangeFiredSeeds: rangeFiredSeeds.size,
        rangeFiredDelta,
        rangeFiredMeanDelta: rangeFiredRows ? rangeFiredDelta / rangeFiredRows : null,
        actionBuckets,
    };
}
