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
import { loadV05Weights } from "./v0_5_weights";

const RANGE = PBTypes.AttackVals.RANGE;
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
