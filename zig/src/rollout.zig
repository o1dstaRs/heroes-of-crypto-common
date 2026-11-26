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
//! keep counting across the rollouts of one call (SearchDriver.rollout called directly restores neither runMatch's
//! createSummonedUnit counter nor lib.ts deterministicUuidSequence per rollout); `Request.bank` gives a call
//! scoreCandidates' bank semantics instead (ABI 3: the -Infinity break, runMatch's per-rollout summon restore, the A19
//! material sample, the offline hopeless-tail bound) and `runRecords` reports every pair (`PairRecord`). A policy turn
//! that lands nothing takes the recovery net (advanceTowardEnemyAction, else defend), and a stalled queue
//! forceStalledLap. Not ported (the call fails rather than guess): the research logit adjustments and an opponent model.
//! See zig/BRIDGE.md.

const std = @import("std");
const rec = @import("recording.zig");
const st = @import("state.zig");
const engine = @import("engine.zig");
const server = @import("server.zig");
const ai = @import("ai.zig");
const rng_mod = @import("rng.zig");
const uuid = @import("uuid.zig");
const v08policy = @import("v08/policy.zig");
const v08util = @import("v08/util.zig");
const scope = @import("scope.zig");
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

/// The boards the v0.8 port covers. Null when `s` is one, else what puts it outside. No spell outside the list and no
/// refused card can appear inside a rollout from such a root (steals, Infest and summons only move or raise cards
/// already on the board), so checking the root covers every state of the call.
pub fn v08Scope(s: *const State, ident: *const Identity, buf: []u8) ?[]const u8 {
    _ = ident; // the src/v08 gap checks that named creatures are gone (common 6e6aff54, d5fddea9)
    // src/v08 covers batches 1-5 and 6a, revived units, the artifacts, smoke, the Nightmare (Fire Wall, burning cells,
    // Time Denial) and every cast (V08_CASTABLE). A board where a unit holds any other spell stays out of scope.
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        for (u.book[0..u.n_book]) |e| {
            if (!v08Castable(e.spell)) return std.fmt.bufPrint(buf, "slot {d} holds spells", .{i}) catch "spells";
        }
        for (u.spells[0..u.n_spells]) |b| {
            if (!v08Castable(b.spell)) return std.fmt.bufPrint(buf, "slot {d} holds spells", .{i}) catch "spells";
        }
        // The cards and rows V08_SCOPE's tables refuse (stolen cards too: batch 6b is not in src/v08 yet, and a Water
        // Shield or Flesh Shield row outlives its source) and a revive's orphan augment rows.
        if (u.ability_mask & V08_SCOPE.refused_abilities != 0) return std.fmt.bufPrint(buf, "slot {d} holds a batch-6b ability", .{i}) catch "batch 6b";
        if (V08_SCOPE.refuse_revived and u.aug_orphans != 0) return std.fmt.bufPrint(buf, "slot {d} was revived", .{i}) catch "batch 6a";
        if (refusedRow(u)) |id| return std.fmt.bufPrint(buf, "slot {d} carries {s}", .{ i, id.name() }) catch "batch 6a";
    }
    if (V08_SCOPE.refuse_artifact_rows and s.artifacts) return "artifact rows";
    if (V08_SCOPE.refuse_smoke and s.fight.n_smoke != 0) return "smoke clouds on the board";
    if (V08_SCOPE.refuse_fire_walls and s.fight.n_fire != 0) return "fire walls on the board";
    // The cards and rows refused after the board-level checks (V08_SCOPE.late: none since the Nightmare's Time Denial
    // joined the scope).
    const late = V08_SCOPE.late;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.ability_mask & late.abilities != 0) return "a late-refused card";
        if (u.buffs.len != 0 and scope.carries(u.buffs.items[0..u.buffs.len], late.buffs)) return "a late-refused buff";
        if (u.debuffs.len != 0 and scope.carries(u.debuffs.items[0..u.debuffs.len], late.debuffs)) return "a late-refused debuff";
        if (u.effects.len != 0 and scope.carries(u.effects.items[0..u.effects.len], late.effects)) return "a late-refused effect";
    }
    return null;
}

