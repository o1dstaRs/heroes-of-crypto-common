import { afterEach, expect, test } from "bun:test";
import { enumerateCandidates } from "../../src/ai/candidates";
import { estimateRangedShieldSequence, type IShieldSequenceImpact } from "../../src/ai/ranged_shield_sequence";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createTestUnit } from "../helpers/combat";
import { lastFuseBoard } from "../helpers/last_fuse";

const options = { nativeSecondVolley: true, echoChance: 0, spendsOnHitOnly: true, throughShot: false };
afterEach(() => setDeterministicRandomSource(undefined));
function fixture() {
    const f = lastFuseBoard({
        ranged: true,
        fuse: false,
        attacker: { abilities: ["Double Shot"] },
        target: { maxHp: 1000, abilities: ["Ember Covenant Blessing", "Water Shield"] },
    });
    f.unitsHolder.seedEmberCovenant();
    const impact: IShieldSequenceImpact = {
        unit: f.target,
        hp: 1000,
        hitChance: 1,
        firstDamage: 1000,
        secondDamage: 1000,
    };
    return { ...f, impact };
}

test("two personal/shared layers consume both volleys; the real engine confirms zero HP damage", () => {
    const f = fixture();
    let rng = 0;
    setDeterministicRandomSource(() => {
        rng++;
        return 0;
    });
    expect(estimateRangedShieldSequence(f.attacker, [f.impact], f.target, options).get(f.target.getId())).toBe(0);
    expect(rng).toBe(0);
    expect(f.target.willWaterShieldAbsorb(f.attacker)).toBe(true);
    expect(f.target.willEmberCovenantBlock(f.attacker)).toBe(true);
    const hp = f.target.getCumulativeHp(),
        arrows = f.attacker.getRangeShots();
    f.fire();
    expect(hp - f.target.getCumulativeHp()).toBe(0);
    expect(arrows - f.attacker.getRangeShots()).toBe(2);
});

test("research catalog fixes the reproduced estimate while default catalog remains unchanged", () => {
    const f = fixture();
    const incumbent = [{ type: "defend_turn" as const, unitId: f.attacker.getId() }];
    const shot = (enabled: boolean) =>
        enumerateCandidates(f.attacker, f.context, incumbent, {
            researchRangedShieldSequence: enabled,
        }).candidates.find((c) => c.kind === "shot" && c.targetId === f.target.getId())!;
    expect(shot(false).features.expectedDamage).toBeGreaterThan(0);
    expect(shot(true).features.expectedDamage).toBe(0);
});

test("Echo can deal damage only after both shields have been spent", () => {
    const f = fixture();
    expect(
        estimateRangedShieldSequence(f.attacker, [f.impact], f.target, { ...options, echoChance: 0.25 }).get(
            f.target.getId(),
        ),
    ).toBe(250);
});

test("misses preserve both shields and ammunition budgets", () => {
    const f = fixture();
    f.impact.hitChance = 0.5;
    expect(estimateRangedShieldSequence(f.attacker, [f.impact], f.target, options).get(f.target.getId())).toBe(0);
    expect(
        estimateRangedShieldSequence(f.attacker, [f.impact], f.target, { ...options, echoChance: 1 }).get(
            f.target.getId(),
        ),
    ).toBe(125);
});

test("a shared shield is consumed once across victims, not once for each victim", () => {
    const f = fixture();
    f.target.deleteBuff("Water Shield");
    const b = createTestUnit({ team: f.target.getTeam(), maxHp: 1000 });
    // Reuse the actual seeded buff object, without changing the live holder during the projection.
    b.willEmberCovenantBlock = () => true;
    const second = { ...f.impact, unit: b };
    const damage = estimateRangedShieldSequence(f.attacker, [f.impact, second], f.target, {
        ...options,
        nativeSecondVolley: false,
        spendsOnHitOnly: false,
    });
    expect(damage.get(f.target.getId())).toBe(0);
    expect(damage.get(b.getId())).toBe(1000);
});

test("a first victim's miss keeps the Covenant for the next victim", () => {
    const f = fixture();
    f.target.deleteBuff("Water Shield");
    f.impact.hitChance = 0.5;
    const b = createTestUnit({ team: f.target.getTeam(), maxHp: 1000 });
    b.willEmberCovenantBlock = () => true;
    const damage = estimateRangedShieldSequence(
        f.attacker,
        [f.impact, { ...f.impact, unit: b, hitChance: 1 }],
        f.target,
        { ...options, nativeSecondVolley: false, spendsOnHitOnly: false },
    );
    expect(damage.get(b.getId())).toBe(500);
});

test("ordinary Fire Element arrows bypass Water Shield but still spend Covenant", () => {
    const f = fixture();
    f.attacker.hasAbilityActive = (name) => name === "Fire Element";
    expect(estimateRangedShieldSequence(f.attacker, [f.impact], f.target, options).get(f.target.getId())).toBe(1000);
});

test("water bypasses Covenant but spends the victim's Water Shield", () => {
    const f = fixture();
    f.attacker.hasAbilityActive = (name) => name === "Water Element";
    expect(estimateRangedShieldSequence(f.attacker, [f.impact], f.target, options).get(f.target.getId())).toBe(1000);
});

test("opposing teams do not share Covenant consumption", () => {
    const f = fixture();
    f.target.deleteBuff("Water Shield");
    const ally = createTestUnit({ team: f.attacker.getTeam(), maxHp: 1000 });
    ally.willEmberCovenantBlock = () => true;
    const damage = estimateRangedShieldSequence(f.attacker, [f.impact, { ...f.impact, unit: ally }], f.target, {
        ...options,
        nativeSecondVolley: false,
        spendsOnHitOnly: false,
    });
    expect([...damage.values()]).toEqual([0, 0]);
    expect(f.attacker.getTeam()).toBe(PBTypes.TeamVals.LEFT);
});
