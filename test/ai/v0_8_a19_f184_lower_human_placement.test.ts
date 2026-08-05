import { describe, expect, test } from "bun:test";

import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import {
    applyV08A19F184LowerHumanPlacement,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY,
    V08A19F184LowerHumanPlacementStrategy,
    type V08A19F184LowerHumanOpeningId,
    type V08A19F184LowerHumanPlacementFallbackReason,
} from "../../src/ai/versions/v0_8_a19_f184_lower_human_placement";
import { createV08A19H18F184LowerHumanRankedFallbackStrategy } from "../../src/ai/versions/v0_8_a19_h18_f184_lower_human_placement_profile";
import { V08A19RankedPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranked_placement";
import { layoutRevealPlacement } from "../../src/ai/versions/v0_7_placement_reveal";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { createCombatFactories, createUnitFromSpec, type IArmyUnitSpec } from "../../src/simulation/army";
import {
    V08_A19_PROD_F184_ANCHOR,
    V08_A19_PROD_F184_FIXTURE_SHA256,
} from "../../src/simulation/v0_8_a19_prod_f184_anchor";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const NORMAL = PBTypes.GridVals.NORMAL;
const LOWER_IDS = V08_A19_PROD_F184_ANCHOR.lower.creatureIds;
const UPPER_IDS = V08_A19_PROD_F184_ANCHOR.upper.creatureIds;
const LOWER_ROSTER = V08_A19_PROD_F184_ANCHOR.lower.roster;
const UPPER_ROSTER = V08_A19_PROD_F184_ANCHOR.upper.roster;

const lowerTemplate: Readonly<Record<string, XY>> = {
    Troglodyte: { x: 13, y: 2 },
    Arbalester: { x: 14, y: 1 },
    Beholder: { x: 13, y: 1 },
    Troll: { x: 14, y: 2 },
    Griffin: { x: 10, y: 3 },
    "Black Dragon": { x: 9, y: 3 },
};

const upperTemplateNormalizedToLower: Readonly<Record<string, XY>> = {
    Dryad: { x: 6, y: 1 },
    Berserker: { x: 2, y: 2 },
    "Battle Mage": { x: 4, y: 1 },
    Valkyrie: { x: 6, y: 3 },
    Mantis: { x: 4, y: 3 },
    "Frenzied Boar": { x: 9, y: 3 },
};

interface IScenario {
    readonly units: Unit[];
    readonly context: IPlacementContext;
    readonly incumbent: Map<string, XY>;
}

let scenarioId = 0;
const scenario = (
    specs: readonly IArmyUnitSpec[],
    opponentIds: readonly number[],
    team: TeamType = LOWER,
    gridType: GridType = NORMAL,
    placementDepth = 3,
    setupPlacementPolicy: IPlacementContext["setupPlacementPolicy"] = "public-roster",
): IScenario => {
    scenarioId += 1;
    const combat = createCombatTestContext(gridType);
    const factories = createCombatFactories();
    const units = specs.map((spec, index) =>
        createUnitFromSpec(
            spec,
            team,
            testGridSettings,
            factories.abilityFactory,
            factories.effectFactory,
            false,
            `f184-lower-policy-${scenarioId}-${index}`,
        ),
    );
    units.forEach((unit) => combat.unitsHolder.addUnit(unit));
    const context: IPlacementContext = {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LOWER ? PlacementPositionType.LOWER_LEFT : PlacementPositionType.UPPER_RIGHT,
            placementDepth,
        ),
        publicOpponentCreatureIds: opponentIds,
        setupPlacementPolicy,
    };
    return {
        units,
        context,
        incumbent: layoutRevealPlacement(units, context, { gap: 0, screenShooters: true, cornerShift: false }),
    };
};

const decoratedFor = (
    fixture: IScenario,
    incumbent: Map<string, XY> = fixture.incumbent,
): { strategy: V08A19F184LowerHumanPlacementStrategy; calls: { value: number } } => {
    const calls = { value: 0 };
    const strategy = new V08A19F184LowerHumanPlacementStrategy({
        version: "v0.8",
        placeArmy: () => {
            calls.value += 1;
            return incumbent;
        },
        decideTurn: () => [],
    });
    return { strategy, calls };
};

