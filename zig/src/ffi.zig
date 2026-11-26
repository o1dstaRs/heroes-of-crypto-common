//! The bridge's C ABI (`zig build lib` -> zig-out/lib/libhocsim.{dylib,so}; binding in zig/ffi/bridge.ts). The format,
//! ownership and error rules are in zig/BRIDGE.md.
//!
//! An engine is a worker's scratch (one per thread: its last error, request arena and rollout state); a state handle is
//! a loaded battle with its unit id table, owned by the engine that loaded it. Calls never print and never panic on
//! bad input: they return an error code (-1, or null) and `hoc_last_error(engine)` says why.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine_mod = @import("engine.zig");
const compare = @import("compare.zig");
const snapshot = @import("snapshot.zig");
const rollout = @import("rollout.zig");
const digest = @import("digest.zig");
const ai = @import("ai.zig");

/// Bumped on any change to a signature, a struct layout or the request/snapshot format.
pub const ABI_VERSION: u32 = 1;

const alloc = std.heap.smp_allocator;

pub const Engine = struct {
    err: [512]u8 = undefined,
    err_len: usize = 0,
    /// Per-call parsing (requests, digests): reset at the start of each call that uses it.
    arena: std.heap.ArenaAllocator,
    /// The rollout copy of the root state.
    scratch: st.State = undefined,
    stats: RolloutStats = .{},

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

/// A loaded battle: the state, the unit ids in index order (copies owned by the handle), and the harness counters the
/// TypeScript side keeps around a search (carried, not interpreted: the port creates no units).
pub const Handle = struct {
    state: st.State,
    ids: [][]const u8,
    id_bytes: []u8,
    /// lib.ts deterministicUuidSequence at export time (`harness.uuidSequence`), -1 when absent.
    uuid_sequence: f64,
};

/// Totals of the last hoc_rollouts call.
pub const RolloutStats = extern struct {
    /// Rollout turns played (aborted rollouts included), for SearchDriver's counters.rolloutTurnsTotal.
    turns: u64 = 0,
    /// Values written.
    written: u32 = 0,
    /// rollout.Stop: 0 every pair done, 1 deadline, 2 turn budget, 3 output full.
    stop: i32 = 0,
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

export fn hoc_engine_new() ?*Engine {
    const e = alloc.create(Engine) catch return null;
    e.* = .{ .arena = std.heap.ArenaAllocator.init(alloc) };
    e.clearError();
    return e;
}

export fn hoc_engine_free(eng: ?*Engine) void {
    const e = eng orelse return;
    e.arena.deinit();
    alloc.destroy(e);
}

/// The last error of `eng` as a NUL-terminated string ("" after a successful call).
export fn hoc_last_error(eng: ?*const Engine) [*:0]const u8 {
    const e = eng orelse return "no engine";
    return @ptrCast(&e.err);
}

fn newHandle(e: *Engine, state: *const st.State, ids: []const []const u8, uuid: f64) ?*Handle {
    var total: usize = 0;
    for (ids) |id| total += id.len;
    const h = alloc.create(Handle) catch {
        e.fail("out of memory", .{});
        return null;
    };
    const id_bytes = alloc.alloc(u8, total) catch {
        alloc.destroy(h);
        e.fail("out of memory", .{});
        return null;
    };
    const table = alloc.alloc([]const u8, ids.len) catch {
        alloc.free(id_bytes);
        alloc.destroy(h);
        e.fail("out of memory", .{});
        return null;
    };
    var at: usize = 0;
    for (ids, 0..) |id, i| {
        @memcpy(id_bytes[at .. at + id.len], id);
        table[i] = id_bytes[at .. at + id.len];
        at += id.len;
    }
    h.* = .{ .state = state.*, .ids = table, .id_bytes = id_bytes, .uuid_sequence = uuid };
    return h;
}

/// Loads an exportBattleState JSON (state_export.ts, version 2, with an optional `harness` block giving the random
/// state, the active unit and the UUID counter). Unit indices follow the export's holder order. Returns null on an
/// unsupported or malformed state (hoc_last_error: "unsupported state: ..." or "malformed state: ...").
export fn hoc_state_load(eng: ?*Engine, json: ?[*]const u8, len: usize) ?*Handle {
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
    const uuid = rec.get(rec.get(root, "harness"), "uuidSequence");
    return newHandle(e, &state, ids, if (uuid == .integer) @floatFromInt(uuid.integer) else -1);
}

export fn hoc_state_clone(eng: ?*Engine, handle: ?*const Handle) ?*Handle {
    const e = eng orelse return null;
    e.clearError();
    const h = handle orelse {
        e.fail("no state", .{});
        return null;
    };
    return newHandle(e, &h.state, h.ids, h.uuid_sequence);
}

export fn hoc_state_free(eng: ?*Engine, handle: ?*Handle) void {
    _ = eng;
    const h = handle orelse return;
    alloc.free(h.ids);
    alloc.free(h.id_bytes);
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
        const grown = newHandle(e, &h.state, table, h.uuid_sequence) orelse return -1;
        alloc.free(h.ids);
        alloc.free(h.id_bytes);
        h.ids = grown.ids;
        h.id_bytes = grown.id_bytes;
        alloc.destroy(grown);
    }
    if (out) |o| o.* = r;
    return 0;
}

// ---- hoc_rollouts --------------------------------------------------------------------------------------------------

const SUPPORTED_ACTIONS = [_][]const u8{
    "end_turn", "wait_turn", "defend_turn", "select_attack_type", "move_unit", "melee_attack", "range_attack", "obstacle_attack",
};

fn parseRequest(e: *Engine, arena: std.mem.Allocator, h: *const Handle, json: []const u8) ?rollout.Request {
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
    var req: rollout.Request = .{ .actor = actor, .seed_base = rec.num(rec.get(v, "seedBase")), .candidates = &.{}, .pairs = &.{} };
    if (rec.get(v, "seedBase") != .integer and rec.get(v, "seedBase") != .float) {
        e.fail("request: seedBase must be a number", .{});
        return null;
    }
    const chance = rec.get(v, "chance");
    if (chance != .null and !(chance == .string and std.mem.eql(u8, chance.string, "plain"))) {
        e.fail("unsupported request: chance {s} (only \"plain\" is ported)", .{if (chance == .string) chance.string else "?"});
        return null;
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
        if (!(kind == .string and std.mem.eql(u8, kind.string, "material"))) {
            e.fail("unsupported request: leaf {s} (only \"material\" is ported)", .{if (kind == .string) kind.string else "?"});
            return null;
        }
        const exact = rec.get(leaf, "exactTerminal");
        req.exact_terminal = exact == .bool and exact.bool;
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
            e.fail("unsupported request: switches for {s}", .{version.string});
            return null;
        }
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
        out_pairs[i] = .{ @intCast(c), @intCast(r) };
    }
    req.pairs = out_pairs;
    const budget = rec.get(v, "turnBudget");
    if (budget == .integer and budget.integer >= 0) req.turn_budget = @intCast(budget.integer);
    return req;
}

