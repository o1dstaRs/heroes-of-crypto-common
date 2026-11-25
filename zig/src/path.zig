//! PathHelper.getMovePath as the v0.1 AI uses it (src/grid/path_helper.ts, indexed fast path), in scope: NORMAL
//! grid with holes, no lava/water/vines/fire walls, footprints 1x1, 2x1 and 2x2.
//!
//! The search is a first-come FIFO walk, not Dijkstra: a cell keeps the route of the first dequeued parent that can
//! afford it. Neighbour order (L, U, D, R, LD, LU, RD, RU) and queue order therefore decide every route and weight.

const std = @import("std");
const st = @import("state.zig");

const Cell = st.Cell;
pub const DIAGONAL_MOVE_COST: f64 = 1.4142135623730951;

/// `grid.getMatrix()` viewed as m[x][y]: 0 empty, the occupant's team (1 or 2), -2 hole.
pub const Matrix = [st.GRID][st.GRID]i8;

pub fn buildMatrix(s: *const st.State) Matrix {
    var m: Matrix = undefined;
    for (0..st.GRID) |x| {
        for (0..st.GRID) |y| {
            const o = s.grid.board[x][y];
            m[x][y] = if (o == st.EMPTY) 0 else if (o == st.HOLE) -2 else @intCast(s.units[o - 1].team);
        }
    }
    return m;
}

/// matrixElementOrDefault(matrix, x, y, 0)
pub inline fn at(m: *const Matrix, x: i32, y: i32) i8 {
    if (x < 0 or x >= st.GRID or y < 0 or y >= st.GRID) return 0;
    return m[@intCast(x)][@intCast(y)];
}

pub inline fn key(x: i32, y: i32) u8 {
    return @intCast((x << 4) | y);
}

/// One IWeightedRoute. Routes share prefixes, so each stores its parent; `parent == -1` is the start.
pub const Route = struct {
    cell: Cell,
    parent: i16,
    weight: f64,
    remaining: f64,
    first_aggr_met: bool,
};

pub const MAX_ROUTES = 260;

pub const MovePath = struct {
    /// routes[0] is the start (the queue seed); routes[1..] are the knownPaths values in insertion order.
    routes: [MAX_ROUTES]Route = undefined,
    n: u16 = 0,
    /// knownPaths key -> index into routes, or -1.
    by_key: [256]i16 = .{-1} ** 256,

    pub fn get(self: *const MovePath, k: u8) ?*const Route {
        const i = self.by_key[k];
        return if (i < 0) null else &self.routes[@intCast(i)];
    }

    /// knownPaths in insertion order.
    pub fn known(self: *const MovePath) []const Route {
        return self.routes[1..self.n];
    }

    pub fn size(self: *const MovePath) usize {
        return self.n - 1;
    }

    /// The route's cells from the start to `r.cell`, written into `out`; returns its length.
    pub fn routeCells(self: *const MovePath, r: *const Route, out: []Cell) usize {
        var len: usize = 0;
        var cur: ?*const Route = r;
        while (cur) |c| {
            len += 1;
            cur = if (c.parent < 0) null else &self.routes[@intCast(c.parent)];
        }
        var i = len;
        cur = r;
        while (cur) |c| {
            i -= 1;
            out[i] = c.cell;
            cur = if (c.parent < 0) null else &self.routes[@intCast(c.parent)];
        }
        return len;
    }

    fn append(self: *MovePath, r: Route) u16 {
        const i = self.n;
        self.routes[i] = r;
        self.n += 1;
        return i;
    }

    /// knownPaths.set: overwrite in place when the key exists (Map keeps its position), else append.
    fn set(self: *MovePath, k: u8, r: Route) void {
        if (self.by_key[k] >= 0) {
            self.routes[@intCast(self.by_key[k])] = r;
        } else {
            self.by_key[k] = @intCast(self.append(r));
        }
    }
};

