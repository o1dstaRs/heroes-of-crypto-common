import { expect, test } from "bun:test";
import { Unit } from "../../src/units/unit";
import {
    beginEffectApplicationCapture,
    endEffectApplicationCapture,
    recordEffectApplication,
} from "../../src/units/effect_application_capture";

const unit = (passive?: string) =>
    Object.assign(Object.create(Unit.prototype), {
        getId: () => "trog",
        hasAbilityActive: (name: string) => name === passive,
    }) as Unit;

test("Madness reports actual resolution, while hover/AI probes and Mechanism stay silent", () => {
    beginEffectApplicationCapture();
    expect(unit("Madness").hasMindAttackResistance()).toBe(true);
    expect(unit("Mechanism").hasMindAttackResistance("Blindness")).toBe(true);
    expect(unit().hasMindAttackResistance("Blindness")).toBe(false);
    expect(endEffectApplicationCapture()).toEqual([]);

    beginEffectApplicationCapture();
    expect(unit("Madness").hasMindAttackResistance("Blindness")).toBe(true);
    expect(endEffectApplicationCapture()).toEqual([
        { unitId: "trog", name: "Blindness", kind: "effect", resisted: true, resistedBy: "Madness" },
    ]);
});

test("a spell's existing generic resistance record does not double the Madness outcome", () => {
    for (const genericFirst of [true, false]) {
        beginEffectApplicationCapture();
        const generic = () =>
            recordEffectApplication({ unitId: "trog", name: "Weakness", kind: "debuff", resisted: true });
        if (genericFirst) generic();
        unit("Madness").hasMindAttackResistance("Weakness", "debuff");
        if (!genericFirst) generic();
        expect(endEffectApplicationCapture()).toEqual([
            { unitId: "trog", name: "Weakness", kind: "debuff", resisted: true, resistedBy: "Madness" },
        ]);
    }
});

import { createCombatTestContext, createTestUnit } from "../helpers/combat";
import { processBlindnessAbility } from "../../src/abilities/blindness_ability";
import { processAggrAbility } from "../../src/abilities/aggr_ability";
import { processTerrifyingGazeAbility } from "../../src/abilities/terrifying_gaze_ability";
import { setDeterministicRandomSource } from "../../src/utils/lib";

test.each([
    ["Blindness", processBlindnessAbility],
    ["Aggr", processAggrAbility],
    ["Terrifying Gaze", processTerrifyingGazeAbility],
] as const)("a rolled %s is blocked by Madness and emits the real incoming effect name", (name, apply) => {
    createCombatTestContext();
    const source = createTestUnit({ abilities: [name], luck: 40, amountAlive: 100 });
    const target = createTestUnit({ name: "Troglodyte", abilities: ["Madness"], amountAlive: 100 });
    beginEffectApplicationCapture();
    setDeterministicRandomSource(() => 0);
    try {
        apply(source, target, source, { updateLog() {} } as never);
        expect(target.hasEffectActive(name)).toBe(false);
        expect(endEffectApplicationCapture()).toContainEqual({
            unitId: target.getId(), name, kind: "effect", resisted: true, resistedBy: "Madness",
        });
    } finally {
        endEffectApplicationCapture();
        setDeterministicRandomSource(undefined);
    }
});
