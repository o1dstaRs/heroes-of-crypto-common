import { describe, expect, test } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import {
    V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY,
    V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT,
    V08A19BoarBattleMageFlankPlacementStrategy,
    withV08A19BoarBattleMageFlankPlacement,
} from "../../src/ai/versions/v0_8_a19_boar_battle_mage_flank_placement";
import { StrategyV0_1 } from "../../src/ai/versions/v0_1";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { PathHelper } from "../../src/grid/path_helper";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const NORMAL = PBTypes.GridVals.NORMAL;

interface IScenarioOptions {
    readonly team?: TeamType;
    readonly gridType?: GridType;
    readonly battleMageCount?: number;
    readonly boarCount?: number;
    readonly summoned?: boolean;
}

interface IScenario {
    readonly units: Unit[];
    readonly context: IPlacementContext;
    readonly incumbent: Map<string, XY>;
}

const scenario = ({
    team = LOWER,
    gridType = NORMAL,
    battleMageCount = 1,
    boarCount = 1,
    summoned = false,
}: IScenarioOptions = {}): IScenario => {
    const combat = createCombatTestContext(gridType);
    const units = [
        ...Array.from({ length: battleMageCount }, () =>
            createTestUnit({ name: "Battle Mage", team, attackType: PBTypes.AttackVals.MELEE_MAGIC, summoned }),
        ),
        createTestUnit({ name: "Arbalester", team, attackType: PBTypes.AttackVals.RANGE, rangeShots: 8 }),
        createTestUnit({ name: "Blacksmith", team }),
        createTestUnit({ name: "White Tiger", team }),
        createTestUnit({ name: "Efreet", team, attackType: PBTypes.AttackVals.MELEE_MAGIC }),
        ...Array.from({ length: boarCount }, () =>
            createTestUnit({ name: "Frenzied Boar", team, size: PBTypes.UnitSizeVals.LARGE }),
        ),
    ];
    units.forEach((unit) => combat.unitsHolder.addUnit(unit));
    const context: IPlacementContext = {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LOWER ? PlacementPositionType.LOWER_LEFT : PlacementPositionType.UPPER_RIGHT,
            3,
        ),
    };
    const incumbent = new StrategyV0_1().placeArmy(units, context);
    return { units, context, incumbent };
};

const unitByName = (fixture: IScenario, name: string): Unit => fixture.units.find((unit) => unit.getName() === name)!;

const footprint = (unit: Unit, base: XY): XY[] =>
    unit.isSmallSize()
        ? [base]
        : [base, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];

const assertCompleteLegalPlacement = (fixture: IScenario, placement: ReadonlyMap<string, XY>): void => {
    expect(placement.size).toBe(fixture.units.length);
    const legal = fixture.context.placement.possibleCellHashes();
    const occupied = new Set<number>();
    for (const unit of fixture.units) {
        const base = placement.get(unit.getId());
        expect(base).toBeDefined();
        for (const cell of footprint(unit, base!)) {
            const cellKey = (cell.x << 4) | cell.y;
            expect(legal.has(cellKey)).toBe(true);
            expect(occupied.has(cellKey)).toBe(false);
            occupied.add(cellKey);
        }
    }
};

const decoratedFor = (fixture: IScenario, calls: { value: number }) =>
    new V08A19BoarBattleMageFlankPlacementStrategy({
        version: "v0.8",
        placeArmy: () => {
            calls.value += 1;
            return fixture.incumbent;
        },
        decideTurn: () => [],
    });

