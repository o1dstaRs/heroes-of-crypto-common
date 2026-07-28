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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { canUnitLandAt } from "../../src/ai/ai";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import {
    enumerateCandidates,
    getEnemiesCellsWithinMovementRange,
    type IEnumeratedCandidate,
} from "../../src/ai/candidates";
import { prioritizeV08ProductiveAction, StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { HITS_PER_MOUNTAIN, NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../src/constants";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType, UnitSizeType } from "../../src/generated/protobuf/v1/types_gen";
import type { Grid } from "../../src/grid/grid";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { runMatch } from "../../src/simulation/battle_engine";
import { createV08A13SearchDriver } from "../../src/simulation/v0_8_a13_search";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const SMALL = PBTypes.UnitSizeVals.SMALL;
const LARGE = PBTypes.UnitSizeVals.LARGE;
const BLOCK_CENTER = PBTypes.GridVals.BLOCK_CENTER;
const A13_URGENT_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 3;

const SEARCH_MODE_KEYS = ["V08_A13_SEARCH", "V07_SEARCH", "Q2_WAIT_ABLATION", "Q2_ORACLE"] as const;
const savedSearchMode = Object.fromEntries(SEARCH_MODE_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
    delete process.env.V07_SEARCH;
    delete process.env.Q2_WAIT_ABLATION;
    delete process.env.Q2_ORACLE;
    // Force the production factory even when a developer shell has unrelated search variables set.
    process.env.V08_A13_SEARCH = "1";
});

afterEach(() => {
    for (const key of SEARCH_MODE_KEYS) {
        const value = savedSearchMode[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

type MountainSide = "left" | "right";
type BodySize = "small" | "large";
type StrikeMode = "stationary" | "routed";

interface BlockFixture {
    readonly actor: Unit;
    readonly enemy: Unit;
    readonly combat: CombatTestContext;
    readonly context: IDecisionContext;
    readonly engine: GameActionEngine;
    readonly turnEngine: TurnEngine;
    readonly fightProperties: ReturnType<FightStateManager["getFightProperties"]>;
    readonly pathHelper: PathHelper;
    readonly getActiveUnitId: () => string;
    readonly setActiveUnitId: (id: string) => void;
}

const otherTeam = (team: TeamType): TeamType => (team === LOWER ? UPPER : LOWER);

const footprintAt = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [{ ...base }]
        : [{ ...base }, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];

function placeActor(combat: CombatTestContext, unit: Unit, base: XY): void {
    if (unit.isSmallSize()) {
        placeUnit(combat.grid, combat.unitsHolder, unit, base);
        return;
    }
    const cells = footprintAt(unit, base);
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) throw new Error(`invalid large-unit base ${base.x},${base.y}`);
    unit.setPosition(position.x, position.y);
    const occupied = combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    if (!occupied) throw new Error(`large-unit placement rejected at ${base.x},${base.y}`);
    combat.unitsHolder.addUnit(unit);
}

function setMountainState(combat: CombatTestContext, leftIntact: boolean, rightIntact: boolean): void {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(BLOCK_CENTER);
    fightProperties.setObstacleHitsPerMountain(leftIntact ? HITS_PER_MOUNTAIN : 0, rightIntact ? HITS_PER_MOUNTAIN : 0);
    if (!leftIntact) combat.grid.clearMountainSide(false);
    if (!rightIntact) combat.grid.clearMountainSide(true);
}

function buildBlockFixture(options: {
    readonly team: TeamType;
    readonly size: UnitSizeType;
    readonly actorBase: XY;
    readonly enemyBase?: XY;
    readonly speed?: number;
    readonly leftIntact?: boolean;
    readonly rightIntact?: boolean;
    readonly rangedAlly?: boolean;
    readonly lap?: number;
}): BlockFixture {
    const combat = createCombatTestContext(BLOCK_CENTER);
    setMountainState(combat, options.leftIntact ?? true, options.rightIntact ?? true);

    const actor = createTestUnit({
        team: options.team,
        name: options.size === LARGE ? "Large BLOCK_CENTER actor" : "Small BLOCK_CENTER actor",
        attackType: MELEE,
        attack: 100,
        armor: 20,
        damageMin: 10,
        damageMax: 10,
        amountAlive: 2,
        maxHp: 100,
        speed: options.speed ?? 2,
        size: options.size,
    });
    const enemy = createTestUnit({
        team: otherTeam(options.team),
        name: "BLOCK_CENTER enemy",
        attackType: MELEE,
        attack: 1,
        armor: 0,
        damageMin: 1,
        damageMax: 1,
        amountAlive: 10,
        maxHp: 100,
        speed: 1,
    });
    placeActor(combat, actor, options.actorBase);
    placeUnit(
        combat.grid,
        combat.unitsHolder,
        enemy,
        options.enemyBase ?? (options.team === LOWER ? { x: 15, y: 15 } : { x: 0, y: 0 }),
    );
    if (options.rangedAlly) {
        const ally = createTestUnit({
            team: options.team,
            name: "Strong allied shooter",
            attackType: RANGE,
            rangeShots: 20,
            damageMin: 20,
            damageMax: 20,
            amountAlive: 10,
            shotDistance: 30,
            speed: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, ally, options.team === LOWER ? { x: 1, y: 14 } : { x: 14, y: 1 });
    }

    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const pathHelper = new PathHelper(testGridSettings);
    const moveHandler = new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder);
    const sceneLog = new SceneLogMock();
    let activeUnitId = actor.getId();
    const engineContext = {
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler,
        sceneLog,
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => activeUnitId || undefined,
        canLandRangeAttack: (unit: Unit) =>
            combat.attackHandler.canLandRangeAttack(unit, combat.grid.getEnemyAggrMatrixByUnitId(unit.getId())),
        getCurrentEnemiesCellsWithinMovementRange: () =>
            getEnemiesCellsWithinMovementRange(actor, {
                grid: combat.grid,
                matrix: combat.grid.getMatrix(),
                unitsHolder: combat.unitsHolder,
                pathHelper,
                attackHandler: combat.attackHandler,
                fightProperties,
            }),
    };
    const engine = new GameActionEngine(engineContext);
    const turnEngine = new TurnEngine(engineContext);
    const started = engine.apply({ type: "start_fight" });
    if (!started.completed) throw new Error(`start_fight rejected: ${started.rejectionReason}`);
    while (fightProperties.getCurrentLap() < (options.lap ?? 1)) {
        fightProperties.flipLap();
    }
    fightProperties.startTurn(actor.getTeam(), 1_000);

    return {
        actor,
        enemy,
        combat,
        context: {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper,
            attackHandler: combat.attackHandler,
            fightProperties,
        },
        engine,
        turnEngine,
        fightProperties,
        pathHelper,
        getActiveUnitId: () => activeUnitId,
        setActiveUnitId: (id: string) => {
            activeUnitId = id;
        },
    };
}

function mountainDestination(side: MountainSide, team: TeamType, size: BodySize): XY {
    if (side === "left") {
        if (team === LOWER) return { x: 4, y: 6 }; // exposed west corner
        return size === "small" ? { x: 7, y: 6 } : { x: 8, y: 6 }; // corridor corner
    }
    if (team === LOWER) return size === "small" ? { x: 8, y: 9 } : { x: 8, y: 10 }; // corridor corner
    return size === "small" ? { x: 11, y: 9 } : { x: 12, y: 10 }; // exposed east corner
}

function strikeStart(side: MountainSide, team: TeamType, size: BodySize, mode: StrikeMode): XY {
    const destination = mountainDestination(side, team, size);
    if (mode === "stationary") return destination;
    return {
        x: destination.x,
        y: destination.y <= 6 ? destination.y - 3 : destination.y + 3,
    };
}

function mineCandidates(fixture: BlockFixture): IEnumeratedCandidate[] {
    return enumerateCandidates(
        fixture.actor,
        {
            ...fixture.context,
            matrix: fixture.combat.grid.getMatrix(),
        },
        [{ type: "end_turn", unitId: fixture.actor.getId(), reason: "manual" }],
        {
            includeMountainAttacks: true,
            enrichIncumbentMetadata: true,
        },
    ).candidates.filter((candidate) => candidate.kind === "mine");
}

function applyAll(engine: GameActionEngine, actions: readonly GameAction[]): void {
    for (const action of actions) {
        const result = engine.apply(action);
        expect(result.completed, `${action.type}: ${result.rejectionReason ?? "rejected"}`).toBe(true);
    }
}

function isFootprintInAttackRange(actor: Unit, actorBase: XY, target: Unit): boolean {
    return footprintAt(actor, actorBase).some((actorCell) =>
        target
            .getCells()
            .some(
                (targetCell) =>
                    Math.abs(actorCell.x - targetCell.x) <= actor.getAttackRange() &&
                    Math.abs(actorCell.y - targetCell.y) <= actor.getAttackRange(),
            ),
    );
}

/** Real weighted route length to the closest legal base from which this actor can hit this target. */
function trueAttackCellPathDistance(actor: Unit, target: Unit, grid: Grid, pathHelper: PathHelper): number {
    const base = actor.getBaseCell();
    if (isFootprintInAttackRange(actor, base, target)) return 0;
    const matrix = grid.getMatrix();
    const paths = pathHelper.getMovePath(
        base,
        matrix,
        100,
        undefined,
        actor.canFly(),
        actor.isSmallSize(),
        actor.canTraverseLava(),
        actor.hasAbilityActive("In Its Own World"),
    );
    let best = Number.POSITIVE_INFINITY;
    for (let x = 0; x < testGridSettings.getGridSize(); x += 1) {
        for (let y = 0; y < testGridSettings.getGridSize(); y += 1) {
            const candidate = { x, y };
            if (!canUnitLandAt(actor, grid, candidate) || !isFootprintInAttackRange(actor, candidate, target)) {
                continue;
            }
            for (const route of paths.knownPaths.get((x << 4) | y) ?? []) {
                best = Math.min(best, route.weight);
            }
        }
    }
    return best;
}

function directEnemyBase(side: MountainSide, team: TeamType, size: BodySize): XY {
    if (size === "small") {
        if (side === "left") return team === LOWER ? { x: 3, y: 6 } : { x: 7, y: 5 };
        return team === LOWER ? { x: 8, y: 10 } : { x: 12, y: 9 };
    }
    if (side === "left") return team === LOWER ? { x: 2, y: 5 } : { x: 9, y: 5 };
    return team === LOWER ? { x: 6, y: 10 } : { x: 13, y: 10 };
}

function makeA13Driver(fixture: BlockFixture) {
    const deps: ILookaheadDeps = {
        engine: fixture.engine,
        turnEngine: fixture.turnEngine,
        grid: fixture.combat.grid,
        unitsHolder: fixture.combat.unitsHolder,
        fightProperties: fixture.fightProperties,
        pathHelper: fixture.pathHelper,
        attackHandler: fixture.combat.attackHandler,
        strategyForTeam: () => new StrategyV0_8(),
        getActiveUnitId: fixture.getActiveUnitId,
        setActiveUnitId: fixture.setActiveUnitId,
        damageDealtThisLap: () => fixture.combat.damageStatisticHolder.has(fixture.fightProperties.getCurrentLap()),
        captureDamageStats: () => [...fixture.combat.damageStatisticHolder.get()],
        restoreDamageStats: (saved) => {
            fixture.combat.damageStatisticHolder.clear();
            for (const value of saved) fixture.combat.damageStatisticHolder.add(value);
        },
    };
    return createV08A13SearchDriver(deps, {
        seed: 0xa13b10c,
        greenVersion: "v0.8",
        redVersion: "v0.8",
    });
}

describe("v0.8 BLOCK_CENTER selection", () => {
    describe("uncapped mountain candidates complete in the real engine", () => {
        for (const side of ["left", "right"] as const) {
            for (const team of [LOWER, UPPER] as const) {
                for (const size of ["small", "large"] as const) {
                    for (const mode of ["stationary", "routed"] as const) {
                        const label = `${side} ${team === LOWER ? "LOWER" : "UPPER"} ${size} ${mode}`;
                        it(label, () => {
                            const fixture = buildBlockFixture({
                                team,
                                size: size === "small" ? SMALL : LARGE,
                                actorBase: strikeStart(side, team, size, mode),
                                speed: mode === "stationary" ? 1 : 8,
                                leftIntact: side === "left",
                                rightIntact: side === "right",
                            });
                            const beforeLeft = fixture.fightProperties.getObstacleHitsLeftLeft();
                            const beforeRight = fixture.fightProperties.getObstacleHitsLeftRight();
                            const candidates = mineCandidates(fixture);

                            expect(candidates).toHaveLength(1);
                            expect(candidates[0].targetCell!.x < 8 ? "left" : "right").toBe(side);
                            const action = candidates[0].actions.find((entry) => entry.type === "obstacle_attack");
                            expect(action).toBeDefined();
                            if (!action || action.type !== "obstacle_attack") return;
                            if (mode === "stationary") {
                                expect(action.attackFrom).toEqual(fixture.actor.getBaseCell());
                                expect(action.path).toBeUndefined();
                            } else {
                                expect(action.attackFrom).not.toEqual(fixture.actor.getBaseCell());
                                expect(action.path?.length ?? 0).toBeGreaterThan(0);
                            }

                            applyAll(fixture.engine, candidates[0].actions);
                            expect(fixture.fightProperties.getObstacleHitsLeftLeft()).toBe(
                                beforeLeft - (side === "left" ? 1 : 0),
                            );
                            expect(fixture.fightProperties.getObstacleHitsLeftRight()).toBe(
                                beforeRight - (side === "right" ? 1 : 0),
                            );
                        });
                    }
                }
            }
        }
    });

    it("honors every independent cleared-side combination", () => {
        const cases = [
            { left: true, right: true, size: SMALL, team: LOWER, base: { x: 7, y: 6 }, expected: "left" },
            { left: true, right: false, size: LARGE, team: UPPER, base: { x: 8, y: 6 }, expected: "left" },
            { left: false, right: true, size: LARGE, team: LOWER, base: { x: 8, y: 10 }, expected: "right" },
            { left: false, right: false, size: SMALL, team: UPPER, base: { x: 8, y: 9 }, expected: undefined },
        ] as const;

        for (const testCase of cases) {
            const fixture = buildBlockFixture({
                team: testCase.team,
                size: testCase.size,
                actorBase: testCase.base,
                speed: 3,
                leftIntact: testCase.left,
                rightIntact: testCase.right,
            });
            const candidates = mineCandidates(fixture);
            if (testCase.expected === undefined) {
                expect(candidates).toHaveLength(0);
                expect(fixture.combat.grid.getCenterCells(true)).toHaveLength(0);
                continue;
            }
            expect(candidates).toHaveLength(1);
            expect(candidates[0].targetCell!.x < 8 ? "left" : "right").toBe(testCase.expected);
            applyAll(fixture.engine, candidates[0].actions);
        }
    });

    describe("production StrategyV0_8 advances by true attack-cell route distance", () => {
        for (const side of ["left", "right"] as const) {
            for (const team of [LOWER, UPPER] as const) {
                for (const size of ["small", "large"] as const) {
                    for (const mode of ["stationary", "routed"] as const) {
                        const label = `${side} ${team === LOWER ? "LOWER" : "UPPER"} ${size} ${mode}`;
                        it(label, () => {
                            const fixture = buildBlockFixture({
                                team,
                                size: size === "small" ? SMALL : LARGE,
                                actorBase: strikeStart(side, team, size, mode),
                                speed: 2,
                                leftIntact: side === "left",
                                rightIntact: side === "right",
                            });
                            const before = trueAttackCellPathDistance(
                                fixture.actor,
                                fixture.enemy,
                                fixture.combat.grid,
                                fixture.pathHelper,
                            );
                            const decision = new StrategyV0_8().decideTurn(fixture.actor, {
                                ...fixture.context,
                                matrix: fixture.combat.grid.getMatrix(),
                            });

                            expect(
                                decision.some(
                                    (action) =>
                                        action.type === "obstacle_attack" ||
                                        action.type === "defend_turn" ||
                                        action.type === "end_turn",
                                ),
                            ).toBe(false);
                            expect(decision.map((action) => action.type)).toContain("move_unit");
                            applyAll(fixture.engine, decision);
                            const after = trueAttackCellPathDistance(
                                fixture.actor,
                                fixture.enemy,
                                fixture.combat.grid,
                                fixture.pathHelper,
                            );
                            expect(Number.isFinite(before)).toBe(true);
                            expect(after).toBeLessThan(before);
                        });
                    }
                }
            }
        }
    });

    describe("a direct enemy hit beats shield and mountain mining", () => {
        for (const side of ["left", "right"] as const) {
            for (const team of [LOWER, UPPER] as const) {
                for (const size of ["small", "large"] as const) {
                    const label = `${side} ${team === LOWER ? "LOWER" : "UPPER"} ${size}`;
                    it(label, () => {
                        const fixture = buildBlockFixture({
                            team,
                            size: size === "small" ? SMALL : LARGE,
                            actorBase: mountainDestination(side, team, size),
                            enemyBase: directEnemyBase(side, team, size),
                            speed: 1,
                            rangedAlly: true,
                        });
                        const mine = mineCandidates(fixture)[0];
                        expect(mine).toBeDefined();

                        for (const passive of [
                            [{ type: "defend_turn", unitId: fixture.actor.getId() }],
                            mine.actions,
                        ] as GameAction[][]) {
                            const replacement = prioritizeV08ProductiveAction(
                                fixture.actor,
                                {
                                    ...fixture.context,
                                    matrix: fixture.combat.grid.getMatrix(),
                                },
                                passive,
                            );
                            expect(replacement.some((action) => action.type === "melee_attack")).toBe(true);
                            expect(
                                replacement.some(
                                    (action) => action.type === "defend_turn" || action.type === "obstacle_attack",
                                ),
                            ).toBe(false);
                        }

                        const hpBefore = fixture.enemy.getCumulativeHp();
                        const decision = new StrategyV0_8().decideTurn(fixture.actor, {
                            ...fixture.context,
                            matrix: fixture.combat.grid.getMatrix(),
                        });
                        expect(decision.some((action) => action.type === "melee_attack")).toBe(true);
                        expect(
                            decision.some(
                                (action) =>
                                    action.type === "wait_turn" ||
                                    action.type === "defend_turn" ||
                                    action.type === "obstacle_attack",
                            ),
                        ).toBe(false);
                        applyAll(fixture.engine, decision);
                        expect(fixture.enemy.getCumulativeHp()).toBeLessThan(hpBefore);
                    });
                }
            }
        }
    });

    for (const passiveKind of ["wait", "shield", "mine"] as const) {
        it(`exact production a13 selects valid late damage over ${passiveKind}`, () => {
            const fixture = buildBlockFixture({
                team: LOWER,
                size: SMALL,
                actorBase: { x: 4, y: 7 },
                enemyBase: { x: 3, y: 7 },
                speed: 1,
                rangedAlly: true,
                lap: A13_URGENT_LAP,
            });
            const passive: GameAction[] =
                passiveKind === "wait"
                    ? [{ type: "wait_turn", unitId: fixture.actor.getId() }]
                    : passiveKind === "shield"
                      ? [{ type: "defend_turn", unitId: fixture.actor.getId() }]
                      : mineCandidates(fixture)[0].actions;
            const driver = makeA13Driver(fixture);
            expect(driver.enabled).toBe(true);
            expect(driver.appliesTo("v0.8")).toBe(true);

            const hpBefore = fixture.enemy.getCumulativeHp();
            const chosen = driver.chooseDecision(fixture.actor, "v0.8", passive);
            expect(chosen.some((action) => action.type === "melee_attack")).toBe(true);
            expect(
                chosen.some(
                    (action) =>
                        action.type === "wait_turn" ||
                        action.type === "defend_turn" ||
                        action.type === "obstacle_attack",
                ),
            ).toBe(false);
            applyAll(fixture.engine, chosen);
            expect(fixture.enemy.getCumulativeHp()).toBeLessThan(hpBefore);
        });
    }

    it("completes bounded small and large production-a13 fights without rejects or stuck turns", () => {
        const cases = [
            {
                seed: 913,
                roster: [{ faction: "Life", creatureName: "Squire", level: 1, size: 1, amount: 20 }],
            },
            {
                seed: 914,
                roster: [{ faction: "Life", creatureName: "Champion", level: 4, size: 2, amount: 3 }],
            },
        ] as const;

        for (const testCase of cases) {
            const result = runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster: testCase.roster.map((entry) => ({ ...entry })),
                seed: testCase.seed,
                gridType: BLOCK_CENTER,
                maxLaps: 12,
            });
            expect(result.endReason).toBe("elimination");
            expect((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0)).toBe(0);
            expect(result.actions.some((action) => action.actionType === "melee_attack")).toBe(true);
            expect(result.actions.some((action) => action.actionType === "obstacle_attack")).toBe(false);
        }
    });
});
