//! v0.8's own passes (src/ai/versions/v0_8.ts StrategyV0_8.decideTurn), after the inherited chain v0.1 ... v0.7.
//! Each pass takes the previous pass's decision and returns its own; `runPass` runs one ported pass on any input, which
//! is how `hoc-sim v08 layers --passes` checks a pass in isolation on the recorded input (the logged layer before it).
//! Passes not ported yet return false from `runPass`; the check then skips them.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const cand = @import("cand.zig");
const fuse = @import("fuse.zig");
const firewall = @import("fire.zig");
const engine = @import("../engine.zig");
const path = @import("../path.zig");
const js = @import("../jsnum.zig");
const AT = st.AttackType;
const abilities = @import("../abilities.zig");
const combat = @import("../combat.zig");
const artifacts = @import("../artifacts.zig");
const spells = @import("../spells.zig");

/// The recorder's pass names, in decideTurn's order (zig/parity/v08/layers.ts).
pub const Pass = enum {
    explicit,
    prioritize,
    defend_to_wait,
    finish,
    ranged_positioning,
    forbidden_target,
    splash,
    damage_spell,
    vine,
    smoke,
    nightmare,
    healer,
    blacksmith,
    ranked_replay,
    backline_protector,
    backline_ward,
    cemetery,
    coherent_melee,
};

pub fn passFromName(n: []const u8) ?Pass {
    const names = [_]struct { []const u8, Pass }{
        .{ "explicit", .explicit },
        .{ "prioritize", .prioritize },
        .{ "defend-to-wait", .defend_to_wait },
        .{ "finish", .finish },
        .{ "ranged-positioning", .ranged_positioning },
        .{ "forbidden-target", .forbidden_target },
        .{ "splash", .splash },
        .{ "damage-spell", .damage_spell },
        .{ "vine", .vine },
        .{ "smoke", .smoke },
        .{ "nightmare", .nightmare },
        .{ "healer", .healer },
        .{ "blacksmith", .blacksmith },
        .{ "ranked-replay", .ranked_replay },
        .{ "backline-protector", .backline_protector },
        .{ "backline-ward", .backline_ward },
        .{ "cemetery", .cemetery },
        .{ "coherent-melee", .coherent_melee },
    };
    for (names) |e| if (std.mem.eql(u8, n, e[0])) return e[1];
    return null;
}

/// Loads a recorded action list into a Decision (paths copied into the decision's own buffers).
pub fn fromActions(d: *ai.Decision, actions: []const rec.Action) bool {
    d.* = .{};
    var path_used: usize = 0;
    var target_used: usize = 0;
    for (actions) |a| {
        if (d.n >= d.actions.len) return false;
        var x = a;
        switch (x) {
            .move_unit => |*m| {
                if (path_used + m.path.len > d.path.len or target_used + m.target_cells.len > d.targets.len) return false;
                @memcpy(d.path[path_used .. path_used + m.path.len], m.path);
                m.path = d.path[path_used .. path_used + m.path.len];
                path_used += m.path.len;
                @memcpy(d.targets[target_used .. target_used + m.target_cells.len], m.target_cells);
                m.target_cells = d.targets[target_used .. target_used + m.target_cells.len];
                target_used += m.target_cells.len;
            },
            .melee_attack => |*m| {
                if (path_used + m.path.len > d.path.len) return false;
                @memcpy(d.path[path_used .. path_used + m.path.len], m.path);
                m.path = d.path[path_used .. path_used + m.path.len];
                path_used += m.path.len;
            },
            .obstacle_attack => |*o| {
                if (path_used + o.path.len > d.path.len) return false;
                @memcpy(d.path[path_used .. path_used + o.path.len], o.path);
                o.path = d.path[path_used .. path_used + o.path.len];
                path_used += o.path.len;
            },
            else => {},
        }
        d.push(x);
    }
    return true;
}

/// ensureExplicitV08Action: a decision with nothing but attack-type selections and end-turn markers becomes a defend.
pub fn explicit(ui: u8, in: *const ai.Decision, out: *ai.Decision) void {
    for (in.slice()) |a| switch (a) {
        .select_attack_type, .end_turn => {},
        else => {
            util.copyDecision(out, in);
            return;
        },
    };
    out.* = .{};
    out.push(.{ .defend_turn = .{ .unit = ui } });
}

/// The defend-to-wait step of decideTurn: a defend with no productive action becomes a wait when the hourglass allows.
pub fn defendToWait(s: *const st.State, ui: u8, in: *const ai.Decision, out: *ai.Decision) void {
    var defends = false;
    var productive = false;
    for (in.slice()) |a| switch (a) {
        .defend_turn => defends = true,
        .move_unit, .melee_attack, .range_attack => productive = true,
        else => {},
    };
    if (defends and !productive and util.canHourglass(s, ui)) {
        util.setWait(out, ui);
        return;
    }
    util.copyDecision(out, in);
}

/// isV08DirectCombatDecision: a melee or ranged attack (area throws are out of scope).
fn isDirectCombat(actions: []const rec.Action) bool {
    for (actions) |a| switch (a) {
        .melee_attack, .range_attack, .area_throw_attack => return true,
        else => {},
    };
    return false;
}

fn moves(actions: []const rec.Action) bool {
    for (actions) |a| if (a == .move_unit) return true;
    return false;
}

/// selectV08DirectCombatCandidate: among melee and shot candidates with positive expected damage, a kill first, then
/// the most damage, then one that does not move (first wins ties).
fn selectDirectCombat(set: *const cand.Set) ?usize {
    var best: ?usize = null;
    for (set.slice(), 0..) |*c, i| {
        if (c.kind != .melee and c.kind != .shot and c.kind != .throw) continue;
        if (!isDirectCombat(c.d.slice())) continue;
        if (!std.math.isFinite(c.ed) or c.ed <= 0) continue;
        if (best) |b| {
            const bb = &set.items[b];
            if (c.ek > bb.ek or (c.ek == bb.ek and (c.ed > bb.ed or (c.ed == bb.ed and moves(bb.d.slice()) and !moves(c.d.slice()))))) best = i;
        } else best = i;
    }
    return best;
}

/// selectV08ProductiveCandidate: direct combat, else the first move, else the first spell.
fn selectProductive(set: *const cand.Set) ?usize {
    if (selectDirectCombat(set)) |i| return i;
    for (set.slice(), 0..) |*c, i| if (c.kind == .move) return i;
    for (set.slice(), 0..) |*c, i| if (c.kind == .spell) return i;
    return null;
}

/// attacksForbiddenTarget: a melee or a shot aimed at the Terrifying Gaze gazer (cannotAttackUnitId).
pub fn attacksForbidden(s: *const st.State, u: *const st.Unit, acts: []const rec.Action) bool {
    for (acts) |a| switch (a) {
        .melee_attack => |m| if (u.cannotAttack(s.units[m.target].uid)) return true,
        .range_attack => |r| if (u.cannotAttack(s.units[r.target].uid)) return true,
        else => {},
    };
    return false;
}

/// A copy of `set` without the candidates that attack the gazer (the order kept).
fn withoutForbidden(s: *const st.State, u: *const st.Unit, set: *const cand.Set, out: *cand.Set) void {
    out.* = .{ .incomplete = set.incomplete };
    for (set.slice()) |*cd| {
        if (attacksForbidden(s, u, cd.d.slice())) continue;
        out.items[out.n] = cd.*;
        util.copyDecision(&out.items[out.n].d, &cd.d);
        out.n += 1;
    }
}

/// repairV08ForbiddenTargetDecision: an attack on the gazer is re-enumerated from an end-turn incumbent (the boundary
/// candidates) without the gazer: the productive pick, else a wait, else a defend, else ending the turn.
fn forbiddenTarget(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (u.forbidden == st.NO_UID or !attacksForbidden(s, u, in.slice())) {
        util.copyDecision(out, in);
        return true;
    }
    var inc: ai.Decision = .{};
    inc.push(.{ .end_turn = .{ .unit = c.ui, .reason = .manual } });
    var all: cand.Set = .{};
    cand.enumerate(c, &inc, cand.BOUNDARY, &all);
    if (all.incomplete) return false;
    var set: cand.Set = .{};
    withoutForbidden(s, u, &all, &set);
    if (selectProductive(&set)) |i| {
        take(out, &set, i);
        return true;
    }
    for ([_]cand.Kind{ .wait, .defend }) |k| {
        for (set.slice(), 0..) |*cd, i| if (cd.kind == k) {
            take(out, &set, i);
            return true;
        };
    }
    util.setEndTurn(out, c.ui);
    return true;
}

/// prioritizeV08SplashRangedDecision: a splash shooter (Area Throw, Large Caliber) or a Through Shot unit
/// (V08_THROUGH_SHOT_LINE unset: on) whose decision shoots or throws takes the shot or area throw with the most priced
/// damage over its whole uncapped catalog (free Through Shot lines included), when that beats the priced incumbent.
/// An army holding Last Fuse runs it too (the blast prices single impacts).
fn splashRanged(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const u = c.unit();
    const through = u.has(.through_shot);
    // Area Throw, Large Caliber, a Through Shot line, or an army holding Last Fuse (its blast prices single impacts).
    if (!(u.has(.area_throw) or u.has(.large_caliber) or through or u.buffs.find(.last_fuse) != null)) return util.copyDecision(out, in);
    if (!util.has(in, .range_attack) and !util.has(in, .area_throw_attack)) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    // enumerateCandidates({maxMoveDestinations: 1, maxMeleePairs: 1, enrichIncumbentMetadata, throughShotFreeAim}): only
    // its shots and area throws are read (and only they can be twins of the ranged incumbent), so the port keeps the
    // incumbent and the best of them (cand.Options.ranged_best).
    cand.enumerate(c, in, .{ .ranged_best = true, .enrich = true, .through_free_aim = through }, &set);
    const inc = &set.items[0];
    if (inc.target < 0 or !std.math.isFinite(inc.ed)) return util.copyDecision(out, in);
    var best: ?usize = null;
    for (set.slice(), 0..) |*cd, i| {
        if (cd.kind != .shot and cd.kind != .throw) continue;
        if (!isDirectCombat(cd.d.slice()) or !std.math.isFinite(cd.ed)) continue;
        if (best == null or cd.ed > set.items[best.?].ed) best = i;
    }
    if (best) |b| {
        if (set.items[b].ed > inc.ed) return take(out, &set, b);
    }
    util.copyDecision(out, in);
}

