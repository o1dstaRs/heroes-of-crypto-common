//! Native rollouts for the A19 search bridge: `SearchDriver.rollout` and `leafValue` (src/simulation/search_driver.ts)
//! on a copy of a loaded battle, with the policy of each seat injected as a decide function (v0.1's `ai.decideTurn`
//! today; the v0.8 port registers its own). Also the plain "play the battle out" helper the bridge and `hoc-sim
//! play-state` share.
//!
//! One rollout: reseed the stream (`plain`: makeRng((seedBase + r * 0x9e3779b1) >>> 0)), make the actor active, apply
//! the candidate's actions (an incumbent's rejected action is skipped as the real loop does, an enumerated candidate's
//! rejection is -Infinity, an incumbent that landed nothing is -Infinity), defend when nothing landed, end the turn, then
//! both seats play their policies forward to the horizon (turns: N unit turns; lap: until the lap flips, at most 64;
//! reply: until the opponent has played once, at most 12; leaf: none), and score the leaf as P(win) for the acting team
//! (`material`, with `exactTerminal`). Not ported (the call fails rather than guess): the actor-antithetic chance
//! stream, the learned v1/v2 leaves and the research logit adjustments, the recovery net (advanceTowardEnemyAction),
//! forceStalledLap, the sole-Abomination defend rule and an opponent model. See zig/BRIDGE.md.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const ai = @import("ai.zig");
const Rng = @import("rng.zig").Rng;

const State = st.State;
const Team = st.Team;

/// A seat's policy: decides the active unit's turn into `out` (the signature of ai.decideTurn).
pub const DecideFn = *const fn (*State, u8, *ai.Decision) void;

pub const Policy = struct { version: []const u8, decide: DecideFn };

/// The policies a request may name. The v0.8 port (src/v08) adds its entry here once its decide function plays whole
/// battles natively.
pub const policies = [_]Policy{
    .{ .version = "v0.1", .decide = ai.decideTurn },
};

pub fn policyFor(version: []const u8) ?DecideFn {
    for (policies) |p| if (std.mem.eql(u8, p.version, version)) return p.decide;
    return null;
}

pub const HorizonMode = enum { turns, lap, reply, leaf };

/// search_driver.ts MAX_LAP_HORIZON_TURNS / MAX_REPLY_HORIZON_TURNS.
pub const MAX_LAP_HORIZON_TURNS: u32 = 64;
pub const MAX_REPLY_HORIZON_TURNS: u32 = 12;

pub const Candidate = struct {
    /// kind "incumbent": the real loop's semantics (rejected actions are skipped; nothing landed = -Infinity).
    incumbent: bool,
    actions: []const rec.Action,
};

pub const Request = struct {
    actor: u8,
    seed_base: f64,
    horizon: HorizonMode = .turns,
    /// The unit-turn cap of the `turns` horizon (SearchDriver's turnHorizon).
    turns: u32 = 12,
    /// leafValue's exact terminal result (SEARCH_A19_EXACT_TERMINAL_RESULTS): a finished fight scores 1, 0 or 0.5.
    exact_terminal: bool = false,
    /// The policy of each team (index Team.RIGHT / Team.LEFT).
    policies: [3]?DecideFn = .{ null, null, null },
    candidates: []const Candidate,
    /// (candidate index, rollout index r) in output order.
    pairs: []const [2]u32,
    /// Rollout turns this call may play (TypeScript's rolloutTurnLimit - rolloutTurnsTotal); null = unbounded. The call
    /// stops after the turn that exceeds it, dropping that rollout, as assertBeforeDecisionDeadline does.
    turn_budget: ?u64 = null,
};

pub const Stop = enum(i32) { done = 0, deadline = 1, turn_budget = 2, out_full = 3 };

/// The budget of one call: an absolute CLOCK_MONOTONIC deadline (`nowNs`, 0 = none) and the turn allowance.
pub const Control = struct {
    deadline_ns: u64 = 0,
    turn_budget: ?u64 = null,
    /// Rollout turns played so far (aborted rollouts included, as TypeScript counts them).
    turns: u64 = 0,
    stop: Stop = .done,

    fn expired(self: *Control) bool {
        if (self.turn_budget) |b| {
            if (self.turns > b) {
                self.stop = .turn_budget;
                return true;
            }
        }
        if (self.deadline_ns != 0 and nowNs() >= self.deadline_ns) {
            self.stop = .deadline;
            return true;
        }
        return false;
    }
};

