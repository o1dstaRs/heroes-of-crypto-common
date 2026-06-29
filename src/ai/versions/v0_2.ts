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
import {
    getRangeAttackSideCenter,
    isRangeAttackSideObservable,
    RANGE_ATTACK_CELL_SIDES,
    type RangeAttackCellSide,
} from "../../grid/grid_math";
import type { IWeightedRoute } from "../../grid/path_definitions";
import type { AttackHandler } from "../../handlers/attack_handler";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext } from "../ai_strategy";
import { otherTeam, StrategyV0_1 } from "./v0_1";

const isAdjacent = (a: XY, b: XY): boolean => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
const RANGE = PBTypes.AttackVals.RANGE;

interface IShotPlan {
    aimCell: XY;
    aimSide: RangeAttackCellSide;
    targetId: string;
    /** Expected effective damage (capped at each hit unit's HP; allies hit subtract). */
    score: number;
    /** Whether the trajectory actually hits any enemy RANGE unit (vs only front-line melee). */
    hitsEnemyRange: boolean;
}

/** Σ remaining shots × max per-shot damage for a team's living range units (mirrors ai.ts firepower). */
function teamRangedFirepower(team: number, unitsHolder: UnitsHolder): number {
    let firepower = 0;
    for (const u of unitsHolder.getAllAllies(team)) {
        if (u.isDead() || u.getAttackType() !== RANGE || u.getRangeShots() <= 0) {
            continue;
        }
        firepower += u.getRangeShots() * Math.max(1, u.getAttackDamageMax());
    }
    return firepower;
}

/**
 * v0.2 — smarter ranged play over the v0.1 baseline. Three changes, all confined to RANGE units; melee
 * units and placement are untouched v0.1, so a v0.1-vs-v0.2 tournament isolates the ranged AI.
 *
 *  1. Out of options: a ranged unit that can't LAND a shot (out of ammo, or boxed in) doesn't waste the
 *     turn on a doomed range attack. "No Melee" units advance/hold; others switch to melee.
 *  2. Best shot: when it CAN shoot, it iterates every VISIBLE EDGE of every enemy, scores each shot by
 *     the expected EFFECTIVE damage it deals (per-unit damage capped at that unit's HP, allies hit by
 *     splash subtracted), and fires the best one — sending the exact aim edge to the engine. AOE units
 *     (Cyclops' Large Caliber, Gargantuan's Area Throw) are evaluated with their splash, so a shot that
 *     clusters multiple enemies naturally wins.
 *  3. Patience: if our ranged firepower outclasses theirs but the only shots available hit front-line
 *     melee (their range units are screened), it hourglasses (waits) to fire once the formation opens —
 *     never more than the engine's once-per-lap, so it can't stall.
 */
