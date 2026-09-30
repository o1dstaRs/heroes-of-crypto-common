import { describe, expect, test } from "bun:test";

import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../../src/ai/ai_strategy";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    placeArmyR1C1,
    placeArmyR1C2,
    placeArmyR1C3,
    placeArmyR2C1,
    placeArmyR2C2,
    placeArmyR2C3,
    placeArmyR3C1,
    placeArmyR3C2,
    placeArmyR3C3,
    placeArmyR4C1,
    placeArmyR4C2,
    placeArmyR4C3,
    placeArmyR5C1,
    placeArmyR5C3,
    placeArmyR6C3,
    PlacementLiftStrategy,
    publicPlacementThreats,
    separationGapForThreats,
} from "../../src/ai/versions/v0_8_placement_lift";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { PathHelper } from "../../src/grid/path_helper";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const WALK = PBTypes.MovementVals.WALK;
const FLY = PBTypes.MovementVals.FLY;

const creature = (name: string): number => {
    const id = creatureIdForName(name);
    if (id === undefined) throw new Error(`Unknown creature ${name}`);
    return id;
};

const makeUnit = (
    name: string,
    attackType: number,
    shotDistance = 0,
    movementType: number = WALK,
    abilities: string[] = [],
): Unit =>
    createTestUnit({
        name,
        team: LEFT,
        attackType,
        rangeShots: attackType === RANGE ? 8 : 0,
        shotDistance,
        movementType,
        abilities,
    });

const at = (units: readonly Unit[], cells: readonly XY[]): Map<string, XY> => {
    const placed = new Map<string, XY>();
    units.forEach((unit, index) => placed.set(unit.getId(), { ...cells[index] }));
    return placed;
};

const contextFor = (
    units: readonly Unit[],
    opponentNames: readonly string[],
    team: typeof LEFT = LEFT,
): IPlacementContext => {
    const combat = createCombatTestContext();
    for (const unit of units) combat.unitsHolder.addUnit(unit);
    return {
        team,
        grid: combat.grid,
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        placement: new RectanglePlacement(
            testGridSettings,
            team === LEFT ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
            3,
            true,
        ),
        sideOrientedPlacement: true,
        setupPlacementPolicy: "public-roster",
        publicOpponentCreatureIds: opponentNames.map(creature),
    };
};

const cell = (placed: ReadonlyMap<string, XY>, unit: Unit): XY => {
    const anchor = placed.get(unit.getId());
    if (!anchor) throw new Error(`missing ${unit.getName()}`);
    return anchor;
};

describe("r1c1 threat files", () => {
    test("gap follows the public roster, and plain ground or chakram alone does not separate", () => {
        expect(separationGapForThreats(publicPlacementThreats([creature("Griffin")]))).toBe(5);
        expect(separationGapForThreats(publicPlacementThreats([creature("Zena"), creature("Wandering Mage")]))).toBe(4);
        expect(separationGapForThreats(publicPlacementThreats([creature("Magic Dragon")]))).toBe(3);
        expect(separationGapForThreats(publicPlacementThreats([creature("Wandering Mage")]))).toBe(2);
        expect(separationGapForThreats(publicPlacementThreats([creature("Thunderbird")]))).toBe(2);
        expect(separationGapForThreats(publicPlacementThreats([creature("Zena")]))).toBe(0);
        expect(separationGapForThreats(publicPlacementThreats(undefined))).toBe(0);
    });

    test("Area Throw, zero bows, plain ground, and Through Shot leave the map alone", () => {
        const left = makeUnit("Left", RANGE, 6);
        const right = makeUnit("Right", RANGE, 8);
        const screen = makeUnit("Screen", MELEE);
        const placed = at(
            [left, right, screen],
            [
                { x: 1, y: 1 },
                { x: 1, y: 14 },
                { x: 3, y: 8 },
            ],
        );
        const splash = placeArmyR1C1(placed, [left, right, screen], contextFor([left, right, screen], ["Gargantuan"]));
        expect(splash).toEqual(placed);
        const breathUnits = [screen];
        const breathPlaced = at(breathUnits, [{ x: 2, y: 4 }]);
        expect(placeArmyR1C1(breathPlaced, breathUnits, contextFor(breathUnits, ["Black Dragon"]))).toEqual(
            breathPlaced,
        );
        const plain = placeArmyR1C1(placed, [left, right, screen], contextFor([left, right, screen], ["Peasant"]));
        expect(plain).toEqual(placed);
        const through = placeArmyR1C1(
            placed,
            [left, right, screen],
            contextFor([left, right, screen], ["Tsar Cannon", "Elf"]),
        );
        expect(through).toEqual(placed);
    });

    test("Fire Breath keeps the corner bows and steps a screen off their file", () => {
        const left = makeUnit("Left", RANGE, 6);
        const right = makeUnit("Right", RANGE, 8);
        const extra = makeUnit("Extra", RANGE, 5);
        const screen = makeUnit("Screen", MELEE);
        const units = [left, right, extra, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 2, y: 1 },
            { x: 2, y: 14 },
        ]);
        const next = placeArmyR1C1(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 13 });
        expect(cell(next, extra).y).not.toBe(1);
        expect(cell(next, extra)).toEqual({ x: 1, y: 7 });
    });

    test("three bows against chakram plus a blast move only the extra", () => {
        const left = makeUnit("Left", RANGE, 4);
        const right = makeUnit("Right", RANGE, 9);
        const extra = makeUnit("Extra", RANGE, 5);
        const screen = makeUnit("Screen", MELEE);
        const units = [left, right, extra, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 4 },
            { x: 3, y: 6 },
        ]);
        const spread = placeArmyR1C1(placed, units, contextFor(units, ["Zena", "Wandering Mage"]));
        expect(cell(spread, left)).toEqual({ x: 1, y: 1 });
        expect(cell(spread, right)).toEqual({ x: 1, y: 14 });
        expect(cell(spread, extra)).toEqual({ x: 1, y: 7 });
        expect(cell(spread, screen)).toEqual({ x: 3, y: 6 });
    });

    test("a blast screens the shorter bow on the ray at distance 2", () => {
        const left = makeUnit("Left", RANGE, 4);
        const right = makeUnit("Right", RANGE, 9);
        const screen = makeUnit("Screen", MELEE);
        const units = [left, right, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        const ray = placeArmyR1C1(placed, units, contextFor(units, ["Wandering Mage", "Elf", "Arbalester"]));
        expect(cell(ray, left)).toEqual({ x: 1, y: 1 });
        expect(cell(ray, right)).toEqual({ x: 1, y: 14 });
        expect(cell(ray, screen)).toEqual({ x: 3, y: 1 });
    });

    test("one melee screens the shorter corner bow, and a single bow is screened without a second corner", () => {
        const left = makeUnit("Left", RANGE, 4);
        const right = makeUnit("Right", RANGE, 9);
        const screen = makeUnit("Screen", MELEE);
        const units = [left, right, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR1C1(placed, units, contextFor(units, ["Elf", "Arbalester"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, screen)).toEqual({ x: 2, y: 1 });

        const only = makeUnit("Only", RANGE, 5);
        const guard = makeUnit("Guard", MELEE);
        const singleUnits = [only, guard];
        const single = at(singleUnits, [
            { x: 2, y: 5 },
            { x: 3, y: 8 },
        ]);
        const screened = placeArmyR1C1(single, singleUnits, contextFor(singleUnits, ["Elf", "Monk"]));
        expect(cell(screened, only)).toEqual({ x: 2, y: 5 });
        expect(cell(screened, guard)).toEqual({ x: 3, y: 5 });
    });

    test("a short extra joins the aura carrier and the corner bows stay", () => {
        const left = makeUnit("Left", RANGE, 16, WALK, ["Sniper"]);
        const right = makeUnit("Right", RANGE, 16, WALK, ["Sniper"]);
        const extra = makeUnit("Extra", RANGE, 4);
        const carrier = makeUnit("Carrier", MELEE, 0, FLY, ["Guiding Winds Aura"]);
        const units = [left, right, extra, carrier];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 7 },
            { x: 1, y: 8 },
        ]);
        const next = placeArmyR1C1(placed, units, contextFor(units, ["Elf", "Arbalester"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, carrier)).toEqual({ x: 1, y: 8 });
        expect(cell(next, extra)).toEqual({ x: 2, y: 7 });
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const bow = makeUnit("Only", RANGE, 5);
        const units = [bow];
        const incumbent = at(units, [{ x: 1, y: 4 }]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: bow.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r1c1");
        const context = contextFor(units, ["Peasant"]);
        expect(strategy.version).toBe("v0.8");
        expect(strategy.placeArmy(units, context)).toEqual(incumbent);
        expect(placements).toBe(1);
        expect(strategy.decideTurn(bow, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: bow.getId() },
        ]);
        expect(() => new PlacementLiftStrategy(base, "nope" as "r1c1")).toThrow(/Unknown placement lift candidate/);
    });
});

const melee = (name: string, armor = 10, abilities: string[] = []): Unit =>
    createTestUnit({
        name,
        team: LEFT,
        attackType: MELEE,
        armor,
        abilities,
    });

describe("r1c2 screens, chargers, and flyers", () => {
    test("Area Throw and Large Caliber leave the map alone", () => {
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const guard = melee("Guard", 30);
        const units = [charger, guard];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR1C2(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
        expect(placeArmyR1C2(placed, units, contextFor(units, ["Cyclops"]))).toEqual(placed);
    });

    test("a lone charger against a shooter takes the near extreme front file", () => {
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const guard = melee("Guard", 30);
        const units = [charger, guard];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 6 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Elf"]));
        expect(cell(next, charger)).toEqual({ x: 3, y: 14 });
        expect(cell(next, guard)).toEqual({ x: 3, y: 6 });
        expect(cell(next, guard).y).not.toBe(14);
        expect(Math.abs(cell(next, charger).y - cell(next, guard).y)).toBeGreaterThanOrEqual(2);
    });

    test("two bows stay put while the ground wall slides to the low edge", () => {
        const left = makeUnit("Left", RANGE, 6);
        const right = makeUnit("Right", RANGE, 8);
        const low = melee("Low", 10);
        const high = melee("High", 12);
        const units = [left, right, low, high];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 6 },
            { x: 3, y: 10 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, low)).toEqual({ x: 3, y: 1 });
        expect(cell(next, high)).toEqual({ x: 3, y: 2 });
    });

    test("a line attack centres one adjacent front pair and keeps an edge-ray screen", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const screen = melee("Screen", 40);
        const left = melee("Left", 20);
        const right = melee("Right", 10);
        const units = [bow, screen, left, right];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 1 },
            { x: 3, y: 6 },
            { x: 3, y: 9 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 1 });
        expect(cell(next, left)).toEqual({ x: 3, y: 7 });
        expect(cell(next, right)).toEqual({ x: 3, y: 8 });
    });

    test("fire breath does not pull a ground body back onto a bow file", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const left = melee("Left", 20);
        const right = melee("Right", 10);
        const units = [bow, left, right];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 6 },
            { x: 3, y: 9 },
        ]);
        expect(placeArmyR1C2(placed, units, contextFor(units, ["Black Dragon"]))).toEqual(placed);
    });

    test("a protector stays on the ward it already touches", () => {
        const queen = melee("Abomination", 45);
        const ward = melee("Ward", 8);
        const left = melee("Left", 20);
        const right = melee("Right", 12);
        const units = [queen, ward, left, right];
        const placed = at(units, [
            { x: 3, y: 5 },
            { x: 3, y: 6 },
            { x: 2, y: 2 },
            { x: 2, y: 12 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(next, queen)).toEqual({ x: 3, y: 5 });
        expect(cell(next, ward)).toEqual({ x: 3, y: 6 });
    });

    test("flyers against a shooter leave the front and split the deep corners", () => {
        const high = makeUnit("High", MELEE, 0, FLY);
        const low = makeUnit("Low", MELEE, 0, FLY);
        const units = [high, low];
        const placed = at(units, [
            { x: 3, y: 10 },
            { x: 3, y: 4 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Elf"]));
        expect(cell(next, high)).toEqual({ x: 1, y: 14 });
        expect(cell(next, low)).toEqual({ x: 1, y: 1 });
    });

    test("a charger against flyers takes the low front file beside a ground neighbor", () => {
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const neighbor = melee("Neighbor", 20);
        const units = [charger, neighbor];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 2 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Harpy"]));
        expect(cell(next, charger)).toEqual({ x: 3, y: 1 });
        expect(cell(next, neighbor)).toEqual({ x: 3, y: 2 });
    });

    test("shooters plus a line keep the slower pair in front and the next pair off that file", () => {
        const slowest = melee("Slowest", 40);
        const slow = melee("Slow", 30);
        const next = melee("Next", 20);
        const last = melee("Last", 10);
        const units = [slowest, slow, next, last];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 2, y: 6 },
            { x: 2, y: 10 },
            { x: 2, y: 12 },
        ]);
        const moved = placeArmyR1C2(placed, units, contextFor(units, ["Elf", "Pikeman"]));
        expect(cell(moved, slowest)).toEqual({ x: 3, y: 5 });
        expect(cell(moved, slow)).toEqual({ x: 3, y: 6 });
        expect(cell(moved, next).x).toBe(2);
        expect(cell(moved, last).x).toBe(2);
        expect([cell(moved, next).y, cell(moved, last).y].sort((a, b) => a - b)).toEqual([9, 10]);
        for (const front of [5, 6]) {
            expect(cell(moved, next).y).not.toBe(front);
            expect(cell(moved, last).y).not.toBe(front);
        }
    });

    test("flyers against flyers stay on the front, split, and finish next to a ground body", () => {
        const high = makeUnit("High", MELEE, 0, FLY);
        const low = makeUnit("Low", MELEE, 0, FLY);
        const guard = melee("Guard", 30);
        const units = [high, low, guard];
        const placed = at(units, [
            { x: 3, y: 12 },
            { x: 3, y: 3 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR1C2(placed, units, contextFor(units, ["Harpy"]));
        const highCell = cell(next, high);
        const lowCell = cell(next, low);
        const guardCell = cell(next, guard);
        expect(highCell.x).toBe(3);
        expect(lowCell.x).toBe(3);
        expect(lowCell.y).toBeLessThanOrEqual(7);
        expect(highCell.y).toBeGreaterThanOrEqual(8);
        expect(Math.abs(highCell.y - lowCell.y)).toBeGreaterThanOrEqual(2);
        expect(Math.max(Math.abs(highCell.x - guardCell.x), Math.abs(highCell.y - guardCell.y))).toBeLessThanOrEqual(1);
        expect(Math.max(Math.abs(lowCell.x - guardCell.x), Math.abs(lowCell.y - guardCell.y))).toBeLessThanOrEqual(1);
    });
});

const caster = (name: string, movementType: number = WALK): Unit =>
    createTestUnit({
        name,
        team: LEFT,
        attackType: MELEE,
        movementType,
        spells: ["Chaos:Fire Strike"],
    });

describe("r1c3 casters leave the threatened cell", () => {
    test("plain ground, one shooter, and Lightning Spin leave the map alone", () => {
        const mage = caster("Battle Mage");
        const wall = melee("Wall");
        const units = [mage, wall];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR1C3(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
        expect(placeArmyR1C3(placed, units, contextFor(units, ["Elf"]))).toEqual(placed);
        expect(placeArmyR1C3(placed, units, contextFor(units, ["Hydra"]))).toEqual(placed);
    });

    test("Area Throw seats casters on opposite back edges and returns the generic guard", () => {
        const low = caster("Battle Mage");
        const high = caster("Ogre Mage");
        const monk = caster("Monk");
        const bow = makeUnit("Bow", RANGE, 6);
        const wallLeft = melee("Left");
        const wallRight = melee("Right");
        const guard = melee("Guard");
        const units = [low, high, monk, bow, wallLeft, wallRight, guard];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 1, y: 9 },
            { x: 1, y: 4 },
            { x: 2, y: 4 },
            { x: 3, y: 7 },
            { x: 3, y: 8 },
            { x: 2, y: 8 },
        ]);
        const next = placeArmyR1C3(placed, units, contextFor(units, ["Gargantuan", "Pikeman"]));
        expect(cell(next, high)).toEqual({ x: 1, y: 14 });
        expect(cell(next, low)).toEqual({ x: 1, y: 1 });
        expect(cell(next, monk)).toEqual({ x: 1, y: 4 });
        expect(cell(next, bow)).toEqual({ x: 2, y: 4 });
        expect(cell(next, wallLeft)).toEqual({ x: 3, y: 7 });
        expect(cell(next, wallRight)).toEqual({ x: 3, y: 8 });
        expect(cell(next, guard)).toEqual({ x: 3, y: 6 });
        const highCell = cell(next, high);
        const lowCell = cell(next, low);
        expect(Math.max(Math.abs(highCell.x - lowCell.x), Math.abs(highCell.y - lowCell.y))).toBeGreaterThanOrEqual(2);
    });

    test("a named protector stays, and the caster it covers does not leave the aura", () => {
        const mage = caster("Battle Mage");
        const angel = melee("Angel");
        const wall = melee("Wall");
        const units = [mage, angel, wall];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 1, y: 7 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR1C3(placed, units, contextFor(units, ["Cyclops"]));
        expect(cell(next, angel)).toEqual({ x: 1, y: 7 });
        expect(cell(next, wall)).toEqual({ x: 3, y: 8 });
        expect(Math.max(Math.abs(cell(next, mage).x - 1), Math.abs(cell(next, mage).y - 7))).toBeLessThanOrEqual(2);
        expect(cell(next, mage).y).not.toBe(14);
        expect(cell(next, mage).y).not.toBe(1);
    });

    test("Fire Breath and Skewer Strike put a caster on an empty back file and pack the guard", () => {
        const mage = caster("Battle Mage");
        const bow = makeUnit("Bow", RANGE, 6);
        const wallLeft = melee("Left");
        const wallRight = melee("Right");
        const guard = melee("Guard");
        const units = [mage, bow, wallLeft, wallRight, guard];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 1, y: 1 },
            { x: 3, y: 7 },
            { x: 3, y: 8 },
            { x: 2, y: 14 },
        ]);
        for (const enemy of ["Black Dragon", "Pikeman"]) {
            const next = placeArmyR1C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, mage)).toEqual({ x: 1, y: 14 });
            expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
            expect(cell(next, wallLeft)).toEqual({ x: 3, y: 7 });
            expect(cell(next, wallRight)).toEqual({ x: 3, y: 8 });
            expect(cell(next, guard)).toEqual({ x: 3, y: 6 });
        }
    });

    test("Chain Lightning leaves a back-center caster behind an empty middle file", () => {
        const safe = caster("Battle Mage");
        const threatened = caster("Ogre Mage");
        const bow = makeUnit("Bow", RANGE, 6);
        const wall = melee("Wall");
        const units = [safe, threatened, bow, wall];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 3, y: 9 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR1C3(placed, units, contextFor(units, ["Thunderbird"]));
        expect(cell(next, safe)).toEqual({ x: 1, y: 8 });
        expect(cell(next, threatened)).toEqual({ x: 1, y: 13 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(next, wall)).toEqual({ x: 3, y: 8 });
    });

    test("two flyers step a corner caster inward and seat a guard on the vacated corner", () => {
        const mage = caster("Wandering Mage", FLY);
        const bow = makeUnit("Bow", RANGE, 6);
        const guard = melee("Guard");
        const units = [mage, bow, guard];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR1C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 2 });
        expect(cell(next, guard)).toEqual({ x: 1, y: 1 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
    });

    test("a guard already screening a bow is not stolen, and a blocked inward step is skipped", () => {
        const mage = caster("Battle Mage");
        const bow = makeUnit("Bow", RANGE, 6);
        const guard = melee("Guard");
        const units = [mage, bow, guard];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 2, y: 14 },
        ]);
        const next = placeArmyR1C3(placed, units, contextFor(units, ["Harpy", "Wyvern"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 2 });
        expect(cell(next, guard)).toEqual({ x: 2, y: 14 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });

        const blocked = melee("Blocked");
        const parked = [mage, blocked, guard];
        const parkedAt = at(parked, [
            { x: 1, y: 1 },
            { x: 1, y: 2 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR1C3(parkedAt, parked, contextFor(parked, ["Harpy", "Griffin"]))).toEqual(parkedAt);
    });

    test("a shooter wall moves casters off back corners and off the forward wing without taking the screen", () => {
        const mage = caster("Battle Mage");
        const flyer = caster("Wandering Mage", FLY);
        const bow = makeUnit("Bow", RANGE, 6);
        const wall = melee("Wall");
        const guard = melee("Guard");
        const units = [mage, flyer, bow, wall, guard];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 9 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
            { x: 2, y: 14 },
        ]);
        const next = placeArmyR1C3(placed, units, contextFor(units, ["Elf", "Monk"]));
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(next, wall)).toEqual({ x: 3, y: 8 });
        expect(cell(next, guard)).toEqual({ x: 2, y: 14 });
        expect(cell(next, mage)).toEqual({ x: 1, y: 13 });
        expect(cell(next, flyer)).toEqual({ x: 1, y: 12 });
        expect(cell(next, flyer).x).not.toBe(3);
    });

    test("Fire Breath keeps precedence over a two-flyer roster", () => {
        const mage = caster("Battle Mage");
        const wall = melee("Wall");
        const units = [mage, wall];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR1C3(placed, units, contextFor(units, ["Black Dragon", "Harpy", "Griffin"]))).toEqual(placed);
    });
});

