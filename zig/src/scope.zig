//! What the native engine covers, as data: the tables the loader (snapshot.zig) refuses by and the v0.8 port's scope
//! (rollout.v08Scope), and the manifest the bridge exports from them (`hoc_scope_manifest`, zig/BRIDGE.md). The loader
//! and v08Scope read these same tables and enums, so the manifest cannot drift from what the library accepts; a
//! TypeScript pre-check compiled from it (zig/ffi/precheck.ts) answers "would the library take this root" by name
//! lookups, without an export.

const std = @import("std");
const st = @import("state.zig");
const artifacts = @import("artifacts.zig");

/// A field the port does not model and refuses unless empty, with the loader's name for it.
pub const Field = struct { key: []const u8, what: []const u8 };

/// Unit fields (`units[].fields.<key>`) that must be empty: undefined, false, 0, "", [] or {} (snapshot.requireEmpty).
/// (Warlord's Edge's warlordsEdgeAttackBase / warlordsEdgeAppliedAttackBonus are loaded since the artifacts port, War
/// Anger's currentAttackModIncrease since batch 6a.) The Mermaid's waterShieldSpent waits for her slice of batch 6b
/// (REFUSED_ABILITIES).
pub const REFUSED_UNIT_FIELDS = [_]Field{
    .{ .key = "waterShieldSpent", .what = "Water Shield spent" },
};

/// Batch 6b lands creature by creature. st.AbilityId names every batch-6b card and the engine code behind them is in
/// place, but only the Harpy's Castling (Shadow Touch is batch 1's) is checked: the loader refuses the other cards by
/// name, active or stolen (snapshot.loadUnit), and the manifest leaves them out of `abilities`, as for a name the port
/// does not know. Each later slice takes its creature's cards out of this mask.
pub const REFUSED_ABILITIES: st.AbilityMask = st.AbilityId.BATCH6B_MASK & ~st.AbilityId.castling.bit();

/// The applied rows of the refused batch-6b cards (the Mermaid's Water Shield, the Abomination's Flesh Shield aura row):
/// refused by name in the applied lists and left out of the manifest's `applied` and `auraEffects`.
pub const REFUSED_ROWS = [_]st.SpellId{ .water_shield, .flesh_shield_aura };

/// Whether the loader takes card `id` (not in REFUSED_ABILITIES).
pub inline fn abilityLoaded(id: st.AbilityId) bool {
    return id.bit() & REFUSED_ABILITIES == 0;
}

/// Whether the loader takes applied row `id` (not in REFUSED_ROWS).
pub fn rowLoaded(id: st.SpellId) bool {
    return !listed(&REFUSED_ROWS, id);
}

/// Unit fields refused when the field is present and its `inner` part is too (neither undefined nor null), refused as
/// `what`: a Last Fuse fatal hit with a source (the striker's row) is pending state; a sourceless one (a corpse a step
/// left in the holder) loads as the port's empty `fuse`.
pub const REFUSED_UNIT_FIELD_PARTS = [_]NestedField{
    .{ .key = "lastFuseFatalHit", .inner = "source", .what = "a pending Last Fuse record" },
};

/// Unit properties (`fields.unitProperties.<key>`) that must be empty.
pub const REFUSED_UNIT_PROPS = [_]Field{};

/// A unit property that is a list of names and may hold only `accepted` ones (undefined or [] passes); any other name
/// is refused as `what`.
pub const LimitedField = struct {
    key: []const u8,
    what: []const u8,
    accepted: []const []const u8,

    pub fn accepts(self: LimitedField, name: []const u8) bool {
        for (self.accepted) |a| {
            if (std.mem.eql(u8, a, name)) return true;
        }
        return false;
    }
};

/// The artifact-granted cards: only the Wounding Charm's "Deep Wounds Level 1" (the card itself is in the ability lists;
/// the record only matters to a re-apply, which runMatch and rollouts never do).
pub const LIMITED_UNIT_PROPS = [_]LimitedField{
    .{ .key = "artifact_granted_abilities", .what = "artifact-granted ability", .accepted = &.{"Deep Wounds Level 1"} },
};

/// The ranked client's authoritative stats: every unit property with this suffix must be empty, except those in
/// AUTHORITATIVE_KEPT (spell_entries_authoritative only says the spell list was built).
pub const AUTHORITATIVE_SUFFIX = "_authoritative";
pub const AUTHORITATIVE_KEPT = [_][]const u8{"spell_entries_authoritative"};

