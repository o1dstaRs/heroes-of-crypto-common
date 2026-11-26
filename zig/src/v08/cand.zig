//! enumerateCandidates (src/ai/candidates.ts CandidateGenerator), the part v0.8's passes run: candidate 0 is the
//! incumbent, then wait, defend, melee (target x stand pairs), shots and moves, deduplicated by the action signature;
//! a duplicate of the incumbent enriches it. Checked against the recorder's candidate lists (RECORD_CANDIDATES=1) by
//! `hoc-sim v08 candidates`. Not ported yet: shots (a list that has one is reported, not compared), mountain strikes,
//! area throws and spells (out of scope), Last Fuse / Lightning Spin / Fire Breath / Rapid Charge valuations.

const std = @import("std");
const rec = @import("../recording.zig");
const st = @import("../state.zig");
const engine = @import("../engine.zig");
const combat = @import("../combat.zig");
const path = @import("../path.zig");
const ai = @import("../ai.zig");
const util = @import("util.zig");
const abilities = @import("../abilities.zig");
const terrain = @import("../terrain.zig");

const Cell = rec.Cell;
const AT = st.AttackType;

pub const Kind = enum { incumbent, wait, defend, melee, shot, move, mine, throw, spell };

pub fn kindName(k: Kind) []const u8 {
    return switch (k) {
        .incumbent => "incumbent",
        .wait => "wait",
        .defend => "defend",
        .melee => "melee",
        .shot => "shot",
        .move => "move",
        .mine => "mine",
        .throw => "throw",
        .spell => "spell",
    };
}

pub const Candidate = struct {
    kind: Kind,
    d: ai.Decision = .{},
    /// targetId as a unit index, or -1.
    target: i16 = -1,
    stand: ?Cell = null,
    tcell: ?Cell = null,
    ed: f64 = 0,
    ek: u8 = 0,
};

pub const Options = struct {
    max_moves: usize = 0,
    max_melee: usize = 0,
    max_shots: usize = 0,
    enrich: bool = false,
    coverage: bool = false,
    /// includeMountainAttacks: one strike on a standing scattered stone (the classic centre mountain is not ported).
    mountains: bool = false,
};

pub const MAX = 64;

pub const Set = struct {
    items: [MAX]Candidate = undefined,
    n: usize = 0,
    /// A class this slice does not generate yet was needed (the caller must not trust the list).
    incomplete: bool = false,

    pub fn slice(self: *const Set) []const Candidate {
        return self.items[0..self.n];
    }
};

// ---- signature ---------------------------------------------------------------------------------------------------

inline fn sameCell(a: Cell, b: Cell) bool {
    return a.x == b.x and a.y == b.y;
}

fn lastCell(p: []const Cell) ?Cell {
    return if (p.len == 0) null else p[p.len - 1];
}

fn optCellEq(a: ?Cell, b: ?Cell) bool {
    if (a == null or b == null) return a == null and b == null;
    return sameCell(a.?, b.?);
}

/// CandidateGenerator.signature equality: per action its type and the fields the signature keeps.
pub fn sigEqual(a: []const rec.Action, b: []const rec.Action) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        if (std.meta.activeTag(x) != std.meta.activeTag(y)) return false;
        switch (x) {
            .select_attack_type => |s| if (s.attack_type != y.select_attack_type.attack_type) return false,
            .move_unit => |m| if (!optCellEq(lastCell(m.path), lastCell(y.move_unit.path))) return false,
            .melee_attack => |m| if (m.target != y.melee_attack.target or !sameCell(m.attack_from, y.melee_attack.attack_from)) return false,
            .range_attack => |r| {
                const o = y.range_attack;
                if (r.target != o.target or !optCellEq(r.aim_cell, o.aim_cell) or r.aim_side != o.aim_side) return false;
            },
            .obstacle_attack => |o| {
                const p = y.obstacle_attack;
                if (o.target_x != p.target_x or o.target_y != p.target_y or o.has_from != p.has_from) return false;
                if (o.has_from and !sameCell(o.attack_from, p.attack_from)) return false;
            },
            else => {},
        }
    }
    return true;
}

