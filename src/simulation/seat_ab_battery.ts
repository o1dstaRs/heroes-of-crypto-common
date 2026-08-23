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
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { AI_VERSIONS } from "../ai";
import { DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { PBTypes } from "../generated/protobuf/v1/types";
import { DEFAULT_AMOUNT_BY_LEVEL, DEFAULT_ROSTER_COMPOSITION, hashSimulationParts } from "./army";
import { type IMatchConfig } from "./battle_engine";
import { DEFAULT_OFFER_K, draftRoster } from "./draft";
import { leagueRoster, resolveLeaguePick } from "./league_eval";
import { type ILeagueGenome } from "./league_genome";
import { liveTwinSetup } from "./livetwin";

/**
 * SEAT-SCOPED A/B BATTERY (W16) — win-rate A/B of a version-scoped, env-gated feature under the two
 * distributions the W15 gap table was priced on:
 *
 *   --draft-source round1    — the real live pick_sim reducer driven by the shipped round-1 genome, boards
 *                              byte-identical to kit_omission_census.ts / measure_round1_misplay_census.ts
 *                              (same "round1-census-pick"/"round1-census-battle" seed construction), so a
 *                              priced gap and its intervention are measured on the SAME board stream;
 *   --draft-source heuristic — misplay_audit.ts's original construction (draftRoster/DEFAULT_DRAFT_W +
 *                              liveTwinSetup), the heuristic-draft LIVETWIN distribution.
 *
 * The candidate seat is a measurement ALIAS version (v0.7s = byte-policy v0.7; see v0_7s.ts): with every
 * gate off this battery is an EXACT-50 control (deterministic engine + side-swapped pairs = every pair
 * splits 1-1), and with a gate scoped to the alias (e.g. V06_RIDER_EV=on V06_RIDER_EV_VERSIONS=v0.7s, or
 * V06_MELEE_DIMS="a,b" V06_MELEE_DIMS_VERSIONS=v0.7s) the measured delta from 50% is exactly the feature's
 * effect on the candidate seat.
 *
 * Each PAIR is one drafted board played twice with the SAME armies/setup/battle seed and only the version
 * strings swapped (candidate green then candidate red), so seat luck cancels within the pair.
 *
 * Usage:
 *   SIM_NO_ACTIONS=1 [gates...] bun src/simulation/seat_ab_battery.ts v0.7s v0.7 \
 *     [--pairs 2000] [--seed 87050710] [--draft-source round1] [--concurrency 8] [--output report.json]
 */

export type SeatAbDraftSource = "round1" | "heuristic";

export interface ISeatAbOptions {
    candidateVersion: string;
    opponentVersion: string;
    pairs: number;
    baseSeed: number;
    draftSource: SeatAbDraftSource;
    maxLaps?: number;
}

/** Board construction byte-identical to kit_omission_census.ts's round1Game (same seeding, same reducer). */
function round1Pair(genome: ILeagueGenome, options: ISeatAbOptions, pair: number): [IMatchConfig, IMatchConfig] {
    const seed = (options.baseSeed + pair * 0x9e3779b1) >>> 0;
    const pickSeed = hashSimulationParts("round1-census-pick", seed);
    const battleSeed = hashSimulationParts("round1-census-battle", seed);
    const pick = resolveLeaguePick(pickSeed, genome, genome, true);
    const base: Omit<IMatchConfig, "greenVersion" | "redVersion"> = {
        roster: leagueRoster(pick.state.lower.creatures),
        redRoster: leagueRoster(pick.state.upper.creatures),
        seed: battleSeed,
        maxLaps: options.maxLaps,
        gridType: PBTypes.GridVals.NORMAL,
        greenArtifactT1: pick.state.lower.tier1Artifact,
        redArtifactT1: pick.state.upper.tier1Artifact,
        greenArtifactT2: pick.state.lower.tier2Artifact,
        redArtifactT2: pick.state.upper.tier2Artifact,
        greenPerk: pick.state.lower.perk,
        redPerk: pick.state.upper.perk,
        greenAugments: pick.lowerAugments,
        redAugments: pick.upperAugments,
        greenSynergies: SETUP_POLICY_V0.pickSynergies(pick.state.lower.creatures),
        redSynergies: SETUP_POLICY_V0.pickSynergies(pick.state.upper.creatures),
    };
    return [
        { ...base, greenVersion: options.candidateVersion, redVersion: options.opponentVersion },
        { ...base, greenVersion: options.opponentVersion, redVersion: options.candidateVersion },
    ];
}

/** Board construction byte-identical to kit_omission_census.ts's heuristicGame (misplay_audit.ts's). */
function heuristicPair(options: ISeatAbOptions, pair: number): [IMatchConfig, IMatchConfig] {
    const seed = (options.baseSeed + pair * 0x9e3779b1) >>> 0;
    const roster = draftRoster(
        DEFAULT_DRAFT_W,
        seed,
        DEFAULT_ROSTER_COMPOSITION,
        DEFAULT_AMOUNT_BY_LEVEL,
        DEFAULT_OFFER_K,
        "expBudget",
    );
    const redRoster = draftRoster(
        DEFAULT_DRAFT_W,
        (seed ^ 0x85ebca6b) >>> 0,
        DEFAULT_ROSTER_COMPOSITION,
        DEFAULT_AMOUNT_BY_LEVEL,
        DEFAULT_OFFER_K,
        "expBudget",
    );
    const greenSetup = liveTwinSetup();
    const redSetup = liveTwinSetup();
    const base: Omit<IMatchConfig, "greenVersion" | "redVersion"> = {
        roster,
        redRoster,
        seed,
        maxLaps: options.maxLaps,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: greenSetup.perk,
        redPerk: redSetup.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
    };
    return [
        { ...base, greenVersion: options.candidateVersion, redVersion: options.opponentVersion },
        { ...base, greenVersion: options.opponentVersion, redVersion: options.candidateVersion },
    ];
}

/** Even index = candidate on GREEN, odd = candidate on RED; indices 2p / 2p+1 share pair p's armies. */
export function buildSeatAbConfigs(options: ISeatAbOptions): IMatchConfig[] {
    const genome =
        options.draftSource === "round1"
            ? projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC))
            : undefined;
    const configs: IMatchConfig[] = [];
    for (let pair = 0; pair < options.pairs; pair += 1) {
        const [candidateGreen, candidateRed] =
            options.draftSource === "round1" ? round1Pair(genome!, options, pair) : heuristicPair(options, pair);
        configs.push(candidateGreen, candidateRed);
    }
    return configs;
}

