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

import { createHash } from "node:crypto";
import {
    closeSync,
    createReadStream,
    existsSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export const V07_COMPOSED_SEED_SCAN_POLICY =
    "structured_seed_ancestor_v8_component_safe_path_prefix_plus_repeated_bound_file_snapshot_and_protocol_typed_tournament_optimizer_census_and_league_expansion_plus_signed_historical_streaming_text_fallback" as const;

export interface IV07ComposedSeedScanOptions {
    cutoff: string;
    commonRoot: string;
    priorManifestExpanderPath: string;
    priorManifestExpanderSha256: string;
    roots: string[];
    rootDiscovery?: Array<{ parent: string; namePrefix: string }>;
    excluded: string[];
    /** Absolute generated-entry prefixes. The final path component must end in `_` or `-`. */
    excludedPathPrefixes?: string[];
    excludedRelativeSuffixes: string[];
    knownReserved?: number[];
    tournamentSeries?: IV07ComposedTournamentSeedSeries[];
    derivedTournamentSchedules?: IV07ComposedDerivedTournamentSchedule[];
    derivedProtocolSchedules?: IV07ComposedDerivedProtocolSchedule[];
    seedSetOutput?: string;
    summaryOutput?: string;
}

export interface IV07ComposedTournamentSeedSeries {
    id: string;
    baseSeed: number;
    streams: number;
    streamStride: number;
    gamesPerStream: number;
    pairSeedStep: number;
}

export interface IV07ComposedDerivedTournamentSchedule {
    id: string;
    sourceEvidence: IV07ComposedSeedSourceEvidence[];
    seed0s: number[];
    passes: number;
    generations: number;
    passStart: number;
    generationStart: number;
    passStep: number;
    generationStep: number;
    trainingGames: number;
    validation: { derivation: "offsets"; values: number[] } | { derivation: "xor"; values: [number] };
    validationGames: number;
}

export interface IV07ComposedSeedSourceEvidence {
    path: string;
    sha256: string;
}

interface IV07ComposedDerivedProtocolScheduleBase {
    id: string;
    baseSeeds: number[];
    sourceEvidence: IV07ComposedSeedSourceEvidence[];
}

export type IV07ComposedDerivedProtocolSchedule =
    | (IV07ComposedDerivedProtocolScheduleBase & {
          derivation: "paired_tournament_roots";
          gamesPerBase: number;
          rootStep: number;
      })
    | (IV07ComposedDerivedProtocolScheduleBase & {
          derivation: "unpaired_game_identity_xor";
          gamesPerBase: number;
          rootStep: number;
          xorMask: number;
      })
    | (IV07ComposedDerivedProtocolScheduleBase & {
          derivation: "unpaired_game_round1_census";
          gamesPerBase: number;
          rootStep: number;
          pickLabel: "round1-census-pick";
          battleLabel: "round1-census-battle";
      })
    | (IV07ComposedDerivedProtocolScheduleBase & {
          derivation: "league_offer_boards";
          boardsPerBase: number;
          rootStep: number;
          pickLabel: "league-pick";
          battleLabel: "league-battle";
          battleAssignments: [0, 1];
      });

export interface IV07ComposedSeedScanSummary {
    schemaVersion: 1;
    scanPolicy: typeof V07_COMPOSED_SEED_SCAN_POLICY;
    cutoff: string;
    commonRoot: string;
    priorManifestExpanderPath: string;
    priorManifestExpanderSha256: string;
    roots: string[];
    rootDiscovery: Array<{ parent: string; namePrefix: string }>;
    excluded: string[];
    excludedPathPrefixes: string[];
    excludedRelativeSuffixes: string[];
    files: number;
    textFiles: number;
    structuredFiles: number;
    expandedManifests: number;
    tournamentSeries: IV07ComposedTournamentSeedSeries[];
    derivedTournamentSchedules: IV07ComposedDerivedTournamentSchedule[];
    derivedTournamentSchedulesSha256: string;
    derivedProtocolSchedules: IV07ComposedDerivedProtocolSchedule[];
    derivedProtocolSchedulesSha256: string;
    derivedProtocolSeedSetSha256: string;
    expandedInlineTournamentPanels: number;
    expandedInlineLeaguePanels: number;
    expandedRecoveredLedgerStreams: number;
    expandedTournamentSeeds: number;
    expandedDerivedScheduleSeeds: number;
    expandedDerivedProtocolSeeds: number;
    expandedInlineLeagueSeeds: number;
    expandedRecoveredLedgerSeeds: number;
    matchedSeedTokens: number;
    uniqueSeeds: number;
    /** Eligible-file identity/metadata census; extracted seed contents are bound by corpusSeedSetSha256. */
    corpusFileSnapshotSha256: string;
    corpusSeedSetSha256: string;
    knownReservedChecks: Record<string, boolean>;
}

export interface IV07ComposedSeedScanResult {
    seeds: number[];
    canonicalSeedSet: string;
    summary: IV07ComposedSeedScanSummary;
    summarySha256: string;
}

type ExpandPriorManifest = (manifest: unknown) => number[];

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, entry]) => [key, canonicalValue(entry)]),
        );
    }
    return value;
}

export function fingerprintV07ComposedDerivedTournamentSchedules(
    schedules: readonly IV07ComposedDerivedTournamentSchedule[],
): string {
    return sha256(JSON.stringify(canonicalValue(schedules)));
}

export function fingerprintV07ComposedDerivedProtocolSchedules(
    schedules: readonly IV07ComposedDerivedProtocolSchedule[],
): string {
    return sha256(JSON.stringify(canonicalValue(schedules)));
}

