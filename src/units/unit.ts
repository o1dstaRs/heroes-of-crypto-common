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
import { BROKEN_AEGIS_MISS_CHANCE } from "../artifacts/artifact_properties";
import { getSpellConfig } from "../configuration/config_provider";
import {
    LUCK_CHANGE_FOR_SHIELD,
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
import {
    getCellForPosition,
    getCellsAroundCell,
    getCellsAroundPosition,
    getLargeUnitAttackCells,
    isPositionWithinGrid,
    getDistanceToFurthestCorner,
} from "../grid/grid_math";
import { GridSettings } from "../grid/grid_settings";
import type { IWeightedRoute } from "../grid/path_definitions";
import type { ISceneLog } from "../scene/scene_log_interface";
import { AppliedSpell } from "../spells/applied_spell";
import { Spell } from "../spells/spell";
import { calculateBuffsDebuffsEffect } from "../spells/spell_helper";
import { getLapString, getRandomInt } from "../utils/lib";
import { winningAtLeastOneEventProbability, type XY } from "../utils/math";
import { UnitProperties } from "./unit_properties";
import type { AttackType, MovementType, TeamType, UnitType, FactionType } from "../generated/protobuf/v1/types_gen";
import { PBTypes } from "../generated/protobuf/v1/types";

// Mechanism constructs have this much LOWER effective status resist vs physical AOE damage (see
// getPhysicalAoeDamageMultiplier): a flat -50, so with no other status resist they take ~50% more.
const MECHANISM_AOE_STATUS_RESIST_PENALTY = 50;

// ARTIFACT Broken Aegis (tier-1): the OFFENSIVE break (a chance to Break the ENEMY the wielder attacks)
// lives in FightProperties.getBreakChancePerTeam and flows in as `chanceToBreak` — NOT here. This file
// only applies the self-cost: a flat chance for the wielder's OWN attacks to miss (see the miss block
// below, keyed on the wielder's "Broken Aegis" marker buff). Constant from artifact_properties.

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
    canTraverseLava(): boolean;
    getTarget(): string;
    getAttackRange(): number;
    isSmallSize(): boolean;
    canMove(): boolean;
    getBaseCell(): XY;
    getCells(): XY[];
    getAttackType(): AttackType;
    hasAbilityActive(abilityName: string): boolean;
    hasDebuffActive(debuffName: string): boolean;
    getRangeShots(): number;
    getRangeShotDistance(): number;
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
    // True once this unit has moved during its current turn. Reset when its turn completes. Lets the
    // engine tell a real "manual" end-of-turn (it moved, then finished) from a do-nothing turn (e.g. an
    // AI unit that ended without moving/attacking/casting), which should read + score as a skip.
    protected movedThisTurn = false;
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

        if (this.unitProperties.attack_type === PBTypes.AttackVals.MELEE) {
            this.selectedAttackType = PBTypes.AttackVals.MELEE;
        } else if (this.unitProperties.attack_type === PBTypes.AttackVals.MELEE_MAGIC) {
            this.selectedAttackType = PBTypes.AttackVals.MELEE_MAGIC;
        } else if (this.unitProperties.attack_type === PBTypes.AttackVals.RANGE) {
            this.selectedAttackType = PBTypes.AttackVals.RANGE;
        } else {
            this.selectedAttackType = PBTypes.AttackVals.MAGIC;
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
    public getUnitProperties(): Readonly<UnitProperties> {
        return this.unitProperties as Readonly<UnitProperties>;
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
    // Grant an ability by name at runtime (e.g. the Wounding Charm artifact granting "Deep Wounds Level 1"
    // to a unit that doesn't natively have it). Idempotent — no-op if the unit already has it. Builds the
    // real Ability (with its effect) via the ability factory and registers it in both lists so getAbility /
    // hasAbilityActive / processDeepWoundsAbility all see it.
    public grantAbility(abilityName: string): void {
        if (this.hasAbilityActive(abilityName)) {
            return;
        }
        const ability = this.abilityFactory.makeAbility(abilityName);
        this.abilities.push(ability);
        if (!this.unitProperties.abilities.includes(abilityName)) {
            this.unitProperties.abilities.push(abilityName);
            // Keep the parallel wire arrays aligned with `abilities` so the client actually DRAWS the granted
            // ability's icon + tooltip — RenderableUnit requires abilities / _descriptions / _stack_powered /
            // _auras to be equal length, and getAbilities-based icon rendering reads these per index.
            this.unitProperties.abilities_descriptions.push(
                ability.getDesc().join("\n").replace(/\{\}/g, ability.getPower().toString()),
            );
            this.unitProperties.abilities_stack_powered.push(ability.isStackPowered());
            this.unitProperties.abilities_auras.push(!!ability.getAuraEffect());
        }
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
        } else if (ability.getName() === "Paralysis") {
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
        }
        this.unitProperties.can_cast_spells = this.unitProperties.spells.length > 0;
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

        // The Morale buff is lap-scoped: it lasts the WHOLE lap (so its 1.25 attack multiplier covers
        // every turn the unit takes this lap, including a morale extra turn) and is cleared at the next
        // lap flip — NOT consumed here on the unit's turn. While it's active the unit's other buffs are
        // held (not ticked down), matching the legacy.
        const moraleBuff = this.getBuff("Morale");
        if (!moraleBuff) {
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

        // Dismorale is lap-scoped too: kept for the whole lap (0.8 multiplier) and cleared at the lap
        // flip, not consumed on the unit's turn. While active, the unit's other debuffs are held.
        if (!dismoraleDebuff) {
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
        // Round: %-based buffs (augments/artifacts, amplified ×1.5 by Tome of Amplification) leave steps
        // fractional, which breaks integer-only movement math. A no-op for un-buffed integer steps.
        return Math.round(this.unitProperties.steps + this.unitProperties.steps_mod);
    }
    public getMorale(): number {
        // Round: integer-semantic stat that %-buffs can leave fractional (feeds integer-only RNG/checks).
        const morale = Math.round(this.unitProperties.morale);
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
        // Round: luck feeds HoCLib.getRandomInt (throws on non-safe-integer args). Artifact/augment buffs
        // (esp. Tome of Amplification's ×1.5) can leave it fractional. A no-op for un-buffed integer luck.
        const luck = Math.round(this.unitProperties.luck + this.unitProperties.luck_mod);
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
    // Chance-reduction (%) against STATUS effects — Stun and Paralysis. Granted by the Amulet of Resolve
    // artifact. Deliberately SEPARATE from magic resist (which governs magic damage and spell debuffs):
    // status resistance only lowers the odds a status effect lands. Read as a per-unit artifact "marker"
    // buff, like Broken Aegis / Giant's Maul. 0 when the unit carries no status-resist source.
    public getStatusResist(): number {
        const amuletOfResolveBuff = this.getBuff("Amulet of Resolve");
        return amuletOfResolveBuff ? amuletOfResolveBuff.getPower() : 0;
    }
    // Multiplier applied to PHYSICAL area-of-effect damage this unit TAKES (Area Throw, Large Caliber,
    // Lightning Spin, Skewer Strike, Through Shot). Status resistance (Amulet of Resolve) hardens the army
    // against splash/cleave/line physical AOE — a 25% status resist means 25% less AOE damage. Mechanism
    // constructs (Tsar Cannon, ...) are FRAGILE to it: a flat -50 effective status resist, so they take ~50%
    // more. MAGIC AOE (Fire Breath / Chain Lightning) is deliberately NOT routed here — it goes through magic
    // resist (magic armor) instead. Clamped to [0, ...] so an over-resist can never heal via negative damage.
    public getPhysicalAoeDamageMultiplier(): number {
        const mechanismPenalty = this.hasAbilityActive("Mechanism") ? MECHANISM_AOE_STATUS_RESIST_PENALTY : 0;
        const effectiveResist = this.getStatusResist() - mechanismPenalty;
        return Math.max(0, 1 - effectiveResist / 100);
    }
    // Chance-reduction (%) against MIND-type abilities — Petrifying Gaze, Blindness, Boar Saliva, Aggr.
    // Granted by the Helm of Focus artifact. SEPARATE from magic resist (which is magic armor — flat % off
    // magic damage); mind resistance only lowers the odds a MIND effect lands. Read as a per-unit artifact
    // "marker" buff, exactly like getStatusResist above. 0 when the unit carries no mind-resist source.
    public getMindResist(): number {
        const helmOfFocusBuff = this.getBuff("Helm of Focus");
        return helmOfFocusBuff ? helmOfFocusBuff.getPower() : 0;
    }
    public getSpellsCount(): number {
        if (this.unitType === PBTypes.UnitVals.CREATURE && this.hasEffectActive("Break")) {
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
        return this.unitProperties.movement_type === PBTypes.MovementVals.FLY;
    }
    // Whether this unit may path over lava cells: either it is Made of Fire, or its army carries the
    // Lava Striders artifact (ARTIFACT). Used as the isMadeOfFire argument to PathHelper.getMovePath.
    public canTraverseLava(): boolean {
        return this.hasAbilityActive("Made of Fire") || !!this.getBuff("Lava Striders");
    }
    public getExp(): number {
        return this.unitProperties.exp;
    }
    public getTeam(): TeamType {
        return this.teamType;
    }
    public getOppositeTeam(): TeamType {
        if (this.teamType === PBTypes.TeamVals.NO_TEAM) {
            return PBTypes.TeamVals.NO_TEAM;
        }

        if (this.teamType === PBTypes.TeamVals.LOWER) {
            return PBTypes.TeamVals.UPPER;
        }

        return PBTypes.TeamVals.LOWER;
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
        // Round: stack power feeds HoCLib.getRandomInt (e.g. Petrifying Gaze) which throws on non-safe-integer
        // args; %-based artifact/augment buffs can leave it fractional. A no-op for un-buffed integer values.
        return Math.round(this.unitProperties.stack_power);
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
    public getCenter(): XY {
        if (this.isSmallSize()) {
            return this.getPosition();
        } else {
            return {
                x: this.getPosition().x + this.gridSettings.getHalfStep(),
                y: this.getPosition().y + this.gridSettings.getHalfStep(),
            };
        }
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
    public applyLuckShield(): void {
        // Luck Shield: replace this turn's random luck spread with a fixed positive bonus (so a bad roll
        // like -3 becomes +LUCK_CHANGE_FOR_SHIELD). Persisting it via luckPerTurn keeps it for the rest
        // of the lap — adjustBaseStats re-derives luck_mod from luckPerTurn and only re-rolls once per
        // lap, so it won't be overwritten. Clamped so base + bonus never exceeds the luck cap.
        let luckMod = LUCK_CHANGE_FOR_SHIELD;
        if (luckMod + this.unitProperties.luck > LUCK_MAX_VALUE_TOTAL) {
            luckMod = LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
        }
        this.unitProperties.luck_mod = luckMod;
        this.luckPerTurn = luckMod;
    }
    public applyArmageddonDamage(armageddonWave: number, sceneLog: ISceneLog): number {
        const aw = Math.floor(armageddonWave);
        if (aw <= 0 || aw > NUMBER_OF_ARMAGEDDON_WAVES) {
            return 0;
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
        return armageddonDamage;
    }
    public applyDamage(minusHp: number, chanceToBreak: number, sceneLog: ISceneLog, extendBreak = false): number {
        if (minusHp <= 0) {
            return 0;
        }

        // Break-on-attack: `chanceToBreak` is the ATTACKER's team break chance (Chaos synergy + the
        // Broken Aegis artifact — see FightProperties.getBreakChancePerTeam), applied to the unit being
        // hit (`this`). Break is OFFENSIVE: it mutes the ENEMY the wielder struck, never the wielder.
        // Break doesn't stack: if the unit is already Broken, don't attempt it again — re-applying would
        // just reset the same 1-lap effect and spam a duplicate "got Break" log (e.g. a Double Shot's two
        // hits, or a hit + counter). Skip the whole thing (including the RNG draw) when it's already active,
        // unless a caller explicitly wants to extend it.
        // The break RNG is drawn ONCE (only when a break is actually possible), then used for both the live
        // decision and the diagnostic below — so the two can never disagree, and production's draw count is
        // unchanged (the draw still happens iff chance>0 and the unit isn't already Broken / we're extending).
        const breakPossible = chanceToBreak > 0 && (extendBreak || !this.hasEffectActive("Break"));
        const breakRoll = breakPossible ? getRandomInt(0, 100) : -1;

        // Diagnostic (env-gated, off by default): trace every break-on-attack decision so a live ranked game
        // can show whether Break was even ATTEMPTED (chance>0 => the attacker's team really has Broken Aegis /
        // Chaos BREAK_ON_ATTACK), the exact RNG roll, and the outcome. Answers "break didn't apply to X":
        // chance=0 => seeding gap; roll>=chance => just RNG; applied=true => it worked (a VFX/log gap, not a
        // mechanics bug). Magic immunity is intentionally irrelevant here — see break_magic_immunity.test.
        if (typeof process !== "undefined" && process.env?.HOC_BREAK_DEBUG === "1") {
            console.warn(
                `[BREAK-DEBUG] target=${this.getName()} magicResist=${this.getMagicResist()} ` +
                    `chance=${chanceToBreak} alreadyBroken=${this.hasEffectActive("Break")} roll=${breakRoll} ` +
                    `applied=${breakPossible && breakRoll < Math.min(chanceToBreak, 100)}`,
            );
        }
        if (breakPossible && breakRoll < Math.min(chanceToBreak, 100)) {
            const breakEffect = this.effectFactory.makeEffect("Break");
            if (breakEffect) {
                if (extendBreak) {
                    breakEffect.extend();
                }
                const laps = breakEffect.getLaps();
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
    public increaseMorale(moraleAmount: number, _synergyMoraleIncrease: number): void {
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

        // Apply the change to the BASE (pre-synergy) morale; adjustBaseStats re-adds the synergy
        // bonus on top. Reading the synergy-inflated unitProperties.morale here and subtracting
        // synergyMoraleIncrease was fragile: when the synergy used at adjust time differed (e.g. 0),
        // the net change came out as (amount - synergy) — so with a +morale synergy, moving toward
        // the enemy showed +1 (or even -1) instead of +3.
        let newMorale = this.initialUnitProperties.morale + moraleAmount;
        if (newMorale > MORALE_MAX_VALUE_TOTAL) {
            newMorale = MORALE_MAX_VALUE_TOTAL;
        }
        if (newMorale < -MORALE_MAX_VALUE_TOTAL) {
            newMorale = -MORALE_MAX_VALUE_TOTAL;
        }
        this.initialUnitProperties.morale = newMorale;
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
    public decreaseMorale(moraleAmount: number, _synergyMoraleIncrease: number): void {
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

        // See increaseMorale: change the BASE morale directly; synergy is re-applied by adjustBaseStats.
        let newMorale = this.initialUnitProperties.morale - moraleAmount;
        if (newMorale > MORALE_MAX_VALUE_TOTAL) {
            newMorale = MORALE_MAX_VALUE_TOTAL;
        }
        if (newMorale < -MORALE_MAX_VALUE_TOTAL) {
            newMorale = -MORALE_MAX_VALUE_TOTAL;
        }
        this.initialUnitProperties.morale = newMorale;
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
        // Made of Fire's central-lava boost (+10% all stats/abilities). Lava Striders grants the actual ability
        // to the whole army (units_holder), so this single hasAbilityActive gate covers both innate Fire units
        // and Lava-Striders armies uniformly.
        if (hasLavaCell && this.hasAbilityActive("Made of Fire") && !this.hasBuffActive("Made of Fire")) {
            const spellProperties = getSpellConfig("System", "Made of Fire");
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
                    spellProperties: getSpellConfig("System", "Made of Water"),
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

        // Flesh Shield is stack-powered: scale its base absorption by stack power, then apply the same
        // luck/synergy adjustment used by other stack abilities. Clamp because absorption is a percentage.
        if (auraEffect.getPowerType() === AbilityPowerType.ABSORB_DAMAGE) {
            return Math.min(
                100,
                Math.max(
                    0,
                    (auraEffect.getPower() / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                        this.getLuck() +
                        synergyAbilityPowerIncrease,
                ),
            );
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

        // ARTIFACT Broken Aegis: the self-cost of the offensive break — the wielder's own attacks have a
        // flat chance to miss (keyed on the wielder's "Broken Aegis" marker buff, not the enemy's).
        if (this.getBuff("Broken Aegis")) {
            combinedMissChances.push(BROKEN_AEGIS_MISS_CHANCE / 100);
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
            attackType === PBTypes.AttackVals.RANGE,
            synergyAbilityPowerIncrease,
            divisor,
        );
        const max = this.calculateAttackDamageMax(
            this.getAttack(),
            enemyUnit,
            attackType === PBTypes.AttackVals.RANGE,
            synergyAbilityPowerIncrease,
            divisor,
        );
        const attackingByMelee =
            attackType === PBTypes.AttackVals.MELEE || attackType === PBTypes.AttackVals.MELEE_MAGIC;
        if (!attackingByMelee && attackType === PBTypes.AttackVals.RANGE) {
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
                // Dense Flesh: a shot aimed at this target consumes ability-power shots total
                if (enemyUnit.hasAbilityActive("Dense Flesh")) {
                    const denseFleshAbility = enemyUnit.getAbility("Dense Flesh");
                    const totalShotsCost = Math.max(1, Math.floor(denseFleshAbility?.getPower() ?? 1));
                    for (let i = 1; i < totalShotsCost; i++) {
                        this.decreaseNumberOfShots();
                    }
                }
            }
        }

        const attackTypeMultiplier =
            attackingByMelee &&
            this.unitProperties.attack_type === PBTypes.AttackVals.RANGE &&
            !this.hasAbilityActive("Handyman")
                ? 0.5
                : 1;

        // Deep Wounds damage bonus: if THIS attacker inflicts Deep Wounds and the target already carries the
        // stacked "Deep Wounds" effect from a prior hit, this strike deals that % more damage. (calculate-
        // ActiveDeepWoundsEffect encoded this but was never wired into damage — this is where it applies, so it
        // works in ranked and sandbox alike since both run this same path.)
        let deepWoundsMultiplier = 1;
        const deepWoundsPower = enemyUnit.getEffect("Deep Wounds")?.getPower() ?? 0;
        if (
            deepWoundsPower > 0 &&
            (this.getAbility("Deep Wounds Level 1") ||
                this.getAbility("Deep Wounds Level 2") ||
                this.getAbility("Deep Wounds Level 3"))
        ) {
            deepWoundsMultiplier = 1 + deepWoundsPower / 100;
        }

        return Math.floor(getRandomInt(min, max) * attackTypeMultiplier * abilityMultiplier * deepWoundsMultiplier);
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
                        (attackType === PBTypes.AttackVals.MELEE || attackType === PBTypes.AttackVals.MELEE_MAGIC)) ||
                    (a.getName() === "Through Shot" && attackType === PBTypes.AttackVals.RANGE)
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
    // Whether this unit has already used its retaliation this lap (set by processOneInTheFieldAbility on any
    // responding unit, cleared at the lap flip). Serialized into the ranked wire snapshot so the client can
    // render the "responded" tag; in sandbox the client reads the live flag directly.
    public getResponded(): boolean {
        return this.responded;
    }
    public setOnHourglass(onHourglass: boolean) {
        this.onHourglass = onHourglass;
    }
    public isOnHourglass(): boolean {
        return this.onHourglass;
    }
    public setMovedThisTurn(moved: boolean) {
        this.movedThisTurn = moved;
    }
    public hasMovedThisTurn(): boolean {
        return this.movedThisTurn;
    }
    public refreshPossibleAttackTypes(canLandRangeAttack: boolean): boolean {
        const currentSelectedAttackType = this.selectedAttackType;
        this.possibleAttackTypes = [];
        if (this.getAttackType() === PBTypes.AttackVals.MAGIC && this.getSpellsCount() > 0 && this.getCanCastSpells()) {
            this.possibleAttackTypes.push(PBTypes.AttackVals.MAGIC);
        } else if (
            this.getAttackType() === PBTypes.AttackVals.RANGE &&
            this.getRangeShots() > 0 &&
            canLandRangeAttack
        ) {
            this.possibleAttackTypes.push(PBTypes.AttackVals.RANGE);
        }

        if (!this.hasAbilityActive("No Melee")) {
            if (this.getAttackType() === PBTypes.AttackVals.MELEE_MAGIC) {
                this.possibleAttackTypes.push(PBTypes.AttackVals.MELEE_MAGIC);
            } else {
                this.possibleAttackTypes.push(PBTypes.AttackVals.MELEE);
            }
        }

        if (
            this.getSpellsCount() > 0 &&
            this.getCanCastSpells() &&
            !this.possibleAttackTypes.includes(PBTypes.AttackVals.MAGIC)
        ) {
            this.possibleAttackTypes.push(PBTypes.AttackVals.MAGIC);
        }

        if (!this.possibleAttackTypes.length) {
            this.possibleAttackTypes.push(PBTypes.AttackVals.NO_ATTACK);
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
            ((selectedAttackType === PBTypes.AttackVals.MELEE &&
                this.possibleAttackTypes.includes(PBTypes.AttackVals.MELEE)) ||
                (selectedAttackType === PBTypes.AttackVals.MELEE_MAGIC &&
                    this.possibleAttackTypes.includes(PBTypes.AttackVals.MELEE_MAGIC)))
        ) {
            if (this.possibleAttackTypes.includes(PBTypes.AttackVals.MELEE_MAGIC)) {
                this.selectedAttackType = PBTypes.AttackVals.MELEE_MAGIC;
                this.unitProperties.attack_type_selected = PBTypes.AttackVals.MELEE_MAGIC;
            } else {
                this.selectedAttackType = PBTypes.AttackVals.MELEE;
                this.unitProperties.attack_type_selected = PBTypes.AttackVals.MELEE;
            }

            return true;
        }

        if (
            selectedAttackType === PBTypes.AttackVals.RANGE &&
            this.unitProperties.attack_type === PBTypes.AttackVals.RANGE &&
            this.getRangeShots() &&
            this.selectedAttackType !== selectedAttackType &&
            this.possibleAttackTypes.includes(PBTypes.AttackVals.RANGE)
        ) {
            this.selectedAttackType = selectedAttackType;
            this.unitProperties.attack_type_selected = PBTypes.AttackVals.RANGE;
            return true;
        }

        if (
            selectedAttackType === PBTypes.AttackVals.MAGIC &&
            this.unitProperties.spells.length &&
            this.unitProperties.can_cast_spells &&
            this.selectedAttackType !== selectedAttackType &&
            this.possibleAttackTypes.includes(PBTypes.AttackVals.MAGIC)
        ) {
            this.selectedAttackType = selectedAttackType;
            this.unitProperties.attack_type_selected = PBTypes.AttackVals.MAGIC;
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
                // Entries are stored as `${faction}:${name}`, but ability-derived castable spells (Wind
                // Flow, Battle Roar, Castling, …) are stored with an EMPTY faction prefix (":name") while
                // the parsed Spell reports faction "System". Reconstructing `${faction}:${name}` therefore
                // never matched those, so the charge was never removed and the spell stayed enabled in the
                // book. Match on the spell NAME (the segment after the last ":") so both forms are removed.
                for (let i = this.unitProperties.spells.length - 1; i >= 0; i--) {
                    const entry = this.unitProperties.spells[i];
                    const entryName = entry.substring(entry.indexOf(":") + 1);
                    if (entryName === spellName) {
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
        // Mechanism units (e.g. Tsar Cannon) cannot be healed — enforce it at the HP-restore chokepoint so
        // NO path (single Heal, Mass Heal, Devour Essence, or any future caller) can restore their HP, even
        // if a caller forgets the canBeHealed() pre-check.
        if (healPower < 0 || !this.canBeHealed()) {
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

        // A unit sitting at full HP must STAY full when its max HP changes below. HP-cap buffs applied at
        // fight start — Pendant of Vitality's +% max HP, HP synergies — raise max_hp but never touch current
        // hp, so without this a fresh stack with an HP artifact would start already "damaged" (e.g. a 170-HP
        // Gargantuan with Pendant would start 170/212 instead of a full 212/212). Captured against the
        // PRE-recompute max_hp so a genuinely damaged unit (hp below its current max) is never free-healed.
        const wasAtFullHp = this.unitProperties.hp >= this.unitProperties.max_hp;

        this.unitProperties.max_hp =
            this.refreshAndGetAdjustedMaxHp(currentLap, synergyAbilityPowerIncrease, madeOfFireBuff) +
            baseStatsDiff.baseStats.hp;

        // ARTIFACTS: Tome of Amplification scales the power of the team-wide System buffs
        // (augments + artifacts) folded into effective stats below. Pendant of Vitality adds % HP here.
        const tomeOfAmplificationBuff = this.getBuff("Tome of Amplification");
        const artifactBuffAmp = tomeOfAmplificationBuff ? 1 + tomeOfAmplificationBuff.getPower() / 100 : 1;
        const ampArtifact = (power: number): number => power * artifactBuffAmp;
        const pendantOfVitalityBuff = this.getBuff("Pendant of Vitality");
        if (pendantOfVitalityBuff) {
            this.unitProperties.max_hp += Number(
                ((this.unitProperties.max_hp / 100) * ampArtifact(pendantOfVitalityBuff.getPower())).toFixed(2),
            );
        }

        if (hasFightStarted && hasUnyieldingPower && !this.adjustedBaseStatsLaps.includes(currentLap)) {
            this.unitProperties.hp += 5;
        }

        // Reconcile current hp with the (possibly changed) max: keep a full unit full when max_hp ROSE
        // (wasAtFullHp — the HP-artifact/synergy refill), and never let current hp exceed max_hp when it
        // DROPPED (a max-hp debuff). A partially-damaged unit keeps its exact hp.
        if (wasAtFullHp || this.unitProperties.max_hp < this.unitProperties.hp) {
            this.unitProperties.hp = this.unitProperties.max_hp;
        }

        // LUCK — recomputed locally unless the value was supplied authoritatively (ranked snapshots
        // carry the server's already-rolled luck incl. auras; recomputing here would roll a divergent
        // per-turn spread on top of it). See UnitProperties.luck_authoritative.
        if (!this.unitProperties.luck_authoritative) {
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

                // Before the fight is initialized (unit placement in sandbox/ranked), units keep their
                // default luck: the random per-turn spread (±LUCK_MAX_CHANGE_FOR_TURN) is only rolled
                // once the fight starts and then re-rolled each lap. Gating the contribution here also
                // stops a stale luckPerTurn (left over from a previous fight/rematch) from leaking into
                // the placement view.
                if (!hasFightStarted) {
                    this.luckPerTurn = 0;
                }
                // ARTIFACTS: Cursed Ward (+luck) and Clover of Fortune (+luck).
                let artifactLuck = 0;
                const cursedWardLuckBuff = this.getBuff("Cursed Ward");
                if (cursedWardLuckBuff) {
                    artifactLuck += ampArtifact(cursedWardLuckBuff.getPower());
                }
                const cloverOfFortuneBuff = this.getBuff("Clover of Fortune");
                if (cloverOfFortuneBuff) {
                    artifactLuck += ampArtifact(cloverOfFortuneBuff.getPower());
                }
                this.unitProperties.luck_mod = this.luckPerTurn + synergyLuckIncrease + artifactLuck;
                if (this.unitProperties.luck_mod + this.unitProperties.luck > LUCK_MAX_VALUE_TOTAL) {
                    this.unitProperties.luck_mod = LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
                } else if (this.unitProperties.luck_mod + this.unitProperties.luck < -LUCK_MAX_VALUE_TOTAL) {
                    this.unitProperties.luck_mod = -LUCK_MAX_VALUE_TOTAL - this.unitProperties.luck;
                }
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
        // ARTIFACTS: Cursed Ward (-morale) and Crown of Command (+morale). Second buff property carries morale.
        const cursedWardMoraleBuff = this.getBuff("Cursed Ward");
        if (cursedWardMoraleBuff) {
            this.unitProperties.morale -= ampArtifact(parseInt(this.getBuffProperties("Cursed Ward")[1] || "0", 10));
        }
        const crownOfCommandMoraleBuff = this.getBuff("Crown of Command");
        if (crownOfCommandMoraleBuff) {
            this.unitProperties.morale += ampArtifact(
                parseInt(this.getBuffProperties("Crown of Command")[1] || "0", 10),
            );
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
                ((this.unitProperties.base_armor / 100) * ampArtifact(armorAugmentBuff.getPower())).toFixed(2),
            );
        }

        // ARTIFACTS: armor / defense. NOTE: Veteran Helm is applied later as an ADDITIONAL stat (armor_mod),
        // not folded into base_armor — see the armor_mod section below.
        // Titan Plate: +% defense as an ADDITIONAL stat (armor_mod), not folded into base_armor — so it never
        // compounds with the armor multiplier or other % defense buffs, and (feeding armor_mod) it guards melee
        // AND ranged. Capture 15% of base here (pre-multiplier); apply into armor_mod at the Veteran Helm block.
        const titanPlateBuff = this.getBuff("Titan Plate");
        const titanPlateArmorBonus = titanPlateBuff
            ? Number(((this.unitProperties.base_armor / 100) * ampArtifact(titanPlateBuff.getPower())).toFixed(2))
            : 0;
        const ironPlateBuff = this.getBuff("Iron Plate");
        if (ironPlateBuff) {
            this.unitProperties.base_armor += ampArtifact(ironPlateBuff.getPower());
        }
        const berserkersBondArmorBuff = this.getBuff("Berserkers Bond");
        if (berserkersBondArmorBuff) {
            this.unitProperties.base_armor = Math.max(
                1,
                this.unitProperties.base_armor -
                    ampArtifact(parseInt(this.getBuffProperties("Berserkers Bond")[1] || "0", 10)),
            );
        }
        const huntersLongbowArmorBuff = this.getBuff("Hunters Longbow");
        if (huntersLongbowArmorBuff) {
            const longbowDefPenaltyPercent = parseInt(this.getBuffProperties("Hunters Longbow")[1] || "0", 10);
            if (longbowDefPenaltyPercent > 0) {
                this.unitProperties.base_armor -= Number(
                    ((this.unitProperties.base_armor / 100) * ampArtifact(longbowDefPenaltyPercent)).toFixed(2),
                );
            }
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
        if (this.getMovementType() === PBTypes.MovementVals.FLY && synergyFlyArmorIncrease > 0) {
            armorModMultiplier = synergyFlyArmorIncrease / 100;
        }
        if (this.hasBuffActive("Spiritual Armor")) {
            const spell = new Spell({
                spellProperties: getSpellConfig("Life", "Spiritual Armor"),
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

        // Veteran Helm: +% defense as an ADDITIONAL stat (armor_mod), scaling from base_armor rather than
        // inflating it. Layered here (after the armor_mod reset/overwrites) so it always survives, and because
        // armor_mod feeds BOTH getArmor and getRangeArmor it now protects vs melee AND ranged — the "+defense
        // (all)" it was always described as (folding into base_armor only guarded melee). Additive off base, so
        // it never compounds with other % defense buffs.
        const veteranHelmArmorBuff = this.getBuff("Veteran Helm");
        if (veteranHelmArmorBuff) {
            this.unitProperties.armor_mod += Number(
                ((this.unitProperties.base_armor / 100) * ampArtifact(veteranHelmArmorBuff.getPower())).toFixed(2),
            );
        }

        // Titan Plate's +% defense (captured pre-multiplier above) lands here as an additional armor_mod, exactly
        // like Veteran Helm — additive off base, non-compounding, guarding melee + ranged.
        if (titanPlateArmorBonus) {
            this.unitProperties.armor_mod = Number((this.unitProperties.armor_mod + titanPlateArmorBonus).toFixed(2));
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

        // NOTE: Helm of Focus is intentionally NOT folded into magic_resist (which is magic armor — flat % off
        // magic DAMAGE). It grants MIND resistance instead (see getMindResist), which lowers the chance a
        // MIND-type ability lands — read as a marker buff at the ability hooks, exactly like getStatusResist.

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
            this.unitProperties.steps += ampArtifact(movementAugmentBuff.getPower());
        }
        // ARTIFACTS: movement. Swift Boots (melee) and Winged Boots (flyers) are only applied to eligible
        // units in applyArtifacts, so buff presence is sufficient. Crown of Command grants +steps to all.
        const swiftBootsBuff = this.getBuff("Swift Boots");
        if (swiftBootsBuff) {
            // Percent of base steps (power is a %), not a flat +1 — scales with the unit's own movement.
            this.unitProperties.steps += Number(
                ((this.unitProperties.steps / 100) * ampArtifact(swiftBootsBuff.getPower())).toFixed(2),
            );
        }
        const wingedBootsBuff = this.getBuff("Winged Boots");
        if (wingedBootsBuff) {
            this.unitProperties.steps += ampArtifact(wingedBootsBuff.getPower());
        }
        const crownOfCommandStepsBuff = this.getBuff("Crown of Command");
        if (crownOfCommandStepsBuff) {
            this.unitProperties.steps += ampArtifact(crownOfCommandStepsBuff.getPower());
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

        if (this.getAttackTypeSelection() !== PBTypes.AttackVals.RANGE && mightAugmentBuff) {
            this.unitProperties.base_attack += Number(
                ((this.unitProperties.base_attack / 100) * ampArtifact(mightAugmentBuff.getPower())).toFixed(2),
            );
        }

        const sniperAugmentBuff = this.getBuff("Sniper Augment");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && sniperAugmentBuff) {
            const buffProperties = this.getBuffProperties(sniperAugmentBuff.getName());
            if (buffProperties?.length === 2) {
                this.unitProperties.base_attack += Number(
                    ((this.unitProperties.base_attack / 100) * ampArtifact(parseInt(buffProperties[0]))).toFixed(2),
                );
                // SHOT DISTANCE
                this.unitProperties.shot_distance += Number(
                    ((this.unitProperties.shot_distance / 100) * ampArtifact(parseInt(buffProperties[1]))).toFixed(2),
                );
            }
        }

        // ARTIFACT Farsight Quiver: extend an archer's BASIC shot range by +% as an ADDITIONAL modifier. Added
        // off the INITIAL shot_distance (not the Sniper-Augment-boosted value above), so it doesn't compound with
        // Sniper Augment. This pushes out the range-falloff threshold (attack_handler.getRangeAttackDivisor)
        // rather than removing falloff entirely (which is what it used to do).
        const farsightQuiverBuff = this.getBuff("Farsight Quiver");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && farsightQuiverBuff) {
            this.unitProperties.shot_distance += Number(
                ((this.initialUnitProperties.shot_distance / 100) * ampArtifact(farsightQuiverBuff.getPower())).toFixed(
                    2,
                ),
            );
        }

        // ARTIFACTS: attack. Flat bonuses first, then percentage bonuses off the running base_attack.
        const keenBladeBuff = this.getBuff("Keen Blade");
        if (keenBladeBuff) {
            this.unitProperties.base_attack += ampArtifact(keenBladeBuff.getPower());
        }
        const berserkersBondAttackBuff = this.getBuff("Berserkers Bond");
        if (berserkersBondAttackBuff) {
            this.unitProperties.base_attack += ampArtifact(berserkersBondAttackBuff.getPower());
        }
        // Veteran Helm grants NO attack — it is a DEFENSE-ONLY artifact (armor_mod block above).
        // Warlord's Edge: +% attack as an ADDITIONAL stat (attack_mod), not folded into base_attack — so it never
        // compounds with the Sharpened Weapons aura multiplier and isn't amplified by base_attack-derived effects
        // (Riot/Weakness). Capture 15% of base here (pre-aura); apply into attack_mod after those overwrites below.
        const warlordsEdgeBuff = this.getBuff("Warlords Edge");
        const warlordsEdgeAttackBonus = warlordsEdgeBuff
            ? Number(((this.unitProperties.base_attack / 100) * ampArtifact(warlordsEdgeBuff.getPower())).toFixed(2))
            : 0;
        const huntersLongbowAttackBuff = this.getBuff("Hunters Longbow");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && huntersLongbowAttackBuff) {
            // Flat additional attack (NOT a percent of base attack) for ranged units.
            const longbowAttackFlat = parseInt(this.getBuffProperties("Hunters Longbow")[0] || "0", 10);
            this.unitProperties.base_attack += ampArtifact(longbowAttackFlat);
        }
        const pendantOfVitalityAttackBuff = this.getBuff("Pendant of Vitality");
        if (pendantOfVitalityAttackBuff) {
            // parseFloat (not parseInt) so a fractional penalty like 12.5% applies exactly rather than truncating to 12.
            const pendantAttackPenaltyPercent = parseFloat(this.getBuffProperties("Pendant of Vitality")[1] || "0");
            this.unitProperties.base_attack -= Number(
                ((this.unitProperties.base_attack / 100) * ampArtifact(pendantAttackPenaltyPercent)).toFixed(2),
            );
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
                spellProperties: getSpellConfig("Chaos", "Riot"),
                amount: 1,
            });
            this.unitProperties.attack_mod = (this.unitProperties.base_attack * spell.getPower()) / 100;
        } else if (this.hasBuffActive("Mass Riot")) {
            const spell = new Spell({
                spellProperties: getSpellConfig("Chaos", "Mass Riot"),
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

        // Veteran Helm is a DEFENSE-ONLY artifact (see the armor_mod block above); it grants no attack.

        // Warlord's Edge's +% attack (captured pre-aura above) lands here as an additional attack_mod — additive
        // off base, non-compounding, surviving the Riot/Weakness attack_mod overwrites; getAttack = base + mod.
        this.unitProperties.attack_mod = Number((this.unitProperties.attack_mod + warlordsEdgeAttackBonus).toFixed(2));
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

            // Immobilized (this branch runs only when !canMove(), i.e. Paralysis): the unit cannot
            // step anywhere, so the ONLY valid cell to strike from is where it currently stands. The
            // valid attack-from anchors are therefore the unit's own current cells — not the ring of
            // cells around it. (Previously small units used getCellsAroundCell + an unconditional
            // addPos=true, which lit up every adjacent cell as a phantom attack position.)
            const checkCells: XY[] = this.isSmallSize() ? [baseCell] : this.getCells();
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
                            // Only the cell the paralyzed unit actually stands on is a valid attack
                            // position (checkCells == [baseCell] here).
                            addPos = surroundingCellHashes.includes(posHash);
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
            // Ability-derived spells are stored with an empty faction prefix (":SpellName").
            // Default an empty faction to "System" (as getSpellConfig does) so those auto-parsed
            // spells are included instead of skipped.
            const factionName = spArr[0] || "System";
            if (!spArr[1]) {
                continue;
            }

            const spellProperties = getSpellConfig(factionName, spArr[1]);
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
    public getEnemyArmor(enemyUnit: Unit, isRangeAttack: boolean, synergyAbilityPowerIncrease: number): number {
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
