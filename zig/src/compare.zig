//! Compares the Zig state after a step with the digest the TypeScript engine recorded after the same step.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const ai = @import("ai.zig");

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

fn flag(v: bool) f64 {
    return if (v) 1 else 0;
}

fn unitNumbers(u: *const st.Unit) [unit_fields.len]f64 {
    return .{
        0,                                   u.amount_alive,                      u.amount_died,       u.hp,                                  u.max_hp,
        @floatFromInt(engine.baseCell(u).x), @floatFromInt(engine.baseCell(u).y), flag(u.isDead()),    flag(u.responded),                     flag(u.on_hourglass),
        flag(u.moved_this_turn),             u.stack_power,                       u.morale,            u.luck,                                u.luck_mod,
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

/// Compares the "x;y,;,..." column (each buff's first and second spell property) with the aura rows' source cells.
/// Other rows are skipped: a team blessing stores its power there (`applyBuff(buff, power)`), compared as its power.
fn sourcesMatch(list: *const st.SpellList, srcs: []const u8) bool {
    var it = std.mem.splitScalar(u8, srcs, ',');
    var i: usize = 0;
    if (srcs.len == 0) return list.len == 0;
    while (it.next()) |entry| : (i += 1) {
        if (i >= list.len) return false;
        const b = list.items[i];
        if (b.laps != st.LAPS_AURA) continue;
        var parts = std.mem.splitScalar(u8, entry, ';');
        const xs = parts.next() orelse return false;
        const ys = parts.next() orelse return false;
        const x: i32 = if (xs.len == 0) -1 else (std.fmt.parseInt(i32, xs, 10) catch return false);
        const y: i32 = if (ys.len == 0) -1 else (std.fmt.parseInt(i32, ys, 10) catch return false);
        if (x != b.src_x or y != b.src_y) return false;
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
        // Batch-2 columns: the Aggr forced target, magic resist (Wardguard) and each buff's source cell.
        if (column(row, 44)) |t| {
            const want: i32 = if (t.len == 0) -1 else (rec.unitIndex(ids, t) catch return false);
            if (want != u.target) {
                m.set("unit {d} target: zig {d}, ts {d}", .{ idx, u.target, want });
                return false;
            }
        }
        if (row.len > 45 and !eqNum(u.magic_resist, rec.num(row[45]))) {
            m.set("unit {d} magic_resist: zig {d}, ts {d}", .{ idx, u.magic_resist, rec.num(row[45]) });
            return false;
        }
        if (column(row, 46)) |srcs| {
            if (!sourcesMatch(&u.buffs, srcs)) {
                m.set("unit {d} buffs_sources: ts '{s}'", .{ idx, srcs });
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
        .{ "started", flag(fs.started) },
        .{ "finished", flag(fs.finished) },
        .{ "firstTurnMade", flag(fs.first_turn_made) },
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
    const ember = rec.get(f, "emberTeams");
    if (ember == .array) {
        var teams: u8 = 0;
        for (ember.array.items) |t| teams |= @as(u8, 1) << @intCast(rec.int(t));
        if (teams != s.ember_teams) {
            m.set("fight emberTeams: zig mask {d}, ts mask {d}", .{ s.ember_teams, teams });
            return false;
        }
    }
    var laps: u128 = 0;
    for (rec.get(f, "damageLaps").array.items) |l| laps |= @as(u128, 1) << @intCast(rec.int(l));
    if (laps != fs.damage_laps) {
        m.set("fight damageLaps differ", .{});
        return false;
    }
    return true;
}

// =====================================================================================================================
// Native play check (hoc-sim native, reused by the v0.8 port)
// =====================================================================================================================

pub fn eventsMatch(got: []const rec.Event, want: []const rec.Event) bool {
    if (got.len != want.len) return false;
    for (got, want) |g, w| if (g.kind != w.kind or g.arg != w.arg) return false;
    return true;
}

pub fn cellsEqual(a: []const rec.Cell, b: []const rec.Cell) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (x.x != y.x or x.y != y.y) return false;
    return true;
}

pub fn actionsEqual(a: rec.Action, b: rec.Action) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    return switch (a) {
        .start_fight => true,
        .advance => |x| x.damage_dealt_this_lap == b.advance.damage_dealt_this_lap,
        .end_turn => |x| x.unit == b.end_turn.unit and x.reason == b.end_turn.reason,
        .wait_turn => |x| x.unit == b.wait_turn.unit,
        .defend_turn => |x| x.unit == b.defend_turn.unit,
        .select_attack_type => |x| x.unit == b.select_attack_type.unit and x.attack_type == b.select_attack_type.attack_type,
        .move_unit => |x| x.unit == b.move_unit.unit and cellsEqual(x.path, b.move_unit.path) and cellsEqual(x.target_cells, b.move_unit.target_cells),
        .melee_attack => |x| x.attacker == b.melee_attack.attacker and x.target == b.melee_attack.target and
            x.attack_from.x == b.melee_attack.attack_from.x and x.attack_from.y == b.melee_attack.attack_from.y and cellsEqual(x.path, b.melee_attack.path),
        .range_attack => |x| blk: {
            const y = b.range_attack;
            if (x.attacker != y.attacker or x.target != y.target) break :blk false;
            if ((x.aim_cell == null) != (y.aim_cell == null)) break :blk false;
            if (x.aim_cell) |ac| break :blk ac.x == y.aim_cell.?.x and ac.y == y.aim_cell.?.y and x.aim_side == y.aim_side;
            break :blk true;
        },
        .decide => |x| blk: {
            const y = b.decide;
            if (x.unit != y.unit or x.out.len != y.out.len) break :blk false;
            for (x.out, y.out) |p, q| if (!actionsEqual(p, q)) break :blk false;
            break :blk true;
        },
    };
}

/// The native-play observer: checks each Zig step (decision or engine call) against the next recorded step.
pub const NativeCheck = struct {
    game: *const rec.Game,
    ids: []const []const u8,
    next: usize = 0,
    failed: ?[]const u8 = null,
    mismatch: Mismatch = .{},
    zig_action: rec.Action = .start_fight,

    pub fn step(ctx: *anyopaque, kind: ai.StepKind, action: rec.Action, r0: u32, s: *const st.State, ok: bool, events: []const rec.Event) bool {
        const self: *NativeCheck = @ptrCast(@alignCast(ctx));
        self.zig_action = action;
        if (self.next >= self.game.steps.len) {
            self.failed = "zig made more steps than the recording";
            return false;
        }
        const want = self.game.steps[self.next];
        const want_kind: ai.StepKind = switch (want.action) {
            .advance => .advance,
            .decide => .decide,
            else => .apply,
        };
        if (kind != want_kind) {
            self.failed = "step kind differs";
        } else if (!actionsEqual(action, want.action)) {
            self.failed = "action differs";
        } else if (r0 != want.r0) {
            self.failed = "random state before the step differs";
        } else if (s.rng.state != want.r1) {
            self.failed = "random stream differs";
        } else if (kind != .decide and ok != want.ok) {
            self.failed = "accepted/rejected differs";
        } else if (kind != .decide and !eventsMatch(events, want.events)) {
            self.failed = "events differ";
        } else if (want.digest) |d| {
            if (!state(s, self.ids, d, &self.mismatch)) self.failed = self.mismatch.text();
        }
        if (self.failed != null) return false;
        self.next += 1;
        return true;
    }
};