describe("r2c1 bows leave the back rank only for the roster that punishes corners", () => {
    test("one bow, Area Throw, and Large Caliber leave the map alone", () => {
        const only = makeUnit("Only", RANGE, 5);
        const guard = melee("Guard");
        const single = [only, guard];
        const singleAt = at(single, [
            { x: 1, y: 1 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR2C1(singleAt, single, contextFor(single, ["Peasant"]))).toEqual(singleAt);
        const pair = [makeUnit("Left", RANGE, 6), makeUnit("Right", RANGE, 8), guard];
        const placed = at(pair, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR2C1(placed, pair, contextFor(pair, ["Gargantuan"]))).toEqual(placed);
        expect(placeArmyR2C1(placed, pair, contextFor(pair, ["Cyclops"]))).toEqual(placed);
    });

    test("Fire Breath shifts the two longest bows inward and baits only the front cell", () => {
        const low = makeUnit("Low", RANGE, 8);
        const high = makeUnit("High", RANGE, 10);
        const extra = makeUnit("Extra", RANGE, 4);
        const baitLow = melee("BaitLow");
        const baitHigh = melee("BaitHigh");
        const clutter = melee("Clutter");
        const units = [low, high, extra, baitLow, baitHigh, clutter];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 7 },
            { x: 3, y: 6 },
            { x: 3, y: 8 },
            { x: 2, y: 2 },
        ]);
        const next = placeArmyR2C1(placed, units, contextFor(units, ["Black Dragon", "Harpy", "Elf"]));
        expect(cell(next, low)).toEqual({ x: 2, y: 2 });
        expect(cell(next, high)).toEqual({ x: 2, y: 13 });
        expect(cell(next, extra)).toEqual({ x: 2, y: 7 });
        const occupied = (x: number, y: number): boolean =>
            [...next.values()].some((anchor) => anchor.x === x && anchor.y === y);
        expect(occupied(3, 1)).toBe(true);
        expect(occupied(3, 14)).toBe(true);
        expect([cell(next, low), cell(next, high), cell(next, extra)]).not.toContainEqual({ x: 3, y: 1 });
        for (const lat of [1, 14]) {
            expect([...next.values()].some((anchor) => anchor.x === 1 && anchor.y === lat)).toBe(false);
            expect([...next.values()].some((anchor) => anchor.x === 2 && anchor.y === lat)).toBe(false);
        }
        for (const lat of [2, 13]) {
            expect([...next.values()].some((anchor) => anchor.x === 1 && anchor.y === lat)).toBe(false);
            expect([...next.values()].some((anchor) => anchor.x === 3 && anchor.y === lat)).toBe(false);
        }
    });

    test("a shooter wall keeps the two longest bows and steps the extra off the corner files", () => {
        const low = makeUnit("Low", RANGE, 9);
        const high = makeUnit("High", RANGE, 8);
        const extra = makeUnit("Extra", RANGE, 5);
        const screen = melee("Screen");
        const units = [low, high, extra, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 4 },
            { x: 3, y: 7 },
        ]);
        const next = placeArmyR2C1(placed, units, contextFor(units, ["Elf", "Monk"]));
        expect(cell(next, low)).toEqual({ x: 1, y: 1 });
        expect(cell(next, high)).toEqual({ x: 1, y: 14 });
        expect(cell(next, extra)).toEqual({ x: 2, y: 7 });
        expect(cell(next, screen)).not.toEqual({ x: 3, y: 7 });
        expect([...next.values()].some((anchor) => anchor.x === 3 && anchor.y === 7)).toBe(false);

        const wideLow = makeUnit("WideLow", RANGE, 9);
        const wideHigh = makeUnit("WideHigh", RANGE, 8);
        const wideExtra = makeUnit("WideExtra", RANGE, 5);
        const wide = [wideLow, wideHigh, wideExtra];
        const wideAt = at(wide, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 4 },
        ]);
        const spread = placeArmyR2C1(wideAt, wide, contextFor(wide, ["Zena", "Elf"]));
        expect(cell(spread, wideLow)).toEqual({ x: 1, y: 1 });
        expect(cell(spread, wideHigh)).toEqual({ x: 1, y: 14 });
        const extraCell = cell(spread, wideExtra);
        expect(extraCell).toEqual({ x: 2, y: 7 });
        for (const corner of [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]) {
            expect(Math.max(Math.abs(extraCell.x - corner.x), Math.abs(extraCell.y - corner.y))).toBeGreaterThanOrEqual(
                4,
            );
        }
    });

    test("exactly two bows move only a short bow, and a sniper overwrite is not the reach", () => {
        const shorter = makeUnit("Shorter", RANGE, 4);
        const longer = makeUnit("Longer", RANGE, 12);
        const units = [shorter, longer];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]);
        const moved = placeArmyR2C1(placed, units, contextFor(units, ["Elf", "Arbalester"]));
        expect(cell(moved, longer)).toEqual({ x: 1, y: 14 });
        expect(cell(moved, shorter)).toEqual({ x: 2, y: 7 });
        expect([...moved.values()].some((anchor) => anchor.x === 3 && anchor.y === 7)).toBe(false);

        const bothLong = [makeUnit("Left", RANGE, 12), makeUnit("Right", RANGE, 12)];
        const corners = at(bothLong, [
            { x: 1, y: 4 },
            { x: 1, y: 10 },
        ]);
        expect(placeArmyR2C1(corners, bothLong, contextFor(bothLong, ["Elf", "Monk"]))).toEqual(corners);

        const left = makeUnit("Arbalester", RANGE, 20, WALK, ["Sniper"]);
        const right = makeUnit("Arbalester", RANGE, 20, WALK, ["Sniper"]);
        const overwritten = [left, right];
        const deep = at(overwritten, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]);
        const front = placeArmyR2C1(deep, overwritten, contextFor(overwritten, ["Peasant"]));
        expect([cell(front, left), cell(front, right)].map((anchor) => anchor.x).sort()).toEqual([3, 3]);
        expect([cell(front, left).y, cell(front, right).y].sort((a, b) => a - b)).toEqual([7, 9]);
        expect([...front.values()].some((anchor) => anchor.x === 2 && (anchor.y === 7 || anchor.y === 9))).toBe(false);
    });

    test("flyers pull every bow to the middle rank and park a body on the back cell", () => {
        const low = makeUnit("Low", RANGE, 10);
        const high = makeUnit("High", RANGE, 8);
        const guardLow = melee("GuardLow");
        const guardHigh = melee("GuardHigh");
        const units = [low, high, guardLow, guardHigh];
        const placed = at(units, [
            { x: 1, y: 14 },
            { x: 1, y: 1 },
            { x: 3, y: 6 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR2C1(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, low)).toEqual({ x: 2, y: 1 });
        expect(cell(next, high)).toEqual({ x: 2, y: 14 });
        expect([cell(next, guardLow), cell(next, guardHigh)].sort((a, b) => a.y - b.y)).toEqual([
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]);
        expect(cell(next, guardLow).x).not.toBe(3);
        expect(cell(next, guardHigh).x).not.toBe(3);
    });

    test("plain ground moves only the short bows to the front and leaves the middle cell empty", () => {
        const shortLow = makeUnit("ShortLow", RANGE, 4);
        const shortHigh = makeUnit("ShortHigh", RANGE, 5);
        const long = makeUnit("Long", RANGE, 12);
        const screen = melee("Screen");
        const units = [shortLow, shortHigh, long, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 8 },
            { x: 2, y: 7 },
        ]);
        const next = placeArmyR2C1(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, long)).toEqual({ x: 1, y: 8 });
        expect([cell(next, shortLow), cell(next, shortHigh)].sort((a, b) => a.y - b.y)).toEqual([
            { x: 3, y: 7 },
            { x: 3, y: 9 },
        ]);
        expect([...next.values()].some((anchor) => anchor.x === 2 && (anchor.y === 7 || anchor.y === 9))).toBe(false);
    });

    test("Lightning Spin leaves a short bow unmoved when the front cell stays within 1 of a friendly", () => {
        const short = makeUnit("Short", RANGE, 4);
        const other = makeUnit("Other", RANGE, 12);
        const neighbor = melee("Neighbor");
        const units = [short, other, neighbor];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR2C1(placed, units, contextFor(units, ["Hydra"]));
        expect(cell(next, other)).toEqual({ x: 1, y: 14 });
        const moved = cell(next, short);
        expect(moved.x).toBe(3);
        for (const anchor of next.values()) {
            if (anchor.x === moved.x && anchor.y === moved.y) continue;
            expect(Math.max(Math.abs(anchor.x - moved.x), Math.abs(anchor.y - moved.y))).toBeGreaterThanOrEqual(2);
        }
        expect([...next.values()].some((anchor) => anchor.x === 2 && anchor.y === moved.y)).toBe(false);
    });
});

const atCells = (placed: ReadonlyMap<string, XY>, units: readonly Unit[]): XY[] =>
    units.map((unit) => cell(placed, unit)).sort((a, b) => a.x - b.x || a.y - b.y);

describe("r2c2 seam wall, empty charger lane, and off-file flyers", () => {
    test("Area Throw, Large Caliber, plain ground, and Lightning Spin leave the map alone", () => {
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const low = melee("Low", 10);
        const mid = melee("Mid", 20);
        const high = melee("High", 30);
        const units = [charger, low, mid, high];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 6 },
            { x: 3, y: 10 },
            { x: 3, y: 12 },
        ]);
        expect(placeArmyR2C2(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
        expect(placeArmyR2C2(placed, units, contextFor(units, ["Cyclops"]))).toEqual(placed);
        expect(placeArmyR2C2(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
        expect(placeArmyR2C2(placed, units, contextFor(units, ["Hydra"]))).toEqual(placed);
    });

    test("Fire Breath or Skewer packs one centred front block and an empty back lane", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const low = melee("Low", 40);
        const mid = melee("Mid", 10);
        const high = melee("High", 12);
        const units = [bow, charger, low, mid, high];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 2, y: 4 },
            { x: 3, y: 4 },
            { x: 3, y: 8 },
            { x: 3, y: 11 },
        ]);
        for (const enemy of [["Black Dragon"], ["Pikeman"]] as const) {
            const next = placeArmyR2C2(placed, units, contextFor(units, enemy));
            expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
            expect(cell(next, charger)).toEqual({ x: 1, y: 6 });
            expect(cell(next, low)).toEqual({ x: 3, y: 7 });
            expect(cell(next, mid)).toEqual({ x: 3, y: 8 });
            expect(cell(next, high)).toEqual({ x: 3, y: 9 });
            const ys = [cell(next, low).y, cell(next, mid).y, cell(next, high).y];
            expect(Math.max(...ys) - Math.min(...ys)).toBe(ys.length - 1);
        }
    });

    test("Through Shot and Chakram do not open the seam and use the centre screen instead", () => {
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const screen = melee("Screen", 40);
        const left = melee("Left", 10);
        const right = melee("Right", 12);
        const units = [charger, screen, left, right];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 6 },
            { x: 3, y: 10 },
            { x: 3, y: 12 },
        ]);
        for (const enemy of [["Zena"], ["Tsar Cannon"]] as const) {
            const next = placeArmyR2C2(placed, units, contextFor(units, enemy));
            expect(cell(next, charger)).toEqual({ x: 1, y: 7 });
            expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
            expect(cell(next, left)).toEqual({ x: 2, y: 8 });
            expect(cell(next, right)).toEqual({ x: 2, y: 9 });
            expect(atCells(next, units).some((anchor) => anchor.x === 1 && anchor.y !== 7)).toBe(false);
        }
    });

    test("enemy flyers put the smallest bodies on the back corners and escort off the front", () => {
        const smallLow = melee("SmallLow", 4);
        const smallHigh = melee("SmallHigh", 50);
        const wideLow = createTestUnit({
            name: "WideLow",
            team: LEFT,
            attackType: MELEE,
            armor: 11,
            footprintWidth: 1,
            footprintHeight: 2,
        });
        const wideHigh = createTestUnit({
            name: "WideHigh",
            team: LEFT,
            attackType: MELEE,
            armor: 12,
            footprintWidth: 1,
            footprintHeight: 2,
        });
        const flyerLow = makeUnit("FlyerLow", MELEE, 0, FLY);
        const flyerHigh = makeUnit("FlyerHigh", MELEE, 0, FLY);
        const units = [smallLow, smallHigh, wideLow, wideHigh, flyerLow, flyerHigh];
        const placed = at(units, [
            { x: 2, y: 2 },
            { x: 2, y: 14 },
            { x: 3, y: 4 },
            { x: 3, y: 13 },
            { x: 3, y: 5 },
            { x: 3, y: 11 },
        ]);
        const next = placeArmyR2C2(placed, units, contextFor(units, ["Harpy"]));
        expect(atCells(next, [smallLow, smallHigh])).toEqual([
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]);
        expect(cell(next, wideLow)).toEqual({ x: 3, y: 7 });
        expect(cell(next, wideHigh)).toEqual({ x: 3, y: 9 });
        expect(atCells(next, [flyerLow, flyerHigh])).toEqual([
            { x: 2, y: 5 },
            { x: 2, y: 10 },
        ]);
    });

    test("two bows suppress the corner and sponge repacks and keep the bow files", () => {
        const left = makeUnit("Left", RANGE, 6);
        const right = makeUnit("Right", RANGE, 8);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const screen = melee("Screen", 40);
        const mid = melee("Mid", 10);
        const high = melee("High", 12);
        const units = [left, right, charger, screen, mid, high];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 2, y: 4 },
            { x: 3, y: 6 },
            { x: 3, y: 8 },
            { x: 3, y: 10 },
        ]);
        const flyers = placeArmyR2C2(placed, units, contextFor(units, ["Harpy"]));
        expect(cell(flyers, left)).toEqual({ x: 1, y: 1 });
        expect(cell(flyers, right)).toEqual({ x: 1, y: 14 });
        expect(cell(flyers, charger)).toEqual({ x: 1, y: 7 });
        expect(cell(flyers, screen)).toEqual({ x: 3, y: 6 });
        expect(cell(flyers, mid)).toEqual({ x: 3, y: 8 });
        expect(cell(flyers, high)).toEqual({ x: 3, y: 10 });

        const shooters = placeArmyR2C2(placed, units, contextFor(units, ["Elf", "Monk"]));
        expect(cell(shooters, left)).toEqual({ x: 1, y: 1 });
        expect(cell(shooters, right)).toEqual({ x: 1, y: 14 });
        expect(cell(shooters, charger)).toEqual({ x: 1, y: 7 });
        expect(cell(shooters, screen)).toEqual({ x: 3, y: 7 });
        expect(cell(shooters, mid)).toEqual({ x: 3, y: 8 });
        expect(cell(shooters, high)).toEqual({ x: 3, y: 10 });
    });

    test("a named protector, its ward, a caster, and a bow stay on a file pierce", () => {
        const queen = melee("Abomination", 45);
        const ward = melee("Ward", 8);
        const caster = melee("Blacksmith", 9);
        const bow = makeUnit("Bow", RANGE, 6);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const left = melee("Left", 10);
        const right = melee("Right", 12);
        const units = [queen, ward, caster, bow, charger, left, right];
        const placed = at(units, [
            { x: 3, y: 5 },
            { x: 3, y: 6 },
            { x: 3, y: 4 },
            { x: 1, y: 1 },
            { x: 2, y: 9 },
            { x: 3, y: 10 },
            { x: 3, y: 12 },
        ]);
        const next = placeArmyR2C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(next, queen)).toEqual({ x: 3, y: 5 });
        expect(cell(next, ward)).toEqual({ x: 3, y: 6 });
        expect(cell(next, caster)).toEqual({ x: 3, y: 4 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, left)).toEqual({ x: 3, y: 7 });
        expect(cell(next, right)).toEqual({ x: 3, y: 8 });
        expect(cell(next, charger)).toEqual({ x: 1, y: 9 });
    });

    test("a file pierce shifts a flyer off a shared ground file and shooters do not use back corners", () => {
        const ground = melee("Ground", 30);
        const shared = makeUnit("Shared", MELEE, 0, FLY);
        const clear = makeUnit("Clear", MELEE, 0, FLY);
        const units = [ground, shared, clear];
        const placed = at(units, [
            { x: 3, y: 5 },
            { x: 2, y: 8 },
            { x: 2, y: 3 },
        ]);
        const shifted = placeArmyR2C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(shifted, ground)).toEqual({ x: 3, y: 8 });
        expect(cell(shifted, shared)).toEqual({ x: 2, y: 9 });
        expect(cell(shifted, clear)).toEqual({ x: 2, y: 3 });

        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const tank = melee("Tank", 40);
        const beside = makeUnit("Beside", MELEE, 0, FLY);
        const shooterUnits = [charger, tank, beside];
        const shooterPlaced = at(shooterUnits, [
            { x: 2, y: 4 },
            { x: 3, y: 6 },
            { x: 3, y: 12 },
        ]);
        const screened = placeArmyR2C2(shooterPlaced, shooterUnits, contextFor(shooterUnits, ["Elf"]));
        expect(cell(screened, charger)).toEqual({ x: 1, y: 7 });
        expect(cell(screened, tank)).toEqual({ x: 3, y: 7 });
        expect(cell(screened, beside)).toEqual({ x: 2, y: 6 });
        expect(cell(screened, beside)).not.toEqual({ x: 1, y: 1 });
        expect(cell(screened, beside)).not.toEqual({ x: 1, y: 14 });
    });

    test("a file pierce with shooters leaves a flyer when every beside cell is on a front file", () => {
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const tank = melee("Tank", 40);
        const other = melee("Other", 10);
        const flyer = makeUnit("Flyer", MELEE, 0, FLY);
        const units = [charger, tank, other, flyer];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 4 },
            { x: 3, y: 11 },
            { x: 3, y: 13 },
        ]);
        const next = placeArmyR2C2(placed, units, contextFor(units, ["Elf", "Pikeman"]));
        expect(cell(next, charger)).toEqual({ x: 1, y: 6 });
        expect(cell(next, tank)).toEqual({ x: 3, y: 7 });
        expect(cell(next, other)).toEqual({ x: 3, y: 8 });
        expect(cell(next, flyer)).toEqual({ x: 3, y: 13 });
    });
});

