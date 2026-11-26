//! Artifacts: the army-wide items of the pick phase (one Tier 1 and one Tier 2 per team, `artifacts/
//! artifact_properties.ts`). In a runMatch battle `UnitsHolder.applyArtifacts` runs once at setup and puts one buff row
//! per artifact on every beneficiary (dual artifacts also a power-0 marker debuff of the same name); the recorded start
//! state carries the rows, so the port never re-derives them. Every row has laps NUMBER_OF_LAPS_TOTAL (never ticks),
//! its power, and the stored properties "first;second" (`AppliedSpell.src_x / src_y`, integers; Keen Blade's 0.7 is
//! only ever read as the power).
//!
//! Ported so far: the stat artifacts (`Unit.adjustBaseStats`, no random draws): Veteran Helm, Keen Blade, Iron Plate,
//! Swift Boots, Winged Boots, Cursed Ward, Hunter's Longbow, Warlord's Edge (with its damage-band re-price), Titan
//! Plate, Clover of Fortune, Crown of Command, Pendant of Vitality, Berserker's Bond and Aegis of the Arcane. A team
//! holding any other artifact is refused at load (its buff name is unknown to `SpellId`, and `supportedT1/T2` refuse
//! the export's team maps).

const std = @import("std");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const abilities = @import("abilities.zig");
const terrain = @import("terrain.zig");

const Unit = st.Unit;
const AppliedSpell = st.AppliedSpell;
const AT = st.AttackType;

/// Tier1Artifact ids the port plays (artifact_properties.ts): Veteran Helm 1, Amulet of Resolve 2, Keen Blade 3, Iron
/// Plate 4, Swift Boots 5, Winged Boots 6, Dual Strike Charm 7, Wounding Charm 8 (its marker row and the Deep Wounds
/// Level 1 card applyArtifacts lends, appended last to the unit's abilities; batch 4 plays the card), Cursed Ward 9,
/// Hunter's Longbow 10, Barrel Barricade 11 (no row: its barrels at start_fight), Mage's Ring 13, Tome of
/// Amplification 14.
pub fn supportedT1(id: i64) bool {
    return switch (id) {
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15 => true,
        else => false,
    };
}

/// Tier2Artifact ids the port plays: Warlord's Edge 1, Titan Plate 2, Clover of Fortune 4, Crown of Command 5, Giant's
/// Maul 6, Pendant of Vitality 7, Farsight Quiver 8, Berserker's Bond 9, the retired Tome id 10, Lava Striders 12,
/// Archmage's Ring 13, Aegis of the Arcane 14, Last Fuse 17.
pub fn supportedT2(id: i64) bool {
    return switch (id) {
        0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17 => true,
        else => false,
    };
}

/// The artifact rows adjustBaseStats reads: the first buff of each name (`statBuffs`), from one pass over the list.
pub const Rows = struct {
    veteran_helm: ?*const AppliedSpell = null,
    keen_blade: ?*const AppliedSpell = null,
    iron_plate: ?*const AppliedSpell = null,
    swift_boots: ?*const AppliedSpell = null,
    winged_boots: ?*const AppliedSpell = null,
    cursed_ward: ?*const AppliedSpell = null,
    hunters_longbow: ?*const AppliedSpell = null,
    warlords_edge: ?*const AppliedSpell = null,
    titan_plate: ?*const AppliedSpell = null,
    clover_of_fortune: ?*const AppliedSpell = null,
    crown_of_command: ?*const AppliedSpell = null,
    pendant_of_vitality: ?*const AppliedSpell = null,
    berserkers_bond: ?*const AppliedSpell = null,
    aegis_of_the_arcane: ?*const AppliedSpell = null,
    gravechain: ?*const AppliedSpell = null,
};

pub fn rows(u: *const Unit) Rows {
    var r: Rows = .{};
    for (u.buffs.items[0..u.buffs.len]) |*b| {
        if (!b.id.isArtifact()) continue;
        switch (b.id) {
            inline .veteran_helm, .keen_blade, .iron_plate, .swift_boots, .winged_boots, .cursed_ward, .hunters_longbow, .warlords_edge, .titan_plate, .clover_of_fortune, .crown_of_command, .pendant_of_vitality, .berserkers_bond, .aegis_of_the_arcane, .gravechain => |id| {
                if (@field(r, @tagName(id)) == null) @field(r, @tagName(id)) = b;
            },
            else => {},
        }
    }
    return r;
}

/// `parseInt(getBuffProperties(name)[k] || "0", 10)`: a stored property, 0 when empty.
pub inline fn prop(v: i8) f64 {
    return if (v < 0) 0 else @floatFromInt(v);
}

