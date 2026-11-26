//! Fire Wall terms of the v0.8 policy port (src/engine/post_move_actor_availability.ts): the stack a move would leave
//! after Made of Fire's boost and the burning cells it enters, and the repair of a move-prefixed attack whose actor the
//! walk would remove or whose Cowardice the walk would bar.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const spells = @import("../spells.zig");
const abilities = @import("../abilities.zig");
const artifacts = @import("../artifacts.zig");
const ai = @import("../ai.zig");

const Cell = rec.Cell;

/// IStackHpState.
pub const Stack = struct { hp: f64, max_hp: f64, alive: f64, died: f64 };

/// IPostMoveActorAvailability's availableAfterMove, resurrected and stack.
pub const PostMove = struct { available: bool, resurrected: bool, stack: Stack };

/// projectStackDamage (units/stack_damage.ts): the front creature takes the hit, whole creatures die past it.
fn stackDamage(state: Stack, requested: f64) struct { state: Stack, dead: bool } {
    var next = state;
    if (requested <= 0) return .{ .state = next, .dead = next.alive <= 0 };
    if (requested < next.hp) {
        next.hp -= requested;
        return .{ .state = next, .dead = false };
    }
    const front = next.hp;
    next.died += 1;
    next.alive -= 1;
    const remaining = requested - front;
    next.hp = next.max_hp;
    const additional = @floor(remaining / next.max_hp);
    if (additional >= next.alive) {
        next.died += next.alive;
        next.alive = 0;
        return .{ .state = next, .dead = true };
    }
    next.died += additional;
    next.alive -= additional;
    next.hp -= @rem(remaining, next.max_hp);
    return .{ .state = next, .dead = false };
}

fn sameCell(a: Cell, b: Cell) bool {
    return a.x == b.x and a.y == b.y;
}

/// moveCellsMatchAsSet: the same length and every cell of `a` in `b`.
fn cellsMatchAsSet(a: []const Cell, b: []const Cell) bool {
    if (a.len != b.len) return false;
    for (a) |x| {
        var found = false;
        for (b) |y| {
            if (sameCell(x, y)) found = true;
        }
        if (!found) return false;
    }
    return true;
}

/// isMovePathFootprintOnly(isSmallSize, path, targetCells, width, height, currentAnchor): a multi-cell body whose path is
/// its destination footprint (as a set), except a line body whose path starts on its current anchor (a real route).
fn footprintOnly(u: *const st.Unit, path: []const Cell, target: []const Cell, base: Cell) bool {
    if (u.fw == 1 and u.fh == 1) return false;
    if (target.len == 0 or !cellsMatchAsSet(path, target)) return false;
    const line = u.fw == 1 or u.fh == 1;
    if (line and path.len > 1 and sameCell(path[0], base)) return false;
    return true;
}

