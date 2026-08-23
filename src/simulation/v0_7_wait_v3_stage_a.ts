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

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
    MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11,
    parseWaitWeightsV3,
    WAIT_FEATURE_NAMES_V2_RAW,
    WAIT_FEATURE_NAMES_V3,
    v07WaitWeightsV3,
} from "../ai/versions/wait_scorer";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    buildArchetypeRoster,
    buildSharedArchetypeOffers,
    setupForArchetype,
    type ArchetypeName,
} from "./archetype_payoff";
import { creaturesByLevel, DEFAULT_AMOUNT_BY_LEVEL, makeRng, resolveStackAmount, type IArmyUnitSpec } from "./army";
import { runMatch, type IMatchResult } from "./battle_engine";
import { parsePhaseBQ2Row } from "./phase_b_dataset";
import { playGame, type ITournamentOptions } from "./tournament";
import type { IRevisionProvenance } from "./v0_7_acceptance";

export const WAIT_V3_STAGE_A_MANIFEST_PATH = fileURLToPath(
    new URL("./manifests/v0_7_wait_v3_stage_a_20260716.json", import.meta.url),
);
export const WAIT_V3_STAGE_A_PAIR_SEED_STEP = 0x9e3779b1;
export const WAIT_V3_STAGE_A_V2_JSON = JSON.stringify(MULTICOHORT_WAIT_WEIGHTS_V2_2026_07_11);
export const WAIT_V3_STAGE_A_SENTINEL_JSON = JSON.stringify({
    b: -1,
    w: new Array(WAIT_FEATURE_NAMES_V3.length).fill(0),
});

export type WaitV3StageACohortId = "ranged_max" | "pure_ranged" | "hybrid" | "random_draft";

export interface IWaitV3StageACohort {
    id: WaitV3StageACohortId;
    kind: "mirror" | "draft";
    roster: "ranged_max_sniper3" | "pure_ranged_exact" | "hybrid" | "independent_random_exp_budget";
    setup: "ranged_max_sniper3" | "melee_coevo" | "hybrid" | "livetwin";
    games: number;
    baseSeed: number;
}

export interface IWaitV3StageAManifest {
    schemaVersion: 1;
    manifestId: string;
    createdAt: string;
    status: "research_only_no_bake";
    candidate: "v0.7";
    opponent: "v0.6";
    pairedSideSwap: true;
    pairSeedStep: number;
    oracle: {
        mode: "Q2_ORACLE";
        versions: "v0.7";
        gate: number;
        rollouts: number;
        horizon: "lap";
        leaf: "material";
    };
    incumbent: {
        v2WeightsSha256: string;
        v3SentinelSha256: string;
        v3Sentinel: string;
    };
    cohorts: IWaitV3StageACohort[];
    heldoutGates: {
        rangeSeedsMin: number;
        rangeFiredSeedsMin: number;
        positiveDeltaCaptureMin: number;
        rangeFiredDelta: "positive";
        eachFiredActionBucketDelta: "nonnegative";
    };
    completion: {
        rawMarker: "RAW_COMPLETE";
        fitMarker: "FIT_COMPLETE";
        requireLiteralFitterLine: "V3 GATE: PASS";
        modelWidth: number;
        modelMustBeNonzero: true;
        automaticBake: false;
        automaticDeploy: false;
    };
    freshSeedAudit: {
        auditedAt: string;
        plannedScenarioSeeds: number;
        internalCollisions: number;
        localNumericTokens: number;
        localCollisions: number;
        zincNumericTokens: number;
        zincCollisions: number;
        localRoots: string[];
        zincRoots: string[];
        declaration: string;
    };
}

export interface IWaitV3StageAManifestProvenance {
    path: string;
    sha256: string;
}

export interface IWaitV3StageASeedAudit {
    roots: string[];
    numericTokens: number;
    collisions: number[];
}

interface IWaitV3StageARunIdentity {
    protocol: IWaitV3StageAManifestProvenance;
    revision: IRevisionProvenance;
    harnessSourceSha256: string;
    fitWrapperSourceSha256: string;
    fitterSourceSha256: string;
    gateSourceSha256: string;
    candidate: "v0.7";
    opponent: "v0.6";
    cohorts: IWaitV3StageACohort[];
    oracle: IWaitV3StageAManifest["oracle"];
    v2WeightsSha256: string;
    v3SentinelSha256: string;
    effectiveBehaviorEnvironment: Record<string, string>;
    seedAudit: IWaitV3StageASeedAudit;
    automaticBake: false;
    automaticDeploy: false;
}

export interface IWaitV3StageARunManifest {
    schemaVersion: 1;
    createdAt: string;
    runFingerprint: string;
    concurrency: number;
    identity: IWaitV3StageARunIdentity;
}

interface IWaitV3StageAGameArtifact {
    schemaVersion: 1;
    runFingerprint: string;
    cohort: WaitV3StageACohortId;
    game: number;
    seed: number;
    greenVersion: string;
    redVersion: string;
    winner: IMatchResult["winner"];
    endReason: IMatchResult["endReason"];
    laps: number;
    decidedByArmageddon: boolean;
    rejectedGreen: number | null;
    rejectedRed: number | null;
}

export interface IWaitV3StageACohortRawReport {
    id: WaitV3StageACohortId;
    games: number;
    q2Rows: number;
    q2ScoredRows: number;
    q2WaitRejected: number;
    q2Path: string;
    q2Bytes: number;
    q2Sha256: string;
    auditPath: string;
    auditBytes: number;
    auditSha256: string;
    gamesPath: string;
    gamesBytes: number;
    gamesSha256: string;
}

export interface IWaitV3StageARawReport {
    schemaVersion: 1;
    kind: "v0.7_wait_v3_stage_a_raw";
    verdict: "PASS";
    generatedAt: string;
    runFingerprint: string;
    protocolSha256: string;
    runManifestSha256: string;
    games: number;
    q2Rows: number;
    cohorts: IWaitV3StageACohortRawReport[];
}