/// The unit's book spell `raw`, when it may cast it now (isSpellUsableByCaster), with its config.
fn usableBookSpell(s: *const st.State, u: *const st.Unit, raw: u8) ?*const st.SpellConfig {
    for (u.spells[0..u.n_spells]) |*b| {
        if (b.spell != raw) continue;
        const cfg = &s.spell_cfg[raw];
        return if (cfg.loaded and spells.usable(u, b, cfg)) cfg else null;
    }
    return null;
}

/// immediateDamagePrecedes: a kill first, then more damage.
inline fn damagePrecedes(a: *const cand.Candidate, b: *const cand.Candidate) bool {
    return a.ek > b.ek or (a.ek == b.ek and a.ed > b.ed);
}

/// selectV08DamageSpellCandidate: among candidates casting an offensive spell (UNIT_AMOUNT_DAMAGE) the unit may cast
/// now, with finite positive damage, the first kill, else the most damage.
fn selectDamageSpell(s: *const st.State, u: *const st.Unit, set: *const cand.Set) ?usize {
    var best: ?usize = null;
    for (set.slice(), 0..) |*cd, i| {
        var cast: ?u8 = null;
        for (cd.d.slice()) |a| if (a == .cast_spell) {
            cast = a.cast_spell.spell;
            break;
        };
        const raw = cast orelse continue;
        if (!std.math.isFinite(cd.ed) or cd.ed <= 0) continue;
        const cfg = usableBookSpell(s, u, raw) orelse continue;
        if (cfg.multiplier != st.SpellMultiplier.UNIT_AMOUNT_DAMAGE) continue;
        if (best == null or damagePrecedes(cd, &set.items[best.?])) best = i;
    }
    return best;
}

/// prioritizeV08DamageSpell: a unit holding a usable damage spell casts the best one (the boundary candidates) unless
/// the decision is a priced direct attack that it does not beat (a kill first, then damage).
fn damageSpell(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    var any = false;
    for (u.spells[0..u.n_spells]) |b| {
        const cfg = usableBookSpell(s, u, b.spell) orelse continue;
        if (cfg.multiplier == st.SpellMultiplier.UNIT_AMOUNT_DAMAGE) any = true;
    }
    if (!any) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY, &set);
    const b = selectDamageSpell(s, u, &set) orelse return util.copyDecision(out, in);
    const inc = &set.items[0];
    const priced_direct = isDirectCombat(inc.d.slice()) and std.math.isFinite(inc.ed) and inc.ed > 0;
    if (!priced_direct or damagePrecedes(&set.items[b], inc)) return take(out, &set, b);
    util.copyDecision(out, in);
}

/// v08VineTargetPressure: alive x max damage x steps (each finite and at least 0).
fn vinePressure(t: *const st.Unit) f64 {
    const f = struct {
        fn nn(x: f64) f64 {
            return if (std.math.isFinite(x)) @max(0, x) else 0;
        }
    };
    return f.nn(t.amount_alive) * f.nn(t.attack_damage_max) * f.nn(engine.getSteps(t));
}

/// prioritizeV08VineThrow: a unit with a usable Vine Throw, on a turn that neither waits, attacks nor casts, outside
/// the dominant-finish window, throws at the boundary candidate's living target with the most pressure (then a grounded
/// one, then the lower magic resist; first on ties).
fn vineThrow(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const vine: u8 = @intFromEnum(st.CastSpell.vine_throw);
    if (usableBookSpell(s, u, vine) == null) return util.copyDecision(out, in);
    for (in.slice()) |a| switch (a) {
        .wait_turn, .melee_attack, .range_attack, .area_throw_attack, .cast_spell => return util.copyDecision(out, in),
        else => {},
    };
    if (util.dominantFinishState(s, u.team).active) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY, &set);
    var best: ?usize = null;
    for (set.slice(), 0..) |*cd, i| {
        if (cd.kind != .spell or cd.spell != vine or cd.target < 0) continue;
        const t = &s.units[@intCast(cd.target)];
        if (t.isDead()) continue;
        const bi = best orelse {
            best = i;
            continue;
        };
        const bt = &s.units[@intCast(set.items[bi].target)];
        const pressure = vinePressure(t) - vinePressure(bt);
        const grounded = @as(i32, @intFromBool(!engine.canFly(t))) - @as(i32, @intFromBool(!engine.canFly(bt)));
        const resistance = engine.getMagicResist(bt) - engine.getMagicResist(t);
        if (pressure > 0 or (pressure == 0 and (grounded > 0 or (grounded == 0 and resistance > 0)))) best = i;
    }
    if (best) |i| return take(out, &set, i);
    util.copyDecision(out, in);
}

// ---- the Healer's sustain role (v0_8_support_roles.ts prioritizeV08HealerSustain) ----

/// isV08DurableHealAnchor: an Abomination, Frenzied Boar or Goblin Knight, or an Angel doing its ranged-line job (its
/// backline protector intent is the Angel's).
fn durableHealAnchor(s: *const st.State, ui: u8) bool {
    return switch (util.creature(s, ui)) {
        .abomination, .frenzied_boar, .goblin_knight => true,
        .angel => if (protectorIntent(s, ui)) |it| it.kind == .angel else false,
        else => false,
    };
}

/// effectiveFrontHeal: what a heal of `raw` restores on the top creature.
inline fn frontHeal(t: *const st.Unit, raw: f64) f64 {
    return @max(0, @min(raw, t.max_hp - t.hp));
}

/// singleHealValue: the restored HP (x3 on a durable anchor) times 1 + the missing fraction of the top creature; 0 for
/// nothing to restore, a trivial heal, or a body below level 3 that is not an anchor and misses under 60%.
fn singleHealValue(s: *const st.State, ti: u8, raw: f64) f64 {
    const t = &s.units[ti];
    const effective = frontHeal(t, raw);
    const trivial = effective < raw * 0.05 and t.max_hp - t.hp < t.max_hp * 0.05;
    if (effective <= 0 or trivial) return 0;
    const missing = @max(0, t.max_hp - t.hp) / @max(1, t.max_hp);
    const anchor = durableHealAnchor(s, ti);
    if (!(anchor or t.level >= 3) and missing < 0.6) return 0;
    return effective * @as(f64, if (anchor) 3 else 1) * (1 + missing);
}

/// incumbentGuaranteedKill: candidate 0 is a priced direct attack that kills, on a target that cannot absorb it
/// (util.canAbsorbPrimary: a Water Shield the striker cannot pass, a Flesh Shield Aura), and with a melee strike only
/// when the target can neither answer it nor burn the striker with Fire Shield (a striker without Fire Element and
/// magic resist below 100). With V08_MAGE_DAMAGE_KILL_PRIORITY_<SIDE>=1 (util.Switches.mage_damage_kill_priority) a
/// priced kill by an offensive spell of the unit's (UNIT_AMOUNT_DAMAGE) counts too, its target's absorb unchecked.
fn incumbentGuaranteedKill(c: *const ai.Ctx, set: *const cand.Set) bool {
    if (set.n == 0) return false;
    const inc = &set.items[0];
    const u = c.unit();
    var damage_spell = false;
    if (util.battle.switches[u.team].mage_damage_kill_priority and inc.spell >= 0) {
        const raw: u8 = @intCast(inc.spell);
        for (u.spells[0..u.n_spells]) |b| {
            if (b.spell == raw and c.s.spell_cfg[raw].multiplier == st.SpellMultiplier.UNIT_AMOUNT_DAMAGE) damage_spell = true;
        }
    }
    if (!(isDirectCombat(inc.d.slice()) or damage_spell) or inc.ek != 1 or !(inc.ed > 0)) return false;
    if (inc.target >= 0) {
        const t = &c.s.units[@intCast(inc.target)];
        if (!damage_spell and util.canAbsorbPrimary(u, t)) return false;
        if (util.has(&inc.d, .melee_attack)) {
            if (util.canRespondToMelee(c.s, c.ui, @intCast(inc.target))) return false;
            if (t.has(.fire_shield) and !u.has(.fire_element) and engine.getMagicResist(u) < 100) return false;
        }
    }
    return true;
}

/// prioritizeV08WanderingMageSmoke: a Wandering Mage outside the dominant finish takes the first Smoke candidate
/// (SUPPORT candidates; addSmoke only offers a cloud that prevents more enemy than friendly ranged damage) unless the
/// decision is a guaranteed kill. V08_ROLE_RELEASE is unset.
fn wanderingMageSmoke(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    if (util.creature(s, c.ui) != .wandering_mage or util.dominantFinishState(s, c.unit().team).active) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.SUPPORT, &set);
    if (incumbentGuaranteedKill(c, &set)) return util.copyDecision(out, in);
    const smoke_raw: i16 = @intFromEnum(st.CastSpell.smoke);
    for (set.slice(), 0..) |*cd, i| {
        if (cd.spell == smoke_raw) return take(out, &set, i);
    }
    util.copyDecision(out, in);
}

/// prioritizeV08NightmareFireWall: a Nightmare whose decision is an advance or a passive turn (no wait, cast, strike, shot
/// or area throw in it), outside the dominant finish, takes the first Fire Wall candidate of the support catalog.
fn nightmareFireWall(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    if (util.creature(s, c.ui) != .nightmare) return util.copyDecision(out, in);
    for (in.slice()) |a| switch (a) {
        .wait_turn, .cast_spell, .melee_attack, .range_attack, .area_throw_attack => return util.copyDecision(out, in),
        else => {},
    };
    if (util.dominantFinishState(s, c.unit().team).active) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.SUPPORT, &set);
    const fire_wall: i16 = @intFromEnum(st.CastSpell.fire_wall);
    for (set.slice(), 0..) |*cd, i| {
        if (cd.spell == fire_wall) return take(out, &set, i);
    }
    util.copyDecision(out, in);
}

