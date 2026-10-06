/*
 * Barrel-heavy a19 cohort check. Not a win-rate bake: both sides are forced onto Barrel Barricade, and the
 * report is placements, barrel strikes, and engine rejections. Search uses offline deterministic work, so a
 * decision is not cut off by the live 1000ms deadline.
 *
 *   bun src/simulation/measure_barrel_use.ts [games=10000] [concurrency=12] [baseSeed=1] [outDir]
 *
 * Cohorts, in order: half ranged-heavy, a quarter cross-archetype, a quarter uniform-mixed. One fight per
 * pair; odd pairs swap which army sits on the green seat. Concurrency 12 matches this machine's perf cores.
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PBTypes } from "../generated/protobuf/v1/types";
import { AI_META_GAMES_PER_MATCHUP, type AiMetaCohort } from "./ai_meta_cohorts_core";
import { resolveAiMetaFightProfile, sanitizedAiMetaEnvironment } from "./measure_ai_meta_cohorts";
import { PersistentWorkerPool } from "./persistent_worker_pool";
import type { BarrelFightRequest, BarrelFightResult } from "./measure_barrel_use_worker";

const USAGE = "Usage: bun src/simulation/measure_barrel_use.ts [games=10000] [concurrency=12] [baseSeed=1] [outDir]";

interface CohortTotals {
    games: number;
    placedBarrels: number;
    gamesWithZeroBarrels: number;
    gamesWithFewerThanFour: number;
    gamesWithBarrelStrike: number;
    gamesWithRanged: number;
    rangedGamesWithBarrelStrike: number;
    barrelStrikes: number;
    ownBarrelStrikes: number;
    enemyBarrelStrikes: number;
    barrelRejections: number;
    otherObstacleStrikes: number;
    otherObstacleRejections: number;
    otherRejections: number;
    engineRejections: number;
    unclassifiedRejections: number;
    nonElimination: number;
    byMap: Record<
        string,
        { games: number; barrelStrikes: number; otherObstacleStrikes: number; barrelRejections: number }
    >;
    barrelRejectionCounts: Record<string, number>;
    otherRejectionCounts: Record<string, number>;
}

function emptyTotals(): CohortTotals {
    return {
        games: 0,
        placedBarrels: 0,
        gamesWithZeroBarrels: 0,
        gamesWithFewerThanFour: 0,
        gamesWithBarrelStrike: 0,
        gamesWithRanged: 0,
        rangedGamesWithBarrelStrike: 0,
        barrelStrikes: 0,
        ownBarrelStrikes: 0,
        enemyBarrelStrikes: 0,
        barrelRejections: 0,
        otherObstacleStrikes: 0,
        otherObstacleRejections: 0,
        otherRejections: 0,
        engineRejections: 0,
        unclassifiedRejections: 0,
        nonElimination: 0,
        byMap: {},
        barrelRejectionCounts: {},
        otherRejectionCounts: {},
    };
}

function bump(counts: Record<string, number>, key: string, amount: number): void {
    counts[key] = (counts[key] ?? 0) + amount;
}

function mapName(map: number): string {
    if (map === PBTypes.GridVals.NORMAL) return "NORMAL";
    if (map === PBTypes.GridVals.LAVA_CENTER) return "LAVA_CENTER";
    if (map === PBTypes.GridVals.BLOCK_CENTER) return "BLOCK_CENTER";
    if (map === PBTypes.GridVals.WATER_CENTER) return "WATER_CENTER";
    return `map-${map}`;
}

function absorb(totals: CohortTotals, result: BarrelFightResult): void {
    totals.games += 1;
    totals.placedBarrels += result.placed;
    totals.gamesWithZeroBarrels += Number(result.placed === 0);
    totals.gamesWithFewerThanFour += Number(result.placed < 4);
    totals.gamesWithBarrelStrike += Number(result.barrelStrikes > 0);
    const ranged = result.greenRanged + result.redRanged > 0;
    totals.gamesWithRanged += Number(ranged);
    totals.rangedGamesWithBarrelStrike += Number(ranged && result.barrelStrikes > 0);
    totals.barrelStrikes += result.barrelStrikes;
    totals.ownBarrelStrikes += result.ownBarrelStrikes;
    totals.enemyBarrelStrikes += result.enemyBarrelStrikes;
    totals.barrelRejections += result.barrelRejections;
    totals.otherObstacleStrikes += result.otherObstacleStrikes;
    totals.otherObstacleRejections += result.otherObstacleRejections;
    totals.otherRejections += result.otherRejections;
    totals.engineRejections += result.engineRejections;
    totals.unclassifiedRejections += result.unclassifiedRejections;
    totals.nonElimination += Number(result.endReason !== "elimination");
    const label = mapName(result.map);
    const mapTotals = (totals.byMap[label] ??= {
        games: 0,
        barrelStrikes: 0,
        otherObstacleStrikes: 0,
        barrelRejections: 0,
    });
    mapTotals.games += 1;
    mapTotals.barrelStrikes += result.barrelStrikes;
    mapTotals.otherObstacleStrikes += result.otherObstacleStrikes;
    mapTotals.barrelRejections += result.barrelRejections;
    for (const [key, count] of Object.entries(result.barrelRejectionCounts))
        bump(totals.barrelRejectionCounts, key, count);
    for (const [key, count] of Object.entries(result.otherRejectionCounts))
        bump(totals.otherRejectionCounts, key, count);
}

function cohortPlan(games: number): { cohort: AiMetaCohort; fights: number }[] {
    const ranged = Math.floor(games / 2);
    const rest = games - ranged;
    const cross = Math.floor(rest / 2);
    const uniform = rest - cross;
    return (
        [
            ["ranged-heavy", ranged],
            ["cross-archetype", cross],
            ["uniform-mixed", uniform],
        ] as const
    )
        .filter((entry) => entry[1] > 0)
        .map(([cohort, fights]) => ({ cohort, fights }));
}

function writeJson(path: string, value: unknown): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
}

function commonHead(): string {
    try {
        return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
        return "unknown";
    }
}

function fightKey(cohort: string, pair: number): string {
    return `${cohort}:${pair}`;
}

/** One JSON object per line. A crash can tear the last line; that line is ignored and the game is replayed. */
function loadCheckpoint(path: string): BarrelFightResult[] {
    if (!existsSync(path)) return [];
    const loaded: BarrelFightResult[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            loaded.push(JSON.parse(line) as BarrelFightResult);
        } catch {
            // Torn final write from a process crash.
        }
    }
    return loaded;
}

