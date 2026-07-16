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

import { CreatureLevelList } from "../../src/units/unit_properties";
import type { IMatchConfig } from "../../src/simulation/battle_engine";
import {
    aggregateRecord,
    buildArmyFromPick,
    cellBaseSeed,
    classifyRole,
    counterScore,
    defaultCells,
    emptyAggregate,
    evaluatePickSimGate,
    estimateInformationUpperBound,
    playPickSimGame,
    rolePayoffFromMatrix,
    roleMix,
    runPickPhase,
    WAVE2_ROLE_PAYOFF,
    ROLES,
    PICKSIM_GATE,
    type IPickSimGameRecord,
    type PickPolicyName,
    type Role,
} from "../../src/simulation/measure_picksim_oracle";

const ALL_POLICIES: PickPolicyName[] = ["policy_v0", "champion", "oracle", "oracle_blind"];

const levelOf = (creatureId: number): number => CreatureLevelList.findIndex((ids) => ids.includes(creatureId));

describe("measure_picksim_oracle priors", () => {
    it("embeds a consistent Wave-2 role payoff (rows + transposes sum to 1, diagonal 0.5)", () => {
        for (const a of ROLES) {
            expect(WAVE2_ROLE_PAYOFF[a][a]).toBe(0.5);
            for (const b of ROLES) {
                expect(WAVE2_ROLE_PAYOFF[a][b] + WAVE2_ROLE_PAYOFF[b][a]).toBeCloseTo(1, 10);
            }
        }
        // The Wave-2 headline ordering: melee >= ranged >= flyer against the field.
        expect(WAVE2_ROLE_PAYOFF.melee.flyer).toBeGreaterThan(0.6);
        expect(WAVE2_ROLE_PAYOFF.flyer.melee).toBeLessThan(0.4);
    });

    it("rebuilds the payoff from a measure_archetypes summary and rejects incomplete ones", () => {
        const payoff = rolePayoffFromMatrix({
            pooledPairs: [
                { a: "melee_coevo", b: "flyer_max", winRateA: 0.6928 },
                { a: "melee_coevo", b: "ranged_max_sniper3", winRateA: 0.5024 },
                { a: "flyer_max", b: "ranged_max_sniper3", winRateA: 0.4584 },
                { a: "melee_coevo", b: "hybrid", winRateA: 0.6722 },
            ],
        });
        for (const a of ROLES) {
            for (const b of ROLES) {
                expect(payoff[a][b]).toBeCloseTo(WAVE2_ROLE_PAYOFF[a][b], 10);
            }
        }
        expect(() => rolePayoffFromMatrix({ pooledPairs: [] })).toThrow();
        expect(() => rolePayoffFromMatrix({})).toThrow();
    });

    it("classifies every enabled creature into a role and best-responds with the priors", () => {
        const seen = new Set<Role>();
        for (let level = 1; level <= 4; level += 1) {
            for (const id of CreatureLevelList[level]) {
                seen.add(classifyRole(id));
            }
        }
        expect([...seen].sort()).toEqual(["flyer", "melee", "ranged"]);
        // Against a flyer-heavy opponent, melee is the prior best response; blind (uniform) also prefers melee.
        const flyerMix = { melee: 0, ranged: 0, flyer: 1 };
        expect(counterScore(WAVE2_ROLE_PAYOFF, "melee", flyerMix)).toBeGreaterThan(
            counterScore(WAVE2_ROLE_PAYOFF, "ranged", flyerMix),
        );
        expect(roleMix([])).toEqual({ melee: 1 / 3, ranged: 1 / 3, flyer: 1 / 3 });
    });
});

