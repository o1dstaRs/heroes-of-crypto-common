//! Melee, ranged and obstacle attacks: GameActionEngine.meleeAttack / rangeAttack / obstacleAttack and the
//! AttackHandler paths they take in scope (the abilities in abilities.zig, no spells; NORMAL, LAVA_CENTER and
//! BLOCK_CENTER grids). Every unit hit passes the striker's team break chance to engine.applyDamageBreak (the Chaos
//! BREAK_ON_ATTACK roll), at the TypeScript call site's point in the action.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const abilities = @import("abilities.zig");
const terrain = @import("terrain.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
const AT = st.AttackType;
const Events = engine.Events;
const Reject = error{Rejected};

// =====================================================================================================================
// Damage (Unit.calculateAttackDamage and the damage chain)
// =====================================================================================================================

/// FightProperties.getBreakChancePerTeam(striker.getTeam())
inline fn breakChance(s: *const State, striker_i: u8) f64 {
    return s.setup[s.units[striker_i].team].break_chance;
}

/// `victim.applyDamage(damage, getBreakChancePerTeam(striker team), sceneLog, extendBreak)`.
inline fn hit(s: *State, striker_i: u8, victim_i: u8, damage: f64, extend: bool) f64 {
    return engine.applyDamageBreak(s, victim_i, damage, breakChance(s, striker_i), extend);
}

pub fn damageBound(att: *const Unit, tgt: *const Unit, dmg: f64, is_range: bool, divisor_in: f64) f64 {
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
    keys: [8]struct { name: u16, team: u8, amount: f64 } = undefined,
    len: u8 = 0,

    /// updateMoraleDecreaseForTheUnitTeam with one "<name>:<team>" entry (positive amounts only).
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
    items: [st.MAX_UNITS]u8 = undefined,
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

/// MoveHandler.applyMoveModifiers for a path-bearing strike: the client's route (resolveKnownPaths trusts it verbatim)
/// minus its origin; distance morale from the current position to the CENTRE OF THE LAST ROUTE CELL (not the
/// footprint centre). Returns false when nothing is left to travel.
fn applyStrikeMoveModifiers(s: *State, ui: u8, path: []const Cell) bool {
    const u = &s.units[ui];
    const base = engine.baseCell(u);
    const travelled = if (path.len > 0 and path[0].x == base.x and path[0].y == base.y) path[1..] else path; // travelledMovePath
    if (travelled.len == 0) return false;
    const last = travelled[travelled.len - 1];
    const to = engine.positionForCell(@floatFromInt(last.x), @floatFromInt(last.y));
    engine.applyDistanceMorale(s, ui, .{ u.pos_x, u.pos_y }, to);
    return true; // applyTravelledDistanceModifier (Crusade) and applyLavaWaterModifier: no-ops in scope
}

/// handleMeleeAttack's movement prefix: a stationary strike, or (with a client `path`) the walk to `from`. A refusal
/// after the move modifiers keeps their morale change, as in TypeScript.
fn strikeMovePrefix(s: *State, ai: u8, from: Cell, from_cells: []const Cell, path: []const Cell, stationary: bool) Reject!void {
    const att = &s.units[ai];
    // A stationary strike passes the occupancy checks on the unit's own cells and setPosition writes the same value.
    if (stationary) return;
    // canMove(): no Paralysis, Whirlpool or web lock in scope.
    const has_route = path.len != 0; // currentActiveKnownPaths.get(attackFrom key)?.length
    if (engine.isSmall(att)) {
        if (!engine.cellsFreeFor(s, ai, &.{from})) return error.Rejected;
        if (!has_route) return error.Rejected;
        const pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
        if (!applyStrikeMoveModifiers(s, ai, path)) return error.Rejected;
        if (!engine.occupyCell(s, ai, from)) return error.Rejected;
        att.pos_x = pos[0];
        att.pos_y = pos[1];
        return;
    }
    // getPositionForFootprintAnchor, then that position's footprint cells
    const anchor_pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
    const pos = [2]f64{
        anchor_pos[0] - (@as(f64, @floatFromInt(@max(1, att.fw))) - 1) * engine.HALF,
        anchor_pos[1] - (@as(f64, @floatFromInt(@max(1, att.fh))) - 1) * engine.HALF,
    };
    const cells = engine.cellsForPosition(pos[0], pos[1], att.fw, att.fh);
    if (!engine.cellsFreeFor(s, ai, cells.slice()) and !engine.cellsFreeFor(s, ai, from_cells)) return error.Rejected;
    if (!has_route) return error.Rejected;
    if (!applyStrikeMoveModifiers(s, ai, path)) return error.Rejected;
    if (!engine.occupyCells(s, ai, cells.slice())) return error.Rejected;
    att.pos_x = pos[0];
    att.pos_y = pos[1];
}

pub fn meleeAttack(s: *State, ai: u8, ti: u8, from: Cell, path: []const Cell, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    if (!s.units[ti].in_holder) return error.Rejected;
    // A path-bearing approach (resolveKnownPaths trusts the client route) must not walk a ground body over "B".
    const approaching = !(engine.baseCell(&s.units[ai]).x == from.x and engine.baseCell(&s.units[ai]).y == from.y);
    if (approaching and path.len != 0 and engine.groundRouteCrossesObstacle(s, &s.units[ai], path)) return error.Rejected;

    const att = &s.units[ai];
    const tgt = &s.units[ti];
    if (att.isDead() or tgt.isDead()) return error.Rejected;
    if (att.attack_type_selected != AT.MELEE and att.attack_type_selected != AT.MELEE_MAGIC) return error.Rejected;
    if (att.team == tgt.team) return error.Rejected;
    // An Aggr'd attacker may strike only its live forced target.
    if (forcedTarget(s, att)) |f| {
        if (f != ti) return error.Rejected;
    }
    const current = engine.baseCell(att);
    const from_cells = engine.cellsForAnchor(from, att.fw, att.fh);
    const tgt_cells = engine.unitCells(tgt);
    if (!adjacent(from_cells.slice(), tgt_cells.slice())) return error.Rejected;
    const stationary = current.x == from.x and current.y == from.y;
    try strikeMovePrefix(s, ai, from, from_cells.slice(), path, stationary);

    // chargedRouteCells: a stationary strike after this turn's move charges that move's route; a path-bearing strike
    // charges its whole route (path.length, origin included); otherwise there are no known paths and no charge.
    var ability_multiplier: f64 = 1;
    var rapid_cells: f64 = 1;
    if (stationary and att.moved_this_turn and att.moved_route_cells > 0) {
        rapid_cells = att.moved_route_cells;
        ability_multiplier = abilities.rapidCharge(att, rapid_cells);
    } else if (path.len != 0) {
        rapid_cells = @floatFromInt(path.len);
        ability_multiplier = abilities.rapidCharge(att, rapid_cells);
    }
    ability_multiplier *= abilities.positionMultiplierOn(att, from, engine.baseCell(tgt), tgt.fw, tgt.fh, s.fight.side_oriented);

    var died: Died = .{};
    var decrease: MoraleDecrease = .{};
    var attacker_plus: f64 = 0;
    var target_plus: f64 = 0;

    const missed = missRoll(s, att, tgt); // M1
    att.attack_mod = @max(0, att.attack_mod); // cleanupAttackModIncrease (+ getUnitAuraAttackMod = 0)
    const damage_from_attack = luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.MELEE, 1, ability_multiplier)) +
        abilities.penetratingBite(att, tgt); // M2: drawn even when a spin replaces the blow

    const spin_attack = lightningSpin(s, ai, from, true, ai, rapid_cells, &died);
    // The same radial impact knocks down every scattered stone in the spin's ring.
    if (spin_attack) spinStones(s, ai, from);
    if (att.has(.skewer_strike)) {
        skewerStrike(s, ai, ti, from, true, &died, &decrease, &attacker_plus);
        // Past a small target the skewer runs on into a stone standing behind it (skewerStrikeObstacleCell).
        if (engine.isSmall(tgt) and terrain.hasScatteredMountains(s)) {
            if (pierceCellBehind(att, from, engine.baseCell(tgt))) |behind| {
                if (engine.cellWithinGrid(behind) and terrain.isScatteredMountainCell(s, behind) and
                    s.grid.board[@intCast(behind.x)][@intCast(behind.y)] == st.BLOCK)
                {
                    terrain.spendObstacleHit(s, behind, behind.x >= st.GRID >> 1);
                }
            }
        }
    }

    // The response lands first.
    var spin_response = meleeResponse(s, ai, ti, from, &died, &decrease, &target_plus);
    if (!spin_attack and !missed and !tgt.isDead()) {
        const absorbed = damage_from_attack > 0 and abilities.absorbs(s, tgt);
        _ = hit(s, ai, ti, damage_from_attack, false); // attack_handler.ts:3214
        s.damage_lap = s.fight.lap;
        if (!absorbed) {
            meleeRiders(s, ai, ti, damage_from_attack);
            attacker_plus += abilities.pegasusLightMorale(tgt);
        }
    }
    engine.refreshStackPowerForAllUnits(s);

    const punch = doublePunch(s, ai, ti);

    if (!spin_response and att.isDead() and !died.includes(ai)) {
        died.push(ai);
        target_plus += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(att, engine.MORALE_CHANGE_FOR_KILL);
    }
    if (!spin_attack and tgt.isDead() and !died.includes(ti)) {
        died.push(ti);
        attacker_plus += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(tgt, engine.MORALE_CHANGE_FOR_KILL);
    } else if (punch.applied) {
        spin_response = meleeResponse(s, ai, ti, from, &died, &decrease, &target_plus);
        const absorbed = punch.damage > 0 and abilities.absorbs(s, tgt);
        if (punch.damage > 0) {
            _ = hit(s, ai, ti, punch.damage, false); // attack_handler.ts:3400
            s.damage_lap = s.fight.lap;
        }
        if (!punch.missed and !absorbed) meleeRiders(s, ai, ti, punch.damage); // no Pegasus Light morale read after them
        if (!spin_response and att.isDead() and !died.includes(ai)) {
            died.push(ai);
            target_plus += engine.MORALE_CHANGE_FOR_KILL;
            decrease.add(att, engine.MORALE_CHANGE_FOR_KILL);
        }
        if (!spin_attack and tgt.isDead() and !died.includes(ti)) {
            died.push(ti);
            attacker_plus += engine.MORALE_CHANGE_FOR_KILL;
            decrease.add(tgt, engine.MORALE_CHANGE_FOR_KILL);
        }
    }
    engine.changeMorale(tgt, target_plus, true);
    engine.changeMorale(att, attacker_plus + punch.morale, true);
    decrease.apply(s);
    engine.refreshStackPowerForAllUnits(s);
    abilities.devourEssence(s, ai, died.items[0..died.len]);
    abilities.devourEssence(s, ti, died.items[0..died.len]);

    cleanupDeadUnits(s, &died, events);
    engine.completeTurn(s, ai, false, false, events);
}

