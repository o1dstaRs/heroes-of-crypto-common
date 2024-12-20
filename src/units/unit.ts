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

import Denque from "denque";
import { Ability } from "../abilities/ability";
import { AbilityFactory } from "../abilities/ability_factory";
import { AbilityPowerType } from "../abilities/ability_properties";
import { getSpellConfig } from "../configuration/config_provider";
import {
    LUCK_MAX_CHANGE_FOR_TURN,
    LUCK_MAX_VALUE_TOTAL,
    MAX_UNIT_STACK_POWER,
    MIN_UNIT_STACK_POWER,
    MORALE_MAX_VALUE_TOTAL,
    NUMBER_OF_ARMAGEDDON_WAVES,
    NUMBER_OF_LAPS_TOTAL,
    MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE,
} from "../constants";
import { AuraEffect } from "../effects/aura_effect";
import { Effect } from "../effects/effect";
import { EffectFactory } from "../effects/effect_factory";
import { AllFactionsType, FactionType, ToFactionType } from "../factions/faction_type";
import {
    getCellForPosition,
    getCellsAroundCell,
    getCellsAroundPosition,
    getLargeUnitAttackCells,
    isPositionWithinGrid,
    getDistanceToFurthestCorner,
} from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import { IWeightedRoute } from "../grid/path_definitions";
import { ISceneLog } from "../scene/scene_log_interface";
import { AppliedSpell } from "../spells/applied_spell";
import { Spell } from "../spells/spell";
import { calculateBuffsDebuffsEffect } from "../spells/spell_helper";
import { getLapString, getRandomInt } from "../utils/lib";
import { winningAtLeastOneEventProbability, XY } from "../utils/math";
import { AttackType, MovementType, TeamType, UnitProperties, UnitType } from "./unit_properties";

export interface IAttackTargets {
    unitIds: Set<string>;
    attackCells: XY[];
    attackCellHashes: Set<number>;
    attackCellHashesToLargeCells: Map<number, XY[]>;
}

export interface IUnitPropertiesProvider {
    getName(): string;

    getHp(): number;

    getMaxHp(): number;

    getSteps(): number;

    getMorale(): number;

    getLuck(): number;

    getSpeed(): number;

    getFaction(): FactionType;

    getBaseArmor(): number;

    getBaseAttack(): number;

    getAttackType(): AttackType;

    getAttack(): number;

    getAttackDamageMin(): number;

    getAttackDamageMax(): number;

    getAttackRange(): number;

    getRangeShots(): number;

    getRangeShotDistance(): number;

    getMagicResist(): number;

    getSpellsCount(): number;

    getCanCastSpells(): boolean;

    getMovementType(): MovementType;

    canFly(): boolean;

    getExp(): number;

    getSize(): number;

    getAmountAlive(): number;

    getAmountDied(): number;

    getStackPower(): number;

    getTeam(): TeamType;

    getUnitType(): UnitType;

    getSmallTextureName(): string;

    getLargeTextureName(): string;

    getAuraRanges(): number[];

    getAuraIsBuff(): boolean[];
}

export interface IUnitAIRepr {
    getId(): string;
    getTeam(): TeamType;
    getSteps(): number;
    getSpeed(): number;
    getSize(): number;
    canFly(): boolean;
    getTarget(): string;
    getAttackRange(): number;
    isSmallSize(): boolean;
    canMove(): boolean;
    getBaseCell(): XY;
    getCells(): XY[];
    getAttackType(): AttackType;
    hasAbilityActive(abilityName: string): boolean;
}

export interface IBoardObj {
    isSmallSize(): boolean;
    getPosition(): XY;
    setRenderPosition(x: number, y: number): void;
}

interface IDamageable {
    applyDamage(minusHp: number, chanceToBreak: number, sceneLog: ISceneLog, extendBreak: boolean): void;

    calculatePossibleLosses(minusHp: number): number;

    isDead(): boolean;
}

interface IDamager {
    calculateAttackDamageMin(
        attackRate: number,
        enemyUnit: Unit,
        isRangeAttack: boolean,
        synergyAbilityPowerIncrease: number,
        divisor: number,
        abilityMultiplier: number,
    ): number;

    calculateAttackDamageMax(
        attackRate: number,
        enemyUnit: Unit,
        isRangeAttack: boolean,
        synergyAbilityPowerIncrease: number,
        divisor: number,
        abilityMultiplier: number,
    ): number;

    calculateAttackDamage(
        enemyUnit: Unit,
        attackType: AttackType,
        synergyAbilityPowerIncrease: number,
        divisor: number,
        abilityMultiplier: number,
    ): number;

    getAttackTypeSelection(): AttackType;

    selectAttackType(selectedAttackType: AttackType): boolean;
}

export class Unit implements IUnitPropertiesProvider, IDamageable, IDamager, IUnitAIRepr, IBoardObj {
    protected readonly unitProperties: UnitProperties;

    protected readonly initialUnitProperties: UnitProperties;

    protected readonly gridSettings: GridSettings;

    protected readonly teamType: TeamType;

    protected readonly unitType: UnitType;

    protected readonly summoned: boolean;

    protected buffs: AppliedSpell[];

    protected debuffs: AppliedSpell[];

    protected readonly position: XY;

    protected renderPosition: XY;

    protected spells: Spell[];

    protected effects: Effect[];

    protected abilities: Ability[] = [];

    protected readonly auraEffects: AuraEffect[] = [];

    protected readonly effectFactory: EffectFactory;

    protected readonly abilityFactory: AbilityFactory;

    protected selectedAttackType: AttackType;

    protected possibleAttackTypes: AttackType[] = [];

    protected maxRangeShots = 0;

    protected responded = false;

    protected onHourglass = false;

    protected currentAttackModIncrease = 0;

    protected adjustedBaseStatsLaps: number[] = [];

    protected luckPerTurn: number = 0;

    protected constructor(
        unitProperties: UnitProperties,
        gridSettings: GridSettings,
        teamType: TeamType,
        unitType: UnitType,
        abilityFactory: AbilityFactory,
        effectFactory: EffectFactory,
        summoned: boolean,
    ) {
        this.unitProperties = unitProperties;
        this.initialUnitProperties = structuredClone(unitProperties);
        this.gridSettings = gridSettings;
        this.teamType = teamType;
        this.unitType = unitType;
        this.effectFactory = effectFactory;
        this.summoned = summoned;

        if (this.unitProperties.attack_type === AttackType.MELEE) {
            this.selectedAttackType = AttackType.MELEE;
        } else if (this.unitProperties.attack_type === AttackType.MELEE_MAGIC) {
            this.selectedAttackType = AttackType.MELEE_MAGIC;
        } else if (this.unitProperties.attack_type === AttackType.RANGE) {
            this.selectedAttackType = AttackType.RANGE;
        } else {
            this.selectedAttackType = AttackType.MAGIC;
        }

        this.renderPosition = { x: 0, y: 0 };
        this.position = { x: 0, y: 0 };
        this.spells = [];
        this.buffs = [];
        this.debuffs = [];
        this.maxRangeShots = this.unitProperties.range_shots;
        this.abilityFactory = abilityFactory;
        this.effects = [];
        this.parseAbilities();
        this.parseAuraEffects();
    }

    public static createUnit(
        unitProperties: UnitProperties,
        gridSettings: GridSettings,
        teamType: TeamType,
        unitType: UnitType,
        abilityFactory: AbilityFactory,
        effectFactory: EffectFactory,
        summoned: boolean,
    ): Unit {
        const unit = new Unit(
            unitProperties,
            gridSettings,
            teamType,
            unitType,
            abilityFactory,
            effectFactory,
            summoned,
        );
        unit.parseSpells();
        return unit;
    }

    public getSpells(): Spell[] {
        return this.spells;
    }

    public getBuff(buffName: string): AppliedSpell | undefined {
        for (const b of this.buffs) {
            if (buffName === b.getName()) {
                return b;
            }
        }

        return undefined;
    }

    public getBuffs(): AppliedSpell[] {
        return this.buffs;
    }

    public getDebuff(debuffName: string): AppliedSpell | undefined {
        for (const db of this.debuffs) {
            if (debuffName === db.getName()) {
                return db;
            }
        }

        return undefined;
    }

    public getDebuffs(): AppliedSpell[] {
        return this.debuffs;
    }

    public deleteAbility(abilityName: string): Ability | undefined {
        let abilityToDelete: Ability | undefined = undefined;
        const updatedAbilities: Ability[] = [];
        for (const a of this.abilities) {
            if (a.getName() === abilityName) {
                abilityToDelete = a;
            } else {
                updatedAbilities.push(a);
            }
        }
        this.abilities = updatedAbilities;

        for (let i = this.unitProperties.abilities.length - 1; i >= 0; i--) {
            if (this.unitProperties.abilities[i] === abilityName) {
                this.unitProperties.abilities.splice(i, 1);
                this.unitProperties.abilities_descriptions.splice(i, 1);
                this.unitProperties.abilities_stack_powered.splice(i, 1);
                this.unitProperties.abilities_auras.splice(i, 1);
            }
        }

        const spellName = abilityName.substring(1, abilityName.length);
        this.spells = this.spells.filter((s: Spell) => s.getName() !== spellName);
        for (let i = this.unitProperties.spells.length - 1; i >= 0; i--) {
            if (this.unitProperties.spells[i] === spellName) {
                this.unitProperties.spells.splice(i, 1);
            }
        }
        if (this.unitProperties.spells.length <= 0) {
            this.unitProperties.can_cast_spells = false;
        }

        return abilityToDelete;
    }

    public addAbility(ability: Ability): void {
        this.unitProperties.abilities.push(ability.getName());
        if (ability.getName() === "Chain Lightning") {
            const percentage = Number((this.calculateAbilityMultiplier(ability, 0) * 100).toFixed(2));
            const description = ability.getDesc().join("\n");
            const updatedDescription = description
                .replace("{}", Number(percentage.toFixed()).toString())
                .replace("{}", Number(((percentage * 7) / 8).toFixed()).toString())
                .replace("{}", Number(((percentage * 6) / 8).toFixed()).toString())
                .replace("{}", Number(((percentage * 5) / 8).toFixed()).toString());
            this.unitProperties.abilities_descriptions.push(updatedDescription);
        }
        if (ability.getName() === "Paralysis") {
            const description = ability.getDesc().join("\n");
            const reduction = this.calculateAbilityApplyChance(ability, 0);
            const chance = Math.min(100, reduction * 2);
            const updatedDescription = description
                .replace("{}", Number(chance.toFixed(2)).toString())
                .replace("{}", Number(reduction.toFixed(2)).toString());
            this.unitProperties.abilities_descriptions.push(updatedDescription);
        } else {
            this.unitProperties.abilities_descriptions.push(
                ability.getDesc().join("\n").replace(/\{\}/g, ability.getPower().toString()),
            );
        }
        this.unitProperties.abilities_stack_powered.push(ability.isStackPowered());
        this.unitProperties.abilities_auras.push(!!ability.getAuraEffect());
        if (this.parseAbilities()) {
            this.parseSpells();
        }
    }

    public getTarget(): string {
        return this.unitProperties.target;
    }

    public setTarget(targetUnitId: string): void {
        this.unitProperties.target = targetUnitId;
    }

    public resetTarget(): void {
        this.unitProperties.target = this.initialUnitProperties.target;
    }

    public getAbilities(): Ability[] {
        if (this.hasEffectActive("Break")) {
            return [];
        }

        return this.abilities;
    }

    public getAuraEffects(): AuraEffect[] {
        if (this.hasEffectActive("Break")) {
            return [];
        }

        return this.auraEffects;
    }

    public hasAuraEffect(auraEffectName: string): boolean {
        for (const ae of this.auraEffects) {
            if (auraEffectName === ae.getName()) {
                return true;
            }
        }

        return false;
    }