const assertLegalCompletePlacement = (fixture: IScenario, placement: ReadonlyMap<string, XY>): void => {
    expect(placement.size).toBe(fixture.units.length);
    const legal = fixture.context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of fixture.units) {
        const base = placement.get(unit.getId());
        expect(base).toBeDefined();
        const footprint = unit.isSmallSize()
            ? [base!]
            : [
                  base!,
                  { x: base!.x - 1, y: base!.y },
                  { x: base!.x, y: base!.y - 1 },
                  { x: base!.x - 1, y: base!.y - 1 },
              ];
        for (const cell of footprint) {
            const key = (cell.x << 4) | cell.y;
            expect(legal.has(key)).toBe(true);
            expect(occupied.has(key)).toBe(false);
            occupied.add(key);
        }
    }
};

const assertFallback = (
    fixture: IScenario,
    fallbackReason: V08A19F184LowerHumanPlacementFallbackReason,
    requestedUnits = fixture.units,
): void => {
    const { strategy, calls } = decoratedFor(fixture);
    expect(strategy.placeArmy(requestedUnits, fixture.context)).toBe(fixture.incumbent);
    expect(calls.value).toBe(1);
    expect(strategy.getLastPlacementAudit()).toMatchObject({
        treatmentApplied: false,
        placementChanged: false,
        openingId: null,
        templateUnitsMoved: 0,
        fallbackReason,
    });
};