describe("r2c3 ward and screen stand where that public threat misses", () => {
    const bow = (name: string): Unit => makeUnit(name, RANGE, 8);
    const pike = (): Unit => makeUnit("Pikeman", MELEE);
    const troll = (): Unit => makeUnit("Troll", PBTypes.AttackVals.MELEE_MAGIC);
    const monk = (): Unit => makeUnit("Monk", RANGE, 6);
    const corners = (left: Unit, right: Unit, others: readonly Unit[], cells: readonly XY[]): Map<string, XY> =>
        at([left, right, ...others], [{ x: 1, y: 1 }, { x: 1, y: 14 }, ...cells]);

    test("plain ground, skewer, and lightning spin leave the map unchanged", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const units = [left, right, ward, screen];
        const placed = corners(
            left,
            right,
            [ward, screen],
            [
                { x: 1, y: 6 },
                { x: 3, y: 8 },
            ],
        );
        for (const enemy of [["Peasant"], ["Pikeman"], ["Hydra"]]) {
            expect(placeArmyR2C3(placed, units, contextFor(units, enemy))).toEqual(placed);
        }
    });

    test("no ward is a no-op even against Area Throw", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const screen = pike();
        const units = [left, right, screen];
        const placed = corners(left, right, [screen], [{ x: 3, y: 8 }]);
        expect(placeArmyR2C3(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
    });

    test("Area Throw spreads the uncovered support bow and both screens by three", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const near = pike();
        const far = troll();
        const units = [left, right, ward, near, far];
        const placed = corners(
            left,
            right,
            [ward, near, far],
            [
                { x: 1, y: 5 },
                { x: 3, y: 6 },
                { x: 3, y: 9 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(next, near)).toEqual({ x: 3, y: 10 });
        expect(cell(next, far)).toEqual({ x: 3, y: 4 });
        expect(placeArmyR2C3(placed, units, contextFor(units, ["Cyclops"]))).toEqual(next);
    });

    test("a support bow the corner reseat would claim is not the ward", () => {
        const dryad = bow("Dryad");
        const ward = monk();
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const screen = pike();
        const units = [dryad, ward, left, right, screen];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 1, y: 6 },
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR2C3(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
    });

    test("Dryad is the support ward before Monk", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const dryad = bow("Dryad");
        const other = monk();
        const screen = pike();
        const units = [left, right, dryad, other, screen];
        const placed = corners(
            left,
            right,
            [dryad, other, screen],
            [
                { x: 1, y: 8 },
                { x: 1, y: 6 },
                { x: 3, y: 6 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, dryad)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 10 });
        expect(cell(next, other)).not.toEqual({ x: 1, y: 7 });
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
    });

    test("a spellbook caster is the ward ahead of a support bow", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const caster = makeUnit("Battle Mage", MELEE);
        const dryad = bow("Dryad");
        const screen = pike();
        const units = [left, right, caster, dryad, screen];
        const placed = corners(
            left,
            right,
            [caster, dryad, screen],
            [
                { x: 1, y: 8 },
                { x: 1, y: 6 },
                { x: 3, y: 6 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, caster)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 10 });
        expect(cell(next, dryad)).not.toEqual({ x: 1, y: 7 });
    });

    test("a ward inside a protector aura stays with its screen", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const protector = createTestUnit({
            name: "Abomination",
            team: LEFT,
            attackType: MELEE,
            movementType: WALK,
            size: PBTypes.UnitSizeVals.LARGE,
        });
        const units = [left, right, ward, screen, protector];
        const placed = corners(
            left,
            right,
            [ward, screen, protector],
            [
                { x: 1, y: 6 },
                { x: 2, y: 6 },
                { x: 2, y: 8 },
            ],
        );
        expect(placeArmyR2C3(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
    });

    test("Fire Breath puts the screen on the front of an empty file and keeps the middle empty", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const other = troll();
        const units = [left, right, ward, screen, other];
        const placed = corners(
            left,
            right,
            [ward, screen, other],
            [
                { x: 1, y: 5 },
                { x: 3, y: 6 },
                { x: 2, y: 7 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
        expect(cell(next, other).y).not.toBe(7);
        expect(cell(next, other)).not.toEqual({ x: 3, y: 8 });
        expect([...next.values()].some((spot) => spot.x === 2 && spot.y === 7)).toBe(false);
    });

    test("Through Shot stands the ward alone on the centre back lateral", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const other = troll();
        const units = [left, right, ward, screen, other];
        const placed = corners(
            left,
            right,
            [ward, screen, other],
            [
                { x: 1, y: 5 },
                { x: 2, y: 7 },
                { x: 3, y: 9 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Tsar Cannon"]));
        expect(cell(next, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen).y).not.toBe(7);
        expect(cell(next, other).y).not.toBe(7);
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        const onFile = [ward, screen, other, left, right].filter((unit) => cell(next, unit).y === 7);
        expect(onFile).toEqual([ward]);
    });

    test("flyers park one screen one step forward and push everyone else outside the 3x3", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const other = troll();
        const units = [left, right, ward, screen, other];
        const placed = corners(
            left,
            right,
            [ward, screen, other],
            [
                { x: 1, y: 5 },
                { x: 3, y: 6 },
                { x: 3, y: 9 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 2, y: 7 });
        expect(Math.max(Math.abs(cell(next, other).x - 1), Math.abs(cell(next, other).y - 7))).toBeGreaterThanOrEqual(
            3,
        );
        expect(cell(next, other)).not.toEqual({ x: 1, y: 1 });
        expect(cell(next, other)).not.toEqual({ x: 1, y: 14 });
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
    });

    test("a plain shooter screen touches the ward, and the corner screen stays", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const cornerScreen = troll();
        const units = [left, right, ward, screen, cornerScreen];
        const placed = corners(
            left,
            right,
            [ward, screen, cornerScreen],
            [
                { x: 1, y: 5 },
                { x: 3, y: 8 },
                { x: 2, y: 1 },
            ],
        );
        const next = placeArmyR2C3(placed, units, contextFor(units, ["Elf", "Zena"]));
        expect(cell(next, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 2, y: 7 });
        expect(cell(next, cornerScreen)).toEqual({ x: 2, y: 1 });
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
    });

    test("Fireball keeps the screen off the ward file at distance 2, Meteor Shower at 3", () => {
        const left = bow("Arbalester");
        const right = bow("Medusa");
        const ward = monk();
        const screen = pike();
        const cornerScreen = troll();
        const units = [left, right, ward, screen, cornerScreen];
        const placed = corners(
            left,
            right,
            [ward, screen, cornerScreen],
            [
                { x: 1, y: 5 },
                { x: 3, y: 8 },
                { x: 2, y: 1 },
            ],
        );
        const blast = placeArmyR2C3(placed, units, contextFor(units, ["Wandering Mage", "Elf", "Monk"]));
        expect(cell(blast, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(blast, screen)).toEqual({ x: 2, y: 9 });
        expect(cell(blast, cornerScreen)).toEqual({ x: 2, y: 1 });
        const meteor = placeArmyR2C3(placed, units, contextFor(units, ["Magic Dragon", "Elf", "Zena"]));
        expect(cell(meteor, ward)).toEqual({ x: 1, y: 7 });
        expect(cell(meteor, screen)).toEqual({ x: 2, y: 10 });
        expect(cell(meteor, cornerScreen)).toEqual({ x: 2, y: 1 });
    });
});

describe("r3c1 one-cell bow keeps the corner", () => {
    const large = (name: string, abilities: string[] = []): Unit =>
        createTestUnit({
            name,
            team: LEFT,
            attackType: RANGE,
            rangeShots: 4,
            shotDistance: 6.5,
            size: PBTypes.UnitSizeVals.LARGE,
            abilities,
        });
    const bow = (name: string, abilities: string[] = []): Unit =>
        createTestUnit({
            name,
            team: LEFT,
            attackType: RANGE,
            rangeShots: 8,
            shotDistance: 6,
            abilities,
        });

    test("a shorter one-cell bow does not take the wide stack's corner", () => {
        const wide = large("Tsar Cannon");
        const orc = bow("Orc");
        const units = [wide, orc];
        const placed = at(units, [
            { x: 2, y: 14 },
            { x: 1, y: 4 },
        ]);
        expect(placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
    });

    test("the longer one-cell bow takes the corner and the wide stack takes the window center", () => {
        const wide = large("Tsar Cannon");
        const elf = bow("Elf");
        const units = [wide, elf];
        const placed = at(units, [
            { x: 2, y: 14 },
            { x: 1, y: 4 },
        ]);
        const next = placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, wide)).toEqual({ x: 2, y: 8 });
        expect(cell(next, elf)).toEqual({ x: 1, y: 14 });
    });

    test("a Sniper-ability bow outranks a longer floored distance", () => {
        const wide = large("Tsar Cannon");
        const sniper = bow("Arbalester", ["Sniper"]);
        const units = [wide, sniper];
        const placed = at(units, [
            { x: 2, y: 14 },
            { x: 1, y: 4 },
        ]);
        const next = placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, wide)).toEqual({ x: 2, y: 8 });
        expect(cell(next, sniper)).toEqual({ x: 1, y: 14 });
    });

    test("two or more flyers keep the wide stack on the corner when the beside cell would empty", () => {
        const wide = large("Tsar Cannon");
        const elf = bow("Elf");
        const units = [wide, elf];
        const placed = at(units, [
            { x: 2, y: 14 },
            { x: 1, y: 4 },
        ]);
        expect(placeArmyR3C1(placed, units, contextFor(units, ["Harpy", "Griffin"]))).toEqual(placed);
    });

    test("a Guiding Winds carrier leaves its corner two cells from the heavier bow", () => {
        const dryad = bow("Dryad", ["Guiding Winds Aura"]);
        const monk = bow("Monk");
        const units = [dryad, monk];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 8 },
        ]);
        const next = placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, monk)).toEqual({ x: 1, y: 1 });
        expect(cell(next, dryad)).toEqual({ x: 1, y: 3 });
    });

    test("Chakram keeps the aura carrier touching the heavy bow", () => {
        const dryad = bow("Dryad", ["Guiding Winds Aura"]);
        const monk = bow("Monk");
        const units = [dryad, monk];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 8 },
        ]);
        const next = placeArmyR3C1(placed, units, contextFor(units, ["Zena"]));
        expect(cell(next, monk)).toEqual({ x: 1, y: 1 });
        expect(cell(next, dryad)).toEqual({ x: 1, y: 2 });
    });

    test("a band-9 extra steps to the front center, and pure ground or flyers do not", () => {
        const left = bow("Elf");
        const right = bow("Monk");
        const orc = bow("Orc");
        const units = [left, right, orc];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 6 },
        ]);
        const forward = placeArmyR3C1(placed, units, contextFor(units, ["Wandering Mage"]));
        expect(cell(forward, left)).toEqual({ x: 1, y: 1 });
        expect(cell(forward, right)).toEqual({ x: 1, y: 14 });
        expect(cell(forward, orc)).toEqual({ x: 3, y: 7 });
        expect(placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
        expect(placeArmyR3C1(placed, units, contextFor(units, ["Harpy", "Griffin"]))).toEqual(placed);
    });

    test("one ranged stack is a no-op", () => {
        const only = bow("Elf");
        const units = [only];
        const placed = at(units, [{ x: 1, y: 1 }]);
        expect(placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
    });

    test("an incomplete extra slides to the nearest complete back cell and stays off the corner file", () => {
        const left = bow("Elf");
        const right = bow("Elf");
        const monk = bow("Monk");
        const units = [left, right, monk];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 2 },
        ]);
        const next = placeArmyR3C1(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, monk)).toEqual({ x: 1, y: 3 });
    });

    test("Area Throw leaves the wide stack put when the window center is within one cell", () => {
        const wide = large("Tsar Cannon");
        const elf = bow("Elf");
        const screen = createTestUnit({ name: "Pikeman", team: LEFT, attackType: MELEE });
        const units = [wide, elf, screen];
        const placed = at(units, [
            { x: 2, y: 14 },
            { x: 1, y: 4 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR3C1(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
    });
});

describe("r3c2 one step off the breath, or a front pack beside the charger", () => {
    const flyer = (name: string): Unit => makeUnit(name, MELEE, 0, FLY);

    test("Area Throw and Large Caliber leave a pierced file unchanged", () => {
        const front = melee("Front", 12);
        const rear = melee("Rear", 18);
        const units = [front, rear];
        const placed = at(units, [
            { x: 3, y: 5 },
            { x: 2, y: 5 },
        ]);
        expect(placeArmyR3C2(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
        expect(placeArmyR3C2(placed, units, contextFor(units, ["Cyclops"]))).toEqual(placed);
    });

    test("Fire Breath steps only the shadowed body toward the nearer empty file", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const locked = melee("Locked", 15);
        const front = melee("Front", 12);
        const rear = melee("Rear", 18);
        const book = melee("Blacksmith", 9);
        const ahead = melee("Ahead", 11);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const alone = flyer("Alone");
        const units = [bow, locked, front, rear, book, ahead, charger, alone];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
            { x: 3, y: 5 },
            { x: 2, y: 5 },
            { x: 2, y: 8 },
            { x: 3, y: 8 },
            { x: 3, y: 12 },
            { x: 2, y: 3 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, locked)).toEqual({ x: 2, y: 1 });
        expect(cell(next, front)).toEqual({ x: 3, y: 5 });
        expect(cell(next, rear)).toEqual({ x: 2, y: 4 });
        expect(cell(next, book)).toEqual({ x: 2, y: 8 });
        expect(cell(next, ahead)).toEqual({ x: 3, y: 8 });
        expect(cell(next, charger)).toEqual({ x: 3, y: 12 });
        expect(cell(next, alone)).toEqual({ x: 2, y: 3 });
        const skewer = placeArmyR3C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(skewer, rear)).toEqual({ x: 2, y: 4 });
    });

    test("a front charger is not the breath mover, and a flyer refuses one file off centre", () => {
        const ally = melee("Ally", 20);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const units = [ally, charger];
        const placed = at(units, [
            { x: 3, y: 4 },
            { x: 2, y: 4 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, ally)).toEqual({ x: 3, y: 4 });
        expect(cell(next, charger)).toEqual({ x: 2, y: 3 });

        const cover = melee("Cover", 20);
        const winged = flyer("Winged");
        const pair = [cover, winged];
        const parked = at(pair, [
            { x: 3, y: 7 },
            { x: 2, y: 7 },
        ]);
        expect(placeArmyR3C2(parked, pair, contextFor(pair, ["Black Dragon"]))).toEqual(parked);
    });

    test("the same step uses the right-hand zone without leaving it", () => {
        const front = melee("Front", 12);
        const rear = melee("Rear", 18);
        const units = [front, rear];
        const placed = at(units, [
            { x: 12, y: 5 },
            { x: 13, y: 5 },
        ]);
        const context = contextFor(units, ["Black Dragon"]);
        const right = {
            ...context,
            team: PBTypes.TeamVals.RIGHT,
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.RIGHT_BOTTOM, 3, true),
        };
        const next = placeArmyR3C2(placed, units, right);
        expect(cell(next, front)).toEqual({ x: 12, y: 5 });
        expect(cell(next, rear)).toEqual({ x: 13, y: 4 });
    });

    test("Lightning Spin opens one file at the outer end and does not build the centre wall", () => {
        const low = melee("Low", 10);
        const mid = melee("Mid", 20);
        const inner = melee("Inner", 30);
        const high = melee("High", 12);
        const outer = melee("Outer", 40);
        const deep = melee("Deep", 8);
        const units = [low, mid, inner, high, outer, deep];
        const placed = at(units, [
            { x: 3, y: 4 },
            { x: 3, y: 5 },
            { x: 3, y: 6 },
            { x: 3, y: 10 },
            { x: 3, y: 11 },
            { x: 2, y: 8 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Hydra"]));
        expect(cell(next, low)).toEqual({ x: 3, y: 3 });
        expect(cell(next, mid)).toEqual({ x: 3, y: 5 });
        expect(cell(next, inner)).toEqual({ x: 3, y: 6 });
        expect(cell(next, high)).toEqual({ x: 3, y: 10 });
        expect(cell(next, outer)).toEqual({ x: 3, y: 12 });
        expect(cell(next, deep)).toEqual({ x: 2, y: 8 });
        const withBows = placeArmyR3C2(placed, units, contextFor(units, ["Hydra", "Elf"]));
        expect(cell(withBows, low)).toEqual({ x: 3, y: 3 });
        expect(cell(withBows, outer)).toEqual({ x: 3, y: 12 });
        expect(atCells(withBows, [low, mid, inner, high, outer]).some((anchor) => anchor.y >= 7 && anchor.y <= 9)).toBe(
            false,
        );
    });

    test("a touching pair steps one file outward, and Through Shot is not that branch", () => {
        const left = melee("Left", 10);
        const right = melee("Right", 20);
        const units = [left, right];
        const placed = at(units, [
            { x: 3, y: 8 },
            { x: 3, y: 9 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Hydra"]));
        expect(cell(next, left)).toEqual({ x: 3, y: 8 });
        expect(cell(next, right)).toEqual({ x: 3, y: 10 });
        expect(placeArmyR3C2(placed, units, contextFor(units, ["Tsar Cannon"]))).toEqual(placed);
    });

    test("ranged enemies pack screens on the centre files and keep the charger beside them", () => {
        const back = melee("Back", 50);
        const high = melee("High", 40);
        const mid = melee("Mid", 20);
        const low = melee("Low", 10);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const bow = makeUnit("Bow", RANGE, 6);
        const units = [back, high, mid, low, charger, bow];
        const placed = at(units, [
            { x: 1, y: 4 },
            { x: 3, y: 2 },
            { x: 3, y: 4 },
            { x: 2, y: 12 },
            { x: 2, y: 6 },
            { x: 1, y: 14 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Elf"]));
        expect(cell(next, back)).toEqual({ x: 1, y: 4 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(next, high)).toEqual({ x: 3, y: 7 });
        expect(cell(next, mid)).toEqual({ x: 3, y: 8 });
        expect(cell(next, low)).toEqual({ x: 3, y: 9 });
        expect(cell(next, charger)).toEqual({ x: 3, y: 6 });
        expect(atCells(next, units).some((anchor) => anchor.x === 2 && anchor.y === 6)).toBe(false);
        expect(atCells(next, units).some((anchor) => anchor.x === 1 && anchor.y === 6)).toBe(false);
    });

    test("two enemy flyers put our flyers behind the block and the next screens behind them", () => {
        const heavy = melee("Heavy", 40);
        const nextArmor = melee("Next", 30);
        const rear = melee("Rear", 20);
        const last = melee("Last", 10);
        const left = flyer("Left");
        const right = flyer("Right");
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const units = [heavy, nextArmor, rear, last, left, right, charger];
        const placed = at(units, [
            { x: 3, y: 2 },
            { x: 3, y: 3 },
            { x: 3, y: 4 },
            { x: 2, y: 4 },
            { x: 3, y: 12 },
            { x: 3, y: 13 },
            { x: 2, y: 10 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Elf", "Harpy", "Griffin"]));
        expect(cell(next, heavy)).toEqual({ x: 3, y: 7 });
        expect(cell(next, nextArmor)).toEqual({ x: 3, y: 8 });
        expect(atCells(next, [left, right])).toEqual([
            { x: 2, y: 7 },
            { x: 2, y: 8 },
        ]);
        expect(cell(next, rear)).toEqual({ x: 1, y: 7 });
        expect(cell(next, last)).toEqual({ x: 1, y: 8 });
        expect(cell(next, charger)).toEqual({ x: 3, y: 6 });
        expect(cell(next, left).y).not.toBe(1);
        expect(cell(next, right).y).not.toBe(14);
    });

    test("two enemy flyers and no bows pack our flyers against a front hinge and fill three back cells", () => {
        const heavy = melee("Heavy", 40);
        const mid = melee("Mid", 30);
        const hinge = melee("Hinge", 10);
        const left = flyer("Left");
        const right = flyer("Right");
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const units = [heavy, mid, hinge, left, right, charger];
        const placed = at(units, [
            { x: 2, y: 11 },
            { x: 1, y: 13 },
            { x: 3, y: 5 },
            { x: 3, y: 12 },
            { x: 3, y: 13 },
            { x: 2, y: 10 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(atCells(next, [left, right])).toEqual([
            { x: 3, y: 3 },
            { x: 3, y: 4 },
        ]);
        expect(cell(next, charger)).toEqual({ x: 3, y: 5 });
        expect(cell(next, heavy)).toEqual({ x: 1, y: 7 });
        expect(cell(next, mid)).toEqual({ x: 1, y: 1 });
        expect(cell(next, hinge)).toEqual({ x: 1, y: 14 });
        expect(cell(next, left).x).toBe(3);
        expect(cell(next, right).x).toBe(3);
    });

    test("plain ground packs the low front half and an enemy charger leaves it unchanged", () => {
        const winged = flyer("Winged");
        const high = melee("High", 30);
        const low = melee("Low", 10);
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const bow = makeUnit("Bow", RANGE, 6);
        const book = melee("Blacksmith", 9);
        const units = [winged, high, low, charger, bow, book];
        const placed = at(units, [
            { x: 3, y: 14 },
            { x: 3, y: 10 },
            { x: 2, y: 12 },
            { x: 1, y: 8 },
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]);
        const next = placeArmyR3C2(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, winged)).toEqual({ x: 3, y: 1 });
        expect(cell(next, high)).toEqual({ x: 3, y: 2 });
        expect(cell(next, low)).toEqual({ x: 3, y: 3 });
        expect(cell(next, charger)).toEqual({ x: 3, y: 4 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, book)).toEqual({ x: 1, y: 14 });
        expect(
            [cell(next, winged).y, cell(next, high).y, cell(next, low).y, cell(next, charger).y].every((y) => y <= 7),
        ).toBe(true);
        expect(placeArmyR3C2(placed, units, contextFor(units, ["Wolf Rider"]))).toEqual(placed);
    });
});

const magicMelee = (name: string): Unit =>
    createTestUnit({
        name,
        team: LEFT,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
    });

describe("r3c3 caster and screen at the distance that threat misses", () => {
    test("plain ground, Lightning Spin, and Chakram alone leave the map", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Hydra"]))).toEqual(placed);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Zena"]))).toEqual(placed);
    });

    test("Area Throw and Large Caliber seat casters on centre files with one screen and an empty middle", () => {
        const low = caster("Battle Mage");
        const high = caster("Ogre Mage");
        const monk = caster("Monk");
        const bow = makeUnit("Bow", RANGE, 6);
        const screenLow = melee("NearLow");
        const screenHigh = melee("NearHigh");
        const far = melee("Far");
        const units = [low, high, monk, bow, screenLow, screenHigh, far];
        const placed = at(units, [
            { x: 1, y: 3 },
            { x: 1, y: 12 },
            { x: 1, y: 5 },
            { x: 1, y: 1 },
            { x: 3, y: 3 },
            { x: 3, y: 12 },
            { x: 3, y: 9 },
        ]);
        for (const enemy of ["Gargantuan", "Cyclops"]) {
            const next = placeArmyR3C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, low)).toEqual({ x: 1, y: 7 });
            expect(cell(next, screenLow)).toEqual({ x: 3, y: 7 });
            expect(cell(next, high)).toEqual({ x: 1, y: 8 });
            expect(cell(next, screenHigh)).toEqual({ x: 3, y: 8 });
            expect(cell(next, monk)).toEqual({ x: 1, y: 5 });
            expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
            expect(cell(next, far)).toEqual({ x: 3, y: 9 });
            expect([...next.values()].some((entry) => entry.x === 2 && (entry.y === 7 || entry.y === 8))).toBe(false);
            expect(cell(next, low).y).not.toBe(1);
            expect(cell(next, high).y).not.toBe(14);
        }
    });

    test("a blocked middle tries the next centre lateral, and a corner guard is not the screen", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const blocker = melee("Blocker");
        const units = [mage, screen, blocker];
        const placed = at(units, [
            { x: 2, y: 5 },
            { x: 3, y: 4 },
            { x: 2, y: 7 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 8 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 8 });
        expect(cell(next, blocker)).toEqual({ x: 2, y: 7 });

        const bow = makeUnit("Bow", RANGE, 6);
        const guard = melee("Guard");
        const other = melee("Other");
        const cornerUnits = [mage, bow, guard, other];
        const cornerPlaced = at(cornerUnits, [
            { x: 2, y: 12 },
            { x: 1, y: 14 },
            { x: 3, y: 14 },
            { x: 3, y: 4 },
        ]);
        const guarded = placeArmyR3C3(cornerPlaced, cornerUnits, contextFor(cornerUnits, ["Cyclops"]));
        expect(cell(guarded, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(guarded, guard)).toEqual({ x: 3, y: 14 });
        expect(cell(guarded, mage)).toEqual({ x: 1, y: 7 });
        expect(cell(guarded, other)).toEqual({ x: 3, y: 7 });
    });

    test("a charger and a spellbook are not screens, and a non-spellbook melee-magic screen is", () => {
        const mage = caster("Battle Mage");
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const book = magicMelee("Ogre Mage");
        const troll = magicMelee("Troll");
        const units = [mage, charger, book, troll];
        const placed = at(units, [
            { x: 2, y: 6 },
            { x: 3, y: 6 },
            { x: 3, y: 5 },
            { x: 3, y: 11 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 7 });
        expect(cell(next, troll)).toEqual({ x: 3, y: 7 });
        expect(cell(next, charger)).toEqual({ x: 3, y: 6 });
        expect(cell(next, book)).toEqual({ x: 3, y: 5 });
    });

    test("one screen seats the nearer caster and leaves the other", () => {
        const low = caster("Battle Mage");
        const high = caster("Ogre Mage");
        const screen = melee("Screen");
        const units = [low, high, screen];
        const placed = at(units, [
            { x: 1, y: 3 },
            { x: 1, y: 12 },
            { x: 3, y: 6 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, low)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
        expect(cell(next, high)).toEqual({ x: 1, y: 12 });
    });

    test("a covered caster stays inside the protector aura", () => {
        const free = caster("Battle Mage");
        const covered = caster("Ogre Mage");
        const angel = melee("Angel");
        const screen = melee("Screen");
        const units = [free, covered, angel, screen];
        const placed = at(units, [
            { x: 1, y: 3 },
            { x: 1, y: 12 },
            { x: 1, y: 11 },
            { x: 3, y: 4 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Cyclops"]));
        expect(cell(next, covered)).toEqual({ x: 1, y: 12 });
        expect(cell(next, angel)).toEqual({ x: 1, y: 11 });
        expect(cell(next, free)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
    });

    test("breath, skewer, and through shot step the caster one shoulder off and leave the screen", () => {
        const mage = caster("Battle Mage");
        const flyer = caster("Wandering Mage", FLY);
        const wall = melee("Wall");
        const screen = melee("Screen");
        const brute = melee("Brute");
        const units = [mage, flyer, wall, screen, brute];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 2, y: 10 },
            { x: 3, y: 8 },
            { x: 3, y: 6 },
            { x: 3, y: 10 },
        ]);
        for (const enemy of [["Black Dragon"], ["Pikeman"], ["Tsar Cannon"], ["Black Dragon", "Harpy", "Griffin"]]) {
            const next = placeArmyR3C3(placed, units, contextFor(units, enemy));
            expect(cell(next, mage)).toEqual({ x: 1, y: 7 });
            expect(cell(next, wall)).toEqual({ x: 3, y: 8 });
            expect(cell(next, screen)).toEqual({ x: 3, y: 6 });
            expect(cell(next, flyer)).toEqual({ x: 2, y: 10 });
            expect(cell(next, brute)).toEqual({ x: 3, y: 10 });
            expect(cell(next, mage).y).not.toBe(1);
            expect(cell(next, mage).y).not.toBe(14);
        }
    });

    test("the closer shoulder wins, a corner shoulder is refused, and an occupied shoulder stays put", () => {
        const mage = caster("Battle Mage");
        const wide = createTestUnit({
            name: "Wide",
            team: LEFT,
            attackType: MELEE,
            footprintWidth: 1,
            footprintHeight: 2,
        });
        const closerUnits = [mage, wide];
        const closer = at(closerUnits, [
            { x: 2, y: 9 },
            { x: 3, y: 9 },
        ]);
        const stepped = placeArmyR3C3(closer, closerUnits, contextFor(closerUnits, ["Black Dragon"]));
        expect(cell(stepped, mage)).toEqual({ x: 1, y: 10 });
        expect(cell(stepped, wide)).toEqual({ x: 3, y: 9 });

        const wall = melee("Wall");
        const edgeUnits = [mage, wall];
        const edge = at(edgeUnits, [
            { x: 2, y: 2 },
            { x: 3, y: 2 },
        ]);
        const offCorner = placeArmyR3C3(edge, edgeUnits, contextFor(edgeUnits, ["Pikeman"]));
        expect(cell(offCorner, mage)).toEqual({ x: 1, y: 3 });
        expect(cell(offCorner, wall)).toEqual({ x: 3, y: 2 });

        const block = melee("Block");
        const blockedUnits = [mage, wall, block];
        const blocked = at(blockedUnits, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
            { x: 1, y: 7 },
        ]);
        const stayed = placeArmyR3C3(blocked, blockedUnits, contextFor(blockedUnits, ["Tsar Cannon"]));
        expect(cell(stayed, mage)).toEqual({ x: 2, y: 8 });
        expect(cell(stayed, wall)).toEqual({ x: 3, y: 8 });
        expect(cell(stayed, block)).toEqual({ x: 1, y: 7 });

        const alone = [mage, wall];
        const apart = at(alone, [
            { x: 1, y: 4 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR3C3(apart, alone, contextFor(alone, ["Black Dragon"]))).toEqual(apart);
    });

    test("a second caster takes the opposite shoulder of the same ally", () => {
        const first = caster("Battle Mage");
        const second = caster("Ogre Mage");
        const wall = melee("Wall");
        const units = [first, second, wall];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 1, y: 8 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, wall)).toEqual({ x: 3, y: 8 });
        expect([cell(next, first).y, cell(next, second).y].sort((a, b) => a - b)).toEqual([7, 9]);
        expect(cell(next, first).x).toBe(1);
        expect(cell(next, second).x).toBe(1);
    });

    test("a caster inside a protector aura does not step off a breath file", () => {
        const mage = caster("Battle Mage");
        const angel = melee("Angel");
        const wall = melee("Wall");
        const units = [mage, angel, wall];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 2, y: 7 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Black Dragon"]))).toEqual(placed);
    });

    test("two flyers put the screen behind the caster, not on a corner the caster vacated inward", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const brute = melee("Brute");
        const units = [mage, screen, brute];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 10 },
            { x: 1, y: 12 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, mage)).toEqual({ x: 2, y: 6 });
        expect(cell(next, screen)).toEqual({ x: 1, y: 6 });
        expect(cell(next, brute)).toEqual({ x: 1, y: 12 });

        const cornerUnits = [mage, screen];
        const corner = at(cornerUnits, [
            { x: 1, y: 1 },
            { x: 3, y: 8 },
        ]);
        const forward = placeArmyR3C3(corner, cornerUnits, contextFor(cornerUnits, ["Hydra", "Harpy", "Griffin"]));
        expect(cell(forward, mage)).toEqual({ x: 2, y: 1 });
        expect(cell(forward, screen)).toEqual({ x: 1, y: 1 });
        expect(cell(forward, mage)).not.toEqual({ x: 1, y: 2 });
    });

    test("two bows shift a corner pair inward, and the bow's only neighbour is not the screen", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const low = makeUnit("Low", RANGE, 6);
        const high = makeUnit("High", RANGE, 8);
        const units = [mage, screen, low, high];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 8 },
            { x: 1, y: 3 },
            { x: 1, y: 14 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Harpy", "Wyvern"]));
        expect(cell(next, mage)).toEqual({ x: 2, y: 2 });
        expect(cell(next, screen)).toEqual({ x: 1, y: 2 });
        expect(cell(next, low)).toEqual({ x: 1, y: 3 });
        expect(cell(next, high)).toEqual({ x: 1, y: 14 });

        const guard = melee("Guard");
        const other = melee("Other");
        const guardedUnits = [mage, guard, other, high];
        const guarded = at(guardedUnits, [
            { x: 1, y: 4 },
            { x: 2, y: 14 },
            { x: 3, y: 6 },
            { x: 1, y: 14 },
        ]);
        const kept = placeArmyR3C3(guarded, guardedUnits, contextFor(guardedUnits, ["Harpy", "Griffin"]));
        expect(cell(kept, guard)).toEqual({ x: 2, y: 14 });
        expect(cell(kept, high)).toEqual({ x: 1, y: 14 });
        expect(cell(kept, mage)).toEqual({ x: 2, y: 4 });
        expect(cell(kept, other)).toEqual({ x: 1, y: 4 });
    });

    test("a blocked middle or another caster leaves the flyer pair, and flyers beat a shooter wall", () => {
        const mage = caster("Battle Mage");
        const other = caster("Ogre Mage");
        const screen = melee("Screen");
        const units = [mage, other, screen];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 2, y: 6 },
            { x: 3, y: 9 },
        ]);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Harpy", "Griffin"]))).toEqual(placed);

        const pair = [mage, screen];
        const shadow = at(pair, [
            { x: 1, y: 4 },
            { x: 3, y: 8 },
        ]);
        const moved = placeArmyR3C3(shadow, pair, contextFor(pair, ["Harpy", "Griffin", "Elf", "Monk"]));
        expect(cell(moved, mage)).toEqual({ x: 2, y: 4 });
        expect(cell(moved, screen)).toEqual({ x: 1, y: 4 });
    });

    test("two shooters step the caster into the empty shadow and leave the screen", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const brute = melee("Brute");
        const units = [mage, screen, brute];
        const placed = at(units, [
            { x: 1, y: 4 },
            { x: 3, y: 8 },
            { x: 1, y: 10 },
        ]);
        for (const enemy of [
            ["Elf", "Arbalester"],
            ["Zena", "Elf"],
        ]) {
            const next = placeArmyR3C3(placed, units, contextFor(units, enemy));
            expect(cell(next, mage)).toEqual({ x: 2, y: 8 });
            expect(cell(next, screen)).toEqual({ x: 3, y: 8 });
            expect(cell(next, brute)).toEqual({ x: 1, y: 10 });
            expect(cell(next, mage).x).not.toBe(1);
        }
    });

    test("an occupied shadow uses the next screen, and a caster already in a shadow stays", () => {
        const mage = caster("Battle Mage");
        const near = melee("Near");
        const blocker = melee("Blocker");
        const far = melee("Far");
        const units = [mage, near, blocker, far];
        const placed = at(units, [
            { x: 1, y: 4 },
            { x: 3, y: 7 },
            { x: 2, y: 7 },
            { x: 3, y: 10 },
        ]);
        const next = placeArmyR3C3(placed, units, contextFor(units, ["Elf", "Medusa"]));
        expect(cell(next, mage)).toEqual({ x: 2, y: 10 });
        expect(cell(next, near)).toEqual({ x: 3, y: 7 });
        expect(cell(next, blocker)).toEqual({ x: 2, y: 7 });
        expect(cell(next, far)).toEqual({ x: 3, y: 10 });

        const held = caster("Ogre Mage");
        const home = melee("Home");
        const other = melee("Other");
        const staying = [held, home, other];
        const stayedAt = at(staying, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
            { x: 3, y: 4 },
        ]);
        expect(placeArmyR3C3(stayedAt, staying, contextFor(staying, ["Elf", "Arbalester"]))).toEqual(stayedAt);
    });

    test("fireball, meteor, and a single shooter leave the caster where placeArmy put it", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const placed = at(units, [
            { x: 1, y: 4 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Elf"]))).toEqual(placed);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Elf", "Monk", "Wandering Mage"]))).toEqual(placed);
        expect(placeArmyR3C3(placed, units, contextFor(units, ["Elf", "Monk", "Magic Dragon"]))).toEqual(placed);
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const incumbent = at(units, [
            { x: 2, y: 5 },
            { x: 3, y: 4 },
        ]);
        const context = contextFor(units, ["Gargantuan"]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: mage.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r3c3");
        expect(strategy.version).toBe("v0.8");
        expect(strategy.placeArmy(units, context)).toEqual(placeArmyR3C3(incumbent, units, context));
        expect(placements).toBe(1);
        expect(strategy.decideTurn(mage, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: mage.getId() },
        ]);
    });
});

const stack = (name: string, hp: number, attackType: number = RANGE, abilities: string[] = [], damage = 1): Unit =>
    createTestUnit({
        name,
        team: LEFT,
        attackType,
        rangeShots: attackType === RANGE ? 8 : 0,
        shotDistance: attackType === RANGE ? 8 : 0,
        maxHp: hp,
        damageMin: damage,
        damageMax: damage,
        abilities,
    });

describe("r4c1 pierce files, back-rank thirds, and HP corners", () => {
    test("fewer than two bows, plain ground, and chain lightning or lightning spin stay", () => {
        const only = stack("Only", 20);
        const screen = stack("Screen", 30, MELEE);
        const units = [only, screen];
        const placed = at(units, [
            { x: 1, y: 4 },
            { x: 2, y: 4 },
        ]);
        expect(placeArmyR4C1(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
        const bows = [stack("Left", 20), stack("Right", 20), screen];
        const calm = at(bows, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR4C1(calm, bows, contextFor(bows, ["Peasant"]))).toEqual(calm);
        const three = [stack("A", 20), stack("B", 20), stack("C", 20)];
        const back = at(three, [
            { x: 1, y: 1 },
            { x: 1, y: 8 },
            { x: 1, y: 14 },
        ]);
        expect(placeArmyR4C1(back, three, contextFor(three, ["Thunderbird"]))).toEqual(back);
        expect(placeArmyR4C1(back, three, contextFor(three, ["Hydra"]))).toEqual(back);
    });

    test("enemy splash nudges a distance-2 bow pair by one back-rank step", () => {
        const left = stack("Left", 30);
        const right = stack("Right", 10);
        const units = [left, right];
        const placed = at(units, [
            { x: 1, y: 5 },
            { x: 1, y: 7 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 5 });
        expect(cell(next, right)).toEqual({ x: 1, y: 8 });
    });

    test("two bows nudge only their own pair, and a blocked lower-HP bow stays", () => {
        const left = stack("Left", 10);
        const right = stack("Right", 40);
        const screen = stack("Screen", 80, MELEE);
        const units = [left, right, screen];
        const placed = at(units, [
            { x: 1, y: 5 },
            { x: 1, y: 7 },
            { x: 1, y: 3 },
        ]);
        expect(placeArmyR4C1(placed, units, contextFor(units, ["Cyclops"]))).toEqual(placed);
    });

    test("with two bows a screen at distance 2 is the pair and moves instead of the bow", () => {
        const left = stack("Left", 10);
        const right = stack("Right", 10);
        const screen = stack("Screen", 500, MELEE);
        const units = [left, right, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 3 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, screen)).toEqual({ x: 1, y: 4 });
    });

    test("three or more bows nudge every distance-2 pair and prefer a screen over a lower-HP bow", () => {
        const low = stack("Low", 40);
        const lower = stack("Lower", 10);
        const high = stack("High", 40);
        const far = stack("Far", 10);
        const units = [low, lower, high, far];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 3 },
            { x: 1, y: 12 },
            { x: 1, y: 10 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Gargantuan", "Black Dragon"]));
        expect(cell(next, low)).toEqual({ x: 1, y: 1 });
        expect(cell(next, lower)).toEqual({ x: 1, y: 4 });
        expect(cell(next, high)).toEqual({ x: 1, y: 12 });
        expect(cell(next, far)).toEqual({ x: 1, y: 9 });

        const left = stack("Left", 20);
        const right = stack("Right", 20);
        const mid = stack("Mid", 10);
        const screen = stack("Screen", 500, MELEE);
        const screened = [left, right, mid, screen];
        const crowd = at(screened, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 5 },
            { x: 1, y: 7 },
        ]);
        const preferred = placeArmyR4C1(crowd, screened, contextFor(screened, ["Gargantuan"]));
        expect(cell(preferred, mid)).toEqual({ x: 1, y: 5 });
        expect(cell(preferred, screen)).toEqual({ x: 1, y: 8 });
        expect(cell(preferred, left)).toEqual({ x: 1, y: 1 });
        expect(cell(preferred, right)).toEqual({ x: 1, y: 14 });
    });

    test("pierce moves a shared file onto the front, and a blast refuses the adjacent front cell", () => {
        const left = stack("Left", 20);
        const right = stack("Right", 20);
        const screen = stack("Screen", 30, MELEE);
        const units = [left, right, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 2, y: 1 },
        ]);
        for (const enemy of ["Black Dragon", "Pikeman", "Tsar Cannon"]) {
            const next = placeArmyR4C1(placed, units, contextFor(units, [enemy]));
            expect(cell(next, left)).toEqual({ x: 1, y: 1 });
            expect(cell(next, right)).toEqual({ x: 1, y: 14 });
            expect(cell(next, screen)).toEqual({ x: 3, y: 2 });
        }
        const frontBows = [left, right, screen];
        const front = at(frontBows, [
            { x: 3, y: 1 },
            { x: 3, y: 14 },
            { x: 2, y: 1 },
        ]);
        const blasted = placeArmyR4C1(front, frontBows, contextFor(frontBows, ["Black Dragon", "Wandering Mage"]));
        expect(cell(blasted, screen)).toEqual({ x: 3, y: 3 });
        expect(cell(blasted, left)).toEqual({ x: 3, y: 1 });
        const plain = placeArmyR4C1(front, frontBows, contextFor(frontBows, ["Black Dragon"]));
        expect(cell(plain, screen)).toEqual({ x: 3, y: 2 });
    });

    test("a third bow slides along the back rank to a third when pierce and a blast are both public", () => {
        const left = stack("Left", 20);
        const right = stack("Right", 20);
        const extra = stack("Extra", 20);
        const units = [left, right, extra];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 4 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Black Dragon", "Wandering Mage"]));
        expect(cell(next, left)).toEqual({ x: 1, y: 1 });
        expect(cell(next, right)).toEqual({ x: 1, y: 14 });
        expect(cell(next, extra)).toEqual({ x: 1, y: 5 });
    });

    test("blasts without pierce slide extras to the thirds and leave two bows or a forward bow alone", () => {
        const left = stack("Left", 20);
        const right = stack("Right", 20);
        const pair = [left, right];
        const two = at(pair, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ]);
        expect(placeArmyR4C1(two, pair, contextFor(pair, ["Magic Dragon"]))).toEqual(two);
        const low = stack("Low", 20);
        const high = stack("High", 20);
        const near = stack("Near", 20);
        const far = stack("Far", 20);
        const units = [low, high, near, far];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 4 },
            { x: 1, y: 12 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Magic Dragon"]));
        expect(cell(next, low)).toEqual({ x: 1, y: 1 });
        expect(cell(next, high)).toEqual({ x: 1, y: 14 });
        expect(cell(next, near)).toEqual({ x: 1, y: 5 });
        expect(cell(next, far)).toEqual({ x: 1, y: 10 });
        const forward = stack("Forward", 20);
        const held = [low, high, forward];
        const middle = at(held, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 2, y: 8 },
        ]);
        expect(placeArmyR4C1(middle, held, contextFor(held, ["Magic Dragon"]))).toEqual(middle);
        const wide = placeArmyR4C1(placed, units, contextFor(units, ["Griffin", "Magic Dragon"]));
        expect(cell(wide, near)).toEqual({ x: 1, y: 6 });
        expect(cell(wide, far)).toEqual({ x: 1, y: 12 });
        expect(cell(wide, low)).toEqual({ x: 1, y: 1 });
        expect(cell(wide, high)).toEqual({ x: 1, y: 14 });
    });

    test("against two grounded shooters the highest HP bows take the corners and leather does not", () => {
        const low = stack("Low", 10);
        const high = stack("High", 50, RANGE, ["Sniper"]);
        const mid = stack("Mid", 30);
        const guard = stack("Guard", 80, MELEE);
        const units = [low, high, mid, guard];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 8 },
            { x: 1, y: 14 },
            { x: 2, y: 8 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Elf", "Monk"]));
        expect(cell(next, high)).toEqual({ x: 1, y: 1 });
        expect(cell(next, mid)).toEqual({ x: 1, y: 14 });
        expect(cell(next, low)).toEqual({ x: 1, y: 8 });
        expect(cell(next, guard)).toEqual({ x: 2, y: 8 });

        const leather = stack("Leather", 200, RANGE, ["Leather Armor"]);
        const sniper = stack("Sniper", 40, RANGE, ["Sniper"]);
        const other = stack("Other", 30);
        const body = stack("Body", 15, MELEE);
        const leatherUnits = [leather, sniper, other, body];
        const leatherPlaced = at(leatherUnits, [
            { x: 1, y: 1 },
            { x: 1, y: 6 },
            { x: 1, y: 14 },
            { x: 2, y: 8 },
        ]);
        const swapped = placeArmyR4C1(leatherPlaced, leatherUnits, contextFor(leatherUnits, ["Elf", "Monk"]));
        expect(cell(swapped, sniper)).toEqual({ x: 1, y: 1 });
        expect(cell(swapped, other)).toEqual({ x: 1, y: 14 });
        expect(cell(swapped, leather)).toEqual({ x: 1, y: 6 });
        expect(cell(swapped, body)).toEqual({ x: 2, y: 8 });
    });

    test("an own splash bow stays put with exactly two bows and otherwise takes the centre back rank", () => {
        const splash = stack("Splash", 100, RANGE, ["Area Throw"]);
        const other = stack("Other", 50);
        const pair = [splash, other];
        const two = at(pair, [
            { x: 1, y: 1 },
            { x: 1, y: 8 },
        ]);
        const held = placeArmyR4C1(two, pair, contextFor(pair, ["Elf", "Monk"]));
        expect(cell(held, splash)).toEqual({ x: 1, y: 1 });
        expect(cell(held, other)).toEqual({ x: 1, y: 14 });

        const extra = stack("Extra", 20);
        const units = [splash, other, extra];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 10 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Elf", "Monk"]));
        expect(cell(next, splash)).toEqual({ x: 1, y: 7 });
        expect(cell(next, extra)).toEqual({ x: 1, y: 1 });
        expect(cell(next, other)).toEqual({ x: 1, y: 14 });
    });

    test("a guiding winds bow that missed a corner stands next to the higher-damage corner", () => {
        const heavy = stack("Heavy", 40, RANGE, [], 20);
        const light = stack("Light", 35, RANGE, [], 1);
        const carrier = stack("Carrier", 10, RANGE, ["Guiding Winds Aura"]);
        const guard = stack("Guard", 12, MELEE);
        const units = [heavy, light, carrier, guard];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 8 },
            { x: 3, y: 6 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Zena", "Monk"]));
        expect(cell(next, heavy)).toEqual({ x: 1, y: 1 });
        expect(cell(next, light)).toEqual({ x: 1, y: 14 });
        expect(cell(next, carrier)).toEqual({ x: 1, y: 2 });
        expect(cell(next, guard)).toEqual({ x: 3, y: 6 });
    });

    test("with no public branch an own splash bow takes the centre and a one-cell bow may refill", () => {
        const splash = stack("Splash", 40, RANGE, ["Large Caliber"]);
        const other = stack("Other", 30);
        const extra = stack("Extra", 20);
        const guard = stack("Guard", 15, MELEE);
        const units = [splash, other, extra, guard];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
            { x: 1, y: 4 },
            { x: 2, y: 9 },
        ]);
        const next = placeArmyR4C1(placed, units, contextFor(units, ["Peasant"]));
        expect(cell(next, splash)).toEqual({ x: 1, y: 7 });
        expect(cell(next, extra)).toEqual({ x: 1, y: 1 });
        expect(cell(next, other)).toEqual({ x: 1, y: 14 });
        expect(cell(next, guard)).toEqual({ x: 2, y: 9 });
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const bow = stack("Only", 20);
        const units = [bow];
        const incumbent = at(units, [{ x: 1, y: 4 }]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: bow.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r4c1");
        const context = contextFor(units, ["Peasant"]);
        expect(strategy.version).toBe("v0.8");
        expect(strategy.placeArmy(units, context)).toEqual(incumbent);
        expect(placements).toBe(1);
        expect(strategy.decideTurn(bow, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: bow.getId() },
        ]);
    });
});

