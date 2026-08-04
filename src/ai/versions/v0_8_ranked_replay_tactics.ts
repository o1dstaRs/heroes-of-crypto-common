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
import { SpellPowerType } from "../../spells/spell_properties";
import { isSpellUsableByCaster } from "../../spells/spell_helper";
import type { Unit } from "../../units/unit";
import type { IDecisionContext } from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";

/** Exact-version rollback scope for the tactics distilled from the four recent ranked replays. */
export const V08_RANKED_REPLAY_TACTICS_VERSIONS_ENV = "V08_RANKED_REPLAY_TACTICS_VERSIONS";
export const V08_RANKED_REPLAY_TIEBREAK_EPSILON_ENV = "SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON";
export const V08_RANKED_REPLAY_TIEBREAK_VERSIONS_ENV = "SEARCH_V08_RANKED_REPLAY_TIEBREAK_VERSIONS";
export const V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV = "SEARCH_V08_RANKED_REPLAY_TIEBREAK_GRIDS";

const PLAYABLE_GRID_TYPES = new Set<number>([
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
]);

const DIRECT_ATTACK_TYPES = new Set<GameAction["type"]>(["melee_attack", "range_attack", "area_throw_attack"]);
const DIRECT_CANDIDATE_KINDS = new Set<IEnumeratedCandidate["kind"]>(["incumbent", "melee", "shot", "area_throw"]);
const FOCUS_DAMAGE_FLOOR = 0.9;
const FOCUS_WOUNDED_FLOOR = 0.25;
const DIVE_DAMAGE_FLOOR = 0.85;

/** An absent scope preserves all maps; an explicitly blank or malformed numeric GridVals CSV fails closed. */
export function v08RankedReplayTiebreakSupportsGrid(gridType: number): boolean {
    const raw = process.env[V08_RANKED_REPLAY_TIEBREAK_GRIDS_ENV];
    if (raw === undefined) return true;

    const values = raw.split(",").map((value) => value.trim());
    if (
        values.some((value) => !/^\d+$/.test(value)) ||
        values.map(Number).some((value) => !PLAYABLE_GRID_TYPES.has(value))
    ) {
        return false;
    }
    return values.map(Number).includes(gridType);
}

/** Immutable base-card lookup shared by the runtime gate and the replay evaluator's public-roster metadata. */
export function isV08ReplayNativeRangedCreatureName(name: string): boolean {
    const creatureId = creatureIdForName(name);
    return creatureId !== undefined && creatureInfo(creatureId)?.ranged === true;
}

/** Stable, symmetric matchup gate: focus-fire search is useful when either drafted army owns a native shooter. */
export function v08ReplayNativeRangedMatchupEligible(context: IDecisionContext): boolean {
    return [...context.unitsHolder.getAllUnits().values()].some(
        (candidate) => !candidate.isSummoned() && isV08ReplayNativeRangedCreatureName(candidate.getName()),
    );
}

const isDirectAttack = (candidate: Readonly<IEnumeratedCandidate>): boolean =>
    DIRECT_CANDIDATE_KINDS.has(candidate.kind) &&
    candidate.actions.some((action) => DIRECT_ATTACK_TYPES.has(action.type)) &&
    !!candidate.targetId &&
    Number.isFinite(candidate.features.expectedDamage) &&
    candidate.features.expectedDamage > 0;

/**
 * Fraction of the original stack already removed, including damage to the surviving front creature. This is
 * public fight state, so both direct AI and the ranked server derive exactly the same focus-fire signal.
 */
export function v08ReplayTargetWoundedFraction(target: Unit): number {
    const alive = Math.max(0, target.getAmountAlive());
    const died = Math.max(0, target.getAmountDied());
    const originalAmount = alive + died;
    if (!originalAmount || target.isDead()) return target.isDead() ? 1 : 0;

    const maxHp = Math.max(0, target.getMaxHp());
    const damagedFrontFraction = maxHp > 0 ? Math.max(0, Math.min(1, (maxHp - target.getHp()) / maxHp)) : 0;
    return Math.max(0, Math.min(1, (died + damagedFrontFraction) / originalAmount));
}