/// Warlord's Edge's percentage for a strike type: the power (16) for a ranged strike, else the second stored property
/// (12), falling back to the power (`getSecondSpellProperty() ?? getPower()`).
pub inline fn warlordsEdgePercent(we: *const AppliedSpell, range: bool) f64 {
    if (range) return we.power;
    return if (we.src_y >= 0) @floatFromInt(we.src_y) else we.power;
}

/// Unit.adjustWarlordsEdgeAttackRate (unit.ts:2895), first thing in calculateAttackDamageMin / Max: when the strike type
/// differs from the selection the last refresh priced, the captured bonus is swapped for the strike type's.
pub fn warlordsEdgeRate(att: *const Unit, rate: f64, is_range: bool) f64 {
    const we = att.buffs.get(.warlords_edge) orelse return rate;
    if (att.we_base == 0) return rate;
    const bonus = js.roundUnitStat((att.we_base / 100) * warlordsEdgePercent(we, is_range), 2);
    if (bonus == att.we_bonus) return rate;
    return js.roundUnitStat(rate - att.we_bonus + bonus, 2);
}

/// No artifact rows: what a battle without artifacts reads.
pub const none: Rows = .{};

/// Pendant of Vitality in the HP block: +power % of the adjusted max hp, before the refill.
pub noinline fn pendantHp(u: *Unit, r: *const Rows) void {
    if (r.pendant_of_vitality) |pv| u.max_hp += js.roundUnitStat((u.max_hp / 100) * pv.power, 2);
}

/// The artifact luck of the LUCK block: Cursed Ward's power plus Clover of Fortune's, in that order.
pub inline fn luck(r: *const Rows) f64 {
    var sum: f64 = 0;
    if (r.cursed_ward) |cw| sum += cw.power;
    if (r.clover_of_fortune) |cf| sum += cf.power;
    return sum;
}

/// The MORALE block's artifact delta (on the shown morale, never the base): Cursed Ward's second stored property off,
/// Crown of Command's first on, before the Madness / Morale / Dismorale locks and the clamp.
pub noinline fn morale(u: *Unit, r: *const Rows) void {
    if (r.cursed_ward) |cw| u.morale -= prop(cw.src_y);
    if (r.crown_of_command) |cc| u.morale += prop(cc.src_x);
}

/// armor_mod after the Nature flyer share: Veteran Helm's share of the final base armor (no outer rounding), then
/// Titan Plate's captured share (rounded with the sum; skipped when 0, `if (titanPlateArmorBonus)`).
pub noinline fn armorMod(u: *Unit, r: *const Rows, titan_bonus: f64) void {
    if (r.veteran_helm) |vh| u.armor_mod += js.roundUnitStat((u.base_armor / 100) * vh.power, 2);
    if (titan_bonus != 0) u.armor_mod = js.roundUnitStat(u.armor_mod + titan_bonus, 2);
}

/// Aegis of the Arcane's independent magic-resist term, folded last into the product of the no-resist chances.
pub inline fn aegis(r: *const Rows, no_resist: f64) f64 {
    const ag = r.aegis_of_the_arcane orelse return no_resist;
    const chance = @min(1, @max(0, ag.power) / 100);
    return if (chance > 0) no_resist * (1 - chance) else no_resist;
}

/// The STEPS block after the Movement Augment: Swift Boots' share of the running steps, Winged Boots' and Crown of
/// Command's flat steps (unrounded until the block's final r1).
pub noinline fn steps(u: *Unit, r: *const Rows) void {
    if (r.swift_boots) |sb| u.steps += js.roundUnitStat((u.steps / 100) * sb.power, 2);
    if (r.winged_boots) |wb| u.steps += wb.power;
    if (r.crown_of_command) |cc| u.steps += cc.power;
    // Gravechain's army-wide step penalty (ARTIFACT_POWER.GRAVECHAIN_STEPS_PENALTY, the constant).
    if (r.gravechain != null) u.steps -= 1;
}

/// The ARMOR block after the Armor Augment: Titan Plate's captured share (returned; added to armor_mod later), then
/// the flats before Heavy Armor's multiplier: Iron Plate's power, Winged Boots' and Crown of Command's second stored
/// property, Berserker's Bond's penalty (floored at 1).
pub noinline fn armorFlats(u: *Unit, r: *const Rows) f64 {
    const titan_bonus: f64 = if (r.titan_plate) |tp| js.roundUnitStat((u.base_armor / 100) * tp.power, 2) else 0;
    if (r.iron_plate) |ip| u.base_armor += ip.power;
    if (r.winged_boots) |wb| u.base_armor += prop(wb.src_y);
    if (r.crown_of_command) |cc| u.base_armor += prop(cc.src_y);
    if (r.berserkers_bond) |bb| u.base_armor = @max(1, u.base_armor - prop(bb.src_y));
    return titan_bonus;
}

