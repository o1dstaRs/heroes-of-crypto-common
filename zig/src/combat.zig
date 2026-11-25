//! Melee and ranged attacks: GameActionEngine.meleeAttack / rangeAttack and the AttackHandler paths they take
//! in scope (the abilities in abilities.zig, no spells, NORMAL grid).

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const abilities = @import("abilities.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
const AT = st.AttackType;
const Events = engine.Events;
const Reject = error{Rejected};

// =====================================================================================================================
// Damage (Unit.calculateAttackDamage and the damage chain)
// =====================================================================================================================

fn damageBound(att: *const Unit, tgt: *const Unit, dmg: f64, is_range: bool, divisor_in: f64) f64 {
    const rate = engine.getAttack(att);
    const armor = if (is_range) engine.getRangeArmor(tgt) else engine.getArmor(tgt);
    const divisor = if (divisor_in <= 0) 1 else divisor_in;
    const luck = engine.getLuck(tgt);
    return @max(1, @ceil(((((dmg * rate * att.amount_alive) / armor) * (1 - luck / 100)) / divisor) * att.attack_multiplier * 1));
}

/// Unit.calculateAttackDamage. A ranged roll spends the attacker's shot before rolling; the ability multiplier is
/// applied after the roll (resolveAttackDamageChain / applyAttackDamageChain).
fn calculateAttackDamage(s: *State, att: *Unit, tgt: *const Unit, attack_type: u8, divisor: f64, ability_multiplier: f64) f64 {
    const is_range = attack_type == AT.RANGE;
    const lo = damageBound(att, tgt, att.attack_damage_min, is_range, divisor);
    const hi = damageBound(att, tgt, att.attack_damage_max, is_range, divisor);
    const by_melee = attack_type == AT.MELEE or attack_type == AT.MELEE_MAGIC;
    const type_mult: f64 = if (by_melee and att.attack_type == AT.RANGE) 0.5 else 1;
    if (!by_melee and is_range) {
        if (engine.getRangeShots(att) <= 0) return 0;
        // decreaseNumberOfShots
        att.range_shots -= 1;
        if (att.range_shots < 0) att.range_shots = 0;
        att.range_shots = @floor(att.range_shots);
    }
    const roll: f64 = @floatFromInt(s.rng.int(@intFromFloat(lo), @intFromFloat(hi)));
    return @floor(roll * type_mult * ability_multiplier * 1 * 1);
}

/// processLuckyStrikeAbility: a chance to multiply the rolled damage.
fn luckyStrike(s: *State, u: *const Unit, damage: f64) f64 {
    const a = u.ability(.lucky_strike) orelse return damage;
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) < abilities.applyChance(u, a)) {
        return @floor(damage * abilities.abilityMultiplier(u, a));
    }
    return damage;
}

/// The miss roll: `getRandomInt(0, 100) < attacker.calculateMissChance(target)`.
inline fn missRoll(s: *State, att: *const Unit, tgt: *const Unit) bool {
    return @as(f64, @floatFromInt(s.rng.int(0, 100))) < abilities.missChance(att, tgt);
}

// =====================================================================================================================
// Morale bookkeeping shared by both attacks
// =====================================================================================================================

/// The `moraleDecreaseForTheUnitTeam` record: "<name>:<team>" keys in insertion order.
const MoraleDecrease = struct {
    keys: [4]struct { name: u16, team: u8, amount: f64 } = undefined,
    len: u8 = 0,

    fn add(self: *MoraleDecrease, u: *const Unit, amount: f64) void {
        if (amount <= 0) return;
        for (self.keys[0..self.len]) |*k| {
            if (k.name == u.name_id and k.team == u.team) {
                k.amount += amount;
                return;
            }
        }
        self.keys[self.len] = .{ .name = u.name_id, .team = u.team, .amount = amount };
        self.len += 1;
    }

    /// UnitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam
    fn apply(self: *const MoraleDecrease, s: *State) void {
        for (self.keys[0..self.len]) |k| {
            for (s.units[0..s.n_units]) |*u| {
                if (u.in_holder and u.team == k.team and u.name_id == k.name) engine.changeMorale(u, k.amount, false);
            }
        }
    }
};

const Died = struct {
    items: [4]u8 = undefined,
    len: u8 = 0,

    fn includes(self: *const Died, u: u8) bool {
        for (self.items[0..self.len]) |x| if (x == u) return true;
        return false;
    }
    fn push(self: *Died, u: u8) void {
        if (!self.includes(u)) {
            self.items[self.len] = u;
            self.len += 1;
        }
    }
};