/**
 * Coarse role value used only to break near-equal legal attacks. Remaining spell charges, active auras and
 * ranged output make a unit strategically valuable; Break and spent spellbooks disappear through Unit's live
 * accessors. Raw unit names and factions are intentionally absent so the lesson transfers to future rosters.
 */
export function v08ReplayTargetRoleValue(target: Unit): number {
    const usableSpells =
        target.getCanCastSpells() && target.getSpellsCount() > 0
            ? target.getSpells().filter((spell) => isSpellUsableByCaster(target, spell))
            : [];
    const hasSupportSpell = usableSpells.some(
        (spell) =>
            spell.isBuff() ||
            spell.isSummon() ||
            spell.getPowerType() === SpellPowerType.HEAL ||
            spell.getPowerType() === SpellPowerType.RESURRECT,
    );
    let value = 0;
    if (usableSpells.length) value += 4 + Math.min(2, usableSpells.length - 1);
    if (hasSupportSpell) value += 2;
    if (target.isRangeCapable() && target.getRangeShots() > 0) value += 4;
    value += Math.min(6, target.getAuraEffects().length * 3);
    return value;
}

function rankedReplayCandidates(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): readonly IEnumeratedCandidate[] {
    return enumerateCandidates(unit, context, decision, {
        maxMoveDestinations: 1,
        maxMeleePairs: 16,
        maxShotAims: 12,
        maxAreaThrowCells: 8,
        preserveAttackTargetCoverage: true,
        enrichIncumbentMetadata: true,
    }).candidates;
}

function directIncumbent(candidates: readonly IEnumeratedCandidate[]): IEnumeratedCandidate | undefined {
    const incumbent = candidates[0];
    return incumbent && isDirectAttack(incumbent) ? incumbent : undefined;
}

/**
 * Continue a coordinated attack when it finishes a wounded enemy, or when that stack has already lost at least
 * 25% of its original strength and the legal alternative retains at least 90% of immediate damage. Existing
 * guaranteed kills and aggregate splash remain protected.
 */
export function selectV08ReplayFocusFireCandidate(
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    const incumbent = directIncumbent(candidates);
    if (!incumbent?.targetId || incumbent.features.expectedKill === 1) return undefined;

    const incumbentTarget = context.unitsHolder.getAllUnits().get(incumbent.targetId);
    if (!incumbentTarget || v08ReplayTargetWoundedFraction(incumbentTarget) > 0) return undefined;

    const attackAction = incumbent.actions.find((action) => DIRECT_ATTACK_TYPES.has(action.type));
    const attackerId =
        attackAction?.type === "melee_attack" ||
        attackAction?.type === "range_attack" ||
        attackAction?.type === "area_throw_attack"
            ? attackAction.attackerId
            : undefined;
    const attacker = attackerId ? context.unitsHolder.getAllUnits().get(attackerId) : undefined;
    const incumbentUsesSplash =
        attackAction?.type === "area_throw_attack" ||
        (attackAction?.type === "range_attack" &&
            !!attacker &&
            (attacker.hasAbilityActive("Area Throw") ||
                attacker.hasAbilityActive("Large Caliber") ||
                attacker.hasAbilityActive("Through Shot")));
    let best: IEnumeratedCandidate | undefined;
    let bestWoundedFraction = 0;
    let bestRoleValue = 0;

    for (const candidate of candidates.slice(1)) {
        if (!isDirectAttack(candidate) || candidate.targetId === incumbent.targetId) continue;
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId!);
        if (!target || target.isDead()) continue;
        const woundedFraction = v08ReplayTargetWoundedFraction(target);
        if (woundedFraction <= 0) continue;
        if (candidate.features.expectedKill !== 1 && woundedFraction < FOCUS_WOUNDED_FLOOR) continue;

        const keepsEnoughDamage =
            candidate.features.expectedDamage >=
            incumbent.features.expectedDamage * (incumbentUsesSplash ? 1 : FOCUS_DAMAGE_FLOOR);
        if (candidate.features.expectedKill !== 1 && !keepsEnoughDamage) continue;

        const roleValue = v08ReplayTargetRoleValue(target);
        if (
            !best ||
            candidate.features.expectedKill > best.features.expectedKill ||
            (candidate.features.expectedKill === best.features.expectedKill &&
                (woundedFraction > bestWoundedFraction ||
                    (woundedFraction === bestWoundedFraction &&
                        (roleValue > bestRoleValue ||
                            (roleValue === bestRoleValue &&
                                candidate.features.expectedDamage > best.features.expectedDamage)))))
        ) {
            best = candidate;
            bestWoundedFraction = woundedFraction;
            bestRoleValue = roleValue;
        }
    }
    return best;
}

