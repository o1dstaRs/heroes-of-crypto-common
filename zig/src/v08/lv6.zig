//! The v0.6 level of the v0.8 chain (src/ai/versions/v0_6.ts StrategyV0_6.decideTurn) with v0.7's finalizeDecision:
//! the baked act-vs-wait scorer (wait_scorer.ts applyWaitScorerWeights with v07BakedWaitWeights, the 2026-08-26 2x1
//! refit). routeCasterDecision is v0.8's: MAGIC Summon Wolves; MELEE_MAGIC Resurrection, Wind Flow and Castling.
//! Identity in scope, so not ported: routeAreaThrow (Area Throw), routeMeleeRiderEV (V06_RIDER_EV off) and the kite
//! (V06_KITE off). The wait scorer's V2 and V3 variants are research-only and absent by default.

const std = @import("std");
const st = @import("../state.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const weights = @import("weights.zig");
const lv5 = @import("lv5.zig");
const cand = @import("cand.zig");
const engine = @import("../engine.zig");
const spells = @import("../spells.zig");

const AT = st.AttackType;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const rin = c.s.rng.state;
    defer policy.note("v0.6", out, c.s, rin);
    // setPreferAttackOverMining(V06_LEGACY_MINE !== "1") around super.decideTurn: mining never preempts an attack.
    c.prefer_attack_over_mining = true;
    lv5.decide(c, out);
    c.prefer_attack_over_mining = false;
    routeCaster(c, out);
    finalizeDecision(c, out);
}

/// routeCasterDecision as v0.8 bakes it (routeUniversalCasterWithPolicy with V08_CASTER_ROUTER_POLICY: Resurrection,
/// Wind Flow, Castling and Summon Wolves; Resurrection does not pre-empt a committed turn). A MAGIC caster replaces a
/// turn that does not commit (summonWolvesMayReplace: a cast other than Summon Wolves, or no wait, defend, attack or
/// cast) with the first Summon Wolves candidate of its uncapped list, read for spells only. A MELEE_MAGIC caster: see
/// routeMeleeMagicCaster.
fn routeCaster(c: *ai.Ctx, out: *ai.Decision) void {
    if (c.unit().attack_type == AT.MELEE_MAGIC) return routeMeleeMagicCaster(c, out);
    if (c.unit().attack_type != AT.MAGIC) return;
    const summon: u8 = @intFromEnum(st.CastSpell.summon_wolves);
    var cast: ?u8 = null;
    for (out.slice()) |a| if (a == .cast_spell) {
        cast = a.cast_spell.spell;
        break;
    };
    if (cast) |sp| {
        if (sp == summon) return;
    } else for (out.slice()) |a| switch (a) {
        .wait_turn, .defend_turn, .melee_attack, .range_attack, .area_throw_attack, .obstacle_attack => return,
        else => {},
    };
    var set: cand.Set = .{};
    cand.enumerate(c, out, .{ .spells_only = true }, &set);
    for (set.slice()) |*k| {
        if (k.kind == .spell and k.spell == summon) return util.copyDecision(out, &k.d);
    }
}

/// incumbentCommitsTurn (and incumbentCommitsTurnAgainstResurrection without the widened wait): a wait, defend,
/// attack, throw, obstacle strike or cast.
fn commitsTurn(out: *const ai.Decision) bool {
    for (out.slice()) |a| switch (a) {
        .wait_turn, .defend_turn, .melee_attack, .range_attack, .area_throw_attack, .obstacle_attack, .cast_spell => return true,
        else => {},
    };
    return false;
}

/// The MELEE_MAGIC branch of routeUniversalCasterWithPolicy, over the spell candidates of the unit's list in order: on a
/// turn that does not commit, the Resurrection with the largest positive surplus (resurrectionRecovery minus the
/// caster's own revive reserve when the cast burns its shared charge, first on ties), else the first Wind Flow when the
/// enemy flyers it would slow outweigh the allied ones (shouldCastWindFlow), else bestCastling.
fn routeMeleeMagicCaster(c: *ai.Ctx, out: *ai.Decision) void {
    if (commitsTurn(out)) return;
    const s = c.s;
    const u = c.unit();
    var set: cand.Set = .{};
    cand.enumerate(c, out, .{ .spells_only = true }, &set);
    const res: u8 = @intFromEnum(st.CastSpell.resurrection);
    // ownsResurrectionCharge: the Resurrection card in the unit's abilities (Break does not matter) and a charge left.
    var burns = false;
    if (u.ability_mask & st.AbilityId.resurrection.bit() != 0) {
        for (u.spells[0..u.n_spells]) |b| if (b.spell == res and b.amount > 0) {
            burns = true;
        };
    }
    var best: ?usize = null;
    var best_surplus: f64 = 0;
    for (set.slice(), 0..) |*k, i| {
        if (k.kind != .spell or k.spell != res or k.target < 0) continue;
        const t = &s.units[@intCast(k.target)];
        // resurrectionPassiveReserve at full weight
        const reserve = @floor((u.amount_alive + u.amount_died) / 2) * u.max_hp;
        const cost: f64 = if (burns) @ceil(reserve * 1) else 0;
        // resurrectionRecovery (no Holy Cross in the live pools): the power cap against the missing health
        const power = @floor((u.amount_alive * u.max_hp) * (1 * spells.moraleMultiplier(.resurrection, u.attack_multiplier)));
        const missing = t.amount_died * t.max_hp + @max(0, t.max_hp - t.hp);
        const surplus = @min(power, missing) - cost;
        if (surplus > best_surplus) {
            best = i;
            best_surplus = surplus;
        }
    }
    if (best) |i| return util.copyDecision(out, &set.items[i].d);
    const wind: u8 = @intFromEnum(st.CastSpell.wind_flow);
    for (set.slice()) |*k| {
        if (k.kind != .spell or k.spell != wind) continue;
        // The first Wind Flow only: when it is not worth casting, Castling is next.
        if (shouldCastWindFlow(s, u.team)) return util.copyDecision(out, &k.d);
        break;
    }
    if (bestCastling(c, set.slice())) |i| return util.copyDecision(out, &set.items[i].d);
}

