//! Shared helpers for the v0.8 port: the unit queries the TypeScript AI reads (src/units/unit.ts), the cursor-facing
//! shot gate (grid_math.ts isRangeAttackSideSelectable) and creature identity.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const combat = @import("../combat.zig");
const pathing = @import("../path.zig");
const ai = @import("../ai.zig");

pub const Cell = st.Cell;
pub const State = st.State;
pub const Unit = st.Unit;
pub const AT = st.AttackType;

// =====================================================================================================================
// Creature identity
// =====================================================================================================================

/// The creatures the v0.8 policy tests by name (`unit.getName() === "..."`); every other creature is `.other`.
pub const Creature = enum(u8) {
    other,
    abomination,
    angel,
    arachna_queen,
    arbalester,
    battle_mage,
    beholder,
    behemoth,
    black_dragon,
    blacksmith,
    centaur,
    cyclops,
    dryad,
    frenzied_boar,
    gargantuan,
    goblin_knight,
    griffin,
    harpy,
    healer,
    magic_dragon,
    monk,
    nightmare,
    ogre_mage,
    pikeman,
    satyr,
    scavenger,
    troll,
    tsar_cannon,
    unicorn,
    wolf,
    zena,

    pub fn fromName(n: []const u8) Creature {
        const table = [_]struct { []const u8, Creature }{
            .{ "Abomination", .abomination },   .{ "Angel", .angel },                 .{ "Arachna Queen", .arachna_queen },
            .{ "Arbalester", .arbalester },     .{ "Battle Mage", .battle_mage },     .{ "Beholder", .beholder },
            .{ "Behemoth", .behemoth },         .{ "Blacksmith", .blacksmith },       .{ "Centaur", .centaur },
            .{ "Dryad", .dryad },               .{ "Frenzied Boar", .frenzied_boar }, .{ "Goblin Knight", .goblin_knight },
            .{ "Griffin", .griffin },           .{ "Harpy", .harpy },                 .{ "Healer", .healer },
            .{ "Magic Dragon", .magic_dragon }, .{ "Monk", .monk },                   .{ "Nightmare", .nightmare },
            .{ "Ogre Mage", .ogre_mage },       .{ "Satyr", .satyr },                 .{ "Troll", .troll },
            .{ "Wolf", .wolf },                 .{ "Zena", .zena },                   .{ "Black Dragon", .black_dragon },
            .{ "Cyclops", .cyclops },           .{ "Gargantuan", .gargantuan },       .{ "Pikeman", .pikeman },
            .{ "Tsar Cannon", .tsar_cannon },   .{ "Scavenger", .scavenger },         .{ "Unicorn", .unicorn },
        };
        for (table) |e| if (std.mem.eql(u8, n, e[0])) return e[1];
        return .other;
    }
};

/// Per-battle facts the engine state does not carry (until Unit has a creature id): each unit's creature.
pub const Battle = struct {
    creature: [st.MAX_UNITS]Creature = .{.other} ** st.MAX_UNITS,

    /// From a recording's `init` (units in holder order, as engine.initState reads them).
    pub fn fromInit(init: std.json.Value) Battle {
        var b: Battle = .{};
        for (rec.get(init, "units").array.items, 0..) |u, i| {
            if (i >= st.MAX_UNITS) break;
            b.creature[i] = Creature.fromName(rec.get(u, "name").string);
        }
        return b;
    }
};

/// The battle being decided (set by whoever runs the policy, before the first decision).
pub threadlocal var battle: Battle = .{};

pub inline fn creature(ui: u8) Creature {
    return battle.creature[ui];
}

// =====================================================================================================================
// Unit queries (src/units/unit.ts)
// =====================================================================================================================

/// Unit.getCumulativeHp
pub fn cumulativeHp(u: *const Unit) f64 {
    if (u.isDead()) return 0;
    const hp = if (u.hp < 0) 0 else u.hp;
    return (u.amount_alive - 1) * u.max_hp + hp;
}

