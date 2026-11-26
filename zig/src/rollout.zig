//! Native rollouts for the A19 search bridge: `SearchDriver.rollout` and `leafValue` (src/simulation/search_driver.ts)
//! on a copy of a loaded battle, with the policy of each seat injected as a decide function (`rollout.policies`: v0.1's
//! `ai.decideTurn` and the v0.8 port's `decideV08`; a mindless unit plays v0.1 whatever its seat). Also the plain "play
//! the battle out" helper the bridge and `hoc-sim play-state` share.
//!
//! One rollout: reseed the stream (`plain`: makeRng((seedBase + r * 0x9e3779b1) >>> 0); `antithetic`: the
//! actor-antithetic stream of search_chance_sampling.ts, one generator per "<lap>:<active id>" key and the exact
//! complement on odd r), make the actor active, apply the candidate's actions (an incumbent's rejected action is skipped
//! as the real loop does, an enumerated candidate's rejection is -Infinity, an incumbent that landed nothing is
//! -Infinity), defend when nothing landed, end the turn, then every unit plays its policy forward to the horizon (turns:
//! N unit turns; lap: until the lap flips, at most 64; reply: until the opponent has played once, at most 12; leaf:
//! none), and score the leaf as P(win) for the acting team (`material`, `v1` or `v2`, with `exactTerminal`). Summons
//! keep counting across the rollouts of one call (TypeScript restores neither runMatch's createSummonedUnit counter nor
//! lib.ts deterministicUuidSequence per rollout). A policy turn that lands nothing takes the recovery net
//! (advanceTowardEnemyAction, else defend), and a stalled queue forceStalledLap. Not ported (the call fails rather than
//! guess): the research logit adjustments and an opponent model. See zig/BRIDGE.md.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const ai = @import("ai.zig");
const rng_mod = @import("rng.zig");
const uuid = @import("uuid.zig");
const v08policy = @import("v08/policy.zig");
const v08util = @import("v08/util.zig");
const Rng = rng_mod.Rng;

const State = st.State;
const Team = st.Team;

/// A unit's policy: decides the active unit's turn into `out`; false when the policy needs a part of the port that is
/// missing (the call then fails with error.UnsupportedPolicy instead of guessing).
pub const DecideFn = *const fn (*State, u8, *ai.Decision) bool;

/// A play-out's decide function (ai.decideTurn's signature, as ai.playMatchWith takes it).
pub const PlayDecideFn = *const fn (*State, u8, *ai.Decision) void;

pub const Policy = struct { version: []const u8, decide: DecideFn };

fn decideV01(s: *State, ui: u8, out: *ai.Decision) bool {
    ai.decideTurn(s, ui, out);
    return true;
}

/// The policies a request may name: "v0.1" (StrategyV0_1) and "v0.8" (the A19 composite's combat decideTurn, native
/// StrategyV0_8 with production switches; it needs `Request.identity` and the army profile, see Tables).
pub const policies = [_]Policy{
    .{ .version = "v0.1", .decide = decideV01 },
    .{ .version = "v0.8", .decide = v08policy.decideV08 },
};

pub fn policyFor(version: []const u8) ?DecideFn {
    for (policies) |p| if (std.mem.eql(u8, p.version, version)) return p.decide;
    return null;
}

/// The boards the v0.8 port covers. Null when `s` is one, else what puts it outside. No batch-6a card or row and no spell
/// outside the list can appear inside a rollout from such a root (steals, Infest and summons only move or raise cards
/// already on the board), so checking the root covers every state of the call.
pub fn v08Scope(s: *const State, ident: *const Identity, buf: []u8) ?[]const u8 {
    _ = ident; // the src/v08 gap checks that named creatures are gone (common 6e6aff54, d5fddea9)
    // src/v08 covers the abilities of batches 1-5 (common 4f5152ba, 2346a159, 0809cc1d, dbbcb452), the wave-1 casts and
    // the batch-4 castables (bcf722a4, 66e72e9e), vines included. A board where a unit holds any other spell stays out of
    // scope.
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        for (u.book[0..u.n_book]) |e| {
            if (!v08Castable(e.spell)) return std.fmt.bufPrint(buf, "slot {d} holds spells", .{i}) catch "spells";
        }
        for (u.spells[0..u.n_spells]) |b| {
            if (!v08Castable(b.spell)) return std.fmt.bufPrint(buf, "slot {d} holds spells", .{i}) catch "spells";
        }
        // Batch 6a is not in src/v08 yet: its cards (stolen ones too), its rows (a Hamstrung flyer, Blindness,
        // Paralysis, Wind Flow and the blessings outlive their source) and a revive's orphan augment rows.
        if (u.ability_mask & st.AbilityId.BATCH6A_MASK != 0) return std.fmt.bufPrint(buf, "slot {d} holds a batch-6a ability", .{i}) catch "batch 6a";
        if (u.aug_orphans != 0) return std.fmt.bufPrint(buf, "slot {d} was revived", .{i}) catch "batch 6a";
        if (batch6aRow(u)) |id| return std.fmt.bufPrint(buf, "slot {d} carries {s}", .{ i, id.name() }) catch "batch 6a";
    }
    // Artifacts: the engine plays the stat artifacts (artifacts.zig), but src/v08 is not checked on them yet (lv8's
    // explicit-rate damage bound has no Warlord's Edge re-price), so a v0.8 seat stays out of scope with any row.
    if (s.artifacts) return "artifact rows (src/v08 not checked on artifacts)";
    // Smoke halves shots through it; src/v08 does not read the store yet.
    if (s.fight.n_smoke != 0) return "smoke clouds on the board";
    return null;
}

