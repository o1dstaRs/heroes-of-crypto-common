//! Writes a State as the digest zig/parity/record.ts records after every step (zig/parity/digest.ts `battleDigest`
//! with setup and terrain columns on): `{units: [[id, amount_alive, ...]], fight: {...}}`, plus the harness state
//! (`active`, `rng`). The bridge returns it for checks; `compare.state` reads the same columns.
//!
//! Numbers print as Zig's shortest round-trip decimals (JSON-parse them; do not compare the text). `buffs_sources`
//! names the stored properties of aura rows and augments only ("x;y"); other rows print ";" (TypeScript prints a
//! blessing's power there, which the port keeps as the row's power).

const std = @import("std");
const st = @import("state.zig");
const engine = @import("engine.zig");

const Writer = std.Io.Writer;
const State = st.State;

fn num(w: *Writer, x: f64) Writer.Error!void {
    if (std.math.isNan(x) or std.math.isInf(x)) return w.writeAll("null");
    if (x == 0) return w.writeAll("0");
    try w.print("{d}", .{x});
}

fn str(w: *Writer, s: []const u8) Writer.Error!void {
    try w.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"', '\\' => {
                try w.writeByte('\\');
                try w.writeByte(c);
            },
            0...0x1f => try w.print("\\u{x:0>4}", .{c}),
            else => try w.writeByte(c),
        }
    }
    try w.writeByte('"');
}

/// A spell list's names, laps or powers joined by commas, as one JSON string.
fn spellColumn(w: *Writer, list: []const st.AppliedSpell, comptime what: enum { names, laps, powers }) Writer.Error!void {
    try w.writeByte('"');
    for (list, 0..) |a, i| {
        if (i > 0) try w.writeByte(',');
        switch (what) {
            .names => try w.writeAll(a.id.name()),
            .laps => try num(w, a.laps),
            .powers => try num(w, a.power),
        }
    }
    try w.writeByte('"');
}

fn idList(w: *Writer, ids: []const []const u8, items: []const u8) Writer.Error!void {
    try w.writeByte('[');
    for (items, 0..) |ui, i| {
        if (i > 0) try w.writeByte(',');
        try str(w, ids[ui]);
    }
    try w.writeByte(']');
}

/// A unit set as TypeScript's sorted id list.
fn idSet(w: *Writer, ids: []const []const u8, set: st.UnitSet) Writer.Error!void {
    var sorted: [st.MAX_UNITS][]const u8 = undefined;
    var n: usize = 0;
    var it = set;
    while (it != 0) {
        const ui: usize = @ctz(it);
        it &= it - 1;
        sorted[n] = ids[ui];
        n += 1;
    }
    std.mem.sort([]const u8, sorted[0..n], {}, struct {
        fn lt(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.order(u8, a, b) == .lt;
        }
    }.lt);
    try w.writeByte('[');
    for (sorted[0..n], 0..) |id, i| {
        if (i > 0) try w.writeByte(',');
        try str(w, id);
    }
    try w.writeByte(']');
}

