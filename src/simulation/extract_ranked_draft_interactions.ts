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
    createReadStream,
    existsSync,
    linkSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";

import { format } from "prettier";

import {
    AI_META_GAMES_PER_MATCHUP,
    AI_META_MAPS,
    AI_META_SCHEMA_VERSION,
    type IAiMetaArmy,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
} from "./ai_meta_cohorts_core";
import { AiMetaUnitInteractionCollector, type IAiMetaUnitInteractionAnalysis } from "./ai_meta_unit_interactions";

type UnknownRecord = Record<string, unknown>;

interface IRankedCohortSummary {
    pairs: number;
    games: number;
    mapGames: Record<string, number>;
    rawPath: string;
}

interface IAiMetaSummaryInput {
    generatedAt: string;
    rankedCohort: IRankedCohortSummary;
}

export interface IRankedDraftInteractionExtraction {
    generatedAt: string;
    interactions: IAiMetaUnitInteractionAnalysis;
}

export interface IRankedDraftInteractionExtractionResult {
    outputPath: string;
    rawPath: string;
    pairs: number;
    games: number;
}

const isRecord = (value: unknown): value is UnknownRecord =>
    !!value && typeof value === "object" && !Array.isArray(value);

const assertInteger = (value: unknown, label: string, minimum: number = 0): number => {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
    }
    return value as number;
};

