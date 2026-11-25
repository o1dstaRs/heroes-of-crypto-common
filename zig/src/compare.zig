//! Compares the Zig state after a step with the digest the TypeScript engine recorded after the same step.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");

pub const Mismatch = struct {
    buf: [512]u8 = undefined,
    len: usize = 0,

    pub fn text(self: *const Mismatch) []const u8 {
        return self.buf[0..self.len];
    }
    fn set(self: *Mismatch, comptime fmt: []const u8, args: anytype) void {
        const s = std.fmt.bufPrint(&self.buf, fmt, args) catch self.buf[0..];
        self.len = s.len;
    }
};

const unit_fields = [_][]const u8{
    "id",                "amount_alive",      "amount_died",       "hp",                   "max_hp",
    "x",                 "y",                 "dead",              "responded",            "hourglass",
    "moved",             "stack_power",       "morale",            "luck",                 "luck_mod",
    "attack_mod",        "armor_mod",         "base_armor",        "base_attack",          "steps",
    "steps_mod",         "initiative",        "range_shots",       "range_shots_mod",      "range_armor",
    "attack_multiplier", "attack_damage_min", "attack_damage_max", "attack_type_selected",
};

fn b(v: bool) f64 {
    return if (v) 1 else 0;
}

fn unitNumbers(u: *const st.Unit) [unit_fields.len]f64 {
    return .{
        0,                                   u.amount_alive,                      u.amount_died,       u.hp,                                  u.max_hp,
        @floatFromInt(engine.baseCell(u).x), @floatFromInt(engine.baseCell(u).y), b(u.isDead()),       b(u.responded),                        b(u.on_hourglass),
        b(u.moved_this_turn),                u.stack_power,                       u.morale,            u.luck,                                u.luck_mod,
        u.attack_mod,                        u.armor_mod,                         u.base_armor,        u.base_attack,                         u.steps,
        u.steps_mod,                         u.initiative,                        u.range_shots,       u.range_shots_mod,                     u.range_armor,
        u.attack_multiplier,                 u.attack_damage_min,                 u.attack_damage_max, @floatFromInt(u.attack_type_selected),
    };
}

fn eqNum(a: f64, e: f64) bool {
    return a == e or (std.math.isNan(a) and std.math.isNan(e));
}

/// Compares "Morale,Luck Blessing" + "1,15" + "0,4" style lists: names, laps and powers in order. `powers` is null
/// for recordings made before the powers column existed.
fn spellsMatch(list: *const st.SpellList, names: []const u8, laps: []const u8, powers: ?[]const u8) bool {
    var it = std.mem.tokenizeScalar(u8, names, ',');
    var lit = std.mem.tokenizeScalar(u8, laps, ',');
    var pit = std.mem.tokenizeScalar(u8, powers orelse "", ',');
    var i: usize = 0;
    while (it.next()) |n| : (i += 1) {
        if (i >= list.len) return false;
        if (!std.mem.eql(u8, n, list.items[i].id.name())) return false;
        const l = lit.next() orelse return false;
        const lv = std.fmt.parseFloat(f64, l) catch return false;
        if (lv != list.items[i].laps) return false;
        if (powers != null) {
            const p = pit.next() orelse return false;
            const pv = std.fmt.parseFloat(f64, p) catch return false;
            if (pv != list.items[i].power) return false;
        }
    }
    return i == list.len;
}

fn column(row: []const std.json.Value, i: usize) ?[]const u8 {
    return if (i < row.len and row[i] == .string) row[i].string else null;
}

fn idSet(ids: []const []const u8, set: st.UnitSet, expected: std.json.Value, m: *Mismatch, what: []const u8) bool {
    var count: usize = 0;
    for (expected.array.items) |e| {
        const idx = rec.unitIndex(ids, e.string) catch {
            m.set("{s}: unknown id", .{what});
            return false;
        };
        if (set & (@as(st.UnitSet, 1) << @intCast(idx)) == 0) {
            m.set("{s}: expected unit {d} in set", .{ what, idx });
            return false;
        }
        count += 1;
    }
    if (@popCount(set) != count) {
        m.set("{s}: zig has {d} units, ts {d}", .{ what, @popCount(set), count });
        return false;
    }
    return true;
}

fn queue(ids: []const []const u8, q: *const st.Queue, expected: std.json.Value, m: *Mismatch, what: []const u8) bool {
    const items = expected.array.items;
    if (items.len != q.len) {
        m.set("{s}: zig len {d}, ts len {d}", .{ what, q.len, items.len });
        return false;
    }
    for (items, 0..) |e, i| {
        const idx = rec.unitIndex(ids, e.string) catch return false;
        if (q.items[i] != idx) {
            m.set("{s}[{d}]: zig unit {d}, ts unit {d}", .{ what, i, q.items[i], idx });
            return false;
        }
    }
    return true;
}