pub fn refusedAuthoritative(key: []const u8) bool {
    if (!std.mem.endsWith(u8, key, AUTHORITATIVE_SUFFIX)) return false;
    for (AUTHORITATIVE_KEPT) |k| {
        if (std.mem.eql(u8, k, key)) return false;
    }
    return true;
}

/// The grid types the port plays (GridVals): NORMAL, LAVA_CENTER, BLOCK_CENTER. WATER_CENTER and its "W" cells are
/// refused.
pub const GRID_TYPES = [_]u8{ st.GridType.NORMAL, st.GridType.LAVA_CENTER, st.GridType.BLOCK_CENTER };

pub fn gridTypeAccepted(gt: i64) bool {
    for (GRID_TYPES) |t| {
        if (gt == t) return true;
    }
    return false;
}

/// boardCoord codes besides unit ids: empty, a mountain or stone, the undried lava, a hole.
pub const BOARD_CODES = [_][]const u8{ "", "B", "L", "H" };

/// Grid fields that must be empty. None since the artifacts port: Barrel Barricade's artifactBarrels (at most
/// MAX_BARRELS) and artifactBarrelLayoutActive are loaded.
pub const REFUSED_GRID_FIELDS = [_]Field{};

/// Grid.artifactBarrels entries the terrain holds (Terrain.barrels).
pub const MAX_BARRELS = @typeInfo(@FieldType(st.Terrain, "barrels")).array.len;

/// FightProperties fields that must be empty (`inner`: the store's field that holds the entries). The smoke clouds
/// (smokeClouds.clouds) and the fire walls (fireWalls.walls) are loaded since Smoke and Fire Wall were ported, at most
/// st.MAX_SMOKE and st.MAX_FIRE cells (`capacities.smoke`, `capacities.fireWalls`).
pub const NestedField = struct { key: []const u8, inner: ?[]const u8 = null, what: []const u8 };
pub const REFUSED_FIGHT_FIELDS = [_]NestedField{
    .{ .key = "legacyAxisPolicyTeams", .what = "legacy-axis policy teams" },
};

/// The per-team artifact maps (Map team -> id, Tier 1 then Tier 2): every team's id must be one the port plays
/// (artifactSupported; 0 = no artifact).
pub const ARTIFACT_FIELDS = [_][]const u8{ "artifactTier1PerTeam", "artifactTier2PerTeam" };

/// artifacts.supportedT1 (tier 0) / supportedT2 (tier 1).
pub fn artifactSupported(tier: usize, id: i64) bool {
    return if (tier == 0) artifacts.supportedT1(id) else artifacts.supportedT2(id);
}

/// The manifest lists the supported ids up to this one (Tier1Artifact / Tier2Artifact are far below it; a test checks
/// that no larger id is supported).
pub const MAX_ARTIFACT_ID = 255;

/// The buff rows whose stored properties (firstSpellProperty / secondSpellProperty, each an integer 0..MAX_STORED_PROPERTY
/// or undefined) the loader reads besides the aura rows (laps Number.MAX_SAFE_INTEGER, buffs and debuffs): the augments
/// and the artifact rows (artifacts.storesProperties), as snapshot.loadLists.
pub fn storesProperties(id: st.SpellId) bool {
    return id.isAugment() or artifacts.storesProperties(id);
}

/// The applied rows that turn the board's artifact flag on (State.artifacts, engine.loadScopeFlags): an artifact buff
/// row (or marker), the System "Made of Fire" buff, Gravechain's Gravebound debuff. A policy with
/// `refuse_artifact_rows` refuses a board where any unit carries one.
pub fn artifactRowBuff(id: st.SpellId) bool {
    return id.isArtifact() or id == .made_of_fire;
}
pub fn artifactRowDebuff(id: st.SpellId) bool {
    return id == .gravebound;
}

/// Unit types the port plays (UnitType.CREATURE).
pub const UNIT_TYPES = [_]i64{1};
/// Footprint sides (footprint_width / footprint_height).
pub const FOOTPRINT_MIN = 1;
pub const FOOTPRINT_MAX = 2;
/// The highest lap a loaded fight may stand at (the lap bit sets hold 128 laps).
pub const MAX_LAP = 126;
/// A stored spell property the port reads (aura rows' source cells, the augments' percentages, the artifact rows'
/// "first;second"): an integer 0..127.
pub const MAX_STORED_PROPERTY = std.math.maxInt(i8);
/// possibleAttackTypes entries.
pub const MAX_POSSIBLE_ATTACK_TYPES = 4;