export function fingerprintV07ComposedSeedSet(seeds: readonly number[]): string {
    const canonical = [...new Set(seeds)].sort((left, right) => left - right);
    return sha256(canonical.length ? `${canonical.join("\n")}\n` : "");
}

function hashSimulationPartsExact(...parts: readonly (string | number | boolean)[]): number {
    let hash = 0x811c9dc5;
    for (const part of parts) {
        const value = String(part);
        const framed = `${value.length}:${value}|`;
        for (let index = 0; index < framed.length; index += 1) {
            hash = Math.imul(hash ^ framed.charCodeAt(index), 0x01000193) >>> 0;
        }
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
    return (hash ^ (hash >>> 16)) >>> 0;
}

function leagueBoardSeeds(
    baseSeed: number,
    board: number,
    rootStep = 0x9e3779b1,
): [pairSeed: number, pickSeed: number, firstBattleSeed: number, secondBattleSeed: number] {
    const pairSeed = (baseSeed + Math.imul(board, rootStep)) >>> 0;
    return [
        pairSeed,
        hashSimulationPartsExact("league-pick", pairSeed),
        hashSimulationPartsExact("league-battle", pairSeed, 0),
        hashSimulationPartsExact("league-battle", pairSeed, 1),
    ];
}

function asUint32Token(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value >>> 0 : undefined;
    }
    if (typeof value !== "string" || !/^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(value)) return undefined;
    const parsed = value.toLowerCase().startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed >>> 0 : undefined;
}

function asHistoricalCorpusSeedToken(value: unknown): number | undefined {
    const unsigned = asUint32Token(value);
    if (unsigned !== undefined) return unsigned;
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= -0x80000000 && value < 0 ? value >>> 0 : undefined;
    }
    if (typeof value !== "string" || !/^-[0-9]{1,10}$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= -0x80000000 && parsed < 0 ? parsed >>> 0 : undefined;
}

function validateOptions(options: IV07ComposedSeedScanOptions): number {
    const cutoff = Date.parse(options.cutoff);
    if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString().replace(".000Z", "Z") !== options.cutoff) {
        throw new Error("Seed scan cutoff must be a canonical ISO-8601 instant");
    }
    if (!options.commonRoot.trim() || options.roots.length === 0 || options.roots.some((root) => !root.trim())) {
        throw new Error("Seed scan requires a common root and at least one corpus root");
    }
    if (
        !options.excludedRelativeSuffixes.length ||
        options.excludedRelativeSuffixes.some(
            (suffix) => !suffix.trim() || suffix.startsWith("/") || suffix.split("/").includes(".."),
        )
    ) {
        throw new Error("Seed scan requires nonempty repository-relative exclusion suffixes");
    }
    const excludedPathPrefixes = options.excludedPathPrefixes ?? [];
    if (
        new Set(excludedPathPrefixes).size !== excludedPathPrefixes.length ||
        excludedPathPrefixes.some(
            (prefix) =>
                !isAbsolute(prefix) ||
                resolve(prefix) !== prefix ||
                dirname(prefix) === prefix ||
                !/[._a-zA-Z0-9][_-]$/.test(basename(prefix)),
        )
    ) {
        throw new Error(
            "Seed-scan path prefixes must be unique absolute generated-entry prefixes ending in `_` or `-`",
        );
    }
    const expectedExpanderPath = resolve(options.commonRoot, "src/simulation/optimizer/v0_7_96h_core.ts");
    if (
        resolve(options.priorManifestExpanderPath) !== expectedExpanderPath ||
        !/^[0-9a-f]{64}$/.test(options.priorManifestExpanderSha256) ||
        !existsSync(expectedExpanderPath) ||
        sha256(readFileSync(expectedExpanderPath)) !== options.priorManifestExpanderSha256
    ) {
        throw new Error("Prior-manifest expander path or SHA-256 does not match the declared common root");
    }
    for (const seed of options.knownReserved ?? []) {
        if (asUint32Token(seed) === undefined) throw new Error(`Known reservation ${seed} is not a uint32`);
    }
    expandV07ComposedTournamentSeedSeries(options.tournamentSeries ?? []);
    expandV07ComposedDerivedTournamentSchedules(options.derivedTournamentSchedules ?? []);
    const derivedTournamentSchedules = options.derivedTournamentSchedules ?? [];
    const derivedProtocolSchedules = options.derivedProtocolSchedules ?? [];
    expandV07ComposedDerivedProtocolSchedules(derivedProtocolSchedules);
    for (const schedule of [...derivedTournamentSchedules, ...derivedProtocolSchedules]) {
        for (const source of schedule.sourceEvidence) {
            const path = resolve(source.path);
            if (!existsSync(path)) throw new Error(`${schedule.id}: source evidence does not exist: ${path}`);
            if (sha256(readFileSync(path)) !== source.sha256) {
                throw new Error(`${schedule.id}: source evidence hash mismatch: ${path}`);
            }
        }
    }
    return cutoff;
}

