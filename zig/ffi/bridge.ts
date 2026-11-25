/*
 * bun:ffi binding of the Zig bridge (zig/src/ffi.zig, built by `cd zig && zig build lib -Drelease=true`). The ABI,
 * the state and request formats and the ownership rules are in zig/BRIDGE.md.
 *
 *   const engine = HocEngine.open();                      // one per worker thread
 *   const state = engine.load(exportBattleState(ctx, { rng, activeUnitId }));
 *   const values = engine.rollouts(state, request);       // one f64 per (candidate, r) pair
 *   state.free(); engine.free();
 *
 * HOC_SIM_LIB overrides the library path (default zig/zig-out/lib/libhocsim.<dylib|so>).
 */

import { dlopen, FFIType, suffix, type Pointer } from "bun:ffi";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Must equal ffi.zig ABI_VERSION. */
export const HOC_ABI_VERSION = 1;

export const HOC_LIB_PATH =
    process.env.HOC_SIM_LIB ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "zig-out", "lib", `libhocsim.${suffix}`);

const { ptr: P, u32, i32, i64, u64, cstring, void: VOID } = FFIType;

const lib = dlopen(HOC_LIB_PATH, {
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
});
if (lib.symbols.hoc_abi_version() !== HOC_ABI_VERSION) {
    throw new Error(
        `libhocsim ABI ${lib.symbols.hoc_abi_version()} != binding ${HOC_ABI_VERSION}: rebuild the library`,
    );
}

/** The raw symbols, for overhead measurements. */
export const hocSymbols = lib.symbols;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(value: string | object): Uint8Array {
    // A zero-length buffer cannot be passed as a pointer; JSON is never empty.
    return encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
}

/** CLOCK_MONOTONIC nanoseconds (the clock of the rollouts deadline). */
export function hocNowNs(): bigint {
    return BigInt(lib.symbols.hoc_now_ns());
}

/** rollout.PlayResult */
export interface IHocPlayResult {
    /** 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (recovery net not ported) */
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

/** hoc_rollouts' request (zig/BRIDGE.md). Unported options fail the call instead of being ignored. */
export interface IHocRolloutRequest {
    actor: string;
    actingTeam?: number;
    seedBase: number;
    /** "plain" only (makeRng((seedBase + r * 0x9e3779b1) >>> 0)); "antithetic" is not ported */
    chance?: "plain";
    horizon?: { mode: "turns" | "lap" | "reply" | "leaf"; turns?: number };
    /** "material" only; v1/v2 learned leaves are not ported */
    leaf?: { kind: "material"; exactTerminal?: boolean };
    /** per team ("1" RIGHT, "2" LEFT): the policy version ("v0.1") and its switches (none supported yet) */
    policies: Record<string, { version: string; switches?: Record<string, unknown> }>;
    candidates: IHocCandidate[];
    /** [candidateIndex, r] in output order */
    pairs: [number, number][];
    /** rollout turns the call may play (rolloutTurnLimit - rolloutTurnsTotal); absent = unbounded */
    turnBudget?: number;
}

export interface IHocRolloutResult {
    /** one value per completed pair (a prefix of the request's pairs) */
    values: Float64Array;
    turns: number;
    stop: (typeof HOC_ROLLOUT_STOPS)[number];
}

export class HocError extends Error {}

export class HocEngine {
    private constructor(public readonly ptr: Pointer) {}

    public static open(): HocEngine {
        const ptr = lib.symbols.hoc_engine_new();
        if (!ptr) throw new HocError("hoc_engine_new failed");
        return new HocEngine(ptr);
    }

    public lastError(): string {
        return String(lib.symbols.hoc_last_error(this.ptr));
    }

    /** Loads an exportBattleState object (or its JSON text). Throws HocError naming an unsupported state. */
    public load(state: string | object): HocState {
        const json = utf8(state);
        const ptr = lib.symbols.hoc_state_load(this.ptr, json, json.length);
        if (!ptr) throw new HocError(this.lastError());
        return new HocState(this, ptr);
    }

    /**
     * Runs the request's rollouts. `deadlineNs` is absolute on hocNowNs()'s clock (0n = none). Throws HocError on an
     * unsupported or malformed request or a rollout that reached unported code (fall back to TypeScript).
     */
    public rollouts(state: HocState, request: IHocRolloutRequest | string, deadlineNs = 0n): IHocRolloutResult {
        const json = utf8(request);
        const cap = typeof request === "string" ? (JSON.parse(request).pairs?.length ?? 0) : request.pairs.length;
        const out = new Float64Array(Math.max(1, cap));
        const written = lib.symbols.hoc_rollouts(this.ptr, state.ptr, json, json.length, out, cap, deadlineNs);
        if (written < 0) throw new HocError(this.lastError());
        const stats = new BigUint64Array(2);
        lib.symbols.hoc_rollout_stats(this.ptr, stats);
        const stop = new Int32Array(stats.buffer, 12, 1)[0];
        return { values: out.slice(0, written), turns: Number(stats[0]), stop: HOC_ROLLOUT_STOPS[stop] ?? "done" };
    }

    public free(): void {
        lib.symbols.hoc_engine_free(this.ptr);
    }
}

export class HocState {
    public constructor(
        private readonly engine: HocEngine,
        public readonly ptr: Pointer,
    ) {}

    public clone(): HocState {
        const ptr = lib.symbols.hoc_state_clone(this.engine.ptr, this.ptr);
        if (!ptr) throw new HocError(this.engine.lastError());
        return new HocState(this.engine, ptr);
    }

    /** The state as zig/src/digest.zig writes it (record.ts digest columns plus `active` and `rng`). */
    public digest(): { units: unknown[][]; fight: Record<string, unknown>; active: string; rng: number } {
        let cap = 1 << 16;
        for (;;) {
            const buf = new Uint8Array(cap);
            const len = Number(lib.symbols.hoc_state_digest_json(this.engine.ptr, this.ptr, buf, cap));
            if (len < 0) throw new HocError(this.engine.lastError());
            if (len <= cap) return JSON.parse(decoder.decode(buf.subarray(0, len)));
            cap = len;
        }
    }

    /** compare.state against a zig/parity/digest.ts battleDigest: null when identical, else the first difference. */
    public checkDigest(digest: object): string | null {
        const json = utf8(digest);
        const r = lib.symbols.hoc_state_check_digest(this.engine.ptr, this.ptr, json, json.length);
        if (r < 0) throw new HocError(this.engine.lastError());
        return r === 1 ? null : this.engine.lastError();
    }

    /** Plays the battle out IN PLACE with v0.1 on both seats (clone first to keep it). */
    public playV01(maxLaps = 60): IHocPlayResult {
        const out = new Int32Array(6);
        if (lib.symbols.hoc_play_v01(this.engine.ptr, this.ptr, maxLaps, out) !== 0) {
            throw new HocError(this.engine.lastError());
        }
        const u = new Uint32Array(out.buffer);
        return { end: out[0], winner: out[1], lap: out[2], steps: u[3], decisions: u[4], rng: u[5] };
    }

    public free(): void {
        lib.symbols.hoc_state_free(this.engine.ptr, this.ptr);
    }
}
