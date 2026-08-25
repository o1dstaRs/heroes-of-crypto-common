import { describe, expect, it } from "bun:test";

import {
    applyTacticalSplitPlacement,
    planTacticalStackSplits,
    tacticalSplitUnitFromUnit,
    type ITacticalSplitUnit,
} from "../../src/ai/tactical_split_placement";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createTestUnit } from "../helpers/combat";

const unit = (overrides: Partial<ITacticalSplitUnit> & Pick<ITacticalSplitUnit, "id">): ITacticalSplitUnit => ({
    id: overrides.id,
    identity: overrides.identity ?? overrides.id,
    amount: overrides.amount ?? 5,
    level: overrides.level ?? 2,
    small: overrides.small ?? true,
    summoned: overrides.summoned ?? false,
    attackType: overrides.attackType ?? PBTypes.AttackVals.MELEE,
    steps: overrides.steps ?? 4,
    hpPerCreature: overrides.hpPerCreature ?? 20,
    auraUtilityCount: overrides.auraUtilityCount ?? 0,
    supportSpellCount: overrides.supportSpellCount ?? 0,
    waterShieldUtilityCount: overrides.waterShieldUtilityCount ?? 0,
    rangedCoverCount: overrides.rangedCoverCount ?? 0,
});

describe("tactical stack splitting", () => {
    it("derives aura and usable support utility from the own live unit only", () => {
        const description = tacticalSplitUnitFromUnit(
            createTestUnit({
                name: "Utility",
                amountAlive: 5,
                abilities: ["Arcane Ward Aura"],
                spells: ["Life:Heal"],
            }),
        );

        expect(description).toMatchObject({
            identity: "Utility:1",
            amount: 5,
            small: true,
            summoned: false,
            auraUtilityCount: 1,
            supportSpellCount: 1,
            waterShieldUtilityCount: 0,
            rangedCoverCount: 0,
        });
    });

    it("recognizes Water Shield and magic attackers as independent split utilities", () => {
        const description = tacticalSplitUnitFromUnit(
            createTestUnit({
                name: "Shielded Mage",
                amountAlive: 5,
                attackType: PBTypes.AttackVals.MAGIC,
                abilities: ["Water Shield"],
            }),
        );

        expect(description).toMatchObject({
            waterShieldUtilityCount: 1,
            rangedCoverCount: 1,
        });
    });

    it("spends only extra slots in aura, single-support, then cheap-mobile bait order", () => {
        const units = [
            unit({ id: "aura-b", level: 3, auraUtilityCount: 1 }),
            unit({ id: "aura-a", level: 1, auraUtilityCount: 1 }),
            unit({ id: "support", supportSpellCount: 2, attackType: PBTypes.AttackVals.MAGIC }),
            unit({ id: "bait-slow", level: 1, hpPerCreature: 14, steps: 3 }),
            unit({ id: "bait-fast", level: 1, hpPerCreature: 14, steps: 6 }),
        ];

        expect(planTacticalStackSplits(units, 9)).toEqual([
            { sourceUnitId: "aura-a", amount: 1, role: "aura" },
            { sourceUnitId: "aura-a", amount: 1, role: "aura" },
            { sourceUnitId: "support", amount: 1, role: "support" },
        ]);
        expect(planTacticalStackSplits(units, 5)).toEqual([]);
        expect(planTacticalStackSplits(units.slice(2), 8)).toEqual([
            { sourceUnitId: "support", amount: 1, role: "support" },
            { sourceUnitId: "bait-fast", amount: 1, role: "bait" },
        ]);
    });

    it("uses every extra utility slot for repeated one-model children from the best aura source", () => {
        const leprechaun = unit({
            id: "leprechaun-full",
            identity: "Leprechaun:1",
            amount: 20,
            auraUtilityCount: 1,
        });

        expect(planTacticalStackSplits([leprechaun], 10)).toEqual([
            { sourceUnitId: "leprechaun-full", amount: 1, role: "aura" },
            { sourceUnitId: "leprechaun-full", amount: 1, role: "aura" },
            { sourceUnitId: "leprechaun-full", amount: 1, role: "aura" },
            { sourceUnitId: "leprechaun-full", amount: 1, role: "aura" },
        ]);
    });

    it("replays Fairy full+1+1 but keeps a one-slot Berserker to one bait child", () => {
        const fairy = unit({
            id: "fairy-full",
            identity: "Fairy:1",
            amount: 20,
            level: 1,
            hpPerCreature: 7,
            steps: 8,
        });
        expect(planTacticalStackSplits([fairy], 8)).toEqual([
            { sourceUnitId: "fairy-full", amount: 1, role: "bait" },
            { sourceUnitId: "fairy-full", amount: 1, role: "bait" },
        ]);

        const berserker = unit({ id: "berserker-full", identity: "Berserker:1", amount: 20 });
        expect(planTacticalStackSplits([berserker], 7)).toEqual([
            { sourceUnitId: "berserker-full", amount: 1, role: "bait" },
        ]);
    });

    it("reserves one-model Water Shield and ranged cover children before generic bait", () => {
        const shield = unit({ id: "mermaid-full", identity: "Mermaid:1", waterShieldUtilityCount: 1 });
        const cover = unit({
            id: "dryad-full",
            identity: "Dryad:1",
            attackType: PBTypes.AttackVals.RANGE,
            rangedCoverCount: 1,
        });
        const bait = unit({ id: "fairy-full", identity: "Fairy:1" });

        expect(planTacticalStackSplits([shield, cover, bait], 8)).toEqual([
            { sourceUnitId: "mermaid-full", amount: 1, role: "shield" },
            { sourceUnitId: "dryad-full", amount: 1, role: "cover" },
        ]);
    });

    it("never splits singles, large or summoned stacks and is idempotent after a child exists", () => {
        const onceSplit = [
            unit({ id: "source", identity: "Monk:2", auraUtilityCount: 1 }),
            unit({ id: "child", identity: "Monk:2", amount: 1, auraUtilityCount: 1 }),
            unit({ id: "single", amount: 1, auraUtilityCount: 1 }),
            unit({ id: "large", small: false, auraUtilityCount: 1 }),
            unit({ id: "summon", summoned: true, auraUtilityCount: 1 }),
        ];

        expect(planTacticalStackSplits(onceSplit, 8)).toEqual([]);
        expect(planTacticalStackSplits([unit({ id: "under-filled", auraUtilityCount: 1 })], 6)).toEqual([]);
    });

    it("places one decoy at an isolated forward corner without moving full stacks", () => {
        const incumbent = new Map([
            ["tank", { x: 7, y: 2 }],
            ["shooter", { x: 8, y: 0 }],
            ["decoy", { x: 6, y: 1 }],
            ["other-split", { x: 9, y: 1 }],
        ]);
        const legal = new Set<number>();
        for (let x = 0; x < 16; x += 1) {
            for (let y = 0; y <= 2; y += 1) legal.add((x << 4) | y);
        }
        const placed = applyTacticalSplitPlacement(
            incumbent,
            ["tank", "shooter", "decoy", "other-split"].map((id) => ({ id, small: true })),
            {
                team: PBTypes.TeamVals.LOWER,
                gridType: PBTypes.GridVals.NORMAL,
                legalCellHashes: legal,
                splitStacks: [
                    { unitId: "decoy", role: "bait" },
                    { unitId: "other-split", role: "aura" },
                ],
            },
        );

        expect(placed.get("tank")).toEqual(incumbent.get("tank"));
        expect(placed.get("shooter")).toEqual(incumbent.get("shooter"));
        expect(placed.get("other-split")).toEqual(incumbent.get("other-split"));
        expect(placed.get("decoy")).toEqual({ x: 0, y: 2 });
    });

    it("mirrors forward placement for the upper army toward decreasing board Y", () => {
        const legal = new Set<number>();
        for (let x = 0; x < 16; x += 1) {
            for (let y = 13; y < 16; y += 1) legal.add((x << 4) | y);
        }
        const placed = applyTacticalSplitPlacement(
            new Map([
                ["tank", { x: 7, y: 13 }],
                ["shooter", { x: 8, y: 15 }],
                ["decoy", { x: 9, y: 14 }],
            ]),
            ["tank", "shooter", "decoy"].map((id) => ({ id, small: true })),
            {
                team: PBTypes.TeamVals.UPPER,
                gridType: PBTypes.GridVals.NORMAL,
                legalCellHashes: legal,
                splitStacks: [{ unitId: "decoy", role: "bait" }],
            },
        );

        expect(placed.get("decoy")).toEqual({ x: 15, y: 13 });
    });

    it("uses the forward center corridor for a utility decoy on Mountains", () => {
        const legal = new Set<number>();
        for (let x = 0; x < 16; x += 1) {
            for (let y = 0; y <= 4; y += 1) legal.add((x << 4) | y);
        }
        const placed = applyTacticalSplitPlacement(
            new Map([
                ["tank", { x: 0, y: 4 }],
                ["decoy", { x: 1, y: 1 }],
            ]),
            [
                { id: "tank", small: true },
                { id: "decoy", small: true },
            ],
            {
                team: PBTypes.TeamVals.LOWER,
                gridType: PBTypes.GridVals.BLOCK_CENTER,
                legalCellHashes: legal,
                splitStacks: [{ unitId: "decoy", role: "aura" }],
            },
        );

        expect([7, 8]).toContain(placed.get("decoy")?.x);
        expect(placed.get("decoy")?.y).toBe(4);
    });

    it("places ranged cover in a protected rear corner", () => {
        const legal = new Set<number>();
        for (let x = 0; x < 16; x += 1) {
            for (let y = 0; y <= 2; y += 1) legal.add((x << 4) | y);
        }
        const placed = applyTacticalSplitPlacement(
            new Map([
                ["tank", { x: 7, y: 2 }],
                ["cover", { x: 8, y: 1 }],
            ]),
            [
                { id: "tank", small: true },
                { id: "cover", small: true },
            ],
            {
                team: PBTypes.TeamVals.LOWER,
                gridType: PBTypes.GridVals.NORMAL,
                legalCellHashes: legal,
                splitStacks: [{ unitId: "cover", role: "cover" }],
            },
        );

        expect(placed.get("cover")).toEqual({ x: 0, y: 0 });
    });
});

