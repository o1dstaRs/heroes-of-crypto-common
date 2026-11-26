//! The Zig engine: battle start state, and `apply` for each top-level engine call.
//!
//! Every function names the TypeScript it mirrors. Scope: the abilities in abilities.zig, the augments and synergies
//! runMatch's setup applies (and the Chaos Break), no spells or artifacts; the NORMAL, LAVA_CENTER and BLOCK_CENTER
//! grids, classic or side-oriented (terrain.zig). See zig/README.md.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const combat = @import("combat.zig");
const abilities = @import("abilities.zig");
const terrain = @import("terrain.zig");
const pathing = @import("path.zig");
const spells = @import("spells.zig");
const artifacts = @import("artifacts.zig");
const Rng = @import("rng.zig").Rng;

const Cell = st.Cell;
const Unit = st.Unit;
const State = st.State;
const Team = st.Team;
const AT = st.AttackType;

// ---- constants (src/constants.ts, grid settings) ----
pub const MIN_X: f64 = -1024;
pub const MAX_X: f64 = 1024;
pub const MIN_Y: f64 = 0;
pub const MAX_Y: f64 = 2048;
pub const CELL: f64 = 128;
pub const HALF: f64 = 64;
pub const MORALE_MAX: f64 = 20;
pub const LUCK_MAX: f64 = 10;
pub const LUCK_MAX_CHANGE_FOR_TURN: i64 = 3;
pub const LUCK_CHANGE_FOR_SHIELD: f64 = 3;
pub const MORALE_CHANGE_FOR_DISTANCE: f64 = 3;
pub const MORALE_CHANGE_FOR_SHIELD: f64 = 2;
pub const MORALE_CHANGE_FOR_CLOCK: f64 = 3;
pub const MORALE_CHANGE_FOR_SKIP: f64 = 1;
pub const MORALE_CHANGE_FOR_KILL: f64 = 4;
pub const STEPS_MORALE_MULTIPLIER: f64 = 0.05;
pub const NUMBER_OF_LAPS_TILL_STOP_NARROWING: i32 = 12;
pub const NUMBER_OF_LAPS_FIRST_ARMAGEDDON: i32 = 12;
pub const NUMBER_OF_ARMAGEDDON_WAVES: i32 = 4;
pub const MAX_HOLE_LAYERS: i32 = 5;
pub const MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE: f64 = 75;
const MAX_SAFE_INTEGER: f64 = 9007199254740991;

pub const Events = struct {
    items: [96]rec.Event = undefined,
    len: usize = 0,

    pub fn push(self: *Events, kind: rec.EventKind, arg: i32) void {
        if (self.len < self.items.len) {
            self.items[self.len] = .{ .kind = kind, .arg = arg };
            self.len += 1;
        }
    }
    pub fn slice(self: *const Events) []const rec.Event {
        return self.items[0..self.len];
    }
};

// =====================================================================================================================
// Geometry (src/grid/grid_math.ts)
// =====================================================================================================================

pub const Cells = struct {
    items: [4]Cell = undefined,
    len: u8 = 0,

    pub fn push(self: *Cells, c: Cell) void {
        self.items[self.len] = c;
        self.len += 1;
    }
    pub fn slice(self: *const Cells) []const Cell {
        return self.items[0..self.len];
    }
};

pub inline fn cellWithinGrid(c: Cell) bool {
    return c.x >= 0 and c.x < st.GRID and c.y >= 0 and c.y < st.GRID;
}

pub inline fn positionWithinGrid(x: f64, y: f64) bool {
    return x >= MIN_X and x < MAX_X and y >= MIN_Y and y < MAX_Y;
}

/// getCellForPosition
pub inline fn cellForPosition(x: f64, y: f64) Cell {
    return .{ .x = @intFromFloat(@floor((x + MAX_X) / CELL)), .y = @intFromFloat(@floor(y / CELL)) };
}

/// getPositionForCell
pub inline fn positionForCell(cx: f64, cy: f64) [2]f64 {
    return .{ MIN_X + (1 + cx) * CELL - HALF, cy * CELL + HALF };
}

/// getPositionForCells (undefined -> null)
pub fn positionForCells(cells: []const Cell) ?[2]f64 {
    if (cells.len == 1) return positionForCell(@floatFromInt(cells[0].x), @floatFromInt(cells[0].y));
    if (cells.len == 0) return null;
    var x0: i32 = std.math.maxInt(i32);
    var x1: i32 = std.math.minInt(i32);
    var y0: i32 = std.math.maxInt(i32);
    var y1: i32 = std.math.minInt(i32);
    for (cells) |c| {
        x0 = @min(x0, c.x);
        x1 = @max(x1, c.x);
        y0 = @min(y0, c.y);
        y1 = @max(y1, c.y);
    }
    if ((x1 - x0 + 1) * (y1 - y0 + 1) != @as(i32, @intCast(cells.len))) return null;
    const rx = @as(f64, @floatFromInt(x0)) + @as(f64, @floatFromInt(x1 - x0)) / 2;
    const ry = @as(f64, @floatFromInt(y0)) + @as(f64, @floatFromInt(y1 - y0)) / 2;
    return positionForCell(rx, ry);
}

/// getFootprintAnchorForCells: max x, max y.
pub fn anchorForCells(cells: []const Cell) Cell {
    var a = Cell{ .x = std.math.minInt(i32), .y = std.math.minInt(i32) };
    for (cells) |c| {
        if (c.x > a.x) a.x = c.x;
        if (c.y > a.y) a.y = c.y;
    }
    return a;
}

/// getFootprintCellsForAnchor (not clipped).
pub fn cellsForAnchor(anchor: Cell, w: u8, h: u8) Cells {
    var out: Cells = .{};
    if (w == 1 and h == 1) {
        out.push(anchor);
        return out;
    }
    var dx: i32 = 0;
    while (dx < w) : (dx += 1) {
        var dy: i32 = 0;
        while (dy < h) : (dy += 1) out.push(.{ .x = anchor.x - dx, .y = anchor.y - dy });
    }
    return out;
}

/// getCellsAroundPosition: the legacy 2x2 order.
pub fn cellsAroundPosition(x: f64, y: f64) Cells {
    var out: Cells = .{};
    const left = x > MIN_X;
    const right = x < MAX_X;
    const down = y > MIN_Y;
    const up = y < MAX_Y;
    const lx: i32 = if (left) @intFromFloat(@floor((x - HALF + MAX_X) / CELL)) else 0;
    const rx: i32 = if (right) @intFromFloat(@floor((x + HALF + MAX_X) / CELL)) else 0;
    const dy: i32 = if (down) @intFromFloat(@floor((y - HALF) / CELL)) else 0;
    const uy: i32 = if (up) @intFromFloat(@floor((y + HALF) / CELL)) else 0;
    if (left and up) out.push(.{ .x = lx, .y = uy });
    if (right and up) out.push(.{ .x = rx, .y = uy });
    if (down and left) out.push(.{ .x = lx, .y = dy });
    if (down and right) out.push(.{ .x = rx, .y = dy });
    return out;
}

/// getFootprintCellsForPosition: `Unit.getCells()`.
pub fn cellsForPosition(x: f64, y: f64, w: u8, h: u8) Cells {
    if (w == 2 and h == 2) return cellsAroundPosition(x, y);
    const anchor = cellForPosition(x, y);
    return cellsForAnchor(anchor, w, h);
}

pub inline fn unitCells(u: *const Unit) Cells {
    return cellsForPosition(u.pos_x, u.pos_y, u.fw, u.fh);
}

/// `Unit.getBaseCell()` (footprints up to 2 per side).
pub inline fn baseCell(u: *const Unit) Cell {
    return cellForPosition(u.pos_x, u.pos_y);
}

pub inline fn isSmall(u: *const Unit) bool {
    return u.fw == 1 and u.fh == 1;
}

/// getDistance
pub inline fn distance(ax: f64, ay: f64, bx: f64, by: f64) f64 {
    const dx = bx - ax;
    const dy = by - ay;
    return @sqrt(dx * dx + dy * dy);
}

// =====================================================================================================================
// Grid occupancy and threat boards (src/grid/grid.ts)
// =====================================================================================================================

inline fn occ(s: *const State, c: Cell) u8 {
    return s.grid.board[@intCast(c.x)][@intCast(c.y)];
}

inline fn setOcc(s: *State, c: Cell, v: u8) void {
    s.grid.board[@intCast(c.x)][@intCast(c.y)] = v;
}

/// stampAggrRing: the on-board 8-neighbourhood ring around the footprint, each ring cell once.
fn stampAggrRing(s: *State, team: u8, footprint: []const Cell, d: i16) void {
    if (footprint.len == 0 or team == 0) return;
    var in_fp: [st.GRID]u16 = .{0} ** st.GRID;
    for (footprint) |c| {
        if (cellWithinGrid(c)) in_fp[@intCast(c.x)] |= @as(u16, 1) << @intCast(c.y);
    }
    var seen: [st.GRID]u16 = .{0} ** st.GRID;
    for (footprint) |c| {
        var dx: i32 = -1;
        while (dx <= 1) : (dx += 1) {
            var dy: i32 = -1;
            while (dy <= 1) : (dy += 1) {
                if (dx == 0 and dy == 0) continue;
                const n = Cell{ .x = c.x + dx, .y = c.y + dy };
                if (!cellWithinGrid(n)) continue;
                const bit = @as(u16, 1) << @intCast(n.y);
                const xi: usize = @intCast(n.x);
                if (in_fp[xi] & bit != 0 or seen[xi] & bit != 0) continue;
                seen[xi] |= bit;
                s.grid.aggr[team][xi][@intCast(n.y)] += d;
            }
        }
    }
}

/// A cell a unit may take: empty, or lava for a unit that can traverse it (canOccupyLava = canTraverseLava()).
inline fn takeable(s: *const State, u: *const Unit, o: u8) bool {
    return o == st.EMPTY or (o == st.LAVA and artifacts.canTraverseLava(s, u));
}

/// What a vacated cell becomes: lava again for a centre cell of an undried LAVA_CENTER map (grid.ts occupyCell /
/// occupyCells), else empty. cleanupAll (a death) never restores it.
inline fn vacated(s: *const State, c: Cell) u8 {
    const t = &s.grid.terrain;
    if (s.fight.grid_type == st.GridType.LAVA_CENTER and !t.cleaned_up_center and c.x >= 6 and c.x < 10 and c.y >= 6 and c.y < 10) return st.LAVA;
    return st.EMPTY;
}

/// occupyCell (1x1 movers).
pub fn occupyCell(s: *State, ui: u8, cell: Cell) bool {
    if (!cellWithinGrid(cell)) return false;
    const u = &s.units[ui];
    if (!takeable(s, u, occ(s, cell))) return false;
    if (u.n_reg != 0 and u.n_reg != 1) return false;
    if (u.n_reg != 0) {
        const oc = u.reg[0];
        if (occ(s, oc) == ui + 1) {
            setOcc(s, oc, vacated(s, oc));
            stampAggrRing(s, u.team, &.{oc}, -1);
        }
    }
    setOcc(s, cell, ui + 1);
    stampAggrRing(s, u.team, &.{cell}, 1);
    u.reg[0] = cell;
    u.n_reg = 1;
    return true;
}

fn dedupCells(cells: []const Cell) Cells {
    var out: Cells = .{};
    outer: for (cells) |c| {
        for (out.slice()) |o| if (o.x == c.x and o.y == c.y) continue :outer;
        out.push(c);
    }
    return out;
}

/// occupyCells (multi-cell registration).
pub fn occupyCells(s: *State, ui: u8, cells: []const Cell) bool {
    if (cells.len == 0) return false;
    const u = &s.units[ui];
    for (cells) |c| {
        if (!cellWithinGrid(c)) return false;
        const o = occ(s, c);
        if (!takeable(s, u, o) and o != ui + 1) return false;
    }
    if (u.n_reg != 0) {
        const legacy = cells.len == 1 or cells.len == 4;
        if (if (legacy) u.n_reg != 4 else u.n_reg != cells.len) return false;
        const left = dedupCells(u.reg[0..u.n_reg]);
        for (left.slice()) |oc| {
            if (occ(s, oc) == ui + 1) setOcc(s, oc, vacated(s, oc));
        }
        stampAggrRing(s, u.team, left.slice(), -1);
    }
    const now = dedupCells(cells);
    for (now.slice()) |c| setOcc(s, c, ui + 1);
    stampAggrRing(s, u.team, now.slice(), 1);
    for (cells, 0..) |c, i| u.reg[i] = c;
    u.n_reg = @intCast(cells.len);
    return true;
}

/// cleanupAll (unit removal).
fn cleanupAll(s: *State, ui: u8) void {
    const u = &s.units[ui];
    if (u.n_reg == 0) return;
    for (u.reg[0..u.n_reg]) |oc| setOcc(s, oc, st.EMPTY);
    stampAggrRing(s, u.team, u.reg[0..u.n_reg], -1);
    u.n_reg = 0;
}

/// areAllCellsEmpty(cells, id) || canOccupyCells(cells, false, false, id): on board and empty or own.
pub fn cellsFreeFor(s: *const State, ui: u8, cells: []const Cell) bool {
    if (cells.len == 0) return false;
    const u = &s.units[ui];
    for (cells) |c| {
        if (!cellWithinGrid(c)) return false;
        const o = occ(s, c);
        if (!takeable(s, u, o) and o != ui + 1) return false;
    }
    return true;
}

pub inline fn enemyAggr(s: *const State, u: *const Unit) *const [st.GRID][st.GRID]i16 {
    return &s.grid.aggr[if (u.team == Team.LEFT) Team.RIGHT else Team.LEFT];
}

// =====================================================================================================================
// Unit getters (src/units/unit.ts)
// =====================================================================================================================

/// Unit.getMorale: the clamped stored morale, 0 under an active Madness or Mechanism.
pub inline fn getMorale(u: *const Unit) f64 {
    const m = js.round(u.morale);
    if (m > MORALE_MAX) return MORALE_MAX;
    if (m < -MORALE_MAX) return -MORALE_MAX;
    if (moraleLocked(u)) return 0;
    return m;
}

/// hasAbilityActive("Madness") || hasAbilityActive("Mechanism"): morale pinned at 0 (and hasMindAttackResistance).
pub inline fn moraleLocked(u: *const Unit) bool {
    return u.ability_mask & (st.AbilityId.madness.bit() | st.AbilityId.mechanism.bit()) != 0 and !u.isBroken();
}

/// hasDebuffActive(name) for one of Spit Ball's debuffs (every reader in scope reads the list; the display list is the
/// same names).
pub inline fn hasDebuff(u: *const Unit, id: st.SpellId) bool {
    return u.debuffs.len != 0 and u.debuffs.find(id) != null;
}

/// hasStatusApplied("Rangebane") on battles where Spit Ball can land it.
pub inline fn rangebaned(s: *const State, u: *const Unit) bool {
    return s.spit and hasDebuff(u, .rangebane);
}

/// hasStatusApplied("Cowardice") on battles where Spit Ball can land it.
pub inline fn cowardly(s: *const State, u: *const Unit) bool {
    return s.spit and hasDebuff(u, .cowardice);
}

/// Unit.getCumulativeHp: 0 when dead, else (alive - 1) * max_hp + max(hp, 0).
pub inline fn cumulativeHp(u: *const Unit) f64 {
    if (u.isDead()) return 0;
    const hp = if (u.hp < 0) 0 else u.hp;
    return (u.amount_alive - 1) * u.max_hp + hp;
}

/// The Cowardice gates: `u` carries Cowardice and has less cumulative hp than `other`. Only the flag and the list length
/// are inline (the AI's melee filters call it for every candidate).
pub inline fn cowardBarred(s: *const State, u: *const Unit, other: *const Unit) bool {
    return s.spit and u.debuffs.len != 0 and cowardBarredSlow(u, other);
}

noinline fn cowardBarredSlow(u: *const Unit, other: *const Unit) bool {
    return u.debuffs.find(.cowardice) != null and cumulativeHp(u) < cumulativeHp(other);
}

/// getDistanceToFurthestCorner (grid_math.ts): the largest distance to a board corner.
pub fn distanceToFurthestCorner(x: f64, y: f64) f64 {
    const a = distance(x, y, MIN_X, MIN_Y);
    const b = distance(x, y, MIN_X, MAX_Y);
    const c = distance(x, y, MAX_X, MIN_Y);
    const d = distance(x, y, MAX_X, MAX_Y);
    return js.max(js.max(js.max(a, b), c), d);
}

pub inline fn getLuck(u: *const Unit) f64 {
    return std.math.clamp(js.round(u.luck + u.luck_mod), -LUCK_MAX, LUCK_MAX);
}

pub inline fn getSteps(u: *const Unit) f64 {
    return u.steps + u.steps_mod;
}

pub inline fn getArmor(u: *const Unit) f64 {
    return @max(1, u.base_armor + u.armor_mod);
}

pub inline fn getRangeArmor(u: *const Unit) f64 {
    return @max(1, u.range_armor + u.armor_mod);
}

pub inline fn getAttack(u: *const Unit) f64 {
    return u.base_attack + u.attack_mod;
}

pub inline fn getRangeShots(u: *const Unit) f64 {
    return if (u.range_shots_mod != 0) u.range_shots_mod else u.range_shots;
}

pub inline fn isRangeCapable(u: *const Unit) bool {
    return u.attack_type == AT.RANGE or (getRangeShots(u) > 0 and u.shot_distance > 0);
}

/// Unit.getMagicResist: magic_resist_mod when set, else magic_resist.
pub inline fn getMagicResist(u: *const Unit) f64 {
    return if (u.magic_resist_mod != 0) u.magic_resist_mod else u.magic_resist;
}

pub inline fn getStackPower(u: *const Unit) f64 {
    return if (u.stack_power > 5) 5 else if (u.stack_power < 1) 1 else js.round(u.stack_power);
}

/// Unit.canFly: a flying creature that is not grounded.
pub inline fn canFly(u: *const Unit) bool {
    return u.movement_type == st.Movement.FLY and !grounded(u);
}

/// Unit.isGrounded's status test (GROUNDING_DEBUFFS = ["Gravebound", "Hamstrung"], unit.ts: Gravechain's debuff and the
/// Dryad's; hasStatusApplied reads the debuff list). The caller has checked isFlyingCreature.
pub inline fn grounded(u: *const Unit) bool {
    return u.debuffs.len != 0 and (u.debuffs.find(.gravebound) != null or u.debuffs.find(.hamstrung) != null);
}

pub inline fn hasMoraleBuff(u: *const Unit) bool {
    return u.buffs.find(.morale) != null;
}

pub inline fn hasDismorale(u: *const Unit) bool {
    return u.debuffs.find(.dismorale) != null;
}

pub inline fn opposite(team: u8) u8 {
    return if (team == Team.NO_TEAM) Team.NO_TEAM else if (team == Team.LEFT) Team.RIGHT else Team.LEFT;
}

/// increaseMorale / decreaseMorale: change the BASE morale, blocked under Madness or Mechanism, Morale, Sadness and
/// Dismorale.
pub fn changeMorale(u: *Unit, amount: f64, increase: bool) void {
    if (amount <= 0 or moraleLocked(u) or hasMoraleBuff(u) or hasDismorale(u) or hasDebuff(u, .sadness)) return;
    var m = if (increase) u.init.morale + amount else u.init.morale - amount;
    if (m > MORALE_MAX) m = MORALE_MAX;
    if (m < -MORALE_MAX) m = -MORALE_MAX;
    u.init.morale = m;
}

/// projectStackDamage, written into the unit: the applied damage, and whether creatures died with the stack alive.
fn projectStackDamage(u: *Unit, minus_hp: f64) struct { applied: f64, lost_and_survived: bool } {
    if (minus_hp < u.hp) {
        u.hp -= minus_hp;
        return .{ .applied = minus_hp, .lost_and_survived = false };
    }
    const front = u.hp;
    u.amount_died += 1;
    u.amount_alive -= 1;
    const remaining = minus_hp - front;
    u.hp = u.max_hp;
    const additional = @floor(remaining / u.max_hp);
    if (additional >= u.amount_alive) {
        u.amount_died += u.amount_alive;
        const were = u.amount_alive;
        u.amount_alive = 0;
        return .{ .applied = @floor(were * u.max_hp) + front, .lost_and_survived = false };
    }
    u.amount_died += additional;
    u.amount_alive -= additional;
    u.hp -= @rem(remaining, u.max_hp);
    return .{ .applied = remaining + front, .lost_and_survived = true };
}

