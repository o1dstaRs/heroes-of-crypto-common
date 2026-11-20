import { expect, test } from "bun:test";

import {
    A19_SHOOTERLESS_MOVEMENT_POLICY,
    a19ShooterlessAugments,
    isA19ShooterlessArmy,
} from "../../src/ai/setup/a19_shooterless_setup";
import type { ISetupAugmentChoice } from "../../src/ai/setup/setup_ship";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;
const brawlers = [C.SQUIRE, C.BERSERKER, C.HYENA, C.NOMAD, C.CRUSADER, C.CHAMPION];
const oneShooter = [C.SQUIRE, C.BERSERKER, C.HYENA, C.NOMAD, C.CRUSADER, C.GARGANTUAN];
const anchor: ISetupAugmentChoice[] = [
    { kind: "Armor", value: 3 },
    { kind: "Might", value: 3 },
    { kind: "Sniper", value: 1 },
];

test("the policy has a stable identity", () => {
    expect(A19_SHOOTERLESS_MOVEMENT_POLICY).toBe("a19-shooterless-movement-v1");
});

test("an army is shooterless only when every known creature attacks in melee", () => {
    expect(isA19ShooterlessArmy(brawlers)).toBe(true);
    expect(isA19ShooterlessArmy(oneShooter)).toBe(false);
    // A caster without a ranged attack still gets nothing from Sniper.
    expect(isA19ShooterlessArmy([C.SQUIRE, C.WANDERING_MAGE, C.HEALER])).toBe(true);
    expect(isA19ShooterlessArmy([])).toBe(false);
    expect(isA19ShooterlessArmy([C.SQUIRE, 999_999])).toBe(false);
});

test("a melee army's Sniper point becomes Movement, after Armor and Might", () => {
    expect(a19ShooterlessAugments(anchor, brawlers)).toEqual([
        { kind: "Movement", value: 1 },
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 3 },
    ]);
    // Split stacks repeat a creature; the answer is the same.
    expect(a19ShooterlessAugments(anchor, [...brawlers, C.SQUIRE, C.SQUIRE])).toEqual(
        a19ShooterlessAugments(anchor, brawlers),
    );
});

test("an army with a shooter, or a plan without Sniper, is returned unchanged in its own order", () => {
    expect(a19ShooterlessAugments(anchor, oneShooter)).toEqual(anchor);
    const six: ISetupAugmentChoice[] = [
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 3 },
    ];
    expect(a19ShooterlessAugments(six, brawlers)).toEqual(six);
    expect(a19ShooterlessAugments([], brawlers)).toEqual([]);
});

test("a plan that already buys Placement or Movement is left alone", () => {
    const delivery: ISetupAugmentChoice[] = [
        { kind: "Placement", value: 1 },
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 2 },
        { kind: "Sniper", value: 1 },
    ];
    expect(a19ShooterlessAugments(delivery, brawlers)).toEqual(delivery);
    const moved: ISetupAugmentChoice[] = [
        { kind: "Movement", value: 1 },
        { kind: "Armor", value: 3 },
        { kind: "Sniper", value: 3 },
    ];
    expect(a19ShooterlessAugments(moved, brawlers)).toEqual(moved);
});

test("more than two Sniper levels overflow into Placement and the total is preserved", () => {
    const heavy: ISetupAugmentChoice[] = [
        { kind: "Sniper", value: 3 },
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 1 },
    ];
    const plan = a19ShooterlessAugments(heavy, brawlers);
    expect(plan).toEqual([
        { kind: "Placement", value: 1 },
        { kind: "Movement", value: 2 },
        { kind: "Armor", value: 3 },
        { kind: "Might", value: 1 },
    ]);
    expect(plan.reduce((sum, entry) => sum + entry.value, 0)).toBe(7);
});

test("the input plan is never mutated", () => {
    const frozen = Object.freeze(anchor.map((entry) => Object.freeze({ ...entry })));
    a19ShooterlessAugments(frozen, brawlers);
    expect(frozen).toEqual(anchor);
});
