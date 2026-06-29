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

import { PBTypes } from "../../generated/protobuf/v1/types";
import type { AttackHandler } from "../../handlers/attack_handler";
import type { Unit } from "../../units/unit";
import type { IAIStrategy } from "../ai_strategy";
import { StrategyV0_4 } from "./v0_4";

const RANGE = PBTypes.AttackVals.RANGE;
// Focus-kill scoring, from the randomized-roster win analysis: total army HP is the dominant win
// factor (the side with more HP won 70% of games) and first-blood / early damage correlate with
// winning, while having more RANGED units was NOT a win lever (~50%). So v0.5 drops v0.3's 2x
// enemy-range bias and instead rewards CONCENTRATING fire to remove whole stacks.
const STACK_KILL_BONUS = 1.5; // a stack-wiping shot adds 1.5x the HP it removes, on top of the damage
const FINISH_WEIGHT = 0.5; // partial shots are nudged toward finishing ONE stack rather than chipping many

/**
 * v0.5 — extends the v0.4 tactics with focus-kill shot selection (the data-driven hypothesis from the
 * random-roster analysis).
 *
 * v0.3 scored a ranged shot by raw effective damage, with a 2x bias toward enemy RANGE units. The
 * analysis showed that bias buys nothing (ranged count/firepower ≈ 50% win rate) while army HP (70%) and
 * tempo — first-blood (55%), early damage — drive wins. v0.5 therefore:
 *  - drops the enemy-range weighting, and
 *  - rewards a shot that WIPES a whole enemy stack (a big bonus on the removed HP) and, short of a kill,
 *    nudges toward bringing a SINGLE stack closest to death — i.e. concentrate fire, take the kill,
 *    instead of spreading max raw damage across survivors.
 *
 * Beholder debuff-spreading (v0.3's shotTargetBonus) and all four v0.4 tactics are inherited unchanged.
 */
export class StrategyV0_5 extends StrategyV0_4 {
    public override readonly version: string = "v0.5";
    protected override scoreShot(
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
                const targetHp = target.getCumulativeHp();
                const effective = Math.min((min + max) / 2, targetHp);
                if (target.getTeam() === enemyTeam) {
                    let v = effective;
                    if (targetHp > 0) {
                        if (effective >= targetHp) {
                            v += targetHp * STACK_KILL_BONUS; // wipes the stack: tempo + permanent removal
                        } else {
                            v += effective * FINISH_WEIGHT * (effective / targetHp); // closer to a kill
                        }
                    }
                    value += v;
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
}

export const STRATEGY_V0_5: IAIStrategy = new StrategyV0_5();
