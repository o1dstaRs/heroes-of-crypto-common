const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseFast });

    // The common commit the artifacts are built from (`-Dcommon-sha=$(git rev-parse HEAD)`): hoc_build_info reports
    // it, and the bridge refuses a library built from another revision than the TypeScript it runs beside.
    const options = b.addOptions();
    options.addOption([]const u8, "common_sha", b.option([]const u8, "common-sha", "Common commit embedded in hoc_build_info (default \"unknown\")") orelse "unknown");

    // libc: the learned leaves' sigmoid calls the C library's `exp` (src/v08/util.zig, src/rollout.zig), as Bun's
    // Math.exp does. On Linux build for the system glibc (x86_64-linux-gnu, dynamic), not static musl: musl's exp can
    // differ from glibc's in the last bit, which flips exact ties against the TypeScript search.
    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    mod.addOptions("build_options", options);
    const exe = b.addExecutable(.{ .name = "hoc-sim", .root_module = mod });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "Run hoc-sim (parity | bench) <recording.jsonl>").dependOn(&run.step);

    // The bridge's shared library (zig/BRIDGE.md): zig-out/lib/libhocsim.dylib on macOS, libhocsim.so on Linux.
    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/ffi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    lib_mod.addOptions("build_options", options);
    const lib = b.addLibrary(.{ .linkage = .dynamic, .name = "hocsim", .root_module = lib_mod });
    b.step("lib", "Build the bridge's shared library (zig-out/lib/libhocsim)").dependOn(&b.addInstallArtifact(lib, .{}).step);

    const test_mod = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addOptions("build_options", options);
    const tests = b.addTest(.{ .root_module = test_mod });
    b.step("test", "Run unit tests").dependOn(&b.addRunArtifact(tests).step);
}
