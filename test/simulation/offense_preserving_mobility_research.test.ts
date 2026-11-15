import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import type { IPlacementSetupDecisionContext } from "../../src/ai/setup/setup_strategy";
import type { RushAugment } from "../../src/simulation/chaos_rush_research";
import {
    OFFENSE_PRESERVING_MOBILITY_RECIPES as recipes,
    offensePreservingMobilityPlan as plan,
} from "../../src/simulation/offense_preserving_mobility_research";

const ids = (...names: string[]) => names.map((name) => creatureIdForName(name)!);
const own = ids("Scavenger", "Troll", "Elf");
const context: IPlacementSetupDecisionContext = {
    decisionPhase: "placement",
    opponentRosterVisibility: "complete",
    gridType: 1,
    gridSize: 16,
    publicOpponentCreatureIds: ids("Orc", "Beholder"),
    synergyVariants: { Chaos: 1, Life: 1, Might: 1, Nature: 1 },
};
const base = (budget: number): RushAugment[] => [
    { kind: "Placement", value: 0 },
    { kind: "Movement", value: 0 },
    { kind: "Armor", value: 3 },
    { kind: "Sniper", value: Math.min(3, budget - 3) },
    { kind: "Might", value: Math.max(0, budget - 6) },
    { kind: "Empower", value: 0 },
];

test("all doctrines preserve offense and fund mobility from actual incumbent Armor", () => {
    for (const budget of [5, 6, 7])
        for (const recipe of recipes.slice(1)) {
            const before = base(budget);
            const after = plan(recipe, budget, own, context, before);
            expect(after.reduce((sum, a) => sum + a.value, 0)).toBe(budget);
            expect(after.find((a) => a.kind === "Movement")!.value).toBe(recipe.movement);
            expect(after.find((a) => a.kind === "Armor")!.value).toBe(3 - recipe.movement);
            expect(after.filter((a) => a.kind !== "Armor" && a.kind !== "Movement")).toEqual(
                before.filter((a) => a.kind !== "Armor" && a.kind !== "Movement"),
            );
            expect(before).toEqual(base(budget));
        }
});

test("private information and damage-caster armies cannot trigger physical shooter denial", () => {
    const incumbent = base(6);
    expect(plan(recipes[1], 6, own, { ...context, opponentRosterVisibility: "partial" }, incumbent)).toBe(incumbent);
    for (const enemy of [
        ids("Orc", "Orc"),
        ids("Battle Mage", "Magic Dragon"),
        ids("Orc", "Beholder", "Battle Mage", "Magic Dragon"),
    ])
        expect(plan(recipes[1], 6, own, { ...context, publicOpponentCreatureIds: enemy }, incumbent)).toBe(incumbent);
    expect(plan(recipes[1], 6, ids("Scavenger", "Scavenger", "Elf"), context, incumbent)).toBe(incumbent);
});

test("Chaos gate requires an active distinct-type Movement synergy", () => {
    const incumbent = base(6);
    expect(
        plan(recipes[3], 6, own, { ...context, synergyVariants: { ...context.synergyVariants!, Chaos: 2 } }, incumbent),
    ).toBe(incumbent);
    expect(plan(recipes[3], 6, ids("Scavenger", "Scavenger", "Champion"), context, incumbent)).toBe(incumbent);
    expect(plan(recipes[1], 6, ids("Champion", "Unicorn"), context, incumbent)).not.toBe(incumbent);
});

test("partial spending, insufficient Armor and an already purchased level are retained", () => {
    const incumbent = base(6);
    expect(plan(recipes[1], 7, own, context, incumbent)).toBe(incumbent);
    const funded = plan(recipes[2], 6, own, context, incumbent);
    expect(plan(recipes[1], 6, own, context, funded)).toBe(funded);
    const noArmor = incumbent.map((a) => ({
        ...a,
        value: a.kind === "Armor" ? 0 : a.kind === "Empower" ? 3 : a.value,
    }));
    expect(plan(recipes[1], 6, own, context, noArmor)).toBe(noArmor);
});

test("native sparse plans omit zero levels; movement is still fully funded", () => {
    for (const budget of [5, 6, 7]) {
        const sparse = base(budget).filter((a) => a.value > 0);
        const funded = plan(recipes[2], budget, own, context, sparse);
        expect(funded.find((a) => a.kind === "Movement")?.value).toBe(2);
        expect(funded.find((a) => a.kind === "Sniper")?.value).toBe(Math.min(3, budget - 3));
        expect(funded.reduce((sum, a) => sum + a.value, 0)).toBe(budget);
    }
});

test("candidate remains outside serving entry points and preserves the closed rush helper", () => {
    for (const path of [
        "src/index.ts",
        "src/ai/setup/setup_ship.ts",
        "src/ai/candidates.ts",
        "src/simulation/battle_engine.ts",
        "src/simulation/search_driver.ts",
    ])
        expect(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).not.toContain(
            "offense_preserving_mobility_research",
        );
});
