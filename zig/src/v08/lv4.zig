//! The v0.4 level of the v0.8 chain (src/ai/versions/v0_4.ts StrategyV0_4.decideTurn), default environment, with
//! v0.8's overrides: rangedOutput is v08TeamRangedOutput, frontMove is StrategyV0_8.frontMove around v0.4's.
//!
//! In scope (no spells or abilities) the pipeline is: hold when out-gunning at range, v0.3, the Goblin Knight's
//! low-level victim, the flyer's patient hunt, the landing guard, the melee legality guard, the lap-1 mass-buff
//! wait, the front move, the range legality guard, plus the ability repositions of batches 1-3: auraRepositionMelee,
//! rapidChargeReposition, aoeMeleeReposition (Fire Breath, Skewer Strike), hydraSpinReposition and
//! chainLightningTarget (batch 6b), and the casts of the later waves (retargetHeal, the Ogre Mage Riot, the Healer's
//! spell policy, the Troll's Wild Regeneration). Off by default: the siege mute (MUTE_SIEGE_ENABLED),
//! the boxed-shooter hold (V04_BOXHOLD), the caster self-delays (V04_OGRESELF / V04_BEHESELF).

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const combat = @import("../combat.zig");
const pathing = @import("../path.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const lv3 = @import("lv3.zig");
const spells = @import("../spells.zig");

const Cell = st.Cell;
const State = st.State;
const AT = st.AttackType;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const rin = s.rng.state;
    defer policy.note("v0.4", out, s, rin);
    // (2) Out-gunning them at range, a shooter that cannot fire yet holds.
    if (u.attack_type == AT.RANGE and engine.getRangeShots(u) > 0 and u.canMove() and holdWhenRangedSuperior(c, out)) return;
    // (6) A small army's Ogre Mage that can move and cannot strike self-casts Riot.
    if (util.creature(s, c.ui) == .ogre_mage and u.canMove() and ogreSingleRiot(c, out)) return;
    // (7) The Healer's spell policy.
    if (util.creature(s, c.ui) == .healer and healerSpell(c, out)) return;
    // (8) The Troll's Wild Regeneration gift (V04_TROLL on).
    if (util.creature(s, c.ui) == .troll and trollWildRegen(c, out)) return;
    lv3.decide(c, out);
    var base: ai.Decision = undefined;
    util.copyDecision(&base, out);
    retargetHeal(c, out);
    preferLowLevelMelee(c, out);
    auraRepositionMelee(c, out);
    rapidChargeReposition(c, out);
    aoeMeleeReposition(c, out);
    flyerPatientHunt(c, out);
    hydraSpinReposition(c, out);
    chainLightningTarget(c, out);
    preferValidMove(c, out, &base);
    enforceMeleeLegality(c, out);
    waitForMassBuff(c, out);
    frontMove(c, out);
    enforceRangeLegality(c, out);
}

/// The unit's first book spell `spell` that it may cast now (isSpellUsableByCaster), with its config.
pub fn usableSpell(s: *const st.State, u: *const st.Unit, spell: st.CastSpell) ?*const st.SpellConfig {
    const raw: u8 = @intFromEnum(spell);
    for (u.spells[0..u.n_spells]) |*b| {
        if (b.spell != raw) continue;
        const cfg = &s.spell_cfg[raw];
        return if (cfg.loaded and spells.usable(u, b, cfg)) cfg else null;
    }
    return null;
}

/// fullCap: max HP x max(1, alive + died); the wounded fraction is 1 - cumulative HP / fullCap (0 for no cap).
pub fn woundFraction(u: *const st.Unit) f64 {
    const cap = u.max_hp * @max(1, u.amount_alive + u.amount_died);
    return if (cap > 0) 1 - util.cumulativeHp(u) / cap else 0;
}

/// (6) ogreMageSingleRiot: an Ogre Mage with no living enemy adjacent, no Riot or Mass Riot on it and a small army
/// (fewer than OGRE_BIG_ARMY = 3 living stacks, itself included) self-casts Riot when its book holds a charge (the
/// laps and the caster's stack power checked as TypeScript does) and the engine's canCastSpell accepts it.
fn ogreSingleRiot(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    const mine = engine.unitCells(u);
    var allies: usize = 0;
    for (s.holderOrder()) |k| {
        const o = &s.units[k];
        if (!o.in_holder or o.isDead()) continue;
        if (o.team == u.team) {
            allies += 1;
        } else if (ai.adjacent(engine.unitCells(o).slice(), mine.slice())) return false;
    }
    if (u.buffs.len != 0 and (u.buffs.find(.riot) != null or u.buffs.find(.mass_riot) != null)) return false;
    if (allies >= 3) return false;
    const raw: u8 = @intFromEnum(st.CastSpell.riot);
    const b = u.bookSpell(raw) orelse return false;
    const cfg = &s.spell_cfg[raw];
    if (!cfg.loaded or !(b.amount > 0) or cfg.laps <= 0 or cfg.min_stack_power > engine.getStackPower(u)) return false;
    if (!spells.canCastSpell(s, c.ui, c.ui, .riot, cfg)) return false;
    out.* = .{};
    out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = raw, .target = c.ui, .has_target = true } });
    return true;
}

