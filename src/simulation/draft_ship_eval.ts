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

import { parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    evaluateLeagueCandidate,
    type ILeagueEvaluationReport,
    type ILeagueOpponentResult,
    type ILeaguePoolEntry,
} from "./league_eval";
import { createLeagueGenome, createMeleeLeagueGenome, LEAGUE_ANCHOR_GENOME, type ILeagueGenome } from "./league_genome";

/**
 * DRAFT SHIP-PATH ACCEPTANCE HARNESS — the turnkey A/B for a candidate draft-weights JSON before it ships
 * via HOC_DRAFT_WEIGHTS on the ranked server.
 *
 * The candidate's intrinsic draft head drafts full armies INSIDE the exact live pick reducer
 * (common/picks/pick_sim, random live auto-bans, legit view, collisions and all), then fights full games
 * (LiveTwin expBudget stacks, shipped fight vector both sides — default v0.7) against two fixed baselines, on
 * paired seeds (each four-game offer board shares one pick board across both seat assignments and an exact
 * battle-side mirror). Every non-consumed genome head is reset to setup-v0 for candidate and baselines:
 *   1. "untrained-heuristic" — the setup-v0 scoreCreature draft (the server's no-config fallback);
 *   2. "shipped-default-draft" — DEFAULT_DRAFT_W, the baked melee co-evolution champion.
 *
 * GATES (on the cluster-robust decisive-win-rate LOWER BOUND per opponent):
 *   - vs untrained-heuristic  >= 0.55 (a shippable champion must clearly beat the untrained fallback);
 *   - vs shipped-default-draft >= 0.47 (non-inferiority: no more than ~3pp regression at 95% confidence
 *     against the incumbent — a candidate equal to the incumbent measures ~0.48-0.49 here, so it passes).
 * Exit code 0 = PASS, 1 = FAIL, 2 = usage/runtime error. This is a measurement gate, not a bake: shipping
 * still means flipping HOC_DRAFT_WEIGHTS to the accepted artifact.
 *
 * Usage (from the repo root):
 *   bun src/simulation/draft_ship_eval.ts --candidate <spec> [--games 4000] [--seed 1] \
 *     [--concurrency N] [--fight-version v0.7] [--gate-vs-heuristic 0.55] [--gate-vs-default 0.47] \
 *     [--output sim-out/draft_ship/report.json]
 * where <spec> accepts everything parseDraftGenome does: an 11- or 95-weight JSON array, a champion
 * {id, weights} object, a path to such a JSON file, or the named specs "anchor"/"heuristic"/"default".
 */

export const DRAFT_SHIP_HEURISTIC_ID = "untrained-heuristic";
export const DRAFT_SHIP_DEFAULT_ID = "shipped-default-draft";

export interface IDraftShipGates {
    vsHeuristic: number;
    vsDefault: number;
}

export const DEFAULT_DRAFT_SHIP_GATES: IDraftShipGates = { vsHeuristic: 0.55, vsDefault: 0.47 };

const assertDraftShipGates = (gates: IDraftShipGates): void => {
    for (const [name, value] of Object.entries(gates)) {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new RangeError(`${name} gate must be a finite probability in [0, 1]`);
        }
    }
};

export interface IDraftShipOptions {
    candidate: ILeagueGenome;
    games: number;
    seed: number;
    concurrency: number;
    fightVersion: string;
    gates: IDraftShipGates;
    outputPath?: string;
}

export interface IDraftShipGateResult {
    opponentId: string;
    gate: number;
    decisiveWinRate: number;
    clusteredLowerBound: number;
    passed: boolean;
}

export interface IDraftShipVerdict {
    schemaVersion: 1;
    status: "measurement_only";
    candidateId: string;
    verdict: "PASS" | "FAIL";
    gates: IDraftShipGateResult[];
    report: ILeagueEvaluationReport;
}

/** The two fixed acceptance baselines the candidate must clear. */
export function draftShipPool(): ILeaguePoolEntry[] {
    return [
        {
            ...projectDraftGenomeForShipping(createLeagueGenome(DRAFT_SHIP_HEURISTIC_ID, LEAGUE_ANCHOR_GENOME)),
            prior: 1,
        },
        { ...projectDraftGenomeForShipping(createMeleeLeagueGenome(DRAFT_SHIP_DEFAULT_ID)), prior: 1 },
    ];
}

/** Entrants exactly as evaluated and deployable: intrinsic draft head only, every other setup head frozen. */
export function draftShipEntrants(candidate: ILeagueGenome): {
    candidate: ILeagueGenome;
    pool: ILeaguePoolEntry[];
} {
    return { candidate: projectDraftGenomeForShipping(candidate), pool: draftShipPool() };
}

