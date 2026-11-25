//! The v0.8 policy port: entry point for `hoc-sim v08 <command> ...`. Everything outside src/v08/ is read-only API.
//!
//!   hoc-sim v08 layers <recording.jsonl> [--top v0.2] [--passes] [--max-fail N]
//!       Replays a layer recording (zig/parity/v08/record.ts with RECORD_LAYERS=1) in the Zig engine and, at every
//!       decision, runs the Zig chain up to --top on a copy of the state, comparing each level's output and random
//!       state with the logged layer of the same name (the k-th Zig "v0.2" against the k-th logged "v0.2").
//!       --passes also checks every ported v0.8 pass (lv8.zig) in isolation: run on the logged output of the layer
//!       before it, its output must equal its own logged layer. Passes not ported yet are skipped.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const compare = @import("../compare.zig");
const ai = @import("../ai.zig");
const policy = @import("policy.zig");
const util = @import("util.zig");
const lv8 = @import("lv8.zig");

fn argValue(args: []const []const u8, name: []const u8) ?[]const u8 {
    for (args, 0..) |a, i| {
        if (std.mem.eql(u8, a, name) and i + 1 < args.len) return args[i + 1];
    }
    return null;
}

fn hasFlag(args: []const []const u8, name: []const u8) bool {
    for (args) |a| if (std.mem.eql(u8, a, name)) return true;
    return false;
}

fn argNumber(args: []const []const u8, name: []const u8, default: usize) usize {
    const v = argValue(args, name) orelse return default;
    return std.fmt.parseInt(usize, v, 10) catch default;
}

/// `args` are the command-line arguments after `hoc-sim v08`.
pub fn run(gpa: std.mem.Allocator, args: []const []const u8) !void {
    if (args.len < 2) {
        std.debug.print("usage: hoc-sim v08 layers <recording.jsonl> [--top v0.2] [--passes] [--max-fail N]\n", .{});
        return error.Usage;
    }
    if (std.mem.eql(u8, args[0], "layers")) {
        const top = policy.levelFromName(argValue(args, "--top") orelse "v0.2") orelse return error.UnknownLevel;
        if (!try layers(gpa, args[1], top, hasFlag(args, "--passes"), argNumber(args, "--max-fail", 10))) std.process.exit(1);
        return;
    }
    std.debug.print("hoc-sim v08: unknown command {s}\n", .{args[0]});
    return error.Usage;
}

// =====================================================================================================================
// Layer check
// =====================================================================================================================

const Logged = struct { name: []const u8, out: []const rec.Action, rin: u32, rout: u32 };

const Mine = struct { name: []const u8, out: []const rec.Action, rin: u32, rout: u32 };

const Collector = struct {
    arena: std.mem.Allocator,
    items: std.ArrayList(Mine) = .empty,
    failed: bool = false,

    fn add(ctx: *anyopaque, name: []const u8, actions: []const rec.Action, rin: u32, rout: u32) void {
        const self: *Collector = @ptrCast(@alignCast(ctx));
        const copy = cloneActions(self.arena, actions) catch {
            self.failed = true;
            return;
        };
        self.items.append(self.arena, .{ .name = name, .out = copy, .rin = rin, .rout = rout }) catch {
            self.failed = true;
        };
    }
};

fn cloneActions(arena: std.mem.Allocator, actions: []const rec.Action) ![]rec.Action {
    const out = try arena.alloc(rec.Action, actions.len);
    for (actions, 0..) |a, i| {
        out[i] = a;
        switch (out[i]) {
            .move_unit => |*m| {
                m.path = try arena.dupe(rec.Cell, m.path);
                m.target_cells = try arena.dupe(rec.Cell, m.target_cells);
            },
            .melee_attack => |*m| m.path = try arena.dupe(rec.Cell, m.path),
            .obstacle_attack => |*o| o.path = try arena.dupe(rec.Cell, o.path),
            else => {},
        }
    }
    return out;
}

fn sameActions(a: []const rec.Action, b: []const rec.Action) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (!compare.actionsEqual(x, y)) return false;
    return true;
}

const Stat = struct { compared: usize = 0, matched: usize = 0 };

fn parseLayers(arena: std.mem.Allocator, ids: []const []const u8, raw: std.json.Value) ![]Logged {
    const items = raw.array.items;
    const out = try arena.alloc(Logged, items.len);
    var previous: []const rec.Action = &.{};
    for (items, 0..) |l, i| {
        const parts = l.array.items;
        var actions = previous;
        if (parts[1] != .null) {
            const raw_out = parts[1].array.items;
            const parsed = try arena.alloc(rec.Action, raw_out.len);
            for (raw_out, 0..) |o, j| parsed[j] = try rec.parseAction(arena, ids, "apply", o);
            actions = parsed;
        }
        out[i] = .{ .name = parts[0].string, .out = actions, .rin = @intCast(rec.int(parts[2])), .rout = @intCast(rec.int(parts[3])) };
        previous = actions;
    }
    return out;
}