/// processOneInTheFieldAbility: the reply is spent.
inline fn spendReply(s: *State, ui: u8) void {
    s.fight.replied |= engine.unitBit(ui);
    s.units[ui].responded = true;
}

/// GameActionEngine.cleanupDeadUnits
fn cleanupDeadUnits(s: *State, died: *const Died, events: *Events) void {
    for (died.items[0..died.len]) |ui| {
        const u = &s.units[ui];
        if (!u.in_holder or !u.isDead()) continue;
        engine.deleteUnit(s, ui);
        events.push(.unit_destroyed, ui);
    }
}

fn adjacent(a: []const Cell, b: []const Cell) bool {
    for (a) |c1| {
        for (b) |c2| {
            const dx = @abs(c1.x - c2.x);
            const dy = @abs(c1.y - c2.y);
            if ((dx == 1 and dy == 0) or (dx == 0 and dy == 1) or (dx == 1 and dy == 1)) return true;
        }
    }
    return false;
}

// =====================================================================================================================
// Melee
// =====================================================================================================================

pub fn meleeAttack(s: *State, ai: u8, ti: u8, from: Cell, path: []const Cell, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    if (!s.units[ti].in_holder) return error.Rejected;
    // Move-then-strike (a `path`) is never produced by v0.1; without a path the strike must be stationary.
    if (path.len != 0) return error.Rejected;

    const att = &s.units[ai];
    const tgt = &s.units[ti];
    if (att.isDead() or tgt.isDead()) return error.Rejected;
    if (att.attack_type_selected != AT.MELEE and att.attack_type_selected != AT.MELEE_MAGIC) return error.Rejected;
    if (att.team == tgt.team) return error.Rejected;
    const current = engine.baseCell(att);
    const from_cells = engine.cellsForAnchor(from, att.fw, att.fh);
    const tgt_cells = engine.unitCells(tgt);
    if (!adjacent(from_cells.slice(), tgt_cells.slice())) return error.Rejected;
    if (current.x != from.x or current.y != from.y) return error.Rejected;
    // Stationary strike: the occupancy checks pass on the unit's own cells and setPosition writes the same value.

    // chargedRouteCells: a stationary strike after this turn's move charges that move's route (no knownPaths
    // provider in the simulation, so a strike without one leaves the multiplier at 1).
    var ability_multiplier: f64 = 1;
    if (att.moved_this_turn and att.moved_route_cells > 0) ability_multiplier = abilities.rapidCharge(att, att.moved_route_cells);
    ability_multiplier *= abilities.positionMultiplier(att, from, engine.baseCell(tgt), tgt.fh);

    const missed = missRoll(s, att, tgt);
    att.attack_mod = @max(0, att.attack_mod); // cleanupAttackModIncrease (+0)
    const damage_from_attack = luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.MELEE, 1, ability_multiplier)) +
        abilities.penetratingBite(att, tgt);

    // The response lands first.
    meleeResponse(s, ai, ti, from);
    if (!missed and !tgt.isDead()) {
        _ = engine.applyDamage(tgt, damage_from_attack);
        s.damage_lap = s.fight.lap;
        meleeRiders(s, ai, ti);
    }
    engine.refreshStackPowerForAllUnits(s);

    const punch = doublePunch(s, ai, ti);

    var died: Died = .{};
    var decrease: MoraleDecrease = .{};
    var attacker_plus: f64 = 0;
    var target_plus: f64 = 0;
    if (att.isDead() and !died.includes(ai)) {
        died.push(ai);
        target_plus += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(att, engine.MORALE_CHANGE_FOR_KILL);
    }
    if (tgt.isDead() and !died.includes(ti)) {
        died.push(ti);
        attacker_plus += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(tgt, engine.MORALE_CHANGE_FOR_KILL);
    } else if (punch.applied) {
        meleeResponse(s, ai, ti, from);
        if (punch.damage > 0) {
            _ = engine.applyDamage(tgt, punch.damage);
            s.damage_lap = s.fight.lap;
        }
        if (!punch.missed) meleeRiders(s, ai, ti);
        if (att.isDead() and !died.includes(ai)) {
            died.push(ai);
            target_plus += engine.MORALE_CHANGE_FOR_KILL;
            decrease.add(att, engine.MORALE_CHANGE_FOR_KILL);
        }
        if (tgt.isDead() and !died.includes(ti)) {
            died.push(ti);
            attacker_plus += engine.MORALE_CHANGE_FOR_KILL;
            decrease.add(tgt, engine.MORALE_CHANGE_FOR_KILL);
        }
    }
    engine.changeMorale(tgt, target_plus, true);
    engine.changeMorale(att, attacker_plus, true);
    decrease.apply(s);
    engine.refreshStackPowerForAllUnits(s);

    cleanupDeadUnits(s, &died, events);
    engine.completeTurn(s, ai, false, false, events);
}

