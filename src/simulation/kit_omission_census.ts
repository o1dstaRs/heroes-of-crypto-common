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

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import { DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    DEFAULT_AMOUNT_BY_LEVEL,
    DEFAULT_ROSTER_COMPOSITION,
    hashSimulationParts,
    STACK_EXPERIENCE_BUDGET,
} from "./army";
import { type IMatchConfig } from "./battle_engine";
import { DEFAULT_OFFER_K, draftRoster } from "./draft";
import {
    createKitOmissionTally,
    mergeKitOmissionTallies,
    type IKitCapabilityTally,
    type IKitOmissionTally,
} from "./kit_omission_tally";
import { leagueRoster, resolveLeaguePick } from "./league_eval";
import { type ILeagueGenome } from "./league_genome";
import { liveTwinSetup } from "./livetwin";

export type { IKitCapabilityTally, IKitCreatureTally, IKitOmissionTally } from "./kit_omission_tally";

/**
 * KIT-OMISSION CENSUS — the W14 "settlement instrument" for the sim-vs-live Healer/Satyr disagreement
 * (docs/v0_7_plan.html §8, W13 census vs W14 live-mining entries).
 *
 * W13's misplay census counts a spell as an "opportunity" when it was engine-legal and unchosen, but it
 * never keeps the CHOSEN side, so it cannot produce the aggregate the W14 real-game miner produces (cast
 * SOMETHING vs cast nothing per acting turn). The two data sources therefore measured different
 * quantities and their headlines ("essentially never casts" vs "casts on 89% of turns") could not be
 * compared. This census records, at every acting unit-turn, with enumerateCandidates (F4 complete,
 * uncapped) as the legality source:
 *
 *   per (creature, capability):  legalTurns / chosenTurns / omittedTurns
 *     -> conditional omission rate  = omitted / legal            (W13's quantity, now with the true
 *                                                                 legal-turn denominator)
 *     -> cast share of acting turns = chosen / actingTurns       (per-spell live-comparable share)
 *   per creature:  anySpellLegalTurns / anySpellCastTurns / anySpellOmittedTurns
 *     -> anySpellCastShare = cast / acting                       (the W14 live metric: Healer 89.0%,
 *                                                                 Satyr 65.2%)
 *
 * Roster/setup construction is byte-identical to measure_round1_misplay_census.ts (same round1Game /
 * heuristicGame builders, same seeding), so a same-seed run is directly comparable to the W13 cells and
 * the omittedTurns/actingTurns column must reproduce W13's per-spell opportunity shares exactly.
 *
 * Env-gated per-turn dump (Q2_DATASET convention — absent = no dump, no default impact):
 *   KIT_OMISSION_DATASET=path — each worker appends `${path}.w<i>.jsonl` rows
 *     {t:"turn", seed, lap, side, unit, shape, chosen:[caps], legal:{cap:candidateCount}, omitted:[caps]}.
 *
 * EV-pricing mode (the "search machinery prices a forgone action" leg): run this same census under
 *   V07_SEARCH=1 SEARCH_VERSIONS=v0.7 SEARCH_GATE=<huge> SEARCH_IL_DATASET=<base> SEARCH_IL_RUN_FINGERPRINT=<64hex>
 * A huge gate keeps every decision on-policy (no overrides) while the committed SearchDriver still
 * rollout-scores every capped candidate and dumps per-candidate mean leaf values (P(win) units) into the
 * IL dataset; each worker gets its own `${base}.w<i>` shard via workerData (see the worker header). The
 * omission tally is unchanged in this mode; the IL shards price each forgone capability as
 * m(best candidate of that capability) - m(chosen). No search internals are touched — env-gated public
 * machinery only.
 *
 * Usage: bun src/simulation/kit_omission_census.ts [--games 2000] [--seed 87000710] [--concurrency 10]
 *   [--fight-version v0.7] [--draft-source round1|heuristic] [--output sim-out/report.json]
 */

export type DraftSource = "round1" | "heuristic";

export interface IKitCensusOptions {
    games: number;
    baseSeed: number;
    fightVersion: string;
    draftSource: DraftSource;
    maxLaps?: number;
}

/** Byte-identical to measure_round1_misplay_census.ts's round1Game (same seeding, same pick reducer). */
function round1Game(genome: ILeagueGenome, options: IKitCensusOptions, game: number): IMatchConfig {
    const seed = (options.baseSeed + game * 0x9e3779b1) >>> 0;
    const pickSeed = hashSimulationParts("round1-census-pick", seed);
    const battleSeed = hashSimulationParts("round1-census-battle", seed);
    const pick = resolveLeaguePick(pickSeed, genome, genome, true);
    return {
        greenVersion: options.fightVersion,
        redVersion: options.fightVersion,
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
}

/** Byte-identical to measure_round1_misplay_census.ts's heuristicGame (misplay_audit.ts construction). */
function heuristicGame(options: IKitCensusOptions, game: number): IMatchConfig {
    const seed = (options.baseSeed + game * 0x9e3779b1) >>> 0;
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
    return {
        greenVersion: options.fightVersion,
        redVersion: options.fightVersion,
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
}

function buildConfigs(options: IKitCensusOptions): IMatchConfig[] {
    const genome =
        options.draftSource === "round1"
            ? projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC))
            : undefined;
    const configs: IMatchConfig[] = [];
    for (let game = 0; game < options.games; game += 1) {
        configs.push(
            options.draftSource === "round1" ? round1Game(genome!, options, game) : heuristicGame(options, game),
        );
    }
    return configs;
}

