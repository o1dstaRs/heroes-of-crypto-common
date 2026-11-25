//! The v0.1 AI (src/ai/versions/v0_1.ts StrategyV0_1.decideTurn and src/ai/ai.ts findTarget) and the v0.1 match
//! loop (runMatchInner in src/simulation/battle_engine.ts), in scope: the abilities in abilities.zig (the AI reads
//! only Backstab), no spells; NORMAL, LAVA_CENTER and BLOCK_CENTER grids (the mountain strategy), classic or
//! side-oriented boards.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const combat = @import("combat.zig");
const pathing = @import("path.zig");
const terrain = @import("terrain.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
const AT = st.AttackType;
const Team = st.Team;
const Matrix = pathing.Matrix;
const MovePath = pathing.MovePath;
const Route = pathing.Route;
const INF = std.math.inf(f64);

// =====================================================================================================================
// Decision output
// =====================================================================================================================

pub const Decision = struct {
    actions: [3]rec.Action = undefined,
    n: u8 = 0,
    path: [64]Cell = undefined,
    targets: [4]Cell = undefined,

    pub fn push(self: *Decision, a: rec.Action) void {
        self.actions[self.n] = a;
        self.n += 1;
    }
    pub fn slice(self: *const Decision) []const rec.Action {
        return self.actions[0..self.n];
    }
};

pub const Kind = enum { melee, range, move, move_and_melee, obstacle };

/// BasicAIAction. `paths` null is the empty `new Map()`.
pub const AIAction = struct {
    kind: Kind,
    move: ?Cell = null,
    attack: ?Cell = null,
    paths: ?*const MovePath = null,
};

/// Per-decision scratch: the decision's matrix and its two move paths (the "actual" one is shared by doFindTarget,
/// fallbackTurn and engineReachableCellKeys: identical arguments, and getMovePath draws nothing in scope).
pub const Ctx = struct {
    s: *State,
    ui: u8,
    m: Matrix,
    infinite: MovePath = undefined,
    actual: MovePath = undefined,
    have_actual: bool = false,
    /// decideTurn's melee branch re-targets through preferRespondedMeleeTarget only for v0.1 (`this.version === "v0.1"`);
    /// a later version's port sets this false. completeMoveWithAdjacentMelee applies it either way.
    prefer_responded: bool = true,
    /// v0.6's setPreferAttackOverMining (ai.ts findTarget): when the mountain strategy offers a strike, doFindTarget
    /// runs (side effects included) and its action replaces the strike when it is an attack. False for v0.1; a
    /// later version's port sets it around its inherited findTarget call.
    prefer_attack_over_mining: bool = false,
    route_buf: [64]Cell = undefined,
    /// isFreeAt for the melee layers: on the board and empty, or one of the attacker's own cells. Bit y of free[x].
    free: [st.GRID]u16 = .{0} ** st.GRID,

    pub fn initFree(self: *Ctx) void {
        const body = engine.unitCells(self.unit());
        for (0..st.GRID) |x| {
            var col: u16 = 0;
            for (0..st.GRID) |y| {
                if (self.m[x][y] == 0) col |= @as(u16, 1) << @intCast(y);
            }
            self.free[x] = col;
        }
        for (body.slice()) |b| {
            if (engine.cellWithinGrid(b)) self.free[@intCast(b.x)] |= @as(u16, 1) << @intCast(b.y);
        }
    }

    pub inline fn unit(self: *const Ctx) *Unit {
        return &self.s.units[self.ui];
    }

    pub fn params(self: *const Ctx, max_steps: f64) pathing.Params {
        const u = self.unit();
        return .{
            .start = engine.baseCell(u),
            .max_steps = max_steps,
            .aggr = &self.s.grid.aggr[engine.opposite(u.team)],
            .can_fly = engine.canFly(u),
            .w = u.fw,
            .h = u.fh,
        };
    }

    pub fn actualPath(self: *Ctx) *const MovePath {
        if (!self.have_actual) {
            pathing.getMovePath(&self.m, self.params(engine.getSteps(self.unit())), &self.actual);
            self.have_actual = true;
        }
        return &self.actual;
    }
};

// =====================================================================================================================
// Small helpers
// =====================================================================================================================

pub inline fn mat(m: *const Matrix, x: i32, y: i32) i8 {
    return pathing.at(m, x, y);
}

pub inline fn sameCell(a: Cell, b: Cell) bool {
    return a.x == b.x and a.y == b.y;
}

pub inline fn occupant(s: *const State, c: Cell) ?u8 {
    if (!engine.cellWithinGrid(c)) return null;
    const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
    if (!st.isUnitCode(o)) return null;
    return o - 1;
}

/// footprintCellsForAnchor (src/simulation/footprint.ts): 1x1 [a]; 2x2 [a, (x-1,y), (x,y-1), (x-1,y-1)];
/// otherwise getFootprintCellsForAnchor (dx outer, dy inner).
pub fn footprintForAnchor(u: *const Unit, a: Cell) engine.Cells {
    var out: engine.Cells = .{};
    if (u.fw == 2 and u.fh == 2) {
        out.push(a);
        out.push(.{ .x = a.x - 1, .y = a.y });
        out.push(.{ .x = a.x, .y = a.y - 1 });
        out.push(.{ .x = a.x - 1, .y = a.y - 1 });
        return out;
    }
    return engine.cellsForAnchor(a, u.fw, u.fh);
}

/// canUnitLandAt -> Grid.canOccupyFootprintAt: on board, and empty or the unit's own cells (holes block).
pub fn canLandAt(s: *const State, ui: u8, a: Cell) bool {
    const u = &s.units[ui];
    var dx: i32 = 0;
    while (dx < u.fw) : (dx += 1) {
        var dy: i32 = 0;
        while (dy < u.fh) : (dy += 1) {
            const c = Cell{ .x = a.x - dx, .y = a.y - dy };
            if (!engine.cellWithinGrid(c)) return false;
            const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
            if (o != st.EMPTY and o != ui + 1) return false;
        }
    }
    return true;
}

pub fn adjacent(a: []const Cell, b: []const Cell) bool {
    for (a) |c1| {
        for (b) |c2| {
            const dx = @abs(c1.x - c2.x);
            const dy = @abs(c1.y - c2.y);
            if ((dx == 1 and dy == 0) or (dx == 0 and dy == 1) or (dx == 1 and dy == 1)) return true;
        }
    }
    return false;
}

pub inline fn cellDistance(a: Cell, b: Cell) f64 {
    return engine.distance(@floatFromInt(a.x), @floatFromInt(a.y), @floatFromInt(b.x), @floatFromInt(b.y));
}

/// countMeleeThreatsToCell: enemy CELLS around the cell.
pub fn countThreats(m: *const Matrix, c: Cell, enemy: u8) u32 {
    var n: u32 = 0;
    var dy: i32 = -1;
    while (dy <= 1) : (dy += 1) {
        var dx: i32 = -1;
        while (dx <= 1) : (dx += 1) {
            if (dx == 0 and dy == 0) continue;
            const nx = c.x + dx;
            const ny = c.y + dy;
            if (nx < 0 or ny < 0 or nx >= st.GRID or ny >= st.GRID) continue;
            if (mat(m, nx, ny) == @as(i8, @intCast(enemy))) n += 1;
        }
    }
    return n;
}

pub fn isMeleeSelection(t: u8) bool {
    return t == AT.MELEE or t == AT.MELEE_MAGIC;
}

/// meleeAttackTypeSelectionPrefix
pub fn meleePrefix(u: *const Unit) ?u8 {
    if (isMeleeSelection(u.attack_type_selected)) return null;
    if (engine.possibleIncludes(u, AT.MELEE)) return AT.MELEE;
    if (engine.possibleIncludes(u, AT.MELEE_MAGIC)) return AT.MELEE_MAGIC;
    return null;
}

// =====================================================================================================================
// findTarget and its helpers (src/ai/ai.ts)
// =====================================================================================================================

/// UnitsHolder.allEnemiesAroundUnit(unit, false): first-seen order over cellsAroundUnit at the unit's base cell.
pub fn enemiesAround(s: *const State, ui: u8, out: *engine.UnitList) void {
    combat.enemiesAround(s, ui, engine.baseCell(&s.units[ui]), out);
}

/// canSelectMeleeTarget (ai.ts): a living enemy, and the live forced target only while the unit is Aggr'd (no Hidden
/// or Cowardice in scope).
pub fn canSelectMeleeTarget(s: *const State, ui: u8, t: u8) bool {
    const target = &s.units[t];
    if (target.isDead() or target.team == s.units[ui].team) return false;
    if (combat.forcedTarget(s, &s.units[ui])) |f| return f == t;
    return true;
}

/// isLegalMeleeTargetAtHp (v0_1.ts): canSelectMeleeTarget's checks on a holder unit (the forced target read the same
/// way: present and alive).
pub fn isLegalMeleeTarget(s: *const State, ui: u8, t: u8) bool {
    return s.units[t].in_holder and canSelectMeleeTarget(s, ui, t);
}

/// isLineBlockedByFriendlyUnit: walk the line on accumulated f64 steps; the first friendly that is not the
/// shooter's own body blocks, an enemy first means clear.
pub fn lineBlockedByFriendly(m: *const Matrix, from: Cell, to: Cell, friendly: u8, own: []const Cell) bool {
    const dx: f64 = @floatFromInt(to.x - from.x);
    const dy: f64 = @floatFromInt(to.y - from.y);
    const len_i = @max(@abs(to.x - from.x), @abs(to.y - from.y));
    if (len_i <= 1) return false;
    const len: f64 = @floatFromInt(len_i);
    const enemy: i8 = @intCast(engine.opposite(friendly));
    const sx = dx / len;
    const sy = dy / len;
    var cx_f = @as(f64, @floatFromInt(from.x)) + sx;
    var cy_f = @as(f64, @floatFromInt(from.y)) + sy;
    var i: u32 = 1;
    while (i < len_i) : (i += 1) {
        const cx: i32 = @intFromFloat(js.round(cx_f));
        const cy: i32 = @intFromFloat(js.round(cy_f));
        if (cx >= 0 and cy >= 0 and cx < st.GRID and cy < st.GRID) {
            const v = mat(m, cx, cy);
            if (v == @as(i8, @intCast(friendly))) {
                var own_body = false;
                for (own) |oc| {
                    if (oc.x == cx and oc.y == cy) own_body = true;
                }
                if (!own_body) return true;
            }
            if (v == enemy) return false;
        }
        cx_f += sx;
        cy_f += sy;
    }
    return false;
}

/// isLineBlockedByObstacle: the cells between two cells, stepped on accumulated f64 fractions and Math.round, hold a
/// mountain or stone (-1). Not the engine's ray: only the AI's target preference reads it.
pub fn lineBlockedByObstacle(m: *const Matrix, from: Cell, to: Cell) bool {
    const len_i = @max(@abs(to.x - from.x), @abs(to.y - from.y));
    if (len_i <= 1) return false;
    const len: f64 = @floatFromInt(len_i);
    const sx = @as(f64, @floatFromInt(to.x - from.x)) / len;
    const sy = @as(f64, @floatFromInt(to.y - from.y)) / len;
    var cx_f = @as(f64, @floatFromInt(from.x)) + sx;
    var cy_f = @as(f64, @floatFromInt(from.y)) + sy;
    var i: u32 = 1;
    while (i < len_i) : (i += 1) {
        const cx: i32 = @intFromFloat(js.round(cx_f));
        const cy: i32 = @intFromFloat(js.round(cy_f));
        if (cx >= 0 and cy >= 0 and cx < st.GRID and cy < st.GRID and mat(m, cx, cy) == pathing.BLOCK) return true;
        cx_f += sx;
        cy_f += sy;
    }
    return false;
}

pub fn findRangeAttackAction(c: *Ctx) ?AIAction {
    const s = c.s;
    const u = c.unit();
    if (engine.getRangeShots(u) <= 0) return null;
    const unit_cell = engine.baseCell(u);
    const enemy: i8 = @intCast(engine.opposite(u.team));
    const body = engine.unitCells(u);
    const shot_distance = u.shot_distance;
    if (shot_distance <= 0) return null;
    const band = if (std.math.isFinite(shot_distance) and shot_distance > 0) @floor(shot_distance) else 0;
    const max_range = band * 4;
    var best: ?Cell = null;
    var best_score: f64 = -1;
    var y: i32 = 0;
    while (y < st.GRID) : (y += 1) {
        var x: i32 = 0;
        while (x < st.GRID) : (x += 1) {
            if (mat(&c.m, x, y) != enemy) continue;
            const t = Cell{ .x = x, .y = y };
            const d: f64 = @floatFromInt(@max(@abs(t.x - unit_cell.x), @abs(t.y - unit_cell.y)));
            if (d > max_range) continue;
            if (lineBlockedByObstacle(&c.m, unit_cell, t)) continue;
            if (lineBlockedByFriendly(&c.m, unit_cell, t, u.team, body.slice())) continue;
            var divisor: f64 = 1;
            if (band > 0) {
                var dd = d;
                while (dd > band) {
                    dd -= band;
                    divisor *= 2;
                }
                if (divisor > 8) divisor = 8;
            }
            const score = 1 / divisor;
            if (score > best_score) {
                best_score = score;
                best = t;
            }
        }
    }
    const b = best orelse return null;
    if (occupant(s, b)) |o| s.ai_prev_target[c.ui] = @intCast(o);
    return .{ .kind = .range, .attack = b };
}

pub const Engagement = struct {
    total_melee: u32 = 0,
    total_ranged: u32 = 0,
    engaged_melee: u32 = 0,
    center: ?Cell = null,
    nearest_melee: f64 = 0,
    pressing: bool = false,
};

pub fn analyzeEngagement(c: *const Ctx) Engagement {
    const s = c.s;
    const u = c.unit();
    const enemy: i8 = @intCast(engine.opposite(u.team));
    const unit_cell = engine.baseCell(u);
    var e: Engagement = .{};
    var sum_x: f64 = 0;
    var sum_y: f64 = 0;
    var nearest = INF;
    for (s.units[0..s.n_units], 0..) |*a, i| {
        if (!a.in_holder or a.team != u.team or i == c.ui or a.isDead()) continue;
        const ac = engine.baseCell(a);
        if (a.attack_type == AT.RANGE) {
            e.total_ranged += 1;
        } else {
            e.total_melee += 1;
            sum_x += @floatFromInt(ac.x);
            sum_y += @floatFromInt(ac.y);
            nearest = @min(nearest, cellDistance(unit_cell, ac));
            if (countThreats(&c.m, ac, @intCast(enemy)) > 0) e.engaged_melee += 1;
        }
        if (!e.pressing) {
            var dy: i32 = -3;
            outer: while (dy <= 3) : (dy += 1) {
                var dx: i32 = -3;
                while (dx <= 3) : (dx += 1) {
                    const nx = ac.x + dx;
                    const ny = ac.y + dy;
                    if (nx >= 0 and ny >= 0 and nx < st.GRID and ny < st.GRID and mat(&c.m, nx, ny) == enemy) {
                        e.pressing = true;
                        break :outer;
                    }
                }
            }
        }
    }
    if (e.total_melee > 0) {
        const n: f64 = @floatFromInt(e.total_melee);
        e.center = .{ .x = @intFromFloat(js.round(sum_x / n)), .y = @intFromFloat(js.round(sum_y / n)) };
    }
    e.nearest_melee = if (nearest == INF) 0 else nearest;
    return e;
}

/// findSaferMoveCell(preferred, knownPaths, matrix, enemyTeam, true, canUnitLandAt). Returns the replacement cell
/// when a candidate beat the preferred cell, else null (the caller keeps its action).
pub fn saferMoveCell(c: *const Ctx, preferred: ?Cell, paths: ?*const MovePath) ?Cell {
    const p = preferred orelse return null;
    const kp = paths orelse return null;
    if (kp.size() == 0) return null;
    const enemy: i8 = @intCast(engine.opposite(c.unit().team));
    const Land = struct {
        fn ok(ctx: *const Ctx, cell: Cell, en: i8) bool {
            const v = mat(&ctx.m, cell.x, cell.y);
            if (v == -1 or v == -2 or v == en) return false;
            return canLandAt(ctx.s, ctx.ui, cell);
        }
    };
    const preferred_threats = countThreats(&c.m, p, @intCast(enemy));
    const preferred_legal = Land.ok(c, p, enemy);
    if (preferred_threats == 0 and preferred_legal) return null;
    var safest: ?Cell = null;
    var replaced = false;
    var safest_threats: f64 = if (preferred_legal) @floatFromInt(preferred_threats) else INF;
    var safest_dist = INF;
    for (kp.known()) |r| {
        const cand = r.cell;
        if (!Land.ok(c, cand, enemy)) continue;
        const threats: f64 = @floatFromInt(countThreats(&c.m, cand, @intCast(enemy)));
        const dist = cellDistance(cand, p);
        if (threats < safest_threats or (threats == safest_threats and dist < safest_dist)) {
            safest_threats = threats;
            safest_dist = dist;
            safest = cand;
            replaced = true;
        }
    }
    return if (replaced) safest else null;
}

// ---- buildMeleeTargetLayers (src/ai/internal/melee_target_layers.ts) ----

pub const Layer = struct {
    cells: [64]Cell = undefined,
    n: u8 = 0,

    pub fn push(self: *Layer, c: Cell) void {
        self.cells[self.n] = c;
        self.n += 1;
    }
};

pub inline fn freeAt(c: *const Ctx, x: i32, y: i32, body: []const Cell) bool {
    _ = body;
    if (x < 0 or x >= st.GRID or y < 0 or y >= st.GRID) return false;
    return c.free[@intCast(x)] & (@as(u16, 1) << @intCast(y)) != 0;
}

pub fn buildLayer(c: *const Ctx, target: Cell, d: i32, body: []const Cell, out: *Layer) void {
    out.* = .{};
    const u = c.unit();
    const cx = target.x;
    const cy = target.y;
    const span = d * 2 + 1;
    if (u.fw == 1 and u.fh == 1) {
        var o: i32 = 0;
        while (o < span) : (o += 1) if (freeAt(c, cx - d + o, cy - d, body)) out.push(.{ .x = cx - d + o, .y = cy - d });
        o = 0;
        while (o < span) : (o += 1) if (freeAt(c, cx - d + o, cy + d, body)) out.push(.{ .x = cx - d + o, .y = cy + d });
        o = 0;
        while (o < span) : (o += 1) if (freeAt(c, cx - d, cy - d + o, body)) out.push(.{ .x = cx - d, .y = cy - d + o });
        o = 0;
        while (o < span) : (o += 1) if (freeAt(c, cx + d, cy - d + o, body)) out.push(.{ .x = cx + d, .y = cy - d + o });
    } else if (u.fw == 2 and u.fh == 2) {
        const Fits = struct {
            fn f(ctx: *const Ctx, x: i32, y: i32, bd: []const Cell) bool {
                return freeAt(ctx, x, y, bd) and freeAt(ctx, x - 1, y, bd) and freeAt(ctx, x - 1, y - 1, bd) and freeAt(ctx, x, y - 1, bd);
            }
        };
        var o: i32 = 0;
        while (o < span) : (o += 1) if (Fits.f(c, cx - d + o, cy - d, body)) out.push(.{ .x = cx - d + o, .y = cy - d });
        o = 0;
        while (o < span) : (o += 1) if (Fits.f(c, cx - d + o, cy + d + 1, body)) out.push(.{ .x = cx - d + o, .y = cy + d + 1 });
        o = 0;
        while (o < span) : (o += 1) if (Fits.f(c, cx - d, cy - d + o, body)) out.push(.{ .x = cx - d, .y = cy - d + o });
        o = 0;
        while (o < span) : (o += 1) if (Fits.f(c, cx + d + 1, cy - d + o, body)) out.push(.{ .x = cx + d + 1, .y = cy - d + o });
        if (Fits.f(c, cx + d + 1, cy + d + 1, body)) out.push(.{ .x = cx + d + 1, .y = cy + d + 1 });
    } else {
        const w: i32 = u.fw;
        const h: i32 = u.fh;
        const x_min = cx - d;
        const x_max = cx + d + w - 1;
        const y_min = cy - d;
        const y_max = cy + d + h - 1;
        const Fits = struct {
            fn f(ctx: *const Ctx, x: i32, y: i32, bd: []const Cell, fw: u8, fh: u8) bool {
                const fp = engine.cellsForAnchor(.{ .x = x, .y = y }, fw, fh);
                for (fp.slice()) |cell| if (!freeAt(ctx, cell.x, cell.y, bd)) return false;
                return true;
            }
        };
        var x = x_min;
        while (x <= x_max) : (x += 1) if (Fits.f(c, x, y_min, body, u.fw, u.fh)) out.push(.{ .x = x, .y = y_min });
        x = x_min;
        while (x <= x_max) : (x += 1) if (Fits.f(c, x, y_max, body, u.fw, u.fh)) out.push(.{ .x = x, .y = y_max });
        var y = y_min + 1;
        while (y < y_max) : (y += 1) {
            if (Fits.f(c, x_min, y, body, u.fw, u.fh)) out.push(.{ .x = x_min, .y = y });
            if (Fits.f(c, x_max, y, body, u.fw, u.fh)) out.push(.{ .x = x_max, .y = y });
        }
    }
}

/// selectableMeleeTargetIdAt: a unit on that cell that canSelectMeleeTarget accepts.
pub fn selectableTargetAt(s: *const State, ui: u8, cell: Cell) ?u8 {
    const o = occupant(s, cell) orelse return null;
    return if (canSelectMeleeTarget(s, ui, o)) o else null;
}

pub const ResultRoute = struct { infinite: bool, index: u16 };

pub fn routeOf(c: *const Ctx, r: ResultRoute) *const Route {
    return if (r.infinite) &c.infinite.routes[r.index] else &c.actual.routes[r.index];
}

pub fn routeIndex(mp: *const MovePath, r: *const Route) u16 {
    return @intCast((@intFromPtr(r) - @intFromPtr(&mp.routes[0])) / @sizeOf(Route));
}

/// doFindTarget (ai.ts:1548)
pub fn doFindTarget(c: *Ctx) ?AIAction {
    const s = c.s;
    const u = c.unit();
    const unit_cell = engine.baseCell(u);
    const team: i8 = @intCast(u.team);
    const steps = engine.getSteps(u);
    pathing.getMovePath(&c.m, c.params(100 + steps), &c.infinite);
    _ = c.actualPath();
    const body = engine.unitCells(u);

    var closest: ?Cell = null;
    var closest_distance = INF;
    var result: ?ResultRoute = null;
    var result_index: ?i32 = null;
    var result_movement = INF;
    var result_left = INF;
    var result_depth = INF;
    var used_infinite = true;

    var layer: Layer = .{};
    var route_cells: [64]Cell = undefined;

    // ---- pass A: infinite path, distance-one layer ----
    {
        const mp = &c.infinite;
        var y: i32 = 0;
        while (y < st.GRID) : (y += 1) {
            var x: i32 = 0;
            while (x < st.GRID) : (x += 1) {
                const el = mat(&c.m, x, y);
                if (el == team or el == 0 or el < 0) continue;
                const target = selectableTargetAt(s, c.ui, .{ .x = x, .y = y }) orelse continue;
                var depth: i32 = 0;
                while (depth < 7) : (depth += 1) {
                    var layer_left = INF;
                    buildLayer(c, .{ .x = x, .y = y }, depth + 1, body.slice(), &layer);
                    for (layer.cells[0..layer.n]) |lc| {
                        if (depth == 0 and sameCell(lc, unit_cell)) {
                            s.ai_prev_target[c.ui] = @intCast(target);
                            return .{ .kind = .melee, .move = unit_cell, .attack = .{ .x = x, .y = y }, .paths = mp };
                        }
                        if (!canLandAt(s, c.ui, lc)) continue;
                        const r = mp.get(pathing.key(lc.x, lc.y)) orelse continue;
                        const weight = r.weight;
                        if (!(weight < closest_distance)) continue;
                        closest_distance = weight;
                        closest = .{ .x = x, .y = y };
                        const len = mp.routeCells(r, &route_cells);
                        var idx: i32 = 0;
                        var next_dist: ?f64 = null;
                        while (true) {
                            const cell = route_cells[@intCast(idx)];
                            if (idx + 1 >= len) break;
                            const next = route_cells[@intCast(idx + 1)];
                            if (sameCell(cell, lc)) break;
                            next_dist = if (mp.get(pathing.key(next.x, next.y))) |nr| nr.weight else null;
                            if (next_dist) |nd| {
                                if (nd > steps) break;
                            }
                            idx += 1;
                            const nd = next_dist orelse break;
                            if (!(nd <= steps and idx < len)) break;
                        }
                        while (idx >= 0) {
                            if (idx >= len) break;
                            if (canLandAt(s, c.ui, route_cells[@intCast(idx)])) break;
                            idx -= 1;
                        }
                        if (idx < 0) continue; // route[-1] is undefined: currentDistance undefined
                        const left: f64 = @floatFromInt(@as(i32, @intCast(len)) - 1 - idx);
                        const move_to = route_cells[@intCast(idx)];
                        const cur_dist = (mp.get(pathing.key(move_to.x, move_to.y)) orelse continue).weight;
                        if (left < layer_left or (left == layer_left and cur_dist < result_movement)) {
                            result = .{ .infinite = true, .index = routeIndex(mp, r) };
                            result_index = idx;
                            result_movement = cur_dist;
                            layer_left = left;
                        }
                    }
                    if (result_movement != 0 and !std.math.isNan(result_movement)) break;
                }
            }
        }
    }

    const settled = blk: {
        const r = result orelse break :blk false;
        const len = c.infinite.routeCells(routeOf(c, r), &route_cells);
        break :blk result_index != null and @as(i32, @intCast(len)) - 1 == result_index.?;
    };
    if (!settled) {
        // ---- pass B: actual path, all layers ----
        used_infinite = false;
        const mp = c.actualPath();
        var y: i32 = 0;
        while (y < st.GRID) : (y += 1) {
            var x: i32 = 0;
            while (x < st.GRID) : (x += 1) {
                const el = mat(&c.m, x, y);
                if (el == team or el == 0 or el < 0) continue;
                const target = selectableTargetAt(s, c.ui, .{ .x = x, .y = y }) orelse continue;
                var depth: i32 = 0;
                while (depth < 7) : (depth += 1) {
                    buildLayer(c, .{ .x = x, .y = y }, depth + 1, body.slice(), &layer);
                    for (layer.cells[0..layer.n]) |lc| {
                        if (depth == 0 and sameCell(lc, unit_cell)) {
                            s.ai_prev_target[c.ui] = @intCast(target);
                            return .{ .kind = .melee, .move = unit_cell, .attack = .{ .x = x, .y = y }, .paths = mp };
                        }
                        if (!canLandAt(s, c.ui, lc)) continue;
                        const r = mp.get(pathing.key(lc.x, lc.y)) orelse continue;
                        const movement = r.weight;
                        const left = cellDistance(lc, .{ .x = x, .y = y });
                        const fd: f64 = @floatFromInt(depth);
                        if (result_depth > fd or (result_depth == fd and (left < result_left or (left == result_left and movement < result_movement)))) {
                            result = .{ .infinite = false, .index = routeIndex(mp, r) };
                            result_movement = movement;
                            result_left = left;
                            result_depth = fd;
                            closest = .{ .x = x, .y = y };
                        }
                    }
                }
            }
        }
    }

    const target_cell = closest orelse return null;
    if (result_index) |ri| {
        if (ri == 0) {
            if (occupant(s, target_cell)) |o| s.ai_prev_target[c.ui] = @intCast(o);
            const end: ?Cell = if (result) |r| routeOf(c, r).cell else null;
            return .{ .kind = .melee, .move = end, .attack = target_cell, .paths = if (used_infinite) &c.infinite else c.actualPath() };
        }
    }
    const end: ?Cell = if (result) |r| routeOf(c, r).cell else null;
    if ((!used_infinite and result_depth == 0) or (used_infinite and settled)) {
        if (occupant(s, target_cell)) |o| s.ai_prev_target[c.ui] = @intCast(o);
        return .{ .kind = .move_and_melee, .move = end, .attack = target_cell, .paths = if (used_infinite) &c.infinite else c.actualPath() };
    }
    s.ai_prev_target[c.ui] = -1;
    return .{ .kind = .move, .move = end, .paths = c.actualPath() };
}

/// findTarget (ai.ts:197)
pub fn findTarget(c: *Ctx) ?AIAction {
    const s = c.s;
    const u = c.unit();
    const enemy_team = engine.opposite(u.team);
    const unit_cell = engine.baseCell(u);
    var around: engine.UnitList = undefined;
    enemiesAround(s, c.ui, &around);
    // canSelectMeleeTarget + isPositionWithinGrid: living enemies on the board.
    var list: engine.UnitList = .{};
    for (around.slice()) |e| {
        const eu = &s.units[e];
        if (canSelectMeleeTarget(s, c.ui, e) and engine.positionWithinGrid(eu.pos_x, eu.pos_y)) list.push(e);
    }
    var selected: ?u8 = null;
    if (combat.forcedTarget(s, u)) |forced| {
        // A live forced target replaces the target memory; the list then holds at most that unit, so no draw.
        for (list.slice()) |e| if (e == forced) {
            selected = e;
        };
    } else {
        const prev = s.ai_prev_target[c.ui];
        if (prev >= 0) {
            for (list.slice()) |e| if (e == prev) {
                selected = e;
            };
        }
    }
    if (selected == null and list.len > 0) selected = list.items[@intCast(s.rng.int(0, list.len))];

    var action: ?AIAction = null;
    if (selected) |e| {
        const ec_list = engine.unitCells(&s.units[e]);
        const uc_list = engine.unitCells(u);
        outer: for (ec_list.slice()) |ec| {
            for (uc_list.slice()) |uc| {
                if (@abs(ec.x - uc.x) <= 1 and @abs(ec.y - uc.y) <= 1) {
                    action = .{ .kind = .melee, .move = unit_cell, .attack = ec };
                    break :outer;
                }
            }
        }
    }
    if (action == null and u.attack_type == AT.RANGE and engine.getRangeShots(u) > 0) action = findRangeAttackAction(c);

    const eng = analyzeEngagement(c);
    const ranged = u.attack_type == AT.RANGE;
    const engaged = countThreats(&c.m, unit_cell, enemy_team) > 0;

    if (action == null and !ranged and !engaged) {
        if (evaluateMountainStrategy(c, &eng)) |mountain| {
            action = mountain; // takes priority over the ranged-heavy hold and the regroup (BLOCK_CENTER only)
            if (c.prefer_attack_over_mining) {
                if (doFindTarget(c)) |normal| {
                    if (normal.kind == .melee or normal.kind == .move_and_melee or normal.kind == .range) action = normal;
                }
            }
        } else if (eng.total_ranged > eng.total_melee and eng.total_ranged >= 2 and !eng.pressing) {
            return null;
        } else if (eng.total_melee > 0 and eng.nearest_melee > 4 and eng.engaged_melee == 0 and !eng.pressing) {
            action = doFindTarget(c);
            if (action) |a| {
                if (a.kind == .move) {
                    if (a.paths) |p| {
                        const center = eng.center.?;
                        if (center.x >= 0 and center.x < st.GRID and center.y >= 0 and center.y < st.GRID) {
                            if (p.get(pathing.key(center.x, center.y))) |r| action = .{ .kind = .move, .move = r.cell, .paths = p };
                        }
                    }
                }
            }
        } else {
            action = doFindTarget(c);
        }
    } else if (action == null) {
        action = doFindTarget(c);
    }

    if (action) |a| {
        if (a.kind == .move) {
            if (ranged) {
                if (saferMoveCell(c, a.move, a.paths)) |safer| action = .{ .kind = .move, .move = safer, .paths = a.paths };
            } else {
                const dest_threats: u32 = if (a.move) |d| countThreats(&c.m, d, enemy_team) else 0;
                if (!engaged and eng.engaged_melee > 0 and dest_threats >= 2) {
                    if (saferMoveCell(c, a.move, a.paths)) |safer| action = .{ .kind = .move, .move = safer, .paths = a.paths };
                }
                if (!engaged and eng.total_ranged >= 2 and eng.total_ranged > eng.total_melee and dest_threats >= 2 and eng.engaged_melee == 0) return null;
            }
        }
    }
    if (action) |a| action = preferBackstabAttackCell(c, a);
    return action;
}

// ---- Mountain (BLOCK_CENTER) strategy (ai.ts) ----

/// GROUP_REGROUP_DIST
pub const GROUP_REGROUP_DIST: f64 = 4;

/// teamRangedFirepower: the sum of remaining shots x max(1, max damage) over the team's living RANGE units.
pub fn teamRangedFirepower(s: *const State, team: u8) f64 {
    var firepower: f64 = 0;
    for (s.units[0..s.n_units]) |*u| {
        if (!u.in_holder or u.team != team or u.isDead() or u.attack_type != AT.RANGE) continue;
        const shots = engine.getRangeShots(u);
        if (shots <= 0) continue;
        firepower += shots * @max(1, u.attack_damage_max);
    }
    return firepower;
}

/// mountainHitsLeft: the classic hit counters on BLOCK_CENTER (6 all game on a scattered board), else 0.
pub fn mountainHitsLeft(s: *const State) i32 {
    if (s.fight.grid_type != st.GridType.BLOCK_CENTER) return 0;
    return terrain.hitsLeft(s);
}

pub const MountainStrike = struct { from: Cell, target: Cell };

/// findMountainMeleeStrike: the cheapest landable stand cell (in place first at weight 0, then knownPaths in
/// insertion order, strictly cheaper wins) whose ANCHOR touches a standing obstacle cell, with the first such cell
/// in getCenterCells order. The move path is the decision's actual path (the same getMovePath arguments).
pub fn findMountainMeleeStrike(c: *Ctx) ?MountainStrike {
    const s = c.s;
    var outer: terrain.CenterCells = undefined;
    terrain.centerCells(s, &outer);
    if (outer.len == 0) return null;
    const unit_cell = engine.baseCell(c.unit());
    const mp = c.actualPath();
    var best: ?MountainStrike = null;
    var best_weight: f64 = 0;
    const Consider = struct {
        fn f(ctx: *const Ctx, cells: []const Cell, stand: Cell, weight: f64, b: *?MountainStrike, bw: *f64) void {
            if (!canLandAt(ctx.s, ctx.ui, stand)) return;
            for (cells) |oc| {
                if (@abs(stand.x - oc.x) <= 1 and @abs(stand.y - oc.y) <= 1) {
                    if (b.* == null or weight < bw.*) {
                        b.* = .{ .from = stand, .target = oc };
                        bw.* = weight;
                    }
                    break;
                }
            }
        }
    };
    Consider.f(c, outer.slice(), unit_cell, 0, &best, &best_weight);
    for (mp.known()) |r| Consider.f(c, outer.slice(), r.cell, r.weight, &best, &best_weight);
    return best;
}

/// evaluateMountainStrategy: an otherwise idle, unpressed melee unit strikes the mountain, in place always, after a
/// move only when its team out-ranges the enemy or its melee is grouped.
pub fn evaluateMountainStrategy(c: *Ctx, eng: *const Engagement) ?AIAction {
    const s = c.s;
    const u = c.unit();
    if (mountainHitsLeft(s) <= 0) return null;
    // canMove() is true in scope; a live forced target (Aggr) must be fought first.
    if (u.attack_type == AT.RANGE or eng.pressing or combat.forcedTarget(s, u) != null) return null;
    if (eng.total_melee > 0 and eng.nearest_melee > GROUP_REGROUP_DIST and eng.engaged_melee == 0 and !eng.pressing) return null;
    const strike = findMountainMeleeStrike(c) orelse return null;
    const out_range = teamRangedFirepower(s, u.team) > teamRangedFirepower(s, engine.opposite(u.team));
    const in_place = sameCell(strike.from, engine.baseCell(u));
    if (!out_range and !in_place and !(eng.nearest_melee <= GROUP_REGROUP_DIST)) return null;
    return .{ .kind = .obstacle, .move = strike.from, .attack = strike.target, .paths = c.actualPath() };
}

/// isBackstabCell on the classic board: a LEFT attacker stands above the target, a RIGHT one below.
pub inline fn isBackstabCell(team: u8, from: Cell, target: Cell) bool {
    return isBackstabCellOn(team, from, target, false);
}

/// isBackstabCell along the axis of advance: y on the classic board, x on a side-oriented one (isSideAxisPolicyTeam;
/// no legacy-axis seats in scope).
pub inline fn isBackstabCellOn(team: u8, from: Cell, target: Cell, side: bool) bool {
    const along = if (side) from.x else from.y;
    const target_along = if (side) target.x else target.y;
    return if (team == Team.LEFT) along > target_along else along < target_along;
}

/// knownPaths.get((x << 4) | y) with JavaScript's int32 key, which an off-board cell can alias onto a real one.
pub fn routeAtJsKey(mp: *const MovePath, x: i32, y: i32) ?*const Route {
    const k: i32 = (x * 16) | y;
    if (k < 0 or k > 255) return null;
    return mp.get(@intCast(k));
}

/// preferBackstabAttackCell (ai.ts): a small Backstab unit striking a small enemy moves to the cheapest reachable
/// cell on the target's far side, when there is one.
pub fn preferBackstabAttackCell(c: *Ctx, a: AIAction) AIAction {
    if (a.kind != .melee and a.kind != .move_and_melee) return a;
    const u = c.unit();
    if (!engine.isSmall(u) or !u.has(.backstab)) return a; // canMove() is true in scope
    const target_cell = a.attack orelse return a;
    const from = a.move orelse return a;
    const t = occupant(c.s, target_cell) orelse return a;
    if (!engine.isSmall(&c.s.units[t])) return a;
    const side = c.s.fight.side_oriented;
    if (isBackstabCellOn(u.team, from, target_cell, side)) return a;
    const unit_cell = engine.baseCell(u);
    const mp = c.actualPath(); // the same getMovePath arguments as the decision's actual path
    var best: ?Cell = null;
    var best_weight = INF;
    var dy: i32 = -1;
    while (dy <= 1) : (dy += 1) {
        var dx: i32 = -1;
        while (dx <= 1) : (dx += 1) {
            if (dx == 0 and dy == 0) continue;
            const cell = Cell{ .x = target_cell.x + dx, .y = target_cell.y + dy };
            if (!isBackstabCellOn(u.team, cell, target_cell, side)) continue;
            const weight = if (sameCell(cell, unit_cell)) 0 else (routeAtJsKey(mp, cell.x, cell.y) orelse continue).weight;
            if (weight < best_weight) {
                best_weight = weight;
                best = cell;
            }
        }
    }
    const b = best orelse return a;
    return .{ .kind = if (sameCell(b, unit_cell)) .melee else .move_and_melee, .move = b, .attack = target_cell, .paths = mp };
}

// =====================================================================================================================
// StrategyV0_1 (src/ai/versions/v0_1.ts)
// =====================================================================================================================

pub fn threat(u: *const Unit) f64 {
    return @max(1, u.attack_damage_max) * @max(1, u.amount_alive);
}

/// The sortByThreat comparator: higher threat first, then base y, then base x.
pub fn threatBefore(s: *const State, a: u8, b: u8) bool {
    const ta = threat(&s.units[a]);
    const tb = threat(&s.units[b]);
    if (ta != tb) return tb - ta < 0;
    const ca = engine.baseCell(&s.units[a]);
    const cb = engine.baseCell(&s.units[b]);
    if (ca.y != cb.y) return ca.y < cb.y;
    return ca.x < cb.x;
}

pub fn sortByThreat(s: *const State, list: *engine.UnitList) void {
    var i: usize = 1;
    while (i < list.len) : (i += 1) {
        const x = list.items[i];
        var j = i;
        while (j > 0 and threatBefore(s, x, list.items[j - 1])) : (j -= 1) list.items[j] = list.items[j - 1];
        list.items[j] = x;
    }
}

pub fn hasResponded(s: *const State, t: u8) bool {
    return s.units[t].responded or s.fight.replied & engine.unitBit(t) != 0;
}

/// preferRespondedMeleeTarget
pub fn preferRespondedTarget(s: *const State, ui: u8, current_id: u8, from_cells: []const Cell) ?u8 {
    var candidates: engine.UnitList = .{};
    for (s.units[0..s.n_units], 0..) |*t, i| {
        if (!t.in_holder or t.team == s.units[ui].team or !isLegalMeleeTarget(s, ui, @intCast(i))) continue;
        const tc = engine.unitCells(t);
        if (adjacent(from_cells, tc.slice())) candidates.push(@intCast(i));
    }
    var current: ?u8 = null;
    for (candidates.slice()) |t| if (t == current_id) {
        current = t;
    };
    if (current) |cur| {
        if (hasResponded(s, cur)) return cur;
    }
    var responded: engine.UnitList = .{};
    for (candidates.slice()) |t| {
        if (t != current_id and hasResponded(s, t)) responded.push(t);
    }
    sortByThreat(s, &responded);
    if (responded.len > 0) return responded.items[0];
    if (current) |cur| return cur;
    sortByThreat(s, &candidates);
    return if (candidates.len > 0) candidates.items[0] else null;
}

/// isLegalMoveRoute (+ engineReachesCell via the actual path's keys)
pub fn isLegalMoveRoute(c: *Ctx, target: Cell, mp: *const MovePath, r: *const Route) bool {
    const u = c.unit();
    if (!canLandAt(c.s, c.ui, target)) return false;
    var cells: [64]Cell = undefined;
    const len = mp.routeCells(r, &cells);
    if (len == 0 or !sameCell(cells[len - 1], target)) return false;
    const base = engine.baseCell(u);
    const travelled = if (sameCell(cells[0], base)) cells[1..len] else cells[0..len];
    const steps = engine.getSteps(u);
    const max_cells = @max(1, @ceil(steps));
    if (travelled.len == 0 or @as(f64, @floatFromInt(travelled.len)) > max_cells or !std.math.isFinite(r.weight) or r.weight < 0 or r.weight > steps + 1e-9) return false;
    var prev = base;
    for (travelled) |cell| {
        const dx = @abs(cell.x - prev.x);
        const dy = @abs(cell.y - prev.y);
        if (!engine.cellWithinGrid(cell) or (dx == 0 and dy == 0) or dx > 1 or dy > 1) return false;
        prev = cell;
    }
    return c.actualPath().get(pathing.key(target.x, target.y)) != null;
}

/// completeMoveWithAdjacentMelee
pub fn completeMoveWithMelee(c: *Ctx, mp: *const MovePath, r: *const Route, preferred: ?u8, out: *Decision) void {
    const s = c.s;
    const u = c.unit();
    const targets = footprintForAnchor(u, r.cell);
    for (targets.slice(), 0..) |t, i| out.targets[i] = t;
    const len = mp.routeCells(r, &out.path);
    const move = rec.Action{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..targets.len], .has_lava = r.has_lava } };

    var adjacent_enemies: engine.UnitList = .{};
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (!e.in_holder or e.team == u.team or !isLegalMeleeTarget(s, c.ui, @intCast(i))) continue;
        const ec = engine.unitCells(e);
        if (adjacent(targets.slice(), ec.slice())) adjacent_enemies.push(@intCast(i));
    }
    var target: ?u8 = null;
    if (preferred) |p| {
        for (adjacent_enemies.slice()) |e| if (e == p) {
            target = e;
        };
    }
    if (target == null and adjacent_enemies.len > 0) target = adjacent_enemies.items[0];
    const resolved = if (target) |t| preferRespondedTarget(s, c.ui, t, targets.slice()) else null;
    const victim = resolved orelse {
        out.push(move);
        return;
    };
    const prefix = meleePrefix(u);
    if (!isMeleeSelection(u.attack_type_selected) and prefix == null) {
        out.push(move);
        return;
    }
    if (prefix) |t| out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = t } });
    out.push(move);
    out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = victim, .attack_from = r.cell, .path = &.{} } });
}

