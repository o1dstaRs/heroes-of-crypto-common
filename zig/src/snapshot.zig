//! Loads a live battle exported mid-fight by zig/parity/state_export.ts (`exportBattleState`) into a `State`: the
//! bridge's input format (zig/BRIDGE.md) and the start point of `hoc-sim resume`.
//!
//! Every field the port models is read from the export: units (stats, base stats, buffs, debuffs and effects with
//! laps, powers and stored properties, the active and stolen abilities, auras, the Web lock, the Rallying Volley
//! arrows, turn flags, position, grid registration; summoned units too), the grid (board, aggression boards, terrain
//! and stones), the fight (laps, queues, sets, flags, hit counters), the units holder (distances, Ember Covenant),
//! the AI target memory, the damage-statistic laps, the summon templates and the summon id parts (the harness's
//! battle seed and summon counter), the spellbooks, the vines and the smoke clouds, the teams' artifacts and Barrel
//! Barricade's barrels. Anything non-empty the port does not model (fire walls, unported artifacts or spells, unported
//! abilities, buffs or effects, ranked authoritative stats, ...) is refused as an unsupported state, naming what it
//! found: the loader is fail-closed, like the export's coverage check on the TypeScript side. The refusals' names and
//! limits are tables in scope.zig, which the scope manifest (`hoc_scope_manifest`) exports.
//!
//! Slots: the holder's units take slots 0.. in holder order; the removed units the turn sets still name (made,
//! hourglass, replied) are kept by uid (Fight.removed_*). Uids are indices into the caller's `ids`.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const artifacts = @import("artifacts.zig");
const terrain = @import("terrain.zig");
const uuid = @import("uuid.zig");
const scope = @import("scope.zig");
const Rng = @import("rng.zig").Rng;

const Value = std.json.Value;
const Unit = st.Unit;
const State = st.State;
const Team = st.Team;
const GT = st.GridType;

/// The export versions this loader reads (state_export.ts `version`).
pub const FORMAT_VERSION: i64 = 2;

/// Why a snapshot was refused: `error.UnsupportedState` (valid, but outside the port) or `error.MalformedState` (not
/// the export format), with a short description.
pub const Why = struct {
    buf: [256]u8 = undefined,
    len: usize = 0,

    pub fn text(self: *const Why) []const u8 {
        return self.buf[0..self.len];
    }
    fn put(self: *Why, comptime fmt: []const u8, args: anytype) void {
        const s = std.fmt.bufPrint(&self.buf, fmt, args) catch self.buf[0..];
        self.len = s.len;
    }
    fn unsupported(self: *Why, comptime fmt: []const u8, args: anytype) error{UnsupportedState} {
        self.put(fmt, args);
        return error.UnsupportedState;
    }
    fn malformed(self: *Why, comptime fmt: []const u8, args: anytype) error{MalformedState} {
        self.put(fmt, args);
        return error.MalformedState;
    }
};

pub const Error = error{ UnsupportedState, MalformedState, OutOfMemory };

/// The harness state outside the engine objects: the random stream's state and the active unit (runMatch's
/// currentActiveUnitId). Values given here win over the export's optional `harness` block.
pub const Harness = struct {
    rng: ?u32 = null,
    /// A unit id, or "" for none.
    active: ?[]const u8 = null,
    /// The uid the next summon takes (a recording numbers summons after its start units); default `ids.len`.
    next_uid: ?u8 = null,
};

// =====================================================================================================================
// JSON helpers (the export's tags: $map, $set, $denque, $num, $undefined, $class)
// =====================================================================================================================

fn get(v: Value, key: []const u8) Value {
    return rec.get(v, key);
}

fn has(v: Value, key: []const u8) bool {
    return v == .object and v.object.get(key) != null;
}

/// `undefined` (tagged) or a missing key.
fn isUndefined(v: Value) bool {
    return v == .null or (v == .object and v.object.get("$undefined") != null);
}

/// A number field that may be absent (an exporter that predates it, or `undefined`): 0 then.
fn optionalNumber(v: Value, why: *Why, what: []const u8) Error!f64 {
    if (isUndefined(v)) return 0;
    return number(v, why, what);
}

fn number(v: Value, why: *Why, what: []const u8) Error!f64 {
    return switch (v) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |s| std.fmt.parseFloat(f64, s) catch why.malformed("{s}: bad number", .{what}),
        .object => |o| blk: {
            const tag = o.get("$num") orelse break :blk why.malformed("{s}: not a number", .{what});
            if (tag != .string) break :blk why.malformed("{s}: bad $num", .{what});
            if (std.mem.eql(u8, tag.string, "-0")) break :blk -0.0;
            if (std.mem.eql(u8, tag.string, "NaN")) break :blk std.math.nan(f64);
            if (std.mem.eql(u8, tag.string, "Infinity")) break :blk std.math.inf(f64);
            if (std.mem.eql(u8, tag.string, "-Infinity")) break :blk -std.math.inf(f64);
            break :blk why.malformed("{s}: bad $num {s}", .{ what, tag.string });
        },
        else => why.malformed("{s}: not a number", .{what}),
    };
}

fn field(v: Value, key: []const u8, why: *Why) Error!f64 {
    return number(get(v, key), why, key);
}

fn integer(v: Value, why: *Why, what: []const u8) Error!i64 {
    const f = try number(v, why, what);
    if (f != @trunc(f) or @abs(f) > 1e15) return why.malformed("{s}: not an integer", .{what});
    return @intFromFloat(f);
}

/// An integer that must fit T (a value that does not is refused, never truncated).
fn intAs(comptime T: type, v: Value, why: *Why, what: []const u8) Error!T {
    const i = try integer(v, why, what);
    return std.math.cast(T, i) orelse why.malformed("{s}: {d} out of range", .{ what, i });
}

fn boolean(v: Value, why: *Why, what: []const u8) Error!bool {
    if (v != .bool) return why.malformed("{s}: not a boolean", .{what});
    return v.bool;
}

fn string(v: Value, why: *Why, what: []const u8) Error![]const u8 {
    if (v != .string) return why.malformed("{s}: not a string", .{what});
    return v.string;
}

/// A plain array, or the items of a tagged Set / Denque.
fn items(v: Value, why: *Why, what: []const u8) Error![]const Value {
    switch (v) {
        .array => |a| return a.items,
        .object => |o| {
            const inner = o.get("$set") orelse o.get("$denque") orelse return why.malformed("{s}: not a list", .{what});
            if (inner != .array) return why.malformed("{s}: bad list", .{what});
            return inner.array.items;
        },
        else => return why.malformed("{s}: not a list", .{what}),
    }
}

/// The [key, value] entries of a tagged Map.
fn mapEntries(v: Value, why: *Why, what: []const u8) Error![]const Value {
    const inner = get(v, "$map");
    if (inner != .array) return why.malformed("{s}: not a $map", .{what});
    for (inner.array.items) |e| {
        if (e != .array or e.array.items.len != 2) return why.malformed("{s}: bad $map entry", .{what});
    }
    return inner.array.items;
}

/// A $map, or a plain object: the value for `key` (a unit id or a team number).
fn lookup(v: Value, key: []const u8, why: *Why, what: []const u8) Error!?Value {
    if (v == .object and v.object.get("$map") == null) return v.object.get(key);
    for (try mapEntries(v, why, what)) |e| {
        const k = e.array.items[0];
        switch (k) {
            .string => |s| if (std.mem.eql(u8, s, key)) return e.array.items[1],
            .integer => |i| {
                var buf: [24]u8 = undefined;
                const t = std.fmt.bufPrint(&buf, "{d}", .{i}) catch continue;
                if (std.mem.eql(u8, t, key)) return e.array.items[1];
            },
            else => {},
        }
    }
    return null;
}

