/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import {
    ArmorAugment,
    MightAugment,
    MovementAugment,
    SniperAugment,
} from "../../src/augments/augment_properties";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { SquarePlacement } from "../../src/grid/square_placement";
import { LifeSynergy, SynergyLevel } from "../../src/synergies/synergy_properties";
import type { Unit } from "../../src/units/unit";
import type { UnitProperties } from "../../src/units/unit_properties";
import { getDistance } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("UnitsHolder", () => {
    it("indexes units by team and exposes team/enemy stat maps", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const lower = createTestUnit({
            name: "Lower Scout",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 20,
            magicResist: 5,
            movementType: PBTypes.MovementVals.FLY,
        });
        const lowerWalker = createTestUnit({
            name: "Lower Walker",
            team: PBTypes.TeamVals.LOWER,
            maxHp: 12,
            magicResist: 2,
        });
        const upper = createTestUnit({
            name: "Upper Guard",
            team: PBTypes.TeamVals.UPPER,
            maxHp: 30,
            magicResist: 7,
        });

        placeUnit(grid, unitsHolder, lower, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, lowerWalker, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, upper, { x: 14, y: 14 });

        expect(Array.from(unitsHolder.getAllUnitsIterator()).map((unit) => unit.getId())).toEqual([
            lower.getId(),
            lowerWalker.getId(),
            upper.getId(),
        ]);
        expect(unitsHolder.getAllEnemyUnits(PBTypes.TeamVals.LOWER).map((unit) => unit.getId())).toEqual([
            upper.getId(),
        ]);
        expect(unitsHolder.getAllAllies(PBTypes.TeamVals.LOWER).map((unit) => unit.getId())).toEqual([
            lower.getId(),
            lowerWalker.getId(),
        ]);
        expect(unitsHolder.getAllTeamUnitsBuffs(PBTypes.TeamVals.LOWER).get(lower.getId())).toEqual([]);
        expect(unitsHolder.getAllEnemyUnitsBuffs(PBTypes.TeamVals.LOWER).get(upper.getId())).toEqual([]);
        expect(unitsHolder.getAllEnemyUnitsDebuffs(PBTypes.TeamVals.LOWER).get(upper.getId())).toEqual([]);
        expect(unitsHolder.getAllTeamUnitsCanFly(PBTypes.TeamVals.LOWER)).toEqual(
            new Map([
                [lower.getId(), true],
                [lowerWalker.getId(), false],
            ]),
        );
        expect(unitsHolder.getAllEnemyUnitsCanFly(PBTypes.TeamVals.LOWER)).toEqual(new Map([[upper.getId(), false]]));
        expect(unitsHolder.getAllTeamUnitsMagicResist(PBTypes.TeamVals.LOWER)).toEqual(
            new Map([
                [lower.getId(), 5],
                [lowerWalker.getId(), 2],
            ]),
        );
        expect(unitsHolder.getAllEnemyUnitsMagicResist(PBTypes.TeamVals.LOWER)).toEqual(new Map([[upper.getId(), 7]]));
        expect(unitsHolder.getAllTeamUnitsHp(PBTypes.TeamVals.LOWER)).toEqual(
            new Map([
                [lower.getId(), 20],
                [lowerWalker.getId(), 12],
            ]),
        );
        expect(unitsHolder.getAllTeamUnitsMaxHp(PBTypes.TeamVals.LOWER)).toEqual(
            new Map([
                [lower.getId(), 20],
                [lowerWalker.getId(), 12],
            ]),
        );
        expect(unitsHolder.getUnitByStats(undefined as unknown as UnitProperties)).toBeUndefined();
        expect(unitsHolder.getUnitByStats(lower.getUnitProperties() as UnitProperties)).toBe(lower);
        expect(flatUnitIds(unitsHolder.refreshUnitsForAllTeams()).sort()).toEqual(
            [lower.getId(), lowerWalker.getId(), upper.getId()].sort(),
        );
    });

    it("filters placed allies and selects the lowest-power units for cleanup", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const lowerLeft = new SquarePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const upperRight = new SquarePlacement(testGridSettings, PlacementPositionType.UPPER_RIGHT, 3);
        const lowerA = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const lowerB = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const lowerC = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const lowerOutside = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const upper = createTestUnit({ team: PBTypes.TeamVals.UPPER });

        lowerA.setStackPower(3);
        lowerB.setStackPower(1);
        lowerC.setStackPower(2);

        placeUnit(grid, unitsHolder, lowerA, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, lowerB, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, lowerC, { x: 3, y: 1 });
        placeUnit(grid, unitsHolder, lowerOutside, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, upper, { x: 14, y: 14 });

        expect(
            unitsHolder
                .getAllAlliesPlaced(PBTypes.TeamVals.LOWER, lowerLeft, upperRight)
                .map((unit) => unit.getId()),
        ).toEqual([lowerA.getId(), lowerB.getId(), lowerC.getId()]);
        expect(
            unitsHolder
                .getAllAlliesPlaced(PBTypes.TeamVals.UPPER, lowerLeft, upperRight)
                .map((unit) => unit.getId()),
        ).toEqual([upper.getId()]);
        expect(unitsHolder.toCleanupRandomUnitsTillTeamSize(5, PBTypes.TeamVals.LOWER, lowerLeft, upperRight)).toEqual(
            [],
        );
        expect(
            unitsHolder
                .toCleanupRandomUnitsTillTeamSize(1, PBTypes.TeamVals.LOWER, lowerLeft, upperRight)
                .map((unit) => unit.getId()),
        ).toEqual([lowerB.getId(), lowerC.getId()]);
        expect(
            unitsHolder
                .toCleanupRandomUnitsTillTeamSize(-1, PBTypes.TeamVals.LOWER, lowerLeft, upperRight)
                .map((unit) => unit.getId()),
        ).toEqual([lowerB.getId(), lowerC.getId(), lowerA.getId()]);
    });

    it("tracks distances to closest enemies and adjacent enemy queries", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const lower = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const upperAdjacent = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        const upperFar = createTestUnit({ team: PBTypes.TeamVals.UPPER });

        placeUnit(grid, unitsHolder, lower, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, upperAdjacent, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, upperFar, { x: 12, y: 12 });

        expect(unitsHolder.allEnemiesAroundUnit(lower, true, { x: 5, y: 5 })).toEqual([upperAdjacent]);
        expect(unitsHolder.allEnemiesAroundUnit(lower, false)).toEqual([upperAdjacent]);
        expect(unitsHolder.allEnemiesAroundUnit(lower, true)).toEqual([]);
        expect(unitsHolder.getNumberOfEnemiesWithinRange(lower, 1)).toBe(1);
        expect(unitsHolder.getUnitAuraAttackMod(lower)).toBe(0);
        expect(unitsHolder.getDistanceToClosestEnemy(PBTypes.TeamVals.UPPER, lower.getPosition())).toBeGreaterThan(0);
        expect(unitsHolder.haveDistancesToClosestEnemiesDecreased()).toBe(true);
        expect(unitsHolder.haveDistancesToClosestEnemiesDecreased()).toBe(false);

        lower.setPosition(positionForCell({ x: 5, y: 5 }).x, positionForCell({ x: 5, y: 5 }).y);
        upperAdjacent.setPosition(positionForCell({ x: 5, y: 5 }).x, positionForCell({ x: 5, y: 5 }).y);

        expect(unitsHolder.haveDistancesToClosestEnemiesDecreased()).toBe(true);
    });

    it("removes units from holder, grid, and fight queues", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const unitCell = { x: 2, y: 2 };
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, unit, unitCell);
        fightProperties.enqueueUpNext(unit.getId());
        fightProperties.enqueueMoralePlus(unit.getId());
        fightProperties.enqueueMoraleMinus(unit.getId());
        fightProperties.enqueueHourglass(unit.getId());

        expect(unitsHolder.deleteUnitById("")).toBe(false);
        expect(unitsHolder.deleteUnitById(unit.getId())).toBe(true);
        expect(unitsHolder.getAllUnits().has(unit.getId())).toBe(false);
        expect(grid.getOccupantUnitId(unitCell)).toBe("");
        expect(fightProperties.upNextIncludes(unit.getId())).toBe(false);
        expect(fightProperties.moralePlusIncludes(unit.getId())).toBe(false);
        expect(fightProperties.moraleMinusIncludes(unit.getId())).toBe(false);
        expect(fightProperties.hourglassIncludes(unit.getId())).toBe(false);
        expect(unitsHolder.deleteUnitById("missing")).toBe(true);
    });

    it("deletes units that are outside allowed placement", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const lowerLeft = new SquarePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const upperRight = new SquarePlacement(testGridSettings, PlacementPositionType.UPPER_RIGHT, 3);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LOWER });

        placeUnit(grid, unitsHolder, unit, { x: 1, y: 1 });

        expect(unitsHolder.deleteUnitIfNotAllowed(unit.getId(), lowerLeft, upperRight)).toBe(false);
        expect(unitsHolder.deleteUnitIfNotAllowed(unit.getId(), undefined, upperRight)).toBe(true);
        expect(unitsHolder.getAllUnits().has(unit.getId())).toBe(false);
        expect(unitsHolder.deleteUnitIfNotAllowed("missing", lowerLeft, upperRight)).toBe(true);
    });

    it("finds summoned units by name and team", () => {
        const { unitsHolder } = createCombatTestContext();
        const summoned = createTestUnit({
            name: "Wolf",
            team: PBTypes.TeamVals.LOWER,
            summoned: true,
        });
        const regular = createTestUnit({
            name: "Wolf",
            team: PBTypes.TeamVals.UPPER,
            summoned: false,
        });

        unitsHolder.addUnit(summoned);
        unitsHolder.addUnit(regular);

        expect(unitsHolder.getSummonedUnitByName(PBTypes.TeamVals.LOWER, "Wolf")).toBe(summoned);
        expect(unitsHolder.getSummonedUnitByName(PBTypes.TeamVals.UPPER, "Wolf")).toBeUndefined();
        expect(unitsHolder.getSummonedUnitByName(PBTypes.TeamVals.LOWER, "")).toBeUndefined();
    });

    it("applies pre-fight supply synergy and skips it after fight start", () => {
        const { unitsHolder } = createCombatTestContext();
        const unit = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            amountAlive: 10,
        });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        unitsHolder.addUnit(unit);
        fightProperties.setSynergyUnitsPerFactions(PBTypes.TeamVals.LOWER, 6, 0, 0, 0);
        fightProperties.updateSynergyPerTeam(
            PBTypes.TeamVals.LOWER,
            PBTypes.FactionVals.LIFE,
            LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
            SynergyLevel.LEVEL_3,
        );

        unitsHolder.increaseUnitsSupplyIfNeededPerTeam(PBTypes.TeamVals.LOWER);

        expect(unit.getAmountAlive()).toBe(11);

        fightProperties.startFight();
        unitsHolder.increaseUnitsSupplyIfNeededPerTeam(PBTypes.TeamVals.LOWER);

        expect(unit.getAmountAlive()).toBe(11);
    });

    it("applies configured augment buffs to placed units", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const ranged = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        const melee = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, ranged, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, melee, { x: 3, y: 2 });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
            type: "Armor",
            value: ArmorAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
            type: "Might",
            value: MightAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
            type: "Sniper",
            value: SniperAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LOWER, {
            type: "Movement",
            value: MovementAugment.LEVEL_1,
        });

        unitsHolder.applyAugments();

        expect(ranged.hasBuffActive("Armor Augment")).toBe(true);
        expect(ranged.hasBuffActive("Might Augment")).toBe(true);
        expect(ranged.hasBuffActive("Sniper Augment")).toBe(true);
        expect(ranged.hasBuffActive("Movement Augment")).toBe(true);
        expect(melee.hasBuffActive("Armor Augment")).toBe(true);
        expect(melee.hasBuffActive("Might Augment")).toBe(true);
        expect(melee.hasBuffActive("Sniper Augment")).toBe(false);
        expect(melee.hasBuffActive("Movement Augment")).toBe(true);
    });

    it("refreshes stack power for all placed units", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const lower = createTestUnit({ team: PBTypes.TeamVals.LOWER, amountAlive: 1, exp: 1 });
        const upper = createTestUnit({ team: PBTypes.TeamVals.UPPER, amountAlive: 5, exp: 1 });

        placeUnit(grid, unitsHolder, lower, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, upper, { x: 12, y: 12 });

        unitsHolder.refreshStackPowerForAllUnits();

        expect(lower.getStackPower()).toBe(1);
        expect(upper.getStackPower()).toBe(5);
    });

    it("refreshes aura effects for allies and enemies while keeping the strongest duplicate aura", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const weakAuraSource = createTestUnit({
            name: "Weak Aura",
            team: PBTypes.TeamVals.LOWER,
            auraEffects: ["Sharpened Weapons"],
            stackPower: 1,
        });
        const strongAuraSource = createTestUnit({
            name: "Strong Aura",
            team: PBTypes.TeamVals.LOWER,
            auraEffects: ["Sharpened Weapons", "Range Null Field"],
            stackPower: 10,
        });
        const meleeAlly = createTestUnit({
            name: "Melee Ally",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.MELEE,
        });
        const rangedEnemy = createTestUnit({
            name: "Ranged Enemy",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
        });
        const meleeEnemy = createTestUnit({
            name: "Melee Enemy",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
        });

        placeUnit(grid, unitsHolder, weakAuraSource, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, strongAuraSource, { x: 3, y: 2 });
        placeUnit(grid, unitsHolder, meleeAlly, { x: 4, y: 2 });
        placeUnit(grid, unitsHolder, rangedEnemy, { x: 4, y: 3 });
        placeUnit(grid, unitsHolder, meleeEnemy, { x: 4, y: 4 });

        unitsHolder.refreshAuraEffectsForAllUnits();

        expect(meleeAlly.hasBuffActive("Sharpened Weapons Aura")).toBe(true);
        expect(meleeAlly.getBuff("Sharpened Weapons Aura")?.getPower()).toBe(18);
        expect(rangedEnemy.hasDebuffActive("Range Null Field Aura")).toBe(true);
        expect(meleeEnemy.hasDebuffActive("Range Null Field Aura")).toBe(false);
    });
});

