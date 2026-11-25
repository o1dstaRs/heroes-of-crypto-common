//! Creature abilities: the per-unit ability formulas (src/units/unit.ts `calculateAbility*`, `calculateMissChance`),
//! the processors in src/abilities/*.ts that need no damage roll, and the team blessings of
//! UnitsHolder.refreshStackPowerForAllUnits (`captureBlessingCensus`, `reapplyTeamBlessing`).
//!
//! In scope there are no synergies, artifacts, Made of Fire, Break, Mechanism or Empower, so every synergy term is 0
//! and those branches are left out; the arithmetic keeps TypeScript's evaluation order so every double matches.

const std = @import("std");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");

const Unit = st.Unit;
const State = st.State;
const Ability = st.Ability;
const PT = st.PowerType;
const AT = st.AttackType;

pub const MAX_UNIT_STACK_POWER: f64 = 5;
/// FightProperties.getAdditionalAbilityPowerPerTeam: no synergies in scope.
const SYNERGY: f64 = 0;

// =====================================================================================================================
// Ability formulas (src/units/unit.ts)
// =====================================================================================================================

/// Unit.calculateAbilityMultiplier
pub fn abilityMultiplier(u: *const Unit, a: *const Ability) f64 {
    var coeff: f64 = 1;
    switch (a.power_type) {
        PT.TOTAL_DAMAGE_PERCENTAGE, PT.MAGIC_DAMAGE, PT.KILL_RANDOM_AMOUNT, PT.IGNORE_ARMOR, PT.MAGIC_RESIST_50, PT.MAGIC_RESIST_25, PT.ABSORB_DEBUFF, PT.BOOST_HEALTH => {
            var combined = a.power + engine.getLuck(u) + 0 + SYNERGY;
            if (combined < 0) combined = 1;
            if (a.stack_powered) {
                coeff *= (combined / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u);
            } else {
                coeff *= combined / 100;
            }
        },
        PT.ADDITIONAL_DAMAGE_PERCENTAGE, PT.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE, PT.ADDITIONAL_RANGE_ARMOR_PERCENTAGE => {
            const own = if (a.stack_powered) (a.power / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) else a.power / 100;
            coeff += own + (engine.getLuck(u) + SYNERGY) / 100 + @as(f64, 0) / 100;
        },
        else => {},
    }
    // Empower scales only Chain Lightning, Fire Breath and Fire Shield: none in scope.
    return coeff;
}

/// Unit.calculateAbilityApplyChance
pub fn applyChance(u: *const Unit, a: *const Ability) f64 {
    const combined = engine.getLuck(u) + SYNERGY + ((a.power + 0) / MAX_UNIT_STACK_POWER) * engine.getStackPower(u);
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
        return (a.power / MAX_UNIT_STACK_POWER) * sp + luck / 10 + SYNERGY / 10 + @as(f64, 0) / 10;
    }
    return js.toFixed((a.power / MAX_UNIT_STACK_POWER) * sp + ((luck + 0 + SYNERGY) / 100) * a.power, 1);
}

/// Unit.canSkipResponse: an ability that is never answered (Shadow Touch).
pub fn skipsResponse(u: *const Unit) bool {
    if (u.ability_mask == 0) return false;
    for (u.abilities[0..u.n_abilities]) |a| if (a.skip_response) return true;
    return false;
}

