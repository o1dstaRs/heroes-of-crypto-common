//! Spell casting, wave 1: GameActionEngine.castSpell (src/engine/action_engine.ts) and the handlers it dispatches to
//! in scope: Vine Throw (with the vines store), Fire Strike, Lightning Strike, Ring of Fire, Meteor Shower, Meteorite,
//! Summon Wolves, and AttackHandler.handleMagicAttack for Heal and Blessing. The casting gates are SpellHelper's
//! (src/spells/spell_helper.ts: isSpellUsableByCaster, canCastSpell, the line-of-sight walks), the damage tail the
//! shared spell projection (spellRawDamage -> resolveSpellVictims -> applySpellDamageToUnits).
//!
//! Random draws: only Vine Throw's snare save (`action_engine.ts:1873`) and, through completeTurn's refresh, a new Wolf
//! stack's lap luck roll. Damage spells pass a break chance of 0 and magic resist cuts their damage deterministically;
//! Magic Reflection returns a fixed share. The Castling hook (getCurrentEnemiesCellsWithinMovementRange, an eager
//! getMovePath in every unit-targeted cast) draws nothing and feeds only Castling, which is not in scope, so it is
//! skipped. A config or spell shape outside wave 1 (a mass spell, a debuff spell through handleMagicAttack, a missing
//! config) sets State.overflow: the checks report it instead of guessing.

