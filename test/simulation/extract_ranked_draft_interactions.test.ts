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

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { expect, test } from "bun:test";

import {
    AI_META_MAPS,
    prepareMetaPair,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
    type IAiMetaRunOptions,
} from "../../src/simulation/ai_meta_cohorts_core";
import { extractRankedDraftInteractions } from "../../src/simulation/extract_ranked_draft_interactions";

const outcome = (aIsGreen: boolean, winner: "a" | "b" | "draw"): IAiMetaGameOutcome => ({
    aIsGreen,
    winner,
    laps: 5,
    endReason: "elimination",
    armageddonDecided: false,
    rejectedA: 0,
    rejectedB: 0,
    hpA: winner === "a" ? 100 : 0,
    hpB: winner === "b" ? 100 : 0,
    survivorsA: winner === "a" ? 2 : 0,
    survivorsB: winner === "b" ? 2 : 0,
});

test("extracts a validated ranked-only interaction summary from a completed full meta report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hoc-ranked-interactions-"));
    try {
        const options: IAiMetaRunOptions = { cohort: "ranked-draft", games: 6, baseSeed: 96_451_101 };
        const records = AI_META_MAPS.map((map, pair) => ({
            ...prepareMetaPair(options, pair, map),
            games: [outcome(true, pair % 2 ? "b" : "a"), outcome(false, pair % 2 ? "b" : "a")],
        })) satisfies IAiMetaPairRecord[];
        const rawPath = "ranked-draft.pairs.jsonl.gz";
        writeFileSync(
            join(directory, rawPath),
            gzipSync(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`),
        );
        const summaryPath = join(directory, "ai-meta.summary.json");
        writeFileSync(
            summaryPath,
            `${JSON.stringify({
                complete: true,
                generatedAt: "2026-08-04T09:42:30.768Z",
                cohorts: [
                    {
                        cohort: "ranked-draft",
                        pairs: records.length,
                        games: records.length * 2,
                        rejectedActions: 0,
                        distinctRosterViolations: 0,
                        overlappingCreatureViolations: 0,
                        mapGames: Object.fromEntries(AI_META_MAPS.map((map) => [String(map), 2])),
                        rawPath,
                    },
                ],
            })}\n`,
        );

        const outputPath = join(directory, "ranked-draft.interactions.json");
        const result = await extractRankedDraftInteractions(summaryPath, outputPath);
        const extracted = JSON.parse(readFileSync(outputPath, "utf8")) as {
            generatedAt: string;
            interactions: { scope: { cohorts: string[]; maps: number[]; pairs: number; games: number } };
        };

        expect(result).toEqual({ outputPath, rawPath: realpathSync(join(directory, rawPath)), pairs: 3, games: 6 });
        expect(extracted.generatedAt).toBe("2026-08-04T09:42:30.768Z");
        expect(extracted.interactions.scope).toEqual({
            cohorts: ["ranked-draft"],
            maps: [...AI_META_MAPS],
            pairs: 3,
            games: 6,
        });
    } finally {
        rmSync(directory, { force: true, recursive: true });
    }
});