export interface ISeatAbGameResult {
    game: number;
    winner: "green" | "red" | "draw";
    laps: number;
    endReason: string;
}

export interface ISeatAbSummary {
    games: number;
    decisiveGames: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    candidateGreenWins: number;
    candidateRedWins: number;
    candidateWinRate: number;
    deltaFromParityPp: number;
    standardErrorPp: number;
    winRate95: { low: number; high: number };
    avgLaps: number;
    endReasons: Record<string, number>;
}

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

/** Pure attribution: even games the candidate is GREEN, odd games RED (buildSeatAbConfigs's contract). */
export function summarizeSeatAb(results: readonly ISeatAbGameResult[]): ISeatAbSummary {
    let candidateWins = 0;
    let opponentWins = 0;
    let draws = 0;
    let candidateGreenWins = 0;
    let candidateRedWins = 0;
    let totalLaps = 0;
    const endReasons: Record<string, number> = {};
    for (const result of results) {
        totalLaps += result.laps;
        endReasons[result.endReason] = (endReasons[result.endReason] ?? 0) + 1;
        if (result.winner === "draw") {
            draws += 1;
            continue;
        }
        const candidateSeat = result.game % 2 === 0 ? "green" : "red";
        if (result.winner === candidateSeat) {
            candidateWins += 1;
            if (candidateSeat === "green") candidateGreenWins += 1;
            else candidateRedWins += 1;
        } else {
            opponentWins += 1;
        }
    }
    const decisiveGames = candidateWins + opponentWins;
    const winRate = decisiveGames > 0 ? candidateWins / decisiveGames : 0.5;
    return {
        games: results.length,
        decisiveGames,
        candidateWins,
        opponentWins,
        draws,
        candidateGreenWins,
        candidateRedWins,
        candidateWinRate: winRate,
        deltaFromParityPp: (winRate - 0.5) * 100,
        standardErrorPp: decisiveGames > 0 ? Math.sqrt((winRate * (1 - winRate)) / decisiveGames) * 100 : 50,
        winRate95: wilson95(candidateWins, decisiveGames),
        avgLaps: results.length > 0 ? totalLaps / results.length : 0,
        endReasons,
    };
}

/** Env gates recorded for audit — the report must show exactly which feature the delta belongs to. */
const AUDITED_ENV = [
    "V06_RIDER_EV",
    "V06_RIDER_EV_VERSIONS",
    "V06_MELEE_DIMS",
    "V06_MELEE_DIMS_VERSIONS",
    "V06_AREA_THROW",
    "V06_AREA_THROW_VERSIONS",
    "V07_CASTER_EXTRA",
    "V07_CASTER_EXTRA_VERSIONS",
    "V06_WEIGHTS",
    "LIVETWIN",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "ROSTER_RANGED_MIN",
    "ROSTER_RANGED_MAX",
    "SIM_NO_ACTIONS",
] as const;

