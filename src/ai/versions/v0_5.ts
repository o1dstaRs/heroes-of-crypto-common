/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { AbilityPowerType } from "../../abilities/ability_properties";
import type { GameAction } from "../../engine/actions";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { AttackHandler } from "../../handlers/attack_handler";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import { canCastSpell } from "../../spells/spell_helper";
import { getPositionForCell } from "../../grid/grid_math";
import { MAX_HITS_MOUNTAIN } from "../../constants";
import {
    analyzeEngagement,
    auraCoverageScore,
    countMeleeThreatsToCell,
    findMountainMeleeStrike,
    isLineBlockedByObstacle,
    mountainHitsLeft,
    planAuraMove,
    teamRangedFirepower,
} from "../ai";
import type { IDecisionContext, IAIStrategy, IPlacementContext } from "../ai_strategy";
import { otherTeam, STRATEGY_V0_1 } from "./v0_1";
import { StrategyV0_4 } from "./v0_4";
import { loadV05Weights } from "./v0_5_weights";
import { loadPlaceWeights, placeByPolicy } from "./v0_5_placement";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
/** Action types that mean the unit is striking/casting this turn (so a move is a combat reposition, not a free one). */
const COMBAT_ACTIONS = new Set(["melee_attack", "range_attack", "cast_spell", "obstacle_attack", "area_throw_attack"]);
/** Rough single-stack firepower proxy (shots * max hit), matching v0.4's firepowerOf. */
const firepowerOf = (u: Unit): number => Math.max(1, u.getRangeShots()) * Math.max(1, u.getAttackDamageMax());
const isAdjacentCell = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
/** A "Hidden" stack (via Disguise Aura) is UNTARGETABLE — the engine rejects any attack on it
 * (attack_not_available). Check both buff and ability forms so we never select it for a strike. */
const isHidden = (u: Unit): boolean => u.hasBuffActive("Hidden") || u.hasAbilityActive("Hidden");
const cellKey = (c: XY): number => (c.x << 4) | c.y;
// A fragile aura-emitting FLYER (e.g. Pegasus) is worth more keeping its aura on the army than diving in to
// melee for a marginal hit — measured: Pegasus attacked 81% of turns, supporting only ~3%. ON by default.
const auraFlyOn = process.env.V05_AURAFLY !== "off";
// Auras that mainly help the MELEE line: Sharpened Weapons (+melee damage, Crusader) and Wolf Trail / walk
// steps (+movement, Wolf Rider). (Pegasus Might is +attack&armor for ALL incl. ranged -> flyer balance play.)
const MELEE_AURA_TYPES = new Set<number>([
    AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE,
    AbilityPowerType.ADDITIONAL_STEPS,
    AbilityPowerType.ADDITIONAL_STEPS_WALK,
]);
// REFUTED, default OFF: explicitly repositioning these emitters to cover the melee line measured WORSE
// (50.9/51.0% vs 51.4/52.1% on two seeds). They're melee ATTACKERS that already advance with the army, so
// overriding their advance/attack to chase aura coverage costs more than the extra coverage is worth. Kept
// behind V05_AURASUPPORT=on for future refinement (e.g. only when truly sitting behind the line).
const auraSupportOn = process.env.V05_AURASUPPORT === "on";
// Healer spell-choice policy. Battery (forced-Healer vs v0.4) ranked single plays:
//   healL4 56.7/57.0% > base 56.2/56.4% > armor 55.8% > bless 54.6% >> heal-anyone 50.3% (over-healing is bad).
// Default "smart": heal a hurt L4 first; keep any heal of a wounded stack; otherwise BALANCE armour vs
// Blessing — bless a ranged unit whose attack spread is large %-wise (gains most from a forced-max hit),
// else armour the most valuable ally. Modes "armor"|"heal"|"bless"|"healL4"|"base" kept for A/B.
const healPolicy = process.env.V05_HEALPOLICY ?? "smart";
// Minimum RELATIVE attack spread ((max-min)/max) for a ranged unit to be worth Blessing over armour.
const blessRelThresh = Number(process.env.V05_BLESS_REL ?? 0.33);

/**
 * v0.5 — the first REINFORCEMENT-LEARNED AI version.
 *
 * It extends the v0.4 champion unchanged (inheriting every validated builder, footprint/legality guard
 * and human-tactic override) and replaces ONE hand-tuned decision — the ranged shot/target scorer — with
 * a parameterised evaluator whose coefficients are searched by SELF-PLAY. The engine cannot clone/roll
 * back board state, so lookahead/MCTS is impossible; instead the Cross-Entropy Method
 * (src/simulation/optimizer/cem.mjs) plays many games of v0.5(weights) vs a frozen v0.4 and climbs the
 * decisive-win-rate reward toward better weights. The winning vector is baked into v0_5_weights.ts.
 *
 * With the DEFAULT weight vector v0.5 is byte-for-byte v0.4 (same shot scores), so registering it can
 * never regress live play; only a trained vector (or process.env.V05_WEIGHTS during a sim) changes
 * behaviour. scoreShot is the proven seam for this — v0.2 introduced it, v0.3 specialised it for
 * range-focus, and it drives which enemy a shooter aims at (a high-leverage, always-valid decision).
 */