/** Expand exact non-tournament protocols whose reports do not persist every derived seed. */
export function expandV07ComposedDerivedProtocolSchedules(
    schedules: readonly IV07ComposedDerivedProtocolSchedule[],
): number[] {
    const seeds = new Set<number>();
    const ids = new Set<string>();
    for (const schedule of schedules) {
        const id = schedule.id;
        if (!id.trim() || ids.has(id)) {
            throw new Error("Derived protocol schedule ids must be nonempty and unique");
        }
        ids.add(id);
        if (
            !schedule.baseSeeds.length ||
            schedule.baseSeeds.some((seed) => asUint32Token(seed) === undefined) ||
            new Set(schedule.baseSeeds).size !== schedule.baseSeeds.length
        ) {
            throw new Error(`${id}: baseSeeds must contain unique uint32 values`);
        }
        if (
            !schedule.sourceEvidence.length ||
            schedule.sourceEvidence.some((source) => !source.path.trim() || !/^[0-9a-f]{64}$/.test(source.sha256)) ||
            new Set(schedule.sourceEvidence.map((source) => source.path)).size !== schedule.sourceEvidence.length
        ) {
            throw new Error(`${id}: sourceEvidence must contain unique paths and SHA-256 hashes`);
        }
        if (asUint32Token(schedule.rootStep) === undefined || schedule.rootStep === 0) {
            throw new Error(`${id}: rootStep must be a nonzero uint32`);
        }

        if (schedule.derivation === "league_offer_boards") {
            if (!Number.isSafeInteger(schedule.boardsPerBase) || schedule.boardsPerBase < 1) {
                throw new Error(`${id}: boardsPerBase must be a positive integer`);
            }
            if (
                schedule.pickLabel !== "league-pick" ||
                schedule.battleLabel !== "league-battle" ||
                JSON.stringify(schedule.battleAssignments) !== "[0,1]"
            ) {
                throw new Error(`${id}: league derivation discriminators are not exact`);
            }
            for (const baseSeed of schedule.baseSeeds) {
                for (let board = 0; board < schedule.boardsPerBase; board += 1) {
                    for (const seed of leagueBoardSeeds(baseSeed, board, schedule.rootStep)) seeds.add(seed);
                }
            }
            continue;
        }

        if (!Number.isSafeInteger(schedule.gamesPerBase) || schedule.gamesPerBase < 1) {
            throw new Error(`${id}: gamesPerBase must be a positive integer`);
        }
        if (schedule.derivation === "paired_tournament_roots") {
            if (schedule.gamesPerBase < 2 || schedule.gamesPerBase % 2 !== 0) {
                throw new Error(`${id}: paired tournament gamesPerBase must be even and at least two`);
            }
            for (const baseSeed of schedule.baseSeeds) {
                for (let pair = 0; pair < schedule.gamesPerBase / 2; pair += 1) {
                    seeds.add((baseSeed + Math.imul(pair, schedule.rootStep)) >>> 0);
                }
            }
            continue;
        }
        if (schedule.derivation === "unpaired_game_identity_xor" && asUint32Token(schedule.xorMask) === undefined) {
            throw new Error(`${id}: xorMask must be uint32`);
        }
        if (
            schedule.derivation === "unpaired_game_round1_census" &&
            (schedule.pickLabel !== "round1-census-pick" || schedule.battleLabel !== "round1-census-battle")
        ) {
            throw new Error(`${id}: round1 census derivation discriminators are not exact`);
        }
        for (const baseSeed of schedule.baseSeeds) {
            for (let game = 0; game < schedule.gamesPerBase; game += 1) {
                const root = (baseSeed + Math.imul(game, schedule.rootStep)) >>> 0;
                seeds.add(root);
                if (schedule.derivation === "unpaired_game_identity_xor") {
                    seeds.add((root ^ schedule.xorMask) >>> 0);
                } else {
                    seeds.add(hashSimulationPartsExact(schedule.pickLabel, root));
                    seeds.add(hashSimulationPartsExact(schedule.battleLabel, root));
                }
            }
        }
    }
    return [...seeds].sort((left, right) => left - right);
}

/** Expand compact optimizer schedules whose individual tournament directories may have been deleted. */
export function expandV07ComposedDerivedTournamentSchedules(
    schedules: readonly IV07ComposedDerivedTournamentSchedule[],
): number[] {
    const seeds = new Set<number>();
    const ids = new Set<string>();
    const addStream = (baseSeed: number, games: number): void => {
        for (let pair = 0; pair < games / 2; pair += 1) {
            seeds.add((baseSeed + Math.imul(pair, 0x9e3779b1)) >>> 0);
        }
    };
    for (const schedule of schedules) {
        if (!schedule.id.trim() || ids.has(schedule.id)) {
            throw new Error("Derived tournament schedule ids must be nonempty and unique");
        }
        ids.add(schedule.id);
        if (
            !schedule.sourceEvidence.length ||
            schedule.sourceEvidence.some((source) => !source.path.trim() || !/^[0-9a-f]{64}$/.test(source.sha256)) ||
            new Set(schedule.sourceEvidence.map((source) => source.path)).size !== schedule.sourceEvidence.length
        ) {
            throw new Error(`${schedule.id}: sourceEvidence must contain unique paths and SHA-256 hashes`);
        }
        if (!schedule.seed0s.length || schedule.seed0s.some((seed) => asUint32Token(seed) === undefined)) {
            throw new Error(`${schedule.id}: seed0s must contain uint32 values`);
        }
        if (new Set(schedule.seed0s).size !== schedule.seed0s.length) {
            throw new Error(`${schedule.id}: seed0s must not contain duplicates`);
        }
        for (const [label, value] of [
            ["passes", schedule.passes],
            ["generations", schedule.generations],
        ] as const) {
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error(`${schedule.id}: ${label} must be a positive integer`);
            }
        }
        for (const [label, value] of [
            ["passStart", schedule.passStart],
            ["generationStart", schedule.generationStart],
        ] as const) {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error(`${schedule.id}: ${label} must be a nonnegative integer`);
            }
        }
        for (const [label, value] of [
            ["passStep", schedule.passStep],
            ["generationStep", schedule.generationStep],
        ] as const) {
            if (asUint32Token(value) === undefined) throw new Error(`${schedule.id}: ${label} must be uint32`);
        }
        for (const [label, games] of [
            ["trainingGames", schedule.trainingGames],
            ["validationGames", schedule.validationGames],
        ] as const) {
            if (!Number.isSafeInteger(games) || games < 2 || games % 2 !== 0) {
                throw new Error(`${schedule.id}: ${label} must be an even integer >= 2`);
            }
        }
        if (
            !["offsets", "xor"].includes(schedule.validation.derivation) ||
            !schedule.validation.values.length ||
            schedule.validation.values.some((value) => asUint32Token(value) === undefined) ||
            (schedule.validation.derivation === "xor" && schedule.validation.values.length !== 1)
        ) {
            throw new Error(`${schedule.id}: validation derivation is incomplete`);
        }
        for (const seed0 of schedule.seed0s) {
            for (let pass = 0; pass < schedule.passes; pass += 1) {
                for (let generation = 0; generation < schedule.generations; generation += 1) {
                    const baseSeed =
                        (seed0 +
                            Math.imul(schedule.passStart + pass, schedule.passStep) +
                            Math.imul(schedule.generationStart + generation, schedule.generationStep)) >>>
                        0;
                    addStream(baseSeed, schedule.trainingGames);
                }
            }
            for (const value of schedule.validation.values) {
                const baseSeed =
                    schedule.validation.derivation === "offsets" ? (seed0 + value) >>> 0 : (seed0 ^ value) >>> 0;
                addStream(baseSeed, schedule.validationGames);
            }
        }
    }
    return [...seeds].sort((left, right) => left - right);
}

