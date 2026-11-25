//! The v0.6 level of the v0.8 chain (src/ai/versions/v0_6.ts StrategyV0_6.decideTurn) with v0.7's finalizeDecision:
//! the baked act-vs-wait scorer (wait_scorer.ts applyWaitScorerWeights with v07BakedWaitWeights, the 2026-08-26 2x1
//! refit). Identity in scope, so not ported: routeCasterDecision (v0.8's router finds no spell candidate),
//! routeAreaThrow (Area Throw), routeMeleeRiderEV (V06_RIDER_EV off) and the kite (V06_KITE off). The wait scorer's
//! V2 and V3 variants are research-only and absent by default.

const std = @import("std");
const st = @import("../state.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const weights = @import("weights.zig");
const lv5 = @import("lv5.zig");

const AT = st.AttackType;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const rin = c.s.rng.state;
    defer policy.note("v0.6", out, c.s, rin);
    lv5.decide(c, out);
    finalizeDecision(c, out);
}

/// StrategyV0_7.finalizeDecision. No casts in scope; a meleeMagicAnchor army (2+ MELEE_MAGIC stacks at the start, no
/// Resurrection or Wind Flow) keeps v0.6's decision.
fn finalizeDecision(c: *ai.Ctx, out: *ai.Decision) void {
    const u = c.unit();
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
    for (s.units[0..s.n_units]) |*o| {
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
