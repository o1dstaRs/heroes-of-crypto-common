//! The v0.2 level of the v0.8 chain (src/ai/versions/v0_2.ts StrategyV0_2.decideTurn) with v0.8's seams:
//! requireResolvedPrimaryRangeTarget is true (a plain shot names and aims at the stack it hits first, through an edge
//! the cursor can select), screen pressure is off (V08_VISIBLE_EDGE_SCREEN_PRESSURE unset), shots are scored by
//! v0.5's learned scoreShot and biased by v0.3's Beholder shotTargetBonus. Out of scope (no spells or abilities):
//! "No Melee", MAGIC casts, the Ogre Mage / Behemoth openers, the Griffin dive and aura moves.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const combat = @import("../combat.zig");
const pathing = @import("../path.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const policy = @import("policy.zig");
const spells = @import("../spells.zig");
const weights = @import("weights.zig");

const Cell = st.Cell;
const State = st.State;
const Unit = st.Unit;
const AT = st.AttackType;
const W = weights.W;

/// A stack at or below this power retaliates for so little that dodging its counter is not worth a retarget.
const NEGLIGIBLE_COUNTER_STACK_POWER: f64 = 1;

pub fn decide(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    const rin = s.rng.state;
    const ranged = u.attack_type == AT.RANGE;
    if (ranged and !engine.canLandRangeAttack(s, u)) {
        meleeFallback(c, out);
    } else if (ranged) {
        decideRangedTurn(c, out);
    } else if (u.attack_type == AT.MAGIC and spellTurn(c, out)) {
        // a MAGIC unit's beneficial cast
    } else if (!creatureOpener(c, out) and !griffinDive(c, out)) {
        policy.v01(c, out);
        preferNoCounterMeleeTarget(c, out);
        withAura(c, out);
    }
    policy.note("v0.2", out, s, rin);
}

// =====================================================================================================================
// Ranged turn
// =====================================================================================================================

const Shot = struct { cell: Cell, side: u8, target: u8, score: f64 };

fn decideRangedTurn(c: *ai.Ctx, out: *ai.Decision) void {
    const best = findBestShot(c) orelse return policy.v01(c, out);
    out.* = .{};
    const u = c.unit();
    if (u.attack_type_selected != AT.RANGE) out.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.RANGE } });
    out.push(.{ .range_attack = .{ .attacker = c.ui, .target = best.target, .aim_cell = best.cell, .aim_side = best.side } });
}

/// Every selectable edge of every enemy whose authoritative first hit is that enemy; the best scored shot wins
/// (first wins ties: enemies in holder order, their cells, sides LEFT, RIGHT, DOWN, UP).
fn findBestShot(c: *ai.Ctx) ?Shot {
    const s = c.s;
    const u = c.unit();
    const team = u.team;
    const opp = engine.opposite(team);
    const from = [2]f64{ u.pos_x, u.pos_y };
    const small = engine.isSmall(u);
    var best: ?Shot = null;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        // Not a Hidden (Disguise) stack, nor the Terrifying Gaze gazer; the first hit is this enemy, so it is neither.
        if (e.isHidden() or u.cannotAttack(e.uid)) continue;
        const ei: u8 = @intCast(i);
        const to = [2]f64{ e.pos_x, e.pos_y };
        const e_small = engine.isSmall(e);
        const cells = engine.unitCells(e);
        for (cells.slice()) |cell| {
            for ([_]u8{ 0, 1, 2, 3 }) |side| {
                if (!combat.sideObservable(s, cell, side, team)) continue;
                if (!util.sideSelectable(s, cell, side, from, to, small, e_small, team)) continue;
                const aim = combat.sideCenter(cell, side, from[0], from[1]);
                const hits = combat.evaluateRange(s, c.ui, from[0], from[1], aim[0], aim[1]);
                if (hits.len == 0 or hits.units[0] != ei) continue;
                const value0 = scoreShot(c, &hits);
                if (value0 <= 0) continue;
                const value = value0 + shotTargetBonus(c, ei, value0);
                if (best == null or value > best.?.score) best = .{ .cell = cell, .side = side, .target = ei, .score = value };
            }
        }
    }
    return best;
}

