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
const engine = @import("../engine.zig");
const path = @import("../path.zig");
const js = @import("../jsnum.zig");
const AT = st.AttackType;
const abilities = @import("../abilities.zig");

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

// ---- backline protector and ward (v0_8_backline_protector.ts) ----

const Protector = enum { abomination, angel, arachna_queen };

fn protectorKind(ui: u8) ?Protector {
    return switch (util.creature(ui)) {
        .abomination => .abomination,
        .angel => .angel,
        .arachna_queen => .arachna_queen,
        else => null,
    };
}

/// isV08BacklineProtectionBeneficiary: living ranged output (spell output is out of scope).
fn isBeneficiary(u: *const st.Unit) bool {
    return !u.isDead() and engine.isRangeCapable(u) and engine.getRangeShots(u) > 0;
}

/// v08BacklineWardValue: remaining maximum ranged output (no spells in scope).
fn wardValue(u: *const st.Unit) f64 {
    const amount = @max(1, @max(0, u.amount_alive));
    const per = @max(1, @max(0, u.attack_damage_max) * amount);
    const ranged = if (engine.isRangeCapable(u)) @max(0, engine.getRangeShots(u)) * per else 0;
    return @min(9007199254740991.0, ranged);
}

/// v08BacklineProtectorCoverageRange: Angel's screen 2; Abomination's and Queen's aura range, 1 without the aura in
/// scope; no synergy aura range in scope.
fn coverageRange(pi: u8) i32 {
    return if (protectorKind(pi) == .angel) 2 else 1;
}

fn footprintDistance(a: []const rec.Cell, b: []const rec.Cell) i32 {
    var best: i32 = std.math.maxInt(i32);
    for (a) |x| for (b) |y| {
        best = @min(best, @max(@abs(x.x - y.x), @abs(x.y - y.y)));
    };
    return best;
}

/// The ward the protector `pi` is assigned to (buildV08BacklineProtectorIntent), or null. Abomination is released by
/// default (V08_ABOMINATION_GUARD unset); no summons in scope.
fn protectorWard(s: *const st.State, pi: u8) ?u8 {
    const kind = protectorKind(pi) orelse return null;
    if (kind == .abomination) return null;
    const p = &s.units[pi];
    var best: ?u8 = null;
    var count: usize = 0;
    for (s.units[0..s.n_units], 0..) |*w, i| {
        if (!w.in_holder or i == pi or w.team != p.team or !isBeneficiary(w)) continue;
        count += 1;
        const wi: u8 = @intCast(i);
        if (best) |b| {
            const vb = wardValue(&s.units[b]);
            const vw = wardValue(w);
            if (vw > vb or (vw == vb and util.idRank(wi) < util.idRank(b))) best = wi;
        } else best = wi;
    }
    const ward = best orelse return null;
    if (kind == .angel) {
        if (count < 2) return null;
        var shooter = false;
        for (s.units[0..s.n_units]) |*e| {
            if (e.in_holder and !e.isDead() and e.team != p.team and engine.isRangeCapable(e) and engine.getRangeShots(e) > 0) shooter = true;
        }
        if (!shooter) return null;
    }
    if (util.dominantFinishState(s, p.team).active) return null;
    if (kind == .arachna_queen) {
        var flyer = false;
        for (s.units[0..s.n_units]) |*e| {
            if (e.in_holder and !e.isDead() and e.team != p.team and engine.canFly(e)) flyer = true;
        }
        if (!flyer) return null;
    }
    return ward;
}

/// buildV08BacklineWardIntent: the protector (Abomination first, then by id) whose assigned ward is this unit.
fn wardProtector(s: *const st.State, ui: u8) ?u8 {
    const u = &s.units[ui];
    if (!isBeneficiary(u)) return null;
    var order: [st.MAX_UNITS]u8 = undefined;
    var n: usize = 0;
    for (s.units[0..s.n_units], 0..) |*p, i| {
        if (!p.in_holder or i == ui or p.isDead() or p.team != u.team or protectorKind(@intCast(i)) == null) continue;
        order[n] = @intCast(i);
        n += 1;
    }
    std.sort.insertion(u8, order[0..n], {}, struct {
        fn lt(_: void, a: u8, b: u8) bool {
            const aa = protectorKind(a) == .abomination;
            const bb = protectorKind(b) == .abomination;
            if (aa != bb) return aa;
            return util.idRank(a) < util.idRank(b);
        }
    }.lt);
    for (order[0..n]) |pi| {
        if (protectorWard(s, pi) == ui) return pi;
    }
    return null;
}