/// bestCastling: with an ally (not the caster, alive) within Chebyshev 2 of the caster's base cell, the Castling onto a
/// RANGE or MAGIC enemy at least 2 cells ahead on the advance axis (x on a side-oriented board) worth most (cumulative HP
/// plus living creatures x max damage; the first on ties). Candidate legality (footprint, reach, Hidden) is cand.zig's.
fn bestCastling(c: *const ai.Ctx, set: []const cand.Candidate) ?usize {
    const s = c.s;
    const u = c.unit();
    const current = engine.baseCell(u);
    var support = false;
    for (s.holderOrder()) |i| {
        const a = &s.units[i];
        if (i == c.ui or a.team != u.team or !a.in_holder or a.isDead()) continue;
        for (engine.unitCells(a).slice()) |cell| {
            if (@max(@abs(cell.x - current.x), @abs(cell.y - current.y)) <= 2) support = true;
        }
        if (support) break;
    }
    if (!support) return null;
    const castling: u8 = @intFromEnum(st.CastSpell.castling);
    const side = s.fight.side_oriented;
    var best: ?usize = null;
    var best_value = -std.math.inf(f64);
    for (set, 0..) |*k, i| {
        if (k.kind != .spell or k.spell != castling or k.target < 0) continue;
        const t = &s.units[@intCast(k.target)];
        if (t.attack_type != AT.RANGE and t.attack_type != AT.MAGIC) continue;
        const to = engine.baseCell(t);
        const delta = if (side) to.x - current.x else to.y - current.y;
        const forward = if (u.team == st.Team.LEFT) delta else -delta;
        if (forward < 2) continue;
        const value = util.cumulativeHp(t) + t.amount_alive * t.attack_damage_max;
        if (value > best_value) {
            best = i;
            best_value = value;
        }
    }
    return best;
}

/// shouldCastWindFlow: the flying pressure (stacks x max damage x steps, each at least 1) of the enemies Wind Flow would
/// slow (alive, flying, magic resist below 100, not already under Wind Flow) exceeds the allied pressure (the caster
/// included).
fn shouldCastWindFlow(s: *const st.State, team: u8) bool {
    var enemy: f64 = 0;
    var allied: f64 = 0;
    for (s.holderOrder()) |i| {
        const o = &s.units[i];
        if (!o.in_holder or o.isDead() or !engine.canFly(o) or engine.getMagicResist(o) == 100) continue;
        if (o.buffs.len != 0 and o.buffs.find(.wind_flow) != null) continue;
        const pressure = @max(1, o.amount_alive) * @max(1, o.attack_damage_max) * @max(1, engine.getSteps(o));
        if (o.team == team) allied += pressure else enemy += pressure;
    }
    return enemy > allied;
}

/// StrategyV0_7.finalizeDecision: a cast is kept (the caster routing already compared it with combat), and so is the
/// decision of a meleeMagicAnchor army (2+ MELEE_MAGIC stacks at the start, no Resurrection or Wind Flow).
fn finalizeDecision(c: *ai.Ctx, out: *ai.Decision) void {
    const u = c.unit();
    if (util.has(out, .cast_spell)) return;
    if (util.battle.melee_magic[u.team] >= 2) return;
    applyWaitScorer(c, out);
}

/// waitScorerInSupport ("support" guard): a melee-class actor in a melee-majority army.
fn inSupport(c: *const ai.Ctx) bool {
    const s = c.s;
    const u = c.unit();
    const melee = struct {
        fn f(at: u8) bool {
            return at == AT.MELEE or at == AT.MELEE_MAGIC;
        }
    }.f;
    if (!melee(u.attack_type)) return false;
    var own: u32 = 0;
    var m: u32 = 0;
    for (s.holderOrder()) |o_slot| {
        const o = &s.units[o_slot];
        if (!o.in_holder or o.isDead() or o.team != u.team) continue;
        own += 1;
        if (melee(o.attack_type)) m += 1;
    }
    return m * 2 > own;
}

fn applyWaitScorer(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    if (util.has(out, .wait_turn)) return;
    if (!util.canHourglass(s, c.ui)) return;
    if (!inSupport(c)) return;
    var f: [util.WAIT_FEATURES]f64 = undefined;
    util.waitFeatures(s, c.ui, out.slice(), &f);
    var z = weights.WAIT_B;
    for (f, 0..) |x, i| z += weights.WAIT_W[i] * x;
    if (!std.math.isFinite(z) or z <= 0) return;
    util.setWait(out, c.ui);
}