// ---- generator ---------------------------------------------------------------------------------------------------

const Gen = struct {
    c: *ai.Ctx,
    opt: Options,
    out: *Set,

    fn incumbentSig(self: *const Gen) ?[]const rec.Action {
        if (self.out.n == 0 or self.out.items[0].kind != .incumbent) return null;
        return self.out.items[0].d.slice();
    }

    /// enrichIncumbentCandidate: a generated twin of candidate 0 copies its observations onto it.
    fn enrich(self: *Gen, cand: *const Candidate) void {
        const inc = self.incumbentSig() orelse return;
        if (!sigEqual(inc, cand.d.slice())) return;
        const anchor = &self.out.items[0];
        if (!self.opt.enrich) {
            if (cand.kind == .shot) {
                anchor.target = cand.target;
                anchor.ed = cand.ed;
                anchor.ek = cand.ek;
            }
            return;
        }
        anchor.target = cand.target;
        anchor.stand = cand.stand;
        anchor.tcell = cand.tcell;
        anchor.ed = cand.ed;
        anchor.ek = cand.ek;
    }

    fn push(self: *Gen, cand: *const Candidate) void {
        for (self.out.slice()) |*have| {
            if (sigEqual(have.d.slice(), cand.d.slice())) {
                self.enrich(cand);
                return;
            }
        }
        if (self.out.n >= MAX) {
            self.out.incomplete = true;
            return;
        }
        self.out.items[self.out.n] = cand.*;
        // The decision's path slices point into its own buffers; rebase them after the copy.
        util.copyDecision(&self.out.items[self.out.n].d, &cand.d);
        self.out.n += 1;
    }

    fn unit(self: *const Gen) *st.Unit {
        return self.c.unit();
    }

    // ---- wait / defend ----

    fn addWait(self: *Gen) void {
        if (!util.canHourglass(self.c.s, self.c.ui)) return;
        var cand = Candidate{ .kind = .wait };
        cand.d.push(.{ .wait_turn = .{ .unit = self.c.ui } });
        self.push(&cand);
    }

    fn addDefend(self: *Gen) void {
        var cand = Candidate{ .kind = .defend };
        cand.d.push(.{ .defend_turn = .{ .unit = self.c.ui } });
        self.push(&cand);
    }

    // ---- shared move pieces ----

    fn movePath(self: *Gen) ?*const path.MovePath {
        if (!self.unit().canMove()) return null;
        return self.c.actualPath();
    }

    /// footprintForCell: getFootprintCellsForPosition at the anchor, whose 2x2 keeps the legacy getCellsAroundPosition
    /// order (x-1,y), (x,y), (x-1,y-1), (x,y-1); other shapes are footprintCellsForAnchor's.
    fn bodyAt(self: *const Gen, a: Cell) engine.Cells {
        const u = self.unit();
        if (u.fw == 2 and u.fh == 2) {
            var out: engine.Cells = .{};
            out.push(.{ .x = a.x - 1, .y = a.y });
            out.push(a);
            out.push(.{ .x = a.x - 1, .y = a.y - 1 });
            out.push(.{ .x = a.x, .y = a.y - 1 });
            return out;
        }
        return ai.footprintForAnchor(u, a);
    }

    /// moveAction(route): the route's cells and the body at its end.
    fn moveTo(self: *Gen, mp: *const path.MovePath, r: *const path.Route, d: *ai.Decision) void {
        const len = mp.routeCells(r, &d.path);
        const body = self.bodyAt(r.cell);
        const cells = body.slice();
        @memcpy(d.targets[0..cells.len], cells);
        d.push(.{ .move_unit = .{ .unit = self.c.ui, .path = d.path[0..len], .target_cells = d.targets[0..cells.len], .has_lava = r.has_lava } });
    }

    // ---- scattered stones (addMountainAttack, scattered branch) ----

    fn addMountainAttack(self: *Gen) void {
        if (!self.opt.mountains) return;
        const s = self.c.s;
        const u = self.unit();
        if (u.isDead()) return;
        if (s.grid.terrain.n_layout == 0) {
            if (s.fight.grid_type == st.GridType.BLOCK_CENTER) self.out.incomplete = true; // the classic mountain
            return;
        }
        var stones: terrain.CenterCells = .{};
        terrain.centerCells(s, &stones);
        const standing = stones.slice();
        if (standing.len == 0) return;
        if (u.target >= 0 and u.target < s.n_units and !s.units[@intCast(u.target)].isDead()) return;
        const base = engine.baseCell(u);
        if (engine.canLandRangeAttack(s, u) and (u.attack_type_selected == AT.RANGE or engine.possibleIncludes(u, AT.RANGE))) {
            // A shooter strikes the nearest stone (Manhattan, first in layout order on ties) from where it stands.
            var target = standing[0];
            var best: i32 = std.math.maxInt(i32);
            for (standing) |cell| {
                const d: i32 = @intCast(@abs(cell.x - base.x) + @abs(cell.y - base.y));
                if (d < best) {
                    best = d;
                    target = cell;
                }
            }
            var cand: Candidate = .{ .kind = .mine, .tcell = target, .stand = base };
            if (u.attack_type_selected != AT.RANGE) cand.d.push(.{ .select_attack_type = .{ .unit = self.c.ui, .attack_type = AT.RANGE } });
            const pos = engine.positionForCell(@floatFromInt(target.x), @floatFromInt(target.y));
            cand.d.push(.{ .obstacle_attack = .{ .attacker = self.c.ui, .target_x = pos[0], .target_y = pos[1], .attack_from = .{ .x = 0, .y = 0 }, .path = &.{}, .has_from = false } });
            self.push(&cand);
            return;
        }
        if (!u.canMove() or u.attack_type_selected == AT.RANGE or !self.canMelee()) return;
        // mountainMeleeStrike: the stationary strike if a stone touches the body, else the cheapest reachable stand
        // touching one (weight, stand x, y, stone x, y; one route per cell in scope).
        var sorted: [st.MAX_STONES]Cell = undefined;
        @memcpy(sorted[0..standing.len], standing);
        std.sort.insertion(Cell, sorted[0..standing.len], {}, struct {
            fn lt(_: void, a: Cell, b: Cell) bool {
                return a.x < b.x or (a.x == b.x and a.y < b.y);
            }
        }.lt);
        const targets = sorted[0..standing.len];
        const Strike = struct { from: Cell, target: Cell, route: ?u16, weight: f64 };
        var best: ?Strike = null;
        if (self.stoneNextTo(targets, base)) |t| {
            if (ai.canLandAt(s, self.c.ui, base)) best = .{ .from = base, .target = t, .route = null, .weight = 0 };
        }
        const mp = self.movePath();
        if (best == null) {
            if (mp) |m| {
                for (m.known(), 0..) |*r, ri| {
                    if (sameCell(r.cell, base) or !std.math.isFinite(r.weight) or !ai.canLandAt(s, self.c.ui, r.cell)) continue;
                    const t = self.stoneNextTo(targets, r.cell) orelse continue;
                    const cand_ = Strike{ .from = r.cell, .target = t, .route = @intCast(ri), .weight = r.weight };
                    if (best) |b| {
                        const better = if (cand_.weight != b.weight) cand_.weight < b.weight else if (cand_.from.x != b.from.x) cand_.from.x < b.from.x else if (cand_.from.y != b.from.y) cand_.from.y < b.from.y else if (cand_.target.x != b.target.x) cand_.target.x < b.target.x else cand_.target.y < b.target.y;
                        if (better) best = cand_;
                    } else best = cand_;
                }
            }
        }
        const strike = best orelse return;
        var cand: Candidate = .{ .kind = .mine, .tcell = strike.target, .stand = strike.from };
        const pos = engine.positionForCell(@floatFromInt(strike.target.x), @floatFromInt(strike.target.y));
        var route_cells: []const Cell = &.{};
        var lava = false;
        if (strike.route) |ri| {
            const r = &mp.?.known()[ri];
            const len = mp.?.routeCells(r, &cand.d.path);
            route_cells = cand.d.path[0..len];
            lava = r.has_lava;
        }
        cand.d.push(.{ .obstacle_attack = .{ .attacker = self.c.ui, .target_x = pos[0], .target_y = pos[1], .attack_from = strike.from, .path = route_cells, .has_lava = lava } });
        self.push(&cand);
    }

    /// The first stone (in x, y order) touching the body at `stand` (legacy footprint order).
    fn stoneNextTo(self: *const Gen, targets: []const Cell, stand: Cell) ?Cell {
        const body = self.bodyAt(stand);
        for (body.slice()) |fc| {
            for (targets) |t| {
                if (@abs(fc.x - t.x) <= 1 and @abs(fc.y - t.y) <= 1) return t;
            }
        }
        return null;
    }

    // ---- moves ----

    fn addMoves(self: *Gen) void {
        const mp = self.movePath() orelse return;
        const u = self.unit();
        const base = engine.baseCell(u);
        var routes: [path.MAX_ROUTES]u16 = undefined;
        var n: usize = 0;
        for (mp.known(), 0..) |*r, i| {
            if (sameCell(r.cell, base)) continue;
            if (!ai.canLandAt(self.c.s, self.c.ui, r.cell)) continue;
            routes[n] = @intCast(i);
            n += 1;
        }
        var kept: [path.MAX_ROUTES]u16 = undefined;
        var kn: usize = n;
        @memcpy(kept[0..n], routes[0..n]);
        if (self.opt.max_moves > 0 and n > self.opt.max_moves) {
            // Nearest-to-an-enemy destinations first (Manhattan to an enemy base cell); stable on ties.
            var dist: [path.MAX_ROUTES]f64 = undefined;
            for (routes[0..n], 0..) |ri, j| dist[j] = self.enemyDistance(mp.known()[ri].cell);
            var order: [path.MAX_ROUTES]u16 = undefined;
            for (0..n) |j| order[j] = @intCast(j);
            const Ctx = struct { d: []const f64 };
            std.sort.insertion(u16, order[0..n], Ctx{ .d = dist[0..n] }, struct {
                fn lt(ctx: Ctx, a: u16, b: u16) bool {
                    return ctx.d[a] < ctx.d[b];
                }
            }.lt);
            kn = self.opt.max_moves;
            for (0..kn) |j| kept[j] = routes[order[j]];
        }
        var cand: Candidate = undefined;
        if (self.opt.enrich) {
            for (routes[0..n]) |ri| {
                self.moveCandidate(mp, &mp.known()[ri], &cand);
                self.enrich(&cand);
            }
        }
        for (kept[0..kn]) |ri| {
            self.moveCandidate(mp, &mp.known()[ri], &cand);
            self.push(&cand);
        }
    }

    /// Built in place: a Decision's path slices point into its own buffers, so a candidate is never returned by value.
    fn moveCandidate(self: *Gen, mp: *const path.MovePath, r: *const path.Route, cand: *Candidate) void {
        cand.* = .{ .kind = .move, .tcell = r.cell };
        self.moveTo(mp, r, &cand.d);
    }

    fn enemyDistance(self: *const Gen, cell: Cell) f64 {
        const s = self.c.s;
        const team = self.unit().team;
        var best: f64 = std.math.inf(f64);
        var any = false;
        for (s.holderOrder()) |e_slot| {
            const e = &s.units[e_slot];
            if (!e.in_holder or e.isDead() or e.team == team) continue;
            any = true;
            const b = engine.baseCell(e);
            const d: f64 = @floatFromInt(@abs(cell.x - b.x) + @abs(cell.y - b.y));
            best = @min(best, d);
        }
        return if (any) best else 0;
    }

    // ---- melee ----

    fn canMelee(self: *const Gen) bool {
        const u = self.unit();
        // No Melee is not in the engine's ability set yet (no creature in scope has it).
        const sel = u.attack_type_selected;
        if (sel == AT.MELEE or sel == AT.MELEE_MAGIC) return true;
        return engine.possibleIncludes(u, AT.MELEE) or engine.possibleIncludes(u, AT.MELEE_MAGIC);
    }

    const Dmg = struct { ed: f64, ek: u8 };

    /// meleeDamage: the mean of the melee roll's bounds (native shooters strike at half; Handyman, which would lift
    /// that, is not in the engine's ability set yet), capped at the target's health.
    fn meleeDamage(self: *const Gen, ti: u8) Dmg {
        const u = self.unit();
        const t = &self.c.s.units[ti];
        const atk_mul: f64 = if (u.ability(.double_punch) != null) 2 else 1;
        // Native shooters deal half melee damage unless Handyman removes the penalty.
        const ranged_mul: f64 = if (u.attack_type == AT.RANGE and !u.has(.handyman)) 0.5 else 1;
        const lo = atk_mul * @floor(combat.damageBound(u, t, u.attack_damage_min, false, 1) * ranged_mul);
        const hi = atk_mul * @floor(combat.damageBound(u, t, u.attack_damage_max, false, 1) * ranged_mul);
        const hp = util.cumulativeHp(t);
        const effective = @min((lo + hi) / 2, hp);
        return .{ .ed = effective, .ek = if (effective >= hp) 1 else 0 };
    }

    const Pair = struct {
        target: u8,
        cell: Cell,
        route: ?u16,
        ed: f64,
        ek: u8,
        index: u16,
        fn stationary(self: Pair) bool {
            return self.route == null;
        }
        fn coverTarget(self: Pair) u8 {
            return self.target;
        }
    };

    /// One distinct visible-edge aim (addShots): the resolved first hit, the aimed enemy, the edge and its value.
    const Shot = struct {
        target: u8,
        aim: u8,
        cell: Cell,
        side: u8,
        ed: f64,
        ek: u8,
        index: u16,
        hits: combat.Hits,
        fn stationary(_: Shot) bool {
            return true;
        }
        /// Coverage preserves every declared visible-edge anchor (the aimed enemy).
        fn coverTarget(self: Shot) u8 {
            return self.aim;
        }
    };

    fn shotCandidate(self: *Gen, sh: *const Shot, cand: *Candidate) void {
        cand.* = .{ .kind = .shot, .target = sh.target, .ed = sh.ed, .ek = sh.ek };
        if (self.unit().attack_type_selected != AT.RANGE) cand.d.push(.{ .select_attack_type = .{ .unit = self.c.ui, .attack_type = AT.RANGE } });
        cand.d.push(.{ .range_attack = .{ .attacker = self.c.ui, .target = sh.aim, .aim_cell = sh.cell, .aim_side = sh.side } });
    }

    /// shotDamage for a plain shot (no Through Shot, splash, Double Shot, Echo, Deep Wounds, shields or Last Fuse in
    /// scope): the hit chance times the mean volley on the first impact, capped at its health.
    fn shotDamage(self: *const Gen, ti: u8, divisor: f64) Dmg {
        const u = self.unit();
        const t = &self.c.s.units[ti];
        const lo = @floor(combat.damageBound(u, t, u.attack_damage_min, true, divisor));
        const hi = @floor(combat.damageBound(u, t, u.attack_damage_max, true, divisor));
        const hp = util.cumulativeHp(t);
        const hit = 1 - @min(100, @max(0, abilities.missChance(u, t))) / 100;
        const effective = hit * @min((lo + hi) / 2, hp);
        return .{ .ed = effective, .ek = if (effective >= hp) 1 else 0 };
    }

    fn sameLine(a: *const combat.Hits, b: *const combat.Hits) bool {
        if (a.len != b.len) return false;
        for (0..a.len) |i| if (a.units[i] != b.units[i] or a.divisors[i] != b.divisors[i]) return false;
        return true;
    }

    fn addShots(self: *Gen) void {
        const s = self.c.s;
        const u = self.unit();
        if (!engine.canLandRangeAttack(s, u)) return;
        if (u.attack_type_selected != AT.RANGE and !engine.possibleIncludes(u, AT.RANGE)) return;
        const team = u.team;
        const opp = engine.opposite(team);
        const from = [2]f64{ u.pos_x, u.pos_y };
        const small = engine.isSmall(u);
        const forced: i32 = if (u.target >= 0 and u.target < s.n_units and !s.units[@intCast(u.target)].isDead()) @as(i32, u.target) else -1;
        var found: [128]Shot = undefined;
        var nf: usize = 0;
        for (s.holderOrder()) |i_slot| {
            const i: usize = i_slot;
            const e = &s.units[i_slot];
            if (!util.livingOf(s, i, opp)) continue;
            const ei: u8 = @intCast(i);
            const to = [2]f64{ e.pos_x, e.pos_y };
            const e_small = engine.isSmall(e);
            const cells = engine.unitCells(e);
            for (cells.slice()) |cell| {
                for ([_]u8{ 0, 1, 2, 3 }) |side| {
                    if (!combat.sideObservable(s, cell, side, team)) continue;
                    if (!util.sideSelectable(s, cell, side, from, to, small, e_small, team)) continue;
                    const aim = combat.sideCenter(cell, side, from[0], from[1]);
                    const hits = combat.evaluateRange(s, self.c.ui, from[0], from[1], aim[0], aim[1]);
                    if (hits.len == 0) continue;
                    const primary = hits.units[0];
                    if (s.units[primary].isDead() or s.units[primary].team != opp) continue;
                    if (forced >= 0 and forced != @as(i32, primary)) continue;
                    if (primary != ei) continue; // a plain shot never advertises a rear stack behind the first hit
                    var dup = false;
                    for (found[0..nf]) |*f| if (f.aim == ei and sameLine(&f.hits, &hits)) {
                        dup = true;
                    };
                    if (dup) continue;
                    if (nf >= found.len) {
                        self.out.incomplete = true;
                        continue;
                    }
                    const dmg = self.shotDamage(primary, hits.divisors[0]);
                    found[nf] = .{ .target = primary, .aim = ei, .cell = cell, .side = side, .ed = dmg.ed, .ek = dmg.ek, .index = @intCast(nf), .hits = hits };
                    nf += 1;
                }
            }
        }
        var kept: [1024]u16 = undefined;
        var kn: usize = nf;
        for (0..nf) |i| kept[i] = @intCast(i);
        if (self.opt.max_shots > 0 and nf > self.opt.max_shots) kn = capAttack(found[0..nf], self.opt.max_shots, self.opt.coverage, &kept);
        var cand: Candidate = undefined;
        // Shot enrichment is unconditional (it predates the opt-in metadata enrichment).
        for (found[0..nf]) |*sh| {
            self.shotCandidate(sh, &cand);
            self.enrich(&cand);
        }
        for (kept[0..kn]) |i| {
            self.shotCandidate(&found[i], &cand);
            self.push(&cand);
        }
    }

    fn meleeCandidate(self: *Gen, mp: ?*const path.MovePath, p: *const Pair, cand: *Candidate) void {
        cand.* = .{ .kind = .melee, .target = p.target, .stand = p.cell, .ed = p.ed, .ek = p.ek };
        const u = self.unit();
        // meleeAttackTypeSelectionPrefix
        if (u.attack_type_selected != AT.MELEE and u.attack_type_selected != AT.MELEE_MAGIC) {
            if (engine.possibleIncludes(u, AT.MELEE)) {
                cand.d.push(.{ .select_attack_type = .{ .unit = self.c.ui, .attack_type = AT.MELEE } });
            } else if (engine.possibleIncludes(u, AT.MELEE_MAGIC)) {
                cand.d.push(.{ .select_attack_type = .{ .unit = self.c.ui, .attack_type = AT.MELEE_MAGIC } });
            }
        }
        const base = engine.baseCell(u);
        if (p.route) |ri| {
            if (!sameCell(p.cell, base)) self.moveTo(mp.?, &mp.?.known()[ri], &cand.d);
        }
        cand.d.push(.{ .melee_attack = .{ .attacker = self.c.ui, .target = p.target, .attack_from = p.cell, .path = &.{} } });
    }

    fn addMelee(self: *Gen) void {
        if (!self.canMelee()) return;
        const s = self.c.s;
        const u = self.unit();
        const team = u.team;
        var targets: [st.MAX_UNITS]u8 = undefined;
        var nt: usize = 0;
        const forced: i32 = if (u.target >= 0 and u.target < s.n_units and !s.units[@intCast(u.target)].isDead()) @as(i32, u.target) else -1;
        for (s.holderOrder()) |i_slot| {
            const i: usize = i_slot;
            const e = &s.units[i_slot];
            if (!e.in_holder or e.isDead() or e.team == team) continue;
            if (forced >= 0 and forced != @as(i32, @intCast(i))) continue;
            targets[nt] = @intCast(i);
            nt += 1;
        }
        if (nt == 0) return;
        var damage: [st.MAX_UNITS]?Dmg = .{null} ** st.MAX_UNITS;
        const base = engine.baseCell(u);
        const mine = engine.unitCells(u);
        var pairs: [1024]Pair = undefined;
        var np: usize = 0;
        const add = struct {
            fn f(g: *Gen, dmg: *[st.MAX_UNITS]?Dmg, ps: *[1024]Pair, n: *usize, ti: u8, cell: Cell, route: ?u16) void {
                if (n.* >= ps.len) {
                    g.out.incomplete = true;
                    return;
                }
                if (dmg[ti] == null) dmg[ti] = g.meleeDamage(ti);
                const v = dmg[ti].?;
                ps[n.*] = .{ .target = ti, .cell = cell, .route = route, .ed = v.ed, .ek = v.ek, .index = @intCast(n.*) };
                n.* += 1;
            }
        }.f;
        // In-place strikes: enemies already adjacent to the current footprint.
        for (targets[0..nt]) |ti| {
            if (ai.adjacent(engine.unitCells(&s.units[ti]).slice(), mine.slice())) add(self, &damage, &pairs, &np, ti, base, null);
        }
        // Move-and-strike: every reachable stand whose footprint touches a target.
        if (self.movePath()) |mp| {
            for (mp.known(), 0..) |*r, ri| {
                if (!ai.canLandAt(s, self.c.ui, r.cell)) continue;
                const body = ai.footprintForAnchor(u, r.cell);
                for (targets[0..nt]) |ti| {
                    if (ai.adjacent(body.slice(), engine.unitCells(&s.units[ti]).slice())) add(self, &damage, &pairs, &np, ti, r.cell, @intCast(ri));
                }
            }
        }
        const mp = self.movePath();
        var kept: [1024]u16 = undefined;
        var kn: usize = np;
        for (0..np) |i| kept[i] = @intCast(i);
        if (self.opt.max_melee > 0 and np > self.opt.max_melee) {
            kn = capAttack(pairs[0..np], self.opt.max_melee, self.opt.coverage, &kept);
        }
        var cand: Candidate = undefined;
        if (self.opt.enrich) {
            for (pairs[0..np]) |*p| {
                self.meleeCandidate(mp, p, &cand);
                self.enrich(&cand);
            }
        }
        for (kept[0..kn]) |i| {
            self.meleeCandidate(mp, &pairs[i], &cand);
            self.push(&cand);
        }
    }
};

