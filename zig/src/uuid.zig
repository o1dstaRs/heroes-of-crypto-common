//! Unit ids as the port keeps them: canonical lowercase UUIDs as 16 bytes (`parse`, `format`), and the summon ids
//! runMatch's createSummonedUnit derives (src/simulation/army.ts `deterministicSimulationId`, `hashSimulationParts`).

const std = @import("std");

pub const Uuid = [16]u8;

fn hexValue(c: u8) ?u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        else => null,
    };
}

/// A canonical lowercase 8-4-4-4-12 UUID string as its 16 bytes, or null for any other id.
pub fn parse(text: []const u8) ?Uuid {
    if (text.len != 36) return null;
    var out: Uuid = undefined;
    var n: usize = 0;
    var i: usize = 0;
    while (i < 36) {
        if (i == 8 or i == 13 or i == 18 or i == 23) {
            if (text[i] != '-') return null;
            i += 1;
            continue;
        }
        const hi = hexValue(text[i]) orelse return null;
        const lo = hexValue(text[i + 1]) orelse return null;
        out[n] = (hi << 4) | lo;
        n += 1;
        i += 2;
    }
    return out;
}

/// uuidFromBytes: lowercase 8-4-4-4-12.
pub fn format(b: *const Uuid, out: *[36]u8) []const u8 {
    const hex = "0123456789abcdef";
    var o: usize = 0;
    for (b, 0..) |x, i| {
        if (i == 4 or i == 6 or i == 8 or i == 10) {
            out[o] = '-';
            o += 1;
        }
        out[o] = hex[x >> 4];
        out[o + 1] = hex[x & 15];
        o += 2;
    }
    return out[0..36];
}

/// The incremental FNV-1a of hashSimulationParts: each part as the UTF-16 units of `${len}:${part}|` (ASCII here).
const Fnv = struct {
    h: u32 = 0x811c9dc5,

    fn bytes(self: *Fnv, s: []const u8) void {
        for (s) |c| self.h = (self.h ^ c) *% 0x01000193;
    }
    fn part(self: *Fnv, s: []const u8) void {
        var buf: [24]u8 = undefined;
        self.bytes(std.fmt.bufPrint(&buf, "{d}:", .{s.len}) catch unreachable);
        self.bytes(s);
        self.bytes("|");
    }
    fn finish(self: *const Fnv) u32 {
        var h = self.h;
        h ^= h >> 16;
        h *%= 0x85ebca6b;
        h ^= h >> 13;
        h *%= 0xc2b2ae35;
        return h ^ (h >> 16);
    }
};

/// deterministicSimulationId(...parts) for string parts (numbers already in their String(x) form).
pub fn simulationId(parts: []const []const u8) Uuid {
    var out: Uuid = undefined;
    for (0..4) |word| {
        var f: Fnv = .{};
        f.part("simulation-unit");
        var wbuf: [4]u8 = undefined;
        f.part(std.fmt.bufPrint(&wbuf, "{d}", .{word}) catch unreachable);
        for (parts) |p| f.part(p);
        const v = f.finish();
        out[word * 4] = @truncate(v >> 24);
        out[word * 4 + 1] = @truncate(v >> 16);
        out[word * 4 + 2] = @truncate(v >> 8);
        out[word * 4 + 3] = @truncate(v);
    }
    out[6] = (out[6] & 0x0f) | 0x50;
    out[8] = (out[8] & 0x3f) | 0x80;
    return out;
}

/// The id createSummonedUnit gives a summon: deterministicSimulationId("summon", seed, team, faction, unitName,
/// casterId, sourceAbility, sequence). `seed` is null when the match has none (String(undefined)).
pub fn summonId(seed: ?i64, team: u8, faction: u8, name: []const u8, caster: *const Uuid, ability: []const u8, sequence: u32) Uuid {
    var seed_buf: [24]u8 = undefined;
    const seed_text = if (seed) |x| std.fmt.bufPrint(&seed_buf, "{d}", .{x}) catch unreachable else "undefined";
    var team_buf: [4]u8 = undefined;
    var faction_buf: [4]u8 = undefined;
    var seq_buf: [12]u8 = undefined;
    var caster_buf: [36]u8 = undefined;
    const parts = [_][]const u8{
        "summon",
        seed_text,
        std.fmt.bufPrint(&team_buf, "{d}", .{team}) catch unreachable,
        std.fmt.bufPrint(&faction_buf, "{d}", .{faction}) catch unreachable,
        name,
        format(caster, &caster_buf),
        ability,
        std.fmt.bufPrint(&seq_buf, "{d}", .{sequence}) catch unreachable,
    };
    return simulationId(&parts);
}

test "summon id matches deterministicSimulationId" {
    const caster = parse("123943f5-e323-54ee-987c-37c8937149b8").?;
    const id = summonId(9400000, 2, 3, "Arachna Spider", &caster, "Infest", 0);
    var buf: [36]u8 = undefined;
    try std.testing.expectEqualStrings("a95bee9d-5a2a-533b-8641-6e6bb7f2ab49", format(&id, &buf));
    try std.testing.expect(parse("A95BEE9D-5a2a-533b-8641-6e6bb7f2ab49") == null);
}
