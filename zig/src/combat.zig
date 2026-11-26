//! Melee, ranged and obstacle attacks: GameActionEngine.meleeAttack / rangeAttack / obstacleAttack and the
//! AttackHandler paths they take in scope (the abilities in abilities.zig, no spells; NORMAL, LAVA_CENTER and
//! BLOCK_CENTER grids). Every unit hit passes the striker's team break chance to engine.applyDamageBreak (the Chaos
//! BREAK_ON_ATTACK roll), at the TypeScript call site's point in the action.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const js = @import("jsnum.zig");
const engine = @import("engine.zig");
const server = @import("server.zig");
const abilities = @import("abilities.zig");
const terrain = @import("terrain.zig");
const spells = @import("spells.zig");
const artifacts = @import("artifacts.zig");

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

/// `victim.applyDamage(damage, getBreakChancePerTeam(striker team), sceneLog, extendBreak, striker)`: a killing hit
/// records the striker's Last Fuse source (artifacts.recordFatal).
inline fn hit(s: *State, striker_i: u8, victim_i: u8, damage: f64, extend: bool) f64 {
    if (!s.artifacts) return engine.applyDamageBreak(s, victim_i, damage, breakChance(s, striker_i), extend);
    const was_alive = !s.units[victim_i].isDead();
    const dealt = engine.applyDamageBreak(s, victim_i, damage, breakChance(s, striker_i), extend);
    if (was_alive and s.units[victim_i].isDead()) artifacts.recordFatal(s, victim_i, dealt, striker_i);
    return dealt;
}

/// Unit.calculateAttackDamageMin/Max with the attacker's own team ability power (every engine call site).
pub fn damageBound(att: *const Unit, tgt: *const Unit, dmg: f64, is_range: bool, divisor_in: f64) f64 {
    return damageBoundSyn(att, tgt, dmg, is_range, divisor_in, att.syn_power);
}

/// Unit.calculateAttackDamageMin/Max with an explicit synergy power, which getEnemyArmor hands to Piercing Spear's
/// multiplier: an active Piercing Spear scales the target's armor by (1 - multiplier), unfloored. Warlord's Edge
/// re-prices the attack rate (artifacts.warlordsEdgeRate).
pub fn damageBoundSyn(att: *const Unit, tgt: *const Unit, dmg: f64, is_range: bool, divisor_in: f64, syn: f64) f64 {
    const rate = if (att.we_base != 0) artifacts.warlordsEdgeRate(att, engine.getAttack(att), is_range) else engine.getAttack(att);
    var armor = if (is_range) engine.getRangeArmor(tgt) else engine.getArmor(tgt);
    if (att.ability_mask & st.AbilityId.piercing_spear.bit() != 0) armor = piercedArmor(att, armor, syn);
    const divisor = if (divisor_in <= 0) 1 else divisor_in;
    const luck = engine.getLuck(tgt);
    return @max(1, @ceil(((((dmg * rate * att.amount_alive) / armor) * (1 - luck / 100)) / divisor) * att.attack_multiplier * 1));
}

/// Piercing Spear's armor (out of line: inside damageBoundSyn it kept every damage bound from inlining).
noinline fn piercedArmor(att: *const Unit, armor: f64, syn: f64) f64 {
    const ps = att.ability(.piercing_spear) orelse return armor;
    return armor * (1 - abilities.abilityMultiplierSyn(att, ps, syn));
}

/// Unit.calculateAttackDamage. A ranged roll spends the attacker's shot before rolling (unless `spend` is false: the
/// AOE tail spends one arrow after the volley); the ability multiplier is applied after the roll
/// (resolveAttackDamageChain / applyAttackDamageChain). A RANGE creature swings at half strength unless it has an
/// active Handyman.
fn calculateAttackDamage(s: *State, att: *Unit, tgt: *const Unit, attack_type: u8, divisor: f64, ability_multiplier: f64) f64 {
    return attackDamage(s, att, tgt, attack_type, divisor, ability_multiplier, true);
}

fn attackDamage(s: *State, att: *Unit, tgt: *const Unit, attack_type: u8, divisor: f64, ability_multiplier: f64, spend: bool) f64 {
    const is_range = attack_type == AT.RANGE;
    const lo = damageBound(att, tgt, att.attack_damage_min, is_range, divisor);
    const hi = damageBound(att, tgt, att.attack_damage_max, is_range, divisor);
    const by_melee = attack_type == AT.MELEE or attack_type == AT.MELEE_MAGIC;
    const type_mult: f64 = if (by_melee and att.attack_type == AT.RANGE and !att.has(.handyman)) 0.5 else 1;
    if (!by_melee and is_range) {
        if (engine.getRangeShots(att) <= 0) return 0;
        if (spend) spendShotsAgainst(att);
    }
    const roll: f64 = @floatFromInt(s.rng.int(@intFromFloat(lo), @intFromFloat(hi)));
    // The chain's Deep Wounds factor (calculateActiveDeepWoundsEffect), before Lucky Strike; the elemental factor is 1.
    const dw = abilities.activeDeepWounds(att, tgt);
    if (dw != 0) return @floor(roll * type_mult * ability_multiplier * (1 + dw / 100) * 1);
    return @floor(roll * type_mult * ability_multiplier * 1 * 1);
}

/// decreaseNumberOfShots
fn spendShot(att: *Unit) void {
    att.range_shots -= 1;
    if (att.range_shots < 0) att.range_shots = 0;
    att.range_shots = @floor(att.range_shots);
}