/// Unit.applyDamage with no break chance (Armageddon, the poison tick): see applyDamageBreak.
pub fn applyDamage(s: *State, ui: u8, minus_hp: f64) f64 {
    return applyDamageBreak(s, ui, minus_hp, 0, false);
}

/// Unit.applyDamage(minusHp, chanceToBreak, sceneLog, extendBreak) (no Water Shield, Water Element or Last Fuse in
/// scope): an Ember Covenant ring absorbs the hit and dissolves its team's covenant; otherwise the break roll
/// (`chance` is the STRIKER's team getBreakChancePerTeam: drawn when it is positive and the unit is not already
/// Broken, or always when `extend`; an extended Break lasts a lap longer), the stack damage projection, then Bitter
/// Experience (+1 armor and step, live and initial, when creatures died and the stack survived). Returns the
/// applied damage.
pub fn applyDamageBreak(s: *State, ui: u8, minus_hp: f64, chance: f64, extend: bool) f64 {
    return applyDamageElement(s, ui, minus_hp, chance, extend, st.Element.UNSET);
}

/// Unit.applyDamage with a spell element (`damageElement`; st.Element.UNSET for a creature's hit): a covenant ring
/// blocks every hit but a WATER one (isEmberCovenantWaterHit; no Water Element attacker in scope), and a FIRE hit
/// leaves the ring standing (isEmberCovenantFireHit) where any other block dissolves the team's covenant.
pub fn applyDamageElement(s: *State, ui: u8, minus_hp: f64, chance: f64, extend: bool, element: u8) f64 {
    const u = &s.units[ui];
    if (minus_hp <= 0) return 0;
    // Only a covenant team's units carry the ring (seeded per team, removed team-wide when the team's bit clears).
    if (s.ember_teams != 0 and element != st.Element.WATER and abilities.absorbsHit(u)) {
        if (element != st.Element.FIRE) abilities.breakEmberCovenant(s, u.team); // notifyEmberCovenantDamage
        return 0;
    }
    if (chance > 0 and (extend or !u.isBroken())) {
        const roll: f64 = @floatFromInt(s.rng.int(0, 100)); // unit.ts:2133
        if (roll < @min(chance, 100)) {
            // effectFactory.makeEffect("Break"), Effect.extend, then Unit.applyEffect (delete by name, append)
            var laps = s.break_laps;
            if (extend and laps != st.LAPS_AURA and laps != st.NUMBER_OF_LAPS_TOTAL) laps += 1;
            abilities.replaceChecked(s, &u.effects, .{ .id = .break_, .laps = laps, .power = s.break_power });
        }
    }
    const r = projectStackDamage(u, minus_hp);
    if (r.applied > 0 and s.ember_teams != 0) abilities.breakEmberCovenant(s, u.team);
    if (r.lost_and_survived and u.has(.bitter_experience)) {
        u.base_armor += 1;
        u.init.base_armor += 1;
        u.steps += 1;
        u.init.steps += 1;
    }
    return r.applied;
}

// =====================================================================================================================
// Stat refresh (UnitsHolder.refreshStackPowerForAllUnits, Unit.adjustBaseStats)
// =====================================================================================================================

/// The first buff of an augment name (adjustBaseStats' statBuffs.get: a revive's orphan rows have no object), only on
/// battles that carry augments.
inline fn augmentBuff(s: *const State, u: *const Unit, id: st.SpellId) ?*const st.AppliedSpell {
    if (!s.augments) return null;
    return u.augment(id);
}

/// Unit.adjustBaseStats, with the team's synergy values (refreshStackPowerForAllUnits' per-team modifiers) and the
/// augment buffs. Might and Sniper read the attack type selected now: selection changes do not refresh.
pub fn adjustBaseStats(s: *State, u: *Unit) void {
    if (s.spit or s.shot_hooks or s.b6_hooks) adjustBaseStatsWith(s, u, true) else adjustBaseStatsWith(s, u, false);
}

/// adjustBaseStats, instantiated without batch 5's and batch 6a's hooks for boards where nothing can trigger them: their
/// code in the one shared body cost the ability-free refresh 3% (register pressure, not the tests).
fn adjustBaseStatsWith(s: *State, u: *Unit, comptime batch5: bool) void {
    const f = &s.fight;
    const syn = &s.setup[u.team];
    const lap_bit: u128 = if (f.lap >= 0 and f.lap < 128) @as(u128, 1) << @intCast(f.lap) else 0;
    const lap_adjusted = u.adjusted_laps & lap_bit != 0;
    // Batch 5's hooks, read once (`u` lies in `s`, so each store to it made every later test reload its flag); every Spit
    // Ball hook needs a debuff on the unit, and nothing here changes the list.
    const spit = batch5 and s.spit and u.debuffs.len != 0;
    const shot_hooks = batch5 and s.shot_hooks;
    // Batch 6a's rows (the four blessings, Wind Flow, the Guiding Winds row) and Hamstrung, read once each (statBuffs.get:
    // the first row of the name; getDebuff for Hamstrung).
    const b6 = batch5 and s.b6_hooks;
    const host: ?f64 = if (b6 and u.buffs.len != 0) u.buffs.power(.angelic_host_blessing) else null;
    const wind: ?f64 = if (b6 and u.buffs.len != 0) u.buffs.power(.wind_flow) else null;

    // resetTarget unless the Aggr status is still applied
    if (s.stat_hooks and u.target >= 0 and u.effects.find(.aggr) == null and u.debuffs.find(.aggr) == null) u.target = -1;
    // resetForbiddenTarget unless the Terrifying Gaze status is still applied (the gazer's death never clears it)
    if (s.gaze and u.forbidden != st.NO_UID and u.effects.find(.terrifying_gaze) == null and u.debuffs.find(.terrifying_gaze) == null) u.forbidden = st.NO_UID;

    // Made of Fire (a lava route with Lava Striders): the +init/power terms at the top of each stat's chain.
    const mof: ?f64 = if (s.artifacts) artifacts.madeOfFire(u) else null;
    // Artifact rows (statBuffs' first row of each name), read below at their TypeScript points; a battle without
    // artifacts reads the empty set and pays one branch per hook.
    var art_rows: artifacts.Rows = undefined;
    const art: *const artifacts.Rows = if (s.artifacts) blk: {
        art_rows = artifacts.rows(u);
        break :blk &art_rows;
    } else &artifacts.none;

    // HP
    if (shot_hooks or (s.unit_hooks and u.has(.unyielding_power))) {
        hpHooks(s, f, u, lap_adjusted, art, mof);
    } else {
        const was_full = u.hp >= u.max_hp;
        u.max_hp = if (mof) |fp| @ceil(u.init.max_hp + u.init.max_hp / fp) else u.init.max_hp;
        // Pendant of Vitality: +% max hp (a full unit is refilled to the new, fractional, max).
        if (s.artifacts) artifacts.pendantHp(u, art);
        if (was_full or u.max_hp < u.hp) u.hp = u.max_hp;
    }

    // LUCK
    if (u.debuffs.len != 0 and u.debuffs.find(.misfortune) != null) {
        // Misfortune, checked first: luck -10, or 0 when luck-buffed (Luck Blessing, Clover of Fortune), luck_mod 0, no
        // lap roll; luck_per_turn keeps the last roll (the lap still counts as adjusted).
        const buffed = u.buffs.find(.luck_blessing) != null or (s.artifacts and u.buffs.find(.clover_of_fortune) != null);
        u.luck = if (buffed) 0 else -LUCK_MAX;
        u.luck_mod = 0;
    } else {
        u.luck = u.init.luck;
        if (f.started and !lap_adjusted) {
            var luck = @as(f64, @floatFromInt(s.rng.int(-LUCK_MAX_CHANGE_FOR_TURN, LUCK_MAX_CHANGE_FOR_TURN + 1)));
            if (luck + u.luck > LUCK_MAX) {
                luck = LUCK_MAX - u.luck;
            } else if (luck + u.luck < -LUCK_MAX) {
                luck = -LUCK_MAX - u.luck;
            }
            u.luck_mod = luck;
            u.luck_per_turn = luck;
        }
        if (!f.started) u.luck_per_turn = 0;
        // Artifact luck: Cursed Ward's power, then Clover of Fortune's.
        const artifact_luck: f64 = if (s.artifacts) artifacts.luck(art) else 0;
        u.luck_mod = u.luck_per_turn + syn.luck + artifact_luck + (u.buffs.power(.luck_blessing) orelse 0);
        if (u.luck_mod + u.luck > LUCK_MAX) {
            u.luck_mod = LUCK_MAX - u.luck;
        } else if (u.luck_mod + u.luck < -LUCK_MAX) {
            u.luck_mod = -LUCK_MAX - u.luck;
        }
    }

    // MORALE (Madness or Mechanism pins it to 0, a leftover Morale or Dismorale entry notwithstanding; Sadness pins it
    // to -20, which a Morale buff overrides)
    u.attack_multiplier = 1;
    u.morale = if (syn.morale > 0) u.init.morale + syn.morale else u.init.morale;
    // Cursed Ward's morale penalty (second stored property) and Crown of Command's morale (first), before the locks.
    if (s.artifacts) artifacts.morale(u, art);
    if (moraleLocked(u)) {
        u.morale = 0;
    } else {
        if (spit and u.debuffs.find(.sadness) != null) u.morale = -MORALE_MAX;
        if (hasMoraleBuff(u)) {
            u.attack_multiplier = 1.25;
            u.morale = MORALE_MAX;
        } else if (hasDismorale(u)) {
            u.attack_multiplier = 0.8;
            u.morale = -MORALE_MAX;
        }
    }
    if (u.morale > MORALE_MAX) u.morale = MORALE_MAX;
    if (u.morale < -MORALE_MAX) u.morale = -MORALE_MAX;

    // ARMOR
    const pegasus_might = if (s.stat_hooks and s.auras) abilities.appliedAuraPower(u, .pegasus_might_aura) else null;
    u.base_armor = js.roundUnitStat((if (mof != null) u.init.base_armor + u.init.base_armor / 10 else u.init.base_armor) + 0, 2);
    if (pegasus_might) |pm| u.base_armor += pm;
    if (wind) |wf| u.base_armor += wf;
    const armor_augment = augmentBuff(s, u, .armor_augment);
    if (armor_augment) |aa| u.base_armor += js.roundUnitStat((u.base_armor / 100) * aa.power, 2);
    // Titan Plate captures its share after the Armor Augment, before the flats; it is added to armor_mod below.
    const titan_bonus: f64 = if (s.artifacts) artifacts.armorFlats(u, art) else 0;
    // Weakening Beam's multiplier comes first: the f64 product is (100 - p) / 100 * (1 + Heavy Armor's share).
    var base_armor_multiplier: f64 = 1;
    if (spit) {
        if (u.debuffs.get(.weakening_beam)) |wb| base_armor_multiplier = (100 - wb.power) / 100;
    }
    if (u.ability(.heavy_armor)) |ha| {
        base_armor_multiplier = base_armor_multiplier *
            (1 + ((ha.power + getLuck(u) + syn.ability_power + artifacts.fireTerm(mof, ha.power)) / 100 / abilities.MAX_UNIT_STACK_POWER) * getStackPower(u));
    }
    u.base_armor = js.roundUnitStat(u.base_armor * base_armor_multiplier, 2);
    const shatter = u.effects.power(.shatter_armor) orelse 0;
    u.armor_mod = if (shatter > 0) -shatter else u.init.armor_mod;
    // Nature's flyer armor (a flying creature, grounded or not) and Spiritual Armor (the first row of the name:
    // (power / 100) x (1 + the flyer share)) make armor_mod a share of the final base armor; an active Shatter Armor is
    // subtracted twice.
    var armor_mod_multiplier: f64 = 0;
    if (u.movement_type == st.Movement.FLY and syn.fly_armor > 0) armor_mod_multiplier = syn.fly_armor / 100;
    if (u.buffs.len != 0) {
        if (u.buffs.get(.spiritual_armor)) |sa| armor_mod_multiplier = (sa.power / 100) * (1 + armor_mod_multiplier);
    }
    if (armor_mod_multiplier != 0) u.armor_mod = js.roundUnitStat(@max(u.base_armor - shatter, 1) * armor_mod_multiplier - shatter, 2);
    // Veteran Helm: a share of the final base armor (no outer rounding); then Titan Plate's captured share (rounded).
    if (s.artifacts) artifacts.armorMod(u, art, titan_bonus);
    // Angelic Host's power (rounded), after the artifacts' armor_mod terms.
    if (host) |ah| u.armor_mod = js.roundUnitStat(u.armor_mod + ah, 2);
    // Armor Rune: the stacked bonus (getBuffStacks: the row's first stored property), flat, at the end of the chain.
    if (s.runes) {
        if (runeStacks(u, .armor_rune)) |n| u.armor_mod = js.roundUnitStat(u.armor_mod + n, 2);
    }

    // MAGIC RESIST
    u.magic_resist = if (mof) |fp| u.init.magic_resist + u.init.magic_resist / fp else u.init.magic_resist;
    if (armor_augment) |aa| u.magic_resist = js.roundUnitStat(u.magic_resist + aa.power, 2); // flat magic armor
    u.magic_resist_mod = 0;
    const p = (if (u.magic_resist_mod != 0) u.magic_resist_mod else u.magic_resist) / 100;
    // winningAtLeastOneEventProbability([getMagicResist() / 100, Magic Shield's and Wardguard's multipliers, the
    // Arcane Ward Blessing row's power / 100]), folded in that order
    var no_resist = 1 * (1 - p);
    if (u.ability(.magic_shield)) |ms| no_resist = no_resist * (1 - abilities.abilityMultiplier(u, ms));
    if (s.stat_hooks) {
        if (u.ability(.wardguard)) |wg| no_resist = no_resist * (1 - abilities.abilityMultiplier(u, wg));
    }
    if (s.blessings) {
        // Warding Mane is folded before Arcane Ward (re-granted after it): the order matters under toFixed(2).
        if (u.buffs.get(.warding_mane_blessing)) |wm| no_resist = no_resist * (1 - @max(0, wm.power) / 100);
        if (u.buffs.get(.arcane_ward_blessing)) |aw| no_resist = no_resist * (1 - @max(0, aw.power) / 100);
    }
    // Aegis of the Arcane: one more independent roll, folded last.
    if (s.artifacts) no_resist = artifacts.aegis(art, no_resist);
    u.magic_resist = js.roundUnitStat((1 - no_resist) * 100, 2);

    // SHOTS: Limited Supply's cap and Endless Quiver's mod.
    if (shot_hooks) shotHooks(u);

    // INITIATIVE
    u.initiative = if (mof) |fp| u.init.initiative + u.init.initiative / fp else u.init.initiative;

    // STEPS
    u.steps_mod = js.roundUnitStat(f.steps_morale_multiplier * getMorale(u), 1) + syn.movement_steps;
    u.steps = if (mof) |fp| u.init.steps + u.init.steps / fp else u.init.steps;
    // Sky Runner: calculateAbilityCount's ADDITIONAL_STEPS share (this refresh's luck), before the Movement augment.
    if (s.unit_hooks) {
        if (u.ability(.sky_runner)) |sr| u.steps += abilities.abilityCount(u, sr);
    }
    // Wolf Trail: its power in steps_mod, before Battle Roar's (the addition order is the float order).
    if (b6 and u.buffs.len != 0) {
        if (u.buffs.power(.wolf_trail_blessing)) |wt| u.steps_mod += wt;
    }
    if (augmentBuff(s, u, .movement_augment)) |ma| u.steps += ma.power;
    // Swift Boots: a share of the running steps (Movement Augment included); Winged Boots' and Crown's flat steps.
    if (s.artifacts) artifacts.steps(u, art);
    if (s.spell_hooks) {
        // Battle Roar: the cast's power in steps_mod (the first buff of the name).
        if (u.buffs.len != 0) {
            if (u.buffs.get(.battle_roar)) |br| u.steps_mod += br.power;
        }
        // Wind Flow: the slow (at most the config's power: Tome of Amplification strengthens only the armor), floored at 1.
        if (wind) |wf| u.steps = @max(1, u.steps - @min(wf, windFlowPower(s)));
        // Vine Throw: the snare cuts the base steps (the first debuff of the name), floored at 1.
        if (u.debuffs.len != 0) {
            if (u.debuffs.get(.vine_throw)) |vt| u.steps = @max(1, u.steps - vt.power);
        }
    }
    // Quagmire (Spit Ball's, or Rime Charm's), then Gravebound (Gravechain's), then Hamstrung (the Dryad's), each the
    // first debuff of the name, on one multiplier: steps and steps_mod x (100 - power) / 100.
    var steps_multiplier: f64 = 1;
    if (spit) {
        if (u.debuffs.get(.quagmire)) |q| steps_multiplier *= (100 - q.power) / 100;
    }
    if (s.artifacts and u.debuffs.len != 0) {
        if (u.debuffs.get(.gravebound)) |g| steps_multiplier *= (100 - g.power) / 100;
    }
    if (b6 and s.hamstring and u.debuffs.len != 0) {
        if (u.debuffs.get(.hamstrung)) |h| steps_multiplier *= (100 - h.power) / 100;
    }
    u.steps = js.roundUnitStat(u.steps * steps_multiplier, 1);
    u.steps_mod = js.roundUnitStat(u.steps_mod * steps_multiplier, 1);
    if (b6) b6Steps(u, host, steps_multiplier);

    // ATTACK
    u.base_attack = if (mof) |fp| u.init.base_attack + u.init.base_attack / fp else u.init.base_attack;
    u.shot_distance = if (mof) |fp| u.init.shot_distance + u.init.shot_distance / fp else u.init.shot_distance;
    // A stolen Endless Quiver makes a natively melee unit a shooter: Medusa's distance (STOLEN_ENDLESS_QUIVER_SHOT_DISTANCE).
    if (shot_hooks and u.init.shot_distance <= 0 and u.has(.endless_quiver)) u.shot_distance = 6.5;
    u.attack_damage_min = u.init.attack_damage_min;
    u.attack_damage_max = u.init.attack_damage_max;
    // Blessing and Battle Roar: every roll is the maximum; else Curse: every roll is the minimum.
    if (s.spell_hooks and (u.buffs.find(.blessing) != null or u.buffs.find(.battle_roar) != null)) {
        u.attack_damage_min = u.attack_damage_max;
    } else if (spit and u.debuffs.find(.curse) != null) {
        u.attack_damage_max = u.attack_damage_min;
    }
    var base_attack_multiplier: f64 = 1;
    if (u.buffs.power(.sharpened_weapons_blessing)) |sw| base_attack_multiplier = base_attack_multiplier * (1 + sw / 100);
    if (pegasus_might) |pm| u.base_attack += pm;
    if (s.augments) {
        if (u.attack_type_selected != AT.RANGE) {
            if (u.augment(.might_augment)) |ma| u.base_attack += js.roundUnitStat((u.base_attack / 100) * ma.power, 2);
        } else if (u.augment(.sniper_augment)) |sa| {
            // getBuffProperties: the stored first/second properties (base attack %, shot distance %).
            if (sa.src_x >= 0 and sa.src_y >= 0) {
                u.base_attack += js.roundUnitStat((u.base_attack / 100) * @as(f64, @floatFromInt(sa.src_x)), 2);
                u.shot_distance += js.roundUnitStat((u.shot_distance / 100) * @as(f64, @floatFromInt(sa.src_y)), 2);
            }
        }
    }
    // Guiding Winds (the receiver's last aura row of the name): power% of the INITIAL distance while RANGE is selected,
    // before the attack artifacts.
    if (b6 and s.auras and u.attack_type_selected == AT.RANGE) {
        if (abilities.appliedAuraPower(u, .guiding_winds_aura)) |gw| u.shot_distance += js.roundUnitStat((u.init.shot_distance / 100) * gw, 2);
    }
    const we_bonus: f64 = if (s.artifacts) artifacts.attackArtifacts(u, art) else 0;
    // Riot (the first row of the name), else Mass Riot: that share of the base attack (unrounded until the round below);
    // else the initial mod.
    u.attack_mod = u.init.attack_mod;
    if (u.buffs.len != 0) {
        if (u.buffs.get(.riot)) |r| {
            u.attack_mod = (u.base_attack * r.power) / 100;
        } else if (u.buffs.get(.mass_riot)) |m| {
            u.attack_mod = (u.base_attack * m.power) / 100;
        }
    }
    // Weakness (the first debuff of the name): power% of the running base attack, before Sharpened Weapons' multiplier.
    if (spit) {
        if (u.debuffs.get(.weakness)) |w| u.attack_mod -= (u.base_attack * w.power) / 100;
    }
    // Blind Fury: the share of the stack already lost, of the INITIAL base attack.
    if (u.has(.blind_fury)) u.attack_mod += (1 - u.amount_alive / (u.amount_alive + u.amount_died)) * u.init.base_attack;
    u.attack_mod = js.roundUnitStat(u.attack_mod + we_bonus, 2);
    if (host) |ah| u.attack_mod = js.roundUnitStat(u.attack_mod + ah, 2);
    // Weapon Rune: the stacked bonus, flat, after Warlord's Edge's round and before the base-attack multiplier.
    if (s.runes) {
        if (runeStacks(u, .weapon_rune)) |n| u.attack_mod = js.roundUnitStat(u.attack_mod + n, 2);
    }
    u.base_attack = js.roundUnitStat(u.base_attack * base_attack_multiplier, 2);
    u.shot_distance = js.roundUnitStat(u.shot_distance, 2);
    // Arrows Wingshield: the range-armor multiplier 1 x (1 + max(0, power) / 100).
    var range_armor_multiplier: f64 = 1;
    if (b6 and u.buffs.len != 0) {
        if (u.buffs.power(.arrows_wingshield_blessing)) |aw| range_armor_multiplier = range_armor_multiplier * (1 + @max(0, aw) / 100);
    }
    u.range_armor = js.roundUnitStat(u.base_armor * range_armor_multiplier, 2);

    if (f.started and !lap_adjusted) u.adjusted_laps |= lap_bit;
}

