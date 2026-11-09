import { describe, expect, test } from "bun:test";
import { planTacticalStackSplits, tacticalSplitUnitFromUnit } from "../../src/ai/tactical_split_placement";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import {
    planWanderingMageResearchSplits,
    protectWanderingMageResearchPlacement,
} from "../../src/simulation/wandering_mage_research";

const factories = createCombatFactories(),
    settings = simulationGridSettings();
const mage = (amount: number, id: string) =>
    createUnitFromSpec(
        { faction: "Chaos", creatureName: "Wandering Mage", level: 1, size: 1, amount },
        PBTypes.TeamVals.LEFT,
        settings,
        factories.abilityFactory,
        factories.effectFactory,
        false,
        id,
    );

describe("Wandering Mage research setup", () => {
    test("retains incumbent order when its single buff child already exists in the plan", () => {
        const caster = tacticalSplitUnitFromUnit(mage(138, "mage"));
        const aura = { ...caster, id: "aura", identity: "Aura test:2", auraUtilityCount: 1, supportSpellCount: 0 };
        const units = [caster, aura],
            before = structuredClone(units);
        expect(planWanderingMageResearchSplits(units, 8, "one-buff")).toEqual(planTacticalStackSplits(units, 8));
        expect(units).toEqual(before);
        expect(planWanderingMageResearchSplits(units, 8, "two-buffs").map((p) => [p.sourceUnitId, p.amount])).toEqual([
            ["mage", 1],
            ["mage", 1],
        ]);
    });
    test("never buys capacity, consumes the last creature, or splits an existing child again", () => {
        const caster = tacticalSplitUnitFromUnit(mage(138, "mage"));
        expect(planWanderingMageResearchSplits([caster], 6, "two-buffs")).toEqual([]);
        expect(planWanderingMageResearchSplits([caster], 7, "two-buffs")).toHaveLength(1);
        expect(planWanderingMageResearchSplits([{ ...caster, amount: 2 }], 8, "two-buffs")).toHaveLength(1);
        expect(planWanderingMageResearchSplits([{ ...caster, amount: 1 }], 8, "two-buffs")).toEqual([]);
        expect(
            planWanderingMageResearchSplits([caster, { ...caster, id: "child", amount: 1 }], 8, "two-buffs"),
        ).toEqual([]);
    });
    test("single children receive two independent Fireforged charges and the complete book", () => {
        const parent = mage(138, "main"),
            child = mage(1, "child");
        const book = [...parent.getUnitProperties().spells];
        parent.shareResourcesWithSplit(child, 1);
        parent.setAmountAlive(137);
        expect(child.getUnitProperties().spells).toEqual(book);
        expect(parent.getUnitProperties().spells).toEqual(book);
        child.useSpell("Fireforged Sword");
        expect(
            child
                .getSpells()
                .find((s) => s.getName() === "Fireforged Sword")!
                .getAmount(),
        ).toBe(1);
        expect(
            parent
                .getSpells()
                .find((s) => s.getName() === "Fireforged Sword")!
                .getAmount(),
        ).toBe(2);
    });
    test("halves lose Smoke while one-body splits retain the main stack's higher-power spells", () => {
        const casters = [mage(136, "main"), mage(69, "half"), mage(1, "single")];
        const anchor = createUnitFromSpec(
            { faction: "Chaos", creatureName: "Abomination", level: 4, size: 2, amount: 1 },
            PBTypes.TeamVals.RIGHT,
            settings,
            factories.abilityFactory,
            factories.effectFactory,
            false,
            "anchor",
        );
        const units = [...casters, anchor];
        units.forEach((u, i) => {
            const p = getPositionForCell(
                { x: i + 2, y: 2 },
                settings.getMinX(),
                settings.getStep(),
                settings.getHalfStep(),
            );
            u.setPosition(p.x, p.y);
        });
        const recalc = () =>
            new FightProperties().setUnitsCalculatedStacksPower(settings, new Map(units.map((u) => [u.getId(), u])));
        recalc();
        expect(casters.map((u) => u.getStackPower())).toEqual([5, 3, 1]);
        const names = (index: number) =>
            casters[index]
                .getSpells()
                .filter((s) => s.getMinimalCasterStackPower() <= casters[index].getStackPower())
                .map((s) => s.getName());
        expect(names(0)).toContain("Smoke");
        expect(names(1)).not.toContain("Smoke");
        expect(names(1)).toContain("Fireball");
        expect(names(2)).toEqual(["Misfortune", "Fireforged Sword"]);
        for (const [amount, power] of [
            [84, 4],
            [83, 3],
            [56, 3],
            [55, 2],
        ]) {
            casters[0].setAmountAlive(amount);
            recalc();
            expect(casters[0].getStackPower()).toBe(power);
        }
        casters[0].setAmountAlive(136);
        anchor.setAmountAlive(2);
        recalc();
        expect(casters[0].getStackPower()).toBe(3);
    });
    for (const sideOrientedPlacement of [false, true])
        for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
            test(`rear positions preserve other unit footprints: side=${sideOrientedPlacement}, team=${team}`, () => {
                const xy = (depth: number, lateral: number) =>
                    sideOrientedPlacement ? { x: depth, y: lateral } : { x: lateral, y: depth };
                const rear = team === PBTypes.TeamVals.LEFT ? 0 : 15,
                    front = team === PBTypes.TeamVals.LEFT ? 2 : 13;
                const incumbent = new Map([
                    ["carry", xy(front, 8)],
                    ["main", xy(front, 7)],
                    ["child", xy(front, 0)],
                ]);
                const units = [
                    { id: "carry", name: "Goblin Knight", amount: 9, small: true },
                    { id: "main", name: "Wandering Mage", amount: 137, small: true },
                    { id: "child", name: "Wandering Mage", amount: 1, small: true },
                ];
                const legalCellHashes = new Set(
                    Array.from({ length: 16 }, (_, i) => {
                        const c = xy(rear, i);
                        return (c.x << 4) | c.y;
                    }),
                );
                const result = protectWanderingMageResearchPlacement(incumbent, units, {
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
                    protectWanderingMageResearchPlacement(incumbent, units, {
                        team,
                        sideOrientedPlacement,
                        legalCellHashes: new Set(),
                    }),
                ).toEqual(incumbent);
            });
        }
    test("the separate lateral option retains an existing safe corner instead of recentering it", () => {
        const incumbent = new Map([
            ["main", { x: 0, y: 0 }],
            ["child", { x: 2, y: 14 }],
        ]);
        const units = [
            { id: "main", name: "Wandering Mage", amount: 138, small: true },
            { id: "child", name: "Wandering Mage", amount: 1, small: true },
        ];
        const context = {
            team: PBTypes.TeamVals.LEFT,
            sideOrientedPlacement: true,
            legalCellHashes: new Set(Array.from({ length: 16 }, (_, y) => y)),
        };
        const lateral = protectWanderingMageResearchPlacement(incumbent, units, {
            ...context,
            retainLateralPosition: true,
        });
        expect(lateral.get("main")).toEqual({ x: 0, y: 0 });
        expect(lateral.get("child")).toEqual({ x: 0, y: 14 });
        expect(protectWanderingMageResearchPlacement(incumbent, units, context).get("main")).toEqual({ x: 0, y: 7 });
        expect(incumbent.get("child")).toEqual({ x: 2, y: 14 });
    });
});
