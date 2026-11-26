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

/// Per-battle facts the engine state does not carry (until Unit has a creature id): each unit's creature, and v0.7's
/// immutable initial-army profile per team (primeArmyProfile at placement: the stacks a team starts the fight with).
pub const Battle = struct {
    creature: [st.MAX_UNITS]Creature = .{.other} ** st.MAX_UNITS,
    /// MELEE_MAGIC stacks per team at the start; two or more make v0.7's meleeMagicAnchor army (no Resurrection or
    /// Wind Flow in scope), which keeps v0.6's decisions without the wait scorer.
    melee_magic: [3]u8 = .{ 0, 0, 0 },
    /// Each unit's place in its ids' localeCompare order (UUIDs: the same as byte order), for the TS id tie-breaks.
    id_rank: [st.MAX_UNITS]u16 = .{0} ** st.MAX_UNITS,
    /// v0.8's ranged positioning runs (V08_RANGED_POSITION_VERSIONS, default "v0.8": production). False for the
    /// v0.8s alias outside that scope, as the plain v0.8s recordings ran.
    ranged_positioning: bool = true,

    /// The profile from the fight's start state (every holder unit).
    pub fn primeProfile(self: *Battle, s: *const State) void {
        self.melee_magic = .{ 0, 0, 0 };
        for (s.units[0..s.n_units]) |*u| {
            if (u.in_holder and u.team < 3 and u.attack_type == AT.MELEE_MAGIC) self.melee_magic[u.team] += 1;
        }
    }

    /// From a recording's `init` (units in holder order, as engine.initState reads them).
    /// The table for a battle resumed mid-fight (the rollout bridge): each slot's creature name and unit id, and v0.7's
    /// per-team MELEE_MAGIC profile primed at the fight's start (the TS strategy keeps it from placement).
    pub fn fromUnits(names: []const []const u8, ids: []const []const u8, melee_magic: [3]u8) Battle {
        var b: Battle = .{ .melee_magic = melee_magic };
        for (names, 0..) |n, i| {
            if (i >= st.MAX_UNITS) break;
            b.creature[i] = Creature.fromName(n);
        }
        for (ids, 0..) |id, i| {
            if (i >= st.MAX_UNITS) break;
            var rank: u16 = 0;
            for (ids, 0..) |other, j| {
                if (j != i and std.mem.order(u8, other, id) == .lt) rank += 1;
            }
            b.id_rank[i] = rank;
        }
        return b;
    }

    pub fn fromInit(init: std.json.Value) Battle {
        var b: Battle = .{};
        const units = rec.get(init, "units").array.items;
        for (units, 0..) |u, i| {
            if (i >= st.MAX_UNITS) break;
            b.creature[i] = Creature.fromName(rec.get(u, "name").string);
        }
        for (units, 0..) |u, i| {
            if (i >= st.MAX_UNITS) break;
            const id = rec.get(u, "id");
            if (id != .string) continue;
            var rank: u16 = 0;
            for (units, 0..) |o, j| {
                if (j >= st.MAX_UNITS or j == i) continue;
                const other = rec.get(o, "id");
                if (other == .string and std.mem.order(u8, other.string, id.string) == .lt) rank += 1;
            }
            b.id_rank[i] = rank;
        }
        return b;
    }
};

/// The battle being decided (set by whoever runs the policy, before the first decision).
pub threadlocal var battle: Battle = .{};

pub inline fn idRank(ui: u8) u16 {
    return battle.id_rank[ui];
}

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
        .obstacle_attack => |*o| o.path = rebase(o.path, &src.path, &dst.path),
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

/// v0.5's COMBAT_ACTIONS and v0.8's posture-protected types: a strike or an obstacle attack (casts and Area Throw are
/// out of scope).
pub fn combatAction(d: *const ai.Decision) bool {
    return strikes(d) or has(d, .obstacle_attack);
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
    d.push(.{ .move_unit = .{ .unit = ui, .path = d.path[0..len], .target_cells = d.targets[0..fp.len], .has_lava = r.has_lava } });
}

// =====================================================================================================================
// Value features (src/simulation/value_features.ts fillValueFeatures) and the wait scorer's features
// (src/ai/versions/wait_scorer.ts extractWaitFeatures)
// =====================================================================================================================

pub inline fn hourglassed(s: *const State, ui: u8) bool {
    return s.fight.hourglass_set & engine.unitBit(ui) != 0;
}

inline fn chebyshev(a: Cell, b: Cell) f64 {
    return @floatFromInt(@max(@abs(a.x - b.x), @abs(a.y - b.y)));
}

inline fn normalizedDifference(a: f64, b: f64) f64 {
    return (a - b) / (a + b + 1);
}