/// decisionDestinationCells: the body where the decision leaves the unit (no Castling in scope).
fn destinationCells(s: *const st.State, ui: u8, actions: []const rec.Action, buf: *engine.Cells) []const rec.Cell {
    const u = &s.units[ui];
    var i = actions.len;
    while (i > 0) {
        i -= 1;
        switch (actions[i]) {
            .obstacle_attack => |o| if (o.has_from) {
                buf.* = ai.footprintForAnchor(u, o.attack_from);
                return buf.slice();
            },
            else => {},
        }
    }
    i = actions.len;
    while (i > 0) {
        i -= 1;
        if (actions[i] == .melee_attack) {
            buf.* = ai.footprintForAnchor(u, actions[i].melee_attack.attack_from);
            return buf.slice();
        }
    }
    i = actions.len;
    while (i > 0) {
        i -= 1;
        if (actions[i] == .move_unit) {
            const m = actions[i].move_unit;
            if (m.target_cells.len > 0) return m.target_cells;
            if (m.path.len > 0) {
                buf.* = ai.footprintForAnchor(u, m.path[m.path.len - 1]);
                return buf.slice();
            }
            break;
        }
    }
    buf.* = engine.unitCells(u);
    return buf.slice();
}

/// preservesV08BacklineWardIntent: inside the protector's range stays inside it; outside, never farther.
fn preservesWard(s: *const st.State, ui: u8, pi: u8, actions: []const rec.Action) bool {
    var buf: engine.Cells = .{};
    const dest = destinationCells(s, ui, actions, &buf);
    const pcells = engine.unitCells(&s.units[pi]);
    const range = coverageRange(pi);
    const current = footprintDistance(pcells.slice(), engine.unitCells(&s.units[ui]).slice());
    const after = footprintDistance(pcells.slice(), dest);
    return if (current <= range) after <= range else after <= current;
}

/// repairV08BacklineWardDecision: a productive ward keeps inside its protector's screen; when the decision would
/// leave it, a preserving attack, else a wait, a defend, a move, or ending the turn.
pub fn backlineWard(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const pi = wardProtector(s, c.ui) orelse return util.copyDecision(out, in);
    if (preservesWard(s, c.ui, pi, in.slice())) return util.copyDecision(out, in);
    var all: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY, &all);
    var kept: cand.Set = .{};
    for (all.slice()) |*cd| {
        if (!preservesWard(s, c.ui, pi, cd.d.slice())) continue;
        kept.items[kept.n] = cd.*;
        util.copyDecision(&kept.items[kept.n].d, &cd.d);
        kept.n += 1;
    }
    if (selectDirectCombat(&kept)) |i| return take(out, &kept, i);
    for ([_]cand.Kind{ .wait, .defend, .move }) |k| {
        for (kept.slice(), 0..) |*cd, i| if (cd.kind == k) return take(out, &kept, i);
    }
    util.setEndTurn(out, c.ui);
}

// ---- ranged positioning (v0_8_ranged_positioning.ts), production path: the pinned retreat ----

/// Unit.calculateAttackDamageMin/Max at an explicit attack rate (combat.damageBound reads the unit's own attack).
fn boundAt(att: *const st.Unit, tgt: *const st.Unit, dmg: f64, rate: f64, is_range: bool) f64 {
    const armor = if (is_range) engine.getRangeArmor(tgt) else engine.getArmor(tgt);
    const luck = engine.getLuck(tgt);
    return @max(1, @ceil(((((dmg * rate * att.amount_alive) / armor) * (1 - luck / 100)) / 1) * att.attack_multiplier * 1));
}

/// estimatePrimaryMeleeDamage, reduced to what pinnedRetreat reads: null when unsupported, else whether the hit is a
/// secure kill. `ok` turns false on a board term not ported yet (auras, or an attacker ability that sequences damage).
fn meleeSecureKill(s: *const st.State, ai_: u8, ti: u8, actions: []const rec.Action, ok: *bool) ?bool {
    const u = &s.units[ai_];
    const t = &s.units[ti];
    if (t.isDead()) return null;
    for (actions) |a| if (a == .move_unit and a.move_unit.has_lava) return null;
    if (u.ability(.lightning_spin) != null or u.ability(.double_punch) != null or u.ability(.skewer_strike) != null) return null;
    if (u.ability(.rapid_charge) != null or u.ability(.backstab) != null or u.ability(.lucky_strike) != null or u.ability(.penetrating_bite) != null) ok.* = false;
    for (s.units[0..s.n_units]) |*o| {
        if (o.in_holder and !o.isDead() and (o.ability(.pegasus_might_aura) != null or o.ability(.absorb_penalties_aura) != null or o.ability(.venom_cloud_aura) != null)) ok.* = false;
    }
    if (!ok.*) return null;
    const rate = @max(u.base_attack, engine.getAttack(u));
    const lo = boundAt(u, t, u.attack_damage_min, rate, false);
    const hi = boundAt(u, t, u.attack_damage_max, rate, false);
    if (hi < lo or hi - lo > 10_000) return null;
    const type_mult: f64 = if (u.attack_type == AT.RANGE) 0.5 else 1;
    const smallest = @floor(lo * type_mult);
    const hit = 1 - @min(100, @max(0, abilities.missChance(u, t))) / 100;
    return hit == 1 and smallest >= util.cumulativeHp(t);
}

