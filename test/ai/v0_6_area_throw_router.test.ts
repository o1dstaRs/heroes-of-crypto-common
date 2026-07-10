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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { routeAreaThrow } from "../../src/ai/versions/area_throw_router";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
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

function contextFor(combat: CombatTestContext): IDecisionContext {
    return {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: combat.attackHandler,
    };
}

function makeGargantuan(): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    return Unit.createUnit(
        getCreatureConfig(LOWER, "Nature", "Gargantuan", "", 100),
        testGridSettings,
        LOWER,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

function placeLarge(combat: CombatTestContext, unit: Unit, base: XY): void {
    const cells = [
        { x: base.x, y: base.y },
        { x: base.x - 1, y: base.y },
        { x: base.x, y: base.y - 1 },
        { x: base.x - 1, y: base.y - 1 },
    ];
    const position = getPositionForCells(testGridSettings, cells);
    if (!position) {
        throw new Error("Invalid large-unit test placement");
    }
    unit.setPosition(position.x, position.y);
    combat.grid.occupyCells(
        cells,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    combat.unitsHolder.addUnit(unit);
}

function withAreaThrowGate<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.V06_AREA_THROW;
    if (value === undefined) {
        delete process.env.V06_AREA_THROW;
    } else {
        process.env.V06_AREA_THROW = value;
    }
    try {
        return run();
    } finally {
        if (previous === undefined) {
            delete process.env.V06_AREA_THROW;
        } else {
            process.env.V06_AREA_THROW = previous;
        }
    }
}

const endTurn = (unit: Unit): GameAction[] => [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
const lastAction = (actions: readonly GameAction[]): GameAction => actions[actions.length - 1];
const candidatesOfKind = (candidates: readonly IEnumeratedCandidate[], kind: string): IEnumeratedCandidate[] =>
    candidates.filter((candidate) => candidate.kind === kind);

describe("v0.6 Area Throw router", () => {
    it("routes a two-target empty-cell splash when it strictly beats the incumbent shot", () => {
        const combat = createCombatTestContext();
        const gargantuan = makeGargantuan();
        const enemyA = createTestUnit({ team: UPPER, name: "A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: UPPER, name: "B", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, gargantuan, { x: 3, y: 3 });
        // The enemies are not adjacent to each other, so an ordinary splash centred on either hits one.
        // An Area Throw at the empty middle row can hit both.
        placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 10, y: 11 });
        const context = contextFor(combat);
        const all = enumerateCandidates(gargantuan, context, endTurn(gargantuan)).candidates;
        const incumbent = candidatesOfKind(all, "shot").find((candidate) => candidate.targetId === enemyA.getId());
        expect(incumbent).toBeDefined();

        const routed = withAreaThrowGate("on", () => routeAreaThrow(gargantuan, context, incumbent!.actions));
        const action = lastAction(routed);
        expect(action.type).toBe("area_throw_attack");

        const selected = candidatesOfKind(all, "area_throw").find((candidate) => {
            const candidateAction = lastAction(candidate.actions);
            return (
                action.type === "area_throw_attack" &&
                candidateAction.type === "area_throw_attack" &&
                candidateAction.targetCell.x === action.targetCell.x &&
                candidateAction.targetCell.y === action.targetCell.y
            );
        });
        expect(selected).toBeDefined();
        expect(selected!.features.expectedDamage).toBeGreaterThan(incumbent!.features.expectedDamage);
    });

    it("uses net effective damage, so a friendly stack in the shared splash prevents a tie override", () => {
        const combat = createCombatTestContext();
        const gargantuan = makeGargantuan();
        const enemyA = createTestUnit({ team: UPPER, name: "A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: UPPER, name: "B", attackType: MELEE, amountAlive: 20 });
        const isolated = createTestUnit({ team: UPPER, name: "Isolated", attackType: MELEE, amountAlive: 20 });
        const ally = createTestUnit({ team: LOWER, name: "Ally", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, gargantuan, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 10, y: 11 });
        placeUnit(combat.grid, combat.unitsHolder, ally, { x: 10, y: 10 });
        placeUnit(combat.grid, combat.unitsHolder, isolated, { x: 14, y: 3 });
        const context = contextFor(combat);
        const all = enumerateCandidates(gargantuan, context, endTurn(gargantuan)).candidates;
        const incumbent = candidatesOfKind(all, "shot").find((candidate) => candidate.targetId === isolated.getId());
        expect(incumbent).toBeDefined();

        const bestThrowDamage = Math.max(
            ...candidatesOfKind(all, "area_throw").map((candidate) => candidate.features.expectedDamage),
        );
        expect(bestThrowDamage).toBeLessThanOrEqual(incumbent!.features.expectedDamage);
        const routed = withAreaThrowGate("on", () => routeAreaThrow(gargantuan, context, incumbent!.actions));
        expect(routed).toBe(incumbent!.actions);
    });

    it("scores an occluded aim at its trajectory interceptor rather than the distant cluster", () => {
        const combat = createCombatTestContext();
        const gargantuan = makeGargantuan();
        const enemyA = createTestUnit({ team: UPPER, name: "A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: UPPER, name: "B", attackType: MELEE, amountAlive: 20 });
        const blocker = createTestUnit({ team: UPPER, name: "Blocker", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, gargantuan, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 10, y: 11 });
        placeUnit(combat.grid, combat.unitsHolder, blocker, { x: 6, y: 6 });
        const context = contextFor(combat);
        const all = enumerateCandidates(gargantuan, context, endTurn(gargantuan)).candidates;
        const occluded = candidatesOfKind(all, "area_throw").find(
            (candidate) => candidate.targetCell?.x === 10 && candidate.targetCell.y === 10,
        );
        const incumbent = candidatesOfKind(all, "shot").find((candidate) => candidate.targetId === blocker.getId());
        expect(occluded).toBeDefined();
        expect(incumbent).toBeDefined();
        // If F4 naively scored the aimed cluster, this would be roughly double the one-stack incumbent.
        expect(occluded!.features.expectedDamage).toBeLessThanOrEqual(incumbent!.features.expectedDamage);

        const routed = withAreaThrowGate("on", () => routeAreaThrow(gargantuan, context, incumbent!.actions));
        const action = lastAction(routed);
        if (action.type === "area_throw_attack") {
            expect(action.targetCell).not.toEqual({ x: 10, y: 10 });
        }
    });

    it("is byte-parity inert gate-off: same array reference and no candidate enumeration", () => {
        const gargantuan = makeGargantuan();
        const incumbent = endTurn(gargantuan);
        let enumerations = 0;
        const enumerate = () => {
            enumerations += 1;
            return { candidates: [], truncated: [] };
        };

        const routed = withAreaThrowGate(undefined, () =>
            routeAreaThrow(gargantuan, {} as IDecisionContext, incumbent, enumerate),
        );
        expect(routed).toBe(incumbent);
        expect(enumerations).toBe(0);
    });
});
