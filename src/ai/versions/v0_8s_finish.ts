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

import { NUMBER_OF_LAPS_FIRST_ARMAGEDDON } from "../../constants";
import type { GameAction } from "../../engine/actions";
import type { FightProperties } from "../../fights/fight_properties";
import { canUnitRespondToMelee } from "../../handlers/melee_response";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import type { IDecisionContext } from "../ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../candidates";
import { isV08DirectCombatDecision } from "./v0_8_dominant_finish";

/** Start eliminating the hardest remaining stack with six complete laps of pre-wave budget. */
export const V08_TARGET_PRESSURE_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 6;

/** From this lap onward v0.8s permits only a positive-damage attack, then an advance if no attack exists. */
export const V08S_URGENT_FINISH_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 3;

const DELIVERY_EPSILON = 1e-9;
/**
 * A melee by the unit who has Dulling Defense permanently cuts a survivor's base attack. Count that as
 * extra remaining work so, among fresh stacks, he would rather swing at one the blow can still dull.
 * Modest on purpose: a much harder stack that the blow cannot dull is still the one to finish.
 */
const DULLING_SWING_WORK_BONUS = 0.2;

interface IScheduledDelivery {
    readonly candidate: IEnumeratedCandidate;
    readonly index: number;
    readonly incumbent: boolean;
    readonly expectedDamage: number;
    readonly expectedKill: 0 | 1;
    readonly deliveryDamage: number;
    readonly stationary: boolean;
    readonly target: Unit;
    readonly remainingFraction: number;
    readonly unsafeDullingMelee: boolean;
    readonly dullingSwing: boolean;
    readonly work: number;
}

const finitePositive = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

