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

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { AI_VERSIONS } from "../ai";
import type { GameAction } from "../engine/actions";
import {
    buildRoster,
    creaturesByLevel,
    DEFAULT_AMOUNT_BY_LEVEL,
    makeRng,
    resolveStackAmount,
    type IArmyUnitSpec,
    type StackAmountMode,
} from "./army";
import { runMatch, type IMatchConfig, type ITurnExecutionObservation, type Side } from "./battle_engine";
import { liveTwinSetup } from "./livetwin";

/**
 * Research-only coverage panel for the four level-4 creatures introduced with v0.8 development.
 *
 * This is deliberately not a promotion/win-rate gate: each target fights a fixed Black Dragon control,
 * so roster strength is confounded with the result. Its job is to guarantee that both the candidate and
 * opponent AI control every new creature, on both physical seats, and to emit actionable per-creature
 * turn/Armageddon telemetry for training and audits.
 */
export const V08_LEVEL4_COVERAGE_UNITS = ["Champion", "Arachna Queen", "Abomination", "Frenzied Boar"] as const;

export type V08Level4CoverageUnit = (typeof V08_LEVEL4_COVERAGE_UNITS)[number];
export type V08Level4Owner = "candidate" | "opponent";

export const V08_LEVEL4_CONTROL_UNIT = "Black Dragon";
export const V08_LEVEL4_COVERAGE_SCHEMA = "hoc.v0_8_l4_coverage.v1";

export interface IV08Level4CoverageLane {
    unit: V08Level4CoverageUnit;
    owner: V08Level4Owner;
}

export const V08_LEVEL4_COVERAGE_LANES: readonly IV08Level4CoverageLane[] = V08_LEVEL4_COVERAGE_UNITS.flatMap(
    (unit) => [
        { unit, owner: "candidate" as const },
        { unit, owner: "opponent" as const },
    ],
);

export interface IV08Level4CoverageOptions {
    candidateVersion: string;
    opponentVersion: string;
    /** One pair is two games with identical armies/randomness and candidate/opponent physical seats swapped. */
    pairsPerLane: number;
    baseSeed: number;
    /** Defaults to all live layouts, rotated deterministically per complete eight-lane cycle. */
    mapTypes?: readonly number[];
    /** Defaults to the live exp-budget stack sizing. */
    amountMode?: StackAmountMode;
    /** Defaults true: both sides receive the shipped SEE_NONE + Armor/Might/Sniper setup. */
    liveSetup?: boolean;
}

export interface IV08Level4ActionAudit {
    appearances: number;
    actingTurns: number;
    completedActions: number;
    completedStrategyActions: number;
    completedRecoveryActions: number;
    productiveActions: number;
    turnsWithoutProductiveAction: number;
    rawEndTurnDecisions: number;
    actionTypes: Record<string, number>;
}

export interface IV08Level4CoverageRecord {
    schema: typeof V08_LEVEL4_COVERAGE_SCHEMA;
    game: number;
    cycle: number;
    seed: number;
    mapType: number;
    lane: IV08Level4CoverageLane;
    candidateVersion: string;
    opponentVersion: string;
    candidateSide: Side;
    targetSide: Side;
    winner: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: "elimination" | "turn_cap" | "stuck";
    rejectedCandidate: number;
    rejectedOpponent: number;
    target: IV08Level4ActionAudit;
    armageddon: {
        reached: boolean;
        waves: number;
        decided: boolean;
        unitsKilled: number;
    };
}

export interface IV08Level4CoverageCellSummary extends IV08Level4ActionAudit {
    lane: IV08Level4CoverageLane;
    games: number;
    candidateWins: number;
    opponentWins: number;
    draws: number;
    rejectedCandidate: number;
    rejectedOpponent: number;
    armageddonReached: number;
    armageddonDecided: number;
}

export interface IV08Level4CoverageSummary {
    schema: typeof V08_LEVEL4_COVERAGE_SCHEMA;
    candidateVersion: string;
    opponentVersion: string;
    baseSeed: number;
    pairsPerLane: number;
    games: number;
    lanes: IV08Level4CoverageCellSummary[];
}

const DEFAULT_MAP_TYPES = [1, 2, 3, 4] as const;
const PRODUCTIVE_ACTIONS: ReadonlySet<GameAction["type"]> = new Set([
    "move_unit",
    "melee_attack",
    "range_attack",
    "cast_spell",
]);

const emptyActionAudit = (): IV08Level4ActionAudit => ({
    appearances: 0,
    actingTurns: 0,
    completedActions: 0,
    completedStrategyActions: 0,
    completedRecoveryActions: 0,
    productiveActions: 0,
    turnsWithoutProductiveAction: 0,
    rawEndTurnDecisions: 0,
    actionTypes: {},
});

