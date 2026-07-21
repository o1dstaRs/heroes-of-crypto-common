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
import type { IEnumeratedCandidate } from "../candidates";
import type { Unit } from "../../units/unit";
import type { UnitsHolder } from "../../units/units_holder";
import { isV08DirectCombatDecision } from "./v0_8_dominant_finish";

/** Start eliminating the hardest remaining stack with six complete laps of pre-wave budget. */
export const V08_TARGET_PRESSURE_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 6;

/** From this lap onward v0.8s permits only a positive-damage attack, then an advance if no attack exists. */
export const V08S_URGENT_FINISH_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 3;

const DELIVERY_EPSILON = 1e-9;

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
    readonly work: number;
}

const finitePositive = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

const isMeleeDelivery = (candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.some((action) => action.type === "melee_attack");

const isStationaryDelivery = (candidate: IEnumeratedCandidate): boolean =>
    !candidate.actions.some((action) => action.type === "move_unit");

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
): number {
    const remainingPreArmageddonActivations = Math.max(
        1,
        NUMBER_OF_LAPS_FIRST_ARMAGEDDON - Math.max(0, Math.floor(currentLap)),
    );
    const regenerates = target.hasAbilityActive("Wild Regeneration") || target.hasBuffActive("Wild Regeneration");
    const regenerationReserve = regenerates ? Math.max(0, target.getMaxHp()) * remainingPreArmageddonActivations : 0;
    const baseWork =
        (Math.max(0, target.getCumulativeHp()) + regenerationReserve) / Math.max(deliveryDamage, DELIVERY_EPSILON);
    if (!isMeleeDelivery(candidate) || !target.hasAbilityActive("Dulling Defense")) {
        return baseWork;
    }

    const dullingPower = Math.max(0, target.getAbilityPower("Dulling Defense"));
    const futureHits = Math.max(0, Math.ceil(baseWork) - 1);
    const dullingTax = Math.min(2, (dullingPower / Math.max(1, actor.getAttack())) * (futureHits / 2));
    return baseWork * (1 + dullingTax);
}

/** Per-target delivery preference: kill, expected damage, stationary attack, then stable enumeration order. */
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
                                    ((left.stationary && !right.stationary) ||
                                        (left.stationary === right.stationary && left.index < right.index)))))))))
    );
}

/**
 * Least-deadline-slack target scheduler for the measurement alias. A kill available now is globally first.
 * Otherwise the target with the greatest remaining attack-work wins, including one Wild Regeneration reserve
 * and the compounding melee cost of Dulling Defense. Ties prefer damage, stationary delivery, then stable order.
 */
export function selectV08STargetPressureCandidate(
    actor: Unit,
    unitsHolder: UnitsHolder,
    candidates: readonly IEnumeratedCandidate[],
    currentLap = V08_TARGET_PRESSURE_START_LAP,
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
            expectedKill === 0 && isMeleeDelivery(candidate) && target.hasAbilityActive("Dulling Defense");
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
            work: targetWork(actor, target, candidate, deliveryDamage, currentLap),
        };
        const prior = bestByTarget.get(pressureTargetId);
        if (!prior || deliveryPrecedes(delivery, prior)) {
            bestByTarget.set(pressureTargetId, delivery);
        }
    }

    const deliveries = [...bestByTarget.values()];
    if (!deliveries.length) return undefined;
    const immediateKills = deliveries.filter(({ expectedKill }) => expectedKill === 1);
    // Dulling Defense permanently destroys the attacker's base attack. Do not let that delivery cost make a
    // fresh Goblin Knight look *more* urgent to weak melee: use another positive target while one exists. Once
    // the Dulling stack is materially wounded (or it is the only target), preserve focus and finish it.
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
        if (left.stationary !== right.stationary) return left.stationary ? -1 : 1;
        return left.index - right.index;
    });
    return focused[0]?.candidate;
}
