//! Writes a State as the digest zig/parity/record.ts records after every step (zig/parity/digest.ts `battleDigest`
//! with setup and terrain columns on): `{units: [[id, amount_alive, ...]], fight: {...}}`, plus the harness state
//! (`active`, `rng`). The bridge returns it for checks; `compare.state` reads the same columns.
//!
//! Numbers print as Zig's shortest round-trip decimals (JSON-parse them; do not compare the text). `buffs_sources`
//! names the stored properties of aura rows and augments only ("x;y"); other rows print ";" (TypeScript prints a
//! blessing's power there, which the port keeps as the row's power). The batch-3 columns follow the setup columns
//! (abilities, stolen abilities, the Web lock, `debuffs_sources` with the same rule as `buffs_sources`, the Rallying
//! Volley arrows), then the spellbook columns (`spell_entries`, `spellbook`), then the batch-4 `forbidden_target` and
//! `helping_hand_link` ("caster id;penalty id"; a Helping Hand row's sources print its max hp and base armor); the
//! fight block carries the vines. Ids come from `ids` by uid; a unit summoned after the table was built prints its UUID.

const std = @import("std");
const st = @import("state.zig");
const engine = @import("engine.zig");
const uuid = @import("uuid.zig");

const Writer = std.Io.Writer;
const State = st.State;

fn spellName(spell: u8) []const u8 {
    return if (spell < st.N_CAST_SPELLS) @as(st.CastSpell, @enumFromInt(spell)).name() else "?";
}

fn num(w: *Writer, x: f64) Writer.Error!void {
    if (std.math.isNan(x) or std.math.isInf(x)) return w.writeAll("null");
    if (x == 0) return w.writeAll("0");
    try w.print("{d}", .{x});
}

/// A Helping Hand row's stored properties as TypeScript prints them: "max hp;base armor".
fn pair(w: *Writer, p: [2]f64) Writer.Error!void {
    try num(w, p[0]);
    try w.writeByte(';');
    try num(w, p[1]);
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
            .laps => try num(w, a.shownLaps()),
            .powers => try num(w, a.power),
        }
    }
    try w.writeByte('"');
}

/// The id string of the unit in `slot`: `ids[uid]` (the handle's or the recording's table), else its UUID (a unit
/// summoned after the table was built).
fn idOf(s: *const State, ids: []const []const u8, slot: usize, buf: *[36]u8) []const u8 {
    const u = &s.units[slot];
    if (u.uid < ids.len) return ids[u.uid];
    return uuid.format(&u.uuid, buf);
}

/// The id of uid `uid` without an entry in the id table: the UUID of the slot holding it ("?" when none does).
fn uidText(s: *const State, uid: u8, buf: *[36]u8) []const u8 {
    for (s.units[0..s.n_units]) |*x| {
        if (x.uid == uid and x.uuid_ok) return uuid.format(&x.uuid, buf);
    }
    return "?";
}

fn idList(w: *Writer, s: *const State, ids: []const []const u8, items: []const u8) Writer.Error!void {
    try w.writeByte('[');
    for (items, 0..) |ui, i| {
        if (i > 0) try w.writeByte(',');
        var buf: [36]u8 = undefined;
        try str(w, idOf(s, ids, ui, &buf));
    }
    try w.writeByte(']');
}

