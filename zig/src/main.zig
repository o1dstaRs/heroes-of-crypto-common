//! hoc-sim: the Zig engine spike.
//!
//!   hoc-sim parity <recording.jsonl> [--max-fail N]   replay every step and compare with the TypeScript digests
//!   hoc-sim bench  <recording.jsonl> [--reps N] [--threads N]   time the replay of the same steps

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const compare = @import("compare.zig");
const pathing = @import("path.zig");
const ai = @import("ai.zig");

fn readAll(alloc: std.mem.Allocator, path: []const u8) ![]u8 {
    return std.fs.cwd().readFileAlloc(alloc, path, 1 << 34);
}

fn argValue(args: []const []const u8, name: []const u8, default: usize) usize {
    for (args, 0..) |a, i| {
        if (std.mem.eql(u8, a, name) and i + 1 < args.len) return std.fmt.parseInt(usize, args[i + 1], 10) catch default;
    }
    return default;
}

fn describe(action: rec.Action) []const u8 {
    return @tagName(action);
}

fn printEvents(label: []const u8, evs: []const rec.Event) void {
    std.debug.print("    {s}:", .{label});
    for (evs) |e| std.debug.print(" {s}({d})", .{ @tagName(e.kind), e.arg });
    std.debug.print("\n", .{});
}

fn parity(gpa: std.mem.Allocator, path: []const u8, max_fail: usize) !bool {
    const buf = try readAll(gpa, path);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();

    var games: usize = 0;
    var games_ok: usize = 0;
    var steps_total: usize = 0;
    var steps_ok: usize = 0;
    var failures: usize = 0;
    var first_fail_kind = std.StringHashMap(usize).init(gpa);
    defer first_fail_kind.deinit();

    var lines = rec.lines(buf);
    while (lines.next()) |line| {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();
        const game = try rec.parseGame(arena, line, true);
        games += 1;
        var s = engine.initState(game.init, game.ids) catch |err| {
            failures += 1;
            steps_total += game.steps.len;
            if (failures <= max_fail) std.debug.print("seed {d}: start state not supported ({s} {s})\n", .{ game.seed, @errorName(err), engine.unsupported_name });
            continue;
        };
        var events: engine.Events = .{};
        var failed = false;
        for (game.steps, 0..) |step, i| {
            steps_total += 1;
            if (step.action == .decide) {
                // Replay mode: the recorded actions follow as engine steps; resume the stream after the decision.
                s.rng.state = step.r1;
                steps_ok += 1;
                continue;
            }
            s.rng.state = step.r0;
            events.len = 0;
            const ok = engine.apply(&s, step.action, &events);
            var m: compare.Mismatch = .{};
            var why: ?[]const u8 = null;
            if (ok != step.ok) {
                why = "accepted/rejected differs";
            } else if (s.rng.state != step.r1) {
                why = "random stream differs";
            } else if (!compare.eventsMatch(events.slice(), step.events)) {
                why = "events differ";
            } else if (!compare.state(&s, game.ids, step.digest.?, &m)) {
                why = m.text();
            }
            if (why) |reason| {
                failed = true;
                failures += 1;
                const key = try std.fmt.allocPrint(gpa, "{s}", .{describe(step.action)});
                const gop = try first_fail_kind.getOrPut(key);
                if (gop.found_existing) gpa.free(key) else gop.value_ptr.* = 0;
                gop.value_ptr.* += 1;
                if (failures <= max_fail) {
                    std.debug.print("seed {d} step {d}/{d} {s}: {s}\n", .{ game.seed, i, game.steps.len, describe(step.action), reason });
                    std.debug.print("    action {any}\n", .{step.action});
                    std.debug.print("    draws: ts {d}; zig rng state {d} vs ts {d}\n", .{ step.draws, s.rng.state, step.r1 });
                    printEvents("ts events ", step.events);
                    printEvents("zig events", events.slice());
                }
                break;
            }
            steps_ok += 1;
        }
        if (!failed) games_ok += 1;
    }
    std.debug.print("parity: {d}/{d} games identical, {d}/{d} steps before the first divergence\n", .{ games_ok, games, steps_ok, steps_total });
    var it = first_fail_kind.iterator();
    while (it.next()) |e| {
        std.debug.print("  first divergence at {s}: {d} games\n", .{ e.key_ptr.*, e.value_ptr.* });
        gpa.free(e.key_ptr.*);
    }
    return games_ok == games;
}

