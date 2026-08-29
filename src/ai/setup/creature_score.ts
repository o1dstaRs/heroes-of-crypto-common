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
import { AbilityPowerType } from "../../abilities/ability_properties";
import { DOUBLE_SHOT_ABILITY_NAMES } from "../../abilities/double_shot_names";
import { getAbilityConfig, getCreatureConfig, getSpellConfig } from "../../configuration/config_provider";
import { CreatureFactions, CreatureLevels } from "../../generated/protobuf/v1/creature_gen";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { normalizeFootprintSide } from "../../grid/grid_math";
import { isOffensiveSpellMultiplier } from "../../spells/spell_damage";
import { SpellPowerType } from "../../spells/spell_properties";

/**
 * Whether a creature's printed kit lands a second ranged attack. Drafting reads the ability NAMES off the
 * catalog rather than a live Unit, so it asks the shared roster directly — otherwise a new member of the
 * family (Gargantuan's Double Throw) silently loses the second-shot weight the bot drafts on.
 */
const shootsTwice = (abilities: string): boolean =>
    DOUBLE_SHOT_ABILITY_NAMES.some((abilityName) => abilities.includes(abilityName));

export const RANKED_SPELL_RANGED_DRAFT_POLICY_ID = "ranked-spell-ranged-v1" as const;
export type RankedSpellRangedDraftPolicyId = typeof RANKED_SPELL_RANGED_DRAFT_POLICY_ID;

export const isRankedSpellRangedDraftPolicy = (value: unknown): value is RankedSpellRangedDraftPolicyId =>
    value === RANKED_SPELL_RANGED_DRAFT_POLICY_ID;

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
    /** attack_type === "MAGIC" — a back-line spellcaster/support rather than a melee-magic hybrid. */
    mage: boolean;
    /** Owns at least one native spell charge or castable ability, including MELEE_MAGIC hybrids. */
    caster: boolean;
    /** Owns at least one configured native spellbook entry; excludes direct-cast abilities. */
    nativeSpellbook: boolean;
    /** Owns a direct-damage spell that can reach an enemy or board area without a native ranged attack. */
    rangedSpellDamage: boolean;
    maxDamage: number;
    shots: number;
    distance: number;
    exp: number;
    hp: number;
    armor: number;
    initiative: number;
    abilities: string;
    /** movement_type === "FLY" — the beneficiary signal for Nature's +Fly-Armor synergy. */
    canFly: boolean;
    /** attack_type includes MELEE (MELEE or MELEE_MAGIC) — beneficiary for Chaos Movement. */
    melee: boolean;
    /** # abilities whose name contains "Aura" — beneficiary for Might's +Auras-Range synergy. */
    auraCount: number;
    /** # non-aura abilities — beneficiary for Might's +Stack-Abilities-Power synergy. */
    abilityCount: number;
    /** Has at least one positive-power, non-healing buff that this unit can actively cast. */
    castsAmplifiableBuff: boolean;
    /** Buffs allied magic damage through Nightmare's Empower or an ADDITIONAL_MAGIC_DAMAGE_PERCENTAGE aura. */
    magicDamageAmplifier: boolean;
    /**
     * The board rectangle this creature's stack occupies, in cells: `footprintWidth` columns (x) by
     * `footprintHeight` rows (y). Draft and the reveal-conditioned placement policies only ever hold a
     * creature ID — there is no Unit to ask before the army exists — so shape has to travel with the
     * identity, or a policy that reserves zone depth, screens a firing line or measures a gap has to guess.
     *
     * This is the shape the engine will actually build the stack with, resolved through the engine's own
     * creature config rather than read off the catalog row — see resolveCreatureFootprint below for why the
     * two are not the same thing. The shipped roster is entirely square, so every creature reports 1x1 or 2x2.
     *
     * Descriptive ONLY. These are deliberately absent from DRAFT_FEATURE_NAMES: the baked DRAFT_ANCHOR_W /
     * DEFAULT_DRAFT_W vectors are fit on that fixed basis, and pricing a footprint as cost or value is a
     * balance decision rather than a geometry fix.
     */
    footprintWidth: number;
    footprintHeight: number;
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
            initiative?: number;
            level?: number;
            spells?: string[];
            abilities?: string[];
            movement_type?: string;
            size?: number;
            footprint_width?: number;
            footprint_height?: number;
        }
    >