fn nearestEnemyDistance(own: []const Cell, other: []const Cell, span: f64) f64 {
    if (own.len == 0 or other.len == 0) return 0;
    var sum: f64 = 0;
    for (own) |c| {
        var best = std.math.inf(f64);
        for (other) |e| {
            const d = chebyshev(c, e);
            if (d < best) best = d;
        }
        sum += best;
    }
    return sum / @as(f64, @floatFromInt(own.len)) / span;
}

fn averageSpread(cells: []const Cell, span: f64) f64 {
    if (cells.len < 2) return 0;
    var sum: f64 = 0;
    var pairs: f64 = 0;
    for (cells, 0..) |a, i| {
        for (cells[i + 1 ..]) |b| {
            sum += chebyshev(a, b);
            pairs += 1;
        }
    }
    return sum / pairs / span;
}

fn averageCenterDistance(cells: []const Cell, span: f64) f64 {
    if (cells.len == 0) return 0;
    const center = span / 2;
    var sum: f64 = 0;
    for (cells) |c| sum += @max(@abs(@as(f64, @floatFromInt(c.x)) - center), @abs(@as(f64, @floatFromInt(c.y)) - center));
    return sum / @as(f64, @floatFromInt(cells.len)) / center;
}

pub const VALUE_FEATURES = 20;

/// The 20 LiveTwin value features from `team`'s perspective; advancement reads x on a side-oriented board
/// (isSideAxisPolicyTeam, no legacy-axis seats in scope).
pub fn valueFeatures(s: *const State, team: u8, out: *[VALUE_FEATURES]f64) void {
    var our_hp: f64 = 0;
    var enemy_hp: f64 = 0;
    var our_cnt: f64 = 0;
    var enemy_cnt: f64 = 0;
    var our_atk: f64 = 0;
    var enemy_atk: f64 = 0;
    var our_ranged: f64 = 0;
    var enemy_ranged: f64 = 0;
    var our_wounded: f64 = 0;
    var enemy_wounded: f64 = 0;
    var our_adv: f64 = 0;
    var enemy_adv: f64 = 0;
    var our_yet: f64 = 0;
    var enemy_yet: f64 = 0;
    var our_cells: [st.MAX_UNITS]Cell = undefined;
    var n_our: usize = 0;
    var enemy_cells: [st.MAX_UNITS]Cell = undefined;
    var n_enemy: usize = 0;
    const span: f64 = st.GRID - 1;
    for (s.units[0..s.n_units], 0..) |*u, i| {
        if (!u.in_holder or u.isDead()) continue;
        const ui: u8 = @intCast(i);
        const hp = cumulativeHp(u);
        const atk = engine.getAttack(u) * u.amount_alive;
        const ranged: f64 = if (u.attack_type == AT.RANGE) 1 else 0;
        const died = u.amount_died;
        const alive = u.amount_alive;
        const wounded = if (died + alive > 0) died / (died + alive) else 0;
        const cell = engine.baseCell(u);
        const along: f64 = @floatFromInt(if (s.fight.side_oriented) cell.x else cell.y);
        const adv = if (u.team == st.Team.LEFT) along / span else (span - along) / span;
        const yet: f64 = if (!madeTurn(s, ui) and !hourglassed(s, ui)) 1 else 0;
        if (u.team == team) {
            our_hp += hp;
            our_cnt += 1;
            our_atk += atk;
            our_ranged += ranged;
            our_wounded += wounded;
            our_adv += adv;
            our_yet += yet;
            our_cells[n_our] = cell;
            n_our += 1;
        } else {
            enemy_hp += hp;
            enemy_cnt += 1;
            enemy_atk += atk;
            enemy_ranged += ranged;
            enemy_wounded += wounded;
            enemy_adv += adv;
            enemy_yet += yet;
            enemy_cells[n_enemy] = cell;
            n_enemy += 1;
        }
    }
    const total = our_cnt + enemy_cnt + 1;
    out[0] = normalizedDifference(our_hp, enemy_hp);
    out[1] = normalizedDifference(our_cnt, enemy_cnt);
    out[2] = normalizedDifference(our_atk, enemy_atk);
    out[3] = (our_ranged - enemy_ranged) / total;
    out[4] = if (our_cnt != 0) our_wounded / our_cnt else 0;
    out[5] = if (enemy_cnt != 0) enemy_wounded / enemy_cnt else 0;
    out[6] = if (our_cnt != 0) our_adv / our_cnt else 0;
    out[7] = if (enemy_cnt != 0) enemy_adv / enemy_cnt else 0;
    out[8] = @min(@as(f64, @floatFromInt(s.fight.lap)) / 10, 1);
    out[9] = (enemy_yet - our_yet) / total;
    out[10] = enemy_yet / total;
    out[11] = our_yet / total;
    out[12] = @as(f64, @floatFromInt(s.fight.hourglass_q.len)) / total;
    out[13] = @as(f64, @floatFromInt(s.fight.up_next.len)) / total;
    out[14] = nearestEnemyDistance(our_cells[0..n_our], enemy_cells[0..n_enemy], span);
    out[15] = nearestEnemyDistance(enemy_cells[0..n_enemy], our_cells[0..n_our], span);
    out[16] = averageSpread(our_cells[0..n_our], span);
    out[17] = averageSpread(enemy_cells[0..n_enemy], span);
    out[18] = averageCenterDistance(our_cells[0..n_our], span);
    out[19] = averageCenterDistance(enemy_cells[0..n_enemy], span);
}

