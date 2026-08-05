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

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { TIER1_ARTIFACT_LIST } from "../../src/artifacts/artifact_properties";
import {
    AI_META_MAPS,
    AI_META_RECORDED_MAPS,
    prepareMetaPair,
    type AiMetaRecordedMap,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
    type IAiMetaRunOptions,
} from "../../src/simulation/ai_meta_cohorts_core";
import {
    AiMetaAccumulator,
    AiMetaAggregation,
    type IAiMetaMetricRow,
    type IAiMetaSummary,
} from "../../src/simulation/measure_ai_meta_cohorts";
import { reaggregateAiMetaSummary } from "../../src/simulation/reaggregate_ai_meta_summary";

const options: IAiMetaRunOptions = {
    cohort: "uniform-mixed",
    games: 8,
    baseSeed: 85_000_717,
};

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

interface IFixture {
    directory: string;
    summaryPath: string;
    summaryText: string;
    records: IAiMetaPairRecord[];
}

function fixture(maps: readonly AiMetaRecordedMap[] = AI_META_RECORDED_MAPS): IFixture {
    const directory = mkdtempSync(join(tmpdir(), "hoc-ai-meta-maps-"));
    const records = maps.map((map: AiMetaRecordedMap, pair) => ({
        ...prepareMetaPair(options, pair),
        map,
        games: [outcome(true, pair % 2 ? "b" : "a"), outcome(false, pair % 2 ? "b" : "a")],
    })) satisfies IAiMetaPairRecord[];
    const accumulator = new AiMetaAccumulator("uniform-mixed");
    const aggregation = new AiMetaAggregation();
    records.forEach((record) => {
        accumulator.add(record);
        aggregation.add(record);
    });
    const computed = aggregation.rows();
    const legacyRows = (rows: readonly IAiMetaMetricRow[]): Omit<IAiMetaMetricRow, "map">[] =>
        rows.filter((row) => row.map === "all").map(({ map: _map, ...row }) => row);
    const rankings = {
        units: legacyRows(computed.units),
        artifactsT1: legacyRows(computed.artifactsT1),
        artifactsT2: legacyRows(computed.artifactsT2),
        augmentPlans: legacyRows(computed.augmentPlans),
        augmentLevels: legacyRows(computed.augmentLevels),
    } as unknown as IAiMetaSummary["rankings"];
    const rawPath = "uniform-mixed.pairs.jsonl.gz";
    writeFileSync(
        join(directory, rawPath),
        gzipSync(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`),
    );
    const summary: IAiMetaSummary = {
        schemaVersion: 1,
        complete: true,
        generatedAt: "2026-07-18T00:00:00.000Z",
        provenance: {
            requestedCohorts: ["uniform-mixed"],
            totalGames: accumulator.games,
            totalPairs: accumulator.pairs,
            maps: [...maps],
            sourceSha256: "original-provenance",
        },
        cohorts: [
            {
                cohort: "uniform-mixed",
                description: "fixture",
                pairs: accumulator.pairs,
                games: accumulator.games,
                greenWins: accumulator.greenWins,
                redWins: accumulator.redWins,
                draws: accumulator.draws,
                armageddonDecided: accumulator.armageddonDecided,
                rejectedActions: accumulator.rejectedActions,
                distinctRosterViolations: accumulator.distinctRosterViolations,
                overlappingCreatureViolations: accumulator.overlappingCreatureViolations,
                mapGames: accumulator.mapGames,
                endReasons: accumulator.endReasons,
                seconds: 1,
                gamesPerSecond: accumulator.games,
                rawPath,
            },
        ],
        rankings,
    };
    const summaryPath = join(directory, "ai-meta.summary.json");
    const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    writeFileSync(summaryPath, summaryText);
    return { directory, summaryPath, summaryText, records };
}

test("reaggregates legacy raw files into all, live, and numeric map dimensions without touching the source", async () => {
    const run = fixture();
    try {
        const result = await reaggregateAiMetaSummary(run.summaryPath);
        expect(result.outputPath).toBe(join(realpathSync(run.directory), "ai-meta.maps.summary.json"));
        expect(result.maps).toEqual([1, 2, 3, 4]);
        expect(result.pairs).toBe(4);
        expect(result.games).toBe(8);
        expect(readFileSync(run.summaryPath, "utf8")).toBe(run.summaryText);

        const enriched = JSON.parse(readFileSync(result.outputPath, "utf8")) as IAiMetaSummary;
        expect(enriched.generatedAt).toBe("2026-07-18T00:00:00.000Z");
        expect(enriched.provenance).toEqual(
            expect.objectContaining({
                sourceSha256: "original-provenance",
                maps: [1, 2, 3, 4],
                mapAggregation: expect.objectContaining({
                    sourceSummary: "ai-meta.summary.json",
                    liveMaps: [1, 3, 4],
                    recordedMaps: [1, 2, 3, 4],
                    defaultDimension: "live",
                    waterNonLive: true,
                    tool: expect.objectContaining({
                        entrypoint: "src/simulation/reaggregate_ai_meta_summary.ts",
                        commonCommit: expect.any(String),
                        commonDirty: expect.any(Boolean),
                        commonStatus: expect.any(Array),
                        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                        runtime: expect.stringMatching(/^bun /),
                    }),
                }),
            }),
        );
        const dimensions = new Set(enriched.rankings.artifactsT1.map((row) => `${row.cohort}/${row.map}`));
        expect(dimensions).toEqual(
            new Set(
                ["all", "uniform-mixed"].flatMap((cohort) =>
                    ["all", "live", 1, 2, 3, 4].map((map) => `${cohort}/${map}`),
                ),
            ),
        );
        expect(enriched.rankings.artifactsT1).toHaveLength(TIER1_ARTIFACT_LIST.length * dimensions.size);
        expect(enriched.rankings.artifactsT1.every((row) => row.map !== undefined)).toBe(true);
        expect(enriched.rankings.synergies).toHaveLength(24 * dimensions.size);
        expect(new Set(enriched.rankings.synergies.map((row) => `${row.cohort}/${row.map}`))).toEqual(dimensions);
        expect(enriched.rankings.synergies.every((row) => row.map !== undefined)).toBe(true);
        expect(enriched.interactions).toMatchObject({
            schema: "cross-fitted-ridge-unit-interactions-v1",
            scope: { maps: [1, 3, 4], cohorts: ["uniform-mixed"], pairs: 3, games: 6 },
            allyPairs: [],
            allyTrios: [],
            counters: [],
        });
    } finally {
        rmSync(run.directory, { recursive: true, force: true });
    }
});

test("marks a future live-only summary as having no recorded non-live water data", async () => {
    const run = fixture(AI_META_MAPS);
    try {
        const result = await reaggregateAiMetaSummary(run.summaryPath);
        const enriched = JSON.parse(readFileSync(result.outputPath, "utf8")) as IAiMetaSummary;
        expect(enriched.provenance.mapAggregation).toEqual(
            expect.objectContaining({
                liveMaps: [1, 3, 4],
                recordedMaps: [1, 3, 4],
                waterNonLive: false,
            }),
        );
        expect(new Set(enriched.rankings.artifactsT1.map((row) => row.map))).toEqual(new Set(["all", "live", 1, 3, 4]));
        expect(new Set(enriched.rankings.synergies.map((row) => row.map))).toEqual(new Set(["all", "live", 1, 3, 4]));
    } finally {
        rmSync(run.directory, { recursive: true, force: true });
    }
});

test("restores omitted zero-support unit rows from complete raw data", async () => {
    const run = fixture(AI_META_MAPS);
    try {
        const source = JSON.parse(readFileSync(run.summaryPath, "utf8")) as IAiMetaSummary;
        source.rankings.units = source.rankings.units.filter((row) => row.selected > 0);
        writeFileSync(run.summaryPath, `${JSON.stringify(source, null, 2)}\n`);

        const result = await reaggregateAiMetaSummary(run.summaryPath);
        const enriched = JSON.parse(readFileSync(result.outputPath, "utf8")) as IAiMetaSummary;
        const restored = enriched.rankings.units.filter(
            (row) => row.map === "all" && row.selected === 0 && row.games === 0 && row.pairs === 0,
        );

        expect(restored.length).toBeGreaterThan(0);
        expect(restored.every((row) => row.pickRate === 0 && row.scoreRate === 0.5)).toBe(true);
    } finally {
        rmSync(run.directory, { recursive: true, force: true });
    }
});

test("requires an explicit diagnostic flag before reaggregating a partial summary", async () => {
    const run = fixture(AI_META_MAPS);
    try {
        const source = JSON.parse(readFileSync(run.summaryPath, "utf8")) as IAiMetaSummary;
        source.complete = false;
        source.provenance.requestedCohorts = ["uniform-mixed", "ranged-heavy"];
        writeFileSync(run.summaryPath, `${JSON.stringify(source, null, 2)}\n`);

        await expect(reaggregateAiMetaSummary(run.summaryPath)).rejects.toThrow("without allowPartial");
        await expect(reaggregateAiMetaSummary(run.summaryPath, undefined, { allowPartial: true })).rejects.toThrow(
            "explicit diagnostic output path",
        );

        const outputPath = join(run.directory, "partial-interactions.summary.json");
        await reaggregateAiMetaSummary(run.summaryPath, outputPath, { allowPartial: true });
        const enriched = JSON.parse(readFileSync(outputPath, "utf8")) as IAiMetaSummary;
        expect(enriched.complete).toBe(false);
        expect(enriched.provenance.mapAggregation).toEqual(
            expect.objectContaining({ sourceComplete: false, partialDiagnostic: true }),
        );
        expect(enriched.rankings).toEqual(source.rankings);
        expect(enriched.interactions?.scope).toMatchObject({ pairs: 3, games: 6 });
    } finally {
        rmSync(run.directory, { recursive: true, force: true });
    }
});

test("allowPartial does not weaken validation for a complete summary", async () => {
    const run = fixture(AI_META_MAPS);
    try {
        const outputPath = join(run.directory, "complete-with-flag.summary.json");
        await reaggregateAiMetaSummary(run.summaryPath, outputPath, { allowPartial: true });
        const enriched = JSON.parse(readFileSync(outputPath, "utf8")) as IAiMetaSummary;

        expect(enriched.provenance.mapAggregation).toEqual(
            expect.objectContaining({ sourceComplete: true, partialDiagnostic: false }),
        );
        expect(enriched.rankings.artifactsT1.some((row) => row.map === "live")).toBe(true);
    } finally {
        rmSync(run.directory, { recursive: true, force: true });
    }
});

test("rejects duplicate raw pairs before publishing an enriched summary", async () => {
    const run = fixture();
    try {
        const corrupt = [...run.records.slice(0, 3), run.records[2]];
        writeFileSync(
            join(run.directory, "uniform-mixed.pairs.jsonl.gz"),
            gzipSync(`${corrupt.map((record) => JSON.stringify(record)).join("\n")}\n`),
        );
        await expect(reaggregateAiMetaSummary(run.summaryPath)).rejects.toThrow("duplicate or out-of-range pair");
    } finally {
        rmSync(run.directory, { recursive: true, force: true });
    }
});