>;

const CREATURE_IDS_BY_ENUM_KEY = PBTypes.CreatureVals as unknown as Readonly<Record<string, number>>;

/**
 * Whether an ability actually projects an aura effect, asked of the config rather than of its NAME.
 *
 * This used to test `name.includes("Aura")`, which held only while every aura ability happened to be
 * called one. Renaming the Squire's to "Arcane Ward Blessing" — it reaches the whole army now, so the word
 * was a lie — silently dropped the Squire from auraCount, and with it the "aura-heavy" cohort tag that the
 * setup search, the draft evaluator and the placement panels all key off. The declaration is the fact; the
 * name is decoration.
 */
const carriesAuraEffect = (abilityName: string): boolean => {
    try {
        return !!getAbilityConfig(abilityName)?.aura_effect;
    } catch {
        return false;
    }
};

const isAmplifiableBuffSpell = (faction: string, name: string): boolean => {
    try {
        const spell = getSpellConfig(faction, name);
        return (
            spell.is_buff &&
            spell.power !== 0 &&
            spell.power_type !== SpellPowerType.HEAL &&
            spell.power_type !== SpellPowerType.RESURRECT
        );
    } catch {
        return false;
    }
};

const isAmplifiableSpellbookEntry = (entry: string): boolean => {
    const separator = entry.indexOf(":");
    if (separator < 0) return false;
    return isAmplifiableBuffSpell(entry.slice(0, separator), entry.slice(separator + 1));
};

const isRangedDamageSpellbookEntry = (entry: string): boolean => {
    const separator = entry.indexOf(":");
    if (separator < 0) return false;
    try {
        const spell = getSpellConfig(entry.slice(0, separator), entry.slice(separator + 1));
        // This is the same contract used by the engine and tactical AI before they call calculateSpellDamage.
        // Target shape alone is not damage: Wandering Mage's Smoke and Misfortune both target at range, but neither
        // is an offensive magic hit and neither should make an army look like a mage battery.
        return !spell.is_buff && isOffensiveSpellMultiplier(spell.multiplier_type);
    } catch {
        return false;
    }
};

const isMagicDamageAmplifyingSpellbookEntry = (entry: string): boolean => {
    const separator = entry.indexOf(":");
    if (separator < 0) return false;
    try {
        const spell = getSpellConfig(entry.slice(0, separator), entry.slice(separator + 1));
        // Unit.getMagicDamageBonusPercentage reads this exact active buff alongside the team's Empower augment.
        return spell.is_buff && spell.name === "Empower";
    } catch {
        return false;
    }
};

const isMagicDamageAmplifyingAbility = (name: string): boolean => {
    try {
        return getAbilityConfig(name).power_type === AbilityPowerType.ADDITIONAL_MAGIC_DAMAGE_PERCENTAGE;
    } catch {
        return false;
    }
};

const isAmplifiableCastableAbility = (name: string): boolean => {
    try {
        return getAbilityConfig(name).can_be_cast && isAmplifiableBuffSpell("System", name);
    } catch {
        return false;
    }
};

const isCastableAbility = (name: string): boolean => {
    try {
        return getAbilityConfig(name).can_be_cast;
    } catch {
        return false;
    }
};

/** Browser-safe display-name lookup shared by runtime placement and simulation setup paths. */
export const creatureIdForName = (name: string): number | undefined => {
    const id = CREATURE_IDS_BY_ENUM_KEY[name.toUpperCase().replace(/ /g, "_")];
    return typeof id === "number" && id > 0 ? id : undefined;
};

