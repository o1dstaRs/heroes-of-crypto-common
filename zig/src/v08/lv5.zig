//! The v0.5 level of the v0.8 chain (src/ai/versions/v0_5.ts StrategyV0_5.decideTurn), default environment, with
//! v0.8's learned weight vector (weights.zig: v0.6's weights with v0.8's melee dims).
//!
//! In scope (no spells; the abilities of batches 1-3) the pipeline is: v0.4, the learned mountain mining
//! (mineByPolicy, BLOCK_CENTER), the learned melee re-rank (meleeByPolicy), the learned AoE stand (aoeMeleeByPolicy:
//! Lightning Spin, Skewer Strike), the learned move re-rank (repositionByPolicy), the aura flyer's support
//! (auraFlyerSupport), the charge hourglass (hourglassByPolicy), the blocked-move guard (dropBlockedMove) and the free
//! adjacent attack (takeAdjacentAttack), with the healer policy, the No Melee retreat, the Hidden-target guard and the
//! Cowardice move-prefix repair. Identity in scope, so not ported: meleeAuraSupport (V05_AURASUPPORT off) and the Fire
//! Wall half of repairUnavailableMovePrefixedAttack (wave 2). Zero-weight or always-zero score terms (War Anger, target caster, Rapid Charge (weight 0),
//! bait, Armageddon) add exactly 0.

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
const spells = @import("../spells.zig");

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
    healerPolicy(c, out);
    noMeleeRetreat(c, out);
    mineByPolicy(c, out);
    meleeByPolicy(c, out);
    aoeMeleeByPolicy(c, out);
    repositionByPolicy(c, out);
    excludeHiddenAttack(c, out);
    auraFlyerSupport(c, out);
    hourglassByPolicy(c, out);
    dropBlockedMove(c, out);
    takeAdjacentAttack(c, out);
    repairMovePrefixedAttack(c, out);
}

/// noMeleeRetreat: a No Melee shooter that can move but cannot land a shot, on a turn with no combat action but a melee
/// (a melee whose Double-Punch-scaled top hit kills the target stays), retreats to the reachable cell (a non-empty
/// route, not its own cell) where its footprint touches no enemy, farthest (Manhattan to the nearest enemy base) from
/// the enemies; first wins ties. An ordinary shooter's disengage never moves (its score starts at +Infinity).
fn noMeleeRetreat(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.attack_type != AT.RANGE or !u.canMove()) return;
    if (engine.canLandRangeAttack(s, u)) return;
    if (!u.has(.no_melee)) return;
    var melee: ?u8 = null;
    for (out.slice()) |a| switch (a) {
        .range_attack, .cast_spell, .obstacle_attack, .area_throw_attack => return,
        .melee_attack => |m| {
            if (melee == null) melee = m.target;
        },
        else => {},
    };
    if (melee) |t| {
        const tgt = &s.units[t];
        if (tgt.in_holder and util.meleeAttacks(u) * util.damageMax(u, tgt, false, 1) >= util.cumulativeHp(tgt)) return;
    }
    const opp = engine.opposite(u.team);
    var any = false;
    for (s.holderOrder()) |k| {
        if (util.livingOf(s, k, opp)) any = true;
    }
    if (!any) return;
    const mp = c.actualPath();
    if (mp.size() == 0) return;
    const base = engine.baseCell(u);
    var best: ?*const pathing.Route = null;
    var best_score = -std.math.inf(f64);
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0 or (r.cell.x == base.x and r.cell.y == base.y)) continue;
        const fp = ai.footprintForAnchor(u, r.cell);
        var pinned = false;
        var dist = std.math.inf(f64);
        for (s.holderOrder()) |k| {
            if (!util.livingOf(s, k, opp)) continue;
            const e = &s.units[k];
            if (util.footprintsNear(engine.unitCells(e).slice(), fp.slice())) pinned = true;
            const eb = engine.baseCell(e);
            dist = @min(dist, @as(f64, @floatFromInt(@abs(r.cell.x - eb.x) + @abs(r.cell.y - eb.y))));
        }
        if (pinned) continue;
        if (dist > best_score) {
            best_score = dist;
            best = r;
        }
    }
    const b = best orelse return;
    util.setMove(out, s, c.ui, mp, b);
}