interface IWaitV3StageAAuditRow extends Record<string, unknown> {
    t: "game";
    mode: "oracle";
    seed: number;
    green: string;
    red: string;
    winner: string;
    endReason: string;
    gate: number;
    horizon: "lap";
    rollouts: number;
    leaf: "material";
    decisions: number;
    q2oPoints: number;
    q2oScored: number;
    q2oIncumbentWait: number;
    q2oWaitRejected: number;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FITTER_SOURCE = join(PROJECT_ROOT, "src/simulation/optimizer/fit_wait_v2.mjs");
const FIT_WRAPPER_SOURCE = join(PROJECT_ROOT, "src/simulation/fit_v0_7_wait_v3_stage_a.ts");
const GATE_SOURCE = join(PROJECT_ROOT, "src/simulation/optimizer/wait_v3_gates.ts");
const PURE_RANGED: readonly { level: number; creatureName: string }[] = [
    { level: 1, creatureName: "Arbalester" },
    { level: 1, creatureName: "Orc" },
    { level: 2, creatureName: "Elf" },
    { level: 2, creatureName: "Medusa" },
    { level: 3, creatureName: "Cyclops" },
    { level: 4, creatureName: "Tsar Cannon" },
];
const FROZEN_COHORTS: readonly IWaitV3StageACohort[] = [
    {
        id: "ranged_max",
        kind: "mirror",
        roster: "ranged_max_sniper3",
        setup: "ranged_max_sniper3",
        games: 4_000,
        baseSeed: 2_403_834_848,
    },
    {
        id: "pure_ranged",
        kind: "mirror",
        roster: "pure_ranged_exact",
        setup: "melee_coevo",
        games: 4_000,
        baseSeed: 3_575_244_398,
    },
    {
        id: "hybrid",
        kind: "mirror",
        roster: "hybrid",
        setup: "hybrid",
        games: 2_000,
        baseSeed: 372_222_176,
    },
    {
        id: "random_draft",
        kind: "draft",
        roster: "independent_random_exp_budget",
        setup: "livetwin",
        games: 2_000,
        baseSeed: 3_566_425_037,
    },
];
const BEHAVIOR_PREFIXES = ["V04_", "V05_", "V06_", "V07_", "SEARCH_", "Q2_", "CEM_"] as const;
const BEHAVIOR_EXACT = new Set([
    "AUGCA_NOVISION",
    "FIGHT_MELEE_ROSTERS",
    "FORCE_CREATURES",
    "LIVETWIN",
    "ROSTER_CASTER_MAX",
    "ROSTER_CASTER_MIN",
    "ROSTER_FLYER_MAX",
    "ROSTER_FLYER_MIN",
    "ROSTER_RANGED_MAX",
    "ROSTER_RANGED_MIN",
    "SIM_NO_ACTIONS",
    "VALUE_DATA",
    "VALUE_DATA_FEATURES",
]);

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function atomicWriteText(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, value);
    renameSync(temporary, path);
}

function atomicWriteJson(path: string, value: unknown): void {
    atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(`Cannot parse JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
    return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
    return value as number;
}

export type WaitV3StageAGitTextReader = (repo: string, args: string[]) => string;

function gitText(repo: string, args: string[]): string {
    try {
        return execFileSync("git", ["-C", repo, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        throw new Error(`Cannot read git provenance: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function parseLiveOriginMain(value: string): string {
    const rows = value
        .split("\n")
        .map((row) => row.trim())
        .filter(Boolean)
        .map((row) => row.split(/\s+/));
    if (
        rows.length !== 1 ||
        rows[0].length !== 2 ||
        rows[0][1] !== "refs/heads/main" ||
        !/^[0-9a-f]{40,64}$/i.test(rows[0][0])
    ) {
        throw new Error("Wait V3 Stage A could not resolve exactly one live origin main revision");
    }
    return rows[0][0].toLowerCase();
}

export function readCleanMainRevision(
    repo: string = PROJECT_ROOT,
    readGit: WaitV3StageAGitTextReader = gitText,
): IRevisionProvenance {
    const status = readGit(repo, ["status", "--porcelain"]);
    if (status) throw new Error(`Wait V3 Stage A requires a completely clean execution repository: ${repo}`);
    const branch = readGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== "main") throw new Error(`Wait V3 Stage A requires branch main; got ${branch}`);
    const commit = readGit(repo, ["rev-parse", "HEAD"]).toLowerCase();
    const originMain = readGit(repo, ["rev-parse", "origin/main"]).toLowerCase();
    if (commit !== originMain)
        throw new Error(`Wait V3 Stage A requires HEAD == origin/main; got ${commit}/${originMain}`);
    const liveOriginMain = parseLiveOriginMain(
        readGit(repo, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]),
    );
    if (commit !== liveOriginMain) {
        throw new Error(`Wait V3 Stage A requires HEAD == live origin/main; got ${commit}/${liveOriginMain}`);
    }
    return {
        commit,
        commitDate: readGit(repo, ["show", "-s", "--format=%cI", "HEAD"]),
        branch,
        remote: (() => {
            try {
                return readGit(repo, ["remote", "get-url", "origin"]);
            } catch {
                return null;
            }
        })(),
        trackedClean: true,
        trackedDiffSha256: null,
    };
}

export function expectedWaitV3StageASeed(cohort: IWaitV3StageACohort, game: number): number {
    if (!Number.isSafeInteger(game) || game < 0 || game >= cohort.games) {
        throw new Error(`${cohort.id} game index out of range: ${game}`);
    }
    return (cohort.baseSeed + Math.floor(game / 2) * WAIT_V3_STAGE_A_PAIR_SEED_STEP) >>> 0;
}

export function plannedWaitV3StageASeeds(manifest: IWaitV3StageAManifest): Set<number> {
    const seeds = new Set<number>();
    for (const cohort of manifest.cohorts) {
        for (let game = 0; game < cohort.games; game += 2) {
            const seed = expectedWaitV3StageASeed(cohort, game);
            if (seeds.has(seed)) throw new Error(`Stage-A seed collision at ${seed}`);
            seeds.add(seed);
        }
    }
    return seeds;
}

export function readWaitV3StageAManifest(path: string = WAIT_V3_STAGE_A_MANIFEST_PATH): {
    manifest: IWaitV3StageAManifest;
    provenance: IWaitV3StageAManifestProvenance;
} {
    const sourcePath = resolve(path);
    const raw = readFileSync(sourcePath, "utf8");
    const manifest = JSON.parse(raw) as IWaitV3StageAManifest;
    validateWaitV3StageAManifest(manifest);
    return { manifest, provenance: { path: sourcePath, sha256: sha256(raw) } };
}