/// A batch-6a row on the unit (a debuff, an effect or a buff), if any.
fn batch6aRow(u: *const st.Unit) ?st.SpellId {
    for (u.debuffs.items[0..u.debuffs.len]) |d| if (d.id == .hamstrung or d.id == .war_anger_aura) return d.id;
    for (u.effects.items[0..u.effects.len]) |e| if (e.id == .blindness or e.id == .paralysis) return e.id;
    for (u.buffs.items[0..u.buffs.len]) |b| if (b.id.isBatch6Stat()) return b.id;
    return null;
}

/// The castables src/v08 decides: the wave-1 spells and the batch-4 castables. A whitelist: every other spell (wave 2,
/// whatever joins `st.CastSpell` later) keeps a board out of v0.8 rollouts until src/v08 decides it and joins this list.
const V08_CASTABLE = [_]st.CastSpell{
    .heal,          .blessing,   .lightning_strike, .fire_strike, .meteor_shower,     .meteorite,
    .summon_wolves, .vine_throw, .ring_of_fire,     .battle_roar, .wild_regeneration,
};

fn v08Castable(spell: u8) bool {
    for (V08_CASTABLE) |c| {
        if (@intFromEnum(c) == spell) return true;
    }
    return false;
}

/// MINDLESS_AI_VERSION: an "AI Driven" unit plays v0.1 whatever its seat (aiVersionForUnit).
pub const mindless_policy: DecideFn = decideV01;

/// isMindlessAiUnit: the unit has "AI Driven" active (Break-aware: a Broken one is steered by its owner again; a thief
/// that stole it is mindless, the robbed unit no longer). Read at every turn.
pub fn isMindless(s: *const State, ui: u8) bool {
    return s.units[ui].has(.ai_driven);
}

/// The decide function of unit `ui`: the mindless pin, else its team's policy.
pub fn unitPolicy(s: *const State, ui: u8, req: *const Request) ?DecideFn {
    if (isMindless(s, ui)) return mindless_policy;
    return req.policies[s.units[ui].team];
}

/// util.Battle.melee_magic for a team without v0.7's army profile: StrategyV0_7.finalizeDecision then keeps v0.6's
/// decision, which is the port's anchor-army path (melee_magic >= 2; the count is read nowhere else).
pub const NO_ARMY_PROFILE: u8 = 0xff;

pub const HorizonMode = enum { turns, lap, reply, leaf };

/// search_driver.ts MAX_LAP_HORIZON_TURNS / MAX_REPLY_HORIZON_TURNS.
pub const MAX_LAP_HORIZON_TURNS: u32 = 64;
pub const MAX_REPLY_HORIZON_TURNS: u32 = 12;

/// The rollout's chance stream: `plain` makeRng((seedBase + r * 0x9e3779b1) >>> 0); `antithetic` the SearchDriver's
/// complementary R2 stream, makeSearchChanceStream(seedBase, r, "actor-antithetic") (r 0..3, seedBase a uint32).
pub const Chance = enum { plain, antithetic };

/// leafValue's model: `material` (no learned leaf), `v1` (the 20-feature DEFAULT_V07_VALUE_WEIGHTS logistic leaf) or `v2`
/// (V08_A13_VALUE_LEAF over the 60 V2 features, production's); none with research logit adjustments.
pub const LeafKind = enum { material, v1, v2 };

/// Names behind the State's indices, for the v0.8 policy's creature and id tables, the actor-antithetic keys and the
/// sole-Abomination rule: unit ids by uid (a unit summoned inside a rollout, uid >= ids.len, is named by its UUID) and
/// creature names by Unit.name_id.
pub const Identity = struct {
    ids: []const []const u8,
    names: []const []const u8,

    /// The id string of the unit in slot `slot` (`buf` holds it when it is a rollout's summon).
    pub fn idOf(self: *const Identity, s: *const State, slot: usize, buf: *[36]u8) []const u8 {
        const u = &s.units[slot];
        if (u.uid < self.ids.len) return self.ids[u.uid];
        return uuid.format(&u.uuid, buf);
    }

    pub fn nameOf(self: *const Identity, u: *const st.Unit) []const u8 {
        return if (u.name_id < self.names.len) self.names[u.name_id] else "";
    }
};

pub const Candidate = struct {
    /// kind "incumbent": the real loop's semantics (rejected actions are skipped; nothing landed = -Infinity).
    incumbent: bool,
    actions: []const rec.Action,
};