/// excludeHiddenAttack: a strike or shot on a Hidden stack becomes, for a melee, an in-place strike on the first
/// enemy (getAllAllies order) that is alive, not Hidden, not Cowardice-barred and adjacent now; otherwise the strike
/// is dropped, keeping the rest of the turn when it moves, else ending the turn.
fn excludeHiddenAttack(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    var idx: ?usize = null;
    for (out.slice(), 0..) |a, i| {
        if (a == .melee_attack or a == .range_attack) {
            idx = i;
            break;
        }
    }
    const i = idx orelse return;
    const a = out.actions[i];
    const target: u8 = if (a == .melee_attack) a.melee_attack.target else a.range_attack.target;
    if (a == .range_attack and a.range_attack.free) return; // a free line names no stack
    const t = &s.units[target];
    if (!t.in_holder or !t.isHidden()) return;
    if (a == .melee_attack) {
        const mine = engine.unitCells(u);
        const opp = engine.opposite(u.team);
        for (s.holderOrder()) |k| {
            const e = &s.units[k];
            if (!e.in_holder or e.team != opp or e.isDead() or e.isHidden() or engine.cowardBarred(s, u, e)) continue;
            if (!util.footprintsNear(engine.unitCells(e).slice(), mine.slice())) continue;
            out.* = .{};
            if (u.attack_type_selected != AT.MELEE) out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
            out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = k, .attack_from = engine.baseCell(u), .path = &.{} } });
            return;
        }
    }
    var rest: ai.Decision = .{};
    var moves = false;
    for (out.slice(), 0..) |x, j| {
        if (j == i or x == .select_attack_type) continue;
        if (x == .move_unit) moves = true;
        rest.push(x);
    }
    if (moves) return util.copyDecision(out, &rest);
    util.setEndTurn(out, c.ui);
}

/// repairUnavailableMovePrefixedAttack (no Fire Wall in scope): a move followed by the unit's melee on a stack with
/// more cumulative HP while the unit carries Cowardice keeps only the actions up to the move.
fn repairMovePrefixedAttack(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    var move_idx: ?usize = null;
    for (out.slice(), 0..) |a, i| {
        if (a == .move_unit and a.move_unit.unit == c.ui) {
            move_idx = i;
            break;
        }
    }
    const mi = move_idx orelse return;
    var dependent = false;
    for (out.slice()[mi + 1 ..]) |a| switch (a) {
        .melee_attack => |m| if (m.attacker == c.ui) {
            dependent = true;
        },
        .range_attack => |r| if (r.attacker == c.ui) {
            dependent = true;
        },
        else => {},
    };
    if (!dependent or !engine.cowardly(s, u)) return;
    const hp = util.cumulativeHp(u);
    var blocked = false;
    for (out.slice()[mi + 1 ..]) |a| switch (a) {
        .melee_attack => |m| if (m.attacker == c.ui) {
            const t = &s.units[m.target];
            if (t.in_holder and !t.isDead() and hp < util.cumulativeHp(t)) blocked = true;
        },
        else => {},
    };
    if (blocked) out.n = @intCast(mi + 1);
}

/// Slots with a sort key, ordered by the key descending, stably (JavaScript's sort with `(p, q) => key(q) - key(p)`).
const Ranked = struct {
    slot: [st.MAX_UNITS]u8 = undefined,
    key: [st.MAX_UNITS]f64 = undefined,
    n: usize = 0,

    fn add(self: *Ranked, slot: u8, key: f64) void {
        var i = self.n;
        // insert after every entry whose key is not smaller (stable descending)
        while (i > 0 and self.key[i - 1] < key) : (i -= 1) {
            self.slot[i] = self.slot[i - 1];
            self.key[i] = self.key[i - 1];
        }
        self.slot[i] = slot;
        self.key[i] = key;
        self.n += 1;
    }
};