/**
 * The footprint the ENGINE will give this creature's stack, which is not always the one its catalog row
 * declares: HOC_FOOTPRINT_OVERRIDES (and its browser twin `globalThis.__hocFootprintOverrides`) can reshape a
 * creature without touching creatures.json, and today that override is the ONLY way a rectangle reaches the
 * board at all. Reading the row directly would therefore leave the draft and the reveal-conditioned placement
 * policies planning around a 1x1 body that the engine then places as a 2x1 — and an anchor chosen for the
 * wrong shape is not a weak move, it is an action the engine rejects.
 *
 * Asking getCreatureConfig keeps the resolution order (override, then declared footprint, then the legacy
 * square `size`) in the one place that owns it instead of copying it here, where it could drift. The cost is
 * paid once per index build. A catalog row too malformed to build full UnitProperties from falls back to the
 * declared shape: this index is a draft convenience, and it must not be the thing that takes a match down.
 */
const resolveCreatureFootprint = (
    factionName: string,
    creatureName: string,
    cfg: { size?: number; footprint_width?: number; footprint_height?: number },
): { width: number; height: number } => {
    try {
        const properties = getCreatureConfig(
            PBTypes.TeamVals.LEFT,
            factionName,
            creatureName,
            // Only the art tier is derived from this name, and nothing here looks at textures.
            `${creatureName.replace(/ /g, "_")}_512`,
            1,
        );
        return { width: properties.footprint_width, height: properties.footprint_height };
    } catch {
        return {
            width: normalizeFootprintSide(cfg.footprint_width, cfg.size ?? 1),
            height: normalizeFootprintSide(cfg.footprint_height, cfg.size ?? 1),
        };
    }
};

/** id -> creature info, built by inverting the CreatureVals enum against creatures.json (enum key =
 * NAME_UPPER_SNAKE, e.g. "Black Dragon" -> BLACK_DRAGON). Only creatures with a real enum id are indexed. */
const buildIndex = (): Map<number, ICreatureInfo> => {
    const index = new Map<number, ICreatureInfo>();
    for (const [factionName, creatures] of Object.entries(CreatureJsonShape)) {
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
            const spellList = cfg.spells ?? [];
            const footprint = resolveCreatureFootprint(factionName, name, cfg);
            index.set(id, {
                id,
                name,
                level: cfg.level ?? CreatureLevels[id] ?? 1,
                faction: CreatureFactions[id] ?? 0,
                ranged: cfg.attack_type === "RANGE",
                mage: cfg.attack_type === "MAGIC",
                caster: spellList.length > 0 || abilityList.some(isCastableAbility),
                nativeSpellbook: spellList.length > 0,
                rangedSpellDamage: spellList.some(isRangedDamageSpellbookEntry),
                maxDamage: cfg.attack_damage_max ?? 0,
                shots: cfg.range_shots ?? 0,
                distance: cfg.shot_distance ?? 0,
                exp: cfg.exp ?? 0,
                hp: cfg.hp ?? 0,
                armor: cfg.armor ?? 0,
                initiative: cfg.initiative ?? 0,
                abilities: abilityList.join(" "),
                canFly: cfg.movement_type === "FLY",
                melee: (cfg.attack_type ?? "").includes("MELEE"),
                auraCount: abilityList.filter(carriesAuraEffect).length,
                abilityCount: abilityList.filter((a) => !carriesAuraEffect(a)).length,
                castsAmplifiableBuff:
                    spellList.some(isAmplifiableSpellbookEntry) || abilityList.some(isAmplifiableCastableAbility),
                magicDamageAmplifier:
                    spellList.some(isMagicDamageAmplifyingSpellbookEntry) ||
                    abilityList.some(isMagicDamageAmplifyingAbility),
                footprintWidth: footprint.width,
                footprintHeight: footprint.height,
            });
        }
    }
    return index;
};

