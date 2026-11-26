/*
 * Exports a live battle (units, grid, fight properties, units holder, AI target memory, damage statistics) as
 * plain JSON, for loading into the Zig engine mid-battle: the state a bridge call or a "resume from step k"
 * parity test hands over.
 *
 * The field lists are the ones src/simulation/battle_snapshot.ts captures for search rollouts, and the same
 * fail-closed coverage check applies: an object with a field these lists don't classify throws, so new
 * TypeScript state can't silently go missing from the export.
 *
 * Besides the raw fields, the export carries what the Zig loader (zig/src/snapshot.zig) would otherwise have to
 * recompute from TypeScript code it does not port: each unit's name and creature id, the configs the engine reads by
 * name (the abilities and aura effects on the board, Poison, Break, the Ember Covenant spell; the same shape as a
 * recording's start state), and each team's synergy values (FightProperties' getAdditional*PerTeam and
 * getBreakChancePerTeam) with the laps till narrowing. The format is documented in zig/BRIDGE.md.
 */

import Denque from "denque";

import { captureAITargetMemory } from "../../src/ai/ai";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    getAbilityConfig,
    getAuraEffectConfig,
    getEffectConfig,
    getSpellConfig,
} from "../../src/configuration/config_provider";

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

/**
 * The harness state outside the engine objects that a loop resuming the battle needs: the random stream's state
 * (mulberry32, as zig/src/rng.zig keeps it), the active unit (runMatch's currentActiveUnitId, "" for none) and the
 * deterministic UUID counter (lib.ts captureDeterministicRandomState().uuidSequence: the ids of units a rollout
 * creates; carried by the Zig handle, which creates none).
 */
export interface IExportHarness {
    rng?: number;
    activeUnitId?: string;
    uuidSequence?: number;
    /** The battle seed and runMatch's createSummonedUnit counter: the parts of a summoned unit's id (Infest). */
    seed?: number;
    summonSequence?: number;
    /**
     * v0.7's immutable army profile per team ("1" RIGHT, "2" LEFT), which the v0.8 policy reads and the strategy
     * instance that placed the army keeps (StrategyV0_7.primeArmyProfile): MELEE_MAGIC stacks at the fight's start and
     * whether every stack emits an aura. Absent or null = no profile (a late takeover). A runMatch-based harness can
     * compute it at start_fight with `armyProfileAtStart`.
     */
    armyProfile?: Record<string, { meleeMagic: number; auraSaturated: boolean } | null>;
}

const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

/** v0.7's army profile of both teams from the holder at the fight's start (isDenseMeleeMagicArmy's count and
 * isAuraSaturatedArmy), as StrategyV0_7.primeArmyProfile computes it at placement. */
export function armyProfileAtStart(unitsHolder: any): Record<string, { meleeMagic: number; auraSaturated: boolean }> {
    const out: Record<string, { meleeMagic: number; auraSaturated: boolean }> = {};
    for (const team of [1, 2]) {
        const units = unitsHolder.getAllAllies(team);
        out[String(team)] = {
            meleeMagic: units.filter((u: any) => u.getAttackType() === MELEE_MAGIC).length,
            auraSaturated:
                units.length > 0 && units.every((u: any) => u.getAuraRanges().some((range: number) => range > 0)),
        };
    }
    return out;
}

const plainConfig = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

/** Spit Ball's debuffs with their config factions (spit_ball_ability.ts POSSIBLE_DEBUFFS_TO_FACTIONS), in roll order. */
export const SPIT_BALL_DEBUFFS: Array<[string, string]> = [
    ["Death", "Curse"],
    ["Death", "Sadness"],
    ["Death", "Quagmire"],
    ["Death", "Weakening Beam"],
    ["Death", "Weakness"],
    ["Order", "Rangebane"],
    ["Order", "Cowardice"],
];

/** The creatures Infest raises, and the one Summon Wolves raises. */
const SUMMON_CREATURES = ["Arachna Spider", "Arachna Queen"];
const SPELL_SUMMON_CREATURES = ["Wolf"];

/** The configs the engine reads by name, as record.ts writes them into a recording's start state, and the summon
 * templates (createUnitFromSpec's fresh props) of the creatures the board can raise: Infest's when a unit holds Infest,
 * the Wolf when a unit holds a summon spell entry or a summoned Wolf stands. With vines on the board the System "Vine
 * Throw" config joins spellConfigs (the snare on arrival reads it; a book spell's config travels in its Spell object),
 * with a Disguise Aura card the System "Hidden" and "Visible" markers the stat refresh writes, and with a Spit Ball card
 * the seven debuffs it applies (Death and Order spells). */