/** Expand explicit observed tournament streams that cannot be recovered from an unpersisted stdout report. */
export function expandV07ComposedTournamentSeedSeries(series: readonly IV07ComposedTournamentSeedSeries[]): number[] {
    const seeds: number[] = [];
    const seen = new Map<number, string>();
    const ids = new Set<string>();
    for (const entry of series) {
        if (!entry.id.trim() || ids.has(entry.id)) {
            throw new Error("Tournament seed-series ids must be nonempty and unique");
        }
        ids.add(entry.id);
        if (asUint32Token(entry.baseSeed) === undefined || asUint32Token(entry.pairSeedStep) === undefined) {
            throw new Error(`${entry.id}: baseSeed and pairSeedStep must be uint32 values`);
        }
        if (!Number.isSafeInteger(entry.streams) || entry.streams < 1) {
            throw new Error(`${entry.id}: streams must be a positive integer`);
        }
        if (!Number.isSafeInteger(entry.streamStride) || entry.streamStride < 0) {
            throw new Error(`${entry.id}: streamStride must be a nonnegative integer`);
        }
        if (!Number.isSafeInteger(entry.gamesPerStream) || entry.gamesPerStream < 2 || entry.gamesPerStream % 2) {
            throw new Error(`${entry.id}: gamesPerStream must be an even integer >= 2`);
        }
        const lastBase = entry.baseSeed + (entry.streams - 1) * entry.streamStride;
        if (!Number.isSafeInteger(lastBase) || lastBase > 0xffffffff) {
            throw new Error(`${entry.id}: final stream base exceeds uint32`);
        }
        for (let stream = 0; stream < entry.streams; stream += 1) {
            const base = entry.baseSeed + stream * entry.streamStride;
            for (let pair = 0; pair < entry.gamesPerStream / 2; pair += 1) {
                const seed = (base + Math.imul(pair, entry.pairSeedStep)) >>> 0;
                const label = `${entry.id}/stream${stream}/pair${pair}`;
                const previous = seen.get(seed);
                if (previous) throw new Error(`Tournament seed-series collision: ${previous} and ${label}`);
                seen.set(seed, label);
                seeds.push(seed);
            }
        }
    }
    return seeds;
}

/**
 * Extract the exact prior-seed corpus used by the composed-ranked preregistration.
 * Directory mtimes never gate recursion; the cutoff applies only to regular files. Numeric strings and object
 * keys are accepted only beneath a seed-named ancestor, while the text fallback remains deliberately broad.
 */
