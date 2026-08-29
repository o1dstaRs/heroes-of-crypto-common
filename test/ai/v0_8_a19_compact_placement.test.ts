import { describe, expect, test } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import {
    V08_A19_COMPACT_PLACEMENT_ANCHORS,
    V08_A19_COMPACT_PLACEMENT_POLICY,
    V08A19CompactPlacementStrategy,
} from "../../src/ai/versions/v0_8_a19_compact_placement";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { layoutRevealPlacement } from "../../src/ai/versions/v0_7_placement_reveal";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { PathHelper } from "../../src/grid/path_helper";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
const NORMAL = PBTypes.GridVals.NORMAL;

const scenario = (
    anchor: string,
    team: TeamType = LEFT,
    gridType: GridType = NORMAL,
    summoned = false,
): { units: Unit[]; context: IPlacementContext; incumbent: Map<string, XY> } => {
    const combat = createCombatTestContext(gridType);
    const units = [
        createTestUnit({ name: "Arbalester", team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 8 }),
        createTestUnit({ name: "Berserker", team }),
        createTestUnit({ name: "Dryad", team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 8 }),
        createTestUnit({ name: "Mantis", team, movementType: PBTypes.MovementVals.FLY }),
        createTestUnit({ name: "Valkyrie", team, movementType: PBTypes.MovementVals.FLY }),
        createTestUnit({ name: anchor, team, size: PBTypes.UnitSizeVals.LARGE, summoned }),
    ];
    units.forEach((unit) => combat.unitsHolder.addUnit(unit));
    const context: IPlacementContext = {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LEFT ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
            5,
        ),
    };
    const incumbent = layoutRevealPlacement(units, context, {
        gap: 0,
        screenShooters: true,
        cornerShift: false,
    });
    return { units, context, incumbent };
};

const decoratedFor = (fixture: ReturnType<typeof scenario>, placeCalls: { value: number }) =>
    new V08A19CompactPlacementStrategy({
        version: "v0.8",
        placeArmy: () => {
            placeCalls.value += 1;
            return fixture.incumbent;
        },
        decideTurn: () => [],
    });

describe("v0.8 A19 level-4-scoped compact placement", () => {
    test("pins the explicit research identity and reviewed anchor list", () => {
        expect(V08_A19_COMPACT_PLACEMENT_POLICY).toMatchObject({
            schema: "hoc.v0_8_a19_compact_placement.v1",
            policyId: "a19-l4-scoped-compact-placement-v1",
            researchOnly: true,
        });
        expect(V08_A19_COMPACT_PLACEMENT_ANCHORS).toEqual([
            "Abomination",
            "Angel",
            "Arachna Queen",
            "Black Dragon",
            "Frenzied Boar",
            "Thunderbird",
        ]);
    });

    test("preserves base placement initialization and then uses legal compact coordinates for every anchor", () => {
        for (const anchor of V08_A19_COMPACT_PLACEMENT_ANCHORS) {
            for (const team of [LEFT, RIGHT] as const) {
                const fixture = scenario(anchor, team);
                const calls = { value: 0 };
                const strategy = decoratedFor(fixture, calls);
                const expected = new StrategyV0_1().placeArmy(fixture.units, fixture.context);

                expect(strategy.placeArmy(fixture.units, fixture.context)).toEqual(expected);
                expect(calls.value).toBe(1);
                expect(strategy.getLastPlacementAudit()).toEqual({
                    treatmentApplied: true,
                    placementChanged: true,
                    selectedAnchor: anchor,
                    fallbackReason: null,
                });
            }
        }
    });

    test("fails closed for an unselected anchor, unsupported map, summoned army, or partial call", () => {
        const cases = [
            { fixture: scenario("Hydra"), reason: "unselected-anchor" },
            { fixture: scenario("Angel", LEFT, PBTypes.GridVals.BLOCK_CENTER), reason: "unsupported-map" },
            { fixture: scenario("Angel", LEFT, NORMAL, true), reason: "summoned-army" },
        ] as const;
        for (const { fixture, reason } of cases) {
            const strategy = decoratedFor(fixture, { value: 0 });
            expect(strategy.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(strategy.getLastPlacementAudit()?.fallbackReason).toBe(reason);
        }

        const partial = scenario("Angel");
        const strategy = decoratedFor(partial, { value: 0 });
        expect(strategy.placeArmy(partial.units.slice(1), partial.context)).toBe(partial.incumbent);
        expect(strategy.getLastPlacementAudit()?.fallbackReason).toBe("partial-army");
    });

    test("fails closed when compact coordinates are illegal and audits an unchanged compact incumbent", () => {
        const illegal = scenario("Angel");
        (illegal.context.placement as unknown as { possibleCellHashes: () => Set<number> }).possibleCellHashes = () =>
            new Set<number>();
        const illegalStrategy = decoratedFor(illegal, { value: 0 });
        expect(illegalStrategy.placeArmy(illegal.units, illegal.context)).toBe(illegal.incumbent);
        expect(illegalStrategy.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: false,
            placementChanged: false,
            fallbackReason: "candidate-incomplete-or-illegal",
        });

        const unchanged = scenario("Angel");
        const compact = new StrategyV0_1().placeArmy(unchanged.units, unchanged.context);
        const strategy = new V08A19CompactPlacementStrategy({
            version: "v0.8",
            placeArmy: () => compact,
            decideTurn: () => [],
        });
        expect(strategy.placeArmy(unchanged.units, unchanged.context)).toBe(compact);
        expect(strategy.getLastPlacementAudit()).toEqual({
            treatmentApplied: false,
            placementChanged: false,
            selectedAnchor: null,
            fallbackReason: "unchanged",
        });
    });

    test("delegates combat decisions unchanged", () => {
        const fixture = scenario("Angel");
        const unit = fixture.units[0];
        const expected: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => fixture.incumbent,
            decideTurn: () => expected,
        };
        const strategy = new V08A19CompactPlacementStrategy(base);
        expect(strategy.decideTurn(unit, {} as never)).toBe(expected);
    });
});
