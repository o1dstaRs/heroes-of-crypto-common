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

const STEPS = ARTIFACT_POWER.CROWN_STEPS;
const MORALE = ARTIFACT_POWER.CROWN_MORALE;
const ARMOR = ARTIFACT_POWER.CROWN_ARMOR;

const crownUnit = () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_2, Tier2Artifact.CROWN_OF_COMMAND);
    const unit = createTestUnit({
        name: "Crown Bearer",
        team: PBTypes.TeamVals.LEFT,
        morale: 0,
    });
    placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
    const baseSteps = unit.getUnitProperties().steps;
    const baseMorale = unit.getUnitProperties().morale;
    const baseArmor = unit.getUnitProperties().base_armor;

    unitsHolder.applyArtifacts(fightProperties);
    unitsHolder.refreshStackPowerForAllUnits();

    return { unit, unitsHolder, fightProperties, baseSteps, baseMorale, baseArmor };
};

describe("Crown of Command", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("grants movement, morale, and armor to the whole army", () => {
        const { unit, baseSteps, baseMorale, baseArmor } = crownUnit();

        expect(unit.getUnitProperties().steps).toBe(baseSteps + STEPS);
        expect(unit.getUnitProperties().morale).toBe(baseMorale + MORALE);
        expect(unit.getUnitProperties().base_armor).toBe(baseArmor + ARMOR);
        expect(unit.getBuffProperties("Crown of Command")).toEqual([String(MORALE), String(ARMOR)]);
    });

    it("does not stack its stats when artifacts and unit stats are refreshed", () => {
        const { unit, unitsHolder, fightProperties, baseSteps, baseMorale, baseArmor } = crownUnit();

        for (let i = 0; i < 3; i += 1) {
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
        }

        expect(unit.getUnitProperties().steps).toBe(baseSteps + STEPS);
        expect(unit.getUnitProperties().morale).toBe(baseMorale + MORALE);
        expect(unit.getUnitProperties().base_armor).toBe(baseArmor + ARMOR);
        expect(unit.getUnitProperties().applied_buffs.filter((name) => name === "Crown of Command")).toHaveLength(1);
    });

    it("states all three bonuses on the artifact card", () => {
        const description = formatArtifactDescription(
            getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.CROWN_OF_COMMAND),
        );

        expect(description).toContain(`+${STEPS} movement`);
        expect(description).toContain(`+${MORALE} morale`);
        expect(description).toContain(`+${ARMOR} armor`);
        expect(description).not.toMatch(/\{\}|\[\]|<>/);
    });
});
