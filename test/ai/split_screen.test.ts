import { afterEach, describe, expect, it } from "bun:test";

import {
    A19_SHIELD_SCREEN_ID,
    A19_SPLIT_SCREEN_ID,
    a19ShieldScreenEnabled,
    a19SplitScreenEnabled,
} from "../../src/ai/split_screen";
import { planA19SupportSplits } from "../../src/ai/support_setup";
import { planTacticalStackSplits, type ITacticalSplitUnit } from "../../src/ai/tactical_split_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const { LEFT, RIGHT } = PBTypes.TeamVals;
const SWITCHES = [
    "A19_SPLIT_SCREEN_LEFT",
    "A19_SPLIT_SCREEN_RIGHT",
    "A19_SHIELD_SCREEN_LEFT",
    "A19_SHIELD_SCREEN_RIGHT",
];
const saved = SWITCHES.map((name) => process.env[name]);
afterEach(() => {
    SWITCHES.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
    });
});

const unit = (overrides: Partial<ITacticalSplitUnit> & Pick<ITacticalSplitUnit, "id">): ITacticalSplitUnit => ({
    id: overrides.id,
    identity: overrides.identity ?? `${overrides.id}:${overrides.level ?? 2}`,
    amount: overrides.amount ?? 5,
    level: overrides.level ?? 2,
    small: overrides.small ?? true,
    summoned: overrides.summoned ?? false,
    attackType: overrides.attackType ?? PBTypes.AttackVals.MELEE,
    steps: overrides.steps ?? 4,
    hpPerCreature: overrides.hpPerCreature ?? 20,
    auraUtilityCount: overrides.auraUtilityCount ?? 0,
    supportSpellCount: overrides.supportSpellCount ?? 0,
    waterShieldUtilityCount: overrides.waterShieldUtilityCount ?? 0,
    rangedCoverCount: overrides.rangedCoverCount ?? 0,
    ...(overrides.footprintCells === undefined ? {} : { footprintCells: overrides.footprintCells }),
});

// The owner's shape: a 1x2 Wolf stack, a shooter and other melee; Placement opens three spare slots (6 + 3 = 9 stacks).
const army = [
    unit({ id: "wolf", identity: "Wolf:1", level: 1, amount: 12, small: false, footprintCells: 2, steps: 6 }),
    unit({
        id: "arbalester",
        identity: "Arbalester:1",
        level: 1,
        amount: 10,
        attackType: PBTypes.AttackVals.RANGE,
        rangedCoverCount: 1,
    }),
    unit({ id: "dryad", identity: "Dryad:1", level: 1, amount: 9 }),
    unit({ id: "griffin", identity: "Griffin:2", level: 2, amount: 6, small: false, footprintCells: 4 }),
    unit({ id: "pikeman", identity: "Pikeman:2", level: 2, amount: 8 }),
    unit({ id: "dragon", identity: "Black Dragon:4", level: 4, amount: 1, small: false, footprintCells: 4 }),
];

describe(A19_SPLIT_SCREEN_ID, () => {
    it("without screen, the planner keeps its shooter cover split and 1x1 bait", () => {
        expect(planTacticalStackSplits(army, 9).map((plan) => [plan.sourceUnitId, plan.role])).toEqual([
            ["arbalester", "cover"],
            ["dryad", "bait"],
            ["dryad", "bait"],
        ]);
    });

    it("with screen, every spare slot is a one-model split of the cheapest body, the 1x2 Wolf first", () => {
        const plans = planTacticalStackSplits(army, 9, { screen: true });
        expect(plans.map((plan) => [plan.sourceUnitId, plan.role])).toEqual([
            ["wolf", "bait"],
            ["wolf", "bait"],
            ["wolf", "bait"],
        ]);
        expect(planA19SupportSplits(army, 9, { screen: true })).toEqual(plans);
    });

    it("2x2 stacks are never screen bodies and aura sources stay 1x1", () => {
        const big = [unit({ id: "griffin", identity: "Griffin:2", small: false, footprintCells: 4 }), army[2]];
        expect(planTacticalStackSplits(big, 9, { screen: true }).every((plan) => plan.sourceUnitId === "dryad")).toBe(
            true,
        );
    });

    it("the seat switch is on unless set to 0", () => {
        delete process.env.A19_SPLIT_SCREEN_LEFT;
        delete process.env.A19_SPLIT_SCREEN_RIGHT;
        expect(a19SplitScreenEnabled(LEFT)).toBe(true);
        process.env.A19_SPLIT_SCREEN_LEFT = "0";
        expect(a19SplitScreenEnabled(LEFT)).toBe(false);
        expect(a19SplitScreenEnabled(RIGHT)).toBe(true);
    });
});