pub const Request = struct {
    actor: u8,
    seed_base: f64,
    chance: Chance = .plain,
    horizon: HorizonMode = .turns,
    /// The unit-turn cap of the `turns` horizon (SearchDriver's turnHorizon).
    turns: u32 = 12,
    leaf: LeafKind = .material,
    /// leafValue's exact terminal result (SEARCH_A19_EXACT_TERMINAL_RESULTS): a finished fight scores 1, 0 or 0.5.
    exact_terminal: bool = false,
    /// The policy of each team (index Team.RIGHT / Team.LEFT).
    policies: [3]?DecideFn = .{ null, null, null },
    candidates: []const Candidate,
    /// (candidate index, rollout index r) in output order.
    pairs: []const [2]u32,
    /// Rollout turns this call may play (TypeScript's rolloutTurnLimit - rolloutTurnsTotal); null = unbounded. The call
    /// stops after the turn that exceeds it, dropping that rollout, as assertBeforeDecisionDeadline does.
    turn_budget: ?u64 = null,
    /// SearchDriver's sole-Abomination Armageddon defend rule (SEARCH_A19_SOLE_ABOMINATION_ARMAGEDDON_DEFEND_POLICY=1 in
    /// the A19 profile): the acting team's last stack, an Abomination facing a lone enemy Abomination it outlasts under
    /// Armageddon, defends instead of asking its policy. Needs `identity`.
    sole_abomination_defend: bool = false,
    /// A test hook for the recovery net (`testDropDecisions` k, 0 = off): a policy decision whose index n in its rollout
    /// (0, 1, ... over the policy calls, the sole-Abomination defend not counted) has Math.imul(n + 1, 0x85ebca6b) >>> 0
    /// divisible by k is computed and then replaced by nothing, so recoverNoopTurn plays that turn. A TypeScript oracle
    /// wraps the rollout policy's decideTurn the same way.
    drop_decisions: u32 = 0,
    /// Required by the v0.8 policy, the antithetic stream and the sole-Abomination rule.
    identity: ?*const Identity = null,
    /// v0.7's immutable army profile (StrategyV0_7.primeArmyProfile at placement): MELEE_MAGIC stacks per team at the
    /// fight's start, read by the v0.8 policy (util.Battle.melee_magic); NO_ARMY_PROFILE for a team whose rollout
    /// strategy has none.
    melee_magic: [3]u8 = .{ 0, 0, 0 },
    /// v0.7's isAuraSaturatedArmy per team from the same profile (util.Battle.aura_saturated): every starting stack
    /// emits an aura, so v0.7 plays its standalone v0.4 anchor. False for a team without a profile.
    aura_saturated: [3]bool = .{ false, false, false },
    /// The summon counters the first rollout starts from (runMatch's createSummonedUnit counter, lib.ts
    /// deterministicUuidSequence) and the summon id scheme; null = the root state's.
    summon_sequence: ?u32 = null,
    uuid_sequence: ?u64 = null,
    id_scheme: st.IdScheme = .match,
};

pub const Stop = enum(i32) { done = 0, deadline = 1, turn_budget = 2, out_full = 3 };

/// The budget of one call: an absolute CLOCK_MONOTONIC deadline (`nowNs`, 0 = none) and the turn allowance; after the
/// call, the turns played, the stop reason and the summon counters the next call continues from.
pub const Control = struct {
    deadline_ns: u64 = 0,
    turn_budget: ?u64 = null,
    /// Rollout turns played so far (aborted rollouts included, as TypeScript counts them).
    turns: u64 = 0,
    stop: Stop = .done,
    /// The counters after the last rollout played (aborted ones included: TypeScript does not restore them).
    summon_sequence: u32 = 0,
    uuid_sequence: u64 = 0,

    fn expired(self: *Control) bool {
        if (self.turn_budget) |b| {
            if (self.turns > b) {
                self.stop = .turn_budget;
                return true;
            }
        }
        if (self.deadline_ns != 0 and nowNs() >= self.deadline_ns) {
            self.stop = .deadline;
            return true;
        }
        return false;
    }
};

pub const Error = error{
    /// A unit without a registered policy had to play, or its policy reached a pass the port lacks.
    UnsupportedPolicy,
    /// A capacity of the port was exceeded (State.overflow: unit slots, ids, list lengths, a summon without its id
    /// parts or template, the antithetic stream's key table).
    UnsupportedCapacity,
};