pub fn write(w: *Writer, s: *const State, ids: []const []const u8) Writer.Error!void {
    try w.writeAll("{\"units\":[");
    var first = true;
    for (s.units[0..s.n_units], 0..) |*u, idx| {
        if (!u.in_holder) continue;
        if (!first) try w.writeByte(',');
        first = false;
        const c = engine.baseCell(u);
        try w.writeByte('[');
        try str(w, ids[idx]);
        const head = [_]f64{
            u.amount_alive,               u.amount_died,                   u.hp,                     u.max_hp,
            @floatFromInt(c.x),           @floatFromInt(c.y),              if (u.isDead()) 1 else 0, if (u.responded) 1 else 0,
            if (u.on_hourglass) 1 else 0, if (u.moved_this_turn) 1 else 0, u.stack_power,            u.morale,
            u.luck,                       u.luck_mod,                      u.attack_mod,             u.armor_mod,
            u.base_armor,                 u.base_attack,                   u.steps,                  u.steps_mod,
            u.initiative,                 u.range_shots,                   u.range_shots_mod,        u.range_armor,
            u.attack_multiplier,          u.attack_damage_min,             u.attack_damage_max,      @floatFromInt(u.attack_type_selected),
        };
        for (head) |x| {
            try w.writeByte(',');
            try num(w, x);
        }
        const buffs = u.buffs.items[0..u.buffs.len];
        const debuffs = u.debuffs.items[0..u.debuffs.len];
        const effects = u.effects.items[0..u.effects.len];
        inline for (.{ buffs, debuffs, effects }) |list| {
            try w.writeByte(',');
            try spellColumn(w, list, .names);
            try w.writeByte(',');
            try spellColumn(w, list, .laps);
        }
        for ([_]f64{ u.pos_x, u.pos_y, u.init.morale, u.luck_per_turn }) |x| {
            try w.writeByte(',');
            try num(w, x);
        }
        inline for (.{ buffs, debuffs, effects }) |list| {
            try w.writeByte(',');
            try spellColumn(w, list, .powers);
        }
        for ([_]f64{ u.init.base_attack, u.moved_route_cells }) |x| {
            try w.writeByte(',');
            try num(w, x);
        }
        try w.writeByte(',');
        try str(w, if (u.target >= 0) ids[@intCast(u.target)] else "");
        try w.writeByte(',');
        try num(w, u.magic_resist);
        try w.writeAll(",\"");
        for (buffs, 0..) |b, i| {
            if (i > 0) try w.writeByte(',');
            if (b.src_x >= 0) try w.print("{d}", .{b.src_x});
            try w.writeByte(';');
            if (b.src_y >= 0) try w.print("{d}", .{b.src_y});
        }
        try w.writeByte('"');
        for ([_]f64{ u.shot_distance, u.init.base_armor, u.init.steps }) |x| {
            try w.writeByte(',');
            try num(w, x);
        }
        try w.writeByte(']');
    }
    const f = &s.fight;
    try w.print("],\"fight\":{{\"lap\":{d},\"started\":{d},\"finished\":{d},\"firstTurnMade\":{d},\"previousTurnTeam\":{d},\"highestInitiative\":", .{
        f.lap, @intFromBool(f.started), @intFromBool(f.finished), @intFromBool(f.first_turn_made), f.previous_turn_team,
    });
    try num(w, f.highest_initiative);
    try w.writeAll(",\"stepsMoraleMultiplier\":");
    try num(w, f.steps_morale_multiplier);
    try w.print(",\"additionalNarrowingLaps\":{d},\"upNext\":", .{f.additional_narrowing_laps});
    try idList(w, ids, f.up_next.slice());
    try w.writeAll(",\"hourglassQ\":");
    try idList(w, ids, f.hourglass_q.slice());
    try w.writeAll(",\"moralePlusQ\":");
    try idList(w, ids, f.morale_plus_q.slice());
    try w.writeAll(",\"moraleMinusQ\":");
    try idList(w, ids, f.morale_minus_q.slice());
    try w.writeAll(",\"made\":");
    try idSet(w, ids, f.made);
    try w.writeAll(",\"hourglassSet\":");
    try idSet(w, ids, f.hourglass_set);
    try w.writeAll(",\"replied\":");
    try idSet(w, ids, f.replied);
    try w.writeAll(",\"damageLaps\":[");
    var first_lap = true;
    for (0..128) |l| {
        if (f.damage_laps & (@as(u128, 1) << @intCast(l)) == 0) continue;
        if (!first_lap) try w.writeByte(',');
        first_lap = false;
        try w.print("{d}", .{l});
    }
    try w.writeAll("],\"emberTeams\":[");
    var first_team = true;
    for (0..3) |t| {
        if (s.ember_teams & (@as(u8, 1) << @intCast(t)) == 0) continue;
        if (!first_team) try w.writeByte(',');
        first_team = false;
        try w.print("{d}", .{t});
    }
    const t = &s.grid.terrain;
    try w.print("],\"terrain\":{{\"hitsL\":{d},\"hitsR\":{d},\"leftCleared\":{d},\"rightCleared\":{d},\"cleanedUpCenter\":{d},\"standing\":[", .{
        f.hits_left, f.hits_right, @intFromBool(t.left_cleared), @intFromBool(t.right_cleared), @intFromBool(t.cleaned_up_center),
    });
    var first_stone = true;
    for (t.layout[0..t.n_layout], 0..) |l, i| {
        if (t.standing & (@as(u16, 1) << @intCast(i)) == 0) continue;
        if (!first_stone) try w.writeByte(',');
        first_stone = false;
        try w.print("[{d},{d}]", .{ l.x, l.y });
    }
    try w.writeAll("]}},\"active\":");
    try str(w, if (s.active >= 0) ids[@intCast(s.active)] else "");
    try w.print(",\"rng\":{d}}}", .{s.rng.state});
}