fn printCells(cells: []const rec.Cell) void {
    std.debug.print("[", .{});
    for (cells) |c| std.debug.print("({d},{d})", .{ c.x, c.y });
    std.debug.print("]", .{});
}

fn printActions(label: []const u8, actions: []const rec.Action) void {
    std.debug.print("      {s}:", .{label});
    for (actions) |a| {
        switch (a) {
            .move_unit => |m| {
                std.debug.print(" move{s} ", .{if (m.has_lava) "(lava)" else ""});
                printCells(m.path);
                std.debug.print(" to ", .{});
                printCells(m.target_cells);
            },
            .melee_attack => |m| {
                std.debug.print(" melee #{d} from ({d},{d}){s} ", .{ m.target, m.attack_from.x, m.attack_from.y, if (m.has_lava) "(lava)" else "" });
                printCells(m.path);
            },
            .obstacle_attack => |o| {
                std.debug.print(" obstacle ({d},{d}) from ({d},{d}){s} ", .{ o.target_x, o.target_y, o.attack_from.x, o.attack_from.y, if (o.has_lava) "(lava)" else "" });
                printCells(o.path);
            },
            else => std.debug.print(" {any}", .{a}),
        }
    }
    std.debug.print("\n", .{});
}

fn dumpUnits(s: *const st.State, actor: u8) void {
    std.debug.print("      actor {d} prev_target {d}; replied {b}; made {b}\n", .{ actor, s.ai_prev_target[actor], s.fight.replied, s.fight.made });
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder) continue;
        const b = engine.baseCell(u);
        std.debug.print("      #{d} team {d} base ({d},{d}) {d}x{d} alive {d} dmax {d} resp {} target {d} hp {d} att_sel {d} type {d}\n", .{ i, u.team, b.x, b.y, u.fw, u.fh, u.amount_alive, u.attack_damage_max, u.responded, u.target, u.hp, u.attack_type_selected, u.attack_type });
    }
}

