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
 * The DEFAULT vector below is the SHIPPED, fully-trained policy (~53.3% vs v0.4 on unseen seeds). The
 * untrained no-op vector that reproduces v0.4 EXACTLY is [1,0,1,0,0,1, 0,0,0,1.5, 0,0,0,0, 0,0,0,0,0,2.0]
 * (shot scoring == v0.4's 2x-range pure-damage; every reposition/melee feature off with its incumbency
 * anchor dominating) — pass it via process.env.V05_WEIGHTS to A/B against the trained default. CEM searches
 * around such anchors and writes the winning vector back here.
 *
 * Runtime injection: the strategy reads `process.env.V05_WEIGHTS` (a JSON number[]) when present — this
 * is how the CEM harness evaluates a candidate vector inside the tournament workers. It is NEVER read
 * from disk (no readFileSync) so the browser client bundle is unaffected; the committed default below
 * is the shipped behaviour.
 */

/**
 * Human-readable order of the weight vector — keep in sync with v0_5.ts and CEM_DIM.
 *
 * Four learned seams (each anchored so weights==no-op reproduce v0.4 exactly):
 *   [0..5]   scoreShot   — which enemy a shooter aims at (stage 1; narrow, ~+1pp).
 *   [6..9]   reposition  — destination of a STANDALONE move (stage 2; ~+0.2pp).
 *   [10..13] reposition+ — richer move features: threat/aggro-zone/shoot-ready/aura (stage 3; ~flat).
 *   [14..19] melee       — which enemy to strike and FROM WHICH cell (stage 4; the breakthrough, +2.4pp).
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
    "posThreat", // * enemy melee that can reach the cell / 3 — exposure the heuristic can't see
    "posAggrZone", // * route steps into the enemy threat zone (1/0)
    "posShoot", // * shooter-with-ammo lands on a cell within shot distance but not boxed (1/0)
    "posAura", // * aura emitter covers more allies from the cell / 4
    "meleeDamage", // * expected damage / target maxHp — which adjacent/reachable enemy to strike
    "meleeKill", // * this strike wipes the target stack (1/0) — focus-kill
    "meleeRetalFree", // * target already used its retaliation this lap (1/0) — a free hit
    "meleeThreat", // * target firepower / 1000 — trade into their most dangerous stack
    "meleeStandThreat", // * enemy melee that can reach our STAND cell / 3 — don't overextend
    "meleeIncumbent", // * (target, stand cell) == v0.4's own melee pick (1/0) — anchor; keeps default == v0.4
    "meleeRetalCost", // * expected retaliation damage taken / our HP (0 if we kill / they already retaliated)
    "meleeFocusFire", // * # of our OTHER stacks already adjacent to the target / 2 — gang up to finish a stack
    "meleeStandSupport", // * # of our stacks adjacent to the stand cell / 2 — strike from where allies screen us
    "meleeTargetWounded", // * fraction of the target stack already dead — finish nearly-dead stacks (remove a unit)
    "posAdvanceFM", // * advance x first-mover-exposure — dial back committing-advance when the enemy will react
    "meleeRetalCostFM", // * retaliation-taken x first-mover-exposure — avoid reactable trades when committing first
    // [26..32] LEARNED CENTER-MOUNTAIN MINING (BLOCK_CENTER maps). Converts an otherwise-advancing melee unit
    // into a move+strike on the block when the weighted score > 0. All-zero (default) = v0.4's fixed heuristic.
    "mineBias", // + constant — overall willingness to break the block instead of advancing
    "mineInPlace", // * already adjacent to the block (1/0) — a free chip, no move
    "mineClose", // * 1 - moveCost/steps — cheaper-to-reach strike cells preferred
    "mineGroup", // * 1 - nearestMeleeAllyDist/10 — mine when the melee is grouped, not alone
    "mineOutRange", // * sign(our ranged firepower - theirs): +1 we out-range, -1 they do
    "mineLaneBlocked", // * the block sits on the straight line to the nearest enemy (1/0) — truly opens the lane
    "mineProgress", // * (MAX_HITS - hitsLeft)/MAX_HITS — lean into finishing a nearly-cleared block
    // [33..40] LEARNED AOE-MELEE POSITIONING (multi-hit melee, currently Hydra Lightning Spin). Scores each
    // reachable stand cell by a weighted sum over the WHOLE hit-set. All-zero (default) = v0.4's coverage-max.
    "aoeCoverage", // * number of enemies the spin catches from the cell (the raw coverage term)
    "aoeValue", // * Σ min(our max melee dmg, enemy cumHP)/enemy maxHp over the hit-set (total damage value)
    "aoeKill", // * # of hit stacks this blow would wipe (focus-finish)
    "aoeThreat", // * Σ enemy firepower/1000 over the hit-set — catch their dangerous stacks
    "aoeExposure", // * enemy melee that can reach the stand cell / 3 — don't over-extend for coverage
    "aoeMoveCost", // * 1 - moveCost/steps — prefer cheaper-to-reach spin cells
    "aoeWounded", // * Σ wounded fraction over the hit-set — finish nearly-dead stacks
    "aoeIncumbent", // * cell == v0.4's coverage-max pick (1/0) — anchor; keeps default == v0.4
] as const;

/**
 * SHIPPED == the SELF-PLAY-TRAINED vector (CEM stage-4, melee-centred). Beats frozen v0.4 by ~+3.3pp on
 * FOUR unseen seeds (53.4 / 53.6 / 53.5 / 52.8, 5-6k games each) while emitting far FEWER engine rejections
 * (89 vs 264 on 6k games) — the learned melee re-pick turns v0.4's invalid strikes into valid hits.
 * Length MUST equal V05_WEIGHT_KEYS.length.
 *
 * What it learned: shots favour higher-tier / high-firepower stacks over the blunt 2x range bias; movement
 * holds/baits rather than charges and avoids lava/water; and — the big one — MELEE strongly weights
 * finishing a stack (meleeKill 1.72) and damage (meleeDamage 1.17), picking the target/stand-cell that v0.4
 * misses, with the meleeIncumbent anchor (1.06) keeping v0.4's pick when nothing clearly beats it.
 */
