//! Creature abilities: the per-unit ability formulas (src/units/unit.ts `calculateAbility*`, `calculateMissChance`),
//! the processors in src/abilities/*.ts that need no damage roll, and the team blessings of
//! UnitsHolder.refreshStackPowerForAllUnits (`captureBlessingCensus`, `reapplyTeamBlessing`).
//!
//! The synergy term of every formula is the owner's team ability power (`Unit.syn_power`, Might's
//! PLUS_STACK_ABILITIES_POWER); Break turns abilities and emitted auras off through `Unit.has` / `ability` /
//! `auraCount`. In scope there are no artifacts, Made of Fire, Mechanism or Empower readers, so those branches are
//! left out; the arithmetic keeps TypeScript's evaluation order so every double matches.

const std = @import("std");
const st = @import("state.zig");
const artifacts = @import("artifacts.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const spells = @import("spells.zig");

const Unit = st.Unit;
const State = st.State;
const Ability = st.Ability;
const PT = st.PowerType;
const AT = st.AttackType;

pub const MAX_UNIT_STACK_POWER: f64 = 5;

// =====================================================================================================================
// Ability formulas (src/units/unit.ts)
// =====================================================================================================================

/// Unit.calculateAbilityMultiplier with the unit's own team ability power (every engine call site in scope).
pub fn abilityMultiplier(u: *const Unit, a: *const Ability) f64 {
    return abilityMultiplierSyn(u, a, u.syn_power);
}

/// Unit.calculateAbilityMultiplier(ability, synergyAbilityPowerIncrease) with an explicit synergy power (the AI's
/// damage estimates pass 0 or the attacker's).
pub fn abilityMultiplierSyn(u: *const Unit, a: *const Ability, syn: f64) f64 {
    var coeff: f64 = 1;
    switch (a.power_type) {
        PT.TOTAL_DAMAGE_PERCENTAGE, PT.MAGIC_DAMAGE, PT.KILL_RANDOM_AMOUNT, PT.IGNORE_ARMOR, PT.MAGIC_RESIST_50, PT.MAGIC_RESIST_25, PT.ABSORB_DEBUFF, PT.BOOST_HEALTH => {
            var combined = a.power + engine.getLuck(u) + artifacts.fireTerm(artifacts.madeOfFire(u), a.power) + syn;
            if (combined < 0) combined = 1;
            if (a.stack_powered) {
                coeff *= (combined / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u);
            } else {
                coeff *= combined / 100;
            }
        },
        PT.ADDITIONAL_DAMAGE_PERCENTAGE, PT.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE, PT.ADDITIONAL_RANGE_ARMOR_PERCENTAGE => {
            const own = if (a.stack_powered) (a.power / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) else a.power / 100;
            coeff += own + (engine.getLuck(u) + syn) / 100 + artifacts.fireTerm(artifacts.madeOfFire(u), a.power) / 100;
        },
        else => {},
    }
    // Empower scales only Chain Lightning, Fire Breath and Fire Shield: none in scope.
    return coeff;
}

/// Unit.calculateAbilityApplyChance
pub fn applyChance(u: *const Unit, a: *const Ability) f64 {
    const combined = engine.getLuck(u) + u.syn_power + ((a.power + artifacts.fireTerm(artifacts.madeOfFire(u), a.power)) / MAX_UNIT_STACK_POWER) * engine.getStackPower(u);
    return if (combined < 0) 0 else combined;
}

/// Unit.calculateAbilityCount (no Deep Wounds in scope).
pub fn abilityCount(u: *const Unit, a: *const Ability) f64 {
    if (a.power_type == PT.REDUCE_BASE_ATTACK_UPON_MELEE_ATTACK) return a.power;
    if (a.power_type != PT.GAIN_ATTACK_AND_ARMOR_EACH_STEP and a.power_type != PT.ADDITIONAL_STEPS and
        a.power_type != PT.STEAL_ARMOR_ON_HIT and a.id != .shatter_armor) return 0;
    const luck = engine.getLuck(u);
    const sp = engine.getStackPower(u);
    if (a.power_type != PT.GAIN_ATTACK_AND_ARMOR_EACH_STEP) {
        return (a.power / MAX_UNIT_STACK_POWER) * sp + luck / 10 + u.syn_power / 10 + artifacts.fireTerm(artifacts.madeOfFire(u), a.power) / 10;
    }
    return js.toFixed((a.power / MAX_UNIT_STACK_POWER) * sp + ((luck + artifacts.fireTerm(artifacts.madeOfFire(u), a.power) + u.syn_power) / 100) * a.power, 1);
}

/// Unit.canSkipResponse: an ability that is never answered (Shadow Touch, Lightning Spin), unless Broken.
pub fn skipsResponse(u: *const Unit) bool {
    if (u.ability_mask == 0 or u.isBroken()) return false;
    for (u.abilities[0..u.n_abilities]) |a| if (a.skip_response) return true;
    return false;
}

/// Unit.calculateMissChance(enemy): the striker's own Boar Saliva effect first, then the enemy's Dodge, and its Small
/// Specie against a level-4 attacker.
pub fn missChance(att: *const Unit, enemy: *const Unit) f64 {
    const saliva: ?f64 = if (att.effects.len != 0) att.effects.power(.boar_saliva) else null;
    if (saliva == null and enemy.ability_mask & (st.AbilityId.dodge.bit() | st.AbilityId.small_specie.bit()) == 0) return 0;
    var chances: [3]f64 = undefined;
    var n: usize = 0;
    if (saliva) |p| {
        chances[n] = p / 100;
        n += 1;
    }
    if (enemy.ability(.dodge)) |a| {
        chances[n] = applyChance(enemy, a) / 100;
        n += 1;
    }
    if (att.level == 4) {
        if (enemy.ability(.small_specie)) |a| {
            chances[n] = applyChance(enemy, a) / 100;
            n += 1;
        }
    }
    if (n == 0) return 0;
    // winningAtLeastOneEventProbability (src/utils/math.ts)
    var no_win: f64 = 1;
    for (chances[0..n]) |p| no_win = no_win * (1 - p);
    return @floor((1 - no_win) * 100);
}

// =====================================================================================================================
// Processors without a damage roll (src/abilities/*.ts)
// =====================================================================================================================

/// processRapidChargeAbility(attacker, chargeDistanceCells)
pub fn rapidCharge(u: *const Unit, cells: f64) f64 {
    const a = u.ability(.rapid_charge) orelse return 1;
    const m = abilityMultiplier(u, a);
    if (m < 1) return 1;
    return 1 + (m - 1) * cells;
}

/// getAbilitiesWithPosisionCoefficient + the caller's product: Backstab from `from` (the attacker's anchor) at a
/// victim anchored at `to`, `to_h` cells tall, on the classic (not side-oriented) board.
pub fn positionMultiplier(u: *const Unit, from: st.Cell, to: st.Cell, to_h: u8) f64 {
    return positionMultiplierOn(u, from, to, 1, to_h, false);
}

/// getAbilitiesWithPosisionCoefficient's Backstab, along the axis of advance: y on the classic board, x on the
/// side-oriented one (isSideOrientedPlacement), with the RIGHT attacker clearing the target's extent along that axis.
pub fn positionMultiplierOn(u: *const Unit, from: st.Cell, to: st.Cell, to_w: u8, to_h: u8, side: bool) f64 {
    var m: f64 = 1;
    const a = u.ability(.backstab) orelse return m;
    const along = if (side) from.x else from.y;
    const target_along = if (side) to.x else to.y;
    const extent: i32 = @max(1, if (side) to_w else to_h);
    if (u.team == st.Team.LEFT and along > target_along) m *= abilityMultiplier(u, a);
    if (u.team == st.Team.RIGHT and along < target_along - (extent - 1)) m *= abilityMultiplier(u, a);
    return m;
}

/// processPenetratingBiteAbility(from, to)
pub fn penetratingBite(from: *const Unit, to: *const Unit) f64 {
    const a = from.ability(.penetrating_bite) orelse return 0;
    return @floor((abilityMultiplier(from, a) - 1) * to.max_hp);
}

/// processShatterArmorAbility(from, target, currentActiveUnit): the effect's power accumulates.
pub fn shatterArmor(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const from = &s.units[from_i];
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const a = from.ability(.shatter_armor) orelse return;
    const existing = to.effects.power(.shatter_armor) orelse 0;
    const amplifier: f64 = if (a.ty == st.AbilityKind.STATUS and to.has(.mechanism)) 1.5 else 1;
    const power = js.toFixed(existing + abilityCount(from, a) * amplifier, 2);
    var laps = a.effect_laps;
    if (to_i == active_i and laps != st.LAPS_AURA and laps != st.NUMBER_OF_LAPS_TOTAL) laps += 1; // Effect.extend
    // Unit.applyEffect
    replaceChecked(s, &to.effects, .{ .id = .shatter_armor, .laps = laps, .power = power });
}

/// processDullingDefenseAblity(from, to): a permanent base-attack cut and its accumulating debuff.
pub fn dullingDefense(from: *const Unit, to: *Unit) void {
    if (to.isDead()) return;
    const a = from.ability(.dulling_defense) orelse return;
    const power = js.toFixed(a.power, 1);
    if (power <= 0) return;
    // Unit.reduceBaseAttack
    const old = to.init.base_attack;
    to.init.base_attack = @max(1, to.init.base_attack - power);
    const reduced = js.toFixed(old - to.init.base_attack, 1);
    if (reduced == 0) return;
    const existing = to.debuffs.power(.dulling_defense);
    const total = js.toFixed((existing orelse 0) + reduced, 1);
    if (existing != null) to.debuffs.delete(.dulling_defense);
    to.debuffs.push(.{ .id = .dulling_defense, .laps = st.NUMBER_OF_LAPS_TOTAL, .power = total });
}

// =====================================================================================================================
// Team blessings (UnitsHolder: captureBlessingCensus, reapplyTeamBlessing, src/abilities/stack_blessings.ts)
// =====================================================================================================================

const ARCANE_WARD_BLESSING_BIT: u32 = 2;
const WARDING_MANE_BLESSING_BIT: u32 = 4;
const SHARPENED_WEAPONS_BLESSING_BIT: u32 = 32;
const RALLYING_VOLLEY_BLESSING_BIT: u32 = 64;
const LUCK_BLESSING_BIT: u32 = 128;
const SYLVAN_FOCUS_BLESSING_BIT: u32 = 256;

inline fn blessingBit(id: st.SpellId) u32 {
    return switch (id) {
        .luck_blessing => LUCK_BLESSING_BIT,
        .sylvan_focus_blessing => SYLVAN_FOCUS_BLESSING_BIT,
        .sharpened_weapons_blessing => SHARPENED_WEAPONS_BLESSING_BIT,
        .arcane_ward_blessing => ARCANE_WARD_BLESSING_BIT,
        .warding_mane_blessing => WARDING_MANE_BLESSING_BIT,
        .rallying_volley_blessing => RALLYING_VOLLEY_BLESSING_BIT,
        else => 0,
    };
}

/// A `Map<TeamType, number>` of the strongest source per team.
const TeamPowers = struct {
    set: [3]bool = .{ false, false, false },
    v: [3]f64 = .{ 0, 0, 0 },

    fn any(self: *const TeamPowers) bool {
        return self.set[0] or self.set[1] or self.set[2];
    }
    fn anyPositive(self: *const TeamPowers) bool {
        for (self.set, self.v) |is_set, v| if (is_set and v > 0) return true;
        return false;
    }
};

const Census = struct {
    luck: TeamPowers = .{},
    sylvan: TeamPowers = .{},
    sharpened: TeamPowers = .{},
    arcane: TeamPowers = .{},
    mane: TeamPowers = .{},
    rally: TeamPowers = .{},
    /// Per unit index: the blessing bits it carries.
    carriers: [st.MAX_UNITS]u32 = undefined,
    carried: u32 = 0,
};

/// Unit.calculateStackBlessingPower (Luck Blessing, Sylvan Focus Blessing)
fn stackBlessingPower(u: *const Unit, a: *const Ability) f64 {
    const sp = @max(0, @min(MAX_UNIT_STACK_POWER, engine.getStackPower(u)));
    return js.toFixed((a.power * sp) / MAX_UNIT_STACK_POWER, 2);
}

/// Unit.calculateSharpenedWeaponsBlessingPower
fn sharpenedWeaponsPower(u: *const Unit, a: *const Ability) f64 {
    const fire: f64 = if (artifacts.madeOfFire(u)) |p| (a.power * p) / 100 else 0;
    return js.toFixed((a.power / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) + engine.getLuck(u) + u.syn_power + fire, 2);
}

inline fn onGrid(u: *const Unit) bool {
    return engine.cellWithinGrid(engine.baseCell(u));
}

/// Unit.calculateArcaneWardBlessingPower: Number((power + getLuck()).toFixed(2)).
fn arcaneWardPower(u: *const Unit, a: *const Ability) f64 {
    return js.toFixed(a.power + engine.getLuck(u), 2);
}

/// Unit.calculateWardingManeBlessingPower: toFixed((power / 5) * clamp(stack power, 0, 5) * max(0, 1 + luck / 100), 2).
fn wardingManePower(u: *const Unit, a: *const Ability) f64 {
    const sp = @max(0, @min(MAX_UNIT_STACK_POWER, engine.getStackPower(u)));
    const scaled = (a.power / MAX_UNIT_STACK_POWER) * sp;
    const luck_multiplier = @max(0, 1 + engine.getLuck(u) / 100);
    return js.toFixed(scaled * luck_multiplier, 2);
}

/// UnitsHolder.captureBlessingCensus (holder order; dead and off-board units are carriers, never sources).
fn captureCensus(s: *const State) Census {
    var c: Census = .{};
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        var carried: u32 = 0;
        for (u.buffs.items[0..u.buffs.len]) |b| carried |= blessingBit(b.id);
        c.carriers[i] = carried;
        c.carried |= carried;
        if (u.isDead() or !onGrid(u)) continue;
        const team = u.team;
        if (u.ability(.luck_blessing)) |a| {
            const power = stackBlessingPower(u, a);
            if (power > 0) {
                c.luck.v[team] = js.max(if (c.luck.set[team]) c.luck.v[team] else 0, power);
                c.luck.set[team] = true;
            }
        }
        if (u.ability(.sylvan_focus_blessing)) |a| {
            const power = stackBlessingPower(u, a);
            if (power > 0) {
                c.sylvan.v[team] = js.max(if (c.sylvan.set[team]) c.sylvan.v[team] else 0, power);
                c.sylvan.set[team] = true;
            }
        }
        if (u.ability(.sharpened_weapons_blessing)) |a| {
            const power = sharpenedWeaponsPower(u, a);
            c.sharpened.v[team] = js.max(if (c.sharpened.set[team]) c.sharpened.v[team] else -std.math.inf(f64), power);
            c.sharpened.set[team] = true;
        }
        if (u.ability(.arcane_ward_blessing)) |a| {
            c.arcane.v[team] = js.max(if (c.arcane.set[team]) c.arcane.v[team] else 0, arcaneWardPower(u, a));
            c.arcane.set[team] = true;
        }
        if (u.ability(.warding_mane_blessing)) |a| {
            c.mane.v[team] = js.max(if (c.mane.set[team]) c.mane.v[team] else 0, wardingManePower(u, a));
            c.mane.set[team] = true;
        }
        if (u.ability(.rallying_volley_blessing)) |a| {
            c.rally.v[team] = js.max(if (c.rally.set[team]) c.rally.v[team] else 0, a.power);
            c.rally.set[team] = true;
        }
    }
    return c;
}