const std = @import("std");
const st = @import("state.zig");
const artifacts = @import("artifacts.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const combat = @import("combat.zig");
const abilities = @import("abilities.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
pub const CS = st.CastSpell;
const ST = st.SpellTarget;
const SP = st.SpellPower;
const EL = st.Element;
const Events = engine.Events;
const Reject = error{Rejected};

const MAX_UNIT_STACK_POWER: f64 = 5;

// =====================================================================================================================
// Gates (spell_helper.ts isSpellUsableByCaster, canCastSpell)
// =====================================================================================================================

/// isSpellUsableByCaster (spell_helper.ts): not Broken, laps > 0, a charge left, enough stack power.
pub fn usable(u: *const Unit, b: *const st.BookSpell, cfg: *const st.SpellConfig) bool {
    return !u.isBroken() and cfg.laps > 0 and b.amount > 0 and cfg.min_stack_power <= engine.getStackPower(u);
}

/// elementalSpellMultiplier against `u` (only Earth Element is in scope: no Fire, Water or Wind Element creature).
pub fn elementMultiplier(element: u8, u: *const Unit) f64 {
    const earth = u.ability_mask & st.AbilityId.earth_element.bit() != 0 and u.has(.earth_element);
    return switch (element) {
        EL.AIR => if (earth) 1.5 else 1,
        EL.EARTH => if (earth) 0 else 1,
        else => 1,
    };
}

/// canCastSpell's notAlreadyApplied: the target carries neither the spell's own row (a buff for a buff spell, an
/// effect or debuff otherwise) nor a conflicting one.
fn notAlreadyApplied(t: *const Unit, spell: CS, cfg: *const st.SpellConfig) bool {
    const Carries = struct {
        fn f(u: *const Unit, buff: bool, id: st.SpellId) bool {
            if (buff) return u.buffs.find(id) != null;
            return u.effects.find(id) != null or u.debuffs.find(id) != null;
        }
    };
    if (spell.applied()) |id| {
        if (Carries.f(t, cfg.is_buff, id)) return false;
    }
    if (cfg.conflict) |id| {
        if (Carries.f(t, cfg.is_buff, id)) return false;
    }
    return true;
}

/// SpellHelper.canCastSpell (spell_helper.ts) for a unit target (the engine never passes targetGridCell, so FREE_CELL is
/// false), in the shapes in scope: HEAL (giftable: Wild Regeneration; or not), ANY_ALLY and ANY_ENEMY. `spell`'s first
/// Spell object is the one tested.
pub fn canCastSpell(s: *const State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig) bool {
    const caster = &s.units[ci];
    const t = &s.units[ti];
    const b = caster.bookSpell(@intFromEnum(spell)) orelse return false;
    if (!usable(caster, b, cfg)) return false;
    var found = false;
    for (caster.spells[0..caster.n_spells]) |x| {
        if (x.spell == @intFromEnum(spell) and x.amount > 0) found = true;
    }
    if (!found) return false;
    const self_cast = ci == ti or (caster.name_id == t.name_id and caster.team == t.team);
    const mr = engine.getMagicResist(t);
    if (cfg.power_type == SP.RESURRECT) return false; // not in scope
    if (cfg.power_type == SP.HEAL) {
        if (cfg.is_giftable) {
            // The gift: an ally of at most the gift level that does not hold the ability active (Break-aware).
            const id = spell.gifted() orelse return false;
            return !t.has(id) and caster.team == t.team and @as(f64, @floatFromInt(t.level)) <= cfg.max_gift_level and (cfg.self_cast or !self_cast);
        }
        // toUnitCanBeHealded: a Mechanism cannot be healed.
        return !t.has(.mechanism) and t.hp < t.max_hp and mr != 100 and caster.team == t.team and (cfg.self_cast or !self_cast);
    }
    if (cfg.target == ST.ANY_ALLY) {
        if (mr == 100) return false;
        if (caster.team == t.team and (cfg.self_cast or !self_cast)) return notAlreadyApplied(t, spell, cfg);
    }
    if (cfg.target == ST.ANY_ENEMY) {
        // hasMindAttackResistance: Madness or Mechanism; getTarget(): the raw Aggr lock
        const mind = cfg.power_type == SP.MIND and engine.moraleLocked(t);
        const forced = caster.target >= 0 and caster.target != @as(i8, @intCast(ti));
        if (mr == 100 or mind or elementMultiplier(cfg.element, t) <= 0 or forced) return false;
        if (caster.team != t.team and !self_cast) return notAlreadyApplied(t, spell, cfg);
    }
    return false;
}

// =====================================================================================================================
// Line of sight (spell_helper.ts isTargetedSpellLineOfSightClear, firstSpellSightBlocker; vines.ts vinePathCells)
// =====================================================================================================================

const Lane = struct {
    items: [40]Cell = undefined,
    len: u8 = 0,

    fn slice(self: *const Lane) []const Cell {
        return self.items[0..self.len];
    }
};

/// vinePathCells: the 8-connected Bresenham lane from the caster's base cell (excluded) to the target's (included).
fn vinePathCells(from: Cell, to: Cell) Lane {
    var lane: Lane = .{};
    var x = from.x;
    var y = from.y;
    const dx: i32 = @intCast(@abs(to.x - x));
    const dy: i32 = @intCast(@abs(to.y - y));
    const sx: i32 = if (x < to.x) 1 else -1;
    const sy: i32 = if (y < to.y) 1 else -1;
    var err = dx - dy;
    const max_cells = dx + dy + 1;
    var guard: i32 = 0;
    while (guard <= max_cells) : (guard += 1) {
        if (!(x == from.x and y == from.y) and lane.len < lane.items.len) {
            lane.items[lane.len] = .{ .x = x, .y = y };
            lane.len += 1;
        }
        if (x == to.x and y == to.y) break;
        const e2 = err * 2;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
    return lane;
}

inline fn boardAt(s: *const State, c: Cell) u8 {
    return s.grid.board[@intCast(c.x)][@intCast(c.y)];
}

const SightMode = enum { creatures, creatures_and_terrain };

/// firstSpellSightBlocker (no transparent units): whether some cell strictly between the two base cells blocks the
/// throw: any third creature, and for `creatures_and_terrain` also "B", "H" and the board's edge (lava is open).
fn sightBlocked(s: *const State, from: Cell, to: Cell, mode: SightMode) bool {
    const lane = vinePathCells(from, to);
    if (lane.len == 0) return true;
    const caster_code = boardAt(s, from);
    const target_code = boardAt(s, to);
    for (lane.items[0 .. lane.len - 1]) |c| {
        if (!engine.cellWithinGrid(c)) {
            if (mode == .creatures) continue;
            return true;
        }
        const o = boardAt(s, c);
        if (o == st.EMPTY or o == st.LAVA) continue;
        if (o == st.BLOCK or o == st.HOLE) {
            if (mode == .creatures) continue;
            return true;
        }
        if (o != caster_code and o != target_code) return true;
    }
    return false;
}

/// THROWN_SPELL_SIDE_OFFSETS: LEFT, RIGHT, DOWN, UP (the RangeAttackCellSide indices).
const SIDE_OFFSETS = [4][2]i32{ .{ -1, 0 }, .{ 1, 0 }, .{ 0, -1 }, .{ 0, 1 } };

/// isAllyOfCaster: the occupant is a holder unit of the caster's team (Fire Strike arcs over the caster's troops).
inline fn allyOfCaster(s: *const State, caster_team: u8, code: u8) bool {
    if (!st.isUnitCode(code)) return false;
    const u = &s.units[code - 1];
    return u.in_holder and u.team == caster_team;
}

/// isThrownSpellSideObservable with the caster's allies transparent: the neighbour is off the board, empty or lava,
/// or an ally of the caster; "B" and "H" and any other body cover the edge.
fn thrownSideObservable(s: *const State, cell: Cell, side: usize, caster_team: u8) bool {
    const n = Cell{ .x = cell.x + SIDE_OFFSETS[side][0], .y = cell.y + SIDE_OFFSETS[side][1] };
    if (!engine.cellWithinGrid(n)) return true;
    const o = boardAt(s, n);
    if (o == st.EMPTY or o == st.LAVA) return true;
    if (o == st.BLOCK or o == st.HOLE) return false;
    return allyOfCaster(s, caster_team, o);
}

const Body = struct {
    items: [4]Cell = undefined,
    len: u8 = 0,

    fn slice(self: *const Body) []const Cell {
        return self.items[0..self.len];
    }
};

/// spellEndpointCells: the body around a base cell, a flood fill (BFS over the four sides) of the cells holding the
/// same occupant; a terrain or empty base is itself.
fn endpointCells(s: *const State, base: Cell) Body {
    var out: Body = .{};
    out.items[0] = base;
    out.len = 1;
    const code = boardAt(s, base);
    if (!st.isUnitCode(code)) return out;
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        for (SIDE_OFFSETS) |o| {
            const c = Cell{ .x = out.items[i].x + o[0], .y = out.items[i].y + o[1] };
            if (!engine.cellWithinGrid(c) or boardAt(s, c) != code) continue;
            var seen = false;
            for (out.items[0..out.len]) |x| {
                if (x.x == c.x and x.y == c.y) seen = true;
            }
            if (seen or out.len >= out.items.len) continue;
            out.items[out.len] = c;
            out.len += 1;
        }
    }
    return out;
}

/// The best candidate of interceptedThrowTrajectory: 0 unobstructed, 1 a body intercepts (`blocker`, a slot), 2 terrain.
/// `impact`: the target-body cell the ray entered (else the aimed endpoint cell), or the blocker's cell
/// (resolveThrownSpellImpact's `cell`: Fireball's blast centre).
pub const Trajectory = struct { obstruction: u2, blocker: u8 = 0, impact: Cell = .{ .x = 0, .y = 0 } };

/// interceptedThrowTrajectory (Fire Strike): every observable edge of the target's body, the pixel ray from the
/// caster's body centre to its centre (traceGridRayCells), the first cell that is neither empty, lava, the caster nor
/// one of its allies stopping it (the target's own cell ends it cleanly); the lowest obstruction wins, then the
/// shortest distance, then enumeration order. Null when no edge is observable. Mirrors resolveThrownSpellImpact /
/// thrownSpellReachesAimedTarget for the intercepted throws (isInterceptedThrownSpell).
pub fn trajectory(s: *const State, ci: u8, ti: u8) ?Trajectory {
    const caster = &s.units[ci];
    const from_base = engine.baseCell(caster);
    const to_base = engine.baseCell(&s.units[ti]);
    const caster_code = boardAt(s, from_base);
    const target_code = boardAt(s, to_base);
    const from_body = endpointCells(s, from_base);
    const fp = engine.positionForCells(from_body.slice()) orelse return null;
    const to_body = endpointCells(s, to_base);
    var best: ?Trajectory = null;
    var best_d: f64 = 0;
    for (to_body.slice()) |cell| {
        for (0..4) |side| {
            if (!thrownSideObservable(s, cell, side, caster.team)) continue;
            const p = combat.sideCenter(cell, @intCast(side), fp[0], fp[1]);
            var t: Trajectory = .{ .obstruction = 0, .impact = cell };
            var ray: combat.Ray = undefined;
            combat.traceRayInto(&ray, fp[0], fp[1], p[0], p[1]);
            for (ray.items[0..ray.len]) |h| {
                if (!engine.cellWithinGrid(h.cell)) continue;
                const o = boardAt(s, h.cell);
                if (o != st.EMPTY and o == target_code) {
                    t.impact = h.cell;
                    break;
                }
                if (o == st.EMPTY or o == caster_code or o == st.LAVA) continue;
                if (o == st.BLOCK or o == st.HOLE) {
                    t.obstruction = 2;
                    break;
                }
                if (allyOfCaster(s, caster.team, o)) continue;
                t = .{ .obstruction = 1, .blocker = o - 1, .impact = h.cell };
                break;
            }
            const dx = p[0] - fp[0];
            const dy = p[1] - fp[1];
            const d = @sqrt(dx * dx + dy * dy); // Math.hypot of integers: exact
            if (best == null or t.obstruction < best.?.obstruction or (t.obstruction == best.?.obstruction and d < best_d)) {
                best = t;
                best_d = d;
            }
        }
    }
    return best;
}

/// isTargetedSpellLineOfSightClear: Vine Throw's creatures-only walk, Ring of Fire's walk with terrain, Fire Strike's
/// visible edge and trajectory (a body intercepts, terrain refuses); every other spell needs no line. Mirrors
/// SpellHelper.isTargetedSpellLineOfSightClear.
pub fn lineOfSightClear(s: *const State, ci: u8, ti: u8, spell: CS) bool {
    const from = engine.baseCell(&s.units[ci]);
    const to = engine.baseCell(&s.units[ti]);
    switch (spell) {
        .vine_throw => return !sightBlocked(s, from, to, .creatures),
        .ring_of_fire => return !sightBlocked(s, from, to, .creatures_and_terrain),
        .fire_strike, .fireball => {
            // hasObservableThrownSpellEdge over target.getCells()
            const team = s.units[ci].team;
            const cells = engine.unitCells(&s.units[ti]);
            var edge = false;
            for (cells.slice()) |c| {
                for (0..4) |side| {
                    if (thrownSideObservable(s, c, side, team)) edge = true;
                }
            }
            if (!edge) return false;
            const t = trajectory(s, ci, ti) orelse return false; // firstTargetedSpellSightBlocker: "B" at the target
            return t.obstruction != 2;
        },
        else => return true,
    }
}

// =====================================================================================================================
// The damage tail (spell_cast_projection.ts, spell_damage.ts, magic_mirror_damage.ts; applySpellDamageToUnits)
// =====================================================================================================================

/// MORALE_SCALED_SPELLS (spell_damage.ts) among the ported ones: isOffensiveSpellMultiplier's set.
pub inline fn moraleScaled(spell: CS) bool {
    return switch (spell) {
        .lightning_strike, .ring_of_fire, .meteor_shower, .meteorite, .fire_strike, .heal, .fireball => true,
        else => false,
    };
}

/// getSpellMoraleMultiplier(spell, caster.getAttackMultiplier())
pub inline fn moraleMultiplier(spell: CS, attack_multiplier: f64) f64 {
    if (!moraleScaled(spell)) return 1;
    return if (std.math.isFinite(attack_multiplier)) @max(0, attack_multiplier) else 1;
}

/// Unit.getMagicDamageBonusPercentage: the Empower Augment and Sylvan Focus Blessing powers, additive (no Empower scroll
/// or arcane rings in scope).
fn magicDamageBonus(u: *const Unit) f64 {
    var total: f64 = 0;
    if (u.buffs.power(.empower_augment)) |p| {
        if (std.math.isFinite(p) and p > 0) total += p;
    }
    if (u.buffs.power(.sylvan_focus_blessing)) |p| {
        if (std.math.isFinite(p) and p > 0) total += p;
    }
    // Mage's Ring, then Archmage's Ring (the caster's own rows).
    total += artifacts.ringsBonus(u);
    return total;
}

/// spellRawDamage -> calculateSpellDamage: floor(alive * power * empowerMultiplier(bonus) * morale), UNIT_AMOUNT_DAMAGE
/// only.
pub fn rawDamage(caster: *const Unit, spell: CS, cfg: *const st.SpellConfig) f64 {
    if (cfg.multiplier != st.SpellMultiplier.UNIT_AMOUNT_DAMAGE) return 0;
    const alive = @max(0, @floor(caster.amount_alive));
    const bonus = magicDamageBonus(caster);
    const empower: f64 = if (!std.math.isFinite(bonus) or bonus <= 0) 1 else 1 + bonus / 100;
    return @max(0, @floor(alive * cfg.power * empower * moraleMultiplier(spell, caster.attack_multiplier)));
}

/// Unit.getMagicDamageTakenMultiplier: Heavy Armor's magic side (no synergy term).
pub fn magicDamageTakenMultiplier(u: *const Unit) f64 {
    if (u.ability_mask & st.AbilityId.heavy_armor.bit() == 0) return 1;
    const ha = u.ability(.heavy_armor) orelse return 1;
    return js.toFixed(((ha.power + engine.getLuck(u)) / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) + 1, 2);
}

/// applyElementAndResistToSpellDamage
fn elementAndResist(raw: f64, element_multiplier: f64, magic_resist: f64) f64 {
    if (element_multiplier <= 0) return 0;
    const scaled = if (element_multiplier == 1) raw else @floor(raw * element_multiplier);
    const resist = @max(0, @min(100, magic_resist));
    return @max(0, @floor(scaled * (1 - resist / 100)));
}

/// spellDamageAgainstUnit (projectSpellDamageAgainstUnit): Heavy Armor first, then the element, then the unit's magic
/// resist.
pub fn damageAgainst(raw: f64, element: u8, u: *const Unit) f64 {
    const m = magicDamageTakenMultiplier(u);
    return elementAndResist(if (m == 1) raw else @floor(raw * m), elementMultiplier(element, u), engine.getMagicResist(u));
}

/// mirroredDamageShare: the Magic Dragon's Magic Reflection, floor(power / 5 * stack power + luck) clamped to 0..100
/// (no Magic Mirror buff in scope).
pub fn mirroredShare(u: *const Unit) f64 {
    if (u.ability_mask & st.AbilityId.magic_reflection.bit() == 0) return 0;
    const a = u.ability(.magic_reflection) orelse return 0;
    const sp = @max(0, @min(MAX_UNIT_STACK_POWER, engine.getStackPower(u)));
    return @max(0, @min(100, @floor((a.power / MAX_UNIT_STACK_POWER) * sp + engine.getLuck(u))));
}

pub const Victim = struct { slot: u8, damage: f64, rebounded: bool };

pub const Victims = struct {
    items: [2 * st.MAX_UNITS]Victim = undefined,
    len: u8 = 0,

    pub fn push(self: *Victims, v: Victim) void {
        if (self.len < self.items.len) {
            self.items[self.len] = v;
            self.len += 1;
        }
    }
};

/// resolveSpellVictims: each target's landed damage, followed by its rebound row onto the caster (projectSpellRebound:
/// the share of what landed, through the caster's own Heavy Armor, element and magic resist). Mirrors resolveSpellVictims.
pub fn resolveVictims(s: *const State, ci: u8, element: u8, raw: f64, targets: []const u8, out: *Victims) void {
    const caster = &s.units[ci];
    for (targets) |ti| {
        const u = &s.units[ti];
        const landed = damageAgainst(raw, element, u);
        out.push(.{ .slot = ti, .damage = landed, .rebounded = false });
        const share = if (landed > 0 and ti != ci) mirroredShare(u) else 0;
        if (share <= 0) continue;
        const reflected = @floor((landed * share) / 100);
        const heavy = magicDamageTakenMultiplier(caster);
        const back = elementAndResist(if (heavy == 1) reflected else @floor(reflected * heavy), elementMultiplier(element, caster), engine.getMagicResist(caster));
        out.push(.{ .slot = ci, .damage = back, .rebounded = true });
    }
}

/// applySpellDamageToUnits: each victim in order (a dead one skipped) takes its damage with the spell's element and no
/// break roll; a non-rebound row adds a damage statistic (even at 0); an enemy of the caster killed earns +4 and costs
/// its same-name stacks 4 (applied after the loop, before the caster's single increase). Fills `died` and `killed`.
fn applyVictims(s: *State, ci: u8, element: u8, victims: *const Victims, died: *combat.Died, killed: *combat.Died) void {
    var decrease: combat.MoraleDecrease = .{};
    var plus: f64 = 0;
    const team = s.units[ci].team;
    for (victims.items[0..victims.len]) |v| {
        const u = &s.units[v.slot];
        if (u.isDead()) continue;
        const applied = engine.applyDamageElement(s, v.slot, v.damage, 0, false, element);
        // A spell kill records the caster's Last Fuse source (the rebound onto the caster is same-team: none).
        if (s.artifacts and u.isDead()) artifacts.recordFatal(s, v.slot, applied, ci);
        if (!v.rebounded) s.damage_lap = s.fight.lap;
        if (u.isDead()) {
            died.push(v.slot);
            if (u.team != team) {
                killed.push(v.slot);
                plus += engine.MORALE_CHANGE_FOR_KILL;
                decrease.add(u, engine.MORALE_CHANGE_FOR_KILL);
            }
        }
    }
    if (decrease.len != 0) decrease.apply(s);
    if (plus > 0) engine.changeMorale(&s.units[ci], plus, true);
}

/// Unit.useSpell: every parsed Spell of that name loses a charge, and the LAST raw entry of that name goes per match.
fn useSpell(u: *Unit, spell: CS) void {
    const id = @intFromEnum(spell);
    for (u.spells[0..u.n_spells]) |*b| {
        if (b.spell != id) continue;
        if (b.amount > 0) b.amount -= 1;
        var i: usize = u.n_book;
        while (i > 0) {
            i -= 1;
            if (u.book[i].spell == id) {
                std.mem.copyForwards(st.BookEntry, u.book[i .. u.n_book - 1], u.book[i + 1 .. u.n_book]);
                u.n_book -= 1;
                break;
            }
        }
    }
}

/// The shared end of a damage cast: the victims' damage, the charge, the death cleanup (a killed enemy's corpse
/// infests when the caster holds Infest) and the caster's completeTurn.
fn damageTail(s: *State, ci: u8, spell: CS, cfg: *const st.SpellConfig, targets: []const u8, events: *Events) void {
    var victims: Victims = .{};
    resolveVictims(s, ci, cfg.element, rawDamage(&s.units[ci], spell, cfg), targets, &victims);
    var died: combat.Died = .{};
    var killed: combat.Died = .{};
    applyVictims(s, ci, cfg.element, &victims, &died, &killed);
    useSpell(&s.units[ci], spell);
    const killer = engine.killerOf(&s.units[ci]);
    combat.cleanupSpellDeaths(s, &died, &killed, &killer, events);
    engine.completeTurn(s, ci, false, false, events);
}

// =====================================================================================================================
// Areas (aoe_range_ability.ts evaluateAffectedUnits, grid_math.ts getCellsAroundCell / getCellsAroundFootprint)
// =====================================================================================================================

pub const Cells = struct {
    items: [24]Cell = undefined,
    len: u8 = 0,

    pub fn has(self: *const Cells, c: Cell) bool {
        for (self.items[0..self.len]) |x| if (x.x == c.x and x.y == c.y) return true;
        return false;
    }
    pub fn push(self: *Cells, c: Cell) void {
        if (self.len < self.items.len) {
            self.items[self.len] = c;
            self.len += 1;
        }
    }
    pub fn slice(self: *const Cells) []const Cell {
        return self.items[0..self.len];
    }
};

/// getCellsAroundCell: the legacy 2x2 neighbourhoods of the cell's four corners, the cell itself left out.
pub fn cellsAroundCell(c: Cell, out: *Cells) void {
    out.len = 0;
    const p = engine.positionForCell(@floatFromInt(c.x), @floatFromInt(c.y));
    const corners = [4][2]f64{
        .{ p[0] - engine.HALF, p[1] + engine.HALF },
        .{ p[0] + engine.HALF, p[1] + engine.HALF },
        .{ p[0] - engine.HALF, p[1] - engine.HALF },
        .{ p[0] + engine.HALF, p[1] - engine.HALF },
    };
    for (corners) |cp| {
        const around = engine.cellsAroundPosition(cp[0], cp[1]);
        for (around.slice()) |a| {
            if ((a.x == c.x and a.y == c.y) or out.has(a)) continue;
            out.push(a);
        }
    }
}

/// getCellsAroundFootprint: the ring around a body, its own cells excluded, first-seen order over the body cells.
pub fn cellsAroundFootprint(body: []const Cell, out: *Cells) void {
    out.len = 0;
    for (body) |b| {
        var around: Cells = .{};
        cellsAroundCell(b, &around);
        for (around.slice()) |a| {
            var own = false;
            for (body) |x| {
                if (x.x == a.x and x.y == a.y) own = true;
            }
            if (own or out.has(a)) continue;
            out.push(a);
        }
    }
}

const Slots = struct {
    items: [st.MAX_UNITS]u8 = undefined,
    len: u8 = 0,

    fn has(self: *const Slots, x: u8) bool {
        for (self.items[0..self.len]) |y| if (y == x) return true;
        return false;
    }
    fn push(self: *Slots, x: u8) void {
        if (self.len < self.items.len) {
            self.items[self.len] = x;
            self.len += 1;
        }
    }
    fn slice(self: *const Slots) []const u8 {
        return self.items[0..self.len];
    }
};

/// evaluateAffectedUnits(cells, rangedAreaAttack = false): the holder units standing on the cells, each once, at its
/// first cell in `cells` order (terrain and empty cells skipped).
fn affectedUnits(s: *const State, cells: []const Cell, out: *Slots) void {
    out.len = 0;
    for (cells) |c| {
        if (!engine.cellWithinGrid(c)) continue;
        const o = boardAt(s, c);
        if (!st.isUnitCode(o)) continue;
        const slot = o - 1;
        if (!s.units[slot].in_holder or out.has(slot)) continue;
        out.push(slot);
    }
}

// =====================================================================================================================
// castSpell and the handlers
// =====================================================================================================================

/// GameActionEngine.castSpell: the turn checks, the caster's Spell and its charge gate, the target and its cell, the
/// generic unit-target gate (line of sight, canCastSpell), then the dispatch in action_engine.ts order. `target` is a
/// slot (NO_SLOT for an id outside the battle), `cell` the action's targetCell.
pub fn castSpell(s: *State, ci: u8, spell_raw: u8, target: ?u8, cell: ?Cell, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ci);
    const caster = &s.units[ci];
    if (caster.moved_this_turn) return error.Rejected; // spell_not_available (moved this turn)
    // spell_not_found: no unit holds a spell outside the port (the loaders refuse it), so such a name is never found.
    if (spell_raw == st.NO_SPELL) return error.Rejected;
    const b = caster.bookSpell(spell_raw) orelse return error.Rejected;
    const spell: CS = @enumFromInt(spell_raw);
    const cfg = &s.spell_cfg[spell_raw];
    if (!cfg.loaded) {
        s.overflow = true; // the recording carries no config for a spell the unit holds
        return error.Rejected;
    }
    if (!usable(caster, b, cfg)) return error.Rejected; // spell_not_available
    var ti: ?u8 = null;
    if (target) |t| {
        if (t >= s.n_units or !s.units[t].in_holder) return error.Rejected; // unit_not_found
        ti = t;
    }
    if (ti) |t| {
        if (cell) |c| {
            const base = engine.baseCell(&s.units[t]);
            if (base.x != c.x or base.y != c.y) return error.Rejected;
        }
        // A Hidden (Disguise) enemy cannot be targeted; a Hidden ally can.
        const hidden_enemy = s.disguise and s.units[t].team != caster.team and s.units[t].isHidden();
        if (hidden_enemy or !lineOfSightClear(s, ci, t, spell) or !canCastSpell(s, ci, t, spell, cfg)) return error.Rejected;
    }
    if (ti == null and spell == .summon_wolves and cfg.target == ST.RANDOM_CLOSE_TO_CASTER) return summonSpell(s, ci, spell, cfg, cell, events);
    if (ti == null and cfg.target == ST.ALL_ALLIES and cfg.power_type != SP.HEAL) return massCastSpell(s, ci, spell, cfg, events);
    if (ti == null and (cfg.target == ST.ALL_FLYING or cfg.target == ST.ALL_ALLIES or cfg.target == ST.ALL_ENEMIES or cfg.target == ST.ALLIES_AREA)) {
        s.overflow = true; // the other mass casts (flyers, enemies, Mass Heal) and craftCast: wave 2
        return error.Rejected;
    }
    if (ti) |t| switch (spell) {
        .vine_throw => return vineThrow(s, ci, t, spell, cfg, events),
        .fire_strike => return fireStrike(s, ci, t, spell, cfg, events),
        .fireball => return fireball(s, ci, t, spell, cfg, events),
        .lightning_strike => return lightningStrike(s, ci, t, spell, cfg, events),
        .ring_of_fire => return ringOfFire(s, ci, t, spell, cfg, events),
        else => {},
    } else switch (spell) {
        .meteorite, .meteor_shower => return meteor(s, ci, spell, cfg, cell, events),
        else => {},
    }
    return magicAttack(s, ci, ti, spell, cfg, events);
}

/// AttackHandler.handleMagicAttack for the spells that reach it in scope (Heal, Blessing, the Wild Regeneration gift):
/// canCastSpell again, then the heal (floor(power * caster alive * morale multiplier), capped at the front creature's
/// max hp), the gift or the buff (appended, a lap longer on a self-cast); the charge; completeTurn. No draw (the resist
/// roll is the debuff spells').
fn magicAttack(s: *State, ci: u8, target: ?u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    const ti = target orelse return error.Rejected; // a spell aimed without its target
    if (s.disguise and s.units[ti].team != s.units[ci].team and s.units[ti].isHidden()) return error.Rejected;
    if (!canCastSpell(s, ci, ti, spell, cfg)) return error.Rejected;
    const caster = &s.units[ci];
    const t = &s.units[ti];
    if (cfg.power_type == SP.RESURRECT) {
        s.overflow = true; // Resurrection: Angel's, batch 6
        return error.Rejected;
    }
    if (!cfg.is_buff) {
        debuffBranch(s, ci, ti, spell, cfg);
        useSpell(caster, spell);
        engine.completeTurn(s, ci, false, false, events);
        return;
    }
    if (cfg.power_type == SP.HEAL and cfg.is_giftable) {
        // The gift (no Holy Cross in scope): the caster deletes the ability (its card, charge and re-parsed book);
        // the target gains it unless it already holds it (the card list minus its stolen marks: the active list) or
        // lost that card to Predatory Assimilation. A lost gift leaves the battle.
        const id = spell.gifted() orelse {
            s.overflow = true;
            return error.Rejected;
        };
        const deleted = abilities.deleteAbility(s, caster, id);
        if (t.activeAbility(id) == null) {
            if (deleted) |a| _ = abilities.addAbility(s, t, a);
        }
        useSpell(caster, spell); // a no-op: the re-parsed book no longer holds the spell
        engine.completeTurn(s, ci, false, false, events);
        return;
    }
    if (cfg.power_type == SP.HEAL) {
        // Unit.applyHeal (no Holy Cross in scope; every unit can be healed)
        const heal = @floor(cfg.power * caster.amount_alive * 1 * moraleMultiplier(spell, caster.attack_multiplier));
        if (heal >= 0) {
            t.hp += @floor(heal);
            if (t.hp > t.max_hp) t.hp = t.max_hp;
        }
    } else {
        // applyBuff (no Helping Hand body): the row at the end of the list, its power raised by the caster's Tome of
        // Amplification (amplifyCastBuffForTarget: an ally's or the caster's own copy)
        const id = spell.applied() orelse {
            s.overflow = true;
            return error.Rejected;
        };
        const laps = cfg.laps + @as(f64, if (ci == ti) 1 else 0);
        const power = if (s.artifacts and caster.team == t.team) artifacts.tomePower(caster, cfg, cfg.power) else cfg.power;
        abilities.pushChecked(s, &t.buffs, .{ .id = id, .laps = laps, .power = power });
    }
    useSpell(caster, spell);
    engine.completeTurn(s, ci, false, false, events);
}

/// handleMagicAttack's debuff branch (Misfortune): the magic-resist save getRandomInt(0, 100) < floor(magic resist) (a MIND
/// spell's Madness / Mechanism resistance short-circuits after it); a landed debuff may be redirected to the Absorb
/// Penalties Aura source (its roll), lands there (laps, +1 on a self-cast) unless that unit resists a MIND spell, then
/// the mirror roll (always drawn: Magic Reflection's chance) copies it onto the caster (laps + 1) unless the caster
/// already carries it or resists a MIND spell.
fn debuffBranch(s: *State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig) void {
    const caster = &s.units[ci];
    const t = &s.units[ti];
    const id = spell.applied() orelse {
        s.overflow = true; // a debuff spell without its row in scope
        return;
    };
    const mind = cfg.power_type == SP.MIND;
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) < @floor(engine.getMagicResist(t))) return; // attack_handler.ts:684
    if (mind and abilities.mindResistant(t)) return;
    const di = abilities.absorptionTarget(s, ti);
    const d = &s.units[di];
    if (!(mind and abilities.mindResistant(d))) {
        abilities.pushChecked(s, &d.debuffs, .{ .id = id, .laps = cfg.laps + @as(f64, if (ci == ti) 1 else 0), .power = cfg.power });
    }
    // SpellHelper.isMirrored(debuffTarget): max(Magic Mirror buff power (none in scope), Magic Reflection's chance).
    const mirror = @floor(@max(0, mirroredShare(d)));
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) < mirror and notAlreadyApplied(caster, spell, cfg) and !(mind and abilities.mindResistant(caster))) { // spell_helper.ts:1232
        abilities.pushChecked(s, &caster.debuffs, .{ .id = id, .laps = cfg.laps + 1, .power = cfg.power });
    }
}