fn cellsDistance(a: []const rec.Cell, b: []const rec.Cell) i32 {
    return footprintDistance(a, b);
}

/// canBeAttackedByMelee at a position: any footprint cell inside the enemy aggression zone.
fn pinnedAt(s: *const st.State, u: *const st.Unit, px: f64, py: f64) bool {
    const aggr = engine.enemyAggr(s, u);
    const cells = engine.cellsForPosition(px, py, u.fw, u.fh);
    for (cells.slice()) |c| {
        if (c.x < 0 or c.x >= st.GRID or c.y < 0 or c.y >= st.GRID) continue;
        if (aggr[@intCast(c.x)][@intCast(c.y)] > 1) return true;
    }
    return false;
}

/// AttackHandler.getRangeAttackDivisor (combat.zig rangeDivisor / shotCellDistance, copied: they are file-private).
fn rangeDivisorAt(att: *const st.Unit, hx: f64, hy: f64, ax: f64, ay: f64) f64 {
    var divisor: f64 = 1;
    const band = if (att.shot_distance > 0 and std.math.isFinite(att.shot_distance)) @floor(att.shot_distance) else 0;
    if (band > 0) {
        const tc = engine.cellForPosition(hx, hy);
        const t = engine.positionForCell(@floatFromInt(tc.x), @floatFromInt(tc.y));
        const hfx = ((@as(f64, @floatFromInt(att.fw)) - 1) / 2) * engine.CELL;
        const hfy = ((@as(f64, @floatFromInt(att.fh)) - 1) / 2) * engine.CELL;
        var away = @max(0, js.round(@max(@abs(t[0] - ax) - hfx, @abs(t[1] - ay) - hfy) / engine.CELL));
        while (away > band) {
            away -= band;
            divisor *= 2;
        }
    }
    return @max(1, divisor);
}

/// allyScreensThreat: the ally sits between the shooter's cells and that enemy, within reach of the shooter.
fn allyScreens(dest: []const rec.Cell, ally: []const rec.Cell, enemy: []const rec.Cell) bool {
    const shooter_enemy = cellsDistance(dest, enemy);
    const ally_enemy = cellsDistance(ally, enemy);
    const shooter_ally = cellsDistance(dest, ally);
    return ally_enemy < shooter_enemy and shooter_ally <= 3 and ally_enemy + shooter_ally <= shooter_enemy + 1;
}

const RouteView = struct {
    route: u16,
    unscreened: i32,
    reachable: i32,
    eligible: bool,
    min_enemy: i32,
    nearest_front: i32,
    divisor: f64,
    cost: f64,
};

fn preferRetreat(l: *const RouteView, r: *const RouteView) bool {
    if (l.unscreened != r.unscreened) return l.unscreened < r.unscreened;
    if (l.reachable != r.reachable) return l.reachable < r.reachable;
    if (l.min_enemy != r.min_enemy) return l.min_enemy > r.min_enemy;
    if (l.nearest_front != r.nearest_front) return l.nearest_front < r.nearest_front;
    if (l.divisor != r.divisor) return l.divisor < r.divisor;
    return l.cost < r.cost;
}

