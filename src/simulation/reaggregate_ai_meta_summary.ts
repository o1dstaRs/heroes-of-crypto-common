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

import { PBTypes } from "../generated/protobuf/v1/types";
import {
    AI_META_COHORTS,
    AI_META_GAMES_PER_MATCHUP,
    AI_META_MAPS,
    AI_META_RECORDED_MAPS,
    AI_META_SCHEMA_VERSION,
    aiMetaSynergyDefinition,
    aiMetaSynergyLevel,
    type AiMetaCohort,
    type AiMetaRecordedMap,
    type IAiMetaArmy,
    type IAiMetaGameOutcome,
    type IAiMetaPairRecord,
} from "./ai_meta_cohorts_core";
import {
    AiMetaAggregation,
    captureAiMetaSourceIdentity,
    isAiMetaRecordedMap,
    type AiMetaMapDimension,
    type IAiMetaMetricRow,
    type IAiMetaRankings,
    type IAiMetaSummary,
    type ICohortQuality,
} from "./measure_ai_meta_cohorts";

type UnknownRecord = Record<string, unknown>;

export interface IReaggregateAiMetaResult {
    outputPath: string;
    pairs: number;
    games: number;
    maps: AiMetaRecordedMap[];
    cohorts: AiMetaCohort[];
}

const isRecord = (value: unknown): value is UnknownRecord =>
    !!value && typeof value === "object" && !Array.isArray(value);

const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

function requiredInteger(record: UnknownRecord, key: string, context: string): number {
    const value = record[key];
    if (!safeInteger(value) || value < 0) throw new Error(`${context}.${key} must be a non-negative safe integer`);
    return value;
}

function sameNumberRecord(left: Record<string, number>, right: Record<string, number>): boolean {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => (left[key] ?? 0) === (right[key] ?? 0));
}

function parseDeclaredMaps(provenance: UnknownRecord): AiMetaRecordedMap[] {
    const maps = provenance.maps;
    if (!Array.isArray(maps) || !maps.length) throw new Error("Summary provenance.maps must list the run maps");
    const parsed: AiMetaRecordedMap[] = [];
    for (const map of maps) {
        if (!safeInteger(map) || !isAiMetaRecordedMap(map)) {
            throw new Error(`Summary contains unknown map id ${String(map)}`);
        }
        if (parsed.includes(map)) throw new Error(`Summary contains duplicate map id ${map}`);
        parsed.push(map);
    }
    const normalized = [...parsed].sort((left, right) => left - right);
    const live = [...AI_META_MAPS].sort((left, right) => left - right);
    const historical = [...AI_META_RECORDED_MAPS].sort((left, right) => left - right);
    const isKnownSet = [live, historical].some(
        (known) => known.length === normalized.length && known.every((map, index) => map === normalized[index]),
    );
    if (!isKnownSet) {
        throw new Error(
            `Summary maps must be the live set (${live.join(",")}) or historical set (${historical.join(",")})`,
        );
    }
    return parsed;
}

function parseCohortQuality(value: unknown, index: number, declaredMaps: readonly AiMetaRecordedMap[]): ICohortQuality {
    if (!isRecord(value)) throw new Error(`Summary cohort ${index} must be an object`);
    const cohort = value.cohort;
    if (typeof cohort !== "string" || !AI_META_COHORTS.includes(cohort as AiMetaCohort)) {
        throw new Error(`Summary cohort ${index} has unknown id ${String(cohort)}`);
    }
    const pairs = requiredInteger(value, "pairs", `cohorts[${index}]`);
    const games = requiredInteger(value, "games", `cohorts[${index}]`);
    if (!pairs || games !== pairs * AI_META_GAMES_PER_MATCHUP) {
        throw new Error(`Summary cohort ${cohort} must contain exactly two games per pair`);
    }
    if (typeof value.rawPath !== "string" || !value.rawPath || basename(value.rawPath) !== value.rawPath) {
        throw new Error(`Summary cohort ${cohort} has an unsafe rawPath`);
    }
    if (!isRecord(value.mapGames)) throw new Error(`Summary cohort ${cohort} is missing mapGames`);
    const mapGames: Record<string, number> = {};
    for (const [key, count] of Object.entries(value.mapGames)) {
        const map = Number(key);
        if (!safeInteger(map) || !isAiMetaRecordedMap(map) || !declaredMaps.includes(map)) {
            throw new Error(`Summary cohort ${cohort} contains unexpected mapGames key ${key}`);
        }
        if (!safeInteger(count) || count <= 0 || count % AI_META_GAMES_PER_MATCHUP !== 0) {
            throw new Error(`Summary cohort ${cohort} has invalid game count for map ${key}`);
        }
        mapGames[key] = count;
    }
    for (const map of declaredMaps) {
        if (!(String(map) in mapGames)) throw new Error(`Summary cohort ${cohort} has no games for map ${map}`);
    }
    if (Object.values(mapGames).reduce((sum, count) => sum + count, 0) !== games) {
        throw new Error(`Summary cohort ${cohort} mapGames do not sum to games`);
    }
    for (const key of [
        "greenWins",
        "redWins",
        "draws",
        "armageddonDecided",
        "rejectedActions",
        "distinctRosterViolations",
        "overlappingCreatureViolations",
    ]) {
        requiredInteger(value, key, `cohorts[${index}]`);
    }
    if (!isRecord(value.endReasons)) throw new Error(`Summary cohort ${cohort} is missing endReasons`);
    for (const [reason, count] of Object.entries(value.endReasons)) {
        if (!reason || !safeInteger(count) || count < 0) {
            throw new Error(`Summary cohort ${cohort} has invalid endReasons`);
        }
    }
    return value as unknown as ICohortQuality;
}

