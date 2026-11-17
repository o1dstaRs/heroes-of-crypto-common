import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selectBarrelForecastIntent } from "../../src/simulation/barrel_forecast_intent_research";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GameAction } from "../../src/engine/actions";
import { GridSettings } from "../../src/grid/grid_settings";
import { getPositionForCell } from "../../src/grid/grid_math";

const settings = new GridSettings(16, 1024, 0, 512, -512, 8, 8);
const barrel = { x: 6, y: 4 };
const unit = (range = false): any => ({
    getId: () => "actor",
    getTeam: () => PBTypes.TeamVals.LEFT,
    getAttackTypeSelection: () => (range ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE),
});
const context = (team = PBTypes.TeamVals.LEFT, origin = "rollout", withBarrel = true): any => ({
    decisionOrigin: origin,
    grid: {
        getSettings: () => settings,
        getArtifactBarrels: () => (withBarrel ? [{ team, index: 0, cell: barrel }] : []),
    },
});
const clear: GameAction[] = [
    {
        type: "obstacle_attack",
        attackerId: "actor",
        targetPosition: getPositionForCell(barrel, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
    },
];
const wait: GameAction[] = [{ type: "wait_turn", unitId: "actor" }];

test("preserves the native intent for both barrel owners without copying either decision", () => {
    for (const owner of [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT]) {
        const before = structuredClone(wait),
            after = structuredClone(clear);
        const state = structuredClone({ before, after });
        expect(selectBarrelForecastIntent(unit(), context(owner), before, after)).toBe(before);
        expect({ before, after }).toEqual(state);
    }
});

test("keeps the live root and unclassified contexts on their original cleanup decision", () => {
    for (const origin of ["root", undefined]) {
        const ctx = context();
        ctx.decisionOrigin = origin;
        expect(selectBarrelForecastIntent(unit(), ctx, wait, clear)).toBe(clear);
    }
});

test("retains earlier legal move and defend intentions in projected turns", () => {
    const actions: GameAction[][] = [
        [{ type: "defend_turn", unitId: "actor" }],
        [
            {
                type: "move_unit",
                unitId: "actor",
                path: [
                    { x: 3, y: 4 },
                    { x: 4, y: 4 },
                ],
                targetCells: [{ x: 4, y: 4 }],
                hasLavaCell: false,
                hasWaterCell: false,
            },
        ],
    ];
    for (const before of actions) expect(selectBarrelForecastIntent(unit(), context(), before, clear)).toBe(before);
});

test("does not change ranged shots, neutral obstacles, foreign attacks or absent cleanups", () => {
    expect(selectBarrelForecastIntent(unit(true), context(), wait, clear)).toBe(clear);
    expect(selectBarrelForecastIntent(unit(), context(undefined, "rollout", false), wait, clear)).toBe(clear);
    const foreign = [{ ...clear[0], attackerId: "other" }] as GameAction[];
    expect(selectBarrelForecastIntent(unit(), context(), wait, foreign)).toBe(foreign);
    expect(selectBarrelForecastIntent(unit(), context(), wait, wait)).toBe(wait);
    expect(selectBarrelForecastIntent(unit(), context(), wait, [])).toEqual([]);
});

test("preserves deliberate clears, direct combat, casts and empty intentions", () => {
    for (const type of ["melee_attack", "range_attack", "area_throw_attack", "cast_spell", "obstacle_attack"]) {
        const before = [{ type }, ...wait] as GameAction[];
        expect(selectBarrelForecastIntent(unit(), context(), before, clear)).toBe(clear);
    }
    expect(selectBarrelForecastIntent(unit(), context(), [], clear)).toBe(clear);
});

test("is absent from native play and shipped A19 configuration", () => {
    for (const path of [
        "../../src/ai/versions/v0_8.ts",
        "../../src/simulation/search_driver.ts",
        "../../src/ai/versions/v0_8_a19_profile.ts",
    ])
        expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain("barrel_forecast_intent_research");
});
