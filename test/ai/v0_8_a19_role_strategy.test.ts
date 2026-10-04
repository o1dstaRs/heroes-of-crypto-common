import { describe, expect, it } from "bun:test";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import { createV08A19RoleStrategy } from "../../src/ai/versions/v0_8_a19_role_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { XY } from "../../src/utils/math";
import { createTestUnit } from "../helpers/combat";
const names = ["Dryad", "Troll", "Fairy", "Medusa", "Monk", "Magic Dragon"];
describe("A19 optional role placement composition", () => {
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
