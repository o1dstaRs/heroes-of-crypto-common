//! v0.8's own passes (src/ai/versions/v0_8.ts StrategyV0_8.decideTurn), after the inherited chain v0.1 ... v0.7.
//! Each pass takes the previous pass's decision and returns its own; `runPass` runs one ported pass on any input, which
//! is how `hoc-sim v08 layers --passes` checks a pass in isolation on the recorded input (the logged layer before it).
//! Passes not ported yet return false from `runPass`; the check then skips them.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const cand = @import("cand.zig");

/// The recorder's pass names, in decideTurn's order (zig/parity/v08/layers.ts).
pub const Pass = enum {
    explicit,
    prioritize,
    defend_to_wait,
    finish,
    ranged_positioning,
    forbidden_target,
    splash,
    damage_spell,
    vine,
    smoke,
    nightmare,
    healer,
    blacksmith,
    ranked_replay,
    backline_protector,
    backline_ward,
    cemetery,
    coherent_melee,
};

pub fn passFromName(n: []const u8) ?Pass {
    const names = [_]struct { []const u8, Pass }{
        .{ "explicit", .explicit },
        .{ "prioritize", .prioritize },
        .{ "defend-to-wait", .defend_to_wait },
        .{ "finish", .finish },
        .{ "ranged-positioning", .ranged_positioning },
        .{ "forbidden-target", .forbidden_target },
        .{ "splash", .splash },
        .{ "damage-spell", .damage_spell },
        .{ "vine", .vine },
        .{ "smoke", .smoke },
        .{ "nightmare", .nightmare },
        .{ "healer", .healer },
        .{ "blacksmith", .blacksmith },
        .{ "ranked-replay", .ranked_replay },
        .{ "backline-protector", .backline_protector },
        .{ "backline-ward", .backline_ward },
        .{ "cemetery", .cemetery },
        .{ "coherent-melee", .coherent_melee },
    };
    for (names) |e| if (std.mem.eql(u8, n, e[0])) return e[1];
    return null;
}

/// Loads a recorded action list into a Decision (paths copied into the decision's own buffers).
pub fn fromActions(d: *ai.Decision, actions: []const rec.Action) bool {
    d.* = .{};
    var path_used: usize = 0;
    var target_used: usize = 0;
    for (actions) |a| {
        if (d.n >= d.actions.len) return false;
        var x = a;
        switch (x) {
            .move_unit => |*m| {
                if (path_used + m.path.len > d.path.len or target_used + m.target_cells.len > d.targets.len) return false;
                @memcpy(d.path[path_used .. path_used + m.path.len], m.path);
                m.path = d.path[path_used .. path_used + m.path.len];
                path_used += m.path.len;
                @memcpy(d.targets[target_used .. target_used + m.target_cells.len], m.target_cells);
                m.target_cells = d.targets[target_used .. target_used + m.target_cells.len];
                target_used += m.target_cells.len;
            },
            .melee_attack => |*m| {
                if (path_used + m.path.len > d.path.len) return false;
                @memcpy(d.path[path_used .. path_used + m.path.len], m.path);
                m.path = d.path[path_used .. path_used + m.path.len];
                path_used += m.path.len;
            },
            .obstacle_attack => |*o| {
                if (path_used + o.path.len > d.path.len) return false;
                @memcpy(d.path[path_used .. path_used + o.path.len], o.path);
                o.path = d.path[path_used .. path_used + o.path.len];
                path_used += o.path.len;
            },
            else => {},
        }
        d.push(x);
    }
    return true;
}

/// ensureExplicitV08Action: a decision with nothing but attack-type selections and end-turn markers becomes a defend.
pub fn explicit(ui: u8, in: *const ai.Decision, out: *ai.Decision) void {
    for (in.slice()) |a| switch (a) {
        .select_attack_type, .end_turn => {},
        else => {
            util.copyDecision(out, in);
            return;
        },
    };
    out.* = .{};
    out.push(.{ .defend_turn = .{ .unit = ui } });
}

/// The defend-to-wait step of decideTurn: a defend with no productive action becomes a wait when the hourglass allows.
pub fn defendToWait(s: *const st.State, ui: u8, in: *const ai.Decision, out: *ai.Decision) void {
    var defends = false;
    var productive = false;
    for (in.slice()) |a| switch (a) {
        .defend_turn => defends = true,
        .move_unit, .melee_attack, .range_attack => productive = true,
        else => {},
    };
    if (defends and !productive and util.canHourglass(s, ui)) {
        util.setWait(out, ui);
        return;
    }
    util.copyDecision(out, in);
}