/// The attack artifacts of adjustBaseStats, after the Might / Sniper augments and before Sharpened Weapons'
/// multiplier: Keen Blade's and Berserker's Bond's flats, Warlord's Edge's capture (the share of the running base
/// attack for the SELECTED attack type, kept in we_base / we_bonus and returned for attack_mod), Hunter's Longbow's
/// first stored property while RANGE is selected, then Pendant of Vitality's penalty on the running value.
pub noinline fn attackArtifacts(u: *Unit, r: *const Rows) f64 {
    if (r.keen_blade) |kb| u.base_attack += kb.power;
    if (r.berserkers_bond) |bb| u.base_attack += bb.power;
    var we_bonus: f64 = 0;
    if (r.warlords_edge) |we| we_bonus = js.roundUnitStat((u.base_attack / 100) * warlordsEdgePercent(we, u.attack_type_selected == AT.RANGE), 2);
    u.we_base = if (r.warlords_edge != null) u.base_attack else 0;
    u.we_bonus = we_bonus;
    if (u.attack_type_selected == AT.RANGE) {
        if (r.hunters_longbow) |hl| u.base_attack += prop(hl.src_x);
    }
    if (r.pendant_of_vitality) |pv| u.base_attack -= js.roundUnitStat((u.base_attack / 100) * prop(pv.src_y), 2);
    return we_bonus;
}

/// Rows whose stored properties the port loads, digests and compares: every artifact row but Keen Blade's (its first
/// property is the power, 1 or 0.7, which does not fit the integer slot and is never read as a property), and the runes
/// (the stacked bonus).
pub inline fn storesProperties(id: st.SpellId) bool {
    return (id.isArtifact() and id != .keen_blade) or id == .armor_rune or id == .weapon_rune;
}

// =====================================================================================================================
// Combat modifiers (no random draws of their own): Amulet of Resolve, Giant's Maul, Dual Strike Charm, Farsight Quiver,
// Mage's / Archmage's Ring, Tome of Amplification
// =====================================================================================================================

/// getStatusResist() / getMindResist(): the Amulet of Resolve row's power (its only source), 0 without it.
pub inline fn statusResist(s: *const st.State, u: *const Unit) f64 {
    if (!s.artifacts) return 0;
    return u.buffs.power(.amulet_of_resolve) orelse 0;
}

/// The MIND abilities' `1 - target.getMindResist() / 100` (Aggr, Terrifying Gaze, Boar Saliva); 1 for other types.
pub inline fn mindCoeff(s: *const st.State, ability_type: u8, target: *const Unit) f64 {
    if (ability_type != st.AbilityKind.MIND) return 1;
    return 1 - statusResist(s, target) / 100;
}

/// A physical AOE sub-hit's Giant's Maul after the damage roll (lightning_spin_ability.ts:189, skewer_strike_ability.ts:169,
/// through_shot_ability.ts:165, aoe_range_ability.ts:178): the striker's `floor(d * (1 + power / 100))`, before the
/// victim's combat.physicalAoeMultiplier (no Broken Aegis in the live pools).
pub inline fn giantsMaul(striker: *const Unit, damage: f64) f64 {
    const gm = striker.buffs.get(.giants_maul) orelse return damage;
    return @floor(damage * (1 + gm.power / 100));
}

/// withDualStrikeCharm (ability_helper.ts:137): the second strike's multiplier times (1 + power / 100).
pub inline fn dualStrike(u: *const Unit, multiplier: f64) f64 {
    const charm = u.buffs.get(.dual_strike_charm) orelse return multiplier;
    return multiplier * (1 + charm.power / 100);
}

/// dualStrike on a battle with artifact rows, else the multiplier as it is.
pub inline fn dualStrikeIn(s: *const st.State, u: *const Unit, multiplier: f64) f64 {
    return if (s.artifacts) dualStrike(u, multiplier) else multiplier;
}

/// hasBuffActive("Farsight Quiver"): the shooter ignores the range falloff (engine divisor and v0.1's scan).
pub inline fn farsight(u: *const Unit) bool {
    return u.buffs.len != 0 and u.buffs.find(.farsight_quiver) != null;
}