/// firepowerOf (v0_5.ts): shots x max hit.
inline fn firepowerOf(u: *const Unit) f64 {
    return @max(1, engine.getRangeShots(u)) * @max(1, u.attack_damage_max);
}

/// StrategyV0_5.scoreShot: the learned shot scorer over every unit the shot's evaluation lists.
fn scoreShot(c: *const ai.Ctx, hits: *const combat.Hits) f64 {
    const s = c.s;
    const u = c.unit();
    const team = u.team;
    const opp = engine.opposite(team);
    const w_damage = W[0];
    const w_kill = W[1];
    const w_range = W[2];
    const w_firepower = W[3];
    const w_level = W[4];
    const w_friendly = W[5];
    const w_focus = W[53];
    const w_tempo = W[54];
    const w_wounded = W[55];
    // The shooter's living allies' footprints (for focus fire).
    var allies: [st.MAX_UNITS]engine.Cells = undefined;
    var n_allies: usize = 0;
    if (w_focus != 0) {
        for (s.holderOrder()) |i_slot| {
            const i: usize = i_slot;
            const a = &s.units[i_slot];
            if (!util.livingOf(s, i, team) or i == c.ui) continue;
            allies[n_allies] = engine.unitCells(a);
            n_allies += 1;
        }
    }
    const shots: f64 = 1; // Double Shot: out of scope
    var value: f64 = 0;
    for (hits.units[0..hits.len], hits.divisors[0..hits.len]) |ti, divisor| {
        const t = &s.units[ti];
        const lo = util.damageMin(u, t, true, divisor);
        const hi = util.damageMax(u, t, true, divisor);
        const hp = util.cumulativeHp(t);
        const effective = @min((shots * (lo + hi)) / 2, hp);
        if (t.team == opp) {
            value += w_damage * effective;
            if (effective >= hp) value += w_kill * hp;
            if (t.attack_type == AT.RANGE) value += w_range * effective;
            value += w_firepower * (firepowerOf(t) / 1000);
            value += w_level * @as(f64, @floatFromInt(t.level));
            // getCanCastSpells (a spellbook; a gifted Wild Regeneration or a stolen castable card adds one).
            if (t.canCastSpells()) value += W[52];
            if (w_focus != 0) {
                const tc = engine.unitCells(t);
                var adjacent: f64 = 0;
                for (allies[0..n_allies]) |*fp| {
                    if (util.footprintsNear(fp.slice(), tc.slice())) adjacent += 1;
                }
                value += w_focus * (adjacent / 2);
            }
            if (w_tempo != 0 and !util.madeTurn(s, ti)) value += w_tempo * (if (effective >= hp) 1 else effective / hp);
            if (w_wounded != 0) {
                const died = t.amount_died;
                const alive = t.amount_alive;
                value += w_wounded * (if (died + alive > 0) died / (died + alive) else 0);
            }
        } else if (t.team == team) {
            value -= w_friendly * effective;
        }
    }
    return value;
}

const BEHOLDER_FRESH_WEIGHT: f64 = 0.35;
const BEHOLDER_YET_TO_ACT_MULT: f64 = 1.8;
const BEHOLDER_THREAT_MULT: f64 = 1.3;
/// SPIT_BALL_DEBUFFS (Sadness, Quagmire, Weakening Beam, Weakness, Cowardice) and Rangebane: none exists in scope.
const SPIT_BALL_DEBUFFS: f64 = 5;

/// StrategyV0_3.shotTargetBonus: the Beholder's debuff-spreading bias.
fn shotTargetBonus(c: *const ai.Ctx, ei: u8, base: f64) f64 {
    if (util.creature(c.s, c.ui) != .beholder) return 0; // or "Spit Ball": abilities out of scope
    const s = c.s;
    const e = &s.units[ei];
    const targets_range = e.attack_type == AT.RANGE;
    const possible = SPIT_BALL_DEBUFFS + @as(f64, if (targets_range) 1 else 0);
    const fresh = possible; // no target carries any of them in scope
    var bonus = base * BEHOLDER_FRESH_WEIGHT * (fresh / possible);
    if (!util.madeTurn(s, ei)) bonus *= BEHOLDER_YET_TO_ACT_MULT;
    if (canThreatenThisTurn(c, ei)) bonus *= BEHOLDER_THREAT_MULT;
    return bonus;
}

