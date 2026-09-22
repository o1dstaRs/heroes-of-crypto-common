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

/**
 * Per-rollout sample capture for the a19 search, and offline replay of candidate-stopping rules.
 *
 * The search scores every shortlisted candidate with `SEARCH_ROLLOUTS` paired-seed rollouts. This harness
 * records EVERY individual rollout value (not just the per-candidate mean) for each scored decision, so a
 * proposed "stop spending rollouts on hopeless challengers" rule can be replayed against real samples and
 * costed BEFORE anyone writes it into the driver and burns a battery on it.
 *
 * It instruments through `SearchDriver.prototype` wrappers and changes no production code path: the wrapped
 * methods delegate to the originals and only observe. Run it with the offline deterministic budget so host
 * speed cannot move a decision.
 *
 *   bun src/simulation/measure_search_rollout_samples.ts capture <games> <seedOffset> <out.jsonl>
 *   bun src/simulation/measure_search_rollout_samples.ts replay <out.jsonl> [more.jsonl ...]
 *
 * MEASURED 2026-09-21 (48 games, 2,633 scored decisions, 50,828 rollouts, deep budget r4/s6/m10): the
 * per-rollout leaf value swings about +/-0.3 P(win) on the SAME candidate across paired seeds, so a partial
 * mean cannot identify a loser. Rules that leave decisions alone save ~3% of rollouts; rules that save real
 * compute (keep the top 2 after round 1: 34% saved) change 8% of decisions with a median stake of 0.12 P(win).
 * Early stopping is therefore DEAD at this budget — see the a19 memory note. Re-run this before revisiting it.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { buildRoster, makeRng } from "./army";
import { runMatch } from "./battle_engine";
import { SearchDriver } from "./search_driver";
import type { Unit } from "../units/unit";

/** One scored decision: the shortlist, every rollout value per candidate, and what the search chose. */
export interface IRolloutSampleRow {
    /** Game index within the capture run. */
    readonly g: number;
    /** Decision index within the game. */
    readonly d: number;
    readonly unit: string;
    readonly level: number | null;
    /** Shortlisted candidate count, candidate 0 is always the incumbent. */
    readonly k: number;
    /** Rollouts per candidate for this decision. */
    readonly r: number;
    readonly kinds: readonly string[];
    /** samples[candidate][rollout]; null = never executed, "-inf" = illegal. */
    readonly samples: readonly (readonly (number | "-inf" | null)[])[];
    readonly means: readonly (number | "-inf")[];
    /** Index of the candidate the search selected, or -1 when it kept the incumbent by reference. */
    readonly chosen: number;
}

const NEGATIVE_INFINITY_TOKEN = "-inf" as const;
const encode = (value: number): number | "-inf" =>
    value === Number.NEGATIVE_INFINITY ? NEGATIVE_INFINITY_TOKEN : Number(value.toFixed(5));
const decode = (value: number | "-inf" | null): number | null =>
    value === NEGATIVE_INFINITY_TOKEN ? Number.NEGATIVE_INFINITY : value;

interface IScoringContext {
    readonly candidates: readonly unknown[];
    readonly samples: number[][];
    readonly rollouts: number;
}

/**
 * Install the observing wrappers. Returns a restore function; every wrapper delegates to the original, so a
 * captured run reproduces the uninstrumented decisions exactly.
 */
export function installRolloutSampleCapture(onRow: (row: IRolloutSampleRow) => void): () => void {
    const prototype = SearchDriver.prototype as unknown as Record<string, (...args: never[]) => unknown>;
    const originalScore = prototype.scoreCandidates;
    const originalRollout = prototype.rollout;
    const originalSearch = prototype.search;
    let context: IScoringContext | null = null;
    let last: (IScoringContext & { readonly means: readonly number[] }) | null = null;
    let game = 0;
    let decision = 0;

    prototype.rollout = function rollout(this: unknown, ...args: never[]): unknown {
        const value = originalRollout.apply(this, args) as number;
        if (context) {
            const candidate = args[1] as unknown;
            const rolloutIndex = args[3] as unknown as number;
            const index = context.candidates.indexOf(candidate);
            if (index >= 0) context.samples[index][rolloutIndex] = value;
        }
        return value;
    } as never;

    prototype.scoreCandidates = function scoreCandidates(this: unknown, ...args: never[]): unknown {
        const candidates = args[1] as unknown as readonly unknown[];
        const horizonMode = args[3] as unknown as string;
        const rollouts = (args[4] as unknown as number | undefined) ?? (this as { rollouts: number }).rollouts;
        // The shortlist stage scores at one leaf rollout per candidate; only the main scoring pass is a budget.
        if (rollouts < 2 || horizonMode === "leaf") return originalScore.apply(this, args);
        context = {
            candidates: [...candidates],
            samples: candidates.map(() => new Array<number>(rollouts).fill(Number.NaN)),
            rollouts,
        };
        try {
            const means = originalScore.apply(this, args) as number[];
            last = { ...context, means: [...means] };
            return means;
        } finally {
            context = null;
        }
    } as never;

    prototype.search = function search(this: unknown, ...args: never[]): unknown {
        last = null;
        const unit = args[0] as unknown as Unit;
        const incumbent = args[2] as unknown;
        const actions = originalSearch.apply(this, args);
        if (last) {
            const chosen = last.candidates.findIndex(
                (candidate) => (candidate as { actions: unknown }).actions === actions,
            );
            onRow({
                g: game,
                d: decision,
                unit: unit.getName(),
                level: unit.getLevel?.() ?? null,
                k: last.candidates.length,
                r: last.rollouts,
                kinds: last.candidates.map((candidate) => String((candidate as { kind: unknown }).kind)),
                samples: last.samples.map((row) => row.map((value) => (Number.isNaN(value) ? null : encode(value)))),
                means: last.means.map(encode),
                chosen: chosen >= 0 ? chosen : actions === incumbent ? 0 : -1,
            });
        }
        decision += 1;
        return actions;
    } as never;

    return (): void => {
        prototype.scoreCandidates = originalScore;
        prototype.rollout = originalRollout;
        prototype.search = originalSearch;
        void game;
        void decision;
    };
}