/**
 * A lightly chipped incumbent target used to suppress every focus alternative. Preserve established focus once
 * the incumbent is 25% wounded, but carry one clear liquidation alternative into rollout search while it is only
 * lightly wounded: either an expected finish, or a materially more wounded high-value stack at comparable damage.
 */
export function selectV08ReplayLightWoundFocusCandidate(
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    const incumbent = directIncumbent(candidates);
    if (!incumbent?.targetId || incumbent.features.expectedKill === 1) return undefined;
    const incumbentTarget = context.unitsHolder.getAllUnits().get(incumbent.targetId);
    if (!incumbentTarget || incumbentTarget.isDead()) return undefined;
    const incumbentWoundedFraction = v08ReplayTargetWoundedFraction(incumbentTarget);
    if (incumbentWoundedFraction <= 0 || incumbentWoundedFraction >= FOCUS_WOUNDED_FLOOR) return undefined;
    const incumbentRoleValue = v08ReplayTargetRoleValue(incumbentTarget);

    const attackAction = incumbent.actions.find((action) => DIRECT_ATTACK_TYPES.has(action.type));
    const attackerId =
        attackAction?.type === "melee_attack" ||
        attackAction?.type === "range_attack" ||
        attackAction?.type === "area_throw_attack"
            ? attackAction.attackerId
            : undefined;
    const attacker = attackerId ? context.unitsHolder.getAllUnits().get(attackerId) : undefined;
    const incumbentUsesSplash =
        attackAction?.type === "area_throw_attack" ||
        (attackAction?.type === "range_attack" &&
            !!attacker &&
            (attacker.hasAbilityActive("Area Throw") ||
                attacker.hasAbilityActive("Large Caliber") ||
                attacker.hasAbilityActive("Through Shot")));

    let best: IEnumeratedCandidate | undefined;
    let bestWoundedFraction = 0;
    let bestRoleValue = 0;
    for (const candidate of candidates.slice(1)) {
        if (!isDirectAttack(candidate) || candidate.targetId === incumbent.targetId) continue;
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId!);
        if (!target || target.isDead()) continue;
        const woundedFraction = v08ReplayTargetWoundedFraction(target);
        const roleValue = v08ReplayTargetRoleValue(target);
        const expectedFinish = candidate.features.expectedKill === 1;
        const highValueFocus =
            woundedFraction >= FOCUS_WOUNDED_FLOOR &&
            woundedFraction > incumbentWoundedFraction &&
            roleValue >= incumbentRoleValue + 3 &&
            candidate.features.expectedDamage >=
                incumbent.features.expectedDamage * (incumbentUsesSplash ? 1 : FOCUS_DAMAGE_FLOOR);
        if (!expectedFinish && !highValueFocus) continue;

        if (
            !best ||
            candidate.features.expectedKill > best.features.expectedKill ||
            (candidate.features.expectedKill === best.features.expectedKill &&
                (woundedFraction > bestWoundedFraction ||
                    (woundedFraction === bestWoundedFraction &&
                        (roleValue > bestRoleValue ||
                            (roleValue === bestRoleValue &&
                                candidate.features.expectedDamage > best.features.expectedDamage)))))
        ) {
            best = candidate;
            bestWoundedFraction = woundedFraction;
            bestRoleValue = roleValue;
        }
    }
    return best;
}