/// Slots ordered by a key, descending and stable (JavaScript's sort with `(p, q) => key(q) - key(p)`).
const Ordered = struct {
    slot: [st.MAX_UNITS]u8 = undefined,
    key: [st.MAX_UNITS]f64 = undefined,
    n: usize = 0,
    fn add(self: *Ordered, slot: u8, key: f64) void {
        var i = self.n;
        while (i > 0 and self.key[i - 1] < key) : (i -= 1) {
            self.slot[i] = self.slot[i - 1];
            self.key[i] = self.key[i - 1];
        }
        self.slot[i] = slot;
        self.key[i] = key;
        self.n += 1;
    }
};

/// (7) decideHealerSpell (stack power 1 or more): the critical allies are living level-3+ stacks the engine would heal
/// (healEligible) that lost more than 30%, most hurt first. Two or more: Mass Heal when the mass cast is legal. One or
/// more: Heal on the most hurt when canCastSpell accepts it. Otherwise Spiritual Armor on the first ally (the caster
/// excluded, none already armored), by max damage x alive descending, that canCastSpell accepts.
fn healerSpell(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (engine.getStackPower(u) < 1) return false;
    var critical: Ordered = .{};
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (!util.livingOf(s, k, u.team)) continue;
        // healEligible: canBeHealed (a Mechanism cannot be), magic resist below 100, the top creature hurt
        if (a.has(.mechanism) or engine.getMagicResist(a) == 100 or !(a.hp < a.max_hp)) continue;
        if (a.level < 3) continue;
        const lost = woundFraction(a);
        if (!(lost > 0.3)) continue;
        critical.add(k, lost);
    }
    if (critical.n >= 2) {
        if (usableSpell(s, u, .mass_heal)) |cfg| {
            if (spells.canMassCastSpell(s, c.ui, .mass_heal, cfg)) {
                out.* = .{};
                out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = @intFromEnum(st.CastSpell.mass_heal) } });
                return true;
            }
        }
    }
    if (critical.n >= 1) {
        if (usableSpell(s, u, .heal)) |cfg| {
            const t = critical.slot[0];
            if (spells.canCastSpell(s, c.ui, t, .heal, cfg)) {
                out.* = .{};
                out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = @intFromEnum(st.CastSpell.heal), .target = t, .has_target = true } });
                return true;
            }
        }
    }
    const cfg = usableSpell(s, u, .spiritual_armor) orelse return false;
    var order: Ordered = .{};
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (k == c.ui or !util.livingOf(s, k, u.team)) continue;
        if (a.buffs.len != 0 and a.buffs.find(.spiritual_armor) != null) continue;
        order.add(k, a.attack_damage_max * a.amount_alive);
    }
    for (order.slot[0..order.n]) |k| {
        if (!spells.canCastSpell(s, c.ui, k, .spiritual_armor, cfg)) continue;
        out.* = .{};
        out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = @intFromEnum(st.CastSpell.spiritual_armor), .target = k, .has_target = true } });
        return true;
    }
    return false;
}

/// (1) retargetHeal: a lone single-target ally heal (a HEAL spell aimed at ANY_ALLY) goes to the living ally with the
/// biggest full HP cap among those down more than 25% that the engine would heal (first on ties).
fn retargetHeal(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (out.n != 1 or out.actions[0] != .cast_spell) return;
    const cast = out.actions[0].cast_spell;
    if (!cast.has_target) return;
    var found = false;
    for (u.spells[0..u.n_spells]) |b| {
        if (b.spell == cast.spell) found = true;
    }
    if (!found) return;
    const spell = std.meta.intToEnum(st.CastSpell, cast.spell) catch return;
    const cfg = &s.spell_cfg[cast.spell];
    if (cfg.power_type != st.SpellPower.HEAL or cfg.target != st.SpellTarget.ANY_ALLY) return;
    var best: ?u8 = null;
    var best_cap: f64 = 0;
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (!util.livingOf(s, k, u.team)) continue;
        if (!(woundFraction(a) > 0.25) or !spells.canCastSpell(s, c.ui, k, spell, cfg)) continue;
        const cap = a.max_hp * @max(1, a.amount_alive + a.amount_died);
        if (best == null or cap > best_cap) {
            best = k;
            best_cap = cap;
        }
    }
    const t = best orelse return;
    if (t == cast.target) return;
    out.actions[0].cast_spell.target = t;
}

fn enemyAdjacent(c: *const ai.Ctx) bool {
    const s = c.s;
    const u = c.unit();
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        const ec = engine.unitCells(e);
        if (util.footprintsNear(ec.slice(), mine.slice())) return true;
    }
    return false;
}

/// (2) holdWhenRangedSuperior: wait (else hold) while out-gunning them, when the shot is not there yet and no enemy
/// is adjacent.
fn holdWhenRangedSuperior(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (util.teamRangedOutput(s, u.team) <= util.teamRangedOutput(s, engine.opposite(u.team))) return false;
    if (engine.canLandRangeAttack(s, u)) return false;
    if (enemyAdjacent(c)) return false;
    if (util.canHourglass(s, c.ui)) util.setWait(out, c.ui) else util.setEndTurn(out, c.ui);
    return true;
}

fn firstMelee(out: *const ai.Decision) ?usize {
    for (out.slice(), 0..) |a, i| if (a == .melee_attack) return i;
    return null;
}