function level4Spec(creatureName: string, amountMode: StackAmountMode): IArmyUnitSpec {
    const entry = creaturesByLevel(4).find((candidate) => candidate.creatureName === creatureName);
    if (!entry) {
        throw new Error(`Enabled level-4 creature not found: ${creatureName}`);
    }
    return {
        faction: entry.faction,
        creatureName: entry.creatureName,
        level: entry.level,
        size: entry.size,
        amount: resolveStackAmount(entry.creatureName, entry.level, DEFAULT_AMOUNT_BY_LEVEL, amountMode),
    };
}

/** Replace the roster's single default L4 slot without disturbing any lower-level RNG picks. */
export function forceLevel4CoverageUnit(
    roster: readonly IArmyUnitSpec[],
    creatureName: V08Level4CoverageUnit | typeof V08_LEVEL4_CONTROL_UNIT,
    amountMode: StackAmountMode = "expBudget",
): IArmyUnitSpec[] {
    const level4Indexes = roster.flatMap((spec, index) => (spec.level === 4 ? [index] : []));
    if (level4Indexes.length !== 1) {
        throw new Error(`Level-4 coverage requires exactly one L4 roster slot; found ${level4Indexes.length}`);
    }
    const replacement = level4Spec(creatureName, amountMode);
    return roster.map((spec, index) => (index === level4Indexes[0] ? replacement : { ...spec }));
}

export interface IV08Level4CoverageGamePlan {
    game: number;
    cycle: number;
    seed: number;
    mapType: number;
    lane: IV08Level4CoverageLane;
    candidateSide: Side;
    targetSide: Side;
    greenRoster: IArmyUnitSpec[];
    redRoster: IArmyUnitSpec[];
}

/**
 * Derive one game entirely from its index, so worker completion order and concurrency cannot change a lane.
 * Adjacent games form the physical-seat swap pair. Every complete cycle covers all 8 lanes with one base roster.
 */
export function planV08Level4CoverageGame(
    options: IV08Level4CoverageOptions,
    game: number,
): IV08Level4CoverageGamePlan {
    const totalGames = options.pairsPerLane * V08_LEVEL4_COVERAGE_LANES.length * 2;
    if (!Number.isSafeInteger(game) || game < 0 || game >= totalGames) {
        throw new Error(`Coverage game index ${game} is outside [0, ${totalGames})`);
    }
    const pair = Math.floor(game / 2);
    const lane = V08_LEVEL4_COVERAGE_LANES[pair % V08_LEVEL4_COVERAGE_LANES.length];
    const cycle = Math.floor(pair / V08_LEVEL4_COVERAGE_LANES.length);
    const seed = (options.baseSeed + cycle * 0x9e3779b1) >>> 0;
    const amountMode = options.amountMode ?? "expBudget";
    const baseRoster = buildRoster(makeRng(seed), undefined, DEFAULT_AMOUNT_BY_LEVEL, undefined, amountMode);
    const targetRoster = forceLevel4CoverageUnit(baseRoster, lane.unit, amountMode);
    const controlRoster = forceLevel4CoverageUnit(baseRoster, V08_LEVEL4_CONTROL_UNIT, amountMode);
    const candidateRoster = lane.owner === "candidate" ? targetRoster : controlRoster;
    const opponentRoster = lane.owner === "opponent" ? targetRoster : controlRoster;
    const candidateSide: Side = game % 2 === 0 ? "green" : "red";
    const targetSide = lane.owner === "candidate" ? candidateSide : candidateSide === "green" ? "red" : "green";
    const maps = options.mapTypes?.length ? options.mapTypes : DEFAULT_MAP_TYPES;
    const mapType = maps[cycle % maps.length];
    return {
        game,
        cycle,
        seed,
        mapType,
        lane,
        candidateSide,
        targetSide,
        greenRoster: candidateSide === "green" ? candidateRoster : opponentRoster,
        redRoster: candidateSide === "green" ? opponentRoster : candidateRoster,
    };
}