/// A Spell object's `spellProperties.faction` (FactionType) and the book prefix it parses to; a non-integer faction
/// is a System spell.
pub const SpellFaction = struct { faction: i64, prefix: u8 };
pub const SPELL_FACTIONS = [_]SpellFaction{
    .{ .faction = 4, .prefix = 2 }, // Life
    .{ .faction = 3, .prefix = 3 }, // Nature
    .{ .faction = 1, .prefix = 4 }, // Chaos
    .{ .faction = 2, .prefix = 5 }, // Might
};

pub fn spellFactionPrefix(faction: i64) ?u8 {
    for (SPELL_FACTIONS) |f| {
        if (f.faction == faction) return f.prefix;
    }
    return null;
}

/// The only effect whose stacks may differ from 1 (its stack count feeds the description only).
pub const STACKING_EFFECT = st.SpellId.poison;

// =====================================================================================================================
// The manifest
// =====================================================================================================================

/// A policy's extra scope: what a request naming it refuses on top of the loader.
pub const PolicyScope = struct {
    name: []const u8,
    /// Spells a unit may hold (book entries and parsed spells); null = every spell the loader takes.
    castable: ?[]const st.CastSpell = null,
    /// Abilities no unit may hold (the active list, stolen ones included).
    refused_abilities: st.AbilityMask = 0,
    /// Debuffs no unit may carry.
    refused_debuffs: []const st.SpellId = &.{},
    /// Effects no unit may carry.
    refused_effects: []const st.SpellId = &.{},
    /// Buffs no unit may carry.
    refused_buffs: []const st.SpellId = &.{},
    /// No unit may be a revived one (orphan augment rows: Unit.aug_orphans; in TypeScript more applied_buffs names than
    /// buff objects).
    refuse_revived: bool = false,
    /// No unit may carry an artifact row (artifactRowBuff / artifactRowDebuff: State.artifacts).
    refuse_artifact_rows: bool = false,
    /// The board may hold no smoke cloud (FightProperties.smokeClouds).
    refuse_smoke: bool = false,
    /// The board may hold no burning cell (FightProperties.fireWalls).
    refuse_fire_walls: bool = false,
    /// Cards and rows refused after the board-level checks, with their own messages (v0.8: the wave-2 rows that outlive
    /// their casters). The manifest lists them with the ones above.
    late: RowScope = .{},
};

/// Cards and rows a policy refuses.
pub const RowScope = struct {
    abilities: st.AbilityMask = 0,
    buffs: []const st.SpellId = &.{},
    debuffs: []const st.SpellId = &.{},
    effects: []const st.SpellId = &.{},
};

/// Whether any applied row in `rows` is in `list`.
pub fn carries(rows: []const st.AppliedSpell, list: []const st.SpellId) bool {
    for (rows) |r| {
        if (listed(list, r.id)) return true;
    }
    return false;
}

fn writeString(w: *std.Io.Writer, s: []const u8) !void {
    try w.writeByte('"');
    for (s) |c| {
        switch (c) {
            '"', '\\' => {
                try w.writeByte('\\');
                try w.writeByte(c);
            },
            else => if (c < 0x20) try w.print("\\u{x:0>4}", .{c}) else try w.writeByte(c),
        }
    }
    try w.writeByte('"');
}

/// Whether `id` is in `list` (a policy's refused rows).
pub fn listed(list: []const st.SpellId, id: st.SpellId) bool {
    for (list) |x| {
        if (x == id) return true;
    }
    return false;
}

/// The SpellIds `pred` keeps, in enum order, as a comptime list (a policy's rows from a SpellId predicate).
pub fn spellIdsWhere(comptime pred: anytype) []const st.SpellId {
    comptime {
        var n: usize = 0;
        for (std.meta.fields(st.SpellId)) |f| {
            if (pred(@as(st.SpellId, @enumFromInt(f.value)))) n += 1;
        }
        var ids: [n]st.SpellId = undefined;
        var k: usize = 0;
        for (std.meta.fields(st.SpellId)) |f| {
            const id: st.SpellId = @enumFromInt(f.value);
            if (pred(id)) {
                ids[k] = id;
                k += 1;
            }
        }
        const out = ids;
        return &out;
    }
}

