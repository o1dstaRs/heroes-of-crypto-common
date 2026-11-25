//! The v0.5 level of the v0.8 chain (src/ai/versions/v0_5.ts StrategyV0_5.decideTurn), default environment, with
//! v0.8's learned weight vector (weights.zig: v0.6's weights with v0.8's melee dims).
//!
//! In scope (no spells or abilities, NORMAL grid) the pipeline is: v0.4, the learned melee re-rank (meleeByPolicy),
//! the learned move re-rank (repositionByPolicy), the charge hourglass (hourglassByPolicy), the blocked-move guard
//! (dropBlockedMove) and the free adjacent attack (takeAdjacentAttack). Identity in scope, so not ported:
//! healerPolicy (no Healer spells), noMeleeRetreat (only No-Melee shooters can move: an ordinary shooter's score
//! never beats its +Infinity start), mineByPolicy (BLOCK_CENTER only), aoeMeleeByPolicy (abilities),
//! excludeHiddenAttack (no Hidden), auraFlyerSupport (no auras), meleeAuraSupport (V05_AURASUPPORT off) and
//! repairUnavailableMovePrefixedAttack (no Fire Wall, no Cowardice). Zero-weight or always-zero score terms (War
//! Anger, punish-melee, target caster, Rapid Charge, bait, Armageddon, Dulling swing, hazard, aura) add exactly 0.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const pathing = @import("../path.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const weights = @import("weights.zig");
const lv4 = @import("lv4.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
const AT = st.AttackType;
const W = weights.W;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const rin = s.rng.state;
    defer policy.note("v0.5", out, s, rin);
    lv4.decide(c, out);
    meleeByPolicy(c, out);
    repositionByPolicy(c, out);
    hourglassByPolicy(c, out);
    dropBlockedMove(c, out);
    takeAdjacentAttack(c, out);
}

inline fn firepowerOf(u: *const Unit) f64 {
    return @max(1, engine.getRangeShots(u)) * @max(1, u.attack_damage_max);
}

/// fmExposure: the share of living enemies that have not acted this lap.
fn fmExposure(c: *const ai.Ctx) f64 {
    const s = c.s;
    const opp = engine.opposite(c.unit().team);
    var n: f64 = 0;
    var yet: f64 = 0;
    for (0..s.n_units) |i| {
        if (!util.livingOf(s, i, opp)) continue;
        n += 1;
        if (!util.madeTurn(s, @intCast(i))) yet += 1;
    }
    return if (n == 0) 0 else yet / n;
}

fn firstIndex(out: *const ai.Decision, comptime tag: std.meta.Tag(rec.Action)) ?usize {
    for (out.slice(), 0..) |a, i| if (a == tag) return i;
    return null;
}

// =====================================================================================================================
// meleeByPolicy
// =====================================================================================================================

const Ally = struct { cells: engine.Cells };

