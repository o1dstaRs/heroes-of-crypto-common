import { describe, expect, test } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Perk } from "../../src/perks/perk_properties";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { creaturesByLevel } from "../../src/simulation/army";
import { runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";

/**
 * Regression: a team fielding artifacts AND augments must keep BOTH sets of buffs. Before 2026-07-15,
 * applyTeamSetup seeded the artifact ids and only then called setDefaultPlacementPerTeam (to init the
 * augment maps) — whose first call for a team resets the artifact maps to NO_ARTIFACT, silently dropping
 * artifacts from every sim game that had augments too (the live server seeds placement first, so this was a
 * sim-only infidelity).
 */

const collectFirstUnitBuffs = (config: Partial<IMatchConfig>): Map<number, string[]> => {
    FightStateManager.getInstance();
    const entry = creaturesByLevel(1)[0];
    const roster = [
        { faction: entry.faction, creatureName: entry.creatureName, level: entry.level, size: entry.size, amount: 20 },
    ];
    const buffsByTeam = new Map<number, string[]>();
    runMatch({
        greenVersion: "v0.1",
        redVersion: "v0.1",
        roster,
        redRoster: roster.map((unit) => ({ ...unit })),
        seed: 83030710,
        gridType: PBTypes.GridVals.NORMAL,
        maxLaps: 1,
        ...config,
        decisionObserver: (observation) => {
            const team = observation.unit.getTeam();
            if (!buffsByTeam.has(team)) {
                buffsByTeam.set(
                    team,
                    observation.unit.getBuffs().map((buff) => buff.getName()),
                );
            }
        },
    });
    return buffsByTeam;
};

describe("battle_engine setup seeding", () => {
    test("artifacts survive when augments are applied to the same team", () => {
        const buffsByTeam = collectFirstUnitBuffs({
            greenPerk: Perk.SEE_NONE,
            redPerk: Perk.SEE_NONE,
            greenAugments: [
                { kind: "Armor", value: 3 },
                { kind: "Might", value: 3 },
            ],
            redAugments: [
                { kind: "Armor", value: 3 },
                { kind: "Might", value: 3 },
            ],
            greenArtifactT1: Tier1Artifact.IRON_PLATE,
            greenArtifactT2: Tier2Artifact.TITAN_PLATE,
            redArtifactT1: Tier1Artifact.IRON_PLATE,
            redArtifactT2: Tier2Artifact.TITAN_PLATE,
        });
        expect(buffsByTeam.size).toBeGreaterThan(0);
        for (const [, buffs] of buffsByTeam) {
            expect(buffs).toContain("Titan Plate");
            expect(buffs).toContain("Iron Plate");
            expect(buffs).toContain("Armor Augment");
            expect(buffs).toContain("Might Augment");
        }
    });

    test("artifacts alone still apply (no-augment path unchanged)", () => {
        const buffsByTeam = collectFirstUnitBuffs({
            greenArtifactT2: Tier2Artifact.TITAN_PLATE,
            redArtifactT2: Tier2Artifact.TITAN_PLATE,
        });
        expect(buffsByTeam.size).toBeGreaterThan(0);
        for (const [, buffs] of buffsByTeam) {
            expect(buffs).toContain("Titan Plate");
        }
    });
});