function validateArmy(value: unknown, context: string): asserts value is IAiMetaArmy {
    if (!isRecord(value) || !Array.isArray(value.roster) || !value.roster.length) {
        throw new Error(`${context} is missing its roster`);
    }
    for (const [index, unit] of value.roster.entries()) {
        if (
            !isRecord(unit) ||
            typeof unit.creatureName !== "string" ||
            !unit.creatureName ||
            !safeInteger(unit.level)
        ) {
            throw new Error(`${context}.roster[${index}] is invalid`);
        }
    }
    if (!Array.isArray(value.creatureIds) || value.creatureIds.length !== value.roster.length) {
        throw new Error(`${context}.creatureIds must match its roster length`);
    }
    value.creatureIds.forEach((creatureId, index) => {
        if (!safeInteger(creatureId) || creatureId <= 0) {
            throw new Error(`${context}.creatureIds[${index}] is invalid`);
        }
    });
    if (!Array.isArray(value.synergies)) throw new Error(`${context}.synergies must be an array`);
    const synergyFactions = new Set<number>();
    value.synergies.forEach((choice, index) => {
        if (
            !isRecord(choice) ||
            !safeInteger(choice.faction) ||
            !safeInteger(choice.synergy) ||
            !aiMetaSynergyDefinition(choice.faction, choice.synergy)
        ) {
            throw new Error(`${context}.synergies[${index}] is invalid`);
        }
        if (synergyFactions.has(choice.faction)) {
            throw new Error(`${context}.synergies contains duplicate faction ${choice.faction}`);
        }
        synergyFactions.add(choice.faction);
        if (!aiMetaSynergyLevel(value.creatureIds as number[], choice.faction)) {
            throw new Error(`${context}.synergies[${index}] is inactive for its roster`);
        }
    });
    for (const tier of ["artifactT1", "artifactT2"] as const) {
        const artifact = value[tier];
        if (
            !isRecord(artifact) ||
            !safeInteger(artifact.id) ||
            (artifact.mode !== "exploit" && artifact.mode !== "explore")
        ) {
            throw new Error(`${context}.${tier} is invalid`);
        }
    }
    const augment = value.augment;
    if (
        !isRecord(augment) ||
        typeof augment.planId !== "string" ||
        !augment.planId ||
        (augment.mode !== "exploit" && augment.mode !== "explore") ||
        !isRecord(augment.plan)
    ) {
        throw new Error(`${context}.augment is invalid`);
    }
    for (const key of ["placement", "armor", "might", "sniper", "movement"]) {
        if (!safeInteger(augment.plan[key])) throw new Error(`${context}.augment.plan.${key} is invalid`);
    }
}

function validateOutcome(value: unknown, context: string): asserts value is IAiMetaGameOutcome {
    if (!isRecord(value)) throw new Error(`${context} must be an object`);
    if (value.winner !== "a" && value.winner !== "b" && value.winner !== "draw") {
        throw new Error(`${context}.winner is invalid`);
    }
    if (typeof value.aIsGreen !== "boolean" || typeof value.armageddonDecided !== "boolean") {
        throw new Error(`${context} has invalid boolean fields`);
    }
    if (value.endReason !== "elimination" && value.endReason !== "turn_cap" && value.endReason !== "stuck") {
        throw new Error(`${context}.endReason is invalid`);
    }
    for (const key of ["laps", "rejectedA", "rejectedB", "hpA", "hpB", "survivorsA", "survivorsB"]) {
        if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
            throw new Error(`${context}.${key} must be finite`);
        }
    }
}

