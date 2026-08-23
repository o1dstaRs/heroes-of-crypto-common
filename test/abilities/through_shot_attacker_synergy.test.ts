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

import { afterEach, describe, expect, it } from "bun:test";

import { processThroughShotAbility } from "../../src/abilities/through_shot_ability";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/**
 * REGRESSION (engine defect): processThroughShotAbility passed the DEFENDER's team power as
 * calculateAttackDamage's `synergyAbilityPowerIncrease`.
 *
 * That argument reaches getEnemyArmor -> calculateAbilityMultiplier(Piercing Spear), i.e. it scales the
 * SHOOTER's armor-ignore — so a Piercing Spear shooter whose own team held a Might synergy shot as if it
 * had none (measured 52 projected vs 39 dealt, -25%), while a synergy on the VICTIM's team boosted the
 * shooter for free. Every other factor on this path already used the attacker's team; this slot was the
 * odd one out.
 */

const RED = PBTypes.TeamVals.UPPER;
const GREEN = PBTypes.TeamVals.LOWER;
const RANGE = PBTypes.AttackVals.RANGE;

/** Raises "additional ability power" for the team that holds it. */
const MIGHT_ABILITY_POWER_SYNERGY = "Might:2:3";

interface PierceRun {
    dealt: number;
    /** Damage recomputed independently with the ATTACKER's team power in the contested argument. */
    expectedFromAttackerTeam: number;
    /** The same, with the DEFENDER's team power — what the engine used to deal. */
    expectedFromDefenderTeam: number;
    attackerTeamPower: number;
    defenderTeamPower: number;
}

const runPierce = (options: { attackerSynergies?: string[]; victimSynergies?: string[] }): PierceRun => {
    const { grid, unitsHolder, damageStatisticHolder } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    if (options.attackerSynergies) {
        fightProperties.setSynergiesPerTeam(RED, options.attackerSynergies);
    }
    if (options.victimSynergies) {
        fightProperties.setSynergiesPerTeam(GREEN, options.victimSynergies);
    }

    const attacker: Unit = createTestUnit({
        name: "Piercer",
        team: RED,
        attackType: RANGE,
        attack: 10,
        damageMin: 7,
        damageMax: 7,
        amountAlive: 5,
        stackPower: 5,
        rangeShots: 9,
        shotDistance: 30,
        abilities: ["Through Shot", "Piercing Spear"],
    });
    attacker.calculateMissChance = () => 0;
    const victim = createTestUnit({ name: "Wall", team: GREEN, armor: 20, maxHp: 1_000_000, amountAlive: 4 });
    placeUnit(grid, unitsHolder, attacker, { x: 5, y: 9 });
    placeUnit(grid, unitsHolder, victim, { x: 5, y: 7 });

    const attackerTeamPower = fightProperties.getAdditionalAbilityPowerPerTeam(RED);
    const defenderTeamPower = fightProperties.getAdditionalAbilityPowerPerTeam(GREEN);

    // The Through Shot ability multiplier ALWAYS took the attacker's team power — only the argument handed
    // to calculateAttackDamage was in dispute, so hold the multiplier fixed and vary just that slot.
    const throughShot = attacker.getAbility("Through Shot");
    expect(throughShot).toBeDefined();
    const throughShotMultiplier = attacker.calculateAbilityMultiplier(throughShot!, attackerTeamPower);

    setDeterministicRandomSource(() => 0);
    // Pure reads: decreaseNumberOfShots = false leaves the quiver untouched, and a one-point damage band
    // (damageMin === damageMax) makes the roll deterministic.
    const withTeamPower = (teamPower: number): number =>
        Math.floor(
            attacker.calculateAttackDamage(victim, RANGE, teamPower, 1, throughShotMultiplier, false) *
                victim.getPhysicalAoeDamageMultiplier(),
        );
    const expectedFromAttackerTeam = withTeamPower(attackerTeamPower);
    const expectedFromDefenderTeam = withTeamPower(defenderTeamPower);
    expect(attacker.getRangeShots()).toBe(9);

    const result = processThroughShotAbility(
        attacker,
        [[victim]],
        attacker,
        [1],
        victim.getPosition(),
        unitsHolder,
        grid,
        new SceneLogMock(),
        damageStatisticHolder,
    );
    expect(result.landed).toBe(true);
    expect(result.perUnitDamage.length).toBe(1);

    return {
        dealt: result.perUnitDamage[0]!.amount,
        expectedFromAttackerTeam,
        expectedFromDefenderTeam,
        attackerTeamPower,
        defenderTeamPower,
    };
};

describe("Through Shot prices its pierce with the ATTACKER's team synergy", () => {
    afterEach(() => setDeterministicRandomSource(undefined));

    it("spends the shooter's own synergy on its Piercing Spear armor-ignore", () => {
        const run = runPierce({ attackerSynergies: [MIGHT_ABILITY_POWER_SYNERGY] });

        // The synergy is live on the shooter's team and absent on the victim's...
        expect(run.attackerTeamPower).toBeGreaterThan(0);
        expect(run.defenderTeamPower).toBe(0);
        // ...and it is worth real damage, so the equality below is not a coincidence.
        expect(run.expectedFromAttackerTeam).toBeGreaterThan(run.expectedFromDefenderTeam);
        // The engine deals the ATTACKER-team number. Before the fix it dealt the defender-team one.
        expect(run.dealt).toBe(run.expectedFromAttackerTeam);
    });

    it("does NOT let the VICTIM's team synergy strengthen the shot", () => {
        const control = runPierce({});
        const victimBuffed = runPierce({ victimSynergies: [MIGHT_ABILITY_POWER_SYNERGY] });

        expect(victimBuffed.defenderTeamPower).toBeGreaterThan(0);
        expect(victimBuffed.attackerTeamPower).toBe(0);
        // The defender's synergy is inert on this path now; it used to raise the shooter's armor-ignore.
        expect(victimBuffed.dealt).toBe(control.dealt);
        expect(victimBuffed.expectedFromDefenderTeam).toBeGreaterThan(victimBuffed.dealt);
    });

    it("matches with neither team holding a synergy (the case that always agreed)", () => {
        const run = runPierce({});

        expect(run.attackerTeamPower).toBe(0);
        expect(run.defenderTeamPower).toBe(0);
        expect(run.dealt).toBe(run.expectedFromAttackerTeam);
        expect(run.dealt).toBe(run.expectedFromDefenderTeam);
    });
});
