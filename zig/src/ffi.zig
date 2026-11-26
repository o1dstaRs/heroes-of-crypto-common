//! The bridge's C ABI (`zig build lib` -> zig-out/lib/libhocsim.{dylib,so}; binding in zig/ffi/bridge.ts). The format,
//! ownership and error rules are in zig/BRIDGE.md.
//!
//! An engine is a worker's scratch (one per thread: its last error, request arena and rollout state); a state handle is
//! a loaded battle with its unit id table, owned by the engine that loaded it. Calls never print and never panic on
//! bad input: they return an error code (-1, or null) and `hoc_last_error(engine)` says why.

const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine_mod = @import("engine.zig");
const compare = @import("compare.zig");
const snapshot = @import("snapshot.zig");
const rollout = @import("rollout.zig");
const digest = @import("digest.zig");
const ai = @import("ai.zig");
const scope = @import("scope.zig");

/// Bumped on any change to a signature, a struct layout or the request/snapshot format. 2: RolloutStats carries the
/// summon counters; requests take v0.8 policies, the antithetic chance, the v1/v2 leaves and the counters. 3: requests
/// take `bank` (scoreCandidates' bank semantics) and hoc_rollout_pairs returns per-pair records; hoc_build_info,
/// hoc_scope_manifest, hoc_exp and hoc_self_test. An ABI 2 request (no `bank`) runs exactly as before.
pub const ABI_VERSION: u32 = 3;

/// The common commit the library was built from (`zig build -Dcommon-sha=<sha>`, default "unknown"): the TypeScript
/// policy and this port are only the same when they come from one revision.
pub const COMMON_SHA: []const u8 = build_options.common_sha;

const alloc = std.heap.smp_allocator;

pub const Engine = struct {
    err: [512]u8 = undefined,
    err_len: usize = 0,
    /// Per-call parsing (requests, digests): reset at the start of each call that uses it.
    arena: std.heap.ArenaAllocator,
    /// The rollout copy of the root state.
    scratch: st.State = undefined,
    stats: RolloutStats = .{},
    /// The names behind the handle a rollout call runs on (rollout.Request.identity points here during the call).
    ident: rollout.Identity = .{ .ids = &.{}, .names = &.{} },
    /// The last hoc_rollouts call's per-pair records (one per request pair; hoc_rollout_pairs copies them out).
    records: []rollout.PairRecord = &.{},
    n_records: usize = 0,

    fn fail(self: *Engine, comptime fmt: []const u8, args: anytype) void {
        const s = std.fmt.bufPrint(self.err[0 .. self.err.len - 1], fmt, args) catch self.err[0 .. self.err.len - 1];
        self.err_len = s.len;
        self.err[self.err_len] = 0;
    }
    fn clearError(self: *Engine) void {
        self.err_len = 0;
        self.err[0] = 0;
    }
    fn tmp(self: *Engine) std.mem.Allocator {
        _ = self.arena.reset(.retain_capacity);
        return self.arena.allocator();
    }
};

/// Name ids a state can use: the holder's creatures and the two summon templates.
pub const MAX_NAMES = st.MAX_UNITS + 2;

/// v0.7's army profile of one team (StrategyV0_7.primeArmyProfile at placement), from the export's
/// `harness.armyProfile` or the request's `armyProfile`: what the v0.8 policy needs from the strategy instance.
pub const ArmyProfile = struct {
    present: bool = false,
    /// MELEE_MAGIC stacks at the fight's start.
    melee_magic: u8 = 0,
    /// Every stack emits an aura: v0.7 routes it through v0.4's archetype anchor (Request.aura_saturated).
    aura_saturated: bool = false,
};

/// A loaded battle: the state, the unit ids in index order and the creature names by Unit.name_id (copies owned by the
/// handle), the harness counters the TypeScript side keeps around a search, and the army profiles.
pub const Handle = struct {
    state: st.State,
    ids: [][]const u8,
    id_bytes: []u8,
    /// lib.ts deterministicUuidSequence at export time (`harness.uuidSequence`), -1 when absent (the state's uuid_seq
    /// then starts at 0).
    uuid_sequence: f64,
    names: [][]const u8 = &.{},
    name_bytes: []u8 = &.{},
    profile: [3]ArmyProfile = .{ .{}, .{}, .{} },
};

/// Totals of the last hoc_rollouts call.
pub const RolloutStats = extern struct {
    /// Rollout turns played (aborted rollouts included), for SearchDriver's counters.rolloutTurnsTotal.
    turns: u64 = 0,
    /// Values written.
    written: u32 = 0,
    /// rollout.Stop: 0 every pair done, 1 deadline, 2 turn budget, 3 output full.
    stop: i32 = 0,
    /// The summon counters after the last rollout played (aborted ones included): runMatch's createSummonedUnit
    /// counter and lib.ts deterministicUuidSequence, for the next call's `summonSequence` / `uuidSequence`.
    summon_sequence: u64 = 0,
    uuid_sequence: u64 = 0,
};

fn bytes(ptr: ?[*]const u8, len: usize) []const u8 {
    return if (ptr) |p| p[0..len] else &.{};
}

export fn hoc_abi_version() u32 {
    return ABI_VERSION;
}

/// CLOCK_MONOTONIC nanoseconds: the clock of hoc_rollouts' deadline.
export fn hoc_now_ns() u64 {
    return rollout.nowNs();
}

pub export fn hoc_engine_new() ?*Engine {
    const e = alloc.create(Engine) catch return null;
    e.* = .{ .arena = std.heap.ArenaAllocator.init(alloc) };
    e.clearError();
    return e;
}

pub export fn hoc_engine_free(eng: ?*Engine) void {
    const e = eng orelse return;
    if (e.records.len > 0) alloc.free(e.records);
    e.arena.deinit();
    alloc.destroy(e);
}

/// The last error of `eng` as a NUL-terminated string ("" after a successful call).
pub export fn hoc_last_error(eng: ?*const Engine) [*:0]const u8 {
    const e = eng orelse return "no engine";
    return @ptrCast(&e.err);
}