/// (8) trollWildRegen: the Troll gifts Wild Regeneration (V04_TROLL on) when it cannot strike an adjacent enemy and its
/// side out-guns theirs at range (v0.8's ranged output): it hourglasses on lap 1, then casts on the living ally of at
/// most the gift level that the gift is worth more to (a19-wild-regen-gift-v1: no own Wild Regeneration, more max HP
/// per creature than the caster; Holy Cross is not in scope), the most max HP first, then cumulative HP, first legal
/// cast in getAllAllies order. As TypeScript, the "already gifted" test reads a buff that never exists, so it never
/// stops the gift.
fn trollWildRegen(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (u.target >= 0) return false;
    const spell = st.CastSpell.wild_regeneration;
    const raw: u8 = @intFromEnum(spell);
    if (u.bookSpell(raw) == null) return false;
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    for (s.holderOrder()) |k| {
        if (!util.livingOf(s, k, opp)) continue;
        const ec = engine.unitCells(&s.units[k]);
        if (util.footprintsNear(ec.slice(), mine.slice())) return false;
    }
    if (util.teamRangedOutput(s, u.team) <= util.teamRangedOutput(s, opp)) return false;
    if (s.fight.lap <= 1 and util.canHourglass(s, c.ui)) {
        util.setWait(out, c.ui);
        return true;
    }
    const cfg = &s.spell_cfg[raw];
    if (!cfg.loaded) return false;
    var cand: [st.MAX_UNITS]u8 = undefined;
    var n: usize = 0;
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (!util.livingOf(s, k, u.team) or k == c.ui) continue;
        if (@as(f64, @floatFromInt(a.level)) > cfg.max_gift_level) continue;
        if (a.has(.wild_regeneration) or !(a.max_hp > u.max_hp)) continue; // isWorthwhileWildRegenerationGift
        cand[n] = k;
        n += 1;
    }
    std.sort.insertion(u8, cand[0..n], s, struct {
        fn lt(st_: *const State, p: u8, q: u8) bool {
            const a = &st_.units[p];
            const b = &st_.units[q];
            if (a.max_hp != b.max_hp) return a.max_hp > b.max_hp;
            return util.cumulativeHp(a) > util.cumulativeHp(b);
        }
    }.lt);
    for (cand[0..n]) |t| {
        if (!spells.canCastSpell(s, c.ui, t, spell, cfg)) continue;
        out.* = .{};
        out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = raw, .target = t, .has_target = true } });
        return true;
    }
    return false;
}

/// IWeightedRoute.route.length: the route's cells, its start included.
fn routeLen(mp: *const pathing.MovePath, r: *const pathing.Route) usize {
    var len: usize = 0;
    var cur: ?*const pathing.Route = r;
    while (cur) |x| {
        len += 1;
        cur = if (x.parent < 0) null else &mp.routes[@intCast(x.parent)];
    }
    return len;
}

/// v0.4's isAdjacentCell from one of `cells` to `c` (|dx| <= 1 and |dy| <= 1, the cell itself included).
fn nearAny(cells: []const Cell, c: Cell) bool {
    for (cells) |x| if (util.near(x, c)) return true;
    return false;
}

/// `{ ...strike, attackFrom: r.cell, path: r's cells, hasLavaCell }` for action `i`: the other actions keep theirs, so
/// the route goes after every other action's cells in the path buffer.
fn setStrikeRoute(d: *ai.Decision, i: usize, mp: *const pathing.MovePath, r: *const pathing.Route) void {
    const lo = @intFromPtr(&d.path[0]);
    var end: usize = 0;
    for (d.actions[0..d.n], 0..) |a, k| {
        if (k == i) continue;
        const sl: []const Cell = switch (a) {
            .move_unit => |m| m.path,
            .melee_attack => |m| m.path,
            .obstacle_attack => |o| o.path,
            else => &.{},
        };
        if (sl.len == 0) continue;
        const p = @intFromPtr(sl.ptr);
        if (p < lo or p >= lo + d.path.len * @sizeOf(Cell)) continue;
        end = @max(end, (p - lo) / @sizeOf(Cell) + sl.len);
    }
    var tmp: [64]Cell = undefined;
    const len = mp.routeCells(r, &tmp);
    @memcpy(d.path[end .. end + len], tmp[0..len]);
    d.actions[i].melee_attack.attack_from = r.cell;
    d.actions[i].melee_attack.path = d.path[end .. end + len];
    d.actions[i].melee_attack.has_lava = r.has_lava;
}

/// A whole new decision: select melee when another type is selected, then strike `target` from `from` along `r` (in
/// place, with no path, when null).
fn setStrike(c: *ai.Ctx, out: *ai.Decision, target: u8, from: Cell, r: ?*const pathing.Route) void {
    const u = c.unit();
    var d: ai.Decision = .{};
    if (u.attack_type_selected != AT.MELEE) d.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
    var len: usize = 0;
    var lava = false;
    if (r) |route| {
        len = c.actualPath().routeCells(route, &d.path);
        lava = route.has_lava;
    }
    d.push(.{ .melee_attack = .{ .attacker = c.ui, .target = target, .attack_from = from, .path = d.path[0..len], .has_lava = lava } });
    util.copyDecision(out, &d);
}