describe("tactical split placement with rectangular incumbents", () => {
    const hash = (x: number, y: number): number => (x << 4) | y;
    // Three legal cells only: the 1x2 incumbent's two body cells at the side-board FRONT, and one rear
    // fallback. Correct occupancy leaves exactly the fallback; the small?1:2 fallback used to leave the
    // incumbent's second body cell free — and frontness then picked it, stacking two units on one cell.
    it("a decoy never lands inside a 1x2 incumbent's body once the real sides are supplied", () => {
        const legal = new Set([hash(3, 7), hash(3, 8), hash(1, 1)]);
        const run = (describeRealBody: boolean) =>
            applyTacticalSplitPlacement(
                new Map([
                    ["tower", { x: 3, y: 8 }],
                    ["decoy", { x: 1, y: 1 }],
                ]),
                [
                    describeRealBody
                        ? { id: "tower", small: true, footprintWidth: 1, footprintHeight: 2 }
                        : { id: "tower", small: true },
                    { id: "decoy", small: true },
                ],
                {
                    team: PBTypes.TeamVals.LOWER,
                    gridType: PBTypes.GridVals.NORMAL,
                    legalCellHashes: legal,
                    splitStacks: [{ unitId: "decoy", role: "bait" }],
                    sideOrientedPlacement: true,
                },
            );
        // With the real body both front cells are occupied, so the decoy has to stay on the rear cell.
        expect(run(true).get("decoy")).toEqual({ x: 1, y: 1 });
        // And the test has teeth: the boolean-only description resurrects the collision it pins against.
        expect(run(false).get("decoy")).toEqual({ x: 3, y: 7 });
    });

    it("a cover split respects a 2x1 incumbent's body on the classic axis for the UPPER team", () => {
        // Classic orientation, UPPER: back = high y. The 2x1 incumbent anchored at (8, 14) covers
        // (7, 14) and (8, 14); the only other legal cell is deeper into the board.
        const legal = new Set([hash(7, 14), hash(8, 14), hash(8, 10)]);
        const placed = applyTacticalSplitPlacement(
            new Map([
                ["wagon", { x: 8, y: 14 }],
                ["cover", { x: 8, y: 10 }],
            ]),
            [
                { id: "wagon", small: false, footprintWidth: 2, footprintHeight: 1 },
                { id: "cover", small: true },
            ],
            {
                team: PBTypes.TeamVals.UPPER,
                gridType: PBTypes.GridVals.NORMAL,
                legalCellHashes: legal,
                splitStacks: [{ unitId: "cover", role: "cover" }],
            },
        );
        expect(placed.get("cover")).toEqual({ x: 8, y: 10 });
    });

    it("every placement it returns is overlap-free across mixed rectangular bodies", () => {
        // A denser board: 1x2 + 2x1 + 2x2 incumbents and two split stacks over a full side zone.
        const legal = new Set<number>();
        for (let x = 1; x <= 3; x++) {
            for (let y = 1; y <= 14; y++) {
                legal.add(hash(x, y));
            }
        }
        const units = [
            { id: "tower", small: true, footprintWidth: 1, footprintHeight: 2 },
            { id: "wagon", small: false, footprintWidth: 2, footprintHeight: 1 },
            { id: "giant", small: false, footprintWidth: 2, footprintHeight: 2 },
            { id: "decoy", small: true, footprintWidth: 1, footprintHeight: 1 },
            { id: "cover", small: true },
        ];
        const placed = applyTacticalSplitPlacement(
            new Map([
                ["tower", { x: 3, y: 8 }],
                ["wagon", { x: 2, y: 4 }],
                ["giant", { x: 2, y: 11 }],
                ["decoy", { x: 1, y: 1 }],
                ["cover", { x: 1, y: 14 }],
            ]),
            units,
            {
                team: PBTypes.TeamVals.LOWER,
                gridType: PBTypes.GridVals.NORMAL,
                legalCellHashes: legal,
                splitStacks: [
                    { unitId: "decoy", role: "bait" },
                    { unitId: "cover", role: "cover" },
                ],
                sideOrientedPlacement: true,
            },
        );
        const seen = new Set<number>();
        for (const placementUnit of units) {
            const base = placed.get(placementUnit.id)!;
            const width = placementUnit.footprintWidth ?? (placementUnit.small ? 1 : 2);
            const height = placementUnit.footprintHeight ?? (placementUnit.small ? 1 : 2);
            for (let dx = 0; dx < width; dx++) {
                for (let dy = 0; dy < height; dy++) {
                    const key = hash(base.x - dx, base.y - dy);
                    expect(seen.has(key)).toBe(false);
                    seen.add(key);
                }
            }
        }
        // The moved stacks must also have stayed inside the legal zone.
        expect(legal.has(hash(placed.get("decoy")!.x, placed.get("decoy")!.y))).toBe(true);
        expect(legal.has(hash(placed.get("cover")!.x, placed.get("cover")!.y))).toBe(true);
    });
});