/**
 * The raw override string, read only to notice that it CHANGED — the grammar stays in config_provider, this
 * is a cache key and not a second parser. config_provider deliberately re-reads the overrides on every unit
 * build so a shape can be flipped mid-session; an index cached for the life of the process would keep
 * answering with the shape from before the flip, which is exactly the engine/AI disagreement the resolution
 * above exists to remove. Reading it is free in the runtimes the sims and the server use, and the index is
 * only ever rebuilt when the string actually differs.
 */
const footprintOverrideSource = (): string => {
    const injected = (globalThis as { __hocFootprintOverrides?: unknown }).__hocFootprintOverrides;
    if (typeof injected === "string" && injected) {
        return injected;
    }
    // `process` is absent in the browser bundle and `env` can be absent in exotic hosts.
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.HOC_FOOTPRINT_OVERRIDES ?? "";
};

let indexCache: Map<number, ICreatureInfo> | undefined;
let indexCacheFootprintOverrides: string | undefined;
const creatureIndex = (): Map<number, ICreatureInfo> => {
    const footprintOverrides = footprintOverrideSource();
    if (!indexCache || indexCacheFootprintOverrides !== footprintOverrides) {
        indexCache = buildIndex();
        indexCacheFootprintOverrides = footprintOverrides;
    }
    return indexCache;
};

export const creatureInfo = (creatureId: number): ICreatureInfo | undefined => creatureIndex().get(creatureId);

export const isRangedDamageCreature = (creatureId: number): boolean => {
    const info = creatureIndex().get(creatureId);
    return !!info && (info.ranged || info.rangedSpellDamage);
};

export const rankedSpellRangedCoPlayAffinity = (creatureId: number, ownCreatureIds: readonly number[]): number => {
    const candidate = creatureIndex().get(creatureId);
    if (!candidate) return 0;
    const own = [...new Set(ownCreatureIds)].map((ownCreatureId) => creatureIndex().get(ownCreatureId));
    const hasOffensiveSpellcaster = own.some((info) => info?.rangedSpellDamage);
    const hasMagicDamageAmplifier = own.some((info) => info?.magicDamageAmplifier);
    if (candidate.rangedSpellDamage && hasMagicDamageAmplifier) return 0.18;
    if (candidate.magicDamageAmplifier && hasOffensiveSpellcaster) return 0.18;
    return 0;
};

/** The two level-4 stacks whose tactical value is specifically tied to screening a fragile back line. */
export const isBacklineProtectorCreature = (creatureId: number): boolean => {
    const info = creatureIndex().get(creatureId);
    return !!info && (info.name === "Abomination" || info.name === "Arachna Queen");
};

/** Native shooters and any spell-bearing stack are the assets Abomination/Queen are intended to screen. */
export const isBacklineProtectionBeneficiaryCreature = (creatureId: number): boolean => {
    const info = creatureIndex().get(creatureId);
    return !!info && (info.ranged || info.caster);
};

export const backlineProtectionBeneficiaryCount = (creatureIds: readonly number[]): number =>
    creatureIds.reduce((count, creatureId) => count + Number(isBacklineProtectionBeneficiaryCreature(creatureId)), 0);

/** One opportunistic caster is not a "backline army"; two independent assets make the protector slot coherent. */
export const MIN_ABOMINATION_BACKLINE_BENEFICIARIES = 2;

const ALWAYS_DURABLE_HEAL_ANCHOR_NAMES = new Set(["Abomination", "Frenzied Boar", "Goblin Knight"]);

const hasNamedCreature = (creatureIds: readonly number[], names: ReadonlySet<string>): boolean =>
    creatureIds.some((creatureId) => {
        const name = creatureIndex().get(creatureId)?.name;
        return !!name && names.has(name);
    });

/**
 * Fair, public-context role fit layered over either the hand heuristic or a shipped intrinsic genome. The
 * multiplier deliberately does not inspect positions or hidden picks:
 *  - Wandering Mage becomes a real counter-pick only after enemy shooters are revealed.
 *  - A Healer and its durable anchor reinforce each other in whichever one is selected later.
 *  - Angel is preferred as a ranged-line screen when both armies actually field a firing line.
 *
 * Intrinsic weights remain immutable/trainable; this small role head prevents a composition-independent argmax
 * from selecting a support unit in the exact matchup where its defining spell/aura has no target.
 */
