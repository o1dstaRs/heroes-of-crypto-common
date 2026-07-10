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

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AI_VERSIONS } from "../ai";
import { DEFAULT_ROSTER_COMPOSITION, STACK_EXPERIENCE_BUDGET } from "./army";
import { runTournamentConcurrent } from "./concurrent_tournament";
import { liveTwinSetup } from "./livetwin";
import type { ITournamentOptions, ITournamentSummary } from "./tournament";

export type LiveTwinCohortName = "melee" | "range" | "random";

export interface ILiveTwinCohortConfig {
    name: LiveTwinCohortName;
    rosterMode: "meleeDrafted" | "random";
    rangedStacks: { min: number; max: number } | null;
}

interface ILiveTwinCohortDefinition {
    config: ILiveTwinCohortConfig;
    env: Record<string, string | undefined>;
}

/**
 * The committed cohort battery. Every cohort keeps LiveTwin's exp-budget stacks and shipped SEE_NONE setup;
 * only roster construction changes. Three or more RANGE stacks out of the six-stack default army is the
 * established range-heavy boundary used by the fight policy.
 */
export const LIVETWIN_COHORTS: readonly ILiveTwinCohortDefinition[] = [
    {
        config: { name: "melee", rosterMode: "meleeDrafted", rangedStacks: null },
        env: { FIGHT_MELEE_ROSTERS: "1", ROSTER_RANGED_MIN: undefined, ROSTER_RANGED_MAX: undefined },
    },
    {
        config: { name: "range", rosterMode: "random", rangedStacks: { min: 3, max: 6 } },
        env: { FIGHT_MELEE_ROSTERS: "0", ROSTER_RANGED_MIN: "3", ROSTER_RANGED_MAX: "6" },
    },
    {
        config: { name: "random", rosterMode: "random", rangedStacks: null },
        env: { FIGHT_MELEE_ROSTERS: "0", ROSTER_RANGED_MIN: undefined, ROSTER_RANGED_MAX: undefined },
    },
] as const;

export interface INonRegressionStats {
    decisiveGames: number;
    winsA: number;
    winsB: number;
    draws: number;
    winRateA: number;
    deltaFromParityPp: number;
    standardErrorPp: number;
    winRate95: { low: number; high: number };
    /** Point-estimate gate used by the bake protocol: A must not finish below its opponent in this cohort. */
    passed: boolean;
}

export interface ILiveTwinCohortResult {
    cohort: ILiveTwinCohortConfig;
    tournament: ITournamentSummary;
    nonRegression: INonRegressionStats;
}

export interface ILiveTwinBatteryOptions {
    versionA: string;
    versionB: string;
    /** Games per cohort. Must be even so every seed has its side-swapped partner. */
    games: number;
    baseSeed: number;
    concurrency: number;
}

export interface ILiveTwinBatteryReport {
    schemaVersion: 1;
    generatedAt: string;
    versions: { candidate: string; opponent: string };
    gamesPerCohort: number;
    totalGames: number;
    baseSeed: number;
    concurrency: number;
    effectiveConfig: {
        preset: "LiveTwin";
        amountMode: "expBudget";
        stackExperienceBudget: number;
        composition: typeof DEFAULT_ROSTER_COMPOSITION;
        setup: ReturnType<typeof liveTwinSetup> & { noVision: true };
        independentTeamRosters: true;
        pairedSideSwap: true;
        map: "NORMAL";
        cohorts: ILiveTwinCohortConfig[];
    };
    headlineCohort: "melee";
    allCohortsPassedNonRegression: boolean;
    cohorts: ILiveTwinCohortResult[];
}

export interface ILiveTwinBatteryDependencies {
    runTournament: (
        options: ITournamentOptions,
        concurrency: number,
    ) => Promise<ITournamentSummary> | ITournamentSummary;
    now: () => Date;
}

const DEFAULT_DEPENDENCIES: ILiveTwinBatteryDependencies = {
    runTournament: runTournamentConcurrent,
    now: () => new Date(),
};

const MANAGED_ENV = [
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "AUGCA_NOVISION",
    "FORCE_CREATURES",
    "SIM_NO_ACTIONS",
] as const;

const BASE_ENV: Record<(typeof MANAGED_ENV)[number], string | undefined> = {
    LIVETWIN: "1",
    FIGHT_MELEE_ROSTERS: undefined,
    ROSTER_RANGED_MIN: undefined,
    ROSTER_RANGED_MAX: undefined,
    AUGCA_NOVISION: "1",
    FORCE_CREATURES: undefined,
    SIM_NO_ACTIONS: "1",
};

const wilson95 = (wins: number, total: number): { low: number; high: number } => {
    if (total <= 0) {
        return { low: 0, high: 1 };
    }
    const z = 1.959963984540054;
    const p = wins / total;
    const z2OverN = (z * z) / total;
    const center = (p + z2OverN / 2) / (1 + z2OverN);
    const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / (1 + z2OverN);
    return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
};

export function nonRegressionStats(summary: ITournamentSummary): INonRegressionStats {
    const winsA = summary.a.wins;
    const winsB = summary.b.wins;
    const decisiveGames = winsA + winsB;
    const winRateA = decisiveGames > 0 ? winsA / decisiveGames : 0.5;
    const standardError = decisiveGames > 0 ? Math.sqrt((winRateA * (1 - winRateA)) / decisiveGames) : 0.5;
    return {
        decisiveGames,
        winsA,
        winsB,
        draws: summary.draws,
        winRateA,
        deltaFromParityPp: (winRateA - 0.5) * 100,
        standardErrorPp: standardError * 100,
        winRate95: wilson95(winsA, decisiveGames),
        passed: decisiveGames > 0 && winsA >= winsB,
    };
}

