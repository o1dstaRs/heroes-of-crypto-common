//! hoc-sim: the Zig engine spike.
//!
//!   hoc-sim parity <recording.jsonl> [--max-fail N]   replay every step and compare with the TypeScript digests
//!   hoc-sim native <recording.jsonl> [--max-fail N]   play every battle natively and compare every step
//!   hoc-sim resume <recording.jsonl> [--max-fail N]   load each embedded mid-battle export, then replay and play
//!                                                     natively from there (RECORD_RESUME recordings)
//!   hoc-sim play-state <state.json> [--max-laps N]    play an exported battle out natively; prints the result
//!   hoc-sim bench  <recording.jsonl> [--reps N] [--threads N]   time the replay of the same steps

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const compare = @import("compare.zig");
const pathing = @import("path.zig");
const ai = @import("ai.zig");
const snapshot = @import("snapshot.zig");
const rollout = @import("rollout.zig");
const digest = @import("digest.zig");

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

/// A game the loader cannot parse (an action or event outside the port): reported and skipped like an unsupported
/// start state.
fn reportUnparseable(err: anyerror) void {
    std.debug.print("seed {d}: recording not supported at step {d} ({s})\n", .{ rec.parse_seed, rec.parse_step, @errorName(err) });
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
        games += 1;
        const game = rec.parseGame(arena, line, true) catch |err| {
            failures += 1;
            if (failures <= max_fail) reportUnparseable(err);
            continue;
        };
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
            const ok = engine.apply(&s, engine.actionToSlots(&s, step.action), &events);
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
                    std.debug.print("    draws: ts {d}; zig rng state {d} vs ts {d}; slots {d}, holder {d}{s}\n", .{ step.draws, s.rng.state, step.r1, s.n_units, s.n_holder, if (s.overflow) ", capacity exceeded" else "" });
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
                _ = engine.apply(&s, engine.actionToSlots(&s, step.action), &events);
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
        const game = rec.parseGame(arena, line, false) catch |err| {
            reportUnparseable(err);
            continue;
        };
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

/// Recomputes every recorded getMovePath call and compares knownPaths order, weights, routes and (when recorded) each
/// route's hasLavaCell exactly. `vine` is accepted and ignored (no vines exist in scope, so a vine strider gets the
/// normal path); a made-of-fire call is not ported and counts as a mismatch.
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
        if (rec.get(v, "fire") == .bool and rec.get(v, "fire").bool) {
            fails += 1;
            if (fails <= max_fail) std.debug.print("call {d}: made of fire (not ported)\n", .{calls});
            continue;
        }
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
                if (kk.len > 3 and (rec.int(kk[3]) == 1) != r.has_lava) {
                    why = "hasLavaCell";
                    break;
                }
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
        games += 1;
        const game = rec.parseGame(arena_state.allocator(), line, true) catch |err| {
            fails += 1;
            if (fails <= max_fail) reportUnparseable(err);
            continue;
        };
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

/// Per-mode tallies of `hoc-sim resume`.
const ResumeTally = struct {
    points: usize = 0,
    ok: usize = 0,
    steps_ok: usize = 0,
    steps_total: usize = 0,
    fails: usize = 0,
};

/// One resume point of a recording (record.ts RECORD_RESUME): replays the remaining engine steps (`native` false) or
/// plays natively from the snapshot (`native` true), checking every remaining step. Returns the failure, if any.
fn resumeOne(game: *const rec.Game, start: *const st.State, k: usize, native_mode: bool, tally: *ResumeTally, max_fail: usize) void {
    const label = if (native_mode) "native" else "replay";
    var s = start.*;
    tally.points += 1;
    tally.steps_total += game.steps.len - k;
    if (native_mode) {
        var check = compare.NativeCheck{ .game = game, .ids = game.ids, .next = k };
        const end = ai.continueMatchWith(&s, 60, .{ .ctx = &check, .step = compare.NativeCheck.step }, ai.decideTurn);
        if (check.failed == null and check.next != game.steps.len) check.failed = "zig stopped early";
        tally.steps_ok += check.next - k;
        if (check.failed) |why| {
            tally.fails += 1;
            if (tally.fails <= max_fail) {
                std.debug.print("seed {d} resume@{d} {s} step {d}/{d}: {s} (end {s})\n", .{ game.seed, k, label, check.next, game.steps.len, why, @tagName(end) });
                if (check.next < game.steps.len) std.debug.print("    ts  {any}\n", .{game.steps[check.next].action});
                std.debug.print("    zig {any}\n", .{check.zig_action});
            }
            return;
        }
        tally.ok += 1;
        return;
    }
    var events: engine.Events = .{};
    for (game.steps[k..], k..) |step, i| {
        if (step.action == .decide) {
            s.rng.state = step.r1;
            tally.steps_ok += 1;
            continue;
        }
        s.rng.state = step.r0;
        events.len = 0;
        const ok = engine.apply(&s, engine.actionToSlots(&s, step.action), &events);
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
            tally.fails += 1;
            if (tally.fails <= max_fail) {
                std.debug.print("seed {d} resume@{d} {s} step {d}/{d} {s}: {s}\n", .{ game.seed, k, label, i, game.steps.len, describe(step.action), reason });
                std.debug.print("    action {any}\n", .{step.action});
            }
            return;
        }
        tally.steps_ok += 1;
    }
    tally.ok += 1;
}