/// Stage-4 learned melee: re-pick the strike's (target, stand cell) among the anchor (v0.4's own), every in-place
/// adjacent enemy and every reachable free stand cell's adjacent enemies, by the learned score; first wins ties.
fn meleeByPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const si = firstIndex(out, .melee_attack) orelse return;
    if (u.target >= 0) return;
    const strike = out.actions[si].melee_attack;
    const team = u.team;
    const opp = engine.opposite(team);
    const base = engine.baseCell(u);
    const mine = engine.unitCells(u);

    var allies: [st.MAX_UNITS]engine.Cells = undefined;
    var n_allies: usize = 0;
    var enemies: [st.MAX_UNITS]u8 = undefined;
    var enemy_cells: [st.MAX_UNITS]engine.Cells = undefined;
    var n_enemies: usize = 0;
    for (s.units[0..s.n_units], 0..) |*a, i| {
        if (util.livingOf(s, i, team) and i != c.ui) {
            allies[n_allies] = engine.unitCells(a);
            n_allies += 1;
        } else if (util.livingOf(s, i, opp)) {
            enemies[n_enemies] = @intCast(i);
            enemy_cells[n_enemies] = engine.unitCells(a);
            n_enemies += 1;
        }
    }
    if (n_enemies == 0) return;

    const v4target = strike.target;
    const v4from = strike.attack_from;
    const my_hp = @max(1, util.cumulativeHp(u));
    const fm = fmExposure(c);

    const Scorer = struct {
        s: *const State,
        u: *const Unit,
        m: *const pathing.Matrix,
        opp: u8,
        allies: []const engine.Cells,
        my_hp: f64,
        fm: f64,
        v4target: u8,
        v4from: Cell,

        fn score(self: *const @This(), target: u8, target_cells: []const Cell, cell: Cell, fp: []const Cell) f64 {
            const t = &self.s.units[target];
            const lo = util.damageMin(self.u, t, false, 1);
            const hi = util.damageMax(self.u, t, false, 1);
            const hp = util.cumulativeHp(t);
            const effective = @min((lo + hi) / 2, hp);
            const dmg = effective / @max(1, t.max_hp);
            const killed = effective >= hp;
            const kill: f64 = if (killed) 1 else 0;
            const replied = util.repliedAttack(self.s, target);
            const retal_free: f64 = if (replied) 1 else 0;
            const threat = firepowerOf(t) / 1000;
            const stand_threat = @as(f64, @floatFromInt(ai.countThreats(self.m, cell, self.opp))) / 3;
            const incumbent: f64 = if (target == self.v4target and ai.sameCell(cell, self.v4from)) 1 else 0;
            var focus: f64 = 0;
            var support: f64 = 0;
            for (self.allies) |*a| {
                if (util.footprintsNear(a.slice(), target_cells)) focus += 1;
                if (util.footprintsNear(a.slice(), fp)) support += 1;
            }
            const focus_fire = focus / 2;
            const stand_support = support / 2;
            const counter: f64 = if (killed or replied) 0 else @min(
                (util.damageMin(t, self.u, false, 1) + util.damageMax(t, self.u, false, 1)) / 2,
                self.my_hp,
            ) / self.my_hp;
            const t_dead = t.amount_died;
            const t_alive = t.amount_alive;
            const target_wounded = if (t_dead + t_alive > 0) t_dead / (t_dead + t_alive) else 0;
            const target_ranged: f64 = if (t.attack_type == AT.RANGE) 1 else 0;
            return W[14] * dmg + W[15] * kill + W[16] * retal_free + W[17] * threat + W[18] * stand_threat +
                W[19] * incumbent + W[20] * counter + W[21] * focus_fire + W[22] * stand_support +
                W[23] * target_wounded + W[25] * counter * self.fm + W[57] * target_ranged;
        }
    };
    const scorer = Scorer{ .s = s, .u = u, .m = &c.m, .opp = opp, .allies = allies[0..n_allies], .my_hp = my_hp, .fm = fm, .v4target = v4target, .v4from = v4from };

    const Best = struct { target: u8, cell: Cell, route: ?*const pathing.Route, score: f64 };
    var best: ?Best = null;
    const Consider = struct {
        fn f(b: *?Best, target: u8, cell: Cell, route: ?*const pathing.Route, value: f64) void {
            if (b.* == null or value > b.*.?.score) b.* = .{ .target = target, .cell = cell, .route = route, .score = value };
        }
    };
    // The anchor: v0.4's own (target, stand cell).
    const vt = &s.units[v4target];
    if (vt.in_holder and !vt.isDead()) {
        const fp = ai.footprintForAnchor(u, v4from);
        const tc = engine.unitCells(vt);
        Consider.f(&best, v4target, v4from, null, scorer.score(v4target, tc.slice(), v4from, fp.slice()));
    }
    // In-place strikes.
    for (enemies[0..n_enemies], enemy_cells[0..n_enemies]) |e, *ec| {
        if (util.footprintsNear(ec.slice(), mine.slice())) {
            Consider.f(&best, e, base, null, scorer.score(e, ec.slice(), base, mine.slice()));
        }
    }
    // Move-and-strike (canMove() is true in scope; no Fire Wall, so moving cannot kill the actor).
    const mp = c.actualPath();
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0) continue;
        const fp = ai.footprintForAnchor(u, r.cell);
        if (!engine.cellsFreeFor(s, c.ui, fp.slice())) continue;
        for (enemies[0..n_enemies], enemy_cells[0..n_enemies]) |e, *ec| {
            if (util.footprintsNear(fp.slice(), ec.slice())) {
                Consider.f(&best, e, r.cell, r, scorer.score(e, ec.slice(), r.cell, fp.slice()));
            }
        }
    }
    const b = best orelse return;
    if (b.target == v4target and ai.sameCell(b.cell, v4from)) return;
    out.* = .{};
    if (u.attack_type_selected != AT.MELEE) out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
    if (b.route) |r| {
        if (!ai.sameCell(b.cell, base)) {
            const len = mp.routeCells(r, &out.path);
            const fp = ai.footprintForAnchor(u, b.cell);
            for (fp.slice(), 0..) |t, i| out.targets[i] = t;
            out.push(.{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..fp.len] } });
        }
    }
    out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = b.target, .attack_from = b.cell, .path = &.{} } });
}