/** Replay one stopping rule over captured samples; returns the cost saved and the decisions it would change. */
export function replayStoppingRule(
    rows: readonly IRolloutSampleRow[],
    options: { readonly firstRounds: number; readonly margin: number; readonly keepTop?: number },
): {
    readonly executed: number;
    readonly used: number;
    readonly savedFraction: number;
    readonly changed: number;
    readonly changedFraction: number;
    readonly medianStake: number;
} {
    const { firstRounds, margin, keepTop } = options;
    let executed = 0;
    let used = 0;
    let changed = 0;
    const stakes: number[] = [];
    for (const row of rows) {
        const samples = row.samples.map((candidate) => candidate.map(decode));
        const partial = samples.map((candidate) => {
            const taken = candidate.slice(0, firstRounds).filter((value): value is number => value !== null);
            if (!taken.length || taken.some((value) => value === Number.NEGATIVE_INFINITY)) {
                return Number.NEGATIVE_INFINITY;
            }
            return taken.reduce((sum, value) => sum + value, 0) / taken.length;
        });
        let leader = 0;
        for (let index = 1; index < partial.length; index += 1) {
            if (partial[index] > partial[leader]) leader = index;
        }
        const survivors = new Set<number>([0, leader]);
        const contenders = [];
        for (let index = 1; index < partial.length; index += 1) {
            if (partial[index] >= partial[0] - margin) contenders.push(index);
        }
        contenders.sort((left, right) => partial[right] - partial[left]);
        for (const index of keepTop === undefined ? contenders : contenders.slice(0, keepTop)) {
            survivors.add(index);
        }
        for (let index = 0; index < samples.length; index += 1) {
            const ran = samples[index].filter((value) => value !== null).length;
            executed += ran;
            used += survivors.has(index) ? ran : Math.min(ran, firstRounds);
        }
        if (row.chosen > 0 && !survivors.has(row.chosen)) {
            changed += 1;
            const means = row.means.map((value) =>
                value === NEGATIVE_INFINITY_TOKEN ? Number.NEGATIVE_INFINITY : value,
            );
            let bestSurviving = Number.NEGATIVE_INFINITY;
            for (const index of survivors) {
                if (means[index] > bestSurviving) bestSurviving = means[index];
            }
            stakes.push((means[row.chosen] as number) - bestSurviving);
        }
    }
    stakes.sort((left, right) => left - right);
    return {
        executed,
        used,
        savedFraction: executed ? 1 - used / executed : 0,
        changed,
        changedFraction: rows.length ? changed / rows.length : 0,
        medianStake: stakes.length ? stakes[Math.floor(stakes.length / 2)] : 0,
    };
}

async function capture(games: number, seedOffset: number, out: string): Promise<void> {
    writeFileSync(out, "");
    let game = 0;
    const restore = installRolloutSampleCapture((row) =>
        appendFileSync(out, `${JSON.stringify({ ...row, g: game })}\n`),
    );
    try {
        for (game = 0; game < games; game += 1) {
            const seed = 910_000 + seedOffset + game;
            const result = runMatch({
                greenVersion: "v0.8",
                redVersion: "v0.8",
                roster: buildRoster(makeRng(seed)),
                seed,
                searchOfflineDeterministicWork: true,
            });
            console.log(`game ${game} seed ${seed} winner=${result.winner} laps=${result.laps}`);
        }
    } finally {
        restore();
    }
    console.log(`captured -> ${out}`);
}

function replay(files: readonly string[]): void {
    const rows: IRolloutSampleRow[] = [];
    for (const file of files) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (line.trim()) rows.push(JSON.parse(line) as IRolloutSampleRow);
        }
    }
    const executed = rows.reduce(
        (sum, row) => sum + row.samples.reduce((n, c) => n + c.filter((v) => v !== null).length, 0),
        0,
    );
    console.log(`decisions=${rows.length} rollouts=${executed} overrides=${rows.filter((r) => r.chosen > 0).length}`);
    console.log("rule                       saved%   changed%   medianStake");
    for (const firstRounds of [1, 2]) {
        for (const margin of [0, 0.05, 0.1, 0.25]) {
            for (const keepTop of [undefined, 2]) {
                const result = replayStoppingRule(rows, { firstRounds, margin, keepTop });
                const name = `r0=${firstRounds} m=${margin.toFixed(2)}${keepTop ? ` top${keepTop}` : ""}`;
                console.log(
                    `${name.padEnd(26)} ${(100 * result.savedFraction).toFixed(1).padStart(5)}` +
                        `   ${(100 * result.changedFraction).toFixed(2).padStart(7)}` +
                        `   ${result.medianStake.toFixed(3).padStart(11)}`,
                );
            }
        }
    }
}

if (import.meta.main) {
    const [mode, ...rest] = process.argv.slice(2);
    if (mode === "capture") {
        await capture(Number(rest[0] ?? 4), Number(rest[1] ?? 0), rest[2] ?? "rollout-samples.jsonl");
    } else if (mode === "replay") {
        replay(rest.length ? rest : ["rollout-samples.jsonl"]);
    } else {
        console.error(
            "Usage:\n  bun src/simulation/measure_search_rollout_samples.ts capture <games> <seedOffset> <out.jsonl>" +
                "\n  bun src/simulation/measure_search_rollout_samples.ts replay <file.jsonl> [...]",
        );
        process.exit(2);
    }
}
