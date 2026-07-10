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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { getAIStrategy, type IAIStrategy, type IDecisionContext } from "../../src/ai";
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
import {
    buildRoster,
    createCombatFactories,
    createUnitFromSpec,
    deterministicSimulationId,
    makeRng,
} from "../../src/simulation/army";
import { GREEN_TEAM, RED_TEAM, simulationGridSettings } from "../../src/simulation/battle_engine";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import { Unit } from "../../src/units/unit";
import { UnitsHolder } from "../../src/units/units_holder";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

const SEARCH_ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_AUDIT",
    "SEARCH_AUDIT_TURNS",
    "SEARCH_INCLUDE_MOVES",
    "SEARCH_OPP_MODEL",
    "V07_VALUE_WEIGHTS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of SEARCH_ENV_KEYS) {
    savedEnv[k] = process.env[k];
}
const setEnv = (patch: Record<string, string | undefined>): void => {
    for (const k of SEARCH_ENV_KEYS) {
        const v = k in patch ? patch[k] : undefined;
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
};

afterEach(() => {
    for (const k of SEARCH_ENV_KEYS) {
        if (savedEnv[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = savedEnv[k];
        }
    }
    setDeterministicRandomSource(undefined);
});

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
    engine: GameActionEngine;
    grid: Grid;
    unitsHolder: UnitsHolder;
    fightProperties: ReturnType<FightStateManager["getFightProperties"]>;
    /** Construct a driver AFTER the desired env is set (the driver reads env in its constructor). */
    makeDriver: () => SearchDriver;
    activeUnit: () => Unit | undefined;
    setActiveUnitId: (id: string) => void;
    decideActive: () => GameAction[];
    playTurns: (n: number) => void;
    finished: () => boolean;
}

/** Mid-fight harness mirroring battle_engine's loop with a deterministic clock (see lookahead.test.ts). */
function buildBattle(seed: number, version = "v0.6", rolloutStrategy?: IAIStrategy): Harness {
    FightStateManager.getInstance();
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

    const deps: ILookaheadDeps = {
        engine,
        turnEngine,
        grid,
        unitsHolder,
        fightProperties,
        pathHelper,
        attackHandler,
        strategyForTeam: () => rolloutStrategy ?? strategy,
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
    };

    const roster = buildRoster(makeRng(seed));
    const greenUnits = roster.map((s, index) =>
        createUnitFromSpec(
            s,
            GREEN_TEAM,
            gridSettings,
            abilityFactory,
            effectFactory,
            false,
            deterministicSimulationId("search-test", seed, GREEN_TEAM, index, s.creatureName, s.amount),
        ),
    );
    const redUnits = roster.map((s, index) =>
        createUnitFromSpec(
            s,
            RED_TEAM,
            gridSettings,
            abilityFactory,
            effectFactory,
            false,
            deterministicSimulationId("search-test", seed, RED_TEAM, index, s.creatureName, s.amount),
        ),
    );
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
        const decided = decideActive();
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
        engine,
        grid,
        unitsHolder,
        fightProperties,
        makeDriver: () => new SearchDriver(deps, { seed, greenVersion: version, redVersion: version }),
        activeUnit: ensureActive,
        setActiveUnitId: (id) => {
            currentActiveUnitId = id;
        },
        decideActive,
        finished: () => finished,
        playTurns: (n: number) => {
            for (let i = 0; i < n && !finished; i += 1) {
                playOneTurn();
            }
        },
    };
}

