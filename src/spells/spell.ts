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

import type { FactionType } from "../generated/protobuf/v1/types_gen";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { IModifyableUnitProperties } from "../units/unit_properties";
import { SpellMultiplierType, SpellPowerType, SpellProperties, SpellTargetType } from "./spell_properties";

export interface ICalculatedBuffsDebuffsEffect {
    baseStats: IModifyableUnitProperties;
    additionalStats: IModifyableUnitProperties;
}

export interface ISpellParams {
    spellProperties: SpellProperties;
    amount: number;
}

export class Spell {
    private readonly spellProperties: SpellProperties;
    protected amountRemaining: number;
    private readonly isSummonSpell: boolean;
    private readonly summonUnitFaction: FactionType = PBTypes.FactionVals.NO_FACTION;
    private readonly summonUnitName: string = "";
    public constructor(spellParams: ISpellParams) {
        this.spellProperties = spellParams.spellProperties;
        this.amountRemaining = spellParams.amount;
        this.isSummonSpell = this.spellProperties.name.startsWith("Summon ");
        if (this.isSummonSpell) {
            if (this.spellProperties.name.endsWith(" Wolves")) {
                this.summonUnitFaction = PBTypes.FactionVals.NATURE;
                this.summonUnitName = "Wolf";
            }
        }
    }
    public getFaction(): FactionType {
        return this.spellProperties.faction;
    }
    public getName(): string {
        return this.spellProperties.name;
    }
    public getLevel(): number {
        return this.spellProperties.level;
    }
    public getDesc(): string[] {
        return this.spellProperties.desc;
    }
    public getSpellTargetType(): SpellTargetType {
        return this.spellProperties.spell_target_type;
    }
    public getPower(): number {
        return this.spellProperties.power;
    }
    public getPowerType(): SpellPowerType {
        return this.spellProperties.power_type;
    }
    public getMultiplierType(): SpellMultiplierType {
        return this.spellProperties.multiplier_type;
    }
    public getLapsTotal(): number {
        return this.spellProperties.laps;
    }
    public isBuff(): boolean {
        return this.spellProperties.is_buff;
    }
    public isSelfCastAllowed(): boolean {
        return this.spellProperties.self_cast_allowed;
    }
    public isSelfDebuffApplicable(): boolean {
        return this.spellProperties.self_debuff_applies;
    }
    public getMinimalCasterStackPower(): number {
        return this.spellProperties.minimal_caster_stack_power;
    }
    public getConflictsWith(): string[] {
        return this.spellProperties.conflicts_with;
    }
    public isRemaining(): boolean {
        return this.amountRemaining > 0;
    }
    public isGiftable(): boolean {
        return this.spellProperties.is_giftable;
    }
    public getMaximumGiftLevel(): number {
        return this.spellProperties.maximum_gift_level;
    }
    public isSummon(): boolean {
        return this.isSummonSpell;
    }
    public getSummonUnitRace(): FactionType {
        return this.summonUnitFaction;
    }
    public getSummonUnitName(): string {
        return this.summonUnitName;
    }
    public getSpellProperties(): SpellProperties {
        return structuredClone(this.spellProperties);
    }
    public getAmount(): number {
        return this.amountRemaining;
    }
    public setPower(power: number): void {
        this.spellProperties.power = power;
    }
    public setDesc(desc: string[]): void {
        this.spellProperties.desc = desc;
    }
    public increaseAmount(): void {
        this.amountRemaining = Math.floor(this.amountRemaining + 1);
    }
    public decreaseAmount(): void {
        if (this.isRemaining()) {
            this.amountRemaining -= 1;
        }
        this.amountRemaining = Math.floor(this.amountRemaining);
    }
}
