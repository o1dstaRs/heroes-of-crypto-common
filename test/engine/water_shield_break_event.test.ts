/*
 * -----------------------------------------------------------------------------
 * Water Shield's break must be VISIBLE: the engine log names the striker, and the
 * absorb rides the action's damage payload as a `secondary` entry (source
 * "water_shield") — the only way the ranked scene log (rebuilt from events,
 * never engine text) can say the shield broke and under whose blow.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import type { ISceneLog } from "../../src/scene/scene_log_interface";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

type AttackEvent = Extract<GameEvent, { type: "unit_attacked" }>;

class RecordingSceneLog implements ISceneLog {
    public lines: string[] = [];

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

const startFight = (sceneLog: ISceneLog) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog,
        attackHandler: context.attackHandler,
    });
    return { context, fightProperties, engine };
};

describe("Water Shield break visibility", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    it("an absorbed melee blow logs the striker and rides the event as a water_shield secondary", () => {
        setDeterministicRandomSource(() => 0);
        const sceneLog = new RecordingSceneLog();
        const { context, fightProperties, engine } = startFight(sceneLog);
        // applyDamage writes through the ATTACK HANDLER's log, which the combat helper builds with a
        // discarding mock — swap in the recorder (same private access the no-riders suite uses to read it).
        (context.attackHandler as unknown as { sceneLog: RecordingSceneLog }).sceneLog = sceneLog;
        const attacker = createTestUnit({
            name: "Orc",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE,
            attack: 10,
            damageMin: 5,
            damageMax: 5,
            amountAlive: 3,
        });
        const mermaid = createTestUnit({
            name: "Mermaid",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 100,
            amountAlive: 5,
            abilities: ["Water Shield"],
        });
        mermaid.trySeedWaterShield();
        expect(mermaid.hasBuffActive("Water Shield")).toBe(true);
        placeUnit(context.grid, context.unitsHolder, attacker, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, mermaid, { x: 4, y: 3 });
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LOWER, 1);
        fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.UPPER, 1);
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);

        const result = engine.apply({
            type: "melee_attack",
            attackerId: attacker.getId(),
            targetId: mermaid.getId(),
            attackFrom: { x: 3, y: 3 },
        });

        expect(result.completed).toBe(true);
        // The engine log (sandbox) names the striker.
        expect(sceneLog.getLog()).toContain("Mermaid's Water Shield absorbs Orc's hit and breaks");

        // The event (ranked) carries the absorb: the shield owner, the eaten amount, no deaths.
        const attackEvent = result.events.find((event): event is AttackEvent => event.type === "unit_attacked");
        expect(attackEvent).toBeDefined();
        const absorb = attackEvent!.damage.secondary?.find((entry) => entry.source === "water_shield");
        expect(absorb).toBeDefined();
        expect(absorb!.unitId).toBe(mermaid.getId());
        expect(absorb!.amount).toBeGreaterThan(0);
        expect(absorb!.unitsDied).toBe(0);

        // The shield is one-per-battle: a second blow damages normally and records no further absorb.
        fightProperties.flipLap();
        fightProperties.startTurn(PBTypes.TeamVals.LOWER, 1000);
        const second = engine.apply({
            type: "melee_attack",
            attackerId: attacker.getId(),
            targetId: mermaid.getId(),
            attackFrom: { x: 3, y: 3 },
        });
        expect(second.completed).toBe(true);
        const secondAttack = second.events.find((event): event is AttackEvent => event.type === "unit_attacked");
        expect(secondAttack!.damage.secondary?.some((entry) => entry.source === "water_shield") ?? false).toBe(false);
    });
});
