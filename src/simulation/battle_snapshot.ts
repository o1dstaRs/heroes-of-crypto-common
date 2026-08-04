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
    "movedRouteCellsThisTurn",
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
    "augmentEmpowerPerTeam",
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
    // Which synergy variant each faction awards this fight. Set once from the draft, but still per-fight
    // state a rollout has to restore — resuming with a different variant map would score the candidate
    // against synergies the live army never had.
    "synergyVariants",
    "obstacleHitsLeftLeft",
    "obstacleHitsLeftRight",
    "additionalNarrowingLaps",
    // Cell-resident Smoke clouds (Ash Moth's Book of Chaos). Mutable battle state like any other: the turn
    // engine decrements it per lap and the move handler dispels a cell when a creature steps on it. It MUST
    // be captured — a rollout that placed or expired smoke would otherwise leave it behind in the live
    // fight, which is exactly the leak the lookahead's "search does not mutate live state" test asserts.
    // Safe to deep-clone: SmokeClouds holds only a Map of plain cells + lap counters.
    "smokeClouds",
    // Cell-resident vines (Trent's Vine Throw). Captured for exactly the same reason as smokeClouds above:
    // the turn engine decrements it per lap, so a rollout that laid or withered a vine would otherwise leak
    // that into the live fight. Safe to deep-clone: Vines holds only a Map of plain cells + lap counters.
    "vines",
    // Cell-resident fire walls (Nightmare's Book of Nightmares). Same reasoning again: the turn engine
    // decrements it per lap and a rollout that lit or burnt out a wall would otherwise leak into the live
    // fight. Safe to deep-clone: FireWalls holds only a Map of plain cells + lap counters.
    "fireWalls",
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

type JournalMutationMethod = (this: object, ...args: unknown[]) => unknown;

const journalMutationHook = Symbol("battleRollbackJournalMutationHook");
const mutationHookedPrototypes = new WeakSet<object>();

type JournalWrappedMethod = JournalMutationMethod & {
    [journalMutationHook]?: true;
};

const UNIT_MUTATION_METHODS = [
    "deleteAbility",
    "grantAbility",
    "addAbility",
    "grantStolenAbility",
    "disableAbilityAsStolen",
    "takeAbilitySpellEntries",
    "registerAbility",
    "removeAbilityMechanics",
    "setTarget",
    "resetTarget",
    "setForbiddenTarget",
    "resetForbiddenTarget",
    "applyEffect",
    "refreshPreTurnState",
    "deleteEffect",
    "deleteAllEffects",
    "deleteBuff",
    "deleteAllBuffs",
    "deleteDebuff",
    "deleteAllDebuffs",
    "minusLap",
    "spendShotsAgainst",
    "decreaseNumberOfShots",
    "setSynergies",
    "setPosition",
    "setRenderPosition",
    "reviveAfterDeath",
    "setWebMovementLocked",
    "increaseAmountAlive",
    "increaseAttackMod",
    "cleanupAttackModIncrease",
    "decreaseAmountDied",
    "randomizeLuckPerTurn",
    "applyLuckShield",
    "applyArmageddonDamage",
    "applyDamage",
    "setAmountAlive",
    "increaseMorale",
    "decreaseBaseArmor",
    "increaseBaseArmor",
    "increaseSupply",
    "decreaseMorale",
    "applyTravelledDistanceModifier",
    "applyLavaWaterModifier",
    "trySeedWaterShield",
    "setResponded",
    "setOnHourglass",
    "setMovedThisTurn",
    "setMovedRouteCellsThisTurn",
    "refreshPossibleAttackTypes",
    "selectNextAttackType",
    "selectAttackType",
    "cleanAuraEffects",
    "applyAuraEffect",
    "applyBuff",
    "takeBuffFrom",
    "applyDebuff",
    "useSpell",
    "applyResurrection",
    "applyHeal",
    "reduceBaseAttack",
    "adjustBaseStats",
    "setRangeShotDistance",
    "setStackPower",
    "parseAbilities",
    "refreshAbilitiesDescriptions",
    "refreshBlindFuryDescription",
    "refreshChakramDescription",
    "parseSpells",
    "parseAuraEffects",
    "refreshAndGetAdjustedMaxHp",
] as const;

const GRID_MUTATION_METHODS = [
    "cleanupCenterObstacle",
    "clearMountainSide",
    "refreshWithNewType",
    "cleanupAll",
    "occupyCell",
    "occupyByHole",
    "occupyCells",
    "rebuildAggrBoards",
    "updateAggrGrid",
] as const;