/// A turn set (slot bits plus the removed units it still names) as TypeScript's sorted id list.
fn idSet(w: *Writer, s: *const State, ids: []const []const u8, set: st.UnitSet, kind: @import("compare.zig").SetKind) Writer.Error!void {
    var sorted: [st.MAX_UNITS + 256][]const u8 = undefined;
    var bufs: [st.MAX_UNITS][36]u8 = undefined;
    var n: usize = 0;
    var it = set;
    while (it != 0) {
        const ui: usize = @ctz(it);
        it &= it - 1;
        sorted[n] = idOf(s, ids, ui, &bufs[n]);
        n += 1;
    }
    const removed = @import("compare.zig").removedSet(&s.fight, kind);
    for (0..256) |uid| {
        if (!removed.has(@intCast(uid))) continue;
        sorted[n] = if (uid < ids.len) ids[uid] else "?";
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
    for (s.holderOrder()) |idx| {
        const u = &s.units[idx];
        if (!first) try w.writeByte(',');
        first = false;
        const c = engine.baseCell(u);
        try w.writeByte('[');
        var id_buf: [36]u8 = undefined;
        try str(w, idOf(s, ids, idx, &id_buf));
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
        var target_buf: [36]u8 = undefined;
        try str(w, if (u.target >= 0) idOf(s, ids, @intCast(u.target), &target_buf) else "");
        try w.writeByte(',');
        try num(w, u.magic_resist);
        try w.writeAll(",\"");
        // buffs_sources reads the buff objects: a revive's orphan augment rows have none.
        for (buffs[u.aug_orphans..], 0..) |b, i| {
            if (i > 0) try w.writeByte(',');
            if (b.id == .helping_hand) {
                try pair(w, u.hh_gift);
                continue;
            }
            if (b.src_x >= 0) try w.print("{d}", .{b.src_x});
            try w.writeByte(';');
            if (b.src_y >= 0) try w.print("{d}", .{b.src_y});
        }
        try w.writeByte('"');
        for ([_]f64{ u.shot_distance, u.init.base_armor, u.init.steps }) |x| {
            try w.writeByte(',');
            try num(w, x);
        }
        // Batch-3 columns: active abilities, stolen abilities, the Web lock, debuff source cells, Rallying Volley.
        try w.writeAll(",\"");
        for (u.abilities[0..u.n_abilities], 0..) |a, i| {
            if (i > 0) try w.writeByte(',');
            try w.writeAll(a.id.name());
        }
        try w.writeAll("\",\"");
        for (u.stolen[0..u.n_stolen], 0..) |a, i| {
            if (i > 0) try w.writeByte(',');
            try w.writeAll(a.name());
        }
        try w.print("\",{d},\"", .{@intFromBool(u.web_locked)});
        for (debuffs, 0..) |b, i| {
            if (i > 0) try w.writeByte(',');
            if (b.id == .helping_hand) {
                try pair(w, u.hh_cost);
                continue;
            }
            if (b.src_x >= 0) try w.print("{d}", .{b.src_x});
            try w.writeByte(';');
            if (b.src_y >= 0) try w.print("{d}", .{b.src_y});
        }
        try w.writeAll("\",");
        try num(w, u.rallying_volley_granted);
        // Spellbook columns: the raw entries and the parsed book (name:charges).
        try w.writeAll(",\"");
        for (u.book[0..u.n_book], 0..) |e, i| {
            if (i > 0) try w.writeByte(',');
            try w.print("{s}:{s}", .{ st.BookEntry.PREFIXES[e.prefix], spellName(e.spell) });
        }
        try w.writeAll("\",\"");
        for (u.spells[0..u.n_spells], 0..) |b, i| {
            if (i > 0) try w.writeByte(',');
            try w.print("{s}:{d}", .{ spellName(b.spell), b.amount });
        }
        // Batch-4 column: Terrifying Gaze's forbidden target (the gazer's id, "" for none).
        try w.writeAll("\",");
        try str(w, if (u.forbidden != st.NO_UID and u.forbidden < ids.len) ids[u.forbidden] else if (u.forbidden != st.NO_UID) uidText(s, u.forbidden, &id_buf) else "");
        // Helping Hand's link: "caster id;penalty id" (each "" when absent).
        try w.writeAll(",\"");
        if (u.hh_caster != st.NO_UID) try w.writeAll(if (u.hh_caster < ids.len) ids[u.hh_caster] else uidText(s, u.hh_caster, &id_buf));
        try w.writeByte(';');
        if (u.hh_penalty != st.NO_UID) try w.writeAll(if (u.hh_penalty < ids.len) ids[u.hh_penalty] else uidText(s, u.hh_penalty, &id_buf));
        try w.writeAll("\"");
        // Batch-6b columns: the spent Water Shield flag and magic_resist_mod (Enchanted Skin's 100).
        try w.print(",{d},", .{@intFromBool(u.water_shield_spent)});
        try num(w, u.magic_resist_mod);
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
    try idList(w, s, ids, f.up_next.slice());
    try w.writeAll(",\"hourglassQ\":");
    try idList(w, s, ids, f.hourglass_q.slice());
    try w.writeAll(",\"moralePlusQ\":");
    try idList(w, s, ids, f.morale_plus_q.slice());
    try w.writeAll(",\"moraleMinusQ\":");
    try idList(w, s, ids, f.morale_minus_q.slice());
    try w.writeAll(",\"made\":");
    try idSet(w, s, ids, f.made, .made);
    try w.writeAll(",\"hourglassSet\":");
    try idSet(w, s, ids, f.hourglass_set, .hourglass);
    try w.writeAll(",\"replied\":");
    try idSet(w, s, ids, f.replied, .replied);
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
    try w.writeAll("],\"vines\":[");
    for (f.vines[0..f.n_vines], 0..) |v, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("[{d},{d},{d},{d}]", .{ v.x, v.y, v.laps, v.team });
    }
    try w.writeAll("],\"smoke\":[");
    for (f.smoke[0..f.n_smoke], 0..) |c, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("[{d},{d},{d}]", .{ c.x, c.y, c.laps });
    }
    try w.writeAll("],\"fireWalls\":[");
    for (f.fire[0..f.n_fire], 0..) |c, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("[{d},{d},{d},", .{ c.x, c.y, c.laps });
        try num(w, @as(f64, @floatFromInt(c.pct10)) / 10);
        try w.writeByte(']');
    }
    // The board's lava cells (x-major), which a death on lava erases and a unit leaving a centre cell restores.
    try w.writeAll("],\"lava\":[");
    var first_lava = true;
    for (0..st.GRID) |x| {
        for (0..st.GRID) |y| {
            if (s.grid.board[x][y] != st.LAVA) continue;
            if (!first_lava) try w.writeByte(',');
            first_lava = false;
            try w.print("[{d},{d}]", .{ x, y });
        }
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
    var active_buf: [36]u8 = undefined;
    try str(w, if (s.active >= 0) idOf(s, ids, @intCast(s.active), &active_buf) else "");
    try w.print(",\"rng\":{d}}}", .{s.rng.state});
}