/// calculateAttackDamageMin(getAttack(), target, isRange, 0, divisor) (no Warlord's Edge, no synergy power).
pub inline fn damageMin(att: *const Unit, tgt: *const Unit, is_range: bool, divisor: f64) f64 {
    return combat.damageBound(att, tgt, att.attack_damage_min, is_range, divisor);
}

/// calculateAttackDamageMax(getAttack(), target, isRange, 0, divisor).
pub inline fn damageMax(att: *const Unit, tgt: *const Unit, is_range: bool, divisor: f64) f64 {
    return combat.damageBound(att, tgt, att.attack_damage_max, is_range, divisor);
}

/// Unit.canRespond(MELEE): no Stun / Blindness / Freeze effect and no "No Melee" ability. None exists in scope.
pub inline fn canRespondMelee(u: *const Unit) bool {
    _ = u;
    return true;
}

/// FightProperties.hasAlreadyMadeTurn
pub inline fn madeTurn(s: *const State, ui: u8) bool {
    return s.fight.made & engine.unitBit(ui) != 0;
}

/// FightProperties.hasAlreadyRepliedAttack
pub inline fn repliedAttack(s: *const State, ui: u8) bool {
    return s.fight.replied & engine.unitBit(ui) != 0;
}

/// Living units of a team in holder order (`getAllAllies(team).filter(!isDead)`).
pub inline fn livingOf(s: *const State, i: usize, team: u8) bool {
    const u = &s.units[i];
    return u.in_holder and u.team == team and !u.isDead();
}

// =====================================================================================================================
// Cells
// =====================================================================================================================

/// The AI's inclusive adjacency (`|dx| <= 1 && |dy| <= 1`, the same cell counts).
pub inline fn near(a: Cell, b: Cell) bool {
    return @abs(a.x - b.x) <= 1 and @abs(a.y - b.y) <= 1;
}

pub fn footprintsNear(a: []const Cell, b: []const Cell) bool {
    for (a) |x| for (b) |y| if (near(x, y)) return true;
    return false;
}

// =====================================================================================================================
// isRangeAttackSideSelectable (src/grid/grid_math.ts), plain shots (no Through Shot, structures not ignored)
// =====================================================================================================================

const Point = struct { x: f64, y: f64, side: u8, d: f64 };