/// prioritizeV08BlacksmithCraft: a Blacksmith holding a usable Craft, outside the dominant finish and without a proven
/// immediate kill, takes the Craft candidate (CRAFT catalog, the incumbent included) whose block reaches the most living
/// allies, then the most recipient value (summed in id order), then the earliest; with at least two recipients, else
/// the decision stands. V08_ROLE_RELEASE is unset.
fn blacksmithCraft(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (util.creature(s, c.ui) != .blacksmith) return util.copyDecision(out, in);
    const craft_raw: u8 = @intFromEnum(st.CastSpell.craft);
    var usable = false;
    for (u.spells[0..u.n_spells]) |*b| {
        if (b.spell == craft_raw and spells.usable(u, b, &s.spell_cfg[b.spell])) {
            usable = true;
            break;
        }
    }
    if (!usable) return util.copyDecision(out, in);
    if (util.dominantFinishState(s, u.team).active or blacksmithGuaranteedKill(c, in)) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.CRAFT, &set);
    var best: ?usize = null;
    var best_count: usize = 0;
    var best_value: f64 = 0;
    for (set.slice(), 0..) |*cd, i| {
        const anchor = craftAnchor(&cd.d, craft_raw) orelse continue;
        var recipients: [st.MAX_UNITS]u8 = undefined;
        const n = cand.craftRecipients(s, u.team, anchor, &recipients);
        var value: f64 = 0;
        for (recipients[0..n]) |r| value = @min(9007199254740991.0, value + craftRecipientValue(s, &s.units[r]));
        if (best == null or n > best_count or (n == best_count and value > best_value)) {
            best = i;
            best_count = n;
            best_value = value;
        }
    }
    if (best) |i| {
        if (best_count >= 2) return take(out, &set, i);
    }
    util.copyDecision(out, in);
}

/// craftAction: the decision's first Craft cast with a target cell.
fn craftAnchor(d: *const ai.Decision, craft_raw: u8) ?rec.Cell {
    for (d.slice()) |a| {
        if (a == .cast_spell and a.cast_spell.spell == craft_raw and a.cast_spell.has_cell) return a.cast_spell.cell;
    }
    return null;
}

/// v08BlacksmithCraftRecipientValue: the stack's remaining output (one activation per remaining shot for a shooter,
/// else one), 60% of it when Craft's double roll would duplicate an active double (Double Shot for a stack with shots,
/// else Double Punch or its crafted copy), plus min(999, cumulative HP) / 1000 as a durability tie-break.
fn craftRecipientValue(s: *const st.State, x: *const st.Unit) f64 {
    _ = s;
    const amount = finitePositive(x.amount_alive);
    const per = amount * finitePositive(x.attack_damage_max);
    const activations: f64 = if (engine.isRangeCapable(x)) @max(1, finitePositive(engine.getRangeShots(x))) else 1;
    const output = per * activations;
    const doubled = if (engine.getRangeShots(x) > 0)
        combat.doubleShotAbility(x) != null
    else
        x.has(.double_punch) or x.has(.crafted_double_punch);
    const marginal = output * @as(f64, if (doubled) 0.6 else 1);
    const tie = @min(999, finitePositive(util.cumulativeHp(x))) / 1000;
    return @min(9007199254740991.0, marginal + tie);
}

fn finitePositive(v: f64) f64 {
    return if (std.math.isFinite(v)) @max(0, v) else 0;
}

/// isV08BlacksmithImmediateGuaranteedKill: a stationary strike from the base cell (no move in the decision) on a living
/// enemy that cannot absorb it (util.canAbsorbPrimary), cannot miss, and whose minimum damage (the team's synergy power)
/// covers the stack's health.
fn blacksmithGuaranteedKill(c: *const ai.Ctx, d: *const ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (util.has(d, .move_unit)) return false;
    const base = engine.baseCell(u);
    var target: ?u8 = null;
    for (d.slice()) |a| {
        if (a == .melee_attack and a.melee_attack.attacker == c.ui and a.melee_attack.attack_from.x == base.x and a.melee_attack.attack_from.y == base.y) {
            target = a.melee_attack.target;
            break;
        }
    }
    const ti = target orelse return false;
    const t = &s.units[ti];
    if (!t.in_holder or t.isDead() or t.team == u.team) return false;
    if (util.canAbsorbPrimary(u, t)) return false;
    if (abilities.missChance(u, t) > 0) return false;
    const minimum = combat.damageBoundSyn(u, t, u.attack_damage_min, false, 1, s.setup[u.team].ability_power);
    return minimum >= util.cumulativeHp(t);
}

/// The power of the unit's first book spell `raw` (0 without it).
fn bookSpellPower(s: *const st.State, u: *const st.Unit, raw: u8) ?*const st.SpellConfig {
    for (u.spells[0..u.n_spells]) |b| {
        if (b.spell == raw) return &s.spell_cfg[raw];
    }
    return null;
}

/// prioritizeV08HealerSustain: unless the decision is a guaranteed kill, a Healer casts Mass Heal when its candidate
/// exists and it restores two or more bodies for more than both the best Heal and the best Blessing, else the Blessing
/// worth more than its best Heal, else that Heal, else Spiritual Armor on the biggest live health pool (x3 on a durable
/// anchor), else the decision (SUPPORT candidates). A Heal is priced by singleHealValue at the caster's healing power
/// (no Holy Cross; it is disabled); Mass Heal by massHealValue; a Blessing by the target's best direct attack (its own
/// candidates from an empty incumbent, the most expected damage first) x (max - min) / (max + min) x min(2, the spell's
/// laps) turns (a shot or a throw capped by its shots unless Endless Quiver), skipping a target that is Blessed or
/// Stunned. V08_ROLE_RELEASE is unset.
fn healerSustain(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (util.creature(s, c.ui) != .healer) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.SUPPORT, &set);
    if (incumbentGuaranteedKill(c, &set)) return util.copyDecision(out, in);
    const heal_raw: u8 = @intFromEnum(st.CastSpell.heal);
    const heal_power: f64 = if (bookSpellPower(s, u, heal_raw)) |cfg| cfg.power else 0;
    const raw = @floor(heal_power * @max(0, u.amount_alive) * 1 * spells.moraleMultiplier(.heal, u.attack_multiplier));
    var single: ?usize = null;
    var single_value: f64 = 0;
    for (set.slice(), 0..) |*cd, i| {
        if (cd.spell != heal_raw or cd.target < 0) continue;
        const t: u8 = @intCast(cd.target);
        const v = singleHealValue(s, t, raw);
        if (!(v > 0)) continue;
        if (single) |b| {
            const bt: u8 = @intCast(set.items[b].target);
            if (!(v > single_value or (v == single_value and durableHealAnchor(s, t) and !durableHealAnchor(s, bt)))) continue;
        }
        single = i;
        single_value = v;
    }
    const bless_raw: u8 = @intFromEnum(st.CastSpell.blessing);
    const laps: f64 = @min(2, if (bookSpellPower(s, u, bless_raw)) |cfg| cfg.laps else 0);
    var bless: ?usize = null;
    var bless_value: f64 = 0;
    for (set.slice(), 0..) |*cd, i| {
        if (cd.spell != bless_raw or cd.target < 0) continue;
        const ti: u8 = @intCast(cd.target);
        const t = &s.units[ti];
        // a Stun or Blindness effect (support roles read those two, not Freeze)
        if (t.buffs.find(.blessing) != null or t.isStunned() or (t.effects.len != 0 and t.effects.find(.blindness) != null)) continue;
        const mn = t.attack_damage_min;
        const mx = t.attack_damage_max;
        if (mx <= mn or mx + mn <= 0) continue;
        var tc: ai.Ctx = undefined;
        ai.initCtxInto(&tc, s, ti);
        const empty: ai.Decision = .{};
        var attacks: cand.Set = .{};
        cand.enumerate(&tc, &empty, cand.SUPPORT, &attacks);
        var best_attack: ?usize = null;
        for (attacks.slice(), 0..) |*a, j| {
            if (!isDirectCombat(a.d.slice()) or util.has(&a.d, .cast_spell)) continue;
            if (best_attack == null or a.ed > attacks.items[best_attack.?].ed) best_attack = j;
        }
        const j = best_attack orelse continue;
        const attack = &attacks.items[j];
        const ranged = util.has(&attack.d, .range_attack) or util.has(&attack.d, .area_throw_attack);
        const turns = if (ranged and !t.has(.endless_quiver)) @min(laps, engine.getRangeShots(t)) else laps;
        const value = ((attack.ed * (mx - mn)) / (mx + mn)) * turns;
        if (value > 0 and (bless == null or value > bless_value)) {
            bless = i;
            bless_value = value;
        }
    }
    const mass_raw: i16 = @intFromEnum(st.CastSpell.mass_heal);
    for (set.slice(), 0..) |*cd, i| {
        if (cd.spell != mass_raw) continue;
        const mass = massHealValue(s, c.ui);
        const rival = @max(if (single != null) single_value else 0, if (bless != null) bless_value else 0);
        if (mass.recipients >= 2 and mass.value > rival) return take(out, &set, i);
        break;
    }
    if (bless) |i| {
        if (bless_value > (if (single != null) single_value else 0)) return take(out, &set, i);
    }
    if (single) |i| return take(out, &set, i);
    // bestArmor: the first Spiritual Armor candidate with the largest cumulative max HP (x3 on a durable anchor).
    const armor_raw: i16 = @intFromEnum(st.CastSpell.spiritual_armor);
    var armor: ?usize = null;
    var armor_value: f64 = -std.math.inf(f64);
    for (set.slice(), 0..) |*cd, i| {
        if (cd.spell != armor_raw or cd.target < 0) continue;
        const ti: u8 = @intCast(cd.target);
        const t = &s.units[ti];
        const value = t.amount_alive * t.max_hp * @as(f64, if (durableHealAnchor(s, ti)) 3 else 1);
        if (value > armor_value) {
            armor = i;
            armor_value = value;
        }
    }
    if (armor) |i| return take(out, &set, i);
    util.copyDecision(out, in);
}