/// getMagicDamageBonusPercentage's ring terms: Mage's Ring, then Archmage's Ring, each when finite and positive.
pub fn ringsBonus(u: *const Unit) f64 {
    var total: f64 = 0;
    for ([_]st.SpellId{ .mages_ring, .archmages_ring }) |id| {
        if (u.buffs.power(id)) |p| {
            if (std.math.isFinite(p) and p > 0) total += p;
        }
    }
    return total;
}

/// amplifyCastBuffForTarget (spells/castable_buff.ts:66) for an ally's copy of a cast buff: a non-HEAL, non-RESURRECT
/// buff of non-zero power cast by a unit holding the Tome of Amplification gets
/// tomeAmplifiedBuffPower = Number((power * (1 + tome / 100)).toFixed(4)).
pub fn tomePower(caster: *const Unit, cfg: *const st.SpellConfig, power: f64) f64 {
    if (!cfg.is_buff or cfg.power_type == st.SpellPower.HEAL or cfg.power_type == st.SpellPower.RESURRECT) return power;
    const tome = caster.buffs.get(.tome_of_amplification) orelse return power;
    if (!std.math.isFinite(power) or power == 0) return power;
    if (!std.math.isFinite(tome.power) or tome.power <= 0) return power;
    return toFixed4(power * (1 + tome.power / 100));
}

/// `Number(x.toFixed(4))`: the nearest multiple of 10^-4 (exact decimal expansion of the binary value), ties to the
/// larger magnitude, as jsnum.toFixed does for one and two digits.
pub fn toFixed4(x: f64) f64 {
    if (std.math.isNan(x) or std.math.isInf(x)) return x;
    const neg = x < 0;
    const a = @abs(x);
    if (a >= 9007199254740992.0) return x;
    const bits: u64 = @bitCast(a);
    const exp_field: i32 = @intCast((bits >> 52) & 0x7ff);
    var m: u64 = bits & ((@as(u64, 1) << 52) - 1);
    var e: i32 = undefined;
    if (exp_field == 0) {
        e = -1074;
    } else {
        m |= @as(u64, 1) << 52;
        e = exp_field - 1075;
    }
    const scale: u128 = 10000;
    var n: u128 = undefined;
    if (e >= 0) {
        n = (@as(u128, m) << @intCast(e)) * scale;
    } else {
        const k: u32 = @intCast(-e);
        const num: u128 = @as(u128, m) * scale;
        if (k >= 120) {
            n = 0;
        } else {
            const den: u128 = @as(u128, 1) << @intCast(k);
            const q: u128 = num >> @intCast(k);
            const rem: u128 = num - (q << @intCast(k));
            n = q;
            if (rem * 2 >= den) n += 1;
        }
    }
    const r = @as(f64, @floatFromInt(n)) / 10000.0;
    return if (neg) -r else r;
}

test "toFixed4 matches JavaScript" {
    const t = std.testing;
    try t.expectEqual(@as(f64, 9.45), toFixed4(7.0 * 1.35));
    try t.expectEqual(@as(f64, 40.5), toFixed4(30.0 * 1.35));
    try t.expectEqual(@as(f64, 33.75), toFixed4(25.0 * 1.35));
    try t.expectEqual(@as(f64, 0.0001), toFixed4(0.00005));
}

// =====================================================================================================================
// Lava Striders and Made of Fire (lava_striders: every on-grid unit of the team may walk and stand on the LAVA_CENTER
// square; a lava route gives the System "Made of Fire" buff)
// =====================================================================================================================

/// Unit.canTraverseLava: hasAbilityActive("Made of Fire") (no Fire creature in scope) or the Lava Striders row.
pub inline fn canTraverseLava(s: *const st.State, u: *const Unit) bool {
    return s.artifacts and u.buffs.len != 0 and u.buffs.find(.lava_striders) != null;
}

/// getBuff("Made of Fire")?.getPower(): the +power % terms of the stat refresh and the ability formulas.
pub inline fn madeOfFire(u: *const Unit) ?f64 {
    if (u.buffs.len == 0) return null;
    return u.buffs.power(.made_of_fire);
}

/// `(madeOfFireBuff ? (power / 100) * madeOfFireBuff.getPower() : 0)`, the term every ability formula adds.
pub inline fn fireTerm(mof: ?f64, power: f64) f64 {
    return if (mof) |p| (power / 100) * p else 0;
}