export function validateWaitV3StageAManifest(manifest: IWaitV3StageAManifest): void {
    if (
        manifest.schemaVersion !== 1 ||
        manifest.manifestId !== "v0.7-wait-v3-stage-a-20260716" ||
        !Number.isFinite(Date.parse(manifest.createdAt)) ||
        manifest.status !== "research_only_no_bake"
    ) {
        throw new Error("Invalid Wait V3 Stage-A manifest identity");
    }
    if (
        manifest.candidate !== "v0.7" ||
        manifest.opponent !== "v0.6" ||
        !manifest.pairedSideSwap ||
        manifest.pairSeedStep !== WAIT_V3_STAGE_A_PAIR_SEED_STEP
    ) {
        throw new Error("Wait V3 Stage A is frozen to paired v0.7 versus v0.6");
    }
    if (stableJson(manifest.cohorts) !== stableJson(FROZEN_COHORTS)) {
        throw new Error("Wait V3 Stage-A cohorts, sizes, or seeds differ from the frozen panel");
    }
    const oracle = manifest.oracle;
    if (
        oracle.mode !== "Q2_ORACLE" ||
        oracle.versions !== "v0.7" ||
        oracle.gate !== 0.01 ||
        oracle.rollouts !== 3 ||
        oracle.horizon !== "lap" ||
        oracle.leaf !== "material"
    ) {
        throw new Error("Wait V3 Stage-A oracle configuration drifted");
    }
    if (manifest.incumbent.v2WeightsSha256 !== sha256(WAIT_V3_STAGE_A_V2_JSON)) {
        throw new Error("Wait V3 Stage-A V2 incumbent hash mismatch");
    }
    if (
        WAIT_FEATURE_NAMES_V3.length !== 125 ||
        manifest.incumbent.v3SentinelSha256 !== sha256(WAIT_V3_STAGE_A_SENTINEL_JSON) ||
        parseWaitWeightsV3(WAIT_V3_STAGE_A_SENTINEL_JSON)?.w.length !== 125
    ) {
        throw new Error("Wait V3 Stage-A nonfiring V3 sentinel mismatch");
    }
    const previous = process.env.V07_WAIT_WEIGHTS_V3;
    try {
        process.env.V07_WAIT_WEIGHTS_V3 = WAIT_V3_STAGE_A_SENTINEL_JSON;
        const resolved = v07WaitWeightsV3();
        if (!resolved || resolved.b !== -1 || resolved.w.some((weight) => weight !== 0)) {
            throw new Error("Wait V3 sentinel is not an active nonfiring model");
        }
    } finally {
        if (previous === undefined) delete process.env.V07_WAIT_WEIGHTS_V3;
        else process.env.V07_WAIT_WEIGHTS_V3 = previous;
        v07WaitWeightsV3();
    }
    if (
        manifest.heldoutGates.rangeSeedsMin !== 256 ||
        manifest.heldoutGates.rangeFiredSeedsMin !== 32 ||
        manifest.heldoutGates.positiveDeltaCaptureMin !== 0.1 ||
        manifest.heldoutGates.rangeFiredDelta !== "positive" ||
        manifest.heldoutGates.eachFiredActionBucketDelta !== "nonnegative"
    ) {
        throw new Error("Wait V3 Stage-A held-out gates drifted");
    }
    if (
        manifest.completion.rawMarker !== "RAW_COMPLETE" ||
        manifest.completion.fitMarker !== "FIT_COMPLETE" ||
        manifest.completion.requireLiteralFitterLine !== "V3 GATE: PASS" ||
        manifest.completion.modelWidth !== 125 ||
        !manifest.completion.modelMustBeNonzero ||
        manifest.completion.automaticBake ||
        manifest.completion.automaticDeploy
    ) {
        throw new Error("Wait V3 Stage-A completion policy drifted");
    }
    const seeds = plannedWaitV3StageASeeds(manifest);
    if (
        seeds.size !== 6_000 ||
        manifest.freshSeedAudit.plannedScenarioSeeds !== seeds.size ||
        manifest.freshSeedAudit.internalCollisions !== 0 ||
        manifest.freshSeedAudit.localCollisions !== 0 ||
        manifest.freshSeedAudit.zincCollisions !== 0 ||
        !manifest.freshSeedAudit.declaration.trim()
    ) {
        throw new Error("Wait V3 Stage-A fresh-seed declaration is incomplete");
    }
}

export function findWaitV3StageASeedCollisions(
    manifest: IWaitV3StageAManifest,
    numericTokens: Iterable<number>,
): number[] {
    const planned = plannedWaitV3StageASeeds(manifest);
    const collisions = new Set<number>();
    for (const token of numericTokens) {
        if (planned.has(token)) collisions.add(token);
    }
    return [...collisions].sort((left, right) => left - right);
}

export function canonicalWaitV3StageASeedToken(value: unknown): number | undefined {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0xffffffff) return undefined;
        return value >>> 0;
    }
    if (typeof value !== "string" || !/^(?:0x[0-9a-f]{1,8}|-?[0-9]{1,10})$/i.test(value)) return undefined;
    const parsed = value.toLowerCase().startsWith("0x") ? Number.parseInt(value.slice(2), 16) : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < -0x80000000 || parsed > 0xffffffff) return undefined;
    return parsed >>> 0;
}

const WAIT_V3_STAGE_A_SEED_SCAN_EXCLUDED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const WAIT_V3_STAGE_A_MAX_SCAN_LINE_CHARACTERS = 64 * 1024 * 1024;

