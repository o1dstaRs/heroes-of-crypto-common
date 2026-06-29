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

import {
    buildRoster,
    makeRng,
    DEFAULT_ROSTER_COMPOSITION,
    DEFAULT_AMOUNT_BY_LEVEL,
    type IRosterComposition,
} from "./army";
import { runMatch, type IMatchResult, type Side } from "./battle_engine";

export interface ITournamentOptions {
    versionA: string;
    versionB: string;
    /** Total games to play. Played as mirrored pairs (each roster is fought twice with sides swapped). */
    games: number;
    /** Base seed; game i uses a seed derived from it, so a whole run reproduces from one number. */
    baseSeed: number;
    maxLaps?: number;
    composition?: readonly IRosterComposition[];
    amountByLevel?: Readonly<Record<number, number>>;
}

export interface IGameRecord {
    game: number;
    /** Which version played which side this game (sides swap every other game). */
    greenVersion: string;
    redVersion: string;
    winnerVersion: string | "draw";
    result: IMatchResult;
}

export interface IVersionStats {
    version: string;
    wins: number;
    winsAsGreen: number;
    winsAsRed: number;
}

export interface ITournamentSummary {
    versionA: string;
    versionB: string;
    games: number;
    baseSeed: number;
    a: IVersionStats;
    b: IVersionStats;
    draws: number;
    /** Share of decisive games won by A (draws excluded). 0.5 = no improvement. */
    winRateA: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    better: string | "tie";
    /** Games whose result leaned on armageddon attrition rather than a clean combat kill. */
    armageddonDecided: number;
    /** Fraction of games NOT decided by armageddon — higher is better (AI wins cleanly). */
    cleanWinRate: number;
}

const emptyStats = (version: string): IVersionStats => ({ version, wins: 0, winsAsGreen: 0, winsAsRed: 0 });

/**
 * Play a single game by its index. Fully self-contained — the seed (and thus the mirrored roster) and
 * the side assignment are derived from the index alone, so games can be run in ANY order or in
 * parallel across workers and still produce the same roster per index. Each mirrored pair (games 2k,
 * 2k+1) shares a roster+seed and swaps sides, cancelling green/red bias.
 */
export function playGame(options: ITournamentOptions, game: number): IGameRecord {
    const composition = options.composition ?? DEFAULT_ROSTER_COMPOSITION;
    const amountByLevel = options.amountByLevel ?? DEFAULT_AMOUNT_BY_LEVEL;

    const pairIndex = Math.floor(game / 2);
    const seed = (options.baseSeed + pairIndex * 0x9e3779b1) >>> 0;
    const roster = buildRoster(makeRng(seed), composition, amountByLevel);

    const aIsGreen = game % 2 === 0;
    const greenVersion = aIsGreen ? options.versionA : options.versionB;
    const redVersion = aIsGreen ? options.versionB : options.versionA;

    const result = runMatch({ greenVersion, redVersion, roster, seed, maxLaps: options.maxLaps });

    const winnerSide: Side | "draw" = result.winner;
    const winnerVersion = winnerSide === "draw" ? "draw" : winnerSide === "green" ? greenVersion : redVersion;
    return { game, greenVersion, redVersion, winnerVersion, result };
}

/** Running totals over games. Accumulation is order-independent, so parallel results merge cleanly. */
export interface ITournamentTally {
    a: IVersionStats;
    b: IVersionStats;
    draws: number;
    totalLaps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    counted: number;
}

export function createTally(options: ITournamentOptions): ITournamentTally {
    return {
        a: emptyStats(options.versionA),
        b: emptyStats(options.versionB),
        draws: 0,
        totalLaps: 0,
        endReasons: {},
        armageddonDecided: 0,
        counted: 0,
    };
}

export function tallyGame(tally: ITournamentTally, record: IGameRecord, options: ITournamentOptions): void {
    if (record.winnerVersion === "draw") {
        tally.draws += 1;
    } else {
        const stats = record.winnerVersion === options.versionA ? tally.a : tally.b;
        stats.wins += 1;
        if (record.result.winner === "green") {
            stats.winsAsGreen += 1;
        } else {
            stats.winsAsRed += 1;
        }
    }
    tally.totalLaps += record.result.laps;
    tally.endReasons[record.result.endReason] = (tally.endReasons[record.result.endReason] ?? 0) + 1;
    if (record.result.attrition.decidedByArmageddon) {
        tally.armageddonDecided += 1;
    }
    tally.counted += 1;
}

export function finalizeTally(tally: ITournamentTally, options: ITournamentOptions): ITournamentSummary {
    const decisive = tally.a.wins + tally.b.wins;
    return {
        versionA: options.versionA,
        versionB: options.versionB,
        games: options.games,
        baseSeed: options.baseSeed,
        a: tally.a,
        b: tally.b,
        draws: tally.draws,
        winRateA: decisive > 0 ? tally.a.wins / decisive : 0.5,
        avgLaps: tally.counted ? tally.totalLaps / tally.counted : 0,
        endReasons: tally.endReasons,
        better:
            tally.a.wins === tally.b.wins ? "tie" : tally.a.wins > tally.b.wins ? options.versionA : options.versionB,
        armageddonDecided: tally.armageddonDecided,
        cleanWinRate: tally.counted ? 1 - tally.armageddonDecided / tally.counted : 1,
    };
}

/**
 * Play `games` AI-vs-AI battles between two versions and tally who wins (sequentially, in this thread).
 * For large runs use runTournamentConcurrent (worker pool). `onGame` receives the full per-game record
 * (placements + every action) so a caller can stream them to a JSONL log for later LLM analysis.
 */
export function runTournament(options: ITournamentOptions, onGame?: (record: IGameRecord) => void): ITournamentSummary {
    const tally = createTally(options);
    for (let game = 0; game < options.games; game += 1) {
        const record = playGame(options, game);
        tallyGame(tally, record, options);
        onGame?.(record);
    }
    return finalizeTally(tally, options);
}