const BenchGame = struct {
    init: st.State,
    steps: []rec.Step,
};

fn benchWorker(games: []const BenchGame, reps: usize, out_steps: *u64, out_check: *u64) void {
    var steps: u64 = 0;
    var check: u64 = 0;
    var events: engine.Events = .{};
    for (0..reps) |_| {
        for (games) |g| {
            var s = g.init;
            for (g.steps) |step| {
                if (step.action == .decide) continue;
                s.rng.state = step.r0;
                events.len = 0;
                _ = engine.apply(&s, step.action, &events);
                steps += 1;
            }
            check +%= s.rng.state +% @as(u64, @intFromFloat(@max(0, s.units[0].amount_alive)));
        }
    }
    out_steps.* = steps;
    out_check.* = check;
}

fn bench(gpa: std.mem.Allocator, path: []const u8, reps: usize, threads: usize) !void {
    const buf = try readAll(gpa, path);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var list: std.ArrayList(BenchGame) = .empty;
    var lines = rec.lines(buf);
    var total_steps: usize = 0;
    while (lines.next()) |line| {
        // Digests are dropped; the parsed JSON tree for `init` is only read once below.
        const game = try rec.parseGame(arena, line, false);
        try list.append(arena, .{ .init = try engine.initState(game.init, game.ids), .steps = game.steps });
        for (game.steps) |step| {
            if (step.action != .decide) total_steps += 1;
        }
    }
    const games = list.items;

    // Warm up once on one thread.
    var ws: u64 = 0;
    var wc: u64 = 0;
    benchWorker(games, 1, &ws, &wc);

    const n = @max(1, threads);
    const step_counts = try gpa.alloc(u64, n);
    defer gpa.free(step_counts);
    const checks = try gpa.alloc(u64, n);
    defer gpa.free(checks);
    const handles = try gpa.alloc(std.Thread, n);
    defer gpa.free(handles);

    var timer = try std.time.Timer.start();
    for (0..n) |t| handles[t] = try std.Thread.spawn(.{}, benchWorker, .{ games, reps, &step_counts[t], &checks[t] });
    for (handles) |h| h.join();
    const ns = timer.read();

    var steps: u64 = 0;
    var check: u64 = 0;
    for (step_counts, checks) |sc, c| {
        steps += sc;
        check +%= c;
    }
    const ns_per_step = @as(f64, @floatFromInt(ns)) / @as(f64, @floatFromInt(steps)) * @as(f64, @floatFromInt(n));
    std.debug.print(
        "bench: {d} games, {d} steps x {d} reps x {d} threads in {d:.1} ms -> {d:.0} ns/step per thread, {d:.2} M steps/s total (check {x})\n",
        .{ games.len, total_steps, reps, n, @as(f64, @floatFromInt(ns)) / 1e6, ns_per_step, @as(f64, @floatFromInt(steps)) / (@as(f64, @floatFromInt(ns)) / 1e9) / 1e6, check },
    );
}

