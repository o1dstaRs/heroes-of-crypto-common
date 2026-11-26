//! PathHelper.getMovePath as the v0.1 AI uses it (src/grid/path_helper.ts, indexed fast path), in scope: holes,
//! mountains and stones (-1), lava (-3), vines and fire walls (a walker's toll per burning cell its body sweeps into),
//! no water and nothing made of fire, footprints 1x1, 2x1
//! and 2x2. The terrain predicates are read literally: a walker is stopped by any non-zero cell, a flyer by any
//! non-zero cell except lava and water, and a flyer route over lava carries hasLavaCell.
//!
//! The search is a first-come FIFO walk, not Dijkstra: a cell keeps the route of the first dequeued parent that can
//! afford it. Neighbour order (L, U, D, R, LD, LU, RD, RU) and queue order therefore decide every route and weight.
//!
//! Vines (Vine Throw): entering a vined anchor cell costs a walker one step more (VINE_CROSS_PENALTY, after the threat
//! multiplier), whoever laid it; a vine strider (In Its Own World) pays nothing extra in the first pass, then a second,
//! relaxing pass walks vined cells for free (a cell is walked again whenever a route leaves strictly more steps), and
//! its vined destinations replace or follow the first pass's (getMovePath's merge). The merged result keeps the routes
//! the replaced entries were ancestors of: those ancestors live past `n` in `routes` (outside `known()`).

const std = @import("std");
const st = @import("state.zig");

const Cell = st.Cell;
pub const DIAGONAL_MOVE_COST: f64 = 1.4142135623730951;

/// `grid.getMatrix()` viewed as m[x][y]: 0 empty, the occupant's team (1 or 2), -1 mountain or stone, -2 hole,
/// -3 lava (ObstacleType).
pub const Matrix = [st.GRID][st.GRID]i8;

pub const BLOCK: i8 = -1;
pub const HOLE: i8 = -2;
pub const LAVA: i8 = -3;
pub const WATER: i8 = -4;

