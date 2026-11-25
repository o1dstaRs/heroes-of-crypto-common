//! Loads a live battle exported mid-fight by zig/parity/state_export.ts (`exportBattleState`) into a `State`: the
//! bridge's input format (zig/BRIDGE.md) and the start point of `hoc-sim resume`.
//!
//! Every field the port models is read from the export: units (stats, base stats, buffs, debuffs and effects with
//! laps, powers and stored properties, abilities, auras, turn flags, position, grid registration), the grid (board,
//! aggression boards, terrain and stones), the fight (laps, queues, sets, flags, hit counters), the units holder
//! (distances, Ember Covenant), the AI target memory and the damage-statistic laps. Anything non-empty the port does
//! not model (smoke, vines, fire walls, artifact barrels, artifacts, spells, summoned units, unported abilities,
//! buffs or effects, ranked authoritative stats, ...) is refused as an unsupported state, naming what it found: the
//! loader is fail-closed, like the export's coverage check on the TypeScript side.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const terrain = @import("terrain.zig");
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
/// then the ids of units already removed from the holder that the fight's turn sets, the AI target memory or the
/// holder's distances still name (TypeScript keeps them), in order of first mention. Slices into `root`.
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
    for (mentioned.items) |m| {
        const id = try string(m, why, "unit id");
        if (rec.unitIndex(out.items, id)) |_| {} else |_| try out.append(arena, id);
    }
    if (out.items.len > st.MAX_UNITS) return why.unsupported("{d} units (at most {d})", .{ out.items.len, st.MAX_UNITS });
    return out.items;
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
    if (ids.len > st.MAX_UNITS) return why.unsupported("{d} units (at most {d})", .{ ids.len, st.MAX_UNITS });

    s.n_units = @intCast(ids.len);
    s.n_aura_defs = 0;
    for (&s.setup, 0..) |*row, t| row.* = engine.loadTeamSetup(root, @intCast(t));
    for (s.units[0..s.n_units]) |*u| {
        // A unit removed from the holder before the snapshot: nothing reads it again (every unit loop checks
        // in_holder first); it keeps only its index.
        u.* = std.mem.zeroes(Unit);
        u.in_holder = false;
        u.target = -1;
    }

    // ---- units ----
    var names: [st.MAX_UNITS][]const u8 = undefined;
    var n_names: u16 = 0;
    var previous: i32 = -1;
    const units = try items(get(root, "units"), why, "units");
    for (units) |uv| {
        const id = try string(get(uv, "id"), why, "unit id");
        const idx = try unitIndexOf(ids, id, why, "units");
        if (@as(i32, idx) <= previous) return why.unsupported("unit {s} out of holder order", .{id});
        previous = idx;
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
    const distances = get(holder, "distancesToClosestEnemies");
    for (try mapEntries(distances, why, "distancesToClosestEnemies")) |e| {
        const ui = try unitIndexOf(ids, try string(e.array.items[0], why, "distances"), why, "distances");
        s.units[ui].dist_known = true;
        s.units[ui].dist_closest_enemy = try number(e.array.items[1], why, "distances");
    }

    // ---- AI target memory and the damage-statistic laps ----
    s.ai_prev_target = .{-1} ** st.MAX_UNITS;
    for (try items(get(root, "aiTargetMemory"), why, "aiTargetMemory")) |e| {
        if (e != .array or e.array.items.len != 2) return why.malformed("aiTargetMemory entry", .{});
        const a = try unitIndexOf(ids, try string(e.array.items[0], why, "aiTargetMemory"), why, "aiTargetMemory");
        const t = try unitIndexOf(ids, try string(e.array.items[1], why, "aiTargetMemory"), why, "aiTargetMemory");
        s.ai_prev_target[a] = @intCast(t);
    }
    s.damage_lap = -1;
    for (try items(get(root, "damageStatLaps"), why, "damageStatLaps")) |l| {
        const lap = try intAs(i32, l, why, "damageStatLaps");
        if (lap > s.damage_lap) s.damage_lap = lap;
    }

    // ---- harness ----
    const hv = get(root, "harness");
    s.rng = Rng.init(0);
    if (harness.rng) |r| {
        s.rng = Rng.init(r);
    } else if (get(hv, "rng") == .integer) {
        s.rng = Rng.init(@intCast(try integer(get(hv, "rng"), why, "harness.rng") & 0xffffffff));
    }
    s.active = -1;
    const active_id: []const u8 = harness.active orelse if (get(hv, "activeUnitId") == .string) get(hv, "activeUnitId").string else "";
    if (active_id.len > 0) {
        const ai = try unitIndexOf(ids, active_id, why, "active unit");
        if (!s.units[ai].in_holder) return why.malformed("active unit {s} is not in the holder", .{active_id});
        s.active = @intCast(ai);
    }
    return s;
}

