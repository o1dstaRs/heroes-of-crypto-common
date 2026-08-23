/*
 * -----------------------------------------------------------------------------
 * Lava Striders lets the whole army walk and stand in lava, but it must NOT make
 * anyone permanently "Made of Fire": that ability is a Fire creature's innate
 * identity, and granting it army-wide showed the icon (and its semantics) on
 * every unit from fight start. The artifact only promises the +10% boost "while
 * on central lava", which is the Made of Fire BUFF — earned by actually moving
 * through (or flying over) lava, exactly like an innate Fire creature earns it.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import {
    formatArtifactDescription,
    getTier2ArtifactProperties,
    Tier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;

/** One army carrying Lava Striders, refreshed the way both sandbox and ranked do. */
const armyWithLavaStriders = () => {
    const { grid, unitsHolder } = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setArtifactPerTeam(LOWER, 2, Tier2Artifact.LAVA_STRIDERS);
    const unit = createTestUnit({ name: "Squire", team: LOWER });
    placeUnit(grid, unitsHolder, unit, { x: 2, y: 2 });
    unitsHolder.applyArtifacts(fightProperties);
    unitsHolder.refreshStackPowerForAllUnits();
    return { grid, unitsHolder, unit };
};

describe("Lava Striders", () => {
    it("presents the artifact to players as Fireproof Boots with its complete terrain effect", () => {
        const artifact = getTier2ArtifactProperties(Tier2Artifact.LAVA_STRIDERS);

        expect(artifact.name).toBe("Fireproof Boots");
        expect(formatArtifactDescription(artifact)).toBe(
            "Allows every allied unit to move across and stand on lava. Contact with the central lava grants Made of Fire for 2 laps: +10% to all stats and ability power.",
        );
    });

    it("never grants the Made of Fire ability, however often the army is refreshed", () => {
        const { unitsHolder, unit } = armyWithLavaStriders();
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        for (let i = 0; i < 3; i += 1) {
            unitsHolder.applyArtifacts(fightProperties);
            unitsHolder.refreshStackPowerForAllUnits();
        }

        expect(unit.hasAbilityActive("Made of Fire")).toBe(false);
        expect(unit.getUnitProperties().abilities).not.toContain("Made of Fire");
        expect(unit.hasBuffActive("Made of Fire")).toBe(false);
        // The marker buff is the whole artifact: it is what opens lava up.
        expect(unit.getUnitProperties().applied_buffs.filter((name) => name === "Lava Striders")).toHaveLength(1);
        expect(unit.canTraverseLava()).toBe(true);
    });

    it("grants the Made of Fire boost only for a route that went through lava", () => {
        const dry = armyWithLavaStriders().unit;
        dry.applyLavaWaterModifier(false, false);
        expect(dry.hasBuffActive("Made of Fire")).toBe(false);

        const waded = armyWithLavaStriders().unit;
        const attackBefore = waded.getBaseAttack();
        waded.applyLavaWaterModifier(true, false);

        expect(waded.hasBuffActive("Made of Fire")).toBe(true);
        expect(waded.getBaseAttack()).toBeGreaterThan(attackBefore);
    });

    it("leaves a unit with neither the ability nor the artifact untouched by lava", () => {
        const { grid, unitsHolder } = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const plain = createTestUnit({ name: "Squire", team: LOWER });
        placeUnit(grid, unitsHolder, plain, { x: 2, y: 2 });

        plain.applyLavaWaterModifier(true, false);

        expect(plain.canTraverseLava()).toBe(false);
        expect(plain.hasBuffActive("Made of Fire")).toBe(false);
    });
});
