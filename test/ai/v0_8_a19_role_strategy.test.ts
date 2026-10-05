import { describe, expect, it } from "bun:test";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import { createV08A19RoleStrategy } from "../../src/ai/versions/v0_8_a19_role_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { XY } from "../../src/utils/math";
import { Grid } from "../../src/grid/grid";
import { createTestUnit, testGridSettings } from "../helpers/combat";
import { creatureInfo, creatureIdForName } from "../../src/ai/setup/creature_score";
import { footprintCellsForAnchor } from "../../src/simulation/footprint";
import {
    V08A19PublicSplashDispersionStrategy,
    reflectIncumbentPlacement,
} from "../../src/ai/versions/v0_8_a19_public_placement";
const names = ["Dryad", "Troll", "Fairy", "Medusa", "Monk", "Magic Dragon"];
describe("A19 optional role placement composition", () => {
    it("preserves native initialization and turn delegation for refined formations on every map and side", () => {
        const families = [
            ["Wandering Mage", "Wyvern", "Berserker", "Battle Mage", "Zena", "Magic Dragon"],
            ["Wandering Mage", "Valkyrie", "Centaur", "Trent", "Zena", "Tsar Cannon"],
            ["Berserker", "Battle Mage", "Centaur", "Medusa", "Cyclops", "Abomination"],
            ["Arbalester", "Elf", "Berserker", "Medusa", "Monk", "Magic Dragon"],
            ["Wandering Mage", "Trent", "Arbalester", "Elf", "Monk", "Angel"],
            ["Squire", "Battle Mage", "Centaur", "Elf", "Monk", "Angel"],
            ["Mermaid", "Battle Mage", "Arbalester", "Beholder", "Cyclops", "Tsar Cannon"],
            ["Wandering Mage", "Battle Mage", "Arbalester", "Trent", "Zena", "Angel"],
        ];
        for (const family of families)
            for (const gridType of [
                PBTypes.GridVals.NORMAL,
                PBTypes.GridVals.LAVA_CENTER,
                PBTypes.GridVals.BLOCK_CENTER,
            ])
                for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                    const left = team === PBTypes.TeamVals.LEFT;
                    const units = family.map((name) => {
                        const info = creatureInfo(creatureIdForName(name)!)!;
                        return createTestUnit({
                            name,
                            team,
                            size: info.footprintWidth as 1 | 2,
                            footprintWidth: info.footprintWidth,
                            footprintHeight: info.footprintHeight,
                            attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                        });
                    });
                    const incumbent = new Map(
                        units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]),
                    );
                    let initialized = 0;
                    const decisions: unknown[] = [];
                    const base: IAIStrategy = {
                        version: "v0.8",
                        placeArmy: () => {
                            initialized++;
                            return incumbent;
                        },
                        decideTurn: (unit, context) => {
                            expect(initialized).toBe(1);
                            decisions.push(context);
                            return [{ type: "defend_turn", unitId: unit.getId() }];
                        },
                    };
                    const legal = new Set(
                        Array.from({ length: 64 }, (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4)),
                    );
                    const context = {
                        team,
                        grid: new Grid(testGridSettings, gridType),
                        sideOrientedPlacement: true,
                        publicOpponentCreatureIds: [creatureIdForName("Tsar Cannon")!],
                        placement: { possibleCellHashes: () => legal },
                        unitsHolder: { getAllAllies: () => units },
                    } as unknown as IPlacementContext;
                    const strategy = createV08A19RoleStrategy(family, gridType, base);
                    const selected = strategy.placeArmy(units, context);
                    expect(initialized).toBe(1);
                    expect(new Set(selected.keys())).toEqual(new Set(units.map((unit) => unit.getId())));
                    const occupied = new Set<number>();
                    for (const unit of units)
                        for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                            const hash = (cell.x << 4) | cell.y;
                            expect(legal.has(hash)).toBe(true);
                            expect(occupied.has(hash)).toBe(false);
                            occupied.add(hash);
                        }
                    const liveContext = {} as never,
                        rolloutContext = { decisionOrigin: "rollout" } as never;
                    for (const decisionContext of [liveContext, rolloutContext])
                        expect(strategy.decideTurn(units[0], decisionContext)).toEqual([
                            { type: "defend_turn", unitId: units[0].getId() },
                        ]);
                    expect(decisions[0]).toBe(liveContext);
                    expect(decisions[1]).toBe(rolloutContext);
                    expect(initialized).toBe(1);
                }
    });
    it("reflects a Lava area battery without amplifiable buffs while retaining buff casters and other maps", () => {
        const families = [
            ["Blacksmith", "Battle Mage", "Orc", "Elf", "Cyclops", "Gargantuan"],
            ["Wandering Mage", "Medusa", "Peasant", "Elf", "Cyclops", "Gargantuan"],
        ];
        for (const [index, family] of families.entries())
            for (const gridType of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER])
                for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT])
                    for (const publicOpponentCreatureIds of [[], [creatureIdForName("Cyclops")!]]) {
                        const left = team === PBTypes.TeamVals.LEFT;
                        const units = family.map((name) => {
                            const info = creatureInfo(creatureIdForName(name)!)!;
                            return createTestUnit({
                                name,
                                team,
                                size: info.footprintWidth as 1 | 2,
                                footprintWidth: info.footprintWidth,
                                footprintHeight: info.footprintHeight,
                                attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                            });
                        });
                        const incumbent = new Map(
                            units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]),
                        );
                        let initialized = 0;
                        const base: IAIStrategy = {
                            version: "v0.8",
                            placeArmy: () => {
                                initialized++;
                                return incumbent;
                            },
                            decideTurn: (unit) => {
                                expect(initialized).toBe(1);
                                return [{ type: "defend_turn", unitId: unit.getId() }];
                            },
                        };
                        const legal = new Set(
                            Array.from(
                                { length: 64 },
                                (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4),
                            ),
                        );
                        const context = {
                            team,
                            grid: new Grid(testGridSettings, gridType),
                            sideOrientedPlacement: true,
                            publicOpponentCreatureIds,
                            placement: { possibleCellHashes: () => legal },
                            unitsHolder: { getAllAllies: () => units },
                        } as unknown as IPlacementContext;
                        const existingSplash = new V08A19PublicSplashDispersionStrategy(
                            { version: "v0.8", placeArmy: () => incumbent, decideTurn: () => [] },
                            true,
                        );
                        const existing = existingSplash.placeArmy(units, context);
                        const strategy = createV08A19RoleStrategy(family, gridType, base);
                        const selected = strategy.placeArmy(units, context);
                        expect(initialized).toBe(1);
                        expect(selected).toEqual(
                            gridType === PBTypes.GridVals.LAVA_CENTER && index === 0
                                ? reflectIncumbentPlacement(units, context, existing)
                                : existing,
                        );
                        const occupied = new Set<number>();
                        for (const unit of units)
                            for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                                const hash = (cell.x << 4) | cell.y;
                                expect(legal.has(hash)).toBe(true);
                                expect(occupied.has(hash)).toBe(false);
                                occupied.add(hash);
                            }
                        expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                            { type: "defend_turn", unitId: units[0].getId() },
                        ]);
                        expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                            { type: "defend_turn", unitId: units[1].getId() },
                        ]);
                    }
    });
    it("disperses a Blocked ground physical healer while preserving a flying protector and other maps", () => {
        for (const protector of ["Trent", "Harpy"])
            for (const gridType of [
                PBTypes.GridVals.NORMAL,
                PBTypes.GridVals.LAVA_CENTER,
                PBTypes.GridVals.BLOCK_CENTER,
            ])
                for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                    const left = team === PBTypes.TeamVals.LEFT;
                    const family = ["Dryad", protector, "Berserker", "Elf", "Zena", "Angel"];
                    const units = family.map((name) => {
                        const info = creatureInfo(creatureIdForName(name)!)!;
                        return createTestUnit({
                            name,
                            team,
                            size: info.footprintWidth as 1 | 2,
                            footprintWidth: info.footprintWidth,
                            footprintHeight: info.footprintHeight,
                            attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                        });
                    });
                    const incumbent = new Map(
                        units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]),
                    );
                    let initialized = 0;
                    const base: IAIStrategy = {
                        version: "v0.8",
                        placeArmy: () => {
                            initialized++;
                            return incumbent;
                        },
                        decideTurn: (unit) => {
                            expect(initialized).toBe(1);
                            return [{ type: "defend_turn", unitId: unit.getId() }];
                        },
                    };
                    const legal = new Set(
                        Array.from({ length: 64 }, (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4)),
                    );
                    const context = {
                        team,
                        grid: new Grid(testGridSettings, gridType),
                        sideOrientedPlacement: true,
                        publicOpponentCreatureIds: [creatureIdForName("Cyclops")!],
                        placement: { possibleCellHashes: () => legal },
                        unitsHolder: { getAllAllies: () => units },
                    } as unknown as IPlacementContext;
                    const strategy = createV08A19RoleStrategy(family, gridType, base),
                        selected = strategy.placeArmy(units, context);
                    expect(initialized).toBe(1);
                    if (gridType === PBTypes.GridVals.BLOCK_CENTER && protector === "Trent") {
                        expect(selected).not.toEqual(incumbent);
                        const occupied = new Set<number>();
                        for (const unit of units)
                            for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                                const hash = (cell.x << 4) | cell.y;
                                expect(legal.has(hash)).toBe(true);
                                expect(occupied.has(hash)).toBe(false);
                                occupied.add(hash);
                            }
                    } else {
                        const existingSplash = new V08A19PublicSplashDispersionStrategy(
                            { version: "v0.8", placeArmy: () => incumbent, decideTurn: () => [] },
                            true,
                        );
                        expect(selected).toEqual(existingSplash.placeArmy(units, context));
                    }
                    expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                        { type: "defend_turn", unitId: units[0].getId() },
                    ]);
                    expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                        { type: "defend_turn", unitId: units[1].getId() },
                    ]);
                }
    });
    it("reflects an ordinary Blocked physical battery on RIGHT while retaining LEFT and other maps", () => {
        const family = ["Peasant", "Trent", "Orc", "Elf", "Cyclops", "Behemoth"];
        for (const gridType of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER])
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                const left = team === PBTypes.TeamVals.LEFT;
                const units = family.map((name) => {
                    const info = creatureInfo(creatureIdForName(name)!)!;
                    return createTestUnit({
                        name,
                        team,
                        size: info.footprintWidth as 1 | 2,
                        footprintWidth: info.footprintWidth,
                        footprintHeight: info.footprintHeight,
                        attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                    });
                });
                const incumbent = new Map(units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]));
                let initialized = 0;
                const base: IAIStrategy = {
                    version: "v0.8",
                    placeArmy: () => {
                        initialized++;
                        return incumbent;
                    },
                    decideTurn: (unit) => {
                        expect(initialized).toBe(1);
                        return [{ type: "defend_turn", unitId: unit.getId() }];
                    },
                };
                const legal = new Set(
                    Array.from({ length: 64 }, (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4)),
                );
                const context = {
                    team,
                    grid: new Grid(testGridSettings, gridType),
                    sideOrientedPlacement: true,
                    publicOpponentCreatureIds: [],
                    placement: { possibleCellHashes: () => legal },
                    unitsHolder: { getAllAllies: () => units },
                } as unknown as IPlacementContext;
                const strategy = createV08A19RoleStrategy(family, gridType, base),
                    selected = strategy.placeArmy(units, context);
                expect(initialized).toBe(1);
                if (gridType === PBTypes.GridVals.BLOCK_CENTER && !left) {
                    expect(selected).not.toEqual(incumbent);
                    const occupied = new Set<number>();
                    for (const unit of units)
                        for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                            const hash = (cell.x << 4) | cell.y;
                            expect(legal.has(hash)).toBe(true);
                            expect(occupied.has(hash)).toBe(false);
                            occupied.add(hash);
                        }
                } else expect(selected).toEqual(incumbent);
                expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                    { type: "defend_turn", unitId: units[0].getId() },
                ]);
                expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                    { type: "defend_turn", unitId: units[1].getId() },
                ]);
            }
    });
    it("spreads a Lava spell carry with a lower flying protector while retaining native ground screens and other maps", () => {
        const families = [
            ["Wolf Rider", "Valkyrie", "Orc", "Beholder", "Griffin", "Magic Dragon"],
            ["Berserker", "White Tiger", "Arbalester", "Elf", "Goblin Knight", "Magic Dragon"],
        ];
        for (const [index, family] of families.entries())
            for (const gridType of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER])
                for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                    const left = team === PBTypes.TeamVals.LEFT;
                    const units = family.map((name) => {
                        const info = creatureInfo(creatureIdForName(name)!)!;
                        return createTestUnit({
                            name,
                            team,
                            size: info.footprintWidth as 1 | 2,
                            footprintWidth: info.footprintWidth,
                            footprintHeight: info.footprintHeight,
                            attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                        });
                    });
                    const incumbent = new Map(
                        units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]),
                    );
                    let initialized = 0;
                    const base: IAIStrategy = {
                        version: "v0.8",
                        placeArmy: () => {
                            initialized++;
                            return incumbent;
                        },
                        decideTurn: (unit) => {
                            expect(initialized).toBe(1);
                            return [{ type: "defend_turn", unitId: unit.getId() }];
                        },
                    };
                    const legal = new Set(
                        Array.from({ length: 64 }, (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4)),
                    );
                    const context = {
                        team,
                        grid: new Grid(testGridSettings, gridType),
                        sideOrientedPlacement: true,
                        publicOpponentCreatureIds: [],
                        placement: { possibleCellHashes: () => legal },
                        unitsHolder: { getAllAllies: () => units },
                    } as unknown as IPlacementContext;
                    const strategy = createV08A19RoleStrategy(family, gridType, base),
                        selected = strategy.placeArmy(units, context);
                    expect(initialized).toBe(1);
                    if (index === 0 && gridType === PBTypes.GridVals.LAVA_CENTER) {
                        expect(selected).not.toEqual(incumbent);
                        const occupied = new Set<number>();
                        for (const unit of units)
                            for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                                const hash = (cell.x << 4) | cell.y;
                                expect(legal.has(hash)).toBe(true);
                                expect(occupied.has(hash)).toBe(false);
                                occupied.add(hash);
                            }
                    } else expect(selected).toEqual(incumbent);
                    expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                        { type: "defend_turn", unitId: units[0].getId() },
                    ]);
                    expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                        { type: "defend_turn", unitId: units[1].getId() },
                    ]);
                }
    });
    it("disperses Lava artillery on LEFT while preserving RIGHT and its combat delegate after native initialization", () => {
        const family = ["Berserker", "Trent", "Orc", "Elf", "Cyclops", "Tsar Cannon"];
        for (const gridType of [PBTypes.GridVals.LAVA_CENTER])
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                const left = team === PBTypes.TeamVals.LEFT;
                const units = family.map((name) => {
                    const info = creatureInfo(creatureIdForName(name)!)!;
                    return createTestUnit({
                        name,
                        team,
                        size: info.footprintWidth as 1 | 2,
                        footprintWidth: info.footprintWidth,
                        footprintHeight: info.footprintHeight,
                        attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                    });
                });
                const incumbent = new Map(units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]));
                let initialized = 0;
                const base: IAIStrategy = {
                    version: "v0.8",
                    placeArmy: () => {
                        initialized++;
                        return incumbent;
                    },
                    decideTurn: (unit) => {
                        expect(initialized).toBe(1);
                        return [{ type: "defend_turn", unitId: unit.getId() }];
                    },
                };
                const legal = new Set(
                    Array.from({ length: 64 }, (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4)),
                );
                const context = {
                    team,
                    grid: new Grid(testGridSettings, gridType),
                    sideOrientedPlacement: true,
                    publicOpponentCreatureIds: [creatureIdForName("Zena")!],
                    placement: { possibleCellHashes: () => legal },
                    unitsHolder: { getAllAllies: () => units },
                } as unknown as IPlacementContext;
                const strategy = createV08A19RoleStrategy(family, gridType, base),
                    selected = strategy.placeArmy(units, context);
                expect(initialized).toBe(1);
                if (gridType === PBTypes.GridVals.LAVA_CENTER && team === PBTypes.TeamVals.LEFT) {
                    expect(selected).not.toEqual(incumbent);
                    expect(selected.size).toBe(units.length);
                    const occupied = new Set<number>();
                    for (const unit of units)
                        for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                            const hash = (cell.x << 4) | cell.y;
                            expect(legal.has(hash)).toBe(true);
                            expect(occupied.has(hash)).toBe(false);
                            occupied.add(hash);
                        }
                } else {
                    const native = new V08A19PublicSplashDispersionStrategy(
                        { ...base, placeArmy: () => incumbent },
                        true,
                    );
                    expect(selected).toEqual(native.placeArmy(units, context));
                }
                expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                    { type: "defend_turn", unitId: units[0].getId() },
                ]);
                expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                    { type: "defend_turn", unitId: units[1].getId() },
                ]);
            }
    });
    it("separates a sparse Lava area battery on both sides without changing other maps or its combat delegate", () => {
        const family = ["Wandering Mage", "Harpy", "Peasant", "Battle Mage", "Goblin Knight", "Gargantuan"];
        for (const gridType of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER])
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                const left = team === PBTypes.TeamVals.LEFT;
                const units = family.map((name) => {
                    const info = creatureInfo(creatureIdForName(name)!)!;
                    return createTestUnit({
                        name,
                        team,
                        size: info.footprintWidth as 1 | 2,
                        footprintWidth: info.footprintWidth,
                        footprintHeight: info.footprintHeight,
                        attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                    });
                });
                const incumbent = new Map(units.map((unit, i) => [unit.getId(), { x: left ? 1 : 14, y: 2 * i + 1 }]));
                let initialized = 0;
                const base: IAIStrategy = {
                    version: "v0.8",
                    placeArmy: () => {
                        initialized++;
                        return incumbent;
                    },
                    decideTurn: (unit) => {
                        expect(initialized).toBe(1);
                        return [{ type: "defend_turn", unitId: unit.getId() }];
                    },
                };
                const legal = new Set(
                    Array.from({ length: 64 }, (_, i) => (((left ? 0 : 12) + (i % 4)) << 4) | Math.floor(i / 4)),
                );
                const context = {
                    team,
                    grid: new Grid(testGridSettings, gridType),
                    sideOrientedPlacement: true,
                    publicOpponentCreatureIds: [],
                    placement: { possibleCellHashes: () => legal },
                    unitsHolder: { getAllAllies: () => units },
                } as unknown as IPlacementContext;
                const strategy = createV08A19RoleStrategy(family, gridType, base),
                    selected = strategy.placeArmy(units, context);
                expect(initialized).toBe(1);
                if (gridType === PBTypes.GridVals.LAVA_CENTER) {
                    expect(selected).not.toEqual(incumbent);
                    expect(selected.size).toBe(units.length);
                    const occupied = new Set<number>();
                    for (const unit of units)
                        for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                            const hash = (cell.x << 4) | cell.y;
                            expect(legal.has(hash)).toBe(true);
                            expect(occupied.has(hash)).toBe(false);
                            occupied.add(hash);
                        }
                } else expect(selected).toEqual(incumbent);
                expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                    { type: "defend_turn", unitId: units[0].getId() },
                ]);
                expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                    { type: "defend_turn", unitId: units[1].getId() },
                ]);
            }
    });
    it("spreads blocked caster batteries legally on either side while preserving other maps", () => {
        const battery = ["Wandering Mage", "Wyvern", "Berserker", "Battle Mage", "Zena", "Magic Dragon"];
        const units = battery.map((name) => {
            const info = creatureInfo(creatureIdForName(name)!)!;
            return createTestUnit({
                name,
                size: info.footprintWidth as 1 | 2,
                footprintWidth: info.footprintWidth,
                footprintHeight: info.footprintHeight,
                attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
            });
        });
        const incumbent = new Map(units.map((u, i) => [u.getId(), { x: 1, y: 2 * i + 1 }]));
        for (const gridType of [PBTypes.GridVals.BLOCK_CENTER, PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER]) {
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                let initialized = 0;
                const base: IAIStrategy = {
                    version: "v0.8",
                    placeArmy: () => {
                        initialized++;
                        return incumbent;
                    },
                    decideTurn: (u) => {
                        expect(initialized).toBe(1);
                        return [{ type: "defend_turn", unitId: u.getId() }];
                    },
                };
                const legal = new Set(Array.from({ length: 64 }, (_, i) => ((i % 4) << 4) | Math.floor(i / 4)));
                const context = {
                    team,
                    grid: new Grid(testGridSettings, gridType),
                    sideOrientedPlacement: true,
                    publicOpponentCreatureIds: [],
                    placement: { possibleCellHashes: () => legal },
                    unitsHolder: { getAllAllies: () => units },
                } as unknown as IPlacementContext;
                const strategy = createV08A19RoleStrategy(battery, gridType, base);
                const selected = strategy.placeArmy(units, context);
                expect(initialized).toBe(1);
                if (gridType === PBTypes.GridVals.BLOCK_CENTER) {
                    expect(selected).not.toEqual(incumbent);
                    const occupied = new Set<number>();
                    for (const unit of units)
                        for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                            const hash = (cell.x << 4) | cell.y;
                            expect(legal.has(hash)).toBe(true);
                            expect(occupied.has(hash)).toBe(false);
                            occupied.add(hash);
                        }
                } else expect(selected).toEqual(incumbent);
                expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                    { type: "defend_turn", unitId: units[0].getId() },
                ]);
            }
        }
    });
    it("keeps blocked spell, volley, splash, and area formations legal on either side after native initialization", () => {
        const families = [
            ["Arbalester", "Elf", "Berserker", "Medusa", "Monk", "Magic Dragon"],
            ["Wandering Mage", "Valkyrie", "Centaur", "Trent", "Zena", "Tsar Cannon"],
            ["Leprechaun", "Medusa", "Wandering Mage", "Pikeman", "Cyclops", "Frenzied Boar"],
            ["Wandering Mage", "Elf", "Squire", "Beholder", "Cyclops", "Gargantuan"],
        ];
        for (const family of families)
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
                const units = family.map((name) => {
                    const info = creatureInfo(creatureIdForName(name)!)!;
                    return createTestUnit({
                        name,
                        team,
                        size: info.footprintWidth as 1 | 2,
                        footprintWidth: info.footprintWidth,
                        footprintHeight: info.footprintHeight,
                        attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                    });
                });
                const left = team === PBTypes.TeamVals.LEFT,
                    x = left ? 1 : 14;
                const incumbent = new Map(units.map((unit, index) => [unit.getId(), { x, y: 2 * index + 1 }]));
                let initialized = 0;
                const base: IAIStrategy = {
                    version: "v0.8",
                    placeArmy: () => {
                        initialized++;
                        return incumbent;
                    },
                    decideTurn: (unit) => {
                        expect(initialized).toBe(1);
                        return [{ type: "defend_turn", unitId: unit.getId() }];
                    },
                };
                const legal = new Set(
                    Array.from(
                        { length: 64 },
                        (_, index) => (((left ? 0 : 12) + (index % 4)) << 4) | Math.floor(index / 4),
                    ),
                );
                const context = {
                    team,
                    grid: new Grid(testGridSettings, PBTypes.GridVals.BLOCK_CENTER),
                    sideOrientedPlacement: true,
                    publicOpponentCreatureIds: [creatureIdForName("Zena")!],
                    placement: { possibleCellHashes: () => legal },
                    unitsHolder: { getAllAllies: () => units },
                } as unknown as IPlacementContext;
                const strategy = createV08A19RoleStrategy(family, PBTypes.GridVals.BLOCK_CENTER, base);
                const selected = strategy.placeArmy(units, context),
                    occupied = new Set<number>();
                expect(initialized).toBe(1);
                expect(selected.size).toBe(units.length);
                for (const unit of units)
                    for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                        const hash = (cell.x << 4) | cell.y;
                        expect(legal.has(hash)).toBe(true);
                        expect(occupied.has(hash)).toBe(false);
                        occupied.add(hash);
                    }
                expect(strategy.decideTurn(units[0], {} as never)).toEqual([
                    { type: "defend_turn", unitId: units[0].getId() },
                ]);
                expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
                    { type: "defend_turn", unitId: units[1].getId() },
                ]);
            }
    });
    it("requires an exact v0.8 base", () => {
        const wrong: IAIStrategy = { version: "v0.7", placeArmy: () => new Map(), decideTurn: () => [] };
        expect(() => createV08A19RoleStrategy(names, PBTypes.GridVals.NORMAL, wrong)).toThrow("native v0.8");
    });
    it("initializes its same base exactly once before delegating live and rollout decisions", () => {
        const units = names.map((name) => createTestUnit({ name })),
            incumbent = new Map<string, XY>(units.map((u, i) => [u.getId(), { x: 1, y: i * 2 }]));
        let initialized = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                initialized++;
                return incumbent;
            },
            decideTurn: (u) => {
                expect(initialized).toBe(1);
                return [{ type: "defend_turn", unitId: u.getId() }];
            },
        };
        const context = {
            team: PBTypes.TeamVals.LEFT,
            grid: { getGridType: () => PBTypes.GridVals.NORMAL },
            publicOpponentCreatureIds: [],
            placement: { possibleCellHashes: () => new Set(Array.from({ length: 16 }, (_, y) => (1 << 4) | y)) },
            unitsHolder: { getAllAllies: () => units },
        } as unknown as IPlacementContext;
        const strategy = createV08A19RoleStrategy(names, PBTypes.GridVals.NORMAL, base);
        expect(strategy.placeArmy(units, context)).toEqual(incumbent);
        expect(initialized).toBe(1);
        expect(strategy.decideTurn(units[0], {} as never)).toEqual([{ type: "defend_turn", unitId: units[0].getId() }]);
        expect(strategy.decideTurn(units[1], { decisionOrigin: "rollout" } as never)).toEqual([
            { type: "defend_turn", unitId: units[1].getId() },
        ]);
    });
    it("creates fresh instances without changing ambient AI profile settings", () => {
        const before = { ...process.env };
        const first = createV08A19RoleStrategy(names, PBTypes.GridVals.NORMAL),
            second = createV08A19RoleStrategy(names, PBTypes.GridVals.NORMAL);
        expect(first.version).toBe("v0.8");
        expect(first).not.toBe(second);
        expect(process.env).toEqual(before);
    });
});
