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

/**
 * Native rollout banks for SearchDriver.scoreCandidates: libhocsim (zig/, ABI 3, zig/BRIDGE.md) plays a bank's
 * rollouts and the driver is left exactly as its TypeScript loop would have left it.
 *
 * Switch `HOC_NATIVE_ROLLOUTS` (read when a driver is built): `0` (default) TypeScript only; `1` a bank runs natively
 * when its root is in the library's scope, else in TypeScript; `shadow` TypeScript decides and a sampled bank
 * (`HOC_NATIVE_SHADOW_RATE`, default every bank) is replayed natively and compared rollout by rollout. The library is
 * `HOC_SIM_LIB` (default zig/zig-out/lib), loaded once per process on first use through zig/ffi/bridge.ts's fail-safe
 * loader (self-test included, `HOC_SIM_COMMON_SHA` pins the common commit it must be built from); a missing or
 * refused library logs once and every bank stays in TypeScript. Bun only: nothing here imports bun:ffi or zig/ at
 * module load, so browser bundles and tsc never see the bridge.
 *
 * A root (one chooseSearchDecision) is native when the library's scope manifest (zig/ffi/precheck.ts), the export and
 * the loader accept its board, every team plays a policy the library implements (StrategyV0_8 under the A19 placement
 * layers, or StrategyV0_1), and the AI environment equals the A19 profile's (the library implements the production
 * values only). A bank is native when, in addition, the driver runs none of the research terms the library does not
 * (rollout cache, opponent model, research or per-team leaves, team scope, the neural correction).
 */

import type { IAIStrategy } from "../ai/ai_strategy";
import { StrategyV0_1 } from "../ai/versions/v0_1";
import { StrategyV0_8 } from "../ai/versions/v0_8";
import { V08_A13_VALUE_LEAF } from "../ai/versions/v0_8_a13_profile";
import { buildV08A19SearchEnvironment } from "../ai/versions/v0_8_a19_profile";
import { V08A19BoarBattleMageFlankPlacementStrategy } from "../ai/versions/v0_8_a19_boar_battle_mage_flank_placement";
import { V08A19CompactPlacementStrategy } from "../ai/versions/v0_8_a19_compact_placement";
import { V08A19F184LowerHumanPlacementStrategy } from "../ai/versions/v0_8_a19_f184_lower_human_placement";
import { V08A19RankedPlacementStrategy } from "../ai/versions/v0_8_a19_ranked_placement";
import { mkdirSync, writeFileSync } from "node:fs";
import { FightStateManager } from "../fights/fight_state_manager";
import { captureDeterministicRandomState, restoreDeterministicRandomState } from "../utils/lib";
import type { INativeHarness } from "./lookahead";
import type { SearchSelectionBounds } from "./search_selection_bounds";
import { DEFAULT_V07_VALUE_WEIGHTS } from "./v0_7_value_weights";

export const NATIVE_ROLLOUTS_ENV = "HOC_NATIVE_ROLLOUTS";
export const NATIVE_SHADOW_RATE_ENV = "HOC_NATIVE_SHADOW_RATE";
/** "throw": a read the native bank cannot reproduce (a draw from the leftover random source, the active unit) throws. */
export const NATIVE_SENTINELS_ENV = "HOC_NATIVE_SENTINELS";
/** Shadow mode writes the self-test fixture (zig/src/selftest) from the first root whose two H64 banks matched. */
export const NATIVE_FIXTURE_DIR_ENV = "HOC_NATIVE_FIXTURE_DIR";
/** Shadow mode writes a mismatching bank's export and request here (at most 20 per process). */
export const NATIVE_SHADOW_DUMP_DIR_ENV = "HOC_NATIVE_SHADOW_DUMP_DIR";
/** The common commit the library must have been built from (`-Dcommon-sha`); unset: not checked. */
export const NATIVE_COMMON_SHA_ENV = "HOC_SIM_COMMON_SHA";

export type NativeRolloutMode = "off" | "on" | "shadow";
export type NativePolicyVersion = "v0.1" | "v0.8";

const logged = new Set<string>();
/** One line per process and key. */
export function nativeRolloutLog(key: string, message: string, level: "error" | "info" = "error"): void {
    if (logged.has(key)) return;
    logged.add(key);
    (level === "info" ? console.info : console.error)(`[native-rollouts] ${message}`);
}

/**
 * How a load notice is logged: an error when HOC_NATIVE_ROLLOUTS asked for native rollouts, information when the default
 * merely found no current library (an installed package, a dirty tree, another runtime). Tools that count console.error
 * as a failure, such as the ranked research adapter, see nothing when the default declines.
 */
const loadNoticeLevel = (): "error" | "info" =>
    (process.env[NATIVE_ROLLOUTS_ENV] ?? "").trim() === "" ? "info" : "error";

/**
 * `HOC_NATIVE_ROLLOUTS`: unset (the default) or `1` native banks where in scope, `0` TypeScript only, `shadow` TypeScript
 * decides and sampled banks are replayed natively. Unset, the backend also requires a current library
 * (nativeDefaultTree: built from this tree's commit, no local changes under src/ or zig/).
 */
export function nativeRolloutModeFromEnv(
    value: string | undefined = process.env[NATIVE_ROLLOUTS_ENV],
): NativeRolloutMode {
    const normalized = (value ?? "").trim().toLowerCase();
    if (normalized === "0" || normalized === "off") return "off";
    if (normalized === "" || normalized === "1" || normalized === "on") return "on";
    if (normalized === "shadow") return "shadow";
    nativeRolloutLog(
        `mode:${normalized}`,
        `${NATIVE_ROLLOUTS_ENV}=${value} is not 0, 1 or shadow; native rollouts stay off`,
    );
    return "off";
}

/**
 * The default's guard (HOC_NATIVE_ROLLOUTS unset, HOC_SIM_COMMON_SHA unset): the commit the library must report, which is
 * this TypeScript tree's own (zig build embeds `git rev-parse HEAD`, with "-dirty" for local changes under zig/), and
 * only while the tree has no local changes under src/ or zig/: a research arm that edits the TypeScript search or
 * policy keeps TypeScript rollouts unless it forces native ones (1). `git` runs a git command in the common root and
 * returns its trimmed output, or null when it fails.
 *
 * A tree that is not a git checkout but an installed package (bun's GitHub install, whose `.bun-tag` ends in the
 * commit's short sha; `bunTag` reads it, null when absent) gives that commit as a prefix (`shaPrefix`): the library's
 * own commit must start with it. Any other tree (a copied or archived research tree) keeps TypeScript rollouts.
 */