/// isV08DirectCombatDecision: a melee or ranged attack (area throws are out of scope).
fn isDirectCombat(actions: []const rec.Action) bool {
    for (actions) |a| switch (a) {
        .melee_attack, .range_attack => return true,
        else => {},
    };
    return false;
}

fn moves(actions: []const rec.Action) bool {
    for (actions) |a| if (a == .move_unit) return true;
    return false;
}

/// selectV08DirectCombatCandidate: among melee and shot candidates with positive expected damage, a kill first, then
/// the most damage, then one that does not move (first wins ties).
fn selectDirectCombat(set: *const cand.Set) ?usize {
    var best: ?usize = null;
    for (set.slice(), 0..) |*c, i| {
        if (c.kind != .melee and c.kind != .shot and c.kind != .throw) continue;
        if (!isDirectCombat(c.d.slice())) continue;
        if (!std.math.isFinite(c.ed) or c.ed <= 0) continue;
        if (best) |b| {
            const bb = &set.items[b];
            if (c.ek > bb.ek or (c.ek == bb.ek and (c.ed > bb.ed or (c.ed == bb.ed and moves(bb.d.slice()) and !moves(c.d.slice()))))) best = i;
        } else best = i;
    }
    return best;
}

/// selectV08ProductiveCandidate: direct combat, else the first move (spells are out of scope).
fn selectProductive(set: *const cand.Set) ?usize {
    if (selectDirectCombat(set)) |i| return i;
    for (set.slice(), 0..) |*c, i| if (c.kind == .move) return i;
    return null;
}

fn take(out: *ai.Decision, set: *const cand.Set, i: usize) void {
    util.copyDecision(out, &set.items[i].d);
}

/// prioritizeV08ProductiveAction: a passive turn (defend, obstacle strike, end turn) becomes the best productive
/// candidate; an already productive decision without an obstacle strike stays.
fn productiveAction(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    var passive = false;
    var productive = false;
    var obstacle = false;
    for (in.slice()) |a| switch (a) {
        .defend_turn, .end_turn => passive = true,
        .obstacle_attack => {
            passive = true;
            obstacle = true;
        },
        .move_unit, .melee_attack, .range_attack => productive = true,
        else => {},
    };
    if (!passive or (productive and !obstacle)) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY, &set);
    if (selectProductive(&set)) |i| return take(out, &set, i);
    util.copyDecision(out, in);
}

/// prioritizeV08Decision: in the dominant-finish window or the final sprint, deal damage now (a commanding army may
/// retarget to more damage; otherwise only a stack kill bypasses the incumbent) or, commanding, advance; at every lap
/// repair a passive incumbent.
pub fn prioritize(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const fs = util.dominantFinishState(c.s, c.unit().team);
    if (fs.active) {
        var set: cand.Set = .{};
        cand.enumerate(c, in, cand.BOUNDARY, &set);
        if (selectDirectCombat(&set)) |i| {
            if (fs.dominant or set.items[i].ek == 1) return take(out, &set, i);
        }
        if (isDirectCombat(in.slice())) return util.copyDecision(out, in);
        if (fs.dominant) {
            for (set.slice(), 0..) |*cd, i| if (cd.kind == .move) return take(out, &set, i);
        }
    }
    productiveAction(c, in, out);
}

const DELIVERY_EPSILON = 1e-9;

const Delivery = struct {
    cand: usize,
    incumbent: bool,
    ed: f64,
    ek: u8,
    stationary: bool,
    target: u8,
    remaining: f64,
    work: f64,
};

/// deliveryPrecedes without Dulling Defense (out of scope): kill, the incumbent, damage, stationary, stable order.
fn deliveryPrecedes(l: *const Delivery, r: *const Delivery) bool {
    if (l.ek != r.ek) return l.ek > r.ek;
    if (l.incumbent != r.incumbent) return l.incumbent;
    if (l.ed != r.ed) return l.ed > r.ed;
    if (l.stationary != r.stationary) return l.stationary;
    return l.cand < r.cand;
}