function parsePairRecord(
    value: unknown,
    cohort: AiMetaCohort,
    declaredMaps: readonly AiMetaRecordedMap[],
    context: string,
): IAiMetaPairRecord {
    if (!isRecord(value)) throw new Error(`${context} must be an object`);
    if (value.schemaVersion !== AI_META_SCHEMA_VERSION) throw new Error(`${context} has an incompatible schemaVersion`);
    if (value.cohort !== cohort) throw new Error(`${context} belongs to cohort ${String(value.cohort)}, not ${cohort}`);
    if (!safeInteger(value.pair) || value.pair < 0) throw new Error(`${context}.pair is invalid`);
    if (!safeInteger(value.map) || !isAiMetaRecordedMap(value.map) || !declaredMaps.includes(value.map)) {
        throw new Error(`${context}.map is not declared by the summary`);
    }
    validateArmy(value.armyA, `${context}.armyA`);
    validateArmy(value.armyB, `${context}.armyB`);
    if (!Array.isArray(value.games) || value.games.length !== AI_META_GAMES_PER_MATCHUP) {
        throw new Error(`${context}.games must contain the seat-swapped pair`);
    }
    value.games.forEach((game, index) => validateOutcome(game, `${context}.games[${index}]`));
    return value as unknown as IAiMetaPairRecord;
}

function assertQualityMatchesRaw(
    quality: ICohortQuality,
    accumulator: NonNullable<ReturnType<AiMetaAggregation["get"]>>,
): void {
    for (const key of [
        "pairs",
        "games",
        "greenWins",
        "redWins",
        "draws",
        "armageddonDecided",
        "rejectedActions",
        "distinctRosterViolations",
        "overlappingCreatureViolations",
    ] as const) {
        if (quality[key] !== accumulator[key]) {
            throw new Error(`Raw ${quality.cohort} ${key}=${accumulator[key]} does not match summary ${quality[key]}`);
        }
    }
    if (!sameNumberRecord(quality.mapGames, accumulator.mapGames)) {
        throw new Error(`Raw ${quality.cohort} mapGames do not match the summary`);
    }
    if (!sameNumberRecord(quality.endReasons, accumulator.endReasons)) {
        throw new Error(`Raw ${quality.cohort} endReasons do not match the summary`);
    }
}

const RANKING_KEYS = ["units", "artifactsT1", "artifactsT2", "augmentPlans", "augmentLevels", "synergies"] as const;

function equivalentRankingValue(left: unknown, right: unknown): boolean {
    if (typeof left === "number" && typeof right === "number") {
        return (
            Number.isFinite(left) &&
            Number.isFinite(right) &&
            Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left))
        );
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

/** Keep the run's historical all-map rows exactly, after verifying that raw reaggregation reproduces them. */
function preserveAllMapRankings(source: UnknownRecord, computed: IAiMetaRankings): IAiMetaRankings {
    if (!isRecord(source.rankings)) throw new Error("Summary is missing rankings");
    const preserved = {} as IAiMetaRankings;
    for (const category of RANKING_KEYS) {
        const values = source.rankings[category];
        if (!Array.isArray(values)) {
            // Pair schema v1 already carried exact synergy choices. Older v1 summaries did not aggregate
            // them, so enrich those summaries directly from raw records while preserving every existing row.
            if (category === "synergies") {
                preserved.synergies = computed.synergies;
                continue;
            }
            throw new Error(`Summary rankings.${category} must be an array`);
        }
        const sourceRows = values.filter(
            (value) => isRecord(value) && (value.map === undefined || value.map === "all"),
        );
        const sourceById = new Map<string, UnknownRecord>();
        for (const value of sourceRows) {
            const row = value as UnknownRecord;
            if (typeof row.cohort !== "string" || typeof row.key !== "string") {
                throw new Error(`Summary rankings.${category} contains an invalid all-map row`);
            }
            const id = `${row.cohort}\u0000${row.key}`;
            if (sourceById.has(id))
                throw new Error(`Summary rankings.${category} contains duplicate ${row.cohort}/${row.key}`);
            sourceById.set(id, row);
        }
        const computedAllRows = computed[category].filter((row) => row.map === "all");
        if (sourceById.size !== computedAllRows.length) {
            throw new Error(
                `Summary rankings.${category} has ${sourceById.size} all-map rows; raw data produced ${computedAllRows.length}`,
            );
        }
        const replacement = new Map<string, IAiMetaMetricRow>();
        for (const row of computedAllRows) {
            const id = `${row.cohort}\u0000${row.key}`;
            const historical = sourceById.get(id);
            if (!historical) throw new Error(`Summary rankings.${category} is missing ${row.cohort}/${row.key}`);
            for (const [key, expected] of Object.entries(row)) {
                if (key === "map") continue;
                if (!equivalentRankingValue(historical[key], expected)) {
                    throw new Error(
                        `Summary rankings.${category} ${row.cohort}/${row.key}.${key} differs from raw data`,
                    );
                }
            }
            replacement.set(id, { ...historical, map: "all" } as unknown as IAiMetaMetricRow);
        }
        preserved[category] = computed[category].map((row) =>
            row.map === "all" ? replacement.get(`${row.cohort}\u0000${row.key}`)! : row,
        );
    }
    return preserved;
}