export function discoverWaitV3StageASeedTokens(roots: readonly string[]): Set<number> {
    const existing = roots.map((root) => resolve(root)).filter(existsSync);
    if (!existing.length) throw new Error("Wait V3 Stage-A seed audit has no existing roots");

    type FileSnapshot = { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
    const files = new Map<string, FileSnapshot>();
    const ownManifestPath = resolve(WAIT_V3_STAGE_A_MANIFEST_PATH);
    const walk = (path: string): void => {
        const absolute = resolve(path);
        let stat: ReturnType<typeof lstatSync>;
        try {
            stat = lstatSync(absolute);
        } catch (error) {
            if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
            if (WAIT_V3_STAGE_A_SEED_SCAN_EXCLUDED_DIRECTORIES.has(basename(absolute))) return;
            for (const entry of readdirSync(absolute).sort()) walk(join(absolute, entry));
            return;
        }
        if (!stat.isFile() || absolute === ownManifestPath) return;
        if (stat.size > 2 * 1024 * 1024 * 1024) throw new Error(`Refusing oversized seed-corpus file ${absolute}`);
        files.set(absolute, {
            path: absolute,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
        });
    };
    for (const root of existing) walk(root);

    const tokens = new Set<number>();
    const add = (value: unknown): void => {
        const canonical = canonicalWaitV3StageASeedToken(value);
        if (canonical !== undefined) tokens.add(canonical);
    };
    const seedKey = (key: string): boolean => /seed/i.test(key);
    const visitStructured = (value: unknown, inheritedSeedContext = false): void => {
        if (typeof value === "number" || typeof value === "string") {
            if (inheritedSeedContext) add(value);
            return;
        }
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const entry of value) visitStructured(entry, inheritedSeedContext);
            return;
        }
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (inheritedSeedContext) add(key);
            visitStructured(entry, inheritedSeedContext || seedKey(key));
        }
    };
    const expandTournamentPanels = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
            for (const entry of value) expandTournamentPanels(entry);
            return;
        }
        const record = value as Record<string, unknown>;
        const baseSeed = canonicalWaitV3StageASeedToken(record.baseSeed);
        const gamesPerArm = record.gamesPerArm;
        const declaredPairSeeds = record.pairSeeds;
        const compactPanel =
            record.games === undefined &&
            Number.isSafeInteger(gamesPerArm) &&
            (gamesPerArm as number) >= 1 &&
            Number.isSafeInteger(declaredPairSeeds) &&
            (declaredPairSeeds as number) === Math.ceil((gamesPerArm as number) / 2);
        const games = compactPanel ? gamesPerArm : record.games;
        const step =
            record.pairSeedStep === undefined
                ? WAIT_V3_STAGE_A_PAIR_SEED_STEP
                : canonicalWaitV3StageASeedToken(record.pairSeedStep);
        if (
            baseSeed !== undefined &&
            step !== undefined &&
            Number.isSafeInteger(games) &&
            (games as number) >= 1 &&
            (compactPanel || (games as number) % 2 === 0)
        ) {
            const pairs = compactPanel ? (declaredPairSeeds as number) : (games as number) / 2;
            for (let pair = 0; pair < pairs; pair += 1) add((baseSeed + Math.imul(pair, step)) >>> 0);
        }
        if (
            Array.isArray(record.cells) &&
            Number.isSafeInteger(gamesPerArm) &&
            (gamesPerArm as number) >= 2 &&
            (gamesPerArm as number) % 2 === 0 &&
            step !== undefined
        ) {
            for (const cell of record.cells) {
                const cellBaseSeed =
                    cell !== null && typeof cell === "object"
                        ? canonicalWaitV3StageASeedToken((cell as Record<string, unknown>).baseSeed)
                        : undefined;
                if (cellBaseSeed === undefined) continue;
                for (let pair = 0; pair < (gamesPerArm as number) / 2; pair += 1) {
                    add((cellBaseSeed + Math.imul(pair, step)) >>> 0);
                }
            }
        }
        for (const entry of Object.values(record)) expandTournamentPanels(entry);
    };
    const seedContextPattern =
        /(?:base[_-]?seed|seed|scenarioRoot|setupSeed|combatSeed|pairSeeds?)[^0-9a-fA-F-]{0,16}(0x[0-9a-fA-F]{1,8}|-?[0-9]{1,10})(?![0-9A-Za-z_])/gi;
    const numericTokenPattern = /(?<![\w-])(?:-?[0-9]{1,10}|0x[0-9a-fA-F]{1,8})\b/g;
    const scanText = (value: string, allNumbers: boolean): void => {
        for (const match of value.matchAll(seedContextPattern)) add(match[1]);
        if (allNumbers) for (const match of value.matchAll(numericTokenPattern)) add(match[0]);
    };
    const scanStream = (path: string, parseJsonLines: boolean, allNumbers: boolean): void => {
        const descriptor = openSync(path, "r");
        const decoder = new StringDecoder("utf8");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let pending = "";
        const consume = (line: string): void => {
            if (parseJsonLines && line.trim()) {
                try {
                    const parsed = JSON.parse(line) as unknown;
                    visitStructured(parsed);
                    expandTournamentPanels(parsed);
                } catch {
                    // In-progress JSONL remains covered by the contextual text scan.
                }
            }
            scanText(line, allNumbers);
        };
        try {
            for (;;) {
                const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
                if (bytes === 0) break;
                pending += decoder.write(buffer.subarray(0, bytes));
                let newline = pending.indexOf("\n");
                while (newline >= 0) {
                    consume(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);
                    newline = pending.indexOf("\n");
                }
                if (pending.length > WAIT_V3_STAGE_A_MAX_SCAN_LINE_CHARACTERS) {
                    throw new Error(`Seed-corpus text line is too long: ${path}`);
                }
            }
            pending += decoder.end();
            if (pending.length > WAIT_V3_STAGE_A_MAX_SCAN_LINE_CHARACTERS) {
                throw new Error(`Seed-corpus text line is too long: ${path}`);
            }
            if (pending) consume(pending);
        } finally {
            closeSync(descriptor);
        }
    };
    const isBinary = (path: string, size: number): boolean => {
        const descriptor = openSync(path, "r");
        const sample = Buffer.allocUnsafe(Math.min(size, 8192));
        try {
            const bytes = readSync(descriptor, sample, 0, sample.length, 0);
            return sample.subarray(0, bytes).includes(0);
        } finally {
            closeSync(descriptor);
        }
    };
    const assertUnchanged = (snapshot: FileSnapshot): void => {
        const observed = lstatSync(snapshot.path);
        if (
            !observed.isFile() ||
            observed.dev !== snapshot.dev ||
            observed.ino !== snapshot.ino ||
            observed.size !== snapshot.size ||
            observed.mtimeMs !== snapshot.mtimeMs ||
            observed.ctimeMs !== snapshot.ctimeMs
        ) {
            throw new Error(`Seed-corpus file changed during audit: ${snapshot.path}`);
        }
    };

    for (const snapshot of [...files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        assertUnchanged(snapshot);
        if (isBinary(snapshot.path, snapshot.size)) {
            assertUnchanged(snapshot);
            continue;
        }
        const extension = extname(snapshot.path).toLowerCase();
        const allNumbers = /seed/i.test(basename(snapshot.path)) || /[\\/]manifests[\\/]/.test(snapshot.path);
        if (extension === ".json" && snapshot.size <= WAIT_V3_STAGE_A_MAX_SCAN_LINE_CHARACTERS) {
            const text = readFileSync(snapshot.path, "utf8");
            try {
                const parsed = JSON.parse(text) as unknown;
                visitStructured(parsed);
                expandTournamentPanels(parsed);
            } catch {
                // Malformed or in-progress JSON remains covered by the text fallback.
            }
            scanText(text, allNumbers);
        } else {
            scanStream(snapshot.path, extension === ".jsonl", allNumbers);
        }
        assertUnchanged(snapshot);
    }
    return tokens;
}

export function auditWaitV3StageASeedRoots(
    manifest: IWaitV3StageAManifest,
    roots: readonly string[],
): IWaitV3StageASeedAudit {
    const existing = roots.map((root) => resolve(root)).filter(existsSync);
    if (!existing.length) throw new Error("Wait V3 Stage-A seed audit has no existing roots");
    const tokens = discoverWaitV3StageASeedTokens(existing);
    const collisions = findWaitV3StageASeedCollisions(manifest, tokens);
    if (collisions.length) {
        throw new Error(`Wait V3 Stage-A fresh-seed collision(s): ${collisions.slice(0, 20).join(", ")}`);
    }
    return { roots: existing, numericTokens: tokens.size, collisions };
}

export function defaultWaitV3StageASeedAuditRoots(projectRoot: string = PROJECT_ROOT): string[] {
    const candidates = [
        join(projectRoot, "docs"),
        join(projectRoot, "src/simulation/manifests"),
        join(projectRoot, "scratchpad"),
        join(dirname(projectRoot), "hoc-common-v07-overnight-runs"),
        join(homedir(), "hoc-common-v07-dbe9356"),
        join(homedir(), "hoc-common-v07-overnight-runs"),
    ];
    return [...new Set(candidates.map((candidate) => resolve(candidate)))].filter(existsSync);
}

function isBehaviorKey(key: string): boolean {
    return BEHAVIOR_EXACT.has(key) || BEHAVIOR_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function waitV3StageAEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
        if (!isBehaviorKey(key) && value !== undefined) environment[key] = value;
    }
    environment.LIVETWIN = "1";
    environment.SIM_NO_ACTIONS = "1";
    environment.FIGHT_MELEE_ROSTERS = "0";
    environment.Q2_ORACLE = "1";
    environment.Q2_DATASET_V2 = "1";
    environment.SEARCH_VERSIONS = "v0.7";
    environment.SEARCH_GATE = "0.01";
    environment.SEARCH_ROLLOUTS = "3";
    environment.SEARCH_AUDIT_TURNS = "0";
    environment.V07_VALUE_WEIGHTS = "material";
    environment.V07_WAIT_WEIGHTS_V2 = WAIT_V3_STAGE_A_V2_JSON;
    environment.V07_WAIT_WEIGHTS_V3 = WAIT_V3_STAGE_A_SENTINEL_JSON;
    return environment;
}

function effectiveBehaviorEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(environment)
            .filter(([key, value]) => isBehaviorKey(key) && value !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)) as [string, string][],
    );
}

function fileHash(path: string): string {
    return sha256(readFileSync(path));
}