/// getTarget() resolved the way the engine and liveForcedTargetId do: the forced unit while it is alive in the holder.
pub fn forcedTarget(s: *const State, u: *const Unit) ?u8 {
    if (u.target < 0) return null;
    const t: u8 = @intCast(u.target);
    const fu = &s.units[t];
    if (!fu.in_holder or fu.isDead()) return null;
    return t;
}

/// The on-hit riders of a landed, unabsorbed melee blow or second punch from `from_i` (the active unit) on `to_i`, in
/// handleMeleeAttack's order: Dulling Defense, Aggr, Pegasus Light, Shatter Armor, Venom Cloud poison.
fn meleeRiders(s: *State, from_i: u8, to_i: u8, damage: f64) void {
    if (s.units[from_i].ability_mask != 0) {
        abilities.dullingDefense(&s.units[from_i], &s.units[to_i]);
        abilities.aggr(s, from_i, to_i, from_i);
        abilities.pegasusLight(s, from_i, to_i, from_i);
        abilities.shatterArmor(s, from_i, to_i, from_i);
    }
    abilities.poisonAura(s, from_i, to_i, damage);
}

/// canUnitRespondToMelee (src/handlers/melee_response.ts): an Aggr'd target answers only its forced attacker (the raw
/// target id, alive or not), nobody answers a Lightning Spin attacker, and the reply is spent once.
fn canRespondToMelee(s: *const State, att: *const Unit, ai: u8, ti: u8) bool {
    const tgt = &s.units[ti];
    if (abilities.skipsResponse(att)) return false;
    if (tgt.target >= 0 and tgt.target != @as(i8, @intCast(ai))) return false;
    return !tgt.responded and s.fight.replied & engine.unitBit(ti) == 0;
}

