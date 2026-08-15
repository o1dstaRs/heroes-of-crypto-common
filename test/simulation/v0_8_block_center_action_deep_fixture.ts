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

import { describe, expect, test } from "bun:test";

import {
    runV08BlockCenterActionPanelGame,
    type IV08BlockCenterActionPanelOptions,
} from "../../src/simulation/v0_8_block_center_action_panel";

const DEEP_PANEL_OPTIONS: IV08BlockCenterActionPanelOptions = {
    candidateVersion: "v0.8",
    opponentVersion: "v0.7",
    games: 50_000,
    baseSeed: 2_607_280_041,
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
    // These games assert an EXACT action log. Under production deadline semantics a loaded shared runner
    // shortens the search, the candidate picks a different action, and the engine rejects it —
    // candidateEngineRejections went 0 -> 1 on CI while the same game passed locally. Finite operation
    // caps make the replay host-independent; real qualification passes keep the live-bounded default.
    searchOfflineDeterministicWork: true,
};

const DEEP_BLOCK_CENTER_REGRESSION_SHARDS = [
    [
        { game: 407, pair: 203, seed: 291_860_228, candidateSide: "red" },
        { game: 4_545, pair: 2_272, seed: 3_351_245_449, candidateSide: "red" },
        { game: 932, pair: 466, seed: 2_623_763_419, candidateSide: "green" },
        {
            game: 15_969,
            pair: 7_984,
            seed: 4_253_757_401,
            candidateSide: "red",
            candidateRoster: ["Leprechaun", "Leprechaun", "Nomad", "Beholder", "Ogre Mage", "Magic Dragon"],
            opponentRoster: ["Arbalester", "Dryad", "Healer", "Battle Mage", "Mantis", "Behemoth"],
        },
    ],
    [
        { game: 2_345, pair: 1_172, seed: 4_049_669_629, candidateSide: "red" },
        { game: 1_294, pair: 647, seed: 2_040_299_008, candidateSide: "green" },
        { game: 6_678, pair: 3_339, seed: 955_787_076, candidateSide: "green" },
        { game: 1_656, pair: 828, seed: 1_456_834_597, candidateSide: "green" },
    ],
    [
        { game: 551, pair: 275, seed: 2_432_673_996, candidateSide: "red" },
        {
            game: 9_521,
            pair: 4_760,
            seed: 1_927_717_569,
            candidateSide: "red",
            candidateRoster: ["Leprechaun", "Peasant", "Harpy", "Elf", "Cyclops", "Angel"],
            opponentRoster: ["Orc", "Centaur", "Hyena", "Healer", "Goblin Knight", "Black Dragon"],
        },
        { game: 1_450, pair: 725, seed: 2_927_858_158, candidateSide: "green" },
        {
            game: 1_589,
            pair: 794,
            seed: 1_400_331_939,
            candidateSide: "red",
            candidateRoster: ["Fairy", "Troglodyte", "Harpy", "Pikeman", "Efreet", "Tsar Cannon"],
            opponentRoster: ["Leprechaun", "Centaur", "Pikeman", "Trent", "Cyclops", "Gargantuan"],
        },
    ],
    [
        { game: 6_724, pair: 3_362, seed: 1_878_267_435, candidateSide: "green" },
        { game: 917, pair: 458, seed: 2_863_113_811, candidateSide: "red" },
        { game: 2_717, pair: 1_358, seed: 3_853_482_135, candidateSide: "red" },
        {
            game: 1_069,
            pair: 534,
            seed: 2_736_768_735,
            candidateSide: "red",
            candidateRoster: ["Berserker", "Berserker", "Valkyrie", "Trent", "Cyclops", "Tsar Cannon"],
            opponentRoster: ["Peasant", "Blacksmith", "Valkyrie", "Elf", "Crusader", "Frenzied Boar"],
        },
    ],
    [
        { game: 432, pair: 216, seed: 439_786_753, candidateSide: "green" },
        { game: 3_202, pair: 1_601, seed: 341_310_362, candidateSide: "green" },
        { game: 474, pair: 237, seed: 348_362_886, candidateSide: "green" },
    ],
    [
        {
            game: 7_845,
            pair: 3_922,
            seed: 2_303_609_179,
            candidateSide: "red",
            candidateRoster: ["Mermaid", "Troglodyte", "Valkyrie", "Wyvern", "Goblin Knight", "Abomination"],
            opponentRoster: ["Mermaid", "Berserker", "Wyvern", "Beholder", "Pegasus", "Angel"],
        },
    ],
    [{ game: 489, pair: 244, seed: 1_749_544_029, candidateSide: "red" }],
    [
        { game: 5_695, pair: 2_847, seed: 643_450_648, candidateSide: "red" },
        {
            game: 4_139,
            pair: 2_069,
            seed: 1_371_697_966,
            candidateSide: "red",
            candidateRoster: ["Squire", "Fairy", "Hyena", "Harpy", "Mantis", "Abomination"],
            opponentRoster: ["Leprechaun", "Mermaid", "Troll", "Battle Mage", "Unicorn", "Champion"],
        },
    ],
] as const;

export function registerV08BlockCenterActionDeepRegressionCensus(): void {
    describe("v0.8 BLOCK_CENTER action oracle panel", () => {
        test("partitions the exact deep-regression census across unique game isolates", () => {
            const regressions = DEEP_BLOCK_CENTER_REGRESSION_SHARDS.flat();
            const gameIds = regressions.map(({ game }) => game);
            const pairIds = regressions.map(({ pair }) => pair);
            const seeds = regressions.map(({ seed }) => seed);

            expect([...gameIds].sort((left, right) => left - right)).toEqual([
                407, 432, 474, 489, 551, 917, 932, 1_069, 1_294, 1_450, 1_589, 1_656, 2_345, 2_717, 3_202, 4_139, 4_545,
                5_695, 6_678, 6_724, 7_845, 9_521, 15_969,
            ]);
            expect(new Set(gameIds).size).toBe(23);
            expect(new Set(pairIds).size).toBe(23);
            expect(new Set(seeds).size).toBe(23);
            expect(regressions.every(({ game, pair }) => pair === Math.floor(game / 2))).toBe(true);
        });
    });
}

export function registerV08BlockCenterActionDeepRegressionShard(shardIndex: number): void {
    const regressions = DEEP_BLOCK_CENTER_REGRESSION_SHARDS[shardIndex];
    if (!regressions) throw new Error(`Unknown BLOCK_CENTER deep-regression shard ${shardIndex}`);

    describe("v0.8 BLOCK_CENTER action oracle panel", () => {
        for (const regression of regressions) {
            test(`keeps deep game ${regression.game} free of urgent BLOCK_CENTER action misses`, () => {
                const record = runV08BlockCenterActionPanelGame(DEEP_PANEL_OPTIONS, regression.game);

                expect(record).toMatchObject({
                    ...regression,
                    candidateEngineRejections: 0,
                    endReason: "elimination",
                });
                expect(record.metrics).toMatchObject({
                    oracleProbeRejections: 0,
                    catalogProbeRejections: 0,
                    sharedCatalogEnumerationTruncations: 0,
                    urgentCatalogMisses: 0,
                    urgentMountainAdjacentMisses: 0,
                    urgentRepeatedNonProgressWithDirectOption: 0,
                    urgentMountainTerminalJitter: 0,
                    urgentCombatDroughts: 0,
                    lateDirectActionMisses: 0,
                    recoveryTurns: 0,
                    observerPairingFaults: 0,
                });
                expect(record.crash).toBeUndefined();
            });
        }
    });
}
