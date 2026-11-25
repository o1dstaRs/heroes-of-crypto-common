/*
 * Exports a live battle (units, grid, fight properties, units holder, AI target memory, damage statistics) as
 * plain JSON, for loading into the Zig engine mid-battle: the state a bridge call or a "resume from step k"
 * parity test hands over.
 *
 * The field lists are the ones src/simulation/battle_snapshot.ts captures for search rollouts, and the same
 * fail-closed coverage check applies: an object with a field these lists don't classify throws, so new
 * TypeScript state can't silently go missing from the export.
 */

import Denque from "denque";

import { captureAITargetMemory } from "../../src/ai/ai";

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
    "lastFuseFatalHit",
    "onHourglass",
    "movedThisTurn",
    "movedRouteCellsThisTurn",
    "currentAttackModIncrease",
    "warlordsEdgeAttackBase",
    "warlordsEdgeAppliedAttackBonus",
    "adjustedBaseStatsLaps",
    "luckPerTurn",
] as const;
const UNIT_SHARED = ["gridSettings", "teamType", "unitType", "summoned", "effectFactory", "abilityFactory"] as const;

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
    "scatteredMountainLayout",
    "scatteredMountainsStanding",
    "artifactBarrels",
    "artifactBarrelLayoutActive",
] as const;
const GRID_SHARED = ["gridSettings", "matrixCache"] as const;

const FIGHT_FIELDS = [
    "id",
    "currentLap",
    "gridType",
    "placementType",
    "sideOrientedPlacement",
    "legacyAxisPolicyTeams",
    "firstTurnMade",
    "fightStarted",
    "fightFinished",
    "previousTurnTeam",
    "highestInitiativeThisTurn",
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
    "doctrinePerTeam",
    "synergyUnitsLifePerTeam",
    "synergyUnitsChaosPerTeam",
    "synergyUnitsMightPerTeam",
    "synergyUnitsNaturePerTeam",
    "damageDealFactPerLap",
    "synergiesPerTeam",
    "synergyVariants",
    "obstacleHitsLeftLeft",
    "obstacleHitsLeftRight",
    "additionalNarrowingLaps",
    "smokeClouds",
    "vines",
    "fireWalls",
] as const;

const HOLDER_FIELDS = [
    "teamsAuraEffects",
    "distancesToClosestEnemies",
    "auraRefreshFingerprint",
    "auraRefreshKnownEmpty",
    "emberCovenantSeeded",
    "emberCovenantTeams",
] as const;
const HOLDER_SHARED = ["grid", "allUnits", "gridSettings"] as const;

function assertCoverage(label: string, obj: object, fields: readonly string[], shared: readonly string[]): void {
    const known = new Set([...fields, ...shared]);
    const missing = Object.keys(obj).filter((field) => !known.has(field));
    if (missing.length) throw new Error(`state export: ${label} has unclassified fields ${missing.sort().join(", ")}`);
}

/**
 * Plain-JSON form of a value: Maps become {$map: [[k, v]...]}, Sets {$set: [...]}, Denques {$denque: [...]},
 * class instances their own fields plus {$class}, functions are dropped, and -0 / non-finite numbers are tagged so
 * the loader reproduces them exactly.
 */
export function toPlain(value: unknown, path = "$", seen = new Set<object>()): unknown {
    if (value === undefined) return { $undefined: true };
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
        if (Object.is(value, -0)) return { $num: "-0" };
        if (!Number.isFinite(value)) return { $num: String(value) };
        return value;
    }
    if (typeof value === "bigint") return { $bigint: value.toString() };
    if (typeof value === "function") return { $function: true };
    if (typeof value !== "object") throw new Error(`state export: ${path} has unsupported ${typeof value}`);
    if (seen.has(value)) throw new Error(`state export: ${path} is a cycle`);
    seen.add(value);
    try {
        if (value instanceof Denque)
            return { $denque: value.toArray().map((v, i) => toPlain(v, `${path}[${i}]`, seen)) };
        if (value instanceof Map) {
            return {
                $map: [...value.entries()].map(([k, v], i) => [
                    toPlain(k, `${path}<k${i}>`, seen),
                    toPlain(v, `${path}<${i}>`, seen),
                ]),
            };
        }
        if (value instanceof Set) return { $set: [...value].map((v, i) => toPlain(v, `${path}{${i}}`, seen)) };
        if (Array.isArray(value)) return value.map((v, i) => toPlain(v, `${path}[${i}]`, seen));
        if (ArrayBuffer.isView(value))
            return { $typed: value.constructor.name, values: Array.from(value as unknown as ArrayLike<number>) };
        const out: Record<string, unknown> = {};
        const proto = Object.getPrototypeOf(value);
        if (proto && proto !== Object.prototype) out.$class = proto.constructor?.name ?? "?";
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === "function") continue;
            out[k] = toPlain(v, `${path}.${k}`, seen);
        }
        return out;
    } finally {
        seen.delete(value);
    }
}

function capture(obj: any, fields: readonly string[], label: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) out[field] = toPlain(obj[field], `${label}.${field}`);
    return out;
}

export interface IExportContext {
    unitsHolder: any;
    grid: any;
    fightProperties: any;
    attackHandler?: any;
}

/** The full mutable battle state as plain JSON (see the module comment). */
export function exportBattleState(ctx: IExportContext): Record<string, unknown> {
    const { unitsHolder, grid, fightProperties } = ctx;
    assertCoverage("Grid", grid, GRID_FIELDS, GRID_SHARED);
    assertCoverage("FightProperties", fightProperties, FIGHT_FIELDS, []);
    assertCoverage("UnitsHolder", unitsHolder, HOLDER_FIELDS, HOLDER_SHARED);
    const units: unknown[] = [];
    for (const [id, unit] of unitsHolder.getAllUnits()) {
        assertCoverage("Unit", unit, UNIT_FIELDS, UNIT_SHARED);
        units.push({
            id,
            team: unit.teamType,
            unitType: unit.unitType,
            summoned: unit.summoned,
            fields: capture(unit, UNIT_FIELDS, `unit ${id}`),
        });
    }
    const damage = ctx.attackHandler?.damageStatisticHolder?.get?.() ?? [];
    return {
        version: 1,
        units,
        grid: capture(grid, GRID_FIELDS, "grid"),
        fight: capture(fightProperties, FIGHT_FIELDS, "fight"),
        holder: capture(unitsHolder, HOLDER_FIELDS, "holder"),
        aiTargetMemory: [...captureAITargetMemory(unitsHolder).entries()],
        damageStatLaps: [...new Set(damage.map((d: { lap: number }) => d.lap))].sort((a: any, b: any) => a - b),
    };
}
