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

import { AbilityType } from "./ability_properties";
import { FightStateManager } from "../fights/fight_state_manager";
import { Grid } from "../grid/grid";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { UnitsHolder } from "../units/units_holder";
import * as HoCLib from "../utils/lib";

export const STUN_AURA_ABILITY_NAME = "Stun Aura";
/** The debuff the aura refresh lands on everyone standing in the field (see UnitsHolder aura pass). */
export const STUN_AURA_DEBUFF_NAME = "Stun Aura";

/**
 * The unit projecting the Stun Aura onto `targetUnit`, or undefined when the field has no live owner.
 *
 * The aura debuff carries its source cell in the applied spell's two properties (UnitsHolder stamps it
 * during the aura refresh), exactly like the Flesh Shield aura — so the owner is resolved from the grid
 * rather than by re-scanning neighbours, and a field whose owner died or moved away resolves to nothing.
 */
export function findStunAuraOwner(targetUnit: Unit, grid: Grid, unitsHolder: UnitsHolder): Unit | undefined {
    const auraDebuff = targetUnit.getDebuff(STUN_AURA_DEBUFF_NAME);
    if (!auraDebuff) {
        return undefined;
    }

    const x = auraDebuff.getFirstSpellProperty();
    const y = auraDebuff.getSecondSpellProperty();
    if (x === undefined || y === undefined) {
        return undefined;
    }

    const ownerId = grid.getOccupantUnitId({ x, y });
    if (!ownerId || ownerId === targetUnit.getId()) {
        return undefined;
    }

    const owner = unitsHolder.getAllUnits().get(ownerId);
    if (
        !owner ||
        owner.isDead() ||
        owner.getTeam() === targetUnit.getTeam() ||
        !owner.hasAbilityActive(STUN_AURA_ABILITY_NAME)
    ) {
        return undefined;
    }

    return owner;
}

/**
 * Engine-identical marginal chance that the field seizes `targetUnit` at its turn start.
 *
 * Deliberately the Squire's own Stun formula (calculateStunApplyChance): the owner's stack-scaled ability
 * power plus its luck, amplified against Mechanisms, and cut by the target's status resist. The ONLY
 * difference is the configured power — 25 against the Squire's 35 — so the field is a flat 10 points
 * weaker than a Squire's stun at the same stack and luck.
 */
export function calculateStunAuraApplyChance(
    auraOwner: Unit,
    targetUnit: Unit,
    additionalAbilityPower: number,
): number {
    const auraAbility = auraOwner.getAbility(STUN_AURA_ABILITY_NAME);
    if (!auraAbility) {
        return 0;
    }

    const amplifier = targetUnit.hasAbilityActive("Mechanism") ? 1.5 : 1;
    return Math.max(
        0,
        Math.min(
            100,
            auraOwner.calculateAbilityApplyChance(auraAbility, additionalAbilityPower) *
                amplifier *
                (1 - targetUnit.getStatusResist() / 100),
        ),
    );
}

/** A landed field stun, for the caller to turn into its own engine event. */
export interface IStunAuraResult {
    stunned: boolean;
    laps: number;
}

/**
 * Roll the Stun Aura against a unit whose turn is starting. Applies the same Stun effect the Squire's
 * ability applies, so everything downstream — the skip, the icon, status resist, dispels — behaves
 * identically. A unit already stunned (or immune) is left alone.
 */
export function processStunAuraAbility(
    targetUnit: Unit,
    grid: Grid,
    unitsHolder: UnitsHolder,
    sceneLog: ISceneLog,
    rollPercent: () => number = () => HoCLib.getRandomInt(0, 100),
): IStunAuraResult {
    const result: IStunAuraResult = { stunned: false, laps: 0 };
    if (targetUnit.isDead()) {
        return result;
    }

    const owner = findStunAuraOwner(targetUnit, grid, unitsHolder);
    if (!owner) {
        return result;
    }

    const auraAbility = owner.getAbility(STUN_AURA_ABILITY_NAME);
    const stunEffect = auraAbility?.getEffect();
    if (!auraAbility || !stunEffect || auraAbility.getType() !== AbilityType.DEBUFF_AURA) {
        return result;
    }
    if (targetUnit.hasEffectActive(stunEffect.getName())) {
        return result;
    }

    const chance = calculateStunAuraApplyChance(
        owner,
        targetUnit,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(owner.getTeam()),
    );
    if (rollPercent() >= chance) {
        return result;
    }

    // The stun lands on the unit whose turn is STARTING, so it costs that whole activation — the same
    // shape the Stun ability gets when it catches the currently active unit.
    stunEffect.extend();
    if (!targetUnit.applyEffect(stunEffect)) {
        return result;
    }

    result.stunned = true;
    result.laps = stunEffect.getLaps();
    sceneLog.updateLog(
        `${targetUnit.getName()} was seized by ${owner.getName()}'s Stun Aura for ${HoCLib.getLapString(result.laps)}`,
    );
    return result;
}
