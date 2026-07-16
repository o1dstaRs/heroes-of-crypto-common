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
import { leagueRoster, resolveLeaguePick } from "./league_eval";
import { type ILeagueGenome } from "./league_genome";
import { liveTwinSetup } from "./livetwin";
import {
    createMisplayAuditTally,
    mergeMisplayAuditTallies,
    type ICreatureAuditSummary,
    type IMisplayAuditTally,
    type IOpportunitySummary,
} from "./misplay_audit";

/**
 * DISTRIBUTION-SHIFT CENSUS, PART 2 — the misplay_audit.ts repertoire-gap census, re-run against the
 * ROUND-1-drafted distribution (server 8823670, HOC_DRAFT_WEIGHTS=league-r1-br-57de5a2d) instead of the
 * ~97%-melee heuristic drafts the original W2 census used, and against v0.7 (the live fight policy)
 * instead of the W2-era v0.6.
 *
 * Reuses misplay_audit.ts's own tally primitives (createMisplayAuditTally / mergeMisplayAuditTallies /
 * the IMisplayAuditTally shape) and the exact same candidate-omission accounting rule (a class/spell
 * counts as an "opportunity" once per acting unit-turn iff enumerateCandidates found a legal alternative
 * the incumbent decision did not already use — see measure_round1_misplay_census_worker.ts, which
 * duplicates that ~60-line rule verbatim). misplay_audit.ts's own AUDITED_VERSION/roster construction are
 * hardcoded to v0.6 + the old heuristic drafter, so this is a sibling script rather than a flag on that
 * file — it is a committed, tested measurement primitive and this script intentionally does not touch it.
 *
 * Two-file split (this orchestrator + measure_round1_misplay_census_worker.ts), NOT the single-file
 * isMainThread pattern league_eval.ts/measure_setup_conditional.ts use: this script needs league_eval.ts
 * (for resolveLeaguePick/leagueRoster) in its own process, but league_eval.ts has an
 * `if (!isMainThread) workerMain(...)` top-level side effect — since isMainThread is a per-THREAD global,
 * not a per-module one, statically importing league_eval.ts from a file that ALSO self-spawns as a worker
 * would register a second, wrongly-shaped message handler on that worker the instant it loaded. Instead,
 * every pick_sim draft is resolved here in the MAIN thread (cheap: ~2000 drafts in well under a second,
 * see measure_round1_draft_distribution.ts) and each worker receives a fully-resolved, plain-JSON
 * IMatchConfig and only ever runs the fight.
 *
 * --draft-source round1 (default): full live pick_sim reducer driven by the round-1 genome on both seats
 *   (mirrored), matching the draft-ship acceptance harness's construction (projectDraftGenomeForShipping
 *   collapses every non-intrinsic head to the setup-v0 anchor — verified equivalent to the live ranked
 *   TIER1_ARTIFACT_WINRATE-driven bundle/T2 choice, SEE_NONE perk + Armor3/Might3/Sniper1 augments, and
 *   (because SEE_NONE reveals nothing) always-tight placement).
 * --draft-source heuristic: byte-identical roster construction to misplay_audit.ts's playMisplayAuditGame
 *   (draftRoster/DEFAULT_DRAFT_W over DEFAULT_ROSTER_COMPOSITION + liveTwinSetup, no artifacts/synergies),
 *   just with a configurable --fight-version — isolates the fight-policy-version effect (v0.6->v0.7) from
 *   the distribution-shift effect (heuristic->round1) when both scripts are compared pairwise.
 *
 * Usage: bun src/simulation/measure_round1_misplay_census.ts [--games 2000] [--seed 86006710]
 *   [--concurrency 12] [--fight-version v0.7] [--draft-source round1] [--output sim-out/report.json]
 */

export const MISPLAY_KILL_THRESHOLD = 0.015;
export const FOCUS_CAPABILITIES = ["spell:Resurrection", "spell:Wind Flow", "spell:Castling", "area_throw"] as const;
export type DraftSource = "round1" | "heuristic";