/// The on-hit riders of a landed melee blow from `from_i` on `to_i`, in handleMeleeAttack's order (the ported ones:
/// Dulling Defense, Shatter Armor). The attacker is the active unit.
fn meleeRiders(s: *State, from_i: u8, to_i: u8) void {
    abilities.dullingDefense(&s.units[from_i], &s.units[to_i]);
    abilities.shatterArmor(s, from_i, to_i, from_i);
}

/// canUnitRespondToMelee (src/handlers/melee_response.ts)
fn canRespondToMelee(s: *const State, att: *const Unit, ti: u8) bool {
    const tgt = &s.units[ti];
    return !abilities.skipsResponse(att) and !tgt.responded and s.fight.replied & engine.unitBit(ti) == 0;
}

/// handleMeleeAttack's captureResponse: the target strikes back once (its reply is spent even on a miss).
fn meleeResponse(s: *State, ai: u8, ti: u8, from: Cell) void {
    const att = &s.units[ai];
    const tgt = &s.units[ti];
    if (tgt.isDead() or !canRespondToMelee(s, att, ti)) return;
    const missed = missRoll(s, tgt, att);
    if (!missed and !att.isDead()) {
        const ability_multiplier = abilities.positionMultiplier(tgt, engine.baseCell(tgt), from, att.fh);
        const damage_from_response = luckyStrike(s, tgt, calculateAttackDamage(s, tgt, att, AT.MELEE, 1, ability_multiplier)) +
            abilities.penetratingBite(tgt, att);
        _ = engine.applyDamage(att, damage_from_response);
        s.damage_lap = s.fight.lap;
        // The responder's riders (Shatter Armor rides only the attacker's blows).
        abilities.dullingDefense(tgt, att);
    }
    spendReply(s, ti);
}

const Punch = struct { applied: bool = false, missed: bool = false, damage: f64 = 0 };

/// processDoublePunchAbility: a second strike with its own miss roll.
fn doublePunch(s: *State, ai: u8, ti: u8) Punch {
    const att = &s.units[ai];
    const tgt = &s.units[ti];
    const a = att.ability(.double_punch) orelse return .{};
    if (att.isDead() or tgt.isDead()) return .{};
    if (missRoll(s, att, tgt)) return .{ .applied = true, .missed = true };
    const ability_multiplier = abilities.abilityMultiplier(att, a);
    const damage = luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.MELEE, 1, ability_multiplier)) +
        abilities.penetratingBite(att, tgt);
    return .{ .applied = true, .damage = damage };
}

// =====================================================================================================================
// Line of fire (src/grid/ray_traversal.ts) and ranged evaluation
// =====================================================================================================================

const INF = std.math.inf(f64);

inline fn axisDisplacement(axis: f64, major: f64, step: f64) f64 {
    if (axis == 0) return 0;
    return @floor((2 * step * axis + major - 1) / (2 * major));
}

inline fn firstStepForDisplacement(required: f64, axis: f64, major: f64) f64 {
    if (axis == 0) return INF;
    return @max(0, @ceil((2 * major * required - major + 1) / (2 * axis)));
}

inline fn firstStepOutsideCell(start: f64, dir: f64, axis: f64, major: f64, cell_index: f64, origin: f64) f64 {
    if (axis == 0) return INF;
    const boundary = origin + (if (dir > 0) cell_index + 1 else cell_index) * engine.CELL;
    const first = if (dir > 0) @ceil(boundary) else @ceil(boundary) - 1;
    const required = if (dir > 0) first - start else start - first;
    return firstStepForDisplacement(required, axis, major);
}

const RayHit = struct { cell: Cell, x: f64, y: f64 };

const Ray = struct {
    items: [64]RayHit = undefined,
    len: usize = 0,
};

