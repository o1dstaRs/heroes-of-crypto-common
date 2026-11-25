//! Loads battles recorded by zig/parity/record.ts: one JSON game per line with the start state, then every
//! top-level engine call (apply / advance) with its random state, events and the digest after it.

const std = @import("std");

pub const Cell = struct { x: i32, y: i32 };

pub const EndReason = enum(u8) { manual, skip, timeout, effect };

pub const Action = union(enum) {
    start_fight,
    advance: struct { damage_dealt_this_lap: bool },
    end_turn: struct { unit: u8, reason: EndReason },
    wait_turn: struct { unit: u8 },
    defend_turn: struct { unit: u8 },
    select_attack_type: struct { unit: u8, attack_type: u8 },
    /// `has_lava` is the action's hasLavaCell (a flyer's route over lava; no state reads it in scope).
    move_unit: struct { unit: u8, path: []const Cell, target_cells: []const Cell, has_lava: bool = false },
    melee_attack: struct { attacker: u8, target: u8, attack_from: Cell, path: []const Cell, has_lava: bool = false },
    range_attack: struct { attacker: u8, target: u8, aim_cell: ?Cell = null, aim_side: u8 = 0 },
    /// A strike on a mountain cell or a stone at `targetPosition` (a cell centre) from `attackFrom`; `path` is the
    /// approach route (empty when striking in place, where the recorded action has no path or route flags).
    obstacle_attack: struct { attacker: u8, target_x: f64, target_y: f64, attack_from: Cell, path: []const Cell, has_lava: bool = false },
    /// An AI decision: the unit and the actions `decideTurn` returned (not an engine call).
    decide: struct { unit: u8, out: []const Action },
};

pub const EventKind = enum(u8) {
    turn_completed,
    next_unit_selected,
    fight_finished,
    unit_destroyed,
    armageddon_applied,
    unit_skipped,
};

/// Headless event as recorded: its type and the unit it names (or the winning team for fight_finished).
pub const Event = struct { kind: EventKind, arg: i32 };

pub const Step = struct {
    action: Action,
    r0: u32,
    r1: u32,
    draws: u32,
    ok: bool,
    events: []const Event,
    /// Expected digest after the step (parity mode only).
    digest: ?std.json.Value,
};

pub const Game = struct {
    seed: i64,
    ids: [][]const u8,
    init: std.json.Value,
    steps: []Step,
};

pub fn num(v: std.json.Value) f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .bool => |b| if (b) 1 else 0,
        .null => 0,
        .number_string => |s| std.fmt.parseFloat(f64, s) catch 0,
        else => 0,
    };
}

pub fn int(v: std.json.Value) i64 {
    return switch (v) {
        .integer => |i| i,
        .float => |f| @intFromFloat(f),
        .bool => |b| @intFromBool(b),
        else => 0,
    };
}

pub fn get(v: std.json.Value, key: []const u8) std.json.Value {
    return switch (v) {
        .object => |o| o.get(key) orelse .null,
        else => .null,
    };
}

fn flag(v: std.json.Value) bool {
    return v == .bool and v.bool;
}

fn cell(v: std.json.Value) Cell {
    return .{ .x = @intCast(int(get(v, "x"))), .y = @intCast(int(get(v, "y"))) };
}

fn cells(arena: std.mem.Allocator, v: std.json.Value) ![]const Cell {
    if (v != .array) return &.{};
    const out = try arena.alloc(Cell, v.array.items.len);
    for (v.array.items, 0..) |c, i| out[i] = cell(c);
    return out;
}

pub fn unitIndex(ids: []const []const u8, id: []const u8) !u8 {
    for (ids, 0..) |known, i| {
        if (std.mem.eql(u8, known, id)) return @intCast(i);
    }
    return error.UnknownUnit;
}

fn unitArg(ids: []const []const u8, v: std.json.Value) !u8 {
    if (v != .string) return error.MissingUnit;
    return unitIndex(ids, v.string);
}