/// Recomputes every recorded getMovePath call and compares knownPaths order, weights and routes exactly.
fn pathCheck(gpa: std.mem.Allocator, file: []const u8, max_fail: usize) !bool {
    const buf = try readAll(gpa, file);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var calls: usize = 0;
    var ok_calls: usize = 0;
    var fails: usize = 0;
    var mp: pathing.MovePath = undefined;
    var lines = rec.lines(buf);
    while (lines.next()) |line| {
        _ = arena_state.reset(.retain_capacity);
        const v = try std.json.parseFromSliceLeaky(std.json.Value, arena_state.allocator(), line, .{});
        calls += 1;
        var m: pathing.Matrix = undefined;
        const rows = rec.get(v, "matrix").array.items;
        for (0..st.GRID) |y| {
            for (0..st.GRID) |x| m[x][y] = @intCast(rec.int(rows[y].array.items[x]));
        }
        var aggr: [st.GRID][st.GRID]i16 = undefined;
        const cols = rec.get(v, "aggr").array.items;
        for (0..st.GRID) |x| {
            for (0..st.GRID) |y| aggr[x][y] = @intCast(rec.int(cols[x].array.items[y]));
        }
        const cell = rec.get(v, "cell").array.items;
        pathing.getMovePath(&m, .{
            .start = .{ .x = @intCast(rec.int(cell[0])), .y = @intCast(rec.int(cell[1])) },
            .max_steps = rec.num(rec.get(v, "maxSteps")),
            .aggr = &aggr,
            .can_fly = rec.get(v, "canFly").bool,
            .w = @intCast(rec.int(rec.get(v, "w"))),
            .h = @intCast(rec.int(rec.get(v, "h"))),
        }, &mp);
        const known = rec.get(v, "known").array.items;
        var why: ?[]const u8 = null;
        var at_i: usize = 0;
        if (known.len != mp.size()) why = "knownPaths size";
        if (why == null) {
            var cells: [64]st.Cell = undefined;
            for (known, mp.known(), 0..) |e, r, i| {
                at_i = i;
                const kk = e.array.items;
                if (rec.int(kk[0]) != pathing.key(r.cell.x, r.cell.y)) {
                    why = "key order";
                    break;
                }
                if (rec.num(kk[1]) != r.weight) {
                    why = "weight";
                    break;
                }
                const route = kk[2].array.items;
                const len = mp.routeCells(&r, &cells);
                if (len != route.len) {
                    why = "route length";
                    break;
                }
                for (route, cells[0..len]) |c, z| {
                    if (rec.int(c.array.items[0]) != z.x or rec.int(c.array.items[1]) != z.y) why = "route cells";
                }
                if (why != null) break;
            }
        }
        if (why) |reason| {
            fails += 1;
            if (fails <= max_fail) {
                std.debug.print("call {d}: {s} at entry {d} (ts {d} entries, zig {d}) cell {any} steps {d}\n", .{ calls, reason, at_i, known.len, mp.size(), cell[0], rec.num(rec.get(v, "maxSteps")) });
            }
        } else ok_calls += 1;
    }
    std.debug.print("paths: {d}/{d} getMovePath calls identical\n", .{ ok_calls, calls });
    return ok_calls == calls;
}

/// Plays every recorded battle natively (Zig AI + engine) and checks each step against the recording.
fn native(gpa: std.mem.Allocator, file: []const u8, max_fail: usize) !bool {
    const buf = try readAll(gpa, file);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var games: usize = 0;
    var games_ok: usize = 0;
    var steps_ok: usize = 0;
    var steps_total: usize = 0;
    var fails: usize = 0;
    var lines = rec.lines(buf);
    while (lines.next()) |line| {
        _ = arena_state.reset(.retain_capacity);
        const game = try rec.parseGame(arena_state.allocator(), line, true);
        games += 1;
        steps_total += game.steps.len;
        var s = engine.initState(game.init, game.ids) catch |err| {
            fails += 1;
            if (fails <= max_fail) std.debug.print("seed {d}: start state not supported ({s} {s})\n", .{ game.seed, @errorName(err), engine.unsupported_name });
            continue;
        };
        s.rng.state = game.steps[0].r0;
        var check = compare.NativeCheck{ .game = &game, .ids = game.ids };
        const end = ai.playMatch(&s, 60, .{ .ctx = &check, .step = compare.NativeCheck.step });
        if (check.failed == null and check.next != game.steps.len) check.failed = "zig stopped early";
        steps_ok += check.next;
        if (check.failed) |why| {
            fails += 1;
            if (fails <= max_fail) {
                std.debug.print("seed {d} step {d}/{d}: {s} (end {s})\n", .{ game.seed, check.next, game.steps.len, why, @tagName(end) });
                if (check.next < game.steps.len) std.debug.print("    ts  {any}\n", .{game.steps[check.next].action});
                std.debug.print("    zig {any}\n", .{check.zig_action});
            }
        } else games_ok += 1;
    }
    std.debug.print("native: {d}/{d} games identical, {d}/{d} steps before the first divergence\n", .{ games_ok, games, steps_ok, steps_total });
    return games_ok == games;
}

