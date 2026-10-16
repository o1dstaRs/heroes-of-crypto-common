/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { processSkewerStrikeAbility } from "../../src/abilities/skewer_strike_ability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit, DamageStatisticHolder } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());

// Water Shield fully absorbs the first incoming hit; an absorbed hit must land NO on-hit riders —
// the same rule as a miss (main melee, response, second punch and Lightning Spin all gate on it).
// Dulling Defense rides the skewer's own blow, so a shielded unit behind must not be dulled.
describe("Skewer Strike vs Water Shield", () => {
    const setup = (behindAbilities: string[]) => {
        const { grid, unitsHolder } = createCombatTestContext();
        const attacker = createTestUnit({
            name: "Skewer",
            team: PBTypes.TeamVals.RIGHT,
            abilities: ["Skewer Strike", "Dulling Defense"],
            attack: 40,
            damageMin: 100,
            damageMax: 100,
            stackPower: 100,
            maxHp: 100,
        });
        const primary = createTestUnit({ name: "Primary", team: PBTypes.TeamVals.LEFT, maxHp: 500, amountAlive: 4 });
        const behind = createTestUnit({
            name: "Behind",
            team: PBTypes.TeamVals.LEFT,
            abilities: behindAbilities,
            attack: 10,
            maxHp: 500,
            amountAlive: 4,
            stackPower: 100,
        });
        placeUnit(grid, unitsHolder, attacker, { x: 5, y: 7 });
        placeUnit(grid, unitsHolder, primary, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, behind, { x: 5, y: 3 });
        unitsHolder.refreshStackPowerForAllUnits();
        behind.trySeedWaterShield();
        return { grid, unitsHolder, attacker, primary, behind };
    };

    const skewer = (ctx: ReturnType<typeof setup>) =>
        processSkewerStrikeAbility(
            ctx.attacker,
            ctx.primary,
            new SceneLogMock(),
            ctx.unitsHolder,
            ctx.grid,
            new DamageStatisticHolder(),
        );

    it("an absorbed pierce hit deals no damage, consumes the shield, and lands no riders", () => {
        const ctx = setup(["Water Shield"]);
        expect(ctx.behind.willWaterShieldAbsorb(ctx.attacker)).toBe(true);

        skewer(ctx);

        expect(ctx.behind.getHp()).toBe(500);
        expect(ctx.behind.getAmountAlive()).toBe(4);
        // One-per-battle: the shield broke on the absorb.
        expect(ctx.behind.hasBuffActive("Water Shield")).toBe(false);
        // The skewer's Dulling Defense must NOT reach through the shield.
        expect(ctx.behind.getDebuff("Dulling Defense")).toBeUndefined();
        ctx.behind.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(ctx.behind.getBaseAttack()).toBe(10);
    });

    it("a landed pierce hit still lands its riders (gate is not over-broad)", () => {
        const ctx = setup([]);
        expect(ctx.behind.willWaterShieldAbsorb(ctx.attacker)).toBe(false);

        skewer(ctx);

        expect(ctx.behind.getHp()).toBeLessThan(500);
        expect(ctx.behind.getDebuff("Dulling Defense")).toBeDefined();
        ctx.behind.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        expect(ctx.behind.getBaseAttack()).toBe(8);
    });
});