/// healerPolicy, V05_HEALPOLICY "smart" (the default): a Healer with stack power 1 or more (1) heals the living level-4
/// ally down more than 20% whose top creature is hurt (magic resist below 100), the most wounded it can heal; else (2)
/// keeps an inherited Heal; else (3) blesses the living ranged ally (not itself) with shots left, no Blessing and a
/// relative damage spread of at least 0.33, the biggest gain (spread x alive x shots) it can bless. Mass Heal and
/// Spiritual Armor are not in scope.
fn healerPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (util.creature(s, c.ui) != .healer or engine.getStackPower(u) < 1) return;
    if (lv4.usableSpell(s, u, .heal)) |cfg| {
        var r: Ranked = .{};
        for (s.holderOrder()) |k| {
            const a = &s.units[k];
            if (!util.livingOf(s, k, u.team)) continue;
            if (engine.getMagicResist(a) == 100 or !(a.hp < a.max_hp) or a.level < 4) continue;
            const lost = lv4.woundFraction(a);
            if (lost > 0.2) r.add(k, lost);
        }
        for (r.slot[0..r.n]) |t| {
            if (!spells.canCastSpell(s, c.ui, t, .heal, cfg)) continue;
            out.* = .{};
            out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = @intFromEnum(st.CastSpell.heal), .target = t, .has_target = true } });
            return;
        }
    }
    for (out.slice()) |a| {
        if (a == .cast_spell) {
            if (a.cast_spell.spell == @intFromEnum(st.CastSpell.heal)) return;
            break;
        }
    }
    const cfg = lv4.usableSpell(s, u, .blessing) orelse return;
    var r: Ranked = .{};
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (!util.livingOf(s, k, u.team) or k == c.ui) continue;
        if (a.attack_type != AT.RANGE or !(engine.getRangeShots(a) > 0) or a.buffs.find(.blessing) != null) continue;
        const mx = a.attack_damage_max;
        const rel: f64 = if (mx > 0) (mx - a.attack_damage_min) / mx else 0;
        if (!(rel >= 0.33)) continue;
        r.add(k, (a.attack_damage_max - a.attack_damage_min) * @max(1, a.amount_alive) * @max(1, engine.getRangeShots(a)));
    }
    for (r.slot[0..r.n]) |t| {
        if (!spells.canCastSpell(s, c.ui, t, .blessing, cfg)) continue;
        out.* = .{};
        out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = @intFromEnum(st.CastSpell.blessing), .target = t, .has_target = true } });
        return;
    }
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
// mineByPolicy
// =====================================================================================================================

const MAX_HITS_MOUNTAIN: f64 = 5;

