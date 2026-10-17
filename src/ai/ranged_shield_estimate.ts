import type { Unit } from "../units/unit";

interface IShieldedVolleyEstimate {
    hp: number;
    hitChance: number;
    firstDamage: number;
    secondDamage: number;
    nativeSecondVolley: boolean;
    echoChance: number;
    spendsOnHitOnly: boolean;
    throughShot: boolean;
}

interface IVolleyState {
    damage: number;
    shield: boolean;
    spent: number;
    probability: number;
}

/**
 * Water Shield absorbs the first positive landed hit, not the whole attack action. Keep its state
 * alongside ammunition across native volleys and the one possible Echo. Damage inputs retain the
 * caller's ordinary per-volley estimate; shield consumption, misses and shot budgets are discrete.
 */
export function estimateShieldedRangedDamage(
    unit: Unit,
    ammunitionTarget: Unit | undefined,
    estimate: IShieldedVolleyEstimate,
): number {
    let states: IVolleyState[] = [{ damage: 0, shield: true, spent: 0, probability: 1 }];
    const volley = (damage: number, chance = 1, spendsArrow = true): void => {
        const next: IVolleyState[] = [];
        for (const state of states) {
            if (state.damage >= estimate.hp || unit.projectRangeShotsAfterVolleys(ammunitionTarget, state.spent) <= 0) {
                next.push(state);
                continue;
            }
            if (chance < 1) next.push({ ...state, probability: state.probability * (1 - chance) });
            for (const [hit, probability] of [
                [false, 1 - estimate.hitChance],
                [true, estimate.hitChance],
            ] as const) {
                const weight = state.probability * chance * probability;
                if (weight <= 0) continue;
                const positive = hit && damage > 0;
                next.push({
                    damage: Math.min(estimate.hp, state.damage + (positive && !state.shield ? damage : 0)),
                    shield: state.shield && !positive,
                    spent: state.spent + Number(spendsArrow && (hit || !estimate.spendsOnHitOnly)),
                    probability: weight,
                });
            }
        }
        states = next;
    };
    volley(estimate.firstDamage);
    if (estimate.nativeSecondVolley) volley(estimate.secondDamage, 1, !estimate.throughShot);
    if (estimate.echoChance > 0) volley(estimate.firstDamage, estimate.echoChance);
    return states.reduce((sum, state) => sum + state.probability * state.damage, 0);
}