/// canReceiveSharpenedWeapons (melee or magic attackers) and canReceiveRallyingVolley (isRangeCapable, or an active
/// Endless Quiver: a thief's refresh grants the row before its shot distance and mod exist).
const Eligible = enum { all, melee_or_magic, ranged };

/// Unit.tryGrantRallyingVolleyShots: applyBuff("Rallying Volley Blessing") adds the arrows once per unit (no ranked
/// authoritative shots in scope).
fn grantRallyingVolleyShots(u: *Unit, power: f64) void {
    if (!engine.isRangeCapable(u) and !u.has(.endless_quiver)) return;
    const bonus = @max(0, @floor(power));
    if (bonus > u.rallying_volley_granted) {
        u.range_shots += bonus - u.rallying_volley_granted;
        u.rallying_volley_granted = bonus;
    }
}

/// UnitsHolder.reapplyTeamBlessing: strip the blessing from its carriers, then grant every living on-board unit its
/// team's strongest power (laps NUMBER_OF_LAPS_TOTAL, never ticked down).
fn reapply(s: *State, c: *const Census, powers: *const TeamPowers, bit: u32, id: st.SpellId, eligible: Eligible, allow_non_positive: bool) void {
    const has_power = if (allow_non_positive) powers.any() else powers.anyPositive();
    if (c.carried & bit == 0 and !has_power) return;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (c.carriers[i] & bit != 0) u.buffs.delete(id);
        if (!powers.set[u.team]) continue;
        const power = powers.v[u.team];
        if ((!allow_non_positive and power <= 0) or u.isDead() or !onGrid(u)) continue;
        switch (eligible) {
            .all => {},
            .melee_or_magic => if (u.attack_type != AT.MELEE and u.attack_type != AT.MAGIC and u.attack_type != AT.MELEE_MAGIC) continue,
            .ranged => if (!engine.isRangeCapable(u) and !u.has(.endless_quiver)) continue,
        }
        if (id == .rallying_volley_blessing) grantRallyingVolleyShots(u, power);
        pushChecked(s, &u.buffs, .{ .id = id, .laps = st.NUMBER_OF_LAPS_TOTAL, .power = power });
    }
}