export function nativeDefaultTree(
    git: (args: string[]) => string | null,
    bunTag: () => string | null = () => null,
): { sha: string } | { shaPrefix: string } | { reason: string } {
    const sha = git(["rev-parse", "HEAD"]);
    if (sha === null || !/^[0-9a-f]{40}$/.test(sha)) {
        const tag = /-([0-9a-f]{7,40})$/.exec(bunTag()?.trim() ?? "");
        if (tag) return { shaPrefix: tag[1] };
        return { reason: "the TypeScript tree is not a git checkout" };
    }
    const changes = git(["status", "--porcelain", "--untracked-files=no", "--", "src", "zig"]);
    if (changes === null) return { reason: "git status failed" };
    if (changes !== "") return { reason: "the TypeScript tree has local changes under src/ or zig/" };
    return { sha };
}

/** The common root's `.bun-tag` (an installed package), or null. */
function commonRootBunTag(): string | null {
    const load = (import.meta as unknown as { require?: (specifier: string) => unknown }).require;
    if (typeof load !== "function") return null;
    try {
        const fs = load("node:fs") as { readFileSync(path: string, encoding: "utf8"): string };
        return fs.readFileSync(decodeURIComponent(new URL("../../.bun-tag", import.meta.url).pathname), "utf8");
    } catch {
        return null;
    }
}

/** git in the common root through Bun.spawnSync (no module import, so browser bundles never see it). */
function commonRootGit(args: string[]): string | null {
    const spawnSync = (
        globalThis as {
            Bun?: { spawnSync(cmd: string[], opts: object): { exitCode: number | null; stdout: Uint8Array } };
        }
    ).Bun?.spawnSync;
    if (typeof spawnSync !== "function") return null;
    try {
        const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
        const run = spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
        return run.exitCode === 0 ? new TextDecoder().decode(run.stdout).trim() : null;
    } catch {
        return null;
    }
}

export function nativeShadowRateFromEnv(value: string | undefined = process.env[NATIVE_SHADOW_RATE_ENV]): number {
    if (value === undefined || value.trim() === "") return 1;
    const rate = Number(value);
    return Number.isFinite(rate) && rate >= 0 ? Math.min(1, rate) : 1;
}

// ---- the bridge, as far as this adapter uses it (zig/ffi/bridge.ts, ABI 3) -------------------------------------

export interface INativePairRecord {
    value: number;
    material: number;
    turns: number;
    flags: number;
    summonSequence: number;
    uuidSequence: number;
    winner: number;
}

interface INativeRolloutCallResult {
    turns: number;
    stop: string;
    summonSequence: number;
    uuidSequence: number;
}

export interface INativeStateHandle {
    free(): void;
}

export interface INativeEngine {
    load(state: string): INativeStateHandle;
    rollouts(state: INativeStateHandle, request: object, deadlineNs?: bigint): INativeRolloutCallResult;
    rolloutPairs(): INativePairRecord[];
    scopeManifest(policy?: string): unknown;
    /** the commit the library was built from ("-dirty" with local zig/ changes) */
    readonly buildInfo: { readonly commonSha: string };
}

export interface INativePairFlags {
    readonly played: number;
    readonly skippedIllegal: number;
    readonly aborted: number;
    readonly notReached: number;
    readonly skippedTail: number;
}

interface INativePrecheck {
    refusal(context: { unitsHolder: unknown; grid: unknown; fightProperties: unknown }): string | null;
}

export interface INativeExportBattle {
    unitsHolder: unknown;
    grid: unknown;
    fightProperties: unknown;
    attackHandler: unknown;
}

export interface INativeExportHarness {
    rng: number;
    activeUnitId: string;
    uuidSequence: number;
    seed?: number;
    summonSequence: number;
    armyProfile: Record<string, INativeArmyProfile | null>;
}

export interface INativeArmyProfile {
    meleeMagic: number;
    auraSaturated: boolean;
}

/** A loaded library with its pre-checks and the state exporter. */
export interface INativeRolloutBackend {
    readonly engine: INativeEngine;
    readonly flags: INativePairFlags;
    /** HocError: a refusal (`unsupported request: ...` refuses the root, any other refuses the bank). */
    isRefusal(error: unknown): boolean;
    nowNs(): bigint;
    refusal(policy: NativePolicyVersion, battle: Omit<INativeExportBattle, "attackHandler">): string | null;
    exportState(battle: INativeExportBattle, harness: INativeExportHarness): string;
}

interface IBridgeModule {
    loadHocEngine(options: { commonSha?: string; log?: (message: string) => void }): INativeEngine | null;
    hocNowNs(): bigint;
    HocError: abstract new (...args: never[]) => Error;
    HOC_PAIR_PLAYED: number;
    HOC_PAIR_SKIPPED_ILLEGAL: number;
    HOC_PAIR_ABORTED: number;
    HOC_PAIR_NOT_REACHED: number;
    HOC_PAIR_SKIPPED_TAIL: number;
}

let backend: INativeRolloutBackend | null | undefined;

/**
 * The process's native backend: loaded on first use (bridge, self-test, pre-checks, exporter), null when this is not
 * Bun or the library is missing, stale or fails its self-test (logged once).
 */
export function getNativeRolloutBackend(): INativeRolloutBackend | null {
    if (backend !== undefined) return backend;
    backend = null;
    const load = (import.meta as unknown as { require?: (specifier: string) => unknown }).require;
    if (typeof load !== "function") {
        nativeRolloutLog(
            "runtime",
            "native rollouts need Bun's import.meta.require; every bank stays in TypeScript",
            loadNoticeLevel(),
        );
        return backend;
    }
    try {
        // The one-time load (the bridge, its self-test, the manifests and their pre-checks) only reads, like a root step.
        backend = rootStepWithoutSideEffects("backend load", () => loadNativeRolloutBackend(load));
    } catch (error) {
        nativeRolloutLog("load-error", `native rollouts off: ${(error as Error).message}`, loadNoticeLevel());
        backend = null;
    }
    return backend;
}

