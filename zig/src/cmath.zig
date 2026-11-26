//! The C library's `exp`, exactly as Bun's Math.exp computes it: the learned leaves' sigmoid and the bridge's self-test
//! compare against TypeScript bit for bit, so the port must call the same `exp` Bun calls.
//!
//! On macOS that is libSystem's, which a plain extern imports. On Linux a plain `extern "c" fn exp` is satisfied by the
//! compiler-rt Zig bundles into the shared library (a local `t exp`), whose results differ from glibc's libm in the last
//! bit on about one input in ten (the self-test's table: 519 of 5,138), so the library binds glibc's `exp` at run time
//! from libm.so.6 instead. A missing libm (never on a glibc host) falls back to the bundled `exp`, and the bridge's
//! self-test then refuses the library, so nothing is served inexactly.

const std = @import("std");
const builtin = @import("builtin");

extern "c" fn exp(x: f64) f64;

const ExpFn = *const fn (f64) callconv(.c) f64;

var glibc_exp: ?ExpFn = null;
var bind_once = std.once(bind);

fn bind() void {
    if (builtin.os.tag != .linux) return;
    const handle = std.c.dlopen("libm.so.6", .{ .LAZY = true }) orelse return;
    const sym = std.c.dlsym(handle, "exp") orelse return;
    glibc_exp = @ptrCast(@alignCast(sym));
}

/// Math.exp: glibc's on Linux, libSystem's on macOS.
pub inline fn cExp(x: f64) f64 {
    if (comptime builtin.os.tag == .linux) {
        bind_once.call();
        if (glibc_exp) |f| return f(x);
    }
    return exp(x);
}

/// True when the run-time binding found glibc's libm (always true off Linux, where the plain import is the system's).
pub fn systemExp() bool {
    if (comptime builtin.os.tag != .linux) return true;
    bind_once.call();
    return glibc_exp != null;
}

test "cExp is the C library's exp" {
    try std.testing.expectEqual(@as(f64, 1.0), cExp(0.0));
    try std.testing.expect(systemExp());
}
