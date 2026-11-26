//! LAVA_CENTER and BLOCK_CENTER terrain on the grid (src/grid/grid.ts, the hit counters in
//! src/fights/fight_properties.ts): the lava square and its drying, the classic 2x2 mountains with their hit
//! counters, and the scattered stones. None of it draws from the random stream.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");

const Cell = st.Cell;
const State = st.State;
const GT = st.GridType;

/// HITS_PER_MOUNTAIN (src/constants.ts)
pub const HITS_PER_MOUNTAIN: i32 = 3;

inline fn mark(s: *State, x: i32, y: i32, v: u8) void {
    s.grid.board[@intCast(x)][@intCast(y)] = v;
}

inline fn at(s: *const State, x: i32, y: i32) u8 {
    return s.grid.board[@intCast(x)][@intCast(y)];
}

/// The classic mountains (isCenterObstacleCell's BLOCK branch): left x 5..6 and right x 9..10, y 7..8.
pub const CLASSIC_LEFT_X = [2]i32{ 5, 6 };
pub const CLASSIC_RIGHT_X = [2]i32{ 9, 10 };
pub const CLASSIC_Y = [2]i32{ 7, 8 };

/// Grid.isScatteredMountainCell: membership of the LAYOUT (a destroyed stone still counts).
pub fn isScatteredMountainCell(s: *const State, c: Cell) bool {
    const t = &s.grid.terrain;
    for (t.layout[0..t.n_layout]) |l| if (l.x == c.x and l.y == c.y) return true;
    return false;
}

/// Grid.hasScatteredMountains: a layout, or artifact barrels placed (artifactBarrelLayoutActive) on any map.
pub inline fn hasScatteredMountains(s: *const State) bool {
    return s.grid.terrain.n_layout > 0 or s.grid.terrain.layout_active;
}

/// Grid.hasClassicMountains
pub inline fn hasClassicMountains(s: *const State) bool {
    const t = &s.grid.terrain;
    return s.fight.grid_type == GT.BLOCK_CENTER and (!t.left_cleared or !t.right_cleared);
}

/// getScatteredMountainsStanding().length
pub inline fn standingCount(s: *const State) u32 {
    return @popCount(s.grid.terrain.standing);
}

/// FightProperties.getObstacleHitsLeft
pub inline fn hitsLeft(s: *const State) i32 {
    return s.fight.hits_left + s.fight.hits_right;
}

/// Grid.clearScatteredMountainAt: knocks out a standing stone; false when nothing stood there.
pub fn clearScatteredMountainAt(s: *State, c: Cell) bool {
    const t = &s.grid.terrain;
    for (t.layout[0..t.n_layout], 0..) |l, i| {
        if (l.x != c.x or l.y != c.y) continue;
        const bit = @as(u16, 1) << @intCast(i);
        if (t.standing & bit == 0) return false;
        t.standing &= ~bit;
        if (at(s, c.x, c.y) == st.BLOCK) mark(s, c.x, c.y, st.EMPTY);
        // A barrel's record goes with its stone (grid.ts clearScatteredMountainAt).
        var k: usize = 0;
        while (k < t.n_barrels) : (k += 1) {
            if (t.barrels[k].slot != i) continue;
            std.mem.copyForwards(st.Barrel, t.barrels[k .. t.n_barrels - 1], t.barrels[k + 1 .. t.n_barrels]);
            t.n_barrels -= 1;
            break;
        }
        return true;
    }
    return false;
}

/// Grid.clearMountainSide (classic): idempotent; false when that side is already gone.
pub fn clearMountainSide(s: *State, is_right: bool) bool {
    if (s.fight.grid_type != GT.BLOCK_CENTER) return false;
    const t = &s.grid.terrain;
    if (if (is_right) t.right_cleared else t.left_cleared) return false;
    if (is_right) t.right_cleared = true else t.left_cleared = true;
    for (if (is_right) CLASSIC_RIGHT_X else CLASSIC_LEFT_X) |x| {
        for (CLASSIC_Y) |y| mark(s, x, y, st.EMPTY);
    }
    return true;
}

/// FightProperties.encounterObstacleHit (classic): one hit off that side, and a damage fact for the lap.
pub fn encounterObstacleHit(s: *State, is_right: bool) void {
    const f = &s.fight;
    const side = if (is_right) &f.hits_right else &f.hits_left;
    if (side.* > 0 and f.lap >= 0 and f.lap < 128) f.damage_laps |= @as(u128, 1) << @intCast(f.lap);
    side.* = @max(0, side.* - 1);
}

