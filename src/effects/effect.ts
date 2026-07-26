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

import { NUMBER_OF_LAPS_TOTAL } from "../constants";
import { EffectProperties } from "./effect_properties";

export class Effect {
    private readonly defaultProperties: EffectProperties;
    private effectProperties: EffectProperties;
    public constructor(effectProperties: EffectProperties) {
        this.defaultProperties = effectProperties;
        this.effectProperties = structuredClone(this.defaultProperties);
    }
    public getName(): string {
        return this.effectProperties.name;
    }
    public getDesc(): string {
        return this.effectProperties.desc;
    }
    public getLaps(): number {
        return this.effectProperties.laps;
    }
    public getPower(): number {
        return this.effectProperties.power;
    }
    public getStacks(): number {
        return this.effectProperties.stacks;
    }
    public getProperties(): EffectProperties {
        return this.effectProperties;
    }
    public setPower(power: number): void {
        this.effectProperties.power = power;
    }
    public setStacks(stacks: number): void {
        this.effectProperties.stacks = stacks;
    }
    /**
     * Rewrites the description a freshly built effect carries. Used by stacking effects to append their
     * live stack count — the string is what UnitProperties.applied_effects_descriptions serialises and the
     * debuff tooltip renders, the same way Deep Wounds shows its accumulated power on the target.
     */
    public setDesc(desc: string): void {
        this.effectProperties.desc = desc;
    }
    public extend(): void {
        if (
            this.effectProperties.laps === Number.MAX_SAFE_INTEGER ||
            this.effectProperties.laps === NUMBER_OF_LAPS_TOTAL
        ) {
            return;
        }

        this.effectProperties.laps += 1;
    }
    public getDefaultProperties(): EffectProperties {
        return structuredClone(this.defaultProperties);
    }
    public minusLap(): void {
        if (
            this.effectProperties.laps === Number.MAX_SAFE_INTEGER ||
            this.effectProperties.laps === NUMBER_OF_LAPS_TOTAL
        ) {
            return;
        }

        if (this.effectProperties.laps > 0) {
            this.effectProperties.laps -= 1;
        }
        if (this.effectProperties.laps < 0) {
            this.effectProperties.laps = 0;
        }
    }
}
