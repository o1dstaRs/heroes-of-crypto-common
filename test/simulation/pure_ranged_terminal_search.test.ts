/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { runMatch } from "../../src/simulation/battle_engine";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import { v07ArchetypeTemplate } from "../../src/simulation/v0_7_archetype_battery";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_SHORTLIST",
    "SEARCH_LATE_RANGED_FINISH_WEIGHT",
    "SEARCH_PURE_RANGED_TERMINAL_WEIGHT",
    "V07_VALUE_WEIGHTS",
    "V07_VALUE_WEIGHTS_V2",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearEnv(): void {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
}

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = saved[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

function pureRangedLeafHarness() {
    const combat = createCombatTestContext();
    const lower = createTestUnit({
        team: PBTypes.TeamVals.LOWER,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 4,
        damageMin: 10,
        damageMax: 10,
        maxHp: 20,
    });
    const upper = createTestUnit({
        team: PBTypes.TeamVals.UPPER,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 4,
        damageMin: 10,
        damageMax: 10,
        maxHp: 20,
    });
    placeUnit(combat.grid, combat.unitsHolder, lower, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, upper, { x: 3, y: 11 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const deps = { unitsHolder: combat.unitsHolder, fightProperties } as ILookaheadDeps;
    return { lower, upper, fightProperties, makeDriver: () => new SearchDriver(deps) };
}

const leafValue = (driver: SearchDriver, team: PBTypes.TeamVals): number =>
    (driver as unknown as { leafValue(side: PBTypes.TeamVals): number }).leafValue(team);

describe("SearchDriver pure-ranged terminal overlay", () => {
    it("keeps the complete recorded action stream byte-identical when unset versus explicit zero", () => {
        clearEnv();
        Object.assign(process.env, {
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            SEARCH_GATE: "99",
            SEARCH_HORIZON: "1",
            SEARCH_ROLLOUTS: "1",
            SEARCH_SHORTLIST: "2",
            V07_VALUE_WEIGHTS: "material",
        });
        const config = {
            greenVersion: "v0.7",
            redVersion: "v0.7",
            roster: [...v07ArchetypeTemplate("ranged_precision").roster],
            seed: 20260716,
            maxLaps: 2,
        };
        const unset = runMatch(structuredClone(config));

        process.env.SEARCH_PURE_RANGED_TERMINAL_WEIGHT = "0";
        const explicitZero = runMatch(structuredClone(config));

        expect(explicitZero.actions).toEqual(unset.actions);
        expect(explicitZero).toEqual(unset);
    }, 30_000);

    it("adds weight times signed terminal advantage to both learned and material leaf logits", () => {
        clearEnv();
        Object.assign(process.env, {
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.7",
            V07_VALUE_WEIGHTS: "material",
        });
        const harness = pureRangedLeafHarness();
        const baseline = harness.makeDriver();
        baseline.onFightReady();

        process.env.SEARCH_PURE_RANGED_TERMINAL_WEIGHT = "2";
        const weighted = harness.makeDriver();
        weighted.onFightReady();
        while (harness.fightProperties.getCurrentLap() < 10) {
            harness.fightProperties.flipLap();
        }
        for (let i = 0; i < 4; i += 1) {
            harness.upper.decreaseNumberOfShots();
        }

        const lowerBaseline = leafValue(baseline, PBTypes.TeamVals.LOWER);
        const upperBaseline = leafValue(baseline, PBTypes.TeamVals.UPPER);
        const lowerWeighted = leafValue(weighted, PBTypes.TeamVals.LOWER);
        const upperWeighted = leafValue(weighted, PBTypes.TeamVals.UPPER);
        expect(lowerWeighted).toBeGreaterThan(lowerBaseline);
        expect(upperWeighted).toBeLessThan(upperBaseline);

        const state = weighted as unknown as {
            counters: {
                pureRangedTerminalLeaves: number;
                pureRangedTerminalNonzeroLeaves: number;
                pureRangedTerminalLogitSum: number;
            };
        };
        expect(state.counters).toMatchObject({
            pureRangedTerminalLeaves: 2,
            pureRangedTerminalNonzeroLeaves: 2,
        });
        expect(state.counters.pureRangedTerminalLogitSum).toBeCloseTo(0, 12);
    });

    it("rejects out-of-range weights only when search mode consumes the knob", () => {
        clearEnv();
        process.env.SEARCH_PURE_RANGED_TERMINAL_WEIGHT = "invalid";
        expect(pureRangedLeafHarness().makeDriver().enabled).toBe(false);

        process.env.V07_SEARCH = "1";
        expect(() => pureRangedLeafHarness().makeDriver()).toThrow(
            "SEARCH_PURE_RANGED_TERMINAL_WEIGHT must be between 0 and 16",
        );
        process.env.SEARCH_PURE_RANGED_TERMINAL_WEIGHT = "17";
        expect(() => pureRangedLeafHarness().makeDriver()).toThrow(
            "SEARCH_PURE_RANGED_TERMINAL_WEIGHT must be between 0 and 16",
        );
    });
});
