import { afterEach, expect, test } from "bun:test";

import { estimateLastFuseMeleeDamage } from "../../src/ai/last_fuse_estimate";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { lastFuseBoard } from "../helpers/last_fuse";

afterEach(() => setDeterministicRandomSource(undefined));

for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
    for (const direction of [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 },
    ]) {
        test(`melee kill projection matches enemy splash without friendly loss, team ${team}, ${JSON.stringify(direction)}`, () => {
            const f = lastFuseBoard({ team, direction });
            const estimate = estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)!;
            const actual = f.fire();
            expect(estimate.expectedNetDamage).toBe(125);
            expect(estimate.expectedNetDamage).toBe(actual.enemyDamage);
            expect(estimate.expectedFriendlyDamage).toBe(0);
            expect(actual.friendlyDamage).toBe(0);
            expect(estimate.secureKill).toBe(true);
        });
    }
}

for (const stackPower of [1, 2, 3, 4, 5]) {
    test(`melee projection uses the attacker stack power ${stackPower}`, () => {
        const f = lastFuseBoard({ attacker: { stackPower }, target: { stackPower: 6 - stackPower }, remainingHp: 1 });
        const estimate = estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)!;
        expect(estimate.expectedNetDamage).toBe(1 + 25 * stackPower);
        expect(f.fire().enemyDamage).toBe(estimate.expectedNetDamage);
    });
}

test("the projection uses remaining HP rather than overkill and does not consume RNG or mutate units", () => {
    const f = lastFuseBoard({ target: { amountAlive: 10 }, remainingHp: 600 });
    const before = JSON.stringify([...f.unitsHolder.getAllUnits().values()].map((unit) => unit.getUnitProperties()));
    setDeterministicRandomSource(() => {
        throw new Error("projection consumed combat RNG");
    });
    const estimate = estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)!;
    expect(estimate.expectedNetDamage).toBe(750);
    expect(JSON.stringify([...f.unitsHolder.getAllUnits().values()].map((unit) => unit.getUnitProperties()))).toBe(
        before,
    );
    expect(f.fire().enemyDamage).toBe(750);
});

test("an enemy owning Last Fuse does not make it explode when the attacker has no artifact", () => {
    const f = lastFuseBoard({ fuse: false, enemyFuse: true });
    expect(estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)).toBeUndefined();
    expect(f.fire().result.events.some((event) => event.type === "pyre_exploded")).toBe(false);
});

test("nonfatal strikes receive no splash bonus", () => {
    const f = lastFuseBoard({ attacker: { damageMin: 10, damageMax: 10 } });
    const estimate = estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)!;
    expect(estimate.fatalChance).toBe(0);
    expect(estimate.expectedNetDamage).toBe(f.fire().enemyDamage);
});

for (const shield of ["target", "neighbor"] as const) {
    test(`Water Shield on the ${shield} matches the actual kill and blast`, () => {
        const f = lastFuseBoard({ [shield]: { abilities: ["Water Shield"] } });
        const estimate = estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)!;
        expect(estimate.expectedNetDamage).toBe(shield === "target" ? 0 : 100);
        expect(f.fire().enemyDamage).toBe(estimate.expectedNetDamage);
    });
}

test("resurrection prevents the explosion while ordinary chains are projected", () => {
    const resurrected = lastFuseBoard({
        target: { amountAlive: 2, abilities: ["Resurrection"], spells: [":Resurrection"] },
    });
    expect(
        estimateLastFuseMeleeDamage(
            resurrected.attacker,
            resurrected.target,
            resurrected.context,
            resurrected.stand,
            resurrected.actions,
        )?.fatalChance,
    ).toBe(0);
    const chain = lastFuseBoard({ neighbor: { maxHp: 10 } });
    expect(
        estimateLastFuseMeleeDamage(chain.attacker, chain.target, chain.context, chain.stand, chain.actions)
            ?.expectedNetDamage,
    ).toBe(110);
    expect(chain.fire().result.events.filter((event) => event.type === "pyre_exploded")).toHaveLength(2);
});

test("complex riders and lethal retaliation remain with engine search", () => {
    for (const options of [
        { attacker: { abilities: ["Petrifying Gaze"] } },
        { response: true, target: { damageMin: 9999, damageMax: 9999 } },
    ]) {
        const f = lastFuseBoard(options);
        expect(estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions)).toBeUndefined();
    }
});