/** Focus candidates are safe shortlist priors; backline dives remain eligible only when leaf search retains them. */
export function selectV08ReplayShortlistFocusCandidate(
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    return (
        selectV08ReplayFocusFireCandidate(context, candidates) ??
        selectV08ReplayLightWoundFocusCandidate(context, candidates)
    );
}

/**
 * Preserve the ordinary leaf winner and reserve at most one distinct replay challenger when its immediate-leaf
 * value is already within epsilon. Both alternatives then receive the normal full rollout evaluation.
 */
export function reserveV08ReplayLeafChallenger<T extends { index: number; score: number }>(
    ranked: readonly T[],
    preferredIndex: number | undefined,
    capacity: number,
    epsilon: number,
): readonly T[] {
    const boundedCapacity = Math.max(0, Math.floor(capacity));
    const incumbent = ranked.slice(0, boundedCapacity);
    if (!boundedCapacity || preferredIndex === undefined || !Number.isFinite(epsilon) || epsilon < 0) return incumbent;
    if (incumbent.some((entry) => entry.index === preferredIndex)) return incumbent;
    const preferred = ranked.find((entry) => entry.index === preferredIndex);
    const leafBest = ranked[0];
    if (!preferred || !leafBest || preferred.score + epsilon < leafBest.score) return incumbent;
    return [...incumbent, preferred];
}

/**
 * In the opening two laps, a flyer or genuinely fast melee stack may bypass a generic front target for a much
 * more valuable shooter, caster, support or aura source. The move must retain at least 85% immediate damage, and an
 * existing guaranteed kill always wins.
 */
export function selectV08ReplayBacklineDiveCandidate(
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
): IEnumeratedCandidate | undefined {
    const currentLap = context.fightProperties?.getCurrentLap() ?? 0;
    const incumbent = directIncumbent(candidates);
    if (
        !incumbent?.targetId ||
        incumbent.features.expectedKill === 1 ||
        currentLap < 1 ||
        currentLap > 2 ||
        (!unit.canFly() && unit.getSteps() < 6 && !unit.hasAbilityActive("Rapid Charge")) ||
        !incumbent.actions.some((action) => action.type === "melee_attack")
    ) {
        return undefined;
    }

    const incumbentTarget = context.unitsHolder.getAllUnits().get(incumbent.targetId);
    if (!incumbentTarget) return undefined;
    const incumbentRoleValue = v08ReplayTargetRoleValue(incumbentTarget);
    let best: IEnumeratedCandidate | undefined;
    let bestRoleValue = incumbentRoleValue;

    for (const candidate of candidates.slice(1)) {
        if (
            candidate.kind !== "melee" ||
            !candidate.targetId ||
            candidate.targetId === incumbent.targetId ||
            candidate.features.expectedDamage < incumbent.features.expectedDamage * DIVE_DAMAGE_FLOOR
        ) {
            continue;
        }
        const target = context.unitsHolder.getAllUnits().get(candidate.targetId);
        if (!target || target.isDead()) continue;
        const roleValue = v08ReplayTargetRoleValue(target);
        if (roleValue <= 0 || roleValue < incumbentRoleValue + 3) continue;

        if (
            !best ||
            candidate.features.expectedKill > best.features.expectedKill ||
            (candidate.features.expectedKill === best.features.expectedKill &&
                (roleValue > bestRoleValue ||
                    (roleValue === bestRoleValue && candidate.features.expectedDamage > best.features.expectedDamage)))
        ) {
            best = candidate;
            bestRoleValue = roleValue;
        }
    }
    return best;
}