/// Runs the request's (candidate, r) rollouts on copies of the handle's state (SearchDriver.rollout + leafValue; the
/// request format is in zig/BRIDGE.md) and writes one f64 per pair, in request order: the leaf P(win) for the actor's
/// team, or -Infinity for a rejected candidate. Returns how many it wrote (a prefix when `deadline_ns` (hoc_now_ns
/// clock, 0 = none), the request's turnBudget or `out_cap` cut it; hoc_rollout_stats says which), or -1 on an
/// unsupported or malformed request or a rollout that reached unported code (hoc_last_error; fall back to TypeScript
/// for the decision).
export fn hoc_rollouts(eng: ?*Engine, handle: ?*const Handle, req_json: ?[*]const u8, req_len: usize, out_values: ?[*]f64, out_cap: usize, deadline_ns: u64) i32 {
    const e = eng orelse return -1;
    e.clearError();
    e.stats = .{};
    const h = handle orelse {
        e.fail("no state", .{});
        return -1;
    };
    const req = parseRequest(e, e.tmp(), h, bytes(req_json, req_len)) orelse return -1;
    var ctl: rollout.Control = .{ .deadline_ns = deadline_ns, .turn_budget = req.turn_budget };
    const out: []f64 = if (out_values) |o| o[0..out_cap] else &.{};
    const written = rollout.run(&h.state, &e.scratch, &req, out, &ctl) catch |err| {
        e.stats = .{ .turns = ctl.turns, .written = 0, .stop = @intFromEnum(ctl.stop) };
        e.fail("unsupported rollout: {s}", .{switch (err) {
            error.UnsupportedRecovery => "a policy turn landed nothing (the recovery net is not ported)",
            error.UnsupportedStall => "the turn queue stalled (forceStalledLap is not ported)",
            error.UnsupportedPolicy => "a seat without a policy had to play",
            error.UnsupportedCapacity => "a capacity of the port was exceeded (unit slots, ids, lists, or a summon without its id parts)",
        }});
        return -1;
    };
    e.stats = .{ .turns = ctl.turns, .written = @intCast(written), .stop = @intFromEnum(ctl.stop) };
    return @intCast(written);
}

export fn hoc_rollout_stats(eng: ?*const Engine, out: ?*RolloutStats) i32 {
    const e = eng orelse return -1;
    if (out) |o| o.* = e.stats;
    return 0;
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