// =====================================================================================================================
// repositionByPolicy
// =====================================================================================================================

/// Stage-2 learned positioning: a pure move's destination is re-picked among the reachable cells by the learned score.
fn repositionByPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const mi = firstIndex(out, .move_unit) orelse return;
    if (util.strikes(out)) return;
    const team = u.team;
    const opp = engine.opposite(team);
    var enemies: [st.MAX_UNITS]Cell = undefined;
    var n_enemies: usize = 0;
    var n_allies: f64 = 0;
    var sum_x: f64 = 0;
    var sum_y: f64 = 0;
    for (s.units[0..s.n_units], 0..) |*a, i| {
        if (util.livingOf(s, i, opp)) {
            enemies[n_enemies] = engine.baseCell(a);
            n_enemies += 1;
        } else if (util.livingOf(s, i, team) and i != c.ui) {
            const b = engine.baseCell(a);
            sum_x += @floatFromInt(b.x);
            sum_y += @floatFromInt(b.y);
            n_allies += 1;
        }
    }
    if (n_enemies == 0) return;
    const base = engine.baseCell(u);
    const move = out.actions[mi].move_unit;
    const dest = if (move.path.len > 0) move.path[move.path.len - 1] else base;
    const cx: f64 = if (n_allies > 0) sum_x / n_allies else @floatFromInt(base.x);
    const cy: f64 = if (n_allies > 0) sum_y / n_allies else @floatFromInt(base.y);
    const steps = @max(1, engine.getSteps(u));
    const Geo = struct {
        fn minEnemy(cell: Cell, en: []const Cell) f64 {
            var d = std.math.inf(f64);
            for (en) |e| d = @min(d, ai.cellDistance(cell, e));
            return d;
        }
        fn toCentroid(cell: Cell, x: f64, y: f64) f64 {
            return engine.distance(@floatFromInt(cell.x), @floatFromInt(cell.y), x, y);
        }
    };
    const en = enemies[0..n_enemies];
    const base_enemy = Geo.minEnemy(base, en);
    const base_centroid = Geo.toCentroid(base, cx, cy);
    const shooter = u.attack_type == AT.RANGE and engine.getRangeShots(u) > 0;
    const shot_dist = u.shot_distance;
    const fm = fmExposure(c);

    const mp = c.actualPath();
    var best: ?*const pathing.Route = null;
    var best_score = -std.math.inf(f64);
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0) continue;
        const cell = r.cell;
        const ed = Geo.minEnemy(cell, en);
        const advance = (base_enemy - ed) / steps;
        const cohesion = (base_centroid - Geo.toCentroid(cell, cx, cy)) / steps;
        const incumbent: f64 = if (ai.sameCell(cell, dest)) 1 else 0;
        const threat = @as(f64, @floatFromInt(ai.countThreats(&c.m, cell, opp))) / 3;
        const aggr_zone: f64 = if (r.first_aggr_met) 1 else 0;
        const shoot_ready: f64 = if (shooter and ed >= 2 and ed <= shot_dist) 1 else 0;
        const value = W[6] * advance + W[7] * cohesion + W[9] * incumbent + W[10] * threat + W[11] * aggr_zone +
            W[12] * shoot_ready + W[24] * advance * fm;
        if (value > best_score) {
            const fp = ai.footprintForAnchor(u, cell);
            if (engine.cellsFreeFor(s, c.ui, fp.slice())) {
                best_score = value;
                best = r;
            }
        }
    }
    const b = best orelse return;
    if (ai.sameCell(b.cell, dest)) return;
    util.setMove(out, s, c.ui, mp, b);
}

