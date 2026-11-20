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

/**
 * Identity only, so the profile can record the policy without loading the draft machinery behind it.
 * The behavior lives in a19_striker_rush.ts.
 */
export const A19_STRIKER_RUSH_POLICY = "a19-striker-rush-v1" as const;
/** The extension of the rush to mixed armies, four strikers with shooters (profile v18). Same file holds the rule. */
export const A19_STRIKER_RUSH_MIXED_POLICY = "a19-striker-rush-mixed-v1" as const;
