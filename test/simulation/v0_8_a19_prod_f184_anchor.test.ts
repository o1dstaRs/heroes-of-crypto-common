import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { IPlacementContext } from "../../src/ai/ai_strategy";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08A19RankedPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranked_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { Perk } from "../../src/perks/perk_properties";
import { createCombatFactories, createUnitFromSpec } from "../../src/simulation/army";
import {
    prepareV08A19ProdF184Pair,
    V08_A19_PROD_F184_ANCHOR,
    V08_A19_PROD_F184_FIXTURE_ID,
    V08_A19_PROD_F184_FIXTURE_SHA256,
    V08_A19_PROD_F184_MATCH_ID,
} from "../../src/simulation/v0_8_a19_prod_f184_anchor";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

describe("v0.8 A19 production f184 placement anchor", () => {
    test("pins the decoded complete production setup and its canonical digest", () => {
        expect(V08_A19_PROD_F184_ANCHOR.provenance).toEqual({
            fixtureId: V08_A19_PROD_F184_FIXTURE_ID,
            source: "production GamesTest1 + PicksTest1 + JournalEntriesTest1 terminal report; PM2 play-action placement log",
            matchId: V08_A19_PROD_F184_MATCH_ID,
            setupRecorded: true,
            terminalReportCompleteReplay: true,
            journalFull: false,
            completeInitialSetupRecovered: true,
        });
        expect(V08_A19_PROD_F184_ANCHOR.map).toBe(PBTypes.GridVals.NORMAL);
        expect(V08_A19_PROD_F184_ANCHOR.defaultPlacementDepth).toBe(3);
        expect(V08_A19_PROD_F184_ANCHOR.lower.creatureIds).toEqual([3, 33, 6, 4, 37, 9]);
        expect(V08_A19_PROD_F184_ANCHOR.upper.creatureIds).toEqual([47, 12, 55, 34, 27, 43]);
        expect(V08_A19_PROD_F184_ANCHOR.lower.roster.map(({ creatureName, amount }) => [creatureName, amount])).toEqual(
            [
                ["Troglodyte", 125],
                ["Arbalester", 124],
                ["Beholder", 22],
                ["Troll", 25],
                ["Griffin", 9],
                ["Black Dragon", 1],
            ],
        );
        expect(V08_A19_PROD_F184_ANCHOR.upper.roster.map(({ creatureName, amount }) => [creatureName, amount])).toEqual(
            [
                ["Dryad", 100],
                ["Berserker", 109],
                ["Battle Mage", 50],
                ["Valkyrie", 29],
                ["Mantis", 12],
                ["Frenzied Boar", 2],
            ],
        );
        expect(V08_A19_PROD_F184_ANCHOR.lower).toMatchObject({
            artifactT1: 10,
            artifactT2: 4,
            perk: Perk.SEE_NONE,
            empower: 0,
            augmentPlan: { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 },
        });
        expect(V08_A19_PROD_F184_ANCHOR.upper).toMatchObject({
            artifactT1: 8,
            artifactT2: 9,
            perk: Perk.SEE_NONE,
            empower: 0,
            augmentPlan: { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
        });
        expect(V08_A19_PROD_F184_ANCHOR.lower.synergies).toEqual([
            { faction: PBTypes.FactionVals.LIFE, synergy: 2, level: 1 },
            { faction: PBTypes.FactionVals.CHAOS, synergy: 1, level: 2 },
        ]);
        expect(V08_A19_PROD_F184_ANCHOR.upper.synergies).toEqual([
            { faction: PBTypes.FactionVals.LIFE, synergy: 2, level: 1 },
            { faction: PBTypes.FactionVals.MIGHT, synergy: 2, level: 1 },
            { faction: PBTypes.FactionVals.NATURE, synergy: 2, level: 1 },
        ]);
        expect(createHash("sha256").update(JSON.stringify(V08_A19_PROD_F184_ANCHOR)).digest("hex")).toBe(
            V08_A19_PROD_F184_FIXTURE_SHA256,
        );
    });

    test("materializes the exact setup deterministically while changing only cluster seeds", () => {
        const first = prepareV08A19ProdF184Pair(123, 4);
        const replay = prepareV08A19ProdF184Pair(123, 4);
        const next = prepareV08A19ProdF184Pair(123, 5);
        expect(replay).toEqual(first);
        expect(next.setupSeed).not.toBe(first.setupSeed);
        expect(next.combatSeed).not.toBe(first.combatSeed);
        expect(next.armyA).toEqual(first.armyA);
        expect(next.armyB).toEqual(first.armyB);
        expect(first.armyA.perk).toBe(Perk.SEE_NONE);
        expect(first.armyB.perk).toBe(Perk.SEE_NONE);
        expect(first.armyA.augment.planId).toBe("P0-A3-M3-S1-V0");
        expect(first.armyB.augment.planId).toBe("P0-A3-M3-S0-V1");
        expect(new Set([...first.armyA.creatureIds, ...first.armyB.creatureIds]).size).toBe(12);
    });

    test("applies the reviewed role correction with actual v0.8 placement and full public rosters", () => {
        const prepared = prepareV08A19ProdF184Pair(123, 0);
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const factories = createCombatFactories();
        const build = (team: TeamType, prefix: string, roster: typeof prepared.armyA.roster): Unit[] =>
            roster.map((spec, index) =>
                createUnitFromSpec(
                    spec,
                    team,
                    testGridSettings,
                    factories.abilityFactory,
                    factories.effectFactory,
                    false,
                    `${prefix}-${index}`,
                ),
            );
        const lower = build(LOWER, "prod-lower", prepared.armyA.roster);
        const upper = build(UPPER, "prod-upper", prepared.armyB.roster);
        [...lower, ...upper].forEach((unit) => combat.unitsHolder.addUnit(unit));

        const context = (team: TeamType, opponentIds: readonly number[]): IPlacementContext => ({
            team,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(
                testGridSettings,
                team === LOWER ? PlacementPositionType.LOWER_LEFT : PlacementPositionType.UPPER_RIGHT,
                V08_A19_PROD_F184_ANCHOR.defaultPlacementDepth,
            ),
            setupPlacementPolicy: "public-roster",
            publicOpponentCreatureIds: opponentIds,
        });
        const frontness = (team: TeamType, unit: Unit, placement: ReadonlyMap<string, { x: number; y: number }>) => {
            const base = placement.get(unit.getId())!;
            const y = unit.isSmallSize() ? base.y : base.y - 0.5;
            return team === LOWER ? y : 15 - y;
        };

        for (const [team, units, opponentIds, correctedName] of [
            [LOWER, lower, prepared.armyB.creatureIds, "Troll"],
            [UPPER, upper, prepared.armyA.creatureIds, "Valkyrie"],
        ] as const) {
            const placementContext = context(team, opponentIds);
            const incumbent = new StrategyV0_8().placeArmy(units, placementContext);
            const decorated = new V08A19RankedPlacementStrategy(new StrategyV0_8());
            const selected = decorated.placeArmy(units, placementContext);
            const corrected = units.find((unit) => unit.getName() === correctedName)!;

            expect(decorated.getLastPlacementAudit()).toMatchObject({
                treatmentApplied: true,
                placementChanged: true,
                correctedPhysicalUnits: 1,
                correctedForwardPhysicals: team === UPPER ? 1 : 0,
                correctedGroundScreens: team === LOWER ? 1 : 0,
                fallbackReason: null,
            });
            expect(frontness(team, corrected, selected)).toBeGreaterThan(frontness(team, corrected, incumbent));
        }
    });
});