/// CLOCK_MONOTONIC in nanoseconds (the clock of every deadline the bridge takes).
pub fn nowNs() u64 {
    const ts = std.posix.clock_gettime(std.posix.CLOCK.MONOTONIC) catch return 0;
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

/// JavaScript's `x >>> 0` (ToUint32).
pub fn toUint32(x: f64) u32 {
    if (!std.math.isFinite(x)) return 0;
    return @intFromFloat(@mod(@trunc(x), 4294967296.0));
}

/// The `plain` chance stream's seed: makeRng((seedBase + r * 0x9e3779b1) >>> 0).
pub fn plainSeed(seed_base: f64, r: u32) u32 {
    return toUint32(seed_base + @as(f64, @floatFromInt(r)) * 2654435761.0);
}

// =====================================================================================================================
// The actor-antithetic chance stream (src/simulation/search_chance_sampling.ts)
// =====================================================================================================================

/// Distinct "<lap>:<active id>" keys one rollout may draw under.
pub const MAX_CHANCE_KEYS = 1024;

/// makeSearchChanceStream(seed, r, "actor-antithetic", deps): every raw draw reads the current lap and the harness's
/// active unit (`State.fight.lap`, `State.active`; "" when none), draws from that key's own mulberry32 generator
/// (seeded `(base ^ hashSimulationParts("a19-actor-chance-v1", lap, id)) >>> 0`, created on first use, private to the
/// rollout), and on odd r returns the exact complement `1 - v - 2^-32` (the bitwise NOT of the uint32).
pub const ActorChance = struct {
    keyed: rng_mod.Keyed = undefined,
    s: *State = undefined,
    ident: *const Identity = undefined,
    base: u32 = 0,
    negate: bool = false,
    n: usize = 0,
    last_key: u64 = NO_KEY,
    last: usize = 0,
    keys: [MAX_CHANCE_KEYS]u64 = undefined,
    gens: [MAX_CHANCE_KEYS]u32 = undefined,

    const NO_KEY: u64 = std.math.maxInt(u64);
    const NO_UNIT: u64 = 0xffff;

    /// Installs the stream for rollout `r` on `s` (replacing its plain stream for every draw).
    pub fn begin(self: *ActorChance, s: *State, ident: *const Identity, seed: u32, r: u32) void {
        self.keyed = .{ .ctx = self, .next = next };
        self.s = s;
        self.ident = ident;
        self.base = plainSeed(@floatFromInt(seed), r / 2);
        self.negate = r % 2 == 1;
        self.n = 0;
        self.last_key = NO_KEY;
        s.rng.keyed = &self.keyed;
    }

    fn next(ctx: *anyopaque) u32 {
        const self: *ActorChance = @ptrCast(@alignCast(ctx));
        const s = self.s;
        const unit: u64 = if (s.active >= 0) s.units[@intCast(s.active)].uid else NO_UNIT;
        const key = (@as(u64, @as(u32, @bitCast(s.fight.lap))) << 16) | unit;
        if (key != self.last_key) self.select(key);
        const v = rng_mod.mulberry32(&self.gens[self.last]);
        return if (self.negate) ~v else v;
    }

    fn select(self: *ActorChance, key: u64) void {
        self.last_key = key;
        for (self.keys[0..self.n], 0..) |k, i| {
            if (k == key) {
                self.last = i;
                return;
            }
        }
        if (self.n >= MAX_CHANCE_KEYS) {
            self.s.overflow = true; // the rollout fails with UnsupportedCapacity
            self.last = 0;
            return;
        }
        var lap_buf: [12]u8 = undefined;
        const lap = std.fmt.bufPrint(&lap_buf, "{d}", .{self.s.fight.lap}) catch unreachable;
        var id_buf: [36]u8 = undefined;
        const id: []const u8 = if (self.s.active >= 0) self.ident.idOf(self.s, @intCast(self.s.active), &id_buf) else "";
        const hash = uuid.hashParts(&.{ "a19-actor-chance-v1", lap, id });
        self.keys[self.n] = key;
        self.gens[self.n] = self.base ^ hash;
        self.last = self.n;
        self.n += 1;
    }
};

// =====================================================================================================================
// The v0.8 policy's per-battle table (v08/util.zig Battle)
// =====================================================================================================================

/// util.battle for the state being rolled: each slot's creature and id rank and the army profile. Built once per call
/// from the root, restored at each rollout's start, and rebuilt after a summon (a new uid, possibly in a reused slot).
const Tables = struct {
    on: bool = false,
    ident: *const Identity = undefined,
    melee_magic: [3]u8 = .{ 0, 0, 0 },
    aura_saturated: [3]bool = .{ false, false, false },
    root: v08util.Battle = .{},
    root_uid: u8 = 0,
    built_uid: u8 = 0,

    fn init(self: *Tables, root: *const State, req: *const Request) void {
        self.on = false;
        for (req.policies) |p| {
            if (p == v08policy.decideV08) self.on = true;
        }
        if (!self.on) return;
        self.ident = req.identity.?;
        self.melee_magic = req.melee_magic;
        self.aura_saturated = req.aura_saturated;
        self.root = battleTable(root, self.ident, self.melee_magic, self.aura_saturated);
        self.root_uid = root.next_uid;
        self.built_uid = root.next_uid;
        v08util.battle = self.root;
    }

    fn reset(self: *Tables) void {
        if (!self.on or self.built_uid == self.root_uid) return;
        v08util.battle = self.root;
        self.built_uid = self.root_uid;
    }

    fn sync(self: *Tables, s: *const State) void {
        if (!self.on or s.next_uid == self.built_uid) return;
        v08util.battle = battleTable(s, self.ident, self.melee_magic, self.aura_saturated);
        self.built_uid = s.next_uid;
    }
};

/// util.Battle.fromUnits over the state's slots (each slot's creature name and unit id).
pub fn battleTable(s: *const State, ident: *const Identity, melee_magic: [3]u8, aura_saturated: [3]bool) v08util.Battle {
    var names: [st.MAX_UNITS][]const u8 = undefined;
    var ids: [st.MAX_UNITS][]const u8 = undefined;
    var bufs: [st.MAX_UNITS][36]u8 = undefined;
    const n = s.n_units;
    for (0..n) |i| {
        names[i] = ident.nameOf(&s.units[i]);
        ids[i] = ident.idOf(s, i, &bufs[i]);
    }
    var b = v08util.Battle.fromUnits(names[0..n], ids[0..n], melee_magic);
    b.aura_saturated = aura_saturated;
    return b;
}

// =====================================================================================================================
// One rollout
// =====================================================================================================================

/// A debugging observer of every rollout step on this thread (`hoc-sim rollout-trace`): each engine call after it ran
/// (`apply` / `advance`, units as slots) and each policy decision before its actions apply (`decide`).
pub const TraceKind = enum { apply, advance, decide };
pub const Trace = struct {
    ctx: *anyopaque,
    f: *const fn (ctx: *anyopaque, kind: TraceKind, s: *const State, a: rec.Action, ok: bool) void,
};
pub threadlocal var trace: ?Trace = null;

/// SearchDriver's finishedSim / finishedWinningTeam, fed by the events of every call.
const Sim = struct {
    finished: bool = false,
    winner: i32 = -1,
    events: engine.Events = .{},

    /// engine.apply (which also runs processEvents' active-unit bookkeeping), tracking fight_finished.
    fn apply(self: *Sim, s: *State, a: rec.Action) bool {
        self.events.len = 0;
        const ok = engine.apply(s, a, &self.events);
        for (self.events.slice()) |e| {
            if (e.kind == .fight_finished) {
                self.finished = true;
                self.winner = e.arg;
            }
        }
        if (trace) |t| t.f(t.ctx, if (a == .advance) .advance else .apply, s, a, ok);
        return ok;
    }
};

/// The per-call state of `run`: the v0.8 tables and the antithetic stream.
const Session = struct {
    tables: Tables = .{},
    chance: ActorChance = .{},
    /// The policy calls of this rollout (Request.drop_decisions).
    decisions: u32 = 0,
};

inline fn productive(a: rec.Action) bool {
    return a != .select_attack_type;
}

/// SearchDriver.simAdvance: advanceQueue, then when no unit is active and the fight is live, forceStalledLap (every
/// living unit marked as having made its turn) and advanceQueue again (the lap flips). With no living unit nothing is
/// marked and the rollout ends at the leaf.
fn simAdvance(s: *State, sim: *Sim) Error!void {
    advanceQueue(s, sim);
    if (!sim.finished and s.active < 0 and engine.forceStalledLap(s)) advanceQueue(s, sim);
}

/// SearchDriver.advanceQueue: at most holder + 2 advanceAfterNoActiveUnit calls until a unit is active, the fight ends,
/// or a call changes nothing.
fn advanceQueue(s: *State, sim: *Sim) void {
    const attempts = @as(usize, s.n_holder) + 2;
    var i: usize = 0;
    while (i < attempts and !sim.finished and s.active < 0) : (i += 1) {
        _ = sim.apply(s, .{ .advance = .{ .damage_dealt_this_lap = s.damage_lap == s.fight.lap } });
        if (sim.finished) return;
        if (s.active >= 0) return;
        if (sim.events.len == 0 and s.fight.up_next.len == 0) break;
    }
}

/// v08ArmageddonWaveDamage (v0_8_armageddon_endgame.ts): the raw damage one original stack takes from wave `wave`.
fn armageddonWaveDamage(u: *const st.Unit, wave: i32) f64 {
    if (wave <= 0 or wave > engine.NUMBER_OF_ARMAGEDDON_WAVES) return 0;
    const original = @max(0, u.amount_alive + u.amount_died);
    const max_hp = @max(0, u.max_hp);
    const waves: f64 = @floatFromInt(engine.NUMBER_OF_ARMAGEDDON_WAVES);
    const w: f64 = @floatFromInt(wave);
    if (wave == 1) return @max(engine.MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE, @floor(max_hp * original * w / waves));
    return @ceil(original * w / waves) * max_hp;
}

/// v08FirstUpcomingArmageddonWave
fn firstUpcomingWave(lap: i32) i32 {
    const applied = @max(0, lap - engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON + 1);
    return @max(1, applied + 1);
}

/// v08UpcomingArmageddonDamageThrough (no Water Shield in scope).
fn armageddonDamageThrough(u: *const st.Unit, lap: i32, through: i32) f64 {
    var damage: f64 = 0;
    var wave = firstUpcomingWave(lap);
    while (wave <= @min(engine.NUMBER_OF_ARMAGEDDON_WAVES, through)) : (wave += 1) damage += armageddonWaveDamage(u, wave);
    return damage;
}

/// isV08SoleAbominationArmageddonDefendOpportunity (search_driver.ts): the unit is its team's only living stack, an
/// Abomination facing one living enemy Abomination, and some upcoming wave leaves it alive and the enemy dead
/// (v08ArmageddonPreservationOpportunity, from lap NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 4).
pub fn soleAbominationOpportunity(s: *const State, ident: *const Identity, ui: u8) bool {
    const u = &s.units[ui];
    if (u.isDead() or !std.mem.eql(u8, ident.nameOf(u), "Abomination")) return false;
    var enemy: ?u8 = null;
    for (s.holderOrder()) |i| {
        const o = &s.units[i];
        if (o.isDead()) continue;
        if (o.team == u.team) {
            if (i != ui) return false;
        } else {
            if (enemy != null) return false;
            enemy = i;
        }
    }
    const e = &s.units[enemy orelse return false];
    if (!std.mem.eql(u8, ident.nameOf(e), "Abomination")) return false;
    const lap = s.fight.lap;
    if (lap < engine.NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 4) return false;
    var wave = firstUpcomingWave(lap);
    while (wave <= engine.NUMBER_OF_ARMAGEDDON_WAVES) : (wave += 1) {
        const survives = v08util.cumulativeHp(u) > armageddonDamageThrough(u, lap, wave);
        const doomed = v08util.cumulativeHp(e) <= armageddonDamageThrough(e, lap, wave);
        if (survives and doomed) return true;
    }
    return false;
}

/// SearchDriver.simPlayTurn: the unit's policy decides (or the sole-Abomination rule defends), its actions apply, then
/// the turn ends.
fn simPlayTurn(s: *State, ui: u8, req: *const Request, sim: *Sim, ses: *Session, enemy_team: u8) Error!void {
    var decision: ai.Decision = .{};
    if (req.sole_abomination_defend and s.units[ui].team != enemy_team and soleAbominationOpportunity(s, req.identity.?, ui)) {
        decision.push(.{ .defend_turn = .{ .unit = ui } });
    } else {
        const decide = unitPolicy(s, ui, req) orelse return error.UnsupportedPolicy;
        if (decide == v08policy.decideV08) ses.tables.sync(s);
        if (!decide(s, ui, &decision)) return error.UnsupportedPolicy;
        if (req.drop_decisions != 0) {
            ses.decisions += 1;
            if ((ses.decisions *% 0x85ebca6b) % req.drop_decisions == 0) decision.n = 0;
        }
    }
    if (trace) |t| t.f(t.ctx, .decide, s, .{ .decide = .{ .unit = ui, .out = decision.slice() } }, true);
    var did = false;
    for (decision.slice()) |a| {
        if (sim.finished) break;
        if (sim.apply(s, a) and productive(a)) did = true;
    }
    if (!sim.finished and s.active == ui and !did) recoverNoopTurn(s, ui, sim);
    if (!sim.finished and s.active == ui) {
        if (!sim.apply(s, .{ .end_turn = .{ .unit = ui, .reason = .manual } })) s.active = -1;
    }
}

/// SearchDriver.recoverNoopTurn, for every unit (the mindless one too: no retry here): advanceTowardEnemyAction when it
/// lands, else defend_turn.
fn recoverNoopTurn(s: *State, ui: u8, sim: *Sim) void {
    var decision: ai.Decision = .{};
    var advanced = false;
    if (ai.advanceTowardEnemy(s, ui, &decision) and !sim.finished and s.active == ui) advanced = sim.apply(s, decision.actions[0]);
    if (!advanced and !sim.finished and s.active == ui) _ = sim.apply(s, .{ .defend_turn = .{ .unit = ui } });
}

extern "c" fn exp(x: f64) f64;

/// DEFAULT_V07_VALUE_WEIGHTS (src/simulation/v0_7_value_weights.ts), the 20-feature LiveTwin leaf.
pub const LEAF_V1_B: f64 = 0.13187;
pub const LEAF_V1_W = [v08util.VALUE_FEATURES]f64{
    2.72071,  2.62258, 1.29138, 0.00841,  -0.43786, 0.40335, 0.22442, -0.05486, -0.03332, -1.62063,
    -0.93442, 0.6862,  0,       -0.28796, -0.22985, 0.18385, -0.0938, 0.12553,  0.02072,  0.02444,
};

/// leafValue: the exact terminal result when asked for, else the material leaf
/// 0.5 * (1 + (ours - enemy) / (ours + enemy + 1)) over the living units' cumulative HP, in holder order.
pub fn leafValue(s: *const State, team: u8, finished: bool, winner: i32, exact_terminal: bool) f64 {
    return leafValueOf(.material, s, team, finished, winner, exact_terminal);
}

/// The learned leaves on `s` (util.valueFeatures and valueFeaturesV2 walk the holder in insertion order, as
/// fillValueFeatures walks unitsHolder.getAllUnits()).
fn learnedLeaf(kind: LeafKind, s: *const State, team: u8) f64 {
    if (kind == .v2) return v08util.leafV2(s, team);
    var f: [v08util.VALUE_FEATURES]f64 = undefined;
    v08util.valueFeatures(s, team, &f);
    var z = LEAF_V1_B;
    for (0..v08util.VALUE_FEATURES) |i| z += LEAF_V1_W[i] * f[i];
    return 1 / (1 + exp(-z));
}

/// leafValue with the request's model: the exact terminal result when asked for, else `kind`'s P(win) for `team`
/// (the learned leaves' sigmoid takes Math.exp from the C library, as JavaScriptCore does).
pub fn leafValueOf(kind: LeafKind, s: *const State, team: u8, finished: bool, winner: i32, exact_terminal: bool) f64 {
    if (exact_terminal and finished and winner >= 0) {
        if (winner == Team.NO_TEAM) return 0.5;
        return if (winner == team) 1 else 0;
    }
    if (kind != .material) return learnedLeaf(kind, s, team);
    var ours: f64 = 0;
    var enemy: f64 = 0;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.isDead()) continue;
        const hp = @max(u.hp, 0);
        const cumulative = (u.amount_alive - 1) * u.max_hp + hp; // Unit.getCumulativeHp
        if (u.team == team) ours += cumulative else enemy += cumulative;
    }
    return 0.5 * (1 + (ours - enemy) / (ours + enemy + 1));
}