export interface IKitCapabilitySummary extends IKitCapabilityTally {
    key: string;
    /** legalTurns / actingUnitTurns (or creature actingTurns at creature scope). */
    legalShareOfActingTurns: number;
    /** omittedTurns / legalTurns — the conditional omission rate W13 could not compute. */
    omissionRateAmongLegal: number;
    /** chosenTurns / actingTurns — directly comparable to the live per-spell cast shares. */
    chosenShareOfActingTurns: number;
    /** omittedTurns / actingTurns — W13's opportunity-share metric, kept for cross-validation. */
    omittedShareOfActingTurns: number;
}

export interface IKitCreatureSummary {
    creature: string;
    actingTurns: number;
    anySpellLegalTurns: number;
    anySpellCastTurns: number;
    anySpellOmittedTurns: number;
    /** anySpellCastTurns / actingTurns — the W14 live metric (Healer 89.0%, Satyr 65.2%). */
    anySpellCastShareOfActingTurns: number;
    /** anySpellCastTurns / anySpellLegalTurns — cast share conditioned on having a legal spell. */
    anySpellCastShareOfLegalTurns: number;
    capabilities: IKitCapabilitySummary[];
    decisionShapes: Record<string, number>;
}

function capabilitySummaries(
    capabilities: Record<string, IKitCapabilityTally>,
    actingTurns: number,
): IKitCapabilitySummary[] {
    return Object.entries(capabilities)
        .map(([key, value]) => ({
            key,
            ...value,
            legalShareOfActingTurns: actingTurns ? value.legalTurns / actingTurns : 0,
            omissionRateAmongLegal: value.legalTurns ? value.omittedTurns / value.legalTurns : 0,
            chosenShareOfActingTurns: actingTurns ? value.chosenTurns / actingTurns : 0,
            omittedShareOfActingTurns: actingTurns ? value.omittedTurns / actingTurns : 0,
        }))
        .sort((a, b) => b.omittedTurns - a.omittedTurns || b.legalTurns - a.legalTurns || a.key.localeCompare(b.key));
}

