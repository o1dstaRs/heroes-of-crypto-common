import { describe, expect, test } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { FightProperties } from "../../src/fights/fight_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { creaturesByLevel } from "../../src/simulation/army";
import { NatureSynergy } from "../../src/synergies/synergy_properties";
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
    const acceptedPlacementWidth = (doctrine: Doctrine, augments?: ISetupAugment[]): number => {
        const properties = new FightProperties();
        seedAcceptedSetupForPlacement(properties, PBTypes.TeamVals.LEFT, doctrine, augments);
        return properties.getAugmentPlacement(PBTypes.TeamVals.LEFT)[0];
    };

    test("models accepted Placement L1/L2/L3 rectangle widths and rejects an over-budget expansion", () => {
        expect(acceptedPlacementWidth(Doctrine.SEE_NONE)).toBe(3);
        expect(acceptedPlacementWidth(Doctrine.SEE_NONE, [{ kind: "Placement", value: 0 }])).toBe(3);
        expect(acceptedPlacementWidth(Doctrine.SEE_NONE, [{ kind: "Placement", value: 1 }])).toBe(4);
        expect(acceptedPlacementWidth(Doctrine.SEE_NONE, [{ kind: "Placement", value: 2 }])).toBe(6);
        expect(
            acceptedPlacementWidth(Doctrine.SEE_ALL, [
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
            greenDoctrine: Doctrine.SEE_NONE,
            redDoctrine: Doctrine.SEE_NONE,
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
            greenDoctrine: Doctrine.SEE_NONE,
            redDoctrine: Doctrine.SEE_NONE,
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

    test("uses the configured seeded synergy variant for combat and board capacity", () => {
        const natureRoster = [
            { faction: "Nature", creatureName: "Fairy", level: 1, size: 1, amount: 10 },
            { faction: "Nature", creatureName: "Dryad", level: 1, size: 1, amount: 10 },
        ];
        const observed = new Map<number, { variant: number; placementSlots: number; flyArmor: number }>();
        runMatch({
            greenVersion: "v0.7",
            redVersion: "v0.7",
            roster: natureRoster,
            redRoster: natureRoster.map((unit) => ({ ...unit })),
            seed: 83030715,
            gridType: PBTypes.GridVals.NORMAL,
            maxLaps: 1,
            synergyVariants: { Nature: NatureSynergy.INCREASE_BOARD_UNITS },
            greenSynergies: [{ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.INCREASE_BOARD_UNITS }],
            redSynergies: [{ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.INCREASE_BOARD_UNITS }],
            decisionObserver: ({ unit, context }) => {
                const team = unit.getTeam();
                if (!observed.has(team)) {
                    observed.set(team, {
                        variant: context.fightProperties.getSynergyVariants().Nature,
                        placementSlots: context.fightProperties.getNumberOfUnitsAvailableForPlacement(team),
                        flyArmor: context.fightProperties.getAdditionalFlyArmorPerTeam(team),
                    });
                }
            },
        });

        expect(observed.size).toBe(2);
        for (const state of observed.values()) {
            expect(state.variant).toBe(NatureSynergy.INCREASE_BOARD_UNITS);
            expect(state.placementSlots).toBe(8);
            expect(state.flyArmor).toBe(0);
        }
    });

    test("rejects a setup choice that conflicts with the configured seeded variant", () => {
        const natureRoster = [
            { faction: "Nature", creatureName: "Fairy", level: 1, size: 1, amount: 10 },
            { faction: "Nature", creatureName: "Dryad", level: 1, size: 1, amount: 10 },
        ];
        expect(() =>
            runMatch({
                greenVersion: "v0.7",
                redVersion: "v0.7",
                roster: natureRoster,
                redRoster: natureRoster.map((unit) => ({ ...unit })),
                seed: 83030716,
                gridType: PBTypes.GridVals.NORMAL,
                maxLaps: 1,
                synergyVariants: { Nature: NatureSynergy.INCREASE_BOARD_UNITS },
                greenSynergies: [{ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.PLUS_FLY_ARMOR }],
                redSynergies: [{ faction: PBTypes.FactionVals.NATURE, synergy: NatureSynergy.INCREASE_BOARD_UNITS }],
            }),
        ).toThrow("does not match the configured Nature variant");
    });

    test("artifacts survive when augments are applied to the same team", () => {
        const buffsByTeam = collectFirstUnitBuffs({
            greenDoctrine: Doctrine.SEE_NONE,
            redDoctrine: Doctrine.SEE_NONE,
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

    test("accepts a seven-point placement, armor, and Empower setup", () => {
        const buffsByTeam = collectFirstUnitBuffs({
            greenDoctrine: Doctrine.SEE_NONE,
            redDoctrine: Doctrine.SEE_NONE,
            greenAugments: [
                { kind: "Placement", value: 1 },
                { kind: "Armor", value: 3 },
                { kind: "Empower", value: 3 },
            ],
            redAugments: [
                { kind: "Placement", value: 1 },
                { kind: "Armor", value: 3 },
                { kind: "Empower", value: 3 },
            ],
        });
        for (const [, buffs] of buffsByTeam) {
            expect(buffs).toContain("Armor Augment");
            expect(buffs).toContain("Empower Augment");
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
