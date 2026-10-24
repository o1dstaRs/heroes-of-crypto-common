import { afterEach, expect, test } from "bun:test";
import { processFireBreathAbility } from "../../src/abilities/fire_breath_ability";
import { estimateFireBreathMeleePotential } from "../../src/ai/fire_breath_tactics";
import { enumerateCandidates } from "../../src/ai/candidates";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createTestUnit, placeUnit } from "../helpers/combat";
import { lastFuseBoard } from "../helpers/last_fuse";

afterEach(() => setDeterministicRandomSource(undefined));
function board(ally = false, immune = false) {
    const f = lastFuseBoard({
        fuse: false,
        attacker: { abilities: ["Fire Breath", "Fire Element"], stackPower: 100, damageMin: 100, damageMax: 100 },
        target: { maxHp: 1000 },
        neighbor: { maxHp: 1000, magicResist: 20, abilities: immune ? ["Fire Element"] : [] },
    });
    if (ally) {
        f.grid.cleanupAll(f.neighbor.getId(), f.neighbor.getAttackRange(), f.neighbor.isSmallSize());
        f.unitsHolder.deleteUnitById(f.neighbor.getId());
        const friend = createTestUnit({ team: f.attacker.getTeam(), maxHp: 1000, magicResist: 20 });
        placeUnit(f.grid, f.unitsHolder, friend, { x: 9, y: 8 });
        return { ...f, tail: friend };
    }
    return { ...f, tail: f.neighbor };
}

test("the complete estimate includes the same magical tail the engine lands", () => {
    const f = board();
    let draws = 0;
    setDeterministicRandomSource(() => {
        draws++;
        return 0;
    });
    const result = estimateFireBreathMeleePotential(f.attacker, f.target, f.context, f.stand, f.actions)!;
    expect(result.netDamage).toBe(180);
    expect(draws).toBe(0);
    const hp = f.tail.getCumulativeHp();
    processFireBreathAbility(
        f.attacker,
        f.target,
        new SceneLogMock(),
        f.unitsHolder,
        f.grid,
        "attk",
        f.damageStatisticHolder,
        f.stand,
    );
    expect(hp - f.tail.getCumulativeHp()).toBe(80);
});

test("friendly fire subtracts from a stand's value", () => {
    const f = board(true);
    expect(estimateFireBreathMeleePotential(f.attacker, f.target, f.context, f.stand, f.actions)!.netDamage).toBe(20);
});

test("a fire-immune blocker stops the whole breath tail", () => {
    const f = board(false, true);
    expect(estimateFireBreathMeleePotential(f.attacker, f.target, f.context, f.stand, f.actions)!.netDamage).toBe(100);
});

test("Covenant blocks the fire tail without breaking; Water Shield lets fire through", () => {
    for (const covenant of [true, false]) {
        const f = lastFuseBoard({
            fuse: false,
            attacker: { abilities: ["Fire Breath", "Fire Element"], stackPower: 100, damageMin: 100, damageMax: 100 },
            target: { maxHp: 1000, abilities: covenant ? ["Ember Covenant Blessing"] : [] },
            neighbor: { maxHp: 1000, abilities: ["Water Shield"] },
        });
        if (covenant) f.unitsHolder.seedEmberCovenant();
        const before = f.neighbor.getCumulativeHp();
        const result = estimateFireBreathMeleePotential(f.attacker, f.target, f.context, f.stand, f.actions)!;
        expect(result.netDamage).toBe(covenant ? 0 : 200);
        setDeterministicRandomSource(() => 0);
        processFireBreathAbility(
            f.attacker,
            f.target,
            new SceneLogMock(),
            f.unitsHolder,
            f.grid,
            "attk",
            f.damageStatisticHolder,
            f.stand,
        );
        expect(before - f.neighbor.getCumulativeHp()).toBe(covenant ? 0 : 100);
    }
});

test("research catalog alone carries whole-impact metadata", () => {
    const f = board();
    const incumbent = [{ type: "defend_turn" as const, unitId: f.attacker.getId() }];
    const value = (enabled: boolean) =>
        enumerateCandidates(f.attacker, f.context, incumbent, { researchFireBreathValue: enabled }).candidates.find(
            (c) =>
                c.kind === "melee" &&
                c.targetId === f.target.getId() &&
                c.standCell?.x === f.stand.x &&
                c.standCell.y === f.stand.y,
        )!.features.expectedDamage;
    expect(value(false)).toBe(100);
    expect(value(true)).toBe(180);
});
