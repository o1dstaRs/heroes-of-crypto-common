import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    RUSH_RECIPES,
    chaosTypes,
    fundRushPlan,
    hasRushTarget,
    isRushBackliner,
    isRushMobile,
    rushCreaturePool,
    rushFootprint,
    rushForwardFormation,
} from "../../src/simulation/chaos_rush_research";

const id = (name: string) => creatureIdForName(name)!;
describe("offline offensive rush admission", () => {
    test("the unqualified research remains outside serving setup and combat", () => {
        for (const path of [
            "src/index.ts",
            "src/ai/setup/setup_ship.ts",
            "src/ai/candidates.ts",
            "src/simulation/battle_engine.ts",
            "src/simulation/search_driver.ts",
        ]) {
            const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
            expect(source).not.toContain("chaos_rush_research");
            expect(source).not.toContain("__rushPlacement");
        }
    });
    test("support casters are not confused with damaging backliners; flying Griffin is mobile", () => {
        expect(isRushBackliner(id("Healer"))).toBe(false);
        expect(isRushBackliner(id("Battle Mage"))).toBe(true);
        expect(isRushMobile(id("Griffin"))).toBe(true);
        expect(isRushMobile(id("Beholder"))).toBe(false);
    });
    test("unrevealed opponent and a single low-tier shooter cannot trigger a draft override", () => {
        const available = [id("Efreet"), id("Elf")];
        for (const knownOpponentCreatureIds of [[], [id("Orc")]])
            expect(
                rushCreaturePool(
                    "chaos-mobile",
                    available,
                    { ownCreatureIds: [id("Scavenger")], knownOpponentCreatureIds },
                    true,
                ),
            ).toBe(available);
        expect(hasRushTarget([id("Magic Dragon")])).toBe(true);
    });
    test("Chaos completion requires the actual Movement variant and counts distinct types", () => {
        const own = [id("Scavenger"), id("Scavenger")],
            available = [id("Troll"), id("Valkyrie")];
        const context = { ownCreatureIds: own, knownOpponentCreatureIds: [id("Magic Dragon")] };
        expect(chaosTypes(own)).toBe(1);
        expect(rushCreaturePool("chaos-mobile", available, context, true)).toEqual([id("Troll")]);
        expect(rushCreaturePool("chaos-mobile", available, context, false)).toEqual([id("Valkyrie")]);
        expect(rushCreaturePool("mobile", available, context, true)).toEqual([id("Valkyrie")]);
    });
    test("every fixed plan pays the complete real budget without free Placement or movement", () => {
        for (const recipe of RUSH_RECIPES)
            if ("placement" in recipe)
                for (const budget of [5, 6, 7]) {
                    const plan = fundRushPlan(recipe, budget, [id("Champion"), id("Unicorn")]);
                    expect(plan.reduce((sum, a) => sum + a.value, 0)).toBe(budget);
                    expect(plan.find((a) => a.kind === "Placement")!.value).toBe(recipe.placement);
                    expect(plan.find((a) => a.kind === "Movement")!.value).toBe(recipe.movement);
                    expect(
                        plan.every(
                            (a) =>
                                Number.isInteger(a.value) &&
                                a.value >= 0 &&
                                a.value <= (a.kind === "Placement" || a.kind === "Movement" ? 2 : 3),
                        ),
                    ).toBe(true);
                }
        expect(fundRushPlan(RUSH_RECIPES[8], 5, []).filter((a) => a.value)).toEqual([
            { kind: "Placement", value: 2 },
            { kind: "Movement", value: 2 },
            { kind: "Armor", value: 1 },
        ]);
    });
    test("forward placement preserves rectangular footprints, blockers, support units and lateral bounds", () => {
        const allowed = Array.from({ length: 48 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6) }));
        const bodies = [
            { id: "large", x: 1, y: 2, width: 2, height: 2, eligible: true },
            { id: "support", x: 0, y: 5, width: 1, height: 1, eligible: false },
        ];
        const blocked = [
            { x: 5, y: 2 },
            { x: 5, y: 3 },
        ];
        const moved = rushForwardFormation(bodies, allowed, blocked, 1);
        expect(moved[1]).toEqual(bodies[1]);
        expect(moved[0].x).toBeGreaterThan(bodies[0].x);
        expect(Math.abs(moved[0].y - bodies[0].y)).toBeLessThanOrEqual(2);
        const occupied = [...blocked, ...moved.flatMap((body) => rushFootprint(body))].map((c) => `${c.x},${c.y}`);
        expect(new Set(occupied).size).toBe(occupied.length);
        expect(bodies[0].x).toBe(1);
        const mirrored = bodies.map((b) => ({ ...b, x: 15 - b.x + b.width - 1 }));
        const reverse = rushForwardFormation(
            mirrored,
            allowed.map((c) => ({ x: 15 - c.x, y: c.y })),
            blocked.map((c) => ({ x: 15 - c.x, y: c.y })),
            -1,
        );
        expect(reverse.map((b) => ({ ...b, x: 15 - b.x + b.width - 1 }))).toEqual(moved);
    });
});
