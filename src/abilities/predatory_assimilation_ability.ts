/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import type { ISceneLog } from "../scene/scene_log_interface";
import { FightStateManager } from "../fights/fight_state_manager";
import type { Unit } from "../units/unit";
import { getRandomInt } from "../utils/lib";

export const PREDATORY_ASSIMILATION_NAME = "Predatory Assimilation";

export interface IAbilityStolen {
    thiefId: string;
    targetId: string;
    abilityName: string;
}

/** Resolves the stack-powered chance attached to one landed direct attack (or response), never to extra hits. */
export function processPredatoryAssimilationAbility(
    thief: Unit,
    target: Unit,
    sceneLog: ISceneLog,
): IAbilityStolen | undefined {
    const assimilationAbility = thief.getAbility(PREDATORY_ASSIMILATION_NAME);
    if (!assimilationAbility) {
        return undefined;
    }

    const candidates = target
        .getAbilities()
        .filter(
            (ability) =>
                ability.getName() !== PREDATORY_ASSIMILATION_NAME && !thief.hasAbilityActive(ability.getName()),
        );
    const chance = thief.calculateAbilityApplyChance(
        assimilationAbility,
        FightStateManager.getInstance().getFightProperties().getAdditionalAbilityPowerPerTeam(thief.getTeam()),
    );
    if (!candidates.length || getRandomInt(0, 100) >= chance) {
        return undefined;
    }

    const selected = candidates[getRandomInt(0, candidates.length)];
    if (!selected) {
        return undefined;
    }

    // Capture spellbook charges before disabling the card, because the disabled ability is intentionally no
    // longer present in the target's mechanical ability list. Duplicate entries are meaningful spell charges.
    const spellEntries = target.takeSpellbookSpellEntries(selected.getName());
    if (!target.disableAbilityAsStolen(selected.getName())) {
        return undefined;
    }

    thief.grantStolenAbility(selected.getName(), spellEntries);
    sceneLog.updateLog(`${thief.getName()} stole ${selected.getName()} from ${target.getName()}`);
    return { thiefId: thief.getId(), targetId: target.getId(), abilityName: selected.getName() };
}
