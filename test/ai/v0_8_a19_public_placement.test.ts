import { describe, expect, it } from "bun:test";
import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import {
    disperseRevealedSplashArmy,
    reflectIncumbentPlacement,
    supportAgainstPublicFastFlyer,
    V08A19PublicSplashDispersionStrategy,
} from "../../src/ai/versions/v0_8_a19_public_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { footprintCellsForAnchor } from "../../src/simulation/footprint";
import type { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createTestUnit } from "../helpers/combat";
const fixture = () => {
    const units = [
        createTestUnit({ name: "Frenzied Boar", size: 2, footprintWidth: 2, footprintHeight: 2 }),
        createTestUnit({ name: "Wolf", size: 2, footprintWidth: 2, footprintHeight: 1 }),
        createTestUnit({ name: "Elf", attackType: PBTypes.AttackVals.RANGE }),
    ];
    const legal = new Set<number>();
    for (let x = 0; x < 4; x++) for (let y = 0; y < 16; y++) legal.add((x << 4) | y);
    const incumbent = new Map<string, XY>(units.map((u, i) => [u.getId(), { x: 2, y: [1, 3, 4][i] }]));
    const context = {
        team: PBTypes.TeamVals.LEFT,
        grid: { getGridType: () => PBTypes.GridVals.NORMAL },
        placement: { possibleCellHashes: () => legal },
        publicOpponentCreatureIds: [creatureIdForName("Gargantuan")!],
        unitsHolder: {
            getAllAllies: () => units,
            getAllEnemies: () => {
                throw new Error("Hidden opponent data must not be read during placement");
            },
        },
    } as unknown as IPlacementContext;
    return { units, legal, incumbent, context };
};
const assertLegal = (units: Unit[], placement: Map<string, XY>, legal: Set<number>) => {
    expect(placement.size).toBe(units.length);
    const occupied = new Set<number>();
    for (const unit of units)
        for (const cell of footprintCellsForAnchor(unit, placement.get(unit.getId())!)) {
            const key = (cell.x << 4) | cell.y;
            expect(legal.has(key)).toBe(true);
            expect(occupied.has(key)).toBe(false);
            occupied.add(key);
        }
};
describe("A19 optional public placement", () => {
    it("separates a publicly revealed area attack while keeping square and rectangular bodies legal", () => {
        const { units, legal, incumbent, context } = fixture();
        const selected = disperseRevealedSplashArmy(units, context, incumbent);
        expect(selected).not.toBe(incumbent);
        assertLegal(units, selected, legal);
        for (const unit of units) expect(selected.get(unit.getId())!.x).toBe(incumbent.get(unit.getId())!.x);
    });
    it("retains the incumbent without a public splash threat and rejects incomplete layouts", () => {
        const { units, incumbent, context } = fixture();
        expect(
            disperseRevealedSplashArmy(
                units,
                { ...context, publicOpponentCreatureIds: [creatureIdForName("Pikeman")!] },
                incumbent,
            ),
        ).toBe(incumbent);
        const incomplete = new Map([...incumbent].slice(1));
        expect(disperseRevealedSplashArmy(units, context, incomplete)).toBe(incomplete);
    });
    it("supports a grounded carry against a revealed level4melee flyer without reading its hidden setup", () => {
        const { units, legal, incumbent, context } = fixture();
        const selected = supportAgainstPublicFastFlyer(
            units,
            { ...context, publicOpponentCreatureIds: [creatureIdForName("Angel")!] },
            incumbent,
        );
        expect(selected).not.toBe(incumbent);
        assertLegal(units, selected, legal);
    });
    it("does not repack a partial allied army", () => {
        const { units, incumbent, context } = fixture();
        const partial = {
            ...context,
            publicOpponentCreatureIds: [creatureIdForName("Angel")!],
            unitsHolder: { getAllAllies: () => units.slice(1) },
        } as unknown as IPlacementContext;
        expect(supportAgainstPublicFastFlyer(units, partial, incumbent)).toBe(incumbent);
    });
    it("reflects complete body footprints and restores every anchor after two reflections", () => {
        const { units, legal, incumbent, context } = fixture();
        const reflected = reflectIncumbentPlacement(units, context, incumbent);
        assertLegal(units, reflected, legal);
        expect(reflected.get(units[0].getId())!.y).toBe(15);
        expect(reflected.get(units[1].getId())!.y).toBe(12);
        expect(reflectIncumbentPlacement(units, context, reflected)).toEqual(incumbent);
        const restricted = {
            ...context,
            placement: { possibleCellHashes: () => new Set<number>([0]) },
        } as unknown as IPlacementContext;
        expect(reflectIncumbentPlacement(units, restricted, incumbent)).toBe(incumbent);
    });
    it("initializes the base before changing placement and delegates decisions to that same instance", () => {
        const { units, incumbent, context } = fixture();
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
        const strategy = new V08A19PublicSplashDispersionStrategy(base, true);
        strategy.placeArmy(units, context);
        expect(strategy.getLastPlacementAudit().placementChanged).toBe(true);
        expect(strategy.decideTurn(units[0], {} as never)).toEqual([{ type: "defend_turn", unitId: units[0].getId() }]);
    });
});