/// The v0.8 policy, the antithetic stream and the sole-Abomination rule read names through `Request.identity`.
fn requireIdentity(req: *const Request) Error!void {
    if (req.identity != null) return;
    for (req.policies) |p| {
        if (p == v08policy.decideV08) return error.UnsupportedPolicy;
    }
    if (req.chance == .antithetic or req.sole_abomination_defend) return error.UnsupportedPolicy;
}

/// One rollout on `s` (a copy of the root state). Returns the leaf value, -Infinity for a rejected candidate, or null
/// when the deadline or the turn budget cut it (`ctl.stop` says which).
pub fn rollout(s: *State, req: *const Request, cand: *const Candidate, r: u32, ctl: *Control) Error!?f64 {
    try requireIdentity(req);
    var ses: Session = .{};
    ses.tables.init(s, req);
    return rolloutIn(s, req, cand, r, ctl, &ses);
}

fn rolloutIn(s: *State, req: *const Request, cand: *const Candidate, r: u32, ctl: *Control, ses: *Session) Error!?f64 {
    if (ctl.expired()) return null;
    s.rng = Rng.init(plainSeed(req.seed_base, r));
    if (req.chance == .antithetic) ses.chance.begin(s, req.identity.?, toUint32(req.seed_base), r);
    ses.tables.reset();
    ses.decisions = 0;
    var sim: Sim = .{};
    const actor = req.actor;
    s.active = @intCast(actor);
    const acting = s.units[actor].team;
    const start_lap = s.fight.lap;

    // ply 0: the candidate itself
    var did = false;
    for (cand.actions) |a| {
        if (ctl.expired()) return null;
        if (sim.finished) break;
        const ok = sim.apply(s, a);
        if (ctl.expired()) return null;
        if (!ok and productive(a)) {
            if (!cand.incumbent) return -std.math.inf(f64);
            continue;
        }
        if (ok and productive(a)) did = true;
    }
    if (cand.incumbent and !did) return -std.math.inf(f64);
    if (!sim.finished and s.active == actor) {
        if (ctl.expired()) return null;
        if (!did) _ = sim.apply(s, .{ .defend_turn = .{ .unit = actor } });
        if (s.active == actor) {
            if (!sim.apply(s, .{ .end_turn = .{ .unit = actor, .reason = .manual } })) s.active = -1;
        }
    }

    // roll forward: every unit plays its policy
    const enemy_team = engine.opposite(acting);
    const cap: u32 = switch (req.horizon) {
        .leaf => 0,
        .lap => MAX_LAP_HORIZON_TURNS,
        .reply => MAX_REPLY_HORIZON_TURNS,
        .turns => req.turns,
    };
    var turns: u32 = 0;
    while (!sim.finished and turns < cap) {
        if (ctl.expired()) return null;
        if (req.horizon == .lap and s.fight.lap > start_lap) break;
        if (s.active < 0) {
            try simAdvance(s, &sim);
            if (sim.finished or s.active < 0) break;
        }
        const ui: u8 = @intCast(s.active);
        const u = &s.units[ui];
        if (!u.in_holder or u.isDead()) {
            s.active = -1;
            continue;
        }
        try simPlayTurn(s, ui, req, &sim, ses, enemy_team);
        turns += 1;
        ctl.turns += 1;
        if (req.horizon == .reply and s.units[ui].team == enemy_team) break;
    }
    if (ctl.expired()) return null;
    if (s.overflow) return error.UnsupportedCapacity;
    return leafValueOf(req.leaf, s, acting, sim.finished, sim.winner, req.exact_terminal);
}