function expectedVersions(manifest: IWaitV3StageAManifest, game: number): { green: string; red: string } {
    return game % 2 === 0
        ? { green: manifest.candidate, red: manifest.opponent }
        : { green: manifest.opponent, red: manifest.candidate };
}

function gamePaths(
    runDir: string,
    cohort: IWaitV3StageACohort,
    game: number,
): {
    q2: string;
    audit: string;
    result: string;
} {
    const stem = game.toString().padStart(5, "0");
    return {
        q2: join(runDir, "raw", cohort.id, `${stem}.q2.jsonl`),
        audit: join(runDir, "audit", cohort.id, `${stem}.audit.jsonl`),
        result: join(runDir, "games", cohort.id, `${stem}.json`),
    };
}

function exactMirrorRoster(cohort: IWaitV3StageACohort, seed: number): IArmyUnitSpec[] {
    const selected =
        cohort.roster === "pure_ranged_exact"
            ? PURE_RANGED
            : buildArchetypeRoster(cohort.roster as ArchetypeName, buildSharedArchetypeOffers(makeRng(seed))).roster;
    return selected.map((unit) => {
        const catalog = creaturesByLevel(unit.level).find((entry) => entry.creatureName === unit.creatureName);
        if (!catalog) throw new Error(`Missing Stage-A creature ${unit.creatureName}`);
        return {
            faction: catalog.faction,
            creatureName: catalog.creatureName,
            level: catalog.level,
            size: catalog.size,
            amount: resolveStackAmount(catalog.creatureName, catalog.level, DEFAULT_AMOUNT_BY_LEVEL, "expBudget"),
        };
    });
}

function playStageAGame(
    manifest: IWaitV3StageAManifest,
    cohort: IWaitV3StageACohort,
    game: number,
    runFingerprint: string,
): IWaitV3StageAGameArtifact {
    const seed = expectedWaitV3StageASeed(cohort, game);
    const versions = expectedVersions(manifest, game);
    let result: IMatchResult;
    if (cohort.kind === "draft") {
        const options: ITournamentOptions = {
            versionA: manifest.candidate,
            versionB: manifest.opponent,
            games: cohort.games,
            baseSeed: cohort.baseSeed,
            amountMode: "expBudget",
            randomizePicks: true,
            lightweight: true,
        };
        result = playGame(options, game).result;
    } else {
        const roster = exactMirrorRoster(cohort, seed);
        const setupName = cohort.setup === "livetwin" ? "melee_coevo" : cohort.setup;
        const setup = setupForArchetype(setupName as ArchetypeName);
        FightStateManager.getInstance();
        result = runMatch({
            greenVersion: versions.green,
            redVersion: versions.red,
            roster: roster.map((unit) => ({ ...unit })),
            redRoster: roster.map((unit) => ({ ...unit })),
            seed,
            gridType: PBTypes.GridVals.NORMAL,
            greenPerk: setup.perk,
            redPerk: setup.perk,
            greenAugments: setup.augments.map((augment) => ({ ...augment })),
            redAugments: setup.augments.map((augment) => ({ ...augment })),
        });
    }
    if (result.seed >>> 0 !== seed) throw new Error(`${cohort.id}/${game}: match seed drifted`);
    return {
        schemaVersion: 1,
        runFingerprint,
        cohort: cohort.id,
        game,
        seed,
        greenVersion: versions.green,
        redVersion: versions.red,
        winner: result.winner,
        endReason: result.endReason,
        laps: result.laps,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen ?? null,
        rejectedRed: result.rejectedRed ?? null,
    };
}

interface IStageAWorkerEnvelope {
    marker: "v0.7-wait-v3-stage-a-worker";
    manifest: IWaitV3StageAManifest;
    cohort: IWaitV3StageACohort;
    runDir: string;
    runFingerprint: string;
    environment: Record<string, string>;
}

if (!isMainThread && parentPort) {
    const envelope = workerData as IStageAWorkerEnvelope;
    if (envelope.marker === "v0.7-wait-v3-stage-a-worker") {
        for (const key of Object.keys(process.env)) {
            if (isBehaviorKey(key)) delete process.env[key];
        }
        Object.assign(process.env, envelope.environment);
        const port = parentPort;
        port.on("message", (message: { type: "game"; game: number } | { type: "stop" }) => {
            if (message.type === "stop") {
                port.close();
                return;
            }
            const paths = gamePaths(envelope.runDir, envelope.cohort, message.game);
            try {
                for (const path of [paths.q2, paths.audit]) {
                    mkdirSync(dirname(path), { recursive: true });
                    if (existsSync(path)) unlinkSync(path);
                }
                process.env.Q2_DATASET = paths.q2;
                process.env.SEARCH_AUDIT = paths.audit;
                const artifact = playStageAGame(
                    envelope.manifest,
                    envelope.cohort,
                    message.game,
                    envelope.runFingerprint,
                );
                port.postMessage({ type: "result", artifact });
            } catch (error) {
                port.postMessage({
                    type: "error",
                    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
                });
            }
        });
        port.postMessage({ type: "ready" });
    }
}

function parseAuditRow(path: string): IWaitV3StageAAuditRow {
    if (!existsSync(path)) throw new Error(`Missing Stage-A audit ${path}`);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error(`${path}: expected exactly one game audit row; got ${lines.length}`);
    const row = requireRecord(JSON.parse(lines[0]), path);
    if (row.t !== "game" || row.mode !== "oracle") throw new Error(`${path}: expected one oracle game row`);
    return row as IWaitV3StageAAuditRow;
}

