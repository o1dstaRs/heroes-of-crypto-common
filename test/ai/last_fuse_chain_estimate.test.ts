import { afterEach, expect, test } from "bun:test";

import { enumerateCandidates } from "../../src/ai/candidates";
import { estimateLastFuseMeleeDamage, estimateLastFuseRangedDamage } from "../../src/ai/last_fuse_estimate";
import { prioritizeV08SplashRangedDecision, StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createTestUnit, placeUnit } from "../helpers/combat";
import { lastFuseBoard } from "../helpers/last_fuse";

afterEach(() => setDeterministicRandomSource(undefined));

test("ordinary shooters without Last Fuse retain their decision", () => {
    const f = lastFuseBoard({ ranged: true, fuse: false });
    expect(prioritizeV08SplashRangedDecision(f.attacker, f.context, f.actions)).toBe(f.actions);
});

const estimate = (f: ReturnType<typeof lastFuseBoard>, ranged: boolean) =>
    ranged
        ? estimateLastFuseRangedDamage(f.attacker, f.target, f.context, 1)
        : estimateLastFuseMeleeDamage(f.attacker, f.target, f.context, f.stand, f.actions);

const execute = (f: ReturnType<typeof lastFuseBoard>) => {
    const enemies = f.unitsHolder.getAllEnemyUnits(f.attacker.getTeam());
    const before = enemies.map((unit) => unit.getCumulativeHp());
    const actual = f.fire();
    return {
        ...actual,
        enemyDamage: enemies.reduce((sum, unit, index) => sum + before[index] - unit.getCumulativeHp(), 0),
    };
};