/// massHealValue: over the caster's team in holder order, every living body that can be healed (no active Mechanism)
/// and is not magic-immune, whose top creature a Mass Heal at the caster's power (spell power x creatures alive x the
/// spell's morale factor, floored; no Holy Cross) restores more than trivially: how many, and the restored HP (x3 on a
/// durable anchor).
fn massHealValue(s: *const st.State, ci: u8) struct { value: f64, recipients: usize } {
    const u = &s.units[ci];
    const raw_id: u8 = @intFromEnum(st.CastSpell.mass_heal);
    const power: f64 = if (bookSpellPower(s, u, raw_id)) |cfg| cfg.power else 0;
    const raw = @floor(power * @max(0, u.amount_alive) * 1 * spells.moraleMultiplier(.mass_heal, u.attack_multiplier));
    var value: f64 = 0;
    var recipients: usize = 0;
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (a.team != u.team or a.isDead() or a.has(.mechanism) or engine.getMagicResist(a) == 100) continue;
        const effective = frontHeal(a, raw);
        const trivial = effective < raw * 0.05 and a.max_hp - a.hp < a.max_hp * 0.05;
        if (effective <= 0 or trivial) continue;
        recipients += 1;
        value += effective * @as(f64, if (durableHealAnchor(s, k)) 3 else 1);
    }
    return .{ .value = value, .recipients = recipients };
}

/// bestV08WardSpell: the spell candidate with a kill first, then the most damage, then the spell name (first on ties).
fn bestWardSpell(set: *const cand.Set) ?usize {
    var best: ?usize = null;
    for (set.slice(), 0..) |*c, i| {
        if (c.kind != .spell) continue;
        if (best) |b| {
            const bb = &set.items[b];
            const name_order = std.mem.order(u8, @as(st.CastSpell, @enumFromInt(@as(u8, @intCast(c.spell)))).name(), @as(st.CastSpell, @enumFromInt(@as(u8, @intCast(bb.spell)))).name());
            if (c.ek > bb.ek or (c.ek == bb.ek and (c.ed > bb.ed or (c.ed == bb.ed and name_order == .lt)))) best = i;
        } else best = i;
    }
    return best;
}

fn take(out: *ai.Decision, set: *const cand.Set, i: usize) void {
    util.copyDecision(out, &set.items[i].d);
}

/// prioritizeV08ProductiveAction: a passive turn (defend, obstacle strike, end turn) becomes the best productive
/// candidate; an already productive decision without an obstacle strike stays.
fn productiveAction(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    var passive = false;
    var productive = false;
    var obstacle = false;
    for (in.slice()) |a| switch (a) {
        .defend_turn, .end_turn => passive = true,
        .obstacle_attack => {
            passive = true;
            obstacle = true;
        },
        .move_unit, .melee_attack, .range_attack, .area_throw_attack, .cast_spell => productive = true,
        else => {},
    };
    if (!passive or (productive and !obstacle)) return util.copyDecision(out, in);
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY, &set);
    if (selectProductive(&set)) |i| return take(out, &set, i);
    util.copyDecision(out, in);
}

/// prioritizeV08Decision: in the dominant-finish window or the final sprint, deal damage now (a commanding army may
/// retarget to more damage; otherwise only a stack kill bypasses the incumbent) or, commanding, advance; at every lap
/// repair a passive incumbent.
pub fn prioritize(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const fs = util.dominantFinishState(c.s, c.unit().team);
    if (fs.active) {
        var set: cand.Set = .{};
        cand.enumerate(c, in, cand.BOUNDARY, &set);
        if (selectDirectCombat(&set)) |i| {
            if (fs.dominant or set.items[i].ek == 1) return take(out, &set, i);
        }
        if (isDirectCombat(in.slice())) return util.copyDecision(out, in);
        if (fs.dominant) {
            for (set.slice(), 0..) |*cd, i| if (cd.kind == .move) return take(out, &set, i);
        }
    }
    productiveAction(c, in, out);
}

const DELIVERY_EPSILON = 1e-9;

/// A melee by the unit who has Dulling Defense permanently cuts a survivor's base attack: extra remaining work.
const DULLING_SWING_WORK_BONUS: f64 = 0.2;

const Delivery = struct {
    cand: usize,
    incumbent: bool,
    ed: f64,
    ek: u8,
    stationary: bool,
    target: u8,
    remaining: f64,
    unsafe_dulling: bool,
    dulling_swing: bool,
    work: f64,
};

/// knightAnswersThisMelee: a Dulling Defense target that will answer this blow.
fn knightAnswers(s: *const st.State, actor: u8, t: u8) bool {
    return s.units[t].has(.dulling_defense) and util.canRespondToMelee(s, actor, t);
}

/// actorDullingSwingCuts: the knight's own non-killing melee still cuts the survivor's base attack.
fn dullingSwingCuts(s: *const st.State, actor: u8, t: u8, melee: bool, ek: u8) bool {
    const a = &s.units[actor];
    return ek == 0 and melee and a.has(.dulling_defense) and util.abilityPower(a, .dulling_defense) > 0 and s.units[t].base_attack > 1;
}

/// targetWork: the hits the target still needs, with one top-creature refill per activation left before Armageddon for
/// a Wild Regeneration stack (TypeScript also reads a Wild Regeneration buff; the gift grants the ability, so the
/// engine has none), taxed when a knight's answer will cut our attack, and raised for the knight's own dulling swing.
fn targetWork(s: *const st.State, actor: u8, t: u8, melee: bool, delivery: f64, ek: u8) f64 {
    const tu = &s.units[t];
    const activations: f64 = @floatFromInt(@max(1, engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON - @max(0, s.fight.lap)));
    const reserve: f64 = if (tu.has(.wild_regeneration)) @max(0, tu.max_hp) * activations else 0;
    const base_work = (@max(0, util.cumulativeHp(tu)) + reserve) / @max(delivery, DELIVERY_EPSILON);
    var work = base_work;
    if (melee and knightAnswers(s, actor, t)) {
        const power = @max(0, util.abilityPower(&s.units[t], .dulling_defense));
        const future = @max(0, @ceil(base_work) - 1);
        const tax = @min(2, (power / @max(1, engine.getAttack(&s.units[actor]))) * (future / 2));
        work *= 1 + tax;
    }
    if (dullingSwingCuts(s, actor, t, melee, ek)) work *= 1 + DULLING_SWING_WORK_BONUS;
    return work;
}

/// deliveryPrecedes: kill, the incumbent, a silent target over a knight who will answer, damage, the knight's own
/// dulling swing, stationary, stable order.
fn deliveryPrecedes(l: *const Delivery, r: *const Delivery) bool {
    if (l.ek != r.ek) return l.ek > r.ek;
    if (l.incumbent != r.incumbent) return l.incumbent;
    if (l.unsafe_dulling != r.unsafe_dulling) return !l.unsafe_dulling;
    if (l.ed != r.ed) return l.ed > r.ed;
    if (l.dulling_swing != r.dulling_swing) return l.dulling_swing;
    if (l.stationary != r.stationary) return l.stationary;
    return l.cand < r.cand;
}

/// selectV08STargetPressureCandidate: a kill now first; else, preferring a target that is not a fresh answering knight,
/// finish an already wounded stack (the least remaining first); else the target with the most remaining attack-work.
/// Ties: damage, the knight's own dulling swing, stationary, stable order. Candidates are scheduled by their pressure
/// target (an area throw's first enemy) and delivery damage (a shot's damage to its primary stack).
fn targetPressure(s: *const st.State, actor: u8, set: *const cand.Set, ok: *bool) ?usize {
    _ = ok;
    const team = s.units[actor].team;
    var by_target: [st.MAX_UNITS]i32 = .{-1} ** st.MAX_UNITS;
    var nt: usize = 0;
    var deliveries: [st.MAX_UNITS]Delivery = undefined;
    for (set.slice(), 0..) |*c, i| {
        // candidate.pressureTargetId ?? candidate.targetId
        const pressure_target = if (c.pressure >= 0) c.pressure else c.target;
        if (pressure_target < 0 or !isDirectCombat(c.d.slice())) continue;
        const ti: u8 = @intCast(pressure_target);
        const t = &s.units[ti];
        const ed = if (std.math.isFinite(c.ed) and c.ed > 0) c.ed else 0;
        // targetDeliveryDamage: a shot's damage to its primary stack when positive, else the expected damage.
        const primary = if (std.math.isFinite(c.primary_dmg) and c.primary_dmg > 0) c.primary_dmg else 0;
        const delivery = if (util.has(&c.d, .range_attack) and primary > 0) primary else ed;
        if (t.isDead() or t.team == team or ed <= 0 or delivery <= 0) continue;
        const ek = c.pressure_ek orelse c.ek;
        const melee = util.has(&c.d, .melee_attack);
        const original = @max(0, t.amount_alive + t.amount_died) * @max(0, t.max_hp);
        const remaining = if (original > 0) @min(1, util.cumulativeHp(t) / original) else 1;
        const d = Delivery{
            .cand = i,
            .incumbent = c.kind == .incumbent,
            .ed = ed,
            .ek = ek,
            .stationary = !moves(c.d.slice()),
            .target = ti,
            .remaining = remaining,
            .unsafe_dulling = ek == 0 and melee and knightAnswers(s, actor, ti),
            .dulling_swing = dullingSwingCuts(s, actor, ti, melee, ek),
            .work = targetWork(s, actor, ti, melee, delivery, ek),
        };
        if (by_target[ti] < 0) {
            by_target[ti] = @intCast(nt);
            deliveries[nt] = d;
            nt += 1;
        } else if (deliveryPrecedes(&d, &deliveries[@intCast(by_target[ti])])) deliveries[@intCast(by_target[ti])] = d;
    }
    if (nt == 0) return null;
    const all = deliveries[0..nt];
    var kills = false;
    for (all) |*d| if (d.ek == 1) {
        kills = true;
    };
    // eligible: the immediate kills; else the deliveries that are not a fresh answering knight; else all of them.
    var eligible: [st.MAX_UNITS]Delivery = undefined;
    var ne: usize = 0;
    if (kills) {
        for (all) |d| if (d.ek == 1) {
            eligible[ne] = d;
            ne += 1;
        };
    } else {
        for (all) |d| if (!d.unsafe_dulling or d.remaining <= 0.5) {
            eligible[ne] = d;
            ne += 1;
        };
        if (ne == 0) {
            @memcpy(eligible[0..nt], all);
            ne = nt;
        }
    }
    // focused: the wounded among them (all of them when there is a kill), else every eligible delivery.
    var focused: [st.MAX_UNITS]Delivery = undefined;
    var nf: usize = 0;
    for (eligible[0..ne]) |d| if (kills or d.remaining < 1 - DELIVERY_EPSILON) {
        focused[nf] = d;
        nf += 1;
    };
    const wounded = nf > 0;
    if (!wounded) {
        @memcpy(focused[0..ne], eligible[0..ne]);
        nf = ne;
    }
    const Cmp = struct { wounded: bool, kills: bool };
    std.sort.insertion(Delivery, focused[0..nf], Cmp{ .wounded = wounded, .kills = kills }, struct {
        fn lt(k: Cmp, l: Delivery, r: Delivery) bool {
            if (k.wounded and l.remaining != r.remaining) return l.remaining < r.remaining;
            if (!k.kills and l.work != r.work) return l.work > r.work;
            if (l.ed != r.ed) return l.ed > r.ed;
            if (l.dulling_swing != r.dulling_swing) return l.dulling_swing;
            if (l.stationary != r.stationary) return l.stationary;
            return l.cand < r.cand;
        }
    }.lt);
    return focused[0].cand;
}