class StrategyV0_2 extends StrategyV0_1 {
    public override readonly version: string = "v0.2";
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const isRanged = unit.getAttackType() === RANGE;
        if (isRanged && !this.canLandRange(unit, context)) {
            if (unit.hasAbilityActive("No Melee")) {
                // No melee strike exists for this unit — advance toward the enemy, or hold if pinned.
                return this.fallbackTurn(unit, context);
            }
            return this.meleeFallback(unit, context);
        }
        if (isRanged && context.attackHandler) {
            return this.decideRangedTurn(unit, context, context.attackHandler);
        }
        return super.decideTurn(unit, context);
    }
    /** A ranged unit that CAN shoot: pick the best visible-edge shot, or hourglass to wait for a better one. */
    private decideRangedTurn(unit: Unit, context: IDecisionContext, attackHandler: AttackHandler): GameAction[] {
        const best = this.findBestShot(unit, context, attackHandler);
        if (!best) {
            // No worthwhile shot found — let v0.1 decide (it may move/engage).
            return super.decideTurn(unit, context);
        }
        if (this.shouldHourglass(unit, context, best)) {
            return [{ type: "wait_turn", unitId: unit.getId() }];
        }
        const actions: GameAction[] = [];
        if (unit.getAttackTypeSelection() !== RANGE) {
            actions.push({ type: "select_attack_type", unitId: unit.getId(), attackType: RANGE });
        }
        actions.push({
            type: "range_attack",
            attackerId: unit.getId(),
            targetId: best.targetId,
            aimCell: best.aimCell,
            aimSide: best.aimSide,
        });
        return actions;
    }
    /**
     * Evaluate a shot at EVERY observable edge of EVERY enemy and return the one with the highest
     * expected effective damage. Effective damage = per-hit-unit expected damage (mean of min/max,
     * pure — no RNG, no ammo spent) capped at that unit's remaining HP, summed over everyone the shot
     * actually hits (occlusion handled by evaluateRangeAttack); allies caught in splash subtract.
     */
    private findBestShot(unit: Unit, context: IDecisionContext, attackHandler: AttackHandler): IShotPlan | undefined {
        const { grid, unitsHolder } = context;
        const matrix = grid.getMatrix();
        const gridSettings = grid.getSettings();
        const allUnits = unitsHolder.getAllUnits();
        const fromTeam = unit.getTeam();
        const enemyTeam = otherTeam(fromTeam);
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
        const isAOE = unit.hasAbilityActive("Large Caliber") || unit.hasAbilityActive("Area Throw");
        const isThroughShot = unit.hasAbilityActive("Through Shot");
        const from = unit.getPosition();

        let best: IShotPlan | undefined;
        for (const enemy of enemies) {
            for (const cell of enemy.getCells()) {
                for (const side of RANGE_ATTACK_CELL_SIDES) {
                    if (!isRangeAttackSideObservable(matrix, cell, side, fromTeam, isThroughShot)) {
                        continue;
                    }
                    const to = getRangeAttackSideCenter(gridSettings, cell, side, from);
                    const evaluation = attackHandler.evaluateRangeAttack(
                        allUnits,
                        unit,
                        from,
                        to,
                        isThroughShot,
                        false,
                        isAOE,
                    );
                    const scored = this.scoreShot(unit, evaluation, fromTeam, enemyTeam);
                    if (scored.value <= 0) {
                        continue;
                    }
                    if (!best || scored.value > best.score) {
                        best = {
                            aimCell: { x: cell.x, y: cell.y },
                            aimSide: side,
                            targetId: enemy.getId(),
                            score: scored.value,
                            hitsEnemyRange: scored.hitsEnemyRange,
                        };
                    }
                }
            }
        }
        return best;
    }
    /** Sum expected effective damage over everyone a shot hits; enemies add, friendly-fire subtracts. */
    private scoreShot(
        unit: Unit,
        evaluation: ReturnType<AttackHandler["evaluateRangeAttack"]>,
        fromTeam: number,
        enemyTeam: number,
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
                const effective = Math.min((min + max) / 2, target.getCumulativeHp());
                if (target.getTeam() === enemyTeam) {
                    value += effective;
                    if (target.getAttackType() === RANGE) {
                        hitsEnemyRange = true;
                    }
                } else if (target.getTeam() === fromTeam) {
                    value -= effective; // friendly fire (AOE splash) is a cost
                }
            }
        }
        return { value, hitsEnemyRange };
    }
    /**
     * Wait (hourglass) instead of firing when: we out-gun them on ranged firepower, the best shot can
     * only reach front-line melee (their range units are still screened), and the engine lets the unit
     * hourglass this lap. Mirrored armies have equal firepower, so this never triggers in self-play — it
     * only matters in asymmetric (real) matchups, where it lets a ranged-superior army wait for a better
     * shot once the enemy closes and the screen opens.
     */
    private shouldHourglass(unit: Unit, context: IDecisionContext, best: IShotPlan): boolean {
        const fp = context.fightProperties;
        if (!fp || best.hitsEnemyRange) {
            return false;
        }
        const fromTeam = unit.getTeam();
        const enemyTeam = otherTeam(fromTeam);
        const { unitsHolder } = context;

        // Only worth waiting if the enemy actually has a screened range unit to expose later.
        const enemyHasRange = unitsHolder
            .getAllAllies(enemyTeam)
            .some((u) => !u.isDead() && u.getAttackType() === RANGE && u.getRangeShots() > 0);
        if (!enemyHasRange) {
            return false;
        }
        if (teamRangedFirepower(fromTeam, unitsHolder) <= teamRangedFirepower(enemyTeam, unitsHolder)) {
            return false;
        }
        // Respect the engine's hourglass rules so the proposal is never rejected (which would waste the turn).
        return (
            fp.getTeamUnitsAlive(fromTeam) > 1 &&
            !unit.isOnHourglass() &&
            !fp.hourglassIncludes(unit.getId()) &&
            !fp.hasAlreadyHourglass(unit.getId()) &&
            !fp.hasAlreadyMadeTurn(unit.getId())
        );
    }
    /** Can the unit land a ranged shot right now (not boxed in / suppressed)? Falls back to ammo count. */
    protected canLandRange(unit: Unit, context: IDecisionContext): boolean {
        const handler = context.attackHandler;
        if (handler) {
            return handler.canLandRangeAttack(unit, context.grid.getEnemyAggrMatrixByUnitId(unit.getId()));
        }
        return unit.getRangeShots() > 0;
    }
    /** A ranged-but-can't-shoot unit that DOES have melee: strike / move-and-strike / advance. */
    private meleeFallback(unit: Unit, context: IDecisionContext): GameAction[] {
        const needSelect = unit.getAttackTypeSelection() !== PBTypes.AttackVals.MELEE;
        const selectAction: GameAction = {
            type: "select_attack_type",
            unitId: unit.getId(),
            attackType: PBTypes.AttackVals.MELEE,
        };
        const withSelect = (actions: GameAction[]): GameAction[] => (needSelect ? [selectAction, ...actions] : actions);

        // 1) Enemy already adjacent — strike in place.
        const adjacent = this.adjacentEnemy(unit, context);
        if (adjacent) {
            return withSelect([
                {
                    type: "melee_attack",
                    attackerId: unit.getId(),
                    targetId: adjacent,
                    attackFrom: { ...unit.getBaseCell() },
                },
            ]);
        }

        // 2) Can reach a cell next to an enemy this turn — move and strike.
        const approach = this.meleeApproach(unit, context);
        if (approach) {
            return withSelect([
                {
                    type: "melee_attack",
                    attackerId: unit.getId(),
                    targetId: approach.targetId,
                    attackFrom: approach.attackFrom,
                    path: approach.route,
                    hasLavaCell: approach.hasLavaCell,
                    hasWaterCell: approach.hasWaterCell,
                },
            ]);
        }

        // 3) Otherwise advance toward the enemy (fallbackTurn holds the turn if it can't move).
        const advance = this.fallbackTurn(unit, context);
        if (advance.length === 1 && advance[0].type === "end_turn") {
            return advance; // pinned: no point flipping to melee
        }
        return withSelect(advance);
    }
    /** The id of a living enemy whose footprint touches the unit's footprint, if any. */
    private adjacentEnemy(unit: Unit, context: IDecisionContext): string | undefined {
        const enemies = context.unitsHolder.getAllAllies(otherTeam(unit.getTeam())).filter((u) => !u.isDead());
        const myCells = unit.getCells();
        for (const enemy of enemies) {
            for (const ec of enemy.getCells()) {
                if (myCells.some((uc) => isAdjacent(ec, uc))) {
                    return enemy.getId();
                }
            }
        }
        return undefined;
    }
    /** Shortest reachable stand-cell whose footprint is adjacent to an enemy (a move-and-melee), if any. */
    private meleeApproach(
        unit: Unit,
        context: IDecisionContext,
    ): { attackFrom: XY; targetId: string; route: XY[]; hasLavaCell?: boolean; hasWaterCell?: boolean } | undefined {
        if (!unit.canMove()) {
            return undefined;
        }
        const { grid, matrix, unitsHolder, pathHelper } = context;
        const enemyTeam = otherTeam(unit.getTeam());
        const enemies = unitsHolder.getAllAllies(enemyTeam).filter((u) => !u.isDead());
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
            unit.hasAbilityActive("Made of Fire"),
        );
        if (!movePath.knownPaths.size) {
            return undefined;
        }

        let best: { attackFrom: XY; targetId: string; route: IWeightedRoute } | undefined;
        for (const routeList of movePath.knownPaths.values()) {
            const route = routeList[0];
            if (!route?.route.length) {
                continue;
            }
            const footprint = this.footprintForCell(unit, route.cell, context);
            for (const enemy of enemies) {
                const touches = enemy.getCells().some((ec) => footprint.some((fc) => isAdjacent(ec, fc)));
                if (touches) {
                    if (!best || route.route.length < best.route.route.length) {
                        best = { attackFrom: { x: route.cell.x, y: route.cell.y }, targetId: enemy.getId(), route };
                    }
                    break;
                }
            }
        }
        if (!best) {
            return undefined;
        }
        return {
            attackFrom: best.attackFrom,
            targetId: best.targetId,
            route: best.route.route.map((c) => ({ x: c.x, y: c.y })),
            hasLavaCell: best.route.hasLavaCell,
            hasWaterCell: best.route.hasWaterCell,
        };
    }
}

export const STRATEGY_V0_2: IAIStrategy = new StrategyV0_2();