/// Unit.applyLavaWaterModifier (move_handler applyRouteMoveModifiers, after the distance morale): a route that touched
/// lava gives a unit that can traverse it, and does not carry the buff yet, "Made of Fire" (laps + 1: extend) and
/// raises its current stats at once (max hp ceil, attack and armor to 2 decimals, steps exact, initiative and shot
/// distance to 1, magic resist to 2; hp untouched). The next refresh recomputes them from the initial stats.
pub fn lavaRoute(s: *st.State, ui: u8, has_lava: bool) void {
    const u = &s.units[ui];
    if (!has_lava or !canTraverseLava(s, u)) return;
    if (u.buffs.find(.made_of_fire) != null) return;
    const p = s.mof_power;
    if (u.buffs.len >= st.SpellList.capacity) {
        s.overflow = true;
        return;
    }
    u.buffs.push(.{ .id = .made_of_fire, .laps = s.mof_laps + 1, .power = p });
    u.max_hp = @max(@ceil(u.max_hp + u.max_hp / p), u.max_hp);
    u.base_attack = @max(js.toFixed(u.base_attack + u.base_attack / p, 2), u.base_attack);
    u.base_armor = @max(js.toFixed(u.base_armor + u.base_armor / p, 2), u.base_armor);
    u.steps = @max(u.steps + u.steps / p, u.steps);
    u.initiative = @max(js.toFixed(u.initiative + u.initiative / p, 1), u.initiative);
    u.shot_distance = @max(js.toFixed(u.shot_distance + u.shot_distance / p, 1), u.shot_distance);
    u.magic_resist = @max(js.toFixed(u.magic_resist + u.magic_resist / p, 2), u.magic_resist);
}

// =====================================================================================================================
// Last Fuse (last_fuse_ability.ts): a stack killed by a hit from an army that holds it explodes in its death cleanup;
// every living unit of the corpse's side touching the corpse takes max(25 * stack power, round(fatal damage * 25%))
// raw hp (no roll, armor, resist, morale or statistic), and a stack the blast kills explodes in turn, depth first.
// =====================================================================================================================

/// Unit.applyDamage's lastFuseFatalHit on a killing hit: lastFuseSourceFor(striker) (its "Last Fuse" row, its team,
/// the row's power, its stack power as last refreshed), dropped for a same-team kill.
pub fn recordFatal(s: *st.State, victim_i: u8, applied: f64, striker_i: u8) void {
    const striker = &s.units[striker_i];
    const victim = &s.units[victim_i];
    const row = striker.buffs.get(.last_fuse) orelse {
        victim.fuse = .{};
        return;
    };
    if (striker.team == victim.team) {
        victim.fuse = .{};
        return;
    }
    victim.fuse = .{ .damage = applied, .team = striker.team, .stack_power = engine.getStackPower(striker), .percent = row.power };
}

/// lastFuseDamage(damageDealt, attackerStackPower, percent)
inline fn blastDamage(fuse: st.FuseHit) f64 {
    return @max(@max(0, fuse.stack_power) * 25, js.round((@max(0, fuse.damage) * fuse.percent) / 100));
}

/// explodeLastFuse for a corpse just deleted (its base cell, footprint and team as it died): the blast set is the box
/// [ax - w, ax + 1] x [ay - h, ay + 1] around the anchor (cellsAroundUnit(corpse, false)); every holder unit off the
/// source's team, alive, with a body cell in it takes the blast in holder order. Kills go to `chain` in hit order,
/// each recording the copied source.
pub fn explode(s: *st.State, anchor: st.Cell, fw: u8, fh: u8, corpse_team: u8, fuse: st.FuseHit, chain: anytype) void {
    if (fuse.team == 0 or fuse.team == corpse_team) return;
    const damage = blastDamage(fuse);
    if (damage <= 0) return;
    const x0 = anchor.x - @as(i32, fw);
    const y0 = anchor.y - @as(i32, fh);
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team == fuse.team or e.isDead()) continue;
        const body = engine.unitCells(e);
        var touches = false;
        for (body.slice()) |c| {
            if (c.x >= x0 and c.x <= anchor.x + 1 and c.y >= y0 and c.y <= anchor.y + 1) touches = true;
        }
        if (!touches) continue;
        const dealt = engine.applyDamageElement(s, i, damage, 0, false, st.Element.UNSET);
        if (dealt <= 0) continue;
        if (e.isDead()) {
            e.fuse = .{ .damage = dealt, .team = fuse.team, .stack_power = fuse.stack_power, .percent = fuse.percent };
            chain.push(i);
        }
    }
}

