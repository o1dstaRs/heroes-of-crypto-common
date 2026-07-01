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
    // [41..48] LEARNED DIRECTIONAL-AOE positioning — Black Dragon Fire Breath & Pikeman Skewer (a LINE through
    // the aimed target) and Thunderbird Chain Lightning (a BFS arc). Separate block from the Hydra spin so the
    // "wants to be surrounded" lesson doesn't leak onto fragile line/chain units. All-zero (default) = v0.4.
    "dirCoverage", // * number of enemy stacks the line/arc catches (raw coverage)
    "dirValue", // * Σ min(our max melee dmg, enemy cumHP)/enemy maxHp over the hit-set
    "dirKill", // * # of hit stacks this blow would wipe
    "dirThreat", // * Σ enemy firepower/1000 over the hit-set — catch their dangerous stacks
    "dirExposure", // * enemy melee that can reach the stand cell / 3 — fragile AOE units avoid over-extending
    "dirMoveCost", // * 1 - moveCost/steps — prefer cheaper-to-reach cells
    "dirWounded", // * Σ wounded fraction over the hit-set — finish nearly-dead stacks
    "dirIncumbent", // * (cell, target) == v0.4's coverage-max pick (1/0) — anchor; keeps default == v0.4
] as const;

/**
 * SHIPPED == the SELF-PLAY-TRAINED vector. Beats frozen v0.4 by ~+6pp: ~61.2% decisive on three truly-FRESH
 * held-out seeds (61.8 / 61.1 / 60.7, 4k games each), panel 61.56% — panel≈fresh, so robust not overfit.
 * Length MUST equal V05_WEIGHT_KEYS.length.
 *
 * What it learned (41-dim full CEM, pass 17): shots favour higher-tier / high-firepower stacks over the blunt
 * 2x range bias; melee leans on a free hit into the most dangerous stack from a screened cell; and the two
 * newest blocks — center-mountain mining [26..32] and AOE-melee positioning [33..40] — are now trained too,
 * the latter learning that a Hydra WANTS to be surrounded (aoeExposure +3.2, aoeCoverage +2.6).
 */
export const DEFAULT_V05_W: readonly number[] = [
    // Long-run CONCURRENT CEM over ALL 41 dims (10h, RNG-fixed sim, panel-validated, pass 17). ~61.2% vs v0.4
    // on three truly-FRESH held-out seeds outside BOTH the training seeds and the 5-seed selection panel
    // (61.8/61.1/60.7, 4k games each; avg 61.2%); panel score 61.56% — panel≈fresh, so robust not overfit.
    // +2.4pp over the pass-8 bake (58.8% on the same fresh seeds), and this pass ALSO co-trained the two new
    // feature blocks below. Shots still lean on high-tier/high-firepower stacks (shotLevel [4] 3.57, shotRange
    // [5] 4.57); melee flips meleeKill ([15] +0.11) back slightly positive while leaning on the free hit
    // (meleeRetalFree [16] 3.96) into the most dangerous stack (meleeThreat [17] 3.23).
    1.5071, -0.2441, 0.3461, 0.8641, 3.5716, 4.5685, 0.9699, 0.1516, -0.5075, 1.2347, -0.2059, 1.9369, 1.3947, 2.5332,
    -0.0088, 0.1119, 3.9592, 3.232, -0.4417, 0.29, -0.7771, 0.5521,
    // [22] meleeStandSupport (-1.78), [23] meleeTargetWounded (-2.37) — strike from a screened stand cell and
    // strongly de-prioritise piling onto already-wounded stacks, letting focus-fire spend hits on fresh kills.
    -1.7815, -2.3662,
    // [24] posAdvanceFM (-0.66), [25] meleeRetalCostFM (+0.69) — first-mover-mitigation interactions.
    -0.655, 0.6914,
    // [26..32] center-mountain mining — LEARNED: mineBias 1.01 (willing to break the block), mineOutRange 0.68
    // (more so when we out-range them), mineLaneBlocked 0.29 (block on the line to the enemy) — net a modest
    // learned lean toward mining a reachable block instead of detouring. Values: bias, inPlace, close, group,
    // outRange, laneBlocked, progress.
    1.0091, -0.5941, -1.4454, -0.3316, 0.681, 0.2878, 0.1747,
    // [33..40] AOE-melee positioning — LEARNED: aoeCoverage 2.65 (catch more enemies), aoeExposure +3.21 (a
    // Hydra WANTS to be surrounded — Lightning Spin hits all-around and draws no counter), aoeKill 1.34
    // (finish stacks), aoeIncumbent 0.73 (keep v0.4's cell absent a clear win). Values: coverage, value, kill,
    // threat, exposure, moveCost, wounded, incumbent.
    2.6464, -0.3006, 1.3421, -0.9998, 3.2068, -0.0927, -0.9579, 0.734,
    // [41..48] DIRECTIONAL-AOE positioning (Fire Breath / Skewer line, Chain Lightning arc) — UNTRAINED (all 0):
    // v0.5 keeps v0.4's coverage-max line/arc pick until the next CEM pass searches these dims.
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