/** Apply the acceptance gates to a finished report (pure — unit-testable without running fights). */
export function evaluateDraftShipGates(report: ILeagueEvaluationReport, gates: IDraftShipGates): IDraftShipVerdict {
    assertDraftShipGates(gates);
    const opponentById = new Map<string, ILeagueOpponentResult>(
        report.opponents.map((opponent) => [opponent.opponentId, opponent]),
    );
    const gateFor = (opponentId: string, gate: number): IDraftShipGateResult => {
        const opponent = opponentById.get(opponentId);
        if (!opponent) {
            throw new Error(`Draft ship report is missing the ${opponentId} baseline`);
        }
        return {
            opponentId,
            gate,
            decisiveWinRate: opponent.decisiveWinRate,
            clusteredLowerBound: opponent.clusteredLowerBound,
            passed: opponent.clusteredLowerBound >= gate,
        };
    };
    const results = [
        gateFor(DRAFT_SHIP_HEURISTIC_ID, gates.vsHeuristic),
        gateFor(DRAFT_SHIP_DEFAULT_ID, gates.vsDefault),
    ];
    return {
        schemaVersion: 1,
        status: "measurement_only",
        candidateId: report.candidateId,
        verdict: results.every((result) => result.passed) ? "PASS" : "FAIL",
        gates: results,
        report,
    };
}

export function parseDraftShipArgs(argv: readonly string[], cwd: string = process.cwd()): IDraftShipOptions {
    const values = new Map<string, string>();
    const allowed = new Set([
        "candidate",
        "concurrency",
        "fight-version",
        "games",
        "gate-vs-default",
        "gate-vs-heuristic",
        "output",
        "seed",
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) {
            throw new Error(`Unexpected positional argument: ${argument}`);
        }
        const [key, inline] = argument.slice(2).split("=", 2);
        if (!allowed.has(key)) {
            throw new Error(`Unknown option --${key}`);
        }
        if (values.has(key)) {
            throw new Error(`Duplicate option --${key}`);
        }
        const value = inline ?? argv[++index];
        if (value === undefined || !value || value.startsWith("--")) {
            throw new Error(`Missing value for --${key}`);
        }
        values.set(key, value);
    }
    const candidateSpec = values.get("candidate");
    if (!candidateSpec) {
        throw new Error("--candidate is required (weights JSON, champion file, or anchor/default)");
    }
    const games = Number(values.get("games") ?? 4000);
    if (!Number.isInteger(games) || games < 8 || games % 4) {
        throw new RangeError("--games must be a multiple of 4 and at least 8");
    }
    const seed = Number(values.get("seed") ?? 1);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new RangeError("--seed must be an integer in [0, 4294967295]");
    }
    const concurrency = Number(values.get("concurrency") ?? Math.max(1, availableParallelism() - 2));
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new RangeError("--concurrency must be a positive integer");
    }
    const fightVersion = values.get("fight-version") ?? "v0.7";
    if (!fightVersion.trim()) {
        throw new TypeError("--fight-version must not be empty");
    }
    const gates = {
        vsHeuristic: Number(values.get("gate-vs-heuristic") ?? DEFAULT_DRAFT_SHIP_GATES.vsHeuristic),
        vsDefault: Number(values.get("gate-vs-default") ?? DEFAULT_DRAFT_SHIP_GATES.vsDefault),
    };
    assertDraftShipGates(gates);
    return {
        candidate: parseDraftGenome(candidateSpec, "candidate", cwd),
        games,
        seed,
        concurrency,
        fightVersion,
        gates,
        ...(values.has("output") ? { outputPath: resolve(cwd, values.get("output")!) } : {}),
    };
}

export async function runDraftShipEval(options: IDraftShipOptions): Promise<IDraftShipVerdict> {
    assertDraftShipGates(options.gates);
    const entrants = draftShipEntrants(options.candidate);
    const report = await evaluateLeagueCandidate(entrants.candidate, entrants.pool, {
        gamesPerOpponent: options.games,
        baseSeed: options.seed,
        concurrency: options.concurrency,
        fightVersion: options.fightVersion,
        mapTypes: [PBTypes.GridVals.NORMAL],
        freezePerk: true,
        aggregate: "worst-case",
    });
    return evaluateDraftShipGates(report, options.gates);
}

async function cliMain(): Promise<void> {
    let options: IDraftShipOptions;
    try {
        options = parseDraftShipArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
        return;
    }
    const startedAt = Date.now();
    console.log(
        `draft-ship-eval: candidate=${options.candidate.id} games/cell=${options.games} seed=${options.seed} ` +
            `fight=${options.fightVersion} concurrency=${options.concurrency}`,
    );
    const verdict = await runDraftShipEval(options);
    const json = `${JSON.stringify(verdict, null, 2)}\n`;
    if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, json);
    }
    for (const gate of verdict.gates) {
        console.log(
            `  vs ${gate.opponentId}: decisive ${(gate.decisiveWinRate * 100).toFixed(2)}% ` +
                `LCB ${(gate.clusteredLowerBound * 100).toFixed(2)}% (gate ${(gate.gate * 100).toFixed(0)}%) -> ` +
                `${gate.passed ? "pass" : "FAIL"}`,
        );
    }
    console.log(
        `draft-ship-eval verdict: ${verdict.verdict} (${verdict.report.totalGames} games, ` +
            `${((Date.now() - startedAt) / 60000).toFixed(1)} min)${options.outputPath ? ` -> ${options.outputPath}` : ""}`,
    );
    process.exitCode = verdict.verdict === "PASS" ? 0 : 1;
}

if (import.meta.main) {
    cliMain().catch((error) => {
        console.error(error);
        process.exitCode = 2;
    });
}