describe("search driver — gating, hygiene, determinism", () => {
    it("is OFF by default: chooseDecision returns the incumbent reference untouched", () => {
        setEnv({});
        const h = buildBattle(101, "v0.6");
        h.playTurns(6);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        expect(driver.enabled).toBe(false);
        expect(driver.appliesTo("v0.6")).toBe(false);
        expect(driver.chooseDecision(unit!, "v0.6", incumbent)).toBe(incumbent);
    });

    it("only re-decides for versions listed in SEARCH_VERSIONS (default v0.6s)", () => {
        setEnv({ V07_SEARCH: "1" });
        const h = buildBattle(202, "v0.6");
        const driver = h.makeDriver();
        expect(driver.enabled).toBe(true);
        expect(driver.appliesTo("v0.6s")).toBe(true);
        expect(driver.appliesTo("v0.6")).toBe(false);
        expect(driver.appliesTo("v0.5")).toBe(false);
    });

    it("a search does not consume (advance) the tournament's seeded RNG stream", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "2", SEARCH_HORIZON: "6" });
        const h = buildBattle(4242, "v0.6");
        h.playTurns(12);
        expect(h.finished()).toBe(false);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();

        const draw = (n: number): number[] => {
            const out: number[] = [];
            for (let i = 0; i < n; i += 1) out.push(getRandomInt(0, 1_000_000));
            return out;
        };
        setDeterministicRandomSource(makeRng(0xa5a5a5));
        const seqNoSearch = draw(40);
        setDeterministicRandomSource(makeRng(0xa5a5a5));
        driver.chooseDecision(unit!, "v0.6", incumbent);
        const seqAfterSearch = draw(40);
        expect(seqAfterSearch).toEqual(seqNoSearch);
    });

    it("a search does not mutate the live battle state", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "2", SEARCH_HORIZON: "6" });
        const h = buildBattle(1313, "v0.6");
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        const before = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        const chosen = driver.chooseDecision(unit!, "v0.6", incumbent);
        expect(chosen.length).toBeGreaterThan(0);
        const after = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        expect(after).toEqual(before);
    });

    it("is deterministic: the same decision point yields the same choice twice", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "2",
            SEARCH_HORIZON: "6",
            SEARCH_GATE: "0",
        });
        const h = buildBattle(777, "v0.6");
        h.playTurns(10);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        const first = JSON.stringify(driver.chooseDecision(unit!, "v0.6", incumbent));
        const second = JSON.stringify(driver.chooseDecision(unit!, "v0.6", incumbent));
        expect(second).toEqual(first);
    });

    it("is deterministic across fresh same-seed battles, not only repeated calls on one Unit", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "2",
            SEARCH_HORIZON: "6",
            SEARCH_GATE: "0",
        });
        const chooseFresh = (): string => {
            const h = buildBattle(0x5eed, "v0.6");
            h.playTurns(10);
            const unit = h.activeUnit();
            expect(unit).toBeDefined();
            return JSON.stringify(h.makeDriver().chooseDecision(unit!, "v0.6", h.decideActive()));
        };

        expect(chooseFresh()).toBe(chooseFresh());
    });

    it("restores battle and damage state when a rollout throws after mutating the engine", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "1", SEARCH_HORIZON: "2" });
        const h = buildBattle(909, "v0.6");
        h.playTurns(4);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const before = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        const originalApply = h.engine.apply.bind(h.engine);
        h.engine.apply = ((action: GameAction) => {
            const result = originalApply(action);
            if (action.type !== "select_attack_type") {
                throw new Error("injected rollout failure");
            }
            return result;
        }) as GameActionEngine["apply"];

        expect(() => h.makeDriver().chooseDecision(unit!, "v0.6", incumbent)).toThrow("injected rollout failure");
        expect(JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)))).toBe(before);
    });

    it("recovers future no-op policy turns by advancing before defending", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "1", SEARCH_HORIZON: "2" });
        let awaitingRecovery = false;
        const noOpStrategy = {
            version: "test-noop",
            decideTurn: () => {
                awaitingRecovery = true;
                return [];
            },
        } as unknown as IAIStrategy;
        const h = buildBattle(606, "v0.6", noOpStrategy);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const recoveryActions: GameAction["type"][] = [];
        const originalApply = h.engine.apply.bind(h.engine);
        h.engine.apply = ((action: GameAction) => {
            if (awaitingRecovery && action.type !== "select_attack_type") {
                recoveryActions.push(action.type);
                awaitingRecovery = false;
            }
            return originalApply(action);
        }) as GameActionEngine["apply"];

        h.makeDriver().chooseDecision(unit!, "v0.6", h.decideActive());

        expect(recoveryActions.length).toBeGreaterThan(0);
        expect(recoveryActions).toContain("move_unit");
        expect(recoveryActions.every((action) => action === "move_unit" || action === "defend_turn")).toBe(true);
    });

    it("force-transitions a live stalled lap instead of scoring a premature leaf", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6" });
        const h = buildBattle(707, "v0.6");
        expect(h.activeUnit()).toBeDefined();
        h.setActiveUnitId("");
        while (h.fightProperties.dequeueNextUnitId()) {
            // Deliberately reproduce an empty queue with living, not-yet-acted units.
        }
        const driver = h.makeDriver() as unknown as { simAdvance(): void };

        driver.simAdvance();

        expect(h.activeUnit()).toBeDefined();
    });

    it("SEARCH_OPP_MODEL: an unknown version throws at construction instead of silently no-opping", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_OPP_MODEL: "no-such-version" });
        const h = buildBattle(321, "v0.6");
        expect(() => h.makeDriver()).toThrow("Unknown AI version");
    });

    it("SEARCH_OPP_MODEL: rollouts re-model ONLY the searched unit's enemy; the acting side keeps its true policy", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "6",
            SEARCH_OPP_MODEL: "v0.4",
        });
        const trueTeams: TeamType[] = [];
        const trueStrategy = getAIStrategy("v0.6");
        const recordingTrue = {
            version: "v0.6",
            decideTurn: (unit: Unit, context: IDecisionContext): GameAction[] => {
                trueTeams.push(unit.getTeam());
                return trueStrategy.decideTurn(unit, context);
            },
        } as unknown as IAIStrategy;
        const h = buildBattle(1313, "v0.6", recordingTrue);
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const enemyTeam = unit!.getTeam() === GREEN_TEAM ? RED_TEAM : GREEN_TEAM;

        const v04 = getAIStrategy("v0.4");
        const originalDecide = v04.decideTurn.bind(v04);
        const oppTeams: TeamType[] = [];
        (v04 as { decideTurn: IAIStrategy["decideTurn"] }).decideTurn = (u, ctx) => {
            oppTeams.push(u.getTeam());
            return originalDecide(u, ctx);
        };
        try {
            h.makeDriver().chooseDecision(unit!, "v0.6", h.decideActive());
        } finally {
            (v04 as { decideTurn: IAIStrategy["decideTurn"] }).decideTurn = originalDecide;
        }

        expect(oppTeams.length).toBeGreaterThan(0);
        expect(oppTeams.every((t) => t === enemyTeam)).toBe(true);
        expect(trueTeams.length).toBeGreaterThan(0);
        expect(trueTeams.every((t) => t === unit!.getTeam())).toBe(true);
    });

    it("Q2 ablation mode is observational: always returns the incumbent reference", () => {
        setEnv({ Q2_WAIT_ABLATION: "1", SEARCH_ROLLOUTS: "2" });
        const h = buildBattle(555, "v0.6");
        h.playTurns(4);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        expect(driver.appliesTo("v0.6")).toBe(true); // ablation defaults SEARCH_VERSIONS to v0.6
        const chosen = driver.chooseDecision(unit!, "v0.6", incumbent);
        expect(chosen).toBe(incumbent);
    });
});