const stepsOf = (unit: Unit, steps: number): Unit => {
    (unit as unknown as { unitProperties: { steps: number } }).unitProperties.steps = steps;
    return unit;
};

const wide = (name: string, armor = 10, abilities: string[] = []): Unit =>
    createTestUnit({
        name,
        team: LEFT,
        attackType: MELEE,
        armor,
        abilities,
        footprintWidth: 2,
        footprintHeight: 1,
    });

describe("r4c2 nothing behind a strike, or flyers on one high file", () => {
    const wing = (name: string): Unit => makeUnit(name, MELEE, 0, FLY);

    test("splash, a plain roster, Through Shot, and Chakram leave the map", () => {
        const front = melee("Front", 12);
        const rear = melee("Rear", 8);
        const units = [front, rear];
        const placed = at(units, [
            { x: 3, y: 5 },
            { x: 2, y: 5 },
        ]);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Gargantuan"]))).toEqual(placed);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Cyclops"]))).toEqual(placed);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Peasant"]))).toEqual(placed);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Tsar Cannon"]))).toEqual(placed);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Zena"]))).toEqual(placed);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Elf"]))).toEqual(placed);
    });

    test("Fire Breath moves the stack behind a strike to the back of an empty front, not one file aside", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const front = melee("Front", 12);
        const rear = melee("Rear", 18);
        const edge = melee("Edge", 9);
        const units = [bow, front, rear, edge];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 5 },
            { x: 2, y: 5 },
            { x: 3, y: 12 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, front)).toEqual({ x: 3, y: 5 });
        expect(cell(next, edge)).toEqual({ x: 3, y: 12 });
        expect(cell(next, rear)).toEqual({ x: 1, y: 4 });
        const skewer = placeArmyR4C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(skewer, rear)).toEqual({ x: 1, y: 4 });
        const spun = placeArmyR4C2(placed, units, contextFor(units, ["Hydra", "Black Dragon"]));
        expect(cell(spun, front)).toEqual({ x: 3, y: 5 });
        expect(cell(spun, rear)).toEqual({ x: 1, y: 4 });
    });

    test("a corner bow stays, and the body behind the next file does not take that cell", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const front = melee("Front", 12);
        const rear = melee("Rear", 18);
        const units = [bow, front, rear];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 3, y: 2 },
            { x: 2, y: 2 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, front)).toEqual({ x: 3, y: 2 });
        expect(cell(next, rear)).toEqual({ x: 1, y: 3 });
    });

    test("a ranged stack behind a screen stays, and a legal file is not rebuilt", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const front = melee("Front", 12);
        const units = [bow, front];
        const placed = at(units, [
            { x: 2, y: 5 },
            { x: 3, y: 5 },
        ]);
        expect(placeArmyR4C2(placed, units, contextFor(units, ["Black Dragon"]))).toEqual(placed);

        const left = melee("Left", 12);
        const right = melee("Right", 14);
        const charger = stepsOf(melee("Charger", 5, ["Rapid Charge"]), 6);
        const parked = wing("Parked");
        const calm = [left, right, charger, parked];
        const calmAt = at(calm, [
            { x: 3, y: 2 },
            { x: 3, y: 12 },
            { x: 3, y: 9 },
            { x: 1, y: 5 },
        ]);
        expect(placeArmyR4C2(calmAt, calm, contextFor(calm, ["Black Dragon"]))).toEqual(calmAt);
    });

    test("the fastest charger takes a clear front cell, and a slower one already there stays", () => {
        const screen = melee("Screen", 20);
        const fast = stepsOf(melee("Fast", 5, ["Rapid Charge"]), 8);
        const slow = stepsOf(melee("Slow", 9, ["Rapid Charge"]), 2);
        const units = [screen, fast, slow];
        const placed = at(units, [
            { x: 3, y: 6 },
            { x: 1, y: 6 },
            { x: 3, y: 11 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(next, screen)).toEqual({ x: 3, y: 6 });
        expect(cell(next, fast)).toEqual({ x: 3, y: 5 });
        expect(cell(next, slow)).toEqual({ x: 3, y: 11 });
        expect(cell(next, fast).x).not.toBe(1);
    });

    test("a flyer leaves the file it shares and does not step one cell along the back rank", () => {
        const screen = melee("Screen", 10);
        const parked = wing("Winged");
        const units = [screen, parked];
        const placed = at(units, [
            { x: 3, y: 6 },
            { x: 1, y: 6 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, screen)).toEqual({ x: 3, y: 6 });
        expect(cell(next, parked)).toEqual({ x: 1, y: 4 });
    });

    test("a lone flyer drops to the back of its own file, and a lone charger steps up to the front", () => {
        const parked = wing("Winged");
        const alone = [parked];
        const parkedAt = at(alone, [{ x: 3, y: 10 }]);
        expect(placeArmyR4C2(parkedAt, alone, contextFor(alone, ["Black Dragon"]))).toEqual(
            at(alone, [{ x: 1, y: 10 }]),
        );
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const rush = [charger];
        const rushAt = at(rush, [{ x: 1, y: 10 }]);
        expect(placeArmyR4C2(rushAt, rush, contextFor(rush, ["Pikeman"]))).toEqual(at(rush, [{ x: 3, y: 10 }]));
    });

    test("a 2x2 on the front and middle keeps the back cells of its files empty", () => {
        const large = createTestUnit({
            name: "Large",
            team: LEFT,
            attackType: MELEE,
            armor: 30,
            footprintWidth: 2,
            footprintHeight: 2,
        });
        const rear = melee("Rear", 8);
        const units = [large, rear];
        const placed = at(units, [
            { x: 3, y: 8 },
            { x: 1, y: 8 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, large)).toEqual({ x: 3, y: 8 });
        expect(cell(next, rear)).toEqual({ x: 1, y: 6 });
    });

    test("the same back-rank move stays inside the right-hand zone", () => {
        const front = melee("Front", 12);
        const rear = melee("Rear", 18);
        const units = [front, rear];
        const placed = at(units, [
            { x: 12, y: 5 },
            { x: 13, y: 5 },
        ]);
        const context = contextFor(units, ["Black Dragon"]);
        const right = {
            ...context,
            team: PBTypes.TeamVals.RIGHT,
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.RIGHT_BOTTOM, 3, true),
        };
        const next = placeArmyR4C2(placed, units, right);
        expect(cell(next, front)).toEqual({ x: 12, y: 5 });
        expect(cell(next, rear)).toEqual({ x: 14, y: 4 });
    });

    test("Lightning Spin seats only the highest-armor one-cell screen and empties the middle", () => {
        const heavy = melee("Heavy", 40);
        const light = melee("Light", 10);
        const parked = wing("Winged");
        const charger = melee("Charger", 5, ["Rapid Charge"]);
        const units = [heavy, light, parked, charger];
        const placed = at(units, [
            { x: 3, y: 10 },
            { x: 3, y: 4 },
            { x: 3, y: 12 },
            { x: 2, y: 6 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Hydra"]));
        expect(cell(next, heavy)).toEqual({ x: 3, y: 8 });
        expect(cell(next, light)).toEqual({ x: 1, y: 4 });
        expect(cell(next, parked)).toEqual({ x: 1, y: 12 });
        expect(cell(next, charger)).toEqual({ x: 1, y: 6 });
        expect(atCells(next, units).some((anchor) => anchor.x === 2)).toBe(false);
        expect(atCells(next, [light, parked, charger]).some((anchor) => anchor.x === 3)).toBe(false);
    });

    test("Lightning Spin leaves a 2x2, a flyer-only army, and a one-cell gap with a bow", () => {
        const large = createTestUnit({
            name: "Large",
            team: LEFT,
            attackType: MELEE,
            footprintWidth: 2,
            footprintHeight: 2,
        });
        const screen = melee("Screen", 20);
        const pair = [large, screen];
        const paired = at(pair, [
            { x: 3, y: 8 },
            { x: 3, y: 4 },
        ]);
        expect(placeArmyR4C2(paired, pair, contextFor(pair, ["Hydra"]))).toEqual(paired);
        const parked = wing("Winged");
        const only = [parked];
        const onlyAt = at(only, [{ x: 3, y: 4 }]);
        expect(placeArmyR4C2(onlyAt, only, contextFor(only, ["Hydra"]))).toEqual(onlyAt);

        const bow = makeUnit("Bow", RANGE, 6);
        const high = melee("High", 30);
        const low = melee("Low", 5);
        const gapped = [bow, high, low];
        const gappedAt = at(gapped, [
            { x: 3, y: 6 },
            { x: 3, y: 2 },
            { x: 1, y: 10 },
        ]);
        expect(placeArmyR4C2(gappedAt, gapped, contextFor(gapped, ["Hydra"]))).toEqual(gappedAt);
    });

    test("flyers stack on the high file and screens take the low front, centre, then the low column", () => {
        const charger = stepsOf(melee("Charger", 4, ["Rapid Charge"]), 7);
        const first = wing("First");
        const second = wing("Second");
        const heavy = melee("Heavy", 40);
        const mid = melee("Mid", 20);
        const light = melee("Light", 10);
        const units = [charger, first, second, heavy, mid, light];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 6 },
            { x: 1, y: 8 },
            { x: 3, y: 3 },
            { x: 2, y: 9 },
            { x: 1, y: 11 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Harpy"]));
        expect(cell(next, charger)).toEqual({ x: 3, y: 14 });
        expect(cell(next, first)).toEqual({ x: 2, y: 14 });
        expect(cell(next, second)).toEqual({ x: 1, y: 14 });
        expect(cell(next, heavy)).toEqual({ x: 3, y: 1 });
        expect(cell(next, mid)).toEqual({ x: 3, y: 8 });
        expect(cell(next, light)).toEqual({ x: 2, y: 1 });
        expect([1, 8].includes(cell(next, first).y)).toBe(false);
        expect(cell(next, heavy).y).not.toBe(14);
    });

    test("a blast still stacks flyers on the high file and does not seat a new adjacent screen pair", () => {
        const first = wing("First");
        const second = wing("Second");
        const heavy = melee("Heavy", 40);
        const mid = melee("Mid", 20);
        const light = melee("Light", 10);
        const units = [first, second, heavy, mid, light];
        const placed = at(units, [
            { x: 3, y: 4 },
            { x: 3, y: 6 },
            { x: 2, y: 8 },
            { x: 1, y: 9 },
            { x: 3, y: 11 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Harpy", "Wandering Mage"]));
        expect(cell(next, first)).toEqual({ x: 3, y: 14 });
        expect(cell(next, second)).toEqual({ x: 2, y: 14 });
        expect(cell(next, heavy)).toEqual({ x: 3, y: 1 });
        expect(cell(next, mid)).toEqual({ x: 3, y: 8 });
        expect(cell(next, light)).toEqual({ x: 1, y: 1 });
        expect(cell(next, light)).not.toEqual({ x: 2, y: 1 });
    });

    test("a deep charger occupies the high front and middle, and the next flyer takes the back", () => {
        const charger = stepsOf(wide("Charger", 8, ["Rapid Charge"]), 6);
        const parked = wing("Winged");
        const units = [charger, parked];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 8 },
        ]);
        const next = placeArmyR4C2(placed, units, contextFor(units, ["Griffin"]));
        expect(cell(next, charger)).toEqual({ x: 3, y: 14 });
        expect(cell(next, parked)).toEqual({ x: 1, y: 14 });
    });

    test("a bow on the high front, or a large screen, leaves the flyer stack unchanged", () => {
        const bow = makeUnit("Bow", RANGE, 6);
        const parked = wing("Winged");
        const screen = melee("Screen", 12);
        const blocked = [bow, parked, screen];
        const blockedAt = at(blocked, [
            { x: 3, y: 14 },
            { x: 2, y: 4 },
            { x: 3, y: 6 },
        ]);
        expect(placeArmyR4C2(blockedAt, blocked, contextFor(blocked, ["Harpy"]))).toEqual(blockedAt);
        const large = createTestUnit({
            name: "Large",
            team: LEFT,
            attackType: MELEE,
            footprintWidth: 2,
            footprintHeight: 2,
        });
        const held = [parked, large];
        const heldAt = at(held, [
            { x: 3, y: 4 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR4C2(heldAt, held, contextFor(held, ["Harpy"]))).toEqual(heldAt);
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const screen = melee("Screen", 10);
        const units = [screen];
        const incumbent = at(units, [{ x: 3, y: 4 }]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: screen.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r4c2");
        const context = contextFor(units, ["Peasant"]);
        expect(strategy.version).toBe("v0.8");
        expect(strategy.placeArmy(units, context)).toEqual(incumbent);
        expect(placements).toBe(1);
        expect(strategy.decideTurn(screen, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: screen.getId() },
        ]);
    });
});

const RIGHT = PBTypes.TeamVals.RIGHT;

const sortedCells = (cells: readonly XY[]): XY[] => [...cells].sort((a, b) => a.x - b.x || a.y - b.y);

describe("r4c3 caster outside the aim, screen on the cell that is hit first", () => {
    test("no caster, a large spellcaster, or a covered caster leaves the map", () => {
        const screen = melee("Screen");
        const alone = [screen];
        const aloneAt = at(alone, [{ x: 2, y: 6 }]);
        expect(placeArmyR4C3(aloneAt, alone, contextFor(alone, ["Gargantuan"]))).toEqual(aloneAt);

        const big = createTestUnit({
            name: "Big Mage",
            team: LEFT,
            attackType: MELEE,
            spells: ["Chaos:Fire Strike"],
            footprintWidth: 2,
            footprintHeight: 2,
        });
        const large = [big, screen];
        const largeAt = at(large, [
            { x: 2, y: 6 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR4C3(largeAt, large, contextFor(large, ["Cyclops"]))).toEqual(largeAt);

        const covered = caster("Ogre Mage");
        const angel = melee("Angel");
        const held = [covered, angel, screen];
        const heldAt = at(held, [
            { x: 1, y: 12 },
            { x: 1, y: 11 },
            { x: 3, y: 4 },
        ]);
        expect(placeArmyR4C3(heldAt, held, contextFor(held, ["Gargantuan"]))).toEqual(heldAt);
    });

    test("plain ground, one flyer, Lightning Spin, and one chakram bow leave the map", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const placed = at(units, [
            { x: 2, y: 6 },
            { x: 3, y: 6 },
        ]);
        for (const enemy of ["Peasant", "Thunderbird", "Hydra", "Zena"]) {
            expect(placeArmyR4C3(placed, units, contextFor(units, [enemy]))).toEqual(placed);
        }
    });

    test("Area Throw or Meteor Shower isolates each caster and puts the screen three files toward the edge", () => {
        const low = caster("Battle Mage");
        const high = caster("Ogre Mage");
        const screenLow = melee("NearLow");
        const screenHigh = melee("NearHigh");
        const sentinel = melee("Sentinel");
        const monk = caster("Monk");
        const bow = makeUnit("Bow", RANGE, 6);
        const units = [low, high, screenLow, screenHigh, sentinel, monk, bow];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 2, y: 11 },
            { x: 3, y: 4 },
            { x: 3, y: 11 },
            { x: 2, y: 8 },
            { x: 3, y: 7 },
            { x: 1, y: 1 },
        ]);
        for (const enemy of ["Gargantuan", "Magic Dragon"]) {
            const opponents = enemy === "Gargantuan" ? [enemy, "Black Dragon"] : [enemy];
            const next = placeArmyR4C3(placed, units, contextFor(units, opponents));
            expect(cell(next, low)).toEqual({ x: 1, y: 4 });
            expect(cell(next, screenLow)).toEqual({ x: 3, y: 1 });
            expect(cell(next, high)).toEqual({ x: 1, y: 11 });
            expect(cell(next, screenHigh)).toEqual({ x: 3, y: 14 });
            expect(cell(next, sentinel)).toEqual({ x: 2, y: 8 });
            expect(cell(next, monk)).toEqual({ x: 3, y: 7 });
            expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        }
    });

    test("stacks inside chebyshev 2 of an Area Throw caster pack onto the opposite front wing", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const clutter = melee("Clutter", 5, ["Rapid Charge"]);
        const far = melee("Far");
        const bow = makeUnit("Bow", RANGE, 6);
        const guard = melee("Guard");
        const units = [mage, screen, clutter, far, bow, guard];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 4 },
            { x: 1, y: 6 },
            { x: 3, y: 12 },
            { x: 1, y: 14 },
            { x: 2, y: 14 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 4 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 1 });
        expect(cell(next, clutter)).toEqual({ x: 3, y: 14 });
        expect(cell(next, far)).toEqual({ x: 3, y: 12 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(next, guard)).toEqual({ x: 2, y: 14 });
    });

    test("Large Caliber, Fireball, and Meteorite use the off-file middle gap and do not evict", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const flyer = makeUnit("Flyer", MELEE, 0, FLY);
        const far = melee("Far");
        const units = [mage, screen, flyer, far];
        const placed = at(units, [
            { x: 2, y: 6 },
            { x: 3, y: 9 },
            { x: 1, y: 7 },
            { x: 3, y: 12 },
        ]);
        for (const enemy of ["Cyclops", "Wandering Mage", "Battle Mage"]) {
            const next = placeArmyR4C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, mage)).toEqual({ x: 1, y: 5 });
            expect(cell(next, screen)).toEqual({ x: 2, y: 3 });
            expect(cell(next, flyer)).toEqual({ x: 1, y: 7 });
            expect(cell(next, far)).toEqual({ x: 3, y: 12 });
        }
    });

    test("the same middle gap is mirrored for the right seat", () => {
        const mage = createTestUnit({
            name: "Battle Mage",
            team: RIGHT,
            attackType: MELEE,
            spells: ["Chaos:Fire Strike"],
        });
        const screen = createTestUnit({ name: "Screen", team: RIGHT, attackType: MELEE });
        const units = [mage, screen];
        const placed = at(units, [
            { x: 13, y: 6 },
            { x: 12, y: 9 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Cyclops"], RIGHT));
        expect(cell(next, mage)).toEqual({ x: 14, y: 6 });
        expect(cell(next, screen)).toEqual({ x: 13, y: 4 });
    });

    test("breath, skewer, and through shot empty the caster file and screen the inward shoulder", () => {
        const mage = caster("Battle Mage");
        const flyer = caster("Wandering Mage", FLY);
        const screen = melee("Screen");
        const other = melee("Other");
        const units = [mage, flyer, screen, other];
        const placed = at(units, [
            { x: 2, y: 5 },
            { x: 2, y: 10 },
            { x: 3, y: 8 },
            { x: 3, y: 12 },
        ]);
        for (const enemy of ["Black Dragon", "Pikeman", "Tsar Cannon"]) {
            const next = placeArmyR4C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, mage)).toEqual({ x: 1, y: 5 });
            expect(cell(next, screen)).toEqual({ x: 3, y: 6 });
            expect(cell(next, flyer)).toEqual({ x: 2, y: 10 });
            expect(cell(next, other)).toEqual({ x: 3, y: 12 });
            expect(
                sortedCells([cell(next, mage), cell(next, screen), cell(next, other)]).some(
                    (entry) => entry.y === 5 && entry.x > 1,
                ),
            ).toBe(false);
        }
    });

    test("a 2x2 screen shifts one file further so it does not share the caster file", () => {
        const mage = caster("Battle Mage");
        const wide = createTestUnit({
            name: "Wide",
            team: LEFT,
            attackType: MELEE,
            footprintWidth: 2,
            footprintHeight: 2,
        });
        const units = [mage, wide];
        const placed = at(units, [
            { x: 2, y: 5 },
            { x: 3, y: 9 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 5 });
        expect(cell(next, wide)).toEqual({ x: 3, y: 7 });
    });

    test("a second line caster takes the other half", () => {
        const low = caster("Battle Mage");
        const high = caster("Ogre Mage");
        const screenLow = melee("NearLow");
        const screenHigh = melee("NearHigh");
        const units = [low, high, screenLow, screenHigh];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 2, y: 11 },
            { x: 3, y: 3 },
            { x: 3, y: 12 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Pikeman"]));
        expect(cell(next, low)).toEqual({ x: 1, y: 4 });
        expect(cell(next, screenLow)).toEqual({ x: 3, y: 5 });
        expect(cell(next, high)).toEqual({ x: 1, y: 11 });
        expect(cell(next, screenHigh)).toEqual({ x: 3, y: 10 });
    });

    test("two flyers cap the three middle cells in front of the centre caster", () => {
        const mage = caster("Battle Mage");
        const second = caster("Ogre Mage");
        const screen = melee("Screen");
        const left = melee("LeftBody");
        const right = melee("RightBody");
        const units = [mage, second, screen, left, right];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 1, y: 13 },
            { x: 2, y: 6 },
            { x: 3, y: 2 },
            { x: 3, y: 12 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 7 });
        expect(cell(next, screen)).toEqual({ x: 2, y: 7 });
        expect(cell(next, left)).toEqual({ x: 2, y: 6 });
        expect(cell(next, right)).toEqual({ x: 2, y: 8 });
        expect(cell(next, second)).toEqual({ x: 1, y: 8 });
    });

    test("a blocked centre file is left alone when the other centre file is blocked too", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const left = melee("LeftBody");
        const right = melee("RightBody");
        const lowFlyer = makeUnit("LowFlyer", MELEE, 0, FLY);
        const highFlyer = makeUnit("HighFlyer", MELEE, 0, FLY);
        const units = [mage, screen, left, right, lowFlyer, highFlyer];
        const placed = at(units, [
            { x: 1, y: 3 },
            { x: 3, y: 3 },
            { x: 3, y: 2 },
            { x: 3, y: 10 },
            { x: 1, y: 7 },
            { x: 1, y: 8 },
        ]);
        expect(placeArmyR4C3(placed, units, contextFor(units, ["Harpy", "Griffin"]))).toEqual(placed);
    });

    test("three further screens give the second caster its own cap", () => {
        const first = caster("Battle Mage");
        const second = caster("Ogre Mage");
        const centre = melee("Centre");
        const wingLow = melee("WingLow", 5, ["Rapid Charge"]);
        const wingHigh = melee("WingHigh", 5, ["Rapid Charge"]);
        const extraA = melee("ExtraA");
        const extraB = melee("ExtraB");
        const extraC = melee("ExtraC");
        const units = [first, second, centre, wingLow, wingHigh, extraA, extraB, extraC];
        const placed = at(units, [
            { x: 1, y: 3 },
            { x: 1, y: 13 },
            { x: 2, y: 3 },
            { x: 3, y: 2 },
            { x: 3, y: 4 },
            { x: 3, y: 11 },
            { x: 3, y: 12 },
            { x: 3, y: 13 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, first)).toEqual({ x: 1, y: 7 });
        expect(cell(next, centre)).toEqual({ x: 2, y: 7 });
        expect(sortedCells([cell(next, wingLow), cell(next, wingHigh)])).toEqual([
            { x: 2, y: 6 },
            { x: 2, y: 8 },
        ]);
        expect(cell(next, second)).toEqual({ x: 1, y: 10 });
        expect(sortedCells([cell(next, extraA), cell(next, extraB), cell(next, extraC)])).toEqual([
            { x: 2, y: 9 },
            { x: 2, y: 10 },
            { x: 2, y: 11 },
        ]);
    });

    test("two enemy bows box one caster with non-range bodies and do not move a corner bow", () => {
        const mage = caster("Battle Mage");
        const left = melee("LeftBody");
        const right = melee("RightBody");
        const front = melee("FrontBody");
        const bow = makeUnit("Bow", RANGE, 6);
        const monk = caster("Monk");
        const units = [mage, left, right, front, bow, monk];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 3 },
            { x: 3, y: 4 },
            { x: 3, y: 5 },
            { x: 1, y: 1 },
            { x: 3, y: 12 },
        ]);
        const next = placeArmyR4C3(placed, units, contextFor(units, ["Elf", "Medusa"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 8 });
        expect(sortedCells([cell(next, left), cell(next, right), cell(next, front)])).toEqual([
            { x: 1, y: 7 },
            { x: 1, y: 9 },
            { x: 2, y: 8 },
        ]);
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        expect(cell(next, monk)).toEqual({ x: 3, y: 12 });
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const incumbent = at(units, [
            { x: 2, y: 6 },
            { x: 3, y: 9 },
        ]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: mage.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r4c3");
        const moved = strategy.placeArmy(units, contextFor(units, ["Cyclops"]));
        expect(strategy.version).toBe("v0.8");
        expect(placements).toBe(1);
        expect(cell(moved, mage)).toEqual({ x: 1, y: 6 });
        expect(cell(moved, screen)).toEqual({ x: 2, y: 4 });
        expect(strategy.decideTurn(mage, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: mage.getId() },
        ]);
    });
});