    public getAbility(abilityName: string): Ability | undefined {
        if (this.hasEffectActive("Break")) {
            return undefined;
        }

        for (const a of this.abilities) {
            if (abilityName === a.getName()) {
                return a;
            }
        }

        return undefined;
    }

    public getEffect(effectName: string): Effect | undefined {
        for (const e of this.effects) {
            if (effectName === e.getName()) {
                return e;
            }
        }

        return undefined;
    }

    public getAuraEffect(auraEffectName: string): AuraEffect | undefined {
        for (const ae of this.auraEffects) {
            if (auraEffectName === ae.getName()) {
                return ae;
            }
        }

        return undefined;
    }

    public getCumulativeHp(): number {
        if (this.isDead()) {
            return 0;
        }

        let cumulativeHp = this.unitProperties.hp;
        if (cumulativeHp < 0) {
            cumulativeHp = 0;
        }

        return (this.unitProperties.amount_alive - 1) * this.unitProperties.max_hp + cumulativeHp;
    }

    public getCumulativeMaxHp(): number {
        return this.unitProperties.amount_alive * this.unitProperties.max_hp;
    }

    public getEffects(): Effect[] {
        return this.effects;
    }

    public isSkippingThisTurn(): boolean {
        const effects = this.getEffects();
        for (const e of effects) {
            if (e.getName() === "Stun" || e.getName() === "Blindness") {
                return true;
            }
        }

        return false;
    }

    public applyEffect(effect: Effect): boolean {
        // not checking for duplicates here, do it on a caller side
        if (
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_laps.length &&
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_powers.length &&
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_descriptions.length
        ) {
            this.deleteEffect(effect.getName());
            this.effects.push(effect);
            this.unitProperties.applied_effects.push(effect.getName());
            this.unitProperties.applied_effects_laps.push(effect.getLaps());
            this.unitProperties.applied_effects_powers.push(effect.getPower());
            this.unitProperties.applied_effects_descriptions.push(
                effect.getDesc().replace(/\{\}/g, effect.getPower().toString()),
            );
            return true;
        }

        return false;
    }

    public refreshPreTurnState(sceneLog: ISceneLog) {
        if (this.unitProperties.hp !== this.unitProperties.max_hp && this.hasAbilityActive("Wild Regeneration")) {
            const healedHp = this.unitProperties.max_hp - this.unitProperties.hp;
            this.unitProperties.hp = this.unitProperties.max_hp;
            sceneLog.updateLog(`${this.getName()} auto regenerated to its maximum hp (+${healedHp})`);
            this.unitProperties.can_cast_spells = this.unitProperties.spells.length > 0;
        }
    }

    public deleteEffect(effectName: string): void {
        this.effects = this.effects.filter((e) => e.getName() !== effectName);

        if (
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_laps.length &&
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_descriptions.length &&
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_powers.length
        ) {
            for (let i = this.unitProperties.applied_effects.length - 1; i >= 0; i--) {
                if (this.unitProperties.applied_effects[i] === effectName) {
                    this.unitProperties.applied_effects.splice(i, 1);
                    this.unitProperties.applied_effects_laps.splice(i, 1);
                    this.unitProperties.applied_effects_descriptions.splice(i, 1);
                    this.unitProperties.applied_effects_powers.splice(i, 1);
                }
            }
        }
    }

    public deleteAllEffects(): void {
        this.effects = [];

        if (
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_laps.length &&
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_descriptions.length &&
            this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_powers.length
        ) {
            for (let i = this.unitProperties.applied_effects.length - 1; i >= 0; i--) {
                this.unitProperties.applied_effects.splice(i, 1);
                this.unitProperties.applied_effects_laps.splice(i, 1);
                this.unitProperties.applied_effects_descriptions.splice(i, 1);
                this.unitProperties.applied_effects_powers.splice(i, 1);
            }
        }
    }

