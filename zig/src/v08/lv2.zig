//! The v0.2 level of the v0.8 chain (src/ai/versions/v0_2.ts StrategyV0_2.decideTurn) with v0.8's seams:
//! requireResolvedPrimaryRangeTarget is true (a plain shot names and aims at the stack it hits first, through an edge
//! the cursor can select), screen pressure is off (V08_VISIBLE_EDGE_SCREEN_PRESSURE unset), shots are scored by
//! v0.5's learned scoreShot and biased by v0.3's Beholder shotTargetBonus. Out of scope (no spells or abilities):
//! "No Melee", MAGIC casts, the Ogre Mage / Behemoth openers, the Griffin dive and aura moves.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const combat = @import("../combat.zig");
const pathing = @import("../path.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const weights = @import("weights.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
const AT = st.AttackType;
const W = weights.W;

/// A stack at or below this power retaliates for so little that dodging its counter is not worth a retarget.
const NEGLIGIBLE_COUNTER_STACK_POWER: f64 = 1;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const rin = s.rng.state;
    const ranged = u.attack_type == AT.RANGE;
    if (ranged and !engine.canLandRangeAttack(s, u)) {
        meleeFallback(c, out);
    } else if (ranged) {
        decideRangedTurn(c, out);
    } else {
        policy.v01(c, out);
        preferNoCounterMeleeTarget(c, out);
    }
    policy.note("v0.2", out, s, rin);
}

// =====================================================================================================================
// Ranged turn
// =====================================================================================================================

const Shot = struct { cell: Cell, side: u8, target: u8, score: f64 };

fn decideRangedTurn(c: *ai.Ctx, out: *ai.Decision) void {
    const best = findBestShot(c) orelse return policy.v01(c, out);
    out.* = .{};
    const u = c.unit();
    if (u.attack_type_selected != AT.RANGE) out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.RANGE } });
    out.push(.{ .range_attack = .{ .attacker = c.ui, .target = best.target, .aim_cell = best.cell, .aim_side = best.side } });
}

/// Every selectable edge of every enemy whose authoritative first hit is that enemy; the best scored shot wins
/// (first wins ties: enemies in holder order, their cells, sides LEFT, RIGHT, DOWN, UP).
fn findBestShot(c: *ai.Ctx) ?Shot {
    const s = c.s;
    const u = c.unit();
    const team = u.team;
    const opp = engine.opposite(team);
    const from = [2]f64{ u.pos_x, u.pos_y };
    const small = engine.isSmall(u);
    var best: ?Shot = null;
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (!util.livingOf(s, i, opp)) continue;
        const ei: u8 = @intCast(i);
        const to = [2]f64{ e.pos_x, e.pos_y };
        const e_small = engine.isSmall(e);
        const cells = engine.unitCells(e);
        for (cells.slice()) |cell| {
            for ([_]u8{ 0, 1, 2, 3 }) |side| {
                if (!combat.sideObservable(s, cell, side, team)) continue;
                if (!util.sideSelectable(s, cell, side, from, to, small, e_small, team)) continue;
                const aim = combat.sideCenter(cell, side, from[0], from[1]);
                const hits = combat.evaluateRange(s, c.ui, from[0], from[1], aim[0], aim[1]);
                if (hits.len == 0 or hits.units[0] != ei) continue;
                const value0 = scoreShot(c, &hits);
                if (value0 <= 0) continue;
                const value = value0 + shotTargetBonus(c, ei, value0);
                if (best == null or value > best.?.score) best = .{ .cell = cell, .side = side, .target = ei, .score = value };
            }
        }
    }
    return best;
}

/// firepowerOf (v0_5.ts): shots x max hit.
inline fn firepowerOf(u: *const Unit) f64 {
    return @max(1, engine.getRangeShots(u)) * @max(1, u.attack_damage_max);
}

