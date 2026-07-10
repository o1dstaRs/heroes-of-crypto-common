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

import { DEFAULT_DRAFT_W } from "../../src/ai/setup/creature_score";
import { Perk } from "../../src/perks/perk_properties";
import {
    amountForCreatureExperienceBudget,
    buildRoster,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    DEFAULT_ROSTER_COMPOSITION,
    getCreatureExperience,
    makeRng,
    resolveStackAmount,
    STACK_EXPERIENCE_BUDGET,
} from "../../src/simulation/army";
import { DEFAULT_OFFER_K, draftRoster } from "../../src/simulation/draft";
import { isLiveTwin, LIVETWIN_PRESET, liveTwinMeleeFraction, liveTwinSetup } from "../../src/simulation/livetwin";
import { playGame } from "../../src/simulation/tournament";

const ENV_KEYS = ["LIVETWIN", "FIGHT_MELEE_ROSTERS", "AUGCA_NOVISION"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
}
afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = savedEnv[k];
        }
    }
});

describe("exp-budget stack amounts (live server rule, ceil(1000/exp))", () => {
    it("matches the server resolver on concrete creatures", () => {
        // exp values straight from creatures.json; amounts = ceil(1000/exp).
        expect(amountForCreatureExperienceBudget("Peasant", STACK_EXPERIENCE_BUDGET, 50)).toBe(200); // exp 5
        expect(amountForCreatureExperienceBudget("Centaur", STACK_EXPERIENCE_BUDGET, 50)).toBe(73); // exp 13.8
        expect(amountForCreatureExperienceBudget("Pikeman", STACK_EXPERIENCE_BUDGET, 30)).toBe(23); // exp 45.2
        expect(amountForCreatureExperienceBudget("Crusader", STACK_EXPERIENCE_BUDGET, 15)).toBe(8); // exp 132
        expect(amountForCreatureExperienceBudget("Thunderbird", STACK_EXPERIENCE_BUDGET, 8)).toBe(3); // exp 334
        expect(amountForCreatureExperienceBudget("Behemoth", STACK_EXPERIENCE_BUDGET, 8)).toBe(2); // exp 500
        expect(amountForCreatureExperienceBudget("Black Dragon", STACK_EXPERIENCE_BUDGET, 8)).toBe(1); // exp 1000
    });

    it("falls back exactly like the server on unknown creatures / invalid budgets", () => {
        expect(amountForCreatureExperienceBudget("No Such Creature", STACK_EXPERIENCE_BUDGET, 42)).toBe(42);
        expect(amountForCreatureExperienceBudget("Peasant", 0, 42)).toBe(42);
        expect(amountForCreatureExperienceBudget("Peasant", Number.NaN, 42)).toBe(42);
        expect(getCreatureExperience("No Such Creature")).toBeUndefined();
    });

    it("lands in the live per-level ranges for EVERY enabled creature (L1 ~73-200 ... L4 1-3)", () => {
        const ranges: Record<number, [number, number]> = { 1: [73, 200], 2: [22, 40], 3: [8, 12], 4: [1, 3] };
        for (const [level, [lo, hi]] of Object.entries(ranges)) {
            const pool = creaturesByLevel(Number(level));
            expect(pool.length).toBeGreaterThan(0);
            for (const c of pool) {
                const amount = amountForCreatureExperienceBudget(c.creatureName, STACK_EXPERIENCE_BUDGET, -1);
                expect(amount).toBeGreaterThanOrEqual(lo);
                expect(amount).toBeLessThanOrEqual(hi);
                // Exact per-creature rule, not a level table.
                const exp = getCreatureExperience(c.creatureName);
                expect(exp).toBeDefined();
                expect(amount).toBe(Math.max(1, Math.ceil(STACK_EXPERIENCE_BUDGET / (exp as number))));
            }
        }
    });

    it("expBudget amounts are PER-CREATURE (a level table cannot express them)", () => {
        // Two L1 creatures with different exp must get different amounts under expBudget.
        expect(resolveStackAmount("Centaur", 1, DEFAULT_AMOUNT_BY_LEVEL, "expBudget")).toBe(73);
        expect(resolveStackAmount("Peasant", 1, DEFAULT_AMOUNT_BY_LEVEL, "expBudget")).toBe(200);
        // levelTable mode ignores the creature entirely.
        expect(resolveStackAmount("Centaur", 1, DEFAULT_AMOUNT_BY_LEVEL, "levelTable")).toBe(50);
        expect(resolveStackAmount("Peasant", 1, DEFAULT_AMOUNT_BY_LEVEL, "levelTable")).toBe(50);
    });
});

