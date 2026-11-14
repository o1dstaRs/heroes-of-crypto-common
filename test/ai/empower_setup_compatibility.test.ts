import { expect, test } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    EMPOWER_SETUP_FEATURES,
    EMPOWER_SETUP_SCHEMA,
    empowerSetupPlan,
    type IEmpowerSetupModel,
} from "../../src/ai/setup/empower_setup";
import { compatibleEmpowerFormation, compatibleEmpowerSetup } from "../../src/ai/setup/empower_setup_compatibility";
import type { ISetupAugmentChoice } from "../../src/ai/setup/setup_ship";

const own = ["Squire", "Wandering Mage", "Healer", "Battle Mage", "Nightmare", "Magic Dragon"].map((name) =>
    creatureIdForName(name)!,
);
const model: IEmpowerSetupModel = {
    schema: EMPOWER_SETUP_SCHEMA,
    features: EMPOWER_SETUP_FEATURES,
    margin: 0.03,
    heads: [0, 0, 1].map((b) => ({ b, w: EMPOWER_SETUP_FEATURES.map(() => 0) })),
};

test("Empower preserves the current formation and respects a separately funded setup", () => {
    const incumbent = empowerSetupPlan(7, own, 0);
    const selected = compatibleEmpowerSetup(model, 7, own, incumbent);
    expect(selected.level).toBe(3);
    expect(selected.formationAugments).toEqual(incumbent);
    expect(selected.augments).toEqual(empowerSetupPlan(7, own, 3));
    const placement: ISetupAugmentChoice[] = [
        { kind: "Placement", value: 1 },
        { kind: "Sniper", value: 3 },
        { kind: "Armor", value: 3 },
    ];
    expect(compatibleEmpowerSetup(model, 7, own, placement)).toEqual({
        level: 0,
        augments: placement,
        formationAugments: placement,
    });
    expect(compatibleEmpowerSetup(model, 4, own, [{ kind: "Armor", value: 3 }]).level).toBe(0);
});

test("manual or edited builds do not inherit a mismatched formation context", () => {
    const incumbent = empowerSetupPlan(7, own, 0),
        selected = empowerSetupPlan(7, own, 3);
    expect(compatibleEmpowerFormation(model, 7, own, incumbent, selected)).toEqual(incumbent);
    const manual = empowerSetupPlan(7, own, 2);
    expect(compatibleEmpowerFormation(model, 7, own, incumbent, manual)).toEqual(manual);
    const withZero: ISetupAugmentChoice[] = [{ kind: "Placement", value: 0 }, ...selected].reverse();
    expect(compatibleEmpowerFormation(model, 7, own, incumbent, withZero)).toEqual(incumbent);
    const duplicate = [...selected, selected[0]];
    expect(compatibleEmpowerFormation(model, 7, own, incumbent, duplicate)).toEqual(duplicate);
});