export const DEFAULT_V05_W: readonly number[] = [
    // Long-run CONCURRENT CEM (8h, RNG-fixed sim, panel-validated, pass 8). ~59.1% vs v0.4 on four truly-FRESH
    // held-out seeds outside BOTH the training seeds and the selection panel (59.7/59.7/58.1/58.9, 5k games
    // each; avg 59.12%); panel score 59.44% — panel≈fresh, so robust not overfit. A further +0.5pp over the
    // pass-7 bake (58.61% fresh), +3.4pp over the original shipped ~55.7%. Shots lean even harder on
    // high-firepower/high-tier stacks (shotFirepower [3] 0.75, shotLevel [4] 4.12, shotRange [5] 5.31); melee
    // keeps meleeKill ([15] -0.50) negative — don't chase the wipe — while taking the free hit (meleeRetalFree
    // [16] 2.92) into the most dangerous stack (meleeThreat [17] 2.53) from a screened cell.
    1.0301, -0.2669, 0.2212, 0.7464, 4.1193, 5.3065, 0.4172, 0.536, -0.4642, 2.4397, -0.1963, 0.9927, 0.8947, 1.7654,
    -0.0329, -0.5002, 2.9235, 2.5296, -0.4112, 1.0424, -1.5771, 0.9101,
    // [22] meleeStandSupport, [23] meleeTargetWounded — strike from a screened stand cell (-0.78) and strongly
    // de-prioritise piling onto already-wounded stacks ([23] -2.78), letting focus-fire spend hits on fresh kills.
    -0.7753, -2.7806,
    // [24] posAdvanceFM, [25] meleeRetalCostFM — first-mover-mitigation interactions, learned non-zero: dial
    // back committing-advance when the enemy will react (posAdvanceFM -1.54) while accepting reactable trades
    // slightly (meleeRetalCostFM +0.26). Part of the pass-8 win.
    -1.5444, 0.2624,
    // [26..32] center-mountain mining — UNTRAINED (all 0): v0.5 leaves v0.4's fixed block-breaking heuristic
    // untouched. A CEM retrain that samples BLOCK_CENTER maps searches these to add learned move+strike mining.
    0, 0, 0, 0, 0, 0, 0,
    // [33..40] AOE-melee positioning — UNTRAINED (all 0): v0.5 keeps v0.4's coverage-max spin cell. Searched by
    // the same frozen-CEM pass (freeze 0..25, explore 26..40) alongside the mountain dims.
    0, 0, 0, 0, 0, 0, 0, 0,
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
