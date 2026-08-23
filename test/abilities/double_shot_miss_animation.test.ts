import { afterEach, describe, expect, it } from "bun:test";

import { processDoubleShotAbility } from "../../src/abilities/double_shot_ability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

// The singleton burns a seeded RNG draw on first construction (getRandomGridType), so touch it before a
// deterministic source is installed or the forced roll below lands on the wrong call.
FightStateManager.getInstance();

const GREEN = PBTypes.TeamVals.LOWER;
const RED = PBTypes.TeamVals.UPPER;

/**
 * The second volley of a Double Shot (and the Blacksmith-granted Crafted Double Shot) must ANIMATE
 * whether or not it connects: the arrow leaves the bow before the miss is rolled, exactly as the primary
 * shot does in attack_handler. Rolling first and returning early drew nothing on a miss, so a two-shot
 * attack rendered a single arrow — intermittently, since it looked correct whenever the roll happened to
 * hit. Only the combat log recorded the second shot at all.
 */
describe("double shot — second volley animation", () => {
    afterEach(() => {
        setDeterministicRandomSource(undefined);
    });

    const fire = (forcedRoll: number) => {
        const context = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Shooter",
            team: GREEN,
            attackType: PBTypes.AttackVals.RANGE,
            abilities: ["Crafted Double Shot"],
            rangeShots: 5,
        });
        // Dodge is what gives the target a non-zero miss chance to roll against at all.
        const target = createTestUnit({ name: "Target", team: RED, abilities: ["Dodge"], maxHp: 10_000 });
        placeUnit(context.grid, context.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(context.grid, context.unitsHolder, target, { x: 8, y: 3 });

        setDeterministicRandomSource(() => forcedRoll);
        return processDoubleShotAbility(
            shooter,
            target,
            [target],
            new SceneLogMock(),
            context.unitsHolder,
            context.grid,
            1,
            target.getPosition(),
            createVisibleDamage(target),
            context.damageStatisticHolder,
            false,
        );
    };

    it("draws the second arrow even when it misses", () => {
        // Lowest possible roll — under any non-zero miss chance, so the second shot misses.
        const missed = fire(0);
        expect(missed.applied).toBe(false);
        expect(missed.animationData.length).toBe(1);
    });

    it("draws the second arrow when it lands", () => {
        const landed = fire(0.999);
        expect(landed.animationData.length).toBeGreaterThanOrEqual(1);
    });
});