/// A push that flags the state when the list is full (TypeScript's lists are unbounded).
pub inline fn pushChecked(s: *State, list: anytype, a: st.AppliedSpell) void {
    if (list.len >= @TypeOf(list.*).capacity) {
        s.overflow = true;
        return;
    }
    list.push(a);
}

/// replace (delete by name, append) that flags the state when the list is full.
pub inline fn replaceChecked(s: *State, list: anytype, a: st.AppliedSpell) void {
    list.delete(a.id);
    pushChecked(s, list, a);
}

/// The blessing part of UnitsHolder.refreshStackPowerForAllUnits, after setUnitsCalculatedStacksPower and the aura
/// refresh. Luck Blessing is resolved first; while it is in play, the aura emitters and luck-dependent sources get an
/// early stat pass (rolling this lap's luck before the others), the auras are refreshed again with that luck, and
/// the census is taken again.
pub fn refreshBlessings(s: *State) void {
    var c = captureCensus(s);
    const refresh_luck = c.luck.anyPositive() or c.carried & LUCK_BLESSING_BIT != 0;
    if (refresh_luck) {
        reapply(s, &c, &c.luck, LUCK_BLESSING_BIT, .luck_blessing, .all, false);
        for (s.holderOrder()) |i| {
            const u = &s.units[i];
            // getAuraEffects() is empty while Broken; the luck-dependent names are read off props.abilities.
            if (u.isDead() or !onGrid(u) or (u.auraCount() == 0 and !u.luck_dependent)) continue;
            engine.adjustBaseStats(s, u);
        }
        if (s.auras) refreshAuras(s);
        c = captureCensus(s);
    }
    // The other STACK_BLESSINGS after Luck Blessing (Sylvan Focus; Tie up the Horses and Wolf Trail are not in scope).
    reapply(s, &c, &c.sylvan, SYLVAN_FOCUS_BLESSING_BIT, .sylvan_focus_blessing, .all, false);
    reapply(s, &c, &c.arcane, ARCANE_WARD_BLESSING_BIT, .arcane_ward_blessing, .all, false);
    reapply(s, &c, &c.mane, WARDING_MANE_BLESSING_BIT, .warding_mane_blessing, .all, false);
    reapply(s, &c, &c.sharpened, SHARPENED_WEAPONS_BLESSING_BIT, .sharpened_weapons_blessing, .melee_or_magic, true);
    reapply(s, &c, &c.rally, RALLYING_VOLLEY_BLESSING_BIT, .rallying_volley_blessing, .ranged, false);
}

// =====================================================================================================================
// Auras (UnitsHolder.refreshAuraEffectsForAllUnits, Unit.calculateAuraPower / cleanAuraEffects / applyAuraEffect)
// =====================================================================================================================

/// Unit.calculateAuraPower(auraEffect, the emitter's team ability power), for the power types the loader accepts.
pub fn auraPower(u: *const Unit, def: *const st.AuraDef) f64 {
    return switch (def.power_type) {
        PT.ADDITIONAL_BASE_ATTACK_AND_ARMOR, PT.POISON_ON_HIT, PT.DISABLE_FLY_MOVEMENT, PT.DISABLE_RANGE_ATTACK, PT.UNTARGETABLE => def.power,
        PT.ABSORB_DEBUFF => blk: {
            var coeff: f64 = 1;
            coeff += (def.power / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) + (engine.getLuck(u) + u.syn_power) / 100 +
                artifacts.fireTerm(artifacts.madeOfFire(u), def.power) / 100;
            break :blk js.toFixed(coeff * 100, 2) - 100;
        },
        else => unreachable, // refused at load
    };
}

/// hasAuraEffect(name): the unit's aura list holds that def (not Break-aware).
inline fn holdsAura(u: *const Unit, def: u8) bool {
    for (u.auras[0..u.n_auras]) |d| if (d == def) return true;
    return false;
}

/// Unit.cleanAuraEffects: every row whose laps are MAX_SAFE_INTEGER goes, with every other row of its name
/// (deleteBuff / deleteDebuff remove by name); the rest keep their order.
fn cleanAuraRows(list: anytype) void {
    var i: usize = list.len;
    while (i > 0) {
        i -= 1;
        if (i < list.len and list.items[i].laps == st.LAPS_AURA) list.delete(list.items[i].id);
    }
}

/// Unit.getAppliedAuraEffect(name)?.getPower(): the last row of that name with aura laps.
pub fn appliedAuraPower(u: *const Unit, id: st.SpellId) ?f64 {
    var i: usize = u.buffs.len;
    while (i > 0) {
        i -= 1;
        const b = u.buffs.items[i];
        if (b.id == id and b.laps == st.LAPS_AURA) return b.power;
    }
    return null;
}

const MAX_EMITTERS = st.MAX_UNITS * st.MAX_UNIT_AURAS;

/// One emitted aura of this refresh (an AppliedAuraEffectProperties source): the emitter, its aura, the power
/// computed once per refresh, the side it lands on, the emitter's base cell (the recorded source cell) and the
/// range with the team's Might aura-range synergy.
const Emission = struct { unit: u8, def: u8, power: f64, team: u8, src: st.Cell, range: f64 };

/// A (name -> strongest emission) list in first-seen order: a cell's list, then the receiver's strongestAuraPerName.
const AuraRows = struct {
    def: [st.MAX_AURA_DEFS]u8 = undefined,
    em: [st.MAX_AURA_DEFS]u8 = undefined,
    len: u8 = 0,

    /// Insert, or replace in place when strictly stronger (Map.set on an existing key keeps its position).
    fn offer(self: *AuraRows, ems: []const Emission, ei: u8) void {
        const e = ems[ei];
        for (self.def[0..self.len], 0..) |d, k| {
            if (d == e.def) {
                if (e.power > ems[self.em[k]].power) self.em[k] = ei;
                return;
            }
        }
        self.def[self.len] = e.def;
        self.em[self.len] = ei;
        self.len += 1;
    }
};

/// The emitter's coverage (getAuraCellKeyBuffer over each body cell): a Chebyshev ball of `range` around any body
/// cell, clipped to the board; `c` is on the board.
fn covers(body: []const st.Cell, c: st.Cell, range: f64) bool {
    for (body) |b| {
        const d: f64 = @floatFromInt(@max(@abs(b.x - c.x), @abs(b.y - c.y)));
        if (d <= range) return true;
    }
    return false;
}

/// UnitsHolder.refreshAuraEffectsForAllUnits. Pass 1 cleans every holder unit's aura rows and computes each
/// emitter's power (with its current stack power and luck); pass 2 gives every holder unit (dead ones included) the
/// strongest emission per aura name over its cells. Per cell, emissions arrive in holder order and replace an entry
/// only when strictly stronger; per receiver, cells are read in getCells order with the same rule. The full refresh
/// is idempotent, so it stands in for TypeScript's fingerprint and known-empty fast paths at every call site.
pub fn refreshAuras(s: *State) void {
    var ems: [MAX_EMITTERS]Emission = undefined;
    var n_ems: u8 = 0;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        // isFootprintWithinGrid: NORMAL bodies never leave the board.
        cleanAuraRows(&u.buffs);
        cleanAuraRows(&u.debuffs);
        for (u.auras[0..u.auraCount()]) |d| {
            const def = &s.aura_defs[d];
            const power = if (def.power != 0) auraPower(u, def) else def.power;
            const range = def.range + s.setup[u.team].aura_range;
            if (range < 0) continue;
            const team = if (def.is_buff) u.team else engine.opposite(u.team);
            if (team != st.Team.LEFT and team != st.Team.RIGHT) continue;
            ems[n_ems] = .{ .unit = @intCast(i), .def = d, .power = power, .team = team, .src = engine.baseCell(u), .range = range };
            n_ems += 1;
        }
    }
    if (n_ems == 0) return;
    var bodies: [st.MAX_UNITS]engine.Cells = undefined;
    for (ems[0..n_ems]) |e| bodies[e.unit] = engine.unitCells(&s.units[e.unit]);
    for (s.holderOrder()) |ri| {
        const u = &s.units[ri];
        var rows: AuraRows = .{};
        const cells = engine.unitCells(u);
        for (cells.slice()) |c| {
            if (!engine.cellWithinGrid(c)) continue; // no emission stamps an off-board key
            var cell_rows: AuraRows = .{};
            for (ems[0..n_ems], 0..) |e, ei| {
                if (e.team != u.team) continue;
                if (!covers(bodies[e.unit].slice(), c, e.range)) continue;
                cell_rows.offer(ems[0..n_ems], @intCast(ei));
            }
            for (cell_rows.em[0..cell_rows.len]) |ei| rows.offer(ems[0..n_ems], ei);
        }
        // applyAuraEffectToUnit -> canApplyAuraEffect (the Web lands on flyers only, the Range Null Field on RANGE
        // creatures, Disguise on units that hold the aura and an active Disguise Aura; true for the other power types
        // in scope) -> applyAuraEffect (a buff row, or a debuff row for an is_buff false aura)
        for (rows.em[0..rows.len]) |ei| {
            const e = ems[ei];
            const def = &s.aura_defs[e.def];
            if (def.power_type == PT.DISABLE_FLY_MOVEMENT and !engine.canFly(u)) continue;
            if (def.power_type == PT.DISABLE_RANGE_ATTACK and u.attack_type != AT.RANGE) continue;
            if (def.power_type == PT.UNTARGETABLE and !(holdsAura(u, e.def) and u.has(.disguise_aura))) continue;
            const row = st.AppliedSpell{
                .id = def.buff,
                .laps = st.LAPS_AURA,
                .power = js.toFixed(e.power, 1),
                .src_x = @intCast(e.src.x),
                .src_y = @intCast(e.src.y),
            };
            if (def.is_buff) replaceChecked(s, &u.buffs, row) else replaceChecked(s, &u.debuffs, row);
        }
    }
}