/// friendlyAuraCover: living allies (but the unit) with a buff aura whose range reaches `cell` from the ally's base
/// cell by Euclidean distance, each counted once; a Broken ally emits none.
fn friendlyAuraCover(s: *const State, ui: u8, cell: Cell) u32 {
    const u = &s.units[ui];
    var n: u32 = 0;
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (a.team != u.team or a.isDead() or k == ui) continue;
        for (a.auras[0..a.auraCount()]) |d| {
            const def = &s.aura_defs[d];
            if (def.is_buff and ai.cellDistance(cell, engine.baseCell(a)) <= def.range) {
                n += 1;
                break;
            }
        }
    }
    return n;
}

/// (4) auraRepositionMelee: a strike moves its stand cell to a reachable cell also next to the target inside more
/// allies' buff auras (ties: the cheaper route); only the strike action changes.
fn auraRepositionMelee(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.target >= 0) return;
    const i = firstMelee(out) orelse return;
    if (!u.canMove()) return;
    const strike = out.actions[i].melee_attack;
    const target = &s.units[strike.target];
    if (!target.in_holder) return;
    const current = friendlyAuraCover(s, c.ui, strike.attack_from);
    const mp = c.actualPath();
    const tc = engine.unitCells(target);
    var best: ?*const pathing.Route = null;
    var best_cover: u32 = 0;
    for (mp.known()) |*r| {
        if (!nearAny(tc.slice(), r.cell)) continue;
        const cover = friendlyAuraCover(s, c.ui, r.cell);
        if (best == null or cover > best_cover or (cover == best_cover and r.weight < best.?.weight)) {
            best = r;
            best_cover = cover;
        }
    }
    const b = best orelse return;
    if (best_cover <= current) return;
    setStrikeRoute(out, i, c.actualPath(), b);
}

/// (8) rapidChargeReposition: a Rapid Charge strike runs the longest reachable approach that still ends next to the
/// same target (the run-up adds damage); only the strike action changes.
fn rapidChargeReposition(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (!u.has(.rapid_charge) or u.target >= 0 or !u.canMove()) return;
    const i = firstMelee(out) orelse return;
    const strike = out.actions[i].melee_attack;
    const target = &s.units[strike.target];
    if (!target.in_holder) return;
    const mp = c.actualPath();
    const tc = engine.unitCells(target);
    var best: ?*const pathing.Route = null;
    var best_len: usize = strike.path.len;
    for (mp.known()) |*r| {
        if (!nearAny(tc.slice(), r.cell)) continue;
        const len = routeLen(mp, r);
        if (len > best_len) {
            best_len = len;
            best = r;
        }
    }
    const b = best orelse return;
    setStrikeRoute(out, i, mp, b);
}

/// The living enemies in getAllAllies(enemy team) order.
fn livingEnemies(s: *const State, team: u8, buf: *[st.MAX_UNITS]u8) []const u8 {
    const opp = engine.opposite(team);
    var n: usize = 0;
    for (s.holderOrder()) |k| {
        const e = &s.units[k];
        if (e.team != opp or e.isDead()) continue;
        buf[n] = k;
        n += 1;
    }
    return buf[0..n];
}

/// aoeMeleeReposition's lineHits: the stacks util.aoeLine catches from `from` through `t` (the target plus the living
/// enemies on the fireBreathDepthAlong cells beyond its base cell; one cell for Skewer Strike).
fn lineHits(s: *const State, u: *const st.Unit, opp: u8, from: Cell, t: u8) u32 {
    var buf: [st.MAX_UNITS]u8 = undefined;
    return @intCast(util.aoeLine(s, u, opp, from, t, &buf).len);
}

const Cand = struct { cell: Cell, route: ?*const pathing.Route };

/// The stand cells v0.4's AoE repositions try: in place, then every known route's cell (insertion order).
fn standCandidates(c: *ai.Ctx, buf: []Cand) []const Cand {
    const u = c.unit();
    buf[0] = .{ .cell = engine.baseCell(u), .route = null };
    var n: usize = 1;
    const mp = c.actualPath();
    for (mp.known()) |*r| {
        if (routeLen(mp, r) == 0) continue;
        buf[n] = .{ .cell = r.cell, .route = r };
        n += 1;
    }
    return buf[0..n];
}

fn candLen(c: *ai.Ctx, k: Cand) usize {
    return if (k.route) |r| routeLen(c.actualPath(), r) else 0;
}

/// (8) aoeMeleeReposition (Fire Breath, Skewer Strike): the stand cell and target whose line catches the most enemy
/// stacks (ties: the shorter route), when that beats the current strike's line and catches two or more; the decision
/// becomes that strike alone.
fn aoeMeleeReposition(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if ((!u.has(.fire_breath) and !u.has(.skewer_strike)) or u.target >= 0 or !u.canMove()) return;
    const i = firstMelee(out) orelse return;
    const strike = out.actions[i].melee_attack;
    var ebuf: [st.MAX_UNITS]u8 = undefined;
    const enemies = livingEnemies(s, u.team, &ebuf);
    if (enemies.len < 2) return;
    const opp = engine.opposite(u.team);
    const base_hits: u32 = if (s.units[strike.target].in_holder) lineHits(s, u, opp, strike.attack_from, strike.target) else 1;
    var cbuf: [pathing.MAX_ROUTES]Cand = undefined;
    const cands = standCandidates(c, &cbuf);
    var best: ?struct { k: Cand, target: u8, hits: u32 } = null;
    for (cands) |k| {
        const fp = ai.footprintForAnchor(u, k.cell);
        for (enemies) |e| {
            const ec = engine.unitCells(&s.units[e]);
            if (!util.footprintsNear(ec.slice(), fp.slice())) continue;
            const hits = lineHits(s, u, opp, k.cell, e);
            if (best == null or hits > best.?.hits or (hits == best.?.hits and candLen(c, k) < candLen(c, best.?.k))) {
                best = .{ .k = k, .target = e, .hits = hits };
            }
        }
    }
    const b = best orelse return;
    if (b.hits < 2 or b.hits <= base_hits) return;
    setStrike(c, out, b.target, b.k.cell, b.k.route);
}