function loadNativeRolloutBackend(load: (specifier: string) => unknown): INativeRolloutBackend | null {
    let commonSha = process.env[NATIVE_COMMON_SHA_ENV] || undefined;
    let shaPrefix: string | undefined;
    if (commonSha === undefined && (process.env[NATIVE_ROLLOUTS_ENV] ?? "").trim() === "") {
        const tree = nativeDefaultTree(commonRootGit, commonRootBunTag);
        if ("reason" in tree) {
            nativeRolloutLog(
                "default",
                `native rollouts off by default: ${tree.reason} (HOC_NATIVE_ROLLOUTS=1 forces them)`,
                "info",
            );
            return null;
        }
        if ("sha" in tree) commonSha = tree.sha;
        else shaPrefix = tree.shaPrefix;
    }
    const bridge = load("../../zig/ffi/bridge.ts") as IBridgeModule;
    const engine = bridge.loadHocEngine({
        commonSha,
        log: (message) => nativeRolloutLog("load", message, loadNoticeLevel()),
    });
    if (!engine) return null;
    if (shaPrefix !== undefined && !engine.buildInfo.commonSha.startsWith(shaPrefix)) {
        nativeRolloutLog(
            "default",
            `native rollouts off by default: libhocsim was built from common ${engine.buildInfo.commonSha}, this package is ${shaPrefix}`,
            "info",
        );
        return null;
    }
    const { compileHocPrecheck } = load("../../zig/ffi/precheck.ts") as {
        compileHocPrecheck(manifest: unknown): INativePrecheck;
    };
    const { exportBattleState } = load("../../zig/parity/state_export.ts") as {
        exportBattleState(battle: INativeExportBattle, harness: INativeExportHarness): unknown;
    };
    const { battleDigest } = load("../../zig/parity/digest.ts") as {
        battleDigest(battle: INativeExportBattle, options: Record<string, boolean>): { fight: unknown };
    };
    const prechecks: Record<NativePolicyVersion, INativePrecheck> = {
        "v0.1": compileHocPrecheck(engine.scopeManifest("v0.1")),
        "v0.8": compileHocPrecheck(engine.scopeManifest("v0.8")),
    };
    return Object.freeze({
        engine,
        flags: Object.freeze({
            played: bridge.HOC_PAIR_PLAYED,
            skippedIllegal: bridge.HOC_PAIR_SKIPPED_ILLEGAL,
            aborted: bridge.HOC_PAIR_ABORTED,
            notReached: bridge.HOC_PAIR_NOT_REACHED,
            skippedTail: bridge.HOC_PAIR_SKIPPED_TAIL,
        }),
        isRefusal: (error: unknown) => error instanceof bridge.HocError,
        nowNs: () => bridge.hocNowNs(),
        refusal: (policy: NativePolicyVersion, battle: Omit<INativeExportBattle, "attackHandler">) =>
            rootStepWithoutSideEffects(
                "precheck",
                () => prechecks[policy].refusal(battle),
                (board) => boardDigest(battleDigest, board),
                { ...battle, attackHandler: undefined },
            ),
        exportState: (battle: INativeExportBattle, harness: INativeExportHarness) =>
            exportWithoutSideEffects(exportBattleState, (board) => boardDigest(battleDigest, board), battle, harness),
    });
}

/** Tests: install a backend (or null for "no library"); undefined restores lazy loading. */
export function setNativeRolloutBackendForTests(next: INativeRolloutBackend | null | undefined): void {
    backend = next;
}

/** The per-process circuit: an unexpected native error turns the backend off for the rest of the process. */
export function disableNativeRollouts(error: unknown): void {
    backend = null;
    nativeRolloutLog(
        "circuit",
        `native rollouts off for this process after an unexpected error: ${(error as Error)?.message ?? error}`,
    );
}

// ---- what a root needs to be native ------------------------------------------------------------------------------

/** The A19 placement layers: each forwards decideTurn to its `base` unchanged (placement only). */
const V08_PLACEMENT_LAYERS: readonly object[] = [
    V08A19F184LowerHumanPlacementStrategy.prototype,
    V08A19BoarBattleMageFlankPlacementStrategy.prototype,
    V08A19CompactPlacementStrategy.prototype,
    V08A19RankedPlacementStrategy.prototype,
];

export interface INativeTeamPolicy {
    version: NativePolicyVersion;
    /** the StrategyV0_8 whose army profiles the export carries (v0.8 only) */
    combat?: StrategyV0_8;
}

/**
 * The library policy a team's rollout strategy plays, or the reason it plays none: exactly StrategyV0_8, under any
 * chain of the A19 placement layers, or exactly StrategyV0_1 (withAreaThrow's routing proxy is transparent; its
 * routers stay off in the A19 environment, which nativeEnvironmentRefusal requires). Every other strategy refuses.
 */
/**
 * The rollout policies' decideTurn chain as loaded (StrategyV0_8 and its v0.7 ... v0.1 supers, StrategyV0_1). A tool that
 * wraps one of them (a layer log, an audit, a research arm written in code) watches or changes TypeScript rollouts, so
 * while it is installed every bank stays in TypeScript (nativePolicyHook).
 */
const LOADED_DECIDE_TURNS: ReadonlyMap<object, unknown> = (() => {
    const loaded = new Map<object, unknown>();
    for (const root of [StrategyV0_8.prototype, StrategyV0_1.prototype]) {
        let prototype: object | null = root;
        while (prototype && prototype !== Object.prototype) {
            if (Object.prototype.hasOwnProperty.call(prototype, "decideTurn")) {
                loaded.set(prototype, (prototype as { decideTurn: unknown }).decideTurn);
            }
            prototype = Object.getPrototypeOf(prototype) as object | null;
        }
    }
    return loaded;
})();

/** "hooked:<Class>.decideTurn" when a rollout policy's decideTurn is no longer the one loaded, else undefined. */
export function nativePolicyHook(): string | undefined {
    for (const [prototype, loaded] of LOADED_DECIDE_TURNS) {
        if ((prototype as { decideTurn: unknown }).decideTurn !== loaded) {
            return `hooked:${(prototype as { constructor: { name: string } }).constructor.name}.decideTurn`;
        }
    }
    return undefined;
}

export function nativeTeamPolicy(strategy: IAIStrategy): INativeTeamPolicy | string {
    let current: unknown = strategy;
    for (let hop = 0; hop < 8 && current; hop += 1) {
        const prototype = Object.getPrototypeOf(current);
        if (prototype === StrategyV0_8.prototype) return { version: "v0.8", combat: current as StrategyV0_8 };
        if (prototype === StrategyV0_1.prototype && hop === 0) return { version: "v0.1" };
        if (!V08_PLACEMENT_LAYERS.includes(prototype)) break;
        current = (current as { base?: unknown }).base;
    }
    return `policy:${strategy.version}`;
}

/** The export's army profile of `team` (placement primed it), null when its strategy never placed that army. */
export function nativeArmyProfile(policy: INativeTeamPolicy, holder: object, team: number): INativeArmyProfile | null {
    const profile = policy.combat?.getArmyProfile(holder, team);
    return profile ? { meleeMagic: profile.meleeMagicAnchor ? 2 : 0, auraSaturated: profile.auraSaturated } : null;
}

