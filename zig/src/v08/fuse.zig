//! The primary melee estimate and Last Fuse (src/ai/melee_damage_estimate.ts, src/ai/last_fuse_estimate.ts) for the
//! v0.8 policy: the pinned retreat reads the melee estimate's secure kill, and the candidate catalog prices a Last Fuse
//! army's single-impact shots and melee strikes with the corpse's blast.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const combat = @import("../combat.zig");
const abilities = @import("../abilities.zig");
const artifacts = @import("../artifacts.zig");
const js = @import("../jsnum.zig");
const util = @import("util.zig");
const ai = @import("../ai.zig");
const spells = @import("../spells.zig");
const AT = st.AttackType;
const Cell = rec.Cell;

/// Unit.calculateAttackDamageMin/Max at an explicit attack rate (combat.damageBound reads the unit's own attack), with
/// the attacker team's synergy power in getEnemyArmor (an active Piercing Spear scales the armor by 1 - multiplier).
pub fn boundAt(att: *const st.Unit, tgt: *const st.Unit, dmg: f64, rate_in: f64, is_range: bool) f64 {
    // adjustWarlordsEdgeAttackRate re-prices the explicit rate too.
    const rate = if (att.we_base != 0) artifacts.warlordsEdgeRate(att, rate_in, is_range) else rate_in;
    var armor = if (is_range) engine.getRangeArmor(tgt) else engine.getArmor(tgt);
    if (att.ability(.piercing_spear)) |ps| armor = armor * (1 - abilities.abilityMultiplierSyn(att, ps, att.syn_power));
    const luck = engine.getLuck(tgt);
    return @max(1, @ceil(((((dmg * rate * att.amount_alive) / armor) * (1 - luck / 100)) / 1) * att.attack_multiplier * 1));
}

/// projectRangeShotsAfterVolleys: the arrows left after `volleys` volleys (an active Endless Quiver costs none; a
/// range_shots_mod override never runs dry; Dense Flesh is not in scope).
pub fn shotsAfter(u: *const st.Unit, volleys: f64) f64 {
    const per: f64 = if (u.ability_mask & st.AbilityId.endless_quiver.bit() != 0 and u.has(.endless_quiver)) 0 else 1;
    const cost = per * @max(0, volleys);
    if (cost <= 0) return engine.getRangeShots(u);
    if (u.range_shots_mod != 0) return u.range_shots_mod;
    return @max(0, @floor(u.range_shots) - cost);
}

/// What estimatePrimaryMeleeDamage reads of a strike's actions: whether a move precedes it, the charge distance (the
/// move's path length, else the strike's own path, else 1) and whether the move crosses lava.
pub const MeleeShape = struct { moved: bool = false, charge: f64 = 1, lava: bool = false };

pub fn meleeShape(actions: []const rec.Action) MeleeShape {
    var shape: MeleeShape = .{};
    for (actions) |a| if (a == .move_unit) {
        shape.moved = true;
        shape.lava = a.move_unit.has_lava;
        if (a.move_unit.path.len > 0) {
            shape.charge = @floatFromInt(a.move_unit.path.len);
            return shape;
        }
        break;
    };
    for (actions) |a| if (a == .melee_attack and a.melee_attack.path.len > 0) {
        shape.charge = @floatFromInt(a.melee_attack.path.len);
        return shape;
    };
    return shape;
}

/// IPrimaryMeleeDamageEstimate: the hit chance, the hit-weighted expected effective damage, the secure kill, the
/// landed probability of the outcomes that kill (summed in the landed map's order), and the largest landed damage.
pub const MeleeEstimate = struct { hit: f64, expected: f64, secure: bool, fatal: f64, max_damage: f64 };