/// The names of `a` then `b` (a policy's rows and its late rows).
fn writeSpellList(w: *std.Io.Writer, a: []const st.SpellId, b: []const st.SpellId) !void {
    try w.writeByte('[');
    for (a, 0..) |d, i| {
        if (i > 0) try w.writeByte(',');
        try writeString(w, d.name());
    }
    for (b, 0..) |d, i| {
        if (a.len + i > 0) try w.writeByte(',');
        try writeString(w, d.name());
    }
    try w.writeByte(']');
}

pub fn writeStrings(w: *std.Io.Writer, items: []const []const u8) !void {
    try w.writeByte('[');
    for (items, 0..) |s, i| {
        if (i > 0) try w.writeByte(',');
        try writeString(w, s);
    }
    try w.writeByte(']');
}

fn writeEnumNames(w: *std.Io.Writer, comptime E: type, mask: ?st.AbilityMask) !void {
    try w.writeByte('[');
    var first = true;
    inline for (std.meta.fields(E)) |f| {
        const id: E = @enumFromInt(f.value);
        const keep = if (mask) |m| (if (E == st.AbilityId) id.bit() & m != 0 else true) else true;
        if (keep) {
            if (!first) try w.writeByte(',');
            first = false;
            try writeString(w, id.name());
        }
    }
    try w.writeByte(']');
}

/// The SpellId names `pred` keeps.
fn writeSpellIds(w: *std.Io.Writer, comptime pred: fn (st.SpellId) bool) !void {
    try w.writeByte('[');
    var first = true;
    inline for (std.meta.fields(st.SpellId)) |f| {
        const id: st.SpellId = @enumFromInt(f.value);
        if (pred(id)) {
            if (!first) try w.writeByte(',');
            first = false;
            try writeString(w, id.name());
        }
    }
    try w.writeByte(']');
}

fn writeArtifactIds(w: *std.Io.Writer, tier: usize) !void {
    try w.writeByte('[');
    var first = true;
    var id: i64 = 0;
    while (id <= MAX_ARTIFACT_ID) : (id += 1) {
        if (!artifactSupported(tier, id)) continue;
        if (!first) try w.writeByte(',');
        first = false;
        try w.print("{d}", .{id});
    }
    try w.writeByte(']');
}

/// The aura effects the loader interns: the X of every applied-spell row named "X Aura" (REFUSED_ROWS left out).
fn writeAuraEffects(w: *std.Io.Writer) !void {
    try w.writeByte('[');
    var first = true;
    inline for (std.meta.fields(st.SpellId)) |f| {
        const id: st.SpellId = @enumFromInt(f.value);
        const n = id.name();
        if (std.mem.endsWith(u8, n, " Aura") and rowLoaded(id)) {
            if (!first) try w.writeByte(',');
            first = false;
            try writeString(w, n[0 .. n.len - " Aura".len]);
        }
    }
    try w.writeByte(']');
}

fn writeFields(w: *std.Io.Writer, fields: []const Field) !void {
    try w.writeByte('[');
    for (fields, 0..) |f, i| {
        if (i > 0) try w.writeByte(',');
        try writeString(w, f.key);
    }
    try w.writeByte(']');
}

