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

import {
    MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE,
    NUMBER_OF_ARMAGEDDON_WAVES,
    NUMBER_OF_LAPS_FIRST_ARMAGEDDON,
} from "../../constants";
import type { Unit } from "../../units/unit";

/** Four full activations before wave one is the earliest bounded endgame intervention. */
export const V08_ARMAGEDDON_PRESERVATION_START_LAP = NUMBER_OF_LAPS_FIRST_ARMAGEDDON - 4;

export interface IV08ArmageddonPreservationOpportunity {
    readonly resolutionWave: number;
}

/** Exact raw damage used by Unit.applyArmageddonDamage for one original stack. */
export function v08ArmageddonWaveDamage(unit: Unit, wave: number): number {
    const normalizedWave = Math.floor(wave);
    if (normalizedWave <= 0 || normalizedWave > NUMBER_OF_ARMAGEDDON_WAVES) return 0;
    const originalAmount = Math.max(0, unit.getAmountAlive() + unit.getAmountDied());
    const maxHp = Math.max(0, unit.getMaxHp());
    if (normalizedWave === 1) {
        return Math.max(
            MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE,
            Math.floor((maxHp * originalAmount * normalizedWave) / NUMBER_OF_ARMAGEDDON_WAVES),
        );
    }
    return Math.ceil((originalAmount * normalizedWave) / NUMBER_OF_ARMAGEDDON_WAVES) * maxHp;
}

/** At a live decision the current lap's wave has already resolved, so only later waves remain. */
export function v08FirstUpcomingArmageddonWave(currentLap: number): number {
    const appliedWave = Math.max(0, Math.floor(currentLap) - NUMBER_OF_LAPS_FIRST_ARMAGEDDON + 1);
    return Math.max(1, appliedWave + 1);
}

export function v08UpcomingArmageddonDamageThrough(unit: Unit, currentLap: number, throughWave: number): number {
    const firstWave = v08FirstUpcomingArmageddonWave(currentLap);
    let damage = 0;
    let waterShieldAvailable = unit.hasBuffActive("Water Shield");
    for (let wave = firstWave; wave <= Math.min(NUMBER_OF_ARMAGEDDON_WAVES, throughWave); wave += 1) {
        // Armageddon has no attacker, so an intact Water Shield absorbs and consumes the first future wave.
        if (waterShieldAvailable) {
            waterShieldAvailable = false;
            continue;
        }
        damage += v08ArmageddonWaveDamage(unit, wave);
    }
    return damage;
}

/**
 * Find a future wave where the actor currently has an environmental survival edge over the opposing stack.
 * This is deliberately an opportunity, not a proof: attacks before that wave can still change either margin.
 * The search driver uses it only to admit a defend candidate into exact-terminal rollout arbitration.
 */
export function v08ArmageddonPreservationOpportunity(
    actor: Unit,
    opposingStack: Unit,
    currentLap: number,
): IV08ArmageddonPreservationOpportunity | undefined {
    if (
        currentLap < V08_ARMAGEDDON_PRESERVATION_START_LAP ||
        actor.isDead() ||
        opposingStack.isDead() ||
        actor.getTeam() === opposingStack.getTeam()
    ) {
        return undefined;
    }

    const firstWave = v08FirstUpcomingArmageddonWave(currentLap);
    for (let wave = firstWave; wave <= NUMBER_OF_ARMAGEDDON_WAVES; wave += 1) {
        const actorSurvives = actor.getCumulativeHp() > v08UpcomingArmageddonDamageThrough(actor, currentLap, wave);
        const opponentIsDoomed =
            opposingStack.getCumulativeHp() <= v08UpcomingArmageddonDamageThrough(opposingStack, currentLap, wave);
        if (actorSurvives && opponentIsDoomed) return { resolutionWave: wave };
    }
    return undefined;
}
