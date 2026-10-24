import type { Unit } from "../units/unit";

export interface IShieldSequenceImpact {
    unit: Unit;
    hp: number;
    hitChance: number;
    firstDamage: number;
    secondDamage: number;
}
interface IState {
    covenant: boolean;
    water: boolean;
    damage: number;
    spent: number;
    probability: number;
}

/**
 * Research-only static direct-damage model for physical volleys. One Covenant hit removes the team's
 * protection; Water Shield belongs to one victim and survives an earlier Covenant absorb. Other victims'
 * hits matter to a focus victim only while their shared Covenant remains intact. This avoids exponential
 * enumeration of every victim's personal shield. Real-engine rollouts own riders and changed attack power.
 */
export function estimateRangedShieldSequence(
    attacker: Unit,
    impacts: readonly IShieldSequenceImpact[],
    ammunitionTarget: Unit | undefined,
    options: { nativeSecondVolley: boolean; echoChance: number; spendsOnHitOnly: boolean; throughShot: boolean },
): Map<string, number> {
    const result = new Map<string, number>();
    for (const focus of impacts) {
        const blockedByCovenant = focus.unit.willEmberCovenantBlock(attacker);
        let states: IState[] = [
            {
                covenant: blockedByCovenant,
                water: focus.unit.willWaterShieldAbsorb(attacker),
                damage: 0,
                spent: 0,
                probability: 1,
            },
        ];
        const volley = (second: boolean, chance: number, spendsArrow: boolean): void => {
            const next: IState[] = [];
            for (const original of states) {
                if (
                    original.damage >= focus.hp ||
                    attacker.projectRangeShotsAfterVolleys(ammunitionTarget, original.spent) <= 0
                ) {
                    next.push(original);
                    continue;
                }
                if (chance < 1) next.push({ ...original, probability: original.probability * (1 - chance) });
                let branch: IState[] = [{ ...original, probability: original.probability * chance }];
                for (const impact of impacts) {
                    const isFocus = impact === focus;
                    const damage = second ? impact.secondDamage : impact.firstDamage;
                    if (!isFocus && (impact.unit.getTeam() !== focus.unit.getTeam() || !blockedByCovenant)) continue;
                    const progressed: IState[] = [];
                    for (const state of branch) {
                        if (!isFocus && (!state.covenant || !impact.unit.willEmberCovenantBlock(attacker))) {
                            progressed.push(state);
                            continue;
                        }
                        for (const [hit, probability] of [
                            [false, 1 - impact.hitChance],
                            [true, impact.hitChance],
                        ] as const) {
                            const weight = state.probability * probability;
                            if (weight <= 0) continue;
                            const positive = hit && damage > 0;
                            const covenantAbsorb = state.covenant && impact.unit.willEmberCovenantBlock(attacker);
                            const waterAbsorb = isFocus && state.water && !covenantAbsorb;
                            progressed.push({
                                covenant: state.covenant && !positive,
                                water: state.water && !(isFocus && positive && !covenantAbsorb),
                                damage: Math.min(
                                    focus.hp,
                                    state.damage +
                                        (isFocus && positive && !covenantAbsorb && !waterAbsorb ? damage : 0),
                                ),
                                spent:
                                    state.spent + Number(isFocus && spendsArrow && (hit || !options.spendsOnHitOnly)),
                                probability: weight,
                            });
                        }
                    }
                    branch = progressed;
                }
                next.push(...branch);
            }
            states = next;
        };
        volley(false, 1, true);
        if (options.nativeSecondVolley) volley(true, 1, !options.throughShot);
        if (options.echoChance > 0) volley(false, options.echoChance, true);
        result.set(
            focus.unit.getId(),
            states.reduce((sum, state) => sum + state.damage * state.probability, 0),
        );
    }
    return result;
}
