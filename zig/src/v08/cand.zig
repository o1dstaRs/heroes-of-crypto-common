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
const spells = @import("../spells.zig");

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
    /// spellName: a spell candidate's spell (a CastSpell raw id), or -1.
    spell: i16 = -1,
};

pub const Options = struct {
    max_moves: usize = 0,
    max_melee: usize = 0,
    max_shots: usize = 0,
    enrich: bool = false,
    coverage: bool = false,
    /// includeMountainAttacks: one strike on a standing scattered stone (the classic centre mountain is not ported).
    mountains: bool = false,
    /// Port-only: the incumbent and the spell candidates, nothing else. A caller that reads only the spell candidates
    /// of an uncapped list gets them in the same order (no other class shares a cast signature, and the incumbent it
    /// passes is not a cast), without the MAX overflow the uncapped moves and melee pairs could hit.
    spells_only: bool = false,
    /// preserveMeteoriteTargetCoverage (battleMageTargetsEnabled, on for a Battle Mage): a Battle Mage's Meteorite keeps
    /// every distinct visible impact after the best one.
    meteor_coverage: bool = false,
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
            // cs:<spell>><targetId or ->@<targetCell or -> (no Fire Wall orientation in scope).
            .cast_spell => |c| {
                const o = y.cast_spell;
                if (c.spell != o.spell or c.has_target != o.has_target or c.has_cell != o.has_cell) return false;
                if (c.has_target and c.target != o.target) return false;
                if (c.has_cell and !sameCell(c.cell, o.cell)) return false;
            },
            else => {},
        }
    }
    return true;
}

/// thrownSpellReachesAimedTarget (the AI's gate, stricter than the engine's): a Fire Strike must reach the aimed target
/// itself (an observable edge and an unobstructed trajectory: a screening body would take it instead); Vine Throw and
/// Ring of Fire keep the engine's lane; other spells need no line.
pub fn reachesAimedTarget(s: *const st.State, ci: u8, ti: u8, spell: spells.CS) bool {
    if (spell == .fire_strike) {
        const t = spells.trajectory(s, ci, ti) orelse return false;
        return t.obstruction == 0;
    }
    return spells.lineOfSightClear(s, ci, ti, spell);
}

/// Unit slots in first-seen order (evaluateAffectedUnits' list).
const Slots = struct {
    items: [st.MAX_UNITS]u8 = undefined,
    len: u8 = 0,

    fn push(self: *Slots, x: u8) void {
        if (self.len < self.items.len) {
            self.items[self.len] = x;
            self.len += 1;
        }
    }
    fn slice(self: *const Slots) []const u8 {
        return self.items[0..self.len];
    }
};

