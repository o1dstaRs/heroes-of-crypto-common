import { expect, it } from "bun:test";
import { createTestUnit } from "../helpers/combat";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { captureUnitHpChanges, observeUnitHpChange } from "../../src/units/hp_change_capture";
import {
    observeCommittedHealth,
    summarizePremiumHealth,
    summarizePremiumUnitHealth,
    validatePremiumHealthLedger,
} from "../../src/simulation/ai_meta_health_ledger";

it("records actual capped HP changes, overkill, resurrection and passive regeneration", () => {
    const unit = createTestUnit({ amountAlive: 3, maxHp: 10, abilities: ["Wild Regeneration"] });
    const source = createTestUnit();
    const log = new SceneLogMock();
    const captured = captureUnitHpChanges(() => {
        unit.applyDamage(13, 0, log, false, source);
        unit.applyHeal(100);
        unit.applyResurrection(100);
        unit.applyDamage(4, 0, log);
        unit.refreshPreTurnState(log);
        unit.applyDamage(1000, 0, log, false, source);
    });
    expect(captured.changes.map((row) => row.after.hp - row.before.hp)).toEqual([-13, 3, 10, -4, 4, -30]);
    expect(captured.changes.map((row) => row.kind)).toEqual([
        "damage",
        "heal",
        "resurrection",
        "damage",
        "regeneration",
        "damage",
    ]);
    expect(captured.changes[0].sourceUnitId).toBe(source.getId());
    expect(captured.changes[3].sourceUnitId).toBeNull();
    expect(observeUnitHpChange(unit, "damage", 1)).toBeUndefined();
});

it("restores scoped observers after nested captures and exceptions", () => {
    const unit = createTestUnit({ maxHp: 100 });
    const log = new SceneLogMock();
    const outer = captureUnitHpChanges(() => {
        unit.applyDamage(1, 0, log);
        expect(() =>
            captureUnitHpChanges(() => {
                unit.applyDamage(2, 0, log);
                throw new Error("probe");
            }),
        ).toThrow("probe");
        unit.applyDamage(3, 0, log);
    });
    expect(outer.changes.map((row) => row.requestedHp)).toEqual([1, 3]);
    expect(observeUnitHpChange(unit, "damage", 1)).toBeUndefined();
});

it("credits actual HP and lethal calls only to explicit sources, without overkill or guessed ownership", () => {
    const source = createTestUnit({ maxHp: 10 });
    const victim = createTestUnit({ maxHp: 10 });
    const unknownVictim = createTestUnit({ maxHp: 10 });
    const units = new Map([source, victim, unknownVictim].map((unit) => [unit.getId(), unit]));
    const { observation } = observeCommittedHealth(
        () => units,
        () => 1,
        "melee_attack",
        () => {
            victim.applyDamage(1000, 0, new SceneLogMock(), false, source);
            unknownVictim.applyDamage(1000, 0, new SceneLogMock());
            return { events: [], completed: true };
        },
    );
    const result = summarizePremiumUnitHealth([observation], new Set([source.getId()]));
    expect(result.damageDealtHpWithSource).toBe(10);
    expect(result.lethalDamageCallsWithSource).toBe(1);
    expect(result.damageHp).toBe(0);
    expect(summarizePremiumUnitHealth([observation], new Set([victim.getId()])).damageHp).toBe(10);
});

it("reconciles direct quantity changes separately and retains removed and created stacks", () => {
    const unit = createTestUnit({ maxHp: 10, amountAlive: 3 });
    const dying = createTestUnit({ maxHp: 10 });
    const units = new Map([
        [unit.getId(), unit],
        [dying.getId(), dying],
    ]);
    const log = new SceneLogMock();
    const { observation } = observeCommittedHealth(
        () => units,
        () => 1,
        "action",
        () => {
            unit.applyDamage(3, 0, log);
            unit.setAmountAlive(5);
            dying.applyDamage(100, 0, log);
            units.delete(dying.getId());
            const summoned = createTestUnit({ maxHp: 5 });
            units.set(summoned.getId(), summoned);
            return { events: [], completed: true };
        },
    );
    validatePremiumHealthLedger([observation], []);
    expect(summarizePremiumHealth([observation])).toMatchObject({
        damageHp: 13,
        damageHpWithoutSource: 13,
        hpGainOutsideFunnels: 20,
        createdStacks: 1,
        removedStacks: 1,
    });
    const tampered = structuredClone(observation);
    tampered.frames[0].observedHpChange++;
    expect(() => validatePremiumHealthLedger([tampered], [])).toThrow("reconciliation");
    const omitted = structuredClone(observation);
    omitted.frames = omitted.frames.filter((row) => row.unitId !== dying.getId());
    expect(() => validatePremiumHealthLedger([omitted], [])).toThrow("missing unit frames");
    const missingEvents = structuredClone(observation);
    missingEvents.eventTypes = ["fight_started"];
    expect(() => validatePremiumHealthLedger([missingEvents], [])).toThrow("event boundaries");
    const later = structuredClone(observation);
    later.frames = [structuredClone(observation.frames[0])];
    later.changes = [];
    later.frames[0].before = { ...later.frames[0].after, hp: later.frames[0].after.hp + 1 };
    later.frames[0].observedHpChange = 0;
    later.frames[0].netHpChange = -1;
    later.frames[0].hpChangeOutsideFunnels = -1;
    expect(() => validatePremiumHealthLedger([observation, later], [])).toThrow("gap between");
});
