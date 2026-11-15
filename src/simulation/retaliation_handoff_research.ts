import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import { canWaitOnHourglass } from "../engine/hourglass";
import { PBTypes } from "../generated/protobuf/v1/types";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import type { Unit } from "../units/unit";

export const RETALIATION_HANDOFF_RESEARCH_ID = "retaliation-handoff-wait-v1";

export interface IRetaliationHandoffOpportunity {
    readonly targetId: string;
    readonly allyIds: readonly string[];
}

/**
 * Offline coverage hypothesis, not a promise that an ally will attack or that waiting is profitable.
 * Only current public combat state is inspected. The ordinary engine rollout owns initiative, target
 * choice, luck, deaths, the hourglass morale cost and whether the defender spends its response.
 */
export function retaliationHandoffOpportunity(
    unit: Unit,
    context: Pick<IDecisionContext, "unitsHolder" | "fightProperties" | "decisionOrigin">,
    incumbent: readonly GameAction[],
): IRetaliationHandoffOpportunity | undefined {
    const fp = context.fightProperties;
    const all = context.unitsHolder.getAllUnits();
    if (context.decisionOrigin !== "root" || !fp || !canWaitOnHourglass(unit, fp, all)) return undefined;
    const attacks = incumbent.filter((action) => action.type === "melee_attack");
    if (
        attacks.length !== 1 ||
        attacks[0].attackerId !== unit.getId() ||
        incumbent.some(
            (action) =>
                action.type !== "melee_attack" && action.type !== "move_unit" && action.type !== "select_attack_type",
        ) ||
        unit.hasAbilityActive("Lightning Spin")
    ) {
        return undefined;
    }
    const target = all.get(attacks[0].targetId);
    if (
        !target ||
        target.isDead() ||
        target.getTeam() === unit.getTeam() ||
        target.hasAbilityActive("Hidden") ||
        target.hasBuffActive("Hidden") ||
        !canUnitRespondToMelee(unit, target, fp)
    ) {
        return undefined;
    }
    const allies: string[] = [];
    for (const ally of all.values()) {
        if (
            ally === unit ||
            ally.isDead() ||
            ally.getTeam() !== unit.getTeam() ||
            fp.hasAlreadyMadeTurn(ally.getId()) ||
            ally.isOnHourglass() ||
            fp.hourglassIncludes(ally.getId()) ||
            ally.isSkippingThisTurn() ||
            ally.hasAbilityActive("No Melee") ||
            ally.hasAbilityActive("Lightning Spin") ||
            ally.cannotAttackUnitId(target.getId()) ||
            (ally.hasStatusApplied("Cowardice") && ally.getCumulativeHp() < target.getCumulativeHp()) ||
            !canUnitRespondToMelee(ally, target, fp)
        ) {
            continue;
        }
        const forced = all.get(ally.getTarget());
        if (forced && !forced.isDead() && forced !== target) continue;
        const attackTypes = [ally.getAttackTypeSelection(), ...ally.getPossibleAttackTypes()];
        if (!attackTypes.some((type) => type === PBTypes.AttackVals.MELEE || type === PBTypes.AttackVals.MELEE_MAGIC)) {
            continue;
        }
        if (
            !ally
                .getCells()
                .some((cell) =>
                    target
                        .getCells()
                        .some(
                            (enemyCell) =>
                                Math.max(Math.abs(cell.x - enemyCell.x), Math.abs(cell.y - enemyCell.y)) === 1,
                        ),
                )
        ) {
            continue;
        }
        allies.push(ally.getId());
    }
    return allies.length ? { targetId: target.getId(), allyIds: allies } : undefined;
}

/** Reserve one already-legal wait within the ordinary challenger cap, preserving the top challenger. */
export function reserveRetaliationHandoffWait(
    legalCandidates: readonly IEnumeratedCandidate[],
    challengers: readonly IEnumeratedCandidate[],
    cap: number,
): readonly IEnumeratedCandidate[] {
    const wait = legalCandidates.find((candidate) => candidate.kind === "wait");
    if (!wait || challengers.includes(wait) || cap < 2) return challengers;
    return [...challengers.slice(0, cap - 1), wait];
}