/// A row V08_SCOPE refuses on the unit (a debuff, then an effect, then a buff), if any.
fn refusedRow(u: *const st.Unit) ?st.SpellId {
    for (u.debuffs.items[0..u.debuffs.len]) |d| if (scope.listed(V08_SCOPE.refused_debuffs, d.id)) return d.id;
    for (u.effects.items[0..u.effects.len]) |e| if (scope.listed(V08_SCOPE.refused_effects, e.id)) return e.id;
    for (u.buffs.items[0..u.buffs.len]) |b| if (scope.listed(V08_SCOPE.refused_buffs, b.id)) return b.id;
    return null;
}

/// The castables src/v08 decides: every `st.CastSpell` (V08_SCOPE). A whitelist: whatever joins `st.CastSpell` later keeps
/// a board out of v0.8 rollouts until src/v08 decides it and joins this list.
pub const V08_CASTABLE = [_]st.CastSpell{
    .heal,             .blessing,    .lightning_strike,  .fire_strike, .meteor_shower,     .meteorite,
    .summon_wolves,    .vine_throw,  .ring_of_fire,      .battle_roar, .wild_regeneration, .fireball,
    .fireforged_sword, .misfortune,  .smoke,             .wind_flow,   .resurrection,      .craft,
    .armor_rune,       .weapon_rune, .spiritual_armor,   .mass_heal,   .whirlpool,         .riot,
    .magic_mirror,     .mass_riot,   .mass_magic_mirror, .courage,     .helping_hand,      .fire_wall,
    .empower,          .castling,
};

/// v08Scope's tables, which the scope manifest exports (scope.zig): the castables and the batch-6b cards and rows.
/// src/v08 covers batches 1-5 and 6a with revived units, the artifact rows, smoke and the wave-2 cards and rows, the
/// Nightmare's included: Fire Wall, the burning cells (a mindless unit, which plays v0.1 whatever its seat, projects its
/// walk through them before a strike: ai.projectPostMove) and Time Denial (the engine's canWaitOnHourglass).
pub const V08_SCOPE = scope.PolicyScope{
    .name = "v0.8",
    .castable = &V08_CASTABLE,
    // Batch 6b: the cards (stolen ones too) and rows src/v08 does not cover yet. Covered: Castling (3193517c: candidates,
    // the caster router, the destination cells), the Mermaid's Water Element and Water Shield (73ffe9a5) and the
    // Thunderbird's Wind Element and Chain Lightning (7c89022b).
    .refused_abilities = st.AbilityId.BATCH6B_MASK & ~st.AbilityId.castling.bit() & ~st.AbilityId.water_element.bit() & ~st.AbilityId.water_shield.bit() & ~st.AbilityId.wind_element.bit() & ~st.AbilityId.chain_lightning.bit(),
    .refused_buffs = &.{.flesh_shield_aura},
};

/// The v0.1 policy takes every board the loader takes.
pub const V01_SCOPE = scope.PolicyScope{ .name = "v0.1" };

