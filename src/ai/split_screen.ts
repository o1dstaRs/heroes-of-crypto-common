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

import { assertNoLegacySeatEnv, seatEnvName } from "./seat_env";

/**
 * a19-split-screen-v1 (profile v35; the owner, November 24, 2026: "premium for some reason always decides to split
 * ranges instead of melee for some reason. For example wolf is much better to split to cover, as it is 1x2 unit"). The
 * tactical split planner (`planTacticalStackSplits` with `{ screen: true }`) reserves no shooter "cover" split, lets
 * 1x2/2x1 stacks be split, and spends every slot left after the aura/support/shield splits on one-model screen splits of
 * the best cheap body. The server's split plan (AI seats and Premium "Arrange army") and the client's Premium projection
 * read the seat switch. See docs/owner_asks_adoption.md.
 */
export const A19_SPLIT_SCREEN_ID = "a19-split-screen-v1";

/** Per-seat switch (seat_env): on unless `A19_SPLIT_SCREEN_<LEFT|RIGHT>=0`. */
export const A19_SPLIT_SCREEN_ENV = "A19_SPLIT_SCREEN";

export function a19SplitScreenEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_SPLIT_SCREEN_ENV);
    return process.env[seatEnvName(A19_SPLIT_SCREEN_ENV, team)] !== "0";
}

/**
 * a19-shield-screen-v1 (profile v36; the owner, November 25, 2026: "it is always better to split mermaid if we have
 * it, because it takes two shots to kill her"; owner decision "Both now": AI seats and Premium). In screen mode the
 * split planner takes a splittable Water Shield stack (Mermaid) as the screen body before any other: its shield
 * absorbs the first attack, so every one-model split costs the enemy two attacks. The server's split plan (AI seats
 * and Premium "Arrange army") and the client's Premium projection read the seat switch. See
 * docs/shield_screen_adoption.md.
 */
export const A19_SHIELD_SCREEN_ID = "a19-shield-screen-v1";

/** Per-seat switch (seat_env): on unless `A19_SHIELD_SCREEN_<LEFT|RIGHT>=0`. */
export const A19_SHIELD_SCREEN_ENV = "A19_SHIELD_SCREEN";

export function a19ShieldScreenEnabled(team: number): boolean {
    assertNoLegacySeatEnv(A19_SHIELD_SCREEN_ENV);
    return process.env[seatEnvName(A19_SHIELD_SCREEN_ENV, team)] !== "0";
}