/// The loader's scope (snapshot.load): what an exported root may hold.
pub fn writeLoader(w: *std.Io.Writer, snapshot_format: i64) !void {
    try w.print("{{\"format\":{d},\"abilities\":", .{snapshot_format});
    try writeEnumNames(w, st.AbilityId, ~REFUSED_ABILITIES);
    try w.writeAll(",\"auraEffects\":");
    try writeAuraEffects(w);
    try w.writeAll(",\"applied\":");
    try writeSpellIds(w, rowLoaded);
    try w.writeAll(",\"spells\":");
    try writeEnumNames(w, st.CastSpell, null);
    try w.writeAll(",\"spellEntryPrefixes\":");
    try writeStrings(w, &st.BookEntry.PREFIXES);
    try w.writeAll(",\"spellFactions\":[");
    for (SPELL_FACTIONS, 0..) |f, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("{d}", .{f.faction});
    }
    try w.writeAll("],\"summons\":");
    try writeStrings(w, &st.SUMMON_NAMES);
    try w.writeAll(",\"unitTypes\":[");
    for (UNIT_TYPES, 0..) |t, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("{d}", .{t});
    }
    try w.print("],\"teams\":[{d},{d}],\"footprint\":[{d},{d}],\"gridTypes\":[", .{ st.Team.RIGHT, st.Team.LEFT, FOOTPRINT_MIN, FOOTPRINT_MAX });
    for (GRID_TYPES, 0..) |t, i| {
        if (i > 0) try w.writeByte(',');
        try w.print("{d}", .{t});
    }
    try w.writeAll("],\"boardCodes\":");
    try writeStrings(w, &BOARD_CODES);
    try w.writeAll(",\"stackingEffect\":");
    try writeString(w, STACKING_EFFECT.name());
    try w.writeAll(",\"storedPropertyBuffs\":");
    try writeSpellIds(w, storesProperties);
    try w.writeAll(",\"artifacts\":{\"tier1\":");
    try writeArtifactIds(w, 0);
    try w.writeAll(",\"tier2\":");
    try writeArtifactIds(w, 1);
    try w.writeAll("},\"artifactRows\":{\"buffs\":");
    try writeSpellIds(w, artifactRowBuff);
    try w.writeAll(",\"debuffs\":");
    try writeSpellIds(w, artifactRowDebuff);
    try w.writeByte('}');
    try w.print(
        ",\"capacities\":{{\"units\":{d},\"ids\":{d},\"abilities\":{d},\"stolen\":{d},\"buffs\":{d},\"debuffs\":{d},\"effects\":{d},\"spellEntries\":{d},\"spells\":{d},\"unitAuras\":{d},\"auraDefs\":{d},\"vines\":{d},\"smoke\":{d},\"fireWalls\":{d},\"stones\":{d},\"barrels\":{d},\"lap\":{d},\"possibleAttackTypes\":{d},\"storedProperty\":{d}}}",
        .{ st.MAX_UNITS, st.MAX_UIDS, st.MAX_ABILITIES, st.MAX_STOLEN, st.MAX_SPELLS, st.MAX_DEBUFFS, st.MAX_EFFECTS, st.MAX_BOOK, st.MAX_BOOK_SPELLS, st.MAX_UNIT_AURAS, st.MAX_AURA_DEFS, st.MAX_VINES, st.MAX_SMOKE, st.MAX_FIRE, st.MAX_STONES, MAX_BARRELS, MAX_LAP, MAX_POSSIBLE_ATTACK_TYPES, MAX_STORED_PROPERTY },
    );
    try w.writeAll(",\"refuse\":{\"unitFields\":");
    try writeFields(w, &REFUSED_UNIT_FIELDS);
    try w.writeAll(",\"unitFieldParts\":[");
    for (REFUSED_UNIT_FIELD_PARTS, 0..) |f, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeByte('"');
        try w.writeAll(f.key);
        try w.writeByte('.');
        try w.writeAll(f.inner.?);
        try w.writeByte('"');
    }
    try w.writeAll("],\"unitProps\":");
    try writeFields(w, &REFUSED_UNIT_PROPS);
    try w.writeAll(",\"unitPropsLimited\":{");
    for (LIMITED_UNIT_PROPS, 0..) |f, i| {
        if (i > 0) try w.writeByte(',');
        try writeString(w, f.key);
        try w.writeByte(':');
        try writeStrings(w, f.accepted);
    }
    try w.writeByte('}');
    try w.writeAll(",\"unitPropSuffix\":");
    try writeString(w, AUTHORITATIVE_SUFFIX);
    try w.writeAll(",\"unitPropSuffixKept\":");
    try writeStrings(w, &AUTHORITATIVE_KEPT);
    try w.writeAll(",\"grid\":");
    try writeFields(w, &REFUSED_GRID_FIELDS);
    try w.writeAll(",\"fight\":[");
    for (REFUSED_FIGHT_FIELDS, 0..) |f, i| {
        if (i > 0) try w.writeByte(',');
        try w.writeByte('"');
        try w.writeAll(f.key);
        if (f.inner) |inner| {
            try w.writeByte('.');
            try w.writeAll(inner);
        }
        try w.writeByte('"');
    }
    try w.writeAll("],\"artifactsPerTeam\":");
    try writeStrings(w, &ARTIFACT_FIELDS);
    try w.writeAll("}}");
}

