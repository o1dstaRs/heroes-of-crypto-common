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

import { RANKED_VERSATILE_DRAFT_SPEC } from "../ai/setup/draft_ship";
import { isRankedDraftStrengthPolicy } from "../ai/setup/draft_strength_prior";
import { V07_NONFIGHT_SETUP_SPEC } from "../ai/setup/setup_ship";
import {
    evaluateRankedDraftTasks,
    RANKED_DRAFT_LIVE_MAP_TYPES,
    rankedDraftLiveIncumbent,
    rankedDraftStrengthCandidate,
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
 * --policy drafts both seats with a battle-fitted strength policy instead (e.g. the shipped
 * ranked-unit-strength-a19-side-v1-w4), so a refit sees the armies the current bot actually builds. --from resumes
 * an interrupted run at a board, appending to the existing output instead of truncating it.
 *
 * Usage: bun src/simulation/collect_ranked_draft_strength_data.ts --boards 4000 --seed 97100001 \
 *     [--exploration 0.5] [--concurrency 14] [--chunk 250] [--policy <strength policy id>] [--from <board>] \
 *     --output sim-out/draft_strength/train.jsonl
 */

interface ICollectOptions {
    boards: number;
    seed: number;
    exploration: number;
    concurrency: number;
    chunk: number;
    outputPath: string;
    policy?: string;
    from: number;
}

function parseCli(argv: readonly string[]): ICollectOptions {
    const values = new Map<string, string>();
    const allowed = new Set(["boards", "seed", "exploration", "concurrency", "chunk", "output", "policy", "from"]);
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
        policy: values.get("policy"),
        from: Number(values.get("from") ?? 0),
    };
    if (!Number.isInteger(options.boards) || options.boards < 2) throw new RangeError("--boards must be >= 2");
    if (!Number.isInteger(options.chunk) || options.chunk < 1) throw new RangeError("--chunk must be positive");
    if (!Number.isInteger(options.from) || options.from < 0 || options.from >= options.boards) {
        throw new RangeError("--from must be a board index below --boards");
    }
    return options;
}

/**
 * The genome both seats draft with: the deployed versatile draft by default, or a battle-fitted strength policy
 * exactly as the ranked draft harness evaluates it.
 */
export function rankedDraftStrengthDataDrafter(policy?: string): ReturnType<typeof rankedDraftLiveIncumbent> {
    if (policy === undefined || policy === RANKED_VERSATILE_DRAFT_SPEC) return rankedDraftLiveIncumbent();
    if (!isRankedDraftStrengthPolicy(policy)) {
        throw new RangeError(`--policy must be ${RANKED_VERSATILE_DRAFT_SPEC} or a strength policy id, got ${policy}`);
    }
    return rankedDraftStrengthCandidate(policy);
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
    const drafter = rankedDraftStrengthDataDrafter(options.policy);
    const pool = [{ ...drafter, id: options.policy ? `${drafter.id}-control` : "live-control", prior: 1 }];
    const panel = rankedDraftStrengthDataOptions(
        options.boards,
        options.seed,
        options.exploration,
        options.concurrency,
    );
    mkdirSync(dirname(options.outputPath), { recursive: true });
    if (options.from === 0) writeFileSync(options.outputPath, "");
    const startedAt = Date.now();
    let written = 0;
    // Chunks keep a long run resumable: every finished chunk is already on disk, and --from continues after it.
    for (let from = options.from; from < options.boards; from += options.chunk) {
        const to = Math.min(options.boards, from + options.chunk);
        const records = await evaluateRankedDraftTasks(drafter, pool, panel, rankedDraftStrengthTasks(from, to));
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