interface ILeafWeights {
    b: number;
    w: readonly number[];
}
const sameLeaf = (a: ILeafWeights, b: ILeafWeights): boolean =>
    a.b === b.b && a.w.length === b.w.length && a.w.every((x, i) => x === b.w[i]);

/**
 * The library's leaf for the driver's weights: "v2" (V08_A13_VALUE_LEAF, production's), "v1" (DEFAULT_V07_VALUE_WEIGHTS)
 * or "material"; other weights refuse ("leaf:...").
 */
export function nativeLeafKind(learnedV2: ILeafWeights | null, learned: ILeafWeights | null): string {
    if (learnedV2) return sameLeaf(learnedV2, V08_A13_VALUE_LEAF) ? "v2" : "leaf:v2_weights";
    if (learned) return sameLeaf(learned, DEFAULT_V07_VALUE_WEIGHTS) ? "v1" : "leaf:v1_weights";
    return "material";
}

/** The AI policy's environment namespaces (and its one AI_ switch: a broad AI_ prefix catches unrelated tooling). */
const AI_POLICY_ENV = /^(A19|B2|Q2|V0\d)_|^AI_AURA_ZONE_EXACT$/;
/**
 * Policy-namespace knobs no rollout reads (audited 2026-11-26 from each knob's readers), each also as its per-seat
 * _LEFT / _RIGHT form:
 * - draft and setup (src/ai/setup): the counter draft and its model, the striker rush's shooter floor, the learned
 *   draft, setup, synergy and augment weights, the conditional setup;
 * - placement (placeArmy only): the split and shield screens, v0.5's placement modes, v0.6's dispersal, v0.7's
 *   reveal, the ranked setup spec;
 * - the search root: the carrier cohesion veto (search_driver's carrierCohesionIncumbent), v0.6s / runMatch's search
 *   switch, the aggressive root and the Q2 dataset, oracle and wait ablation;
 * - the leaf weights, which nativeLeafKind checks on every bank;
 * - the v0.5 lookahead, which no A19 driver runs;
 * - runner infrastructure: the aligned-v2 runner, measurement switches, the audit skip.
 * Kept checked: B2_ORACLE. Its side channel is also fed by the wait scorer inside TypeScript rollouts, so a native
 * bank would change what the oracle collects.
 */
const AI_POLICY_ROOT_ONLY: readonly string[] = [
    "A19_COUNTER_DRAFT",
    "A19_COUNTER_MODEL",
    "A19_STRIKER_RUSH_MIXED_MIN_SHOOTERS",
    "V05_AUGCA_WEIGHTS",
    "V05_DRAFT_FROZEN_WEIGHTS",
    "V05_DRAFT_WEIGHTS",
    "V05_SETUPCA_WEIGHTS",
    "V05_SETUP_WEIGHTS",
    "V05_SYNERGY_WEIGHTS",
    "V07_SETUP_CONDITIONAL",
    "A19_SHIELD_SCREEN",
    "A19_SPLIT_SCREEN",
    "V05_FLYERMIN",
    "V05_PLACEMENT",
    "V05_PLACE_WEIGHTS",
    "V06_DISPERSE_TEAM",
    "V07_PLACEMENT_REVEAL",
    "V07_PLACEMENT_REVEAL_VERSIONS",
    "V08_RANKED_SETUP_POLICY_SPEC",
    "A19_CARRIER_COHESION",
    "Q2_DATASET",
    "Q2_DATASET_V2",
    "Q2_ORACLE",
    "Q2_WAIT_ABLATION",
    "V07_SEARCH",
    "V08_AGGRESSIVE",
    "V07_VALUE_WEIGHTS",
    "V07_VALUE_WEIGHTS_V2",
    "V05_LOOKAHEAD",
    "V05_LOOKAHEAD_POSW",
    "V05_RERANK_GATE",
    "V05_VALUE_WEIGHTS",
    "A19_CONTINUATION_DISABLED",
    "A19_DIAGNOSTIC_DISABLED",
    "V05_SKIP_AUDIT",
    "V07_ALIGNED_V2_DEFINITION",
    "V07_ALIGNED_V2_HEARTBEAT_MS",
    "V07_ALIGNED_V2_HOST_PROBE_MS",
    "V07_ALIGNED_V2_HOST_PROBE_TIMEOUT_MS",
    "V07_ALIGNED_V2_MAX_RESTARTS",
    "V07_ALIGNED_V2_NICE",
    "V07_ALIGNED_V2_OUT",
    "V07_ALIGNED_V2_RESTART_BASE_MS",
    "V07_ALIGNED_V2_RESTART_MAX_MS",
    "V07_ALIGNED_V2_RUNNER_PROGRESS_WATCHDOG_MS",
    "V07_ALIGNED_V2_RUNNER_STARTUP_WATCHDOG_MS",
    "V07_ALIGNED_V2_STOP_GRACE_MS",
    "V07_ALIGNED_V2_WATCHDOG_MS",
    "V07_COMPOSED_HOST_IDLE_ATTESTATION",
];
/**
 * Policy-namespace variables no rollout reads: AI_POLICY_ROOT_ONLY (with the per-seat forms), the root-only flyer
 * backline priority, the override carrier (its effect shows in the variables it overrides), and the search routing that
 * picks the driver (V08_A19_SEARCH, V08_A13_SEARCH).
 */
const AI_POLICY_ENV_IGNORED: ReadonlySet<string> = new Set([
    ...AI_POLICY_ROOT_ONLY.flatMap((key) => [key, `${key}_LEFT`, `${key}_RIGHT`]),
    "V08_FLYER_BACKLINE_PRIORITY",
    "V08_FLYER_BACKLINE_PRIORITY_LEFT",
    "V08_FLYER_BACKLINE_PRIORITY_RIGHT",
    "V08_A19_SEARCH_ENV_OVERRIDES",
    "V08_A19_SEARCH",
    "V08_A13_SEARCH",
]);
/**
 * Rollout-read switches whose every reader tests for one value only (=== / !== that value), so unset, "0", "" and any
 * other value all mean off: compared by meaning (on or off), not by string. Audited 2026-11-26: v0_8_support_roles.ts
 * (the mage kill priority, per seat), v0_7.ts (the dense melee-magic isolation; the aura caster router at "on"),
 * v0_8_ranged_positioning.ts (the protected-advance guardrails, the supported band advance, the pre-pin egress, and
 * their live-only switches).
 */
