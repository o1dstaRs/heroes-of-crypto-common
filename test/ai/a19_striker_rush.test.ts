import { expect, test } from "bun:test";

import {
    A19_STRIKER_RUSH_POLICY,
    a19StrikerCount,
    a19StrikerRushAugments,
    a19StrikerRushBundle,
    a19StrikerRushDraftPool,
    a19StrikerRushFormation,
    isA19FastStriker,
    isA19StrikerRushSetup,
    type IA19StrikerRushBody,
} from "../../src/ai/setup/a19_striker_rush";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const C = PBTypes.CreatureVals;
// The two armies of the live game the policy was learned from.
const rushers = [C.SQUIRE, C.WANDERING_MAGE, C.HYENA, C.MANTICORE, C.EFREET, C.MAGIC_DRAGON];
const shooters = [C.SCAVENGER, C.DRYAD, C.MEDUSA, C.BEHOLDER, C.ZENA, C.GARGANTUAN];
const brawlers = [C.SQUIRE, C.BERSERKER, C.HYENA, C.NOMAD, C.CRUSADER, C.CHAMPION];

test("the policy has a stable identity", () => {
    expect(A19_STRIKER_RUSH_POLICY).toBe("a19-striker-rush-v1");
});

test("fast strikers fly or have five printed steps; shooters and casters are never strikers", () => {
    expect(isA19FastStriker(C.EFREET)).toBe(true);
    expect(isA19FastStriker(C.MANTICORE)).toBe(true);
    expect(isA19FastStriker(C.BERSERKER)).toBe(true);
    expect(isA19FastStriker(C.SQUIRE)).toBe(false);
    expect(isA19FastStriker(C.DRYAD)).toBe(false);
    expect(isA19FastStriker(C.WANDERING_MAGE)).toBe(false);
    expect(a19StrikerCount(rushers)).toBe(4);
    expect(a19StrikerCount(shooters)).toBe(1);
    expect(a19StrikerCount(brawlers)).toBe(6);
    // A split stack is still one drafted creature.
    expect(a19StrikerCount([...rushers, C.SQUIRE, C.SQUIRE])).toBe(4);
});

test("the draft head prefers a fast striker, then any striker, and otherwise leaves the choice alone", () => {
    expect(a19StrikerRushDraftPool(C.DRYAD, [C.DRYAD, C.SQUIRE, C.BERSERKER])).toEqual([C.BERSERKER]);
    expect(a19StrikerRushDraftPool(C.DRYAD, [C.DRYAD, C.SQUIRE, C.PEASANT])).toEqual([C.SQUIRE, C.PEASANT]);
    expect(a19StrikerRushDraftPool(C.SQUIRE, [C.DRYAD, C.SQUIRE, C.BERSERKER])).toEqual([C.BERSERKER]);
    expect(a19StrikerRushDraftPool(C.BERSERKER, [C.DRYAD, C.SQUIRE, C.BERSERKER])).toEqual([]);
    expect(a19StrikerRushDraftPool(C.DRYAD, [C.DRYAD, C.ORC, C.WANDERING_MAGE])).toEqual([]);
});

test("the opening bundle with the most strikers wins; the earlier choice is kept on a tie", () => {
    const bundles = [
        [C.DRYAD, C.ORC, 10],
        [C.SQUIRE, C.DRYAD, 4],
        [C.SQUIRE, C.BERSERKER, 5],
        [C.PEASANT, C.BERSERKER, 5],
    ] as const;
    expect(a19StrikerRushBundle(bundles, 0)).toBe(2);
    expect(a19StrikerRushBundle(bundles, 3)).toBe(3);
    expect(a19StrikerRushBundle(bundles.slice(0, 2), 0)).toBe(1);
    expect(a19StrikerRushBundle(bundles.slice(0, 1), 0)).toBe(0);
});

test("the setup is used by a melee army against an army that is not one", () => {
    expect(isA19StrikerRushSetup(rushers, shooters)).toBe(true);
    // The same setup loses to a melee army: keep the native plan there.
    expect(isA19StrikerRushSetup(rushers, brawlers)).toBe(false);
    expect(isA19StrikerRushSetup(brawlers, rushers)).toBe(false);
    // Three strikers are not a melee army.
    expect(isA19StrikerRushSetup(shooters, rushers)).toBe(false);
    expect(isA19StrikerRushSetup([C.SQUIRE, C.HYENA, C.EFREET, C.DRYAD, C.MEDUSA, C.ZENA], shooters)).toBe(false);
    // Partial rosters give no decision.
    expect(isA19StrikerRushSetup(rushers, shooters.slice(0, 5))).toBe(false);
    expect(isA19StrikerRushSetup(rushers.slice(0, 5), shooters)).toBe(false);
});

