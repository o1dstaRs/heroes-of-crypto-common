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

import { runTournamentConcurrent } from "./concurrent_tournament";

/**
 * CEM fitness evaluator for the composition+opponent-aware AUGMENT policy. Runs a `cemAugCA` self-play
 * tournament — the WEIGHTED army-aware policy (vector from env V05_AUGCA_WEIGHTS) vs the FROZEN blind heuristic,
 * both fielding their own random rosters — and prints the weighted policy's decisive win rate as JSON.
 *
 *   V05_AUGCA_WEIGHTS='[...20...]' bun src/simulation/cem_augca_eval.ts <games> <seed> <concurrency>
 */
async function main(): Promise<void> {
    const [gamesArg, seedArg, concArg] = process.argv.slice(2);
    const games = Number(gamesArg) || 3000;
    const seed = Number(seedArg) || 1;
    const concurrency = Number(concArg) || 4;

    let wins = 0;
    let losses = 0;
    let draws = 0;
    await runTournamentConcurrent(
        { versionA: "v0.6", versionB: "v0.6", games, baseSeed: seed, cemAugCA: true, lightweight: true },
        concurrency,
        (rec) => {
            const winner = rec.result.winner;
            if (winner === "draw") {
                draws += 1;
                return;
            }
            const weightedWon =
                (rec.greenIsWeighted && winner === "green") || (!rec.greenIsWeighted && winner === "red");
            if (weightedWon) wins += 1;
            else losses += 1;
        },
    );
    const decisive = wins + losses;
    process.stdout.write(JSON.stringify({ winRate: decisive ? wins / decisive : 0.5, wins, losses, draws }) + "\n");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