/// prioritizeV08A13FinishDecision: from the final sprint (lap 9), the target-pressure attack, else the advance.
/// False when the board needs an unported term.
pub fn finish(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    if (c.s.fight.lap < util.URGENT_FINISH_START_LAP) {
        util.copyDecision(out, in);
        return true;
    }
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.FINISH, &set);
    var ok = true;
    const attack = targetPressure(c.s, c.ui, &set, &ok);
    if (!ok) return false;
    if (attack) |i| {
        take(out, &set, i);
        return true;
    }
    for (set.slice(), 0..) |*cd, i| if (cd.kind == .move) {
        take(out, &set, i);
        return true;
    };
    util.copyDecision(out, in);
    return true;
}

// ---- backline protector and ward (v0_8_backline_protector.ts) ----

const Protector = enum { abomination, angel, arachna_queen };

fn protectorKind(s: *const st.State, ui: u8) ?Protector {
    return switch (util.creature(s, ui)) {
        .abomination => .abomination,
        .angel => .angel,
        .arachna_queen => .arachna_queen,
        else => null,
    };
}

/// isV08BacklineProtectionBeneficiary: living ranged output (spell output is out of scope).
/// The spells a unit holds that it may cast now (getSpells() filtered by isSpellUsableByCaster); 0 without a book.
fn usableSpells(s: *const st.State, u: *const st.Unit) usize {
    if (!u.canCastSpells()) return 0;
    var n: usize = 0;
    for (u.spells[0..u.n_spells]) |*b| {
        if (spells.usable(u, b, &s.spell_cfg[b.spell])) n += 1;
    }
    return n;
}

/// isV08BacklineProtectionBeneficiary: a living stack with shots left, or with a spell it can cast.
fn isBeneficiary(s: *const st.State, u: *const st.Unit) bool {
    if (u.isDead()) return false;
    return (engine.isRangeCapable(u) and engine.getRangeShots(u) > 0) or usableSpells(s, u) > 0;
}

/// v08BacklineWardValue: remaining maximum ranged output plus remaining usable spells, each scaled by the stack's
/// direct output.
fn wardValue(s: *const st.State, u: *const st.Unit) f64 {
    const amount = @max(1, @max(0, u.amount_alive));
    const per = @max(1, @max(0, u.attack_damage_max) * amount);
    const ranged = if (engine.isRangeCapable(u)) @max(0, engine.getRangeShots(u)) * per else 0;
    const spell_output = @as(f64, @floatFromInt(usableSpells(s, u))) * per;
    return @min(9007199254740991.0, ranged + spell_output);
}

/// v08BacklineProtectorCoverageRange: Angel's screen 2; Abomination's and Queen's aura range, 1 without the aura;
/// plus the team's synergy aura range (getAdditionalAuraRangePerTeam), floored, at least 0. The Abomination's is read
/// only under V08_ABOMINATION_GUARD (unset: it is released, protectorIntent).
fn coverageRange(s: *const st.State, pi: u8) i32 {
    // getAuraEffect("Flesh Shield" / "Web")?.getRange() ?? 1 (getAuraEffect reads a Broken unit's auras too).
    const kind = protectorKind(s, pi);
    var base: f64 = if (kind == .angel) 2 else 1;
    if (kind == .arachna_queen or kind == .abomination) {
        const u = &s.units[pi];
        for (u.auras[0..u.n_auras]) |d| {
            const aura = if (kind == .abomination) d == s.flesh_def else s.aura_defs[d].power_type == st.PowerType.DISABLE_FLY_MOVEMENT;
            if (aura) base = s.aura_defs[d].range;
        }
    }
    return @intFromFloat(@max(0, @floor(base + s.setup[s.units[pi].team].aura_range)));
}

fn footprintDistance(a: []const rec.Cell, b: []const rec.Cell) i32 {
    var best: i32 = std.math.maxInt(i32);
    for (a) |x| for (b) |y| {
        best = @min(best, @max(@abs(x.x - y.x), @abs(x.y - y.y)));
    };
    return best;
}

const Intent = struct {
    kind: Protector,
    ward: u8,
    wards: [st.MAX_UNITS]u8 = undefined,
    nw: usize = 0,

    fn wardSlice(self: *const Intent) []const u8 {
        return self.wards[0..self.nw];
    }
};

/// The ward the protector `pi` is assigned to (buildV08BacklineProtectorIntent), or null. Abomination is released by
/// default (V08_ABOMINATION_GUARD unset).
fn protectorWard(s: *const st.State, pi: u8) ?u8 {
    const intent = protectorIntent(s, pi) orelse return null;
    return intent.ward;
}

/// buildV08BacklineProtectorIntent: the protector's wards (every living ranged ally) and its primary ward (the most
/// valuable, then by id). Angel needs two wards facing a live shooter; Queen needs a live enemy flyer; the finish
/// window releases every role.
fn protectorIntent(s: *const st.State, pi: u8) ?Intent {
    const kind = protectorKind(s, pi) orelse return null;
    if (kind == .abomination) return null;
    const p = &s.units[pi];
    // A summoned Queen (an Infest reward) stays offensive.
    if (kind == .arachna_queen and p.summoned) return null;
    var intent = Intent{ .kind = kind, .ward = 0 };
    var best: ?u8 = null;
    var count: usize = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const w = &s.units[i_slot];
        if (!w.in_holder or i == pi or w.team != p.team or w.summoned or !isBeneficiary(s, w)) continue;
        count += 1;
        const wi: u8 = @intCast(i);
        intent.wards[intent.nw] = wi;
        intent.nw += 1;
        if (best) |b| {
            const vb = wardValue(s, &s.units[b]);
            const vw = wardValue(s, w);
            if (vw > vb or (vw == vb and util.idLess(s, wi, b))) best = wi;
        } else best = wi;
    }
    const ward = best orelse return null;
    if (kind == .angel) {
        if (count < 2) return null;
        var shooter = false;
        for (s.holderOrder()) |e_slot| {
            const e = &s.units[e_slot];
            if (e.in_holder and !e.isDead() and e.team != p.team and engine.isRangeCapable(e) and engine.getRangeShots(e) > 0) shooter = true;
        }
        if (!shooter) return null;
    }
    if (util.dominantFinishState(s, p.team).active) return null;
    if (kind == .arachna_queen) {
        var flyer = false;
        for (s.holderOrder()) |e_slot| {
            const e = &s.units[e_slot];
            if (e.in_holder and !e.isDead() and e.team != p.team and engine.canFly(e)) flyer = true;
        }
        if (!flyer) return null;
    }
    intent.ward = ward;
    return intent;
}

fn cellsOf(s: *const st.State, ui: u8) engine.Cells {
    return engine.unitCells(&s.units[ui]);
}

fn coversWard(s: *const st.State, cells: []const rec.Cell, ward: u8, pi: u8) bool {
    return footprintDistance(cells, cellsOf(s, ward).slice()) <= coverageRange(s, pi);
}

/// totalWardValue of the intent's wards that `cells` covers.
fn coveredValue(s: *const st.State, intent: *const Intent, cells: []const rec.Cell, pi: u8) f64 {
    var total: f64 = 0;
    for (intent.wardSlice()) |w| {
        if (coversWard(s, cells, w, pi)) total = @min(9007199254740991.0, total + wardValue(s, &s.units[w]));
    }
    return total;
}

/// preservesCurrentlyCoveredWards: every ward the protector covers now is still covered at `dest` (one permitted loss).
fn keepsCovered(s: *const st.State, intent: *const Intent, pi: u8, dest: []const rec.Cell, permitted: ?u8) bool {
    const current = cellsOf(s, pi);
    for (intent.wardSlice()) |w| {
        if (!coversWard(s, current.slice(), w, pi)) continue;
        if (permitted != null and permitted.? == w) continue;
        if (!coversWard(s, dest, w, pi)) return false;
    }
    return true;
}

/// catchUpDestinationAllowed: an uncovered primary ward may be approached when no covered ward is lost, or when the
/// step restores the primary and raises the covered value.
fn catchUpAllowed(s: *const st.State, intent: *const Intent, pi: u8, dest: []const rec.Cell) bool {
    const current = cellsOf(s, pi);
    const ward = cellsOf(s, intent.ward);
    const range = coverageRange(s, pi);
    const now = footprintDistance(current.slice(), ward.slice());
    const after = footprintDistance(dest, ward.slice());
    if (now <= range or after >= now) return false;
    if (keepsCovered(s, intent, pi, dest, null)) return true;
    return coversWard(s, dest, intent.ward, pi) and coveredValue(s, intent, dest, pi) > coveredValue(s, intent, current.slice(), pi);
}