/// The landed outcomes of a damage chain as TypeScript's Map builds them: one entry per damage, in first-insertion
/// order, each entry's probability accumulated in roll order. Both outcome sequences (the ordinary roll and the lucky
/// one) are non-decreasing in the roll, so each keeps its new keys sorted and a key is found by binary search.
const Landed = struct {
    const CAP = 2048;
    damage: [CAP]f64 = undefined,
    prob: [CAP]f64 = undefined,
    n: usize = 0,
    /// per sequence (0 ordinary, 1 lucky): the entries it created, ascending
    seq: [2][CAP]u16 = undefined,
    nseq: [2]usize = .{ 0, 0 },
    full: bool = false,

    fn find(self: *const Landed, which: usize, d: f64) ?usize {
        const ids = self.seq[which][0..self.nseq[which]];
        var lo: usize = 0;
        var hi: usize = ids.len;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            const v = self.damage[ids[mid]];
            if (v == d) return ids[mid];
            if (v < d) lo = mid + 1 else hi = mid;
        }
        return null;
    }

    /// addOutcome: a zero-probability outcome is dropped.
    fn add(self: *Landed, which: usize, d: f64, p: f64) void {
        if (p <= 0 or self.full) return;
        if (self.find(0, d) orelse self.find(1, d)) |i| {
            self.prob[i] += p;
            return;
        }
        const ids = self.seq[which][0..self.nseq[which]];
        // A sequence that is not monotone (it never is) would break the sorted lookup: give up rather than guess.
        if (self.n >= CAP or (ids.len > 0 and self.damage[ids[ids.len - 1]] > d)) {
            self.full = true;
            return;
        }
        self.damage[self.n] = d;
        self.prob[self.n] = p;
        self.seq[which][self.nseq[which]] = @intCast(self.n);
        self.nseq[which] += 1;
        self.n += 1;
    }
};

/// estimatePrimaryMeleeDamage for unit `ai_` striking `ti` from `from` with `shape`: null for an unsupported sequence
/// (a lava move, Lightning Spin, Double Punch, Skewer Strike; Fire Breath and Chain Lightning are not in the engine)
/// or a malformed band. The chain: Rapid Charge over the charge distance, Paralysis, then the position abilities
/// (Backstab) from `from`, the ranged unit's half-strength swing unless Handyman, the target's Deep Wounds, Lucky
/// Strike's chance and multiplier, and Penetrating Bite's bonus. The rate is the unit's attack without its current aura
/// increase plus the War Anger aura it would have on its footprint at `from` (getUnitAuraAttackMod over standCells). A
/// band too wide for the landed map sets util.unsupported (TypeScript prices up to 10,000 rolls).
pub fn primaryMelee(s: *const st.State, ai_: u8, ti: u8, shape: MeleeShape, from: Cell) ?MeleeEstimate {
    const u = &s.units[ai_];
    const t = &s.units[ti];
    if (t.isDead() or shape.lava) return null;
    if (u.has(.lightning_spin) or u.has(.double_punch) or u.has(.skewer_strike)) return null;
    const stand = ai.footprintForAnchor(u, from);
    const rate = @max(u.base_attack, engine.getAttack(u) - u.attack_mod_increase) + warAngerModAt(s, ai_, stand.slice());
    var handler: f64 = 1;
    if (u.ability(.rapid_charge)) |rc| {
        const base = abilities.abilityMultiplier(u, rc);
        if (base >= 1) handler *= 1 + (base - 1) * shape.charge;
    }
    if (abilities.paralysisFactor(u)) |p| handler *= p;
    handler *= abilities.positionMultiplierOn(u, from, engine.baseCell(t), t.fw, t.fh, s.fight.side_oriented);
    const lo = boundAt(u, t, u.attack_damage_min, rate, false);
    const hi = boundAt(u, t, u.attack_damage_max, rate, false);
    if (hi < lo) return null;
    const rolls = @max(1, hi - lo);
    if (rolls > 10_000) return null;
    const type_mult: f64 = if (u.attack_type == AT.RANGE and !u.has(.handyman)) 0.5 else 1;
    var lucky_chance: f64 = 0;
    var lucky_mult: f64 = 1;
    if (u.ability(.lucky_strike)) |ls| {
        lucky_chance = @min(100, @max(0, @ceil(abilities.applyChance(u, ls)))) / 100;
        lucky_mult = abilities.abilityMultiplier(u, ls);
    }
    const bite = abilities.penetratingBite(u, t);
    const wounds = 1 + abilities.activeDeepWounds(u, t) / 100;
    var landed: Landed = .{};
    const raw_end = if (hi == lo) lo + 1 else hi;
    var raw = lo;
    while (raw < raw_end) : (raw += 1) {
        const ordinary = @floor(raw * type_mult * handler * wounds * 1);
        const p = 1 / rolls;
        if (lucky_chance > 0) {
            landed.add(0, ordinary + bite, p * (1 - lucky_chance));
            landed.add(1, @floor(ordinary * lucky_mult) + bite, p * lucky_chance);
        } else landed.add(0, ordinary + bite, p);
    }
    if (landed.full) {
        util.unsupported = true;
        return null;
    }
    const hit = 1 - @min(100, @max(0, abilities.missChance(u, t))) / 100;
    const hp = util.cumulativeHp(t);
    var expected: f64 = 0;
    var fatal: f64 = 0;
    var every_kills = true;
    var max_damage = -std.math.inf(f64);
    for (landed.damage[0..landed.n], landed.prob[0..landed.n]) |d, p| {
        expected += p * @min(hp, @max(0, d));
        if (d >= hp) fatal += p else every_kills = false;
        max_damage = @max(max_damage, d);
    }
    return .{ .hit = hit, .expected = hit * expected, .secure = hit == 1 and every_kills, .fatal = fatal, .max_damage = max_damage };
}