fn requireEmpty(v: Value, why: *Why, what: []const u8) Error!void {
    if (isUndefined(v)) return;
    const n: usize = switch (v) {
        .array => |a| a.items.len,
        .string => |s| s.len,
        .object => |o| blk: {
            if (o.get("$map")) |m| break :blk if (m == .array) m.array.items.len else 1;
            if (o.get("$set")) |m| break :blk if (m == .array) m.array.items.len else 1;
            if (o.get("$denque")) |m| break :blk if (m == .array) m.array.items.len else 1;
            break :blk o.count();
        },
        .bool => |b| @intFromBool(b),
        .integer => |i| @intCast(@intFromBool(i != 0)),
        .float => |f| @intFromBool(f != 0),
        else => 1,
    };
    if (n != 0) return why.unsupported("{s} is not empty", .{what});
}

fn unitIndexOf(ids: []const []const u8, id: []const u8, why: *Why, what: []const u8) Error!u8 {
    return rec.unitIndex(ids, id) catch why.malformed("{s}: unknown unit {s}", .{ what, id });
}

/// An optional unit id property (undefined or "" = none) as a uid.
fn linkId(v: Value, ids: []const []const u8, why: *Why, what: []const u8) Error!u8 {
    if (isUndefined(v)) return st.NO_UID;
    if (v != .string) return why.unsupported("{s} that is not an id", .{what});
    if (v.string.len == 0) return st.NO_UID;
    return unitIndexOf(ids, v.string, why, what);
}

/// A Helping Hand row's stored properties: the caster's max hp and base armor at the cast.
fn helpingHandProperties(o: Value, why: *Why) Error![2]f64 {
    const hp = get(o, "firstSpellProperty");
    const armor = get(o, "secondSpellProperty");
    if (isUndefined(hp) or isUndefined(armor)) return why.unsupported("a Helping Hand row without its stored properties", .{});
    return .{ try number(hp, why, "Helping Hand max hp"), try number(armor, why, "Helping Hand base armor") };
}

fn cellOf(v: Value, why: *Why, what: []const u8) Error!st.Cell {
    if (v == .array and v.array.items.len == 2) {
        return .{ .x = try intAs(i32, v.array.items[0], why, what), .y = try intAs(i32, v.array.items[1], why, what) };
    }
    return .{ .x = try intAs(i32, get(v, "x"), why, what), .y = try intAs(i32, get(v, "y"), why, what) };
}

// =====================================================================================================================
// Loading
// =====================================================================================================================

/// The snapshot's unit ids (the index order a caller without a recording uses): the holder's units in insertion order,
/// then the ids of units already removed from the holder that the fight's turn sets, the AI target memory, the holder's
/// distances or a unit's forbidden target (a dead gazer's id stays until the fright ends) still name (TypeScript keeps
/// them), in order of first mention. Slices into `root`.
pub fn unitIds(arena: std.mem.Allocator, root: Value, why: *Why) Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    const units = try items(get(root, "units"), why, "units");
    for (units) |u| try out.append(arena, try string(get(u, "id"), why, "unit id"));
    const fight = get(root, "fight");
    var mentioned: std.ArrayList(Value) = .empty;
    for ([_][]const u8{ "alreadyMadeTurn", "alreadyHourglass", "alreadyRepliedAttack", "upNextQueue", "hourglassQueue", "moralePlusQueue", "moraleMinusQueue" }) |key| {
        try mentioned.appendSlice(arena, try items(get(fight, key), why, key));
    }
    for (try mapEntries(get(fight, "alreadyMadeTurnByTeam"), why, "alreadyMadeTurnByTeam")) |e| {
        try mentioned.appendSlice(arena, try items(e.array.items[1], why, "alreadyMadeTurnByTeam"));
    }
    for (try items(get(root, "aiTargetMemory"), why, "aiTargetMemory")) |e| {
        if (e == .array) try mentioned.appendSlice(arena, e.array.items);
    }
    for (try mapEntries(get(get(root, "holder"), "distancesToClosestEnemies"), why, "distancesToClosestEnemies")) |e| {
        try mentioned.append(arena, e.array.items[0]);
    }
    for (units) |u| {
        const f = get(get(get(u, "fields"), "unitProperties"), "forbidden_target");
        if (f == .string and f.string.len > 0) try mentioned.append(arena, f);
    }
    for (mentioned.items) |m| {
        const id = try string(m, why, "unit id");
        if (rec.unitIndex(out.items, id)) |_| {} else |_| try out.append(arena, id);
    }
    if (out.items.len > st.MAX_UIDS) return why.unsupported("{d} unit ids (at most {d})", .{ out.items.len, st.MAX_UIDS });
    return out.items;
}

/// The slot of unit id `id` (its uid in `ids`), or null when the unit has none (removed, and no longer named by the
/// turn sets).
fn slotOfId(s: *const State, ids: []const []const u8, id: []const u8, why: *Why, what: []const u8) Error!?u8 {
    const uid = try unitIndexOf(ids, id, why, what);
    return s.slotOf(uid);
}

fn requireSlot(s: *const State, ids: []const []const u8, id: []const u8, why: *Why, what: []const u8) Error!u8 {
    return (try slotOfId(s, ids, id, why, what)) orelse why.unsupported("{s}: unit {s} is no longer in the battle", .{ what, id });
}