fn canThreatenThisTurn(c: *const ai.Ctx, ei: u8) bool {
    const s = c.s;
    const e = &s.units[ei];
    if (e.attack_type == AT.RANGE) return engine.getRangeShots(e) > 0;
    const reach = engine.getSteps(e) + 1;
    const ec = engine.baseCell(e);
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const a = &s.units[i_slot];
        if (!util.livingOf(s, i, c.unit().team)) continue;
        if (ai.cellDistance(ec, engine.baseCell(a)) <= reach) return true;
    }
    return false;
}

// =====================================================================================================================
// A ranged unit that cannot land a shot
// =====================================================================================================================

fn meleeFallback(c: *ai.Ctx, out: *ai.Decision) void {
    out.* = .{};
    const u = c.unit();
    const ui = c.ui;
    const need_select = u.attack_type_selected != AT.MELEE;
    const select = rec.Action{ .select_attack_type = .{ .unit = ui, .attack_type = AT.MELEE } };
    // 1) An enemy already adjacent: strike in place.
    if (adjacentEnemy(c)) |t| {
        if (need_select) out.push(select);
        out.push(.{ .melee_attack = .{ .attacker = ui, .target = t, .attack_from = engine.baseCell(u), .path = &.{} } });
        return;
    }
    // 2) A reachable cell next to an enemy: move and strike.
    if (meleeApproach(c)) |ap| {
        if (need_select) out.push(select);
        const len = c.actualPath().routeCells(ap.route, &out.path);
        out.push(.{ .melee_attack = .{ .attacker = ui, .target = ap.target, .attack_from = ap.route.cell, .path = out.path[0..len], .has_lava = ap.route.has_lava } });
        return;
    }
    // 3) Advance (fallbackTurn holds the turn when the unit cannot move).
    ai.fallbackTurn(c, out);
    if (out.n == 1 and out.actions[0] == .end_turn) return;
    if (need_select) {
        std.debug.assert(out.n < out.actions.len);
        var j: usize = out.n;
        while (j > 0) : (j -= 1) out.actions[j] = out.actions[j - 1];
        out.actions[0] = select;
        out.n += 1;
    }
}

/// The first living enemy (holder order) whose footprint touches the unit's.
fn adjacentEnemy(c: *const ai.Ctx) ?u8 {
    const s = c.s;
    const u = c.unit();
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const e = &s.units[i_slot];
        if (!util.livingOf(s, i, opp)) continue;
        const ec = engine.unitCells(e);
        if (util.footprintsNear(ec.slice(), mine.slice())) return @intCast(i);
    }
    return null;
}

const Approach = struct { route: *const pathing.Route, target: u8 };

/// The shortest-route reachable stand cell whose footprint touches an enemy (first wins ties, knownPaths order),
/// with the first enemy it touches.
fn meleeApproach(c: *ai.Ctx) ?Approach {
    const s = c.s;
    const u = c.unit();
    if (!u.canMove()) return null;
    const opp = engine.opposite(u.team);
    // The living enemies that are not Hidden (Disguise).
    var any = false;
    for (0..s.n_units) |i| {
        if (util.livingOf(s, i, opp) and !s.units[i].isHidden()) any = true;
    }
    if (!any) return null;
    const mp = c.actualPath();
    if (mp.size() == 0) return null;
    var best: ?Approach = null;
    var best_len: usize = 0;
    var buf: [64]Cell = undefined;
    for (mp.known()) |*r| {
        const len = mp.routeCells(r, &buf);
        if (len == 0) continue;
        const fp = ai.footprintForAnchor(u, r.cell);
        for (s.holderOrder()) |i_slot| {
            const i: usize = i_slot;
            const e = &s.units[i_slot];
            if (!util.livingOf(s, i, opp) or e.isHidden()) continue;
            const ec = engine.unitCells(e);
            if (util.footprintsNear(ec.slice(), fp.slice())) {
                if (best == null or len < best_len) {
                    best = .{ .route = r, .target = @intCast(i) };
                    best_len = len;
                }
                break;
            }
        }
    }
    return best;
}