function topCounts(counts: Record<string, number>, limit: number): { key: string; count: number }[] {
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([key, count]) => ({ key, count }));
}

async function main(argv: readonly string[]): Promise<void> {
    if (argv[0] === "--help" || argv[0] === "-h") {
        console.log(USAGE);
        return;
    }
    const games = Number(argv[0] ?? 10_000);
    const concurrency = Number(argv[1] ?? 12);
    const baseSeed = Number(argv[2] ?? 1);
    if (!Number.isSafeInteger(games) || games < 1)
        throw new RangeError(`games must be a positive integer; got ${argv[0]}`);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new RangeError(`concurrency must be a positive integer; got ${argv[1]}`);
    }
    if (!Number.isSafeInteger(baseSeed)) throw new RangeError(`baseSeed must be an integer; got ${argv[2]}`);

    const outDir = argv[3] ?? join(process.cwd(), "sim-out", `barrel-use-${games}-s${baseSeed}`);
    mkdirSync(outDir, { recursive: true });
    const plan = cohortPlan(games);
    const requests: BarrelFightRequest[] = [];
    for (const entry of plan) {
        const matchupGames = entry.fights * AI_META_GAMES_PER_MATCHUP;
        for (let pair = 0; pair < entry.fights; pair += 1) {
            requests.push({
                cohort: entry.cohort,
                pair,
                matchupGames,
                baseSeed,
                greenIsArmyA: pair % 2 === 0,
            });
        }
    }

    const fightProfile = resolveAiMetaFightProfile("a19-work");
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizedAiMetaEnvironment(process.env, fightProfile))) {
        if (typeof value === "string") environment[key] = value;
    }
    const startedAtPath = join(outDir, "started-at.txt");
    const startedAt = existsSync(startedAtPath) ? Number(readFileSync(startedAtPath, "utf8")) : Date.now();
    if (!existsSync(startedAtPath)) writeFileSync(startedAtPath, `${startedAt}\n`);
    const head = commonHead();
    const byCohort = new Map<AiMetaCohort, CohortTotals>();
    for (const entry of plan) byCohort.set(entry.cohort, emptyTotals());
    const overall = emptyTotals();
    const samples: string[] = [];
    const checkpointPath = join(outDir, "results.jsonl");
    const wanted = new Set(requests.map((request) => fightKey(request.cohort, request.pair)));
    const seen = new Set<string>();
    for (const result of loadCheckpoint(checkpointPath)) {
        const key = fightKey(result.cohort, result.pair);
        if (!wanted.has(key) || seen.has(key)) continue;
        seen.add(key);
        absorb(overall, result);
        const cohortTotals = byCohort.get(result.cohort);
        if (!cohortTotals) continue;
        absorb(cohortTotals, result);
        for (const sample of result.barrelRejectionSamples) {
            if (samples.length < 40) samples.push(`${result.cohort}#${result.pair} ${sample}`);
        }
    }
    const pending = requests.filter((request) => !seen.has(fightKey(request.cohort, request.pair)));
    let completed = seen.size;

    const snapshot = (complete: boolean) => ({
        complete,
        purpose: "barrel placement, barrel strikes, and barrel-associated engine rejections; not a win-rate bake",
        policy: "v0.8 a19",
        search: "offline-deterministic-work (live 1000ms deadline disabled)",
        sideOrientedPlacement: true,
        tier1: "BARREL_BARRICADE forced on both sides",
        commonHead: head,
        baseSeed,
        concurrency,
        games: requests.length,
        cohorts: plan,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        completed,
        overall,
        byCohort: Object.fromEntries(byCohort),
        barrelRejectionSamples: samples,
        topOtherRejections: topCounts(overall.otherRejectionCounts, 15),
    });

    console.log(
        `Barrel use: ${requests.length} games (${plan.map((entry) => `${entry.cohort} ${entry.fights}`).join(", ")}), ` +
            `${pending.length} remaining, ${concurrency} workers, seed ${baseSeed}, a19 offline-deterministic -> ${outDir}`,
    );
    writeJson(join(outDir, "progress.json"), {
        completed,
        total: requests.length,
        elapsedSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        gamesPerSecond: 0,
        placedBarrels: overall.placedBarrels,
        barrelStrikes: overall.barrelStrikes,
        barrelRejections: overall.barrelRejections,
        engineRejections: overall.engineRejections,
        gamesWithZeroBarrels: overall.gamesWithZeroBarrels,
    });

    const pool =
        pending.length === 0
            ? null
            : new PersistentWorkerPool<BarrelFightRequest, BarrelFightResult>({
                  concurrency: Math.min(concurrency, pending.length),
                  maxQueuedTasks: Math.min(concurrency, pending.length),
                  workerUrl: new URL("./measure_barrel_use_worker.ts", import.meta.url),
                  workerOptions: { env: environment },
              });
    let next = 0;
    const lane = async (): Promise<void> => {
        if (!pool) return;
        while (true) {
            const index = next;
            if (index >= pending.length) return;
            next += 1;
            const result = await pool.run(pending[index]);
            appendFileSync(checkpointPath, `${JSON.stringify(result)}\n`);
            absorb(overall, result);
            const cohortTotals = byCohort.get(result.cohort);
            if (!cohortTotals) throw new Error(`Unexpected cohort ${result.cohort}`);
            absorb(cohortTotals, result);
            for (const sample of result.barrelRejectionSamples) {
                if (samples.length < 40) samples.push(`${result.cohort}#${result.pair} ${sample}`);
            }
            completed += 1;
            if (completed % 25 === 0 || completed === requests.length) {
                const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
                writeJson(join(outDir, "progress.json"), {
                    completed,
                    total: requests.length,
                    elapsedSeconds: Math.round(elapsed),
                    gamesPerSecond: Number((completed / elapsed).toFixed(3)),
                    placedBarrels: overall.placedBarrels,
                    barrelStrikes: overall.barrelStrikes,
                    barrelRejections: overall.barrelRejections,
                    engineRejections: overall.engineRejections,
                    gamesWithZeroBarrels: overall.gamesWithZeroBarrels,
                });
            }
            if (completed % 250 === 0 || completed === requests.length) {
                writeJson(
                    join(outDir, completed === requests.length ? "summary.json" : "partial-summary.json"),
                    snapshot(completed === requests.length),
                );
                const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
                console.log(
                    `  ${completed}/${requests.length} games, ${overall.barrelStrikes} barrel strikes, ` +
                        `${overall.barrelRejections} barrel rejections, ${(completed / elapsed).toFixed(2)} games/s`,
                );
            }
        }
    };

    if (pool) {
        try {
            await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => lane()));
            await pool.close();
        } catch (error) {
            await pool.terminate(error);
            throw error;
        }
    }

    const summary = snapshot(true);
    writeJson(join(outDir, "summary.json"), summary);
    console.log(`\nPlaced barrels: ${overall.placedBarrels} across ${overall.games} games`);
    console.log(
        `Games with 0 barrels: ${overall.gamesWithZeroBarrels}; fewer than 4: ${overall.gamesWithFewerThanFour}`,
    );
    console.log(
        `Barrel strikes: ${overall.barrelStrikes} (own ${overall.ownBarrelStrikes}, enemy ${overall.enemyBarrelStrikes}) ` +
            `in ${overall.gamesWithBarrelStrike} games`,
    );
    console.log(`Ranged games with a barrel strike: ${overall.rangedGamesWithBarrelStrike}/${overall.gamesWithRanged}`);
    console.log(`Barrel-associated rejections: ${overall.barrelRejections}`);
    console.log(
        `Other rejections: ${overall.otherRejections} (obstacle-not-barrel ${overall.otherObstacleRejections}, ` +
            `unclassified ${overall.unclassifiedRejections}, engine total ${overall.engineRejections})`,
    );
    console.log(`Non-elimination games: ${overall.nonElimination}`);
    console.log(`Summary: ${join(outDir, "summary.json")}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