/// Loads `root` (an exportBattleState object) into a State whose unit indices follow `ids`: every snapshot unit must
/// appear in `ids`, in the same relative order (the holder's insertion order); an id of `ids` missing from the snapshot
/// is a unit already removed from the holder (`in_holder` false). Pass `unitIds(root)` when there is no recording.
pub fn load(root: Value, ids: []const []const u8, harness: Harness, why: *Why) Error!State {
    var s: State = undefined;
    why.len = 0;
    const version = get(root, "version");
    if (version != .integer or version.integer != FORMAT_VERSION) return why.malformed("export version is not {d}", .{FORMAT_VERSION});
    const configs = get(root, "configs");
    if (configs != .object) return why.malformed("no configs", .{});
    const grid = get(root, "grid");
    const fight = get(root, "fight");
    const holder = get(root, "holder");
    if (grid != .object or fight != .object or holder != .object) return why.malformed("missing grid, fight or holder", .{});
    if (ids.len > st.MAX_UIDS) return why.unsupported("{d} unit ids (at most {d})", .{ ids.len, st.MAX_UIDS });

    // ---- slots: the holder's units in holder order ----
    const units = try items(get(root, "units"), why, "units");
    var slot_uids: [st.MAX_UNITS]u8 = undefined;
    var n_slots: usize = 0;
    var previous: i32 = -1;
    for (units) |uv| {
        const id = try string(get(uv, "id"), why, "unit id");
        const uid = try unitIndexOf(ids, id, why, "units");
        if (@as(i32, uid) <= previous) return why.unsupported("unit {s} out of holder order", .{id});
        previous = uid;
        if (n_slots >= st.MAX_UNITS) return why.unsupported("more than {d} units in the holder", .{st.MAX_UNITS});
        slot_uids[n_slots] = uid;
        n_slots += 1;
    }
    const n_holder = n_slots;
    s.n_units = @intCast(n_slots);
    s.n_holder = @intCast(n_holder);
    s.n_aura_defs = 0;
    s.overflow = false;
    s.summons = null;
    s.spell_cfg = .{st.SpellConfig{}} ** st.N_CAST_SPELLS;
    engine.loadSpellConfigs(&s, get(configs, "spellConfigs"));
    for (&s.setup, 0..) |*row, t| row.* = engine.loadTeamSetup(root, @intCast(t));
    for (s.units[0..s.n_units], 0..) |*u, i| {
        // A unit removed from the holder before the snapshot: nothing reads it again (every unit loop goes over the
        // holder); it keeps only its slot and uid for the turn sets.
        u.* = std.mem.zeroes(Unit);
        u.in_holder = false;
        u.target = -1;
        u.forbidden = st.NO_UID;
        u.uid = slot_uids[i];
        if (i < n_holder) s.holder[i] = @intCast(i);
        if (uuid.parse(ids[slot_uids[i]])) |b| {
            u.uuid = b;
            u.uuid_ok = true;
        }
    }
    s.next_uid = harness.next_uid orelse @intCast(ids.len);

    // ---- units ----
    var names: [st.MAX_UNITS][]const u8 = undefined;
    var n_names: u16 = 0;
    for (units, 0..) |uv, slot| {
        const idx: u8 = @intCast(slot);
        const name = try string(get(uv, "name"), why, "unit name");
        var name_id: u16 = n_names;
        for (names[0..n_names], 0..) |known, k| {
            if (std.mem.eql(u8, known, name)) name_id = @intCast(k);
        }
        if (name_id == n_names) {
            names[n_names] = name;
            n_names += 1;
        }
        try loadUnit(&s, root, configs, uv, ids, idx, name_id, why);
    }

    // ---- summon templates and the summon id parts ----
    s.summons = engine.loadSummons(configs, get(configs, "summonTemplates"), &s) catch |err| return switch (err) {
        error.UnsupportedAbility => why.unsupported("summon ability {s}", .{engine.unsupported_name}),
        error.UnsupportedAura => why.unsupported("summon aura {s}", .{engine.unsupported_name}),
        else => why.malformed("summon templates: {s}", .{@errorName(err)}),
    };
    engine.summonNameIds(&s, names[0..n_names]);
    const hv = get(root, "harness");
    s.has_seed = get(hv, "seed") == .integer;
    s.seed = if (s.has_seed) @floatFromInt(get(hv, "seed").integer) else 0;
    s.summon_seq = if (get(hv, "summonSequence") == .integer) try intAs(u32, get(hv, "summonSequence"), why, "harness.summonSequence") else 0;
    s.uuid_seq = if (get(hv, "uuidSequence") == .integer) try intAs(u64, get(hv, "uuidSequence"), why, "harness.uuidSequence") else 0;
    s.id_scheme = .match;

    // ---- flags and configs read without an ability naming them ----
    engine.loadScopeFlags(&s, configs) catch |err| return why.malformed("configs: {s}", .{@errorName(err)});

    // ---- grid and terrain ----
    try loadGrid(&s, grid, fight, ids, why);

    // ---- fight ----
    try loadFight(&s, fight, root, ids, why);

    // ---- units holder ----
    const ember_seeded = get(holder, "emberCovenantSeeded");
    s.ember_seeded = ember_seeded == .bool and ember_seeded.bool;
    s.ember_teams = 0;
    for (try items(get(holder, "emberCovenantTeams"), why, "emberCovenantTeams")) |t| {
        const team = try integer(t, why, "emberCovenantTeams");
        if (team < 0 or team > Team.LEFT) return why.malformed("emberCovenantTeams: team {d}", .{team});
        s.ember_teams |= @as(u8, 1) << @intCast(team);
    }
    // The distances of removed units are never read again (only living holder units are measured).
    const distances = get(holder, "distancesToClosestEnemies");
    for (try mapEntries(distances, why, "distancesToClosestEnemies")) |e| {
        const ui = (try slotOfId(&s, ids, try string(e.array.items[0], why, "distances"), why, "distances")) orelse continue;
        s.units[ui].dist_known = true;
        s.units[ui].dist_closest_enemy = try number(e.array.items[1], why, "distances");
    }

    // ---- AI target memory and the damage-statistic laps ----
    // A remembered unit that left the battle matches no enemy again (findTarget looks it up among the living), and a
    // removed attacker never decides: such entries are dropped.
    s.ai_prev_target = .{-1} ** st.MAX_UNITS;
    for (try items(get(root, "aiTargetMemory"), why, "aiTargetMemory")) |e| {
        if (e != .array or e.array.items.len != 2) return why.malformed("aiTargetMemory entry", .{});
        const a = (try slotOfId(&s, ids, try string(e.array.items[0], why, "aiTargetMemory"), why, "aiTargetMemory")) orelse continue;
        const t = (try slotOfId(&s, ids, try string(e.array.items[1], why, "aiTargetMemory"), why, "aiTargetMemory")) orelse continue;
        s.ai_prev_target[a] = @intCast(t);
    }
    s.damage_lap = -1;
    for (try items(get(root, "damageStatLaps"), why, "damageStatLaps")) |l| {
        const lap = try intAs(i32, l, why, "damageStatLaps");
        if (lap > s.damage_lap) s.damage_lap = lap;
    }

    // ---- harness ----
    s.rng = Rng.init(0);
    if (harness.rng) |r| {
        s.rng = Rng.init(r);
    } else if (get(hv, "rng") == .integer) {
        s.rng = Rng.init(@intCast(try integer(get(hv, "rng"), why, "harness.rng") & 0xffffffff));
    }
    s.active = -1;
    const active_id: []const u8 = harness.active orelse if (get(hv, "activeUnitId") == .string) get(hv, "activeUnitId").string else "";
    if (active_id.len > 0) {
        const ai = (try slotOfId(&s, ids, active_id, why, "active unit")) orelse return why.malformed("active unit {s} is not in the holder", .{active_id});
        if (!s.units[ai].in_holder) return why.malformed("active unit {s} is not in the holder", .{active_id});
        s.active = @intCast(ai);
    }
    return s;
}

/// Fails unless the unit-level fields the port does not model are empty or at their defaults.
fn checkUnitScope(uv: Value, fields: Value, props: Value, why: *Why) Error!void {
    // Summoned units: the creatures Infest and Summon Wolves raise.
    if (get(uv, "summoned") == .bool and get(uv, "summoned").bool) {
        const name = try string(get(uv, "name"), why, "unit name");
        var known = false;
        for (st.SUMMON_NAMES) |n| {
            if (std.mem.eql(u8, name, n)) known = true;
        }
        if (!known) return why.unsupported("summoned {s}", .{name});
    }
    const unit_type = get(uv, "unitType");
    var creature = false;
    for (scope.UNIT_TYPES) |t| {
        if (unit_type == .integer and unit_type.integer == t) creature = true;
    }
    if (!creature) return why.unsupported("unit type is not a creature", .{});
    // Lists that may hold only the names scope.zig accepts: the Wounding Charm lends "Deep Wounds Level 1" (the only
    // artifact-granted card); the card itself is in the ability lists, the record only matters to a re-apply, which
    // runMatch and rollouts never do.
    for (scope.LIMITED_UNIT_PROPS) |f| {
        const list = get(props, f.key);
        if (isUndefined(list)) continue;
        for (try items(list, why, f.key)) |g| {
            if (!f.accepts(try string(g, why, f.key))) return why.unsupported("{s}", .{f.what});
        }
    }
    for (scope.REFUSED_UNIT_PROPS) |f| try requireEmpty(get(props, f.key), why, f.what);
    if (props == .object) {
        var it = props.object.iterator();
        while (it.next()) |e| {
            // The ranked client's authoritative stats (`*_authoritative`); spell_entries_authoritative only says the
            // spell list was built (spells must be empty anyway).
            const key = e.key_ptr.*;
            if (scope.refusedAuthoritative(key)) try requireEmpty(e.value_ptr.*, why, key);
        }
    }
    for (scope.REFUSED_UNIT_FIELDS) |f| try requireEmpty(get(fields, f.key), why, f.what);
    // Last Fuse: TypeScript records a fatal hit on every killing blow; only one with a source (the striker's Last Fuse
    // row) is pending state the port does not load. A sourceless one (a corpse a step left in the holder) is the port's
    // empty `fuse`. (scope.REFUSED_UNIT_FIELD_PARTS)
    for (scope.REFUSED_UNIT_FIELD_PARTS) |f| {
        const v = get(fields, f.key);
        if (!isUndefined(v) and !isUndefined(get(v, f.inner.?))) return why.unsupported("{s}", .{f.what});
    }
}