// =====================================================================================================================
// preferNoCounterMeleeTarget
// =====================================================================================================================

/// Would striking this stack in melee provoke a counter worth dodging?
fn counterMatters(s: *const State, t: u8) bool {
    const u = &s.units[t];
    if (engine.getStackPower(u) <= NEGLIGIBLE_COUNTER_STACK_POWER) return false;
    if (util.repliedAttack(s, t)) return false;
    return util.canRespondMelee(u);
}

/// An in-place strike on a stack that would counter moves to the most threatening equally adjacent enemy that
/// would not (it already responded), never overriding a forced target or a move-and-strike.
/// withAura (v0_2.ts): an aura emitter that would only move repositions to the reachable cell covering the most targets,
/// else hourglasses while more targets can still come into range and nothing threatens it, else refuses an advance that
/// would drag its auras off targets it covers now. Attacks pass straight through; non-emitters are untouched.
/// decideCreatureOpener: a Behemoth casts Battle Roar (an all-allies buff) while the mass cast is legal (canMassCastSpell,
/// the engine's own gate). The Ogre Mage's Mass Riot is wave 2: no book in scope holds it.
fn creatureOpener(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (!u.canCastSpells()) return false;
    if (util.creature(s, c.ui) != .behemoth) return false;
    const spell = st.CastSpell.battle_roar;
    const raw: u8 = @intFromEnum(spell);
    const b = u.bookSpell(raw) orelse return false;
    const cfg = &s.spell_cfg[raw];
    if (!cfg.loaded or !spells.usable(u, b, cfg)) return false;
    if (!spells.canMassCastSpell(s, c.ui, spell, cfg)) return false;
    out.* = .{};
    out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = raw } });
    return true;
}