/// Learned center-mountain mining (BLOCK_CENTER): an otherwise pure advance strikes the mountain instead when the
/// learned score over (in place, closeness, grouping, out-ranging, lane blocked, progress) is positive.
fn mineByPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.attack_type == AT.RANGE or !u.canMove()) return;
    if (u.target >= 0) {
        const f = &s.units[@intCast(u.target)];
        if (f.in_holder and !f.isDead()) return;
    }
    const hits: f64 = @floatFromInt(ai.mountainHitsLeft(s));
    if (hits <= 0) return;
    if (!util.has(out, .move_unit) or util.combatAction(out)) return;
    const strike = ai.findMountainMeleeStrike(c) orelse return;
    const base = engine.baseCell(u);
    const in_place = ai.sameCell(strike.from, base);
    const mp = c.actualPath();
    const route = mp.get(pathing.key(strike.from.x, strike.from.y));
    const move_cost: f64 = if (in_place) 0 else if (route) |r| r.weight else engine.getSteps(u);
    const f_close = @max(0, 1 - move_cost / @max(1, engine.getSteps(u)));
    const eng = ai.analyzeEngagement(c);
    const f_group = @max(0, 1 - eng.nearest_melee / 10);
    const opp = engine.opposite(u.team);
    const f_out_range = std.math.sign(ai.teamRangedFirepower(s, u.team) - ai.teamRangedFirepower(s, opp));
    const f_progress = (MAX_HITS_MOUNTAIN - hits) / MAX_HITS_MOUNTAIN;
    var nearest: ?Cell = null;
    var nearest_d = std.math.inf(f64);
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        const ec = engine.baseCell(e);
        const d = ai.cellDistance(base, ec);
        if (d < nearest_d) {
            nearest_d = d;
            nearest = ec;
        }
    }
    const f_lane: f64 = if (nearest) |n| (if (ai.lineBlockedByObstacle(&c.m, base, n)) 1 else 0) else 0;
    const score = W[26] + W[27] * @as(f64, if (in_place) 1 else 0) + W[28] * f_close + W[29] * f_group +
        W[30] * f_out_range + W[31] * f_lane + W[32] * f_progress;
    if (score <= 0) return;
    const target = engine.positionForCell(@floatFromInt(strike.target.x), @floatFromInt(strike.target.y));
    out.* = .{};
    var len: usize = 0;
    var lava = false;
    if (!in_place) {
        const r = route orelse return;
        len = mp.routeCells(r, &out.path);
        if (len == 0) return;
        lava = r.has_lava;
    }
    out.push(.{ .obstacle_attack = .{ .attacker = c.ui, .target_x = target[0], .target_y = target[1], .attack_from = strike.from, .path = out.path[0..len], .has_lava = lava } });
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
    // Multi-hit melee is positioned for coverage by v0.4 and aoeMeleeByPolicy (Fire Breath and Chain Lightning are not
    // in scope).
    if (u.has(.lightning_spin) or u.has(.skewer_strike)) return;
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
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (util.livingOf(s, i, team) and i != c.ui) {
            allies[n_allies] = engine.unitCells(a);
            n_allies += 1;
        } else if (util.livingOf(s, i, opp) and !a.isHidden()) {
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
        ui: u8,
        atk_mul: f64,

        fn score(self: *const @This(), target: u8, target_cells: []const Cell, cell: Cell, fp: []const Cell) f64 {
            const t = &self.s.units[target];
            const lo = self.atk_mul * util.damageMin(self.u, t, false, 1);
            const hi = self.atk_mul * util.damageMax(self.u, t, false, 1);
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
            // Punish-melee: a Dulling Defense knight that will answer this blow costs permanent attack (Fire Shield is
            // not in scope). His own swing permanently cuts a survivor's base attack.
            const knight_answers = t.has(.dulling_defense) and util.canRespondToMelee(self.s, self.ui, target);
            const punish: f64 = if (!killed and knight_answers) 1 else 0;
            const dulling: f64 = if (!killed and self.u.has(.dulling_defense) and t.base_attack > 1) 1 else 0;
            // Target-caster: enemy spellcasters (getCanCastSpells: a spellbook) are force multipliers.
            const target_caster: f64 = if (t.canCastSpells()) 1 else 0;
            return W[14] * dmg + W[15] * kill + W[16] * retal_free + W[17] * threat + W[18] * stand_threat +
                W[19] * incumbent + W[20] * counter + W[21] * focus_fire + W[22] * stand_support +
                W[23] * target_wounded + W[25] * counter * self.fm + W[50] * punish + W[51] * target_caster +
                W[57] * target_ranged + DULLING_OWN_SWING_SCORE * dulling;
        }
    };
    const scorer = Scorer{ .s = s, .u = u, .m = &c.m, .opp = opp, .allies = allies[0..n_allies], .my_hp = my_hp, .fm = fm, .v4target = v4target, .v4from = v4from, .ui = c.ui, .atk_mul = util.meleeAttacks(u) };

    const Best = struct { target: u8, cell: Cell, route: ?*const pathing.Route, score: f64 };
    var best: ?Best = null;
    const Consider = struct {
        fn f(b: *?Best, target: u8, cell: Cell, route: ?*const pathing.Route, value: f64) void {
            if (b.* == null or value > b.*.?.score) b.* = .{ .target = target, .cell = cell, .route = route, .score = value };
        }
    };
    // The anchor: v0.4's own (target, stand cell).
    const vt = &s.units[v4target];
    if (vt.in_holder and !vt.isDead() and !vt.isHidden()) {
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
    // Move-and-strike, when the unit can move (no Fire Wall, so moving cannot kill the actor).
    const mp = c.actualPath();
    var buf: [64]Cell = undefined;
    const routes = if (u.canMove()) mp.known() else mp.known()[0..0];
    for (routes) |*r| {
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
            out.push(.{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..fp.len], .has_lava = r.has_lava } });
        }
    }
    out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = b.target, .attack_from = b.cell, .path = &.{} } });
}

// =====================================================================================================================
// AoE melee: aoeMeleeByPolicy and the hourglass's meleeAoeHitCount (Lightning Spin and Skewer Strike; Fire Breath and
// Chain Lightning are not in scope)
// =====================================================================================================================

