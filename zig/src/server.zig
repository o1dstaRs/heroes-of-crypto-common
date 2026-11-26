//! The server's engine path for rollouts (`engine: "server"`, State.engine_mode). Production bot seats roll out on
//! play_session.ts createBotSearchDeps, whose action engine context answers getCurrentActiveKnownPaths
//! (currentActiveKnownPaths) before every move and every approach: a full stat refresh, the aggression boards rebuilt
//! from the grid registrations, then getMovePath for the active unit. Moves and approaches then take the server's route
//! (resolveKnownMoveRoute / resolveKnownPaths in action_engine.ts), and the server's DamageStatisticHolder marks a lap
//! only for a statistic with damage > 0 (engine.markDamageLap). runMatch has no provider; with engine_mode `match`
//! nothing here runs.

const std = @import("std");
const st = @import("state.zig");
const engine = @import("engine.zig");
const pathing = @import("path.zig");
const artifacts = @import("artifacts.zig");

const State = st.State;
const Cell = st.Cell;

/// Server-only paths no oracle cohort has shown deciding a value (step-level negative tests: a broken build that still
/// matches every traced step and bank), flagged in State.server_unverified only where they decide something runMatch's
/// path would not. A rollout that reaches one is refused (rollout.Error.UnsupportedServer*), so its bank stays in
/// TypeScript instead of serving an unverified value:
/// - UNVERIFIED_ROUTE: a move's server route that changes what the walk reads off it (its legality, length, travelled
///   count, the lava flag, or any cell on a board with burning cells), a path-bearing strike's route that changes what
///   the approach reads (its length, travelled count, last cell, a ground crossing of "B", the lava flag), a strike the
///   refreshed map cannot reach refused for want of that route, and a path-less approach the full map accepts;
/// - UNVERIFIED_ZERO_LAP: a lap left unmarked by a 0-damage statistic (runMatch's holder marks it) that adds a
///   narrowing lap;
/// - UNVERIFIED_OBSTACLE: an obstacle strike whose provider approach differs from runMatch's, or that the refreshed map
///   cannot reach, refused for want of that route.
/// The provider's refresh at moves and melee approaches and a stationary strike's one-cell charge decide values in the
/// cohorts, and Zig matches them there; at obstacle strikes the provider's calls and their refresh match the server's
/// call for call (kp_log against the oracle's provider log, the refresh changing stats there included). None of them is
/// flagged.
pub const UNVERIFIED_ROUTE: u8 = 1;
pub const UNVERIFIED_ZERO_LAP: u8 = 2;
pub const UNVERIFIED_OBSTACLE: u8 = 4;

/// The travelled part of a route (travelledMovePath: without its leading base cell).
pub fn travelledOf(r: []const Cell, base: Cell) []const Cell {
    return travelled(r, base);
}

/// routeMatchesActionPath: the same cells in order, or the same travelled cells (each without its leading base cell).
pub fn sameRoute(route: []const Cell, p: []const Cell, base: Cell) bool {
    if (cellsInOrder(route, p)) return true;
    return cellsInOrder(travelled(route, base), travelled(p, base));
}

fn travelled(r: []const Cell, base: Cell) []const Cell {
    return if (r.len > 0 and r[0].x == base.x and r[0].y == base.y) r[1..] else r;
}

fn cellsInOrder(a: []const Cell, b: []const Cell) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (x.x != y.x or x.y != y.y) return false;
    return true;
}

/// `hoc-sim rollout-trace`'s provider log (debugging, this thread; null everywhere else): each knownPaths call's map
/// size (-1 without a map), whether its stat refresh changed the trace's per-unit stats line ("h": morale, luck, steps,
/// base attack and their modifiers, the hourglass and reply flags) or the active unit's steps, and the route the action
/// takes from that map (a move's to its path's last cell, a strike's to its attack-from cell; none when the map holds
/// none), as the server oracle records its provider's calls, so the two call sequences can be compared step by step.
pub const KpEntry = struct {
    size: i32,
    stats: bool,
    steps: bool,
    /// -1: no route was looked up (no map), -2: the map holds none, else the route's length in `route`.
    route_len: i16 = -1,
    route: [96]Cell = undefined,
};
pub const KpLog = struct {
    n: usize = 0,
    items: [64]KpEntry = undefined,

    fn push(self: *KpLog, e: KpEntry) void {
        if (self.n < self.items.len) self.items[self.n] = e;
        self.n += 1;
    }
};
pub threadlocal var kp_log: ?*KpLog = null;

