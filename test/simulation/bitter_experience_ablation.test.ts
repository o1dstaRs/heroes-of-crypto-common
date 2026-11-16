import { test, expect, afterEach } from "bun:test";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { info, neutralizeBonus, type Axis } from "../helpers/bitter_experience_ablation";
afterEach(() => setDeterministicRandomSource(undefined));
for (const axis of ["none", "armor", "steps", "both"] as Axis[])
    test(`exact isolated ${axis} bonus ablation preserves casualties and counter through rollback`, () => {
        const context = createCombatTestContext(),
            fp = FightStateManager.getInstance().getFightProperties();
        const unit = createTestUnit({
            name: "Peasant",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Bitter Experience"],
            maxHp: 8,
            amountAlive: 12,
            armor: 7,
        });
        placeUnit(context.grid, context.unitsHolder, unit, { x: 4, y: 6 });
        const start = info(unit);
        unit.applyDamage(10, 0, new SceneLogMock());
        const earned = info(unit);
        expect(earned.stacks - start.stacks).toBe(1);
        expect(start.amount - earned.amount).toBe(1);
        const removed = neutralizeBonus(unit, start.stacks, axis),
            after = info(unit);
        expect(after.hp).toBe(earned.hp);
        expect(after.amount).toBe(earned.amount);
        expect(after.stacks).toBe(earned.stacks);
        expect(after.baseArmor).toBe(start.baseArmor + (axis === "armor" || axis === "both" ? 0 : 1));
        expect(after.initialArmor).toBe(start.initialArmor + (axis === "armor" || axis === "both" ? 0 : 1));
        expect(after.rawSteps).toBe(start.rawSteps + (axis === "steps" || axis === "both" ? 0 : 1));
        expect(after.initialSteps).toBe(start.initialSteps + (axis === "steps" || axis === "both" ? 0 : 1));
        expect(removed.armorRemoved).toBe(axis === "armor" || axis === "both" ? 1 : 0);
        const snap = snapshotBattle(context.unitsHolder, context.grid, fp);
        unit.applyDamage(10, 0, new SceneLogMock());
        restoreBattle(snap, context.unitsHolder, context.grid, fp);
        expect(info(unit)).toEqual(after);
    });
test("one HP can buy a bonus from a wounded top Peasant even in a small stack", () => {
    createCombatTestContext();
    const u = createTestUnit({ name: "Peasant", abilities: ["Bitter Experience"], maxHp: 8, amountAlive: 3 });
    u.applyDamage(7, 0, new SceneLogMock());
    const s = info(u);
    expect(s.stacks).toBe(0);
    u.applyDamage(1, 0, new SceneLogMock());
    expect(info(u).amount).toBe(2);
    expect(info(u).stacks).toBe(1);
    expect(info(u).baseArmor - s.baseArmor).toBe(1);
});
test("no-casualty and fatal hits have no bonus to neutralize", () => {
    for (const damage of [1, 24]) {
        createCombatTestContext();
        const u = createTestUnit({ name: "Peasant", abilities: ["Bitter Experience"], maxHp: 8, amountAlive: 3 });
        const s = info(u);
        u.applyDamage(damage, 0, new SceneLogMock());
        const b = info(u);
        expect(neutralizeBonus(u, s.stacks, "both")).toEqual({ stacks: 0, armorRemoved: 0, stepsRemoved: 0 });
        expect(info(u)).toEqual(b);
    }
});