/// Every (candidate, r) pair of the request in order, each on a fresh copy of `root` made in `scratch` (the summon
/// counters carry over from one rollout to the next); writes one value per pair into `out` and returns how many it
/// wrote (a prefix when the deadline, the turn budget or `out` stops it). `ctl` ends with the counters.
pub fn run(root: *const State, scratch: *State, req: *const Request, out: []f64, ctl: *Control) Error!usize {
    // Every rollout turn decides with a fresh DecisionPathCatalog (search_driver.ts simPlayTurn).
    const saved_catalog = ai.catalog_decisions;
    ai.catalog_decisions = true;
    defer ai.catalog_decisions = saved_catalog;
    try requireIdentity(req);
    var ses: Session = .{};
    ses.tables.init(root, req);
    var summon_seq = req.summon_sequence orelse root.summon_seq;
    var uuid_seq = req.uuid_sequence orelse root.uuid_seq;
    defer {
        ctl.summon_sequence = summon_seq;
        ctl.uuid_sequence = uuid_seq;
        scratch.rng.keyed = null;
    }
    var written: usize = 0;
    for (req.pairs) |p| {
        if (written >= out.len) {
            ctl.stop = .out_full;
            break;
        }
        scratch.* = root.*;
        scratch.summon_seq = summon_seq;
        scratch.uuid_seq = uuid_seq;
        scratch.id_scheme = req.id_scheme;
        const v = rolloutIn(scratch, req, &req.candidates[p[0]], p[1], ctl, &ses);
        summon_seq = scratch.summon_seq;
        uuid_seq = scratch.uuid_seq;
        out[written] = ((try v) orelse break);
        written += 1;
    }
    return written;
}

