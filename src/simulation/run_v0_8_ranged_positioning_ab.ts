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

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    buildV08A13SearchEnvironment,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_SOURCE_VERSION,
} from "../ai/versions/v0_8_a13_profile";
import { MIRROR_COHORTS, type MirrorCohortName } from "./measure_mirror_cohorts";
import {
    PURE_RANGED_JIT_NO_MELEE_FOCUS_ACTIVATION_BUFFER,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP,
    PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
} from "./pure_ranged_jit_no_melee_focus";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
export const V08_RANGED_POSITIONING_AB_RUNNER = join(REPOSITORY_ROOT, "src/simulation/measure_mirror_cohorts.ts");
export const V08_RANGED_POSITIONING_AB_VERSIONS = `${V08_A13_PRODUCTION_VERSION},${V08_A13_SOURCE_VERSION}` as const;

const A13_VERSION_SCOPE_KEYS = [
    "SEARCH_VERSIONS",
    "V06_MELEE_DIMS_VERSIONS",
    "V07_AURA_CASTER_ROUTER_VERSIONS",
    "V07_DENSE_MM_SALVAGE_ISOLATION_VERSIONS",
    "V07_PLACEMENT_REVEAL_VERSIONS",
] as const;

/** Only execution essentials survive; inherited experiments cannot contaminate this A/B. */
const INHERITED_OS_ENVIRONMENT_KEYS = [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
] as const;

export type V08RangedPositioningMode = "advance" | "retreat" | "both" | "off";
export type V08RangedPositioningTimingMode = "research_unbounded" | "operational_bounded";
export type V08RangedPositioningMoveShots = 0 | 1 | 2;

export interface IV08RangedPositioningABOptions {
    cohorts: readonly MirrorCohortName[];
    games: number;
    seed: number;
    concurrency: number;
    out: string;
    mode: V08RangedPositioningMode;
    timingMode: V08RangedPositioningTimingMode;
    moveShots?: V08RangedPositioningMoveShots;
    noMeleeTerminalPressure?: boolean;
    deadlineFinisher?: boolean;
    paretoNoMeleeFocus?: boolean;
    /** Enables identical target-covered catalogs for both seats without allowing either selector to fire. */
    paretoNoMeleeFocusCatalogOnly?: boolean;
    paretoNoMeleeFocusDamageFloor?: number;
    jitNoMeleeFocus?: boolean;
    /** Enables the JIT arm's target-covered catalog for both seats while disabling its selector. */
    jitNoMeleeFocusCatalogOnly?: boolean;
    supportedRangedDelta?: boolean;
    responseNeutralAdvance?: boolean;
    diag?: boolean;
}

export interface IV08RangedPositioningABInvocation {
    cohort: MirrorCohortName;
    args: string[];
    environment: NodeJS.ProcessEnv;
    outBase: string;
    /** Absolute, cohort-local SearchDriver JSONL artifact. Present for a measured target-focus arm. */
    searchAuditPath?: string;
}

export interface IV08RangedPositioningABSourceIdentity {
    head: string | null;
    tree: string | null;
    dirty: boolean | null;
}

export interface IV08RangedPositioningABManifest {
    schema: "hoc.v0_8_ranged_positioning_ab_experiment.v3";
    source: IV08RangedPositioningABSourceIdentity;
    geometry: {
        cohort: MirrorCohortName;
        games: number;
        seed: number;
        concurrency: number;
        amountMode: "expBudget";
        livetwin: true;
        pairedSideSwap: true;
        symmetricRosters: true;
    };
    arm: {
        mode: V08RangedPositioningMode;
        timingMode: V08RangedPositioningTimingMode;
        moveShots: V08RangedPositioningMoveShots;
        noMeleeTerminalPressure: boolean;
        deadlineFinisher: boolean;
        paretoNoMeleeFocus: boolean;
        paretoNoMeleeFocusCatalogOnly: boolean;
        paretoNoMeleeFocusDamageFloor: number;
        jitNoMeleeFocus: boolean;
        jitNoMeleeFocusCatalogOnly: boolean;
        jitNoMeleeFocusStartLap: number;
        jitNoMeleeFocusLastLap: number;
        jitNoMeleeFocusActivationBuffer: number;
        jitNoMeleeFocusDamageFloor: number;
        supportedRangedDelta: boolean;
        responseNeutralAdvance: boolean;
        diag: boolean;
        candidateVersion: typeof V08_A13_PRODUCTION_VERSION;
        controlVersion: typeof V08_A13_SOURCE_VERSION;
    };
    behaviorEnvironment: Readonly<Record<string, string>>;
    artifacts: {
        summary: string;
        searchAudit?: string;
    };
    fingerprintSha256: string;
}