const isMeleeDelivery = (candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.some((action) => action.type === "melee_attack");

const isStationaryDelivery = (candidate: IEnumeratedCandidate): boolean =>
    !candidate.actions.some((action) => action.type === "move_unit");

/** The knight dulls the attacker only by answering. A spent, stunned, or otherwise silent knight does not. */
const knightAnswersThisMelee = (
    attacker: Unit,
    target: Unit,
    fightProperties?: Pick<FightProperties, "hasAlreadyRepliedAttack">,
): boolean => target.hasAbilityActive("Dulling Defense") && canUnitRespondToMelee(attacker, target, fightProperties);

/**
 * His own swing permanently cuts the struck survivor's base attack. A killing blow does not: the stack is
 * already gone, and a unit already at 1 attack cannot lose any more.
 */
const actorDullingSwingCuts = (
    actor: Unit,
    target: Unit,
    candidate: IEnumeratedCandidate,
    expectedKill: 0 | 1,
): boolean =>
    expectedKill === 0 &&
    isMeleeDelivery(candidate) &&
    actor.hasAbilityActive("Dulling Defense") &&
    actor.getAbilityPower("Dulling Defense") > 0 &&
    target.getBaseAttack() > 1;

const targetDeliveryDamage = (candidate: IEnumeratedCandidate): number => {
    if (candidate.actions.some((action) => action.type === "range_attack")) {
        const primaryDamage = finitePositive(candidate.shotFeatures?.primaryTargetDamage);
        if (primaryDamage > 0) return primaryDamage;
    }
    return finitePositive(candidate.features?.expectedDamage);
};

function targetWork(
    actor: Unit,
    target: Unit,
    candidate: IEnumeratedCandidate,
    deliveryDamage: number,
    currentLap: number,
    fightProperties?: Pick<FightProperties, "hasAlreadyRepliedAttack">,
    expectedKill: 0 | 1 = 0,
): number {
    const remainingPreArmageddonActivations = Math.max(
        1,
        NUMBER_OF_LAPS_FIRST_ARMAGEDDON - Math.max(0, Math.floor(currentLap)),
    );
    const regenerates = target.hasAbilityActive("Wild Regeneration") || target.hasBuffActive("Wild Regeneration");
    const regenerationReserve = regenerates ? Math.max(0, target.getMaxHp()) * remainingPreArmageddonActivations : 0;
    const baseWork =
        (Math.max(0, target.getCumulativeHp()) + regenerationReserve) / Math.max(deliveryDamage, DELIVERY_EPSILON);
    let work = baseWork;
    // Answering costs the attacker permanent attack, so later hits into him are weaker. A silent knight does not.
    if (isMeleeDelivery(candidate) && knightAnswersThisMelee(actor, target, fightProperties)) {
        const dullingPower = Math.max(0, target.getAbilityPower("Dulling Defense"));
        const futureHits = Math.max(0, Math.ceil(baseWork) - 1);
        const dullingTax = Math.min(2, (dullingPower / Math.max(1, actor.getAttack())) * (futureHits / 2));
        work *= 1 + dullingTax;
    }
    if (actorDullingSwingCuts(actor, target, candidate, expectedKill)) {
        work *= 1 + DULLING_SWING_WORK_BONUS;
    }
    return work;
}

/** Per-target delivery preference: kill, incumbent, a silent target over one who will answer, damage, the knight's own dulling swing, stationary attack, then stable order. */
function deliveryPrecedes(left: IScheduledDelivery, right: IScheduledDelivery): boolean {
    const leftKill = left.expectedKill;
    const rightKill = right.expectedKill;
    return (
        leftKill > rightKill ||
        (leftKill === rightKill &&
            ((left.incumbent && !right.incumbent) ||
                (left.incumbent === right.incumbent &&
                    ((!left.unsafeDullingMelee && right.unsafeDullingMelee) ||
                        (left.unsafeDullingMelee === right.unsafeDullingMelee &&
                            (left.expectedDamage > right.expectedDamage ||
                                (left.expectedDamage === right.expectedDamage &&
                                    ((left.dullingSwing && !right.dullingSwing) ||
                                        (left.dullingSwing === right.dullingSwing &&
                                            ((left.stationary && !right.stationary) ||
                                                (left.stationary === right.stationary &&
                                                    left.index < right.index)))))))))))
    );
}

/**
 * Least-deadline-slack target scheduler for the measurement alias. A kill available now is globally first.
 * Otherwise the target with the greatest remaining attack-work wins, including one Wild Regeneration reserve
 * and the melee cost of Dulling Defense when that unit will answer. The actor's own swing is a reason to
 * attack: a melee that still cuts base attack is preferred over an equal delivery that does not. Ties prefer
 * damage, that swing, stationary delivery, then stable order.
 */
export function selectV08STargetPressureCandidate(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    currentLap = V08_TARGET_PRESSURE_START_LAP,
    fightProperties?: Pick<FightProperties, "hasAlreadyRepliedAttack">,
): IEnumeratedCandidate | undefined {
    const bestByTarget = new Map<string, IScheduledDelivery>();
    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const pressureTargetId = candidate.pressureTargetId ?? candidate.targetId;
        if (!pressureTargetId || !isV08DirectCombatDecision(candidate.actions)) continue;
        const target = unitsHolder.getAllUnits().get(pressureTargetId);
        const expectedDamage = finitePositive(candidate.features?.expectedDamage);
        const deliveryDamage = targetDeliveryDamage(candidate);
        if (
            !target ||
            target.isDead() ||
            target.getTeam() === actor.getTeam() ||
            expectedDamage <= 0 ||
            deliveryDamage <= 0
        ) {
            continue;
        }
        const expectedKill = candidate.pressureExpectedKill ?? candidate.features.expectedKill;
        const originalHp =
            Math.max(0, target.getAmountAlive() + target.getAmountDied()) * Math.max(0, target.getMaxHp());
        const remainingFraction = originalHp > 0 ? Math.min(1, target.getCumulativeHp() / originalHp) : 1;
        const unsafeDullingMelee =
            expectedKill === 0 && isMeleeDelivery(candidate) && knightAnswersThisMelee(actor, target, fightProperties);
        const dullingSwing = actorDullingSwingCuts(actor, target, candidate, expectedKill);
        const delivery: IScheduledDelivery = {
            candidate,
            index,
            incumbent: candidate.kind === "incumbent",
            expectedDamage,
            expectedKill,
            deliveryDamage,
            stationary: isStationaryDelivery(candidate),
            target,
            remainingFraction,
            unsafeDullingMelee,
            dullingSwing,
            work: targetWork(actor, target, candidate, deliveryDamage, currentLap, fightProperties, expectedKill),
        };
        const prior = bestByTarget.get(pressureTargetId);
        if (!prior || deliveryPrecedes(delivery, prior)) {
            bestByTarget.set(pressureTargetId, delivery);
        }
    }

    const deliveries = [...bestByTarget.values()];
    if (!deliveries.length) return undefined;
    const immediateKills = deliveries.filter(({ expectedKill }) => expectedKill === 1);
    // Answering with Dulling Defense permanently cuts the attacker's base attack. Do not let that cost make a
    // fresh knight who can still answer look more urgent: use another positive target while one exists. A knight
    // who will not answer has no such cost. Once the answering stack is materially wounded (or it is the only
    // target), preserve focus and finish it.
    const nonDullingDeliveries = deliveries.filter(
        ({ remainingFraction, unsafeDullingMelee }) => !unsafeDullingMelee || remainingFraction <= 0.5,
    );
    const eligible = immediateKills.length
        ? immediateKills
        : nonDullingDeliveries.length
          ? nonDullingDeliveries
          : deliveries;
    // Once damage has been invested into a reachable stack, finish that work before opening a fresh target. This
    // prevents late Troll -> Abomination and Abomination -> Goblin Knight switches from discarding several laps
    // of progress. If every target is fresh, retain the hard-stack-first deadline policy.
    const wounded = immediateKills.length
        ? eligible
        : eligible.filter(({ remainingFraction }) => remainingFraction < 1 - DELIVERY_EPSILON);
    const focused = wounded.length ? wounded : eligible;
    focused.sort((left, right) => {
        if (wounded.length && left.remainingFraction !== right.remainingFraction) {
            return left.remainingFraction - right.remainingFraction;
        }
        if (!immediateKills.length && left.work !== right.work) return right.work - left.work;
        if (left.expectedDamage !== right.expectedDamage) return right.expectedDamage - left.expectedDamage;
        if (left.dullingSwing !== right.dullingSwing) return left.dullingSwing ? -1 : 1;
        if (left.stationary !== right.stationary) return left.stationary ? -1 : 1;
        return left.index - right.index;
    });
    return focused[0]?.candidate;
}

