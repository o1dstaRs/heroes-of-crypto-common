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

import { PBTypes } from "../../generated/protobuf/v1/types";
import { ChaosSynergy, LifeSynergy, MightSynergy, NatureSynergy } from "../../synergies/synergy_properties";
import { creatureInfo, type ICreatureInfo } from "./creature_score";

/**
 * SITUATIONAL synergy picker. The shipped heuristic picks a FIXED best-per-faction synergy (BEST_SYNERGY_BY_FACTION),
 * score each of the two effects per faction. Double synergies are now a ruleset property: once a faction reaches
 * the two-stack threshold, both of its effects are active. The scorer remains available for historical analysis,
 * while the live picker returns the complete pair rather than selecting an alternative.
 */

const F = PBTypes.FactionVals;

export interface ISynergyOption {
    faction: number;
    synergy: number;
    label: string;
    /** Per-creature beneficiary contribution — summed over the faction's fielded units. */
    benef: (c: ICreatureInfo) => number;
    /** True for the synergy the fixed BEST_SYNERGY_BY_FACTION table picks (sets the anchor bias). */
    tablePick: boolean;
}

export const SYNERGY_OPTIONS: readonly ISynergyOption[] = [
    // Life — +Supply (table) vs +Morale/Luck. Both broad → count units.
    {
        faction: F.LIFE,
        synergy: LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
        label: "life:supply",
        benef: () => 1,
        tablePick: true,
    },
    {
        faction: F.LIFE,
        synergy: LifeSynergy.PLUS_MORALE_AND_LUCK,
        label: "life:morale",
        benef: () => 1,
        tablePick: false,
    },
    // Chaos — Movement (table, helps melee close) vs Break-on-Attack (helps attackers vs armor).
    {
        faction: F.CHAOS,
        synergy: ChaosSynergy.MOVEMENT,
        label: "chaos:move",
        benef: (c) => (c.melee ? 1 : 0),
        tablePick: true,
    },
    { faction: F.CHAOS, synergy: ChaosSynergy.BREAK_ON_ATTACK, label: "chaos:break", benef: () => 1, tablePick: false },
    // Might — +Abilities-Power (table, scales with ability units) vs +Auras-Range (scales with aura carriers).
    {
        faction: F.MIGHT,
        synergy: MightSynergy.PLUS_AURAS_RANGE,
        label: "might:auras",
        benef: (c) => c.auraCount,
        tablePick: false,
    },
    {
        faction: F.MIGHT,
        synergy: MightSynergy.PLUS_STACK_ABILITIES_POWER,
        label: "might:abil",
        benef: (c) => c.abilityCount,
        tablePick: true,
    },
    // Nature — +Fly-Armor (table, needs flyers) vs Increase-Board-Units (more stacks; the "split" mechanic).
    {
        faction: F.NATURE,
        synergy: NatureSynergy.INCREASE_BOARD_UNITS,
        label: "nature:units",
        benef: () => 1,
        tablePick: false,
    },
    {
        faction: F.NATURE,
        synergy: NatureSynergy.PLUS_FLY_ARMOR,
        label: "nature:fly",
        benef: (c) => (c.canFly ? 1 : 0),
        tablePick: true,
    },
];

export const SYNERGY_DIM = SYNERGY_OPTIONS.length * 2; // 16 = 8 synergies x [bias, benefWeight]

/** Anchor = the fixed BEST_SYNERGY_BY_FACTION table: bias 1 for the table's pick, 0 for the other, benefWeight 0. */
export const SYNERGY_ANCHOR_W: readonly number[] = SYNERGY_OPTIONS.flatMap((o) => [o.tablePick ? 1 : 0, 0]);

export const SYNERGY_WEIGHTS_ENV = "V05_SYNERGY_WEIGHTS";

export const loadSynergyWeights = (): number[] => {
    const raw = process.env[SYNERGY_WEIGHTS_ENV];
    if (raw) {
        try {
            const p = JSON.parse(raw);
            if (Array.isArray(p) && p.length === SYNERGY_DIM && p.every((n) => Number.isFinite(n))) {
                return p;
            }
        } catch {
            /* malformed -> anchor */
        }
    }
    return SYNERGY_ANCHOR_W.slice();
};

/**
 * For each fielded faction (2+ units — the synergy activation threshold), return both effects. `w` is retained
 * for compatibility with historical optimizer callers; no learned score may suppress an effect the ruleset grants.
 */
export const pickSynergiesSituational = (
    creatureIds: readonly number[],
    _w: number[],
): { faction: number; synergy: number }[] => {
    const byFaction = new Map<number, ICreatureInfo[]>();
    for (const id of creatureIds) {
        const c = creatureInfo(id);
        if (!c || !c.faction) {
            continue;
        }
        const arr = byFaction.get(c.faction);
        if (arr) {
            arr.push(c);
        } else {
            byFaction.set(c.faction, [c]);
        }
    }
    const out: { faction: number; synergy: number }[] = [];
    for (const [faction, units] of byFaction) {
        if (units.length < 2) {
            continue; // a synergy only reaches level 1 with 2+ units of the faction
        }
        for (const option of SYNERGY_OPTIONS) {
            if (option.faction === faction) {
                out.push({ faction, synergy: option.synergy });
            }
        }
    }
    return out;
};