/// projectPostMoveActorAvailability for a move along `path` (the move action's cells, as the AI emits them) onto the
/// footprint `target`, with the route's lava flag (no resolved route). travelledMovePath drops a first cell on the base;
/// a route that applies its modifiers (a travelled path) and touched lava gives a lava traverser without the buff Made
/// of Fire's max hp (ceil(max hp + max hp / power), not lower). Then each burning cell the body enters
/// (fireWallCellsForTraversal + enteredFireWallCells: a flyer or a footprint-only move only its landing cells) burns the
/// projected stack for fireWallBurnDamage at that cell's share (the unit's element, magic resist and magic damage taken
/// as they are now); a 0 burn or a death stops it. An intact Water Shield on an unbroken holder (willWaterShieldAbsorb, no
/// attacker or element) absorbs the first burn that does damage. A
/// stack the fire kills that can resurrect itself revives min(died, max(1, floor(died / 2))) creatures. Available when
/// creatures stand.
pub fn projectPostMove(s: *const st.State, ui: u8, path: []const Cell, target: []const Cell, has_lava: bool) PostMove {
    const u = &s.units[ui];
    var stack = Stack{ .hp = u.hp, .max_hp = u.max_hp, .alive = u.amount_alive, .died = u.amount_died };
    const base = engine.baseCell(u);
    const only = footprintOnly(u, path, target, base);
    const travelled: []const Cell = if (only) path else if (path.len > 0 and sameCell(path[0], base)) path[1..] else path;
    const modifiers = !only and travelled.len > 0;
    if (modifiers and has_lava and artifacts.canTraverseLava(s, u) and u.buffs.find(.made_of_fire) == null) {
        stack.max_hp = @max(@ceil(stack.max_hp + stack.max_hp / s.mof_power), stack.max_hp);
    }
    if (s.fight.n_fire != 0) {
        var burning: engine.Swept = .{};
        const start = engine.unitCells(u);
        engine.burningCellsEntered(s, ui, start.slice(), travelled, target, only, &burning);
        // fireWallBurnTargetOf, read once (Ember Covenant counts as Fire Element, as the engine's burn reads it).
        const elem: f64 = if (u.buffs.len != 0 and u.buffs.find(.ember_covenant_blessing) != null) 0 else spells.elementMultiplier(st.Element.FIRE, u);
        const mr = @max(0, @min(100, engine.getMagicResist(u)));
        const heavy = spells.magicDamageTakenMultiplier(u);
        var shield = abilities.waterShieldAbsorbs(s, u, null, st.Element.UNSET);
        for (burning.slice()) |c| {
            const requested = engine.fireBurnDamage(stack.alive * stack.max_hp, s.fight.firePct(c.x, c.y), elem, mr, heavy);
            if (requested <= 0) break;
            if (shield) {
                shield = false;
                continue;
            }
            const d = stackDamage(stack, requested);
            stack = d.state;
            if (d.dead) break;
        }
    }
    var resurrected = false;
    if (stack.alive <= 0 and engine.canSelfResurrect(u)) {
        const revived = @min(stack.died, @max(1, @floor(stack.died / 2)));
        if (revived > 0) {
            stack.alive += revived;
            stack.died -= revived;
            resurrected = true;
        }
    }
    return .{ .available = stack.alive > 0, .resurrected = resurrected, .stack = stack };
}

/// The projected stack's cumulative hp: (alive - 1) x max hp + max(0, hp).
pub fn stackHp(p: PostMove) f64 {
    return (p.stack.alive - 1) * p.stack.max_hp + @max(0, p.stack.hp);
}

/// repairUnavailableMovePrefixedAttack: when the decision moves the unit and then strikes or shoots with it, keep only
/// the actions up to the move if the projected walk leaves the unit unable to act, or if Cowardice (projected hp) bars
/// one of its strikes on a living target.
pub fn repairMovePrefixedAttack(s: *const st.State, ui: u8, d: *ai.Decision) void {
    const acts = d.slice();
    var move: ?usize = null;
    for (acts, 0..) |a, i| {
        if (a == .move_unit and a.move_unit.unit == ui) {
            move = i;
            break;
        }
    }
    const mi = move orelse return;
    var dependent = false;
    for (acts[mi + 1 ..]) |a| {
        switch (a) {
            .melee_attack => |m| if (m.attacker == ui) {
                dependent = true;
            },
            .range_attack => |r| if (r.attacker == ui) {
                dependent = true;
            },
            else => {},
        }
    }
    if (!dependent) return;
    const m = acts[mi].move_unit;
    const p = projectPostMove(s, ui, m.path, m.target_cells, m.has_lava);
    if (!p.available) {
        d.n = @intCast(mi + 1);
        return;
    }
    if (!engine.cowardly(s, &s.units[ui])) return;
    const hp = stackHp(p);
    for (acts[mi + 1 ..]) |a| {
        if (a != .melee_attack or a.melee_attack.attacker != ui) continue;
        const t = &s.units[a.melee_attack.target];
        if (t.in_holder and !t.isDead() and hp < engine.cumulativeHp(t)) {
            d.n = @intCast(mi + 1);
            return;
        }
    }
}
