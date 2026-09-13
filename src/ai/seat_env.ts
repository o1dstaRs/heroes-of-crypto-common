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
import { PBTypes } from "../generated/protobuf/v1/types";

/**
 * Per-seat research env seams — wait weights, the wait-cancel gate and the SearchDriver V2 value leaf — name
 * their variables `<BASE>_LEFT` / `<BASE>_RIGHT`, following the LEFT/RIGHT team system. The side-board battery
 * (writer) and the policy code (readers) both build names HERE. On 2026-08-29 the team rename rewrote the
 * battery's hand-written seat literals but not the readers', and every per-seat override silently reached no
 * seat for two weeks; a single builder is what stops the two sides from drifting apart again.
 */
export const seatEnvName = (base: string, team: number): string =>
    `${base}_${team === PBTypes.TeamVals.LEFT ? "LEFT" : "RIGHT"}`;

const cleanBases = new Set<string>();

/**
 * Fail loudly while a pre-rename `<BASE>_LOWER` / `<BASE>_UPPER` is set: it used to be read and no longer is,
 * and a silently ignored override is exactly the failure this seam already suffered once. A base is cached only
 * once it is proven clean, so the hot per-decision readers pay nothing afterwards, while a stale legacy variable
 * keeps throwing on every call instead of erroring once and then quietly falling back to the defaults.
 */
export function assertNoLegacySeatEnv(base: string): void {
    if (cleanBases.has(base)) {
        return;
    }
    for (const [legacy, seat] of [
        ["LOWER", "LEFT"],
        ["UPPER", "RIGHT"],
    ] as const) {
        const value = process.env[`${base}_${legacy}`];
        if (value !== undefined && value !== "") {
            throw new Error(`${base}_${legacy} is no longer read: teams are LEFT/RIGHT, set ${base}_${seat} instead`);
        }
    }
    cleanBases.add(base);
}

/** Test seam: forget which bases were proven clean, so a test can set a legacy name and observe the error. */
export function resetLegacySeatEnvChecksForTests(): void {
    cleanBases.clear();
}