// ---- Last Fuse ------------------------------------------------------------------------------------------------------

/// ILastFuseDamageEstimate: the expected net damage (the blow and the corpse's blasts), the expected primary damage
/// (null when the estimate has none), the fatal chance and whether the first blow certainly kills.
pub const FuseEstimate = struct { net: f64, primary: ?f64 = null, friendly: f64 = 0, fatal: f64, secure: bool };

/// lastFuseDamage (last_fuse_ability.ts), as artifacts.zig's blast: the striker's stack power x 25, or the fatal
/// damage's share, whichever is larger.
fn fuseBlast(fatal_damage: f64, stack_power: f64, percent: f64) f64 {
    return @max(@max(0, stack_power) * 25, js.round((@max(0, fatal_damage) * percent) / 100));
}

/// Chebyshev contact between two footprints (touches).
fn touches(a: []const Cell, b: []const Cell) bool {
    for (a) |x| for (b) |y| {
        if (@abs(@as(i32, x.x) - @as(i32, y.x)) <= 1 and @abs(@as(i32, x.y) - @as(i32, y.y)) <= 1) return true;
    };
    return false;
}

/// enemyBlastDamage: the corpse of `target` explodes (Last Fuse of `u`'s army) on every touching living enemy of `u`
/// except the target, in holder order: an absorbing shield takes the blast instead (once), each stack loses at most its
/// health, and every stack destroyed explodes in turn (its fatal damage the blast it took), depth first. A blast that
/// destroys a self-resurrecting stack leaves the estimate to search (null).
fn enemyBlastDamage(s: *const st.State, u: *const st.Unit, target: u8) ?f64 {
    const Enemy = struct { slot: u8, hp: f64, shielded: bool, resurrects: bool };
    const Blast = struct {
        enemies: [st.MAX_UNITS]Enemy = undefined,
        n: usize = 0,
        damage: f64 = 0,
        power: f64,
        percent: f64,
        state: *const st.State,
        fn detonate(self: *@This(), cells: []const Cell, fatal_damage: f64) bool {
            const blast = fuseBlast(fatal_damage, self.power, self.percent);
            var destroyed: [st.MAX_UNITS]struct { slot: u8, fatal: f64 } = undefined;
            var nd: usize = 0;
            for (self.enemies[0..self.n]) |*e| {
                if (e.hp <= 0 or !touches(cells, engine.unitCells(&self.state.units[e.slot]).slice())) continue;
                if (e.shielded) {
                    e.shielded = false;
                    continue;
                }
                const dealt = @min(blast, e.hp);
                e.hp -= dealt;
                self.damage += dealt;
                if (e.hp <= 0) {
                    if (e.resurrects) return false;
                    destroyed[nd] = .{ .slot = e.slot, .fatal = dealt };
                    nd += 1;
                }
            }
            for (destroyed[0..nd]) |d| {
                if (!self.detonate(engine.unitCells(&self.state.units[d.slot]).slice(), d.fatal)) return false;
            }
            return true;
        }
    };
    const row = u.buffs.get(.last_fuse) orelse return null;
    var b = Blast{ .power = engine.getStackPower(u), .percent = row.power, .state = s };
    for (s.holderOrder()) |i| {
        const e = &s.units[i];
        if (e.team == u.team or i == target or e.isDead() or !e.in_holder) continue;
        b.enemies[b.n] = .{ .slot = i, .hp = engine.cumulativeHp(e), .shielded = abilities.absorbsHit(e), .resurrects = engine.canSelfResurrect(e) };
        b.n += 1;
    }
    const t = &s.units[target];
    return if (b.detonate(engine.unitCells(t).slice(), engine.cumulativeHp(t))) b.damage else null;
}