describe("r5c1 empty-aim ring, cannon files, or full-damage corners", () => {
    const RIGHT = PBTypes.TeamVals.RIGHT;
    const piece = (
        name: string,
        attack: number,
        shot = 0,
        extras: { hp?: number; fly?: boolean; abilities?: string[]; team?: number } = {},
    ): Unit =>
        createTestUnit({
            name,
            team: extras.team ?? LEFT,
            attackType: attack,
            rangeShots: attack === RANGE ? 8 : 0,
            shotDistance: shot,
            movementType: extras.fly ? FLY : WALK,
            abilities: extras.abilities ?? [],
            maxHp: extras.hp ?? 10,
        });

    const occupied = (placed: ReadonlyMap<string, XY>): XY[] => [...placed.values()];

    test("an army with no bow is left alone", () => {
        const screen = piece("Screen", MELEE);
        const placed = at([screen], [{ x: 3, y: 8 }]);
        expect(placeArmyR5C1(placed, [screen], contextFor([screen], ["Gargantuan"]))).toEqual(placed);
    });

    test("Area Throw puts one bow on the nearer back corner and the block on the opposite front wing", () => {
        const bow = piece("Bow", RANGE, 6);
        const first = piece("First", MELEE);
        const second = piece("Second", MELEE);
        const units = [bow, first, second];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
            { x: 2, y: 4 },
        ]);
        const next = placeArmyR5C1(placed, units, contextFor(units, ["Gargantuan", "Cyclops"]));
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect(sortedCells([cell(next, first), cell(next, second)])).toEqual([
            { x: 3, y: 1 },
            { x: 3, y: 2 },
        ]);
        for (const lat of [12, 13, 14]) expect(occupied(next)).not.toContainEqual({ x: 3, y: lat });
    });

    test("two Area Throw bows stay Chebyshev 3 apart and a short bow does not take the other corner", () => {
        const sniper = piece("Sniper", RANGE, 5, { abilities: ["Sniper"] });
        const long = piece("Long", RANGE, 6.5);
        const short = piece("Short", RANGE, 5);
        const screen = piece("Screen", MELEE);
        const pair = [sniper, long, screen];
        const spread = placeArmyR5C1(
            at(pair, [
                { x: 2, y: 6 },
                { x: 2, y: 9 },
                { x: 3, y: 4 },
            ]),
            pair,
            contextFor(pair, ["Gargantuan"]),
        );
        expect(cell(spread, long)).toEqual({ x: 1, y: 1 });
        expect(cell(spread, sniper)).toEqual({ x: 1, y: 14 });
        expect(cell(spread, screen)).toEqual({ x: 3, y: 7 });
        const units = [sniper, short, screen];
        const next = placeArmyR5C1(
            at(units, [
                { x: 2, y: 6 },
                { x: 2, y: 9 },
                { x: 3, y: 4 },
            ]),
            units,
            contextFor(units, ["Gargantuan"]),
        );
        expect(cell(next, sniper)).toEqual({ x: 1, y: 1 });
        expect(cell(next, short)).toEqual({ x: 3, y: 14 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
    });

    test("Large Caliber packs the front centre and still allows a Chebyshev-2 body", () => {
        const bow = piece("Bow", RANGE, 6);
        const screen = piece("Screen", MELEE);
        const units = [bow, screen];
        const next = placeArmyR5C1(
            at(units, [
                { x: 1, y: 8 },
                { x: 2, y: 2 },
            ]),
            units,
            contextFor(units, ["Cyclops"]),
        );
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
        expect(occupied(next)).not.toContainEqual({ x: 2, y: 14 });

        const bodies = Array.from({ length: 10 }, (_, index) => piece(`Body${index}`, MELEE));
        const army = [bow, ...bodies];
        const packed = placeArmyR5C1(
            at(army, [{ x: 1, y: 8 }, ...bodies.map((_, index) => ({ x: 3, y: index + 1 }))]),
            army,
            contextFor(army, ["Cyclops"]),
        );
        expect(cell(packed, bow)).toEqual({ x: 1, y: 14 });
        expect(occupied(packed)).toContainEqual({ x: 3, y: 12 });
        expect(occupied(packed)).not.toContainEqual({ x: 2, y: 14 });
        const nearest = bodies.reduce((best, body) => {
            const atCell = cell(packed, body);
            return Math.min(best, Math.max(Math.abs(atCell.x - 1), Math.abs(atCell.y - 14)));
        }, Infinity);
        expect(nearest).toBe(2);
    });

    test("Through Shot sits bows just inside the cannon files and does not clear the old file", () => {
        const short = piece("Short", RANGE, 5);
        const long = piece("Long", RANGE, 6.5);
        const screen = piece("Screen", MELEE);
        const units = [short, long, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 8 },
            { x: 3, y: 1 },
        ]);
        const next = placeArmyR5C1(placed, units, contextFor(units, ["Tsar Cannon"]));
        expect(cell(next, short)).toEqual({ x: 1, y: 3 });
        expect(cell(next, long)).toEqual({ x: 1, y: 12 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 1 });
        const breath = placeArmyR5C1(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(breath, long)).toEqual({ x: 1, y: 1 });
        expect(cell(breath, short)).toEqual({ x: 2, y: 7 });
    });

    test("a qualifying bow takes a short corner and the displaced bow leaves the back rank", () => {
        const short = piece("Short", RANGE, 5, { hp: 200 });
        const long = piece("Long", RANGE, 6.5, { hp: 1 });
        const units = [short, long];
        const next = placeArmyR5C1(
            at(units, [
                { x: 1, y: 1 },
                { x: 1, y: 8 },
            ]),
            units,
            contextFor(units, ["Peasant"]),
        );
        expect(cell(next, long)).toEqual({ x: 1, y: 1 });
        expect(cell(next, short)).toEqual({ x: 2, y: 7 });
        const off = [piece("Left", RANGE, 5), piece("Right", RANGE, 5)];
        const idle = at(off, [
            { x: 1, y: 7 },
            { x: 1, y: 8 },
        ]);
        expect(placeArmyR5C1(idle, off, contextFor(off, ["Peasant"]))).toEqual(idle);
        const reach9 = piece("Reach9", RANGE, 5.3);
        const held = piece("Held", RANGE, 6.5);
        const ranked = [reach9, held];
        const corners = [
            { x: 1, y: 1 },
            { x: 1, y: 14 },
        ];
        expect(cell(placeArmyR5C1(at(ranked, corners), ranked, contextFor(ranked, ["Peasant"])), reach9)).toEqual({
            x: 2,
            y: 7,
        });
        expect(cell(placeArmyR5C1(at(ranked, corners), ranked, contextFor(ranked, ["Elf"])), reach9)).toEqual({
            x: 3,
            y: 7,
        });
        expect(
            cell(placeArmyR5C1(at(ranked, corners), ranked, contextFor(ranked, ["Griffin", "Magic Dragon"])), reach9),
        ).toEqual({ x: 2, y: 7 });
    });

    test("equal short bows both leave the corners", () => {
        const left = piece("Left", RANGE, 5);
        const right = piece("Right", RANGE, 5);
        const units = [left, right];
        const next = placeArmyR5C1(
            at(units, [
                { x: 1, y: 1 },
                { x: 1, y: 14 },
            ]),
            units,
            contextFor(units, ["Peasant"]),
        );
        expect(sortedCells([cell(next, left), cell(next, right)])).toEqual([
            { x: 2, y: 7 },
            { x: 2, y: 8 },
        ]);
    });

    test("reach 10 stays on the middle rank and reach 9 steps to the front against one shooter", () => {
        const mid = piece("Mid", RANGE, 6);
        const front = piece("Front", RANGE, 5.3);
        const units = [mid, front];
        const next = placeArmyR5C1(
            at(units, [
                { x: 1, y: 1 },
                { x: 1, y: 14 },
            ]),
            units,
            contextFor(units, ["Elf"]),
        );
        expect(cell(next, mid)).toEqual({ x: 2, y: 7 });
        expect(cell(next, front)).toEqual({ x: 3, y: 7 });
    });

    test("a same-file guard steps straight ahead and skips protectors, chargers, and cannon files", () => {
        const bow = piece("Only", RANGE, 6);
        const low = piece("Pikeman", MELEE, 0, { hp: 40 });
        const abomination = piece("Abomination", MELEE, 0, { hp: 1 });
        const charger = piece("Charger", MELEE, 0, { hp: 2, abilities: ["Rapid Charge"] });
        const left = piece("LeftWing", MELEE, 0, { fly: true });
        const right = piece("RightWing", MELEE, 0, { fly: true });
        const units = [bow, low, abomination, charger, left, right];
        const placed = at(units, [
            { x: 2, y: 5 },
            { x: 3, y: 9 },
            { x: 3, y: 2 },
            { x: 3, y: 3 },
            { x: 3, y: 6 },
            { x: 3, y: 10 },
        ]);
        const next = placeArmyR5C1(placed, units, contextFor(units, ["Elf"]));
        expect(cell(next, bow)).toEqual({ x: 2, y: 5 });
        expect(cell(next, low)).toEqual({ x: 3, y: 5 });
        expect(cell(next, abomination)).toEqual({ x: 3, y: 2 });
        expect(cell(next, charger)).toEqual({ x: 3, y: 3 });

        const corner = piece("Corner", RANGE, 7.75);
        const other = piece("Other", RANGE, 6.5);
        const screen = piece("Screen", MELEE);
        const west = piece("West", MELEE, 0, { fly: true });
        const east = piece("East", MELEE, 0, { fly: true });
        const guarded = [corner, other, screen, west, east];
        const guardedAt = placeArmyR5C1(
            at(guarded, [
                { x: 1, y: 14 },
                { x: 1, y: 1 },
                { x: 3, y: 8 },
                { x: 3, y: 4 },
                { x: 3, y: 5 },
            ]),
            guarded,
            contextFor(guarded, ["Peasant"]),
        );
        expect(cell(guardedAt, corner)).toEqual({ x: 1, y: 14 });
        expect(cell(guardedAt, other)).toEqual({ x: 1, y: 1 });
        expect(cell(guardedAt, screen)).toEqual({ x: 2, y: 14 });

        const cannonBow = piece("Cannon", RANGE, 6);
        const cannonScreen = piece("File", MELEE);
        const cannonWest = piece("CannonWest", MELEE, 0, { fly: true });
        const cannonEast = piece("CannonEast", MELEE, 0, { fly: true });
        const cannonUnits = [cannonBow, cannonScreen, cannonWest, cannonEast];
        const cannon = placeArmyR5C1(
            at(cannonUnits, [
                { x: 1, y: 8 },
                { x: 3, y: 8 },
                { x: 3, y: 4 },
                { x: 3, y: 5 },
            ]),
            cannonUnits,
            contextFor(cannonUnits, ["Tsar Cannon"]),
        );
        expect(cell(cannon, cannonBow)).toEqual({ x: 1, y: 12 });
        expect(cell(cannon, cannonScreen)).toEqual({ x: 3, y: 8 });

        const quiet = [bow, low];
        const quietAt = at(quiet, [
            { x: 2, y: 5 },
            { x: 3, y: 9 },
        ]);
        expect(placeArmyR5C1(quietAt, quiet, contextFor(quiet, ["Elf"]))).toEqual(quietAt);
        const walled = placeArmyR5C1(placed, units, contextFor(units, ["Elf", "Monk"]));
        expect(cell(walled, low)).toEqual({ x: 3, y: 9 });
    });

    test("the right-hand zone uses frontness, not raw x", () => {
        const bow = piece("Bow", RANGE, 6, { team: RIGHT });
        const screen = piece("Screen", MELEE, 0, { team: RIGHT });
        const units = [bow, screen];
        const next = placeArmyR5C1(
            at(units, [
                { x: 13, y: 4 },
                { x: 12, y: 8 },
            ]),
            units,
            contextFor(units, ["Gargantuan"], RIGHT),
        );
        expect(cell(next, bow)).toEqual({ x: 14, y: 1 });
        expect(cell(next, screen)).toEqual({ x: 12, y: 14 });
        for (const lat of [1, 2, 3]) expect(occupied(next)).not.toContainEqual({ x: 12, y: lat });
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const bow = piece("Bow", RANGE, 6);
        const screen = piece("Screen", MELEE);
        const units = [bow, screen];
        const incumbent = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 8 },
        ]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: bow.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r5c1");
        const moved = strategy.placeArmy(units, contextFor(units, ["Gargantuan"]));
        expect(strategy.version).toBe("v0.8");
        expect(placements).toBe(1);
        expect(cell(moved, bow)).toEqual({ x: 1, y: 14 });
        expect(cell(moved, screen)).toEqual({ x: 3, y: 1 });
        expect(strategy.decideTurn(bow, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: bow.getId() },
        ]);
    });
});

