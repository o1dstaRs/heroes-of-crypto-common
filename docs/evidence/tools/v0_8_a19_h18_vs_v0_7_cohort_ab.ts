#!/usr/bin/env bun

/**
 * External, source-sealed v0.8+A19/H18 versus unsearched v0.7 strength harness.
 *
 * The single allowed run is exactly 10,080 fights: seven preregistered AI-meta
 * cohorts, 360 matchup clusters per cohort, and four crossover games per cluster.
 * Candidate roster A and roster B each fight from green and red against the opposite
 * v0.7 roster. Every cohort has exactly 120 clusters on each live map.
 *
 * This file lives outside src/ and adds no production experiment seam. A19 is installed
 * only through buildV08A19H18SearchEnvironment; SEARCH_VERSIONS remains v0.8, so the
 * v0.7 anchor is deliberately unsearched.
 *
 * No-fight checks:
 *   bun docs/evidence/tools/v0_8_a19_h18_vs_v0_7_cohort_ab.ts --self-test --source-root CLEAN_COMMON
 *   bun docs/evidence/tools/v0_8_a19_h18_vs_v0_7_cohort_ab.ts --preflight --source-root CLEAN_COMMON
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker, parentPort } from "node:worker_threads";

import type { IMatchConfig, IMatchResult, Side } from "../../../src/simulation/battle_engine";
import type { AiMetaCohort, IAiMetaArmy } from "../../../src/simulation/ai_meta_cohorts_core";

const SCHEMA = "hoc.v0_8_a19_h18_vs_v0_7_cohort_ab.v1" as const;
const CLUSTERS_PER_COHORT = 360 as const;
const CLUSTERS_PER_COHORT_MAP = 120 as const;
const GAMES_PER_CLUSTER = 4 as const;
const TOTAL_CLUSTERS = 2_520 as const;
const TOTAL_GAMES = 10_080 as const;
const CANDIDATE_VERSION = "v0.8" as const;
const ANCHOR_VERSION = "v0.7" as const;
const EXPECTED_HORIZON = 18 as const;
const EXPECTED_SHORTLIST = 3 as const;
const EXPECTED_COMMON_COMMIT = "57db6cd884c173dc77c18de4ac4cfe898170463c" as const;
const EXPECTED_COMMON_TREE = "013e059443dc3590d3afd3474155ac50348c666e" as const;
const RAW_FILE = "a19-h18-vs-v0-7-cohort-ab.records.jsonl";
const SUMMARY_FILE = "a19-h18-vs-v0-7-cohort-ab.summary.json";
const STARTED_FILE = "a19-h18-vs-v0-7-cohort-ab.started.json";
const RUN_SEED_LABEL = "hoc.a19-h18-v0.7.ten-k-seed.v1";
const RUN_SEED = 2_026_080_301;
const RUN_SEED_COMMITMENT = "11c23942a77472efce8592db9ebc7585fe2d9178c357e278a4375d778cb5060a";

const AI_META_COHORTS = [
    "ranked-draft",
    "uniform-mixed",
    "ranged-heavy",
    "ground-melee",
    "flyer-heavy",
    "caster-support",
    "cross-archetype",
] as const satisfies readonly AiMetaCohort[];
const AI_META_MAPS = [1, 3, 4] as const;
const AI_META_COHORT_DESCRIPTIONS: Readonly<Record<AiMetaCohort, string>> = Object.freeze({
    "ranked-draft": "Tracked live ranked-pick reducer and shipped draft policy.",
    "uniform-mixed": "Level-balanced armies sampled uniformly from draftable creatures.",
    "ranged-heavy": "Each army fields two to four ranged stacks.",
    "ground-melee": "Each army fields no ranged stacks and at least four ground-melee stacks.",
    "flyer-heavy": "Each army fields at least two flying stacks.",
    "caster-support": "Each army fields at least two magic or melee-magic stacks.",
    "cross-archetype": "Balanced ordered ranged, melee, flyer, and caster matchups.",
});

type CandidateRoster = "a" | "b";

interface IOptions {
    concurrency: 6 | 12;
    maxLaps: 60;
    output: string;
    sourceRoot: string;
    expectedSourceSha256: string;
}

interface ITask {
    cohort: AiMetaCohort;
    pair: number;
}

interface IGameRecord {
    assignment: 0 | 1;
    candidateRoster: CandidateRoster;
    candidateSide: Side;
    candidateVersion: typeof CANDIDATE_VERSION;
    anchorVersion: typeof ANCHOR_VERSION;
    winner: Side | "draw";
    candidateResult: "win" | "loss" | "draw";
    candidateScore: number;
    laps: number;
    endReason: IMatchResult["endReason"];
    rejectedCandidate: number;
    rejectedAnchor: number;
    candidateHpMargin: number;
    candidateSurvivorMargin: number;
    totalActions: number;
    elapsedMs: number;
    candidateRosterSignature: string;
    anchorRosterSignature: string;
    setupFingerprint: string;
}

interface IClusterRecord {
    schema: typeof SCHEMA;
    cohort: AiMetaCohort;
    pair: number;
    setupSeed: number;
    combatSeed: number;
    map: number;
    games: [IGameRecord, IGameRecord, IGameRecord, IGameRecord];
}

interface IMetricRow {
    key: string;
    clusters: number;
    games: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
    decisiveWinRate: number;
    drawAwareScoreRate: number;
    standardErrorPp: number | null;
    ciLowPp: number;
    ciHighPp: number;
}

interface ISourceSeal {
    commonRoot: string;
    gitCommit: string;
    gitHeadTree: string;
    gitDirty: boolean;
    gitStatusSha256: string;
    sourceSha256: string;
    files: number;
    bytes: number;
    a19ProfileSha256: string;
    a13ProfileSha256: string;
    searchDriverSha256: string;
    battleEngineSha256: string;
    cohortGeneratorSha256: string;
    packageSha256: string;
    lockSha256: string | null;
    runnerSha256: string;
}

interface IEnvironmentSeal {
    profileSchema: string;
    candidateId: string;
    researchOnly: boolean;
    horizon: number;
    shortlist: number;
    rollouts: number;
    searchVersions: string;
    a19GenomeSha256: string;
    a19BehaviorEnvironmentSha256: string;
    a13GenomeSha256: string;
    a19EnvironmentSha256: string;
    changedFromA13: { key: string; a19: string | null; a13: string | null }[];
    runSeedCommitment: string;
}

interface ISourceRuntime {
    a13Profile: typeof import("../../../src/ai/versions/v0_8_a13_profile");
    a19Profile: typeof import("../../../src/ai/versions/v0_8_a19_h18_profile");
    army: typeof import("../../../src/simulation/army");
    battle: typeof import("../../../src/simulation/battle_engine");
    cohorts: typeof import("../../../src/simulation/ai_meta_cohorts_core");
    search: typeof import("../../../src/simulation/v0_8_a13_search");
}

interface IWorkerReady {
    type: "ready";
    environment: IEnvironmentSeal;
    workerBehaviorEnvironmentSha256: string;
}

type WorkerResponse = IWorkerReady | { type: "result"; record: IClusterRecord } | { type: "error"; error: string };

type WorkerRequest = { type: "cluster"; task: ITask } | { type: "stop" };

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_SOURCE_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const stableEntries = (value: Readonly<Record<string, string | undefined>>): [string, string | null][] =>
    Object.entries(value)
        .map(([key, item]) => [key, item ?? null] as [string, string | null])
        .sort(([left], [right]) => left.localeCompare(right));

const environmentSha256 = (value: Readonly<Record<string, string | undefined>>): string =>
    sha256(JSON.stringify(stableEntries(value)));

async function loadSourceRuntime(sourceRoot: string): Promise<ISourceRuntime> {
    const source = (path: string): string => pathToFileURL(join(sourceRoot, "src", path)).href;
    const [a13Profile, a19Profile, army, battle, cohorts, search] = await Promise.all([
        import(source("ai/versions/v0_8_a13_profile.ts")),
        import(source("ai/versions/v0_8_a19_h18_profile.ts")),
        import(source("simulation/army.ts")),
        import(source("simulation/battle_engine.ts")),
        import(source("simulation/ai_meta_cohorts_core.ts")),
        import(source("simulation/v0_8_a13_search.ts")),
    ]);
    return { a13Profile, a19Profile, army, battle, cohorts, search } as ISourceRuntime;
}

const candidateProfileEnvironment = (runtime: ISourceRuntime): Readonly<Record<string, string | undefined>> =>
    runtime.a19Profile.buildV08A19H18SearchEnvironment(CANDIDATE_VERSION);

function profileDelta(runtime: ISourceRuntime): { key: string; a19: string | null; a13: string | null }[] {
    const a19 = new Map(stableEntries(candidateProfileEnvironment(runtime)));
    const a13 = new Map(stableEntries(runtime.a13Profile.buildV08A13SearchEnvironment(CANDIDATE_VERSION)));
    return [...new Set([...a19.keys(), ...a13.keys()])].sort().flatMap((key) => {
        const a19Value = a19.get(key) ?? null;
        const a13Value = a13.get(key) ?? null;
        return a19Value === a13Value ? [] : [{ key, a19: a19Value, a13: a13Value }];
    });
}

function runSeedCommitment(seed: number): string {
    return sha256(`${RUN_SEED_LABEL}\0${seed}`);
}

function assertEnvironmentContract(runtime: ISourceRuntime): IEnvironmentSeal {
    const candidateEnvironment = candidateProfileEnvironment(runtime);
    const delta = profileDelta(runtime);
    const sourceCohorts = [...runtime.cohorts.AI_META_COHORTS];
    const sourceMaps = [...runtime.cohorts.AI_META_MAPS];
    if (JSON.stringify(sourceCohorts) !== JSON.stringify(AI_META_COHORTS)) {
        throw new Error(`Source cohort catalog differs from the harness contract: ${JSON.stringify(sourceCohorts)}`);
    }
    if (JSON.stringify(sourceMaps) !== JSON.stringify(AI_META_MAPS)) {
        throw new Error(`Source live-map catalog differs from the harness contract: ${JSON.stringify(sourceMaps)}`);
    }
    if (runtime.a19Profile.V08_A19_H18_PROFILE.researchOnly !== true) {
        throw new Error("A19/H18 must remain explicitly research-only");
    }
    if (runtime.a19Profile.V08_A19_H18_SEARCH.horizon !== EXPECTED_HORIZON) {
        throw new Error(`A19/H18 horizon must be ${EXPECTED_HORIZON}`);
    }
    if (runtime.a19Profile.V08_A19_H18_SEARCH.shortlist !== EXPECTED_SHORTLIST) {
        throw new Error(`A19/H18 shortlist must be ${EXPECTED_SHORTLIST}`);
    }
    if (candidateEnvironment.V07_SEARCH !== "1") {
        throw new Error("A19/H18 must explicitly enable the SearchDriver");
    }
    if (candidateEnvironment.SEARCH_VERSIONS !== CANDIDATE_VERSION) {
        throw new Error(`SEARCH_VERSIONS must contain only ${CANDIDATE_VERSION}; v0.7 must remain unsearched`);
    }
    if (candidateEnvironment.SEARCH_HORIZON !== String(EXPECTED_HORIZON)) {
        throw new Error("A19/H18 environment does not bind horizon 18");
    }
    if (candidateEnvironment.SEARCH_SHORTLIST !== String(EXPECTED_SHORTLIST)) {
        throw new Error("A19/H18 environment does not bind the production shortlist");
    }
    if (
        delta.length !== 1 ||
        delta[0].key !== "SEARCH_HORIZON" ||
        delta[0].a19 !== String(EXPECTED_HORIZON) ||
        delta[0].a13 !== String(runtime.a13Profile.V08_A13_SEARCH.horizon)
    ) {
        throw new Error(`A19 escaped its single horizon delta from A13: ${JSON.stringify(delta)}`);
    }
    if (runSeedCommitment(RUN_SEED) !== RUN_SEED_COMMITMENT) {
        throw new Error("Embedded run seed does not match its preregistered commitment");
    }
    return {
        profileSchema: runtime.a19Profile.V08_A19_H18_PROFILE_SCHEMA,
        candidateId: runtime.a19Profile.V08_A19_H18_CANDIDATE_ID,
        researchOnly: runtime.a19Profile.V08_A19_H18_PROFILE.researchOnly,
        horizon: runtime.a19Profile.V08_A19_H18_SEARCH.horizon,
        shortlist: runtime.a19Profile.V08_A19_H18_SEARCH.shortlist,
        rollouts: runtime.a19Profile.V08_A19_H18_SEARCH.rollouts,
        searchVersions: candidateEnvironment.SEARCH_VERSIONS,
        a19GenomeSha256: runtime.a19Profile.V08_A19_H18_GENOME_SHA256,
        a19BehaviorEnvironmentSha256: runtime.a19Profile.V08_A19_H18_BEHAVIOR_ENVIRONMENT_SHA256,
        a13GenomeSha256: runtime.a13Profile.V08_A13_GENOME_SHA256,
        a19EnvironmentSha256: environmentSha256(candidateEnvironment),
        changedFromA13: delta,
        runSeedCommitment: RUN_SEED_COMMITMENT,
    };
}

function positiveInteger(raw: string | undefined, label: string, fallback: number): number {
    const value = Number(raw ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
}

function parseOptions(argv: readonly string[]): IOptions {
    const { values } = parseArgs({
        args: [...argv],
        options: {
            concurrency: { type: "string" },
            "max-laps": { type: "string" },
            output: { type: "string" },
            "source-root": { type: "string" },
            "expected-source-sha256": { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    const concurrency = positiveInteger(values.concurrency, "concurrency", 6);
    if (concurrency !== 6 && concurrency !== 12) throw new Error("concurrency must be 6 or 12");
    const maxLaps = positiveInteger(values["max-laps"], "max-laps", 60);
    if (maxLaps !== 60) throw new Error("the sealed 10,080-fight run requires max-laps 60");
    if (!values.output) throw new Error("--output is required and must name a new directory");
    if (!values["source-root"]?.trim()) throw new Error("--source-root is required and must be a clean checkout");
    if (!values["expected-source-sha256"]?.trim()) {
        throw new Error("--expected-source-sha256 is required to bind the clean source checkout");
    }
    return {
        concurrency,
        maxLaps: maxLaps as 60,
        output: resolve(values.output),
        sourceRoot: resolve(values["source-root"]),
        expectedSourceSha256: values["expected-source-sha256"].trim(),
    };
}

function utilitySourceRoot(argv: readonly string[]): string {
    const index = argv.indexOf("--source-root");
    if (index < 0) return DEFAULT_SOURCE_ROOT;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--source-root requires a path");
    return resolve(value);
}

function listFiles(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name);
            const stat = statSync(path);
            if (stat.isDirectory()) visit(path);
            else if (stat.isFile()) files.push(path);
        }
    };
    visit(root);
    return files;
}

function fileSha256(path: string): string {
    return sha256(readFileSync(path));
}

function sourceSeal(sourceRoot: string): ISourceSeal {
    const sourceFiles = listFiles(join(sourceRoot, "src"));
    const supportFiles = ["package.json", "bun.lock", "bunfig.toml"]
        .map((name) => join(sourceRoot, name))
        .filter(existsSync);
    const files = [...sourceFiles, ...supportFiles].sort();
    const hash = createHash("sha256");
    let bytes = 0;
    for (const path of files) {
        const contents = readFileSync(path);
        const pathRelative = relative(sourceRoot, path);
        bytes += contents.byteLength;
        hash.update(String(Buffer.byteLength(pathRelative)));
        hash.update(":");
        hash.update(pathRelative);
        hash.update(":");
        hash.update(String(contents.byteLength));
        hash.update(":");
        hash.update(contents);
    }
    const git = (args: readonly string[]): string =>
        execFileSync("git", [...args], { cwd: sourceRoot, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--", "src", "package.json", "bun.lock"], {
        cwd: sourceRoot,
    });
    return {
        commonRoot: sourceRoot,
        gitCommit: git(["rev-parse", "HEAD"]),
        gitHeadTree: git(["rev-parse", "HEAD^{tree}"]),
        gitDirty: status.byteLength > 0,
        gitStatusSha256: sha256(status),
        sourceSha256: hash.digest("hex"),
        files: files.length,
        bytes,
        a19ProfileSha256: fileSha256(join(sourceRoot, "src/ai/versions/v0_8_a19_h18_profile.ts")),
        a13ProfileSha256: fileSha256(join(sourceRoot, "src/ai/versions/v0_8_a13_profile.ts")),
        searchDriverSha256: fileSha256(join(sourceRoot, "src/simulation/search_driver.ts")),
        battleEngineSha256: fileSha256(join(sourceRoot, "src/simulation/battle_engine.ts")),
        cohortGeneratorSha256: fileSha256(join(sourceRoot, "src/simulation/ai_meta_cohorts_core.ts")),
        packageSha256: fileSha256(join(sourceRoot, "package.json")),
        lockSha256: existsSync(join(sourceRoot, "bun.lock")) ? fileSha256(join(sourceRoot, "bun.lock")) : null,
        runnerSha256: fileSha256(SCRIPT_PATH),
    };
}

function assertCleanPushedSource(seal: ISourceSeal): void {
    if (seal.gitCommit !== EXPECTED_COMMON_COMMIT || seal.gitHeadTree !== EXPECTED_COMMON_TREE) {
        throw new Error(
            `Source must be pushed common ${EXPECTED_COMMON_COMMIT}/${EXPECTED_COMMON_TREE}; observed ${seal.gitCommit}/${seal.gitHeadTree}`,
        );
    }
    if (seal.gitDirty) throw new Error("--source-root must be clean for src, package.json, and bun.lock");
}

function workerEnvironment(sourceRoot: string): Record<string, string> {
    const environment: Record<string, string> = {
        NODE_ENV: "production",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        SIM_NO_ACTIONS: "1",
        LIVETWIN: "1",
        FIGHT_MELEE_ROSTERS: "0",
        HOC_A19_V07_SOURCE_ROOT: sourceRoot,
    };
    for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
    }
    return environment;
}

function behaviorEnvironment(): Record<string, string | undefined> {
    const prefixes = ["SEARCH_", "V04_", "V05_", "V06_", "V07_", "V08_", "V09_", "Q2_"];
    const exact = new Set(["NODE_ENV", "SIM_NO_ACTIONS", "LIVETWIN", "FIGHT_MELEE_ROSTERS", "HOC_A19_V07_SOURCE_ROOT"]);
    return Object.fromEntries(
        Object.entries(process.env)
            .filter(([key]) => exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix)))
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function setupFingerprint(candidate: IAiMetaArmy, anchor: IAiMetaArmy, map: number): string {
    return sha256(
        JSON.stringify({
            candidate: {
                roster: candidate.roster,
                perk: candidate.perk,
                t1: candidate.artifactT1.id,
                t2: candidate.artifactT2.id,
                augments: candidate.augment.augments,
                synergies: candidate.synergies,
            },
            anchor: {
                roster: anchor.roster,
                perk: anchor.perk,
                t1: anchor.artifactT1.id,
                t2: anchor.artifactT2.id,
                augments: anchor.augment.augments,
                synergies: anchor.synergies,
            },
            map,
        }),
    );
}

function configFor(
    green: IAiMetaArmy,
    red: IAiMetaArmy,
    greenVersion: string,
    redVersion: string,
    seed: number,
    map: number,
    maxLaps: number,
): IMatchConfig {
    return {
        greenVersion,
        redVersion,
        roster: green.roster,
        redRoster: red.roster,
        seed,
        gridType: map,
        maxLaps,
        headlessEvents: true,
        greenPerk: green.perk,
        redPerk: red.perk,
        greenAugments: green.augment.augments,
        redAugments: red.augment.augments,
        greenArtifactT1: green.artifactT1.id,
        redArtifactT1: red.artifactT1.id,
        greenArtifactT2: green.artifactT2.id,
        redArtifactT2: red.artifactT2.id,
        greenSynergies: green.synergies,
        redSynergies: red.synergies,
        placementAugmentTiming: "setup-before-placement",
    };
}

function playGame(
    runtime: ISourceRuntime,
    assignment: 0 | 1,
    candidateRoster: CandidateRoster,
    candidate: IAiMetaArmy,
    anchor: IAiMetaArmy,
    candidateSide: Side,
    combatSeed: number,
    map: number,
    maxLaps: number,
): IGameRecord {
    const candidateIsGreen = candidateSide === "green";
    const config = candidateIsGreen
        ? configFor(candidate, anchor, CANDIDATE_VERSION, ANCHOR_VERSION, combatSeed, map, maxLaps)
        : configFor(anchor, candidate, ANCHOR_VERSION, CANDIDATE_VERSION, combatSeed, map, maxLaps);
    const startedAt = performance.now();
    // The exact A19 profile scopes the complete match. Its SEARCH_VERSIONS=v0.8 means the
    // same SearchDriver ignores every v0.7 unit, keeping the anchor unsearched.
    const result = runtime.search.withScopedAIEnvironment(candidateProfileEnvironment(runtime), () =>
        runtime.battle.runMatch(config),
    );
    const elapsedMs = performance.now() - startedAt;
    const candidateResult = result.winner === "draw" ? "draw" : result.winner === candidateSide ? "win" : "loss";
    const own = candidateIsGreen ? result.outcome.green : result.outcome.red;
    const opposing = candidateIsGreen ? result.outcome.red : result.outcome.green;
    return {
        assignment,
        candidateRoster,
        candidateSide,
        candidateVersion: CANDIDATE_VERSION,
        anchorVersion: ANCHOR_VERSION,
        winner: result.winner,
        candidateResult,
        candidateScore: candidateResult === "win" ? 1 : candidateResult === "draw" ? 0.5 : 0,
        laps: result.laps,
        endReason: result.endReason,
        rejectedCandidate: candidateIsGreen ? (result.rejectedGreen ?? 0) : (result.rejectedRed ?? 0),
        rejectedAnchor: candidateIsGreen ? (result.rejectedRed ?? 0) : (result.rejectedGreen ?? 0),
        candidateHpMargin: own.hpRemaining - opposing.hpRemaining,
        candidateSurvivorMargin: own.unitsAlive - opposing.unitsAlive,
        totalActions: result.totalActions,
        elapsedMs,
        candidateRosterSignature: runtime.cohorts.rosterSignature(candidate.roster),
        anchorRosterSignature: runtime.cohorts.rosterSignature(anchor.roster),
        setupFingerprint: setupFingerprint(candidate, anchor, map),
    };
}

function playCluster(runtime: ISourceRuntime, task: ITask): IClusterRecord {
    const prepared = runtime.cohorts.prepareMetaPair(
        { cohort: task.cohort, games: task.pairs * 2, baseSeed: task.baseSeed },
        task.pair,
    );
    if (!runtime.cohorts.rostersAreStrictlyDistinct(prepared.armyA.roster, prepared.armyB.roster)) {
        throw new Error(`${task.cohort}:${task.pair} generated overlapping rosters`);
    }
    const armOrder: [Arm, Arm] =
        (task.pair + AI_META_COHORTS.indexOf(task.cohort)) % 2 === 0 ? ["s3", "s2"] : ["s2", "s3"];
    const cells = [
        {
            assignment: 0 as const,
            candidateRoster: "a" as const,
            candidate: prepared.armyA,
            anchor: prepared.armyB,
            side: "green" as const,
        },
        {
            assignment: 0 as const,
            candidateRoster: "a" as const,
            candidate: prepared.armyA,
            anchor: prepared.armyB,
            side: "red" as const,
        },
        {
            assignment: 1 as const,
            candidateRoster: "b" as const,
            candidate: prepared.armyB,
            anchor: prepared.armyA,
            side: "green" as const,
        },
        {
            assignment: 1 as const,
            candidateRoster: "b" as const,
            candidate: prepared.armyB,
            anchor: prepared.armyA,
            side: "red" as const,
        },
    ];
    const games: IGameRecord[] = [];
    for (const cell of cells) {
        for (const arm of armOrder) {
            games.push(
                playGame(
                    runtime,
                    arm,
                    cell.assignment,
                    cell.candidateRoster,
                    cell.candidate,
                    cell.anchor,
                    cell.side,
                    prepared.combatSeed,
                    prepared.map,
                    task.maxLaps,
                ),
            );
        }
    }
    return {
        schema: SCHEMA,
        cohort: task.cohort,
        pair: task.pair,
        setupSeed: prepared.setupSeed,
        combatSeed: prepared.combatSeed,
        map: prepared.map,
        armOrder,
        games: games as IClusterRecord["games"],
    };
}

function armGames(record: IClusterRecord, arm: Arm): IGameRecord[] {
    return record.games.filter((game) => game.arm === arm);
}

function armScore(record: IClusterRecord, arm: Arm): number {
    const games = armGames(record, arm);
    return games.reduce((sum, game) => sum + game.candidateScore, 0) / games.length;
}

function metricRow(key: string, records: readonly IClusterRecord[]): IMetricRow {
    const games = records.flatMap((record) => record.games);
    const s3Games = games.filter((game) => game.arm === "s3");
    const s2Games = games.filter((game) => game.arm === "s2");
    const effects = records.map((record) => armScore(record, "s3") - armScore(record, "s2"));
    const s3ScoreRate = s3Games.length
        ? s3Games.reduce((sum, game) => sum + game.candidateScore, 0) / s3Games.length
        : 0;
    const s2ScoreRate = s2Games.length
        ? s2Games.reduce((sum, game) => sum + game.candidateScore, 0) / s2Games.length
        : 0;
    const mean = effects.length ? effects.reduce((sum, effect) => sum + effect, 0) / effects.length : 0;
    const standardError =
        effects.length >= 2
            ? Math.sqrt(
                  effects.reduce((sum, effect) => sum + (effect - mean) ** 2, 0) /
                      (effects.length - 1) /
                      effects.length,
              )
            : null;
    const margin = standardError === null ? 1 : 1.959963984540054 * standardError;
    return {
        key,
        clusters: records.length,
        gamesPerArm: s3Games.length,
        s3Wins: s3Games.filter((game) => game.candidateResult === "win").length,
        s3Losses: s3Games.filter((game) => game.candidateResult === "loss").length,
        s3Draws: s3Games.filter((game) => game.candidateResult === "draw").length,
        s2Wins: s2Games.filter((game) => game.candidateResult === "win").length,
        s2Losses: s2Games.filter((game) => game.candidateResult === "loss").length,
        s2Draws: s2Games.filter((game) => game.candidateResult === "draw").length,
        s3ScoreRate,
        s2ScoreRate,
        liftPp: mean * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        ciLowPp: (mean - margin) * 100,
        ciHighPp: (mean + margin) * 100,
    };
}

function fixedStratifiedOverall(records: readonly IClusterRecord[]): IMetricRow {
    const strata = AI_META_COHORTS.flatMap((cohort) =>
        AI_META_MAPS.map((map) => records.filter((record) => record.cohort === cohort && record.map === map)),
    ).filter((stratum) => stratum.length > 0);
    if (!strata.length) return metricRow("overall", []);
    const stratumEffects = strata.map((stratum) => {
        const effects = stratum.map((record) => armScore(record, "s3") - armScore(record, "s2"));
        const mean = effects.reduce((sum, effect) => sum + effect, 0) / effects.length;
        const variance =
            effects.length >= 2
                ? effects.reduce((sum, effect) => sum + (effect - mean) ** 2, 0) / (effects.length - 1)
                : null;
        return { effects, mean, variance };
    });
    const base = metricRow("overall", records);
    const mean = stratumEffects.reduce((sum, stratum) => sum + stratum.mean, 0) / stratumEffects.length;
    const standardError = stratumEffects.every((stratum) => stratum.variance !== null)
        ? Math.sqrt(
              stratumEffects.reduce((sum, stratum) => sum + stratum.variance! / stratum.effects.length, 0) /
                  stratumEffects.length ** 2,
          )
        : null;
    const margin = standardError === null ? 1 : 1.959963984540054 * standardError;
    return {
        ...base,
        liftPp: mean * 100,
        standardErrorPp: standardError === null ? null : standardError * 100,
        ciLowPp: (mean - margin) * 100,
        ciHighPp: (mean + margin) * 100,
    };
}

function summarize(records: readonly IClusterRecord[]): {
    overall: IMetricRow;
    cohorts: IMetricRow[];
    maps: IMetricRow[];
    cohortMaps: IMetricRow[];
} {
    return {
        overall: fixedStratifiedOverall(records),
        cohorts: AI_META_COHORTS.map((cohort) =>
            metricRow(
                cohort,
                records.filter((record) => record.cohort === cohort),
            ),
        ),
        maps: AI_META_MAPS.map((map) =>
            metricRow(
                `map-${map}`,
                records.filter((record) => record.map === map),
            ),
        ),
        cohortMaps: AI_META_COHORTS.flatMap((cohort) =>
            AI_META_MAPS.map((map) =>
                metricRow(
                    `${cohort}:map-${map}`,
                    records.filter((record) => record.cohort === cohort && record.map === map),
                ),
            ),
        ),
    };
}

function validateRecords(
    runtime: ISourceRuntime,
    records: readonly IClusterRecord[],
    options: IOptions,
    sourceUnchanged: boolean,
): Record<string, unknown> {
    const expected = new Set(
        options.cohorts.flatMap((cohort) => Array.from({ length: options.pairs }, (_, pair) => `${cohort}:${pair}`)),
    );
    let malformedClusters = 0;
    let rejectedS3 = 0;
    let rejectedS2 = 0;
    let rejectedAnchor = 0;
    let stuckMatches = 0;
    let overlappingRosters = 0;
    for (const record of records) {
        const identity = `${record.cohort}:${record.pair}`;
        if (!expected.delete(identity)) malformedClusters += 1;
        const expectedSetupSeed = runtime.army.hashSimulationParts(
            "ai-meta-setup",
            options.baseSeed,
            record.cohort,
            record.pair,
        );
        const expectedCombatSeed = runtime.army.hashSimulationParts(
            "ai-meta-combat",
            options.baseSeed,
            record.cohort,
            record.pair,
        );
        const expectedArmOrder: [Arm, Arm] =
            (record.pair + AI_META_COHORTS.indexOf(record.cohort)) % 2 === 0 ? ["s3", "s2"] : ["s2", "s3"];
        if (
            record.schema !== SCHEMA ||
            record.map !== runtime.cohorts.cohortMap(record.cohort, record.pair) ||
            record.setupSeed !== expectedSetupSeed ||
            record.combatSeed !== expectedCombatSeed ||
            record.armOrder[0] !== expectedArmOrder[0] ||
            record.armOrder[1] !== expectedArmOrder[1] ||
            record.games.length !== GAMES_PER_CLUSTER ||
            armGames(record, "s3").length !== CLUSTER_SIZE_PER_ARM ||
            armGames(record, "s2").length !== CLUSTER_SIZE_PER_ARM
        ) {
            malformedClusters += 1;
            continue;
        }
        for (const arm of ["s3", "s2"] as const) {
            const armRecords = armGames(record, arm);
            const cells = new Set(armRecords.map((game) => `${game.assignment}:${game.candidateSide}`));
            if (cells.size !== CLUSTER_SIZE_PER_ARM) malformedClusters += 1;
            for (const game of armRecords) {
                const expectedResult =
                    game.winner === "draw" ? "draw" : game.winner === game.candidateSide ? "win" : "loss";
                const expectedScore = expectedResult === "win" ? 1 : expectedResult === "draw" ? 0.5 : 0;
                if (game.candidateResult !== expectedResult || game.candidateScore !== expectedScore) {
                    malformedClusters += 1;
                }
                if (game.candidateRoster !== (game.assignment === 0 ? "a" : "b")) malformedClusters += 1;
                const candidateNames = new Set(game.candidateRosterSignature.split("|").filter(Boolean));
                if (game.anchorRosterSignature.split("|").some((name) => candidateNames.has(name))) {
                    overlappingRosters += 1;
                }
                if (arm === "s3") rejectedS3 += game.rejectedCandidate;
                else rejectedS2 += game.rejectedCandidate;
                rejectedAnchor += game.rejectedAnchor;
                stuckMatches += Number(game.endReason === "stuck");
            }
        }
        for (const assignment of [0, 1] as const) {
            for (const side of ["green", "red"] as const) {
                const s3 = record.games.find(
                    (game) => game.arm === "s3" && game.assignment === assignment && game.candidateSide === side,
                );
                const s2 = record.games.find(
                    (game) => game.arm === "s2" && game.assignment === assignment && game.candidateSide === side,
                );
                if (!s3 || !s2 || s3.setupFingerprint !== s2.setupFingerprint) malformedClusters += 1;
                if (
                    s3 &&
                    s2 &&
                    (s3.candidateRosterSignature !== s2.candidateRosterSignature ||
                        s3.anchorRosterSignature !== s2.anchorRosterSignature)
                ) {
                    malformedClusters += 1;
                }
            }
        }
    }
    if (records.length !== options.pairs * options.cohorts.length || expected.size > 0) malformedClusters += 1;
    for (const cohort of options.cohorts) {
        for (const map of AI_META_MAPS) {
            const count = records.filter((record) => record.cohort === cohort && record.map === map).length;
            if (count !== options.pairs / AI_META_MAPS.length) malformedClusters += 1;
        }
    }
    return {
        expectedClusters: options.pairs * options.cohorts.length,
        clusters: records.length,
        games: records.length * GAMES_PER_CLUSTER,
        gamesPerArm: records.length * CLUSTER_SIZE_PER_ARM,
        malformedClusters,
        rejectedS3,
        rejectedS2,
        rejectedAnchor,
        stuckMatches,
        overlappingRosters,
        sourceUnchanged,
    };
}

function buildGates(rankings: ReturnType<typeof summarize>, quality: Record<string, unknown>): Record<string, unknown> {
    const supported = (rows: readonly IMetricRow[]): IMetricRow[] => rows.filter((row) => row.clusters > 0);
    const safe = (rows: readonly IMetricRow[]): boolean =>
        supported(rows).every((row) => row.liftPp >= GATES.safetyFloorPp && row.ciHighPp >= 0);
    return {
        practicalUplift: {
            passed: rankings.overall.liftPp >= GATES.practicalLiftPp,
            observed: rankings.overall.liftPp,
            requirement: `S3-minus-S2 draw-aware lift >= +${GATES.practicalLiftPp.toFixed(1)}pp`,
        },
        measurableUplift: {
            passed: rankings.overall.ciLowPp >= GATES.clusteredCiLowPp,
            observed: rankings.overall.ciLowPp,
            requirement: `fixed-stratified clustered 95% lower bound >= +${GATES.clusteredCiLowPp.toFixed(2)}pp`,
        },
        cohortSafety: {
            passed: safe(rankings.cohorts),
            observed: rankings.cohorts,
            requirement: "no cohort below -2pp or statistically clearly harmful",
        },
        mapSafety: {
            passed: safe(rankings.maps),
            observed: rankings.maps,
            requirement: "no live map below -2pp or statistically clearly harmful",
        },
        sliceSafety: {
            passed: safe(rankings.cohortMaps),
            observed: rankings.cohortMaps,
            requirement: "no cohort-by-map slice below -2pp or statistically clearly harmful",
        },
        quality: {
            passed:
                quality.malformedClusters === 0 &&
                quality.rejectedS3 === 0 &&
                quality.rejectedS2 === 0 &&
                quality.rejectedAnchor === 0 &&
                quality.stuckMatches === 0 &&
                quality.overlappingRosters === 0 &&
                quality.sourceUnchanged === true,
            observed: quality,
            requirement: "zero malformed/overlapping/rejected/stuck matches and unchanged sealed source",
        },
    };
}

async function runWorkers(
    options: IOptions,
    rawPath: string,
): Promise<{ records: IClusterRecord[]; workerSeals: IWorkerReady[] }> {
    const tasks = options.cohorts.flatMap((cohort) =>
        Array.from({ length: options.pairs }, (_, pair): ITask => ({
            cohort,
            pair,
            pairs: options.pairs,
            baseSeed: options.baseSeed,
            maxLaps: options.maxLaps,
        })),
    );
    const records: IClusterRecord[] = [];
    const workerSeals: IWorkerReady[] = [];
    const workers: Worker[] = [];
    const workerCount = Math.min(options.concurrency, tasks.length);
    let dispatched = 0;
    let completed = 0;
    let lastProgressAt = 0;
    return new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        const stop = (): void => workers.forEach((worker) => void worker.terminate());
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            stop();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatch = (worker: Worker): void => {
            const task = tasks[dispatched++];
            worker.postMessage(
                task ? ({ type: "cluster", task } satisfies WorkerRequest) : ({ type: "stop" } satisfies WorkerRequest),
            );
        };
        for (let index = 0; index < workerCount; index += 1) {
            const worker = new Worker(new URL(import.meta.url), { env: workerEnvironment(options.sourceRoot) });
            workers.push(worker);
            worker.on("message", (message: WorkerResponse) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    workerSeals.push(message);
                    dispatch(worker);
                    return;
                }
                records.push(message.record);
                appendFileSync(rawPath, `${JSON.stringify(message.record)}\n`);
                completed += 1;
                const now = Date.now();
                if (now - lastProgressAt >= 5_000 || completed === tasks.length) {
                    lastProgressAt = now;
                    console.error(
                        `[a19-v07] ${completed}/${tasks.length} clusters (${completed * GAMES_PER_CLUSTER} fights)`,
                    );
                }
                if (completed === tasks.length) {
                    settled = true;
                    stop();
                    resolvePromise({ records, workerSeals });
                    return;
                }
                dispatch(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                if (!settled && code !== 0) fail(new Error(`A19/v0.7 worker exited with code ${code}`));
            });
        }
    });
}

function validateWorkerSeals(
    workerSeals: readonly IWorkerReady[],
    concurrency: number,
    expected: IEnvironmentSeal,
): void {
    if (workerSeals.length !== concurrency)
        throw new Error(`Expected ${concurrency} worker seals, received ${workerSeals.length}`);
    const expectedEnvironment = JSON.stringify(expected);
    const behaviorHashes = new Set<string>();
    for (const seal of workerSeals) {
        if (JSON.stringify(seal.environment) !== expectedEnvironment)
            throw new Error("Worker imported a different a13 profile");
        behaviorHashes.add(seal.workerBehaviorEnvironmentSha256);
    }
    if (behaviorHashes.size !== 1) throw new Error("Workers did not start under one behavioral environment");
}

async function workerPreflight(sourceRoot: string, expected: IEnvironmentSeal): Promise<IWorkerReady> {
    return new Promise((resolvePromise, rejectPromise) => {
        const worker = new Worker(new URL(import.meta.url), { env: workerEnvironment(sourceRoot) });
        let settled = false;
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            void worker.terminate();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        worker.on("message", (message: WorkerResponse) => {
            if (settled) return;
            if (message.type === "error") {
                fail(new Error(message.error));
                return;
            }
            if (message.type !== "ready") {
                fail(new Error("Worker preflight received a fight result without a task"));
                return;
            }
            try {
                validateWorkerSeals([message], 1, expected);
                settled = true;
                void worker.terminate();
                resolvePromise(message);
            } catch (error) {
                fail(error);
            }
        });
        worker.on("error", fail);
        worker.on("exit", (code) => {
            if (!settled && code !== 0) fail(new Error(`Worker preflight exited with code ${code}`));
        });
    });
}

async function run(options: IOptions): Promise<Record<string, unknown>> {
    if (existsSync(options.output)) throw new Error(`Refusing to resume or overwrite ${options.output}`);
    mkdirSync(options.output, { recursive: false });
    const rawPath = join(options.output, RAW_FILE);
    writeFileSync(rawPath, "");
    const runtime = await loadSourceRuntime(options.sourceRoot);
    const environment = assertEnvironmentContract(runtime);
    const sourceBefore = sourceSeal(options.sourceRoot);
    if (options.expectedSourceSha256 && options.expectedSourceSha256 !== sourceBefore.sourceSha256) {
        throw new Error(
            `Source seal mismatch: expected ${options.expectedSourceSha256}, observed ${sourceBefore.sourceSha256}`,
        );
    }
    const startedAt = new Date();
    writeFileSync(
        join(options.output, STARTED_FILE),
        `${JSON.stringify({ schema: SCHEMA, startedAt: startedAt.toISOString(), options, sourceBefore, environment }, null, 2)}\n`,
    );
    const startedMs = Date.now();
    const { records, workerSeals } = await runWorkers(options, rawPath);
    const sourceAfter = sourceSeal(options.sourceRoot);
    const sourceUnchanged =
        sourceBefore.sourceSha256 === sourceAfter.sourceSha256 &&
        sourceBefore.runnerSha256 === sourceAfter.runnerSha256;
    validateWorkerSeals(
        workerSeals,
        Math.min(options.concurrency, options.pairs * options.cohorts.length),
        environment,
    );
    records.sort((left, right) =>
        left.cohort === right.cohort
            ? left.pair - right.pair
            : AI_META_COHORTS.indexOf(left.cohort) - AI_META_COHORTS.indexOf(right.cohort),
    );
    writeFileSync(rawPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const quality = validateRecords(runtime, records, options, sourceUnchanged);
    const rankings = summarize(records);
    const gates = buildGates(rankings, quality);
    const allGatesPassed = Object.values(gates).every((gate) => (gate as { passed: boolean }).passed);
    const confirmationStage =
        options.stage === "direction" || options.stage === "validation" || options.stage === "replication";
    const summary = {
        schema: SCHEMA,
        complete: (gates.quality as { passed: boolean }).passed,
        stage: options.stage,
        promotionEvidence: options.stage === "validation" || options.stage === "replication",
        heldoutConfirmation: confirmationStage,
        verdict: confirmationStage ? (allGatesPassed ? "measurably_better" : "rejected") : "development_only",
        generatedAt: new Date().toISOString(),
        seconds: (Date.now() - startedMs) / 1_000,
        options: { ...options, clusterSizePerArm: CLUSTER_SIZE_PER_ARM, gamesPerCluster: GAMES_PER_CLUSTER },
        preregistration: {
            stagePairs: STAGE_PAIRS,
            stageSeeds: STAGE_SEEDS,
            validationSeedCommitment: VALIDATION_SEED_COMMITMENT,
            validationSeedCommitmentCodec: `${VALIDATION_SEED_LABEL}\\0<decimal-seed>`,
            primaryEstimand:
                "mean within-cluster draw-aware score difference: S3-vs-v0.7 four-game crossover minus S2-vs-v0.7 identical four-game crossover",
            uncertainty:
                "two-sided normal 95% interval over complete eight-game clusters; overall is fixed-stratified across cohort x live-map cells",
            optionalStopping:
                "validation and replication are one-shot, fixed-size stages; never inspect partial win rates",
            gates: GATES,
        },
        arms: {
            s3: "untouched automatic production v0.8+a13 factory",
            s2: "canonical production a13 environment with only SEARCH_SHORTLIST=2",
            anchor: ANCHOR_VERSION,
            crossover:
                "each AI arm receives roster A and roster B, once on each physical side, with identical setup/map/combat seeds",
        },
        cohortDescriptions: Object.fromEntries(
            options.cohorts.map((cohort) => [cohort, AI_META_COHORT_DESCRIPTIONS[cohort]]),
        ),
        provenance: {
            sourceBefore,
            sourceAfter,
            environment,
            workerBehaviorEnvironmentSha256: workerSeals[0]?.workerBehaviorEnvironmentSha256,
            runtime: {
                bun: Bun.version,
                platform: platform(),
                arch: arch(),
                release: release(),
                cpu: cpus()[0]?.model ?? "unknown",
                logicalCpus: cpus().length,
                availableParallelism: availableParallelism(),
                workerConcurrency: options.concurrency,
                memory: totalmem(),
            },
        },
        quality,
        rankings,
        gates,
    };
    writeFileSync(join(options.output, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

async function selfTest(sourceRoot: string): Promise<void> {
    const runtime = await loadSourceRuntime(sourceRoot);
    const environment = assertEnvironmentContract(runtime);
    if (environment.profileDelta.length !== 1) throw new Error("environment self-test failed");
    const fakeGame = (arm: Arm, score: number): IGameRecord => ({
        arm,
        assignment: 0,
        candidateRoster: "a",
        candidateSide: "green",
        winner: score === 1 ? "green" : score === 0 ? "red" : "draw",
        candidateResult: score === 1 ? "win" : score === 0 ? "loss" : "draw",
        candidateScore: score,
        laps: 1,
        endReason: "elimination",
        rejectedCandidate: 0,
        rejectedAnchor: 0,
        candidateHpMargin: 0,
        candidateSurvivorMargin: 0,
        totalActions: 1,
        elapsedMs: 0,
        candidateRosterSignature: "candidate",
        anchorRosterSignature: "anchor",
        setupFingerprint: "same",
    });
    const record = (pair: number, s3: number, s2: number): IClusterRecord => ({
        schema: SCHEMA,
        cohort: "ranked-draft",
        pair,
        setupSeed: pair,
        combatSeed: pair,
        map: 1,
        armOrder: ["s3", "s2"],
        games: [
            fakeGame("s3", s3),
            fakeGame("s2", s2),
            fakeGame("s3", s3),
            fakeGame("s2", s2),
            fakeGame("s3", s3),
            fakeGame("s2", s2),
            fakeGame("s3", s3),
            fakeGame("s2", s2),
        ],
    });
    const metric = metricRow("self-test", [record(0, 1, 0), record(1, 0.5, 0.5)]);
    if (metric.liftPp !== 50 || metric.s3ScoreRate !== 0.75 || metric.s2ScoreRate !== 0.25) {
        throw new Error(`cluster estimator self-test failed: ${JSON.stringify(metric)}`);
    }
    let validationAcceptedWithoutSource = false;
    try {
        parseOptions(["--stage", "validation", "--output", "/tmp/should-not-run"]);
        validationAcceptedWithoutSource = true;
    } catch {
        // Expected: promotion evidence must bind its immutable source archive.
    }
    if (validationAcceptedWithoutSource) throw new Error("validation source-seal self-test failed");
    console.log(JSON.stringify({ ok: true, schema: SCHEMA, environment, estimator: metric }, null, 2));
}

async function preflight(sourceRoot: string): Promise<void> {
    const runtime = await loadSourceRuntime(sourceRoot);
    const environment = assertEnvironmentContract(runtime);
    const worker = await workerPreflight(sourceRoot, environment);
    console.log(
        JSON.stringify(
            {
                ok: true,
                schema: SCHEMA,
                source: sourceSeal(sourceRoot),
                environment,
                workerEnvironmentSha256: environmentSha256(workerEnvironment(sourceRoot)),
                workerBehaviorEnvironmentSha256: worker.workerBehaviorEnvironmentSha256,
                stagePairs: STAGE_PAIRS,
                stageSeeds: STAGE_SEEDS,
            },
            null,
            2,
        ),
    );
}

async function workerMain(workerPort: NonNullable<typeof parentPort>): Promise<void> {
    const sourceRoot = process.env.HOC_A19_V07_SOURCE_ROOT;
    if (!sourceRoot) throw new Error("A19/v0.7 worker requires HOC_A19_V07_SOURCE_ROOT");
    const runtime = await loadSourceRuntime(sourceRoot);
    process.env.SIM_NO_ACTIONS = "1";
    process.env.LIVETWIN = "1";
    process.env.FIGHT_MELEE_ROSTERS = "0";
    const ready: IWorkerReady = {
        type: "ready",
        environment: assertEnvironmentContract(runtime),
        workerBehaviorEnvironmentSha256: environmentSha256(behaviorEnvironment()),
    };
    workerPort.on("message", (message: WorkerRequest) => {
        if (message.type === "stop") {
            workerPort.close();
            return;
        }
        try {
            workerPort.postMessage({
                type: "result",
                record: playCluster(runtime, message.task),
            } satisfies WorkerResponse);
        } catch (error) {
            workerPort.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            } satisfies WorkerResponse);
        }
    });
    workerPort.postMessage(ready);
}

if (parentPort) {
    const workerPort = parentPort;
    void workerMain(workerPort).catch((error) => {
        workerPort.postMessage({
            type: "error",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        } satisfies WorkerResponse);
    });
} else if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.includes("--self-test")) {
        void selfTest(utilitySourceRoot(args)).catch((error) => {
            console.error(error instanceof Error ? (error.stack ?? error.message) : error);
            process.exitCode = 1;
        });
    } else if (args.includes("--preflight")) {
        void preflight(utilitySourceRoot(args)).catch((error) => {
            console.error(error instanceof Error ? (error.stack ?? error.message) : error);
            process.exitCode = 1;
        });
    } else {
        run(parseOptions(args))
            .then((summary) => {
                const overall = (summary.rankings as ReturnType<typeof summarize>).overall;
                console.log(
                    JSON.stringify(
                        {
                            verdict: summary.verdict,
                            complete: summary.complete,
                            games: (summary.quality as { games: number }).games,
                            s3ScoreRate: overall.s3ScoreRate,
                            s2ScoreRate: overall.s2ScoreRate,
                            liftPp: overall.liftPp,
                            ciPp: [overall.ciLowPp, overall.ciHighPp],
                            output: (summary.options as IOptions).output,
                        },
                        null,
                        2,
                    ),
                );
            })
            .catch((error) => {
                console.error(error instanceof Error ? (error.stack ?? error.message) : error);
                process.exitCode = 1;
            });
    }
}

export {
    SCHEMA as V08_A19_H18_VS_V07_COHORT_AB_SCHEMA,
    metricRow as summarizeV08S3VsS2Clusters,
    parseOptions as parseV08S3VsS2Options,
};