const AI_POLICY_ENV_ON_AT: Readonly<Record<string, string>> = {
    V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT: "1",
    V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT: "1",
    V07_DENSE_MM_SALVAGE_ISOLATION: "1",
    V07_AURA_CASTER_ROUTER: "on",
    V08_PROTECTED_ADVANCE_GUARDRAILS: "1",
    V08_PROTECTED_ADVANCE_GUARDRAILS_LIVE_ONLY: "1",
    V08_SUPPORTED_BAND_ADVANCE: "1",
    V08_SUPPORTED_BAND_ADVANCE_LIVE_ONLY: "1",
    V08_SUPPORTED_PREPIN_EGRESS: "1",
    V08_SUPPORTED_PREPIN_EGRESS_LIVE_ONLY: "1",
};
/** Whether two values of a policy variable mean the same to its readers (undefined: unset). */
function samePolicyMeaning(key: string, a: string | undefined, b: string | undefined): boolean {
    if (a === b) return true;
    const on = AI_POLICY_ENV_ON_AT[key];
    return on !== undefined && (a === on) === (b === on);
}
let profilePolicyEnvironment: Readonly<Record<string, string | undefined>> | undefined;

function a19PolicyEnvironment(): Readonly<Record<string, string | undefined>> {
    if (profilePolicyEnvironment) return profilePolicyEnvironment;
    const withheld = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
    try {
        const environment = buildV08A19SearchEnvironment();
        const policy: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(environment)) {
            if (AI_POLICY_ENV.test(key) && !AI_POLICY_ENV_IGNORED.has(key)) policy[key] = value;
        }
        profilePolicyEnvironment = Object.freeze(policy);
    } finally {
        if (withheld !== undefined) process.env.V08_A19_SEARCH_ENV_OVERRIDES = withheld;
    }
    return profilePolicyEnvironment;
}

/**
 * The library implements the production AI only: every policy-namespace variable a rollout reads must mean what the
 * A19 profile's value means (unset where the profile unsets it; samePolicyMeaning), as the bot seat scopes it around
 * each decision, and no other may be set. Root-only knobs (AI_POLICY_ENV_IGNORED) are not checked.
 */
export function nativeEnvironmentRefusal(
    env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
    const expected = a19PolicyEnvironment();
    for (const [key, value] of Object.entries(expected)) {
        if (!samePolicyMeaning(key, env[key], value)) return `env:${key}`;
    }
    for (const key of Object.keys(env)) {
        if (env[key] === undefined || !AI_POLICY_ENV.test(key) || AI_POLICY_ENV_IGNORED.has(key)) continue;
        if (!(key in expected) && !samePolicyMeaning(key, env[key], undefined)) return `env:${key}`;
    }
    return null;
}

// ---- one root, one bank ----------------------------------------------------------------------------------------

/** One chooseSearchDecision: its loaded board, or why it stays in TypeScript. */
export class NativeRootScope {
    public handle: INativeStateHandle | undefined;
    public refused: string | undefined;
    /** per team ("1", "2"): the library policy its rollouts play */
    public policies: Record<string, { version: NativePolicyVersion }> | undefined;
    /** a native bank ran and no rollout has reset the active unit since (sentinels) */
    public afterNative = false;
    public counted = false;
    /** the export, kept for shadow dumps and the fixture */
    public json: string | undefined;
    public constructor(public readonly version: string) {}
    public close(): void {
        this.handle?.free();
        this.handle = undefined;
    }
}

export interface INativeRolloutStatistics {
    mode: NativeRolloutMode;
    banks: number;
    nativeBanks: number;
    tsBanks: number;
    nativeCalls: number;
    roots: number;
    nativeRoots: number;
    nativeTurns: number;
    tsTurns: number;
    nativeBankMs: number;
    tsBankMs: number;
    /** per bank: why it ran in TypeScript */
    fallback: Record<string, number>;
    /** per root: why its board stayed in TypeScript */
    rootFallback: Record<string, number>;
    /** native banks cut by the deadline or the turn budget */
    stops: Record<string, number>;
    /** roots the pre-check passed and the loader or a request refused */
    precheckMisses: number;
    shadowBanks: number;
    shadowMismatches: number;
    shadowRollouts: number;
    shadowRolloutMismatches: number;
    shadowSkipped: number;
    /** sentinels: reads the native bank does not reproduce */
    leftoverDraws: number;
    activeReadsAfterNative: number;
}

export function emptyNativeRolloutStatistics(mode: NativeRolloutMode): INativeRolloutStatistics {
    return {
        mode,
        banks: 0,
        nativeBanks: 0,
        tsBanks: 0,
        nativeCalls: 0,
        roots: 0,
        nativeRoots: 0,
        nativeTurns: 0,
        tsTurns: 0,
        nativeBankMs: 0,
        tsBankMs: 0,
        fallback: {},
        rootFallback: {},
        stops: {},
        precheckMisses: 0,
        shadowBanks: 0,
        shadowMismatches: 0,
        shadowRollouts: 0,
        shadowRolloutMismatches: 0,
        shadowSkipped: 0,
        leftoverDraws: 0,
        activeReadsAfterNative: 0,
    };
}

export const countNativeReason = (counts: Record<string, number>, reason: string): void => {
    counts[reason] = (counts[reason] ?? 0) + 1;
};

/** A refusal message without ids and numbers, as a counter key. */
export const nativeReason = (message: string): string =>
    message
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
        .replace(/\d+/g, "N")
        .slice(0, 100);

export interface INativeBankInput {
    actor: string;
    actingTeam: number;
    candidates: readonly { kind: string; actions: readonly unknown[] }[];
    seedBase: number;
    horizonMode: string;
    turnHorizon: number;
    rolloutCount: number;
    chance: "plain" | "antithetic";
    leaf: { kind: "v2" | "v1" | "material"; exactTerminal: boolean };
    policies: Record<string, { version: NativePolicyVersion }>;
    soleAbominationDefend: boolean;
    harness: INativeHarness;
    /** the counters the bank starts from */
    start: { uuid: number; summon: number };
    captureMaterial: boolean;
    /** scoreCandidates' bound hopeless tails (offline): the selection bounds and the margin */
    tails?: { selectionBounds?: SearchSelectionBounds; margin: number };
    /** rolloutTurnLimit and counters.rolloutTurnsTotal at the bank's start */
    turnLimit: number | null;
    turnsBefore: number;
    deadlineAt: number | null;
}

export interface INativeBankResult {
    means: number[];
    materials: number[];
    turns: number;
    uuid: number;
    /** "done", "deadline" or "turn_budget" */
    stop: string;
    calls: number;
    records: INativePairRecord[];
    requests: object[];
    /** a rollout ran (rolloutEnemyTeam is set) */
    played: boolean;
    /**
     * the harness names summons from the uuid sequence (summonIds "uuidSequence", the server's): the records'
     * summonSequence is then the library's own count, which TypeScript does not keep (zig/BRIDGE.md)
     */
    uuidNamed?: boolean;
}

