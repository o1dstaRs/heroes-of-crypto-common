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

import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const GS = testGridSettings;

const cellCenter = (x: number, y: number) => getPositionForCell({ x, y }, GS.getMinX(), GS.getStep(), GS.getHalfStep());

/**
 * A Through Shot shooter aiming at a free world point instead of a declared stack. The client sends
 * `targetPosition` with an EMPTY targetId — the shot pierces, so the victims are whatever the ray
 * crosses rather than one nominated target.
 */
const setupFreeAimFight = (opts: { shooterAbilities?: string[]; victimCells?: { x: number; y: number }[] }) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const { grid, unitsHolder, attackHandler } = context;
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const attacker = createTestUnit({
        name: "Archer",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.RANGE,
        attack: 40,
        damageMin: 30,
        damageMax: 30,
        rangeShots: 3,
        shotDistance: 16,
        initiative: 5,
        morale: 4,
        abilities: opts.shooterAbilities ?? ["Through Shot"],
    });
    placeUnit(grid, unitsHolder, attacker, { x: 1, y: 5 });
    attacker.refreshPossibleAttackTypes(true);

    const victims: Unit[] = [];
    let index = 1;
    for (const cell of opts.victimCells ?? [{ x: 8, y: 5 }]) {
        const victim = createTestUnit({
            name: `Victim${index}`,
            team: PBTypes.TeamVals.RIGHT,
            maxHp: 400,
            amountAlive: 20,
            armor: 0,
        });
        placeUnit(grid, unitsHolder, victim, cell);
        victims.push(victim);
        index += 1;
    }

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, victims.length);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const engine = new GameActionEngine({
        fightProperties,
        grid,
        unitsHolder,
        moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
        sceneLog: new SceneLogMock(),
        attackHandler,
        getCurrentActiveUnitId: () => attacker.getId(),
        runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
    });

    return { engine, attacker, victims };
};

describe("free-aim Through Shot (server/common engine)", () => {
    it("resolves a shot aimed at a world point with no declared target", () => {
        const setup = setupFreeAimFight({ victimCells: [{ x: 8, y: 5 }] });
        const hpBefore = setup.victims[0]!.getCumulativeHp();

        // Exactly the shape the client codec puts on the wire for a free shot: empty targetId, and a
        // free world endpoint beyond the victim so the ray crosses it.
        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: "",
            targetPosition: cellCenter(12, 5),
        });

        expect(result.completed).toBe(true);
        expect(setup.victims[0]!.getCumulativeHp()).toBeLessThan(hpBefore);
    });

    it("names the unit the ray actually hit as the attacked target", () => {
        const setup = setupFreeAimFight({
            victimCells: [
                { x: 6, y: 5 },
                { x: 9, y: 5 },
            ],
        });

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: "",
            targetPosition: cellCenter(13, 5),
        });

        expect(result.completed).toBe(true);
        const attacked = result.events.find(
            (event): event is Extract<typeof event, { type: "unit_attacked" }> => event.type === "unit_attacked",
        );
        expect(attacked).toBeDefined();
        // The nearer stack is the one the ray reaches first, so it owns the event — not an empty id.
        expect(attacked!.targetId).toBe(setup.victims[0]!.getId());
    });

    it("refuses a free aim from a shooter without Through Shot", () => {
        const setup = setupFreeAimFight({ shooterAbilities: [], victimCells: [{ x: 8, y: 5 }] });
        const hpBefore = setup.victims[0]!.getCumulativeHp();

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: "",
            targetPosition: cellCenter(12, 5),
        });

        expect(result.completed).toBe(false);
        expect(setup.victims[0]!.getCumulativeHp()).toBe(hpBefore);
    });

    it("refuses a free aim outside the battlefield", () => {
        const setup = setupFreeAimFight({ victimCells: [{ x: 8, y: 5 }] });

        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: "",
            targetPosition: { x: GS.getMaxX() + GS.getStep() * 4, y: 0 },
        });

        expect(result.completed).toBe(false);
    });

    it("refuses a malformed free aim", () => {
        const setup = setupFreeAimFight({ victimCells: [{ x: 8, y: 5 }] });
        const hpBefore = setup.victims[0]!.getCumulativeHp();

        // targetPosition arrives over the wire from a client; NaN must not slip past the bounds check and
        // reach the ray tracer. isPositionWithinGrid is written positively so NaN fails every comparison.
        for (const aim of [
            { x: Number.NaN, y: Number.NaN },
            { x: 0, y: Number.POSITIVE_INFINITY },
        ]) {
            const result = setup.engine.apply({
                type: "range_attack",
                attackerId: setup.attacker.getId(),
                targetId: "",
                targetPosition: aim,
            });
            expect(result.completed).toBe(false);
        }
        expect(setup.victims[0]!.getCumulativeHp()).toBe(hpBefore);
    });

    it("still requires a declared target for an ordinary ranged attack", () => {
        const setup = setupFreeAimFight({ shooterAbilities: [], victimCells: [{ x: 8, y: 5 }] });

        // No targetId and no free-aim position at all: the engine must still reject rather than
        // invent an aim point.
        const result = setup.engine.apply({
            type: "range_attack",
            attackerId: setup.attacker.getId(),
            targetId: "",
        });

        expect(result.completed).toBe(false);
    });
});
