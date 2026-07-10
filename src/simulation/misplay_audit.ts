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
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";

import { enumerateCandidates, type CandidateKind, type ICandidateSet, type IDecisionContext } from "../ai";
import { DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import { DEFAULT_AMOUNT_BY_LEVEL, DEFAULT_ROSTER_COMPOSITION, STACK_EXPERIENCE_BUDGET } from "./army";
import { runMatch, type IDecisionObservation, type IMatchConfig, type IMatchResult } from "./battle_engine";
import { DEFAULT_OFFER_K, draftRoster } from "./draft";
import { LIVETWIN_PRESET, liveTwinSetup } from "./livetwin";

export const AUDITED_VERSION = "v0.6";
export const MISPLAY_KILL_THRESHOLD = 0.015;
export const FOCUS_CAPABILITIES = [
    "spell:Resurrection",
    "spell:Wind Flow",
    "spell:Castling",
    "area_throw",
    "defend",
    "wait",
] as const;

export type FocusCapability = (typeof FOCUS_CAPABILITIES)[number];
export type CandidateEnumerator = (unit: Unit, context: IDecisionContext, incumbent: GameAction[]) => ICandidateSet;

export interface IOpportunityCounter {
    opportunityTurns: number;
    alternativeCandidates: number;
}

export interface ICreatureAuditTally {
    actingTurns: number;
    alternativeCandidates: number;
    opportunities: Record<string, number>;
    opportunityCandidates: Record<string, number>;
    incumbentDecisionShapes: Record<string, number>;
}

export interface IMisplayAuditTally {
    games: number;
    actingUnitTurns: number;
    ignoredStrategyTurns: number;
    alternativeCandidates: number;
    classCounters: Record<string, IOpportunityCounter>;
    spellCounters: Record<string, IOpportunityCounter>;
    capabilityCounters: Record<string, IOpportunityCounter>;
    creatures: Record<string, ICreatureAuditTally>;
    incumbentDecisionShapes: Record<string, number>;
    truncatedTurns: number;
    truncatedClasses: Record<string, number>;
    outcomes: {
        greenWins: number;
        redWins: number;
        draws: number;
        totalLaps: number;
        endReasons: Record<string, number>;
    };
}

export interface IMisplayAuditOptions {
    games: number;
    baseSeed: number;
    maxLaps?: number;
}

export interface INormalizedMisplayAuditOptions extends IMisplayAuditOptions {
    games: number;
    baseSeed: number;
}

export interface IOpportunitySummary extends IOpportunityCounter {
    key: string;
    shareOfActingTurns: number;
}

export interface ICreatureAuditSummary {
    creature: string;
    actingTurns: number;
    alternativeCandidates: number;
    summedOpportunityCount: number;
    summedOpportunityShare: number;
    opportunities: IOpportunitySummary[];
    incumbentDecisionShapes: Record<string, number>;
}

export interface IMisplayAuditReport {
    schemaVersion: 1;
    status: "candidate_omission_census";
    auditedVersion: typeof AUDITED_VERSION;
    games: number;
    baseSeed: number;
    actingUnitTurns: number;
    effectiveConfig: {
        preset: "LiveTwin";
        amountMode: "expBudget";
        stackExperienceBudget: number;
        composition: typeof DEFAULT_ROSTER_COMPOSITION;
        setup: ReturnType<typeof liveTwinSetup> & { noVision: true };
        independentMeleeDraftedRosters: true;
        map: "NORMAL";
        gameSeed: string;
        candidateEnumeration: "F4 complete and uncapped";
        observationPoint: "after decideTurn, before lookahead, apply and recovery";
    };
    outcomes: {
        greenWins: number;
        redWins: number;
        draws: number;
        avgLaps: number;
        endReasons: Record<string, number>;
    };
    alternativeCandidates: number;
    avgAlternativeCandidatesPerTurn: number;
    classBreakdown: IOpportunitySummary[];
    spellBreakdown: IOpportunitySummary[];
    focusBreakdown: Record<FocusCapability, IOpportunitySummary>;
    topMissedCapabilities: IOpportunitySummary[];
    creatures: ICreatureAuditSummary[];
    topCreatures: ICreatureAuditSummary[];
    enumerationAudit: {
        truncatedTurns: number;
        truncatedClasses: Record<string, number>;
        ignoredStrategyTurns: number;
    };
    topThreeKillMetric: {
        metric: "sum of the top three per-turn omission shares; opportunities may overlap on one turn";
        topThree: IOpportunitySummary[];
        summedOpportunityShare: number;
        threshold: typeof MISPLAY_KILL_THRESHOLD;
        belowThreshold: boolean;
        verdict: "not_claimed";
    };
    limitations: string[];
}

const emptyCounter = (): IOpportunityCounter => ({ opportunityTurns: 0, alternativeCandidates: 0 });

export function createMisplayAuditTally(): IMisplayAuditTally {
    return {
        games: 0,
        actingUnitTurns: 0,
        ignoredStrategyTurns: 0,
        alternativeCandidates: 0,
        classCounters: {},
        spellCounters: {},
        capabilityCounters: {},
        creatures: {},
        incumbentDecisionShapes: {},
        truncatedTurns: 0,
        truncatedClasses: {},
        outcomes: { greenWins: 0, redWins: 0, draws: 0, totalLaps: 0, endReasons: {} },
    };
}

function counterFor(counters: Record<string, IOpportunityCounter>, key: string): IOpportunityCounter {
    return (counters[key] ??= emptyCounter());
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
    record[key] = (record[key] ?? 0) + amount;
}

function incumbentClasses(actions: readonly GameAction[]): Set<string> {
    const classes = new Set<string>();
    for (const action of actions) {
        if (action.type === "wait_turn") classes.add("wait");
        else if (action.type === "defend_turn") classes.add("defend");
        else if (action.type === "move_unit") classes.add("move");
        else if (action.type === "melee_attack") classes.add("melee");
        else if (action.type === "range_attack") classes.add("shot");
        else if (action.type === "area_throw_attack") classes.add("area_throw");
        else if (action.type === "cast_spell") classes.add("spell");
    }
    return classes;
}

function incumbentSpells(actions: readonly GameAction[]): Set<string> {
    return new Set(
        actions
            .filter((action) => action.type === "cast_spell")
            .map((action) => (action as Extract<GameAction, { type: "cast_spell" }>).spellName),
    );
}

function decisionShape(actions: readonly GameAction[]): string {
    const classes = [...incumbentClasses(actions)].sort();
    if (classes.length) return classes.join("+");
    if (actions.some((action) => action.type === "obstacle_attack")) return "obstacle";
    if (actions.some((action) => action.type === "end_turn")) return "end";
    return "none";
}

function creatureFor(tally: IMisplayAuditTally, name: string): ICreatureAuditTally {
    return (tally.creatures[name] ??= {
        actingTurns: 0,
        alternativeCandidates: 0,
        opportunities: {},
        opportunityCandidates: {},
        incumbentDecisionShapes: {},
    });
}

/** Reduce one live decision into the census. A class is counted at most once per acting unit-turn. */
export function observeMisplayDecision(
    tally: IMisplayAuditTally,
    observation: IDecisionObservation,
    enumerate: CandidateEnumerator = enumerateCandidates,
): void {
    if (observation.strategyVersion !== AUDITED_VERSION) {
        tally.ignoredStrategyTurns += 1;
        return;
    }
    const incumbent = [...observation.incumbent];
    const candidateSet = enumerate(observation.unit, observation.context, incumbent);
    const alternatives = candidateSet.candidates.slice(1);
    const incumbentKindSet = incumbentClasses(incumbent);
    const incumbentSpellSet = incumbentSpells(incumbent);
    const missedCapabilities = new Set<string>();
    const shape = decisionShape(incumbent);
    const creature = creatureFor(tally, observation.unit.getName());

    tally.actingUnitTurns += 1;
    tally.alternativeCandidates += alternatives.length;
    increment(tally.incumbentDecisionShapes, shape);
    creature.actingTurns += 1;
    creature.alternativeCandidates += alternatives.length;
    increment(creature.incumbentDecisionShapes, shape);

    const alternativesByKind = new Map<CandidateKind, number>();
    const alternativesBySpell = new Map<string, number>();
    for (const candidate of alternatives) {
        alternativesByKind.set(candidate.kind, (alternativesByKind.get(candidate.kind) ?? 0) + 1);
        if (candidate.kind === "spell" && candidate.spellName) {
            alternativesBySpell.set(candidate.spellName, (alternativesBySpell.get(candidate.spellName) ?? 0) + 1);
        }
    }
    for (const [kind, count] of alternativesByKind) {
        if (kind === "incumbent") continue;
        const classCounter = counterFor(tally.classCounters, kind);
        classCounter.alternativeCandidates += count;
        if (!incumbentKindSet.has(kind)) {
            classCounter.opportunityTurns += 1;
            if (kind !== "spell") {
                const capability = counterFor(tally.capabilityCounters, kind);
                capability.opportunityTurns += 1;
                capability.alternativeCandidates += count;
                missedCapabilities.add(kind);
            }
        }
    }
    for (const [spellName, count] of alternativesBySpell) {
        const spellCounter = counterFor(tally.spellCounters, spellName);
        spellCounter.alternativeCandidates += count;
        if (!incumbentSpellSet.has(spellName)) {
            spellCounter.opportunityTurns += 1;
            const key = `spell:${spellName}`;
            const capability = counterFor(tally.capabilityCounters, key);
            capability.opportunityTurns += 1;
            capability.alternativeCandidates += count;
            missedCapabilities.add(key);
        }
    }
    for (const capability of missedCapabilities) {
        increment(creature.opportunities, capability);
        const candidateCount = capability.startsWith("spell:")
            ? (alternativesBySpell.get(capability.slice("spell:".length)) ?? 0)
            : (alternativesByKind.get(capability as CandidateKind) ?? 0);
        increment(creature.opportunityCandidates, capability, candidateCount);
    }
    if (candidateSet.truncated.length) {
        tally.truncatedTurns += 1;
        for (const kind of candidateSet.truncated) increment(tally.truncatedClasses, kind);
    }
}

function mergeCounters(target: Record<string, IOpportunityCounter>, source: Record<string, IOpportunityCounter>): void {
    for (const [key, value] of Object.entries(source)) {
        const counter = counterFor(target, key);
        counter.opportunityTurns += value.opportunityTurns;
        counter.alternativeCandidates += value.alternativeCandidates;
    }
}

function mergeNumbers(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, value] of Object.entries(source)) increment(target, key, value);
}