/// capAttackCandidates on melee pairs or shots (anything with target, ed, ek, a stationary flag and its source index):
/// by expected damage (stable), or with target coverage first.
fn capAttack(pairs: anytype, cap: usize, coverage: bool, out: *[1024]u16) usize {
    const P = @TypeOf(pairs);
    const n = pairs.len;
    var order: [1024]u16 = undefined;
    for (0..n) |i| order[i] = @intCast(i);
    if (!coverage) {
        std.sort.insertion(u16, order[0..n], pairs, struct {
            fn lt(ps: P, a: u16, b: u16) bool {
                return ps[b].ed < ps[a].ed;
            }
        }.lt);
        for (0..cap) |i| out[i] = order[i];
        return cap;
    }
    const precedes = struct {
        fn f(ps: P, a: u16, b: u16) bool {
            const l = ps[a];
            const r = ps[b];
            if (l.ek != r.ek) return l.ek > r.ek;
            if (l.ed != r.ed) return l.ed > r.ed;
            const ls = l.stationary();
            const rs = r.stationary();
            if (ls != rs) return ls;
            return l.index < r.index;
        }
    }.f;
    // Best delivery per distinct target, in first-seen order of the target.
    var best: [st.MAX_UNITS]i32 = .{-1} ** st.MAX_UNITS;
    var first_seen: [st.MAX_UNITS]u8 = undefined;
    var nt: usize = 0;
    for (0..n) |i| {
        const t = pairs[i].coverTarget();
        if (best[t] < 0) {
            best[t] = @intCast(i);
            first_seen[nt] = t;
            nt += 1;
        } else if (precedes(pairs, @intCast(i), @intCast(best[t]))) best[t] = @intCast(i);
    }
    var used: [1024]bool = .{false} ** 1024;
    var k: usize = 0;
    for (first_seen[0..nt]) |t| {
        out[k] = @intCast(best[t]);
        used[@intCast(best[t])] = true;
        k += 1;
    }
    var fill: [1024]u16 = undefined;
    var nf: usize = 0;
    for (0..n) |i| if (!used[i]) {
        fill[nf] = @intCast(i);
        nf += 1;
    };
    std.sort.insertion(u16, fill[0..nf], pairs, precedes);
    const budget = @max(cap, nt);
    for (fill[0..nf]) |i| {
        if (k >= budget) break;
        out[k] = i;
        k += 1;
    }
    return @min(k, budget);
}