export function validateWaitV3StageAGameArtifacts(
    runDir: string,
    manifest: IWaitV3StageAManifest,
    cohort: IWaitV3StageACohort,
    game: number,
    runFingerprint: string,
): { result: IWaitV3StageAGameArtifact; q2Text: string; auditText: string; scoredRows: number } {
    const paths = gamePaths(runDir, cohort, game);
    if (!existsSync(paths.result)) throw new Error(`Missing Stage-A result ${paths.result}`);
    const result = requireRecord(readJson(paths.result), paths.result) as unknown as IWaitV3StageAGameArtifact;
    const seed = expectedWaitV3StageASeed(cohort, game);
    const versions = expectedVersions(manifest, game);
    if (
        result.schemaVersion !== 1 ||
        result.runFingerprint !== runFingerprint ||
        result.cohort !== cohort.id ||
        result.game !== game ||
        result.seed !== seed ||
        result.greenVersion !== versions.green ||
        result.redVersion !== versions.red
    ) {
        throw new Error(`${paths.result}: result identity mismatch`);
    }
    if (!(["green", "red", "draw"] as const).includes(result.winner)) {
        throw new Error(`${paths.result}: invalid winner ${String(result.winner)}`);
    }
    if (!(["elimination", "turn_cap", "stuck"] as const).includes(result.endReason)) {
        throw new Error(`${paths.result}: invalid end reason ${String(result.endReason)}`);
    }
    if (
        !Number.isSafeInteger(result.laps) ||
        result.laps < 1 ||
        typeof result.decidedByArmageddon !== "boolean" ||
        result.rejectedGreen !== 0 ||
        result.rejectedRed !== 0
    ) {
        throw new Error(`${paths.result}: invalid outcome or nonzero engine rejection count`);
    }
    const audit = parseAuditRow(paths.audit);
    if (
        audit.seed >>> 0 !== seed ||
        audit.green !== versions.green ||
        audit.red !== versions.red ||
        audit.winner !== result.winner ||
        audit.endReason !== result.endReason ||
        audit.gate !== manifest.oracle.gate ||
        audit.horizon !== manifest.oracle.horizon ||
        audit.rollouts !== manifest.oracle.rollouts ||
        audit.leaf !== manifest.oracle.leaf
    ) {
        throw new Error(`${paths.audit}: audit identity/configuration mismatch`);
    }
    const points = requireInteger(audit.q2oPoints, `${paths.audit}.q2oPoints`, 1);
    const scored = requireInteger(audit.q2oScored, `${paths.audit}.q2oScored`);
    const kept = requireInteger(audit.q2oIncumbentWait, `${paths.audit}.q2oIncumbentWait`);
    const rejected = requireInteger(audit.q2oWaitRejected, `${paths.audit}.q2oWaitRejected`);
    if (scored + kept !== points) throw new Error(`${paths.audit}: Q2 point accounting mismatch`);
    if (rejected !== 0) throw new Error(`${paths.audit}: Q2 wait rejection tripwire fired ${rejected} time(s)`);
    const q2Text = readFileSync(paths.q2, "utf8");
    const lines = q2Text.split("\n").filter(Boolean);
    if (lines.length !== points) {
        throw new Error(`${paths.q2}: expected ${points} Q2 rows from audit; got ${lines.length}`);
    }
    let scoredRows = 0;
    for (let line = 0; line < lines.length; line += 1) {
        const parsed = parsePhaseBQ2Row(
            JSON.parse(lines[line]),
            WAIT_FEATURE_NAMES_V2_RAW.length,
            runFingerprint,
            `${paths.q2}:${line + 1}`,
        );
        if (
            parsed.seed !== seed ||
            parsed.greenVersion !== versions.green ||
            parsed.redVersion !== versions.red ||
            parsed.oracle.gate !== manifest.oracle.gate ||
            parsed.oracle.rollouts !== manifest.oracle.rollouts ||
            parsed.oracle.horizon !== manifest.oracle.horizon ||
            parsed.oracle.leaf !== manifest.oracle.leaf ||
            parsed.oracle.opponentModel !== null
        ) {
            throw new Error(`${paths.q2}:${line + 1}: Q2 row identity/configuration mismatch`);
        }
        if (parsed.delta !== null) scoredRows += 1;
    }
    if (scoredRows !== scored - rejected) {
        throw new Error(`${paths.q2}: scored-row count ${scoredRows} differs from audit ${scored - rejected}`);
    }
    return { result, q2Text, auditText: readFileSync(paths.audit, "utf8"), scoredRows };
}

export function validateWaitV3StageAExactDirectoryEntries(path: string, expectedNames: readonly string[]): void {
    const expected = new Set(expectedNames);
    const actual = existsSync(path) ? readdirSync(path) : [];
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
        throw new Error(
            `${path}: expected exactly [${[...expected].sort().join(", ")}]; got [${actual.sort().join(", ")}]`,
        );
    }
}

function assertExactGameFiles(runDir: string, cohort: IWaitV3StageACohort): void {
    for (const [directory, suffix] of [
        [join(runDir, "raw", cohort.id), ".q2.jsonl"],
        [join(runDir, "audit", cohort.id), ".audit.jsonl"],
        [join(runDir, "games", cohort.id), ".json"],
    ] as const) {
        const expected = new Set(
            Array.from({ length: cohort.games }, (_, game) => `${game.toString().padStart(5, "0")}${suffix}`),
        );
        validateWaitV3StageAExactDirectoryEntries(directory, [...expected]);
    }
}

function artifactSummary(path: string): { bytes: number; sha256: string } {
    const content = readFileSync(path);
    return { bytes: content.length, sha256: sha256(content) };
}

interface IWaitV3StageABuiltDataset {
    path: string;
    text: string;
    bytes: number;
    sha256: string;
}

interface IWaitV3StageABuiltRaw {
    cohorts: IWaitV3StageACohortRawReport[];
    totalRows: number;
}

function buildWaitV3StageARaw(
    runDir: string,
    manifest: IWaitV3StageAManifest,
    runManifest: IWaitV3StageARunManifest,
    consumeDatasets: (datasets: readonly IWaitV3StageABuiltDataset[]) => void,
): IWaitV3StageABuiltRaw {
    const cohortIds = manifest.cohorts.map(({ id }) => id);
    for (const root of ["raw", "audit", "games"]) {
        validateWaitV3StageAExactDirectoryEntries(join(runDir, root), cohortIds);
    }
    const cohorts: IWaitV3StageACohortRawReport[] = [];
    let totalRows = 0;
    for (const cohort of manifest.cohorts) {
        assertExactGameFiles(runDir, cohort);
        let q2 = "";
        let audit = "";
        let games = "";
        let scoredRows = 0;
        for (let game = 0; game < cohort.games; game += 1) {
            const validated = validateWaitV3StageAGameArtifacts(
                runDir,
                manifest,
                cohort,
                game,
                runManifest.runFingerprint,
            );
            q2 += validated.q2Text.endsWith("\n") ? validated.q2Text : `${validated.q2Text}\n`;
            audit += validated.auditText.endsWith("\n") ? validated.auditText : `${validated.auditText}\n`;
            games += `${JSON.stringify(validated.result)}\n`;
            scoredRows += validated.scoredRows;
        }
        const q2Path = join(runDir, "datasets", `${cohort.id}.q2.jsonl`);
        const auditPath = join(runDir, "datasets", `${cohort.id}.audit.jsonl`);
        const gamesPath = join(runDir, "datasets", `${cohort.id}.games.jsonl`);
        const buildDataset = (path: string, text: string): IWaitV3StageABuiltDataset => ({
            path,
            text,
            bytes: Buffer.byteLength(text),
            sha256: sha256(text),
        });
        const q2Dataset = buildDataset(q2Path, q2);
        const auditDataset = buildDataset(auditPath, audit);
        const gamesDataset = buildDataset(gamesPath, games);
        consumeDatasets([q2Dataset, auditDataset, gamesDataset]);
        const q2Rows = q2.split("\n").filter(Boolean).length;
        totalRows += q2Rows;
        cohorts.push({
            id: cohort.id,
            games: cohort.games,
            q2Rows,
            q2ScoredRows: scoredRows,
            q2WaitRejected: 0,
            q2Path: relative(runDir, q2Path),
            q2Bytes: q2Dataset.bytes,
            q2Sha256: q2Dataset.sha256,
            auditPath: relative(runDir, auditPath),
            auditBytes: auditDataset.bytes,
            auditSha256: auditDataset.sha256,
            gamesPath: relative(runDir, gamesPath),
            gamesBytes: gamesDataset.bytes,
            gamesSha256: gamesDataset.sha256,
        });
    }
    return { cohorts, totalRows };
}

export interface IWaitV3StageARawCompletion {
    report: IWaitV3StageARawReport;
    rawCompleteSha256: string;
    rawReportSha256: string;
}