/// SpellHelper.canMassCastSpell for an ALL_ALLIES non-HEAL spell: some unit of the caster's team (holder order) with
/// magic resist other than 100 that carries no buff of the spell's name or a conflicting one.
pub fn canMassCastSpell(s: *const State, ci: u8, spell: CS, cfg: *const st.SpellConfig) bool {
    if (cfg.target != ST.ALL_ALLIES or cfg.power_type == SP.HEAL) return false;
    const team = s.units[ci].team;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.team != team) continue;
        if (engine.getMagicResist(u) == 100) continue;
        if (!alreadyAppliedBuff(u, spell, cfg)) return true;
    }
    return false;
}

/// hasAlreadyAppliedSpell for a buff spell: the unit carries a buff of the spell's name or of a conflicting one.
fn alreadyAppliedBuff(u: *const Unit, spell: CS, cfg: *const st.SpellConfig) bool {
    if (spell.applied()) |id| {
        if (u.buffs.find(id) != null) return true;
    }
    if (cfg.conflict) |id| {
        if (u.buffs.find(id) != null) return true;
    }
    return false;
}

/// GameActionEngine.massCastSpell -> massCastOnAllies for an ALL_ALLIES non-HEAL spell (Battle Roar): canMassCastSpell,
/// then every ally in holder order (the caster included) with magic resist other than 100 that does not carry it yet
/// gets the buff appended: power = the caster's creatures alive for UNIT_AMOUNT (else the config's), laps + 1 on the
/// caster; then the charge and completeTurn. No draw.
fn massCastSpell(s: *State, ci: u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    if (!canMassCastSpell(s, ci, spell, cfg)) return error.Rejected; // spell_not_available
    const id = spell.applied() orelse {
        s.overflow = true; // a mass buff without a row in scope
        return error.Rejected;
    };
    const caster = &s.units[ci];
    const team = caster.team;
    const power = if (cfg.multiplier == st.SpellMultiplier.UNIT_AMOUNT) caster.amount_alive else cfg.power;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.team != team) continue;
        if (engine.getMagicResist(u) == 100) continue;
        if (alreadyAppliedBuff(u, spell, cfg)) continue;
        // applyBuff(amplifyCastBuffForTarget(...)): the caster's Tome of Amplification raises the ally's copy.
        const amplified = if (s.artifacts) artifacts.tomePower(caster, cfg, power) else power;
        abilities.pushChecked(s, &u.buffs, .{ .id = id, .laps = cfg.laps + @as(f64, if (i == ci) 1 else 0), .power = amplified });
    }
    useSpell(caster, spell);
    engine.completeTurn(s, ci, false, false, events);
}