/// Whether the player's ranged cursor can select this exact edge: a probe just inside the edge resolves, through
/// getClosestSideCenterDetailed, to this cell and side.
pub fn sideSelectable(s: *const State, cell: Cell, side: u8, from: [2]f64, to: [2]f64, from_small: bool, to_small: bool, team: u8) bool {
    if (side > 3) return false;
    const center = engine.positionForCell(@floatFromInt(cell.x), @floatFromInt(cell.y));
    const reach: f64 = @max(0, engine.HALF - 1);
    var probe = center;
    switch (side) {
        0 => probe[0] -= reach,
        1 => probe[0] += reach,
        2 => probe[1] -= reach,
        else => probe[1] += reach,
    }
    if (!engine.positionWithinGrid(probe[0], probe[1])) return false;
    const pc = engine.cellForPosition(probe[0], probe[1]);
    if (pc.x != cell.x or pc.y != cell.y) return false;
    const cp = engine.positionForCell(@floatFromInt(pc.x), @floatFromInt(pc.y));
    const half = engine.HALF;
    const step = engine.CELL;
    const ax = from[0];
    const ay = from[1];
    const tx = to[0];
    const ty = to[1];
    const same_or_big = from_small == to_small or !from_small;
    const small_to_big = from_small and !to_small;
    const big_to_small = to_small and !from_small;

    var pts: [4]Point = undefined;
    var n: usize = 0;
    if (combat.sideObservable(s, pc, 0, team) and !(big_to_small and ax == tx - half) and
        ((same_or_big and ax < tx) or (small_to_big and ax - half < tx - step)))
    {
        pts[n] = .{ .x = cp[0] - half, .y = cp[1], .side = 0, .d = 0 };
        n += 1;
    }
    if (combat.sideObservable(s, pc, 1, team) and !(big_to_small and ax == tx + half) and
        ((same_or_big and ax > tx) or (small_to_big and ax + half > tx + step)))
    {
        pts[n] = .{ .x = cp[0] + half, .y = cp[1], .side = 1, .d = 0 };
        n += 1;
    }
    if (combat.sideObservable(s, pc, 2, team) and !(big_to_small and ay == ty - half) and
        ((same_or_big and ay < ty) or (small_to_big and ay - half < ty - step)))
    {
        pts[n] = .{ .x = cp[0], .y = cp[1] - half, .side = 2, .d = 0 };
        n += 1;
    }
    if (combat.sideObservable(s, pc, 3, team) and !(big_to_small and ay == ty + half) and
        ((same_or_big and ay > ty) or (small_to_big and ay + half > ty + step)))
    {
        pts[n] = .{ .x = cp[0], .y = cp[1] + half, .side = 3, .d = 0 };
        n += 1;
    }
    if (n == 0) return false;
    for (pts[0..n]) |*p| p.d = engine.distance(ax, ay, p.x, p.y);
    // Sort by (distance, side index); stable insertion sort over at most four points.
    var i: usize = 1;
    while (i < n) : (i += 1) {
        const x = pts[i];
        var j = i;
        while (j > 0 and (x.d < pts[j - 1].d or (x.d == pts[j - 1].d and x.side < pts[j - 1].side))) : (j -= 1) pts[j] = pts[j - 1];
        pts[j] = x;
    }
    var chosen = pts[0];
    if (n > 1) {
        const da = engine.distance(pts[0].x, pts[0].y, probe[0], probe[1]);
        const db = engine.distance(pts[1].x, pts[1].y, probe[0], probe[1]);
        if (db < da) chosen = pts[1];
    }
    return chosen.side == side;
}

// =====================================================================================================================
// The hourglass rule (src/engine/hourglass.ts canWaitOnHourglass)
// =====================================================================================================================

/// FightProperties.hasUnactedTeammate: another living teammate in the holder has not made its turn this lap.
pub fn hasUnactedTeammate(s: *const State, ui: u8) bool {
    const team = s.units[ui].team;
    if (s.fight.team_units_alive[team] <= 1) return false;
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (i != ui and u.in_holder and !u.isDead() and u.team == team and !madeTurn(s, @intCast(i))) return true;
    }
    return false;
}

/// canWaitOnHourglass: whether the engine accepts a wait (hourglass) for this unit now. No Time Denial in scope.
pub fn canHourglass(s: *const State, ui: u8) bool {
    const u = &s.units[ui];
    if (u.team != st.Team.LEFT and u.team != st.Team.RIGHT) return false;
    if (u.moved_this_turn) return false;
    if (!hasUnactedTeammate(s, ui)) return false;
    if (u.on_hourglass) return false;
    if (s.fight.hourglass_q.includes(ui)) return false;
    if (madeTurn(s, ui)) return false;
    return s.fight.hourglass_set & engine.unitBit(ui) == 0;
}

/// isAoEUnit (v0_4.ts): by name, or by an AoE ability (abilities out of scope).
pub fn isAoEUnit(ui: u8) bool {
    return switch (creature(ui)) {
        .black_dragon, .pikeman, .gargantuan, .cyclops, .tsar_cannon => true,
        else => false,
    };
}

// =====================================================================================================================
// Team measures (src/ai/versions/v0_8.ts)
// =====================================================================================================================

inline fn nonnegativeFinite(v: f64) f64 {
    return if (std.math.isFinite(v)) @max(0, v) else 0;
}

/// v08TeamRangedOutput: living range-capable stacks' shots x max damage x amount (StrategyV0_8.rangedOutput).
pub fn teamRangedOutput(s: *const State, team: u8) f64 {
    var output: f64 = 0;
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!livingOf(s, i, team) or !engine.isRangeCapable(u)) continue;
        const stack = nonnegativeFinite(engine.getRangeShots(u)) * nonnegativeFinite(u.attack_damage_max) * nonnegativeFinite(u.amount_alive);
        output = @min(9007199254740991, output + stack);
    }
    return output;
}