test("the funded plan is Placement 2 and Movement 2, paid for from the native plan", () => {
    const levels = (plan: readonly { kind: string; value: number }[]) =>
        Object.fromEntries(plan.map((entry) => [entry.kind, entry.value]));
    // The live case: the stock plan for this army is Armor 3 / Might 3 on six points.
    expect(
        levels(
            a19StrikerRushAugments(
                [
                    { kind: "Armor", value: 3 },
                    { kind: "Might", value: 3 },
                ],
                6,
                rushers,
            ),
        ),
    ).toEqual({ Placement: 2, Movement: 2, Armor: 2 });
    expect(
        levels(
            a19StrikerRushAugments(
                [
                    { kind: "Armor", value: 3 },
                    { kind: "Might", value: 2 },
                ],
                5,
                rushers,
            ),
        ),
    ).toEqual({ Placement: 2, Movement: 2, Armor: 1 });
    expect(
        levels(
            a19StrikerRushAugments(
                [
                    { kind: "Armor", value: 3 },
                    { kind: "Might", value: 3 },
                    { kind: "Empower", value: 1 },
                ],
                7,
                rushers,
            ),
        ),
    ).toEqual({ Placement: 2, Movement: 2, Armor: 3 });
    // An army with a shooter keeps one Sniper level until nothing cheaper is left.
    const mixed = [C.SQUIRE, C.HYENA, C.MANTICORE, C.EFREET, C.DRYAD, C.CHAMPION];
    expect(
        levels(
            a19StrikerRushAugments(
                [
                    { kind: "Sniper", value: 3 },
                    { kind: "Armor", value: 3 },
                ],
                6,
                mixed,
            ),
        ),
    ).toEqual({ Placement: 2, Movement: 2, Armor: 1, Sniper: 1 });
    expect(
        levels(
            a19StrikerRushAugments(
                [
                    { kind: "Sniper", value: 3 },
                    { kind: "Armor", value: 2 },
                ],
                5,
                mixed,
            ),
        ),
    ).toEqual({ Placement: 2, Movement: 2, Sniper: 1 });
    // Whatever the native plan, the result spends exactly the budget and never exceeds a cap.
    for (const budget of [5, 6, 7]) {
        const plan = a19StrikerRushAugments(
            [
                { kind: "Sniper", value: 3 },
                { kind: "Armor", value: budget - 3 },
            ],
            budget,
            mixed,
        );
        expect(plan.reduce((sum, entry) => sum + entry.value, 0)).toBe(budget);
        expect(plan.every((entry) => entry.value <= 3)).toBe(true);
    }
    // An unspent native point is not wasted.
    expect(levels(a19StrikerRushAugments([{ kind: "Armor", value: 1 }], 6, rushers))).toEqual({
        Placement: 2,
        Movement: 2,
        Armor: 2,
    });
});

const zone = (xFrom: number, xTo: number, yFrom: number, yTo: number) => {
    const cells: { x: number; y: number }[] = [];
    for (let x = xFrom; x <= xTo; x++) for (let y = yFrom; y <= yTo; y++) cells.push({ x, y });
    return cells;
};
const body = (id: string, x: number, y: number, striker: boolean, width = 1, height = 1): IA19StrikerRushBody => ({
    id,
    x,
    y,
    width,
    height,
    striker,
});

test("strikers start on the edge nearest the enemy, spread over the rows; everything else stays put", () => {
    // Left-hand army in the Placement 2 zone: columns 0-5, all sixteen rows.
    const army = [
        body("squire", 3, 6, true),
        body("mage", 1, 11, false),
        body("hyena", 3, 9, true, 2, 1),
        body("manticore", 3, 14, true, 2, 1),
        body("efreet", 3, 4, true),
        body("dragon", 2, 2, false, 2, 2),
    ];
    const placed = new Map(a19StrikerRushFormation(army, zone(0, 5, 0, 15), [], 1).map((unit) => [unit.id, unit]));
    for (const id of ["squire", "hyena", "manticore", "efreet"]) expect(placed.get(id)!.x).toBe(5);
    // Native row order is kept and the four strikers cover the height of the zone.
    const rows = ["efreet", "squire", "hyena", "manticore"].map((id) => placed.get(id)!.y);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(rows).toEqual([2, 6, 10, 14]);
    expect(placed.get("mage")).toMatchObject({ x: 1, y: 11 });
    expect(placed.get("dragon")).toMatchObject({ x: 2, y: 2 });
});

test("the right-hand army mirrors it and wide bodies put their leading edge on the front column", () => {
    const army = [body("hyena", 13, 4, true, 2, 1), body("squire", 13, 10, true), body("archer", 14, 7, false)];
    const placed = new Map(a19StrikerRushFormation(army, zone(10, 15, 0, 15), [], -1).map((unit) => [unit.id, unit]));
    // Anchor is the top-right cell, so a two-wide body on column 10 is anchored at 11.
    expect(placed.get("hyena")).toMatchObject({ x: 11, y: 4 });
    expect(placed.get("squire")).toMatchObject({ x: 10, y: 12 });
    expect(placed.get("archer")).toMatchObject({ x: 14, y: 7 });
});

test("blocked ground is never used and a displaced body moves to the nearest free cell", () => {
    const army = [body("squire", 3, 8, true), body("scout", 5, 8, false)];
    const blocked = [{ x: 5, y: 7 }];
    const placed = new Map(a19StrikerRushFormation(army, zone(0, 5, 0, 15), blocked, 1).map((unit) => [unit.id, unit]));
    // One striker wants the middle row of the front column; row 7 is a mountain, so it takes row 8.
    expect(placed.get("squire")).toMatchObject({ x: 5, y: 8 });
    // The scout lost its cell to the striker and steps back, not forward.
    const scout = placed.get("scout")!;
    expect(Math.abs(scout.x - 5) + Math.abs(scout.y - 8)).toBe(1);
    expect(`${scout.x},${scout.y}`).not.toBe("5,7");
    const cells = new Set([...placed.values()].map((unit) => `${unit.x},${unit.y}`));
    expect(cells.size).toBe(2);
    expect(() => a19StrikerRushFormation(army, [], [], 1)).toThrow();
});
