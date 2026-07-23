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

import {
    AIActionType,
    captureAITargetMemory,
    findTarget,
    setPreferAttackOverMining,
    type BasicAIAction,
} from "../../src/ai/ai";
import {
    createDecisionPathCatalog,
    DecisionPathCatalog,
    type IDecisionPathSource,
} from "../../src/ai/decision_path_catalog";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import type { IReadonlyKnownPaths } from "../../src/grid/path_definitions";
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

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const SMALL = PBTypes.UnitSizeVals.SMALL;
const LARGE = PBTypes.UnitSizeVals.LARGE;

interface IFixture {
    actor: Unit;
    combat: CombatTestContext;
    matrix: number[][];
    target: Unit;
}

function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
}

function makeFixture(
    gridType: Parameters<typeof createCombatTestContext>[0],
    size: typeof SMALL | typeof LARGE,
    actorCell: XY,
    targetCell: XY,
    speed = 3.3,
): IFixture {
    const combat = createCombatTestContext(gridType);
    const actor = createTestUnit({ team: LOWER, name: "Layer Actor", attackType: MELEE, size, speed });
    const target = createTestUnit({ team: UPPER, name: "Layer Target", attackType: MELEE, speed: 1 });
    placeUnit(combat.grid, combat.unitsHolder, actor, actorCell);
    placeUnit(combat.grid, combat.unitsHolder, target, targetCell);
    return { actor, combat, matrix: combat.grid.getMatrix(), target };
}

function eagerCatalogSource(fixture: IFixture): {
    catalog: DecisionPathCatalog;
    source: IDecisionPathSource;
} {
    const catalog = createDecisionPathCatalog(
        fixture.combat.grid,
        new PathHelper(testGridSettings),
        fixture.actor,
        fixture.matrix,
    );
    return {
        catalog,
        source: {
            getMovePath: (...args) => catalog.getMovePath(...args),
        },
    };
}

function firstLayerCatalogSource(fixture: IFixture): {
    catalog: DecisionPathCatalog;
    source: IDecisionPathSource;
} {
    const catalog = createDecisionPathCatalog(
        fixture.combat.grid,
        new PathHelper(testGridSettings),
        fixture.actor,
        fixture.matrix,
    );
    return { catalog, source: catalog };
}

function knownPathsValue(paths: IReadonlyKnownPaths): unknown {
    return [...paths.entries()]
        .sort(([left], [right]) => left - right)
        .map(([key, routes]) => [
            key,
            routes.map(({ cell, route, weight }) => ({
                cell: { ...cell },
                route: route.map((point) => ({ ...point })),
                weight,
            })),
        ]);
}

function actionValue(action: BasicAIAction | undefined): unknown {
    if (!action) return null;
    return {
        type: action.actionType(),
        move: action.cellToMove(),
        attack: action.cellToAttack(),
        knownPaths: knownPathsValue(action.currentActiveKnownPaths()),
    };
}

function runDecision(
    fixture: IFixture,
    source: IDecisionPathSource,
    seed: number,
): {
    action: BasicAIAction | undefined;
    rngTail: number[];
} {
    setDeterministicRandomSource(makeRng(seed));
    const action = findTarget(fixture.actor, fixture.combat.grid, fixture.matrix, fixture.combat.unitsHolder, source);
    return {
        action,
        rngTail: [getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000), getRandomInt(0, 1_000_000)],
    };
}

afterEach(() => {
    setDeterministicRandomSource(undefined);
    setPreferAttackOverMining(false);
});

