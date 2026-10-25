import { describe, expect, test } from "bun:test";

import { EffectFactory } from "../../src/effects/effect_factory";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createTestUnit } from "../helpers/combat";

const peasant = () => createTestUnit({ name: "Peasant", abilities: ["Bitter Experience"], amountAlive: 10 });

describe("Bitter Experience stacks", () => {
    test("counts qualifying hits once even when several creatures die", () => {
        const unit = peasant();
        const armor = unit.getBaseArmor();
        const steps = unit.getSteps();
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(0);

        unit.applyDamage(30, 0, new SceneLogMock());
        expect(unit.getAmountDied()).toBe(3);
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(1);
        expect(unit.getBaseArmor()).toBe(armor + 1);
        expect(unit.getSteps()).toBe(steps + 1);

        unit.applyDamage(10, 0, new SceneLogMock());
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(2);
        expect(unit.getBaseArmor()).toBe(armor + 2);
        expect(unit.getSteps()).toBe(steps + 2);
    });

    test("does not count hits without casualties or the final fatal hit", () => {
        const unit = peasant();
        unit.applyDamage(5, 0, new SceneLogMock());
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(0);

        unit.applyDamage(10, 0, new SceneLogMock());
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(1);

        unit.applyDamage(1_000, 0, new SceneLogMock());
        expect(unit.isDead()).toBe(true);
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(1);
    });

    test("does not count casualties while Break disables the ability", () => {
        const unit = peasant();
        unit.applyEffect(new EffectFactory().makeEffect("Break")!);
        unit.applyDamage(10, 0, new SceneLogMock());
        expect(unit.getAmountDied()).toBe(1);
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(0);
    });

    test("starts counting safely for older properties without a counter", () => {
        const unit = peasant();
        delete unit.getUnitProperties().bitter_experience_stacks;
        unit.applyDamage(10, 0, new SceneLogMock());
        expect(unit.getUnitProperties().bitter_experience_stacks).toBe(1);
    });
});