/// The route the action takes from the latest logged map (kp_log), or none.
fn logRoute(r: ?[]const Cell) void {
    const l = kp_log orelse return;
    if (l.n == 0 or l.n > l.items.len) return;
    const e = &l.items[l.n - 1];
    const cells = r orelse {
        e.route_len = -2;
        return;
    };
    const k = @min(cells.len, e.route.len);
    @memcpy(e.route[0..k], cells[0..k]);
    e.route_len = @intCast(k);
}

fn statsLine(s: *const State) u64 {
    var h = std.hash.Wyhash.init(0);
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        h.update(std.mem.asBytes(&[_]f64{ u.morale, u.luck, u.luck_mod, u.steps, u.steps_mod, u.base_attack, u.attack_mod }));
        h.update(&[_]u8{ @intFromBool(u.on_hourglass), @intFromBool(u.responded) });
    }
    return h.final();
}

/// What the provider answered: no live active unit in the holder (undefined: the caller trusts the action, as
/// runMatch does), an empty map (the active unit cannot move), or the active unit's known paths.
pub const Known = enum { none, empty, paths };

/// currentActiveKnownPaths (play_session.ts): `none` without an active unit in the holder; `empty` for one that cannot
/// move (canMove(): Paralysis, Whirlpool, the Web lock; no refresh); otherwise refreshAuthoritativeStats (the full
/// refreshStackPowerForAllUnits, which a second call does not leave idempotent), refreshAggrBoards, and getMovePath
/// from the active unit's base cell with its refreshed getSteps, the enemy team's rebuilt board, flight, footprint, the
/// fight's vines and fire walls, In Its Own World and canTraverseLava, written into `out`.
pub fn knownPaths(s: *State, out: *pathing.MovePath) Known {
    const log = kp_log;
    if (s.active < 0 or !s.units[@intCast(s.active)].in_holder) {
        if (log) |l| l.push(.{ .size = -1, .stats = false, .steps = false });
        return .none;
    }
    const ui: u8 = @intCast(s.active);
    const u = &s.units[ui];
    if (!u.canMove()) {
        if (log) |l| l.push(.{ .size = 0, .stats = false, .steps = false });
        return .empty;
    }
    const stats0 = if (log != null) statsLine(s) else 0;
    const steps0 = if (log != null) engine.getSteps(u) else 0;
    engine.refreshStackPowerForAllUnits(s);
    rebuildAggrBoards(s);
    defer if (log) |l| l.push(.{ .size = @intCast(out.size()), .stats = statsLine(s) != stats0, .steps = engine.getSteps(u) != steps0 });
    const m = pathing.buildMatrix(s);
    pathing.getMovePath(&m, .{
        .start = engine.baseCell(u),
        .max_steps = engine.getSteps(u),
        .aggr = &s.grid.aggr[engine.opposite(u.team)],
        .can_fly = engine.canFly(u),
        .w = u.fw,
        .h = u.fh,
        .vines = if (s.fight.n_vines != 0) &s.fight.vine_cells else null,
        .vine_stride = u.ability_mask & st.AbilityId.in_its_own_world.bit() != 0 and u.has(.in_its_own_world),
        .fire = if (s.fight.n_fire != 0) &s.fight.fire_cells else null,
        .made_of_fire = artifacts.canTraverseLava(s, u),
    }, out);
    if (out.overflow) s.overflow = true;
    return .paths;
}

/// refreshAggrBoards -> Grid.rebuildAggrBoards (grid.ts): every board back to the baseline 1, then the ring of every
/// registered unit that is alive in the holder with a non-zero attack range, stamped +1 on its team's board (additive,
/// so the registration order is free).
pub fn rebuildAggrBoards(s: *State) void {
    for (0..3) |t| {
        for (0..st.GRID) |x| {
            for (0..st.GRID) |y| s.grid.aggr[t][x][y] = 1;
        }
    }
    for (s.units[0..s.n_units]) |*u| {
        if (u.n_reg == 0 or !u.in_holder or u.isDead() or !(u.attack_range != 0)) continue;
        engine.stampAggrRing(s, u.team, u.reg[0..u.n_reg], 1);
    }
}

/// A known route's cells (the start cell first, as IWeightedRoute.route holds them).
pub const RouteBuf = struct {
    cells: [96]Cell = undefined,
    len: u8 = 0,

    fn slice(self: *const RouteBuf) []const Cell {
        return self.cells[0..self.len];
    }
};

