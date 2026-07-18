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
    hp: number;
    armor: number;
    speed: number;
    abilities: string;
    /** movement_type === "FLY" — the beneficiary signal for Nature's +Fly-Armor synergy. */
    canFly: boolean;
    /** attack_type includes MELEE (MELEE or MELEE_MAGIC) — beneficiary for Chaos Movement. */
    melee: boolean;
    /** # abilities whose name contains "Aura" — beneficiary for Might's +Auras-Range synergy. */
    auraCount: number;
    /** # non-aura abilities — beneficiary for Might's +Stack-Abilities-Power synergy. */
    abilityCount: number;
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
            hp?: number;
            armor?: number;
            speed?: number;
            level?: number;
            abilities?: string[];
            movement_type?: string;
        }
    >
>;

const CREATURE_IDS_BY_ENUM_KEY = PBTypes.CreatureVals as unknown as Readonly<Record<string, number>>;

/** Browser-safe display-name lookup shared by runtime placement and simulation setup paths. */
export const creatureIdForName = (name: string): number | undefined => {
    const id = CREATURE_IDS_BY_ENUM_KEY[name.toUpperCase().replace(/ /g, "_")];
    return typeof id === "number" && id > 0 ? id : undefined;
};

/** id -> creature info, built once by inverting the CreatureVals enum against creatures.json (enum key =
 * NAME_UPPER_SNAKE, e.g. "Black Dragon" -> BLACK_DRAGON). Only creatures with a real enum id are indexed. */
const buildIndex = (): Map<number, ICreatureInfo> => {
    const index = new Map<number, ICreatureInfo>();
    for (const [, creatures] of Object.entries(CreatureJsonShape)) {
        if (!creatures || typeof creatures !== "object") {
            continue;
        }
        for (const [name, cfg] of Object.entries(creatures)) {
            if (!cfg || typeof cfg !== "object") {
                continue;
            }
            const id = creatureIdForName(name);
            if (id === undefined) {
                continue;
            }
            const abilityList = cfg.abilities ?? [];
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
                hp: cfg.hp ?? 0,
                armor: cfg.armor ?? 0,
                speed: cfg.speed ?? 0,
                abilities: abilityList.join(" "),
                canFly: cfg.movement_type === "FLY",
                melee: (cfg.attack_type ?? "").includes("MELEE"),
                auraCount: abilityList.filter((a) => a.includes("Aura")).length,
                abilityCount: abilityList.filter((a) => !a.includes("Aura")).length,
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

// ---------------------------------------------------------------------------
// TRAINABLE draft scorer — a linear feature decomposition of scoreCreature so a CEM pass can learn the
// draft weights (the pick-phase counterpart to the fight/setup vectors). DRAFT_ANCHOR_W reproduces
// scoreCreature EXACTLY, so the frozen anchor policy == today's heuristic draft; the weighted policy searches
// around it. Ranking-only (argmax/top-N over an offered set), so absolute scale/offset are irrelevant.
// ---------------------------------------------------------------------------

export const DRAFT_FEATURE_NAMES = [
    "level", // creature level (1..4)
    "exp", // stack experience/value
    "ranged", // 1 if a ranged attacker (they carry most fights)
    "rangedDmg", // max damage if ranged, else 0
    "meleeDmg", // max damage if melee, else 0
    "rangedShots", // shots if ranged, else 0
    "rangedDist", // shot distance if ranged, else 0
    "doubleShot",
    "throughShot",
    "areaThrow",
    "largeCaliber",
] as const;

export const DRAFT_FEATURE_DIM = DRAFT_FEATURE_NAMES.length;

/** Coefficients that make scoreCreatureWeighted(id, DRAFT_ANCHOR_W) === scoreCreature(id) (pre-round). This
 * stays the FROZEN training reference (the heuristic), unchanged so CEM gains are always measured against it. */
export const DRAFT_ANCHOR_W: readonly number[] = [35, 0.125, 95, 3, 1.2, 5, 6, 50, 70, 60, 45];

/**
 * Baked DRAFT vector — CO-EVOLUTION robust champion (agent-zinc node, 2026-07-05). Iterated best-response
 * self-play (each pass best-responds to the previous champion) CONVERGED to a MELEE-favoring draft that
 * DOMINATES every alternative in a worst-case round-robin: it beats the heuristic anchor 97.6%, a strong
 * trained RANGED draft 64.4%, and a melee-exploit variant 61.7% — worst case 61.7%, the ONLY draft that beats
 * all others. (An earlier ranged champion won 86% vs the anchor but is itself crushed by melee → 35.6%
 * worst-case, NOT robust; this replaced it.) Army composition is the single biggest AI lever, and melee beats
 * ranged vs the v0.5 fight AI — a possible melee/ranged balance signal worth a designer's eye. DEFAULT when no
 * V05_DRAFT_WEIGHTS env; pass DRAFT_ANCHOR_W via env to A/B against the pre-training heuristic.
 */
export const DEFAULT_DRAFT_W: readonly number[] = [
    22.1106, 0.5343, -90.8122, -2.8907, 3.3891, 7.2954, -9.0207, 47.2111, 74.5008, 35.7793, 5.6801,
];

export const DRAFT_WEIGHTS_ENV = "V05_DRAFT_WEIGHTS";

/** Feature vector for a creature id (aligned to DRAFT_FEATURE_NAMES). Zeros for an unknown id. */
export const creatureFeatures = (creatureId: number): number[] => {
    const c = creatureIndex().get(creatureId);
    if (!c) {
        return new Array(DRAFT_FEATURE_DIM).fill(0);
    }
    const r = c.ranged ? 1 : 0;
    return [
        c.level,
        c.exp,
        r,
        r ? c.maxDamage : 0,
        r ? 0 : c.maxDamage,
        r ? c.shots : 0,
        r ? c.distance : 0,
        c.abilities.includes("Double Shot") ? 1 : 0,
        c.abilities.includes("Through Shot") ? 1 : 0,
        c.abilities.includes("Area Throw") ? 1 : 0,
        c.abilities.includes("Large Caliber") ? 1 : 0,
    ];
};

/** Weighted draft score = w · features(id). Higher is a better pick. */
export const scoreCreatureWeighted = (creatureId: number, w: readonly number[]): number => {
    const f = creatureFeatures(creatureId);
    let s = 0;
    for (let i = 0; i < f.length; i += 1) {
        s += f[i] * (w[i] ?? 0);
    }
    return s;
};

/** Active draft weights: process.env.V05_DRAFT_WEIGHTS (JSON number[]) for CEM/A-B, else the anchor. */
export const loadDraftWeights = (): number[] => {
    const raw = process.env[DRAFT_WEIGHTS_ENV];
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (
                Array.isArray(parsed) &&
                parsed.length === DRAFT_FEATURE_DIM &&
                parsed.every((n) => typeof n === "number" && Number.isFinite(n))
            ) {
                return parsed as number[];
            }
        } catch {
            /* malformed -> baked default */
        }
    }
    return DEFAULT_DRAFT_W.slice();
};