/// Copies `strings` into one owned buffer and a table of slices into it.
fn copyStrings(strings: []const []const u8) !struct { table: [][]const u8, bytes: []u8 } {
    var total: usize = 0;
    for (strings) |x| total += x.len;
    const buf = try alloc.alloc(u8, total);
    errdefer alloc.free(buf);
    const table = try alloc.alloc([]const u8, strings.len);
    var at: usize = 0;
    for (strings, 0..) |x, i| {
        @memcpy(buf[at .. at + x.len], x);
        table[i] = buf[at .. at + x.len];
        at += x.len;
    }
    return .{ .table = table, .bytes = buf };
}

/// What a handle carries besides its state and ids.
const HandleMeta = struct {
    uuid: f64 = -1,
    names: []const []const u8 = &.{},
    profile: [3]ArmyProfile = .{ .{}, .{}, .{} },
};

fn newHandle(e: *Engine, state: *const st.State, ids: []const []const u8, meta: HandleMeta) ?*Handle {
    const h = alloc.create(Handle) catch {
        e.fail("out of memory", .{});
        return null;
    };
    const id_copy = copyStrings(ids) catch {
        alloc.destroy(h);
        e.fail("out of memory", .{});
        return null;
    };
    const name_copy = copyStrings(meta.names) catch {
        alloc.free(id_copy.table);
        alloc.free(id_copy.bytes);
        alloc.destroy(h);
        e.fail("out of memory", .{});
        return null;
    };
    h.* = .{
        .state = state.*,
        .ids = id_copy.table,
        .id_bytes = id_copy.bytes,
        .uuid_sequence = meta.uuid,
        .names = name_copy.table,
        .name_bytes = name_copy.bytes,
        .profile = meta.profile,
    };
    return h;
}

fn metaOf(h: *const Handle) HandleMeta {
    return .{ .uuid = h.uuid_sequence, .names = h.names, .profile = h.profile };
}

/// The creature names by Unit.name_id: the snapshot's units in holder order (the loader interns names in that order)
/// and the summon templates' names.
fn nameTable(arena: std.mem.Allocator, root: std.json.Value, s: *const st.State) ![]const []const u8 {
    const names = try arena.alloc([]const u8, MAX_NAMES);
    for (names) |*n| n.* = "";
    var used: usize = 0;
    const units = rec.get(root, "units");
    if (units == .array) {
        for (units.array.items, 0..) |uv, slot| {
            if (slot >= s.n_holder) break;
            const id = s.units[slot].name_id;
            const name = rec.get(uv, "name");
            if (id < MAX_NAMES and name == .string) {
                names[id] = name.string;
                used = @max(used, id + 1);
            }
        }
    }
    for (s.summon_name_id, 0..) |id, k| {
        if (id < MAX_NAMES) {
            names[id] = st.SUMMON_NAMES[k];
            used = @max(used, id + 1);
        }
    }
    return names[0..used];
}

/// `{"1": {"meleeMagic": n, "auraSaturated": b} | null, "2": ...}` (absent teams keep no profile).
fn parseProfiles(v: std.json.Value, out: *[3]ArmyProfile) ?[]const u8 {
    if (v != .object) return if (v == .null) null else "armyProfile must be an object";
    for ([_]u8{ st.Team.RIGHT, st.Team.LEFT }) |team| {
        var key: [4]u8 = undefined;
        const k = std.fmt.bufPrint(&key, "{d}", .{team}) catch unreachable;
        const p = rec.get(v, k);
        if (p == .null) continue;
        if (p != .object) return "armyProfile: a team's profile must be an object or null";
        const mm = rec.get(p, "meleeMagic");
        if (mm != .integer or mm.integer < 0 or mm.integer > st.MAX_UNITS) return "armyProfile: meleeMagic must be a stack count";
        const sat = rec.get(p, "auraSaturated");
        if (sat != .null and sat != .bool) return "armyProfile: auraSaturated must be a boolean";
        out[team] = .{ .present = true, .melee_magic = @intCast(mm.integer), .aura_saturated = sat == .bool and sat.bool };
    }
    return null;
}

/// Loads an exportBattleState JSON (state_export.ts, version 2, with an optional `harness` block giving the random
/// state, the active unit and the UUID counter). Unit indices follow the export's holder order. Returns null on an
/// unsupported or malformed state (hoc_last_error: "unsupported state: ..." or "malformed state: ...").
pub export fn hoc_state_load(eng: ?*Engine, json: ?[*]const u8, len: usize) ?*Handle {
    const e = eng orelse return null;
    e.clearError();
    const arena = e.tmp();
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena, bytes(json, len), .{}) catch |err| {
        e.fail("malformed state: JSON {s}", .{@errorName(err)});
        return null;
    };
    var why: snapshot.Why = .{};
    const ids = snapshot.unitIds(arena, root, &why) catch |err| {
        e.fail("{s}: {s}", .{ if (err == error.UnsupportedState) "unsupported state" else "malformed state", why.text() });
        return null;
    };
    const state = snapshot.load(root, ids, .{}, &why) catch |err| {
        e.fail("{s}: {s}", .{ if (err == error.UnsupportedState) "unsupported state" else "malformed state", why.text() });
        return null;
    };
    const harness = rec.get(root, "harness");
    const uuid = rec.get(harness, "uuidSequence");
    var profile: [3]ArmyProfile = .{ .{}, .{}, .{} };
    if (parseProfiles(rec.get(harness, "armyProfile"), &profile)) |msg| {
        e.fail("malformed state: harness.{s}", .{msg});
        return null;
    }
    const names = nameTable(arena, root, &state) catch {
        e.fail("out of memory", .{});
        return null;
    };
    return newHandle(e, &state, ids, .{ .uuid = if (uuid == .integer) @floatFromInt(uuid.integer) else -1, .names = names, .profile = profile });
}

export fn hoc_state_clone(eng: ?*Engine, handle: ?*const Handle) ?*Handle {
    const e = eng orelse return null;
    e.clearError();
    const h = handle orelse {
        e.fail("no state", .{});
        return null;
    };
    return newHandle(e, &h.state, h.ids, metaOf(h));
}

pub export fn hoc_state_free(eng: ?*Engine, handle: ?*Handle) void {
    _ = eng;
    const h = handle orelse return;
    alloc.free(h.ids);
    alloc.free(h.id_bytes);
    alloc.free(h.names);
    alloc.free(h.name_bytes);
    alloc.destroy(h);
}