    public deleteBuff(buffName: string): void {
        this.buffs = this.buffs.filter((b) => b.getName() !== buffName);

        if (
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_laps.length &&
            this.unitProperties.applied_buffs.length == this.unitProperties.applied_buffs_descriptions.length &&
            this.unitProperties.applied_buffs.length == this.unitProperties.applied_buffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_buffs.length - 1; i >= 0; i--) {
                if (this.unitProperties.applied_buffs[i] === buffName) {
                    this.unitProperties.applied_buffs.splice(i, 1);
                    this.unitProperties.applied_buffs_laps.splice(i, 1);
                    this.unitProperties.applied_buffs_descriptions.splice(i, 1);
                    this.unitProperties.applied_buffs_powers.splice(i, 1);
                }
            }
        }
    }

    public deleteAllBuffs(): void {
        this.buffs = [];

        if (
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_laps.length &&
            this.unitProperties.applied_buffs.length == this.unitProperties.applied_buffs_descriptions.length &&
            this.unitProperties.applied_buffs.length == this.unitProperties.applied_buffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_buffs.length - 1; i >= 0; i--) {
                const buffName = this.unitProperties.applied_buffs[i];
                if (!buffName.endsWith(" Augment")) {
                    this.unitProperties.applied_buffs.splice(i, 1);
                    this.unitProperties.applied_buffs_laps.splice(i, 1);
                    this.unitProperties.applied_buffs_descriptions.splice(i, 1);
                    this.unitProperties.applied_buffs_powers.splice(i, 1);
                }
            }
        }
    }

    public deleteDebuff(debuffName: string): void {
        this.debuffs = this.debuffs.filter((d) => d.getName() !== debuffName);

        if (
            this.unitProperties.applied_debuffs.length === this.unitProperties.applied_debuffs_laps.length &&
            this.unitProperties.applied_debuffs.length == this.unitProperties.applied_debuffs_descriptions.length &&
            this.unitProperties.applied_debuffs.length == this.unitProperties.applied_debuffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_debuffs.length - 1; i >= 0; i--) {
                if (this.unitProperties.applied_debuffs[i] === debuffName) {
                    this.unitProperties.applied_debuffs.splice(i, 1);
                    this.unitProperties.applied_debuffs_laps.splice(i, 1);
                    this.unitProperties.applied_debuffs_descriptions.splice(i, 1);
                    this.unitProperties.applied_debuffs_powers.splice(i, 1);
                }
            }
        }
    }

    public deleteAllDebuffs(): void {
        this.debuffs = [];

        if (
            this.unitProperties.applied_debuffs.length === this.unitProperties.applied_debuffs_laps.length &&
            this.unitProperties.applied_debuffs.length == this.unitProperties.applied_debuffs_descriptions.length &&
            this.unitProperties.applied_debuffs.length == this.unitProperties.applied_debuffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_debuffs.length - 1; i >= 0; i--) {
                this.unitProperties.applied_debuffs.splice(i, 1);
                this.unitProperties.applied_debuffs_laps.splice(i, 1);
                this.unitProperties.applied_debuffs_descriptions.splice(i, 1);
                this.unitProperties.applied_debuffs_powers.splice(i, 1);
            }
        }
    }

    public minusLap(): void {
        const dismoraleDebuff = this.getDebuff("Dismorale");
        if (!dismoraleDebuff) {
            for (const ef of this.effects) {
                if (ef.getLaps() > 0) {
                    ef.minusLap();
                }

                if (ef.getLaps()) {
                    if (
                        this.unitProperties.applied_effects.length ===
                            this.unitProperties.applied_effects_laps.length &&
                        this.unitProperties.applied_effects.length ===
                            this.unitProperties.applied_effects_descriptions.length &&
                        this.unitProperties.applied_effects.length === this.unitProperties.applied_effects_powers.length
                    ) {
                        for (let i = 0; i < this.unitProperties.applied_effects.length; i++) {
                            if (
                                this.unitProperties.applied_effects[i] === ef.getName() &&
                                this.unitProperties.applied_effects_laps[i] !== Number.MAX_SAFE_INTEGER &&
                                this.unitProperties.applied_effects_laps[i] !== NUMBER_OF_LAPS_TOTAL
                            ) {
                                this.unitProperties.applied_effects_laps[i]--;
                            }
                        }
                    }
                } else {
                    this.deleteEffect(ef.getName());
                }
            }
        }

        const moraleBuff = this.getBuff("Morale");
        if (moraleBuff) {
            this.deleteBuff("Morale");
        } else {
            for (const b of this.buffs) {
                if (b.getLaps() > 0 && b) {
                    b.minusLap();
                }

                if (b.getLaps()) {
                    if (this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_laps.length) {
                        for (let i = 0; i < this.unitProperties.applied_buffs.length; i++) {
                            if (
                                this.unitProperties.applied_buffs[i] === b.getName() &&
                                this.unitProperties.applied_buffs_laps[i] !== Number.MAX_SAFE_INTEGER &&
                                this.unitProperties.applied_buffs_laps[i] !== NUMBER_OF_LAPS_TOTAL
                            ) {
                                this.unitProperties.applied_buffs_laps[i]--;
                            }
                        }
                    }
                } else {
                    this.deleteBuff(b.getName());
                }
            }
        }

        if (dismoraleDebuff) {
            this.deleteDebuff("Dismorale");
        } else {
            for (const d of this.debuffs) {
                if (d.getLaps() > 0) {
                    d.minusLap();
                }

                if (d.getLaps()) {
                    if (
                        this.unitProperties.applied_debuffs.length === this.unitProperties.applied_debuffs_laps.length
                    ) {
                        for (let i = 0; i < this.unitProperties.applied_debuffs.length; i++) {
                            if (
                                this.unitProperties.applied_debuffs[i] === d.getName() &&
                                this.unitProperties.applied_debuffs_laps[i] !== Number.MAX_SAFE_INTEGER &&
                                this.unitProperties.applied_debuffs_laps[i] !== NUMBER_OF_LAPS_TOTAL
                            ) {
                                this.unitProperties.applied_debuffs_laps[i]--;
                            }
                        }
                    }
                } else {
                    this.deleteDebuff(d.getName());
                }
            }
        }
    }

    public hasDebuffActive(debuffName: string): boolean {
        for (const b of this.getDebuffs()) {
            if (b.getName() === debuffName) {
                return true;
            }
        }

        return false;
    }

    public hasBuffActive(buffName: string): boolean {
        for (const b of this.getBuffs()) {
            if (b.getName() === buffName) {
                return true;
            }
        }

        return false;
    }

    public hasEffectActive(effectName: string): boolean {
        for (const ef of this.getEffects()) {
            if (ef.getName() === effectName) {
                return true;
            }
        }

        return false;
    }

    public hasAbilityActive(abilityName: string): boolean {
        if (this.hasEffectActive("Break")) {
            return false;
        }

        for (const ab of this.abilities) {
            if (ab.getName() === abilityName) {
                return true;
            }
        }

        return false;
    }

    public hasSpellRemaining(spellName: string): boolean {
        for (const s of this.spells) {
            if (s.getName() === spellName && s.isRemaining()) {
                return true;
            }
        }

        return false;
    }

    public getAppliedAuraEffect(auraEffectName: string): AuraEffect | undefined {
        if (
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_laps.length &&
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_descriptions.length &&
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_buffs.length - 1; i >= 0; i--) {
                if (
                    auraEffectName === this.unitProperties.applied_buffs[i] &&
                    this.unitProperties.applied_buffs_laps[i] === Number.MAX_SAFE_INTEGER
                ) {
                    const auraEffectWords = auraEffectName.split(/\s+/);
                    const auraEffectString = auraEffectWords.slice(0, -1).join(" ");
                    const auraEffect = this.effectFactory.makeAuraEffect(auraEffectString);
                    if (auraEffect) {
                        auraEffect.setPower(this.unitProperties.applied_buffs_powers[i]);
                        return auraEffect;
                    }
                }
            }
        }

        return undefined;
    }

    public getAbilityPower(abilityName: string): number {
        if (this.hasEffectActive("Break")) {
            return 0;
        }

        for (const ab of this.abilities) {
            if (ab.getName() === abilityName) {
                return ab.getPower();
            }
        }

        return 0;
    }

    public getFaction(): FactionType {
        return this.unitProperties.faction;
    }

    public getName(): string {
        return this.unitProperties.name;
    }

    public getHp(): number {
        return this.unitProperties.hp;
    }

    public getMaxHp(): number {
        return this.unitProperties.max_hp;
    }

    public getSteps(): number {
        return this.unitProperties.steps + this.unitProperties.steps_mod;
    }

    public getMorale(): number {
        const { morale } = this.unitProperties;
        if (morale > MORALE_MAX_VALUE_TOTAL) {
            return MORALE_MAX_VALUE_TOTAL;
        }
        if (morale < -MORALE_MAX_VALUE_TOTAL) {
            return -MORALE_MAX_VALUE_TOTAL;
        }
        if (this.hasAbilityActive("Madness") || this.hasAbilityActive("Mechanism")) {
            return 0;
        }

        return morale;
    }

    public getLuck(): number {
        const luck = this.unitProperties.luck + this.unitProperties.luck_mod;
        if (luck > LUCK_MAX_VALUE_TOTAL) {
            return LUCK_MAX_VALUE_TOTAL;
        }
        if (luck < -LUCK_MAX_VALUE_TOTAL) {
            return -LUCK_MAX_VALUE_TOTAL;
        }
        return luck;
    }

    public getSpeed(): number {
        return this.unitProperties.speed;
    }

    public getBaseArmor(): number {
        return this.unitProperties.base_armor;
    }

    public getBaseAttack(): number {
        return this.unitProperties.base_attack;
    }

    public getArmor(): number {
        return Math.max(1, this.unitProperties.base_armor + this.unitProperties.armor_mod);
    }

    public getRangeArmor(): number {
        return Math.max(1, this.unitProperties.range_armor + this.unitProperties.armor_mod);
    }

    public getAttackType(): AttackType {
        return this.unitProperties.attack_type;
    }

    public getAttack(): number {
        return this.unitProperties.base_attack + this.unitProperties.attack_mod;
    }

    public getAttackDamageMin(): number {
        return this.unitProperties.attack_damage_min;
    }

    public getAttackDamageMax(): number {
        return this.unitProperties.attack_damage_max;
    }

    public getAttackRange(): number {
        return this.unitProperties.attack_range;
    }

    public getRangeShots(): number {
        return this.unitProperties.range_shots_mod
            ? this.unitProperties.range_shots_mod
            : this.unitProperties.range_shots;
    }

    public decreaseNumberOfShots(): void {
        this.unitProperties.range_shots -= 1;
        if (this.unitProperties.range_shots < 0) {
            this.unitProperties.range_shots = 0;
        }
        this.unitProperties.range_shots = Math.floor(this.unitProperties.range_shots);
    }

    public getRangeShotDistance(): number {
        return this.unitProperties.shot_distance;
    }

    public getMagicResist(): number {
        return this.unitProperties.magic_resist_mod
            ? this.unitProperties.magic_resist_mod
            : this.unitProperties.magic_resist;
    }

    public getSpellsCount(): number {
        if (this.unitType === UnitType.CREATURE && this.hasEffectActive("Break")) {
            return 0;
        }

        return this.unitProperties.spells.length;
    }

    public getCanCastSpells(): boolean {
        return this.unitProperties.can_cast_spells;
    }

    public getMovementType(): MovementType {
        return this.unitProperties.movement_type;
    }

    public canFly(): boolean {
        return this.unitProperties.movement_type === MovementType.FLY;
    }

    public getExp(): number {
        return this.unitProperties.exp;
    }

    public getTeam(): TeamType {
        return this.teamType;
    }

    public getOppositeTeam(): TeamType {
        if (this.teamType === TeamType.NO_TEAM) {
            return TeamType.NO_TEAM;
        }

        if (this.teamType === TeamType.LOWER) {
            return TeamType.UPPER;
        }

        return TeamType.LOWER;
    }

    public getUnitType(): UnitType {
        return this.unitType;
    }

    public getSmallTextureName(): string {
        return this.unitProperties.small_texture_name;
    }

    public getLargeTextureName(): string {
        return this.unitProperties.large_texture_name;
    }

    public getAmountAlive(): number {
        return this.unitProperties.amount_alive;
    }

    public getAmountDied(): number {
        return this.unitProperties.amount_died;
    }

    public getAuraRanges(): number[] {
        return this.unitProperties.aura_ranges;
    }

    public getAuraIsBuff(): boolean[] {
        return this.unitProperties.aura_is_buff;
    }

    public getStackPower(): number {
        if (this.unitProperties.stack_power > MAX_UNIT_STACK_POWER) {
            return MAX_UNIT_STACK_POWER;
        }
        if (this.unitProperties.stack_power < MIN_UNIT_STACK_POWER) {
            return MIN_UNIT_STACK_POWER;
        }
        return this.unitProperties.stack_power;
    }

    public getId(): string {
        return this.unitProperties.id;
    }

    public setSynergies(synergies: string[]): void {
        this.unitProperties.synergies = synergies;
    }

    public setPosition(x: number, y: number, setRender = true): void {
        if (this.hasAbilityActive("Sniper")) {
            this.setRangeShotDistance(
                Number(
                    (
                        getDistanceToFurthestCorner(this.getPosition(), this.gridSettings) /
                            this.gridSettings.getStep() -
                        0.45
                    ).toFixed(2),
                ),
            );
        }
        this.position.x = x;
        this.position.y = y;

        if (setRender) {
            this.setRenderPosition(x, y);
        }
    }

    public setRenderPosition(x: number, y: number) {
        this.renderPosition.x = x;
        this.renderPosition.y = y;
    }

    public getPosition(): XY {
        return this.position;
    }

    public getBaseCell(): XY {
        return getCellForPosition(this.gridSettings, this.getPosition());
    }

    public getCells(): XY[] {
        if (this.isSmallSize()) {
            const bodyCellPos = getCellForPosition(this.gridSettings, this.getPosition());
            if (!bodyCellPos) {
                return [];
            }

            return [bodyCellPos];
        }

        return getCellsAroundPosition(this.gridSettings, this.getPosition());
    }

    public getSize(): number {
        return this.unitProperties.size;
    }

    public isSmallSize(): boolean {
        return this.unitProperties.size === 1;
    }

    public isSummoned(): boolean {
        return this.summoned;
    }

    public getLevel(): number {
        return this.unitProperties.level;
    }

    public canMove(): boolean {
        return !this.hasEffectActive("Paralysis");
    }

    public increaseAmountAlive(increaseBy: number): void {
        if ((!this.isDead() && this.isSummoned()) || (this.isDead() && !this.isSummoned())) {
            this.unitProperties.amount_alive += increaseBy;
        }
    }

    public increaseAttackMod(increaseBy: number): void {
        if (increaseBy > 0) {
            this.unitProperties.attack_mod = Number((this.unitProperties.attack_mod + increaseBy).toFixed(2));
            this.currentAttackModIncrease = increaseBy;
        } else {
            this.currentAttackModIncrease = 0;
        }
    }

    public cleanupAttackModIncrease(): void {
        const newAttackMod = this.unitProperties.attack_mod - this.currentAttackModIncrease;
        this.unitProperties.attack_mod = Math.max(0, newAttackMod);
    }

    public getCurrentAttackModIncrease(): number {
        return this.currentAttackModIncrease;
    }

    public decreaseAmountDied(decreaseBy: number): void {
        if (!this.isDead() && !this.isSummoned()) {
            this.unitProperties.amount_died -= Math.min(this.unitProperties.amount_died, decreaseBy);
        }
    }

    public randomizeLuckPerTurn(): void {
        let calculatedLuck = getRandomInt(-LUCK_MAX_CHANGE_FOR_TURN, LUCK_MAX_CHANGE_FOR_TURN + 1);
        if (calculatedLuck + this.unitProperties.luck > LUCK_MAX_VALUE_TOTAL) {
            calculatedLuck = LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
        } else if (calculatedLuck + this.unitProperties.luck < -LUCK_MAX_VALUE_TOTAL) {
            calculatedLuck = -LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
        }
        this.unitProperties.luck_mod = calculatedLuck;
        this.luckPerTurn = calculatedLuck;
    }

    public cleanupLuckPerTurn(): void {
        // this.unitProperties.luck_mod = 0;
        this.luckPerTurn = 0;
    }

    public applyArmageddonDamage(armageddonWave: number, sceneLog: ISceneLog): void {
        const aw = Math.floor(armageddonWave);
        if (aw <= 0 || aw > NUMBER_OF_ARMAGEDDON_WAVES) {
            return;
        }

        const canHitPartially = aw === 1;
        const part = aw / NUMBER_OF_ARMAGEDDON_WAVES;
        let armageddonDamage = 0;
        const unitsTotal = this.unitProperties.amount_died + this.unitProperties.amount_alive;

        if (canHitPartially) {
            armageddonDamage = Math.max(
                MIN_ARMAGEDDON_DAMAGE_FIRST_WAVE,
                Math.floor(this.unitProperties.max_hp * unitsTotal * part),
            );
        } else {
            const unitsDamaged = Math.ceil(unitsTotal * part);
            armageddonDamage = unitsDamaged * this.unitProperties.max_hp;
        }

        sceneLog.updateLog(`${this.getName()} got hit by armageddon for ${armageddonDamage} damage`);
        this.applyDamage(armageddonDamage, 0, sceneLog, false);
    }

    public applyDamage(minusHp: number, chanceToBreak: number, sceneLog: ISceneLog, extendBreak = false): number {
        if (minusHp <= 0) {
            return 0;
        }

        if (chanceToBreak > 0 && getRandomInt(0, 100) < Math.min(chanceToBreak, 100)) {
            const breakEffect = this.effectFactory.makeEffect("Break");
            if (breakEffect) {
                const laps = breakEffect.getLaps();
                if (extendBreak) {
                    breakEffect.extend();
                }
                if (this.applyEffect(breakEffect)) {
                    sceneLog.updateLog(`${this.getName()} got Break for ${getLapString(laps)}`);
                }
            }
        }

        if (minusHp < this.unitProperties.hp) {
            this.unitProperties.hp -= minusHp;
            this.handleDamageAnimation(0); // Trigger animation hook with no deaths
            return minusHp;
        }

        this.unitProperties.amount_died += 1;
        this.unitProperties.amount_alive -= 1;
        minusHp -= this.unitProperties.hp;
        let substracted = this.unitProperties.hp;
        this.unitProperties.hp = this.unitProperties.max_hp;

        const amountDied = Math.floor(minusHp / this.unitProperties.max_hp);
        // dead
        if (amountDied >= this.unitProperties.amount_alive) {
            this.unitProperties.amount_died += this.unitProperties.amount_alive;
            const wereAlive = this.unitProperties.amount_alive;
            this.unitProperties.amount_alive = 0;
            this.handleDamageAnimation(wereAlive); // Trigger animation hook with all deaths
            return Math.floor(wereAlive * this.unitProperties.max_hp) + substracted;
        }

        this.unitProperties.amount_died += amountDied;
        this.unitProperties.amount_alive -= amountDied;
        this.unitProperties.hp -= minusHp % this.unitProperties.max_hp;

        this.handleDamageAnimation(amountDied + 1); // Trigger animation hook with the number of deaths

        // Apply "Bitter Experience" if available
        if (this.hasAbilityActive("Bitter Experience")) {
            this.unitProperties.base_armor += 1;
            this.initialUnitProperties.base_armor += 1;
            this.unitProperties.steps += 1;
            this.initialUnitProperties.steps += 1;
        }

        return minusHp + substracted;
    }

    public isDead(): boolean {
        return this.unitProperties.amount_alive <= 0;
    }

    public setAmountAlive(amountAlive: number): void {
        if (amountAlive <= 0) {
            return;
        }

        this.unitProperties.amount_alive = Math.floor(amountAlive);
        this.initialUnitProperties.amount_alive = Math.floor(amountAlive);
    }

    public increaseMorale(moraleAmount: number, synergyMoraleIncrease: number): void {
        if (
            moraleAmount <= 0 ||
            this.hasAbilityActive("Madness") ||
            this.hasAbilityActive("Mechanism") ||
            this.hasBuffActive("Courage") ||
            this.hasBuffActive("Morale") ||
            this.hasDebuffActive("Sadness") ||
            this.hasDebuffActive("Dismorale")
        ) {
            return;
        }

        let newMorale = this.unitProperties.morale + moraleAmount;
        if (newMorale > MORALE_MAX_VALUE_TOTAL) {
            newMorale = MORALE_MAX_VALUE_TOTAL;
        }
        if (newMorale < -MORALE_MAX_VALUE_TOTAL) {
            newMorale = -MORALE_MAX_VALUE_TOTAL;
        }
        this.initialUnitProperties.morale = newMorale - synergyMoraleIncrease;
    }

    public decreaseBaseArmor(armorAmount: number): void {
        this.initialUnitProperties.base_armor = Math.max(
            1,
            Number((this.initialUnitProperties.base_armor - armorAmount).toFixed(2)),
        );
    }

    public increaseBaseArmor(armorAmount: number): void {
        this.initialUnitProperties.base_armor = Number(
            (this.initialUnitProperties.base_armor + armorAmount).toFixed(2),
        );
    }

    public increaseSupply(supplyIncreasePercentage: number): void {
        if (supplyIncreasePercentage <= 0) {
            return;
        }

        this.initialUnitProperties.amount_alive = Math.floor(
            this.initialUnitProperties.amount_alive * (1 + supplyIncreasePercentage / 100),
        );
        this.unitProperties.amount_alive = this.initialUnitProperties.amount_alive;
    }

    public decreaseMorale(moraleAmount: number, synergyMoraleIncrease: number): void {
        if (
            moraleAmount <= 0 ||
            this.hasAbilityActive("Madness") ||
            this.hasAbilityActive("Mechanism") ||
            this.hasBuffActive("Courage") ||
            this.hasBuffActive("Morale") ||
            this.hasDebuffActive("Sadness") ||
            this.hasDebuffActive("Dismorale")
        ) {
            return;
        }

        let newMorale = this.unitProperties.morale - moraleAmount;
        if (newMorale > MORALE_MAX_VALUE_TOTAL) {
            newMorale = MORALE_MAX_VALUE_TOTAL;
        }
        if (newMorale < -MORALE_MAX_VALUE_TOTAL) {
            newMorale = -MORALE_MAX_VALUE_TOTAL;
        }
        this.initialUnitProperties.morale = newMorale - synergyMoraleIncrease;
    }

    public applyTravelledDistanceModifier(cellsTravelled: number, synergyAbilityPowerIncrease: number): void {
        const cruradeAbility = this.getAbility("Crusade");
        if (cruradeAbility) {
            const additionalAttackAndArmor =
                this.calculateAbilityCount(cruradeAbility, synergyAbilityPowerIncrease) * cellsTravelled;
            this.initialUnitProperties.base_attack = Number(
                (this.initialUnitProperties.base_attack + additionalAttackAndArmor).toFixed(2),
            );

            this.initialUnitProperties.base_armor = Number(
                (this.initialUnitProperties.base_armor + additionalAttackAndArmor).toFixed(2),
            );

            this.initialUnitProperties.base_attack = Math.min(50, this.initialUnitProperties.base_attack);
            this.initialUnitProperties.base_armor = Math.min(50, this.initialUnitProperties.base_armor);
        }
    }

    public applyLavaWaterModifier(hasLavaCell: boolean, hasWaterCell: boolean): void {
        if (hasLavaCell && this.hasAbilityActive("Made of Fire") && !this.hasBuffActive("Made of Fire")) {
            const spellProperties = getSpellConfig(FactionType.NO_TYPE, "Made of Fire");
            this.applyBuff(
                new Spell({
                    spellProperties: spellProperties,
                    amount: 1,
                }),
                undefined,
                undefined,
                true,
            );

            this.unitProperties.max_hp = Math.max(
                Math.ceil(this.unitProperties.max_hp + this.unitProperties.max_hp / spellProperties.power),
                this.unitProperties.max_hp,
            );
            this.unitProperties.base_attack = Math.max(
                Number(
                    (this.unitProperties.base_attack + this.unitProperties.base_attack / spellProperties.power).toFixed(
                        2,
                    ),
                ),
                this.unitProperties.base_attack,
            );
            this.unitProperties.base_armor = Math.max(
                Number(
                    (this.unitProperties.base_armor + this.unitProperties.base_armor / spellProperties.power).toFixed(
                        2,
                    ),
                ),
                this.unitProperties.base_armor,
            );
            this.unitProperties.steps = Math.max(
                Number((this.unitProperties.steps + this.unitProperties.steps / spellProperties.power).toFixed(21)),
                this.unitProperties.steps,
            );
            this.unitProperties.speed = Math.max(
                Number((this.unitProperties.speed + this.unitProperties.speed / spellProperties.power).toFixed(1)),
                this.unitProperties.speed,
            );
            this.unitProperties.shot_distance = Math.max(
                Number(
                    (
                        this.unitProperties.shot_distance +
                        this.unitProperties.shot_distance / spellProperties.power
                    ).toFixed(1),
                ),
                this.unitProperties.shot_distance,
            );
            this.unitProperties.magic_resist = Math.max(
                Number(
                    (
                        this.unitProperties.magic_resist +
                        this.unitProperties.magic_resist / spellProperties.power
                    ).toFixed(2),
                ),
                this.unitProperties.magic_resist,
            );
        }

        if (hasWaterCell && this.hasAbilityActive("Made of Water") && !this.hasBuffActive("Made of Water")) {
            this.applyBuff(
                new Spell({
                    spellProperties: getSpellConfig(FactionType.NO_TYPE, "Made of Water"),
                    amount: 1,
                }),
                undefined,
                undefined,
                true,
            );
        }
    }

    public calculatePossibleLosses(minusHp: number): number {
        let amountDied = 0;
        const currentHp = this.unitProperties.hp;

        if (minusHp < currentHp) {
            return amountDied;
        }

        amountDied++;
        minusHp -= currentHp;

        amountDied += Math.floor(minusHp / this.unitProperties.max_hp);
        if (amountDied >= this.unitProperties.amount_alive) {
            return this.unitProperties.amount_alive;
        }

        return amountDied;
    }

    public calculateAuraPower(auraEffect: AuraEffect, synergyAbilityPowerIncrease: number): number {
        let calculatedCoeff = 1;

        if (auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_STEPS_WALK) {
            return auraEffect.getPower();
        }

        if (auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_BASE_ATTACK_AND_ARMOR) {
            return auraEffect.getPower();
        }

        const madeOfFireBuff = this.getBuff("Made of Fire");

        if (
            auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE ||
            auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE ||
            auraEffect.getPowerType() === AbilityPowerType.ABSORB_DEBUFF
        ) {
            calculatedCoeff +=
                (auraEffect.getPower() / 100 / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                (this.getLuck() + synergyAbilityPowerIncrease) / 100 +
                (madeOfFireBuff ? (auraEffect.getPower() / 100) * madeOfFireBuff.getPower() : 0) / 100;
        }

        if (auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_STEPS) {
            return Number(
                (
                    (auraEffect.getPower() / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                    ((this.getLuck() + synergyAbilityPowerIncrease) / 100) * auraEffect.getPower()
                ).toFixed(1),
            );
        }

        return Number((calculatedCoeff * 100).toFixed(2)) - 100;
    }

    public calculateEffectMultiplier(effect: Effect, synergyAbilityPowerIncrease: number): number {
        let calculatedCoeff = 1;
        let combinedPower = effect.getPower() + this.getLuck() + synergyAbilityPowerIncrease;
        if (combinedPower < 0) {
            combinedPower = 1;
        }

        if (effect.getName() === "Pegasus Light") {
            return combinedPower;
        }

        calculatedCoeff *= (combinedPower / 100 / MAX_UNIT_STACK_POWER) * this.getStackPower();

        return calculatedCoeff;
    }

    public hasMindAttackResistance(): boolean {
        return this.hasAbilityActive("Madness") || this.hasAbilityActive("Mechanism");
    }

    public canBeHealed(): boolean {
        return !this.hasAbilityActive("Mechanism");
    }

    public calculateAbilityCount(ability: Ability, synergyAbilityPowerIncrease: number): number {
        if (
            ability.getPowerType() !== AbilityPowerType.GAIN_ATTACK_AND_ARMOR_EACH_STEP &&
            ability.getPowerType() !== AbilityPowerType.ADDITIONAL_STEPS &&
            ability.getPowerType() !== AbilityPowerType.STEAL_ARMOR_ON_HIT &&
            ability.getPowerType() !== AbilityPowerType.REDUCE_BASE_ATTACK_UPON_MELEE_ATTACK &&
            ability.getName() !== "Shatter Armor" &&
            ability.getName() !== "Deep Wounds Level 1" &&
            ability.getName() !== "Deep Wounds Level 2" &&
            ability.getName() !== "Deep Wounds Level 3"
        ) {
            return 0;
        }

        const madeOfFireBuff = this.getBuff("Made of Fire");

        if (
            ability.getName() === "Deep Wounds Level 1" ||
            ability.getName() === "Deep Wounds Level 2" ||
            ability.getName() === "Deep Wounds Level 3"
        ) {
            const deepWoundsPower = Math.max(
                0,
                (ability.getPower() / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                    this.getLuck() +
                    synergyAbilityPowerIncrease +
                    (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0),
            );

            return Number(deepWoundsPower.toFixed(1));
        }

        if (ability.getPowerType() !== AbilityPowerType.GAIN_ATTACK_AND_ARMOR_EACH_STEP) {
            return (
                (ability.getPower() / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                this.getLuck() / 10 +
                synergyAbilityPowerIncrease / 10 +
                (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0) / 10
            );
        }

        return Number(
            (
                (ability.getPower() / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                ((this.getLuck() +
                    (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0) +
                    synergyAbilityPowerIncrease) /
                    100) *
                    ability.getPower()
            ).toFixed(1),
        );
    }

    public calculateAbilityMultiplier(ability: Ability, synergyAbilityPowerIncrease: number): number {
        let calculatedCoeff = 1;
        const madeOfFireBuff = this.getBuff("Made of Fire");
        if (
            ability.getPowerType() === AbilityPowerType.TOTAL_DAMAGE_PERCENTAGE ||
            ability.getPowerType() === AbilityPowerType.MAGIC_DAMAGE ||
            ability.getPowerType() === AbilityPowerType.KILL_RANDOM_AMOUNT ||
            ability.getPowerType() === AbilityPowerType.IGNORE_ARMOR ||
            ability.getPowerType() === AbilityPowerType.MAGIC_RESIST_50 ||
            ability.getPowerType() === AbilityPowerType.MAGIC_RESIST_25 ||
            ability.getPowerType() === AbilityPowerType.ABSORB_DEBUFF ||
            ability.getPowerType() === AbilityPowerType.BOOST_HEALTH
        ) {
            let combinedPower =
                ability.getPower() +
                this.getLuck() +
                (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0) +
                synergyAbilityPowerIncrease;
            if (combinedPower < 0) {
                combinedPower = 1;
            }

            calculatedCoeff *= (combinedPower / 100 / MAX_UNIT_STACK_POWER) * this.getStackPower();
        } else if (
            ability.getPowerType() === AbilityPowerType.ADDITIONAL_DAMAGE_PERCENTAGE ||
            ability.getPowerType() === AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE ||
            ability.getPowerType() === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE
        ) {
            calculatedCoeff +=
                (ability.getPower() / 100 / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                (this.getLuck() + synergyAbilityPowerIncrease) / 100 +
                (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0) / 100;
        }

        return calculatedCoeff;
    }

    public calculateMissChance(enemyUnit: Unit, enemySynergyAbilityPowerIncrease: number): number {
        const combinedMissChances = [];
        const selfBoarSalivaEffect = this.getEffect("Boar Saliva");

        if (selfBoarSalivaEffect) {
            combinedMissChances.push(selfBoarSalivaEffect.getPower() / 100);
        }

        const enemyDodgeAbility = enemyUnit.getAbility("Dodge");

        if (enemyDodgeAbility) {
            const dodgeChance =
                enemyUnit.calculateAbilityApplyChance(enemyDodgeAbility, enemySynergyAbilityPowerIncrease) / 100;
            combinedMissChances.push(dodgeChance);
        }

        if (!this.isSmallSize()) {
            const smallSpecieAbility = enemyUnit.getAbility("Small Specie");
            if (smallSpecieAbility) {
                const dodgeChance =
                    enemyUnit.calculateAbilityApplyChance(smallSpecieAbility, enemySynergyAbilityPowerIncrease) / 100;
                combinedMissChances.push(dodgeChance);
            }
        }

        if (combinedMissChances.length) {
            return Math.floor(winningAtLeastOneEventProbability(combinedMissChances) * 100);
        }

        return 0;
    }

    public calculateAbilityApplyChance(ability: Ability, synergyAbilityPowerIncrease: number): number {
        const madeOfFireBuff = this.getBuff("Made of Fire");
        const combinedPower =
            this.getLuck() +
            synergyAbilityPowerIncrease +
            ((ability.getPower() + (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0)) /
                MAX_UNIT_STACK_POWER) *
                this.getStackPower();
        if (combinedPower < 0) {
            return 0;
        }

        return combinedPower;
    }

    public calculateAttackDamageMin(
        attackRate: number,
        enemyUnit: Unit,
        isRangeAttack: boolean,
        synergyAbilityPowerIncrease: number,
        divisor = 1,
        abilityMultiplier = 1,
    ): number {
        if (divisor <= 0) {
            divisor = 1;
        }

        return Math.max(
            1,
            Math.ceil(
                ((((this.unitProperties.attack_damage_min * attackRate * this.unitProperties.amount_alive) /
                    this.getEnemyArmor(enemyUnit, isRangeAttack, synergyAbilityPowerIncrease)) *
                    (1 - enemyUnit.getLuck() / 100)) /
                    divisor) *
                    this.unitProperties.attack_multiplier *
                    abilityMultiplier,
            ),
        );
    }

    public calculateAttackDamageMax(
        attackRate: number,
        enemyUnit: Unit,
        isRangeAttack: boolean,
        synergyAbilityPowerIncrease: number,
        divisor = 1,
        abilityMultiplier = 1,
    ): number {
        if (divisor <= 0) {
            divisor = 1;
        }
        return Math.max(
            1,
            Math.ceil(
                ((((this.unitProperties.attack_damage_max * attackRate * this.unitProperties.amount_alive) /
                    this.getEnemyArmor(enemyUnit, isRangeAttack, synergyAbilityPowerIncrease)) *
                    (1 - enemyUnit.getLuck() / 100)) /
                    divisor) *
                    this.unitProperties.attack_multiplier *
                    abilityMultiplier,
            ),
        );
    }

    public calculateAttackDamage(
        enemyUnit: Unit,
        attackType: AttackType,
        synergyAbilityPowerIncrease: number,
        divisor = 1,
        abilityMultiplier = 1,
        decreaseNumberOfShots = true,
    ): number {
        const min = this.calculateAttackDamageMin(
            this.getAttack(),
            enemyUnit,
            attackType === AttackType.RANGE,
            synergyAbilityPowerIncrease,
            divisor,
        );
        const max = this.calculateAttackDamageMax(
            this.getAttack(),
            enemyUnit,
            attackType === AttackType.RANGE,
            synergyAbilityPowerIncrease,
            divisor,
        );
        const attackingByMelee = attackType === AttackType.MELEE || attackType === AttackType.MELEE_MAGIC;
        if (!attackingByMelee && attackType === AttackType.RANGE) {
            if (this.getRangeShots() <= 0) {
                return 0;
            }
            let gotUnlimitedSupplies = false;
            for (const abil of this.getAbilities()) {
                if (abil.getPowerType() === AbilityPowerType.UNLIMITED_SUPPLIES) {
                    gotUnlimitedSupplies = true;
                }
            }
            if (decreaseNumberOfShots && !gotUnlimitedSupplies) {
                this.decreaseNumberOfShots();
            }
        }

        const attackTypeMultiplier =
            attackingByMelee &&
            this.unitProperties.attack_type === AttackType.RANGE &&
            !this.hasAbilityActive("Handyman")
                ? 0.5
                : 1;

        return Math.floor(getRandomInt(min, max) * attackTypeMultiplier * abilityMultiplier);
    }

    public canSkipResponse(): boolean {
        if (!this.hasAbilityActive("Break")) {
            for (const a of this.abilities) {
                if (a.getSkipResponse()) {
                    return true;
                }
            }
        }

        return false;
    }

    public canRespond(attackType: AttackType): boolean {
        for (const e of this.effects) {
            if (e.getName() === "Stun" || e.getName() === "Blindness") {
                return false;
            }
        }

        if (!this.hasEffectActive("Break")) {
            for (const a of this.abilities) {
                if (
                    (a.getName() === "No Melee" &&
                        (attackType === AttackType.MELEE || attackType === AttackType.MELEE_MAGIC)) ||
                    (a.getName() === "Through Shot" && attackType === AttackType.RANGE)
                ) {
                    return false;
                }
            }
        }

        return true;
    }

    public setResponded(hasResponded: boolean) {
        this.responded = hasResponded;
    }

    public setOnHourglass(onHourglass: boolean) {
        this.onHourglass = onHourglass;
    }

    public isOnHourglass(): boolean {
        return this.onHourglass;
    }

    public refreshPossibleAttackTypes(canLandRangeAttack: boolean): boolean {
        const currentSelectedAttackType = this.selectedAttackType;
        this.possibleAttackTypes = [];
        if (this.getAttackType() === AttackType.MAGIC && this.getSpellsCount() > 0 && this.getCanCastSpells()) {
            this.possibleAttackTypes.push(AttackType.MAGIC);
        } else if (this.getAttackType() === AttackType.RANGE && this.getRangeShots() > 0 && canLandRangeAttack) {
            this.possibleAttackTypes.push(AttackType.RANGE);
        }

        if (!this.hasAbilityActive("No Melee")) {
            if (this.getAttackType() === AttackType.MELEE_MAGIC) {
                this.possibleAttackTypes.push(AttackType.MELEE_MAGIC);
            } else {
                this.possibleAttackTypes.push(AttackType.MELEE);
            }
        }

        if (
            this.getSpellsCount() > 0 &&
            this.getCanCastSpells() &&
            !this.possibleAttackTypes.includes(AttackType.MAGIC)
        ) {
            this.possibleAttackTypes.push(AttackType.MAGIC);
        }

        if (!this.possibleAttackTypes.length) {
            this.possibleAttackTypes.push(AttackType.NO_TYPE);
        }

        if (!this.possibleAttackTypes.length) {
            return false;
        }

        this.unitProperties.attack_type_selected = this.possibleAttackTypes[0];
        this.selectedAttackType = this.possibleAttackTypes[0];
        return currentSelectedAttackType !== this.selectedAttackType;
    }

    public getAttackTypeSelection(): AttackType {
        return this.selectedAttackType;
    }

    public getPossibleAttackTypes(): AttackType[] {
        return this.possibleAttackTypes;
    }

    public getAttackTypeSelectionIndex(): [number, number] {
        return [this.possibleAttackTypes.indexOf(this.selectedAttackType), this.possibleAttackTypes.length];
    }

    public selectNextAttackType(): boolean {
        let index = this.possibleAttackTypes.indexOf(this.selectedAttackType);
        let initialIndex = index;
        do {
            index = (index + 1) % this.possibleAttackTypes.length;
            if (this.selectAttackType(this.possibleAttackTypes[index])) {
                return true;
            }
        } while (index !== initialIndex);
        return false;
    }

    public selectAttackType(selectedAttackType: AttackType): boolean {
        if (
            this.selectedAttackType !== selectedAttackType &&
            ((selectedAttackType === AttackType.MELEE && this.possibleAttackTypes.includes(AttackType.MELEE)) ||
                (selectedAttackType === AttackType.MELEE_MAGIC &&
                    this.possibleAttackTypes.includes(AttackType.MELEE_MAGIC)))
        ) {
            if (this.possibleAttackTypes.includes(AttackType.MELEE_MAGIC)) {
                this.selectedAttackType = AttackType.MELEE_MAGIC;
                this.unitProperties.attack_type_selected = AttackType.MELEE_MAGIC;
            } else {
                this.selectedAttackType = AttackType.MELEE;
                this.unitProperties.attack_type_selected = AttackType.MELEE;
            }

            return true;
        }

        if (
            selectedAttackType === AttackType.RANGE &&
            this.unitProperties.attack_type === AttackType.RANGE &&
            this.getRangeShots() &&
            this.selectedAttackType !== selectedAttackType &&
            this.possibleAttackTypes.includes(AttackType.RANGE)
        ) {
            this.selectedAttackType = selectedAttackType;
            this.unitProperties.attack_type_selected = AttackType.RANGE;
            return true;
        }

        if (
            selectedAttackType === AttackType.MAGIC &&
            this.unitProperties.spells.length &&
            this.unitProperties.can_cast_spells &&
            this.selectedAttackType !== selectedAttackType &&
            this.possibleAttackTypes.includes(AttackType.MAGIC)
        ) {
            this.selectedAttackType = selectedAttackType;
            this.unitProperties.attack_type_selected = AttackType.MAGIC;
            return true;
        }

        return false;
    }

    public cleanAuraEffects(): void {
        if (
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_laps.length &&
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_descriptions.length &&
            this.unitProperties.applied_buffs.length === this.unitProperties.applied_buffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_buffs.length - 1; i >= 0; i--) {
                if (this.unitProperties.applied_buffs_laps[i] === Number.MAX_SAFE_INTEGER) {
                    this.deleteBuff(this.unitProperties.applied_buffs[i]);
                }
            }
        }

        if (
            this.unitProperties.applied_debuffs.length === this.unitProperties.applied_debuffs_laps.length &&
            this.unitProperties.applied_debuffs.length === this.unitProperties.applied_debuffs_descriptions.length &&
            this.unitProperties.applied_debuffs.length === this.unitProperties.applied_debuffs_powers.length
        ) {
            for (let i = this.unitProperties.applied_debuffs.length - 1; i >= 0; i--) {
                if (this.unitProperties.applied_debuffs_laps[i] === Number.MAX_SAFE_INTEGER) {
                    this.deleteDebuff(this.unitProperties.applied_debuffs[i]);
                }
            }
        }
    }

    public applyAuraEffect(
        auraEffectName: string,
        auraEffectDescription: string,
        isBuff: boolean,
        power: number,
        sourceCellString: string,
    ): void {
        let firstSpellProperty: number | undefined = undefined;
        let secondSpellProperty: number | undefined = undefined;
        const sourceCellStringSplit = sourceCellString.split(";");
        if (sourceCellStringSplit.length === 2) {
            firstSpellProperty = parseInt(sourceCellStringSplit[0]);
            secondSpellProperty = parseInt(sourceCellStringSplit[1]);
        }

        const lapsTotal = Number.MAX_SAFE_INTEGER;
        const applied = new AppliedSpell(auraEffectName, power, lapsTotal, firstSpellProperty, secondSpellProperty);
        if (isBuff) {
            this.deleteBuff(auraEffectName);
            this.buffs.push(applied);
            this.unitProperties.applied_buffs.push(auraEffectName);
            this.unitProperties.applied_buffs_laps.push(lapsTotal);
            this.unitProperties.applied_buffs_descriptions.push(`${auraEffectDescription};${sourceCellString}`);
            this.unitProperties.applied_buffs_powers.push(power);
        } else {
            this.deleteDebuff(auraEffectName);
            this.debuffs.push(applied);
            this.unitProperties.applied_debuffs.push(auraEffectName);
            this.unitProperties.applied_debuffs_laps.push(lapsTotal);
            this.unitProperties.applied_debuffs_descriptions.push(`${auraEffectDescription};${sourceCellString}`);
            this.unitProperties.applied_debuffs_powers.push(power);
        }
    }

    public applyBuff(
        buff: Spell,
        firstBuffProperty?: number,
        secondBuffProperty?: number,
        extend: boolean = false,
    ): void {
        // not checking for duplicates here, do it on a caller side
        const lapsTotal = buff.getLapsTotal() + (extend ? 1 : 0);
        const firstBuffPropertyString = firstBuffProperty === undefined ? "" : firstBuffProperty.toString();
        const secondBuffPropertyString = secondBuffProperty === undefined ? "" : secondBuffProperty.toString();

        this.buffs.push(
            new AppliedSpell(buff.getName(), buff.getPower(), lapsTotal, firstBuffProperty, secondBuffProperty),
        );
        this.unitProperties.applied_buffs.push(buff.getName());
        this.unitProperties.applied_buffs_laps.push(lapsTotal);
        this.unitProperties.applied_buffs_descriptions.push(
            `${buff
                .getDesc()
                .slice(0, buff.getDesc().length - 1)
                .join(" ")};${firstBuffPropertyString};${secondBuffPropertyString}`,
        );
        this.unitProperties.applied_buffs_powers.push(0);
    }

    public getBuffProperties(buffName: string): [string, string] {
        const buffProperties: [string, string] = ["", ""];
        for (let i = 0; i < this.unitProperties.applied_buffs_descriptions.length; i++) {
            const description = this.unitProperties.applied_buffs_descriptions[i];
            const splitDescription = description.split(";");
            if (splitDescription.length === 3 && buffName === this.unitProperties.applied_buffs[i]) {
                buffProperties[0] = splitDescription[1];
                buffProperties[1] = splitDescription[2];
                break;
            }
        }

        return buffProperties;
    }

    public applyDebuff(
        debuff: Spell,
        firstDebuffProperty?: number,
        secondDebuffProperty?: number,
        extend: boolean = false,
    ): void {
        // not checking for duplicates here, do it on a caller side
        const lapsTotal = debuff.getLapsTotal() + (extend ? 1 : 0);
        const firstDebuffPropertyString = firstDebuffProperty === undefined ? "" : firstDebuffProperty.toString();
        const secondDebuffPropertyString = secondDebuffProperty === undefined ? "" : secondDebuffProperty.toString();

        this.debuffs.push(
            new AppliedSpell(debuff.getName(), debuff.getPower(), lapsTotal, firstDebuffProperty, secondDebuffProperty),
        );
        this.unitProperties.applied_debuffs.push(debuff.getName());
        this.unitProperties.applied_debuffs_laps.push(lapsTotal);
        this.unitProperties.applied_debuffs_descriptions.push(
            `${debuff
                .getDesc()
                .slice(0, debuff.getDesc().length - 1)
                .join(" ")};${firstDebuffPropertyString};${secondDebuffPropertyString}`,
        );
        this.unitProperties.applied_debuffs_powers.push(0);
    }

    public useSpell(spellName: string): void {
        for (const s of this.spells) {
            if (s.getName() === spellName) {
                s.decreaseAmount();
                const fullSpellName = `${s.getFaction()}:${s.getName()}`;
                for (let i = this.unitProperties.spells.length - 1; i >= 0; i--) {
                    if (this.unitProperties.spells[i] === fullSpellName) {
                        this.unitProperties.spells.splice(i, 1);
                        break;
                    }
                }
            }
            if (!s.isRemaining() && spellName === "Resurrection") {
                this.deleteAbility("Resurrection");
            }
        }
    }

    public getAllProperties(): UnitProperties {
        return structuredClone(this.unitProperties);
    }

    // returns number of units resurrected
    public applyResurrection(resurrectionPower: number): number {
        const hpDiff = this.unitProperties.max_hp - this.unitProperties.hp;
        if (hpDiff >= resurrectionPower) {
            this.unitProperties.hp += resurrectionPower;
            return 0;
        } else {
            this.unitProperties.hp = this.unitProperties.max_hp;
            resurrectionPower -= hpDiff;
        }

        const projectedAmountResurrected = Math.ceil(resurrectionPower / this.unitProperties.max_hp);
        const actualAmountResurrected = Math.min(this.unitProperties.amount_died, projectedAmountResurrected);

        if (projectedAmountResurrected > actualAmountResurrected) {
            this.unitProperties.hp = this.unitProperties.max_hp;
        } else {
            const hpStillToHeal = resurrectionPower % this.unitProperties.max_hp;
            this.unitProperties.hp = hpStillToHeal;
        }

        const newAmountDied = this.unitProperties.amount_died - actualAmountResurrected;
        this.unitProperties.amount_alive += actualAmountResurrected;
        this.unitProperties.amount_died = newAmountDied < 0 ? 0 : newAmountDied;

        return actualAmountResurrected;
    }

    public applyHeal(healPower: number): number {
        if (healPower < 0) {
            return 0;
        }

        let healedFor = Math.floor(healPower);
        const wasHp = this.unitProperties.hp;
        this.unitProperties.hp += healedFor;
        if (this.unitProperties.hp > this.unitProperties.max_hp) {
            healedFor = this.unitProperties.max_hp - wasHp;
            this.unitProperties.hp = this.unitProperties.max_hp;
        }

        return healedFor;
    }

    public handleResurrectionAnimation(): void {}

    public reduceBaseAttack(reduceBy: number): number {
        if (reduceBy <= 0) {
            return 0;
        }

        const oldBaseAttack = this.initialUnitProperties.base_attack;
        this.initialUnitProperties.base_attack = Math.max(1, this.initialUnitProperties.base_attack - reduceBy);

        return Number((oldBaseAttack - this.initialUnitProperties.base_attack).toFixed(1));
    }

    public adjustBaseStats(
        hasFightStarted: boolean,
        currentLap: number,
        synergyAbilityPowerIncrease: number,
        synergyMovementStepsIncrease: number,
        synergyFlyArmorIncrease: number,
        synergyMoraleIncrease: number,
        synergyLuckIncrease: number,
        stepsMoraleMultiplier = 0,
    ) {
        // target
        if (!this.hasEffectActive("Aggr")) {
            this.resetTarget();
        }

        // HP
        const madeOfFireBuff = this.getBuff("Made of Fire");
        const baseStatsDiff = calculateBuffsDebuffsEffect(this.getBuffs(), this.getDebuffs());
        const hasUnyieldingPower = this.hasAbilityActive("Unyielding Power");

        this.unitProperties.max_hp =
            this.refreshAndGetAdjustedMaxHp(currentLap, synergyAbilityPowerIncrease, madeOfFireBuff) +
            baseStatsDiff.baseStats.hp;

        if (hasFightStarted && hasUnyieldingPower && !this.adjustedBaseStatsLaps.includes(currentLap)) {
            this.unitProperties.hp += 5;
        }

        if (this.unitProperties.max_hp < this.unitProperties.hp) {
            this.unitProperties.hp = this.unitProperties.max_hp;
        }

        // LUCK
        if (baseStatsDiff.baseStats.luck === Number.MAX_SAFE_INTEGER) {
            this.unitProperties.luck = LUCK_MAX_VALUE_TOTAL;
            this.unitProperties.luck_mod = 0;
        } else {
            this.unitProperties.luck = synergyLuckIncrease;
            if (this.unitProperties.luck !== this.initialUnitProperties.luck) {
                this.unitProperties.luck = this.initialUnitProperties.luck;
            }
            if (hasFightStarted && !this.adjustedBaseStatsLaps.includes(currentLap)) {
                this.randomizeLuckPerTurn();
            }

            this.unitProperties.luck_mod = this.luckPerTurn + synergyLuckIncrease;
            if (this.unitProperties.luck_mod + this.unitProperties.luck > LUCK_MAX_VALUE_TOTAL) {
                this.unitProperties.luck_mod = LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
            } else if (this.unitProperties.luck_mod + this.unitProperties.luck < -LUCK_MAX_VALUE_TOTAL) {
                this.unitProperties.luck_mod = -LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
            }
        }

        // MORALE
        this.unitProperties.attack_multiplier = 1;
        if (synergyMoraleIncrease > 0) {
            // this.initialUnitProperties.morale = synergyMoraleIncrease;
            this.unitProperties.morale = this.initialUnitProperties.morale + synergyMoraleIncrease;
        } else {
            this.unitProperties.morale = this.initialUnitProperties.morale;
        }
        if (this.hasAbilityActive("Madness") || this.hasAbilityActive("Mechanism")) {
            this.unitProperties.morale = 0;
        } else {
            let lockedMorale = false;
            if (this.hasDebuffActive("Sadness")) {
                if (this.hasBuffActive("Courage")) {
                    this.unitProperties.morale = 0;
                    lockedMorale = true;
                } else {
                    this.unitProperties.morale = -MORALE_MAX_VALUE_TOTAL;
                }
            }
            if (this.hasBuffActive("Courage")) {
                if (this.hasDebuffActive("Sadness")) {
                    this.unitProperties.morale = 0;
                    lockedMorale = true;
                } else {
                    this.unitProperties.morale = MORALE_MAX_VALUE_TOTAL;
                }
            }
            if (this.hasBuffActive("Morale")) {
                this.unitProperties.attack_multiplier = 1.25;
                if (!lockedMorale) {
                    this.unitProperties.morale = MORALE_MAX_VALUE_TOTAL;
                }
            } else if (this.hasDebuffActive("Dismorale")) {
                this.unitProperties.attack_multiplier = 0.8;
                if (!lockedMorale) {
                    this.unitProperties.morale = -MORALE_MAX_VALUE_TOTAL;
                }
            }
        }
        if (this.unitProperties.morale > MORALE_MAX_VALUE_TOTAL) {
            this.unitProperties.morale = MORALE_MAX_VALUE_TOTAL;
        }
        if (this.unitProperties.morale < -MORALE_MAX_VALUE_TOTAL) {
            this.unitProperties.morale = -MORALE_MAX_VALUE_TOTAL;
        }

        // ARMOR
        const pegasusMightAura = this.getAppliedAuraEffect("Pegasus Might Aura");
        this.unitProperties.base_armor = Number(
            (
                (madeOfFireBuff
                    ? this.initialUnitProperties.base_armor + this.initialUnitProperties.base_armor / 10
                    : this.initialUnitProperties.base_armor) + baseStatsDiff.baseStats.armor
            ).toFixed(2),
        );
        if (pegasusMightAura) {
            this.unitProperties.base_armor += pegasusMightAura.getPower();
        }
        const windFlowBuff = this.getBuff("Wind Flow");
        if (windFlowBuff) {
            this.unitProperties.base_armor += windFlowBuff.getPower();
        }
        const armorAugmentBuff = this.getBuff("Armor Augment");
        if (armorAugmentBuff) {
            this.unitProperties.base_armor += Number(
                ((this.unitProperties.base_armor / 100) * armorAugmentBuff.getPower()).toFixed(2),
            );
        }

        // BUFFS & DEBUFFS
        const weakeningBeamDebuff = this.getDebuff("Weakening Beam");
        let baseArmorMultiplier = 1;
        if (weakeningBeamDebuff) {
            baseArmorMultiplier = (100 - weakeningBeamDebuff.getPower()) / 100;
        }

        const heavyArmorAbility = this.getAbility("Heavy Armor");
        if (heavyArmorAbility) {
            baseArmorMultiplier =
                baseArmorMultiplier *
                (1 +
                    ((heavyArmorAbility.getPower() +
                        this.getLuck() +
                        synergyAbilityPowerIncrease +
                        (madeOfFireBuff ? (heavyArmorAbility.getPower() / 100) * madeOfFireBuff.getPower() : 0)) /
                        100 /
                        MAX_UNIT_STACK_POWER) *
                        this.getStackPower());
        }

        this.unitProperties.base_armor = Number((this.unitProperties.base_armor * baseArmorMultiplier).toFixed(2));

        // mod
        const shatterArmorEffect = this.getEffect("Shatter Armor");
        let shatterArmorEffectPower = 0;
        if (shatterArmorEffect) {
            shatterArmorEffectPower = shatterArmorEffect.getPower();
        }
        this.unitProperties.armor_mod =
            shatterArmorEffectPower > 0 ? -shatterArmorEffectPower : this.initialUnitProperties.armor_mod;
        let armorModMultiplier = 0;
        if (this.getMovementType() === MovementType.FLY && synergyFlyArmorIncrease > 0) {
            armorModMultiplier = synergyFlyArmorIncrease / 100;
        }
        if (this.hasBuffActive("Spiritual Armor")) {
            const spell = new Spell({
                spellProperties: getSpellConfig(FactionType.LIFE, "Spiritual Armor"),
                amount: 1,
            });
            armorModMultiplier = (spell.getPower() / 100) * (1 + armorModMultiplier);
        }

        if (armorModMultiplier) {
            this.unitProperties.armor_mod = Number(
                (
                    Math.max(this.unitProperties.base_armor - shatterArmorEffectPower, 1) * armorModMultiplier -
                    shatterArmorEffectPower
                ).toFixed(2),
            );
        }

        // this.unitProperties.armor_mod = Number((this.unitProperties.base_armor * baseArmorMultiplier).toFixed(2));

        const leatherArmorAbility = this.getAbility("Leather Armor");
        let rangeArmorMultiplier = leatherArmorAbility ? leatherArmorAbility.getPower() / 100 : 1;

        const arrowsWingshieldAura = this.getAppliedAuraEffect("Arrows Wingshield Aura");
        if (arrowsWingshieldAura) {
            rangeArmorMultiplier = rangeArmorMultiplier * (1 + arrowsWingshieldAura.getPower() / 100);
        }

        // MDEF
        this.unitProperties.magic_resist = madeOfFireBuff
            ? this.initialUnitProperties.magic_resist +
              this.initialUnitProperties.magic_resist / madeOfFireBuff.getPower()
            : this.initialUnitProperties.magic_resist;
        const enchantedSkinAbility = this.getAbility("Enchanted Skin");
        if (enchantedSkinAbility) {
            this.unitProperties.magic_resist_mod = enchantedSkinAbility.getPower();
        } else {
            const magicResists: number[] = [this.getMagicResist() / 100];
            const magicShieldAbility = this.getAbility("Magic Shield");
            if (magicShieldAbility) {
                magicResists.push(this.calculateAbilityMultiplier(magicShieldAbility, synergyAbilityPowerIncrease));
            }

            const wardguardAbility = this.getAbility("Wardguard");
            if (wardguardAbility) {
                magicResists.push(this.calculateAbilityMultiplier(wardguardAbility, synergyAbilityPowerIncrease));
            }

            this.unitProperties.magic_resist = Number(
                (winningAtLeastOneEventProbability(magicResists) * 100).toFixed(2),
            );
        }

        // SHOTS
        if (this.hasAbilityActive("Limited Supply")) {
            const actualStackPowerCoeff = this.getStackPower() / MAX_UNIT_STACK_POWER;
            this.unitProperties.range_shots = Math.min(
                this.unitProperties.range_shots,
                Math.floor(this.maxRangeShots * actualStackPowerCoeff),
            );
        }

        const endlessQuiverAbility = this.getAbility("Endless Quiver");
        if (endlessQuiverAbility) {
            this.unitProperties.range_shots_mod = endlessQuiverAbility.getPower();
        }

        // SPEED
        this.unitProperties.speed = madeOfFireBuff
            ? this.initialUnitProperties.speed + this.initialUnitProperties.speed / madeOfFireBuff.getPower()
            : this.initialUnitProperties.speed;

        // STEPS
        this.unitProperties.steps_mod =
            Number((stepsMoraleMultiplier * this.getMorale()).toFixed(1)) + synergyMovementStepsIncrease;
        const skyRunnerAbility = this.getAbility("Sky Runner");
        if (hasFightStarted && hasUnyieldingPower && !this.adjustedBaseStatsLaps.includes(currentLap)) {
            this.initialUnitProperties.steps += 1;
        }

        this.unitProperties.steps = madeOfFireBuff
            ? this.initialUnitProperties.steps + this.initialUnitProperties.steps / madeOfFireBuff.getPower()
            : this.initialUnitProperties.steps;
        if (skyRunnerAbility) {
            this.unitProperties.steps += this.calculateAbilityCount(skyRunnerAbility, synergyAbilityPowerIncrease);
        }
        const wolfTrailAuraEffect = this.getAppliedAuraEffect("Wolf Trail Aura");
        if (wolfTrailAuraEffect) {
            this.unitProperties.steps_mod += wolfTrailAuraEffect.getPower();
        }
        if (!this.canFly()) {
            const tieUpTheHorsesAuraEffect = this.getAppliedAuraEffect("Tie up the Horses Aura");
            if (tieUpTheHorsesAuraEffect) {
                this.unitProperties.steps_mod += tieUpTheHorsesAuraEffect.getPower();
            }
        }
        const movementAugmentBuff = this.getBuff("Movement Augment");
        if (movementAugmentBuff) {
            this.unitProperties.steps += movementAugmentBuff.getPower();
        }
        const battleRoarBuff = this.getBuff("Battle Roar");
        if (battleRoarBuff) {
            this.unitProperties.steps_mod += battleRoarBuff.getPower();
        }
        if (windFlowBuff) {
            const newSteps = this.unitProperties.steps - windFlowBuff.getPower();
            this.unitProperties.steps = Math.max(1, newSteps);
        }

        const quagmireDebuff = this.getDebuff("Quagmire");
        let stepsMultiplier = 1;
        if (quagmireDebuff) {
            stepsMultiplier = (100 - quagmireDebuff.getPower()) / 100;
        }
        this.unitProperties.steps = Number((this.unitProperties.steps * stepsMultiplier).toFixed(1));
        this.unitProperties.steps_mod = Number((this.unitProperties.steps_mod * stepsMultiplier).toFixed(1));

        // ATTACK
        if (hasFightStarted && !this.adjustedBaseStatsLaps.includes(currentLap)) {
            if (hasUnyieldingPower) {
                this.initialUnitProperties.base_attack += 2;
            }
        }
        this.unitProperties.base_attack = madeOfFireBuff
            ? this.initialUnitProperties.base_attack +
              this.initialUnitProperties.base_attack / madeOfFireBuff.getPower()
            : this.initialUnitProperties.base_attack;
        this.unitProperties.shot_distance = madeOfFireBuff
            ? this.initialUnitProperties.shot_distance +
              this.initialUnitProperties.shot_distance / madeOfFireBuff.getPower()
            : this.initialUnitProperties.shot_distance;
        if (pegasusMightAura) {
            this.unitProperties.base_attack += pegasusMightAura.getPower();
        }

        const mightAugmentBuff = this.getBuff("Might Augment");

        if (this.getAttackTypeSelection() !== AttackType.RANGE && mightAugmentBuff) {
            this.unitProperties.base_attack += Number(
                ((this.unitProperties.base_attack / 100) * mightAugmentBuff.getPower()).toFixed(2),
            );
        }

        const sniperAugmentBuff = this.getBuff("Sniper Augment");
        if (this.getAttackTypeSelection() === AttackType.RANGE && sniperAugmentBuff) {
            const buffProperties = this.getBuffProperties(sniperAugmentBuff.getName());
            if (buffProperties?.length === 2) {
                this.unitProperties.base_attack += Number(
                    ((this.unitProperties.base_attack / 100) * parseInt(buffProperties[0])).toFixed(2),
                );
                // SHOT DISTANCE
                this.unitProperties.shot_distance += Number(
                    ((this.unitProperties.shot_distance / 100) * parseInt(buffProperties[1])).toFixed(2),
                );
            }
        }

        let baseAttackMultiplier = 1;
        const sharpenedWeaponsAura = this.getAppliedAuraEffect("Sharpened Weapons Aura");

        if (sharpenedWeaponsAura) {
            baseAttackMultiplier = baseAttackMultiplier * (1 + sharpenedWeaponsAura.getPower() / 100);
        }

        const blessingBuff = this.getBuff("Blessing");
        if (blessingBuff || battleRoarBuff) {
            this.unitProperties.attack_damage_min = this.unitProperties.attack_damage_max;
        } else {
            this.unitProperties.attack_damage_min = this.initialUnitProperties.attack_damage_min;
        }

        if (this.hasBuffActive("Riot")) {
            const spell = new Spell({
                spellProperties: getSpellConfig(FactionType.CHAOS, "Riot"),
                amount: 1,
            });
            this.unitProperties.attack_mod = (this.unitProperties.base_attack * spell.getPower()) / 100;
        } else if (this.hasBuffActive("Mass Riot")) {
            const spell = new Spell({
                spellProperties: getSpellConfig(FactionType.CHAOS, "Mass Riot"),
                amount: 1,
            });
            this.unitProperties.attack_mod = (this.unitProperties.base_attack * spell.getPower()) / 100;
        } else {
            this.unitProperties.attack_mod = this.initialUnitProperties.attack_mod;
        }

        const weaknessDebuff = this.getDebuff("Weakness");
        if (weaknessDebuff) {
            this.unitProperties.attack_mod -= (this.unitProperties.base_attack * weaknessDebuff.getPower()) / 100;
        }

        if (this.hasAbilityActive("Blind Fury")) {
            this.unitProperties.attack_mod +=
                (1 -
                    this.unitProperties.amount_alive /
                        (this.unitProperties.amount_alive + this.unitProperties.amount_died)) *
                this.initialUnitProperties.base_attack;
        }

        this.unitProperties.attack_mod = Number(this.unitProperties.attack_mod.toFixed(2));
        this.unitProperties.base_attack = Number((this.unitProperties.base_attack * baseAttackMultiplier).toFixed(2));
        this.unitProperties.shot_distance = Number(this.unitProperties.shot_distance.toFixed(2));

        this.unitProperties.range_armor = Number((this.unitProperties.base_armor * rangeArmorMultiplier).toFixed(2));

        if (hasFightStarted && !this.adjustedBaseStatsLaps.includes(currentLap)) {
            this.adjustedBaseStatsLaps.push(currentLap);
        }

        this.refreshAbilitiesDescriptions(synergyAbilityPowerIncrease);
    }

    public setRangeShotDistance(distance: number) {
        this.unitProperties.shot_distance = distance;
    }

    public setStackPower(stackPower: number): void {
        this.unitProperties.stack_power = stackPower;
    }

    public attackMeleeAllowed(
        enemyTeam: Unit[],
        positions: ReadonlyMap<string, XY>,
        adjacentEnemies: Unit[],
        fromPathCells?: XY[],
        currentActiveKnownPaths?: Map<number, IWeightedRoute[]>,
        extendByCells?: XY[],
    ): IAttackTargets {
        const canAttackUnitIds: Set<string> = new Set();
        const possibleAttackCells: XY[] = [];
        const possibleAttackCellHashes: Set<number> = new Set();
        const possibleAttackCellHashesToLargeCells: Map<number, XY[]> = new Map();
        const possibleFromPathCells: Denque<XY> = fromPathCells ? new Denque(fromPathCells) : new Denque();

        let fromPathHashes: Set<number> | undefined;
        let currentCells: XY[];
        if (this.isSmallSize()) {
            const currentCell = this.getBaseCell();
            if (currentCell) {
                possibleFromPathCells.unshift(currentCell);
                currentCells = [currentCell];
            } else {
                currentCells = [];
            }
        } else {
            currentCells = this.getCells();
            for (const c of currentCells) {
                possibleFromPathCells.unshift(c);
            }
            fromPathHashes = new Set();
            for (let i = 0; i < possibleFromPathCells.length; i++) {
                const fp = possibleFromPathCells.get(i);
                if (!fp) {
                    continue;
                }
                fromPathHashes.add((fp.x << 4) | fp.y);
            }
        }

        let maxX = Number.MIN_SAFE_INTEGER;
        let maxY = Number.MIN_SAFE_INTEGER;

        for (const c of currentCells) {
            maxX = Math.max(maxX, c.x);
            maxY = Math.max(maxY, c.y);
        }

        if (this.canMove()) {
            for (const u of enemyTeam) {
                const position = positions.get(u.getId());
                if (!position || !isPositionWithinGrid(this.gridSettings, position)) {
                    continue;
                }

                let bodyCells: XY[];
                if (u.isSmallSize()) {
                    const bodyCellPos = getCellForPosition(this.gridSettings, position);
                    if (!bodyCellPos) {
                        continue;
                    }
                    bodyCells = extendByCells ? [bodyCellPos, ...extendByCells] : [bodyCellPos];
                } else {
                    bodyCells = extendByCells ? [...u.getCells(), ...extendByCells] : u.getCells();
                }

                for (const bodyCell of bodyCells) {
                    for (let i = 0; i < possibleFromPathCells.length; i++) {
                        const pathCell = possibleFromPathCells.get(i);
                        if (!pathCell) {
                            continue;
                        }

                        if (
                            Math.abs(bodyCell.x - pathCell.x) <= this.getAttackRange() &&
                            Math.abs(bodyCell.y - pathCell.y) <= this.getAttackRange()
                        ) {
                            const posHash = (pathCell.x << 4) | pathCell.y;
                            let addCell = false;
                            if (this.isSmallSize()) {
                                addCell = true;
                            } else {
                                const largeUnitAttackCells = getLargeUnitAttackCells(
                                    this.gridSettings,
                                    pathCell,
                                    { x: maxX, y: maxY },
                                    bodyCell,
                                    currentActiveKnownPaths,
                                    fromPathHashes,
                                );

                                if (largeUnitAttackCells?.length) {
                                    addCell = true;
                                    possibleAttackCellHashesToLargeCells.set(posHash, largeUnitAttackCells);
                                }
                            }

                            if (addCell) {
                                if (!canAttackUnitIds.has(u.getId())) {
                                    canAttackUnitIds.add(u.getId());
                                }

                                if (!possibleAttackCellHashes.has(posHash)) {
                                    possibleAttackCells.push(pathCell);
                                    possibleAttackCellHashes.add(posHash);
                                }
                            }
                        }
                    }
                }
            }
        } else {
            const baseCell = this.getBaseCell();

            let checkCells: XY[];
            if (this.isSmallSize()) {
                // use either target move position on current
                // depending on the action type (attack vs response)
                checkCells = getCellsAroundCell(this.gridSettings, baseCell);
            } else {
                checkCells = [];
                for (let i = -2; i <= 1; i++) {
                    for (let j = -2; j <= 1; j++) {
                        checkCells.push({ x: baseCell.x + i, y: baseCell.y + j });
                    }
                }
            }
            const surroundingCellHashes: number[] = [];
            for (const c of checkCells) {
                surroundingCellHashes.push((c.x << 4) | c.y);
            }

            const skipCells: number[] = [];
            for (const ae of adjacentEnemies) {
                for (const c of ae.getCells()) {
                    skipCells.push((c.x << 4) | c.y);
                }
            }

            const enemiesCells: Map<string, XY[]> = new Map();
            for (const ae of adjacentEnemies) {
                const enemyRelatedCells: XY[] = [];
                for (const c of ae.getCells()) {
                    const cellsAround = getCellsAroundCell(this.gridSettings, c);
                    for (const ca of cellsAround) {
                        const cellAroundHash = (ca.x << 4) | ca.y;
                        if (skipCells.includes(cellAroundHash)) {
                            continue;
                        }
                        enemyRelatedCells.push(ca);
                    }
                }
                enemiesCells.set(ae.getId(), enemyRelatedCells);
            }

            for (const ae of adjacentEnemies) {
                const enemyRelatedCells = enemiesCells.get(ae.getId());
                if (!enemyRelatedCells?.length) {
                    continue;
                }
                const position = positions.get(ae.getId());
                if (!position || !isPositionWithinGrid(this.gridSettings, position)) {
                    continue;
                }

                let bodyCells: XY[];
                if (ae.isSmallSize()) {
                    const bodyCellPos = getCellForPosition(this.gridSettings, position);
                    if (!bodyCellPos) {
                        continue;
                    }
                    bodyCells = extendByCells ? [bodyCellPos, ...extendByCells] : [bodyCellPos];
                } else {
                    bodyCells = extendByCells ? [...ae.getCells(), ...extendByCells] : ae.getCells();
                }

                for (const bodyCell of bodyCells) {
                    for (const c of enemyRelatedCells) {
                        const posHash = (c.x << 4) | c.y;
                        let addPos = false;
                        if (this.isSmallSize()) {
                            addPos = true;
                        } else if (surroundingCellHashes.includes((c.x << 4) | c.y)) {
                            const largeUnitAttackCells = getLargeUnitAttackCells(
                                this.gridSettings,
                                c,
                                { x: maxX, y: maxY },
                                bodyCell,
                                currentActiveKnownPaths,
                                fromPathHashes,
                            );

                            if (largeUnitAttackCells?.length) {
                                addPos = true;
                                possibleAttackCellHashesToLargeCells.set(posHash, largeUnitAttackCells);
                            }
                        }

                        if (addPos) {
                            if (!canAttackUnitIds.has(ae.getId())) {
                                canAttackUnitIds.add(ae.getId());
                            }

                            if (!possibleAttackCellHashes.has(posHash)) {
                                possibleAttackCells.push(c);
                                possibleAttackCellHashes.add(posHash);
                            }
                        }
                    }
                }
            }
        }

        return {
            unitIds: canAttackUnitIds,
            attackCells: possibleAttackCells,
            attackCellHashes: possibleAttackCellHashes,
            attackCellHashesToLargeCells: possibleAttackCellHashesToLargeCells,
        };
    }

    protected parseAbilities(): boolean {
        let spellAdded = false;
        for (const abilityName of this.unitProperties.abilities) {
            if (!this.hasAbilityActive(abilityName)) {
                const ability = this.abilityFactory.makeAbility(abilityName);
                this.abilities.push(ability);
                const spell = ability.getSpell();
                if (spell && !this.unitProperties.spells.includes(`:${spell.getName()}`)) {
                    this.unitProperties.spells.push(`:${spell.getName()}`);
                    this.unitProperties.can_cast_spells = true;
                    spellAdded = true;
                }
            }
        }

        return spellAdded;
    }

    protected refreshAbilitiesDescriptions(_synergyAbilityPowerIncrease: number): void {}

    protected parseSpellData(spellData: string[]): Map<string, number> {
        const spells: Map<string, number> = new Map();

        for (const sp of spellData) {
            if (!spells.has(sp)) {
                spells.set(sp, 1);
            } else {
                const amount = spells.get(sp);
                spells.set(sp, (amount || 0) + 1);
            }
        }

        return spells;
    }

    protected parseSpells(): void {
        const spells: Map<string, number> = this.parseSpellData(this.unitProperties.spells);
        const newSpells: Spell[] = [];

        for (const [k, v] of spells.entries()) {
            const spArr = k.split(":");
            if (spArr.length !== 2) {
                continue;
            }
            // can return us undefined
            const faction = ToFactionType[spArr[0] as AllFactionsType] ?? FactionType.NO_TYPE;
            if (faction === undefined) {
                continue;
            }

            const spellProperties = getSpellConfig(faction, spArr[1]);
            newSpells.push(new Spell({ spellProperties: spellProperties, amount: v }));
        }
        this.spells = newSpells;
    }

    protected parseAuraEffects(): void {
        for (const auraEffectName of this.unitProperties.aura_effects) {
            const auraEffect = this.effectFactory.makeAuraEffect(auraEffectName);
            if (auraEffect) {
                this.auraEffects.push(auraEffect);
            }
        }
    }

    protected handleDamageAnimation(_unitsDied: number): void {}

    protected getEnemyArmor(enemyUnit: Unit, isRangeAttack: boolean, synergyAbilityPowerIncrease: number): number {
        const piercingSpearAbility = this.getAbility("Piercing Spear");
        const armor = isRangeAttack ? enemyUnit.getRangeArmor() : enemyUnit.getArmor();
        if (piercingSpearAbility) {
            return armor * (1 - this.calculateAbilityMultiplier(piercingSpearAbility, synergyAbilityPowerIncrease));
        }

        return armor;
    }

    protected refreshAndGetAdjustedMaxHp(
        currentLap: number,
        synergyAbilityPowerIncrease: number,
        madeOfFireBuff?: AppliedSpell,
    ): number {
        const hasUnyieldingPower = this.hasAbilityActive("Unyielding Power");
        if (hasUnyieldingPower) {
            this.unitProperties.max_hp =
                (madeOfFireBuff
                    ? Math.ceil(
                          this.initialUnitProperties.max_hp +
                              this.initialUnitProperties.max_hp / madeOfFireBuff.getPower(),
                      )
                    : this.initialUnitProperties.max_hp) +
                currentLap * 5;
        } else {
            this.unitProperties.max_hp = madeOfFireBuff
                ? Math.ceil(
                      this.initialUnitProperties.max_hp + this.initialUnitProperties.max_hp / madeOfFireBuff.getPower(),
                  )
                : this.initialUnitProperties.max_hp;
        }

        const boostHealthAbility = this.getAbility("Boost Health");
        if (boostHealthAbility) {
            const multiplier = this.calculateAbilityMultiplier(boostHealthAbility, synergyAbilityPowerIncrease);

            let adjustActualHp = false;
            if (this.unitProperties.hp === this.unitProperties.max_hp) {
                adjustActualHp = true;
            }

            this.unitProperties.max_hp = Math.round(
                this.unitProperties.max_hp + this.unitProperties.max_hp * multiplier,
            );
            if (adjustActualHp) {
                this.unitProperties.hp = this.unitProperties.max_hp;
            }
            return this.unitProperties.max_hp;
        }

        return this.unitProperties.max_hp;
    }
}
