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
    /// A shot at `target` (aimCell / aimSide the requested edge), or with `free` a Through Shot aimed at the world point
    /// (`tx`, `ty`): `targetPosition` with `targetId` empty or absent (isFreeAim); `target` is then unused.
    range_attack: struct { attacker: u8, target: u8, aim_cell: ?Cell = null, aim_side: u8 = 0, free: bool = false, tx: f64 = 0, ty: f64 = 0 },
    /// A strike on a mountain cell or a stone at `targetPosition` (a cell centre) from `attackFrom`; `path` is the
    /// approach route (empty when striking in place, where the recorded action has no path or route flags).
    /// `has_from` false: the action carries no attackFrom (a shooter's ranged shot at the obstacle).
    obstacle_attack: struct { attacker: u8, target_x: f64, target_y: f64, attack_from: Cell, path: []const Cell, has_lava: bool = false, has_from: bool = true },
    /// An AI decision: the unit and the actions `decideTurn` returned (not an engine call).
    decide: struct { unit: u8, out: []const Action },
    /// A cast (`cast_spell`): the spell (state.CastSpell, or NO_SPELL for a name outside the port), the target unit
    /// (`has_target`), the target cell (`has_cell`) and Fire Wall's targetOrientation (normalized: 0 to 3).
    cast_spell: struct { caster: u8, spell: u8, target: u8 = 0, has_target: bool = false, cell: Cell = .{ .x = 0, .y = 0 }, has_cell: bool = false, orientation: u8 = 0 },
    /// Area Throw at a cell (`targetCell`: empty, lava or a scattered stone), sent by v0.8 only.
    area_throw_attack: struct { attacker: u8, target_cell: Cell },
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
    /// A decide step of a mindless ("AI Driven") unit recorded under another RECORD_VERSION (`v: "v0.1"`): runMatch
    /// decided it with StrategyV0_1 whatever the seat's version.
    mindless: bool = false,
    /// `stall`: the uids runMatch's forceStalledLap marked as having made their turn just before this step (between
    /// engine calls, so a replay applies them first).
    stall: []const u8 = &.{},
};

pub const Game = struct {
    seed: i64,
    /// Unit ids by uid: the start state's units, then the summoned units in creation order (`summonIds`).
    ids: [][]const u8,
    /// The start state's unit count (the first summon's uid).
    n_start: usize = 0,
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
        if (flag(get(a, "hasWaterCell"))) return error.UnsupportedObstacleAttack;
        const from = get(a, "attackFrom");
        return .{ .obstacle_attack = .{
            .attacker = try unitArg(ids, get(a, "attackerId")),
            .target_x = num(get(pos, "x")),
            .target_y = num(get(pos, "y")),
            .attack_from = if (from == .null) .{ .x = 0, .y = 0 } else cell(from),
            .path = try cells(arena, get(a, "path")),
            .has_lava = flag(get(a, "hasLavaCell")),
            .has_from = from != .null,
        } };
    }
    if (std.mem.eql(u8, t, "cast_spell")) {
        const name = get(a, "spellName");
        if (name != .string) return error.MissingSpell;
        const spell = @import("state.zig").CastSpell.fromName(name.string);
        const tid = get(a, "targetId");
        const tc = get(a, "targetCell");
        return .{ .cast_spell = .{
            .caster = try unitArg(ids, get(a, "casterId")),
            .spell = if (spell) |sp| @intFromEnum(sp) else @import("state.zig").NO_SPELL,
            .target = if (tid == .string) try unitIndex(ids, tid.string) else 0,
            .has_target = tid == .string,
            .cell = if (tc == .object) cell(tc) else .{ .x = 0, .y = 0 },
            .has_cell = tc == .object,
            .orientation = orientationOf(get(a, "targetOrientation")),
        } };
    }
    if (std.mem.eql(u8, t, "range_attack")) {
        const pos = get(a, "targetPosition");
        const tid = get(a, "targetId");
        // isFreeAim: a position and no target id ("" counts as none); a shot naming both ignores the position.
        if (pos != .null and (tid != .string or tid.string.len == 0)) {
            const x = get(pos, "x");
            const y = get(pos, "y");
            if ((x != .integer and x != .float) or (y != .integer and y != .float)) return error.UnsupportedAim;
            return .{ .range_attack = .{ .attacker = try unitArg(ids, get(a, "attackerId")), .target = 0, .free = true, .tx = num(x), .ty = num(y) } };
        }
        const aim = get(a, "aimCell");
        return .{ .range_attack = .{
            .attacker = try unitArg(ids, get(a, "attackerId")),
            .target = try unitArg(ids, tid),
            .aim_cell = if (aim != .null and get(a, "aimSide") != .null) cell(aim) else null,
            .aim_side = @intCast(int(get(a, "aimSide"))),
        } };
    }
    if (std.mem.eql(u8, t, "area_throw_attack")) {
        const tc = get(a, "targetCell");
        if (tc != .object) return error.MissingCell;
        return .{ .area_throw_attack = .{ .attacker = try unitArg(ids, get(a, "attackerId")), .target_cell = cell(tc) } };
    }
    std.debug.print("unsupported action type {s}\n", .{t});
    return error.UnsupportedAction;
}