const assertFinite = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be finite`);
    }
    return value;
};

const assertString = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
    return value;
};

const assertArtifact = (value: unknown, label: string): void => {
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    assertInteger(value.id, `${label}.id`, 0);
};

function assertArmy(value: unknown, label: string): asserts value is IAiMetaArmy {
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    if (!Array.isArray(value.roster) || !value.roster.length) throw new TypeError(`${label}.roster must be non-empty`);
    value.roster.forEach((unit, index) => {
        if (!isRecord(unit)) throw new TypeError(`${label}.roster[${index}] must be an object`);
        assertString(unit.creatureName, `${label}.roster[${index}].creatureName`);
        assertInteger(unit.level, `${label}.roster[${index}].level`, 1);
        assertInteger(unit.amount, `${label}.roster[${index}].amount`, 1);
    });
    if (!Array.isArray(value.creatureIds) || value.creatureIds.length !== value.roster.length) {
        throw new TypeError(`${label}.creatureIds must match roster`);
    }
    value.creatureIds.forEach((creatureId, index) => assertInteger(creatureId, `${label}.creatureIds[${index}]`, 1));
    assertString(value.setupCohort, `${label}.setupCohort`);
    assertArtifact(value.artifactT1, `${label}.artifactT1`);
    assertArtifact(value.artifactT2, `${label}.artifactT2`);
    if (!isRecord(value.augment)) throw new TypeError(`${label}.augment must be an object`);
    assertString(value.augment.planId, `${label}.augment.planId`);
    if (!Array.isArray(value.synergies)) throw new TypeError(`${label}.synergies must be an array`);
    value.synergies.forEach((choice, index) => {
        if (!isRecord(choice)) throw new TypeError(`${label}.synergies[${index}] must be an object`);
        assertInteger(choice.faction, `${label}.synergies[${index}].faction`, 1);
        assertInteger(choice.synergy, `${label}.synergies[${index}].synergy`, 1);
    });
}

function assertOutcome(value: unknown, label: string): asserts value is IAiMetaGameOutcome {
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    if (value.winner !== "a" && value.winner !== "b" && value.winner !== "draw") {
        throw new TypeError(`${label}.winner is invalid`);
    }
    if (typeof value.aIsGreen !== "boolean") throw new TypeError(`${label}.aIsGreen must be boolean`);
    for (const key of ["laps", "hpA", "hpB", "survivorsA", "survivorsB"] as const) {
        assertFinite(value[key], `${label}.${key}`);
    }
}

const parseRankedPair = (value: unknown, line: number): IAiMetaPairRecord => {
    const label = `ranked-draft raw line ${line}`;
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    if (value.schemaVersion !== AI_META_SCHEMA_VERSION)
        throw new TypeError(`${label} has an incompatible schemaVersion`);
    if (value.cohort !== "ranked-draft") throw new TypeError(`${label} belongs to ${String(value.cohort)}`);
    assertInteger(value.pair, `${label}.pair`, 0);
    if (!Number.isSafeInteger(value.map) || !(AI_META_MAPS as readonly number[]).includes(value.map as number)) {
        throw new TypeError(`${label}.map is not a live map`);
    }
    assertArmy(value.armyA, `${label}.armyA`);
    assertArmy(value.armyB, `${label}.armyB`);
    if (!Array.isArray(value.games) || value.games.length !== AI_META_GAMES_PER_MATCHUP) {
        throw new TypeError(`${label}.games must contain the seat-swapped pair`);
    }
    value.games.forEach((outcome, index) => assertOutcome(outcome, `${label}.games[${index}]`));
    return value as unknown as IAiMetaPairRecord;
};

const parseSummary = (value: unknown): IAiMetaSummaryInput => {
    if (!isRecord(value)) throw new TypeError("AI-meta summary must be an object");
    const generatedAt = assertString(value.generatedAt, "AI-meta summary generatedAt");
    if (value.complete !== true) throw new TypeError("AI-meta summary must be complete");
    if (!Array.isArray(value.cohorts)) throw new TypeError("AI-meta summary cohorts must be an array");
    const ranked = value.cohorts.filter((entry) => isRecord(entry) && entry.cohort === "ranked-draft");
    if (ranked.length !== 1) throw new TypeError("AI-meta summary must contain exactly one ranked-draft cohort");
    const cohort = ranked[0];
    const pairs = assertInteger(cohort.pairs, "ranked-draft cohort pairs", 1);
    const games = assertInteger(cohort.games, "ranked-draft cohort games", AI_META_GAMES_PER_MATCHUP);
    if (games !== pairs * AI_META_GAMES_PER_MATCHUP) {
        throw new TypeError("ranked-draft cohort games must equal twice its pair count");
    }
    const rawPath = assertString(cohort.rawPath, "ranked-draft cohort rawPath");
    if (basename(rawPath) !== rawPath) throw new TypeError("ranked-draft cohort rawPath must be a basename");
    for (const key of ["rejectedActions", "distinctRosterViolations", "overlappingCreatureViolations"] as const) {
        if (assertInteger(cohort[key], `ranked-draft cohort ${key}`, 0) !== 0) {
            throw new TypeError(`ranked-draft cohort ${key} must be zero`);
        }
    }
    if (!isRecord(cohort.mapGames)) throw new TypeError("ranked-draft cohort mapGames must be an object");
    if (Object.keys(cohort.mapGames).some((key) => !AI_META_MAPS.map(String).includes(key))) {
        throw new TypeError("ranked-draft cohort mapGames contains a non-live map");
    }
    const mapGames: Record<string, number> = {};
    for (const map of AI_META_MAPS) {
        const count = assertInteger(cohort.mapGames[String(map)], `ranked-draft cohort mapGames.${map}`, 1);
        if (count % AI_META_GAMES_PER_MATCHUP) {
            throw new TypeError(`ranked-draft cohort mapGames.${map} must be seat-paired`);
        }
        mapGames[String(map)] = count;
    }
    if (Object.values(mapGames).reduce((sum, count) => sum + count, 0) !== games) {
        throw new TypeError("ranked-draft cohort mapGames must sum to games");
    }
    return { generatedAt, rankedCohort: { pairs, games, mapGames, rawPath } };
};

const publishJsonAtomically = async (outputPath: string, value: unknown): Promise<void> => {
    if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing output ${outputPath}`);
    mkdirSync(dirname(outputPath), { recursive: true });
    const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        writeFileSync(
            temporaryPath,
            await format(JSON.stringify(value, null, 4), { parser: "json", printWidth: 120, tabWidth: 4 }),
            { flag: "wx" },
        );
        linkSync(temporaryPath, outputPath);
    } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
};