/// vineThrowCast: the lane from the caster to the target (its base cell last) takes root on every cell that is not "B"
/// or "H" (vines.addAll, the thrower's team), then the snare save getRandomInt(0, 100) < floor(magic resist) is drawn
/// (always: action_engine.ts:1873); a failed save appends the "Vine Throw" debuff (the spell's power and laps). The
/// charge is spent either way.
fn vineThrow(s: *State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    const from = engine.baseCell(&s.units[ci]);
    const to = engine.baseCell(&s.units[ti]);
    const lane = vinePathCells(from, to);
    if (lane.len == 0 or sightBlocked(s, from, to, .creatures)) return error.Rejected;
    const team = s.units[ci].team;
    for (lane.slice()) |c| {
        if (!engine.cellWithinGrid(c)) continue;
        const o = boardAt(s, c);
        if (o == st.BLOCK or o == st.HOLE) continue;
        engine.addVine(s, c, cfg.laps, team);
    }
    const t = &s.units[ti];
    const resisted = @as(f64, @floatFromInt(s.rng.int(0, 100))) < @floor(engine.getMagicResist(t));
    if (!resisted) abilities.pushChecked(s, &t.debuffs, .{ .id = .vine_throw, .laps = cfg.laps, .power = cfg.power });
    useSpell(&s.units[ci], spell);
    engine.completeTurn(s, ci, false, false, events);
}

