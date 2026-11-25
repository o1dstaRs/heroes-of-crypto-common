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

/// The blessing part of UnitsHolder.refreshStackPowerForAllUnits, after setUnitsCalculatedStacksPower and the aura
/// refresh. Luck Blessing is resolved first; while it is in play, the aura emitters and luck-dependent sources get an
/// early stat pass (rolling this lap's luck before the others), the auras are refreshed again with that luck, and
/// the census is taken again.
pub fn refreshBlessings(s: *State) void {
    var c = captureCensus(s);
    const refresh_luck = c.luck.anyPositive() or c.carried & LUCK_BLESSING_BIT != 0;
    if (refresh_luck) {
        reapply(s, &c, &c.luck, LUCK_BLESSING_BIT, .luck_blessing, .all, false);
        for (s.units[0..s.n_units]) |*u| {
            if (!u.in_holder or u.isDead() or !onGrid(u) or (u.n_auras == 0 and !u.luck_dependent)) continue;
            engine.adjustBaseStats(s, u);
        }
        if (s.auras) refreshAuras(s);
        c = captureCensus(s);
    }
    reapply(s, &c, &c.sharpened, SHARPENED_WEAPONS_BLESSING_BIT, .sharpened_weapons_blessing, .melee_or_magic, true);
}

// =====================================================================================================================
// Auras (UnitsHolder.refreshAuraEffectsForAllUnits, Unit.calculateAuraPower / cleanAuraEffects / applyAuraEffect)
// =====================================================================================================================

/// Unit.calculateAuraPower(auraEffect, 0), for the power types the loader accepts.
pub fn auraPower(u: *const Unit, def: *const st.AuraDef) f64 {
    return switch (def.power_type) {
        PT.ADDITIONAL_BASE_ATTACK_AND_ARMOR, PT.POISON_ON_HIT => def.power,
        PT.ABSORB_DEBUFF => blk: {
            var coeff: f64 = 1;
            coeff += (def.power / 100 / MAX_UNIT_STACK_POWER) * engine.getStackPower(u) + (engine.getLuck(u) + SYNERGY) / 100 +
                @as(f64, 0) / 100; // Made of Fire: not in scope
            break :blk js.toFixed(coeff * 100, 2) - 100;
        },
        else => unreachable, // refused at load
    };
}

/// Unit.cleanAuraEffects: every row whose laps are MAX_SAFE_INTEGER goes, with every other row of its name
/// (deleteBuff / deleteDebuff remove by name); the rest keep their order.
fn cleanAuraRows(list: *st.SpellList) void {
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
/// computed once per refresh, the side it lands on and the emitter's base cell (the recorded source cell).
const Emission = struct { unit: u8, def: u8, power: f64, team: u8, src: st.Cell };

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
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder) continue;
        // isFootprintWithinGrid: NORMAL bodies never leave the board.
        cleanAuraRows(&u.buffs);
        cleanAuraRows(&u.debuffs);
        for (u.auras[0..u.n_auras]) |d| {
            const def = &s.aura_defs[d];
            const power = if (def.power != 0) auraPower(u, def) else def.power;
            if (def.range + 0 < 0) continue; // getAdditionalAuraRangePerTeam: 0
            const team = if (def.is_buff) u.team else engine.opposite(u.team);
            if (team != st.Team.LEFT and team != st.Team.RIGHT) continue;
            ems[n_ems] = .{ .unit = @intCast(i), .def = d, .power = power, .team = team, .src = engine.baseCell(u) };
            n_ems += 1;
        }
    }
    if (n_ems == 0) return;
    var bodies: [st.MAX_UNITS]engine.Cells = undefined;
    for (ems[0..n_ems]) |e| bodies[e.unit] = engine.unitCells(&s.units[e.unit]);
    for (s.units[0..s.n_units]) |*u| {
        if (!u.in_holder) continue;
        var rows: AuraRows = .{};
        const cells = engine.unitCells(u);
        for (cells.slice()) |c| {
            if (!engine.cellWithinGrid(c)) continue; // no emission stamps an off-board key
            var cell_rows: AuraRows = .{};
            for (ems[0..n_ems], 0..) |e, ei| {
                if (e.team != u.team) continue;
                if (!covers(bodies[e.unit].slice(), c, s.aura_defs[e.def].range)) continue;
                cell_rows.offer(ems[0..n_ems], @intCast(ei));
            }
            for (cell_rows.em[0..cell_rows.len]) |ei| rows.offer(ems[0..n_ems], ei);
        }
        // applyAuraEffectToUnit -> canApplyAuraEffect (true for the power types in scope) -> applyAuraEffect
        for (rows.em[0..rows.len]) |ei| {
            const e = ems[ei];
            const def = &s.aura_defs[e.def];
            u.buffs.replace(.{
                .id = def.buff,
                .laps = st.LAPS_AURA,
                .power = js.toFixed(e.power, 1),
                .src_x = @intCast(e.src.x),
                .src_y = @intCast(e.src.y),
            });
        }
    }
}

