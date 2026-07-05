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

import { CreatureFactions } from "../../generated/protobuf/v1/creature_gen";
import { Perk } from "../../perks/perk_properties";
import { scoreCreature } from "./creature_score";
import {
    AUGMENT_PRIORITY,
    BEST_SYNERGY_BY_FACTION,
    TIER1_ARTIFACT_WINRATE,
    TIER2_ARTIFACT_WINRATE,
    type ISetupPolicy,
} from "./setup_strategy";

/** argmax by a scoring function; returns the first candidate on empty/tie. */
const bestBy = <T>(items: readonly T[], score: (item: T) => number): T | undefined => {
    let best: T | undefined;
    let bestScore = -Infinity;
    for (const item of items) {
        const s = score(item);
        if (s > bestScore) {
            bestScore = s;
            best = item;
        }
    }
    return best;
};

/**
 * Heuristic setup policy v0 — the first server-authoritative "AI does the full draft/setup". Every choice is
 * grounded in the sim measurements (measure_artifacts.ts / measure_setup.ts): pick the highest-win-rate
 * artifact from what's offered, the measured-best synergy per fielded faction, spend the augment budget on the
 * universally-strong Armor/Might augments, take the max-budget doctrine (vision isn't the lever here — the
 * upgrade points are), and score creatures by the shared draft heuristic. Deterministic and vectorizable so a
 * later CEM pass can learn these tables/weights.
 */
export class SetupPolicyV0 implements ISetupPolicy {
    public readonly version: string = "setup-v0";
    /** Max upgrade-point budget among the real doctrines (SEE_NONE = 7) so the AI can afford Armor L3 + Might
     * L3. Vision isn't modelled/decisive here; the points are. */
    public pickPerk(): number {
        return Perk.SEE_NONE;
    }
    public pickBundle(bundles: readonly (readonly [number, number, number])[]): number {
        if (!bundles.length) {
            return 0;
        }
        let bestIdx = 0;
        let bestScore = -Infinity;
        bundles.forEach(([l1, l2, t1], idx) => {
            const score = scoreCreature(l1) + scoreCreature(l2) + (TIER1_ARTIFACT_WINRATE[t1] ?? 50);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = idx;
            }
        });
        return bestIdx;
    }
    public pickCreature(_level: number, available: readonly number[]): number {
        return bestBy(available, (id) => scoreCreature(id)) ?? available[0] ?? 0;
    }
    public pickArtifactT2(offered: readonly number[]): number {
        return bestBy(offered, (id) => TIER2_ARTIFACT_WINRATE[id] ?? 0) ?? offered[0] ?? 0;
    }
    public pickSynergies(creatureIds: readonly number[]): { faction: number; synergy: number }[] {
        const countByFaction = new Map<number, number>();
        for (const id of creatureIds) {
            const faction = CreatureFactions[id];
            if (faction) {
                countByFaction.set(faction, (countByFaction.get(faction) ?? 0) + 1);
            }
        }
        const out: { faction: number; synergy: number }[] = [];
        for (const [faction, count] of countByFaction) {
            // A synergy only reaches level 1 with 2+ units of the faction; skip factions that can't trigger.
            if (count >= 2 && BEST_SYNERGY_BY_FACTION[faction]) {
                out.push({ faction, synergy: BEST_SYNERGY_BY_FACTION[faction] });
            }
        }
        return out;
    }
    public bestSynergyForFaction(faction: number): number {
        return BEST_SYNERGY_BY_FACTION[faction] ?? 0;
    }
    public pickAugments(budget: number): { kind: "Armor" | "Might" | "Sniper" | "Movement"; value: number }[] {
        // Spend the FULL budget down the value-ranked list of net-POSITIVE augments (Armor > Might > Sniper),
        // highest affordable level each. Movement is skipped — it's measured net-negative (~45%), so a leftover
        // point is better spent on Sniper (~57%) or left unspent than sunk into it. This banks the CEM result
        // (cem_setup.mjs): the earlier "Armor+Might only" heuristic left 1 point of a 7-budget unspent, and
        // spending it on Sniper1 was worth ~+7.8pp on a held-out seed (train 58.5% / val 57.8%).
        const NET_POSITIVE = new Set<string>(["Armor", "Might", "Sniper"]);
        const out: { kind: "Armor" | "Might" | "Sniper" | "Movement"; value: number }[] = [];
        let remaining = Math.max(0, Math.floor(budget));
        for (const { kind, maxLevel } of AUGMENT_PRIORITY) {
            if (!NET_POSITIVE.has(kind)) {
                continue;
            }
            const level = Math.min(maxLevel, remaining);
            if (level >= 1) {
                out.push({ kind, value: level });
                remaining -= level;
            }
        }
        return out;
    }
}

/** Shared singleton — the policy is stateless. */
export const SETUP_POLICY_V0 = new SetupPolicyV0();