/// SECONDARY_RIDERS and the shot cards estimateLastFuseRangedDamage leaves to search.
fn secondaryRider(u: *const st.Unit) bool {
    return u.has(.devour_essence) or u.has(.petrifying_gaze) or u.has(.predatory_assimilation) or u.has(.borrowed_grace);
}

/// estimateLastFuseRangedDamage: a stationary ordinary shot of a Last Fuse army on its only possible impact, priced per
/// roll (Lucky Strike included) with the corpse's blast at the fatal chance; null (search decides) for a shooter or
/// target whose sequence it does not model: a secondary rider or a physical AOE / Chakram / Absolving Arrow card, a
/// Fireforged Sword, a target that can answer the shot, a Double Shot or Echo that may follow an uncertain kill, a
/// self-resurrecting target while the shooter's team can Break (Broken Aegis, Chaos Break on Attack), or a blast that
/// would destroy a self-resurrecting stack. Flesh Shield is not in the engine's scope.
pub fn lastFuseRanged(s: *const st.State, u: *const st.Unit, ti: u8, divisor: f64) ?FuseEstimate {
    const t = &s.units[ti];
    if (t.isDead() or u.buffs.find(.last_fuse) == null or t.team == u.team or engine.getRangeShots(u) <= 0) return null;
    if (u.buffs.find(.fireforged_sword) != null or secondaryRider(u)) return null;
    if (u.has(.through_shot) or u.has(.area_throw) or u.has(.large_caliber) or u.has(.chakram) or u.has(.absolving_arrow)) return null;
    // A possible counter can change the shooter's health, shield, stats or ability to finish the shot.
    if (engine.isRangeCapable(t) and engine.getRangeShots(t) > 0 and !abilities.skipsResponse(u) and !util.repliedAttack(s, ti) and
        !t.isSkipping() and !t.has(.through_shot)) return null;
    const resurrects = engine.canSelfResurrect(t);
    if (resurrects and s.setup[u.team].break_chance > 0) return null;
    const lo = combat.damageBound(u, t, u.attack_damage_min, true, divisor);
    const hi = combat.damageBound(u, t, u.attack_damage_max, true, divisor);
    if (hi < lo) return null;
    const rolls = @max(1, hi - lo);
    if (rolls > 10_000) return null;
    const ability_mult = abilities.paralysisFactor(u) orelse 1;
    const wounds = 1 + abilities.activeDeepWounds(u, t) / 100;
    var lucky_chance: f64 = 0;
    var lucky_mult: f64 = 1;
    if (u.ability(.lucky_strike)) |a| {
        lucky_chance = @min(100, @max(0, @ceil(abilities.applyChance(u, a)))) / 100;
        lucky_mult = abilities.abilityMultiplier(u, a);
    }
    const hit = 1 - @min(100, @max(0, abilities.missChance(u, t))) / 100;
    const hp = engine.cumulativeHp(t);
    var conditional: f64 = 0;
    var conditional_fatal: f64 = 0;
    var minimum = std.math.inf(f64);
    var raw = lo;
    while (raw < lo + rolls) : (raw += 1) {
        // applyAttackDamageChain: one floor over the roll, the ability multiplier, Deep Wounds and the elemental factor (1).
        const ordinary = @floor(raw * 1 * ability_mult * wounds * 1);
        for ([_][2]f64{ .{ ordinary, (1 - lucky_chance) / rolls }, .{ @floor(ordinary * lucky_mult), lucky_chance / rolls } }) |o| {
            if (o[1] <= 0) continue;
            minimum = @min(minimum, o[0]);
            conditional += o[1] * @min(hp, @max(0, o[0]));
            if (o[0] >= hp) conditional_fatal += o[1];
        }
    }
    const absorbed = abilities.absorbsHit(t);
    const first_kills = hit == 1 and minimum >= hp and !absorbed;
    const may_follow = combat.doubleShotAbility(u) != null or artifacts.echoChance(s, u) > 0;
    if (may_follow and !first_kills and !(hit == 1 and shotsAfter(u, 1) <= 0)) return null;
    const fatal = if (resurrects or absorbed) 0 else hit * conditional_fatal;
    const splash = if (fatal > 0) (enemyBlastDamage(s, u, ti) orelse return null) else 0;
    const primary = if (absorbed) 0 else hit * conditional;
    return .{ .net = primary + fatal * splash, .primary = primary, .fatal = fatal, .secure = first_kills and !resurrects };
}