pub fn writePolicy(w: *std.Io.Writer, p: PolicyScope) !void {
    try w.writeAll("{\"castable\":");
    if (p.castable) |list| {
        try w.writeByte('[');
        for (list, 0..) |c, i| {
            if (i > 0) try w.writeByte(',');
            try writeString(w, c.name());
        }
        try w.writeByte(']');
    } else {
        try w.writeAll("null");
    }
    try w.writeAll(",\"refusedAbilities\":");
    try writeEnumNames(w, st.AbilityId, p.refused_abilities | p.late.abilities);
    try w.writeAll(",\"refusedDebuffs\":");
    try writeSpellList(w, p.refused_debuffs, p.late.debuffs);
    try w.writeAll(",\"refusedEffects\":");
    try writeSpellList(w, p.refused_effects, p.late.effects);
    try w.writeAll(",\"refusedBuffs\":");
    try writeSpellList(w, p.refused_buffs, p.late.buffs);
    try w.writeAll(if (p.refuse_revived) ",\"refusedRevived\":true" else ",\"refusedRevived\":false");
    try w.writeAll(if (p.refuse_artifact_rows) ",\"refusedArtifactRows\":true" else ",\"refusedArtifactRows\":false");
    try w.writeAll(if (p.refuse_smoke) ",\"refusedSmoke\":true" else ",\"refusedSmoke\":false");
    try w.writeAll(if (p.refuse_fire_walls) ",\"refusedFireWalls\":true}" else ",\"refusedFireWalls\":false}");
}

/// The whole scope (every policy): the body `coverage` hashes.
pub fn writeScope(w: *std.Io.Writer, snapshot_format: i64, policies: []const PolicyScope, actions: []const []const u8, engines: []const []const u8) !void {
    try w.writeAll("{\"loader\":");
    try writeLoader(w, snapshot_format);
    try w.writeAll(",\"policies\":{");
    for (policies, 0..) |p, i| {
        if (i > 0) try w.writeByte(',');
        try writeString(w, p.name);
        try w.writeByte(':');
        try writePolicy(w, p);
    }
    try w.writeAll("},\"actions\":");
    try writeStrings(w, actions);
    try w.writeAll(",\"supportedEngines\":");
    try writeStrings(w, engines);
    try w.writeByte('}');
}