// =====================================================================================================================
// On-hit riders and other batch-2 processors (src/abilities/*.ts)
// =====================================================================================================================

/// applyPoisonEffect (poison_ability.ts): a new hit stacks onto the active poison.
fn applyPoison(s: *State, tgt: *Unit, poison_hp: f64) void {
    if (tgt.isDead() or poison_hp <= 0 or tgt.has(.mechanism)) return; // canBePoisoned; no Holy Cross
    const active = tgt.effects.power(.poison) orelse 0;
    const stacked = if (active != 0) @max(poison_hp, active + @max(1, js.round(poison_hp * 0.5))) else poison_hp;
    if (stacked <= active) return;
    replaceChecked(s, &tgt.effects, .{ .id = .poison, .laps = s.poison_laps, .power = stacked });
}

/// processPoisonAuraAbility(attacker, target, damageDealt): a hit by a unit under Venom Cloud poisons its victim.
pub fn poisonAura(s: *State, att_i: u8, tgt_i: u8, damage: f64) void {
    if (!s.auras or damage <= 0) return; // the buff exists only through the aura refresh
    const tgt = &s.units[tgt_i];
    if (tgt.isDead()) return;
    const att = &s.units[att_i];
    const base = att.buffs.power(.venom_cloud_aura) orelse return; // POISON_ON_HIT_AURA_BUFF_NAMES
    const percent = @max(0, base + engine.getLuck(att));
    const poison_hp = @floor((damage * percent) / 100);
    if (poison_hp <= 0) return;
    applyPoison(s, tgt, poison_hp);
}

inline fn extendLaps(laps: f64) f64 {
    return if (laps == st.LAPS_AURA or laps == st.NUMBER_OF_LAPS_TOTAL) laps else laps + 1; // Effect.extend
}

/// processAggrAbility(from, target, currentActiveUnit): the roll is drawn even when the target already has Aggr.
pub fn aggr(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const a = from.ability(.aggr) orelse return;
    // MIND: 1 - getMindResist() / 100 (the target's Amulet of Resolve).
    if (!(@as(f64, @floatFromInt(s.rng.int(0, 100))) < applyChance(from, a) * artifacts.mindCoeff(s, a.ty, to))) return;
    if (to.effects.find(.aggr) != null) return;
    const laps = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    // Aggr is a MIND effect: hasMindAttackResistance (Madness or Mechanism) resists it after the roll.
    if (a.ty == st.AbilityKind.MIND and mindResistant(to)) return;
    replaceChecked(s, &to.effects, .{ .id = .aggr, .laps = laps, .power = a.effect_power });
    to.target = @intCast(from_i);
}

/// processStunAbility(from, target, currentActiveUnit): calculateStunApplyChance (x1.5 for the STATUS card on a
/// Mechanism target; x (1 - status resist / 100), Amulet of Resolve's) clamped to [0, 100]; the roll is drawn even when the target is already
/// stunned (then nothing changes). The stun lasts a lap longer on the active unit. `from` may be dead (its blow still
/// lands).
pub fn stun(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const a = from.ability(.stun) orelse return;
    const amplifier: f64 = if (a.ty == st.AbilityKind.STATUS and to.has(.mechanism)) 1.5 else 1;
    const chance = @max(0, @min(100, applyChance(from, a) * amplifier * (1 - artifacts.statusResist(s, to) / 100)));
    if (!(@as(f64, @floatFromInt(s.rng.int(0, 100))) < chance)) return; // stun_ability.ts:58
    if (to.isStunned()) return;
    const laps: f64 = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    replaceChecked(s, &to.effects, .{ .id = .stun, .laps = laps, .power = a.effect_power });
}

/// processDeepWoundsAbility(from, target, currentActiveUnit): the holder's active cards (Level 0 to 3, in that order,
/// Break-aware) sum (power / 5) * stack power, then luck and the team's ability power once, floored at 0 and toFixed(1);
/// a positive sum is added to the target's "Deep Wounds" row (delete + append, toFixed(1)), laps 3 or 4 on the active
/// unit. A killing hit wounds nobody. No roll.
pub fn deepWounds(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    if (from.ability_mask & st.AbilityId.DEEP_WOUNDS_MASK == 0) return;
    var stacked: f64 = 0;
    var laps: f64 = 0;
    var held = false;
    inline for (st.AbilityId.DEEP_WOUNDS) |id| {
        if (from.ability(id)) |a| {
            stacked += (a.power / MAX_UNIT_STACK_POWER) * engine.getStackPower(from) + artifacts.fireTerm(artifacts.madeOfFire(from), a.power);
            if (!held) laps = a.effect_laps;
            held = true;
        }
    }
    if (!held) return;
    const sum = js.toFixed(@max(0, stacked + engine.getLuck(from) + from.syn_power), 1);
    if (sum == 0) return;
    const total = js.toFixed((to.effects.power(.deep_wounds) orelse 0) + sum, 1);
    replaceChecked(s, &to.effects, .{ .id = .deep_wounds, .laps = if (to_i == active_i) extendLaps(laps) else laps, .power = total });
}

/// hasAnyDeepWoundsAbility / calculateActiveDeepWoundsEffect's holder test: any of the four cards, Break-aware.
pub inline fn holdsDeepWounds(u: *const Unit) bool {
    if (u.ability_mask & st.AbilityId.DEEP_WOUNDS_MASK == 0 or u.isBroken()) return false;
    return true;
}

/// calculateActiveDeepWoundsEffect(attacker, target): the target's row power when the attacker holds a card, else 0.
pub inline fn activeDeepWounds(att: *const Unit, tgt: *const Unit) f64 {
    if (tgt.effects.len == 0) return 0;
    const p = tgt.effects.power(.deep_wounds) orelse return 0;
    if (p == 0 or !holdsDeepWounds(att)) return 0;
    return p;
}

/// processBoarSalivaAbility(from, target, currentActiveUnit): an un-Saliva'd living target gets the effect, power
/// toFixed(1 * ((max(1 if < 0, 30 + luck + syn) / 100 / 5) * stack power) * 100, 2) of the holder, laps 3 (4 on the
/// active unit), unless Madness resists it (after the power is set). No roll in scope (the mind-resist save needs an
/// artifact).
pub fn boarSaliva(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const a = from.ability(.boar_saliva) orelse return;
    // The target's MIND resist (Amulet of Resolve) gives it a save, drawn before the already-salivated check.
    const mind = artifacts.mindCoeff(s, a.ty, to);
    if (mind < 1 and @as(f64, @floatFromInt(s.rng.int(0, 100))) >= mind * 100) return;
    if (to.effects.find(.boar_saliva) != null) return;
    var combined = @as(f64, a.effect_power) + engine.getLuck(from) + from.syn_power;
    if (combined < 0) combined = 1;
    var coeff: f64 = 1;
    coeff *= (combined / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(from);
    const power = js.toFixed(coeff * 100, 2);
    const laps = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    if (a.ty == st.AbilityKind.MIND and mindResistant(to)) return; // hasMindAttackResistance
    replaceChecked(s, &to.effects, .{ .id = .boar_saliva, .laps = laps, .power = power });
}

/// processTerrifyingGazeAbility(from, target, currentActiveUnit): the roll getRandomInt(0, 100) < applyChance (drawn on
/// a frightened or Madness target too); a frightened target is re-pointed at this gazer (its laps unchanged), Madness
/// resists, else the effect (laps 1, extended on the active unit) and the forbidden gazer's uid.
pub fn terrifyingGaze(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const a = from.ability(.terrifying_gaze) orelse return;
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= applyChance(from, a) * artifacts.mindCoeff(s, a.ty, to)) return; // terrifying_gaze_ability.ts:45
    if (to.effects.find(.terrifying_gaze) != null) {
        to.forbidden = from.uid;
        return;
    }
    const laps = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    if (a.ty == st.AbilityKind.MIND and mindResistant(to)) return;
    replaceChecked(s, &to.effects, .{ .id = .terrifying_gaze, .laps = laps, .power = a.effect_power });
    to.forbidden = from.uid;
}

