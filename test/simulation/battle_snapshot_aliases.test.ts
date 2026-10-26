import { expect, test } from "bun:test";
import Denque from "denque";
import type { AuraEffect } from "../../src/effects/aura_effect";
import type { AppliedAuraEffectProperties } from "../../src/effects/effect_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { BattleRollbackJournal, deepClone, restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

function fixture() {
    const context = createCombatTestContext();
    const thief = createTestUnit({ name: "Arachna Queen", amountAlive: 20, stackPower: 3 });
    thief.grantStolenAbility("Wolf Trail Aura");
    placeUnit(context.grid, context.unitsHolder, thief, { x: 4, y: 4 });
    const ally = createTestUnit({ name: "Nearby ally" });
    placeUnit(context.grid, context.unitsHolder, ally, { x: 4, y: 5 });
    context.unitsHolder.refreshAuraEffectsForAllUnits();
    const fight = FightStateManager.getInstance().getFightProperties();
    const cardAura = () => Reflect.get(thief.getAbility("Wolf Trail Aura")!, "auraEffect") as AuraEffect;
    const aura = () => thief.getAuraEffect("Wolf Trail")!;
    const projected = () => {
        const teams = Reflect.get(context.unitsHolder, "teamsAuraEffects") as Map<
            number,
            Map<number, AppliedAuraEffectProperties[]>
        >;
        return [...teams.get(thief.getTeam())!.values()]
            .flat()
            .filter((entry) => entry.getAuraEffectProperties().name === "Wolf Trail");
    };
    expect(cardAura()).toBe(aura());
    expect(projected().length).toBeGreaterThan(1);
    expect(projected().every((entry) => entry.getAuraEffectProperties() === aura().getProperties())).toBe(true);
    return { ...context, thief, ally, fight, cardAura, aura, projected };
}

function expectAliases(f: ReturnType<typeof fixture>) {
    expect(f.cardAura()).toBe(f.aura());
    expect(f.projected().every((entry) => entry.getAuraEffectProperties() === f.aura().getProperties())).toBe(true);
    const power = f.aura().getPower();
    f.aura().setPower(power + 0.1);
    expect(f.cardAura().getPower()).toBe(power + 0.1);
    expect(f.projected().every((entry) => entry.getAuraEffectProperties().power === power + 0.1)).toBe(true);
}

const savedValues = (snapshot: ReturnType<typeof snapshotBattle>) =>
    JSON.stringify({ ...snapshot, unitRefs: undefined }, (_key, value) =>
        value instanceof Map || value instanceof Set ? [...value] : value,
    );

test("full rollback preserves a stolen aura's shared card, source and projected-cell properties", () => {
    const f = fixture();
    const snapshot = snapshotBattle(f.unitsHolder, f.grid, f.fight);
    const frozen = savedValues(snapshot);
    f.thief.setStackPower(5);
    f.unitsHolder.refreshAuraEffectsForAllUnits();
    restoreBattle(snapshot, f.unitsHolder, f.grid, f.fight);
    expectAliases(f);
    expect(savedValues(snapshot)).toBe(frozen);
    restoreBattle(snapshot, f.unitsHolder, f.grid, f.fight);
    expectAliases(f);
    expect(savedValues(snapshot)).toBe(frozen);
});

test("incremental rollback keeps aliases across separately first-touched unit and holder objects", () => {
    const f = fixture();
    const journal = new BattleRollbackJournal(f.unitsHolder, f.grid, f.fight);
    for (const holderFirst of [false, true]) {
        const checkpoint = journal.checkpoint();
        try {
            if (holderFirst) f.unitsHolder.refreshAuraEffectsForAllUnits();
            f.thief.setStackPower(5);
            f.unitsHolder.refreshAuraEffectsForAllUnits();
        } finally {
            checkpoint.rollback();
        }
        expectAliases(f);
        f.unitsHolder.refreshAuraEffectsForAllUnits();
    }
});

test("rolling back only a unit mutation also restores its links into the untouched aura cache", () => {
    const f = fixture();
    const checkpoint = new BattleRollbackJournal(f.unitsHolder, f.grid, f.fight).checkpoint();
    try {
        f.thief.setTarget("temporary target");
    } finally {
        checkpoint.rollback();
    }
    expectAliases(f);
});

test("rolling back only a holder mutation also restores links to otherwise untouched aura sources", () => {
    const f = fixture();
    const checkpoint = new BattleRollbackJournal(f.unitsHolder, f.grid, f.fight).checkpoint();
    try {
        f.unitsHolder.haveDistancesToClosestEnemiesDecreased();
    } finally {
        checkpoint.rollback();
    }
    expectAliases(f);
});

test("prototype-preserving clones retain shared objects through arrays, keyed containers and queues", () => {
    const f = fixture(),
        aura = f.aura();
    const source = { aura, list: [aura], map: new Map([[aura, new Set([aura])]]), queue: new Denque([aura]) };
    const clone = deepClone(source);
    expect(clone.aura).not.toBe(aura);
    expect(Object.getPrototypeOf(clone.aura)).toBe(Object.getPrototypeOf(aura));
    expect(clone.list[0]).toBe(clone.aura);
    expect([...clone.map.keys()][0]).toBe(clone.aura);
    expect([...clone.map.get(clone.aura)!][0]).toBe(clone.aura);
    expect(clone.queue.peekFront()).toBe(clone.aura);
    clone.aura.setPower(99);
    expect(aura.getPower()).not.toBe(99);
});

test("equal independent aura objects stay independent, and sparse arrays keep their holes", () => {
    const f = fixture();
    const independent = deepClone(f.aura());
    const sparse = new Array<AuraEffect>(3);
    sparse[2] = f.aura();
    const cloned = deepClone({ first: f.aura(), second: independent, sparse });
    expect(cloned.first).not.toBe(cloned.second);
    expect(cloned.first.getProperties()).not.toBe(cloned.second.getProperties());
    expect(cloned.sparse).toHaveLength(3);
    expect(0 in cloned.sparse).toBe(false);
    expect(1 in cloned.sparse).toBe(false);
    expect(cloned.sparse[2]).toBe(cloned.first);
});
