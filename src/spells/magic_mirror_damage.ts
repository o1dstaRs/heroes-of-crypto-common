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

import type { ISceneLog } from "../scene/scene_log_interface";
import type { ISecondaryDamage } from "../scene/animations";
import type { Unit } from "../units/unit";
import { applyElementAndResistToSpellDamage, elementalSpellMultiplier } from "./spell_damage";
import { getMagicMirrorPower } from "./spell_helper";
import { SpellElement } from "./spell_properties";

export interface IMagicMirrorDamageProjection {
    /** Damage after the attacker's own element and magic resistance, before Water Shield. */
    landed: number;
    /** Damage the attacker would actually lose after Water Shield. */
    damage: number;
    kills: number;
    absorbedByWaterShield: boolean;
    reflectionPercent: number;
}

export interface IAppliedMagicMirrorDamage extends IMagicMirrorDamageProjection {
    /** Damage Unit.applyDamage actually removed, capped by the attacker's remaining stack health. */
    appliedDamage: number;
    unitDied: boolean;
}

/** Apply an elemental magical hit to `unit`: element first, then that unit's magic resistance. */
export function elementalMagicDamageAgainstUnit(rawDamage: number, element: SpellElement, unit: Unit): number {
    return applyElementAndResistToSpellDamage(
        rawDamage,
        elementalSpellMultiplier({
            element,
            targetIsFireElement: unit.hasAbilityActive("Fire Element"),
            targetIsWaterElement: unit.hasAbilityActive("Water Element"),
            targetIsWindElement: unit.hasAbilityActive("Wind Element"),
            targetIsEarthElement: unit.hasAbilityActive("Earth Element"),
        }),
        unit.getMagicResist(),
    );
}

/**
 * Project the share a Magic Mirror spell buff sends back for one direct magical hit.
 *
 * `landedOnHolder` is the hit after the holder's magic resistance/element, but before Water Shield or HP
 * capping—the same damage figure every direct magic source computes before Unit.applyDamage. A spell may pass
 * an explicit percentage after rolling Magic Reflection; ability callers omit it and use only the guaranteed
 * Magic Mirror / Mass Magic Mirror buff share.
 */
export function projectMagicMirrorDamage(input: {
    attacker: Unit;
    holder: Unit;
    landedOnHolder: number;
    element: SpellElement;
    reflectionPercent?: number;
}): IMagicMirrorDamageProjection | undefined {
    const { attacker, holder, landedOnHolder, element } = input;
    if (attacker.getId() === holder.getId() || landedOnHolder <= 0) {
        return undefined;
    }
    const reflectionPercent = input.reflectionPercent ?? getMagicMirrorPower(holder);
    if (reflectionPercent <= 0) {
        return undefined;
    }

    const reflectedRawDamage = Math.floor((landedOnHolder * reflectionPercent) / 100);
    const landed = elementalMagicDamageAgainstUnit(reflectedRawDamage, element, attacker);
    const absorbedByWaterShield = landed > 0 && attacker.willWaterShieldAbsorb(attacker);
    const damage = absorbedByWaterShield ? 0 : landed;

    return {
        landed,
        damage,
        kills: damage > 0 ? attacker.calculatePossibleLosses(damage) : 0,
        absorbedByWaterShield,
        reflectionPercent,
    };
}

/**
 * Apply and report one guaranteed Magic Mirror / Mass Magic Mirror return from an ability-side magic hit.
 * Reflected damage is defensive: it never enters the original attacker's offensive damage statistics and it
 * never recursively triggers another mirror. The caller owns normal dead-unit cleanup and morale policy.
 */
export function applyMagicMirrorDamage(input: {
    attacker: Unit;
    holder: Unit;
    landedOnHolder: number;
    element: SpellElement;
    sceneLog: ISceneLog;
    secondaryDamage?: ISecondaryDamage[];
}): IAppliedMagicMirrorDamage | undefined {
    const { attacker, holder, sceneLog, secondaryDamage } = input;
    if (attacker.isDead()) {
        return undefined;
    }
    const projection = projectMagicMirrorDamage(input);
    if (!projection || projection.landed <= 0) {
        return undefined;
    }

    const positionAtImpact = { ...attacker.getPosition() };
    const amountAliveBefore = attacker.getAmountAlive();
    // Passing the original attacker back into applyDamage preserves Water Shield's source rule. In
    // particular, reflected Fire Breath from a Fire Element remains fire that passes its own shield.
    const appliedDamage = attacker.applyDamage(projection.landed, 0, sceneLog, false, attacker);
    const unitDied = attacker.isDead();
    secondaryDamage?.push({
        source: "magic_mirror",
        unitId: attacker.getId(),
        position: positionAtImpact,
        amount: appliedDamage,
        unitsDied: Math.max(0, amountAliveBefore - attacker.getAmountAlive()),
        rebounded: true,
    });
    sceneLog.updateLog(
        `${holder.getName()} reflected ${projection.reflectionPercent}% magic damage back to ${attacker.getName()} (${appliedDamage})`,
    );
    if (unitDied) {
        sceneLog.updateLog(`${attacker.getName()} died`);
    }

    return { ...projection, appliedDamage, unitDied };
}
