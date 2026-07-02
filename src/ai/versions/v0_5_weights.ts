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
    // [49..50] LEARNED per-ability "hidden gems" folded into the melee stand-cell/target scorer.
    "warAngerSurround", // * # living enemies within War Anger aura range of the stand cell (Valkyrie: +dmg/enemy → seek surround)
    "punishMeleeAvoid", // * meleeing a Fire Shield (Efreet) / Dulling Defense (Goblin Knight) survivor (1/0) — a reflect/debuff cost; learn to avoid
] as const;

/**
 * SHIPPED == the SELF-PLAY-TRAINED vector. Beats frozen v0.4 by ~+6.5pp: ~61.6% decisive on three truly-FRESH
 * held-out seeds (61.5 / 61.6 / 61.7, 4k games each), panel 61.74% — panel≈fresh, so robust not overfit.
 * Length MUST equal V05_WEIGHT_KEYS.length.
 *
 * What it learned (49-dim full CEM, pass 12): shots favour higher-tier / high-firepower stacks; melee leans on
 * a free hit into the most dangerous stack from a screened cell; center-mountain mining [26..32] and AOE
 * positioning are trained — the Hydra spin [33..40] learning it WANTS to be surrounded (aoeExposure +3.1,
 * aoeCoverage +2.6), while the directional-AOE block [41..48] (Fire Breath / Skewer / Chain Lightning) mostly
 * ANCHORS to v0.4's coverage-max (dirIncumbent +0.71) — those lines/arcs were already near-optimal.
 */
export const DEFAULT_V05_W: readonly number[] = [
    // Long-run CONCURRENT CEM over ALL 49 dims (7h, RNG-fixed sim, panel-validated, pass 12). ~61.6% vs v0.4 on
    // three truly-FRESH held-out seeds outside BOTH the training seeds and the 5-seed panel (61.5/61.6/61.7, 4k
    // games each; avg 61.6%); panel 61.74% — panel≈fresh, robust not overfit. +0.6pp over the pass-17 bake
    // (61.0% on the same fresh seeds) from refining the whole vector + training the directional-AOE block.
    1.6989, -0.5351, 0.1209, -0.0394, 3.1819, 4.4191, 0.8675, 0.5428, -0.3078, 0.8065, -0.737, 1.5808, 1.7297, 2.8292,
    -0.0376, 1.0486, 3.4951, 2.9443, -0.666, -0.0077, -2.0195, 0.6111,
    // [22] meleeStandSupport (-1.90), [23] meleeTargetWounded (-2.55) — strike from a screened stand cell and
    // strongly de-prioritise piling onto already-wounded stacks.
    -1.8996, -2.5474,
    // [24] posAdvanceFM (-0.99), [25] meleeRetalCostFM (+1.75) — first-mover-mitigation interactions.
    -0.9852, 1.7509,
    // [26..32] center-mountain mining — LEARNED (bias, inPlace, close, group, outRange, laneBlocked, progress).
    1.4942, -0.4027, -0.501, -0.7806, 0.5115, 0.1852, -0.1876,
    // [33..40] Hydra spin AOE — LEARNED: aoeCoverage 2.56 + aoeExposure +3.13 (a Hydra WANTS to be surrounded),
    // aoeIncumbent 1.69. Values: coverage, value, kill, threat, exposure, moveCost, wounded, incumbent.
    2.5639, -0.758, 0.9309, -0.6723, 3.1302, -0.5766, -0.9204, 1.6919,
    // [41..48] DIRECTIONAL-AOE (Fire Breath / Skewer line, Chain Lightning arc) — LEARNED but ANCHOR-heavy
    // (dirIncumbent 0.71, others small): v0.4's coverage-max line/arc was already near-optimal, so it mostly
    // keeps it. Values: coverage, value, kill, threat, exposure, moveCost, wounded, incumbent.
    0.0288, 0.0292, -1.0115, 0.1992, 0.2565, 0.2656, 0.1276, 0.7142,
    // [49..50] hidden-gem melee features — UNTRAINED (0): warAngerSurround (Valkyrie seeks surround) and
    // punishMeleeAvoid (don't trade into Fire Shield / Dulling Defense). Searched by the next CEM pass.
    0, 0,
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