/// Writes the state's digest JSON (digest.zig) into `out` when it fits; returns its length either way (call again
/// with a larger buffer when the length exceeds `cap`), or -1.
export fn hoc_state_digest_json(eng: ?*Engine, handle: ?*const Handle, out: ?[*]u8, cap: usize) i64 {
    const e = eng orelse return -1;
    e.clearError();
    const h = handle orelse {
        e.fail("no state", .{});
        return -1;
    };
    var w: std.Io.Writer.Allocating = .init(e.tmp());
    digest.write(&w.writer, &h.state, h.ids) catch {
        e.fail("out of memory", .{});
        return -1;
    };
    const text = w.written();
    if (out) |o| {
        if (text.len <= cap) @memcpy(o[0..text.len], text);
    }
    return @intCast(text.len);
}

/// Compares the state with a digest recorded by zig/parity/digest.ts `battleDigest` (compare.state: every unit
/// column, the queues and sets, the terrain). Returns 1 when identical, 0 when not (hoc_last_error names the first
/// difference), -1 on bad input.
export fn hoc_state_check_digest(eng: ?*Engine, handle: ?*const Handle, json: ?[*]const u8, len: usize) i32 {
    const e = eng orelse return -1;
    e.clearError();
    const h = handle orelse {
        e.fail("no state", .{});
        return -1;
    };
    const d = std.json.parseFromSliceLeaky(std.json.Value, e.tmp(), bytes(json, len), .{}) catch |err| {
        e.fail("digest JSON {s}", .{@errorName(err)});
        return -1;
    };
    if (rec.get(d, "units") != .array or rec.get(d, "fight") != .object) {
        e.fail("not a digest", .{});
        return -1;
    }
    var m: compare.Mismatch = .{};
    if (compare.state(&h.state, h.ids, d, &m)) return 1;
    e.fail("{s}", .{m.text()});
    return 0;
}

/// Plays the battle out in place with v0.1 on both seats (from the start when the fight has not started, else from
/// where it stands) and writes the outcome. Clone first to keep the loaded state. Returns 0, or -1.
export fn hoc_play_v01(eng: ?*Engine, handle: ?*Handle, max_laps: i32, out: ?*rollout.PlayResult) i32 {
    const e = eng orelse return -1;
    e.clearError();
    const h = handle orelse {
        e.fail("no state", .{});
        return -1;
    };
    // Units summoned during the play-out join the handle's id table (uids are dense: a summon takes the next one).
    const arena = e.tmp();
    var summoned: rollout.SummonIds = .{ .first = h.ids.len, .alloc = arena };
    const r = rollout.playHooked(&h.state, max_laps, ai.decideTurn, summoned.hook());
    if (summoned.ids.items.len > 0) {
        const table = summoned.table(arena, h.ids) catch {
            e.fail("out of memory", .{});
            return -1;
        };
        const grown = newHandle(e, &h.state, table, metaOf(h)) orelse return -1;
        alloc.free(h.ids);
        alloc.free(h.id_bytes);
        alloc.free(grown.names);
        alloc.free(grown.name_bytes);
        h.ids = grown.ids;
        h.id_bytes = grown.id_bytes;
        alloc.destroy(grown);
    }
    if (out) |o| o.* = r;
    return 0;
}

// ---- hoc_rollouts --------------------------------------------------------------------------------------------------

/// Whether this build plays the server's engine path (`engine: "server"`). Off until server mode is complete: a
/// request for it is then refused as unsupported, so the caller keeps those rollouts in TypeScript.
pub const SERVER_ENGINE = true;
/// The engine paths a request may select (`supportedEngines` in the manifest and the build info).
pub const SUPPORTED_ENGINES: []const []const u8 = if (SERVER_ENGINE) &.{ "match", "server" } else &.{"match"};

pub const SUPPORTED_ACTIONS = [_][]const u8{
    "end_turn",   "wait_turn",         "defend_turn", "select_attack_type", "move_unit", "melee_attack", "range_attack", "obstacle_attack",
    "cast_spell", "area_throw_attack",
};