/// AttackHandler.spendObstacleHit: a stone dies outright; a classic mountain spends from its side's counter.
pub fn spendObstacleHit(s: *State, c: Cell, is_right: bool) void {
    if (isScatteredMountainCell(s, c)) {
        _ = clearScatteredMountainAt(s, c);
        return;
    }
    encounterObstacleHit(s, is_right);
}

/// AttackHandler.obstacleStillStands
pub fn obstacleStillStands(s: *const State) bool {
    if (hasScatteredMountains(s) and !hasClassicMountains(s)) return standingCount(s) > 0;
    return hitsLeft(s) > 0;
}

pub const CenterCells = struct {
    items: [st.MAX_STONES + 8]Cell = undefined,
    len: u8 = 0,

    fn push(self: *CenterCells, c: Cell) void {
        self.items[self.len] = c;
        self.len += 1;
    }
    pub fn slice(self: *const CenterCells) []const Cell {
        return self.items[0..self.len];
    }
};

/// Grid.getCenterCells on BLOCK_CENTER (excludeInner has no effect there): the standing stones in layout order, then
/// each uncleared classic side, x outer. Off BLOCK_CENTER: the standing layout when barrels made one
/// (hasScatteredMountains), else nothing (the obstacle strike, the only caller, is refused first).
pub fn centerCells(s: *const State, out: *CenterCells) void {
    out.* = .{};
    const t = &s.grid.terrain;
    if (s.fight.grid_type != GT.BLOCK_CENTER) {
        if (!hasScatteredMountains(s)) return;
        for (t.layout[0..t.n_layout], 0..) |l, i| {
            if (t.standing & (@as(u16, 1) << @intCast(i)) != 0) out.push(l);
        }
        return;
    }
    for (t.layout[0..t.n_layout], 0..) |l, i| {
        if (t.standing & (@as(u16, 1) << @intCast(i)) != 0) out.push(l);
    }
    if (!t.left_cleared) {
        for (CLASSIC_LEFT_X) |x| for (CLASSIC_Y) |y| out.push(.{ .x = x, .y = y });
    }
    if (!t.right_cleared) {
        for (CLASSIC_RIGHT_X) |x| for (CLASSIC_Y) |y| out.push(.{ .x = x, .y = y });
    }
}

/// Grid.cleanupCenterObstacle for LAVA_CENTER (TurnEngine calls it only for meltable maps): the square becomes
/// ground for the rest of the game. Idempotent.
pub fn cleanupCenterObstacle(s: *State) void {
    const t = &s.grid.terrain;
    if (t.cleaned_up_center or s.fight.grid_type != GT.LAVA_CENTER) return;
    var x: i32 = 6;
    while (x < 10) : (x += 1) {
        var y: i32 = 6;
        while (y < 10) : (y += 1) {
            if (at(s, x, y) == st.LAVA) mark(s, x, y, st.EMPTY);
        }
    }
    t.cleaned_up_center = true;
}

/// FightProperties.getLapsNarrowed
pub inline fn lapsNarrowed(f: *const st.Fight) i32 {
    return @divFloor(f.lap - 1, f.laps_till_narrowing) + f.additional_narrowing_laps;
}

fn cellOf(v: std.json.Value) Cell {
    const a = v.array.items;
    return .{ .x = @intCast(rec.int(a[0])), .y = @intCast(rec.int(a[1])) };
}