describe("Q2 oracle — gate-1 act-vs-wait lap-rollout arbitration", () => {
    /** Play forward to a decision point the oracle would actually score: wait-eligible, non-wait incumbent. */
    const findOraclePoint = (h: Harness): { unit: Unit; incumbent: GameAction[] } => {
        for (let i = 0; i < 80 && !h.finished(); i += 1) {
            const unit = h.activeUnit();
            if (!unit) {
                break;
            }
            const fp = h.fightProperties;
            const id = unit.getId();
            const eligible =
                fp.getTeamUnitsAlive(unit.getTeam()) > 1 &&
                !fp.hourglassIncludes(id) &&
                !fp.hasAlreadyMadeTurn(id) &&
                !fp.hasAlreadyHourglass(id);
            const incumbent = h.decideActive();
            if (eligible && incumbent.length > 0 && !incumbent.some((a) => a.type === "wait_turn")) {
                return { unit, incumbent };
            }
            h.playTurns(1);
        }
        throw new Error("no oracle-eligible decision point found");
    };

    it("is gated: Q2_ORACLE=1 applies to v0.6s only by default (the A/B alias), and is off without the env", () => {
        setEnv({});
        const off = buildBattle(11, "v0.6").makeDriver();
        expect(off.enabled).toBe(false);
        setEnv({ Q2_ORACLE: "1" });
        const on = buildBattle(11, "v0.6").makeDriver();
        expect(on.enabled).toBe(true);
        expect(on.appliesTo("v0.6s")).toBe(true);
        expect(on.appliesTo("v0.6")).toBe(false);
        expect(on.appliesTo("v0.5")).toBe(false);
    });

    it("scores ONLY {incumbent, wait}: the chosen decision is the incumbent reference or a lone wait_turn", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "2", SEARCH_GATE: "0" });
        const h = buildBattle(2024, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const chosen = h.makeDriver().chooseDecision(unit, "v0.6", incumbent);
        if (chosen !== incumbent) {
            expect(chosen).toHaveLength(1);
            expect(chosen[0]).toEqual({ type: "wait_turn", unitId: unit.getId() });
        }
    });

    it("never overrides when the gate cannot be cleared (SEARCH_GATE=99)", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "1", SEARCH_GATE: "99" });
        const h = buildBattle(2024, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        expect(h.makeDriver().chooseDecision(unit, "v0.6", incumbent)).toBe(incumbent);
    });

    it("keeps an incumbent that already waits, without running any rollout (degenerate {wait, wait})", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "1" });
        const h = buildBattle(2025, "v0.6");
        const { unit } = findOraclePoint(h);
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        let applies = 0;
        const originalApply = h.engine.apply.bind(h.engine);
        h.engine.apply = ((action: GameAction) => {
            applies += 1;
            return originalApply(action);
        }) as GameActionEngine["apply"];
        expect(h.makeDriver().chooseDecision(unit, "v0.6", incumbent)).toBe(incumbent);
        expect(applies).toBe(0);
    });

    it("skips a unit that cannot hourglass, without running any rollout", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "1" });
        const h = buildBattle(2026, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        h.fightProperties.enqueueHourglass(unit.getId()); // hourglassIncludes -> engine would reject the wait
        let applies = 0;
        const originalApply = h.engine.apply.bind(h.engine);
        h.engine.apply = ((action: GameAction) => {
            applies += 1;
            return originalApply(action);
        }) as GameActionEngine["apply"];
        expect(h.makeDriver().chooseDecision(unit, "v0.6", incumbent)).toBe(incumbent);
        expect(applies).toBe(0);
    });

    it("does not consume the tournament's seeded RNG stream", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "2" });
        const h = buildBattle(2027, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const driver = h.makeDriver();
        const draw = (n: number): number[] => {
            const out: number[] = [];
            for (let i = 0; i < n; i += 1) out.push(getRandomInt(0, 1_000_000));
            return out;
        };
        setDeterministicRandomSource(makeRng(0x517e57));
        const seqNoOracle = draw(40);
        setDeterministicRandomSource(makeRng(0x517e57));
        driver.chooseDecision(unit, "v0.6", incumbent);
        expect(draw(40)).toEqual(seqNoOracle);
    });

    it("does not mutate the live battle state", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "2" });
        const h = buildBattle(2028, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const before = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        h.makeDriver().chooseDecision(unit, "v0.6", incumbent);
        const after = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        expect(after).toEqual(before);
    });

    it("is deterministic: the same decision point yields the same choice twice", () => {
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "2", SEARCH_GATE: "0" });
        const h = buildBattle(2029, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const driver = h.makeDriver();
        const first = JSON.stringify(driver.chooseDecision(unit, "v0.6", incumbent));
        const second = JSON.stringify(driver.chooseDecision(unit, "v0.6", incumbent));
        expect(second).toEqual(first);
    });

    it("counts an engine-rejected wait as the alreadyHourglass desync tripwire instead of overriding", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "q2o-")), "audit.jsonl");
        setEnv({ Q2_ORACLE: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ROLLOUTS: "1", SEARCH_AUDIT: auditPath });
        const h = buildBattle(2030, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const driver = h.makeDriver();
        const originalApply = h.engine.apply.bind(h.engine);
        h.engine.apply = ((action: GameAction) => {
            if (action.type === "wait_turn") {
                return { completed: false, events: [], rejectionReason: "hourglass_not_available" };
            }
            return originalApply(action);
        }) as GameActionEngine["apply"];
        let chosen: GameAction[];
        try {
            chosen = driver.chooseDecision(unit, "v0.6", incumbent);
        } finally {
            h.engine.apply = originalApply as GameActionEngine["apply"];
        }
        expect(chosen).toBe(incumbent); // an illegal wait can never win

        driver.onMatchEnd("v0.6", "elimination");
        const lines = readFileSync(auditPath, "utf8").trim().split("\n");
        const summary = JSON.parse(lines[lines.length - 1]);
        expect(summary.mode).toBe("oracle");
        expect(summary.horizon).toBe("lap");
        expect(summary.q2oScored).toBe(1);
        expect(summary.q2oWaitRejected).toBe(1);
        expect(summary.q2oWaits).toBe(0);
    });

    it("writes the oracle audit summary with the wait-decision statistics", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "q2o-")), "audit.jsonl");
        setEnv({
            Q2_ORACLE: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_GATE: "0",
            SEARCH_AUDIT: auditPath,
            SEARCH_AUDIT_TURNS: "1",
        });
        const h = buildBattle(2031, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const driver = h.makeDriver();
        driver.chooseDecision(unit, "v0.6", incumbent);
        driver.chooseDecision(unit, "v0.6", [{ type: "wait_turn", unitId: unit.getId() }]);
        driver.onMatchEnd("v0.6", "elimination");
        const lines = readFileSync(auditPath, "utf8").trim().split("\n");
        const summary = JSON.parse(lines[lines.length - 1]);
        expect(summary.q2oPoints).toBe(2);
        expect(summary.q2oScored).toBe(1);
        expect(summary.q2oIncumbentWait).toBe(1);
        expect(summary.q2oDeltaCount).toBeLessThanOrEqual(1);
        expect(summary.q2oWaits + (summary.q2oScored - summary.q2oWaits)).toBe(summary.q2oScored);
        const turnRows = lines.slice(0, -1).map((l) => JSON.parse(l));
        expect(turnRows.some((r) => r.t === "q2o")).toBe(true);
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
