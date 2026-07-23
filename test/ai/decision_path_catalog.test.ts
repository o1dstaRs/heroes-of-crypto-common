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

import { afterEach, describe, expect, it } from "bun:test";

import type { IDecisionContext } from "../../src/ai";
import { AIActionType, BasicAIAction } from "../../src/ai/ai";
import { enumerateCandidates } from "../../src/ai/candidates";
import {
    createDecisionPathCatalog,
    DecisionPathCatalog,
    type IDecisionPathSource,
} from "../../src/ai/decision_path_catalog";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import { getRandomInt, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import {
    createCombatTestContext,
    createTestUnit,
    placeUnit,
    testGridSettings,
    type CombatTestContext,
} from "../helpers/combat";

type MoveArgs = Parameters<PathHelper["getMovePath"]>;

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;

function makeRng(seed: number, onDraw?: () => void): () => number {
    let state = seed >>> 0;
    return () => {
        onDraw?.();
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function canonicalArgs(combat: CombatTestContext, unit: Unit, matrix: number[][]): MoveArgs {
    const enemyTeam = unit.getTeam() === LOWER ? UPPER : LOWER;
    return [
        { ...unit.getBaseCell() },
        matrix,
        unit.getSteps(),
        combat.grid.getAggrMatrixByTeam(enemyTeam),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
    ];
}

function rngTail(): number[] {
    return [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)];
}

function placeCanonicalPair(speed = 4.2): {
    combat: CombatTestContext;
    unit: Unit;
    enemy: Unit;
    matrix: number[][];
} {
    const combat = createCombatTestContext();
    const unit = createTestUnit({ team: LOWER, name: "Path Actor", attackType: MELEE, speed });
    const enemy = createTestUnit({ team: UPPER, name: "Path Target", attackType: MELEE });
    placeUnit(combat.grid, combat.unitsHolder, unit, { x: 8, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 11, y: 11 });
    return { combat, unit, enemy, matrix: combat.grid.getMatrix() };
}

afterEach(() => {
    setDeterministicRandomSource(undefined);
});

describe("decision-scoped path catalog", () => {
    it("preserves canonical values and RNG while public PathHelper results remain freshly owned", () => {
        const { combat, unit, matrix } = placeCanonicalPair();
        const delegate = new PathHelper(testGridSettings);
        const args = canonicalArgs(combat, unit, matrix);

        const directA = delegate.getMovePath(...args);
        const directB = delegate.getMovePath(...args);
        expect(directB).toEqual(directA);
        expect(directB).not.toBe(directA);
        expect(directB.cells).not.toBe(directA.cells);
        expect(directB.hashes).not.toBe(directA.hashes);
        expect(directB.knownPaths).not.toBe(directA.knownPaths);

        const catalog = createDecisionPathCatalog(combat.grid, delegate, unit, matrix, true);
        const callerCell = { ...args[0] };
        const cachedA = catalog.getMovePath(callerCell, args[1], args[2], args[3], args[4], args[5], args[6]);
        const cachedB = catalog.getMovePath(...args);
        expect(cachedB).toBe(cachedA);
        expect(cachedA).toEqual(directA);
        expect(catalog.getStats()).toEqual({ requests: 2, hits: 1, misses: 1, bypasses: 0 });

        const sharedRoute = [...cachedA.knownPaths.values()].find((routes) => routes[0])![0];
        callerCell.x = 99;
        callerCell.y = 99;
        expect(sharedRoute.route[0]).toEqual(args[0]);
        const action = new BasicAIAction(AIActionType.MOVE, sharedRoute.cell, undefined, cachedA.knownPaths);
        const sharedX = sharedRoute.cell.x;
        action.cellToMove()!.x = 99;
        expect(sharedRoute.cell.x).toBe(sharedX);

        let directDraws = 0;
        setDeterministicRandomSource(makeRng(0xa13c_ace, () => directDraws++));
        delegate.getMovePath(...args);
        delegate.getMovePath(...args);
        expect(directDraws).toBe(0);
        const directTail = rngTail();

        let catalogDraws = 0;
        setDeterministicRandomSource(makeRng(0xa13c_ace, () => catalogDraws++));
        const freshCatalog = createDecisionPathCatalog(combat.grid, delegate, unit, matrix);
        freshCatalog.getMovePath(...args);
        freshCatalog.getMovePath(...args);
        expect(catalogDraws).toBe(0);
        expect(rngTail()).toEqual(directTail);

        const publicAfterCatalog = delegate.getMovePath(...args);
        expect(publicAfterCatalog).toEqual(directA);
        expect(publicAfterCatalog).not.toBe(directA);
        expect(publicAfterCatalog.cells).not.toBe(directA.cells);
        expect(publicAfterCatalog.hashes).not.toBe(directA.hashes);
        expect(publicAfterCatalog.knownPaths).not.toBe(directA.knownPaths);
    });

    it("matches direct canonical traversal across 4,096 deterministic dense boards", () => {
        const { combat, unit } = placeCanonicalPair();
        const delegate = new PathHelper(testGridSettings);
        let state = 0x0a13_d0da;
        let rawDraws = 0;
        setDeterministicRandomSource(() => {
            rawDraws++;
            return 0.37;
        });

        for (let iteration = 0; iteration < 4_096; iteration++) {
            const matrix = Array.from({ length: 16 }, () =>
                Array.from({ length: 16 }, () => {
                    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
                    const sample = state & 0xff;
                    return sample < 28 ? -1 : sample < 52 ? UPPER : 0;
                }),
            );
            const current = unit.getBaseCell();
            matrix[current.x][current.y] = 0;
            const args = canonicalArgs(combat, unit, matrix);
            const direct = delegate.getMovePath(...args);
            const catalog = createDecisionPathCatalog(combat.grid, delegate, unit, matrix, true);
            const miss = catalog.getMovePath(...args);
            const hit = catalog.getMovePath(...args);

            expect(miss).toEqual(direct);
            expect(hit).toBe(miss);
            expect(catalog.getStats()).toEqual({ requests: 2, hits: 1, misses: 1, bypasses: 0 });
        }
        expect(rawDraws).toBe(0);
    });

    it("bypasses noncanonical inputs and keeps their fresh-result ownership", () => {
        const { combat, unit, matrix } = placeCanonicalPair(3.3);
        const delegate = new PathHelper(testGridSettings);
        const catalog = createDecisionPathCatalog(combat.grid, delegate, unit, matrix, true);
        const [cell, , steps, aggression, canFly, isSmall, canTraverseLava] = canonicalArgs(combat, unit, matrix);
        const copiedMatrix = matrix.map((column) => [...column]);
        const copiedAggression = aggression?.map((column) => [...column]);
        const variants: MoveArgs[] = [
            [{ ...cell }, copiedMatrix, steps, aggression, canFly, isSmall, canTraverseLava],
            [{ ...cell }, matrix, steps, copiedAggression, canFly, isSmall, canTraverseLava],
            [{ x: cell.x - 1, y: cell.y }, matrix, steps, aggression, canFly, isSmall, canTraverseLava],
            [{ ...cell }, matrix, steps + 1, aggression, canFly, isSmall, canTraverseLava],
            [{ ...cell }, matrix, steps, aggression, !canFly, isSmall, canTraverseLava],
            [{ ...cell }, matrix, steps, aggression, canFly, !isSmall, canTraverseLava],
            [{ ...cell }, matrix, steps, aggression, canFly, isSmall, !canTraverseLava],
        ];

        for (const variant of variants) {
            const first = catalog.getMovePath(...variant);
            const second = catalog.getMovePath(...variant);
            expect(second).toEqual(first);
            expect(second).not.toBe(first);
            expect(second.cells).not.toBe(first.cells);
            expect(second.hashes).not.toBe(first.hashes);
            expect(second.knownPaths).not.toBe(first.knownPaths);
        }
        expect(catalog.getStats()).toEqual({
            requests: variants.length * 2,
            hits: 0,
            misses: 0,
            bypasses: variants.length * 2,
        });
    });

    it("fails closed for custom colliding neighbors and preserves their RNG draws", () => {
        class CollidingPathHelper extends PathHelper {
            private neighborCalls = 0;
            public override getMovePath(...args: MoveArgs): ReturnType<PathHelper["getMovePath"]> {
                this.neighborCalls = 0;
                return super.getMovePath(...args);
            }
            public override getNeighborCells(): XY[] {
                if (this.neighborCalls++ !== 0) {
                    return [];
                }
                return [
                    { x: 2, y: 2 },
                    { x: 0, y: 16 },
                    { x: 1, y: 0 },
                    { x: 1, y: 16 },
                    { x: 1, y: 0 },
                    { x: 1, y: 0 },
                ];
            }
        }

        const combat = createCombatTestContext();
        const unit = createTestUnit({ team: LOWER, name: "Collision Actor", attackType: MELEE, speed: 20 });
        placeUnit(combat.grid, combat.unitsHolder, unit, { x: 8, y: 8 });
        const occupancy = Array.from({ length: 16 }, () => Array<number>(17).fill(0));
        const aggression = combat.grid.getAggrMatrixByTeam(UPPER)!;
        for (const column of aggression) {
            column.push(1);
        }
        const diagonal = PathHelper.DIAGONAL_MOVE_COST;
        aggression[2][2] = 2;
        aggression[0][16] = 3 / diagonal;
        aggression[1][0] = 1 / diagonal;
        aggression[1][16] = 2 / diagonal;

        const delegate = new CollidingPathHelper(testGridSettings);
        const catalog = createDecisionPathCatalog(combat.grid, delegate, unit, occupancy, true);
        const args = canonicalArgs(combat, unit, occupancy);
        let rawDraws = 0;
        setDeterministicRandomSource(() => {
            rawDraws++;
            return 0.37;
        });
        const first = catalog.getMovePath(...args);
        const second = catalog.getMovePath(...args);

        expect(rawDraws).toBe(4);
        expect(second).not.toBe(first);
        expect(second).toEqual(first);
        expect(first.knownPaths.get(16)?.map(({ weight }) => weight)).toEqual([3, 1, 1, 1, 2, 1, 1]);
        expect(catalog.getStats()).toEqual({ requests: 2, hits: 0, misses: 0, bypasses: 2 });
    });

    it("fails closed when a base helper's private result filter is monkeypatched", () => {
        const { combat, unit, matrix } = placeCanonicalPair();
        const delegate = new PathHelper(testGridSettings);
        const mutableDelegate = delegate as unknown as {
            filterUnallowedDestinations: (...args: unknown[]) => unknown;
        };
        const baseFilter = (
            PathHelper.prototype as unknown as {
                filterUnallowedDestinations: (...args: unknown[]) => unknown;
            }
        ).filterUnallowedDestinations;
        let filterCalls = 0;
        mutableDelegate.filterUnallowedDestinations = function (...args: unknown[]): unknown {
            filterCalls++;
            return Reflect.apply(baseFilter, this, args);
        };
        const catalog = createDecisionPathCatalog(combat.grid, delegate, unit, matrix, true);
        const args = canonicalArgs(combat, unit, matrix);

        const first = catalog.getMovePath(...args);
        const second = catalog.getMovePath(...args);

        expect(filterCalls).toBe(2);
        expect(second).toEqual(first);
        expect(second).not.toBe(first);
        expect(catalog.getStats()).toEqual({ requests: 2, hits: 0, misses: 0, bypasses: 2 });
    });

    it("authorizes first-layer elision only for the exact cache-safe catalog epoch", () => {
        const { combat, unit, matrix } = placeCanonicalPair();
        const delegate = new PathHelper(testGridSettings);
        const catalog = createDecisionPathCatalog(combat.grid, delegate, unit, matrix);

        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(catalog, combat.grid, unit, matrix)).toBe(true);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                catalog,
                combat.grid,
                unit,
                matrix.map((row) => [...row]),
            ),
        ).toBe(false);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(catalog, createCombatTestContext().grid, unit, matrix),
        ).toBe(false);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                catalog,
                combat.grid,
                createTestUnit({ team: LOWER }),
                matrix,
            ),
        ).toBe(false);
        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(delegate, combat.grid, unit, matrix)).toBe(false);

        class CustomPathHelper extends PathHelper {}
        const customCatalog = createDecisionPathCatalog(
            combat.grid,
            new CustomPathHelper(testGridSettings),
            unit,
            matrix,
        );
        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(customCatalog, combat.grid, unit, matrix)).toBe(false);

        const nonProductionMatrix = Array.from({ length: 15 }, () => Array<number>(15).fill(0));
        const nonProductionCatalog = createDecisionPathCatalog(
            combat.grid,
            new PathHelper(testGridSettings),
            unit,
            nonProductionMatrix,
        );
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                nonProductionCatalog,
                combat.grid,
                unit,
                nonProductionMatrix,
            ),
        ).toBe(false);
    });

    it("fails closed for structural copies, proxy catalogs, invalid runtime sources, and overridden Unit geometry", () => {
        const { combat, unit, matrix } = placeCanonicalPair();
        const catalog = createDecisionPathCatalog(combat.grid, new PathHelper(testGridSettings), unit, matrix);
        const structuralCopy = {
            getMovePath: catalog.getMovePath.bind(catalog),
        } as IDecisionPathSource;
        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(structuralCopy, combat.grid, unit, matrix)).toBe(
            false,
        );

        let proxyTraps = 0;
        const proxyCatalog = new Proxy(catalog, {
            get(target, property, receiver): unknown {
                proxyTraps++;
                return Reflect.get(target, property, receiver);
            },
            getPrototypeOf(target): object | null {
                proxyTraps++;
                return Reflect.getPrototypeOf(target);
            },
            has(target, property): boolean {
                proxyTraps++;
                return Reflect.has(target, property);
            },
        });
        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(proxyCatalog, combat.grid, unit, matrix)).toBe(false);
        expect(proxyTraps).toBe(0);

        let revokedProxyTraps = 0;
        const revokedCatalog = Proxy.revocable(catalog, {
            get(target, property, receiver): unknown {
                revokedProxyTraps++;
                return Reflect.get(target, property, receiver);
            },
            getPrototypeOf(target): object | null {
                revokedProxyTraps++;
                return Reflect.getPrototypeOf(target);
            },
            has(target, property): boolean {
                revokedProxyTraps++;
                return Reflect.has(target, property);
            },
        });
        revokedCatalog.revoke();
        let revokedResult: boolean | undefined;
        expect(() => {
            revokedResult = DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                revokedCatalog.proxy,
                combat.grid,
                unit,
                matrix,
            );
        }).not.toThrow();
        expect(revokedResult).toBe(false);
        expect(revokedProxyTraps).toBe(0);

        for (const invalidSource of [null, undefined, false, 0, "catalog", Symbol("catalog")]) {
            expect(
                DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                    invalidSource as unknown as IDecisionPathSource,
                    combat.grid,
                    unit,
                    matrix,
                ),
            ).toBe(false);
        }

        setDeterministicRandomSource(makeRng(0xa13_e11d));
        const expectedTail = rngTail();
        setDeterministicRandomSource(makeRng(0xa13_e11d));
        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(catalog, combat.grid, unit, matrix)).toBe(true);
        expect(DecisionPathCatalog.canElideUnconsumedMeleeLayers(proxyCatalog, combat.grid, unit, matrix)).toBe(false);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                null as unknown as IDecisionPathSource,
                combat.grid,
                unit,
                matrix,
            ),
        ).toBe(false);
        expect(rngTail()).toEqual(expectedTail);

        const overriddenCells = placeCanonicalPair();
        const cellsCatalog = createDecisionPathCatalog(
            overriddenCells.combat.grid,
            new PathHelper(testGridSettings),
            overriddenCells.unit,
            overriddenCells.matrix,
        );
        overriddenCells.unit.getCells = () => Unit.prototype.getCells.call(overriddenCells.unit);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                cellsCatalog,
                overriddenCells.combat.grid,
                overriddenCells.unit,
                overriddenCells.matrix,
            ),
        ).toBe(false);

        const overriddenSize = placeCanonicalPair();
        const sizeCatalog = createDecisionPathCatalog(
            overriddenSize.combat.grid,
            new PathHelper(testGridSettings),
            overriddenSize.unit,
            overriddenSize.matrix,
        );
        overriddenSize.unit.isSmallSize = () => Unit.prototype.isSmallSize.call(overriddenSize.unit);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                sizeCatalog,
                overriddenSize.combat.grid,
                overriddenSize.unit,
                overriddenSize.matrix,
            ),
        ).toBe(false);

        const overriddenPosition = placeCanonicalPair();
        const positionCatalog = createDecisionPathCatalog(
            overriddenPosition.combat.grid,
            new PathHelper(testGridSettings),
            overriddenPosition.unit,
            overriddenPosition.matrix,
        );
        overriddenPosition.unit.getPosition = () => Unit.prototype.getPosition.call(overriddenPosition.unit);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                positionCatalog,
                overriddenPosition.combat.grid,
                overriddenPosition.unit,
                overriddenPosition.matrix,
            ),
        ).toBe(false);
    });

    it("keeps full root candidate order, metadata, identity, and RNG exact across the one-shot handoff", () => {
        const combat = createCombatTestContext();
        const actor = createTestUnit({
            team: LOWER,
            name: "Candidate Actor",
            attackType: MELEE,
            speed: 4.2,
            amountAlive: 5,
        });
        const adjacent = createTestUnit({ team: UPPER, name: "Adjacent Target", attackType: MELEE, amountAlive: 3 });
        const distant = createTestUnit({ team: UPPER, name: "Distant Target", attackType: MELEE, amountAlive: 4 });
        const blocker = createTestUnit({ team: LOWER, name: "Friendly Blocker", attackType: MELEE });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, adjacent, { x: 5, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, distant, { x: 10, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, blocker, { x: 7, y: 5 });
        const matrix = combat.grid.getMatrix();
        const incumbent: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: actor.getId(),
                targetId: adjacent.getId(),
                attackFrom: { x: 5, y: 5 },
            },
        ];
        const options = {
            enrichIncumbentMetadata: true,
            preserveAttackTargetCoverage: true,
        } as const;
        const directHelper = new PathHelper(testGridSettings);
        const directContext: IDecisionContext = {
            grid: combat.grid,
            matrix,
            unitsHolder: combat.unitsHolder,
            pathHelper: directHelper,
            attackHandler: combat.attackHandler,
        };

        setDeterministicRandomSource(makeRng(0xa13c_0de));
        directHelper.getMovePath(...canonicalArgs(combat, actor, matrix));
        const directSet = enumerateCandidates(actor, directContext, incumbent, options);
        const directTail = rngTail();

        setDeterministicRandomSource(makeRng(0xa13c_0de));
        const catalogHelper = new PathHelper(testGridSettings);
        const catalog = createDecisionPathCatalog(combat.grid, catalogHelper, actor, matrix, true);
        catalog.getMovePath(...canonicalArgs(combat, actor, matrix));
        expect(catalog.claimRootShare(new PathHelper(testGridSettings), actor, matrix)).toBe(false);
        expect(catalog.claimRootShare(catalogHelper, actor, combat.grid.getMatrix())).toBe(false);
        expect(catalog.claimRootShare(catalogHelper, blocker, matrix)).toBe(false);
        expect(catalog.claimRootShare(catalogHelper, actor, matrix)).toBe(true);
        const catalogSet = enumerateCandidates(
            actor,
            { ...directContext, pathHelper: catalogHelper, decisionPathCatalog: catalog },
            incumbent,
            options,
        );
        expect(catalog.claimRootShare(catalogHelper, actor, matrix)).toBe(false);
        const catalogTail = rngTail();

        expect(catalogSet).toEqual(directSet);
        expect(directSet.candidates[0].actions).toBe(incumbent);
        expect(catalogSet.candidates[0].actions).toBe(incumbent);
        expect(catalogSet.candidates.length).toBeGreaterThan(10);
        expect(catalogSet.candidates.map(({ kind }) => kind)).toEqual(
            expect.arrayContaining(["incumbent", "defend", "melee", "move"]),
        );
        expect(catalogSet.candidates[0].targetId).toBe(adjacent.getId());
        expect(catalogSet.candidates[0].standCell).toEqual({ x: 5, y: 5 });
        expect(catalogSet.candidates[0].features.expectedDamage).toBeGreaterThan(0);
        expect(catalogTail).toEqual(directTail);
        expect(catalog.getStats()).toEqual({ requests: 2, hits: 1, misses: 1, bypasses: 0 });
    });
});