pub fn idleTurn(c: *const Ctx, out: *Decision) void {
    out.push(.{ .end_turn = .{ .unit = c.ui, .reason = .manual } });
}

/// fallbackTurn
pub fn fallbackTurn(c: *Ctx, out: *Decision) void {
    out.n = 0;
    const s = c.s;
    const u = c.unit();
    const mp = c.actualPath();
    var enemies: engine.UnitList = .{};
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (e.in_holder and e.team != u.team and !e.isDead()) enemies.push(@intCast(i));
    }
    if (enemies.len == 0 or mp.size() == 0) return idleTurn(c, out);
    const base = engine.baseCell(u);
    var best: ?*const Route = null;
    var best_score: i32 = std.math.maxInt(i32);
    for (mp.known()) |*r| {
        const cell = r.cell;
        if (sameCell(cell, base)) continue;
        if (!canLandAt(s, c.ui, cell)) continue;
        if (!isLegalMoveRoute(c, cell, mp, r)) continue;
        var score: i32 = std.math.maxInt(i32);
        for (enemies.slice()) |e| {
            const ec = engine.baseCell(&s.units[e]);
            score = @min(score, @as(i32, @intCast(@abs(cell.x - ec.x) + @abs(cell.y - ec.y))));
        }
        if (score < best_score) {
            best_score = score;
            best = r;
        }
    }
    const b = best orelse return idleTurn(c, out);
    completeMoveWithMelee(c, mp, b, null, out);
}