/// processMinerAbility(attacker, target): Number(calculateAbilityCount(...).toFixed(2)) base armor moves from the
/// target's INITIAL base armor (floored at 1) to the attacker's; the live values follow at the next stat refresh. The
/// target's "Miner" debuff (laps 15) holds the running total. No roll.
pub fn miner(s: *State, from_i: u8, to_i: u8) void {
    const from = &s.units[from_i];
    const a = from.ability(.miner) orelse return;
    const to = &s.units[to_i];
    if (from.isDead() or to.isDead()) return;
    const amount = js.toFixed(abilityCount(from, a), 2);
    // Unit.decreaseBaseArmor
    if (amount <= 0) return;
    const old = to.init.base_armor;
    to.init.base_armor = @max(1, js.toFixed(old - amount, 2));
    const mined = js.toFixed(old - to.init.base_armor, 2);
    if (mined <= 0) return;
    from.init.base_armor = js.toFixed(from.init.base_armor + mined, 2); // Unit.increaseBaseArmor
    const total = js.toFixed((to.debuffs.power(.miner) orelse 0) + mined, 2);
    replaceChecked(s, &to.debuffs, .{ .id = .miner, .laps = st.NUMBER_OF_LAPS_TOTAL, .power = total });
}

/// processPredatoryAssimilationPoison(attacker, target, damageDealt): Predatory Assimilation's own poison rider, on a
/// landed blow or response (25% of the rolled damage, plus the attacker's luck). No roll.
pub fn assimilationPoison(s: *State, att_i: u8, tgt_i: u8, damage: f64) void {
    if (damage <= 0) return;
    const tgt = &s.units[tgt_i];
    if (tgt.isDead()) return;
    const att = &s.units[att_i];
    if (!att.has(.predatory_assimilation)) return;
    const percent = @max(0, 25 + engine.getLuck(att)); // PREDATORY_ASSIMILATION_POISON_PERCENT
    const poison_hp = @floor((damage * percent) / 100);
    if (poison_hp <= 0) return;
    applyPoison(s, tgt, poison_hp);
}

/// LUCK_DEPENDENT_BLESSINGS (units_holder.ts) among the ported abilities: the early luck pass reads card names.
pub inline fn isLuckDependentCard(id: st.AbilityId) bool {
    return id == .sharpened_weapons_blessing or id == .arcane_ward_blessing or id == .warding_mane_blessing;
}

/// Unit.removeAbilityMechanics for an ability leaving the active list: its aura effect goes unless another active
/// ability still provides it, and a castable ability's own spell entries go (then the book is re-parsed).
fn removeAbilityMechanics(s: *State, u: *Unit, gone: *const Ability) void {
    if (gone.id.castable()) |spell| {
        removeDirectEntries(u, spell);
        if (!engine.parseBook(u)) s.overflow = true;
    }
    if (gone.aura == st.NO_AURA) return;
    for (u.abilities[0..u.n_abilities]) |*a| if (a.aura == gone.aura) return;
    var k: usize = 0;
    while (k < u.n_auras) {
        if (u.auras[k] == gone.aura) {
            var j = k;
            while (j + 1 < u.n_auras) : (j += 1) u.auras[j] = u.auras[j + 1];
            u.n_auras -= 1;
        } else k += 1;
    }
}

/// isDirectAbilitySpellEntry: ":X" or "System:X".
inline fn isDirectEntry(e: st.BookEntry, spell: st.CastSpell) bool {
    return e.spell == @intFromEnum(spell) and e.normalized() == st.BookEntry.NO_FACTION;
}

fn removeDirectEntries(u: *Unit, spell: st.CastSpell) void {
    var w: usize = 0;
    for (u.book[0..u.n_book]) |e| {
        if (isDirectEntry(e, spell)) continue;
        u.book[w] = e;
        w += 1;
    }
    u.n_book = @intCast(w);
}

/// The spell charges a card owns (isSpellOwnedBySpellbook for a SPELLBOOK card: a faction entry of one of its spells;
/// isDirectAbilitySpellEntry for a castable ability).
fn ownsEntry(id: st.AbilityId, e: st.BookEntry) bool {
    if (id.isSpellbook()) return e.prefix != st.BookEntry.NO_FACTION and e.spell != st.NO_SPELL and id.ownsSpell(@enumFromInt(e.spell));
    if (id.castable()) |spell| return isDirectEntry(e, spell);
    return false;
}

const Entries = struct {
    items: [st.MAX_BOOK]st.BookEntry = undefined,
    len: u8 = 0,
};

/// Unit.takeAbilitySpellEntries: the card's remaining charges leave the unit (re-parsing its book when any did), as
/// the thief will hold them (a castable ability's as ":X").
fn takeAbilitySpellEntries(s: *State, u: *Unit, id: st.AbilityId, out: *Entries) void {
    out.len = 0;
    if (u.n_book == 0 or u.activeAbility(id) == null) return;
    var w: usize = 0;
    for (u.book[0..u.n_book]) |e| {
        if (ownsEntry(id, e)) {
            out.items[out.len] = if (id.isSpellbook()) e else .{ .spell = e.spell, .prefix = st.BookEntry.NO_FACTION };
            out.len += 1;
        } else {
            u.book[w] = e;
            w += 1;
        }
    }
    if (out.len == 0) return;
    u.n_book = @intCast(w);
    if (!engine.parseBook(u)) s.overflow = true;
}

/// Unit.disableAbilityAsStolen: the name joins props.stolen_abilities, the ability leaves the active list (the card
/// stays), then removeAbilityMechanics. Returns the ability as it was.
fn disableAsStolen(s: *State, u: *Unit, id: st.AbilityId) ?Ability {
    var idx: ?usize = null;
    for (u.abilities[0..u.n_abilities], 0..) |a, k| {
        if (a.id == id) idx = k;
    }
    const k = idx orelse return null;
    const ability = u.abilities[k];
    var listed = false;
    for (u.stolen[0..u.n_stolen]) |x| {
        if (x == id) listed = true;
    }
    if (!listed) {
        if (u.n_stolen < st.MAX_STOLEN) {
            u.stolen[u.n_stolen] = id;
            u.n_stolen += 1;
        } else s.overflow = true;
    }
    var j = k;
    while (j + 1 < u.n_abilities) : (j += 1) u.abilities[j] = u.abilities[j + 1];
    u.n_abilities -= 1;
    u.ability_mask &= ~id.bit();
    removeAbilityMechanics(s, u, &ability);
    return ability;
}

/// Unit.grantStolenAbility -> grantAbility(name, {restoreStolen: true}): a no-op if the thief already has it; the
/// name leaves the thief's own stolen list; a fresh copy of the configured ability (Ability records hold config values
/// only) is appended, and its aura effect if the thief does not emit it yet. registerAbility's card data feeds the
/// early luck pass (`luck_dependent`).
fn grantStolen(s: *State, u: *Unit, a: Ability, entries: *const Entries) void {
    if (u.activeAbility(a.id) != null) return;
    defer grantSpellEntries(s, u, a.id, entries);
    var k: usize = 0;
    while (k < u.n_stolen) {
        if (u.stolen[k] == a.id) {
            var j = k;
            while (j + 1 < u.n_stolen) : (j += 1) u.stolen[j] = u.stolen[j + 1];
            u.n_stolen -= 1;
        } else k += 1;
    }
    if (u.n_abilities >= st.MAX_ABILITIES) {
        s.overflow = true;
        return;
    }
    u.abilities[u.n_abilities] = a;
    u.n_abilities += 1;
    u.ability_mask |= a.id.bit();
    if (isLuckDependentCard(a.id)) u.luck_dependent = true;
    if (a.aura != st.NO_AURA) {
        for (u.auras[0..u.n_auras]) |x| if (x == a.aura) return;
        if (u.n_auras >= st.MAX_UNIT_AURAS) {
            s.overflow = true;
            return;
        }
        u.auras[u.n_auras] = a.aura;
        u.n_auras += 1;
    }
}