// =====================================================================================================================
// On-hit riders and other batch-2 processors (src/abilities/*.ts)
// =====================================================================================================================

/// applyPoisonEffect (poison_ability.ts): a new hit stacks onto the active poison.
fn applyPoison(s: *const State, tgt: *Unit, poison_hp: f64) void {
    if (tgt.isDead() or poison_hp <= 0) return; // canBePoisoned: no Mechanism in scope; no Holy Cross
    const active = tgt.effects.power(.poison) orelse 0;
    const stacked = if (active != 0) @max(poison_hp, active + @max(1, js.round(poison_hp * 0.5))) else poison_hp;
    if (stacked <= active) return;
    tgt.effects.replace(.{ .id = .poison, .laps = s.poison_laps, .power = stacked });
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
    // MIND: 1 - getMindResist() / 100, and getMindResist is the Amulet of Resolve (not in scope).
    if (!(@as(f64, @floatFromInt(s.rng.int(0, 100))) < applyChance(from, a) * 1)) return;
    if (to.effects.find(.aggr) != null) return;
    const laps = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    // hasMindAttackResistance (Madness, Mechanism): none in scope.
    to.effects.replace(.{ .id = .aggr, .laps = laps, .power = a.effect_power });
    to.target = @intCast(from_i);
}

/// processPegasusLightAbility(from, target, currentActiveUnit): power = the effect's 10 + the Pegasus's luck.
pub fn pegasusLight(s: *State, from_i: u8, to_i: u8, active_i: u8) void {
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const a = from.ability(.pegasus_light) orelse return;
    if (to.effects.find(.pegasus_light) != null) return;
    // calculateEffectMultiplier: Pegasus Light returns the combined power, flat
    var power = a.effect_power + engine.getLuck(from) + SYNERGY;
    if (power < 0) power = 1;
    const laps = if (to_i == active_i) extendLaps(a.effect_laps) else a.effect_laps;
    to.effects.replace(.{ .id = .pegasus_light, .laps = laps, .power = power });
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
        // Unit.applyHeal
        const heal = up_to - u.hp;
        if (heal < 0) return;
        u.hp += @floor(heal);
        if (u.hp > u.max_hp) u.hp = u.max_hp;
    }
}

/// processSpitBallAbility(from, target) for a shooter without Spit Ball: only EffectHelper.getAbsorptionTarget's roll,
/// drawn when the target carries Absorb Penalties Aura and a unit stands on its source cell. The outcome is unused.
pub fn spitBall(s: *State, tgt_i: u8) void {
    if (!s.auras) return; // the buff exists only through the aura refresh
    const tgt = &s.units[tgt_i];
    const b = tgt.buffs.get(.absorb_penalties_aura) orelse return;
    if (b.src_x < 0 or b.src_y < 0) return;
    const c = st.Cell{ .x = b.src_x, .y = b.src_y };
    if (!engine.cellWithinGrid(c)) return;
    const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
    if (!st.isUnitCode(o)) return;
    _ = s.rng.int(0, 100); // getRandomInt(0, 100) < floor(power) && !source.isDead(): discarded
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
        u.buffs.push(.{ .id = .ember_covenant_blessing, .laps = s.ember_laps, .power = s.ember_power });
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
