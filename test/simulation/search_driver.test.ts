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

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { getAIStrategy, type IAIStrategy, type IDecisionContext, type IEnumeratedCandidate } from "../../src/ai";
import { WAIT_FEATURE_NAMES, WAIT_FEATURE_NAMES_V2_RAW } from "../../src/ai/versions/wait_scorer";
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
import { ilActionSignature, parseIlGameRow, parseIlRow } from "../../src/simulation/il_dataset";
import { parsePhaseBQ2Row } from "../../src/simulation/phase_b_dataset";
import { classifyActions, SearchDriver } from "../../src/simulation/search_driver";
import { DEFAULT_V07_VALUE_WEIGHTS } from "../../src/simulation/v0_7_value_weights";
import { VALUE_FEATURE_NAMES_V2 } from "../../src/simulation/value_features";
import { Unit } from "../../src/units/unit";
import { UnitsHolder } from "../../src/units/units_holder";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

const SEARCH_ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "Q2_DATASET",
    "Q2_DATASET_V2",
    "SEARCH_IL_DATASET",
    "SEARCH_IL_RUN_FINGERPRINT",
    "SEARCH_IL_COHORT",
    "PHASE_B_RUN_FINGERPRINT",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_AUDIT",
    "SEARCH_AUDIT_TURNS",
    "SEARCH_ACTIVE_CHALLENGERS",
    "SEARCH_OBSERVE_ONLY",
    "SEARCH_SHORTLIST",
    "SEARCH_DECISION_DEADLINE_MS",
    "SEARCH_CIRCUIT_BREAKER_MS",
    "SEARCH_LATE_RANGED_FINISH_WEIGHT",
    "SEARCH_INCLUDE_MOVES",
    "SEARCH_MAX_MOVES",
    "SEARCH_MAX_MELEE",
    "SEARCH_MAX_SHOTS",
    "SEARCH_MAX_THROWS",
    "SEARCH_OPP_MODEL",
    "V07_VALUE_WEIGHTS",
    "V07_VALUE_WEIGHTS_V2",
    "V07_WAIT_SCORER",
    "V07_WAIT_WEIGHTS",
    "V07_WAIT_VERSIONS",
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
    const productiveActionTypes = new Set<GameAction["type"]>([
        "move_unit",
        "melee_attack",
        "range_attack",
        "area_throw_attack",
        "cast_spell",
    ]);
    const hasProductiveAction = (actions: readonly GameAction[]): boolean =>
        actions.some((action) => productiveActionTypes.has(action.type));
    const expectEngineAcceptsProductiveDecision = (harness: Harness, actions: readonly GameAction[]): void => {
        const executions = actions.map((action) => ({ action, result: harness.engine.apply(action) }));
        expect(
            executions.some(({ action, result }) => result.completed && productiveActionTypes.has(action.type)),
        ).toBe(true);
        expect(
            executions
                .filter(({ action }) => action.type !== "select_attack_type")
                .every(({ result }) => result.completed),
        ).toBe(true);
    };
    const stableSnapshot = (harness: Harness): unknown => {
        const snapshot = normalize(snapshotBattle(harness.unitsHolder, harness.grid, harness.fightProperties)) as {
            fight?: { id?: string };
        };
        if (snapshot.fight) snapshot.fight.id = "<fight-id>";
        return snapshot;
    };
    const captureCandidates = (
        driver: SearchDriver,
        consumer: "search" | "ablate" = "search",
    ): IEnumeratedCandidate[][] => {
        const calls: IEnumeratedCandidate[][] = [];
        const intercepted = driver as unknown as {
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seedBase: number,
                t0: number,
            ): GameAction[];
            ablate(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seedBase: number,
                t0: number,
            ): GameAction[];
        };
        intercepted[consumer] = (_unit, candidates, incumbent) => {
            calls.push(candidates);
            return incumbent;
        };
        return calls;
    };

    it("shortlists by an immediate leaf while retaining the incumbent and stable top challengers", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_GATE: "0",
            SEARCH_SHORTLIST: "3",
        });
        const harness = buildBattle(90, "v0.6");
        const unit = harness.activeUnit()!;
        const incumbent = harness.decideActive();
        const id = unit.getId();
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "wait", actions: [{ type: "wait_turn", unitId: id }] },
            { kind: "defend", actions: [{ type: "defend_turn", unitId: id }] },
            { kind: "spell", actions: [{ type: "cast_spell", casterId: id, spellName: "test" }] },
            { kind: "move", actions: [{ type: "move_unit", unitId: id, cells: [] }] },
        ] as unknown as IEnumeratedCandidate[];
        const calls: Array<{ kinds: string[]; mode: string; rollouts: number | undefined }> = [];
        const driver = harness.makeDriver() as unknown as {
            counters: { candidatesTotal: number; scoredCandidatesTotal: number };
            scoreCandidates: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
                rollouts?: number,
            ) => number[];
            search: (
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
            ) => GameAction[];
        };
        driver.scoreCandidates = (_unit, scored, _seed, mode, rollouts) => {
            calls.push({ kinds: scored.map(({ kind }) => kind), mode, rollouts });
            if (mode === "leaf") return [0.1, 0.8, 0.4, 0.8, -Infinity];
            return scored.map(({ kind }) => (kind === "spell" ? 0.9 : kind === "wait" ? 0.7 : 0.1));
        };

        expect(driver.search(unit, candidates, incumbent, 123, performance.now())).toEqual(candidates[3].actions);
        expect(calls).toEqual([
            { kinds: ["incumbent", "wait", "defend", "spell", "move"], mode: "leaf", rollouts: 1 },
            { kinds: ["incumbent", "wait", "spell"], mode: "turns", rollouts: 3 },
        ]);
        expect(driver.counters.candidatesTotal).toBe(5);
        expect(driver.counters.scoredCandidatesTotal).toBe(3);
    });

    it("v0.8 prioritizes a scored legal attack, spell, or move over wait, Luck Shield, and mountain mining", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            SEARCH_SHORTLIST: "2",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const harness = buildBattle(91, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: id }];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "wait", actions: [{ type: "wait_turn", unitId: id }] },
            {
                kind: "mine",
                actions: [{ type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } }],
            },
            { kind: "spell", actions: [{ type: "cast_spell", casterId: id, spellName: "productive" }] },
            { kind: "move", actions: [{ type: "move_unit", unitId: id, cells: [] }] },
        ] as unknown as IEnumeratedCandidate[];
        const calls: string[][] = [];
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ) => number[];
            search: (
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
            ) => GameAction[];
        };
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push(scored.map(({ kind }) => kind));
            if (mode === "leaf") return scored.map(({ kind }) => (kind === "wait" || kind === "mine" ? 0.99 : 0.1));
            return scored.map(({ kind }) => (kind === "spell" ? 0.2 : 0.99));
        };

        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), true)).toEqual(candidates[3].actions);
        expect(calls).toEqual([
            ["incumbent", "wait", "mine", "spell", "move"],
            ["incumbent", "spell"],
        ]);
    });

    it("keeps v0.7 scoring unchanged and lets v0.8 use nonproductive actions only without a productive option", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6,v0.8s", SEARCH_GATE: "0" });
        const harness = buildBattle(92, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: id }];
        const mine: GameAction[] = [{ type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } }];
        const productive: GameAction[] = [{ type: "move_unit", unitId: id, path: [] }];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "mine", actions: mine },
            { kind: "move", actions: productive },
        ] as unknown as IEnumeratedCandidate[];
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates: () => number[];
            search: (
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
            ) => GameAction[];
        };
        driver.scoreCandidates = () => [0.1, 0.9, 0.2];
        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), false)).toEqual(mine);
        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), true)).toEqual(productive);

        const noProductive = candidates.slice(0, 2);
        driver.scoreCandidates = () => [0.1, 0.9];
        expect(driver.search(unit, noProductive, incumbent, 123, performance.now(), true)).toEqual(mine);

        // A generated move that the real engine rejects is not a valid productive escape hatch.
        driver.scoreCandidates = () => [0.1, 0.9, -Infinity];
        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), true)).toEqual(mine);
    });

    it("validates SEARCH_SHORTLIST only when search mode is enabled", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_SHORTLIST: "1" });
        expect(() => buildBattle(89, "v0.6").makeDriver()).toThrow("SEARCH_SHORTLIST must be an integer >= 2");

        setEnv({ SEARCH_SHORTLIST: "invalid" });
        expect(buildBattle(88, "v0.6").makeDriver().enabled).toBe(false);
    });

    it("validates an opt-in decision deadline and requires circuit headroom", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_DECISION_DEADLINE_MS: "invalid" });
        expect(() => buildBattle(87, "v0.6").makeDriver()).toThrow("SEARCH_DECISION_DEADLINE_MS must be positive");

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_DECISION_DEADLINE_MS: "275",
            SEARCH_CIRCUIT_BREAKER_MS: "275",
        });
        expect(() => buildBattle(86, "v0.6").makeDriver()).toThrow(
            "SEARCH_DECISION_DEADLINE_MS must be below SEARCH_CIRCUIT_BREAKER_MS",
        );

        setEnv({ SEARCH_DECISION_DEADLINE_MS: "invalid" });
        expect(buildBattle(85, "v0.6").makeDriver().enabled).toBe(false);
    });

    it("validates the opt-in late ranged finish weight only in search mode", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_LATE_RANGED_FINISH_WEIGHT: "invalid" });
        expect(() => buildBattle(84, "v0.6").makeDriver()).toThrow(
            "SEARCH_LATE_RANGED_FINISH_WEIGHT must be between 0 and 16",
        );

        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_LATE_RANGED_FINISH_WEIGHT: "17" });
        expect(() => buildBattle(83, "v0.6").makeDriver()).toThrow(
            "SEARCH_LATE_RANGED_FINISH_WEIGHT must be between 0 and 16",
        );

        setEnv({ SEARCH_LATE_RANGED_FINISH_WEIGHT: "invalid" });
        expect(buildBattle(82, "v0.6").makeDriver().enabled).toBe(false);
    });

    it("keeps weight zero exact and raises late leaves on an injured ranged board", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "search-finish-pressure-")), "audit.jsonl");
        const harness = buildBattle(81, "v0.6");

        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6" });
        const unset = harness.makeDriver();
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_LATE_RANGED_FINISH_WEIGHT: "0" });
        const explicitZero = harness.makeDriver();
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_LATE_RANGED_FINISH_WEIGHT: "2",
            SEARCH_AUDIT: auditPath,
        });
        const weighted = harness.makeDriver();
        weighted.onFightReady();

        const actingTeam = harness.activeUnit()!.getTeam();
        const enemy = [...harness.unitsHolder.getAllUnits().values()].find((unit) => unit.getTeam() !== actingTeam)!;
        enemy.applyDamage(Math.max(1, Math.floor(enemy.getCumulativeHp() / 2)), 0, new SceneLogMock());
        while (harness.fightProperties.getCurrentLap() < 12) {
            harness.fightProperties.flipLap();
        }

        const leaf = (driver: SearchDriver): number =>
            (driver as unknown as { leafValue(team: TeamType): number }).leafValue(actingTeam);
        const unsetValue = leaf(unset);
        expect(leaf(explicitZero)).toBe(unsetValue);
        expect(leaf(weighted)).toBeGreaterThan(unsetValue);

        const weightedState = weighted as unknown as {
            counters: {
                decisions: number;
                finishPressureLeaves: number;
                finishPressureNonzeroLeaves: number;
                finishPressureLogitSum: number;
            };
        };
        expect(weightedState.counters).toMatchObject({
            finishPressureLeaves: 1,
            finishPressureNonzeroLeaves: 1,
        });
        expect(weightedState.counters.finishPressureLogitSum).toBeGreaterThan(0);

        weightedState.counters.decisions = 1;
        weighted.onMatchEnd("v0.6", "turn_cap");
        expect(JSON.parse(readFileSync(auditPath, "utf8"))).toMatchObject({
            lateRangedFinishWeight: 2,
            finishPressureLeaves: 1,
            finishPressureNonzeroLeaves: 1,
        });
    });

    it("uses the committed LiveTwin leaf by default and keeps an explicit material fallback", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6" });
        const learned = buildBattle(91, "v0.6").makeDriver() as unknown as {
            learned: { b: number; w: readonly number[] } | null;
        };
        expect(learned.learned).toEqual(DEFAULT_V07_VALUE_WEIGHTS);

        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", V07_VALUE_WEIGHTS: "material" });
        const material = buildBattle(92, "v0.6").makeDriver() as unknown as { learned: unknown };
        expect(material.learned).toBeNull();
    });

    it("V2 leaf resolution falls back on malformed/all-zero weights and accepts a sole non-zero candidate", () => {
        const weightsV2 = (b: number): string =>
            JSON.stringify({ b, w: new Array(VALUE_FEATURE_NAMES_V2.length).fill(0) });
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", V07_VALUE_WEIGHTS_V2: "not-json" });
        const malformed = buildBattle(93, "v0.6").makeDriver() as unknown as {
            learned: unknown;
            learnedV2: unknown;
        };
        expect(malformed.learned).toEqual(DEFAULT_V07_VALUE_WEIGHTS);
        expect(malformed.learnedV2).toBeNull();

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            V07_VALUE_WEIGHTS: "material",
            V07_VALUE_WEIGHTS_V2: weightsV2(0),
        });
        const disabled = buildBattle(94, "v0.6").makeDriver() as unknown as {
            learned: unknown;
            learnedV2: unknown;
        };
        expect(disabled.learned).toBeNull();
        expect(disabled.learnedV2).toBeNull();

        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", V07_VALUE_WEIGHTS_V2: weightsV2(0.25) });
        const v2 = buildBattle(95, "v0.6").makeDriver() as unknown as {
            learnedV2: { b: number; w: number[] } | null;
        };
        expect(v2.learnedV2?.b).toBe(0.25);
        expect(v2.learnedV2?.w).toHaveLength(VALUE_FEATURE_NAMES_V2.length);
    });

    it("rejects a valid V2 leaf combined with any explicit V07_VALUE_WEIGHTS selector", () => {
        const candidate = JSON.stringify({ b: 0.25, w: new Array(VALUE_FEATURE_NAMES_V2.length).fill(0) });
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            V07_VALUE_WEIGHTS: "material",
            V07_VALUE_WEIGHTS_V2: candidate,
        });
        expect(() => buildBattle(96, "v0.6").makeDriver()).toThrow(
            "V07_VALUE_WEIGHTS_V2 cannot be combined with explicit V07_VALUE_WEIGHTS",
        );
    });

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

    it("keeps wait and defend challengers when SEARCH_ACTIVE_CHALLENGERS is default-off", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6" });
        const h = buildBattle(203, "v0.6");
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const driver = h.makeDriver();
        const calls = captureCandidates(driver);

        expect(driver.chooseDecision(unit!, "v0.6", incumbent)).toBe(incumbent);
        expect(calls).toHaveLength(1);
        expect(calls[0][0].kind).toBe("incumbent");
        expect(calls[0].map((candidate) => candidate.kind)).toEqual(expect.arrayContaining(["wait", "defend"]));
    });

    it("SEARCH_ACTIVE_CHALLENGERS removes wait/defend challengers but never the incumbent anchor", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ACTIVE_CHALLENGERS: "1" });
        const h = buildBattle(204, "v0.6");
        h.playTurns(10);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const activeIncumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const passiveIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        const calls = captureCandidates(driver);

        expect(driver.chooseDecision(unit!, "v0.6", activeIncumbent)).toBe(activeIncumbent);
        expect(driver.chooseDecision(unit!, "v0.6", passiveIncumbent)).toBe(passiveIncumbent);
        expect(calls).toHaveLength(2);
        expect(calls[0][0]).toMatchObject({ kind: "incumbent", actions: activeIncumbent });
        expect(calls[1][0]).toMatchObject({ kind: "incumbent", actions: passiveIncumbent });
        for (const candidates of calls) {
            expect(candidates.slice(1).map((candidate) => candidate.kind)).not.toContain("wait");
            expect(candidates.slice(1).map((candidate) => candidate.kind)).not.toContain("defend");
        }
    });

    it("SEARCH_ACTIVE_CHALLENGERS does not filter Q2 ablation candidates", () => {
        setEnv({ Q2_WAIT_ABLATION: "1", SEARCH_VERSIONS: "v0.6", SEARCH_ACTIVE_CHALLENGERS: "1" });
        const h = buildBattle(205, "v0.6");
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const driver = h.makeDriver();
        const calls = captureCandidates(driver, "ablate");

        expect(driver.chooseDecision(unit!, "v0.6", incumbent)).toBe(incumbent);
        expect(calls).toHaveLength(1);
        expect(calls[0].map((candidate) => candidate.kind)).toEqual(expect.arrayContaining(["wait", "defend"]));
    });

    it("keeps searching subsequent decisions when SEARCH_CIRCUIT_BREAKER_MS is absent", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6" });
        const h = buildBattle(204, "v0.6");
        h.playTurns(10);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const firstIncumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const secondIncumbent: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        const calls = captureCandidates(driver);

        expect(driver.chooseDecision(unit!, "v0.6", firstIncumbent)).toBe(firstIncumbent);
        expect(driver.chooseDecision(unit!, "v0.6", secondIncumbent)).toBe(secondIncumbent);
        expect(calls).toHaveLength(2);
    });

    it("opens a tiny SEARCH_CIRCUIT_BREAKER_MS after the first result, skips later searches, and audits it", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "search-circuit-")), "audit.jsonl");
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_CIRCUIT_BREAKER_MS: "0.000001",
            SEARCH_AUDIT: auditPath,
        });
        const h = buildBattle(204, "v0.6");
        h.playTurns(10);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const firstIncumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const secondIncumbent: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const thirdIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit!.getId() }];
        const firstResult: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        let searchCalls = 0;
        const intercepted = driver as unknown as {
            search(): GameAction[];
        };
        intercepted.search = () => {
            searchCalls += 1;
            return firstResult;
        };

        expect(driver.chooseDecision(unit!, "v0.6", firstIncumbent)).toBe(firstResult);
        expect(driver.chooseDecision(unit!, "v0.6", secondIncumbent)).toBe(secondIncumbent);
        expect(driver.chooseDecision(unit!, "v0.6", thirdIncumbent)).toBe(thirdIncumbent);
        expect(searchCalls).toBe(1);

        driver.onMatchEnd("v0.6", "elimination");
        const summary = JSON.parse(readFileSync(auditPath, "utf8").trim());
        expect(summary).toMatchObject({
            mode: "search",
            decisions: 1,
            lateRangedFinishWeight: 0,
            initialBoardRangedness: 0,
            finishPressureLeaves: 0,
            finishPressureNonzeroLeaves: 0,
            finishPressureLogitSum: 0,
            circuitBreakerMs: 0.000001,
            circuitOpened: true,
            circuitSkipped: 2,
        });
    });

    it("keeps v0.8 productive with an engine-valid fallback after its search circuit opens", () => {
        const auditPath = join(mkdtempSync(join(tmpdir(), "search-v08-circuit-")), "audit.jsonl");
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_CIRCUIT_BREAKER_MS: "0.000001",
            SEARCH_AUDIT: auditPath,
        });
        const h = buildBattle(204, "v0.8s");
        h.playTurns(10);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const firstIncumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const secondIncumbent: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const thirdIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit!.getId() }];
        const firstResult: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        let searchCalls = 0;
        const intercepted = driver as unknown as {
            search(): GameAction[];
        };
        intercepted.search = () => {
            searchCalls += 1;
            return firstResult;
        };

        expect(driver.chooseDecision(unit!, "v0.8s", firstIncumbent)).toBe(firstResult);
        const before = stableSnapshot(h);
        const secondResult = driver.chooseDecision(unit!, "v0.8s", secondIncumbent);
        const thirdResult = driver.chooseDecision(unit!, "v0.8s", thirdIncumbent);
        expect(hasProductiveAction(secondResult)).toBe(true);
        expect(hasProductiveAction(thirdResult)).toBe(true);
        expect(stableSnapshot(h)).toEqual(before);
        expect(searchCalls).toBe(1);

        driver.onMatchEnd("v0.8s", "elimination");
        const summary = JSON.parse(readFileSync(auditPath, "utf8").trim());
        expect(summary).toMatchObject({
            mode: "search",
            decisions: 1,
            circuitBreakerMs: 0.000001,
            circuitOpened: true,
            circuitSkipped: 2,
        });
        expectEngineAcceptsProductiveDecision(h, secondResult);
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

    it("the real shortlist pre-pass preserves live state and reduces full-horizon candidates", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "2",
            SEARCH_SHORTLIST: "2",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const h = buildBattle(1313, "v0.6");
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        const counters = (
            driver as unknown as {
                counters: { candidatesTotal: number; scoredCandidatesTotal: number };
            }
        ).counters;
        const before = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));

        expect(driver.chooseDecision(unit!, "v0.6", incumbent).length).toBeGreaterThan(0);

        const after = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        expect(after).toEqual(before);
        expect(counters.candidatesTotal).toBeGreaterThan(counters.scoredCandidatesTotal);
        expect(counters.scoredCandidatesTotal).toBe(2);
    });

    it("fails closed to the incumbent and restores state when the decision deadline expires", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "6",
            SEARCH_SHORTLIST: "2",
            SEARCH_DECISION_DEADLINE_MS: "0.000001",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const h = buildBattle(1313, "v0.6");
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        const counters = (
            driver as unknown as {
                counters: { deadlineFallbacks: number; scoredCandidatesTotal: number };
            }
        ).counters;
        const before = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));

        expect(driver.chooseDecision(unit!, "v0.6", incumbent)).toBe(incumbent);

        const after = JSON.stringify(normalize(snapshotBattle(h.unitsHolder, h.grid, h.fightProperties)));
        expect(after).toEqual(before);
        expect(counters.deadlineFallbacks).toBe(1);
        expect(counters.scoredCandidatesTotal).toBe(0);
    });

    it("uses an engine-valid productive v0.8 fallback when the decision deadline expires", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "6",
            SEARCH_SHORTLIST: "2",
            SEARCH_DECISION_DEADLINE_MS: "0.000001",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const h = buildBattle(1313, "v0.8s");
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        const counters = (
            driver as unknown as {
                counters: { deadlineFallbacks: number; scoredCandidatesTotal: number };
            }
        ).counters;
        const before = stableSnapshot(h);
        setDeterministicRandomSource(makeRng(0x5eed));
        const expectedNextRandom = getRandomInt(0, 1_000_000);
        setDeterministicRandomSource(makeRng(0x5eed));

        const chosen = driver.chooseDecision(unit!, "v0.8s", incumbent);

        expect(chosen).not.toBe(incumbent);
        expect(hasProductiveAction(chosen)).toBe(true);
        expect(stableSnapshot(h)).toEqual(before);
        expect(getRandomInt(0, 1_000_000)).toBe(expectedNextRandom);
        expect(counters.deadlineFallbacks).toBe(1);
        expect(counters.scoredCandidatesTotal).toBe(0);
        expectEngineAcceptsProductiveDecision(h, chosen);
    });

    it("keeps v0.8 observe-only deadline and circuit fallbacks on the exact incumbent", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_OBSERVE_ONLY: "1",
            SEARCH_DECISION_DEADLINE_MS: "0.000001",
            SEARCH_CIRCUIT_BREAKER_MS: "0.00001",
        });
        const h = buildBattle(1313, "v0.8s");
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const firstIncumbent: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const secondIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        const counters = (
            driver as unknown as {
                counters: { decisions: number; deadlineFallbacks: number; circuitSkipped: number };
            }
        ).counters;

        expect(driver.chooseDecision(unit!, "v0.8s", firstIncumbent)).toBe(firstIncumbent);
        expect(driver.chooseDecision(unit!, "v0.8s", secondIncumbent)).toBe(secondIncumbent);
        expect(counters).toMatchObject({ decisions: 1, deadlineFallbacks: 1, circuitSkipped: 1 });
    });

    it("skips a rejected productive probe and preserves a true no-productive fallback", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        const h = buildBattle(1313, "v0.8s");
        h.playTurns(8);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: unit!.getId() }];
        const driver = h.makeDriver();
        const calls = captureCandidates(driver);
        expect(driver.chooseDecision(unit!, "v0.8s", incumbent)).toBe(incumbent);
        const productive = calls[0].filter((candidate) => hasProductiveAction(candidate.actions));
        expect(productive.length).toBeGreaterThan(0);
        const invalid = {
            ...productive[0],
            kind: "move",
            actions: [{ type: "move_unit", unitId: unit!.getId(), path: [] }],
        } as IEnumeratedCandidate;
        const internal = driver as unknown as {
            firstEngineValidProductiveCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
            ): IEnumeratedCandidate | undefined;
        };
        const before = stableSnapshot(h);

        const fallback = internal.firstEngineValidProductiveCandidate(unit!, [invalid, ...productive], 123);
        h.setActiveUnitId(unit!.getId());
        expect(fallback).toBe(productive[0]);
        expect(stableSnapshot(h)).toEqual(before);

        expect(internal.firstEngineValidProductiveCandidate(unit!, [invalid], 123)).toBeUndefined();
        h.setActiveUnitId(unit!.getId());
        expect(stableSnapshot(h)).toEqual(before);
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

    it("keeps a seeded unsearched policy state and decision byte-identical when IL knobs are ignored", () => {
        const capture = (withIgnoredIlKnob: boolean): string => {
            setEnv(withIgnoredIlKnob ? { SEARCH_IL_DATASET: "/tmp/ignored-il-v3.jsonl" } : {});
            const h = buildBattle(0x1a17, "v0.6");
            h.playTurns(12);
            return JSON.stringify({
                state: stableSnapshot(h),
                decision: h.decideActive(),
            });
        };

        expect(capture(true)).toBe(capture(false));
    });

    it("keeps a seeded searched decision byte-identical with v3 IL collection on or off", () => {
        const dir = mkdtempSync(join(tmpdir(), "ild-identity-"));
        const capture = (withIl: boolean): string => {
            setEnv({
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.6",
                SEARCH_ROLLOUTS: "1",
                SEARCH_HORIZON: "2",
                SEARCH_GATE: "0",
                SEARCH_SHORTLIST: "2",
                ...(withIl
                    ? {
                          SEARCH_IL_DATASET: join(dir, "rows.jsonl"),
                          SEARCH_IL_RUN_FINGERPRINT: "e".repeat(64),
                          SEARCH_IL_COHORT: "identity",
                      }
                    : {}),
            });
            const h = buildBattle(0x1a18, "v0.6");
            h.playTurns(8);
            const unit = h.activeUnit()!;
            const incumbent = h.decideActive();
            const before = stableSnapshot(h);
            const chosen = h.makeDriver().chooseDecision(unit, "v0.6", incumbent);
            const after = stableSnapshot(h);
            return JSON.stringify({ incumbent, chosen, before, after });
        };

        expect(capture(true)).toBe(capture(false));
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

    it("Q2_DATASET dumps one wait-scorer-aligned row per wait-eligible point (Gate-2 fit input)", () => {
        const datasetPath = join(mkdtempSync(join(tmpdir(), "q2d-")), "dataset.jsonl");
        setEnv({
            Q2_ORACLE: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_GATE: "0",
            Q2_DATASET: datasetPath,
        });
        const h = buildBattle(2032, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const driver = h.makeDriver();
        driver.chooseDecision(unit, "v0.6", incumbent); // scored act point
        driver.chooseDecision(unit, "v0.6", [{ type: "wait_turn", unitId: unit.getId() }]); // kept policy wait
        driver.onMatchEnd("v0.6", "elimination");
        const rows = readFileSync(datasetPath, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.t).toBe("q2d");
            expect(row.s).toBe(2032);
            expect(row.g).toBe("v0.6");
            expect(row.f).toHaveLength(WAIT_FEATURE_NAMES.length);
            expect(row.f.every((x: unknown) => typeof x === "number" && Number.isFinite(x))).toBe(true);
        }
        const scored = rows.find((r) => r.iw === 0);
        const keptWait = rows.find((r) => r.iw === 1);
        expect(scored).toBeDefined();
        expect(keptWait).toBeDefined();
        expect([0, 1]).toContain(scored.y);
        expect(scored.rej).toBe(0);
        expect(typeof scored.d).toBe("number"); // the rollout value delta (wait minus act)
        expect(keptWait.y).toBe(1);
        expect(keptWait.d).toBeNull();
        expect(keptWait.k).toBe("wait");
    });

    it("Q2_DATASET_V2 requires provenance and emits self-describing oracle rows", () => {
        const datasetPath = join(mkdtempSync(join(tmpdir(), "q2d-v2-")), "dataset.jsonl");
        const fingerprint = "a".repeat(64);
        setEnv({
            Q2_ORACLE: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_GATE: "0",
            SEARCH_OPP_MODEL: "v0.4",
            Q2_DATASET: datasetPath,
            Q2_DATASET_V2: "1",
        });
        const missing = buildBattle(2033, "v0.6");
        expect(() => missing.makeDriver()).toThrow("PHASE_B_RUN_FINGERPRINT");

        setEnv({
            Q2_ORACLE: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_GATE: "0",
            SEARCH_OPP_MODEL: "v0.4",
            Q2_DATASET: datasetPath,
            Q2_DATASET_V2: "1",
            PHASE_B_RUN_FINGERPRINT: fingerprint,
        });
        const h = buildBattle(2033, "v0.6");
        const { unit, incumbent } = findOraclePoint(h);
        const driver = h.makeDriver();
        driver.chooseDecision(unit, "v0.6", incumbent);
        driver.chooseDecision(unit, "v0.6", [{ type: "wait_turn", unitId: unit.getId() }]);
        driver.onMatchEnd("v0.6", "elimination");

        const rows = readFileSync(datasetPath, "utf8")
            .trim()
            .split("\n")
            .map((line, index) =>
                parsePhaseBQ2Row(JSON.parse(line), WAIT_FEATURE_NAMES_V2_RAW.length, fingerprint, `row ${index}`),
            );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.v).toBe(2);
            expect(row.runFingerprint).toBe(fingerprint);
            expect(row.seed).toBe(2033);
            expect(row.features).toHaveLength(WAIT_FEATURE_NAMES_V2_RAW.length);
            expect(row.oracle).toEqual({
                gate: 0,
                rollouts: 1,
                horizon: "lap",
                leaf: "learned",
                opponentModel: "v0.4",
            });
        }
        expect(rows.find((row) => row.incumbentWait === 1)?.delta).toBeNull();
    });

    it("SEARCH_IL_DATASET dumps one imitation row per searched decision (search mode only)", () => {
        const dir = mkdtempSync(join(tmpdir(), "ild-"));
        const ilPath = join(dir, "il.jsonl");
        const fingerprint = "d".repeat(64);
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "2",
            SEARCH_GATE: "0",
            SEARCH_SHORTLIST: "2",
            SEARCH_IL_DATASET: ilPath,
            SEARCH_IL_RUN_FINGERPRINT: fingerprint,
            SEARCH_IL_COHORT: "smoke",
        });
        const h = buildBattle(2040, "v0.6");
        const unit = h.activeUnit()!;
        const incumbent = h.decideActive();
        const driver = h.makeDriver();
        const decided = driver.chooseDecision(unit, "v0.6", incumbent);
        driver.onMatchEnd("green", "elimination");
        const lines = readFileSync(ilPath, "utf8").trim().split("\n");
        expect(lines).toHaveLength(2);
        const row = parseIlRow(JSON.parse(lines[0]), fingerprint);
        const game = parseIlGameRow(JSON.parse(lines[1]), fingerprint);
        expect(row.seed).toBe(2040);
        expect(row.cohort).toBe("smoke");
        expect(row.decision).toBe(0);
        expect(row.green).toBe("v0.6");
        expect(row.k).toBe(classifyActions(incumbent));
        expect(row.cands[0].kind).toBe("incumbent");
        expect(row.cands[0].sig).toBe(ilActionSignature(incumbent));
        expect(row.vf).toHaveLength(VALUE_FEATURE_NAMES_V2.length);
        expect(row.cands.every((candidate) => candidate.af.length > 40)).toBe(true);
        expect(row.cands.every((candidate) => candidate.ck === candidate.am.family)).toBe(true);
        // The dumped chosen index resolves to the exact turn the driver returned to the battle loop.
        expect(row.cands[row.chosen].sig).toBe(ilActionSignature(decided));
        expect(row.act.length).toBeGreaterThan(0);
        expect(row.cands).toHaveLength(2);
        expect(row.nc).toBeGreaterThanOrEqual(row.cands.length);
        expect(row.cfg).toEqual({
            gate: 0,
            horizon: 2,
            rollouts: 1,
            leaf: "learned",
            shortlist: 2,
            includeMoves: 0,
            activeChallengers: 0,
            oppModel: null,
            decisionDeadlineMs: null,
            circuitBreakerMs: null,
            caps: {
                maxMoveDestinations: 1,
                maxMeleePairs: 8,
                maxShotAims: 6,
                maxAreaThrowCells: 4,
            },
        });
        // The incumbent's mean leaf is comparable (finite) unless it was illegal in simulation.
        expect(row.cands.some((c) => c.m !== null)).toBe(true);
        expect(game).toMatchObject({
            rows: 1,
            decisions: 1,
            searched: 1,
            singleCandidate: 0,
            deadlineFallbacks: 0,
            circuitOpened: 0,
            circuitSkipped: 0,
            cfg: {
                shortlist: 2,
                activeChallengers: 0,
                decisionDeadlineMs: null,
                circuitBreakerMs: null,
                caps: {
                    maxMoveDestinations: 1,
                    maxMeleePairs: 8,
                    maxShotAims: 6,
                    maxAreaThrowCells: 4,
                },
            },
        });

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_IL_DATASET: join(dir, "missing-provenance.jsonl"),
        });
        expect(() => buildBattle(2042, "v0.6").makeDriver()).toThrow("SEARCH_IL_RUN_FINGERPRINT");

        // Oracle mode never writes IL rows — the knob is search-mode only.
        const oraclePath = join(dir, "oracle-il.jsonl");
        setEnv({
            Q2_ORACLE: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_GATE: "0",
            SEARCH_IL_DATASET: oraclePath,
        });
        const oracleBattle = buildBattle(2041, "v0.6");
        const { unit: oracleUnit, incumbent: oracleIncumbent } = findOraclePoint(oracleBattle);
        const oracleDriver = oracleBattle.makeDriver();
        oracleDriver.chooseDecision(oracleUnit, "v0.6", oracleIncumbent);
        oracleDriver.onMatchEnd("v0.6", "elimination");
        expect(existsSync(oraclePath)).toBe(false);
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