describe("defaults stay byte-identical (the anchor)", () => {
    it("buildRoster default === explicit 'levelTable', amounts from the {50,30,15,8} table", () => {
        for (const seed of [1, 42, 777]) {
            const def = buildRoster(makeRng(seed));
            const explicit = buildRoster(
                makeRng(seed),
                DEFAULT_ROSTER_COMPOSITION,
                DEFAULT_AMOUNT_BY_LEVEL,
                undefined,
                "levelTable",
            );
            expect(explicit).toEqual(def);
            for (const spec of def) {
                expect(spec.amount).toBe(DEFAULT_AMOUNT_BY_LEVEL[spec.level]);
            }
        }
    });

    it("draftRoster default === explicit 'levelTable'", () => {
        const def = draftRoster(DEFAULT_DRAFT_W, 42, DEFAULT_ROSTER_COMPOSITION, DEFAULT_AMOUNT_BY_LEVEL);
        const explicit = draftRoster(
            DEFAULT_DRAFT_W,
            42,
            DEFAULT_ROSTER_COMPOSITION,
            DEFAULT_AMOUNT_BY_LEVEL,
            DEFAULT_OFFER_K,
            "levelTable",
        );
        expect(explicit).toEqual(def);
        for (const spec of def) {
            expect(spec.amount).toBe(DEFAULT_AMOUNT_BY_LEVEL[spec.level]);
        }
    });

    it("expBudget mode changes ONLY the amounts — the creature picks (rng stream) are identical", () => {
        const table = buildRoster(makeRng(42));
        const live = buildRoster(
            makeRng(42),
            DEFAULT_ROSTER_COMPOSITION,
            DEFAULT_AMOUNT_BY_LEVEL,
            undefined,
            "expBudget",
        );
        expect(live.map((s) => s.creatureName)).toEqual(table.map((s) => s.creatureName));
        for (const spec of live) {
            const exp = getCreatureExperience(spec.creatureName) as number;
            expect(spec.amount).toBe(Math.max(1, Math.ceil(STACK_EXPERIENCE_BUDGET / exp)));
        }
    });

    it("without LIVETWIN the preset is fully inert", () => {
        delete process.env.LIVETWIN;
        delete process.env.FIGHT_MELEE_ROSTERS;
        expect(isLiveTwin()).toBe(false);
        expect(liveTwinMeleeFraction()).toBe(0);
        // An explicit FIGHT_MELEE_ROSTERS still wins (cohort battery), LIVETWIN or not.
        process.env.FIGHT_MELEE_ROSTERS = "0.5";
        expect(liveTwinMeleeFraction()).toBe(0.5);
    });
});

describe("LIVETWIN preset", () => {
    it("commits the live-faithful values: expBudget + all-melee drafts + SEE_NONE + no vision", () => {
        expect(LIVETWIN_PRESET.amountMode).toBe("expBudget");
        expect(LIVETWIN_PRESET.meleeRosterFraction).toBe(1);
        expect(LIVETWIN_PRESET.perk).toBe(Perk.SEE_NONE);
        expect(LIVETWIN_PRESET.noVision).toBe(true);
    });

    it("liveTwinSetup returns the SHIPPED ranked setup: SEE_NONE + Armor3/Might3/Sniper1", () => {
        const setup = liveTwinSetup();
        expect(setup.perk).toBe(Perk.SEE_NONE);
        expect(setup.augments).toEqual([
            { kind: "Armor", value: 3 },
            { kind: "Might", value: 3 },
            { kind: "Sniper", value: 1 },
        ]);
    });

    it("LIVETWIN=1 activates the preset; explicit FIGHT_MELEE_ROSTERS still overrides the fraction", () => {
        process.env.LIVETWIN = "1";
        delete process.env.FIGHT_MELEE_ROSTERS;
        expect(isLiveTwin()).toBe(true);
        expect(liveTwinMeleeFraction()).toBe(1);
        process.env.FIGHT_MELEE_ROSTERS = "0.5";
        expect(liveTwinMeleeFraction()).toBe(0.5);
    });

    it("playGame under LIVETWIN=1 fields exp-budget melee-drafted armies on both sides", () => {
        process.env.LIVETWIN = "1";
        delete process.env.FIGHT_MELEE_ROSTERS;
        const options = { versionA: "v0.1", versionB: "v0.1", games: 2, baseSeed: 11, maxLaps: 3 };
        const record = playGame(options, 0);
        const rosters = [record.result.roster, record.result.redRoster ?? []];
        expect(record.result.redRoster?.length).toBe(record.result.roster.length); // two DRAFTED armies, not mirrored
        for (const roster of rosters) {
            for (const spec of roster) {
                const exp = getCreatureExperience(spec.creatureName) as number;
                expect(spec.amount).toBe(Math.max(1, Math.ceil(STACK_EXPERIENCE_BUDGET / exp)));
            }
        }
    }, 60000);

    it("playGame WITHOUT LIVETWIN keeps the historical mirrored {50,30,15,8} roster", () => {
        delete process.env.LIVETWIN;
        delete process.env.FIGHT_MELEE_ROSTERS;
        const options = { versionA: "v0.1", versionB: "v0.1", games: 2, baseSeed: 11, maxLaps: 3 };
        const record = playGame(options, 0);
        expect(record.result.redRoster ?? undefined).toBeUndefined();
        for (const spec of record.result.roster) {
            expect(spec.amount).toBe(DEFAULT_AMOUNT_BY_LEVEL[spec.level]);
        }
    }, 60000);
});
