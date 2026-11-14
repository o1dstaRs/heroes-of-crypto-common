import { describe, expect, it } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    EMPOWER_SETUP_FEATURES,
    EMPOWER_SETUP_SCHEMA,
    empowerSetupFeatures,
    empowerSetupPlan,
    selectEmpowerSetup,
    type IEmpowerSetupModel,
} from "../../src/ai/setup/empower_setup";
import { conditionalAugments } from "../../src/ai/setup/setup_conditional";

const roster = (names: string[]) =>
    names.map((name) => {
        const id = creatureIdForName(name);
        if (id === undefined) throw new Error(name);
        return id;
    });
const magic = roster(["Wandering Mage", "Squire", "Battle Mage", "Healer", "Ogre Mage", "Magic Dragon"]);
const support = roster(["Squire", "Peasant", "Healer", "Troll", "Ogre Mage", "Angel"]);
const model = (gain = 0): IEmpowerSetupModel => ({
    schema: EMPOWER_SETUP_SCHEMA,
    features: EMPOWER_SETUP_FEATURES,
    heads: [1, 2, 3].map(() => ({ b: gain, w: EMPOWER_SETUP_FEATURES.map(() => 0) })),
    margin: 0.03,
});

describe("funded own-roster Empower setup", () => {
    it("recognizes real damage spells, excluding support spells and magic-melee labels", () => {
        expect(empowerSetupFeatures(7, magic)).toHaveLength(EMPOWER_SETUP_FEATURES.length);
        expect(empowerSetupFeatures(7, support)).toBeUndefined();
        expect(selectEmpowerSetup(model(1), 7, support)).toBe(0);
        const wall = roster(["Squire", "Peasant", "Healer", "Troll", "Nightmare", "Angel"]);
        expect(empowerSetupFeatures(7, wall)).toHaveLength(EMPOWER_SETUP_FEATURES.length);
        expect(selectEmpowerSetup(model(1), 7, wall)).toBe(1);
    });
    it("retains the exact incumbent at level zero and pays for each other level at every doctrine budget", () => {
        for (const budget of [5, 6, 7]) {
            expect(empowerSetupPlan(budget, magic, 0)).toEqual(conditionalAugments(budget, magic, new Set(["sniper"])));
            for (const level of [1, 2, 3]) {
                const plan = empowerSetupPlan(budget, magic, level);
                expect(plan.reduce((sum, entry) => sum + entry.value, 0)).toBe(budget);
                expect(plan.find((entry) => entry.kind === "Empower")?.value).toBe(level);
                expect(plan.every((entry) => entry.value >= 1 && entry.value <= 3)).toBe(true);
                expect(plan.some((entry) => entry.kind === "Placement" || entry.kind === "Movement")).toBe(false);
            }
        }
    });
    it("rejects malformed, incomplete, duplicate or summoned rosters", () => {
        for (const own of [
            magic.slice(1),
            [...magic, magic[0]],
            magic.map(() => magic[0]),
            [999, ...magic.slice(1)],
            [45, ...magic.slice(1)],
        ]) {
            expect(empowerSetupFeatures(7, own)).toBeUndefined();
            expect(selectEmpowerSetup(model(1), 7, own)).toBe(0);
        }
        expect(() => empowerSetupPlan(8, magic, 1)).toThrow();
        expect(() => empowerSetupPlan(5, magic, 4)).toThrow();
    });
    it("requires a predicted gain beyond the frozen margin and retains the cheaper level on ties", () => {
        expect(selectEmpowerSetup(model(0.03), 7, magic)).toBe(0);
        expect(selectEmpowerSetup(model(0.04), 7, magic)).toBe(1);
        const fitted = model();
        fitted.heads[2].b = 0.1;
        expect(selectEmpowerSetup(fitted, 7, magic)).toBe(3);
        fitted.heads[2].b = NaN;
        expect(() => selectEmpowerSetup(fitted, 7, magic)).toThrow();
    });
});