/// The unit's spellbook: the raw entries (props.spells "<Faction>:<Name>", one per charge) and the parsed Spell objects
/// (`spells`: name, amountRemaining; spent ones included), whose spellProperties give the configs. A spell outside the
/// port (CastSpell) is refused by name.
fn loadBook(s: *State, u: *Unit, fields: Value, props: Value, why: *Why) Error!void {
    u.n_book = 0;
    u.n_spells = 0;
    const entries = get(props, "spells");
    if (!isUndefined(entries)) {
        const list = try items(entries, why, "spells");
        if (list.len > st.MAX_BOOK) return why.unsupported("{d} spell entries (at most {d})", .{ list.len, st.MAX_BOOK });
        for (list) |e| {
            const entry = try string(e, why, "spells");
            u.book[u.n_book] = engine.parseBookEntry(entry) catch return why.unsupported("spell {s}", .{entry});
            u.n_book += 1;
        }
    }
    const objects = try items(get(fields, "spells"), why, "spells");
    if (objects.len > st.MAX_BOOK_SPELLS) return why.unsupported("{d} spells (at most {d})", .{ objects.len, st.MAX_BOOK_SPELLS });
    for (objects) |o| {
        const sp = get(o, "spellProperties");
        const name = try string(get(sp, "name"), why, "spell name");
        const spell = st.CastSpell.fromName(name) orelse return why.unsupported("spell {s}", .{name});
        const amount = try intAs(u8, get(o, "amountRemaining"), why, "amountRemaining");
        // The parse key's faction (an empty faction is "System": normalizeSpellEntry gives both ":X").
        const faction = get(sp, "faction");
        var prefix: u8 = st.BookEntry.NO_FACTION;
        if (faction == .integer) {
            prefix = scope.spellFactionPrefix(faction.integer) orelse return why.unsupported("spell {s} of faction {d}", .{ name, faction.integer });
        }
        u.spells[u.n_spells] = .{ .spell = @intFromEnum(spell), .prefix = prefix, .amount = amount };
        u.n_spells += 1;
        if (!s.spell_cfg[@intFromEnum(spell)].loaded and sp == .object) s.spell_cfg[@intFromEnum(spell)] = engine.spellConfigOf(sp);
    }
}

/// The names of the unit's Ability objects (its ACTIVE list: config order, then what it stole), as JSON strings.
fn activeNames(arena: []Value, objects: []const Value, why: *Why) Error![]const Value {
    if (objects.len > arena.len) return why.unsupported("{d} active abilities (at most {d})", .{ objects.len, arena.len });
    for (objects, 0..) |o, i| arena[i] = .{ .string = try string(get(get(o, "abilityProperties"), "name"), why, "abilityProperties") };
    return arena[0..objects.len];
}

/// The names of a list of class instances (`abilities`, `auraEffects`) must be the props' name list, in order.
fn checkNames(objects: []const Value, names: []const Value, comptime props_key: []const u8, why: *Why) Error!void {
    if (objects.len != names.len) return why.unsupported("{s}: {d} objects for {d} names", .{ props_key, objects.len, names.len });
    for (objects, names) |o, n| {
        const inner = get(o, props_key);
        const got = try string(get(inner, "name"), why, props_key);
        const want = try string(n, why, props_key);
        if (!std.mem.eql(u8, got, want)) return why.unsupported("{s} {s} differs from props ({s})", .{ props_key, got, want });
    }
}

/// A stored spell property (getFirst/SecondSpellProperty): -1 for undefined; only small integers are modelled (the
/// aura rows' source cells and the Sniper Augment's percentages).
fn storedProperty(v: Value, why: *Why) Error!i8 {
    if (isUndefined(v)) return -1;
    const x = try number(v, why, "spell property");
    if (x != @trunc(x) or x < 0 or x > scope.MAX_STORED_PROPERTY) return why.unsupported("stored spell property {d}", .{x});
    return @intFromFloat(x);
}

/// The applied lists from the props' parallel arrays (engine.loadSpells), cross-checked against the AppliedSpell /
/// Effect objects (name, laps, power, in order), which also give the buffs' stored properties.
fn loadLists(u: *Unit, fields: Value, props: Value, why: *Why) Error!void {
    u.buffs = engine.loadSpells(@TypeOf(u.buffs), props, "buffs") catch |err| return spellError(err, why);
    u.debuffs = engine.loadSpells(@TypeOf(u.debuffs), props, "debuffs") catch |err| return spellError(err, why);
    u.effects = engine.loadSpells(@TypeOf(u.effects), props, "effects") catch |err| return spellError(err, why);
    const lists = [_]struct { []const u8, []const st.AppliedSpell }{
        .{ "buffs", u.buffs.items[0..u.buffs.len] },
        .{ "debuffs", u.debuffs.items[0..u.debuffs.len] },
        .{ "effects", u.effects.items[0..u.effects.len] },
    };
    u.aug_orphans = 0;
    for (lists, 0..) |l, li| {
        const objects = try items(get(fields, l[0]), why, l[0]);
        // A Resurrection revive (deleteAllBuffs) keeps the augment display rows without their objects: a leading run of
        // augment names with no object is the unit's orphan rows; the rest match the objects one to one.
        var skip: usize = 0;
        if (li == 0 and objects.len < l[1].len) {
            skip = l[1].len - objects.len;
            for (l[1][0..skip]) |a| {
                if (!a.id.isAugment()) return why.unsupported("buffs: {d} objects for {d} applied names", .{ objects.len, l[1].len });
            }
            u.aug_orphans = @intCast(skip);
        }
        if (objects.len != l[1].len - skip) return why.unsupported("{s}: {d} objects for {d} applied names", .{ l[0], objects.len, l[1].len });
        for (objects, l[1][skip..], skip..) |o, a, k| {
            // AppliedSpell {name, power, lapsRemaining}; Effect {effectProperties: {name, laps, power, stacks}}.
            const ep = get(o, "effectProperties");
            const props_obj = if (ep == .object) ep else o;
            const name = try string(get(props_obj, "name"), why, l[0]);
            const laps = try number(if (ep == .object) get(ep, "laps") else get(o, "lapsRemaining"), why, "laps");
            const power = try number(get(props_obj, "power"), why, "power");
            // A duplicate debuff row (a mirrored Spit Ball debuff) ticks its display laps faster than its object laps:
            // the object governs expiry, the display list is what the digest shows (AppliedSpell.lag).
            if (li == 1 and std.mem.eql(u8, name, a.id.name()) and power == a.power and laps != a.laps) {
                const lag = laps - a.laps;
                if (lag != @trunc(lag) or @abs(lag) > 1000) return why.unsupported("debuffs: object {s} laps {d}", .{ name, laps });
                u.debuffs.items[k].laps = laps;
                u.debuffs.items[k].lag = @intFromFloat(lag);
                continue;
            }
            if (!std.mem.eql(u8, name, a.id.name()) or laps != a.laps or power != a.power) {
                return why.unsupported("{s}: object {s} differs from the applied list", .{ l[0], name });
            }
            if (ep == .object and a.id != .poison) {
                // Poison's stack count only feeds its description; any other effect with stacks is outside the port.
                const stacks = get(ep, "stacks");
                if (!isUndefined(stacks) and try number(stacks, why, "stacks") != 1) return why.unsupported("{s} with stacks", .{name});
            }
        }
    }
    const stacks = get(props, "applied_effects_stacks");
    if (stacks == .array) {
        for (stacks.array.items, 0..) |x, i| {
            const poison = i < u.effects.len and u.effects.items[i].id == .poison;
            if (!poison and (x != .integer or x.integer != 1)) return why.unsupported("effect stacks other than 1", .{});
        }
    }
    // Stored properties: the aura rows' source cells (buff and debuff rows), the augments' (Sniper "27;70") and the
    // artifact rows' (scope.storesProperties), as engine.loadBuffSources.
    // Helping Hand's rows keep theirs on the unit (one row of the name per list).
    const objects = try items(get(fields, "buffs"), why, "buffs");
    var gifts: u8 = 0;
    for (objects, 0..) |o, i| {
        const b = &u.buffs.items[u.aug_orphans + i];
        if (b.id == .helping_hand) {
            gifts += 1;
            if (gifts > 1) return why.unsupported("two Helping Hand buff rows", .{});
            u.hh_gift = try helpingHandProperties(o, why);
            continue;
        }
        if (b.laps != st.LAPS_AURA and !scope.storesProperties(b.id)) continue;
        b.src_x = try storedProperty(get(o, "firstSpellProperty"), why);
        b.src_y = try storedProperty(get(o, "secondSpellProperty"), why);
    }
    var costs: u8 = 0;
    for (try items(get(fields, "debuffs"), why, "debuffs"), 0..) |o, i| {
        const b = &u.debuffs.items[i];
        if (b.id == .helping_hand) {
            costs += 1;
            if (costs > 1) return why.unsupported("two Helping Hand debuff rows", .{});
            u.hh_cost = try helpingHandProperties(o, why);
            continue;
        }
        if (b.laps != st.LAPS_AURA) continue;
        b.src_x = try storedProperty(get(o, "firstSpellProperty"), why);
        b.src_y = try storedProperty(get(o, "secondSpellProperty"), why);
    }
}

