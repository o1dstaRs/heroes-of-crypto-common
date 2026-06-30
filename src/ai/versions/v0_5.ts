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
import { PBTypes } from "../../generated/protobuf/v1/types";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { AttackHandler } from "../../handlers/attack_handler";
import type { Unit } from "../../units/unit";
import { getDistance, type XY } from "../../utils/math";
import { auraCoverageScore, countMeleeThreatsToCell } from "../ai";
import type { IDecisionContext, IAIStrategy } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { StrategyV0_4 } from "./v0_4";
import { loadV05Weights } from "./v0_5_weights";

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
/** Action types that mean the unit is striking/casting this turn (so a move is a combat reposition, not a free one). */
const COMBAT_ACTIONS = new Set(["melee_attack", "range_attack", "cast_spell", "obstacle_attack", "area_throw_attack"]);
/** Rough single-stack firepower proxy (shots * max hit), matching v0.4's firepowerOf. */
const firepowerOf = (u: Unit): number => Math.max(1, u.getRangeShots()) * Math.max(1, u.getAttackDamageMax());
const isAdjacentCell = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;

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
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        // v0.4's full decision (which already used v0.5's learned scoreShot via inheritance), then two learned
        // post-processes: re-rank a melee strike's (target, stand cell), then re-rank a standalone move's
        // destination. They're mutually exclusive (a turn is either a strike or a pure move), and both anchor
        // to v0.4's own pick, so with the default weights v0.5 == v0.4 (a strict, validity-preserving extension).
        const base = super.decideTurn(unit, context);
        return this.repositionByPolicy(unit, context, this.meleeByPolicy(unit, context, base));
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
        const [, , , , , , , , , , , , , , wDmg, wKill, wRetal, wThreat, wStand, wIncumbent] = this.w;
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const base = unit.getBaseCell();
        const myCells = unit.getCells();
        const fp = context.fightProperties;
        const v4target = strike.targetId;
        const v4from = strike.attackFrom ?? base;
        const cowardlyVs = (e: Unit): boolean =>
            unit.hasDebuffActive("Cowardice") && unit.getCumulativeHp() < e.getCumulativeHp();
        const enemies = unitsHolder
            .getAllAllies(enemyTeam)
            .filter((e) => !e.isDead() && !e.hasBuffActive("Hidden") && !cowardlyVs(e));
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
        if (v4targetUnit && !v4targetUnit.isDead()) {
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
                unit.hasAbilityActive("Made of Fire"),
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
        const score = (c: Cand): number => {
            const min = unit.calculateAttackDamageMin(unit.getAttack(), c.target, false, 0, 1);
            const max = unit.calculateAttackDamageMax(unit.getAttack(), c.target, false, 0, 1);
            const hp = c.target.getCumulativeHp();
            const effective = Math.min((min + max) / 2, hp);
            const dmg = effective / Math.max(1, c.target.getMaxHp());
            const kill = effective >= hp ? 1 : 0;
            const retalFree = fp?.hasAlreadyRepliedAttack(c.target.getId()) ? 1 : 0;
            const threat = firepowerOf(c.target) / 1000;
            const standThreat = countMeleeThreatsToCell(c.cell, matrix, enemyTeam) / 3;
            const incumbent = c.target.getId() === v4target && c.cell.x === v4from.x && c.cell.y === v4from.y ? 1 : 0;
            return (
                wDmg * dmg +
                wKill * kill +
                wRetal * retalFree +
                wThreat * threat +
                wStand * standThreat +
                wIncumbent * incumbent
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
                wAura * aura
            );
        };

        const movePath = pathHelper.getMovePath(
            base,
            matrix,
            unit.getSteps(),
            grid.getAggrMatrixByTeam(enemyTeam),
            unit.canFly(),
            unit.isSmallSize(),
            unit.hasAbilityActive("Made of Fire"),
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
    protected override scoreShot(
        unit: Unit,
        evaluation: ReturnType<AttackHandler["evaluateRangeAttack"]>,
        fromTeam: number,
        enemyTeam: number,
    ): { value: number; hitsEnemyRange: boolean } {
        const [wDamage, wKill, wRange, wFirepower, wLevel, wFriendlyFire] = this.w;
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
                } else if (target.getTeam() === fromTeam) {
                    value -= wFriendlyFire * effective; // friendly fire (AOE splash) is a cost
                }
            }
        }
        return { value, hitsEnemyRange };
    }
}

export const STRATEGY_V0_5: IAIStrategy = new StrategyV0_5();