const FIGHT_MUTATION_METHODS = [
    "setSmokeClouds",
    "setVines",
    "setFireWalls",
    "setObstacleHitsLeft",
    "setObstacleHitsPerMountain",
    "encounterDamageDealFact",
    "encounterObstacleHit",
    "restoreStepsMoraleMultiplier",
    "setGridType",
    "dequeueNextUnitId",
    "dequeueMoraleMinus",
    "dequeueMoralePlus",
    "dequeueHourglassQueue",
    "setHighestSpeedThisTurn",
    "startTurn",
    "requestAdditionalTurnTime",
    "markFirstTurn",
    "startFight",
    "finishFight",
    "flipLap",
    "encounterAdditionalNarrowingLap",
    "setTeamUnitsAlive",
    "setSynergyVariants",
    "setSynergyUnitsPerFactions",
    "setSynergiesPerTeam",
    "updateSynergyPerTeam",
    "addRepliedAttack",
    "addAlreadyMadeTurn",
    "enqueueHourglass",
    "restoreAlreadyHourglass",
    "enqueueMoraleMinus",
    "enqueueMoralePlus",
    "enqueueUpNext",
    "removeFromUpNext",
    "removeFromHourglassQueue",
    "removeFromMoraleMinusQueue",
    "removeFromMoralePlusQueue",
    "increaseStepsMoraleMultiplier",
    "updatePreviousTurnTeam",
    "setDefaultPlacementPerTeam",
    "setArtifactPerTeam",
    "setPerkPerTeam",
    "setAugmentPerTeam",
    "prefetchNextUnitsToTurn",
    "setUnitsCalculatedStacksPower",
    "removeItemOnce",
    "getNextTurnUnitId",
] as const;

const HOLDER_MUTATION_METHODS = [
    "haveDistancesToClosestEnemiesDecreased",
    "applyAugments",
    "applyArtifacts",
    "refreshUnitsForAllTeams",
    "deleteUnitById",
    "refreshAngelicHostForAllUnits",
    "refreshWaterShieldForAllUnits",
    "refreshStackPowerForAllUnits",
    "refreshAuraEffectsIfNeeded",
    "refreshAuraEffectsForAllUnits",
    "addUnit",
    "decreaseMoraleForTheSameUnitsOfTheTeam",
    "increaseUnitsSupplyIfNeededPerTeam",
    "deleteUnitIfNotAllowed",
] as const;

const SMOKE_MUTATION_METHODS = ["add", "dispel", "clear", "minusAllLaps"] as const;
const VINE_MUTATION_METHODS = ["add", "addAll", "remove", "clear", "minusAllLaps"] as const;
const FIRE_WALL_MUTATION_METHODS = ["add", "addAll", "remove", "clear", "minusAllLaps"] as const;

let activeRollbackCheckpoint: BattleRollbackCheckpoint | undefined;

function installMutationHooks(unitsHolder: UnitsHolder, grid: Grid, fightProperties: FightProperties): void {
    wrapMutationMethods(unitsHolder, HOLDER_MUTATION_METHODS, (target) =>
        activeRollbackCheckpoint?.recordHolderMutation(target as UnitsHolder),
    );
    wrapMutationMethods(grid, GRID_MUTATION_METHODS, (target) =>
        activeRollbackCheckpoint?.recordGridMutation(target as Grid),
    );
    wrapMutationMethods(fightProperties, FIGHT_MUTATION_METHODS, (target) =>
        activeRollbackCheckpoint?.recordFightMutation(target as FightProperties),
    );
    for (const unit of unitsHolder.getAllUnits().values()) {
        wrapMutationMethods(unit, UNIT_MUTATION_METHODS, (target) =>
            activeRollbackCheckpoint?.recordUnitMutation(target as Unit),
        );
    }
    wrapMutationMethods(fightProperties.getSmokeClouds(), SMOKE_MUTATION_METHODS, (target) =>
        activeRollbackCheckpoint?.recordTerrainMutation(target),
    );
    wrapMutationMethods(fightProperties.getVines(), VINE_MUTATION_METHODS, (target) =>
        activeRollbackCheckpoint?.recordTerrainMutation(target),
    );
    wrapMutationMethods(fightProperties.getFireWalls(), FIRE_WALL_MUTATION_METHODS, (target) =>
        activeRollbackCheckpoint?.recordTerrainMutation(target),
    );
}