/// sha256 of `body` as 64 lowercase hex digits.
pub fn sha256Hex(body: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(body, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

test "the manifest names the loader's tables and hashes stably" {
    var a: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer a.deinit();
    const v08 = PolicyScope{ .name = "v0.8", .castable = &.{ .heal, .blessing }, .refused_abilities = st.AbilityId.BATCH6A_MASK, .refused_debuffs = &.{.hamstrung}, .refused_effects = &.{ .blindness, .paralysis }, .refused_buffs = comptime spellIdsWhere(st.SpellId.isBatch6Stat), .refuse_revived = true, .refuse_artifact_rows = true, .refuse_smoke = true, .refuse_fire_walls = true };
    try writeScope(&a.writer, 2, &.{ .{ .name = "v0.1" }, v08 }, &.{ "end_turn", "move_unit" }, &.{"match"});
    const text = a.written();
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, text, .{});
    defer parsed.deinit();
    const loader = parsed.value.object.get("loader").?;
    try std.testing.expectEqual(@as(usize, std.meta.fields(st.AbilityId).len - @popCount(REFUSED_ABILITIES)), loader.object.get("abilities").?.array.items.len);
    try std.testing.expectEqual(@as(usize, std.meta.fields(st.SpellId).len - REFUSED_ROWS.len), loader.object.get("applied").?.array.items.len);
    for (loader.object.get("abilities").?.array.items) |n| try std.testing.expect(!std.mem.eql(u8, n.string, "Water Shield"));
    for (loader.object.get("auraEffects").?.array.items) |n| try std.testing.expect(!std.mem.eql(u8, n.string, "Flesh Shield"));
    var castling = false;
    for (loader.object.get("abilities").?.array.items) |n| castling = castling or std.mem.eql(u8, n.string, "Castling");
    try std.testing.expect(castling);
    try std.testing.expectEqualStrings("Venom Cloud", loader.object.get("auraEffects").?.array.items[0].string);
    const refused = parsed.value.object.get("policies").?.object.get("v0.8").?.object.get("refusedAbilities").?.array.items;
    try std.testing.expectEqual(@as(usize, @popCount(st.AbilityId.BATCH6A_MASK)), refused.len);
    try std.testing.expectEqualStrings("lastFuseFatalHit.source", loader.object.get("refuse").?.object.get("unitFieldParts").?.array.items[0].string);
    const v08m = parsed.value.object.get("policies").?.object.get("v0.8").?.object;
    try std.testing.expectEqual(@as(usize, 2), v08m.get("refusedEffects").?.array.items.len);
    try std.testing.expect(v08m.get("refusedBuffs").?.array.items.len >= 1);
    try std.testing.expect(v08m.get("refusedRevived").?.bool);
    try std.testing.expect(parsed.value.object.get("policies").?.object.get("v0.8").?.object.get("refusedArtifactRows").?.bool);
    try std.testing.expect(!parsed.value.object.get("policies").?.object.get("v0.1").?.object.get("refusedArtifactRows").?.bool);
    try std.testing.expect(parsed.value.object.get("policies").?.object.get("v0.8").?.object.get("refusedSmoke").?.bool);
    try std.testing.expectEqual(@as(i64, st.MAX_SMOKE), loader.object.get("capacities").?.object.get("smoke").?.integer);
    try std.testing.expect(parsed.value.object.get("policies").?.object.get("v0.8").?.object.get("refusedFireWalls").?.bool);
    try std.testing.expectEqual(@as(i64, st.MAX_FIRE), loader.object.get("capacities").?.object.get("fireWalls").?.integer);
    const arts = loader.object.get("artifacts").?.object;
    try std.testing.expect(arts.get("tier1").?.array.items.len > 1 and arts.get("tier2").?.array.items.len > 1);
    const limited = loader.object.get("refuse").?.object.get("unitPropsLimited").?.object.get("artifact_granted_abilities").?.array.items;
    try std.testing.expectEqualStrings("Deep Wounds Level 1", limited[0].string);
    try std.testing.expect(refusedAuthoritative("luck_authoritative"));
    try std.testing.expect(!refusedAuthoritative("spell_entries_authoritative"));
    try std.testing.expectEqual(sha256Hex(text), sha256Hex(text));
}

test "no artifact id past MAX_ARTIFACT_ID is supported (the manifest lists them all)" {
    var id: i64 = -4096;
    while (id < 65536) : (id += 1) {
        if (id >= 0 and id <= MAX_ARTIFACT_ID) continue;
        try std.testing.expect(!artifactSupported(0, id) and !artifactSupported(1, id));
    }
}

test "artifactRowBuff / artifactRowDebuff are the rows State.artifacts turns on for" {
    // The self-test fixture's root (no artifact rows), each SpellId in turn on one unit as a buff and as a debuff.
    const snapshot = @import("snapshot.zig");
    const engine = @import("engine.zig");
    const a = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(std.json.Value, a, @embedFile("selftest/state.json"), .{});
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var why: snapshot.Why = .{};
    const ids = try snapshot.unitIds(arena.allocator(), parsed.value, &why);
    const root = try a.create(st.State);
    defer a.destroy(root);
    root.* = try snapshot.load(parsed.value, ids, .{}, &why);
    try std.testing.expect(!root.artifacts);
    const configs = parsed.value.object.get("configs").?;
    const s = try a.create(st.State);
    defer a.destroy(s);
    const ui = root.holder[0];
    inline for (std.meta.fields(st.SpellId)) |f| {
        const id: st.SpellId = @enumFromInt(f.value);
        inline for (.{ false, true }) |debuff| {
            s.* = root.*;
            const row = st.AppliedSpell{ .id = id, .laps = 3, .power = 1 };
            if (debuff) s.units[ui].debuffs.push(row) else s.units[ui].buffs.push(row);
            // The flag is set while the units are scanned; a config the root lacks fails only afterwards.
            engine.loadScopeFlags(s, configs) catch {};
            const want = if (debuff) artifactRowDebuff(id) else artifactRowBuff(id);
            if (s.artifacts != want) std.debug.print("{s} ({s}): State.artifacts {s}, scope {s}\n", .{ id.name(), if (debuff) "debuff" else "buff", if (s.artifacts) "on" else "off", if (want) "on" else "off" });
            try std.testing.expectEqual(want, s.artifacts);
        }
    }
}
