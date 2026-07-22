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

import { describe, expect, it } from "bun:test";

import {
    AI_META_COHORTS,
    AI_META_FIGHT_PROFILE,
    AI_META_FIGHT_VERSION,
    AI_META_MAPS,
    AI_META_RECORDED_MAPS,
    AI_META_SYNERGY_DEFINITIONS,
    AI_META_SYNERGY_POLICY_SPEC,
    AI_META_SYNERGY_TRACKING,
    aiMetaSynergyLevel,
    armyFeatures,
    cohortArchetypes,
    cohortMap,
    generateMetaMatchup,
    prepareMetaPair,
    rosterSignature,
    rostersAreStrictlyDistinct,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
    type IAiMetaRunOptions,
} from "../../src/simulation/ai_meta_cohorts_core";
import {
    AiMetaAccumulator,
    AiMetaAggregation,
    sanitizedAiMetaEnvironment,
    validateAiMetaGamesPerCohort,
} from "../../src/simulation/measure_ai_meta_cohorts";

const options = (cohort: (typeof AI_META_COHORTS)[number], games = 32): IAiMetaRunOptions => ({
    cohort,
    games,
    baseSeed: 85_000_717,
});

const outcome = (aIsGreen: boolean, winner: "a" | "b" | "draw"): IAiMetaGameOutcome => ({
    aIsGreen,
    winner,
    laps: 5,
    endReason: "elimination",
    armageddonDecided: false,
    rejectedA: 0,
    rejectedB: 0,
    hpA: winner === "a" ? 100 : 0,
    hpB: winner === "b" ? 100 : 0,
    survivorsA: winner === "a" ? 2 : 0,
    survivorsB: winner === "b" ? 2 : 0,
});