pub fn parseAction(arena: std.mem.Allocator, ids: []const []const u8, kind: []const u8, a: std.json.Value) !Action {
    if (std.mem.eql(u8, kind, "decide")) {
        return .{ .decide = .{ .unit = try unitArg(ids, get(a, "unitId")), .out = &.{} } };
    }
    if (std.mem.eql(u8, kind, "advance")) {
        return .{ .advance = .{ .damage_dealt_this_lap = get(a, "damageDealtThisLap") == .bool and get(a, "damageDealtThisLap").bool } };
    }
    const t = get(a, "type").string;
    if (std.mem.eql(u8, t, "start_fight")) return .start_fight;
    if (std.mem.eql(u8, t, "end_turn")) {
        const r = get(a, "reason");
        var reason: EndReason = .manual;
        if (r == .string) {
            if (std.mem.eql(u8, r.string, "skip")) reason = .skip;
            if (std.mem.eql(u8, r.string, "timeout")) reason = .timeout;
            if (std.mem.eql(u8, r.string, "effect")) reason = .effect;
        }
        return .{ .end_turn = .{ .unit = try unitArg(ids, get(a, "unitId")), .reason = reason } };
    }
    if (std.mem.eql(u8, t, "wait_turn")) return .{ .wait_turn = .{ .unit = try unitArg(ids, get(a, "unitId")) } };
    if (std.mem.eql(u8, t, "defend_turn")) return .{ .defend_turn = .{ .unit = try unitArg(ids, get(a, "unitId")) } };
    if (std.mem.eql(u8, t, "select_attack_type")) {
        return .{ .select_attack_type = .{
            .unit = try unitArg(ids, get(a, "unitId")),
            .attack_type = @intCast(int(get(a, "attackType"))),
        } };
    }
    if (std.mem.eql(u8, t, "move_unit")) {
        return .{ .move_unit = .{
            .unit = try unitArg(ids, get(a, "unitId")),
            .path = try cells(arena, get(a, "path")),
            .target_cells = try cells(arena, get(a, "targetCells")),
            .has_lava = flag(get(a, "hasLavaCell")),
        } };
    }
    if (std.mem.eql(u8, t, "melee_attack")) {
        return .{ .melee_attack = .{
            .attacker = try unitArg(ids, get(a, "attackerId")),
            .target = try unitArg(ids, get(a, "targetId")),
            .attack_from = cell(get(a, "attackFrom")),
            .path = try cells(arena, get(a, "path")),
            .has_lava = flag(get(a, "hasLavaCell")),
        } };
    }
    if (std.mem.eql(u8, t, "obstacle_attack")) {
        const pos = get(a, "targetPosition");
        if (get(a, "attackFrom") == .null) return error.UnsupportedObstacleAttack; // ranged obstacle shots: not ported
        if (flag(get(a, "hasWaterCell"))) return error.UnsupportedObstacleAttack;
        return .{ .obstacle_attack = .{
            .attacker = try unitArg(ids, get(a, "attackerId")),
            .target_x = num(get(pos, "x")),
            .target_y = num(get(pos, "y")),
            .attack_from = cell(get(a, "attackFrom")),
            .path = try cells(arena, get(a, "path")),
            .has_lava = flag(get(a, "hasLavaCell")),
        } };
    }
    if (std.mem.eql(u8, t, "range_attack")) {
        if (get(a, "targetPosition") != .null) return error.UnsupportedAim; // free aim needs Through Shot
        const aim = get(a, "aimCell");
        return .{ .range_attack = .{
            .attacker = try unitArg(ids, get(a, "attackerId")),
            .target = try unitArg(ids, get(a, "targetId")),
            .aim_cell = if (aim != .null and get(a, "aimSide") != .null) cell(aim) else null,
            .aim_side = @intCast(int(get(a, "aimSide"))),
        } };
    }
    std.debug.print("unsupported action type {s}\n", .{t});
    return error.UnsupportedAction;
}

fn parseEvent(ids: []const []const u8, v: std.json.Value) !Event {
    const t = v.array.items[0].string;
    const arg = v.array.items[1];
    const kinds = [_]struct { []const u8, EventKind }{
        .{ "turn_completed", .turn_completed },
        .{ "next_unit_selected", .next_unit_selected },
        .{ "fight_finished", .fight_finished },
        .{ "unit_destroyed", .unit_destroyed },
        .{ "armageddon_applied", .armageddon_applied },
        .{ "unit_skipped", .unit_skipped },
    };
    for (kinds) |k| {
        if (std.mem.eql(u8, t, k[0])) {
            const a: i32 = switch (arg) {
                .string => |s| try unitIndex(ids, s),
                .integer => |i| @intCast(i),
                else => -1,
            };
            return .{ .kind = k[1], .arg = a };
        }
    }
    std.debug.print("unsupported event {s}\n", .{t});
    return error.UnsupportedEvent;
}

/// Parses one recorded game. Everything is allocated from `arena`; `keep_digests` retains the expected digests.
pub fn parseGame(arena: std.mem.Allocator, line: []const u8, keep_digests: bool) !Game {
    const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{});
    const init = get(root, "init");
    const units = get(init, "units").array.items;
    const ids = try arena.alloc([]const u8, units.len);
    for (units, 0..) |u, i| ids[i] = get(u, "id").string;

    const raw_steps = get(root, "steps").array.items;
    const steps = try arena.alloc(Step, raw_steps.len);
    for (raw_steps, 0..) |s, i| {
        const ev_raw = if (get(s, "ev") == .array) get(s, "ev").array.items else &[_]std.json.Value{};
        const events = try arena.alloc(Event, ev_raw.len);
        for (ev_raw, 0..) |e, j| events[j] = try parseEvent(ids, e);
        var action = try parseAction(arena, ids, get(s, "k").string, get(s, "a"));
        if (action == .decide) {
            const out_raw = get(s, "out").array.items;
            const out = try arena.alloc(Action, out_raw.len);
            for (out_raw, 0..) |o, j| out[j] = try parseAction(arena, ids, "apply", o);
            action.decide.out = out;
        }
        steps[i] = .{
            .action = action,
            .r0 = @intCast(int(get(s, "r0"))),
            .r1 = @intCast(int(get(s, "r1"))),
            .draws = @intCast(int(get(s, "draws"))),
            .ok = get(s, "ok") == .null or int(get(s, "ok")) == 1,
            .events = events,
            .digest = if (keep_digests and get(s, "s") != .null) get(s, "s") else null,
        };
    }
    return .{ .seed = int(get(root, "seed")), .ids = ids, .init = init, .steps = steps };
}

/// Iterates the non-empty lines of a JSONL buffer.
pub fn lines(buf: []const u8) std.mem.TokenIterator(u8, .scalar) {
    return std.mem.tokenizeScalar(u8, buf, '\n');
}
