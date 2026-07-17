import { describe, expect, test } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Perk } from "../../src/perks/perk_properties";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { creaturesByLevel } from "../../src/simulation/army";
import {
    runMatch,
    seedAcceptedSetupForPlacement,
    type IMatchConfig,
    type ISetupAugment,
} from "../../src/simulation/battle_engine";

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
    const acceptedPlacementWidth = (perk: Perk, augments?: ISetupAugment[]): number => {
        const properties = new FightProperties();
        seedAcceptedSetupForPlacement(properties, PBTypes.TeamVals.LOWER, perk, augments);
        return properties.getAugmentPlacement(PBTypes.TeamVals.LOWER)[0];
    };

    test("models accepted Placement L1/L2/L3 rectangle widths and rejects an over-budget expansion", () => {
        expect(acceptedPlacementWidth(Perk.SEE_NONE)).toBe(3);
        expect(acceptedPlacementWidth(Perk.SEE_NONE, [{ kind: "Placement", value: 0 }])).toBe(3);
        expect(acceptedPlacementWidth(Perk.SEE_NONE, [{ kind: "Placement", value: 1 }])).toBe(4);
        expect(acceptedPlacementWidth(Perk.SEE_NONE, [{ kind: "Placement", value: 2 }])).toBe(5);
        expect(
            acceptedPlacementWidth(Perk.SEE_ALL, [
                { kind: "Armor", value: 3 },
                { kind: "Might", value: 2 },
                { kind: "Placement", value: 1 },
            ]),
        ).toBe(3);
    });

    test("keeps legacy delayed placement byte-identical when a Placement augment is recorded", () => {
        const entry = creaturesByLevel(1)[0];
        const roster = [
            {
                faction: entry.faction,
                creatureName: entry.creatureName,
                level: entry.level,
                size: entry.size,
                amount: 20,
            },
        ];
        const base: IMatchConfig = {
            greenVersion: "v0.7",
            redVersion: "v0.7",
            roster,
            redRoster: roster.map((unit) => ({ ...unit })),
            seed: 83030711,
            gridType: PBTypes.GridVals.NORMAL,
            maxLaps: 2,
            greenPerk: Perk.SEE_NONE,
            redPerk: Perk.SEE_NONE,
        };
        const baseline = runMatch(base);
        const delayed = runMatch({
            ...base,
            greenAugments: [{ kind: "Placement", value: 2 }],
            redAugments: [{ kind: "Placement", value: 2 }],
        });
        expect(delayed.placements).toEqual(baseline.placements);
        expect(delayed.actions).toEqual(baseline.actions);
        expect(delayed.outcome).toEqual(baseline.outcome);
    });

    test("models server-main re-placement with the final strategy position in the expanded zone", () => {
        const unit = { faction: "Life", creatureName: "Pikeman", level: 2, size: 1, amount: 7 };
        const base: IMatchConfig = {
            greenVersion: "v0.7",
            redVersion: "v0.7",
            roster: [unit],
            redRoster: [{ ...unit }],
            seed: 83030712,
            gridType: PBTypes.GridVals.NORMAL,
            maxLaps: 1,
            greenPerk: Perk.SEE_NONE,
            redPerk: Perk.SEE_NONE,
            placementAugmentTiming: "setup-before-placement",
        };
        const defaultZone = runMatch(base);
        const placementL2 = runMatch({
            ...base,
            greenAugments: [{ kind: "Placement", value: 1 }],
            redAugments: [{ kind: "Placement", value: 1 }],
        });
        const placementL3 = runMatch({
            ...base,
            greenAugments: [{ kind: "Placement", value: 2 }],
            redAugments: [{ kind: "Placement", value: 2 }],
        });

        expect(defaultZone.placements.green[0].cell).toEqual({ x: 1, y: 3 });
        expect(placementL2.placements.green[0].cell).toEqual({ x: 0, y: 4 });
        expect(placementL3.placements.green[0].cell).toEqual({ x: 0, y: 5 });
        expect(placementL2.placements.red[0].cell).toEqual({ x: 0, y: 11 });
        expect(placementL3.placements.red[0].cell).toEqual({ x: 0, y: 10 });
    });

    test("keeps Grid and FightProperties synchronized on explicit BLOCK and LAVA maps", () => {
        const unit = { faction: "Life", creatureName: "Pikeman", level: 2, size: 1, amount: 7 };
        for (const gridType of [PBTypes.GridVals.BLOCK_CENTER, PBTypes.GridVals.LAVA_CENTER]) {
            const observed: Array<{ grid: number; fightProperties: number }> = [];
            const result = runMatch({
                greenVersion: "v0.7",
                redVersion: "v0.7",
                roster: [unit],
                redRoster: [{ ...unit }],
                seed: 83030713 + gridType,
                gridType,
                maxLaps: 1,
                decisionObserver: ({ context }) => {
                    observed.push({
                        grid: context.grid.getGridType(),
                        fightProperties: context.fightProperties.getGridType(),
                    });
                },
            });
            expect(result.gridType).toBe(gridType);
            expect(observed.length).toBeGreaterThan(0);
            expect(observed.every((entry) => entry.grid === gridType && entry.fightProperties === gridType)).toBe(true);
            expect(FightStateManager.getInstance().getFightProperties().getGridType()).toBe(gridType);
        }
    });

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
