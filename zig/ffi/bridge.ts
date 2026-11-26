/*
 * bun:ffi binding of the Zig bridge (zig/src/ffi.zig, built by `cd zig && zig build lib -Drelease=true`). The ABI,
 * the state and request formats and the ownership rules are in zig/BRIDGE.md.
 *
 *   const engine = HocEngine.open();                      // one per worker thread; throws when the library is unusable
 *   const state = engine.load(exportBattleState(ctx, { rng, activeUnitId, armyProfile }));
 *   const values = engine.rollouts(state, request);       // one f64 per (candidate, r) pair
 *   const pairs = engine.rolloutPairs();                  // the call's per-pair records (ABI 3)
 *   state.free(); engine.free();
 *
 * Production callers use the fail-safe entry instead: `loadHocEngine({ commonSha })` returns null (and logs once) when
 * the library is missing, fails to load, has another ABI or common commit, or fails its self-test; the caller then runs
 * TypeScript. Importing this module never loads the library.
 *
 * HOC_SIM_LIB overrides the library path (default zig/zig-out/lib/libhocsim.<dylib|so>).
 */

import { dlopen, FFIType, suffix, type Pointer } from "bun:ffi";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Must equal ffi.zig ABI_VERSION. */
export const HOC_ABI_VERSION = 3;

export const HOC_LIB_PATH =
    process.env.HOC_SIM_LIB ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "zig-out", "lib", `libhocsim.${suffix}`);

const { ptr: P, u32, i32, i64, u64, f64, cstring, void: VOID } = FFIType;

const SYMBOLS = {
    hoc_abi_version: { args: [], returns: u32 },
    hoc_now_ns: { args: [], returns: u64 },
    hoc_engine_new: { args: [], returns: P },
    hoc_engine_free: { args: [P], returns: VOID },
    hoc_last_error: { args: [P], returns: cstring },
    hoc_state_load: { args: [P, P, u64], returns: P },
    hoc_state_clone: { args: [P, P], returns: P },
    hoc_state_free: { args: [P, P], returns: VOID },
    hoc_state_digest_json: { args: [P, P, P, u64], returns: i64 },
    hoc_state_check_digest: { args: [P, P, P, u64], returns: i32 },
    hoc_play_v01: { args: [P, P, i32, P], returns: i32 },
    hoc_rollouts: { args: [P, P, P, u64, P, u64, u64], returns: i32 },
    hoc_rollout_stats: { args: [P, P], returns: i32 },
    hoc_rollout_pairs: { args: [P, P, u64], returns: i32 },
    hoc_build_info: { args: [], returns: cstring },
    hoc_scope_manifest: { args: [P, u64], returns: cstring },
    hoc_exp: { args: [f64], returns: f64 },
    hoc_self_test: { args: [P], returns: i32 },
} as const;

type HocSymbols = ReturnType<typeof dlopen<typeof SYMBOLS>>["symbols"];

export class HocError extends Error {}

/** hoc_build_info(): the library's identity. */
export interface IHocBuildInfo {
    abi: number;
    /** the common commit it was built from (`-Dcommon-sha`), "unknown" for a development build */
    commonSha: string;
    /** sha256 of the scope manifest's body: the coverage this build accepts */
    coverage: string;
    zig: string;
    target: string;
    cpu: string;
    optimize: string;
    snapshotFormat: number;
    glibc: string | null;
}

interface ILoadedLibrary {
    path: string;
    symbols: HocSymbols;
    buildInfo: IHocBuildInfo;
}

const opened = new Map<string, ILoadedLibrary | { error: string }>();

/** dlopen + ABI check, once per path; never throws. */
function openLibrary(path: string): ILoadedLibrary | { error: string } {
    const known = opened.get(path);
    if (known) return known;
    let result: ILoadedLibrary | { error: string };
    try {
        // The ABI first, through the one symbol every version exports: another ABI may lack the newer symbols.
        const probe = dlopen(path, { hoc_abi_version: SYMBOLS.hoc_abi_version });
        const abi = probe.symbols.hoc_abi_version();
        probe.close();
        if (abi !== HOC_ABI_VERSION) {
            result = { error: `libhocsim ABI ${abi} != binding ${HOC_ABI_VERSION}: rebuild the library (${path})` };
        } else {
            const lib = dlopen(path, SYMBOLS);
            const info = JSON.parse(String(lib.symbols.hoc_build_info())) as IHocBuildInfo;
            result = { path, symbols: lib.symbols, buildInfo: info };
        }
    } catch (e) {
        result = { error: `libhocsim unavailable at ${path}: ${(e as Error).message}` };
    }
    opened.set(path, result);
    return result;
}