export function readCompletedWaitV3StageARaw(
    runDir: string,
    manifest: IWaitV3StageAManifest,
    runManifest: IWaitV3StageARunManifest,
): IWaitV3StageARawCompletion | null {
    const markerPath = join(runDir, manifest.completion.rawMarker);
    if (!existsSync(markerPath)) return null;
    const marker = requireRecord(readJson(markerPath), markerPath);
    const reportPath = join(runDir, "raw-report.json");
    if (
        marker.schemaVersion !== 1 ||
        marker.kind !== "v0.7_wait_v3_stage_a_raw_complete" ||
        !Number.isFinite(Date.parse(String(marker.completedAt))) ||
        marker.runFingerprint !== runManifest.runFingerprint ||
        marker.report !== "raw-report.json" ||
        typeof marker.reportSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(marker.reportSha256) ||
        typeof marker.artifactsSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(marker.artifactsSha256)
    ) {
        throw new Error(`${markerPath}: invalid completed raw marker`);
    }
    if (!existsSync(reportPath)) throw new Error(`${markerPath}: completed raw report is missing`);
    const rawReportSha256 = fileHash(reportPath);
    if (rawReportSha256 !== marker.reportSha256) {
        throw new Error(`${markerPath}: completed raw report hash mismatch`);
    }
    const report = readJson(reportPath) as IWaitV3StageARawReport;
    const expectedGames = manifest.cohorts.reduce((sum, cohort) => sum + cohort.games, 0);
    if (
        report.schemaVersion !== 1 ||
        report.kind !== "v0.7_wait_v3_stage_a_raw" ||
        report.verdict !== "PASS" ||
        !Number.isFinite(Date.parse(report.generatedAt)) ||
        report.runFingerprint !== runManifest.runFingerprint ||
        report.protocolSha256 !== runManifest.identity.protocol.sha256 ||
        report.runManifestSha256 !== fileHash(join(runDir, "run.json")) ||
        report.games !== expectedGames ||
        !Array.isArray(report.cohorts) ||
        report.cohorts.length !== manifest.cohorts.length
    ) {
        throw new Error(`${reportPath}: completed raw report identity mismatch`);
    }
    if (marker.artifactsSha256 !== sha256(stableJson(report.cohorts))) {
        throw new Error(`${markerPath}: completed raw artifact envelope hash mismatch`);
    }

    const built = buildWaitV3StageARaw(runDir, manifest, runManifest, (datasets) => {
        for (const expected of datasets) {
            if (!existsSync(expected.path)) throw new Error(`${expected.path}: completed raw dataset is missing`);
            const actual = artifactSummary(expected.path);
            if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
                throw new Error(`${expected.path}: completed raw dataset differs from source artifacts`);
            }
        }
    });
    if (report.q2Rows !== built.totalRows || stableJson(report.cohorts) !== stableJson(built.cohorts)) {
        throw new Error(`${reportPath}: completed raw report differs from source artifacts`);
    }
    validateWaitV3StageAExactDirectoryEntries(
        join(runDir, "datasets"),
        manifest.cohorts.flatMap(({ id }) => [`${id}.q2.jsonl`, `${id}.audit.jsonl`, `${id}.games.jsonl`]),
    );
    return {
        report,
        rawCompleteSha256: fileHash(markerPath),
        rawReportSha256,
    };
}

export function validateAndSealWaitV3StageARaw(
    runDir: string,
    manifest: IWaitV3StageAManifest,
    runManifest: IWaitV3StageARunManifest,
): IWaitV3StageARawReport {
    if (existsSync(join(runDir, manifest.completion.rawMarker))) {
        throw new Error("Refusing to rewrite an existing Wait V3 Stage-A raw completion");
    }
    const built = buildWaitV3StageARaw(runDir, manifest, runManifest, (datasets) => {
        for (const dataset of datasets) atomicWriteText(dataset.path, dataset.text);
    });
    validateWaitV3StageAExactDirectoryEntries(
        join(runDir, "datasets"),
        manifest.cohorts.flatMap(({ id }) => [`${id}.q2.jsonl`, `${id}.audit.jsonl`, `${id}.games.jsonl`]),
    );
    const runManifestPath = join(runDir, "run.json");
    const report: IWaitV3StageARawReport = {
        schemaVersion: 1,
        kind: "v0.7_wait_v3_stage_a_raw",
        verdict: "PASS",
        generatedAt: new Date().toISOString(),
        runFingerprint: runManifest.runFingerprint,
        protocolSha256: runManifest.identity.protocol.sha256,
        runManifestSha256: fileHash(runManifestPath),
        games: manifest.cohorts.reduce((sum, cohort) => sum + cohort.games, 0),
        q2Rows: built.totalRows,
        cohorts: built.cohorts,
    };
    const reportPath = join(runDir, "raw-report.json");
    atomicWriteJson(reportPath, report);
    const marker = {
        schemaVersion: 1,
        kind: "v0.7_wait_v3_stage_a_raw_complete",
        completedAt: new Date().toISOString(),
        runFingerprint: runManifest.runFingerprint,
        report: relative(runDir, reportPath),
        reportSha256: fileHash(reportPath),
        artifactsSha256: sha256(stableJson(built.cohorts)),
    };
    atomicWriteJson(join(runDir, manifest.completion.rawMarker), marker);
    return report;
}

