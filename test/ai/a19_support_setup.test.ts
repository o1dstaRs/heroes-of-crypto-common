import { expect, test } from "bun:test";
import { finalizeA19Placement, finalizePlacement, type PlacementEnvelope } from "../../src/ai/placement/adapter";
import { chooseA19HealerSplitMode, planA19SupportSplits } from "../../src/ai/support_setup";
import { tacticalSplitUnitFromUnit } from "../../src/ai/tactical_split_placement";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import { simulationGridSettings } from "../../src/simulation/battle_engine";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { planHealerResearchSplits, protectHealerResearchPlacement } from "../../src/simulation/healer_split_research";
import {
    planWanderingMageResearchSplits,
    protectWanderingMageResearchPlacement,
} from "../../src/simulation/wandering_mage_research";
import { planA19HealerSplits, protectA19HealerPlacement } from "../../src/ai/healer_support_setup";
import { planA19WanderingMageSplits, protectA19WanderingMagePlacement } from "../../src/ai/wandering_mage_support";

const factories = createCombatFactories();
const settings = simulationGridSettings();
const unit = (name: string, faction: string, amount: number, level: number, size: number) =>
    tacticalSplitUnitFromUnit(
        createUnitFromSpec(
            { creatureName: name, faction, amount, level, size },
            PBTypes.TeamVals.LEFT,
            settings,
            factories.abilityFactory,
            factories.effectFactory,
            false,
            name,
        ),
    );
const roster = () => [
    unit("Healer", "Life", 40, 2, 1),
    unit("Wandering Mage", "Chaos", 138, 1, 1),
    unit("Peasant", "Life", 166, 1, 1),
    unit("Troll", "Chaos", 24, 2, 1),
    unit("Goblin Knight", "Chaos", 7, 3, 1),
    unit("Abomination", "Chaos", 1, 4, 2),
];

test("Healer alternatives retain the measured split rules, and Mage reserves its minimum buff child", () => {
    const units = roster();
    for (const cap of [6, 7, 8, 9]) {
        for (const mode of ["single", "half", "two-singles"] as const)
            expect(planA19HealerSplits(units, cap, mode)).toEqual(planHealerResearchSplits(units, cap, mode));
        expect(planA19WanderingMageSplits(units, cap)).toEqual(planWanderingMageResearchSplits(units, cap, "one-buff"));
    }
    expect(chooseA19HealerSplitMode(units, 2)).toBe("half");
    const weakHealer = units.map((u) => (u.identity === "Healer:2" ? { ...u, amount: 16 } : u));
    expect(chooseA19HealerSplitMode(weakHealer, 2)).toBe("two-singles");
    expect(chooseA19HealerSplitMode(weakHealer, 1)).toBe("single");
    expect(planA19SupportSplits(units, 6)).toEqual([]);
    const shared = planA19SupportSplits(units, 8);
    expect(shared.map((p) => [p.sourceUnitId, p.amount])).toEqual([
        ["Healer", 20],
        ["Wandering Mage", 1],
    ]);
    expect(planA19SupportSplits(weakHealer, 9).map((p) => [p.sourceUnitId, p.amount])).toEqual([
        ["Healer", 1],
        ["Healer", 1],
        ["Wandering Mage", 1],
    ]);
    const alreadySplit = [
        ...units.map((u) => ({ ...u, amount: Math.max(1, u.amount - 1) })),
        { ...units[0], id: "healer-child", amount: 1 },
        { ...units[1], id: "mage-child", amount: 1 },
    ];
    expect(
        planA19SupportSplits(alreadySplit, 10).some((p) =>
            ["Healer", "Wandering Mage", "healer-child", "mage-child"].includes(p.sourceUnitId),
        ),
    ).toBe(false);
});

for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
    test(`combined final protection is legal, detached and leaves every other footprint fixed on team ${team}`, () => {
        const rear = team === PBTypes.TeamVals.LEFT ? 0 : 15;
        const front = team === PBTypes.TeamVals.LEFT ? 2 : 13;
        const bodies = [
            { id: "healer", name: "Healer", amount: 20, small: true },
            { id: "mage", name: "Wandering Mage", amount: 137, small: true },
            { id: "mage-child", name: "Wandering Mage", amount: 1, small: true },
            { id: "carry", name: "Abomination", amount: 2, small: false, footprintWidth: 2, footprintHeight: 2 },
        ];
        const formation = new Map([
            ["healer", { x: front, y: 6 }],
            ["mage", { x: front, y: 0 }],
            ["mage-child", { x: front, y: 15 }],
            ["carry", { x: front, y: 10 }],
        ]);
        const context: PlacementEnvelope = {
            team,
            sideOrientedPlacement: true,
            gridType: 1,
            doctrine: 1,
            artifacts: [1, 1],
            augments: [],
            publicOpponentCreatureIds: [],
            legalCellHashes: new Set(Array.from({ length: 16 }, (_, y) => (rear << 4) | y)),
        };
        const oldHealer = protectHealerResearchPlacement(formation, bodies, context);
        expect(protectA19HealerPlacement(formation, bodies, context)).toEqual(oldHealer);
        const combined = protectWanderingMageResearchPlacement(oldHealer, bodies, {
            ...context,
            retainLateralPosition: true,
        });
        expect(protectA19WanderingMagePlacement(oldHealer, bodies, context)).toEqual(combined);
        const units = bodies.map((b) => ({
            getId: () => b.id,
            getName: () => b.name,
            getAmountAlive: () => b.amount,
            getFootprintWidth: () => b.footprintWidth ?? 1,
            getFootprintHeight: () => b.footprintHeight ?? 1,
        }));
        expect(finalizePlacement(units, context, formation)).toEqual(formation);
        const result = finalizeA19Placement(units, context, formation);
        expect(result).toEqual(combined);
        expect(result.get("carry")).toEqual(formation.get("carry"));
        expect(result.get("mage")).toEqual({ x: rear, y: 0 });
        expect(new Set([...result.values()].map((p) => `${p.x}:${p.y}`)).size).toBe(result.size);
        expect(finalizeA19Placement(units, context, result)).toEqual(result);
        expect(formation.get("mage")).toEqual({ x: front, y: 0 });
        expect(finalizeA19Placement(units, { ...context, legalCellHashes: new Set() }, formation)).toEqual(formation);
    });
}
