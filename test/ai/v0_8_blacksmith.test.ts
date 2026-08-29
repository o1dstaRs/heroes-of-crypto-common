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

import { afterEach, describe, expect, it } from "bun:test";

import type { IDecisionContext, IPlacementContext } from "../../src/ai";
import { StrategyV0_8, V08_BLACKSMITH_ROLE_VERSIONS_ENV } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import {
    prioritizeV08BlacksmithCraft,
    v08BlacksmithCraftPlacement,
    v08BlacksmithCraftRecipientValue,
    v08BlacksmithCraftRecipientsAt,
    v08PublicRosterPunishesCraftCluster,
} from "../../src/ai/versions/v0_8_blacksmith";
import { V08_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8_dominant_finish";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;
const savedBlacksmithScope = process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV];

afterEach(() => {
    if (savedBlacksmithScope === undefined) delete process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV];
    else process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV] = savedBlacksmithScope;
});

const decisionContext = (combat: ReturnType<typeof createCombatTestContext>): IDecisionContext => ({
    grid: combat.grid,
    matrix: combat.grid.getMatrix(),
    unitsHolder: combat.unitsHolder,
    pathHelper: new PathHelper(testGridSettings),
    attackHandler: combat.attackHandler,
    fightProperties: FightStateManager.getInstance().getFightProperties(),
});

const blacksmith = (): Unit =>
    createTestUnit({
        team: LOWER,
        name: "Blacksmith",
        attackType: MELEE,
        attack: 9,
        damageMin: 2,
        damageMax: 3,
        amountAlive: 100,
        maxHp: 9,
        stackPower: 4,
        spells: ["System:Craft", "System:Armor Rune", "System:Weapon Rune"],
    });

const cast = (actions: readonly GameAction[]): Extract<GameAction, { type: "cast_spell" }> | undefined =>
    actions.find((action): action is Extract<GameAction, { type: "cast_spell" }> => action.type === "cast_spell");