async function executeCohort(
    runDir: string,
    manifest: IWaitV3StageAManifest,
    cohort: IWaitV3StageACohort,
    runFingerprint: string,
    environment: NodeJS.ProcessEnv,
    concurrency: number,
): Promise<void> {
    const pending: number[] = [];
    for (let game = 0; game < cohort.games; game += 1) {
        const paths = gamePaths(runDir, cohort, game);
        if (existsSync(paths.result)) {
            validateWaitV3StageAGameArtifacts(runDir, manifest, cohort, game, runFingerprint);
            continue;
        }
        for (const orphan of [paths.q2, paths.audit]) {
            if (existsSync(orphan)) unlinkSync(orphan);
        }
        pending.push(game);
    }
    if (!pending.length) return;
    const workerCount = Math.min(concurrency, pending.length);
    const workerEnvironment = Object.fromEntries(
        Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const workers = new Set<Worker>();
    let cursor = 0;
    let completed = cohort.games - pending.length;
    await new Promise<void>((resolvePromise, rejectPromise) => {
        let stopped = false;
        const terminateWorkers = async (): Promise<void> => {
            await Promise.all([...workers].map(async (worker) => void (await worker.terminate())));
        };
        const fail = (error: unknown): void => {
            if (stopped) return;
            stopped = true;
            const failure = error instanceof Error ? error : new Error(String(error));
            void terminateWorkers().then(
                () => rejectPromise(failure),
                () => rejectPromise(failure),
            );
        };
        const finish = (): void => {
            if (stopped) return;
            stopped = true;
            void terminateWorkers().then(resolvePromise, rejectPromise);
        };
        const next = (worker: Worker): void => {
            if (stopped) return;
            if (cursor >= pending.length) {
                worker.postMessage({ type: "stop" });
                return;
            }
            worker.postMessage({ type: "game", game: pending[cursor++] });
        };
        for (let index = 0; index < workerCount; index += 1) {
            const worker = new Worker(new URL(import.meta.url), {
                workerData: {
                    marker: "v0.7-wait-v3-stage-a-worker",
                    manifest,
                    cohort,
                    runDir,
                    runFingerprint,
                    environment: workerEnvironment,
                } satisfies IStageAWorkerEnvelope,
                // Install the frozen environment before this module's static policy imports execute.
                env: workerEnvironment,
            });
            workers.add(worker);
            worker.on("message", (message: { type: string; artifact?: IWaitV3StageAGameArtifact; error?: string }) => {
                if (stopped) return;
                if (message.type === "ready") {
                    next(worker);
                    return;
                }
                if (message.type === "error") {
                    fail(new Error(message.error ?? "Stage-A worker failed"));
                    return;
                }
                if (message.type !== "result" || !message.artifact) {
                    fail(new Error(`Unexpected Stage-A worker message ${message.type}`));
                    return;
                }
                const paths = gamePaths(runDir, cohort, message.artifact.game);
                atomicWriteJson(paths.result, message.artifact);
                validateWaitV3StageAGameArtifacts(runDir, manifest, cohort, message.artifact.game, runFingerprint);
                completed += 1;
                if (completed % 100 === 0 || completed === cohort.games) {
                    console.log(`${cohort.id}: ${completed}/${cohort.games} complete`);
                }
                if (completed === cohort.games) finish();
                else next(worker);
            });
            worker.on("error", fail);
            worker.on("exit", (code) => {
                workers.delete(worker);
                if (!stopped && code !== 0) {
                    fail(new Error(`Stage-A worker exited ${code}`));
                    return;
                }
                if (!stopped && workers.size === 0 && completed === cohort.games) {
                    stopped = true;
                    resolvePromise();
                }
            });
        }
    });
}

function readOrCreateRunManifest(
    runDir: string,
    manifest: IWaitV3StageAManifest,
    provenance: IWaitV3StageAManifestProvenance,
    revision: IRevisionProvenance,
    seedAudit: IWaitV3StageASeedAudit,
    environment: NodeJS.ProcessEnv,
    concurrency: number,
): IWaitV3StageARunManifest {
    const identity: IWaitV3StageARunIdentity = {
        protocol: provenance,
        revision,
        harnessSourceSha256: fileHash(fileURLToPath(import.meta.url)),
        fitWrapperSourceSha256: fileHash(FIT_WRAPPER_SOURCE),
        fitterSourceSha256: fileHash(FITTER_SOURCE),
        gateSourceSha256: fileHash(GATE_SOURCE),
        candidate: manifest.candidate,
        opponent: manifest.opponent,
        cohorts: manifest.cohorts,
        oracle: manifest.oracle,
        v2WeightsSha256: sha256(WAIT_V3_STAGE_A_V2_JSON),
        v3SentinelSha256: sha256(WAIT_V3_STAGE_A_SENTINEL_JSON),
        effectiveBehaviorEnvironment: effectiveBehaviorEnvironment(environment),
        seedAudit,
        automaticBake: false,
        automaticDeploy: false,
    };
    const runFingerprint = sha256(stableJson(identity));
    const path = join(runDir, "run.json");
    if (existsSync(path)) {
        const existing = readJson(path) as IWaitV3StageARunManifest;
        if (
            existing.schemaVersion !== 1 ||
            existing.runFingerprint !== runFingerprint ||
            stableJson(existing.identity) !== stableJson(identity)
        ) {
            throw new Error(`${path}: cannot resume under different Stage-A provenance`);
        }
        return existing;
    }
    const runManifest: IWaitV3StageARunManifest = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runFingerprint,
        concurrency,
        identity,
    };
    atomicWriteJson(path, runManifest);
    return runManifest;
}

export async function runWaitV3StageA(options: {
    runDir: string;
    concurrency: number;
    seedAuditRoots?: string[];
    rawOnly?: boolean;
}): Promise<IWaitV3StageARawReport> {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 64) {
        throw new Error(`Stage-A concurrency must be an integer in [1,64]; got ${options.concurrency}`);
    }
    const runDir = resolve(options.runDir);
    const { manifest, provenance } = readWaitV3StageAManifest();
    const revision = readCleanMainRevision();
    const runPath = join(runDir, "run.json");
    const roots = options.seedAuditRoots ?? defaultWaitV3StageASeedAuditRoots();
    const seedAudit = existsSync(runPath)
        ? (readJson(runPath) as IWaitV3StageARunManifest).identity.seedAudit
        : auditWaitV3StageASeedRoots(manifest, roots);
    mkdirSync(runDir, { recursive: true });
    const environment = waitV3StageAEnvironment();
    const runManifest = readOrCreateRunManifest(
        runDir,
        manifest,
        provenance,
        revision,
        seedAudit,
        environment,
        options.concurrency,
    );
    process.env.PHASE_B_RUN_FINGERPRINT = runManifest.runFingerprint;
    environment.PHASE_B_RUN_FINGERPRINT = runManifest.runFingerprint;
    const completedRaw = readCompletedWaitV3StageARaw(runDir, manifest, runManifest);
    let report: IWaitV3StageARawReport;
    if (completedRaw) {
        report = completedRaw.report;
    } else {
        for (const cohort of manifest.cohorts) {
            await executeCohort(runDir, manifest, cohort, runManifest.runFingerprint, environment, options.concurrency);
        }
        report = validateAndSealWaitV3StageARaw(runDir, manifest, runManifest);
    }
    if (!options.rawOnly) {
        const fit = spawnSync(process.execPath, [FIT_WRAPPER_SOURCE, "--run-dir", runDir], {
            cwd: PROJECT_ROOT,
            env: waitV3StageAEnvironment(process.env),
            encoding: "utf8",
            stdio: "inherit",
        });
        if (fit.error) throw fit.error;
        if (fit.status !== 0) throw new Error(`Wait V3 Stage-A fitter wrapper exited ${fit.status}`);
    }
    return report;
}

async function main(): Promise<void> {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            out: { type: "string" },
            concurrency: { type: "string", default: "12" },
            "raw-only": { type: "boolean", default: false },
            "preflight-only": { type: "boolean", default: false },
            "seed-audit-root": { type: "string", multiple: true },
        },
        strict: true,
        allowPositionals: false,
    });
    if (parsed.values["preflight-only"]) {
        const { manifest } = readWaitV3StageAManifest();
        const revision = readCleanMainRevision();
        const roots = parsed.values["seed-audit-root"] ?? defaultWaitV3StageASeedAuditRoots();
        const audit = auditWaitV3StageASeedRoots(manifest, roots);
        console.log(JSON.stringify({ verdict: "PASS", revision, seedAudit: audit }, null, 2));
        return;
    }
    if (!parsed.values.out) {
        throw new Error(
            "usage: bun src/simulation/v0_7_wait_v3_stage_a.ts --out <new-or-resumable-run-dir> " +
                "[--concurrency 12] [--raw-only] [--preflight-only] [--seed-audit-root path ...]",
        );
    }
    const concurrency = Number(parsed.values.concurrency);
    await runWaitV3StageA({
        runDir: parsed.values.out,
        concurrency,
        seedAuditRoots: parsed.values["seed-audit-root"],
        rawOnly: parsed.values["raw-only"],
    });
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
