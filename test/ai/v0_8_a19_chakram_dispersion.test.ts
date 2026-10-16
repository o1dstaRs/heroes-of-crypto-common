import { describe, expect, it } from "bun:test";

import type { IAIStrategy, IPlacementContext } from "../../src/ai/ai_strategy";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import {
    disperseRevealedChakramArmy,
    V08A19ChakramDispersionStrategy,
} from "../../src/ai/versions/v0_8_a19_chakram_dispersion";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { footprintCellsForAnchor } from "../../src/simulation/footprint";
import type { XY } from "../../src/utils/math";
import { createTestUnit } from "../helpers/combat";

const chakramId = Array.from({ length: 128 }, (_, id) => id).find((id) =>
    creatureInfo(id)?.abilities.includes("Chakram"),
);
const fixture = () => {
    const units = [
        createTestUnit({ name: "Pikeman" }),
        createTestUnit({ name: "Elf" }),
        createTestUnit({ name: "Medusa" }),
    ];
    const incumbent = new Map<string, XY>(units.map((unit, index) => [unit.getId(), { x: 1, y: index + 1 }]));
    const legal = new Set(Array.from({ length: 16 }, (_, y) => (1 << 4) | y));
    const context = {
        publicOpponentCreatureIds: [chakramId!],
        placement: { possibleCellHashes: () => legal },
    } as unknown as IPlacementContext;
    return { units, incumbent, context, legal };
};

describe("A19 public Chakram placement", () => {
    it("uses a real revealed Chakram identity and separates an adjacent bounce chain legally", () => {
        expect(chakramId).toBeDefined();
        const { units, context, incumbent, legal } = fixture();
        const selected = disperseRevealedChakramArmy(units, context, incumbent);
        expect(selected).not.toBe(incumbent);
        const occupied = new Set<number>();
        for (const unit of units) {
            const anchor = selected.get(unit.getId())!;
            expect(anchor.x).toBe(incumbent.get(unit.getId())!.x);
            for (const cell of footprintCellsForAnchor(unit, anchor)) {
                const hash = (cell.x << 4) | cell.y;
                expect(legal.has(hash)).toBe(true);
                expect(occupied.has(hash)).toBe(false);
                occupied.add(hash);
            }
        }
        const rows = [...selected.values()].map((cell) => cell.y).sort((a, b) => a - b);
        expect(rows[1] - rows[0]).toBeGreaterThan(1);
        expect(rows[2] - rows[1]).toBeGreaterThan(1);
    });

    it("keeps an incumbent when the public roster has no Chakram or the placement is incomplete", () => {
        const { units, context, incumbent } = fixture();
        expect(
            disperseRevealedChakramArmy(
                units,
                { ...context, publicOpponentCreatureIds: [PBTypes.CreatureVals.PIKEMAN] },
                incumbent,
            ),
        ).toBe(incumbent);
        const incomplete = new Map([...incumbent].slice(1));
        expect(disperseRevealedChakramArmy(units, context, incomplete)).toBe(incomplete);
    });

    it("initializes its native base once before an enabled placement change and delegates turns", () => {
        const { units, context, incumbent } = fixture();
        let initialized = false;
        let placements = 0;
        const base: IAIStrategy = {
            version: "v0.8",
            placeArmy: () => {
                initialized = true;
                placements++;
                return incumbent;
            },
            decideTurn: (unit) => {
                expect(initialized).toBe(true);
                return [{ type: "defend_turn", unitId: unit.getId() }];
            },
        };
        const strategy = new V08A19ChakramDispersionStrategy(base, true);
        strategy.placeArmy(units, context);
        expect(placements).toBe(1);
        expect(strategy.getLastPlacementAudit().placementChanged).toBe(true);
        expect(strategy.decideTurn(units[0], {} as never)).toEqual([{ type: "defend_turn", unitId: units[0].getId() }]);
    });
});