/// decideSpellTurn: a MAGIC unit with stack power 1 or more casts its most valuable beneficial spell (strictly positive,
/// first wins ties, spells in book order). A summon is worth amount x 60 while the team out-shoots the enemy, else x 3,
/// at the getRandomGridCellAroundPosition cell (an RNG draw per summon considered) when the body fits there, else the
/// first anchor around the caster that fits. A mass heal or buff is worth 200 per beneficiary (a buff only while an
/// enemy that is not Hidden stands within half the board); an ally heal goes to the ally missing the most HP on its top
/// creature, an ally buff (fighting soon) to the most threatening ally without it, each through canCastSpell.
/// Debuffs and damage spells are never cast here.
fn spellTurn(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (u.n_spells == 0 or engine.getStackPower(u) < 1) return false;
    const team = u.team;
    const opp = engine.opposite(team);
    var any_ally = false;
    for (s.holderOrder()) |k| {
        if (util.livingOf(s, k, team)) any_ally = true;
    }
    if (!any_ally) return false;
    const base = engine.baseCell(u);
    var nearest = std.math.inf(f64);
    for (s.holderOrder()) |k| {
        if (!util.livingOf(s, k, opp) or s.units[k].isHidden()) continue;
        nearest = @min(nearest, ai.cellDistance(base, engine.baseCell(&s.units[k])));
    }
    const fighting_soon = nearest <= @as(f64, @floatFromInt(st.GRID)) / 2;
    const ranged_superior = util.teamRangedOutput(s, team) > util.teamRangedOutput(s, opp);
    var best_value: f64 = 0;
    var best_spell: ?u8 = null;
    var best_target: ?u8 = null;
    var best_cell: ?Cell = null;
    for (u.spells[0..u.n_spells]) |*b| {
        const spell = std.meta.intToEnum(st.CastSpell, b.spell) catch {
            util.unsupported = true;
            return false;
        };
        const cfg = &s.spell_cfg[b.spell];
        if (!cfg.loaded) {
            util.unsupported = true;
            return false;
        }
        if (!spells.usable(u, b, cfg)) continue;
        const is_heal = cfg.power_type == st.SpellPower.HEAL;
        if (spell == .summon_wolves and cfg.target == st.SpellTarget.RANDOM_CLOSE_TO_CASTER) {
            const amount = @floor(u.amount_alive * cfg.power);
            const sm = s.summons orelse {
                util.unsupported = true; // no Wolf template: the summoned body's footprint is unknown
                return false;
            };
            if (!sm.present[st.Summons.WOLF]) {
                util.unsupported = true;
                return false;
            }
            const fw = sm.units[st.Summons.WOLF].fw;
            const fh = sm.units[st.Summons.WOLF].fh;
            var cell: ?Cell = null;
            if (util.randomGridCellAroundPosition(c, team, u.pos_x, u.pos_y)) |rc| {
                if (spells.seatFree(s, rc, fw, fh)) cell = rc;
            }
            if (cell == null) cell = firstSummonableAnchor(s, c.ui, fw, fh);
            if (amount > 0) {
                if (cell) |sc| {
                    const value = amount * @as(f64, if (ranged_superior) 60 else 3);
                    if (value > best_value) {
                        best_value = value;
                        best_spell = b.spell;
                        best_target = null;
                        best_cell = sc;
                    }
                }
            }
            continue;
        }
        if (!cfg.is_buff and !is_heal) continue;
        const applied = spell.applied();
        if (cfg.target == st.SpellTarget.ALL_ALLIES or cfg.target == st.SpellTarget.ALL_FLYING) {
            var beneficiaries: f64 = 0;
            for (s.holderOrder()) |k| {
                const a = &s.units[k];
                if (!util.livingOf(s, k, team) or (!cfg.self_cast and k == c.ui)) continue;
                if (cfg.target == st.SpellTarget.ALL_FLYING and !engine.canFly(a)) continue;
                const benefits = if (is_heal) a.hp < a.max_hp and engine.getMagicResist(a) != 100 else !(if (applied) |id| a.buffs.find(id) != null else false);
                if (benefits) beneficiaries += 1;
            }
            if (beneficiaries > 0 and (is_heal or fighting_soon)) {
                const value = beneficiaries * 200;
                if (value > best_value) {
                    best_value = value;
                    best_spell = b.spell;
                    best_target = null;
                    best_cell = null;
                }
            }
        } else if (cfg.target == st.SpellTarget.ANY_ALLY) {
            var target: ?u8 = null;
            var value: f64 = 0;
            if (is_heal or fighting_soon) {
                for (s.holderOrder()) |k| {
                    const a = &s.units[k];
                    if (!util.livingOf(s, k, team) or (!cfg.self_cast and k == c.ui)) continue;
                    var v: f64 = undefined;
                    if (is_heal) {
                        v = a.max_hp - a.hp;
                    } else {
                        if (applied) |id| if (a.buffs.find(id) != null) continue;
                        v = ai.threat(a); // meleeThreat (no Helping Hand in scope)
                    }
                    if (v > value) {
                        value = v;
                        target = k;
                    }
                }
            }
            if (target) |t| {
                if (spells.canCastSpell(s, c.ui, t, spell, cfg) and value > best_value) {
                    best_value = value;
                    best_spell = b.spell;
                    best_target = t;
                    best_cell = null;
                }
            }
        }
    }
    const raw = best_spell orelse return false;
    out.* = .{};
    out.push(.{ .cast_spell = .{ .caster = c.ui, .spell = raw, .target = best_target orelse 0, .has_target = best_target != null, .cell = best_cell orelse .{ .x = 0, .y = 0 }, .has_cell = best_cell != null } });
    return true;
}

