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

import CREATURES_JSON from "../../configuration/creatures.json";
import { CreatureFactions, CreatureLevels } from "../../generated/protobuf/v1/creature_gen";
import { PBTypes } from "../../generated/protobuf/v1/types";

/**
 * Draft-time creature evaluation shared by the setup AI (server draft) and the sim. A creature is
 * addressed by its CreatureVals enum id (what the ranked pick document stores). This mirrors the heuristic
 * the client's LocalModelDraftOpponent uses, but is self-contained in common so the server and sim share
 * one implementation: score = level weight + a pressure term (damage/shots/range/key abilities), with a
 * strong bonus for ranged units (they decide most fights) — matching the measured "ranged/AoE artifacts &
 * augments dominate" signal.
 */
export interface ICreatureInfo {
    id: number;
    name: string;
    level: number;
    faction: number;
    ranged: boolean;
    maxDamage: number;
    shots: number;
    distance: number;
    exp: number;
    abilities: string;
}

const CreatureJsonShape = CREATURES_JSON as unknown as Record<
    string,
    Record<
        string,
        {
            attack_type?: string;
            attack_damage_max?: number;
            range_shots?: number;
            shot_distance?: number;
            exp?: number;
            level?: number;
            abilities?: string[];
        }
    >
>;

/** id -> creature info, built once by inverting the CreatureVals enum against creatures.json (enum key =
 * NAME_UPPER_SNAKE, e.g. "Black Dragon" -> BLACK_DRAGON). Only creatures with a real enum id are indexed. */
const buildIndex = (): Map<number, ICreatureInfo> => {
    const idByEnumKey = PBTypes.CreatureVals as unknown as Record<string, number>;
    const index = new Map<number, ICreatureInfo>();
    for (const [, creatures] of Object.entries(CreatureJsonShape)) {
        if (!creatures || typeof creatures !== "object") {
            continue;
        }
        for (const [name, cfg] of Object.entries(creatures)) {
            if (!cfg || typeof cfg !== "object") {
                continue;
            }
            const enumKey = name.toUpperCase().replace(/ /g, "_");
            const id = idByEnumKey[enumKey];
            if (typeof id !== "number" || id <= 0) {
                continue;
            }
            index.set(id, {
                id,
                name,
                level: cfg.level ?? CreatureLevels[id] ?? 1,
                faction: CreatureFactions[id] ?? 0,
                ranged: cfg.attack_type === "RANGE",
                maxDamage: cfg.attack_damage_max ?? 0,
                shots: cfg.range_shots ?? 0,
                distance: cfg.shot_distance ?? 0,
                exp: cfg.exp ?? 0,
                abilities: (cfg.abilities ?? []).join(" "),
            });
        }
    }
    return index;
};

let indexCache: Map<number, ICreatureInfo> | undefined;
const creatureIndex = (): Map<number, ICreatureInfo> => {
    if (!indexCache) {
        indexCache = buildIndex();
    }
    return indexCache;
};

export const creatureInfo = (creatureId: number): ICreatureInfo | undefined => creatureIndex().get(creatureId);

/**
 * Standalone draft value of a creature. Higher is better. Ranged units and high-pressure abilities are
 * favoured (they carry most games); exp/level break ties toward stronger stacks.
 */
export const scoreCreature = (creatureId: number): number => {
    const c = creatureIndex().get(creatureId);
    if (!c) {
        return 0;
    }
    const rangedBonus = c.ranged ? 95 : 0;
    const pressure =
        c.maxDamage * (c.ranged ? 3 : 1.2) +
        c.shots * (c.ranged ? 5 : 0) +
        c.distance * (c.ranged ? 6 : 0) +
        (c.abilities.includes("Double Shot") ? 50 : 0) +
        (c.abilities.includes("Through Shot") ? 70 : 0) +
        (c.abilities.includes("Area Throw") ? 60 : 0) +
        (c.abilities.includes("Large Caliber") ? 45 : 0);
    return Math.round(c.level * 35 + c.exp / 8 + rangedBonus + pressure);
};