const Bits = struct {
    w: [4]u64 = .{ 0, 0, 0, 0 },

    inline fn has(self: *const Bits, k: u8) bool {
        return self.w[k >> 6] & (@as(u64, 1) << @intCast(k & 63)) != 0;
    }
    inline fn put(self: *Bits, k: u8) void {
        self.w[k >> 6] |= @as(u64, 1) << @intCast(k & 63);
    }
};

pub const Params = struct {
    start: Cell,
    max_steps: f64,
    /// grid.getAggrMatrixByTeam(enemy team), [x][y]
    aggr: *const [st.GRID][st.GRID]i16,
    can_fly: bool,
    w: u8,
    h: u8,
};

/// getMovePath -> calculateMovePath (indexed branch) -> filterUnallowedDestinations (identity here).
pub fn getMovePath(m: *const Matrix, p: Params, out: *MovePath) void {
    out.* = .{};
    const w: i32 = p.w;
    const h: i32 = p.h;
    const small = w == 1 and h == 1;
    const legacy = w == 2 and h == 2;
    const start = p.start;
    std.debug.assert(start.x >= w - 1 and start.x < st.GRID and start.y >= h - 1 and start.y < st.GRID);

    // Footprint offsets (dx outer, dy inner) and the unit's own cells.
    var off_x: [4]i32 = undefined;
    var off_y: [4]i32 = undefined;
    var n_off: usize = 0;
    {
        var dx: i32 = 0;
        while (dx < w) : (dx += 1) {
            var dy: i32 = 0;
            while (dy < h) : (dy += 1) {
                off_x[n_off] = dx;
                off_y[n_off] = dy;
                n_off += 1;
            }
        }
    }
    var initial: Bits = .{};
    for (0..n_off) |i| {
        const cx = start.x - off_x[i];
        const cy = start.y - off_y[i];
        if (cx >= 0 and cy >= 0) initial.put(key(cx, cy));
    }

    var visited: Bits = .{};
    var allowed: Bits = .{};
    visited.put(key(start.x, start.y));
    _ = out.append(.{ .cell = start, .parent = -1, .weight = 0, .remaining = p.max_steps, .first_aggr_met = false });

    const Ctx = struct {
        m: *const Matrix,
        p: Params,
        w: i32,
        h: i32,
        small: bool,
        legacy: bool,
        off_x: *const [4]i32,
        off_y: *const [4]i32,
        n_off: usize,

        inline fn covers(self: @This(), anchor: Cell, x: i32, y: i32) bool {
            return x <= anchor.x and x > anchor.x - self.w and y <= anchor.y and y > anchor.y - self.h;
        }

        fn shears(self: @This(), from: Cell, to: Cell) bool {
            const sx = to.x - from.x;
            const sy = to.y - from.y;
            for (0..2) |route| {
                const vx = if (route == 0) from.x + sx else from.x;
                const vy = if (route == 0) from.y else from.y + sy;
                for (0..self.n_off) |i| {
                    const cx = vx - self.off_x[i];
                    const cy = vy - self.off_y[i];
                    if (self.covers(from, cx, cy) or self.covers(to, cx, cy)) continue;
                    if (at(self.m, cx, cy) != 0) return true;
                }
            }
            return false;
        }

        /// aggr(): the enemy-threat multiplier; flips the parent's firstAggrMet on the first threatened cell.
        fn aggr(self: @This(), n: Cell, parent: *Route) f64 {
            const board = self.p.aggr;
            var sum: f64 = 0;
            var count: f64 = undefined;
            sum += one(board[@intCast(n.x)][@intCast(n.y)]);
            if (self.small) {
                count = 1;
            } else if (self.legacy) {
                sum += one(board[@intCast(n.x - 1)][@intCast(n.y)]);
                sum += one(board[@intCast(n.x - 1)][@intCast(n.y - 1)]);
                sum += one(board[@intCast(n.x)][@intCast(n.y - 1)]);
                count = 4;
            } else {
                for (1..self.n_off) |i| sum += one(board[@intCast(n.x - self.off_x[i])][@intCast(n.y - self.off_y[i])]);
                count = @floatFromInt(self.n_off);
            }
            const value = sum / count;
            if (value > 1 and !parent.first_aggr_met) {
                parent.first_aggr_met = true;
                return 1;
            }
            return value;
        }

        inline fn one(v: i16) f64 {
            return if (v == 0) 1 else @floatFromInt(v);
        }

        fn blocked(self: @This(), n: Cell, initial_cells: *const Bits) bool {
            if (self.small) {
                return at(self.m, n.x, n.y) != 0 and !initial_cells.has(key(n.x, n.y));
            }
            if (self.legacy) {
                const cells = [4][2]i32{ .{ n.x, n.y }, .{ n.x - 1, n.y }, .{ n.x - 1, n.y - 1 }, .{ n.x, n.y - 1 } };
                for (cells) |c| {
                    if (at(self.m, c[0], c[1]) != 0 and !initial_cells.has(key(c[0], c[1]))) return true;
                }
                return false;
            }
            for (0..self.n_off) |i| {
                const fx = n.x - self.off_x[i];
                const fy = n.y - self.off_y[i];
                if (at(self.m, fx, fy) != 0 and !initial_cells.has(key(fx, fy))) return true;
            }
            return false;
        }

        /// The diagonal "sneak" rule for walkers. Returns true when the diagonal is refused.
        fn sneaks(self: @This(), cur: Cell, n: Cell) bool {
            const mm = self.m;
            const xa = cur.x - 1;
            const ya = cur.y - 1;
            const xb = cur.x + 1;
            const yb = cur.y + 1;
            if (!self.small and !self.legacy) return self.shears(cur, n);
            if (xa == n.x and ya == n.y) {
                return if (self.small) at(mm, xa, cur.y) != 0 and at(mm, cur.x, ya) != 0 else at(mm, cur.x - 2, cur.y) != 0 or at(mm, cur.x, cur.y - 2) != 0;
            } else if (xb == n.x and yb == n.y) {
                return if (self.small) at(mm, xb, cur.y) != 0 and at(mm, cur.x, yb) != 0 else at(mm, xa, yb) != 0 or at(mm, xb, ya) != 0;
            } else if (xa == n.x and yb == n.y) {
                return if (self.small) at(mm, xa, cur.y) != 0 and at(mm, cur.x, yb) != 0 else at(mm, cur.x - 2, ya) != 0 or at(mm, cur.x, yb) != 0;
            } else if (xb == n.x and ya == n.y) {
                return if (self.small) at(mm, xb, cur.y) != 0 and at(mm, cur.x, ya) != 0 else at(mm, xa, cur.y - 2) != 0 or at(mm, cur.x + 1, cur.y) != 0;
            }
            return false;
        }
    };
    const ctx = Ctx{ .m = m, .p = p, .w = w, .h = h, .small = small, .legacy = legacy, .off_x = &off_x, .off_y = &off_y, .n_off = n_off };

    var qi: u16 = 0;
    while (qi < out.n) {
        const cur_index = qi;
        qi += 1;
        const cur = out.routes[cur_index].cell;
        var nbrs: [8]Cell = undefined;
        var nn: usize = 0;
        const left = cur.x > w - 1;
        const right = cur.x < st.GRID - 1;
        const down = cur.y > h - 1;
        const up = cur.y < st.GRID - 1;
        const cand = [8]struct { bool, i32, i32 }{
            .{ left, -1, 0 },           .{ up, 0, 1 },           .{ down, 0, -1 },           .{ right, 1, 0 },
            .{ left and down, -1, -1 }, .{ left and up, -1, 1 }, .{ right and down, 1, -1 }, .{ right and up, 1, 1 },
        };
        for (cand) |c| {
            if (!c[0]) continue;
            const nx = cur.x + c[1];
            const ny = cur.y + c[2];
            if (!visited.has(key(nx, ny))) {
                nbrs[nn] = .{ .x = nx, .y = ny };
                nn += 1;
            }
        }
        for (nbrs[0..nn]) |n| {
            const kn = key(n.x, n.y);
            if (ctx.blocked(n, &initial)) {
                visited.put(kn);
                continue;
            }
            const diag = cur.x != n.x and cur.y != n.y;
            const parent = &out.routes[cur_index];
            const remaining = parent.remaining;
            var cost: f64 = undefined;
            if (diag) {
                cost = if (p.can_fly) DIAGONAL_MOVE_COST else DIAGONAL_MOVE_COST * ctx.aggr(n, parent);
                if (!(remaining >= cost)) continue;
                if (!p.can_fly and ctx.sneaks(cur, n)) continue;
            } else {
                cost = if (p.can_fly) 1 else ctx.aggr(n, parent);
                if (!(remaining >= cost)) continue;
            }
            const child = Route{
                .cell = n,
                .parent = @intCast(cur_index),
                .weight = parent.weight + cost,
                .remaining = remaining - cost,
                .first_aggr_met = parent.first_aggr_met,
            };
            const ci = out.append(child);
            out.by_key[kn] = @intCast(ci);
            // allowed marking (the anchor, then the rest of the body)
            allowed.put(kn);
            if (legacy) {
                allowed.put(key(n.x - 1, n.y));
                allowed.put(key(n.x - 1, n.y - 1));
                allowed.put(key(n.x, n.y - 1));
            } else if (!small) {
                for (1..n_off) |i| allowed.put(key(n.x - off_x[i], n.y - off_y[i]));
            }
            visited.put(kn);
        }
    }

    // Closest-move pass: every free straight-adjacent anchor gets weight 1 and route [start, c].
    const cm = [4]struct { bool, i32, i32 }{
        .{ start.x > w - 1, -1, 0 },
        .{ start.y < st.GRID - 1, 0, 1 },
        .{ start.y > h - 1, 0, -1 },
        .{ start.x < st.GRID - 1, 1, 0 },
    };
    for (cm) |c| {
        if (!c[0]) continue;
        const cell = Cell{ .x = start.x + c[1], .y = start.y + c[2] };
        const k = key(cell.x, cell.y);
        const entry = Route{ .cell = cell, .parent = 0, .weight = 1, .remaining = 0, .first_aggr_met = false };
        if (small) {
            if (at(m, cell.x, cell.y) != 0 or allowed.has(k)) continue;
            allowed.put(k);
            out.set(k, entry);
        } else if (!legacy) {
            var edge_blocked = false;
            for (0..n_off) |i| {
                const cx = cell.x - off_x[i];
                const cy = cell.y - off_y[i];
                if (ctx.covers(start, cx, cy)) continue;
                if (allowed.has(key(cx, cy)) or at(m, cx, cy) != 0) {
                    edge_blocked = true;
                    break;
                }
            }
            if (!edge_blocked) {
                for (0..n_off) |i| {
                    const cx = cell.x - off_x[i];
                    const cy = cell.y - off_y[i];
                    if (ctx.covers(start, cx, cy)) continue;
                    allowed.put(key(cx, cy));
                }
                out.set(k, entry);
            }
        } else {
            // 2x2: the two leading-edge cells for each direction.
            var e: [2][2]i32 = undefined;
            if (cell.x < start.x) {
                e = .{ .{ cell.x - 1, cell.y }, .{ cell.x - 1, cell.y - 1 } };
            } else if (cell.x > start.x) {
                e = .{ .{ cell.x, cell.y }, .{ cell.x, cell.y - 1 } };
            } else if (cell.y < start.y) {
                e = .{ .{ cell.x, cell.y - 1 }, .{ cell.x - 1, cell.y - 1 } };
            } else {
                e = .{ .{ cell.x, cell.y }, .{ cell.x - 1, cell.y } };
            }
            const k1 = key(e[0][0], e[0][1]);
            const k2 = key(e[1][0], e[1][1]);
            if (!allowed.has(k1) and at(m, e[0][0], e[0][1]) == 0 and !allowed.has(k2) and at(m, e[1][0], e[1][1]) == 0) {
                allowed.put(k1);
                allowed.put(k2);
                out.set(k, entry);
            }
        }
    }
}