/// detonateLastFuseChain: each blast kill (in hit order) leaves the holder, gets its unit_destroyed, and explodes in
/// turn, depth first. No Infest from a blast kill.
pub fn detonateChain(s: *st.State, victims: []const u8, events: *engine.Events) void {
    for (victims) |vi| {
        const v = &s.units[vi];
        if (!v.in_holder or !v.isDead()) continue;
        // deleteUnitById(id, true): a Resurrection holder revives in place (no unit_destroyed, no blast).
        if (engine.tryRevive(s, vi)) continue;
        const anchor = engine.baseCell(v);
        const fw = v.fw;
        const fh = v.fh;
        const team = v.team;
        const fuse = v.fuse;
        v.fuse = .{};
        engine.deleteUnit(s, vi);
        events.push(.unit_destroyed, v.uid);
        var next: Chain = .{};
        explode(s, anchor, fw, fh, team, fuse, &next);
        detonateChain(s, next.items[0..next.len], events);
    }
}

/// A blast's kills, in hit order.
pub const Chain = struct {
    items: [st.MAX_UNITS]u8 = undefined,
    len: u8 = 0,
    pub fn push(self: *Chain, u: u8) void {
        if (self.len >= st.MAX_UNITS) return;
        self.items[self.len] = u;
        self.len += 1;
    }
};

// =====================================================================================================================
// Barrel Barricade (artifact_barrels.ts): at start_fight each owning team places two barrels in its deployment zone;
// each becomes an ordinary one-hit scattered stone (terrain.addBarrel) on any map. No draws.
// =====================================================================================================================

pub const BARREL_BARRICADE: u8 = 11;

const BarrelKey = struct { blocks: u1, rank: f64, axis: i32, x: i32, y: i32 };

fn barrelBlocks(c: st.Cell, shooters: []const st.Cell, team: u8, side: bool) bool {
    for (shooters) |sh| {
        if (side) {
            if (c.y != sh.y) continue;
            if (if (team == st.Team.LEFT) c.x > sh.x else c.x < sh.x) return true;
        } else if (c.x == sh.x and (if (team == st.Team.LEFT) c.y > sh.y else c.y < sh.y)) return true;
    }
    return false;
}

fn barrelRank(c: st.Cell, shooters: []const st.Cell, team: u8, side: bool) f64 {
    if (shooters.len == 0) return 0;
    var best: f64 = std.math.inf(f64);
    for (shooters) |sh| {
        const cross: i32 = if (side) @intCast(@abs(c.y - sh.y)) else @intCast(@abs(c.x - sh.x));
        const inward: i32 = if (side) (if (team == st.Team.LEFT) c.x - sh.x else sh.x - c.x) else (if (team == st.Team.LEFT) c.y - sh.y else sh.y - c.y);
        const v: f64 = @floatFromInt((if (inward < 0) @as(i32, 100) else 0) + cross * 2 + @max(0, inward - 1));
        best = @min(best, v);
    }
    return best;
}

fn keyLess(_: void, a: BarrelKey, b: BarrelKey) bool {
    if (a.blocks != b.blocks) return a.blocks < b.blocks;
    if (a.rank != b.rank) return a.rank < b.rank;
    if (a.axis != b.axis) return a.axis < b.axis;
    if (a.x != b.x) return a.x < b.x;
    return a.y < b.y;
}

inline fn orthogonal(a: st.Cell, b: st.Cell) bool {
    return @abs(a.x - b.x) + @abs(a.y - b.y) == 1;
}

