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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
    captureAITargetMemory,
    clearAITargetMemory,
    recordAITargetMemory,
    restoreAITargetMemory,
} from "../../src/ai/ai";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import { v07ArchetypeTemplate } from "../../src/simulation/v0_7_archetype_battery";
import { captureFinishPressureState } from "../../src/simulation/v0_7_finish_pressure";
import type { UnitsHolder } from "../../src/units/units_holder";

const ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "SEARCH_GATE",
    "SEARCH_HORIZON",
    "SEARCH_ROLLOUTS",
    "SEARCH_LATE_RANGED_FINISH_WEIGHT",
    "SEARCH_SHORTLIST",
    "SEARCH_AUDIT",
    "SEARCH_INCLUDE_MOVES",
    "SEARCH_OPP_MODEL",
    "V07_VALUE_WEIGHTS",
    "V07_VALUE_WEIGHTS_V2",
    "Q2_DATASET_V2",
    "PHASE_B_RUN_FINGERPRINT",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function clearSearchEnv(): void {
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

test("AI target memory is isolated per battle holder and supports exact rollback/reset", () => {
    const first = {} as UnitsHolder;
    const second = {} as UnitsHolder;
    recordAITargetMemory(first, "unit-a", "target-a");
    const snapshot = captureAITargetMemory(first);

    recordAITargetMemory(first, "unit-a", "future-target");
    recordAITargetMemory(second, "unit-a", "other-battle-target");
    restoreAITargetMemory(first, snapshot);

    expect([...captureAITargetMemory(first)]).toEqual([["unit-a", "target-a"]]);
    expect([...captureAITargetMemory(second)]).toEqual([["unit-a", "other-battle-target"]]);
    clearAITargetMemory(first);
    expect([...captureAITargetMemory(first)]).toEqual([]);
});

test("an impossible override gate leaves the complete seeded match byte-identical", () => {
    clearSearchEnv();
    const seed = 20260710;
    const roster = buildRoster(makeRng(seed));
    const config = {
        greenVersion: "v0.6s",
        redVersion: "v0.6",
        roster,
        seed,
        maxLaps: 60,
    } as const;
    const baseline = runMatch(structuredClone(config));

    process.env.V07_SEARCH = "1";
    process.env.SEARCH_GATE = "99";
    process.env.SEARCH_ROLLOUTS = "1";
    process.env.SEARCH_HORIZON = "4";
    const searched = runMatch(structuredClone(config));

    expect(searched).toEqual(baseline);
}, 30_000);

test("the battle engine captures the post-start finish baseline before the first decision", () => {
    clearSearchEnv();
    const auditPath = join(mkdtempSync(join(tmpdir(), "search-finish-baseline-")), "audit.jsonl");
    Object.assign(process.env, {
        V07_SEARCH: "1",
        SEARCH_VERSIONS: "v0.7",
        SEARCH_GATE: "99",
        SEARCH_HORIZON: "1",
        SEARCH_ROLLOUTS: "1",
        SEARCH_SHORTLIST: "2",
        SEARCH_LATE_RANGED_FINISH_WEIGHT: "1",
        SEARCH_AUDIT: auditPath,
    });

    let firstDecisionRangedness: number | null = null;
    runMatch({
        greenVersion: "v0.7",
        redVersion: "v0.6",
        roster: v07ArchetypeTemplate("mage_fireline").roster,
        seed: 123,
        maxLaps: 4,
        decisionObserver: ({ context }) => {
            firstDecisionRangedness ??= captureFinishPressureState(context.unitsHolder).initialBoardRangedness;
        },
    });

    const summary = JSON.parse(readFileSync(auditPath, "utf8").trim());
    expect(summary).toMatchObject({
        mode: "search",
        lateRangedFinishWeight: 1,
        initialBoardRangedness: firstDecisionRangedness,
    });
    expect(firstDecisionRangedness).toBeGreaterThan(0);
    expect(firstDecisionRangedness).toBeLessThan(1);
    expect(summary.finishPressureLeaves).toBeGreaterThan(0);

    const ineligibleAuditPath = join(mkdtempSync(join(tmpdir(), "search-finish-ineligible-")), "audit.jsonl");
    process.env.SEARCH_AUDIT = ineligibleAuditPath;
    runMatch({
        greenVersion: "v0.7",
        redVersion: "v0.6",
        roster: v07ArchetypeTemplate("mage_frontline").roster,
        seed: 124,
        maxLaps: 4,
    });
    expect(JSON.parse(readFileSync(ineligibleAuditPath, "utf8"))).toMatchObject({
        lateRangedFinishWeight: 1,
        initialBoardRangedness: 0,
        finishPressureLeaves: 0,
        finishPressureNonzeroLeaves: 0,
        finishPressureLogitSum: 0,
    });
}, 30_000);
