//! JavaScript number semantics the engine relies on: `Number(x.toFixed(f))`, `roundUnitStat`, `Math.round`.

const std = @import("std");

/// `Number(x.toFixed(digits))` for digits 1 or 2, computed exactly from the binary value of x:
/// the nearest multiple of 10^-digits, ties going to the larger magnitude, keeping JS's "-0.0" -> -0.
pub fn toFixed(x: f64, comptime digits: u2) f64 {
    const scale: u64 = if (digits == 1) 10 else 100;
    if (std.math.isNan(x) or std.math.isInf(x)) return x;
    // Fast path (as roundUnitStat's): x already sits on the 10^-digits grid.
    const fscale: f64 = @floatFromInt(scale);
    const scaled = x * fscale;
    if (@abs(scaled) <= 4503599627370496.0 and @floor(scaled) == scaled and scaled / fscale == x) {
        return if (x == 0) 0 else x;
    }
    const neg = x < 0;
    const a = @abs(x);
    if (a >= 9007199254740992.0) return x; // an integer already
    const bits: u64 = @bitCast(a);
    const exp_field: i32 = @intCast((bits >> 52) & 0x7ff);
    var m: u64 = bits & ((@as(u64, 1) << 52) - 1);
    var e: i32 = undefined;
    if (exp_field == 0) {
        e = -1074;
    } else {
        m |= @as(u64, 1) << 52;
        e = exp_field - 1075;
    }
    var n: u64 = undefined;
    if (e >= 0) {
        n = (m << @intCast(e)) * scale;
    } else {
        const k: u32 = @intCast(-e);
        const num: u128 = @as(u128, m) * scale;
        if (k >= 120) {
            n = 0; // num < 2^60, so num / 2^k < 1/2
        } else {
            const den: u128 = @as(u128, 1) << @intCast(k);
            const q: u128 = num >> @intCast(k);
            const rem: u128 = num - (q << @intCast(k));
            n = @intCast(q);
            if (rem * 2 >= den) n += 1;
        }
    }
    const r = @as(f64, @floatFromInt(n)) / @as(f64, @floatFromInt(scale));
    return if (neg) -r else r;
}

/// `roundUnitStat` (src/units/stat_rounding.ts) is numerically `Number(value.toFixed(digits))`.
pub inline fn roundUnitStat(x: f64, comptime digits: u2) f64 {
    return toFixed(x, digits);
}

/// `Math.round`: round half toward +infinity, exact for every double.
pub fn round(x: f64) f64 {
    if (std.math.isNan(x) or std.math.isInf(x)) return x;
    const f = @floor(x);
    return if (x - f >= 0.5) f + 1 else f;
}

test "toFixed matches JavaScript" {
    const t = std.testing;
    try t.expectEqual(@as(f64, -0.1), toFixed(0.05 * -1.0, 1));
    try t.expectEqual(@as(f64, 2.9), toFixed(2.93, 1));
    try t.expectEqual(@as(f64, 1.01), toFixed(1.005 + 0.00000001, 2));
    try t.expectEqual(@as(f64, 1.0), toFixed(1.005, 2)); // 1.005 is 1.00499999999999989... in binary
    try t.expectEqual(@as(f64, 0.3), toFixed(0.15000000000000002 * 2.0, 1));
    try t.expectEqual(@as(f64, 181.02), toFixed(181.01933598375618, 2));
    try t.expect(std.math.signbit(toFixed(-0.01, 1)));
    try t.expectEqual(@as(f64, 3), round(2.5));
    try t.expectEqual(@as(f64, -2), round(-2.5));
    try t.expectEqual(@as(f64, 0), round(0.49999999999999994));
}