/// ActionEngine.startFight's barrel block: for LEFT then RIGHT, when the team holds Barrel Barricade, the zone of its
/// Placement augment (artifactBarrelPlacementCells: the RECTANGLE of size 3 / 4 / 6), sorted by (on a friendly
/// shooter's file in front of it, screen rank, inward edge first, x, y); barrel 0 is the first free safe cell with a
/// free safe orthogonal neighbour, barrel 1 the first free safe cell next to barrel 0 (else the first one).
pub fn placeBarrels(s: *st.State) void {
    for ([_]u8{ st.Team.LEFT, st.Team.RIGHT }) |team| {
        if (s.setup[team].artifact_t1 != BARREL_BARRICADE) continue;
        const size: i32 = switch (s.setup[team].placement) {
            0 => 3,
            1 => 4,
            else => 6,
        };
        const side = s.fight.side_oriented;
        var zone: [st.GRID * st.GRID]BarrelKey = undefined;
        var n: usize = 0;
        var x_lo: i32 = 0;
        var x_hi: i32 = 0;
        var y_lo: i32 = 0;
        var y_hi: i32 = 0;
        if (side) {
            const e: i32 = if (size >= 6) 0 else 1;
            const inset: i32 = if (size == 3) 1 else 0;
            x_lo = if (team == st.Team.LEFT) e else 15 - e - size + 1;
            x_hi = if (team == st.Team.LEFT) e + size - 1 else 15 - e;
            y_lo = inset;
            y_hi = 15 - inset;
        } else {
            const r: i32 = if (size >= 6) 0 else 1;
            x_lo = if (size == 3) 1 else 0;
            x_hi = if (size == 3) 14 else 15;
            y_lo = if (team == st.Team.LEFT) r else 15 - r - size + 1;
            y_hi = if (team == st.Team.LEFT) r + size - 1 else 15 - r;
        }
        // The shooters: every board cell of every living RANGE unit of the team.
        var shooters: [64]st.Cell = undefined;
        var ns: usize = 0;
        for (s.holderOrder()) |i| {
            const u = &s.units[i];
            if (u.team != team or u.isDead()) continue;
            var ranged = u.attack_type == AT.RANGE;
            for (u.possible[0..u.n_possible]) |pt| {
                if (pt == AT.RANGE) ranged = true;
            }
            if (!ranged) continue;
            const body = engine.unitCells(u);
            for (body.slice()) |c| {
                if (!engine.cellWithinGrid(c) or s.grid.board[@intCast(c.x)][@intCast(c.y)] != i + 1) continue;
                if (ns < shooters.len) {
                    shooters[ns] = c;
                    ns += 1;
                }
            }
        }
        const sign: i32 = if (team == st.Team.LEFT) -1 else 1;
        var x = x_lo;
        while (x <= x_hi) : (x += 1) {
            var y = y_lo;
            while (y <= y_hi) : (y += 1) {
                const c = st.Cell{ .x = x, .y = y };
                zone[n] = .{
                    .blocks = @intFromBool(barrelBlocks(c, shooters[0..ns], team, side)),
                    .rank = barrelRank(c, shooters[0..ns], team, side),
                    .axis = sign * (if (side) x else y),
                    .x = x,
                    .y = y,
                };
                n += 1;
            }
        }
        std.mem.sort(BarrelKey, zone[0..n], {}, keyLess);
        var placed: ?st.Cell = null;
        for (0..2) |index| {
            var eligible: [st.GRID * st.GRID]st.Cell = undefined;
            var ne: usize = 0;
            var any_safe = false;
            for (zone[0..n]) |k| {
                if (s.grid.board[@intCast(k.x)][@intCast(k.y)] == st.EMPTY and k.blocks == 0) any_safe = true;
            }
            for (zone[0..n]) |k| {
                if (s.grid.board[@intCast(k.x)][@intCast(k.y)] != st.EMPTY) continue;
                if (any_safe and k.blocks != 0) continue;
                eligible[ne] = .{ .x = k.x, .y = k.y };
                ne += 1;
            }
            if (ne == 0) continue;
            var target: st.Cell = eligible[0];
            if (placed) |p0| {
                for (eligible[0..ne]) |c| {
                    if (orthogonal(p0, c)) {
                        target = c;
                        break;
                    }
                }
            } else {
                outer: for (eligible[0..ne]) |c| {
                    for (eligible[0..ne]) |o| {
                        if (orthogonal(c, o)) {
                            target = c;
                            break :outer;
                        }
                    }
                }
            }
            terrain.addBarrel(s, team, @intCast(index), target);
            placed = target;
        }
    }
}

// =====================================================================================================================
// Rime Charm and Gravechain (trigger_riders): riders on a landed hit owned by the striker's row (not Break-aware), each
// roll getRandomInt(0, 100) with no chance short-cut.
// =====================================================================================================================

/// processRimeCharmAbility(from, target, currentActiveUnit?): a living target without full magic resist rolls against
/// clamp(power + the striker's luck, 0, 100); a target already in Quagmire keeps it (checked AFTER the draw); else the
/// Quagmire debuff (laps from the second stored property, + 1 on the active unit).
pub fn rimeCharm(s: *st.State, from_i: u8, to_i: u8, active: ?u8) void {
    if (!s.artifacts) return;
    const to = &s.units[to_i];
    if (to.isDead()) return;
    const from = &s.units[from_i];
    const rc = from.buffs.get(.rime_charm) orelse return;
    if (engine.getMagicResist(to) >= 100) return;
    const base: f64 = if (rc.power != 0) rc.power else if (rc.src_x > 0) prop(rc.src_x) else 30;
    const chance = @max(0, @min(100, base + engine.getLuck(from)));
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= chance) return; // rime_charm_ability.ts:41
    if (to.debuffs.find(.quagmire) != null) return;
    const laps: f64 = if (rc.src_y >= 0) prop(rc.src_y) else 3;
    const extend: f64 = if (active != null and active.? == to_i) 1 else 0;
    abilities.pushChecked(s, &to.debuffs, .{ .id = .quagmire, .laps = laps + extend, .power = s.quagmire_power });
}

