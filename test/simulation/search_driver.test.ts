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

import {
    enumerateCandidates,
    getAIStrategy,
    type IAIStrategy,
    type IDecisionContext,
    type IEnumeratedCandidate,
} from "../../src/ai";
import { isV08StrongerRangedPostureWait } from "../../src/ai/versions/v0_8";
import { V08_DOMINANT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import { V08S_URGENT_FINISH_START_LAP, V08_TARGET_PRESSURE_START_LAP } from "../../src/ai/versions/v0_8s_finish";
import {
    canWaitOnHourglassMirror,
    WAIT_FEATURE_NAMES,
    WAIT_FEATURE_NAMES_V2_RAW,
    waitScorerInSupport,
} from "../../src/ai/versions/wait_scorer";
import type { GameAction } from "../../src/engine/actions";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { createDefaultGameRuntime } from "../../src/engine/runtime";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { Grid } from "../../src/grid/grid";
import { getPositionForCell } from "../../src/grid/grid_math";
import type { GridType } from "../../src/grid/grid_type";
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
    type IArmyUnitSpec,
} from "../../src/simulation/army";
import { GREEN_TEAM, RED_TEAM, simulationGridSettings } from "../../src/simulation/battle_engine";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { ilActionSignature, parseIlGameRow, parseIlRow } from "../../src/simulation/il_dataset";
import { buildMirrorRoster } from "../../src/simulation/measure_mirror_cohorts";
import { parsePhaseBQ2Row } from "../../src/simulation/phase_b_dataset";
import { MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES } from "../../src/simulation/pure_ranged_pareto_no_melee_focus";
import {
    classifyActions,
    isV08SoleAbominationArmageddonDefendOpportunity,
    SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY_ENV,
    SearchDriver,
    SearchRollbackError,
    type ISearchMatchInfo,
    type ISearchPassiveProductiveProbe,
    type SearchPassiveProductiveProbeObserver,
    type SearchRollbackStrategy,
} from "../../src/simulation/search_driver";
import { runV08BlockCenterActionPanelGame } from "../../src/simulation/v0_8_block_center_action_panel";
import { DEFAULT_V07_VALUE_WEIGHTS } from "../../src/simulation/v0_7_value_weights";
import { VALUE_FEATURE_NAMES_V2 } from "../../src/simulation/value_features";
import { Unit } from "../../src/units/unit";
import { UnitsHolder } from "../../src/units/units_holder";
import { getDeterministicRandomSource, getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";

const SEARCH_ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "Q2_DATASET",
    "Q2_DATASET_V2",
    "SEARCH_IL_DATASET",
    "SEARCH_IL_RUN_FINGERPRINT",
    "SEARCH_ROLLBACK_STRATEGY",
    "SEARCH_IL_COHORT",
    "PHASE_B_RUN_FINGERPRINT",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_AUDIT",
    "SEARCH_AUDIT_TURNS",
    "SEARCH_ACTIVE_CHALLENGERS",
    "SEARCH_A19_ABOMINATION_MIRROR_RELEASE",
    "SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE",
    "SEARCH_A19_EXACT_TERMINAL_RESULTS",
    "SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION",
    "SEARCH_A19_NONREGRESSIVE_PRODUCTIVE_OVERRIDE",
    "SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY",
    "SEARCH_A19_FAST_FLYER_COHESION",
    "SEARCH_A19_STRICT_AGGRESSIVE_WAIT_TIES",
    "V08_AGGRESSIVE",
    "SEARCH_OBSERVE_ONLY",
    "SEARCH_SHORTLIST",
    "SEARCH_DECISION_DEADLINE_MS",
    "SEARCH_WAIT_DEADLINE_POLICY",
    "SEARCH_CIRCUIT_BREAKER_MS",
    "SEARCH_LATE_RANGED_FINISH_WEIGHT",
    "SEARCH_PURE_RANGED_NO_MELEE_PRESSURE",
    "SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS",
    "SEARCH_PURE_RANGED_DEADLINE_FINISHER",
    "SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR",
    "SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE",
    "SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS",
    "SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS",
    "SEARCH_INCLUDE_MOVES",
    "SEARCH_MAX_MOVES",
    "SEARCH_MAX_MOVE_SHOTS",
    "SEARCH_MOVE_SHOT_VERSIONS",
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
    pathHelper: PathHelper;
    attackHandler: AttackHandler;
    /** Construct a driver AFTER the desired env is set (the driver reads env in its constructor). */
    makeDriver: (
        passiveProductiveProbeObserver?: SearchPassiveProductiveProbeObserver,
        rollbackStrategy?: SearchRollbackStrategy,
        matchPatch?: Partial<ISearchMatchInfo>,
    ) => SearchDriver;
    activeUnit: () => Unit | undefined;
    setActiveUnitId: (id: string) => void;
    failNextActiveUnitRestore: () => void;
    decideActive: () => GameAction[];
    playTurns: (n: number) => void;
    finished: () => boolean;
}

// Keep wait-specific fixtures independent of Nightmare's board-wide Time Denial, which intentionally removes Hourglass.
const HOURGLASS_FIXTURE_ROSTER: readonly IArmyUnitSpec[] = [
    { faction: "Chaos", creatureName: "Orc", level: 1, size: 1, amount: 50 },
    { faction: "Nature", creatureName: "Leprechaun", level: 1, size: 1, amount: 50 },
    { faction: "Nature", creatureName: "White Tiger", level: 2, size: 1, amount: 30 },
    { faction: "Life", creatureName: "Battle Mage", level: 2, size: 1, amount: 30 },
    { faction: "Nature", creatureName: "Unicorn", level: 3, size: 1, amount: 15 },
    { faction: "Might", creatureName: "Thunderbird", level: 4, size: 2, amount: 8 },
];

