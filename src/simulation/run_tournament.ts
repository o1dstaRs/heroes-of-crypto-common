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

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { AI_VERSIONS } from "../ai";
import { runTournamentConcurrent } from "./concurrent_tournament";

/**
 * CLI: run an AI-vs-AI tournament and write LLM-feedable logs.
 *
 *   bun src/simulation/run_tournament.ts <versionA> <versionB> [games] [baseSeed] [outDir] [concurrency]
 *
 * Examples:
 *   bun src/simulation/run_tournament.ts v0.1 v0.2 1000           # auto concurrency (= CPU cores)
 *   bun src/simulation/run_tournament.ts v0.1 v0.2 1000 1 sim-out 10   # exactly 10 games in parallel
 *   bun src/simulation/run_tournament.ts v0.1 v0.2 1000 1 sim-out 1    # force single-threaded
 *
 * Concurrency runs games across worker threads (each its own isolate, so the engine's singleton is
 * safe). Produces, under outDir:
 *   <A>_vs_<B>_<stamp>.jsonl        — one JSON line per game: placements + every action + outcome
 *   <A>_vs_<B>_<stamp>.summary.json — aggregate win rates, end reasons, which version is better
 *
 * Feed the .jsonl (and especially the placement + early-action lines of games the new version LOST)
 * to an LLM to mine concrete improvements for the next version.
 */
async function main(): Promise<void> {
    // Flags (e.g. --random) may appear anywhere; strip them so positional args keep their order.
    const argv = process.argv.slice(2);
    const flags = argv.filter((a) => a.startsWith("--"));
    const [versionA, versionB, gamesArg, seedArg, outDirArg, concurrencyArg] = argv.filter((a) => !a.startsWith("--"));
    const randomizePicks = flags.includes("--random") || flags.includes("--randomize-picks");
    if (!versionA || !versionB) {
        console.error(
            "usage: run_tournament <versionA> <versionB> [games] [baseSeed] [outDir] [concurrency] [--random]",
        );
        console.error(`known versions: ${AI_VERSIONS.join(", ")}`);
        process.exit(1);
    }
    const games = gamesArg ? Number(gamesArg) : 1000;
    const baseSeed = seedArg ? Number(seedArg) : 1;
    const outDir = outDirArg ?? join(process.cwd(), "sim-out");
    const defaultConcurrency = Math.max(1, availableParallelism());
    const concurrency = Math.min(
        concurrencyArg ? Math.max(1, Number(concurrencyArg)) : defaultConcurrency,
        Math.max(1, games),
    );
    mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `${versionA}_vs_${versionB}_${stamp}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const jsonlPath = join(outDir, `${base}.jsonl`);
    const summaryPath = join(outDir, `${base}.summary.json`);
    writeFileSync(jsonlPath, "");

    const startedAt = Date.now();
    let buffer: string[] = [];
    let logged = 0;
    const flush = (): void => {
        if (buffer.length) {
            appendFileSync(jsonlPath, buffer.join(""));
            buffer = [];
        }
    };

    console.log(
        `Running ${games} games: ${versionA} vs ${versionB} (seed ${baseSeed}, concurrency ${concurrency}, ` +
            `picks ${randomizePicks ? "RANDOM per team" : "mirrored"}) -> ${jsonlPath}`,
    );
    const summary = await runTournamentConcurrent(
        { versionA, versionB, games, baseSeed, randomizePicks },
        concurrency,
        (record) => {
            buffer.push(`${JSON.stringify(record)}\n`);
            if (buffer.length >= 50) {
                flush();
            }
            logged += 1;
            if (logged % 100 === 0) {
                console.log(`  ${logged}/${games} games...`);
            }
        },
    );
    flush();

    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log("");
    console.log(`Done in ${seconds}s. Summary -> ${summaryPath}`);
    console.log(
        `${summary.a.version}: ${summary.a.wins} wins (green ${summary.a.winsAsGreen} / red ${summary.a.winsAsRed})`,
    );
    console.log(
        `${summary.b.version}: ${summary.b.wins} wins (green ${summary.b.winsAsGreen} / red ${summary.b.winsAsRed})`,
    );
    console.log(
        `draws: ${summary.draws} | ${summary.versionA} win rate (decisive): ${(summary.winRateA * 100).toFixed(1)}%`,
    );
    console.log(
        `better: ${summary.better} | avg laps: ${summary.avgLaps.toFixed(1)} | end reasons: ${JSON.stringify(summary.endReasons)}`,
    );
    console.log(
        `clean wins (not armageddon): ${(summary.cleanWinRate * 100).toFixed(1)}% | armageddon-decided: ${summary.armageddonDecided}/${summary.games}`,
    );
}

// Bun/Node entry-point guard.
if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

export { main };