/// normalizeFireWallOrientation: a finite number truncated and taken mod 4 (negatives wrap); anything else HORIZONTAL.
fn orientationOf(v: std.json.Value) u8 {
    const x: f64 = switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        else => return 0,
    };
    if (!std.math.isFinite(x)) return 0;
    const t = @trunc(x);
    if (@abs(t) > 1e15) return 0;
    const i: i64 = @intFromFloat(t);
    return @intCast(@mod(i, 4));
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

/// The seed of the game parseGame last started (diagnostics for a game it refuses; -1 before the root parsed).
pub var parse_seed: i64 = -1;
/// The step index parseGame was reading when it refused a game.
pub var parse_step: usize = 0;

/// Parses one recorded game. Everything is allocated from `arena`; `keep_digests` retains the expected digests.
/// On an error `parse_seed` / `parse_step` name the game and step (callers report it and skip the game).
pub fn parseGame(arena: std.mem.Allocator, line: []const u8, keep_digests: bool) !Game {
    parse_seed = -1;
    parse_step = 0;
    const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{});
    return parseGameValue(arena, root, keep_digests);
}

/// parseGame on an already parsed line (callers that also read other keys of the game, e.g. `resume`).
pub fn parseGameValue(arena: std.mem.Allocator, root: std.json.Value, keep_digests: bool) !Game {
    parse_step = 0;
    parse_seed = int(get(root, "seed"));
    const init = get(root, "init");
    const units = get(init, "units").array.items;
    const summon_ids = get(root, "summonIds");
    const n_summons = if (summon_ids == .array) summon_ids.array.items.len else 0;
    if (units.len + n_summons > 255) return error.TooManyUnits;
    const ids = try arena.alloc([]const u8, units.len + n_summons);
    for (units, 0..) |u, i| ids[i] = get(u, "id").string;
    for (0..n_summons) |i| ids[units.len + i] = summon_ids.array.items[i].string;

    const raw_steps = get(root, "steps").array.items;
    const steps = try arena.alloc(Step, raw_steps.len);
    for (raw_steps, 0..) |s, i| {
        parse_step = i;
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
        const stall_raw = get(s, "stall");
        var stall: []const u8 = &.{};
        if (stall_raw == .array) {
            const list = try arena.alloc(u8, stall_raw.array.items.len);
            for (stall_raw.array.items, 0..) |x, j| list[j] = try unitArg(ids, x);
            stall = list;
        }
        steps[i] = .{
            .stall = stall,
            .action = action,
            .r0 = @intCast(int(get(s, "r0"))),
            .r1 = @intCast(int(get(s, "r1"))),
            .draws = @intCast(int(get(s, "draws"))),
            .ok = get(s, "ok") == .null or int(get(s, "ok")) == 1,
            .events = events,
            .digest = if (keep_digests and get(s, "s") != .null) get(s, "s") else null,
            .mindless = get(s, "v") == .string and std.mem.eql(u8, get(s, "v").string, "v0.1"),
        };
    }
    return .{ .seed = int(get(root, "seed")), .ids = ids, .n_start = units.len, .init = init, .steps = steps };
}

/// Iterates the non-empty lines of a JSONL buffer.
pub fn lines(buf: []const u8) std.mem.TokenIterator(u8, .scalar) {
    return std.mem.tokenizeScalar(u8, buf, '\n');
}
