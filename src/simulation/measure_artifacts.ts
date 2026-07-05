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
import { TIER1_ARTIFACT_LIST } from "../artifacts/artifact_properties";
import { runTournamentConcurrent } from "./concurrent_tournament";
import type { IGameRecord } from "./tournament";

/**
 * CLI: measure which Tier-1 artifact is statistically best.
 *
 *   bun src/simulation/measure_artifacts.ts [version] [games] [baseSeed] [outDir] [concurrency] [--random] [--maps[=...]]
 *
 * Every team fields ONE random Tier-1 artifact. Games are played as mirrored pairs where the two artifacts
 * swap sides between the pair's two games (see tournament.playGame), so green/red side bias cancels exactly
 * and each artifact's aggregate win rate isolates the artifact's own contribution. Both sides run the SAME
 * AI version (default v0.5) so the AI is not a confound.
 *
 * Examples:
 *   bun src/simulation/measure_artifacts.ts                    # v0.5, 10000 games, mirrored rosters, NORMAL map
 *   bun src/simulation/measure_artifacts.ts v0.5 10000 1 sim-out 12 --random   # randomized rosters, 12 workers
 *   bun src/simulation/measure_artifacts.ts v0.4 20000 1 sim-out 0 --maps      # all four maps, auto concurrency
 *
 * Writes, under outDir:
 *   artifacts_<version>_<stamp>.jsonl        — one JSON line per game (record + both sides' artifact ids)
 *   artifacts_<version>_<stamp>.summary.json — per-artifact win/loss/draw + win rate + Wilson 95% CI, ranked
 */

interface IArtifactTally {
    id: number;
    name: string;
    wins: number;
    losses: number;
    draws: number;
    winsAsGreen: number;
    winsAsRed: number;
}