/** Fold the detached turn observer into a compact per-target audit (safe to send across worker boundaries). */
export function auditV08Level4Turn(
    audit: IV08Level4ActionAudit,
    observation: ITurnExecutionObservation,
    unit: V08Level4CoverageUnit,
    side: Side,
): void {
    if (observation.creatureName !== unit || observation.side !== side) {
        return;
    }
    audit.actingTurns += 1;
    if (observation.rawIncumbent.some((action) => action.type === "end_turn")) {
        audit.rawEndTurnDecisions += 1;
    }
    const strategyTypes = observation.strategyActions
        .filter(({ completed, action }) => completed && action.type !== "select_attack_type")
        .map(({ action }) => action.type);
    const recoveryTypes = observation.recoveryAttempts
        .filter(({ completed, action }) => completed && action !== undefined)
        .map(({ action }) => action!.type);
    const completedTypes = [...strategyTypes, ...recoveryTypes];
    audit.completedStrategyActions += strategyTypes.length;
    audit.completedRecoveryActions += recoveryTypes.length;
    audit.completedActions += completedTypes.length;
    let productive = 0;
    for (const actionType of completedTypes) {
        audit.actionTypes[actionType] = (audit.actionTypes[actionType] ?? 0) + 1;
        if (PRODUCTIVE_ACTIONS.has(actionType)) {
            productive += 1;
        }
    }
    audit.productiveActions += productive;
    if (productive === 0) {
        audit.turnsWithoutProductiveAction += 1;
    }
}

/** Play one compact forced-coverage game. Intended for the dedicated worker and focused smoke tests. */
export function runV08Level4CoverageGame(options: IV08Level4CoverageOptions, game: number): IV08Level4CoverageRecord {
    const plan = planV08Level4CoverageGame(options, game);
    const target = emptyActionAudit();
    target.appearances = (plan.targetSide === "green" ? plan.greenRoster : plan.redRoster).filter(
        (spec) => spec.creatureName === plan.lane.unit,
    ).length;
    const setup = options.liveSetup === false ? undefined : liveTwinSetup();
    const config: IMatchConfig = {
        greenVersion: plan.candidateSide === "green" ? options.candidateVersion : options.opponentVersion,
        redVersion: plan.candidateSide === "green" ? options.opponentVersion : options.candidateVersion,
        roster: plan.greenRoster,
        redRoster: plan.redRoster,
        seed: plan.seed,
        gridType: plan.mapType,
        greenPerk: setup?.perk,
        redPerk: setup?.perk,
        greenAugments: setup?.augments,
        redAugments: setup?.augments,
        turnExecutionObserver: (observation) =>
            auditV08Level4Turn(target, observation, plan.lane.unit, plan.targetSide),
    };
    const result = runMatch(config);
    const winner = result.winner === "draw" ? "draw" : result.winner === plan.candidateSide ? "candidate" : "opponent";
    const candidateIsGreen = plan.candidateSide === "green";
    return {
        schema: V08_LEVEL4_COVERAGE_SCHEMA,
        game,
        cycle: plan.cycle,
        seed: plan.seed,
        mapType: plan.mapType,
        lane: plan.lane,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        candidateSide: plan.candidateSide,
        targetSide: plan.targetSide,
        winner,
        laps: result.laps,
        endReason: result.endReason,
        rejectedCandidate: candidateIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
        rejectedOpponent: candidateIsGreen ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0),
        target,
        armageddon: {
            reached: result.attrition.reachedArmageddon,
            waves: result.attrition.armageddonWaves,
            decided: result.attrition.decidedByArmageddon,
            unitsKilled: result.attrition.unitsKilledByArmageddon,
        },
    };
}

const laneKey = ({ unit, owner }: IV08Level4CoverageLane): string => `${unit}:${owner}`;

export function summarizeV08Level4Coverage(
    options: IV08Level4CoverageOptions,
    records: readonly IV08Level4CoverageRecord[],
): IV08Level4CoverageSummary {
    const byLane = new Map<string, IV08Level4CoverageCellSummary>(
        V08_LEVEL4_COVERAGE_LANES.map((lane) => [
            laneKey(lane),
            {
                lane,
                games: 0,
                candidateWins: 0,
                opponentWins: 0,
                draws: 0,
                rejectedCandidate: 0,
                rejectedOpponent: 0,
                armageddonReached: 0,
                armageddonDecided: 0,
                ...emptyActionAudit(),
            },
        ]),
    );
    for (const record of records) {
        const cell = byLane.get(laneKey(record.lane));
        if (!cell) {
            throw new Error(`Unknown coverage lane in record: ${laneKey(record.lane)}`);
        }
        cell.games += 1;
        if (record.winner === "candidate") cell.candidateWins += 1;
        else if (record.winner === "opponent") cell.opponentWins += 1;
        else cell.draws += 1;
        cell.rejectedCandidate += record.rejectedCandidate;
        cell.rejectedOpponent += record.rejectedOpponent;
        cell.armageddonReached += Number(record.armageddon.reached);
        cell.armageddonDecided += Number(record.armageddon.decided);
        cell.appearances += record.target.appearances;
        cell.actingTurns += record.target.actingTurns;
        cell.completedActions += record.target.completedActions;
        cell.completedStrategyActions += record.target.completedStrategyActions;
        cell.completedRecoveryActions += record.target.completedRecoveryActions;
        cell.productiveActions += record.target.productiveActions;
        cell.turnsWithoutProductiveAction += record.target.turnsWithoutProductiveAction;
        cell.rawEndTurnDecisions += record.target.rawEndTurnDecisions;
        for (const [actionType, count] of Object.entries(record.target.actionTypes)) {
            cell.actionTypes[actionType] = (cell.actionTypes[actionType] ?? 0) + count;
        }
    }
    return {
        schema: V08_LEVEL4_COVERAGE_SCHEMA,
        candidateVersion: options.candidateVersion,
        opponentVersion: options.opponentVersion,
        baseSeed: options.baseSeed,
        pairsPerLane: options.pairsPerLane,
        games: records.length,
        lanes: [...byLane.values()],
    };
}