describe("AI meta cohort generation", () => {
    it("pins the current study to the promoted v0.8+a13 profile and deployed synergy policy", () => {
        expect(AI_META_FIGHT_VERSION).toBe("v0.8");
        expect(AI_META_FIGHT_PROFILE).toBe("v0.8+a13");
        expect(AI_META_SYNERGY_POLICY_SPEC).toBe("v07-nonfight-4eda84635fe7");
        expect(AI_META_SYNERGY_TRACKING).toBe("exact-active-choice-level-v1");
        expect(AI_META_SYNERGY_DEFINITIONS).toHaveLength(8);

        let sawChaos = false;
        for (let pair = 0; pair < 80 && !sawChaos; pair += 1) {
            const prepared = prepareMetaPair(options("uniform-mixed", 200), pair);
            for (const army of [prepared.armyA, prepared.armyB]) {
                const chaos = army.synergies.find((choice) => choice.faction === 1);
                if (!chaos) continue;
                sawChaos = true;
                expect(chaos.synergy).toBe(2);
                const creatureId = army.creatureIds.find((id) => aiMetaSynergyLevel([id, id], chaos.faction) === 1);
                expect(creatureId).toBeDefined();
                expect(aiMetaSynergyLevel([creatureId!], chaos.faction)).toBe(0);
                expect(aiMetaSynergyLevel([creatureId!, creatureId!], chaos.faction)).toBe(1);
                expect(aiMetaSynergyLevel(Array(4).fill(creatureId!), chaos.faction)).toBe(2);
                expect(aiMetaSynergyLevel(Array(6).fill(creatureId!), chaos.faction)).toBe(3);
            }
        }
        expect(sawChaos).toBe(true);
    });

    it("identifies only units with Tome-amplifiable castable buffs", () => {
        const castableFeatures = armyFeatures([
            { faction: "Life", creatureName: "Healer", level: 2, size: 1, amount: 1 },
            { faction: "Chaos", creatureName: "Ogre Mage", level: 3, size: 1, amount: 1 },
            { faction: "Life", creatureName: "Valkyrie", level: 2, size: 1, amount: 1 },
        ]);
        const passiveFeatures = armyFeatures([
            { faction: "Life", creatureName: "Angel", level: 4, size: 2, amount: 1 },
        ]);

        expect(castableFeatures.buffers).toBe(3);
        expect(passiveFeatures.buffers).toBe(0);
        expect(passiveFeatures.auraCarriers).toBe(1);
    });

    it("generates two globally exclusive, non-mirrored armies in every cohort", () => {
        for (const cohort of AI_META_COHORTS) {
            for (let pair = 0; pair < 8; pair += 1) {
                const matchup = generateMetaMatchup(options(cohort), pair);
                expect(rosterSignature(matchup.rosterA)).not.toBe(rosterSignature(matchup.rosterB));
                expect(rostersAreStrictlyDistinct(matchup.rosterA, matchup.rosterB)).toBe(true);
                expect(matchup.rosterA).toHaveLength(6);
                expect(matchup.rosterB).toHaveLength(6);
                expect(matchup.map).toBe(cohortMap(cohort, pair));
            }
        }
    });

    it("balances all ordered cross-archetype matchups without self-matches", () => {
        const matchups = new Set<string>();
        for (let pair = 0; pair < 12; pair += 1) {
            const [left, right] = cohortArchetypes("cross-archetype", pair);
            expect(left).not.toBe(right);
            matchups.add(`${left}:${right}`);
        }
        expect(matchups.size).toBe(12);

        const mapsByMatchup = new Map<string, Set<number>>();
        const mapCounts = new Map<number, number>();
        const completeCycle = 12 * AI_META_MAPS.length;
        for (let pair = 0; pair < completeCycle; pair += 1) {
            const matchup = cohortArchetypes("cross-archetype", pair).join(":");
            const map = cohortMap("cross-archetype", pair);
            const seen = mapsByMatchup.get(matchup) ?? new Set<number>();
            seen.add(map);
            mapsByMatchup.set(matchup, seen);
            mapCounts.set(map, (mapCounts.get(map) ?? 0) + 1);
        }
        expect([...mapsByMatchup.values()].every((maps) => maps.size === AI_META_MAPS.length)).toBe(true);
        expect(AI_META_MAPS.map((map) => mapCounts.get(map))).toEqual([12, 12, 12]);
        expect(AI_META_MAPS).toEqual([1, 3, 4]);
        expect(AI_META_RECORDED_MAPS).toEqual([1, 2, 3, 4]);
    });

    it("makes contextual setup deterministic while retaining exploration support", () => {
        const first = prepareMetaPair(options("uniform-mixed", 1000), 12);
        expect(prepareMetaPair(options("uniform-mixed", 1000), 12)).toEqual(first);

        let explored = 0;
        let exploited = 0;
        for (let pair = 0; pair < 200; pair += 1) {
            const prepared = prepareMetaPair(options("uniform-mixed", 1000), pair);
            for (const army of [prepared.armyA, prepared.armyB]) {
                for (const choice of [army.artifactT1, army.artifactT2, army.augment]) {
                    if (choice.mode === "explore") explored += 1;
                    else exploited += 1;
                }
                expect(
                    army.augment.plan.placement +
                        army.augment.plan.armor +
                        army.augment.plan.might +
                        army.augment.plan.sniper +
                        army.augment.plan.movement,
                ).toBe(7);
            }
        }
        expect(explored).toBeGreaterThan(100);
        expect(exploited).toBeGreaterThan(explored);
    });

    it("sanitizes experiment flags before worker module initialization", () => {
        const environment = sanitizedAiMetaEnvironment({
            PATH: "/bin",
            V05_WEIGHTS: "injected",
            V07_SEARCH: "1",
            SEARCH_IL_DATASET: "/tmp/injected",
            VALUE_DATA: "/tmp/injected.jsonl",
            VALUE_DATA_FEATURES: "v2",
            PHASE_B_RUN_FINGERPRINT: "injected",
            FORCE_CREATURES: "Wolf",
            FIGHT_MELEE_ROSTERS: "1",
        });
        expect(environment.PATH).toBe("/bin");
        expect(environment.V05_WEIGHTS).toBeUndefined();
        expect(environment.V07_SEARCH).toBeUndefined();
        expect(environment.SEARCH_IL_DATASET).toBeUndefined();
        expect(environment.VALUE_DATA).toBeUndefined();
        expect(environment.VALUE_DATA_FEATURES).toBeUndefined();
        expect(environment.PHASE_B_RUN_FINGERPRINT).toBeUndefined();
        expect(environment.FORCE_CREATURES).toBeUndefined();
        expect(environment.SIM_NO_ACTIONS).toBe("1");
        expect(environment.LIVETWIN).toBe("1");
        expect(environment.FIGHT_MELEE_ROSTERS).toBe("0");
        expect(environment.V08_A13_SEARCH).toBe("1");
    });

    it("only accepts complete three-map seat-swap cycles", () => {
        for (const games of [6, 72, 150_000]) expect(() => validateAiMetaGamesPerCohort(games)).not.toThrow();
        for (const games of [0, 2, 4, 8, 12.5, Number.NaN]) {
            expect(() => validateAiMetaGamesPerCohort(games)).toThrow("divisible by 6");
        }
    });
});

