/*
 * -----------------------------------------------------------------------------
 * A dodged/missed attack must not land on-hit effects: an Orc's ranged shot the
 * Scavenger dodges must NOT Stun it. Regression: the ranged path applied
 * Stun / Rime Charm / Petrifying Gaze / Spit Ball even when isAttackMissed was
 * true (the melee path already gated these on the miss).
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { createSequenceGameRuntime } from "../../src/engine/runtime";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { AttackHandler } from "../../src/handlers/attack_handler";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISceneLog } from "../../src/scene/scene_log_interface";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

/** Recording log so the test can assert the shot was actually reported as a miss. */
class RecordingSceneLog implements ISceneLog {
    public readonly lines: string[] = [];
    public getLog(): string {
        return this.lines.join("\n");
    }
    public updateLog(newLog?: string): void {
        if (newLog) {
            this.lines.push(newLog);
        }
    }
    public hasBeenUpdated(): boolean {
        return this.lines.length > 0;
    }
}

describe("missed attack lands no on-hit effects", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it.each(["melee", "range"] as const)(
        "records a confirmed missed %s counter without inferring it from zero HP loss",
        (kind) => {
            for (const missed of [false, true]) {
                const context = createCombatTestContext();
                const { grid, unitsHolder } = context;
                const fightProperties = FightStateManager.getInstance().getFightProperties();
                fightProperties.startFight();
                const options = {
                    attackType: kind === "range" ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                    maxHp: 1000,
                    amountAlive: 1,
                    attack: 10,
                    damageMin: 5,
                    damageMax: 5,
                    rangeShots: 10,
                    shotDistance: 10,
                };
                const attacker = createTestUnit({ ...options, name: "Squire", team: PBTypes.TeamVals.LEFT });
                const target = createTestUnit({ ...options, name: "Orc", team: PBTypes.TeamVals.RIGHT });
                attacker.calculateMissChance = () => 0;
                target.calculateMissChance = () => (missed ? 100 : 0);
                placeUnit(grid, unitsHolder, attacker, { x: 3, y: 3 });
                placeUnit(grid, unitsHolder, target, kind === "range" ? { x: 3, y: 9 } : { x: 4, y: 3 });
                attacker.refreshPossibleAttackTypes(true);
                target.refreshPossibleAttackTypes(true);
                fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
                fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
                fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);
                const sceneLog = new RecordingSceneLog();
                const engine = new GameActionEngine({
                    fightProperties,
                    grid,
                    unitsHolder,
                    sceneLog,
                    moveHandler: new MoveHandler(grid.getSettings(), grid, unitsHolder),
                    attackHandler: new AttackHandler(testGridSettings, grid, sceneLog, context.damageStatisticHolder),
                    getCurrentActiveUnitId: () => attacker.getId(),
                    runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
                });
                const hpBefore = attacker.getCumulativeHp();
                const result = engine.apply(
                    kind === "range"
                        ? { type: "range_attack", attackerId: attacker.getId(), targetId: target.getId() }
                        : {
                              type: "melee_attack",
                              attackerId: attacker.getId(),
                              targetId: target.getId(),
                              attackFrom: { x: 3, y: 3 },
                          },
                );
                expect(result.completed).toBe(true);
                const event = result.events.find((event) => event.type === "unit_attacked");
                if (!event || event.type !== "unit_attacked") throw new Error("Attack event missing");
                const recorded = JSON.parse(JSON.stringify(event.damage));
                if (missed) {
                    expect(sceneLog.getLog()).toContain(kind === "range" ? "misses 🏹 resp" : "misses ⚔️ resp");
                    expect(attacker.getCumulativeHp()).toBe(hpBefore);
                    expect(recorded.missedResponse).toEqual({
                        unitId: attacker.getId(),
                        position: attacker.getPosition(),
                    });
                } else {
                    expect(attacker.getCumulativeHp()).toBeLessThan(hpBefore);
                    expect(recorded.missedResponse).toBeUndefined();
                }
                expect(recorded.missed).not.toBe(true);
            }
        },
    );

    it("a dodged ranged shot does not Stun (Orc vs Scavenger)", () => {
        // RNG pinned to 0 makes this fully discriminating: the miss roll (0 < dodge chance) always
        // MISSES, and the stun roll (0 < stun chance) would always LAND if it were (wrongly)
        // processed after the miss. Luck seeds both chances above zero regardless of stack power
        // (calculateAbilityApplyChance = luck + scaled ability power).
        setDeterministicRandomSource(() => 0);

        const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const { grid, unitsHolder } = context;
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setGridType(PBTypes.GridVals.NORMAL);
        fightProperties.startFight();

        const orc = createTestUnit({
            name: "Orc",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            attack: 11,
            damageMin: 1,
            damageMax: 5,
            rangeShots: 6,
            shotDistance: 10,
            luck: 40,
            abilities: ["Stun"],
        });
        const scavenger = createTestUnit({
            name: "Scavenger",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 100,
            amountAlive: 5,
            luck: 40,
            abilities: ["Dodge"],
        });

        const placeSmall = (unit: Unit, cell: { x: number; y: number }): void => {
            const pos = getPositionForCell(
                cell,
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            );
            unit.setPosition(pos.x, pos.y);
            grid.occupyCell(cell, unit.getId(), unit.getTeam(), unit.getAttackRange(), false, false);
            unitsHolder.addUnit(unit);
        };
        placeSmall(orc, { x: 3, y: 3 });
        placeSmall(scavenger, { x: 3, y: 9 });
        orc.refreshPossibleAttackTypes(true);

        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

        const sceneLog = new RecordingSceneLog();
        const moveHandler = new MoveHandler(grid.getSettings(), grid, unitsHolder);
        // Hand-built AttackHandler so the miss line lands in the recording log (the helper's handler
        // uses a discard-everything SceneLogMock).
        const attackHandler = new AttackHandler(testGridSettings, grid, sceneLog, context.damageStatisticHolder);
        const engine = new GameActionEngine({
            fightProperties,
            grid,
            unitsHolder,
            moveHandler,
            sceneLog,
            attackHandler,
            getCurrentActiveUnitId: () => orc.getId(),
            runtime: createSequenceGameRuntime({ nowMillis: [1400] }),
        });

        const hpBefore = scavenger.getCumulativeHp();
        const result = engine.apply({
            type: "range_attack",
            attackerId: orc.getId(),
            targetId: scavenger.getId(),
        });

        expect(result.completed).toBe(true);
        expect(sceneLog.getLog()).toContain("misses 🏹 on");
        expect(scavenger.getCumulativeHp()).toBe(hpBefore);
        expect(scavenger.getEffects().map((e) => e.getName())).not.toContain("Stun");
    });
});
