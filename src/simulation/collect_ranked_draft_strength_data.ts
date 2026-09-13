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
import { dirname, resolve } from "node:path";

import { V07_NONFIGHT_SETUP_SPEC } from "../ai/setup/setup_ship";
import {
    evaluateRankedDraftTasks,
    RANKED_DRAFT_LIVE_MAP_TYPES,
    rankedDraftLiveIncumbent,
    type IRankedDraftEvaluationOptions,
    type IRankedDraftEvaluationTask,
} from "./ranked_draft_eval";

/**
 * UNIT-STRENGTH DATA: how the live ranked bot converts each creature into wins.
 *
 * Both seats draft with the deployed ranked policy under the server's rules, except that each bundle and creature
 * decision is replaced by a uniform legal choice with probability --exploration, so creatures the policy rarely
 * takes still appear in realistic armies. Fights are the live a19 v0.8 on the side-oriented board with
 * deterministic search budgets, on the ranked map rotation, with the live setup policy for both seats.
 *
 * With the same policy in both seats, the two pick-seat assignments of an offer board draft identical armies, so
 * only the first assignment is played, in both battle mirrors: two unique, side-balanced games per board.
 *
 * Usage: bun src/simulation/collect_ranked_draft_strength_data.ts --boards 4000 --seed 97100001 \
 *     [--exploration 0.5] [--concurrency 14] [--chunk 250] --output sim-out/draft_strength/train.jsonl
 */

interface ICollectOptions {
    boards: number;
    seed: number;
    exploration: number;
    concurrency: number;
    chunk: number;
    outputPath: string;
}

function parseCli(argv: readonly string[]): ICollectOptions {
    const values = new Map<string, string>();
    const allowed = new Set(["boards", "seed", "exploration", "concurrency", "chunk", "output"]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) throw new Error(`Unexpected positional argument ${argument}`);
        const [key, inline] = argument.slice(2).split("=", 2);
        if (!allowed.has(key)) throw new Error(`Unknown option --${key}`);
        const value = inline ?? argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
        values.set(key, value);
    }
    const output = values.get("output");
    if (!output) throw new Error("--output is required");
    const options: ICollectOptions = {
        boards: Number(values.get("boards") ?? 4000),
        seed: Number(values.get("seed") ?? 97_100_001),
        exploration: Number(values.get("exploration") ?? 0.5),
        concurrency: Number(values.get("concurrency") ?? Math.max(1, availableParallelism() - 2)),
        chunk: Number(values.get("chunk") ?? 250),
        outputPath: resolve(output),
    };
    if (!Number.isInteger(options.boards) || options.boards < 2) throw new RangeError("--boards must be >= 2");
    if (!Number.isInteger(options.chunk) || options.chunk < 1) throw new RangeError("--chunk must be positive");
    return options;
}

export function rankedDraftStrengthDataOptions(
    boards: number,
    seed: number,
    exploration: number,
    concurrency: number,
): IRankedDraftEvaluationOptions {
    return {
        gamesPerOpponent: boards * 4,
        baseSeed: seed,
        concurrency,
        mapTypes: [...RANKED_DRAFT_LIVE_MAP_TYPES],
        fightProfile: "a19",
        candidateSetupPolicySpec: V07_NONFIGHT_SETUP_SPEC,
        opponentSetupPolicySpec: V07_NONFIGHT_SETUP_SPEC,
        liveDraftRules: true,
        sideBoard: true,
        deterministicSearch: true,
        explorationRate: exploration,
        recordArmies: true,
    };
}

/** The unique games of boards [from, to): first pick-seat assignment, both battle mirrors. */
export function rankedDraftStrengthTasks(from: number, to: number): IRankedDraftEvaluationTask[] {
    const tasks: IRankedDraftEvaluationTask[] = [];
    for (let board = from; board < to; board += 1) {
        tasks.push({ opponentIndex: 0, game: board * 4 }, { opponentIndex: 0, game: board * 4 + 1 });
    }
    return tasks;
}

async function cliMain(): Promise<void> {
    const options = parseCli(process.argv.slice(2));
    const live = rankedDraftLiveIncumbent();
    const pool = [{ ...live, id: "live-control", prior: 1 }];
    const panel = rankedDraftStrengthDataOptions(
        options.boards,
        options.seed,
        options.exploration,
        options.concurrency,
    );
    mkdirSync(dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, "");
    const startedAt = Date.now();
    let written = 0;
    // Chunks keep a long run resumable by inspection: every finished chunk is already on disk.
    for (let from = 0; from < options.boards; from += options.chunk) {
        const to = Math.min(options.boards, from + options.chunk);
        const records = await evaluateRankedDraftTasks(live, pool, panel, rankedDraftStrengthTasks(from, to));
        appendFileSync(options.outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
        written += records.length;
        const perSecond = written / Math.max(1, (Date.now() - startedAt) / 1000);
        const remaining = (options.boards - to) * 2;
        console.error(
            `[draft-strength] boards ${to}/${options.boards} games ${written} ` +
                `(${perSecond.toFixed(2)}/s, eta ${Math.round(remaining / Math.max(perSecond, 1e-9) / 60)}m)`,
        );
    }
    console.error(`[draft-strength] done: ${written} games -> ${options.outputPath}`);
}

if (import.meta.main) {
    cliMain().catch((error) => {
        console.error(error);
        process.exitCode = 2;
    });
}
