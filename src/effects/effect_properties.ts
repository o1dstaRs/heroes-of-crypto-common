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

import { AbilityPowerType } from "../abilities/ability_properties";
import { XY } from "../utils/math";

export interface IAuraOnMap {
    xy: XY;
    range: number;
    isBuff: boolean;
    isSmallUnit: boolean;
}

export class EffectProperties {
    public readonly name: string;

    public laps: number;

    public readonly desc: string;

    public constructor(name: string, laps: number, desc: string) {
        this.name = name;
        this.laps = laps;
        this.desc = desc;
    }
}

export class AuraEffectProperties {
    public readonly name: string;

    public range: number;

    public readonly desc: string;

    public power: number;

    public readonly is_buff: boolean;

    public readonly power_type: AbilityPowerType;

    public constructor(
        name: string,
        range: number,
        desc: string,
        power: number,
        is_buff: boolean,
        power_type: AbilityPowerType,
    ) {
        this.name = name;
        this.range = range;
        this.desc = desc;
        this.power = power;
        this.is_buff = is_buff;
        this.power_type = power_type;
    }
}
