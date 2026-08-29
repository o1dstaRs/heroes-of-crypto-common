import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { IPlacementContext } from "../../src/ai/ai_strategy";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { V08A19F184HumanPlacementStrategy } from "../../src/ai/versions/v0_8_a19_f184_human_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
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

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

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
        expect(V08_A19_PROD_F184_ANCHOR.left.creatureIds).toEqual([3, 33, 6, 4, 37, 9]);
        expect(V08_A19_PROD_F184_ANCHOR.right.creatureIds).toEqual([47, 12, 55, 34, 27, 43]);
        expect(V08_A19_PROD_F184_ANCHOR.left.roster.map(({ creatureName, amount }) => [creatureName, amount])).toEqual([
            ["Troglodyte", 125],
            ["Arbalester", 124],
            ["Beholder", 22],
            ["Troll", 25],
            ["Griffin", 9],
            ["Black Dragon", 1],
        ]);
        expect(V08_A19_PROD_F184_ANCHOR.right.roster.map(({ creatureName, amount }) => [creatureName, amount])).toEqual(
            [
                ["Dryad", 100],
                ["Berserker", 109],
                ["Battle Mage", 50],
                ["Valkyrie", 29],
                ["Mantis", 12],
                ["Frenzied Boar", 2],
            ],
        );
        expect(V08_A19_PROD_F184_ANCHOR.left).toMatchObject({
            artifactT1: 10,
            artifactT2: 4,
            doctrine: Doctrine.SEE_NONE,
            empower: 0,
            augmentPlan: { placement: 0, armor: 3, might: 3, sniper: 1, movement: 0 },
        });
        expect(V08_A19_PROD_F184_ANCHOR.right).toMatchObject({
            artifactT1: 8,
            artifactT2: 9,
            doctrine: Doctrine.SEE_NONE,
            empower: 0,
            augmentPlan: { placement: 0, armor: 3, might: 3, sniper: 0, movement: 1 },
        });
        expect(V08_A19_PROD_F184_ANCHOR.left.synergies).toEqual([
            { faction: PBTypes.FactionVals.LIFE, synergy: 2, level: 1 },
            { faction: PBTypes.FactionVals.CHAOS, synergy: 1, level: 2 },
        ]);
        expect(V08_A19_PROD_F184_ANCHOR.right.synergies).toEqual([
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
        expect(first.armyA.doctrine).toBe(Doctrine.SEE_NONE);
        expect(first.armyB.doctrine).toBe(Doctrine.SEE_NONE);
        expect(first.armyA.augment.planId).toBe("P0-A3-M3-S1-V0");
        expect(first.armyB.augment.planId).toBe("P0-A3-M3-S0-V1");
        expect(new Set([...first.armyA.creatureIds, ...first.armyB.creatureIds]).size).toBe(12);
    });

    test("replays the recorded opening with actual v0.8 placement and full public rosters", () => {
        const prepared = prepareV08A19ProdF184Pair(123, 0);
        const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
        const factories = createCombatFactories();
        const build = (team: TeamType, prefix: string, roster: typeof prepared.armyA.roster): Unit[] =>
            roster.map((spec, index) => {
                const unit = createUnitFromSpec(
                    spec,
                    team,
                    testGridSettings,
                    factories.abilityFactory,
                    factories.effectFactory,
                    false,
                    `${prefix}-${index}`,
                );
                // Fight 184 predates the mounted class shipping 2x1: restore each stack's RECORDED shape so
                // the replay stays a replay. The live-catalog behavior (shape gate disables the treatment)
                // is pinned by the policy suites.
                const recordedProperties = (
                    unit as unknown as {
                        unitProperties: { size: number; footprint_width: number; footprint_height: number };
                    }
                ).unitProperties;
                recordedProperties.size = spec.size;
                recordedProperties.footprint_width = spec.footprintWidth ?? spec.size;
                recordedProperties.footprint_height = spec.footprintHeight ?? spec.size;
                return unit;
            });
        const left = build(LEFT, "prod-lower", prepared.armyA.roster);
        const right = build(RIGHT, "prod-upper", prepared.armyB.roster);
        [...left, ...right].forEach((unit) => combat.unitsHolder.addUnit(unit));

        const context = (team: TeamType, opponentIds: readonly number[]): IPlacementContext => ({
            team,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(
                testGridSettings,
                team === LEFT ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
                V08_A19_PROD_F184_ANCHOR.defaultPlacementDepth,
            ),
            setupPlacementPolicy: "public-roster",
            publicOpponentCreatureIds: opponentIds,
        });
        for (const [team, units, opponentIds, openingId, observed] of [
            [
                LEFT,
                left,
                prepared.armyB.creatureIds,
                "prod-f184-lower-roster",
                V08_A19_PROD_F184_ANCHOR.observedPlacement.left,
            ],
            [
                RIGHT,
                right,
                prepared.armyA.creatureIds,
                "prod-f184-upper-roster",
                V08_A19_PROD_F184_ANCHOR.observedPlacement.right,
            ],
        ] as const) {
            const placementContext = context(team, opponentIds);
            const incumbent = new StrategyV0_8().placeArmy(units, placementContext);
            const decorated = new V08A19F184HumanPlacementStrategy(new StrategyV0_8());
            const selected = decorated.placeArmy(units, placementContext);

            expect(decorated.getLastPlacementAudit()).toMatchObject({
                treatmentApplied: true,
                placementChanged: true,
                openingId,
                templateUnitsMoved: 6,
                fallbackReason: null,
            });
            expect(selected).not.toEqual(incumbent);
            for (const unit of units) {
                const expected = observed.find((entry) => entry.creatureName === unit.getName());
                expect(expected).toBeDefined();
                expect(selected.get(unit.getId())).toEqual({ x: expected!.x, y: expected!.y });
            }
        }
    });
});