function sortedNumbers(record: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function finalizeKitCensus(options: IKitCensusOptions, tally: IKitOmissionTally) {
    const turns = tally.actingUnitTurns;
    const capabilities = capabilitySummaries(tally.capabilities, turns);
    const creatures = Object.entries(tally.creatures)
        .map(([creature, value]): IKitCreatureSummary => {
            return {
                creature,
                actingTurns: value.actingTurns,
                anySpellLegalTurns: value.anySpellLegalTurns,
                anySpellCastTurns: value.anySpellCastTurns,
                anySpellOmittedTurns: value.anySpellOmittedTurns,
                anySpellCastShareOfActingTurns: value.actingTurns ? value.anySpellCastTurns / value.actingTurns : 0,
                anySpellCastShareOfLegalTurns: value.anySpellLegalTurns
                    ? value.anySpellCastTurns / value.anySpellLegalTurns
                    : 0,
                capabilities: capabilitySummaries(value.capabilities, value.actingTurns),
                decisionShapes: sortedNumbers(value.decisionShapes),
            };
        })
        .sort(
            (a, b) =>
                b.anySpellOmittedTurns - a.anySpellOmittedTurns ||
                b.actingTurns - a.actingTurns ||
                a.creature.localeCompare(b.creature),
        );
    return {
        schemaVersion: 1,
        status: "kit_omission_census",
        auditedVersion: options.fightVersion,
        draftSource: options.draftSource,
        games: tally.games,
        baseSeed: options.baseSeed,
        actingUnitTurns: turns,
        effectiveConfig: {
            preset: "LiveTwin",
            amountMode: "expBudget",
            stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
            composition: DEFAULT_ROSTER_COMPOSITION,
            draftSource:
                options.draftSource === "round1"
                    ? "pick_sim mirrored round-1 (br-57de5a2dab8b27b5), projectDraftGenomeForShipping"
                    : "draftRoster/DEFAULT_DRAFT_W over DEFAULT_ROSTER_COMPOSITION (misplay_audit.ts's original construction)",
            candidateEnumeration: "F4 complete and uncapped",
            observationPoint: "after decideTurn, before lookahead, apply and recovery",
            searchEnv: {
                V07_SEARCH: process.env.V07_SEARCH ?? null,
                SEARCH_VERSIONS: process.env.SEARCH_VERSIONS ?? null,
                SEARCH_GATE: process.env.SEARCH_GATE ?? null,
                SEARCH_IL_DATASET: process.env.SEARCH_IL_DATASET ?? null,
                KIT_OMISSION_DATASET: process.env.KIT_OMISSION_DATASET ?? null,
            },
        },
        outcomes: {
            greenWins: tally.outcomes.greenWins,
            redWins: tally.outcomes.redWins,
            draws: tally.outcomes.draws,
            avgLaps: tally.games ? tally.outcomes.totalLaps / tally.games : 0,
            endReasons: sortedNumbers(tally.outcomes.endReasons),
        },
        capabilities,
        spellCapabilities: capabilities.filter((c) => c.key.startsWith("spell:") || c.key === "area_throw"),
        creatures,
        topCreatures: creatures.slice(0, 20),
        enumerationAudit: { truncatedTurns: tally.truncatedTurns },
        limitations: [
            "An omission means enumerateCandidates found the capability engine-legal and the policy chose no action in it; it is not evidence the alternative was better (EV pricing is the separate search-mode leg).",
            "A capability is counted once per acting turn regardless of how many placements/targets were legal; legalCandidates keeps the raw count.",
            "anySpell* creature aggregates are the direct counterpart of the W14 real-game miner's cast-vs-no-cast rate; per-spell chosenShareOfActingTurns is the counterpart of its per-spell shares.",
            "omittedShareOfActingTurns reproduces W13's opportunity-share metric byte-for-byte at the same seed/games/construction (cross-validation column).",
            "The census covers fight decisions only; draft/setup/placement opportunities are out of scope.",
        ],
    };
}

export type IKitCensusReport = ReturnType<typeof finalizeKitCensus>;

async function runCensus(
    configs: readonly IMatchConfig[],
    options: IKitCensusOptions,
    concurrency: number,
    onGame?: (completed: number, total: number) => void,
): Promise<IKitCensusReport> {
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, configs.length));
    const kitDatasetBase = process.env.KIT_OMISSION_DATASET || undefined;
    const ilDatasetBase = process.env.SEARCH_IL_DATASET || undefined;
    return new Promise<IKitCensusReport>((resolvePromise, rejectPromise) => {
        const tally = createKitOmissionTally();
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
        const workerUrl = new URL("./kit_omission_census_worker.ts", import.meta.url);
        for (let i = 0; i < poolSize; i += 1) {
            const worker = new Worker(workerUrl, {
                workerData: {
                    kitDatasetShard: kitDatasetBase ? `${kitDatasetBase}.w${i}.jsonl` : undefined,
                    ilDatasetShard: ilDatasetBase ? `${ilDatasetBase}.w${i}.jsonl` : undefined,
                },
            });
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; tally: IKitOmissionTally }
                        | { type: "error"; error: string },
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
                    mergeKitOmissionTallies(tally, message.tally);
                    completed += 1;
                    onGame?.(completed, configs.length);
                    if (completed >= configs.length) {
                        settled = true;
                        cleanup();
                        resolvePromise(finalizeKitCensus(options, tally));
                        return;
                    }
                    dispatch(worker);
                },
            );
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`census worker exited ${code} before completing its jobs`));
            });
        }
    });
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    return parsed;
}

async function cliMain(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "2000" },
            seed: { type: "string", default: "87000710" },
            concurrency: { type: "string", default: String(Math.min(12, Math.max(1, availableParallelism()))) },
            "fight-version": { type: "string", default: "v0.7" },
            "draft-source": { type: "string", default: "round1" },
            output: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    const games = positiveInteger(values.games, "--games");
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) {
        throw new Error(`--seed must be an integer in [0, 2^32-1]; got ${values.seed}`);
    }
    const concurrency = positiveInteger(values.concurrency, "--concurrency");
    const draftSource = values["draft-source"] as DraftSource;
    if (draftSource !== "round1" && draftSource !== "heuristic") {
        throw new Error(`--draft-source must be round1 or heuristic; got ${draftSource}`);
    }
    const options: IKitCensusOptions = {
        games,
        baseSeed,
        fightVersion: values["fight-version"]!,
        draftSource,
    };
    console.error(
        `Running KIT_OMISSION_CENSUS: ${games} fresh LiveTwin ${options.fightVersion} mirrors ` +
            `(draft-source=${draftSource}, seed ${baseSeed}, concurrency ${concurrency})`,
    );
    console.error("  resolving drafts (main thread)...");
    const configs = buildConfigs(options);
    console.error(`  ${configs.length} armies resolved; running fights...`);
    const progressEvery = Math.max(10, Math.floor(games / 20));
    const report = await runCensus(configs, options, concurrency, (completed) => {
        if (completed % progressEvery === 0 || completed === games) console.error(`  ${completed}/${games} games`);
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) {
        const outputPath = resolve(values.output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        console.error(`Summary: ${outputPath}`);
    } else {
        process.stdout.write(json);
    }
    const spells = report.spellCapabilities.slice(0, 5);
    console.error(
        `Observed ${report.actingUnitTurns} acting turns; top omitted kit capabilities: ` +
            spells
                .map(
                    (s) =>
                        `${s.key} legal ${(s.legalShareOfActingTurns * 100).toFixed(2)}% ` +
                        `omit ${(s.omissionRateAmongLegal * 100).toFixed(1)}%`,
                )
                .join("; "),
    );
}

if (import.meta.main) {
    FightStateManager.getInstance();
    cliMain().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