/// traceGridRayCells: every cell the segment crosses, with the first pixel in it.
fn traceRay(sx_in: f64, sy_in: f64, ex_in: f64, ey_in: f64) Ray {
    var ray: Ray = .{};
    const sx = js.round(sx_in);
    const sy = js.round(sy_in);
    const ex = js.round(ex_in);
    const ey = js.round(ey_in);
    const dx = @abs(ex - sx);
    const dy = @abs(ey - sy);
    const major = @max(dx, dy);
    const dir_x: f64 = if (sx < ex) 1 else -1;
    const dir_y: f64 = if (sy < ey) 1 else -1;
    if (major == 0) {
        ray.items[0] = .{ .cell = engine.cellForPosition(sx, sy), .x = sx, .y = sy };
        ray.len = 1;
        return ray;
    }
    var seen: [64]u32 = undefined;
    var n_seen: usize = 0;
    var have_prev = false;
    var prev_x: i32 = 0;
    var prev_y: i32 = 0;
    var step: f64 = 0;
    while (step <= major) {
        const px = sx + dir_x * axisDisplacement(dx, major, step);
        const py = sy + dir_y * axisDisplacement(dy, major, step);
        const cxf = @floor((px + engine.MAX_X) / engine.CELL);
        const cyf = @floor(py / engine.CELL);
        const cx: i32 = @intFromFloat(cxf);
        const cy: i32 = @intFromFloat(cyf);
        if (!have_prev or cx != prev_x or cy != prev_y) {
            const key = (@as(u32, @bitCast(cx)) << 4) | @as(u32, @bitCast(cy));
            var found = false;
            for (seen[0..n_seen]) |k| if (k == key) {
                found = true;
            };
            if (!found and ray.len < ray.items.len) {
                ray.items[ray.len] = .{ .cell = .{ .x = cx, .y = cy }, .x = px, .y = py };
                ray.len += 1;
                seen[n_seen] = key;
                n_seen += 1;
            }
            have_prev = true;
            prev_x = cx;
            prev_y = cy;
        }
        const nx = firstStepOutsideCell(sx, dir_x, dx, major, cxf, -engine.MAX_X);
        const ny = firstStepOutsideCell(sy, dir_y, dy, major, cyf, 0);
        const next = @min(nx, ny);
        if (!std.math.isFinite(next) or next > major) break;
        step = if (next > step) next else step + 1;
    }
    return ray;
}

/// getShotCellDistance: Chebyshev cells from the shooter's footprint to the target cell.
fn shotCellDistance(ax: f64, ay: f64, w: u8, h: u8, tx: f64, ty: f64) f64 {
    const tc = engine.cellForPosition(tx, ty);
    const t = engine.positionForCell(@floatFromInt(tc.x), @floatFromInt(tc.y));
    const hfx = ((@as(f64, @floatFromInt(w)) - 1) / 2) * engine.CELL;
    const hfy = ((@as(f64, @floatFromInt(h)) - 1) / 2) * engine.CELL;
    const dx = @abs(t[0] - ax) - hfx;
    const dy = @abs(t[1] - ay) - hfy;
    return @max(0, js.round(@max(dx, dy) / engine.CELL));
}

/// AttackHandler.getRangeAttackDivisor
fn rangeDivisor(att: *const Unit, hx: f64, hy: f64, ax: f64, ay: f64) f64 {
    var divisor: f64 = 1;
    const band = if (att.shot_distance > 0 and std.math.isFinite(att.shot_distance)) @floor(att.shot_distance) else 0;
    if (band > 0) {
        var away = shotCellDistance(ax, ay, att.fw, att.fh, hx, hy);
        while (away > band) {
            away -= band;
            divisor *= 2;
        }
    }
    if (divisor < 1) divisor = 1;
    if (divisor > 8) divisor = 8;
    return @floor(divisor);
}

pub const Hits = struct {
    units: [st.MAX_UNITS]u8 = undefined,
    divisors: [st.MAX_UNITS]f64 = undefined,
    len: u8 = 0,
};

