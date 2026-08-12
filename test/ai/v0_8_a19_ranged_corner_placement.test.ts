import { describe, expect, test } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { V08A19RangedCornerPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranged_corner_placement";
import { layoutRevealPlacement } from "../../src/ai/versions/v0_7_placement_reveal";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { PathHelper } from "../../src/grid/path_helper";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings, type TestUnitOptions } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const LARGE = PBTypes.UnitSizeVals.LARGE;

interface IScenario {
    readonly units: Unit[];
    readonly context: IPlacementContext;
    readonly incumbent: Map<string, XY>;
}

const SUPPORT_FIRELINE: readonly TestUnitOptions[] = [
    { name: "Arbalester", attackType: RANGE, rangeShots: 8, amountAlive: 124 },
    { name: "Beholder", attackType: RANGE, rangeShots: 8, amountAlive: 22 },
    { name: "Ogre Mage", attackType: MELEE_MAGIC, spells: ["Chaos:Mass Riot"], amountAlive: 9 },
    { name: "Behemoth", attackType: MELEE_MAGIC, size: LARGE, amountAlive: 1 },
    { name: "Troglodyte", attackType: MELEE, amountAlive: 120 },
    { name: "Berserker", attackType: MELEE, amountAlive: 110 },
];

const scenario = (
    team: TeamType = LOWER,
    publicOpponentCreatureIds: readonly number[] = [creatureIdForName("Peasant")!],
    placementSize = 5,
): IScenario => {
    const combat = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const units = SUPPORT_FIRELINE.map((spec) => createTestUnit({ ...spec, team }));
    units.forEach((unit) => combat.unitsHolder.addUnit(unit));
    const context: IPlacementContext = {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LOWER ? PlacementPositionType.LOWER_LEFT : PlacementPositionType.UPPER_RIGHT,
            placementSize,
        ),
        setupPlacementPolicy: "public-roster",
        publicOpponentCreatureIds,
    };
    const incumbent = layoutRevealPlacement(units, context, {
        gap: 0,
        screenShooters: true,
        cornerShift: false,
        physicalMeleeMagicRoles: true,
    });
    return { units, context, incumbent };
};

const footprintFor = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [base]
        : [base, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];

const assertLegalCompletePlacement = (fixture: IScenario, placement: ReadonlyMap<string, XY>): void => {
    expect(placement.size).toBe(fixture.units.length);
    const legal = fixture.context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of fixture.units) {
        const base = placement.get(unit.getId());
        expect(base).toBeDefined();
        for (const cell of footprintFor(unit, base!)) {
            const cellKey = (cell.x << 4) | cell.y;
            expect(legal.has(cellKey)).toBe(true);
            expect(occupied.has(cellKey)).toBe(false);
            occupied.add(cellKey);
        }
    }
};

const unitByName = (fixture: IScenario, name: string): Unit => fixture.units.find((unit) => unit.getName() === name)!;
const supportSpan = (fixture: IScenario, placement: ReadonlyMap<string, XY>): number => {
    const ids = ["Arbalester", "Beholder", "Ogre Mage"].map((name) => unitByName(fixture, name).getId());
    const xs = ids.map((id) => placement.get(id)!.x);
    return Math.max(...xs) - Math.min(...xs);
};
const candidate = (fixture: IScenario): V08A19RangedCornerPlacementStrategy => {
    const base: IAIStrategy = { version: "v0.8", placeArmy: () => fixture.incumbent, decideTurn: () => [] };
    return new V08A19RangedCornerPlacementStrategy(base);
};

describe("v0.8 A19 Ogre Mage and Behemoth ranged-corner placement", () => {
    test("compacts the supported fireline at one edge while putting Behemoth beside the first shooter", () => {
        const fixture = scenario();
        const strategy = candidate(fixture);
        const placed = strategy.placeArmy(fixture.units, fixture.context);
        const arbalester = unitByName(fixture, "Arbalester");
        const behemoth = unitByName(fixture, "Behemoth");

        assertLegalCompletePlacement(fixture, placed);
        expect(supportSpan(fixture, placed)).toBeLessThan(supportSpan(fixture, fixture.incumbent));
        expect(
            fixture.context.grid.areCellsAdjacent(
                footprintFor(arbalester, placed.get(arbalester.getId())!),
                footprintFor(behemoth, placed.get(behemoth.getId())!),
            ),
        ).toBe(true);
        expect(strategy.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            placementChanged: true,
            rangedUnitIds: [unitByName(fixture, "Arbalester").getId(), unitByName(fixture, "Beholder").getId()],
            ogreMageId: unitByName(fixture, "Ogre Mage").getId(),
            behemothId: behemoth.getId(),
            fallbackReason: null,
        });
    });

    test("mirrors the formation for the upper seat", () => {
        const fixture = scenario(UPPER);
        const placed = candidate(fixture).placeArmy(fixture.units, fixture.context);
        assertLegalCompletePlacement(fixture, placed);
        expect(supportSpan(fixture, placed)).toBeLessThan(supportSpan(fixture, fixture.incumbent));
    });

    test("fails closed against public flyers and splash", () => {
        for (const [opponent, reason] of [
            [[creatureIdForName("Griffin")!], "opponent-flyer"],
            [[creatureIdForName("Gargantuan")!], "opponent-splash"],
            [[creatureIdForName("Battle Mage")!], "opponent-ranged-spell-damage"],
        ] as const) {
            const fixture = scenario(LOWER, opponent);
            const strategy = candidate(fixture);
            expect(strategy.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(strategy.getLastPlacementAudit()?.fallbackReason).toBe(reason);
        }
    });

    test("keeps the incumbent formation without an extended placement zone", () => {
        const fixture = scenario(LOWER, [creatureIdForName("Peasant")!], 3);
        const strategy = candidate(fixture);
        expect(strategy.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
        expect(strategy.getLastPlacementAudit()?.fallbackReason).toBe("placement-not-extended");
    });

    test("leaves combat decisions to the wrapped A19 strategy", () => {
        const fixture = scenario();
        const decision: GameAction[] = [{ type: "defend_turn", unitId: fixture.units[0].getId() }];
        const strategy = new V08A19RangedCornerPlacementStrategy({
            version: "v0.8",
            placeArmy: () => fixture.incumbent,
            decideTurn: () => [...decision],
        });
        expect(strategy.decideTurn(fixture.units[0], {} as never)).toEqual(decision);
    });
});
