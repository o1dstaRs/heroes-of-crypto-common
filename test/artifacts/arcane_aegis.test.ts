import { beforeEach, expect, it } from "bun:test";

import {
    ARTIFACT_POWER,
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

/** What remains after every listed magic-defense roll misses. Same formula as Magic Shield. */
const combinedMagicDefense = (...rolls: number[]): number =>
    Number(((1 - rolls.reduce((missed, roll) => missed * (1 - roll / 100), 1)) * 100).toFixed(2));

const AEGIS = ARTIFACT_POWER.AEGIS_OF_THE_ARCANE_MAGIC_DEFENSE;

beforeEach(() => FightStateManager.getInstance().reset());

it("rolls 20% magic defense for every ally instead of adding 20, and clears on deselection", () => {
    expect(AEGIS).toBe(20);
    const { grid, unitsHolder } = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const allies = [
        createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.LEFT, magicResist: 0 }),
        createTestUnit({ name: "Champion", team: PBTypes.TeamVals.LEFT, magicResist: 15 }),
    ];
    const enemy = createTestUnit({ name: "Peasant", team: PBTypes.TeamVals.RIGHT, magicResist: 15 });
    [...allies, enemy].forEach((unit, i) => placeUnit(grid, unitsHolder, unit, { x: 2 + i, y: 2 }));
    unitsHolder.refreshStackPowerForAllUnits();
    const bases = allies.map((unit) => unit.getMagicResist());
    const enemyBase = enemy.getMagicResist();
    fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.AEGIS_OF_THE_ARCANE);
    for (let i = 0; i < 3; i++) {
        unitsHolder.applyArtifacts(fight);
        unitsHolder.refreshStackPowerForAllUnits();
        allies.forEach((unit, index) => {
            expect(unit.getMagicResist()).toBeCloseTo(combinedMagicDefense(bases[index], AEGIS), 2);
        });
        // 15 and a 20% roll is 32, not 15 + 20.
        expect(allies[1].getMagicResist()).toBeCloseTo(32, 2);
        expect(allies[1].getMagicResist()).not.toBeCloseTo(bases[1] + AEGIS, 2);
        expect(enemy.getMagicResist()).toBe(enemyBase);
    }
    fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.NO_ARTIFACT);
    unitsHolder.applyArtifacts(fight);
    unitsHolder.refreshStackPowerForAllUnits();
    allies.forEach((unit, index) => expect(unit.getMagicResist()).toBe(bases[index]));
});

it("combines with Magic Shield as another roll, not as points added before the shield", () => {
    const { grid, unitsHolder } = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const monk = createTestUnit({
        name: "Monk",
        team: PBTypes.TeamVals.LEFT,
        abilities: ["Magic Shield"],
        magicResist: 15,
        stackPower: 5,
    });
    placeUnit(grid, unitsHolder, monk, { x: 2, y: 2 });
    // The fight has not started, so luck stays 0 and the full-stack shield is its card power of 50.
    fight.setArtifactPerTeam(PBTypes.TeamVals.LEFT, 2, Tier2Artifact.AEGIS_OF_THE_ARCANE);
    unitsHolder.applyArtifacts(fight);
    unitsHolder.refreshStackPowerForAllUnits();

    // 1 − 0.85 × 0.80 × 0.50 = 66. Adding 20 first, then the shield, would be 67.5.
    expect(monk.getMagicResist()).toBeCloseTo(combinedMagicDefense(15, AEGIS, 50), 2);
    expect(monk.getMagicResist()).not.toBeCloseTo(combinedMagicDefense(15 + AEGIS, 50), 2);
});

it("is draftable under its new wire id with an accurate tooltip", () => {
    expect(ToTier2Artifact["14"]).toBe(Tier2Artifact.AEGIS_OF_THE_ARCANE);
    expect(TIER2_ARTIFACT_LIST.some((item) => item.id === Tier2Artifact.AEGIS_OF_THE_ARCANE)).toBe(true);
    expect(
        formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.AEGIS_OF_THE_ARCANE)),
    ).toContain("extra 20% magic defense roll");
});
