import { beforeEach, expect, it } from "bun:test";

import {
    ArtifactTier,
    formatArtifactDescription,
    getArtifactProperties,
    TIER2_ARTIFACT_LIST,
    Tier2Artifact,
    ToTier2Artifact,
} from "../../src/artifacts/artifact_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

beforeEach(() => FightStateManager.getInstance().reset());

it("adds 18 magic defense to every ally, recomputes once, and clears on deselection", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const allies = [
        createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.LEFT }),
        createTestUnit({ name: "Archer", team: PBTypes.TeamVals.LEFT }),
    ];
    const enemy = createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.RIGHT });
    [...allies, enemy].forEach((unit, i) => placeUnit(grid, unitsHolder, unit, { x: 2 + i, y: 2 }));
    unitsHolder.refreshStackPowerForAllUnits();
    const bases = allies.map((unit) => unit.getMagicResist());
    const enemyBase = enemy.getMagicResist();
    fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.AEGIS_OF_THE_ARCANE);
    for (let i = 0; i < 3; i++) {
        unitsHolder.applyArtifacts(fight);
        unitsHolder.refreshStackPowerForAllUnits();
        allies.forEach((unit, index) => expect(unit.getMagicResist()).toBeCloseTo(bases[index] + 18, 2));
        expect(enemy.getMagicResist()).toBe(enemyBase);
    }
    fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.NO_ARTIFACT);
    unitsHolder.applyArtifacts(fight);
    unitsHolder.refreshStackPowerForAllUnits();
    allies.forEach((unit, index) => expect(unit.getMagicResist()).toBe(bases[index]));
});

it("is draftable under its new wire id with an accurate tooltip", () => {
    expect(ToTier2Artifact["14"]).toBe(Tier2Artifact.AEGIS_OF_THE_ARCANE);
    expect(TIER2_ARTIFACT_LIST.some((item) => item.id === Tier2Artifact.AEGIS_OF_THE_ARCANE)).toBe(true);
    expect(
        formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.AEGIS_OF_THE_ARCANE)),
    ).toContain("+18 percentage points of magic defense");
});