/// firstSummonableAnchor over getCellsAroundFootprint(caster cells): for every offset inside the summoned body (dx outer,
/// then dy) and every ring cell, the first new anchor whose whole body is on the board and free.
fn firstSummonableAnchor(s: *const st.State, ci: u8, fw: u8, fh: u8) ?Cell {
    var ring: spells.Cells = .{};
    const body = engine.unitCells(&s.units[ci]);
    spells.cellsAroundFootprint(body.slice(), &ring);
    var tried: [96]Cell = undefined;
    var n: usize = 0;
    for (0..fw) |dx| {
        for (0..fh) |dy| {
            for (ring.slice()) |r| {
                const a = Cell{ .x = r.x + @as(i32, @intCast(dx)), .y = r.y + @as(i32, @intCast(dy)) };
                var seen = false;
                for (tried[0..n]) |t| {
                    if (t.x == a.x and t.y == a.y) seen = true;
                }
                if (seen) continue;
                if (n < tried.len) {
                    tried[n] = a;
                    n += 1;
                }
                if (spells.seatFree(s, a, fw, fh)) return a;
            }
        }
    }
    return null;
}

/// decideGriffinDive: a Range Null Field emitter that can move, facing living enemy shooters, with another living flyer
/// within its steps + aura range + 2 of the nearest shooter, flies where the most shooters fall inside the aura (by
/// Euclidean distance from the landing anchor to their base cells, the aura's own range) and strikes a shooter next to
/// that anchor, the cheapest route on ties; with no strike cell it advances to the best-covering cell.
fn griffinDive(c: *ai.Ctx, out: *ai.Decision) bool {
    const s = c.s;
    const u = c.unit();
    if (!u.has(.range_null_field_aura) or !u.canMove()) return false;
    const opp = engine.opposite(u.team);
    var ranged: [st.MAX_UNITS]u8 = undefined;
    var nr: usize = 0;
    for (s.holderOrder()) |k| {
        if (!util.livingOf(s, k, opp) or s.units[k].attack_type != AT.RANGE) continue;
        ranged[nr] = k;
        nr += 1;
    }
    if (nr == 0) return false;
    // nullFieldRange: the widest debuff aura the unit emits.
    var aura_r: f64 = 0;
    for (u.auras[0..u.auraCount()]) |d| {
        if (!s.aura_defs[d].is_buff) aura_r = @max(aura_r, s.aura_defs[d].range);
    }
    // hasFlyingSupport
    var support = false;
    for (s.holderOrder()) |k| {
        const a = &s.units[k];
        if (k == c.ui or !util.livingOf(s, k, u.team) or !engine.canFly(a)) continue;
        var nearest = std.math.inf(f64);
        for (ranged[0..nr]) |r| nearest = @min(nearest, ai.cellDistance(engine.baseCell(a), engine.baseCell(&s.units[r])));
        if (nearest <= engine.getSteps(a) + aura_r + 2) {
            support = true;
            break;
        }
    }
    if (!support) return false;
    const mp = c.actualPath();
    const Pick = struct { route: *const pathing.Route, target: u8 = 0, cover: u32, weight: f64 };
    var strike: ?Pick = null;
    var advance: ?Pick = null;
    for (mp.known()) |*r| {
        var cover: u32 = 0;
        for (ranged[0..nr]) |k| {
            if (ai.cellDistance(r.cell, engine.baseCell(&s.units[k])) <= aura_r) cover += 1;
        }
        if (cover == 0) continue;
        if (advance == null or cover > advance.?.cover or (cover == advance.?.cover and r.weight < advance.?.weight)) advance = .{ .route = r, .cover = cover, .weight = r.weight };
        var adj: ?u8 = null;
        for (ranged[0..nr]) |k| {
            const kc = engine.unitCells(&s.units[k]);
            for (kc.slice()) |rc| if (util.near(rc, r.cell)) {
                adj = k;
                break;
            };
            if (adj != null) break;
        }
        if (adj) |t| {
            if (strike == null or cover > strike.?.cover or (cover == strike.?.cover and r.weight < strike.?.weight)) strike = .{ .route = r, .target = t, .cover = cover, .weight = r.weight };
        }
    }
    if (strike) |st_| {
        var d: ai.Decision = .{};
        if (u.attack_type_selected != AT.MELEE) d.push(.{ .select_attack_type = .{ .unit = c.ui, .attack_type = AT.MELEE } });
        const len = mp.routeCells(st_.route, &d.path);
        d.push(.{ .melee_attack = .{ .attacker = c.ui, .target = st_.target, .attack_from = st_.route.cell, .path = d.path[0..len], .has_lava = st_.route.has_lava } });
        util.copyDecision(out, &d);
        return true;
    }
    const base = engine.baseCell(u);
    if (advance) |a| {
        if (!(a.route.cell.x == base.x and a.route.cell.y == base.y) and mp.routeCells(a.route, &out.path) > 0) {
            util.setMove(out, s, c.ui, mp, a.route);
            return true;
        }
    }
    return false;
}