/// Enemy stacks next to the unit's footprint at `cell` (the Lightning Spin zone): the count and the first of them.
fn spinZone(c: *ai.Ctx, enemies: []const u8, cell: Cell) struct { count: u32, first: u8 } {
    const s = c.s;
    const fp = ai.footprintForAnchor(c.unit(), cell);
    var n: u32 = 0;
    var first: u8 = 0;
    for (enemies) |e| {
        const ec = engine.unitCells(&s.units[e]);
        if (!util.footprintsNear(ec.slice(), fp.slice())) continue;
        if (n == 0) first = e;
        n += 1;
    }
    return .{ .count = n, .first = first };
}

/// (9) hydraSpinReposition (Lightning Spin): the reachable stand cell next to the most enemy stacks (ties: the shorter
/// route), when that is two or more and beats the current stand; the decision becomes a strike on the first of them.
fn hydraSpinReposition(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (!u.has(.lightning_spin) or u.target >= 0 or !u.canMove()) return;
    const i = firstMelee(out) orelse return;
    const strike = out.actions[i].melee_attack;
    var ebuf: [st.MAX_UNITS]u8 = undefined;
    const enemies = livingEnemies(s, u.team, &ebuf);
    if (enemies.len < 2) return;
    const base_count = spinZone(c, enemies, strike.attack_from).count;
    var cbuf: [pathing.MAX_ROUTES]Cand = undefined;
    const cands = standCandidates(c, &cbuf);
    var best: ?struct { k: Cand, target: u8, count: u32 } = null;
    for (cands) |k| {
        const z = spinZone(c, enemies, k.cell);
        if (z.count == 0) continue;
        if (best == null or z.count > best.?.count or (z.count == best.?.count and candLen(c, k) < candLen(c, best.?.k))) {
            best = .{ .k = k, .target = z.first, .count = z.count };
        }
    }
    const b = best orelse return;
    if (b.count < 2 or b.count <= base_count) return;
    setStrike(c, out, b.target, b.k.cell, b.k.route);
}

/// (10) chainLightningTarget (Chain Lightning): the reachable stand and adjacent enemy whose arc (util.chainHits) reaches
/// the most stacks (ties: the shorter route), when that is two or more and beats the current strike's arc (1 when its
/// target has left the holder); the decision becomes that strike.
fn chainLightningTarget(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (!u.has(.chain_lightning) or u.target >= 0 or !u.canMove()) return;
    const i = firstMelee(out) orelse return;
    const strike = out.actions[i].melee_attack;
    var ebuf: [st.MAX_UNITS]u8 = undefined;
    const enemies = livingEnemies(s, u.team, &ebuf);
    if (enemies.len < 2) return;
    var hbuf: [st.MAX_UNITS]u8 = undefined;
    const base_reach: usize = if (s.units[strike.target].in_holder) util.chainHits(s, enemies, strike.target, &hbuf).len else 1;
    var cbuf: [pathing.MAX_ROUTES]Cand = undefined;
    const cands = standCandidates(c, &cbuf);
    var best: ?struct { k: Cand, target: u8, reach: usize } = null;
    for (cands) |k| {
        const fp = ai.footprintForAnchor(u, k.cell);
        for (enemies) |e| {
            const ec = engine.unitCells(&s.units[e]);
            if (!util.footprintsNear(ec.slice(), fp.slice())) continue;
            const reach = util.chainHits(s, enemies, e, &hbuf).len;
            if (best == null or reach > best.?.reach or (reach == best.?.reach and candLen(c, k) < candLen(c, best.?.k))) {
                best = .{ .k = k, .target = e, .reach = reach };
            }
        }
    }
    const b = best orelse return;
    if (b.reach < 2 or b.reach <= base_reach) return;
    setStrike(c, out, b.target, b.k.cell, b.k.route);
}

/// (7) The Goblin Knight swaps an in-place strike to the lowest-level adjacent enemy below the target's level.
fn preferLowLevelMelee(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (util.creature(c.s, c.ui) != .goblin_knight or u.target >= 0) return;
    const i = firstMelee(out) orelse return;
    const strike = out.actions[i].melee_attack;
    const base = engine.baseCell(u);
    if (strike.path.len > 0 or !ai.sameCell(strike.attack_from, base)) return;
    const current = &s.units[strike.target];
    if (!current.in_holder) return;
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    var best: ?u8 = null;
    var best_level: u8 = 0;
    for (s.holderOrder()) |k_slot| {
        const k: usize = k_slot;
        const e = &s.units[k_slot];
        if (!util.livingOf(s, k, opp) or e.level >= current.level) continue;
        const ec = engine.unitCells(e);
        if (!util.footprintsNear(ec.slice(), mine.slice())) continue;
        if (best == null or e.level < best_level) {
            best = @intCast(k);
            best_level = e.level;
        }
    }
    const b = best orelse return;
    out.actions[i].melee_attack.target = b;
}