/**
 * One bank with scoreCandidates' exact loop semantics: live (no tail bounds) one call; offline with bounds one call per
 * candidate, each with the reference TypeScript would use for it. The per-pair records replay TypeScript's bookkeeping
 * (sums, the -Infinity break, materials, the selection bounds, the best finished mean, leaves outside [0, 1]). Throws
 * the bridge's HocError on a refusal; nothing of the driver is touched here.
 */
export function runNativeBank(
    native: INativeRolloutBackend,
    handle: INativeStateHandle,
    input: INativeBankInput,
): INativeBankResult {
    const { flags } = native;
    const R = input.rolloutCount;
    const base = {
        actor: input.actor,
        actingTeam: input.actingTeam,
        seedBase: input.seedBase,
        chance: input.chance,
        horizon: { mode: input.horizonMode, turns: input.turnHorizon },
        leaf: input.leaf,
        policies: input.policies,
        soleAbominationDefend: input.soleAbominationDefend,
        summonIds: input.harness.summonIds,
        // Named only when the harness names it, so a "match" harness sends the request it always sent.
        ...(input.harness.engine !== undefined ? { engine: input.harness.engine } : {}),
    };
    const deadlineNs = (): bigint =>
        input.deadlineAt === null
            ? 0n
            : native.nowNs() + BigInt(Math.max(1, Math.floor((input.deadlineAt - performance.now()) * 1e6)));
    const means: number[] = [];
    const materials: number[] = [];
    const records: INativePairRecord[] = [];
    const requests: object[] = [];
    let turns = 0;
    let uuid = input.start.uuid;
    // "rollout": every call starts from the bank's sequence (runMatch restores it per rollout); "call": it chains.
    let summon = input.start.summon;
    let calls = 0;
    let played = false;
    let leafOutsideUnitInterval = false;
    let bestFinishedMean = Number.NEGATIVE_INFINITY;
    const done = (stop: string): INativeBankResult => ({
        means,
        materials,
        turns,
        uuid,
        stop,
        calls,
        records,
        requests,
        played,
        uuidNamed: input.harness.summonIds === "uuidSequence",
    });
    const tails = input.tails;
    const groups: number[][] = tails
        ? input.candidates.map((_, index) => [index])
        : [input.candidates.map((_, index) => index)];
    for (const group of groups) {
        let tailBound: { reference: number | null; margin: number; rolloutCount: number } | undefined;
        if (tails && !leafOutsideUnitInterval) {
            const reference = tails.selectionBounds?.referenceMean(group[0]) ?? bestFinishedMean;
            tailBound = {
                reference: Number.isFinite(reference) ? reference : null,
                margin: tails.margin,
                rolloutCount: R,
            };
        }
        // scoreCandidates asserts the budget before every candidate: a bank already past it stops here.
        if (input.turnLimit !== null && input.turnsBefore + turns > input.turnLimit) return done("turn_budget");
        const pairs: [number, number][] = [];
        for (let k = 0; k < group.length; k += 1) for (let r = 0; r < R; r += 1) pairs.push([k, r]);
        const request = {
            ...base,
            candidates: group.map((index) => ({
                kind: input.candidates[index].kind,
                actions: input.candidates[index].actions,
            })),
            pairs,
            ...(input.turnLimit === null ? {} : { turnBudget: input.turnLimit - (input.turnsBefore + turns) }),
            summonSequence: summon,
            uuidSequence: uuid,
            bank: {
                skipAfterIllegal: true,
                summonScope: input.harness.summonScope,
                material: input.captureMaterial,
                ...(tailBound ? { tailBound } : {}),
            },
        };
        requests.push(request);
        const result = native.engine.rollouts(handle, request, deadlineNs());
        calls += 1;
        const pairRecords = native.engine.rolloutPairs();
        records.push(...pairRecords);
        turns += result.turns;
        uuid = result.uuidSequence;
        if (input.harness.summonScope === "call") summon = result.summonSequence;
        for (let k = 0; k < group.length; k += 1) {
            const candidateIndex = group[k];
            let sum = 0;
            let completed = 0;
            let materialSum = 0;
            let materialCount = 0;
            let illegal = false;
            for (let r = 0; r < R; r += 1) {
                const record = pairRecords[k * R + r];
                if (!record || record.flags === flags.aborted || record.flags === flags.notReached) {
                    if (record?.flags === flags.aborted) played = true;
                    return done(result.stop === "done" ? "deadline" : result.stop);
                }
                if (record.flags === flags.skippedIllegal || record.flags === flags.skippedTail) break;
                played = true;
                const score = record.value;
                if (input.captureMaterial && Number.isFinite(score)) {
                    materialSum += record.material;
                    materialCount += 1;
                }
                if (score === Number.NEGATIVE_INFINITY) {
                    illegal = true;
                    break;
                }
                sum += score;
                completed += 1;
                if (!Number.isFinite(score) || score > 1) leafOutsideUnitInterval = true;
            }
            means.push(illegal ? Number.NEGATIVE_INFINITY : sum / R);
            if (tails?.selectionBounds && !illegal && completed === R) {
                tails.selectionBounds.recordFinished(candidateIndex, sum / R);
            }
            if (tails && !leafOutsideUnitInterval && !illegal && completed === R && sum / R > bestFinishedMean) {
                bestFinishedMean = sum / R;
            }
            if (input.captureMaterial) {
                materials.push(!illegal && materialCount === R ? materialSum / R : Number.NEGATIVE_INFINITY);
            }
        }
        if (result.stop !== "done") return done(result.stop);
    }
    return done("done");
}

// ---- shadow mode -----------------------------------------------------------------------------------------------

/** One TypeScript rollout, as shadow mode records it around SearchDriver.rollout. */
export interface INativeShadowRollout {
    candidate: unknown;
    r: number;
    value?: number;
    aborted: boolean;
    turns: number;
    uuid: number;
    summon: number;
    /** the finishing team inside the rollout, 0 none, -1 when it did not finish */
    winner: number;
    material?: number;
}

export interface INativeShadowTypeScriptBank {
    means?: readonly number[];
    materials?: readonly number[];
    threw: boolean;
    turns: number;
    uuid: number;
    rollouts: readonly INativeShadowRollout[];
}