describe("v0.8 A19 Boar + Battle Mage far-flank placement", () => {
    test("pins an immutable, default-off research identity", () => {
        expect(V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY).toMatchObject({
            schema: "hoc.v0_8_a19_boar_battle_mage_flank_placement.v1",
            policyId: "a19-boar-battle-mage-far-flank-v1",
            researchOnly: true,
            defaultEnabled: false,
            treatment: V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT,
        });
        expect(Object.isFrozen(V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY)).toBe(true);
        expect(Object.isFrozen(V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.rosterCondition)).toBe(true);
        expect(Object.isFrozen(V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.expectedCompactOrigin)).toBe(true);
        expect(Object.isFrozen(V08_A19_BOAR_BATTLE_MAGE_FLANK_PLACEMENT_POLICY.destination)).toBe(true);

        const base: IAIStrategy = { version: "v0.8", placeArmy: () => new Map(), decideTurn: () => [] };
        expect(withV08A19BoarBattleMageFlankPlacement(base).version).toBe(base.version);
    });

    test("calls the base first and moves only the Boar to the legal far flank for both seats", () => {
        for (const team of [LOWER, UPPER] as const) {
            const fixture = scenario({ team });
            const calls = { value: 0 };
            const strategy = decoratedFor(fixture, calls);
            const boar = unitByName(fixture, "Frenzied Boar");
            const originalEntries = [...fixture.incumbent].map(([id, cell]) => [id, { ...cell }] as const);
            const expectedY = team === LOWER ? 3 : 13;

            expect(fixture.incumbent.get(boar.getId())).toEqual({ x: 2, y: expectedY });
            const placed = strategy.placeArmy(fixture.units, fixture.context);

            expect(calls.value).toBe(1);
            expect(placed).not.toBe(fixture.incumbent);
            expect(placed.get(boar.getId())).toEqual({ x: 14, y: expectedY });
            expect([...fixture.incumbent]).toEqual(originalEntries);
            for (const unit of fixture.units.filter((unit) => unit.getId() !== boar.getId())) {
                expect(placed.get(unit.getId())).toEqual(fixture.incumbent.get(unit.getId()));
            }
            assertCompleteLegalPlacement(fixture, placed);
            expect(strategy.getLastPlacementAudit()).toEqual({
                treatment: V08_A19_BOAR_BATTLE_MAGE_FLANK_TREATMENT,
                treatmentApplied: true,
                placementChanged: true,
                boarId: boar.getId(),
                battleMageCount: 1,
                fallbackReason: null,
            });
            expect(Object.isFrozen(strategy.getLastPlacementAudit())).toBe(true);
        }
    });

    test("accepts the reviewed duplicate-Battle-Mage roster condition", () => {
        const fixture = scenario({ battleMageCount: 2 });
        const strategy = decoratedFor(fixture, { value: 0 });
        const boar = unitByName(fixture, "Frenzied Boar");

        const placed = strategy.placeArmy(fixture.units, fixture.context);

        expect(placed.get(boar.getId())).toEqual({ x: 14, y: 3 });
        expect(strategy.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            battleMageCount: 2,
            fallbackReason: null,
        });
        assertCompleteLegalPlacement(fixture, placed);
    });

    test("fails closed outside the exact normal, full, non-summoned roster condition", () => {
        const unsupportedTeam = scenario();
        const cases: Array<{
            fixture: IScenario;
            reason: string;
            requestedUnits?: Unit[];
            context?: IPlacementContext;
        }> = [
            { fixture: scenario({ gridType: PBTypes.GridVals.BLOCK_CENTER }), reason: "unsupported-map" },
            {
                fixture: unsupportedTeam,
                reason: "unsupported-team",
                context: { ...unsupportedTeam.context, team: PBTypes.TeamVals.NO_TEAM },
            },
            { fixture: scenario({ summoned: true }), reason: "summoned-army" },
            { fixture: scenario({ battleMageCount: 0 }), reason: "roster-condition-not-met" },
            { fixture: scenario({ boarCount: 2 }), reason: "roster-condition-not-met" },
        ];

        const partial = scenario();
        cases.push({ fixture: partial, requestedUnits: partial.units.slice(1), reason: "partial-army" });

        for (const { fixture, reason, requestedUnits = fixture.units, context = fixture.context } of cases) {
            const strategy = decoratedFor(fixture, { value: 0 });
            expect(strategy.placeArmy(requestedUnits, context)).toBe(fixture.incumbent);
            expect(strategy.getLastPlacementAudit()).toMatchObject({
                treatment: null,
                treatmentApplied: false,
                placementChanged: false,
                fallbackReason: reason,
            });
        }
    });

    test("fails closed for an unexpected compact origin or an occupied far-flank footprint", () => {
        const unexpected = scenario();
        const unexpectedBoar = unitByName(unexpected, "Frenzied Boar");
        unexpected.incumbent.set(unexpectedBoar.getId(), { x: 9, y: 3 });
        const unexpectedStrategy = decoratedFor(unexpected, { value: 0 });
        expect(unexpectedStrategy.placeArmy(unexpected.units, unexpected.context)).toBe(unexpected.incumbent);
        expect(unexpectedStrategy.getLastPlacementAudit()?.fallbackReason).toBe("unexpected-compact-origin");

        const occupied = scenario();
        const occupiedBoar = unitByName(occupied, "Frenzied Boar");
        const blocker = occupied.units.find((unit) => unit.getId() !== occupiedBoar.getId())!;
        occupied.incumbent.set(blocker.getId(), { x: 14, y: 3 });
        const occupiedStrategy = decoratedFor(occupied, { value: 0 });
        expect(occupiedStrategy.placeArmy(occupied.units, occupied.context)).toBe(occupied.incumbent);
        expect(occupied.incumbent.get(occupiedBoar.getId())).toEqual({ x: 2, y: 3 });
        expect(occupiedStrategy.getLastPlacementAudit()).toMatchObject({
            treatment: null,
            treatmentApplied: false,
            placementChanged: false,
            fallbackReason: "candidate-incomplete-or-illegal",
        });
    });

    test("delegates combat decisions unchanged", () => {
        const fixture = scenario();
        const unit = fixture.units[0];
        const expected: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => fixture.incumbent,
            decideTurn: () => expected,
        };
        const strategy = new V08A19BoarBattleMageFlankPlacementStrategy(base);

        expect(strategy.decideTurn(unit, {} as never)).toBe(expected);
    });
});