function wrapMutationMethods(
    instance: object,
    methods: readonly string[],
    recordMutation: (target: object) => void,
): void {
    let prototype = Object.getPrototypeOf(instance);
    while (prototype && prototype !== Object.prototype) {
        if (!mutationHookedPrototypes.has(prototype)) {
            for (const methodName of methods) {
                const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
                if (!descriptor || typeof descriptor.value !== "function") {
                    continue;
                }
                const original = descriptor.value as JournalWrappedMethod;
                if (original[journalMutationHook]) {
                    continue;
                }
                const wrapped: JournalWrappedMethod = function (this: object, ...args: unknown[]): unknown {
                    recordMutation(this);
                    return original.apply(this, args);
                };
                Object.defineProperty(wrapped, journalMutationHook, { value: true });
                Object.defineProperty(prototype, methodName, { ...descriptor, value: wrapped });
            }
            mutationHookedPrototypes.add(prototype);
        }
        prototype = Object.getPrototypeOf(prototype);
    }
}

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

function writeFields(obj: object, fields: readonly string[], bag: Bag, cloneValues: boolean): void {
    const dst = obj as Bag;
    for (const f of fields) {
        dst[f] = cloneValues ? deepClone(bag[f]) : bag[f];
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

export class BattleRollbackCheckpoint {
    private readonly unitsHolder: UnitsHolder;
    private readonly grid: Grid;
    private readonly fightProperties: FightProperties;
    private readonly unitRefs: Map<string, Unit>;
    private readonly unitOrder: string[];
    private readonly aiTargetMemory: Map<string, string>;
    private readonly smokeClouds: object;
    private readonly vines: object;
    private readonly fireWalls: object;
    private readonly units = new Map<string, Bag>();
    private gridSnapshot: Bag | undefined;
    private fightSnapshot: Bag | undefined;
    private holderSnapshot: Bag | undefined;
    private consumed = false;
    public constructor(
        unitsHolder: UnitsHolder,
        grid: Grid,
        fightProperties: FightProperties,
        unitRefs: Map<string, Unit>,
        unitOrder: string[],
    ) {
        this.unitsHolder = unitsHolder;
        this.grid = grid;
        this.fightProperties = fightProperties;
        this.unitRefs = unitRefs;
        this.unitOrder = unitOrder;
        this.aiTargetMemory = captureAITargetMemory(unitsHolder);
        this.smokeClouds = fightProperties.getSmokeClouds();
        this.vines = fightProperties.getVines();
        this.fireWalls = fightProperties.getFireWalls();
    }
    public recordUnitMutation(unit: Unit): void {
        const id = unit.getId();
        if (this.unitRefs.get(id) !== unit || this.units.has(id)) {
            return;
        }
        this.units.set(id, captureFields(unit, UNIT_FIELDS));
    }
    public recordGridMutation(grid: Grid): void {
        if (grid !== this.grid || this.gridSnapshot) {
            return;
        }
        this.gridSnapshot = captureFields(grid, GRID_FIELDS);
    }
    public recordFightMutation(fightProperties: FightProperties): void {
        if (fightProperties !== this.fightProperties || this.fightSnapshot) {
            return;
        }
        this.fightSnapshot = captureFields(fightProperties, FIGHT_FIELDS);
    }
    public recordHolderMutation(unitsHolder: UnitsHolder): void {
        if (unitsHolder !== this.unitsHolder || this.holderSnapshot) {
            return;
        }
        this.holderSnapshot = captureFields(unitsHolder, HOLDER_FIELDS);
    }
    public recordTerrainMutation(terrain: object): void {
        if (terrain === this.smokeClouds || terrain === this.vines || terrain === this.fireWalls) {
            this.recordFightMutation(this.fightProperties);
        }
    }
    public getCapturedObjectCounts(): { units: number; grid: number; fight: number; holder: number } {
        return {
            units: this.units.size,
            grid: this.gridSnapshot ? 1 : 0,
            fight: this.fightSnapshot ? 1 : 0,
            holder: this.holderSnapshot ? 1 : 0,
        };
    }
    public rollback(): void {
        if (this.consumed) {
            throw new Error("Battle rollback checkpoint has already been consumed");
        }
        if (activeRollbackCheckpoint !== this) {
            throw new Error("Battle rollback checkpoints must be consumed in creation order");
        }
        this.consumed = true;
        activeRollbackCheckpoint = undefined;
        const liveUnits = this.unitsHolder.getAllUnits() as Map<string, Unit>;
        liveUnits.clear();
        for (const id of this.unitOrder) {
            const unit = this.unitRefs.get(id);
            if (!unit) {
                continue;
            }
            const snapshot = this.units.get(id);
            if (snapshot) {
                writeFields(unit, UNIT_FIELDS, snapshot, false);
            }
            liveUnits.set(id, unit);
        }
        if (this.gridSnapshot) {
            writeFields(this.grid, GRID_FIELDS, this.gridSnapshot, false);
        }
        if (this.fightSnapshot) {
            writeFields(this.fightProperties, FIGHT_FIELDS, this.fightSnapshot, false);
        }
        if (this.holderSnapshot) {
            writeFields(this.unitsHolder, HOLDER_FIELDS, this.holderSnapshot, false);
        }
        restoreAITargetMemory(this.unitsHolder, this.aiTargetMemory);
    }
}

export class BattleRollbackJournal {
    private readonly unitsHolder: UnitsHolder;
    private readonly grid: Grid;
    private readonly fightProperties: FightProperties;
    public constructor(unitsHolder: UnitsHolder, grid: Grid, fightProperties: FightProperties) {
        assertBattleSnapshotCoverage(unitsHolder, grid, fightProperties);
        this.unitsHolder = unitsHolder;
        this.grid = grid;
        this.fightProperties = fightProperties;
        installMutationHooks(unitsHolder, grid, fightProperties);
    }
    public checkpoint(): BattleRollbackCheckpoint {
        if (activeRollbackCheckpoint) {
            throw new Error("Cannot create a battle rollback checkpoint while another checkpoint is active");
        }
        const unitRefs = new Map(this.unitsHolder.getAllUnits());
        const checkpoint = new BattleRollbackCheckpoint(this.unitsHolder, this.grid, this.fightProperties, unitRefs, [
            ...unitRefs.keys(),
        ]);
        activeRollbackCheckpoint = checkpoint;
        return checkpoint;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function assertBattleSnapshotCoverage(
    unitsHolder: UnitsHolder,
    grid: Grid,
    fightProperties: FightProperties,
): void {
    assertFieldCoverage("Grid", grid, GRID_FIELDS, GRID_SHARED_FIELDS);
    assertFieldCoverage("FightProperties", fightProperties, FIGHT_FIELDS);
    assertFieldCoverage("UnitsHolder", unitsHolder, HOLDER_FIELDS, HOLDER_SHARED_FIELDS);
    for (const unit of unitsHolder.getAllUnits().values()) {
        assertFieldCoverage("Unit", unit, UNIT_FIELDS, UNIT_SHARED_FIELDS);
    }
}

function captureBattleSnapshot(unitsHolder: UnitsHolder, grid: Grid, fightProperties: FightProperties): BattleSnapshot {
    const units = new Map<string, Bag>();
    const unitRefs = new Map<string, Unit>();
    const unitOrder: string[] = [];
    for (const [id, unit] of unitsHolder.getAllUnits()) {
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

export function snapshotBattle(unitsHolder: UnitsHolder, grid: Grid, fightProperties: FightProperties): BattleSnapshot {
    assertBattleSnapshotCoverage(unitsHolder, grid, fightProperties);
    return captureBattleSnapshot(unitsHolder, grid, fightProperties);
}

function restoreBattleSnapshot(
    snapshot: BattleSnapshot,
    unitsHolder: UnitsHolder,
    grid: Grid,
    fightProperties: FightProperties,
    cloneValues: boolean,
): void {
    const liveUnits = unitsHolder.getAllUnits() as Map<string, Unit>;

    liveUnits.clear();
    for (const id of snapshot.unitOrder) {
        const unit = snapshot.unitRefs.get(id);
        const bag = snapshot.units.get(id);
        if (!unit || !bag) {
            continue;
        }
        writeFields(unit, UNIT_FIELDS, bag, cloneValues);
        liveUnits.set(id, unit);
    }

    writeFields(grid, GRID_FIELDS, snapshot.grid, cloneValues);
    writeFields(fightProperties, FIGHT_FIELDS, snapshot.fight, cloneValues);
    writeFields(unitsHolder, HOLDER_FIELDS, snapshot.holder, cloneValues);
    restoreAITargetMemory(unitsHolder, snapshot.aiTargetMemory);
}

export function restoreBattle(
    snapshot: BattleSnapshot,
    unitsHolder: UnitsHolder,
    grid: Grid,
    fightProperties: FightProperties,
): void {
    restoreBattleSnapshot(snapshot, unitsHolder, grid, fightProperties, true);
}