/// adjustBaseStats' steps_mod terms after the slow's rounding: Angelic Host's power (unslowed), then Tie up the Horses on
/// a unit that cannot fly (slowed, toFixed(4)).
noinline fn b6Steps(u: *Unit, host: ?f64, steps_multiplier: f64) void {
    if (host) |ah| u.steps_mod = js.roundUnitStat(u.steps_mod + ah, 2);
    if (u.buffs.len != 0 and !canFly(u)) {
        if (u.buffs.power(.tie_up_the_horses_blessing)) |tie| u.steps_mod = artifacts.toFixed4(u.steps_mod + tie * steps_multiplier);
    }
}

/// getSpellConfig("System", "Wind Flow").power (recorded `spellConfigs`); a carrier without the config is a capacity of
/// the port (the slow cannot be followed).
fn windFlowPower(s: *State) f64 {
    const cfg = &s.spell_cfg[@intFromEnum(st.CastSpell.wind_flow)];
    if (!cfg.loaded) {
        s.overflow = true;
        return 0;
    }
    return cfg.power;
}

/// Unit.getBuffStacks for a rune: the row's first stored property (0 when absent); null when the term is 0.
inline fn runeStacks(u: *const Unit, id: st.SpellId) ?f64 {
    if (u.buffs.len == 0) return null;
    const b = u.buffs.get(id) orelse return null;
    if (b.src_x <= 0) return null;
    return @floatFromInt(b.src_x);
}

/// adjustBaseStats' HP block with the unit hooks (hasAbilityActive, read once: Break-aware): refreshAndGetAdjustedMaxHp's
/// max hp (initial, Made of Fire's ceil(initial + initial / power) on a lava-route unit, + 5 per lap under Unyielding
/// Power), Boost Health's boost (`round(max + max * multiplier)`, the multiplier read with the luck left by the previous
/// refresh; a top creature at exactly the reset maximum is refilled to the boosted one, the free heal), Pendant of
/// Vitality's share, then on Unyielding Power's lap's first refresh after the start +5 hp, +1 initial step and +2
/// initial base attack (first read after this block, by the STEPS and ATTACK copies), then the full-hp refill or the cap.
noinline fn hpHooks(s: *const State, f: *const st.Fight, u: *Unit, lap_adjusted: bool, art: *const artifacts.Rows, mof: ?f64) void {
    const was_full = u.hp >= u.max_hp;
    const up = s.unit_hooks and u.has(.unyielding_power);
    const base = if (mof) |fp| @ceil(u.init.max_hp + u.init.max_hp / fp) else u.init.max_hp;
    u.max_hp = if (up) base + @as(f64, @floatFromInt(f.lap)) * 5 else base;
    if (s.shot_hooks) {
        if (u.ability(.boost_health)) |bh| {
            const m = abilities.abilityMultiplier(u, bh);
            const reset_full = u.hp == u.max_hp;
            u.max_hp = js.round(u.max_hp + u.max_hp * m);
            if (reset_full) u.hp = u.max_hp;
        }
    }
    // max_hp is refreshAndGetAdjustedMaxHp's result here (+ baseStatsDiff.hp, 0 in scope): Pendant of Vitality's share,
    // before Unyielding Power's +5 and the refill.
    artifacts.pendantHp(u, art);
    if (up and f.started and !lap_adjusted) {
        u.hp += 5;
        u.init.steps += 1;
        u.init.base_attack += 2;
    }
    if (was_full or u.max_hp < u.hp) u.hp = u.max_hp;
}

/// adjustBaseStats' SHOTS block: Limited Supply caps range_shots at floor(maxRangeShots * stack power / 5) plus the
/// Rallying Volley arrows (it only lowers them); Endless Quiver pins range_shots_mod to its power (99), cleared once the
/// quiver is off (Broken or stolen away).
noinline fn shotHooks(u: *Unit) void {
    if (u.has(.limited_supply)) {
        const coeff = getStackPower(u) / abilities.MAX_UNIT_STACK_POWER;
        u.range_shots = @min(u.range_shots, @floor(u.max_range_shots * coeff) + u.rallying_volley_granted);
    }
    if (u.ability(.endless_quiver)) |eq| {
        u.range_shots_mod = eq.power;
    } else if (u.range_shots_mod != 0) {
        u.range_shots_mod = 0;
    }
}

/// FightProperties.setUnitsCalculatedStacksPower
fn setStackPowers(s: *State) void {
    var max_total: f64 = -MAX_SAFE_INTEGER;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (!positionWithinGrid(u.pos_x, u.pos_y)) continue;
        const total = u.exp * u.amount_alive;
        max_total = if (max_total < total) total else max_total;
    }
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (!positionWithinGrid(u.pos_x, u.pos_y)) continue;
        const pct = ((u.exp * u.amount_alive) / max_total) * 100;
        u.stack_power = if (pct <= 20) 1 else if (pct <= 40) 2 else if (pct <= 60) 3 else if (pct <= 80) 4 else 5;
    }
}

/// UnitsHolder.refreshStackPowerForAllUnits (no Water Shield in scope): stack powers, the aura refresh (reading the new
/// stack power and the luck left by the previous refresh), the blessings, then every unit's stats, each followed by
/// increaseAttackMod(getUnitAuraAttackMod) (War Anger) and the Disguise swap.
pub fn refreshStackPowerForAllUnits(s: *State) void {
    setStackPowers(s);
    if (s.auras) abilities.refreshAuras(s);
    if (s.blessings) abilities.refreshBlessings(s);
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (!cellWithinGrid(baseCell(u))) continue;
        adjustBaseStats(s, u);
        if (s.war_anger) increaseAttackMod(u, warAngerMod(s, i));
    }
    if (s.disguise) disguisePass(s);
}

/// UnitsHolder.getUnitAuraAttackMod(unit) (the unit's cells now): a unit holding the War Anger AuraEffect and not Broken
/// gains getBaseAttack() * ((power * enemies) / 100), the power its AuraEffect holds (Unit.war_anger_power) and the
/// enemies the distinct holder units of the other team (dead ones too) standing in the clipped Chebyshev ball of the
/// aura's range plus the team's aura range around any body cell; 0 otherwise.
pub fn warAngerMod(s: *const State, ui: u8) f64 {
    const u = &s.units[ui];
    const def = s.war_anger_def;
    if (def == st.NO_AURA or u.n_auras == 0 or u.isBroken()) return 0;
    var holds = false;
    for (u.auras[0..u.n_auras]) |d| {
        if (d == def) holds = true;
    }
    if (!holds) return 0;
    const n = enemiesWithin(s, ui, s.aura_defs[def].range + s.setup[u.team].aura_range);
    return u.base_attack * ((u.war_anger_power * @as(f64, @floatFromInt(n))) / 100);
}

/// Unit.increaseAttackMod: a positive increase lands on attack_mod (toFixed(2)) and is remembered unrounded; otherwise
/// the remembered increase is 0.
pub inline fn increaseAttackMod(u: *Unit, by: f64) void {
    if (by > 0) {
        u.attack_mod = js.toFixed(u.attack_mod + by, 2);
        u.attack_mod_increase = by;
    } else u.attack_mod_increase = 0;
}

/// countEnemiesWithinRange(unit, unit.getCells(), range): the distinct enemy holder units occupying the clipped
/// Chebyshev ball of `range` around any body cell.
fn enemiesWithin(s: *const State, ui: u8, range: f64) u32 {
    if (!(range >= 0)) return 0;
    const r: i32 = @intFromFloat(@min(range, st.GRID));
    const u = &s.units[ui];
    const body = unitCells(u);
    var seen: st.UnitSet = 0;
    for (body.slice()) |c| {
        if (!cellWithinGrid(c)) continue;
        var x = @max(0, c.x - r);
        while (x <= @min(st.GRID - 1, c.x + r)) : (x += 1) {
            var y = @max(0, c.y - r);
            while (y <= @min(st.GRID - 1, c.y + r)) : (y += 1) {
                const o = s.grid.board[@intCast(x)][@intCast(y)];
                if (!st.isUnitCode(o)) continue;
                const e = &s.units[o - 1];
                if (e.in_holder and e.team != u.team) seen |= unitBit(o - 1);
            }
        }
    }
    return @popCount(seen);
}

/// Unit.applyTravelledDistanceModifier (Crusade, Break-aware): calculateAbilityCount (this refresh's stack power, the luck
/// now, the team's ability power) per travelled cell on the INITIAL base attack and armor, toFixed(2), capped at 50. The
/// next stat refresh reads it.
pub fn crusade(u: *Unit, cells: usize) void {
    const a = u.ability(.crusade) orelse return;
    const add = abilities.abilityCount(u, a) * @as(f64, @floatFromInt(cells));
    u.init.base_attack = @min(50, js.toFixed(u.init.base_attack + add, 2));
    u.init.base_armor = @min(50, js.toFixed(u.init.base_armor + add, 2));
}

/// canSelfResurrect: an active Resurrection card (Break-aware) and a parsed Resurrection with a charge.
pub fn canSelfResurrect(u: *const Unit) bool {
    if (!u.has(.resurrection)) return false;
    for (u.spells[0..u.n_spells]) |b| {
        if (b.spell == @intFromEnum(st.CastSpell.resurrection) and b.amount > 0) return true;
    }
    return false;
}

/// UnitsHolder.deleteUnitById(id, true)'s revive: a dead holder that canSelfResurrect gets min(died, max(1, floor(died /
/// 2))) creatures back (hp stays its full max), loses every effect, debuff and buff object (the augment display rows stay
/// as orphans, the stat refresh no longer reads them), its Aggr target, and the Resurrection card with its charge (the
/// book re-parsed). It keeps its slot, uid, cells, place in the holder and turn state. Returns whether it revived (then
/// the caller emits no unit_destroyed and raises no Infest summon).
pub fn tryRevive(s: *State, ui: u8) bool {
    if (!s.resurrection) return false;
    const u = &s.units[ui];
    if (u.ability_mask & st.AbilityId.resurrection.bit() == 0 or !canSelfResurrect(u)) return false;
    const died = u.amount_died;
    const count = @min(died, @max(1, @floor(died / 2)));
    // reviveAfterDeath
    if (!u.isDead() or !(count > 0)) return false;
    const revived = @min(u.amount_died, @floor(count));
    if (revived <= 0) return false;
    u.amount_alive += revived;
    u.amount_died -= revived;
    u.fuse = .{}; // lastFuseFatalHit = undefined
    // deleteAllEffects, deleteAllBuffs (the " Augment" display rows stay, objects none), deleteAllDebuffs
    u.effects.len = 0;
    u.debuffs.len = 0;
    var w: u8 = 0;
    for (u.buffs.items[0..u.buffs.len]) |b| {
        if (!b.id.isAugment()) continue;
        u.buffs.items[w] = b;
        w += 1;
    }
    u.buffs.len = w;
    u.aug_orphans = w;
    u.target = -1; // resetTarget: initialUnitProperties.target is "" in scope
    _ = abilities.deleteAbility(s, u, .resurrection);
    return true;
}

/// The Disguise swaps of refreshStackPowerForAllUnits' stat loop: the swap after each unit's stats touches only that
/// unit's lists, and adjustBaseStats reads only its own unit, so running them after the whole pass gives the same state.
noinline fn disguisePass(s: *State) void {
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (!cellWithinGrid(baseCell(u))) continue;
        if (abilities.appliedAuraPower(u, .disguise_aura) != null) disguiseSwap(s, i);
    }
}

/// The Disguise swap of refreshStackPowerForAllUnits for a unit carrying the "Disguise Aura" row: Visible (Hidden
/// deleted) when an enemy holder unit stands within the configured range plus the team's aura range of any body cell
/// (getNumberOfEnemiesWithinRange: board occupants, dead ones included), else Hidden (Visible deleted); a marker
/// already carried is kept where it is, a new one is appended.
fn disguiseSwap(s: *State, ui: u8) void {
    const u = &s.units[ui];
    const range = s.disguise_range + s.setup[u.team].aura_range;
    if (enemyWithin(s, ui, range)) {
        u.buffs.delete(.hidden);
        if (u.debuffs.find(.visible) == null) abilities.pushChecked(s, &u.debuffs, .{ .id = .visible, .laps = s.visible_laps, .power = s.visible_power });
    } else {
        u.debuffs.delete(.visible);
        if (u.buffs.find(.hidden) == null) abilities.pushChecked(s, &u.buffs, .{ .id = .hidden, .laps = s.hidden_laps, .power = s.hidden_power });
    }
}

/// countEnemiesWithinRange(unit, unit.getCells(), range) > 0: a board occupant of the other team inside the clipped
/// Chebyshev ball of `range` around any body cell.
fn enemyWithin(s: *const State, ui: u8, range: f64) bool {
    if (!(range >= 0)) return false;
    const r: i32 = @intFromFloat(@min(range, st.GRID));
    const u = &s.units[ui];
    const body = unitCells(u);
    for (body.slice()) |c| {
        var x = @max(0, c.x - r);
        while (x <= @min(st.GRID - 1, c.x + r)) : (x += 1) {
            var y = @max(0, c.y - r);
            while (y <= @min(st.GRID - 1, c.y + r)) : (y += 1) {
                const o = s.grid.board[@intCast(x)][@intCast(y)];
                if (!st.isUnitCode(o)) continue;
                const e = &s.units[o - 1];
                if (e.in_holder and e.team != u.team) return true;
            }
        }
    }
    return false;
}

// =====================================================================================================================
// UnitsHolder queries
// =====================================================================================================================

/// getDistanceToClosestEnemy: every holder unit of the enemy team, dead or not.
fn distanceToClosestEnemy(s: *const State, enemy_team: u8, x: f64, y: f64) f64 {
    var closest = MAX_SAFE_INTEGER;
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team != enemy_team) continue;
        closest = @min(closest, distance(x, y, e.pos_x, e.pos_y));
    }
    return closest;
}

/// haveDistancesToClosestEnemiesDecreased
fn haveDistancesDecreased(s: *State) bool {
    var decreased = false;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.isDead()) continue;
        if (!positionWithinGrid(u.pos_x, u.pos_y)) continue;
        const current = js.toFixed(distanceToClosestEnemy(s, opposite(u.team), u.pos_x, u.pos_y), 2);
        if (u.dist_known) {
            const known = u.dist_closest_enemy;
            if (known == 0 or known > current) decreased = true;
        } else {
            decreased = true;
        }
        u.dist_known = true;
        u.dist_closest_enemy = current;
    }
    return decreased;
}

/// getDistanceToEnemyCentroid
pub fn distanceToEnemyCentroid(s: *const State, enemy_team: u8, x: f64, y: f64) f64 {
    var sx: f64 = 0;
    var sy: f64 = 0;
    var n: f64 = 0;
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team != enemy_team) continue;
        sx += e.pos_x;
        sy += e.pos_y;
        n += 1;
    }
    if (n == 0) return MAX_SAFE_INTEGER;
    return distance(x, y, sx / n, sy / n);
}

/// deleteUnitById (no resurrection in scope). Always returns true for a real id. Releases every Aggr lock on the unit.
pub fn deleteUnit(s: *State, ui: u8) void {
    const u = &s.units[ui];
    if (u.in_holder) {
        u.in_holder = false;
        cleanupAll(s, ui);
        if (std.mem.indexOfScalar(u8, s.holderOrder(), ui)) |k| {
            std.mem.copyForwards(u8, s.holder[k .. s.n_holder - 1], s.holder[k + 1 .. s.n_holder]);
            s.n_holder -= 1;
        }
    }
    for (s.holderOrder()) |i| {
        const x = &s.units[i];
        if (x.target == @as(i8, @intCast(ui))) x.target = -1;
    }
    _ = s.fight.hourglass_q.removeOnce(ui);
    _ = s.fight.morale_minus_q.removeOnce(ui);
    _ = s.fight.morale_plus_q.removeOnce(ui);
    _ = s.fight.up_next.removeOnce(ui);
}

pub inline fn unitBit(ui: u8) st.UnitSet {
    return @as(st.UnitSet, 1) << @intCast(ui);
}

// =====================================================================================================================
// Turn order (TurnEngine.getOrderedTurnUnits)
// =====================================================================================================================

pub const UnitList = struct {
    items: [st.MAX_UNITS]u8 = undefined,
    len: u8 = 0,

    pub fn push(self: *UnitList, u: u8) void {
        self.items[self.len] = u;
        self.len += 1;
    }
    pub fn slice(self: *const UnitList) []const u8 {
        return self.items[0..self.len];
    }
};

const Ordered = struct {
    all: UnitList = .{},
    right: UnitList = .{},
    left: UnitList = .{},
};

/// Stable sort by initiative, highest first (Array.prototype.sort with (a, b) => b - a).
fn sortByInitiative(s: *const State, list: *UnitList) void {
    var i: usize = 1;
    while (i < list.len) : (i += 1) {
        const x = list.items[i];
        const xi = s.units[x].initiative;
        var j = i;
        while (j > 0 and xi > s.units[list.items[j - 1]].initiative) : (j -= 1) list.items[j] = list.items[j - 1];
        list.items[j] = x;
    }
}

fn aliveTeam(s: *const State, team: u8) UnitList {
    var out: UnitList = .{};
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.team == team and !u.isDead()) out.push(i);
    }
    return out;
}

fn orderedTurnUnits(s: *State) Ordered {
    var o: Ordered = .{};
    o.right = aliveTeam(s, Team.RIGHT);
    o.left = aliveTeam(s, Team.LEFT);
    for (o.right.slice()) |u| o.all.push(u);
    for (o.left.slice()) |u| o.all.push(u);
    s.rng.shuffle(u8, o.all.items[0..o.all.len]);
    sortByInitiative(s, &o.all);
    s.rng.shuffle(u8, o.right.items[0..o.right.len]);
    sortByInitiative(s, &o.right);
    s.rng.shuffle(u8, o.left.items[0..o.left.len]);
    sortByInitiative(s, &o.left);
    return o;
}

fn finishFightIfNeeded(s: *State, o: *const Ordered, events: *Events) bool {
    if (o.left.len != 0 and o.right.len != 0) return false;
    const winner: u8 = if (o.left.len != 0) Team.LEFT else if (o.right.len != 0) Team.RIGHT else Team.NO_TEAM;
    s.fight.finished = true;
    events.push(.fight_finished, winner);
    return true;
}