/// Grid.getOccupantNumeric: a unit's team wins over terrain (a Lava Striders unit may stand on lava). An empty cell of
/// the undried lava square reads lava: the matrix takes the centre obstacle from the map, not from boardCoord, so a
/// death on lava (which leaves "" in boardCoord) still shows lava here.
pub fn buildMatrix(s: *const st.State) Matrix {
    var m: Matrix = undefined;
    const lava_live = s.fight.grid_type == st.GridType.LAVA_CENTER and !s.grid.terrain.cleaned_up_center;
    for (0..st.GRID) |x| {
        for (0..st.GRID) |y| {
            const o = s.grid.board[x][y];
            m[x][y] = switch (o) {
                st.EMPTY => if (lava_live and x >= 6 and x < 10 and y >= 6 and y < 10) LAVA else 0,
                st.HOLE => HOLE,
                st.BLOCK => BLOCK,
                st.LAVA => LAVA,
                else => @intCast(s.units[o - 1].team),
            };
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
    /// hasLavaCell: the route (a flyer's) touched lava. hasWaterCell is always false (no water in scope).
    has_lava: bool = false,
};

/// The start, 256 knownPaths values and, after a vine strider's merge, the ancestors of the routes it kept.
pub const MAX_ROUTES = 640;

pub const MovePath = struct {
    /// routes[0] is the start (the queue seed); routes[1..n] are the knownPaths values in insertion order; a vine
    /// merge stores ancestors that are no longer values from `n` on.
    routes: [MAX_ROUTES]Route = undefined,
    n: u16 = 0,
    /// knownPaths key -> index into routes, or -1.
    by_key: [256]i16 = .{-1} ** 256,
    /// A capacity of the vine merge was exceeded (routes, the second pass's queue, a route longer than 64 cells): the
    /// result does not follow TypeScript (the AI context flags the state).
    overflow: bool = false,

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
    /// FightProperties.vines as a cell bitmap (bit y of vines[x]); null when the board has none.
    vines: ?*const [st.GRID]u16 = null,
    /// hasAbilityActive("In Its Own World"): the vine strider's free second pass.
    vine_stride: bool = false,
    /// FightProperties.fireWalls as a cell bitmap (bit y of fire[x]); null when the board has none.
    fire: ?*const [st.GRID]u16 = null,
    /// isMadeOfFire = unit.canTraverseLava() (a Lava Striders army, artifacts.zig): a walker's body may stand on lava,
    /// a walker route that touches lava carries hasLavaCell, and the closest-move pass takes lava cells.
    made_of_fire: bool = false,
};

/// VINE_CROSS_PENALTY (src/spells/vines.ts)
pub const VINE_CROSS_PENALTY: f64 = 1;
/// PATH_BUDGET_EPSILON (the strider's relaxation tolerance)
pub const PATH_BUDGET_EPSILON: f64 = 1e-9;

inline fn vined(v: *const [st.GRID]u16, x: i32, y: i32) bool {
    return v[@intCast(x)] & (@as(u16, 1) << @intCast(y)) != 0;
}

/// FIRE_WALL_CROSS_PENALTY (src/spells/fire_walls.ts)
pub const FIRE_WALL_CROSS_PENALTY: f64 = 1;

/// terrainAdjustedCost's Fire Wall term for a walker's step from anchor `a` to the neighbour `b`: the toll per burning
/// cell of getSweptFootprintCells(a, b) (the cells the body newly touches, the start footprint excluded; a diagonal
/// step touches both side footprints, then the destination's).
fn fireToll(fire: *const [st.GRID]u16, a: Cell, b: Cell, w: u8, h: u8) f64 {
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    var anchors: [3]Cell = undefined;
    var na: usize = 0;
    if (sx != 0 and sy != 0) {
        anchors[0] = .{ .x = a.x + sx, .y = a.y };
        anchors[1] = .{ .x = a.x, .y = a.y + sy };
        na = 2;
    }
    anchors[na] = b;
    na += 1;
    var seen: [12]Cell = undefined;
    var ns: usize = 0;
    var burning: f64 = 0;
    for (anchors[0..na]) |anc| {
        var dx: i32 = 0;
        while (dx < w) : (dx += 1) {
            var dy: i32 = 0;
            while (dy < h) : (dy += 1) {
                const c = Cell{ .x = anc.x - dx, .y = anc.y - dy };
                // the start footprint: a's own cells
                if (c.x <= a.x and c.x > a.x - @as(i32, w) and c.y <= a.y and c.y > a.y - @as(i32, h)) continue;
                var dup = false;
                for (seen[0..ns]) |x| {
                    if (x.x == c.x and x.y == c.y) dup = true;
                }
                if (dup) continue;
                if (ns < seen.len) {
                    seen[ns] = c;
                    ns += 1;
                }
                if (c.x >= 0 and c.y >= 0 and c.x < st.GRID and c.y < st.GRID and vined(fire, c.x, c.y)) burning += 1;
            }
        }
    }
    return burning * FIRE_WALL_CROSS_PENALTY;
}

/// getMovePath -> calculateMovePath (indexed branch) -> filterUnallowedDestinations (it filters only `cells`, which
/// nothing here reads: knownPaths keeps a flyer's lava destinations); with a vine strider and vines, the second pass and
/// the merge of its vined destinations.
pub fn getMovePath(m: *const Matrix, p: Params, out: *MovePath) void {
    if (p.vines) |v| {
        if (p.can_fly) search(true, .first, m, p, out) else search(false, .first, m, p, out);
        if (p.vine_stride) mergeStride(m, p, v, out);
        return;
    }
    if (p.can_fly) search(true, .none, m, p, out) else search(false, .none, m, p, out);
}

/// The body test of calculateMovePath for one footprint cell value: a walker is stopped by anything non-zero, a flyer
/// by anything it cannot fly over (lava and water it can).
inline fn blocksBody(comptime fly: bool, el: i8, made_of_fire: bool) bool {
    return if (fly) el != 0 and el != LAVA and el != WATER else el != 0 and !(made_of_fire and el == LAVA);
}

/// The closest-move pass's free test for one cell: empty, or lava for a unit made of fire.
inline fn freeForClosest(el: i8, made_of_fire: bool) bool {
    return el == 0 or (made_of_fire and el == LAVA);
}

/// Which walk calculateMovePath runs: no vines on the board, the first pass with vines (a walker's toll, none for a
/// flyer or a strider), or the strider's relaxing second pass.
const Pass = enum { none, first, stride };

fn Geometry(comptime fly: bool) type {
    return struct {
        m: *const Matrix,
        p: Params,
        w: i32,
        h: i32,
        small: bool,
        legacy: bool,
        off_x: [4]i32,
        off_y: [4]i32,
        n_off: usize,
        initial: Bits,

        const Self = @This();

        fn init(m: *const Matrix, p: Params) Self {
            var g: Self = .{ .m = m, .p = p, .w = p.w, .h = p.h, .small = p.w == 1 and p.h == 1, .legacy = p.w == 2 and p.h == 2, .off_x = undefined, .off_y = undefined, .n_off = 0, .initial = .{} };
            // Footprint offsets (dx outer, dy inner) and the unit's own cells.
            var dx: i32 = 0;
            while (dx < g.w) : (dx += 1) {
                var dy: i32 = 0;
                while (dy < g.h) : (dy += 1) {
                    g.off_x[g.n_off] = dx;
                    g.off_y[g.n_off] = dy;
                    g.n_off += 1;
                }
            }
            for (0..g.n_off) |i| {
                const cx = p.start.x - g.off_x[i];
                const cy = p.start.y - g.off_y[i];
                if (cx >= 0 and cy >= 0) g.initial.put(key(cx, cy));
            }
            return g;
        }

        inline fn covers(self: *const Self, anchor: Cell, x: i32, y: i32) bool {
            return x <= anchor.x and x > anchor.x - self.w and y <= anchor.y and y > anchor.y - self.h;
        }

        fn shears(self: *const Self, from: Cell, to: Cell) bool {
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
        fn aggr(self: *const Self, n: Cell, parent: *Route) f64 {
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

        /// The footprint test. `crosses` gets crossesLava: the anchor, all four 2x2 cells, or a rectangle's cells up to
        /// the first blocking one (only a flyer can stand its body over lava, so walkers skip it).
        fn blocked(self: *const Self, n: Cell, crosses: *bool) bool {
            const initial_cells = &self.initial;
            if (self.small) {
                const el = at(self.m, n.x, n.y);
                if (fly or self.p.made_of_fire) crosses.* = el == LAVA;
                return blocksBody(fly, el, self.p.made_of_fire) and !initial_cells.has(key(n.x, n.y));
            }
            if (self.legacy) {
                const cells = [4][2]i32{ .{ n.x, n.y }, .{ n.x - 1, n.y }, .{ n.x - 1, n.y - 1 }, .{ n.x, n.y - 1 } };
                if (fly or self.p.made_of_fire) {
                    for (cells) |c| {
                        if (at(self.m, c[0], c[1]) == LAVA) crosses.* = true;
                    }
                }
                for (cells) |c| {
                    if (blocksBody(fly, at(self.m, c[0], c[1]), self.p.made_of_fire) and !initial_cells.has(key(c[0], c[1]))) return true;
                }
                return false;
            }
            for (0..self.n_off) |i| {
                const fx = n.x - self.off_x[i];
                const fy = n.y - self.off_y[i];
                const el = at(self.m, fx, fy);
                if ((fly or self.p.made_of_fire) and el == LAVA) crosses.* = true;
                if (blocksBody(fly, el, self.p.made_of_fire) and !initial_cells.has(key(fx, fy))) return true;
            }
            return false;
        }

        /// The diagonal "sneak" rule for walkers. Returns true when the diagonal is refused.
        fn sneaks(self: *const Self, cur: Cell, n: Cell) bool {
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

        /// The neighbours of `cur` in calculateMovePath's order (L, U, D, R, LD, LU, RD, RU), on the anchor's board.
        fn neighbours(self: *const Self, cur: Cell, out: *[8]Cell) usize {
            var nn: usize = 0;
            const left = cur.x > self.w - 1;
            const right = cur.x < st.GRID - 1;
            const down = cur.y > self.h - 1;
            const up = cur.y < st.GRID - 1;
            const cand = [8]struct { bool, i32, i32 }{
                .{ left, -1, 0 },           .{ up, 0, 1 },           .{ down, 0, -1 },           .{ right, 1, 0 },
                .{ left and down, -1, -1 }, .{ left and up, -1, 1 }, .{ right and down, 1, -1 }, .{ right and up, 1, 1 },
            };
            for (cand) |c| {
                if (!c[0]) continue;
                out[nn] = .{ .x = cur.x + c[1], .y = cur.y + c[2] };
                nn += 1;
            }
            return nn;
        }

        /// The allowed marking of a captured destination (the anchor, then the rest of the body).
        fn markAllowed(self: *const Self, allowed: *Bits, n: Cell) void {
            allowed.put(key(n.x, n.y));
            if (self.legacy) {
                allowed.put(key(n.x - 1, n.y));
                allowed.put(key(n.x - 1, n.y - 1));
                allowed.put(key(n.x, n.y - 1));
            } else if (!self.small) {
                for (1..self.n_off) |i| allowed.put(key(n.x - self.off_x[i], n.y - self.off_y[i]));
            }
        }

        /// The closest-move pass: every free straight-adjacent anchor not yet allowed gets weight 1 and route [start, c]
        /// (`set` replaces in place or appends).
        fn closestMoves(self: *const Self, allowed: *Bits, ctx: anytype, set: anytype) void {
            const start = self.p.start;
            const m = self.m;
            const cm = [4]struct { bool, i32, i32 }{
                .{ start.x > self.w - 1, -1, 0 },
                .{ start.y < st.GRID - 1, 0, 1 },
                .{ start.y > self.h - 1, 0, -1 },
                .{ start.x < st.GRID - 1, 1, 0 },
            };
            for (cm) |c| {
                if (!c[0]) continue;
                const cell = Cell{ .x = start.x + c[1], .y = start.y + c[2] };
                const k = key(cell.x, cell.y);
                var entry = Route{ .cell = cell, .parent = 0, .weight = 1, .remaining = 0, .first_aggr_met = false };
                const mof = self.p.made_of_fire;
                if (self.small) {
                    const me1 = at(m, cell.x, cell.y);
                    if (!freeForClosest(me1, mof) or allowed.has(k)) continue;
                    allowed.put(k);
                    entry.has_lava = me1 == LAVA;
                    set(ctx, k, entry);
                } else if (!self.legacy) {
                    var edge_blocked = false;
                    for (0..self.n_off) |i| {
                        const cx = cell.x - self.off_x[i];
                        const cy = cell.y - self.off_y[i];
                        if (self.covers(start, cx, cy)) continue;
                        const el = at(m, cx, cy);
                        if (allowed.has(key(cx, cy)) or !freeForClosest(el, mof)) {
                            edge_blocked = true;
                            break;
                        }
                        if (el == LAVA) entry.has_lava = true;
                    }
                    if (!edge_blocked) {
                        for (0..self.n_off) |i| {
                            const cx = cell.x - self.off_x[i];
                            const cy = cell.y - self.off_y[i];
                            if (self.covers(start, cx, cy)) continue;
                            allowed.put(key(cx, cy));
                        }
                        set(ctx, k, entry);
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
                    const me1 = at(m, e[0][0], e[0][1]);
                    const me2 = at(m, e[1][0], e[1][1]);
                    if (!allowed.has(k1) and freeForClosest(me1, mof) and !allowed.has(k2) and freeForClosest(me2, mof)) {
                        allowed.put(k1);
                        allowed.put(k2);
                        entry.has_lava = me1 == LAVA or me2 == LAVA;
                        set(ctx, k, entry);
                    }
                }
            }
        }
    };
}

/// The first walk (pass `.none`, or `.first` with vines on the board): one route per cell, the first dequeued parent that
/// can afford it. Kept apart from the strider's pass (and its shared Geometry) so the vine-free walk stays as tight.
fn search(comptime fly: bool, comptime pass: Pass, m: *const Matrix, p: Params, out: *MovePath) void {
    // Field by field: a whole-struct `.{}` would build and copy the full route array.
    out.n = 0;
    out.by_key = .{-1} ** 256;
    out.overflow = false;
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

        /// The footprint test. `crosses` gets crossesLava: the anchor, all four 2x2 cells, or a rectangle's cells
        /// up to the first blocking one (only a flyer can stand its body over lava, so walkers skip it).
        fn blocked(self: @This(), n: Cell, initial_cells: *const Bits, crosses: *bool) bool {
            if (self.small) {
                const el = at(self.m, n.x, n.y);
                if (fly or self.p.made_of_fire) crosses.* = el == LAVA;
                return blocksBody(fly, el, self.p.made_of_fire) and !initial_cells.has(key(n.x, n.y));
            }
            if (self.legacy) {
                const cells = [4][2]i32{ .{ n.x, n.y }, .{ n.x - 1, n.y }, .{ n.x - 1, n.y - 1 }, .{ n.x, n.y - 1 } };
                if (fly or self.p.made_of_fire) {
                    for (cells) |c| {
                        if (at(self.m, c[0], c[1]) == LAVA) crosses.* = true;
                    }
                }
                for (cells) |c| {
                    if (blocksBody(fly, at(self.m, c[0], c[1]), self.p.made_of_fire) and !initial_cells.has(key(c[0], c[1]))) return true;
                }
                return false;
            }
            for (0..self.n_off) |i| {
                const fx = n.x - self.off_x[i];
                const fy = n.y - self.off_y[i];
                const el = at(self.m, fx, fy);
                if ((fly or self.p.made_of_fire) and el == LAVA) crosses.* = true;
                if (blocksBody(fly, el, self.p.made_of_fire) and !initial_cells.has(key(fx, fy))) return true;
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
            var crosses = false;
            if (ctx.blocked(n, &initial, &crosses)) {
                visited.put(kn);
                continue;
            }
            const diag = cur.x != n.x and cur.y != n.y;
            const parent = &out.routes[cur_index];
            const remaining = parent.remaining;
            var cost: f64 = undefined;
            if (diag) {
                cost = if (fly) DIAGONAL_MOVE_COST else DIAGONAL_MOVE_COST * ctx.aggr(n, parent);
                // vineAdjustedCost: a walker pays the toll on a vined anchor (a strider not in this pass)
                if (pass == .first and !fly and !p.vine_stride and vined(p.vines.?, n.x, n.y)) cost += VINE_CROSS_PENALTY;
                if (!fly) if (p.fire) |fw| {
                    cost += fireToll(fw, cur, n, p.w, p.h);
                };
                if (!(remaining >= cost)) continue;
                if (!fly and ctx.sneaks(cur, n)) continue;
            } else {
                cost = if (fly) 1 else ctx.aggr(n, parent);
                if (pass == .first and !fly and !p.vine_stride and vined(p.vines.?, n.x, n.y)) cost += VINE_CROSS_PENALTY;
                if (!fly) if (p.fire) |fw| {
                    cost += fireToll(fw, cur, n, p.w, p.h);
                };
                if (!(remaining >= cost)) continue;
            }
            const child = Route{
                .cell = n,
                .parent = @intCast(cur_index),
                .weight = parent.weight + cost,
                .remaining = remaining - cost,
                .first_aggr_met = parent.first_aggr_met,
                .has_lava = (fly or p.made_of_fire) and (parent.has_lava or crosses),
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

/// The strider's second walk (calculateMovePath with normalVineStridePaths): its queue entries (append-only, parents
/// by index), the steps each cell has left, and its knownPaths in insertion order (key -> queue index).
const StrideScratch = struct {
    pub const MAX_QUEUE = 2048;
    q: [MAX_QUEUE]Route = undefined,
    nq: u16 = 0,
    order: [256]u8 = undefined,
    n_order: u16 = 0,
    idx: [256]i16 = .{-1} ** 256,
    full: bool = false,

    fn push(self: *StrideScratch, r: Route) ?u16 {
        if (self.nq >= MAX_QUEUE) {
            self.full = true;
            return null;
        }
        self.q[self.nq] = r;
        self.nq += 1;
        return self.nq - 1;
    }

    /// knownPaths.set: replace in place (the key keeps its position), or append.
    fn set(self: *StrideScratch, k: u8, qi: u16) void {
        if (self.idx[k] < 0) {
            self.order[self.n_order] = k;
            self.n_order += 1;
        }
        self.idx[k] = @intCast(qi);
    }

    fn setRoute(self: *StrideScratch, k: u8, r: Route) void {
        const qi = self.push(r) orelse return;
        self.set(k, qi);
    }
};

/// The merged result's scratch (a copy of MovePath that the merge then writes back).
threadlocal var stride_scratch: StrideScratch = undefined;
threadlocal var merge_scratch: MovePath = undefined;

/// The second pass for a strider with vines on the board (relaxesVisited): only vined cells and the first pass's
/// destinations are walkable, a vined cell costs nothing, the neighbour scan ignores the visited table, a cell is
/// entered again whenever the new route leaves strictly more steps than it holds (the better route replaces the
/// knownPaths value), and a dequeued entry a better route overtook is dropped. Then getMovePath's merge: every vined
/// destination of this pass replaces the first pass's value of its key, or follows the first pass's keys.
fn mergeStride(m: *const Matrix, p: Params, vines: *const [st.GRID]u16, out: *MovePath) void {
    if (p.can_fly) strideSearch(true, m, p, vines, out) else strideSearch(false, m, p, vines, out);
}

fn strideSearch(comptime fly: bool, m: *const Matrix, p: Params, vines: *const [st.GRID]u16, out: *MovePath) void {
    const sc = &stride_scratch;
    sc.nq = 0;
    sc.n_order = 0;
    sc.idx = .{-1} ** 256;
    sc.full = false;
    const g = Geometry(fly).init(m, p);
    const start = p.start;
    var visited: Bits = .{};
    var allowed: Bits = .{};
    var left: [256]f64 = .{0} ** 256; // indexedStepsRemaining (a Float64Array: 0 until written)
    visited.put(key(start.x, start.y));
    left[key(start.x, start.y)] = p.max_steps;
    _ = sc.push(.{ .cell = start, .parent = -1, .weight = 0, .remaining = p.max_steps, .first_aggr_met = false });

    var qi: u16 = 0;
    while (qi < sc.nq) {
        const cur_index = qi;
        qi += 1;
        const cur = sc.q[cur_index].cell;
        const kc = key(cur.x, cur.y);
        if (p.max_steps - sc.q[cur_index].weight < left[kc] - PATH_BUDGET_EPSILON) continue; // overtaken
        var nbrs: [8]Cell = undefined;
        const nn = g.neighbours(cur, &nbrs);
        for (nbrs[0..nn]) |n| {
            const kn = key(n.x, n.y);
            const on_vine = vined(vines, n.x, n.y);
            if (!on_vine and out.by_key[kn] < 0) continue; // neither a vine nor a first-pass destination
            if (!g.small and (n.x < g.w - 1 or n.y < g.h - 1)) {
                visited.put(kn);
                continue;
            }
            var crosses = false;
            if (g.blocked(n, &crosses)) {
                visited.put(kn);
                continue;
            }
            const diag = cur.x != n.x and cur.y != n.y;
            const parent = &sc.q[cur_index];
            const remaining = left[kc];
            var cost: f64 = undefined;
            if (diag) {
                cost = if (fly) DIAGONAL_MOVE_COST else DIAGONAL_MOVE_COST * g.aggr(n, parent);
            } else {
                cost = if (fly) 1 else g.aggr(n, parent);
            }
            if (on_vine) cost = 0; // VINE_STRIDE_CELL_COST
            if (!fly) if (p.fire) |fw| {
                cost += fireToll(fw, cur, n, p.w, p.h);
            };
            if (!(remaining >= cost)) continue;
            const next = remaining - cost;
            if (visited.has(kn) and !(next > left[kn] + PATH_BUDGET_EPSILON)) continue; // relaxesBudget
            if (diag and !fly and g.sneaks(cur, n)) continue;
            left[kn] = next;
            const child = Route{
                .cell = n,
                .parent = @intCast(cur_index),
                .weight = parent.weight + cost,
                .remaining = next,
                .first_aggr_met = parent.first_aggr_met,
                .has_lava = (fly or p.made_of_fire) and (parent.has_lava or crosses),
            };
            const ci = sc.push(child) orelse break;
            if (visited.has(kn)) {
                sc.set(kn, ci); // a better route to a cell already walked replaces its value
            } else {
                sc.set(kn, ci); // captureRoute: always the first-arrival `set` branch
                g.markAllowed(&allowed, n);
            }
            visited.put(kn);
        }
    }
    const Set = struct {
        fn f(s: *StrideScratch, k: u8, r: Route) void {
            s.setRoute(k, r);
        }
    };
    g.closestMoves(&allowed, sc, Set.f);
    if (sc.full) {
        out.overflow = true;
        return;
    }
    merge(out, sc, vines);
}

/// Builds the merged knownPaths into `out`: the first pass's values in order with each vined key of the second pass
/// replacing its value in place (or appended after), then the ancestors of every kept route that are no longer values
/// themselves, copied past `n` (each source route at most once, so shared prefixes stay shared).
fn merge(out: *MovePath, sc: *StrideScratch, vines: *const [st.GRID]u16) void {
    const r = &merge_scratch;
    r.n = 0;
    r.by_key = .{-1} ** 256;
    r.overflow = false;
    // The merged values: (from the second pass, source index), in knownPaths order.
    const Src = struct { stride: bool, i: u16 };
    var values: [256]Src = undefined;
    var n_values: usize = 0;
    var pos: [256]i16 = .{-1} ** 256;
    for (out.routes[1..out.n], 1..) |rt, i| {
        const k = key(rt.cell.x, rt.cell.y);
        pos[k] = @intCast(n_values);
        values[n_values] = .{ .stride = false, .i = @intCast(i) };
        n_values += 1;
    }
    for (sc.order[0..sc.n_order]) |k| {
        const qi: u16 = @intCast(sc.idx[k]);
        const cell = sc.q[qi].cell;
        if (!vined(vines, cell.x, cell.y)) continue;
        if (pos[k] >= 0) {
            values[@intCast(pos[k])] = .{ .stride = true, .i = qi };
        } else {
            pos[k] = @intCast(n_values);
            values[n_values] = .{ .stride = true, .i = qi };
            n_values += 1;
        }
    }
    // Where each source route lands in the result (-1: not copied yet); both starts are routes[0].
    var map_first: [MAX_ROUTES]i16 = .{-1} ** MAX_ROUTES;
    var map_stride: [StrideScratch.MAX_QUEUE]i16 = .{-1} ** StrideScratch.MAX_QUEUE;
    map_first[0] = 0;
    map_stride[0] = 0;
    r.routes[0] = out.routes[0];
    r.n = @intCast(1 + n_values);
    for (values[0..n_values], 1..) |v, i| {
        if (v.stride) map_stride[v.i] = @intCast(i) else map_first[v.i] = @intCast(i);
        const rt = if (v.stride) sc.q[v.i] else out.routes[v.i];
        r.by_key[key(rt.cell.x, rt.cell.y)] = @intCast(i);
    }
    // Copy every value and, on demand, its missing ancestors (a work list of (result index, source)).
    var work: [MAX_ROUTES]struct { at: u16, src: Src } = undefined;
    var n_work: usize = 0;
    for (values[0..n_values], 1..) |v, i| {
        work[n_work] = .{ .at = @intCast(i), .src = v };
        n_work += 1;
    }
    var next_hidden: usize = r.n;
    var w: usize = 0;
    while (w < n_work) : (w += 1) {
        const item = work[w];
        var rt = if (item.src.stride) sc.q[item.src.i] else out.routes[item.src.i];
        if (rt.parent >= 0) {
            const pi: u16 = @intCast(rt.parent);
            const mapped = if (item.src.stride) &map_stride[pi] else &map_first[pi];
            if (mapped.* < 0) {
                if (next_hidden >= MAX_ROUTES or n_work >= work.len) {
                    out.overflow = true;
                    return;
                }
                mapped.* = @intCast(next_hidden);
                work[n_work] = .{ .at = @intCast(next_hidden), .src = .{ .stride = item.src.stride, .i = pi } };
                n_work += 1;
                next_hidden += 1;
            }
            rt.parent = mapped.*;
        }
        r.routes[item.at] = rt;
    }
    // routeCells writes into 64-cell buffers: a longer route is outside the port.
    for (1..r.n) |i| {
        var len: usize = 0;
        var cur: i16 = @intCast(i);
        while (cur >= 0) : (cur = r.routes[@intCast(cur)].parent) {
            len += 1;
            if (len > 64) {
                out.overflow = true;
                return;
            }
        }
    }
    out.n = r.n;
    out.by_key = r.by_key;
    @memcpy(out.routes[0..next_hidden], r.routes[0..next_hidden]);
}
