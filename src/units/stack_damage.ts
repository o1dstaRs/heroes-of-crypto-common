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

/**
 * The four fields Unit.applyDamage mutates when a stack takes ordinary damage.
 * Keeping the transition pure lets callers project hazards without cloning or
 * mutating a live Unit, while Unit itself remains the authoritative consumer.
 */
export interface IStackHpState {
    readonly hp: number;
    readonly maxHp: number;
    readonly amountAlive: number;
    readonly amountDied: number;
}

export interface IStackDamageProjection {
    readonly state: IStackHpState;
    readonly appliedDamage: number;
    readonly unitsDied: number;
    readonly animationDeaths: number;
    readonly dead: boolean;
}

/**
 * Project Unit.applyDamage's stack-HP arithmetic exactly, excluding the
 * effect/buff hooks that run before it (Water Shield and Break) and the
 * post-transition Bitter Experience stat gain.
 */
export function projectStackDamage(state: IStackHpState, requestedDamage: number): IStackDamageProjection {
    const next = { ...state };
    if (requestedDamage <= 0) {
        return {
            state: next,
            appliedDamage: 0,
            unitsDied: 0,
            animationDeaths: 0,
            dead: next.amountAlive <= 0,
        };
    }

    if (requestedDamage < next.hp) {
        next.hp -= requestedDamage;
        return {
            state: next,
            appliedDamage: requestedDamage,
            unitsDied: 0,
            animationDeaths: 0,
            dead: false,
        };
    }

    const aliveBefore = next.amountAlive;
    const frontHp = next.hp;
    next.amountDied += 1;
    next.amountAlive -= 1;
    const remainingDamage = requestedDamage - frontHp;
    next.hp = next.maxHp;

    const additionalDeaths = Math.floor(remainingDamage / next.maxHp);
    if (additionalDeaths >= next.amountAlive) {
        next.amountDied += next.amountAlive;
        const wereAlive = next.amountAlive;
        next.amountAlive = 0;
        return {
            state: next,
            appliedDamage: Math.floor(wereAlive * next.maxHp) + frontHp,
            unitsDied: aliveBefore,
            // Preserve Unit.applyDamage's historical animation argument: the first
            // front-stack death is implicit in this all-dead branch.
            animationDeaths: wereAlive,
            dead: true,
        };
    }

    next.amountDied += additionalDeaths;
    next.amountAlive -= additionalDeaths;
    next.hp -= remainingDamage % next.maxHp;
    return {
        state: next,
        appliedDamage: remainingDamage + frontHp,
        unitsDied: additionalDeaths + 1,
        animationDeaths: additionalDeaths + 1,
        dead: false,
    };
}