fn parseRequest(e: *Engine, arena: std.mem.Allocator, h: *const Handle, json: []const u8) ?rollout.Request {
    e.ident = .{ .ids = h.ids, .names = h.names };
    const v = std.json.parseFromSliceLeaky(std.json.Value, arena, json, .{}) catch |err| {
        e.fail("request JSON {s}", .{@errorName(err)});
        return null;
    };
    const ids = h.ids;
    const actor_v = rec.get(v, "actor");
    if (actor_v != .string) {
        e.fail("request: actor must be a unit id", .{});
        return null;
    }
    const actor_uid = rec.unitIndex(ids, actor_v.string) catch {
        e.fail("request: unknown actor {s}", .{actor_v.string});
        return null;
    };
    const actor = h.state.slotOf(actor_uid) orelse {
        e.fail("request: actor {s} is not a living unit", .{actor_v.string});
        return null;
    };
    if (!h.state.units[actor].in_holder or h.state.units[actor].isDead()) {
        e.fail("request: actor {s} is not a living unit", .{actor_v.string});
        return null;
    }
    const team_v = rec.get(v, "actingTeam");
    if (team_v != .null and rec.int(team_v) != h.state.units[actor].team) {
        e.fail("request: actingTeam {d} is not the actor's team", .{rec.int(team_v)});
        return null;
    }
    var req: rollout.Request = .{ .actor = actor, .seed_base = rec.num(rec.get(v, "seedBase")), .candidates = &.{}, .pairs = &.{}, .identity = &e.ident };
    if (rec.get(v, "seedBase") != .integer and rec.get(v, "seedBase") != .float) {
        e.fail("request: seedBase must be a number", .{});
        return null;
    }
    const chance = rec.get(v, "chance");
    if (chance != .null) {
        const name = if (chance == .string) chance.string else "?";
        if (std.mem.eql(u8, name, "plain")) {
            req.chance = .plain;
        } else if (std.mem.eql(u8, name, "antithetic") or std.mem.eql(u8, name, "actor-antithetic")) {
            req.chance = .antithetic;
            // makeSearchChanceStream's guards: a uint32 seed (the rollout indices are checked with the pairs).
            const sb = rec.get(v, "seedBase");
            if (sb != .integer or sb.integer < 0 or sb.integer > std.math.maxInt(u32)) {
                e.fail("request: the antithetic stream needs a uint32 seedBase", .{});
                return null;
            }
        } else {
            e.fail("unsupported request: chance {s} (\"plain\" or \"antithetic\")", .{name});
            return null;
        }
    }
    const horizon = rec.get(v, "horizon");
    if (horizon != .null) {
        const mode = rec.get(horizon, "mode");
        req.horizon = if (mode == .string) std.meta.stringToEnum(rollout.HorizonMode, mode.string) orelse {
            e.fail("request: horizon mode {s}", .{mode.string});
            return null;
        } else .turns;
        const turns = rec.get(horizon, "turns");
        if (turns == .integer and turns.integer >= 0) req.turns = @intCast(turns.integer);
        if (req.horizon == .turns and turns != .integer) {
            e.fail("request: horizon turns must be an integer", .{});
            return null;
        }
    }
    const leaf = rec.get(v, "leaf");
    if (leaf != .null) {
        const kind = rec.get(leaf, "kind");
        req.leaf = if (kind == .string) std.meta.stringToEnum(rollout.LeafKind, kind.string) orelse {
            e.fail("unsupported request: leaf {s} (\"material\", \"v1\" or \"v2\")", .{kind.string});
            return null;
        } else {
            e.fail("request: leaf.kind must be a string", .{});
            return null;
        };
        const exact = rec.get(leaf, "exactTerminal");
        req.exact_terminal = exact == .bool and exact.bool;
    }
    var profile = h.profile;
    if (parseProfiles(rec.get(v, "armyProfile"), &profile)) |msg| {
        e.fail("request: {s}", .{msg});
        return null;
    }
    const pols = rec.get(v, "policies");
    for ([_]u8{ st.Team.RIGHT, st.Team.LEFT }) |team| {
        var key: [4]u8 = undefined;
        const k = std.fmt.bufPrint(&key, "{d}", .{team}) catch unreachable;
        const p = rec.get(pols, k);
        if (p == .null) continue;
        const version = rec.get(p, "version");
        if (version != .string) {
            e.fail("request: policies.{s}.version", .{k});
            return null;
        }
        req.policies[team] = rollout.policyFor(version.string) orelse {
            e.fail("unsupported request: policy {s}", .{version.string});
            return null;
        };
        const switches = rec.get(p, "switches");
        if (switches == .object and switches.object.count() > 0) {
            e.fail("unsupported request: switches for {s} (production switches only)", .{version.string});
            return null;
        }
        if (req.policies[team] == rollout.policyFor("v0.8")) {
            // v0.7's army profile comes from the strategy instance that models the team in the rollouts. One that never
            // placed this army (a late takeover, or the server's createAIStrategy model of a human seat) has none and
            // keeps v0.6's decision: the port's melee-magic-anchor path (melee_magic >= 2) is exactly that. An
            // aura-saturated army takes v0.4's archetype anchor (src/v08 plays it where it equals the v0.4 level and
            // refuses the rest itself).
            const pr = profile[team];
            req.melee_magic[team] = if (pr.present) pr.melee_magic else rollout.NO_ARMY_PROFILE;
            req.aura_saturated[team] = pr.present and pr.aura_saturated;
        }
    }
    if (req.policies[st.Team.LEFT] == rollout.policyFor("v0.8") or req.policies[st.Team.RIGHT] == rollout.policyFor("v0.8")) {
        var why_buf: [96]u8 = undefined;
        if (rollout.v08Scope(&h.state, &e.ident, &why_buf)) |why| {
            e.fail("unsupported request: the v0.8 port covers boards without batch-5 abilities or spells outside its list ({s})", .{why});
            return null;
        }
    }
    const sole = rec.get(v, "soleAbominationDefend");
    if (sole != .null and sole != .bool) {
        e.fail("request: soleAbominationDefend must be a boolean", .{});
        return null;
    }
    req.sole_abomination_defend = sole == .bool and sole.bool;
    const drop = rec.get(v, "testDropDecisions");
    if (drop == .integer and drop.integer > 0) req.drop_decisions = @intCast(@min(drop.integer, std.math.maxInt(u32)));
    const ids_v = rec.get(v, "summonIds");
    if (ids_v != .null) {
        const name = if (ids_v == .string) ids_v.string else "?";
        if (std.mem.eql(u8, name, "match")) {
            req.id_scheme = .match;
        } else if (std.mem.eql(u8, name, "uuidSequence")) {
            req.id_scheme = .uuid_sequence;
        } else {
            e.fail("request: summonIds {s} (\"match\" or \"uuidSequence\")", .{name});
            return null;
        }
    }
    const engine_v = rec.get(v, "engine");
    if (engine_v != .null) {
        const name = if (engine_v == .string) engine_v.string else "?";
        if (std.mem.eql(u8, name, "match")) {
            req.engine = .match;
        } else if (std.mem.eql(u8, name, "server")) {
            if (!SERVER_ENGINE) {
                e.fail("unsupported request: engine \"server\" (this build's supportedEngines: match)", .{});
                return null;
            }
            req.engine = .server;
        } else {
            e.fail("request: engine {s} (\"match\" or \"server\")", .{name});
            return null;
        }
    }
    if (req.engine == .server and req.id_scheme != .uuid_sequence) {
        e.fail("request: engine \"server\" needs summonIds \"uuidSequence\"", .{});
        return null;
    }
    const seq_v = rec.get(v, "summonSequence");
    if (seq_v != .null) {
        if (seq_v != .integer or seq_v.integer < 0 or seq_v.integer > std.math.maxInt(u32)) {
            e.fail("request: summonSequence must be a uint32", .{});
            return null;
        }
        req.summon_sequence = @intCast(seq_v.integer);
    }
    const uuid_v = rec.get(v, "uuidSequence");
    if (uuid_v != .null) {
        if (uuid_v != .integer or uuid_v.integer < 0) {
            e.fail("request: uuidSequence must be a non-negative integer", .{});
            return null;
        }
        req.uuid_sequence = @intCast(uuid_v.integer);
    } else if (req.id_scheme == .uuid_sequence and h.uuid_sequence < 0) {
        e.fail("request: summonIds \"uuidSequence\" needs harness.uuidSequence or uuidSequence", .{});
        return null;
    }
    const cands = rec.get(v, "candidates");
    if (cands != .array) {
        e.fail("request: candidates", .{});
        return null;
    }
    const out_cands = arena.alloc(rollout.Candidate, cands.array.items.len) catch {
        e.fail("out of memory", .{});
        return null;
    };
    for (cands.array.items, 0..) |c, i| {
        const kind = rec.get(c, "kind");
        const actions = rec.get(c, "actions");
        if (actions != .array) {
            e.fail("request: candidate {d} actions", .{i});
            return null;
        }
        const out_actions = arena.alloc(rec.Action, actions.array.items.len) catch {
            e.fail("out of memory", .{});
            return null;
        };
        for (actions.array.items, 0..) |a, j| {
            const t = rec.get(a, "type");
            var known = false;
            if (t == .string) {
                for (SUPPORTED_ACTIONS) |name| {
                    if (std.mem.eql(u8, name, t.string)) known = true;
                }
            }
            if (!known) {
                e.fail("unsupported request: candidate {d} action {s}", .{ i, if (t == .string) t.string else "?" });
                return null;
            }
            const named = rec.parseAction(arena, ids, "apply", a) catch |err| {
                e.fail("unsupported request: candidate {d} action {d}: {s}", .{ i, j, @errorName(err) });
                return null;
            };
            out_actions[j] = engine_mod.actionToSlots(&h.state, named);
        }
        out_cands[i] = .{ .incumbent = kind == .string and std.mem.eql(u8, kind.string, "incumbent"), .actions = out_actions };
    }
    req.candidates = out_cands;
    const pairs = rec.get(v, "pairs");
    if (pairs != .array) {
        e.fail("request: pairs", .{});
        return null;
    }
    const out_pairs = arena.alloc([2]u32, pairs.array.items.len) catch {
        e.fail("out of memory", .{});
        return null;
    };
    for (pairs.array.items, 0..) |p, i| {
        if (p != .array or p.array.items.len != 2 or p.array.items[0] != .integer or p.array.items[1] != .integer) {
            e.fail("request: pair {d}", .{i});
            return null;
        }
        const c = p.array.items[0].integer;
        const r = p.array.items[1].integer;
        if (c < 0 or c >= out_cands.len or r < 0 or r > std.math.maxInt(u32)) {
            e.fail("request: pair {d} out of range", .{i});
            return null;
        }
        if (req.chance == .antithetic and r > 3) {
            e.fail("request: pair {d}: the antithetic stream takes rollout indices 0 through 3", .{i});
            return null;
        }
        out_pairs[i] = .{ @intCast(c), @intCast(r) };
    }
    req.pairs = out_pairs;
    const budget = rec.get(v, "turnBudget");
    if (budget == .integer and budget.integer >= 0) req.turn_budget = @intCast(budget.integer);
    if (!parseBank(e, rec.get(v, "bank"), &req)) return null;
    return req;
}