export interface IV08RangedPositioningABDependencies {
    runChild?: (invocation: IV08RangedPositioningABInvocation) => Promise<number>;
    discoverSourceIdentity?: () => IV08RangedPositioningABSourceIdentity;
    writeManifest?: (path: string, manifest: IV08RangedPositioningABManifest) => void;
    /** Test seam around artifact preparation; production truncates the audit immediately before launch. */
    prepareInvocation?: (invocation: IV08RangedPositioningABInvocation) => void | Promise<void>;
}

const positiveInteger = (value: number, name: string): void => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
};

const isPositioningMode = (value: string): value is V08RangedPositioningMode =>
    value === "advance" || value === "retreat" || value === "both" || value === "off";

const isTimingMode = (value: string): value is V08RangedPositioningTimingMode =>
    value === "research_unbounded" || value === "operational_bounded";

const isMoveShotCap = (value: number): value is V08RangedPositioningMoveShots =>
    value === 0 || value === 1 || value === 2;

const isParetoDamageFloor = (value: number): boolean => value === 0.9 || value === 0.95 || value === 1;

function validateBehaviorArmGeometry(
    mode: V08RangedPositioningMode,
    moveShots: V08RangedPositioningMoveShots,
    noMeleeTerminalPressure: boolean,
    deadlineFinisher: boolean,
    paretoNoMeleeFocus: boolean,
    jitNoMeleeFocus: boolean,
    supportedRangedDelta: boolean,
    responseNeutralAdvance: boolean,
): void {
    const enabledSpecialArms = [
        noMeleeTerminalPressure,
        deadlineFinisher,
        paretoNoMeleeFocus,
        jitNoMeleeFocus,
        supportedRangedDelta,
        responseNeutralAdvance,
    ].filter(Boolean).length;
    if (enabledSpecialArms > 1) {
        throw new Error(
            "noMeleeTerminalPressure, deadlineFinisher, paretoNoMeleeFocus, jitNoMeleeFocus, " +
                "supportedRangedDelta, and responseNeutralAdvance are mutually exclusive",
        );
    }
    if (noMeleeTerminalPressure && (mode !== "off" || moveShots !== 0)) {
        throw new Error("noMeleeTerminalPressure requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (deadlineFinisher && (mode !== "off" || moveShots !== 0)) {
        throw new Error("deadlineFinisher requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (paretoNoMeleeFocus && (mode !== "off" || moveShots !== 0)) {
        throw new Error("paretoNoMeleeFocus requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (jitNoMeleeFocus && (mode !== "off" || moveShots !== 0)) {
        throw new Error("jitNoMeleeFocus requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (supportedRangedDelta && ((mode !== "retreat" && mode !== "both") || moveShots !== 0)) {
        throw new Error("supportedRangedDelta requires mode=retreat|both and moveShots=0");
    }
    if (responseNeutralAdvance && ((mode !== "advance" && mode !== "both") || moveShots !== 0)) {
        throw new Error("responseNeutralAdvance requires mode=advance|both and moveShots=0");
    }
}

export function normalizeV08RangedPositioningCohorts(raw: string): MirrorCohortName[] {
    const cohorts = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    if (!cohorts.length) throw new Error("cohorts must contain at least one mirror cohort");
    const seen = new Set<string>();
    for (const cohort of cohorts) {
        if (!MIRROR_COHORTS.includes(cohort as MirrorCohortName)) {
            throw new Error(`unknown cohort \"${cohort}\"; allowed cohorts: ${MIRROR_COHORTS.join(",")}`);
        }
        if (seen.has(cohort)) throw new Error(`duplicate cohort \"${cohort}\"`);
        seen.add(cohort);
    }
    return cohorts as MirrorCohortName[];
}

function validateOptions(options: IV08RangedPositioningABOptions): void {
    if (!options.cohorts.length) throw new Error("cohorts must contain at least one mirror cohort");
    for (const cohort of options.cohorts) {
        if (!MIRROR_COHORTS.includes(cohort)) throw new Error(`unknown cohort \"${cohort}\"`);
    }
    if (new Set(options.cohorts).size !== options.cohorts.length) throw new Error("cohorts must be unique");
    positiveInteger(options.games, "games");
    if (options.games < 2 || options.games % 2 !== 0) {
        throw new Error("games must be an even integer >= 2 for paired side swaps");
    }
    positiveInteger(options.concurrency, "concurrency");
    if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
        throw new Error("seed must be a uint32");
    }
    if (!options.out.trim()) throw new Error("out must not be empty");
    if (!isPositioningMode(options.mode)) throw new Error("mode must be advance|retreat|both|off");
    if (!isTimingMode(options.timingMode)) {
        throw new Error("timingMode must be research_unbounded|operational_bounded");
    }
    if (!isMoveShotCap(options.moveShots ?? 0)) throw new Error("moveShots must be 0|1|2");
    if (options.noMeleeTerminalPressure !== undefined && typeof options.noMeleeTerminalPressure !== "boolean") {
        throw new Error("noMeleeTerminalPressure must be a boolean");
    }
    if (options.deadlineFinisher !== undefined && typeof options.deadlineFinisher !== "boolean") {
        throw new Error("deadlineFinisher must be a boolean");
    }
    if (options.paretoNoMeleeFocus !== undefined && typeof options.paretoNoMeleeFocus !== "boolean") {
        throw new Error("paretoNoMeleeFocus must be a boolean");
    }
    if (
        options.paretoNoMeleeFocusCatalogOnly !== undefined &&
        typeof options.paretoNoMeleeFocusCatalogOnly !== "boolean"
    ) {
        throw new Error("paretoNoMeleeFocusCatalogOnly must be a boolean");
    }
    if (options.paretoNoMeleeFocus && options.paretoNoMeleeFocusCatalogOnly) {
        throw new Error("paretoNoMeleeFocus and paretoNoMeleeFocusCatalogOnly are mutually exclusive");
    }
    const paretoDamageFloor = options.paretoNoMeleeFocusDamageFloor ?? 1;
    if (!isParetoDamageFloor(paretoDamageFloor)) {
        throw new Error("paretoNoMeleeFocusDamageFloor must be one of 0.9, 0.95, or 1");
    }
    if (!options.paretoNoMeleeFocus && paretoDamageFloor !== 1) {
        throw new Error("paretoNoMeleeFocusDamageFloor below 1 requires paretoNoMeleeFocus");
    }
    if (options.jitNoMeleeFocus !== undefined && typeof options.jitNoMeleeFocus !== "boolean") {
        throw new Error("jitNoMeleeFocus must be a boolean");
    }
    if (options.jitNoMeleeFocusCatalogOnly !== undefined && typeof options.jitNoMeleeFocusCatalogOnly !== "boolean") {
        throw new Error("jitNoMeleeFocusCatalogOnly must be a boolean");
    }
    if (options.jitNoMeleeFocus && options.jitNoMeleeFocusCatalogOnly) {
        throw new Error("jitNoMeleeFocus and jitNoMeleeFocusCatalogOnly are mutually exclusive");
    }
    if (options.supportedRangedDelta !== undefined && typeof options.supportedRangedDelta !== "boolean") {
        throw new Error("supportedRangedDelta must be a boolean");
    }
    if (options.responseNeutralAdvance !== undefined && typeof options.responseNeutralAdvance !== "boolean") {
        throw new Error("responseNeutralAdvance must be a boolean");
    }
    validateBehaviorArmGeometry(
        options.mode,
        options.moveShots ?? 0,
        options.noMeleeTerminalPressure ?? false,
        options.deadlineFinisher ?? false,
        (options.paretoNoMeleeFocus ?? false) || (options.paretoNoMeleeFocusCatalogOnly ?? false),
        (options.jitNoMeleeFocus ?? false) || (options.jitNoMeleeFocusCatalogOnly ?? false),
        options.supportedRangedDelta ?? false,
        options.responseNeutralAdvance ?? false,
    );
    if (options.noMeleeTerminalPressure && (options.cohorts.length !== 1 || options.cohorts[0] !== "pure_ranged")) {
        throw new Error("noMeleeTerminalPressure requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (options.deadlineFinisher && (options.cohorts.length !== 1 || options.cohorts[0] !== "pure_ranged")) {
        throw new Error("deadlineFinisher requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (
        (options.paretoNoMeleeFocus || options.paretoNoMeleeFocusCatalogOnly) &&
        (options.cohorts.length !== 1 || options.cohorts[0] !== "pure_ranged")
    ) {
        throw new Error("paretoNoMeleeFocus requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (
        (options.jitNoMeleeFocus || options.jitNoMeleeFocusCatalogOnly) &&
        (options.cohorts.length !== 1 || options.cohorts[0] !== "pure_ranged")
    ) {
        throw new Error("jitNoMeleeFocus requires cohorts=pure_ranged, mode=off, and moveShots=0");
    }
    if (options.diag !== undefined && typeof options.diag !== "boolean") throw new Error("diag must be a boolean");
}

function minimalChildEnvironment(sourceEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_OS_ENVIRONMENT_KEYS) {
        const value = sourceEnvironment[key];
        if (value !== undefined) environment[key] = value;
    }
    environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    return environment;
}

const EXECUTION_ONLY_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
    ...INHERITED_OS_ENVIRONMENT_KEYS,
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    // The absolute append target is artifact routing, not AI behavior. Its declared manifest artifact binds it.
    "SEARCH_AUDIT",
]);

const compareCanonicalKeys = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => compareCanonicalKeys(left, right))
                .map(([key, entry]) => [key, canonicalize(entry)]),
        );
    }
    return value;
};

