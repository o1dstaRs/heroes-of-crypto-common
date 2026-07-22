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

import * as HoCLib from "../utils/lib";
import * as HoCConfig from "../configuration/config_provider";
import { Grid } from "../grid/grid";
import { Spell } from "../spells/spell";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";
import * as SpellHelper from "../spells/spell_helper";
import { UnitsHolder } from "../units/units_holder";
import * as EffectHelper from "../effects/effect_helper";
import { FightStateManager } from "../fights/fight_state_manager";

/**
 * Hamstring (Dryad): on a landed attack, a stack-powered chance to apply "Hamstrung" (-30% movement, like
 * Quagmire but stronger). The chance comes from the shared stack+luck formula (calculateAbilityApplyChance):
 * power/MAX_UNIT_STACK_POWER * stackPower + luck + synergy, i.e. 6/12/18/24/30 by stack tier (+ luck), a
 * default of 30% at full stack. Absorbable (Absorb Penalties), resistible by magic resist, and mirrored.
 */
export function processHamstringAbility(
    fromUnit: Unit,
    targetUnit: Unit,
    currentActiveUnit: Unit,
    unitsHolder: UnitsHolder,
    grid: Grid,
    sceneLog: ISceneLog,
): void {
    const hamstringAbility = fromUnit.getAbility("Hamstring");
    if (!hamstringAbility) {
        return;
    }

    const absorptionTarget = EffectHelper.getAbsorptionTarget(targetUnit, grid, unitsHolder);
    if (absorptionTarget) {
        targetUnit = absorptionTarget;
    }

    if (targetUnit.isDead() || targetUnit.hasDebuffActive("Hamstrung")) {
        return;
    }

    if (
        HoCLib.getRandomInt(0, 100) >=
        fromUnit.calculateAbilityApplyChance(
            hamstringAbility,
            FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(fromUnit.getTeam()),
        )
    ) {
        return;
    }

    if (HoCLib.getRandomInt(0, 100) < Math.floor(targetUnit.getMagicResist())) {
        sceneLog.updateLog(`${targetUnit.getName()} resisted from Hamstrung`);
        return;
    }

    const debuff = new Spell({ spellProperties: HoCConfig.getSpellConfig("Death", "Hamstrung"), amount: 1 });
    const laps = debuff.getLapsTotal();

    targetUnit.applyDebuff(debuff, undefined, undefined, targetUnit.getId() === currentActiveUnit.getId());
    sceneLog.updateLog(
        `${fromUnit.getName()} applied Hamstrung on ${targetUnit.getName()} for ${HoCLib.getLapString(laps)}`,
    );

    if (SpellHelper.isMirrored(targetUnit)) {
        fromUnit.applyDebuff(debuff, undefined, undefined, fromUnit.getId() === currentActiveUnit.getId());
        sceneLog.updateLog(
            `${targetUnit.getName()} mirrored Hamstrung to ${fromUnit.getName()} for ${HoCLib.getLapString(laps)}`,
        );
    }
}