/// The request's `bank` (ABI 3): scoreCandidates' bank semantics, see rollout.Bank. Unknown keys are refused, never
/// ignored. A bank that skips pairs needs candidate-major pairs.
fn parseBank(e: *Engine, v: std.json.Value, req: *rollout.Request) bool {
    if (v == .null) return true;
    if (v != .object) {
        e.fail("request: bank must be an object", .{});
        return false;
    }
    var it = v.object.iterator();
    while (it.next()) |entry| {
        const key = entry.key_ptr.*;
        const x = entry.value_ptr.*;
        if (std.mem.eql(u8, key, "skipAfterIllegal")) {
            if (x != .bool) {
                e.fail("request: bank.skipAfterIllegal must be a boolean", .{});
                return false;
            }
            req.bank.skip_after_illegal = x.bool;
        } else if (std.mem.eql(u8, key, "summonScope")) {
            const name = if (x == .string) x.string else "?";
            if (std.mem.eql(u8, name, "rollout")) {
                req.bank.summon_per_rollout = true;
            } else if (std.mem.eql(u8, name, "call")) {
                req.bank.summon_per_rollout = false;
            } else {
                e.fail("request: bank.summonScope {s} (\"call\" or \"rollout\")", .{name});
                return false;
            }
        } else if (std.mem.eql(u8, key, "material")) {
            if (x != .bool) {
                e.fail("request: bank.material must be a boolean", .{});
                return false;
            }
            req.bank.material = x.bool;
        } else if (std.mem.eql(u8, key, "tailBound")) {
            if (x == .null) continue;
            const reference = rec.get(x, "reference");
            const margin = rec.get(x, "margin");
            const count = rec.get(x, "rolloutCount");
            const isNum = struct {
                fn f(n: std.json.Value) bool {
                    return n == .integer or n == .float;
                }
            }.f;
            if (x != .object or !isNum(margin) or count != .integer or count.integer < 1 or count.integer > std.math.maxInt(u32) or (reference != .null and !isNum(reference))) {
                e.fail("request: bank.tailBound must be {{reference: number | null, margin: number, rolloutCount: positive integer}}", .{});
                return false;
            }
            // A null reference is TypeScript's -Infinity (no candidate finished yet): the bound never fires.
            if (reference != .null) req.bank.tail = .{ .reference = rec.num(reference), .margin = rec.num(margin), .count = @intCast(count.integer) };
        } else {
            e.fail("unsupported request: bank.{s}", .{key});
            return false;
        }
    }
    if (req.bank.skip_after_illegal or req.bank.tail != null) {
        // Candidate-major: once a candidate's run of pairs ends, it never comes back.
        var seen = std.DynamicBitSetUnmanaged.initEmpty(e.arena.allocator(), req.candidates.len) catch {
            e.fail("out of memory", .{});
            return false;
        };
        var cur: ?u32 = null;
        for (req.pairs, 0..) |p, i| {
            if (cur != null and cur.? == p[0]) continue;
            if (seen.isSet(p[0])) {
                e.fail("request: pair {d}: a bank that skips needs candidate-major pairs", .{i});
                return false;
            }
            seen.set(p[0]);
            cur = p[0];
        }
    }
    return true;
}

/// parseRequest for in-process callers (`hoc-sim rollout-trace`): the request names point into `h` and `e.ident`.
pub fn requestFor(e: *Engine, h: *const Handle, json: []const u8) ?rollout.Request {
    e.clearError();
    return parseRequest(e, e.tmp(), h, json);
}

