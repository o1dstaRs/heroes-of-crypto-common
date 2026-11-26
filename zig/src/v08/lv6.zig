//! The v0.6 level of the v0.8 chain (src/ai/versions/v0_6.ts StrategyV0_6.decideTurn) with v0.7's finalizeDecision:
//! the baked act-vs-wait scorer (wait_scorer.ts applyWaitScorerWeights with v07BakedWaitWeights, the 2026-08-26 2x1
//! refit). routeCasterDecision is v0.8's (its Summon Wolves rule; the MELEE_MAGIC spells it routes are not in scope).
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
/// cast) with the first Summon Wolves candidate of its uncapped list, read for spells only. A MELEE_MAGIC caster's
/// routed spells (Resurrection, Wind Flow, Castling) are not in scope, so its decision stands.
fn routeCaster(c: *ai.Ctx, out: *ai.Decision) void {
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
        .wait_turn, .defend_turn, .melee_attack, .range_attack, .obstacle_attack => return,
        else => {},
    };
    var set: cand.Set = .{};
    cand.enumerate(c, out, .{ .spells_only = true }, &set);
    for (set.slice()) |*k| {
        if (k.kind == .spell and k.spell == summon) return util.copyDecision(out, &k.d);
    }
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
