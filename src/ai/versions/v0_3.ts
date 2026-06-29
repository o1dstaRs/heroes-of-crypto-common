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
import { StrategyV0_2 } from "./v0_2";

const RANGE = PBTypes.AttackVals.RANGE;
// How much more a point of damage on an enemy RANGE unit is worth than the same damage on a melee
// unit. Winning the ranged-attrition race flips firepower superiority our way; from there we hold a
// grouped position and out-shoot, while the now ranged-inferior enemy must walk onto our shots.
const ENEMY_RANGE_DAMAGE_WEIGHT = 2.0;

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
class StrategyV0_3 extends StrategyV0_2 {
    public override readonly version: string = "v0.3";
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
}

export const STRATEGY_V0_3: IAIStrategy = new StrategyV0_3();
