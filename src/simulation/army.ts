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

import { AbilityFactory } from "../abilities/ability_factory";
import { getCreatureConfig } from "../configuration/config_provider";
import CREATURES_JSON from "../configuration/creatures.json";
import { EffectFactory } from "../effects/effect_factory";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { GridSettings } from "../grid/grid_settings";
import { Unit } from "../units/unit";
import { uuidFromBytes } from "../utils/lib";

/** A single creature stack picked for a roster. */
export interface IArmyUnitSpec {
    faction: string;
    creatureName: string;
    level: number;
    /** 1 = small (1x1), 2 = large (2x2). */
    size: number;
    /** Number of creatures in the stack. */
    amount: number;
}

/** How many stacks of each level make up a roster, e.g. 2×L1, 2×L2, 1×L3, 1×L4. */
export interface IRosterComposition {
    level: number;
    count: number;
}

export const DEFAULT_ROSTER_COMPOSITION: readonly IRosterComposition[] = [
    { level: 1, count: 2 },
    { level: 2, count: 2 },
    { level: 3, count: 1 },
    { level: 4, count: 1 },
];

/** Default stack sizes per level (same for both teams, so they never bias the comparison). */
export const DEFAULT_AMOUNT_BY_LEVEL: Readonly<Record<number, number>> = { 1: 50, 2: 30, 3: 15, 4: 8 };

/** LIVE-server stack sizing: every stack is worth ~this much creature experience (server play_session.ts
 * STACK_EXPERIENCE_BUDGET). A stack's amount is ceil(budget / creature exp), so cheap L1 creatures field
 * ~73-200 bodies while an L4 fields 1-3 — very different from the sim's historical {50,30,15,8} table. */
export const STACK_EXPERIENCE_BUDGET = 1000;

/**
 * How roster stack AMOUNTS are sized:
 *  - 'levelTable' (default): the historical per-level table (DEFAULT_AMOUNT_BY_LEVEL / options.amountByLevel).
 *    Byte-identical to every run before this mode existed.
 *  - 'expBudget': the LIVE server rule — per-CREATURE ceil(STACK_EXPERIENCE_BUDGET / exp) (a port of the
 *    server's creature_lookup.ts amountForCreatureExperienceBudget). A level table CANNOT express this
 *    (creatures of one level differ, e.g. Centaur 73 vs Peasant 200), hence a per-creature resolver.
 */
export type StackAmountMode = "levelTable" | "expBudget";

/** creatures.json `exp` for an enabled creature (by display name), else undefined. */
export function getCreatureExperience(creatureName: string): number | undefined {
    const entry = getCatalog().find((e) => e.creatureName === creatureName);
    const exp = entry?.exp;
    return typeof exp === "number" && exp > 0 ? exp : undefined;
}

/**
 * Port of the server's `amountForCreatureExperienceBudget` (creature_lookup.ts), keyed by creature name
 * (the sim's roster key) instead of enum id: how many creatures fit the experience budget, at least 1.
 * Unknown creature / invalid budget -> fallbackAmount, exactly like the server.
 */
export function amountForCreatureExperienceBudget(
    creatureName: string,
    experienceBudget: number,
    fallbackAmount: number,
): number {
    const exp = getCreatureExperience(creatureName);
    if (!exp || !Number.isFinite(experienceBudget) || experienceBudget <= 0) {
        return fallbackAmount;
    }
    return Math.max(1, Math.ceil(experienceBudget / exp));
}

/** Resolve one stack's amount under the given mode (expBudget falls back to the level table if exp is missing). */
export function resolveStackAmount(
    creatureName: string,
    level: number,
    amountByLevel: Readonly<Record<number, number>>,
    amountMode: StackAmountMode,
): number {
    const tableAmount = amountByLevel[level] ?? 1;
    if (amountMode === "expBudget") {
        return amountForCreatureExperienceBudget(creatureName, STACK_EXPERIENCE_BUDGET, tableAmount);
    }
    return tableAmount;
}

/** Deterministic PRNG (mulberry32) so a recorded seed reproduces a roster exactly. */
export function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export type SimulationIdentityPart = string | number | boolean;