/// The getAuraCells(cell, 1) order: the cell, then getCellsAroundCell's ring (on the board).
const RING = [8][2]i32{ .{ -1, 1 }, .{ 0, 1 }, .{ -1, 0 }, .{ 1, 1 }, .{ 1, 0 }, .{ -1, -1 }, .{ 0, -1 }, .{ 1, -1 } };

/// processGravechainAbility(attacker, target, ..., currentActiveUnit, attemptedTargets): the chance is computed once
/// (clamp(power + luck, 0, 100)); the links are the target (dead or alive) and its living teammates touching it, up to
/// three hops (getGravechainLinks: per source, its cells in getCells order, each cell's aura cells at range 1); each link
/// not yet attempted in this exchange is marked, then a living one without full magic resist and not Gravebound rolls,
/// and a hit applies Gravebound (laps from the second stored property, + 1 on the active unit).
pub fn gravechain(s: *st.State, att_i: u8, tgt_i: u8, active_i: u8, attempted: *st.UidSet) void {
    if (!s.artifacts) return;
    const att = &s.units[att_i];
    const gc = att.buffs.get(.gravechain) orelse return;
    const tgt = &s.units[tgt_i];
    if (att.team == tgt.team) return;
    const chance = @max(0, @min(100, gc.power + engine.getLuck(att)));
    const laps: f64 = if (gc.src_y > 0) prop(gc.src_y) else 3;
    var links: [st.MAX_UNITS]u8 = undefined;
    var n: usize = 0;
    var visited: st.UidSet = .{};
    links[0] = tgt_i;
    n = 1;
    visited.add(tgt.uid);
    var layer_start: usize = 0;
    var layer_end: usize = 1;
    var hop: usize = 0;
    while (hop < 3 and layer_start < layer_end) : (hop += 1) {
        for (links[layer_start..layer_end]) |src_i| {
            const body = engine.unitCells(&s.units[src_i]);
            for (body.slice()) |c| {
                var k: usize = 0;
                while (k < 9) : (k += 1) {
                    const nb: st.Cell = if (k == 0) c else .{ .x = c.x + RING[k - 1][0], .y = c.y + RING[k - 1][1] };
                    if (!engine.cellWithinGrid(nb)) continue;
                    const o = s.grid.board[@intCast(nb.x)][@intCast(nb.y)];
                    if (!st.isUnitCode(o)) continue;
                    const ui: u8 = o - 1;
                    const u = &s.units[ui];
                    if (visited.has(u.uid)) continue;
                    if (!u.in_holder or u.team != tgt.team or u.isDead()) continue;
                    visited.add(u.uid);
                    if (n < links.len) {
                        links[n] = ui;
                        n += 1;
                    }
                }
            }
        }
        layer_start = layer_end;
        layer_end = n;
    }
    for (links[0..n]) |li| {
        const e = &s.units[li];
        if (attempted.has(e.uid)) continue;
        attempted.add(e.uid);
        if (e.isDead() or engine.getMagicResist(e) >= 100 or e.debuffs.find(.gravebound) != null) continue;
        if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= chance) continue; // gravechain_ability.ts:61
        const extend: f64 = if (li == active_i) 1 else 0;
        abilities.pushChecked(s, &e.debuffs, .{ .id = .gravebound, .laps = laps + extend, .power = s.gravebound_power });
    }
}

// =====================================================================================================================
// Quiver of Echoes (attack_handler.ts handleRangeAttack, handleObstacleAttack): the volley itself is combat.echo.
// =====================================================================================================================

/// Unit.getBonusRangedAttackChance: a native shooter (attack_type RANGE) holding the Quiver of Echoes row rolls an extra
/// volley at clamp(power + luck, 0, 100) (power: the row's, else its first stored property, else 35); 0 otherwise.
pub fn echoChance(s: *const st.State, u: *const Unit) f64 {
    if (!s.artifacts or u.attack_type != AT.RANGE or u.buffs.len == 0) return 0;
    const q = u.buffs.get(.quiver_of_echoes) orelse return 0;
    const power: f64 = if (q.power != 0) q.power else if (q.src_x > 0) prop(q.src_x) else 35;
    return @max(0, @min(100, power + engine.getLuck(u)));
}
