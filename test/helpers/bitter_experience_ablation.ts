import assert from "node:assert/strict";
import type { Unit } from "../../src/units/unit";
import type { UnitProperties } from "../../src/units/unit_properties";

// Synthetic test control only: neutralize a newly earned bonus while retaining the real hit,
// casualties and proc counter. Both live and initial stats must change so the control survives
// ordinary stat refresh and battle rollback. This is not a legal action or a serving AI policy.
export type Axis = "none" | "armor" | "steps" | "both";
export const info = (u: Unit) => {
    const p = u.getUnitProperties(),
        i = (u as unknown as { initialUnitProperties: UnitProperties }).initialUnitProperties;
    return {
        id: u.getId(),
        name: u.getName(),
        amount: u.getAmountAlive(),
        hp: u.getCumulativeHp(),
        topHp: u.getHp(),
        maxHp: u.getMaxHp(),
        baseArmor: p.base_armor,
        initialArmor: i.base_armor,
        armor: u.getArmor(),
        rawSteps: p.steps,
        initialSteps: i.steps,
        steps: u.getSteps(),
        stacks: p.bitter_experience_stacks ?? 0,
        bitterActive: u.hasAbilityActive("Bitter Experience"),
        broken: u.hasEffectActive("Break"),
        attackType: u.getAttackType(),
        hasSpells: u.getSpells().length > 0,
    };
};
export function neutralizeBonus(unit: Unit, previousStacks: number, axis: Axis) {
    const p = unit.getUnitProperties() as UnitProperties,
        i = (unit as unknown as { initialUnitProperties: UnitProperties }).initialUnitProperties,
        d = (p.bitter_experience_stacks ?? 0) - previousStacks;
    assert(d >= 0 && Number.isInteger(d));
    if (!d || axis === "none") return { stacks: d, armorRemoved: 0, stepsRemoved: 0 };
    if (axis === "armor" || axis === "both") {
        p.base_armor -= d;
        i.base_armor -= d;
    }
    if (axis === "steps" || axis === "both") {
        p.steps -= d;
        i.steps -= d;
    }
    return {
        stacks: d,
        armorRemoved: axis === "armor" || axis === "both" ? d : 0,
        stepsRemoved: axis === "steps" || axis === "both" ? d : 0,
    };
}
