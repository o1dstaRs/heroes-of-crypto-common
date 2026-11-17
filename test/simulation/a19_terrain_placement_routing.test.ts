import { expect, test } from "bun:test";

import { chooseA19TerrainPlacement } from "../../src/ai/placement/terrain_reflection";
import { createV08A19Strategy } from "../../src/ai/versions/v0_8_a19_profile";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { runMatch, type IMatchConfig } from "../../src/simulation/battle_engine";
import type { XY } from "../../src/utils/math";
import fixture from "../ai/fixtures/a19_terrain_placement.json";

test("default simulations apply the final public terrain choice, while explicit formation overrides retain their cells", () => {
    const expected = new Map<number, XY[]>(),
        original = new Map<number, XY[]>();
    let changed = 0;
    const stop = new Error("Captured actual pre-combat placement; no combat is required by this routing test");
    const config: IMatchConfig = {
        ...(fixture.simulationConfig as unknown as IMatchConfig),
        greenVersion: "v0.8",
        redVersion: "v0.8",
        sideOrientedPlacement: true,
        placementAugmentTiming: "setup-before-placement",
        searchOfflineDeterministicWork: true,
    };
    expect(() =>
        runMatch({
            ...config,
            greenStrategyOverride: createV08A19Strategy(),
            redStrategyOverride: createV08A19Strategy(),
            beforeFightStart(context) {
                for (const team of [2, 1]) {
                    const units = context.unitsHolder.getAllAllies(team);
                    const incumbent = new Map(units.map((unit) => [unit.getId(), { ...unit.getBaseCell() }]));
                    original.set(team, [...incumbent.values()]);
                    const legal = new RectanglePlacement(
                        context.grid.getSettings(),
                        team === 2 ? PlacementPositionType.LEFT_BOTTOM : PlacementPositionType.RIGHT_TOP,
                        context.fightProperties.getAugmentPlacement(team)[0],
                        true,
                    ).possibleCellHashes();
                    const choice = chooseA19TerrainPlacement(
                        units,
                        {
                            team,
                            gridType: 4,
                            gridSettings: context.grid.getSettings(),
                            sideOrientedPlacement: true,
                            legalCellHashes: legal,
                            publicMapSeed: `sim-${config.seed}`,
                        },
                        incumbent,
                    );
                    changed += Number(choice.changed);
                    expected.set(team, [...choice.positions.values()]);
                }
                throw stop;
            },
        }),
    ).toThrow(stop);
    expect(changed).toBeGreaterThan(0);
    expect(() =>
        runMatch({
            ...config,
            beforeFightStart(context) {
                for (const team of [2, 1])
                    expect(context.unitsHolder.getAllAllies(team).map((unit) => unit.getBaseCell())).toEqual(
                        expected.get(team)!,
                    );
                throw stop;
            },
        }),
    ).toThrow(stop);
    expect(() =>
        runMatch({
            ...config,
            greenStrategyOverride: createV08A19Strategy(),
            redStrategyOverride: createV08A19Strategy(),
            beforeFightStart(context) {
                for (const team of [2, 1])
                    expect(context.unitsHolder.getAllAllies(team).map((unit) => unit.getBaseCell())).toEqual(
                        original.get(team)!,
                    );
                throw stop;
            },
        }),
    ).toThrow(stop);
    const selected = new Map<number, XY[]>();
    expect(() =>
        runMatch({
            ...config,
            researchFormationSelector(context) {
                expect(context.units.map((unit) => unit.cell)).toEqual(expected.get(context.team)!);
                const positions = context.units.map((unit) => ({
                    x: unit.cell.x,
                    y: 15 - unit.cell.y + unit.height - 1,
                }));
                selected.set(context.team, positions);
                return new Map(context.units.map((unit, index) => [unit.unitId, positions[index]]));
            },
            beforeFightStart(context) {
                for (const team of [2, 1])
                    expect(context.unitsHolder.getAllAllies(team).map((unit) => unit.getBaseCell())).toEqual(
                        selected.get(team)!,
                    );
                throw stop;
            },
        }),
    ).toThrow(stop);
});
