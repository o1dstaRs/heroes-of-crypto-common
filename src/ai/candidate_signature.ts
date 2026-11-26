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

import type { GameAction } from "../engine/actions";

const canonicalValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .filter((key) => record[key] !== undefined)
            .map((key) => [key, canonicalValue(record[key])]),
    );
};

/**
 * Stable signature of a decision's actions (keys sorted, undefined dropped) for attribution and deterministic tie
 * diagnostics. The former v0.9 strategy's v09CandidateSignature, byte for byte (v0.9 was removed on 2026-11-26).
 */
export const candidateSignature = (actions: readonly GameAction[]): string =>
    JSON.stringify(canonicalValue(actions)) ?? "[]";
