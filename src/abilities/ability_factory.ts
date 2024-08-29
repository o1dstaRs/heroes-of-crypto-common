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

import { getAbilityConfig } from "../configuration/config_provider";
import { EffectFactory } from "../effects/effect_factory";
import { Ability } from "./ability";

export const abilityToTextureName = (abilityName: string): string =>
    `${abilityName.toLowerCase().replace(/ /g, "_")}_256`;

export class AbilityFactory {
    protected readonly effectsFactory: EffectFactory;

    public constructor(effectsFactory: EffectFactory) {
        this.effectsFactory = effectsFactory;
    }

    public getEffectsFactory(): EffectFactory {
        return this.effectsFactory;
    }

    public makeAbility(name: string) {
        const abilityConfig = getAbilityConfig(name);

        return new Ability(
            abilityConfig,
            this.effectsFactory.makeEffect(abilityConfig.effect),
            this.effectsFactory.makeAuraEffect(abilityConfig.aura_effect),
        );
    }
}