/// handleMeleeAttack's captureResponse: the target strikes back once (its reply is spent even on a miss). A
/// responding Pikeman skewers behind the attacker and a responding Hydra spins (whatever the miss roll says);
/// a spin replaces the plain response. Returns whether a response spin landed.
fn meleeResponse(s: *State, ai: u8, ti: u8, from: Cell, died: *Died, decrease: *MoraleDecrease, target_plus: *f64) bool {
    const att = &s.units[ai];
    const tgt = &s.units[ti];
    if (tgt.isDead() or !canRespondToMelee(s, att, ai, ti)) return false;
    const missed = missRoll(s, tgt, att); // M3
    const tgt_base = engine.baseCell(tgt);
    if (tgt.ability_mask & st.AbilityId.skewer_strike.bit() != 0) skewerStrike(s, ti, ai, tgt_base, false, died, decrease, target_plus);
    const spin = lightningSpin(s, ti, tgt_base, false, ai, 1, died);
    if (!missed and !spin and !att.isDead()) {
        const ability_multiplier = abilities.positionMultiplierOn(tgt, tgt_base, from, att.fw, att.fh, s.fight.side_oriented);
        const damage_from_response = luckyStrike(s, tgt, calculateAttackDamage(s, tgt, att, AT.MELEE, 1, ability_multiplier)) +
            abilities.penetratingBite(tgt, att); // M4
        const absorbed = damage_from_response > 0 and abilities.absorbs(s, att);
        _ = hit(s, ti, ai, damage_from_response, true); // attack_handler.ts:3072: the active attacker's Break extends
        s.damage_lap = s.fight.lap;
        if (!absorbed) {
            target_plus.* += abilities.pegasusLightMorale(att);
            // The responder's riders: Dulling Defense, Aggr, Venom Cloud poison, Pegasus Light (Shatter Armor rides
            // only the attacker's blows).
            if (tgt.ability_mask != 0) {
                abilities.dullingDefense(tgt, att);
                abilities.aggr(s, ti, ai, ai);
            }
            abilities.poisonAura(s, ti, ai, damage_from_response);
            if (tgt.ability_mask != 0) abilities.pegasusLight(s, ti, ai, ai);
        }
    }
    spendReply(s, ti);
    return spin;
}