export function runV08Level4CoverageConcurrent(
    options: IV08Level4CoverageOptions,
    concurrency: number,
    onGame?: (record: IV08Level4CoverageRecord) => void,
): Promise<IV08Level4CoverageSummary> {
    const total = options.pairsPerLane * V08_LEVEL4_COVERAGE_LANES.length * 2;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize === 1) {
        const records = Array.from({ length: total }, (_, game) => runV08Level4CoverageGame(options, game));
        records.forEach(onGame ?? (() => undefined));
        return Promise.resolve(summarizeV08Level4Coverage(options, records));
    }
    return new Promise((resolve, reject) => {
        const records: IV08Level4CoverageRecord[] = [];
        const workers: Worker[] = [];
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: dispatched++ });
        };
        const workerUrl = new URL("./v0_8_l4_coverage_worker.ts", import.meta.url);
        for (let index = 0; index < poolSize; index += 1) {
            const worker = new Worker(workerUrl, { workerData: { options } });
            workers.push(worker);
            worker.on(
                "message",
                (message: { type: "ready" } | { type: "result"; record: IV08Level4CoverageRecord }) => {
                    if (settled) return;
                    if (message.type === "ready") {
                        dispatch(worker);
                        return;
                    }
                    records.push(message.record);
                    onGame?.(message.record);
                    completed += 1;
                    if (completed === total) {
                        settled = true;
                        cleanup();
                        resolve(summarizeV08Level4Coverage(options, records));
                    } else {
                        dispatch(worker);
                    }
                },
            );
            worker.on("error", fail);
        }
    });
}

async function main(): Promise<void> {
    const [candidateVersion, opponentVersion, pairsArg, seedArg, outDirArg, concurrencyArg] = process.argv.slice(2);
    if (!candidateVersion || !opponentVersion) {
        console.error(
            "usage: v0_8_l4_coverage <candidateVersion> <opponentVersion> [pairsPerLane] [baseSeed] [outDir] [concurrency]",
        );
        process.exitCode = 1;
        return;
    }
    if (!AI_VERSIONS.includes(candidateVersion) || !AI_VERSIONS.includes(opponentVersion)) {
        throw new Error(`Unknown version; known versions: ${AI_VERSIONS.join(", ")}`);
    }
    const pairsPerLane = pairsArg ? Number(pairsArg) : 100;
    const baseSeed = seedArg ? Number(seedArg) : 1;
    if (!Number.isSafeInteger(pairsPerLane) || pairsPerLane < 1 || !Number.isSafeInteger(baseSeed)) {
        throw new Error("pairsPerLane must be a positive integer and baseSeed must be an integer");
    }
    const outDir = outDirArg ?? join(process.cwd(), "sim-out");
    const total = pairsPerLane * V08_LEVEL4_COVERAGE_LANES.length * 2;
    const concurrency = Math.min(concurrencyArg ? Math.max(1, Number(concurrencyArg)) : availableParallelism(), total);
    const options: IV08Level4CoverageOptions = {
        candidateVersion,
        opponentVersion,
        pairsPerLane,
        baseSeed,
    };
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `v08_l4_${candidateVersion}_vs_${opponentVersion}_${stamp}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const jsonlPath = join(outDir, `${base}.jsonl`);
    const summaryPath = join(outDir, `${base}.summary.json`);
    writeFileSync(jsonlPath, "");
    let completed = 0;
    const started = Date.now();
    console.log(
        `Running ${total} forced-L4 coverage games (${pairsPerLane} pairs/lane, concurrency ${concurrency}) -> ${jsonlPath}`,
    );
    const summary = await runV08Level4CoverageConcurrent(options, concurrency, (record) => {
        appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
        completed += 1;
        if (completed % 100 === 0 || completed === total) console.log(`  ${completed}/${total} games...`);
    });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Summary -> ${summaryPath}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    void main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