describe("guarded first melee layer in findTarget", () => {
    it("preserves actions, complete path values, target memory, and RNG on every production map", () => {
        setPreferAttackOverMining(true);
        const cases = [
            {
                grid: PBTypes.GridVals.NORMAL,
                size: SMALL,
                from: { x: 5, y: 5 },
                to: { x: 8, y: 5 },
                speed: 4.2,
            },
            {
                grid: PBTypes.GridVals.NORMAL,
                size: LARGE,
                from: { x: 4, y: 4 },
                to: { x: 8, y: 4 },
                speed: 4.2,
            },
            { grid: PBTypes.GridVals.NORMAL, size: SMALL, from: { x: 2, y: 2 }, to: { x: 12, y: 12 } },
            { grid: PBTypes.GridVals.NORMAL, size: LARGE, from: { x: 3, y: 3 }, to: { x: 12, y: 11 } },
            { grid: PBTypes.GridVals.WATER_CENTER, size: SMALL, from: { x: 3, y: 7 }, to: { x: 12, y: 8 } },
            { grid: PBTypes.GridVals.WATER_CENTER, size: LARGE, from: { x: 3, y: 6 }, to: { x: 12, y: 9 } },
            { grid: PBTypes.GridVals.LAVA_CENTER, size: SMALL, from: { x: 3, y: 7 }, to: { x: 12, y: 8 } },
            { grid: PBTypes.GridVals.LAVA_CENTER, size: LARGE, from: { x: 3, y: 6 }, to: { x: 12, y: 9 } },
            { grid: PBTypes.GridVals.BLOCK_CENTER, size: SMALL, from: { x: 3, y: 7 }, to: { x: 12, y: 8 } },
            { grid: PBTypes.GridVals.BLOCK_CENTER, size: LARGE, from: { x: 3, y: 6 }, to: { x: 12, y: 9 } },
        ] as const;

        for (const [index, testCase] of cases.entries()) {
            const eagerFixture = makeFixture(
                testCase.grid,
                testCase.size,
                testCase.from,
                testCase.to,
                "speed" in testCase ? testCase.speed : 2.2 + (index % 3),
            );
            const firstFixture = makeFixture(
                testCase.grid,
                testCase.size,
                testCase.from,
                testCase.to,
                "speed" in testCase ? testCase.speed : 2.2 + (index % 3),
            );
            const eager = eagerCatalogSource(eagerFixture);
            const first = firstLayerCatalogSource(firstFixture);

            expect(
                DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                    eager.source,
                    eagerFixture.combat.grid,
                    eagerFixture.actor,
                    eagerFixture.matrix,
                ),
            ).toBe(false);
            expect(
                DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                    first.source,
                    firstFixture.combat.grid,
                    firstFixture.actor,
                    firstFixture.matrix,
                ),
            ).toBe(true);

            const eagerResult = runDecision(eagerFixture, eager.source, 0xa13_1000 + index);
            const firstResult = runDecision(firstFixture, first.source, 0xa13_1000 + index);
            expect(actionValue(firstResult.action)).toEqual(actionValue(eagerResult.action));
            expect(firstResult.rngTail).toEqual(eagerResult.rngTail);

            const eagerMemory = [...captureAITargetMemory(eagerFixture.combat.unitsHolder).values()];
            const firstMemory = [...captureAITargetMemory(firstFixture.combat.unitsHolder).values()];
            expect(eagerMemory.map((id) => id === eagerFixture.target.getId())).toEqual(
                firstMemory.map((id) => id === firstFixture.target.getId()),
            );
            if ("speed" in testCase) {
                expect(eagerMemory).toEqual([eagerFixture.target.getId()]);
                expect(firstMemory).toEqual([firstFixture.target.getId()]);
            }
        }
    });

    it("keeps the finite-path search eager so a deeper reachable layer yields a legal move", () => {
        setPreferAttackOverMining(true);
        const fixture = makeFixture(PBTypes.GridVals.NORMAL, SMALL, { x: 3, y: 3 }, { x: 11, y: 11 }, 1);
        const { catalog } = firstLayerCatalogSource(fixture);

        const result = runDecision(fixture, catalog, 0xa13_f17e);
        expect(result.action?.actionType()).toBe(AIActionType.MOVE);
        const endpoint = result.action?.cellToMove();
        expect(endpoint).toBeDefined();
        const endpointKey = (endpoint!.x << 4) | endpoint!.y;
        expect(result.action!.currentActiveKnownPaths().has(endpointKey)).toBe(true);
    });

    it("falls back to the eager trace when Unit footprint geometry is stateful", () => {
        const eagerFixture = makeFixture(PBTypes.GridVals.NORMAL, SMALL, { x: 4, y: 4 }, { x: 11, y: 11 }, 3.3);
        const guardedFixture = makeFixture(PBTypes.GridVals.NORMAL, SMALL, { x: 4, y: 4 }, { x: 11, y: 11 }, 3.3);
        let eagerGetCellsCalls = 0;
        let guardedGetCellsCalls = 0;
        eagerFixture.actor.getCells = () => {
            eagerGetCellsCalls++;
            return Unit.prototype.getCells.call(eagerFixture.actor);
        };
        guardedFixture.actor.getCells = () => {
            guardedGetCellsCalls++;
            return Unit.prototype.getCells.call(guardedFixture.actor);
        };
        const eager = eagerCatalogSource(eagerFixture);
        const guarded = firstLayerCatalogSource(guardedFixture);

        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                guarded.catalog,
                guardedFixture.combat.grid,
                guardedFixture.actor,
                guardedFixture.matrix,
            ),
        ).toBe(false);
        const eagerResult = runDecision(eagerFixture, eager.source, 0xa13_fa11);
        const guardedResult = runDecision(guardedFixture, guarded.source, 0xa13_fa11);
        expect(actionValue(guardedResult.action)).toEqual(actionValue(eagerResult.action));
        expect(guardedResult.rngTail).toEqual(eagerResult.rngTail);
        expect(guardedGetCellsCalls).toBe(eagerGetCellsCalls);
        expect(guardedGetCellsCalls).toBeGreaterThan(0);
    });
});