const Punch = struct { applied: bool = false, missed: bool = false, damage: f64 = 0, morale: f64 = 0 };

/// processDoublePunchAbility: a second strike with its own miss roll (an Aggr'd puncher only at its forced target).
fn doublePunch(s: *State, ai: u8, ti: u8) Punch {
    const att = &s.units[ai];
    const tgt = &s.units[ti];
    const a = att.ability(.double_punch) orelse return .{};
    if (att.isDead() or tgt.isDead()) return .{};
    if (att.target >= 0 and att.target != @as(i8, @intCast(ti))) return .{};
    if (missRoll(s, att, tgt)) return .{ .applied = true, .missed = true };
    const ability_multiplier = abilities.abilityMultiplier(att, a);
    const damage = luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.MELEE, 1, ability_multiplier)) +
        abilities.penetratingBite(att, tgt);
    return .{ .applied = true, .damage = damage, .morale = abilities.pegasusLightMorale(tgt) };
}

/// UnitsHolder.allEnemiesAroundUnit(unit, isAttack, attackFromCell): enemies on the cells touching the body anchored
/// at `first` (getCellsAroundCell for a 1x1; the (w+2) x (h+2) box, x outer, for larger bodies), first-seen order.
pub fn enemiesAround(s: *const State, ui: u8, first: Cell, out: *engine.UnitList) void {
    const u = &s.units[ui];
    out.* = .{};
    const Visit = struct {
        fn cell(st_: *const State, attacker: u8, c: Cell, list: *engine.UnitList) void {
            if (!engine.cellWithinGrid(c)) return;
            const o = st_.grid.board[@intCast(c.x)][@intCast(c.y)];
            if (!st.isUnitCode(o)) return;
            const x: u8 = o - 1;
            if (x == attacker) return;
            const e = &st_.units[x];
            if (!e.in_holder or e.team == st_.units[attacker].team) return;
            for (list.slice()) |y| if (y == x) return;
            list.push(x);
        }
    };
    if (engine.isSmall(u)) {
        // getCellsAroundCell order, in-grid only.
        const ring = [8][2]i32{ .{ -1, 1 }, .{ 0, 1 }, .{ -1, 0 }, .{ 1, 1 }, .{ 1, 0 }, .{ -1, -1 }, .{ 0, -1 }, .{ 1, -1 } };
        for (ring) |d| Visit.cell(s, ui, .{ .x = first.x + d[0], .y = first.y + d[1] }, out);
        return;
    }
    var i: i32 = -@as(i32, u.fw);
    while (i <= 1) : (i += 1) {
        var j: i32 = -@as(i32, u.fh);
        while (j <= 1) : (j += 1) Visit.cell(s, ui, .{ .x = first.x + i, .y = first.y + j }, out);
    }
}

/// processLightningSpinAbility: every enemy around the spinner (at its strike cell, or where it stands when
/// responding) takes a sub-hit in ring order, each with its own miss roll and, when not missed, damage roll; the
/// spin's kill and Pegasus Light morale and its same-name morale losses apply at once. Returns whether it landed
/// (whenever the unit has the ability).
fn lightningSpin(s: *State, from_i: u8, first: Cell, is_attack: bool, active_i: u8, rapid_cells: f64, died: *Died) bool {
    const from = &s.units[from_i];
    const a = from.ability(.lightning_spin) orelse return false; // none while Broken
    var ring: engine.UnitList = undefined;
    enemiesAround(s, from_i, first, &ring); // no Terrifying Gaze lock or Flesh Shield owners in scope
    const common = abilities.rapidCharge(from, rapid_cells);
    var dead: Died = .{};
    var morale: f64 = 0;
    var decrease: MoraleDecrease = .{};
    for (ring.slice()) |ei| {
        const enemy = &s.units[ei];
        if (enemy.isDead()) continue;
        if (missRoll(s, from, enemy)) continue;
        const ability_multiplier = abilities.abilityMultiplier(from, a) * common;
        var damage = luckyStrike(s, from, calculateAttackDamage(s, from, enemy, AT.MELEE, 1, ability_multiplier)) +
            abilities.penetratingBite(from, enemy);
        damage = @floor(damage * 1); // getPhysicalAoeDamageMultiplier
        const absorbed = damage > 0 and abilities.absorbs(s, enemy);
        const dealt = hit(s, from_i, ei, damage, false); // lightning_spin_ability.ts:239
        abilities.poisonAura(s, from_i, ei, dealt);
        s.damage_lap = s.fight.lap;
        if (!absorbed) morale += abilities.pegasusLightMorale(enemy);
        if (enemy.isDead()) {
            dead.push(ei);
        } else if (!absorbed) {
            abilities.dullingDefense(from, enemy);
            abilities.aggr(s, from_i, ei, active_i);
            abilities.pegasusLight(s, from_i, ei, active_i);
            if (is_attack) abilities.shatterArmor(s, from_i, ei, active_i);
        }
    }
    for (dead.items[0..dead.len]) |d| {
        died.push(d);
        morale += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(&s.units[d], engine.MORALE_CHANGE_FOR_KILL);
    }
    if (!is_attack) spendReply(s, from_i);
    if (!from.isDead()) engine.changeMorale(from, morale, true);
    decrease.apply(s);
    return true;
}

