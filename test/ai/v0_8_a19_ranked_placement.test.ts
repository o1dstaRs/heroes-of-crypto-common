import { describe, expect, test } from "bun:test";

import type { GameAction } from "../../src/engine/actions";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import {
    applyV08A19RankedPlacement,
    V08_A19_RANKED_PLACEMENT_POLICY,
    V08A19RankedPlacementStrategy,
} from "../../src/ai/versions/v0_8_a19_ranked_placement";
import { layoutRevealPlacement } from "../../src/ai/versions/v0_7_placement_reveal";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { PathHelper } from "../../src/grid/path_helper";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings, type TestUnitOptions } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const NORMAL = PBTypes.GridVals.NORMAL;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const RANGE = PBTypes.AttackVals.RANGE;
const LARGE = PBTypes.UnitSizeVals.LARGE;
const DOUBLE_FLYER_ROSTER = [PBTypes.CreatureVals.BLACK_DRAGON, PBTypes.CreatureVals.GRIFFIN] as const;

interface IScenario {
    readonly units: Unit[];
    readonly context: IPlacementContext;
    readonly incumbent: Map<string, XY>;
}

const scenario = (
    specs: readonly TestUnitOptions[],
    team: TeamType = LOWER,
    gridType: GridType = NORMAL,
    publicOpponentCreatureIds: readonly number[] | undefined = DOUBLE_FLYER_ROSTER,
    setupPlacementPolicy: IPlacementContext["setupPlacementPolicy"] = "public-roster",
): IScenario => {
    const combat = createCombatTestContext(gridType);
    const units = specs.map((spec) => createTestUnit({ ...spec, team }));
    units.forEach((unit) => combat.unitsHolder.addUnit(unit));
    const context: IPlacementContext = {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LOWER ? PlacementPositionType.LOWER_LEFT : PlacementPositionType.UPPER_RIGHT,
            5,
        ),
        ...(publicOpponentCreatureIds === undefined ? {} : { publicOpponentCreatureIds }),
        ...(setupPlacementPolicy === undefined ? {} : { setupPlacementPolicy }),
    };
    const incumbent = layoutRevealPlacement(units, context, {
        gap: 0,
        screenShooters: true,
        cornerShift: false,
    });
    return { units, context, incumbent };
};

const upperProductionSpecs: readonly TestUnitOptions[] = [
    { name: "Battle Mage", attackType: MELEE_MAGIC, spells: ["Life:Fire Strike"], amountAlive: 50 },
    { name: "Berserker", attackType: MELEE, amountAlive: 109 },
    { name: "Dryad", attackType: RANGE, rangeShots: 8, amountAlive: 100 },
    { name: "Frenzied Boar", attackType: MELEE, size: LARGE, amountAlive: 2 },
    { name: "Mantis", attackType: MELEE, movementType: PBTypes.MovementVals.FLY, amountAlive: 12 },
    {
        name: "Valkyrie",
        attackType: MELEE_MAGIC,
        movementType: PBTypes.MovementVals.FLY,
        abilities: ["Wind Flow"],
        amountAlive: 29,
    },
];

const lowerProductionSpecs: readonly TestUnitOptions[] = [
    { name: "Arbalester", attackType: RANGE, rangeShots: 8, amountAlive: 124 },
    { name: "Beholder", attackType: RANGE, rangeShots: 8, amountAlive: 22 },
    {
        name: "Black Dragon",
        attackType: MELEE,
        movementType: PBTypes.MovementVals.FLY,
        size: LARGE,
        amountAlive: 1,
    },
    { name: "Griffin", attackType: MELEE, movementType: PBTypes.MovementVals.FLY, amountAlive: 9 },
    { name: "Troglodyte", attackType: MELEE, amountAlive: 125 },
    { name: "Troll", attackType: MELEE_MAGIC, abilities: ["Wild Regeneration"], amountAlive: 25 },
];

const footprint = (unit: Unit, base: XY): XY[] =>
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
        for (const cell of footprint(unit, base!)) {
            const cellKey = (cell.x << 4) | cell.y;
            expect(legal.has(cellKey)).toBe(true);
            expect(occupied.has(cellKey)).toBe(false);
            occupied.add(cellKey);
        }
    }
};

const center = (unit: Unit, base: XY): XY => (unit.isSmallSize() ? base : { x: base.x - 0.5, y: base.y - 0.5 });
const frontness = (team: TeamType, unit: Unit, base: XY): number => {
    const cell = center(unit, base);
    return team === LOWER ? cell.y : 15 - cell.y;
};
const unitByName = (fixture: IScenario, name: string): Unit => fixture.units.find((unit) => unit.getName() === name)!;
const decoratedFor = (fixture: IScenario): V08A19RankedPlacementStrategy =>
    new V08A19RankedPlacementStrategy({
        version: "v0.8",
        placeArmy: () => fixture.incumbent,
        decideTurn: () => [],
    });

