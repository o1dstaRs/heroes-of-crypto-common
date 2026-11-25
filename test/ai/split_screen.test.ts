import { afterEach, describe, expect, it } from "bun:test";

import { A19_SPLIT_SCREEN_ID, a19SplitScreenEnabled } from "../../src/ai/split_screen";
import { planA19SupportSplits } from "../../src/ai/support_setup";
import { planTacticalStackSplits, type ITacticalSplitUnit } from "../../src/ai/tactical_split_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";

const { LEFT, RIGHT } = PBTypes.TeamVals;
const SWITCHES = ["A19_SPLIT_SCREEN_LEFT", "A19_SPLIT_SCREEN_RIGHT"];
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
