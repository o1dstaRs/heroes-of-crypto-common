import { describe, expect, test } from "bun:test";
import { tacticalSplitUnitFromUnit } from "../../src/ai/tactical_split_placement";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import { planHealerResearchSplits, protectHealerResearchPlacement } from "../../src/simulation/healer_split_research";
import { getPositionForCell } from "../../src/grid/grid_math";

const factories = createCombatFactories();
const settings = simulationGridSettings();
const healer = (amount: number, id: string) =>
    createUnitFromSpec(
        { faction: "Life", creatureName: "Healer", level: 2, size: 1, amount },
        PBTypes.TeamVals.LEFT,
        settings,
        factories.abilityFactory,
        factories.effectFactory,
        false,
        id,
    );

describe("Healer-only split research", () => {
    test("does not buy slots, split an already split Healer, or mutate the input", () => {
        const unit = tacticalSplitUnitFromUnit(healer(40, "healer"));
        const before = structuredClone(unit);
        expect(planHealerResearchSplits([unit], 6, "half")).toEqual([]);
        expect(planHealerResearchSplits([unit, { ...unit, id: "child", amount: 1 }], 8, "half")).toEqual([]);
        expect(unit).toEqual(before);
    });
    test("keeps the large healing battery or divides bodies equally according to the frozen arm", () => {
        const unit = tacticalSplitUnitFromUnit(healer(40, "healer"));
        expect(planHealerResearchSplits([unit], 7, "single").map((p) => p.amount)).toEqual([1]);
        expect(planHealerResearchSplits([unit], 7, "half").map((p) => p.amount)).toEqual([20]);
        expect(planHealerResearchSplits([unit], 8, "two-singles").map((p) => p.amount)).toEqual([1, 1]);
        expect(planHealerResearchSplits([unit], 7, "two-singles").map((p) => p.amount)).toEqual([1]);
        expect(planHealerResearchSplits([{ ...unit, amount: 3 }], 8, "half").map((p) => p.amount)).toEqual([1]);
    });
    test("a split copies charges instead of dividing them", () => {
        const source = healer(40, "source"),
            child = healer(20, "child");
        const book = [...source.getUnitProperties().spells];
        source.shareResourcesWithSplit(child, 20);
        source.setAmountAlive(20);
        expect(source.getUnitProperties().spells).toEqual(book);
        expect(child.getUnitProperties().spells).toEqual(book);
        child.useSpell("Spiritual Armor");
        expect(
            child
                .getSpells()
                .find((s) => s.getName() === "Spiritual Armor")!
                .getAmount(),
        ).toBe(1);
        expect(
            source
                .getSpells()
                .find((s) => s.getName() === "Spiritual Armor")!
                .getAmount(),
        ).toBe(2);
    });
    test("halves retain power-three spells on a 1000-exp board; singles retain Armor but not Blessing", () => {
        const halves = [healer(20, "a"), healer(20, "b"), healer(1, "c")];
        const anchor = createUnitFromSpec(
            { faction: "Chaos", creatureName: "Abomination", level: 4, size: 2, amount: 1 },
            PBTypes.TeamVals.RIGHT,
            settings,
            factories.abilityFactory,
            factories.effectFactory,
            false,
            "anchor",
        );
        const units = [...halves, anchor];
        units.forEach((u, i) => {
            const p = getPositionForCell(
                { x: i + 2, y: 2 },
                settings.getMinX(),
                settings.getStep(),
                settings.getHalfStep(),
            );
            u.setPosition(p.x, p.y);
        });
        new FightProperties().setUnitsCalculatedStacksPower(settings, new Map(units.map((u) => [u.getId(), u])));
        expect(halves.map((u) => u.getStackPower())).toEqual([3, 3, 1]);
        const eligible = (index: number) =>
            halves[index]
                .getSpells()
                .filter((s) => s.getMinimalCasterStackPower() <= halves[index].getStackPower())
                .map((s) => s.getName());
        expect(eligible(0)).toEqual(["Heal", "Spiritual Armor", "Blessing", "Mass Heal"]);
        expect(eligible(2)).toEqual(["Heal", "Spiritual Armor"]);
        halves[0].setAmountAlive(17);
        halves[1].setAmountAlive(16);
        new FightProperties().setUnitsCalculatedStacksPower(settings, new Map(units.map((u) => [u.getId(), u])));
        expect(halves.map((u) => u.getStackPower())).toEqual([3, 2, 1]);
        halves[0].setAmountAlive(20);
        halves[1].setAmountAlive(20);
        anchor.setAmountAlive(2);
        new FightProperties().setUnitsCalculatedStacksPower(settings, new Map(units.map((u) => [u.getId(), u])));
        expect(halves.map((u) => u.getStackPower())).toEqual([2, 2, 1]);
    });
    for (const sideOrientedPlacement of [false, true])
        for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
            test(`protects both Healers without moving the carry: side=${sideOrientedPlacement}, team=${team}`, () => {
                const xy = (along: number, lateral: number) =>
                    sideOrientedPlacement ? { x: along, y: lateral } : { x: lateral, y: along };
                const rear = team === PBTypes.TeamVals.LEFT ? 0 : 15;
                const front = team === PBTypes.TeamVals.LEFT ? 2 : 13;
                const incumbent = new Map([
                    ["carry", xy(front, 8)],
                    ["main", xy(front, 7)],
                    ["child", xy(front, 0)],
                ]);
                const units = [
                    { id: "carry", name: "Troll", amount: 25, small: true },
                    { id: "main", name: "Healer", amount: 20, small: true },
                    { id: "child", name: "Healer", amount: 20, small: true },
                ];
                const legalCellHashes = new Set(
                    Array.from({ length: 16 }, (_, i) => {
                        const c = xy(rear, i);
                        return (c.x << 4) | c.y;
                    }),
                );
                const result = protectHealerResearchPlacement(incumbent, units, {
                    team,
                    sideOrientedPlacement,
                    legalCellHashes,
                });
                expect(result.get("carry")).toEqual(incumbent.get("carry"));
                for (const id of ["main", "child"])
                    expect(sideOrientedPlacement ? result.get(id)!.x : result.get(id)!.y).toBe(rear);
                expect(result.get("main")).not.toEqual(result.get("child"));
                expect(incumbent.get("child")).toEqual(xy(front, 0));
                expect(
                    protectHealerResearchPlacement(incumbent, units, {
                        team,
                        sideOrientedPlacement,
                        legalCellHashes: new Set(),
                    }),
                ).toEqual(incumbent);
            });
        }
});
