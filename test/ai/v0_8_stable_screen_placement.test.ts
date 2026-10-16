import { describe, expect, test } from "bun:test";
import { stabilizeV08RangedScreen } from "../../src/ai/versions/v0_8_stable_screen_placement";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import type { IPlacementContext } from "../../src/ai/ai_strategy";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { PathHelper } from "../../src/grid/path_helper";
import { footprintCellsForAnchor } from "../../src/simulation/footprint";
import { createCombatTestContext, createTestUnit, testGridSettings } from "../helpers/combat";

function fixture(mirror = false) {
    const combat = createCombatTestContext(),
        team = mirror ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const units = [
        createTestUnit({
            team,
            name: "Beholder",
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            amountAlive: 20,
        }),
        createTestUnit({ team, name: "Cyclops", attackType: PBTypes.AttackVals.RANGE, rangeShots: 5, amountAlive: 8 }),
        createTestUnit({
            team,
            name: "Frenzied Boar",
            abilities: ["AI Driven"],
            size: PBTypes.UnitSizeVals.LARGE,
            amountAlive: 2,
        }),
        createTestUnit({
            team,
            name: "Wolf",
            size: PBTypes.UnitSizeVals.LARGE,
            footprintWidth: 2,
            footprintHeight: 1,
            amountAlive: 30,
        }),
        createTestUnit({ team, name: "Peasant", amountAlive: 60 }),
    ];
    const anchors = [
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 4 },
        { x: 2, y: 7 },
        { x: 3, y: 1 },
    ];
    const incumbent = new Map(
        units.map((u, i) => [
            u.getId(),
            { ...anchors[i], x: mirror ? 15 - anchors[i].x + u.getFootprintWidth() - 1 : anchors[i].x },
        ]),
    );
    const context: IPlacementContext = {
        ...combat,
        team,
        pathHelper: new PathHelper(testGridSettings),
        sideOrientedPlacement: true,
        placement: new RectanglePlacement(
            testGridSettings,
            mirror ? PlacementPositionType.RIGHT_TOP : PlacementPositionType.LEFT_BOTTOM,
            3,
            true,
        ),
        publicOpponentCreatureIds: [creatureIdForName("Thunderbird")!],
    };
    return { units, incumbent, context };
}
function openLandings(f: ReturnType<typeof fixture>, p: Map<string, { x: number; y: number }>) {
    const occupied = new Set(
        f.units
            .filter((u) => !u.hasAbilityActive("AI Driven"))
            .flatMap((u) => footprintCellsForAnchor(u, p.get(u.getId())!).map((c) => `${c.x},${c.y}`)),
    );
    let count = 0;
    for (const ward of f.units.slice(0, 2))
        for (let x = 1; x < 16; x++)
            for (let y = 1; y < 16; y++) {
                const cells = [
                    { x, y },
                    { x: x - 1, y },
                    { x, y: y - 1 },
                    { x: x - 1, y: y - 1 },
                ];
                const w = p.get(ward.getId())!;
                if (
                    cells.every((c) => !occupied.has(`${c.x},${c.y}`)) &&
                    cells.some((c) => Math.max(Math.abs(c.x - w.x), Math.abs(c.y - w.y)) === 1)
                )
                    count++;
            }
    return count;
}
describe("experimental mindless-aware ranged screen placement", () => {
    test("nearest relocation leaves a still-legal mindless body in place while repairing the screen", () => {
        const f = fixture();
        const boar = f.units[2];
        f.incumbent.set(boar.getId(), { x: 2, y: 14 });
        const result = stabilizeV08RangedScreen(f.units, f.context, f.incumbent, "nearest");
        expect(result).not.toBe(f.incumbent);
        expect(result.get(boar.getId())).toEqual(f.incumbent.get(boar.getId()));
        expect(openLandings(f, result)).toBeLessThan(openLandings(f, f.incumbent));
    });
    test("nearest relocation displaces an obstructing mindless body only as far as necessary on either side", () => {
        for (const mirror of [false, true]) {
            const f = fixture(mirror),
                boar = f.units[2];
            const result = stabilizeV08RangedScreen(f.units, f.context, f.incumbent, "nearest");
            const original = f.incumbent.get(boar.getId())!;
            const travel = (c: { x: number; y: number }) =>
                Math.max(Math.abs(c.x - original.x), Math.abs(c.y - original.y));
            const legal = f.context.placement.possibleCellHashes();
            const taken = new Set(
                f.units
                    .filter((u) => u !== boar)
                    .flatMap((u) => footprintCellsForAnchor(u, result.get(u.getId())!).map((c) => (c.x << 4) | c.y)),
            );
            const available = [...legal]
                .map((h) => ({ x: h >> 4, y: h & 15 }))
                .filter((base) =>
                    footprintCellsForAnchor(boar, base).every(
                        (c) => legal.has((c.x << 4) | c.y) && !taken.has((c.x << 4) | c.y),
                    ),
                );
            expect(result.get(boar.getId())).not.toEqual(original);
            expect(travel(result.get(boar.getId())!)).toBe(Math.min(...available.map(travel)));
            expect(openLandings(f, result)).toBeLessThan(openLandings(f, f.incumbent));
            for (const ward of f.units.slice(0, 2))
                expect(result.get(ward.getId())).toEqual(f.incumbent.get(ward.getId()));
        }
    });
    test("the original forward research variant remains the default for reproducible comparisons", () => {
        const f = fixture();
        expect(stabilizeV08RangedScreen(f.units, f.context, f.incumbent)).toEqual(
            stabilizeV08RangedScreen(f.units, f.context, f.incumbent, "forward"),
        );
    });
    test("improves protection after the mindless body leaves while preserving shooters and legal footprints", () => {
        const f = fixture(),
            before = JSON.stringify([...f.incumbent]),
            result = stabilizeV08RangedScreen(f.units, f.context, f.incumbent);
        expect(result).not.toBe(f.incumbent);
        expect(openLandings(f, result)).toBeLessThan(openLandings(f, f.incumbent));
        expect(JSON.stringify([...f.incumbent])).toBe(before);
        for (const ward of f.units.slice(0, 2)) expect(result.get(ward.getId())).toEqual(f.incumbent.get(ward.getId()));
        const taken = new Set<number>(),
            legal = f.context.placement.possibleCellHashes();
        for (const u of f.units)
            for (const c of footprintCellsForAnchor(u, result.get(u.getId())!)) {
                const k = (c.x << 4) | c.y;
                expect(legal.has(k)).toBe(true);
                expect(taken.has(k)).toBe(false);
                taken.add(k);
            }
    });
    test("has the same protection improvement when physically mirrored", () => {
        const a = fixture(),
            b = fixture(true);
        const ra = stabilizeV08RangedScreen(a.units, a.context, a.incumbent),
            rb = stabilizeV08RangedScreen(b.units, b.context, b.incumbent);
        expect(openLandings(a, ra)).toBe(openLandings(b, rb));
        expect(openLandings(a, ra)).toBeLessThan(openLandings(a, a.incumbent));
    });
    test("does not inspect hidden opposing units or positions", () => {
        const f = fixture();
        f.context.unitsHolder = new Proxy(f.context.unitsHolder, {
            get() {
                throw new Error("Hidden engine state read");
            },
        });
        expect(() => stabilizeV08RangedScreen(f.units, f.context, f.incumbent)).not.toThrow();
    });
    test("preserves an incomplete or no-public-threat setup", () => {
        const f = fixture();
        expect(stabilizeV08RangedScreen(f.units, { ...f.context, publicOpponentCreatureIds: [] }, f.incumbent)).toBe(
            f.incumbent,
        );
        const partial = new Map(f.incumbent);
        partial.delete(f.units[0].getId());
        expect(stabilizeV08RangedScreen(f.units, f.context, partial)).toBe(partial);
    });
});
