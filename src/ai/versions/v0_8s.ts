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
import type { TeamType } from "../../generated/protobuf/v1/types_gen";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { IAIStrategy, IDecisionContext } from "../ai_strategy";
import { enumerateCandidates } from "../candidates";
import { StrategyV0_8, v08TeamRangedOutput } from "./v0_8";
import { selectV08STargetPressureCandidate, V08S_URGENT_FINISH_START_LAP } from "./v0_8s_finish";

/** Measurement-only alias for applying anti-Armageddon experiments to one v0.8 mirror seat. */
export class StrategyV0_8S extends StrategyV0_8 {
    public override readonly version: string = "v0.8s";
    protected override rangedOutput(team: number, unitsHolder: UnitsHolder): number {
        return v08TeamRangedOutput(team as TeamType, unitsHolder);
    }
    public override decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const incumbent = super.decideTurn(unit, context);
        const currentLap = context.fightProperties?.getCurrentLap() ?? 0;
        // Before the universal final sprint, target-pressure alternatives belong to SearchDriver so the exact
        // inherited action remains available as candidate zero. This keeps a deterministic target preference in
        // the shortlist without turning it into an unconditional, potentially losing retarget.
        if (!Number.isFinite(currentLap) || currentLap < V08S_URGENT_FINISH_START_LAP) {
            return incumbent;
        }

        const candidates = enumerateCandidates(unit, context, incumbent, {
            maxMoveDestinations: 1,
            maxMeleePairs: 8,
            maxShotAims: 6,
            maxAreaThrowCells: 4,
            enrichIncumbentMetadata: true,
            preserveAttackTargetCoverage: true,
        }).candidates;
        // The universal final sprint may force a fresh attack from lap 9. Ordinary/balanced stronger-ranged
        // posture waits remain untouched through lap 8, while the inherited >=2:1 dominant finish may still press
        // from lap 7 through StrategyV0_8.
        const attack = selectV08STargetPressureCandidate(unit, context.unitsHolder, candidates, currentLap);
        if (attack) return attack.actions;
        const advance = candidates.find((candidate) => candidate.kind === "move");
        if (advance) return advance.actions;
        return incumbent;
    }
}

export const STRATEGY_V0_8S: IAIStrategy = new StrategyV0_8S();