export const creatureRoleFitMultiplier = (
    creatureId: number,
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
): number => {
    const info = creatureIndex().get(creatureId);
    if (!info) return 1;
    const knownEnemyShooters = knownOpponentCreatureIds.reduce(
        (count, opponentId) => count + Number(creatureIndex().get(opponentId)?.ranged),
        0,
    );
    const ownBackline = backlineProtectionBeneficiaryCount(ownCreatureIds);
    const ownHasHealer = ownCreatureIds.some((id) => creatureIndex().get(id)?.name === "Healer");
    const ownAngelHasActiveScreen =
        knownEnemyShooters > 0 &&
        ownCreatureIds.some((id) => creatureIndex().get(id)?.name === "Angel") &&
        backlineProtectionBeneficiaryCount(ownCreatureIds.filter((id) => creatureIndex().get(id)?.name !== "Angel")) >=
            2;
    const ownHasDurableAnchor =
        hasNamedCreature(ownCreatureIds, ALWAYS_DURABLE_HEAL_ANCHOR_NAMES) || ownAngelHasActiveScreen;
    const candidateAngelHasActiveScreen = info.name === "Angel" && ownBackline >= 2 && knownEnemyShooters > 0;

    if (info.name === "Wandering Mage" && knownEnemyShooters > 0) {
        return knownEnemyShooters >= 2 ? 3 : 2.25;
    }

    let multiplier = 1;
    if (info.name === "Healer" && ownHasDurableAnchor) multiplier *= 2;
    if (ownHasHealer && (ALWAYS_DURABLE_HEAL_ANCHOR_NAMES.has(info.name) || candidateAngelHasActiveScreen)) {
        multiplier *= 1.25;
    }
    // Angel can satisfy two independent composition jobs: a Healer sustain anchor and a firing-line screen.
    // Preserve both signals instead of letting whichever branch happens to run first erase the other.
    if (candidateAngelHasActiveScreen) multiplier *= 1.5;
    return multiplier;
};

/**
 * Apply a role-fit boost without assuming a learned score is positive. Multiplication promotes positive scores,
 * but would make a negative score more negative and therefore punish the exact counter-pick we meant to help.
 * Dividing a negative score by the same >=1 multiplier preserves score ordering semantics while moving it
 * monotonically toward zero.
 */
export const applyCreatureRoleFitMultiplier = (score: number, multiplier: number): number => {
    if (!Number.isFinite(score) || !Number.isFinite(multiplier) || multiplier <= 1) return score;
    return score >= 0 ? score * multiplier : score / multiplier;
};

/**
 * Hard draft-safety layer shared by live ranked and league training. A protector without a shooter or
 * spell-bearing ward is a role mismatch, so remove it whenever the offer contains any ordinary legal
 * alternative. If every legal choice is a protector, retain the original offer: the draft must still progress.
 */
export const eligibleBacklineProtectorChoices = (
    available: readonly number[],
    ownCreatureIds: readonly number[],
    knownOpponentCreatureIds: readonly number[],
): readonly number[] => {
    const backlineCount = backlineProtectionBeneficiaryCount(ownCreatureIds);
    const hasAbominationArmy = backlineCount >= MIN_ABOMINATION_BACKLINE_BENEFICIARIES;
    const hasWard = backlineCount > 0;
    const knownFlyer = knownOpponentCreatureIds.some((creatureId) => creatureIndex().get(creatureId)?.canFly);
    const ordinary = available.filter((creatureId) => {
        const name = creatureIndex().get(creatureId)?.name;
        if (name === "Abomination") return hasAbominationArmy;
        if (name === "Arachna Queen") return hasWard && knownFlyer;
        return true;
    });
    return ordinary.length ? ordinary : available;
};

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
        (shootsTwice(c.abilities) ? 50 : 0) +
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
        shootsTwice(c.abilities) ? 1 : 0,
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
