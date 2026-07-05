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

interface ICatalogEntry {
    faction: string;
    creatureName: string;
    level: number;
    size: number;
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
    const json = CREATURES_JSON as unknown as Record<string, Record<string, { level?: number; size?: number }>>;
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
                entries.push({ faction, creatureName, level: cfg.level, size: cfg.size });
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

export function buildRoster(
    rng: () => number,
    composition: readonly IRosterComposition[] = DEFAULT_ROSTER_COMPOSITION,
    amountByLevel: Readonly<Record<number, number>> = DEFAULT_AMOUNT_BY_LEVEL,
    factionFilter?: string,
): IArmyUnitSpec[] {
    const roster: IArmyUnitSpec[] = [];
    const forced = forcedByLevel();
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
            roster.push({
                faction: pick.faction,
                creatureName: pick.creatureName,
                level: pick.level,
                size: pick.size,
                amount: amountByLevel[level] ?? 1,
            });
        }
    }
    return roster;
}

/** Instantiate a Unit for the given spec and team. The abilityFactory/effectFactory are shared per match. */
export function createUnitFromSpec(
    spec: IArmyUnitSpec,
    team: TeamType,
    gridSettings: GridSettings,
    abilityFactory: AbilityFactory,
    effectFactory: EffectFactory,
    summoned = false,
): Unit {
    const textureName = `${spec.creatureName.toLowerCase().replace(/ /g, "_")}_128`;
    const properties = getCreatureConfig(team, spec.faction, spec.creatureName, textureName, spec.amount);
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