pub const DOMINANT_FINISH_START_LAP: i32 = engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 5;
pub const DOMINANT_FINISH_HP_RATIO: f64 = 2;
pub const URGENT_FINISH_START_LAP: i32 = engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 3;

pub const FinishState = struct { own_hp: f64, enemy_hp: f64, dominant: bool, urgent: bool, active: bool };

/// v08DominantFinishState (v0_8_dominant_finish.ts). Summons are out of scope.
pub fn dominantFinishState(s: *const State, team: u8) FinishState {
    var own: f64 = 0;
    var enemy: f64 = 0;
    for (s.units[0..s.n_units]) |*u| {
        if (!u.in_holder or u.isDead()) continue;
        const hp = nonnegativeFinite(cumulativeHp(u));
        if (u.team == team) own += hp else enemy += hp;
    }
    const lap = s.fight.lap;
    const dominant = lap >= DOMINANT_FINISH_START_LAP and own >= DOMINANT_FINISH_HP_RATIO * enemy;
    const urgent = lap >= URGENT_FINISH_START_LAP;
    return .{ .own_hp = own, .enemy_hp = enemy, .dominant = enemy > 0 and dominant, .urgent = enemy > 0 and urgent, .active = enemy > 0 and (dominant or urgent) };
}

// =====================================================================================================================
// Decisions
// =====================================================================================================================

fn rebase(slice: []const Cell, from: []const Cell, to: []Cell) []const Cell {
    if (slice.len == 0) return slice;
    const start = @intFromPtr(slice.ptr);
    const lo = @intFromPtr(from.ptr);
    if (start < lo or start >= lo + from.len * @sizeOf(Cell)) return slice;
    const off = (start - lo) / @sizeOf(Cell);
    return to[off .. off + slice.len];
}

/// Copies a decision, re-pointing its actions' cell slices into the copy's own buffers.
pub fn copyDecision(dst: *ai.Decision, src: *const ai.Decision) void {
    dst.* = src.*;
    for (dst.actions[0..dst.n]) |*a| switch (a.*) {
        .move_unit => |*m| {
            m.path = rebase(m.path, &src.path, &dst.path);
            m.target_cells = rebase(m.target_cells, &src.targets, &dst.targets);
        },
        .melee_attack => |*m| m.path = rebase(m.path, &src.path, &dst.path),
        else => {},
    };
}

pub fn has(d: *const ai.Decision, comptime tag: std.meta.Tag(rec.Action)) bool {
    for (d.slice()) |a| if (a == tag) return true;
    return false;
}

/// The decision strikes or casts (melee_attack, range_attack; cast_spell is out of scope).
pub fn strikes(d: *const ai.Decision) bool {
    return has(d, .melee_attack) or has(d, .range_attack);
}

pub fn setWait(d: *ai.Decision, ui: u8) void {
    d.* = .{};
    d.push(.{ .wait_turn = .{ .unit = ui } });
}

pub fn setEndTurn(d: *ai.Decision, ui: u8) void {
    d.* = .{};
    d.push(.{ .end_turn = .{ .unit = ui, .reason = .manual } });
}

/// A single move_unit along `r` (path and footprint), replacing the decision.
pub fn setMove(d: *ai.Decision, s: *const State, ui: u8, mp: *const pathing.MovePath, r: *const pathing.Route) void {
    d.* = .{};
    const len = mp.routeCells(r, &d.path);
    const fp = ai.footprintForAnchor(&s.units[ui], r.cell);
    for (fp.slice(), 0..) |t, i| d.targets[i] = t;
    d.push(.{ .move_unit = .{ .unit = ui, .path = d.path[0..len], .target_cells = d.targets[0..fp.len] } });
}