/// StrategyV0_5.scoreShot: the learned shot scorer over every unit the shot's evaluation lists.
fn scoreShot(c: *const ai.Ctx, hits: *const combat.Hits) f64 {
    const s = c.s;
    const u = c.unit();
    const team = u.team;
    const opp = engine.opposite(team);
    const w_damage = W[0];
    const w_kill = W[1];
    const w_range = W[2];
    const w_firepower = W[3];
    const w_level = W[4];
    const w_friendly = W[5];
    const w_focus = W[53];
    const w_tempo = W[54];
    const w_wounded = W[55];
    // The shooter's living allies' footprints (for focus fire).
    var allies: [st.MAX_UNITS]engine.Cells = undefined;
    var n_allies: usize = 0;
    if (w_focus != 0) {
        for (s.units[0..s.n_units], 0..) |*a, i| {
            if (!util.livingOf(s, i, team) or i == c.ui) continue;
            allies[n_allies] = engine.unitCells(a);
            n_allies += 1;
        }
    }
    const shots: f64 = 1; // Double Shot: out of scope
    var value: f64 = 0;
    for (hits.units[0..hits.len], hits.divisors[0..hits.len]) |ti, divisor| {
        const t = &s.units[ti];
        const lo = util.damageMin(u, t, true, divisor);
        const hi = util.damageMax(u, t, true, divisor);
        const hp = util.cumulativeHp(t);
        const effective = @min((shots * (lo + hi)) / 2, hp);
        if (t.team == opp) {
            value += w_damage * effective;
            if (effective >= hp) value += w_kill * hp;
            if (t.attack_type == AT.RANGE) value += w_range * effective;
            value += w_firepower * (firepowerOf(t) / 1000);
            value += w_level * @as(f64, @floatFromInt(t.level));
            // getCanCastSpells: no spells in scope.
            if (w_focus != 0) {
                const tc = engine.unitCells(t);
                var adjacent: f64 = 0;
                for (allies[0..n_allies]) |*fp| {
                    if (util.footprintsNear(fp.slice(), tc.slice())) adjacent += 1;
                }
                value += w_focus * (adjacent / 2);
            }
            if (w_tempo != 0 and !util.madeTurn(s, ti)) value += w_tempo * (if (effective >= hp) 1 else effective / hp);
            if (w_wounded != 0) {
                const died = t.amount_died;
                const alive = t.amount_alive;
                value += w_wounded * (if (died + alive > 0) died / (died + alive) else 0);
            }
        } else if (t.team == team) {
            value -= w_friendly * effective;
        }
    }
    return value;
}

const BEHOLDER_FRESH_WEIGHT: f64 = 0.35;
const BEHOLDER_YET_TO_ACT_MULT: f64 = 1.8;
const BEHOLDER_THREAT_MULT: f64 = 1.3;
/// SPIT_BALL_DEBUFFS (Sadness, Quagmire, Weakening Beam, Weakness, Cowardice) and Rangebane: none exists in scope.
const SPIT_BALL_DEBUFFS: f64 = 5;

/// StrategyV0_3.shotTargetBonus: the Beholder's debuff-spreading bias.
fn shotTargetBonus(c: *const ai.Ctx, ei: u8, base: f64) f64 {
    if (util.creature(c.ui) != .beholder) return 0; // or "Spit Ball": abilities out of scope
    const s = c.s;
    const e = &s.units[ei];
    const targets_range = e.attack_type == AT.RANGE;
    const possible = SPIT_BALL_DEBUFFS + @as(f64, if (targets_range) 1 else 0);
    const fresh = possible; // no target carries any of them in scope
    var bonus = base * BEHOLDER_FRESH_WEIGHT * (fresh / possible);
    if (!util.madeTurn(s, ei)) bonus *= BEHOLDER_YET_TO_ACT_MULT;
    if (canThreatenThisTurn(c, ei)) bonus *= BEHOLDER_THREAT_MULT;
    return bonus;
}

fn canThreatenThisTurn(c: *const ai.Ctx, ei: u8) bool {
    const s = c.s;
    const e = &s.units[ei];
    if (e.attack_type == AT.RANGE) return engine.getRangeShots(e) > 0;
    const reach = engine.getSteps(e) + 1;
    const ec = engine.baseCell(e);
    for (s.units[0..s.n_units], 0..) |*a, i| {
        if (!util.livingOf(s, i, c.unit().team)) continue;
        if (ai.cellDistance(ec, engine.baseCell(a)) <= reach) return true;
    }
    return false;
}

// =====================================================================================================================
// A ranged unit that cannot land a shot
// =====================================================================================================================