pub const Error = error{
    /// A unit's policy landed nothing: the recovery net (advanceTowardEnemyAction, then defend) is not ported.
    UnsupportedRecovery,
    /// The turn queue stalled with living units: forceStalledLap is not ported.
    UnsupportedStall,
    /// A seat without a registered policy had to play.
    UnsupportedPolicy,
    /// A capacity of the port was exceeded (State.overflow: unit slots, ids, list lengths, or a summon without its
    /// id parts or template).
    UnsupportedCapacity,
};

/// CLOCK_MONOTONIC in nanoseconds (the clock of every deadline the bridge takes).
pub fn nowNs() u64 {
    const ts = std.posix.clock_gettime(std.posix.CLOCK.MONOTONIC) catch return 0;
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

/// JavaScript's `x >>> 0` (ToUint32).
pub fn toUint32(x: f64) u32 {
    if (!std.math.isFinite(x)) return 0;
    return @intFromFloat(@mod(@trunc(x), 4294967296.0));
}

/// The `plain` chance stream's seed: makeRng((seedBase + r * 0x9e3779b1) >>> 0).
pub fn plainSeed(seed_base: f64, r: u32) u32 {
    return toUint32(seed_base + @as(f64, @floatFromInt(r)) * 2654435761.0);
}

/// SearchDriver's finishedSim / finishedWinningTeam, fed by the events of every call.
const Sim = struct {
    finished: bool = false,
    winner: i32 = -1,
    events: engine.Events = .{},

    /// engine.apply (which also runs processEvents' active-unit bookkeeping), tracking fight_finished.
    fn apply(self: *Sim, s: *State, a: rec.Action) bool {
        self.events.len = 0;
        const ok = engine.apply(s, a, &self.events);
        for (self.events.slice()) |e| {
            if (e.kind == .fight_finished) {
                self.finished = true;
                self.winner = e.arg;
            }
        }
        return ok;
    }
};

inline fn productive(a: rec.Action) bool {
    return a != .select_attack_type;
}

/// SearchDriver.advanceQueue, then simAdvance's forceStalledLap branch (refused: not ported, unless no unit lives,
/// where forceStalledLap returns false and the rollout ends at the leaf).
fn simAdvance(s: *State, sim: *Sim) Error!void {
    const attempts = @as(usize, s.n_holder) + 2;
    var i: usize = 0;
    while (i < attempts and !sim.finished and s.active < 0) : (i += 1) {
        _ = sim.apply(s, .{ .advance = .{ .damage_dealt_this_lap = s.damage_lap == s.fight.lap } });
        if (sim.finished) return;
        if (s.active >= 0) return;
        if (sim.events.len == 0 and s.fight.up_next.len == 0) break;
    }
    if (sim.finished or s.active >= 0) return;
    for (s.holderOrder()) |slot| {
        if (!s.units[slot].isDead()) return error.UnsupportedStall;
    }
}

/// SearchDriver.simPlayTurn: the seat's policy decides, its actions apply, then the turn ends.
fn simPlayTurn(s: *State, ui: u8, req: *const Request, sim: *Sim) Error!void {
    const decide = req.policies[s.units[ui].team] orelse return error.UnsupportedPolicy;
    var decision: ai.Decision = undefined;
    decide(s, ui, &decision);
    var did = false;
    for (decision.slice()) |a| {
        if (sim.finished) break;
        if (sim.apply(s, a) and productive(a)) did = true;
    }
    if (!sim.finished and s.active == ui and !did) return error.UnsupportedRecovery;
    if (!sim.finished and s.active == ui) {
        if (!sim.apply(s, .{ .end_turn = .{ .unit = ui, .reason = .manual } })) s.active = -1;
    }
}

/// leafValue: the exact terminal result when asked for, else the material leaf
/// 0.5 * (1 + (ours - enemy) / (ours + enemy + 1)) over the living units' cumulative HP, in holder order.
pub fn leafValue(s: *const State, team: u8, finished: bool, winner: i32, exact_terminal: bool) f64 {
    if (exact_terminal and finished and winner >= 0) {
        if (winner == Team.NO_TEAM) return 0.5;
        return if (winner == team) 1 else 0;
    }
    var ours: f64 = 0;
    var enemy: f64 = 0;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.isDead()) continue;
        const hp = @max(u.hp, 0);
        const cumulative = (u.amount_alive - 1) * u.max_hp + hp; // Unit.getCumulativeHp
        if (u.team == team) ours += cumulative else enemy += cumulative;
    }
    return 0.5 * (1 + (ours - enemy) / (ours + enemy + 1));
}

