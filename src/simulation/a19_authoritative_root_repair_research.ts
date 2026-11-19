/*
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { IDecisionContext } from "../ai/ai_strategy";
import {
    coherentMeleeApproachResearch,
    type ICoherentMeleeApproachResult,
} from "../ai/coherent_melee_approach_research";
import type { GameAction } from "../engine/actions";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";

export const A19_AUTHORITATIVE_ROOT_REPAIR_RESEARCH_ID = "a19-authoritative-root-melee-repair-v1";

export interface IAuthoritativeRootRepairResearchInput {
    unit: Unit;
    version: string;
    actions: GameAction[];
    context?: IDecisionContext;
    team: TeamType;
    searched: boolean;
}

/**
 * Inactive research: repair only the final real action list returned by an unchanged A19 search.
 * Call after chooseDecision and before its caller reconciles target memory. Never wrap the policy:
 * repairing its hypothetical proposals changes the search model and is a separate, closed experiment.
 * Ordinary lists keep their reference, preserving the caller's incumbent-memory restoration branch.
 */
export function repairA19AuthoritativeRootResearch({
    unit,
    version,
    actions,
    context,
    team,
    searched,
}: IAuthoritativeRootRepairResearchInput): ICoherentMeleeApproachResult {
    if (
        !searched ||
        version !== "v0.8" ||
        unit.getTeam() !== team ||
        context?.decisionOrigin !== "root" ||
        !context.fightProperties?.hasFightStarted() ||
        context.fightProperties.hasFightFinished() ||
        context.unitsHolder.getAllUnits().get(unit.getId()) !== unit
    ) {
        return { actions, reason: "unchanged" };
    }
    return coherentMeleeApproachResearch(unit, context, actions);
}
