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

import { TeamType } from "../units/unit_properties";
import { XY } from "../utils/math";
import { Ability } from "./ability";

export function getAbilitiesWithPosisionCoefficient(
    unitAbilities: Ability[],
    fromCell?: XY,
    toCell?: XY,
    toUnitSmallSize?: boolean,
    fromUnitTeam?: TeamType,
): Ability[] {
    const abilities: Ability[] = [];
    if (!unitAbilities?.length || !fromCell || !toCell) {
        return abilities;
    }

    for (const a of unitAbilities) {
        if (a.getName() === "Backstab") {
            const aY = fromCell.y;
            const tY = toCell.y;

            if (fromUnitTeam === TeamType.LOWER && aY > tY) {
                abilities.push(a);
            }

            if (fromUnitTeam === TeamType.UPPER && aY < tY - (toUnitSmallSize ? 0 : 1)) {
                abilities.push(a);
            }
        }
    }

    return abilities;
}

export const abilityToTextureName = (abilityName: string): string =>
    `${abilityName.toLowerCase().replace(/ /g, "_")}_256`;