// The owner's game 4a48d1ca: Mermaid in a fort army, three spare slots. Without the rule one Mermaid is split for its
// shield and the other slots go to the cheapest other body (Peasant).
const mermaidArmy = [
    unit({ id: "mermaid", identity: "Mermaid:1", level: 1, amount: 18, hpPerCreature: 12, waterShieldUtilityCount: 1 }),
    unit({ id: "peasant", identity: "Peasant:1", level: 1, amount: 40, hpPerCreature: 6 }),
    unit({
        id: "elf",
        identity: "Elf:1",
        level: 1,
        amount: 20,
        attackType: PBTypes.AttackVals.RANGE,
        rangedCoverCount: 1,
    }),
    unit({ id: "trent", identity: "Trent:2", level: 2, amount: 8 }),
    unit({ id: "queen", identity: "Arachna Queen:4", level: 4, amount: 1, small: false, footprintCells: 4 }),
];

describe(A19_SHIELD_SCREEN_ID, () => {
    it("without the rule, Mermaid gets one shield split and the other slots go to the cheapest other body", () => {
        const plans = planTacticalStackSplits(mermaidArmy, 9, { screen: true });
        expect(plans.map((plan) => [plan.sourceUnitId, plan.role])).toEqual([
            ["mermaid", "shield"],
            ["peasant", "bait"],
            ["peasant", "bait"],
        ]);
    });

    it("with the rule, every spare slot is a one-model Mermaid: each takes two attacks to kill", () => {
        const plans = planTacticalStackSplits(mermaidArmy, 9, { screen: true, shieldScreen: true });
        expect(plans.map((plan) => [plan.sourceUnitId, plan.role])).toEqual([
            ["mermaid", "shield"],
            ["mermaid", "bait"],
            ["mermaid", "bait"],
        ]);
        expect(planA19SupportSplits(mermaidArmy, 9, { screen: true, shieldScreen: true })).toEqual(plans);
    });

    it("a two-model Mermaid stack splits once and the next body takes the rest", () => {
        const small = mermaidArmy.map((entry) => (entry.id === "mermaid" ? { ...entry, amount: 2 } : entry));
        expect(
            planTacticalStackSplits(small, 9, { screen: true, shieldScreen: true }).map((plan) => plan.sourceUnitId),
        ).toEqual(["mermaid", "peasant", "peasant"]);
    });

    it("Mermaid outranks aura splits: the owner's army with an aura Peasant still screens with Mermaids", () => {
        const withAura = mermaidArmy.map((entry) =>
            entry.id === "peasant" ? { ...entry, auraUtilityCount: 1 } : entry,
        );
        expect(
            planTacticalStackSplits(withAura, 9, { screen: true }).map((plan) => [plan.sourceUnitId, plan.role]),
        ).toEqual([
            ["peasant", "aura"],
            ["peasant", "aura"],
            ["mermaid", "shield"],
        ]);
        expect(
            planTacticalStackSplits(withAura, 9, { screen: true, shieldScreen: true }).map((plan) => [
                plan.sourceUnitId,
                plan.role,
            ]),
        ).toEqual([
            ["mermaid", "shield"],
            ["mermaid", "bait"],
            ["mermaid", "bait"],
        ]);
    });

    it("armies without a Water Shield stack keep the split-screen body", () => {
        expect(planTacticalStackSplits(army, 9, { screen: true, shieldScreen: true })).toEqual(
            planTacticalStackSplits(army, 9, { screen: true }),
        );
    });

    it("the seat switch is on unless set to 0", () => {
        delete process.env.A19_SHIELD_SCREEN_LEFT;
        delete process.env.A19_SHIELD_SCREEN_RIGHT;
        expect(a19ShieldScreenEnabled(LEFT)).toBe(true);
        process.env.A19_SHIELD_SCREEN_RIGHT = "0";
        expect(a19ShieldScreenEnabled(RIGHT)).toBe(false);
        expect(a19ShieldScreenEnabled(LEFT)).toBe(true);
    });
});