export class StrategyV0_5 extends StrategyV0_4 {
    public override readonly version: string = "v0.5";
    /** Learned coefficients; see V05_WEIGHT_KEYS for the layout. */
    private readonly w: number[];
    public constructor(weights?: number[]) {
        super();
        this.w = weights ?? loadV05Weights();
    }
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        // Placement was never CEM-trained: v0.5 inherits v0.4→v0.3's hand-coded layout, whose flyer "flank
        // wing" is v0.3's self-described weakest bucket — and flyer-heavy mirrors (Griffin/Pegasus/Black
        // Dragon) are exactly where v0.5 loses both seats. Measured: on flyer rosters, v0.1's simple rows beat
        // the wing by +5.1pp (64.4% -> 69.5%) and cut flyer lose-both ~40%, +1.9pp overall, no regression.
        // Mode selector (env for A/B; unset = shipped v0.4/v0.3 layout). NOTE: "rows-for-flyers" (v01/hybrid)
        // wins +2.5pp vs v0.1 but is ~-0.5pp vs v0.4 across seeds — the wing is fine when paired with STRONG
        // per-turn play, so the hand-fix optimizes the wrong target. Placement is instead being made a LEARNED
        // seam trained against the real self-play reward (see the placement CEM). Default stays v0.4 until then.
        const mode = process.env.V05_PLACEMENT ?? "default";
        if (mode === "v01") {
            return STRATEGY_V0_1.placeArmy(units, context);
        }
        if (mode === "default") {
            return super.placeArmy(units, context);
        }
        // "learned": the trainable placement seam — score each unit's cell by a weighted feature sum, anchored
        // to v0.4 so DEFAULT_PLACE_W reproduces it exactly. Injected via V05_PLACE_WEIGHTS for the placement CEM.
        if (mode === "learned") {
            return placeByPolicy(units, context, super.placeArmy(units, context), loadPlaceWeights());
        }
        // flyerMin=1: ANY flyer routes the army to simple rows — measured best (78.6% vs 77.6% at min=2 and
        // 76.3% default at seed 777), i.e. v0.3's wing hurts even with a single flyer. Pure-ground/AoE armies
        // (no flyer) keep v0.4's AoE/tank-aware placement, which adds ~+0.4pp over blanket simple rows.
        const flyerMin = Number(process.env.V05_FLYERMIN ?? 1);
        if (units.filter((u) => u.canFly()).length >= flyerMin) {
            return STRATEGY_V0_1.placeArmy(units, context);
        }
        return super.placeArmy(units, context);
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        // v0.4's full decision (which already used v0.5's learned scoreShot via inheritance), then two learned
        // post-processes: re-rank a melee strike's (target, stand cell), then re-rank a standalone move's
        // destination. They're mutually exclusive (a turn is either a strike or a pure move), and both anchor
        // to v0.4's own pick, so with the default weights v0.5 == v0.4 (a strict, validity-preserving extension).
        const base = this.healerPolicy(unit, context, super.decideTurn(unit, context));
        // A pinned No-Melee shooter (Tsar Cannon) can neither shoot (suppressed by an adjacent enemy) nor
        // melee — and v0.1's fallbackTurn ADVANCES it toward the enemy, deepening the pin. Retreat it to a
        // reachable cell with no adjacent enemy so it can shoot again next lap. A 44-atk cannon left dead.
        const unpinned = this.noMeleeRetreat(unit, context, base);
        // Learned mountain mining: on a BLOCK_CENTER map, let CEM decide whether an otherwise-advancing melee
        // unit should instead move+strike the center block to open the lane (weights [26..32], default 0 = v0.4).
        const mined = this.mineByPolicy(unit, context, unpinned);
        const melee = this.meleeByPolicy(unit, context, mined);
        // Learned AOE-melee positioning: pick a multi-hit unit's stand cell by a weighted sum over the WHOLE
        // hit-set (coverage vs total value vs exposure), not just v0.4's max-enemy-count (weights [33..40],
        // default 0 = v0.4's coverage-max — the current behaviour, kept by meleeByPolicy skipping these units).
        const aoe = this.aoeMeleeByPolicy(unit, context, melee);
        const repos = this.repositionByPolicy(unit, context, aoe);
        // Final safety net: never emit an attack on a Hidden (untargetable) stack — the engine rejects it.
        const safe = this.excludeHiddenAttack(unit, context, repos);
        // A fragile aura-flyer keeps its aura on the army instead of diving for a marginal melee hit.
        const flyer = this.auraFlyerSupport(unit, context, safe);
        // A melee-buff aura emitter (Crusader/Wolf Rider) covers the FRONT melee line, not the backline.
        const auraM = this.meleeAuraSupport(unit, context, flyer);
        // Strategic hourglass: rather than charge FIRST into a reactable trade while enemies still get to
        // react this lap, wait — converting the ~41% first-mover seat into the ~59% second-mover one.
        const waited = this.hourglassByPolicy(unit, context, auraM);
        // Final catch-all: never emit a move whose footprint is occupied (the engine rejects move_blocked).
        const guarded = this.dropBlockedMove(unit, context, waited);
        // Free attack-of-opportunity: if a melee unit's move ENDS adjacent to an attackable enemy, strike it
        // instead of just walking up (it's exposed to that enemy next turn regardless — hitting is strictly
        // better). Fixes the common "unit moved next to the enemy but didn't attack".
        return this.takeAdjacentAttack(unit, context, guarded);
    }
    /**
     * Convert a PURE melee advance that stops next to a live, legally-attackable enemy into a move+strike on
     * that enemy. The base flow commits to one target and, when it can't reach that target this turn, just
     * advances — often ending adjacent to a DIFFERENT enemy it then ignores. Only fires for melee-capable
     * units on a validated move, respects Hidden / Cowardice / forced (Aggr) targets, and reuses the move's
     * own (already-legal) path so the emitted strike is valid by construction.
     */
    /**
     * Anti-pin for No-Melee shooters (Tsar Cannon). When such a unit can't land a shot right now (an adjacent
     * enemy suppresses it) its only base option is v0.1's fallbackTurn, which ADVANCES toward the nearest enemy
     * — the exact wrong move for a unit that has no melee and just needs a clear cell to shoot from. Replace an
     * advancing/holding decision with a retreat to the reachable cell FARTHEST from the enemies that has NO
     * adjacent enemy (so the suppression lifts and it can fire next lap). Only fires for a pure move/end (never
     * overrides a real action), and only when a genuinely-unpinned cell is reachable — else the base stands.
     */
    private noMeleeRetreat(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (unit.getAttackType() !== RANGE || !unit.canMove()) {
            return decision;
        }
        // Not pinned? It can shoot (or already will) — leave the base decision alone.
        if (this.canLandRange(unit, context)) {
            return decision;
        }
        // A pinned shooter can't fire (an adjacent enemy suppresses the shot). Two flavours, gated separately:
        //  - No-Melee (Tsar Cannon): its base turn is a pure advance/hold → retreat to the FARTHEST safe cell.
        //  - Any other shooter (Beholder, Elf, …): its base turn is a weak melee CHARGE (or a move). Rather than
        //    trade 15 dmg in melee or waste the turn, DISENGAGE to the nearest clear cell so it can shoot next
        //    lap — a ranged flyer sitting in melee is the worst option. But KEEP a melee that KILLS the pinner
        //    (that removes the suppression outright), and never override an actual shot/cast.
        const noMelee = unit.hasAbilityActive("No Melee");
        const gateOn = noMelee ? process.env.V05_NOMELEE_RETREAT !== "off" : process.env.V05_RANGED_DISENGAGE !== "off";
        if (!gateOn) {
            return decision;
        }
        // Leave a real ranged/cast action alone; only a melee or a pure move is a disengage candidate.
        if (decision.some((a) => COMBAT_ACTIONS.has(a.type) && a.type !== "melee_attack")) {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const meleeAtk = decision.find((a) => a.type === "melee_attack");
        if (meleeAtk?.type === "melee_attack") {
            const tgt = unitsHolder.getAllUnits().get(meleeAtk.targetId);
            if (
                tgt &&
                this.meleeAttacks(unit) * unit.calculateAttackDamageMax(unit.getAttack(), tgt, false, 0, 1) >=
                    tgt.getCumulativeHp()
            ) {
                return decision; // this melee wipes the pinner — better than disengaging
            }
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        if (!movePath.knownPaths.size) {
            return decision;
        }
        const base = unit.getBaseCell();
        let best: IWeightedRoute | undefined;
        // No-Melee wants max safety (farthest from enemies); a shooter wants the CHEAPEST disengage (least move,
        // to keep shot damage up and stay in the fight) — pick by move cost then distance.
        let bestScore = noMelee ? -Infinity : Infinity;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length || (route.cell.x === base.x && route.cell.y === base.y)) {
                continue;
            }
            const fp = this.footprintForCell(unit, route.cell, context);
            const stillPinned = enemies.some((e) => e.getCells().some((ec) => fp.some((fc) => isAdjacentCell(ec, fc))));
            if (stillPinned) {
                continue; // this cell is also suppressed — no good
            }
            const dist = Math.min(
                ...enemies.map((e) => {
                    const ec = e.getBaseCell();
                    return Math.abs(route.cell.x - ec.x) + Math.abs(route.cell.y - ec.y);
                }),
            );
            const score = noMelee ? dist : -(route.weight ?? route.route.length);
            if (score > bestScore) {
                bestScore = score;
                best = route;
            }
        }
        if (!best) {
            return decision; // fully boxed — nothing better than the base
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.hasLavaCell,
                hasWaterCell: best.hasWaterCell,
            },
        ];
    }
    private takeAdjacentAttack(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (process.env.V05_OPP === "off") {
            return decision; // A/B toggle (default ON)
        }
        if (unit.hasAbilityActive("No Melee")) {
            return decision;
        }
        const atk = unit.getAttackType();
        if (atk !== MELEE && atk !== PBTypes.AttackVals.MELEE_MAGIC) {
            return decision; // ranged/magic units handle their own turn
        }
        if (decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // already striking/casting
        }
        const move = decision.find((a) => a.type === "move_unit");
        // Two salvageable shapes: (a) a PURE MOVE that lands adjacent (charge → strike), or (b) an
        // END_TURN while ALREADY adjacent (pure waste — a melee unit sitting next to an attackable enemy
        // and passing). A wait_turn is left alone: that's the learned reactive hourglass, which acts later.
        const isPureMove = !!move && move.type === "move_unit" && !!move.path?.length;
        const isIdleEnd =
            !move &&
            process.env.V05_OPP_IDLE !== "off" &&
            decision.some((a) => a.type === "end_turn") &&
            !unit.isSkippingThisTurn();
        if (!isPureMove && !isIdleEnd) {
            return decision;
        }
        const base = unit.getBaseCell();
        const dest = isPureMove ? move!.path![move!.path!.length - 1] : { x: base.x, y: base.y };
        const destFp = isPureMove ? this.footprintForCell(unit, dest, context) : unit.getCells();
        const enemyTeam = otherTeam(unit.getTeam());
        const forced = unit.getTarget();
        const cowardlyVs = (e: Unit): boolean =>
            unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp();
        const targets = context.unitsHolder
            .getAllAllies(enemyTeam)
            .filter(
                (e) =>
                    !e.isDead() &&
                    !isHidden(e) &&
                    !cowardlyVs(e) &&
                    (!forced || e.getId() === forced) &&
                    e.getCells().some((ec) => destFp.some((fc) => isAdjacentCell(fc, ec))),
            );
        if (!targets.length) {
            return decision;
        }
        // Prefer a stack we can KILL, else the most dangerous (highest firepower) adjacent enemy.
        const atkMul = this.meleeAttacks(unit);
        const target = targets.sort((a, b) => {
            const kA =
                atkMul * unit.calculateAttackDamageMax(unit.getAttack(), a, false, 0, 1) >= a.getCumulativeHp() ? 1 : 0;
            const kB =
                atkMul * unit.calculateAttackDamageMax(unit.getAttack(), b, false, 0, 1) >= b.getCumulativeHp() ? 1 : 0;
            return kB - kA || firepowerOf(b) - firepowerOf(a);
        })[0];
        const acts: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        acts.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: target.getId(),
            attackFrom: { x: dest.x, y: dest.y },
            path: isPureMove ? move!.path : undefined,
            hasLavaCell: isPureMove ? move!.hasLavaCell : undefined,
            hasWaterCell: isPureMove ? move!.hasWaterCell : undefined,
        });
        return acts;
    }
    /**
     * Strategic hourglass (env-gated A/B; default off). The single biggest un-tapped edge is the second-mover
     * advantage — measured P(win | act second) ≈ 59% vs P(win | act first) ≈ 41%. Hourglass is the only
     * mechanic that converts one into the other: parking a unit (no lap consumed) lets it act LATER in the
     * lap, after the enemy commits. v0.4 never does this strategically, so it's a clean asymmetric edge.
     *
     * Heuristic: when our chosen turn is a melee CHARGE (a strike that required MOVING to reach the target —
     * a forward commit, path present) AND enough enemies are still YET TO ACT this lap (fmExposure ≥ thresh)
     * AND the engine will accept a wait, hourglass instead — let them commit first, then strike on our
     * reactive turn. In-place strikes (already adjacent), shots, moves, casts and waits are left untouched.
     *
     * SHIPPED ON (default). Measured vs v0.4: ~61% → ~68% (+6-7pp, consistent across 5 seeds) — by far the
     * largest single AI gain, and orthogonal to the (plateaued) scoring/placement seams. fm≥0.67 was the best
     * threshold in a sweep (67.4→68.1% as it rises from 0.5). Set V05_HOURGLASS=off to A/B against it.
     */
    private hourglassByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if ((process.env.V05_HOURGLASS ?? "on") !== "on") {
            return decision;
        }
        // A RANGED unit only produces a melee CHARGE when its shot was suppressed (pinned). Hourglassing that
        // fallback is a trap: waiting doesn't lift the suppression, so on the re-up it STILL can't shoot and the
        // charge often can't execute either — the turn is wasted (the client renders it as "<unit> skips turn",
        // e.g. a pinned Beholder). Hourglass is a melee-unit tool; keep shooters out of it (shoot or melee now).
        if (process.env.V05_HG_RANGED !== "off" && unit.getAttackType() === RANGE) {
            return decision;
        }
        const isCharge = decision.some((a) => a.type === "melee_attack" && Array.isArray(a.path) && a.path.length > 0);
        if (!isCharge || !this.canHourglass(unit, context)) {
            return decision;
        }
        const fm = this.fmExposure(unit, context);
        const thresh = Number(process.env.V05_HOURGLASS_FM ?? 0.67);
        if (fm < thresh) {
            return decision;
        }
        return [{ type: "wait_turn", unitId: unit.getId() }];
    }
    /**
     * Learned center-mountain mining (BLOCK_CENTER maps). v0.4 already breaks the block via a fixed
     * heuristic; this ADDS a learned option: when a melee unit would otherwise just ADVANCE, CEM can
     * decide (from map features) that moving to strike the block is the better turn — opening the lane
     * to the enemy over a few laps instead of detouring the army around it. Weights [26..32] default to 0,
     * so untrained v0.5 leaves v0.4's mining untouched; a trained vector converts some advances to strikes.
     * Only PURE advances are candidates (never overrides an attack / existing strike / cast).
     */
    private mineByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const wBias = this.w[26] ?? 0;
        const wInPlace = this.w[27] ?? 0;
        const wClose = this.w[28] ?? 0;
        const wGroup = this.w[29] ?? 0;
        const wOutRange = this.w[30] ?? 0;
        const wLaneBlocked = this.w[31] ?? 0;
        const wProgress = this.w[32] ?? 0;
        if (!wBias && !wInPlace && !wClose && !wGroup && !wOutRange && !wLaneBlocked && !wProgress) {
            return decision; // untrained: exact v0.4 mountain behaviour (its own heuristic still runs in super)
        }
        if (unit.getAttackType() === RANGE || !unit.canMove()) {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const hits = mountainHitsLeft(grid);
        if (hits <= 0) {
            return decision; // not a block map / already cleared
        }
        // Only upgrade a PURE advance — leave real attacks, an existing strike, or a cast alone.
        if (!decision.some((a) => a.type === "move_unit") || decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision;
        }
        const strike = findMountainMeleeStrike(unit, grid, matrix, pathHelper);
        if (!strike) {
            return decision; // can't reach the block this turn
        }
        const base = unit.getBaseCell();
        const inPlace = strike.attackFrom.x === base.x && strike.attackFrom.y === base.y;
        const route = strike.knownPaths.get(cellKey(strike.attackFrom))?.[0];
        const moveCost = inPlace ? 0 : (route?.weight ?? unit.getSteps());
        // Features (normalized). fClose: 1=free in-place, →0=full-move away. fGroup: 1=tightly grouped.
        // fOutRange: +1 we out-range them / -1 they out-range us. fProgress: 0=fresh block →~1 nearly cleared.
        // fLaneBlocked: the block sits on the straight line to the nearest enemy (breaking it truly opens the lane).
        const fClose = Math.max(0, 1 - moveCost / Math.max(1, unit.getSteps()));
        const eng = analyzeEngagement(unit, matrix, unitsHolder);
        const fGroup = Math.max(0, 1 - eng.nearestMeleeAllyDist / 10);
        const enemyTeam = otherTeam(unit.getTeam());
        const fOutRange = Math.sign(
            teamRangedFirepower(unit.getTeam(), unitsHolder) - teamRangedFirepower(enemyTeam, unitsHolder),
        );
        const fProgress = (MAX_HITS_MOUNTAIN - hits) / MAX_HITS_MOUNTAIN;
        let nearestEnemy: XY | undefined;
        let nearestD = Infinity;
        for (const e of unitsHolder.getAllAllies(enemyTeam)) {
            if (e.isDead()) {
                continue;
            }
            const c = e.getBaseCell();
            const d = getDistance(base, c);
            if (d < nearestD) {
                nearestD = d;
                nearestEnemy = c;
            }
        }
        const fLaneBlocked = nearestEnemy && isLineBlockedByObstacle(base, nearestEnemy, matrix) ? 1 : 0;
        const score =
            wBias +
            wInPlace * (inPlace ? 1 : 0) +
            wClose * fClose +
            wGroup * fGroup +
            wOutRange * fOutRange +
            wLaneBlocked * fLaneBlocked +
            wProgress * fProgress;
        if (score <= 0) {
            return decision; // learned: advancing beats mining here
        }
        const gs = grid.getSettings();
        const targetPosition = getPositionForCell(strike.targetCell, gs.getMinX(), gs.getStep(), gs.getHalfStep());
        const path = inPlace ? undefined : route?.route.map((c) => ({ x: c.x, y: c.y }));
        if (!inPlace && !path?.length) {
            return decision; // no usable route to the strike cell
        }
        return [
            {
                type: "obstacle_attack",
                attackerId: unit.getId(),
                targetPosition,
                attackFrom: { x: strike.attackFrom.x, y: strike.attackFrom.y },
                path,
                hasLavaCell: route?.hasLavaCell,
                hasWaterCell: route?.hasWaterCell,
            },
        ];
    }
    /**
     * Learned AOE-melee positioning. v0.4 positions a multi-hit melee unit by MAX enemy-count; this lets CEM
     * instead score each reachable stand cell (and, for directional AOE, the target it aims through) by a
     * weighted sum over the WHOLE hit-set — coverage, total damage value, kills, enemy firepower caught,
     * self-exposure, move cost, wounded — with an incumbency anchor on v0.4's pick. Two weight blocks so the
     * lessons don't cross-contaminate (a Hydra WANTS to be surrounded; a fragile Dragon/Thunderbird does not):
     *   • SPIN [33..40] — all-around, target-independent: Hydra Lightning Spin.
     *   • DIRECTIONAL [41..48] — target/direction-dependent: Black Dragon Fire Breath & Pikeman Skewer (a LINE
     *     through the target) and Thunderbird Chain Lightning (a BFS arc from the target).
     * Dormant (block all-zero) => v0.4's coverage-max stands (meleeByPolicy skips these units).
     */
    private aoeMeleeByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const spin = unit.hasAbilityActive("Lightning Spin");
        const fireBreath = unit.hasAbilityActive("Fire Breath");
        const skewer = unit.hasAbilityActive("Skewer Strike");
        const chain = unit.hasAbilityActive("Chain Lightning");
        const directional = fireBreath || skewer || chain;
        if (!spin && !directional) {
            return decision;
        }
        const off = spin ? 33 : 41;
        const wCov = this.w[off] ?? 0;
        const wVal = this.w[off + 1] ?? 0;
        const wKill = this.w[off + 2] ?? 0;
        const wThreat = this.w[off + 3] ?? 0;
        const wExpo = this.w[off + 4] ?? 0;
        const wCost = this.w[off + 5] ?? 0;
        const wWound = this.w[off + 6] ?? 0;
        const wInc = this.w[off + 7] ?? 0;
        if (!wCov && !wVal && !wKill && !wThreat && !wExpo && !wCost && !wWound && !wInc) {
            return decision; // dormant: keep v0.4's coverage-max positioning
        }
        const strike = decision.find((a) => a.type === "melee_attack");
        if (!strike || strike.type !== "melee_attack" || unit.getTarget() || !unit.canMove()) {
            return decision;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const footprintAt = (cell: XY): XY[] => this.footprintForCell(unit, cell, context);
        const adjEnemies = (cell: XY): Unit[] => {
            const fp = footprintAt(cell);
            return enemies.filter((e) => e.getCells().some((ec) => fp.some((fc) => isAdjacentCell(ec, fc))));
        };
        // Directional hit-sets — mirror v0.4's aoeMeleeReposition (line) and chainLightningTarget (arc).
        const depth = fireBreath ? (unit.isSmallSize() ? 1 : 2) : 1;
        const occupantEnemy = (cell: XY): Unit | undefined => {
            if (cell.x < 0 || cell.y < 0) {
                return undefined;
            }
            const id = grid.getOccupantUnitId(cell);
            const u = id ? unitsHolder.getAllUnits().get(id) : undefined;
            return u && !u.isDead() && u.getTeam() === enemyTeam ? u : undefined;
        };
        const lineHits = (cell: XY, target: Unit): Unit[] => {
            const tc = target.getBaseCell();
            const dx = Math.sign(tc.x - cell.x);
            const dy = Math.sign(tc.y - cell.y);
            const hit = [target];
            const seen = new Set<string>([target.getId()]);
            for (let k = 1; k <= depth; k += 1) {
                const occ = occupantEnemy({ x: tc.x + dx * k, y: tc.y + dy * k });
                if (occ && !seen.has(occ.getId())) {
                    seen.add(occ.getId());
                    hit.push(occ);
                }
            }
            return hit;
        };
        const chainable = enemies.filter((e) => !e.hasAbilityActive("Wind Element") && e.getMagicResist() < 100);
        const chainHits = (target: Unit): Unit[] => {
            const affected = new Map<string, Unit>([[target.getId(), target]]);
            let frontier: Unit[] = [target];
            for (let layer = 0; layer < 4 && frontier.length; layer += 1) {
                const next: Unit[] = [];
                for (const u of frontier) {
                    for (const e of chainable) {
                        if (affected.has(e.getId())) {
                            continue;
                        }
                        if (e.getCells().some((ec) => u.getCells().some((uc) => isAdjacentCell(ec, uc)))) {
                            affected.set(e.getId(), e);
                            next.push(e);
                        }
                    }
                }
                frontier = next;
            }
            return [...affected.values()];
        };
        const movePath = pathHelper.getMovePath(
            unit.getBaseCell(),
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const bc = unit.getBaseCell();
        const v4from = strike.attackFrom ?? bc;
        const v4target = strike.targetId;
        const stands: { cell: XY; route?: IWeightedRoute }[] = [{ cell: bc }];
        for (const routes of movePath.knownPaths.values()) {
            const r = routes[0];
            if (r?.route.length) {
                stands.push({ cell: r.cell, route: r });
            }
        }
        // Enumerate candidates: spin is target-independent (one per cell); directional pairs each stand cell
        // with every enemy adjacent to its footprint (the aim through which the line/arc resolves).
        type Cand = { cell: XY; route?: IWeightedRoute; target: Unit; hitSet: Unit[] };
        const cands: Cand[] = [];
        for (const s of stands) {
            if (spin) {
                const hitSet = adjEnemies(s.cell);
                if (hitSet.length) {
                    cands.push({ cell: s.cell, route: s.route, target: hitSet[0], hitSet });
                }
                continue;
            }
            const fp = footprintAt(s.cell);
            for (const e of enemies) {
                if (!e.getCells().some((ec) => fp.some((fc) => isAdjacentCell(ec, fc)))) {
                    continue;
                }
                cands.push({
                    cell: s.cell,
                    route: s.route,
                    target: e,
                    hitSet: chain ? chainHits(e) : lineHits(s.cell, e),
                });
            }
        }
        if (!cands.length) {
            return decision;
        }
        const dmgMax = Math.max(1, unit.getAttackDamageMax());
        const steps = Math.max(1, unit.getSteps());
        const score = (c: Cand): number => {
            let val = 0;
            let kills = 0;
            let threat = 0;
            let wound = 0;
            for (const e of c.hitSet) {
                const hp = e.getCumulativeHp();
                val += Math.min(dmgMax, hp) / Math.max(1, e.getMaxHp());
                if (dmgMax >= hp) {
                    kills += 1;
                }
                threat += firepowerOf(e) / 1000;
                const total = Math.max(1, e.getAmountAlive() + e.getAmountDied());
                wound += 1 - e.getAmountAlive() / total;
            }
            const expo = countMeleeThreatsToCell(c.cell, matrix, enemyTeam) / 3;
            const cost = c.route ? Math.max(0, 1 - c.route.route.length / steps) : 1;
            const inc =
                c.cell.x === v4from.x && c.cell.y === v4from.y && (spin || c.target.getId() === v4target) ? 1 : 0;
            return (
                wCov * c.hitSet.length +
                wVal * val +
                wKill * kills +
                wThreat * threat +
                wExpo * expo +
                wCost * cost +
                wWound * wound +
                wInc * inc
            );
        };
        let best: Cand | undefined;
        let bestScore = -Infinity;
        for (const c of cands) {
            const s = score(c);
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        // v0.4's pick wins (or nothing better) — keep the original strike (incl. its path).
        if (
            !best ||
            (best.cell.x === v4from.x && best.cell.y === v4from.y && (spin || best.target.getId() === v4target))
        ) {
            return decision;
        }
        const inPlace = best.cell.x === bc.x && best.cell.y === bc.y;
        const actions: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        actions.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: best.target.getId(),
            attackFrom: { x: best.cell.x, y: best.cell.y },
            path: inPlace ? undefined : best.route?.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route?.hasLavaCell,
            hasWaterCell: best.route?.hasWaterCell,
        });
        return actions;
    }
    /**
     * Catch-all validity guard for moves. Some aura-repositioning paths (the inherited withAura, and large
     * flyers like Angel/Pegasus/Griffin) build a move from a reachable ANCHOR whose full footprint can still
     * clip an occupied cell — the engine then rejects it as move_blocked and the turn is wasted. If the final
     * decision carries such a move, drop it and hold instead (hourglass if allowed, else end turn). Measured:
     * eliminates the ~0.013/game move_blocked seen with asymmetric armies (mostly size-2 units).
     */
    private dropBlockedMove(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const mv = decision.find((a) => a.type === "move_unit");
        if (!mv || mv.type !== "move_unit") {
            return decision;
        }
        const fp = mv.targetCells ?? [];
        if (!fp.length) {
            return decision;
        }
        const valid =
            context.grid.areAllCellsEmpty(fp, unit.getId()) ||
            context.grid.canOccupyCells(
                fp,
                unit.hasAbilityActive("Made of Fire"),
                unit.hasAbilityActive("Made of Water"),
            );
        if (valid) {
            return decision;
        }
        return this.canHourglass(unit, context)
            ? [{ type: "wait_turn", unitId: unit.getId() }]
            : [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * First-mover exposure: fraction of LIVING enemies that haven't acted yet this lap. 1 = we commit before
     * any of them react (the disadvantaged "first-mover" seat); 0 = they've all acted and we're reacting.
     * Measured: moving first wins ~41% vs ~59% second — a structural seat edge. The fmExposure-scaled
     * interaction weights let CEM learn to play more conservatively (advance less, avoid reactable trades)
     * exactly when this is high, to claw back some of the first-mover losses. Default weights = no change.
     */
    private fmExposure(unit: Unit, context: IDecisionContext): number {
        const fp = context.fightProperties;
        if (!fp) {
            return 0;
        }
        const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((e) => !e.isDead());
        if (!enemies.length) {
            return 0;
        }
        let yetToAct = 0;
        for (const e of enemies) {
            if (!fp.hasAlreadyMadeTurn(e.getId())) {
                yetToAct += 1;
            }
        }
        return yetToAct / enemies.length;
    }
    /**
     * Melee-line aura support. Crusader (Sharpened Weapons, +melee damage) and Wolf Rider (Wolf Trail, +move)
     * carry auras that only help MELEE allies, so the base "max total coverage" positioning wastes them on
     * the backline. On a pure move (not a strike), reposition this ground emitter to the reachable cell that
     * covers the most MELEE allies, tie-breaking toward the melee centroid — so it advances WITH the front
     * line instead of sitting back with the ranged units. Pegasus (flyer, all-ally aura) is excluded.
     */
    private meleeAuraSupport(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!auraSupportOn || unit.canFly()) {
            return decision;
        }
        const meleeAuras = unit.getAuraEffects().filter((a) => MELEE_AURA_TYPES.has(a.getPowerType()));
        if (!meleeAuras.length || decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // not a melee-aura emitter, or it's striking/casting this turn
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const team = unit.getTeam();
        const enemyTeam = otherTeam(team);
        const meleeAllies = unitsHolder
            .getAllAllies(team)
            .filter((a) => !a.isDead() && a.getId() !== unit.getId() && a.getAttackType() === MELEE);
        if (!meleeAllies.length) {
            return decision; // no melee line to support
        }
        const auraRange = Math.max(...meleeAuras.map((a) => a.getRange()));
        const centroid = {
            x: meleeAllies.reduce((s, a) => s + a.getBaseCell().x, 0) / meleeAllies.length,
            y: meleeAllies.reduce((s, a) => s + a.getBaseCell().y, 0) / meleeAllies.length,
        };
        const cover = (cell: XY): number =>
            meleeAllies.filter((a) => getDistance(cell, a.getBaseCell()) <= auraRange).length;
        const footprintOk = (cell: XY): boolean => {
            const f = this.footprintForCell(unit, cell, context);
            return (
                f.length > 0 &&
                (grid.areAllCellsEmpty(f, unit.getId()) ||
                    grid.canOccupyCells(
                        f,
                        unit.hasAbilityActive("Made of Fire"),
                        unit.hasAbilityActive("Made of Water"),
                    ))
            );
        };
        const base = unit.getBaseCell();
        let best: { cell: XY; route?: IWeightedRoute; cover: number; dist: number } = {
            cell: base,
            cover: cover(base),
            dist: getDistance(base, centroid),
        };
        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        for (const routes of movePath.knownPaths.values()) {
            const route = routes[0];
            if (!route?.route.length || !footprintOk(route.cell)) {
                continue;
            }
            const c = cover(route.cell);
            const d = getDistance(route.cell, centroid);
            // Prefer covering more melee allies; tie-break toward the melee centroid (advance with the line).
            if (c > best.cover || (c === best.cover && d < best.dist)) {
                best = { cell: route.cell, route, cover: c, dist: d };
            }
        }
        if (!best.route || (best.cell.x === base.x && best.cell.y === base.y)) {
            return decision; // already best-positioned for the melee line
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            },
        ];
    }
    /**
     * Experimental Healer spell-choice policy (V05_HEALPOLICY). The base Healer heals a hurt L3-4 stack
     * (>30% lost) else casts Spiritual Armor, and never uses Blessing. This forces a single play so each can
     * be measured head-to-head: "armor" (always armour the top attacker), "heal" (heal anyone hurt), "bless"
     * (max-damage buff the highest-spread attacker), "healL4" (eagerly heal a hurt level-4 stack first, else
     * fall back to the inherited play). "base" (default) leaves v0.4's decision untouched.
     */
    private healerPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (healPolicy === "base" || unit.getName() !== "Healer" || unit.getStackPower() < 1) {
            return decision;
        }
        const { grid, matrix, unitsHolder } = context;
        const gridSettings = grid.getSettings();
        const team = unit.getTeam();
        const allies = unitsHolder.getAllAllies(team).filter((a) => !a.isDead());
        const usable = (name: string) =>
            unit
                .getSpells()
                .find(
                    (s) =>
                        s.getName() === name &&
                        s.getLapsTotal() > 0 &&
                        s.isRemaining() &&
                        s.getMinimalCasterStackPower() <= unit.getStackPower(),
                );
        const canCastOn = (spell: ReturnType<typeof usable>, t: Unit): boolean =>
            !!spell &&
            !!canCastSpell(
                false,
                gridSettings,
                matrix,
                unit,
                t,
                spell,
                t.getBaseCell(),
                t.getMagicResist(),
                t.hasMindAttackResistance(),
                t.canBeHealed(),
                undefined,
            );
        const lostFrac = (a: Unit): number => {
            const cap = a.getMaxHp() * Math.max(1, a.getAmountAlive() + a.getAmountDied());
            return cap > 0 ? 1 - a.getCumulativeHp() / cap : 0;
        };
        const healEligible = (a: Unit): boolean =>
            a.canBeHealed() && a.getMagicResist() !== 100 && a.getHp() < a.getMaxHp();
        const castHeal = (minLost: number, minLevel: number): GameAction[] | undefined => {
            const heal = usable("Heal");
            const t = allies
                .filter((a) => healEligible(a) && a.getLevel() >= minLevel && lostFrac(a) > minLost)
                .sort((p, q) => lostFrac(q) - lostFrac(p))
                .find((a) => canCastOn(heal, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Heal", targetId: t.getId() }]
                : undefined;
        };
        const castArmor = (): GameAction[] | undefined => {
            const armor = usable("Spiritual Armor");
            const t = allies
                .filter((a) => a.getId() !== unit.getId() && !a.hasBuffActive("Spiritual Armor"))
                .sort(
                    (p, q) => q.getAttackDamageMax() * q.getAmountAlive() - p.getAttackDamageMax() * p.getAmountAlive(),
                )
                .find((a) => canCastOn(armor, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Spiritual Armor", targetId: t.getId() }]
                : undefined;
        };
        const castBless = (): GameAction[] | undefined => {
            const bless = usable("Blessing");
            const gain = (a: Unit): number =>
                Math.max(0, a.getAttackDamageMax() - a.getAttackDamageMin()) *
                Math.max(1, a.getAmountAlive()) *
                (a.getAttackType() === RANGE && a.getRangeShots() > 0 ? Math.max(1, a.getRangeShots()) : 1);
            const t = allies
                .filter((a) => a.getId() !== unit.getId() && !a.hasBuffActive("Blessing") && gain(a) > 0)
                .sort((p, q) => gain(q) - gain(p))
                .find((a) => canCastOn(bless, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Blessing", targetId: t.getId() }]
                : undefined;
        };
        // Bless a RANGED unit whose attack spread is large RELATIVE to its max ((max-min)/max) — those gain
        // the most % from a forced-max hit (e.g. Orc 80%, Arbalester 50% vs Cyclops 23%). Among qualifiers,
        // pick the one whose total damage gain (abs spread x stack x shots) is biggest.
        const castBlessRanged = (relThresh: number): GameAction[] | undefined => {
            const bless = usable("Blessing");
            if (!bless) {
                return undefined;
            }
            const relSpread = (a: Unit): number => {
                const mx = a.getAttackDamageMax();
                return mx > 0 ? (mx - a.getAttackDamageMin()) / mx : 0;
            };
            const absGain = (a: Unit): number =>
                (a.getAttackDamageMax() - a.getAttackDamageMin()) *
                Math.max(1, a.getAmountAlive()) *
                Math.max(1, a.getRangeShots());
            const t = allies
                .filter(
                    (a) =>
                        a.getId() !== unit.getId() &&
                        a.getAttackType() === RANGE &&
                        a.getRangeShots() > 0 &&
                        !a.hasBuffActive("Blessing") &&
                        relSpread(a) >= relThresh,
                )
                .sort((p, q) => absGain(q) - absGain(p))
                .find((a) => canCastOn(bless, a));
            return t
                ? [{ type: "cast_spell", casterId: unit.getId(), spellName: "Blessing", targetId: t.getId() }]
                : undefined;
        };
        switch (healPolicy) {
            case "armor":
                return castArmor() ?? decision;
            case "heal":
                return castHeal(0.05, 1) ?? decision;
            case "bless":
                return castBless() ?? decision;
            case "healL4":
                return castHeal(0.2, 4) ?? decision; // eagerly heal a hurt L4, else inherited play
            case "smart": {
                // 1) heal a hurt L4 first; 2) keep any inherited heal (wounded stacks); 3) otherwise bless a
                // high-%-spread ranged unit, else armour the most valuable ally.
                const l4 = castHeal(0.2, 4);
                if (l4) {
                    return l4;
                }
                const inh = decision.find((a) => a.type === "cast_spell");
                if (inh?.type === "cast_spell" && (inh.spellName === "Heal" || inh.spellName === "Mass Heal")) {
                    return decision;
                }
                return castBlessRanged(blessRelThresh) ?? castArmor() ?? decision;
            }
            default:
                return decision;
        }
    }
    /**
     * Keep a fragile aura-emitting FLYER (Pegasus etc.) in its support role. The base AI prefers any
     * available attack over aura positioning — fine for ground bruisers, wrong for a glass-cannon flyer that
     * can reach an enemy almost every turn and so dives in instead of buffing the army (measured 81% attacks,
     * 3% support). When such a flyer's turn is a MARGINAL melee strike (not a guaranteed kill, not a free /
     * retaliation-spent hit) and its aura currently covers allies, reposition for the best coverage instead
     * (planAuraMove), else hold the aura up (hourglass / stay). Kills and free hits are still taken.
     */
    private auraFlyerSupport(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        if (!auraFlyOn || !unit.canFly() || !unit.getAuraEffects().length) {
            return decision;
        }
        const strike = decision.find((a) => a.type === "melee_attack");
        if (!strike || strike.type !== "melee_attack") {
            return decision; // only converts a diving MELEE strike (a flyer shooting from range is fine)
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const target = unitsHolder.getAllUnits().get(strike.targetId);
        if (!target) {
            return decision;
        }
        // A guaranteed kill or a retaliation-free hit is always worth taking, even diving. (Double Punch 2x.)
        const kill =
            this.meleeAttacks(unit) * unit.calculateAttackDamageMin(unit.getAttack(), target, false, 0, 1) >=
            target.getCumulativeHp();
        const retalFree = context.fightProperties?.hasAlreadyRepliedAttack(target.getId()) ?? false;
        if (kill || retalFree) {
            return decision;
        }
        const gridSettings = grid.getSettings();
        const base = unit.getBaseCell();
        // Nothing to protect right now -> just attack as before.
        if (auraCoverageScore(unit, base, gridSettings, unitsHolder) < 1) {
            return decision;
        }
        const enemyTeam = otherTeam(unit.getTeam());
        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        const plan = planAuraMove(unit, movePath.knownPaths, gridSettings, matrix, unitsHolder);
        // 1) A reachable cell covers more allies -> reposition there (stay in support).
        if (
            plan &&
            plan.bestScore > plan.currentScore &&
            unit.canMove() &&
            (plan.bestCell.x !== base.x || plan.bestCell.y !== base.y)
        ) {
            const route = movePath.knownPaths.get(cellKey(plan.bestCell))?.[0];
            if (route?.route.length) {
                return [
                    {
                        type: "move_unit",
                        unitId: unit.getId(),
                        path: route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                        targetCells: this.footprintForCell(unit, plan.bestCell, context),
                        hasLavaCell: route.hasLavaCell,
                        hasWaterCell: route.hasWaterCell,
                    },
                ];
            }
        }
        // 2) Already at the best coverage: hold the aura up rather than dive (hourglass if allowed, else stay).
        if (this.canHourglass(unit, context)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * Guarantee v0.5 never selects a Hidden (Disguise Aura) stack for a strike — the engine refuses such
     * attacks (attack_not_available), wasting the turn. If the chosen melee/range target is Hidden, retarget
     * a melee strike to a legal adjacent non-Hidden enemy; otherwise drop the strike (keep any move, else
     * hold). The base AI already filters Hidden in most paths, so this is a belt-and-suspenders catch-all.
     */
    private excludeHiddenAttack(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const idx = decision.findIndex((a) => a.type === "melee_attack" || a.type === "range_attack");
        if (idx < 0) {
            return decision;
        }
        const atk = decision[idx];
        if (atk.type !== "melee_attack" && atk.type !== "range_attack") {
            return decision;
        }
        const target = context.unitsHolder.getAllUnits().get(atk.targetId);
        if (!target || !isHidden(target)) {
            return decision; // targeting a normal stack — fine
        }
        // Melee: retarget to a legal in-place non-Hidden enemy if one is adjacent now.
        if (atk.type === "melee_attack") {
            const enemyTeam = otherTeam(unit.getTeam());
            const myCells = unit.getCells();
            const alt = context.unitsHolder
                .getAllAllies(enemyTeam)
                .find(
                    (e) =>
                        !e.isDead() &&
                        !isHidden(e) &&
                        !(unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp()) &&
                        e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(mc, ec))),
                );
            if (alt) {
                const acts: GameAction[] = [];
                if (unit.getAttackTypeSelection() !== MELEE) {
                    acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
                }
                acts.push({
                    type: "melee_attack",
                    attackerId: unit.getId(),
                    targetId: alt.getId(),
                    attackFrom: { ...unit.getBaseCell() },
                });
                return acts;
            }
        }
        // No legal retarget (or a Hidden ranged shot): drop the strike, keep any non-attack action, else hold.
        const rest = decision.filter((a, i) => i !== idx && a.type !== "select_attack_type");
        if (rest.some((a) => a.type === "move_unit")) {
            return rest;
        }
        return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * Stage-4 learned melee. When this turn lands a melee strike, re-pick WHICH enemy to hit and FROM WHICH
     * cell among the legal options — in-place-adjacent enemies and reachable cells adjacent to an enemy — by
     * a learned score (damage / focus-kill / free-hit-if-retaliation-spent / target firepower / don't-
     * overextend) anchored to v0.4's own pick. Candidates are footprint-guarded and adjacency-checked, so
     * every emitted strike (and any move into it) is valid by construction. Forced targets (Aggr/taunt) and
     * the default weights both keep v0.4's exact strike.
     */
    private meleeByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const strike = decision.find((a) => a.type === "melee_attack");
        if (!strike || strike.type !== "melee_attack" || unit.getTarget()) {
            return decision; // not a melee strike, or a forced target we may not retarget
        }
        // Multi-hit melee — Hydra (Lightning Spin), Black Dragon (Fire Breath), Pikeman (Skewer Strike) and
        // Thunderbird (Chain Lightning) — is positioned for COVERAGE (most enemies caught in one blow), by v0.4
        // when the AOE block is dormant or by aoeMeleeByPolicy when trained. The single-target re-rank below
        // optimises raw damage on ONE victim and would trade that coverage away, so leave these units to the
        // AOE positioner. (Measured: keeps Hydra's avg enemies/spin at ~2.34 instead of drifting to ~2.26.)
        if (
            unit.hasAbilityActive("Lightning Spin") ||
            unit.hasAbilityActive("Fire Breath") ||
            unit.hasAbilityActive("Skewer Strike") ||
            unit.hasAbilityActive("Chain Lightning")
        ) {
            return decision;
        }
        const [
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            wDmg,
            wKill,
            wRetal,
            wThreat,
            wStand,
            wIncumbent,
            wRetalCost,
            wFocus,
            wStandSupport,
            wTargetWounded,
        ] = this.w;
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const base = unit.getBaseCell();
        const myCells = unit.getCells();
        const myAllies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        const fp = context.fightProperties;
        const v4target = strike.targetId;
        const v4from = strike.attackFrom ?? base;
        const cowardlyVs = (e: Unit): boolean =>
            unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp();
        const enemies = unitsHolder
            .getAllAllies(enemyTeam)
            .filter((e) => !e.isDead() && !isHidden(e) && !cowardlyVs(e));
        if (!enemies.length) {
            return decision;
        }
        const footprintOk = (cell: XY): boolean => {
            const f = this.footprintForCell(unit, cell, context);
            return (
                f.length > 0 &&
                (grid.areAllCellsEmpty(f, unit.getId()) ||
                    grid.canOccupyCells(
                        f,
                        unit.hasAbilityActive("Made of Fire"),
                        unit.hasAbilityActive("Made of Water"),
                    ))
            );
        };
        const adjacentFrom = (cell: XY, e: Unit): boolean => {
            const f = this.footprintForCell(unit, cell, context);
            return f.some((mc) => e.getCells().some((ec) => isAdjacentCell(mc, ec)));
        };

        type Cand = { target: Unit; cell: XY; route?: IWeightedRoute };
        const cands: Cand[] = [];
        // ANCHOR: v0.4's own (target, stand cell) is always a candidate, so the meleeIncumbent weight can
        // make it win (default behaviour). Without this, a tie at 0 could deviate from v0.4 even at default.
        const v4targetUnit = unitsHolder.getAllUnits().get(v4target);
        if (v4targetUnit && !v4targetUnit.isDead() && !isHidden(v4targetUnit)) {
            cands.push({ target: v4targetUnit, cell: v4from });
        }
        // In-place strikes: any enemy already adjacent to the unit's current footprint.
        for (const e of enemies) {
            if (e.getCells().some((ec) => myCells.some((mc) => isAdjacentCell(mc, ec)))) {
                cands.push({ target: e, cell: base });
            }
        }
        // Move-and-strike: reachable cells whose footprint sits adjacent to an enemy (skip if can't move).
        if (unit.canMove()) {
            const movePath = pathHelper.getMovePath(
                base,
                matrix,
                unit.getSteps(),
                grid.getAggrMatrixByTeam(enemyTeam),
                unit.canFly(),
                unit.isSmallSize(),
                unit.canTraverseLava(),
            );
            for (const routes of movePath.knownPaths.values()) {
                const route = routes[0];
                if (!route?.route.length || !footprintOk(route.cell)) {
                    continue;
                }
                for (const e of enemies) {
                    if (adjacentFrom(route.cell, e)) {
                        cands.push({ target: e, cell: route.cell, route });
                    }
                }
            }
        }
        if (!cands.length) {
            return decision;
        }
        const myHp = Math.max(1, unit.getCumulativeHp());
        // First-mover mitigation: when most enemies haven't acted yet (we commit before they react), avoid
        // reactable trades more strongly. wRetalCostFM scales the retaliation cost by that exposure.
        const fm = this.fmExposure(unit, context);
        const wRetalCostFM = this.w[25] ?? 0;
        // Two "hidden gem" features (default weights 0 => no change to the trained melee policy):
        // [49] War Anger Aura (Valkyrie) — +power% melee damage per ENEMY within aura range AT ATTACK TIME, so
        //      the unit wants a stand cell that puts MANY enemies in range (Hydra's surround lesson, for a
        //      single-target flyer). Count living enemies within the aura range of the candidate footprint.
        // [50] Punish-melee — the target reflects/debuffs melee attackers (Efreet Fire Shield, Goblin Knight
        //      Dulling Defense); trading into it costs beyond the normal counter, so avoid it (weight learns -).
        const wWarAnger = this.w[49] ?? 0;
        const wPunishMelee = this.w[50] ?? 0;
        // [51] target-caster: enemy Healers / spell-casters (Ogre Mage, Satyr, Behemoth, Troll, Angel…) are
        // force multipliers whose value isn't captured by raw firepower — bias melee toward removing them.
        const wMeleeCaster = this.w[51] ?? 0;
        const waAura = unit.getAuraEffects().find((a) => a.getName() === "War Anger");
        const waRange = waAura ? waAura.getRange() : 0;
        const livingEnemies = waRange > 0 ? unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead()) : [];
        const warAngerCount = (cell: XY): number => {
            if (waRange <= 0) {
                return 0;
            }
            const f = this.footprintForCell(unit, cell, context);
            return livingEnemies.filter((e) =>
                e
                    .getCells()
                    .some((ec) => f.some((fc) => Math.max(Math.abs(ec.x - fc.x), Math.abs(ec.y - fc.y)) <= waRange)),
            ).length;
        };
        const atkMul = this.meleeAttacks(unit);
        const score = (c: Cand): number => {
            const min = atkMul * unit.calculateAttackDamageMin(unit.getAttack(), c.target, false, 0, 1);
            const max = atkMul * unit.calculateAttackDamageMax(unit.getAttack(), c.target, false, 0, 1);
            const hp = c.target.getCumulativeHp();
            const effective = Math.min((min + max) / 2, hp);
            const dmg = effective / Math.max(1, c.target.getMaxHp());
            const kill = effective >= hp ? 1 : 0;
            const replied = fp?.hasAlreadyRepliedAttack(c.target.getId()) ?? false;
            const retalFree = replied ? 1 : 0;
            const threat = firepowerOf(c.target) / 1000;
            const standThreat = countMeleeThreatsToCell(c.cell, matrix, enemyTeam) / 3;
            const incumbent = c.target.getId() === v4target && c.cell.x === v4from.x && c.cell.y === v4from.y ? 1 : 0;
            // Focus-fire: how many of OUR other stacks are already adjacent to this target (so the army can
            // wipe it together). Concentrating melee on an already-engaged stack finishes it faster.
            const focusFire =
                myAllies.filter((a) =>
                    a.getCells().some((ac) => c.target.getCells().some((tc) => isAdjacentCell(ac, tc))),
                ).length / 2;
            // Expected retaliation damage taken (as a fraction of our HP) — 0 if this strike kills the stack
            // or the target already retaliated this lap. The core favorable-trade signal: avoid striking a
            // hard-hitting survivor. Weight is learned (expected negative).
            const counter =
                kill || replied
                    ? 0
                    : Math.min(
                          (c.target.calculateAttackDamageMin(c.target.getAttack(), unit, false, 0, 1) +
                              c.target.calculateAttackDamageMax(c.target.getAttack(), unit, false, 0, 1)) /
                              2,
                          myHp,
                      ) / myHp;
            // Stand-support: how many of OUR stacks sit adjacent to the stand cell (screen/protect us there).
            const fpCells = this.footprintForCell(unit, c.cell, context);
            const standSupport =
                myAllies.filter((a) => a.getCells().some((ac) => fpCells.some((fc) => isAdjacentCell(ac, fc)))).length /
                2;
            // Target-wounded: fraction of the target stack already dead — finishing a nearly-dead stack removes
            // a whole unit from the board (worth more than chip damage on a fresh one).
            const tDead = c.target.getAmountDied();
            const tAlive = c.target.getAmountAlive();
            const targetWounded = tDead + tAlive > 0 ? tDead / (tDead + tAlive) : 0;
            const warAnger = warAngerCount(c.cell);
            const punishMelee =
                !kill && (c.target.hasAbilityActive("Fire Shield") || c.target.hasAbilityActive("Dulling Defense"))
                    ? 1
                    : 0;
            const targetCaster = c.target.getCanCastSpells() ? 1 : 0;
            return (
                wDmg * dmg +
                wKill * kill +
                wRetal * retalFree +
                wThreat * threat +
                wStand * standThreat +
                wIncumbent * incumbent +
                wRetalCost * counter +
                wFocus * focusFire +
                wStandSupport * standSupport +
                wTargetWounded * targetWounded +
                wRetalCostFM * counter * fm +
                wWarAnger * warAnger +
                wPunishMelee * punishMelee +
                wMeleeCaster * targetCaster
            );
        };
        let best: Cand | undefined;
        let bestScore = -Infinity;
        for (const c of cands) {
            const s = score(c);
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        // Policy agrees with v0.4 (or nothing better) -> keep v0.4's exact strike (incl. any move it built).
        if (!best || (best.target.getId() === v4target && best.cell.x === v4from.x && best.cell.y === v4from.y)) {
            return decision;
        }
        const acts: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== MELEE) {
            acts.push({ type: "select_attack_type", unitId: unit.getId(), attackType: MELEE });
        }
        // Emit the move+strike as a SEPARATE move_unit + in-place melee_attack: the standalone move applies
        // the full move handler (measured ~+2.5pp over folding the move into a path-bearing melee_attack). The
        // ranked client folds this pair back into one move+attack for its transport (AIController).
        if (best.route && (best.cell.x !== base.x || best.cell.y !== base.y)) {
            acts.push({
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            });
        }
        acts.push({
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: best.target.getId(),
            attackFrom: { ...best.cell },
        });
        return acts;
    }
    /**
     * Stage-2 learned positioning. When this turn is a pure reposition (a single move_unit, no strike or
     * cast), re-pick the destination among the engine's reachable cells by a learned linear score over
     * cell features (advance toward the enemy, cohesion with allies, lava/water hazard, and an incumbency
     * bias toward v0.4's own pick). Candidates come straight from pathHelper.getMovePath — exactly the set
     * v0.3 moves within — so every emitted move is valid by construction (no new engine rejections). With
     * the default weights v0.4's destination always wins, so untrained v0.5 == v0.4.
     */
    private repositionByPolicy(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] {
        const move = decision.find((a) => a.type === "move_unit");
        if (!move || move.type !== "move_unit") {
            return decision; // not a move turn
        }
        if (decision.some((a) => COMBAT_ACTIONS.has(a.type))) {
            return decision; // move is part of a strike/cast — leave the (target-constrained) stand cell alone
        }
        const [, , , , , , wAdvance, wCohesion, wHazard, wIncumbent, wThreat, wAggrZone, wShoot, wAura] = this.w;
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return decision;
        }
        const base = unit.getBaseCell();
        const dest = move.path.length ? move.path[move.path.length - 1] : base; // v0.4's chosen anchor cell
        const allies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        const centroid = allies.length
            ? {
                  x: allies.reduce((s, a) => s + a.getBaseCell().x, 0) / allies.length,
                  y: allies.reduce((s, a) => s + a.getBaseCell().y, 0) / allies.length,
              }
            : base;
        const steps = Math.max(1, unit.getSteps());
        const minEnemyDist = (c: XY): number => Math.min(...enemies.map((e) => getDistance(c, e.getBaseCell())));
        const baseEnemyDist = minEnemyDist(base);
        const baseCentroidDist = getDistance(base, centroid);
        // Per-unit constants for the shoot-readiness feature: a shooter with ammo wants a cell within its
        // shot distance of an enemy but NOT boxed in melee (dist >= 2).
        const isShooter = unit.getAttackType() === RANGE && unit.getRangeShots() > 0;
        const shotDist = unit.getRangeShotDistance();
        const gridSettings = grid.getSettings();
        // First-mover mitigation: when committing before the enemy reacts (high fmExposure), let CEM dial back
        // the advance (don't over-extend into a reactable position). wAdvanceFM modulates advance by exposure.
        const fm = this.fmExposure(unit, context);
        const wAdvanceFM = this.w[24] ?? 0;
        const score = (cell: XY, route: IWeightedRoute): number => {
            const advance = (baseEnemyDist - minEnemyDist(cell)) / steps; // + => closer to the enemy
            const cohesion = (baseCentroidDist - getDistance(cell, centroid)) / steps; // + => toward allies
            const hazard = route.hasLavaCell || route.hasWaterCell ? 1 : 0;
            const incumbent = cell.x === dest.x && cell.y === dest.y ? 1 : 0;
            // Richer (stage-3) features — what v0.4's hand-tuned positioning can't express directly.
            const threat = countMeleeThreatsToCell(cell, matrix, enemyTeam) / 3; // enemy melee that can reach this cell
            const aggrZone = route.firstAggrMet ? 1 : 0; // route steps into the enemy threat zone
            const ed = minEnemyDist(cell);
            const shootReady = isShooter && ed >= 2 && ed <= shotDist ? 1 : 0; // can likely fire from here
            const aura = auraCoverageScore(unit, cell, gridSettings, unitsHolder) / 4; // aura emitters cover more allies
            return (
                wAdvance * advance +
                wCohesion * cohesion +
                wHazard * hazard +
                wIncumbent * incumbent +
                wThreat * threat +
                wAggrZone * aggrZone +
                wShoot * shootReady +
                wAura * aura +
                wAdvanceFM * advance * fm
            );
        };

        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.canTraverseLava(),
        );
        // A candidate's full footprint must be occupiable — getMovePath keys on the anchor, but a large
        // unit's footprint can still clip an occupied cell. Mirror v0.4's moveIsBlocked guard exactly so we
        // never emit a move the engine would reject (validity by construction == 0 added rejections).
        const footprintOk = (cell: XY): boolean => {
            const fp = this.footprintForCell(unit, cell, context);
            return (
                fp.length > 0 &&
                (grid.areAllCellsEmpty(fp, unit.getId()) ||
                    grid.canOccupyCells(
                        fp,
                        unit.hasAbilityActive("Made of Fire"),
                        unit.hasAbilityActive("Made of Water"),
                    ))
            );
        };
        let best: { cell: XY; route: IWeightedRoute } | undefined;
        let bestScore = -Infinity;
        for (const routes of movePath.knownPaths.values()) {
            const route = routes[0];
            if (!route?.route.length) {
                continue;
            }
            const s = score(route.cell, route);
            if (s > bestScore && footprintOk(route.cell)) {
                bestScore = s;
                best = { cell: route.cell, route };
            }
        }
        // No better-or-equal alternative, or the policy agrees with v0.4's pick -> keep v0.4's decision verbatim.
        if (!best || (best.cell.x === dest.x && best.cell.y === dest.y)) {
            return decision;
        }
        return [
            {
                type: "move_unit",
                unitId: unit.getId(),
                path: best.route.route.map((c: XY) => ({ x: c.x, y: c.y })),
                targetCells: this.footprintForCell(unit, best.cell, context),
                hasLavaCell: best.route.hasLavaCell,
                hasWaterCell: best.route.hasWaterCell,
            },
        ];
    }
    /**
     * Learned shot scorer. Sums a weighted feature vector over every unit a candidate shot hits — enemies
     * add value, our own units (AOE splash) subtract. The default weights reproduce v0.4's "2x range,
     * pure-damage" scoring exactly; the trained weights additionally bias toward finishing a stack
     * (shotKill), silencing high-firepower shooters (shotFirepower) and higher-tier targets (shotLevel).
     * hitsEnemyRange is reported whenever a shot touches any enemy RANGE unit, independent of the weights,
     * so the inherited hourglass/hold logic is unaffected.
     */
    /**
     * Melee attacks a unit lands in one turn: 2 for Double Punch (Crusader/Wolf/Berserker land a second hit
     * at 100% — double_punch_ability.ts), else 1. The MELEE twin of the Double Shot handling in scoreShot;
     * without it the AI values these units at ~half and misses 2-hit kills in target selection / stand scoring.
     */
    private meleeAttacks(unit: Unit): number {
        return process.env.V05_DBLPUNCH !== "off" && unit.hasAbilityActive("Double Punch") ? 2 : 1;
    }
    protected override scoreShot(
        unit: Unit,
        evaluation: ReturnType<AttackHandler["evaluateRangeAttack"]>,
        fromTeam: number,
        enemyTeam: number,
        context: IDecisionContext,
    ): { value: number; hitsEnemyRange: boolean } {
        const [wDamage, wKill, wRange, wFirepower, wLevel, wFriendlyFire] = this.w;
        // [52] target-caster: silencing an enemy Healer / spell-caster is worth more than its raw firepower.
        const wShotCaster = this.w[52] ?? 0;
        // [53..55] NEW shot features (anchored at 0 -> no change until CEM trains them). Mirror the melee
        // scorer's proven signals onto the (previously thin) shot scorer:
        //   [53] shotFocusFire — allies already adjacent to the target: concentrate fire to finish it faster.
        //   [54] shotTempo     — the target HAS NOT acted this lap: killing it DENIES its turn (the second-mover
        //                        edge that made hourglass the biggest win). Full credit on a kill, partial on chip.
        //   [55] shotWounded   — fraction of the stack already dead: finishing a near-dead stack removes a whole unit.
        const wShotFocus = this.w[53] ?? 0;
        const wShotTempo = this.w[54] ?? 0;
        const wShotWounded = this.w[55] ?? 0;
        const fp = context.fightProperties;
        const myAllies =
            wShotFocus !== 0
                ? context.unitsHolder.getAllAllies(fromTeam).filter((a) => !a.isDead() && a.getId() !== unit.getId())
                : [];
        let value = 0;
        let hitsEnemyRange = false;
        // Double Shot (Gargantuan) lands a SECOND full shot — target + its whole AOE splash — at 100%
        // (double_shot_ability.ts). Model that so the scorer values the shot at its true ~2x output and,
        // crucially, so the kill bonus fires on a stack we can only wipe WITH both shots (single-shot damage
        // alone reads as "can't kill"). Applies to the friendly-fire cost too (the 2nd shot re-hits allies).
        const shots = process.env.V05_DBLSHOT !== "off" && unit.hasAbilityActive("Double Shot") ? 2 : 1;
        const counted = new Set<string>();
        for (let i = 0; i < evaluation.affectedUnits.length; i += 1) {
            const divisor = evaluation.rangeAttackDivisors[i] ?? 1;
            for (const target of evaluation.affectedUnits[i]) {
                if (counted.has(target.getId())) {
                    continue;
                }
                counted.add(target.getId());
                const min = unit.calculateAttackDamageMin(unit.getAttack(), target, true, 0, divisor);
                const max = unit.calculateAttackDamageMax(unit.getAttack(), target, true, 0, divisor);
                const targetHp = target.getCumulativeHp();
                const effective = Math.min((shots * (min + max)) / 2, targetHp);
                if (target.getTeam() === enemyTeam) {
                    value += wDamage * effective;
                    if (effective >= targetHp) {
                        value += wKill * targetHp; // this shot wipes the whole stack
                    }
                    if (target.getAttackType() === RANGE) {
                        value += wRange * effective; // silence their shooters
                        hitsEnemyRange = true;
                    }
                    value += wFirepower * (firepowerOf(target) / 1000);
                    value += wLevel * target.getLevel();
                    if (target.getCanCastSpells()) {
                        value += wShotCaster; // silence their Healer / caster
                    }
                    if (wShotFocus !== 0) {
                        const focus =
                            myAllies.filter((a) =>
                                a.getCells().some((ac) => target.getCells().some((tc) => isAdjacentCell(ac, tc))),
                            ).length / 2;
                        value += wShotFocus * focus; // concentrate fire on an already-engaged stack
                    }
                    if (wShotTempo !== 0 && fp && !fp.hasAlreadyMadeTurn(target.getId())) {
                        // deny the target's turn — full credit on a kill, scaled by damage fraction on chip
                        value += wShotTempo * (effective >= targetHp ? 1 : effective / targetHp);
                    }
                    if (wShotWounded !== 0) {
                        const died = target.getAmountDied();
                        const alive = target.getAmountAlive();
                        value += wShotWounded * (died + alive > 0 ? died / (died + alive) : 0);
                    }
                } else if (target.getTeam() === fromTeam) {
                    value -= wFriendlyFire * effective; // friendly fire (AOE splash) is a cost
                }
            }
        }
        return { value, hitsEnemyRange };
    }
}

export const STRATEGY_V0_5: IAIStrategy = new StrategyV0_5();
