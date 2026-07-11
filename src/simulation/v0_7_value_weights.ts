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

/**
 * Phase-B MULTI-COHORT V2 leaf CANDIDATE (2026-07-11, env-gated — NOT a default): 60 coefficients over
 * VALUE_FEATURE_NAMES_V2 (raw 30 + rangedness-interaction block), fit by optimizer/fit_value_v2.mjs with
 * SHRINKAGE toward DEFAULT_V07_VALUE_WEIGHTS on the shared first-20 block (l2=0.003, 300 epochs) on
 * 414,666 positions from 8,000 v0.6 self-play games across five cohorts (LIVETWIN melee drafts 2k /
 * mixed FMR=0.5 drafts 2k / forced ranged_max_sniper3 mirrors 2k / hybrid mirrors 1k / pure_ranged
 * mirrors 1k; seeds 79011710..79015710). Held-out accuracy split BY GAME (vs the committed 20d leaf):
 *   pooled 79.95% (20d: 78.06) | melee 76.06 (75.97) | mixed 78.26 (77.72) | ranged_max 84.13 (81.65)
 *   | hybrid 75.21 (75.69) | pure_ranged 83.79 (76.62; material baseline 85.75)
 * Arm via V07_VALUE_WEIGHTS_V2=$(json of this constant) — search_driver's leaf then uses the V2 basis.
 */
export const MULTICOHORT_V07_VALUE_WEIGHTS_V2_2026_07_11 = {
    b: 0.12085,
    w: [
        3.86987, 2.93244, 1.81804, -0.13392, -1.07473, 1.00686, 0.17237, 0.00405, -0.10434, -1.71923, -0.95201, 0.7672,
        0.00009, -0.24357, -0.37844, 0.29021, -0.14016, 0.19824, 0.08107, -0.05474, -0.0443, 0.01188, 0.12247, -0.12216,
        0.27926, -0.30397, 0.0532, -0.06169, -0.08185, 0.01745, 0.80706, -0.1135, 0.66729, -0.14334, -0.47378, 0.41186,
        -0.02215, -0.03767, -0.06966, 0.16734, 0.15768, -0.00967, 0.00006, 0.1581, 0.02515, 0.03954, 0.00281, 0.02284,
        0.03988, -0.00286, -0.02536, -0.00387, 0.04793, -0.04506, 0.00626, -0.01338, 0.02377, -0.03594, -0.09021,
        0.0321,
    ],
} as const;