/// processSkewerStrikeAbility -> nextStandingTargets(pierceLargeUnits = false, onlyOppositeTeam) -> strikeSkewerTargets:
/// past a 1x1 target, the enemy on the cell straight behind it (as seen from `from_cell`, the striker's cell) takes
/// a hit with its own miss and damage rolls (no Lucky Strike, no response). Kills and morale go to the caller's
/// bookkeeping. Only 1x1 units (Pikemen) carry the ability.
fn skewerStrike(s: *State, from_i: u8, to_i: u8, from_cell: Cell, is_attack: bool, died: *Died, decrease: *MoraleDecrease, plus: *f64) void {
    const from = &s.units[from_i];
    if (!from.has(.skewer_strike)) return;
    const to = &s.units[to_i];
    if (!engine.isSmall(to)) return;
    const tb = engine.baseCell(to);
    const c = Cell{ .x = tb.x + (tb.x - from_cell.x), .y = tb.y + (tb.y - from_cell.y) };
    if (!engine.cellWithinGrid(c)) return;
    const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
    if (!st.isUnitCode(o)) return; // a stone behind the target is broken by the caller, not skewered
    const vi: u8 = o - 1;
    const next = &s.units[vi];
    if (!next.in_holder or vi == from_i or vi == to_i or next.team == from.team) return;
    strikeSkewerTarget(s, from_i, vi, is_attack, died, decrease, plus);
}

