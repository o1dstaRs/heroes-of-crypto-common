import { describe, expect, it } from "bun:test";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import { createV08A19RoleStrategy } from "../../src/ai/versions/v0_8_a19_role_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { XY } from "../../src/utils/math";
import { Grid } from "../../src/grid/grid";
import { createTestUnit, testGridSettings } from "../helpers/combat";
import { creatureInfo, creatureIdForName } from "../../src/ai/setup/creature_score";
import { footprintCellsForAnchor } from "../../src/simulation/footprint";
const names = ["Dryad", "Troll", "Fairy", "Medusa", "Monk", "Magic Dragon"];
describe("A19 optional role placement composition", () => {
    it("spreads a left blocked caster battery legally while preserving other seats and maps", () => {
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
                if (gridType === PBTypes.GridVals.BLOCK_CENTER && team === PBTypes.TeamVals.LEFT) {
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
