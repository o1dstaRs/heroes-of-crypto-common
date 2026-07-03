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

import { Unit } from "../units/unit";
import * as HoCLib from "../utils/lib";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Spell } from "../spells/spell";
import { getSpellConfig } from "../configuration/config_provider";

// ARTIFACT Rime Charm: any attack from a unit carrying the Rime Charm buff has a chance (buff power, e.g.
// 30%) to chill the target — applying a Quagmire slow (movement reduction) for a number of laps stored as
// the buff's second property (e.g. 3). Reuses the existing "Quagmire" spell debuff so no new effect config
// is required.
export function processRimeCharmAbility(fromUnit: Unit, targetUnit: Unit, sceneLog: ISceneLog): void {
    if (targetUnit.isDead()) {
        return;
    }

    const rimeCharmBuff = fromUnit.getBuff("Rime Charm");
    if (!rimeCharmBuff) {
        return;
    }

    if (HoCLib.getRandomInt(0, 100) >= rimeCharmBuff.getPower()) {
        return;
    }

    if (targetUnit.hasDebuffActive("Quagmire")) {
        return;
    }

    const laps = parseInt(fromUnit.getBuffProperties("Rime Charm")[1] || "3", 10);
    const quagmire = new Spell({
        spellProperties: getSpellConfig("Death", "Quagmire", laps),
        amount: 1,
    });
    targetUnit.applyDebuff(quagmire);
    sceneLog.updateLog(`${fromUnit.getName()} chilled ${targetUnit.getName()} for ${HoCLib.getLapString(laps)}`);
}