/// Unit.spendShotsAgainst: projectShotCost is 0 for a holder of an active UNLIMITED_SUPPLIES ability (Endless Quiver;
/// no Dense Flesh in scope), else one arrow.
fn spendShotsAgainst(att: *Unit) void {
    if (att.ability_mask & st.AbilityId.endless_quiver.bit() != 0 and att.has(.endless_quiver)) return;
    spendShot(att);
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
pub const MoraleDecrease = struct {
    keys: [16]struct { name: u16, team: u8, amount: f64 } = undefined,
    len: u8 = 0,

    /// updateMoraleDecreaseForTheUnitTeam with one "<name>:<team>" entry (positive amounts only).
    pub fn add(self: *MoraleDecrease, u: *const Unit, amount: f64) void {
        if (amount <= 0) return;
        for (self.keys[0..self.len]) |*k| {
            if (k.name == u.name_id and k.team == u.team) {
                k.amount += amount;
                return;
            }
        }
        if (self.len >= self.keys.len) return;
        self.keys[self.len] = .{ .name = u.name_id, .team = u.team, .amount = amount };
        self.len += 1;
    }

    /// UnitsHolder.decreaseMoraleForTheSameUnitsOfTheTeam
    pub fn apply(self: *const MoraleDecrease, s: *State) void {
        for (self.keys[0..self.len]) |k| {
            for (s.holderOrder()) |i| {
                const u = &s.units[i];
                if (u.team == k.team and u.name_id == k.name) engine.changeMorale(u, k.amount, false);
            }
        }
    }
};

pub const Died = struct {
    items: [st.MAX_UNITS]u8 = undefined,
    len: u8 = 0,

    pub fn includes(self: *const Died, u: u8) bool {
        for (self.items[0..self.len]) |x| if (x == u) return true;
        return false;
    }
    pub fn push(self: *Died, u: u8) void {
        if (!self.includes(u)) {
            self.items[self.len] = u;
            self.len += 1;
        }
    }
};

// =====================================================================================================================
// Fireforged Sword (abilities/fireforged_sword_ability.ts): the Wandering Mage's buff burns after its holder's hits
// =====================================================================================================================

/// The sweep or volley victims a burn reads (the attack's `secondary` / `perUnitDamage` entries, in order): the damage
/// each hit dealt, or the swing a Water Shield or an Ember Covenant ring ate (`ignition`).
pub const SwordHits = struct {
    slots: [2 * st.MAX_UNITS]u8 = undefined,
    bases: [2 * st.MAX_UNITS]f64 = undefined,
    len: u8 = 0,

    fn push(self: *SwordHits, slot: u8, dealt: f64, swing: f64, absorbed: bool) void {
        if (self.len >= self.slots.len) return;
        self.slots[self.len] = slot;
        self.bases[self.len] = if (absorbed and swing > 0) swing else dealt;
        self.len += 1;
    }
};

/// Whether `u` holds the Fireforged Sword buff (the buff list: Break-proof), on a battle where one can exist.
inline fn holdsSword(s: *const State, u: *const Unit) bool {
    return s.swords and u.buffs.len != 0 and u.buffs.find(.fireforged_sword) != null;
}

/// The hit list a holder's sweep or volley fills (null when it cannot burn).
inline fn swordList(s: *const State, u: *const Unit, hits: *SwordHits) ?*SwordHits {
    return if (holdsSword(s, u)) hits else null;
}

/// fireforgedSwordDamage: 0 at magic resist >= 100 or for a non-positive base or power; else
/// floor(((base * power) / 100) * Heavy Armor's magic multiplier * element) (0 for a Fire Element), then
/// applyMagicResistToSpellDamage.
fn swordDamage(to: *const Unit, base: f64, power: f64) f64 {
    const mr = engine.getMagicResist(to);
    if (mr >= 100 or !(base > 0) or !(power > 0)) return 0;
    const element = spells.elementMultiplier(st.Element.FIRE, to);
    if (element <= 0) return 0;
    const burn = ((base * power) / 100) * spells.magicDamageTakenMultiplier(to);
    const resist = @max(0, @min(100, mr));
    return @max(0, @floor(@floor(burn * element) * (1 - resist / 100)));
}

const Burn = struct { killed: bool = false, wielder_died: bool = false };

/// processFireforgedSwordAbility: a living victim of a holder takes the burn (the buff's power when finite and positive)
/// as FIRE damage with no break roll (an Ember Covenant ring blocks it and stays), the damage statistic row, and a
/// killing burn records the wielder's Last Fuse. Then applyMagicMirrorDamage: a victim holding a Magic Mirror buff
/// reflects floor(burn x its buff power / 100) onto a living wielder, through the wielder's Heavy Armor, element and
/// magic resist, as FIRE with no break roll and no Last Fuse source (its own team).
fn swordBurn(s: *State, from_i: u8, to_i: u8, base: f64) Burn {
    const to = &s.units[to_i];
    if (to.isDead()) return .{};
    const sword = s.units[from_i].buffs.get(.fireforged_sword) orelse return .{};
    const power: f64 = if (std.math.isFinite(sword.power) and sword.power > 0) sword.power else 0;
    const burn = swordDamage(to, base, power);
    if (burn <= 0) return .{};
    const dealt = engine.applyDamageElement(s, to_i, burn, 0, false, st.Element.FIRE);
    engine.markDamageLap(s, dealt);
    if (s.artifacts and to.isDead()) artifacts.recordFatal(s, to_i, dealt, from_i);
    var out: Burn = .{ .killed = to.isDead() };
    const from = &s.units[from_i];
    const share = spells.mirrorBuffPower(to);
    if (share > 0 and from_i != to_i and !from.isDead()) {
        const reflected = @floor((burn * share) / 100);
        const heavy = spells.magicDamageTakenMultiplier(from);
        const landed = spells.damageAgainstNoHeavy(if (heavy == 1) reflected else @floor(reflected * heavy), st.Element.FIRE, from);
        if (landed > 0) {
            const back = engine.applyDamageElement(s, from_i, landed, 0, false, st.Element.FIRE);
            if (s.artifacts and from.isDead()) artifacts.recordFatal(s, from_i, back, from_i);
            out.wielder_died = from.isDead();
        }
    }
    return out;
}

/// A single-target burn (the blow, the second punch, the shots, the responses): a kill joins `died` once and its
/// same-name stacks' loss merges into `decrease`; returns the kill morale (+4) for the sites that grant it.
fn swordHit(s: *State, from_i: u8, to_i: u8, base: f64, died: *Died, decrease: *MoraleDecrease) f64 {
    if (!holdsSword(s, &s.units[from_i])) return 0;
    const b = swordBurn(s, from_i, to_i, base);
    var plus: f64 = 0;
    if (b.killed) {
        if (!died.includes(to_i)) died.push(to_i);
        decrease.add(&s.units[to_i], engine.MORALE_CHANGE_FOR_KILL);
        plus = engine.MORALE_CHANGE_FOR_KILL;
    }
    // A wielder killed by the reflection joins the deaths (no morale either way).
    if (b.wielder_died and !died.includes(from_i)) died.push(from_i);
    return plus;
}

/// processFireforgedSwordOnVictims: each listed unit once, at its first entry with a positive base, never the wielder;
/// a kill joins `died` once and merges its same-name loss into `decrease` (null: Through Shot's, which drops both).
/// Returns the kills' morale (+4 each).
fn swordOnVictims(s: *State, from_i: u8, hits: *const SwordHits, died: *Died, decrease: ?*MoraleDecrease) f64 {
    if (hits.len == 0 or !holdsSword(s, &s.units[from_i])) return 0;
    var burned: st.UnitSet = 0;
    var plus: f64 = 0;
    for (hits.slots[0..hits.len], hits.bases[0..hits.len]) |v, base| {
        if (!(base > 0) or burned & engine.unitBit(v) != 0 or v == from_i) continue;
        burned |= engine.unitBit(v);
        const b = swordBurn(s, from_i, v, base);
        if (b.killed) {
            if (!died.includes(v)) died.push(v);
            if (decrease) |d| d.add(&s.units[v], engine.MORALE_CHANGE_FOR_KILL);
            plus += engine.MORALE_CHANGE_FOR_KILL;
        }
        if (b.wielder_died and !died.includes(from_i)) died.push(from_i);
    }
    return plus;
}

/// processOneInTheFieldAbility: the reply is spent unless the unit holds One in the Field (Break-aware, read now).
inline fn spendReply(s: *State, ui: u8) void {
    if (s.units[ui].ability_mask & st.AbilityId.one_in_the_field.bit() != 0 and s.units[ui].has(.one_in_the_field)) return;
    s.fight.replied |= engine.unitBit(ui);
    s.units[ui].responded = true;
}

/// createDirectKillAttributions: up to two (victim, killer) pairs (a melee strike: the target by the attacker, the
/// attacker by the target; a shot: the primary by the shooter, the counter-shot's victim by the primary), or an area
/// throw's enemies (`area`, slot bits) all by `k1`. A killer's Infest is read at cleanup, a dead killer's too (its slot
/// keeps it: the active unit's slot and a holder unit's are never reused within the step, and the killers are captured
/// before any corpse is removed).
const Attribution = struct {
    v1: u8 = engine.NO_SLOT,
    /// The killers as they stood before the cleanup (a removed corpse's slot can take a summon).
    k1: engine.Killer = undefined,
    v2: u8 = engine.NO_SLOT,
    k2: engine.Killer = undefined,
    area: st.UnitSet = 0,
};

/// GameActionEngine.cleanupDeadUnits: each dead unit of `died` (in order) leaves the holder, a Last Fuse corpse blasts its
/// neighbours, the corpse of a direct kill by an Infest holder raises a summon (engine.spawnInfested), then the blast's
/// kills chain.
fn cleanupDeadUnits(s: *State, died: *const Died, events: *Events, attribution: ?*const Attribution) void {
    for (died.items[0..died.len]) |ui| {
        const u = &s.units[ui];
        if (!u.in_holder or !u.isDead()) continue;
        // deleteUnitById(id, true): a Resurrection holder revives in place (no unit_destroyed, blast or Infest summon).
        if (engine.tryRevive(s, ui)) continue;
        const corpse = engine.unitCells(u);
        const level = u.level;
        const anchor = engine.baseCell(u);
        const fw = u.fw;
        const fh = u.fh;
        const team = u.team;
        const fuse = u.fuse;
        u.fuse = .{};
        engine.deleteUnit(s, ui);
        events.push(.unit_destroyed, u.uid);
        // Last Fuse: the corpse's blast, then the Infest spawn, then the blast kills' chain.
        var chain: artifacts.Chain = .{};
        if (s.artifacts) artifacts.explode(s, anchor, fw, fh, team, fuse, &chain);
        if (attribution) |a| {
            const killer: ?*const engine.Killer = if (ui == a.v1) &a.k1 else if (ui == a.v2) &a.k2 else if (a.area & engine.unitBit(ui) != 0) &a.k1 else null;
            if (killer) |k| {
                if (k.infest) engine.spawnInfested(s, k, level, corpse.slice());
            }
        }
        if (chain.len != 0) artifacts.detonateChain(s, chain.items[0..chain.len], events);
    }
}

/// cleanupDeadUnits([unit]) for a stack a Fire Wall burned to death on its way (with the strike's kill attributions when
/// it was walking in to strike: a target holding Infest raises a summon from the attacker's corpse).
pub fn cleanupFireDeath(s: *State, ui: u8, attribution: ?*const Attribution, events: *Events) void {
    var died: Died = .{};
    died.push(ui);
    cleanupDeadUnits(s, &died, events, attribution);
}

/// cleanupDeadUnits with a spell's kill attributions (createDirectKillAttributions over the caster's enemy victims,
/// `killed`): each dead unit of `died` leaves the holder in order, and a killed corpse raises a summon when the
/// caster (`killer`, captured before the cleanup) holds Infest.
pub fn cleanupSpellDeaths(s: *State, died: *const Died, killed: *const Died, killer: *const engine.Killer, events: *Events) void {
    for (died.items[0..died.len]) |ui| {
        const u = &s.units[ui];
        if (!u.in_holder or !u.isDead()) continue;
        // deleteUnitById(id, true): a Resurrection holder revives in place (no unit_destroyed, blast or Infest summon).
        if (engine.tryRevive(s, ui)) continue;
        const corpse = engine.unitCells(u);
        const level = u.level;
        const anchor = engine.baseCell(u);
        const fw = u.fw;
        const fh = u.fh;
        const team = u.team;
        const fuse = u.fuse;
        u.fuse = .{};
        engine.deleteUnit(s, ui);
        events.push(.unit_destroyed, u.uid);
        var chain: artifacts.Chain = .{};
        if (s.artifacts) artifacts.explode(s, anchor, fw, fh, team, fuse, &chain);
        if (killer.infest and killed.includes(ui)) engine.spawnInfested(s, killer, level, corpse.slice());
        if (chain.len != 0) artifacts.detonateChain(s, chain.items[0..chain.len], events);
    }
}

fn sameCellList(a: []const Cell, b: []const Cell) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (x.x != y.x or x.y != y.y) return false;
    return true;
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
fn applyStrikeMoveModifiers(s: *State, ui: u8, path: []const Cell, has_lava: bool) bool {
    const u = &s.units[ui];
    const base = engine.baseCell(u);
    const travelled = if (path.len > 0 and path[0].x == base.x and path[0].y == base.y) path[1..] else path; // travelledMovePath
    if (travelled.len == 0) return false;
    const last = travelled[travelled.len - 1];
    const to = engine.positionForCell(@floatFromInt(last.x), @floatFromInt(last.y));
    engine.applyDistanceMorale(s, ui, .{ u.pos_x, u.pos_y }, to);
    // applyTravelledDistanceModifier (Crusade over the travelled route), then applyLavaWaterModifier (Made of Fire on a
    // lava route).
    if (s.crusade) engine.crusade(u, travelled.len);
    if (s.artifacts) artifacts.lavaRoute(s, ui, has_lava);
    return true;
}

/// handleMeleeAttack's movement prefix: a stationary strike, or (with a client `path`) the walk to `from`. A refusal
/// after the move modifiers keeps their morale change, as in TypeScript.
/// Server mode: whether a path-bearing strike's approach under the provider decides anything differently from runMatch's
/// (the action's own path): the route's presence, its length (Rapid Charge's cells, read only with the card), the
/// travelled count (Crusade, only with the card), the last travelled cell (distance morale), a ground crossing of "B",
/// the lava flag, or with burning cells any cell.
fn approachDiffers(s: *const State, ai: u8, am: server.Approach, path: []const Cell) bool {
    if (path.len == 0) return false; // path-less: server.approach flags the approach the full map accepts
    const r = am.route orelse return false; // unreached: flagged where the missing route refuses the strike (noRoute)
    const u = &s.units[ai];
    const base = engine.baseCell(u);
    if (s.artifacts and am.has_lava != s.action_lava) return true;
    if (server.sameRoute(r, path, base)) return false;
    if (s.fight.n_fire != 0) return true;
    const tr = server.travelledOf(r, base);
    const tp = server.travelledOf(path, base);
    if (r.len != path.len and u.ability(.rapid_charge) != null) return true;
    if (tr.len != tp.len and u.ability(.crusade) != null) return true;
    if (tr.len == 0 or tp.len == 0) return tr.len != tp.len;
    if (tr[tr.len - 1].x != tp[tp.len - 1].x or tr[tr.len - 1].y != tp[tp.len - 1].y) return true;
    return engine.groundRouteCrossesObstacle(s, u, r) != engine.groundRouteCrossesObstacle(s, u, path);
}

fn strikeMovePrefix(s: *State, ai: u8, from: Cell, from_cells: []const Cell, am: server.Approach, stationary: bool) Reject!void {
    const att = &s.units[ai];
    // A stationary strike passes the occupancy checks on the unit's own cells and setPosition writes the same value.
    if (stationary) return;
    // canMove(): the Web lock or Paralysis (attack_not_available).
    if (!att.canMove()) return error.Rejected;
    const route = am.route orelse &.{}; // currentActiveKnownPaths.get(attackFrom key)?.[0]
    const has_route = am.route != null;
    if (engine.isSmall(att)) {
        if (!engine.cellsFreeFor(s, ai, &.{from})) return error.Rejected;
        if (!has_route) return error.Rejected;
        const pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
        if (!applyStrikeMoveModifiers(s, ai, route, am.has_lava)) return error.Rejected;
        if (!engine.occupyCell(s, ai, from)) return error.Rejected;
        att.pos_x = pos[0];
        att.pos_y = pos[1];
        if (s.fight.n_smoke != 0) engine.dispelSmoke(s, ai, &.{from}); // attack_handler.ts:2607
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
    if (!has_route) return error.Rejected; // also one the server's refreshed map cannot reach (am.unreached)
    if (!applyStrikeMoveModifiers(s, ai, route, am.has_lava)) return error.Rejected;
    if (!engine.occupyCells(s, ai, cells.slice())) return error.Rejected;
    att.pos_x = pos[0];
    att.pos_y = pos[1];
    if (s.fight.n_smoke != 0) engine.dispelSmoke(s, ai, cells.slice()); // attack_handler.ts:2607
}

pub fn meleeAttack(s: *State, ai: u8, ti: u8, from: Cell, path: []const Cell, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    if (ti >= s.n_units or !s.units[ti].in_holder) return error.Rejected;
    // resolveKnownPaths: runMatch trusts a path-bearing approach's route; the server asks its provider first (every
    // strike, stationary ones too) and takes the server's route.
    var route_buf: server.RouteBuf = .{};
    const am = if (s.engine_mode == .server) server.approach(s, from, path, s.action_lava, &route_buf) else server.Approach.fromPath(path, s.action_lava);
    if (s.engine_mode == .server and approachDiffers(s, ai, am, path)) s.server_unverified |= server.UNVERIFIED_ROUTE;
    // An approach with a route must not walk a ground body over "B".
    const approaching = !(engine.baseCell(&s.units[ai]).x == from.x and engine.baseCell(&s.units[ai]).y == from.y);
    if (approaching) {
        if (am.route) |r| {
            if (engine.groundRouteCrossesObstacle(s, &s.units[ai], r)) return error.Rejected;
        }
    }

    const att = &s.units[ai];
    const tgt = &s.units[ti];
    if (att.isDead() or tgt.isDead()) return error.Rejected;
    if (att.attack_type_selected != AT.MELEE and att.attack_type_selected != AT.MELEE_MAGIC) return error.Rejected;
    if (att.has(.no_melee) or att.team == tgt.team or engine.cowardBarred(s, att, tgt)) return error.Rejected;
    // An Aggr'd attacker may strike only its live forced target.
    if (forcedTarget(s, att)) |f| {
        if (f != ti) return error.Rejected;
    }
    // Terrifying Gaze bars the gazer; a Hidden (Disguise) target cannot be struck.
    if (s.forbids(att, tgt.uid)) return error.Rejected;
    if (s.disguise and tgt.isHidden()) return error.Rejected;
    const current = engine.baseCell(att);
    const from_cells = engine.cellsForAnchor(from, att.fw, att.fh);
    const tgt_cells = engine.unitCells(tgt);
    if (!adjacent(from_cells.slice(), tgt_cells.slice())) return error.Rejected;
    const stationary = current.x == from.x and current.y == from.y;
    const cells_before = engine.unitCells(att); // the snare on arrival compares the body before and after
    try strikeMovePrefix(s, ai, from, from_cells.slice(), am, stationary);
    // burnAttackerOnFireWalls: the walk in burns before the blow (after the smoke dispel), along the map's route (or the
    // attack-from cell); a stack the flames kill never strikes: the action completes with its cleanup (the melee kill
    // attributions) and completeTurn.
    if (!stationary and s.fight.n_fire != 0) {
        const r = am.route orelse &.{from};
        const travelled = if (r.len > 0 and r[0].x == current.x and r[0].y == current.y) r[1..] else r;
        const landing = engine.unitCells(att);
        var burning: engine.Swept = .{};
        engine.burningCellsEntered(s, ai, cells_before.slice(), travelled, landing.slice(), false, &burning);
        engine.burnOnFire(s, ai, burning.slice());
        if (att.isDead()) {
            const attribution: Attribution = .{
                .v1 = ti,
                .k1 = engine.killerOf(&s.units[ai]),
                .v2 = ai,
                .k2 = engine.killerOf(&s.units[ti]),
            };
            cleanupFireDeath(s, ai, &attribution, events);
            engine.completeTurn(s, ai, false, false, events);
            return;
        }
    }

    // chargedRouteCells: a stationary strike after this turn's move charges that move's route; a path-bearing strike
    // charges its whole route (path.length, origin included); otherwise there are no known paths and no charge.
    var ability_multiplier: f64 = 1;
    var rapid_cells: f64 = 1;
    if (stationary and att.moved_this_turn and att.moved_route_cells > 0) {
        if (s.fight.rc_alt_unit == ai and s.fight.rc_alt_len != att.moved_route_cells) s.server_unverified |= server.UNVERIFIED_ROUTE;
        rapid_cells = att.moved_route_cells;
        ability_multiplier = abilities.rapidCharge(att, rapid_cells);
    } else if (am.defined) {
        // map.get(attackFrom)?.[0]?.route.length ?? 1: the server charges a stationary strike one cell.
        rapid_cells = if (am.route) |r| @floatFromInt(r.len) else 1;
        ability_multiplier = abilities.rapidCharge(att, rapid_cells);
    }
    // Paralysis (the attacker's) cuts after Rapid Charge, before Backstab.
    if (abilities.paralysisFactor(att)) |pf| ability_multiplier *= pf;
    ability_multiplier *= abilities.positionMultiplierOn(att, from, engine.baseCell(tgt), tgt.fw, tgt.fh, s.fight.side_oriented);

    var died: Died = .{};
    var decrease: MoraleDecrease = .{};
    var attacker_plus: f64 = 0;
    var target_plus: f64 = 0;

    const missed = missRoll(s, att, tgt); // M1
    // cleanupAttackModIncrease, then increaseAttackMod(getUnitAuraAttackMod) around the body after the move prefix.
    if (s.war_anger) {
        att.attack_mod = @max(0, att.attack_mod - att.attack_mod_increase);
        engine.increaseAttackMod(att, engine.warAngerMod(s, ai));
    } else att.attack_mod = @max(0, att.attack_mod);
    const damage_from_attack = luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.MELEE, 1, ability_multiplier)) +
        abilities.penetratingBite(att, tgt); // M2: drawn even when a spin replaces the blow

    // Gravechain: one attempted set for the attack's spin, skewer and blow (gravechainAttackTargets).
    var gc_attack: st.UidSet = .{};
    var sweep_hits: SwordHits = .{};
    const sweep = swordList(s, att, &sweep_hits);
    const spin_attack = lightningSpin(s, ai, from, true, ai, rapid_cells, &died, &gc_attack, sweep);
    // The same radial impact knocks down every scattered stone in the spin's ring.
    if (spin_attack) spinStones(s, ai, from);
    if (att.has(.skewer_strike)) {
        skewerStrike(s, ai, ti, from, true, &died, &decrease, &attacker_plus, ai, &gc_attack, sweep);
    }
    // Fireforged Sword over everything the sweeps caught (attack_handler.ts:2793; a missed blow too).
    if (sweep) |w| attacker_plus += swordOnVictims(s, ai, w, &died, &decrease);
    if (att.has(.skewer_strike)) {
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
    var response = meleeResponse(s, ai, ti, from, &died, &decrease, &target_plus);
    var spin_response = response.spin;
    // Predatory Assimilation's response steal: any response that was not missed (once per action).
    var response_landed = response.landed;
    if (!spin_attack and !missed and !tgt.isDead()) {
        const absorbed = damage_from_attack > 0 and abilities.absorbs(s, tgt);
        const blow_dealt = hit(s, ai, ti, damage_from_attack, false); // attack_handler.ts:3214
        engine.markDamageLap(s, blow_dealt);
        // Fireforged Sword (attack_handler.ts:3252): the swing a shield ate still burns; the kill grants no morale.
        _ = swordHit(s, ai, ti, damage_from_attack, &died, &decrease);
        if (!absorbed) {
            meleeRiders(s, ai, ti, damage_from_attack, true, &gc_attack);
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
        response = meleeResponse(s, ai, ti, from, &died, &decrease, &target_plus);
        spin_response = response.spin;
        if (response.landed) response_landed = true;
        const absorbed = punch.damage > 0 and abilities.absorbs(s, tgt);
        if (punch.damage > 0) {
            const punch_dealt = hit(s, ai, ti, punch.damage, false); // attack_handler.ts:3400
            engine.markDamageLap(s, punch_dealt);
        }
        // Fireforged Sword on the second punch (attack_handler.ts:3458; no kill morale).
        if (!punch.missed) _ = swordHit(s, ai, ti, punch.damage, &died, &decrease);
        // No Pegasus Light morale read and no Predatory Assimilation poison after a second punch's riders.
        if (!punch.missed and !absorbed) {
            var gc_punch: st.UidSet = .{}; // the second punch rolls Gravechain with a fresh set
            meleeRiders(s, ai, ti, punch.damage, false, &gc_punch);
        }
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
    // Predatory Assimilation (attack_handler.ts:3565, :3575): the responder steals first, then the attacker (M1 hit).
    if (response_landed) abilities.assimilate(s, ti, ai);
    if (!missed) abilities.assimilate(s, ai, ti);
    engine.refreshStackPowerForAllUnits(s);
    abilities.devourEssence(s, ai, died.items[0..died.len]);
    abilities.devourEssence(s, ti, died.items[0..died.len]);
    // Walking in to strike ends the walk on those cells: an enemy vine there snares the attacker.
    if (s.fight.n_vines != 0) {
        const cells_after = engine.unitCells(att);
        if (!sameCellList(cells_before.slice(), cells_after.slice())) engine.snareOnVineArrival(s, ai, cells_after.slice());
    }

    const attribution: Attribution = .{
        .v1 = ti,
        .k1 = engine.killerOf(&s.units[ai]),
        .v2 = ai,
        .k2 = engine.killerOf(&s.units[ti]),
    };
    cleanupDeadUnits(s, &died, events, &attribution);
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
/// handleMeleeAttack's order: Miner, Stun, Dulling Defense, Petrifying Gaze, Boar Saliva, Aggr, Terrifying Gaze (its
/// roll the blow's last), Deep Wounds, Pegasus Light, Shatter Armor, Venom Cloud poison, and on the blow
/// (`assimilation_poison`) Predatory Assimilation's poison. Rime Charm and Gravechain (`gc`, the exchange's attempted
/// set) roll right after Stun on a second punch and last on the blow.
fn meleeRiders(s: *State, from_i: u8, to_i: u8, damage: f64, assimilation_poison: bool, gc: *st.UidSet) void {
    if (s.units[from_i].ability_mask != 0) {
        abilities.miner(s, from_i, to_i);
        abilities.stun(s, from_i, to_i, from_i);
        abilities.freeze(s, from_i, to_i, from_i);
    }
    // A second punch rolls Rime Charm and Gravechain right after Stun and Freeze (before Aggr); the blow rolls them last.
    if (!assimilation_poison) {
        artifacts.rimeCharm(s, from_i, to_i, from_i);
        artifacts.gravechain(s, from_i, to_i, from_i, gc);
    }
    if (s.units[from_i].ability_mask != 0) {
        abilities.dullingDefense(&s.units[from_i], &s.units[to_i]);
        abilities.petrifyingGaze(s, from_i, to_i, damage, 1);
        abilities.boarSaliva(s, from_i, to_i, from_i);
        abilities.aggr(s, from_i, to_i, from_i);
        abilities.terrifyingGaze(s, from_i, to_i, from_i);
        abilities.deepWounds(s, from_i, to_i, from_i);
        abilities.pegasusLight(s, from_i, to_i, from_i);
        abilities.paralysis(s, from_i, to_i, from_i);
        abilities.shatterArmor(s, from_i, to_i, from_i);
        // Hamstring rides the blow only (not the second punch).
        if (assimilation_poison) abilities.hamstring(s, from_i, to_i, from_i);
    }
    abilities.poisonAura(s, from_i, to_i, damage);
    if (assimilation_poison and s.units[from_i].ability_mask != 0) abilities.assimilationPoison(s, from_i, to_i, damage);
    if (assimilation_poison) {
        artifacts.rimeCharm(s, from_i, to_i, from_i);
        artifacts.gravechain(s, from_i, to_i, from_i, gc);
    }
    // Blindness is the last rider of the blow and of the second punch.
    if (s.units[from_i].ability_mask != 0) abilities.blindness(s, from_i, to_i, from_i);
}

/// canUnitRespondToMelee (src/handlers/melee_response.ts): an Aggr'd target answers only its forced attacker (the raw
/// target id, alive or not), nobody answers a Lightning Spin attacker, a No Melee unit never answers, a Cowardly one
/// not a stronger attacker, and the reply is spent once.
fn canRespondToMelee(s: *const State, att: *const Unit, ai: u8, ti: u8) bool {
    const tgt = &s.units[ti];
    if (abilities.skipsResponse(att)) return false;
    if (tgt.has(.no_melee) or engine.cowardBarred(s, tgt, att)) return false;
    if (tgt.isSkipping()) return false; // canRespond: a Stun or Blindness blocks the reply without spending it
    if (tgt.target >= 0 and tgt.target != @as(i8, @intCast(ai))) return false;
    if (s.forbids(tgt, att.uid)) return false; // a frightened unit never answers its gazer (nothing spent)
    return !tgt.responded and s.fight.replied & engine.unitBit(ti) == 0;
}

const Response = struct { spin: bool = false, landed: bool = false };

/// handleMeleeAttack's captureResponse: the target strikes back once (its reply is spent even on a miss). A
/// responding Pikeman skewers behind the attacker and a responding Hydra spins (whatever the miss roll says);
/// a spin replaces the plain response. Returns whether a response spin landed and whether the response was not
/// missed (Predatory Assimilation's response steal reads it, spinner or not).
fn meleeResponse(s: *State, ai: u8, ti: u8, from: Cell, died: *Died, decrease: *MoraleDecrease, target_plus: *f64) Response {
    const att = &s.units[ai];
    const tgt = &s.units[ti];
    if (tgt.isDead() or !canRespondToMelee(s, att, ai, ti)) return .{};
    const missed = missRoll(s, tgt, att); // M3
    const tgt_base = engine.baseCell(tgt);
    // Gravechain: one attempted set for the response's skewer, spin and blow (gravechainResponseTargets).
    var gc_response: st.UidSet = .{};
    var sweep_hits: SwordHits = .{};
    const sweep = swordList(s, tgt, &sweep_hits);
    if (tgt.ability_mask & st.AbilityId.skewer_strike.bit() != 0) skewerStrike(s, ti, ai, tgt_base, false, died, decrease, target_plus, ai, &gc_response, sweep);
    const spin = lightningSpin(s, ti, tgt_base, false, ai, 1, died, &gc_response, sweep);
    // The responder's Fireforged Sword over its own sweeps (attack_handler.ts:2964).
    if (sweep) |w| target_plus.* += swordOnVictims(s, ti, w, died, decrease);
    if (!missed and !spin and !att.isDead()) {
        var ability_multiplier = abilities.positionMultiplierOn(tgt, tgt_base, from, att.fw, att.fh, s.fight.side_oriented);
        // Paralysis (the responder's) after Backstab.
        if (abilities.paralysisFactor(tgt)) |pf| ability_multiplier *= pf;
        const damage_from_response = luckyStrike(s, tgt, calculateAttackDamage(s, tgt, att, AT.MELEE, 1, ability_multiplier)) +
            abilities.penetratingBite(tgt, att); // M4
        const absorbed = damage_from_response > 0 and abilities.absorbs(s, att);
        const response_dealt = hit(s, ti, ai, damage_from_response, true); // attack_handler.ts:3072: the active attacker's Break extends
        engine.markDamageLap(s, response_dealt);
        // The responder's Fireforged Sword (attack_handler.ts:3085): +4 for a kill.
        target_plus.* += swordHit(s, ti, ai, damage_from_response, died, decrease);
        if (!absorbed) {
            target_plus.* += abilities.pegasusLightMorale(att);
            // The responder's riders: Miner, Stun, Dulling Defense, Petrifying Gaze, Boar Saliva, Aggr, Deep Wounds,
            // Venom Cloud and Predatory Assimilation poison, Pegasus Light (no Terrifying Gaze; Shatter Armor rides only
            // the attacker's blows).
            if (tgt.ability_mask != 0) {
                abilities.miner(s, ti, ai);
                abilities.stun(s, ti, ai, ai);
                abilities.freeze(s, ti, ai, ai);
                abilities.dullingDefense(tgt, att);
                abilities.petrifyingGaze(s, ti, ai, damage_from_response, 1);
                abilities.boarSaliva(s, ti, ai, ai);
                abilities.aggr(s, ti, ai, ai);
                abilities.deepWounds(s, ti, ai, ai);
            }
            abilities.poisonAura(s, ti, ai, damage_from_response);
            if (tgt.ability_mask != 0) {
                abilities.assimilationPoison(s, ti, ai, damage_from_response);
                abilities.pegasusLight(s, ti, ai, ai);
                abilities.paralysis(s, ti, ai, ai);
            }
            artifacts.rimeCharm(s, ti, ai, ai);
            artifacts.gravechain(s, ti, ai, ai, &gc_response);
            if (tgt.ability_mask != 0) abilities.blindness(s, ti, ai, ai);
        }
    }
    spendReply(s, ti);
    return .{ .spin = spin, .landed = !missed };
}

const Punch = struct { applied: bool = false, missed: bool = false, damage: f64 = 0, morale: f64 = 0 };

/// processDoublePunchAbility: a second strike with its own miss roll (an Aggr'd puncher only at its forced target).
fn doublePunch(s: *State, ai: u8, ti: u8) Punch {
    const att = &s.units[ai];
    const tgt = &s.units[ti];
    // getAbility("Double Punch") ?? getAbility("Crafted Double Punch")
    const a = att.ability(.double_punch) orelse att.ability(.crafted_double_punch) orelse return .{};
    if (att.isDead() or att.isSkipping() or tgt.isDead()) return .{}; // a stunned, blinded or frozen puncher (isSkippingThisTurn) stops
    if (att.target >= 0 and att.target != @as(i8, @intCast(ti))) return .{};
    if (missRoll(s, att, tgt)) return .{ .applied = true, .missed = true };
    // withDualStrikeCharm: the Dual Strike Charm's +power % on the second punch only.
    var ability_multiplier = if (s.artifacts) artifacts.dualStrike(att, abilities.abilityMultiplier(att, a)) else abilities.abilityMultiplier(att, a);
    // Paralysis (the puncher's: a response may just have landed it) after the Dual Strike Charm.
    if (abilities.paralysisFactor(att)) |pf| ability_multiplier *= pf;
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
fn lightningSpin(s: *State, from_i: u8, first: Cell, is_attack: bool, active_i: u8, rapid_cells: f64, died: *Died, gc: *st.UidSet, sweep: ?*SwordHits) bool {
    const from = &s.units[from_i];
    const a = from.ability(.lightning_spin) orelse return false; // none while Broken
    var around: engine.UnitList = undefined;
    enemiesAround(s, from_i, first, &around); // no Flesh Shield owners in scope
    // A unit Terrifying Gaze forbids the spinner to attack is left out of the ring.
    var ring: engine.UnitList = .{};
    for (around.slice()) |e| {
        if (!s.forbids(from, s.units[e].uid)) ring.push(e);
    }
    const common = abilities.rapidCharge(from, rapid_cells);
    var dead: Died = .{};
    var morale: f64 = 0;
    var decrease: MoraleDecrease = .{};
    for (ring.slice()) |ei| {
        const enemy = &s.units[ei];
        if (enemy.isDead()) continue;
        const missed = missRoll(s, from, enemy);
        // A Cowardly spinner skips a stronger enemy after its miss roll.
        if (engine.cowardBarred(s, from, enemy)) continue;
        if (missed) continue;
        var ability_multiplier = abilities.abilityMultiplier(from, a) * common;
        // Paralysis (the spinner's), before the Deep Wounds fold.
        if (abilities.paralysisFactor(from)) |pf| ability_multiplier *= pf;
        // Deep Wounds is folded in here AND in the damage chain: the spin squares it.
        if (enemy.effects.len != 0) {
            if (enemy.effects.get(.deep_wounds)) |dw| {
                if (abilities.holdsDeepWounds(from)) ability_multiplier *= 1 + dw.power / 100;
            }
        }
        var damage = luckyStrike(s, from, calculateAttackDamage(s, from, enemy, AT.MELEE, 1, ability_multiplier)) +
            abilities.penetratingBite(from, enemy);
        // Giant's Maul (the striker's), then getPhysicalAoeDamageMultiplier (the victim's Amulet of Resolve, Mechanism).
        if (s.artifacts) damage = artifacts.giantsMaul(from, damage);
        damage = @floor(damage * physicalAoeMultiplier(s, enemy));
        const absorbed = damage > 0 and abilities.absorbs(s, enemy);
        const dealt = hit(s, from_i, ei, damage, false); // lightning_spin_ability.ts:239
        if (sweep) |w| w.push(ei, dealt, damage, absorbed);
        abilities.poisonAura(s, from_i, ei, dealt);
        engine.markDamageLap(s, dealt);
        if (!absorbed) morale += abilities.pegasusLightMorale(enemy);
        // Gravechain rolls off every unabsorbed sub-hit, a killing one included, before the death check.
        if (!absorbed) artifacts.gravechain(s, from_i, ei, active_i, gc);
        if (enemy.isDead()) {
            dead.push(ei);
        } else if (!absorbed) {
            abilities.miner(s, from_i, ei);
            abilities.stun(s, from_i, ei, active_i);
            abilities.freeze(s, from_i, ei, active_i);
            artifacts.rimeCharm(s, from_i, ei, active_i);
            abilities.dullingDefense(from, enemy);
            abilities.petrifyingGaze(s, from_i, ei, damage, 1);
            abilities.boarSaliva(s, from_i, ei, active_i);
            abilities.aggr(s, from_i, ei, active_i);
            abilities.deepWounds(s, from_i, ei, active_i);
            abilities.pegasusLight(s, from_i, ei, active_i);
            abilities.paralysis(s, from_i, ei, active_i);
            if (is_attack) abilities.shatterArmor(s, from_i, ei, active_i) else abilities.blindness(s, from_i, ei, active_i);
            if (enemy.isDead()) dead.push(ei); // a Petrifying Gaze kill
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
/// past a 1x1 target, the enemy on the cell straight behind it (pierceSweepCells: as seen from `from_cell`, the
/// striker's anchor, or for a large striker from its body cell closest to the target) takes a hit with its own miss
/// and damage rolls (no Lucky Strike, no response). Kills and morale go to the caller's bookkeeping.
fn skewerStrike(s: *State, from_i: u8, to_i: u8, from_cell: Cell, is_attack: bool, died: *Died, decrease: *MoraleDecrease, plus: *f64, active_i: u8, gc: *st.UidSet, sweep: ?*SwordHits) void {
    const from = &s.units[from_i];
    if (!from.has(.skewer_strike)) return;
    const to = &s.units[to_i];
    if (!engine.isSmall(to)) return;
    const tb = engine.baseCell(to);
    const a = closestBodyCell(from, from_cell, tb);
    const c = Cell{ .x = tb.x + (tb.x - a.x), .y = tb.y + (tb.y - a.y) };
    if (!engine.cellWithinGrid(c)) return;
    const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
    if (!st.isUnitCode(o)) return; // a stone behind the target is broken by the caller, not skewered
    const vi: u8 = o - 1;
    const next = &s.units[vi];
    if (!next.in_holder or vi == from_i or vi == to_i or next.team == from.team) return;
    strikeSkewerTarget(s, from_i, vi, is_attack, died, decrease, plus, active_i, gc, sweep);
}

/// strikeSkewerTargets for one chosen victim: its miss roll and damage roll (no Lucky Strike, no response), the
/// riders of a landed unabsorbed hit, and the kill's bookkeeping in the caller's lists.
fn strikeSkewerTarget(s: *State, from_i: u8, vi: u8, is_attack: bool, died: *Died, decrease: *MoraleDecrease, plus: *f64, active_i: u8, gc: *st.UidSet, sweep: ?*SwordHits) void {
    const from = &s.units[from_i];
    const a = from.ability(.skewer_strike) orelse return;
    const next = &s.units[vi];
    if (next.isDead()) return;
    if (missRoll(s, from, next)) return; // S1
    var damage = calculateAttackDamage(s, from, next, AT.MELEE, 1, abilities.abilityMultiplier(from, a)); // S2
    // Giant's Maul (the striker's), then getPhysicalAoeDamageMultiplier (the victim's Amulet of Resolve, Mechanism).
    if (s.artifacts) damage = artifacts.giantsMaul(from, damage);
    damage = @floor(damage * physicalAoeMultiplier(s, next));
    const absorbed = damage > 0 and abilities.absorbs(s, next);
    const dealt = hit(s, from_i, vi, damage, false); // skewer_strike_ability.ts:210
    if (sweep) |w| w.push(vi, dealt, damage, absorbed);
    engine.markDamageLap(s, dealt);
    // Gravechain rolls off an unabsorbed skewer hit (the active unit's set), a killing one included.
    if (!absorbed) artifacts.gravechain(s, from_i, vi, active_i, gc);
    if (!next.isDead() and !absorbed) {
        abilities.poisonAura(s, from_i, vi, dealt);
        abilities.miner(s, from_i, vi);
        abilities.stun(s, from_i, vi, from_i);
        abilities.freeze(s, from_i, vi, from_i);
        artifacts.rimeCharm(s, from_i, vi, null); // the skewer passes no active unit: never extended
        abilities.dullingDefense(from, next);
        abilities.petrifyingGaze(s, from_i, vi, damage, 1);
        abilities.boarSaliva(s, from_i, vi, from_i);
        abilities.aggr(s, from_i, vi, from_i); // A3
        abilities.deepWounds(s, from_i, vi, from_i);
        abilities.pegasusLight(s, from_i, vi, from_i);
        abilities.paralysis(s, from_i, vi, from_i); // the skewer's own damage is never cut
        if (is_attack) abilities.shatterArmor(s, from_i, vi, from_i) else abilities.blindness(s, from_i, vi, from_i);
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

pub const RayHit = struct { cell: Cell, x: f64, y: f64 };

pub const Ray = struct {
    items: [64]RayHit = undefined,
    len: usize = 0,
};

/// traceGridRayCells: every cell the segment crosses, with the first pixel in it.
pub fn traceRay(sx_in: f64, sy_in: f64, ex_in: f64, ey_in: f64) Ray {
    var ray: Ray = undefined;
    traceRayInto(&ray, sx_in, sy_in, ex_in, ey_in);
    return ray;
}

/// traceRay into `ray` (the hot callers' form: a 1.5 KB Ray built by value was stored blank, then copied out).
pub fn traceRayInto(ray: *Ray, sx_in: f64, sy_in: f64, ex_in: f64, ey_in: f64) void {
    ray.len = 0;
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
        return;
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

/// AttackHandler.getRangeAttackDivisor (an active Sniper or Farsight Quiver skips the bands).
fn rangeDivisor(att: *const Unit, hx: f64, hy: f64, ax: f64, ay: f64) f64 {
    if (att.ability_mask & st.AbilityId.sniper.bit() != 0 and att.has(.sniper)) return 1;
    var divisor: f64 = 1;
    const band = if (att.shot_distance > 0 and std.math.isFinite(att.shot_distance)) @floor(att.shot_distance) else 0;
    // Farsight Quiver (the shooter's marker buff) skips the falloff bands.
    if (band > 0 and !artifacts.farsight(att)) {
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
    return evaluateRangeFlags(s, from_ui, fx, fy, tx, ty, false, false);
}

/// evaluateRange's primaries with the ray flags: `through` carries the ray to the field edge (Through Shot), `splash` lets
/// it pass stones (Large Caliber / Area Throw); the rings of a splash group are left out (see evaluateGroups).
pub fn evaluateRangeFlags(s: *const State, from_ui: u8, fx: f64, fy: f64, tx_in: f64, ty_in: f64, through: bool, splash: bool) Hits {
    var hits: Hits = .{};
    const from = &s.units[from_ui];
    const end = if (through) projectLineToFieldEdge(fx, fy, tx_in, ty_in) else [2]f64{ tx_in, ty_in };
    var ray: Ray = undefined;
    traceRayInto(&ray, fx, fy, end[0], end[1]);
    var smoked = false; // pathCrossedSmoke: sticky for the rest of the ray
    for (ray.items[0..ray.len]) |h| {
        if (!engine.cellWithinGrid(h.cell)) continue;
        if (!smoked and s.fight.hasSmoke(h.cell.x, h.cell.y)) smoked = true;
        const o = s.grid.board[@intCast(h.cell.x)][@intCast(h.cell.y)];
        if (o == st.BLOCK and !splash) break; // the ray stops at the first mountain or stone (attackObstacle)
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
        const divisor = rangeDivisor(from, h.x, h.y, fx, fy);
        hits.divisors[hits.len] = if (smoked) @min(8, divisor * 2) else divisor;
        hits.len += 1;
        if (through and wingshieldOwner(u)) break; // a Through Shot's ray ends with an Arrows Wingshield owner
    }
    return hits;
}

/// isRangeAttackSideObservable: the neighbour across that side is empty, a hole, lava, off the board, or the shooter's
/// own team (a mountain or stone hides it).
pub fn sideObservable(s: *const State, cell: Cell, side: u8, from_team: u8) bool {
    return sideObservableEx(s, cell, side, from_team, false, false);
}

/// isRangeAttackSideObservable(..., isThroughShot, ignoresStructures): a shot that ignores structures (Large Caliber,
/// Area Throw) may face a stone; a Through Shot sees past every unit (only a stone hides a side).
pub fn sideObservableEx(s: *const State, cell: Cell, side: u8, from_team: u8, through: bool, ignores: bool) bool {
    const n: Cell = switch (side) {
        0 => .{ .x = cell.x - 1, .y = cell.y },
        1 => .{ .x = cell.x + 1, .y = cell.y },
        2 => .{ .x = cell.x, .y = cell.y - 1 },
        else => .{ .x = cell.x, .y = cell.y + 1 },
    };
    if (!engine.cellWithinGrid(n)) return true;
    const o = s.grid.board[@intCast(n.x)][@intCast(n.y)];
    if (o == st.BLOCK) return ignores;
    if (through or !st.isUnitCode(o)) return true;
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
/// (first wins ties; order = target cells x [LEFT, RIGHT, DOWN, UP]), with the shooter's Through Shot and Large Caliber
/// / Area Throw flags.
pub fn aimEdge(s: *const State, att: *const Unit, tgt: *const Unit, aim_cell: ?Cell, aim_side: u8) ?[2]f64 {
    const cells = engine.unitCells(tgt);
    const through = att.has(.through_shot);
    const ignores = isSplashShooter(att);
    if (aim_cell) |ac| {
        for (cells.slice()) |c| {
            if (c.x == ac.x and c.y == ac.y and aim_side < 4 and sideObservableEx(s, c, aim_side, att.team, through, ignores)) {
                return sideCenter(c, aim_side, att.pos_x, att.pos_y);
            }
        }
    }
    var best: ?[2]f64 = null;
    var best_d: f64 = 0;
    for (cells.slice()) |c| {
        for ([_]u8{ 0, 1, 2, 3 }) |side| {
            if (!sideObservableEx(s, c, side, att.team, through, ignores)) continue;
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

/// getAffectedUnitsAndObstacles' groups as the engine reads them: per enemy the ray meets (in ray order) its members
/// (the enemy, then for a Large Caliber / Area Throw shooter every living unit of either team on the ring around the
/// cell the ray entered it, ring order, each body once), its divisor and its entry cell; the blast cells a splash shot
/// clears stones in (every group's ring, then its entry cell); and the first stone a ray that stops at stones met.
/// About 1.2 KB: declare it `undefined` and fill it in place (`evaluateGroups`, `reset`); a default value or a returned
/// copy cost a store and a copy of the whole struct on every shot (5% of the engine replay).
pub const Groups = struct {
    n: u8 = 0,
    divisors: [st.MAX_UNITS]f64 = undefined,
    start: [st.MAX_UNITS + 1]u8 = undefined,
    members: [MAX_MEMBERS]u8 = undefined,
    n_members: u8 = 0,
    entry: [st.MAX_UNITS]Cell = undefined,
    cells: [MAX_BLAST_CELLS]Cell = undefined,
    n_cells: u16 = 0,
    obstacle: ?[2]f64 = null,

    /// No groups, no blast, no stone (the arrays stay as they are).
    pub inline fn reset(self: *Groups) void {
        self.n = 0;
        self.n_members = 0;
        self.n_cells = 0;
        self.obstacle = null;
        self.start[0] = 0;
    }
    pub inline fn group(self: *const Groups, k: usize) []const u8 {
        return self.members[self.start[k]..self.start[k + 1]];
    }
    pub inline fn first(self: *const Groups, k: usize) u8 {
        return self.members[self.start[k]];
    }
};

pub const MAX_MEMBERS = 160;
const MAX_BLAST_CELLS = 320;

/// isRangeAttackSideObservable's and evaluateRangeAttack's `ignoresStructures` / `isAOEShot`: an active Large Caliber
/// or Area Throw (Break-aware).
pub inline fn isSplashShooter(u: *const Unit) bool {
    return u.ability_mask & (st.AbilityId.large_caliber.bit() | st.AbilityId.area_throw.bit()) != 0 and (u.has(.large_caliber) or u.has(.area_throw));
}

/// processRangeAOEAbility's ability: Area Throw, else Large Caliber, else Chakram (getAbility, Break-aware).
fn aoeAbility(u: *const Unit) ?*const st.Ability {
    if (u.ability_mask & (st.AbilityId.area_throw.bit() | st.AbilityId.large_caliber.bit() | st.AbilityId.chakram.bit()) == 0) return null;
    return u.ability(.area_throw) orelse u.ability(.large_caliber) orelse u.ability(.chakram);
}

/// getDoubleShotAbility: the first active of Double Shot, Crafted Double Shot and Double Throw.
pub fn doubleShotAbility(u: *const Unit) ?*const st.Ability {
    if (u.ability_mask & (st.AbilityId.double_shot.bit() | st.AbilityId.crafted_double_shot.bit() | st.AbilityId.double_throw.bit()) == 0) return null;
    return u.ability(.double_shot) orelse u.ability(.crafted_double_shot) orelse u.ability(.double_throw);
}

/// Unit.getPhysicalAoeDamageMultiplier: max(0, 1 - (status resist (Amulet of Resolve) - 50 on an active Mechanism) / 100).
pub inline fn physicalAoeMultiplier(s: *const State, u: *const Unit) f64 {
    const mechanism: f64 = if (u.ability_mask & st.AbilityId.mechanism.bit() != 0 and u.has(.mechanism)) 50 else 0;
    return @max(0, 1 - (artifacts.statusResist(s, u) - mechanism) / 100);
}

/// getCellsAroundCell (grid_math.ts): the ring around a cell, on the board, in the legacy corner order.
fn cellsAroundCell(c: Cell) spells.Cells {
    var out: spells.Cells = .{};
    spells.cellsAroundCell(c, &out);
    return out;
}

/// `Math.min(a, b)` for non-NaN values: -0 wins over +0.
inline fn jsMin(a: f64, b: f64) f64 {
    if (a < b) return a;
    if (b < a) return b;
    return if (std.math.signbit(a)) a else b;
}

/// GridMath.projectLineToFieldEdge: the line from (x0, y0) through (x1, y1) carried on to the first field edge.
pub fn projectLineToFieldEdge(x0: f64, y0: f64, x1: f64, y1: f64) [2]f64 {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const sx = if (dx != 0) js.max((engine.MIN_X - x1) / dx, (engine.MAX_X - x1) / dx) else INF;
    const sy = if (dy != 0) js.max((engine.MIN_Y - y1) / dy, (engine.MAX_Y - y1) / dy) else INF;
    const scalar = jsMin(sx, sy);
    const x = x1 + dx * scalar;
    const y = y1 + dy * scalar;
    return .{ js.max(engine.MIN_X, jsMin(engine.MAX_X, x)), js.max(engine.MIN_Y, jsMin(engine.MAX_Y, y)) };
}

/// evaluateRangeAttack(..., isThroughShot, false, isAOEShot) as the engine resolves it: `through` carries the ray to the
/// field edge, `splash` lets it pass stones; rings come with the shooter's Large Caliber / Area Throw. Fills `g`.
pub fn evaluateGroups(g: *Groups, s: *const State, from_ui: u8, fx: f64, fy: f64, tx: f64, ty: f64, through: bool, splash: bool) void {
    g.reset();
    const from = &s.units[from_ui];
    const end = if (through) projectLineToFieldEdge(fx, fy, tx, ty) else [2]f64{ tx, ty };
    var ray: Ray = undefined;
    traceRayInto(&ray, fx, fy, end[0], end[1]);
    const rings = isSplashShooter(from);
    var primaries: st.UnitSet = 0;
    var smoked = false; // pathCrossedSmoke: sticky for the rest of the ray, read before the stone break
    for (ray.items[0..ray.len]) |h| {
        if (!engine.cellWithinGrid(h.cell)) continue;
        if (!smoked and s.fight.hasSmoke(h.cell.x, h.cell.y)) smoked = true;
        const o = s.grid.board[@intCast(h.cell.x)][@intCast(h.cell.y)];
        if (o == st.BLOCK and !splash) {
            g.obstacle = .{ h.x, h.y };
            break;
        }
        if (!st.isUnitCode(o)) continue; // empty, a hole, a stone (a splash ray), lava
        const ui: u8 = o - 1;
        if (ui == from_ui or primaries & engine.unitBit(ui) != 0) continue;
        const u = &s.units[ui];
        if (!u.in_holder or u.isDead() or u.team == from.team) continue;
        primaries |= engine.unitBit(ui);
        const begin = g.n_members;
        g.members[g.n_members] = ui;
        g.n_members += 1;
        // An Arrows Wingshield owner takes the shot alone: no splash ring (its blast is its own cell), and a Through
        // Shot's ray ends with it.
        const owner = wingshieldOwner(u);
        if (rings and owner) {
            g.cells[g.n_cells] = h.cell;
            g.n_cells += 1;
        } else if (rings) {
            const ring = cellsAroundCell(h.cell);
            for (ring.slice()) |c| {
                const ro = s.grid.board[@intCast(c.x)][@intCast(c.y)];
                if (!st.isUnitCode(ro)) continue;
                const vi: u8 = ro - 1;
                if (std.mem.indexOfScalar(u8, g.members[begin..g.n_members], vi) != null) continue;
                const v = &s.units[vi];
                if (!v.in_holder or v.isDead()) continue;
                g.members[g.n_members] = vi;
                g.n_members += 1;
            }
            for (ring.slice()) |c| {
                g.cells[g.n_cells] = c;
                g.n_cells += 1;
            }
            g.cells[g.n_cells] = h.cell;
            g.n_cells += 1;
        }
        // A ray that crossed smoke at or before this group halves its damage: the divisor doubles, capped at 8.
        const divisor = rangeDivisor(from, h.x, h.y, fx, fy);
        g.divisors[g.n] = if (smoked) @min(8, divisor * 2) else divisor;
        g.entry[g.n] = h.cell;
        g.n += 1;
        g.start[g.n] = g.n_members;
        if (through and owner) break;
    }
}

/// hasAbilityActive("Arrows Wingshield Blessing") on a victim (Break-aware): immune to being shot through, and it does
/// not propagate ranged area damage (Through Shot, the splashes, the area throw, the Chakram).
pub inline fn wingshieldOwner(u: *const Unit) bool {
    return u.ability_mask & st.AbilityId.arrows_wingshield_blessing.bit() != 0 and u.has(.arrows_wingshield_blessing);
}

/// Grid.clearScatteredMountainsInCells over a splash ray's blast cells.
fn clearStones(s: *State, g: *const Groups) void {
    for (g.cells[0..g.n_cells]) |c| _ = terrain.clearScatteredMountainAt(s, c);
}

/// getObstacleIntersections(...).slice(0, out.len): the first stone cells on the whole segment, past units.
fn obstacleIntersections(s: *const State, fx: f64, fy: f64, tx: f64, ty: f64, out: []Cell) usize {
    var n: usize = 0;
    var ray: Ray = undefined;
    traceRayInto(&ray, fx, fy, tx, ty);
    for (ray.items[0..ray.len]) |h| {
        if (n >= out.len) break;
        if (!engine.cellWithinGrid(h.cell) or s.grid.board[@intCast(h.cell.x)][@intCast(h.cell.y)] != st.BLOCK) continue;
        out[n] = h.cell;
        n += 1;
    }
    return n;
}

pub fn rangeAttack(s: *State, ai: u8, ti: u8, aim_cell: ?Cell, aim_side: u8, events: *Events) Reject!void {
    return shoot(s, ai, ti, null, aim_cell, aim_side, events);
}

/// A Through Shot aimed at a free world point (`range_attack` with `targetPosition` and no target id).
pub fn freeAimAttack(s: *State, ai: u8, tx: f64, ty: f64, events: *Events) Reject!void {
    return shoot(s, ai, 0, .{ tx, ty }, null, 0, events);
}

/// GameActionEngine.rangeAttack: the turn checks, the declared target (or the free aim of a Through Shot holder), the
/// Range Null Field / Rangebane refusal, the aim edge, the ray (Through Shot to the field edge; a splash ray through
/// stones, its groups with their rings), a free shot that met no enemy (a stone on its line takes a ranged obstacle shot,
/// else one arrow flies into nothing), the Double Shot stone rule (scattered boards: the first two stones on the line
/// take the two projectiles), the counter-shot pre-check with the primary's own flags, resolveShot, then the stones in a
/// splash shot's blast (and in a thrown splash counter's), the cleanup with the kill attributions (the primary by the
/// shooter, the counter-shot's victim by the primary) and completeTurn.
fn shoot(s: *State, ai: u8, ti: u8, free: ?[2]f64, aim_cell: ?Cell, aim_side: u8, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    const att = &s.units[ai];
    if (att.moved_this_turn) return error.Rejected;
    if (free) |p| {
        if (!att.has(.through_shot)) return error.Rejected;
        if (!std.math.isFinite(p[0]) or !std.math.isFinite(p[1]) or !engine.positionWithinGrid(p[0], p[1]) or
            (p[0] == att.pos_x and p[1] == att.pos_y)) return error.Rejected;
    } else {
        if (ti >= s.n_units) return error.Rejected;
        const declared = &s.units[ti];
        if (!declared.in_holder or declared.isDead()) return error.Rejected;
    }
    if (engine.nullFielded(s, att) or engine.rangebaned(s, att)) return error.Rejected;
    const through = att.has(.through_shot);
    const splash = isSplashShooter(att);
    const to: [2]f64 = if (free) |p| p else (aimEdge(s, att, &s.units[ti], aim_cell, aim_side) orelse return error.Rejected);
    var g: Groups = undefined;
    evaluateGroups(&g, s, ai, att.pos_x, att.pos_y, to[0], to[1], through, splash);
    if (free != null and g.n == 0) {
        if (!engine.canLandRangeAttack(s, att)) return error.Rejected;
        if (forcedTarget(s, att) != null) return error.Rejected;
        if (g.obstacle) |o| return obstacleAttackAt(s, ai, o[0], o[1], null, &.{}, events);
        spendShot(att); // decreaseNumberOfShots: no refresh
        engine.completeTurn(s, ai, false, false, events);
        return;
    }
    // The Double Shot stone rule (a splash shooter ignores structures and skips it).
    var suppress_double = false;
    if (terrain.hasScatteredMountains(s) and !splash and doubleShotAbility(att) != null) {
        var stones: [2]Cell = undefined;
        const n = obstacleIntersections(s, att.pos_x, att.pos_y, to[0], to[1], &stones);
        if (n > 0) {
            if (!engine.canLandRangeAttack(s, att)) return error.Rejected;
            var cleared: u8 = 0;
            for (stones[0..n]) |c| {
                if (terrain.clearScatteredMountainAt(s, c)) cleared += 1;
            }
            if (cleared >= 2) {
                spendShot(att); // both projectiles on stones: one arrow, no roll
                engine.refreshStackPowerForAllUnits(s);
                engine.completeTurn(s, ai, false, false, events);
                return;
            }
            evaluateGroups(&g, s, ai, att.pos_x, att.pos_y, to[0], to[1], through, splash);
            suppress_double = true;
        }
    }
    // The counter-shot pre-check: the actual primary (the ray's first group), with its own ray flags.
    var resp: Groups = undefined;
    var have_resp = false;
    var resp_blast = false;
    var resp_div: f64 = 1;
    if (g.n > 0) {
        const pi = g.first(0);
        const pu = &s.units[pi];
        if (engine.isRangeCapable(pu) and engine.getRangeShots(pu) > 0 and !engine.nullFielded(s, pu) and !engine.rangebaned(s, pu) and !pinnedByMelee(s, pu)) {
            resp_blast = isSplashShooter(pu);
            evaluateGroups(&resp, s, pi, pu.pos_x, pu.pos_y, att.pos_x, att.pos_y, pu.has(.through_shot), resp_blast);
            if (resp.n > 0) {
                resp_div = resp.divisors[0];
                have_resp = true;
            }
        }
    }

    var died: Died = .{};
    var out: Outcome = .{};
    // Quiver of Echoes: the chance is read before the shot (handleRangeAttack).
    const echo_chance = artifacts.echoChance(s, att);
    if (!resolveShot(s, ai, &g, if (have_resp) resp.group(0) else null, resp_div, to, false, suppress_double, &died, &out)) return error.Rejected;
    if (echo_chance > 0) echo(s, ai, &g, &out, to, false, echo_chance, &died);
    if (terrain.hasScatteredMountains(s)) {
        if (splash) clearStones(s, &g);
        if (out.response_thrown and resp_blast) clearStones(s, &resp);
    }
    const primary = g.first(0);
    const attribution: Attribution = .{
        .v1 = primary,
        .k1 = engine.killerOf(&s.units[ai]),
        .v2 = if (have_resp) resp.first(0) else engine.NO_SLOT,
        .k2 = engine.killerOf(&s.units[primary]),
    };
    cleanupDeadUnits(s, &died, events, &attribution);
    engine.completeTurn(s, ai, false, false, events);
}

/// GameActionEngine.areaThrowAttack: the turn checks, an active Area Throw with RANGE selected and arrows left, a cell
/// on the board that is empty, lava or (on a scattered board) a stone; then areaStrikeAtCell.
pub fn areaThrowAttack(s: *State, ai: u8, cell: Cell, events: *Events) Reject!void {
    try engine.validateTurnAction(s, ai);
    const att = &s.units[ai];
    if (att.moved_this_turn) return error.Rejected;
    if (!att.has(.area_throw) or att.attack_type_selected != AT.RANGE or engine.getRangeShots(att) <= 0 or !engine.cellWithinGrid(cell)) return error.Rejected;
    const o = s.grid.board[@intCast(cell.x)][@intCast(cell.y)];
    if (o != st.EMPTY and o != st.LAVA and !(o == st.BLOCK and terrain.hasScatteredMountains(s))) return error.Rejected;
    return areaStrikeAtCell(s, ai, cell, events);
}

/// GameActionEngine.areaStrikeAtCell: the blast lands on the cell where the splash ray to the aimed cell first enters
/// an enemy (projectAreaThrowTargetCell), else on the aimed cell; every unit on its 3x3 (ring order, the centre last;
/// either team, the thrower too) is the list resolveShot throws at as an AOE (no counter-shot), with the divisor to the
/// centre. Then every stone in the 3x3 goes, a throw that caught no unit but broke a stone costs one arrow, and the
/// thrower's enemies in the list are its kills for Infest.
fn areaStrikeAtCell(s: *State, ai: u8, aimed: Cell, events: *Events) Reject!void {
    const att = &s.units[ai];
    const aim_pos = engine.positionForCell(@floatFromInt(aimed.x), @floatFromInt(aimed.y));
    var proj: Groups = undefined;
    evaluateGroups(&proj, s, ai, att.pos_x, att.pos_y, aim_pos[0], aim_pos[1], false, true);
    const target = if (proj.n > 0) proj.entry[0] else aimed;
    const pos = engine.positionForCell(@floatFromInt(target.x), @floatFromInt(target.y));
    var cells: [9]Cell = undefined;
    const ring = cellsAroundCell(target);
    for (ring.slice(), 0..) |c, k| cells[k] = c;
    cells[ring.len] = target;
    const n_cells: usize = ring.len + 1;
    // evaluateAffectedUnits: each unit once, in cell order, alive or not; when Arrows Wingshield owners stand in the 3x3
    // (a ranged area attack), only they are caught.
    var list: [9]u8 = undefined;
    var n: usize = 0;
    var owners: usize = 0;
    for (cells[0..n_cells]) |c| {
        const o = s.grid.board[@intCast(c.x)][@intCast(c.y)];
        if (!st.isUnitCode(o)) continue;
        const ui: u8 = o - 1;
        if (std.mem.indexOfScalar(u8, list[0..n], ui) != null) continue;
        list[n] = ui;
        n += 1;
        if (wingshieldOwner(&s.units[ui])) owners += 1;
    }
    if (owners != 0) {
        var w: usize = 0;
        for (list[0..n]) |ui| {
            if (!wingshieldOwner(&s.units[ui])) continue;
            list[w] = ui;
            w += 1;
        }
        n = w;
    }
    const divisor = rangeDivisor(att, pos[0], pos[1], att.pos_x, att.pos_y);
    var g: Groups = undefined;
    g.reset();
    if (n > 0) {
        for (0..2) |_| {
            for (list[0..n]) |ui| {
                g.members[g.n_members] = ui;
                g.n_members += 1;
            }
            g.divisors[g.n] = divisor;
            g.entry[g.n] = target;
            g.n += 1;
            g.start[g.n] = g.n_members;
        }
    }
    var died: Died = .{};
    var out: Outcome = .{};
    const echo_chance = artifacts.echoChance(s, att);
    if (!resolveShot(s, ai, &g, null, 1, pos, true, false, &died, &out)) return error.Rejected;
    if (echo_chance > 0) echo(s, ai, &g, &out, pos, true, echo_chance, &died);
    var cleared: u32 = 0;
    if (terrain.hasScatteredMountains(s)) {
        for (cells[0..n_cells]) |c| {
            if (terrain.clearScatteredMountainAt(s, c)) cleared += 1;
        }
    }
    if (n == 0 and cleared > 0) spendShot(att);
    var attribution: Attribution = .{ .k1 = engine.killerOf(att) };
    for (list[0..n]) |ui| {
        if (s.units[ui].team != att.team) attribution.area |= engine.unitBit(ui);
    }
    cleanupDeadUnits(s, &died, events, &attribution);
    engine.completeTurn(s, ai, false, false, events);
}

const Outcome = struct {
    /// The counter-shot flew (its animation from the primary exists): a splash responder's blast clears its stones.
    response_thrown: bool = false,
    /// targetUnits[0] after the Chakram grew it in place (attack_handler.ts ~1424): group 0, then the bounce victims it
    /// did not hold, up to the first dodge. Set only when a Chakram flew (head_len 0 otherwise); Quiver of Echoes' volley
    /// aims at its survivors.
    head: [st.MAX_UNITS]u8 = undefined,
    head_len: u8 = 0,
};

/// resolveRangeAttack's finalizeRangeAttack: Predatory Assimilation's response steal (the primary robs the counter-shot's
/// victim), then the attacker's (a shot that landed robs the initial primary), once.
const Fin = struct {
    done: bool = false,
    initial: u8,
    response: ?u8 = null,
    primary_landed: bool = false,

    fn run(self: *Fin, s: *State, ai: u8) void {
        if (self.done) return;
        self.done = true;
        if (self.response) |r| abilities.assimilate(s, self.initial, r);
        if (self.primary_landed) abilities.assimilate(s, ai, self.initial);
    }
};

/// recordPrimaryTargetDeath: a dead target joins `died` once with the attacker's +4 and its same-name decrease.
fn recordDeath(s: *State, target_ui: u8, died: *Died, plus: *f64, decrease: *MoraleDecrease) bool {
    const t = &s.units[target_ui];
    if (!t.isDead()) return false;
    if (!died.includes(target_ui)) {
        died.push(target_ui);
        plus.* += engine.MORALE_CHANGE_FOR_KILL;
        decrease.add(t, engine.MORALE_CHANGE_FOR_KILL);
    }
    return true;
}

/// AttackHandler.resolveRangeAttack (no artifacts, smoke, Flesh Shield or Paralysis in scope) over the ray groups `g`
/// (an AOE throw: its 3x3 list twice) and the counter-shot's group `resp_units`. Returns `completed`.
fn resolveShot(s: *State, ai: u8, g: *const Groups, resp_units: ?[]const u8, resp_div: f64, to: [2]f64, is_aoe: bool, suppress_double: bool, died: *Died, out: *Outcome) bool {
    const att = &s.units[ai];
    if (att.isDead() or (g.n == 0 and !is_aoe) or att.attack_type_selected != AT.RANGE or !engine.canLandRangeAttack(s, att)) return false;
    if (g.n == 0) return true; // an area throw that caught no unit: completed, nothing rolled, spent or refreshed
    var attacker_plus: f64 = 0;
    var decrease: MoraleDecrease = .{};
    var group: usize = 0;
    var target_ui = g.first(0);
    var tgt = &s.units[target_ui];
    var fin: Fin = .{ .initial = target_ui };
    // A single-group shot at a Hidden (Disguise) unit is refused; a ray holding two enemies is not.
    if (s.disguise and g.n == 1 and tgt.isHidden()) return false;
    // An Aggr'd shooter's shot must land first on its live forced target; an AOE throw must catch it.
    if (forcedTarget(s, att)) |f| {
        const lands = if (is_aoe) std.mem.indexOfScalar(u8, g.members[0..g.n_members], f) != null else target_ui == f;
        if (!lands) return false;
    }
    // Terrifying Gaze bars the gazer as the shot's first hit.
    if (s.forbids(att, tgt.uid)) return false;
    var through_hits: SwordHits = .{};
    const through_list = swordList(s, att, &through_hits);
    if (att.ability_mask & st.AbilityId.through_shot.bit() != 0 and throughShot(s, ai, g, true, 1, died, through_list)) {
        fin.primary_landed = true;
        fin.run(s, ai);
        // A Double Shot holder fires the volley again (no arrow), at the Double Shot multiplier.
        if (!suppress_double) {
            if (doubleShotAbility(att)) |ds| {
                if (!att.isDead() and !att.isSkipping()) {
                    // Dual Strike Charm amplifies the second volley (before the > 0 test).
                    const m = artifacts.dualStrikeIn(s, att, abilities.abilityMultiplier(att, ds));
                    if (m > 0) _ = throughShot(s, ai, g, false, m, died, through_list);
                }
            }
        }
        // Fireforged Sword over both volleys' pierced units (attack_handler.ts:1294): no kill morale, no same-name loss.
        if (through_list) |w| _ = swordOnVictims(s, ai, w, died, null);
        engine.refreshStackPowerForAllUnits(s);
        return true;
    }
    if (!is_aoe and (tgt.team == att.team or tgt.isDead() or engine.cowardBarred(s, att, tgt))) return false;
    var divisor = g.divisors[0];

    // Absolving Arrow: the shot cleanses the shooter's allies on its whole ray, before the miss roll.
    absolvingArrow(s, ai, att.pos_x, att.pos_y, to[0], to[1]);
    const missed = missRoll(s, att, tgt); // attack_handler.ts:1343
    var rv: ?u8 = if (resp_units) |r| r[0] else null;
    var response_missed = false;
    if (rv) |r| {
        // canRespond(RANGE): no Stun, no active Through Shot; an Aggr'd target answers only its forced attacker (the raw
        // target id); a Cowardly one not a stronger victim.
        const aggr_ok = tgt.target < 0 or tgt.target == @as(i8, @intCast(ai));
        if (!abilities.skipsResponse(att) and s.fight.replied & engine.unitBit(target_ui) == 0 and !tgt.isSkipping() and
            !tgt.has(.through_shot) and engine.canLandRangeAttack(s, tgt) and !engine.cowardBarred(s, tgt, &s.units[r]) and aggr_ok and
            !s.forbids(tgt, att.uid))
        {
            response_missed = missRoll(s, tgt, &s.units[r]); // attack_handler.ts:1377
        } else rv = null;
    }

    // The attack: an AOE tail over group 0 (Area Throw, Large Caliber, or Chakram with its bounces), which lands before
    // the counter-shot; else the single damage roll (a missed shot rolls none and spends no arrow).
    const has_chakram = att.has(.chakram);
    var tail_landed = false;
    var damage_from_attack: f64 = 0;
    var attack_damage_applied = true;
    if (aoeAbility(att) != null) {
        var flight: Flight = .{};
        for (g.group(0)) |v| flight.add(v, 1, .roll);
        if (has_chakram) {
            chakramFlight(s, ai, target_ui, missed, &flight);
            @memcpy(out.head[0..flight.len], flight.slots[0..flight.len]);
            out.head_len = flight.len;
        }
        var volley_hits: SwordHits = .{};
        const volley = swordList(s, att, &volley_hits);
        damage_from_attack = luckyStrike(s, att, aoeTail(s, ai, &flight, divisor, ai, died, volley));
        tail_landed = true;
        // Fireforged Sword over the volley's landed hits (attack_handler.ts:1498): +4 per kill.
        if (volley) |w| attacker_plus += swordOnVictims(s, ai, w, died, &decrease);
    } else if (!missed) {
        damage_from_attack = luckyStrike(s, att, calculateAttackDamage(s, att, tgt, AT.RANGE, divisor, abilities.paralysisFactor(att) orelse 1));
        attack_damage_applied = false;
    }
    const gaze_attack = damage_from_attack;

    // A volley that already killed the primary leaves nobody to shoot back (its miss roll is spent, its reply not).
    if (rv != null and tgt.isDead()) rv = null;
    var target_plus: f64 = 0;
    var resp_tail = false;
    var resp_chakram = false;
    var response_absorbed = false;
    var gaze_resp: f64 = 0;
    if (rv) |r| {
        // The counter-shot's own arrow: the responder's allies on the return line to the shooter's centre.
        absolvingArrow(s, target_ui, tgt.pos_x, tgt.pos_y, att.pos_x, att.pos_y);
        out.response_thrown = true;
        const victim = &s.units[r];
        if (aoeAbility(tgt) != null) {
            var flight: Flight = .{};
            for (resp_units.?) |v| flight.add(v, 1, .roll);
            if (tgt.has(.chakram)) {
                resp_chakram = true;
                chakramFlight(s, target_ui, r, response_missed, &flight);
            }
            var counter_hits: SwordHits = .{};
            const counter = swordList(s, tgt, &counter_hits);
            _ = luckyStrike(s, tgt, aoeTail(s, target_ui, &flight, resp_div, ai, died, counter));
            resp_tail = true;
            // The responder's Fireforged Sword over its counter-volley (attack_handler.ts:1687).
            if (counter) |w| target_plus += swordOnVictims(s, target_ui, w, died, &decrease);
        } else if (!response_missed) {
            const dmg = luckyStrike(s, tgt, calculateAttackDamage(s, tgt, victim, AT.RANGE, resp_div, abilities.paralysisFactor(tgt) orelse 1));
            gaze_resp = dmg;
            response_absorbed = dmg > 0 and abilities.absorbs(s, victim);
            // attack_handler.ts:1763: extended only when the counter-shot hits the shooter whose turn it is.
            const counter_dealt = hit(s, target_ui, r, dmg, r == ai);
            engine.markDamageLap(s, counter_dealt);
            // The responder's Fireforged Sword on its counter-shot (attack_handler.ts:1778): +4 for a kill.
            target_plus += swordHit(s, target_ui, r, dmg, died, &decrease);
            if (!response_absorbed) {
                target_plus += abilities.pegasusLightMorale(victim); // dropped unless an early return applies it
                abilities.poisonAura(s, target_ui, r, dmg);
                abilities.assimilationPoison(s, target_ui, r, dmg);
            }
        }
        spendReply(s, target_ui);
        if (!response_missed or (!resp_chakram and resp_tail)) fin.response = r;
    }

    // The primary: a single shot's hit, then its riders (after a landed splash only the poisons, from the volley's
    // largest damage: the tail rolled the rest per victim); its death switches the target.
    var switch_target = false;
    if (!tail_landed or !is_aoe) {
        var absorbed = false;
        if (!attack_damage_applied) {
            absorbed = damage_from_attack > 0 and abilities.absorbs(s, tgt);
            const shot_dealt = hit(s, ai, target_ui, damage_from_attack, false); // attack_handler.ts:1886
            engine.markDamageLap(s, shot_dealt);
            if (!absorbed) attacker_plus += abilities.pegasusLightMorale(tgt);
            // Gravechain off the landed shot (attack_handler.ts:1923; a fresh set; the target may have died).
            if (!absorbed) {
                var gc: st.UidSet = .{};
                artifacts.gravechain(s, ai, target_ui, ai, &gc);
            }
            // Fireforged Sword (attack_handler.ts:1937): the shot a shield ate still burns; no kill morale.
            _ = swordHit(s, ai, target_ui, damage_from_attack, died, &decrease);
        }
        if (!tgt.isDead() and !missed and !absorbed) {
            if (!tail_landed) {
                abilities.deepWounds(s, ai, target_ui, ai);
                abilities.stun(s, ai, target_ui, ai);
                abilities.freeze(s, ai, target_ui, ai); // attack_handler.ts:1977
                artifacts.rimeCharm(s, ai, target_ui, ai); // attack_handler.ts:1978
                abilities.petrifyingGaze(s, ai, target_ui, gaze_attack, divisor);
                abilities.spitBall(s, ai, target_ui, ai);
            }
            // Hamstring rides the primary shot (a landed splash too), never the counter-shot or a second arrow.
            abilities.hamstring(s, ai, target_ui, ai);
            abilities.poisonAura(s, ai, target_ui, damage_from_attack);
            abilities.assimilationPoison(s, ai, target_ui, damage_from_attack);
            if (!tail_landed) abilities.borrowedGrace(s, ai, target_ui, ai);
        }
        if (recordDeath(s, target_ui, died, &attacker_plus, &decrease)) switch_target = true;
    }
    if (!missed or (!has_chakram and tail_landed)) fin.primary_landed = true;

    // The counter-shot's bookkeeping: after a splash counter only the shooter's death ends the action; after a single
    // counter-shot the victim's death, or its riders and a death they caused (a Petrifying Gaze).
    if (rv) |r| {
        const victim = &s.units[r];
        var victim_dead = false;
        // Gravechain off a landed single counter-shot (attack_handler.ts:2041; a fresh set; the shooter is active).
        if (!resp_tail and !response_missed and !response_absorbed) {
            var gc: st.UidSet = .{};
            artifacts.gravechain(s, target_ui, r, ai, &gc);
        }
        if (resp_tail) {
            if (victim.isDead() and r == ai) {
                died.push(r);
                victim_dead = true;
            }
        } else {
            if (!victim.isDead() and !response_missed and !response_absorbed) {
                abilities.deepWounds(s, target_ui, r, ai);
                abilities.stun(s, target_ui, r, ai);
                abilities.freeze(s, target_ui, r, ai);
                artifacts.rimeCharm(s, target_ui, r, ai);
                abilities.petrifyingGaze(s, target_ui, r, gaze_resp, resp_div);
                abilities.spitBall(s, target_ui, r, ai);
                abilities.borrowedGrace(s, target_ui, r, ai); // a Monk shooting back copies just the same
            }
            if (victim.isDead()) {
                if (!died.includes(r)) {
                    died.push(r);
                    decrease.add(victim, engine.MORALE_CHANGE_FOR_KILL);
                    if (!tgt.isDead()) target_plus += engine.MORALE_CHANGE_FOR_KILL;
                }
                victim_dead = true;
            }
        }
        if (victim_dead and r == ai) {
            engine.changeMorale(att, attacker_plus, true);
            engine.changeMorale(tgt, target_plus, true);
            decrease.apply(s);
            fin.run(s, ai);
            return true; // the shooter is dead: no refresh
        }
    }

    engine.refreshStackPowerForAllUnits(s);

    // The switch: the next group with a living member, its first unit, its divisor; the shot then ends unless the second
    // shot may follow.
    if (switch_target) {
        var k: usize = 1;
        while (k < g.n) : (k += 1) {
            var all_dead = true;
            for (g.group(k)) |m| {
                if (!s.units[m].isDead()) {
                    all_dead = false;
                    break;
                }
            }
            if (!all_dead) break;
        }
        if (k >= g.n) {
            engine.changeMorale(att, attacker_plus, true);
            engine.changeMorale(tgt, target_plus, true);
            decrease.apply(s);
            fin.run(s, ai);
            return true;
        }
        group = k;
        const previous = target_ui;
        target_ui = g.first(k);
        tgt = &s.units[target_ui];
        if (previous != target_ui) engine.changeMorale(tgt, target_plus, true);
        if (tgt.team == att.team or tgt.isDead() or engine.cowardBarred(s, att, tgt)) {
            if (tgt.isDead()) died.push(target_ui);
            engine.changeMorale(att, attacker_plus, true);
            decrease.apply(s);
            fin.run(s, ai);
            return true;
        }
        divisor = g.divisors[k];
    }

    // Double Shot / Double Throw: the second shot at the (possibly switched) target.
    var second: Second = .{};
    var second_hits: SwordHits = .{};
    if (!suppress_double) second = doubleShot(s, ai, target_ui, g.group(group), divisor, is_aoe, died, swordList(s, att, &second_hits));
    // Fireforged Sword over an area second volley (attack_handler.ts:2280): +4 per kill.
    if (second.tail and second_hits.len != 0) attacker_plus += swordOnVictims(s, ai, &second_hits, died, &decrease);
    if (!second.tail) {
        // Gravechain off the second arrow (attack_handler.ts:2302; a fresh set; the target may have died).
        if (second.applied and !second.absorbed) {
            var gc: st.UidSet = .{};
            artifacts.gravechain(s, ai, target_ui, ai, &gc);
        }
        // Fireforged Sword on the second arrow (attack_handler.ts:2316): +4 for a kill.
        if (second.applied) attacker_plus += swordHit(s, ai, target_ui, second.damage, died, &decrease);
        if (!tgt.isDead() and second.applied and !second.absorbed) {
            abilities.deepWounds(s, ai, target_ui, ai);
            abilities.stun(s, ai, target_ui, ai);
            abilities.freeze(s, ai, target_ui, ai);
            artifacts.rimeCharm(s, ai, target_ui, ai);
            abilities.petrifyingGaze(s, ai, target_ui, second.damage, divisor);
            abilities.spitBall(s, ai, target_ui, ai);
            abilities.poisonAura(s, ai, target_ui, second.damage);
            abilities.borrowedGrace(s, ai, target_ui, ai);
        }
        _ = recordDeath(s, target_ui, died, &attacker_plus, &decrease);
    }
    engine.changeMorale(att, attacker_plus + second.morale, true);
    decrease.apply(s);
    fin.run(s, ai);
    engine.refreshStackPowerForAllUnits(s);
    return true;
}

/// handleRangeAttack's Quiver of Echoes after a completed shot: a living shooter that is not skipping (Stun, Blindness)
/// and still has arrows, facing a surviving target group (each group's living members: group 0 as the Chakram grew it),
/// draws getRandomInt(0, 100); under `chance` (read before the shot) one more ordinary volley flies at the surviving
/// groups with their original divisors, the same aim and AOE flag, no counter-shot and no Double Shot (resolveShot: its
/// own rolls, riders, arrow and refresh). A volley that does not complete keeps the draw and changes nothing. Its deaths join `died` after
/// the shot's, each once.
fn echo(s: *State, ai: u8, g: *const Groups, out: *const Outcome, to: [2]f64, is_aoe: bool, chance: f64, died: *Died) void {
    const att = &s.units[ai];
    if (att.isDead() or att.isSkipping() or engine.getRangeShots(att) <= 0) return; // isSkippingThisTurn
    var live: Groups = undefined;
    live.reset();
    for (0..g.n) |k| {
        const members: []const u8 = if (k == 0 and out.head_len != 0) out.head[0..out.head_len] else g.group(k);
        const first = live.n_members;
        for (members) |m| {
            if (s.units[m].isDead() or live.n_members >= live.members.len) continue;
            live.members[live.n_members] = m;
            live.n_members += 1;
        }
        if (live.n_members == first) continue;
        live.divisors[live.n] = g.divisors[k];
        live.entry[live.n] = g.entry[k];
        live.n += 1;
        live.start[live.n] = live.n_members;
    }
    if (live.n == 0) return;
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= chance) return; // attack_handler.ts:956
    var echo_died: Died = .{};
    var echo_out: Outcome = .{};
    if (!resolveShot(s, ai, &live, null, 1, to, is_aoe, true, &echo_died, &echo_out)) return;
    for (echo_died.items[0..echo_died.len]) |d| {
        if (!died.includes(d)) died.push(d);
    }
}

const Second = struct { applied: bool = false, tail: bool = false, absorbed: bool = false, damage: f64 = 0, morale: f64 = 0 };

/// processDoubleShotAbility: the second shot of a Double Shot / Double Throw holder (getDoubleShotAbility, Break-aware):
/// none when the shooter is dead, stunned or out of arrows, the target is dead, or (a range_attack) the shooter is Aggr'd
/// to another unit (raw target id); an area throw aims at its list's first living unit. Then its own miss roll; a
/// splash shooter throws a second AOE tail over the group (Area Throw's multiplier, one more arrow), else one more
/// single-target shot at the ability's multiplier (one more arrow), never answered.
fn doubleShot(s: *State, ai: u8, target_ui: u8, grp: []const u8, divisor: f64, is_aoe: bool, died: *Died, hits: ?*SwordHits) Second {
    const att = &s.units[ai];
    const a = doubleShotAbility(att) orelse return .{};
    const has_chakram = att.ability(.chakram) != null;
    var to_ui = target_ui;
    if (is_aoe and !has_chakram) {
        for (grp) |m| {
            if (!s.units[m].isDead()) {
                to_ui = m;
                break;
            }
        }
    }
    const to = &s.units[to_ui];
    if (att.isDead() or to.isDead() or att.isSkipping() or engine.getRangeShots(att) <= 0) return .{};
    if ((!is_aoe or has_chakram) and att.target >= 0 and att.target != @as(i8, @intCast(to_ui))) return .{};
    const missed = missRoll(s, att, to); // double_shot_ability.ts:122
    if (has_chakram) {
        // A second Chakram flight (a Crafted Double Shot, or a thief holding both): its own flight from `to` (the
        // trajectory's misses, the first dodge ending it), every victim's bounce factor times the Double Shot multiplier
        // and the Dual Strike Charm, then the AOE tail (one more arrow), a missed throw included.
        var flight: Flight = .{};
        chakramFlight(s, ai, to_ui, missed, &flight);
        const factor = abilities.abilityMultiplier(att, a) * artifacts.dualStrikeIn(s, att, 1);
        for (flight.factors[0..flight.len]) |*f| f.* *= factor;
        _ = luckyStrike(s, att, aoeTail(s, ai, &flight, divisor, ai, died, hits));
        return .{ .applied = true, .tail = true };
    }
    if (missed) return .{}; // a missed second shot spends no arrow
    if (aoeAbility(att) != null) {
        // Dual Strike Charm: every caught unit's factor (double_shot_ability.ts:159).
        const charm = artifacts.dualStrikeIn(s, att, 1);
        var flight: Flight = .{};
        for (grp) |v| flight.add(v, charm, .roll);
        _ = luckyStrike(s, att, aoeTail(s, ai, &flight, divisor, ai, died, hits));
        return .{ .applied = true, .tail = true };
    }
    // Dual Strike Charm on the second arrow's multiplier (double_shot_ability.ts:234).
    var m = artifacts.dualStrikeIn(s, att, abilities.abilityMultiplier(att, a));
    if (abilities.paralysisFactor(att)) |pf| m *= pf; // Paralysis after the Dual Strike Charm
    const dmg = luckyStrike(s, att, calculateAttackDamage(s, att, to, AT.RANGE, divisor, m));
    const absorbed = dmg > 0 and abilities.absorbs(s, to);
    const second_dealt = hit(s, ai, to_ui, dmg, false);
    engine.markDamageLap(s, second_dealt);
    return .{ .applied = true, .absorbed = absorbed, .damage = dmg, .morale = if (absorbed) 0 else abilities.pegasusLightMorale(to) };
}

/// processThroughShotAbility: every single-unit group on the line, in ray order, each living one with its own miss roll
/// and, when not missed, a damage roll (the ability's flat multiplier, times `factor` for a second volley; no arrow), the
/// physical-AOE multiplier (x1.5 on a Mechanism), the hit (the break roll), Venom Cloud poison from the damage dealt,
/// Pegasus Light morale at once and Petrifying Gaze; then per damaged unit its kill (+4, the same-name decrease) or its
/// riders; the shooter's morale, one arrow (a plain decrement) when `decrease_shots`. False when it does not fire.
fn throughShot(s: *State, ai: u8, g: *const Groups, decrease_shots: bool, factor: f64, died: *Died, hits: ?*SwordHits) bool {
    const att = &s.units[ai];
    const a = att.ability(.through_shot) orelse return false;
    if (att.isDead() or att.isSkipping() or engine.getRangeShots(att) <= 0) return false;
    var any_live = false;
    for (g.members[0..g.n_members]) |m| {
        if (!s.units[m].isDead()) any_live = true;
    }
    if (!any_live) return false;
    var damaged: [st.MAX_UNITS]u8 = undefined;
    var n_damaged: usize = 0;
    var absorbed: st.UnitSet = 0;
    var morale: f64 = 0;
    var decrease: MoraleDecrease = .{};
    for (0..g.n) |k| {
        const grp = g.group(k);
        if (grp.len != 1) continue;
        const c = grp[0];
        const cu = &s.units[c];
        if (cu.isDead()) continue;
        const divisor = g.divisors[k];
        if (divisor == 0) continue;
        if (!missRoll(s, att, cu)) { // through_shot_ability.ts:124
            var multiplier = abilities.abilityMultiplier(att, a) * factor;
            // Paralysis (the shooter's) after the volley factor.
            if (abilities.paralysisFactor(att)) |pf| multiplier *= pf;
            var dmg = luckyStrike(s, att, attackDamage(s, att, cu, AT.RANGE, divisor, multiplier, false));
            // Giant's Maul (the shooter's), then getPhysicalAoeDamageMultiplier (the victim's Amulet of Resolve, Mechanism).
            if (s.artifacts) dmg = artifacts.giantsMaul(att, dmg);
            dmg = @floor(dmg * physicalAoeMultiplier(s, cu));
            const was_absorbed = dmg > 0 and abilities.absorbs(s, cu);
            if (was_absorbed) absorbed |= engine.unitBit(c);
            const dealt = hit(s, ai, c, dmg, false); // through_shot_ability.ts:210
            if (hits) |w| w.push(c, dealt, dmg, was_absorbed);
            abilities.poisonAura(s, ai, c, dealt);
            engine.markDamageLap(s, dealt);
            if (!was_absorbed) engine.changeMorale(att, abilities.pegasusLightMorale(cu), true);
            damaged[n_damaged] = c;
            n_damaged += 1;
            if (!cu.isDead() and !was_absorbed) abilities.petrifyingGaze(s, ai, c, dmg, divisor);
        }
        // An Arrows Wingshield owner stops the bolt, hit or missed (through_shot_ability.ts:263).
        if (wingshieldOwner(cu)) break;
    }
    var gc: st.UidSet = .{}; // one Gravechain set per volley (through_shot_ability.ts:268)
    for (damaged[0..n_damaged]) |c| {
        const cu = &s.units[c];
        if (absorbed & engine.unitBit(c) == 0) artifacts.gravechain(s, ai, c, ai, &gc);
        if (cu.isDead()) {
            if (!died.includes(c)) {
                died.push(c);
                morale += engine.MORALE_CHANGE_FOR_KILL;
                decrease.add(cu, engine.MORALE_CHANGE_FOR_KILL);
            }
        } else if (absorbed & engine.unitBit(c) == 0) {
            abilities.deepWounds(s, ai, c, ai);
            abilities.stun(s, ai, c, ai);
            abilities.freeze(s, ai, c, ai);
            artifacts.rimeCharm(s, ai, c, ai);
            abilities.spitBall(s, ai, c, ai);
            abilities.borrowedGrace(s, ai, c, ai);
        }
    }
    engine.changeMorale(att, morale, true);
    decrease.apply(s);
    if (decrease_shots) spendShot(att);
    return true;
}

// =====================================================================================================================
// Chakram (src/abilities/chakram_ability.ts) and the ranged AOE tail (src/abilities/aoe_range_ability.ts)
// =====================================================================================================================

/// A victim's miss verdict in an AOE tail: rolled at its turn in the tail (Large Caliber, Area Throw), or pre-rolled
/// in flight order (Chakram's primary and bounces).
const Pre = enum(u8) { roll, hit, miss };

/// The units an AOE tail strikes, in order (the primary first), with each one's damage factor (a Chakram bounce) and
/// miss verdict.
const Flight = struct {
    slots: [st.MAX_UNITS]u8 = undefined,
    factors: [st.MAX_UNITS]f64 = undefined,
    pre: [st.MAX_UNITS]Pre = undefined,
    len: u8 = 0,

    fn add(self: *Flight, slot: u8, factor: f64, pre: Pre) void {
        for (self.slots[0..self.len]) |x| if (x == slot) return; // each victim at most once
        if (self.len >= self.slots.len) return;
        self.slots[self.len] = slot;
        self.factors[self.len] = factor;
        self.pre[self.len] = pre;
        self.len += 1;
    }

    /// A Chakram verdict and factor (keyed by unit id in TypeScript): on a victim already listed, or appended.
    fn upsert(self: *Flight, slot: u8, factor: f64, pre: Pre) void {
        for (self.slots[0..self.len], 0..) |x, k| {
            if (x == slot) {
                self.factors[k] = factor;
                self.pre[k] = pre;
                return;
            }
        }
        self.add(slot, factor, pre);
    }
};

/// resolveChakramFlightMisses on a tail's flight: the primary keeps the shot's own verdict; when it landed, the planned
/// bounces roll their misses in flight order and the first dodge ends the flight.
fn chakramFlight(s: *State, thrower_i: u8, primary_i: u8, missed: bool, flight: *Flight) void {
    flight.upsert(primary_i, 1, if (missed) .miss else .hit);
    if (missed) return;
    var plan: Flight = .{};
    planChakram(s, thrower_i, primary_i, &plan);
    for (plan.slots[0..plan.len], plan.factors[0..plan.len]) |v, factor| {
        const m = missRoll(s, &s.units[thrower_i], &s.units[v]); // attack_handler.ts:1414 (:1612 on a counter-throw)
        flight.upsert(v, factor, if (m) .miss else .hit);
        if (m) break;
    }
}

/// chakramSeparation: the smallest Chebyshev distance between two bodies (a 1x1 by its base cell).
fn chakramSeparation(a: *const Unit, b: *const Unit) i32 {
    const ac = engine.unitCells(a);
    const bc = engine.unitCells(b);
    const a_cells: []const Cell = if (engine.isSmall(a)) &.{engine.baseCell(a)} else ac.slice();
    const b_cells: []const Cell = if (engine.isSmall(b)) &.{engine.baseCell(b)} else bc.slice();
    var best: i32 = std.math.maxInt(i32);
    for (a_cells) |x| {
        for (b_cells) |y| best = @min(best, @max(@abs(x.x - y.x), @abs(x.y - y.y)));
    }
    return best;
}

const NEIGHBOR_OFFSETS = [8][2]i32{ .{ -1, -1 }, .{ 0, -1 }, .{ 1, -1 }, .{ -1, 0 }, .{ 1, 0 }, .{ -1, 1 }, .{ 0, 1 }, .{ 1, 1 } };

/// emptyBridgePath's existence: a chain of `gap` empty cells inside the box both bodies span, each Chebyshev-adjacent
/// to the last, the first touching `a` and the last touching `b`. Empty = no occupant, or a dead unit still in the
/// holder; terrain ("B", "L", "H") and live units are walls.
fn chakramBridge(s: *const State, a: *const Unit, b: *const Unit, gap: i32) bool {
    const ac = engine.unitCells(a);
    const bc = engine.unitCells(b);
    const a_cells: []const Cell = if (engine.isSmall(a)) &.{engine.baseCell(a)} else ac.slice();
    const b_cells: []const Cell = if (engine.isSmall(b)) &.{engine.baseCell(b)} else bc.slice();
    var x0: i32 = std.math.maxInt(i32);
    var x1: i32 = std.math.minInt(i32);
    var y0: i32 = std.math.maxInt(i32);
    var y1: i32 = std.math.minInt(i32);
    for ([2][]const Cell{ a_cells, b_cells }) |list| {
        for (list) |c| {
            x0 = @min(x0, c.x);
            x1 = @max(x1, c.x);
            y0 = @min(y0, c.y);
            y1 = @max(y1, c.y);
        }
    }
    const Box = struct {
        st_: *const State,
        x0: i32,
        x1: i32,
        y0: i32,
        y1: i32,
        fn empty(self: @This(), c: Cell) bool {
            if (c.x < self.x0 or c.x > self.x1 or c.y < self.y0 or c.y > self.y1) return false;
            if (!engine.cellWithinGrid(c)) return false;
            const o = self.st_.grid.board[@intCast(c.x)][@intCast(c.y)];
            if (o == st.EMPTY) return true;
            if (!st.isUnitCode(o)) return false;
            const u = &self.st_.units[o - 1];
            return u.in_holder and u.isDead();
        }
        fn touches(list: []const Cell, c: Cell) bool {
            for (list) |x| if (@max(@abs(x.x - c.x), @abs(x.y - c.y)) == 1) return true;
            return false;
        }
    };
    const box = Box{ .st_ = s, .x0 = x0, .x1 = x1, .y0 = y0, .y1 = y1 };
    for (a_cells) |ac_| {
        for (NEIGHBOR_OFFSETS) |o| {
            const first = Cell{ .x = ac_.x + o[0], .y = ac_.y + o[1] };
            if (!box.empty(first)) continue;
            if (gap == 1) {
                if (Box.touches(b_cells, first)) return true;
                continue;
            }
            for (NEIGHBOR_OFFSETS) |o2| {
                const second = Cell{ .x = first.x + o2[0], .y = first.y + o2[1] };
                if (!box.empty(second)) continue;
                if (Box.touches(b_cells, second)) return true;
            }
        }
    }
    return false;
}

/// The clockwise sweep from heading `h` to direction `v` (chakramClockwiseSweep of two Math.atan2 bearings), as a
/// class and an exact comparison on the integer vectors: class 0 straight ahead, 1 turning clockwise by less than a
/// half turn, 2 straight back, 3 the rest. Distinct directions of small integer vectors differ by far more than an
/// ulp and parallel ones give identical atan2 results, so this reproduces the float order and its ties exactly.
fn sweepClass(h: [2]i32, v: [2]i32) u2 {
    const cross = h[0] * v[1] - h[1] * v[0];
    if (cross == 0) return if (h[0] * v[0] + h[1] * v[1] > 0) 0 else 2;
    return if (cross < 0) 1 else 3;
}

/// -1 when the sweep to `a` is smaller than to `b`, 0 when equal, 1 when larger.
fn sweepOrder(h: [2]i32, a: [2]i32, b: [2]i32) i32 {
    const ca = sweepClass(h, a);
    const cb = sweepClass(h, b);
    if (ca != cb) return if (ca < cb) -1 else 1;
    if (ca == 0 or ca == 2) return 0;
    const cross = a[0] * b[1] - a[1] * b[0];
    return if (cross < 0) -1 else if (cross > 0) 1 else 0;
}

inline fn direction(from: Cell, to: Cell) [2]i32 {
    return .{ to.x - from.x, to.y - from.y };
}

/// `a.getId() < b.getId()`: canonical UUID ids compare as their bytes.
fn idLess(s: *State, a: *const Unit, b: *const Unit) bool {
    if (!a.uuid_ok or !b.uuid_ok) {
        s.overflow = true;
        return a.uid < b.uid;
    }
    return std.mem.order(u8, &a.uuid, &b.uuid) == .lt;
}

/// resolveChakramTrajectory: from the primary, up to clamp(round(stack power), 1, 5) - 1 bounces, each to the live
/// enemy of the thrower (holder order; not yet struck) one or two empty cells apart from the last victim with an empty
/// bridge, first by clockwise sweep from the heading, then by separation, then by id. A two-cell bounce strikes at
/// half damage and ends the flight. Pure geometry: no roll.
fn planChakram(s: *State, thrower_i: u8, primary_i: u8, out: *Flight) void {
    const thrower = &s.units[thrower_i];
    // An Arrows Wingshield owner hit as the primary relays nothing (chakram_ability.ts:333).
    if (thrower.ability(.chakram) == null or s.units[primary_i].isDead() or wingshieldOwner(&s.units[primary_i])) return;
    var visited: st.UnitSet = engine.unitBit(primary_i);
    var last = primary_i;
    var heading = direction(engine.baseCell(thrower), engine.baseCell(&s.units[primary_i]));
    const max_targets = @max(1, @min(5, js.round(engine.getStackPower(thrower))));
    const max_bounces: usize = @intFromFloat(max_targets - 1);
    var hop: usize = 0;
    while (hop < max_bounces) : (hop += 1) {
        const from = &s.units[last];
        var next: ?u8 = null;
        var next_sep: i32 = 0;
        var next_dir: [2]i32 = .{ 0, 0 };
        for (s.holderOrder()) |i| {
            const u = &s.units[i];
            if (visited & engine.unitBit(i) != 0 or u.isDead() or u.team == thrower.team) continue;
            const sep = chakramSeparation(from, u);
            const gap = sep - 1;
            if (gap < 1 or gap > 2) continue;
            if (!chakramBridge(s, from, u, gap)) continue;
            const dir = direction(engine.baseCell(from), engine.baseCell(u));
            const better = blk: {
                const n = next orelse break :blk true;
                const order = sweepOrder(heading, dir, next_dir);
                if (order != 0) break :blk order < 0;
                if (sep != next_sep) break :blk sep < next_sep;
                break :blk idLess(s, u, &s.units[n]);
            };
            if (better) {
                next = i;
                next_sep = sep;
                next_dir = dir;
            }
        }
        const n = next orelse break;
        // The clockwise winner is an owner: the disc drops there, no hit, and the flight ends (chakram_ability.ts:404).
        if (wingshieldOwner(&s.units[n])) break;
        visited |= engine.unitBit(n);
        const wide = next_sep - 1 != 1;
        out.add(n, if (wide) 0.5 else 1, .roll);
        if (wide) break;
        heading = direction(engine.baseCell(from), engine.baseCell(&s.units[n]));
        last = n;
    }
}

/// processRangeAOEAbility (no Flesh Shield, Giant's Maul, Broken Aegis or Paralysis in scope): the ability is Area Throw,
/// else Large Caliber, else Chakram. Per victim in order (a dead one is listed and skipped): its miss verdict (rolled
/// here, vs the thrower, unless pre-rolled), and when not missed the damage roll with the ability's multiplier and
/// `divisor` (no arrow spent), the bounce factor, the physical-AOE multiplier (x1.5 on a Mechanism), the covenant check
/// and the hit (the break roll, never extended), Venom Cloud poison from the damage dealt, Pegasus Light morale and
/// Petrifying Gaze; then, in order, every kill (+4 each, an ally's too, and the same-name decreases) and the riders of
/// every landed live victim (Deep Wounds, Stun, Spit Ball, Borrowed Grace; `active_i` is the unit whose turn it is);
/// the thrower's morale at once, and one arrow (spendShotsAgainst, a missed throw too). Kills go to `died`. Returns the
/// largest damage rolled.
fn aoeTail(s: *State, thrower_i: u8, flight: *const Flight, divisor: f64, active_i: u8, died: *Died, hits: ?*SwordHits) f64 {
    const thrower = &s.units[thrower_i];
    const a = aoeAbility(thrower) orelse return 0;
    var tail_died: Died = .{};
    var was_dead: Died = .{};
    var landed: [st.MAX_UNITS]bool = .{false} ** st.MAX_UNITS;
    var morale: f64 = 0;
    var decrease: MoraleDecrease = .{};
    var max_damage: f64 = 0;
    for (flight.slots[0..flight.len], 0..) |v, k| {
        const u = &s.units[v];
        if (u.isDead()) {
            tail_died.push(v);
            was_dead.push(v);
            continue;
        }
        const missed = switch (flight.pre[k]) {
            .roll => missRoll(s, thrower, u), // aoe_range_ability.ts:123
            .hit => false,
            .miss => true,
        };
        if (missed) continue;
        var ability_multiplier = abilities.abilityMultiplier(thrower, a);
        if (abilities.paralysisFactor(thrower)) |pf| ability_multiplier *= pf; // aoe_range_ability.ts:151
        var damage = luckyStrike(s, thrower, attackDamage(s, thrower, u, AT.RANGE, divisor, ability_multiplier, false));
        if (flight.factors[k] != 1) damage = @floor(damage * flight.factors[k]);
        // Giant's Maul (the striker's), then getPhysicalAoeDamageMultiplier (the victim's Amulet of Resolve, Mechanism).
        if (s.artifacts) damage = artifacts.giantsMaul(thrower, damage);
        damage = @floor(damage * physicalAoeMultiplier(s, u));
        const absorbed = damage > 0 and abilities.absorbs(s, u);
        if (!absorbed) landed[k] = true;
        const dealt = hit(s, thrower_i, v, damage, false); // aoe_range_ability.ts:230
        if (hits) |w| w.push(v, dealt, damage, absorbed);
        abilities.poisonAura(s, thrower_i, v, dealt);
        engine.markDamageLap(s, dealt);
        if (!absorbed) morale += abilities.pegasusLightMorale(u);
        max_damage = @max(max_damage, damage);
        if (!u.isDead() and !absorbed) abilities.petrifyingGaze(s, thrower_i, v, damage, divisor);
    }
    var gc_tail: st.UidSet = .{}; // one Gravechain set per AOE call
    for (flight.slots[0..flight.len], 0..) |v, k| {
        const u = &s.units[v];
        if (landed[k]) artifacts.gravechain(s, thrower_i, v, active_i, &gc_tail);
        if (u.isDead()) {
            if (!was_dead.includes(v)) {
                if (!tail_died.includes(v)) {
                    tail_died.push(v);
                    morale += engine.MORALE_CHANGE_FOR_KILL;
                    decrease.add(u, engine.MORALE_CHANGE_FOR_KILL);
                }
                was_dead.push(v);
            }
            continue;
        }
        if (!landed[k]) continue;
        abilities.deepWounds(s, thrower_i, v, active_i);
        abilities.stun(s, thrower_i, v, active_i);
        abilities.freeze(s, thrower_i, v, active_i);
        artifacts.rimeCharm(s, thrower_i, v, active_i);
        abilities.spitBall(s, thrower_i, v, active_i);
        abilities.borrowedGrace(s, thrower_i, v, active_i);
    }
    engine.changeMorale(thrower, morale, true);
    decrease.apply(s);
    spendShotsAgainst(thrower); // spendShotsAgainst(affectedUnits[0]): one arrow (no Dense Flesh in scope)
    for (tail_died.items[0..tail_died.len]) |d| died.push(d);
    return max_damage;
}

/// processAbsolvingArrowAbility on the shot's whole ray (traceGridRayCells from `(fx, fy)` to `(tx, ty)`, past enemies
/// and terrain): each live ally of the shooter on it, once, has its liftable negatives rolled off
/// (abilities.absolveAlly) with the first-lift chance clamp(0, 100, calculateAbilityApplyChance).
fn absolvingArrow(s: *State, shooter_i: u8, fx: f64, fy: f64, tx: f64, ty: f64) void {
    const shooter = &s.units[shooter_i];
    const a = shooter.ability(.absolving_arrow) orelse return;
    const first = @max(0, @min(100, abilities.applyChance(shooter, a)));
    var visited: st.UnitSet = engine.unitBit(shooter_i);
    var ray: Ray = undefined;
    traceRayInto(&ray, fx, fy, tx, ty);
    for (ray.items[0..ray.len]) |h| {
        if (!engine.cellWithinGrid(h.cell)) continue;
        const o = s.grid.board[@intCast(h.cell.x)][@intCast(h.cell.y)];
        if (!st.isUnitCode(o)) continue;
        const slot: u8 = o - 1;
        if (visited & engine.unitBit(slot) != 0) continue;
        const ally = &s.units[slot];
        if (!ally.in_holder) continue;
        visited |= engine.unitBit(slot);
        if (ally.isDead() or ally.team != shooter.team) continue;
        abilities.absolveAlly(s, ally, first);
    }
}

// =====================================================================================================================
// Obstacles (BLOCK_CENTER): GameActionEngine.obstacleAttack, AttackHandler.handleObstacleAttack
// =====================================================================================================================

/// AbilityHelper.pierceCellBehind: the cell one step past `target` on the line from the attacker's body cell closest
/// to it (a 2x2 in its hand-written order, first strictly closer wins), or null when the attacker is not in contact.
fn pierceCellBehind(att: *const Unit, from: Cell, target: Cell) ?Cell {
    const a = closestBodyCell(att, from, target);
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    if (@max(@abs(dx), @abs(dy)) != 1) return null;
    return .{ .x = target.x + dx, .y = target.y + dy };
}

/// pierceSweepCells / pierceCellBehind: the cell a sweep starts from, `from` (the striker's anchor) for a 1x1, else the
/// body cell anchored there closest to `target` (a 2x2 in its hand-written order, first strictly closer wins).
fn closestBodyCell(att: *const Unit, from: Cell, target: Cell) Cell {
    if (engine.isSmall(att)) return from;
    var body: engine.Cells = .{};
    if (att.fw == 2 and att.fh == 2) {
        body.push(from);
        body.push(.{ .x = from.x - 1, .y = from.y });
        body.push(.{ .x = from.x, .y = from.y - 1 });
        body.push(.{ .x = from.x - 1, .y = from.y - 1 });
    } else body = engine.cellsForAnchor(from, att.fw, att.fh);
    var a = body.items[0];
    var best = cellDist(a, target);
    for (body.slice()) |c| {
        const d = cellDist(c, target);
        if (d < best) {
            a = c;
            best = d;
        }
    }
    return a;
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
    var gc_pierce: st.UidSet = .{};
    strikeSkewerTarget(s, ai, vi, true, died, &decrease, &plus, ai, &gc_pierce, null);
    if (!att.isDead()) engine.changeMorale(att, plus, true);
    decrease.apply(s);
}

/// AttackHandler.handleObstacleAttack's range branch (a shooter with RANGE selected that can land a shot): on a
/// scattered board the shot breaks the first stone on its ray, a Double Shot holder's the first TWO
/// (getObstacleIntersections, collected before any falls); on the classic board it spends the aimed mountain's hit;
/// either way one arrow is spent (a plain decrement). No miss or damage roll; then Quiver of Echoes' extra hit
/// (obstacleEcho). Returns rangeLanded.
fn rangedObstacleShot(s: *State, ai: u8, tx: f64, ty: f64) bool {
    const att = &s.units[ai];
    var landed = false;
    if (terrain.hasScatteredMountains(s)) {
        var stones: [2]Cell = undefined;
        const max: usize = if (doubleShotAbility(att) != null) 2 else 1;
        const n = obstacleIntersections(s, att.pos_x, att.pos_y, tx, ty, stones[0..max]);
        for (stones[0..n]) |c| terrain.spendObstacleHit(s, c, c.x >= st.GRID >> 1);
        landed = n > 0;
    } else {
        const c = engine.cellForPosition(tx, ty);
        terrain.spendObstacleHit(s, c, c.x >= st.GRID >> 1);
        landed = true;
    }
    // decreaseNumberOfShots
    att.range_shots -= 1;
    if (att.range_shots < 0) att.range_shots = 0;
    att.range_shots = @floor(att.range_shots);
    if (landed and s.artifacts) obstacleEcho(s, ai, tx, ty);
    return landed;
}

/// handleObstacleAttack's Quiver of Echoes (attack_handler.ts:3940): the chance read after the shot; the echo's stone is,
/// on a scattered board, the first one still standing on the segment to the aim, on the classic board the aimed
/// mountain while it stands. With one there and arrows left, getRandomInt(0, 100) under the chance spends one more hit
/// on it (the classic side only while it has hits left, checked after the draw) and one more arrow.
fn obstacleEcho(s: *State, ai: u8, tx: f64, ty: f64) void {
    const att = &s.units[ai];
    const chance = artifacts.echoChance(s, att);
    if (chance <= 0) return;
    const scattered = terrain.hasScatteredMountains(s);
    var cell: Cell = undefined;
    if (scattered) {
        var stones: [1]Cell = undefined;
        if (obstacleIntersections(s, att.pos_x, att.pos_y, tx, ty, stones[0..1]) == 0) return;
        cell = stones[0];
    } else {
        if (!terrain.obstacleStillStands(s)) return;
        cell = engine.cellForPosition(tx, ty);
    }
    if (engine.getRangeShots(att) <= 0) return;
    if (@as(f64, @floatFromInt(s.rng.int(0, 100))) >= chance) return; // attack_handler.ts:3951
    const right = cell.x >= st.GRID >> 1;
    if (!scattered and (if (right) s.fight.hits_right else s.fight.hits_left) <= 0) return;
    terrain.spendObstacleHit(s, cell, right);
    att.range_shots -= 1;
    if (att.range_shots < 0) att.range_shots = 0;
    att.range_shots = @floor(att.range_shots);
}

/// AttackHandler.handleObstacleAttack: the range branch when the attacker can shoot (rangedObstacleShot), else the
/// melee branch: the walk in (or a strike in place), the hit, Skewer Strike's pierce, Double Punch's second hit,
/// then Hydra's Lightning Spin around the strike anchor. No miss or damage roll on the stone itself. Returns
/// `completed`; kills from the pierce and the spin go to `died`. `from` is null for a shot without attackFrom.
/// noRoute's obstacle twin (server.UNVERIFIED_OBSTACLE): the strike is refused (false).
fn unreachedObstacle(s: *State, am: server.Approach) bool {
    if (am.unreached) s.server_unverified |= server.UNVERIFIED_OBSTACLE;
    return false;
}

fn handleObstacleAttack(s: *State, ai: u8, tx: f64, ty: f64, from_opt: ?Cell, am: server.Approach, died: *Died, burned: *bool) bool {
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
    const route = am.route orelse &.{}; // currentActiveKnownPaths.get(attackFrom)?.[0]
    const has_route = am.route != null;
    // Captured before either branch relocates the attacker (burnAttackerOnFireWalls).
    const start_cells = engine.unitCells(att);
    if (engine.isSmall(att)) {
        if (!engine.cellsFreeFor(s, ai, from_cells.slice())) return false;
        if (!(stationary or has_route)) return unreachedObstacle(s, am);
        const pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
        if (!stationary) {
            if (!applyStrikeMoveModifiers(s, ai, route, am.has_lava)) return false;
            if (!engine.occupyCell(s, ai, from)) return false;
        }
        att.pos_x = pos[0];
        att.pos_y = pos[1];
        if (s.fight.n_smoke != 0) engine.dispelSmoke(s, ai, &.{from}); // attack_handler.ts:4072
    } else {
        const anchor_pos = engine.positionForCell(@floatFromInt(from.x), @floatFromInt(from.y));
        const pos = [2]f64{
            anchor_pos[0] - (@as(f64, @floatFromInt(@max(1, att.fw))) - 1) * engine.HALF,
            anchor_pos[1] - (@as(f64, @floatFromInt(@max(1, att.fh))) - 1) * engine.HALF,
        };
        const cells = engine.cellsForPosition(pos[0], pos[1], att.fw, att.fh);
        if (!engine.cellsFreeFor(s, ai, cells.slice())) return false;
        if (!(stationary or has_route)) return unreachedObstacle(s, am);
        if (!stationary) {
            if (!applyStrikeMoveModifiers(s, ai, route, am.has_lava)) return false;
            if (!engine.occupyCells(s, ai, cells.slice())) return false;
        }
        att.pos_x = pos[0];
        att.pos_y = pos[1];
        if (s.fight.n_smoke != 0) engine.dispelSmoke(s, ai, cells.slice()); // attack_handler.ts:4189
    }
    // The walk in burns before the obstacle is struck (both branches, after the smoke dispel); burned to death, the
    // strike is skipped and the action completes with the cleanup alone.
    if (!stationary and s.fight.n_fire != 0) {
        const r = am.route orelse &.{from};
        const travelled = if (r.len > 0 and r[0].x == base.x and r[0].y == base.y) r[1..] else r;
        const landing = engine.unitCells(att);
        var burning: engine.Swept = .{};
        engine.burningCellsEntered(s, ai, start_cells.slice(), travelled, landing.slice(), false, &burning);
        engine.burnOnFire(s, ai, burning.slice());
        if (att.isDead()) {
            died.push(ai);
            burned.* = true;
            return true;
        }
    }
    terrain.spendObstacleHit(s, target, is_right);
    pierceStoneBehind(s, ai, from, target, died);
    if (terrain.obstacleStillStands(s) and (att.has(.double_punch) or att.has(.crafted_double_punch))) terrain.spendObstacleHit(s, target, is_right);

    // spinAroundObstacleStrike: the spin lands as off a unit strike (chargedRouteCells ?? 1), then the stones around.
    if (att.has(.lightning_spin)) {
        var rapid_cells: f64 = 1;
        if (stationary and att.moved_this_turn and att.moved_route_cells > 0) {
            if (s.fight.rc_alt_unit == ai and s.fight.rc_alt_len != att.moved_route_cells) s.server_unverified |= server.UNVERIFIED_ROUTE;
            rapid_cells = att.moved_route_cells;
        } else if (am.defined) {
            rapid_cells = if (am.route) |r| @floatFromInt(r.len) else 1;
        }
        var gc_spin: st.UidSet = .{}; // an obstacle strike's spin rolls Gravechain with a fresh set
        _ = lightningSpin(s, ai, from, true, ai, rapid_cells, died, &gc_spin, null);
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
/// fires at the obstacle instead (attackFrom and the route are then ignored; refused after this turn's move); an Area
/// Throw / Large Caliber shooter's shot at a stone is the area strike on it (areaStrikeAtCell).
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
    // A splash shooter's shot at a stone lands ON it: the area strike centred there (the aimed cell must hold "B").
    if (scattered and can_land_range and isSplashShooter(att)) {
        if (!engine.cellWithinGrid(target) or s.grid.board[@intCast(target.x)][@intCast(target.y)] != st.BLOCK) return error.Rejected;
        return areaStrikeAtCell(s, ai, target, events);
    }
    const hits_before = terrain.hitsLeft(s);
    // resolveKnownPaths when the action has an attack-from cell (the server's provider is asked then, a shot too).
    var route_buf: server.RouteBuf = .{};
    var am = server.Approach.fromPath(path, s.action_lava);
    if (from) |f| {
        if (s.engine_mode == .server) {
            // The provider's call and refresh here match the server call for call (server.kp_log); an approach that
            // differs from runMatch's is still unverified (server.UNVERIFIED_OBSTACLE).
            am = server.approach(s, f, path, s.action_lava, &route_buf);
            if (approachDiffers(s, ai, am, path)) s.server_unverified |= server.UNVERIFIED_OBSTACLE;
        }
        const base = engine.baseCell(att);
        const approaching = !can_land_range and !(base.x == f.x and base.y == f.y);
        if (approaching) {
            if (am.route) |r| {
                if (engine.groundRouteCrossesObstacle(s, att, r)) return error.Rejected;
            }
        }
    }

    var died: Died = .{};
    var burned = false;
    const completed = handleObstacleAttack(s, ai, tx, ty, from, am, &died, &burned);
    const landed = if (scattered) terrain.standingCount(s) < standing_before else terrain.hitsLeft(s) < hits_before;
    if (burned) {
        cleanupDeadUnits(s, &died, events, null);
        engine.completeTurn(s, ai, false, false, events);
        return;
    }
    if (!completed or !landed) return error.Rejected;

    engine.refreshStackPowerForAllUnits(s);
    cleanupDeadUnits(s, &died, events, null);
    // Clear whichever classic mountain ran out of hits (clearMountainSide is idempotent).
    if (!scattered) {
        if (s.fight.hits_left <= 0) _ = terrain.clearMountainSide(s, false);
        if (s.fight.hits_right <= 0) _ = terrain.clearMountainSide(s, true);
    }
    engine.completeTurn(s, ai, false, false, events);
}
