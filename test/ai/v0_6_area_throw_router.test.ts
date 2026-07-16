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
import { StrategyV0_6 } from "../../src/ai/versions/v0_6";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCells } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
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

function makeGargantuan(team = LOWER): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    return Unit.createUnit(
        getCreatureConfig(team, "Nature", "Gargantuan", "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        false,
    );
}

function activateEngine(combat: CombatTestContext, active: Unit): GameActionEngine {
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();
    fightProperties.setTeamUnitsAlive(LOWER, combat.unitsHolder.getAllAllies(LOWER).length);
    fightProperties.setTeamUnitsAlive(UPPER, combat.unitsHolder.getAllAllies(UPPER).length);
    fightProperties.startTurn(active.getTeam(), 1_000);
    return new GameActionEngine({
        fightProperties,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler: combat.attackHandler,
        getCurrentActiveUnitId: () => active.getId(),
    });
}

function expectActionsToApply(engine: GameActionEngine, actions: readonly GameAction[]): void {
    for (const action of actions) {
        const result = engine.apply(action);
        expect(result.completed, `${action.type}: ${result.rejectionReason ?? "rejected"}`).toBe(true);
    }
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
    it("StrategyV0_6 routes a two-target empty-cell splash only when the gate is on", () => {
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
        const strategy = new StrategyV0_6();
        const incumbentActions = withAreaThrowGate(undefined, () => strategy.decideTurn(gargantuan, context));
        const incumbentAction = lastAction(incumbentActions);
        expect(incumbentAction.type).toBe("range_attack");
        const incumbent = candidatesOfKind(all, "shot").find(
            (candidate) => candidate.targetId === (incumbentAction.type === "range_attack" && incumbentAction.targetId),
        );
        expect(incumbent).toBeDefined();

        const routed = withAreaThrowGate("on", () => strategy.decideTurn(gargantuan, context));
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
        expectActionsToApply(activateEngine(combat, gargantuan), routed);
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

    it("never routes an Area Throw whose engine primary hit violates a forced target", () => {
        const combat = createCombatTestContext();
        const gargantuan = makeGargantuan();
        const forced = createTestUnit({ team: UPPER, name: "Forced", attackType: MELEE, amountAlive: 20 });
        const clusterA = createTestUnit({ team: UPPER, name: "Cluster A", attackType: MELEE, amountAlive: 20 });
        const clusterB = createTestUnit({ team: UPPER, name: "Cluster B", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, gargantuan, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, forced, { x: 14, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, clusterA, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, clusterB, { x: 10, y: 11 });
        gargantuan.setTarget(forced.getId());
        const context = contextFor(combat);
        const all = enumerateCandidates(gargantuan, context, endTurn(gargantuan)).candidates;
        const incumbent = candidatesOfKind(all, "shot").find((candidate) => candidate.targetId === forced.getId());
        expect(incumbent).toBeDefined();
        expect(candidatesOfKind(all, "area_throw").every((candidate) => candidate.targetId === forced.getId())).toBe(
            true,
        );

        const routed = withAreaThrowGate("on", () => routeAreaThrow(gargantuan, context, incumbent!.actions));
        const routedAttack = lastAction(routed);
        if (routedAttack.type === "area_throw_attack") {
            const routedCandidate = candidatesOfKind(all, "area_throw").find(
                (candidate) =>
                    candidate.targetCell?.x === routedAttack.targetCell.x &&
                    candidate.targetCell.y === routedAttack.targetCell.y,
            );
            expect(routedCandidate?.targetId).toBe(forced.getId());
        } else {
            expect(routedAttack.type).toBe("range_attack");
        }
        expectActionsToApply(activateEngine(combat, gargantuan), routed);
    });

    it("supports both-seat and green/red seat-scoped gates", () => {
        const setup = (team: number) => {
            const combat = createCombatTestContext();
            const gargantuan = makeGargantuan(team);
            const enemyTeam = team === LOWER ? UPPER : LOWER;
            const enemyA = createTestUnit({ team: enemyTeam, attackType: MELEE, amountAlive: 20 });
            const enemyB = createTestUnit({ team: enemyTeam, attackType: MELEE, amountAlive: 20 });
            placeLarge(combat, gargantuan, { x: 3, y: 3 });
            placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 9 });
            placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 10, y: 11 });
            return { gargantuan, context: contextFor(combat), incumbent: endTurn(gargantuan) };
        };
        const expectRouted = (team: number, gate: string) => {
            const { gargantuan, context, incumbent } = setup(team);
            const routed = withAreaThrowGate(gate, () => routeAreaThrow(gargantuan, context, incumbent));
            expect(lastAction(routed).type).toBe("area_throw_attack");
        };
        const expectInert = (team: number, gate: string) => {
            const { gargantuan, context, incumbent } = setup(team);
            const routed = withAreaThrowGate(gate, () => routeAreaThrow(gargantuan, context, incumbent));
            expect(routed).toBe(incumbent);
        };

        expectRouted(LOWER, "on");
        expectRouted(UPPER, "both");
        expectRouted(LOWER, "green");
        expectRouted(UPPER, "red");
        expectInert(LOWER, "red");
        expectInert(UPPER, "green");
        expectInert(LOWER, "1");
    });

    it("honours V06_AREA_THROW_VERSIONS: unset = every caller, set = only listed strategy versions", () => {
        const combat = createCombatTestContext();
        const gargantuan = makeGargantuan();
        const enemyA = createTestUnit({ team: UPPER, name: "A", attackType: MELEE, amountAlive: 20 });
        const enemyB = createTestUnit({ team: UPPER, name: "B", attackType: MELEE, amountAlive: 20 });
        placeLarge(combat, gargantuan, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemyA, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, enemyB, { x: 10, y: 11 });
        const context = contextFor(combat);
        const incumbent = endTurn(gargantuan);

        withAreaThrowGate("on", () => {
            // Unset scope keeps the router's original semantics: any caller (with or without a version) routes.
            expect(lastAction(routeAreaThrow(gargantuan, context, incumbent)).type).toBe("area_throw_attack");
            expect(lastAction(routeAreaThrow(gargantuan, context, incumbent, undefined, "v0.6")).type).toBe(
                "area_throw_attack",
            );

            // A set scope routes ONLY the listed versions; everything else (including version-less callers)
            // preserves the exact incumbent array — the seat-scoped mirror contract.
            process.env.V06_AREA_THROW_VERSIONS = "v0.7s";
            try {
                expect(lastAction(routeAreaThrow(gargantuan, context, incumbent, undefined, "v0.7s")).type).toBe(
                    "area_throw_attack",
                );
                expect(routeAreaThrow(gargantuan, context, incumbent, undefined, "v0.7")).toBe(incumbent);
                expect(routeAreaThrow(gargantuan, context, incumbent)).toBe(incumbent);
            } finally {
                delete process.env.V06_AREA_THROW_VERSIONS;
            }
        });
    });

    it("is byte-parity inert gate-off: same array reference and no candidate enumeration", () => {
        const gargantuan = makeGargantuan();
        const incumbent = endTurn(gargantuan);
        let enumerations = 0;
        const enumerate = () => {
            enumerations += 1;
            return { candidates: [], truncated: [] };
        };

        for (const gate of [undefined, "off", "1", "red"]) {
            const routed = withAreaThrowGate(gate, () =>
                routeAreaThrow(gargantuan, {} as IDecisionContext, incumbent, enumerate),
            );
            expect(routed).toBe(incumbent);
        }
        expect(enumerations).toBe(0);
    });
});