fn v08Castable(spell: u8) bool {
    for (V08_SCOPE.castable.?) |c| {
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
    /// The engine path the rollouts reproduce (`engine`: "match", runMatch's; "server", the server's bot-seat deps).
    engine: st.EngineMode = .match,
    /// scoreCandidates' bank semantics (the request's `bank`, ABI 3); the defaults are ABI 2's plain pair loop.
    bank: Bank = .{},
};

/// How one call reproduces a SearchDriver.scoreCandidates bank (search_driver.ts): the pairs must then be
/// candidate-major (every pair of a candidate before the next candidate's), as the bank's loops are.
pub const Bank = struct {
    /// The `break` after an illegal (-Infinity) rollout: the candidate's later pairs are not played (no turns, no
    /// summons, no uuid values).
    skip_after_illegal: bool = false,
    /// runMatch's captureAuxiliaryState, restored after every rollout of a bank: each rollout starts from the
    /// request's summon sequence instead of the previous rollout's (the server has no such counter: "call").
    summon_per_rollout: bool = false,
    /// The A19 material sample after every finite rollout (scoreCandidates' captureMaterial: "turns" banks with
    /// captureA19Material), in `PairRecord.material`.
    material: bool = false,
    /// The offline hopeless-tail bound (remainingRolloutsCannotWin) with one reference for every candidate of the call
    /// (a caller whose reference moves between candidates calls once per candidate).
    tail: ?TailBound = null,
};

/// remainingRolloutsCannotWin(sum, completed, count, reference, margin) after each finite rollout of a candidate:
/// the candidate's later pairs are skipped. Off for the rest of the call once a leaf is not in [0, 1]
/// (scoreCandidates' leafOutsideUnitInterval).
pub const TailBound = struct {
    reference: f64,
    margin: f64,
    /// The bank's rolloutCount (the bound's divisor).
    count: u32,
};

/// What happened to one pair of a call (`PairRecord.flags`).
pub const PairFlag = struct {
    pub const PLAYED: u32 = 0;
    /// Not played: an earlier rollout of its candidate was illegal (Bank.skip_after_illegal).
    pub const SKIPPED_ILLEGAL: u32 = 1;
    /// Cut by the deadline or the turn budget (its turns are counted, its value is not).
    pub const ABORTED: u32 = 2;
    /// Not reached: the call stopped before it.
    pub const NOT_REACHED: u32 = 3;
    /// Not played: the tail bound said its candidate cannot win (Bank.tail).
    pub const SKIPPED_TAIL: u32 = 4;
};

/// One pair's outcome, in request order (C layout, 40 bytes: hoc_rollout_pairs copies these).
pub const PairRecord = extern struct {
    /// The leaf value, -Infinity for a rejected candidate, NaN when the pair was not played.
    value: f64 = std.math.nan(f64),
    /// The A19 material sample (Bank.material and a finite value), else NaN.
    material: f64 = std.math.nan(f64),
    /// Rollout turns the pair played (an aborted one included).
    turns: u32 = 0,
    flags: u32 = PairFlag.NOT_REACHED,
    /// The summon counters after the pair (runMatch's createSummonedUnit counter, lib.ts deterministicUuidSequence): as
    /// the rollout left them, before Bank.summon_per_rollout restores the summon sequence (a skipped pair: the counters
    /// the next pair starts from).
    summon_seq: u32 = 0,
    /// The fight_finished team inside the rollout (0 = none), -1 when the fight did not finish.
    winner: i32 = -1,
    uuid_seq: u64 = 0,
};

/// SearchDriver.scoreCandidates' material sample: 0.5 * (1 + (ours - enemy) / (ours + enemy + 1000)) with each living
/// unit's strength exp * cumulativeHp / max(1, maxHp), in holder order (unitsHolder.getAllUnits()).
pub fn materialSample(s: *const State, team: u8) f64 {
    var ours: f64 = 0;
    var enemy: f64 = 0;
    for (s.holderOrder()) |i| {
        const u = &s.units[i];
        if (u.isDead()) continue;
        const strength = (u.exp * v08util.cumulativeHp(u)) / @max(1.0, u.max_hp);
        if (u.team == team) ours += strength else enemy += strength;
    }
    return 0.5 * (1 + (ours - enemy) / (ours + enemy + 1000));
}

/// remainingRolloutsCannotWin (search_driver.ts): every unplayed leaf in [0, 1] still leaves the candidate strictly
/// more than `margin` below `best`.
pub fn remainingRolloutsCannotWin(sum: f64, completed: u32, count: u32, best: f64, margin: f64) bool {
    if (!std.math.isFinite(sum) or !std.math.isFinite(best) or !std.math.isFinite(margin) or margin < 0 or completed < 1 or count < 2 or completed >= count) return false;
    const remaining: f64 = @floatFromInt(count - completed);
    const max_mean = (sum + remaining) / @as(f64, @floatFromInt(count));
    return max_mean + margin < best;
}

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
    /// Server mode reached a server-only path no oracle cohort has verified (State.server_unverified, server.zig): a
    /// route (UNVERIFIED_ROUTE), a 0-damage lap (UNVERIFIED_ZERO_LAP), an obstacle strike (UNVERIFIED_OBSTACLE).
    UnsupportedServerRoute,
    UnsupportedServerZeroLap,
    UnsupportedServerObstacle,
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
    /// The last rollout's fight_finished team, -1 when its fight did not finish (PairRecord.winner).
    winner: i32 = -1,
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

/// Math.exp (cmath.zig: glibc's on Linux, not the bundled compiler-rt exp).
const cExp = @import("cmath.zig").cExp;

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
    return 1 / (1 + cExp(-z));
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
    var sim: Sim = .{};
    defer ses.winner = if (sim.finished) sim.winner else -1;
    return rolloutBody(s, req, cand, r, ctl, ses, &sim);
}