/// canProjectMeleeResponse: whether the target's answer to the strike cannot change it. True when the target cannot
/// answer, or its answer (its own primary melee estimate from its base cell) misses for sure, is absorbed, or never
/// kills the striker; false for an answer the estimate does not model (a Backstab answer to a moved strike, Rapid Charge,
/// the target's Fireforged Sword, a secondary rider, a target team that can Break; Fire Shield and Flesh Shield are not
/// in the engine's scope).
fn canProjectMeleeResponse(s: *const st.State, ai_: u8, ti: u8, shape: MeleeShape) bool {
    const u = &s.units[ai_];
    const t = &s.units[ti];
    if (!util.canRespondToMelee(s, ai_, ti)) return true;
    if ((shape.moved and t.has(.backstab)) or t.has(.rapid_charge) or t.buffs.find(.fireforged_sword) != null or secondaryRider(t) or
        s.setup[t.team].break_chance > 0) return false;
    const response = primaryMelee(s, ti, ai_, .{}, engine.baseCell(t)) orelse return false;
    if (response.hit <= 0 or abilities.absorbsHit(u)) return true;
    return response.max_damage < util.cumulativeHp(u);
}

/// estimateLastFuseMeleeDamage: a supported direct strike of a Last Fuse army priced with the corpse's blast at the
/// strike's fatal chance; null (search decides) for a striker with a Fireforged Sword or a secondary rider (Fire Shield
/// is not in the engine), a move while a Fire Wall burns or an aura is on the board, an unsupported primary sequence,
/// a fatal strike whose answer the estimate cannot project, or a blast that destroys a self-resurrecting stack. An
/// absorbed strike buys nothing.
pub fn lastFuseMelee(s: *const st.State, ai_: u8, ti: u8, shape: MeleeShape, from: Cell) ?FuseEstimate {
    const u = &s.units[ai_];
    const t = &s.units[ti];
    if (u.buffs.find(.last_fuse) == null or t.isDead() or t.team == u.team) return null;
    if (u.buffs.find(.fireforged_sword) != null or secondaryRider(u)) return null;
    if (shape.moved) {
        // decisionFireWalls(context).size() > 0, or any unit projecting an aura (getAuraEffects(): none while Broken).
        if (s.fight.n_fire != 0) return null;
        for (s.holderOrder()) |i| if (s.units[i].auraCount() != 0) return null;
    }
    const resurrects = engine.canSelfResurrect(t);
    if (resurrects and s.setup[u.team].break_chance > 0) return null;
    const damage = primaryMelee(s, ai_, ti, shape, from) orelse return null;
    if (abilities.absorbsHit(t)) return .{ .net = 0, .fatal = 0, .secure = false };
    const fatal = if (resurrects) 0 else damage.hit * damage.fatal;
    if (fatal > 0 and !canProjectMeleeResponse(s, ai_, ti, shape)) return null;
    const splash = if (fatal > 0) (enemyBlastDamage(s, u, ti) orelse return null) else 0;
    return .{ .net = damage.expected + fatal * splash, .primary = damage.expected, .fatal = fatal, .secure = damage.secure and !resurrects };
}