/// Fails unless the unit-level fields the port does not model are empty or at their defaults.
fn checkUnitScope(uv: Value, fields: Value, props: Value, why: *Why) Error!void {
    if (get(uv, "summoned") == .bool and get(uv, "summoned").bool) return why.unsupported("summoned unit", .{});
    const unit_type = get(uv, "unitType");
    if (unit_type != .integer or unit_type.integer != 1) return why.unsupported("unit type is not a creature", .{});
    try checkSpells(fields, props, why);
    try requireEmpty(get(props, "stolen_abilities"), why, "stolen abilities");
    try requireEmpty(get(props, "artifact_granted_abilities"), why, "artifact-granted abilities");
    try requireEmpty(get(props, "forbidden_target"), why, "forbidden target");
    try requireEmpty(get(props, "web_movement_locked"), why, "Web movement lock");
    try requireEmpty(get(props, "helping_hand_caster_id"), why, "Helping Hand caster");
    try requireEmpty(get(props, "helping_hand_penalty_id"), why, "Helping Hand penalty");
    try requireEmpty(get(props, "rallying_volley_granted"), why, "Rallying Volley arrows");
    if (props == .object) {
        var it = props.object.iterator();
        while (it.next()) |e| {
            // The ranked client's authoritative stats (`*_authoritative`); spell_entries_authoritative only says the
            // spell list was built (spells must be empty anyway).
            const key = e.key_ptr.*;
            if (std.mem.endsWith(u8, key, "_authoritative") and !std.mem.eql(u8, key, "spell_entries_authoritative")) {
                try requireEmpty(e.value_ptr.*, why, key);
            }
        }
    }
    try requireEmpty(get(fields, "waterShieldSpent"), why, "Water Shield spent");
    try requireEmpty(get(fields, "lastFuseFatalHit"), why, "Last Fuse");
    try requireEmpty(get(fields, "currentAttackModIncrease"), why, "attack mod increase");
    try requireEmpty(get(fields, "warlordsEdgeAttackBase"), why, "Warlord's Edge");
    try requireEmpty(get(fields, "warlordsEdgeAppliedAttackBonus"), why, "Warlord's Edge");
}

/// Castable abilities the port loads as inert under its policies (they are never cast): their spell entries may be
/// present. Any other spell is outside the port.
const INERT_ABILITY_SPELLS = [_][]const u8{"Vine Throw"};

fn inertAbilitySpell(name: []const u8, abilities: Value) bool {
    var inert = false;
    for (INERT_ABILITY_SPELLS) |n| {
        if (std.mem.eql(u8, n, name)) inert = true;
    }
    if (!inert or abilities != .array) return false;
    for (abilities.array.items) |a| {
        if (a == .string and std.mem.eql(u8, a.string, name)) return true;
    }
    return false;
}