// =====================================================================================================================
// hourglassByPolicy, dropBlockedMove, takeAdjacentAttack
// =====================================================================================================================

/// Strategic hourglass (V05_HOURGLASS on): a melee charge (a path-bearing strike) waits while 67%+ of the living
/// enemies have yet to act. Shooters are exempt (V05_HG_RANGED); a 2+-stack AoE strike (abilities) is kept.
fn hourglassByPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const u = c.unit();
    if (u.attack_type == AT.RANGE) return;
    var charge = false;
    for (out.slice()) |a| {
        if (a == .melee_attack and a.melee_attack.path.len > 0) charge = true;
    }
    if (!charge or !util.canHourglass(c.s, c.ui)) return;
    if (fmExposure(c) < 0.67) return;
    util.setWait(out, c.ui);
}

/// A move whose footprint is not free becomes a wait (else a hold).
fn dropBlockedMove(c: *ai.Ctx, out: *ai.Decision) void {
    const mi = firstIndex(out, .move_unit) orelse return;
    const fp = out.actions[mi].move_unit.target_cells;
    if (fp.len == 0 or engine.cellsFreeFor(c.s, c.ui, fp)) return;
    if (util.canHourglass(c.s, c.ui)) util.setWait(out, c.ui) else util.setEndTurn(out, c.ui);
}

/// A melee unit's pure move that ends next to an attackable enemy (or an idle end while already adjacent) strikes it:
/// a stack it can kill first, else the highest-firepower one (holder order breaks ties).
fn takeAdjacentAttack(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.attack_type != AT.MELEE and u.attack_type != AT.MELEE_MAGIC) return;
    if (util.strikes(out)) return;
    const mi = firstIndex(out, .move_unit);
    var pure_move = false;
    var path: []const Cell = &.{};
    if (mi) |i| {
        path = out.actions[i].move_unit.path;
        pure_move = path.len > 0;
    }
    const idle_end = mi == null and util.has(out, .end_turn); // no Stun / Blindness / Freeze in scope
    if (!pure_move and !idle_end) return;
    const base = engine.baseCell(u);
    const dest = if (pure_move) path[path.len - 1] else base;
    const dest_fp = if (pure_move) ai.footprintForAnchor(u, dest) else engine.unitCells(u);
    const opp = engine.opposite(u.team);
    var best: ?u8 = null;
    var best_kill = false;
    var best_fire: f64 = 0;
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (!util.livingOf(s, i, opp)) continue;
        if (u.target >= 0 and u.target != @as(i8, @intCast(i))) continue;
        const ec = engine.unitCells(e);
        if (!util.footprintsNear(ec.slice(), dest_fp.slice())) continue;
        const kill = util.damageMax(u, e, false, 1) >= util.cumulativeHp(e);
        const fire = firepowerOf(e);
        if (best == null or (kill and !best_kill) or (kill == best_kill and fire > best_fire)) {
            best = @intCast(i);
            best_kill = kill;
            best_fire = fire;
        }
    }
    const t = best orelse return;
    out.n = 0; // keep the buffers: `path` still points into out.path
    if (u.attack_type_selected != AT.MELEE) out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
    out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = t, .attack_from = dest, .path = if (pure_move) path else &.{} } });
}
