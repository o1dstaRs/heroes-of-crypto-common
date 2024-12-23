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

import { CreatureByLevel, CreatureLevels, CreaturePoolByLevel } from "../units/unit_properties";

export const canBanCreatureLevel = (
    creatureLevel: number,
    creaturesBanned: number[],
    knownCreatures: number[],
    creaturesPickedPerTeam: number[],
): boolean => {
    let minimumCreaturesOfThisLevelRequired = 2;
    let totalNumberOfCreaturesRemaining = CreatureByLevel[creatureLevel - 1].length ?? 0;

    for (const cb of creaturesBanned) {
        if (creatureLevel === CreatureLevels[cb as keyof typeof CreatureLevels]) {
            totalNumberOfCreaturesRemaining -= 1;
        }
    }

    const pool = [...CreaturePoolByLevel];
    pool[0] -= 1;
    pool[1] -= 1;
    pool[2] -= 1;
    pool[3] -= 1;

    for (const kc of knownCreatures) {
        if (creatureLevel === CreatureLevels[kc as keyof typeof CreatureLevels]) {
            if (pool[creatureLevel] < 1) {
                minimumCreaturesOfThisLevelRequired -= 1;
            } else {
                pool[creatureLevel] -= 1;
            }
            totalNumberOfCreaturesRemaining -= 1;
        }
    }

    const amount = pool[creatureLevel];
    if (amount > 0) {
        totalNumberOfCreaturesRemaining -= amount;
    }

    for (let i = 0; i < creaturesPickedPerTeam.length; i++) {
        const p = creaturesPickedPerTeam[i];
        if (i < 2) {
            if (creatureLevel === CreatureLevels[p as keyof typeof CreatureLevels]) {
                totalNumberOfCreaturesRemaining -= 1;
            }
            continue;
        }
        if (creatureLevel === CreatureLevels[p as keyof typeof CreatureLevels]) {
            minimumCreaturesOfThisLevelRequired -= 1;
            totalNumberOfCreaturesRemaining -= 1;
        }
    }

    return minimumCreaturesOfThisLevelRequired < totalNumberOfCreaturesRemaining;
};