fn rolloutBody(s: *State, req: *const Request, cand: *const Candidate, r: u32, ctl: *Control, ses: *Session, sim: *Sim) Error!?f64 {
    if (ctl.expired()) return null;
    s.rng = Rng.init(plainSeed(req.seed_base, r));
    if (req.chance == .antithetic) ses.chance.begin(s, req.identity.?, toUint32(req.seed_base), r);
    ses.tables.reset();
    ses.decisions = 0;
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
            try simAdvance(s, sim);
            if (sim.finished or s.active < 0) break;
        }
        const ui: u8 = @intCast(s.active);
        const u = &s.units[ui];
        if (!u.in_holder or u.isDead()) {
            s.active = -1;
            continue;
        }
        try simPlayTurn(s, ui, req, sim, ses, enemy_team);
        turns += 1;
        ctl.turns += 1;
        if (req.horizon == .reply and s.units[ui].team == enemy_team) break;
    }
    if (ctl.expired()) return null;
    if (s.overflow) return error.UnsupportedCapacity;
    if (s.server_unverified != 0) {
        if (s.server_unverified & server.UNVERIFIED_ROUTE != 0) return error.UnsupportedServerRoute;
        if (s.server_unverified & server.UNVERIFIED_ZERO_LAP != 0) return error.UnsupportedServerZeroLap;
        return error.UnsupportedServerObstacle;
    }
    return leafValueOf(req.leaf, s, acting, sim.finished, sim.winner, req.exact_terminal);
}

/// Every (candidate, r) pair of the request in order, each on a fresh copy of `root` made in `scratch` (the summon
/// counters carry over from one rollout to the next unless `req.bank` restores them); writes one value per pair into
/// `out` and returns how many it wrote (a prefix when the deadline, the turn budget or `out` stops it). `ctl` ends with
/// the counters.
pub fn run(root: *const State, scratch: *State, req: *const Request, out: []f64, ctl: *Control) Error!usize {
    return runRecords(root, scratch, req, out, ctl, &.{});
}