export function mergeMisplayAuditTallies(target: IMisplayAuditTally, source: IMisplayAuditTally): void {
    target.games += source.games;
    target.actingUnitTurns += source.actingUnitTurns;
    target.ignoredStrategyTurns += source.ignoredStrategyTurns;
    target.alternativeCandidates += source.alternativeCandidates;
    target.truncatedTurns += source.truncatedTurns;
    mergeCounters(target.classCounters, source.classCounters);
    mergeCounters(target.spellCounters, source.spellCounters);
    mergeCounters(target.capabilityCounters, source.capabilityCounters);
    mergeNumbers(target.incumbentDecisionShapes, source.incumbentDecisionShapes);
    mergeNumbers(target.truncatedClasses, source.truncatedClasses);
    for (const [name, value] of Object.entries(source.creatures)) {
        const creature = creatureFor(target, name);
        creature.actingTurns += value.actingTurns;
        creature.alternativeCandidates += value.alternativeCandidates;
        mergeNumbers(creature.opportunities, value.opportunities);
        mergeNumbers(creature.opportunityCandidates, value.opportunityCandidates);
        mergeNumbers(creature.incumbentDecisionShapes, value.incumbentDecisionShapes);
    }
    target.outcomes.greenWins += source.outcomes.greenWins;
    target.outcomes.redWins += source.outcomes.redWins;
    target.outcomes.draws += source.outcomes.draws;
    target.outcomes.totalLaps += source.outcomes.totalLaps;
    mergeNumbers(target.outcomes.endReasons, source.outcomes.endReasons);
}

