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

import { EffectFactory } from "../effects/effect_factory";
import * as HoCLib from "../utils/lib";
import type { ISceneLog } from "../scene/scene_log_interface";
import type { Unit } from "../units/unit";

export type CraftOutcome = "stun" | "nothing" | "double" | "frozen";

export interface ICraftResult {
    unitId: string;
    outcome: CraftOutcome;
    /** The ability name granted (for "double"/"frozen"); undefined for "stun"/"nothing". */
    grantedAbility?: string;
}

import { DOUBLE_SHOT_ABILITY_NAMES } from "./double_shot_names";
import { getCraftChances } from "./craft_chances";

// Re-exported so existing importers keep working; the definitions live in craft_chances.ts, which has no
// dependencies and so can also be reached from the config layer without closing an import cycle.
export { getCraftChances, type ICraftChances } from "./craft_chances";

const effectFactory = new EffectFactory();

/**
 * The Blacksmith's Craft, applied to every ally inside the chosen 2x2 area. Each ally rolls an independent,
 * luck-weighted outcome based on the caster's luck and Tome of Amplification. Ranged allies (range_shots > 0)
 * receive the shot/bow variants, everyone else the
 * punch/sword variants. Returns the per-unit outcome so the caller can emit explicit result animations.
 */
export function processCraftAbility(caster: Unit, allies: Unit[], sceneLog: ISceneLog): ICraftResult[] {
    const results: ICraftResult[] = [];
    const tome = caster.getBuff("Tome of Amplification")?.getPower() ?? 0;
    const chances = getCraftChances(caster.getLuck(), tome);
    // The Tome creates fractional odds. Use hundredths of a percentage point for its rolls.
    const resolution = chances.double > 40 ? 100 : 1;
    const stunEnd = Math.round(chances.stun * resolution);
    const nothingEnd = Math.round((chances.stun + chances.nothing) * resolution);
    const doubleEnd = Math.round((100 - chances.frozen) * resolution);

    for (const ally of allies) {
        if (ally.isDead()) {
            continue;
        }
        const roll = HoCLib.getRandomInt(0, 100 * resolution);
        const isRanged = ally.getRangeShots() > 0;

        if (roll < stunEnd) {
            const stun = effectFactory.makeEffect("Stun");
            // The Blacksmith caught in its own backfire is the unit whose turn it is: without the extra lap the
            // Stun ran out at the end of this very turn and it never missed one.
            if (stun && ally.getId() === caster.getId()) {
                stun.extend();
            }
            if (stun && ally.applyEffect(stun)) {
                sceneLog.updateLog(`${ally.getName()}'s craft backfired — stunned`);
            }
            results.push({ unitId: ally.getId(), outcome: "stun" });
        } else if (roll < nothingEnd) {
            sceneLog.updateLog(`${ally.getName()}'s craft failed`);
            results.push({ unitId: ally.getId(), outcome: "nothing" });
        } else if (roll < doubleEnd) {
            const granted = isRanged ? "Crafted Double Shot" : "Crafted Double Punch";
            // A unit that already gets this second attack can't gain a third (no triple attacks) — the
            // craft simply does nothing rather than stacking another double. On the ranged side that means
            // the WHOLE family, so a Gargantuan already throwing twice is not handed a third boulder.
            const alreadyStrikesTwice = isRanged
                ? DOUBLE_SHOT_ABILITY_NAMES.some((abilityName) => ally.hasAbilityActive(abilityName))
                : ally.hasAbilityActive("Double Punch") || ally.hasAbilityActive("Crafted Double Punch");
            if (alreadyStrikesTwice) {
                sceneLog.updateLog(`${ally.getName()}'s craft found nothing to improve`);
                results.push({ unitId: ally.getId(), outcome: "nothing" });
            } else {
                ally.grantAbility(granted);
                sceneLog.updateLog(`${ally.getName()} was crafted with ${granted}`);
                results.push({ unitId: ally.getId(), outcome: "double", grantedAbility: granted });
            }
        } else {
            const granted = isRanged ? "Crafted Frozen Bow" : "Crafted Frozen Sword";
            ally.grantAbility(granted);
            sceneLog.updateLog(`${ally.getName()} was crafted with ${granted}`);
            results.push({ unitId: ally.getId(), outcome: "frozen", grantedAbility: granted });
        }
    }
    return results;
}