/// fireStrikeCast: canCastSpell again, then the throw's impact: terrain refuses, a screening enemy body takes the hit
/// instead of the aimed target.
fn fireStrike(s: *State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    if (!canCastSpell(s, ci, ti, spell, cfg)) return error.Rejected;
    const t = trajectory(s, ci, ti) orelse return error.Rejected; // blockedByTerrain
    if (t.obstruction == 2) return error.Rejected;
    var victim = ti;
    if (t.obstruction == 1 and t.blocker != ti) {
        const v = &s.units[t.blocker];
        if (!v.in_holder or v.isDead()) return error.Rejected;
        victim = t.blocker;
    }
    damageTail(s, ci, spell, cfg, &.{victim}, events);
}

/// fireballCast: Fire Strike's gate and intercepted trajectory, then the blast: the unit the throw burst on (the aimed
/// target, or the enemy screening it) first, then every other living unit with a cell in [impact, ring(impact)], in that
/// cell order, each once, allies included and the caster spared (stones and barrels stay); the shared damage tail.
fn fireball(s: *State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    if (!canCastSpell(s, ci, ti, spell, cfg)) return error.Rejected;
    const t = trajectory(s, ci, ti) orelse return error.Rejected; // blockedByTerrain
    if (t.obstruction == 2) return error.Rejected;
    var epicentre = ti;
    if (t.obstruction == 1 and t.blocker != ti) {
        const v = &s.units[t.blocker];
        if (!v.in_holder or v.isDead()) return error.Rejected;
        epicentre = t.blocker;
    }
    var cells: Cells = .{};
    cells.push(t.impact);
    var ring: Cells = .{};
    cellsAroundCell(t.impact, &ring);
    for (ring.slice()) |c| cells.push(c);
    var affected: Slots = .{};
    affectedUnits(s, cells.slice(), &affected);
    var caught: Slots = .{};
    caught.push(epicentre);
    for (affected.slice()) |x| {
        if (s.units[x].isDead() or x == ci or x == epicentre) continue;
        caught.push(x);
    }
    damageTail(s, ci, spell, cfg, caught.slice(), events);
}