/// cellKey: (x << 4) | y.
inline fn key(c: Cell) u8 {
    return @intCast((c.x << 4) | c.y);
}

/// The route the pather stored for `c` (knownPaths.get(key)[0]: a cell holds one route in scope, so a route matching
/// the action's path and canonicalRoute are both it), copied into `buf`; null when the cell is unreachable.
fn routeTo(mp: *const pathing.MovePath, c: Cell, buf: *RouteBuf) ?*const pathing.Route {
    if (c.x < 0 or c.y < 0 or c.x >= st.GRID or c.y >= st.GRID) return null;
    const r = mp.get(key(c)) orelse return null;
    var len: usize = 0;
    var cur: ?*const pathing.Route = r;
    while (cur) |x| {
        len += 1;
        cur = if (x.parent < 0) null else &mp.routes[@intCast(x.parent)];
    }
    if (len > buf.cells.len) return null;
    buf.len = @intCast(mp.routeCells(r, buf.cells[0..len]));
    return r;
}

/// resolveKnownMoveRoute for a path move (not footprint-only): `runmatch` when the provider has no map (the action's
/// path is trusted), `rejected` (invalid_move) for an empty map or an unreachable destination, else the server's route
/// to the path's last cell and its hasLavaCell.
pub const MoveRoute = union(enum) {
    runmatch,
    rejected,
    route: struct { cells: []const Cell, has_lava: bool },
};

pub fn moveRoute(s: *State, p: []const Cell, buf: *RouteBuf) MoveRoute {
    var mp: pathing.MovePath = undefined;
    switch (knownPaths(s, &mp)) {
        .none => return .runmatch,
        .empty => {
            logRoute(null);
            return .rejected;
        },
        .paths => {
            const r = routeTo(&mp, p[p.len - 1], buf) orelse {
                logRoute(null);
                return .rejected;
            };
            logRoute(buf.slice());
            return .{ .route = .{ .cells = buf.slice(), .has_lava = r.has_lava } };
        },
    }
}

/// resolveKnownPaths (action_engine.ts) for a strike from `from`: whether a known-paths map exists (TypeScript: the map
/// is defined), the route it holds for `from` (map.get(cellKey(from))?.[0]?.route) and that route's hasLavaCell.
/// handleMeleeAttack / handleObstacleAttack read it: an approach needs the route, applyMoveModifiers walks it, and
/// chargedRouteCells is the route's length, 1 for a defined map without one, nothing without a map.
pub const Approach = struct {
    defined: bool = false,
    route: ?[]const Cell = null,
    has_lava: bool = false,
    /// The server's refreshed map cannot reach a path-bearing strike's attack-from cell (runMatch walks the action's
    /// path): flagged (UNVERIFIED_ROUTE / UNVERIFIED_OBSTACLE) only where the missing route refuses the strike.
    unreached: bool = false,

    /// runMatch (no provider): a path-bearing action carries its own path as the route; a path-less one has no map.
    pub fn fromPath(p: []const Cell, has_lava: bool) Approach {
        return if (p.len == 0) .{} else .{ .defined = true, .route = p, .has_lava = has_lava };
    }
};

/// resolveKnownPaths on the server: the provider is asked first, for every strike (stationary ones too). A path-less
/// strike takes the whole map (none: no map; empty: a map with no route); a path-bearing one the route to `from` (the
/// matching or canonical route), or no map when `from` is unreachable; without a provider map, runMatch's.
pub fn approach(s: *State, from: Cell, p: []const Cell, has_lava: bool, buf: *RouteBuf) Approach {
    var mp: pathing.MovePath = undefined;
    switch (knownPaths(s, &mp)) {
        .none => return Approach.fromPath(p, has_lava),
        .empty => {
            logRoute(null);
            return if (p.len == 0) .{ .defined = true } else .{};
        },
        .paths => {
            const r = routeTo(&mp, from, buf);
            logRoute(if (r != null) buf.slice() else null);
            const base = engine.baseCell(&s.units[@intCast(s.active)]);
            if (p.len == 0) {
                // A path-less approach the full map accepts (runMatch refuses it): not seen by the oracle yet.
                if (r != null and !(from.x == base.x and from.y == base.y)) s.server_unverified |= UNVERIFIED_ROUTE;
                return .{ .defined = true, .route = if (r != null) buf.slice() else null, .has_lava = if (r) |x| x.has_lava else false };
            }
            const found = r orelse return .{ .unreached = true };
            return .{ .defined = true, .route = buf.slice(), .has_lava = found.has_lava };
        },
    }
}
