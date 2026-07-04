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

import type { GameAction } from "../../engine/actions";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { AttackHandler } from "../../handlers/attack_handler";
import type { Unit } from "../../units/unit";
import { GRID_SIZE } from "../../grid/grid_constants";
import { getDistance, type XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { StrategyV0_2 } from "./v0_2";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const placeCellKey = (cell: XY): number => (cell.x << 4) | cell.y;
const isAdjacent = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
// How much more a point of damage on an enemy RANGE unit is worth than the same damage on a melee
// unit. Winning the ranged-attrition race flips firepower superiority our way; from there we hold a
// grouped position and out-shoot, while the now ranged-inferior enemy must walk onto our shots.
const ENEMY_RANGE_DAMAGE_WEIGHT = 2.0;
// How far a melee unit must drift from its allies' centroid before we treat it as a detached straggler
// and redirect it to rejoin the pack rather than charge the enemy alone (avoids piecemeal engagement).
const STRAGGLER_DIST = 3.0;

// Beholder's "Spit Ball" debuffs. A ranged hit stacks every one the target does NOT already have
// (Rangebane only lands on range targets), so a target lacking more of these is a richer opportunity.
const SPIT_BALL_DEBUFFS = ["Sadness", "Quagmire", "Weakening Beam", "Weakness", "Cowardice"] as const;
const SPIT_BALL_RANGE_ONLY_DEBUFF = "Rangebane";
// Debuff bias expressed as a fraction of the shot's damage, so raw damage stays the primary driver.
const BEHOLDER_FRESH_WEIGHT = 0.35; // up to +35% of damage for an all-fresh target
const BEHOLDER_YET_TO_ACT_MULT = 1.8; // the debuff will degrade a turn the target hasn't taken yet
const BEHOLDER_THREAT_MULT = 1.3; // ...and that turn would actually hit us

/**
 * v0.3 — continues from v0.2 (inherits placement, best-shot, out-of-ammo, aura, spell-casting).
 *
 * Change #1 — focus-fire the enemy's shooters: when choosing which visible edge to fire at, v0.2 picks
 * purely by expected effective damage, treating every enemy the same. v0.3 instead values damage dealt
 * to enemy RANGE units more highly. Killing their shooters first wins the ranged-attrition race — once
 * our remaining firepower out-guns theirs, the ranged-inferior side has no way to win at range and must
 * close the distance onto our shots, while we hold a strong grouped position and keep firing. This is a
 * FOCUSED weighting (enemy-range only), not the generic threat/finish weighting v0.2 tried and dropped.
 *
 * Tried and dropped (no measurable gain over v0.2): late-game "anti-kite" forced-melee (the late-game
 * shufflers genuinely can't reach an enemy to strike, so forcing aggression is a no-op).
 */
export class StrategyV0_3 extends StrategyV0_2 {
    public override readonly version: string = "v0.3";
    /**
     * Change #2 — don't waste a shooter in melee. v0.2 sends any ranged unit that can't land a shot
     * into melee. But a shooter that still has AMMO and is merely boxed in is better off RETREATING
     * behind its own melee line (whose aggro screens it) and trying to shoot next turn — keeping the
     * far more valuable ranged attack alive. Melee is only right when it can't be helped or clearly
     * pays: a "Handyman" unit (no melee penalty), a target that already used its retaliation this lap
     * (no counter), or a lethal blow. Out-of-ammo units still melee (v0.2 behaviour) — they have no
     * shot to wait for. Everything else defers to v0.2.
     */
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        if (
            unit.getAttackType() === RANGE &&
            unit.getRangeShots() > 0 && // still has a shot worth preserving for next turn
            unit.canMove() &&
            !unit.hasAbilityActive("No Melee") &&
            !unit.hasAbilityActive("Handyman") && // Handyman shooters melee without penalty
            !this.canLandRange(unit, context) && // ...but it can't shoot right now (boxed in)
            !this.meleeIsClearlyRight(unit, context)
        ) {
            const retreat = this.rangedRetreat(unit, context);
            if (retreat) {
                return retreat;
            }
        }
        const decision = super.decideTurn(unit, context);
        // Army cohesion: a melee straggler that would otherwise plod toward the enemy alone is redirected to
        // rejoin the pack, so we engage as a block instead of feeding the brawl one stack at a time.
        if (unit.getAttackType() === MELEE && unit.canMove() && this.shouldCohere(unit, context)) {
            const rejoin = this.cohesionAdvance(unit, context, decision);
            if (rejoin) {
                return rejoin;
            }
        }
        return decision;
    }
    /** Whether melee cohesion (rejoin-the-pack) applies this turn. Always on for v0.3; subclasses may suppress it. */
    protected shouldCohere(_unit: Unit, _context: IDecisionContext): boolean {
        return true;
    }
    /**
     * If v0.2's decision for this melee unit is a PURE move (no attack/cast available this turn) and the unit
     * is a detached straggler - meaningfully far from the centroid of its living allies - steer it toward the
     * pack instead of toward the enemy. Arriving together lets us focus-fire and trade well; arriving piecemeal
     * is how brawls are lost. Conservative: stragglers only, only when no strike was on offer, valid moves only
     * (drawn from getMovePath, so the engine never rejects). Undefined -> keep v0.2's move.
     */
    private cohesionAdvance(unit: Unit, context: IDecisionContext, decision: GameAction[]): GameAction[] | undefined {
        if (!decision.length || decision.some((a) => a.type !== "move_unit")) {
            return undefined; // a strike/cast was available - don't touch it
        }
        const move = decision.find((a) => a.type === "move_unit");
        if (!move || move.type !== "move_unit") {
            return undefined;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const allies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId());
        if (allies.length < 2) {
            return undefined; // nothing to rally to
        }
        const centroid = {
            x: allies.reduce((sum, a) => sum + a.getBaseCell().x, 0) / allies.length,
            y: allies.reduce((sum, a) => sum + a.getBaseCell().y, 0) / allies.length,
        };
        const base = unit.getBaseCell();
        if (getDistance(base, centroid) < STRAGGLER_DIST) {
            return undefined; // already with the pack
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
        let bestCell = base;
        let bestRoute: IWeightedRoute | undefined;
        let bestDist = getDistance(base, centroid);
        for (const routes of movePath.knownPaths.values()) {
            const route = routes[0];
            if (!route?.route.length) {
                continue;
            }
            const dist = getDistance(route.cell, centroid);
            if (dist < bestDist) {
                bestDist = dist;
                bestCell = route.cell;
                bestRoute = route;
            }
        }
        if (bestRoute && (bestCell.x !== base.x || bestCell.y !== base.y)) {
            return [
                {
                    type: "move_unit",
                    unitId: unit.getId(),
                    path: bestRoute.route.map((c: XY) => ({ x: c.x, y: c.y })),
                    targetCells: this.footprintForCell(unit, bestCell, context),
                    hasLavaCell: bestRoute.hasLavaCell,
                    hasWaterCell: bestRoute.hasWaterCell,
                },
            ];
        }
        return undefined;
    }
    /** Melee for a boxed-in shooter only pays when it's free or decisive: a safe-to-hit or lethal target. */
    private meleeIsClearlyRight(unit: Unit, context: IDecisionContext): boolean {
        const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((e) => !e.isDead());
        const myCells = unit.getCells();
        const fp = FightStateManager.getInstance().getFightProperties();
        for (const e of enemies) {
            if (!e.getCells().some((ec) => myCells.some((uc) => isAdjacent(ec, uc)))) {
                continue; // only in-place strikes — we won't chase with a shooter
            }
            // Lethal: a guaranteed wipe of the stack is always worth taking.
            if (unit.calculateAttackDamageMin(unit.getAttack(), e, false, 0, 1) >= e.getCumulativeHp()) {
                return true;
            }
            // Free: the target already used its retaliation this lap, so we take no counter.
            if (fp.hasAlreadyRepliedAttack(e.getId())) {
                return true;
            }
        }
        return false;
    }
    /**
     * Pull a boxed-in shooter back behind the melee line: move to the reachable cell that maximises
     * distance from enemies while staying close to our melee (screened by their aggro). If no move
     * improves safety, hold — hourglass if allowed so allies can shuffle and free a shot this lap,
     * else end the turn — rather than throwing the shooter into melee. Undefined ⇒ let v0.2 decide.
     */
    private rangedRetreat(unit: Unit, context: IDecisionContext): GameAction[] | undefined {
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((e) => !e.isDead());
        if (!enemies.length) {
            return undefined;
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
        const meleeAllies = unitsHolder
            .getAllAllies(unit.getTeam())
            .filter((a) => !a.isDead() && a.getId() !== unit.getId() && a.getAttackType() === MELEE);
        const minEnemyDist = (cell: XY): number => Math.min(...enemies.map((e) => getDistance(cell, e.getBaseCell())));
        const nearestAllyDist = (cell: XY): number =>
            meleeAllies.length ? Math.min(...meleeAllies.map((a) => getDistance(cell, a.getBaseCell()))) : 0;
        // Safer = further from every enemy, but not abandoning the melee screen (so subtract ally distance).
        const safety = (cell: XY): number => minEnemyDist(cell) * 2 - nearestAllyDist(cell);

        const base = unit.getBaseCell();
        let bestCell = base;
        let bestRoute: IWeightedRoute | undefined;
        let bestScore = safety(base);
        for (const routes of movePath.knownPaths.values()) {
            const route = routes[0];
            if (!route?.route.length) {
                continue;
            }
            const score = safety(route.cell);
            if (score > bestScore) {
                bestScore = score;
                bestCell = route.cell;
                bestRoute = route;
            }
        }

        if (bestRoute && (bestCell.x !== base.x || bestCell.y !== base.y)) {
            return [
                {
                    type: "move_unit",
                    unitId: unit.getId(),
                    path: bestRoute.route.map((c: XY) => ({ x: c.x, y: c.y })),
                    targetCells: this.footprintForCell(unit, bestCell, context),
                    hasLavaCell: bestRoute.hasLavaCell,
                    hasWaterCell: bestRoute.hasWaterCell,
                },
            ];
        }
        // Already as safe as we can get: wait (so allies move and may open a shot this lap), else hold.
        if (this.canHourglass(unit, context)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        return [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];
    }
    /**
     * Same effective-damage scoring as v0.2, but damage on enemy RANGE units is weighted up so the
     * best-shot search prefers angles that hit the enemy's shooters (even slightly lower raw damage),
     * focus-firing them down first. Friendly-fire and HP-capping are unchanged.
     */
    protected override scoreShot(
        unit: Unit,
        evaluation: ReturnType<AttackHandler["evaluateRangeAttack"]>,
        fromTeam: number,
        enemyTeam: number,
        _context: IDecisionContext,
    ): { value: number; hitsEnemyRange: boolean } {
        let value = 0;
        let hitsEnemyRange = false;
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
                const effective = Math.min((min + max) / 2, targetHp);
                if (target.getTeam() === enemyTeam) {
                    if (target.getAttackType() === RANGE) {
                        value += effective * ENEMY_RANGE_DAMAGE_WEIGHT; // focus-fire their shooters
                        hitsEnemyRange = true;
                    } else {
                        value += effective;
                    }
                } else if (target.getTeam() === fromTeam) {
                    value -= effective; // friendly fire (AOE splash) is a cost
                }
            }
        }
        return { value, hitsEnemyRange };
    }
    /**
     * Beholder ("Spit Ball") target bias: a ranged hit stacks every listed debuff the target DOESN'T
     * already have, so v0.3 spreads debuffs onto the richest victim instead of re-hitting one that is
     * already debuffed. Most valuable when the target (a) still lacks several debuffs, (b) hasn't acted
     * this lap — the debuff cripples its imminent turn — and (c) can actually threaten this turn (a
     * melee in reach, or a range unit with shots). Scaled by the shot's damage so damage stays dominant.
     * Returns 0 for non-Beholder shooters and for targets that are already fully debuffed.
     */
    protected override shotTargetBonus(unit: Unit, enemy: Unit, baseValue: number, context: IDecisionContext): number {
        if (unit.getName() !== "Beholder" && !unit.hasAbilityActive("Spit Ball")) {
            return 0;
        }
        const targetsRange = enemy.getAttackType() === RANGE;
        const possible = SPIT_BALL_DEBUFFS.length + (targetsRange ? 1 : 0);
        let fresh = SPIT_BALL_DEBUFFS.reduce((n, d) => n + (enemy.hasDebuffActive(d) ? 0 : 1), 0);
        if (targetsRange && !enemy.hasDebuffActive(SPIT_BALL_RANGE_ONLY_DEBUFF)) {
            fresh += 1;
        }
        if (fresh === 0) {
            return 0; // already fully debuffed — nothing more to stack (we still shoot it for damage)
        }
        let bonus = baseValue * BEHOLDER_FRESH_WEIGHT * (fresh / possible);
        if (!this.hasActedThisLap(enemy, context)) {
            bonus *= BEHOLDER_YET_TO_ACT_MULT;
        }
        if (this.canThreatenThisTurn(enemy, unit, context)) {
            bonus *= BEHOLDER_THREAT_MULT;
        }
        return bonus;
    }
    private hasActedThisLap(enemy: Unit, context: IDecisionContext): boolean {
        return context.fightProperties?.hasAlreadyMadeTurn(enemy.getId()) ?? false;
    }
    /** Will this enemy hurt us on its turn — a melee in reach of our line, or a range unit with shots left? */
    private canThreatenThisTurn(enemy: Unit, unit: Unit, context: IDecisionContext): boolean {
        if (enemy.getAttackType() === RANGE) {
            return enemy.getRangeShots() > 0; // it can fire (full line-of-sight check left as a refinement)
        }
        const allies = context.unitsHolder.getAllAllies(unit.getTeam()).filter((a) => !a.isDead());
        const reach = enemy.getSteps() + 1; // move into contact + strike
        return allies.some((a) => getDistance(enemy.getBaseCell(), a.getBaseCell()) <= reach);
    }
    /**
     * Placement variant: v0.2 sits non-sniper shooters back-CENTRE behind the wall; v0.3 tucks EVERY
     * range unit into the safest, most-cornered deep cells (like snipers). Our focus-fire firepower is
     * what wins, so protecting all of it from the clash pays. Melee still forms the centred front wall;
     * casters/support sit back-centre behind it.
     */
    public override placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const placements = new Map<string, XY>();
        const occupied = new Set<number>();
        const legal = context.placement.possibleCellHashes();
        const baseCells = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
        if (!baseCells.length) {
            return placements;
        }
        const frontness = (cc: XY): number => (context.team === PBTypes.TeamVals.LOWER ? cc.y : GRID_SIZE - 1 - cc.y);
        const xs = baseCells.map((cc) => cc.x);
        const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
        const edgeness = (cc: XY): number => Math.abs(cc.x - centreX);
        const footprintFor = (u: Unit, base: XY): XY[] =>
            u.isSmallSize()
                ? [base]
                : [
                      { x: base.x, y: base.y },
                      { x: base.x - 1, y: base.y },
                      { x: base.x, y: base.y - 1 },
                      { x: base.x - 1, y: base.y - 1 },
                  ];
        const placeBy = (u: Unit, compare: (a: XY, b: XY) => number): void => {
            for (const base of [...baseCells].sort(compare)) {
                const footprint = footprintFor(u, base);
                if (footprint.some((cc) => !legal.has(placeCellKey(cc)) || occupied.has(placeCellKey(cc)))) {
                    continue;
                }
                for (const cc of footprint) {
                    occupied.add(placeCellKey(cc));
                }
                placements.set(u.getId(), { x: base.x, y: base.y });
                return;
            }
        };
        const bySizeLargeFirst = (a: Unit, b: Unit): number => (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1);
        const isRange = (u: Unit): boolean => u.getAttackType() === RANGE;
        const isMeleeU = (u: Unit): boolean => u.getAttackType() === MELEE;
        const ranged = units.filter(isRange).sort(bySizeLargeFirst);
        const melee = units.filter(isMeleeU).sort(bySizeLargeFirst);
        const support = units.filter((u) => !isRange(u) && !isMeleeU(u)).sort(bySizeLargeFirst);
        for (const u of ranged) {
            placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(b) - edgeness(a)); // deep + cornered
        }
        // Ground melee form the centred front wall (the body the enemy must grind through). Flyers, by
        // contrast, ignore terrain and screens, so spreading them across that wall wastes their reach.
        // We instead STAGE all flyers together, forward and packed onto one flank, so they sweep the
        // enemy back line as a coordinated wing in a single move (and support each other's dives) rather
        // than peeling off solo. Flying-heavy mirrors are v0.3's weakest bucket; a grouped flank wing is
        // the textbook answer to "coordinate flyers, don't dive alone".
        const isFlyer = (u: Unit): boolean => u.canFly();
        const groundMelee = melee.filter((u) => !isFlyer(u));
        const flyers = melee.filter(isFlyer);
        for (const u of groundMelee) {
            placeBy(u, (a, b) => frontness(b) - frontness(a) || edgeness(a) - edgeness(b)); // front wall, centred
        }
        for (const u of flyers) {
            placeBy(u, (a, b) => frontness(b) - frontness(a) || a.x - b.x); // forward, packed onto one flank
        }
        for (const u of support) {
            placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(a) - edgeness(b)); // back, centred
        }
        return placements;
    }
}

export const STRATEGY_V0_3: IAIStrategy = new StrategyV0_3();