/// lightningStrikeCast: any enemy on the board (canCastSpell again), no line of sight.
fn lightningStrike(s: *State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    if (!canCastSpell(s, ci, ti, spell, cfg)) return error.Rejected;
    damageTail(s, ci, spell, cfg, &.{ti}, events);
}

/// ringOfFireCast: canCastSpell, the clear line (creatures and terrain), then every living unit touching the target's
/// body (allies too; never the caster or the target) burns; an empty ring still spends the charge.
fn ringOfFire(s: *State, ci: u8, ti: u8, spell: CS, cfg: *const st.SpellConfig, events: *Events) Reject!void {
    if (!canCastSpell(s, ci, ti, spell, cfg)) return error.Rejected;
    if (sightBlocked(s, engine.baseCell(&s.units[ci]), engine.baseCell(&s.units[ti]), .creatures_and_terrain)) return error.Rejected;
    const body = engine.unitCells(&s.units[ti]);
    var ring: Cells = .{};
    cellsAroundFootprint(body.slice(), &ring);
    var affected: Slots = .{};
    affectedUnits(s, ring.slice(), &affected);
    var caught: Slots = .{};
    for (affected.slice()) |x| {
        if (s.units[x].isDead() or x == ci or x == ti) continue;
        caught.push(x);
    }
    damageTail(s, ci, spell, cfg, caught.slice(), events);
}

