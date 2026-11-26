//! The v0.1 AI (src/ai/versions/v0_1.ts StrategyV0_1.decideTurn and src/ai/ai.ts findTarget) and the v0.1 match
//! loop (runMatchInner in src/simulation/battle_engine.ts), in scope: the abilities in abilities.zig (the AI reads
//! only Backstab), no spells; NORMAL, LAVA_CENTER and BLOCK_CENTER grids (the mountain strategy), classic or
//! side-oriented boards.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const artifacts = @import("artifacts.zig");
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
    /// The decision runs with a DecisionPathCatalog (SearchDriver's rollout turns), which lets findTarget build only
    /// the distance-one melee layer of its infinite-path pass (canElideUnconsumedMeleeLayers). The two differ only
    /// when a layer-one route weighs 0: a vine strider's free road. Set from `catalog_decisions` by initCtxInto.
    elide_melee_layers: bool = false,
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
            // The fight's vines, and hasAbilityActive("In Its Own World") (every AI getMovePath passes it).
            .vines = if (self.s.fight.n_vines != 0) &self.s.fight.vine_cells else null,
            .vine_stride = u.ability_mask & st.AbilityId.in_its_own_world.bit() != 0 and u.has(.in_its_own_world),
            .made_of_fire = artifacts.canTraverseLava(self.s, u),
        };
    }

    pub fn actualPath(self: *Ctx) *const MovePath {
        if (!self.have_actual) {
            pathing.getMovePath(&self.m, self.params(engine.getSteps(self.unit())), &self.actual);
            if (self.actual.overflow) self.s.overflow = true;
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
            if (o != st.EMPTY and o != ui + 1 and !(o == st.LAVA and artifacts.canTraverseLava(s, u))) return false;
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

/// canSelectMeleeTarget (ai.ts): a living enemy that is not Hidden, the live forced target only while the unit is
/// Aggr'd, and not a stronger enemy (cumulative hp) while the unit carries Cowardice. The Terrifying Gaze lock is not
/// read here (findTarget keeps the gazer).
pub fn canSelectMeleeTarget(s: *const State, ui: u8, t: u8) bool {
    const target = &s.units[t];
    if (target.isDead() or target.team == s.units[ui].team) return false;
    if (s.disguise and target.isHidden()) return false;
    if (combat.forcedTarget(s, &s.units[ui])) |f| {
        if (f != t) return false;
    }
    return !engine.cowardBarred(s, &s.units[ui], target);
}

/// isLegalMeleeTargetAtHp (v0_1.ts): canSelectMeleeTarget's checks on a holder unit (the forced target read the same
/// way: present and alive), and not the gazer that frightened the unit (cannotAttackUnitId).
pub fn isLegalMeleeTarget(s: *const State, ui: u8, t: u8) bool {
    return s.units[t].in_holder and !s.forbids(&s.units[ui], s.units[t].uid) and canSelectMeleeTarget(s, ui, t);
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

/// findRangeAttackAction (ai.ts): the best enemy cell in a y-major scan by 1 / divisor (an active Sniper ignores the
/// bands and the range), a splash shooter scoring its splash (countAOESplashValue) and skipping the stone and screen
/// tests, a Through Shot holder the enemies beyond (countEnemiesBeyondInLine) and skipping the screen test; strict
/// improvement only, so the first best cell wins.
pub fn findRangeAttackAction(c: *Ctx) ?AIAction {
    const s = c.s;
    const u = c.unit();
    if (engine.getRangeShots(u) <= 0) return null;
    // A shooter inside an enemy's Range Null Field, or under Rangebane, cannot fire: no target, no memory write.
    if (engine.nullFielded(s, u) or engine.rangebaned(s, u)) return null;
    const unit_cell = engine.baseCell(u);
    const enemy: i8 = @intCast(engine.opposite(u.team));
    const body = engine.unitCells(u);
    const aoe = combat.isSplashShooter(u);
    const through = u.has(.through_shot);
    const double = combat.doubleShotAbility(u) != null;
    const sniper = u.ability_mask & st.AbilityId.sniper.bit() != 0 and u.has(.sniper);
    const shot_distance = u.shot_distance;
    if (shot_distance <= 0 and !sniper) return null;
    const band = if (std.math.isFinite(shot_distance) and shot_distance > 0) @floor(shot_distance) else 0;
    // ignoresDistancePenalty: an active Sniper or Farsight Quiver lifts the range cut-off and the falloff score.
    const ignores = sniper or artifacts.farsight(u);
    const max_range = if (ignores) INF else band * 4;
    var best: ?Cell = null;
    var best_score: f64 = -1;
    var y: i32 = 0;
    while (y < st.GRID) : (y += 1) {
        var x: i32 = 0;
        while (x < st.GRID) : (x += 1) {
            if (mat(&c.m, x, y) != enemy) continue;
            const t = Cell{ .x = x, .y = y };
            const d: f64 = @floatFromInt(@max(@abs(t.x - unit_cell.x), @abs(t.y - unit_cell.y)));
            if (!ignores and d > max_range) continue;
            if (!aoe and lineBlockedByObstacle(&c.m, unit_cell, t)) continue;
            if (!aoe and !through and lineBlockedByFriendly(&c.m, unit_cell, t, u.team, body.slice())) continue;
            // A Hidden enemy can never be the shot's primary target.
            if (s.disguise) {
                if (occupant(s, t)) |o| {
                    if (s.units[o].isHidden()) continue;
                }
            }
            var divisor: f64 = 1;
            if (!ignores and band > 0) {
                var dd = d;
                while (dd > band) {
                    dd -= band;
                    divisor *= 2;
                }
                if (divisor > 8) divisor = 8;
            }
            var score = 1 / divisor;
            if (aoe) {
                const splash = aoeSplashValue(&c.m, t, enemy, @intCast(u.team));
                score *= @as(f64, @floatFromInt(splash.enemies)) + 1;
                if (splash.allies > 0) score *= js.max(0.1, 1 - 0.3 * @as(f64, @floatFromInt(splash.allies)));
            }
            if (through) score *= 1 + @as(f64, @floatFromInt(enemiesBeyondInLine(&c.m, unit_cell, t, enemy))) * 0.5;
            if (double) score *= 2;
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

/// countAOESplashValue (ai.ts): the enemy and ally units around a target cell on the matrix alone. The target cells are
/// the cell and each of its (-1,0), (0,-1), (-1,-1) neighbours holding the same value (the cell itself listed twice); the
/// splash is the union of their on-board 8-neighbourhoods minus the target cells, in insertion order of packed keys
/// (x << 4) | y; enemy and ally cells are then counted once per "2x2" (a counted cell marks its (-1,0), (0,-1),
/// (-1,-1) keys).
pub fn aoeSplashValue(m: *const Matrix, target: Cell, enemy: i8, ally: i8) struct { enemies: u32, allies: u32 } {
    var targets: [5]Cell = undefined;
    var n_targets: usize = 1;
    targets[0] = target;
    var target_keys: [4]u64 = .{ 0, 0, 0, 0 };
    const Key = struct {
        inline fn of(x: i32, y: i32) u8 {
            return @intCast((x << 4) | y);
        }
        inline fn mark(set: *[4]u64, k: u8) void {
            set[k >> 6] |= @as(u64, 1) << @intCast(k & 63);
        }
        inline fn has(set: *const [4]u64, k: i32) bool {
            if (k < 0 or k > 255) return false;
            const kk: u8 = @intCast(k);
            return set[kk >> 6] & (@as(u64, 1) << @intCast(kk & 63)) != 0;
        }
    };
    Key.mark(&target_keys, Key.of(target.x, target.y));
    const tv = mat(m, target.x, target.y);
    if (tv != 0) {
        for ([_][2]i32{ .{ 0, 0 }, .{ -1, 0 }, .{ 0, -1 }, .{ -1, -1 } }) |d| {
            const nx = target.x + d[0];
            const ny = target.y + d[1];
            if (nx >= 0 and ny >= 0 and nx < st.GRID and ny < st.GRID and mat(m, nx, ny) == tv) {
                targets[n_targets] = .{ .x = nx, .y = ny };
                n_targets += 1;
                Key.mark(&target_keys, Key.of(nx, ny));
            }
        }
    }
    var check: [64]u8 = undefined;
    var n_check: usize = 0;
    var in_check: [4]u64 = .{ 0, 0, 0, 0 };
    for (targets[0..n_targets]) |tc| {
        var dy: i32 = -1;
        while (dy <= 1) : (dy += 1) {
            var dx: i32 = -1;
            while (dx <= 1) : (dx += 1) {
                if (dx == 0 and dy == 0) continue;
                const nx = tc.x + dx;
                const ny = tc.y + dy;
                if (nx < 0 or ny < 0 or nx >= st.GRID or ny >= st.GRID) continue;
                const k = Key.of(nx, ny);
                if (Key.has(&target_keys, k) or Key.has(&in_check, k)) continue;
                Key.mark(&in_check, k);
                check[n_check] = k;
                n_check += 1;
            }
        }
    }
    var enemy_cells: [64]u8 = undefined;
    var n_enemy: usize = 0;
    var enemy_set: [4]u64 = .{ 0, 0, 0, 0 };
    var ally_cells: [64]u8 = undefined;
    var n_ally: usize = 0;
    var ally_set: [4]u64 = .{ 0, 0, 0, 0 };
    for (check[0..n_check]) |k| {
        const v = mat(m, @intCast(k >> 4), @intCast(k & 0xf));
        if (v == 0) continue;
        if (v == enemy) {
            enemy_cells[n_enemy] = k;
            n_enemy += 1;
            Key.mark(&enemy_set, k);
        } else if (v == ally) {
            ally_cells[n_ally] = k;
            n_ally += 1;
            Key.mark(&ally_set, k);
        }
    }
    const Dedupe = struct {
        fn count(cells: []const u8, set: *const [4]u64) u32 {
            var counted: [4]u64 = .{ 0, 0, 0, 0 };
            var n: u32 = 0;
            for (cells) |k| {
                if (Key.has(&counted, k)) continue;
                n += 1;
                Key.mark(&counted, k);
                const cx: i32 = k >> 4;
                const cy: i32 = k & 0xf;
                for ([_][2]i32{ .{ -1, 0 }, .{ 0, -1 }, .{ -1, -1 } }) |d| {
                    const nx = cx + d[0];
                    const ny = cy + d[1];
                    // JavaScript's ((nx << 4) | ny) of a negative coordinate is negative: it never matches.
                    if (nx < 0 or ny < 0) continue;
                    const nk = (nx << 4) | ny;
                    if (Key.has(set, nk)) Key.mark(&counted, @intCast(nk));
                }
            }
            return n;
        }
    };
    return .{ .enemies = Dedupe.count(enemy_cells[0..n_enemy], &enemy_set), .allies = Dedupe.count(ally_cells[0..n_ally], &ally_set) };
}

/// countEnemiesBeyondInLine (ai.ts): from the target cell on, `len` steps of (dx, dy) / len (f64, Math.round per axis)
/// until the board edge, counting enemy-team cells.
pub fn enemiesBeyondInLine(m: *const Matrix, from: Cell, target: Cell, enemy: i8) u32 {
    const dx: f64 = @floatFromInt(target.x - from.x);
    const dy: f64 = @floatFromInt(target.y - from.y);
    const len_i = @max(@abs(target.x - from.x), @abs(target.y - from.y));
    if (len_i == 0) return 0;
    const len: f64 = @floatFromInt(len_i);
    const sx = dx / len;
    const sy = dy / len;
    var count: u32 = 0;
    var cx_f = @as(f64, @floatFromInt(target.x)) + sx;
    var cy_f = @as(f64, @floatFromInt(target.y)) + sy;
    var i: u32 = 0;
    while (i < len_i) : (i += 1) {
        const rx = js.round(cx_f);
        const ry = js.round(cy_f);
        if (rx < 0 or ry < 0 or rx >= st.GRID or ry >= st.GRID) break;
        if (mat(m, @intFromFloat(rx), @intFromFloat(ry)) == enemy) count += 1;
        cx_f += sx;
        cy_f += sy;
    }
    return count;
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
    for (s.holderOrder()) |i| {
        const a = &s.units[i];
        if (a.team != u.team or i == c.ui or a.isDead()) continue;
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
    if (c.infinite.overflow) c.s.overflow = true;
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
                // buildFirstMeleeTargetLayers under a catalog: the first layer only.
                const max_depth: i32 = if (c.elide_melee_layers) 1 else 7;
                var depth: i32 = 0;
                while (depth < max_depth) : (depth += 1) {
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
                            // A No Melee unit repositions toward the actual-path target instead.
                            if (u.has(.no_melee)) return .{ .kind = .move, .move = unit_cell, .paths = mp };
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
    // A RANGE No Melee unit (Tsar Cannon) moves toward the closest target instead of striking it.
    if (u.attack_type == AT.RANGE and u.has(.no_melee)) {
        if (occupant(s, target_cell)) |o| s.ai_prev_target[c.ui] = @intCast(o);
        var move: ?Cell = null;
        if (result) |r| {
            if (used_infinite and result_index != null) {
                const len = c.infinite.routeCells(routeOf(c, r), &route_cells);
                const ri: usize = @intCast(result_index.?);
                if (ri < len) move = route_cells[ri];
            } else move = routeOf(c, r).cell;
        }
        return .{ .kind = .move, .move = move, .paths = c.actualPath() };
    }
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
    // A No Melee unit still draws its pick above, but builds no melee strike from it.
    if (selected) |e| if (!u.has(.no_melee)) {
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
    };
    if (action == null and u.attack_type == AT.RANGE and engine.getRangeShots(u) > 0) action = findRangeAttackAction(c);

    const eng = analyzeEngagement(c);
    const ranged = u.attack_type == AT.RANGE;
    const engaged = countThreats(&c.m, unit_cell, enemy_team) > 0;

    // A web-locked flyer (canMove false) takes no movement branch: it strikes in place, shoots, or falls back.
    if (action == null and !ranged and u.canMove() and !engaged) {
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
    } else if (action == null and u.canMove()) {
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
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.team != team or u.isDead() or u.attack_type != AT.RANGE) continue;
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
    // A live forced target (Aggr) must be fought first.
    if (u.attack_type == AT.RANGE or !u.canMove() or eng.pressing or combat.forcedTarget(s, u) != null) return null;
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
    if (!engine.isSmall(u) or !u.has(.backstab) or !u.canMove()) return a;
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
    for (s.holderOrder()) |i| {
        const t = &s.units[i];
        if (t.team == s.units[ui].team or !isLegalMeleeTarget(s, ui, i)) continue;
        const tc = engine.unitCells(t);
        if (adjacent(from_cells, tc.slice())) candidates.push(i);
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
    const max_cells = engine.maxCellsForStepBudget(c.s, u); // maxCellsForStepBudget: a vine strider's board bound
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
    if (u.has(.no_melee)) return out.push(move);

    var adjacent_enemies: engine.UnitList = .{};
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team == u.team or !isLegalMeleeTarget(s, c.ui, i)) continue;
        const ec = engine.unitCells(e);
        if (adjacent(targets.slice(), ec.slice())) adjacent_enemies.push(i);
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

/// idleTurn: an ordinary unit ends its turn; a mindless one ("AI Driven", Break-aware) waits when canWaitOnHourglass
/// passes, else defends.
pub fn idleTurn(c: *const Ctx, out: *Decision) void {
    const u = c.unit();
    if (!u.has(.ai_driven)) return out.push(.{ .end_turn = .{ .unit = c.ui, .reason = .manual } });
    if (engine.canWaitOnHourglass(c.s, c.ui)) return out.push(.{ .wait_turn = .{ .unit = c.ui } });
    out.push(.{ .defend_turn = .{ .unit = c.ui } });
}

/// fallbackTurn
pub fn fallbackTurn(c: *Ctx, out: *Decision) void {
    out.n = 0;
    const s = c.s;
    const u = c.unit();
    if (!u.canMove()) return idleTurn(c, out);
    const mp = c.actualPath();
    var enemies: engine.UnitList = .{};
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team != u.team and !e.isDead()) enemies.push(i);
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

/// advanceTowardEnemyAction (src/simulation/turn_recovery.ts), the recovery net's move: for a unit that can move and has
/// a living enemy, getMovePath with the unit's own footprint, steps, flight, lava traversal and vine stride, then among
/// the destinations (knownPaths order) other than its base cell where it can land, the first with the smallest
/// Manhattan distance to an enemy's base cell; written as one move_unit into `out` (its path and targets live there).
/// False when there is no such move. No draw (getMovePath draws nothing in scope).
pub noinline fn advanceTowardEnemy(s: *State, ui: u8, out: *Decision) bool {
    out.n = 0;
    const u = &s.units[ui];
    if (!u.canMove()) return false;
    const enemy_team = if (u.team == Team.LEFT) Team.RIGHT else Team.LEFT;
    var enemies: engine.UnitList = .{};
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team == enemy_team and !e.isDead()) enemies.push(i);
    }
    if (enemies.len == 0) return false;
    const m = pathing.buildMatrix(s);
    var mp: MovePath = undefined;
    pathing.getMovePath(&m, .{
        .start = engine.baseCell(u),
        .max_steps = engine.getSteps(u),
        .aggr = &s.grid.aggr[enemy_team],
        .can_fly = engine.canFly(u),
        .w = u.fw,
        .h = u.fh,
        .vines = if (s.fight.n_vines != 0) &s.fight.vine_cells else null,
        .vine_stride = u.ability_mask & st.AbilityId.in_its_own_world.bit() != 0 and u.has(.in_its_own_world),
        .made_of_fire = artifacts.canTraverseLava(s, u),
    }, &mp);
    if (mp.overflow) s.overflow = true;
    if (mp.size() == 0) return false;
    const base = engine.baseCell(u);
    var best: ?*const Route = null;
    var best_score: i32 = std.math.maxInt(i32);
    for (mp.known()) |*r| {
        if (sameCell(r.cell, base)) continue;
        if (!canLandAt(s, ui, r.cell)) continue;
        var score: i32 = std.math.maxInt(i32);
        for (enemies.slice()) |e| {
            const ec = engine.baseCell(&s.units[e]);
            score = @min(score, @as(i32, @intCast(@abs(r.cell.x - ec.x) + @abs(r.cell.y - ec.y))));
        }
        if (score < best_score) {
            best_score = score;
            best = r;
        }
    }
    const b = best orelse return false;
    const targets = footprintForAnchor(u, b.cell);
    for (targets.slice(), 0..) |t, i| out.targets[i] = t;
    const len = mp.routeCells(b, &out.path);
    out.push(.{ .move_unit = .{ .unit = ui, .path = out.path[0..len], .target_cells = out.targets[0..targets.len], .has_lava = b.has_lava } });
    return true;
}

/// isRangeShotLandable: the aim edge and the ray with the shooter's Through Shot and Large Caliber / Area Throw flags,
/// the ray's first hit a live legal enemy (Hidden only on a single-group ray; the live forced target), and a Cowardly
/// shooter (not a Through Shot) no weaker than it.
pub fn rangeShotLandable(s: *const State, ui: u8, ti: u8, aim_cell: ?Cell, aim_side: u8) bool {
    const u = &s.units[ui];
    const t = &s.units[ti];
    if (!t.in_holder or t.isDead() or t.team == u.team) return false;
    if ((s.disguise and t.isHidden()) or s.forbids(u, t.uid)) return false;
    if (!engine.canLandRangeAttack(s, u)) return false;
    const to = combat.aimEdge(s, u, t, aim_cell, aim_side) orelse return false;
    const through = u.has(.through_shot);
    const hits = combat.evaluateRangeFlags(s, ui, u.pos_x, u.pos_y, to[0], to[1], through, combat.isSplashShooter(u));
    if (hits.len == 0) return false;
    const first = &s.units[hits.units[0]];
    if (first.isDead() or first.team == u.team or s.forbids(u, first.uid)) return false;
    if (s.disguise and hits.len == 1 and first.isHidden()) return false;
    // An Aggr'd shooter's first hit must be its live forced target.
    if (combat.forcedTarget(s, u)) |forced| {
        if (hits.units[0] != forced) return false;
    }
    return through or !engine.cowardBarred(s, u, first);
}

/// findLegalRangeAttack
pub fn findLegalRangeAttack(c: *const Ctx, preferred: u8) ?rec.Action {
    const s = c.s;
    const u = c.unit();
    var order: engine.UnitList = .{};
    var has_preferred = false;
    // The candidates: living enemies that are not Hidden and not the gazer that frightened the shooter.
    const Candidate = struct {
        fn ok(st_: *const State, shooter: *const Unit, e: *const Unit) bool {
            return e.team != shooter.team and !e.isDead() and !(st_.disguise and e.isHidden()) and !st_.forbids(shooter, e.uid);
        }
    };
    for (s.holderOrder()) |i| {
        if (Candidate.ok(s, u, &s.units[i]) and i == preferred) has_preferred = true;
    }
    if (has_preferred) order.push(preferred);
    for (s.holderOrder()) |i| {
        if (!Candidate.ok(s, u, &s.units[i])) continue;
        if (has_preferred and i == preferred) continue;
        order.push(i);
    }
    const through = u.has(.through_shot);
    const ignores = combat.isSplashShooter(u);
    for (order.slice()) |t| {
        if (rangeShotLandable(s, c.ui, t, null, 0)) return .{ .range_attack = .{ .attacker = c.ui, .target = t } };
        const cells = engine.unitCells(&s.units[t]);
        for (cells.slice()) |cell| {
            for ([_]u8{ 0, 1, 2, 3 }) |side| {
                if (!combat.sideObservableEx(s, cell, side, u.team, through, ignores)) continue;
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
/// Decisions on this thread run as SearchDriver's rollout turns do, with a DecisionPathCatalog (rollout.run sets it;
/// runMatch's decisions without search have none).
pub threadlocal var catalog_decisions: bool = false;

pub fn initCtxInto(c: *Ctx, s: *State, ui: u8) void {
    c.s = s;
    c.ui = ui;
    c.m = pathing.buildMatrix(s);
    c.have_actual = false;
    c.prefer_responded = true;
    c.prefer_attack_over_mining = false;
    c.elide_melee_layers = catalog_decisions;
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
            // findTarget can hand a melee to a unit that cannot strike (a No Melee shooter boxed in): reposition instead.
            if (u.has(.no_melee)) return fallbackTurn(c, out);
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
            if (!sameCell(from, base) and !u.canMove()) return fallbackTurn(c, out);
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
            if (!u.canMove()) return fallbackTurn(c, out);
            const mp = a.paths orelse return fallbackTurn(c, out);
            const r = mp.get(pathing.key(tc.x, tc.y)) orelse return fallbackTurn(c, out);
            if (!isLegalMoveRoute(c, tc, mp, r)) return fallbackTurn(c, out);
            completeMoveWithMelee(c, mp, r, null, out);
        },
        .obstacle => {
            // A mindless ("AI Driven") unit never mines: it charges instead (findTarget's side effects stand).
            if (u.has(.ai_driven)) return fallbackTurn(c, out);
            // No select_attack_type prefix and no route legality check.
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

/// Called after every engine call and decision, in recording order; `stall` (optional) when the loop ran forceStalledLap
/// (between engine calls: the next advance follows it).
pub const Observer = struct {
    ctx: *anyopaque,
    step: *const fn (ctx: *anyopaque, kind: StepKind, action: rec.Action, r0: u32, s: *const State, ok: bool, events: []const rec.Event) bool,
    stall: ?*const fn (ctx: *anyopaque, s: *const State) void = null,
};

pub const EndReason = enum { elimination, turn_cap, stuck, observer_stop, unsupported };

/// One engine call (`action` names slots); the observer sees the action with its units named by uid (engine.actionToUids,
/// taken before the call: a slot can change hands during it), as recordings name them.
pub fn call(s: *State, action: rec.Action, kind: StepKind, obs: ?Observer, events: *engine.Events) struct { ok: bool, stop: bool } {
    const r0 = s.rng.state;
    events.len = 0;
    const named = if (obs != null) engine.actionToUids(s, action) else action;
    const ok = engine.apply(s, action, events);
    if (obs) |o| {
        if (!o.step(o.ctx, kind, named, r0, s, ok, events.slice())) return .{ .ok = ok, .stop = true };
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
    return continueMatchWith(s, max_laps, obs, decide);
}

/// One decision of unit `ui` into `decision`, reported to the observer (units named by uid). True when the observer
/// stops the loop.
fn decideStep(s: *State, ui: u8, decide: *const fn (*State, u8, *Decision) void, decision: *Decision, obs: ?Observer) bool {
    const r0 = s.rng.state;
    decide(s, ui, decision);
    if (obs) |o| {
        var named: [3]rec.Action = undefined;
        for (decision.slice(), 0..) |a, k| named[k] = engine.actionToUids(s, a);
        const d = rec.Action{ .decide = .{ .unit = s.units[ui].uid, .out = named[0..decision.n] } };
        if (!o.step(o.ctx, .decide, d, r0, s, true, &.{})) return true;
    }
    return false;
}

/// The runMatchInner loop after start_fight, from any point it reaches: a fight start, or a battle loaded mid-fight
/// (snapshot.zig) at a decision boundary (`State.active` set, its decision not taken) or with no active unit.
/// runMatch's advance(): at most holder + 2 advanceAfterNoActiveUnit calls until a unit is active, the fight ends, or a
/// call changes nothing. True when the observer stopped the loop.
fn advanceAttempts(s: *State, obs: ?Observer, events: *engine.Events) bool {
    const attempts = @as(usize, s.n_holder) + 2;
    var i: usize = 0;
    while (i < attempts and !s.fight.finished and s.active < 0) : (i += 1) {
        const r = call(s, .{ .advance = .{ .damage_dealt_this_lap = s.damage_lap == s.fight.lap } }, .advance, obs, events);
        if (r.stop) return true;
        if (s.fight.finished or s.active >= 0) break;
        if (events.len == 0 and s.fight.up_next.len == 0) break;
    }
    return false;
}

pub fn continueMatchWith(s: *State, max_laps: i32, obs: ?Observer, decide: *const fn (*State, u8, *Decision) void) EndReason {
    var events: engine.Events = .{};
    var decision: Decision = .{};
    while (!s.fight.finished) {
        if (s.fight.lap > max_laps) return .turn_cap;
        if (s.active < 0) {
            if (advanceAttempts(s, obs, &events)) return .observer_stop;
            if (s.fight.finished) break;
            if (s.active < 0) {
                // The queue stalled with the fight live (a run of skipped activations): forceStalledLap marks every
                // living unit as having made its turn, and a fresh advance() flips the lap.
                if (engine.forceStalledLap(s)) {
                    if (obs) |o| {
                        if (o.stall) |f| f(o.ctx, s);
                    }
                    if (advanceAttempts(s, obs, &events)) return .observer_stop;
                }
                if (s.fight.finished) break;
                if (s.active < 0) return .stuck;
            }
            continue;
        }
        const ui: u8 = @intCast(s.active);
        if (!s.units[ui].in_holder or s.units[ui].isDead()) {
            s.active = -1;
            continue;
        }
        // isMindlessAiUnit, read at the turn's start (runMatch's mindlessUnit).
        const mindless = s.units[ui].has(.ai_driven);
        if (decideStep(s, ui, decide, &decision, obs)) return .observer_stop;
        var did_something = false;
        for (decision.slice()) |a| {
            const r = call(s, a, .apply, obs, &events);
            if (r.stop) return .observer_stop;
            if (r.ok and a != .select_attack_type) did_something = true;
            if (s.fight.finished) break;
        }
        if (!s.fight.finished and s.active == ui and !did_something) {
            // The recovery net: a mindless unit decides once more with its pinned policy and applies what it can
            // (runMatch's "v0.1_retry"); any other unit takes advanceTowardEnemyAction, else defends.
            if (mindless) {
                if (decideStep(s, ui, decide, &decision, obs)) return .observer_stop;
                for (decision.slice()) |a| {
                    if (s.fight.finished or s.active != ui) break;
                    const r = call(s, a, .apply, obs, &events);
                    if (r.stop) return .observer_stop;
                }
            } else {
                var advanced = false;
                if (advanceTowardEnemy(s, ui, &decision)) {
                    const r = call(s, decision.actions[0], .apply, obs, &events);
                    if (r.stop) return .observer_stop;
                    advanced = r.ok;
                }
                if (!advanced and !s.fight.finished and s.active == ui) {
                    const r = call(s, .{ .defend_turn = .{ .unit = ui } }, .apply, obs, &events);
                    if (r.stop) return .observer_stop;
                }
            }
        }
        if (!s.fight.finished and s.active == ui) {
            const r = call(s, .{ .end_turn = .{ .unit = ui, .reason = .manual } }, .apply, obs, &events);
            if (r.stop) return .observer_stop;
            if (!r.ok) s.active = -1;
        }
    }
    return .elimination;
}
