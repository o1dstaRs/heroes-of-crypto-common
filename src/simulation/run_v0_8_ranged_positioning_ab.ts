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

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
    buildV08A13SearchEnvironment,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_SOURCE_VERSION,
} from "../ai/versions/v0_8_a13_profile";
import { MIRROR_COHORTS, type MirrorCohortName } from "./measure_mirror_cohorts";

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
}

export interface IV08RangedPositioningABInvocation {
    cohort: MirrorCohortName;
    args: string[];
    environment: NodeJS.ProcessEnv;
    outBase: string;
}

export interface IV08RangedPositioningABDependencies {
    runChild?: (invocation: IV08RangedPositioningABInvocation) => Promise<number>;
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

/**
 * Build the exact promoted a13 search policy for both seats. The only asymmetric switch is ranged positioning,
 * scoped to production v0.8; v0.8s is the otherwise identical control. Research timing removes only a13's two
 * wall-clock guards, leaving its search genome, candidate caps, leaf, gate, and strategy controls unchanged.
 */
export function buildV08RangedPositioningABEnvironment(
    mode: V08RangedPositioningMode,
    timingMode: V08RangedPositioningTimingMode,
    sourceEnvironment: NodeJS.ProcessEnv = process.env,
    moveShots: V08RangedPositioningMoveShots = 0,
): NodeJS.ProcessEnv {
    if (!isPositioningMode(mode)) throw new Error("mode must be advance|retreat|both|off");
    if (!isTimingMode(timingMode)) throw new Error("timingMode must be research_unbounded|operational_bounded");
    if (!isMoveShotCap(moveShots)) throw new Error("moveShots must be 0|1|2");

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
    environment.V08_RANGED_POSITION_VERSIONS = V08_A13_PRODUCTION_VERSION;
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
    );
    return options.cohorts.map((cohort) => {
        const outBase = join(out, cohort);
        return {
            cohort,
            outBase,
            environment: { ...environment },
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

export async function runV08RangedPositioningAB(
    options: IV08RangedPositioningABOptions,
    dependencies: IV08RangedPositioningABDependencies = {},
): Promise<IV08RangedPositioningABInvocation[]> {
    const invocations = buildV08RangedPositioningABInvocations(options);
    const runChild = dependencies.runChild ?? spawnInvocation;
    const moveShots = options.moveShots ?? 0;
    for (const invocation of invocations) {
        console.error(
            `[v0.8-ranged-positioning-ab] cohort=${invocation.cohort} mode=${options.mode} ` +
                `moveShots=${moveShots} timing=${options.timingMode} games=${options.games} seed=${options.seed}`,
        );
        const code = await runChild(invocation);
        if (code !== 0) throw new Error(`ranged-positioning A/B ${invocation.cohort} exited with code ${code}`);
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
            timing: { type: "string", default: "operational_bounded" },
        },
        strict: true,
        allowPositionals: false,
    });
    const mode = values.mode!;
    const timingMode = values.timing!;
    const moveShots = Number(values["move-shots"]);
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
                "[--move-shots 0|1|2] " +
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