/// meteorShowerCast / meteoriteCast: the block at `targetCell` (Meteor Shower's 3x3 centred on it, Meteorite's 2x2 from
/// it, x-major) must lie on the board and catch a living enemy; every enemy under it is a victim, first-touched order.
fn meteor(s: *State, ci: u8, spell: CS, cfg: *const st.SpellConfig, target_cell: ?Cell, events: *Events) Reject!void {
    const c = target_cell orelse return error.Rejected;
    var cells: Cells = .{};
    const spread: []const i32 = if (spell == .meteor_shower) &.{ -1, 0, 1 } else &.{ 0, 1 };
    for (spread) |dx| {
        for (spread) |dy| cells.push(.{ .x = c.x + dx, .y = c.y + dy });
    }
    for (cells.slice()) |x| {
        if (!engine.cellWithinGrid(x)) return error.Rejected;
    }
    var affected: Slots = .{};
    affectedUnits(s, cells.slice(), &affected);
    var enemies: Slots = .{};
    const team = s.units[ci].team;
    for (affected.slice()) |x| {
        if (s.units[x].team != team and !s.units[x].isDead()) enemies.push(x);
    }
    if (enemies.len == 0) return error.Rejected;
    damageTail(s, ci, spell, cfg, enemies.slice(), events);
}