fn lastAttackTarget(actions: []const rec.Action) ?u8 {
    var i = actions.len;
    while (i > 0) {
        i -= 1;
        switch (actions[i]) {
            .melee_attack => |m| return m.target,
            .range_attack => |r| return r.target,
            else => {},
        }
    }
    return null;
}

/// queenInterceptsLocalDiver: the Queen strikes an enemy already touching the primary ward, one ring out at most.
fn queenIntercepts(s: *const st.State, intent: *const Intent, pi: u8, actions: []const rec.Action, dest: []const rec.Cell) bool {
    if (intent.kind != .arachna_queen) return false;
    const ti = lastAttackTarget(actions) orelse return false;
    const t = &s.units[ti];
    if (t.isDead()) return false;
    const ward = cellsOf(s, intent.ward);
    return footprintDistance(engine.unitCells(t).slice(), ward.slice()) <= 1 and footprintDistance(dest, ward.slice()) <= coverageRange(s, pi) + 1;
}

/// preservesV08BacklineProtectorIntent.
fn preservesProtector(s: *const st.State, intent: *const Intent, pi: u8, actions: []const rec.Action) bool {
    var buf: engine.Cells = .{};
    const dest = destinationCells(s, pi, actions, &buf);
    if (intent.kind == .angel and isDirectCombat(actions) and !coversWard(s, dest, intent.ward, pi)) return false;
    if (catchUpAllowed(s, intent, pi, dest)) return true;
    const intercept = queenIntercepts(s, intent, pi, actions, dest);
    if (!keepsCovered(s, intent, pi, dest, if (intercept) intent.ward else null)) return false;
    if (coversWard(s, dest, intent.ward, pi)) return true;
    return intercept;
}

fn pureMove(actions: []const rec.Action) bool {
    if (actions.len == 0) return false;
    for (actions) |a| if (a != .move_unit) return false;
    return true;
}

fn sameFootprint(a: []const rec.Cell, b: []const rec.Cell) bool {
    if (a.len != b.len) return false;
    for (a) |x| {
        var found = false;
        for (b) |y| if (x.x == y.x and x.y == y.y) {
            found = true;
        };
        if (!found) return false;
    }
    return true;
}

/// The closest distance from `cells` to an enemy (the Queen's: a flyer) touching a ward the protector covers now.
fn closestLocalThreat(s: *const st.State, intent: *const Intent, pi: u8, cells: []const rec.Cell) ?i32 {
    const current = cellsOf(s, pi);
    const team = s.units[pi].team;
    var best: ?i32 = null;
    for (s.holderOrder()) |e_slot| {
        const e = &s.units[e_slot];
        if (!e.in_holder or e.isDead() or e.team == team) continue;
        if (intent.kind == .arachna_queen and !engine.canFly(e)) continue;
        const ecells = engine.unitCells(e);
        var local = false;
        for (intent.wardSlice()) |w| {
            if (coversWard(s, current.slice(), w, pi) and footprintDistance(ecells.slice(), cellsOf(s, w).slice()) <= 1) local = true;
        }
        if (!local) continue;
        const d = footprintDistance(cells, ecells.slice());
        best = if (best) |b| @min(b, d) else d;
    }
    return best;
}

/// isV08BacklineProtectorPureMoveMeaningful: closer to the primary, more covered value, or closer to a local threat.
fn pureMoveMeaningful(s: *const st.State, intent: *const Intent, pi: u8, actions: []const rec.Action) bool {
    if (!pureMove(actions)) return false;
    const current = cellsOf(s, pi);
    var buf: engine.Cells = .{};
    const dest = destinationCells(s, pi, actions, &buf);
    if (sameFootprint(current.slice(), dest) or !preservesProtector(s, intent, pi, actions)) return false;
    const ward = cellsOf(s, intent.ward);
    if (footprintDistance(dest, ward.slice()) < footprintDistance(current.slice(), ward.slice())) return true;
    if (coveredValue(s, intent, dest, pi) > coveredValue(s, intent, current.slice(), pi)) return true;
    const now = closestLocalThreat(s, intent, pi, current.slice()) orelse return false;
    const after = closestLocalThreat(s, intent, pi, dest) orelse return false;
    return after < now;
}

/// followWard: the closest catch-up route toward the uncovered primary ward that loses no covered ward (else the best
/// value swap); by distance, route weight, then cell y and x. None for a protector that cannot move (Paralysis, a web).
fn followWard(c: *ai.Ctx, intent: *const Intent, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (!u.canMove()) return false;
    const ward = cellsOf(s, intent.ward);
    const now = footprintDistance(engine.unitCells(u).slice(), ward.slice());
    const mp = c.actualPath();
    const Best = struct { ri: usize, d: i32, w: f64, cell: rec.Cell };
    var preserving: ?Best = null;
    var swap: ?Best = null;
    for (mp.known(), 0..) |*r, ri| {
        const body = ai.footprintForAnchor(u, r.cell);
        const dest = body.slice();
        if (!ai.canLandAt(s, c.ui, r.cell)) continue;
        const d = footprintDistance(dest, ward.slice());
        if (d >= now or !catchUpAllowed(s, intent, c.ui, dest)) continue;
        const cand_ = Best{ .ri = ri, .d = d, .w = r.weight, .cell = r.cell };
        const slot = if (keepsCovered(s, intent, c.ui, dest, null)) &preserving else &swap;
        if (slot.*) |b| {
            const better = if (cand_.d != b.d) cand_.d < b.d else if (cand_.w != b.w) cand_.w < b.w else (cand_.cell.y < b.cell.y or (cand_.cell.y == b.cell.y and cand_.cell.x < b.cell.x));
            if (better) slot.* = cand_;
        } else slot.* = cand_;
    }
    const best = preserving orelse swap orelse return false;
    const r = &mp.known()[best.ri];
    out.* = .{};
    const len = mp.routeCells(r, &out.path);
    const body = ai.footprintForAnchor(u, r.cell);
    @memcpy(out.targets[0..body.slice().len], body.slice());
    out.push(.{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..body.slice().len], .has_lava = r.has_lava } });
    return true;
}

/// prioritizeV08BacklineProtector: an Angel or Queen with a ward keeps protection-compatible work, follows a displaced
/// primary ward, or holds the screen (wait, else defend). Abomination's hard-risk rule is unused: it is released.
pub fn backlineProtector(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const intent = protectorIntent(s, c.ui) orelse return util.copyDecision(out, in);
    const current = cellsOf(s, c.ui);
    if (!coversWard(s, current.slice(), intent.ward, c.ui)) {
        var buf: engine.Cells = .{};
        const dest = destinationCells(s, c.ui, in.slice(), &buf);
        if (catchUpAllowed(s, &intent, c.ui, dest) and keepsCovered(s, &intent, c.ui, dest, null)) return util.copyDecision(out, in);
        if (followWard(c, &intent, out)) return;
        if (catchUpAllowed(s, &intent, c.ui, dest)) return util.copyDecision(out, in);
        if (sameFootprint(dest, current.slice())) return util.copyDecision(out, in);
    } else if (preservesProtector(s, &intent, c.ui, in.slice())) {
        if (!pureMove(in.slice()) or pureMoveMeaningful(s, &intent, c.ui, in.slice())) return util.copyDecision(out, in);
    }
    if (util.canHourglass(s, c.ui)) util.setWait(out, c.ui) else {
        out.* = .{};
        out.push(.{ .defend_turn = .{ .unit = c.ui } });
    }
}

/// buildV08BacklineWardIntent: the protector (Abomination first, then by id) whose assigned ward is this unit.
fn wardProtector(s: *const st.State, ui: u8) ?u8 {
    const u = &s.units[ui];
    if (u.summoned or !isBeneficiary(s, u)) return null;
    var order: [st.MAX_UNITS]u8 = undefined;
    var n: usize = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const p = &s.units[i_slot];
        if (!p.in_holder or i == ui or p.isDead() or p.team != u.team or p.summoned or protectorKind(s, @intCast(i)) == null) continue;
        order[n] = @intCast(i);
        n += 1;
    }
    std.sort.insertion(u8, order[0..n], s, struct {
        fn lt(st_: *const st.State, a: u8, b: u8) bool {
            const aa = protectorKind(st_, a) == .abomination;
            const bb = protectorKind(st_, b) == .abomination;
            if (aa != bb) return aa;
            return util.idLess(st_, a, b);
        }
    }.lt);
    for (order[0..n]) |pi| {
        if (protectorWard(s, pi) == ui) return pi;
    }
    return null;
}

/// decisionDestinationCells: the body where the decision leaves the unit. The unit's last Castling lands it on the
/// cells of its target while that target lives; else the last obstacle strike's stand, melee stand or move.
fn destinationCells(s: *const st.State, ui: u8, actions: []const rec.Action, buf: *engine.Cells) []const rec.Cell {
    const u = &s.units[ui];
    var i = actions.len;
    const castling: u8 = @intFromEnum(st.CastSpell.castling);
    while (i > 0) {
        i -= 1;
        switch (actions[i]) {
            .cast_spell => |cs| if (cs.caster == ui and cs.spell == castling) {
                if (cs.has_target) {
                    const t = &s.units[cs.target];
                    if (t.in_holder and !t.isDead()) {
                        buf.* = engine.unitCells(t);
                        return buf.slice();
                    }
                }
                break;
            },
            else => {},
        }
    }
    i = actions.len;
    while (i > 0) {
        i -= 1;
        switch (actions[i]) {
            .obstacle_attack => |o| if (o.has_from) {
                buf.* = ai.footprintForAnchor(u, o.attack_from);
                return buf.slice();
            },
            else => {},
        }
    }
    i = actions.len;
    while (i > 0) {
        i -= 1;
        if (actions[i] == .melee_attack) {
            buf.* = ai.footprintForAnchor(u, actions[i].melee_attack.attack_from);
            return buf.slice();
        }
    }
    i = actions.len;
    while (i > 0) {
        i -= 1;
        if (actions[i] == .move_unit) {
            const m = actions[i].move_unit;
            if (m.target_cells.len > 0) return m.target_cells;
            if (m.path.len > 0) {
                buf.* = ai.footprintForAnchor(u, m.path[m.path.len - 1]);
                return buf.slice();
            }
            break;
        }
    }
    buf.* = engine.unitCells(u);
    return buf.slice();
}