function engineConfigs(unitsHolder: any, grid: any, fightProperties: any): Record<string, Record<string, unknown>> {
    const abilityConfigs: Record<string, any> = {};
    const effectConfigs: Record<string, unknown> = {};
    const auraEffectConfigs: Record<string, unknown> = {};
    const addProps = (props: any): void => {
        for (const name of props.abilities ?? []) {
            if (name in abilityConfigs) continue;
            abilityConfigs[name] = plainConfig(getAbilityConfig(name));
            const effect = abilityConfigs[name]?.effect;
            if (effect && !(effect in effectConfigs)) effectConfigs[effect] = plainConfig(getEffectConfig(effect));
        }
        for (const name of props.aura_effects ?? []) {
            if (!(name in auraEffectConfigs)) auraEffectConfigs[name] = plainConfig(getAuraEffectConfig(name));
        }
    };
    let summons = false;
    let spellSummons = false;
    let disguise = false;
    let spitBall = false;
    // Craft grants four cards mid-fight and stuns by name (craft_ability.ts).
    let craft = false;
    // Artifacts: a Lava Striders army's lava routes apply the System "Made of Fire" buff (its config travels here).
    let madeOfFire = false;
    // Rime Charm and Gravechain apply the Death "Quagmire" and "Gravebound" debuffs.
    let riders = false;
    // Batch 6a: Hamstring applies the Death "Hamstrung" debuff; a Wind Flow carrier's stat refresh reads the System
    // "Wind Flow" config (the caster's Spell object may be spent or gone).
    let hamstring = false;
    let windFlow = false;
    for (const unit of unitsHolder.getAllUnits().values()) {
        const props = unit.getUnitProperties();
        addProps(props);
        if ((props.abilities ?? []).includes("Disguise Aura")) disguise = true;
        if ((props.abilities ?? []).includes("Spit Ball")) spitBall = true;
        if ((props.spells ?? []).some((entry: string) => entry.endsWith(":Craft"))) craft = true;
        if ((props.applied_buffs ?? []).some((name: string) => name === "Lava Striders" || name === "Made of Fire"))
            madeOfFire = true;
        if (
            (props.applied_buffs ?? []).some((name: string) => name === "Rime Charm" || name === "Gravechain") ||
            (props.applied_debuffs ?? []).some((name: string) => name === "Quagmire" || name === "Gravebound")
        )
            riders = true;
        if ((props.abilities ?? []).includes("Hamstring")) hamstring = true;
        if ((props.applied_buffs ?? []).includes("Wind Flow")) windFlow = true;
        if ((props.abilities ?? []).includes("Infest")) summons = true;
        if ((props.spells ?? []).some((entry: string) => entry.includes(":Summon "))) spellSummons = true;
        if (unit.summoned && SPELL_SUMMON_CREATURES.includes(unit.getName())) spellSummons = true;
    }
    let summonTemplates: Record<string, unknown> | undefined;
    if (summons || spellSummons) {
        const { abilityFactory, effectFactory } = createCombatFactories();
        summonTemplates = {};
        for (const creatureName of [
            ...(summons ? SUMMON_CREATURES : []),
            ...(spellSummons ? SPELL_SUMMON_CREATURES : []),
        ]) {
            const unit = createUnitFromSpec(
                { faction: "Nature", creatureName, level: 0, size: 0, amount: 1 },
                2,
                grid.getSettings(),
                abilityFactory,
                effectFactory,
                true,
                "00000000-0000-5000-8000-000000000000",
            );
            addProps(unit.getUnitProperties());
            summonTemplates[creatureName] = {
                name: unit.getName(),
                creatureId: creatureIdForName(unit.getName()) ?? 0,
                level: unit.getLevel(),
                size: unit.getSize(),
                footprintW: unit.getFootprintWidth(),
                footprintH: unit.getFootprintHeight(),
                props: plainConfig(unit.getUnitProperties()),
                initialProps: plainConfig(unit.initialUnitProperties),
            };
        }
    }
    for (const effect of ["Poison", "Break"]) {
        if (!(effect in effectConfigs)) effectConfigs[effect] = plainConfig(getEffectConfig(effect));
    }
    const spellConfigs: Record<string, unknown> = {
        "Ember Covenant Blessing": plainConfig(getSpellConfig("System", "Ember Covenant Blessing")),
    };
    if (fightProperties?.getVines?.()?.size?.()) {
        spellConfigs["Vine Throw"] = plainConfig(getSpellConfig("System", "Vine Throw"));
    }
    if (disguise) {
        for (const name of ["Hidden", "Visible"]) spellConfigs[name] = plainConfig(getSpellConfig("System", name));
    }
    if (spitBall) {
        for (const [faction, name] of SPIT_BALL_DEBUFFS)
            spellConfigs[name] = plainConfig(getSpellConfig(faction, name));
    }
    if (craft) {
        for (const name of [
            "Crafted Double Punch",
            "Crafted Double Shot",
            "Crafted Frozen Sword",
            "Crafted Frozen Bow",
        ]) {
            if (name in abilityConfigs) continue;
            abilityConfigs[name] = plainConfig(getAbilityConfig(name));
            const effect = abilityConfigs[name]?.effect;
            if (effect && !(effect in effectConfigs)) effectConfigs[effect] = plainConfig(getEffectConfig(effect));
        }
        if (!("Stun" in effectConfigs)) effectConfigs.Stun = plainConfig(getEffectConfig("Stun"));
    }
    if (madeOfFire) spellConfigs["Made of Fire"] = plainConfig(getSpellConfig("System", "Made of Fire"));
    if (hamstring) spellConfigs.Hamstrung = plainConfig(getSpellConfig("Death", "Hamstrung"));
    if (windFlow) spellConfigs["Wind Flow"] = plainConfig(getSpellConfig("System", "Wind Flow"));
    if (riders)
        for (const name of ["Quagmire", "Gravebound"]) spellConfigs[name] = plainConfig(getSpellConfig("Death", name));
    return {
        abilityConfigs,
        effectConfigs,
        auraEffectConfigs,
        spellConfigs,
        ...(summonTemplates ? { summonTemplates } : {}),
    };
}

