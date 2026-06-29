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
 * Learned weights for v0.5's self-play-trained evaluator.
 *
 * v0.5 is the first REINFORCEMENT-LEARNED AI version: rather than hand-tuned thresholds, its scoring
 * coefficients are searched by self-play (the Cross-Entropy Method, src/simulation/optimizer/cem.mjs)
 * against a FROZEN v0.4. The engine has no board-state clone/rollback (so no lookahead / MCTS is
 * possible — verified), which makes black-box POLICY SEARCH over a parameterised scorer the right RL
 * family here; reward is simply the self-play decisive win rate.
 *
 * The DEFAULT vector below reproduces v0.4's shot scoring EXACTLY (so an untrained v0.5 == v0.4):
 *   - enemy hit: value += shotDamage * effective   (v0.4: += effective, i.e. 1.0)
 *   - enemy RANGE hit additionally: += shotRange * effective  (v0.4: total 2.0x, so default shotRange=1.0)
 *   - friendly-fire splash: value -= shotFriendlyFire * effective  (v0.4: -= effective, i.e. 1.0)
 *   - shotKill / shotFirepower / shotLevel: NEW biases, default 0 (off) so the default is a no-op delta.
 * CEM searches around this and writes the winning vector back here.
 *
 * Runtime injection: the strategy reads `process.env.V05_WEIGHTS` (a JSON number[]) when present — this
 * is how the CEM harness evaluates a candidate vector inside the tournament workers. It is NEVER read
 * from disk (no readFileSync) so the browser client bundle is unaffected; the committed default below
 * is the shipped behaviour.
 */

/**
 * Human-readable order of the weight vector — keep in sync with v0_5.ts and CEM_DIM.
 *
 * Two learned seams:
 *   [0..5] scoreShot   — which enemy a shooter aims at (stage 1; a narrow lever, ~+1pp ceiling).
 *   [6..9] reposition  — where a unit moves on a STANDALONE reposition turn (stage 2; the real
 *                        positioning/timing headroom). The policy re-ranks the engine's reachable cells
 *                        by w·features; "posIncumbent" biases toward v0.4's own chosen destination, so at
 *                        the default below (all feature weights 0, incumbent > 0) v0.5 keeps v0.4's move
 *                        EXACTLY — the untrained-v0.5 == v0.4 safety identity holds across both seams.
 */
export const V05_WEIGHT_KEYS = [
    "shotDamage", // * expected effective damage on an enemy hit (proven dominant term)
    "shotKill", // * cumulative HP of a stack THIS shot finishes (focus-kill bonus)
    "shotRange", // * extra effective damage when the hit lands on an enemy RANGE unit
    "shotFirepower", // * target firepower / 1000 (prefer silencing high-DPS shooters)
    "shotLevel", // * target level (prefer hitting higher-tier stacks)
    "shotFriendlyFire", // * effective AOE-splash damage onto our own units (a cost; subtracted)
    "posAdvance", // * (toward nearest enemy, per step) — sign learns advance(+) vs retreat(-)
    "posCohesion", // * (toward ally centroid, per step) — stay with the pack vs peel off
    "posHazard", // * candidate route crosses lava/water (1/0) — usually penalised
    "posIncumbent", // * candidate == v0.4's own destination (1/0) — anchor; keeps the default == v0.4
] as const;

/**
 * SHIPPED == the SELF-PLAY-TRAINED vector (CEM, gen 5 best). It beats frozen v0.4 by ~+1.2pp on unseen
 * seeds (50.8% / 51.6% on two fresh 6k-game runs; 51.91% on the held-out training seed) while emitting
 * FEWER engine rejections than v0.4. The untrained no-op vector (== v0.4) was [1,0,1,0,0,1, 0,0,0,1.5];
 * pass it via process.env.V05_WEIGHTS to A/B against this default. Length MUST equal V05_WEIGHT_KEYS.length.
 *
 * What it learned: shot scoring shifted toward higher-tier targets (shotLevel 0->1.40, shotFirepower
 * 0->0.67) and away from the blunt 2x range bias (shotRange 1->0.08); positioning prefers holding/baiting
 * over charging (posAdvance -0.37), staying loosely cohesive (posCohesion 0.25), strongly avoiding
 * lava/water (posHazard 0.89), with a firm incumbency anchor (posIncumbent 2.08) so it only overrides
 * v0.4's move when a cell is clearly better.
 */
export const DEFAULT_V05_W: readonly number[] = [
    0.8001, -0.3517, 0.0828, 0.6675, 1.4, 2.035, -0.3694, 0.2538, 0.892, 2.0847,
];

/**
 * Resolve the active weight vector. Honours process.env.V05_WEIGHTS (JSON number[]) for CEM training /
 * A-B sim runs; otherwise returns the committed default. Falls back to the default on any malformed input
 * so a bad env value can never crash a live game — it just plays as v0.4.
 */
export function loadV05Weights(): number[] {
    const raw = process.env.V05_WEIGHTS;
    if (raw) {
        try {
            const arr = JSON.parse(raw);
            if (
                Array.isArray(arr) &&
                arr.length === DEFAULT_V05_W.length &&
                arr.every((x) => typeof x === "number" && Number.isFinite(x))
            ) {
                return arr as number[];
            }
        } catch {
            /* malformed -> fall through to default */
        }
    }
    return DEFAULT_V05_W.slice();
}
