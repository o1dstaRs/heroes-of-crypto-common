import { describe, expect, it } from "bun:test";

import type { Ability } from "../../src/abilities/ability";
import { EffectFactory } from "../../src/effects/effect_factory";
import { Unit } from "../../src/units/unit";
import { createTestUnit } from "../helpers/combat";

const refresh = (unit: Unit): void => unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

describe("stat refresh public dispatch", () => {
    it("observes a subclass ability override changing between same-lap refreshes", () => {
        let suppressArmor = true;
        class CustomUnit extends Unit {
            public override getAbility(name: string): Ability | undefined {
                if (name === "Heavy Armor" && suppressArmor) return undefined;
                return super.getAbility(name);
            }
        }
        const unit = createTestUnit({ abilities: ["Heavy Armor"], armor: 20, stackPower: 3 });
        Object.setPrototypeOf(unit, CustomUnit.prototype);

        refresh(unit);
        const withoutAbility = unit.getArmor();
        suppressArmor = false;
        refresh(unit);
        expect(unit.getArmor()).toBeGreaterThan(withoutAbility);
        suppressArmor = true;
        refresh(unit);
        expect(unit.getArmor()).toBe(withoutAbility);
    });

    it("preserves custom effect reads and stats when an instance overrides ability lookup", () => {
        const unit = createTestUnit({
            abilities: ["Heavy Armor", "Magic Shield", "Sky Runner", "Blind Fury"],
            armor: 20,
            stackPower: 3,
        });
        const effect = new EffectFactory().makeEffect("Break")!;
        const getName = effect.getName;
        let reads = 0;
        Object.defineProperty(effect, "getName", {
            value() {
                reads++;
                return getName.call(effect);
            },
        });
        unit.applyEffect(effect);
        reads = 0;
        refresh(unit);
        const ordinaryReads = reads;
        const properties = JSON.stringify(unit.getUnitProperties());

        Object.defineProperty(unit, "getAbility", { value: Unit.prototype.getAbility });
        reads = 0;
        refresh(unit);
        expect(reads).toBeGreaterThan(1);
        expect(reads).toBe(ordinaryReads);
        expect(JSON.stringify(unit.getUnitProperties())).toBe(properties);
    });
});
