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

import { createHash } from "node:crypto";

function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
}

/**
 * SHA-256 of a value's canonical JSON (object keys sorted, no whitespace): the fingerprint the locked doctrine draft
 * checkpoint and the locked setup research checkpoints pin. It is the former v0.9 protocol's fingerprintV09, byte for
 * byte, kept when v0.9 was removed (2026-11-26).
 */
export function canonicalJsonSha256(value: unknown): string {
    return createHash("sha256").update(canonical(value)).digest("hex");
}