/// Unit.calculateMissChance(enemy): the enemy's Dodge, and its Small Specie against a level-4 attacker.
pub fn missChance(att: *const Unit, enemy: *const Unit) f64 {
    if (enemy.ability_mask & (st.AbilityId.dodge.bit() | st.AbilityId.small_specie.bit()) == 0) return 0;
    var chances: [2]f64 = undefined;
    var n: usize = 0;
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
    var m: f64 = 1;
    const a = u.ability(.backstab) orelse return m;
    if (u.team == st.Team.LEFT and from.y > to.y) m *= abilityMultiplier(u, a);
    if (u.team == st.Team.RIGHT and from.y < to.y - (@as(i32, @max(1, to_h)) - 1)) m *= abilityMultiplier(u, a);
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
    const amplifier: f64 = 1; // 1.5 for a STATUS-type card on a Mechanism target: no Mechanism in scope
    const power = js.toFixed(existing + abilityCount(from, a) * amplifier, 2);
    var laps = a.effect_laps;
    if (to_i == active_i and laps != st.LAPS_AURA and laps != st.NUMBER_OF_LAPS_TOTAL) laps += 1; // Effect.extend
    // Unit.applyEffect
    to.effects.delete(.shatter_armor);
    to.effects.push(.{ .id = .shatter_armor, .laps = laps, .power = power });
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

const SHARPENED_WEAPONS_BLESSING_BIT: u32 = 32;
const LUCK_BLESSING_BIT: u32 = 128;

inline fn blessingBit(id: st.SpellId) u32 {
    return switch (id) {
        .luck_blessing => LUCK_BLESSING_BIT,
        .sharpened_weapons_blessing => SHARPENED_WEAPONS_BLESSING_BIT,
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
    sharpened: TeamPowers = .{},
    /// Per unit index: the blessing bits it carries.
    carriers: [st.MAX_UNITS]u32 = undefined,
    carried: u32 = 0,
};

/// Unit.calculateStackBlessingPower("Luck Blessing")
fn stackBlessingPower(u: *const Unit, a: *const Ability) f64 {
    const sp = @max(0, @min(MAX_UNIT_STACK_POWER, engine.getStackPower(u)));
    return js.toFixed((a.power * sp) / MAX_UNIT_STACK_POWER, 2);
}

/// Unit.calculateSharpenedWeaponsBlessingPower
fn sharpenedWeaponsPower(u: *const Unit, a: *const Ability) f64 {
    return js.toFixed((a.power / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) + engine.getLuck(u) + SYNERGY + 0, 2);
}

inline fn onGrid(u: *const Unit) bool {
    return engine.cellWithinGrid(engine.baseCell(u));
}

/// UnitsHolder.captureBlessingCensus
fn captureCensus(s: *const State) Census {
    var c: Census = .{};
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder) continue;
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
        if (u.ability(.sharpened_weapons_blessing)) |a| {
            const power = sharpenedWeaponsPower(u, a);
            c.sharpened.v[team] = js.max(if (c.sharpened.set[team]) c.sharpened.v[team] else -std.math.inf(f64), power);
            c.sharpened.set[team] = true;
        }
    }
    return c;
}

const Eligible = enum { all, melee_or_magic };

/// UnitsHolder.reapplyTeamBlessing: strip the blessing from its carriers, then grant every living on-board unit its
/// team's strongest power (laps NUMBER_OF_LAPS_TOTAL, never ticked down).
fn reapply(s: *State, c: *const Census, powers: *const TeamPowers, bit: u32, id: st.SpellId, eligible: Eligible, allow_non_positive: bool) void {
    const has_power = if (allow_non_positive) powers.any() else powers.anyPositive();
    if (c.carried & bit == 0 and !has_power) return;
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder) continue;
        if (c.carriers[i] & bit != 0) u.buffs.delete(id);
        if (!powers.set[u.team]) continue;
        const power = powers.v[u.team];
        if ((!allow_non_positive and power <= 0) or u.isDead() or !onGrid(u)) continue;
        if (eligible == .melee_or_magic and u.attack_type != AT.MELEE and u.attack_type != AT.MAGIC and u.attack_type != AT.MELEE_MAGIC) continue;
        u.buffs.push(.{ .id = id, .laps = st.NUMBER_OF_LAPS_TOTAL, .power = power });
    }
}

/// The blessing part of UnitsHolder.refreshStackPowerForAllUnits, after setUnitsCalculatedStacksPower. Luck Blessing
/// is resolved first; while it is in play, the luck-dependent sources get an early stat pass (rolling this lap's luck
/// before the others) and the census is taken again.
pub fn refreshBlessings(s: *State) void {
    var c = captureCensus(s);
    const refresh_luck = c.luck.anyPositive() or c.carried & LUCK_BLESSING_BIT != 0;
    if (refresh_luck) {
        reapply(s, &c, &c.luck, LUCK_BLESSING_BIT, .luck_blessing, .all, false);
        for (s.units[0..s.n_units]) |*u| {
            if (!u.in_holder or u.isDead() or !onGrid(u) or !u.luck_dependent) continue;
            engine.adjustBaseStats(s, u);
        }
        c = captureCensus(s);
    }
    reapply(s, &c, &c.sharpened, SHARPENED_WEAPONS_BLESSING_BIT, .sharpened_weapons_blessing, .melee_or_magic, true);
}
