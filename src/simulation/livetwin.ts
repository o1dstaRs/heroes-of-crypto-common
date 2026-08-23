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

import { getUpgradePoints, Perk } from "../perks/perk_properties";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import type { StackAmountMode } from "./army";
import type { ISetupAugment } from "./battle_engine";

/**
 * LIVETWIN — the committed live-faithful eval config (v0.7 roadmap F2).
 *
 * Every sim pp ever "won" off this config has already converted into a live regression at least once
 * (augment-CA: +1.6pp sim, −1.3pp ranked). The gaps it closes, each verified in server code:
 *  - STACKS: live sizes every stack per-creature as ceil(1000 / exp) (play_session.ts
 *    STACK_EXPERIENCE_BUDGET + creature_lookup.ts amountForCreatureExperienceBudget) — L1 fields ~73-200
 *    bodies, L4 fields 1-3 — not the sim's historical {50,30,15,8} level table.
 *  - ROSTERS: live armies are drafted (and ~97% melee under the shipped draft weights), not uniform-random.
 *  - VISION/SETUP: live ranked ships perk SEE_NONE (no enemy vision) + the blind Armor3/Might3/Sniper1
 *    augment spend for every AI army; comp-aware policies must not see free enemy features.
 *  - SEEDS: mirrored side-swap pairs (the tournament default) stay on, so seat luck cancels.
 *
 * Activate with env `LIVETWIN=1` (or run_tournament's `--livetwin`). It is inherited by tournament worker
 * threads and by optimizer/cem.mjs child tournaments automatically (both propagate process.env), so ONE
 * switch makes any gate/eval live-faithful. Explicit env knobs still win where noted (e.g. a cohort battery
 * can set FIGHT_MELEE_ROSTERS=0/0.5/1 per pass while keeping the rest of the preset).
 *
 * With LIVETWIN unset, nothing anywhere changes — the default sim path stays byte-identical.
 */
export interface ILiveTwinPreset {
    /** Stack sizing rule — the live per-creature exp-budget resolver. */
    amountMode: StackAmountMode;
    /** Fraction of games fielding melee-DRAFTED (DEFAULT_DRAFT_W) rosters — live headline = 1 (roadmap F2:
     * "every gate reports its headline on FIGHT_MELEE_ROSTERS=1 + SEE_NONE"). */
    meleeRosterFraction: number;
    /** The shipped live perk: SEE_NONE (no enemy vision, max upgrade budget). */
    perk: number;
    /** Zero any enemy-composition features in comp-aware setup policies (AUGCA_NOVISION semantics). */
    noVision: boolean;
}

export const LIVETWIN_PRESET: ILiveTwinPreset = {
    amountMode: "expBudget",
    meleeRosterFraction: 1,
    perk: Perk.SEE_NONE,
    noVision: true,
};

/** Whether the live-faithful eval config is active (env LIVETWIN=1). */
export const isLiveTwin = (): boolean => process.env.LIVETWIN === "1";

/**
 * Effective melee-drafted-roster fraction: an EXPLICIT FIGHT_MELEE_ROSTERS env always wins (so the
 * melee/range/random cohort battery can sweep it under LIVETWIN); else the preset's fraction under
 * LIVETWIN; else 0 (off — the historical default).
 */
export const liveTwinMeleeFraction = (): number => {
    const env = process.env.FIGHT_MELEE_ROSTERS;
    if (env !== undefined && env !== "") {
        return Number(env);
    }
    return isLiveTwin() ? LIVETWIN_PRESET.meleeRosterFraction : 0;
};

/** The SHIPPED live setup both ranked AI armies actually field: SEE_NONE + blind Armor3/Might3/Sniper1. */
export const liveTwinSetup = (): { perk: number; augments: ISetupAugment[] } => ({
    perk: LIVETWIN_PRESET.perk,
    augments: SETUP_POLICY_V0.pickAugments(getUpgradePoints(LIVETWIN_PRESET.perk)),
});