/// A landed melee by a Dulling Defense unit permanently cuts a survivor's base attack (DULLING_OWN_SWING_SCORE).
const DULLING_OWN_SWING_SCORE: f64 = 0.7;

fn livingEnemies(s: *const State, team: u8, buf: *[st.MAX_UNITS]u8) []const u8 {
    const opp = engine.opposite(team);
    var n: usize = 0;
    for (s.holderOrder()) |k| {
        if (!util.livingOf(s, k, opp)) continue;
        buf[n] = k;
        n += 1;
    }
    return buf[0..n];
}

/// The enemies next to the unit's footprint at `cell`, in order.
fn ringAt(c: *ai.Ctx, enemies: []const u8, cell: Cell, buf: *[st.MAX_UNITS]u8) []const u8 {
    const s = c.s;
    const fp = ai.footprintForAnchor(c.unit(), cell);
    var n: usize = 0;
    for (enemies) |e| {
        const ec = engine.unitCells(&s.units[e]);
        if (!util.footprintsNear(ec.slice(), fp.slice())) continue;
        buf[n] = e;
        n += 1;
    }
    return buf[0..n];
}

/// A Skewer Strike line from `from` through `t`: the target, then the living enemy stack on the cell beyond its base cell.
fn skewerLine(s: *const State, opp: u8, from: Cell, t: u8, buf: *[2]u8) []const u8 {
    const tc = engine.baseCell(&s.units[t]);
    buf[0] = t;
    var n: usize = 1;
    const beyond = Cell{ .x = tc.x + std.math.sign(tc.x - from.x), .y = tc.y + std.math.sign(tc.y - from.y) };
    if (beyond.x >= 0 and beyond.y >= 0) {
        if (ai.occupant(s, beyond)) |o| {
            if (o != t and !s.units[o].isDead() and s.units[o].team == opp) {
                buf[1] = o;
                n = 2;
            }
        }
    }
    return buf[0..n];
}

/// meleeAoeHitCount: the enemy stacks the decision's strike catches (the Lightning Spin ring at its stand cell, or the
/// Skewer line through its target); 1 for any other strike, 0 without one.
fn meleeAoeHitCount(c: *ai.Ctx, out: *const ai.Decision) usize {
    const s = c.s;
    const u = c.unit();
    const si = firstIndex(out, .melee_attack) orelse return 0;
    const strike = out.actions[si].melee_attack;
    var ebuf: [st.MAX_UNITS]u8 = undefined;
    const enemies = livingEnemies(s, u.team, &ebuf);
    if (u.has(.lightning_spin)) {
        var rbuf: [st.MAX_UNITS]u8 = undefined;
        return ringAt(c, enemies, strike.attack_from, &rbuf).len;
    }
    const opp = engine.opposite(u.team);
    const t = &s.units[strike.target];
    if (!t.in_holder or t.isDead() or t.team != opp) return 0;
    if (u.has(.skewer_strike)) {
        var lbuf: [2]u8 = undefined;
        return skewerLine(s, opp, strike.attack_from, strike.target, &lbuf).len;
    }
    return 1;
}

fn routeLen(mp: *const pathing.MovePath, r: *const pathing.Route) usize {
    var len: usize = 0;
    var cur: ?*const pathing.Route = r;
    while (cur) |x| {
        len += 1;
        cur = if (x.parent < 0) null else &mp.routes[@intCast(x.parent)];
    }
    return len;
}