fn meleeFallback(c: *ai.Ctx, out: *ai.Decision) void {
    out.* = .{};
    const u = c.unit();
    const ui = c.ui;
    const need_select = u.attack_type_selected != AT.MELEE;
    const select = rec.Action{ .select_attack_type = .{ .unit = ui, .attack_type = AT.MELEE } };
    // 1) An enemy already adjacent: strike in place.
    if (adjacentEnemy(c)) |t| {
        if (need_select) out.push(select);
        out.push(.{ .melee_attack = .{ .attacker = ui, .target = t, .attack_from = engine.baseCell(u), .path = &.{} } });
        return;
    }
    // 2) A reachable cell next to an enemy: move and strike.
    if (meleeApproach(c)) |ap| {
        if (need_select) out.push(select);
        const len = c.actualPath().routeCells(ap.route, &out.path);
        out.push(.{ .melee_attack = .{ .attacker = ui, .target = ap.target, .attack_from = ap.route.cell, .path = out.path[0..len], .has_lava = ap.route.has_lava } });
        return;
    }
    // 3) Advance (fallbackTurn holds the turn when the unit cannot move).
    ai.fallbackTurn(c, out);
    if (out.n == 1 and out.actions[0] == .end_turn) return;
    if (need_select) {
        std.debug.assert(out.n < out.actions.len);
        var j: usize = out.n;
        while (j > 0) : (j -= 1) out.actions[j] = out.actions[j - 1];
        out.actions[0] = select;
        out.n += 1;
    }
}

/// The first living enemy (holder order) whose footprint touches the unit's.
fn adjacentEnemy(c: *const ai.Ctx) ?u8 {
    const s = c.s;
    const u = c.unit();
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (!util.livingOf(s, i, opp)) continue;
        const ec = engine.unitCells(e);
        if (util.footprintsNear(ec.slice(), mine.slice())) return @intCast(i);
    }
    return null;
}

const Approach = struct { route: *const pathing.Route, target: u8 };

/// The shortest-route reachable stand cell whose footprint touches an enemy (first wins ties, knownPaths order),
/// with the first enemy it touches.
fn meleeApproach(c: *ai.Ctx) ?Approach {
    const s = c.s;
    const u = c.unit();
    const opp = engine.opposite(u.team);
    var any = false;
    for (0..s.n_units) |i| {
        if (util.livingOf(s, i, opp)) any = true;
    }
    if (!any) return null; // canMove() is true in scope
    const mp = c.actualPath();
    if (mp.size() == 0) return null;
    var best: ?Approach = null;
    var best_len: usize = 0;
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        const len = mp.routeCells(r, &buf);
        if (len == 0) continue;
        const fp = ai.footprintForAnchor(u, r.cell);
        for (s.units[0..s.n_units], 0..) |*e, i| {
            if (!util.livingOf(s, i, opp)) continue;
            const ec = engine.unitCells(e);
            if (util.footprintsNear(ec.slice(), fp.slice())) {
                if (best == null or len < best_len) {
                    best = .{ .route = r, .target = @intCast(i) };
                    best_len = len;
                }
                break;
            }
        }
    }
    return best;
}

// =====================================================================================================================
// preferNoCounterMeleeTarget
// =====================================================================================================================

/// Would striking this stack in melee provoke a counter worth dodging?
fn counterMatters(s: *const State, t: u8) bool {
    const u = &s.units[t];
    if (engine.getStackPower(u) <= NEGLIGIBLE_COUNTER_STACK_POWER) return false;
    if (util.repliedAttack(s, t)) return false;
    return util.canRespondMelee(u);
}

/// An in-place strike on a stack that would counter moves to the most threatening equally adjacent enemy that
/// would not (it already responded), never overriding a forced target or a move-and-strike.
fn preferNoCounterMeleeTarget(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.target >= 0) return;
    var idx: ?usize = null;
    for (out.slice(), 0..) |a, i| {
        if (a == .melee_attack) {
            idx = i;
            break;
        }
    }
    const i = idx orelse return;
    const strike = out.actions[i].melee_attack;
    const base = engine.baseCell(u);
    if (strike.path.len > 0 or strike.attack_from.x != base.x or strike.attack_from.y != base.y) return;
    const cur = strike.target;
    if (!s.units[cur].in_holder or !counterMatters(s, cur)) return;
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    var best: ?u8 = null;
    var best_threat: f64 = 0;
    for (s.units[0..s.n_units], 0..) |*e, k| {
        const ek: u8 = @intCast(k);
        if (!util.livingOf(s, k, opp) or ek == cur) continue;
        if (!(engine.getStackPower(e) > NEGLIGIBLE_COUNTER_STACK_POWER) or counterMatters(s, ek)) continue;
        const ec = engine.unitCells(e);
        if (!util.footprintsNear(ec.slice(), mine.slice())) continue;
        const t = ai.threat(e);
        if (best == null or t > best_threat) {
            best = ek;
            best_threat = t;
        }
    }
    const b = best orelse return;
    out.actions[i].melee_attack.target = b;
}