/// evaluateAffectedUnits(cells, rangedAreaAttack = false): the holder units standing on the cells, each once, at its
/// first cell in `cells` order.
fn affectedUnits(s: *const st.State, cells: []const Cell, out: *Slots) void {
    var seen: [st.MAX_UNITS]bool = .{false} ** st.MAX_UNITS;
    for (cells) |cell| {
        if (!engine.cellWithinGrid(cell)) continue;
        const code = s.grid.board[@intCast(cell.x)][@intCast(cell.y)];
        if (!st.isUnitCode(code)) continue;
        const v: u8 = code - 1;
        if (!s.units[v].in_holder or seen[v]) continue;
        seen[v] = true;
        out.push(v);
    }
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
        anchor.spell = cand.spell;
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

    // ---- spells (addSpells) ----

    /// pushSpell: one cast_spell action with the given targetId / targetCell; a damage spell carries its valuation.
    fn pushSpell(self: *Gen, raw: u8, target: ?u8, cell: ?Cell, ed: f64, ek: u8) void {
        var cand = Candidate{ .kind = .spell, .spell = raw, .ed = ed, .ek = ek, .tcell = cell };
        if (target) |t| cand.target = t;
        cand.d.push(.{ .cast_spell = .{ .caster = self.c.ui, .spell = raw, .target = target orelse 0, .has_target = target != null, .cell = cell orelse .{ .x = 0, .y = 0 }, .has_cell = cell != null } });
        self.push(&cand);
    }

    const Damage = struct { value: f64, kill: u8 };

    /// offensiveSpellDamage: projectSpellDamageAgainstUnit's damage (an Ember Covenant holder blocks it; Water Shield
    /// is not in scope), capped at the target's cumulative HP, and whether it kills the stack.
    fn spellDamage(self: *const Gen, spell: spells.CS, cfg: *const st.SpellConfig, ti: u8) Damage {
        const t = &self.c.s.units[ti];
        const landed = spells.damageAgainst(spells.rawDamage(self.unit(), spell, cfg), cfg.element, t);
        const damage: f64 = if (abilities.absorbsHit(t)) 0 else landed;
        const hp = util.cumulativeHp(t);
        return .{ .value = @min(damage, hp), .kill = if (damage >= hp) 1 else 0 };
    }

    /// ringOfFireDamage: every other living stack touching the target's body (the caster and the target spared), enemy
    /// damage counted for and friendly damage against; null for an empty ring.
    fn ringDamage(self: *const Gen, spell: spells.CS, cfg: *const st.SpellConfig, ti: u8) ?Damage {
        const s = self.c.s;
        const body = engine.unitCells(&s.units[ti]);
        var ring: spells.Cells = .{};
        spells.cellsAroundFootprint(body.slice(), &ring);
        var caught: Slots = .{};
        affectedUnits(s, ring.slice(), &caught);
        var any = false;
        var out: Damage = .{ .value = 0, .kill = 0 };
        for (caught.slice()) |v| {
            if (s.units[v].isDead() or v == self.c.ui or v == ti) continue;
            any = true;
            const d = self.spellDamage(spell, cfg, v);
            if (s.units[v].team != self.unit().team) {
                out.value += d.value;
                if (d.kill != 0) out.kill = 1;
            } else out.value -= d.value;
        }
        return if (any) out else null;
    }

    const Impact = struct { cell: Cell, value: f64, kill: u8, victims: Slots = .{} };

    /// addMeteoriteCastCandidates: every block that can catch an enemy body (Meteor Shower's 3x3 about its centre anchor,
    /// Meteorite's 2x2 up and right of its corner anchor, anchors off every enemy cell, each once) on the board, valued at
    /// the overkill-capped damage it lands on enemies (projectSpellDamageAgainstUnit; a kill flags it); the best block
    /// (first on ties) is the candidate. With the Battle Mage's coverage, Hidden stacks are ignored and every distinct
    /// visible victim list adds its first block after it. Water Shield is not in scope.
    fn addMeteors(self: *Gen, spell: spells.CS, raw: u8, cfg: *const st.SpellConfig) void {
        const s = self.c.s;
        const u = self.unit();
        const raw_damage = spells.rawDamage(u, spell, cfg);
        if (raw_damage <= 0) return;
        const shower = spell == .meteor_shower;
        const spread: []const i32 = if (shower) &.{ -1, 0, 1 } else &.{ 0, 1 };
        const offsets: []const i32 = if (shower) &.{ -1, 0, 1 } else &.{ 0, -1 };
        const preserve = self.opt.meteor_coverage and spell == .meteorite and util.creature(s, self.c.ui) == .battle_mage;
        const opp = engine.opposite(u.team);
        var seen: [st.GRID + 2][st.GRID + 2]bool = .{.{false} ** (st.GRID + 2)} ** (st.GRID + 2);
        var impacts: [64]Impact = undefined;
        var n_impacts: usize = 0;
        var best: ?Impact = null;
        for (s.holderOrder()) |k| {
            if (!util.livingOf(s, k, opp)) continue;
            if (preserve and s.units[k].isHidden()) continue;
            const ec = engine.unitCells(&s.units[k]);
            for (ec.slice()) |cell| for (offsets) |ox| for (offsets) |oy| {
                const anchor = Cell{ .x = cell.x + ox, .y = cell.y + oy };
                const sx: usize = @intCast(anchor.x + 1);
                const sy: usize = @intCast(anchor.y + 1);
                if (seen[sx][sy]) continue;
                seen[sx][sy] = true;
                var cells: spells.Cells = .{};
                var inside = true;
                for (spread) |dx| for (spread) |dy| {
                    const c = Cell{ .x = anchor.x + dx, .y = anchor.y + dy };
                    if (!engine.cellWithinGrid(c)) inside = false;
                    cells.push(c);
                };
                if (!inside) continue;
                var caught: Slots = .{};
                affectedUnits(s, cells.slice(), &caught);
                var impact = Impact{ .cell = anchor, .value = 0, .kill = 0 };
                for (caught.slice()) |v| {
                    const t = &s.units[v];
                    if (t.team == u.team or t.isDead()) continue;
                    if (preserve and t.isHidden()) continue;
                    impact.victims.push(v);
                    const dealt: f64 = if (abilities.absorbsHit(t)) 0 else spells.damageAgainst(raw_damage, cfg.element, t);
                    const hp = util.cumulativeHp(t);
                    impact.value += @min(dealt, hp);
                    if (dealt >= hp) impact.kill = 1;
                }
                if (impact.value <= 0) continue;
                if (best == null or impact.value > best.?.value) best = impact;
                if (preserve) {
                    var dup = false;
                    for (impacts[0..n_impacts]) |*have| {
                        if (std.mem.eql(u8, have.victims.slice(), impact.victims.slice())) dup = true;
                    }
                    if (!dup) {
                        if (n_impacts == impacts.len) {
                            self.out.incomplete = true;
                        } else {
                            impacts[n_impacts] = impact;
                            n_impacts += 1;
                        }
                    }
                }
            };
        }
        const b = best orelse return;
        self.pushSpell(raw, null, b.cell, b.value, b.kill);
        for (impacts[0..n_impacts]) |*impact| {
            if (sameCell(impact.cell, b.cell)) continue;
            self.pushSpell(raw, null, impact.cell, impact.value, impact.kill);
        }
    }

    /// The summon branch of addSpells (Summon Wolves): with a body to summon, the first anchor around the caster that
    /// fits (summonableAnchors), and, with no Wolf of the team on the board yet, the fitting anchor whose whole body lies
    /// ahead of every caster cell and nearest the caster's lane (strictly; side boards read y) when it differs; with no
    /// fitting anchor, an existing Wolf is reinforced by an anchorless cast.
    fn addSummon(self: *Gen, raw: u8, cfg: *const st.SpellConfig) void {
        const s = self.c.s;
        const u = self.unit();
        const amount = @floor(u.amount_alive * cfg.power);
        if (amount <= 0) return;
        const sm = s.summons orelse {
            self.out.incomplete = true;
            return;
        };
        if (!sm.present[st.Summons.WOLF]) {
            self.out.incomplete = true;
            return;
        }
        const fw = sm.units[st.Summons.WOLF].fw;
        const fh = sm.units[st.Summons.WOLF].fh;
        const caster = engine.unitCells(u);
        var ring: spells.Cells = .{};
        spells.cellsAroundFootprint(caster.slice(), &ring);
        var anchors: [96]Cell = undefined;
        var n: usize = 0;
        var tried: [96]Cell = undefined;
        var nt: usize = 0;
        for (0..fw) |dx| for (0..fh) |dy| for (ring.slice()) |r| {
            const a = Cell{ .x = r.x + @as(i32, @intCast(dx)), .y = r.y + @as(i32, @intCast(dy)) };
            var dup = false;
            for (tried[0..nt]) |t| {
                if (sameCell(t, a)) dup = true;
            }
            if (dup) continue;
            if (nt < tried.len) {
                tried[nt] = a;
                nt += 1;
            }
            if (spells.seatFree(s, a, fw, fh) and n < anchors.len) {
                anchors[n] = a;
                n += 1;
            }
        };
        var existing = false;
        for (s.holderOrder()) |k| {
            const w = &s.units[k];
            if (w.summoned and w.name_id == s.summon_name_id[st.Summons.WOLF] and w.team == u.team) existing = true;
        }
        if (n == 0) {
            if (existing) self.pushSpell(raw, null, null, 0, 0);
            return;
        }
        self.pushSpell(raw, null, anchors[0], 0, 0);
        if (existing) return;
        const side = s.fight.side_oriented;
        var lane: f64 = 0;
        for (caster.slice()) |cc| lane += @floatFromInt(if (side) cc.y else cc.x);
        lane /= @floatFromInt(caster.len);
        var forward: ?Cell = null;
        var lane_distance = std.math.inf(f64);
        for (anchors[0..n]) |a| {
            const body = engine.cellsForAnchor(a, fw, fh);
            var ahead = true;
            for (body.slice()) |bc| for (caster.slice()) |from| {
                const delta: i32 = if (side) bc.x - from.x else bc.y - from.y;
                const adv = if (u.team == st.Team.LEFT) delta else -delta;
                if (!(adv > 0)) ahead = false;
            };
            if (!ahead) continue;
            var sum: f64 = 0;
            for (body.slice()) |bc| sum += @floatFromInt(if (side) bc.y else bc.x);
            const distance = @abs(sum / @as(f64, @floatFromInt(body.len)) - lane);
            if (distance < lane_distance) {
                forward = a;
                lane_distance = distance;
            }
        }
        if (forward) |f| {
            if (!sameCell(f, anchors[0])) self.pushSpell(raw, null, f, 0, 0);
        }
    }

    /// addSpells: every usable spell in book order. Mass casts (canMassCastSpell), ally spells over the caster then its
    /// living allies (the Wild Regeneration gift only to an ally it is worth more to: no Wild Regeneration of its own,
    /// more max HP; Holy Cross is not in scope), and enemy spells over the living enemies that are not Hidden, through
    /// canCastSpell and the thrown line; a damage spell is valued (Ring of Fire by its ring, empty rings dropped; no
    /// Last Fuse or Fireball in scope). Summons and cell-targeted spells are not ported yet: the list is incomplete.
    fn addSpells(self: *Gen) void {
        const s = self.c.s;
        const u = self.unit();
        const team = u.team;
        const opp = engine.opposite(team);
        for (u.spells[0..u.n_spells]) |*b| {
            const spell = std.meta.intToEnum(spells.CS, b.spell) catch {
                self.out.incomplete = true;
                continue;
            };
            const cfg = &s.spell_cfg[b.spell];
            if (!cfg.loaded) {
                self.out.incomplete = true;
                continue;
            }
            if (!spells.usable(u, b, cfg)) continue;
            if (spell == .summon_wolves and cfg.target == st.SpellTarget.RANDOM_CLOSE_TO_CASTER) {
                self.addSummon(b.spell, cfg);
                continue;
            }
            switch (cfg.target) {
                st.SpellTarget.FREE_CELL => {
                    if (spell == .meteorite or spell == .meteor_shower) self.addMeteors(spell, b.spell, cfg) else self.out.incomplete = true;
                },
                st.SpellTarget.RANDOM_CLOSE_TO_CASTER, st.SpellTarget.ALLIES_AREA, st.SpellTarget.ENEMY_WITHIN_MOVEMENT_RANGE => self.out.incomplete = true,
                st.SpellTarget.ALL_ALLIES, st.SpellTarget.ALL_ENEMIES, st.SpellTarget.ALL_FLYING => {
                    if (spells.canMassCastSpell(s, self.c.ui, spell, cfg)) self.pushSpell(b.spell, null, null, 0, 0);
                },
                st.SpellTarget.ANY_ALLY => {
                    var order: [st.MAX_UNITS + 1]u8 = undefined;
                    var n: usize = 0;
                    order[0] = self.c.ui;
                    n = 1;
                    for (s.holderOrder()) |k| {
                        if (k != self.c.ui and util.livingOf(s, k, team)) {
                            order[n] = k;
                            n += 1;
                        }
                    }
                    for (order[0..n]) |k| {
                        const a = &s.units[k];
                        if (spell == .wild_regeneration and (a.has(.wild_regeneration) or !(a.max_hp > u.max_hp))) continue;
                        if (spells.canCastSpell(s, self.c.ui, k, spell, cfg)) self.pushSpell(b.spell, k, null, 0, 0);
                    }
                },
                st.SpellTarget.ANY_ENEMY => {
                    for (s.holderOrder()) |k| {
                        if (!util.livingOf(s, k, opp) or s.units[k].isHidden()) continue;
                        if (!spells.canCastSpell(s, self.c.ui, k, spell, cfg)) continue;
                        if (!reachesAimedTarget(s, self.c.ui, k, spell)) continue;
                        if (cfg.multiplier == st.SpellMultiplier.UNIT_AMOUNT_DAMAGE) {
                            const d = if (spell == .ring_of_fire) (self.ringDamage(spell, cfg, k) orelse continue) else self.spellDamage(spell, cfg, k);
                            self.pushSpell(b.spell, k, null, d.value, d.kill);
                        } else self.pushSpell(b.spell, k, null, 0, 0);
                    }
                },
                else => {}, // AUTO and other target types are not cast through cast_spell
            }
        }
    }

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
            if (e.isHidden() or u.cannotAttack(e.uid)) continue; // a Hidden unit or the gazer is no legal shot
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
                    if (s.units[primary].isHidden() or u.cannotAttack(s.units[primary].uid)) continue;
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
            // meleeTargets: not Hidden (Disguise), the forced target only, not the Terrifying Gaze gazer (Cowardice is
            // not in scope).
            if (e.isHidden() or u.cannotAttack(e.uid)) continue;
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
    if (opt.spells_only) {
        g.addSpells();
        if (out.incomplete) util.unsupported = true;
        return;
    }
    g.addWait();
    g.addDefend();
    g.addMelee();
    g.addMountainAttack();
    g.addShots();
    g.addSpells();
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
    // A list this port cannot complete (a class not generated yet, or more than MAX candidates; TypeScript has no cap)
    // makes the decision unsupported: decideV08 refuses it.
    if (out.incomplete) util.unsupported = true;
}

/// The boundary options (enumerateV08BoundaryCandidates without mountain strikes).
pub const BOUNDARY = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true, .meteor_coverage = true };
/// The boundary census without the Battle Mage's Meteorite coverage: repairV07ForbiddenTargetDecision's options and
/// v0.8's support roles' (enumerateSupportCandidates).
pub const REPAIR_V07 = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true };
pub const SUPPORT = REPAIR_V07;
/// enumerateV08BoundaryCandidates with mountain strikes (the cemetery pass).
pub const BOUNDARY_MOUNTAINS = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true, .mountains = true, .meteor_coverage = true };
/// prioritizeV08A13FinishDecision's options.
pub const FINISH = Options{ .max_moves = 1, .max_melee = 8, .max_shots = 6, .enrich = true, .coverage = true };