/// aoeMeleeByPolicy: the learned AoE stand. Every stand (in place, then each landable known route) with, for the spin
/// [33..40], its first adjacent enemy and the whole ring, or, for the skewer [41..48], each adjacent enemy and its
/// line, scored over the hit set (coverage, value, kills, threat, exposure, move cost, wounds, incumbency); the best
/// (first on ties) replaces v0.4's strike unless it is v0.4's own pick. The trained blocks are never dormant.
fn aoeMeleeByPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const spin = u.has(.lightning_spin);
    if (!spin and !u.has(.skewer_strike)) return;
    const off: usize = if (spin) 33 else 41;
    const si = firstIndex(out, .melee_attack) orelse return;
    if (u.target >= 0 or !u.canMove()) return;
    const strike = out.actions[si].melee_attack;
    var ebuf: [st.MAX_UNITS]u8 = undefined;
    const enemies = livingEnemies(s, u.team, &ebuf);
    if (enemies.len == 0) return;
    const opp = engine.opposite(u.team);
    const bc = engine.baseCell(u);
    const v4from = strike.attack_from;
    const v4target = strike.target;
    const dmg_max = @max(1, u.attack_damage_max);
    const steps = @max(1, engine.getSteps(u));
    const mp = c.actualPath();

    const Best = struct { cell: Cell, route: ?*const pathing.Route, target: u8, score: f64 };
    var best: ?Best = null;
    const Score = struct {
        fn of(st_: *const State, m: *const pathing.Matrix, o: u8, w: []const f64, hits: []const u8, cell: Cell, cost: f64, inc: f64, dmax: f64) f64 {
            var val: f64 = 0;
            var kills: f64 = 0;
            var threat: f64 = 0;
            var wound: f64 = 0;
            for (hits) |h| {
                const e = &st_.units[h];
                const hp = util.cumulativeHp(e);
                val += @min(dmax, hp) / @max(1, e.max_hp);
                if (dmax >= hp) kills += 1;
                threat += firepowerOf(e) / 1000;
                const total = @max(1, e.amount_alive + e.amount_died);
                wound += 1 - e.amount_alive / total;
            }
            const expo = @as(f64, @floatFromInt(ai.countThreats(m, cell, o))) / 3;
            const cov: f64 = @floatFromInt(hits.len);
            return w[0] * cov + w[1] * val + w[2] * kills + w[3] * threat + w[4] * expo + w[5] * cost + w[6] * wound + w[7] * inc;
        }
    };
    const w = W[off .. off + 8];
    var k: usize = 0;
    const known = mp.known();
    while (k <= known.len) : (k += 1) {
        // Stand k: 0 is in place; k >= 1 is known route k-1, when landable.
        const route: ?*const pathing.Route = if (k == 0) null else &known[k - 1];
        const cell = if (route) |r| r.cell else bc;
        if (route) |r| {
            if (routeLen(mp, r) == 0 or !ai.canLandAt(s, c.ui, r.cell)) continue;
        }
        const cost: f64 = if (route) |r| @max(0, 1 - @as(f64, @floatFromInt(routeLen(mp, r))) / steps) else 1;
        var rbuf: [st.MAX_UNITS]u8 = undefined;
        if (spin) {
            const ring = ringAt(c, enemies, cell, &rbuf);
            if (ring.len == 0) continue; // the primary is the first of the ring (no Cowardice in scope)
            const inc: f64 = if (ai.sameCell(cell, v4from)) 1 else 0;
            const v = Score.of(s, &c.m, opp, w, ring, cell, cost, inc, dmg_max);
            if (best == null or v > best.?.score) best = .{ .cell = cell, .route = route, .target = ring[0], .score = v };
            continue;
        }
        const ring = ringAt(c, enemies, cell, &rbuf);
        for (ring) |e| {
            var lbuf: [2]u8 = undefined;
            const line = skewerLine(s, opp, cell, e, &lbuf);
            const inc: f64 = if (ai.sameCell(cell, v4from) and e == v4target) 1 else 0;
            const v = Score.of(s, &c.m, opp, w, line, cell, cost, inc, dmg_max);
            if (best == null or v > best.?.score) best = .{ .cell = cell, .route = route, .target = e, .score = v };
        }
    }
    const b = best orelse return;
    if (ai.sameCell(b.cell, v4from) and (spin or b.target == v4target)) return;
    var d: ai.Decision = .{};
    if (u.attack_type_selected != AT.MELEE) d.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
    var len: usize = 0;
    var lava = false;
    if (b.route) |r| {
        lava = r.has_lava;
        if (!ai.sameCell(b.cell, bc)) len = mp.routeCells(r, &d.path);
    }
    d.push(.{ .melee_attack = .{ .attacker = c.ui, .target = b.target, .attack_from = b.cell, .path = d.path[0..len], .has_lava = lava } });
    util.copyDecision(out, &d);
}

// =====================================================================================================================
// auraFlyerSupport
// =====================================================================================================================

