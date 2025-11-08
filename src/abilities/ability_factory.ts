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

import { getAbilityConfig, getSpellConfig } from "../configuration/config_provider";
import { EffectFactory } from "../effects/effect_factory";
import { FactionType } from "../factions/faction_type";
import { Spell } from "../spells/spell";
import { Ability } from "./ability";

export class AbilityFactory {
    protected readonly effectFactory: EffectFactory;
    public constructor(effectFactory: EffectFactory) {
        this.effectFactory = effectFactory;
    }
    public getEffectsFactory(): EffectFactory {
        return this.effectFactory;
    }
    public makeAbility(name: string) {
        const abilityConfig = getAbilityConfig(name);
        let spell: Spell | undefined = undefined;
        if (abilityConfig.can_be_cast) {
            spell = new Spell({ spellProperties: getSpellConfig(FactionType.NO_TYPE, abilityConfig.name), amount: 1 });
        }

        return new Ability(
            abilityConfig,
            this.effectFactory.makeEffect(abilityConfig.effect),
            this.effectFactory.makeAuraEffect(abilityConfig.aura_effect),
            spell,
        );
    }
}