describe("v0.8 Blacksmith Craft router", () => {
    it("makes the legal max-recipient, max-combat-value Craft the native incumbent", () => {
        const combat = createCombatTestContext();
        const smith = blacksmith();
        const highRanged = createTestUnit({
            team: LOWER,
            name: "High ranged",
            attackType: RANGE,
            damageMax: 20,
            amountAlive: 10,
            rangeShots: 8,
        });
        const highMelee = createTestUnit({
            team: LOWER,
            name: "High melee",
            attackType: MELEE,
            damageMax: 20,
            amountAlive: 10,
        });
        const lowFirst = createTestUnit({
            team: LOWER,
            name: "Low first",
            attackType: MELEE,
            damageMax: 1,
        });
        const lowSecond = createTestUnit({
            team: LOWER,
            name: "Low second",
            attackType: MELEE,
            damageMax: 1,
        });
        const enemy = createTestUnit({ team: UPPER, name: "Enemy" });
        placeUnit(combat.grid, combat.unitsHolder, smith, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, highRanged, { x: 5, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, highMelee, { x: 6, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, lowFirst, { x: 9, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, lowSecond, { x: 10, y: 9 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });
        const context = decisionContext(combat);
        const incumbent: GameAction[] = [{ type: "defend_turn", unitId: smith.getId() }];

        const selected = prioritizeV08BlacksmithCraft(smith, context, incumbent);
        const action = cast(selected);
        expect(action?.spellName).toBe("Craft");
        expect(action?.targetCell).toBeDefined();
        expect(v08BlacksmithCraftRecipientsAt(smith, context, action!.targetCell!).map((unit) => unit.getId())).toEqual(
            [highMelee.getId(), highRanged.getId()].sort(),
        );
    });

    it("does not spend Craft on one recipient and preserves only a stationary guaranteed kill", () => {
        const singleCombat = createCombatTestContext();
        const singleSmith = blacksmith();
        const loneAlly = createTestUnit({ team: LOWER, name: "Lone ally" });
        const distantEnemy = createTestUnit({ team: UPPER, name: "Distant enemy" });
        placeUnit(singleCombat.grid, singleCombat.unitsHolder, singleSmith, { x: 2, y: 2 });
        placeUnit(singleCombat.grid, singleCombat.unitsHolder, loneAlly, { x: 8, y: 8 });
        placeUnit(singleCombat.grid, singleCombat.unitsHolder, distantEnemy, { x: 13, y: 13 });
        const hold: GameAction[] = [{ type: "defend_turn", unitId: singleSmith.getId() }];
        expect(prioritizeV08BlacksmithCraft(singleSmith, decisionContext(singleCombat), hold)).toBe(hold);

        const killCombat = createCombatTestContext();
        const killSmith = blacksmith();
        const first = createTestUnit({ team: LOWER, name: "Craft first", damageMax: 10, amountAlive: 10 });
        const second = createTestUnit({ team: LOWER, name: "Craft second", damageMax: 10, amountAlive: 10 });
        const victim = createTestUnit({ team: UPPER, name: "Certain victim", maxHp: 1, armor: 0 });
        placeUnit(killCombat.grid, killCombat.unitsHolder, killSmith, { x: 2, y: 2 });
        placeUnit(killCombat.grid, killCombat.unitsHolder, victim, { x: 3, y: 2 });
        placeUnit(killCombat.grid, killCombat.unitsHolder, first, { x: 7, y: 7 });
        placeUnit(killCombat.grid, killCombat.unitsHolder, second, { x: 8, y: 7 });
        const guaranteed: GameAction[] = [
            {
                type: "melee_attack",
                attackerId: killSmith.getId(),
                targetId: victim.getId(),
                attackFrom: { ...killSmith.getBaseCell() },
            },
        ];
        expect(prioritizeV08BlacksmithCraft(killSmith, decisionContext(killCombat), guaranteed)).toBe(guaranteed);
    });

    it("releases Craft during the universal dominant-finish sprint", () => {
        const combat = createCombatTestContext();
        const smith = blacksmith();
        const first = createTestUnit({ team: LOWER, name: "Craft first" });
        const second = createTestUnit({ team: LOWER, name: "Craft second" });
        const enemy = createTestUnit({ team: UPPER, name: "Live enemy" });
        placeUnit(combat.grid, combat.unitsHolder, smith, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, first, { x: 7, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, second, { x: 8, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        while (fightProperties.getCurrentLap() < V08_URGENT_FINISH_START_LAP) fightProperties.flipLap();
        const finish: GameAction[] = [{ type: "defend_turn", unitId: smith.getId() }];

        expect(prioritizeV08BlacksmithCraft(smith, decisionContext(combat), finish)).toBe(finish);
    });

    it("is wired into the shipped strategy and can isolate one exact alias for paired a13 trials", () => {
        const combat = createCombatTestContext();
        const smith = blacksmith();
        const first = createTestUnit({ team: LOWER, name: "Craft first", damageMax: 10, amountAlive: 10 });
        const second = createTestUnit({ team: LOWER, name: "Craft second", damageMax: 10, amountAlive: 10 });
        const enemy = createTestUnit({ team: UPPER, name: "Distant enemy" });
        placeUnit(combat.grid, combat.unitsHolder, smith, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, first, { x: 7, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, second, { x: 8, y: 7 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 13, y: 13 });
        const context = decisionContext(combat);

        process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV] = "v0.8";
        expect(cast(new StrategyV0_8().decideTurn(smith, context))?.spellName).toBe("Craft");
        expect(cast(new StrategyV0_8S().decideTurn(smith, context))?.spellName).not.toBe("Craft");
    });
});

interface IPlacementFixture {
    readonly units: Unit[];
    readonly context: IPlacementContext;
    readonly inherited: Map<string, XY>;
}

const placementFixture = (publicOpponentCreatureIds: readonly number[]): IPlacementFixture => {
    const combat = createCombatTestContext();
    const units = [
        blacksmith(),
        createTestUnit({
            team: LOWER,
            name: "Artillery",
            attackType: RANGE,
            damageMax: 20,
            amountAlive: 10,
            rangeShots: 8,
        }),
        createTestUnit({
            team: LOWER,
            name: "Archer",
            attackType: RANGE,
            damageMax: 12,
            amountAlive: 10,
            rangeShots: 6,
        }),
        createTestUnit({ team: LOWER, name: "Bruiser", damageMax: 20, amountAlive: 20 }),
        createTestUnit({ team: LOWER, name: "Guard", damageMax: 10, amountAlive: 20 }),
        createTestUnit({ team: LOWER, name: "Filler", damageMax: 1, amountAlive: 1 }),
    ];
    for (const unit of units) combat.unitsHolder.addUnit(unit);
    const initialCells: XY[] = [
        { x: 0, y: 1 },
        { x: 3, y: 1 },
        { x: 6, y: 1 },
        { x: 9, y: 1 },
        { x: 12, y: 1 },
        { x: 14, y: 1 },
    ];
    const inherited = new Map(units.map((unit, index) => [unit.getId(), initialCells[index]]));
    return {
        units,
        inherited,
        context: {
            team: LOWER,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
            publicOpponentCreatureIds,
            setupPlacementPolicy: "public-roster",
        },
    };
};

const inOneTwoByTwo = (cells: readonly XY[]): boolean => {
    const xs = cells.map((cell) => cell.x);
    const ys = cells.map((cell) => cell.y);
    return Math.max(...xs) - Math.min(...xs) <= 1 && Math.max(...ys) - Math.min(...ys) <= 1;
};

const placementFootprint = (unit: Unit, placements: ReadonlyMap<string, XY>): XY[] => {
    const base = placements.get(unit.getId())!;
    return unit.isSmallSize()
        ? [base]
        : [base, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];
};

const sharedCraftAnchors = (
    units: readonly Unit[],
    context: IPlacementContext,
    placements: ReadonlyMap<string, XY>,
): XY[] => {
    const legal = context.placement.possibleCellHashes();
    return [...legal]
        .map((cellKey) => ({ x: cellKey >> 4, y: cellKey & 0xf }))
        .filter((anchor) => {
            const targetKeys = new Set([
                (anchor.x << 4) | anchor.y,
                ((anchor.x + 1) << 4) | anchor.y,
                (anchor.x << 4) | (anchor.y + 1),
                ((anchor.x + 1) << 4) | (anchor.y + 1),
            ]);
            return (
                [...targetKeys].every((cellKey) => legal.has(cellKey)) &&
                units.every((unit) =>
                    placementFootprint(unit, placements).some((cell) => targetKeys.has((cell.x << 4) | cell.y)),
                )
            );
        });
};

describe("v0.8 Blacksmith Craft placement", () => {
    it("clusters four distinct highest-value small allies without moving the rest", () => {
        const fixture = placementFixture([PBTypes.CreatureVals.SQUIRE]);
        const selected = [...fixture.units]
            .sort(
                (left, right) =>
                    v08BlacksmithCraftRecipientValue(right) - v08BlacksmithCraftRecipientValue(left) ||
                    left.getId().localeCompare(right.getId()),
            )
            .slice(0, 4);
        const selectedIds = new Set(selected.map((unit) => unit.getId()));
        const result = v08BlacksmithCraftPlacement(fixture.units, fixture.context, fixture.inherited);

        expect(result).not.toBe(fixture.inherited);
        expect(inOneTwoByTwo(selected.map((unit) => result.get(unit.getId())!))).toBe(true);
        expect(new Set(selected.map((unit) => JSON.stringify(result.get(unit.getId())))).size).toBe(4);
        for (const unit of fixture.units.filter((candidate) => !selectedIds.has(candidate.getId()))) {
            expect(result.get(unit.getId())).toEqual(fixture.inherited.get(unit.getId()));
        }
        for (const cell of result.values()) {
            expect(fixture.context.placement.possibleCellHashes().has((cell.x << 4) | cell.y)).toBe(true);
        }
        expect(new Set([...result.values()].map((cell) => (cell.x << 4) | cell.y)).size).toBe(fixture.units.length);
    });

    it("packs a high-value large recipient by footprint and preserves its inherited ward edge", () => {
        const fixture = placementFixture([PBTypes.CreatureVals.SQUIRE]);
        const largeProtector = createTestUnit({
            team: LOWER,
            name: "Abomination",
            size: PBTypes.UnitSizeVals.LARGE,
            damageMax: 50,
            amountAlive: 100,
            auraEffects: ["Flesh Shield"],
            auraRanges: [1],
            auraIsBuff: [true],
        });
        fixture.units.push(largeProtector);
        fixture.context.unitsHolder.addUnit(largeProtector);
        fixture.inherited.set(largeProtector.getId(), { x: 4, y: 3 });
        const ward = fixture.units.find((unit) => unit.getName() === "Artillery")!;

        const selected = [...fixture.units]
            .sort(
                (left, right) =>
                    v08BlacksmithCraftRecipientValue(right) - v08BlacksmithCraftRecipientValue(left) ||
                    left.getId().localeCompare(right.getId()),
            )
            .slice(0, 4);
        expect(selected.map((unit) => unit.getId())).toContain(largeProtector.getId());

        const result = v08BlacksmithCraftPlacement(fixture.units, fixture.context, fixture.inherited);
        expect(result).not.toBe(fixture.inherited);
        expect(sharedCraftAnchors(selected, fixture.context, result).length).toBeGreaterThan(0);

        const protectorFootprint = placementFootprint(largeProtector, result);
        const wardFootprint = placementFootprint(ward, result);
        expect(
            Math.min(
                ...protectorFootprint.flatMap((protectorCell) =>
                    wardFootprint.map((wardCell) =>
                        Math.max(Math.abs(protectorCell.x - wardCell.x), Math.abs(protectorCell.y - wardCell.y)),
                    ),
                ),
            ),
        ).toBeLessThanOrEqual(1);

        const occupied = new Set<number>();
        const legal = fixture.context.placement.possibleCellHashes();
        for (const unit of fixture.units) {
            for (const cell of placementFootprint(unit, result)) {
                const cellKey = (cell.x << 4) | cell.y;
                expect(legal.has(cellKey)).toBe(true);
                expect(occupied.has(cellKey)).toBe(false);
                occupied.add(cellKey);
            }
        }
    });

    it("breaks an equal-count placement tie for a recipient whose 40% double outcome is still useful", () => {
        const combat = createCombatTestContext();
        const smith = blacksmith();
        const highFirst = createTestUnit({
            team: LOWER,
            name: "High first",
            damageMax: 30,
            amountAlive: 20,
        });
        const highSecond = createTestUnit({
            team: LOWER,
            name: "High second",
            damageMax: 25,
            amountAlive: 20,
        });
        const plain = createTestUnit({
            team: LOWER,
            name: "Plain",
            damageMax: 20,
            amountAlive: 10,
        });
        const doubled = createTestUnit({
            team: LOWER,
            name: "Already doubled",
            damageMax: 20,
            amountAlive: 10,
            abilities: ["Double Punch"],
        });
        const units = [smith, highFirst, highSecond, plain, doubled];
        units.forEach((unit) => combat.unitsHolder.addUnit(unit));
        const initialCells: XY[] = [
            { x: 0, y: 1 },
            { x: 3, y: 1 },
            { x: 6, y: 1 },
            { x: 9, y: 1 },
            { x: 12, y: 1 },
        ];
        const inherited = new Map(units.map((unit, index) => [unit.getId(), initialCells[index]]));
        const context: IPlacementContext = {
            team: LOWER,
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            placement: new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 5),
            publicOpponentCreatureIds: [PBTypes.CreatureVals.SQUIRE],
            setupPlacementPolicy: "public-roster",
        };

        expect(v08BlacksmithCraftRecipientValue(plain)).toBeGreaterThan(v08BlacksmithCraftRecipientValue(doubled));
        for (const ability of ["Crafted Double Punch", "Double Shot", "Crafted Double Shot"]) {
            const attackType = ability.includes("Shot") ? RANGE : MELEE;
            const alreadyDoubled = createTestUnit({
                team: LOWER,
                attackType,
                rangeShots: attackType === RANGE ? 1 : 0,
                damageMax: 20,
                amountAlive: 10,
                abilities: [ability],
            });
            const comparable = createTestUnit({
                team: LOWER,
                attackType,
                rangeShots: attackType === RANGE ? 1 : 0,
                damageMax: 20,
                amountAlive: 10,
            });
            expect(v08BlacksmithCraftRecipientValue(comparable)).toBeGreaterThan(
                v08BlacksmithCraftRecipientValue(alreadyDoubled),
            );
        }

        const result = v08BlacksmithCraftPlacement(units, context, inherited);
        expect(sharedCraftAnchors([smith, highFirst, highSecond, plain], context, result).length).toBeGreaterThan(0);
        expect(result.get(doubled.getId())).toEqual(inherited.get(doubled.getId()));
    });

    it("returns the exact inherited layout against every public ranged/magic AOE class", () => {
        const threats = [
            PBTypes.CreatureVals.GARGANTUAN,
            PBTypes.CreatureVals.TSAR_CANNON,
            PBTypes.CreatureVals.CYCLOPS,
            PBTypes.CreatureVals.ZENA,
            PBTypes.CreatureVals.BATTLE_MAGE,
            PBTypes.CreatureVals.MAGIC_DRAGON,
            PBTypes.CreatureVals.NIGHTMARE,
            PBTypes.CreatureVals.BLACK_DRAGON,
            PBTypes.CreatureVals.THUNDERBIRD,
        ];
        expect(threats.every((creatureId) => v08PublicRosterPunishesCraftCluster([creatureId]))).toBe(true);
        for (const creatureId of threats) {
            const fixture = placementFixture([creatureId]);
            expect(v08BlacksmithCraftPlacement(fixture.units, fixture.context, fixture.inherited)).toBe(
                fixture.inherited,
            );
        }
    });

    it("uses the public roster rather than hidden opponent runtime state", () => {
        const fixture = placementFixture([PBTypes.CreatureVals.SQUIRE]);
        const hiddenSplash = createTestUnit({
            team: UPPER,
            name: "Gargantuan",
            attackType: RANGE,
            abilities: ["Area Throw"],
        });
        fixture.context.unitsHolder.addUnit(hiddenSplash);

        expect(v08BlacksmithCraftPlacement(fixture.units, fixture.context, fixture.inherited)).not.toBe(
            fixture.inherited,
        );
    });

    it("fails closed when only a partial reveal is available instead of treating it as the full roster", () => {
        const fixture = placementFixture([PBTypes.CreatureVals.SQUIRE]);
        const partialContext: IPlacementContext = {
            ...fixture.context,
            publicOpponentCreatureIds: undefined,
            revealedOpponentCreatures: [PBTypes.CreatureVals.SQUIRE],
            setupPlacementPolicy: "legitimate-reveal",
        };

        expect(v08BlacksmithCraftPlacement(fixture.units, partialContext, fixture.inherited)).toBe(fixture.inherited);
    });

    it("composes after protector placement without breaking an inherited ward screen", () => {
        const fixture = placementFixture([PBTypes.CreatureVals.SQUIRE]);
        const protector = createTestUnit({
            team: LOWER,
            name: "Abomination",
            size: PBTypes.UnitSizeVals.LARGE,
        });
        fixture.units.push(protector);
        fixture.context.unitsHolder.addUnit(protector);
        const ward = fixture.units.find((unit) => unit.getName() === "Artillery")!;
        fixture.inherited.set(ward.getId(), { x: 4, y: 3 });
        fixture.inherited.set(protector.getId(), { x: 3, y: 4 });

        const result = v08BlacksmithCraftPlacement(fixture.units, fixture.context, fixture.inherited);
        const wardCell = result.get(ward.getId())!;
        const protectorCell = result.get(protector.getId())!;
        const protectorFootprint = [
            protectorCell,
            { x: protectorCell.x - 1, y: protectorCell.y },
            { x: protectorCell.x, y: protectorCell.y - 1 },
            { x: protectorCell.x - 1, y: protectorCell.y - 1 },
        ];
        expect(
            Math.min(
                ...protectorFootprint.map((cell) =>
                    Math.max(Math.abs(cell.x - wardCell.x), Math.abs(cell.y - wardCell.y)),
                ),
            ),
        ).toBeLessThanOrEqual(1);

        const occupied = new Set<number>();
        for (const unit of fixture.units) {
            const base = result.get(unit.getId())!;
            const footprint = unit.isSmallSize()
                ? [base]
                : [base, { x: base.x - 1, y: base.y }, { x: base.x, y: base.y - 1 }, { x: base.x - 1, y: base.y - 1 }];
            for (const cell of footprint) {
                const cellKey = (cell.x << 4) | cell.y;
                expect(occupied.has(cellKey)).toBe(false);
                occupied.add(cellKey);
            }
        }
    });

    it("preserves both range-2 Angel ward edges while clustering for Craft", () => {
        const fixture = placementFixture([PBTypes.CreatureVals.CENTAUR]);
        const angel = createTestUnit({
            team: LOWER,
            name: "Angel",
            size: PBTypes.UnitSizeVals.LARGE,
        });
        fixture.units.push(angel);
        fixture.context.unitsHolder.addUnit(angel);
        const primary = fixture.units.find((unit) => unit.getName() === "Artillery")!;
        const secondary = fixture.units.find((unit) => unit.getName() === "Archer")!;
        fixture.inherited.set(angel.getId(), { x: 3, y: 4 });
        fixture.inherited.set(primary.getId(), { x: 5, y: 4 });
        fixture.inherited.set(secondary.getId(), { x: 5, y: 2 });

        const result = v08BlacksmithCraftPlacement(fixture.units, fixture.context, fixture.inherited);
        const angelBase = result.get(angel.getId())!;
        const angelFootprint = [
            angelBase,
            { x: angelBase.x - 1, y: angelBase.y },
            { x: angelBase.x, y: angelBase.y - 1 },
            { x: angelBase.x - 1, y: angelBase.y - 1 },
        ];
        for (const ward of [primary, secondary]) {
            const wardCell = result.get(ward.getId())!;
            expect(
                Math.min(
                    ...angelFootprint.map((cell) =>
                        Math.max(Math.abs(cell.x - wardCell.x), Math.abs(cell.y - wardCell.y)),
                    ),
                ),
            ).toBeLessThanOrEqual(2);
        }
    });
});
