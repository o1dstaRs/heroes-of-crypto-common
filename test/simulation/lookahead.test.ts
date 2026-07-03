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
import { restoreBattle, snapshotBattle, type BattleSnapshot } from "../../src/simulation/battle_snapshot";
import { LookaheadDriver } from "../../src/simulation/lookahead";
import { Unit } from "../../src/units/unit";
import { UnitsHolder } from "../../src/units/units_holder";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

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

interface FullSnapshot {
    battle: BattleSnapshot;
    stats: IDamageStatistic[];
    active: string;
    tick: number;
}

interface Harness {
    grid: Grid;
    unitsHolder: UnitsHolder;
    fightProperties: ReturnType<FightStateManager["getFightProperties"]>;
    driver: LookaheadDriver;
    activeUnit: () => Unit | undefined;
    decideActive: () => GameAction[];
    playTurns: (n: number) => void;
    finished: () => boolean;
    snapshot: () => FullSnapshot;
    restore: (s: FullSnapshot) => void;
}

/**
 * A minimal mid-fight driver mirroring src/simulation/battle_engine.ts, but with a DETERMINISTIC clock
 * (a counter, folded into the snapshot) so a rolled-back replay is bit-reproducible. This isolates the
 * property under test — a lookahead search must not consume the seeded RNG stream or leak battle state —
 * from the sim's pre-existing wall-clock non-determinism (getTimeMillis; runMatch is itself not
 * bit-reproducible run-to-run because of it, independent of lookahead).
 */
function buildBattle(seed: number, version = "v0.5"): Harness {
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
    const clock = { tick: 0 };
    const runtime = { ...createDefaultGameRuntime(), clock: { nowMillis: () => (clock.tick += 1) } };
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

    const driver = new LookaheadDriver({
        engine,
        turnEngine,
        grid,
        unitsHolder,
        fightProperties,
        pathHelper,
        attackHandler,
        strategyForTeam: () => strategy,
        getActiveUnitId: () => currentActiveUnitId,
        setActiveUnitId: (id) => {
            currentActiveUnitId = id;
        },
        damageDealtThisLap: () => damageStat.has(fightProperties.getCurrentLap()),
        captureDamageStats: () => [...damageStat.get()],
        restoreDamageStats: (saved) => {
            damageStat.clear();
            for (const v of saved) {
                damageStat.add(v);
            }
        },
    });

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

    const ensureActive = (): Unit | undefined => {
        if (finished) return undefined;
        if (!currentActiveUnitId) {
            advance();
            if (finished || !currentActiveUnitId) return undefined;
        }
        const u = unitsHolder.getAllUnits().get(currentActiveUnitId);
        if (!u || u.isDead()) {
            currentActiveUnitId = "";
            return undefined;
        }
        return u;
    };

    const decideActive = (): GameAction[] => {
        const u = ensureActive();
        if (!u) return [];
        return strategy.decideTurn(u, {
            grid,
            matrix: grid.getMatrix(),
            unitsHolder,
            pathHelper,
            attackHandler,
            fightProperties,
        });
    };

    const playOneTurn = (): void => {
        const unit = ensureActive();
        if (!unit) return;
        const actingId = currentActiveUnitId;
        const decided = strategy.decideTurn(unit, {
            grid,
            matrix: grid.getMatrix(),
            unitsHolder,
            pathHelper,
            attackHandler,
            fightProperties,
        });
        for (const action of decided) {
            applyEvents(engine.apply(action).events);
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
        driver,
        activeUnit: ensureActive,
        decideActive,
        finished: () => finished,
        playTurns: (n: number) => {
            for (let i = 0; i < n && !finished; i += 1) {
                playOneTurn();
            }
        },
        snapshot: () => ({
            battle: snapshotBattle(unitsHolder, grid, fightProperties),
            stats: [...damageStat.get()],
            active: currentActiveUnitId,
            tick: clock.tick,
        }),
        restore: (s: FullSnapshot) => {
            restoreBattle(s.battle, unitsHolder, grid, fightProperties);
            damageStat.clear();
            for (const v of s.stats) damageStat.add(v);
            currentActiveUnitId = s.active;
            clock.tick = s.tick;
            finished = false;
        },
    };
}

describe("lookahead driver — replay determinism / no RNG leak", () => {
    // Reach a non-trivial mid-fight, freeze the full state, then measure the CONT-turn continuation after
    // an injected `prelude`. Because `restore(mid)` runs AFTER the prelude and the RNG is reseeded fresh,
    // any two preludes that leave no residue OUTSIDE the snapshot must yield the identical continuation.
    it("a lookahead search does not consume (advance) the tournament's seeded RNG stream", () => {
        try {
            const h = buildBattle(4242, "v0.5");
            h.playTurns(16);
            expect(h.finished()).toBe(false);
            const unit = h.activeUnit();
            expect(unit).toBeDefined();
            const baseDecision = h.decideActive();

            const draw = (n: number): number[] => {
                const out: number[] = [];
                for (let i = 0; i < n; i += 1) out.push(getRandomInt(0, 1_000_000));
                return out;
            };

            // Reference: the next 40 draws from a freshly-seeded stream, with NO search run.
            setDeterministicRandomSource(makeRng(0xa5a5a5));
            const seqNoSearch = draw(40);

            // Re-seed the SAME stream, run a full lookahead search (which internally swaps to a private
            // stream and restores this one), then draw again. If the search consumed even one value from
            // the real stream, the sequences would differ.
            setDeterministicRandomSource(makeRng(0xa5a5a5));
            h.driver.chooseDecision(unit!, baseDecision);
            const seqAfterSearch = draw(40);

            expect(seqAfterSearch).toEqual(seqNoSearch);
        } finally {
            setDeterministicRandomSource(undefined);
        }
    });

    it("the search itself does not mutate the live battle state", () => {
        try {
            const h = buildBattle(1313, "v0.5");
            h.playTurns(10);
            const unit = h.activeUnit();
            expect(unit).toBeDefined();
            const before = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
            const chosen = h.driver.chooseDecision(unit!, h.decideActive());
            expect(chosen.length).toBeGreaterThan(0);
            const after = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
            expect(after).toEqual(before);
        } finally {
            setDeterministicRandomSource(undefined);
        }
    });
});

function normalize(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
        return Object.is(value, -0) ? 0 : value;
    }
    if ((value as { constructor?: { name?: string } }).constructor?.name === "Denque") {
        return { __denque: (value as { toArray(): unknown[] }).toArray().map(normalize) };
    }
    if (value instanceof Map) {
        return { __map: [...value.entries()].map(([k, v]) => [normalize(k), normalize(v)]) };
    }
    if (value instanceof Set) {
        return { __set: [...value].map(normalize) };
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