function normalizeOptions(options: IMisplayAuditOptions): INormalizedMisplayAuditOptions {
    if (!Number.isSafeInteger(options.games) || options.games < 1) {
        throw new Error(`games must be a positive integer; got ${options.games}`);
    }
    if (!Number.isSafeInteger(options.baseSeed) || options.baseSeed < 0 || options.baseSeed > 0xffffffff) {
        throw new Error(`baseSeed must be an integer in [0, 2^32-1]; got ${options.baseSeed}`);
    }
    if (options.maxLaps !== undefined && (!Number.isSafeInteger(options.maxLaps) || options.maxLaps < 1)) {
        throw new Error(`maxLaps must be a positive integer; got ${options.maxLaps}`);
    }
    return { ...options };
}

function recordOutcome(tally: IMisplayAuditTally, result: IMatchResult): void {
    tally.games += 1;
    if (result.winner === "green") tally.outcomes.greenWins += 1;
    else if (result.winner === "red") tally.outcomes.redWins += 1;
    else tally.outcomes.draws += 1;
    tally.outcomes.totalLaps += result.laps;
    increment(tally.outcomes.endReasons, result.endReason);
}

export function playMisplayAuditGame(
    options: IMisplayAuditOptions,
    game: number,
    matchRunner: (config: IMatchConfig) => IMatchResult = runMatch,
): IMisplayAuditTally {
    const normalized = normalizeOptions(options);
    if (!Number.isSafeInteger(game) || game < 0 || game >= normalized.games) {
        throw new Error(`game must be in [0, ${normalized.games}); got ${game}`);
    }
    const seed = (normalized.baseSeed + game * 0x9e3779b1) >>> 0;
    const roster = draftRoster(
        DEFAULT_DRAFT_W,
        seed,
        DEFAULT_ROSTER_COMPOSITION,
        DEFAULT_AMOUNT_BY_LEVEL,
        DEFAULT_OFFER_K,
        LIVETWIN_PRESET.amountMode,
    );
    const redRoster = draftRoster(
        DEFAULT_DRAFT_W,
        (seed ^ 0x85ebca6b) >>> 0,
        DEFAULT_ROSTER_COMPOSITION,
        DEFAULT_AMOUNT_BY_LEVEL,
        DEFAULT_OFFER_K,
        LIVETWIN_PRESET.amountMode,
    );
    const greenSetup = liveTwinSetup();
    const redSetup = liveTwinSetup();
    const tally = createMisplayAuditTally();
    // Prime the lazy singleton outside runMatch's deterministic RNG scope; otherwise a worker's first game
    // consumes one extra seeded draw and results depend on job scheduling.
    FightStateManager.getInstance();
    const result = matchRunner({
        greenVersion: AUDITED_VERSION,
        redVersion: AUDITED_VERSION,
        roster,
        redRoster,
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        maxLaps: normalized.maxLaps,
        greenPerk: greenSetup.perk,
        redPerk: redSetup.perk,
        greenAugments: greenSetup.augments,
        redAugments: redSetup.augments,
        decisionObserver: (observation) => observeMisplayDecision(tally, observation),
    });
    recordOutcome(tally, result);
    return tally;
}