/** The differences between a TypeScript bank and its native replay (empty: identical), and the counts it compared. */
export function compareNativeShadowBank(
    flags: INativePairFlags,
    ts: INativeShadowTypeScriptBank,
    native: INativeBankResult,
    start: { summon: number },
    captureMaterial: boolean,
): { fails: string[]; rollouts: number; rolloutMismatches: number; skipped: number; summoned: number } {
    const fails: string[] = [];
    if (ts.threw ? native.stop === "done" : native.stop !== "done") {
        fails.push(`stop ${native.stop} vs TypeScript ${ts.threw ? "threw" : "done"}`);
    }
    if (native.turns !== ts.turns) fails.push(`turns ${native.turns} vs ${ts.turns}`);
    if (!ts.threw && native.uuid !== ts.uuid) fails.push(`uuid ${native.uuid} vs ${ts.uuid}`);
    if (
        !ts.threw &&
        !(ts.means?.length === native.means.length && ts.means.every((v, i) => Object.is(v, native.means[i])))
    ) {
        fails.push("means");
    }
    if (
        captureMaterial &&
        !ts.threw &&
        ts.materials &&
        !ts.materials.every((value, index) => Object.is(value, native.materials[index]))
    ) {
        fails.push("materials");
    }
    const played = native.records.filter((r) => r.flags === flags.played || r.flags === flags.aborted);
    const skipped = native.records.filter((r) => r.flags === flags.skippedIllegal || r.flags === flags.skippedTail);
    if (played.length !== ts.rollouts.length) fails.push(`rollouts ${played.length} vs ${ts.rollouts.length}`);
    let rolloutMismatches = 0;
    let summoned = 0;
    const compared = Math.min(played.length, ts.rollouts.length);
    for (let i = 0; i < compared; i += 1) {
        const n = played[i];
        const t = ts.rollouts[i];
        if (t.summon !== start.summon) summoned += 1;
        const tsMaterial = t.material ?? Number.NaN;
        const same =
            (t.aborted ? n.flags === flags.aborted : n.flags === flags.played && Object.is(n.value, t.value)) &&
            n.turns === t.turns &&
            n.uuidSequence === t.uuid &&
            // Under uuid naming TypeScript keeps no summon counter (the record holds the bank's start value), while
            // the library still counts its summons; the uuid sequence above already names every summon.
            (native.uuidNamed === true || n.summonSequence === t.summon) &&
            n.winner === t.winner &&
            (!captureMaterial ||
                (Number.isNaN(tsMaterial) ? Number.isNaN(n.material) : Object.is(n.material, tsMaterial)));
        if (!same) {
            rolloutMismatches += 1;
            if (fails.length < 6) {
                fails.push(
                    `rollout ${i}: native ${JSON.stringify(n)} TypeScript ${JSON.stringify({ ...t, candidate: undefined })}`,
                );
            }
        }
    }
    return { fails, rollouts: compared, rolloutMismatches, skipped: skipped.length, summoned };
}

const hexOf = (x: number): string | null => {
    if (Number.isNaN(x)) return null;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    return view.getBigUint64(0).toString(16).padStart(16, "0");
};

/**
 * The self-test fixture's expected records (zig/src/selftest/expected.json) from TypeScript's rollouts of one bank:
 * per pair the value and material as IEEE hex, turns, flags, counters and winner; a skipped pair carries the counters
 * it was skipped at.
 */
export function nativeFixtureExpected(
    flags: INativePairFlags,
    ts: INativeShadowTypeScriptBank,
    candidates: readonly unknown[],
    rolloutCount: number,
    start: { uuid: number; summon: number },
    summonScope: "rollout" | "call",
    captureMaterial: boolean,
): { turns: number; stop: number; pairs: object[] } {
    const pairs: object[] = [];
    let index = 0;
    let summon = start.summon;
    let uuid = start.uuid;
    for (const candidate of candidates) {
        let skip = 0;
        for (let r = 0; r < rolloutCount; r += 1) {
            if (skip) {
                pairs.push({
                    value: null,
                    material: null,
                    turns: 0,
                    flags: skip,
                    summonSequence: summon,
                    uuidSequence: uuid,
                    winner: -1,
                });
                continue;
            }
            const t = ts.rollouts[index++];
            if (!t || t.candidate !== candidate || t.r !== r)
                throw new Error("native fixture: TypeScript rollout order");
            const value = t.value ?? Number.NaN;
            pairs.push({
                value: hexOf(value),
                material: captureMaterial && Number.isFinite(value) ? hexOf(t.material ?? Number.NaN) : null,
                turns: t.turns,
                flags: flags.played,
                summonSequence: t.summon,
                uuidSequence: t.uuid,
                winner: t.winner,
            });
            uuid = t.uuid;
            summon = summonScope === "rollout" ? start.summon : t.summon;
            if (value === Number.NEGATIVE_INFINITY) skip = flags.skippedIllegal;
        }
    }
    return { turns: ts.turns, stop: 0, pairs };
}

/** The deterministic uuid counter now (the native request's uuidSequence). */
export const nativeUuidSequence = (): number => captureDeterministicRandomState().uuidSequence;

// ---- sentinels, dumps and the fixture ---------------------------------------------------------------------------

let activeRoot: NativeRootScope | undefined;

/** chooseSearchDecision's root becomes the one the active-unit sentinel reads; returns the outer root. */
export function enterNativeRoot(root: NativeRootScope | undefined): NativeRootScope | undefined {
    const outer = activeRoot;
    activeRoot = root;
    return outer;
}

export const nativeSentinelsThrow = (): boolean => process.env[NATIVE_SENTINELS_ENV] === "throw";

let exportSideEffects = 0;
/** Exports this process found changing the state they read (HOC_NATIVE_SENTINELS only). */
export const nativeExportSideEffects = (): number => exportSideEffects;

const DIGEST_EVERYTHING = { setup: true, terrain: true, batch3: true, spells: true, batch4: true, helpingHand: true };

/** The board's parity digest (zig/parity/digest.ts), with the fight FightStateManager holds when it is another one. */
export function boardDigest(
    battleDigest: (battle: INativeExportBattle, options: Record<string, boolean>) => { fight: unknown },
    battle: INativeExportBattle,
): string {
    const bound: unknown = FightStateManager.getInstance().getFightProperties();
    return JSON.stringify([
        battleDigest(battle, DIGEST_EVERYTHING),
        bound && bound !== battle.fightProperties
            ? battleDigest({ ...battle, fightProperties: bound }, DIGEST_EVERYTHING).fight
            : null,
    ]);
}

/**
 * A step of the native path that may only read: the root's pre-check and export, and the backend's one-time load (the
 * bridge's self-test, the manifests' pre-checks). The TypeScript search goes on from the same state after each, so a
 * step that drew from the seeded source, moved the deterministic uuid sequence (the server names its summons from it,
 * and unit ids seed the rollouts) or changed the board would shift every later TypeScript rollout of the search, and a
 * once-per-process step (a cached summon template) would make searches depend on the process's history. A failed step
 * leaves the random state as it found it. Under HOC_NATIVE_SENTINELS each step is checked: the seeded source's draws
 * (counted through a forwarding source), the uuid sequence, and the board's digest with FightStateManager's fight (when
 * a board is given), before and after; "throw" throws on a difference, "count" counts it (nativeExportSideEffects) and
 * logs it once.
 */
