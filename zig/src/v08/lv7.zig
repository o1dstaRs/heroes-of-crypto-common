//! The v0.7 level of the v0.8 chain (src/ai/versions/v0_7.ts StrategyV0_7.decideTurn): v0.6, then the melee-magic
//! stance fix. The aura-saturated archetype anchor is the chain's v0.4 level where they are equal (util.anchorPorted;
//! decideV08 refuses the seat otherwise). Then the Arachna Queen assimilation router (a stolen spell; Endless Quiver is
//! not in scope), the melee-magic stance fix and the Terrifying Gaze repair.

const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const ai = @import("../ai.zig");
const policy = @import("policy.zig");
const lv6 = @import("lv6.zig");
const lv4 = @import("lv4.zig");
const cand = @import("cand.zig");
const std = @import("std");
const util = @import("util.zig");

const AT = st.AttackType;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const rin = c.s.rng.state;
    defer policy.note("v0.7", out, c.s, rin);
    // isAuraSaturatedArmy: v0.6's learned policy is out of distribution when every stack emits an aura, so v0.7 plays its
    // standalone v0.4 anchor (lv8 refuses the seat unless util.anchorPorted, where the anchor is the chain's v0.4
    // level); its universal caster router (Resurrection, Wind Flow) has nothing to route in scope.
    if (util.battle.aura_saturated[c.unit().team]) lv4.decide(c, out) else lv6.decide(c, out);
    routeQueenAssimilation(c, out);
    normalizeMeleeMagicSelection(c, out);
    repairForbiddenTarget(c, out);
}

/// routeArachnaQueenAssimilation: an Arachna Queen holding a spell with charges left (Predatory Assimilation took a
/// castable card) casts the first spell candidate instead of a turn that neither casts nor deals damage (melee, shot,
/// area throw or obstacle strike); a Queen with a stolen Endless Quiver (natively melee, now range-capable with RANGE
/// among her attack types) fires the shot candidate with the highest expected damage (first on ties) instead of any
/// turn that does not cast, keeping the turn when no shot is legal.
fn routeQueenAssimilation(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (util.creature(s, c.ui) != .arachna_queen) return;
    var remaining = false;
    for (u.spells[0..u.n_spells]) |b| {
        if (b.amount > 0) remaining = true;
    }
    const stolen_range = u.attack_type != AT.RANGE and u.has(.endless_quiver) and engine.isRangeCapable(u) and
        engine.possibleIncludes(u, AT.RANGE);
    if (!remaining and !stolen_range) return;
    var casts = false;
    var damages = false;
    for (out.slice()) |a| switch (a) {
        .cast_spell => casts = true,
        .melee_attack, .range_attack, .area_throw_attack, .obstacle_attack => damages = true,
        else => {},
    };
    if (remaining and !casts and !damages) {
        var set: cand.Set = .{};
        cand.enumerate(c, out, .{ .spells_only = true }, &set);
        for (set.slice()) |*k| {
            if (k.kind == .spell) return util.copyDecision(out, &k.d);
        }
    }
    if (stolen_range and !casts) {
        var set: cand.Set = .{};
        cand.enumerate(c, out, .{ .shots_only = true }, &set);
        var best: ?usize = null;
        for (set.slice(), 0..) |*k, i| {
            if (k.kind == .shot and (best == null or k.ed > set.items[best.?].ed)) best = i;
        }
        if (best) |b| util.copyDecision(out, &set.items[b].d);
    }
}

/// attacksForbiddenTarget: a melee or a shot aimed at the Terrifying Gaze gazer (cannotAttackUnitId).
fn attacksForbidden(s: *const st.State, u: *const st.Unit, acts: []const rec.Action) bool {
    for (acts) |a| switch (a) {
        .melee_attack => |m| if (u.cannotAttack(s.units[m.target].uid)) return true,
        .range_attack => |r| if (u.cannotAttack(s.units[r.target].uid)) return true,
        else => {},
    };
    return false;
}

/// repairV07ForbiddenTargetDecision: an attack on the gazer (a late v0.4/v0.5 overlay replaced v0.1's checked target)
/// is re-enumerated from an end-turn incumbent (the boundary options) without the gazer: the best legal attack (a kill,
/// then damage, then one that does not move; first on ties), else a spell, move, wait or defend, else end the turn.
fn repairForbiddenTarget(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.forbidden == st.NO_UID or !attacksForbidden(s, u, out.slice())) return;
    var inc: ai.Decision = .{};
    inc.push(.{ .end_turn = .{ .unit = c.ui, .reason = .manual } });
    var set: cand.Set = .{};
    cand.enumerate(c, &inc, cand.REPAIR_V07, &set);
    if (set.incomplete) {
        util.unsupported = true;
        return;
    }
    var best: ?usize = null;
    for (set.slice(), 0..) |*k, i| {
        if (attacksForbidden(s, u, k.d.slice())) continue;
        if (k.kind != .melee and k.kind != .shot and k.kind != .throw) continue;
        if (!std.math.isFinite(k.ed) or k.ed <= 0) continue;
        if (best) |b| {
            const bb = &set.items[b];
            const km = util.has(&k.d, .move_unit);
            const bm = util.has(&bb.d, .move_unit);
            if (k.ek > bb.ek or (k.ek == bb.ek and (k.ed > bb.ed or (k.ed == bb.ed and bm and !km)))) best = i;
        } else best = i;
    }
    if (best) |b| return util.copyDecision(out, &set.items[b].d);
    for ([_]cand.Kind{ .spell, .move, .wait, .defend }) |kind| {
        for (set.slice()) |*k| {
            if (k.kind == kind and !attacksForbidden(s, u, k.d.slice())) return util.copyDecision(out, &k.d);
        }
    }
    util.setEndTurn(out, c.ui);
}

/// normalizeMeleeMagicSelection (melee_attack_type.ts): a MELEE_MAGIC-only stack's MELEE select becomes MELEE_MAGIC,
/// once.
fn normalizeMeleeMagicSelection(c: *ai.Ctx, out: *ai.Decision) void {
    const u = c.unit();
    if (engine.possibleIncludes(u, AT.MELEE) or !engine.possibleIncludes(u, AT.MELEE_MAGIC)) return;
    var any = false;
    for (out.slice()) |a| {
        if (a == .select_attack_type and a.select_attack_type.attack_type == AT.MELEE) any = true;
    }
    if (!any) return;
    var kept: [3]rec.Action = undefined;
    var n: u8 = 0;
    var selected = u.attack_type_selected;
    for (out.slice()) |a| {
        if (a != .select_attack_type) {
            kept[n] = a;
            n += 1;
            continue;
        }
        if (a.select_attack_type.attack_type != AT.MELEE) {
            kept[n] = a;
            n += 1;
            selected = a.select_attack_type.attack_type;
            continue;
        }
        if (selected != AT.MELEE_MAGIC) {
            kept[n] = .{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE_MAGIC } };
            n += 1;
            selected = AT.MELEE_MAGIC;
        }
    }
    for (kept[0..n], 0..) |a, i| out.actions[i] = a;
    out.n = n;
}