/** Each team's synergy values (constant once the setup ran) and the laps till narrowing. */
function setupValues(fp: any): Record<string, unknown> {
    const perTeam: Record<string, unknown> = {};
    for (const team of [2, 1]) {
        perTeam[team] = {
            abilityPower: fp.getAdditionalAbilityPowerPerTeam(team),
            movementSteps: fp.getAdditionalMovementStepsPerTeam(team),
            flyArmor: fp.getAdditionalFlyArmorPerTeam(team),
            morale: fp.getAdditionalMoralePerTeam(team),
            luck: fp.getAdditionalLuckPerTeam(team),
            supply: fp.getAdditionalSupplyPerTeam(team),
            auraRange: fp.getAdditionalAuraRangePerTeam(team),
            breakChance: fp.getBreakChancePerTeam(team),
        };
    }
    return { lapsTillNarrowing: fp.getNumberOfLapsTillNarrowing(), perTeam };
}

/** The full mutable battle state as plain JSON (see the module comment). */
export function exportBattleState(ctx: IExportContext, harness?: IExportHarness): Record<string, unknown> {
    const { unitsHolder, grid, fightProperties } = ctx;
    assertCoverage("Grid", grid, GRID_FIELDS, GRID_SHARED);
    assertCoverage("FightProperties", fightProperties, FIGHT_FIELDS, []);
    assertCoverage("UnitsHolder", unitsHolder, HOLDER_FIELDS, HOLDER_SHARED);
    const units: unknown[] = [];
    for (const [id, unit] of unitsHolder.getAllUnits()) {
        assertCoverage("Unit", unit, UNIT_FIELDS, UNIT_SHARED);
        units.push({
            id,
            name: unit.getName(),
            creatureId: creatureIdForName(unit.getName()) ?? 0,
            team: unit.teamType,
            unitType: unit.unitType,
            summoned: unit.summoned,
            fields: capture(unit, UNIT_FIELDS, `unit ${id}`),
        });
    }
    const damage = ctx.attackHandler?.damageStatisticHolder?.get?.() ?? [];
    return {
        version: 2,
        units,
        grid: capture(grid, GRID_FIELDS, "grid"),
        fight: capture(fightProperties, FIGHT_FIELDS, "fight"),
        holder: capture(unitsHolder, HOLDER_FIELDS, "holder"),
        aiTargetMemory: [...captureAITargetMemory(unitsHolder).entries()],
        damageStatLaps: [...new Set(damage.map((d: { lap: number }) => d.lap))].sort((a: any, b: any) => a - b),
        configs: engineConfigs(unitsHolder, grid, fightProperties),
        setup: setupValues(fightProperties),
        ...(harness
            ? {
                  harness: {
                      rng: harness.rng ?? null,
                      activeUnitId: harness.activeUnitId ?? "",
                      uuidSequence: harness.uuidSequence ?? null,
                      ...(harness.seed === undefined ? {} : { seed: harness.seed }),
                      ...(harness.summonSequence === undefined ? {} : { summonSequence: harness.summonSequence }),
                      ...(harness.armyProfile === undefined ? {} : { armyProfile: harness.armyProfile }),
                  },
              }
            : {}),
    };
}
