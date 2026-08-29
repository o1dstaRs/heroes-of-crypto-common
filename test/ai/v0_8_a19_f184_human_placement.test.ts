import { describe, expect, test } from "bun:test";

import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import {
    applyV08A19F184HumanPlacement,
    V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256,
    V08_A19_F184_HUMAN_PLACEMENT_POLICY,
    V08A19F184HumanPlacementStrategy,
    type V08A19F184HumanOpeningId,
    type V08A19F184HumanPlacementFallbackReason,
} from "../../src/ai/versions/v0_8_a19_f184_human_placement";
import { layoutRevealPlacement } from "../../src/ai/versions/v0_7_placement_reveal";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import type { IPlacement } from "../../src/grid/placement_properties";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { SquarePlacement } from "../../src/grid/square_placement";
import { createCombatFactories, createUnitFromSpec, type IArmyUnitSpec } from "../../src/simulation/army";
import {
    V08_A19_PROD_F184_ANCHOR,
    V08_A19_PROD_F184_FIXTURE_SHA256,
} from "../../src/simulation/v0_8_a19_prod_f184_anchor";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const NORMAL = PBTypes.GridVals.NORMAL;
const LEFT_IDS = V08_A19_PROD_F184_ANCHOR.left.creatureIds;
const RIGHT_IDS = V08_A19_PROD_F184_ANCHOR.right.creatureIds;
const LEFT_ROSTER = V08_A19_PROD_F184_ANCHOR.left.roster;
const RIGHT_ROSTER = V08_A19_PROD_F184_ANCHOR.right.roster;