describe("AI meta aggregation", () => {
    it("builds pooled, cohort, live, and recorded-map dimensions", () => {
        const first = prepareMetaPair(options("uniform-mixed", 4), 0);
        const second = prepareMetaPair(options("uniform-mixed", 4), 1);
        const aggregation = new AiMetaAggregation();
        aggregation.add({
            ...first,
            map: 1,
            games: [outcome(true, "a"), outcome(false, "a")],
        });
        aggregation.add({
            ...second,
            map: 2,
            games: [outcome(true, "b"), outcome(false, "b")],
        });

        expect(aggregation.get("all", "all")?.pairs).toBe(2);
        expect(aggregation.get("uniform-mixed", "all")?.pairs).toBe(2);
        expect(aggregation.get("all", "live")?.pairs).toBe(1);
        expect(aggregation.get("uniform-mixed", "live")?.pairs).toBe(1);
        expect(aggregation.get("all", 1)?.pairs).toBe(1);
        expect(aggregation.get("all", 2)?.pairs).toBe(1);
        expect(aggregation.get("uniform-mixed", 2)?.pairs).toBe(1);

        const tier1Rows = aggregation.rows().artifactsT1;
        expect(new Set(tier1Rows.map((row) => row.map))).toEqual(new Set(["all", "live", 1, 2]));
        expect(tier1Rows.every((row) => row.map !== undefined)).toBe(true);
        const synergyRows = aggregation.rows().synergies;
        expect(new Set(synergyRows.map((row) => row.map))).toEqual(new Set(["all", "live", 1, 2]));
        expect(synergyRows.every((row) => row.map !== undefined)).toBe(true);
    });

    it("uses the two-game matchup as one confidence cluster and attributes physical seat swaps", () => {
        const prepared = prepareMetaPair(options("uniform-mixed", 2), 0);
        const record: IAiMetaPairRecord = {
            ...prepared,
            games: [outcome(true, "a"), outcome(false, "a")],
        };
        const accumulator = new AiMetaAccumulator("test");
        accumulator.add(record);
        const rows = accumulator.rows().units;
        for (const unit of prepared.armyA.roster) {
            const row = rows.find((candidate) => candidate.name === unit.creatureName);
            expect(row?.pairs).toBe(1);
            expect(row?.scoreRate).toBe(1);
            expect(row?.games).toBe(2);
        }
        for (const unit of prepared.armyB.roster) {
            const row = rows.find((candidate) => candidate.name === unit.creatureName);
            expect(row?.scoreRate).toBe(0);
        }
        expect(accumulator.greenWins).toBe(1);
        expect(accumulator.redWins).toBe(1);
        expect(accumulator.distinctRosterViolations).toBe(0);
        expect(accumulator.overlappingCreatureViolations).toBe(0);
        const synergyRows = accumulator.rows().synergies;
        expect(synergyRows).toHaveLength(AI_META_SYNERGY_DEFINITIONS.length * 3);
        expect(synergyRows.reduce((sum, row) => sum + row.selected, 0)).toBe(
            prepared.armyA.synergies.length + prepared.armyB.synergies.length,
        );
        expect(synergyRows.reduce((sum, row) => sum + row.exploreSelections, 0)).toBe(0);
        expect(synergyRows.reduce((sum, row) => sum + row.exploitSelections, 0)).toBe(
            prepared.armyA.synergies.length + prepared.armyB.synergies.length,
        );
    });

    it("keeps same-choice randomized assignments in one matchup confidence cluster", () => {
        const prepared = prepareMetaPair(options("uniform-mixed", 2), 0);
        prepared.armyA.artifactT1.mode = "explore";
        prepared.armyB.artifactT1 = { ...prepared.armyA.artifactT1, mode: "explore" };
        prepared.armyA.artifactT2.mode = "explore";
        prepared.armyB.artifactT2 = { ...prepared.armyA.artifactT2, mode: "exploit" };
        prepared.armyA.augment.mode = "explore";
        prepared.armyB.augment = { ...prepared.armyA.augment, mode: "explore" };
        const accumulator = new AiMetaAccumulator("test");
        accumulator.add({
            ...prepared,
            games: [outcome(true, "a"), outcome(false, "a")],
        });
        const rows = accumulator.rows();
        const tier1 = rows.artifactsT1.find((row) => row.key === String(prepared.armyA.artifactT1.id));
        const tier2 = rows.artifactsT2.find((row) => row.key === String(prepared.armyA.artifactT2.id));
        const plan = rows.augmentPlans.find((row) => row.key === prepared.armyA.augment.planId);
        expect(tier1?.pairs).toBe(1);
        expect(tier1?.games).toBe(4);
        expect(tier1?.scoreRate).toBe(0.5);
        expect(tier1?.policyPairs).toBe(1);
        expect(tier2?.pairs).toBe(1);
        expect(tier2?.scoreRate).toBe(1);
        expect(tier2?.policyPairs).toBe(1);
        expect(plan?.pairs).toBe(1);
        expect(plan?.scoreRate).toBe(0.5);
        expect(plan?.policyPairs).toBe(1);
        for (const [kind, level] of Object.entries(prepared.armyA.augment.plan)) {
            const row = rows.augmentLevels.find(
                (candidate) => candidate.key.toLowerCase() === `${kind}:${level}`.toLowerCase(),
            );
            expect(row?.pairs).toBe(1);
            expect(row?.scoreRate).toBe(0.5);
            expect(row?.policyPairs).toBe(1);
        }
    });
});