/// grantAbility's spell part for a stolen card: registerAbility re-parses the thief's book for a castable ability (no
/// default charge), then the moved charges are appended and the book parsed again.
fn grantSpellEntries(s: *State, u: *Unit, id: st.AbilityId, entries: *const Entries) void {
    if (id.castable() != null and !engine.parseBook(u)) s.overflow = true;
    if (entries.len == 0) return;
    for (entries.items[0..entries.len]) |e| {
        if (u.n_book >= st.MAX_BOOK) {
            s.overflow = true;
            break;
        }
        u.book[u.n_book] = e;
        u.n_book += 1;
    }
    if (!engine.parseBook(u)) s.overflow = true;
}

/// processPredatoryAssimilationAbility(thief, target): the candidates are the target's active abilities (none while
/// it is Broken; a dead target keeps them) other than Predatory Assimilation and the ones the thief already has. The
/// chance roll is drawn only when a candidate exists, the pick indexes the active list order (no draw for one).
pub fn assimilate(s: *State, thief_i: u8, target_i: u8) void {
    const thief = &s.units[thief_i];
    const pa = thief.ability(.predatory_assimilation) orelse return;
    const target = &s.units[target_i];
    var candidates: [st.MAX_ABILITIES]st.AbilityId = undefined;
    var n: usize = 0;
    if (!target.isBroken()) {
        for (target.abilities[0..target.n_abilities]) |a| {
            if (a.id == .predatory_assimilation or thief.has(a.id)) continue;
            candidates[n] = a.id;
            n += 1;
        }
    }
    const chance = applyChance(thief, pa);
    if (n == 0) return;
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= chance) return; // predatory_assimilation_ability.ts:51
    const picked = candidates[@intCast(s.rng.int(0, @intCast(n)))]; // :55
    // The card's remaining charges are captured before it is disabled (takeAbilitySpellEntries).
    var entries: Entries = .{};
    takeAbilitySpellEntries(s, target, picked, &entries);
    const ability = disableAsStolen(s, target, picked) orelse return;
    grantStolen(s, thief, ability, &entries);
}

/// Unit.deleteAbility for a giftable card leaving its caster: the active ability (if it is in the list), the stolen mark
/// and removeAbilityMechanics (its aura, its castable spell's direct entries and a re-parse). Returns the ability as it
/// was, or null when the unit does not hold it.
pub fn deleteAbility(s: *State, u: *Unit, id: st.AbilityId) ?Ability {
    var idx: ?usize = null;
    for (u.abilities[0..u.n_abilities], 0..) |a, k| {
        if (a.id == id) idx = k;
    }
    var k: usize = 0;
    while (k < u.n_stolen) {
        if (u.stolen[k] == id) {
            var j = k;
            while (j + 1 < u.n_stolen) : (j += 1) u.stolen[j] = u.stolen[j + 1];
            u.n_stolen -= 1;
        } else k += 1;
    }
    const i = idx orelse return null;
    const ability = u.abilities[i];
    var j = i;
    while (j + 1 < u.n_abilities) : (j += 1) u.abilities[j] = u.abilities[j + 1];
    u.n_abilities -= 1;
    u.ability_mask &= ~id.bit();
    removeAbilityMechanics(s, u, &ability);
    return ability;
}

/// Unit.addAbility (a gift): nothing when the unit already has it active or lost the card to Predatory Assimilation;
/// else registerAbility: the ability appended, its aura, and for a castable card one ":X" entry unless a direct entry
/// exists, then a re-parse. Returns whether the ability arrived.
pub fn addAbility(s: *State, u: *Unit, a: Ability) bool {
    if (u.activeAbility(a.id) != null) return false;
    for (u.stolen[0..u.n_stolen]) |x| if (x == a.id) return false;
    if (u.n_abilities >= st.MAX_ABILITIES) {
        s.overflow = true;
        return false;
    }
    u.abilities[u.n_abilities] = a;
    u.n_abilities += 1;
    u.ability_mask |= a.id.bit();
    if (isLuckDependentCard(a.id)) u.luck_dependent = true;
    if (a.aura != st.NO_AURA) {
        var present = false;
        for (u.auras[0..u.n_auras]) |x| if (x == a.aura) {
            present = true;
        };
        if (!present) {
            if (u.n_auras >= st.MAX_UNIT_AURAS) {
                s.overflow = true;
            } else {
                u.auras[u.n_auras] = a.aura;
                u.n_auras += 1;
            }
        }
    }
    if (a.id.castable()) |spell| {
        var direct = false;
        for (u.book[0..u.n_book]) |e| if (isDirectEntry(e, spell)) {
            direct = true;
        };
        if (!direct) {
            if (u.n_book >= st.MAX_BOOK) {
                s.overflow = true;
            } else {
                u.book[u.n_book] = .{ .spell = @intFromEnum(spell), .prefix = st.BookEntry.NO_FACTION };
                u.n_book += 1;
            }
        }
        if (!engine.parseBook(u)) s.overflow = true;
    }
    return true;
}

/// isEquipmentOrMarkerSpellName for the names in scope: augments, Morale/Dismorale and the army blessings (the stack
/// blessings included).
pub fn isMarkerSpell(id: st.SpellId) bool {
    return id.isAugment() or id.isArtifact() or switch (id) {
        .morale, .dismorale, .luck_blessing, .sylvan_focus_blessing, .sharpened_weapons_blessing, .arcane_ward_blessing, .rallying_volley_blessing, .ember_covenant_blessing, .hidden, .visible, .warding_mane_blessing => true,
        else => false,
    };
}

/// processBorrowedGraceAbility(thief, target, currentActiveUnit) on a landed shot or counter-shot: when the target
/// carries a takeable buff (laps > 0, not an aura row, not a marker: a cast Blessing in scope), the chance roll
/// getRandomInt(0, 10_000) / 100 < borrowedGraceChance, then the pick (no draw for one candidate), then takeBuffFrom:
/// the thief's copy (power, stored properties, laps left, +1 when the thief is the active unit without Morale and the
/// laps are in (0, 15)) replaces any row of that name at the end of its buffs; the target keeps the original.
pub fn borrowedGrace(s: *State, thief_i: u8, target_i: u8, active_i: u8) void {
    const thief = &s.units[thief_i];
    const target = &s.units[target_i];
    if (thief.isDead() or target.isDead()) return;
    const a = thief.ability(.borrowed_grace) orelse return;
    var candidates: [st.MAX_SPELLS]u8 = undefined;
    var n: usize = 0;
    for (target.buffs.items[0..target.buffs.len], 0..) |b, i| {
        if (b.laps <= 0 or b.laps == st.LAPS_AURA or isMarkerSpell(b.id)) continue;
        candidates[n] = @intCast(i);
        n += 1;
    }
    if (n == 0) return;
    // borrowedGraceChance: the thief's Made of Fire power raises the base chance.
    const sp = @max(1, @min(MAX_UNIT_STACK_POWER, engine.getStackPower(thief)));
    const per_stack = (a.power - 20) / (MAX_UNIT_STACK_POWER - 1);
    const base = 20 + per_stack * (sp - 1);
    const fire = artifacts.madeOfFire(thief) orelse 0;
    const chance = js.toFixed(@max(0, @min(100, base * (1 + fire / 100) + engine.getLuck(thief) + thief.syn_power)), 2);
    if (@as(f64, @floatFromInt(s.rng.int(0, 10_000))) / 100 >= chance) return; // borrowed_grace_ability.ts:110
    const pick = candidates[@intCast(s.rng.int(0, @intCast(n)))];
    const id = target.buffs.items[pick].id;
    const applied = target.buffs.get(id).?.*; // takeBuffFrom reads the first row of the name
    var laps = applied.laps;
    if (thief_i == active_i and !engine.hasMoraleBuff(thief) and laps > 0 and laps < st.NUMBER_OF_LAPS_TOTAL) laps += 1;
    var copy = applied;
    copy.laps = laps;
    thief.buffs.delete(id);
    pushChecked(s, &thief.buffs, copy);
}

/// processAbsolvingArrowAbility's lifts on one ally: every effect with laps > 0, then every debuff with laps > 0
/// that is neither an aura row nor a marker (listed before any deletion); the i-th entry is lifted when
/// getRandomInt(0, 100) < first / 2^i (2 raw per entry, lifted or not), deleting that name from both lists.
pub fn absolveAlly(s: *State, ally: *Unit, first: f64) void {
    var names: [st.MAX_EFFECTS + st.MAX_DEBUFFS]st.SpellId = undefined;
    var n: usize = 0;
    for (ally.effects.items[0..ally.effects.len]) |e| {
        if (e.laps > 0) {
            names[n] = e.id;
            n += 1;
        }
    }
    for (ally.debuffs.items[0..ally.debuffs.len]) |d| {
        if (d.laps > 0 and d.laps != st.LAPS_AURA and !isMarkerSpell(d.id)) {
            names[n] = d.id;
            n += 1;
        }
    }
    var div: f64 = 1;
    for (names[0..n]) |id| {
        const roll: f64 = @floatFromInt(s.rng.int(0, 100)); // absolving_arrow_ability.ts:132
        const chance = first / div;
        div *= 2;
        if (roll >= chance) continue;
        ally.effects.delete(id);
        ally.debuffs.delete(id);
    }
}

