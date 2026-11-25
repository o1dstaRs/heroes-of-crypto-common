//! The engine's seeded random stream, bit-identical to the TypeScript simulation path:
//! mulberry32 (`makeRng` in src/simulation/army.ts) feeding `getRandomInt` (src/utils/lib.ts).
//!
//! TypeScript turns each mulberry32 output u into the double u / 2^32, then builds a 53-bit value from two
//! draws: hi = floor(r1 * 2^21) and lo = floor(r2 * 2^32). Both products are exact in f64, so
//! hi = u1 >> 11 and lo = u2, and the whole stream is plain integer arithmetic here.

const std = @import("std");

pub const Rng = struct {
    state: u32,
    draws: u64 = 0,

    pub fn init(state: u32) Rng {
        return .{ .state = state };
    }

    /// One mulberry32 output as the 32-bit integer behind TypeScript's `u / 4294967296`.
    pub inline fn nextU32(self: *Rng) u32 {
        self.draws += 1;
        self.state +%= 0x6d2b79f5;
        var t: u32 = self.state;
        t = (t ^ (t >> 15)) *% (t | 1);
        t ^= t +% ((t ^ (t >> 7)) *% (t | 61));
        return t ^ (t >> 14);
    }

    inline fn nextRaw53(self: *Rng) u64 {
        const hi: u64 = self.nextU32() >> 11;
        const lo: u64 = self.nextU32();
        return (hi << 32) | lo;
    }

    /// Uniform integer in [min, max), with TypeScript's rejection sampling. A span of 0 or 1 draws nothing.
    pub fn int(self: *Rng, min: i64, max: i64) i64 {
        std.debug.assert(max >= min);
        if (max == min) return min;
        const span: u64 = @intCast(max - min);
        if (span == 1) return min;
        // Turn and morale draws use small spans: give the compiler constant divisors for them.
        return switch (span) {
            inline 2...40, 100 => |c| @as(i64, @intCast(self.uniform(c))) + min,
            else => @as(i64, @intCast(self.uniform(span))) + min,
        };
    }

    inline fn uniform(self: *Rng, span: u64) u64 {
        const two53: u64 = @as(u64, 1) << 53;
        const limit = (two53 / span) * span;
        while (true) {
            const r = self.nextRaw53();
            if (r < limit) return r % span;
        }
    }

    /// Fisher-Yates exactly as `shuffleWithRng` / `shuffle` in TypeScript.
    pub fn shuffle(self: *Rng, comptime T: type, items: []T) void {
        if (items.len < 2) return;
        var i: usize = items.len - 1;
        while (i > 0) : (i -= 1) {
            const j: usize = @intCast(self.int(0, @intCast(i + 1)));
            std.mem.swap(T, &items[i], &items[j]);
        }
    }
};

test "mulberry32 matches the TypeScript stream" {
    // Expected values from: makeRng(12345) in src/simulation/army.ts, multiplied back by 2^32.
    var r = Rng.init(12345);
    const expected = [_]u32{ 4207900869, 1317490944, 2079646450 };
    for (expected) |e| try std.testing.expectEqual(e, r.nextU32());
}

test "getRandomInt matches the TypeScript stream" {
    // Expected values from: setDeterministicRandomSource(makeRng(777)); getRandomInt(0, spans[i % 7]).
    var r = Rng.init(777);
    const spans = [_]i64{ 2, 3, 7, 100, 1, 5, 1000000007 };
    const expected = [_]i64{ 1, 0, 0, 39, 0, 1, 311655492, 1, 0, 5, 96, 0, 2, 931189256, 1, 1, 3, 85, 0, 1 };
    for (expected, 0..) |e, i| try std.testing.expectEqual(e, r.int(0, spans[i % 7]));
}
