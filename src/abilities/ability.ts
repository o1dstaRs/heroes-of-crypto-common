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

import { AuraEffect } from "../effects/aura_effect";
import { Effect } from "../effects/effect";
import { Spell } from "../spells/spell";
import { AbilityPowerType, AbilityProperties, AbilityType } from "./ability_properties";

export class Ability {
    private readonly abilityProperties: AbilityProperties;

    private readonly effect: Effect | undefined;

    private readonly auraEffect: AuraEffect | undefined;

    private readonly spell: Spell | undefined;

    public constructor(
        abilityProperties: AbilityProperties,
        effect: Effect | undefined,
        auraEffect: AuraEffect | undefined,
        spell: Spell | undefined,
    ) {
        this.abilityProperties = abilityProperties;
        this.effect = effect;
        this.auraEffect = auraEffect;
        this.spell = spell;
    }

    public getName(): string {
        return this.abilityProperties.name;
    }

    public getType(): AbilityType {
        return this.abilityProperties.type;
    }

    public getDesc(): string[] {
        return this.abilityProperties.desc;
    }

    public getPower(): number {
        return this.abilityProperties.power;
    }

    public getPowerType(): AbilityPowerType {
        return this.abilityProperties.power_type;
    }

    public getSkipResponse(): boolean {
        return this.abilityProperties.skip_response;
    }

    public getEffect(): Effect | undefined {
        if (this.effect) {
            return new Effect(this.effect.getDefaultProperties());
        }

        return undefined;
    }

    public getEffectName(): string | undefined {
        return this.effect?.getName();
    }

    public getSpell(): Spell | undefined {
        return this.spell;
    }

    public getAuraEffect(): AuraEffect | undefined {
        if (this.auraEffect) {
            this.auraEffect.toDefault();
            return this.auraEffect;
        }

        return undefined;
    }

    public getAuraEffectName(): string | undefined {
        return this.auraEffect?.getName();
    }

    public getProperties(): AbilityProperties {
        return structuredClone(this.abilityProperties);
    }

    public isStackPowered(): boolean {
        return this.abilityProperties.stack_powered;
    }
}