/// `hoc-sim resume`: for every resume point of a RECORD_RESUME recording, loads the embedded mid-battle export
/// (snapshot.zig), checks it against the recorded digest of the step before, then (a) replays the remaining recorded
/// engine steps and (b) plays natively from there, comparing every remaining step as `parity` and `native` do.
fn resumeCheck(gpa: std.mem.Allocator, file: []const u8, max_fail: usize) !bool {
    const buf = try readAll(gpa, file);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var games: usize = 0;
    var games_without: usize = 0;
    var unparseable: usize = 0;
    var unsupported: usize = 0;
    var load_fail: usize = 0;
    var loaded: usize = 0;
    // Where the points fall in their battles: thirds of the step count.
    var thirds = [3]usize{ 0, 0, 0 };
    var reasons = std.StringHashMap(usize).init(gpa);
    defer {
        var it = reasons.keyIterator();
        while (it.next()) |k| gpa.free(k.*);
        reasons.deinit();
    }
    var replay: ResumeTally = .{};
    var native_tally: ResumeTally = .{};
    var load_ns: u64 = 0;
    var lines = rec.lines(buf);
    while (lines.next()) |line| {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();
        games += 1;
        const root = std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{}) catch |err| {
            unparseable += 1;
            if (unparseable <= max_fail) std.debug.print("game {d}: bad JSON ({s})\n", .{ games, @errorName(err) });
            continue;
        };
        const points = rec.get(root, "resume");
        const game = rec.parseGameValue(arena, root, true) catch |err| {
            unparseable += 1;
            if (unparseable <= max_fail) reportUnparseable(err);
            // The steps are outside the port, but the loader can still say what it refuses in the exports.
            if (points == .array) {
                const units = rec.get(rec.get(root, "init"), "units");
                if (units != .array) continue;
                const ids = try arena.alloc([]const u8, units.array.items.len);
                for (units.array.items, 0..) |u, i| ids[i] = rec.get(u, "id").string;
                for (points.array.items) |p| {
                    var why: snapshot.Why = .{};
                    _ = snapshot.load(rec.get(p, "state"), ids, .{}, &why) catch |lerr| {
                        if (lerr != error.UnsupportedState) continue;
                        unsupported += 1;
                        const gop = try reasons.getOrPut(why.text());
                        if (!gop.found_existing) {
                            gop.key_ptr.* = try gpa.dupe(u8, why.text());
                            gop.value_ptr.* = 0;
                        }
                        gop.value_ptr.* += 1;
                    };
                }
            }
            continue;
        };
        if (points != .array or points.array.items.len == 0) {
            games_without += 1;
            continue;
        }
        for (points.array.items) |p| {
            const k: usize = @intCast(rec.int(rec.get(p, "step")));
            if (k == 0 or k >= game.steps.len or game.steps[k].action != .decide) {
                load_fail += 1;
                if (load_fail <= max_fail) std.debug.print("seed {d}: resume step {d} is not a decision\n", .{ game.seed, k });
                continue;
            }
            var why: snapshot.Why = .{};
            var timer = try std.time.Timer.start();
            const created = rec.get(p, "summonsCreated");
            const s = snapshot.load(rec.get(p, "state"), game.ids, .{
                .rng = @intCast(rec.int(rec.get(p, "rng"))),
                .active = rec.get(p, "unitId").string,
                // The recording numbers summons in creation order after the start units.
                .next_uid = if (created == .integer) @intCast(game.n_start + @as(usize, @intCast(created.integer))) else null,
            }, &why) catch |err| {
                if (err == error.UnsupportedState) {
                    unsupported += 1;
                    const gop = try reasons.getOrPut(why.text());
                    if (!gop.found_existing) {
                        gop.key_ptr.* = try gpa.dupe(u8, why.text());
                        gop.value_ptr.* = 0;
                    }
                    gop.value_ptr.* += 1;
                    if (unsupported <= max_fail) std.debug.print("seed {d} resume@{d}: unsupported state ({s})\n", .{ game.seed, k, why.text() });
                } else {
                    load_fail += 1;
                    if (load_fail <= max_fail) std.debug.print("seed {d} resume@{d}: {s} ({s})\n", .{ game.seed, k, @errorName(err), why.text() });
                }
                continue;
            };
            load_ns += timer.read();
            // The snapshot is the state after the step before the decision.
            var m: compare.Mismatch = .{};
            const r0_ok = s.rng.state == game.steps[k].r0 and s.active >= 0 and s.units[@intCast(s.active)].uid == game.steps[k].action.decide.unit;
            if (!r0_ok or (game.steps[k - 1].digest != null and !compare.state(&s, game.ids, game.steps[k - 1].digest.?, &m))) {
                load_fail += 1;
                if (load_fail <= max_fail) std.debug.print("seed {d} resume@{d}: loaded state differs from the recorded digest: {s}\n", .{ game.seed, k, if (r0_ok) m.text() else "random state or active unit" });
                continue;
            }
            loaded += 1;
            thirds[@min(2, k * 3 / game.steps.len)] += 1;
            resumeOne(&game, &s, k, false, &replay, max_fail);
            resumeOne(&game, &s, k, true, &native_tally, max_fail);
        }
    }
    std.debug.print("resume: {d} games ({d} without a resume point, {d} unparseable); {d} points loaded and identical to the recorded digest, {d} unsupported, {d} failed to load\n", .{ games, games_without, unparseable, loaded, unsupported, load_fail });
    std.debug.print("  points by battle third: early {d}, mid {d}, late {d}; load {d:.1} us per snapshot\n", .{ thirds[0], thirds[1], thirds[2], if (loaded > 0) @as(f64, @floatFromInt(load_ns)) / @as(f64, @floatFromInt(loaded)) / 1000 else 0 });
    for ([_]struct { []const u8, *const ResumeTally }{ .{ "replay", &replay }, .{ "native", &native_tally } }) |t| {
        std.debug.print("  {s}: {d}/{d} resumed battles identical, {d}/{d} remaining steps before the first divergence\n", .{ t[0], t[1].ok, t[1].points, t[1].steps_ok, t[1].steps_total });
    }
    var it = reasons.iterator();
    while (it.next()) |e| std.debug.print("  unsupported: {s}: {d}\n", .{ e.key_ptr.*, e.value_ptr.* });
    return load_fail == 0 and unparseable == 0 and replay.fails == 0 and native_tally.fails == 0;
}