describe("v0.8 A19 ranked placement research policy", () => {
    test("binds the preregistered v8 identity without changing the wrapped strategy version", () => {
        expect(V08_A19_RANKED_PLACEMENT_POLICY).toMatchObject({
            schema: "hoc.v0_8_a19_ranked_placement.v8",
            policyId: "a19-ranked-placement-v8",
            treatment: "physical-role-corrected-double-flyer-shooter-screen",
            researchOnly: true,
        });
        const base: IAIStrategy = { version: "v0.8", placeArmy: () => new Map(), decideTurn: () => [] };
        expect(new V08A19RankedPlacementStrategy(base).version).toBe("v0.8");
    });

    test("keeps the historical reveal layout byte-identical when the optional taxonomy is omitted", () => {
        const fixture = scenario(upperProductionSpecs, UPPER);
        const explicitLegacy = layoutRevealPlacement(fixture.units, fixture.context, {
            gap: 0,
            screenShooters: true,
            cornerShift: false,
            physicalMeleeMagicRoles: false,
        });
        expect([...explicitLegacy]).toEqual([...fixture.incumbent]);
    });

    test("faithfully corrects the reviewed upper production roles inside the two-flyer screen", () => {
        const fixture = scenario(upperProductionSpecs, UPPER);
        const valkyrie = unitByName(fixture, "Valkyrie");
        const battleMage = unitByName(fixture, "Battle Mage");
        const dryad = unitByName(fixture, "Dryad");
        const decorated = decoratedFor(fixture);
        const placed = decorated.placeArmy(fixture.units, fixture.context);

        assertLegalCompletePlacement(fixture, placed);
        expect(frontness(UPPER, valkyrie, placed.get(valkyrie.getId())!)).toBeGreaterThan(
            frontness(UPPER, valkyrie, fixture.incumbent.get(valkyrie.getId())!),
        );
        expect(frontness(UPPER, battleMage, placed.get(battleMage.getId())!)).toBeLessThanOrEqual(2);
        expect(frontness(UPPER, dryad, placed.get(dryad.getId())!)).toBeLessThanOrEqual(2);
        expect(decorated.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            placementChanged: true,
            correctedPhysicalUnits: 1,
            correctedForwardPhysicals: 1,
            correctedGroundScreens: 0,
            nativeSpellbookBackliners: 1,
            fallbackReason: null,
        });
    });

    test("moves Troll from generic rear support into the reviewed lower guard screen", () => {
        const fixture = scenario(lowerProductionSpecs, LOWER);
        const troll = unitByName(fixture, "Troll");
        const decorated = decoratedFor(fixture);
        const placed = decorated.placeArmy(fixture.units, fixture.context);

        assertLegalCompletePlacement(fixture, placed);
        expect(frontness(LOWER, troll, placed.get(troll.getId())!)).toBeGreaterThan(
            frontness(LOWER, troll, fixture.incumbent.get(troll.getId())!),
        );
        expect(decorated.getLastPlacementAudit()).toMatchObject({
            treatmentApplied: true,
            placementChanged: true,
            correctedPhysicalUnits: 1,
            correctedForwardPhysicals: 0,
            correctedGroundScreens: 1,
            nativeSpellbookBackliners: 0,
            fallbackReason: null,
        });
    });

    test("mirrors the physical-role correction between lower and upper seats", () => {
        for (const team of [LOWER, UPPER] as const) {
            const fixture = scenario(upperProductionSpecs, team);
            const valkyrie = unitByName(fixture, "Valkyrie");
            const placed = applyV08A19RankedPlacement(fixture.units, fixture.context, fixture.incumbent);
            assertLegalCompletePlacement(fixture, placed);
            expect(frontness(team, valkyrie, placed.get(valkyrie.getId())!)).toBeGreaterThan(
                frontness(team, valkyrie, fixture.incumbent.get(valkyrie.getId())!),
            );
        }
    });

    test("fails closed outside the complete public double-flyer context", () => {
        const missingPublicRoster = scenario(upperProductionSpecs);
        delete missingPublicRoster.context.publicOpponentCreatureIds;
        const cases: Array<[IScenario, string]> = [
            [
                scenario(upperProductionSpecs, LOWER, NORMAL, [PBTypes.CreatureVals.GRIFFIN]),
                "opponent-unknown-or-not-double-flyer",
            ],
            [scenario(upperProductionSpecs, LOWER, PBTypes.GridVals.BLOCK_CENTER), "unsupported-map"],
            [missingPublicRoster, "unauthorized-or-missing-public-roster"],
            [
                scenario(upperProductionSpecs, LOWER, NORMAL, DOUBLE_FLYER_ROSTER, "legitimate-reveal"),
                "unauthorized-or-missing-public-roster",
            ],
        ];
        for (const [fixture, fallbackReason] of cases) {
            const decorated = decoratedFor(fixture);
            expect(decorated.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(decorated.getLastPlacementAudit()).toMatchObject({
                treatmentApplied: false,
                placementChanged: false,
                fallbackReason,
            });
        }
    });

    test("preserves splash precedence and unknown public identities", () => {
        const splash = scenario(upperProductionSpecs, LOWER, NORMAL, [
            ...DOUBLE_FLYER_ROSTER,
            PBTypes.CreatureVals.GARGANTUAN,
        ]);
        const unknown = scenario(upperProductionSpecs, LOWER, NORMAL, [...DOUBLE_FLYER_ROSTER, 999_999]);
        for (const [fixture, fallbackReason] of [
            [splash, "opponent-splash"],
            [unknown, "opponent-unknown-or-not-double-flyer"],
        ] as const) {
            const decorated = decoratedFor(fixture);
            expect(decorated.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(decorated.getLastPlacementAudit()?.fallbackReason).toBe(fallbackReason);
        }
    });

    test("does not invent a screen or touch specialist topology", () => {
        const noShooter = scenario(
            upperProductionSpecs.filter((spec) => spec.name !== "Dryad"),
            LOWER,
        );
        const noHistoricalGuard = scenario(
            upperProductionSpecs.filter((spec) => spec.name !== "Berserker" && spec.name !== "Frenzied Boar"),
            LOWER,
        );
        const noCorrection = scenario(
            upperProductionSpecs.filter((spec) => spec.name !== "Valkyrie"),
            LOWER,
        );
        const wrongRoleCounts = scenario(
            upperProductionSpecs.map((spec) =>
                spec.name === "Berserker"
                    ? { name: "Healer", attackType: PBTypes.AttackVals.MAGIC, spells: ["Life:Heal"], amountAlive: 20 }
                    : spec,
            ),
            LOWER,
        );
        const specialist = scenario(
            [...upperProductionSpecs, { name: "Angel", attackType: MELEE, amountAlive: 1 }],
            LOWER,
        );
        for (const [fixture, fallbackReason] of [
            [noShooter, "not-incumbent-shooter-screen"],
            [noHistoricalGuard, "not-incumbent-shooter-screen"],
            [noCorrection, "no-physical-melee-magic-correction"],
            [wrongRoleCounts, "not-reviewed-two-two-two-formation"],
            [specialist, "special-topology"],
        ] as const) {
            const decorated = decoratedFor(fixture);
            expect(decorated.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(decorated.getLastPlacementAudit()?.fallbackReason).toBe(fallbackReason);
        }
    });

    test("fails closed for unknown, duplicate, and non-shooter-screen incumbents", () => {
        const unknown = scenario(
            upperProductionSpecs.map((spec) =>
                spec.name === "Valkyrie" ? { ...spec, name: "Unknown Physical Mage" } : spec,
            ),
            LOWER,
        );
        const duplicate = scenario(
            upperProductionSpecs.map((spec) =>
                spec.name === "Mantis"
                    ? {
                          name: "Valkyrie",
                          attackType: MELEE_MAGIC,
                          movementType: PBTypes.MovementVals.FLY,
                          amountAlive: 1,
                      }
                    : spec,
            ),
            LOWER,
        );
        const altered = scenario(upperProductionSpecs, LOWER);
        const mantis = unitByName(altered, "Mantis");
        const valkyrie = unitByName(altered, "Valkyrie");
        const mantisCell = altered.incumbent.get(mantis.getId())!;
        const valkyrieCell = altered.incumbent.get(valkyrie.getId())!;
        altered.incumbent.set(mantis.getId(), { ...valkyrieCell });
        altered.incumbent.set(valkyrie.getId(), { ...mantisCell });

        for (const [fixture, fallbackReason] of [
            [unknown, "unknown-own-identity"],
            [duplicate, "split-summoned-or-duplicate-army"],
            [altered, "not-incumbent-shooter-screen"],
        ] as const) {
            const decorated = decoratedFor(fixture);
            expect(decorated.placeArmy(fixture.units, fixture.context)).toBe(fixture.incumbent);
            expect(decorated.getLastPlacementAudit()?.fallbackReason).toBe(fallbackReason);
        }
    });

    test("rejects partial-army placement calls without changing the incumbent object", () => {
        const fixture = scenario(upperProductionSpecs, LOWER);
        const decorated = decoratedFor(fixture);
        expect(decorated.placeArmy(fixture.units.slice(1), fixture.context)).toBe(fixture.incumbent);
        expect(decorated.getLastPlacementAudit()?.fallbackReason).toBe("partial-army");
    });

    test("delegates combat decisions unchanged", () => {
        const fixture = scenario(upperProductionSpecs, LOWER);
        const unit = fixture.units[0];
        const decision: GameAction[] = [{ type: "defend_turn", unitId: unit.getId() }];
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => fixture.incumbent,
            decideTurn: () => [...decision],
        };
        const decorated = new V08A19RankedPlacementStrategy(base);
        expect(decorated.decideTurn(unit, {} as never)).toEqual(decision);
    });
});