// =====================================================================================================================
// FightProperties queue logic
// =====================================================================================================================

fn flipLap(f: *st.Fight) void {
    f.made = 0;
    f.hourglass_set = 0;
    f.replied = 0;
    f.removed_made = .{};
    f.removed_hourglass = .{};
    f.removed_replied = .{};
    f.lap += 1;
    f.hourglass_q = .{};
    f.morale_minus_q = .{};
    f.morale_plus_q = .{};
    f.up_next = .{};
}

inline fn isNarrowingLap(f: *const st.Fight) bool {
    return f.lap > f.laps_till_narrowing and @mod(f.lap, f.laps_till_narrowing) == 1;
}

inline fn armageddonWave(f: *const st.Fight) i32 {
    return f.lap - NUMBER_OF_LAPS_FIRST_ARMAGEDDON + 1;
}

inline fn inList(list: []const u8, u: u8) bool {
    for (list) |x| if (x == u) return true;
    return false;
}

/// getNextTurnUnitId
fn nextTurnUnitId(s: *State, eligible: st.UnitSet, right: []const u8, left: []const u8) ?u8 {
    const f = &s.fight;
    if (left.len == 0 or right.len == 0) return null;
    while (f.morale_plus_q.shift()) |id| {
        if (eligible & unitBit(id) != 0 and f.made & unitBit(id) == 0 and !f.up_next.includes(id)) return id;
    }
    var first: []const u8 = undefined;
    var second: []const u8 = undefined;
    if (f.previous_turn_team == Team.NO_TEAM) {
        var total_r: f64 = 0;
        var total_l: f64 = 0;
        for (right) |ui| {
            f.highest_initiative = @max(f.highest_initiative, s.units[ui].initiative);
            total_r += getMorale(&s.units[ui]);
        }
        for (left) |ui| {
            f.highest_initiative = @max(f.highest_initiative, s.units[ui].initiative);
            total_l += getMorale(&s.units[ui]);
        }
        const avg_r = if (right.len != 0) total_r / @as(f64, @floatFromInt(right.len)) else 0;
        const avg_l = if (left.len != 0) total_l / @as(f64, @floatFromInt(left.len)) else 0;
        if (avg_r > avg_l) {
            first = right;
            second = left;
        } else if (avg_r < avg_l) {
            first = left;
            second = right;
        } else {
            var lmax: f64 = -MAX_SAFE_INTEGER;
            for (left) |ui| lmax = if (s.units[ui].initiative > lmax) s.units[ui].initiative else lmax;
            var rmax: f64 = -MAX_SAFE_INTEGER;
            for (right) |ui| rmax = if (s.units[ui].initiative > rmax) s.units[ui].initiative else rmax;
            if (lmax > rmax) {
                first = left;
                second = right;
            } else if (lmax < rmax) {
                first = right;
                second = left;
            } else if (s.rng.int(0, 2) != 0) {
                first = right;
                second = left;
            } else {
                first = left;
                second = right;
            }
        }
    } else if (f.previous_turn_team == Team.LEFT) {
        first = right;
        second = left;
    } else {
        first = left;
        second = right;
    }
    for ([_][]const u8{ first, second }) |batch| {
        for (batch) |id| {
            if (f.made & unitBit(id) == 0 and !f.up_next.includes(id) and !f.hourglass_q.includes(id) and !f.morale_minus_q.includes(id)) return id;
        }
    }
    while (f.morale_minus_q.shift()) |id| {
        if (eligible & unitBit(id) != 0 and f.made & unitBit(id) == 0 and !f.up_next.includes(id)) return id;
    }
    var has_eligible_hourglass = false;
    for (f.hourglass_q.slice()) |id| {
        if (eligible & unitBit(id) != 0) has_eligible_hourglass = true;
    }
    var all_accounted = true;
    var it = eligible;
    while (it != 0) {
        const id: u8 = @intCast(@ctz(it));
        it &= it - 1;
        if (!(f.made & unitBit(id) != 0 or f.hourglass_q.includes(id) or f.up_next.includes(id))) all_accounted = false;
    }
    if (has_eligible_hourglass and all_accounted) {
        while (f.hourglass_q.shift()) |id| {
            if (eligible & unitBit(id) != 0 and f.made & unitBit(id) == 0 and !f.up_next.includes(id)) return id;
        }
    }
    return null;
}

/// prefetchNextUnitsToTurn
fn prefetchNextUnits(s: *State, right: []const u8, left: []const u8) void {
    var eligible: st.UnitSet = 0;
    var count: u32 = 0;
    for ([_][]const u8{ right, left }) |side| {
        for (side) |ui| {
            const u = &s.units[ui];
            if (u.in_holder and !u.isDead() and eligible & unitBit(ui) == 0) {
                eligible |= unitBit(ui);
                count += 1;
            }
        }
    }
    var er: UnitList = .{};
    var el: UnitList = .{};
    for (right) |ui| if (eligible & unitBit(ui) != 0) er.push(ui);
    for (left) |ui| if (eligible & unitBit(ui) != 0) el.push(ui);
    const f = &s.fight;
    while (true) {
        var queued: st.UnitSet = 0;
        for (f.up_next.slice()) |id| {
            if (eligible & unitBit(id) != 0) queued |= unitBit(id);
        }
        if (@popCount(queued) >= count) return;
        const next = nextTurnUnitId(s, eligible, er.slice(), el.slice()) orelse return;
        const u = &s.units[next];
        if (u.in_holder and !u.isDead() and !f.up_next.includes(next) and f.made & unitBit(next) == 0) {
            f.up_next.push(next);
            f.previous_turn_team = u.team;
        }
    }
}

// =====================================================================================================================
// Lap transition (TurnEngine.handleLapTransition and friends)
// =====================================================================================================================

/// UPDATE_* masks (src/grid/grid_constants.ts)
const Dir = enum { up, down, left, right };

fn shiftedCells(cells: []const Cell, shift: i32, laps_narrowed: i32, moving_x: bool) ?Cells {
    var out: Cells = .{};
    for (cells) |c| {
        if (moving_x) {
            const nx = c.x + shift;
            if (nx < laps_narrowed or nx >= st.GRID - laps_narrowed) return null;
            out.push(.{ .x = nx, .y = c.y });
        } else {
            const ny = c.y + shift;
            if (ny < laps_narrowed or ny >= st.GRID - laps_narrowed) return null;
            out.push(.{ .x = c.x, .y = ny });
        }
    }
    return out;
}

/// finishDirectedUnitMove. Returns the new position, or null when the occupy was refused.
fn finishDirectedMove(s: *State, ui: u8, target: []const Cell, new_pos: ?[2]f64, dir: ?Dir) ?[2]f64 {
    if (target.len == 0) return null;
    const u = &s.units[ui];
    const ok = if (isSmall(u)) occupyCell(s, ui, anchorForCells(target)) else occupyCells(s, ui, target);
    if (!ok) return null;
    // dispelSmokeOnOccupiedCells on the arrival footprint (a move or a narrowing shove), before setPosition.
    if (s.fight.n_smoke != 0) dispelSmoke(s, ui, target);
    var pos = new_pos;
    if (pos == null) {
        if (dir) |d| pos = switch (d) {
            .up => .{ u.pos_x, u.pos_y + CELL },
            .down => .{ u.pos_x, u.pos_y - CELL },
            .left => .{ u.pos_x - CELL, u.pos_y },
            .right => .{ u.pos_x + CELL, u.pos_y },
        };
    }
    if (pos) |p| {
        // Unit.setPosition: an active Sniper's shot distance is rewritten from the position it leaves (the next stat
        // refresh rebuilds it, so only a move_unit step shows it).
        if (u.ability_mask & st.AbilityId.sniper.bit() != 0 and u.has(.sniper)) {
            u.shot_distance = js.toFixed(distanceToFurthestCorner(u.pos_x, u.pos_y) / CELL - 0.45, 2);
        }
        u.pos_x = p[0];
        u.pos_y = p[1];
    }
    return pos;
}

/// MoveHandler.moveUnitTowardsCenter + TurnEngine.handleSystemMoveResult. Returns whether the unit was destroyed.
fn moveUnitTowardsCenter(s: *State, cell: Cell, dir: Dir, laps_narrowed: i32, events: *Events) void {
    const o = occ(s, cell);
    if (!st.isUnitCode(o)) return; // a hole, a stone or lava: unitsHolder.get("B") is undefined
    const ui: u8 = o - 1;
    const u = &s.units[ui];
    if (!u.in_holder) return;
    const cells = unitCells(u);
    var target: Cells = .{};
    for (cells.slice()) |c| target.push(switch (dir) {
        .up => .{ .x = c.x, .y = c.y + 1 },
        .down => .{ .x = c.x, .y = c.y - 1 },
        .left => .{ .x = c.x - 1, .y = c.y },
        .right => .{ .x = c.x + 1, .y = c.y },
    });
    var destroyed = false;
    if (cellsFreeFor(s, ui, target.slice())) {
        _ = finishDirectedMove(s, ui, target.slice(), null, dir);
    } else {
        var shift: i32 = if (u.team == Team.LEFT) 1 else -1;
        const move_x = dir == .up or dir == .down;
        const initial = target;
        var flipped = false;
        var moved = false;
        while (shift != 0) {
            if (shiftedCells(target.slice(), shift, laps_narrowed, move_x)) |sh| {
                if (cellsFreeFor(s, ui, sh.slice())) {
                    const pos = positionForCells(sh.slice()) orelse {
                        target = sh;
                        continue;
                    };
                    _ = finishDirectedMove(s, ui, sh.slice(), pos, null);
                    shift = 0;
                    moved = true;
                } else {
                    target = sh;
                }
            } else if (flipped) {
                shift = 0;
            } else {
                shift = -shift;
                target = initial;
                flipped = true;
            }
        }
        if (!moved) destroyed = true;
    }
    if (destroyed) {
        deleteUnit(s, ui);
        events.push(.unit_destroyed, u.uid);
    }
}

/// Grid.occupyByHole: a hole swallows a standing scattered stone.
fn occupyByHole(s: *State, cell: Cell) void {
    if (!cellWithinGrid(cell)) return;
    _ = terrain.clearScatteredMountainAt(s, cell);
    setOcc(s, cell, st.HOLE);
}

fn applyNarrowing(s: *State, encounter_current: bool, events: *Events) void {
    const f = &s.fight;
    if (f.lap > NUMBER_OF_LAPS_TILL_STOP_NARROWING) return;
    const calculated = @divFloor(f.lap - @as(i32, if (encounter_current) 1 else 0), f.laps_till_narrowing) + f.additional_narrowing_laps;
    if (calculated < 1) return;
    const total = @min(calculated, MAX_HOLE_LAYERS);
    const max_cell_x: i32 = 8;
    const min_cell_x: i32 = -8;
    const max_cell_y: i32 = 16;
    const min_cell_y: i32 = 0;
    var layer: i32 = 1;
    while (layer <= total) : (layer += 1) {
        const off = layer - 1;
        var i = min_cell_x + off;
        while (i < max_cell_x - off) : (i += 1) {
            const c = Cell{ .x = i + max_cell_x, .y = off };
            moveUnitTowardsCenter(s, c, .up, layer, events);
            occupyByHole(s, c);
        }
        i = min_cell_x + off;
        while (i < max_cell_x - off) : (i += 1) {
            const c = Cell{ .x = i + max_cell_x, .y = max_cell_y - layer };
            moveUnitTowardsCenter(s, c, .down, layer, events);
            occupyByHole(s, c);
        }
        i = min_cell_y + off;
        while (i < max_cell_y - off) : (i += 1) {
            const c = Cell{ .x = off, .y = i };
            moveUnitTowardsCenter(s, c, .right, layer, events);
            occupyByHole(s, c);
        }
        i = min_cell_y + off;
        while (i < max_cell_y - off) : (i += 1) {
            const c = Cell{ .x = (max_cell_x << 1) - layer, .y = i };
            moveUnitTowardsCenter(s, c, .left, layer, events);
            occupyByHole(s, c);
        }
    }
}

/// Unit.applyArmageddonDamage's amount (the caller applies it).
fn armageddonDamage(u: *const Unit, wave: i32) f64 {
    if (wave <= 0 or wave > NUMBER_OF_ARMAGEDDON_WAVES) return 0;
    const part = @as(f64, @floatFromInt(wave)) / @as(f64, @floatFromInt(NUMBER_OF_ARMAGEDDON_WAVES));
    const total = u.amount_died + u.amount_alive;
    const dmg = if (wave == 1)
        @max(MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE, @floor(u.max_hp * total * part))
    else
        @ceil(total * part) * u.max_hp;
    return dmg;
}

fn applyArmageddon(s: *State, units: []const u8, events: *Events) void {
    const wave = armageddonWave(&s.fight);
    if (wave <= 0 or wave > NUMBER_OF_ARMAGEDDON_WAVES) return;
    for (units) |ui| {
        const u = &s.units[ui];
        if (u.isDead() or !u.in_holder) continue;
        _ = applyDamage(s, ui, armageddonDamage(u, wave));
        events.push(.armageddon_applied, u.uid);
        if (u.isDead()) {
            // deleteUnitById(id, wave === 1): the first wave lets a Resurrection holder revive in place.
            if (wave == 1 and tryRevive(s, ui)) continue;
            deleteUnit(s, ui);
            events.push(.unit_destroyed, u.uid);
        }
    }
}

fn applyMoraleRolls(s: *State, units: []const u8) void {
    for (units) |ui| {
        const u = &s.units[ui];
        const m = getMorale(u);
        if (m == 0) continue;
        const chance: f64 = @floatFromInt(s.rng.int(0, 100));
        if (chance >= @abs(m)) continue;
        if (m > 0) {
            abilities.pushChecked(s, &u.buffs, .{ .id = .morale, .laps = 1, .power = 0 });
            s.fight.morale_plus_q.push(ui);
        } else {
            abilities.pushChecked(s, &u.debuffs, .{ .id = .dismorale, .laps = 1, .power = 0 });
            s.fight.morale_minus_q.push(ui);
        }
    }
}

fn handleLapTransition(s: *State, o: *const Ordered, all_made: bool, damage_dealt: bool, events: *Events) void {
    for (o.right.slice()) |ui| {
        s.units[ui].responded = false;
        s.units[ui].on_hourglass = false;
    }
    for (o.left.slice()) |ui| {
        s.units[ui].responded = false;
        s.units[ui].on_hourglass = false;
    }
    const f = &s.fight;
    if (damage_dealt and f.lap >= 0 and f.lap < 128) f.damage_laps |= @as(u128, 1) << @intCast(f.lap);
    if (f.first_turn_made) {
        flipLap(f);
        // SmokeClouds.minusAllLaps, then Vines.minusAllLaps: each entry loses a lap and goes at 0.
        if (f.n_smoke != 0) smokeMinusAllLaps(f);
        if (f.n_vines != 0) vinesMinusAllLaps(f);
        // The lava dries once getLapsNarrowed() (this transition's lap, the additional laps before this
        // transition's increment) reaches the laps till narrowing. runMatch never passes centerAlreadyDried.
        if (f.grid_type == st.GridType.LAVA_CENTER and terrain.lapsNarrowed(f) >= f.laps_till_narrowing) terrain.cleanupCenterObstacle(s);
    }

    var lr: UnitList = .{};
    for (o.left.slice()) |ui| lr.push(ui);
    for (o.right.slice()) |ui| lr.push(ui);
    applyArmageddon(s, lr.slice(), events);
    var refreshed = orderedTurnUnits(s);
    if (finishFightIfNeeded(s, &refreshed, events)) return;

    const decreased = haveDistancesDecreased(s);
    if (all_made and (!decreased or isNarrowingLap(f))) {
        var encounter_current = false;
        const prev_lap = f.lap - 1;
        const prev_damage = prev_lap >= 0 and prev_lap < 128 and (f.damage_laps & (@as(u128, 1) << @intCast(prev_lap))) != 0;
        if (!decreased and !prev_damage and !isNarrowingLap(f)) {
            f.additional_narrowing_laps += 1;
            encounter_current = true;
        }
        applyNarrowing(s, encounter_current, events);
        f.steps_morale_multiplier += STEPS_MORALE_MULTIPLIER;
        refreshStackPowerForAllUnits(s);
        refreshed = orderedTurnUnits(s);
    }

    for (refreshed.all.slice()) |ui| {
        const u = &s.units[ui];
        if (u.buffs.find(.morale) != null) u.buffs.delete(.morale);
        if (u.debuffs.find(.dismorale) != null) u.debuffs.delete(.dismorale);
    }
    refreshStackPowerForAllUnits(s);
    applyMoraleRolls(s, refreshed.all.slice());
    prefetchNextUnits(s, refreshed.right.slice(), refreshed.left.slice());
}

// =====================================================================================================================
// Activation and turn completion
// =====================================================================================================================

/// Vines.minusAllLaps: in Map order, laps-- (never below 0), an entry at 0 is deleted (the rest keep their order).
fn vinesMinusAllLaps(f: *st.Fight) void {
    var w: usize = 0;
    for (f.vines[0..f.n_vines]) |v_in| {
        var v = v_in;
        if (v.laps > 0) v.laps -= 1;
        if (v.laps <= 0) {
            f.vine_cells[v.x] &= ~(@as(u16, 1) << @intCast(v.y));
            continue;
        }
        f.vines[w] = v;
        w += 1;
    }
    f.n_vines = @intCast(w);
}

/// SmokeClouds.minusAllLaps: in Map order, laps-- (never below 0), an entry at 0 is deleted (the rest keep their order).
fn smokeMinusAllLaps(f: *st.Fight) void {
    var w: usize = 0;
    for (f.smoke[0..f.n_smoke]) |c_in| {
        var c = c_in;
        if (c.laps > 0) c.laps -= 1;
        if (c.laps <= 0) {
            f.smoke_cells[c.x] &= ~(@as(u16, 1) << @intCast(c.y));
            continue;
        }
        f.smoke[w] = c;
        w += 1;
    }
    f.n_smoke = @intCast(w);
}

/// SmokeClouds.add (Map.set): a smoked cell takes the new laps in place, a new one is appended.
pub fn addSmoke(s: *State, c: Cell, laps: f64) void {
    const f = &s.fight;
    const l: i16 = @intFromFloat(laps);
    if (f.hasSmoke(c.x, c.y)) {
        for (f.smoke[0..f.n_smoke]) |*e| {
            if (e.x == c.x and e.y == c.y) {
                e.laps = l;
                return;
            }
        }
    }
    if (f.n_smoke >= st.MAX_SMOKE) {
        s.overflow = true;
        return;
    }
    f.smoke[f.n_smoke] = .{ .x = @intCast(c.x), .y = @intCast(c.y), .laps = l };
    f.n_smoke += 1;
    f.smoke_cells[@intCast(c.x)] |= @as(u16, 1) << @intCast(c.y);
}

/// dispelSmokeOnOccupiedCells: the clouds on those of `cells` that `ui` is registered on go (the rest keep their order).
pub fn dispelSmoke(s: *State, ui: u8, cells: []const Cell) void {
    const f = &s.fight;
    for (cells) |c| {
        if (f.n_smoke == 0) return;
        if (!cellWithinGrid(c) or occ(s, c) != ui + 1 or !f.hasSmoke(c.x, c.y)) continue;
        var w: usize = 0;
        for (f.smoke[0..f.n_smoke]) |e| {
            if (e.x == c.x and e.y == c.y) continue;
            f.smoke[w] = e;
            w += 1;
        }
        f.n_smoke = @intCast(w);
        f.smoke_cells[@intCast(c.x)] &= ~(@as(u16, 1) << @intCast(c.y));
    }
}

/// Vines.add (Map.set): a vined cell is replaced in place (laps and team reset, its position kept), a new one appended.
pub fn addVine(s: *State, c: Cell, laps: f64, team: u8) void {
    const f = &s.fight;
    const l: i16 = @intFromFloat(laps);
    if (f.hasVine(c.x, c.y)) {
        for (f.vines[0..f.n_vines]) |*v| {
            if (v.x == c.x and v.y == c.y) {
                v.laps = l;
                v.team = team;
                return;
            }
        }
    }
    if (f.n_vines >= st.MAX_VINES) {
        s.overflow = true;
        return;
    }
    f.vines[f.n_vines] = .{ .x = @intCast(c.x), .y = @intCast(c.y), .laps = l, .team = team };
    f.n_vines += 1;
    f.vine_cells[@intCast(c.x)] |= @as(u16, 1) << @intCast(c.y);
}