/// Runs the request's (candidate, r) rollouts on copies of the handle's state (SearchDriver.rollout + leafValue; the
/// request format is in zig/BRIDGE.md) and writes one f64 per pair, in request order: the leaf P(win) for the actor's
/// team, or -Infinity for a rejected candidate (NaN for a pair a `bank` skipped). Returns how many it wrote (a prefix
/// when `deadline_ns` (hoc_now_ns clock, 0 = none), the request's turnBudget or `out_cap` cut it; hoc_rollout_stats
/// says which; hoc_rollout_pairs gives every pair's record), or -1 on an unsupported or malformed request or a rollout
/// that reached unported code (hoc_last_error; fall back to TypeScript for the decision).
export fn hoc_rollouts(eng: ?*Engine, handle: ?*const Handle, req_json: ?[*]const u8, req_len: usize, out_values: ?[*]f64, out_cap: usize, deadline_ns: u64) i32 {
    const e = eng orelse return -1;
    e.clearError();
    e.stats = .{};
    const h = handle orelse {
        e.fail("no state", .{});
        return -1;
    };
    e.n_records = 0;
    const req = parseRequest(e, e.tmp(), h, bytes(req_json, req_len)) orelse return -1;
    var ctl: rollout.Control = .{ .deadline_ns = deadline_ns, .turn_budget = req.turn_budget };
    const out: []f64 = if (out_values) |o| o[0..out_cap] else &.{};
    if (e.records.len < req.pairs.len) {
        if (e.records.len > 0) alloc.free(e.records);
        e.records = alloc.alloc(rollout.PairRecord, @max(req.pairs.len, 256)) catch {
            e.records = &.{};
            e.fail("out of memory", .{});
            return -1;
        };
    }
    e.n_records = req.pairs.len;
    const written = rollout.runRecords(&h.state, &e.scratch, &req, out, &ctl, e.records[0..req.pairs.len]) catch |err| {
        e.stats = .{ .turns = ctl.turns, .written = 0, .stop = @intFromEnum(ctl.stop), .summon_sequence = ctl.summon_sequence, .uuid_sequence = ctl.uuid_sequence };
        e.fail("unsupported rollout: {s}", .{switch (err) {
            error.UnsupportedPolicy => "a unit without a policy had to play, or its policy needs a pass the port lacks",
            error.UnsupportedCapacity => "a capacity of the port was exceeded (unit slots, ids, lists, chance keys, or a summon without its id parts)",
            error.UnsupportedServerRoute => "server mode reached a route the server oracle has not verified (a server route that changes the walk or the approach, a strike refused for want of a route, or a path-less approach the full map accepts)",
            error.UnsupportedServerZeroLap => "server mode reached a lap the server oracle has not verified (a lap left unmarked by a 0-damage statistic adds a narrowing lap)",
            error.UnsupportedServerObstacle => "server mode reached an obstacle strike the server oracle has not verified (its provider refresh changed a unit the strike reads, or its approach differs)",
        }});
        return -1;
    };
    e.stats = .{ .turns = ctl.turns, .written = @intCast(written), .stop = @intFromEnum(ctl.stop), .summon_sequence = ctl.summon_sequence, .uuid_sequence = ctl.uuid_sequence };
    return @intCast(written);
}

export fn hoc_rollout_stats(eng: ?*const Engine, out: ?*RolloutStats) i32 {
    const e = eng orelse return -1;
    if (out) |o| o.* = e.stats;
    return 0;
}

/// Copies the last hoc_rollouts call's per-pair records (rollout.PairRecord, 40 bytes each, one per request pair in
/// order; pairs after a stop read NOT_REACHED) into `out`, at most `cap`; returns how many the call has (0 after a
/// refused request), or -1.
export fn hoc_rollout_pairs(eng: ?*const Engine, out: ?[*]rollout.PairRecord, cap: usize) i32 {
    const e = eng orelse return -1;
    if (out) |o| {
        const n = @min(cap, e.n_records);
        @memcpy(o[0..n], e.records[0..n]);
    }
    return @intCast(e.n_records);
}

/// libc's `exp`, the one the learned leaves' sigmoid calls (rollout.zig, v08/util.zig): the bridge's self-test compares
/// it with the runtime's Math.exp on a fixed table, because exact ties decide choices.
/// Math.exp (cmath.zig: glibc's on Linux, not the bundled compiler-rt exp).
const cExp = @import("cmath.zig").cExp;
export fn hoc_exp(x: f64) f64 {
    return cExp(x);
}

// ---- build identity and scope manifest -----------------------------------------------------------------------------

/// The policies a request may name with their extra scope, in rollout.policies' order.
const POLICY_SCOPES = [_]scope.PolicyScope{ rollout.V01_SCOPE, rollout.V08_SCOPE };

comptime {
    std.debug.assert(POLICY_SCOPES.len == rollout.policies.len);
    for (POLICY_SCOPES, rollout.policies) |a, b| std.debug.assert(std.mem.eql(u8, a.name, b.version));
}

const Manifest = struct {
    coverage: [64]u8,
    /// Every policy (hoc_scope_manifest with no name).
    full: [:0]const u8,
    per_policy: [POLICY_SCOPES.len][:0]const u8,
    build_info: [:0]const u8,
};

var manifest_lock: std.Thread.Mutex = .{};
var manifest_cache: ?Manifest = null;

fn targetName() []const u8 {
    return @tagName(builtin.cpu.arch) ++ "-" ++ @tagName(builtin.os.tag) ++ "-" ++ @tagName(builtin.abi);
}

fn writeHeader(w: *std.Io.Writer, coverage: []const u8) !void {
    try w.print("{{\"abi\":{d},\"commonSha\":\"{s}\",\"coverage\":\"{s}\"", .{ ABI_VERSION, COMMON_SHA, coverage });
}