async function runBattery(
    configs: readonly IMatchConfig[],
    concurrency: number,
    onGame?: (completed: number, total: number) => void,
): Promise<ISeatAbGameResult[]> {
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, configs.length));
    return new Promise<ISeatAbGameResult[]>((resolvePromise, rejectPromise) => {
        const results: ISeatAbGameResult[] = [];
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= configs.length) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched, config: configs[dispatched] });
            dispatched += 1;
        };
        const workerUrl = new URL("./seat_ab_battery_worker.ts", import.meta.url);
        for (let i = 0; i < poolSize; i += 1) {
            const worker = new Worker(workerUrl);
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        { type: "ready" } | ({ type: "result" } & ISeatAbGameResult) | { type: "error"; error: string },
                ) => {
                    if (settled) return;
                    if (message.type === "error") {
                        fail(new Error(message.error));
                        return;
                    }
                    if (message.type === "ready") {
                        dispatch(worker);
                        return;
                    }
                    results.push({
                        game: message.game,
                        winner: message.winner,
                        laps: message.laps,
                        endReason: message.endReason,
                    });
                    completed += 1;
                    onGame?.(completed, configs.length);
                    if (completed >= configs.length) {
                        settled = true;
                        cleanup();
                        resolvePromise(results);
                        return;
                    }
                    dispatch(worker);
                },
            );
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`seat A/B worker exited ${code} before completion`));
            });
        }
    });
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    }
    return parsed;
}

async function cliMain(): Promise<void> {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            pairs: { type: "string", default: "2000" },
            seed: { type: "string", default: "87050710" },
            "draft-source": { type: "string", default: "round1" },
            concurrency: { type: "string", default: "" },
            output: { type: "string", default: "" },
        },
    });
    const [candidateVersion, opponentVersion] = positionals;
    if (!candidateVersion || !opponentVersion || candidateVersion === opponentVersion) {
        throw new Error(
            `usage: seat_ab_battery <candidateVersion> <opponentVersion> [--pairs N] [--seed S] ` +
                `[--draft-source round1|heuristic] [--concurrency C] [--output report.json] ` +
                `(distinct versions; known: ${AI_VERSIONS.join(", ")})`,
        );
    }
    for (const version of [candidateVersion, opponentVersion]) {
        if (!AI_VERSIONS.includes(version)) {
            throw new Error(`Unknown version "${version}". Known versions: ${AI_VERSIONS.join(", ")}`);
        }
    }
    const draftSource = values["draft-source"] as SeatAbDraftSource;
    if (draftSource !== "round1" && draftSource !== "heuristic") {
        throw new Error(`--draft-source must be round1 or heuristic; got ${draftSource}`);
    }
    // Fights don't need per-action recording; keep workers lightweight unless the caller overrides.
    process.env.SIM_NO_ACTIONS ??= "1";
    const options: ISeatAbOptions = {
        candidateVersion,
        opponentVersion,
        pairs: positiveInteger(values.pairs!, "--pairs"),
        baseSeed: positiveInteger(values.seed!, "--seed"),
        draftSource,
    };
    const concurrency = values.concurrency
        ? positiveInteger(values.concurrency, "--concurrency")
        : Math.min(12, Math.max(1, availableParallelism()));
    const configs = buildSeatAbConfigs(options);
    console.error(
        `seat A/B: ${candidateVersion} vs ${opponentVersion}, ${options.pairs} pairs (${configs.length} games), ` +
            `draft-source=${draftSource}, seed ${options.baseSeed}, concurrency ${concurrency}`,
    );
    const started = Date.now();
    const results = await runBattery(configs, concurrency, (completed, total) => {
        if (completed % 500 === 0 || completed === total) {
            console.error(`  ${completed}/${total} games...`);
        }
    });
    const summary = summarizeSeatAb(results);
    const report = {
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        candidateVersion,
        opponentVersion,
        draftSource,
        pairs: options.pairs,
        baseSeed: options.baseSeed,
        elapsedMs: Date.now() - started,
        env: Object.fromEntries(AUDITED_ENV.map((key) => [key, process.env[key] ?? null])),
        summary,
    };
    const outputPath = values.output
        ? resolve(process.cwd(), values.output)
        : resolve(
              process.cwd(),
              "sim-out",
              "seat_ab",
              `${candidateVersion}_vs_${opponentVersion}_${draftSource}_seed${options.baseSeed}.json`.replace(
                  /[^a-zA-Z0-9._-]/g,
                  "_",
              ),
          );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    const s = summary;
    console.log(
        `${candidateVersion} vs ${opponentVersion} [${draftSource}]: ${(s.candidateWinRate * 100).toFixed(2)}% ` +
            `(${s.deltaFromParityPp >= 0 ? "+" : ""}${s.deltaFromParityPp.toFixed(2)}pp ± ${s.standardErrorPp.toFixed(2)}) ` +
            `on ${s.decisiveGames} decisive of ${s.games} games (draws ${s.draws}; candidate green/red wins ` +
            `${s.candidateGreenWins}/${s.candidateRedWins}); 95% [${(s.winRate95.low * 100).toFixed(2)}, ` +
            `${(s.winRate95.high * 100).toFixed(2)}]`,
    );
    console.log(`report -> ${outputPath}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    cliMain().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