/** Mid-fight harness mirroring battle_engine's loop with a deterministic clock (see lookahead.test.ts). */
function buildBattle(
    seed: number,
    version = "v0.6",
    rolloutStrategy?: IAIStrategy,
    rosterOverride?: readonly IArmyUnitSpec[],
    failDamageRestore = false,
    gridType: GridType = PBTypes.GridVals.NORMAL,
): Harness {
    FightStateManager.getInstance();
    setDeterministicRandomSource(makeRng((seed ^ 0x6d2b79f5) >>> 0));

    const gridSettings = simulationGridSettings();
    FightStateManager.getInstance().reset();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(gridType);
    const grid = new Grid(gridSettings, gridType);
    const unitsHolder = new UnitsHolder(grid);
    const sceneLog = new SceneLogMock();
    const damageStat = new DamageStatHolder();
    const attackHandler = new AttackHandler(gridSettings, grid, sceneLog, damageStat);
    const moveHandler = new MoveHandler(gridSettings, grid, unitsHolder);
    const pathHelper = new PathHelper(gridSettings);
    const clock = { tick: 0 };
    const runtime = { ...createDefaultGameRuntime(), clock: { nowMillis: () => (clock.tick += 1) } };
    const { abilityFactory, effectFactory } = createCombatFactories();

    const greenZone = new RectanglePlacement(gridSettings, PlacementPositionType.LOWER_LEFT, 3);
    const redZone = new RectanglePlacement(gridSettings, PlacementPositionType.UPPER_RIGHT, 3);
    const zoneHashesFor = (team: TeamType): Set<number> =>
        team === GREEN_TEAM ? greenZone.possibleCellHashes() : redZone.possibleCellHashes();

    let currentActiveUnitId = "";
    let failNextActiveUnitRestore = false;
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
            if (failNextActiveUnitRestore) {
                failNextActiveUnitRestore = false;
                throw new Error("injected active-unit restore failure");
            }
            currentActiveUnitId = id;
        },
        damageDealtThisLap: () => damageStat.has(fightProperties.getCurrentLap()),
        captureDamageStats: () => [...damageStat.get()],
        restoreDamageStats: (saved) => {
            damageStat.clear();
            for (const v of saved) {
                damageStat.add(v);
            }
            if (failDamageRestore) {
                throw new Error("injected damage-stat restore failure");
            }
        },
    };

    const roster = rosterOverride ?? buildRoster(makeRng(seed));
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
        pathHelper,
        attackHandler,
        makeDriver: (passiveProductiveProbeObserver, rollbackStrategy, matchPatch) =>
            new SearchDriver(
                deps,
                { seed, greenVersion: version, redVersion: version, ...matchPatch },
                undefined,
                passiveProductiveProbeObserver,
                rollbackStrategy,
            ),
        activeUnit: ensureActive,
        setActiveUnitId: (id) => {
            currentActiveUnitId = id;
        },
        failNextActiveUnitRestore: () => {
            failNextActiveUnitRestore = true;
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

    const soleAbominationArmageddonFixture = (
        keepExtraStacks = false,
    ): { harness: Harness; actor: Unit; enemy: Unit; extras: Unit[] } => {
        const harness = buildBattle(9_001, "v0.8", undefined, [
            { faction: "Chaos", creatureName: "Abomination", level: 4, size: 2, amount: 8 },
            { faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 1 },
        ]);
        const named = (team: TeamType, name: string): Unit =>
            harness.unitsHolder
                .getAllAllies(team)
                .find((candidate) => !candidate.isDead() && candidate.getName() === name)!;
        const actor = named(GREEN_TEAM, "Abomination");
        const enemy = named(RED_TEAM, "Abomination");
        const extras = [named(GREEN_TEAM, "Squire"), named(RED_TEAM, "Squire")];
        if (!keepExtraStacks) {
            for (const extra of extras) harness.unitsHolder.deleteUnitById(extra.getId());
        }
        actor.applyDamage(964, 0, new SceneLogMock());
        enemy.applyDamage(1_416, 0, new SceneLogMock());
        while (harness.fightProperties.getCurrentLap() < 9) harness.fightProperties.flipLap();
        harness.setActiveUnitId(actor.getId());
        return { harness, actor, enemy, extras };
    };

    it("keeps the sole-Abomination Armageddon policy default-off and validates its flag", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8" });
        const fixture = soleAbominationArmageddonFixture();
        expect(
            isV08SoleAbominationArmageddonDefendOpportunity(
                fixture.actor,
                fixture.harness.unitsHolder,
                fixture.harness.fightProperties.getCurrentLap(),
            ),
        ).toBe(true);
        expect(
            (
                fixture.harness.makeDriver() as unknown as {
                    soleAbominationArmageddonDefendPolicy: boolean;
                }
            ).soleAbominationArmageddonDefendPolicy,
        ).toBe(false);

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            [SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY_ENV]: "invalid",
        });
        expect(() => fixture.harness.makeDriver()).toThrow(
            `${SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY_ENV} must be 0 or 1`,
        );
    });

    it("requires exactly one living Abomination per side", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8" });
        const { harness, actor, extras } = soleAbominationArmageddonFixture(true);
        expect(
            isV08SoleAbominationArmageddonDefendOpportunity(
                actor,
                harness.unitsHolder,
                harness.fightProperties.getCurrentLap(),
            ),
        ).toBe(false);

        for (const extra of extras) harness.unitsHolder.deleteUnitById(extra.getId());
        expect(
            isV08SoleAbominationArmageddonDefendOpportunity(
                actor,
                harness.unitsHolder,
                harness.fightProperties.getCurrentLap(),
            ),
        ).toBe(true);
    });

    it("uses the same sole-Abomination Armageddon defend policy live and in own-side rollouts", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            [SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY_ENV]: "1",
        });
        const live = soleAbominationArmageddonFixture();
        const liveDriver = live.harness.makeDriver() as unknown as {
            counters: { decisions: number; soleAbominationArmageddonDefends: number };
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: live.actor.getId() }];
        expect(liveDriver.chooseDecision(live.actor, "v0.8", incumbent)).toEqual([
            { type: "defend_turn", unitId: live.actor.getId() },
        ]);
        expect(liveDriver.counters).toMatchObject({ decisions: 1, soleAbominationArmageddonDefends: 1 });

        const rollout = soleAbominationArmageddonFixture();
        const rolloutActions: GameAction[] = [];
        const interceptedEngine = rollout.harness.engine as unknown as {
            apply(action: GameAction): ReturnType<GameActionEngine["apply"]>;
        };
        interceptedEngine.apply = (action) => {
            rolloutActions.push(action);
            return { completed: true, events: [] };
        };
        const rolloutDriver = rollout.harness.makeDriver() as unknown as {
            counters: { soleAbominationArmageddonDefends: number };
            rolloutEnemyTeam: TeamType | null;
            simPlayTurn(unit: Unit): void;
        };
        rolloutDriver.rolloutEnemyTeam = RED_TEAM;
        rolloutDriver.simPlayTurn(rollout.actor);
        expect(rolloutActions[0]).toEqual({ type: "defend_turn", unitId: rollout.actor.getId() });
        expect(rolloutDriver.counters.soleAbominationArmageddonDefends).toBe(0);
    });

    it("raises a typed fatal error when rollout cleanup cannot prove the state restored", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
        });
        const harness = buildBattle(89, "v0.6", undefined, undefined, true);
        const unit = harness.activeUnit()!;
        const incumbent = harness.decideActive();
        const before = stableSnapshot(harness);
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates: (
                unit: Unit,
                candidates: readonly Array<{ kind: string; actions: GameAction[] }>,
                seedBase: number,
                horizonMode: string,
                rolloutCount: number,
            ) => number[];
        };

        expect(() =>
            driver.scoreCandidates(unit, [{ kind: "incumbent", actions: incumbent }], 123, "turns", 1),
        ).toThrow(SearchRollbackError);
        expect(stableSnapshot(harness)).toEqual(before);
    });

    it("restores the outer RNG before surfacing an active-unit cleanup failure", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
        });
        const harness = buildBattle(88, "v0.6");
        const unit = harness.activeUnit()!;
        const incumbent = harness.decideActive();
        const savedSource = (): number => 0.25;
        setDeterministicRandomSource(savedSource);
        const driver = harness.makeDriver() as unknown as {
            search: (
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seedBase: number,
                t0: number,
            ) => GameAction[];
            chooseDecision: (
                unit: Unit,
                version: string,
                incumbent: GameAction[],
                context?: IDecisionContext,
            ) => GameAction[];
        };
        driver.search = (_unit, _candidates, actions) => actions;
        harness.failNextActiveUnitRestore();

        expect(() => driver.chooseDecision(unit, "v0.6", incumbent)).toThrow(SearchRollbackError);
        expect(getDeterministicRandomSource()).toBe(savedSource);
    });

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

    it("A19 repairs a hard passive only with a nonregressive productive rollout", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "1",
            SEARCH_A19_NONREGRESSIVE_PRODUCTIVE_OVERRIDE: "1",
        });
        const harness = buildBattle(91, "v0.8");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: id }];
        const spell: GameAction[] = [{ type: "cast_spell", casterId: id, spellName: "productive" }];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "spell", actions: spell },
        ] as unknown as IEnumeratedCandidate[];
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates(): number[];
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
            ): GameAction[];
        };

        driver.scoreCandidates = () => [0.99, 0.01];
        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), true)).toBe(incumbent);

        driver.scoreCandidates = () => [0.5, 0.5];
        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), true)).toBe(spell);
    });

    it("A19 validates only a provisional override and requires the full gate in an independent paired bank", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "0.03",
            SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION: "1",
        });
        const harness = buildBattle(92, "v0.8");
        const unit = harness.activeUnit()!;
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const attack: GameAction[] = [
            { type: "melee_attack", attackerId: unit.getId(), targetId: "enemy", attackFrom: { x: 4, y: 4 } },
        ];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "melee", actions: attack },
        ] as unknown as IEnumeratedCandidate[];
        const driver = harness.makeDriver() as unknown as {
            counters: {
                nonregressiveOverrideValidationAttempts: number;
                nonregressiveOverrideValidationPasses: number;
                nonregressiveOverrideValidationRejects: number;
            };
            scoreCandidates(): number[];
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
            ): GameAction[];
        };

        let call = 0;
        driver.scoreCandidates = () => (++call === 1 ? [0.4, 0.42] : [0, 1]);
        expect(driver.search(unit, candidates, incumbent, 123, performance.now())).toBe(incumbent);
        expect(call).toBe(1);
        expect(driver.counters).toMatchObject({
            nonregressiveOverrideValidationAttempts: 0,
            nonregressiveOverrideValidationPasses: 0,
            nonregressiveOverrideValidationRejects: 0,
        });

        call = 0;
        driver.scoreCandidates = () => (++call === 1 ? [0.4, 0.8] : [0.7, 0.72]);
        expect(driver.search(unit, candidates, incumbent, 123, performance.now())).toBe(incumbent);
        expect(call).toBe(2);
        expect(driver.counters).toMatchObject({
            nonregressiveOverrideValidationAttempts: 1,
            nonregressiveOverrideValidationPasses: 0,
            nonregressiveOverrideValidationRejects: 1,
        });

        call = 0;
        driver.scoreCandidates = () => (++call === 1 ? [0.4, 0.8] : [0.5, 0.54]);
        expect(driver.search(unit, candidates, incumbent, 123, performance.now())).toBe(attack);
        expect(call).toBe(2);
        expect(driver.counters).toMatchObject({
            nonregressiveOverrideValidationAttempts: 2,
            nonregressiveOverrideValidationPasses: 1,
            nonregressiveOverrideValidationRejects: 1,
        });
    });

    it("does not treat a move-then-mountain incumbent as productive", () => {
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
        const incumbent: GameAction[] = [
            { type: "move_unit", unitId: id, path: [{ x: 3, y: 4 }] },
            { type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } },
        ];
        const move: GameAction[] = [{ type: "move_unit", unitId: id, path: [{ x: 4, y: 4 }] }];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "move", actions: move },
        ] as unknown as IEnumeratedCandidate[];
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
        driver.scoreCandidates = (_unit, scored) => scored.map(({ kind }) => (kind === "incumbent" ? 0.99 : 0.01));

        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), true)).toBe(move);
    });

    it("v0.8 dominant-finish shortlisting forces combat over an ordinary wait through a saturated gate", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            SEARCH_SHORTLIST: "2",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const harness = buildBattle(92, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: id }];
        const attack: GameAction[] = [
            { type: "melee_attack", attackerId: id, targetId: "enemy", attackFrom: { x: 3, y: 4 } },
        ];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            {
                kind: "mine",
                actions: [{ type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } }],
            },
            { kind: "spell", actions: [{ type: "cast_spell", casterId: id, spellName: "support" }] },
            { kind: "move", actions: [{ type: "move_unit", unitId: id, path: [{ x: 4, y: 4 }] }] },
            { kind: "melee", actions: attack, features: { expectedDamage: 10, expectedKill: 0 } },
        ] as unknown as IEnumeratedCandidate[];
        const calls: Array<{ mode: string; kinds: string[] }> = [];
        const driver = harness.makeDriver() as unknown as {
            counters: { dominantFinishCombatOverrides: number };
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
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
            ) => GameAction[];
        };
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push({ mode, kinds: scored.map(({ kind }) => kind) });
            return scored.map(({ kind }) => (kind === "melee" ? 0.01 : kind === "incumbent" ? 0.99 : 0.9));
        };

        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), false, undefined, true)).toEqual(
            attack,
        );
        expect(calls).toEqual([
            { mode: "leaf", kinds: ["incumbent", "mine", "spell", "move", "melee"] },
            { mode: "turns", kinds: ["incumbent", "melee"] },
        ]);
        expect(driver.counters.dominantFinishCombatOverrides).toBe(1);
    });

    it("v0.8 dominant-finish advances before spending a no-attack turn on support", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            SEARCH_SHORTLIST: "2",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const harness = buildBattle(921, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: id }];
        const support: GameAction[] = [{ type: "cast_spell", casterId: id, spellName: "support" }];
        const advance: GameAction[] = [{ type: "move_unit", unitId: id, path: [{ x: 4, y: 4 }] }];
        const candidates = [
            { kind: "incumbent", actions: incumbent },
            { kind: "spell", actions: support },
            { kind: "move", actions: advance },
        ] as unknown as IEnumeratedCandidate[];
        const calls: Array<{ mode: string; kinds: string[] }> = [];
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
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
            ) => GameAction[];
        };
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push({ mode, kinds: scored.map(({ kind }) => kind) });
            return scored.map(({ kind }) => (kind === "spell" ? 0.99 : kind === "incumbent" ? 0.9 : 0.01));
        };

        expect(driver.search(unit, candidates, incumbent, 123, performance.now(), false, undefined, true)).toEqual(
            advance,
        );
        expect(calls).toEqual([
            { mode: "leaf", kinds: ["incumbent", "spell", "move"] },
            { mode: "turns", kinds: ["incumbent", "move"] },
        ]);
    });

    it("arms universal balanced-fight urgency for the a13 alias and production v0.8 at lap 9", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s,v0.8,v0.7", SEARCH_INCLUDE_MOVES: "1" });
        const harness = buildBattle(922, "v0.8s");
        const unit = harness.activeUnit()!;
        while (harness.fightProperties.getCurrentLap() < V08S_URGENT_FINISH_START_LAP) {
            harness.fightProperties.flipLap();
        }
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const flags: Array<{ targetPressure: boolean; urgent: boolean }> = [];
        const driver = harness.makeDriver() as unknown as {
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
                aggressiveWaitComparison?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ): GameAction[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        driver.search = (
            _unit,
            _candidates,
            current,
            _seed,
            _t0,
            _productive,
            _fallback,
            _dominant,
            _aggressive,
            targetPressure = false,
            urgent = false,
        ) => {
            flags.push({ targetPressure, urgent });
            return current;
        };

        expect(driver.chooseDecision(unit, "v0.8s", incumbent)).toBe(incumbent);
        expect(driver.chooseDecision(unit, "v0.8", incumbent)).toBe(incumbent);
        expect(driver.chooseDecision(unit, "v0.7", incumbent)).toBe(incumbent);
        expect(flags).toEqual([
            { targetPressure: true, urgent: true },
            { targetPressure: true, urgent: true },
            { targetPressure: false, urgent: false },
        ]);
    });

    it("keeps searched v0.8s candidate kinds aligned with promoted v0.8 before target pressure starts", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s,v0.8",
            SEARCH_MAX_MELEE: "1",
            SEARCH_MAX_SHOTS: "1",
            SEARCH_MAX_THROWS: "1",
        });
        const capture = (version: "v0.8s" | "v0.8"): IEnumeratedCandidate[] => {
            // Seed 204, not 203: adding Trent to the Nature L2 catalog shifted the seeded roster and 203 no
            // longer deals this side a shooter, which is the posture these tests exist to exercise.
            const harness = buildBattle(204, version);
            expect(harness.fightProperties.getCurrentLap()).toBeLessThan(V08_TARGET_PRESSURE_START_LAP);
            const unit = harness.unitsHolder
                .getAllAllies(GREEN_TEAM)
                .find((candidate) => !candidate.isDead() && candidate.isRangeCapable())!;
            expect(unit).toBeDefined();
            unit.refreshPossibleAttackTypes(true);
            harness.setActiveUnitId(unit.getId());
            const incumbent: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
            let captured: IEnumeratedCandidate[] | undefined;
            const driver = harness.makeDriver() as unknown as {
                search(
                    unit: Unit,
                    candidates: IEnumeratedCandidate[],
                    incumbent: GameAction[],
                    seed: number,
                    t0: number,
                ): GameAction[];
                chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
            };
            driver.search = (_unit, candidates, current) => {
                captured = candidates;
                return current;
            };

            expect(driver.chooseDecision(unit, version, incumbent)).toBe(incumbent);
            expect(captured).toBeDefined();
            expect(captured!.filter(({ kind }) => kind === "shot")).toHaveLength(1);
            return captured!;
        };

        const sourceAlias = capture("v0.8s");
        const production = capture("v0.8");
        // A19 promotion intentionally changes v0.8 deployment coordinates. Before target pressure, it must still
        // expose the same bounded action classes as the v0.8s source alias; exact paths/aim cells may differ.
        expect(sourceAlias.map(({ kind }) => kind)).toEqual(production.map(({ kind }) => kind));
    });

    it("keeps the preferred v0.8s target shortlisted but requires a non-worse rollout before lap 9", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            SEARCH_SHORTLIST: "2",
        });
        const harness = buildBattle(923, "v0.8s");
        const unit = harness.activeUnit()!;
        const enemies = harness.unitsHolder
            .getAllAllies(unit.getTeam() === GREEN_TEAM ? RED_TEAM : GREEN_TEAM)
            .filter((enemy) => !enemy.isDead())
            .sort((left, right) => left.getCumulativeHp() - right.getCumulativeHp());
        const easy = enemies[0];
        const hard = enemies[enemies.length - 1];
        const attack = (target: Unit): GameAction[] => [
            { type: "range_attack", attackerId: unit.getId(), targetId: target.getId() },
        ];
        const features = (damage: number) => ({
            moraleDelta: 0,
            luckDelta: 0,
            enemiesNotYetActedFrac: 0,
            alliesNotYetActedFrac: 0,
            lap: 6,
            hourglassSpent: 0 as const,
            spendsRangeShot: 1 as const,
            spendsSpellCharge: 0 as const,
            burnsResurrectionCharge: 0 as const,
            expectedDamage: damage,
            expectedKill: 0 as const,
        });
        const incumbent = attack(easy);
        const hardAttack = attack(hard);
        const candidates: IEnumeratedCandidate[] = [
            {
                kind: "incumbent",
                actions: incumbent,
                targetId: easy.getId(),
                features: features(Math.max(1, easy.getCumulativeHp())),
                shotFeatures: { primaryTargetDamage: Math.max(1, easy.getCumulativeHp()) } as never,
            },
            {
                kind: "spell",
                actions: [{ type: "cast_spell", casterId: unit.getId(), spellName: "support" }],
                features: features(0),
            },
            {
                kind: "shot",
                actions: hardAttack,
                targetId: hard.getId(),
                features: features(1),
                shotFeatures: { primaryTargetDamage: 1 } as never,
            },
        ];
        const calls: Array<{ mode: string; kinds: string[] }> = [];
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ): number[];
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
                aggressiveWaitComparison?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ): GameAction[];
            firstEngineValidProductiveCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                prioritizeDominantFinish?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ): IEnumeratedCandidate | undefined;
        };
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push({ mode, kinds: scored.map(({ kind }) => kind) });
            return scored.map(({ kind }) => (kind === "spell" ? 0.99 : kind === "incumbent" ? 0.9 : 0.01));
        };

        expect(
            driver.search(unit, candidates, incumbent, 123, performance.now(), false, undefined, false, false, true),
        ).toBe(incumbent);
        expect(calls).toEqual([
            { mode: "leaf", kinds: ["incumbent", "spell", "shot"] },
            { mode: "turns", kinds: ["incumbent", "shot"] },
        ]);

        calls.length = 0;
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push({ mode, kinds: scored.map(({ kind }) => kind) });
            return scored.map(({ kind }) => (kind === "spell" ? 0.99 : 0.5));
        };
        expect(
            driver.search(unit, candidates, incumbent, 123, performance.now(), false, undefined, false, false, true),
        ).toBe(hardAttack);

        calls.length = 0;
        expect(driver.firstEngineValidProductiveCandidate(unit, candidates, 123, false, true, true)).toBe(
            candidates[2],
        );
        expect(calls[0]).toEqual({ mode: "leaf", kinds: ["shot"] });
    });

    it("keeps urgent positive-damage spells ahead of movement in scored and bounded fallback paths", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            SEARCH_SHORTLIST: "2",
        });
        const harness = buildBattle(924, "v0.8s", undefined, [
            { faction: "Life", creatureName: "Battle Mage", level: 2, size: 1, amount: 20 },
            { faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 50 },
        ]);
        const unit = harness.unitsHolder
            .getAllAllies(GREEN_TEAM)
            .find((candidate) => candidate.getName() === "Battle Mage")!;
        harness.setActiveUnitId(unit.getId());
        const id = unit.getId();
        const incumbentMove: GameAction[] = [{ type: "move_unit", unitId: id, path: [{ x: 3, y: 4 }] }];
        const challengerMove: GameAction[] = [{ type: "move_unit", unitId: id, path: [{ x: 4, y: 4 }] }];
        const meteorite: GameAction[] = [{ type: "cast_spell", casterId: id, spellName: "Meteorite" }];
        const candidates = [
            { kind: "incumbent", actions: incumbentMove },
            { kind: "move", actions: challengerMove },
            {
                kind: "spell",
                actions: meteorite,
                features: { expectedDamage: 82, expectedKill: 0 },
            },
        ] as unknown as IEnumeratedCandidate[];
        const calls: Array<{ mode: string; kinds: string[] }> = [];
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ): number[];
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
                aggressiveWaitComparison?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ): GameAction[];
            firstEngineValidProductiveCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                prioritizeDominantFinish?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ): IEnumeratedCandidate | undefined;
        };
        driver.scoreCandidates = (_unit, scored, _seed, mode) => {
            calls.push({ mode, kinds: scored.map(({ kind }) => kind) });
            return scored.map(({ kind }) => (kind === "move" ? 0.99 : kind === "spell" ? 0.01 : 0.9));
        };

        expect(
            driver.search(
                unit,
                candidates,
                incumbentMove,
                123,
                performance.now(),
                false,
                undefined,
                false,
                false,
                true,
                true,
            ),
        ).toEqual(meteorite);
        expect(calls).toEqual([
            { mode: "leaf", kinds: ["incumbent", "move", "spell"] },
            { mode: "turns", kinds: ["incumbent", "spell"] },
        ]);

        calls.length = 0;
        expect(driver.firstEngineValidProductiveCandidate(unit, candidates, 123, false, true, true)).toBe(
            candidates[2],
        );
        expect(calls).toEqual([{ mode: "leaf", kinds: ["spell"] }]);

        calls.length = 0;
        const nativeSpellCandidates = [
            { ...candidates[2], kind: "incumbent" },
            candidates[1],
        ] as IEnumeratedCandidate[];
        expect(
            driver.search(
                unit,
                nativeSpellCandidates,
                meteorite,
                123,
                performance.now(),
                false,
                undefined,
                false,
                false,
                true,
                true,
            ),
        ).toEqual(meteorite);
        expect(driver.firstEngineValidProductiveCandidate(unit, nativeSpellCandidates, 123, false, true, true)).toBe(
            nativeSpellCandidates[0],
        );

        const smokeHarness = buildBattle(925, "v0.8s", undefined, [
            { faction: "Chaos", creatureName: "Ash Moth", level: 1, size: 1, amount: 50 },
            { faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 50 },
        ]);
        const smokeCaster = smokeHarness.unitsHolder
            .getAllAllies(GREEN_TEAM)
            .find((candidate) => candidate.getName() === "Ash Moth")!;
        smokeHarness.setActiveUnitId(smokeCaster.getId());
        const smoke: IEnumeratedCandidate = {
            kind: "incumbent",
            actions: [{ type: "cast_spell", casterId: smokeCaster.getId(), spellName: "Smoke" }],
            features: { expectedDamage: 120, expectedKill: 0 },
        } as IEnumeratedCandidate;
        const smokeMove: IEnumeratedCandidate = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: smokeCaster.getId(), path: [{ x: 4, y: 4 }] }],
        } as IEnumeratedCandidate;
        const smokeDriver = smokeHarness.makeDriver() as unknown as typeof driver;
        smokeDriver.scoreCandidates = (_unit, scored, _seed, mode) => {
            return scored.map(({ kind }) => (kind === "incumbent" ? 0.99 : mode === "leaf" ? 0.1 : 0.01));
        };
        expect(
            smokeDriver.search(
                smokeCaster,
                [smoke, smokeMove],
                smoke.actions,
                123,
                performance.now(),
                false,
                undefined,
                false,
                false,
                true,
                true,
            ),
        ).toEqual(smokeMove.actions);
        expect(
            smokeDriver.firstEngineValidProductiveCandidate(smokeCaster, [smoke, smokeMove], 123, false, true, true),
        ).toBe(smokeMove);
    });

    const terminalMountainFixture = (
        actorBase: XY,
        destinationBase: XY,
        lap = V08S_URGENT_FINISH_START_LAP,
    ): { harness: Harness; actor: Unit; incumbent: GameAction[] } => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_SHORTLIST: "2",
            SEARCH_MAX_MOVES: "1",
        });
        const harness = buildBattle(
            927,
            "v0.8s",
            undefined,
            [
                { faction: "Chaos", creatureName: "Abomination", level: 4, size: 2, amount: 1 },
                { faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 1 },
            ],
            false,
            PBTypes.GridVals.BLOCK_CENTER,
        );
        const named = (team: TeamType, name: string): Unit =>
            harness.unitsHolder
                .getAllAllies(team)
                .find((candidate) => !candidate.isDead() && candidate.getName() === name)!;
        const actor = named(GREEN_TEAM, "Abomination");
        const enemy = named(RED_TEAM, "Squire");
        harness.unitsHolder.deleteUnitById(named(GREEN_TEAM, "Squire").getId());
        harness.unitsHolder.deleteUnitById(named(RED_TEAM, "Abomination").getId());
        const relocate = (unit: Unit, base: XY): void => {
            harness.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
            const position = getPositionForCell(
                base,
                harness.grid.getSettings().getMinX(),
                harness.grid.getSettings().getStep(),
                harness.grid.getSettings().getHalfStep(),
            );
            const largeOffset = unit.isSmallSize() ? 0 : harness.grid.getSettings().getHalfStep();
            unit.setPosition(position.x - largeOffset, position.y - largeOffset);
            expect(
                harness.grid.occupyCells(
                    footprint(unit, base),
                    unit.getId(),
                    unit.getTeam(),
                    unit.getAttackRange(),
                    unit.hasAbilityActive("Made of Fire"),
                    unit.hasAbilityActive("Made of Water"),
                ),
            ).toBe(true);
        };
        relocate(actor, actorBase);
        relocate(enemy, { x: 7, y: 7 });
        actor.resetTarget();
        harness.setActiveUnitId(actor.getId());
        while (harness.fightProperties.getCurrentLap() < lap) harness.fightProperties.flipLap();
        return {
            harness,
            actor,
            incumbent: [
                {
                    type: "move_unit",
                    unitId: actor.getId(),
                    path: [{ ...actorBase }, { ...destinationBase }],
                    targetCells: footprint(actor, destinationBase),
                    hasLavaCell: false,
                    hasWaterCell: false,
                },
            ],
        };
    };

    it("orders positive damage and strict footprint-closing movement ahead of a stationary finish mountain", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        const harness = buildBattle(926, "v0.8s");
        const unit = harness.activeUnit()!;
        const enemy = harness.unitsHolder.getAllEnemyUnits(unit.getTeam()).find((candidate) => !candidate.isDead())!;
        const id = unit.getId();
        const damage = {
            kind: "melee",
            actions: [
                { type: "melee_attack", attackerId: id, targetId: enemy.getId(), attackFrom: unit.getBaseCell() },
            ],
            targetId: enemy.getId(),
            features: { expectedDamage: 10, expectedKill: 0 },
        } as IEnumeratedCandidate;
        const advance = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: id, path: [{ x: 4, y: 4 }] }],
        } as IEnumeratedCandidate;
        const closingMove = {
            kind: "move",
            actions: [
                {
                    type: "move_unit",
                    unitId: id,
                    path: [{ ...enemy.getBaseCell() }],
                    targetCells: enemy.getCells().map((cell) => ({ ...cell })),
                },
            ],
        } as IEnumeratedCandidate;
        const mountain = {
            kind: "mine",
            actions: [
                {
                    type: "obstacle_attack",
                    attackerId: id,
                    targetPosition: { x: 0, y: 0 },
                    attackFrom: unit.getBaseCell(),
                },
            ],
        } as IEnumeratedCandidate;
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ): number[];
            firstEngineValidLateStationaryMountainCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                stationaryMountain: IEnumeratedCandidate,
                seed: number,
            ): IEnumeratedCandidate | undefined;
        };
        const probes: string[] = [];
        let damageScore = 0.5;
        let closingScore = 0.5;
        driver.scoreCandidates = (_unit, candidates) =>
            candidates.map((candidate) => {
                probes.push(candidate.kind);
                return candidate === damage
                    ? damageScore
                    : candidate === closingMove
                      ? closingScore
                      : candidate === mountain
                        ? 0.5
                        : -Infinity;
            });

        expect(
            driver.firstEngineValidLateStationaryMountainCandidate(unit, [advance, closingMove, damage], mountain, 123),
        ).toBeUndefined();
        expect(probes).toEqual(["melee"]);

        probes.length = 0;
        damageScore = -Infinity;
        expect(
            driver.firstEngineValidLateStationaryMountainCandidate(unit, [advance, closingMove, damage], mountain, 123),
        ).toBe(closingMove);
        expect(probes).toEqual(["melee", "move"]);

        probes.length = 0;
        closingScore = -Infinity;
        expect(
            driver.firstEngineValidLateStationaryMountainCandidate(unit, [advance, closingMove, damage], mountain, 123),
        ).toBe(mountain);
        expect(probes).toEqual(["melee", "move", "mine"]);

        probes.length = 0;
        driver.scoreCandidates = (_unit, candidates) =>
            candidates.map((candidate) => {
                probes.push(candidate.kind);
                return -Infinity;
            });
        expect(
            driver.firstEngineValidLateStationaryMountainCandidate(unit, [advance, damage], mountain, 123),
        ).toBeUndefined();
        expect(probes).toEqual(["melee", "mine"]);
    });

    it("uses the same prevalidated stationary finish hit after the search circuit opens", () => {
        const { harness, actor, incumbent } = terminalMountainFixture({ x: 5, y: 10 }, { x: 5, y: 10 });
        expect(
            (incumbent[0]?.type === "move_unit" ? (incumbent[0].targetCells ?? []) : [])
                .map(cellKey)
                .sort((left, right) => left - right),
        ).toEqual(
            actor
                .getCells()
                .map(cellKey)
                .sort((left, right) => left - right),
        );
        const mountain = enumerateCandidates(
            actor,
            {
                grid: harness.grid,
                matrix: harness.grid.getMatrix(),
                unitsHolder: harness.unitsHolder,
                pathHelper: harness.pathHelper,
                attackHandler: harness.attackHandler,
                fightProperties: harness.fightProperties,
            },
            incumbent,
            { includeMountainAttacks: true },
        ).candidates.find((candidate) => candidate.kind === "mine");
        expect(mountain).toBeDefined();
        expect(mountain?.actions[0]).toMatchObject({
            type: "obstacle_attack",
            attackFrom: actor.getBaseCell(),
        });
        expect(mountain?.actions[0]?.type === "obstacle_attack" ? mountain.actions[0].path : undefined).toBeUndefined();
        const driver = harness.makeDriver() as unknown as {
            circuitOpen: boolean;
            appliesTo(version: string): boolean;
            firstEngineValidLateStationaryMountainCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                stationaryMountain: IEnumeratedCandidate,
                seed: number,
            ): IEnumeratedCandidate | undefined;
            search(): never;
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        expect(harness.fightProperties.getCurrentLap()).toBe(V08S_URGENT_FINISH_START_LAP);
        expect(driver.appliesTo("v0.8s")).toBe(true);
        driver.circuitOpen = true;
        let invoked = false;
        let expandedCandidates: readonly IEnumeratedCandidate[] = [];
        driver.firstEngineValidLateStationaryMountainCandidate = (_unit, candidates, stationaryMountain) => {
            invoked = true;
            expandedCandidates = candidates;
            return stationaryMountain;
        };
        driver.search = () => {
            throw new Error("stationary finish mountain reached horizon search");
        };

        const selected = driver.chooseDecision(actor, "v0.8s", incumbent);
        expect(invoked).toBe(true);
        const expandedMoves = expandedCandidates.filter((candidate) => candidate.kind === "move");
        expect(expandedMoves.length).toBeGreaterThan(1);
        const enemyCells = harness.unitsHolder
            .getAllEnemyUnits(actor.getTeam())
            .filter((enemy) => !enemy.isDead())
            .flatMap((enemy) => enemy.getCells());
        const distance = (cells: readonly XY[]): number =>
            Math.min(
                ...cells.flatMap((cell) =>
                    enemyCells.map((enemy) => Math.max(Math.abs(cell.x - enemy.x), Math.abs(cell.y - enemy.y))),
                ),
            );
        expect(
            expandedMoves.some((candidate) => {
                const move = candidate.actions.at(-1);
                return (
                    move?.type === "move_unit" &&
                    !!move.targetCells?.length &&
                    distance(move.targetCells) < distance(actor.getCells())
                );
            }),
        ).toBe(true);
        expect(selected[0]?.type).toBe("obstacle_attack");
        expect(selected).toHaveLength(1);
        expect(selected[0]).toMatchObject({
            type: "obstacle_attack",
            attackerId: actor.getId(),
            attackFrom: actor.getBaseCell(),
        });
        expect(selected[0]?.type === "obstacle_attack" ? selected[0].path : undefined).toBeUndefined();
        const hitsBefore = harness.fightProperties.getObstacleHitsLeft();
        expect(harness.engine.apply(selected[0]!).completed).toBe(true);
        expect(harness.fightProperties.getObstacleHitsLeft()).toBeLessThan(hitsBefore);
    });

    it("does not promote move-to-mountain mining and preserves unrelated dominant-window fallthrough", () => {
        const assertFallsThrough = (actorBase: XY, lap: number, expectMoveMountain: boolean): void => {
            const { harness, actor, incumbent } = terminalMountainFixture(actorBase, { x: 2, y: 12 }, lap);
            const mountain = enumerateCandidates(
                actor,
                {
                    grid: harness.grid,
                    matrix: harness.grid.getMatrix(),
                    unitsHolder: harness.unitsHolder,
                    pathHelper: harness.pathHelper,
                    attackHandler: harness.attackHandler,
                    fightProperties: harness.fightProperties,
                },
                incumbent,
                { includeMountainAttacks: true },
            ).candidates.find((candidate) => candidate.kind === "mine");
            expect(mountain).toBeDefined();
            const obstacle = mountain?.actions.find((action) => action.type === "obstacle_attack");
            expect(!!obstacle?.path?.length).toBe(expectMoveMountain);
            const driver = harness.makeDriver() as unknown as {
                search(unit: Unit, candidates: IEnumeratedCandidate[], incumbent: GameAction[]): GameAction[];
                chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
            };
            let searched = false;
            driver.search = (_unit, _candidates, current) => {
                searched = true;
                return current;
            };
            expect(driver.chooseDecision(actor, "v0.8s", incumbent)).toBe(incumbent);
            expect(searched).toBe(true);
        };

        // From here the generated mountain candidate needs a route, so it cannot enter the stationary fast path.
        assertFallsThrough({ x: 3, y: 12 }, V08S_URGENT_FINISH_START_LAP, true);
        // This adjacent control does not satisfy the solo-melee retreat guard's complete runtime state.
        assertFallsThrough({ x: 5, y: 10 }, V08S_URGENT_FINISH_START_LAP - 1, false);
    });

    it("pins BLOCK_CENTER game 4139: a blocked Squire clears the final rock instead of retreating and returning", () => {
        const record = runV08BlockCenterActionPanelGame(
            {
                candidateVersion: "v0.8",
                opponentVersion: "v0.7",
                games: 5_000,
                baseSeed: 2_607_280_041,
                sourceDirty: true,
            },
            4_139,
        );

        expect(record).toMatchObject({
            game: 4_139,
            pair: 2_069,
            seed: 1_371_697_966,
            candidateSide: "red",
            endReason: "elimination",
        });
        expect(record.candidateRoster).toContain("Squire");
        expect(record.byCreature.Squire).toMatchObject({
            abaOscillations: 0,
            urgentMountainTerminalJitter: 0,
            strategyRejectedActions: 0,
            recoveryTurns: 0,
        });
        expect(
            record.failureSamples.some(
                (sample) =>
                    sample.creatureName === "Squire" &&
                    sample.lap === V08S_URGENT_FINISH_START_LAP - 1 &&
                    sample.issue === "non_progress_move",
            ),
        ).toBe(false);
    });

    // The role-aware draft/support policy now ends former seed 6678 before the late window, so it no longer
    // proves its named condition. Forced-target release is covered deterministically by the explicit
    // dead-target engine fixture in v0_8_block_center_action_panel.test.ts instead of pinning a whole battle.

    it("scopes the dominant-finish window to v0.8 while leaving v0.7 search unchanged", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s,v0.7", SEARCH_INCLUDE_MOVES: "1" });
        const harness = buildBattle(93, "v0.8s");
        const unit = harness.activeUnit()!;
        const enemyTeam = unit.getTeam() === GREEN_TEAM ? RED_TEAM : GREEN_TEAM;
        for (const enemy of harness.unitsHolder.getAllAllies(enemyTeam)) {
            enemy.applyDamage(Math.floor(enemy.getCumulativeHp() * 0.75), 0, new SceneLogMock());
        }
        while (harness.fightProperties.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP) {
            harness.fightProperties.flipLap();
        }

        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];
        const flags: boolean[] = [];
        const driver = harness.makeDriver() as unknown as {
            counters: { dominantFinishTurns: number };
            search: (
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seed: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
            ) => GameAction[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        driver.search = (_unit, _candidates, current, _seed, _t0, _productive, _fallback, dominant = false) => {
            flags.push(dominant);
            return current;
        };

        expect(driver.chooseDecision(unit, "v0.8s", incumbent)).toBe(incumbent);
        expect(driver.chooseDecision(unit, "v0.7", incumbent)).toBe(incumbent);
        expect(flags).toEqual([true, false]);
        expect(driver.counters.dominantFinishTurns).toBe(1);
    });

    it("orders direct combat first for dominant-finish deadline and circuit fallbacks", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        const harness = buildBattle(94, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const incumbent = {
            kind: "incumbent",
            actions: [{ type: "move_unit", unitId: id, path: [{ x: 3, y: 4 }] }],
        } as unknown as IEnumeratedCandidate;
        const attack = {
            kind: "shot",
            actions: [{ type: "range_attack", attackerId: id, targetId: "enemy" }],
            features: { expectedDamage: 10, expectedKill: 0 },
        } as unknown as IEnumeratedCandidate;
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ) => number[];
            firstEngineValidProductiveCandidate: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                prioritizeDominantFinish?: boolean,
            ) => IEnumeratedCandidate | undefined;
        };
        const probed: string[] = [];
        driver.scoreCandidates = (_unit, [candidate]) => {
            probed.push(candidate.kind);
            return [0.5];
        };

        expect(driver.firstEngineValidProductiveCandidate(unit, [incumbent, attack], 123, true)).toBe(attack);
        expect(probed).toEqual(["shot"]);

        probed.length = 0;
        expect(driver.firstEngineValidProductiveCandidate(unit, [incumbent, attack], 123, false)).toBe(incumbent);
        expect(probed).toEqual(["move"]);

        const support = {
            kind: "spell",
            actions: [{ type: "cast_spell", casterId: id, spellName: "support" }],
        } as unknown as IEnumeratedCandidate;
        probed.length = 0;
        expect(driver.firstEngineValidProductiveCandidate(unit, [support, incumbent], 123, true)).toBe(incumbent);
        expect(probed).toEqual(["move"]);
    });

    it("skips a move-then-mountain incumbent in productive deadline and circuit fallbacks", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        const harness = buildBattle(95, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const moveThenMine = {
            kind: "incumbent",
            actions: [
                { type: "move_unit", unitId: id, path: [{ x: 3, y: 4 }] },
                { type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } },
            ],
        } as unknown as IEnumeratedCandidate;
        const move = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: id, path: [{ x: 4, y: 4 }] }],
        } as unknown as IEnumeratedCandidate;
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ) => number[];
            firstEngineValidProductiveCandidate: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
            ) => IEnumeratedCandidate | undefined;
        };
        const probed: string[] = [];
        driver.scoreCandidates = (_unit, [candidate]) => {
            probed.push(candidate.kind);
            return [0.5];
        };

        expect(driver.firstEngineValidProductiveCandidate(unit, [moveThenMine, move], 123)).toBe(move);
        expect(probed).toEqual(["move"]);
    });

    it("skips net-zero or harmful direct attacks in urgent deadline and circuit fallbacks", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        const harness = buildBattle(951, "v0.8s");
        const unit = harness.activeUnit()!;
        const enemy = harness.unitsHolder
            .getAllAllies(unit.getTeam() === GREEN_TEAM ? RED_TEAM : GREEN_TEAM)
            .find((candidate) => !candidate.isDead())!;
        const harmful = {
            kind: "shot",
            actions: [{ type: "range_attack", attackerId: unit.getId(), targetId: enemy.getId() }],
            features: { expectedDamage: -10, expectedKill: 1 },
        } as unknown as IEnumeratedCandidate;
        const move = {
            kind: "move",
            actions: [{ type: "move_unit", unitId: unit.getId(), path: [{ x: 4, y: 4 }] }],
        } as unknown as IEnumeratedCandidate;
        const driver = harness.makeDriver() as unknown as {
            scoreCandidates: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                mode: string,
            ) => number[];
            firstEngineValidProductiveCandidate: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                prioritizeDominantFinish?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ) => IEnumeratedCandidate | undefined;
        };
        const probed: string[] = [];
        driver.scoreCandidates = (_unit, [candidate]) => {
            probed.push(candidate.kind);
            return [0.5];
        };

        expect(driver.firstEngineValidProductiveCandidate(unit, [harmful, move], 123, false, true, true)).toBe(move);
        expect(probed).toEqual(["move"]);
    });

    it("repairs forced passives with a legal spell but never treats harmful combat as progress", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            SEARCH_SHORTLIST: "2",
        });
        const harness = buildBattle(952, "v0.8s");
        const unit = harness.activeUnit()!;
        const id = unit.getId();
        const defend: GameAction[] = [{ type: "defend_turn", unitId: id }];
        const spell: GameAction[] = [{ type: "cast_spell", casterId: id, spellName: "support" }];
        const harmful: GameAction[] = [{ type: "range_attack", attackerId: id, targetId: "enemy" }];
        const candidates = [
            { kind: "incumbent", actions: defend },
            { kind: "shot", actions: harmful, features: { expectedDamage: -10, expectedKill: 1 } },
            { kind: "spell", actions: spell },
        ] as unknown as IEnumeratedCandidate[];
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
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
                aggressiveWaitComparison?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
            ) => GameAction[];
            firstEngineValidProductiveCandidate: (
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seed: number,
                prioritizeDominantFinish?: boolean,
                prioritizeV08STargetPressure?: boolean,
                prioritizeV08SUrgency?: boolean,
                prioritizeProductiveActions?: boolean,
            ) => IEnumeratedCandidate | undefined;
        };
        driver.scoreCandidates = (_unit, scored) =>
            scored.map(({ kind }) => (kind === "shot" ? 1 : kind === "incumbent" ? 0.9 : 0.1));

        // Urgent, ordinary hard-passive, and dominant force tiers all retain the low-scored legal spell in the
        // shortlist and choose it over both a higher-scored harmful shot and the passive incumbent.
        expect(
            driver.search(unit, candidates, defend, 123, performance.now(), true, undefined, false, false, true, true),
        ).toEqual(spell);
        expect(
            driver.search(
                unit,
                candidates,
                defend,
                123,
                performance.now(),
                true,
                undefined,
                false,
                false,
                false,
                false,
            ),
        ).toEqual(spell);
        expect(
            driver.search(
                unit,
                candidates,
                defend,
                123,
                performance.now(),
                false,
                undefined,
                true,
                false,
                false,
                false,
            ),
        ).toEqual(spell);

        // An ordinary urgent incumbent is unchanged, and a hard passive remains preferable to self-harm when
        // the harmful attack is the only superficially productive challenger.
        expect(
            driver.search(unit, candidates, defend, 123, performance.now(), false, undefined, false, false, true, true),
        ).toEqual(defend);
        expect(
            driver.search(
                unit,
                candidates.slice(0, 2),
                defend,
                123,
                performance.now(),
                true,
                undefined,
                false,
                false,
                true,
                true,
            ),
        ).toEqual(defend);
        expect(driver.firstEngineValidProductiveCandidate(unit, candidates, 123, false, true, true, true)).toBe(
            candidates[2],
        );
        expect(
            driver.firstEngineValidProductiveCandidate(unit, candidates.slice(0, 2), 123, false, true, true, true),
        ).toBeUndefined();
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

    it("keeps move-shots default-off, bounds the probe, and scopes it to explicit version seats", () => {
        const configured = (
            seed: number,
        ): {
            max: number;
            capFor: (version: string) => number;
            provenance: { maxMoveShotComposites: number; moveShotVersions: string[] };
        } => {
            const driver = buildBattle(seed, "v0.8s").makeDriver() as unknown as {
                maxMoveShotComposites: number;
                moveShotCapForVersion: (version: string) => number;
                ilConfig: () => { maxMoveShotComposites: number; moveShotVersions: string[] };
            };
            return {
                max: driver.maxMoveShotComposites,
                capFor: (version) => driver.moveShotCapForVersion(version),
                provenance: driver.ilConfig(),
            };
        };

        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        expect(configured(881).max).toBe(0);
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s,v0.8", SEARCH_MAX_MOVE_SHOTS: "2" });
        const defaultScope = configured(882);
        expect(defaultScope.max).toBe(2);
        expect(defaultScope.capFor("v0.8s")).toBe(2);
        expect(defaultScope.capFor("v0.8")).toBe(2);

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s,v0.8",
            SEARCH_MAX_MOVE_SHOTS: "2",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8",
        });
        const scoped = configured(886);
        expect(scoped.capFor("v0.8")).toBe(2);
        expect(scoped.capFor("v0.8s")).toBe(0);
        expect(scoped.provenance).toMatchObject({
            maxMoveShotComposites: 2,
            moveShotVersions: ["v0.8"],
        });

        const auditPath = join(mkdtempSync(join(tmpdir(), "search-move-shot-scope-")), "audit.jsonl");
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s,v0.8",
            SEARCH_MAX_MOVE_SHOTS: "2",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8",
            SEARCH_AUDIT: auditPath,
        });
        const auditDriver = buildBattle(888, "v0.8s").makeDriver();
        auditDriver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(auditPath, "utf8"))).toMatchObject({
            maxMoveShotComposites: 2,
            moveShotVersions: ["v0.8"],
        });

        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s", SEARCH_MAX_MOVE_SHOTS: "3" });
        expect(() => configured(883)).toThrow("SEARCH_MAX_MOVE_SHOTS must be an integer between 0 and 2");
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s", SEARCH_MAX_MOVE_SHOTS: "1.5" });
        expect(() => configured(884)).toThrow("SEARCH_MAX_MOVE_SHOTS must be an integer between 0 and 2");
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s,v0.8",
            SEARCH_MAX_MOVE_SHOTS: "1",
            SEARCH_MOVE_SHOT_VERSIONS: "v0.8,v0.8",
        });
        expect(() => configured(887)).toThrow(
            "SEARCH_MOVE_SHOT_VERSIONS must be a comma-separated list of unique versions",
        );

        setEnv({ SEARCH_MAX_MOVE_SHOTS: "invalid", SEARCH_MOVE_SHOT_VERSIONS: "," });
        expect(buildBattle(885, "v0.8s").makeDriver().enabled).toBe(false);
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

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_WAIT_DEADLINE_POLICY: "unbounded",
        });
        expect(() => buildBattle(85, "v0.8").makeDriver()).toThrow(
            "SEARCH_WAIT_DEADLINE_POLICY must be profile or operation_bounded",
        );

        setEnv({ SEARCH_DECISION_DEADLINE_MS: "invalid", SEARCH_WAIT_DEADLINE_POLICY: "invalid" });
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

    it("scores completed rollout battles by their exact result instead of the approximate leaf", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8", SEARCH_A19_EXACT_TERMINAL_RESULTS: "1" });
        const harness = buildBattle(8101, "v0.8");
        const driver = harness.makeDriver();
        const actingTeam = harness.activeUnit()!.getTeam();
        const enemyTeam = actingTeam === PBTypes.TeamVals.LOWER ? PBTypes.TeamVals.UPPER : PBTypes.TeamVals.LOWER;
        const internals = driver as unknown as {
            processEvents(events: GameEvent[]): void;
            leafValue(team: TeamType): number;
        };

        internals.processEvents([{ type: "fight_finished", winningTeam: actingTeam }]);
        expect(internals.leafValue(actingTeam)).toBe(1);
        expect(internals.leafValue(enemyTeam)).toBe(0);

        internals.processEvents([{ type: "fight_finished", winningTeam: PBTypes.TeamVals.NO_TEAM }]);
        expect(internals.leafValue(actingTeam)).toBe(0.5);
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

    const pureRangedTerminalRoster = (arbalesterAmount: number): readonly IArmyUnitSpec[] => [
        { faction: "Life", creatureName: "Tsar Cannon", level: 4, size: 2, amount: 2 },
        { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: arbalesterAmount },
    ];
    const pureRangedTerminalEnvironment = {
        V07_SEARCH: "1",
        SEARCH_VERSIONS: "v0.8,v0.8s",
        SEARCH_GATE: "1000",
        SEARCH_HORIZON: "1",
        SEARCH_ROLLOUTS: "1",
        SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "1",
        SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: "v0.8",
    } as const;

    it("keeps the pure-ranged terminal-pressure decision identical while default-off", () => {
        setEnv({
            ...pureRangedTerminalEnvironment,
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: undefined,
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: undefined,
        });
        const h = buildBattle(10_301, "v0.8", undefined, pureRangedTerminalRoster(100));
        const unit = h.activeUnit()!;
        expect(unit.getName()).toBe("Tsar Cannon");
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver();
        driver.onFightReady();
        expect(driver.chooseDecision(unit, "v0.8", incumbent)).toBe(incumbent);
    });

    it("pressures a live Tsar Cannon from lap one without waiting, defending, or mining", () => {
        setEnv({ ...pureRangedTerminalEnvironment });
        const h = buildBattle(10_302, "v0.8", undefined, pureRangedTerminalRoster(100));
        const unit = h.activeUnit()!;
        expect(unit.getName()).toBe("Tsar Cannon");
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver();
        driver.onFightReady();
        const chosen = driver.chooseDecision(unit, "v0.8", incumbent);
        const shot = chosen.find((action) => action.type === "range_attack");
        expect(shot?.type).toBe("range_attack");
        expect(h.unitsHolder.getAllUnits().get(shot!.targetId)?.getName()).toBe("Tsar Cannon");
        expect(chosen.some((action) => action.type === "wait_turn")).toBe(false);
        expect(chosen.some((action) => action.type === "defend_turn")).toBe(false);
        expect(chosen.some((action) => action.type === "obstacle_attack")).toBe(false);
        expect(h.fightProperties.getCurrentLap()).toBeLessThan(V08_TARGET_PRESSURE_START_LAP);
    });

    it("keeps an immediate ranged kill ahead of Tsar terminal-barrier pressure", () => {
        setEnv({ ...pureRangedTerminalEnvironment });
        const h = buildBattle(10_303, "v0.8", undefined, pureRangedTerminalRoster(1));
        const unit = h.activeUnit()!;
        expect(unit.getName()).toBe("Tsar Cannon");
        const driver = h.makeDriver();
        driver.onFightReady();
        const chosen = driver.chooseDecision(unit, "v0.8", [{ type: "wait_turn", unitId: unit.getId() }]);
        const shot = chosen.find((action) => action.type === "range_attack");
        expect(shot?.type).toBe("range_attack");
        expect(h.unitsHolder.getAllUnits().get(shot!.targetId)?.getName()).toBe("Arbalester");
    });

    it("leaves ordinary ranged shooters on the baseline policy", () => {
        setEnv({ ...pureRangedTerminalEnvironment });
        const h = buildBattle(10_306, "v0.8", undefined, pureRangedTerminalRoster(100));
        const unit = [...h.unitsHolder.getAllUnits().values()].find(
            (candidate) => candidate.getTeam() === GREEN_TEAM && candidate.getName() === "Arbalester",
        )!;
        h.setActiveUnitId(unit.getId());
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver();
        driver.onFightReady();
        expect(driver.chooseDecision(unit, "v0.8", incumbent)).toBe(incumbent);
    });

    it("preserves the incumbent on a mixed original board", () => {
        setEnv({ ...pureRangedTerminalEnvironment });
        const mixedRoster: readonly IArmyUnitSpec[] = [
            { faction: "Life", creatureName: "Tsar Cannon", level: 4, size: 2, amount: 2 },
            { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 },
        ];
        const h = buildBattle(10_304, "v0.8", undefined, mixedRoster);
        const unit = h.activeUnit()!;
        expect(unit.getName()).toBe("Tsar Cannon");
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver();
        driver.onFightReady();
        expect(driver.chooseDecision(unit, "v0.8", incumbent)).toBe(incumbent);
    });

    it("scopes pure-ranged terminal pressure to the configured candidate version", () => {
        setEnv({ ...pureRangedTerminalEnvironment });
        const h = buildBattle(10_305, "v0.8", undefined, pureRangedTerminalRoster(100));
        const unit = h.activeUnit()!;
        const driver = h.makeDriver();
        driver.onFightReady();
        const controlIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        expect(driver.chooseDecision(unit, "v0.8s", controlIncumbent)).toBe(controlIncumbent);
        const candidateIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const candidate = driver.chooseDecision(unit, "v0.8", candidateIncumbent);
        expect(candidate).not.toBe(candidateIncumbent);
        expect(candidate.some((action) => action.type === "range_attack")).toBe(true);
    });

    const pureRangedDeadlineRoster = (): readonly IArmyUnitSpec[] =>
        buildMirrorRoster("pure_ranged", 10_307, "expBudget");
    const pureRangedDeadlineEnvironment = {
        V07_SEARCH: "1",
        SEARCH_VERSIONS: "v0.8,v0.8s",
        SEARCH_GATE: "1000",
        SEARCH_HORIZON: "1",
        SEARCH_ROLLOUTS: "1",
        SEARCH_PURE_RANGED_DEADLINE_FINISHER: "1",
        SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS: "v0.8",
    } as const;

    const greenUnitNamed = (h: Harness, name: string): Unit =>
        [...h.unitsHolder.getAllUnits().values()].find(
            (candidate) => candidate.getTeam() === GREEN_TEAM && candidate.getName() === name,
        )!;

    it("preserves Medusa's opening target while terminal-finisher slack remains", () => {
        setEnv({ ...pureRangedDeadlineEnvironment });
        const openingRoster = pureRangedDeadlineRoster().map((spec) =>
            spec.creatureName === "Tsar Cannon" ? { ...spec, amount: 1 } : spec,
        );
        const h = buildBattle(8_222_701, "v0.8", undefined, openingRoster);
        const unit = greenUnitNamed(h, "Medusa");
        h.setActiveUnitId(unit.getId());
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver();
        driver.onFightReady();
        expect(h.fightProperties.getCurrentLap()).toBe(1);
        expect(driver.chooseDecision(unit, "v0.8", incumbent)).toBe(incumbent);
    });

    it("redirects only Endless Quiver at the last feasible No Melee boundary", () => {
        setEnv({ ...pureRangedDeadlineEnvironment });
        const h = buildBattle(8_222_701, "v0.8", undefined, pureRangedDeadlineRoster());
        const medusa = greenUnitNamed(h, "Medusa");
        // Re-calibrated 34 -> 18 when ranged falloff bands became squares of whole cells: every shot in
        // this seeded line gained a band, so the barrier stops needing every remaining activation at a
        // much smaller stack. 18 is the largest stack that still sits on the boundary (19 has slack).
        medusa.setAmountAlive(18);
        h.setActiveUnitId(medusa.getId());
        const driver = h.makeDriver();
        driver.onFightReady();
        const medusaIncumbent: GameAction[] = [{ type: "wait_turn", unitId: medusa.getId() }];
        const chosen = driver.chooseDecision(medusa, "v0.8", medusaIncumbent);
        const shot = chosen.find((action) => action.type === "range_attack");
        expect(shot?.type).toBe("range_attack");
        expect(h.unitsHolder.getAllUnits().get(shot!.targetId)?.getName()).toBe("Tsar Cannon");

        const tsar = greenUnitNamed(h, "Tsar Cannon");
        h.setActiveUnitId(tsar.getId());
        const tsarIncumbent: GameAction[] = [{ type: "wait_turn", unitId: tsar.getId() }];
        expect(driver.chooseDecision(tsar, "v0.8", tsarIncumbent)).toBe(tsarIncumbent);
    });

    it("rejects an already-hopeless No Melee completion schedule", () => {
        setEnv({ ...pureRangedDeadlineEnvironment });
        const h = buildBattle(8_222_701, "v0.8", undefined, pureRangedDeadlineRoster());
        const medusa = greenUnitNamed(h, "Medusa");
        medusa.setAmountAlive(1);
        h.setActiveUnitId(medusa.getId());
        const driver = h.makeDriver();
        driver.onFightReady();
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: medusa.getId() }];
        expect(driver.chooseDecision(medusa, "v0.8", incumbent)).toBe(incumbent);
    });

    it("preserves an incumbent immediate kill at the feasible No Melee boundary", () => {
        setEnv({ ...pureRangedDeadlineEnvironment });
        const h = buildBattle(8_222_701, "v0.8", undefined, pureRangedDeadlineRoster());
        const medusa = greenUnitNamed(h, "Medusa");
        medusa.setAmountAlive(32);
        h.setActiveUnitId(medusa.getId());
        const incumbent = h.decideActive();
        const shot = incumbent.find((action) => action.type === "range_attack");
        expect(shot?.type).toBe("range_attack");
        const target = h.unitsHolder.getAllUnits().get(shot!.targetId)!;
        expect(target.getName()).not.toBe("Tsar Cannon");
        target.applyDamage(target.getCumulativeHp() - 1, 0, new SceneLogMock(), false);

        const driver = h.makeDriver();
        driver.onFightReady();
        expect(driver.chooseDecision(medusa, "v0.8", incumbent)).toBe(incumbent);
    });

    it("scopes the deadline finisher to the candidate version and rejects the failed pressure combination", () => {
        setEnv({ ...pureRangedDeadlineEnvironment });
        const h = buildBattle(8_222_701, "v0.8", undefined, pureRangedDeadlineRoster());
        const unit = greenUnitNamed(h, "Medusa");
        // Same 34 -> 18 boundary re-calibration as the Endless Quiver redirect above.
        unit.setAmountAlive(18);
        h.setActiveUnitId(unit.getId());
        const driver = h.makeDriver();
        driver.onFightReady();
        const controlIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        expect(driver.chooseDecision(unit, "v0.8s", controlIncumbent)).toBe(controlIncumbent);
        const candidateIncumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        expect(driver.chooseDecision(unit, "v0.8", candidateIncumbent)).not.toBe(candidateIncumbent);

        setEnv({
            ...pureRangedDeadlineEnvironment,
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "1",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: "v0.8",
        });
        expect(() => h.makeDriver()).toThrow("mutually exclusive");
    });

    const pureRangedParetoFocusRoster = (): readonly IArmyUnitSpec[] => [
        { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 20 },
        { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 18 },
    ];
    const pureRangedParetoFocusEnvironment = {
        V07_SEARCH: "1",
        SEARCH_VERSIONS: "v0.8,v0.8s",
        SEARCH_GATE: "1000",
        SEARCH_HORIZON: "1",
        SEARCH_ROLLOUTS: "1",
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "1",
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8",
    } as const;

    const positionParetoFocusFixture = (
        h: Harness,
        noMeleeCell: XY = { x: 9, y: 6 },
    ): { actor: Unit; primary: Unit; noMelee: Unit } => {
        const green = h.unitsHolder.getAllAllies(GREEN_TEAM);
        const red = h.unitsHolder.getAllAllies(RED_TEAM);
        const actor = green[0];
        const primary = red[0];
        const noMelee = red[1];
        actor.grantStolenAbility("Through Shot");
        noMelee.grantStolenAbility("No Melee");
        const moveTo = (unit: Unit, cell: XY): void => {
            h.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
            const position = getPositionForCell(
                cell,
                h.grid.getSettings().getMinX(),
                h.grid.getSettings().getStep(),
                h.grid.getSettings().getHalfStep(),
            );
            unit.setPosition(position.x, position.y);
            h.grid.occupyCell(
                cell,
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        };
        moveTo(actor, { x: 2, y: 7 });
        moveTo(green[1], { x: 2, y: 12 });
        moveTo(primary, { x: 8, y: 7 });
        moveTo(noMelee, noMeleeCell);
        h.setActiveUnitId(actor.getId());
        return { actor, primary, noMelee };
    };

    const plainAim = (actor: Unit, primary: Unit): GameAction[] => [
        {
            type: "range_attack",
            attackerId: actor.getId(),
            targetId: primary.getId(),
            aimCell: { ...primary.getBaseCell() },
            aimSide: 0,
        },
    ];

    const mixedSupportedParetoRoster = (): readonly IArmyUnitSpec[] =>
        buildMirrorRoster("mixed_cyclops_tsar", 10_319, "expBudget");

    const positionMixedSupportedParetoFixture = (h: Harness): { actor: Unit; primary: Unit; noMelee: Unit } => {
        const named = (team: TeamType, name: string): Unit =>
            [...h.unitsHolder.getAllUnits().values()].find(
                (candidate) => candidate.getTeam() === team && candidate.getName() === name,
            )!;
        const placements: Array<readonly [Unit, XY]> = [
            [named(GREEN_TEAM, "Cyclops"), { x: 2, y: 7 }],
            [named(GREEN_TEAM, "Squire"), { x: 3, y: 8 }],
            [named(GREEN_TEAM, "Pikeman"), { x: 1, y: 14 }],
            [named(GREEN_TEAM, "Arbalester"), { x: 1, y: 2 }],
            [named(GREEN_TEAM, "Elf"), { x: 1, y: 4 }],
            [named(GREEN_TEAM, "Tsar Cannon"), { x: 3, y: 13 }],
            [named(RED_TEAM, "Squire"), { x: 5, y: 7 }],
            // Keep the intended rear-aim Large Caliber case engine-real: the Squire at (5, 7) is the
            // first impact, while the Tsar's 2x2 footprint begins inside that impact's adjacent splash.
            [named(RED_TEAM, "Tsar Cannon"), { x: 7, y: 7 }],
            [named(RED_TEAM, "Arbalester"), { x: 10, y: 8 }],
            [named(RED_TEAM, "Cyclops"), { x: 10, y: 5 }],
            [named(RED_TEAM, "Pikeman"), { x: 14, y: 13 }],
            [named(RED_TEAM, "Elf"), { x: 14, y: 2 }],
        ];
        for (const [unit] of placements) {
            h.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
        }
        for (const [unit, base] of placements) {
            const position = getPositionForCell(
                base,
                h.grid.getSettings().getMinX(),
                h.grid.getSettings().getStep(),
                h.grid.getSettings().getHalfStep(),
            );
            unit.setPosition(position.x, position.y);
            expect(
                h.grid.occupyCells(
                    footprint(unit, base),
                    unit.getId(),
                    unit.getTeam(),
                    unit.getAttackRange(),
                    unit.hasAbilityActive("Made of Fire"),
                    unit.hasAbilityActive("Made of Water"),
                ),
            ).toBe(true);
        }
        const actor = named(GREEN_TEAM, "Cyclops");
        const primary = named(RED_TEAM, "Squire");
        const noMelee = named(RED_TEAM, "Tsar Cannon");
        h.setActiveUnitId(actor.getId());
        return { actor, primary, noMelee };
    };

    const mixedSupportedParetoEnvironment = {
        ...pureRangedParetoFocusEnvironment,
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "mixed_supported",
        // The selector remains candidate-only even if a hand-written environment includes both version names.
        SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8,v0.8s",
    } as const;
    const uniformMixedSupportedFunnelCounts = (value: number): Record<string, number> =>
        Object.fromEntries(MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES.map((stage) => [stage, value]));

    it("wires the 0.95 floor through SearchDriver while the scoped control remains exact", () => {
        const exactAudit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-exact-floor-")), "search.jsonl");
        setEnv({ ...pureRangedParetoFocusEnvironment, SEARCH_AUDIT: exactAudit });
        const exactHarness = buildBattle(10_315, "v0.8", undefined, pureRangedParetoFocusRoster());
        const exactFixture = positionParetoFocusFixture(exactHarness, { x: 9, y: 10 });
        exactFixture.noMelee.applyDamage(exactFixture.noMelee.getCumulativeHp() - 100, 0, new SceneLogMock(), false);
        const exactDriver = exactHarness.makeDriver();
        exactDriver.onFightReady();
        const exactIncumbent = plainAim(exactFixture.actor, exactFixture.primary);
        expect(exactDriver.chooseDecision(exactFixture.actor, "v0.8", exactIncumbent)).toBe(exactIncumbent);
        exactDriver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(exactAudit, "utf8").trim())).toMatchObject({
            pureRangedParetoNoMeleeFocusDamageFloor: 1,
            pureRangedParetoNoMeleeFocusProposals: 0,
            pureRangedParetoNoMeleeFocusValidOverrides: 0,
        });

        const relaxedAudit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-relaxed-floor-")), "search.jsonl");
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "0.95",
            SEARCH_AUDIT: relaxedAudit,
        });
        const relaxedHarness = buildBattle(10_315, "v0.8", undefined, pureRangedParetoFocusRoster());
        const relaxedFixture = positionParetoFocusFixture(relaxedHarness, { x: 9, y: 10 });
        relaxedFixture.noMelee.applyDamage(
            relaxedFixture.noMelee.getCumulativeHp() - 100,
            0,
            new SceneLogMock(),
            false,
        );
        const relaxedDriver = relaxedHarness.makeDriver();
        relaxedDriver.onFightReady();

        const controlIncumbent = plainAim(relaxedFixture.actor, relaxedFixture.primary);
        expect(relaxedDriver.chooseDecision(relaxedFixture.actor, "v0.8s", controlIncumbent)).toBe(controlIncumbent);
        const candidateIncumbent = plainAim(relaxedFixture.actor, relaxedFixture.primary);
        const chosen = relaxedDriver.chooseDecision(relaxedFixture.actor, "v0.8", candidateIncumbent);
        expect(chosen).not.toBe(candidateIncumbent);
        expect(chosen.find((action) => action.type === "range_attack")?.targetId).toBe(relaxedFixture.noMelee.getId());
        relaxedDriver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(relaxedAudit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            pureRangedParetoNoMeleeFocusDamageFloor: 0.95,
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 1,
            pureRangedParetoNoMeleeFocusStrictProposals: 0,
            pureRangedParetoNoMeleeFocusRelaxedOnlyProposals: 1,
            pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides: 1,
            pureRangedParetoNoMeleeFocusBelowFloorViolations: 0,
        });
        expect(summary.pureRangedParetoNoMeleeFocusMinimumDamageRatio as number).toBeGreaterThanOrEqual(0.95);
        expect(summary.pureRangedParetoNoMeleeFocusMinimumDamageRatio as number).toBeLessThan(1);
    });

    it("takes an engine-valid aggregate-Pareto No-Melee focus only for the scoped v0.8 seat", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-focus-")), "search.jsonl");
        setEnv({ ...pureRangedParetoFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_308, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary, noMelee } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const controlIncumbent = plainAim(actor, primary);
        expect(driver.chooseDecision(actor, "v0.8s", controlIncumbent)).toBe(controlIncumbent);

        const candidateIncumbent = plainAim(actor, primary);
        const chosen = driver.chooseDecision(actor, "v0.8", candidateIncumbent);
        expect(chosen).not.toBe(candidateIncumbent);
        const shot = chosen.find((action) => action.type === "range_attack");
        expect(shot?.type).toBe("range_attack");
        expect(shot?.targetId).toBe(noMelee.getId());

        const postureWait: GameAction[] = [{ type: "wait_turn", unitId: actor.getId() }];
        expect(driver.chooseDecision(actor, "v0.8", postureWait)).toBe(postureWait);
        driver.onMatchEnd("draw", "turn_cap");
        const summary = readFileSync(audit, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .find((row) => row.t === "game")!;
        expect(summary).toMatchObject({
            pureRangedParetoNoMeleeFocus: true,
            pureRangedParetoNoMeleeFocusVersions: ["v0.8"],
            pureRangedParetoNoMeleeFocusDamageFloor: 1,
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 1,
            pureRangedParetoNoMeleeFocusRejectedProbes: 0,
            pureRangedParetoNoMeleeFocusStrictProposals: 1,
            pureRangedParetoNoMeleeFocusRelaxedOnlyProposals: 0,
            pureRangedParetoNoMeleeFocusRelaxedOnlyValidOverrides: 0,
            pureRangedParetoNoMeleeFocusBelowFloorViolations: 0,
            pureRangedParetoNoMeleeFocusProposalsByActorAbility: { through_shot: 1 },
            pureRangedParetoNoMeleeFocusOverridesByActorAbility: { through_shot: 1 },
            pureRangedParetoNoMeleeFocusProposalsByActorName: { Arbalester: 1 },
            pureRangedParetoNoMeleeFocusOverridesByActorName: { Arbalester: 1 },
        });
        expect(summary.pureRangedParetoNoMeleeFocusExpectedDamage as number).toBeGreaterThan(0);
        expect(summary.pureRangedParetoNoMeleeFocusMinimumDamageRatio as number).toBeGreaterThan(1);
        expect(summary).not.toHaveProperty("pureRangedParetoNoMeleeFocusScope");
        expect(summary).not.toHaveProperty("mixedSupportedParetoNoMeleeFocusFunnel");

        expectEngineAcceptsProductiveDecision(h, chosen);
    });

    it("keeps the exact inherited aim while Pareto focus is default-off and rejects pure-arm combinations", () => {
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: undefined,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: undefined,
        });
        const h = buildBattle(10_309, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionParetoFocusFixture(h);
        const incumbent = plainAim(actor, primary);
        const driver = h.makeDriver();
        driver.onFightReady();
        expect(driver.chooseDecision(actor, "v0.8", incumbent)).toBe(incumbent);

        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_DEADLINE_FINISHER: "1",
            SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS: "v0.8",
        });
        expect(() => h.makeDriver()).toThrow("mutually exclusive");
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "1",
            SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS: "v0.8",
        });
        expect(() => h.makeDriver()).toThrow("mutually exclusive");

        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "0.89",
        });
        expect(() => h.makeDriver()).toThrow("must be between 0.9 and 1");

        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "everywhere",
        });
        expect(() => h.makeDriver()).toThrow("must be pure_ranged, any_board, or mixed_supported");

        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "any_board",
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR: "0.95",
        });
        expect(() => h.makeDriver()).toThrow("requires damage floor 1");
    });

    it("selects strict Pareto focus only for production v0.8 on a mixed original board", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-any-board-")), "search.jsonl");
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "any_board",
            // Even an over-broad direct env cannot allow the source alias to select this widened arm.
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: "v0.8,v0.8s",
            SEARCH_AUDIT: audit,
        });
        const mixedRoster: readonly IArmyUnitSpec[] = [
            ...pureRangedParetoFocusRoster(),
            { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 20 },
        ];
        const h = buildBattle(10_317, "v0.8", undefined, mixedRoster);
        const { actor, primary, noMelee } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const controlIncumbent = plainAim(actor, primary);
        expect(driver.chooseDecision(actor, "v0.8s", controlIncumbent)).toBe(controlIncumbent);
        const candidateIncumbent = plainAim(actor, primary);
        const chosen = driver.chooseDecision(actor, "v0.8", candidateIncumbent);
        expect(chosen).not.toBe(candidateIncumbent);
        expect(chosen.find((action) => action.type === "range_attack")?.targetId).toBe(noMelee.getId());

        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            pureRangedParetoNoMeleeFocusScope: "any_board",
            pureRangedParetoNoMeleeFocusDamageFloor: 1,
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 1,
            pureRangedParetoNoMeleeFocusBelowFloorViolations: 0,
        });
        expect(summary).not.toHaveProperty("mixedSupportedParetoNoMeleeFocusFunnel");
        expectEngineAcceptsProductiveDecision(h, chosen);
    });

    it("gives both mixed-board seats the same strict target-covered catalog", () => {
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE: "any_board",
            SEARCH_MAX_SHOTS: "1",
        });
        const mixedRoster: readonly IArmyUnitSpec[] = [
            ...pureRangedParetoFocusRoster(),
            { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 20 },
        ];
        const h = buildBattle(10_318, "v0.8", undefined, mixedRoster);
        const { actor, primary } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();
        const calls = captureCandidates(driver);
        const intercepted = driver as unknown as {
            firstEngineValidCandidate(): IEnumeratedCandidate | undefined;
        };
        intercepted.firstEngineValidCandidate = () => undefined;

        driver.chooseDecision(actor, "v0.8s", plainAim(actor, primary));
        driver.chooseDecision(actor, "v0.8", plainAim(actor, primary));

        expect(calls).toHaveLength(2);
        expect(normalize(calls[1])).toEqual(normalize(calls[0]));
        expect(calls[0].filter((candidate) => candidate.kind === "shot").length).toBeGreaterThan(1);
    });

    it("selects mixed-supported focus only for v0.8 and emits one sparse causal v13 proposal row", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-mixed-supported-")), "search.jsonl");
        setEnv({ ...mixedSupportedParetoEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_319, "v0.8", undefined, mixedSupportedParetoRoster());
        const { actor, primary, noMelee } = positionMixedSupportedParetoFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const controlIncumbent = plainAim(actor, primary);
        expect(driver.chooseDecision(actor, "v0.8s", controlIncumbent)).toBe(controlIncumbent);
        const candidateIncumbent = plainAim(actor, primary);
        const chosen = driver.chooseDecision(actor, "v0.8", candidateIncumbent);
        expect(chosen).not.toBe(candidateIncumbent);
        expect(chosen.find((action) => action.type === "range_attack")?.targetId).toBe(noMelee.getId());

        driver.onMatchEnd("draw", "turn_cap");
        const rows = readFileSync(audit, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const proposalRows = rows.filter((row) => row.t === "pareto_focus");
        expect(proposalRows).toHaveLength(1);
        expect(proposalRows[0]).toMatchObject({
            schema: "hoc.search.pareto_focus.v13",
            t: "pareto_focus",
            seed: 10_319,
            side: "green",
            unitId: actor.getId(),
            decisionOrdinal: 1,
            lap: 1,
            scope: "mixed_supported",
            status: "valid_override",
            actor: { name: "Cyclops", ability: "large_caliber" },
            support: { guardCount: 1, reachableThreats: 1, screenedThreats: 1 },
            incumbent: { targetId: primary.getId(), targetName: "Squire" },
            proposal: { targetId: noMelee.getId(), targetName: "Tsar Cannon" },
        });
        expect(proposalRows[0].proposalCount as number).toBeGreaterThan(0);
        expect((proposalRows[0].proposal as { minimumDamageRatio: number }).minimumDamageRatio).toBeGreaterThanOrEqual(
            1,
        );
        expect(rows.find((row) => row.t === "game")).toMatchObject({
            pureRangedParetoNoMeleeFocusScope: "mixed_supported",
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 1,
            pureRangedParetoNoMeleeFocusBelowFloorViolations: 0,
            mixedSupportedParetoNoMeleeFocusFunnel: {
                countingDomain: "production_v0.8_selector_decisions",
                stages: MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES,
                opportunities: 1,
                cumulative: uniformMixedSupportedFunnelCounts(1),
                failures: uniformMixedSupportedFunnelCounts(0),
            },
        });
        expectEngineAcceptsProductiveDecision(h, chosen);
    });

    it("takes a valid mixed-supported override with close native support and no reachable threats", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-mixed-zero-threat-")), "search.jsonl");
        setEnv({ ...mixedSupportedParetoEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_325, "v0.8", undefined, mixedSupportedParetoRoster());
        const { actor, primary, noMelee } = positionMixedSupportedParetoFixture(h);
        primary.grantStolenAbility("No Melee");
        const driver = h.makeDriver();
        driver.onFightReady();

        const incumbent = plainAim(actor, primary);
        const chosen = driver.chooseDecision(actor, "v0.8", incumbent);
        expect(chosen).not.toBe(incumbent);
        expect(chosen.find((action) => action.type === "range_attack")?.targetId).toBe(noMelee.getId());

        driver.onMatchEnd("draw", "turn_cap");
        const rows = readFileSync(audit, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(rows.find((row) => row.t === "pareto_focus")).toMatchObject({
            schema: "hoc.search.pareto_focus.v13",
            status: "valid_override",
            support: { guardCount: 1, reachableThreats: 0, screenedThreats: 0 },
            incumbent: { targetId: primary.getId() },
            proposal: { targetId: noMelee.getId() },
        });
        expect(rows.find((row) => row.t === "game")).toMatchObject({
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 1,
            mixedSupportedParetoNoMeleeFocusFunnel: {
                opportunities: 1,
                cumulative: uniformMixedSupportedFunnelCounts(1),
                failures: uniformMixedSupportedFunnelCounts(0),
            },
        });
        expectEngineAcceptsProductiveDecision(h, chosen);
    });

    it("telescopes mixed-supported first failures without counting the control seat", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-mixed-funnel-")), "search.jsonl");
        setEnv({ ...mixedSupportedParetoEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_323, "v0.8", undefined, mixedSupportedParetoRoster());
        const { actor, primary, noMelee } = positionMixedSupportedParetoFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const controlIncumbent = plainAim(actor, primary);
        // The control seat may still improve this engine-real splash through ordinary a13 search. The funnel
        // assertion below is the relevant isolation invariant: only production v0.8 selector decisions count.
        driver.chooseDecision(actor, "v0.8s", controlIncumbent);
        const nonShotIncumbent: GameAction[] = [{ type: "wait_turn", unitId: actor.getId() }];
        driver.chooseDecision(actor, "v0.8", nonShotIncumbent);
        const alreadyFocusedIncumbent = plainAim(actor, noMelee);
        driver.chooseDecision(actor, "v0.8", alreadyFocusedIncumbent);

        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as {
            mixedSupportedParetoNoMeleeFocusFunnel: {
                opportunities: number;
                cumulative: Record<string, number>;
                failures: Record<string, number>;
            };
        };
        expect(summary.mixedSupportedParetoNoMeleeFocusFunnel).toEqual({
            countingDomain: "production_v0.8_selector_decisions",
            stages: [...MIXED_SUPPORTED_PARETO_NO_MELEE_FOCUS_FUNNEL_STAGES],
            opportunities: 2,
            cumulative: {
                mixed_board: 2,
                exact_native_actor_identity: 2,
                stationary_lap_candidate_shape: 1,
                original_native_guard_presence: 1,
                original_native_tsar_no_melee_target: 1,
                reachable_threat_assessment: 1,
                all_reachable_threats_screened: 1,
                catalog_expansion: 0,
                exact_pareto_proposal: 0,
                valid_override: 0,
            },
            failures: {
                mixed_board: 0,
                exact_native_actor_identity: 0,
                stationary_lap_candidate_shape: 1,
                original_native_guard_presence: 0,
                original_native_tsar_no_melee_target: 0,
                reachable_threat_assessment: 0,
                all_reachable_threats_screened: 0,
                catalog_expansion: 1,
                exact_pareto_proposal: 0,
                valid_override: 0,
            },
        });
    });

    it("keeps a rear-aim Pareto redirect when its canonical first hit preserves the incumbent kill", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-mixed-no-proposal-")), "search.jsonl");
        setEnv({ ...mixedSupportedParetoEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_324, "v0.8", undefined, mixedSupportedParetoRoster());
        const { actor, primary, noMelee } = positionMixedSupportedParetoFixture(h);
        primary.applyDamage(primary.getCumulativeHp() - 1, 0, new SceneLogMock(), false);
        const driver = h.makeDriver();
        driver.onFightReady();

        const incumbent = plainAim(actor, primary);
        const chosen = driver.chooseDecision(actor, "v0.8", incumbent);
        expect(chosen).not.toBe(incumbent);
        expect(chosen.find((action) => action.type === "range_attack")?.targetId).toBe(noMelee.getId());

        driver.onMatchEnd("draw", "turn_cap");
        const rows = readFileSync(audit, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(rows.find((row) => row.t === "pareto_focus")).toMatchObject({
            status: "valid_override",
            incumbent: {
                targetId: primary.getId(),
                expectedKill: 1,
                primaryTargetDamage: 1,
            },
            proposal: {
                targetId: noMelee.getId(),
                expectedKill: 1,
            },
        });
        const proposal = rows.find((row) => row.t === "pareto_focus")?.proposal as
            { aimTargetDamage?: number; expectedNoMeleeDamage?: number } | undefined;
        expect(proposal?.aimTargetDamage).toBeGreaterThan(0);
        expect(proposal?.expectedNoMeleeDamage).toBe(proposal?.aimTargetDamage);
        expect(rows.find((row) => row.t === "game")).toMatchObject({
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 1,
            mixedSupportedParetoNoMeleeFocusFunnel: {
                opportunities: 1,
                cumulative: {
                    catalog_expansion: 1,
                    exact_pareto_proposal: 1,
                    valid_override: 1,
                },
                failures: {
                    exact_pareto_proposal: 0,
                    valid_override: 0,
                },
            },
        });
    });

    it("gives mixed-supported candidate and control seats identical target-covered catalogs", () => {
        setEnv({ ...mixedSupportedParetoEnvironment, SEARCH_MAX_SHOTS: "1" });
        const h = buildBattle(10_320, "v0.8", undefined, mixedSupportedParetoRoster());
        const { actor, primary } = positionMixedSupportedParetoFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();
        const calls = captureCandidates(driver);
        const intercepted = driver as unknown as {
            firstEngineValidCandidate(): IEnumeratedCandidate | undefined;
        };
        intercepted.firstEngineValidCandidate = () => undefined;

        driver.chooseDecision(actor, "v0.8s", plainAim(actor, primary));
        driver.chooseDecision(actor, "v0.8", plainAim(actor, primary));

        expect(calls).toHaveLength(2);
        expect(normalize(calls[1])).toEqual(normalize(calls[0]));
        expect(calls[0].filter((candidate) => candidate.kind === "shot").length).toBeGreaterThan(1);
    });

    it("audits mixed-supported rejected probes and deadline fallbacks without per-turn audit mode", () => {
        const auditStatus = (
            deadline: boolean,
        ): { proposal: Record<string, unknown>; game: Record<string, unknown> } => {
            const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-mixed-status-")), "search.jsonl");
            setEnv({
                ...mixedSupportedParetoEnvironment,
                SEARCH_AUDIT: audit,
                SEARCH_DECISION_DEADLINE_MS: deadline ? "0.0001" : undefined,
            });
            const h = buildBattle(deadline ? 10_322 : 10_321, "v0.8", undefined, mixedSupportedParetoRoster());
            const { actor, primary } = positionMixedSupportedParetoFixture(h);
            const driver = h.makeDriver();
            driver.onFightReady();
            if (!deadline) {
                const intercepted = driver as unknown as {
                    firstEngineValidCandidate(): IEnumeratedCandidate | undefined;
                };
                intercepted.firstEngineValidCandidate = () => undefined;
            }
            driver.chooseDecision(actor, "v0.8", plainAim(actor, primary));
            driver.onMatchEnd("draw", "turn_cap");
            const rows = readFileSync(audit, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            return {
                proposal: rows.find((row) => row.t === "pareto_focus")!,
                game: rows.find((row) => row.t === "game")!,
            };
        };

        const rejected = auditStatus(false);
        expect(rejected.proposal).toMatchObject({
            schema: "hoc.search.pareto_focus.v13",
            status: "rejected_probe",
            lap: 1,
            support: { guardCount: 1, reachableThreats: 1, screenedThreats: 1 },
        });
        expect(rejected.game).toMatchObject({
            mixedSupportedParetoNoMeleeFocusFunnel: {
                opportunities: 1,
                cumulative: {
                    exact_pareto_proposal: 1,
                    valid_override: 0,
                },
                failures: { valid_override: 1 },
            },
        });

        const deadline = auditStatus(true);
        expect(deadline.proposal).toMatchObject({
            schema: "hoc.search.pareto_focus.v13",
            status: "deadline_fallback",
            lap: 1,
            support: { guardCount: 1, reachableThreats: 1, screenedThreats: 1 },
        });
        expect(deadline.game).toMatchObject({
            mixedSupportedParetoNoMeleeFocusFunnel: {
                opportunities: 1,
                cumulative: {
                    exact_pareto_proposal: 1,
                    valid_override: 0,
                },
                failures: { valid_override: 1 },
            },
        });
    });

    it("does not let Pareto focus bypass an already-open search circuit", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-circuit-")), "search.jsonl");
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_CIRCUIT_BREAKER_MS: "0.0001",
            SEARCH_AUDIT: audit,
        });
        const h = buildBattle(10_310, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const opening = plainAim(actor, primary);
        driver.chooseDecision(actor, "v0.8s", opening);
        for (let lap = 1; lap < 7; lap += 1) h.fightProperties.flipLap();
        for (const enemy of h.unitsHolder.getAllAllies(RED_TEAM)) enemy.setAmountAlive(1);
        const afterCircuit = plainAim(actor, primary);
        driver.chooseDecision(actor, "v0.8", afterCircuit);
        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            circuitOpened: true,
            pureRangedParetoNoMeleeFocusProposals: 0,
            pureRangedParetoNoMeleeFocusValidOverrides: 0,
        });
    });

    it("scores every circuit-open operation-bounded wait and keeps behavior counters observer-invariant", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_CIRCUIT_BREAKER_MS: "0.0001",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVES: "1",
            SEARCH_MAX_MELEE: "2",
            SEARCH_MAX_SHOTS: "2",
            SEARCH_MAX_THROWS: "1",
            SEARCH_ACTIVE_CHALLENGERS: "1",
            SEARCH_WAIT_DEADLINE_POLICY: "operation_bounded",
            V08_AGGRESSIVE: "1",
        });
        const h = buildBattle(10_319, "v0.8");
        const unit = h.activeUnit()!;
        const probes: ISearchPassiveProductiveProbe[] = [];
        const control = h.makeDriver() as unknown as {
            circuitOpen: boolean;
            counters: Record<string, unknown>;
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        const observed = h.makeDriver((probe) => probes.push({ ...probe })) as unknown as {
            circuitOpen: boolean;
            counters: Record<string, unknown>;
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        const behaviorCounters = (counters: Record<string, unknown>): Record<string, unknown> => {
            const behavior = { ...counters };
            delete behavior.msTotal;
            return behavior;
        };
        const opening: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "skip" }];
        control.chooseDecision(unit, "v0.8", opening);
        observed.chooseDecision(unit, "v0.8", opening);
        expect(control.circuitOpen).toBe(true);
        expect(observed.circuitOpen).toBe(true);
        expect(behaviorCounters(observed.counters)).toEqual(behaviorCounters(control.counters));

        control.scoreCandidates = (_unit, candidates) => candidates.map(() => 0.5);
        observed.scoreCandidates = (_unit, candidates) => candidates.map(() => 0.5);
        const passive: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const controlChoice = control.chooseDecision(unit, "v0.8", passive);
        const observedChoice = observed.chooseDecision(unit, "v0.8", passive);
        expect(observedChoice).toEqual(controlChoice);
        expect(controlChoice).not.toBe(passive);
        expect(hasProductiveAction(controlChoice)).toBe(true);
        expect(behaviorCounters(observed.counters)).toEqual(behaviorCounters(control.counters));
        expect(probes).toHaveLength(1);
        expect(probes[0]).toMatchObject({
            unitId: unit.getId(),
            incumbentKind: "wait",
            retainedPassive: false,
            betterShortlistedProductiveAlternative: true,
            evidenceComplete: true,
            circuitOpenAtDecision: true,
            circuitWaitArbitration: true,
            resolution: "scored",
        });

        const secondControlWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const secondObservedWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        expect(control.chooseDecision(unit, "v0.8", secondControlWait)).not.toBe(secondControlWait);
        expect(observed.chooseDecision(unit, "v0.8", secondObservedWait)).not.toBe(secondObservedWait);
        expect(behaviorCounters(observed.counters)).toEqual(behaviorCounters(control.counters));
        expect(control.counters).toMatchObject({ circuitWaitArbitrations: 2, circuitSkipped: 0 });
        expect(observed.counters).toMatchObject({ circuitWaitArbitrations: 2, circuitSkipped: 0 });
        expect(probes).toHaveLength(2);
        expect(probes[1]).toMatchObject({
            unitId: unit.getId(),
            incumbentKind: "wait",
            retainedPassive: false,
            circuitOpenAtDecision: true,
            circuitWaitArbitration: true,
            resolution: "scored",
        });

        const fresh = h.makeDriver() as unknown as {
            circuitOpen: boolean;
            counters: Record<string, unknown>;
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        fresh.chooseDecision(unit, "v0.8", opening);
        expect(fresh.circuitOpen).toBe(true);
        fresh.scoreCandidates = (_unit, candidates) => candidates.map(() => 0.5);
        const freshWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        expect(fresh.chooseDecision(unit, "v0.8", freshWait)).not.toBe(freshWait);
        expect(fresh.counters).toMatchObject({ circuitWaitArbitrations: 1, circuitSkipped: 0 });
    });

    it("freezes passive behavior time before diagnostic aggregation can affect the circuit or later decisions", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_CIRCUIT_BREAKER_MS: "10",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVES: "1",
            SEARCH_MAX_MELEE: "2",
            SEARCH_MAX_SHOTS: "2",
            SEARCH_MAX_THROWS: "1",
            SEARCH_ACTIVE_CHALLENGERS: "1",
            V08_AGGRESSIVE: "1",
        });
        const h = buildBattle(10_320, "v0.8");
        const unit = h.activeUnit()!;
        const probes: ISearchPassiveProductiveProbe[] = [];
        type CapturePassiveProbe = (
            audit: unknown,
            actor: Unit,
            selectedActions: readonly GameAction[],
            resolution: string,
            candidates?: readonly IEnumeratedCandidate[],
            means?: readonly number[],
            productiveFallback?: IEnumeratedCandidate,
        ) => void;
        type TimedDriver = {
            circuitOpen: boolean;
            counters: { msTotal: number };
            scoreCandidates(
                actor: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            capturePassiveProductiveProbe: CapturePassiveProbe;
            chooseDecision(actor: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        const control = h.makeDriver() as unknown as TimedDriver;
        const observed = h.makeDriver((probe) => probes.push({ ...probe })) as unknown as TimedDriver;
        control.scoreCandidates = (_actor, candidates) => candidates.map(() => 0.5);
        observed.scoreCandidates = (_actor, candidates) => candidates.map(() => 0.5);

        let fakeNow = 0;
        const realNow = performance.now;
        Object.defineProperty(performance, "now", { configurable: true, value: () => fakeNow });
        try {
            const originalCapture = observed.capturePassiveProductiveProbe.bind(observed);
            observed.capturePassiveProductiveProbe = (
                audit,
                actor,
                selectedActions,
                resolution,
                candidates = [],
                means = [],
                productiveFallback,
            ): void => {
                const diagnosticCandidates = candidates.map(
                    (candidate) =>
                        new Proxy(candidate, {
                            get(target, property, receiver) {
                                if (property === "kind") fakeNow = 100;
                                return Reflect.get(target, property, receiver);
                            },
                        }),
                );
                originalCapture(
                    audit,
                    actor,
                    selectedActions,
                    resolution,
                    diagnosticCandidates,
                    means,
                    productiveFallback,
                );
            };

            const firstControlWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
            const firstObservedWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
            const firstControl = control.chooseDecision(unit, "v0.8", firstControlWait);
            const firstObserved = observed.chooseDecision(unit, "v0.8", firstObservedWait);
            expect(firstObserved).toEqual(firstControl);
            expect(fakeNow).toBe(100);
            expect(control.circuitOpen).toBe(false);
            expect(observed.circuitOpen).toBe(false);
            expect(observed.counters.msTotal).toBe(control.counters.msTotal);
            expect(probes).toHaveLength(1);
            expect(probes[0].decisionMs).toBe(0);

            const secondControlWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
            const secondObservedWait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
            expect(observed.chooseDecision(unit, "v0.8", secondObservedWait)).toEqual(
                control.chooseDecision(unit, "v0.8", secondControlWait),
            );
            expect(control.circuitOpen).toBe(false);
            expect(observed.circuitOpen).toBe(false);
        } finally {
            Object.defineProperty(performance, "now", { configurable: true, value: realNow });
        }
    });

    it("bounds the Pareto engine probe by the ordinary decision deadline", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-deadline-")), "search.jsonl");
        setEnv({
            ...pureRangedParetoFocusEnvironment,
            SEARCH_DECISION_DEADLINE_MS: "0.0001",
            SEARCH_AUDIT: audit,
        });
        const h = buildBattle(10_311, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const incumbent = plainAim(actor, primary);
        expect(driver.chooseDecision(actor, "v0.8", incumbent)).toBe(incumbent);
        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            searched: 1,
            deadlineFallbacks: 1,
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 0,
            pureRangedParetoNoMeleeFocusRejectedProbes: 0,
        });
    });

    it("keeps ordinary-shooter catalogs exact when Pareto focus is globally enabled", () => {
        const catalog = (enabled: boolean): unknown => {
            setEnv({
                ...pureRangedParetoFocusEnvironment,
                SEARCH_MAX_SHOTS: "1",
                SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: enabled ? "1" : undefined,
                SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS: enabled ? "v0.8" : undefined,
            });
            const h = buildBattle(10_313, "v0.8", undefined, pureRangedParetoFocusRoster());
            const { actor, primary } = positionParetoFocusFixture(h);
            actor.deleteAbility("Through Shot");
            const driver = h.makeDriver();
            driver.onFightReady();
            const calls = captureCandidates(driver);

            expect(driver.chooseDecision(actor, "v0.8", plainAim(actor, primary))).toEqual(plainAim(actor, primary));
            expect(calls).toHaveLength(1);
            return normalize(calls[0]);
        };

        expect(catalog(true)).toEqual(catalog(false));
    });

    it("gives special-actor candidate and control seats the same target-covered catalog", () => {
        setEnv({ ...pureRangedParetoFocusEnvironment, SEARCH_MAX_SHOTS: "1" });
        const h = buildBattle(10_316, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();
        const calls = captureCandidates(driver);
        const intercepted = driver as unknown as {
            firstEngineValidCandidate(): IEnumeratedCandidate | undefined;
        };
        intercepted.firstEngineValidCandidate = () => undefined;

        driver.chooseDecision(actor, "v0.8s", plainAim(actor, primary));
        driver.chooseDecision(actor, "v0.8", plainAim(actor, primary));

        expect(calls).toHaveLength(2);
        expect(normalize(calls[1])).toEqual(normalize(calls[0]));
        expect(calls[0].filter((candidate) => candidate.kind === "shot").length).toBeGreaterThan(1);
    });

    it("continues through ordinary a13 search when the Pareto filter has no proposal", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-no-proposal-")), "search.jsonl");
        setEnv({ ...pureRangedParetoFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_312, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionParetoFocusFixture(h);
        actor.grantStolenAbility("Area Throw");
        const driver = h.makeDriver();
        driver.onFightReady();

        driver.chooseDecision(actor, "v0.8", plainAim(actor, primary));
        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            searched: 1,
            pureRangedParetoNoMeleeFocusProposals: 0,
            pureRangedParetoNoMeleeFocusValidOverrides: 0,
        });
    });

    it("continues ordinary search after every proposed Pareto redirect fails its engine probe", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-pareto-rejected-probe-")), "search.jsonl");
        setEnv({ ...pureRangedParetoFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_314, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionParetoFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();
        const intercepted = driver as unknown as {
            firstEngineValidCandidate(): IEnumeratedCandidate | undefined;
        };
        intercepted.firstEngineValidCandidate = () => undefined;
        const incumbent = plainAim(actor, primary);
        const before = stableSnapshot(h);

        expect(driver.chooseDecision(actor, "v0.8", incumbent)).toBe(incumbent);
        expect(stableSnapshot(h)).toEqual(before);
        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            searched: 1,
            pureRangedParetoNoMeleeFocusProposals: 1,
            pureRangedParetoNoMeleeFocusValidOverrides: 0,
            pureRangedParetoNoMeleeFocusRejectedProbes: 1,
        });
    });

    const pureRangedJitFocusEnvironment = {
        V07_SEARCH: "1",
        SEARCH_VERSIONS: "v0.8,v0.8s",
        SEARCH_GATE: "1000",
        SEARCH_HORIZON: "1",
        SEARCH_ROLLOUTS: "1",
        SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS: "1",
        SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: "v0.8",
    } as const;

    const positionJitFocusFixture = (h: Harness): { actor: Unit; primary: Unit; noMelee: Unit } => {
        const green = h.unitsHolder.getAllAllies(GREEN_TEAM);
        const red = h.unitsHolder.getAllAllies(RED_TEAM);
        const actor = green[0];
        const primary = red[0];
        const noMelee = red[1];
        noMelee.grantStolenAbility("No Melee");
        // Keep the barrier large enough to arm the JIT scheduler from lap one without manufacturing a low-HP kill.
        noMelee.setAmountAlive(100);
        const moveTo = (unit: Unit, cell: XY): void => {
            h.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
            const position = getPositionForCell(
                cell,
                h.grid.getSettings().getMinX(),
                h.grid.getSettings().getStep(),
                h.grid.getSettings().getHalfStep(),
            );
            unit.setPosition(position.x, position.y);
            h.grid.occupyCell(
                cell,
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        };
        moveTo(actor, { x: 2, y: 7 });
        moveTo(green[1], { x: 2, y: 12 });
        moveTo(primary, { x: 8, y: 7 });
        moveTo(noMelee, { x: 9, y: 6 });
        h.setActiveUnitId(actor.getId());
        return { actor, primary, noMelee };
    };

    const jitAim = (actor: Unit, target: Unit): GameAction[] => [
        {
            type: "range_attack",
            attackerId: actor.getId(),
            targetId: target.getId(),
            aimCell: { ...target.getBaseCell() },
            aimSide: 0,
        },
    ];

    it("takes an engine-valid JIT redirect only for the scoped v0.8 seat and audits every invariant", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-jit-focus-")), "search.jsonl");
        setEnv({ ...pureRangedJitFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_401, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary, noMelee } = positionJitFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();

        const candidateIncumbent = jitAim(actor, primary);
        const chosen = driver.chooseDecision(actor, "v0.8", candidateIncumbent);
        expect(chosen).not.toBe(candidateIncumbent);
        expect(chosen.find((action) => action.type === "range_attack")?.targetId).toBe(noMelee.getId());
        driver.onMatchEnd("draw", "turn_cap");
        const summary = JSON.parse(readFileSync(audit, "utf8").trim()) as Record<string, unknown>;
        expect(summary).toMatchObject({
            pureRangedJitNoMeleeFocus: true,
            pureRangedJitNoMeleeFocusVersions: ["v0.8"],
            pureRangedJitNoMeleeFocusStartLap: 1,
            pureRangedJitNoMeleeFocusLastLap: 11,
            pureRangedJitNoMeleeFocusActivationBuffer: 1,
            pureRangedJitNoMeleeFocusDamageFloor: 0.8,
            pureRangedJitNoMeleeFocusProposals: 1,
            pureRangedJitNoMeleeFocusValidOverrides: 1,
            pureRangedJitNoMeleeFocusRejectedProbes: 0,
            pureRangedJitNoMeleeFocusSelections: 1,
            pureRangedJitNoMeleeFocusFiniteAmmoSelections: 1,
            pureRangedJitNoMeleeFocusEndlessQuiverSelections: 0,
            pureRangedJitNoMeleeFocusBelowFloorViolations: 0,
            pureRangedJitNoMeleeFocusExpectedKillRegressionViolations: 0,
            pureRangedJitNoMeleeFocusFriendlyFireRegressionViolations: 0,
            pureRangedJitNoMeleeFocusNonSingleActivationViolations: 0,
            pureRangedJitNoMeleeFocusProposalsByActorName: { Arbalester: 1 },
            pureRangedJitNoMeleeFocusOverridesByActorName: { Arbalester: 1 },
            pureRangedJitNoMeleeFocusOverridesByTargetName: { Arbalester: 1 },
            pureRangedJitNoMeleeFocusOverridesByLap: { "1": 1 },
        });
        expect(summary.pureRangedJitNoMeleeFocusMaximumDeadlineSlack as number).toBeLessThanOrEqual(1);
        expect(summary.pureRangedJitNoMeleeFocusMinimumDamageRatio as number).toBeGreaterThanOrEqual(0.8);

        expectEngineAcceptsProductiveDecision(h, chosen);
    });

    it("engine-probes an armed incumbent lock and returns the exact inherited action reference", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-jit-lock-")), "search.jsonl");
        setEnv({ ...pureRangedJitFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_402, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, noMelee } = positionJitFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();
        const intercepted = driver as unknown as {
            firstEngineValidCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                deadlineAt?: number | null,
            ): IEnumeratedCandidate | undefined;
        };
        const realProbe = intercepted.firstEngineValidCandidate.bind(driver);
        let probes = 0;
        intercepted.firstEngineValidCandidate = (unit, candidates, seedBase, deadlineAt) => {
            probes += 1;
            return realProbe(unit, candidates, seedBase, deadlineAt);
        };
        const incumbent = jitAim(actor, noMelee);
        expect(driver.chooseDecision(actor, "v0.8", incumbent)).toBe(incumbent);
        expect(probes).toBe(1);
        driver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(audit, "utf8").trim())).toMatchObject({
            pureRangedJitNoMeleeFocusIncumbentLockProposals: 1,
            pureRangedJitNoMeleeFocusIncumbentLocks: 1,
            pureRangedJitNoMeleeFocusRejectedLockProbes: 0,
            pureRangedJitNoMeleeFocusSelections: 1,
            pureRangedJitNoMeleeFocusLocksByActorName: { Arbalester: 1 },
            pureRangedJitNoMeleeFocusLocksByTargetName: { Arbalester: 1 },
            pureRangedJitNoMeleeFocusLocksByLap: { "1": 1 },
        });
    });

    it("counts both proposal classes when an immediate-kill redirect rejects before its incumbent lock accepts", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-jit-kill-reject-lock-")), "search.jsonl");
        setEnv({ ...pureRangedJitFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_409, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary, noMelee } = positionJitFocusFixture(h);
        primary.grantStolenAbility("No Melee");
        // Ten bodies cap the redirect at 90 HP: still a kill, but close enough to the uncapped incumbent shot
        // to clear the preregistered aggregate-damage floor.
        primary.setAmountAlive(10);
        const driver = h.makeDriver();
        driver.onFightReady();
        const incumbent = jitAim(actor, noMelee);
        const intercepted = driver as unknown as {
            firstEngineValidCandidate(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                deadlineAt?: number | null,
            ): IEnumeratedCandidate | undefined;
        };
        const realProbe = intercepted.firstEngineValidCandidate.bind(driver);
        intercepted.firstEngineValidCandidate = (unit, candidates, seedBase, deadlineAt) => {
            expect(candidates.length).toBeGreaterThanOrEqual(2);
            expect(candidates[0].kind).toBe("shot");
            expect(candidates[0].targetId).toBe(primary.getId());
            expect(candidates[0].features.expectedKill).toBe(1);
            expect(candidates[1].kind).toBe("incumbent");
            expect(candidates[1].targetId).toBe(noMelee.getId());
            expect(candidates[1].features.expectedKill).toBe(0);
            // Inject the first redirect rejection, then retain the authoritative probe for the lock fallback.
            return realProbe(unit, candidates.slice(1), seedBase, deadlineAt);
        };
        expect(driver.chooseDecision(actor, "v0.8", incumbent)).toBe(incumbent);
        driver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(audit, "utf8").trim())).toMatchObject({
            pureRangedJitNoMeleeFocusIncumbentLockProposals: 1,
            pureRangedJitNoMeleeFocusIncumbentLocks: 1,
            pureRangedJitNoMeleeFocusRejectedLockProbes: 0,
            pureRangedJitNoMeleeFocusProposals: 1,
            pureRangedJitNoMeleeFocusImmediateKillProposals: 1,
            pureRangedJitNoMeleeFocusValidOverrides: 0,
            pureRangedJitNoMeleeFocusRejectedProbes: 0,
            pureRangedJitNoMeleeFocusSelections: 1,
        });
    });

    it("audits an active Endless Quiver JIT selection separately from finite ammo", () => {
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-jit-endless-")), "search.jsonl");
        setEnv({ ...pureRangedJitFocusEnvironment, SEARCH_AUDIT: audit });
        const h = buildBattle(10_408, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary, noMelee } = positionJitFocusFixture(h);
        // Unlimited ammo raises the optimistic lap-one ceiling to eleven activations; keep this fixture armed.
        noMelee.setAmountAlive(200);
        actor.grantStolenAbility("Endless Quiver");
        const driver = h.makeDriver();
        driver.onFightReady();

        expect(driver.chooseDecision(actor, "v0.8", jitAim(actor, primary))).not.toEqual(jitAim(actor, primary));
        driver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(audit, "utf8").trim())).toMatchObject({
            pureRangedJitNoMeleeFocusSelections: 1,
            pureRangedJitNoMeleeFocusFiniteAmmoSelections: 0,
            pureRangedJitNoMeleeFocusEndlessQuiverSelections: 1,
        });
    });

    it("falls through stock a13 after a rejected JIT lock and preserves deadline/circuit fail-closed behavior", () => {
        const rejectedAudit = join(mkdtempSync(join(tmpdir(), "hoc-jit-lock-rejected-")), "search.jsonl");
        setEnv({ ...pureRangedJitFocusEnvironment, SEARCH_AUDIT: rejectedAudit });
        const rejectedHarness = buildBattle(10_403, "v0.8", undefined, pureRangedParetoFocusRoster());
        const rejectedFixture = positionJitFocusFixture(rejectedHarness);
        const rejectedDriver = rejectedHarness.makeDriver();
        rejectedDriver.onFightReady();
        const rejectedIntercept = rejectedDriver as unknown as {
            firstEngineValidCandidate(): IEnumeratedCandidate | undefined;
        };
        rejectedIntercept.firstEngineValidCandidate = () => undefined;
        const rejectedIncumbent = jitAim(rejectedFixture.actor, rejectedFixture.noMelee);
        expect(rejectedDriver.chooseDecision(rejectedFixture.actor, "v0.8", rejectedIncumbent)).toBe(rejectedIncumbent);
        rejectedDriver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(rejectedAudit, "utf8").trim())).toMatchObject({
            searched: 1,
            pureRangedJitNoMeleeFocusIncumbentLockProposals: 1,
            pureRangedJitNoMeleeFocusIncumbentLocks: 0,
            pureRangedJitNoMeleeFocusRejectedLockProbes: 1,
            pureRangedJitNoMeleeFocusSelections: 0,
        });

        const deadlineAudit = join(mkdtempSync(join(tmpdir(), "hoc-jit-lock-deadline-")), "search.jsonl");
        setEnv({
            ...pureRangedJitFocusEnvironment,
            SEARCH_DECISION_DEADLINE_MS: "0.0001",
            SEARCH_AUDIT: deadlineAudit,
        });
        const deadlineHarness = buildBattle(10_404, "v0.8", undefined, pureRangedParetoFocusRoster());
        const deadlineFixture = positionJitFocusFixture(deadlineHarness);
        const deadlineDriver = deadlineHarness.makeDriver();
        deadlineDriver.onFightReady();
        const deadlineIncumbent = jitAim(deadlineFixture.actor, deadlineFixture.noMelee);
        expect(deadlineDriver.chooseDecision(deadlineFixture.actor, "v0.8", deadlineIncumbent)).toBe(deadlineIncumbent);
        deadlineDriver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(deadlineAudit, "utf8").trim())).toMatchObject({
            deadlineFallbacks: 1,
            pureRangedJitNoMeleeFocusIncumbentLockProposals: 1,
            pureRangedJitNoMeleeFocusIncumbentLocks: 0,
            pureRangedJitNoMeleeFocusRejectedLockProbes: 0,
            pureRangedJitNoMeleeFocusSelections: 0,
        });

        const circuitAudit = join(mkdtempSync(join(tmpdir(), "hoc-jit-lock-circuit-")), "search.jsonl");
        setEnv({
            ...pureRangedJitFocusEnvironment,
            SEARCH_CIRCUIT_BREAKER_MS: "0.0001",
            SEARCH_AUDIT: circuitAudit,
        });
        const circuitHarness = buildBattle(10_407, "v0.8", undefined, pureRangedParetoFocusRoster());
        const circuitFixture = positionJitFocusFixture(circuitHarness);
        const circuitDriver = circuitHarness.makeDriver();
        circuitDriver.onFightReady();
        circuitDriver.chooseDecision(
            circuitFixture.actor,
            "v0.8s",
            jitAim(circuitFixture.actor, circuitFixture.primary),
        );
        const circuitIncumbent = jitAim(circuitFixture.actor, circuitFixture.noMelee);
        expect(circuitDriver.chooseDecision(circuitFixture.actor, "v0.8", circuitIncumbent)).toBe(circuitIncumbent);
        circuitDriver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(circuitAudit, "utf8").trim())).toMatchObject({
            circuitOpened: true,
            circuitSkipped: 1,
            pureRangedJitNoMeleeFocusIncumbentLockProposals: 0,
            pureRangedJitNoMeleeFocusSelections: 0,
        });
    });

    it("gives JIT treatment and selector-off control identical catalogs while control counters stay zero", () => {
        setEnv({
            ...pureRangedJitFocusEnvironment,
            SEARCH_MAX_SHOTS: "1",
            SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS: "jit-catalog-only-control",
        });
        const audit = join(mkdtempSync(join(tmpdir(), "hoc-jit-catalog-only-")), "search.jsonl");
        process.env.SEARCH_AUDIT = audit;
        const h = buildBattle(10_405, "v0.8", undefined, pureRangedParetoFocusRoster());
        const { actor, primary } = positionJitFocusFixture(h);
        const driver = h.makeDriver();
        driver.onFightReady();
        const calls = captureCandidates(driver);

        driver.chooseDecision(actor, "v0.8s", jitAim(actor, primary));
        driver.chooseDecision(actor, "v0.8", jitAim(actor, primary));
        expect(calls).toHaveLength(2);
        expect(normalize(calls[1])).toEqual(normalize(calls[0]));
        expect(calls[0].filter((candidate) => candidate.kind === "shot").length).toBeGreaterThan(0);
        driver.onMatchEnd("draw", "turn_cap");
        expect(JSON.parse(readFileSync(audit, "utf8").trim())).toMatchObject({
            pureRangedJitNoMeleeFocus: true,
            pureRangedJitNoMeleeFocusVersions: ["jit-catalog-only-control"],
            pureRangedJitNoMeleeFocusIncumbentLockProposals: 0,
            pureRangedJitNoMeleeFocusProposals: 0,
            pureRangedJitNoMeleeFocusSelections: 0,
            pureRangedJitNoMeleeFocusValidOverrides: 0,
        });
    });

    it("rejects JIT overlap with Pareto and every earlier pure-ranged arm", () => {
        for (const conflict of [
            { SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS: "1" },
            { SEARCH_PURE_RANGED_NO_MELEE_PRESSURE: "1" },
            { SEARCH_PURE_RANGED_DEADLINE_FINISHER: "1" },
        ]) {
            setEnv({ ...pureRangedJitFocusEnvironment, ...conflict });
            const h = buildBattle(10_406, "v0.8", undefined, pureRangedParetoFocusRoster());
            expect(() => h.makeDriver()).toThrow("mutually exclusive");
        }
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

    it("optionally scopes a shared version label to one physical team", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8" });
        const h = buildBattle(202, "v0.8");
        const scoped = h.makeDriver(undefined, undefined, { searchTeamScope: [GREEN_TEAM] });

        expect(scoped.appliesTo("v0.8")).toBe(false);
        expect(scoped.appliesTo("v0.8", GREEN_TEAM)).toBe(true);
        expect(scoped.appliesTo("v0.8", RED_TEAM)).toBe(false);

        expect(() => h.makeDriver(undefined, undefined, { searchTeamScope: [PBTypes.TeamVals.NO_TEAM] })).toThrow(
            "Search team scope may contain only LOWER and UPPER",
        );
    });

    it("keeps wait and defend challengers when SEARCH_ACTIVE_CHALLENGERS is default-off", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.6" });
        const h = buildBattle(203, "v0.6", undefined, HOURGLASS_FIXTURE_ROSTER);
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

    it("keeps v0.8 tactical-wait challengers but never introduces a generated Luck Shield", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s" });
        const h = buildBattle(203, "v0.8s", undefined, HOURGLASS_FIXTURE_ROSTER);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        const incumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
        const driver = h.makeDriver();
        const calls = captureCandidates(driver);

        expect(driver.chooseDecision(unit!, "v0.8s", incumbent)).toBe(incumbent);
        expect(calls).toHaveLength(1);
        expect(calls[0].map((candidate) => candidate.kind)).toContain("wait");
        expect(calls[0].slice(1).map((candidate) => candidate.kind)).not.toContain("defend");
    });

    it("V08_AGGRESSIVE keeps waits scored while hard-prioritizing only idle, Luck Shield, and mountain", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s,v0.8", V08_AGGRESSIVE: "1" });
        const h = buildBattle(203, "v0.8s", undefined, HOURGLASS_FIXTURE_ROSTER);
        const unit = h.activeUnit()!;
        const id = unit.getId();
        const calls: Array<{ kinds: string[]; prioritizeProductive: boolean; aggressiveWait: boolean }> = [];
        const driver = h.makeDriver() as unknown as {
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seedBase: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
                aggressiveWaitComparison?: boolean,
            ): GameAction[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        driver.search = (
            _unit,
            candidates,
            incumbent,
            _seed,
            _t0,
            prioritizeProductive = false,
            _fallback,
            _finish,
            aggressiveWait = false,
        ) => {
            calls.push({ kinds: candidates.slice(1).map(({ kind }) => kind), prioritizeProductive, aggressiveWait });
            return incumbent;
        };

        const passiveIncumbents: GameAction[][] = [
            [{ type: "end_turn", unitId: id, reason: "skip" }],
            [{ type: "wait_turn", unitId: id }],
            [{ type: "defend_turn", unitId: id }],
            [{ type: "obstacle_attack", attackerId: id, targetPosition: { x: 7, y: 7 } }],
        ];
        for (const incumbent of passiveIncumbents) {
            expect(driver.chooseDecision(unit, "v0.8s", incumbent)).toBe(incumbent);
        }

        expect(calls).toHaveLength(passiveIncumbents.length);
        expect(calls.map(({ prioritizeProductive }) => prioritizeProductive)).toEqual([true, false, true, true]);
        expect(calls.map(({ aggressiveWait }) => aggressiveWait)).toEqual([false, true, false, false]);
        expect(calls[0].kinds).toContain("wait");
        for (const call of calls) {
            expect(call.kinds).not.toContain("defend");
            expect(call.kinds).not.toContain("mine");
        }

        calls.length = 0;
        const wait = passiveIncumbents[1];
        expect(driver.chooseDecision(unit, "v0.8", wait)).toBe(wait);
        expect(driver.chooseDecision(unit, "v0.8", passiveIncumbents[0])).toBe(passiveIncumbents[0]);
        expect(calls).toHaveLength(2);
        expect(calls[0].prioritizeProductive).toBe(false);
        expect(calls[0].aggressiveWait).toBe(true);
        expect(calls[1].kinds).toContain("wait");
    });

    it("V08_AGGRESSIVE replaces a wait only with an engine-valid productive action scoring at least as well", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "1",
            V08_AGGRESSIVE: "1",
        });
        const h = buildBattle(206, "v0.8s");
        const unit = h.activeUnit()!;
        const wait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        driver.scoreCandidates = (_unit, candidates) =>
            candidates.map(({ kind }) => (kind === "incumbent" ? 0.99 : 0.01));

        expect(driver.chooseDecision(unit, "v0.8s", wait)).toBe(wait);

        const tiedHarness = buildBattle(206, "v0.8s");
        const tiedUnit = tiedHarness.activeUnit()!;
        const tiedWait: GameAction[] = [{ type: "wait_turn", unitId: tiedUnit.getId() }];
        const tiedDriver = tiedHarness.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        tiedDriver.scoreCandidates = (_unit, candidates) => candidates.map(() => 0.5);
        const tiedChoice = tiedDriver.chooseDecision(tiedUnit, "v0.8s", tiedWait);
        expect(tiedChoice).not.toBe(tiedWait);
        expect(hasProductiveAction(tiedChoice)).toBe(true);
        expectEngineAcceptsProductiveDecision(tiedHarness, tiedChoice);

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "1",
            V08_AGGRESSIVE: "1",
            SEARCH_A19_STRICT_AGGRESSIVE_WAIT_TIES: "1",
        });
        const strictHarness = buildBattle(206, "v0.8");
        const strictUnit = strictHarness.activeUnit()!;
        const strictWait: GameAction[] = [{ type: "wait_turn", unitId: strictUnit.getId() }];
        const strictDriver = strictHarness.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        strictDriver.scoreCandidates = (_unit, candidates) => candidates.map(() => 0.5);
        expect(strictDriver.chooseDecision(strictUnit, "v0.8", strictWait)).toBe(strictWait);

        const rejectedHarness = buildBattle(206, "v0.8s");
        const rejectedUnit = rejectedHarness.activeUnit()!;
        const rejectedWait: GameAction[] = [{ type: "wait_turn", unitId: rejectedUnit.getId() }];
        const rejectedDriver = rejectedHarness.makeDriver() as unknown as {
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        rejectedDriver.scoreCandidates = (_unit, candidates) =>
            candidates.map(({ kind }) => (kind === "incumbent" ? 0.99 : -Infinity));
        expect(rejectedDriver.chooseDecision(rejectedUnit, "v0.8s", rejectedWait)).toBe(rejectedWait);
    });

    it("keeps the normal rollout gate for an explicit stronger-ranged posture wait", () => {
        const buildStrongPosture = () => {
            // Seed 204, not 203: adding Trent to the Nature L2 catalog shifted the seeded roster and 203 no
            // longer deals this side a shooter, which is the posture these tests exist to exercise.
            const harness = buildBattle(204, "v0.8s");
            const unit = [...harness.unitsHolder.getAllAllies(GREEN_TEAM)].find(
                (candidate) =>
                    !candidate.isDead() &&
                    candidate.getAttackType() === PBTypes.AttackVals.MELEE &&
                    !candidate.isRangeCapable() &&
                    candidate.canMove(),
            )!;
            const ownShooters = harness.unitsHolder
                .getAllAllies(GREEN_TEAM)
                .filter((candidate) => !candidate.isDead() && candidate.isRangeCapable());
            const enemyShooters = harness.unitsHolder
                .getAllAllies(RED_TEAM)
                .filter((candidate) => !candidate.isDead() && candidate.isRangeCapable());
            expect(ownShooters.length).toBeGreaterThan(0);
            expect(enemyShooters.length).toBeGreaterThan(0);
            for (const shooter of ownShooters) shooter.setAmountAlive(1_000);
            for (const shooter of enemyShooters) shooter.setAmountAlive(1);
            harness.setActiveUnitId(unit.getId());
            const wait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
            expect(
                isV08StrongerRangedPostureWait(
                    unit,
                    harness.unitsHolder,
                    harness.fightProperties.getCurrentLap(),
                    wait,
                ),
            ).toBe(true);
            return { harness, unit, wait };
        };

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_GATE: "0.1",
            SEARCH_DECISION_DEADLINE_MS: "1",
            SEARCH_WAIT_DEADLINE_POLICY: "operation_bounded",
            V08_AGGRESSIVE: "1",
        });
        const tied = buildStrongPosture();
        const tiedDriver = tied.harness.makeDriver() as unknown as {
            decisionDeadlineMs: number | null;
            counters: { strongerRangedPostureWaits: number };
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
                rolloutCount?: number,
                deadlineAt?: number | null,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        tiedDriver.decisionDeadlineMs = 0;
        const tiedDeadlines: Array<number | null> = [];
        tiedDriver.scoreCandidates = (_unit, candidates, _seedBase, _mode, _rolloutCount, deadlineAt = null) => {
            tiedDeadlines.push(deadlineAt);
            return candidates.map(() => 0.5);
        };
        expect(tiedDriver.chooseDecision(tied.unit, "v0.8s", tied.wait)).toBe(tied.wait);
        expect(tiedDeadlines.length).toBeGreaterThan(0);
        expect(tiedDeadlines.every((deadline) => deadline === null)).toBe(true);
        expect(tiedDriver.counters.strongerRangedPostureWaits).toBe(1);

        const circuitTied = buildStrongPosture();
        const circuitTiedDriver = circuitTied.harness.makeDriver() as unknown as {
            circuitOpen: boolean;
            counters: { circuitWaitArbitrations: number };
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
                rolloutCount?: number,
                deadlineAt?: number | null,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        circuitTiedDriver.circuitOpen = true;
        circuitTiedDriver.scoreCandidates = (_unit, candidates) => candidates.map(() => 0.5);
        expect(circuitTiedDriver.chooseDecision(circuitTied.unit, "v0.8s", circuitTied.wait)).toBe(circuitTied.wait);
        expect(circuitTiedDriver.counters.circuitWaitArbitrations).toBe(1);

        const better = buildStrongPosture();
        const betterDriver = better.harness.makeDriver() as unknown as {
            decisionDeadlineMs: number | null;
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
                rolloutCount?: number,
                deadlineAt?: number | null,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        betterDriver.decisionDeadlineMs = 0;
        betterDriver.scoreCandidates = (_unit, candidates) =>
            candidates.map(({ kind }) => (kind === "incumbent" ? 0.1 : 0.9));
        const betterChoice = betterDriver.chooseDecision(better.unit, "v0.8s", better.wait);
        expect(betterChoice).not.toBe(better.wait);
        expect(hasProductiveAction(betterChoice)).toBe(true);
    });

    it("V08_AGGRESSIVE starts the two-to-one finish window five laps before Armageddon", () => {
        setEnv({ V07_SEARCH: "1", SEARCH_VERSIONS: "v0.8s,v0.8", V08_AGGRESSIVE: "1" });
        const h = buildBattle(207, "v0.8s");
        const unit = h.activeUnit()!;
        const incumbent: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const finishFlags: boolean[] = [];
        const driver = h.makeDriver() as unknown as {
            search(
                unit: Unit,
                candidates: IEnumeratedCandidate[],
                incumbent: GameAction[],
                seedBase: number,
                t0: number,
                prioritizeProductiveActions?: boolean,
                productiveFallback?: IEnumeratedCandidate,
                prioritizeDominantFinish?: boolean,
            ): GameAction[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        driver.search = (_unit, _candidates, current, _seed, _t0, _productive, _fallback, finish = false) => {
            finishFlags.push(finish);
            return current;
        };

        while (h.fightProperties.getCurrentLap() < V08_DOMINANT_FINISH_START_LAP - 1) {
            h.fightProperties.flipLap();
        }
        expect(driver.chooseDecision(unit, "v0.8s", incumbent)).toBe(incumbent);

        const enemyTeam = unit.getTeam() === GREEN_TEAM ? RED_TEAM : GREEN_TEAM;
        for (const enemy of h.unitsHolder.getAllAllies(enemyTeam)) {
            enemy.applyDamage(Math.floor(enemy.getCumulativeHp() * 0.75), 0, new SceneLogMock());
        }
        h.fightProperties.flipLap();
        expect(h.fightProperties.getCurrentLap()).toBe(V08_DOMINANT_FINISH_START_LAP);
        expect(driver.chooseDecision(unit, "v0.8s", incumbent)).toBe(incumbent);
        expect(driver.chooseDecision(unit, "v0.8", incumbent)).toBe(incumbent);
        expect(finishFlags).toEqual([false, true, true]);
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

    it("uses fixed offline work bounds while an omitted match flag retains live deadline and circuit behavior", () => {
        const run = (offlineDeterministicWork: boolean | undefined): Record<string, unknown> => {
            const auditPath = join(
                mkdtempSync(join(tmpdir(), offlineDeterministicWork ? "search-offline-work-" : "search-live-work-")),
                "audit.jsonl",
            );
            process.env.SEARCH_AUDIT = auditPath;
            const h = buildBattle(204, "v0.6");
            h.playTurns(10);
            const unit = h.activeUnit();
            expect(unit).toBeDefined();
            const incumbent: GameAction[] = [{ type: "end_turn", unitId: unit!.getId(), reason: "skip" }];
            const driver = h.makeDriver(undefined, undefined, { offlineDeterministicWork });
            const observedDeadlines: Array<number | null> = [];
            const intercepted = driver as unknown as {
                shortlistCandidates(
                    unit: Unit,
                    candidates: IEnumeratedCandidate[],
                    seedBase: number,
                    deadlineAt: number | null,
                ): IEnumeratedCandidate[];
                scoreCandidates(
                    unit: Unit,
                    candidates: readonly IEnumeratedCandidate[],
                    seedBase: number,
                    horizonMode: string,
                    rolloutCount: number,
                    deadlineAt: number | null,
                ): number[];
            };
            intercepted.shortlistCandidates = (_unit, candidates, _seedBase, deadlineAt) => {
                observedDeadlines.push(deadlineAt);
                return candidates.slice(0, 2);
            };
            intercepted.scoreCandidates = (_unit, candidates) => candidates.map(() => 0);

            driver.chooseDecision(unit!, "v0.6", incumbent);
            driver.onMatchEnd("draw", "turn_cap");
            expect(observedDeadlines).toHaveLength(1);
            expect(observedDeadlines[0] === null).toBe(offlineDeterministicWork === true);
            return JSON.parse(readFileSync(auditPath, "utf8").trim()) as Record<string, unknown>;
        };

        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_DECISION_DEADLINE_MS: "0.000001",
            SEARCH_CIRCUIT_BREAKER_MS: "0.00001",
        });
        expect(run(undefined)).toMatchObject({
            offlineDeterministicWork: false,
            circuitOpened: true,
        });
        expect(run(true)).toMatchObject({
            offlineDeterministicWork: true,
            deadlineFallbacks: 0,
            circuitOpened: false,
            circuitSkipped: 0,
        });
    });

    it("repairs hard v0.8 passives but preserves a strategic wait after its search circuit opens", () => {
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
        expect(thirdResult).toBe(thirdIncumbent);
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

    it("owned rollback checkpoints match legacy snapshot decisions and state", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "2",
            SEARCH_HORIZON: "4",
            SEARCH_SHORTLIST: "2",
        });
        const run = (rollbackStrategy: SearchRollbackStrategy) => {
            const h = buildBattle(913, "v0.6");
            h.playTurns(8);
            const unit = h.activeUnit();
            expect(unit).toBeDefined();
            const incumbent = h.decideActive();
            const before = stableSnapshot(h);
            const chosen = JSON.stringify(
                h.makeDriver(undefined, rollbackStrategy).chooseDecision(unit!, "v0.6", incumbent),
            );
            const after = stableSnapshot(h);
            return { before, chosen, after };
        };

        const legacy = run("snapshot");
        const checkpoint = run("checkpoint");
        expect(legacy.after).toEqual(legacy.before);
        expect(checkpoint.after).toEqual(checkpoint.before);
        expect(checkpoint).toEqual(legacy);
    });

    it("accepts only explicit checkpoint or legacy rollback strategies", () => {
        setEnv({ SEARCH_ROLLBACK_STRATEGY: "snapshot" });
        const legacy = buildBattle(914, "v0.6").makeDriver() as unknown as { rollbackStrategy: string };
        expect(legacy.rollbackStrategy).toBe("snapshot");

        setEnv({ SEARCH_ROLLBACK_STRATEGY: "checkpoint" });
        const checkpoint = buildBattle(915, "v0.6").makeDriver() as unknown as { rollbackStrategy: string };
        expect(checkpoint.rollbackStrategy).toBe("checkpoint");

        setEnv({ SEARCH_ROLLBACK_STRATEGY: "unsupported" });
        expect(() => buildBattle(916, "v0.6").makeDriver()).toThrow(
            "SEARCH_ROLLBACK_STRATEGY must be checkpoint or snapshot",
        );
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

    it("casts instead of shielding or forcing a harmful shot after the deadline and circuit open", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "6",
            SEARCH_SHORTLIST: "2",
            SEARCH_INCLUDE_MOVES: "1",
        });
        const h = buildBattle(13_314, "v0.8s", undefined, [
            { faction: "Might", creatureName: "Cyclops", level: 3, size: 1, amount: 1 },
            { faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 50 },
        ]);
        const named = (team: TeamType, name: string): Unit =>
            [...h.unitsHolder.getAllUnits().values()].find(
                (candidate) => candidate.getTeam() === team && candidate.getName() === name,
            )!;
        const actor = named(GREEN_TEAM, "Cyclops");
        const ally = named(GREEN_TEAM, "Squire");
        const target = named(RED_TEAM, "Squire");
        const distantEnemy = named(RED_TEAM, "Cyclops");
        const placements: Array<readonly [Unit, XY]> = [
            [actor, { x: 2, y: 7 }],
            [ally, { x: 9, y: 8 }],
            [target, { x: 9, y: 7 }],
            [distantEnemy, { x: 13, y: 13 }],
        ];
        for (const [unit] of placements) {
            h.grid.cleanupAll(unit.getId(), unit.getAttackRange(), unit.isSmallSize());
        }
        for (const [unit, cell] of placements) {
            const position = getPositionForCell(
                cell,
                h.grid.getSettings().getMinX(),
                h.grid.getSettings().getStep(),
                h.grid.getSettings().getHalfStep(),
            );
            unit.setPosition(position.x, position.y);
            h.grid.occupyCell(
                cell,
                unit.getId(),
                unit.getTeam(),
                unit.getAttackRange(),
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        }
        target.applyDamage(target.getCumulativeHp() - 1, 0, new SceneLogMock(), false);
        actor.setTarget(target.getId());
        actor.grantStolenAbility("Forest Spellbook", ["Life:Courage"]);
        h.setActiveUnitId(actor.getId());

        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: actor.getId() }];
        const catalogDriver = h.makeDriver();
        const catalogCalls = captureCandidates(catalogDriver);
        expect(catalogDriver.chooseDecision(actor, "v0.8s", incumbent)).toBe(incumbent);
        expect(catalogCalls).toHaveLength(1);
        const candidates = catalogCalls[0];
        const harmfulShot = candidates.find(
            (candidate) =>
                candidate.kind === "shot" &&
                candidate.actions.some(
                    (action) => action.type === "range_attack" && action.targetId === target.getId(),
                ) &&
                candidate.features.expectedDamage < 0 &&
                candidate.features.expectedKill === 1 &&
                (candidate.shotFeatures?.primaryTargetDamage ?? 0) > 0,
        );
        const courage = candidates.find(
            (candidate) =>
                candidate.kind === "spell" &&
                candidate.actions.some((action) => action.type === "cast_spell" && action.spellName === "Courage"),
        );
        const positiveDirectCombat = candidates.filter(
            (candidate) =>
                candidate.features.expectedDamage > 0 &&
                candidate.actions.some(
                    (action) =>
                        action.type === "melee_attack" ||
                        action.type === "range_attack" ||
                        action.type === "area_throw_attack",
                ),
        );
        expect(harmfulShot).toBeDefined();
        expect(courage).toBeDefined();
        expect(positiveDirectCombat).toEqual([]);

        const before = stableSnapshot(h);
        const deadlineDriver = h.makeDriver() as unknown as {
            decisionDeadlineMs: number | null;
            counters: { deadlineFallbacks: number; scoredCandidatesTotal: number };
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        // Zero is injected after construction so the real chooseDecision path deterministically reaches its
        // deadline fallback without relying on a sub-microsecond wall-clock race.
        deadlineDriver.decisionDeadlineMs = 0;
        setDeterministicRandomSource(makeRng(0xd1ead));
        const deadlineExpectedRandom = getRandomInt(0, 1_000_000);
        setDeterministicRandomSource(makeRng(0xd1ead));

        const deadlineChosen = deadlineDriver.chooseDecision(actor, "v0.8s", incumbent);

        expect(deadlineChosen).toEqual(courage!.actions);
        expect(deadlineChosen.some((action) => action.type === "range_attack")).toBe(false);
        expect(deadlineChosen.some((action) => action.type === "defend_turn")).toBe(false);
        expect(stableSnapshot(h)).toEqual(before);
        expect(getRandomInt(0, 1_000_000)).toBe(deadlineExpectedRandom);
        expect(deadlineDriver.counters).toMatchObject({ deadlineFallbacks: 1, scoredCandidatesTotal: 0 });

        const circuitDriver = h.makeDriver() as unknown as {
            circuitOpen: boolean;
            counters: { decisions: number; circuitSkipped: number };
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        circuitDriver.circuitOpen = true;
        setDeterministicRandomSource(makeRng(0xc1c017));
        const circuitExpectedRandom = getRandomInt(0, 1_000_000);
        setDeterministicRandomSource(makeRng(0xc1c017));

        const circuitChosen = circuitDriver.chooseDecision(actor, "v0.8s", incumbent);

        expect(circuitChosen).toEqual(courage!.actions);
        expect(circuitChosen.some((action) => action.type === "range_attack")).toBe(false);
        expect(circuitChosen.some((action) => action.type === "defend_turn")).toBe(false);
        expect(stableSnapshot(h)).toEqual(before);
        expect(getRandomInt(0, 1_000_000)).toBe(circuitExpectedRandom);
        expect(circuitDriver.counters).toMatchObject({ decisions: 0, circuitSkipped: 1 });

        // The rejected choice was genuinely engine-legal: it is excluded only because its net AOE damage is
        // harmful, not because the fallback probe happened to reject it.
        for (const action of harmfulShot!.actions) {
            expect(h.engine.apply(action).completed).toBe(true);
        }
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

    it("preserves a strategic v0.8 wait when the deadline expires and after its circuit opens", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8s",
            SEARCH_DECISION_DEADLINE_MS: "0.000001",
            SEARCH_CIRCUIT_BREAKER_MS: "0.00001",
        });
        const h = buildBattle(1313, "v0.8s");
        h.playTurns(8);
        const unit = h.activeUnit()!;
        const wait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const driver = h.makeDriver();
        const counters = (
            driver as unknown as {
                counters: { decisions: number; deadlineFallbacks: number; circuitSkipped: number };
            }
        ).counters;

        expect(driver.chooseDecision(unit, "v0.8s", wait)).toBe(wait);
        expect(driver.chooseDecision(unit, "v0.8s", wait)).toBe(wait);
        expect(counters).toMatchObject({ decisions: 1, deadlineFallbacks: 1, circuitSkipped: 1 });
    });

    it("never blindly replaces an aggressive ordinary wait when its value comparison times out", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVES: "1",
            SEARCH_MAX_MELEE: "1",
            SEARCH_MAX_SHOTS: "1",
            SEARCH_MAX_THROWS: "1",
            V08_AGGRESSIVE: "1",
        });
        const h = buildBattle(13_131, "v0.8");
        const unit = [...h.unitsHolder.getAllUnits().values()].find(
            (candidate) => !candidate.isDead() && !candidate.isRangeCapable() && candidate.canMove(),
        )!;
        expect(unit).toBeDefined();
        h.setActiveUnitId(unit.getId());
        unit.refreshPossibleAttackTypes(true);
        const wait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const probes: ISearchPassiveProductiveProbe[] = [];
        const driver = h.makeDriver((probe) => probes.push({ ...probe })) as unknown as {
            decisionDeadlineMs: number | null;
            counters: { deadlineFallbacks: number; msTotal: number };
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        // Inject after validation so the live comparison deterministically reaches the timeout. The detached
        // counterfactual may prove a productive action exists, but it cannot retroactively alter behavior.
        driver.decisionDeadlineMs = 0;

        expect(driver.chooseDecision(unit, "v0.8", wait)).toBe(wait);
        expect(driver.counters.deadlineFallbacks).toBe(1);
        expect(probes).toHaveLength(1);
        expect(probes[0]).toMatchObject({
            incumbentKind: "wait",
            retainedPassive: true,
            hasEngineValidProductiveAlternative: true,
            scoreComparisonComplete: true,
            evidenceComplete: true,
            resolution: "deadline_fallback",
        });
        expect(probes[0].incumbentScore).toBeNumber();
        expect(probes[0].bestShortlistedProductiveScore).toBeNumber();
        expect(driver.counters.msTotal).toBe(probes[0].decisionMs);
    });

    it("completes an operation-bounded aggressive wait comparison despite an expired profile deadline", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_DECISION_DEADLINE_MS: "1",
            SEARCH_WAIT_DEADLINE_POLICY: "operation_bounded",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_INCLUDE_MOVES: "1",
            SEARCH_MAX_MOVES: "1",
            SEARCH_MAX_MELEE: "1",
            SEARCH_MAX_SHOTS: "1",
            SEARCH_MAX_THROWS: "1",
            V08_AGGRESSIVE: "1",
        });
        const h = buildBattle(13_132, "v0.8");
        const unit = [...h.unitsHolder.getAllUnits().values()].find(
            (candidate) => !candidate.isDead() && !candidate.isRangeCapable() && candidate.canMove(),
        )!;
        h.setActiveUnitId(unit.getId());
        unit.refreshPossibleAttackTypes(true);
        const wait: GameAction[] = [{ type: "wait_turn", unitId: unit.getId() }];
        const deadlines: Array<number | null> = [];
        const driver = h.makeDriver() as unknown as {
            decisionDeadlineMs: number | null;
            counters: { deadlineFallbacks: number };
            scoreCandidates(
                unit: Unit,
                candidates: readonly IEnumeratedCandidate[],
                seedBase: number,
                mode: string,
                rolloutCount?: number,
                deadlineAt?: number | null,
            ): number[];
            chooseDecision(unit: Unit, version: string, incumbent: GameAction[]): GameAction[];
        };
        driver.decisionDeadlineMs = 0;
        driver.scoreCandidates = (_unit, candidates, _seedBase, _mode, _rolloutCount, deadlineAt = null) => {
            deadlines.push(deadlineAt);
            return candidates.map(({ kind }) => (kind === "incumbent" ? 0.1 : 0.9));
        };

        const choice = driver.chooseDecision(unit, "v0.8", wait);

        expect(choice).not.toBe(wait);
        expect(hasProductiveAction(choice)).toBe(true);
        expect(deadlines.length).toBeGreaterThan(0);
        expect(deadlines.every((deadline) => deadline === null)).toBe(true);
        expect(driver.counters.deadlineFallbacks).toBe(0);
        expectEngineAcceptsProductiveDecision(h, choice);
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

    it("marks every strategy decision made inside SearchDriver as a rollout", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.6",
            SEARCH_ROLLOUTS: "1",
            SEARCH_HORIZON: "6",
            SEARCH_GATE: "0",
            SEARCH_SHORTLIST: "2",
        });
        const origins: Array<IDecisionContext["decisionOrigin"]> = [];
        const trueStrategy = getAIStrategy("v0.6");
        const recordingStrategy = {
            version: "rollout-origin-recorder",
            decideTurn: (unit: Unit, context: IDecisionContext): GameAction[] => {
                origins.push(context.decisionOrigin);
                return trueStrategy.decideTurn(unit, context);
            },
        } as unknown as IAIStrategy;
        const harness = buildBattle(1313, "v0.6", recordingStrategy);
        harness.playTurns(8);
        const unit = harness.activeUnit();
        expect(unit).toBeDefined();

        harness.makeDriver().chooseDecision(unit!, "v0.6", harness.decideActive());

        expect(origins.length).toBeGreaterThan(0);
        expect(origins.every((origin) => origin === "rollout")).toBe(true);
    });

    it("pins active AI-Driven rollout turns to v0.1 ahead of team and opponent models", () => {
        setEnv({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_OPP_MODEL: "v0.4",
        });
        let teamCalls = 0;
        let opponentModelCalls = 0;
        const origins: Array<IDecisionContext["decisionOrigin"]> = [];
        const teamStrategy = {
            version: "team-rollout-recorder",
            decideTurn: (): GameAction[] => {
                teamCalls += 1;
                return [];
            },
        } as unknown as IAIStrategy;
        const h = buildBattle(1314, "v0.8", teamStrategy);
        const unit = h.activeUnit();
        expect(unit).toBeDefined();
        unit!.grantAbility("AI Driven");

        const v01 = getAIStrategy("v0.1");
        const opponentModel = getAIStrategy("v0.4");
        const originalV01DecideTurn = v01.decideTurn;
        const originalOpponentDecideTurn = opponentModel.decideTurn;
        v01.decideTurn = (rolloutUnit, context) => {
            origins.push(context.decisionOrigin);
            return originalV01DecideTurn.call(v01, rolloutUnit, context);
        };
        opponentModel.decideTurn = (rolloutUnit, context) => {
            opponentModelCalls += 1;
            return originalOpponentDecideTurn.call(opponentModel, rolloutUnit, context);
        };
        try {
            const driver = h.makeDriver() as unknown as {
                rolloutEnemyTeam: TeamType | null;
                simPlayTurn(unitToPlay: Unit): void;
            };
            // Exercise the strongest alternate route: the unit is on the side currently rebound to
            // SEARCH_OPP_MODEL. AI Driven must still win before that model is consulted.
            driver.rolloutEnemyTeam = unit!.getTeam();
            driver.simPlayTurn(unit!);
        } finally {
            v01.decideTurn = originalV01DecideTurn;
            opponentModel.decideTurn = originalOpponentDecideTurn;
        }

        expect(origins).toEqual(["rollout"]);
        expect(teamCalls).toBe(0);
        expect(opponentModelCalls).toBe(0);
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
        const h = buildBattle(2032, "v0.6", undefined, HOURGLASS_FIXTURE_ROSTER);
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
            maxMoveShotComposites: 0,
            moveShotVersions: [],
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
                maxMoveShotComposites: 0,
                moveShotVersions: [],
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
            const eligible =
                canWaitOnHourglassMirror(unit, fp, h.unitsHolder.getAllUnits()) &&
                waitScorerInSupport(unit, h.unitsHolder);
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
        // Find a deterministic live-battle point inside the deployed scorer's training support. Searching a
        // small fixed seed prefix keeps catalog additions from pinning this wiring test to a newly ranged or
        // caster-heavy roster while still failing if no supported engine-waitable action remains reachable.
        let fixture: { h: Harness; unit: Unit } | undefined;
        for (let seed = 1; seed <= 64 && !fixture; seed += 1) {
            setEnv({});
            const h = buildBattle(seed, "v0.6s");
            try {
                fixture = { h, unit: findEligibleActPoint(h).unit };
            } catch {
                // This roster has no supported act point inside the bounded live-battle window.
            }
        }
        expect(fixture).toBeDefined();
        if (!fixture) throw new Error("no supported wait-scorer wiring fixture found");

        setEnv({ V07_WAIT_SCORER: "on", V07_WAIT_WEIGHTS: armedBias(9) });
        const decided = fixture.h.decideActive();
        expect(decided).toEqual([{ type: "wait_turn", unitId: fixture.unit.getId() }]);
        const applied = fixture.h.engine.apply(decided[0]);
        expect(applied.completed).toBe(true);
    });

    it("scorer stays scoped to v0.6s by default: plain v0.6 decides identically even when armed", () => {
        let fixture: { seed: number; battle: Harness } | undefined;
        for (let seed = 1; seed <= 64 && !fixture; seed += 1) {
            setEnv({});
            const battle = buildBattle(seed, "v0.6");
            try {
                findEligibleActPoint(battle);
                fixture = { seed, battle };
            } catch {
                // This roster has no supported same-team defer point inside the bounded window.
            }
        }
        expect(fixture).toBeDefined();
        if (!fixture) throw new Error("no supported plain-v0.6 wait-scorer fixture found");
        const offDecision = JSON.stringify(fixture.battle.decideActive());

        setEnv({});
        const b = buildBattle(fixture.seed, "v0.6");
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