/// flyerPatientHunt (V04_FHUNT2, on): a melee flyer with no strike waits until an ally is in contact, then closes
/// on the nearest enemy shooter or caster.
fn flyerPatientHunt(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (!engine.canFly(u) or u.attack_type != AT.MELEE or !u.canMove()) return;
    if (util.strikes(out)) return;
    const opp = engine.opposite(u.team);
    var ranges: [st.MAX_UNITS]Cell = undefined;
    var n_ranges: usize = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        if (e.attack_type == AT.RANGE or e.attack_type == AT.MAGIC) {
            ranges[n_ranges] = engine.baseCell(e);
            n_ranges += 1;
        }
    }
    if (n_ranges == 0) return;
    var clash = false;
    outer: for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (!util.livingOf(s, i, u.team) or i == c.ui) continue;
        const ac = engine.unitCells(a);
        for (s.holderOrder()) |k_slot| {
            const k: usize = k_slot;
            const e = &s.units[k_slot];
            if (!util.livingOf(s, k, opp)) continue;
            const ec = engine.unitCells(e);
            if (util.footprintsNear(ec.slice(), ac.slice())) {
                clash = true;
                break :outer;
            }
        }
    }
    if (!clash) {
        if (util.canHourglass(s, c.ui)) util.setWait(out, c.ui);
        return;
    }
    const Nearest = struct {
        fn of(cell: Cell, targets: []const Cell) f64 {
            var d = std.math.inf(f64);
            for (targets) |t| d = @min(d, ai.cellDistance(cell, t));
            return d;
        }
    };
    const mp = c.actualPath();
    var best: ?*const pathing.Route = null;
    var best_dist = Nearest.of(engine.baseCell(u), ranges[0..n_ranges]);
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0) continue;
        const d = Nearest.of(r.cell, ranges[0..n_ranges]);
        if (d < best_dist) {
            best_dist = d;
            best = r;
        }
    }
    const r = best orelse return;
    util.setMove(out, s, c.ui, mp, r);
}

/// decisionLandingIsBlocked: a path-bearing strike whose stand cell the unit cannot land on, or (V04_MVGUARD, on) a
/// move whose footprint is not free.
fn landingBlocked(c: *const ai.Ctx, d: *const ai.Decision) bool {
    const s = c.s;
    for (d.slice()) |a| {
        if (a == .melee_attack) {
            const m = a.melee_attack;
            if (m.path.len > 0 and !ai.canLandAt(s, c.ui, m.attack_from)) return true;
            break;
        }
    }
    for (d.slice()) |a| {
        if (a == .move_unit) {
            const fp = a.move_unit.target_cells;
            return fp.len > 0 and !engine.cellsFreeFor(s, c.ui, fp);
        }
    }
    return false;
}

/// preferValidMove: keep the tuned decision unless it lands blocked; then the validated v0.3 decision; else hold.
fn preferValidMove(c: *ai.Ctx, out: *ai.Decision, base: *const ai.Decision) void {
    if (!landingBlocked(c, out)) return;
    if (!landingBlocked(c, base)) return util.copyDecision(out, base);
    if (util.canHourglass(c.s, c.ui)) util.setWait(out, c.ui) else util.setEndTurn(out, c.ui);
}

fn inPlaceStrike(c: *ai.Ctx, out: *ai.Decision, target: u8) void {
    const u = c.unit();
    out.* = .{};
    if (u.attack_type_selected != AT.MELEE) out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
    out.push(.{ .melee_attack = .{ .attacker = c.ui, .target = target, .attack_from = engine.baseCell(u), .path = &.{} } });
}

/// (11) enforceMeleeLegality: only the forced (Aggr) target may be struck; a strike the engine would refuse (the target
/// gone, Hidden, or a stronger stack while the unit carries Cowardice, or a move the unit cannot make) becomes an
/// in-place strike on the first enemy (getAllAllies order) that is not the Terrifying Gaze gazer and is strikable in
/// place (alive, not Hidden, not Cowardice-barred, adjacent now), else the fallback turn.
fn enforceMeleeLegality(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const i = firstMelee(out) orelse return;
    const strike = out.actions[i].melee_attack;
    const mine = engine.unitCells(u);
    const Strikable = struct {
        fn ok(st_: *const State, att: *const st.Unit, t: u8, my: []const Cell) bool {
            const e = &st_.units[t];
            if (!e.in_holder or e.isDead() or e.isHidden() or engine.cowardBarred(st_, att, e)) return false;
            const ec = engine.unitCells(e);
            return util.footprintsNear(ec.slice(), my);
        }
    };
    if (u.target >= 0 and u.target != @as(i8, @intCast(strike.target))) {
        const f: u8 = @intCast(u.target);
        if (s.units[f].in_holder and !s.units[f].isDead()) {
            if (Strikable.ok(s, u, f, mine.slice())) return inPlaceStrike(c, out, f);
            return ai.fallbackTurn(c, out);
        }
    }
    const t = &s.units[strike.target];
    const moves = !ai.sameCell(strike.attack_from, engine.baseCell(u));
    if (!t.in_holder or t.isDead() or t.isHidden() or engine.cowardBarred(s, u, t) or (moves and !u.canMove())) {
        if (u.target >= 0) return ai.fallbackTurn(c, out);
        const opp = engine.opposite(u.team);
        for (s.holderOrder()) |k| {
            if (s.units[k].team != opp or u.cannotAttack(s.units[k].uid)) continue;
            if (Strikable.ok(s, u, k, mine.slice())) return inPlaceStrike(c, out, k);
        }
        return ai.fallbackTurn(c, out);
    }
}