/// The unit's spells (Spell objects and props.spells "faction:name" entries): only the spell entries of its own inert
/// castable abilities.
fn checkSpells(fields: Value, props: Value, why: *Why) Error!void {
    const abilities = get(props, "abilities");
    for (try items(get(fields, "spells"), why, "spells")) |sp| {
        const name = try string(get(get(sp, "spellProperties"), "name"), why, "spell name");
        if (!inertAbilitySpell(name, abilities)) return why.unsupported("spell {s}", .{name});
    }
    const entries = get(props, "spells");
    if (isUndefined(entries)) return;
    for (try items(entries, why, "spells")) |e| {
        const entry = try string(e, why, "spells");
        const name = if (std.mem.lastIndexOfScalar(u8, entry, ':')) |i| entry[i + 1 ..] else entry;
        if (!inertAbilitySpell(name, abilities)) return why.unsupported("spell {s}", .{entry});
    }
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
    if (x != @trunc(x) or x < 0 or x > std.math.maxInt(i8)) return why.unsupported("stored spell property {d}", .{x});
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
    for (lists) |l| {
        const objects = try items(get(fields, l[0]), why, l[0]);
        if (objects.len != l[1].len) return why.unsupported("{s}: {d} objects for {d} applied names", .{ l[0], objects.len, l[1].len });
        for (objects, l[1]) |o, a| {
            // AppliedSpell {name, power, lapsRemaining}; Effect {effectProperties: {name, laps, power, stacks}}.
            const ep = get(o, "effectProperties");
            const props_obj = if (ep == .object) ep else o;
            const name = try string(get(props_obj, "name"), why, l[0]);
            const laps = try number(if (ep == .object) get(ep, "laps") else get(o, "lapsRemaining"), why, "laps");
            const power = try number(get(props_obj, "power"), why, "power");
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
    // Stored properties: the aura rows' source cells and the augments' (Sniper "27;70"), as engine.loadBuffSources.
    const objects = try items(get(fields, "buffs"), why, "buffs");
    for (objects, 0..) |o, i| {
        const b = &u.buffs.items[i];
        if (!b.id.isAugment() and b.laps != st.LAPS_AURA) continue;
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
    if (fw < 1 or fw > 2 or fh < 1 or fh > 2) return why.unsupported("footprint {d}x{d}", .{ fw, fh });
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
    };
    const u = &s.units[idx];
    u.syn_power = s.setup[u.team].ability_power;

    // Abilities and auras from the configs (the same loaders as a recording's start state), checked against the
    // unit's Ability / AuraEffect objects.
    engine.loadAbilities(configs, props, u) catch |err| return switch (err) {
        error.UnsupportedAbility => why.unsupported("ability {s}", .{engine.unsupported_name}),
        else => why.malformed("abilities: {s}", .{@errorName(err)}),
    };
    engine.loadAuras(configs, props, s, u) catch |err| return switch (err) {
        error.UnsupportedAura => why.unsupported("aura {s}", .{engine.unsupported_name}),
        else => why.malformed("auras: {s}", .{@errorName(err)}),
    };
    try checkNames(try items(get(fields, "abilities"), why, "abilities"), try items(get(props, "abilities"), why, "abilities"), "abilityProperties", why);
    const aura_names = get(props, "aura_effects");
    try checkNames(try items(get(fields, "auraEffects"), why, "auraEffects"), if (aura_names == .array) aura_names.array.items else &.{}, "auraEffectProperties", why);

    const target = get(props, "target");
    if (target == .string and target.string.len > 0) u.target = @intCast(try unitIndexOf(ids, target.string, why, "target"));
    try loadLists(u, fields, props, why);

    for (try items(get(fields, "adjustedBaseStatsLaps"), why, "adjustedBaseStatsLaps")) |l| {
        const lap = try integer(l, why, "adjustedBaseStatsLaps");
        if (lap < 0 or lap >= 128) return why.unsupported("adjusted lap {d}", .{lap});
        u.adjusted_laps |= @as(u128, 1) << @intCast(lap);
    }
    const possible = try items(get(fields, "possibleAttackTypes"), why, "possibleAttackTypes");
    if (possible.len > u.possible.len) return why.unsupported("{d} possible attack types", .{possible.len});
    for (possible, 0..) |p, k| u.possible[k] = try intAs(u8, p, why, "possibleAttackTypes");
    u.n_possible = @intCast(possible.len);
}

fn loadGrid(s: *State, grid: Value, fight: Value, ids: []const []const u8, why: *Why) Error!void {
    const gt = try integer(get(fight, "gridType"), why, "gridType");
    if (gt != try integer(get(grid, "gridType"), why, "grid.gridType")) return why.malformed("grid and fight grid types differ", .{});
    if (gt != GT.NORMAL and gt != GT.LAVA_CENTER and gt != GT.BLOCK_CENTER) return why.unsupported("grid type {d}", .{gt});
    try requireEmpty(get(grid, "artifactBarrels"), why, "artifact barrels");
    try requireEmpty(get(grid, "artifactBarrelLayoutActive"), why, "artifact barrel layout");
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
        for (t.layout[0..t.n_layout], 0..) |l, i| {
            if (t.standing & (@as(u16, 1) << @intCast(i)) != 0) expect[@intCast(l.x)][@intCast(l.y)] = st.BLOCK;
        }
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
                const ui = try unitIndexOf(ids, code, why, "boardCoord");
                if (!s.units[ui].in_holder) return why.malformed("board holds a removed unit", .{});
                break :blk ui + 1;
            };
            const e = expect[x][y];
            if ((v == st.BLOCK or v == st.LAVA or e != st.EMPTY) and v != e) {
                return why.unsupported("terrain cell ({d},{d}) is {s}", .{ x, y, if (code.len == 0) "empty" else code });
            }
            s.grid.board[x][y] = v;
        }
    }

    // Registrations (cellsByUnitId, in the caller's order), each matching the board.
    const regs = get(grid, "cellsByUnitId");
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder) continue;
        const cells_v = (try lookup(regs, ids[i], why, "cellsByUnitId")) orelse continue;
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