describe("UnitsHolder.getDistanceToEnemyCentroid", () => {
    it("returns MAX_SAFE_INTEGER when there are no enemies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const ally = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 3 });

        // No UPPER units exist, so there is no enemy centroid.
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.UPPER, positionForCell({ x: 3, y: 3 }))).toBe(
            Number.MAX_SAFE_INTEGER,
        );
    });

    it("equals the distance to the only enemy when there is exactly one", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        const from = positionForCell({ x: 2, y: 2 });
        // With a single enemy the centroid coincides with the closest-enemy metric.
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.UPPER, from)).toBeCloseTo(
            getDistance(from, enemy.getPosition()),
        );
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.UPPER, from)).toBeCloseTo(
            unitsHolder.getDistanceToClosestEnemy(PBTypes.TeamVals.UPPER, from),
        );
    });

    it("measures distance to the average position of all enemies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const e1 = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "E1" });
        const e2 = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "E2" });
        placeUnit(grid, unitsHolder, e1, { x: 2, y: 8 });
        placeUnit(grid, unitsHolder, e2, { x: 8, y: 8 });

        const from = positionForCell({ x: 5, y: 2 });
        const centroid = {
            x: (e1.getPosition().x + e2.getPosition().x) / 2,
            y: (e1.getPosition().y + e2.getPosition().y) / 2,
        };
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.UPPER, from)).toBeCloseTo(
            getDistance(from, centroid),
        );
    });

    it("ignores friendly units", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const enemy = createTestUnit({ team: PBTypes.TeamVals.UPPER });
        const ally = createTestUnit({ team: PBTypes.TeamVals.LOWER });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, ally, { x: 1, y: 1 });

        const from = positionForCell({ x: 4, y: 4 });
        // Only the UPPER enemy counts; the LOWER ally must not move the centroid.
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.UPPER, from)).toBeCloseTo(
            getDistance(from, enemy.getPosition()),
        );
    });
});