describe("r5c3 blast bait, two files off the plug, or a three-wide shield", () => {
    test("no unlocked caster leaves the map", () => {
        const screen = melee("Screen");
        const alone = [screen];
        const aloneAt = at(alone, [{ x: 2, y: 6 }]);
        expect(placeArmyR5C3(aloneAt, alone, contextFor(alone, ["Gargantuan"]))).toEqual(aloneAt);

        const monk = caster("Monk");
        const dryad = caster("Dryad");
        const named = [monk, dryad, screen];
        const namedAt = at(named, [
            { x: 1, y: 6 },
            { x: 1, y: 8 },
            { x: 3, y: 7 },
        ]);
        expect(placeArmyR5C3(namedAt, named, contextFor(named, ["Cyclops"]))).toEqual(namedAt);

        const covered = caster("Ogre Mage");
        const angel = melee("Angel");
        const held = [covered, angel, screen];
        const heldAt = at(held, [
            { x: 1, y: 8 },
            { x: 1, y: 7 },
            { x: 3, y: 4 },
        ]);
        expect(placeArmyR5C3(heldAt, held, contextFor(held, ["Gargantuan"]))).toEqual(heldAt);
    });

    test("fireball, meteor, one flyer, and plain ground leave the map", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 2, y: 6 },
        ]);
        for (const enemy of ["Peasant", "Wandering Mage", "Magic Dragon", "Harpy"]) {
            expect(placeArmyR5C3(placed, units, contextFor(units, [enemy]))).toEqual(placed);
        }
    });

    test("Area Throw baits the front centre and isolates the caster", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const near = melee("Near");
        const far = melee("Far");
        const bow = makeUnit("Bow", RANGE, 6);
        const guard = melee("Guard");
        const units = [mage, screen, near, far, bow, guard];
        const placed = at(units, [
            { x: 2, y: 6 },
            { x: 3, y: 8 },
            { x: 2, y: 5 },
            { x: 1, y: 13 },
            { x: 1, y: 14 },
            { x: 2, y: 1 },
        ]);
        for (const opponents of [["Gargantuan"], ["Gargantuan", "Cyclops"]]) {
            const next = placeArmyR5C3(placed, units, contextFor(units, opponents));
            expect(cell(next, screen)).toEqual({ x: 3, y: 7 });
            expect(cell(next, near)).toEqual({ x: 3, y: 6 });
            expect(cell(next, mage)).toEqual({ x: 1, y: 4 });
            expect(cell(next, far)).toEqual({ x: 1, y: 13 });
            expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
            expect(cell(next, guard)).toEqual({ x: 2, y: 1 });
        }
    });

    test("Large Caliber slides the caster away from every footprint and steps the screen inward", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 2, y: 6 },
        ]);
        const next = placeArmyR5C3(placed, units, contextFor(units, ["Cyclops", "Black Dragon"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 13 });
        expect(cell(next, screen)).toEqual({ x: 2, y: 7 });
    });

    test("Large Caliber keeps the caster when no back cell is three away", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const low = melee("Low");
        const mid = melee("Mid");
        const high = melee("High");
        const edge = melee("Edge");
        const units = [mage, screen, low, mid, high, edge];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 2, y: 8 },
            { x: 2, y: 2 },
            { x: 2, y: 5 },
            { x: 2, y: 11 },
            { x: 2, y: 13 },
        ]);
        const next = placeArmyR5C3(placed, units, contextFor(units, ["Cyclops"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 8 });
        expect(cell(next, screen)).toEqual({ x: 2, y: 7 });
        expect(cell(next, low)).toEqual({ x: 2, y: 2 });
        expect(cell(next, high)).toEqual({ x: 2, y: 11 });
    });

    test("a plug stays and the caster moves two files off it", () => {
        const mage = caster("Battle Mage");
        const plug = melee("Plug");
        const screen = melee("Screen");
        const units = [mage, plug, screen];
        const placed = at(units, [
            { x: 1, y: 5 },
            { x: 3, y: 5 },
            { x: 1, y: 12 },
        ]);
        for (const enemy of ["Black Dragon", "Pikeman", "Tsar Cannon"]) {
            const next = placeArmyR5C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, plug)).toEqual({ x: 3, y: 5 });
            expect(cell(next, mage)).toEqual({ x: 1, y: 7 });
            expect(cell(next, screen)).toEqual({ x: 2, y: 6 });
            expect([...next.values()]).not.toContainEqual({ x: 1, y: 6 });
        }
        const pair = [mage, plug];
        const pairAt = at(pair, [
            { x: 1, y: 5 },
            { x: 3, y: 5 },
        ]);
        const shifted = placeArmyR5C3(pairAt, pair, contextFor(pair, ["Black Dragon"]));
        expect(cell(shifted, plug)).toEqual({ x: 3, y: 5 });
        expect(cell(shifted, mage)).toEqual({ x: 1, y: 7 });
        const open = [mage, screen];
        const openAt = at(open, [
            { x: 1, y: 5 },
            { x: 2, y: 8 },
        ]);
        expect(placeArmyR5C3(openAt, open, contextFor(open, ["Black Dragon"]))).toEqual(openAt);
    });

    test("spin, chakram, and chain lightning swap halves without moving other files", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const bow = makeUnit("Bow", RANGE, 6);
        const units = [mage, screen, bow];
        const placed = at(units, [
            { x: 2, y: 4 },
            { x: 3, y: 5 },
            { x: 1, y: 14 },
        ]);
        for (const enemy of ["Hydra", "Zena", "Thunderbird"]) {
            const next = placeArmyR5C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, mage)).toEqual({ x: 1, y: 4 });
            expect(cell(next, screen)).toEqual({ x: 3, y: 8 });
            expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        }
    });

    test("two flyers put a back caster on the front and the screen on the vacated cell", () => {
        const corner = caster("Battle Mage");
        const mage = caster("Ogre Mage");
        const screen = melee("Screen");
        const units = [corner, mage, screen];
        const placed = at(units, [
            { x: 1, y: 1 },
            { x: 1, y: 6 },
            { x: 3, y: 10 },
        ]);
        const next = placeArmyR5C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, corner)).toEqual({ x: 1, y: 1 });
        expect(cell(next, mage)).toEqual({ x: 3, y: 6 });
        expect(cell(next, screen)).toEqual({ x: 1, y: 6 });
        expect([...next.values()]).not.toContainEqual({ x: 2, y: 6 });
    });

    test("two shooters build a three-wide middle shield and fewer bodies change nothing", () => {
        const mage = caster("Battle Mage");
        const left = melee("LeftBody");
        const centre = melee("CentreBody");
        const right = melee("RightBody");
        const bow = makeUnit("Bow", RANGE, 6);
        const units = [mage, left, centre, right, bow];
        const placed = at(units, [
            { x: 2, y: 8 },
            { x: 3, y: 3 },
            { x: 3, y: 4 },
            { x: 3, y: 12 },
            { x: 1, y: 14 },
        ]);
        const next = placeArmyR5C3(placed, units, contextFor(units, ["Elf", "Medusa"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 8 });
        expect(sortedCells([cell(next, left), cell(next, centre), cell(next, right)])).toEqual([
            { x: 2, y: 7 },
            { x: 2, y: 8 },
            { x: 2, y: 9 },
        ]);
        expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
        expect([...next.values()]).not.toContainEqual({ x: 1, y: 7 });
        expect([...next.values()]).not.toContainEqual({ x: 1, y: 9 });

        const short = [mage, left, centre];
        const shortAt = at(short, [
            { x: 2, y: 8 },
            { x: 3, y: 3 },
            { x: 3, y: 4 },
        ]);
        expect(placeArmyR5C3(shortAt, short, contextFor(short, ["Elf", "Medusa"]))).toEqual(shortAt);
        const blasted = placeArmyR5C3(placed, units, contextFor(units, ["Elf", "Medusa", "Wandering Mage"]));
        expect(blasted).toEqual(placed);
    });

    test("the right seat mirrors the bait", () => {
        const RIGHT = PBTypes.TeamVals.RIGHT;
        const mage = createTestUnit({
            name: "Battle Mage",
            team: RIGHT,
            attackType: MELEE,
            spells: ["Chaos:Fire Strike"],
        });
        const screen = createTestUnit({ name: "Screen", team: RIGHT, attackType: MELEE });
        const units = [mage, screen];
        const placed = at(units, [
            { x: 13, y: 6 },
            { x: 12, y: 10 },
        ]);
        const next = placeArmyR5C3(placed, units, contextFor(units, ["Gargantuan"], RIGHT));
        expect(cell(next, mage)).toEqual({ x: 14, y: 4 });
        expect(cell(next, screen)).toEqual({ x: 12, y: 7 });
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const mage = caster("Battle Mage");
        const screen = melee("Screen");
        const units = [mage, screen];
        const incumbent = at(units, [
            { x: 2, y: 6 },
            { x: 3, y: 8 },
        ]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: mage.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r5c3");
        const moved = strategy.placeArmy(units, contextFor(units, ["Gargantuan"]));
        expect(strategy.version).toBe("v0.8");
        expect(placements).toBe(1);
        expect(cell(moved, mage)).toEqual({ x: 1, y: 4 });
        expect(cell(moved, screen)).toEqual({ x: 3, y: 7 });
        expect(strategy.decideTurn(mage, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: mage.getId() },
        ]);
    });
});

