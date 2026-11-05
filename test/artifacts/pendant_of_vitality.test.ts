import { describe, expect, test } from "bun:test";

import {
    ArtifactTier,
    formatArtifactDescription,
    getTier2ArtifactProperties,
    Tier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

describe("Pendant of Vitality", () => {
    for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        test(`team ${team} gains 22% health and pays 11% attack without stacking or affecting the opponent`, () => {
            const { grid, unitsHolder } = createCombatTestContext();
            const fight = FightStateManager.getInstance().getFightProperties();
            fight.setArtifactPerTeam(team, ArtifactTier.TIER_2, Tier2Artifact.PENDANT_OF_VITALITY);
            const own = createTestUnit({ team, maxHp: 100, attack: 100 });
            const enemy = createTestUnit({
                team: team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
                maxHp: 100,
                attack: 100,
            });
            placeUnit(grid, unitsHolder, own, { x: 2, y: 2 });
            placeUnit(grid, unitsHolder, enemy, { x: 10, y: 10 });
            for (let refresh = 0; refresh < 3; refresh++) {
                unitsHolder.applyArtifacts(fight);
                unitsHolder.refreshStackPowerForAllUnits();
                expect(own.getMaxHp()).toBe(122);
                expect(own.getHp()).toBe(122);
                expect(own.getBaseAttack()).toBe(89);
                expect(enemy.getMaxHp()).toBe(100);
                expect(enemy.getBaseAttack()).toBe(100);
            }
        });
    }

    test("the card prints the same health benefit and attack downside", () => {
        const description = formatArtifactDescription(getTier2ArtifactProperties(Tier2Artifact.PENDANT_OF_VITALITY));
        expect(description).toContain("+22% HP");
        expect(description).toContain("-11% attack");
    });
});
