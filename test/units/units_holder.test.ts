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

import { ArmorAugment, MightAugment, MovementAugment, SniperAugment } from "../../src/augments/augment_properties";
import {
    ArtifactTier,
    formatArtifactDescription,
    getTier2ArtifactProperties,
    Tier1Artifact,
    Tier2Artifact,
} from "../../src/artifacts/artifact_properties";
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
        const left = createTestUnit({
            name: "Lower Scout",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 20,
            magicResist: 5,
            movementType: PBTypes.MovementVals.FLY,
        });
        const leftWalker = createTestUnit({
            name: "Lower Walker",
            team: PBTypes.TeamVals.LEFT,
            maxHp: 12,
            magicResist: 2,
        });
        const right = createTestUnit({
            name: "Upper Guard",
            team: PBTypes.TeamVals.RIGHT,
            maxHp: 30,
            magicResist: 7,
        });

        placeUnit(grid, unitsHolder, left, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, leftWalker, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, right, { x: 14, y: 14 });

        expect(Array.from(unitsHolder.getAllUnitsIterator()).map((unit) => unit.getId())).toEqual([
            left.getId(),
            leftWalker.getId(),
            right.getId(),
        ]);
        expect(unitsHolder.getAllEnemyUnits(PBTypes.TeamVals.LEFT).map((unit) => unit.getId())).toEqual([
            right.getId(),
        ]);
        expect(unitsHolder.getAllAllies(PBTypes.TeamVals.LEFT).map((unit) => unit.getId())).toEqual([
            left.getId(),
            leftWalker.getId(),
        ]);
        expect(unitsHolder.getAllTeamUnitsBuffs(PBTypes.TeamVals.LEFT).get(left.getId())).toEqual([]);
        expect(unitsHolder.getAllEnemyUnitsBuffs(PBTypes.TeamVals.LEFT).get(right.getId())).toEqual([]);
        expect(unitsHolder.getAllEnemyUnitsDebuffs(PBTypes.TeamVals.LEFT).get(right.getId())).toEqual([]);
        expect(unitsHolder.getAllTeamUnitsCanFly(PBTypes.TeamVals.LEFT)).toEqual(
            new Map([
                [left.getId(), true],
                [leftWalker.getId(), false],
            ]),
        );
        expect(unitsHolder.getAllEnemyUnitsCanFly(PBTypes.TeamVals.LEFT)).toEqual(new Map([[right.getId(), false]]));
        expect(unitsHolder.getAllTeamUnitsMagicResist(PBTypes.TeamVals.LEFT)).toEqual(
            new Map([
                [left.getId(), 5],
                [leftWalker.getId(), 2],
            ]),
        );
        expect(unitsHolder.getAllEnemyUnitsMagicResist(PBTypes.TeamVals.LEFT)).toEqual(new Map([[right.getId(), 7]]));
        expect(unitsHolder.getAllTeamUnitsHp(PBTypes.TeamVals.LEFT)).toEqual(
            new Map([
                [left.getId(), 20],
                [leftWalker.getId(), 12],
            ]),
        );
        expect(unitsHolder.getAllTeamUnitsMaxHp(PBTypes.TeamVals.LEFT)).toEqual(
            new Map([
                [left.getId(), 20],
                [leftWalker.getId(), 12],
            ]),
        );
        expect(unitsHolder.getUnitByStats(undefined as unknown as UnitProperties)).toBeUndefined();
        expect(unitsHolder.getUnitByStats(left.getUnitProperties() as UnitProperties)).toBe(left);
        expect(flatUnitIds(unitsHolder.refreshUnitsForAllTeams()).sort()).toEqual(
            [left.getId(), leftWalker.getId(), right.getId()].sort(),
        );
    });

    it("filters placed allies and selects the lowest-power units for cleanup", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const leftBottom = new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 3);
        const rightTop = new SquarePlacement(testGridSettings, PlacementPositionType.RIGHT_TOP, 3);
        const leftA = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const leftB = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const leftC = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const leftOutside = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const right = createTestUnit({ team: PBTypes.TeamVals.RIGHT });

        leftA.setStackPower(3);
        leftB.setStackPower(1);
        leftC.setStackPower(2);

        placeUnit(grid, unitsHolder, leftA, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, leftB, { x: 2, y: 1 });
        placeUnit(grid, unitsHolder, leftC, { x: 3, y: 1 });
        placeUnit(grid, unitsHolder, leftOutside, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, right, { x: 14, y: 14 });

        expect(
            unitsHolder.getAllAlliesPlaced(PBTypes.TeamVals.LEFT, leftBottom, rightTop).map((unit) => unit.getId()),
        ).toEqual([leftA.getId(), leftB.getId(), leftC.getId()]);
        expect(
            unitsHolder.getAllAlliesPlaced(PBTypes.TeamVals.RIGHT, leftBottom, rightTop).map((unit) => unit.getId()),
        ).toEqual([right.getId()]);
        expect(unitsHolder.toCleanupRandomUnitsTillTeamSize(5, PBTypes.TeamVals.LEFT, leftBottom, rightTop)).toEqual(
            [],
        );
        expect(
            unitsHolder
                .toCleanupRandomUnitsTillTeamSize(1, PBTypes.TeamVals.LEFT, leftBottom, rightTop)
                .map((unit) => unit.getId()),
        ).toEqual([leftB.getId(), leftC.getId()]);
        expect(
            unitsHolder
                .toCleanupRandomUnitsTillTeamSize(-1, PBTypes.TeamVals.LEFT, leftBottom, rightTop)
                .map((unit) => unit.getId()),
        ).toEqual([leftB.getId(), leftC.getId(), leftA.getId()]);
    });

    it("tracks distances to closest enemies and adjacent enemy queries", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const left = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const rightAdjacent = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
        const rightFar = createTestUnit({ team: PBTypes.TeamVals.RIGHT });

        placeUnit(grid, unitsHolder, left, { x: 5, y: 5 });
        placeUnit(grid, unitsHolder, rightAdjacent, { x: 5, y: 6 });
        placeUnit(grid, unitsHolder, rightFar, { x: 12, y: 12 });

        expect(unitsHolder.allEnemiesAroundUnit(left, true, { x: 5, y: 5 })).toEqual([rightAdjacent]);
        expect(unitsHolder.allEnemiesAroundUnit(left, false)).toEqual([rightAdjacent]);
        expect(unitsHolder.allEnemiesAroundUnit(left, true)).toEqual([]);
        expect(unitsHolder.getNumberOfEnemiesWithinRange(left, 1)).toBe(1);
        expect(unitsHolder.getUnitAuraAttackMod(left)).toBe(0);
        expect(unitsHolder.getDistanceToClosestEnemy(PBTypes.TeamVals.RIGHT, left.getPosition())).toBeGreaterThan(0);
        expect(unitsHolder.haveDistancesToClosestEnemiesDecreased()).toBe(true);
        expect(unitsHolder.haveDistancesToClosestEnemiesDecreased()).toBe(false);

        left.setPosition(positionForCell({ x: 5, y: 5 }).x, positionForCell({ x: 5, y: 5 }).y);
        rightAdjacent.setPosition(positionForCell({ x: 5, y: 5 }).x, positionForCell({ x: 5, y: 5 }).y);

        expect(unitsHolder.haveDistancesToClosestEnemiesDecreased()).toBe(true);
    });

    it("removes units from holder, grid, and fight queues", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const unit = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        // Seed the id into initial properties too: resetTarget() would otherwise make this test pass while
        // retaining a dangling target on a unit hydrated from a mid-fight snapshot.
        const aggravated = createTestUnit({ team: PBTypes.TeamVals.RIGHT, target: unit.getId() });
        const unitCell = { x: 2, y: 2 };
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, unit, unitCell);
        placeUnit(grid, unitsHolder, aggravated, { x: 3, y: 3 });
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
        expect(aggravated.getTarget()).toBe("");
        expect(unitsHolder.deleteUnitById("missing")).toBe(true);
    });

    it("deletes units that are outside allowed placement", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const leftBottom = new SquarePlacement(testGridSettings, PlacementPositionType.LEFT_BOTTOM, 3);
        const rightTop = new SquarePlacement(testGridSettings, PlacementPositionType.RIGHT_TOP, 3);
        const unit = createTestUnit({ team: PBTypes.TeamVals.LEFT });

        placeUnit(grid, unitsHolder, unit, { x: 1, y: 1 });

        expect(unitsHolder.deleteUnitIfNotAllowed(unit.getId(), leftBottom, rightTop)).toBe(false);
        expect(unitsHolder.deleteUnitIfNotAllowed(unit.getId(), undefined, rightTop)).toBe(true);
        expect(unitsHolder.getAllUnits().has(unit.getId())).toBe(false);
        expect(unitsHolder.deleteUnitIfNotAllowed("missing", leftBottom, rightTop)).toBe(true);
    });

    it("finds summoned units by name and team", () => {
        const { unitsHolder } = createCombatTestContext();
        const summoned = createTestUnit({
            name: "Wolf",
            team: PBTypes.TeamVals.LEFT,
            summoned: true,
        });
        const regular = createTestUnit({
            name: "Wolf",
            team: PBTypes.TeamVals.RIGHT,
            summoned: false,
        });

        unitsHolder.addUnit(summoned);
        unitsHolder.addUnit(regular);

        expect(unitsHolder.getSummonedUnitByName(PBTypes.TeamVals.LEFT, "Wolf")).toBe(summoned);
        expect(unitsHolder.getSummonedUnitByName(PBTypes.TeamVals.RIGHT, "Wolf")).toBeUndefined();
        expect(unitsHolder.getSummonedUnitByName(PBTypes.TeamVals.LEFT, "")).toBeUndefined();
    });

    it("applies pre-fight supply synergy and skips it after fight start", () => {
        const { unitsHolder } = createCombatTestContext();
        const unit = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            amountAlive: 10,
        });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        unitsHolder.addUnit(unit);
        fightProperties.setSynergyUnitsPerFactions(PBTypes.TeamVals.LEFT, 6, 0, 0, 0);
        fightProperties.updateSynergyPerTeam(
            PBTypes.TeamVals.LEFT,
            PBTypes.FactionVals.LIFE,
            LifeSynergy.PLUS_SUPPLY_PERCENTAGE,
            SynergyLevel.LEVEL_3,
        );

        unitsHolder.increaseUnitsSupplyIfNeededPerTeam(PBTypes.TeamVals.LEFT);

        expect(unit.getAmountAlive()).toBe(11);

        fightProperties.startFight();
        unitsHolder.increaseUnitsSupplyIfNeededPerTeam(PBTypes.TeamVals.LEFT);

        expect(unit.getAmountAlive()).toBe(11);
    });

    it("applies configured augment buffs to placed units", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const ranged = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        const melee = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, ranged, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, melee, { x: 3, y: 2 });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Armor",
            value: ArmorAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Might",
            value: MightAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Sniper",
            value: SniperAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
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

    it("does not let Tome amplify augments or tier-1 artifact stats", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const melee = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attack: 10,
            armor: 10,
        });
        const ranged = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            attack: 10,
            armor: 10,
            rangeShots: 3,
            shotDistance: 16,
        });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, melee, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, ranged, { x: 3, y: 2 });
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.KEEN_BLADE);
        fightProperties.setArtifactPerTeam(
            PBTypes.TeamVals.LEFT,
            ArtifactTier.TIER_2,
            Tier2Artifact.TOME_OF_AMPLIFICATION,
        );
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Armor",
            value: ArmorAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Might",
            value: MightAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Sniper",
            value: SniperAugment.LEVEL_1,
        });
        fightProperties.setAugmentPerTeam(PBTypes.TeamVals.LEFT, {
            type: "Movement",
            value: MovementAugment.LEVEL_1,
        });

        unitsHolder.applyArtifacts();
        unitsHolder.applyAugments();
        ranged.refreshPossibleAttackTypes(true);
        melee.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
        ranged.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);

        expect(melee.hasBuffActive("Tome of Amplification")).toBe(true);
        expect(melee.getBaseArmor()).toBeCloseTo(10.6);
        expect(melee.getBaseAttack()).toBeCloseTo(11.5);
        expect(melee.getSteps()).toBe(4);
        expect(ranged.getBaseArmor()).toBeCloseTo(10.6);
        // Sniper L1 attack rose 7% -> 8%, reaching parity with Might L1 — the ranged and melee
        // augmented attacks now match exactly.
        expect(ranged.getBaseAttack()).toBeCloseTo(11.5);
        expect(ranged.getUnitProperties().shot_distance).toBeCloseTo(19.2);
        expect(ranged.getSteps()).toBe(4);
    });

    it("describes Tome as affecting only allied unit-cast buffs", () => {
        expect(formatArtifactDescription(getTier2ArtifactProperties(Tier2Artifact.TOME_OF_AMPLIFICATION))).toBe(
            "Increases the power of non-healing castable buffs allied units apply to allies by 50%. Does not affect healing, resurrection, augments, artifacts, auras, or passive effects.",
        );
    });

    it("applies tier 1 & tier 2 artifact buffs to the right units", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const ranged = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        const melee = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, ranged, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, melee, { x: 3, y: 2 });

        expect(
            fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.VETERAN_HELM),
        ).toBe(true);
        expect(
            fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_2, Tier2Artifact.WARLORDS_EDGE),
        ).toBe(true);
        expect(fightProperties.getArtifactTier1(PBTypes.TeamVals.LEFT)).toBe(Tier1Artifact.VETERAN_HELM);
        expect(fightProperties.getArtifactTier2(PBTypes.TeamVals.LEFT)).toBe(Tier2Artifact.WARLORDS_EDGE);

        melee.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
        const baseAttackBefore = melee.getUnitProperties().base_attack;
        const attackBefore = melee.getAttack();
        const armorBefore = melee.getArmor();

        unitsHolder.applyArtifacts();

        // Veteran Helm (all units) + Warlord's Edge (all units) are applied as System buffs.
        expect(melee.hasBuffActive("Veteran Helm")).toBe(true);
        expect(ranged.hasBuffActive("Veteran Helm")).toBe(true);
        expect(melee.hasBuffActive("Warlords Edge")).toBe(true);

        // Warlord's Edge (+% attack) lands in attack_mod and Veteran Helm (+% defense) in armor_mod — both are
        // ADDITIONAL stats, deliberately NOT folded into base_attack/base_armor (so they don't compound with
        // aura multipliers). After a recompute the effective attack and armor rise while the base stays put.
        melee.adjustBaseStats(false, 1, 0, 0, 0, 0, 0, 0);
        expect(melee.getUnitProperties().base_attack).toBe(baseAttackBefore);
        expect(melee.getAttack()).toBeGreaterThan(attackBefore);
        expect(melee.getArmor()).toBeGreaterThan(armorBefore);
    });

    it("applies movement artifacts only to eligible units", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const ranged = createTestUnit({
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
        });
        const melee = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, ranged, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, melee, { x: 3, y: 2 });

        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.SWIFT_BOOTS);
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_2, Tier2Artifact.FARSIGHT_QUIVER);
        unitsHolder.applyArtifacts();

        // Swift Boots grants movement to melee units only.
        expect(melee.hasBuffActive("Swift Boots")).toBe(true);
        expect(ranged.hasBuffActive("Swift Boots")).toBe(false);
        // Farsight Quiver is applied to every unit as a marker (read at range-attack time).
        expect(ranged.hasBuffActive("Farsight Quiver")).toBe(true);
    });

    it("clears artifact buffs when the selection is reset", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const melee = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        const fightProperties = FightStateManager.getInstance().getFightProperties();

        placeUnit(grid, unitsHolder, melee, { x: 3, y: 2 });
        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.VETERAN_HELM);
        unitsHolder.applyArtifacts();
        expect(melee.hasBuffActive("Veteran Helm")).toBe(true);

        fightProperties.setArtifactPerTeam(PBTypes.TeamVals.LEFT, ArtifactTier.TIER_1, Tier1Artifact.NO_ARTIFACT);
        unitsHolder.applyArtifacts();
        expect(melee.hasBuffActive("Veteran Helm")).toBe(false);
    });

    it("refreshes stack power for all placed units", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const left = createTestUnit({ team: PBTypes.TeamVals.LEFT, amountAlive: 1, exp: 1 });
        const right = createTestUnit({ team: PBTypes.TeamVals.RIGHT, amountAlive: 5, exp: 1 });

        placeUnit(grid, unitsHolder, left, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, right, { x: 12, y: 12 });

        unitsHolder.refreshStackPowerForAllUnits();

        expect(left.getStackPower()).toBe(1);
        expect(right.getStackPower()).toBe(5);
    });

    it("refreshes aura effects for allies and enemies while keeping the strongest duplicate aura", () => {
        const { unitsHolder, grid } = createCombatTestContext();
        const weakAuraSource = createTestUnit({
            name: "Weak Aura",
            team: PBTypes.TeamVals.LEFT,
            auraEffects: ["Sharpened Weapons"],
            stackPower: 1,
        });
        const strongAuraSource = createTestUnit({
            name: "Strong Aura",
            team: PBTypes.TeamVals.LEFT,
            auraEffects: ["Sharpened Weapons", "Range Null Field"],
            stackPower: 10,
        });
        const meleeAlly = createTestUnit({
            name: "Melee Ally",
            team: PBTypes.TeamVals.LEFT,
            attackType: PBTypes.AttackVals.MELEE,
        });
        const rangedEnemy = createTestUnit({
            name: "Ranged Enemy",
            team: PBTypes.TeamVals.RIGHT,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 2,
        });
        const meleeEnemy = createTestUnit({
            name: "Melee Enemy",
            team: PBTypes.TeamVals.RIGHT,
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
        const ally = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, ally, { x: 3, y: 3 });

        // No UPPER units exist, so there is no enemy centroid.
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.RIGHT, positionForCell({ x: 3, y: 3 }))).toBe(
            Number.MAX_SAFE_INTEGER,
        );
    });

    it("equals the distance to the only enemy when there is exactly one", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });

        const from = positionForCell({ x: 2, y: 2 });
        // With a single enemy the centroid coincides with the closest-enemy metric.
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.RIGHT, from)).toBeCloseTo(
            getDistance(from, enemy.getPosition()),
        );
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.RIGHT, from)).toBeCloseTo(
            unitsHolder.getDistanceToClosestEnemy(PBTypes.TeamVals.RIGHT, from),
        );
    });

    it("measures distance to the average position of all enemies", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const e1 = createTestUnit({ team: PBTypes.TeamVals.RIGHT, name: "E1" });
        const e2 = createTestUnit({ team: PBTypes.TeamVals.RIGHT, name: "E2" });
        placeUnit(grid, unitsHolder, e1, { x: 2, y: 8 });
        placeUnit(grid, unitsHolder, e2, { x: 8, y: 8 });

        const from = positionForCell({ x: 5, y: 2 });
        const centroid = {
            x: (e1.getPosition().x + e2.getPosition().x) / 2,
            y: (e1.getPosition().y + e2.getPosition().y) / 2,
        };
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.RIGHT, from)).toBeCloseTo(
            getDistance(from, centroid),
        );
    });

    it("ignores friendly units", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const enemy = createTestUnit({ team: PBTypes.TeamVals.RIGHT });
        const ally = createTestUnit({ team: PBTypes.TeamVals.LEFT });
        placeUnit(grid, unitsHolder, enemy, { x: 8, y: 8 });
        placeUnit(grid, unitsHolder, ally, { x: 1, y: 1 });

        const from = positionForCell({ x: 4, y: 4 });
        // Only the UPPER enemy counts; the LOWER ally must not move the centroid.
        expect(unitsHolder.getDistanceToEnemyCentroid(PBTypes.TeamVals.RIGHT, from)).toBeCloseTo(
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
        const knightA = createTestUnit({ team: PBTypes.TeamVals.LEFT, name: "Knight", morale: 10 });
        const knightB = createTestUnit({ team: PBTypes.TeamVals.LEFT, name: "Knight", morale: 10 });
        const archer = createTestUnit({ team: PBTypes.TeamVals.LEFT, name: "Archer", morale: 10 });
        const enemyKnight = createTestUnit({ team: PBTypes.TeamVals.RIGHT, name: "Knight", morale: 10 });
        placeUnit(grid, unitsHolder, knightA, { x: 1, y: 1 });
        placeUnit(grid, unitsHolder, knightB, { x: 2, y: 2 });
        placeUnit(grid, unitsHolder, archer, { x: 3, y: 3 });
        placeUnit(grid, unitsHolder, enemyKnight, { x: 8, y: 8 });

        // A LOWER Knight fell: same-name + same-team allies lose MORALE_CHANGE_FOR_KILL (4) each.
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam({ [`Knight:${PBTypes.TeamVals.LEFT}`]: 4 });

        expect(sync(knightA)).toBe(6);
        expect(sync(knightB)).toBe(6);
        expect(sync(archer)).toBe(10); // different unit type — unaffected
        expect(sync(enemyKnight)).toBe(10); // enemy team — unaffected
    });

    it("accumulates the penalty when multiple same-type stacks die at once", () => {
        const { grid, unitsHolder } = createCombatTestContext();
        const knight = createTestUnit({ team: PBTypes.TeamVals.LEFT, name: "Knight", morale: 10 });
        placeUnit(grid, unitsHolder, knight, { x: 1, y: 1 });

        // Two Knights died in the same attack -> 2 * 4 = 8.
        unitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam({ [`Knight:${PBTypes.TeamVals.LEFT}`]: 8 });

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