/** Wilson score interval for a binomial proportion — a sane CI even at the tails / small n. */
function wilson(wins: number, n: number, z = 1.96): [number, number] {
    if (n <= 0) {
        return [0, 0];
    }
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const flags = argv.filter((a) => a.startsWith("--"));
    const [versionArg, gamesArg, seedArg, outDirArg, concurrencyArg] = argv.filter((a) => !a.startsWith("--"));
    const randomizePicks = flags.includes("--random") || flags.includes("--randomize-picks");

    const MAP_BY_NAME: Record<string, number> = { normal: 1, water: 2, lava: 3, block: 4 };
    const mapsFlag = flags.find((f) => f === "--maps" || f.startsWith("--maps="));
    const mapTypes = mapsFlag
        ? (mapsFlag.includes("=") ? mapsFlag.split("=")[1].split(",") : ["normal", "water", "lava", "block"])
              .map((n) => MAP_BY_NAME[n.trim().toLowerCase()])
              .filter((v): v is number => typeof v === "number")
        : undefined;

    const version = versionArg ?? "v0.5";
    if (!AI_VERSIONS.includes(version)) {
        console.error(`unknown version "${version}". known: ${AI_VERSIONS.join(", ")}`);
        process.exit(1);
    }
    const games = gamesArg ? Number(gamesArg) : 10000;
    const baseSeed = seedArg ? Number(seedArg) : 1;
    const outDir = outDirArg ?? join(process.cwd(), "sim-out");
    const defaultConcurrency = Math.max(1, availableParallelism());
    const concurrency = Math.min(
        concurrencyArg && Number(concurrencyArg) > 0 ? Math.max(1, Number(concurrencyArg)) : defaultConcurrency,
        Math.max(1, games),
    );
    mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `artifacts_${version}_${stamp}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const jsonlPath = join(outDir, `${base}.jsonl`);
    const summaryPath = join(outDir, `${base}.summary.json`);
    writeFileSync(jsonlPath, "");

    const nameById = new Map<number, string>(TIER1_ARTIFACT_LIST.map((a) => [a.id, a.name]));
    const tallies = new Map<number, IArtifactTally>(
        TIER1_ARTIFACT_LIST.map((a) => [
            a.id,
            { id: a.id, name: a.name, wins: 0, losses: 0, draws: 0, winsAsGreen: 0, winsAsRed: 0 },
        ]),
    );
    const tallyFor = (id: number): IArtifactTally => {
        let t = tallies.get(id);
        if (!t) {
            t = { id, name: nameById.get(id) ?? `#${id}`, wins: 0, losses: 0, draws: 0, winsAsGreen: 0, winsAsRed: 0 };
            tallies.set(id, t);
        }
        return t;
    };

    let buffer: string[] = [];
    let logged = 0;
    let draws = 0;
    const flush = (): void => {
        if (buffer.length) {
            appendFileSync(jsonlPath, buffer.join(""));
            buffer = [];
        }
    };

    const record = (rec: IGameRecord): void => {
        buffer.push(`${JSON.stringify(rec)}\n`);
        if (buffer.length >= 50) {
            flush();
        }
        const g = rec.greenArtifactT1;
        const r = rec.redArtifactT1;
        const winner = rec.result.winner;
        if (winner === "draw") {
            draws += 1;
        }
        if (g) {
            const t = tallyFor(g);
            if (winner === "green") {
                t.wins += 1;
                t.winsAsGreen += 1;
            } else if (winner === "red") {
                t.losses += 1;
            } else {
                t.draws += 1;
            }
        }
        if (r) {
            const t = tallyFor(r);
            if (winner === "red") {
                t.wins += 1;
                t.winsAsRed += 1;
            } else if (winner === "green") {
                t.losses += 1;
            } else {
                t.draws += 1;
            }
        }
        logged += 1;
        if (logged % 500 === 0) {
            console.log(`  ${logged}/${games} games...`);
        }
    };

    console.log(
        `Measuring Tier-1 artifacts: ${version} vs ${version}, ${games} games ` +
            `(seed ${baseSeed}, concurrency ${concurrency}, rosters ${randomizePicks ? "RANDOM" : "mirrored"}, ` +
            `maps ${mapTypes ? mapTypes.join("/") : "NORMAL"}) -> ${jsonlPath}`,
    );

    const startedAt = Date.now();
    await runTournamentConcurrent(
        { versionA: version, versionB: version, games, baseSeed, randomizePicks, mapTypes, artifactsT1: true },
        concurrency,
        record,
    );
    flush();

    // Rank by decisive win rate (draws excluded from the denominator, reported separately).
    const rows = [...tallies.values()]
        .map((t) => {
            const decisive = t.wins + t.losses;
            const winRate = decisive > 0 ? t.wins / decisive : 0;
            const [lo, hi] = wilson(t.wins, decisive);
            return { ...t, appearances: t.wins + t.losses + t.draws, decisive, winRate, ciLow: lo, ciHigh: hi };
        })
        .sort((a, b) => b.winRate - a.winRate);

    const summary = {
        version,
        games,
        baseSeed,
        randomizePicks,
        mapTypes: mapTypes ?? [1],
        draws,
        note: "winRate is decisive (draws excluded). Each game credits BOTH sides' artifacts. Side bias cancels via per-pair swap. CI = Wilson 95%.",
        ranking: rows,
    };
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`\nDone in ${seconds}s. Summary -> ${summaryPath}`);
    console.log(`draws: ${draws}/${games} (${((draws / games) * 100).toFixed(1)}%)\n`);
    const pad = (s: string, n: number): string => s.padEnd(n);
    const padL = (s: string, n: number): string => s.padStart(n);
    console.log(
        `${pad("rank  artifact", 26)} ${padL("games", 7)} ${padL("W", 6)} ${padL("L", 6)} ${padL("D", 5)} ${padL("win%", 7)}  95% CI`,
    );
    rows.forEach((r, i) => {
        console.log(
            `${pad(`${padL(`${i + 1}`, 2)}.   ${r.name}`, 26)} ${padL(`${r.appearances}`, 7)} ${padL(`${r.wins}`, 6)} ` +
                `${padL(`${r.losses}`, 6)} ${padL(`${r.draws}`, 5)} ${padL(`${(r.winRate * 100).toFixed(1)}`, 7)}  ` +
                `[${(r.ciLow * 100).toFixed(1)}, ${(r.ciHigh * 100).toFixed(1)}]`,
        );
    });
}

// Bun/Node entry-point guard.
if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

export { main };
