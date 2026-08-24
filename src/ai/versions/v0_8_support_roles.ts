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
import type { Unit } from "../../units/unit";
import type { IDecisionContext } from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";
import { buildV08BacklineProtectorIntent, isImmediateMeleeResponseExposed } from "./v0_8_backline_protector";
import { isV08DirectCombatDecision } from "./v0_8_dominant_finish";
import { v08DominantFinishState } from "./v0_8_dominant_finish";

const WANDERING_MAGE = "Wandering Mage";
const HEALER = "Healer";
const NIGHTMARE = "Nightmare";
const SMOKE = "Smoke";
const FIRE_WALL = "Fire Wall";
const HEAL = "Heal";
const MASS_HEAL = "Mass Heal";
const SPIRITUAL_ARMOR = "Spiritual Armor";

/**
 * These are the expensive, durable stacks for which a Healer slot has an explicit sustain job. This is
 * intentionally a role list rather than a blanket level check: healing a damage-focused level-4 stack after it
 * has already lost bodies does not restore those bodies, while keeping one of these live preserves its screen,
 * aura, retaliation pressure, or absorption bank.
 */
export const V08_DURABLE_HEAL_ANCHORS = new Set(["Abomination", "Frenzied Boar", "Goblin Knight", "Angel"]);

export const isV08DurableHealAnchor = (unit: Unit, context?: IDecisionContext): boolean => {
    if (!V08_DURABLE_HEAL_ANCHORS.has(unit.getName())) return false;
    // Angel is a sustain anchor only while it is doing the ranged-line job the composition paid for.
    // Without context preserve the public name predicate for callers that only need role taxonomy.
    return (
        unit.getName() !== "Angel" ||
        context === undefined ||
        buildV08BacklineProtectorIntent(unit, context)?.kind === "angel"
    );
};

const enumerateSupportCandidates = (
    unit: Unit,
    context: IDecisionContext,
    decision: readonly GameAction[],
): readonly IEnumeratedCandidate[] =>
    enumerateCandidates(unit, context, [...decision], {
        maxMoveDestinations: 1,
        maxMeleePairs: 8,
        maxShotAims: 6,
        maxAreaThrowCells: 4,
        enrichIncumbentMetadata: true,
    }).candidates;

const incumbentGuaranteedKill = (
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): boolean => {
    const incumbent = candidates[0];
    const target = incumbent?.targetId ? context.unitsHolder.getAllUnits().get(incumbent.targetId) : undefined;
    const targetCanAbsorbPrimary =
        !!target &&
        ((target.hasBuffActive("Water Shield") && !unit.hasAbilityActive("Fire Element")) ||
            target.hasBuffActive("Flesh Shield Aura"));
    const melee = incumbent?.actions.some((action) => action.type === "melee_attack") === true;
    const targetCanPunishMelee =
        !!target &&
        melee &&
        (isImmediateMeleeResponseExposed(unit, target, context) ||
            (target.hasAbilityActive("Fire Shield") &&
                !unit.hasAbilityActive("Fire Element") &&
                unit.getMagicResist() < 100));
    return (
        !!incumbent &&
        isV08DirectCombatDecision(incumbent.actions) &&
        incumbent.features.expectedKill === 1 &&
        incumbent.features.expectedDamage > 0 &&
        !targetCanAbsorbPrimary &&
        !targetCanPunishMelee
    );
};

/**
 * Smoke is Wandering Mage's reason to exist against shooters. Candidate generation already rejects a cloud whose
 * exact crossed rays suppress at least as much friendly ranged output as enemy output. Promote the surviving
 * net-positive cloud to the native v0.8 proposal, so a13's size-two shortlist cannot discard this future-value
 * spell before rollout. A guaranteed kill and the universal finish window still take priority.
 */
export function prioritizeV08WanderingMageSmoke(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    if (
        unit.getName() !== WANDERING_MAGE ||
        v08DominantFinishState(context.unitsHolder, unit.getTeam(), context.fightProperties?.getCurrentLap() ?? 0)
            .active
    ) {
        return decision;
    }
    const candidates = enumerateSupportCandidates(unit, context, decision);
    if (incumbentGuaranteedKill(unit, context, candidates)) return decision;
    return candidates.find((candidate) => candidate.spellName === SMOKE)?.actions ?? decision;
}

/**
 * Nightmare is a melee caster, so the inherited MELEE_MAGIC-only router never exposes Book of Nightmares.
 * Candidate generation already finds one engine-legal, threat-weighted Fire Wall that blocks an enemy approach;
 * promote it only over an advance/passive turn so a13's size-two shortlist can compare its delayed value without
 * spending an immediate attack, cast, or tactical hourglass.
 */
export function prioritizeV08NightmareFireWall(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    if (
        unit.getName() !== NIGHTMARE ||
        decision.some(
            (action) =>
                action.type === "wait_turn" ||
                action.type === "cast_spell" ||
                action.type === "melee_attack" ||
                action.type === "range_attack" ||
                action.type === "area_throw_attack",
        ) ||
        v08DominantFinishState(context.unitsHolder, unit.getTeam(), context.fightProperties?.getCurrentLap() ?? 0)
            .active
    ) {
        return decision;
    }
    return (
        enumerateSupportCandidates(unit, context, decision).find((candidate) => candidate.spellName === FIRE_WALL)
            ?.actions ?? decision
    );
}