/// estimateLastFuseSpellDamage given the cast's projection (projectSpellDamageAgainstUnit: `damage`, and whether a
/// shield absorbs it): a Last Fuse army's direct cast on an enemy that reflects nothing (mirroredDamageShare 0), priced
/// with the corpse's blast when it kills a stack that cannot resurrect; an absorbed cast prices 0; null (the plain
/// estimate) otherwise, or when the blast would destroy a self-resurrecting stack.
pub fn lastFuseSpell(s: *const st.State, u: *const st.Unit, ti: u8, damage: f64, absorbed: bool) ?FuseEstimate {
    const t = &s.units[ti];
    if (t.isDead() or t.team == u.team or u.buffs.find(.last_fuse) == null or spells.mirroredShare(t) > 0) return null;
    if (absorbed) return .{ .net = 0, .fatal = 0, .secure = false };
    const hp = engine.cumulativeHp(t);
    const fatal = damage >= hp and !engine.canSelfResurrect(t);
    const splash = if (fatal) (enemyBlastDamage(s, u, ti) orelse return null) else 0;
    return .{ .net = @min(damage, hp) + splash, .fatal = if (fatal) 1 else 0, .secure = fatal };
}

/// UnitsHolder.getUnitAuraAttackMod(unit, cells): engine.warAngerMod over `cells` instead of the unit's body. A unit
/// holding the War Anger AuraEffect and not Broken gains getBaseAttack() * ((power * enemies) / 100), the enemies the
/// distinct holder units of the other team standing in the clipped Chebyshev ball of the aura's range plus the team's
/// aura range around any of the cells; 0 otherwise.
fn warAngerModAt(s: *const st.State, ui: u8, cells: []const Cell) f64 {
    const u = &s.units[ui];
    const def = s.war_anger_def;
    if (def == st.NO_AURA or u.n_auras == 0 or u.isBroken()) return 0;
    var holds = false;
    for (u.auras[0..u.n_auras]) |d| {
        if (d == def) holds = true;
    }
    if (!holds) return 0;
    const range = s.aura_defs[def].range + s.setup[u.team].aura_range;
    if (!(range >= 0)) return 0;
    const r: i32 = @intFromFloat(@min(range, st.GRID));
    var seen: st.UnitSet = 0;
    for (cells) |c| {
        if (!engine.cellWithinGrid(c)) continue;
        var x = @max(0, c.x - r);
        while (x <= @min(st.GRID - 1, c.x + r)) : (x += 1) {
            var y = @max(0, c.y - r);
            while (y <= @min(st.GRID - 1, c.y + r)) : (y += 1) {
                const o = s.grid.board[@intCast(x)][@intCast(y)];
                if (!st.isUnitCode(o)) continue;
                const e = &s.units[o - 1];
                if (e.in_holder and e.team != u.team) seen |= engine.unitBit(o - 1);
            }
        }
    }
    return u.base_attack * ((u.war_anger_power * @as(f64, @floatFromInt(@popCount(seen)))) / 100);
}