/// auraFlyerSupport (V05_AURAFLY, on): an aura-emitting flyer's marginal melee strike (not a sure kill by its minimum
/// damage, not a retaliation-free hit) becomes support while its aura covers anyone: the reachable cell covering more
/// targets (v0.6's relevance weight), else a hold (hourglass, else stay).
fn auraFlyerSupport(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (!engine.canFly(u) or u.auraCount() == 0) return;
    const si = firstIndex(out, .melee_attack) orelse return;
    const strike = out.actions[si].melee_attack;
    const t = &s.units[strike.target];
    if (!t.in_holder) return;
    const kill = util.meleeAttacks(u) * util.damageMin(u, t, false, 1) >= util.cumulativeHp(t);
    if (kill or util.repliedAttack(s, strike.target)) return;
    const base = engine.baseCell(u);
    if (util.auraCoverageScore(s, c.ui, base, .relevance) < 1) return;
    if (util.planAuraMove(c, .relevance)) |plan| {
        if (plan.best_score > plan.current and u.canMove() and !ai.sameCell(plan.best, base)) {
            const mp = c.actualPath();
            if (mp.get(pathing.key(plan.best.x, plan.best.y))) |r| {
                return util.setMove(out, s, c.ui, mp, r);
            }
        }
    }
    if (util.canHourglass(s, c.ui)) util.setWait(out, c.ui) else util.setEndTurn(out, c.ui);
}

// =====================================================================================================================
// repositionByPolicy
// =====================================================================================================================

/// Stage-2 learned positioning: a pure move's destination is re-picked among the reachable cells by the learned score.
fn repositionByPolicy(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const mi = firstIndex(out, .move_unit) orelse return;
    if (util.combatAction(out)) return;
    const team = u.team;
    const opp = engine.opposite(team);
    var enemies: [st.MAX_UNITS]Cell = undefined;
    var n_enemies: usize = 0;
    var n_allies: f64 = 0;
    var sum_x: f64 = 0;
    var sum_y: f64 = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
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
        const hazard: f64 = if (r.has_lava) 1 else 0;
        const incumbent: f64 = if (ai.sameCell(cell, dest)) 1 else 0;
        const threat = @as(f64, @floatFromInt(ai.countThreats(&c.m, cell, opp))) / 3;
        const aggr_zone: f64 = if (r.first_aggr_met) 1 else 0;
        const shoot_ready: f64 = if (shooter and ed >= 2 and ed <= shot_dist) 1 else 0;
        // Aura emitters cover more allies (auraCoverageScore, default flat weight).
        const aura = util.auraCoverageScore(s, c.ui, cell, .flat) / 4;
        const value = W[6] * advance + W[7] * cohesion + W[8] * hazard + W[9] * incumbent + W[10] * threat + W[11] * aggr_zone +
            W[12] * shoot_ready + W[13] * aura + W[24] * advance * fm;
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
    // A multi-stack AoE line or ring is a transient opportunity: keep it.
    if (meleeAoeHitCount(c, out) >= 2) return;
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
    if (util.combatAction(out)) return;
    const mi = firstIndex(out, .move_unit);
    var pure_move = false;
    var path: []const Cell = &.{};
    var lava = false;
    if (mi) |i| {
        path = out.actions[i].move_unit.path;
        lava = out.actions[i].move_unit.has_lava;
        pure_move = path.len > 0;
    }
    const idle_end = mi == null and util.has(out, .end_turn) and !u.isStunned(); // isSkippingThisTurn (Stun)
    if (!pure_move and !idle_end) return;
    const base = engine.baseCell(u);
    const dest = if (pure_move) path[path.len - 1] else base;
    const dest_fp = if (pure_move) ai.footprintForAnchor(u, dest) else engine.unitCells(u);
    const opp = engine.opposite(u.team);
    var best: ?u8 = null;
    var best_kill = false;
    var best_fire: f64 = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        if (e.isHidden() or u.cannotAttack(e.uid)) continue; // Hidden, or the Terrifying Gaze gazer
        if (u.target >= 0 and u.target != @as(i8, @intCast(i))) continue;
        const ec = engine.unitCells(e);
        if (!util.footprintsNear(ec.slice(), dest_fp.slice())) continue;
        const kill = util.meleeAttacks(u) * util.damageMax(u, e, false, 1) >= util.cumulativeHp(e);
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
    out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = t, .attack_from = dest, .path = if (pure_move) path else &.{}, .has_lava = pure_move and lava } });
}
