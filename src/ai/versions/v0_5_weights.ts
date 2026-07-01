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
    // Long-run CONCURRENT CEM (8h, RNG-fixed sim, panel-validated, pass 7). ~58.6% vs v0.4 on four truly-FRESH
    // held-out seeds outside BOTH the training seeds and the selection panel (59.4/58.9/57.6/58.6, 5k games
    // each; avg 58.61%); panel score 58.68% — the panel→fresh gap has essentially vanished, so the policy is
    // robust rather than overfit. A further +1.9pp over the prior pass-6 bake (56.74% fresh). Shots stay heavy
    // on high-firepower/high-tier stacks (shotLevel [4] 3.92, shotRange [5] 4.75); melee now flips meleeKill
    // ([15] -1.23) NEGATIVE — don't chase the wipe — while leaning hard on a free hit (meleeRetalFree [16] 3.45)
    // and meleeThreat ([17] 1.51), i.e. trade into their most dangerous stack from a screened cell.
    0.7805, -0.2351, 0.2918, 0.3259, 3.9152, 4.7528, 0.6614, 0.2203, -0.7477, 2.2378, 0.1866, 0.9765, 0.6135, 1.5349,
    -0.0091, -1.2281, 3.4529, 1.5101, -0.7689, 1.0507, -1.7521, 0.8412,
    // [22] meleeStandSupport, [23] meleeTargetWounded — strike from a screened stand cell (-0.67) and strongly
    // de-prioritise piling onto already-wounded stacks ([23] -2.80), letting focus-fire spend hits on fresh kills.
    -0.6676, -2.8021,
    // [24] posAdvanceFM, [25] meleeRetalCostFM — first-mover-mitigation interactions, learned non-zero: dial
    // back committing-advance when the enemy will react (posAdvanceFM -1.32) while accepting reactable trades
    // slightly (meleeRetalCostFM +0.19). Part of the pass-7 win.
    -1.3218, 0.1874,
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