async function readRawCohort(
    summaryDirectory: string,
    quality: ICohortQuality,
    declaredMaps: readonly AiMetaRecordedMap[],
    aggregation: AiMetaAggregation,
): Promise<void> {
    const rawPath = resolve(summaryDirectory, quality.rawPath);
    const relativePath = relative(summaryDirectory, rawPath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
        throw new Error(`Unsafe raw path for ${quality.cohort}: ${quality.rawPath}`);
    }
    if (!existsSync(rawPath) || !statSync(rawPath).isFile()) throw new Error(`Missing raw file ${rawPath}`);
    const realDirectory = realpathSync(summaryDirectory);
    const realRawPath = realpathSync(rawPath);
    const realRelativePath = relative(realDirectory, realRawPath);
    if (!realRelativePath || realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
        throw new Error(`Raw file for ${quality.cohort} resolves outside the summary directory`);
    }

    const pairs = new Set<number>();
    const mapPairs = new Map<AiMetaRecordedMap, number>();
    const compressed = createReadStream(realRawPath);
    const gunzip = createGunzip();
    compressed.pipe(gunzip);
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (!line.trim()) throw new Error(`${quality.rawPath}:${lineNumber} is blank`);
            let parsed: unknown;
            try {
                parsed = JSON.parse(line) as unknown;
            } catch (error) {
                throw new Error(
                    `${quality.rawPath}:${lineNumber} is not JSON: ${error instanceof Error ? error.message : error}`,
                );
            }
            const record = parsePairRecord(
                parsed,
                quality.cohort as AiMetaCohort,
                declaredMaps,
                `${quality.rawPath}:${lineNumber}`,
            );
            if (record.pair >= quality.pairs || pairs.has(record.pair)) {
                throw new Error(`${quality.rawPath}:${lineNumber} has duplicate or out-of-range pair ${record.pair}`);
            }
            pairs.add(record.pair);
            mapPairs.set(record.map, (mapPairs.get(record.map) ?? 0) + 1);
            aggregation.add(record);
        }
    } catch (error) {
        compressed.destroy();
        gunzip.destroy();
        throw error;
    }
    if (pairs.size !== quality.pairs) {
        throw new Error(`${quality.rawPath} contains ${pairs.size} pairs; expected ${quality.pairs}`);
    }
    for (const map of declaredMaps) {
        const expected = quality.mapGames[String(map)] / AI_META_GAMES_PER_MATCHUP;
        if ((mapPairs.get(map) ?? 0) !== expected) {
            throw new Error(
                `${quality.rawPath} map ${map} contains ${mapPairs.get(map) ?? 0} pairs; expected ${expected}`,
            );
        }
    }
}

const defaultOutputPath = (summaryPath: string): string =>
    summaryPath.endsWith(".summary.json")
        ? `${summaryPath.slice(0, -".summary.json".length)}.maps.summary.json`
        : `${summaryPath.replace(/\.json$/i, "")}.maps.json`;

