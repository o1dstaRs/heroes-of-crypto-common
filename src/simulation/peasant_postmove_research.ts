import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import { estimatePrimaryMeleeDamage } from "../ai/melee_damage_estimate";
import type { GameAction } from "../engine/actions";
import { canUnitRespondToMelee } from "../handlers/melee_response";
import { projectStackDamage } from "../units/stack_damage";
import type { Unit } from "../units/unit";

export const PEASANT_POSTMOVE_RESEARCH_ID = "peasant-postmove-response-coverage-v1";

export interface IPeasantResponseCost {
    readonly targetId: string;
    readonly procChance: number;
    readonly expectedHpLoss: number;
    readonly maximumHpLoss: number;
    readonly maximumCasualties: number;
}

/** Only an ordinary single strike, optionally following one explicit safe move. */
export function isPeasantResponseSequence(unitId: string, actions: readonly GameAction[]): boolean {
    let moves = 0,
        strikes = 0;
    for (const action of actions) {
        if (action.type === "select_attack_type") {
            if (strikes || action.unitId !== unitId) return false;
        } else if (action.type === "move_unit") {
            if (strikes || ++moves > 1 || action.unitId !== unitId || action.hasLavaCell || action.hasWaterCell)
                return false;
        } else if (action.type === "melee_attack") {
            if (++strikes > 1 || action.attackerId !== unitId || action.path?.length) return false;
        } else return false;
    }
    return strikes === 1;
}

/**
 * Research-only inspection at the PRE-STRIKE point inside an existing legal leaf rollout. Movement
 * and its aura/stat refresh have already executed; the defender is still at pre-primary-hit strength.
 * Pure projection uses the entire supported damage distribution, not the leaf's one lucky damage roll.
 * No absolute casualty cap: the maximum HP price is 5% of the surviving stack, with no fatal outcome.
 * Nothing here decides an attack, changes a tier, adds a bonus reward or bypasses native guards.
 */
export function inspectPeasantResponseCost(
    unit: Unit,
    context: IDecisionContext,
    strike: Extract<GameAction, { type: "melee_attack" }>,
): IPeasantResponseCost | undefined {
    const fp = context.fightProperties,
        cell = unit.getBaseCell();
    if (
        context.decisionOrigin !== "root" ||
        !fp ||
        unit.getName() !== "Peasant" ||
        unit.isDead() ||
        unit.getAmountAlive() < 2 ||
        !unit.hasAbilityActive("Bitter Experience") ||
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
        [unit, target].some(
            (u) =>
                u.hasBuffActive("Flesh Shield Aura") ||
                u.hasAbilityActive("Fire Shield") ||
                u.hasBuffActive("Fireforged Sword"),
        ) ||
        target.hasAbilityActive("Rapid Charge") ||
        ["Devour Essence", "Petrifying Gaze", "Predatory Assimilation", "Borrowed Grace"].some((name) =>
            target.hasAbilityActive(name),
        ) ||
        !canUnitRespondToMelee(unit, target, fp) ||
        unit.willAbsorbIncomingHit(target) ||
        fp.getBreakChancePerTeam(target.getTeam()) > 0 ||
        !context.grid.areCellsAdjacent(unit.getCells(), target.getCells()) ||
        unit.cannotAttackUnitId(target.getId()) ||
        (unit.getTarget() && unit.getTarget() !== target.getId()) ||
        (unit.hasStatusApplied("Cowardice") && unit.getCumulativeHp() < target.getCumulativeHp())
    )
        return undefined;
    if (!estimatePrimaryMeleeDamage(unit, target, context, cell, [strike])) return undefined;
    const response = estimatePrimaryMeleeDamage(target, unit, context, target.getBaseCell(), [
        {
            type: "melee_attack",
            attackerId: target.getId(),
            targetId: unit.getId(),
            attackFrom: target.getBaseCell(),
        },
    ]);
    if (!response || response.hitChance <= 0) return undefined;
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
    if (procChance < 0.5 || maximumHpLoss > unit.getCumulativeHp() * 0.05) return undefined;
    return { targetId: target.getId(), procChance, expectedHpLoss, maximumHpLoss, maximumCasualties };
}

export interface IPeasantResponseLeaf {
    readonly candidate: IEnumeratedCandidate;
    readonly value: number;
    readonly cost: IPeasantResponseCost;
}

/**
 * Preserve the complete native shortlist, including any existing special reservation. Add at most
 * one omitted supported response trade when native has not already exceeded its ordinary cap.
 * Rank missing trades by the existing immediate value; ties prefer lower expected damage, then
 * catalog order. Full search and final neural arbitration retain their ordinary selection rules.
 */
export function reservePeasantPostmoveCandidate(
    native: readonly IEnumeratedCandidate[],
    leaves: readonly IPeasantResponseLeaf[],
    ordinaryCap: number,
): readonly IEnumeratedCandidate[] {
    if (!Number.isInteger(ordinaryCap) || ordinaryCap < 1 || !native.length || native.length > ordinaryCap)
        return native;
    const nativeActions = new Set(native.map((candidate) => JSON.stringify(candidate.actions)));
    let best: IPeasantResponseLeaf | undefined;
    for (const leaf of leaves) {
        if (!Number.isFinite(leaf.value) || nativeActions.has(JSON.stringify(leaf.candidate.actions))) continue;
        if (
            !best ||
            leaf.value > best.value ||
            (leaf.value === best.value && leaf.cost.expectedHpLoss < best.cost.expectedHpLoss)
        )
            best = leaf;
    }
    return best ? [...native, best.candidate] : native;
}