const fingerprint = (value: unknown): string =>
    createHash("sha256")
        .update(JSON.stringify(canonicalize(value)))
        .digest("hex");

export function extractV08RangedPositioningBehaviorEnvironment(
    environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
    return Object.freeze(
        Object.fromEntries(
            Object.entries(environment)
                .filter(
                    (entry): entry is [string, string] =>
                        entry[1] !== undefined && !EXECUTION_ONLY_ENVIRONMENT_KEYS.has(entry[0]),
                )
                .sort(([left], [right]) => compareCanonicalKeys(left, right)),
        ),
    );
}

export function discoverV08RangedPositioningABSourceIdentity(
    repositoryRoot: string = REPOSITORY_ROOT,
): IV08RangedPositioningABSourceIdentity {
    const git = (args: readonly string[]): string | null => {
        try {
            return execFileSync("git", ["-C", repositoryRoot, ...args], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
            }).trim();
        } catch {
            return null;
        }
    };
    const head = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const status = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
    return {
        head: head || null,
        tree: tree || null,
        dirty: status === null ? null : status.length > 0,
    };
}

export function buildV08RangedPositioningABManifest(
    invocation: IV08RangedPositioningABInvocation,
    options: IV08RangedPositioningABOptions,
    source: IV08RangedPositioningABSourceIdentity,
): IV08RangedPositioningABManifest {
    const moveShots = options.moveShots ?? 0;
    const payload = {
        schema: "hoc.v0_8_ranged_positioning_ab_experiment.v3" as const,
        source,
        geometry: {
            cohort: invocation.cohort,
            games: options.games,
            seed: options.seed,
            concurrency: Math.min(options.concurrency, options.games),
            amountMode: "expBudget" as const,
            livetwin: true as const,
            pairedSideSwap: true as const,
            symmetricRosters: true as const,
        },
        arm: {
            mode: options.mode,
            timingMode: options.timingMode,
            moveShots,
            noMeleeTerminalPressure: options.noMeleeTerminalPressure ?? false,
            deadlineFinisher: options.deadlineFinisher ?? false,
            paretoNoMeleeFocus: options.paretoNoMeleeFocus ?? false,
            paretoNoMeleeFocusCatalogOnly: options.paretoNoMeleeFocusCatalogOnly ?? false,
            paretoNoMeleeFocusDamageFloor: options.paretoNoMeleeFocusDamageFloor ?? 1,
            jitNoMeleeFocus: options.jitNoMeleeFocus ?? false,
            jitNoMeleeFocusCatalogOnly: options.jitNoMeleeFocusCatalogOnly ?? false,
            jitNoMeleeFocusStartLap: PURE_RANGED_JIT_NO_MELEE_FOCUS_START_LAP,
            jitNoMeleeFocusLastLap: PURE_RANGED_JIT_NO_MELEE_FOCUS_LAST_LAP,
            jitNoMeleeFocusActivationBuffer: PURE_RANGED_JIT_NO_MELEE_FOCUS_ACTIVATION_BUFFER,
            jitNoMeleeFocusDamageFloor: PURE_RANGED_JIT_NO_MELEE_FOCUS_DAMAGE_FLOOR,
            supportedRangedDelta: options.supportedRangedDelta ?? false,
            responseNeutralAdvance: options.responseNeutralAdvance ?? false,
            diag: options.diag ?? false,
            candidateVersion: V08_A13_PRODUCTION_VERSION,
            controlVersion: V08_A13_SOURCE_VERSION,
        },
        behaviorEnvironment: extractV08RangedPositioningBehaviorEnvironment(invocation.environment),
        artifacts: {
            summary: `${invocation.outBase}.summary.json`,
            ...(invocation.searchAuditPath ? { searchAudit: invocation.searchAuditPath } : {}),
        },
    };
    return { ...payload, fingerprintSha256: fingerprint(payload) };
}