export function rootStepWithoutSideEffects<T>(
    step: string,
    run: () => T,
    digest?: (battle: INativeExportBattle) => string,
    battle?: INativeExportBattle,
): T {
    const random = captureDeterministicRandomState();
    const sentinels = process.env[NATIVE_SENTINELS_ENV];
    const guarded = (): T => {
        try {
            return run();
        } catch (error) {
            restoreDeterministicRandomState(random);
            throw error;
        }
    };
    if (!sentinels) return guarded();
    // The check never refuses a root itself: a board the digest cannot read is checked without it.
    const digestOrNull = (): string | null => {
        if (!digest || !battle) return null;
        try {
            return digest(battle);
        } catch (error) {
            nativeRolloutLog("export-digest", `the export check skips the board digest: ${(error as Error).message}`);
            return null;
        }
    };
    const before = digestOrNull();
    const { source } = random;
    let draws = 0;
    if (source) {
        restoreDeterministicRandomState({
            source: () => {
                draws += 1;
                return source();
            },
            uuidSequence: random.uuidSequence,
        });
    }
    const result = guarded();
    const { uuidSequence } = captureDeterministicRandomState();
    restoreDeterministicRandomState({ source, uuidSequence });
    const moved: string[] = [];
    if (draws) moved.push(`drew ${draws} values from the seeded source`);
    if (uuidSequence !== random.uuidSequence)
        moved.push(`moved the uuid sequence ${random.uuidSequence} -> ${uuidSequence}`);
    if (before !== null && digestOrNull() !== before) moved.push("changed the board");
    if (moved.length) {
        exportSideEffects += 1;
        const message = `the ${step} ${moved.join(", ")}`;
        if (sentinels === "throw") throw new Error(`native rollouts: ${message}`);
        nativeRolloutLog(`side-effect:${step}`, `${message} (HOC_NATIVE_SENTINELS counts every one)`);
    }
    return result;
}

/** The root's export (exportBattleState as JSON), checked as rootStepWithoutSideEffects says. */
export function exportWithoutSideEffects(
    exportBattleState: (battle: INativeExportBattle, harness: INativeExportHarness) => unknown,
    digest: (battle: INativeExportBattle) => string,
    battle: INativeExportBattle,
    harness: INativeExportHarness,
): string {
    return rootStepWithoutSideEffects(
        "state export",
        () => JSON.stringify(exportBattleState(battle, harness)),
        digest,
        battle,
    );
}

const sentinelDeps = new WeakSet<object>();

/**
 * HOC_NATIVE_SENTINELS (count or throw): a read of the active unit between a native bank and the next rollout is a
 * read TypeScript would have answered with the last rollout's unit. Installed once per deps object.
 */
export function installNativeActiveUnitSentinel(
    deps: { getActiveUnitId(): string | undefined; setActiveUnitId(id: string): void },
    stats: () => INativeRolloutStatistics | undefined,
): void {
    if (!process.env[NATIVE_SENTINELS_ENV] || sentinelDeps.has(deps)) return;
    sentinelDeps.add(deps);
    const get = deps.getActiveUnitId.bind(deps);
    const set = deps.setActiveUnitId.bind(deps);
    deps.getActiveUnitId = () => {
        if (activeRoot?.afterNative) {
            const counters = stats();
            if (counters) counters.activeReadsAfterNative += 1;
            if (nativeSentinelsThrow())
                throw new Error("native rollouts: the active unit was read after a native bank");
        }
        return get();
    };
    deps.setActiveUnitId = (id: string) => {
        if (activeRoot) activeRoot.afterNative = false;
        set(id);
    };
}

let shadowDumps = 0;

/** A mismatching shadow bank: one log line, and its export and requests under HOC_NATIVE_SHADOW_DUMP_DIR (20 at most). */
export function reportNativeShadowMismatch(
    root: NativeRootScope,
    label: string,
    fails: readonly string[],
    requests: readonly object[],
): void {
    console.error(`[native-shadow] ${label} ${fails.slice(0, 3).join("; ").slice(0, 600)}`);
    const dir = process.env[NATIVE_SHADOW_DUMP_DIR_ENV];
    if (!dir || !root.json || shadowDumps >= 20) return;
    shadowDumps += 1;
    try {
        mkdirSync(dir, { recursive: true });
        const name = `${dir}/shadow_${process.pid}_${shadowDumps}`;
        writeFileSync(`${name}.state.json`, root.json);
        requests.forEach((request, index) => writeFileSync(`${name}.req${index}.json`, JSON.stringify(request)));
    } catch (error) {
        nativeRolloutLog("dump", `shadow dump failed: ${(error as Error).message}`);
    }
}

let pendingFixture: { json: string; kinds: string[]; requests: object[]; expected: object[] } | undefined;
let fixtureWritten: string | undefined;

/** Which fixture this process wrote (shadow mode with HOC_NATIVE_FIXTURE_DIR), if any. */
export const nativeFixtureWritten = (): string | undefined => fixtureWritten;

/**
 * The self-test fixture (zig/src/selftest/{state,requests,expected}.json): the first root whose stock (antithetic R2)
 * and deep (plain R8) H64 banks both matched in one call each, with at least three candidates; the expected records are
 * TypeScript's. Stock and deep search the same board from separate roots, matched by the export.
 */
export function offerNativeFixtureBank(root: NativeRootScope, request: { chance?: string }, expected: object): void {
    const dir = process.env[NATIVE_FIXTURE_DIR_ENV];
    if (!dir || fixtureWritten || !root.json) return;
    const kind = request.chance === "antithetic" ? "stock" : "deep";
    if (!pendingFixture || pendingFixture.json !== root.json) {
        pendingFixture = { json: root.json, kinds: [], requests: [], expected: [] };
    }
    if (pendingFixture.kinds.includes(kind)) return;
    pendingFixture.kinds.push(kind);
    pendingFixture.requests.push(request);
    pendingFixture.expected.push(expected);
    if (pendingFixture.kinds.length < 2) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/state.json`, pendingFixture.json);
    writeFileSync(`${dir}/requests.json`, JSON.stringify(pendingFixture.requests));
    writeFileSync(`${dir}/expected.json`, JSON.stringify(pendingFixture.expected));
    fixtureWritten = `${pendingFixture.kinds.join("+")} in ${dir}`;
}
