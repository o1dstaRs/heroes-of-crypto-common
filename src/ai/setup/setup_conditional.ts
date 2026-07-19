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

import { Tier2Artifact } from "../../artifacts/artifact_properties";
import { creatureInfo } from "./creature_score";
import { SETUP_POLICY_V0 } from "./setup_v0";

/**
 * CONDITIONAL_SETUP_V1 — an own-roster-composition rule layer over setup-v0 (env-gated, default OFF).
 *
 * setup-v0's tables are composition-BLIND: the same Armor3/Might3/Sniper1 spend and the same Tier-2
 * win-rate table regardless of what army was actually drafted. The 2026-07-15 evidence pass (v0.7 both
 * sides, LiveTwin exp-budget stacks, SEE_NONE, mirrored composition-controlled rosters, 2k games/cell,
 * seeds 83000710-83015710) measured the conditional effects directly:
 *
 *   Augments — pin Sniper3 (Sniper3/Armor3/Might1) vs the anchor spend, by own ranged stacks (of 6):
 *     4.6 ranged 97.1%+/-0.4 | 3 ranged 77.0%+/-1.0 | 2 ranged 57.0%+/-1.1 | ~1 ranged 49.8%+/-1.1 |
 *     1 ranged 39.3%+/-1.1 | 0 ranged 30.3%+/-1.0. Flyer-heavy rosters obey the same ranged-count rule
 *     (59.1% at avg 2.2 ranged). Armor must stay the second pick: Sniper3/Might3/Armor1 loses to
 *     Sniper3/Armor3/Might1 21.7-78.3. Sniper2 at 2 ranged is worse than Sniper3 (53.2% vs 57.0%).
 *     => rule "sniper": own ranged stacks >= 2 -> spend Sniper3 > Armor3 > Might(rest); else anchor.
 *
 *   Tier-2 artifact — the blind table's ranking inverts by composition (per-cohort tables measured via
 *     measure_artifacts, v0.7, LIVETWIN, 12k games/cohort; see TIER2_ARTIFACT_WINRATE_* below).
 *     => rule "t2": pick from the measured table of the matching own-composition cohort; anchor table
 *        when the composition is uncovered (no creatures known).
 *
 *   Synergy — fresh per-faction probes (4k games each, buckets by the beneficiary feature) re-confirmed
 *     the v0.6-era verdict: no roster-conditioned synergy pick beats the fixed table, so there is NO
 *     "synergy" rule in v1 (conditionalSynergies delegates to setup-v0 unconditionally).
 *
 * OWN roster only — no opponent features. (The augment-CA history: composition-aware policies trained
 * with free enemy vision regressed live; conditioning on the OWN roster is exempt from that trap but was
 * still cohort-tested per rule above.)
 *
 * The common-library default stays setup-v0: every entry point here returns setup-v0's choice unless the
 * rule is activated. Ranked servers may supply an explicit accepted default while retaining an off switch.
 */

export const SETUP_CONDITIONAL_VERSION = "conditional-setup-v1";

/** Env gate. Unset/"off"/"0" -> disabled (default). "on"/"1"/"all" -> all shipped rules. Or a comma list. */
export const SETUP_CONDITIONAL_ENV = "V07_SETUP_CONDITIONAL";

export const CONDITIONAL_SETUP_RULES = ["sniper", "t2"] as const;
export type ConditionalSetupRule = (typeof CONDITIONAL_SETUP_RULES)[number];

/** Own-roster composition counts (ranged first, then flyer, else ground melee — the league role order). */
export interface IOwnComposition {
    total: number;
    ranged: number;
    flyer: number;
    groundMelee: number;
}

export function ownComposition(creatureIds: readonly number[]): IOwnComposition {
    const composition: IOwnComposition = { total: 0, ranged: 0, flyer: 0, groundMelee: 0 };
    for (const id of creatureIds) {
        const info = creatureInfo(id);
        if (!info) {
            continue;
        }
        composition.total += 1;
        if (info.ranged) {
            composition.ranged += 1;
        } else if (info.canFly) {
            composition.flyer += 1;
        } else {
            composition.groundMelee += 1;
        }
    }
    return composition;
}