pub fn state(s: *const st.State, ids: []const []const u8, digest: std.json.Value, m: *Mismatch) bool {
    // Units: TypeScript lists the units still in the holder, in insertion order.
    const units = rec.get(digest, "units").array.items;
    var k: usize = 0;
    for (s.units[0..s.n_units], 0..) |*u, idx| {
        if (!u.in_holder) continue;
        if (k >= units.len) {
            m.set("unit {d} still in zig holder, ts removed it", .{idx});
            return false;
        }
        const row = units[k].array.items;
        const ts_idx = rec.unitIndex(ids, row[0].string) catch return false;
        if (ts_idx != idx) {
            m.set("holder slot {d}: zig unit {d}, ts unit {d}", .{ k, idx, ts_idx });
            return false;
        }
        const nums = unitNumbers(u);
        for (1..unit_fields.len) |f| {
            const e = rec.num(row[f]);
            if (!eqNum(nums[f], e)) {
                m.set("unit {d} {s}: zig {d}, ts {d}", .{ idx, unit_fields[f], nums[f], e });
                return false;
            }
        }
        const lists = [_]struct { []const u8, *const st.SpellList, usize, usize }{
            .{ "buffs", &u.buffs, 29, 39 },
            .{ "debuffs", &u.debuffs, 31, 40 },
            .{ "effects", &u.effects, 33, 41 },
        };
        for (lists) |l| {
            if (!spellsMatch(l[1], row[l[2]].string, row[l[2] + 1].string, column(row, l[3]))) {
                const first = if (l[1].len > 0) l[1].items[0] else st.AppliedSpell{ .id = .morale, .laps = 0 };
                m.set("unit {d} {s}: ts '{s}' laps '{s}' powers '{s}' (zig has {d}; first {s} laps {d} power {d})", .{
                    idx,                                        l[0],       row[l[2]].string, row[l[2] + 1].string, column(row, l[3]) orelse "", l[1].len,
                    if (l[1].len > 0) first.id.name() else "-", first.laps, first.power,
                });
                return false;
            }
        }
        const hidden = [_]struct { []const u8, f64, usize }{
            .{ "px", u.pos_x, 35 },
            .{ "py", u.pos_y, 36 },
            .{ "base_morale", u.init.morale, 37 },
            .{ "luck_per_turn", u.luck_per_turn, 38 },
            .{ "base_attack_init", u.init.base_attack, 42 },
            .{ "moved_route_cells", u.moved_route_cells, 43 },
        };
        for (hidden) |h| {
            if (h[2] >= row.len) continue; // older recordings stop at an earlier column
            const e = rec.num(row[h[2]]);
            if (!eqNum(h[1], e)) {
                m.set("unit {d} {s}: zig {d}, ts {d}", .{ idx, h[0], h[1], e });
                return false;
            }
        }
        k += 1;
    }
    if (k != units.len) {
        m.set("ts holder has {d} units, zig {d}", .{ units.len, k });
        return false;
    }

    const f = rec.get(digest, "fight");
    const fs = &s.fight;
    const scalars = [_]struct { []const u8, f64 }{
        .{ "lap", @floatFromInt(fs.lap) },
        .{ "started", b(fs.started) },
        .{ "finished", b(fs.finished) },
        .{ "firstTurnMade", b(fs.first_turn_made) },
        .{ "previousTurnTeam", @floatFromInt(fs.previous_turn_team) },
        .{ "highestInitiative", fs.highest_initiative },
        .{ "stepsMoraleMultiplier", fs.steps_morale_multiplier },
        .{ "additionalNarrowingLaps", @floatFromInt(fs.additional_narrowing_laps) },
    };
    for (scalars) |sc| {
        const e = rec.num(rec.get(f, sc[0]));
        if (!eqNum(sc[1], e)) {
            m.set("fight {s}: zig {d}, ts {d}", .{ sc[0], sc[1], e });
            return false;
        }
    }
    if (!queue(ids, &fs.up_next, rec.get(f, "upNext"), m, "upNext")) return false;
    if (!queue(ids, &fs.hourglass_q, rec.get(f, "hourglassQ"), m, "hourglassQ")) return false;
    if (!queue(ids, &fs.morale_plus_q, rec.get(f, "moralePlusQ"), m, "moralePlusQ")) return false;
    if (!queue(ids, &fs.morale_minus_q, rec.get(f, "moraleMinusQ"), m, "moraleMinusQ")) return false;
    if (!idSet(ids, fs.made, rec.get(f, "made"), m, "made")) return false;
    if (!idSet(ids, fs.hourglass_set, rec.get(f, "hourglassSet"), m, "hourglassSet")) return false;
    if (!idSet(ids, fs.replied, rec.get(f, "replied"), m, "replied")) return false;
    var laps: u128 = 0;
    for (rec.get(f, "damageLaps").array.items) |l| laps |= @as(u128, 1) << @intCast(rec.int(l));
    if (laps != fs.damage_laps) {
        m.set("fight damageLaps differ", .{});
        return false;
    }
    return true;
}