/// pinnedRetreat (legacy selection; the supported-delta catalog is an off-by-default experiment): a shooter that is
/// pinned in melee reach and would strike a non-securely-killed target in melee, or would not shoot, retreats to the
/// best reachable cell outside melee reach where every enemy that could reach it is screened by a melee ally.
fn pinnedRetreat(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision, ok: *bool) void {
    const s = c.s;
    const u = c.unit();
    util.copyDecision(out, in);
    if (u.attack_type != AT.RANGE or engine.getRangeShots(u) <= 0) return;
    if (!pinnedAt(s, u, u.pos_x, u.pos_y)) return;
    var melee: ?rec.Action = null;
    for (in.slice()) |a| switch (a) {
        .range_attack, .obstacle_attack => return,
        .melee_attack => melee = a,
        else => {},
    };
    if (melee) |m| {
        if (isDirectCombat(in.slice()) and util.dominantFinishState(s, u.team).active) return;
        if (s.fight.lap >= engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1) return;
        const secure = meleeSecureKill(s, c.ui, m.melee_attack.target, in.slice(), ok) orelse return;
        if (secure) return;
    }
    var enemies: [st.MAX_UNITS]u8 = undefined;
    var ne: usize = 0;
    var front: [st.MAX_UNITS]u8 = undefined;
    var nfr: usize = 0;
    for (s.units[0..s.n_units], 0..) |*o, i| {
        if (!o.in_holder or o.isDead()) continue;
        if (o.team != u.team) {
            enemies[ne] = @intCast(i);
            ne += 1;
        } else if (i != c.ui and (o.attack_type == AT.MELEE or o.attack_type == AT.MELEE_MAGIC)) {
            front[nfr] = @intCast(i);
            nfr += 1;
        }
    }
    if (ne == 0) return;
    const mp = c.actualPath();
    const base = engine.baseCell(u);
    var best: ?RouteView = null;
    for (mp.known(), 0..) |*r, ri| {
        if (r.cell.x == base.x and r.cell.y == base.y) continue;
        if (r.has_lava or !ai.canLandAt(s, c.ui, r.cell)) continue;
        const body = ai.footprintForAnchor(u, r.cell);
        const foot = body.slice();
        const pos = engine.positionForCells(foot) orelse continue;
        if (pinnedAt(s, u, pos[0], pos[1])) continue;
        var reachable: i32 = 0;
        var screened: i32 = 0;
        var min_enemy: i32 = std.math.maxInt(i32);
        var divisor: f64 = std.math.inf(f64);
        for (enemies[0..ne]) |ei| {
            const e = &s.units[ei];
            const ecells = engine.unitCells(e);
            const d = cellsDistance(foot, ecells.slice());
            min_enemy = @min(min_enemy, d);
            divisor = @min(divisor, rangeDivisorAt(u, e.pos_x, e.pos_y, pos[0], pos[1]));
            if (@as(f64, @floatFromInt(d)) > @ceil(@max(0, engine.getSteps(e))) + 1) continue; // withinMeleeHorizon
            reachable += 1;
            for (front[0..nfr]) |fi| {
                if (allyScreens(foot, engine.unitCells(&s.units[fi]).slice(), ecells.slice())) {
                    screened += 1;
                    break;
                }
            }
        }
        var nearest: i32 = std.math.maxInt(i32);
        for (front[0..nfr]) |fi| nearest = @min(nearest, cellsDistance(foot, engine.unitCells(&s.units[fi]).slice()));
        const view = RouteView{ .route = @intCast(ri), .unscreened = reachable - screened, .reachable = reachable, .eligible = reachable == screened, .min_enemy = min_enemy, .nearest_front = nearest, .divisor = divisor, .cost = r.weight };
        if (!view.eligible) continue;
        if (best == null or preferRetreat(&view, &best.?)) best = view;
    }
    const b = best orelse return;
    const r = &mp.known()[b.route];
    out.* = .{};
    const len = mp.routeCells(r, &out.path);
    const body = ai.footprintForAnchor(u, r.cell);
    const cells = body.slice();
    @memcpy(out.targets[0..cells.len], cells);
    out.push(.{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..cells.len], .has_lava = r.has_lava } });
}

/// prioritizeV08RangedPositioning at production settings (V08_RANGED_POSITION_MODE "retreat", the band-advance and
/// pre-pin egress experiments off): the pinned retreat. False on a board term not ported yet.
pub fn rangedPositioning(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    if (!util.battle.ranged_positioning) {
        util.copyDecision(out, in);
        return true;
    }
    var ok = true;
    pinnedRetreat(c, in, out, &ok);
    return ok;
}

/// Runs one ported pass on `in`; false when the pass is not ported yet.
pub fn runPass(c: *ai.Ctx, pass: Pass, in: *const ai.Decision, out: *ai.Decision) bool {
    switch (pass) {
        .explicit => explicit(c.ui, in, out),
        .defend_to_wait => defendToWait(c.s, c.ui, in, out),
        .prioritize => prioritize(c, in, out),
        .finish => return finish(c, in, out),
        .backline_ward => backlineWard(c, in, out),
        .ranged_positioning => return rangedPositioning(c, in, out),
        else => return false,
    }
    return true;
}
