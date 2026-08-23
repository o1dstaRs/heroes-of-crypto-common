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
        swordPercentage: fireforgedSwordPower(swordBuff.getPower(), fromUnit.getEmpowerPercentage()),
        targetMagicResist: toUnit.getMagicResist(),
        targetIsFireElement: toUnit.hasAbilityActive("Fire Element"),
        targetIsWaterElement: toUnit.hasAbilityActive("Water Element"),
        targetIsWindElement: toUnit.hasAbilityActive("Wind Element"),
        targetIsEarthElement: toUnit.hasAbilityActive("Earth Element"),
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
