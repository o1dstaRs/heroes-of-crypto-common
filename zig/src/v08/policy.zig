//! The v0.8 policy (src/ai/versions/v0_8.ts StrategyV0_8.decideTurn), flattened: the inheritance chain v0.1 ... v0.7
//! with v0.8's overrides baked in, then v0.8's passes. Only the code v0.8 runs is ported (owner scope, 2026-11-25:
//! v0.1 and v0.8 only). Each level reports its output to an optional layer hook, which the layer check compares
//! with the recorder's layer log (zig/parity/v08/layers.ts) inside real v0.8 battles.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const ai = @import("../ai.zig");
const lv2 = @import("lv2.zig");
const lv3 = @import("lv3.zig");
const lv4 = @import("lv4.zig");
const lv5 = @import("lv5.zig");
const lv6 = @import("lv6.zig");
const lv7 = @import("lv7.zig");
const lv8 = @import("lv8.zig");

/// Observes each level's output: its name (the recorder's layer names: "v0.1" ... "v0.7", then the v0.8 passes),
/// its actions and the random state on entry and return.
pub const LayerHook = struct {
    ctx: *anyopaque,
    f: *const fn (ctx: *anyopaque, name: []const u8, actions: []const rec.Action, rin: u32, rout: u32) void,
};

pub threadlocal var hook: ?LayerHook = null;

pub inline fn note(name: []const u8, out: *const ai.Decision, s: *const st.State, rin: u32) void {
    if (hook) |h| h.f(h.ctx, name, out.slice(), rin, s.rng.state);
}

/// The top of the chain a run stops at (`hoc-sim v08 layers --top`), for checking a partial port.
pub const Level = enum { v01, v02, v03, v04, v05, v06, v07, v08 };

pub fn levelFromName(n: []const u8) ?Level {
    if (std.mem.eql(u8, n, "v0.1")) return .v01;
    if (std.mem.eql(u8, n, "v0.2")) return .v02;
    if (std.mem.eql(u8, n, "v0.3")) return .v03;
    if (std.mem.eql(u8, n, "v0.4")) return .v04;
    if (std.mem.eql(u8, n, "v0.5")) return .v05;
    if (std.mem.eql(u8, n, "v0.6")) return .v06;
    if (std.mem.eql(u8, n, "v0.7")) return .v07;
    if (std.mem.eql(u8, n, "v0.8")) return .v08;
    return null;
}

/// StrategyV0_1.decideTurn on the decision's context, as a later version runs it (no responded-victim preference).
pub fn v01(c: *ai.Ctx, out: *ai.Decision) void {
    const rin = c.s.rng.state;
    c.prefer_responded = false;
    ai.decideWith(c, out);
    note("v0.1", out, c.s, rin);
}

/// Runs the chain up to `top` for unit `ui`.
pub fn decideTo(s: *st.State, ui: u8, out: *ai.Decision, top: Level) void {
    var c: ai.Ctx = undefined;
    ai.initCtxInto(&c, s, ui);
    out.* = .{};
    switch (top) {
        .v01 => v01(&c, out),
        .v02 => lv2.decide(&c, out),
        .v03 => lv3.decide(&c, out),
        .v04 => lv4.decide(&c, out),
        .v05 => lv5.decide(&c, out),
        .v06 => lv6.decide(&c, out),
        .v07 => lv7.decide(&c, out),
        .v08 => _ = lv8.decide(&c, out),
    }
}
