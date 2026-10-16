/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 * -----------------------------------------------------------------------------
 */

import type { ISceneLog } from "../scene/scene_log_interface";
import { FightStateManager } from "../fights/fight_state_manager";
import type { Unit } from "../units/unit";
import { getRandomInt } from "../utils/lib";
import { applyPoisonEffect } from "./poison_ability";

export const PREDATORY_ASSIMILATION_NAME = "Predatory Assimilation";

/**
 * Share of the damage just dealt that this ability applies as Poison, before the attacker's luck.
 * Five points over Venom Cloud Aura's 20, and not an aura: only the unit holding the ability poisons.
 */
export const PREDATORY_ASSIMILATION_POISON_PERCENT = 25;

export interface IAbilityStolen {
    thiefId: string;
    targetId: string;
    abilityName: string;
}

/**
 * Resolves the stack-powered steal attached to one landed direct attack or response, never to extra hits.
 * The poison on that same hit is {@link processPredatoryAssimilationPoison}; it is not rolled here.
 */
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

    // Capture every remaining charge owned by the card before disabling it, because the disabled ability is
    // intentionally no longer present in the target's mechanical ability list. Duplicate entries are charges.
    const spellEntries = target.takeAbilitySpellEntries(selected.getName());
    if (!target.disableAbilityAsStolen(selected.getName())) {
        return undefined;
    }

    thief.grantStolenAbility(selected.getName(), spellEntries);
    sceneLog.updateLog(`${thief.getName()} stole ${selected.getName()} from ${target.getName()}`);
    return { thiefId: thief.getId(), targetId: target.getId(), abilityName: selected.getName() };
}

/**
 * Poisons the unit just hit, for {@link PREDATORY_ASSIMILATION_POISON_PERCENT} of that hit's damage plus the
 * attacker's luck. Call it only for a landed direct hit — melee attack, melee retaliation, primary shot,
 * counter-shot — the same hits that can steal. A second punch, second shot, splash victim, pierce or skewer
 * is not this call, so Venom Cloud can still poison those while this does not.
 *
 * It is not an aura and it is a separate application from {@link processPoisonAuraAbility}, so the two stack
 * whichever lands first. Break, and a copy that has been stolen away, both turn it off.
 */
export function processPredatoryAssimilationPoison(
    attackerUnit: Unit,
    targetUnit: Unit,
    damageDealt: number,
    sceneLog: ISceneLog,
): void {
    if (damageDealt <= 0 || targetUnit.isDead() || !attackerUnit.hasAbilityActive(PREDATORY_ASSIMILATION_NAME)) {
        return;
    }

    const percent = Math.max(0, PREDATORY_ASSIMILATION_POISON_PERCENT + attackerUnit.getLuck());
    const poisonHp = Math.floor((damageDealt * percent) / 100);
    if (poisonHp <= 0) {
        return;
    }

    applyPoisonEffect(targetUnit, poisonHp, sceneLog);
}
