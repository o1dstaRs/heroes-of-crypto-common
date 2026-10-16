import { afterEach, expect, test } from "bun:test";

import { estimateLastFuseRangedDamage } from "../../src/ai/last_fuse_estimate";
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
        test(`ranged kill projection matches enemy splash, team ${team}, ${JSON.stringify(direction)}`, () => {
            const f = lastFuseBoard({ ranged: true, team, direction });
            const estimate = estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)!;
            const actual = f.fire();
            expect(estimate.expectedNetDamage).toBe(120);
            expect(actual.enemyDamage).toBe(estimate.expectedNetDamage);
            expect(estimate.expectedFriendlyDamage).toBe(0);
            expect(actual.friendlyDamage).toBe(0);
            expect(estimate.secureKill).toBe(true);
        });
    }
}

for (const stackPower of [1, 2, 3, 4, 5]) {
    test(`ranged projection uses destroyed power ${stackPower} and actual fatal HP`, () => {
        const f = lastFuseBoard({ ranged: true, target: { stackPower }, remainingHp: 1 });
        const estimate = estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)!;
        expect(estimate.expectedNetDamage).toBe(1 + 20 * stackPower);
        expect(f.fire().enemyDamage).toBe(estimate.expectedNetDamage);
    });
}

for (const shield of ["target", "neighbor"] as const) {
    test(`ranged projection respects ${shield} Water Shield`, () => {
        const f = lastFuseBoard({ ranged: true, [shield]: { abilities: ["Water Shield"] } });
        const estimate = estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)!;
        expect(estimate.expectedNetDamage).toBe(shield === "target" ? 0 : 100);
        expect(f.fire().enemyDamage).toBe(estimate.expectedNetDamage);
    });
}

test("ranged projection does not consume RNG, mutate shields, or use enemy ownership", () => {
    const f = lastFuseBoard({ ranged: true, fuse: false, enemyFuse: true });
    setDeterministicRandomSource(() => {
        throw new Error("projection consumed combat RNG");
    });
    expect(estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)).toBeUndefined();
    expect(f.fire().result.events.some((event) => event.type === "pyre_exploded")).toBe(false);
});

test("nonlethal shots and resurrection grant no explosion bonus", () => {
    for (const options of [
        { attacker: { damageMin: 10, damageMax: 10 } },
        { target: { amountAlive: 2, abilities: ["Resurrection"], spells: [":Resurrection"] } },
    ]) {
        const f = lastFuseBoard({ ranged: true, ...options });
        expect(estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)?.fatalChance).toBe(0);
    }
});

test("chained deaths, secondary riders, and uncertain volleys stay with engine search", () => {
    for (const options of [
        { neighbor: { maxHp: 10 } },
        { attacker: { abilities: ["Through Shot"] } },
        { attacker: { abilities: ["Crafted Double Shot"], damageMin: 10, damageMax: 10 } },
    ]) {
        const f = lastFuseBoard({ ranged: true, ...options });
        expect(estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)).toBeUndefined();
    }
});