/// isRangeShotLandable
pub fn rangeShotLandable(s: *const State, ui: u8, ti: u8, aim_cell: ?Cell, aim_side: u8) bool {
    const u = &s.units[ui];
    const t = &s.units[ti];
    if (!t.in_holder or t.isDead() or t.team == u.team) return false;
    if (!engine.canLandRangeAttack(s, u)) return false;
    const to = combat.aimEdge(s, u, t, aim_cell, aim_side) orelse return false;
    const hits = combat.evaluateRange(s, ui, u.pos_x, u.pos_y, to[0], to[1]);
    if (hits.len == 0) return false;
    const first = &s.units[hits.units[0]];
    if (first.isDead() or first.team == u.team) return false;
    // An Aggr'd shooter's first hit must be its live forced target.
    if (combat.forcedTarget(s, u)) |forced| return hits.units[0] == forced;
    return true;
}

/// findLegalRangeAttack
pub fn findLegalRangeAttack(c: *const Ctx, preferred: u8) ?rec.Action {
    const s = c.s;
    const u = c.unit();
    var order: engine.UnitList = .{};
    var has_preferred = false;
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (e.in_holder and e.team != u.team and !e.isDead() and i == preferred) has_preferred = true;
    }
    if (has_preferred) order.push(preferred);
    for (s.units[0..s.n_units], 0..) |*e, i| {
        if (!e.in_holder or e.team == u.team or e.isDead()) continue;
        if (has_preferred and i == preferred) continue;
        order.push(@intCast(i));
    }
    for (order.slice()) |t| {
        if (rangeShotLandable(s, c.ui, t, null, 0)) return .{ .range_attack = .{ .attacker = c.ui, .target = t } };
        const cells = engine.unitCells(&s.units[t]);
        for (cells.slice()) |cell| {
            for ([_]u8{ 0, 1, 2, 3 }) |side| {
                if (!combat.sideObservable(s, cell, side, u.team)) continue;
                if (rangeShotLandable(s, c.ui, t, cell, side)) {
                    return .{ .range_attack = .{ .attacker = c.ui, .target = t, .aim_cell = cell, .aim_side = side } };
                }
            }
        }
    }
    return null;
}