/// preservesV08BacklineWardIntent: inside the protector's range stays inside it; outside, never farther.
fn preservesWard(s: *const st.State, ui: u8, pi: u8, actions: []const rec.Action) bool {
    var buf: engine.Cells = .{};
    const dest = destinationCells(s, ui, actions, &buf);
    const pcells = engine.unitCells(&s.units[pi]);
    const range = coverageRange(s, pi);
    const current = footprintDistance(pcells.slice(), engine.unitCells(&s.units[ui]).slice());
    const after = footprintDistance(pcells.slice(), dest);
    return if (current <= range) after <= range else after <= current;
}

/// repairV08BacklineWardDecision: a productive ward keeps inside its protector's screen; when the decision would
/// leave it, a preserving attack, else a wait, a defend, a move, or ending the turn.
pub fn backlineWard(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const pi = wardProtector(s, c.ui) orelse return util.copyDecision(out, in);
    if (preservesWard(s, c.ui, pi, in.slice())) return util.copyDecision(out, in);
    var all: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY, &all);
    if (all.incomplete) {
        util.unsupported = true;
        return util.copyDecision(out, in);
    }
    var kept: cand.Set = .{};
    for (all.slice()) |*cd| {
        if (attacksForbidden(s, c.unit(), cd.d.slice()) or !preservesWard(s, c.ui, pi, cd.d.slice())) continue;
        kept.items[kept.n] = cd.*;
        util.copyDecision(&kept.items[kept.n].d, &cd.d);
        kept.n += 1;
    }
    if (selectDirectCombat(&kept)) |i| return take(out, &kept, i);
    if (bestWardSpell(&kept)) |i| return take(out, &kept, i);
    for ([_]cand.Kind{ .wait, .defend, .move }) |k| {
        for (kept.slice(), 0..) |*cd, i| if (cd.kind == k) return take(out, &kept, i);
    }
    util.setEndTurn(out, c.ui);
}

// ---- ranged positioning (v0_8_ranged_positioning.ts), production path: the pinned retreat ----

/// estimatePrimaryMeleeDamage(...).secureKill for a strike from `from` (fuse.primaryMelee): null for an unsupported
/// sequence, else whether the hit cannot miss and every landed outcome kills.
fn meleeSecureKill(s: *const st.State, ai_: u8, ti: u8, actions: []const rec.Action, from: rec.Cell) ?bool {
    const estimate = fuse.primaryMelee(s, ai_, ti, fuse.meleeShape(actions), from) orelse return null;
    return estimate.secure;
}

fn cellsDistance(a: []const rec.Cell, b: []const rec.Cell) i32 {
    return footprintDistance(a, b);
}

/// canBeAttackedByMelee at a position: any footprint cell inside the enemy aggression zone.
fn pinnedAt(s: *const st.State, u: *const st.Unit, px: f64, py: f64) bool {
    const aggr = engine.enemyAggr(s, u);
    const cells = engine.cellsForPosition(px, py, u.fw, u.fh);
    for (cells.slice()) |c| {
        if (c.x < 0 or c.x >= st.GRID or c.y < 0 or c.y >= st.GRID) continue;
        if (aggr[@intCast(c.x)][@intCast(c.y)] > 1) return true;
    }
    return false;
}

/// allyScreensThreat: the ally sits between the shooter's cells and that enemy, within reach of the shooter.
fn allyScreens(dest: []const rec.Cell, ally: []const rec.Cell, enemy: []const rec.Cell) bool {
    const shooter_enemy = cellsDistance(dest, enemy);
    const ally_enemy = cellsDistance(ally, enemy);
    const shooter_ally = cellsDistance(dest, ally);
    return ally_enemy < shooter_enemy and shooter_ally <= 3 and ally_enemy + shooter_ally <= shooter_enemy + 1;
}

const RouteView = struct {
    route: u16,
    unscreened: i32,
    reachable: i32,
    eligible: bool,
    min_enemy: i32,
    nearest_front: i32,
    divisor: f64,
    cost: f64,
};

fn preferRetreat(l: *const RouteView, r: *const RouteView) bool {
    if (l.unscreened != r.unscreened) return l.unscreened < r.unscreened;
    if (l.reachable != r.reachable) return l.reachable < r.reachable;
    if (l.min_enemy != r.min_enemy) return l.min_enemy > r.min_enemy;
    if (l.nearest_front != r.nearest_front) return l.nearest_front < r.nearest_front;
    if (l.divisor != r.divisor) return l.divisor < r.divisor;
    return l.cost < r.cost;
}

/// pinnedRetreat (legacy selection; the supported-delta catalog is an off-by-default experiment): a shooter that is
/// pinned in melee reach and would strike a non-securely-killed target in melee, or would not shoot, retreats to the
/// best reachable cell outside melee reach where every enemy that could reach it is screened by a melee ally.
fn pinnedRetreat(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    util.copyDecision(out, in);
    if (u.attack_type != AT.RANGE or engine.getRangeShots(u) <= 0) return;
    // A web-locked shooter cannot move, a Handyman shooter melees without penalty, and a shooter inside an enemy Range
    // Null Field or under Rangebane is already silenced.
    if (!u.canMove() or u.has(.handyman)) return;
    if (u.debuffs.find(.range_null_field_aura) != null or engine.rangebaned(s, u)) return;
    if (!pinnedAt(s, u, u.pos_x, u.pos_y)) return;
    var melee: ?rec.Action = null;
    for (in.slice()) |a| switch (a) {
        // TURN_CONSUMING_NON_MELEE
        .range_attack, .area_throw_attack, .obstacle_attack, .cast_spell => return,
        .melee_attack => melee = a,
        else => {},
    };
    if (melee) |m| {
        if (isDirectCombat(in.slice()) and util.dominantFinishState(s, u.team).active) return;
        if (s.fight.lap >= engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 1) return;
        const secure = meleeSecureKill(s, c.ui, m.melee_attack.target, in.slice(), m.melee_attack.attack_from) orelse return;
        if (secure) return;
    }
    var enemies: [st.MAX_UNITS]u8 = undefined;
    var ne: usize = 0;
    var front: [st.MAX_UNITS]u8 = undefined;
    var nfr: usize = 0;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const o = &s.units[i_slot];
        if (!o.in_holder or o.isDead()) continue;
        if (o.team != u.team) {
            enemies[ne] = @intCast(i);
            ne += 1;
        } else if (i != c.ui and (o.attack_type == AT.MELEE or o.attack_type == AT.MELEE_MAGIC)) {
            front[nfr] = @intCast(i);
            nfr += 1;
        }
    }
    if (ne == 0) return;
    const mp = c.actualPath();
    const base = engine.baseCell(u);
    var best: ?RouteView = null;
    for (mp.known(), 0..) |*r, ri| {
        if (r.cell.x == base.x and r.cell.y == base.y) continue;
        if (r.has_lava or !ai.canLandAt(s, c.ui, r.cell)) continue;
        const body = ai.footprintForAnchor(u, r.cell);
        const foot = body.slice();
        const pos = engine.positionForCells(foot) orelse continue;
        if (pinnedAt(s, u, pos[0], pos[1])) continue;
        var reachable: i32 = 0;
        var screened: i32 = 0;
        var min_enemy: i32 = std.math.maxInt(i32);
        var divisor: f64 = std.math.inf(f64);
        for (enemies[0..ne]) |ei| {
            const e = &s.units[ei];
            const ecells = engine.unitCells(e);
            const d = cellsDistance(foot, ecells.slice());
            min_enemy = @min(min_enemy, d);
            divisor = @min(divisor, util.rangeDivisorAt(u, e.pos_x, e.pos_y, pos[0], pos[1]));
            // withinMeleeHorizon: a No Melee enemy never threatens.
            if (e.has(.no_melee) or @as(f64, @floatFromInt(d)) > @ceil(@max(0, engine.getSteps(e))) + 1) continue;
            reachable += 1;
            for (front[0..nfr]) |fi| {
                if (allyScreens(foot, engine.unitCells(&s.units[fi]).slice(), ecells.slice())) {
                    screened += 1;
                    break;
                }
            }
        }
        var nearest: i32 = std.math.maxInt(i32);
        for (front[0..nfr]) |fi| nearest = @min(nearest, cellsDistance(foot, engine.unitCells(&s.units[fi]).slice()));
        const view = RouteView{ .route = @intCast(ri), .unscreened = reachable - screened, .reachable = reachable, .eligible = reachable == screened, .min_enemy = min_enemy, .nearest_front = nearest, .divisor = divisor, .cost = r.weight };
        // legacyEligible: a No Melee shooter takes any route, another only a fully screened one.
        if (!(u.has(.no_melee) or view.eligible)) continue;
        if (best == null or preferRetreat(&view, &best.?)) best = view;
    }
    const b = best orelse return;
    const r = &mp.known()[b.route];
    out.* = .{};
    const len = mp.routeCells(r, &out.path);
    const body = ai.footprintForAnchor(u, r.cell);
    const cells = body.slice();
    @memcpy(out.targets[0..cells.len], cells);
    out.push(.{ .move_unit = .{ .unit = c.ui, .path = out.path[0..len], .target_cells = out.targets[0..cells.len], .has_lava = r.has_lava } });
}

/// prioritizeV08RangedPositioning at production settings (V08_RANGED_POSITION_MODE "retreat", the band-advance and
/// pre-pin egress experiments off): the pinned retreat. False on a board term not ported yet.
pub fn rangedPositioning(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    if (!util.battle.ranged_positioning) {
        util.copyDecision(out, in);
        return true;
    }
    pinnedRetreat(c, in, out);
    return true;
}