describe("measure_picksim_oracle pick phase", () => {
    it("completes a valid deterministic live draft for every policy pairing", () => {
        for (const lower of ALL_POLICIES) {
            for (const upper of ALL_POLICIES) {
                for (const seed of [1, 42, 1337]) {
                    const outcome = runPickPhase(seed, lower, upper);
                    const again = runPickPhase(seed, lower, upper);
                    expect(outcome.state.phaseSequence).toBe(11);
                    expect(again.state.lower.creatures).toEqual(outcome.state.lower.creatures);
                    expect(again.state.upper.creatures).toEqual(outcome.state.upper.creatures);
                    for (const team of [outcome.state.lower, outcome.state.upper]) {
                        expect(team.creatures).toHaveLength(6);
                        const levels = team.creatures.map(levelOf).sort();
                        expect(levels).toEqual([1, 1, 2, 2, 3, 4]);
                        for (const id of team.creatures) {
                            expect(outcome.state.creaturesBanned).not.toContain(id);
                        }
                        expect(team.tier2Offers).toContain(team.tier2Artifact!);
                        expect(team.tier1Artifact! >= 1 && team.tier1Artifact! <= 12).toBe(true);
                    }
                    // Shared exclusive pool: no creature fielded by both teams.
                    const lowerSet = new Set(outcome.state.lower.creatures);
                    for (const id of outcome.state.upper.creatures) {
                        expect(lowerSet.has(id)).toBe(false);
                    }
                }
            }
        }
    });

    it("never collides for the informed oracle and counts collisions for blind policies", () => {
        let baselineCollisions = 0;
        for (let seed = 1; seed <= 40; seed += 1) {
            const oracleGame = runPickPhase(seed, "oracle", "champion");
            expect(oracleGame.lower.collisions).toBe(0);
            const mirror = runPickPhase(seed, "champion", "champion");
            baselineCollisions += mirror.lower.collisions + mirror.upper.collisions;
            const byLevel = mirror.lower.collisionsByLevel.map(
                (count, index) => count + mirror.upper.collisionsByLevel[index],
            );
            expect(byLevel.reduce((sum, count) => sum + count, 0)).toBe(
                mirror.lower.collisions + mirror.upper.collisions,
            );
        }
        // Two greedy identical policies chase the same creatures, so hidden-pick collisions must show up.
        expect(baselineCollisions).toBeGreaterThan(0);
    });

    it("tracks informed-oracle decisions and only ever overrides toward the opponent", () => {
        let decisions = 0;
        for (let seed = 1; seed <= 20; seed += 1) {
            const outcome = runPickPhase(seed, "oracle", "policy_v0");
            decisions += outcome.lower.oracleDecisions;
            expect(outcome.upper.oracleDecisions).toBe(0);
            expect(outcome.lower.oracleOverrides).toBeLessThanOrEqual(outcome.lower.oracleDecisions);
            const byDecision = Object.values(outcome.lower.overridesByDecision).reduce(
                (sum, count) => sum + (count ?? 0),
                0,
            );
            expect(byDecision).toBe(outcome.lower.oracleOverrides);
        }
        // One bundle + four creature picks per game for the oracle seat.
        expect(decisions).toBe(20 * 5);
    });
});

