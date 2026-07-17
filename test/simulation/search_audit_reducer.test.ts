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

import { describe, expect, it } from "bun:test";

import {
    reduceSearchAuditJsonl,
    searchAuditTurnKey,
    type ISearchAuditTurnRow,
} from "../../src/simulation/search_audit_reducer";

const turn = (seed: number, decisionOrdinal = 0, patch: Record<string, unknown> = {}): ISearchAuditTurnRow => ({
    t: "turn",
    seed,
    side: "green",
    unitId: `unit-${seed}`,
    lap: 2,
    decisionOrdinal,
    inc: "defend",
    selectedKind: "melee",
    validationDelta: 0.2,
    ms: 1.1,
    ...patch,
});

const game = (seed: number, searched: number, msTotal = 3): Record<string, unknown> => ({
    t: "game",
    seed,
    mode: "search",
    observeOnly: true,
    searched,
    decisions: searched,
    msTotal,
});

const jsonl = (...rows: readonly Record<string, unknown>[]): string =>
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

describe("search audit reducer", () => {
    it("deduplicates replayed game blocks and preserves exact planned-seed order", () => {
        const first = turn(11);
        const replay = turn(11, 0, { ms: 99 });
        const result = reduceSearchAuditJsonl(
            jsonl(first, game(11, 1), replay, game(11, 1, 101), game(22, 0)),
            [22, 11],
            { requireCompleteSearchTurns: true },
        );

        expect(result.duplicateTurnRows).toBe(1);
        expect(result.duplicateGameRows).toBe(1);
        expect(result.turnRows).toEqual([first]);
        expect(result.gameRows.map((row) => row.seed)).toEqual([22, 11]);
        expect(searchAuditTurnKey(first)).toBe('[11,"green","unit-11",2,0]');
    });

    it("rejects a conflicting replay at the same stable turn identity", () => {
        expect(() =>
            reduceSearchAuditJsonl(jsonl(turn(7), turn(7, 0, { selectedKind: "shot" }), game(7, 1)), [7], {
                requireCompleteSearchTurns: true,
            }),
        ).toThrow("conflicting replay rows");
    });

    it("fails closed on missing game coverage or incomplete per-turn coverage", () => {
        expect(() => reduceSearchAuditJsonl(jsonl(game(1, 0)), [1, 2])).toThrow("missing 1 planned game");
        expect(() => reduceSearchAuditJsonl(jsonl(game(1, 1)), [1], { requireCompleteSearchTurns: true })).toThrow(
            "0 turn rows but summary searched=1",
        );
    });

    it("rejects legacy turn rows that cannot be deduplicated safely", () => {
        expect(() =>
            reduceSearchAuditJsonl(jsonl({ t: "turn", seed: 3, lap: 1, unit: "Squire" }, game(3, 1)), [3]),
        ).toThrow("side must be green or red");
    });
});