fn queueOf(v: Value, ids: []const []const u8, why: *Why, what: []const u8) Error!st.Queue {
    var q: st.Queue = .{};
    const list = try items(v, why, what);
    if (list.len > st.MAX_UNITS) return why.malformed("{s}: {d} entries", .{ what, list.len });
    for (list) |e| q.push(try unitIndexOf(ids, try string(e, why, what), why, what));
    return q;
}

fn setOf(v: Value, ids: []const []const u8, why: *Why, what: []const u8) Error!st.UnitSet {
    var set: st.UnitSet = 0;
    for (try items(v, why, what)) |e| set |= engine.unitBit(try unitIndexOf(ids, try string(e, why, what), why, what));
    return set;
}

fn loadFight(s: *State, fight: Value, root: Value, ids: []const []const u8, why: *Why) Error!void {
    const f = &s.fight;
    const lap = try integer(get(fight, "currentLap"), why, "currentLap");
    if (lap < 0 or lap >= 127) return why.unsupported("lap {d}", .{lap});
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
    try requireEmpty(get(fight, "legacyAxisPolicyTeams"), why, "legacy-axis policy teams");
    try requireEmpty(get(get(fight, "smokeClouds"), "clouds"), why, "smoke clouds");
    try requireEmpty(get(get(fight, "vines"), "vines"), why, "vines");
    try requireEmpty(get(get(fight, "fireWalls"), "walls"), why, "fire walls");
    for ([_][]const u8{ "artifactTier1PerTeam", "artifactTier2PerTeam" }) |key| {
        for (try mapEntries(get(fight, key), why, key)) |e| try requireEmpty(e.array.items[1], why, "artifacts");
    }

    f.up_next = try queueOf(get(fight, "upNextQueue"), ids, why, "upNextQueue");
    f.hourglass_q = try queueOf(get(fight, "hourglassQueue"), ids, why, "hourglassQueue");
    f.morale_plus_q = try queueOf(get(fight, "moralePlusQueue"), ids, why, "moralePlusQueue");
    f.morale_minus_q = try queueOf(get(fight, "moraleMinusQueue"), ids, why, "moraleMinusQueue");
    f.made = try setOf(get(fight, "alreadyMadeTurn"), ids, why, "alreadyMadeTurn");
    f.hourglass_set = try setOf(get(fight, "alreadyHourglass"), ids, why, "alreadyHourglass");
    f.replied = try setOf(get(fight, "alreadyRepliedAttack"), ids, why, "alreadyRepliedAttack");
    // alreadyMadeTurnByTeam is not modelled apart: it must be `made` split by team.
    var by_team: st.UnitSet = 0;
    for (try mapEntries(get(fight, "alreadyMadeTurnByTeam"), why, "alreadyMadeTurnByTeam")) |e| {
        const team = try integer(e.array.items[0], why, "alreadyMadeTurnByTeam");
        const set = try setOf(e.array.items[1], ids, why, "alreadyMadeTurnByTeam");
        var it = set;
        while (it != 0) {
            const ui: u8 = @intCast(@ctz(it));
            it &= it - 1;
            if (s.units[ui].in_holder and s.units[ui].team != team) return why.unsupported("alreadyMadeTurnByTeam disagrees with the teams", .{});
        }
        by_team |= set;
    }
    if (by_team != f.made) return why.unsupported("alreadyMadeTurnByTeam differs from alreadyMadeTurn", .{});
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