function publishJsonAtomically(outputPath: string, value: unknown): void {
    if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing output ${outputPath}`);
    mkdirSync(dirname(outputPath), { recursive: true });
    const temporaryPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
        // A same-directory hard link publishes without the overwrite race of rename(2).
        linkSync(temporaryPath, outputPath);
    } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
}

export async function reaggregateAiMetaSummary(
    summaryArgument: string,
    outputArgument?: string,
): Promise<IReaggregateAiMetaResult> {
    const summaryPath = realpathSync(resolve(summaryArgument));
    const outputPath = resolve(outputArgument ?? defaultOutputPath(summaryPath));
    if (outputPath === summaryPath) throw new Error("The enriched summary must not replace the original summary");
    if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing output ${outputPath}`);

    const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Summary root must be an object");
    if (parsed.schemaVersion !== AI_META_SCHEMA_VERSION) throw new Error("Summary schemaVersion is incompatible");
    if (parsed.complete !== true) throw new Error("Only a complete AI meta summary can be reaggregated");
    if (!isRecord(parsed.provenance)) throw new Error("Summary is missing provenance");
    if (!Array.isArray(parsed.cohorts) || !parsed.cohorts.length) throw new Error("Summary has no cohorts");
    const aggregationToolIdentity = captureAiMetaSourceIdentity();

    const declaredMaps = parseDeclaredMaps(parsed.provenance);
    const qualities = parsed.cohorts.map((quality, index) => parseCohortQuality(quality, index, declaredMaps));
    const cohorts = qualities.map((quality) => quality.cohort as AiMetaCohort);
    if (new Set(cohorts).size !== cohorts.length) throw new Error("Summary contains duplicate cohorts");
    if (Array.isArray(parsed.provenance.requestedCohorts)) {
        const requested = parsed.provenance.requestedCohorts;
        if (requested.length !== cohorts.length || requested.some((cohort, index) => cohort !== cohorts[index])) {
            throw new Error("Summary cohorts do not match provenance.requestedCohorts");
        }
    }

    const aggregation = new AiMetaAggregation();
    const summaryDirectory = dirname(summaryPath);
    for (const quality of qualities) {
        await readRawCohort(summaryDirectory, quality, declaredMaps, aggregation);
        const accumulator = aggregation.get(quality.cohort, "all");
        if (!accumulator) throw new Error(`No aggregate was produced for ${quality.cohort}`);
        assertQualityMatchesRaw(quality, accumulator);
    }

    const dimensions: AiMetaMapDimension[] = ["all", "live", ...declaredMaps];
    for (const cohort of ["all", ...cohorts]) {
        for (const map of dimensions) {
            const accumulator = aggregation.get(cohort, map);
            if (!accumulator || !accumulator.pairs) {
                throw new Error(`Missing ${cohort}/${map} aggregate after reading raw records`);
            }
        }
    }
    const pooled = aggregation.get("all", "all")!;
    const expectedPairs = qualities.reduce((sum, quality) => sum + quality.pairs, 0);
    const expectedGames = qualities.reduce((sum, quality) => sum + quality.games, 0);
    if (pooled.pairs !== expectedPairs || pooled.games !== expectedGames) {
        throw new Error("Pooled raw totals do not match cohort summaries");
    }
    for (const [key, expected] of [
        ["totalPairs", expectedPairs],
        ["totalGames", expectedGames],
    ] as const) {
        const reported = parsed.provenance[key];
        if (reported !== undefined && reported !== expected) {
            throw new Error(`provenance.${key}=${String(reported)} does not match raw total ${expected}`);
        }
    }

    const computedRankings = aggregation.rows();
    const finalToolIdentity = captureAiMetaSourceIdentity();
    if (
        finalToolIdentity.commonCommit !== aggregationToolIdentity.commonCommit ||
        finalToolIdentity.sourceSha256 !== aggregationToolIdentity.sourceSha256
    ) {
        throw new Error("AI meta aggregation source changed while raw records were being read");
    }
    const enriched: IAiMetaSummary = {
        ...(parsed as unknown as IAiMetaSummary),
        provenance: {
            ...parsed.provenance,
            mapAggregation: {
                generatedAt: new Date().toISOString(),
                sourceSummary: basename(summaryPath),
                liveMaps: [...AI_META_MAPS],
                recordedMaps: [...declaredMaps],
                defaultDimension: "live",
                waterNonLive: declaredMaps.includes(PBTypes.GridVals.WATER_CENTER),
                tool: {
                    entrypoint: "src/simulation/reaggregate_ai_meta_summary.ts",
                    ...aggregationToolIdentity,
                },
            },
        },
        rankings: preserveAllMapRankings(parsed, computedRankings),
    };
    publishJsonAtomically(outputPath, enriched);
    return { outputPath, pairs: expectedPairs, games: expectedGames, maps: declaredMaps, cohorts };
}

const USAGE =
    "Usage: bun src/simulation/reaggregate_ai_meta_summary.ts <ai-meta.summary.json> [ai-meta.maps.summary.json]";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    if (argv[0] === "--help" || argv[0] === "-h") {
        console.log(USAGE);
        return;
    }
    if (!argv[0] || argv.length > 2) throw new Error(USAGE);
    const result = await reaggregateAiMetaSummary(argv[0], argv[1]);
    console.log(
        `AI meta maps: ${result.games.toLocaleString()} fights, ${result.cohorts.length} cohorts, ` +
            `${result.maps.length} recorded maps -> ${result.outputPath}`,
    );
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
