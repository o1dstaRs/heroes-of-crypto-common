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
    Tier1Artifact,
} from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const STEPS = ARTIFACT_POWER.WINGED_BOOTS_STEPS;
const ARMOR = ARTIFACT_POWER.WINGED_BOOTS_ARMOR;

/**
 * Winged Boots grants flyers BOTH movement and armour. The armour rides as the buff's second stored value
 * (the power stays the steps, which the movement hook reads), so these cover the whole path: the artifact
 * has to hand both numbers over, the flyer has to end up with both, and a walker has to end up with neither.
 */
const armFlight = (movementType: number) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LOWER, 1, Tier1Artifact.WINGED_BOOTS);
    const unit = createTestUnit({
        name: "Griffin",
        team: PBTypes.TeamVals.LOWER,
        movementType,
    });
    placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
    const baseArmor = unit.getUnitProperties().base_armor;
    const baseSteps = unit.getUnitProperties().steps;
    unitsHolder.applyArtifacts(fightProperties);
    unitsHolder.refreshStackPowerForAllUnits();
    return { unit, baseArmor, baseSteps };
};

describe("Winged Boots", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("gives a flying unit both the movement and the armour", () => {
        const { unit, baseArmor, baseSteps } = armFlight(PBTypes.MovementVals.FLY);

        expect(unit.getUnitProperties().steps).toBe(baseSteps + STEPS);
        expect(unit.getUnitProperties().base_armor).toBe(baseArmor + ARMOR);
    });

    it("leaves a walking unit untouched — the boots are for flyers", () => {
        const { unit, baseArmor, baseSteps } = armFlight(PBTypes.MovementVals.WALK);

        expect(unit.getUnitProperties().steps).toBe(baseSteps);
        expect(unit.getUnitProperties().base_armor).toBe(baseArmor);
        expect(unit.getBuff("Winged Boots")).toBeUndefined();
    });

    // Re-running the refresh cycle is the ranked path (every snapshot recomputes), so a second pass must
    // not stack a second set of boots — the same trap Cursed Ward's morale fell into.
    it("applies once however many times the stats are recomputed", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LOWER, 1, Tier1Artifact.WINGED_BOOTS);
        const unit = createTestUnit({
            name: "Griffin",
            team: PBTypes.TeamVals.LOWER,
            movementType: PBTypes.MovementVals.FLY,
        });
        placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
        const baseArmor = unit.getUnitProperties().base_armor;

        const seen: number[] = [];
        for (let i = 0; i < 4; i += 1) {
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
            seen.push(unit.getUnitProperties().base_armor);
        }

        expect(seen).toEqual([baseArmor + ARMOR, baseArmor + ARMOR, baseArmor + ARMOR, baseArmor + ARMOR]);
        expect(unit.getUnitProperties().applied_buffs.filter((n) => n === "Winged Boots")).toHaveLength(1);
    });

    it("states both halves on the artifact card", () => {
        // The filled text is what a player reads (pick UI, sidebar) — the raw one keeps its placeholders.
        const description = formatArtifactDescription(
            getArtifactProperties(ArtifactTier.TIER_1, Tier1Artifact.WINGED_BOOTS),
        );

        expect(description).toContain(`+${STEPS} base movement`);
        expect(description).toContain(`+${ARMOR} armor`);
        // No unfilled placeholders left behind by the two-value substitution.
        expect(description).not.toContain("{}");
        expect(description).not.toContain("[]");
    });
});
