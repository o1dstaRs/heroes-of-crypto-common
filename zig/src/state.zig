//! Battle state as plain fixed-size data: copying a `State` is the whole snapshot/restore, so a rollout
//! costs one memcpy instead of the TypeScript engine's object-graph snapshot.
//!
//! Numbers the TypeScript engine keeps as JS numbers are f64 here, so every rounding step matches.

const std = @import("std");
const Rng = @import("rng.zig").Rng;

pub const MAX_UNITS = 32;
pub const GRID = 16;
pub const MAX_SPELLS = 8;

pub const Team = struct {
    pub const NO_TEAM: u8 = 0;
    pub const RIGHT: u8 = 1;
    pub const LEFT: u8 = 2;
};

pub const AttackType = struct {
    pub const NO_ATTACK: u8 = 0;
    pub const MELEE: u8 = 1;
    pub const RANGE: u8 = 2;
    pub const MAGIC: u8 = 3;
    pub const MELEE_MAGIC: u8 = 4;
};

pub const Movement = struct {
    pub const WALK: u8 = 1;
    pub const FLY: u8 = 2;
};

pub const Cell = @import("recording.zig").Cell;

/// System spells the scoped battles can carry as buffs/debuffs. The string table is only for digests.
pub const SpellId = enum(u8) {
    morale,
    dismorale,
    luck_shield,

    pub fn name(self: SpellId) []const u8 {
        return switch (self) {
            .morale => "Morale",
            .dismorale => "Dismorale",
            .luck_shield => "Luck Shield",
        };
    }
};

pub const AppliedSpell = struct {
    id: SpellId,
    laps: f64,
    power: f64 = 0,
};

pub const SpellList = struct {
    items: [MAX_SPELLS]AppliedSpell = undefined,
    len: u8 = 0,

    pub fn find(self: *const SpellList, id: SpellId) ?usize {
        for (self.items[0..self.len], 0..) |s, i| if (s.id == id) return i;
        return null;
    }
    pub fn removeAt(self: *SpellList, i: usize) void {
        var j = i;
        while (j + 1 < self.len) : (j += 1) self.items[j] = self.items[j + 1];
        self.len -= 1;
    }
    pub fn push(self: *SpellList, s: AppliedSpell) void {
        self.items[self.len] = s;
        self.len += 1;
    }
};

/// `initialUnitProperties`: the base values every stat refresh recomputes from. Only `morale` changes in scope.
pub const BaseStats = struct {
    max_hp: f64,
    luck: f64,
    morale: f64,
    base_armor: f64,
    armor_mod: f64,
    base_attack: f64,
    attack_mod: f64,
    attack_damage_min: f64,
    attack_damage_max: f64,
    steps: f64,
    initiative: f64,
    magic_resist: f64,
    shot_distance: f64,
};

pub const Unit = struct {
    in_holder: bool,
    team: u8,
    faction: u8,
    level: u8,
    size: u8,
    fw: u8,
    fh: u8,
    attack_type: u8,
    attack_type_selected: u8,
    movement_type: u8,

    base: Cell,
    pos_x: f64,
    pos_y: f64,
    cells: [4]Cell,
    n_cells: u8,

    max_hp: f64,
    hp: f64,
    steps: f64,
    steps_mod: f64,
    morale: f64,
    luck: f64,
    initiative: f64,
    armor_mod: f64,
    base_armor: f64,
    range_armor: f64,
    base_attack: f64,
    attack_mod: f64,
    attack_damage_min: f64,
    attack_damage_max: f64,
    attack_range: f64,
    range_shots: f64,
    range_shots_mod: f64,
    shot_distance: f64,
    magic_resist: f64,
    magic_resist_mod: f64,
    exp: f64,
    amount_alive: f64,
    amount_died: f64,
    luck_mod: f64,
    attack_multiplier: f64,
    stack_power: f64,

    responded: bool,
    on_hourglass: bool,
    moved_this_turn: bool,

    buffs: SpellList,
    debuffs: SpellList,
    effects: SpellList,

    init: BaseStats,
    luck_per_turn: f64,
    /// Bit L set = lap L already re-rolled luck (`adjustedBaseStatsLaps`).
    adjusted_laps: u128,
    /// UnitsHolder.distancesToClosestEnemies entry for this unit.
    dist_known: bool,
    dist_closest_enemy: f64,
    name_id: u16,
    /// possibleAttackTypes, in order.
    possible: [4]u8,
    n_possible: u8,
    /// Grid registration (`cellsByUnitId`), in the order the caller supplied it.
    reg: [4]Cell,
    n_reg: u8,

    pub fn isDead(self: *const Unit) bool {
        return self.amount_alive <= 0;
    }
};

/// A small FIFO of unit indices with Denque's order (front = next out).
pub const Queue = struct {
    items: [MAX_UNITS]u8 = undefined,
    len: u8 = 0,

    pub fn push(self: *Queue, u: u8) void {
        self.items[self.len] = u;
        self.len += 1;
    }
    pub fn shift(self: *Queue) ?u8 {
        if (self.len == 0) return null;
        const u = self.items[0];
        var i: usize = 1;
        while (i < self.len) : (i += 1) self.items[i - 1] = self.items[i];
        self.len -= 1;
        return u;
    }
    pub fn includes(self: *const Queue, u: u8) bool {
        for (self.items[0..self.len]) |x| if (x == u) return true;
        return false;
    }
    pub fn removeOnce(self: *Queue, u: u8) bool {
        for (self.items[0..self.len], 0..) |x, i| {
            if (x == u) {
                var j = i;
                while (j + 1 < self.len) : (j += 1) self.items[j] = self.items[j + 1];
                self.len -= 1;
                return true;
            }
        }
        return false;
    }
    pub fn slice(self: *const Queue) []const u8 {
        return self.items[0..self.len];
    }
};

pub const UnitSet = u32;

pub const Fight = struct {
    lap: i32 = 1,
    started: bool = false,
    finished: bool = false,
    first_turn_made: bool = false,
    previous_turn_team: u8 = 0,
    highest_initiative: f64 = 0,
    steps_morale_multiplier: f64 = 0,
    additional_narrowing_laps: i32 = 0,
    laps_till_narrowing: i32 = 3,
    grid_type: u8 = 1,

    up_next: Queue = .{},
    hourglass_q: Queue = .{},
    morale_plus_q: Queue = .{},
    morale_minus_q: Queue = .{},

    made: UnitSet = 0,
    hourglass_set: UnitSet = 0,
    replied: UnitSet = 0,
    /// Bit L set = damage was dealt in lap L.
    damage_laps: u128 = 0,
    team_units_alive: [3]i32 = .{ 0, 0, 0 },
};

pub const EMPTY: u8 = 0;
pub const HOLE: u8 = 0xff;

pub const Grid = struct {
    /// boardCoord[x][y]: EMPTY, HOLE, or unit index + 1.
    board: [GRID][GRID]u8,
    /// boardAggrPerTeam[team][x][y], baseline 1, +1 per ring stamp of that team's units.
    aggr: [3][GRID][GRID]i16,
};

pub const State = struct {
    units: [MAX_UNITS]Unit,
    n_units: u8,
    grid: Grid,
    fight: Fight,
    rng: Rng,
    /// The harness's currentActiveUnitId (-1 = none), fed by the step's events.
    active: i8,
    /// AI target memory (ai.ts previousTargetsByBattle): attacker -> remembered target, -1 = none.
    ai_prev_target: [MAX_UNITS]i8,
    /// Lap of the latest damage-statistic entry (a landed hit or response); feeds damageDealtThisLap.
    damage_lap: i32,
};