fn spellError(err: anyerror, why: *Why) Error {
    return switch (err) {
        error.UnsupportedSpell => why.unsupported("buff, debuff or effect {s}", .{engine.unsupported_name}),
        error.TooManySpells => why.unsupported("more applied spells than the lists hold", .{}),
        else => why.malformed("applied lists: {s}", .{@errorName(err)}),
    };
}

fn loadUnit(s: *State, root: Value, configs: Value, uv: Value, ids: []const []const u8, idx: u8, name_id: u16, why: *Why) Error!void {
    const uid = s.units[idx].uid;
    const id_bytes = s.units[idx].uuid;
    const id_ok = s.units[idx].uuid_ok;
    _ = root;
    const fields = get(uv, "fields");
    const props = get(fields, "unitProperties");
    const base = get(fields, "initialUnitProperties");
    if (props != .object or base != .object) return why.malformed("unit without properties", .{});
    try checkUnitScope(uv, fields, props, why);
    const sel = try integer(get(fields, "selectedAttackType"), why, "selectedAttackType");
    if (sel != try integer(get(props, "attack_type_selected"), why, "attack_type_selected")) {
        return why.unsupported("selectedAttackType {d} differs from attack_type_selected", .{sel});
    }
    const pos = get(fields, "position");
    const team = try integer(get(uv, "team"), why, "team");
    if (team != Team.LEFT and team != Team.RIGHT) return why.unsupported("team {d}", .{team});
    const fw = try integer(get(props, "footprint_width"), why, "footprint_width");
    const fh = try integer(get(props, "footprint_height"), why, "footprint_height");
    if (fw < scope.FOOTPRINT_MIN or fw > scope.FOOTPRINT_MAX or fh < scope.FOOTPRINT_MIN or fh > scope.FOOTPRINT_MAX) return why.unsupported("footprint {d}x{d}", .{ fw, fh });
    const cid = get(uv, "creatureId");
    s.units[idx] = .{
        .in_holder = true,
        .creature_id = if (cid == .integer and cid.integer >= 0 and cid.integer < 65536) @intCast(cid.integer) else 0,
        .team = @intCast(team),
        .faction = try intAs(u8, get(props, "faction"), why, "faction"),
        .level = try intAs(u8, get(props, "level"), why, "level"),
        .size = try intAs(u8, get(props, "size"), why, "size"),
        .fw = @intCast(fw),
        .fh = @intCast(fh),
        .attack_type = try intAs(u8, get(props, "attack_type"), why, "attack_type"),
        .attack_type_selected = @intCast(sel),
        .movement_type = try intAs(u8, get(props, "movement_type"), why, "movement_type"),
        .base = .{ .x = 0, .y = 0 },
        .pos_x = try field(pos, "x", why),
        .pos_y = try field(pos, "y", why),
        .cells = undefined,
        .n_cells = 0,
        .max_hp = try field(props, "max_hp", why),
        .hp = try field(props, "hp", why),
        .steps = try field(props, "steps", why),
        .steps_mod = try field(props, "steps_mod", why),
        .morale = try field(props, "morale", why),
        .luck = try field(props, "luck", why),
        .initiative = try field(props, "initiative", why),
        .armor_mod = try field(props, "armor_mod", why),
        .base_armor = try field(props, "base_armor", why),
        .range_armor = try field(props, "range_armor", why),
        .base_attack = try field(props, "base_attack", why),
        .attack_mod = try field(props, "attack_mod", why),
        .attack_damage_min = try field(props, "attack_damage_min", why),
        .attack_damage_max = try field(props, "attack_damage_max", why),
        .attack_range = try field(props, "attack_range", why),
        .range_shots = try field(props, "range_shots", why),
        .range_shots_mod = try field(props, "range_shots_mod", why),
        .shot_distance = try field(props, "shot_distance", why),
        .magic_resist = try field(props, "magic_resist", why),
        .magic_resist_mod = try field(props, "magic_resist_mod", why),
        .exp = try field(props, "exp", why),
        .amount_alive = try field(props, "amount_alive", why),
        .amount_died = try field(props, "amount_died", why),
        .luck_mod = try field(props, "luck_mod", why),
        .attack_multiplier = try field(props, "attack_multiplier", why),
        .stack_power = try field(props, "stack_power", why),
        .responded = try boolean(get(fields, "responded"), why, "responded"),
        .on_hourglass = try boolean(get(fields, "onHourglass"), why, "onHourglass"),
        .moved_this_turn = try boolean(get(fields, "movedThisTurn"), why, "movedThisTurn"),
        .we_base = try optionalNumber(get(fields, "warlordsEdgeAttackBase"), why, "warlordsEdgeAttackBase"),
        .we_bonus = try optionalNumber(get(fields, "warlordsEdgeAppliedAttackBonus"), why, "warlordsEdgeAppliedAttackBonus"),
        .buffs = .{},
        .debuffs = .{},
        .effects = .{},
        .init = .{
            .max_hp = try field(base, "max_hp", why),
            .luck = try field(base, "luck", why),
            .morale = try field(base, "morale", why),
            .base_armor = try field(base, "base_armor", why),
            .armor_mod = try field(base, "armor_mod", why),
            .base_attack = try field(base, "base_attack", why),
            .attack_mod = try field(base, "attack_mod", why),
            .attack_damage_min = try field(base, "attack_damage_min", why),
            .attack_damage_max = try field(base, "attack_damage_max", why),
            .steps = try field(base, "steps", why),
            .initiative = try field(base, "initiative", why),
            .magic_resist = try field(base, "magic_resist", why),
            .shot_distance = try field(base, "shot_distance", why),
            .amount_alive = try field(base, "amount_alive", why),
        },
        .luck_per_turn = try field(fields, "luckPerTurn", why),
        .adjusted_laps = 0,
        .dist_known = false,
        .dist_closest_enemy = 0,
        .name_id = name_id,
        .possible = .{ 0, 0, 0, 0 },
        .n_possible = 0,
        .reg = undefined,
        .n_reg = 0,
        .abilities = undefined,
        .n_abilities = 0,
        .ability_mask = 0,
        .luck_dependent = false,
        .moved_route_cells = try field(fields, "movedRouteCellsThisTurn", why),
        .target = -1,
        .auras = undefined,
        .n_auras = 0,
        .syn_power = 0,
        .uid = uid,
        .uuid = id_bytes,
        .uuid_ok = id_ok,
    };
    const u = &s.units[idx];
    u.syn_power = s.setup[u.team].ability_power;
    // Unit.maxRangeShots (the constructor's range_shots, Limited Supply's base): hidden, exported as a unit field.
    u.max_range_shots = try field(fields, "maxRangeShots", why);
    // War Anger's hidden state: currentAttackModIncrease (what the last increaseAttackMod added; 0 or undefined for
    // a non-holder).
    const inc = get(fields, "currentAttackModIncrease");
    u.attack_mod_increase = if (isUndefined(inc)) 0 else try number(inc, why, "currentAttackModIncrease");
    const rv = get(props, "rallying_volley_granted");
    u.rallying_volley_granted = if (isUndefined(rv)) 0 else try number(rv, why, "rallying_volley_granted");
    const web = get(props, "web_movement_locked");
    u.web_locked = !isUndefined(web) and try boolean(web, why, "web_movement_locked");

    // Abilities and auras from the configs (the same loaders as a recording's start state), checked against the
    // unit's Ability / AuraEffect objects: the active list is the Ability objects (stolen ones included), the card list
    // props.abilities, and props.stolen_abilities what the unit lost.
    var active_buf: [st.MAX_ABILITIES]Value = undefined;
    const active = try activeNames(&active_buf, try items(get(fields, "abilities"), why, "abilities"), why);
    const stolen_v = get(props, "stolen_abilities");
    engine.loadUnitAbilities(configs, active, try items(get(props, "abilities"), why, "abilities"), if (isUndefined(stolen_v)) &.{} else try items(stolen_v, why, "stolen_abilities"), s, u) catch |err| return switch (err) {
        error.UnsupportedAbility => why.unsupported("ability {s}", .{engine.unsupported_name}),
        error.UnsupportedAura => why.unsupported("aura {s}", .{engine.unsupported_name}),
        error.TooManyAbilities => why.unsupported("more abilities than the port holds", .{}),
        else => why.malformed("abilities: {s}", .{@errorName(err)}),
    };
    engine.loadAuras(configs, props, s, u) catch |err| return switch (err) {
        error.UnsupportedAura => why.unsupported("aura {s}", .{engine.unsupported_name}),
        else => why.malformed("auras: {s}", .{@errorName(err)}),
    };
    const aura_names = get(props, "aura_effects");
    const aura_objects = try items(get(fields, "auraEffects"), why, "auraEffects");
    try checkNames(aura_objects, if (aura_names == .array) aura_names.array.items else &.{}, "auraEffectProperties", why);
    // The power the War Anger AuraEffect holds now (the last aura refresh that iterated it), read by the attack mod.
    for (aura_objects) |o| {
        const ap = get(o, "auraEffectProperties");
        if (std.mem.eql(u8, try string(get(ap, "name"), why, "auraEffectProperties"), "War Anger")) u.war_anger_power = try number(get(ap, "power"), why, "War Anger power");
    }

    const target = get(props, "target");
    if (target == .string and target.string.len > 0) u.target = @intCast(try requireSlot(s, ids, target.string, why, "target"));
    // Terrifying Gaze's lock names the gazer by id (a removed one too): kept as its uid.
    const forbidden = get(props, "forbidden_target");
    u.forbidden = st.NO_UID;
    if (forbidden == .string and forbidden.string.len > 0) u.forbidden = try unitIndexOf(ids, forbidden.string, why, "forbidden_target");
    // Helping Hand's link (spells/helping_hand.ts) names the caster and the penalty unit by id: kept as uids.
    u.hh_caster = try linkId(get(props, "helping_hand_caster_id"), ids, why, "helping_hand_caster_id");
    u.hh_penalty = try linkId(get(props, "helping_hand_penalty_id"), ids, why, "helping_hand_penalty_id");
    try loadLists(u, fields, props, why);
    try loadBook(s, u, fields, props, why);
    u.summoned = get(uv, "summoned") == .bool and get(uv, "summoned").bool;

    for (try items(get(fields, "adjustedBaseStatsLaps"), why, "adjustedBaseStatsLaps")) |l| {
        const lap = try integer(l, why, "adjustedBaseStatsLaps");
        if (lap < 0 or lap >= 128) return why.unsupported("adjusted lap {d}", .{lap});
        u.adjusted_laps |= @as(u128, 1) << @intCast(lap);
    }
    const possible = try items(get(fields, "possibleAttackTypes"), why, "possibleAttackTypes");
    if (possible.len > u.possible.len or possible.len > scope.MAX_POSSIBLE_ATTACK_TYPES) return why.unsupported("{d} possible attack types", .{possible.len});
    for (possible, 0..) |p, k| u.possible[k] = try intAs(u8, p, why, "possibleAttackTypes");
    u.n_possible = @intCast(possible.len);
}

