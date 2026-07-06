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
 * CEM fitness evaluator for the DRAFT policy. Runs a `cemDraft` self-play tournament — the WEIGHTED draft
 * policy (vector from env V05_DRAFT_WEIGHTS) vs the FROZEN anchor heuristic — where each side drafts its own
 * roster from shared offered subsets, and prints the weighted policy's decisive win rate as JSON. cem_draft.mjs
 * spawns many of these in parallel (one per candidate) to saturate the node.
 *
 *   V05_DRAFT_WEIGHTS='[...]' bun src/simulation/cem_draft_eval.ts <games> <seed> <concurrency>
 */
async function main(): Promise<void> {
    const [gamesArg, seedArg, concArg, verArg] = process.argv.slice(2);
    const games = Number(gamesArg) || 3000;
    const seed = Number(seedArg) || 1;
    const concurrency = Number(concArg) || 4;
    // Optional 4th arg: the FIGHT AI both sides use (default v0.5). Lets us check whether a draft advantage is
    // real or specific to one fight AI (e.g. melee>ranged might be a v0.5 positioning artifact).
    const fightVersion = verArg || "v0.5";
    // Optional CEM_DRAFT_MAPS="1,4" → board layouts (1 NORMAL, 2 WATER, 3 LAVA, 4 BLOCK). Obstacle maps slow
    // melee's approach, so ranged should fare better there if terrain is the lever.
    const mapTypes = process.env.CEM_DRAFT_MAPS
        ? process.env.CEM_DRAFT_MAPS.split(",")
              .map(Number)
              .filter((n) => Number.isFinite(n))
        : undefined;

    let wins = 0;
    let losses = 0;
    let draws = 0;
    await runTournamentConcurrent(
        {
            versionA: fightVersion,
            versionB: fightVersion,
            games,
            baseSeed: seed,
            cemDraft: true,
            lightweight: true,
            ...(mapTypes ? { mapTypes } : {}),
        },
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