const spellPower = (unit: Unit, name: string): number =>
    unit
        .getSpells()
        .find((spell) => spell.getName() === name)
        ?.getPower() ?? 0;

const effectiveFrontHeal = (target: Unit, rawPower: number): number =>
    Math.max(0, Math.min(rawPower, target.getMaxHp() - target.getHp()));

const anchorMultiplier = (target: Unit, context: IDecisionContext): number =>
    isV08DurableHealAnchor(target, context) ? 3 : 1;

const singleHealValue = (target: Unit, rawPower: number, context: IDecisionContext): number => {
    const effective = effectiveFrontHeal(target, rawPower);
    if (effective <= 0) return 0;
    const missingFraction = Math.max(0, target.getMaxHp() - target.getHp()) / Math.max(1, target.getMaxHp());
    const importantBody = isV08DurableHealAnchor(target, context) || target.getLevel() >= 3;
    // Low-tier bodies remain valid emergency targets, but do not consume a finite charge for a scratch.
    if (!importantBody && missingFraction < 0.6) return 0;
    return effective * anchorMultiplier(target, context) * (1 + missingFraction);
};

const targetForCandidate = (context: IDecisionContext, candidate: IEnumeratedCandidate): Unit | undefined =>
    candidate.targetId ? context.unitsHolder.getAllUnits().get(candidate.targetId) : undefined;

const bestSingleHeal = (
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): { candidate: IEnumeratedCandidate; value: number } | undefined => {
    const rawPower = spellPower(unit, HEAL) * Math.max(0, unit.getAmountAlive());
    let best: { candidate: IEnumeratedCandidate; value: number } | undefined;
    for (const candidate of candidates) {
        // Candidate zero keeps kind="incumbent" even when its metadata identifies an exact legal spell.
        // Include it so a correct inherited Heal is never accidentally replaced by preventative Armor.
        if (candidate.spellName !== HEAL) continue;
        const target = targetForCandidate(context, candidate);
        if (!target) continue;
        const value = singleHealValue(target, rawPower, context);
        if (
            value > 0 &&
            (!best ||
                value > best.value ||
                (value === best.value &&
                    isV08DurableHealAnchor(target, context) &&
                    !isV08DurableHealAnchor(targetForCandidate(context, best.candidate)!, context)))
        ) {
            best = { candidate, value };
        }
    }
    return best;
};

const massHealValue = (unit: Unit, context: IDecisionContext): { value: number; recipients: number } => {
    const rawPower = spellPower(unit, MASS_HEAL) * Math.max(0, unit.getAmountAlive());
    let value = 0;
    let recipients = 0;
    for (const ally of context.unitsHolder.getAllAllies(unit.getTeam())) {
        if (ally.isDead() || !ally.canBeHealed() || ally.getMagicResist() === 100) continue;
        const effective = effectiveFrontHeal(ally, rawPower);
        if (effective <= 0) continue;
        recipients += 1;
        value += effective * anchorMultiplier(ally, context);
    }
    return { value, recipients };
};

const bestArmor = (
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined => {
    let best: IEnumeratedCandidate | undefined;
    let bestValue = -Infinity;
    for (const candidate of candidates) {
        if (candidate.spellName !== SPIRITUAL_ARMOR) continue;
        const target = targetForCandidate(context, candidate);
        if (!target) continue;
        // Armor on an absorption bank/bodyguard is preventative healing. Otherwise retain the old sensible
        // preference for a large live health pool, with stable candidate order breaking exact ties.
        const value = target.getCumulativeMaxHp() * anchorMultiplier(target, context);
        if (value > bestValue) {
            best = candidate;
            bestValue = value;
        }
    }
    return best;
};

/**
 * v0.4's Healer branch waits for a coarse >30% whole-stack wound and then sorts by wound percentage. Healing
 * cannot resurrect bodies: the engine restores only the current front creature, so that metric frequently saves
 * little while ignoring a damaged 500-HP Abomination or healthy-but-about-to-tank Angel. Price the health the
 * spell can actually restore, prioritize the durable screen anchors, use Mass Heal only when it beats the best
 * single charge across multiple bodies, and put preventative armor on the same anchor class.
 */
export function prioritizeV08HealerSustain(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    if (unit.getName() !== HEALER) return decision;
    const candidates = enumerateSupportCandidates(unit, context, decision);
    if (incumbentGuaranteedKill(unit, context, candidates)) return decision;

    const single = bestSingleHeal(unit, context, candidates);
    const mass = candidates.find((candidate) => candidate.spellName === MASS_HEAL);
    if (mass) {
        const massValue = massHealValue(unit, context);
        if (massValue.recipients >= 2 && massValue.value > (single?.value ?? 0)) {
            return mass.actions;
        }
    }
    if (single) return single.candidate.actions;

    return bestArmor(context, candidates)?.actions ?? decision;
}