fn loadGrid(s: *State, grid: Value, fight: Value, ids: []const []const u8, why: *Why) Error!void {
    const gt = try integer(get(fight, "gridType"), why, "gridType");
    if (gt != try integer(get(grid, "gridType"), why, "grid.gridType")) return why.malformed("grid and fight grid types differ", .{});
    if (!scope.gridTypeAccepted(gt)) return why.unsupported("grid type {d}", .{gt});
    for (scope.REFUSED_GRID_FIELDS) |f| try requireEmpty(get(grid, f.key), why, f.what);
    s.fight = .{};
    s.fight.grid_type = @intCast(gt);

    // Terrain: the layout in roll order, the standing stones (packed (x << 8) | y), the cleared sides and the dried centre.
    const t = &s.grid.terrain;
    t.* = .{};
    const layout = try items(get(grid, "scatteredMountainLayout"), why, "scatteredMountainLayout");
    if (layout.len > st.MAX_STONES) return why.unsupported("{d} stones", .{layout.len});
    for (layout, 0..) |c, i| {
        t.layout[i] = try cellOf(c, why, "scatteredMountainLayout");
        if (!engine.cellWithinGrid(t.layout[i])) return why.malformed("stone off the board", .{});
    }
    t.n_layout = @intCast(layout.len);
    for (try items(get(grid, "scatteredMountainsStanding"), why, "scatteredMountainsStanding")) |packed_cell| {
        const p = try intAs(u16, packed_cell, why, "scatteredMountainsStanding");
        const c = st.Cell{ .x = p >> 8, .y = p & 0xff };
        var found = false;
        for (t.layout[0..t.n_layout], 0..) |l, i| {
            if (l.x == c.x and l.y == c.y) {
                t.standing |= @as(u16, 1) << @intCast(i);
                found = true;
            }
        }
        if (!found) return why.malformed("standing stone outside the layout", .{});
    }
    t.left_cleared = try boolean(get(grid, "leftMountainCleared"), why, "leftMountainCleared");
    t.right_cleared = try boolean(get(grid, "rightMountainCleared"), why, "rightMountainCleared");
    t.cleaned_up_center = try boolean(get(grid, "cleanedUpCenter"), why, "cleanedUpCenter");
    // Barrel Barricade: artifactBarrels (Map "team:index" -> {team, index, cell}, in insertion order), each a layout
    // cell; artifactBarrelLayoutActive.
    const active = get(grid, "artifactBarrelLayoutActive");
    t.layout_active = !isUndefined(active) and try boolean(active, why, "artifactBarrelLayoutActive");
    const barrels = get(grid, "artifactBarrels");
    if (!isUndefined(barrels)) {
        for (try mapEntries(barrels, why, "artifactBarrels")) |e| {
            const b = e.array.items[1];
            const cell = try cellOf(get(b, "cell"), why, "barrel cell");
            var slot: ?u8 = null;
            for (t.layout[0..t.n_layout], 0..) |l, i| {
                if (l.x == cell.x and l.y == cell.y) slot = @intCast(i);
            }
            if (slot == null) return why.malformed("barrel outside the layout", .{});
            if (t.n_barrels >= t.barrels.len) return why.unsupported("more than {d} barrels", .{t.barrels.len});
            t.barrels[t.n_barrels] = .{ .team = try intAs(u8, get(b, "team"), why, "barrel team"), .index = try intAs(u8, get(b, "index"), why, "barrel index"), .slot = slot.? };
            t.n_barrels += 1;
        }
    }

    // The terrain cells terrain.load would stamp: lava (undried LAVA_CENTER), the uncleared classic mountains and the
    // standing stones (BLOCK_CENTER).
    var expect: [st.GRID][st.GRID]u8 = .{.{st.EMPTY} ** st.GRID} ** st.GRID;
    if (gt == GT.LAVA_CENTER and !t.cleaned_up_center) {
        for (6..10) |x| for (6..10) |y| {
            expect[x][y] = st.LAVA;
        };
    }
    if (gt == GT.BLOCK_CENTER) {
        if (!t.left_cleared) for (terrain.CLASSIC_LEFT_X) |x| for (terrain.CLASSIC_Y) |y| {
            expect[@intCast(x)][@intCast(y)] = st.BLOCK;
        };
        if (!t.right_cleared) for (terrain.CLASSIC_RIGHT_X) |x| for (terrain.CLASSIC_Y) |y| {
            expect[@intCast(x)][@intCast(y)] = st.BLOCK;
        };
    }
    // Standing layout cells are stones on every map (Barrel Barricade's barrels stand off BLOCK_CENTER too).
    for (t.layout[0..t.n_layout], 0..) |l, i| {
        if (t.standing & (@as(u16, 1) << @intCast(i)) != 0) expect[@intCast(l.x)][@intCast(l.y)] = st.BLOCK;
    }

    // Board: boardCoord[x][y] holds "", a unit id, "H" (a hole), "B" or "L"; every terrain cell must be where the
    // terrain says (a unit standing on lava, or a stone the board lost, is outside the port).
    const columns = try items(get(grid, "boardCoord"), why, "boardCoord");
    if (columns.len != st.GRID) return why.malformed("boardCoord has {d} columns", .{columns.len});
    for (columns, 0..) |col, x| {
        const cells = try items(col, why, "boardCoord");
        if (cells.len != st.GRID) return why.malformed("boardCoord column {d}", .{x});
        for (cells, 0..) |cv, y| {
            const code = try string(cv, why, "boardCoord");
            const v: u8 = if (code.len == 0)
                st.EMPTY
            else if (std.mem.eql(u8, code, "B"))
                st.BLOCK
            else if (std.mem.eql(u8, code, "L"))
                st.LAVA
            else if (std.mem.eql(u8, code, "H"))
                st.HOLE
            else if (std.mem.eql(u8, code, "W"))
                return why.unsupported("water cell", .{})
            else blk: {
                const ui = (try slotOfId(s, ids, code, why, "boardCoord")) orelse return why.malformed("board holds a removed unit", .{});
                if (!s.units[ui].in_holder) return why.malformed("board holds a removed unit", .{});
                break :blk ui + 1;
            };
            const e = expect[x][y];
            // Lava Striders: a unit that can traverse lava stands on the square, and a death there leaves ground
            // (grid.cleanupAll writes no "L" back).
            const lava_ok = e == st.LAVA and (v == st.EMPTY or (st.isUnitCode(v) and artifacts.canTraverseLava(s, &s.units[v - 1])));
            if (!lava_ok and (v == st.BLOCK or v == st.LAVA or e != st.EMPTY) and v != e) {
                return why.unsupported("terrain cell ({d},{d}) is {s}", .{ x, y, if (code.len == 0) "empty" else code });
            }
            s.grid.board[x][y] = v;
        }
    }

    // Registrations (cellsByUnitId, in the caller's order), each matching the board.
    const regs = get(grid, "cellsByUnitId");
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder) continue;
        const cells_v = (try lookup(regs, ids[u.uid], why, "cellsByUnitId")) orelse continue;
        const cells = try items(cells_v, why, "cellsByUnitId");
        if (cells.len > u.reg.len) return why.unsupported("{d} registered cells", .{cells.len});
        for (cells, 0..) |c, k| {
            const cell = try cellOf(c, why, "cellsByUnitId");
            if (!engine.cellWithinGrid(cell) or s.grid.board[@intCast(cell.x)][@intCast(cell.y)] != i + 1) {
                return why.malformed("registration of unit {d} disagrees with the board", .{i});
            }
            u.reg[k] = cell;
        }
        u.n_reg = @intCast(cells.len);
    }
    for (0..st.GRID) |x| for (0..st.GRID) |y| {
        const o = s.grid.board[x][y];
        if (!st.isUnitCode(o)) continue;
        const u = &s.units[o - 1];
        var found = false;
        for (u.reg[0..u.n_reg]) |c| {
            if (c.x == x and c.y == y) found = true;
        }
        if (!found) return why.malformed("board cell ({d},{d}) is not registered", .{ x, y });
    };

    // Threat boards: boardAggrPerTeam[team][x][y] (baseline 1; team 0 is never stamped).
    for (0..3) |team| for (0..st.GRID) |x| for (0..st.GRID) |y| {
        s.grid.aggr[team][x][y] = 1;
    };
    for (try mapEntries(get(grid, "boardAggrPerTeam"), why, "boardAggrPerTeam")) |e| {
        const team = try integer(e.array.items[0], why, "boardAggrPerTeam");
        if (team < 0 or team > Team.LEFT) return why.malformed("boardAggrPerTeam team {d}", .{team});
        const cols = try items(e.array.items[1], why, "boardAggrPerTeam");
        if (cols.len != st.GRID) return why.malformed("boardAggrPerTeam columns", .{});
        for (cols, 0..) |col, x| {
            const vals = try items(col, why, "boardAggrPerTeam");
            if (vals.len != st.GRID) return why.malformed("boardAggrPerTeam rows", .{});
            for (vals, 0..) |v, y| s.grid.aggr[@intCast(team)][x][y] = try intAs(i16, v, why, "boardAggrPerTeam");
        }
    }
}