fn buildManifest() !Manifest {
    const pa = std.heap.page_allocator;
    var body: std.Io.Writer.Allocating = .init(pa);
    defer body.deinit();
    try scope.writeScope(&body.writer, snapshot.FORMAT_VERSION, &POLICY_SCOPES, &SUPPORTED_ACTIONS, SUPPORTED_ENGINES);
    var m: Manifest = undefined;
    m.coverage = scope.sha256Hex(body.written());
    {
        var w: std.Io.Writer.Allocating = .init(pa);
        errdefer w.deinit();
        try writeHeader(&w.writer, &m.coverage);
        try w.writer.writeAll(",\"policy\":null,\"scope\":");
        try w.writer.writeAll(body.written());
        try w.writer.writeByte('}');
        m.full = try w.toOwnedSliceSentinel(0);
    }
    for (POLICY_SCOPES, 0..) |p, i| {
        var w: std.Io.Writer.Allocating = .init(pa);
        errdefer w.deinit();
        try writeHeader(&w.writer, &m.coverage);
        try w.writer.print(",\"policy\":\"{s}\",\"scope\":", .{p.name});
        try scope.writeScope(&w.writer, snapshot.FORMAT_VERSION, &.{p}, &SUPPORTED_ACTIONS, SUPPORTED_ENGINES);
        try w.writer.writeByte('}');
        m.per_policy[i] = try w.toOwnedSliceSentinel(0);
    }
    {
        var w: std.Io.Writer.Allocating = .init(pa);
        errdefer w.deinit();
        try writeHeader(&w.writer, &m.coverage);
        const glibc: ?std.SemanticVersion = if (builtin.os.tag == .linux and builtin.abi.isGnu()) builtin.os.version_range.linux.glibc else null;
        try w.writer.print(",\"zig\":\"{s}\",\"target\":\"{s}\",\"cpu\":\"{s}\",\"optimize\":\"{s}\",\"snapshotFormat\":{d}", .{ builtin.zig_version_string, targetName(), builtin.cpu.model.name, @tagName(builtin.mode), snapshot.FORMAT_VERSION });
        if (glibc) |g| try w.writer.print(",\"glibc\":\"{d}.{d}\"", .{ g.major, g.minor }) else try w.writer.writeAll(",\"glibc\":null");
        try w.writer.writeAll(",\"supportedEngines\":");
        try scope.writeStrings(&w.writer, SUPPORTED_ENGINES);
        try w.writer.writeByte('}');
        m.build_info = try w.toOwnedSliceSentinel(0);
    }
    return m;
}

fn manifestData() ?*const Manifest {
    manifest_lock.lock();
    defer manifest_lock.unlock();
    if (manifest_cache == null) manifest_cache = buildManifest() catch return null;
    return &manifest_cache.?;
}

/// The library's identity as JSON (static, NUL-terminated, owned by the library): {abi, commonSha, coverage (the scope
/// manifest's sha256), zig, target, cpu, optimize, snapshotFormat, glibc}. Null only when out of memory.
export fn hoc_build_info() ?[*:0]const u8 {
    const m = manifestData() orelse return null;
    return m.build_info.ptr;
}

/// The scope manifest (scope.zig) as JSON (static, NUL-terminated): `{abi, commonSha, coverage, policy, scope: {loader,
/// policies: {<name>: {castable, refusedAbilities, refusedDebuffs}}, actions}}` for policy `name` ("v0.1", "v0.8"), or
/// every policy when `name` is null or empty. Null for an unknown policy (or out of memory).
export fn hoc_scope_manifest(name: ?[*]const u8, len: usize) ?[*:0]const u8 {
    const m = manifestData() orelse return null;
    const n = bytes(name, len);
    if (n.len == 0) return m.full.ptr;
    for (POLICY_SCOPES, 0..) |p, i| {
        if (std.mem.eql(u8, p.name, n)) return m.per_policy[i].ptr;
    }
    return null;
}

// ---- self-test ------------------------------------------------------------------------------------------------------

/// A compiled-in root (an exportBattleState export), requests on it and the records TypeScript's scoreCandidates
/// produced for them (zig/BRIDGE.md "Loading safely and the self-test" says how they were made): hoc_self_test replays
/// them on the host, so a CPU, libc or build that changes a single bit of a rollout is caught before the backend is
/// used.
const SELFTEST_STATE = @embedFile("selftest/state.json");
const SELFTEST_REQUESTS = @embedFile("selftest/requests.json");
const SELFTEST_EXPECTED = @embedFile("selftest/expected.json");

fn hexBits(v: std.json.Value) ?f64 {
    if (v == .null) return std.math.nan(f64);
    if (v != .string) return null;
    const bits = std.fmt.parseInt(u64, v.string, 16) catch return null;
    return @bitCast(bits);
}

fn sameBits(a: f64, b: f64) bool {
    if (std.math.isNan(a) or std.math.isNan(b)) return std.math.isNan(a) and std.math.isNan(b);
    return @as(u64, @bitCast(a)) == @as(u64, @bitCast(b));
}

