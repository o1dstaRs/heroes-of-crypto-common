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
import { Unit } from "../units/unit";
import { Spell } from "../spells/spell";
import { getSpellConfig } from "../configuration/config_provider";
import * as HoCConstants from "../constants";

const DULLING_DEFENSE_DEBUFF = "Dulling Defense";

export function processDullingDefenseAblity(fromUnit: Unit, toUnit: Unit, sceneLog: ISceneLog): void {
    if (toUnit.isDead()) {
        return;
    }

    const dullingDefenseAbility = fromUnit.getAbility("Dulling Defense");
    if (!dullingDefenseAbility) {
        return;
    }

    const dullingDefensePower = Number(dullingDefenseAbility.getPower().toFixed(1));
    if (dullingDefensePower <= 0) {
        return;
    }

    const reducedBy = toUnit.reduceBaseAttack(dullingDefensePower);
    if (!reducedBy) {
        return;
    }

    // Also surface a permanent "Dulling Defense" debuff on the target that ACCUMULATES the total base
    // attack it has lost — so the reduction is visible (icon in the debuffs list) and players can see by
    // how much. Re-applied each trigger with the running total; NUMBER_OF_LAPS_TOTAL laps = never expires
    // this fight (AppliedSpell.minusLap treats that value as permanent). The stored power AND the debuff's
    // description property both carry the total, so the tooltip reads "…permanently reduced by <total>".
    const existing = toUnit.getDebuff(DULLING_DEFENSE_DEBUFF);
    const totalReduced = Number(((existing?.getPower() ?? 0) + reducedBy).toFixed(1));
    if (existing) {
        toUnit.deleteDebuff(DULLING_DEFENSE_DEBUFF);
    }
    const dullingDebuff = new Spell({
        spellProperties: getSpellConfig("System", DULLING_DEFENSE_DEBUFF, HoCConstants.NUMBER_OF_LAPS_TOTAL),
        amount: 1,
    });
    dullingDebuff.setPower(totalReduced);
    toUnit.applyDebuff(dullingDebuff, totalReduced);

    sceneLog.updateLog(
        `${toUnit.getName()} permanently lost ${reducedBy} base attack due to Dulling Defense (total ${totalReduced})`,
    );
}
