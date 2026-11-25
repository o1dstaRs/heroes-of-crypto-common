//! The v0.8 policy port: entry point for `hoc-sim v08 <args>`. Owned by the v0.8 port; replace freely.
//! Everything outside src/v08/ (state.zig, engine.zig, ...) is read-only API from here.

const std = @import("std");

/// `args` are the command-line arguments after `hoc-sim v08`.
pub fn run(gpa: std.mem.Allocator, args: []const []const u8) !void {
    _ = gpa;
    _ = args;
    std.debug.print("hoc-sim v08: not implemented yet\n", .{});
    return error.NotImplemented;
}

test {
    // Add `_ = @import("<file>.zig");` lines here to include v0.8 tests in `zig build test`.
}