/// Unit.getFootprintCellsForAnchor (grid_math getFootprintCellsForAnchor): the anchor's body, dx outer and dy inner
/// (a 2x2 is (x,y), (x,y-1), (x-1,y), (x-1,y-1), unlike the AI's footprintCellsForAnchor order).
fn gridFootprint(u: *const st.Unit, a: rec.Cell) engine.Cells {
    var out: engine.Cells = .{};
    var dx: i32 = 0;
    while (dx < @max(1, u.fw)) : (dx += 1) {
        var dy: i32 = 0;
        while (dy < @max(1, u.fh)) : (dy += 1) out.push(.{ .x = a.x - dx, .y = a.y - dy });
    }
    return out;
}

/// a19CoherentMeleeApproach (on unless A19_COHERENT_MELEE_APPROACH_<SIDE>=0: util.Switches.coherent_melee; off, the
/// decision passes unchanged): a move followed by a strike from a cell
/// the move does not reach (an aura or Rapid Charge reposition replaced the strike, not the move) is repaired: the move
/// is rebuilt to the strike's stand cell and the strike made stationary; a strike from the current cell drops the stale
/// move; an approach the engine would not allow keeps the actions up to the move and drops the strike. Hidden, No
/// Melee, Terrifying Gaze, Cowardice and Fire Walls (repairUnavailableMovePrefixedAttack) are not in scope.
pub fn coherentMelee(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    util.copyDecision(out, in);
    if (!util.battle.switches[c.unit().team].coherent_melee) return true;
    const s = c.s;
    const acts = in.slice();
    var strike: ?usize = null;
    for (acts, 0..) |a, i| if (a == .melee_attack and a.melee_attack.attacker == c.ui) {
        strike = i;
        break;
    };
    const si = strike orelse return true;
    var move: ?usize = null;
    for (acts[0..si], 0..) |a, i| if (a == .move_unit and a.move_unit.unit == c.ui) {
        move = i;
        break;
    };
    const mi = move orelse return true;
    const u = c.unit();
    const hit = acts[si].melee_attack;
    const desired = gridFootprint(u, hit.attack_from);
    const m = acts[mi].move_unit;
    // resolveMoveTargetCells: the supplied cells, else the body at the path's end, else none.
    var old_buf: engine.Cells = .{};
    const old: []const rec.Cell = if (m.target_cells.len > 0) m.target_cells else if (m.path.len > 0) blk: {
        old_buf = gridFootprint(u, m.path[m.path.len - 1]);
        break :blk old_buf.slice();
    } else &.{};
    if (sameFootprint(old, desired.slice())) return true;

    // preserveMove: the actions up to and including the move.
    const t = &s.units[hit.target];
    var forced_other = false;
    if (u.target >= 0) {
        const f = &s.units[@intCast(u.target)];
        if (f.in_holder and !f.isDead() and u.target != @as(i8, @intCast(hit.target))) forced_other = true;
    }
    const tc = engine.unitCells(t);
    if (!t.in_holder or t.isDead() or t.team == u.team or t.isHidden() or u.has(.no_melee) or u.cannotAttack(t.uid) or
        forced_other or !ai.adjacent(desired.slice(), tc.slice()))
    {
        out.n = @intCast(mi + 1);
        return true;
    }
    const stationary = rec.Action{ .melee_attack = .{ .attacker = hit.attacker, .target = hit.target, .attack_from = hit.attack_from, .path = &.{} } };
    // The rebuilt decision owns its cells: any other action carrying cells is not expected (refuse rather than alias).
    for (acts, 0..) |a, i| {
        if (i == mi or i == si) continue;
        switch (a) {
            .move_unit => |x| if (x.path.len > 0 or x.target_cells.len > 0) return false,
            .melee_attack => |x| if (x.path.len > 0) return false,
            .obstacle_attack => |x| if (x.path.len > 0) return false,
            else => {},
        }
    }
    const base = engine.baseCell(u);
    var d: ai.Decision = .{};
    if (ai.sameCell(base, hit.attack_from)) {
        // The strike is from the current cell: drop the stale move (unless Cowardice bars the strike: keep the move).
        if (engine.cowardly(s, u) and util.cumulativeHp(u) < util.cumulativeHp(t)) {
            out.n = @intCast(mi + 1);
            return true;
        }
        for (acts, 0..) |a, i| {
            if (i == mi) continue;
            d.push(if (i == si) stationary else a);
        }
        util.copyDecision(out, &d);
        return true;
    }
    if (!u.canMove()) {
        out.n = @intCast(mi + 1);
        return true;
    }
    const mp = c.actualPath();
    const r = mp.get(path.key(hit.attack_from.x, hit.attack_from.y)) orelse {
        out.n = @intCast(mi + 1);
        return true;
    };
    if (!engine.cellsFreeFor(s, c.ui, desired.slice())) {
        out.n = @intCast(mi + 1);
        return true;
    }
    // The aligned approach: the move along the route to the stand cell, then the stationary strike.
    for (acts, 0..) |a, i| {
        if (i == mi) {
            const len = mp.routeCells(r, &d.path);
            const body = desired.slice();
            @memcpy(d.targets[0..body.len], body);
            d.push(.{ .move_unit = .{ .unit = m.unit, .path = d.path[0..len], .target_cells = d.targets[0..body.len], .has_lava = r.has_lava } });
        } else d.push(if (i == si) stationary else a);
    }
    // repairUnavailableMovePrefixedAttack on the aligned approach (a Fire Wall walk, or Cowardice at the projected hp).
    firewall.repairMovePrefixedAttack(s, c.ui, &d);
    util.copyDecision(out, &d);
    return true;
}

/// The passes after v0.7, in decideTurn's order; false when a pass this board needs is not ported (cemetery with
/// standing scattered stones, a coherent-melee repair, or an unported ability term).
pub fn decide(c: *ai.Ctx, out: *ai.Decision) bool {
    // v0.7's aura-saturated archetype anchor (a standalone StrategyV0_4 with the universal caster router) is ported only
    // where it equals the chain's v0.4 level (util.anchorPorted).
    if (util.battle.aura_saturated[c.unit().team] and !util.anchorPorted(c.s, c.unit().team)) return false;
    var cur: ai.Decision = .{};
    var next: ai.Decision = .{};
    util.unsupported = false;
    @import("lv7.zig").decide(c, &cur);
    if (util.unsupported) return false;
    const order = [_]Pass{ .explicit, .prioritize, .defend_to_wait, .finish, .ranged_positioning, .forbidden_target, .splash, .damage_spell, .vine, .smoke, .nightmare, .healer, .blacksmith, .ranked_replay, .backline_protector, .backline_ward, .cemetery, .coherent_melee };
    const names = [_][]const u8{ "explicit", "prioritize", "defend-to-wait", "finish", "ranged-positioning", "forbidden-target", "splash", "damage-spell", "vine", "smoke", "nightmare", "healer", "blacksmith", "ranked-replay", "backline-protector", "backline-ward", "cemetery", "coherent-melee" };
    for (order, names) |pass, name| {
        const rin = c.s.rng.state;
        if (!runPass(c, pass, &cur, &next)) return false;
        util.copyDecision(&cur, &next);
        @import("policy.zig").note(name, &cur, c.s, rin);
    }
    util.copyDecision(out, &cur);
    return true;
}

/// prioritizeV08CemeteryObstacleAttack: with a standing scattered stone and no committed attack, strike or cast, the
/// best direct attack, else a stone strike, else the decision.
pub fn cemetery(c: *ai.Ctx, in: *const ai.Decision, out: *ai.Decision) bool {
    const t = &c.s.grid.terrain;
    // V08_POSTURE_PROTECTED_ACTION_TYPES: a strike, a shot, an area throw, an obstacle attack or a cast.
    const protected = util.combatAction(in);
    if (t.n_layout == 0 or t.standing == 0 or protected) {
        util.copyDecision(out, in);
        return true;
    }
    var set: cand.Set = .{};
    cand.enumerate(c, in, cand.BOUNDARY_MOUNTAINS, &set);
    if (set.incomplete) return false;
    if (selectDirectCombat(&set)) |i| {
        take(out, &set, i);
        return true;
    }
    for (set.slice(), 0..) |*cd, i| if (cd.kind == .mine) {
        take(out, &set, i);
        return true;
    };
    util.copyDecision(out, in);
    return true;
}

/// Runs one ported pass on `in`; false when the pass is not ported yet, or met a term it cannot follow exactly
/// (util.unsupported, e.g. an incomplete candidate list).
pub fn runPass(c: *ai.Ctx, pass: Pass, in: *const ai.Decision, out: *ai.Decision) bool {
    util.unsupported = false;
    return runPassInner(c, pass, in, out) and !util.unsupported;
}

fn runPassInner(c: *ai.Ctx, pass: Pass, in: *const ai.Decision, out: *ai.Decision) bool {
    switch (pass) {
        .explicit => explicit(c.ui, in, out),
        .defend_to_wait => defendToWait(c.s, c.ui, in, out),
        .prioritize => prioritize(c, in, out),
        .finish => return finish(c, in, out),
        .backline_ward => backlineWard(c, in, out),
        .backline_protector => backlineProtector(c, in, out),
        .coherent_melee => return coherentMelee(c, in, out),
        .forbidden_target => return forbiddenTarget(c, in, out),
        .splash => splashRanged(c, in, out),
        .damage_spell => damageSpell(c, in, out),
        .vine => vineThrow(c, in, out),
        .healer => healerSustain(c, in, out),
        .smoke => wanderingMageSmoke(c, in, out),
        .blacksmith => blacksmithCraft(c, in, out),
        .nightmare => nightmareFireWall(c, in, out),
        // Identity: ranked-replay tactics are an off-by-default research scope.
        .ranked_replay => util.copyDecision(out, in),
        .cemetery => return cemetery(c, in, out),
        .ranged_positioning => return rangedPositioning(c, in, out),
    }
    return true;
}