/// selectV08STargetPressureCandidate: a kill now first; else finish an already wounded stack (the least remaining
/// first); else the target with the most remaining attack-work. Null when Dulling Defense or Wild Regeneration is on
/// the board (not ported).
fn targetPressure(s: *const st.State, actor: u8, set: *const cand.Set, ok: *bool) ?usize {
    const team = s.units[actor].team;
    if (s.units[actor].ability(.dulling_defense) != null) ok.* = false;
    var by_target: [st.MAX_UNITS]i32 = .{-1} ** st.MAX_UNITS;
    var order: [st.MAX_UNITS]u8 = undefined;
    var nt: usize = 0;
    var deliveries: [st.MAX_UNITS]Delivery = undefined;
    for (set.slice(), 0..) |*c, i| {
        if (c.target < 0 or !isDirectCombat(c.d.slice())) continue;
        const ti: u8 = @intCast(c.target);
        const t = &s.units[ti];
        const ed = if (std.math.isFinite(c.ed) and c.ed > 0) c.ed else 0;
        if (t.isDead() or t.team == team or ed <= 0) continue;
        if (t.ability(.dulling_defense) != null) ok.* = false;
        const original = @max(0, t.amount_alive + t.amount_died) * @max(0, t.max_hp);
        const remaining = if (original > 0) @min(1, util.cumulativeHp(t) / original) else 1;
        // Wild Regeneration's reserve (max HP per remaining pre-Armageddon activation): no creature in scope regenerates.
        const work = @max(0, util.cumulativeHp(t)) / @max(ed, DELIVERY_EPSILON);
        const d = Delivery{ .cand = i, .incumbent = c.kind == .incumbent, .ed = ed, .ek = c.ek, .stationary = !moves(c.d.slice()), .target = ti, .remaining = remaining, .work = work };
        if (by_target[ti] < 0) {
            by_target[ti] = @intCast(nt);
            order[nt] = ti;
            deliveries[nt] = d;
            nt += 1;
        } else if (deliveryPrecedes(&d, &deliveries[@intCast(by_target[ti])])) deliveries[@intCast(by_target[ti])] = d;
    }
    if (nt == 0) return null;
    var kills = false;
    for (deliveries[0..nt]) |*d| if (d.ek == 1) {
        kills = true;
    };
    // eligible: the immediate kills, else every delivery (no Dulling Defense in scope).
    var focused: [st.MAX_UNITS]Delivery = undefined;
    var nf: usize = 0;
    for (deliveries[0..nt]) |d| if (!kills or d.ek == 1) {
        focused[nf] = d;
        nf += 1;
    };
    var wounded = kills;
    if (!kills) {
        var nw: usize = 0;
        for (focused[0..nf]) |d| if (d.remaining < 1 - DELIVERY_EPSILON) {
            focused[nw] = d;
            nw += 1;
        };
        if (nw > 0) {
            nf = nw;
            wounded = true;
        } else {
            nf = 0;
            for (deliveries[0..nt]) |d| {
                focused[nf] = d;
                nf += 1;
            }
        }
    }
    const Cmp = struct { wounded: bool, kills: bool };
    std.sort.insertion(Delivery, focused[0..nf], Cmp{ .wounded = wounded, .kills = kills }, struct {
        fn lt(k: Cmp, l: Delivery, r: Delivery) bool {
            if (k.wounded and l.remaining != r.remaining) return l.remaining < r.remaining;
            if (!k.kills and l.work != r.work) return l.work > r.work;
            if (l.ed != r.ed) return l.ed > r.ed;
            if (l.stationary != r.stationary) return l.stationary;
            return l.cand < r.cand;
        }
    }.lt);
    return focused[0].cand;
}

/// prioritizeV08A13FinishDecision: from the final sprint (lap 9), the target-pressure attack, else the advance.
/// False when the board needs an unported term.
pub fn finish(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    if (c.s.fight.lap < util.URGENT_FINISH_START_LAP) {
        util.copyDecision(out, in);
        return true;
    }
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.FINISH, &set);
    var ok = true;
    const attack = targetPressure(c.s, c.ui, &set, &ok);
    if (!ok) return false;
    if (attack) |i| {
        take(out, &set, i);
        return true;
    }
    for (set.slice(), 0..) |*cd, i| if (cd.kind == .move) {
        take(out, &set, i);
        return true;
    };
    util.copyDecision(out, in);
    return true;
}

/// Runs one ported pass on `in`; false when the pass is not ported yet.
pub fn runPass(c: *ai.Ctx, pass: Pass, in: *const ai.Decision, out: *ai.Decision) bool {
    switch (pass) {
        .explicit => explicit(c.ui, in, out),
        .defend_to_wait => defendToWait(c.s, c.ui, in, out),
        .prioritize => prioritize(c, in, out),
        .finish => return finish(c, in, out),
        else => return false,
    }
    return true;
}
