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

import { describe, expect, it } from "bun:test";
import Denque from "denque";

import { getAIStrategy } from "../../src/ai";
import type { GameAction } from "../../src/engine/actions";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { createDefaultGameRuntime } from "../../src/engine/runtime";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { Grid } from "../../src/grid/grid";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { AttackHandler } from "../../src/handlers/attack_handler";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { IDamageStatistic } from "../../src/scene/scene_stats";
import type { IStatisticHolder } from "../../src/scene/statistic_holder_interface";
import { buildRoster, createCombatFactories, createUnitFromSpec, makeRng } from "../../src/simulation/army";
import { GREEN_TEAM, RED_TEAM, simulationGridSettings } from "../../src/simulation/battle_engine";
import { snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import { Unit } from "../../src/units/unit";
import { UnitsHolder } from "../../src/units/units_holder";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

// ---------------------------------------------------------------------------
// Minimal mid-fight driver (mirrors src/simulation/battle_engine.ts wiring so the mutations we
// snapshot/restore across are produced by the REAL engine, not hand-rolled writes).
// ---------------------------------------------------------------------------

class DamageStatHolder implements IStatisticHolder<IDamageStatistic> {
    private readonly values: IDamageStatistic[] = [];
    public add(v: IDamageStatistic): void {
        this.values.push(v);
    }
    public get(): IDamageStatistic[] {
        return this.values;
    }
    public has(lap: number): boolean {
        return this.values.some((v) => v.lap === lap);
    }
    public clear(): void {
        this.values.length = 0;
    }
}

const cellKey = (cell: XY): number => (cell.x << 4) | cell.y;
const footprint = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ x: base.x, y: base.y }]
        : [
              { x: base.x, y: base.y },
              { x: base.x - 1, y: base.y },
              { x: base.x, y: base.y - 1 },
              { x: base.x - 1, y: base.y - 1 },
          ];

interface Harness {
    grid: Grid;
    unitsHolder: UnitsHolder;
    fightProperties: ReturnType<FightStateManager["getFightProperties"]>;
    playTurns: (n: number) => void;
    finished: () => boolean;
}

