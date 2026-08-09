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

import { Tier2Artifact } from "../artifacts/artifact_properties";
import { EffectFactory } from "../effects/effect_factory";
import { FightStateManager } from "../fights/fight_state_manager";
import type { ISceneLog } from "../scene/scene_log_interface";
import { Unit } from "../units/unit";

const effectFactory = new EffectFactory();

/**
 * Each poison landed on an ALREADY poisoned target adds a stack worth this share of that hit's own poison
 * value. So the second stack raises the tick by 70% of what it would have applied on its own, the third by
 * another 70%, and so on — linear, the same shape as Deep Wounds summing its cards' powers rather than one
 * overriding another. The stack count is not stored anywhere: the accumulated hp/turn IS the stack total,
 * which keeps this out of the effect serialization and the battle snapshot.
 */
const POISON_STACK_SHARE = 0.7;

/**
 * The stacked tick stays a WHOLE number of hp: TurnEngine feeds it straight into applyDamage, which
 * subtracts it from hp without rounding, so a fractional power would leave units on fractional health.
 * Rounding can floor a tiny poison's share to nothing, hence the 1 hp minimum — a stack that landed must
 * always be worth something, or the guard below would silently drop it.
 */
const poisonStackIncrement = (poisonHp: number): number => Math.max(1, Math.round(poisonHp * POISON_STACK_SHARE));

/**
 * Applies (or stacks) the persistent Poison damage-over-time effect on a target.
 *
 * Poison ticks for `poisonHp` RAW hp at the START of the poisoned unit's turn (see TurnEngine) and lasts
 * until the very end of the fight — its config laps === NUMBER_OF_LAPS_TOTAL, which are never decremented.
 * The first poison sets the tick outright. Every later one stacks: the tick grows by POISON_STACK_SHARE of
 * the incoming poison, and never drops below the strongest single poison the target has been dealt — so a
 * big hit landing on a weak stack still rebases the tick upwards instead of only adding its 35%.
 */
export function applyPoisonEffect(targetUnit: Unit, poisonHp: number, sceneLog: ISceneLog): void {
    if (targetUnit.isDead() || poisonHp <= 0) {
        return;
    }

    // Holy Cross (Tier 2) grants the wielder's whole army immunity to poison — nobody on that team can be
    // poisoned, so drop the effect entirely for them.
    if (
        FightStateManager.getInstance()
            .getFightProperties()
            .hasArtifactTier2(targetUnit.getTeam(), Tier2Artifact.HOLY_CROSS)
    ) {
        return;
    }

    const activePoison = targetUnit.getEffect("Poison");
    const activePower = activePoison?.getPower() ?? 0;
    // A stack must never leave the tick weaker than the strongest single poison dealt, hence the max().
    const stackedPower = activePower ? Math.max(poisonHp, activePower + poisonStackIncrement(poisonHp)) : poisonHp;

    if (stackedPower <= activePower) {
        return;
    }

    const poison = effectFactory.makeEffect("Poison");
    if (!poison) {
        return;
    }
    poison.setPower(stackedPower);

    // Carry the count forward and spell it out in the description: applyEffect serialises that string into
    // applied_effects_descriptions, which is what the debuff tooltip shows — the same way Deep Wounds
    // surfaces its accumulated power on the target. The count rides the effect, so it survives a snapshot.
    const stacks = (activePoison?.getStacks() ?? 0) + 1;
    poison.setStacks(stacks);
    poison.setDesc(`${poison.getDesc()} Poison stacks: ${stacks}.`);

    if (targetUnit.applyEffect(poison)) {
        sceneLog.updateLog(
            activePower
                ? `${targetUnit.getName()} poison stacks up to ${stacks} (${activePower} -> ${stackedPower} hp per turn)`
                : `${targetUnit.getName()} is poisoned (${stackedPower} hp per turn)`,
        );
    }
}