/// Builds unit `ui`'s decision context in place: the board matrix and the free-cell bitmap the melee layers read
/// (the two move paths are computed on demand). A Ctx is about 18 KB, so build it where it lives:
/// `var c: Ctx = undefined; initCtxInto(&c, s, ui);`.
pub fn initCtxInto(c: *Ctx, s: *State, ui: u8) void {
    c.s = s;
    c.ui = ui;
    c.m = pathing.buildMatrix(s);
    c.have_actual = false;
    c.prefer_responded = true;
    c.prefer_attack_over_mining = false;
    c.initFree();
}

/// initCtxInto by value (copies the context once; prefer initCtxInto in hot loops).
pub fn initCtx(s: *State, ui: u8) Ctx {
    var c: Ctx = undefined;
    initCtxInto(&c, s, ui);
    return c;
}

/// StrategyV0_1.decideTurn: builds the unit's decision context, then decideWith.
pub fn decideTurn(s: *State, ui: u8, out: *Decision) void {
    var c: Ctx = undefined;
    initCtxInto(&c, s, ui);
    decideWith(&c, out);
}

/// StrategyV0_1.decideTurn on an existing decision context (its matrix, free bitmap and any move paths already built).
pub fn decideWith(c: *Ctx, out: *Decision) void {
    out.* = .{};
    const s = c.s;
    const ui = c.ui;
    const u = c.unit();
    const a = findTarget(c) orelse return fallbackTurn(c, out);
    switch (a.kind) {
        .range => {
            if (!engine.possibleIncludes(u, AT.RANGE)) return fallbackTurn(c, out);
            const tc = a.attack orelse return fallbackTurn(c, out);
            const target = occupant(s, tc) orelse return fallbackTurn(c, out);
            const shot = findLegalRangeAttack(c, target) orelse return fallbackTurn(c, out);
            if (u.attack_type_selected != AT.RANGE) out.push(.{ .select_attack_type = .{ .unit = ui, .attack_type = AT.RANGE } });
            out.push(shot);
        },
        .melee, .move_and_melee => {
            const tc = a.attack orelse return fallbackTurn(c, out);
            const from = a.move orelse engine.baseCell(u);
            const target0 = occupant(s, tc) orelse return fallbackTurn(c, out);
            const from_cells = footprintForAnchor(u, from);
            const target = if (c.prefer_responded) (preferRespondedTarget(s, ui, target0, from_cells.slice()) orelse return fallbackTurn(c, out)) else target0;
            const t = &s.units[target];
            if (!isLegalMeleeTarget(s, ui, target)) return fallbackTurn(c, out);
            const tcells = engine.unitCells(t);
            if (!adjacent(from_cells.slice(), tcells.slice())) return fallbackTurn(c, out);
            const base = engine.baseCell(u);
            if (!sameCell(from, base)) {
                const mp = a.paths orelse return fallbackTurn(c, out);
                const r = mp.get(pathing.key(from.x, from.y)) orelse return fallbackTurn(c, out);
                if (!isLegalMoveRoute(c, from, mp, r)) return fallbackTurn(c, out);
                return completeMoveWithMelee(c, mp, r, target, out);
            }
            const prefix = meleePrefix(u);
            if (!isMeleeSelection(u.attack_type_selected) and prefix == null) return fallbackTurn(c, out);
            if (prefix) |pt| out.push(.{ .select_attack_type = .{ .unit = ui, .attack_type = pt } });
            out.push(.{ .melee_attack = .{ .attacker = ui, .target = target, .attack_from = from, .path = &.{} } });
        },
        .move => {
            const tc = a.move orelse return fallbackTurn(c, out);
            const mp = a.paths orelse return fallbackTurn(c, out);
            const r = mp.get(pathing.key(tc.x, tc.y)) orelse return fallbackTurn(c, out);
            if (!isLegalMoveRoute(c, tc, mp, r)) return fallbackTurn(c, out);
            completeMoveWithMelee(c, mp, r, null, out);
        },
        .obstacle => {
            // No select_attack_type prefix and no route legality check; no mindless ("AI Driven") unit in scope.
            const struck = a.attack orelse return fallbackTurn(c, out);
            const from = a.move orelse return fallbackTurn(c, out);
            const pos = engine.positionForCell(@floatFromInt(struck.x), @floatFromInt(struck.y));
            var len: usize = 0;
            var has_lava = false;
            if (!sameCell(from, engine.baseCell(u))) {
                const mp = a.paths orelse return fallbackTurn(c, out);
                const r = mp.get(pathing.key(from.x, from.y)) orelse return fallbackTurn(c, out);
                len = mp.routeCells(r, &out.path);
                if (len == 0) return fallbackTurn(c, out);
                has_lava = r.has_lava;
            }
            out.push(.{ .obstacle_attack = .{ .attacker = ui, .target_x = pos[0], .target_y = pos[1], .attack_from = from, .path = out.path[0..len], .has_lava = has_lava } });
        },
    }
}