/**
 * Return a replay-qualified scored candidate only when rollout evaluation already places it within epsilon of
 * the selected best. Search remains authoritative; this helper merely supplies a deterministic tactical prior
 * for candidates whose measured values are effectively tied.
 */
export function selectV08ReplayNearTieCandidateIndex(
    unit: Unit,
    context: IDecisionContext,
    candidates: readonly IEnumeratedCandidate[],
    means: readonly number[],
    bestIndex: number,
    epsilon: number,
    overrideGate: number,
    eligibleIndices?: ReadonlySet<number>,
): number | undefined {
    if (
        candidates.length !== means.length ||
        bestIndex <= 0 ||
        bestIndex >= candidates.length ||
        !Number.isFinite(epsilon) ||
        epsilon < 0 ||
        !Number.isFinite(overrideGate) ||
        overrideGate < 0 ||
        !Number.isFinite(means[bestIndex]) ||
        means[bestIndex] === -Infinity ||
        !Number.isFinite(means[0]) ||
        means[bestIndex] - means[0] < overrideGate
    ) {
        return undefined;
    }

    const focus = selectV08ReplayFocusFireCandidate(context, candidates);
    const lightWoundFocus = selectV08ReplayLightWoundFocusCandidate(context, candidates);
    const dive = selectV08ReplayBacklineDiveCandidate(unit, context, candidates);
    for (const preferred of [focus, lightWoundFocus, dive]) {
        if (!preferred) continue;
        const index = candidates.indexOf(preferred);
        if (index <= 0 || (eligibleIndices && !eligibleIndices.has(index))) continue;
        const score = means[index];
        if (
            Number.isFinite(score) &&
            score !== -Infinity &&
            score - means[0] >= overrideGate &&
            score + epsilon >= means[bestIndex]
        ) {
            return index;
        }
    }
    return undefined;
}

/** Focus fire takes precedence; the opening dive is considered only when no wounded-stack continuation applies. */
export function prioritizeV08RankedReplayCombatTactics(
    unit: Unit,
    context: IDecisionContext,
    decision: GameAction[],
): GameAction[] {
    const attack = decision.find(
        (
            action,
        ): action is Extract<GameAction, { type: "melee_attack" }> | Extract<GameAction, { type: "range_attack" }> =>
            action.type === "melee_attack" || action.type === "range_attack",
    );
    if (!attack) return decision;
    const incumbentTargetId = attack.targetId;

    const enemies = context.unitsHolder.getAllAllies(unit.getOppositeTeam()).filter((enemy) => !enemy.isDead());
    const hasWoundedAlternative = enemies.some(
        (enemy) => enemy.getId() !== incumbentTargetId && v08ReplayTargetWoundedFraction(enemy) > 0,
    );
    const currentLap = context.fightProperties?.getCurrentLap() ?? 0;
    const incumbentTarget = context.unitsHolder.getAllUnits().get(incumbentTargetId);
    const canConsiderDive =
        attack.type === "melee_attack" &&
        currentLap >= 1 &&
        currentLap <= 2 &&
        (unit.canFly() || unit.getSteps() >= 6 || unit.hasAbilityActive("Rapid Charge")) &&
        !!incumbentTarget &&
        enemies.some(
            (enemy) =>
                enemy.getId() !== incumbentTargetId &&
                v08ReplayTargetRoleValue(enemy) >= v08ReplayTargetRoleValue(incumbentTarget) + 3,
        );
    if (!hasWoundedAlternative && !canConsiderDive) return decision;

    const candidates = rankedReplayCandidates(unit, context, decision);
    const focus = selectV08ReplayFocusFireCandidate(context, candidates);
    if (focus) return focus.actions;
    return selectV08ReplayBacklineDiveCandidate(unit, context, candidates)?.actions ?? decision;
}