export interface INormalizedCensusOptions {
    games: number;
    baseSeed: number;
    fightVersion: string;
    draftSource: DraftSource;
    maxLaps?: number;
}

/** Round-1-vs-round-1 mirrored pick_sim draft -> full LiveTwin-equivalent army (roster, T1/T2 artifact,
 * SEE_NONE perk, Armor3/Might3/Sniper1 augments, always-tight placement under no vision, synergies). */
function round1Game(genome: ILeagueGenome, options: INormalizedCensusOptions, game: number): IMatchConfig {
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

/** Byte-identical to misplay_audit.ts's playMisplayAuditGame roster/setup construction. */
function heuristicGame(options: INormalizedCensusOptions, game: number): IMatchConfig {
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

function buildConfigs(options: INormalizedCensusOptions): IMatchConfig[] {
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

function summaries(
    counters: Record<string, { opportunityTurns: number; alternativeCandidates: number }>,
    turns: number,
): IOpportunitySummary[] {
    return Object.entries(counters)
        .map(([key, value]) => ({ key, ...value, shareOfActingTurns: turns ? value.opportunityTurns / turns : 0 }))
        .sort(
            (a, b) =>
                b.opportunityTurns - a.opportunityTurns ||
                b.alternativeCandidates - a.alternativeCandidates ||
                a.key.localeCompare(b.key),
        );
}
function sortedNumbers(record: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export function finalizeCensus(options: INormalizedCensusOptions, tally: IMisplayAuditTally) {
    const turns = tally.actingUnitTurns;
    const classBreakdown = summaries(tally.classCounters, turns);
    const spellBreakdown = summaries(tally.spellCounters, turns);
    const topMissedCapabilities = summaries(tally.capabilityCounters, turns);
    const repertoireGapBreakdown = topMissedCapabilities.filter(
        (summary) => summary.key === "area_throw" || summary.key.startsWith("spell:"),
    );
    const zeroSummary = (key: string): IOpportunitySummary => ({
        key,
        opportunityTurns: 0,
        alternativeCandidates: 0,
        shareOfActingTurns: 0,
    });
    const focusBreakdown = Object.fromEntries(
        FOCUS_CAPABILITIES.map((key) => [key, topMissedCapabilities.find((s) => s.key === key) ?? zeroSummary(key)]),
    );
    const creatures = Object.entries(tally.creatures)
        .map(([creature, value]): ICreatureAuditSummary => {
            const opportunities = summaries(
                Object.fromEntries(
                    Object.entries(value.opportunities).map(([key, opportunityTurns]) => [
                        key,
                        { opportunityTurns, alternativeCandidates: value.opportunityCandidates[key] ?? 0 },
                    ]),
                ),
                value.actingTurns,
            );
            const summedOpportunityCount = opportunities.reduce((sum, entry) => sum + entry.opportunityTurns, 0);
            return {
                creature,
                actingTurns: value.actingTurns,
                alternativeCandidates: value.alternativeCandidates,
                summedOpportunityCount,
                summedOpportunityShare: value.actingTurns ? summedOpportunityCount / value.actingTurns : 0,
                opportunities,
                incumbentDecisionShapes: sortedNumbers(value.incumbentDecisionShapes),
            };
        })
        .sort(
            (a, b) =>
                b.summedOpportunityCount - a.summedOpportunityCount ||
                b.actingTurns - a.actingTurns ||
                a.creature.localeCompare(b.creature),
        );
    const topThree = repertoireGapBreakdown.slice(0, 3);
    const summedOpportunityShare = topThree.reduce((sum, entry) => sum + entry.shareOfActingTurns, 0);
    return {
        schemaVersion: 1,
        status: "candidate_omission_census",
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
        },
        outcomes: {
            greenWins: tally.outcomes.greenWins,
            redWins: tally.outcomes.redWins,
            draws: tally.outcomes.draws,
            avgLaps: tally.games ? tally.outcomes.totalLaps / tally.games : 0,
            endReasons: sortedNumbers(tally.outcomes.endReasons),
        },
        alternativeCandidates: tally.alternativeCandidates,
        avgAlternativeCandidatesPerTurn: turns ? tally.alternativeCandidates / turns : 0,
        classBreakdown,
        spellBreakdown,
        focusBreakdown,
        repertoireGapBreakdown,
        topMissedCapabilities,
        creatures,
        topCreatures: creatures.slice(0, 20),
        enumerationAudit: {
            truncatedTurns: tally.truncatedTurns,
            truncatedClasses: sortedNumbers(tally.truncatedClasses),
            ignoredStrategyTurns: tally.ignoredStrategyTurns,
        },
        topThreeKillMetric: {
            metric: "sum of the top three Q1 repertoire-gap shares (spell:* and area_throw); opportunities may overlap on one turn",
            eligibleCapabilities: "spell:* and area_throw",
            topThree,
            summedOpportunityShare,
            threshold: MISPLAY_KILL_THRESHOLD,
            belowThreshold: turns > 0 && summedOpportunityShare < MISPLAY_KILL_THRESHOLD,
            verdict: "not_claimed",
        },
        limitations: [
            "An omission means an engine-legal alternative class existed and the audited version chose no action in that class; it is not evidence the alternative was better.",
            "Opportunity shares overlap because one unit-turn can omit multiple candidate classes or spells.",
            "M3 rider-EV scorer gaps (petrify/stun/kill-secure/charge valuation) are not observable from action-class enumeration and require score-level instrumentation, same limitation as misplay_audit.ts.",
            "The census covers fight decisions only; pick_sim draft/setup/placement opportunities are outside its scope (see measure_round1_draft_distribution.ts for the draft side).",
            "round1 draft-source fields real T1/T2 artifacts (from the pick_sim bundle/tier2 choice) and synergies; heuristic draft-source fields neither, matching misplay_audit.ts's original W2-era construction exactly.",
        ],
    };
}

export type ICensusReport = ReturnType<typeof finalizeCensus>;

async function runCensus(
    configs: readonly IMatchConfig[],
    options: INormalizedCensusOptions,
    concurrency: number,
    onGame?: (completed: number, total: number) => void,
): Promise<ICensusReport> {
    // Always dispatched through the worker pool (min 1 worker) — see the file header for why this
    // orchestrator cannot itself double as the worker entry point (league_eval.ts import hazard).
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, configs.length));
    return new Promise<ICensusReport>((resolvePromise, rejectPromise) => {
        const tally = createMisplayAuditTally();
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
        const workerUrl = new URL("./measure_round1_misplay_census_worker.ts", import.meta.url);
        for (let i = 0; i < poolSize; i += 1) {
            const worker = new Worker(workerUrl);
            workers.push(worker);
            worker.on(
                "message",
                (
                    message:
                        | { type: "ready" }
                        | { type: "result"; tally: IMisplayAuditTally }
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
                    mergeMisplayAuditTallies(tally, message.tally);
                    completed += 1;
                    onGame?.(completed, configs.length);
                    if (completed >= configs.length) {
                        settled = true;
                        cleanup();
                        resolvePromise(finalizeCensus(options, tally));
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
            seed: { type: "string", default: "86006710" },
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
    const options: INormalizedCensusOptions = {
        games,
        baseSeed,
        fightVersion: values["fight-version"]!,
        draftSource,
    };

    console.error(
        `Running ROUND1 MISPLAY_AUDIT: ${games} fresh LiveTwin ${options.fightVersion} mirrors ` +
            `(draft-source=${draftSource}, seed ${baseSeed}, concurrency ${concurrency})`,
    );
    console.error("  resolving pick_sim drafts (main thread)...");
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
    console.error(
        `Observed ${report.actingUnitTurns} acting turns; top-3 summed omission share ` +
            `${(report.topThreeKillMetric.summedOpportunityShare * 100).toFixed(2)}% ` +
            `(threshold ${(MISPLAY_KILL_THRESHOLD * 100).toFixed(1)}%, verdict not claimed).`,
    );
}

if (import.meta.main) {
    FightStateManager.getInstance();
    cliMain().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