function validateOptions(options: ILiveTwinBatteryOptions): void {
    if (!AI_VERSIONS.includes(options.versionA)) {
        throw new Error(`Unknown candidate version "${options.versionA}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    if (!AI_VERSIONS.includes(options.versionB)) {
        throw new Error(`Unknown opponent version "${options.versionB}". Known versions: ${AI_VERSIONS.join(", ")}`);
    }
    if (options.versionA === options.versionB) {
        throw new Error("candidateVersion and opponentVersion must be different so tournament wins can be attributed");
    }
    if (!Number.isSafeInteger(options.games) || options.games < 2 || options.games % 2 !== 0) {
        throw new Error("games must be an even integer >= 2 so every game has a side-swapped partner");
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0 || options.baseSeed > 0xffffffff) {
        throw new Error("baseSeed must be an integer in [0, 2^32-1]");
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error("concurrency must be a positive integer");
    }
}

async function withEnvironment<T>(
    overrides: Record<string, string | undefined>,
    operation: () => Promise<T> | T,
): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const key of MANAGED_ENV) {
        saved.set(key, process.env[key]);
        const value = overrides[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        return await operation();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

export async function runLiveTwinBattery(
    options: ILiveTwinBatteryOptions,
    dependencies: Partial<ILiveTwinBatteryDependencies> = {},
): Promise<ILiveTwinBatteryReport> {
    validateOptions(options);
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const concurrency = Math.min(options.concurrency, options.games);
    const cohorts: ILiveTwinCohortResult[] = [];

    // Environment-backed roster controls are process-global, so cohorts deliberately run sequentially. Worker
    // threads capture these explicit values at construction; the finally block restores the caller's environment.
    for (const definition of LIVETWIN_COHORTS) {
        const env = { ...BASE_ENV, ...definition.env };
        const tournament = await withEnvironment(env, () =>
            deps.runTournament(
                {
                    versionA: options.versionA,
                    versionB: options.versionB,
                    games: options.games,
                    baseSeed: options.baseSeed,
                    amountMode: "expBudget",
                    randomizePicks: true,
                    lightweight: true,
                },
                concurrency,
            ),
        );
        cohorts.push({
            cohort: definition.config,
            tournament,
            nonRegression: nonRegressionStats(tournament),
        });
    }

    const setup = liveTwinSetup();
    return {
        schemaVersion: 1,
        generatedAt: deps.now().toISOString(),
        versions: { candidate: options.versionA, opponent: options.versionB },
        gamesPerCohort: options.games,
        totalGames: options.games * cohorts.length,
        baseSeed: options.baseSeed,
        concurrency,
        effectiveConfig: {
            preset: "LiveTwin",
            amountMode: "expBudget",
            stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
            composition: DEFAULT_ROSTER_COMPOSITION,
            setup: { ...setup, noVision: true },
            independentTeamRosters: true,
            pairedSideSwap: true,
            map: "NORMAL",
            cohorts: LIVETWIN_COHORTS.map((definition) => definition.config),
        },
        headlineCohort: "melee",
        allCohortsPassedNonRegression: cohorts.every((result) => result.nonRegression.passed),
        cohorts,
    };
}

export interface ILiveTwinBatteryCliOptions extends ILiveTwinBatteryOptions {
    outputPath: string;
}

export function parseLiveTwinBatteryArgs(argv: string[], cwd: string = process.cwd()): ILiveTwinBatteryCliOptions {
    const [versionA, versionB, gamesArg, seedArg, concurrencyArg, outputArg, ...extra] = argv;
    if (!versionA || !versionB || extra.length > 0) {
        throw new Error(
            "usage: livetwin_battery <candidateVersion> <opponentVersion> [gamesPerCohort] [baseSeed] [concurrency] [output.json|-]",
        );
    }
    const games = gamesArg === undefined ? 3000 : Number(gamesArg);
    const baseSeed = seedArg === undefined ? 1 : Number(seedArg);
    const defaultConcurrency = Math.min(12, Math.max(1, availableParallelism()), Math.max(1, games));
    const concurrency = concurrencyArg === undefined ? defaultConcurrency : Number(concurrencyArg);
    const defaultOutput = join(cwd, "sim-out", "livetwin", `${versionA}_vs_${versionB}_seed${baseSeed}.battery.json`);
    const outputPath = outputArg === "-" ? "-" : resolve(cwd, outputArg ?? defaultOutput);
    const options = { versionA, versionB, games, baseSeed, concurrency, outputPath };
    validateOptions(options);
    return options;
}

export function writeLiveTwinBatteryReport(report: ILiveTwinBatteryReport, outputPath: string): void {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath === "-") {
        process.stdout.write(json);
        return;
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const options = parseLiveTwinBatteryArgs(argv);
    const report = await runLiveTwinBattery(options);
    writeLiveTwinBatteryReport(report, options.outputPath);
    if (options.outputPath !== "-") {
        for (const result of report.cohorts) {
            const stats = result.nonRegression;
            console.log(
                `${result.cohort.name}: ${(stats.winRateA * 100).toFixed(2)}% ` +
                    `(${stats.deltaFromParityPp >= 0 ? "+" : ""}${stats.deltaFromParityPp.toFixed(2)}pp) ` +
                    `${stats.passed ? "PASS" : "REGRESSION"}`,
            );
        }
        console.log(`LiveTwin battery summary -> ${options.outputPath}`);
    }
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