/** Measured break-even: Sniper3 beats the anchor spend from two own ranged stacks up (57.0% at exactly 2). */
export const SNIPER_PIN_MIN_RANGED = 2;

/** A ranged-heavy own roster prefers the ranged-cohort Tier-2 table from the same threshold. */
export const T2_RANGED_TABLE_MIN_RANGED = 2;

/**
 * Tier-2 marginal win rates on melee-heavy rosters (0-1 ranged stacks): v0.7 both sides, LIVETWIN=1 with
 * FIGHT_MELEE_ROSTERS=0 ROSTER_RANGED_MIN=0 ROSTER_RANGED_MAX=1, mirrored rosters, 12k games, seed 83015710
 * (measure_artifacts --tier=2, post artifact+augment seeding fix). Historical shift vs the blind v0.5-era
 * table: Tome of Amplification 41.7 -> 74.7 under its former augment-amplifying mechanic; Crown of Command
 * 43.1 -> 31.2. Tome's melee and ranged rows are stale after the 2026-07-18 castable-buffs-only change and
 * must be remeasured before they are treated as current evidence.
 */
export const TIER2_ARTIFACT_WINRATE_MELEE: Record<number, number> = {
    [Tier2Artifact.TOME_OF_AMPLIFICATION]: 74.7,
    [Tier2Artifact.TITAN_PLATE]: 68.0,
    [Tier2Artifact.WARLORDS_EDGE]: 67.5,
    [Tier2Artifact.CLOVER_OF_FORTUNE]: 64.7,
    [Tier2Artifact.FARSIGHT_QUIVER]: 57.6,
    [Tier2Artifact.GIANTS_MAUL]: 44.2,
    [Tier2Artifact.HOLY_CROSS]: 42.3,
    [Tier2Artifact.RIME_CHARM]: 42.0,
    [Tier2Artifact.LAVA_STRIDERS]: 41.2,
    [Tier2Artifact.PENDANT_OF_VITALITY]: 34.2,
    [Tier2Artifact.BERSERKERS_BOND]: 33.8,
    [Tier2Artifact.CROWN_OF_COMMAND]: 31.2,
};

/**
 * Tier-2 marginal win rates on ranged-heavy rosters (2-3 ranged stacks): v0.7 both sides, LIVETWIN=1 with
 * FIGHT_MELEE_ROSTERS=0 ROSTER_RANGED_MIN=2 ROSTER_RANGED_MAX=3, mirrored rosters, 12k games, seed 83012710
 * (post-fix). Farsight Quiver — 4th in the blind table (62.5) — is THE ranged pick at 88.8 +/- 1.4.
 */
export const TIER2_ARTIFACT_WINRATE_RANGED: Record<number, number> = {
    [Tier2Artifact.FARSIGHT_QUIVER]: 88.8,
    [Tier2Artifact.TOME_OF_AMPLIFICATION]: 71.3,
    [Tier2Artifact.TITAN_PLATE]: 67.2,
    [Tier2Artifact.CLOVER_OF_FORTUNE]: 66.5,
    [Tier2Artifact.WARLORDS_EDGE]: 65.3,
    [Tier2Artifact.RIME_CHARM]: 38.6,
    [Tier2Artifact.GIANTS_MAUL]: 37.9,
    [Tier2Artifact.HOLY_CROSS]: 37.8,
    [Tier2Artifact.LAVA_STRIDERS]: 37.0,
    [Tier2Artifact.CROWN_OF_COMMAND]: 32.6,
    [Tier2Artifact.PENDANT_OF_VITALITY]: 28.2,
    [Tier2Artifact.BERSERKERS_BOND]: 27.2,
};