/**
 * The a13 native finish layer originally lived only on the `v0.8s` measurement alias.
 * It is pure strategy behavior (not rollout scoring), so production v0.8 bakes the same
 * layer and keeps SearchDriver free to compare the inherited action as candidate zero
 * before the universal final sprint.
 */
export function prioritizeV08A13FinishDecision(
    unit: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
): GameAction[] {
    const currentLap = context.fightProperties?.getCurrentLap() ?? 0;
    if (!Number.isFinite(currentLap) || currentLap < V08S_URGENT_FINISH_START_LAP) {
        return incumbent;
    }

    const candidates = enumerateCandidates(unit, context, incumbent, {
        maxMoveDestinations: 1,
        maxMeleePairs: 8,
        maxShotAims: 6,
        maxAreaThrowCells: 4,
        // The terminal sprint gets one exact live move-then-shot escape hatch. Hypothetical rollout turns retain
        // the historical catalog: rediscovering every post-move ray there is both redundant and expensive.
        maxMoveShotComposites: context.decisionOrigin === "rollout" ? 0 : 1,
        discoverMoveShotTargetsAfterMove: context.decisionOrigin !== "rollout",
        enrichIncumbentMetadata: true,
        preserveAttackTargetCoverage: true,
    }).candidates;
    const attack = selectV08STargetPressureCandidate(
        unit,
        context.unitsHolder,
        candidates,
        currentLap,
        context.fightProperties,
    );
    if (attack) return attack.actions;
    const advance = candidates.find((candidate) => candidate.kind === "move");
    return advance?.actions ?? incumbent;
}
