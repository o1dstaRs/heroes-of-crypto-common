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

import { createTestUnit } from "../helpers/combat";
import { processShatterArmorAbility } from "../../src/abilities/shatter_armor_ability";
import { SceneLogMock } from "../../src/scene/scene_log_mock";

/**
 * A ranked client seeds the effect/buff DISPLAY strings but deliberately NOT the OBJECT arrays that
 * adjustBaseStats derives armor_mod / attack_mod from — rebuilding those would double-apply stats that
 * already arrive authoritative. The consequence was that no debuff- or buff-driven stat change ever
 * reached the ranked HUD: a unit under Shatter Armor showed its full base armor while the server had the
 * penalty applied, which reads as "the effect isn't working".
 *
 * The snapshot now carries the server's final mods, and these flags make adjustBaseStats keep them.
 */
describe("authoritative stat mods", () => {
    const adjust = (unit: ReturnType<typeof createTestUnit>): void => unit.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);

    it("keeps an authoritative armor_mod instead of re-deriving it from effects it cannot see", () => {
        const unit = createTestUnit({ name: "Peasant", amountAlive: 5, maxHp: 100 });
        const props = unit.getUnitProperties();
        props.armor_mod = -10;
        props.armor_mod_authoritative = true;

        adjust(unit);

        expect(props.armor_mod).toBe(-10);
        // getArmor is base + mod, so the HUD finally shows the penalty the server applied.
        expect(unit.getArmor()).toBe(Math.max(1, props.base_armor - 10));
    });

    it("keeps an authoritative attack_mod the same way", () => {
        const unit = createTestUnit({ name: "Peasant", amountAlive: 5, maxHp: 100 });
        const props = unit.getUnitProperties();
        props.attack_mod = -3;
        props.attack_mod_authoritative = true;

        adjust(unit);

        expect(props.attack_mod).toBe(-3);
    });

    // The regression guard: without the flag a client that never rebuilt the effect objects silently loses
    // the penalty, which is exactly the bug. Sandbox owns the whole derivation and must keep running it.
    it("still re-derives the mods locally when they are not authoritative", () => {
        const unit = createTestUnit({ name: "Peasant", amountAlive: 5, maxHp: 100 });
        const props = unit.getUnitProperties();
        props.armor_mod = -10;
        props.attack_mod = -3;

        adjust(unit);

        expect(props.armor_mod).toBe(0);
        expect(props.attack_mod).toBe(0);
    });

    // End to end on the real ability: sandbox derives the same number the server would ship.
    it("agrees with the value a locally-applied Shatter Armor derives", () => {
        const log = new SceneLogMock();
        const attacker = createTestUnit({
            name: "Wolf Rider",
            abilities: ["Shatter Armor"],
            amountAlive: 5,
            stackPower: 5,
        });
        const local = createTestUnit({ name: "Peasant", amountAlive: 10, maxHp: 100 });
        processShatterArmorAbility(attacker, local, attacker, log);
        adjust(local);
        const derived = local.getUnitProperties().armor_mod;
        expect(derived).toBeLessThan(0);

        // Now the ranked path: same number handed over as authoritative, no effect object present.
        const ranked = createTestUnit({ name: "Peasant", amountAlive: 10, maxHp: 100 });
        ranked.getUnitProperties().armor_mod = derived;
        ranked.getUnitProperties().armor_mod_authoritative = true;
        adjust(ranked);

        expect(ranked.getUnitProperties().armor_mod).toBe(derived);
        expect(ranked.getArmor()).toBe(local.getArmor());
    });
});
