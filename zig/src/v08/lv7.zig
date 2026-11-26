//! The v0.7 level of the v0.8 chain (src/ai/versions/v0_7.ts StrategyV0_7.decideTurn): v0.6, then the melee-magic
//! stance fix. Not ported: the aura-saturated archetype anchor (decideV08 refuses such a seat), the Arachna Queen
//! assimilation router (no spells or Endless Quiver) and the Terrifying Gaze repair.

const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const ai = @import("../ai.zig");
const policy = @import("policy.zig");
const lv6 = @import("lv6.zig");

const AT = st.AttackType;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const rin = c.s.rng.state;
    defer policy.note("v0.7", out, c.s, rin);
    lv6.decide(c, out);
    normalizeMeleeMagicSelection(c, out);
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