function summaries(counters: Record<string, IOpportunityCounter>, turns: number): IOpportunitySummary[] {
    return Object.entries(counters)
        .map(([key, value]) => ({
            key,
            ...value,
            shareOfActingTurns: turns ? value.opportunityTurns / turns : 0,
        }))
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

export function finalizeMisplayAudit(options: IMisplayAuditOptions, tally: IMisplayAuditTally): IMisplayAuditReport {
    const normalized = normalizeOptions(options);
    const turns = tally.actingUnitTurns;
    const classBreakdown = summaries(tally.classCounters, turns);
    const spellBreakdown = summaries(tally.spellCounters, turns);
    const topMissedCapabilities = summaries(tally.capabilityCounters, turns);
    const zeroSummary = (key: string): IOpportunitySummary => ({
        key,
        opportunityTurns: 0,
        alternativeCandidates: 0,
        shareOfActingTurns: 0,
    });
    const focusBreakdown = Object.fromEntries(
        FOCUS_CAPABILITIES.map((key) => [
            key,
            topMissedCapabilities.find((summary) => summary.key === key) ?? zeroSummary(key),
        ]),
    ) as Record<FocusCapability, IOpportunitySummary>;
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
    const topThree = topMissedCapabilities.slice(0, 3);
    const summedOpportunityShare = topThree.reduce((sum, entry) => sum + entry.shareOfActingTurns, 0);
    const setup = liveTwinSetup();
    return {
        schemaVersion: 1,
        status: "candidate_omission_census",
        auditedVersion: AUDITED_VERSION,
        games: tally.games,
        baseSeed: normalized.baseSeed,
        actingUnitTurns: turns,
        effectiveConfig: {
            preset: "LiveTwin",
            amountMode: "expBudget",
            stackExperienceBudget: STACK_EXPERIENCE_BUDGET,
            composition: DEFAULT_ROSTER_COMPOSITION,
            setup: { ...setup, noVision: true },
            independentMeleeDraftedRosters: true,
            map: "NORMAL",
            gameSeed: "seed=(baseSeed + game*0x9e3779b1)>>>0; every census game is a fresh scenario",
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
        topMissedCapabilities,
        creatures,
        topCreatures: creatures.slice(0, 20),
        enumerationAudit: {
            truncatedTurns: tally.truncatedTurns,
            truncatedClasses: sortedNumbers(tally.truncatedClasses),
            ignoredStrategyTurns: tally.ignoredStrategyTurns,
        },
        topThreeKillMetric: {
            metric: "sum of the top three per-turn omission shares; opportunities may overlap on one turn",
            topThree,
            summedOpportunityShare,
            threshold: MISPLAY_KILL_THRESHOLD,
            belowThreshold: turns > 0 && summedOpportunityShare < MISPLAY_KILL_THRESHOLD,
            verdict: "not_claimed",
        },
        limitations: [
            "An omission means an engine-legal alternative class existed and v0.6 chose no action in that class; it is not evidence the alternative was better.",
            "Opportunity shares overlap because one unit-turn can omit multiple candidate classes or spells.",
            "The top-three threshold is reported as the roadmap's census gate, but this harness never claims a performance or bake verdict.",
            "Castling is enumerator-legal, but executing it in battle_engine still requires wiring the same movement-range callback into GameActionEngine.",
            "The census covers fight decisions only; pick_sim draft/setup/placement opportunities are outside its scope.",
        ],
    };
}

export function runMisplayAuditSequential(
    options: IMisplayAuditOptions,
    onGame?: (completed: number, total: number) => void,
): IMisplayAuditReport {
    const normalized = normalizeOptions(options);
    const tally = createMisplayAuditTally();
    for (let game = 0; game < normalized.games; game += 1) {
        mergeMisplayAuditTallies(tally, playMisplayAuditGame(normalized, game));
        onGame?.(game + 1, normalized.games);
    }
    return finalizeMisplayAudit(normalized, tally);
}

export async function runMisplayAudit(
    options: IMisplayAuditOptions,
    concurrency: number,
    onGame?: (completed: number, total: number) => void,
): Promise<IMisplayAuditReport> {
    const normalized = normalizeOptions(options);
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, normalized.games));
    if (poolSize <= 1) return runMisplayAuditSequential(normalized, onGame);

    return new Promise<IMisplayAuditReport>((resolvePromise, rejectPromise) => {
        const tally = createMisplayAuditTally();
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatchNext = (worker: Worker): void => {
            if (dispatched >= normalized.games) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched });
            dispatched += 1;
        };
        const workerUrl = new URL("./misplay_audit_worker.ts", import.meta.url);
        for (let i = 0; i < poolSize; i += 1) {
            let worker: Worker;
            try {
                worker = new Worker(workerUrl, { workerData: { options: normalized } });
            } catch (error) {
                fail(error);
                return;
            }
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
                        dispatchNext(worker);
                        return;
                    }
                    mergeMisplayAuditTallies(tally, message.tally);
                    completed += 1;
                    onGame?.(completed, normalized.games);
                    if (completed >= normalized.games) {
                        settled = true;
                        const report = finalizeMisplayAudit(normalized, tally);
                        cleanup();
                        resolvePromise(report);
                        return;
                    }
                    dispatchNext(worker);
                },
            );
            worker.on("error", fail);
        }
    });
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    return parsed;
}

