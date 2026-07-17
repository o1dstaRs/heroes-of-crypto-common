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

import { readFileSync } from "node:fs";

export type SearchAuditSide = "green" | "red";
export type SearchAuditTurnType = "turn" | "q2" | "q2o";

export interface ISearchAuditTurnRow extends Record<string, unknown> {
    t: SearchAuditTurnType;
    seed: number;
    side: SearchAuditSide;
    unitId: string;
    lap: number;
    /** Zero-based ordinal among SearchDriver decisions in this game. Gaps are valid. */
    decisionOrdinal: number;
}

export interface ISearchAuditGameRow extends Record<string, unknown> {
    t: "game";
    seed: number;
}

export interface ISearchAuditReduction {
    /** Turn rows in seed-plan order, then deterministic in-game order. */
    turnRows: ISearchAuditTurnRow[];
    /** Exactly one summary for each planned seed, in seed-plan order. */
    gameRows: ISearchAuditGameRow[];
    duplicateTurnRows: number;
    duplicateGameRows: number;
}

export interface ISearchAuditReducerOptions {
    /** Require one `t:"turn"` row for each search counted by an observe-only search summary. */
    requireCompleteSearchTurns?: boolean;
}

const TURN_TYPES = new Set<SearchAuditTurnType>(["turn", "q2", "q2o"]);
const MIN_SIGNED_INT32 = -0x80000000;
const MAX_UINT32 = 0xffffffff;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSeed(value: unknown, context: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < MIN_SIGNED_INT32 || (value as number) > MAX_UINT32) {
        throw new Error(`${context} must be a signed int32 or uint32`);
    }
}