/// GameActionEngine.snareOnVineArrival: a unit whose footprint ends a move on an ENEMY vine is snared (no save), unless
/// it already carries the snare; the debuff lasts a lap longer (the mover is the active unit).
pub fn snareOnVineArrival(s: *State, ui: u8, cells: []const Cell) void {
    const f = &s.fight;
    const u = &s.units[ui];
    if (f.n_vines == 0 or u.isDead() or u.debuffs.find(.vine_throw) != null) return;
    var snared = false;
    for (cells) |c| {
        if (f.vineTeam(c.x, c.y)) |team| {
            if (team != u.team) snared = true;
        }
    }
    if (!snared) return;
    const cfg = &s.spell_cfg[@intFromEnum(st.CastSpell.vine_throw)];
    if (!cfg.loaded) {
        s.overflow = true; // the recording carries no Vine Throw config
        return;
    }
    abilities.pushChecked(s, &u.debuffs, .{ .id = .vine_throw, .laps = cfg.laps + 1, .power = cfg.power });
}

/// maxCellsForStepBudget: a vine strider (In Its Own World) with vines on the board walks vined cells for free, so the
/// board bounds its walk; everyone else pays at least a step per cell.
pub fn maxCellsForStepBudget(s: *const State, u: *const Unit) f64 {
    if (s.fight.n_vines != 0 and u.has(.in_its_own_world)) return st.GRID * st.GRID;
    return @max(1, @ceil(getSteps(u)));
}

/// AttackHandler.canLandRangeAttack(unit, grid.getEnemyAggrMatrixByUnitId(id)): range capable, not pinned by melee,
/// shots left, and no Range Null Field Aura row (the debuff list, not Break-aware; no Rangebane in scope).
pub fn canLandRangeAttack(s: *const State, u: *const Unit) bool {
    if (!isRangeCapable(u)) return false;
    const aggr = enemyAggr(s, u);
    const cells = cellsForPosition(u.pos_x, u.pos_y, u.fw, u.fh);
    for (cells.slice()) |c| {
        if (c.x < 0 or c.x >= st.GRID or c.y < 0 or c.y >= st.GRID) continue;
        if (aggr[@intCast(c.x)][@intCast(c.y)] > 1) return false;
    }
    if (getRangeShots(u) <= 0) return false;
    return !nullFielded(s, u) and !rangebaned(s, u);
}

/// hasDebuffActive("Range Null Field Aura"), only on battles where a field can stand.
pub inline fn nullFielded(s: *const State, u: *const Unit) bool {
    return s.null_field and u.debuffs.len != 0 and u.debuffs.find(.range_null_field_aura) != null;
}

/// Unit.refreshPossibleAttackTypes: a MAGIC creature with charges (and not Broken) leads with MAGIC, every other caster
/// gets MAGIC last; an active No Melee leaves the melee type out, and an empty list is [NO_ATTACK].
fn refreshPossibleAttackTypes(u: *Unit, can_land_range: bool) void {
    u.n_possible = 0;
    const casts = u.n_book != 0 and u.spellsCount() > 0;
    if (u.attack_type == AT.MAGIC and casts) {
        u.possible[u.n_possible] = AT.MAGIC;
        u.n_possible += 1;
    } else if (u.attack_type == AT.RANGE and getRangeShots(u) > 0 and can_land_range) {
        u.possible[u.n_possible] = AT.RANGE;
        u.n_possible += 1;
    }
    if (!u.has(.no_melee)) {
        u.possible[u.n_possible] = if (u.attack_type == AT.MELEE_MAGIC) AT.MELEE_MAGIC else AT.MELEE;
        u.n_possible += 1;
    }
    if (!possibleIncludes(u, AT.RANGE) and u.attack_type != AT.RANGE and getRangeShots(u) > 0 and u.shot_distance > 0 and can_land_range) {
        u.possible[u.n_possible] = AT.RANGE;
        u.n_possible += 1;
    }
    if (casts and !possibleIncludes(u, AT.MAGIC)) {
        u.possible[u.n_possible] = AT.MAGIC;
        u.n_possible += 1;
    }
    if (u.n_possible == 0) {
        u.possible[0] = AT.NO_ATTACK;
        u.n_possible = 1;
    }
    u.attack_type_selected = u.possible[0];
}

pub fn possibleIncludes(u: *const Unit, t: u8) bool {
    for (u.possible[0..u.n_possible]) |x| if (x == t) return true;
    return false;
}

const Activation = enum { ready, poisoned, skipped };

/// TurnEngine.activateNextUnit. `poisoned`: the unit's poison tick killed it (it is deleted, and the caller emits
/// unit_destroyed after next_unit_selected; the tick runs no stat refresh and grants no morale). `skipped`: the unit
/// is stunned (isSkippingThisTurn), and the caller completes its turn as a skip after next_unit_selected.
fn activateNextUnit(s: *State, ui: u8) Activation {
    const u = &s.units[ui];
    u.moved_this_turn = false;
    u.moved_route_cells = 0;
    u.on_hourglass = false;
    // startTurn's timers are not modelled; stacksToAct refreshes the team counts.
    for ([_]u8{ Team.LEFT, Team.RIGHT }) |side| {
        var n: i32 = 0;
        for (s.holderOrder()) |i| {
            const x = &s.units[i];
            if (x.team == side and !x.isDead()) n += 1;
        }
        s.fight.team_units_alive[side] = n;
    }
    // refreshPreTurnState: the Web lock is snapshotted now, then Wild Regeneration refills the top creature (before
    // the poison tick; a stunned or re-activated unit too).
    u.web_locked = canFly(u) and u.debuffs.len != 0 and u.debuffs.find(.web_aura) != null;
    if (u.ability_mask & st.AbilityId.wild_regeneration.bit() != 0 and u.hp != u.max_hp and !u.isBroken()) u.hp = u.max_hp;
    if (u.effects.len != 0) {
        if (u.effects.power(.poison)) |poison| {
            if (poison > 0) {
                _ = applyDamage(s, ui, poison);
                if (u.isDead()) {
                    deleteUnit(s, ui);
                    return .poisoned;
                }
            }
        }
    }
    refreshPossibleAttackTypes(u, canLandRangeAttack(s, u));
    s.fight.first_turn_made = true;
    // isSkippingThisTurn: Stun, Blindness or Freeze, or a Whirlpool debuff.
    return if (u.isSkipping() or u.whirlpooled()) .skipped else .ready;
}

/// One list's pass of Unit.minusLap: each entry loses a lap (sentinel counts excepted) and is deleted at 0.
fn minusLapList(list: anytype) void {
    var i: usize = 0;
    while (i < list.len) {
        const e = &list.items[i];
        if (e.laps > 0 and e.laps != st.LAPS_AURA and e.laps != st.NUMBER_OF_LAPS_TOTAL) e.laps -= 1;
        if (e.laps != 0) i += 1 else list.removeAt(i);
    }
}

/// Unit.minusLap: Dismorale holds the effects and debuffs, Morale holds the buffs.
fn minusLap(u: *Unit) void {
    const dismorale = hasDismorale(u);
    if (!dismorale) minusLapList(&u.effects);
    if (!hasMoraleBuff(u)) minusLapList(&u.buffs);
    if (!dismorale) {
        if (hasDuplicateName(&u.debuffs)) minusLapDuplicates(&u.debuffs) else minusLapList(&u.debuffs);
    }
}

fn hasDuplicateName(list: anytype) bool {
    if (list.len < 2) return false;
    const items = list.items[0..list.len];
    for (items, 0..) |a, i| {
        for (items[i + 1 ..]) |b| if (a.id == b.id) return true;
    }
    return false;
}

/// Unit.minusLap's loop over a list holding duplicate names (a mirrored Spit Ball debuff): for each object row in order,
/// its laps tick (sentinels excepted) and, while not 0, EVERY display entry of the name ticks (display sentinels
/// excepted); a row reaching 0 deletes the name (all rows), and the name's later rows are then detached and change
/// nothing. Names are independent, so each is resolved at its first row.
fn minusLapDuplicates(list: anytype) void {
    var done: u64 = 0;
    var i: usize = 0;
    while (i < list.len) {
        const id = list.items[i].id;
        const bit = @as(u64, 1) << @intCast(@intFromEnum(id));
        if (done & bit != 0) {
            i += 1;
            continue;
        }
        done |= bit;
        // The name's rows (object identities) at the start of the tick.
        var rows: [@TypeOf(list.*).capacity]u8 = undefined;
        var n: usize = 0;
        for (list.items[i..list.len], i..) |e, k| {
            if (e.id == id) {
                rows[n] = @intCast(k);
                n += 1;
            }
        }
        var deleted = false;
        for (rows[0..n]) |k| {
            const e = &list.items[k];
            if (e.laps != st.LAPS_AURA and e.laps != st.NUMBER_OF_LAPS_TOTAL and e.laps > 0) e.laps -= 1;
            if (e.laps != 0) {
                // This row's own display entry falls with its laps (lag kept); the name's other entries fall too.
                for (rows[0..n]) |r| {
                    if (r == k) continue;
                    const other = &list.items[r];
                    const shown = other.shownLaps();
                    if (shown != st.LAPS_AURA and shown != st.NUMBER_OF_LAPS_TOTAL) other.lag += 1;
                }
            } else {
                list.delete(id);
                deleted = true;
                break;
            }
        }
        if (!deleted) i += 1;
    }
}

/// TurnEngine.completeTurn
pub fn completeTurn(s: *State, ui: u8, hourglass: bool, skip: bool, events: *Events) void {
    const u = &s.units[ui];
    if (skip) {
        changeMorale(u, MORALE_CHANGE_FOR_SKIP, false);
        events.push(.unit_skipped, u.uid);
    }
    if (!hourglass) {
        minusLap(u);
        s.fight.made |= unitBit(ui);
        _ = s.fight.up_next.removeOnce(ui);
        u.on_hourglass = false;
    }
    refreshStackPowerForAllUnits(s);
    u.moved_this_turn = false;
    u.moved_route_cells = 0;
    events.push(.turn_completed, u.uid);
}

/// forceStalledLap (src/simulation/turn_recovery.ts), between engine calls when an advance() used up its attempts with
/// no unit activated: every living holder unit is marked as having made its turn (addAlreadyMadeTurn: no events, no
/// morale, no lap tick, no draw), so the next advance flips the lap. Returns whether any unit was marked.
pub fn forceStalledLap(s: *State) bool {
    var forced = false;
    for (s.holderOrder()) |i| {
        if (s.units[i].isDead()) continue;
        s.fight.made |= unitBit(i);
        forced = true;
    }
    return forced;
}

fn advance(s: *State, damage_dealt: bool, events: *Events) void {
    var o = orderedTurnUnits(s);
    if (finishFightIfNeeded(s, &o, events)) return;
    const f = &s.fight;
    const init_first_lap = f.lap == 1 and f.hourglass_q.len == 0 and f.up_next.len == 0;
    var all_made = true;
    for (o.right.slice()) |ui| if (f.made & unitBit(ui) == 0) {
        all_made = false;
    };
    for (o.left.slice()) |ui| if (f.made & unitBit(ui) == 0) {
        all_made = false;
    };
    if ((init_first_lap or all_made) and !f.finished) {
        handleLapTransition(s, &o, all_made, damage_dealt, events);
        o = orderedTurnUnits(s);
    }
    if (f.finished) return;
    if (finishFightIfNeeded(s, &o, events)) return;
    prefetchNextUnits(s, o.right.slice(), o.left.slice());

    var next: ?u8 = f.up_next.shift();
    while (next) |n| {
        const nu = &s.units[n];
        if (nu.in_holder and !nu.isDead()) break;
        if (f.up_next.len == 0) break;
        next = f.up_next.shift();
    }
    if (next) |n| {
        const nu = &s.units[n];
        if (!nu.in_holder or nu.isDead()) return;
        const activation = activateNextUnit(s, n);
        events.push(.next_unit_selected, nu.uid);
        switch (activation) {
            .ready => {},
            .poisoned => events.push(.unit_destroyed, nu.uid),
            // completeTurn(unit, { skipReason: "effect" }): the skip's morale, unit_skipped, the lap and turn_completed
            .skipped => completeTurn(s, n, false, true, events),
        }
    }
}

// =====================================================================================================================
// Actions (GameActionEngine)
// =====================================================================================================================

const Reject = error{Rejected};

/// validateActionUnit
pub fn validateActionUnit(s: *const State, ui: u8) Reject!void {
    if (!s.fight.started or s.fight.finished) return error.Rejected;
    if (ui >= s.n_units or !s.units[ui].in_holder) return error.Rejected;
    if (s.active >= 0 and s.active != ui) return error.Rejected;
}

/// validateTurnAction
pub fn validateTurnAction(s: *const State, ui: u8) Reject!void {
    try validateActionUnit(s, ui);
    if (s.fight.made & unitBit(ui) != 0) return error.Rejected;
}

/// UnitsHolder.increaseUnitsSupplyIfNeededPerTeam -> Unit.increaseSupply: the Life supply synergy grows every holder
/// unit of the team (dead or unplaced ones too) before the fight starts; hp and amount_died stay.
fn increaseUnitsSupplyIfNeededPerTeam(s: *State, team: u8) void {
    if (s.fight.started or s.fight.finished) return;
    const pct = s.setup[team].supply;
    if (pct <= 0) return;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.team != team) continue;
        u.init.amount_alive = @floor(u.init.amount_alive * (1 + pct / 100));
        u.amount_alive = u.init.amount_alive;
    }
}

fn startFight(s: *State) bool {
    if (s.fight.started or s.fight.finished) return false;
    const left = aliveTeam(s, Team.LEFT).len;
    const right = aliveTeam(s, Team.RIGHT).len;
    if (left == 0 or right == 0) return false;
    increaseUnitsSupplyIfNeededPerTeam(s, Team.LEFT);
    increaseUnitsSupplyIfNeededPerTeam(s, Team.RIGHT);
    _ = haveDistancesDecreased(s);
    // Barrel Barricade: each owning team's two barrels (LEFT first), before fightProperties.startFight.
    if (s.artifacts or s.setup[Team.LEFT].artifact_t1 == 11 or s.setup[Team.RIGHT].artifact_t1 == 11) artifacts.placeBarrels(s);
    s.fight.started = true;
    s.fight.team_units_alive[Team.LEFT] = left;
    s.fight.team_units_alive[Team.RIGHT] = right;
    refreshStackPowerForAllUnits(s);
    abilities.seedEmberCovenant(s);
    return true;
}

fn endTurn(s: *State, ui: u8, reason: rec.EndReason, events: *Events) Reject!void {
    try validateTurnAction(s, ui);
    const forced = reason != .manual;
    const did_nothing = !s.units[ui].moved_this_turn;
    completeTurn(s, ui, false, forced or did_nothing, events);
}

/// canWaitOnHourglass (src/engine/hourglass.ts; no Time Denial in scope): a LEFT or RIGHT unit that has not moved, with an
/// unacted living teammate (hasUnactedTeammate), not on the hourglass, queued, done or already waited this lap.
pub fn canWaitOnHourglass(s: *const State, ui: u8) bool {
    const u = &s.units[ui];
    if (u.team != Team.LEFT and u.team != Team.RIGHT) return false;
    if (u.moved_this_turn) return false;
    var unacted = false;
    if (s.fight.team_units_alive[u.team] > 1) {
        for (s.holderOrder()) |i| {
            const x = &s.units[i];
            if (i != ui and !x.isDead() and x.team == u.team and s.fight.made & unitBit(i) == 0) unacted = true;
        }
    }
    return unacted and !u.on_hourglass and !s.fight.hourglass_q.includes(ui) and s.fight.made & unitBit(ui) == 0 and s.fight.hourglass_set & unitBit(ui) == 0;
}

fn waitTurn(s: *State, ui: u8, events: *Events) Reject!void {
    try validateTurnAction(s, ui);
    const u = &s.units[ui];
    if (u.moved_this_turn) return error.Rejected;
    if (!canWaitOnHourglass(s, ui)) return error.Rejected;
    changeMorale(u, MORALE_CHANGE_FOR_CLOCK, false);
    u.on_hourglass = true;
    s.fight.hourglass_set |= unitBit(ui);
    s.fight.hourglass_q.push(ui);
    completeTurn(s, ui, true, false, events);
}

fn defendTurn(s: *State, ui: u8, events: *Events) Reject!void {
    try validateTurnAction(s, ui);
    const u = &s.units[ui];
    if (u.debuffs.len != 0 and u.debuffs.find(.misfortune) != null) {
        // applyLuckShield under Misfortune (luckIsPinnedByMisfortune): no +3, and the lap's roll is dropped.
        u.luck_mod = 0;
        u.luck_per_turn = 0;
    } else {
        var luck_mod = LUCK_CHANGE_FOR_SHIELD;
        if (luck_mod + u.luck > LUCK_MAX) luck_mod = LUCK_MAX - u.luck;
        u.luck_mod = luck_mod;
        u.luck_per_turn = luck_mod;
    }
    changeMorale(u, MORALE_CHANGE_FOR_SHIELD, false);
    completeTurn(s, ui, false, false, events);
}

fn selectAttackType(s: *State, ui: u8, t: u8) Reject!void {
    try validateActionUnit(s, ui);
    const u = &s.units[ui];
    if (u.attack_type_selected == t) return;
    if ((t == AT.MELEE and possibleIncludes(u, AT.MELEE)) or (t == AT.MELEE_MAGIC and possibleIncludes(u, AT.MELEE_MAGIC))) {
        u.attack_type_selected = if (possibleIncludes(u, AT.MELEE_MAGIC)) AT.MELEE_MAGIC else AT.MELEE;
        return;
    }
    if (t == AT.RANGE and getRangeShots(u) != 0 and possibleIncludes(u, AT.RANGE)) {
        u.attack_type_selected = AT.RANGE;
        return;
    }
    if (t == AT.MAGIC and u.canCastSpells() and possibleIncludes(u, AT.MAGIC)) {
        u.attack_type_selected = AT.MAGIC;
        return;
    }
    return error.Rejected;
}

/// PathHelper.areCellsFormingFootprint
fn formsFootprint(cells: []const Cell, w: u8, h: u8) bool {
    if (cells.len != @as(usize, w) * h) return false;
    var x0: i32 = std.math.maxInt(i32);
    var x1: i32 = std.math.minInt(i32);
    var y0: i32 = std.math.maxInt(i32);
    var y1: i32 = std.math.minInt(i32);
    for (cells, 0..) |c, i| {
        if (!cellWithinGrid(c)) return false;
        for (cells[0..i]) |p| if (p.x == c.x and p.y == c.y) return false;
        x0 = @min(x0, c.x);
        x1 = @max(x1, c.x);
        y0 = @min(y0, c.y);
        y1 = @max(y1, c.y);
    }
    return x1 - x0 == @as(i32, w) - 1 and y1 - y0 == @as(i32, h) - 1;
}

fn sameCellSet(a: []const Cell, b: []const Cell) bool {
    if (a.len != b.len) return false;
    outer: for (a) |x| {
        for (b) |y| if (x.x == y.x and x.y == y.y) continue :outer;
        return false;
    }
    return true;
}

/// GameActionEngine.groundRouteCrossesObstacle: a walker's footprint at some anchor of the route stands on "B" (lava
/// is not a ground obstacle here; flyers are exempt).
pub fn groundRouteCrossesObstacle(s: *const State, u: *const Unit, route: []const Cell) bool {
    // TypeScript tests "B" on every map (artifact barrels stand off BLOCK_CENTER too).
    if (canFly(u) or (s.fight.grid_type != st.GridType.BLOCK_CENTER and !terrain.hasScatteredMountains(s))) return false;
    for (route) |anchor| {
        const fp = cellsForAnchor(anchor, u.fw, u.fh);
        for (fp.slice()) |c| {
            if (cellWithinGrid(c) and occ(s, c) == st.BLOCK) return true;
        }
    }
    return false;
}