/// processPegasusLightAbility(from, target, currentActiveUnit): power = the effect's 10 + the Pegasus's luck.
pub fn pegasusLight(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const a = from.ability(.pegasus_light) orelse return;
    if (to.effects.find(.pegasus_light) != null) return;
    // calculateEffectMultiplier: Pegasus Light returns the combined power, flat
    var power = a.effect_power + engine.getLuck(from) + from.syn_power;
    if (power < 0) power = 1;
    const laps = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    replaceChecked(s, &to.effects, .{ .id = .pegasus_light, .laps = laps, .power = power });
}

/// The morale an attack on `u` pays while it carries Pegasus Light (`getEffect("Pegasus Light")?.getPower()`).
pub inline fn pegasusLightMorale(u: *const Unit) f64 {
    if (u.effects.len == 0) return 0;
    return u.effects.power(.pegasus_light) orelse 0;
}

/// processDevourEssenceAbility(fromUnit, unitIdsDied): a kill of an enemy stack heals the front creature.
pub fn devourEssence(s: *State, ui: u8, died: []const u8) void {
    const u = &s.units[ui];
    if (u.isDead()) return;
    const a = u.ability(.devour_essence) orelse return;
    if (a.power == 0) return;
    var killed = false;
    for (died) |d| {
        const x = &s.units[d];
        if (x.in_holder and x.team == engine.opposite(u.team)) {
            killed = true; // canSelfResurrect: no Angel in scope
            break;
        }
    }
    if (!killed) return;
    const power = js.toFixed(applyChance(u, a), 2);
    if (power <= 0) return;
    const up_to = @ceil(u.max_hp * @min(1, power / 100));
    if (up_to > u.hp) {
        // Unit.applyHeal: a Mechanism cannot be healed.
        if (u.has(.mechanism)) return;
        const heal = up_to - u.hp;
        if (heal < 0) return;
        u.hp += @floor(heal);
        if (u.hp > u.max_hp) u.hp = u.max_hp;
    }
}

/// hasMindAttackResistance: an active Madness or Mechanism.
pub inline fn mindResistant(u: *const Unit) bool {
    return engine.moraleLocked(u);
}

/// EffectHelper.getAbsorptionTarget: when the target carries an Absorb Penalties Aura row and a unit stands on its source
/// cell, the roll getRandomInt(0, 100) < floor(power), and a living source takes the penalty. Returns the unit that
/// receives it.
fn absorptionTarget(s: *State, tgt_i: u8) u8 {
    if (!s.auras) return tgt_i; // the buff exists only through the aura refresh
    const tgt = &s.units[tgt_i];
    const b = tgt.buffs.get(.absorb_penalties_aura) orelse return tgt_i;
    if (b.src_x < 0 or b.src_y < 0) return tgt_i;
    const c = st.Cell{ .x = b.src_x, .y = b.src_y };
    if (!engine.cellWithinGrid(c)) return tgt_i;
    const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
    if (!st.isUnitCode(o)) return tgt_i;
    const roll: f64 = @floatFromInt(s.rng.int(0, 100)); // effect_helper.ts:370
    const src = o - 1;
    if (roll < @floor(b.power) and !s.units[src].isDead()) return src;
    return tgt_i;
}

/// processSpitBallAbility(from, target, currentActiveUnit) on a landed shot, counter-shot or splash victim: the Absorb
/// Penalties redirect, then (a living receiver, a shooter with an active Spit Ball) per candidate debuff in table order
/// (Rangebane only for an attack_type RANGE receiver, none it already carries) the chance roll, after a pass the
/// magic-resist save (always drawn; a MIND name is then resisted by Madness or Mechanism), and after a landing the
/// receiver's mirror roll (always drawn): a mirrored copy goes to the shooter unless it resists a MIND name, and may
/// duplicate a row it carries. The rows are appended (laps + 1 on the active unit). Inline: only a board with auras or a
/// Spit Ball holder goes further.
pub inline fn spitBall(s: *State, from_i: u8, tgt_i: u8, active_i: u8) void {
    if (s.auras or s.spit) spitBallOn(s, from_i, tgt_i, active_i);
}

fn spitBallOn(s: *State, from_i: u8, tgt_i: u8, active_i: u8) void {
    const t_i = absorptionTarget(s, tgt_i);
    if (!s.spit) return;
    const t = &s.units[t_i];
    if (t.isDead()) return;
    const from = &s.units[from_i];
    if (from.ability_mask & st.AbilityId.spit_ball.bit() == 0) return;
    const a = from.ability(.spit_ball) orelse return;
    spitBallRolls(s, from_i, t_i, active_i, a);
}

noinline fn spitBallRolls(s: *State, from_i: u8, t_i: u8, active_i: u8, a: *const Ability) void {
    const t = &s.units[t_i];
    const from = &s.units[from_i];
    var cands: [7]u8 = undefined;
    var n: usize = 0;
    for (st.SpellId.SPIT_BALL, 0..) |id, k| {
        if (id == .rangebane and t.attack_type != AT.RANGE) continue;
        if (t.debuffs.find(id) != null) continue;
        cands[n] = @intCast(k);
        n += 1;
    }
    if (n == 0) return;
    const chance = applyChance(from, a);
    const resist = @floor(engine.getMagicResist(t));
    for (cands[0..n]) |k| {
        if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= chance) continue; // spit_ball_ability.ts:73
        const cfg = &s.spit_cfg[k];
        if (!cfg.loaded) {
            s.overflow = true; // the recording carries no config for the debuff
            return;
        }
        const id = st.SpellId.SPIT_BALL[k];
        const saved = @as(f64, @floatFromInt(s.rng.int(0, 100))) < resist; // spit_ball_ability.ts:94
        if (saved or (cfg.mind and mindResistant(t))) continue;
        pushChecked(s, &t.debuffs, .{ .id = id, .laps = if (t_i == active_i) cfg.laps + 1 else cfg.laps, .power = cfg.power });
        // SpellHelper.isMirrored(target): max(Magic Mirror buff power (none in scope), Magic Reflection's chance).
        const mirror = @floor(@max(0, spells.mirroredShare(t)));
        if (@as(f64, @floatFromInt(s.rng.int(0, 100))) < mirror and !(cfg.mind and mindResistant(from))) { // spell_helper.ts:1232
            pushChecked(s, &from.debuffs, .{ .id = id, .laps = if (from_i == active_i) cfg.laps + 1 else cfg.laps, .power = cfg.power });
        }
    }
}

/// calculatePetrifyingGazeKillChance's range factor 0.75^log2(divisor) for the divisors in scope (powers of two to 8).
inline fn petrifyRangeFactor(divisor: f64) f64 {
    const d = @max(1, divisor);
    if (d == 1) return 1;
    if (d == 2) return 0.75;
    if (d == 4) return 0.5625;
    if (d == 8) return 0.421875;
    return std.math.pow(f64, 0.75, std.math.log2(d));
}

/// processPetrifyingGazeAbility(from, to, damage, ..., rangeDivisor): after a landed, unabsorbed hit of `damage` on a
/// living victim, the holder's active Gaze (a MIND card: Madness or Mechanism resists before any roll) rolls the kill
/// coefficient getRandomInt(floor(pmax * 2 / 3), pmax) / 100 (pmax = floor(applyChance)), kills that share of the damage
/// in whole creatures (never the last), then the petrify roll getRandomInt(0, 100) < min(35, round(pmax / 4) + 4 *
/// (level - 1)) x 0.75^log2(divisor), rounded, which adds the front creature's hp. The damage lands with break chance 0
/// and adds a damage statistic. Inline: every hit site of the engine calls it, and only a holder goes further.
pub inline fn petrifyingGaze(s: *State, from_i: u8, to_i: u8, damage: f64, divisor: f64) void {
    if (s.units[from_i].ability_mask & st.AbilityId.petrifying_gaze.bit() != 0) petrifyingGazeHeld(s, from_i, to_i, damage, divisor);
}

fn petrifyingGazeHeld(s: *State, from_i: u8, to_i: u8, damage: f64, divisor: f64) void {
    const to = &s.units[to_i];
    if (to.isDead() or damage <= 0) return;
    const from = &s.units[from_i];
    const a = from.ability(.petrifying_gaze) orelse return;
    if (a.ty == st.AbilityKind.MIND and mindResistant(to)) return;
    gazeRolls(s, from_i, to_i, damage, divisor, a);
}