function printUsage(): void {
    console.log(
        "usage: bun src/simulation/misplay_audit.ts [--games 500] [--seed 1] [--concurrency 12] " +
            "[--output sim-out/misplay_audit.summary.json]",
    );
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "500" },
            seed: { type: "string", default: "1" },
            concurrency: { type: "string", default: String(Math.min(12, Math.max(1, availableParallelism()))) },
            output: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        printUsage();
        return;
    }
    const games = positiveInteger(values.games, "--games");
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) {
        throw new Error(`--seed must be an integer in [0, 2^32-1]; got ${values.seed}`);
    }
    const concurrency = positiveInteger(values.concurrency, "--concurrency");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `misplay_audit_${stamp}.summary.json`);
    process.env.SIM_NO_ACTIONS = "1";
    console.error(
        `Running Q1 MISPLAY_AUDIT: ${games} fresh LiveTwin ${AUDITED_VERSION} mirrors ` +
            `(seed ${baseSeed}, concurrency ${concurrency})`,
    );
    const progressEvery = Math.max(10, Math.floor(games / 20));
    const report = await runMisplayAudit({ games, baseSeed }, concurrency, (completed) => {
        if (completed % progressEvery === 0 || completed === games) console.error(`  ${completed}/${games} games`);
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output === "-") {
        process.stdout.write(json);
    } else {
        const outputPath = resolve(output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        console.error(`Summary: ${outputPath}`);
    }
    console.error(
        `Observed ${report.actingUnitTurns} acting turns; top-3 summed omission share ` +
            `${(report.topThreeKillMetric.summedOpportunityShare * 100).toFixed(2)}% ` +
            `(threshold ${(MISPLAY_KILL_THRESHOLD * 100).toFixed(1)}%, verdict not claimed).`,
    );
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