const hpStack = (
    name: string,
    hp: number,
    options: {
        attackType?: number;
        spells?: string[];
        abilities?: string[];
        movementType?: number;
        team?: PBTypes.TeamVals;
        footprintWidth?: number;
        footprintHeight?: number;
    } = {},
): Unit =>
    createTestUnit({
        name,
        team: options.team ?? LEFT,
        size: options.footprintWidth && options.footprintWidth > 1 ? PBTypes.UnitSizeVals.LARGE : undefined,
        maxHp: hp,
        attackType: options.attackType ?? MELEE,
        spells: options.spells,
        abilities: options.abilities,
        movementType: options.movementType,
        footprintWidth: options.footprintWidth,
        footprintHeight: options.footprintHeight,
    });

const wardOf = (name: string, hp: number, team: PBTypes.TeamVals = LEFT): Unit =>
    hpStack(name, hp, { team, spells: ["Chaos:Fire Strike"] });

describe("r6c3 screen on the ray, ward outside the landing", () => {
    test("other rosters, a flying caster, and no screen leave the map", () => {
        const mage = wardOf("Battle Mage", 40);
        const screen = hpStack("Screen", 30);
        const units = [mage, screen];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 8 },
        ]);
        for (const enemy of ["Peasant", "Hydra", "Harpy", "Wandering Mage"]) {
            expect(placeArmyR6C3(placed, units, contextFor(units, [enemy]))).toEqual(placed);
        }
        const flying = hpStack("Battle Mage", 40, { spells: ["Chaos:Fire Strike"], movementType: FLY });
        const flyers = [flying, screen];
        const flyAt = at(flyers, [
            { x: 1, y: 6 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR6C3(flyAt, flyers, contextFor(flyers, ["Gargantuan"]))).toEqual(flyAt);
        const large = hpStack("Ogre Mage", 80, {
            spells: ["Chaos:Fire Strike"],
            footprintWidth: 2,
            footprintHeight: 2,
        });
        const wide = [large, screen];
        const wideAt = at(wide, [
            { x: 2, y: 6 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR6C3(wideAt, wide, contextFor(wide, ["Gargantuan"]))).toEqual(wideAt);
        const alone = [screen];
        const aloneAt = at(alone, [{ x: 3, y: 6 }]);
        expect(placeArmyR6C3(aloneAt, alone, contextFor(alone, ["Gargantuan"]))).toEqual(aloneAt);
    });

    test("Area Throw puts the highest screen on the ward file and keeps the middle empty", () => {
        const mage = wardOf("Battle Mage", 40);
        const high = hpStack("High", 100);
        const low = hpStack("Low", 10);
        const charger = hpStack("Charger", 200, { abilities: ["Rapid Charge"] });
        const bow = hpStack("Bow", 20, { attackType: RANGE });
        const dryad = hpStack("Dryad", 15, { attackType: RANGE });
        const angel = hpStack("Angel", 90);
        const units = [mage, high, low, charger, bow, dryad, angel];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 12 },
            { x: 2, y: 6 },
            { x: 3, y: 8 },
            { x: 1, y: 14 },
            { x: 1, y: 13 },
            { x: 3, y: 14 },
        ]);
        for (const opponents of [["Gargantuan"], ["Gargantuan", "Cyclops", "Black Dragon"]]) {
            const next = placeArmyR6C3(placed, units, contextFor(units, opponents));
            expect(cell(next, mage)).toEqual({ x: 1, y: 6 });
            expect(cell(next, high)).toEqual({ x: 3, y: 6 });
            expect(cell(next, low)).toEqual({ x: 3, y: 3 });
            expect(cell(next, charger)).toEqual({ x: 3, y: 8 });
            expect(cell(next, bow)).toEqual({ x: 1, y: 14 });
            expect(cell(next, dryad)).toEqual({ x: 1, y: 13 });
            expect(cell(next, angel)).toEqual({ x: 3, y: 14 });
            expect([...next.values()]).not.toContainEqual({ x: 2, y: 6 });
        }
    });

    test("a second Area Throw ward repeats at least four files away", () => {
        const first = wardOf("Monk", 80);
        const second = wardOf("Battle Mage", 70);
        const high = hpStack("High", 50);
        const low = hpStack("Low", 20);
        const units = [first, second, high, low];
        const placed = at(units, [
            { x: 1, y: 4 },
            { x: 1, y: 12 },
            { x: 3, y: 9 },
            { x: 2, y: 2 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Gargantuan"]));
        expect(cell(next, first)).toEqual({ x: 1, y: 4 });
        expect(cell(next, high)).toEqual({ x: 3, y: 4 });
        expect(cell(next, second)).toEqual({ x: 1, y: 12 });
        expect(cell(next, low)).toEqual({ x: 3, y: 12 });
        expect([...next.values()]).not.toContainEqual({ x: 2, y: 4 });
        expect([...next.values()]).not.toContainEqual({ x: 2, y: 12 });
    });

    test("Large Caliber seats the ward on a front corner and steps a ring screen out", () => {
        const mage = wardOf("Battle Mage", 40);
        const screen = hpStack("Screen", 30);
        const units = [mage, screen];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 2, y: 2 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Cyclops"]));
        expect(cell(next, mage)).toEqual({ x: 3, y: 1 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 4 });
        for (const blocked of [
            { x: 3, y: 2 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
        ]) {
            expect([...next.values()]).not.toContainEqual(blocked);
        }
    });

    test("a locked body in the near ring sends the ward to the other corner", () => {
        const mage = wardOf("Battle Mage", 40);
        const screen = hpStack("Screen", 30);
        const dryad = hpStack("Dryad", 12, { attackType: RANGE });
        const units = [mage, screen, dryad];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 8 },
            { x: 2, y: 1 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Cyclops", "Black Dragon"]));
        expect(cell(next, mage)).toEqual({ x: 3, y: 14 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 8 });
        expect(cell(next, dryad)).toEqual({ x: 2, y: 1 });
    });

    test("breath, skewer, and through shot share the two-lateral screen", () => {
        const ward = wardOf("Battle Mage", 50);
        const other = wardOf("Monk", 40);
        const high = hpStack("High", 30);
        const low = hpStack("Low", 20);
        const units = [ward, other, high, low];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 1, y: 4 },
            { x: 2, y: 11 },
            { x: 3, y: 7 },
        ]);
        for (const enemy of ["Black Dragon", "Pikeman", "Tsar Cannon"]) {
            const next = placeArmyR6C3(placed, units, contextFor(units, [enemy]));
            expect(cell(next, ward)).toEqual({ x: 1, y: 8 });
            expect(cell(next, high)).toEqual({ x: 3, y: 10 });
            expect(cell(next, other)).toEqual({ x: 1, y: 4 });
            expect(cell(next, low)).toEqual({ x: 3, y: 2 });
            for (const blocked of [
                { x: 2, y: 8 },
                { x: 3, y: 8 },
                { x: 2, y: 10 },
                { x: 2, y: 4 },
                { x: 3, y: 4 },
                { x: 2, y: 2 },
                { x: 2, y: 9 },
                { x: 3, y: 9 },
            ]) {
                expect([...next.values()]).not.toContainEqual(blocked);
            }
        }
    });

    test("a spare body leaves the breath cell", () => {
        const ward = wardOf("Battle Mage", 40);
        const screen = hpStack("Screen", 30);
        const blocker = hpStack("Blocker", 12);
        const units = [ward, screen, blocker];
        const placed = at(units, [
            { x: 1, y: 8 },
            { x: 3, y: 4 },
            { x: 2, y: 10 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Black Dragon"]));
        expect(cell(next, ward)).toEqual({ x: 1, y: 8 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 10 });
        expect(cell(next, blocker)).toEqual({ x: 1, y: 9 });
        expect([...next.values()]).not.toContainEqual({ x: 2, y: 10 });
    });

    test("two flyers cap the back of a middle-rank ward and avoid the corner shoulder", () => {
        const mage = wardOf("Battle Mage", 40);
        const rear = hpStack("Rear", 30);
        const side = hpStack("Side", 20);
        const bow = hpStack("Bow", 15, { attackType: RANGE });
        const units = [mage, rear, side, bow];
        const placed = at(units, [
            { x: 1, y: 2 },
            { x: 3, y: 8 },
            { x: 3, y: 10 },
            { x: 1, y: 1 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Harpy", "Griffin"]));
        expect(cell(next, mage)).toEqual({ x: 2, y: 2 });
        expect(cell(next, rear)).toEqual({ x: 1, y: 2 });
        expect(cell(next, side)).toEqual({ x: 2, y: 3 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 1 });
        const offBack = wardOf("Ogre Mage", 40);
        const offUnits = [offBack, rear];
        const offAt = at(offUnits, [
            { x: 2, y: 6 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR6C3(offAt, offUnits, contextFor(offUnits, ["Harpy", "Griffin"]))).toEqual(offAt);
        const bulky = hpStack("Bulky", 80, { footprintWidth: 2, footprintHeight: 2 });
        const bulkyUnits = [mage, bulky];
        const bulkyAt = at(bulkyUnits, [
            { x: 1, y: 6 },
            { x: 3, y: 8 },
        ]);
        expect(placeArmyR6C3(bulkyAt, bulkyUnits, contextFor(bulkyUnits, ["Harpy", "Griffin"]))).toEqual(bulkyAt);
    });

    test("a second flyer pocket is built only when two further screens remain", () => {
        const low = wardOf("Battle Mage", 100);
        const high = wardOf("Monk", 90);
        const rear = hpStack("Rear", 40);
        const side = hpStack("Side", 30);
        const rear2 = hpStack("Rear2", 20);
        const side2 = hpStack("Side2", 10);
        const units = [low, high, rear, side, rear2, side2];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 1, y: 10 },
            { x: 3, y: 12 },
            { x: 3, y: 11 },
            { x: 3, y: 4 },
            { x: 3, y: 3 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Harpy", "Wyvern"]));
        expect(cell(next, low)).toEqual({ x: 2, y: 6 });
        expect(cell(next, rear)).toEqual({ x: 1, y: 6 });
        expect(cell(next, side)).toEqual({ x: 2, y: 7 });
        expect(cell(next, high)).toEqual({ x: 2, y: 10 });
        expect(cell(next, rear2)).toEqual({ x: 1, y: 10 });
        expect(cell(next, side2)).toEqual({ x: 2, y: 9 });
    });

    test("two shooters keep a same-file gap and park other screens three files away", () => {
        const mage = wardOf("Battle Mage", 40);
        const high = hpStack("High", 35);
        const low = hpStack("Low", 15);
        const dryad = hpStack("Dryad", 10, { attackType: RANGE });
        const bow = hpStack("Bow", 12, { attackType: RANGE });
        const units = [mage, high, low, dryad, bow];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 10 },
            { x: 3, y: 4 },
            { x: 1, y: 12 },
            { x: 1, y: 13 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Elf", "Medusa", "Hydra"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 6 });
        expect(cell(next, high)).toEqual({ x: 3, y: 6 });
        expect(cell(next, low)).toEqual({ x: 3, y: 3 });
        expect(cell(next, dryad)).toEqual({ x: 1, y: 12 });
        expect(cell(next, bow)).toEqual({ x: 1, y: 13 });
        expect([...next.values()]).not.toContainEqual({ x: 2, y: 6 });
        const blasted = placeArmyR6C3(placed, units, contextFor(units, ["Elf", "Medusa", "Wandering Mage"]));
        expect(blasted).toEqual(placed);
    });

    test("Chakram splits the pair to Chebyshev 4 instead of leaving the empty-file bridge", () => {
        const mage = wardOf("Battle Mage", 40);
        const screen = hpStack("Screen", 30);
        const units = [mage, screen];
        const placed = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 6 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Zena", "Elf"]));
        expect(cell(next, mage)).toEqual({ x: 1, y: 6 });
        expect(cell(next, screen)).toEqual({ x: 3, y: 2 });
        const separation = Math.max(Math.abs(1 - 3), Math.abs(6 - 2));
        expect(separation).toBeGreaterThanOrEqual(4);
        expect(cell(next, mage).y).not.toBe(cell(next, screen).y);
    });

    test("the right seat mirrors the ray", () => {
        const RIGHT = PBTypes.TeamVals.RIGHT;
        const mage = wardOf("Battle Mage", 40, RIGHT);
        const screen = hpStack("Screen", 30, { team: RIGHT });
        const units = [mage, screen];
        const placed = at(units, [
            { x: 14, y: 6 },
            { x: 12, y: 10 },
        ]);
        const next = placeArmyR6C3(placed, units, contextFor(units, ["Gargantuan"], RIGHT));
        expect(cell(next, mage)).toEqual({ x: 14, y: 6 });
        expect(cell(next, screen)).toEqual({ x: 12, y: 6 });
        expect([...next.values()]).not.toContainEqual({ x: 13, y: 6 });
    });

    test("the wrapper keeps combat and only replaces placeArmy", () => {
        const mage = wardOf("Battle Mage", 40);
        const screen = hpStack("Screen", 30);
        const units = [mage, screen];
        const incumbent = at(units, [
            { x: 1, y: 6 },
            { x: 3, y: 10 },
        ]);
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                placements += 1;
                return incumbent;
            },
            decideTurn: () => [{ type: "defend_turn", unitId: mage.getId() }],
        };
        const strategy = new PlacementLiftStrategy(base, "r6c3");
        const moved = strategy.placeArmy(units, contextFor(units, ["Gargantuan"]));
        expect(strategy.version).toBe("v0.8");
        expect(placements).toBe(1);
        expect(cell(moved, mage)).toEqual({ x: 1, y: 6 });
        expect(cell(moved, screen)).toEqual({ x: 3, y: 6 });
        expect(strategy.decideTurn(mage, {} as IDecisionContext)).toEqual([
            { type: "defend_turn", unitId: mage.getId() },
        ]);
    });
});