/// strikeSkewerTargets for one chosen victim: its miss roll and damage roll (no Lucky Strike, no response), the
/// riders of a landed unabsorbed hit, and the kill's bookkeeping in the caller's lists.
fn strikeSkewerTarget(s: *State, from_i: u8, vi: u8, is_attack: bool, died: *Died, decrease: *MoraleDecrease, plus: *f64) void {
    const from = &s.units[from_i];
    const a = from.ability(.skewer_strike) orelse return;
    const next = &s.units[vi];
    if (next.isDead()) return;
    if (missRoll(s, from, next)) return; // S1
    var damage = calculateAttackDamage(s, from, next, AT.MELEE, 1, abilities.abilityMultiplier(from, a)); // S2
    damage = @floor(damage * 1); // getPhysicalAoeDamageMultiplier
    const absorbed = damage > 0 and abilities.absorbs(s, next);
    const dealt = hit(s, from_i, vi, damage, false); // skewer_strike_ability.ts:210
    s.damage_lap = s.fight.lap;
    if (!next.isDead() and !absorbed) {
        abilities.poisonAura(s, from_i, vi, dealt);
        abilities.dullingDefense(from, next);
        abilities.aggr(s, from_i, vi, from_i); // A3
        abilities.pegasusLight(s, from_i, vi, from_i);
        if (is_attack) abilities.shatterArmor(s, from_i, vi, from_i);
    }
    if (next.isDead()) {
        died.push(vi);
        plus.* += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(next, engine.MORALE_CHANGE_FOR_KILL);
    }
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
        if (o == st.BLOCK) break; // the ray stops at the first mountain or stone (attackObstacle)
        if (!st.isUnitCode(o)) continue; // empty, a hole, or lava (an affectedCells entry no one reads in scope)
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

/// isRangeAttackSideObservable: the neighbour across that side is empty, a hole, lava, off the board, or the shooter's
/// own team (a mountain or stone hides it).
pub fn sideObservable(s: *const State, cell: Cell, side: u8, from_team: u8) bool {
    const n: Cell = switch (side) {
        0 => .{ .x = cell.x - 1, .y = cell.y },
        1 => .{ .x = cell.x + 1, .y = cell.y },
        2 => .{ .x = cell.x, .y = cell.y - 1 },
        else => .{ .x = cell.x, .y = cell.y + 1 },
    };
    if (!engine.cellWithinGrid(n)) return true;
    const o = s.grid.board[@intCast(n.x)][@intCast(n.y)];
    if (o == st.BLOCK) return false;
    if (!st.isUnitCode(o)) return true;
    return s.units[o - 1].team == from_team;
}

/// getRangeAttackSideCenter
pub fn sideCenter(cell: Cell, side: u8, ax: f64, ay: f64) [2]f64 {
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
    // An Aggr'd shooter's shot must land first on its live forced target.
    if (forcedTarget(s, att)) |f| {
        if (f != target_ui) return error.Rejected;
    }
    var idx: usize = 1;

    const missed = missRoll(s, att, tgt);
    var responder_target: ?u8 = null;
    var response_missed = false;
    var response_absorbed = false;
    if (response_victim) |rv| {
        // An Aggr'd target counter-shoots only its forced attacker (the raw target id).
        const aggr_ok = tgt.target < 0 or tgt.target == @as(i8, @intCast(ai));
        if (!abilities.skipsResponse(att) and s.fight.replied & engine.unitBit(target_ui) == 0 and engine.canLandRangeAttack(s, tgt) and aggr_ok) {
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
            response_absorbed = damage_from_response > 0 and abilities.absorbs(s, victim);
            // attack_handler.ts:1763: extended only when the counter-shot hits the shooter whose turn it is.
            _ = hit(s, target_ui, rv, damage_from_response, rv == ai);
            s.damage_lap = s.fight.lap;
            if (!response_absorbed) {
                target_plus += abilities.pegasusLightMorale(victim); // dropped unless an early return applies it
                abilities.poisonAura(s, target_ui, rv, damage_from_response);
            }
        }
        spendReply(s, target_ui);
    }

    if (!missed) {
        const absorbed = damage_from_attack > 0 and abilities.absorbs(s, tgt);
        _ = hit(s, ai, target_ui, damage_from_attack, false); // attack_handler.ts:1886
        s.damage_lap = s.fight.lap;
        if (!absorbed) attacker_plus += abilities.pegasusLightMorale(tgt);
        if (!tgt.isDead() and !absorbed) {
            abilities.spitBall(s, target_ui); // the Absorb Penalties roll
            abilities.poisonAura(s, ai, target_ui, damage_from_attack);
        }
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
            } else if (!response_missed and !response_absorbed) {
                abilities.spitBall(s, rv); // the counter-shot victim's Absorb Penalties roll
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

// =====================================================================================================================
// Obstacles (BLOCK_CENTER): GameActionEngine.obstacleAttack, AttackHandler.handleObstacleAttack
// =====================================================================================================================

/// AbilityHelper.pierceCellBehind: the cell one step past `target` on the line from the attacker's body cell closest
/// to it (a 2x2 in its hand-written order, first strictly closer wins), or null when the attacker is not in contact.
fn pierceCellBehind(att: *const Unit, from: Cell, target: Cell) ?Cell {
    var a = from;
    if (!engine.isSmall(att)) {
        var body: engine.Cells = .{};
        if (att.fw == 2 and att.fh == 2) {
            body.push(from);
            body.push(.{ .x = from.x - 1, .y = from.y });
            body.push(.{ .x = from.x, .y = from.y - 1 });
            body.push(.{ .x = from.x - 1, .y = from.y - 1 });
        } else body = engine.cellsForAnchor(from, att.fw, att.fh);
        a = body.items[0];
        var best = cellDist(a, target);
        for (body.slice()) |c| {
            const d = cellDist(c, target);
            if (d < best) {
                a = c;
                best = d;
            }
        }
    }
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    if (@max(@abs(dx), @abs(dy)) != 1) return null;
    return .{ .x = target.x + dx, .y = target.y + dy };
}

inline fn cellDist(a: Cell, b: Cell) f64 {
    return engine.distance(@floatFromInt(a.x), @floatFromInt(a.y), @floatFromInt(b.x), @floatFromInt(b.y));
}

/// AttackHandler.spinScatteredObstaclesAround (lightningSpinObstacleCells): every standing stone in the spin's ring
/// (UnitsHolder.cellsAroundUnit at the strike anchor) goes down.
fn spinStones(s: *State, ui: u8, first: Cell) void {
    if (!terrain.hasScatteredMountains(s)) return;
    const u = &s.units[ui];
    const Visit = struct {
        fn cell(st_: *State, c: Cell) void {
            if (!engine.cellWithinGrid(c)) return;
            if (!terrain.isScatteredMountainCell(st_, c) or st_.grid.board[@intCast(c.x)][@intCast(c.y)] != st.BLOCK) return;
            terrain.spendObstacleHit(st_, c, c.x >= st.GRID >> 1);
        }
    };
    var i: i32 = if (engine.isSmall(u)) -1 else -@as(i32, u.fw);
    while (i <= 1) : (i += 1) {
        var j: i32 = if (engine.isSmall(u)) -1 else -@as(i32, u.fh);
        while (j <= 1) : (j += 1) {
            if (engine.isSmall(u) and i == 0 and j == 0) continue;
            Visit.cell(s, .{ .x = first.x + i, .y = first.y + j });
        }
    }
}

/// AttackHandler.pierceScatteredObstacleBehind for Skewer Strike (no Fire Breath in scope): past a struck stone the
/// skewer breaks the stone behind it, or strikes the live enemy standing there (strikeSkewerTargets, then the
/// attacker's morale and the same-name morale losses at once). Kills go to `died`.
fn pierceStoneBehind(s: *State, ai: u8, from: Cell, target: Cell, died: *Died) void {
    const att = &s.units[ai];
    if (!terrain.isScatteredMountainCell(s, target) or !att.has(.skewer_strike)) return;
    const behind = pierceCellBehind(att, from, target) orelse return;
    if (!engine.cellWithinGrid(behind)) return;
    const o = s.grid.board[@intCast(behind.x)][@intCast(behind.y)];
    if (o == st.BLOCK) {
        if (terrain.isScatteredMountainCell(s, behind)) terrain.spendObstacleHit(s, behind, behind.x >= st.GRID >> 1);
        return;
    }
    if (!st.isUnitCode(o)) return;
    const vi: u8 = o - 1;
    const v = &s.units[vi];
    if (!v.in_holder or v.isDead() or v.team == att.team) return;
    var decrease: MoraleDecrease = .{};
    var plus: f64 = 0;
    strikeSkewerTarget(s, ai, vi, true, died, &decrease, &plus);
    if (!att.isDead()) engine.changeMorale(att, plus, true);
    decrease.apply(s);
}

/// AttackHandler.handleObstacleAttack's range branch (a shooter with RANGE selected that can land a shot): on a
/// scattered board the shot breaks the FIRST stone on its ray (getObstacleIntersections(...)[0]: no Double Shot in
/// scope), on the classic board it spends the aimed mountain's hit; either way one arrow is spent. No miss or
/// damage roll, and no Quiver of Echoes (an artifact) volley. Returns rangeLanded.
fn rangedObstacleShot(s: *State, ai: u8, tx: f64, ty: f64) bool {
    const att = &s.units[ai];
    var landed = false;
    if (terrain.hasScatteredMountains(s)) {
        const ray = traceRay(att.pos_x, att.pos_y, tx, ty);
        for (ray.items[0..ray.len]) |h| {
            if (!engine.cellWithinGrid(h.cell) or s.grid.board[@intCast(h.cell.x)][@intCast(h.cell.y)] != st.BLOCK) continue;
            const c = engine.cellForPosition(h.x, h.y);
            terrain.spendObstacleHit(s, c, c.x >= st.GRID >> 1);
            landed = true;
            break;
        }
    } else {
        const c = engine.cellForPosition(tx, ty);
        terrain.spendObstacleHit(s, c, c.x >= st.GRID >> 1);
        landed = true;
    }
    // decreaseNumberOfShots
    att.range_shots -= 1;
    if (att.range_shots < 0) att.range_shots = 0;
    att.range_shots = @floor(att.range_shots);
    return landed;
}

/// AttackHandler.handleObstacleAttack: the range branch when the attacker can shoot (rangedObstacleShot), else the
/// melee branch: the walk in (or a strike in place), the hit, Skewer Strike's pierce, Double Punch's second hit,
/// then Hydra's Lightning Spin around the strike anchor. No miss or damage roll on the stone itself. Returns
/// `completed`; kills from the pierce and the spin go to `died`. `from` is null for a shot without attackFrom.
fn handleObstacleAttack(s: *State, ai: u8, tx: f64, ty: f64, from_opt: ?Cell, path: []const Cell, died: *Died) bool {
    const att = &s.units[ai];
    const target = engine.cellForPosition(tx, ty);
    const is_right = target.x >= st.GRID >> 1;
    if ((!terrain.hasScatteredMountains(s) and s.fight.grid_type != st.GridType.BLOCK_CENTER) or !terrain.obstacleStillStands(s) or
        att.isDead() or !engine.positionWithinGrid(tx, ty) or !engine.positionWithinGrid(att.pos_x, att.pos_y)) return false;
    if (forcedTarget(s, att) != null) return false;
    var center: terrain.CenterCells = undefined;
    terrain.centerCells(s, &center);
    var found = false;
    for (center.slice()) |c| {
        if (c.x == target.x and c.y == target.y) found = true;
    }
    if (!found) return false;

    if (att.attack_type_selected == AT.RANGE and engine.canLandRangeAttack(s, att)) {
        if (rangedObstacleShot(s, ai, tx, ty)) return true;
    }
    // A shot that broke nothing completes with nothing done (the caller then refuses it: nothing landed).
    const from = from_opt orelse return true;

    // isAdjacentToCenter: any cell of the body at the strike anchor touches any standing obstacle cell.
    const from_cells = engine.cellsForAnchor(from, att.fw, att.fh);
    var adjacent_to_center = false;
    outer: for (from_cells.slice()) |c| {
        for (center.slice()) |cc| {
            if (@abs(c.x - cc.x) <= 1 and @abs(c.y - cc.y) <= 1) {
                adjacent_to_center = true;
                break :outer;
            }
        }
    }
    if (!adjacent_to_center) return false;
    const base = engine.baseCell(att);
    const stationary = base.x == from.x and base.y == from.y;
    const has_route = path.len != 0; // currentActiveKnownPaths.get(attackFrom)?.length
    if (engine.isSmall(att)) {
        if (!(engine.cellsFreeFor(s, ai, from_cells.slice()) and (stationary or has_route))) return false;
        const pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
        if (!stationary) {
            if (!applyStrikeMoveModifiers(s, ai, path)) return false;
            if (!engine.occupyCell(s, ai, from)) return false;
        }
        att.pos_x = pos[0];
        att.pos_y = pos[1];
    } else {
        const anchor_pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
        const pos = [2]f64{
            anchor_pos[0] - (@as(f64, @floatFromInt(@max(1, att.fw))) - 1) * engine.HALF,
            anchor_pos[1] - (@as(f64, @floatFromInt(@max(1, att.fh))) - 1) * engine.HALF,
        };
        const cells = engine.cellsForPosition(pos[0], pos[1], att.fw, att.fh);
        if (!(engine.cellsFreeFor(s, ai, cells.slice()) and (stationary or has_route))) return false;
        if (!stationary) {
            if (!applyStrikeMoveModifiers(s, ai, path)) return false;
            if (!engine.occupyCells(s, ai, cells.slice())) return false;
        }
        att.pos_x = pos[0];
        att.pos_y = pos[1];
    }
    terrain.spendObstacleHit(s, target, is_right);
    pierceStoneBehind(s, ai, from, target, died);
    if (terrain.obstacleStillStands(s) and att.has(.double_punch)) terrain.spendObstacleHit(s, target, is_right);

    // spinAroundObstacleStrike: the spin lands as off a unit strike (chargedRouteCells ?? 1), then the stones around.
    if (att.has(.lightning_spin)) {
        var rapid_cells: f64 = 1;
        if (stationary and att.moved_this_turn and att.moved_route_cells > 0) {
            rapid_cells = att.moved_route_cells;
        } else if (has_route) {
            rapid_cells = @floatFromInt(path.len);
        }
        _ = lightningSpin(s, ai, from, true, ai, rapid_cells, died);
        spinStones(s, ai, from);
    }
    // Kills off an obstacle strike feed Devour Essence the way a unit strike's do.
    if (died.len != 0) {
        engine.refreshStackPowerForAllUnits(s);
        abilities.devourEssence(s, ai, died.items[0..died.len]);
    }
    return true;
}

/// GameActionEngine.obstacleAttack: strike a classic mountain cell or a scattered stone at `targetPosition` from
/// `attackFrom` (a moving strike carries the client route in `path`). RNG: none of its own; a Pikeman's pierce and a
/// Hydra's spin roll as on a unit strike. A refusal after the walk in keeps the move, as in TypeScript.
pub fn obstacleAttack(s: *State, ai: u8, tx: f64, ty: f64, from: Cell, path: []const Cell, events: *Events) Reject!void {
    return obstacleAttackAt(s, ai, tx, ty, from, path, events);
}

/// GameActionEngine.obstacleAttack with an optional `attackFrom`: a shooter with RANGE selected that can land a shot
/// fires at the obstacle instead (attackFrom and the route are then ignored; refused after this turn's move).
/// Area Throw / Large Caliber (areaStrikeAtCell) are not in scope.
pub fn obstacleAttackAt(s: *State, ai: u8, tx: f64, ty: f64, from: ?Cell, path: []const Cell, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    const att = &s.units[ai];
    const target = engine.cellForPosition(tx, ty);
    const scattered = terrain.isScatteredMountainCell(s, target);
    const standing_before = terrain.standingCount(s);
    if ((!scattered and s.fight.grid_type != st.GridType.BLOCK_CENTER) or
        (if (scattered) standing_before == 0 else terrain.hitsLeft(s) <= 0)) return error.Rejected; // obstacle_not_available
    const can_land_range = att.attack_type_selected == AT.RANGE and engine.canLandRangeAttack(s, att);
    if (!can_land_range and from == null) return error.Rejected; // attack_not_available
    if (can_land_range and att.moved_this_turn) return error.Rejected; // MOVED_THIS_TURN_MELEE_ONLY
    const hits_before = terrain.hitsLeft(s);
    if (from) |f| {
        const base = engine.baseCell(att);
        const approaching = !can_land_range and !(base.x == f.x and base.y == f.y);
        if (approaching and path.len != 0 and engine.groundRouteCrossesObstacle(s, att, path)) return error.Rejected;
    }

    var died: Died = .{};
    const completed = handleObstacleAttack(s, ai, tx, ty, from, path, &died);
    const landed = if (scattered) terrain.standingCount(s) < standing_before else terrain.hitsLeft(s) < hits_before;
    if (!completed or !landed) return error.Rejected;

    engine.refreshStackPowerForAllUnits(s);
    cleanupDeadUnits(s, &died, events);
    // Clear whichever classic mountain ran out of hits (clearMountainSide is idempotent).
    if (!scattered) {
        if (s.fight.hits_left <= 0) _ = terrain.clearMountainSide(s, false);
        if (s.fight.hits_right <= 0) _ = terrain.clearMountainSide(s, true);
    }
    engine.completeTurn(s, ai, false, false, events);
}
