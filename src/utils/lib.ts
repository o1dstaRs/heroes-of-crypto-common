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

import { Buffer } from "buffer";

/* -------------------------------------------------------------------------- */
/*                               Secure randomness                            */
/* -------------------------------------------------------------------------- */

interface CryptoLike {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function getWebCrypto(): CryptoLike | undefined {
    // Narrow without `any`
    const g = globalThis as unknown as { crypto?: CryptoLike };
    return g.crypto && typeof g.crypto.getRandomValues === "function" ? g.crypto : undefined;
}

/**
 * Secure uniform integer in [min, max) using Web Crypto when available.
 * - Exclusive of max (matches Node's crypto.randomInt).
 * - Uses rejection sampling (no modulo bias).
 * - Falls back to Math.random only if crypto is unavailable.
 * - Supports full safe JS ranges (≤ 2^53 - 1).
 */
export function getRandomInt(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("min/max must be finite numbers");
    if (!Number.isInteger(min) || !Number.isInteger(max)) throw new Error("min/max must be integers");
    if (max < min) throw new Error("max must be >= min");
    if (max === min) return min;

    const spanBig = BigInt(max) - BigInt(min); // > 0
    const TWO53 = 1n << 53n;

    const c = getWebCrypto();
    if (c) {
        // Rejection sample 53-bit values to avoid bias
        const limit = (TWO53 / spanBig) * spanBig; // largest multiple of span below 2^53
        for (;;) {
            const u32 = new Uint32Array(2);
            c.getRandomValues(u32);
            const hi = BigInt(u32[0] & 0x001fffff); // 21 bits
            const lo = BigInt(u32[1]); // 32 bits
            const rnd53 = (hi << 32n) | lo; // 53-bit integer in [0, 2^53)
            if (rnd53 < limit) {
                return Number(rnd53 % spanBig) + min;
            }
        }
    }

    // Explicit, allowed fallback (non-crypto): still unbiased via float range
    const span = max - min;
    return Math.floor(Math.random() * span) + min;
}

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

export function shuffle<T>(array: T[]): T[] {
    // Fisher–Yates with secure getRandomInt
    for (let i = array.length - 1; i > 0; i--) {
        const j = getRandomInt(0, i + 1); // j ∈ [0, i]
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

export function matrixElement(matrix: number[][], x: number, y: number): number {
    return matrix[y]?.[x] ?? 0;
}

export function stringToBoolean(str: string | null | undefined): boolean {
    if (str == null) return false;
    const s = String(str).toLowerCase();
    return s === "true" || s === "1";
}

export function removeItemOnce<T>(arr: T[], value: T): boolean {
    const index = arr.indexOf(value);
    if (index > -1) {
        arr.splice(index, 1);
        return true;
    }
    return false;
}

export function isBrowser(): boolean {
    return typeof window !== "undefined" && typeof document !== "undefined";
}

interface HrtimeLike {
    bigint?: () => bigint;
}
interface ProcessLike {
    hrtime?: HrtimeLike;
}

export function getTimeMillis(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    const p = (globalThis as unknown as { process?: ProcessLike }).process;
    if (p?.hrtime?.bigint) {
        const ns = p.hrtime.bigint(); // bigint nanoseconds
        return Number(ns / 1_000_000n);
    }
    return Date.now();
}

export function interval(func: () => void | Promise<void>, timeoutMillis: number): void {
    const run = async () => {
        await func();
    };
    (isBrowser() ? window.setInterval : setInterval)(run, timeoutMillis);
}

export function uuidToUint8Array(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, "");
    if (hex.length !== 32) throw new Error("Invalid UUID format");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

export const uuidFromBytes = (buffer: Uint8Array): string => {
    if (buffer.length !== 16) throw new Error("Buffer must be 16 bytes long");
    const hex = Array.from(buffer, (b) => b.toString(16).padStart(2, "0"));
    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
    ].join("-");
};

/**
 * Convert a Base64-encoded string to a Uint8Array (browser/Bun/Node).
 */
export const base64ToUint8Array = (base64: string): Uint8Array => {
    const buffer = Buffer.from(base64, "base64");
    return new Uint8Array(buffer);
};

export class RefNumber {
    public value: number;
    public constructor(initialValue: number) {
        this.value = initialValue;
    }
    public getValue(): number {
        return this.value;
    }
    public increment(by: number = 1): void {
        this.value += by;
    }
    public decrement(by: number = 1): void {
        this.value -= by;
    }
    public reset(newValue: number): void {
        this.value = newValue;
    }
}

export const getLapString = (laps: number): string => (laps === 1 ? "1 lap" : `${laps} laps`);
