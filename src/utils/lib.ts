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
    randomUUID?: () => string;
}

function getWebCrypto(): CryptoLike | undefined {
    // Narrow without `any`
    const g = globalThis as unknown as { crypto?: CryptoLike };
    return g.crypto && typeof g.crypto.getRandomValues === "function" ? g.crypto : undefined;
}

export function getSecureRandomValues<T extends ArrayBufferView>(array: T): T {
    const c = getWebCrypto();
    if (!c) {
        throw new Error("Crypto-secure random values are unavailable in this runtime");
    }
    return c.getRandomValues(array);
}

/* -------------------------------------------------------------------------- */
/*                       Deterministic source (test/sim ONLY)                 */
/* -------------------------------------------------------------------------- */

/**
 * A pluggable source of raw randomness consumed by {@link getRandomInt}. It returns a uniform float in
 * [0, 1). The DEFAULT is crypto-secure (`crypto.getRandomValues`) and is the ONLY path real games ever
 * take — production code never installs an override, so live, real-money matches always use unpredictable
 * crypto randomness that fails closed.
 *
 * The simulation/optimizer harness (and unit tests) may install a SEEDED override via
 * {@link setDeterministicRandomSource} so a run reproduces exactly from one seed. This makes AI-vs-AI
 * measurements a paired, zero-variance comparison (same scenarios for both versions) — never use it in a
 * code path that decides a real match outcome.
 */
export type RandomSource = () => number;
let deterministicSource: RandomSource | undefined;

/** Install (or clear, with `undefined`) a seeded randomness source. Simulation/tests only — see above. */
export function setDeterministicRandomSource(source: RandomSource | undefined): void {
    deterministicSource = source;
}

/** Whether a seeded source is currently installed (true only inside a simulation/test scope). */
export function isDeterministicRandomActive(): boolean {
    return deterministicSource !== undefined;
}

/**
 * The currently installed seeded source (or undefined). Simulation-only: the 2-ply lookahead driver
 * SWAPS the source to a private stream while it simulates candidate moves, then restores this exact
 * reference — so the real (tournament) RNG stream is never advanced by rollback-and-retry search and
 * replay-determinism is preserved. Never used on a live-game path (no source is installed there).
 */
export function getDeterministicRandomSource(): RandomSource | undefined {
    return deterministicSource;
}

/** One raw 53-bit value: from the seeded source if installed, else crypto-secure (the production path). */
function nextRaw53(): bigint {
    if (deterministicSource) {
        // The seeded source (mulberry32) yields only 32 bits of precision, so `floor(r * 2^53)` would push
        // those bits into the HIGH end and leave the LOW 21 bits always zero. That biases small-range
        // getRandomInt — e.g. randomInt(0, 2) returned the low bit, hence ALWAYS 0, which made the
        // morale-tie turn-order coin flip never random (LOWER/green always went first in sims -> a spurious
        // ~57/43 side bias that does NOT exist in production). Combine TWO draws for a full 53-bit value with
        // random LOW bits, matching the crypto branch's distribution. Production (crypto) is unaffected.
        const clamp = (r: number): number => (r < 0 ? 0 : r >= 1 ? 0.9999999999999999 : r);
        const hi = BigInt(Math.floor(clamp(deterministicSource()) * 0x200000)); // 21 high bits (2^21)
        const lo = BigInt(Math.floor(clamp(deterministicSource()) * 0x100000000)); // 32 low bits (2^32)
        return (hi << 32n) | lo; // 53-bit integer in [0, 2^53) with proper low-bit entropy
    }
    const u32 = new Uint32Array(2);
    getSecureRandomValues(u32);
    const hi = BigInt(u32[0] & 0x001fffff); // 21 bits
    const lo = BigInt(u32[1]); // 32 bits
    return (hi << 32n) | lo; // 53-bit integer in [0, 2^53)
}

/**
 * Secure uniform integer in [min, max).
 * - Exclusive of max (matches Node's crypto.randomInt).
 * - Uses rejection sampling (no modulo bias).
 * - Fails closed if crypto-secure randomness is unavailable (unless a seeded test source is installed).
 * - Supports safe JS integer ranges up to 2^53 possible values.
 */
export function getRandomInt(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error("min/max must be finite numbers");
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new Error("min/max must be safe integers");
    if (max < min) throw new Error("max must be >= min");
    if (max === min) return min;

    const spanBig = BigInt(max) - BigInt(min); // > 0
    const TWO53 = 1n << 53n;
    if (spanBig > TWO53) throw new Error("range must contain at most 2^53 possible values");
    if (spanBig === 1n) return min;

    // Rejection sample 53-bit values to avoid bias. The raw source is crypto-secure in production and a
    // seeded PRNG only when a simulation/test has installed one (see setDeterministicRandomSource).
    const limit = (TWO53 / spanBig) * spanBig; // largest multiple of span below 2^53
    for (;;) {
        const rnd53 = nextRaw53();
        if (rnd53 < limit) {
            return Number(rnd53 % spanBig) + min;
        }
    }
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
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) {
        throw new Error("Invalid UUID format");
    }
    const hex = uuid.replace(/-/g, "");
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

export function createSecureUuid(): string {
    const c = getWebCrypto();
    if (!c) {
        throw new Error("Crypto-secure UUID generation is unavailable in this runtime");
    }
    if (typeof c.randomUUID === "function") {
        return c.randomUUID();
    }

    const bytes = getSecureRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return uuidFromBytes(bytes);
}

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

/** Compact "💀N" suffix for a damage scene-log line; empty when no units of the stack died. */
export const killTag = (unitsKilled: number): string => (unitsKilled > 0 ? ` 💀${unitsKilled}` : "");