describe("Q2 gate-2 — deployed wait-scorer wiring (v0.6 decideTurn, live battle)", () => {
    /** Fast-forward (scorer disarmed) to a wait-eligible point whose incumbent decision is an act. */
    const findEligibleActPoint = (h: Harness): { unit: Unit; incumbent: GameAction[] } => {
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
        throw new Error("no wait-eligible act point found");
    };
    const armedBias = (b: number): string => JSON.stringify({ b, w: new Array(WAIT_FEATURE_NAMES.length).fill(0) });

    it("armed scorer overrides v0.6s's act to a wait the ENGINE ACCEPTS (mirror/engine legality parity)", () => {
        setEnv({});
        // Re-pinned 3101 -> 2 after enabling Arachna Queen expanded the L4 roster pool and shifted the
        // seeded battle at 3101 to a caster decision that the scorer correctly leaves active.
        const h = buildBattle(2, "v0.6s");
        const { unit } = findEligibleActPoint(h);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: armedBias(9) });
        const decided = h.decideActive();
        expect(decided).toEqual([{ type: "wait_turn", unitId: unit.getId() }]);
        const applied = h.engine.apply(decided[0]);
        expect(applied.completed).toBe(true);
    });

    it("scorer stays scoped to v0.6s by default: plain v0.6 decides identically even when armed", () => {
        setEnv({});
        const a = buildBattle(3103, "v0.6");
        findEligibleActPoint(a);
        const offDecision = JSON.stringify(a.decideActive());

        setEnv({});
        const b = buildBattle(3103, "v0.6");
        findEligibleActPoint(b);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: armedBias(9) });
        expect(JSON.stringify(b.decideActive())).toBe(offDecision);
    });

    it("anchor: gate on with ALL-ZERO weights decides byte-identically to the env being unset", () => {
        setEnv({});
        const a = buildBattle(3102, "v0.6s");
        findEligibleActPoint(a);
        const offDecision = JSON.stringify(a.decideActive());

        setEnv({});
        const b = buildBattle(3102, "v0.6s");
        findEligibleActPoint(b);
        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: armedBias(0) });
        expect(JSON.stringify(b.decideActive())).toBe(offDecision);
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
