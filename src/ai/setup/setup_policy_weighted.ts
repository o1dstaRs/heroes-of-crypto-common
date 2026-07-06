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

import { Perk, getUpgradePoints } from "../../perks/perk_properties";
import { SetupPolicyV0 } from "./setup_v0";

/**
 * Weight-parameterised setup policy for CEM training (mirrors the v0.5 combat path: a base heuristic plus a
 * learned weight vector injected at runtime). The ANCHOR — an all-zero vector — reproduces SetupPolicyV0
 * exactly, so gen-1 of a CEM run never regresses below the shipped heuristic (incumbency, as v0.5 did).
 *
 * Two interacting decisions are learned (the ones a per-axis greedy can't jointly optimise): the doctrine
 * (its upgrade-point budget) and how that budget is split across augment categories. Artifacts + synergies
 * stay on the measured-best greedy (independent choices — greedy is already optimal there).
 *
 * Weight layout (SETUP_WEIGHT_DIM = 7):
 *   [0..2] perk bias for [THREE_REVEALS, SEE_ALL, SEE_NONE] — added to each doctrine's budget score.
 *   [3..6] augment-category value nudge for [Armor, Might, Sniper, Movement] — added to the measured base
 *          advantage; a category is bought (highest affordable level) while its nudged value clears a
 *          threshold, in descending value order, until the budget is spent.
 */
export const SETUP_WEIGHT_DIM = 7;

/** Env var carrying the JSON weight vector (browser-bundle safe: only read in the Node/Bun sim/trainer). */
export const SETUP_WEIGHTS_ENV = "V05_SETUP_WEIGHTS";

/** Measured advantage-over-50% of each augment category at its top level (Armor L3 ≈ +19pp, …). The greedy
 * threshold sits between Might and Sniper so the anchor buys exactly {Armor, Might} — the shipped heuristic. */
const AUGMENT_BASE_VALUE: Record<"Armor" | "Might" | "Sniper" | "Movement", number> = {
    Armor: 19,
    Might: 15,
    Sniper: 7,
    Movement: -5,
};
const AUGMENT_MAX_LEVEL: Record<"Armor" | "Might" | "Sniper" | "Movement", number> = {
    Armor: 3,
    Might: 3,
    Sniper: 3,
    Movement: 2,
};
const AUGMENT_VALUE_THRESHOLD = 10; // anchor: only Armor(+19)/Might(+15) clear it; Sniper(+7)/Movement don't.

const PERKS: Perk[] = [Perk.THREE_REVEALS, Perk.SEE_ALL, Perk.SEE_NONE];

/**
 * Baked setup vector — CEM self-play champion (agent-zinc node, 2026-07-05): decisive win rate 57.8% on a
 * held-out seed vs the all-zero heuristic anchor (+7.8pp), CEM_DIM=7 POP=12 GENS=12 GAMES=3000. Steers the
 * perk away from THREE_REVEALS ([0..2]) and lifts Sniper past the augment buy threshold ([3..6]). This is the
 * DEFAULT when no V05_SETUP_WEIGHTS env is set — the anchor is now the trained policy, not the raw heuristic.
 * To recover the pre-training heuristic for an A/B, pass V05_SETUP_WEIGHTS='[0,0,0,0,0,0,0]'.
 */
export const DEFAULT_SETUP_W: readonly number[] = [-3.02959, -0.42867, -0.26908, 1.00639, -2.94528, 3.57446, -0.01473];

export const loadSetupWeights = (): number[] => {
    const raw = process.env[SETUP_WEIGHTS_ENV];
    if (!raw) {
        return DEFAULT_SETUP_W.slice();
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
            const w = parsed.slice(0, SETUP_WEIGHT_DIM);
            while (w.length < SETUP_WEIGHT_DIM) w.push(0);
            return w;
        }
    } catch {
        // fall through to anchor
    }
    return DEFAULT_SETUP_W.slice();
};

export class SetupPolicyWeighted extends SetupPolicyV0 {
    public override readonly version = "setup-weighted";
    private readonly w: number[];
    public constructor(weights: number[] = loadSetupWeights()) {
        super();
        this.w = weights.length >= SETUP_WEIGHT_DIM ? weights : [...weights, ...new Array(SETUP_WEIGHT_DIM).fill(0)];
    }
    /** Doctrine maximising (upgrade-point budget + learned bias). Anchor → SEE_NONE (max budget). */
    public override pickPerk(): number {
        let best = PERKS[0];
        let bestScore = -Infinity;
        PERKS.forEach((perk, i) => {
            const score = getUpgradePoints(perk) + this.w[i];
            if (score > bestScore) {
                bestScore = score;
                best = perk;
            }
        });
        return best;
    }
    /** Spend the budget across augment categories by nudged value, highest affordable level first. Anchor →
     * {Armor L3, Might L3} (the shipped heuristic). */
    public override pickAugments(budget: number): { kind: "Armor" | "Might" | "Sniper" | "Movement"; value: number }[] {
        const kinds = ["Armor", "Might", "Sniper", "Movement"] as const;
        const ranked = kinds
            .map((kind, i) => ({ kind, value: AUGMENT_BASE_VALUE[kind] + this.w[3 + i] }))
            .filter((c) => c.value >= AUGMENT_VALUE_THRESHOLD)
            .sort((a, b) => b.value - a.value);
        const out: { kind: "Armor" | "Might" | "Sniper" | "Movement"; value: number }[] = [];
        let remaining = Math.max(0, Math.floor(budget));
        for (const c of ranked) {
            const level = Math.min(AUGMENT_MAX_LEVEL[c.kind], remaining);
            if (level >= 1) {
                out.push({ kind: c.kind, value: level });
                remaining -= level;
            }
        }
        return out;
    }
}
