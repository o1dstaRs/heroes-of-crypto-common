import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getPositionForCell } from "../../src/grid/grid_math";
import { GridSettings } from "../../src/grid/grid_settings";
import {
    selectBarrelForecastModelMixture,
    usesBarrelIntentForecast,
} from "../../src/simulation/barrel_forecast_model_mixture_research";
import { setDeterministicRandomSource } from "../../src/utils/lib";

const settings = new GridSettings(16, 1024, 0, 512, -512, 8, 8),
    cell = { x: 6, y: 4 };
const unit: any = { getId: () => "actor", getAttackTypeSelection: () => PBTypes.AttackVals.MELEE };
const context: any = {
    decisionOrigin: "rollout",
    grid: { getSettings: () => settings, getArtifactBarrels: () => [{ team: PBTypes.TeamVals.LEFT, index: 0, cell }] },
};
const before: GameAction[] = [{ type: "wait_turn", unitId: "actor" }],
    cleanup: GameAction[] = [
        {
            type: "obstacle_attack",
            attackerId: "actor",
            targetPosition: getPositionForCell(cell, settings.getMinX(), settings.getStep(), settings.getHalfStep()),
        },
    ];
const query = { horizonMode: "turns", rolloutCount: 2, sampleIndex: 0, seedBase: 104 };

test("each complete R2 comparison contains one native and one intent future with exact decision identity", () => {
    for (const seedBase of [0, 1, 104, 105, 0xfffffffe, 0xffffffff]) {
        const decisions = [0, 1].map((sampleIndex) =>
            selectBarrelForecastModelMixture(unit, context, before, cleanup, { ...query, seedBase, sampleIndex }),
        );
        expect(decisions.filter((d) => d === before)).toHaveLength(1);
        expect(decisions.filter((d) => d === cleanup)).toHaveLength(1);
    }
});

test("sample assignment is stable across candidate evaluation order without consuming chance draws", () => {
    let draws = 0;
    setDeterministicRandomSource(() => {
        draws++;
        return 0.5;
    });
    try {
        for (const seedBase of [104, 105]) {
            const pair = [0, 1].map((sampleIndex) => usesBarrelIntentForecast({ ...query, seedBase, sampleIndex }));
            for (const sampleIndex of [1, 0, 1, 0])
                expect(usesBarrelIntentForecast({ ...query, seedBase, sampleIndex })).toBe(pair[sampleIndex]);
        }
        expect(draws).toBe(0);
    } finally {
        setDeterministicRandomSource(undefined);
    }
});

test("root, leaf/reply, R4 and invalid samples preserve original cleanup", () => {
    for (const horizonMode of ["leaf", "reply", "lap", ""])
        expect(selectBarrelForecastModelMixture(unit, context, before, cleanup, { ...query, horizonMode })).toBe(
            cleanup,
        );
    for (const rolloutCount of [1, 3, 4])
        expect(selectBarrelForecastModelMixture(unit, context, before, cleanup, { ...query, rolloutCount })).toBe(
            cleanup,
        );
    for (const sampleIndex of [-1, 2, 0.5, NaN])
        expect(selectBarrelForecastModelMixture(unit, context, before, cleanup, { ...query, sampleIndex })).toBe(
            cleanup,
        );
    for (const seedBase of [-1, 0.5, NaN, Infinity, 0x100000000])
        expect(usesBarrelIntentForecast({ ...query, seedBase })).toBe(false);
    expect(selectBarrelForecastModelMixture(unit, { ...context, decisionOrigin: "root" }, before, cleanup, query)).toBe(
        cleanup,
    );
});

test("selected intent samples still protect direct combat, casts, neutral stones and ranged cleanup", () => {
    expect(
        selectBarrelForecastModelMixture(unit, context, [{ type: "cast_spell" } as GameAction], cleanup, query),
    ).toBe(cleanup);
    expect(
        selectBarrelForecastModelMixture(
            { ...unit, getAttackTypeSelection: () => PBTypes.AttackVals.RANGE },
            context,
            before,
            cleanup,
            query,
        ),
    ).toBe(cleanup);
    expect(
        selectBarrelForecastModelMixture(
            unit,
            { ...context, grid: { ...context.grid, getArtifactBarrels: () => [] } },
            before,
            cleanup,
            query,
        ),
    ).toBe(cleanup);
});

test("original helpers and serving source do not import this candidate", () => {
    for (const path of [
        "../../src/ai/versions/v0_8.ts",
        "../../src/simulation/search_driver.ts",
        "../../src/ai/versions/v0_8_a19_profile.ts",
        "../../src/simulation/barrel_forecast_intent_research.ts",
        "../../src/simulation/barrel_forecast_useful_clear_research.ts",
    ])
        expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain(
            "barrel_forecast_model_mixture_research",
        );
});
