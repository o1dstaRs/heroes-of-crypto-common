/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createTestUnit } from "../helpers/combat";

// "Fire Element" (Efreet, Black Dragon) and "Water Element" (Mermaid) are opposing affinities: each deals
// +power% (50) to the other. The vulnerability lives on the defender's element ability and is read by
// Unit.getElementalDamageMultiplier, which feeds calculateAttackDamage — so it covers normal attacks and
// Fire Breath (whose per-target damage also routes through calculateAttackDamage).
describe("Water Element (Fire <-> Water +50% affinity)", () => {
    it("deals +50% both directions between Fire and Water element units, 1x otherwise", () => {
        const mermaid = createTestUnit({ name: "Mermaid", abilities: ["Water Element"] });
        const efreet = createTestUnit({ name: "Efreet", abilities: ["Fire Element"] });
        const plain = createTestUnit({ name: "Plain", abilities: [] });

        // The config powers must actually be loaded for the multiplier to mean anything.
        expect(mermaid.getAbility("Water Element")?.getPower()).toBe(50);
        expect(efreet.getAbility("Fire Element")?.getPower()).toBe(50);

        expect(mermaid.getElementalDamageMultiplier(efreet)).toBeCloseTo(1.5, 5);
        expect(efreet.getElementalDamageMultiplier(mermaid)).toBeCloseTo(1.5, 5);
        // No interaction against non-elemental units, or between same elements.
        expect(mermaid.getElementalDamageMultiplier(plain)).toBe(1);
        expect(efreet.getElementalDamageMultiplier(plain)).toBe(1);
        expect(mermaid.getElementalDamageMultiplier(createTestUnit({ abilities: ["Water Element"] }))).toBe(1);
    });

    it("folds the +50% into calculateAttackDamage against a Fire-element target", () => {
        // Deterministic base damage (min === max, no luck) so the only difference between the two targets is
        // the Fire Element affinity on one of them.
        const mermaid = createTestUnit({
            name: "Mermaid",
            abilities: ["Water Element"],
            attack: 10,
            damageMin: 8,
            damageMax: 8,
            luck: 0,
        });
        const fireTarget = createTestUnit({ name: "Efreet", abilities: ["Fire Element"], armor: 10, luck: 0 });
        const plainTarget = createTestUnit({ name: "Plain", abilities: [], armor: 10, luck: 0 });

        const vsFire = mermaid.calculateAttackDamage(fireTarget, PBTypes.AttackVals.MELEE, 0);
        const vsPlain = mermaid.calculateAttackDamage(plainTarget, PBTypes.AttackVals.MELEE, 0);

        expect(vsPlain).toBeGreaterThan(0);
        expect(vsFire).toBe(Math.floor(vsPlain * 1.5));
    });
});

// Water Shield is a once-per-battle innate buff that fully absorbs the first incoming damage instance (0
// damage taken), then breaks. Seeding is idempotent and never re-grants a shield that has been consumed.
describe("Water Shield (once-per-battle absorb)", () => {
    it("absorbs the first hit for 0 damage, then lets subsequent hits through", () => {
        const log = new SceneLogMock();
        const unit = createTestUnit({ name: "Mermaid", abilities: ["Water Shield"], maxHp: 12 });

        unit.trySeedWaterShield();
        expect(unit.hasBuffActive("Water Shield")).toBe(true);

        const startHp = unit.getHp();
        const firstHit = unit.applyDamage(5, 0, log);
        expect(firstHit).toBe(0);
        expect(unit.getHp()).toBe(startHp);
        expect(unit.hasBuffActive("Water Shield")).toBe(false);

        const secondHit = unit.applyDamage(5, 0, log);
        expect(secondHit).toBe(5);
        expect(unit.getHp()).toBe(startHp - 5);
    });

    it("is ignored by fire — a Fire Element attacker passes through without absorbing or consuming it", () => {
        const log = new SceneLogMock();
        const mermaid = createTestUnit({ name: "Mermaid", abilities: ["Water Shield"], maxHp: 12 });
        const efreet = createTestUnit({ name: "Efreet", abilities: ["Fire Element"] });
        const plain = createTestUnit({ name: "Plain", abilities: [] });

        mermaid.trySeedWaterShield();
        expect(mermaid.hasBuffActive("Water Shield")).toBe(true);

        // Fire attacker: full damage lands, shield is NOT consumed (fire ignores it).
        const fireHit = mermaid.applyDamage(4, 0, log, false, efreet);
        expect(fireHit).toBe(4);
        expect(mermaid.getHp()).toBe(12 - 4);
        expect(mermaid.hasBuffActive("Water Shield")).toBe(true);

        // The still-intact shield absorbs the next NON-fire hit.
        const physHit = mermaid.applyDamage(4, 0, log, false, plain);
        expect(physHit).toBe(0);
        expect(mermaid.getHp()).toBe(12 - 4); // unchanged
        expect(mermaid.hasBuffActive("Water Shield")).toBe(false);
    });

    it("does not re-grant the shield after it has been consumed", () => {
        const log = new SceneLogMock();
        const unit = createTestUnit({ name: "Mermaid", abilities: ["Water Shield"], maxHp: 12 });

        unit.trySeedWaterShield();
        unit.applyDamage(5, 0, log); // consume it
        expect(unit.hasBuffActive("Water Shield")).toBe(false);

        // A later refresh (which calls trySeedWaterShield on every unit) must NOT bring it back.
        unit.trySeedWaterShield();
        expect(unit.hasBuffActive("Water Shield")).toBe(false);
    });

    it("only seeds the shield for units that actually own the ability", () => {
        const noShield = createTestUnit({ name: "Plain", abilities: [] });
        noShield.trySeedWaterShield();
        expect(noShield.hasBuffActive("Water Shield")).toBe(false);
    });
});