/// Runs the compiled-in requests on the compiled-in state and compares every pair record (value and material bit for
/// bit, turns, flags, the summon counters, the winner) and each call's totals with the expected records. Returns 1
/// when all match, 0 when one differs or the fixture does not load (hoc_last_error names it), -1 without an engine.
export fn hoc_self_test(eng: ?*Engine) i32 {
    const e = eng orelse return -1;
    e.clearError();
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();
    const expected = std.json.parseFromSliceLeaky(std.json.Value, a, SELFTEST_EXPECTED, .{}) catch {
        e.fail("self-test: the expected records do not parse", .{});
        return 0;
    };
    const requests = std.json.parseFromSliceLeaky(std.json.Value, a, SELFTEST_REQUESTS, .{}) catch {
        e.fail("self-test: the requests do not parse", .{});
        return 0;
    };
    if (expected != .array or requests != .array or requests.array.items.len == 0 or requests.array.items.len != expected.array.items.len) {
        e.fail("self-test: no fixture compiled in", .{});
        return 0;
    }
    const h = hoc_state_load(e, SELFTEST_STATE.ptr, SELFTEST_STATE.len) orelse {
        var msg: [512]u8 = undefined;
        const why = std.fmt.bufPrint(&msg, "{s}", .{std.mem.span(hoc_last_error(e))}) catch "?";
        e.fail("self-test: the fixture state: {s}", .{why});
        return 0;
    };
    defer hoc_state_free(e, h);
    for (requests.array.items, expected.array.items, 0..) |rq, ex, k| {
        var text: std.Io.Writer.Allocating = .init(a);
        std.json.Stringify.value(rq, .{}, &text.writer) catch {
            e.fail("out of memory", .{});
            return 0;
        };
        const pairs = rec.get(ex, "pairs");
        if (pairs != .array) {
            e.fail("self-test: request {d} has no expected pairs", .{k});
            return 0;
        }
        const out = a.alloc(f64, @max(1, pairs.array.items.len)) catch {
            e.fail("out of memory", .{});
            return 0;
        };
        const json = text.written();
        const written = hoc_rollouts(e, h, json.ptr, json.len, out.ptr, pairs.array.items.len, 0);
        if (written < 0) {
            var msg: [512]u8 = undefined;
            const why = std.fmt.bufPrint(&msg, "{s}", .{std.mem.span(hoc_last_error(e))}) catch "?";
            e.fail("self-test: request {d} refused: {s}", .{ k, why });
            return 0;
        }
        if (e.stats.turns != @as(u64, @intCast(rec.int(rec.get(ex, "turns")))) or e.stats.stop != rec.int(rec.get(ex, "stop"))) {
            e.fail("self-test: request {d}: {d} turns, stop {d}; expected {d}, {d}", .{ k, e.stats.turns, e.stats.stop, rec.int(rec.get(ex, "turns")), rec.int(rec.get(ex, "stop")) });
            return 0;
        }
        if (e.n_records != pairs.array.items.len) {
            e.fail("self-test: request {d}: {d} records for {d} expected", .{ k, e.n_records, pairs.array.items.len });
            return 0;
        }
        for (pairs.array.items, e.records[0..e.n_records], 0..) |want, got, i| {
            const value = hexBits(rec.get(want, "value")) orelse {
                e.fail("self-test: request {d} pair {d}: bad expected value", .{ k, i });
                return 0;
            };
            const material = hexBits(rec.get(want, "material")) orelse {
                e.fail("self-test: request {d} pair {d}: bad expected material", .{ k, i });
                return 0;
            };
            const same = sameBits(value, got.value) and sameBits(material, got.material) and got.turns == rec.int(rec.get(want, "turns")) and
                got.flags == rec.int(rec.get(want, "flags")) and got.summon_seq == rec.int(rec.get(want, "summonSequence")) and
                got.uuid_seq == rec.int(rec.get(want, "uuidSequence")) and got.winner == rec.int(rec.get(want, "winner"));
            if (!same) {
                e.fail("self-test: request {d} pair {d}: value {x} material {x} turns {d} flags {d} summons {d} uuid {d} winner {d} differ from the expected record", .{ k, i, @as(u64, @bitCast(got.value)), @as(u64, @bitCast(got.material)), got.turns, got.flags, got.summon_seq, got.uuid_seq, got.winner });
                return 0;
            }
        }
    }
    e.clearError();
    return 1;
}

// Placeholder for the A19 search port (not implemented; see zig/BRIDGE.md "Growing into the search"):
//   hoc_score_candidates(eng, handle, req_json, len, out_means, out_materials, out_completed, cap, deadline_ns)
// would move scoreCandidates' per-candidate loop, the certified tail bounds and the material sample into Zig, and
// hoc_decide(eng, handle, decision_json, len, out_actions_json, cap) the whole decision.

test "engine lifecycle and errors" {
    const e = hoc_engine_new().?;
    defer hoc_engine_free(e);
    const bad = "{\"version\":1}";
    try std.testing.expect(hoc_state_load(e, bad, bad.len) == null);
    try std.testing.expect(std.mem.startsWith(u8, std.mem.span(hoc_last_error(e)), "malformed state"));
    try std.testing.expectEqual(ABI_VERSION, hoc_abi_version());
}

test "build info and the scope manifest parse, and every policy's manifest shares the coverage" {
    const info = std.mem.span(hoc_build_info().?);
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, info, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, ABI_VERSION), parsed.value.object.get("abi").?.integer);
    const coverage = parsed.value.object.get("coverage").?.string;
    try std.testing.expectEqual(@as(usize, 64), coverage.len);
    for ([_][]const u8{ "", "v0.1", "v0.8" }) |p| {
        const text = std.mem.span(hoc_scope_manifest(p.ptr, p.len).?);
        const m = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, text, .{});
        defer m.deinit();
        try std.testing.expectEqualStrings(coverage, m.value.object.get("coverage").?.string);
    }
    try std.testing.expect(hoc_scope_manifest("v9", 2) == null);
    try std.testing.expectEqual(@as(f64, 1), hoc_exp(0));
}

test "the engine request field: match plays, server waits for its build, anything else is malformed" {
    const e = hoc_engine_new().?;
    defer hoc_engine_free(e);
    const h = hoc_state_load(e, SELFTEST_STATE.ptr, SELFTEST_STATE.len).?;
    defer hoc_state_free(e, h);
    const a = std.testing.allocator;
    const requests = try std.json.parseFromSlice(std.json.Value, a, SELFTEST_REQUESTS, .{});
    defer requests.deinit();
    var text: std.Io.Writer.Allocating = .init(a);
    defer text.deinit();
    try std.json.Stringify.value(requests.value.array.items[0], .{}, &text.writer);
    const body = text.written();
    var out: [4096]f64 = undefined;
    const Case = struct { []const u8, ?[]const u8 };
    const server_error = if (SERVER_ENGINE) "request: engine \"server\" needs summonIds" else "unsupported request: engine \"server\"";
    for ([_]Case{
        .{ "{\"engine\":\"match\",", null },
        .{ "{\"engine\":\"server\",", server_error },
        .{ "{\"engine\":\"bogus\",", "request: engine bogus" },
        .{ "{\"engine\":7,", "request: engine ?" },
    }) |case| {
        const req = try std.mem.concat(a, u8, &.{ case[0], body[1..] });
        defer a.free(req);
        const written = hoc_rollouts(e, h, req.ptr, req.len, &out, out.len, 0);
        if (case[1]) |want| {
            try std.testing.expect(written < 0);
            try std.testing.expect(std.mem.startsWith(u8, std.mem.span(hoc_last_error(e)), want));
        } else try std.testing.expect(written > 0);
    }
}

test "the compiled-in self-test fixture replays bit for bit" {
    const e = hoc_engine_new().?;
    defer hoc_engine_free(e);
    const r = hoc_self_test(e);
    if (r != 1) std.debug.print("{s}\n", .{std.mem.span(hoc_last_error(e))});
    try std.testing.expectEqual(@as(i32, 1), r);
}