noinline fn gazeRolls(s: *State, from_i: u8, to_i: u8, damage: f64, divisor: f64, a: *const Ability) void {
    const to = &s.units[to_i];
    const from = &s.units[from_i];
    const pmax = @floor(applyChance(from, a));
    const pmin = @floor((pmax / 3) * 2);
    const coeff = @as(f64, @floatFromInt(s.rng.int(@intFromFloat(pmin), @intFromFloat(pmax)))) / 100; // petrifying_gaze_ability.ts:81
    const killed = (damage * coeff) / to.max_hp;
    var amount = @min(@floor(killed), to.amount_alive - 1);
    var dmg = amount * to.max_hp;
    var proc = false;
    if (amount < to.amount_alive) {
        const level: f64 = @floatFromInt(to.level);
        const base = @min(35, js.round(pmax * 0.25) + 4 * (level - 1));
        const mind_resist: f64 = if (a.ty == st.AbilityKind.MIND) artifacts.statusResist(s, to) else 0;
        const chance = @max(0, js.round(base * petrifyRangeFactor(divisor) * (1 - mind_resist / 100)));
        if (@as(f64, @floatFromInt(s.rng.int(0, 100))) < chance) { // petrifying_gaze_ability.ts:100
            dmg += to.hp;
            proc = true;
        }
    } else amount = to.amount_alive;
    if (amount != 0 or proc) {
        // applyDamage(damage, 0, ..., lastFuseSourceFor(gazer)): a killing petrify records the gazer's Last Fuse.
        const dealt = engine.applyDamageBreak(s, to_i, dmg, 0, false);
        if (s.artifacts and to.isDead()) artifacts.recordFatal(s, to_i, dealt, from_i);
        s.damage_lap = s.fight.lap;
    }
}

// =====================================================================================================================
// Ember Covenant (UnitsHolder.seedEmberCovenant / breakEmberCovenant, Unit.willEmberCovenantBlock)
// =====================================================================================================================

inline fn teamBit(team: u8) u8 {
    return @as(u8, 1) << @intCast(team);
}

/// UnitsHolder.seedEmberCovenant (start_fight, after its stat refresh): every live on-board ally of a live on-board
/// Hydra gets the buff, appended after the rows the refresh wrote.
pub fn seedEmberCovenant(s: *State) void {
    if (s.ember_seeded) return;
    s.ember_seeded = true;
    for (s.units[0..s.n_units]) |*u| {
        if (u.in_holder and !u.isDead() and onGrid(u) and u.has(.ember_covenant_blessing)) s.ember_teams |= teamBit(u.team);
    }
    if (s.ember_teams == 0) return;
    for (s.units[0..s.n_units]) |*u| {
        if (!u.in_holder or s.ember_teams & teamBit(u.team) == 0 or u.isDead() or !onGrid(u)) continue;
        pushChecked(s, &u.buffs, .{ .id = .ember_covenant_blessing, .laps = s.ember_laps, .power = s.ember_power });
    }
}

/// notifyEmberCovenantDamage -> UnitsHolder.breakEmberCovenant: the team's covenant dissolves on every holder unit.
pub fn breakEmberCovenant(s: *State, team: u8) void {
    if (s.ember_teams & teamBit(team) == 0) return;
    s.ember_teams &= ~teamBit(team);
    for (s.units[0..s.n_units]) |*u| {
        if (u.in_holder and u.team == team) u.buffs.delete(.ember_covenant_blessing);
    }
}

/// Unit.willAbsorbIncomingHit (= willEmberCovenantBlock: no Water Shield, no Water Element attacker in scope).
pub inline fn absorbsHit(u: *const Unit) bool {
    return u.buffs.len != 0 and u.buffs.find(.ember_covenant_blessing) != null;
}

/// absorbsHit, skipping the buff scan while no team holds a covenant.
pub inline fn absorbs(s: *const State, u: *const Unit) bool {
    return s.ember_teams != 0 and absorbsHit(u);
}

test "Absorb Penalties aura power is 10 * stack power + luck" {
    var u = std.mem.zeroes(Unit);
    const def = st.AuraDef{ .buff = .absorb_penalties_aura, .range = 2, .power = 50, .is_buff = true, .power_type = PT.ABSORB_DEBUFF };
    var sp: f64 = 1;
    while (sp <= 5) : (sp += 1) {
        var luck: f64 = -10;
        while (luck <= 10) : (luck += 1) {
            u.stack_power = sp;
            u.luck = luck;
            const p = auraPower(&u, &def);
            try std.testing.expectEqual(10 * sp + luck, p);
            try std.testing.expectEqual(p, js.toFixed(p, 1));
        }
    }
}

test "Break turns abilities, auras and skip-response off while it lasts" {
    var u = std.mem.zeroes(Unit);
    u.abilities[0] = .{ .id = .lightning_spin, .power = 50, .power_type = PT.TOTAL_DAMAGE_PERCENTAGE, .ty = 0, .stack_powered = false, .skip_response = true };
    u.n_abilities = 1;
    u.ability_mask = st.AbilityId.lightning_spin.bit();
    u.n_auras = 1;
    try std.testing.expect(u.has(.lightning_spin) and u.ability(.lightning_spin) != null);
    try std.testing.expect(skipsResponse(&u) and u.auraCount() == 1);
    u.effects.replace(.{ .id = .break_, .laps = 2 });
    try std.testing.expect(!u.has(.lightning_spin) and u.ability(.lightning_spin) == null);
    try std.testing.expect(!skipsResponse(&u) and u.auraCount() == 0);
    try std.testing.expect(!u.has(.dodge)); // absent stays absent
    u.effects.delete(.break_);
    try std.testing.expect(u.has(.lightning_spin));
}

test "Boar Saliva is the striker's first miss term, Dodge and Small Specie follow" {
    var att = std.mem.zeroes(Unit);
    var enemy = std.mem.zeroes(Unit);
    att.stack_power = 1;
    enemy.stack_power = 1;
    try std.testing.expectEqual(@as(f64, 0), missChance(&att, &enemy));
    att.effects.replace(.{ .id = .boar_saliva, .laps = 3, .power = 7.8 });
    try std.testing.expectEqual(@as(f64, 7), missChance(&att, &enemy)); // floor(0.078 * 100)
    enemy.abilities[0] = .{ .id = .dodge, .power = 20, .power_type = PT.APPLY_EFFECT, .ty = 0, .stack_powered = true, .skip_response = false };
    enemy.n_abilities = 1;
    enemy.ability_mask = st.AbilityId.dodge.bit();
    // 1 - (1 - 0.078) * (1 - 0.04) = 0.11488
    try std.testing.expectEqual(@as(f64, 11), missChance(&att, &enemy));
}

test "Deep Wounds sums the held cards in level order, then luck and ability power once" {
    var s = std.mem.zeroes(State);
    s.n_units = 2;
    const from = &s.units[0];
    from.stack_power = 3;
    from.luck = -1;
    from.syn_power = 0.5;
    from.abilities[0] = .{ .id = .deep_wounds_level_2, .power = 10, .effect_laps = 3, .power_type = PT.APPLY_EFFECT, .ty = 0, .stack_powered = true, .skip_response = false };
    from.abilities[1] = .{ .id = .deep_wounds_level_1, .power = 6, .effect_laps = 3, .power_type = PT.APPLY_EFFECT, .ty = 0, .stack_powered = true, .skip_response = false };
    from.n_abilities = 2;
    from.ability_mask = st.AbilityId.deep_wounds_level_1.bit() | st.AbilityId.deep_wounds_level_2.bit();
    s.units[1].amount_alive = 1;
    deepWounds(&s, 0, 1, 0);
    // (6/5)*3 + (10/5)*3 - 1 + 0.5 = 9.1, laps 3 off the active unit
    try std.testing.expectEqual(@as(f64, 9.1), s.units[1].effects.power(.deep_wounds).?);
    try std.testing.expectEqual(@as(f64, 3), s.units[1].effects.items[0].laps);
    deepWounds(&s, 0, 1, 1);
    try std.testing.expectEqual(@as(f64, 18.2), s.units[1].effects.power(.deep_wounds).?);
    try std.testing.expectEqual(@as(f64, 4), s.units[1].effects.items[0].laps);
    try std.testing.expectEqual(@as(f64, 18.2), activeDeepWounds(from, &s.units[1]));
    s.units[1].amount_alive = 0;
    deepWounds(&s, 0, 1, 0); // a killing hit wounds nobody
    try std.testing.expectEqual(@as(f64, 18.2), s.units[1].effects.power(.deep_wounds).?);
}