/// One rollout on `s` (a copy of the root state). Returns the leaf value, -Infinity for a rejected candidate, or null
/// when the deadline or the turn budget cut it (`ctl.stop` says which).
pub fn rollout(s: *State, req: *const Request, cand: *const Candidate, r: u32, ctl: *Control) Error!?f64 {
    if (ctl.expired()) return null;
    s.rng = Rng.init(plainSeed(req.seed_base, r));
    var sim: Sim = .{};
    const actor = req.actor;
    s.active = @intCast(actor);
    const acting = s.units[actor].team;
    const start_lap = s.fight.lap;

    // ply 0: the candidate itself
    var did = false;
    for (cand.actions) |a| {
        if (ctl.expired()) return null;
        if (sim.finished) break;
        const ok = sim.apply(s, a);
        if (ctl.expired()) return null;
        if (!ok and productive(a)) {
            if (!cand.incumbent) return -std.math.inf(f64);
            continue;
        }
        if (ok and productive(a)) did = true;
    }
    if (cand.incumbent and !did) return -std.math.inf(f64);
    if (!sim.finished and s.active == actor) {
        if (ctl.expired()) return null;
        if (!did) _ = sim.apply(s, .{ .defend_turn = .{ .unit = actor } });
        if (s.active == actor) {
            if (!sim.apply(s, .{ .end_turn = .{ .unit = actor, .reason = .manual } })) s.active = -1;
        }
    }

    // roll forward: both seats play their policies
    const enemy_team = engine.opposite(acting);
    const cap: u32 = switch (req.horizon) {
        .leaf => 0,
        .lap => MAX_LAP_HORIZON_TURNS,
        .reply => MAX_REPLY_HORIZON_TURNS,
        .turns => req.turns,
    };
    var turns: u32 = 0;
    while (!sim.finished and turns < cap) {
        if (ctl.expired()) return null;
        if (req.horizon == .lap and s.fight.lap > start_lap) break;
        if (s.active < 0) {
            try simAdvance(s, &sim);
            if (sim.finished or s.active < 0) break;
        }
        const ui: u8 = @intCast(s.active);
        const u = &s.units[ui];
        if (!u.in_holder or u.isDead()) {
            s.active = -1;
            continue;
        }
        try simPlayTurn(s, ui, req, &sim);
        turns += 1;
        ctl.turns += 1;
        if (req.horizon == .reply and s.units[ui].team == enemy_team) break;
    }
    if (ctl.expired()) return null;
    if (s.overflow) return error.UnsupportedCapacity;
    return leafValue(s, acting, sim.finished, sim.winner, req.exact_terminal);
}

/// Every (candidate, r) pair of the request in order, each on a fresh copy of `root` made in `scratch`; writes one value
/// per pair into `out` and returns how many it wrote (a prefix when the deadline, the turn budget or `out` stops it).
pub fn run(root: *const State, scratch: *State, req: *const Request, out: []f64, ctl: *Control) Error!usize {
    var written: usize = 0;
    for (req.pairs) |p| {
        if (written >= out.len) {
            ctl.stop = .out_full;
            break;
        }
        scratch.* = root.*;
        const v = (try rollout(scratch, req, &req.candidates[p[0]], p[1], ctl)) orelse break;
        out[written] = v;
        written += 1;
    }
    return written;
}

// =====================================================================================================================
// Playing a battle out
// =====================================================================================================================