/// canCastSummon for the summoned body anchored at `anchor`: every cell on the board and empty (matrix 0). The test
/// firstSummonableAnchor / summonableAnchors apply to each candidate anchor.
pub fn seatFree(s: *const State, anchor: Cell, w: u8, h: u8) bool {
    const fp = engine.cellsForAnchor(anchor, w, h);
    for (fp.slice()) |c| {
        if (!engine.cellWithinGrid(c) or boardAt(s, c) != st.EMPTY) return false;
    }
    return true;
}

/// summonSpell (Summon Wolves): floor(caster alive * power) Wolves. A living summoned Wolf of the caster's team (the
/// first in holder order) absorbs them (no id, no counter, no draw); otherwise a new 2x1 stack is seated at the
/// explicit targetCell (never relocated) or, without one, the first free anchor around the caster, created as
/// runMatch's createSummonedUnit does (both counters move before the placement) and appended to the holder.
fn summonSpell(s: *State, ci: u8, spell: CS, cfg: *const st.SpellConfig, target_cell: ?Cell, events: *Events) Reject!void {
    const caster = &s.units[ci];
    const amount = @floor(caster.amount_alive * cfg.power);
    if (amount <= 0) return error.Rejected;
    const which = st.Summons.WOLF;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (!u.summoned or u.name_id != s.summon_name_id[which] or u.team != caster.team) continue;
        // Unit.increaseAmountAlive
        if ((!u.isDead() and u.summoned) or (u.isDead() and !u.summoned)) u.amount_alive += amount;
        useSpell(caster, spell);
        engine.completeTurn(s, ci, false, false, events);
        return;
    }
    const sm = s.summons orelse {
        s.overflow = true; // the recording carries no Wolf template
        return error.Rejected;
    };
    if (!sm.present[which]) {
        s.overflow = true;
        return error.Rejected;
    }
    var nu = sm.units[which];
    var seat: ?Cell = null;
    if (target_cell) |c| {
        if (seatFree(s, c, nu.fw, nu.fh)) seat = c;
    } else {
        // resolveSummonAnchor -> firstSummonableAnchor over the caster's ring (runMatch passes no target-cell hook)
        var ring: Cells = .{};
        const body = engine.unitCells(caster);
        cellsAroundFootprint(body.slice(), &ring);
        var tried: Cells = .{};
        search: for (0..nu.fw) |dx| {
            for (0..nu.fh) |dy| {
                for (ring.slice()) |r| {
                    const a = Cell{ .x = r.x + @as(i32, @intCast(dx)), .y = r.y + @as(i32, @intCast(dy)) };
                    if (tried.has(a)) continue;
                    tried.push(a);
                    if (seatFree(s, a, nu.fw, nu.fh)) {
                        seat = a;
                        break :search;
                    }
                }
            }
        }
    }
    const anchor = seat orelse return error.Rejected;
    const sequence = s.summon_seq;
    s.summon_seq += 1;
    const uuid_sequence = s.uuid_seq;
    s.uuid_seq += 1;
    // resolveSummonCells: the anchor's footprint (the 2x2 in its hand-written order)
    var cells: engine.Cells = .{};
    if (engine.isSmall(&nu)) {
        cells.push(anchor);
    } else if (nu.fw == 2 and nu.fh == 2) {
        cells.push(.{ .x = anchor.x - 1, .y = anchor.y });
        cells.push(anchor);
        cells.push(.{ .x = anchor.x - 1, .y = anchor.y - 1 });
        cells.push(.{ .x = anchor.x, .y = anchor.y - 1 });
    } else cells = engine.cellsForAnchor(anchor, nu.fw, nu.fh);
    const pos = engine.positionForCells(cells.slice()) orelse return error.Rejected;
    nu.amount_alive = amount;
    nu.init.amount_alive = amount;
    const summoner = engine.killerOf(caster);
    _ = engine.addSummon(s, nu, which, &summoner, "spell", sequence, uuid_sequence, cells.slice(), pos) orelse return error.Rejected;
    useSpell(&s.units[ci], spell);
    engine.completeTurn(s, ci, false, false, events);
}

test "vinePathCells is Bresenham from the caster (excluded) to the target (included)" {
    const lane = vinePathCells(.{ .x = 2, .y = 3 }, .{ .x = 7, .y = 5 });
    const want = [_][2]i32{ .{ 3, 3 }, .{ 4, 4 }, .{ 5, 4 }, .{ 6, 5 }, .{ 7, 5 } };
    try std.testing.expectEqual(@as(u8, want.len), lane.len);
    for (want, lane.slice()) |w, c| try std.testing.expect(w[0] == c.x and w[1] == c.y);
}

test "spell damage arithmetic: element, Heavy Armor and resist floors" {
    try std.testing.expectEqual(@as(f64, 229), elementAndResist(300, 1, 23.5));
    try std.testing.expectEqual(@as(f64, 427), elementAndResist(300, 1.5, 5));
    try std.testing.expectEqual(@as(f64, 0), elementAndResist(300, 0, 5));
}