export async function scanV07ComposedSeedCorpus(
    options: IV07ComposedSeedScanOptions,
): Promise<IV07ComposedSeedScanResult> {
    const cutoff = validateOptions(options);
    const commonRoot = resolve(options.commonRoot);
    const rootDiscovery = structuredClone(options.rootDiscovery ?? []);
    const discoverRoots = (): string[] =>
        rootDiscovery.flatMap(({ parent, namePrefix }) => {
            if (!parent.trim() || !namePrefix.trim()) {
                throw new Error("Seed-scan root discovery entries must be nonempty");
            }
            const absoluteParent = resolve(parent);
            if (!existsSync(absoluteParent) || !statSync(absoluteParent).isDirectory()) {
                throw new Error(`Seed-scan discovery parent does not exist or is not a directory: ${absoluteParent}`);
            }
            return readdirSync(absoluteParent)
                .filter((name) => name.startsWith(namePrefix))
                .sort()
                .map((name) => resolve(absoluteParent, name));
        });
    const discoveredRoots = discoverRoots();
    const roots = [...new Set([...options.roots.map((root) => resolve(root)), ...discoveredRoots])];
    const excluded = new Set(options.excluded.map((path) => resolve(path)));
    const excludedPathPrefixes = [...(options.excludedPathPrefixes ?? [])].sort();
    const excludedRelativeSuffixes = [...new Set(options.excludedRelativeSuffixes)].sort();
    const hasExcludedPathPrefix = (absolute: string): boolean =>
        excludedPathPrefixes.some((prefix) => {
            const candidate = relative(dirname(prefix), absolute);
            if (!candidate || isAbsolute(candidate) || candidate === ".." || candidate.startsWith(`..${sep}`)) {
                return false;
            }
            return candidate.split(/[\\/]/, 1)[0]!.startsWith(basename(prefix));
        });
    type CorpusFileSnapshot = {
        path: string;
        dev: number;
        ino: number;
        size: number;
        mtimeMs: number;
        ctimeMs: number;
    };
    const fileSnapshots = new Map<string, CorpusFileSnapshot>();
    const isMissingRace = (error: unknown): boolean =>
        error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    const walk = (path: string, required = false, destination = fileSnapshots): void => {
        if (!existsSync(path)) {
            if (required) throw new Error(`Required seed-scan root does not exist: ${resolve(path)}`);
            return;
        }
        const absolute = resolve(path);
        if (excluded.has(absolute)) return;
        if (hasExcludedPathPrefix(absolute)) return;
        if (excludedRelativeSuffixes.some((suffix) => absolute.endsWith(`/${suffix}`))) return;
        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(absolute);
        } catch (error) {
            if (isMissingRace(error) && !required) return;
            throw error;
        }
        if (stat.isDirectory()) {
            let entries: string[];
            try {
                entries = readdirSync(absolute);
            } catch (error) {
                if (isMissingRace(error) && !required) return;
                throw error;
            }
            for (const entry of entries) walk(resolve(absolute, entry), false, destination);
        } else if (stat.isFile() && stat.mtimeMs <= cutoff) {
            const snapshot = {
                path: absolute,
                dev: stat.dev,
                ino: stat.ino,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
            };
            const previous = destination.get(absolute);
            if (previous && JSON.stringify(previous) !== JSON.stringify(snapshot)) {
                throw new Error(`Corpus file changed during the bound census: ${absolute}`);
            }
            destination.set(absolute, snapshot);
        }
    };
    for (const root of roots) walk(root, true);
    const files = [...fileSnapshots.keys()].sort();
    const fileSnapshotRecords = files.map((path) => fileSnapshots.get(path)!);
    const corpusFileSnapshotSha256 = sha256(`${JSON.stringify(fileSnapshotRecords)}\n`);

    const corePath = resolve(commonRoot, "src/simulation/optimizer/v0_7_96h_core.ts");
    const core = (await import(pathToFileURL(corePath).href)) as {
        expandV0796hPriorSeedManifest: ExpandPriorManifest;
    };
    if (typeof core.expandV0796hPriorSeedManifest !== "function") {
        throw new Error(`Prior-seed expander is missing from ${corePath}`);
    }

    const values = new Set<number>();
    let occurrences = 0;
    let textFiles = 0;
    let structuredFiles = 0;
    let expandedManifests = 0;
    let expandedInlineTournamentPanels = 0;
    let expandedInlineTournamentSeeds = 0;
    let expandedInlineLeaguePanels = 0;
    let expandedInlineLeagueSeeds = 0;
    let expandedRecoveredLedgerStreams = 0;
    let expandedRecoveredLedgerSeeds = 0;
    const add = (value: unknown): void => {
        const parsed = asHistoricalCorpusSeedToken(value);
        if (parsed === undefined) return;
        occurrences += 1;
        values.add(parsed);
    };
    const seedKey = (key: string): boolean => /seed/i.test(key);
    const visit = (value: unknown, inheritedSeedContext = false): void => {
        if (typeof value === "number" || typeof value === "string") {
            if (inheritedSeedContext) add(value);
            return;
        }
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const entry of value) visit(entry, inheritedSeedContext);
            return;
        }
        for (const [key, entry] of Object.entries(value)) {
            if (inheritedSeedContext) add(key);
            visit(entry, inheritedSeedContext || seedKey(key));
        }
    };
    const expand = (value: unknown): void => {
        const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
        const recognized =
            record !== undefined &&
            (record.seedSeries !== undefined ||
                record.panels !== undefined ||
                (record.gamesPerCell !== undefined && record.cells !== undefined) ||
                record.headline !== undefined ||
                record.cohorts !== undefined);
        try {
            const seeds = core.expandV0796hPriorSeedManifest(value);
            if (seeds.length === 0) return;
            expandedManifests += 1;
            for (const seed of seeds) add(seed);
        } catch (error) {
            if (recognized) {
                throw new Error("Recognized prior-seed manifest failed authoritative expansion", { cause: error });
            }
            // Unsupported structured files remain covered by seed-ancestor traversal and the text fallback.
        }
    };
    const expandInlineTournamentPanels = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const entry of value) expandInlineTournamentPanels(entry);
            return;
        }
        const record = value as Record<string, unknown>;
        const baseSeed = asHistoricalCorpusSeedToken(record.baseSeed);
        const directGames = record.games;
        const gamesPerArm = record.gamesPerArm;
        const declaredPairSeeds = record.pairSeeds;
        const compactArmShape = directGames === undefined && declaredPairSeeds !== undefined;
        const compactArmPanel =
            compactArmShape &&
            typeof gamesPerArm === "number" &&
            typeof declaredPairSeeds === "number" &&
            Number.isSafeInteger(declaredPairSeeds) &&
            declaredPairSeeds >= 1;
        const games = compactArmPanel ? gamesPerArm : directGames;
        const configuredStep = record.pairSeedStep;
        const pairSeedStep = configuredStep === undefined ? 0x9e3779b1 : asUint32Token(configuredStep);
        if (
            compactArmShape &&
            (baseSeed === undefined ||
                !compactArmPanel ||
                !Number.isSafeInteger(gamesPerArm) ||
                gamesPerArm < 1 ||
                declaredPairSeeds !== Math.ceil(gamesPerArm / 2))
        ) {
            throw new Error("Compact gamesPerArm panel has an inconsistent pairSeeds declaration");
        }
        if (configuredStep !== undefined && pairSeedStep === undefined && baseSeed !== undefined) {
            throw new Error("Inline tournament panel has a non-uint32 pairSeedStep");
        }
        if (
            baseSeed !== undefined &&
            typeof games === "number" &&
            Number.isSafeInteger(games) &&
            games >= 1 &&
            (compactArmPanel || (games >= 2 && games % 2 === 0)) &&
            pairSeedStep !== undefined
        ) {
            const pairs = compactArmPanel ? (declaredPairSeeds as number) : games / 2;
            expandedInlineTournamentPanels += 1;
            expandedInlineTournamentSeeds += pairs;
            for (let pair = 0; pair < pairs; pair += 1) {
                add((baseSeed + Math.imul(pair, pairSeedStep)) >>> 0);
            }
        }
        if (Array.isArray(record.cells) && gamesPerArm !== undefined) {
            if (
                typeof gamesPerArm !== "number" ||
                !Number.isSafeInteger(gamesPerArm) ||
                gamesPerArm < 2 ||
                gamesPerArm % 2 !== 0 ||
                pairSeedStep === undefined
            ) {
                throw new Error("Compact gamesPerArm cell panel is incomplete");
            }
            const cellBaseSeeds = record.cells
                .map((cell) =>
                    cell !== null && typeof cell === "object"
                        ? asHistoricalCorpusSeedToken((cell as Record<string, unknown>).baseSeed)
                        : undefined,
                )
                .filter((seed): seed is number => seed !== undefined);
            if (cellBaseSeeds.length !== record.cells.length || new Set(cellBaseSeeds).size !== cellBaseSeeds.length) {
                throw new Error("Compact gamesPerArm cell panel must contain unique uint32 base seeds");
            }
            for (const cellBaseSeed of new Set(cellBaseSeeds)) {
                expandedInlineTournamentPanels += 1;
                expandedInlineTournamentSeeds += gamesPerArm / 2;
                for (let pair = 0; pair < gamesPerArm / 2; pair += 1) {
                    add((cellBaseSeed + Math.imul(pair, pairSeedStep)) >>> 0);
                }
            }
        }
        for (const entry of Object.values(record)) expandInlineTournamentPanels(entry);
    };
    const expandInlineLeaguePanels = (value: unknown, recoveredLedgerContext = false): void => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const entry of value) expandInlineLeaguePanels(entry, recoveredLedgerContext);
            return;
        }
        const record = value as Record<string, unknown>;
        if (
            recoveredLedgerContext &&
            (record.streamCount !== undefined || record.streams !== undefined) &&
            (!Number.isSafeInteger(record.streamCount) ||
                !Array.isArray(record.streams) ||
                record.streamCount !== record.streams.length)
        ) {
            throw new Error("Recovered ledger streamCount must exactly match its streams array");
        }
        const explicitBaseSeed = asHistoricalCorpusSeedToken(record.baseSeed ?? record.seed ?? record.heldOutSeed);
        const gamesPerOpponent = record.gamesPerOpponent;
        const gamesPerOpponentPerSeed = record.gamesPerOpponentPerSeed;
        const expandLeague = (baseSeed: number, boards: number): void => {
            expandedInlineLeaguePanels += 1;
            expandedInlineLeagueSeeds += boards * 4;
            for (let board = 0; board < boards; board += 1) {
                for (const seed of leagueBoardSeeds(baseSeed, board)) add(seed);
            }
        };
        if (
            gamesPerOpponent !== undefined &&
            (record.baseSeed !== undefined || record.seed !== undefined || record.heldOutSeed !== undefined) &&
            (explicitBaseSeed === undefined ||
                typeof gamesPerOpponent !== "number" ||
                !Number.isSafeInteger(gamesPerOpponent) ||
                gamesPerOpponent < 4 ||
                gamesPerOpponent % 4 !== 0)
        ) {
            throw new Error("Inline league panel must declare a uint32 seed and gamesPerOpponent divisible by four");
        }
        if (
            typeof gamesPerOpponent === "number" &&
            Number.isSafeInteger(gamesPerOpponent) &&
            gamesPerOpponent >= 4 &&
            gamesPerOpponent % 4 === 0
        ) {
            if (explicitBaseSeed !== undefined) expandLeague(explicitBaseSeed, gamesPerOpponent / 4);
        }
        if (gamesPerOpponentPerSeed !== undefined) {
            const declaredSeedArrays = [record.seeds, record.baseSeeds].filter((value) => value !== undefined);
            const baseSeedValues = declaredSeedArrays[0];
            if (
                declaredSeedArrays.length !== 1 ||
                !Array.isArray(baseSeedValues) ||
                baseSeedValues.length < 1 ||
                typeof gamesPerOpponentPerSeed !== "number" ||
                !Number.isSafeInteger(gamesPerOpponentPerSeed) ||
                gamesPerOpponentPerSeed < 4 ||
                gamesPerOpponentPerSeed % 4 !== 0
            ) {
                throw new Error("Inline multi-seed league panel is incomplete");
            }
            const baseSeeds = baseSeedValues.map(asHistoricalCorpusSeedToken);
            if (
                !baseSeeds.every((seed): seed is number => seed !== undefined) ||
                new Set(baseSeeds).size !== baseSeeds.length
            ) {
                throw new Error("Inline multi-seed league panel must contain unique uint32 seeds");
            }
            for (const baseSeed of baseSeeds) expandLeague(baseSeed, gamesPerOpponentPerSeed / 4);
        }
        const recoveredBoards = record.boards;
        if (
            recoveredLedgerContext &&
            (recoveredBoards !== undefined || record.family !== undefined) &&
            (explicitBaseSeed === undefined ||
                typeof recoveredBoards !== "number" ||
                !Number.isSafeInteger(recoveredBoards) ||
                recoveredBoards < 1 ||
                !["powered-league", "legacy-cem-draft"].includes(String(record.family)))
        ) {
            throw new Error(
                "Recovered ledger stream must declare an exact supported family, uint32 baseSeed, and boards",
            );
        }
        if (
            recoveredLedgerContext &&
            explicitBaseSeed !== undefined &&
            typeof recoveredBoards === "number" &&
            Number.isSafeInteger(recoveredBoards) &&
            recoveredBoards >= 1
        ) {
            expandedRecoveredLedgerStreams += 1;
            const poweredLeague = record.family === "powered-league";
            expandedRecoveredLedgerSeeds += recoveredBoards * (poweredLeague ? 4 : 1);
            for (let board = 0; board < recoveredBoards; board += 1) {
                const seeds = leagueBoardSeeds(explicitBaseSeed, board);
                add(seeds[0]);
                if (poweredLeague) {
                    add(seeds[1]);
                    add(seeds[2]);
                    add(seeds[3]);
                }
            }
        }
        for (const [key, entry] of Object.entries(record)) {
            expandInlineLeaguePanels(entry, recoveredLedgerContext || key === "recoveredLedger");
        }
    };
    const expandStructuredValue = (value: unknown, label: string): void => {
        try {
            visit(value);
            expand(value);
            expandInlineTournamentPanels(value);
            expandInlineLeaguePanels(value);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Structured seed expansion failed for ${label}: ${detail}`, { cause: error });
        }
    };
    const textPattern =
        /(?:base[_-]?seed|seed|scenarioRoot|setupSeed|combatSeed|pairSeeds?)[^0-9a-fA-F-]{0,16}(0x[0-9a-fA-F]{1,8}|-?[0-9]{1,10})(?![0-9A-Za-z_])/gi;
    const numericTokenPattern = /(?<![\w-])(?:-?[0-9]{1,10}|0x[0-9a-fA-F]{1,8})\b/g;
    const maxStreamLineCharacters = 64 * 1024 * 1024;
    const textBoundaryCharacters = 128;
    const binarySample = Buffer.allocUnsafe(8192);
    const isBinaryCorpusFile = (path: string, size: number): boolean => {
        const descriptor = openSync(path, "r");
        try {
            const sampled = readSync(descriptor, binarySample, 0, Math.min(size, binarySample.length), 0);
            return binarySample.subarray(0, sampled).includes(0);
        } finally {
            closeSync(descriptor);
        }
    };
    const streamLines = async function* (path: string): AsyncGenerator<string> {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
            pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            let newline = pending.indexOf("\n");
            while (newline >= 0) {
                yield pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                newline = pending.indexOf("\n");
            }
            if (pending.length > maxStreamLineCharacters) {
                throw new Error(`Corpus text line exceeds ${maxStreamLineCharacters} characters: ${path}`);
            }
        }
        pending += decoder.end();
        if (pending.length > maxStreamLineCharacters) {
            throw new Error(`Corpus text line exceeds ${maxStreamLineCharacters} characters: ${path}`);
        }
        if (pending) yield pending;
    };
    const scanTextMatches = (text: string, scanAllNumbers: boolean): void => {
        for (const match of text.matchAll(textPattern)) add(match[1]);
        if (scanAllNumbers) {
            for (const match of text.matchAll(numericTokenPattern)) add(match[0]);
        }
    };
    const scanStreamedText = async (path: string, onLine?: (line: string) => void): Promise<void> => {
        const scanAllNumbers = /seed/i.test(basename(path)) || path.includes("/manifests/");
        let previousTail = "";
        for await (const line of streamLines(path)) {
            onLine?.(line);
            scanTextMatches(line, scanAllNumbers);
            if (previousTail) {
                const boundary = `${previousTail}\n${line.slice(0, textBoundaryCharacters)}`;
                const boundaryIndex = previousTail.length;
                for (const match of boundary.matchAll(textPattern)) {
                    const start = match.index;
                    const end = start + match[0].length;
                    if (start < boundaryIndex && end > boundaryIndex + 1) add(match[1]);
                }
            }
            previousTail = `${previousTail}\n${line}`.slice(-textBoundaryCharacters);
        }
    };

    for (const path of files) {
        const expected = fileSnapshots.get(path)!;
        const assertUnchanged = (): void => {
            const observed = statSync(path);
            if (
                !observed.isFile() ||
                observed.dev !== expected.dev ||
                observed.ino !== expected.ino ||
                observed.size !== expected.size ||
                observed.mtimeMs !== expected.mtimeMs ||
                observed.ctimeMs !== expected.ctimeMs
            ) {
                throw new Error(`Corpus file changed after the bound snapshot: ${path}`);
            }
        };
        assertUnchanged();
        if (expected.size > 2 * 1024 * 1024 * 1024) throw new Error(`Refusing oversized corpus file ${path}`);
        if (isBinaryCorpusFile(path, expected.size)) {
            assertUnchanged();
            continue;
        }
        const extension = extname(path).toLowerCase();
        if (extension === ".json") {
            const text = readFileSync(path, "utf8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                // Malformed or in-progress JSON is still covered by the text fallback below.
            }
            if (parsed !== undefined) {
                structuredFiles += 1;
                expandStructuredValue(parsed, path);
            }
            scanTextMatches(text, /seed/i.test(basename(path)) || path.includes("/manifests/"));
        } else if (extension === ".jsonl") {
            let parsedAny = false;
            let lineNumber = 0;
            await scanStreamedText(path, (line) => {
                lineNumber += 1;
                if (!line.trim()) return;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    // In-progress trailing rows are still covered by the text fallback below.
                }
                if (parsed !== undefined) {
                    expandStructuredValue(parsed, `${path}:${lineNumber}`);
                    parsedAny = true;
                }
            });
            structuredFiles += Number(parsedAny);
        } else {
            await scanStreamedText(path);
        }
        assertUnchanged();
        textFiles += 1;
    }

    const finalRoots = [...new Set([...options.roots.map((root) => resolve(root)), ...discoverRoots()])];
    if (JSON.stringify(finalRoots) !== JSON.stringify(roots)) {
        throw new Error("Seed-scan discovered root set changed during the bound census");
    }
    const finalFileSnapshots = new Map<string, CorpusFileSnapshot>();
    for (const root of finalRoots) walk(root, true, finalFileSnapshots);
    const finalFileSnapshotRecords = [...finalFileSnapshots.keys()].sort().map((path) => finalFileSnapshots.get(path)!);
    if (JSON.stringify(finalFileSnapshotRecords) !== JSON.stringify(fileSnapshotRecords)) {
        throw new Error("Eligible seed-corpus file set changed during the bound census");
    }

    const tournamentSeries = structuredClone(options.tournamentSeries ?? []);
    const tournamentSeeds = expandV07ComposedTournamentSeedSeries(tournamentSeries);
    for (const seed of tournamentSeeds) add(seed);
    const derivedTournamentSchedules = structuredClone(options.derivedTournamentSchedules ?? []);
    const derivedScheduleSeeds = expandV07ComposedDerivedTournamentSchedules(derivedTournamentSchedules);
    for (const seed of derivedScheduleSeeds) add(seed);
    const derivedProtocolSchedules = structuredClone(options.derivedProtocolSchedules ?? []);
    const derivedProtocolSeeds = expandV07ComposedDerivedProtocolSchedules(derivedProtocolSchedules);
    for (const seed of derivedProtocolSeeds) add(seed);

    const seeds = [...values].sort((left, right) => left - right);
    const canonicalSeedSet = seeds.length ? `${seeds.join("\n")}\n` : "";
    const summary: IV07ComposedSeedScanSummary = {
        schemaVersion: 1,
        scanPolicy: V07_COMPOSED_SEED_SCAN_POLICY,
        cutoff: options.cutoff,
        commonRoot,
        priorManifestExpanderPath: corePath,
        priorManifestExpanderSha256: sha256(readFileSync(corePath)),
        roots,
        rootDiscovery,
        excluded: [...excluded].sort(),
        excludedPathPrefixes,
        excludedRelativeSuffixes,
        files: files.length,
        textFiles,
        structuredFiles,
        expandedManifests,
        tournamentSeries,
        derivedTournamentSchedules,
        derivedTournamentSchedulesSha256: fingerprintV07ComposedDerivedTournamentSchedules(derivedTournamentSchedules),
        derivedProtocolSchedules,
        derivedProtocolSchedulesSha256: fingerprintV07ComposedDerivedProtocolSchedules(derivedProtocolSchedules),
        derivedProtocolSeedSetSha256: fingerprintV07ComposedSeedSet(derivedProtocolSeeds),
        expandedInlineTournamentPanels,
        expandedInlineLeaguePanels,
        expandedRecoveredLedgerStreams,
        expandedTournamentSeeds: tournamentSeeds.length + expandedInlineTournamentSeeds,
        expandedDerivedScheduleSeeds: derivedScheduleSeeds.length,
        expandedDerivedProtocolSeeds: derivedProtocolSeeds.length,
        expandedInlineLeagueSeeds,
        expandedRecoveredLedgerSeeds,
        matchedSeedTokens: occurrences,
        uniqueSeeds: seeds.length,
        corpusFileSnapshotSha256,
        corpusSeedSetSha256: sha256(canonicalSeedSet),
        knownReservedChecks: Object.fromEntries(
            (options.knownReserved ?? []).map((seed) => [String(seed), values.has(seed >>> 0)]),
        ),
    };
    const summaryBytes = `${JSON.stringify(summary, null, 2)}\n`;
    if (options.seedSetOutput) writeFileSync(resolve(options.seedSetOutput), canonicalSeedSet);
    if (options.summaryOutput) writeFileSync(resolve(options.summaryOutput), summaryBytes);
    return { seeds, canonicalSeedSet, summary, summarySha256: sha256(summaryBytes) };
}

if (import.meta.main) {
    const optionsPath = process.argv[2];
    if (!optionsPath || process.argv.length !== 3) {
        throw new Error("Usage: bun src/simulation/v0_7_composed_seed_scan.ts <options.json>");
    }
    const options = JSON.parse(readFileSync(resolve(optionsPath), "utf8")) as IV07ComposedSeedScanOptions;
    const result = await scanV07ComposedSeedCorpus(options);
    process.stdout.write(`${JSON.stringify({ ...result.summary, summarySha256: result.summarySha256 }, null, 2)}\n`);
}
