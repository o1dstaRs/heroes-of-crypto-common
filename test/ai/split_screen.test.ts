import { afterEach, describe, expect, it } from "bun:test";

import {
    A19_CLOSE_SCREEN_ID,
    A19_SHIELD_SCREEN_ID,
    A19_SPLIT_SCREEN_ID,
    a19CloseScreenEnabled,
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
    "A19_CLOSE_SCREEN_LEFT",
    "A19_CLOSE_SCREEN_RIGHT",
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
    ...(overrides.flying === undefined ? {} : { flying: overrides.flying }),
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

describe(A19_CLOSE_SCREEN_ID, () => {
    // The AI seat of the owner's game d6d7ee8b: no shooter, six stacks, five spare slots (11 stacks).
    const closer = [
        unit({ id: "wolf", identity: "Wolf:1", level: 1, amount: 120, small: false, footprintCells: 2, steps: 5.8 }),
        unit({ id: "fairy", identity: "Fairy:1", level: 1, amount: 139, steps: 10, flying: true }),
        unit({ id: "trent", identity: "Trent:2", level: 2, amount: 24, steps: 4.9 }),
        unit({ id: "pikeman", identity: "Pikeman:2", level: 2, amount: 23, steps: 6.1 }),
        unit({
            id: "pegasus",
            identity: "Pegasus:3",
            level: 3,
            amount: 11,
            small: false,
            footprintCells: 2,
            flying: true,
        }),
        unit({ id: "hydra", identity: "Hydra:4", level: 4, amount: 2, small: false, footprintCells: 4 }),
    ];
    // The owner's roster in that game: Peasant, Leprechaun, Medusa, White Tiger, Unicorn, Gargantuan (two shooters).
    const fort = [31, 23, 5, 25, 28, 29];
    const meleeOnly = [31, 23, 25, 28];
    const bodies = (plans: readonly { sourceUnitId: string; role: string }[]) =>
        plans.map((plan) => [plan.sourceUnitId, plan.role]);

    it("closing on shooters with none of its own, the spare slots become one-model Fairy splits", () => {
        const plans = planTacticalStackSplits(closer, 11, {
            screen: true,
            closeScreen: true,
            opponentCreatureIds: fort,
        });
        expect(bodies(plans)).toEqual(Array.from({ length: 5 }, () => ["fairy", "bait"]));
        expect(
            planA19SupportSplits(closer, 11, { screen: true, closeScreen: true, opponentCreatureIds: fort }),
        ).toEqual(plans);
    });

    it("against no shooter, with a shooter of its own, or with the switch off, the Wolf screen stays", () => {
        const wolves = Array.from({ length: 5 }, () => ["wolf", "bait"]);
        const plan = (units: readonly ITacticalSplitUnit[], options: object) =>
            bodies(planTacticalStackSplits(units, 11, { screen: true, ...options }));
        expect(plan(closer, { closeScreen: true, opponentCreatureIds: meleeOnly })).toEqual(wolves);
        expect(plan(closer, { closeScreen: true })).toEqual(wolves);
        expect(plan(closer, { opponentCreatureIds: fort })).toEqual(wolves);
        const withShooter = [
            ...closer.slice(0, 5),
            unit({ id: "elf", identity: "Elf:4", level: 4, amount: 3, attackType: PBTypes.AttackVals.RANGE }),
        ];
        expect(plan(withShooter, { closeScreen: true, opponentCreatureIds: fort })).toEqual(wolves);
    });

    it("the fastest cheap body: the lowest level first, then a flyer, then the most steps", () => {
        const plan = (units: readonly ITacticalSplitUnit[]) =>
            bodies(planTacticalStackSplits(units, 7, { screen: true, closeScreen: true, opponentCreatureIds: fort }));
        const base = closer.slice(2);
        // a level-2 flyer does not beat a level-1 ground body
        expect(
            plan([
                unit({
                    id: "wolf",
                    identity: "Wolf:1",
                    level: 1,
                    amount: 9,
                    small: false,
                    footprintCells: 2,
                    steps: 5.8,
                }),
                unit({ id: "griffin", identity: "Griffin:2", level: 2, amount: 9, steps: 7, flying: true }),
                ...base,
            ]),
        ).toEqual([["wolf", "bait"]]);
        // among level-1 bodies a slower flyer beats a faster walker
        expect(
            plan([
                unit({ id: "hyena", identity: "Hyena:1", level: 1, amount: 9, steps: 8 }),
                unit({ id: "fairy", identity: "Fairy:1", level: 1, amount: 9, steps: 6, flying: true }),
                ...base,
            ]),
        ).toEqual([["fairy", "bait"]]);
        // without a flyer, the most steps
        expect(
            plan([
                unit({
                    id: "wolf",
                    identity: "Wolf:1",
                    level: 1,
                    amount: 9,
                    small: false,
                    footprintCells: 2,
                    steps: 5.8,
                }),
                unit({ id: "hyena", identity: "Hyena:1", level: 1, amount: 9, steps: 8 }),
                ...base,
            ]),
        ).toEqual([["hyena", "bait"]]);
    });

    it("the seat switch is on unless set to 0", () => {
        delete process.env.A19_CLOSE_SCREEN_LEFT;
        delete process.env.A19_CLOSE_SCREEN_RIGHT;
        expect(a19CloseScreenEnabled(LEFT)).toBe(true);
        process.env.A19_CLOSE_SCREEN_LEFT = "0";
        expect(a19CloseScreenEnabled(LEFT)).toBe(false);
        expect(a19CloseScreenEnabled(RIGHT)).toBe(true);
    });
});
