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

import { CreatureLevelList, CreatureLevelMap, CreaturePoolByLevel } from "../units/unit_properties";

export const canBanCreatureLevel = (
    creatureLevel: number,
    creaturesBanned: number[],
    knownCreatures: number[],
    creaturesPickedPerTeam: number[],
): boolean => {
    let minimumCreaturesOfThisLevelRequired = 2;
    let totalNumberOfCreaturesRemaining = CreatureLevelList[creatureLevel - 1].length ?? 0;

    for (const cb of creaturesBanned) {
        if (creatureLevel === CreatureLevelMap[cb as keyof typeof CreatureLevelMap]) {
            totalNumberOfCreaturesRemaining -= 1;
        }
    }

    const pool = [...CreaturePoolByLevel];
    pool[0] -= 1;
    pool[1] -= 1;
    pool[2] -= 1;
    pool[3] -= 1;

    for (const kc of knownCreatures) {
        if (creatureLevel === CreatureLevelMap[kc as keyof typeof CreatureLevelMap]) {
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
            if (creatureLevel === CreatureLevelMap[p as keyof typeof CreatureLevelMap]) {
                totalNumberOfCreaturesRemaining -= 1;
            }
            continue;
        }
        if (creatureLevel === CreatureLevelMap[p as keyof typeof CreatureLevelMap]) {
            minimumCreaturesOfThisLevelRequired -= 1;
            totalNumberOfCreaturesRemaining -= 1;
        }
    }

    return minimumCreaturesOfThisLevelRequired < totalNumberOfCreaturesRemaining;
};