const leftTemplate: Readonly<Record<string, XY>> = {
    Troglodyte: { x: 13, y: 2 },
    Arbalester: { x: 14, y: 1 },
    Beholder: { x: 13, y: 1 },
    Troll: { x: 14, y: 2 },
    Griffin: { x: 10, y: 3 },
    "Black Dragon": { x: 9, y: 3 },
};
const rightTemplateNormalizedToLeft: Readonly<Record<string, XY>> = {
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
    team: TeamType = LEFT,
    gridType: GridType = NORMAL,
    placementDepth = 3,
    setupPlacementPolicy: IPlacementContext["setupPlacementPolicy"] = "public-roster",
): IScenario => {
    scenarioId += 1;
    const combat = createCombatTestContext(gridType);
    const factories = createCombatFactories();
    const units = specs.map((spec, index) => {
        const unit = createUnitFromSpec(
            spec,
            team,
            testGridSettings,
            factories.abilityFactory,
            factories.effectFactory,
            false,
            `f184-policy-${scenarioId}-${index}`,
        );
        // The fixture describes the RECORDED world: fight 184 was played before the mounted class shipped
        // 2x1, so its Griffin and Mantis were 1x1 size-1 stacks. The catalog has since reshaped them, and
        // the policy's own-unit shape gate would (correctly) disable the treatment for every live roster —
        // which the dedicated live-catalog test below pins. Here the recorded shapes are restored so the
        // exact-template machinery stays genuinely exercised.
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
    units.forEach((unit) => combat.unitsHolder.addUnit(unit));
    const context: IPlacementContext = {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LEFT ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
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
): { strategy: V08A19F184HumanPlacementStrategy; calls: { value: number } } => {
    const calls = { value: 0 };
    const strategy = new V08A19F184HumanPlacementStrategy({
        version: "v0.8",
        placeArmy: () => {
            calls.value += 1;
            return incumbent;
        },
        decideTurn: () => [],
    });
    return { strategy, calls };
};

const footprint = (unit: Unit, base: XY): XY[] =>
    getFootprintCellsForAnchor(base, unit.getFootprintWidth(), unit.getFootprintHeight());

const assertLegalCompletePlacement = (fixture: IScenario, placement: ReadonlyMap<string, XY>): void => {
    expect(placement.size).toBe(fixture.units.length);
    const legal = fixture.context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of fixture.units) {
        const base = placement.get(unit.getId());
        expect(base).toBeDefined();
        for (const cell of footprint(unit, base!)) {
            const key = (cell.x << 4) | cell.y;
            expect(legal.has(key)).toBe(true);
            expect(occupied.has(key)).toBe(false);
            occupied.add(key);
        }
    }
};

const expectedForTeam = (unit: Unit, leftBase: XY, team: TeamType): XY =>
    team === LEFT ? leftBase : { x: leftBase.x, y: unit.isSmallSize() ? 15 - leftBase.y : 16 - leftBase.y };

const withHashes = (base: IPlacement, hashes: Set<number>): IPlacement => ({
    getType: () => base.getType(),
    getSize: () => base.getSize(),
    isAllowed: (cell) => base.isAllowed(cell),
    possibleCellHashes: () => hashes,
    possibleCellPositions: (isSmallUnit) => base.possibleCellPositions(isSmallUnit),
});

const assertFallback = (
    fixture: IScenario,
    fallbackReason: V08A19F184HumanPlacementFallbackReason,
    requestedUnits = fixture.units,
): void => {
    const { strategy, calls } = decoratedFor(fixture);
    expect(strategy.placeArmy(requestedUnits, fixture.context)).toBe(fixture.incumbent);
    expect(calls.value).toBe(1);
    expect(strategy.getLastPlacementAudit()).toMatchObject({
        treatmentApplied: false,
        placementChanged: false,
        openingId: null,
        fallbackReason,
    });
};

describe("v0.8 A19 exact f184 human-opening placement policy", () => {
    test("has an isolated, production-fixture-bound v10 research identity", () => {
        expect(V08_A19_F184_HUMAN_PLACEMENT_POLICY).toMatchObject({
            schema: "hoc.v0_8_a19_f184_human_placement.v10",
            policyId: "a19-prod-f184-opening-v1",
            treatment: "exact-public-matchup-production-opening",
            productionFixtureSha256: V08_A19_PROD_F184_FIXTURE_SHA256,
            researchOnly: true,
        });
        expect(V08_A19_F184_HUMAN_PLACEMENT_FIXTURE_SHA256).toBe(V08_A19_PROD_F184_FIXTURE_SHA256);
        const base: IAIStrategy = { version: "v0.8", placeArmy: () => new Map(), decideTurn: () => [] };
        expect(new V08A19F184HumanPlacementStrategy(base).version).toBe("v0.8");
    });

    for (const [openingId, specs, opponentIds, template] of [
        ["prod-f184-lower-roster", LEFT_ROSTER, RIGHT_IDS, leftTemplate],
        ["prod-f184-upper-roster", RIGHT_ROSTER, LEFT_IDS, rightTemplateNormalizedToLeft],
    ] as const satisfies readonly [
        V08A19F184HumanOpeningId,
        readonly IArmyUnitSpec[],
        readonly number[],
        Readonly<Record<string, XY>>,
    ][]) {
        for (const team of [LEFT, RIGHT] as const) {
            test(`places ${openingId} exactly for ${team === LEFT ? "LEFT" : "RIGHT"}`, () => {
                const fixture = scenario(specs, opponentIds, team);
                const { strategy, calls } = decoratedFor(fixture);
                const selected = strategy.placeArmy(fixture.units, fixture.context);

                expect(calls.value).toBe(1);
                assertLegalCompletePlacement(fixture, selected);
                for (const unit of fixture.units) {
                    expect(selected.get(unit.getId())).toEqual(expectedForTeam(unit, template[unit.getName()], team));
                }
                expect(strategy.getLastPlacementAudit()).toMatchObject({
                    treatmentApplied: true,
                    placementChanged: true,
                    openingId,
                    fallbackReason: null,
                });
                expect(strategy.getLastPlacementAudit()?.templateUnitsMoved).toBeGreaterThan(0);
                expect(applyV08A19F184HumanPlacement(fixture.units, fixture.context, fixture.incumbent)).toEqual(
                    selected,
                );
            });
        }
    }

    test("is independent of unit IDs, own order, public-ID order, and seat", () => {
        const first = scenario(RIGHT_ROSTER, LEFT_IDS, RIGHT);
        const second = scenario([...RIGHT_ROSTER].reverse(), [...LEFT_IDS].reverse(), RIGHT);
        const firstSelected = decoratedFor(first).strategy.placeArmy(first.units, first.context);
        const secondSelected = decoratedFor(second).strategy.placeArmy(second.units, second.context);
        const byName = (units: Unit[], selected: ReadonlyMap<string, XY>): Record<string, XY | undefined> =>
            Object.fromEntries(units.map((unit) => [unit.getName(), selected.get(unit.getId())]));
        expect(byName(second.units, secondSelected)).toEqual(byName(first.units, firstSelected));
    });

    test("fails closed for map, team, policy, placement type, depth, orientation, or legal-zone drift", () => {
        assertFallback(scenario(RIGHT_ROSTER, LEFT_IDS, LEFT, PBTypes.GridVals.BLOCK_CENTER), "unsupported-map");

        const unsupportedTeam = scenario(RIGHT_ROSTER, LEFT_IDS);
        unsupportedTeam.context.team = PBTypes.TeamVals.NO_TEAM;
        assertFallback(unsupportedTeam, "unsupported-team");

        assertFallback(
            scenario(RIGHT_ROSTER, LEFT_IDS, LEFT, NORMAL, 3, "legitimate-reveal"),
            "unauthorized-or-missing-public-roster",
        );
        const missingPublic = scenario(RIGHT_ROSTER, LEFT_IDS);
        delete missingPublic.context.publicOpponentCreatureIds;
        assertFallback(missingPublic, "unauthorized-or-missing-public-roster");
        assertFallback(scenario(RIGHT_ROSTER, LEFT_IDS, LEFT, NORMAL, 4), "unsupported-placement-geometry");

        const square = scenario(RIGHT_ROSTER, LEFT_IDS);
        square.context.placement = new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 3);
        assertFallback(square, "unsupported-placement-geometry");

        const oppositeSeat = scenario(RIGHT_ROSTER, LEFT_IDS);
        oppositeSeat.context.placement = new RectanglePlacement(testGridSettings, PlacementPositionType.RIGHT_TOP, 3);
        assertFallback(oppositeSeat, "unsupported-placement-geometry");

        for (const mutation of ["minus", "plus"] as const) {
            const fixture = scenario(RIGHT_ROSTER, LEFT_IDS);
            const hashes = new Set(fixture.context.placement.possibleCellHashes());
            if (mutation === "minus") hashes.delete([...hashes][0]);
            else hashes.add(0);
            fixture.context.placement = withHashes(fixture.context.placement, hashes);
            assertFallback(fixture, "unsupported-placement-geometry");
        }
    });

    test("requires the exact six unique known public creature IDs", () => {
        assertFallback(scenario(RIGHT_ROSTER, LEFT_IDS.slice(0, 5)), "invalid-public-roster");
        assertFallback(scenario(RIGHT_ROSTER, [...LEFT_IDS, PBTypes.CreatureVals.WOLF]), "invalid-public-roster");
        assertFallback(scenario(RIGHT_ROSTER, [...LEFT_IDS.slice(0, 5), LEFT_IDS[0]]), "invalid-public-roster");
        assertFallback(scenario(RIGHT_ROSTER, [...LEFT_IDS.slice(0, 5), 999_999]), "unknown-public-identity");
        assertFallback(
            scenario(RIGHT_ROSTER, [...LEFT_IDS.slice(0, 5), PBTypes.CreatureVals.ORC]),
            "unmatched-public-opening",
        );
    });

    test("rejects partial, split, summoned, unknown, and metadata-mismatched own armies", () => {
        const partial = scenario(RIGHT_ROSTER, LEFT_IDS);
        assertFallback(partial, "partial-army", partial.units.slice(1));

        const duplicateRoster = RIGHT_ROSTER.map((spec) =>
            spec.creatureName === "Mantis" ? { ...RIGHT_ROSTER[3] } : { ...spec },
        );
        assertFallback(scenario(duplicateRoster, LEFT_IDS), "split-summoned-or-duplicate-army");

        const summoned = scenario(RIGHT_ROSTER, LEFT_IDS);
        (summoned.units[0] as unknown as { summoned: boolean }).summoned = true;
        assertFallback(summoned, "split-summoned-or-duplicate-army");

        const unknown = scenario(RIGHT_ROSTER, LEFT_IDS);
        (unknown.units[0] as unknown as { unitProperties: { name: string } }).unitProperties.name = "Unknown Unit";
        assertFallback(unknown, "unknown-own-identity");

        for (const mutate of [
            (unit: Unit) =>
                ((unit as unknown as { unitProperties: { level: number } }).unitProperties.level =
                    PBTypes.UnitLevelVals.THIRD),
            (unit: Unit) =>
                ((unit as unknown as { unitProperties: { size: number } }).unitProperties.size =
                    PBTypes.UnitSizeVals.LARGE),
            (unit: Unit) =>
                ((unit as unknown as { unitProperties: { faction: number } }).unitProperties.faction =
                    PBTypes.FactionVals.CHAOS),
            (unit: Unit) => ((unit as unknown as { unitType: number }).unitType = PBTypes.UnitVals.HERO),
        ]) {
            const fixture = scenario(RIGHT_ROSTER, LEFT_IDS);
            mutate(fixture.units[0]);
            assertFallback(fixture, "own-unit-shape-mismatch");
        }
    });

    test("returns the incumbent object and reports unchanged when the base already uses the template", () => {
        const fixture = scenario(LEFT_ROSTER, RIGHT_IDS);
        const template = applyV08A19F184HumanPlacement(fixture.units, fixture.context, fixture.incumbent);
        const { strategy, calls } = decoratedFor(fixture, template);
        expect(strategy.placeArmy(fixture.units, fixture.context)).toBe(template);
        expect(calls.value).toBe(1);
        expect(strategy.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: false,
            placementChanged: false,
            fallbackReason: "unchanged",
        });
    });

    test("today's shipped catalog reshapes the mounted class, so every live f184 roster falls back", () => {
        // Griffin (lower roster) and Mantis (upper roster) now ship 2x1 size-2; the recorded fight-184
        // stacks were 1x1 size-1. The shape gate exists precisely so the exact opening is never faked
        // onto differently-shaped pieces — the treatment must disable, not repair.
        for (const [specs, opponentIds] of [
            [LEFT_ROSTER, RIGHT_IDS],
            [RIGHT_ROSTER, LEFT_IDS],
        ] as const) {
            const fixture = scenario(specs, opponentIds);
            const mounted = new Set(["Griffin", "Mantis"]);
            for (const unit of fixture.units) {
                if (!mounted.has(unit.getName())) continue;
                const liveShape = (
                    unit as unknown as {
                        unitProperties: { size: number; footprint_width: number; footprint_height: number };
                    }
                ).unitProperties;
                liveShape.size = 2;
                liveShape.footprint_width = 2;
                liveShape.footprint_height = 1;
            }
            assertFallback(fixture, "own-unit-shape-mismatch");
        }
    });

    test("delegates combat decisions unchanged", () => {
        const fixture = scenario(RIGHT_ROSTER, LEFT_IDS);
        const unit = fixture.units[0];
        const decision: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => fixture.incumbent,
            decideTurn: () => [...decision],
        };
        const decorated = new V08A19F184HumanPlacementStrategy(base);
        expect(decorated.decideTurn(unit, {} as never)).toEqual(decision);
    });
});