function buildBattle(seed: number, version = "v0.1"): Harness {
    setDeterministicRandomSource(makeRng((seed ^ 0x6d2b79f5) >>> 0));

    const gridSettings = simulationGridSettings();
    FightStateManager.getInstance().reset();
    const grid = new Grid(gridSettings, PBTypes.GridVals.NORMAL);
    const unitsHolder = new UnitsHolder(grid);
    const sceneLog = new SceneLogMock();
    const damageStat = new DamageStatHolder();
    const attackHandler = new AttackHandler(gridSettings, grid, sceneLog, damageStat);
    const moveHandler = new MoveHandler(gridSettings, grid, unitsHolder);
    const pathHelper = new PathHelper(gridSettings);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const runtime = createDefaultGameRuntime();
    const { abilityFactory, effectFactory } = createCombatFactories();

    const greenZone = new RectanglePlacement(gridSettings, PlacementPositionType.LOWER_LEFT, 3);
    const redZone = new RectanglePlacement(gridSettings, PlacementPositionType.UPPER_RIGHT, 3);
    const zoneHashesFor = (team: TeamType): Set<number> =>
        team === GREEN_TEAM ? greenZone.possibleCellHashes() : redZone.possibleCellHashes();

    let currentActiveUnitId = "";
    const engineContext = {
        fightProperties,
        grid,
        unitsHolder,
        moveHandler,
        sceneLog,
        attackHandler,
        getCurrentActiveUnitId: () => currentActiveUnitId || undefined,
        canLandRangeAttack: (unit: Unit) =>
            attackHandler.canLandRangeAttack(unit, grid.getEnemyAggrMatrixByUnitId(unit.getId())),
        canPlaceUnit: (unit: Unit, cells: XY[]) => cells.every((c) => zoneHashesFor(unit.getTeam()).has(cellKey(c))),
        runtime,
    };

    const engine = new GameActionEngine(engineContext);
    const turnEngine = new TurnEngine(engineContext);
    const strategy = getAIStrategy(version);

    const roster = buildRoster(makeRng(seed));
    const greenUnits = roster.map((s) =>
        createUnitFromSpec(s, GREEN_TEAM, gridSettings, abilityFactory, effectFactory),
    );
    const redUnits = roster.map((s) => createUnitFromSpec(s, RED_TEAM, gridSettings, abilityFactory, effectFactory));
    for (const u of [...greenUnits, ...redUnits]) {
        unitsHolder.addUnit(u);
    }

    let finished = false;
    const applyEvents = (events: GameEvent[]): void => {
        for (const event of events) {
            if (event.type === "turn_completed") {
                if (currentActiveUnitId === event.unitId) currentActiveUnitId = "";
            } else if (event.type === "next_unit_selected") {
                currentActiveUnitId = event.unitId;
            } else if (event.type === "fight_finished") {
                currentActiveUnitId = "";
                finished = true;
            } else if (event.type === "unit_destroyed") {
                if (currentActiveUnitId === event.unitId) currentActiveUnitId = "";
            }
        }
    };

    const placeArmy = (units: Unit[], team: TeamType, zone: RectanglePlacement): void => {
        const legal = zone.possibleCellHashes();
        const occupied = new Set<number>();
        const desired = strategy.placeArmy(units, { team, grid, unitsHolder, pathHelper, placement: zone });
        const legalBaseCells: XY[] = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
        const tryPlaceAt = (unit: Unit, base: XY): boolean => {
            const cells = footprint(unit, base);
            if (cells.some((c) => !legal.has(cellKey(c)) || occupied.has(cellKey(c)))) return false;
            const result = engine.apply({
                type: "place_unit",
                unitId: unit.getId(),
                team,
                unitName: unit.getName(),
                cells,
            });
            if (!result.completed) return false;
            for (const c of cells) occupied.add(cellKey(c));
            return true;
        };
        for (const unit of units) {
            const base = desired.get(unit.getId());
            let placed = base ? tryPlaceAt(unit, base) : false;
            if (!placed) {
                for (const candidate of legalBaseCells) {
                    if (tryPlaceAt(unit, candidate)) {
                        placed = true;
                        break;
                    }
                }
            }
        }
    };

    placeArmy(greenUnits, GREEN_TEAM, greenZone);
    placeArmy(redUnits, RED_TEAM, redZone);

    applyEvents(engine.apply({ type: "start_fight" }).events);

    const advance = (): void => {
        const maxAttempts = unitsHolder.getAllUnits().size + 2;
        for (let i = 0; i < maxAttempts && !finished && !currentActiveUnitId; i += 1) {
            const result = turnEngine.advanceAfterNoActiveUnit({
                damageDealtThisLap: damageStat.has(fightProperties.getCurrentLap()),
            });
            applyEvents(result.events);
            if (result.fightFinished) {
                finished = true;
                return;
            }
            if (currentActiveUnitId) return;
            if (!result.events.length && fightProperties.getUpNextQueueSize() === 0) break;
        }
    };

    const playOneTurn = (): void => {
        if (finished) return;
        if (!currentActiveUnitId) {
            advance();
            if (finished || !currentActiveUnitId) return;
        }
        const actingId = currentActiveUnitId;
        const unit = unitsHolder.getAllUnits().get(actingId);
        if (!unit || unit.isDead()) {
            currentActiveUnitId = "";
            return;
        }
        const decided: GameAction[] = strategy.decideTurn(unit, {
            grid,
            matrix: grid.getMatrix(),
            unitsHolder,
            pathHelper,
            attackHandler,
            fightProperties,
        });
        for (const action of decided) {
            const result = engine.apply(action);
            applyEvents(result.events);
            if (finished) break;
        }
        if (!finished && currentActiveUnitId === actingId) {
            applyEvents(engine.apply({ type: "defend_turn", unitId: actingId }).events);
        }
        if (!finished && currentActiveUnitId === actingId) {
            const end = engine.apply({ type: "end_turn", unitId: actingId, reason: "manual" });
            applyEvents(end.events);
            if (!end.completed) currentActiveUnitId = "";
        }
    };

    return {
        grid,
        unitsHolder,
        fightProperties,
        finished: () => finished,
        playTurns: (n: number) => {
            for (let i = 0; i < n && !finished; i += 1) {
                playOneTurn();
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Canonical, JSON-comparable dumps
// ---------------------------------------------------------------------------

/** Recursively turn a value (with Map/Set/Denque/class instances) into plain, comparable JSON data. */
function normalize(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
        // Normalise -0 to 0 so numeric equality never trips on the sign of zero.
        return Object.is(value, -0) ? 0 : value;
    }
    if (value instanceof Denque) {
        return { __denque: (value as Denque<unknown>).toArray().map(normalize) };
    }
    if (value instanceof Map) {
        return { __map: [...(value as Map<unknown, unknown>).entries()].map(([k, v]) => [normalize(k), normalize(v)]) };
    }
    if (value instanceof Set) {
        return { __set: [...(value as Set<unknown>)].map(normalize) };
    }
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
        out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
}

function dumpUnit(unit: Unit) {
    const p = unit.getUnitProperties();
    return {
        id: unit.getId(),
        hp: p.hp,
        maxHp: p.max_hp,
        amountAlive: p.amount_alive,
        amountDied: p.amount_died,
        position: { ...unit.getPosition() },
        baseCell: { ...unit.getBaseCell() },
        morale: unit.getMorale(),
        luck: unit.getLuck(),
        luckMod: p.luck_mod,
        attackMod: p.attack_mod,
        armorMod: p.armor_mod,
        rangeShots: unit.getRangeShots(),
        rawRangeShots: p.range_shots,
        maxRangeShots: p.range_shots_mod,
        selectedAttackType: unit.getAttackTypeSelection(),
        possibleAttackTypes: unit.getPossibleAttackTypes(),
        buffs: unit.getBuffs().map((b) => ({ name: b.getName(), laps: b.getLaps(), power: b.getPower() })),
        debuffs: unit.getDebuffs().map((d) => ({ name: d.getName(), laps: d.getLaps(), power: d.getPower() })),
        effects: unit.getEffects().map((e) => ({ name: e.getName(), laps: e.getLaps(), power: e.getPower() })),
        spells: unit.getSpells().map((s) => ({ name: s.getName(), amount: s.getAmount() })),
        abilities: unit.getAbilities().map((a) => a.getName()),
        target: unit.getTarget(),
        appliedBuffs: [...p.applied_buffs],
        appliedBuffsLaps: [...p.applied_buffs_laps],
        appliedDebuffs: [...p.applied_debuffs],
        appliedEffects: [...p.applied_effects],
        appliedEffectsLaps: [...p.applied_effects_laps],
    };
}

function dumpUnits(unitsHolder: UnitsHolder) {
    return [...unitsHolder.getAllUnits().values()]
        .map(dumpUnit)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function dumpGrid(grid: Grid) {
    // getMatrix() returns a fresh array, but getAggrMatrixByTeam() returns the LIVE matrix the grid
    // mutates in place — deep-copy it so a held "before" dump isn't corrupted by subsequent play.
    const clone = (m?: number[][]) => (m ? m.map((row) => [...row]) : m);
    return {
        matrix: grid.getMatrix(),
        aggrUpper: clone(grid.getAggrMatrixByTeam(1)),
        aggrLower: clone(grid.getAggrMatrixByTeam(2)),
    };
}

// Canonical dump of ALL mutable FightProperties fields (via a throwaway snapshot). Note: we do NOT
// use FightProperties.serialize() as the oracle — it writes several fields as protobuf int32 and
// throws on legitimate fractional mid-fight values (e.g. a creature speed of 7.6 in
// highest_speed_this_turn), and it is lossy (omits synergies/augments/obstacleHitsLeft/etc). The
// normalized snapshot below is a strictly stronger, complete comparison.

// ---------------------------------------------------------------------------
// The deliverable
// ---------------------------------------------------------------------------

describe("battle snapshot round-trip", () => {
    it("restores independent BLOCK_CENTER mountain HP and cleared-side flags", () => {
        FightStateManager.getInstance().reset();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.BLOCK_CENTER);
        const grid = new Grid(simulationGridSettings(), PBTypes.GridVals.BLOCK_CENTER);
        const unitsHolder = new UnitsHolder(grid);
        const initialMatrix = grid.getMatrix();
        const initialLeft = fightProperties.getObstacleHitsLeftLeft();
        const initialRight = fightProperties.getObstacleHitsLeftRight();
        const snapshot = snapshotBattle(unitsHolder, grid, fightProperties);

        fightProperties.setObstacleHitsPerMountain(0, 1);
        expect(grid.clearMountainSide(false)).toBe(true);
        expect(grid.clearMountainSide(true)).toBe(true);
        expect(grid.getMatrix()).not.toEqual(initialMatrix);

        restoreBattle(snapshot, unitsHolder, grid, fightProperties);

        expect(fightProperties.getObstacleHitsLeftLeft()).toBe(initialLeft);
        expect(fightProperties.getObstacleHitsLeftRight()).toBe(initialRight);
        expect(grid.getMatrix()).toEqual(initialMatrix);
        // The booleans, not only boardCoord, were restored: either mountain can be cleared again.
        expect(grid.clearMountainSide(false)).toBe(true);
        expect(grid.clearMountainSide(true)).toBe(true);
    });

    it("fails closed when a future mutable field is not classified", () => {
        FightStateManager.getInstance().reset();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const grid = new Grid(simulationGridSettings(), PBTypes.GridVals.NORMAL);
        const unitsHolder = new UnitsHolder(grid);
        Object.defineProperty(grid, "futureMutableField", { value: 1, enumerable: true, configurable: true });

        expect(() => snapshotBattle(unitsHolder, grid, fightProperties)).toThrow(
            "Battle snapshot field coverage incomplete for Grid: futureMutableField",
        );
    });

    it("losslessly restores full mid-fight state after real engine turns mutate it", () => {
        try {
            const h = buildBattle(20240626);

            // 1. Advance to a non-trivial mid-fight state (units moved, damage dealt, queues/morale set).
            h.playTurns(14);
            expect(h.finished()).toBe(false);

            // Sanity: the battle actually progressed off its starting positions / full HP.
            const someDamage = [...h.unitsHolder.getAllUnits().values()].some(
                (u) => u.getHp() !== u.getMaxHp() || u.getAmountDied() > 0,
            );
            expect(someDamage).toBe(true);

            // 2. Capture S.
            const snapshot = snapshotBattle(h.unitsHolder, h.grid, h.fightProperties);
            const preUnits = dumpUnits(h.unitsHolder);
            const preGrid = dumpGrid(h.grid);
            const preNormalized = normalize(snapshot);

            // 3. Advance real engine turns so the live state genuinely diverges from S. Reseed the
            // global RNG first so this exact stream can be reproduced in step 6 — the ONLY variable
            // between the two runs is then whether the battle state was restored losslessly.
            setDeterministicRandomSource(makeRng(0xabcdef));
            h.playTurns(10);
            const afterUnits = dumpUnits(h.unitsHolder);
            const afterGrid = dumpGrid(h.grid);
            expect(afterUnits).not.toEqual(preUnits); // mutation really happened

            // 4. Roll back.
            restoreBattle(snapshot, h.unitsHolder, h.grid, h.fightProperties);

            // 5. Assert the restored state is bit-identical to S.
            expect(dumpUnits(h.unitsHolder)).toEqual(preUnits);
            expect(dumpGrid(h.grid)).toEqual(preGrid);

            // Strongest check: a fresh snapshot after restore equals the original, field-for-field,
            // across EVERY captured mutable field (units, grid, fightProperties, holder caches).
            const reSnapshot = snapshotBattle(h.unitsHolder, h.grid, h.fightProperties);
            expect(normalize(reSnapshot)).toEqual(preNormalized);

            // 6. The restored state must be LIVE and COMPLETE: replaying the exact same engine turns
            // (identical RNG stream) from the rolled-back state must reproduce step 3 bit-for-bit.
            // Any un-restored battle field would make this replay diverge.
            setDeterministicRandomSource(makeRng(0xabcdef));
            h.playTurns(10);
            expect(dumpUnits(h.unitsHolder)).toEqual(afterUnits);
            expect(dumpGrid(h.grid)).toEqual(afterGrid);
        } finally {
            setDeterministicRandomSource(undefined);
        }
    });

    it("restores identically when called repeatedly from the same snapshot", () => {
        try {
            const h = buildBattle(777);
            h.playTurns(12);
            const snapshot = snapshotBattle(h.unitsHolder, h.grid, h.fightProperties);
            const baseline = normalize(snapshot);

            for (let i = 0; i < 3; i += 1) {
                h.playTurns(6);
                restoreBattle(snapshot, h.unitsHolder, h.grid, h.fightProperties);
                expect(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties))).toEqual(baseline);
            }
        } finally {
            setDeterministicRandomSource(undefined);
        }
    });
});