/// waitForMassBuff (V04_BUFFWAIT, on; the Ogre and Behemoth self-delays are off): on lap 1 a unit without a strike or cast
/// waits while its army's Behemoth roar (no living ally carries Battle Roar yet, unless range-heavy) or Ogre Mage riot
/// (no living ally carries Mass Riot or Riot yet) is still pending.
fn waitForMassBuff(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    if (s.fight.lap > 1) return;
    if (util.strikes(out)) return;
    const team = c.unit().team;
    var ranged: usize = 0;
    var behemoth = false;
    var ogre = false;
    var roared = false;
    var rioted = false;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (!util.livingOf(s, i, team)) continue;
        if (a.attack_type == AT.RANGE) ranged += 1;
        if (a.buffs.find(.battle_roar) != null) roared = true;
        if (a.buffs.find(.mass_riot) != null or a.buffs.find(.riot) != null) rioted = true;
        switch (util.creature(s, @intCast(i))) {
            .behemoth => behemoth = true,
            .ogre_mage => ogre = true,
            else => {},
        }
    }
    const roar_pending = ranged < 3 and behemoth and !roared;
    const riot_pending = ogre and !rioted;
    const me = util.creature(c.s, c.ui);
    const wait = (roar_pending and me != .behemoth) or (riot_pending and me != .ogre_mage);
    if (wait and util.canHourglass(s, c.ui)) util.setWait(out, c.ui);
}

fn isPureAdvance(d: *const ai.Decision) bool {
    if (!util.has(d, .move_unit)) return false;
    for (d.slice()) |a| if (a != .move_unit and a != .select_attack_type) return false;
    return true;
}

/// v08HasStrongerRangedPosture (obstacle attacks and casts are out of scope).
fn hasStrongerRangedPosture(c: *const ai.Ctx, d: *const ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (u.attack_type != AT.MELEE or engine.isRangeCapable(u) or !u.canMove()) return false;
    if (util.combatAction(d)) return false;
    if (util.dominantFinishState(s, u.team).active) return false;
    return util.teamRangedOutput(s, u.team) > util.teamRangedOutput(s, engine.opposite(u.team));
}

const Front = union(enum) { keep, wait, move: *const pathing.Route };

/// StrategyV0_4.frontMove (V04_FRONTMOVE, on): a melee unit of a range-heavy army (3+ living shooters) without a
/// strike waits while its side out-guns theirs; otherwise a Unicorn or Scavenger leads toward the nearest enemy.
fn v04FrontMove(c: *ai.Ctx, d: *const ai.Decision) Front {
    const s = c.s;
    const u = c.unit();
    if (u.attack_type != AT.MELEE or !u.canMove()) return .keep;
    const opp = engine.opposite(u.team);
    var my_ranged: usize = 0;
    var enemies: [st.MAX_UNITS]Cell = undefined;
    var n_enemies: usize = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (util.livingOf(s, i, u.team) and a.attack_type == AT.RANGE) my_ranged += 1;
        if (util.livingOf(s, i, opp)) {
            enemies[n_enemies] = engine.baseCell(a);
            n_enemies += 1;
        }
    }
    if (my_ranged < 3) return .keep;
    if (util.strikes(d)) return .keep;
    if (n_enemies == 0) return .keep;
    if (util.teamRangedOutput(s, u.team) > util.teamRangedOutput(s, opp)) {
        return if (util.canHourglass(s, c.ui)) .wait else .keep;
    }
    switch (util.creature(c.s, c.ui)) {
        .unicorn, .scavenger => {},
        else => return .keep,
    }
    const Nearest = struct {
        fn of(cell: Cell, targets: []const Cell) f64 {
            var best = std.math.inf(f64);
            for (targets) |t| best = @min(best, ai.cellDistance(cell, t));
            return best;
        }
    };
    const mp = c.actualPath();
    var best: ?*const pathing.Route = null;
    var best_dist = Nearest.of(engine.baseCell(u), enemies[0..n_enemies]);
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        if (mp.routeCells(r, &buf) == 0) continue;
        const dd = Nearest.of(r.cell, enemies[0..n_enemies]);
        if (dd < best_dist) {
            best_dist = dd;
            best = r;
        }
    }
    return if (best) |r| .{ .move = r } else .keep;
}

/// StrategyV0_8.frontMove: hold for a stronger ranged posture; never let v0.4's proxy turn a pure advance into a wait.
fn frontMove(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const stronger = hasStrongerRangedPosture(c, out);
    if (stronger and util.canHourglass(s, c.ui)) return util.setWait(out, c.ui);
    const inherited = v04FrontMove(c, out);
    switch (inherited) {
        .keep => {},
        .wait => {
            if (!stronger and isPureAdvance(out)) return;
            util.setWait(out, c.ui);
        },
        .move => |r| util.setMove(out, s, c.ui, c.actualPath(), r),
    }
}

// =====================================================================================================================
// enforceRangeLegality
// =====================================================================================================================

const Edge = struct { cell: Cell, side: u8 };