/// applyDistanceMoraleModifier
pub fn applyDistanceMorale(s: *State, ui: u8, from: [2]f64, to: [2]f64) void {
    const u = &s.units[ui];
    const enemy = opposite(u.team);
    const before = distanceToEnemyCentroid(s, enemy, from[0], from[1]);
    const after = distanceToEnemyCentroid(s, enemy, to[0], to[1]);
    if (after < before) {
        changeMorale(u, MORALE_CHANGE_FOR_DISTANCE, true);
    } else if (after > before) {
        changeMorale(u, MORALE_CHANGE_FOR_DISTANCE, false);
    }
}

fn moveUnit(s: *State, ui: u8, path: []const Cell, target_cells: []const Cell) Reject!void {
    try validateTurnAction(s, ui);
    const u = &s.units[ui];
    if (!u.canMove()) return error.Rejected; // move_not_available (the Web lock)
    if (path.len == 0) return error.Rejected;
    if (target_cells.len == 0) return error.Rejected; // the fallback is unreachable: v0.1 always supplies them
    if (!formsFootprint(target_cells, u.fw, u.fh)) return error.Rejected;
    // isMovePathFootprintOnly
    const one_cell = u.fw == 1 and u.fh == 1;
    var footprint_only = !one_cell and sameCellSet(path, target_cells);
    const anchor = baseCell(u);
    if (footprint_only and (u.fw == 1 or u.fh == 1) and path.len > 1 and path[0].x == anchor.x and path[0].y == anchor.y) footprint_only = false;
    if (footprint_only) return error.Rejected; // never produced by v0.1; not ported
    const travelled = if (path[0].x == anchor.x and path[0].y == anchor.y) path[1..] else path;
    const max_cells = maxCellsForStepBudget(s, u);
    if (travelled.len == 0 or @as(f64, @floatFromInt(travelled.len)) > max_cells) return error.Rejected;
    var prev = anchor;
    for (travelled) |c| {
        if (!cellWithinGrid(c)) return error.Rejected;
        const dx = @abs(c.x - prev.x);
        const dy = @abs(c.y - prev.y);
        if ((dx == 0 and dy == 0) or dx > 1 or dy > 1) return error.Rejected;
        prev = c;
    }
    if (groundRouteCrossesObstacle(s, u, path)) return error.Rejected; // move_blocked
    if (!cellsFreeFor(s, ui, target_cells)) return error.Rejected;
    const from = [2]f64{ u.pos_x, u.pos_y };
    const to = positionForCells(target_cells) orelse return error.Rejected;
    _ = finishDirectedMove(s, ui, target_cells, to, null) orelse return error.Rejected;
    // applyRouteMoveModifiers: getTravelledRoute strips nothing here; the route is non-empty. Distance morale, Crusade
    // over the travelled route (the path minus its origin), then applyLavaWaterModifier (Made of Fire on a lava route).
    applyDistanceMorale(s, ui, from, to);
    if (s.crusade) crusade(u, travelled.len);
    if (s.artifacts) artifacts.lavaRoute(s, ui, s.action_lava);
    snareOnVineArrival(s, ui, target_cells);
    u.moved_this_turn = true;
    u.moved_route_cells = @floatFromInt(path.len); // setMovedRouteCellsThisTurn(action.path.length)
}

// =====================================================================================================================
// Entry points
// =====================================================================================================================

/// The name behind the last UnsupportedAbility / UnsupportedSpell load error (diagnostics only).
pub var unsupported_name: []const u8 = "";

/// The applied_* parallel arrays of a recorded unit (names, laps, powers) as one list.
pub fn loadSpells(comptime List: type, props: std.json.Value, comptime kind: []const u8) !List {
    var list: List = .{};
    const names = rec.get(props, "applied_" ++ kind).array.items;
    const laps = rec.get(props, "applied_" ++ kind ++ "_laps").array.items;
    const powers = rec.get(props, "applied_" ++ kind ++ "_powers").array.items;
    if (names.len > List.capacity) return error.TooManySpells;
    for (names, 0..) |n, i| {
        const id = st.SpellId.fromName(n.string) orelse {
            unsupported_name = n.string;
            return error.UnsupportedSpell;
        };
        list.push(.{ .id = id, .laps = rec.num(laps[i]), .power = rec.num(powers[i]) });
    }
    return list;
}

/// One "first;second" stored-property pair (recorded `buffsSources`, getFirst/SecondSpellProperty): -1 for an empty
/// side; a value that does not fit is refused (only the Sniper Augment's percentages are read in scope).
fn storedProperty(text: []const u8) !i8 {
    if (text.len == 0) return -1;
    const v = std.fmt.parseInt(i32, text, 10) catch return error.UnsupportedBuffProperty;
    if (v < 0 or v > std.math.maxInt(i8)) return error.UnsupportedBuffProperty;
    return @intCast(v);
}

/// The buffs' stored properties from `init.units[].buffsSources` (one "first;second" entry per buff, in buff order):
/// the augments' and, after a setup refresh, the aura rows' source cells. Team blessings store their power there,
/// which the port keeps as the row's power.
fn loadBuffSources(unit: std.json.Value, list: *st.SpellList) !void {
    const srcs = rec.get(unit, "buffsSources");
    if (srcs != .array) return;
    if (srcs.array.items.len != list.len) return error.BuffSourcesMismatch;
    for (srcs.array.items, 0..) |e, i| {
        const b = &list.items[i];
        if (!b.id.isAugment() and b.laps != st.LAPS_AURA and !artifacts.storesProperties(b.id)) continue;
        var parts = std.mem.splitScalar(u8, e.string, ';');
        b.src_x = try storedProperty(parts.next() orelse "");
        b.src_y = try storedProperty(parts.next() orelse "");
    }
}

/// The aura debuff rows' source cells from `init.units[].debuffsSources` (batch-3 recordings with setup: the Web Aura).
fn loadDebuffSources(unit: std.json.Value, list: anytype) !void {
    const srcs = rec.get(unit, "debuffsSources");
    if (srcs != .array) return;
    if (srcs.array.items.len != list.len) return error.BuffSourcesMismatch;
    for (srcs.array.items, 0..) |e, i| {
        const b = &list.items[i];
        if (b.laps != st.LAPS_AURA) continue;
        var parts = std.mem.splitScalar(u8, e.string, ';');
        b.src_x = try storedProperty(parts.next() orelse "");
        b.src_y = try storedProperty(parts.next() orelse "");
    }
}

/// `init.setup.perTeam[team]` (record.ts setupState): the team's synergy values; zero without setup.
pub fn loadTeamSetup(init: std.json.Value, team: u8) st.TeamSetup {
    var key: [4]u8 = undefined;
    const k = std.fmt.bufPrint(&key, "{d}", .{team}) catch unreachable;
    const row = rec.get(rec.get(rec.get(init, "setup"), "perTeam"), k);
    if (row != .object) return .{};
    return .{
        .ability_power = rec.num(rec.get(row, "abilityPower")),
        .movement_steps = rec.num(rec.get(row, "movementSteps")),
        .fly_armor = rec.num(rec.get(row, "flyArmor")),
        .morale = rec.num(rec.get(row, "morale")),
        .luck = rec.num(rec.get(row, "luck")),
        .supply = rec.num(rec.get(row, "supply")),
        .aura_range = rec.num(rec.get(row, "auraRange")),
        .break_chance = rec.num(rec.get(row, "breakChance")),
        .artifact_t1 = artifactId(rec.get(row, "artifactT1")),
        .artifact_t2 = artifactId(rec.get(row, "artifactT2")),
        .placement = artifactId(rec.get(rec.get(row, "augments"), "Placement")),
    };
}

/// A recorded team artifact id (`init.setup.perTeam[team].artifactT1/T2`; 0 when absent).
fn artifactId(v: std.json.Value) u8 {
    return switch (v) {
        .integer => |i| if (i >= 0 and i < 256) @intCast(i) else 0,
        else => 0,
    };
}

/// LUCK_DEPENDENT_BLESSINGS (src/units/units_holder.ts)
const LUCK_DEPENDENT_BLESSINGS = [_][]const u8{
    "Tie up the Horses Blessing",
    "Sharpened Weapons Blessing",
    "Arcane Ward Blessing",
    "Warding Mane Blessing",
    "Arrows Wingshield Blessing",
};

/// The unit's abilities from `props.abilities` and the recorded `getAbilityConfig` / `getEffectConfig` entries (no aura
/// links: loadUnitAbilities is the full loader).
pub fn loadAbilities(init: std.json.Value, props: std.json.Value, u: *Unit) !void {
    const names = rec.get(props, "abilities").array.items;
    try loadAbilityRecords(init, names, names, null, u);
}

/// One configured ability (getAbilityConfig), with the default of the effect it applies.
fn abilityRecord(init: std.json.Value, name: []const u8) !st.Ability {
    const id = st.AbilityId.fromName(name) orelse {
        unsupported_name = name;
        return error.UnsupportedAbility;
    };
    const cfg = rec.get(rec.get(init, "abilityConfigs"), name);
    if (cfg == .null) return error.MissingAbilityConfig;
    var a = st.Ability{
        .id = id,
        .power = rec.num(rec.get(cfg, "power")),
        .power_type = @intCast(rec.int(rec.get(cfg, "power_type"))),
        .ty = @intCast(rec.int(rec.get(cfg, "type"))),
        .stack_powered = rec.get(cfg, "stack_powered") == .bool and rec.get(cfg, "stack_powered").bool,
        .skip_response = rec.get(cfg, "skip_response") == .bool and rec.get(cfg, "skip_response").bool,
    };
    const effect = rec.get(cfg, "effect");
    if (effect == .string) {
        const ecfg = rec.get(rec.get(init, "effectConfigs"), effect.string);
        if (ecfg == .null) return error.MissingEffectConfig;
        const laps = rec.num(rec.get(ecfg, "laps"));
        const power = rec.num(rec.get(ecfg, "power"));
        a.effect_laps = @floatCast(laps);
        a.effect_power = @floatCast(power);
        if (a.effect_laps != laps or a.effect_power != power) return error.UnsupportedEffectConfig;
    }
    return a;
}

/// The active ability list (`active`, the unit's Ability objects in order: config order, then what it stole) and the
/// card names (`cards`, props.abilities: the early luck pass reads them), each ability linked to the aura effect it
/// emits when `s` is given (loadAuras interns the defs).
fn loadAbilityRecords(init: std.json.Value, active: []const std.json.Value, cards: []const std.json.Value, s: ?*State, u: *Unit) !void {
    u.n_abilities = 0;
    u.ability_mask = 0;
    u.luck_dependent = false;
    for (cards) |n| {
        for (LUCK_DEPENDENT_BLESSINGS) |name| {
            if (std.mem.eql(u8, n.string, name)) u.luck_dependent = true;
        }
    }
    for (active) |n| {
        var a = try abilityRecord(init, n.string);
        if (s) |state| {
            const aura = rec.get(rec.get(rec.get(init, "abilityConfigs"), n.string), "aura_effect");
            if (aura == .string) a.aura = try internAura(init, state, aura.string);
        }
        if (u.n_abilities >= st.MAX_ABILITIES) return error.TooManyAbilities;
        u.abilities[u.n_abilities] = a;
        u.n_abilities += 1;
        u.ability_mask |= a.id.bit();
    }
}

/// loadAbilityRecords for a unit of `s`: the active list, the card names and the abilities it lost (`stolen`, names).
pub fn loadUnitAbilities(init: std.json.Value, active: []const std.json.Value, cards: []const std.json.Value, stolen: []const std.json.Value, s: *State, u: *Unit) !void {
    try loadAbilityRecords(init, active, cards, s, u);
    u.n_stolen = 0;
    for (stolen) |n| {
        const id = st.AbilityId.fromName(n.string) orelse {
            unsupported_name = n.string;
            return error.UnsupportedAbility;
        };
        if (u.n_stolen >= st.MAX_STOLEN) return error.TooManyAbilities;
        u.stolen[u.n_stolen] = id;
        u.n_stolen += 1;
    }
}

/// The State.aura_defs index of aura effect `name` (recorded `init.auraEffectConfigs`), interned on first use.
fn internAura(init: std.json.Value, s: *State, name: []const u8) !u8 {
    var buf: [64]u8 = undefined;
    const buff_name = std.fmt.bufPrint(&buf, "{s} Aura", .{name}) catch return error.UnsupportedAura;
    const buff = st.SpellId.fromName(buff_name) orelse {
        unsupported_name = name;
        return error.UnsupportedAura;
    };
    for (s.aura_defs[0..s.n_aura_defs], 0..) |d, k| {
        if (d.buff == buff) return @intCast(k);
    }
    const cfg = rec.get(rec.get(init, "auraEffectConfigs"), name);
    if (cfg == .null) return error.MissingAuraConfig;
    const def = st.AuraDef{
        .buff = buff,
        .range = rec.num(rec.get(cfg, "range")),
        .power = rec.num(rec.get(cfg, "power")),
        .is_buff = rec.get(cfg, "is_buff") == .bool and rec.get(cfg, "is_buff").bool,
        .power_type = @intCast(rec.int(rec.get(cfg, "power_type"))),
    };
    switch (def.power_type) {
        st.PowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR, st.PowerType.POISON_ON_HIT, st.PowerType.ABSORB_DEBUFF, st.PowerType.DISABLE_FLY_MOVEMENT => {},
        // batch 6a: War Anger (the Valkyrie's debuff aura) and Guiding Winds (the Dryad's buff aura)
        st.PowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE, st.PowerType.ADDITIONAL_SHOT_DISTANCE_PERCENTAGE => {},
        // power 0 (calculateAuraPower is never called): the Range Null Field and Disguise
        st.PowerType.DISABLE_RANGE_ATTACK, st.PowerType.UNTARGETABLE => if (def.power != 0) {
            unsupported_name = name;
            return error.UnsupportedAura;
        },
        else => {
            unsupported_name = name;
            return error.UnsupportedAura;
        },
    }
    if (s.n_aura_defs >= st.MAX_AURA_DEFS) return error.TooManyAuras;
    s.aura_defs[s.n_aura_defs] = def;
    s.n_aura_defs += 1;
    return s.n_aura_defs - 1;
}

/// The unit's emitted auras from `props.aura_effects` and the recorded `init.auraEffectConfigs`, interned in
/// State.aura_defs.
pub fn loadAuras(init: std.json.Value, props: std.json.Value, s: *State, u: *Unit) !void {
    u.n_auras = 0;
    const names = rec.get(props, "aura_effects");
    if (names != .array) return;
    for (names.array.items) |n| {
        const idx = try internAura(init, s, n.string);
        if (u.n_auras >= st.MAX_UNIT_AURAS) return error.TooManyAuras;
        u.auras[u.n_auras] = idx;
        u.n_auras += 1;
    }
}

