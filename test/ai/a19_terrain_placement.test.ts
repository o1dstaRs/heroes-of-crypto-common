import { expect, test } from "bun:test";

import {
    chooseA19TerrainPlacement,
    A19_TERRAIN_PLACEMENT_POLICY,
    type TerrainPlacementUnit,
} from "../../src/ai/placement/terrain_reflection";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Grid } from "../../src/grid/grid";
import { getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { GridSettings } from "../../src/grid/grid_settings";
import { scatteredMountainsForSeed } from "../../src/grid/scattered_mountains";
import { makeRng } from "../../src/simulation/army";
import { captureDeterministicRandomState, setDeterministicRandomSource } from "../../src/utils/lib";
import fixture from "./fixtures/a19_terrain_placement.json";

function parts(sample = fixture.cases[0]) {
    const units: TerrainPlacementUnit[] = sample.bodies.map((body, index) => ({
        getId: () => `stack-${index}`,
        getName: () => body.name,
        getAmountAlive: () => body.amount,
        getFootprintWidth: () => body.width,
        getFootprintHeight: () => body.height,
        getAttackType: () => body.attackType,
        canFly: () => body.fly,
        isSmallSize: () => body.small,
        canTraverseLava: () => body.lava,
        hasAbilityActive: (name) => name === "In Its Own World" && body.vine,
    }));
    const settings = sample.settings as [number, number, number, number, number, number, number];
    return {
        units,
        incumbent: new Map(units.map((unit, index) => [unit.getId(), { ...sample.incumbent[index] }])),
        context: {
            team: sample.team,
            gridType: sample.gridType,
            publicMapSeed: sample.publicMapSeed,
            gridSettings: new GridSettings(...settings),
            sideOrientedPlacement: true,
            legalCellHashes: new Set(sample.legal),
        },
    };
}

test("the adopted serving choice exactly reproduces all 72 registered openings, including 34 reflections", () => {
    FightStateManager.getInstance().reset();
    // Native draft/placement has already initialized the catalog before the measured policy call.
    const cyclops = creatureInfo(PBTypes.CreatureVals.CYCLOPS)!;
    const liveCost = cyclops.exp;
    // The registered openings use the original Cyclops stack cost.
    cyclops.exp = 140;
    setDeterministicRandomSource(makeRng(17112026));
    const rng = captureDeterministicRandomState();
    let changed = 0;
    try {
        for (const sample of fixture.cases) {
            const { units, incumbent, context } = parts(sample);
            const before = JSON.stringify([...incumbent]);
            const choice = chooseA19TerrainPlacement(units, context, incumbent);
            expect([...choice.positions.values()]).toEqual(sample.expected);
            expect(choice.baselineCost).toBe(sample.diagnostic.baselineCost);
            expect(choice.reflectedCost).toBe(sample.diagnostic.reflectedCost);
            expect(choice.changed).toBe(sample.diagnostic.changed);
            expect(JSON.stringify([...incumbent])).toBe(before);
            const grid = new Grid(context.gridSettings, 4);
            grid.setScatteredMountains(scatteredMountainsForSeed(context.publicMapSeed).map((stone) => stone.cell));
            for (let index = 0; index < units.length; index++) {
                const unit = units[index],
                    anchor = choice.positions.get(unit.getId())!;
                const cells = getFootprintCellsForAnchor(anchor, unit.getFootprintWidth(), unit.getFootprintHeight());
                expect(grid.occupyCells(cells, unit.getId(), context.team, 1, unit.canTraverseLava(), false)).toBe(
                    true,
                );
                expect(cells.every((cell) => context.legalCellHashes.has((cell.x << 4) | cell.y))).toBe(true);
                expect(anchor.x).toBe(sample.incumbent[index].x);
            }
            changed += Number(choice.changed);
        }
        expect(changed).toBe(34);
        expect(captureDeterministicRandomState()).toEqual(rng);
        expect(A19_TERRAIN_PLACEMENT_POLICY.researchSourceSha256).toBe(fixture.sourceSha256);
        expect(A19_TERRAIN_PLACEMENT_POLICY.adoptedByUser).toBe(true);
        expect(A19_TERRAIN_PLACEMENT_POLICY.registeredStrengthGatePassed).toBe(false);
    } finally {
        cyclops.exp = liveCost;
        setDeterministicRandomSource(undefined);
    }
});

test("reflection preserves rectangular ally distances and is idempotent", () => {
    FightStateManager.getInstance().reset();
    const sample = fixture.cases.find(
        (sample) => sample.diagnostic.changed && sample.bodies.some((body) => body.width !== body.height),
    )!;
    expect(sample).toBeDefined();
    const { units, context, incumbent } = parts(sample);
    const choice = chooseA19TerrainPlacement(units, context, incumbent);
    const centers = (positions: typeof incumbent) =>
        units.map((unit) => {
            const p = positions.get(unit.getId())!;
            return { x: p.x - (unit.getFootprintWidth() - 1) / 2, y: p.y - (unit.getFootprintHeight() - 1) / 2 };
        });
    const before = centers(incumbent),
        after = centers(choice.positions);
    for (let i = 0; i < units.length; i++)
        for (let j = 0; j < units.length; j++) {
            expect(Math.abs(after[i].x - after[j].x)).toBe(Math.abs(before[i].x - before[j].x));
            expect(Math.abs(after[i].y - after[j].y)).toBe(Math.abs(before[i].y - before[j].y));
        }
    expect(chooseA19TerrainPlacement(units, context, choice.positions).positions).toEqual(choice.positions);
    expect(chooseA19TerrainPlacement(units, context, choice.positions).changed).toBe(false);
});

test("unsupported maps, missing/illegal inputs and ties keep a detached incumbent", () => {
    FightStateManager.getInstance().reset();
    const { units, context, incumbent } = parts();
    for (const changes of [
        { gridType: 1 },
        { gridType: 3 },
        { gridType: 2 },
        { sideOrientedPlacement: false },
        { publicMapSeed: "" },
        { team: 0 },
        { legalCellHashes: new Set<number>() },
    ]) {
        const choice = chooseA19TerrainPlacement(units, { ...context, ...changes }, incumbent);
        expect(choice.positions).toEqual(incumbent);
        expect(choice.positions).not.toBe(incumbent);
        expect(choice.positions.values().next().value).not.toBe(incumbent.values().next().value);
        expect(choice.changed).toBe(false);
    }
    const malformed = new Map(incumbent);
    malformed.set(units[0].getId(), { x: 1, y: 16 });
    expect(chooseA19TerrainPlacement(units, context, malformed).positions).toEqual(malformed);
    expect(chooseA19TerrainPlacement(units.slice(1), context, incumbent).changed).toBe(false);
    const flyers = units.map((unit) => ({ ...unit, getAttackType: () => 1, canFly: () => true }));
    const tie = chooseA19TerrainPlacement(flyers, context, incumbent);
    expect(tie.baselineCost).toBe(0);
    expect(tie.reflectedCost).toBe(0);
    expect(tie.positions).toEqual(incumbent);
});

test("changing hidden-state decoys cannot enter the public placement projection", () => {
    FightStateManager.getInstance().reset();
    const { units, context, incumbent } = parts(fixture.cases.find((sample) => sample.diagnostic.changed)!);
    const expected = chooseA19TerrainPlacement(units, context, incumbent);
    const guarded = new Proxy(context, {
        get(target, property) {
            if (!(property in target)) throw new Error(`Private placement read: ${String(property)}`);
            return Reflect.get(target, property);
        },
    });
    expect(chooseA19TerrainPlacement(units, guarded, incumbent)).toEqual(expected);
});