// =====================================================================================================================
// Playing a battle out
// =====================================================================================================================

/// The outcome of playing a loaded battle to its end (C layout: the bridge returns it as is).
pub const PlayResult = extern struct {
    /// ai.EndReason: 0 elimination, 1 turn cap, 2 stuck, 3 observer stop, 4 unsupported (recovery net).
    end: i32 = 0,
    /// The fight_finished event's team (0 = no team), -1 when the fight did not finish.
    winner: i32 = -1,
    lap: i32 = 0,
    /// Engine calls and decisions made.
    steps: u32 = 0,
    decisions: u32 = 0,
    /// The random stream's state at the end.
    rng: u32 = 0,
};

/// Called after every step of a play-out with the state (e.g. to learn the ids of the units summoned so far).
pub const StepHook = struct {
    ctx: *anyopaque,
    f: *const fn (ctx: *anyopaque, s: *const State) void,
};

const PlayObserver = struct {
    result: *PlayResult,
    hook: ?StepHook = null,

    fn step(ctx: *anyopaque, kind: ai.StepKind, action: rec.Action, r0: u32, s: *const State, ok: bool, events: []const rec.Event) bool {
        _ = action;
        _ = r0;
        _ = ok;
        const self: *PlayObserver = @ptrCast(@alignCast(ctx));
        if (kind == .decide) self.result.decisions += 1 else self.result.steps += 1;
        for (events) |e| {
            if (e.kind == .fight_finished) self.result.winner = e.arg;
        }
        if (self.hook) |h| h.f(h.ctx, s);
        return true;
    }
};