function writeExperimentManifest(path: string, manifest: IV08RangedPositioningABManifest): void {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Build the exact promoted a13 search policy for both seats. Experimental switches are explicitly scoped to
 * production v0.8; v0.8s is the otherwise identical control. Research timing removes only a13's two wall-clock
 * guards, leaving its search genome, candidate caps, leaf, gate, and strategy controls unchanged.
 */
export function buildV08RangedPositioningABEnvironment(
    mode: V08RangedPositioningMode,
    timingMode: V08RangedPositioningTimingMode,
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
    moveShots: V08RangedPositioningMoveShots = 0,
    noMeleeTerminalPressure = false,
    deadlineFinisher = false,
    supportedRangedDelta = false,
    responseNeutralAdvance = false,
    paretoNoMeleeFocus = false,
    paretoNoMeleeFocusDamageFloor = 1,
    paretoNoMeleeFocusCatalogOnly = false,
    jitNoMeleeFocus = false,
    jitNoMeleeFocusCatalogOnly = false,
): NodeJS.ProcessEnv {
    if (!isPositioningMode(mode)) throw new Error("mode must be advance|retreat|both|off");
    if (!isTimingMode(timingMode)) throw new Error("timingMode must be research_unbounded|operational_bounded");
    if (!isMoveShotCap(moveShots)) throw new Error("moveShots must be 0|1|2");
    if (typeof noMeleeTerminalPressure !== "boolean") throw new Error("noMeleeTerminalPressure must be a boolean");
    if (typeof deadlineFinisher !== "boolean") throw new Error("deadlineFinisher must be a boolean");
    if (typeof paretoNoMeleeFocus !== "boolean") throw new Error("paretoNoMeleeFocus must be a boolean");
    if (typeof paretoNoMeleeFocusCatalogOnly !== "boolean") {
        throw new Error("paretoNoMeleeFocusCatalogOnly must be a boolean");
    }
    if (paretoNoMeleeFocus && paretoNoMeleeFocusCatalogOnly) {
        throw new Error("paretoNoMeleeFocus and paretoNoMeleeFocusCatalogOnly are mutually exclusive");
    }
    if (!isParetoDamageFloor(paretoNoMeleeFocusDamageFloor)) {
        throw new Error("paretoNoMeleeFocusDamageFloor must be one of 0.9, 0.95, or 1");
    }
    if (!paretoNoMeleeFocus && paretoNoMeleeFocusDamageFloor !== 1) {
        throw new Error("paretoNoMeleeFocusDamageFloor below 1 requires paretoNoMeleeFocus");
    }
    if (typeof jitNoMeleeFocus !== "boolean") throw new Error("jitNoMeleeFocus must be a boolean");
    if (typeof jitNoMeleeFocusCatalogOnly !== "boolean") {
        throw new Error("jitNoMeleeFocusCatalogOnly must be a boolean");
    }
    if (jitNoMeleeFocus && jitNoMeleeFocusCatalogOnly) {
        throw new Error("jitNoMeleeFocus and jitNoMeleeFocusCatalogOnly are mutually exclusive");
    }
    if (typeof supportedRangedDelta !== "boolean") throw new Error("supportedRangedDelta must be a boolean");
    if (typeof responseNeutralAdvance !== "boolean") throw new Error("responseNeutralAdvance must be a boolean");
    validateBehaviorArmGeometry(
        mode,
        moveShots,
        noMeleeTerminalPressure,
        deadlineFinisher,
        paretoNoMeleeFocus || paretoNoMeleeFocusCatalogOnly,
        jitNoMeleeFocus || jitNoMeleeFocusCatalogOnly,
        supportedRangedDelta,
        responseNeutralAdvance,
    );

    const environment = minimalChildEnvironment(sourceEnvironment);
    for (const [key, value] of Object.entries(buildV08A13SearchEnvironment())) {
        if (value !== undefined) environment[key] = value;
    }
    for (const key of A13_VERSION_SCOPE_KEYS) environment[key] = V08_RANGED_POSITIONING_AB_VERSIONS;
    if (timingMode === "research_unbounded") {
        environment.SEARCH_DECISION_DEADLINE_MS = "";
        environment.SEARCH_CIRCUIT_BREAKER_MS = "";
    }

    // Force the explicitly rebound generic SearchDriver. The default factory intentionally scopes a13 to only
    // production v0.8, which would make v0.8s an invalid control for this two-seat experiment.
    environment.V08_A13_SEARCH = "0";
    environment.SEARCH_MAX_MOVE_SHOTS = String(moveShots);
    environment.SEARCH_MOVE_SHOT_VERSIONS = V08_A13_PRODUCTION_VERSION;
    environment.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE = noMeleeTerminalPressure ? "1" : "0";
    environment.SEARCH_PURE_RANGED_NO_MELEE_PRESSURE_VERSIONS = V08_A13_PRODUCTION_VERSION;
    environment.SEARCH_PURE_RANGED_DEADLINE_FINISHER = deadlineFinisher ? "1" : "0";
    environment.SEARCH_PURE_RANGED_DEADLINE_FINISHER_VERSIONS = V08_A13_PRODUCTION_VERSION;
    environment.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS =
        paretoNoMeleeFocus || paretoNoMeleeFocusCatalogOnly ? "1" : "0";
    environment.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS = paretoNoMeleeFocusCatalogOnly
        ? "catalog-only-control"
        : V08_A13_PRODUCTION_VERSION;
    if (paretoNoMeleeFocus) {
        environment.SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_DAMAGE_FLOOR = String(paretoNoMeleeFocusDamageFloor);
    }
    environment.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS = jitNoMeleeFocus || jitNoMeleeFocusCatalogOnly ? "1" : "0";
    environment.SEARCH_PURE_RANGED_JIT_NO_MELEE_FOCUS_VERSIONS = jitNoMeleeFocusCatalogOnly
        ? "jit-catalog-only-control"
        : V08_A13_PRODUCTION_VERSION;
    environment.V08_SUPPORTED_RANGED_DELTA_VERSIONS = supportedRangedDelta ? V08_A13_PRODUCTION_VERSION : "";
    environment.V08_RESPONSE_NEUTRAL_ADVANCE_VERSIONS = responseNeutralAdvance ? V08_A13_PRODUCTION_VERSION : "";
    // Incremental positioning arms compare against the same shipped positioning policy, so both seats receive
    // the baseline and only production v0.8 receives the selected delta.
    environment.V08_RANGED_POSITION_VERSIONS =
        supportedRangedDelta || responseNeutralAdvance
            ? V08_RANGED_POSITIONING_AB_VERSIONS
            : V08_A13_PRODUCTION_VERSION;
    environment.V08_RANGED_POSITION_MODE = mode;
    return environment;
}

export function buildV08RangedPositioningABInvocations(
    options: IV08RangedPositioningABOptions,
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
): IV08RangedPositioningABInvocation[] {
    validateOptions(options);
    const out = resolve(options.out);
    const concurrency = Math.min(options.concurrency, options.games);
    const environment = buildV08RangedPositioningABEnvironment(
        options.mode,
        options.timingMode,
        sourceEnvironment,
        options.moveShots ?? 0,
        options.noMeleeTerminalPressure ?? false,
        options.deadlineFinisher ?? false,
        options.supportedRangedDelta ?? false,
        options.responseNeutralAdvance ?? false,
        options.paretoNoMeleeFocus ?? false,
        options.paretoNoMeleeFocusDamageFloor ?? 1,
        options.paretoNoMeleeFocusCatalogOnly ?? false,
        options.jitNoMeleeFocus ?? false,
        options.jitNoMeleeFocusCatalogOnly ?? false,
    );
    return options.cohorts.map((cohort) => {
        const outBase = join(out, cohort);
        const searchAuditPath =
            options.paretoNoMeleeFocus ||
            options.paretoNoMeleeFocusCatalogOnly ||
            options.jitNoMeleeFocus ||
            options.jitNoMeleeFocusCatalogOnly
                ? `${outBase}.search-audit.jsonl`
                : undefined;
        const invocationEnvironment = { ...environment };
        if (searchAuditPath) invocationEnvironment.SEARCH_AUDIT = searchAuditPath;
        return {
            cohort,
            outBase,
            ...(searchAuditPath ? { searchAuditPath } : {}),
            environment: invocationEnvironment,
            args: [
                V08_RANGED_POSITIONING_AB_RUNNER,
                "--cohort",
                cohort,
                "--games",
                String(options.games),
                "--seed",
                String(options.seed),
                "--concurrency",
                String(concurrency),
                "--amount-mode",
                "expBudget",
                "--livetwin",
                "1",
                "--vA",
                V08_A13_PRODUCTION_VERSION,
                "--vB",
                V08_A13_SOURCE_VERSION,
                ...(options.diag ? ["--diag"] : []),
                "--out",
                outBase,
            ],
        };
    });
}

async function spawnInvocation(invocation: IV08RangedPositioningABInvocation): Promise<number> {
    return new Promise<number>((resolveCode, reject) => {
        const child = spawn(process.execPath, invocation.args, {
            cwd: REPOSITORY_ROOT,
            env: invocation.environment,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (signal) reject(new Error(`ranged-positioning A/B ${invocation.cohort} exited on ${signal}`));
            else resolveCode(code ?? 1);
        });
    });
}

/** Create a fresh append target so a rerun can never inherit counters from an earlier experiment. */
export function prepareV08RangedPositioningABInvocation(invocation: IV08RangedPositioningABInvocation): void {
    if (!invocation.searchAuditPath) return;
    if (invocation.environment.SEARCH_AUDIT !== invocation.searchAuditPath) {
        throw new Error(`search audit routing mismatch for cohort ${invocation.cohort}`);
    }
    mkdirSync(dirname(invocation.searchAuditPath), { recursive: true });
    writeFileSync(invocation.searchAuditPath, "");
}

export async function runV08RangedPositioningAB(
    options: IV08RangedPositioningABOptions,
    dependencies: IV08RangedPositioningABDependencies = {},
): Promise<IV08RangedPositioningABInvocation[]> {
    const invocations = buildV08RangedPositioningABInvocations(options);
    const runChild = dependencies.runChild ?? spawnInvocation;
    const discoverSourceIdentity = dependencies.discoverSourceIdentity ?? discoverV08RangedPositioningABSourceIdentity;
    const writeManifest = dependencies.writeManifest ?? writeExperimentManifest;
    const prepareInvocation = dependencies.prepareInvocation ?? prepareV08RangedPositioningABInvocation;
    const moveShots = options.moveShots ?? 0;
    const noMeleeTerminalPressure = options.noMeleeTerminalPressure ?? false;
    const deadlineFinisher = options.deadlineFinisher ?? false;
    const paretoNoMeleeFocus = options.paretoNoMeleeFocus ?? false;
    const paretoNoMeleeFocusCatalogOnly = options.paretoNoMeleeFocusCatalogOnly ?? false;
    const paretoNoMeleeFocusDamageFloor = options.paretoNoMeleeFocusDamageFloor ?? 1;
    const jitNoMeleeFocus = options.jitNoMeleeFocus ?? false;
    const jitNoMeleeFocusCatalogOnly = options.jitNoMeleeFocusCatalogOnly ?? false;
    const supportedRangedDelta = options.supportedRangedDelta ?? false;
    const responseNeutralAdvance = options.responseNeutralAdvance ?? false;
    for (const invocation of invocations) {
        const sourceIdentity = discoverSourceIdentity();
        console.error(
            `[v0.8-ranged-positioning-ab] cohort=${invocation.cohort} mode=${options.mode} ` +
                `moveShots=${moveShots} diag=${options.diag ?? false} timing=${options.timingMode} ` +
                `noMeleeTerminalPressure=${noMeleeTerminalPressure} ` +
                `deadlineFinisher=${deadlineFinisher} paretoNoMeleeFocus=${paretoNoMeleeFocus} ` +
                `paretoCatalogOnly=${paretoNoMeleeFocusCatalogOnly} ` +
                `paretoDamageFloor=${paretoNoMeleeFocusDamageFloor} ` +
                `jitNoMeleeFocus=${jitNoMeleeFocus} jitCatalogOnly=${jitNoMeleeFocusCatalogOnly} ` +
                `supportedRangedDelta=${supportedRangedDelta} ` +
                `responseNeutralAdvance=${responseNeutralAdvance} ` +
                `games=${options.games} seed=${options.seed}`,
        );
        await prepareInvocation(invocation);
        const code = await runChild(invocation);
        if (code !== 0) throw new Error(`ranged-positioning A/B ${invocation.cohort} exited with code ${code}`);
        const manifest = buildV08RangedPositioningABManifest(invocation, options, sourceIdentity);
        writeManifest(`${invocation.outBase}.experiment.json`, manifest);
    }
    return invocations;
}

export function parseV08RangedPositioningABOptions(args: readonly string[]): IV08RangedPositioningABOptions {
    const { values } = parseArgs({
        args: [...args],
        options: {
            cohorts: { type: "string", default: "hybrid,ranged_max_sniper3" },
            games: { type: "string", default: "1000" },
            seed: { type: "string", default: "872511" },
            concurrency: {
                type: "string",
                default: String(Math.min(12, Math.max(1, availableParallelism()))),
            },
            out: { type: "string", default: "sim-out/v0.8-ranged-positioning-ab" },
            mode: { type: "string", default: "both" },
            "move-shots": { type: "string", default: "0" },
            "no-melee-terminal-pressure": { type: "boolean", default: false },
            "deadline-finisher": { type: "boolean", default: false },
            "pareto-no-melee-focus": { type: "boolean", default: false },
            "pareto-catalog-only": { type: "boolean", default: false },
            "pareto-damage-floor": { type: "string", default: "1" },
            "jit-no-melee-focus": { type: "boolean", default: false },
            "jit-catalog-only": { type: "boolean", default: false },
            "supported-ranged-delta": { type: "boolean", default: false },
            "response-neutral-advance": { type: "boolean", default: false },
            diag: { type: "boolean", default: false },
            timing: { type: "string", default: "operational_bounded" },
        },
        strict: true,
        allowPositionals: false,
    });
    const mode = values.mode!;
    const timingMode = values.timing!;
    const moveShots = Number(values["move-shots"]);
    const paretoNoMeleeFocusDamageFloor = Number(values["pareto-damage-floor"]);
    if (!isPositioningMode(mode)) throw new Error("--mode must be advance|retreat|both|off");
    if (!isTimingMode(timingMode)) {
        throw new Error("--timing must be research_unbounded|operational_bounded");
    }
    if (!isMoveShotCap(moveShots)) throw new Error("--move-shots must be 0|1|2");
    const options: IV08RangedPositioningABOptions = {
        cohorts: normalizeV08RangedPositioningCohorts(values.cohorts!),
        games: Number(values.games),
        seed: Number(values.seed),
        concurrency: Number(values.concurrency),
        out: values.out!,
        mode,
        timingMode,
        moveShots,
        noMeleeTerminalPressure: values["no-melee-terminal-pressure"]!,
        deadlineFinisher: values["deadline-finisher"]!,
        paretoNoMeleeFocus: values["pareto-no-melee-focus"]!,
        paretoNoMeleeFocusCatalogOnly: values["pareto-catalog-only"]!,
        paretoNoMeleeFocusDamageFloor,
        jitNoMeleeFocus: values["jit-no-melee-focus"]!,
        jitNoMeleeFocusCatalogOnly: values["jit-catalog-only"]!,
        supportedRangedDelta: values["supported-ranged-delta"]!,
        responseNeutralAdvance: values["response-neutral-advance"]!,
        diag: values.diag!,
    };
    validateOptions(options);
    return options;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(
            "Usage: bun src/simulation/run_v0_8_ranged_positioning_ab.ts " +
                "[--cohorts hybrid,ranged_max_sniper3] [--games 1000] [--seed 872511] " +
                "[--concurrency 12] [--out sim-out/ranged-ab] [--mode advance|retreat|both|off] " +
                "[--move-shots 0|1|2] [--no-melee-terminal-pressure] [--deadline-finisher] " +
                "[--pareto-no-melee-focus|--pareto-catalog-only] [--pareto-damage-floor 0.9..1] " +
                "[--jit-no-melee-focus|--jit-catalog-only] " +
                "[--supported-ranged-delta] [--response-neutral-advance] [--diag] " +
                "[--timing research_unbounded|operational_bounded]",
        );
        return;
    }
    await runV08RangedPositioningAB(parseV08RangedPositioningABOptions(args));
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