/// evaluateRangeAttack -> getAffectedUnitsAndObstacles: each living enemy on the ray, in ray order.
pub fn evaluateRange(s: *const State, from_ui: u8, fx: f64, fy: f64, tx: f64, ty: f64) Hits {
    var hits: Hits = .{};
    const from = &s.units[from_ui];
    const ray = traceRay(fx, fy, tx, ty);
    for (ray.items[0..ray.len]) |h| {
        if (!engine.cellWithinGrid(h.cell)) continue;
        const o = s.grid.board[@intCast(h.cell.x)][@intCast(h.cell.y)];
        if (o == st.EMPTY or o == st.HOLE) continue;
        const ui: u8 = o - 1;
        if (ui == from_ui) continue;
        var seen = false;
        for (hits.units[0..hits.len]) |x| if (x == ui) {
            seen = true;
        };
        if (seen) continue;
        const u = &s.units[ui];
        if (!u.in_holder or u.isDead()) continue;
        if (u.team == from.team) continue;
        hits.units[hits.len] = ui;
        hits.divisors[hits.len] = rangeDivisor(from, h.x, h.y, fx, fy);
        hits.len += 1;
    }
    return hits;
}

/// isRangeAttackSideObservable: the neighbour across that side is empty, a hole, off the board, or the shooter's own team.
pub fn sideObservable(s: *const State, cell: Cell, side: u8, from_team: u8) bool {
    const n: Cell = switch (side) {
        0 => .{ .x = cell.x - 1, .y = cell.y },
        1 => .{ .x = cell.x + 1, .y = cell.y },
        2 => .{ .x = cell.x, .y = cell.y - 1 },
        else => .{ .x = cell.x, .y = cell.y + 1 },
    };
    if (!engine.cellWithinGrid(n)) return true;
    const o = s.grid.board[@intCast(n.x)][@intCast(n.y)];
    if (o == st.EMPTY or o == st.HOLE) return true;
    return s.units[o - 1].team == from_team;
}

/// getRangeAttackSideCenter
fn sideCenter(cell: Cell, side: u8, ax: f64, ay: f64) [2]f64 {
    const c = engine.positionForCell(@floatFromInt(cell.x), @floatFromInt(cell.y));
    var p: [2]f64 = switch (side) {
        0 => .{ c[0] - engine.HALF, c[1] },
        1 => .{ c[0] + engine.HALF, c[1] },
        2 => .{ c[0], c[1] - engine.HALF },
        else => .{ c[0], c[1] + engine.HALF },
    };
    if (p[0] < ax) p[0] -= 1;
    if (p[1] < ay) p[1] -= 1;
    return p;
}

/// resolveRangeAttackAimEdge: the requested edge if it is observable, else the nearest observable edge
/// (first wins ties; order = target cells x [LEFT, RIGHT, DOWN, UP]).
pub fn aimEdge(s: *const State, att: *const Unit, tgt: *const Unit, aim_cell: ?Cell, aim_side: u8) ?[2]f64 {
    const cells = engine.unitCells(tgt);
    if (aim_cell) |ac| {
        for (cells.slice()) |c| {
            if (c.x == ac.x and c.y == ac.y and aim_side < 4 and sideObservable(s, c, aim_side, att.team)) {
                return sideCenter(c, aim_side, att.pos_x, att.pos_y);
            }
        }
    }
    var best: ?[2]f64 = null;
    var best_d: f64 = 0;
    for (cells.slice()) |c| {
        for ([_]u8{ 0, 1, 2, 3 }) |side| {
            if (!sideObservable(s, c, side, att.team)) continue;
            const p = sideCenter(c, side, att.pos_x, att.pos_y);
            const d = engine.distance(att.pos_x, att.pos_y, p[0], p[1]);
            if (best == null or d < best_d) {
                best = p;
                best_d = d;
            }
        }
    }
    return best;
}

/// AttackHandler.canBeAttackedByMelee
pub fn pinnedByMelee(s: *const State, u: *const Unit) bool {
    const aggr = engine.enemyAggr(s, u);
    const cells = engine.cellsForPosition(u.pos_x, u.pos_y, u.fw, u.fh);
    for (cells.slice()) |c| {
        if (!engine.cellWithinGrid(c)) continue;
        if (aggr[@intCast(c.x)][@intCast(c.y)] > 1) return true;
    }
    return false;
}

// =====================================================================================================================
// Ranged
// =====================================================================================================================

