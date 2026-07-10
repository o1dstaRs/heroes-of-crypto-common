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
 * v0.7 RAWS leaf fitted on 253,880 positions from 6,000 fresh LiveTwin v0.6 mirror games (seed 4243).
 * The 20 coefficients align with VALUE_FEATURE_NAMES. Held-out: 75.1% accuracy / 0.4976 log loss,
 * versus 71.6% / 0.5330 for normalized material alone.
 */
export const DEFAULT_V07_VALUE_WEIGHTS = {
    b: 0.13187,
    w: [
        2.72071, 2.62258, 1.29138, 0.00841, -0.43786, 0.40335, 0.22442, -0.05486, -0.03332, -1.62063, -0.93442, 0.6862,
        0, -0.28796, -0.22985, 0.18385, -0.0938, 0.12553, 0.02072, 0.02444,
    ],
} as const;
