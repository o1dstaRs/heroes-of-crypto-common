import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import { estimatePrimaryMeleeDamage } from "../ai/melee_damage_estimate";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import { projectStackDamage } from "../units/stack_damage";
import type { Unit } from "../units/unit";

export const BITTER_EXPERIENCE_RESEARCH_ID = "bitter-experience-cheap-response-v1";

export interface IBitterExperienceOpportunity {
    readonly candidate: IEnumeratedCandidate;
    readonly targetId: string;
    readonly procChance: number;
    readonly expectedHpLoss: number;
    readonly maximumHpLoss: number;
    readonly maximumCasualties: number;
}

/**
 * Offline shortlist hypothesis, never a forced attack or an invented armor reward. Normal melee
 * responses are calculated before the original primary damage is applied, so use the defender's
 * present stack, even if our strike kills it. Unsupported sweep/reflect/burn/break exchanges stay
 * with the native policy. Full engine continuation, not this cost screen, owns tactical value.
 */
export function bitterExperienceOpportunity(
    unit: Unit,
    context: IDecisionContext,
    candidate: IEnumeratedCandidate,
): IBitterExperienceOpportunity | undefined {
    const fp = context.fightProperties;
    if (
        context.decisionOrigin !== "root" ||
        !fp ||
        unit.isDead() ||
        unit.getAmountAlive() < 2 ||
        !unit.hasAbilityActive("Bitter Experience") ||
        unit.hasBuffActive("Flesh Shield Aura") ||
        unit.hasAbilityActive("Fire Shield") ||
        unit.hasBuffActive("Fireforged Sword") ||
        candidate.actions.some((a) => a.type !== "melee_attack" && a.type !== "select_attack_type")
    )
        return undefined;
    const strikes = candidate.actions.filter((a) => a.type === "melee_attack");
    if (strikes.length !== 1) return undefined;
    const strike = strikes[0],
        cell = unit.getBaseCell();
    if (
        strike.attackerId !== unit.getId() ||
        strike.path?.length ||
        strike.attackFrom.x !== cell.x ||
        strike.attackFrom.y !== cell.y
    )
        return undefined;
    const target = context.unitsHolder.getAllUnits().get(strike.targetId);
    if (
        !target ||
        target.isDead() ||
        target.getTeam() === unit.getTeam() ||
        target.hasAbilityActive("Hidden") ||
        target.hasBuffActive("Hidden") ||
        target.hasBuffActive("Flesh Shield Aura") ||
        target.hasAbilityActive("Fire Shield") ||
        target.hasBuffActive("Fireforged Sword") ||
        target.hasAbilityActive("Rapid Charge") ||
        ["Devour Essence", "Petrifying Gaze", "Predatory Assimilation", "Borrowed Grace"].some((name) =>
            target.hasAbilityActive(name),
        ) ||
        !canUnitRespondToMelee(unit, target, fp) ||
        unit.willAbsorbIncomingHit(target) ||
        fp.getBreakChancePerTeam(target.getTeam()) > 0
    )
        return undefined;
    if (
        !context.grid.areCellsAdjacent(unit.getCells(), target.getCells()) ||
        unit.cannotAttackUnitId(target.getId()) ||
        (unit.getTarget() && unit.getTarget() !== target.getId()) ||
        (unit.hasStatusApplied("Cowardice") && unit.getCumulativeHp() < target.getCumulativeHp())
    )
        return undefined;
    const primary = estimatePrimaryMeleeDamage(unit, target, context, cell, candidate.actions);
    const response = estimatePrimaryMeleeDamage(target, unit, context, target.getBaseCell(), [
        {
            type: "melee_attack",
            attackerId: target.getId(),
            targetId: unit.getId(),
            attackFrom: target.getBaseCell(),
        },
    ]);
    if (!primary || !response || response.hitChance <= 0) return undefined;
    const hp = {
        hp: unit.getHp(),
        maxHp: unit.getMaxHp(),
        amountAlive: unit.getAmountAlive(),
        amountDied: unit.getAmountDied(),
    };
    let procChance = 0,
        expectedHpLoss = 0,
        maximumHpLoss = 0,
        maximumCasualties = 0;
    for (const roll of response.landedOutcomes) {
        const projected = projectStackDamage(hp, roll.damage);
        if (projected.dead) return undefined;
        const probability = response.hitChance * roll.probability;
        if (projected.unitsDied > 0) procChance += probability;
        expectedHpLoss += probability * projected.appliedDamage;
        maximumHpLoss = Math.max(maximumHpLoss, projected.appliedDamage);
        maximumCasualties = Math.max(maximumCasualties, projected.unitsDied);
    }
    if (procChance < 0.5 || maximumCasualties > 2 || maximumHpLoss > unit.getCumulativeHp() * 0.05) return undefined;
    return { candidate, targetId: target.getId(), procChance, expectedHpLoss, maximumHpLoss, maximumCasualties };
}

/** Choose one cheap, likely proc from the already legal catalog; exact ties preserve catalog order. */
export function selectBitterExperienceOpportunity(
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IBitterExperienceOpportunity | undefined {
    let best: IBitterExperienceOpportunity | undefined;
    for (const candidate of candidates) {
        const value = bitterExperienceOpportunity(unit, context, candidate);
        if (
            value &&
            (!best ||
                value.procChance > best.procChance ||
                (value.procChance === best.procChance && value.expectedHpLoss < best.expectedHpLoss))
        )
            best = value;
    }
    return best;
}

/** Keep every native comparison and append at most one full-horizon alternative. Existing extra reservations take precedence. */
export function reserveBitterExperienceCandidate(
    opportunity: IBitterExperienceOpportunity | undefined,
    incumbent: IEnumeratedCandidate,
    challengers: readonly IEnumeratedCandidate[],
    cap: number,
): readonly IEnumeratedCandidate[] {
    if (
        !opportunity ||
        opportunity.candidate === incumbent ||
        challengers.includes(opportunity.candidate) ||
        cap < 1 ||
        challengers.length > cap
    )
        return challengers;
    return [...challengers, opportunity.candidate];
}

/** Crossing a late target-priority tier requires beating every ordinary eligible action and native by 0.01. */
export function includeImprovingBitterExperienceTrade(
    candidates: readonly IEnumeratedCandidate[],
    means: readonly number[],
    selection: readonly number[],
    opportunity: IBitterExperienceOpportunity | undefined,
): readonly number[] {
    if (!opportunity) return selection;
    const index = candidates.indexOf(opportunity.candidate);
    if (index <= 0 || selection.includes(index) || !Number.isFinite(means[index])) return selection;
    const reference = Math.max(means[0], ...selection.map((i) => means[i]));
    return means[index] - reference >= 0.01 ? [...selection, index] : selection;
}