for (const ranged of [false, true]) {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        for (const direction of [
            { x: 1, y: 0 },
            { x: -1, y: 1 },
        ]) {
            test(`chain projection matches the engine for ranged=${ranged}, team=${team}, direction=${JSON.stringify(direction)}`, () => {
                const f = lastFuseBoard({ ranged, team, direction, neighbor: { maxHp: 10 } });
                const third = createTestUnit({ team: f.target.getTeam(), maxHp: 1000 });
                placeUnit(f.grid, f.unitsHolder, third, { x: 8 + 2 * direction.x, y: 8 + 2 * direction.y });
                const before = JSON.stringify(snapshotBattle(f.unitsHolder, f.grid, f.fight));
                setDeterministicRandomSource(() => {
                    throw new Error("projection consumed RNG");
                });
                const projected = estimate(f, ranged);
                expect(projected?.expectedNetDamage).toBe(135);
                expect(projected?.expectedPrimaryDamage).toBe(100);
                expect(projected?.expectedFriendlyDamage).toBe(0);
                expect(JSON.stringify(snapshotBattle(f.unitsHolder, f.grid, f.fight))).toBe(before);
                const actual = execute(f);
                expect(actual.enemyDamage).toBe(projected!.expectedNetDamage);
                expect(actual.friendlyDamage).toBe(0);
                expect(actual.result.events.filter((event) => event.type === "pyre_exploded")).toHaveLength(2);
            });
        }
    }

    test(`chain damage uses each fatal hit and the original killer's power for ranged=${ranged}`, () => {
        const f = lastFuseBoard({
            ranged,
            attacker: { damageMin: 2000, damageMax: 2000, stackPower: 1 },
            target: { maxHp: 1200, stackPower: 5 },
            neighbor: { maxHp: 200, stackPower: 5 },
        });
        const third = createTestUnit({ team: f.target.getTeam(), maxHp: 1000 });
        placeUnit(f.grid, f.unitsHolder, third, { x: 10, y: 8 });
        expect(estimate(f, ranged)?.expectedNetDamage).toBe(1450);
        expect(execute(f).enemyDamage).toBe(1450);
    });

    test(`a shield absorbs the first blast but not the next chain blast for ranged=${ranged}`, () => {
        const f = lastFuseBoard({ ranged, neighbor: { maxHp: 10 } });
        const shielded = createTestUnit({ team: f.target.getTeam(), maxHp: 100, abilities: ["Water Shield"] });
        placeUnit(f.grid, f.unitsHolder, shielded, { x: 9, y: 9 });
        shielded.trySeedWaterShield();
        expect(estimate(f, ranged)?.expectedNetDamage).toBe(135);
        expect(shielded.willWaterShieldAbsorb()).toBe(true);
        expect(execute(f).enemyDamage).toBe(135);
        expect(shielded.getCumulativeHp()).toBe(75);
    });

    test(`branching chains do not double-count bodies or renew shields for ranged=${ranged}`, () => {
        const f = lastFuseBoard({ ranged, neighbor: { maxHp: 10 } });
        const sibling = createTestUnit({ team: f.target.getTeam(), maxHp: 10 });
        const shielded = createTestUnit({ team: f.target.getTeam(), maxHp: 40, abilities: ["Water Shield"] });
        placeUnit(f.grid, f.unitsHolder, sibling, { x: 8, y: 7 });
        placeUnit(f.grid, f.unitsHolder, shielded, { x: 9, y: 7 });
        shielded.trySeedWaterShield();
        expect(estimate(f, ranged)?.expectedNetDamage).toBe(160);
        const actual = execute(f);
        expect(actual.enemyDamage).toBe(160);
        expect(actual.result.events.filter((event) => event.type === "pyre_exploded")).toHaveLength(4);
    });

    test(`a rectangular victim extends the chain through its footprint for ranged=${ranged}`, () => {
        const f = lastFuseBoard({ ranged, neighbor: { maxHp: 10 } });
        const wide = createTestUnit({ team: f.target.getTeam(), maxHp: 10, footprintWidth: 2, footprintHeight: 1 });
        const last = createTestUnit({ team: f.target.getTeam(), maxHp: 1000 });
        placeUnit(f.grid, f.unitsHolder, wide, { x: 11, y: 8 });
        placeUnit(f.grid, f.unitsHolder, last, { x: 12, y: 8 });
        expect(estimate(f, ranged)?.expectedNetDamage).toBe(145);
        expect(execute(f).enemyDamage).toBe(145);
        expect(last.getCumulativeHp()).toBe(975);
    });

    test(`a lethal resurrecting chain recipient remains with full engine search for ranged=${ranged}`, () => {
        const f = lastFuseBoard({
            ranged,
            neighbor: { maxHp: 10, abilities: ["Resurrection"], spells: [":Resurrection"] },
        });
        expect(estimate(f, ranged)).toBeUndefined();
        expect(execute(f).result.events.filter((event) => event.type === "pyre_exploded")).toHaveLength(1);
        expect(f.neighbor.isDead()).toBe(false);
    });

    test(`candidate scoring recognizes a weak execution worth more than a direct hit for ranged=${ranged}`, () => {
        const f = lastFuseBoard({
            ranged,
            attacker: { damageMin: 200, damageMax: 200, stackPower: 5 },
            target: { maxHp: 1 },
            neighbor: { maxHp: 100 },
        });
        const third = createTestUnit({ team: f.target.getTeam(), maxHp: 1000 });
        placeUnit(f.grid, f.unitsHolder, third, { x: 10, y: 8 });
        const candidates = enumerateCandidates(
            f.attacker,
            f.context,
            [{ type: "defend_turn", unitId: f.attacker.getId() }],
            {
                includeLastFuseCounterTrades: true,
                maxMeleePairs: 1,
            },
        ).candidates;
        const execution = candidates.find(
            (candidate) => candidate.targetId === f.target.getId() && candidate.kind === (ranged ? "shot" : "melee"),
        );
        expect(execution).toBeDefined();
        expect(execution!.features.expectedDamage).toBe(226);
        expect(execution!.features.expectedKill).toBe(1);
        const choice = new StrategyV0_8()
            .decideTurn(f.attacker, f.context)
            .find((action) => action.type === "range_attack" || action.type === "melee_attack");
        expect(choice && "targetId" in choice && [f.target.getId(), f.neighbor.getId()].includes(choice.targetId)).toBe(
            true,
        );
        expect(execute(f).enemyDamage).toBe(226);
    });
}
