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

import { RANKED_DRAFT_INTERACTION_PRIOR_SOURCE } from "../ai/setup/draft_interaction_prior";
import {
    DEFAULT_RANKED_DRAFT_DIRECT_GATES,
    evaluateRankedDraftDirectGates,
    type IRankedDraftDirectGateResult,
    type IRankedDraftDirectGates,
} from "./ranked_draft_direct_gate";
import {
    evaluateRankedDraftCandidate,
    rankedDraftCurrentIncumbent,
    rankedDraftInteractionPriorCandidate,
    type IRankedDraftEvaluationReport,
} from "./ranked_draft_eval";

export const RANKED_DRAFT_INTERACTION_PRIOR_DEFAULT_GAMES = 70_000;

export type IRankedDraftInteractionPriorGates = IRankedDraftDirectGates;

export const DEFAULT_RANKED_DRAFT_INTERACTION_PRIOR_GATES = DEFAULT_RANKED_DRAFT_DIRECT_GATES;

export interface IRankedDraftInteractionPriorOptions {
    games: number;
    seed: number;
    concurrency: number;
    gates?: IRankedDraftInteractionPriorGates;
    outputPath?: string;
}

export type IRankedDraftInteractionPriorGateResult = IRankedDraftDirectGateResult;

export interface IRankedDraftInteractionPriorVerdict {
    schemaVersion: 1;
    status: "research_only_no_bake";
    candidateId: string;
    incumbentId: string;
    source: typeof RANKED_DRAFT_INTERACTION_PRIOR_SOURCE;
    verdict: "PASS" | "FAIL";
    gates: IRankedDraftInteractionPriorGateResult[];
    headToHead: {
        games: number;
        wins: number;
        losses: number;
        draws: number;
        drawAwareScore: number;
        decisiveWinRate: number;
        clusteredLowerBound: number;
    };
    report: IRankedDraftEvaluationReport;
}

export function interactionPriorEntrants() {
    const candidate = rankedDraftInteractionPriorCandidate();
    const incumbent = rankedDraftCurrentIncumbent();
    return { candidate, incumbent: { ...incumbent, prior: 1 } };
}

/** Apply the predeclared direct-incumbent gate without mutating or promoting any ship configuration. */
export function evaluateRankedDraftInteractionPriorGates(
    report: IRankedDraftEvaluationReport,
    gates: IRankedDraftInteractionPriorGates = DEFAULT_RANKED_DRAFT_INTERACTION_PRIOR_GATES,
): IRankedDraftInteractionPriorVerdict {
    const { candidate, incumbent } = interactionPriorEntrants();
    const result = evaluateRankedDraftDirectGates(report, candidate.id, incumbent.id, gates);
    return {
        schemaVersion: 1,
        status: "research_only_no_bake",
        candidateId: candidate.id,
        incumbentId: incumbent.id,
        source: RANKED_DRAFT_INTERACTION_PRIOR_SOURCE,
        ...result,
        report,
    };
}

export async function runRankedDraftInteractionPriorEval(
    options: IRankedDraftInteractionPriorOptions,
): Promise<IRankedDraftInteractionPriorVerdict> {
    if (!Number.isInteger(options.games) || options.games < 8 || options.games % 4) {
        throw new RangeError("games must be a multiple of four and at least eight");
    }
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
        throw new RangeError("seed must be an integer in [0, 4294967295]");
    }
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
        throw new RangeError("concurrency must be a positive integer");
    }
    const entrants = interactionPriorEntrants();
    const report = await evaluateRankedDraftCandidate(entrants.candidate, [entrants.incumbent], {
        gamesPerOpponent: options.games,
        baseSeed: options.seed,
        concurrency: options.concurrency,
    });
    return evaluateRankedDraftInteractionPriorGates(report, options.gates);
}

function parseCli(argv: readonly string[]): IRankedDraftInteractionPriorOptions {
    const values = new Map<string, string>();
    const allowed = new Set(["games", "seed", "concurrency", "output"]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument ${argument}`);
        const [key, inline] = argument.slice(2).split("=", 2);
        if (!allowed.has(key)) throw new Error(`Unknown option --${key}`);
        if (values.has(key)) throw new Error(`Duplicate option --${key}`);
        const value = inline ?? argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
        values.set(key, value);
    }
    const games = Number(values.get("games") ?? RANKED_DRAFT_INTERACTION_PRIOR_DEFAULT_GAMES);
    const seed = Number(values.get("seed") ?? 96_410_701);
    const concurrency = Number(values.get("concurrency") ?? Math.min(12, availableParallelism()));
    return {
        games,
        seed,
        concurrency,
        ...(values.has("output") ? { outputPath: resolve(values.get("output")!) } : {}),
    };
}

async function cliMain(): Promise<void> {
    let options: IRankedDraftInteractionPriorOptions;
    try {
        options = parseCli(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
        return;
    }
    const startedAt = Date.now();
    console.log(
        `ranked-interaction-prior: games=${options.games} seed=${options.seed} concurrency=${options.concurrency}`,
    );
    const verdict = await runRankedDraftInteractionPriorEval(options);
    const json = `${JSON.stringify(verdict, null, 2)}\n`;
    if (options.outputPath) {
        mkdirSync(dirname(options.outputPath), { recursive: true });
        writeFileSync(options.outputPath, json);
    }
    console.log(
        `  head-to-head ${(verdict.headToHead.drawAwareScore * 100).toFixed(2)}% draw-aware; ` +
            `decisive ${(verdict.headToHead.decisiveWinRate * 100).toFixed(2)}%; ` +
            `LCB ${(verdict.headToHead.clusteredLowerBound * 100).toFixed(2)}%`,
    );
    console.log(
        `ranked-interaction-prior verdict: ${verdict.verdict} (${verdict.report.totalGames} games, ` +
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