pub fn rangeAttack(s: *State, ai: u8, ti: u8, aim_cell: ?Cell, aim_side: u8, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    const att = &s.units[ai];
    if (att.moved_this_turn) return error.Rejected;
    const declared = &s.units[ti];
    if (!declared.in_holder or declared.isDead()) return error.Rejected;
    const to = aimEdge(s, att, declared, aim_cell, aim_side) orelse return error.Rejected;
    const hits = evaluateRange(s, ai, att.pos_x, att.pos_y, to[0], to[1]);

    var response_divisor: f64 = 1;
    var response_victim: ?u8 = null;
    if (hits.len > 0) {
        const primary = &s.units[hits.units[0]];
        if (engine.isRangeCapable(primary) and engine.getRangeShots(primary) > 0 and !pinnedByMelee(s, primary)) {
            const back = evaluateRange(s, hits.units[0], primary.pos_x, primary.pos_y, att.pos_x, att.pos_y);
            if (back.len > 0) {
                response_divisor = back.divisors[0];
                response_victim = back.units[0];
            }
        }
    }

    // resolveRangeAttack
    if (att.isDead() or hits.len == 0) return error.Rejected;
    if (att.attack_type_selected != AT.RANGE or !engine.canLandRangeAttack(s, att)) return error.Rejected;
    var target_ui = hits.units[0];
    var tgt = &s.units[target_ui];
    if (tgt.team == att.team or tgt.isDead()) return error.Rejected;
    var idx: usize = 1;

    const missed = missRoll(s, att, tgt);
    var responder_target: ?u8 = null;
    var response_missed = false;
    if (response_victim) |rv| {
        if (!abilities.skipsResponse(att) and s.fight.replied & engine.unitBit(target_ui) == 0 and engine.canLandRangeAttack(s, tgt)) {
            response_missed = missRoll(s, tgt, &s.units[rv]);
            responder_target = rv;
        }
    }
    // A missed shot rolls no damage and spends no arrow.
    const damage_from_attack = if (missed) 0 else luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.RANGE, hits.divisors[0], 1));

    var died: Died = .{};
    var decrease: MoraleDecrease = .{};
    var attacker_plus: f64 = 0;
    var target_plus: f64 = 0;

    if (responder_target) |rv| {
        const victim = &s.units[rv];
        if (!response_missed) {
            const damage_from_response = luckyStrike(s, tgt, calculateAttackDamage(s, tgt, victim, AT.RANGE, response_divisor, 1));
            _ = engine.applyDamage(victim, damage_from_response);
            s.damage_lap = s.fight.lap;
        }
        spendReply(s, target_ui);
    }

    if (!missed) {
        _ = engine.applyDamage(tgt, damage_from_attack);
        s.damage_lap = s.fight.lap;
    }
    var switch_target = false;
    if (tgt.isDead()) {
        if (!died.includes(target_ui)) {
            died.push(target_ui);
            attacker_plus += engine.MORALE_CHANGE_FOR_KILL;
            decrease.add(tgt, engine.MORALE_CHANGE_FOR_KILL);
        }
        switch_target = true;
    }

    done: {
        if (responder_target) |rv| {
            const victim = &s.units[rv];
            if (victim.isDead()) {
                if (!died.includes(rv)) {
                    died.push(rv);
                    decrease.add(victim, engine.MORALE_CHANGE_FOR_KILL);
                    if (!tgt.isDead()) target_plus += engine.MORALE_CHANGE_FOR_KILL;
                }
                if (rv == ai) {
                    engine.changeMorale(att, attacker_plus, true);
                    engine.changeMorale(tgt, target_plus, true);
                    decrease.apply(s);
                    break :done;
                }
            }
        }

        engine.refreshStackPowerForAllUnits(s);

        if (switch_target) {
            var group: u8 = 0;
            while (idx < hits.len) {
                group = @intCast(idx);
                if (!s.units[hits.units[idx]].isDead()) break;
                idx += 1;
            }
            const previous = target_ui;
            target_ui = hits.units[group];
            tgt = &s.units[target_ui];
            if (previous != target_ui) engine.changeMorale(tgt, target_plus, true);
            if (tgt.team == att.team or tgt.isDead()) {
                if (tgt.isDead()) died.push(target_ui);
                engine.changeMorale(att, attacker_plus, true);
                decrease.apply(s);
                break :done;
            }
        }

        if (tgt.isDead() and !died.includes(target_ui)) {
            died.push(target_ui);
            attacker_plus += engine.MORALE_CHANGE_FOR_KILL;
            decrease.add(tgt, engine.MORALE_CHANGE_FOR_KILL);
        }
        engine.changeMorale(att, attacker_plus, true);
        decrease.apply(s);
        engine.refreshStackPowerForAllUnits(s);
    }

    cleanupDeadUnits(s, &died, events);
    engine.completeTurn(s, ai, false, false, events);
}
