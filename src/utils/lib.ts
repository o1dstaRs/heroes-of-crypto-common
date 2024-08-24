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

import { randomInt } from "crypto";

export function shuffle<T>(array: T[]): T[] {
    let currentIndex = array.length;
    let randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex > 0) {
        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
}

export function matrixElement(matrix: number[][], x: number, y: number): number {
    if (!(y in matrix)) {
        return 0;
    }
    if (!(x in matrix[y])) {
        return 0;
    }
    return matrix[y][x];
}

export function removeItemOnce<T>(arr: T[], value: T): boolean {
    const index = arr.indexOf(value);
    let removed = false;
    if (index > -1) {
        arr.splice(index, 1);
        removed = true;
    }
    return removed;
}

// supports 65536 max
export function getRandomInt(min: number, max: number): number {
    if (max - min > 65536 || min < 65536 || max > 65536) {
        throw new Error("Invalid range. Only max - min <= 65536 is supported");
    }

    if (typeof window !== "undefined" && typeof window.document !== "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const crypto = window.crypto || (window as any).msCrypto; // For IE11 compatibility
        const range = max - min;
        const maxByteValue = 65536; // 2^16 = 65536

        if (range <= 0) {
            throw new Error("Max must be greater than min");
        }

        const byteArray = new Uint16Array(1); // 16-bit array to handle values up to 65536
        let randomValue: number;

        do {
            crypto.getRandomValues(byteArray);
            randomValue = byteArray[0];
        } while (randomValue >= Math.floor(maxByteValue / range) * range);

        return min + (randomValue % range);
    }

    return randomInt(min, max);
}

export function isBrowser(): boolean {
    return typeof window !== "undefined" && typeof window.document !== "undefined";
}

export function getTimeMillis(): number {
    if (typeof window !== "undefined" && typeof window.document !== "undefined") {
        return window.performance.now();
    }

    return Math.floor(Number(process.hrtime.bigint()) / 1000000);
}

export function interval(func: () => void | Promise<void>, timeoutMillis: number): void {
    const executeFunction = async () => {
        await func();
    };

    if (isBrowser()) {
        window.setInterval(executeFunction, timeoutMillis);
    } else {
        setInterval(executeFunction, timeoutMillis);
    }
}

export function uuidToUint8Array(uuid: string): Uint8Array {
    // Remove hyphens from the UUID string
    const hexStr = uuid.replace(/-/g, "");

    // Ensure the UUID string has the correct length
    if (hexStr.length !== 32) {
        throw new Error("Invalid UUID format");
    }

    // Convert each pair of hexadecimal digits into a byte
    const byteArray = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        byteArray[i] = parseInt(hexStr.substring(i * 2, 2), 16);
    }

    return byteArray;
}

export const uuidFromBytes = (buffer: Uint8Array): string => {
    // Ensure the buffer has exactly 16 bytes.
    if (buffer.length !== 16) {
        throw new Error("Buffer must be 16 bytes long");
    }

    // Array of hex groups for the UUID string
    const hex = Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0"));

    // Format according to UUID standard (8-4-4-4-12)
    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
    ].join("-");
};

/**
 * Convert a Base64-encoded string to a Uint8Array in Bun runtime.
 * @param base64 - The Base64-encoded string.
 * @returns The Uint8Array.
 */
export const base64ToUint8Array = (base64: string): Uint8Array => {
    // Decode the Base64 string to a Buffer
    const buffer = Buffer.from(base64, "base64");

    // Convert the Buffer to a Uint8Array
    return new Uint8Array(buffer);
};