fn withAura(c: *ai.Ctx, out: *ai.Decision) void {
    for (out.slice()) |a| switch (a) {
        .melee_attack, .range_attack, .cast_spell => return,
        else => {},
    };
    const plan = util.planAuraMove(c, .flat) orelse return;
    const s = c.s;
    const u = c.unit();
    const base = engine.baseCell(u);
    // 1) A reachable cell covers more targets: move there.
    if (plan.best_score > plan.current and !(plan.best.x == base.x and plan.best.y == base.y) and u.canMove()) {
        const mp = c.actualPath();
        if (mp.get(pathing.key(plan.best.x, plan.best.y))) |r| {
            var d: ai.Decision = .{};
            const len = mp.routeCells(r, &d.path);
            if (len > 0) {
                const body = ai.footprintForAnchor(u, plan.best);
                @memcpy(d.targets[0..body.slice().len], body.slice());
                d.push(.{ .move_unit = .{ .unit = c.ui, .path = d.path[0..len], .target_cells = d.targets[0..body.slice().len], .has_lava = r.has_lava } });
                util.copyDecision(out, &d);
                return;
            }
        }
    }
    // 2) Hourglass first: nothing better to cover yet, targets still out of range, no melee pressure.
    if (plan.best_score <= plan.current and plan.best_score < plan.coverable and plan.threats == 0 and util.canHourglass(s, c.ui)) {
        util.setWait(out, c.ui);
        return;
    }
    // 3) The default advance would drag the aura off targets: hold instead.
    for (out.slice()) |a| {
        if (a != .move_unit) continue;
        const m = a.move_unit;
        if (m.path.len > 0 and util.auraCoverageScore(s, c.ui, m.path[m.path.len - 1], .flat) < plan.current) util.setEndTurn(out, c.ui);
        break;
    }
}

fn preferNoCounterMeleeTarget(c: *ai.Ctx, out: *ai.Decision) void {
    const s = c.s;
    const u = c.unit();
    if (u.target >= 0) return;
    var idx: ?usize = null;
    for (out.slice(), 0..) |a, i| {
        if (a == .melee_attack) {
            idx = i;
            break;
        }
    }
    const i = idx orelse return;
    const strike = out.actions[i].melee_attack;
    const base = engine.baseCell(u);
    if (strike.path.len > 0 or strike.attack_from.x != base.x or strike.attack_from.y != base.y) return;
    const cur = strike.target;
    if (!s.units[cur].in_holder or !counterMatters(s, cur)) return;
    const mine = engine.unitCells(u);
    const opp = engine.opposite(u.team);
    var best: ?u8 = null;
    var best_threat: f64 = 0;
    for (s.holderOrder()) |k_slot| {
        const k: usize = k_slot;
        const e = &s.units[k_slot];
        const ek: u8 = @intCast(k);
        if (!util.livingOf(s, k, opp) or ek == cur) continue;
        if (e.isHidden() or u.cannotAttack(e.uid)) continue; // never swap onto a Hidden stack or the gazer
        if (!(engine.getStackPower(e) > NEGLIGIBLE_COUNTER_STACK_POWER) or counterMatters(s, ek)) continue;
        const ec = engine.unitCells(e);
        if (!util.footprintsNear(ec.slice(), mine.slice())) continue;
        const t = ai.threat(e);
        if (best == null or t > best_threat) {
            best = ek;
            best_threat = t;
        }
    }
    const b = best orelse return;
    out.actions[i].melee_attack.target = b;
}