/// The flags that keep the ability-free path cheap (`State.blessings`, `auras`, `stat_hooks`, `augments`) and the configs
/// read without an ability naming them (the Poison laps, the Break effect, the Ember Covenant spell), from the units
/// already loaded into `s` (and the summon templates) and `init`'s effectConfigs / spellConfigs. Clears the Ember
/// Covenant state. Shared by initState and the mid-battle loader (snapshot.zig).
pub fn loadScopeFlags(s: *State, init: std.json.Value) !void {
    s.blessings = false;
    s.auras = false;
    s.stat_hooks = false;
    s.augments = false;
    s.artifacts = false;
    s.spell_hooks = false;
    s.null_field = false;
    s.disguise = false;
    s.unit_hooks = false;
    s.gaze = false;
    s.spit = false;
    s.shot_hooks = false;
    s.spit_cfg = .{st.SpitConfig{}} ** 7;
    s.b6_hooks = false;
    s.war_anger = false;
    s.hamstring = false;
    s.crusade = false;
    s.resurrection = false;
    s.war_anger_def = st.NO_AURA;
    s.hamstrung_laps = 3;
    s.hamstrung_power = 30;
    var spit_holder = false;
    var poisons = false;
    var covenant = false;
    var breaks = false;
    var fire = false;
    var riders = false;
    var crafts = false;
    // A unit can swap Disguise markers: it holds the card (natively or stolen later) or carries the aura row.
    var swaps = false;
    for (s.setup) |row| {
        if (row.break_chance > 0) breaks = true;
    }
    const AB = st.AbilityId;
    const blessing_mask = AB.luck_blessing.bit() | AB.sharpened_weapons_blessing.bit() | AB.arcane_ward_blessing.bit() | AB.rallying_volley_blessing.bit() | AB.sylvan_focus_blessing.bit() | AB.warding_mane_blessing.bit() |
        AB.arrows_wingshield_blessing.bit() | AB.angelic_host_blessing.bit() | AB.tie_up_the_horses_blessing.bit() | AB.wolf_trail_blessing.bit();
    // The batch-6a cards whose rows adjustBaseStats reads (the blessings, Wind Flow, Guiding Winds, Hamstring).
    const b6_mask = AB.arrows_wingshield_blessing.bit() | AB.angelic_host_blessing.bit() | AB.tie_up_the_horses_blessing.bit() | AB.wolf_trail_blessing.bit() |
        AB.wind_flow.bit() | AB.guiding_winds_aura.bit() | AB.hamstring.bit();
    var templates: [st.N_SUMMONS]?*const Unit = .{null} ** st.N_SUMMONS;
    if (s.summons) |sm| {
        for (0..st.N_SUMMONS) |k| {
            if (sm.present[k]) templates[k] = &sm.units[k];
        }
    }
    var all: [st.MAX_UNITS + st.N_SUMMONS]*const Unit = undefined;
    var n_all: usize = 0;
    for (s.units[0..s.n_units]) |*u| {
        all[n_all] = u;
        n_all += 1;
    }
    for (templates) |t| if (t) |u| {
        all[n_all] = u;
        n_all += 1;
    };
    for (all[0..n_all], 0..) |u, k| {
        // The flags say what can ever happen, so they read the configured abilities, Break or not. Abilities only
        // move between units (Predatory Assimilation), so the board's abilities cover every later holder.
        const mask = u.ability_mask;
        if (mask & blessing_mask != 0) s.blessings = true;
        if (u.n_auras != 0) s.auras = true;
        if (mask & (AB.aggr.bit() | AB.wardguard.bit()) != 0 or u.target >= 0) s.stat_hooks = true;
        if (mask & AB.ember_covenant_blessing.bit() != 0) covenant = true;
        if (mask & AB.predatory_assimilation.bit() != 0) poisons = true;
        if (mask & AB.range_null_field_aura.bit() != 0) s.null_field = true;
        if (mask & (AB.unyielding_power.bit() | AB.sky_runner.bit()) != 0) s.unit_hooks = true;
        if (mask & AB.terrifying_gaze.bit() != 0 or u.forbidden != st.NO_UID) s.gaze = true;
        if (mask & AB.disguise_aura.bit() != 0) swaps = true;
        // Battle Roar's row is read where Blessing's is (the castable card holds a charge, the loop below sees it).
        if (mask & AB.battle_roar.bit() != 0) s.spell_hooks = true;
        if (mask & AB.spit_ball.bit() != 0) spit_holder = true;
        if (mask & b6_mask != 0) s.b6_hooks = true;
        if (mask & AB.war_anger_aura.bit() != 0) s.war_anger = true;
        if (mask & AB.hamstring.bit() != 0) s.hamstring = true;
        if (mask & AB.crusade.bit() != 0) s.crusade = true;
        if (mask & AB.resurrection.bit() != 0) s.resurrection = true;
        // Wind Flow's row is read where Battle Roar's is.
        if (mask & AB.wind_flow.bit() != 0) s.spell_hooks = true;
        if (mask & (AB.limited_supply.bit() | AB.endless_quiver.bit() | AB.boost_health.bit()) != 0 or u.range_shots_mod != 0) s.shot_hooks = true;
        if (u.effects.find(.break_) != null) breaks = true;
        // A template's aura links hold SpellId values (loadSummons): only the battle's units index aura_defs.
        const aura_def = struct {
            fn poison(state: *const State, template: bool, d: u8) bool {
                if (template) return d == @intFromEnum(st.SpellId.venom_cloud_aura);
                return state.aura_defs[d].power_type == st.PowerType.POISON_ON_HIT;
            }
        };
        const template = k >= s.n_units;
        for (u.abilities[0..u.n_abilities]) |a| {
            if (a.aura != st.NO_AURA and aura_def.poison(s, template, a.aura)) poisons = true;
        }
        for (u.auras[0..u.n_auras]) |d| {
            if (aura_def.poison(s, template, d)) poisons = true;
        }
        for (u.buffs.items[0..u.buffs.len]) |b| {
            if (blessingRow(b.id)) s.blessings = true;
            if (b.laps == st.LAPS_AURA) s.auras = true;
            if (b.id == .ember_covenant_blessing) covenant = true;
            if (b.id.isAugment()) s.augments = true;
            if (b.id.isArtifact()) s.artifacts = true;
            if (b.id == .lava_striders or b.id == .made_of_fire) fire = true;
            if (b.id == .made_of_fire) s.artifacts = true; // a copied buff outlives its army's rows
            if (b.id == .rime_charm or b.id == .gravechain) riders = true;
            if (b.id == .fireforged_sword) s.swords = true;
            if (b.id == .armor_rune or b.id == .weapon_rune) s.runes = true;
            // Rime Charm inflicts Spit Ball's Quagmire: its holder turns the Spit Ball hooks on.
            if (b.id == .rime_charm) s.spit = true;
            if (b.id == .blessing or b.id == .battle_roar) s.spell_hooks = true;
            if (b.id == .warding_mane_blessing) s.blessings = true;
            if (b.id == .hidden) s.disguise = true;
            if (b.id == .disguise_aura) swaps = true;
            if (b.id.isBatch6Stat()) s.b6_hooks = true;
            if (b.id == .wind_flow) s.spell_hooks = true;
        }
        for (u.debuffs.items[0..u.debuffs.len]) |b| {
            // Gravechain's Gravebound outlives its holder's rows (Rime Charm's Quagmire is Spit Ball's, below).
            if (b.id == .gravebound) s.artifacts = true;
            if (b.laps == st.LAPS_AURA) s.auras = true;
            if (b.id.isSpitBall()) s.spit = true;
            if (b.id == .vine_throw) s.spell_hooks = true;
            if (b.id == .range_null_field_aura) s.null_field = true;
            if (b.id == .visible) s.disguise = true;
            if (b.id == .hamstrung) {
                s.hamstring = true;
                s.b6_hooks = true;
            }
        }
        // Spells move only with Predatory Assimilation, so the board's books cover every later holder.
        if (u.n_book != 0 or u.n_spells != 0) s.spell_hooks = true;
        for (u.spells[0..u.n_spells]) |b| {
            if (b.spell == @intFromEnum(st.CastSpell.fireforged_sword)) s.swords = true;
            // A spent Craft lingers in the parsed book at 0 (its raw entry is gone, and with it the recorded configs).
            if (b.spell == @intFromEnum(st.CastSpell.craft) and b.amount > 0) crafts = true;
            if (b.spell == @intFromEnum(st.CastSpell.armor_rune) or b.spell == @intFromEnum(st.CastSpell.weapon_rune)) s.runes = true;
        }
        if (u.effects.find(.poison) != null) poisons = true;
    }
    // Configs read without an ability naming them (record.ts: effectConfigs.Poison, spellConfigs).
    if (s.auras) s.stat_hooks = true;
    // Spit Ball's seven debuffs (spellConfigs of Death and Order, recorded when a unit holds the card).
    if (spit_holder) {
        s.spit = true;
        for (st.SpellId.SPIT_BALL, 0..) |id, k| {
            const cfg = rec.get(rec.get(init, "spellConfigs"), id.name());
            if (cfg == .null) return error.MissingSpellConfig;
            s.spit_cfg[k] = .{
                .laps = rec.num(rec.get(cfg, "laps")),
                .power = rec.num(rec.get(cfg, "power")),
                .mind = rec.int(rec.get(cfg, "power_type")) == st.SpellPower.MIND,
                .loaded = true,
            };
        }
    }
    // Hamstrung (spells.json Death, recorded in spellConfigs when a unit holds Hamstring): the debuff Hamstring lands.
    if (s.hamstring) {
        const cfg = rec.get(rec.get(init, "spellConfigs"), "Hamstrung");
        if (cfg != .null) {
            s.hamstrung_laps = rec.num(rec.get(cfg, "laps"));
            s.hamstrung_power = rec.num(rec.get(cfg, "power"));
        } else {
            for (all[0..n_all]) |u| {
                if (u.ability_mask & AB.hamstring.bit() != 0) return error.MissingSpellConfig;
            }
        }
    }
    // The War Anger aura def (its range; the holder's attack mod reads the power its AuraEffect holds).
    for (s.aura_defs[0..s.n_aura_defs], 0..) |d, k| {
        if (d.buff == .war_anger_aura) s.war_anger_def = @intCast(k);
    }
    s.poison_laps = st.NUMBER_OF_LAPS_TOTAL;
    if (poisons) {
        const cfg = rec.get(rec.get(init, "effectConfigs"), "Poison");
        if (cfg == .null) return error.MissingEffectConfig;
        s.poison_laps = rec.num(rec.get(cfg, "laps"));
    }
    // effects.json "Break" (laps 2, power 0), recorded with setup; read only when a team can break.
    s.break_laps = 2;
    s.break_power = 0;
    if (breaks) {
        const cfg = rec.get(rec.get(init, "effectConfigs"), "Break");
        if (cfg == .null) return error.MissingEffectConfig;
        s.break_laps = rec.num(rec.get(cfg, "laps"));
        s.break_power = rec.num(rec.get(cfg, "power"));
    }
    // Disguise: the aura's configured range and the System markers (recorded `spellConfigs`: Hidden, Visible).
    s.disguise_range = 0;
    s.hidden_laps = 1;
    s.hidden_power = 0;
    s.visible_laps = 1;
    s.visible_power = 0;
    if (swaps) s.disguise = true;
    if (swaps) {
        const acfg = rec.get(rec.get(init, "auraEffectConfigs"), "Disguise");
        if (acfg == .null) return error.MissingAuraConfig;
        s.disguise_range = rec.num(rec.get(acfg, "range"));
        const hcfg = rec.get(rec.get(init, "spellConfigs"), "Hidden");
        const vcfg = rec.get(rec.get(init, "spellConfigs"), "Visible");
        if (hcfg == .null or vcfg == .null) return error.MissingSpellConfig;
        s.hidden_laps = rec.num(rec.get(hcfg, "laps"));
        s.hidden_power = rec.num(rec.get(hcfg, "power"));
        s.visible_laps = rec.num(rec.get(vcfg, "laps"));
        s.visible_power = rec.num(rec.get(vcfg, "power"));
    }
    // Craft: the four cards it grants and the effects.json Stun it applies by name (recorded `abilityConfigs` /
    // `effectConfigs` when a book holds a Craft charge).
    s.crafted_loaded = false;
    s.craft_stun_laps = 1;
    s.craft_stun_power = 0;
    if (crafts) {
        for ([_][]const u8{ "Crafted Double Punch", "Crafted Double Shot", "Crafted Frozen Sword", "Crafted Frozen Bow" }, 0..) |name, k| {
            s.crafted[k] = try abilityRecord(init, name);
        }
        s.crafted_loaded = true;
        const stun = rec.get(rec.get(init, "effectConfigs"), "Stun");
        if (stun == .null) return error.MissingEffectConfig;
        s.craft_stun_laps = rec.num(rec.get(stun, "laps"));
        s.craft_stun_power = rec.num(rec.get(stun, "power"));
    }
    // Rime Charm / Gravechain rows: the Death "Quagmire" and "Gravebound" debuffs' powers they apply (recorded
    // `spellConfigs`; a debuff already on a unit carries its own).
    s.quagmire_power = 25;
    s.gravebound_power = 25;
    if (riders) {
        const q = rec.get(rec.get(init, "spellConfigs"), "Quagmire");
        const g = rec.get(rec.get(init, "spellConfigs"), "Gravebound");
        if (q == .null or g == .null) return error.MissingSpellConfig;
        s.quagmire_power = rec.num(rec.get(q, "power"));
        s.gravebound_power = rec.num(rec.get(g, "power"));
    }
    // Lava Striders: the System "Made of Fire" buff its lava routes apply (recorded `spellConfigs`).
    s.mof_power = 10;
    s.mof_laps = 2;
    if (fire) {
        const cfg = rec.get(rec.get(init, "spellConfigs"), "Made of Fire");
        if (cfg == .null) return error.MissingSpellConfig;
        s.mof_power = rec.num(rec.get(cfg, "power"));
        s.mof_laps = rec.num(rec.get(cfg, "laps"));
    }
    s.ember_seeded = false;
    s.ember_teams = 0;
    s.ember_laps = st.NUMBER_OF_LAPS_TOTAL;
    s.ember_power = 0;
    if (covenant) {
        const cfg = rec.get(rec.get(init, "spellConfigs"), "Ember Covenant Blessing");
        if (cfg == .null) return error.MissingSpellConfig;
        s.ember_laps = rec.num(rec.get(cfg, "laps"));
        s.ember_power = rec.num(rec.get(cfg, "power"));
    }
}

inline fn blessingRow(id: st.SpellId) bool {
    return switch (id) {
        .luck_blessing, .sharpened_weapons_blessing, .arcane_ward_blessing, .rallying_volley_blessing, .sylvan_focus_blessing => true,
        .arrows_wingshield_blessing, .angelic_host_blessing, .tie_up_the_horses_blessing, .wolf_trail_blessing => true,
        else => false,
    };
}

/// A spell entry's faction prefix ("" for ":Vine Throw").
fn bookPrefix(faction: []const u8) ?u8 {
    for (st.BookEntry.PREFIXES, 0..) |p, k| {
        if (std.mem.eql(u8, p, faction)) return @intCast(k);
    }
    return null;
}

/// One raw "<Faction>:<Name>" entry (unitProperties.spells). A spell outside the port is refused by name.
pub fn parseBookEntry(entry: []const u8) !st.BookEntry {
    const colon = std.mem.indexOfScalar(u8, entry, ':') orelse {
        unsupported_name = entry;
        return error.UnsupportedSpellEntry;
    };
    const spell = st.CastSpell.fromName(entry[colon + 1 ..]) orelse {
        unsupported_name = entry;
        return error.UnsupportedSpellEntry;
    };
    const prefix = bookPrefix(entry[0..colon]) orelse {
        unsupported_name = entry;
        return error.UnsupportedSpellEntry;
    };
    return .{ .spell = @intFromEnum(spell), .prefix = prefix };
}

/// unitProperties.spells as the unit's raw entries, then parseSpells.
pub fn loadBook(u: *Unit, entries: []const std.json.Value) !void {
    u.n_book = 0;
    if (entries.len > st.MAX_BOOK) return error.TooManySpellEntries;
    for (entries) |e| {
        if (e != .string) return error.MalformedSpellEntry;
        u.book[u.n_book] = try parseBookEntry(e.string);
        u.n_book += 1;
    }
    if (!parseBook(u)) return error.TooManySpellEntries;
}

/// Unit.parseSpells: one Spell per distinct normalized entry (normalizeSpellEntry: "System:X" is ":X"), in
/// first-occurrence order, amount = its count; fresh objects, so a spent Spell disappears. False on overflow.
pub fn parseBook(u: *Unit) bool {
    u.n_spells = 0;
    outer: for (u.book[0..u.n_book]) |e| {
        const prefix = e.normalized();
        for (u.spells[0..u.n_spells]) |*b| {
            if (b.spell == e.spell and b.prefix == prefix) {
                b.amount += 1;
                continue :outer;
            }
        }
        if (u.n_spells >= st.MAX_BOOK_SPELLS) return false;
        u.spells[u.n_spells] = .{ .spell = e.spell, .prefix = prefix, .amount = 1 };
        u.n_spells += 1;
    }
    return true;
}

/// One SpellProperties object (getSpellConfig) as the port's config.
pub fn spellConfigOf(cfg: std.json.Value) st.SpellConfig {
    var out: st.SpellConfig = .{
        .power = rec.num(rec.get(cfg, "power")),
        .laps = rec.num(rec.get(cfg, "laps")),
        .min_stack_power = rec.num(rec.get(cfg, "minimal_caster_stack_power")),
        .target = @intCast(rec.int(rec.get(cfg, "spell_target_type"))),
        .power_type = @intCast(rec.int(rec.get(cfg, "power_type"))),
        .multiplier = @intCast(rec.int(rec.get(cfg, "multiplier_type"))),
        .element = @intCast(rec.int(rec.get(cfg, "element"))),
        .is_buff = rec.get(cfg, "is_buff") == .bool and rec.get(cfg, "is_buff").bool,
        .self_cast = rec.get(cfg, "self_cast_allowed") == .bool and rec.get(cfg, "self_cast_allowed").bool,
        .is_giftable = rec.get(cfg, "is_giftable") == .bool and rec.get(cfg, "is_giftable").bool,
        .max_gift_level = rec.num(rec.get(cfg, "maximum_gift_level")),
        .loaded = true,
    };
    const conflicts = rec.get(cfg, "conflicts_with");
    if (conflicts == .array) {
        for (conflicts.array.items) |c| {
            if (c != .string) continue;
            if (st.SpellId.fromName(c.string)) |id| {
                if (out.conflict == null) out.conflict = id;
            }
        }
    }
    return out;
}

/// The configs of the spells in `cfgs` (an object keyed by spell name: a recording's `init.spellConfigs`, the export's
/// `configs.spellConfigs`); names outside the port are skipped.
pub fn loadSpellConfigs(s: *State, cfgs: std.json.Value) void {
    if (cfgs != .object) return;
    var it = cfgs.object.iterator();
    while (it.next()) |e| {
        const spell = st.CastSpell.fromName(e.key_ptr.*) orelse continue;
        if (e.value_ptr.* != .object) continue;
        s.spell_cfg[@intFromEnum(spell)] = spellConfigOf(e.value_ptr.*);
    }
}

/// A recorded unit (a start-state unit or a summon template: `name`, `creatureId`, `level`, `size`, `footprintW/H`,
/// `props` and, after a setup refresh, `initialProps`) as a Unit, without its abilities, lists, position or grid
/// registration.
fn unitFromRecord(u: std.json.Value, name_id: u16) Unit {
    const props = rec.get(u, "props");
    // initialUnitProperties: recorded apart once a setup refresh has folded augments and synergies into props.
    const base = if (rec.get(u, "initialProps") == .object) rec.get(u, "initialProps") else props;
    const pn = struct {
        fn f(v: std.json.Value, key: []const u8) f64 {
            return rec.num(rec.get(v, key));
        }
    }.f;
    const cid = rec.get(u, "creatureId");
    const rv = rec.get(props, "rallying_volley_granted");
    return .{
        .in_holder = true,
        .creature_id = if (cid == .integer) @intCast(cid.integer) else 0,
        .team = @intCast(rec.int(rec.get(u, "team"))),
        .faction = @intCast(rec.int(rec.get(props, "faction"))),
        .level = @intCast(rec.int(rec.get(u, "level"))),
        .size = @intCast(rec.int(rec.get(u, "size"))),
        .fw = @intCast(rec.int(rec.get(u, "footprintW"))),
        .fh = @intCast(rec.int(rec.get(u, "footprintH"))),
        .attack_type = @intCast(rec.int(rec.get(props, "attack_type"))),
        .attack_type_selected = @intCast(rec.int(rec.get(props, "attack_type_selected"))),
        .movement_type = @intCast(rec.int(rec.get(props, "movement_type"))),
        .base = .{ .x = 0, .y = 0 },
        .pos_x = 0,
        .pos_y = 0,
        .cells = undefined,
        .n_cells = 0,
        .max_hp = pn(props, "max_hp"),
        .hp = pn(props, "hp"),
        .steps = pn(props, "steps"),
        .steps_mod = pn(props, "steps_mod"),
        .morale = pn(props, "morale"),
        .luck = pn(props, "luck"),
        .initiative = pn(props, "initiative"),
        .armor_mod = pn(props, "armor_mod"),
        .base_armor = pn(props, "base_armor"),
        .range_armor = pn(props, "range_armor"),
        .base_attack = pn(props, "base_attack"),
        .attack_mod = pn(props, "attack_mod"),
        .attack_damage_min = pn(props, "attack_damage_min"),
        .attack_damage_max = pn(props, "attack_damage_max"),
        .attack_range = pn(props, "attack_range"),
        .range_shots = pn(props, "range_shots"),
        .range_shots_mod = pn(props, "range_shots_mod"),
        .shot_distance = pn(props, "shot_distance"),
        .magic_resist = pn(props, "magic_resist"),
        .magic_resist_mod = pn(props, "magic_resist_mod"),
        .exp = pn(props, "exp"),
        .amount_alive = pn(props, "amount_alive"),
        .amount_died = pn(props, "amount_died"),
        .luck_mod = pn(props, "luck_mod"),
        .attack_multiplier = pn(props, "attack_multiplier"),
        .stack_power = pn(props, "stack_power"),
        .responded = false,
        .on_hourglass = false,
        .moved_this_turn = false,
        .buffs = .{},
        .debuffs = .{},
        .effects = .{},
        .init = .{
            .max_hp = pn(base, "max_hp"),
            .luck = pn(base, "luck"),
            .morale = pn(base, "morale"),
            .base_armor = pn(base, "base_armor"),
            .armor_mod = pn(base, "armor_mod"),
            .base_attack = pn(base, "base_attack"),
            .attack_mod = pn(base, "attack_mod"),
            .attack_damage_min = pn(base, "attack_damage_min"),
            .attack_damage_max = pn(base, "attack_damage_max"),
            .steps = pn(base, "steps"),
            .initiative = pn(base, "initiative"),
            .magic_resist = pn(base, "magic_resist"),
            .shot_distance = pn(base, "shot_distance"),
            .amount_alive = pn(base, "amount_alive"),
        },
        .luck_per_turn = 0,
        .adjusted_laps = 0,
        .dist_known = false,
        .dist_closest_enemy = 0,
        .name_id = name_id,
        .possible = .{ 0, 0, 0, 0 },
        .n_possible = 0,
        .reg = undefined,
        .n_reg = 0,
        .abilities = undefined,
        .n_abilities = 0,
        .ability_mask = 0,
        .luck_dependent = false,
        .moved_route_cells = 0,
        .target = -1,
        .auras = undefined,
        .n_auras = 0,
        .syn_power = 0,
        .rallying_volley_granted = if (rv == .null) 0 else rec.num(rv),
        // The constructor's range_shots (initialUnitProperties never move it; pre-refresh props hold the same value).
        .max_range_shots = pn(base, "range_shots"),
    };
}

/// Interned summon templates (zig/parity/record.ts `init.summonTemplates`, state_export.ts `configs.summonTemplates`):
/// one immutable copy per distinct template text, shared by every State that points at it (process lifetime). Their
/// auras and abilities' aura links hold SpellId values (the defs are interned per battle: spawnInfested maps them).
var summons_lock: std.Thread.Mutex = .{};
var summons_registry: std.ArrayList(struct { text: []u8, summons: *st.Summons }) = .empty;

/// The summon templates of `cfg` (an object with "Arachna Spider" / "Arachna Queen" entries, configs alongside in
/// `init`), interned, with their aura defs interned in `s` too. Null when `cfg` is not an object.
pub fn loadSummons(init: std.json.Value, cfg: std.json.Value, s: *State) !?*const st.Summons {
    if (cfg != .object) return null;
    var sm: st.Summons = std.mem.zeroes(st.Summons);
    for (st.SUMMON_NAMES, 0..) |name, k| {
        const t = rec.get(cfg, name);
        if (t != .object) continue;
        const props = rec.get(t, "props");
        var u = unitFromRecord(t, 0);
        u.in_holder = false;
        u.summoned = true;
        const entries = rec.get(props, "spells");
        if (entries == .array) try loadBook(&u, entries.array.items);
        const abil = rec.get(props, "abilities").array.items;
        try loadUnitAbilities(init, abil, abil, &.{}, s, &u);
        try loadAuras(init, props, s, &u);
        // Template form: aura links as SpellId values.
        for (u.abilities[0..u.n_abilities]) |*a| {
            if (a.aura != st.NO_AURA) a.aura = @intFromEnum(s.aura_defs[a.aura].buff);
        }
        for (u.auras[0..u.n_auras]) |*d| d.* = @intFromEnum(s.aura_defs[d.*].buff);
        sm.units[k] = u;
        sm.present[k] = true;
    }
    var text: std.Io.Writer.Allocating = .init(std.heap.page_allocator);
    defer text.deinit();
    std.json.Stringify.value(cfg, .{}, &text.writer) catch return error.OutOfMemory;
    summons_lock.lock();
    defer summons_lock.unlock();
    for (summons_registry.items) |e| {
        if (std.mem.eql(u8, e.text, text.written())) return e.summons;
    }
    const owned = try std.heap.page_allocator.dupe(u8, text.written());
    const copy = try std.heap.page_allocator.create(st.Summons);
    copy.* = sm;
    try summons_registry.append(std.heap.page_allocator, .{ .text = owned, .summons = copy });
    return copy;
}