fn layers(gpa: std.mem.Allocator, path: []const u8, top: policy.Level, passes: bool, max_fail: usize) !bool {
    const buf = try std.fs.cwd().readFileAlloc(gpa, path, 1 << 34);
    defer gpa.free(buf);
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    var decision_arena = std.heap.ArenaAllocator.init(gpa);
    defer decision_arena.deinit();

    var stats = std.StringArrayHashMap(Stat).init(gpa);
    defer stats.deinit();
    var games: usize = 0;
    var unparsed: usize = 0;
    var engine_stops: usize = 0;
    var decisions: usize = 0;
    var decisions_ok: usize = 0;
    var fails: usize = 0;

    var lines = rec.lines(buf);
    while (lines.next()) |line| {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();
        const game = rec.parseGame(arena, line, true) catch |err| {
            unparsed += 1;
            std.debug.print("game {d}: recording not parsed ({s})\n", .{ games + unparsed, @errorName(err) });
            continue;
        };
        const root = try std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{});
        const raw_steps = rec.get(root, "steps").array.items;
        games += 1;
        util.battle = util.Battle.fromInit(game.init);
        var s = engine.initState(game.init, game.ids) catch |err| {
            std.debug.print("seed {d}: start state not supported ({s})\n", .{ game.seed, @errorName(err) });
            continue;
        };
        util.battle.primeProfile(&s);
        var events: engine.Events = .{};
        for (game.steps, 0..) |step, i| {
            if (step.action == .decide) {
                const raw = raw_steps[i];
                const logged_raw = rec.get(raw, "layers");
                if (logged_raw == .array) {
                    _ = decision_arena.reset(.retain_capacity);
                    const da = decision_arena.allocator();
                    const logged = try parseLayers(da, game.ids, logged_raw);
                    // The AI target memory the decision started from.
                    s.ai_prev_target = .{-1} ** st.MAX_UNITS;
                    for (rec.get(raw, "memory").array.items) |pair| {
                        const a = rec.unitIndex(game.ids, pair.array.items[0].string) catch continue;
                        const t = rec.unitIndex(game.ids, pair.array.items[1].string) catch continue;
                        s.ai_prev_target[a] = @intCast(t);
                    }
                    var copy = s;
                    copy.rng.state = step.r0;
                    var collector = Collector{ .arena = da };
                    policy.hook = .{ .ctx = &collector, .f = Collector.add };
                    var out: ai.Decision = .{};
                    policy.decideTo(&copy, step.action.decide.unit, &out, top);
                    policy.hook = null;
                    decisions += 1;
                    var all_ok = true;
                    for (logged, 0..) |l, li| {
                        // The k-th logged layer of this name against the k-th Zig layer of the same name.
                        var k: usize = 0;
                        for (logged[0..li]) |p| if (std.mem.eql(u8, p.name, l.name)) {
                            k += 1;
                        };
                        var mine: ?Mine = null;
                        var seen: usize = 0;
                        for (collector.items.items) |m| {
                            if (!std.mem.eql(u8, m.name, l.name)) continue;
                            if (seen == k) {
                                mine = m;
                                break;
                            }
                            seen += 1;
                        }
                        const m = mine orelse continue; // not ported (above --top) or not reached by the Zig chain
                        const gop = try stats.getOrPut(l.name);
                        if (!gop.found_existing) {
                            gop.key_ptr.* = try gpa.dupe(u8, l.name); // the recording arena is reset per game
                            gop.value_ptr.* = .{};
                        }
                        gop.value_ptr.compared += 1;
                        const ok = sameActions(m.out, l.out) and m.rin == l.rin and m.rout == l.rout;
                        if (ok) {
                            gop.value_ptr.matched += 1;
                            continue;
                        }
                        all_ok = false;
                        fails += 1;
                        if (fails <= max_fail) {
                            std.debug.print("seed {d} step {d} unit {d} layer {s}: differs (rng in {d}/{d} out {d}/{d})\n", .{ game.seed, i, step.action.decide.unit, l.name, m.rin, l.rin, m.rout, l.rout });
                            printActions("ts ", l.out);
                            printActions("zig", m.out);
                            if (std.posix.getenv("V08_DEBUG") != null) dumpUnits(&s, step.action.decide.unit);
                        }
                        break; // later layers build on this one
                    }
                    if (passes) {
                        // Each ported v0.8 pass on the logged output of the layer before it.
                        for (logged, 0..) |l, li| {
                            if (li == 0) continue;
                            const pass = lv8.passFromName(l.name) orelse continue;
                            var input: ai.Decision = .{};
                            if (!lv8.fromActions(&input, logged[li - 1].out)) continue;
                            var pcopy = s;
                            pcopy.rng.state = l.rin;
                            var pc: ai.Ctx = undefined;
                            ai.initCtxInto(&pc, &pcopy, step.action.decide.unit);
                            var pout: ai.Decision = .{};
                            if (!lv8.runPass(&pc, pass, &input, &pout)) continue;
                            const key = try std.fmt.allocPrint(da, "pass {s}", .{l.name});
                            const gop = try stats.getOrPut(key);
                            if (!gop.found_existing) {
                                gop.key_ptr.* = try gpa.dupe(u8, key);
                                gop.value_ptr.* = .{};
                            }
                            gop.value_ptr.compared += 1;
                            if (sameActions(pout.slice(), l.out) and pcopy.rng.state == l.rout) {
                                gop.value_ptr.matched += 1;
                                continue;
                            }
                            all_ok = false;
                            fails += 1;
                            if (fails <= max_fail) {
                                std.debug.print("seed {d} step {d} unit {d} pass {s}: differs (rng out {d}/{d})\n", .{ game.seed, i, step.action.decide.unit, l.name, pcopy.rng.state, l.rout });
                                printActions("in ", logged[li - 1].out);
                                printActions("ts ", l.out);
                                printActions("zig", pout.slice());
                            }
                        }
                    }
                    if (all_ok) decisions_ok += 1;
                }
                s.rng.state = step.r1;
                continue;
            }
            s.rng.state = step.r0;
            events.len = 0;
            const ok = engine.apply(&s, step.action, &events);
            var m: compare.Mismatch = .{};
            const diverged = ok != step.ok or s.rng.state != step.r1 or !compare.eventsMatch(events.slice(), step.events) or
                !compare.state(&s, game.ids, step.digest.?, &m);
            if (diverged) {
                engine_stops += 1;
                break; // the engine left the recording: later decisions see a different board
            }
        }
    }
    std.debug.print("layers: {d} games ({d} stopped early at an engine divergence, {d} not parsed), {d}/{d} decisions with every compared layer identical\n", .{ games, engine_stops, unparsed, decisions_ok, decisions });
    var it = stats.iterator();
    while (it.next()) |e| {
        std.debug.print("  {s}: {d}/{d}\n", .{ e.key_ptr.*, e.value_ptr.matched, e.value_ptr.compared });
        gpa.free(e.key_ptr.*);
    }
    return decisions_ok == decisions;
}

test {
    // Add `_ = @import("<file>.zig");` lines here to include v0.8 tests in `zig build test`.
}