/// The outcome of playing a loaded battle to its end (C layout: the bridge returns it as is).
pub const PlayResult = extern struct {
    /// ai.EndReason: 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (recovery net).
    end: i32 = 0,
    /// The fight_finished event's team (0 = no team), -1 when the fight did not finish.
    winner: i32 = -1,
    lap: i32 = 0,
    /// Engine calls and decisions made.
    steps: u32 = 0,
    decisions: u32 = 0,
    /// The random stream's state at the end.
    rng: u32 = 0,
};

/// Called after every step of a play-out with the state (e.g. to learn the ids of the units summoned so far).
pub const StepHook = struct {
    ctx: *anyopaque,
    f: *const fn (ctx: *anyopaque, s: *const State) void,
};

const PlayObserver = struct {
    result: *PlayResult,
    hook: ?StepHook = null,

    fn step(ctx: *anyopaque, kind: ai.StepKind, action: rec.Action, r0: u32, s: *const State, ok: bool, events: []const rec.Event) bool {
        _ = action;
        _ = r0;
        _ = ok;
        const self: *PlayObserver = @ptrCast(@alignCast(ctx));
        if (kind == .decide) self.result.decisions += 1 else self.result.steps += 1;
        for (events) |e| {
            if (e.kind == .fight_finished) self.result.winner = e.arg;
        }
        if (self.hook) |h| h.f(h.ctx, s);
        return true;
    }
};

/// The ids of the units summoned in a play-out, by uid from `first` on (a summon joins the holder at the end of the
/// step that raised it): a StepHook for callers whose id table must name them (digests of the final state).
pub const SummonIds = struct {
    first: usize,
    ids: std.ArrayList([36]u8) = .empty,
    alloc: std.mem.Allocator,

    pub fn hook(self: *SummonIds) StepHook {
        return .{ .ctx = self, .f = capture };
    }

    fn capture(ctx: *anyopaque, s: *const State) void {
        const self: *SummonIds = @ptrCast(@alignCast(ctx));
        while (self.first + self.ids.items.len < s.next_uid) {
            const uid = self.first + self.ids.items.len;
            var text: [36]u8 = .{'?'} ** 36;
            for (s.holderOrder()) |i| {
                if (s.units[i].uid == uid) _ = @import("uuid.zig").format(&s.units[i].uuid, &text);
            }
            self.ids.append(self.alloc, text) catch return;
        }
    }

    /// `base` followed by the captured ids (slices into `self`), allocated from `arena`.
    pub fn table(self: *const SummonIds, arena: std.mem.Allocator, base: []const []const u8) ![]const []const u8 {
        const out = try arena.alloc([]const u8, base.len + self.ids.items.len);
        @memcpy(out[0..base.len], base);
        for (self.ids.items, 0..) |*t, i| out[base.len + i] = t;
        return out;
    }
};

/// Plays `s` out with `decide` on both seats: from the start (start_fight first) when the fight has not started, else
/// from where it stands (runMatchInner's loop: a decision boundary or no active unit).
pub fn play(s: *State, max_laps: i32, decide: DecideFn) PlayResult {
    return playHooked(s, max_laps, decide, null);
}

/// play, calling `hook` after every step.
pub fn playHooked(s: *State, max_laps: i32, decide: DecideFn, hook: ?StepHook) PlayResult {
    var result: PlayResult = .{};
    var obs = PlayObserver{ .result = &result, .hook = hook };
    const observer: ai.Observer = .{ .ctx = &obs, .step = PlayObserver.step };
    const end = if (s.fight.started) ai.continueMatchWith(s, max_laps, observer, decide) else ai.playMatchWith(s, max_laps, observer, decide);
    result.end = @intFromEnum(end);
    result.lap = s.fight.lap;
    result.rng = s.rng.state;
    return result;
}

test "plain chance seed is (seedBase + r * 0x9e3779b1) >>> 0" {
    // (123456789 + 3 * 0x9e3779b1) >>> 0 = 8086763072 mod 2^32
    try std.testing.expectEqual(@as(u32, @intCast((123456789 + 3 * 2654435761) % 4294967296)), plainSeed(123456789, 3));
    try std.testing.expectEqual(@as(u32, 4294967295), toUint32(-1));
    try std.testing.expectEqual(@as(u32, 5), toUint32(5.9));
}
