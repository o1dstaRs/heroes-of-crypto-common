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

import { MAX_UNIT_STACK_POWER } from "../constants";
import { FightStateManager } from "../fights/fight_state_manager";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { AppliedSpell } from "../spells/applied_spell";
import type { Unit } from "../units/unit";
import { getRandomInt } from "../utils/lib";

import { isEquipmentOrMarkerSpellName } from "./ability_helper";

export const BORROWED_GRACE_NAME = "Borrowed Grace";

/**
 * The chance a single-stack Monk lands the theft. The ability's own power is the chance at
 * MAX_UNIT_STACK_POWER, and the stacks in between interpolate — 20 / 32.5 / 45 / 57.5 / 70.
 *
 * This is deliberately NOT Unit.calculateAbilityApplyChance (power/5 * stack, i.e. 14 at one stack): the
 * card is meant to be worth carrying on a battered stack too, so the curve starts high and climbs less
 * steeply. Chakram's bounce budget takes the same liberty with its stack curve.
 */
export const BORROWED_GRACE_MIN_CHANCE = 20;

export interface IBuffStolen {
    thiefId: string;
    targetId: string;
    buffName: string;
}

/** The theft chance at this Monk's current stack, with luck and the team's ability power folded in. */
export function borrowedGraceChance(thief: Unit, synergyAbilityPowerIncrease: number): number {
    const ability = thief.getAbility(BORROWED_GRACE_NAME);
    if (!ability) {
        return 0;
    }

    const stackPower = Math.max(1, Math.min(MAX_UNIT_STACK_POWER, thief.getStackPower()));
    const perStack = (ability.getPower() - BORROWED_GRACE_MIN_CHANCE) / (MAX_UNIT_STACK_POWER - 1);
    const chance =
        BORROWED_GRACE_MIN_CHANCE + perStack * (stackPower - 1) + thief.getLuck() + synergyAbilityPowerIncrease;

    return Math.max(0, Math.min(100, chance));
}

/**
 * Whether one applied buff can be taken off its owner: a cast blessing can, worn equipment and engine
 * markers cannot (isEquipmentOrMarkerSpellName), and neither can an aura's grant — an aura is re-applied
 * on the very next refresh with Number.MAX_SAFE_INTEGER laps, so "stealing" it would be a no-op that
 * still burned the roll.
 */
export function isTakeableBuff(buff: AppliedSpell): boolean {
    if (buff.getLaps() <= 0 || buff.getLaps() === Number.MAX_SAFE_INTEGER) {
        return false;
    }

    return !isEquipmentOrMarkerSpellName(buff.getName());
}

/**
 * Resolves the theft for ONE landed shot: with the stack-scaled chance above, one random active buff is
 * taken off the target and worn by the Monk for whatever duration the buff had left. Nothing happens when
 * the target carries no takeable buff — the shot is not "wasted", it simply had nothing to take.
 */
export function processBorrowedGraceAbility(thief: Unit, target: Unit, sceneLog: ISceneLog): IBuffStolen | undefined {
    if (!thief.getAbility(BORROWED_GRACE_NAME)) {
        return undefined;
    }

    const candidates = target.getBuffs().filter(isTakeableBuff);
    if (!candidates.length) {
        return undefined;
    }

    const chance = borrowedGraceChance(
        thief,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(thief.getTeam()),
    );
    if (getRandomInt(0, 100) >= chance) {
        return undefined;
    }

    const selected = candidates[getRandomInt(0, candidates.length)];
    if (!selected || !thief.takeBuffFrom(target, selected.getName())) {
        return undefined;
    }

    sceneLog.updateLog(`${thief.getName()} took ${selected.getName()} from ${target.getName()}`);

    return { thiefId: thief.getId(), targetId: target.getId(), buffName: selected.getName() };
}