/** Stable non-cryptographic hash for simulation identity and private rollout seeds. */
export function hashSimulationParts(...parts: readonly SimulationIdentityPart[]): number {
    let hash = 0x811c9dc5;
    for (const part of parts) {
        const value = String(part);
        const framed = `${value.length}:${value}|`;
        for (let i = 0; i < framed.length; i += 1) {
            hash = Math.imul(hash ^ framed.charCodeAt(i), 0x01000193) >>> 0;
        }
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
    return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Produce a stable UUID-shaped id without touching secure randomness. The four salted words make collisions
 * negligible for the handful of stacks in one match while preserving the UUID format expected by serializers.
 */
export function deterministicSimulationId(...parts: readonly SimulationIdentityPart[]): string {
    const bytes = new Uint8Array(16);
    for (let word = 0; word < 4; word += 1) {
        const value = hashSimulationParts("simulation-unit", word, ...parts);
        const offset = word * 4;
        bytes[offset] = value >>> 24;
        bytes[offset + 1] = value >>> 16;
        bytes[offset + 2] = value >>> 8;
        bytes[offset + 3] = value;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return uuidFromBytes(bytes);
}

interface ICatalogEntry {
    faction: string;
    creatureName: string;
    level: number;
    size: number;
    /** creatures.json attack_type — "MELEE" | "RANGE" | "MELEE_MAGIC" | "MAGIC". */
    attackType: string;
    /** creatures.json movement_type — "WALK" | "FLY" (canFly cohort filter; same field creature_score.ts reads). */
    movementType?: string;
    /** creatures.json exp — the creature's experience cost (drives the live exp-budget stack sizing). */
    exp?: number;
}

let catalogCache: ICatalogEntry[] | undefined;

const creatureEnum = PBTypes.CreatureVals as unknown as Record<string, number>;

/**
 * Only creatures that have a CreatureVals enum id are actually ENABLED in the game — creatures.json
 * also carries disabled/unreleased entries (e.g. Faerie Dragon, which has no enum id). This mirrors
 * the server's creature_lookup (it keys names to the enum), so rosters never field a disabled unit.
 */
function isCreatureEnabled(creatureName: string): boolean {
    const enumKey = creatureName.toUpperCase().replace(/ /g, "_");
    const id = creatureEnum[enumKey];
    return typeof id === "number" && id > 0;
}

function getCatalog(): ICatalogEntry[] {
    if (catalogCache) {
        return catalogCache;
    }
    const json = CREATURES_JSON as unknown as Record<
        string,
        Record<string, { level?: number; size?: number; attack_type?: string; movement_type?: string; exp?: number }>
    >;
    const entries: ICatalogEntry[] = [];
    for (const faction of Object.keys(json)) {
        const factionCreatures = json[faction];
        if (!factionCreatures || typeof factionCreatures !== "object") {
            continue; // skips the top-level "version" string
        }
        for (const creatureName of Object.keys(factionCreatures)) {
            const cfg = factionCreatures[creatureName];
            if (
                cfg &&
                typeof cfg.level === "number" &&
                typeof cfg.size === "number" &&
                isCreatureEnabled(creatureName)
            ) {
                entries.push({
                    faction,
                    creatureName,
                    level: cfg.level,
                    size: cfg.size,
                    attackType: cfg.attack_type ?? "MELEE",
                    movementType: cfg.movement_type,
                    exp: typeof cfg.exp === "number" && cfg.exp > 0 ? cfg.exp : undefined,
                });
            }
        }
    }
    catalogCache = entries;
    return entries;
}

export function creaturesByLevel(level: number, faction?: string): ICatalogEntry[] {
    const byLevel = getCatalog().filter((e) => e.level === level);
    if (!faction) {
        return byLevel;
    }
    // Restrict to the faction when asked (synergy measurement fields a faction-stacked army); fall back to
    // the full pool for any level that faction doesn't cover, so a roster can always be built.
    const byFaction = byLevel.filter((e) => e.faction.toLowerCase() === faction.toLowerCase());
    return byFaction.length ? byFaction : byLevel;
}

/**
 * Build one roster (list of stacks) from the composition. Both teams in a match receive an identical
 * copy of this list, so the only difference between the sides is the AI driving them.
 */
/**
 * Diagnostic-only: force specific creatures into a level's first slot via FORCE_CREATURES, e.g.
 * `FORCE_CREATURES="2:Pikeman,4:Black Dragon"`. Lets an A/B target a specific matchup without changing
 * the random rng sequence (the pick is still rolled, then overridden), so runs stay reproducible.
 */
function forcedByLevel(): Record<number, string> {
    const raw = process.env.FORCE_CREATURES;
    if (!raw) {
        return {};
    }
    const out: Record<number, string> = {};
    for (const part of raw.split(",")) {
        const [lvl, name] = part.split(":");
        if (lvl && name) {
            out[Number(lvl)] = name.trim();
        }
    }
    return out;
}

/**
 * Diagnostic-only: constrain the number of RANGE (ranged-attacker) stacks per roster via
 * ROSTER_RANGED_MIN / ROSTER_RANGED_MAX, e.g. `ROSTER_RANGED_MIN=2 ROSTER_RANGED_MAX=3` for range-heavy
 * armies. Applied by rejection sampling (rebuild until the RANGE count is in range), so it stays fully
 * deterministic for a given seed — the retries consume the same rng stream. Off by default (no env set),
 * so existing runs are unaffected.
 *
 * ROSTER_FLYER_MIN / ROSTER_FLYER_MAX (canFly, movement_type "FLY") and ROSTER_CASTER_MIN /
 * ROSTER_CASTER_MAX (attack_type "MAGIC" or "MELEE_MAGIC" — the same isCaster definition
 * value_features.ts's extractValueFeaturesV2Raw already uses) extend the identical rejection-sampling
 * pattern to two more own-composition dimensions (2026-07-15, W11 flyer/caster cohort probes), e.g.
 * `ROSTER_FLYER_MIN=2` for flyer-heavy armies or `ROSTER_CASTER_MIN=2` for caster-heavy armies. All three
 * constraints are independent and may be combined; none is active unless its env is set.
 */
interface IRosterCountConstraint {
    min: number;
    max: number;
}

function countConstraint(envMin: string, envMax: string): IRosterCountConstraint | undefined {
    const min = process.env[envMin];
    const max = process.env[envMax];
    if (min === undefined && max === undefined) {
        return undefined;
    }
    return {
        min: min !== undefined ? Number(min) : 0,
        max: max !== undefined ? Number(max) : Number.MAX_SAFE_INTEGER,
    };
}

const rangedConstraint = (): IRosterCountConstraint | undefined =>
    countConstraint("ROSTER_RANGED_MIN", "ROSTER_RANGED_MAX");
const flyerConstraint = (): IRosterCountConstraint | undefined =>
    countConstraint("ROSTER_FLYER_MIN", "ROSTER_FLYER_MAX");
const casterConstraint = (): IRosterCountConstraint | undefined =>
    countConstraint("ROSTER_CASTER_MIN", "ROSTER_CASTER_MAX");

const isCasterAttackType = (attackType: string): boolean => attackType === "MAGIC" || attackType === "MELEE_MAGIC";

export function buildRoster(
    rng: () => number,
    composition: readonly IRosterComposition[] = DEFAULT_ROSTER_COMPOSITION,
    amountByLevel: Readonly<Record<number, number>> = DEFAULT_AMOUNT_BY_LEVEL,
    factionFilter?: string,
    amountMode: StackAmountMode = "levelTable",
): IArmyUnitSpec[] {
    const forced = forcedByLevel();
    const buildOnce = (): { roster: IArmyUnitSpec[]; ranged: number; flyer: number; caster: number } => {
        const roster: IArmyUnitSpec[] = [];
        let ranged = 0;
        let flyer = 0;
        let caster = 0;
        for (const { level, count } of composition) {
            const pool = creaturesByLevel(level, factionFilter);
            if (!pool.length) {
                throw new Error(`No creatures found for level ${level}`);
            }
            for (let i = 0; i < count; i += 1) {
                let pick = pool[Math.floor(rng() * pool.length)];
                if (i === 0 && forced[level]) {
                    const forcedPick = pool.find((p) => p.creatureName === forced[level]);
                    if (forcedPick) {
                        pick = forcedPick;
                    }
                }
                if (pick.attackType === "RANGE") {
                    ranged += 1;
                }
                if (pick.movementType === "FLY") {
                    flyer += 1;
                }
                if (isCasterAttackType(pick.attackType)) {
                    caster += 1;
                }
                roster.push({
                    faction: pick.faction,
                    creatureName: pick.creatureName,
                    level: pick.level,
                    size: pick.size,
                    amount: resolveStackAmount(pick.creatureName, level, amountByLevel, amountMode),
                });
            }
        }
        return { roster, ranged, flyer, caster };
    };

    const ranged = rangedConstraint();
    const flyer = flyerConstraint();
    const caster = casterConstraint();
    if (!ranged && !flyer && !caster) {
        return buildOnce().roster;
    }
    // Rejection-sample until every active dimension's count lands in its [min, max] window. Deterministic
    // per seed; the retry budget is a safety valve (feasibility is high), and we keep the build closest to
    // the combined window if it's ever exhausted.
    const totalDistance = (build: { ranged: number; flyer: number; caster: number }): number =>
        (ranged ? rangeDistance(build.ranged, ranged) : 0) +
        (flyer ? rangeDistance(build.flyer, flyer) : 0) +
        (caster ? rangeDistance(build.caster, caster) : 0);
    let best = buildOnce();
    let bestDist = totalDistance(best);
    for (let attempt = 0; attempt < 2000 && bestDist > 0; attempt += 1) {
        const next = buildOnce();
        const dist = totalDistance(next);
        if (dist < bestDist) {
            best = next;
            bestDist = dist;
        }
    }
    return best.roster;
}

function rangeDistance(value: number, { min, max }: { min: number; max: number }): number {
    if (value < min) {
        return min - value;
    }
    if (value > max) {
        return value - max;
    }
    return 0;
}

/** Instantiate a Unit for the given spec and team. The abilityFactory/effectFactory are shared per match. */
export function createUnitFromSpec(
    spec: IArmyUnitSpec,
    team: TeamType,
    gridSettings: GridSettings,
    abilityFactory: AbilityFactory,
    effectFactory: EffectFactory,
    summoned = false,
    simulationId?: string,
): Unit {
    const textureName = `${spec.creatureName.toLowerCase().replace(/ /g, "_")}_128`;
    const properties = getCreatureConfig(team, spec.faction, spec.creatureName, textureName, spec.amount);
    if (simulationId) {
        Object.defineProperty(properties, "id", { value: simulationId, enumerable: true });
    }
    return Unit.createUnit(
        properties,
        gridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        summoned,
    );
}

export function createCombatFactories(): { abilityFactory: AbilityFactory; effectFactory: EffectFactory } {
    const effectFactory = new EffectFactory();
    return { abilityFactory: new AbilityFactory(effectFactory), effectFactory };
}
