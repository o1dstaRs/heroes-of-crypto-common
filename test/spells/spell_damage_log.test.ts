/*
 * -----------------------------------------------------------------------------
 * Offensive spells must report the damage they ACTUALLY dealt.
 *
 * Regression guard: Lightning Strike, Ring of Fire, Meteorite and Meteor Shower
 * logged the pre-resistance roll, so the scene log printed the same figure however
 * much magic resistance the target had — the damage was reduced correctly, but the
 * log read as though mdef did nothing.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISceneLog } from "../../src/scene/scene_log_interface";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/** SceneLogMock discards everything, and this test is about what the log SAYS. */
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

/** Magic Dragon facing an aim plus the adjacent stack Ring of Fire actually damages. */
const setup = (magicResist: number) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Magic Dragon",
        team: PBTypes.TeamVals.LEFT,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        spells: ["Nature:Lightning Strike", "Nature:Ring of Fire"],
        amountAlive: 20,
        stackPower: 5,
        initiative: 5,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 3, y: 3 });

    const victim = createTestUnit({
        name: "Victim",
        team: PBTypes.TeamVals.RIGHT,
        maxHp: 100_000,
        magicResist,
        initiative: 3,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, victim, { x: 6, y: 3 });

    // Ring of Fire spares the creature it is aimed at and burns the ring around it, so the cast needs a
    // second body to catch — and that body, not the aimed one, is what the log has to match. Same magic
    // resistance, so the number the log prints is still the resisted one this test is about.
    const ringVictim = createTestUnit({
        name: "Ring Victim",
        team: PBTypes.TeamVals.RIGHT,
        maxHp: 100_000,
        magicResist,
        initiative: 3,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, ringVictim, { x: 6, y: 4 });

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 2);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const sceneLog = new RecordingSceneLog();
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog,
        attackHandler: context.attackHandler,
    });

    return { ...context, engine, caster, victim, ringVictim, sceneLog };
};

/** Cast at the victim and return both the hp it lost and the number the log printed. */
const castAndRead = (magicResist: number, spellName: string) => {
    const fight = setup(magicResist);
    const damagedUnit = spellName === "Ring of Fire" ? fight.ringVictim : fight.victim;
    const hpBefore = damagedUnit.getHp();
    const aimedHpBefore = fight.victim.getHp();
    const result = fight.engine.apply({
        type: "cast_spell",
        casterId: fight.caster.getId(),
        spellName,
        targetId: fight.victim.getId(),
    });
    expect(result.completed).toBe(true);
    if (spellName === "Ring of Fire") {
        expect(fight.victim.getHp()).toBe(aimedHpBefore);
    }

    const line = fight.sceneLog.lines.find((entry) => entry.includes(fight.caster.getName()))!;
    const logged = Number(line.match(/\((\d+)\)/)?.[1]);
    return { took: hpBefore - damagedUnit.getHp(), logged };
};

describe("offensive spell scene log", () => {
    for (const spellName of ["Lightning Strike", "Ring of Fire"]) {
        it(`${spellName} logs the damage that landed, not the pre-resistance roll`, () => {
            const soft = castAndRead(0, spellName);
            const warded = castAndRead(50, spellName);

            // The log must equal what the victim actually lost, at every resistance.
            expect(soft.logged).toBe(soft.took);
            expect(warded.logged).toBe(warded.took);
            // …and it must visibly move with mdef, which is the whole complaint.
            expect(warded.logged).toBeLessThan(soft.logged);
        });
    }
});
