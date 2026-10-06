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
    it("reflects Blocked buff and volley artillery on both sides while preserving split units and combat initialization", () => {
        for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT])
            for (const split of [false, true]) {
                const ownNames = ["Wandering Mage", "Beholder", "Peasant", "Hyena", "Zena", "Tsar Cannon"];
                if (split) ownNames.push(ownNames[0]);
                const units = ownNames.map((name) => {
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
                const left = team === PBTypes.TeamVals.LEFT;
                const incumbent = new Map(
                    units.map((unit, index) => [unit.getId(), { x: left ? 1 : 14, y: 2 * index + 1 }]),
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
                    grid: new Grid(testGridSettings, PBTypes.GridVals.BLOCK_CENTER),
                    sideOrientedPlacement: true,
                    publicOpponentCreatureIds: [],
                    placement: { possibleCellHashes: () => legal },
                    unitsHolder: { getAllAllies: () => units },
                } as unknown as IPlacementContext;
                const strategy = createV08A19RoleStrategy(ownNames, PBTypes.GridVals.BLOCK_CENTER, base);
                const selected = strategy.placeArmy(units, context);
                expect(selected).toEqual(reflectIncumbentPlacement(units, context, incumbent));
                expect(initialized).toBe(1);
                expect(selected.size).toBe(units.length);
                const occupied = new Set<number>();
                for (const unit of units)
                    for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                        const hash = (cell.x << 4) | cell.y;
                        expect(legal.has(hash)).toBe(true);
                        expect(occupied.has(hash)).toBe(false);
                        occupied.add(hash);
                    }
                const live = {} as never,
                    rollout = { decisionOrigin: "rollout" } as never;
                for (const decisionContext of [live, rollout])
                    expect(strategy.decideTurn(units[0], decisionContext)).toEqual([
                        { type: "defend_turn", unitId: units[0].getId() },
                    ]);
                expect(decisions).toEqual([live, rollout]);
                expect(initialized).toBe(1);
            }
    });
    it("retains Dense Flesh RIGHT and unbuffered artillery, and rolls back a mismatched or illegal reflected footprint", () => {
        const families = [
            ["Berserker", "Battle Mage", "Centaur", "Medusa", "Cyclops", "Abomination"],
            ["Battle Mage", "Beholder", "Peasant", "Hyena", "Zena", "Tsar Cannon"],
            ["Wandering Mage", "Beholder", "Peasant", "Hyena", "Medusa", "Tsar Cannon"],
        ];
        for (const ownNames of families) {
            const units = ownNames.map((name) => {
                const info = creatureInfo(creatureIdForName(name)!)!;
                return createTestUnit({
                    name,
                    team: PBTypes.TeamVals.RIGHT,
                    size: info.footprintWidth as 1 | 2,
                    footprintWidth: info.footprintWidth,
                    footprintHeight: info.footprintHeight,
                    attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                });
            });
            const incumbent = new Map(units.map((unit, index) => [unit.getId(), { x: 14, y: 2 * index + 1 }]));
            const base: IAIStrategy = { version: "v0.8", placeArmy: () => incumbent, decideTurn: () => [] };
            const context = {
                team: PBTypes.TeamVals.RIGHT,
                grid: new Grid(testGridSettings, PBTypes.GridVals.BLOCK_CENTER),
                sideOrientedPlacement: true,
                publicOpponentCreatureIds: [],
                placement: {
                    possibleCellHashes: () =>
                        new Set(Array.from({ length: 64 }, (_, i) => ((12 + (i % 4)) << 4) | Math.floor(i / 4))),
                },
                unitsHolder: { getAllAllies: () => units },
            } as unknown as IPlacementContext;
            expect(
                createV08A19RoleStrategy(ownNames, PBTypes.GridVals.BLOCK_CENTER, base).placeArmy(units, context),
            ).toEqual(incumbent);
        }
        const unit = createTestUnit({
            name: "Tsar Cannon",
            team: PBTypes.TeamVals.RIGHT,
            size: 2,
            footprintWidth: 2,
            footprintHeight: 1,
        });
        const incumbent = new Map([[unit.getId(), { x: 14, y: 1 }]]);
        let initialized = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                initialized++;
                return incumbent;
            },
            decideTurn: () => [],
        };
        const strategy = createV08A19RoleStrategy(
            ["Wandering Mage", "Beholder", "Peasant", "Hyena", "Zena", "Tsar Cannon"],
            PBTypes.GridVals.BLOCK_CENTER,
            base,
        );
        const context = {
            team: PBTypes.TeamVals.RIGHT,
            grid: new Grid(testGridSettings, PBTypes.GridVals.NORMAL),
            sideOrientedPlacement: true,
            publicOpponentCreatureIds: [],
            placement: { possibleCellHashes: () => new Set([(14 << 4) | 1, (15 << 4) | 1]) },
            unitsHolder: { getAllAllies: () => [unit] },
        } as unknown as IPlacementContext;
        expect(strategy.placeArmy([unit], context)).toEqual(incumbent);
        context.grid = new Grid(testGridSettings, PBTypes.GridVals.BLOCK_CENTER);
        expect(strategy.placeArmy([unit], context)).toEqual(incumbent);
        expect(initialized).toBe(2);
    });
    it("reflects a Normal physical battery only on RIGHT while preserving other maps, split identities and its combat delegate", () => {
        for (const gridType of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER])
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT])
                for (const split of [false, true]) {
                    const ownNames = ["Mermaid", "Hyena", "Arbalester", "Medusa", "Cyclops", "Frenzied Boar"];
                    if (split) ownNames.push(ownNames[0]);
                    const units = ownNames.map((name) => {
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
                    const left = team === PBTypes.TeamVals.LEFT;
                    const incumbent = new Map(
                        units.map((unit, index) => [unit.getId(), { x: left ? 1 : 14, y: 2 * index + 1 }]),
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
                        Array.from(
                            { length: 64 },
                            (_, index) => (((left ? 0 : 12) + (index % 4)) << 4) | Math.floor(index / 4),
                        ),
                    );
                    const context = {
                        team,
                        grid: new Grid(testGridSettings, gridType),
                        sideOrientedPlacement: true,
                        publicOpponentCreatureIds: [],
                        placement: { possibleCellHashes: () => legal },
                        unitsHolder: { getAllAllies: () => units },
                    } as unknown as IPlacementContext;
                    const strategy = createV08A19RoleStrategy(ownNames, gridType, base);
                    const selected = strategy.placeArmy(units, context);
                    // Blocked already has its independently measured RIGHT reflection.
                    const reflect = !left && gridType !== PBTypes.GridVals.LAVA_CENTER;
                    expect(selected).toEqual(
                        reflect ? reflectIncumbentPlacement(units, context, incumbent) : incumbent,
                    );
                    expect(initialized).toBe(1);
                    const occupied = new Set<number>();
                    for (const unit of units)
                        for (const cell of footprintCellsForAnchor(unit, selected.get(unit.getId())!)) {
                            const hash = (cell.x << 4) | cell.y;
                            expect(legal.has(hash)).toBe(true);
                            expect(occupied.has(hash)).toBe(false);
                            occupied.add(hash);
                        }
                    const live = {} as any,
                        rollout = { forRollout: true } as any;
                    expect(strategy.decideTurn(units[0], live)).toEqual([
                        { type: "defend_turn", unitId: units[0].getId() },
                    ]);
                    expect(strategy.decideTurn(units[0], rollout)).toEqual([
                        { type: "defend_turn", unitId: units[0].getId() },
                    ]);
                    expect(decisions).toEqual([live, rollout]);
                }
    });
    it("retains other Normal roles, mismatched contexts and an incumbent whose reflected footprint is illegal", () => {
        const families = [
            ["Wandering Mage", "Hyena", "Arbalester", "Medusa", "Cyclops", "Frenzied Boar"],
            ["Elf", "Hyena", "Arbalester", "Medusa", "Cyclops", "Frenzied Boar"],
            ["Mermaid", "Hyena", "Wolf", "Medusa", "Cyclops", "Frenzied Boar"],
            ["Mermaid", "Hyena", "Arbalester", "Medusa", "Cyclops", "Angel"],
            ["Mermaid", "Hyena", "Arbalester", "Wolf", "Cyclops", "Gargantuan"],
            ["Mermaid", "Hyena", "Arbalester", "Wolf", "Cyclops", "Tsar Cannon"],
            ["Mermaid", "Hyena", "Arbalester", "Medusa", "Cyclops", "Abomination"],
        ];
        for (const ownNames of families) {
            const units = ownNames.map((name) => {
                const i = creatureInfo(creatureIdForName(name)!)!;
                return createTestUnit({
                    name,
                    team: PBTypes.TeamVals.RIGHT,
                    size: i.footprintWidth as 1 | 2,
                    footprintWidth: i.footprintWidth,
                    footprintHeight: i.footprintHeight,
                    attackType: i.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                });
            });
            const incumbent = new Map(units.map((u, index) => [u.getId(), { x: 14, y: 2 * index + 1 }]));
            const base: IAIStrategy = { version: "v0.8", placeArmy: () => incumbent, decideTurn: () => [] };
            const context = {
                team: PBTypes.TeamVals.RIGHT,
                grid: new Grid(testGridSettings, PBTypes.GridVals.NORMAL),
                sideOrientedPlacement: true,
                publicOpponentCreatureIds: [],
                placement: {
                    possibleCellHashes: () =>
                        new Set(Array.from({ length: 64 }, (_, i) => ((12 + (i % 4)) << 4) | Math.floor(i / 4))),
                },
                unitsHolder: { getAllAllies: () => units },
            } as unknown as IPlacementContext;
            expect(createV08A19RoleStrategy(ownNames, PBTypes.GridVals.NORMAL, base).placeArmy(units, context)).toEqual(
                incumbent,
            );
        }
        const unit = createTestUnit({ name: "Arbalester", team: PBTypes.TeamVals.RIGHT });
        const incumbent = new Map([[unit.getId(), { x: 14, y: 1 }]]);
        const base: IAIStrategy = { version: "v0.8", placeArmy: () => incumbent, decideTurn: () => [] };
        const strategy = createV08A19RoleStrategy(
            ["Mermaid", "Hyena", "Arbalester", "Medusa", "Cyclops", "Frenzied Boar"],
            PBTypes.GridVals.NORMAL,
            base,
        );
        const context = {
            team: PBTypes.TeamVals.RIGHT,
            grid: new Grid(testGridSettings, PBTypes.GridVals.LAVA_CENTER),
            sideOrientedPlacement: true,
            publicOpponentCreatureIds: [],
            placement: { possibleCellHashes: () => new Set([(14 << 4) | 1]) },
            unitsHolder: { getAllAllies: () => [unit] },
        } as unknown as IPlacementContext;
        expect(strategy.placeArmy([unit], context)).toEqual(incumbent);
        context.grid = new Grid(testGridSettings, PBTypes.GridVals.NORMAL);
        expect(strategy.placeArmy([unit], context)).toEqual(incumbent);
    });
    it("protects a sparse Blocked spell carry with flying melee support and reflects other carries only on RIGHT", () => {
        const families: { names: string[]; reflection: "both" | "right" | "none" }[] = [
            { names: ["Wolf", "Medusa", "Fairy", "Troll", "Zena", "Magic Dragon"], reflection: "both" },
            { names: ["Peasant", "Troll", "Orc", "Medusa", "Griffin", "Magic Dragon"], reflection: "both" },
            { names: ["Peasant", "Troll", "Beholder", "Trent", "Zena", "Magic Dragon"], reflection: "none" },
            { names: ["Peasant", "Wolf", "Elf", "Trent", "Medusa", "Magic Dragon"], reflection: "none" },
            { names: ["Wolf Rider", "Elf", "Wandering Mage", "Trent", "Zena", "Angel"], reflection: "right" },
            {
                names: ["Squire", "Battle Mage", "Centaur", "Trent", "Goblin Knight", "Tsar Cannon"],
                reflection: "right",
            },
            { names: ["Squire", "Trent", "Dryad", "Battle Mage", "Zena", "Behemoth"], reflection: "right" },
            {
                names: ["Orc", "Manticore", "Peasant", "Battle Mage", "Goblin Knight", "Gargantuan"],
                reflection: "right",
            },
            { names: ["Squire", "Trent", "Dryad", "Battle Mage", "Elf", "Frenzied Boar"], reflection: "none" },
        ];
        for (const family of families)
            for (const team of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT])
                for (const split of [false, true]) {
                    const left = team === PBTypes.TeamVals.LEFT;
                    const names = split ? [...family.names, family.names[0]] : family.names;
                    const units = names.map((name) => {
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
                        units.map((unit, index) => [unit.getId(), { x: left ? 1 : 14, y: 2 * index + 1 }]),
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
                        Array.from(
                            { length: 64 },
                            (_, index) => (((left ? 0 : 12) + (index % 4)) << 4) | Math.floor(index / 4),
                        ),
                    );
                    const context = {
                        team,
                        grid: new Grid(testGridSettings, PBTypes.GridVals.BLOCK_CENTER),
                        sideOrientedPlacement: true,
                        publicOpponentCreatureIds: [],
                        placement: { possibleCellHashes: () => legal },
                        unitsHolder: { getAllAllies: () => units },
                    } as unknown as IPlacementContext;
                    const strategy = createV08A19RoleStrategy(names, PBTypes.GridVals.BLOCK_CENTER, base);
                    const selected = strategy.placeArmy(units, context);
                    const reflect = family.reflection === "both" || (family.reflection === "right" && !left);
                    expect(selected).toEqual(
                        reflect ? reflectIncumbentPlacement(units, context, incumbent) : incumbent,
                    );
                    expect(initialized).toBe(1);
                    expect(selected.size).toBe(units.length);
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
                    expect(decisions).toEqual([liveContext, rolloutContext]);
                }
    });
    it("retains a sparse caster formation on other maps, a mismatched context, or an illegal reflected footprint", () => {
        const names = ["Wolf Rider", "Elf", "Wandering Mage", "Trent", "Zena", "Angel"];
        for (const [selectedMap, actualMap, restrictCells] of [
            [PBTypes.GridVals.NORMAL, PBTypes.GridVals.NORMAL, false],
            [PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.LAVA_CENTER, false],
            [PBTypes.GridVals.BLOCK_CENTER, PBTypes.GridVals.NORMAL, false],
            [PBTypes.GridVals.BLOCK_CENTER, PBTypes.GridVals.BLOCK_CENTER, true],
        ] as const) {
            const units = names.map((name) => {
                const info = creatureInfo(creatureIdForName(name)!)!;
                return createTestUnit({
                    name,
                    team: PBTypes.TeamVals.RIGHT,
                    size: info.footprintWidth as 1 | 2,
                    footprintWidth: info.footprintWidth,
                    footprintHeight: info.footprintHeight,
                    attackType: info.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
                });
            });
            const incumbent = new Map(units.map((unit, index) => [unit.getId(), { x: 14, y: 2 * index + 1 }]));
            let initialized = 0;
            const base: IAIStrategy = {
                version: "v0.8",
                placeArmy: () => {
                    initialized++;
                    return incumbent;
                },
                decideTurn: () => [],
            };
            const legal = new Set(
                restrictCells
                    ? units.flatMap((unit) =>
                          footprintCellsForAnchor(unit, incumbent.get(unit.getId())!).map(
                              (cell) => (cell.x << 4) | cell.y,
                          ),
                      )
                    : Array.from({ length: 64 }, (_, index) => ((12 + (index % 4)) << 4) | Math.floor(index / 4)),
            );
            const context = {
                team: PBTypes.TeamVals.RIGHT,
                grid: new Grid(testGridSettings, actualMap),
                sideOrientedPlacement: true,
                publicOpponentCreatureIds: [],
                placement: { possibleCellHashes: () => legal },
                unitsHolder: { getAllAllies: () => units },
            } as unknown as IPlacementContext;
            expect(createV08A19RoleStrategy(names, selectedMap, base).placeArmy(units, context)).toEqual(incumbent);
            expect(initialized).toBe(1);
        }
    });
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
    it("reflects an ordinary physical battery on Normal and Blocked RIGHT while retaining LEFT and Lava", () => {
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
                if (gridType !== PBTypes.GridVals.LAVA_CENTER && !left) {
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