pub const VALUE_FEATURES_V2 = 60;

/// fillValueFeaturesV2 (value_features.ts): the 20 base features, the class/composition block (ranged, flyer and
/// caster shares, ranged HP shares, remaining shots, ranged standoff), then the rangedness-interaction copy of all 30.
pub fn valueFeaturesV2(s: *const State, team: u8, out: *[VALUE_FEATURES_V2]f64) void {
    var base: [VALUE_FEATURES]f64 = undefined;
    valueFeatures(s, team, &base);
    @memcpy(out[0..VALUE_FEATURES], &base);
    var own_cnt: f64 = 0;
    var enemy_cnt: f64 = 0;
    var own_ranged: f64 = 0;
    var enemy_ranged: f64 = 0;
    var own_fly: f64 = 0;
    var enemy_fly: f64 = 0;
    var own_caster: f64 = 0;
    var enemy_caster: f64 = 0;
    var own_hp: f64 = 0;
    var enemy_hp: f64 = 0;
    var own_ranged_hp: f64 = 0;
    var enemy_ranged_hp: f64 = 0;
    var own_shots: f64 = 0;
    var enemy_shots: f64 = 0;
    for (s.units[0..s.n_units]) |*u| {
        if (!u.in_holder or u.isDead()) continue;
        const ranged = u.attack_type == AT.RANGE;
        const caster = u.attack_type == AT.MAGIC or u.attack_type == AT.MELEE_MAGIC;
        const hp = cumulativeHp(u);
        const shots = if (ranged) engine.getRangeShots(u) else 0;
        if (u.team == team) {
            own_cnt += 1;
            own_hp += hp;
            if (ranged) {
                own_ranged += 1;
                own_ranged_hp += hp;
                own_shots += shots;
            }
            if (engine.canFly(u)) own_fly += 1;
            if (caster) own_caster += 1;
        } else {
            enemy_cnt += 1;
            enemy_hp += hp;
            if (ranged) {
                enemy_ranged += 1;
                enemy_ranged_hp += hp;
                enemy_shots += shots;
            }
            if (engine.canFly(u)) enemy_fly += 1;
            if (caster) enemy_caster += 1;
        }
    }
    const own_ranged_frac = if (own_cnt != 0) own_ranged / own_cnt else 0;
    out[20] = own_ranged_frac;
    out[21] = if (enemy_cnt != 0) enemy_ranged / enemy_cnt else 0;
    out[22] = if (own_cnt != 0) own_fly / own_cnt else 0;
    out[23] = if (enemy_cnt != 0) enemy_fly / enemy_cnt else 0;
    out[24] = if (own_cnt != 0) own_caster / own_cnt else 0;
    out[25] = if (enemy_cnt != 0) enemy_caster / enemy_cnt else 0;
    out[26] = if (own_hp > 0) own_ranged_hp / own_hp else 0;
    out[27] = if (enemy_hp > 0) enemy_ranged_hp / enemy_hp else 0;
    out[28] = normalizedDifference(own_shots, enemy_shots);
    out[29] = own_ranged_frac * out[14];
    const rangedness = (out[20] + out[21]) / 2;
    for (0..30) |i| out[30 + i] = if (rangedness != 0) out[i] * rangedness else 0;
}

extern "c" fn exp(x: f64) f64;

/// SearchDriver.leafValue with the production V2 model (V08_A13_VALUE_LEAF) and no research logit adjustments:
/// P(win) for `team`. Math.exp is the C library's exp, as JavaScriptCore's is.
pub fn leafV2(s: *const State, team: u8) f64 {
    const W = @import("weights.zig");
    var f: [VALUE_FEATURES_V2]f64 = undefined;
    valueFeaturesV2(s, team, &f);
    var z = W.LEAF_V2_B;
    for (0..VALUE_FEATURES_V2) |i| z += W.LEAF_V2_W[i] * f[i];
    return 1 / (1 + exp(-z));
}