describe("measure_picksim_oracle armies and games", () => {
    it("materializes the picked army with live expBudget stack sizing and the picked artifacts", () => {
        const outcome = runPickPhase(7, "champion", "policy_v0");
        const army = buildArmyFromPick(outcome.state.lower);
        expect(army.roster).toHaveLength(6);
        expect(army.roster.map((unit) => unit.level)).toEqual([1, 1, 2, 2, 3, 4]);
        for (const unit of army.roster) {
            expect(unit.amount).toBeGreaterThanOrEqual(1);
            expect(unit.creatureName.length).toBeGreaterThan(0);
        }
        // Live exp-budget sizing: an L1 stack fields far more bodies than an L4 stack.
        expect(army.roster[0].amount).toBeGreaterThan(army.roster[5].amount);
        expect(army.tier1Artifact).toBe(outcome.state.lower.tier1Artifact!);
        expect(army.tier2Artifact).toBe(outcome.state.lower.tier2Artifact!);
        expect(army.perk).toBe(3); // SEE_NONE
        expect(army.augments.length).toBeGreaterThan(0);
        expect(army.roleStacks.reduce((sum, count) => sum + count, 0)).toBe(6);
    });

    it("pairs the seed but re-drafts policies in opposite pick seats", () => {
        const cell = defaultCells().find((candidate) => candidate.id === PICKSIM_GATE.headlineCell)!;
        const configs: IMatchConfig[] = [];
        const runFake = (game: number): IPickSimGameRecord =>
            playPickSimGame(cell, { gamesPerCell: 4, baseSeed: 123 }, game, {
                matchRunner: (config) => {
                    configs.push(config);
                    return { winner: "green", laps: 5, endReason: "elimination", decidedByArmageddon: false };
                },
            });
        const even = runFake(0);
        const odd = runFake(1);
        // The offer/combat seed is shared, but each policy sees the other pick seat and re-drafts its army.
        expect(configs[0].seed).toBe(configs[1].seed);
        expect(even.armyA).not.toBe(odd.armyA);
        expect(even.armyB).not.toBe(odd.armyB);
        expect(configs[0].greenArtifactT1).toBeGreaterThanOrEqual(1);
        expect(configs[0].greenArtifactT2).toBeGreaterThanOrEqual(1);
        expect(configs[0].greenPerk).toBe(3);
        expect(configs[0].greenAugments!.length).toBeGreaterThan(0);
        expect(even.aIsLower).toBe(true);
        expect(odd.aIsLower).toBe(false);
        expect(even.winnerSlot).toBe("a");
        expect(odd.winnerSlot).toBe("b");
        // A fresh pair draws a different seed.
        const other = runFake(2);
        expect(other.seed).not.toBe(even.seed);
        expect(cellBaseSeed(1, 0)).not.toBe(cellBaseSeed(1, 1));
    });

    it("aggregates records and applies the registered +3pp reopen gate", () => {
        const cell = defaultCells()[2];
        expect(cell.id).toBe(PICKSIM_GATE.headlineCell);
        const aggregate = emptyAggregate(cell.id, cell, 1);
        const record = playPickSimGame(cell, { gamesPerCell: 2, baseSeed: 5 }, 0, {
            matchRunner: () => ({ winner: "red", laps: 9, endReason: "elimination", decidedByArmageddon: false }),
        });
        aggregateRecord(aggregate, record);
        expect(aggregate.games).toBe(1);
        expect(aggregate.winsB).toBe(1);
        expect(aggregate.oracleDecisions).toBe(5);

        const dead = evaluatePickSimGate({ oracleWinRate: 0.5299, oracleDecisive: 7900, oracleGames: 8000 });
        expect(dead.verdict).toBe("DEAD");
        expect(dead.adequatelyPowered).toBe(true);
        const reopen = evaluatePickSimGate({ oracleWinRate: 0.531, oracleDecisive: 7900, oracleGames: 8000 });
        expect(reopen.verdict).toBe("REOPEN");
        const underpowered = evaluatePickSimGate({ oracleWinRate: 0.6, oracleDecisive: 100, oracleGames: 100 });
        expect(underpowered.adequatelyPowered).toBe(false);
        expect(underpowered.verdict).toBe("INCONCLUSIVE");
        expect(underpowered.reason).toContain("cannot decide");
    });

    it("uses a conservative pair-cluster bound for the information upper-bound proxy", () => {
        const estimate = estimateInformationUpperBound({
            informedWinRate: 0.6442,
            blindWinRate: 0.6363,
            informedSePp: 0.535,
            blindSePp: 0.538,
            informedGames: 8000,
            blindGames: 8000,
        });
        expect(estimate.interpretation).toBe("upper_bound_proxy_including_omniscient_collision_avoidance");
        expect(estimate.valuePp).toBeCloseTo(0.79, 8);
        expect(estimate.independentGameSePp).toBeCloseTo(Math.hypot(0.535, 0.538), 10);
        expect(estimate.conservativeClusterSePp).toBeCloseTo(Math.SQRT2 * Math.hypot(0.535, 0.538), 10);
        expect(estimate.upper95Pp).toBeLessThan(3);
        expect(estimate.thresholdVerdict).toBe("EXCLUDED_AT_95");

        const underpowered = estimateInformationUpperBound({
            informedWinRate: 0.5,
            blindWinRate: 0.5,
            informedSePp: 0.1,
            blindSePp: 0.1,
            informedGames: 100,
            blindGames: 100,
        });
        expect(underpowered.upper95Pp).toBeLessThan(3);
        expect(underpowered.thresholdVerdict).toBe("INCONCLUSIVE");
    });
});