/// isOneModelDecoy: a one-creature stack whose creature has a bigger living stack in its army.
fn isOneModelDecoy(s: *const st.State, ti: i16) bool {
    if (ti < 0) return false;
    const t = &s.units[@intCast(ti)];
    if (t.isDead() or t.amount_alive > 1) return false;
    for (s.holderOrder()) |i_slot| {
        const i: usize = i_slot;
        const o = &s.units[i_slot];
        if (i == @as(usize, @intCast(ti)) or !o.in_holder or o.isDead() or o.team != t.team) continue;
        if (o.creature_id == t.creature_id and o.amount_alive > 1) return true;
    }
    return false;
}

fn meleeTargetOf(d: *const ai.Decision) i16 {
    for (d.slice()) |a| if (a == .melee_attack) return a.melee_attack.target;
    return -1;
}

/// enumerateCandidates for unit `c.ui` with `incumbent` as candidate 0.
pub fn enumerate(c: *ai.Ctx, incumbent: *const ai.Decision, opt: Options, out: *Set) void {
    out.* = .{};
    var g = Gen{ .c = c, .opt = opt, .out = out };
    var inc = Candidate{ .kind = .incumbent };
    util.copyDecision(&inc.d, incumbent);
    g.push(&inc);
    g.addWait();
    g.addDefend();
    g.addMelee();
    g.addMountainAttack();
    g.addShots();
    g.addMoves();
    // a19-decoy-aware-v1 (on unless A19_DECOY_AWARE_<SIDE>=0): no challenger strikes a one-model decoy while another
    // candidate strikes a real stack. Candidate 0 always stays.
    var real = false;
    for (out.slice()) |*cand| {
        const t = meleeTargetOf(&cand.d);
        if (t >= 0 and !isOneModelDecoy(c.s, t)) real = true;
    }
    if (real) {
        var k: usize = 1;
        for (1..out.n) |i| {
            if (isOneModelDecoy(c.s, meleeTargetOf(&out.items[i].d))) continue;
            if (k != i) {
                out.items[k] = out.items[i];
                util.copyDecision(&out.items[k].d, &out.items[i].d);
            }
            k += 1;
        }
        out.n = k;
    }
}

/// The boundary options (enumerateV08BoundaryCandidates without mountain strikes).
pub const BOUNDARY = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true };
/// enumerateV08BoundaryCandidates with mountain strikes (the cemetery pass).
pub const BOUNDARY_MOUNTAINS = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true, .mountains = true };
/// prioritizeV08A13FinishDecision's options.
pub const FINISH = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true, .coverage = true };