/// `hoc-sim play-state`: loads one exported battle (state_export.ts, with its `harness` block), plays it out with v0.1
/// on both seats, and prints `{"result": {...}, "digest": {...}}` (rollout.PlayResult, digest.zig) on stdout.
fn playState(gpa: std.mem.Allocator, file: []const u8, max_laps: i32) !bool {
    const buf = try readAll(gpa, file);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, buf, .{});
    var why: snapshot.Why = .{};
    const ids = snapshot.unitIds(arena, root, &why) catch |err| {
        std.debug.print("state not loaded: {s} ({s})\n", .{ @errorName(err), why.text() });
        return false;
    };
    var s = snapshot.load(root, ids, .{}, &why) catch |err| {
        std.debug.print("state not loaded: {s} ({s})\n", .{ @errorName(err), why.text() });
        return false;
    };
    var summoned: rollout.SummonIds = .{ .first = s.next_uid, .alloc = arena };
    const r = rollout.playHooked(&s, max_laps, ai.decideTurn, summoned.hook());
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    try out.writer.print("{{\"result\":{{\"end\":{d},\"winner\":{d},\"lap\":{d},\"steps\":{d},\"decisions\":{d},\"rng\":{d}}},\"digest\":", .{ r.end, r.winner, r.lap, r.steps, r.decisions, r.rng });
    try digest.write(&out.writer, &s, try summoned.table(arena, ids));
    try out.writer.writeAll("}\n");
    try std.fs.File.stdout().writeAll(out.written());
    return true;
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
        const game = rec.parseGame(arena_state.allocator(), line, false) catch |err| {
            reportUnparseable(err);
            continue;
        };
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
        std.debug.print("usage: hoc-sim (parity|native|resume|bench|native-bench|paths) <recording.jsonl> [--max-fail N] [--reps N] [--threads N]\n       hoc-sim play-state <state.json> [--max-laps N]\n", .{});
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
    } else if (std.mem.eql(u8, cmd, "resume")) {
        if (!try resumeCheck(gpa, path_arg, argValue(args, "--max-fail", 10))) std.process.exit(1);
    } else if (std.mem.eql(u8, cmd, "play-state")) {
        if (!try playState(gpa, path_arg, @intCast(argValue(args, "--max-laps", 60)))) std.process.exit(1);
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