export async function extractRankedDraftInteractions(
    summaryArgument: string,
    outputArgument: string,
): Promise<IRankedDraftInteractionExtractionResult> {
    const summaryPath = realpathSync(resolve(summaryArgument));
    const outputPath = resolve(outputArgument);
    if (outputPath === summaryPath)
        throw new Error("Interaction extraction output must not replace the source summary");
    const summary = parseSummary(JSON.parse(readFileSync(summaryPath, "utf8")) as unknown);
    const summaryDirectory = realpathSync(dirname(summaryPath));
    const rawPath = realpathSync(resolve(summaryDirectory, summary.rankedCohort.rawPath));
    const rawRelativePath = relative(summaryDirectory, rawPath);
    if (!rawRelativePath || rawRelativePath.startsWith("..") || isAbsolute(rawRelativePath)) {
        throw new Error("ranked-draft rawPath resolves outside the summary directory");
    }
    if (!statSync(rawPath).isFile()) throw new Error("ranked-draft rawPath must resolve to a file");
    const collector = new AiMetaUnitInteractionCollector();
    const pairIds = new Set<number>();
    const mapPairs = new Map<number, number>();
    const compressed = createReadStream(rawPath);
    const gunzip = createGunzip();
    compressed.pipe(gunzip);
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (!line.trim()) throw new TypeError(`ranked-draft raw line ${lineNumber} is blank`);
            let parsed: unknown;
            try {
                parsed = JSON.parse(line) as unknown;
            } catch (error) {
                throw new TypeError(
                    `ranked-draft raw line ${lineNumber} is not JSON: ${error instanceof Error ? error.message : error}`,
                );
            }
            const record = parseRankedPair(parsed, lineNumber);
            if (pairIds.has(record.pair) || record.pair >= summary.rankedCohort.pairs) {
                throw new TypeError(
                    `ranked-draft raw line ${lineNumber} has duplicate or out-of-range pair ${record.pair}`,
                );
            }
            pairIds.add(record.pair);
            mapPairs.set(record.map, (mapPairs.get(record.map) ?? 0) + 1);
            collector.add(record);
        }
    } catch (error) {
        compressed.destroy();
        gunzip.destroy();
        throw error;
    }
    if (pairIds.size !== summary.rankedCohort.pairs) {
        throw new TypeError(`ranked-draft raw has ${pairIds.size}/${summary.rankedCohort.pairs} pairs`);
    }
    for (const map of AI_META_MAPS) {
        const expectedPairs = summary.rankedCohort.mapGames[String(map)] / AI_META_GAMES_PER_MATCHUP;
        if (mapPairs.get(map) !== expectedPairs) {
            throw new TypeError(`ranked-draft raw map ${map} has ${mapPairs.get(map) ?? 0}/${expectedPairs} pairs`);
        }
    }
    const interactions = collector.analyze();
    if (
        interactions.scope.pairs !== summary.rankedCohort.pairs ||
        interactions.scope.games !== summary.rankedCohort.games ||
        interactions.scope.cohorts.length !== 1 ||
        interactions.scope.cohorts[0] !== "ranked-draft" ||
        interactions.scope.maps.join(",") !== AI_META_MAPS.join(",")
    ) {
        throw new Error("Ranked draft interaction extraction produced an inconsistent scope");
    }
    await publishJsonAtomically(outputPath, {
        generatedAt: summary.generatedAt,
        interactions,
    } satisfies IRankedDraftInteractionExtraction);
    return {
        outputPath,
        rawPath,
        pairs: summary.rankedCohort.pairs,
        games: summary.rankedCohort.games,
    };
}

const USAGE = "Usage: bun src/simulation/extract_ranked_draft_interactions.ts <ai-meta.summary.json> <output.json>";

async function cliMain(): Promise<void> {
    const [summaryPath, outputPath, ...extra] = process.argv.slice(2);
    if (!summaryPath || !outputPath || extra.length) throw new Error(USAGE);
    const result = await extractRankedDraftInteractions(summaryPath, outputPath);
    console.log(
        `Ranked draft interactions: ${result.games.toLocaleString()} fights, ${result.pairs.toLocaleString()} pairs -> ${result.outputPath}`,
    );
}

if (import.meta.main) {
    cliMain().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 2;
    });
}