pub const WAIT_FEATURES = 41;

/// The v0.5 hourglass rule's counterfactual verdict (incumbentRuleWaits): a melee charge, a legal wait, fm >= 0.67.
fn incumbentRuleWaits(s: *const State, ui: u8, incumbent: []const rec.Action, fm: f64) bool {
    if (s.units[ui].attack_type == AT.RANGE) return false;
    var charge = false;
    for (incumbent) |a| {
        if (a == .melee_attack and a.melee_attack.path.len > 0) charge = true;
    }
    if (!charge or !canHourglass(s, ui)) return false;
    return fm >= 0.67;
}

/// extractWaitFeatures: the value features, then the tempo / hourglass block.
pub fn waitFeatures(s: *const State, ui: u8, incumbent: []const rec.Action, out: *[WAIT_FEATURES]f64) void {
    const u = &s.units[ui];
    valueFeatures(s, u.team, out[0..VALUE_FEATURES]);
    var own_alive: f64 = 0;
    var enemy_alive: f64 = 0;
    var own_yet: f64 = 0;
    var enemy_yet: f64 = 0;
    var own_init_sum: f64 = 0;
    var enemy_init_sum: f64 = 0;
    var own_init_max: f64 = 0;
    var enemy_init_max: f64 = 0;
    var enemies: f64 = 0;
    var enemies_yet: f64 = 0;
    for (s.units[0..s.n_units], 0..) |*o, i| {
        if (!o.in_holder or o.isDead()) continue;
        const oi: u8 = @intCast(i);
        const own = o.team == u.team;
        if (!own) {
            enemies += 1;
            if (!madeTurn(s, oi)) enemies_yet += 1;
        }
        if (own) own_alive += 1 else enemy_alive += 1;
        if (madeTurn(s, oi) or hourglassed(s, oi)) continue;
        if (own) {
            own_yet += 1;
            own_init_sum += o.initiative;
            own_init_max = @max(own_init_max, o.initiative);
        } else {
            enemy_yet += 1;
            enemy_init_sum += o.initiative;
            enemy_init_max = @max(enemy_init_max, o.initiative);
        }
    }
    const clampCnt = struct {
        fn f(n: f64) f64 {
            return @min(n / 8, 1);
        }
    }.f;
    const lap: f64 = @floatFromInt(s.fight.lap);
    const till_i: i32 = @max(1, s.fight.laps_till_narrowing);
    const till: f64 = @floatFromInt(till_i);
    const narrowed: f64 = @floatFromInt(@divFloor(s.fight.lap - 1, till_i) + s.fight.additional_narrowing_laps);
    const at = u.attack_type;
    const fm = if (enemies != 0) enemies_yet / enemies else 0;
    const enemy_yet_frac = if (enemy_alive != 0) enemy_yet / enemy_alive else 0;
    const lap_capped = @min(lap, 8) / 8;
    const is_melee: f64 = if (at == AT.MELEE or at == AT.MELEE_MAGIC) 1 else 0;
    const is_ranged: f64 = if (at == AT.RANGE) 1 else 0;
    const made: f64 = @floatFromInt(s.fight.madeCount());
    var f = out[VALUE_FEATURES..];
    f[0] = fm;
    f[1] = clampCnt(own_yet);
    f[2] = clampCnt(enemy_yet);
    f[3] = if (own_alive != 0) own_yet / own_alive else 0;
    f[4] = enemy_yet_frac;
    f[5] = if (own_alive + enemy_alive > 0) made / (own_alive + enemy_alive) else 0;
    f[6] = lap_capped;
    f[7] = normalizedDifference(own_init_max, enemy_init_max);
    f[8] = normalizedDifference(if (own_yet != 0) own_init_sum / own_yet else 0, if (enemy_yet != 0) enemy_init_sum / enemy_yet else 0);
    f[9] = is_melee;
    f[10] = is_ranged;
    f[11] = if (at == AT.MAGIC or at == AT.MELEE_MAGIC) 1 else 0;
    f[12] = if (engine.canFly(u)) 1 else 0;
    f[13] = clampCnt(own_alive);
    f[14] = clampCnt(enemy_alive);
    f[15] = @min(narrowed / till, 1);
    f[16] = @as(f64, @floatFromInt(@mod(s.fight.lap - 1, till_i))) / till;
    f[17] = if (incumbentRuleWaits(s, ui, incumbent, fm)) 1 else 0;
    f[18] = fm * lap_capped;
    f[19] = enemy_yet_frac * is_melee;
    f[20] = enemy_yet_frac * is_ranged;
}
