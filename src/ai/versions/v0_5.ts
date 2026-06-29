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
import type { IDecisionContext, IAIStrategy } from "../ai_strategy";
import { otherTeam } from "./v0_1";
import { StrategyV0_4 } from "./v0_4";
import { loadV05Weights } from "./v0_5_weights";

const RANGE = PBTypes.AttackVals.RANGE;
/** Action types that mean the unit is striking/casting this turn (so a move is a combat reposition, not a free one). */
const COMBAT_ACTIONS = new Set(["melee_attack", "range_attack", "cast_spell", "obstacle_attack", "area_throw_attack"]);
/** Rough single-stack firepower proxy (shots * max hit), matching v0.4's firepowerOf. */
const firepowerOf = (u: Unit): number => Math.max(1, u.getRangeShots()) * Math.max(1, u.getAttackDamageMax());

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
        // v0.4's full decision (which already used v0.5's learned scoreShot via inheritance), then the
        // learned reposition policy re-ranks a STANDALONE move's destination. Default weights keep v0.4's
        // own destination (posIncumbent anchor), so this is a strict, validity-preserving extension.
        return this.repositionByPolicy(unit, context, super.decideTurn(unit, context));
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
        const [, , , , , , wAdvance, wCohesion, wHazard, wIncumbent] = this.w;
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
        const score = (cell: XY, route: IWeightedRoute): number => {
            const advance = (baseEnemyDist - minEnemyDist(cell)) / steps; // + => closer to the enemy
            const cohesion = (baseCentroidDist - getDistance(cell, centroid)) / steps; // + => toward allies
            const hazard = route.hasLavaCell || route.hasWaterCell ? 1 : 0;
            const incumbent = cell.x === dest.x && cell.y === dest.y ? 1 : 0;
            return wAdvance * advance + wCohesion * cohesion + wHazard * hazard + wIncumbent * incumbent;
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