/// The recorded `init.terrain` (absent in classic NORMAL recordings): the scattered layout in roll order, the stones
/// standing, the hit counters, the cleared classic sides, the dried centre and the board orientation; then stamps the
/// terrain markers on an empty board (before the units are registered: no unit ever stands on terrain). A recording
/// without terrain fields gets the defaults setGridType and the Grid constructor give its grid type.
pub fn load(init: std.json.Value, s: *State) !void {
    const t = &s.grid.terrain;
    t.* = .{};
    const gt = s.fight.grid_type;
    if (gt != GT.NORMAL and gt != GT.LAVA_CENTER and gt != GT.BLOCK_CENTER) return error.UnsupportedGridType;
    s.fight.side_oriented = false;
    s.fight.hits_left = if (gt == GT.BLOCK_CENTER) HITS_PER_MOUNTAIN else 0;
    s.fight.hits_right = s.fight.hits_left;
    const tv = rec.get(init, "terrain");
    if (tv == .object) {
        s.fight.side_oriented = rec.int(rec.get(tv, "sideOriented")) == 1;
        s.fight.hits_left = @intCast(rec.int(rec.get(tv, "hitsL")));
        s.fight.hits_right = @intCast(rec.int(rec.get(tv, "hitsR")));
        t.left_cleared = rec.int(rec.get(tv, "leftCleared")) == 1;
        t.right_cleared = rec.int(rec.get(tv, "rightCleared")) == 1;
        t.cleaned_up_center = rec.int(rec.get(tv, "cleanedUpCenter")) == 1;
        const layout = rec.get(tv, "layout").array.items;
        if (layout.len > st.MAX_STONES) return error.TooManyStones;
        for (layout, 0..) |c, i| t.layout[i] = cellOf(c);
        t.n_layout = @intCast(layout.len);
        for (rec.get(tv, "standing").array.items) |c| {
            const cell = cellOf(c);
            var found = false;
            for (t.layout[0..t.n_layout], 0..) |l, i| {
                if (l.x == cell.x and l.y == cell.y) {
                    t.standing |= @as(u16, 1) << @intCast(i);
                    found = true;
                }
            }
            if (!found) return error.StoneOutsideLayout;
        }
    } else if (gt != GT.NORMAL) {
        return error.MissingTerrain;
    }
    if (gt == GT.LAVA_CENTER and !t.cleaned_up_center) {
        var x: i32 = 6;
        while (x < 10) : (x += 1) {
            var y: i32 = 6;
            while (y < 10) : (y += 1) mark(s, x, y, st.LAVA);
        }
    }
    if (gt == GT.BLOCK_CENTER) {
        if (!t.left_cleared) for (CLASSIC_LEFT_X) |x| for (CLASSIC_Y) |y| mark(s, x, y, st.BLOCK);
        if (!t.right_cleared) for (CLASSIC_RIGHT_X) |x| for (CLASSIC_Y) |y| mark(s, x, y, st.BLOCK);
    }
    // Standing layout cells are stones on every map (artifact barrels stand on NORMAL and LAVA_CENTER too).
    for (t.layout[0..t.n_layout], 0..) |l, i| {
        if (t.standing & (@as(u16, 1) << @intCast(i)) != 0) mark(s, l.x, l.y, st.BLOCK);
    }
}

/// Grid.placeArtifactBarrel: the team's barrel `index` becomes a standing layout stone at `cell` (appended after the
/// seeded stones), "B" on the board, recorded in Map order.
pub fn addBarrel(s: *State, team: u8, index: u8, cell: Cell) void {
    const t = &s.grid.terrain;
    if (t.n_layout >= st.MAX_STONES or t.n_barrels >= t.barrels.len) {
        s.overflow = true;
        return;
    }
    const slot = t.n_layout;
    t.layout[slot] = cell;
    t.n_layout += 1;
    t.standing |= @as(u16, 1) << @intCast(slot);
    mark(s, cell.x, cell.y, st.BLOCK);
    t.barrels[t.n_barrels] = .{ .team = team, .index = index, .slot = slot };
    t.n_barrels += 1;
    t.layout_active = true;
}

/// The recorded digest's `fight.terrain`, when present.
pub fn matches(s: *const State, tv: std.json.Value, why: *[]const u8) bool {
    const t = &s.grid.terrain;
    const scalars = [_]struct { []const u8, i64 }{
        .{ "hitsL", s.fight.hits_left },
        .{ "hitsR", s.fight.hits_right },
        .{ "leftCleared", @intFromBool(t.left_cleared) },
        .{ "rightCleared", @intFromBool(t.right_cleared) },
        .{ "cleanedUpCenter", @intFromBool(t.cleaned_up_center) },
    };
    for (scalars) |sc| {
        if (rec.int(rec.get(tv, sc[0])) != sc[1]) {
            why.* = sc[0];
            return false;
        }
    }
    const standing = rec.get(tv, "standing").array.items;
    var k: usize = 0;
    for (t.layout[0..t.n_layout], 0..) |l, i| {
        if (t.standing & (@as(u16, 1) << @intCast(i)) == 0) continue;
        if (k >= standing.len) {
            why.* = "standing (zig has more stones)";
            return false;
        }
        const c = cellOf(standing[k]);
        if (c.x != l.x or c.y != l.y) {
            why.* = "standing (order or cell)";
            return false;
        }
        k += 1;
    }
    if (k != standing.len) {
        why.* = "standing (ts has more stones)";
        return false;
    }
    return true;
}
