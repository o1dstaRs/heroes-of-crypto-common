//! The v0.3 level of the v0.8 chain (src/ai/versions/v0_3.ts StrategyV0_3.decideTurn): a boxed-in shooter with ammo
//! retreats behind its melee line instead of meleeing (unless the strike is free or lethal), and a melee straggler
//! whose v0.2 turn is a pure move rejoins the pack. shouldCohere is v0.4's override: off while a living enemy is an
//! AoE unit. Out of scope: the "No Melee" and "Handyman" exemptions (abilities).

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const pathing = @import("../path.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const lv2 = @import("lv2.zig");

const Cell = st.Cell;
const AT = st.AttackType;

/// How far a melee unit must drift from its allies' centroid before it counts as a straggler.
const STRAGGLER_DIST: f64 = 3.0;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const rin = s.rng.state;
    defer policy.note("v0.3", out, s, rin);
    // A No Melee shooter has no melee to avoid, and a Handyman shooter melees without penalty: neither retreats here.
    if (u.attack_type == AT.RANGE and engine.getRangeShots(u) > 0 and u.canMove() and !u.has(.no_melee) and !u.has(.handyman) and !engine.canLandRangeAttack(s, u) and !meleeIsClearlyRight(c)) {
        if (rangedRetreat(c, out)) return;
    }
    lv2.decide(c, out);
    if (u.attack_type == AT.MELEE and u.canMove() and shouldCohere(c)) _ = cohesionAdvance(c, out);
}

/// StrategyV0_4.shouldCohere: no living enemy is an AoE unit.
fn shouldCohere(c: *const ai.Ctx) bool {
    const s = c.s;
    const opp = engine.opposite(c.unit().team);
    for (0..s.n_units) |i| {
        if (util.livingOf(s, i, opp) and util.isAoEUnit(s, @intCast(i))) return false;
    }
    return true;
}

/// A boxed-in shooter's melee pays only when an adjacent strike is lethal or free (the target already replied).
fn meleeIsClearlyRight(c: *const ai.Ctx) bool {
    const s = c.s;
    const u = c.unit();
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        const ec = engine.unitCells(e);
        if (!util.footprintsNear(ec.slice(), mine.slice())) continue;
        if (util.damageMin(u, e, false, 1) >= util.cumulativeHp(e)) return true;
        if (util.repliedAttack(s, @intCast(i))) return true;
    }
    return false;
}

fn pushMove(c: *ai.Ctx, out: *ai.Decision, r: *const pathing.Route) void {
    out.* = .{};
    const u = c.unit();
    const len = c.actualPath().routeCells(r, &out.path);
    const fp = ai.footprintForAnchor(u, r.cell);
    for (fp.slice(), 0..) |t, i| out.targets[i] = t;
    out.push(.{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..fp.len], .has_lava = r.has_lava } });
}

/// Pull a boxed-in shooter back: the reachable cell furthest from every enemy that keeps near its melee screen;
/// if none improves, wait (hourglass) or hold. False only when no enemy lives.
fn rangedRetreat(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    const team = u.team;
    const opp = engine.opposite(team);
    var enemies: [st.MAX_UNITS]Cell = undefined;
    var n_enemies: usize = 0;
    var allies: [st.MAX_UNITS]Cell = undefined;
    var n_allies: usize = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (util.livingOf(s, i, opp)) {
            enemies[n_enemies] = engine.baseCell(a);
            n_enemies += 1;
        } else if (util.livingOf(s, i, team) and i != c.ui and a.attack_type == AT.MELEE) {
            allies[n_allies] = engine.baseCell(a);
            n_allies += 1;
        }
    }
    if (n_enemies == 0) return false;
    const Safety = struct {
        fn of(cell: Cell, en: []const Cell, al: []const Cell) f64 {
            var min_enemy = std.math.inf(f64);
            for (en) |e| min_enemy = @min(min_enemy, ai.cellDistance(cell, e));
            var nearest_ally: f64 = 0;
            if (al.len > 0) {
                nearest_ally = std.math.inf(f64);
                for (al) |a| nearest_ally = @min(nearest_ally, ai.cellDistance(cell, a));
            }
            return min_enemy * 2 - nearest_ally;
        }
    };
    const mp = c.actualPath();
    const base = engine.baseCell(u);
    var best_route: ?*const pathing.Route = null;
    var best_score = Safety.of(base, enemies[0..n_enemies], allies[0..n_allies]);
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0) continue;
        const score = Safety.of(r.cell, enemies[0..n_enemies], allies[0..n_allies]);
        if (score > best_score) {
            best_score = score;
            best_route = r;
        }
    }
    if (best_route) |r| {
        if (!ai.sameCell(r.cell, base)) {
            pushMove(c, out, r);
            return true;
        }
    }
    out.* = .{};
    if (util.canHourglass(s, c.ui)) {
        out.push(.{ .wait_turn = .{ .unit = c.ui } });
    } else {
        out.push(.{ .end_turn = .{ .unit = c.ui, .reason = .manual } });
    }
    return true;
}

/// A melee straggler whose turn is a pure move steers to the reachable cell nearest its living allies' centroid.
fn cohesionAdvance(c: *ai.Ctx, out: *ai.Decision) bool {
    if (out.n == 0) return false;
    for (out.slice()) |a| if (a != .move_unit) return false;
    const s = c.s;
    const u = c.unit();
    var n: f64 = 0;
    var sum_x: f64 = 0;
    var sum_y: f64 = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (!util.livingOf(s, i, u.team) or i == c.ui) continue;
        const b = engine.baseCell(a);
        sum_x += @floatFromInt(b.x);
        sum_y += @floatFromInt(b.y);
        n += 1;
    }
    if (n < 2) return false;
    const cx = sum_x / n;
    const cy = sum_y / n;
    const base = engine.baseCell(u);
    var best_dist = engine.distance(@floatFromInt(base.x), @floatFromInt(base.y), cx, cy);
    if (best_dist < STRAGGLER_DIST) return false;
    const mp = c.actualPath();
    var best_route: ?*const pathing.Route = null;
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0) continue;
        const d = engine.distance(@floatFromInt(r.cell.x), @floatFromInt(r.cell.y), cx, cy);
        if (d < best_dist) {
            best_dist = d;
            best_route = r;
        }
    }
    const r = best_route orelse return false;
    if (ai.sameCell(r.cell, base)) return false;
    pushMove(c, out, r);
    return true;
}