/** The loaded library at `path` (default HOC_LIB_PATH); throws HocError when it is missing or has another ABI. */
export function requireHocLibrary(path = HOC_LIB_PATH): ILoadedLibrary {
    const lib = openLibrary(path);
    if ("error" in lib) throw new HocError(lib.error);
    return lib;
}

/**
 * The raw symbols of the default library, for overhead measurements (resolved on first use, so importing this module
 * loads nothing; a missing library throws at that first use).
 */
export const hocSymbols: HocSymbols = new Proxy({} as HocSymbols, {
    get: (_target, key) => (requireHocLibrary().symbols as any)[key],
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(value: string | object): Uint8Array {
    // A zero-length buffer cannot be passed as a pointer; JSON is never empty.
    return encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
}

/** CLOCK_MONOTONIC nanoseconds (the clock of the rollouts deadline). */
export function hocNowNs(): bigint {
    return BigInt(requireHocLibrary().symbols.hoc_now_ns());
}

/** rollout.PlayResult */
export interface IHocPlayResult {
    /** 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (no longer produced: the recovery net is ported) */
    end: number;
    /** fight_finished's team (2 = LEFT/green, 1 = RIGHT/red, 0 = none), -1 when the fight did not finish */
    winner: number;
    lap: number;
    steps: number;
    decisions: number;
    /** the random stream's state at the end */
    rng: number;
}

export const HOC_END_REASONS = ["elimination", "turn_cap", "stuck", "observer_stop", "unsupported"] as const;
export const HOC_ROLLOUT_STOPS = ["done", "deadline", "turn_budget", "out_full"] as const;

/** One candidate of a rollouts request: a GameAction list; kind "incumbent" gets the real loop's semantics. */
export interface IHocCandidate {
    kind: string;
    actions: unknown[];
}

/** v0.7's army profile of one team (StrategyV0_7.primeArmyProfile at placement), as the v0.8 policy needs it. */
export interface IHocArmyProfile {
    /** MELEE_MAGIC stacks at the fight's start */
    meleeMagic: number;
    /** every stack emits an aura (v0.7's v0.4 anchor) */
    auraSaturated?: boolean;
}

/**
 * ABI 3: SearchDriver.scoreCandidates' bank semantics for one call (zig/BRIDGE.md). Pairs must be candidate-major
 * when `skipAfterIllegal` or `tailBound` is set. Unknown keys are refused.
 */
export interface IHocBank {
    /** scoreCandidates' `break` after a -Infinity rollout: the candidate's later pairs are skipped */
    skipAfterIllegal?: boolean;
    /** "rollout": runMatch's captureAuxiliaryState restores the summon sequence after every rollout; "call" (default):
     * it carries over (the server, which names summons by uuid) */
    summonScope?: "call" | "rollout";
    /** the A19 material sample after every finite rollout ("turns" banks with captureA19Material) */
    material?: boolean;
    /** remainingRolloutsCannotWin with one reference for the call (null reference = -Infinity: never fires) */
    tailBound?: { reference: number | null; margin: number; rolloutCount: number } | null;
}

/** hoc_rollouts' request (zig/BRIDGE.md). Unported options fail the call instead of being ignored. */
export interface IHocRolloutRequest {
    actor: string;
    actingTeam?: number;
    seedBase: number;
    /**
     * "plain": makeRng((seedBase + r * 0x9e3779b1) >>> 0); "antithetic": SearchDriver's complementary R2 stream,
     * makeSearchChanceStream(seedBase, r, "actor-antithetic") (r 0..3, a uint32 seedBase)
     */
    chance?: "plain" | "antithetic";
    horizon?: { mode: "turns" | "lap" | "reply" | "leaf"; turns?: number };
    /** "material", "v1" (DEFAULT_V07_VALUE_WEIGHTS) or "v2" (V08_A13_VALUE_LEAF, production's) */
    leaf?: { kind: "material" | "v1" | "v2"; exactTerminal?: boolean };
    /** per team ("1" RIGHT, "2" LEFT): the policy version ("v0.1" or "v0.8") and its switches (none supported yet) */
    policies: Record<string, { version: string; switches?: Record<string, unknown> }>;
    candidates: IHocCandidate[];
    /** [candidateIndex, r] in output order */
    pairs: [number, number][];
    /** rollout turns the call may play (rolloutTurnLimit - rolloutTurnsTotal); absent = unbounded */
    turnBudget?: number;
    /** SearchDriver's sole-Abomination Armageddon defend rule (on in the A19 profile) */
    soleAbominationDefend?: boolean;
    /** test hook for the recovery net: drop the policy calls whose per-rollout index n has imul(n + 1, 0x85ebca6b) % k == 0 */
    testDropDecisions?: number;
    /** per team: overrides the export's harness.armyProfile (a v0.8 seat needs one) */
    armyProfile?: Record<string, IHocArmyProfile | null>;
    /** the counters the first rollout starts from (default: the export's harness values) */
    summonSequence?: number;
    uuidSequence?: number;
    /** how a summon is named: runMatch's createSummonedUnit ("match", default) or the server's createSecureUuid */
    summonIds?: "match" | "uuidSequence";
    /** ABI 3: scoreCandidates' bank semantics; absent = ABI 2's plain pair loop */
    bank?: IHocBank;
}

export interface IHocRolloutResult {
    /** one value per completed pair (a prefix of the request's pairs; NaN for a pair the bank skipped) */
    values: Float64Array;
    turns: number;
    stop: (typeof HOC_ROLLOUT_STOPS)[number];
    /** the summon counters after the call (aborted rollouts included), for the next request */
    summonSequence: number;
    uuidSequence: number;
}

/** rollout.PairFlag */
export const HOC_PAIR_PLAYED = 0;
export const HOC_PAIR_SKIPPED_ILLEGAL = 1;
export const HOC_PAIR_ABORTED = 2;
export const HOC_PAIR_NOT_REACHED = 3;
export const HOC_PAIR_SKIPPED_TAIL = 4;

/** rollout.PairRecord: one pair of the last hoc_rollouts call. */
export interface IHocPairRecord {
    /** the leaf value, -Infinity for a rejected candidate, NaN when not played */
    value: number;
    /** the A19 material sample (bank.material and a finite value), else NaN */
    material: number;
    /** rollout turns the pair played (an aborted one included) */
    turns: number;
    /** HOC_PAIR_* */
    flags: number;
    /** the counters after the pair */
    summonSequence: number;
    uuidSequence: number;
    /** the fight_finished team inside the rollout (0 none), -1 when it did not finish */
    winner: number;
}

const PAIR_RECORD_BYTES = 40;

export class HocEngine {
    private records = new ArrayBuffer(PAIR_RECORD_BYTES * 64);

    private constructor(
        public readonly ptr: Pointer,
        private readonly sym: HocSymbols,
        public readonly buildInfo: IHocBuildInfo,
    ) {}

    /** A new engine on the default library (or `path`); throws HocError when the library is unusable. */
    public static open(path = HOC_LIB_PATH): HocEngine {
        const lib = requireHocLibrary(path);
        return HocEngine.on(lib);
    }

    /** @internal */
    public static on(lib: ILoadedLibrary): HocEngine {
        const ptr = lib.symbols.hoc_engine_new();
        if (!ptr) throw new HocError("hoc_engine_new failed");
        return new HocEngine(ptr as Pointer, lib.symbols, lib.buildInfo);
    }

    /** @internal the symbols this engine calls */
    public get symbols(): HocSymbols {
        return this.sym;
    }

    public lastError(): string {
        return String(this.sym.hoc_last_error(this.ptr));
    }

    /** Loads an exportBattleState object (or its JSON text). Throws HocError naming an unsupported state. */
    public load(state: string | object): HocState {
        const json = utf8(state);
        const ptr = this.sym.hoc_state_load(this.ptr, json, json.length);
        if (!ptr) throw new HocError(this.lastError());
        return new HocState(this, ptr as Pointer);
    }

    /**
     * Runs the request's rollouts. `deadlineNs` is absolute on hocNowNs()'s clock (0n = none). Throws HocError on an
     * unsupported or malformed request or a rollout that reached unported code (fall back to TypeScript).
     */
    public rollouts(state: HocState, request: IHocRolloutRequest | string, deadlineNs = 0n): IHocRolloutResult {
        const json = utf8(request);
        const cap = typeof request === "string" ? (JSON.parse(request).pairs?.length ?? 0) : request.pairs.length;
        const out = new Float64Array(Math.max(1, cap));
        const written = this.sym.hoc_rollouts(this.ptr, state.ptr, json, json.length, out, cap, deadlineNs);
        if (written < 0) throw new HocError(this.lastError());
        const stats = new BigUint64Array(4);
        this.sym.hoc_rollout_stats(this.ptr, stats);
        const stop = new Int32Array(stats.buffer, 12, 1)[0];
        return {
            values: out.slice(0, written),
            turns: Number(stats[0]),
            stop: HOC_ROLLOUT_STOPS[stop] ?? "done",
            summonSequence: Number(stats[2]),
            uuidSequence: Number(stats[3]),
        };
    }

    /** The last rollouts call's per-pair records (one per request pair, in order). */
    public rolloutPairs(): IHocPairRecord[] {
        let n = this.sym.hoc_rollout_pairs(this.ptr, null, 0);
        if (n < 0) throw new HocError("hoc_rollout_pairs failed");
        if (this.records.byteLength < n * PAIR_RECORD_BYTES) this.records = new ArrayBuffer(n * PAIR_RECORD_BYTES * 2);
        const buf = this.records;
        n = this.sym.hoc_rollout_pairs(this.ptr, new Uint8Array(buf), n);
        const f = new Float64Array(buf);
        const u = new Uint32Array(buf);
        const s = new Int32Array(buf);
        const out: IHocPairRecord[] = new Array(n);
        for (let i = 0; i < n; i++) {
            const w = i * 10;
            out[i] = {
                value: f[i * 5],
                material: f[i * 5 + 1],
                turns: u[w + 4],
                flags: u[w + 5],
                summonSequence: u[w + 6],
                winner: s[w + 7],
                // uuid_seq is a u64; the TypeScript counter is a safe integer
                uuidSequence: u[w + 8] + u[w + 9] * 4294967296,
            };
        }
        return out;
    }

    /** The scope manifest for `policy` ("v0.1", "v0.8"; "" = every policy). */
    public scopeManifest(policy = ""): IHocScopeManifest {
        return scopeManifestOf(this.sym, policy);
    }

    public free(): void {
        this.sym.hoc_engine_free(this.ptr);
    }
}

export class HocState {
    public constructor(
        private readonly engine: HocEngine,
        public readonly ptr: Pointer,
    ) {}

    public clone(): HocState {
        const ptr = this.engine.symbols.hoc_state_clone(this.engine.ptr, this.ptr);
        if (!ptr) throw new HocError(this.engine.lastError());
        return new HocState(this.engine, ptr as Pointer);
    }

    /** The state as zig/src/digest.zig writes it (record.ts digest columns plus `active` and `rng`). */
    public digest(): { units: unknown[][]; fight: Record<string, unknown>; active: string; rng: number } {
        let cap = 1 << 16;
        for (;;) {
            const buf = new Uint8Array(cap);
            const len = Number(this.engine.symbols.hoc_state_digest_json(this.engine.ptr, this.ptr, buf, cap));
            if (len < 0) throw new HocError(this.engine.lastError());
            if (len <= cap) return JSON.parse(decoder.decode(buf.subarray(0, len)));
            cap = len;
        }
    }

    /** compare.state against a zig/parity/digest.ts battleDigest: null when identical, else the first difference. */
    public checkDigest(digest: object): string | null {
        const json = utf8(digest);
        const r = this.engine.symbols.hoc_state_check_digest(this.engine.ptr, this.ptr, json, json.length);
        if (r < 0) throw new HocError(this.engine.lastError());
        return r === 1 ? null : this.engine.lastError();
    }

    /** Plays the battle out IN PLACE with v0.1 on both seats (clone first to keep it). */
    public playV01(maxLaps = 60): IHocPlayResult {
        const out = new Int32Array(6);
        if (this.engine.symbols.hoc_play_v01(this.engine.ptr, this.ptr, maxLaps, out) !== 0) {
            throw new HocError(this.engine.lastError());
        }
        const u = new Uint32Array(out.buffer);
        return { end: out[0], winner: out[1], lap: out[2], steps: u[3], decisions: u[4], rng: u[5] };
    }

    public free(): void {
        this.engine.symbols.hoc_state_free(this.engine.ptr, this.ptr);
    }
}

// ---- scope manifest ------------------------------------------------------------------------------------------------

/** hoc_scope_manifest (zig/src/scope.zig): what the library accepts, generated from the loader's own tables. */
export interface IHocScopeManifest {
    abi: number;
    commonSha: string;
    coverage: string;
    /** the policy this manifest is for, null for every policy */
    policy: string | null;
    scope: {
        loader: {
            format: number;
            abilities: string[];
            auraEffects: string[];
            /** names a buff, debuff or effect row may carry */
            applied: string[];
            spells: string[];
            spellEntryPrefixes: string[];
            spellFactions: number[];
            summons: string[];
            unitTypes: number[];
            teams: number[];
            footprint: [number, number];
            gridTypes: number[];
            boardCodes: string[];
            stackingEffect: string;
            /** buff rows whose stored properties are read besides the aura rows (augments, artifact rows) */
            storedPropertyBuffs: string[];
            /** the artifact ids the port plays per tier (artifactTier1PerTeam / artifactTier2PerTeam values; 0 = none) */
            artifacts: { tier1: number[]; tier2: number[] };
            /** the applied rows that make a board an artifact board (State.artifacts; a policy may refuse them) */
            artifactRows: { buffs: string[]; debuffs: string[] };
            capacities: Record<
                | "units"
                | "ids"
                | "abilities"
                | "stolen"
                | "buffs"
                | "debuffs"
                | "effects"
                | "spellEntries"
                | "spells"
                | "unitAuras"
                | "auraDefs"
                | "vines"
                | "smoke"
                | "fireWalls"
                | "stones"
                | "barrels"
                | "lap"
                | "possibleAttackTypes"
                | "storedProperty",
                number
            >;
            refuse: {
                unitFields: string[];
                /** "field.part": refused when the field and its part are both present (lastFuseFatalHit.source) */
                unitFieldParts: string[];
                unitProps: string[];
                /** name lists that may hold only these names (artifact_granted_abilities: the Wounding Charm's card) */
                unitPropsLimited: Record<string, string[]>;
                unitPropSuffix: string;
                unitPropSuffixKept: string[];
                grid: string[];
                fight: string[];
                artifactsPerTeam: string[];
            };
        };
        policies: Record<
            string,
            {
                castable: string[] | null;
                refusedAbilities: string[];
                refusedDebuffs: string[];
                refusedEffects: string[];
                refusedBuffs: string[];
                /** no unit may be a revived one (more applied_buffs names than buff objects: orphan augment rows) */
                refusedRevived: boolean;
                /** no unit may carry an artifact row (loader.artifactRows) */
                refusedArtifactRows: boolean;
                /** the board may hold no smoke cloud */
                refusedSmoke: boolean;
                /** the board may hold no burning cell (fire walls) */
                refusedFireWalls: boolean;
            }
        >;
        actions: string[];
    };
}

function scopeManifestOf(sym: HocSymbols, policy: string): IHocScopeManifest {
    const name = encoder.encode(policy);
    const text = sym.hoc_scope_manifest(name.length ? name : null, name.length);
    if (!text) throw new HocError(`no scope manifest for policy "${policy}"`);
    return JSON.parse(String(text)) as IHocScopeManifest;
}

// ---- fail-safe loading and the self-test ---------------------------------------------------------------------------

export interface IHocLoadOptions {
    /** the library (default HOC_LIB_PATH) */
    path?: string;
    /** the common commit the TypeScript beside it was built from; a library built from another (or "unknown") is refused */
    commonSha?: string;
    /** run the self-test before the first use (default true) */
    selfTest?: boolean;
    /** where the one-time refusal message goes (default console.error) */
    log?: (message: string) => void;
}

export interface IHocSelfTestReport {
    ok: boolean;
    reason?: string;
    path: string;
    buildInfo?: IHocBuildInfo;
    /** Math.exp against the library's libc exp on the fixed table */
    exp?: { inputs: number; mismatches: number; first?: { x: number; js: number; native: number } };
    /** the compiled-in state and request (hoc_self_test) */
    fixture?: { ok: boolean; error?: string };
}

/** The exp table: the leaves' logit range on a fixed mulberry32 stream, the extremes, and the special values. */
export function hocExpTable(): number[] {
    const out = [0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 5e-324, 708, 709.78, -708, -745, -745.2, 20, -20, 40, -40];
    let state = 0x5eed1234 >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 4096; i++) out.push((next() - 0.5) * 24); // |z| <= 12: where every leaf logit lands
    for (let i = 0; i < 1024; i++) out.push((next() - 0.5) * 1400); // the whole finite range
    return out;
}

/** Runs the self-test on the library at `path` (dlopen, ABI, commonSha, exp table, compiled-in rollouts). */
export function runHocSelfTest(opts: Pick<IHocLoadOptions, "path" | "commonSha"> = {}): IHocSelfTestReport {
    const path = opts.path ?? HOC_LIB_PATH;
    const lib = openLibrary(path);
    if ("error" in lib) return { ok: false, reason: lib.error, path };
    const report: IHocSelfTestReport = { ok: false, path, buildInfo: lib.buildInfo };
    if (opts.commonSha !== undefined && lib.buildInfo.commonSha !== opts.commonSha) {
        report.reason = `libhocsim was built from common ${lib.buildInfo.commonSha}, this process runs ${opts.commonSha}`;
        return report;
    }
    const inputs = hocExpTable();
    let mismatches = 0;
    for (const x of inputs) {
        const js = Math.exp(x);
        const native = lib.symbols.hoc_exp(x);
        if (!Object.is(js, native)) {
            mismatches += 1;
            report.exp ??= { inputs: inputs.length, mismatches: 0, first: { x, js, native } };
        }
    }
    report.exp = { ...(report.exp ?? { inputs: inputs.length }), inputs: inputs.length, mismatches };
    if (mismatches) {
        report.reason = `Math.exp differs from libhocsim's exp on ${mismatches} of ${inputs.length} inputs`;
        return report;
    }
    const engine = HocEngine.on(lib);
    try {
        const r = lib.symbols.hoc_self_test(engine.ptr);
        report.fixture = r === 1 ? { ok: true } : { ok: false, error: engine.lastError() };
    } finally {
        engine.free();
    }
    if (!report.fixture.ok) {
        report.reason = `libhocsim self-test failed: ${report.fixture.error}`;
        return report;
    }
    report.ok = true;
    return report;
}

const verdicts = new Map<string, IHocSelfTestReport>();

/**
 * The fail-safe entry: a new engine on a usable library, or null (logged once per process and reason) when the
 * library is missing, does not load, has another ABI, was built from another common commit than `commonSha`, or fails
 * its self-test. Never throws; the verdict is cached per path, commit and self-test setting.
 */
export function loadHocEngine(opts: IHocLoadOptions = {}): HocEngine | null {
    const path = opts.path ?? HOC_LIB_PATH;
    const selfTest = opts.selfTest ?? true;
    const key = `${path}\u0000${opts.commonSha ?? ""}\u0000${selfTest}`;
    let verdict = verdicts.get(key);
    if (!verdict) {
        try {
            if (selfTest) {
                verdict = runHocSelfTest({ path, commonSha: opts.commonSha });
            } else {
                const lib = openLibrary(path);
                if ("error" in lib) verdict = { ok: false, reason: lib.error, path };
                else if (opts.commonSha !== undefined && lib.buildInfo.commonSha !== opts.commonSha)
                    verdict = {
                        ok: false,
                        path,
                        buildInfo: lib.buildInfo,
                        reason: `libhocsim was built from common ${lib.buildInfo.commonSha}, this process runs ${opts.commonSha}`,
                    };
                else verdict = { ok: true, path, buildInfo: lib.buildInfo };
            }
        } catch (e) {
            verdict = { ok: false, path, reason: `libhocsim check failed: ${(e as Error).message}` };
        }
        verdicts.set(key, verdict);
        if (!verdict.ok) (opts.log ?? console.error)(`[hocsim] native rollouts off: ${verdict.reason}`);
    }
    if (!verdict.ok) return null;
    try {
        const lib = openLibrary(path);
        return "error" in lib ? null : HocEngine.on(lib);
    } catch {
        return null;
    }
}