function parseRow(line: string, lineNumber: number): ISearchAuditTurnRow | ISearchAuditGameRow {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        throw new Error(`Search audit line ${lineNumber} is not valid JSON`);
    }
    if (!isRecord(value)) throw new Error(`Search audit line ${lineNumber} must be an object`);
    assertSeed(value.seed, `Search audit line ${lineNumber} seed`);
    if (value.t === "game") return value as ISearchAuditGameRow;
    if (typeof value.t !== "string" || !TURN_TYPES.has(value.t as SearchAuditTurnType)) {
        throw new Error(`Search audit line ${lineNumber} has unsupported row type ${String(value.t)}`);
    }
    if (value.side !== "green" && value.side !== "red") {
        throw new Error(`Search audit line ${lineNumber} side must be green or red`);
    }
    if (typeof value.unitId !== "string" || !value.unitId) {
        throw new Error(`Search audit line ${lineNumber} unitId must be non-empty`);
    }
    if (!Number.isSafeInteger(value.lap) || (value.lap as number) < 0) {
        throw new Error(`Search audit line ${lineNumber} lap must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(value.decisionOrdinal) || (value.decisionOrdinal as number) < 0) {
        throw new Error(`Search audit line ${lineNumber} decisionOrdinal must be a non-negative integer`);
    }
    return value as ISearchAuditTurnRow;
}

/** Stable key for deduplicating a replayed match after append-before-checkpoint worker failure. */
export function searchAuditTurnKey(row: ISearchAuditTurnRow): string {
    return JSON.stringify([row.seed, row.side, row.unitId, row.lap, row.decisionOrdinal]);
}

function semanticValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(semanticValue);
    if (!isRecord(value)) return value;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        if (key === "ms" || key === "msTotal") continue;
        normalized[key] = semanticValue(value[key]);
    }
    return normalized;
}

function assertReplayEquivalent(
    existing: ISearchAuditTurnRow | ISearchAuditGameRow,
    replay: ISearchAuditTurnRow | ISearchAuditGameRow,
    context: string,
): void {
    if (JSON.stringify(semanticValue(existing)) !== JSON.stringify(semanticValue(replay))) {
        throw new Error(`${context} has conflicting replay rows`);
    }
}

/**
 * Parse a shared append-only audit, remove whole-game replay duplicates, and fail closed unless its game
 * summaries cover the exact planned seed set. Timing fields are ignored only when comparing replay rows.
 */
export function reduceSearchAuditJsonl(
    jsonl: string,
    plannedSeeds: readonly number[],
    options: ISearchAuditReducerOptions = {},
): ISearchAuditReduction {
    const planIndex = new Map<number, number>();
    for (let index = 0; index < plannedSeeds.length; index += 1) {
        const seed = plannedSeeds[index];
        assertSeed(seed, `Planned seed ${index}`);
        if (planIndex.has(seed)) throw new Error(`Planned seeds repeat ${seed}`);
        planIndex.set(seed, index);
    }

    const turnByKey = new Map<string, ISearchAuditTurnRow>();
    const gameBySeed = new Map<number, ISearchAuditGameRow>();
    let duplicateTurnRows = 0;
    let duplicateGameRows = 0;
    const lines = jsonl.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        const row = parseRow(line, index + 1);
        if (!planIndex.has(row.seed)) throw new Error(`Search audit contains unexpected seed ${row.seed}`);
        if (row.t === "game") {
            const existing = gameBySeed.get(row.seed);
            if (existing) {
                assertReplayEquivalent(existing, row, `Game seed ${row.seed}`);
                duplicateGameRows += 1;
            } else {
                gameBySeed.set(row.seed, row);
            }
            continue;
        }
        const key = searchAuditTurnKey(row);
        const existing = turnByKey.get(key);
        if (existing) {
            assertReplayEquivalent(existing, row, `Turn ${key}`);
            duplicateTurnRows += 1;
        } else {
            turnByKey.set(key, row);
        }
    }

    const missingSeeds = plannedSeeds.filter((seed) => !gameBySeed.has(seed));
    if (missingSeeds.length) {
        throw new Error(
            `Search audit is missing ${missingSeeds.length} planned game summary row(s): ${missingSeeds
                .slice(0, 8)
                .join(", ")}`,
        );
    }

    const turnRows = [...turnByKey.values()].sort((left, right) => {
        const planOrder = planIndex.get(left.seed)! - planIndex.get(right.seed)!;
        if (planOrder !== 0) return planOrder;
        if (left.decisionOrdinal !== right.decisionOrdinal) return left.decisionOrdinal - right.decisionOrdinal;
        if (left.side !== right.side) return left.side.localeCompare(right.side);
        if (left.unitId !== right.unitId) return left.unitId.localeCompare(right.unitId);
        return left.t.localeCompare(right.t);
    });
    const gameRows = plannedSeeds.map((seed) => gameBySeed.get(seed)!);

    if (options.requireCompleteSearchTurns) {
        const turnCountBySeed = new Map<number, number>();
        for (const row of turnRows) {
            if (row.t === "turn") turnCountBySeed.set(row.seed, (turnCountBySeed.get(row.seed) ?? 0) + 1);
        }
        for (const row of gameRows) {
            if (row.mode !== "search" || row.observeOnly !== true) {
                throw new Error(`Game seed ${row.seed} is not an observe-only search audit`);
            }
            if (!Number.isSafeInteger(row.searched) || (row.searched as number) < 0) {
                throw new Error(`Game seed ${row.seed} searched must be a non-negative integer`);
            }
            const observed = turnCountBySeed.get(row.seed) ?? 0;
            if (observed !== row.searched) {
                throw new Error(`Game seed ${row.seed} has ${observed} turn rows but summary searched=${row.searched}`);
            }
        }
    }

    return { turnRows, gameRows, duplicateTurnRows, duplicateGameRows };
}

export function reduceSearchAuditFile(
    path: string,
    plannedSeeds: readonly number[],
    options: ISearchAuditReducerOptions = {},
): ISearchAuditReduction {
    return reduceSearchAuditJsonl(readFileSync(path, "utf8"), plannedSeeds, options);
}