/// The name id a summon's creature takes: the board's own when a start unit has that name, else a fresh one.
pub fn summonNameIds(s: *State, names: []const []const u8) void {
    var next: u16 = @intCast(names.len);
    for (st.SUMMON_NAMES, 0..) |n, k| {
        s.summon_name_id[k] = next;
        for (names, 0..) |known, i| {
            if (std.mem.eql(u8, known, n)) s.summon_name_id[k] = @intCast(i);
        }
        if (s.summon_name_id[k] == next) next += 1;
    }
}

pub fn initState(init: std.json.Value, ids: []const []const u8) !st.State {
    var s: st.State = undefined;
    s.n_aura_defs = 0;
    s.overflow = false;
    s.summons = null;
    s.summon_seq = 0;
    s.uuid_seq = 0;
    s.id_scheme = .match;
    s.n_holder = 0;
    s.spell_cfg = .{st.SpellConfig{}} ** st.N_CAST_SPELLS;
    loadSpellConfigs(&s, rec.get(init, "spellConfigs"));
    const units = rec.get(init, "units").array.items;
    if (units.len > st.MAX_UNITS) return error.TooManyUnits;
    s.n_units = @intCast(units.len);
    s.next_uid = @intCast(units.len);
    // The battle seed (a summon id's second part): record.ts writes it as the start state's rosterSeed.
    const seed = rec.get(init, "rosterSeed");
    s.has_seed = seed == .integer;
    s.seed = if (s.has_seed) @floatFromInt(seed.integer) else 0;
    var names: [st.MAX_UNITS][]const u8 = undefined;
    var n_names: u16 = 0;
    for (&s.setup, 0..) |*row, t| row.* = loadTeamSetup(init, @intCast(t));
    for (units, 0..) |u, i| {
        const props = rec.get(u, "props");
        const pos = rec.get(u, "position");
        const name = rec.get(u, "name").string;
        var name_id: u16 = n_names;
        for (names[0..n_names], 0..) |known, k| {
            if (std.mem.eql(u8, known, name)) name_id = @intCast(k);
        }
        if (name_id == n_names) {
            names[n_names] = name;
            n_names += 1;
        }
        s.units[i] = unitFromRecord(u, name_id);
        const unit = &s.units[i];
        unit.pos_x = rec.num(rec.get(pos, "x"));
        unit.pos_y = rec.num(rec.get(pos, "y"));
        unit.uid = @intCast(i);
        if (i < ids.len) {
            if (@import("uuid.zig").parse(ids[i])) |b| {
                unit.uuid = b;
                unit.uuid_ok = true;
            }
        }
        s.holder[i] = @intCast(i);
        s.n_holder += 1;
        if (unit.team > Team.LEFT) return error.UnsupportedTeam;
        unit.syn_power = s.setup[unit.team].ability_power;
        const abil = rec.get(props, "abilities").array.items;
        const stolen = rec.get(props, "stolen_abilities");
        try loadUnitAbilities(init, abil, abil, if (stolen == .array) stolen.array.items else &.{}, &s, unit);
        const entries = rec.get(props, "spells");
        if (entries == .array) try loadBook(unit, entries.array.items);
        try loadAuras(init, props, &s, unit);
        const target = rec.get(props, "target");
        if (target == .string and target.string.len > 0) unit.target = @intCast(try rec.unitIndex(ids, target.string));
        const forbidden = rec.get(props, "forbidden_target");
        if (forbidden == .string and forbidden.string.len > 0) unit.forbidden = try rec.unitIndex(ids, forbidden.string);
        unit.buffs = try loadSpells(@TypeOf(unit.buffs), props, "buffs");
        unit.debuffs = try loadSpells(@TypeOf(unit.debuffs), props, "debuffs");
        unit.effects = try loadSpells(@TypeOf(unit.effects), props, "effects");
        try loadBuffSources(u, &unit.buffs);
        try loadDebuffSources(u, &unit.debuffs);
    }
    s.summons = try loadSummons(init, rec.get(init, "summonTemplates"), &s);
    summonNameIds(&s, names[0..n_names]);
    try loadScopeFlags(&s, init);
    // Grid: stamp the terrain, register each unit's placement cells, then build the threat boards from them.
    for (0..st.GRID) |x| {
        for (0..st.GRID) |y| s.grid.board[x][y] = st.EMPTY;
    }
    for (0..3) |t| {
        for (0..st.GRID) |x| {
            for (0..st.GRID) |y| s.grid.aggr[t][x][y] = 1;
        }
    }
    s.fight = .{};
    s.fight.grid_type = @intCast(rec.int(rec.get(rec.get(init, "grid"), "gridType")));
    try terrain.load(init, &s);
    for (units, 0..) |u, i| {
        const cells = rec.get(u, "cells").array.items;
        const unit = &s.units[i];
        for (cells, 0..) |c, k| {
            unit.reg[k] = .{ .x = @intCast(rec.int(rec.get(c, "x"))), .y = @intCast(rec.int(rec.get(c, "y"))) };
            s.grid.board[@intCast(unit.reg[k].x)][@intCast(unit.reg[k].y)] = @intCast(i + 1);
        }
        unit.n_reg = @intCast(cells.len);
        stampAggrRing(&s, unit.team, unit.reg[0..unit.n_reg], 1);
    }
    s.fight.laps_till_narrowing = @intCast(rec.int(rec.get(rec.get(init, "fight"), "numberOfLapsTillNarrowing")));
    // Cross-check the rebuilt board against the recorded grid.getMatrix() (matrix[y][x]).
    const rows = rec.get(rec.get(init, "grid"), "matrix");
    if (rows == .array) {
        const m = pathing.buildMatrix(&s);
        for (rows.array.items, 0..) |row, y| {
            for (row.array.items, 0..) |v, x| {
                if (x >= st.GRID or y >= st.GRID or rec.int(v) != m[x][y]) return error.TerrainMismatch;
            }
        }
    }
    s.rng = Rng.init(0);
    s.active = -1;
    s.ai_prev_target = .{-1} ** st.MAX_UNITS;
    s.damage_lap = -1;
    return s;
}

// =====================================================================================================================
// Summons (GameActionEngine.spawnInfestedUnit, runMatch's createSummonedUnit, UnitsHolder.addUnit)
// =====================================================================================================================

/// A slot a new unit can take, the lowest first: a removed unit's slot that the turn sets no longer name, else a
/// removed unit's slot whose set memberships move to Fight.removed_* (they keep removed ids until the lap flips), else
/// the next unused slot. The active unit's slot is never taken (its completeTurn is still to come).
pub fn allocSlot(s: *State) ?u8 {
    const f = &s.fight;
    const named = f.made | f.hourglass_set | f.replied;
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (u.in_holder or named & unitBit(@intCast(i)) != 0 or s.active == @as(i8, @intCast(i))) continue;
        return @intCast(i);
    }
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (u.in_holder or s.active == @as(i8, @intCast(i))) continue;
        const bit = unitBit(@intCast(i));
        if (f.made & bit != 0) f.removed_made.add(u.uid);
        if (f.hourglass_set & bit != 0) f.removed_hourglass.add(u.uid);
        if (f.replied & bit != 0) f.removed_replied.add(u.uid);
        f.made &= ~bit;
        f.hourglass_set &= ~bit;
        f.replied &= ~bit;
        return @intCast(i);
    }
    if (s.n_units >= st.MAX_UNITS) return null;
    s.n_units += 1;
    return s.n_units - 1;
}

/// What spawnInfested reads of the killer: its Infest (hasAbilityActive, read at cleanup), team and id.
pub const Killer = struct { infest: bool, team: u8, uuid: [16]u8, uuid_ok: bool };

pub fn killerOf(u: *const Unit) Killer {
    return .{ .infest = u.ability_mask & st.AbilityId.infest.bit() != 0 and u.has(.infest), .team = u.team, .uuid = u.uuid, .uuid_ok = u.uuid_ok };
}

/// GameActionEngine.spawnInfestedUnit: the corpse of a direct kill by an Infest holder raises an "Arachna Spider"
/// (level 1-3) or an "Arachna Queen" (level 4) of one creature on the killer's team, on the corpse's cells when they
/// fit its footprint, else on the corpse's anchor; it joins the holder last (Map.set) with a fresh uid and the id
/// createSummonedUnit hashes (the sequence counts every call, a failed placement too). No augments, Life supply or
/// events; its first stat refresh (the step's completeTurn) rolls its lap luck after everyone else's.
pub fn spawnInfested(s: *State, killer: *const Killer, corpse_level: u8, corpse: []const Cell) void {
    if (corpse.len == 0) return;
    const which: usize = if (corpse_level == 4) st.Summons.QUEEN else if (corpse_level >= 1 and corpse_level <= 3) st.Summons.SPIDER else return;
    const sm = s.summons orelse {
        s.overflow = true; // the recording carries no template: the battle cannot be followed
        return;
    };
    if (!sm.present[which]) {
        s.overflow = true;
        return;
    }
    const sequence = s.summon_seq;
    s.summon_seq += 1;
    const uuid_sequence = s.uuid_seq;
    s.uuid_seq += 1;
    const nu = sm.units[which];
    // resolveSummonCells unless the corpse cells already form the footprint (getFootprintAnchorForCells otherwise).
    var cells: Cells = .{};
    if (formsFootprint(corpse, nu.fw, nu.fh)) {
        for (corpse) |c| cells.push(c);
    } else {
        const a = anchorForCells(corpse);
        if (isSmall(&nu)) {
            cells.push(a);
        } else if (nu.fw == 2 and nu.fh == 2) {
            cells.push(.{ .x = a.x - 1, .y = a.y });
            cells.push(a);
            cells.push(.{ .x = a.x - 1, .y = a.y - 1 });
            cells.push(.{ .x = a.x, .y = a.y - 1 });
        } else cells = cellsForAnchor(a, nu.fw, nu.fh);
    }
    const pos = positionForCells(cells.slice()) orelse return;
    // Grid.occupyCells: every cell on the board and empty (the summon owns none yet).
    for (cells.slice()) |c| {
        if (!cellWithinGrid(c) or occ(s, c) != st.EMPTY) return;
    }
    _ = addSummon(s, nu, which, killer, "Infest", sequence, uuid_sequence, cells.slice(), pos);
}

/// The tail of runMatch's createSummonedUnit and UnitsHolder.addUnit shared by Infest and Summon Wolves: the id
/// (deterministicSimulationId("summon", seed, team, 3, name, summoner id, `ability`, sequence), or the "sim" UUID of
/// `uuid_sequence`), a fresh uid and slot, the grid registration on `cells` (already checked free) at `pos`, the holder
/// append, the AI memory reset of the slot and a covenant team's ring. Returns the slot, or null (State.overflow).
pub fn addSummon(s: *State, template: Unit, which: usize, summoner: *const Killer, ability: []const u8, sequence: u32, uuid_sequence: u64, cells: []const Cell, pos: [2]f64) ?u8 {
    var nu = template;
    if ((s.id_scheme == .match and (!summoner.uuid_ok or !s.has_seed)) or s.next_uid >= st.MAX_UIDS) {
        s.overflow = true; // no canonical summoner id or battle seed to hash, or out of uids
        return null;
    }
    const slot = allocSlot(s) orelse {
        s.overflow = true;
        return null;
    };
    nu.uid = s.next_uid;
    s.next_uid += 1;
    nu.uuid = switch (s.id_scheme) {
        .match => @import("uuid.zig").summonId(@intFromFloat(s.seed), summoner.team, 3, st.SUMMON_NAMES[which], &summoner.uuid, ability, sequence),
        .uuid_sequence => @import("uuid.zig").simUuid(uuid_sequence),
    };
    nu.uuid_ok = true;
    nu.in_holder = true;
    nu.summoned = true;
    nu.team = summoner.team;
    nu.syn_power = s.setup[nu.team].ability_power;
    nu.name_id = s.summon_name_id[which];
    nu.pos_x = pos[0];
    nu.pos_y = pos[1];
    nu.n_reg = 0;
    // Template form to this battle's aura defs.
    for (nu.abilities[0..nu.n_abilities]) |*a| {
        if (a.aura != st.NO_AURA) a.aura = auraDefFor(s, a.aura);
    }
    for (nu.auras[0..nu.n_auras]) |*d| d.* = auraDefFor(s, d.*);
    s.units[slot] = nu;
    _ = occupyCells(s, slot, cells);
    // A new summoned body (Summon Wolves, an Infest spawn) clears the smoke under it.
    if (s.fight.n_smoke != 0) dispelSmoke(s, slot, cells);
    s.holder[s.n_holder] = slot;
    s.n_holder += 1;
    // A slot carries no AI target memory from a previous occupant (TypeScript's memory names the dead id).
    s.ai_prev_target[slot] = -1;
    for (&s.ai_prev_target) |*t| {
        if (t.* == @as(i8, @intCast(slot))) t.* = -1;
    }
    // UnitsHolder.addUnit: a covenant team's newcomer joins the ring (a Queen's team never holds one in scope).
    const u = &s.units[slot];
    if (s.ember_teams & (@as(u8, 1) << @intCast(u.team)) != 0 and !u.isDead() and cellWithinGrid(baseCell(u))) {
        abilities.pushChecked(s, &u.buffs, .{ .id = .ember_covenant_blessing, .laps = s.ember_laps, .power = s.ember_power });
    }
    return slot;
}

/// The aura def of a template aura (a SpellId value) in this battle.
fn auraDefFor(s: *const State, buff: u8) u8 {
    for (s.aura_defs[0..s.n_aura_defs], 0..) |d, k| {
        if (@intFromEnum(d.buff) == buff) return @intCast(k);
    }
    return 0;
}

// =====================================================================================================================
// Unit identities: recorded actions name uids, the engine works on slots
// =====================================================================================================================

/// A slot no unit holds: an action naming a unit outside the battle is refused (as an unknown id is).
pub const NO_SLOT: u8 = 0xff;

fn slotOrNone(s: *const State, uid: u8) u8 {
    return s.slotOf(uid) orelse NO_SLOT;
}

/// A recorded action (units named by uid, the recording's index) with its units as slots. Identity without summons.
pub fn actionToSlots(s: *const State, a: rec.Action) rec.Action {
    var out = a;
    switch (out) {
        .start_fight, .advance => {},
        .end_turn => |*x| x.unit = slotOrNone(s, x.unit),
        .wait_turn => |*x| x.unit = slotOrNone(s, x.unit),
        .defend_turn => |*x| x.unit = slotOrNone(s, x.unit),
        .select_attack_type => |*x| x.unit = slotOrNone(s, x.unit),
        .move_unit => |*x| x.unit = slotOrNone(s, x.unit),
        .melee_attack => |*x| {
            x.attacker = slotOrNone(s, x.attacker);
            x.target = slotOrNone(s, x.target);
        },
        .range_attack => |*x| {
            x.attacker = slotOrNone(s, x.attacker);
            if (!x.free) x.target = slotOrNone(s, x.target);
        },
        .obstacle_attack => |*x| x.attacker = slotOrNone(s, x.attacker),
        .area_throw_attack => |*x| x.attacker = slotOrNone(s, x.attacker),
        .decide => |*x| x.unit = slotOrNone(s, x.unit),
        .cast_spell => |*x| {
            x.caster = slotOrNone(s, x.caster);
            if (x.has_target) x.target = slotOrNone(s, x.target);
        },
    }
    return out;
}

inline fn uidOf(s: *const State, slot: u8) u8 {
    return if (slot < s.n_units) s.units[slot].uid else slot;
}

/// An engine action (units as slots) with its units named by uid, as recordings name them (`decide`'s actions are
/// left as they are: use it per action).
pub fn actionToUids(s: *const State, a: rec.Action) rec.Action {
    var out = a;
    switch (out) {
        .start_fight, .advance => {},
        .end_turn => |*x| x.unit = uidOf(s, x.unit),
        .wait_turn => |*x| x.unit = uidOf(s, x.unit),
        .defend_turn => |*x| x.unit = uidOf(s, x.unit),
        .select_attack_type => |*x| x.unit = uidOf(s, x.unit),
        .move_unit => |*x| x.unit = uidOf(s, x.unit),
        .melee_attack => |*x| {
            x.attacker = uidOf(s, x.attacker);
            x.target = uidOf(s, x.target);
        },
        .range_attack => |*x| {
            x.attacker = uidOf(s, x.attacker);
            if (!x.free) x.target = uidOf(s, x.target);
        },
        .obstacle_attack => |*x| x.attacker = uidOf(s, x.attacker),
        .area_throw_attack => |*x| x.attacker = uidOf(s, x.attacker),
        .decide => |*x| x.unit = uidOf(s, x.unit),
        .cast_spell => |*x| {
            x.caster = uidOf(s, x.caster);
            if (x.has_target) x.target = uidOf(s, x.target);
        },
    }
    return out;
}

/// Applies one top-level engine call (units as slots), then updates the harness's active unit from the events
/// (runMatch.applyEvents; events name uids). Returns whether the TypeScript engine accepts the call.
pub fn apply(s: *State, action: rec.Action, events: *Events) bool {
    // The action's hasLavaCell, read by the route modifiers (applyLavaWaterModifier).
    s.action_lava = switch (action) {
        .move_unit => |a| a.has_lava,
        .melee_attack => |a| a.has_lava,
        .obstacle_attack => |a| a.has_lava,
        else => false,
    };
    const ok: bool = switch (action) {
        .start_fight => startFight(s),
        .advance => |a| blk: {
            advance(s, a.damage_dealt_this_lap, events);
            break :blk true;
        },
        .end_turn => |a| if (endTurn(s, a.unit, a.reason, events)) true else |_| false,
        .wait_turn => |a| if (waitTurn(s, a.unit, events)) true else |_| false,
        .defend_turn => |a| if (defendTurn(s, a.unit, events)) true else |_| false,
        .select_attack_type => |a| if (selectAttackType(s, a.unit, a.attack_type)) true else |_| false,
        .move_unit => |a| if (moveUnit(s, a.unit, a.path, a.target_cells)) true else |_| false,
        .melee_attack => |a| if (combat.meleeAttack(s, a.attacker, a.target, a.attack_from, a.path, events)) true else |_| false,
        .range_attack => |a| if (a.free)
            (if (combat.freeAimAttack(s, a.attacker, a.tx, a.ty, events)) true else |_| false)
        else
            (if (combat.rangeAttack(s, a.attacker, a.target, a.aim_cell, a.aim_side, events)) true else |_| false),
        .area_throw_attack => |a| if (combat.areaThrowAttack(s, a.attacker, a.target_cell, events)) true else |_| false,
        .obstacle_attack => |a| if (combat.obstacleAttackAt(s, a.attacker, a.target_x, a.target_y, if (a.has_from) a.attack_from else null, a.path, events)) true else |_| false,
        .decide => true, // AI decisions are not engine calls
        .cast_spell => |a| if (spells.castSpell(s, a.caster, a.spell, if (a.has_target) a.target else null, if (a.has_cell) a.cell else null, events)) true else |_| false,
    };
    for (events.slice()) |e| {
        const active_uid: i32 = if (s.active >= 0) s.units[@intCast(s.active)].uid else -1;
        switch (e.kind) {
            .next_unit_selected => s.active = if (s.slotOf(@intCast(e.arg))) |slot| @intCast(slot) else -1,
            .turn_completed => if (active_uid == e.arg) {
                s.active = -1;
            },
            .fight_finished => s.active = -1,
            .unit_destroyed => if (active_uid == e.arg) {
                s.active = -1;
            },
            else => {},
        }
    }
    return ok;
}
