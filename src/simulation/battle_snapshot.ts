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

import Denque from "denque";

import { captureAITargetMemory, restoreAITargetMemory } from "../ai/ai";
import type { FightProperties } from "../fights/fight_properties";
import type { Grid } from "../grid/grid";
import type { Unit } from "../units/unit";
import type { UnitsHolder } from "../units/units_holder";

/**
 * FEASIBILITY SPIKE: lossless snapshot/restore of the full mutable battle state.
 *
 * The goal is to let an AI clone the live fight, simulate candidate moves through the real engine,
 * then roll back — hundreds of times per decision. `snapshotBattle` captures every mutable field of
 * the `UnitsHolder`, `Grid` and `FightProperties` (deep-cloned so the snapshot is frozen against
 * later mutation); `restoreBattle` writes it back INTO the same live instances the engine holds
 * references to, so the rollback is transparent to the engine.
 *
 * Implementation note: all state lives in TypeScript `private`/`protected`/`readonly` fields.
 * `readonly` is a compile-time-only guard, so we reach the fields through narrow "internals" casts
 * rather than widening the public surface of Unit/Grid/FightProperties. `deepClone` preserves each
 * value's prototype, so class instances in the dynamic arrays (Spell, Effect, AppliedSpell,
 * AuraEffect, Ability, UnitProperties) survive the round-trip with their methods intact.
 */

// ---------------------------------------------------------------------------
// Prototype-preserving deep clone
// ---------------------------------------------------------------------------

/**
 * Deep-clone `value`, preserving the prototype of class instances (so methods keep working) and
 * faithfully copying Map / Set / Denque / typed arrays. Every value reachable from the captured
 * battle fields is plain data or one of these containers — there are NO shared/opaque references
 * (factories, grid settings) inside the captured subtrees, so a full recursive clone is safe.
 */