fn queueOf(s: *const State, v: Value, ids: []const []const u8, why: *Why, what: []const u8) Error!st.Queue {
    var q: st.Queue = .{};
    const list = try items(v, why, what);
    if (list.len > st.MAX_UNITS) return why.malformed("{s}: {d} entries", .{ what, list.len });
    for (list) |e| q.push(try requireSlot(s, ids, try string(e, why, what), why, what));
    return q;
}

/// A turn set: the holder's units as slot bits, the removed ones (TypeScript keeps their ids until the lap flips) by
/// uid in `removed`.
fn turnSet(s: *State, v: Value, ids: []const []const u8, removed: *st.UidSet, why: *Why, what: []const u8) Error!st.UnitSet {
    var set: st.UnitSet = 0;
    for (try items(v, why, what)) |e| {
        const id = try string(e, why, what);
        if (try slotOfId(s, ids, id, why, what)) |slot| {
            set |= engine.unitBit(slot);
        } else removed.add(try unitIndexOf(ids, id, why, what));
    }
    return set;
}

fn loadFight(s: *State, fight: Value, root: Value, ids: []const []const u8, why: *Why) Error!void {
    const f = &s.fight;
    const lap = try integer(get(fight, "currentLap"), why, "currentLap");
    if (lap < 0 or lap > scope.MAX_LAP) return why.unsupported("lap {d}", .{lap});
    f.lap = @intCast(lap);
    f.started = try boolean(get(fight, "fightStarted"), why, "fightStarted");
    f.finished = try boolean(get(fight, "fightFinished"), why, "fightFinished");
    f.first_turn_made = try boolean(get(fight, "firstTurnMade"), why, "firstTurnMade");
    f.previous_turn_team = try intAs(u8, get(fight, "previousTurnTeam"), why, "previousTurnTeam");
    f.highest_initiative = try field(fight, "highestInitiativeThisTurn", why);
    f.steps_morale_multiplier = try field(fight, "stepsMoraleMultiplier", why);
    f.additional_narrowing_laps = try intAs(i32, get(fight, "additionalNarrowingLaps"), why, "additionalNarrowingLaps");
    f.laps_till_narrowing = try intAs(i32, get(get(root, "setup"), "lapsTillNarrowing"), why, "setup.lapsTillNarrowing");
    if (f.laps_till_narrowing <= 0) return why.malformed("laps till narrowing {d}", .{f.laps_till_narrowing});
    f.side_oriented = try boolean(get(fight, "sideOrientedPlacement"), why, "sideOrientedPlacement");
    f.hits_left = try intAs(i32, get(fight, "obstacleHitsLeftLeft"), why, "obstacleHitsLeftLeft");
    f.hits_right = try intAs(i32, get(fight, "obstacleHitsLeftRight"), why, "obstacleHitsLeftRight");
    for (scope.REFUSED_FIGHT_FIELDS) |rf| {
        const v = get(fight, rf.key);
        try requireEmpty(if (rf.inner) |inner| get(v, inner) else v, why, rf.what);
    }
    // Smoke: Map entries [key, {cell, lapsRemaining}] in insertion order.
    const clouds = get(get(fight, "smokeClouds"), "clouds");
    if (!isUndefined(clouds)) {
        for (try mapEntries(clouds, why, "smoke clouds")) |e| {
            const v = e.array.items[1];
            const c = try cellOf(get(v, "cell"), why, "smoke cell");
            if (!engine.cellWithinGrid(c)) return why.malformed("smoke off the board", .{});
            if (f.n_smoke >= st.MAX_SMOKE) return why.unsupported("more than {d} smoked cells", .{st.MAX_SMOKE});
            if (f.hasSmoke(c.x, c.y)) return why.malformed("two clouds on ({d},{d})", .{ c.x, c.y });
            f.smoke[f.n_smoke] = .{
                .x = @intCast(c.x),
                .y = @intCast(c.y),
                .laps = try intAs(i16, get(v, "lapsRemaining"), why, "lapsRemaining"),
            };
            f.n_smoke += 1;
            f.smoke_cells[@intCast(c.x)] |= @as(u16, 1) << @intCast(c.y);
        }
    }
    // Vines: Map entries [key, {cell, lapsRemaining, team}] in insertion order.
    const vines = get(get(fight, "vines"), "vines");
    if (!isUndefined(vines)) {
        for (try mapEntries(vines, why, "vines")) |e| {
            const v = e.array.items[1];
            const c = try cellOf(get(v, "cell"), why, "vine cell");
            if (!engine.cellWithinGrid(c)) return why.malformed("vine off the board", .{});
            if (f.n_vines >= st.MAX_VINES) return why.unsupported("more than {d} vines", .{st.MAX_VINES});
            if (f.hasVine(c.x, c.y)) return why.malformed("two vines on ({d},{d})", .{ c.x, c.y });
            f.vines[f.n_vines] = .{
                .x = @intCast(c.x),
                .y = @intCast(c.y),
                .laps = try intAs(i16, get(v, "lapsRemaining"), why, "lapsRemaining"),
                .team = try intAs(u8, get(v, "team"), why, "vine team"),
            };
            f.n_vines += 1;
            f.vine_cells[@intCast(c.x)] |= @as(u16, 1) << @intCast(c.y);
        }
        if (f.n_vines != 0 and !s.spell_cfg[@intFromEnum(st.CastSpell.vine_throw)].loaded) return why.malformed("vines without the Vine Throw config", .{});
    }
    // The teams' artifacts (Map team -> id): ids the port plays (scope.artifactSupported: artifacts.supportedT1/T2) or
    // refused by number.
    for (scope.ARTIFACT_FIELDS, 0..) |key, tier| {
        for (try mapEntries(get(fight, key), why, key)) |e| {
            const team = try integer(e.array.items[0], why, "artifact team");
            const id = try integer(e.array.items[1], why, "artifact id");
            if (!scope.artifactSupported(tier, id)) return why.unsupported("Tier-{d} artifact {d}", .{ tier + 1, id });
            if (team != st.Team.LEFT and team != st.Team.RIGHT) return why.malformed("artifact team {d}", .{team});
            const row = &s.setup[@intCast(team)];
            if (tier == 0) row.artifact_t1 = @intCast(id) else row.artifact_t2 = @intCast(id);
        }
    }

    f.up_next = try queueOf(s, get(fight, "upNextQueue"), ids, why, "upNextQueue");
    f.hourglass_q = try queueOf(s, get(fight, "hourglassQueue"), ids, why, "hourglassQueue");
    f.morale_plus_q = try queueOf(s, get(fight, "moralePlusQueue"), ids, why, "moralePlusQueue");
    f.morale_minus_q = try queueOf(s, get(fight, "moraleMinusQueue"), ids, why, "moraleMinusQueue");
    f.made = try turnSet(s, get(fight, "alreadyMadeTurn"), ids, &f.removed_made, why, "alreadyMadeTurn");
    f.hourglass_set = try turnSet(s, get(fight, "alreadyHourglass"), ids, &f.removed_hourglass, why, "alreadyHourglass");
    f.replied = try turnSet(s, get(fight, "alreadyRepliedAttack"), ids, &f.removed_replied, why, "alreadyRepliedAttack");
    // alreadyMadeTurnByTeam is not modelled apart: it must be `made` split by team (compared as uid sets).
    var made_uids: [st.MAX_UIDS + 1]bool = .{false} ** (st.MAX_UIDS + 1);
    var made_n: usize = 0;
    for (try items(get(fight, "alreadyMadeTurn"), why, "alreadyMadeTurn")) |e| {
        const uid = try unitIndexOf(ids, try string(e, why, "alreadyMadeTurn"), why, "alreadyMadeTurn");
        if (!made_uids[uid]) made_n += 1;
        made_uids[uid] = true;
    }
    var by_team_n: usize = 0;
    for (try mapEntries(get(fight, "alreadyMadeTurnByTeam"), why, "alreadyMadeTurnByTeam")) |e| {
        const team = try integer(e.array.items[0], why, "alreadyMadeTurnByTeam");
        for (try items(e.array.items[1], why, "alreadyMadeTurnByTeam")) |x| {
            const id = try string(x, why, "alreadyMadeTurnByTeam");
            const uid = try unitIndexOf(ids, id, why, "alreadyMadeTurnByTeam");
            if (!made_uids[uid]) return why.unsupported("alreadyMadeTurnByTeam differs from alreadyMadeTurn", .{});
            if (try slotOfId(s, ids, id, why, "alreadyMadeTurnByTeam")) |ui| {
                if (s.units[ui].in_holder and s.units[ui].team != team) return why.unsupported("alreadyMadeTurnByTeam disagrees with the teams", .{});
            }
            by_team_n += 1;
        }
    }
    if (by_team_n != made_n) return why.unsupported("alreadyMadeTurnByTeam differs from alreadyMadeTurn", .{});
    f.damage_laps = 0;
    for (try mapEntries(get(fight, "damageDealFactPerLap"), why, "damageDealFactPerLap")) |e| {
        const l = try integer(e.array.items[0], why, "damageDealFactPerLap");
        if (l < 0 or l >= 128) return why.unsupported("damage lap {d}", .{l});
        if (e.array.items[1] == .bool and e.array.items[1].bool) f.damage_laps |= @as(u128, 1) << @intCast(l);
    }
    f.team_units_alive = .{ 0, 0, 0 };
    for (try mapEntries(get(fight, "teamUnitsAlive"), why, "teamUnitsAlive")) |e| {
        const team = try integer(e.array.items[0], why, "teamUnitsAlive");
        if (team < 0 or team > Team.LEFT) return why.malformed("teamUnitsAlive team {d}", .{team});
        f.team_units_alive[@intCast(team)] = try intAs(i32, e.array.items[1], why, "teamUnitsAlive");
    }
}

test "tagged numbers" {
    var why: Why = .{};
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const v = try std.json.parseFromSliceLeaky(Value, arena.allocator(), "[{\"$num\":\"-0\"},1.5,{\"$num\":\"NaN\"},7]", .{});
    const a = v.array.items;
    try std.testing.expect(std.math.signbit(try number(a[0], &why, "x")));
    try std.testing.expectEqual(@as(f64, 1.5), try number(a[1], &why, "x"));
    try std.testing.expect(std.math.isNan(try number(a[2], &why, "x")));
    try std.testing.expectEqual(@as(i64, 7), try integer(a[3], &why, "x"));
}