describe("v0.8 A19 exact f184 LOWER-only human-opening placement policy", () => {
    test("has a distinct production-fixture-bound v11 lower-only-v1 identity", () => {
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_POLICY).toMatchObject({
            schema: "hoc.v0_8_a19_f184_human_placement.v11.lower-only-v1",
            policyId: "a19-prod-f184-opening-lower-only-v1",
            treatment: "exact-public-matchup-production-opening-lower-only-v1",
            supportedTeam: LOWER,
            productionFixtureSha256: V08_A19_PROD_F184_FIXTURE_SHA256,
            researchOnly: true,
        });
        expect(V08_A19_F184_LOWER_HUMAN_PLACEMENT_FIXTURE_SHA256).toBe(V08_A19_PROD_F184_FIXTURE_SHA256);
        const base: IAIStrategy = { version: "v0.8", placeArmy: () => new Map(), decideTurn: () => [] };
        expect(new V08A19F184LowerHumanPlacementStrategy(base).version).toBe("v0.8");
    });

    for (const [openingId, specs, opponentIds, template] of [
        ["prod-f184-lower-roster", LOWER_ROSTER, UPPER_IDS, lowerTemplate],
        ["prod-f184-upper-roster", UPPER_ROSTER, LOWER_IDS, upperTemplateNormalizedToLower],
    ] as const satisfies readonly [
        V08A19F184LowerHumanOpeningId,
        readonly IArmyUnitSpec[],
        readonly number[],
        Readonly<Record<string, XY>>,
    ][]) {
        test(`places ${openingId} exactly when the candidate owns LOWER`, () => {
            const fixture = scenario([...specs].reverse(), [...opponentIds].reverse());
            const { strategy, calls } = decoratedFor(fixture);
            const selected = strategy.placeArmy(fixture.units, fixture.context);

            expect(calls.value).toBe(1);
            assertLegalCompletePlacement(fixture, selected);
            for (const unit of fixture.units) expect(selected.get(unit.getId())).toEqual(template[unit.getName()]);
            expect(strategy.getLastPlacementAudit()).toMatchObject({
                treatmentApplied: true,
                placementChanged: true,
                openingId,
                fallbackReason: null,
            });
            expect(strategy.getLastPlacementAudit()?.templateUnitsMoved).toBeGreaterThan(0);
            expect(applyV08A19F184LowerHumanPlacement(fixture.units, fixture.context, fixture.incumbent)).toEqual(
                selected,
            );
        });
    }

    test("returns the exact incumbent with explicit unsupported-team fallback for UPPER", () => {
        for (const [specs, opponentIds] of [
            [LOWER_ROSTER, UPPER_IDS],
            [UPPER_ROSTER, LOWER_IDS],
        ] as const) {
            const fixture = scenario(specs, opponentIds, UPPER);
            const { strategy, calls } = decoratedFor(fixture);
            expect(strategy.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(calls.value).toBe(1);
            expect(strategy.getLastPlacementAudit()).toMatchObject({
                treatmentApplied: false,
                placementChanged: false,
                openingId: null,
                templateUnitsMoved: 0,
                fallbackReason: "unsupported-team",
            });
            expect(strategy.getLastPlacementAudit()?.selectedFingerprint).toBe(
                strategy.getLastPlacementAudit()?.incumbentFingerprint,
            );
            expect(applyV08A19F184LowerHumanPlacement(fixture.units, fixture.context, fixture.incumbent)).toBe(
                fixture.incumbent,
            );
        }
    });

    test("keeps the exact f184 opening above a generic ranked-placement correction", () => {
        const fixture = scenario(UPPER_ROSTER, LOWER_IDS);
        const strategy = createV08A19H18F184LowerHumanRankedFallbackStrategy();
        const generic = (strategy as unknown as { base: V08A19RankedPlacementStrategy }).base;
        const selected = strategy.placeArmy(fixture.units, fixture.context);

        expect(generic.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            placementChanged: true,
            correctedPhysicalUnits: 1,
            correctedForwardPhysicals: 1,
            fallbackReason: null,
        });
        for (const unit of fixture.units) {
            expect(selected.get(unit.getId())).toEqual(upperTemplateNormalizedToLower[unit.getName()]);
        }
        expect(strategy.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            placementChanged: true,
            openingId: "prod-f184-upper-roster",
            fallbackReason: null,
        });
    });

    test("uses the generic correction when a LOWER public roster does not match f184", () => {
        const fixture = scenario(UPPER_ROSTER, [PBTypes.CreatureVals.BLACK_DRAGON, PBTypes.CreatureVals.GRIFFIN]);
        const strategy = createV08A19H18F184LowerHumanRankedFallbackStrategy();
        const generic = (strategy as unknown as { base: V08A19RankedPlacementStrategy }).base;
        const selected = strategy.placeArmy(fixture.units, fixture.context);
        const valkyrie = fixture.units.find((unit) => unit.getName() === "Valkyrie")!;

        expect(selected).not.toBe(fixture.incumbent);
        expect(selected.get(valkyrie.getId())?.y).toBeGreaterThan(fixture.incumbent.get(valkyrie.getId())!.y);
        expect(generic.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            placementChanged: true,
            correctedPhysicalUnits: 1,
            correctedForwardPhysicals: 1,
            fallbackReason: null,
        });
        expect(strategy.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: false,
            placementChanged: false,
            openingId: null,
            fallbackReason: "invalid-public-roster",
        });
    });

    test("retains the v10 lower-side fail-closed gates", () => {
        assertFallback(scenario(UPPER_ROSTER, LOWER_IDS, LOWER, PBTypes.GridVals.BLOCK_CENTER), "unsupported-map");
        assertFallback(scenario(UPPER_ROSTER, LOWER_IDS, LOWER, NORMAL, 4), "unsupported-placement-geometry");
        assertFallback(
            scenario(UPPER_ROSTER, LOWER_IDS, LOWER, NORMAL, 3, "legitimate-reveal"),
            "unauthorized-or-missing-public-roster",
        );
        assertFallback(scenario(UPPER_ROSTER, LOWER_IDS.slice(0, 5)), "invalid-public-roster");
        assertFallback(scenario(UPPER_ROSTER, [...LOWER_IDS.slice(0, 5), 999_999]), "unknown-public-identity");
        assertFallback(scenario(UPPER_ROSTER, UPPER_IDS), "unmatched-public-opening");

        const partial = scenario(UPPER_ROSTER, LOWER_IDS);
        assertFallback(partial, "partial-army", partial.units.slice(1));

        const shapeMismatch = scenario(UPPER_ROSTER, LOWER_IDS);
        (shapeMismatch.units[0] as unknown as { unitProperties: { level: number } }).unitProperties.level =
            PBTypes.UnitLevelVals.THIRD;
        assertFallback(shapeMismatch, "own-unit-shape-mismatch");
    });

    test("delegates combat decisions unchanged", () => {
        const fixture = scenario(UPPER_ROSTER, LOWER_IDS);
        const unit = fixture.units[0];
        const decision: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => fixture.incumbent,
            decideTurn: () => [...decision],
        };
        const decorated = new V08A19F184LowerHumanPlacementStrategy(base);
        expect(decorated.decideTurn(unit, {} as never)).toEqual(decision);
    });
});