export function deepClone<T>(value: T): T {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if (value instanceof Denque) {
        return new Denque((value as Denque<unknown>).toArray().map((v) => deepClone(v))) as unknown as T;
    }
    if (value instanceof Map) {
        const out = new Map();
        for (const [k, v] of value as Map<unknown, unknown>) {
            out.set(deepClone(k), deepClone(v));
        }
        return out as unknown as T;
    }
    if (value instanceof Set) {
        const out = new Set();
        for (const v of value as Set<unknown>) {
            out.add(deepClone(v));
        }
        return out as unknown as T;
    }
    if (ArrayBuffer.isView(value)) {
        // Typed array (Uint8Array etc.) — copy the underlying buffer slice.
        return (value as unknown as { slice(): T }).slice();
    }
    if (Array.isArray(value)) {
        return (value as unknown[]).map((v) => deepClone(v)) as unknown as T;
    }
    const out = Object.create(Object.getPrototypeOf(value));
    for (const key of Object.keys(value as object)) {
        out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as T;
}

// ---------------------------------------------------------------------------
// Internals views (TypeScript-only casts onto the private fields we capture)
// ---------------------------------------------------------------------------

/** The mutable Unit fields captured by the snapshot. Shared/immutable refs are intentionally excluded. */
const UNIT_FIELDS = [
    "unitProperties",
    "initialUnitProperties",
    "buffs",
    "debuffs",
    "position",
    "renderPosition",
    "spells",
    "effects",
    "abilities",
    "auraEffects",
    "selectedAttackType",
    "possibleAttackTypes",
    "maxRangeShots",
    "responded",
    "waterShieldSpent",
    "onHourglass",
    "movedThisTurn",
    "currentAttackModIncrease",
    "adjustedBaseStatsLaps",
    "luckPerTurn",
] as const;

const UNIT_SHARED_FIELDS = [
    "gridSettings",
    "teamType",
    "unitType",
    "summoned",
    "effectFactory",
    "abilityFactory",
] as const;

/** The mutable Grid fields captured by the snapshot (gridSettings is shared/immutable — excluded). */
const GRID_FIELDS = [
    "cellsByUnitId",
    "unitIdToTeam",
    "boardAggrPerTeam",
    "gridType",
    "boardCoord",
    "availableCenterStart",
    "availableCenterEnd",
    "cleanedUpCenter",
    "leftMountainCleared",
    "rightMountainCleared",
] as const;

const GRID_SHARED_FIELDS = ["gridSettings"] as const;

/**
 * All mutable FightProperties fields. `gridSettings`-like shared refs don't exist here — every field
 * is a primitive, Set, Map or Denque of primitives — so we capture the whole set.
 */
const FIGHT_FIELDS = [
    "id",
    "currentLap",
    "gridType",
    "placementType",
    "firstTurnMade",
    "fightStarted",
    "fightFinished",
    "previousTurnTeam",
    "highestSpeedThisTurn",
    "alreadyMadeTurn",
    "alreadyMadeTurnByTeam",
    "alreadyHourglass",
    "alreadyRepliedAttack",
    "teamUnitsAlive",
    "hourglassQueue",
    "moralePlusQueue",
    "moraleMinusQueue",
    "currentTurnStart",
    "currentTurnEnd",
    "currentLapTotalTimePerTeam",
    "upNextQueue",
    "stepsMoraleMultiplier",
    "hasAdditionalTimeRequestedPerTeam",
    "defaultPlacementPerTeam",
    "augmentPlacementPerTeam",
    "augmentArmorPerTeam",
    "augmentMightPerTeam",
    "augmentSniperPerTeam",
    "augmentMovementPerTeam",
    "artifactTier1PerTeam",
    "artifactTier2PerTeam",
    "perkPerTeam",
    "synergyUnitsLifePerTeam",
    "synergyUnitsChaosPerTeam",
    "synergyUnitsMightPerTeam",
    "synergyUnitsNaturePerTeam",
    "damageDealFactPerLap",
    "synergiesPerTeam",
    "obstacleHitsLeftLeft",
    "obstacleHitsLeftRight",
    "additionalNarrowingLaps",
] as const;

/** The mutable UnitsHolder caches (derived, but snapshotted so restore is byte-for-byte). */
const HOLDER_FIELDS = [
    "teamsAuraEffects",
    "distancesToClosestEnemies",
    "auraRefreshFingerprint",
    "auraRefreshKnownEmpty",
] as const;

const HOLDER_SHARED_FIELDS = ["grid", "allUnits", "gridSettings"] as const;

type Bag = Record<string, unknown>;

function captureFields(obj: object, fields: readonly string[]): Bag {
    const bag: Bag = {};
    const src = obj as Bag;
    for (const f of fields) {
        bag[f] = deepClone(src[f]);
    }
    return bag;
}

/**
 * Fail closed when a class gains an own field that the snapshot does not explicitly classify. This keeps
 * future mutable state additions from silently making rollout restore lossy. Shared immutable references and
 * `UnitsHolder.allUnits` (captured separately as unitRefs/unitOrder) are the only intentional exclusions.
 */
function assertFieldCoverage(
    label: string,
    obj: object,
    captured: readonly string[],
    intentionallyShared: readonly string[] = [],
): void {
    const classified = new Set([...captured, ...intentionallyShared]);
    const missing = Object.keys(obj).filter((field) => !classified.has(field));
    if (missing.length) {
        throw new Error(`Battle snapshot field coverage incomplete for ${label}: ${missing.sort().join(", ")}`);
    }
}

function writeFields(obj: object, fields: readonly string[], bag: Bag): void {
    const dst = obj as Bag;
    for (const f of fields) {
        dst[f] = deepClone(bag[f]);
    }
}

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export interface BattleSnapshot {
    /** Per-unit captured field bags, keyed by unit id. */
    units: Map<string, Bag>;
    /**
     * Live references to the Unit instances present at capture time, in holder-iteration order.
     * Holding the reference keeps a unit that later DIES (and is dropped from the holder map) alive
     * so restore can re-insert the very same instance — and restores the map's iteration order,
     * which the turn engine depends on for determinism.
     */
    unitRefs: Map<string, Unit>;
    unitOrder: string[];
    grid: Bag;
    fight: Bag;
    holder: Bag;
    /** Battle-scoped policy memory used by the legacy target-selection heuristic. */
    aiTargetMemory: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function snapshotBattle(unitsHolder: UnitsHolder, grid: Grid, fightProperties: FightProperties): BattleSnapshot {
    assertFieldCoverage("Grid", grid, GRID_FIELDS, GRID_SHARED_FIELDS);
    assertFieldCoverage("FightProperties", fightProperties, FIGHT_FIELDS);
    assertFieldCoverage("UnitsHolder", unitsHolder, HOLDER_FIELDS, HOLDER_SHARED_FIELDS);
    const units = new Map<string, Bag>();
    const unitRefs = new Map<string, Unit>();
    const unitOrder: string[] = [];
    for (const [id, unit] of unitsHolder.getAllUnits()) {
        assertFieldCoverage("Unit", unit, UNIT_FIELDS, UNIT_SHARED_FIELDS);
        units.set(id, captureFields(unit, UNIT_FIELDS));
        unitRefs.set(id, unit);
        unitOrder.push(id);
    }
    return {
        units,
        unitRefs,
        unitOrder,
        grid: captureFields(grid, GRID_FIELDS),
        fight: captureFields(fightProperties, FIGHT_FIELDS),
        holder: captureFields(unitsHolder, HOLDER_FIELDS),
        aiTargetMemory: captureAITargetMemory(unitsHolder),
    };
}

export function restoreBattle(
    snapshot: BattleSnapshot,
    unitsHolder: UnitsHolder,
    grid: Grid,
    fightProperties: FightProperties,
): void {
    const liveUnits = unitsHolder.getAllUnits() as Map<string, Unit>;

    // Rebuild the holder's unit map exactly as it was at capture: same members, same iteration
    // order. Units that DIED after the snapshot were dropped from the map but survive as references
    // in `unitRefs`, so they come back; units SUMMONED after the snapshot are simply not re-added
    // (their grid occupancy is wiped by the grid restore below). Each restored unit's mutable state
    // is written back into the very same instance the engine still references elsewhere.
    liveUnits.clear();
    for (const id of snapshot.unitOrder) {
        const unit = snapshot.unitRefs.get(id);
        const bag = snapshot.units.get(id);
        if (!unit || !bag) {
            continue;
        }
        writeFields(unit, UNIT_FIELDS, bag);
        liveUnits.set(id, unit);
    }

    writeFields(grid, GRID_FIELDS, snapshot.grid);
    writeFields(fightProperties, FIGHT_FIELDS, snapshot.fight);
    writeFields(unitsHolder, HOLDER_FIELDS, snapshot.holder);
    restoreAITargetMemory(unitsHolder, snapshot.aiTargetMemory);
}
