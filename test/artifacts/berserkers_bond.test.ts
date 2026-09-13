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

import { beforeEach, describe, expect, it } from "bun:test";

import {
    ARTIFACT_POWER,
    ArtifactTier,
    formatArtifactDescription,
    getArtifactProperties,
    Tier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const ATTACK = ARTIFACT_POWER.BERSERKERS_BOND_ATTACK;
const DEFENSE_PENALTY = ARTIFACT_POWER.BERSERKERS_BOND_DEFENSE_PENALTY;

const bondUnit = (armor = 10) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_2, Tier2Artifact.BERSERKERS_BOND);
    const unit = createTestUnit({ name: "Bond Bearer", team: PBTypes.TeamVals.LEFT, armor, attack: 10 });
    placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
    const baseAttack = unit.getUnitProperties().base_attack;
    const baseArmor = unit.getUnitProperties().base_armor;

    unitsHolder.applyArtifacts(fightProperties);
    unitsHolder.refreshStackPowerForAllUnits();

    return { unit, unitsHolder, fightProperties, baseAttack, baseArmor };
};

describe("Berserker's Bond", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("is +3 attack / -1 defense (owner call 2026-09-13, was -2 defense)", () => {
        expect(ATTACK).toBe(3);
        expect(DEFENSE_PENALTY).toBe(1);
    });

    it("adds the attack and takes the defense from the whole army", () => {
        const { unit, baseAttack, baseArmor } = bondUnit();

        expect(unit.getUnitProperties().base_attack).toBe(baseAttack + ATTACK);
        expect(unit.getUnitProperties().base_armor).toBe(baseArmor - DEFENSE_PENALTY);
        expect(unit.getBuffProperties("Berserkers Bond")[1]).toBe(String(DEFENSE_PENALTY));
    });

    it("does not stack when artifacts and unit stats are refreshed", () => {
        const { unit, unitsHolder, fightProperties, baseAttack, baseArmor } = bondUnit();

        for (let i = 0; i < 3; i += 1) {
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
        }

        expect(unit.getUnitProperties().base_attack).toBe(baseAttack + ATTACK);
        expect(unit.getUnitProperties().base_armor).toBe(baseArmor - DEFENSE_PENALTY);
    });

    it("never drops armor below 1", () => {
        const { unit } = bondUnit(1);

        expect(unit.getUnitProperties().base_armor).toBe(1);
    });

    it("states both numbers on the artifact card", () => {
        const description = formatArtifactDescription(
            getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.BERSERKERS_BOND),
        );

        expect(description).toContain(`+${ATTACK} attack`);
        expect(description).toContain(`-${DEFENSE_PENALTY} defense`);
        expect(description).not.toMatch(/\{\}|\[\]|<>/);
    });
});