fn nativeBenchWorker(inits: []const st.State, r0s: []const u32, reps: usize, out_games: *u64, out_check: *u64) void {
    var n: u64 = 0;
    var check: u64 = 0;
    for (0..reps) |_| {
        for (inits, r0s) |init_state, r0| {
            var s = init_state;
            s.rng.state = r0;
            const end = ai.playMatch(&s, 60, null);
            check +%= s.rng.state +% @intFromEnum(end);
            n += 1;
        }
    }
    out_games.* = n;
    out_check.* = check;
}

/// Times whole native battles (AI + engine) from the recorded start states.
fn nativeBench(gpa: std.mem.Allocator, file: []const u8, reps: usize, threads: usize) !void {
    const buf = try readAll(gpa, file);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var inits: std.ArrayList(st.State) = .empty;
    var r0s: std.ArrayList(u32) = .empty;
    var lines = rec.lines(buf);
    while (lines.next()) |line| {
        const game = try rec.parseGame(arena_state.allocator(), line, false);
        try inits.append(arena_state.allocator(), try engine.initState(game.init, game.ids));
        try r0s.append(arena_state.allocator(), game.steps[0].r0);
    }
    var g0: u64 = 0;
    var c0: u64 = 0;
    nativeBenchWorker(inits.items, r0s.items, 1, &g0, &c0);
    const n = @max(1, threads);
    const counts = try gpa.alloc(u64, n);
    defer gpa.free(counts);
    const checks = try gpa.alloc(u64, n);
    defer gpa.free(checks);
    const handles = try gpa.alloc(std.Thread, n);
    defer gpa.free(handles);
    var timer = try std.time.Timer.start();
    for (0..n) |t| handles[t] = try std.Thread.spawn(.{}, nativeBenchWorker, .{ inits.items, r0s.items, reps, &counts[t], &checks[t] });
    for (handles) |h| h.join();
    const ns = timer.read();
    var games: u64 = 0;
    for (counts) |x| games += x;
    const per_game_us = @as(f64, @floatFromInt(ns)) / @as(f64, @floatFromInt(games)) * @as(f64, @floatFromInt(n)) / 1000;
    std.debug.print("native-bench: {d} battles x {d} reps x {d} threads in {d:.1} ms -> {d:.1} us/battle per thread, {d:.0} battles/s total (check {x})\n", .{ inits.items.len, reps, n, @as(f64, @floatFromInt(ns)) / 1e6, per_game_us, @as(f64, @floatFromInt(games)) / (@as(f64, @floatFromInt(ns)) / 1e9), c0 });
}

pub fn main() !void {
    var gpa_state: std.heap.GeneralPurposeAllocator(.{}) = .init;
    defer _ = gpa_state.deinit();
    const gpa = gpa_state.allocator();

    const args = try std.process.argsAlloc(gpa);
    defer std.process.argsFree(gpa, args);
    if (args.len < 3) {
        std.debug.print("usage: hoc-sim (parity|bench) <recording.jsonl> [--max-fail N] [--reps N] [--threads N]\n", .{});
        std.process.exit(2);
    }
    const cmd = args[1];
    const path_arg = args[2];
    if (std.mem.eql(u8, cmd, "parity")) {
        const ok = try parity(gpa, path_arg, argValue(args, "--max-fail", 10));
        if (!ok) std.process.exit(1);
    } else if (std.mem.eql(u8, cmd, "v08")) {
        try @import("v08/main.zig").run(gpa, args[2..]);
    } else if (std.mem.eql(u8, cmd, "native")) {
        if (!try native(gpa, path_arg, argValue(args, "--max-fail", 10))) std.process.exit(1);
    } else if (std.mem.eql(u8, cmd, "native-bench")) {
        try nativeBench(gpa, path_arg, argValue(args, "--reps", 5), argValue(args, "--threads", 1));
    } else if (std.mem.eql(u8, cmd, "paths")) {
        if (!try pathCheck(gpa, path_arg, argValue(args, "--max-fail", 10))) std.process.exit(1);
    } else if (std.mem.eql(u8, cmd, "bench")) {
        try bench(gpa, path_arg, argValue(args, "--reps", 5), argValue(args, "--threads", 1));
    } else {
        std.debug.print("unknown command {s}\n", .{cmd});
        std.process.exit(2);
    }
}