/// `run`, also filling `records` (one per request pair while it lasts, in pair order; entries past the stop stay
/// NOT_REACHED). With `req.bank` the call is one scoreCandidates bank (or a candidate-major slice of one): a skipped
/// pair counts as written (value NaN in `out`, its flag in the record) and plays nothing.
pub fn runRecords(root: *const State, scratch: *State, req: *const Request, out: []f64, ctl: *Control, records: []PairRecord) Error!usize {
    // Every rollout turn decides with a fresh DecisionPathCatalog (search_driver.ts simPlayTurn).
    const saved_catalog = ai.catalog_decisions;
    ai.catalog_decisions = true;
    defer ai.catalog_decisions = saved_catalog;
    try requireIdentity(req);
    var ses: Session = .{};
    ses.tables.init(root, req);
    const summon_start = req.summon_sequence orelse root.summon_seq;
    var summon_seq = summon_start;
    var uuid_seq = req.uuid_sequence orelse root.uuid_seq;
    defer {
        ctl.summon_sequence = summon_seq;
        ctl.uuid_sequence = uuid_seq;
        scratch.rng.keyed = null;
    }
    for (records) |*rc| rc.* = .{};
    const bank = req.bank;
    const acting_team = root.units[req.actor].team;
    // scoreCandidates' per-candidate loop state (pairs are candidate-major when a bank skips).
    const NONE = std.math.maxInt(u32);
    var cur_cand: u32 = NONE;
    var skip: u32 = PairFlag.PLAYED;
    var cand_sum: f64 = 0;
    var cand_done: u32 = 0;
    var outside_unit = false;
    var written: usize = 0;
    for (req.pairs, 0..) |p, i| {
        if (written >= out.len) {
            ctl.stop = .out_full;
            break;
        }
        if (p[0] != cur_cand) {
            cur_cand = p[0];
            skip = PairFlag.PLAYED;
            cand_sum = 0;
            cand_done = 0;
        }
        if (skip != PairFlag.PLAYED) {
            out[written] = std.math.nan(f64);
            if (i < records.len) records[i] = .{ .flags = skip, .summon_seq = summon_seq, .uuid_seq = uuid_seq };
            written += 1;
            continue;
        }
        const turns_before = ctl.turns;
        scratch.* = root.*;
        scratch.summon_seq = summon_seq;
        scratch.uuid_seq = uuid_seq;
        scratch.id_scheme = req.id_scheme;
        scratch.engine_mode = req.engine;
        const v = rolloutIn(scratch, req, &req.candidates[p[0]], p[1], ctl, &ses);
        summon_seq = if (bank.summon_per_rollout) summon_start else scratch.summon_seq;
        uuid_seq = scratch.uuid_seq;
        const turns: u32 = @intCast(ctl.turns - turns_before);
        const value = (try v) orelse {
            if (i < records.len) records[i] = .{ .flags = PairFlag.ABORTED, .turns = turns, .summon_seq = scratch.summon_seq, .uuid_seq = uuid_seq, .winner = ses.winner };
            break;
        };
        out[written] = value;
        written += 1;
        if (i < records.len) {
            records[i] = .{
                .value = value,
                .material = if (bank.material and std.math.isFinite(value)) materialSample(scratch, acting_team) else std.math.nan(f64),
                .flags = PairFlag.PLAYED,
                .turns = turns,
                .summon_seq = scratch.summon_seq,
                .uuid_seq = uuid_seq,
                .winner = ses.winner,
            };
        }
        if (value == -std.math.inf(f64)) {
            if (bank.skip_after_illegal) skip = PairFlag.SKIPPED_ILLEGAL;
            continue;
        }
        cand_sum += value;
        cand_done += 1;
        if (!std.math.isFinite(value) or value > 1) {
            outside_unit = true;
        } else if (bank.tail) |t| {
            if (!outside_unit and remainingRolloutsCannotWin(cand_sum, cand_done, t.count, t.reference, t.margin)) skip = PairFlag.SKIPPED_TAIL;
        }
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

test "v08Scope takes the Nightmare's boards (Fire Wall, burning cells, Time Denial) and still refuses the rest of batch 6b" {
    const snapshot = @import("snapshot.zig");
    const a = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(std.json.Value, a, @embedFile("selftest/state.json"), .{});
    defer parsed.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var why: snapshot.Why = .{};
    const ids = try snapshot.unitIds(arena.allocator(), parsed.value, &why);
    const root = try a.create(State);
    defer a.destroy(root);
    root.* = try snapshot.load(parsed.value, ids, .{}, &why);
    const ident = Identity{ .ids = ids, .names = &.{} };
    var buf: [96]u8 = undefined;
    try std.testing.expect(v08Scope(root, &ident, &buf) == null);
    const s = try a.create(State);
    defer a.destroy(s);
    const ui = root.holder[0];
    const chaos: u8 = 4; // BookEntry.PREFIXES
    // A Nightmare's board: its book (Fire Wall, Empower), its Time Denial card and a burning cell.
    s.* = root.*;
    const u = &s.units[ui];
    for ([_]st.CastSpell{ .fire_wall, .empower }) |spell| {
        u.book[u.n_book] = .{ .spell = @intFromEnum(spell), .prefix = chaos };
        u.n_book += 1;
        u.spells[u.n_spells] = .{ .spell = @intFromEnum(spell), .prefix = chaos, .amount = 1 };
        u.n_spells += 1;
    }
    u.ability_mask |= st.AbilityId.time_denial.bit();
    engine.addFire(s, .{ .x = 7, .y = 7 }, 2, 250);
    try std.testing.expect(s.fight.n_fire == 1);
    try std.testing.expect(v08Scope(s, &ident, &buf) == null);
    // A Water Shield row on a wall board is in scope too (fire.zig and ai.zig absorb the first burn); the batch-6b cards
    // and rows src/v08 does not cover yet stay out, on a wall board as anywhere, and so does a spell outside the list.
    const nightmare = s.*;
    s.units[ui].buffs.push(.{ .id = .water_shield, .laps = 3, .power = 1 });
    try std.testing.expect(v08Scope(s, &ident, &buf) == null);
    s.* = nightmare;
    s.units[ui].buffs.push(.{ .id = .flesh_shield_aura, .laps = 3, .power = 1 });
    try std.testing.expect(std.mem.indexOf(u8, v08Scope(s, &ident, &buf).?, "Flesh Shield") != null);
    s.* = nightmare;
    s.units[ui].ability_mask |= st.AbilityId.fire_element.bit();
    try std.testing.expect(std.mem.indexOf(u8, v08Scope(s, &ident, &buf).?, "batch-6b") != null);
    s.* = nightmare;
    s.units[ui].book[s.units[ui].n_book] = .{ .spell = 0xfe, .prefix = chaos };
    s.units[ui].n_book += 1;
    try std.testing.expect(std.mem.indexOf(u8, v08Scope(s, &ident, &buf).?, "spells") != null);
    // The manifest says the same: every castable (Fire Wall included), no burning-cell refusal, no late rows, Time
    // Denial loaded, only the uncovered batch-6b cards and rows refused.
    var w: std.Io.Writer.Allocating = .init(a);
    defer w.deinit();
    try scope.writePolicy(&w.writer, V08_SCOPE);
    const m = try std.json.parseFromSlice(std.json.Value, a, w.written(), .{});
    defer m.deinit();
    var fire_wall = false;
    for (m.value.object.get("castable").?.array.items) |n| fire_wall = fire_wall or std.mem.eql(u8, n.string, "Fire Wall");
    try std.testing.expect(fire_wall);
    try std.testing.expect(!m.value.object.get("refusedFireWalls").?.bool);
    try std.testing.expectEqual(@as(st.AbilityMask, 0), V08_SCOPE.late.abilities);
    const refused = m.value.object.get("refusedAbilities").?.array.items;
    try std.testing.expectEqual(@as(usize, @popCount(V08_SCOPE.refused_abilities)), refused.len);
    try std.testing.expect(V08_SCOPE.refused_abilities & ~st.AbilityId.BATCH6B_MASK == 0);
    for (refused) |n| try std.testing.expect(!std.mem.eql(u8, n.string, "Time Denial"));
    try std.testing.expectEqual(V08_SCOPE.refused_buffs.len, m.value.object.get("refusedBuffs").?.array.items.len);
}

test "plain chance seed is (seedBase + r * 0x9e3779b1) >>> 0" {
    // (123456789 + 3 * 0x9e3779b1) >>> 0 = 8086763072 mod 2^32
    try std.testing.expectEqual(@as(u32, @intCast((123456789 + 3 * 2654435761) % 4294967296)), plainSeed(123456789, 3));
    try std.testing.expectEqual(@as(u32, 4294967295), toUint32(-1));
    try std.testing.expectEqual(@as(u32, 5), toUint32(5.9));
}

test "remainingRolloutsCannotWin matches search_driver.ts" {
    // 1 of 4 rollouts at 0.1: the best possible mean is (0.1 + 3) / 4 = 0.775
    try std.testing.expect(remainingRolloutsCannotWin(0.1, 1, 4, 0.8, 0));
    try std.testing.expect(!remainingRolloutsCannotWin(0.1, 1, 4, 0.775, 0));
    try std.testing.expect(!remainingRolloutsCannotWin(0.1, 1, 4, 0.8, 0.03));
    // guards: no rollout yet, a single rollout, all done, a non-finite reference, a negative margin
    try std.testing.expect(!remainingRolloutsCannotWin(0, 0, 4, 0.9, 0));
    try std.testing.expect(!remainingRolloutsCannotWin(0.1, 1, 1, 0.9, 0));
    try std.testing.expect(!remainingRolloutsCannotWin(0.4, 4, 4, 0.9, 0));
    try std.testing.expect(!remainingRolloutsCannotWin(0.1, 1, 4, -std.math.inf(f64), 0));
    try std.testing.expect(!remainingRolloutsCannotWin(0.1, 1, 4, 0.9, -1));
}