const bestFromTable = (offered: readonly number[], table: Readonly<Record<number, number>>): number | undefined => {
    let best: number | undefined;
    let bestScore = -Infinity;
    for (const id of offered) {
        const score = table[id];
        if (score !== undefined && score > bestScore) {
            bestScore = score;
            best = id;
        }
    }
    return best;
};

/** Parse a rules spec ("on"/"all"/"1" -> every shipped rule; comma list -> the known subset; else none). */
export function parseConditionalRules(spec: string | undefined): ReadonlySet<ConditionalSetupRule> {
    const trimmed = (spec ?? "").trim().toLowerCase();
    if (!trimmed || trimmed === "off" || trimmed === "0") {
        return new Set();
    }
    if (trimmed === "on" || trimmed === "1" || trimmed === "all") {
        return new Set(CONDITIONAL_SETUP_RULES);
    }
    const known = new Set<string>(CONDITIONAL_SETUP_RULES);
    return new Set(
        trimmed
            .split(",")
            .map((rule) => rule.trim())
            .filter((rule): rule is ConditionalSetupRule => known.has(rule)),
    );
}

/** Active rules from env V07_SETUP_CONDITIONAL. Default OFF (empty set). */
export function conditionalRulesFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<ConditionalSetupRule> {
    return parseConditionalRules(env[SETUP_CONDITIONAL_ENV]);
}

export interface IConditionalAugment {
    kind: "Armor" | "Might" | "Sniper" | "Movement";
    value: number;
}

/**
 * Rule "sniper": with >= SNIPER_PIN_MIN_RANGED own ranged stacks, spend the budget Sniper3 > Armor3 >
 * Might(rest) instead of the anchor Armor3 > Might3 > Sniper1. Anything else (fewer ranged, rule off,
 * unknown roster) is setup-v0's spend, byte-identical.
 */
export function conditionalAugments(
    budget: number,
    ownCreatureIds: readonly number[],
    rules: ReadonlySet<ConditionalSetupRule>,
): IConditionalAugment[] {
    if (!rules.has("sniper") || ownComposition(ownCreatureIds).ranged < SNIPER_PIN_MIN_RANGED) {
        return SETUP_POLICY_V0.pickAugments(budget);
    }
    const out: IConditionalAugment[] = [];
    let remaining = Math.max(0, Math.floor(budget));
    for (const kind of ["Sniper", "Armor", "Might"] as const) {
        const level = Math.min(3, remaining);
        if (level >= 1) {
            out.push({ kind, value: level });
            remaining -= level;
        }
    }
    return out;
}

/**
 * Rule "t2": pick the offered Tier-2 artifact from the measured table of the own-composition cohort
 * (ranged-heavy vs melee). Uncovered composition (no known creatures) or rule off -> setup-v0's blind table.
 */
export function conditionalArtifactT2(
    offered: readonly number[],
    ownCreatureIds: readonly number[],
    rules: ReadonlySet<ConditionalSetupRule>,
): number {
    const composition = ownComposition(ownCreatureIds);
    if (!rules.has("t2") || composition.total === 0) {
        return SETUP_POLICY_V0.pickArtifactT2(offered);
    }
    const table =
        composition.ranged >= T2_RANGED_TABLE_MIN_RANGED ? TIER2_ARTIFACT_WINRATE_RANGED : TIER2_ARTIFACT_WINRATE_MELEE;
    return bestFromTable(offered, table) ?? SETUP_POLICY_V0.pickArtifactT2(offered);
}

/**
 * Synergy stays setup-v0's fixed table: the fresh 2026-07-15 per-faction probes (and the v0.6-era trained
 * situational picker before them) found no roster-conditioned pick that beats it. Kept as an explicit
 * entry point so the harness/server call sites don't special-case synergies if a v2 rule ever lands.
 */
export function conditionalSynergies(creatureIds: readonly number[]): { faction: number; synergy: number }[] {
    return SETUP_POLICY_V0.pickSynergies(creatureIds);
}
