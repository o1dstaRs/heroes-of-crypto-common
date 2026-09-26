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

import * as HoCConstants from "../constants";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import { FightStateManager } from "../fights/fight_state_manager";
import type { IStatisticHolder } from "../scene/statistic_holder_interface";
import type { IDamageStatistic } from "../scene/scene_stats";
import type { ISecondaryDamage } from "../scene/animations";
import { applyMagicMirrorDamage } from "../spells/magic_mirror_damage";
import { fireforgedSwordDamage, fireforgedSwordPower } from "../spells/spell_damage";
import { SpellElement } from "../spells/spell_properties";

export const FIREFORGED_SWORD_BUFF_NAME = "Fireforged Sword";

export interface IFireforgedSwordResult {
    increaseMorale: number;
    unitIdsDied: string[];
    moraleDecreaseForTheUnitTeam: Record<string, number>;
}

const NO_BURN: IFireforgedSwordResult = Object.freeze({
    increaseMorale: 0,
    unitIdsDied: [],
    moraleDecreaseForTheUnitTeam: {},
});

/**
 * The burning edge a Fireforged Sword adds to a swing that has just landed.
 *
 * This is Fire Shield's mirror image — same plumbing, opposite direction. Fire Shield burns the ATTACKER
 * who struck a shielded defender; the sword burns the DEFENDER the enchanted blade hit. Both deal fire as
 * a SECOND, magical hit: armour does not blunt it, magic resistance does, and it is reported as its own
 * secondary damage entry rather than being folded into the swing's number, so the player can see what the
 * steel did and what the fire did.
 *
 * Call it after the attack's own applyDamage, with the damage that actually landed — a swing fully
 * absorbed by a shield leaves nothing to set alight.
 */
export function processFireforgedSwordAbility(
    fromUnit: Unit,
    toUnit: Unit,
    damageFromAttack: number,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
): IFireforgedSwordResult {
    if (toUnit.isDead()) {
        return NO_BURN;
    }
    const swordBuff = fromUnit.getBuff(FIREFORGED_SWORD_BUFF_NAME);
    if (!swordBuff) {
        return NO_BURN;
    }

    const burnDamage = fireforgedSwordDamage({
        damageDealt: damageFromAttack,
        swordPercentage: fireforgedSwordPower(swordBuff.getPower()),
        targetMagicResist: toUnit.getMagicResist(),
        targetIsFireElement: toUnit.hasAbilityActive("Fire Element"),
        targetIsWaterElement: toUnit.hasAbilityActive("Water Element"),
        targetIsWindElement: toUnit.hasAbilityActive("Wind Element"),
        targetIsEarthElement: toUnit.hasAbilityActive("Earth Element"),
        targetMagicDamageTakenMultiplier: toUnit.getMagicDamageTakenMultiplier(),
    });
    if (burnDamage <= 0) {
        return NO_BURN;
    }

    const positionAtImpact = { ...toUnit.getPosition() };
    const amountAliveBefore = toUnit.getAmountAlive();
    damageStatisticHolder.add({
        unitName: fromUnit.getName(),
        // 0 break chance: this is a magic hit, not another swing.
        damage: toUnit.applyDamage(burnDamage, 0 /* magic attack */, sceneLog, false, fromUnit),
        team: fromUnit.getTeam(),
        lap: FightStateManager.getInstance().getFightProperties().getCurrentLap(),
    });
    secondaryDamage?.push({
        source: "fireforged_sword",
        unitId: toUnit.getId(),
        position: positionAtImpact,
        amount: burnDamage,
        unitsDied: Math.max(0, amountAliveBefore - toUnit.getAmountAlive()),
    });
    sceneLog.updateLog(`${toUnit.getName()} burned for (${burnDamage}) by Fireforged Sword`);
    const mirror = applyMagicMirrorDamage({
        attacker: fromUnit,
        holder: toUnit,
        landedOnHolder: burnDamage,
        element: SpellElement.FIRE,
        sceneLog,
        secondaryDamage,
    });
    const reflectedDeaths = mirror?.unitDied ? [fromUnit.getId()] : [];

    if (toUnit.isDead()) {
        sceneLog.updateLog(`${toUnit.getName()} died`);
        return {
            increaseMorale: HoCConstants.MORALE_CHANGE_FOR_KILL,
            unitIdsDied: [toUnit.getId(), ...reflectedDeaths],
            moraleDecreaseForTheUnitTeam: {
                [`${toUnit.getName()}:${toUnit.getTeam()}`]: HoCConstants.MORALE_CHANGE_FOR_KILL,
            },
        };
    }

    return reflectedDeaths.length
        ? { increaseMorale: 0, unitIdsDied: reflectedDeaths, moraleDecreaseForTheUnitTeam: {} }
        : NO_BURN;
}

/** Somewhere to look a victim's id up — UnitsHolder, without dragging its import in here. */
export interface IFireforgedSwordUnitLookup {
    getAllUnits(): ReadonlyMap<string, Unit>;
}

/**
 * The blade against a whole volley: every unit one attack damaged, each burned for its OWN damage.
 *
 * A sweeping or piercing attack is still "the ally's attack", so every unit it hurts takes the blade's
 * fire — an Area Throw that lands on four creatures sets four alight, each for its own share rather than
 * all for the biggest. Built on top of the single-victim call so there is exactly one place that prices
 * and applies a burn.
 *
 * Victims are given as (unitId, amount) because that is what every multi-victim processor already reports
 * (perUnitDamage on the AOE and Through Shot results, the secondary-damage entries a breath or a spin
 * pushes). A victim that took nothing, missed, or is already gone is skipped.
 */
export function processFireforgedSwordOnVictims(
    fromUnit: Unit,
    victims: readonly { unitId: string; amount: number }[],
    unitsHolder: IFireforgedSwordUnitLookup,
    sceneLog: ISceneLog,
    damageStatisticHolder: IStatisticHolder<IDamageStatistic>,
    secondaryDamage?: ISecondaryDamage[],
): IFireforgedSwordResult {
    if (!victims.length || !fromUnit.getBuff(FIREFORGED_SWORD_BUFF_NAME)) {
        return NO_BURN;
    }
    const allUnits = unitsHolder.getAllUnits();
    let increaseMorale = 0;
    const unitIdsDied: string[] = [];
    const moraleDecreaseForTheUnitTeam: Record<string, number> = {};
    // One burn per victim even when a processor reported it in several pieces, so a unit hit twice by the
    // same sweep is not set alight twice by one swing.
    const burned = new Set<string>();
    for (const victim of victims) {
        if (!(victim.amount > 0) || burned.has(victim.unitId)) {
            continue;
        }
        const target = allUnits.get(victim.unitId);
        // Never burn the wielder with its own blade, whatever a processor reported.
        if (!target || target.getId() === fromUnit.getId()) {
            continue;
        }
        burned.add(victim.unitId);
        const result = processFireforgedSwordAbility(
            fromUnit,
            target,
            victim.amount,
            sceneLog,
            damageStatisticHolder,
            secondaryDamage,
        );
        increaseMorale += result.increaseMorale;
        for (const id of result.unitIdsDied) {
            if (!unitIdsDied.includes(id)) {
                unitIdsDied.push(id);
            }
        }
        for (const [key, value] of Object.entries(result.moraleDecreaseForTheUnitTeam)) {
            moraleDecreaseForTheUnitTeam[key] = (moraleDecreaseForTheUnitTeam[key] ?? 0) + value;
        }
    }
    return { increaseMorale, unitIdsDied, moraleDecreaseForTheUnitTeam };
}