/// The ids of the units summoned in a play-out, by uid from `first` on (a summon joins the holder at the end of the
/// step that raised it): a StepHook for callers whose id table must name them (digests of the final state).
pub const SummonIds = struct {
    first: usize,
    ids: std.ArrayList([36]u8) = .empty,
    alloc: std.mem.Allocator,

    pub fn hook(self: *SummonIds) StepHook {
        return .{ .ctx = self, .f = capture };
    }

    fn capture(ctx: *anyopaque, s: *const State) void {
        const self: *SummonIds = @ptrCast(@alignCast(ctx));
        while (self.first + self.ids.items.len < s.next_uid) {
            const uid = self.first + self.ids.items.len;
            var text: [36]u8 = .{'?'} ** 36;
            for (s.holderOrder()) |i| {
                if (s.units[i].uid == uid) _ = @import("uuid.zig").format(&s.units[i].uuid, &text);
            }
            self.ids.append(self.alloc, text) catch return;
        }
    }

    /// `base` followed by the captured ids (slices into `self`), allocated from `arena`.
    pub fn table(self: *const SummonIds, arena: std.mem.Allocator, base: []const []const u8) ![]const []const u8 {
        const out = try arena.alloc([]const u8, base.len + self.ids.items.len);
        @memcpy(out[0..base.len], base);
        for (self.ids.items, 0..) |*t, i| out[base.len + i] = t;
        return out;
    }
};

/// Plays `s` out with `decide` on both seats: from the start (start_fight first) when the fight has not started, else
/// from where it stands (runMatchInner's loop: a decision boundary or no active unit).
pub fn play(s: *State, max_laps: i32, decide: PlayDecideFn) PlayResult {
    return playHooked(s, max_laps, decide, null);
}

/// play, calling `hook` after every step.
pub fn playHooked(s: *State, max_laps: i32, decide: PlayDecideFn, hook: ?StepHook) PlayResult {
    var result: PlayResult = .{};
    var obs = PlayObserver{ .result = &result, .hook = hook };
    const observer: ai.Observer = .{ .ctx = &obs, .step = PlayObserver.step };
    const end = if (s.fight.started) ai.continueMatchWith(s, max_laps, observer, decide) else ai.playMatchWith(s, max_laps, observer, decide);
    result.end = @intFromEnum(end);
    result.lap = s.fight.lap;
    result.rng = s.rng.state;
    return result;
}

test "plain chance seed is (seedBase + r * 0x9e3779b1) >>> 0" {
    // (123456789 + 3 * 0x9e3779b1) >>> 0 = 8086763072 mod 2^32
    try std.testing.expectEqual(@as(u32, @intCast((123456789 + 3 * 2654435761) % 4294967296)), plainSeed(123456789, 3));
    try std.testing.expectEqual(@as(u32, 4294967295), toUint32(-1));
    try std.testing.expectEqual(@as(u32, 5), toUint32(5.9));
}