// =====================================================================================================================
// The v0.1 match loop (runMatchInner)
// =====================================================================================================================

pub const StepKind = enum { apply, advance, decide };

/// Called after every engine call and decision, in recording order.
pub const Observer = struct {
    ctx: *anyopaque,
    step: *const fn (ctx: *anyopaque, kind: StepKind, action: rec.Action, r0: u32, s: *const State, ok: bool, events: []const rec.Event) bool,
};

pub const EndReason = enum { elimination, turn_cap, stuck, observer_stop, unsupported };

pub fn call(s: *State, action: rec.Action, kind: StepKind, obs: ?Observer, events: *engine.Events) struct { ok: bool, stop: bool } {
    const r0 = s.rng.state;
    events.len = 0;
    const ok = engine.apply(s, action, events);
    if (obs) |o| {
        if (!o.step(o.ctx, kind, action, r0, s, ok, events.slice())) return .{ .ok = ok, .stop = true };
    }
    return .{ .ok = ok, .stop = false };
}

/// Plays a whole battle from a start state (before start_fight) with v0.1 on both sides.
pub fn playMatch(s: *State, max_laps: i32, obs: ?Observer) EndReason {
    return playMatchWith(s, max_laps, obs, decideTurn);
}

/// The runMatchInner loop with `decide` choosing every turn (v0.1's `decideTurn`, or a later version's).
pub fn playMatchWith(s: *State, max_laps: i32, obs: ?Observer, decide: *const fn (*State, u8, *Decision) void) EndReason {
    var events: engine.Events = .{};
    if (call(s, .start_fight, .apply, obs, &events).stop) return .observer_stop;
    var decision: Decision = .{};
    while (!s.fight.finished) {
        if (s.fight.lap > max_laps) return .turn_cap;
        if (s.active < 0) {
            var holder: usize = 0;
            for (s.units[0..s.n_units]) |*u| {
                if (u.in_holder) holder += 1;
            }
            const attempts = holder + 2;
            var i: usize = 0;
            while (i < attempts and !s.fight.finished and s.active < 0) : (i += 1) {
                const r = call(s, .{ .advance = .{ .damage_dealt_this_lap = s.damage_lap == s.fight.lap } }, .advance, obs, &events);
                if (r.stop) return .observer_stop;
                if (s.fight.finished or s.active >= 0) break;
                if (events.len == 0 and s.fight.up_next.len == 0) break;
            }
            if (s.fight.finished) break;
            if (s.active < 0) return .stuck; // forceStalledLap is not ported (never seen)
            continue;
        }
        const ui: u8 = @intCast(s.active);
        if (!s.units[ui].in_holder or s.units[ui].isDead()) {
            s.active = -1;
            continue;
        }
        const r0 = s.rng.state;
        decide(s, ui, &decision);
        if (obs) |o| {
            if (!o.step(o.ctx, .decide, .{ .decide = .{ .unit = ui, .out = decision.slice() } }, r0, s, true, &.{})) return .observer_stop;
        }
        var did_something = false;
        for (decision.slice()) |a| {
            const r = call(s, a, .apply, obs, &events);
            if (r.stop) return .observer_stop;
            if (r.ok and a != .select_attack_type) did_something = true;
            if (s.fight.finished) break;
        }
        if (!s.fight.finished and s.active == ui and !did_something) return .unsupported; // recovery net not ported
        if (!s.fight.finished and s.active == ui) {
            const r = call(s, .{ .end_turn = .{ .unit = ui, .reason = .manual } }, .apply, obs, &events);
            if (r.stop) return .observer_stop;
            if (!r.ok) s.active = -1;
        }
    }
    return .elimination;
}