/// resolveRangeAttackAimEdge: the requested edge if observable, else the observable edge nearest the attacker (the
/// shot's Through Shot / ignores-structures flags in the side test).
fn resolveAimEdge(s: *const State, att: *const st.Unit, tgt: *const st.Unit, aim_cell: ?Cell, aim_side: u8, through: bool, ignores: bool) ?Edge {
    const cells = engine.unitCells(tgt);
    if (aim_cell) |ac| {
        for (cells.slice()) |cl| {
            if (cl.x == ac.x and cl.y == ac.y and aim_side < 4 and combat.sideObservableEx(s, cl, aim_side, att.team, through, ignores)) return .{ .cell = cl, .side = aim_side };
        }
    }
    var best: ?Edge = null;
    var best_d: f64 = 0;
    for (cells.slice()) |cl| {
        for ([_]u8{ 0, 1, 2, 3 }) |side| {
            if (!combat.sideObservableEx(s, cl, side, att.team, through, ignores)) continue;
            const p = combat.sideCenter(cl, side, att.pos_x, att.pos_y);
            const d = engine.distance(att.pos_x, att.pos_y, p[0], p[1]);
            if (best == null or d < best_d) {
                best = .{ .cell = cl, .side = side };
                best_d = d;
            }
        }
    }
    return best;
}

/// rangeShotLands (requireResolvedPrimaryRangeTarget: true): the target alive and not Hidden, the shot landable
/// (canLandRangeAttack), a selectable aim edge (not for a Through Shot), and the engine's evaluation of the resolved
/// aim (Through Shot's line, a splash shooter's rings) leading with a living enemy the unit may hit: not a lone Hidden
/// group, not Cowardice-barred, the forced target if one lives, not the gazer.
fn rangeShotLands(c: *const ai.Ctx, shot: anytype) bool {
    const s = c.s;
    const u = c.unit();
    const target = &s.units[shot.target];
    if (!target.in_holder or target.isDead() or target.isHidden()) return false;
    if (!engine.canLandRangeAttack(s, u)) return false;
    const from = [2]f64{ u.pos_x, u.pos_y };
    const through = u.has(.through_shot);
    const aoe = combat.isSplashShooter(u);
    if (!through) {
        const edge = resolveAimEdge(s, u, target, shot.aim_cell, shot.aim_side, through, aoe) orelse return false;
        if (!util.sideSelectableEx(s, edge.cell, edge.side, from, .{ target.pos_x, target.pos_y }, engine.isSmall(u), engine.isSmall(target), u.team, through, aoe)) return false;
    }
    // resolveRangeTargetPosition, replicated: the aim cell (else the target cell nearest the attacker), then the aim
    // side if observable (else the observable side nearest the attacker).
    const cells = engine.unitCells(target);
    var cell: ?Cell = null;
    if (shot.aim_cell) |ac| {
        for (cells.slice()) |cl| if (cl.x == ac.x and cl.y == ac.y) {
            cell = cl;
            break;
        };
    }
    if (cell == null) {
        var best_d: f64 = std.math.floatMax(f64);
        for (cells.slice()) |cl| {
            const p = engine.positionForCell(@floatFromInt(cl.x), @floatFromInt(cl.y));
            const d = engine.distance(from[0], from[1], p[0], p[1]);
            if (d < best_d) {
                best_d = d;
                cell = cl;
            }
        }
    }
    const cl = cell orelse return false;
    var sides: [4]u8 = undefined;
    var n_sides: usize = 0;
    for ([_]u8{ 0, 1, 2, 3 }) |side| {
        if (combat.sideObservableEx(s, cl, side, u.team, through, aoe)) {
            sides[n_sides] = side;
            n_sides += 1;
        }
    }
    var to = [2]f64{ target.pos_x, target.pos_y };
    if (n_sides > 0) {
        var side = sides[0];
        var requested = false;
        if (shot.aim_cell != null) {
            for (sides[0..n_sides]) |sd| if (sd == shot.aim_side) {
                requested = true;
            };
        }
        if (requested) {
            side = shot.aim_side;
        } else {
            var best_d: f64 = std.math.floatMax(f64);
            for (sides[0..n_sides]) |sd| {
                const p = combat.sideCenter(cl, sd, from[0], from[1]);
                const d = engine.distance(from[0], from[1], p[0], p[1]);
                if (d < best_d) {
                    best_d = d;
                    side = sd;
                }
            }
        }
        to = combat.sideCenter(cl, side, from[0], from[1]);
    }
    var g: combat.Groups = undefined;
    combat.evaluateGroups(&g, s, c.ui, from[0], from[1], to[0], to[1], through, aoe);
    if (g.n == 0) return false;
    const fi = g.first(0);
    const first = &s.units[fi];
    if (first.isDead() or first.team == u.team) return false;
    if (g.n == 1 and first.isHidden()) return false;
    if (engine.cowardBarred(s, u, first)) return false;
    if (u.target >= 0 and u.target != @as(i8, @intCast(fi))) {
        const f = &s.units[@intCast(u.target)];
        if (f.in_holder and !f.isDead()) return false;
    }
    if (u.cannotAttack(first.uid)) return false;
    return true;
}

/// Final range-legality guard: a shot that would not land becomes v0.1's fallback advance.
fn enforceRangeLegality(c: *ai.Ctx, out: *ai.Decision) void {
    for (out.slice()) |a| {
        if (a == .range_attack) {
            if (!rangeShotLands(c, a.range_attack)) ai.fallbackTurn(c, out);
            return;
        }
    }
}