describe("UnitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam", () => {
    const sync = (u: Unit): number => {
        u.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
        return u.getMorale();
    };

    it("drops morale only for living same-type allies of the fallen stack", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const knightA = createTestUnit({ team: PBTypes.TeamVals.LOWER, name: "Knight", morale: 10 });
        const knightB = createTestUnit({ team: PBTypes.TeamVals.LOWER, name: "Knight", morale: 10 });
        const archer = createTestUnit({ team: PBTypes.TeamVals.LOWER, name: "Archer", morale: 10 });
        const enemyKnight = createTestUnit({ team: PBTypes.TeamVals.UPPER, name: "Knight", morale: 10 });
        placeUnit(grid, unitsHolder, knightA, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, knightB, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, enemyKnight, { x: 8, y: 8 });

        // A LOWER Knight fell: same-name + same-team allies lose MORALE_CHANGE_FOR_KILL (4) each.
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam({ [`Knight:${PBTypes.TeamVals.LOWER}`]: 4 });

        expect(sync(knightA)).toBe(6);
        expect(sync(knightB)).toBe(6);
        expect(sync(archer)).toBe(10); // different unit type — unaffected
        expect(sync(enemyKnight)).toBe(10); // enemy team — unaffected
    });

    it("accumulates the penalty when multiple same-type stacks die at once", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const knight = createTestUnit({ team: PBTypes.TeamVals.LOWER, name: "Knight", morale: 10 });
        placeUnit(grid, unitsHolder, knight, { x: 1, y: 1 });

        // Two Knights died in the same attack -> 2 * 4 = 8.
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam({ [`Knight:${PBTypes.TeamVals.LOWER}`]: 8 });

        expect(sync(knight)).toBe(2);
    });
});

function flatUnitIds(teams: Unit[][]): string[] {
    return teams.flat().map((unit) => unit.getId());
}

function positionForCell(cell: { x: number; y: number }): { x: number; y: number } {
    return getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
}
