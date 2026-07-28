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
import { BLIND_FURY_ABILITY_NAME, blindFuryDescription } from "../abilities/blind_fury_ability";
import { AbilityFactory } from "../abilities/ability_factory";
import { AbilityPowerType } from "../abilities/ability_properties";
import { ABSOLVING_ARROW_NAME, absolvingArrowFirstLiftChance } from "../abilities/absolving_arrow_ability";
import { getCraftChances } from "../abilities/craft_ability";
import { BROKEN_AEGIS_MISS_CHANCE } from "../artifacts/artifact_properties";
import { empowerMultiplier } from "../augments/augment_properties";
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
    GUIDING_WINDS_MAX_PERCENT,
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
import { madeOfFireBoostedMaxHp } from "./movement_stat_modifiers";
import { projectStackDamage } from "./stack_damage";
import { roundUnitStat } from "./stat_rounding";
import { UnitProperties } from "./unit_properties";
import type { AttackType, MovementType, TeamType, UnitType, FactionType } from "../generated/protobuf/v1/types_gen";
import { PBTypes } from "../generated/protobuf/v1/types";

// Mechanism constructs have this much LOWER effective status resist vs physical AOE damage (see
// getPhysicalAoeDamageMultiplier): a flat -50, so with no other status resist they take ~50% more.
const MECHANISM_AOE_STATUS_RESIST_PENALTY = 50;

// Shot range a natively-melee unit gains when it holds a stolen Endless Quiver (Predatory
// Assimilation): the quiver's native owner's (Medusa's) shot_distance from creatures.json. Applied in
// adjustBaseStats only while the initial shot_distance is 0, so natural shooters keep their own range.
const STOLEN_ENDLESS_QUIVER_SHOT_DISTANCE = 6.5;

// The abilities whose damage is MAGIC and therefore scales with the team's Empower Augment. Everything else
// that goes through calculateAbilityMultiplier (Double Punch, Lightning Spin, Through Shot, Boost Health,
// Magic Shield, …) is physical output or a defensive figure and is deliberately left alone — Empower buys
// magic damage, not a blanket ability buff. Fire Shield is included even though it triggers on being hit:
// the flames it throws back are the holder's own magic damage.
const EMPOWERED_MAGIC_ABILITIES: ReadonlySet<string> = new Set(["Chain Lightning", "Fire Breath", "Fire Shield"]);

// SPELLBOOK cards own these faction-prefixed spell charges. Keep the mapping explicit: a unit can have
// unrelated castable abilities (stored with a leading colon) or, in the future, more than one spell source,
// and Assimilation must transfer only the remaining charges belonging to the stolen card.
const SPELLBOOK_SPELL_NAMES: Readonly<Record<string, ReadonlySet<string>>> = {
    "Book of Healing": new Set(["Heal", "Spiritual Armor", "Blessing", "Mass Heal"]),
    "Forest Spellbook": new Set(["Courage", "Helping Hand", "Summon Wolves"]),
    "Tome of Might": new Set(["Riot", "Magic Mirror", "Mass Riot", "Mass Magic Mirror"]),
    "Book of Chaos": new Set(["Smoke", "Misfortune", "Fireforged Sword"]),
    "Book of Nightmares": new Set(["Fire Wall", "Empower"]),
    "Basic Tome of Battle Magic": new Set(["Fire Strike", "Meteorite"]),
    "Tome of Elements": new Set(["Whirlpool", "Lightning Strike", "Ring of Fire", "Meteor Shower"]),
    "Blacksmith Tools": new Set(["Craft"]),
    Enchants: new Set(["Armor Rune", "Weapon Rune"]),
};

function isSpellOwnedBySpellbook(entry: string, abilityName: string): boolean {
    if (entry.startsWith(":")) {
        return false;
    }
    const spellName = entry.split(":", 2)[1];
    return !!spellName && !!SPELLBOOK_SPELL_NAMES[abilityName]?.has(spellName);
}

function isDirectAbilitySpellEntry(entry: string, spellName: string): boolean {
    return entry === `:${spellName}` || entry === `System:${spellName}`;
}

function normalizeSpellEntry(entry: string): string {
    return entry.startsWith("System:") ? entry.slice("System".length) : entry;
}

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
    /**
     * Debuff/effect check that also reads the authoritative display list, so the rule holds for a ranked
     * client (which leaves the OBJECT arrays empty) as well as for the engine and the simulator.
     */
    hasStatusApplied(name: string): boolean;
    getRangeShots(): number;
    getRangeShotDistance(): number;
}

export interface IBoardObj {
    isSmallSize(): boolean;
    getPosition(): XY;
    setRenderPosition(x: number, y: number): void;
}

interface IDamageable {
    applyDamage(
        minusHp: number,
        chanceToBreak: number,
        sceneLog: ISceneLog,
        extendBreak: boolean,
        attacker?: Unit,
    ): void;

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
    // Water Shield: set once this unit's one-per-battle absorb shield has been consumed, so the seeding
    // refresh (UnitsHolder.refreshWaterShieldForAllUnits) never re-grants it after it breaks.
    protected waterShieldSpent = false;
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
        // Deep-copy so this unit OWNS its properties (nested arrays included). Client factories stamp
        // same-type stacks by shallow-spreading a shared template (Unit.createUnit({ ...template, id, team }))
        // and stack-splits reuse the source unit's live props — both alias the nested `abilities` /
        // `abilities_descriptions` / ... arrays. Without this clone, grantAbility() pushing to one unit's
        // `abilities` leaked onto every same-type unit (e.g. Craft's Crafted Frozen Bow on ALL Elves).
        this.unitProperties = structuredClone(unitProperties);
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
        // Raw creature configuration omits the synthetic charge for direct-cast ability cards, so the first
        // construction must add it. Once constructed, `spells` is the exact remaining runtime charge list:
        // an absent entry then means "spent" and must stay absent through snapshots/reconstruction.
        const addConfiguredAbilitySpells = this.unitProperties.spell_entries_authoritative !== true;
        this.parseAbilities(addConfiguredAbilitySpells);
        this.unitProperties.spell_entries_authoritative = true;
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
        const abilityToDelete =
            this.abilities.find((ability) => ability.getName() === abilityName) ??
            (this.unitProperties.abilities.includes(abilityName)
                ? this.abilityFactory.makeAbility(abilityName)
                : undefined);
        this.abilities = this.abilities.filter((ability) => ability.getName() !== abilityName);

        for (let i = this.unitProperties.abilities.length - 1; i >= 0; i--) {
            if (this.unitProperties.abilities[i] === abilityName) {
                this.unitProperties.abilities.splice(i, 1);
                this.unitProperties.abilities_descriptions.splice(i, 1);
                this.unitProperties.abilities_stack_powered.splice(i, 1);
                this.unitProperties.abilities_auras.splice(i, 1);
                this.unitProperties.aura_ranges.splice(i, 1);
                this.unitProperties.aura_is_buff.splice(i, 1);
            }
        }
        this.unitProperties.stolen_abilities ??= [];
        this.unitProperties.stolen_abilities = this.unitProperties.stolen_abilities.filter(
            (stolenAbility) => stolenAbility !== abilityName,
        );
        if (abilityToDelete) {
            this.removeAbilityMechanics(abilityToDelete);
        }

        return abilityToDelete;
    }
    // Grant an ability by name at runtime (e.g. the Wounding Charm artifact granting "Deep Wounds Level 0"
    // to a unit that doesn't natively have it). Idempotent — no-op if the unit already has it. Builds the
    // real Ability (with its effect) via the ability factory and registers it in both lists so getAbility /
    // hasAbilityActive / processDeepWoundsAbility all see it.
    public grantAbility(abilityName: string, options: { restoreStolen?: boolean; spellEntries?: string[] } = {}): void {
        if (this.abilities.some((ability) => ability.getName() === abilityName)) {
            return;
        }
        this.unitProperties.stolen_abilities ??= [];
        // Repeated artifact/synergy refreshes must not undo a permanent theft. Only another explicit
        // Assimilation transfer may reactivate a card the receiving unit previously lost.
        if (this.unitProperties.stolen_abilities.includes(abilityName) && !options.restoreStolen) {
            return;
        }
        this.unitProperties.stolen_abilities = this.unitProperties.stolen_abilities.filter(
            (stolenAbility) => stolenAbility !== abilityName,
        );
        const ability = this.abilityFactory.makeAbility(abilityName);
        this.registerAbility(
            ability,
            !this.unitProperties.abilities.includes(abilityName),
            options.spellEntries === undefined,
        );
        if (options.spellEntries?.length) {
            this.unitProperties.spells.push(...options.spellEntries);
            this.parseSpells();
            this.unitProperties.can_cast_spells = this.unitProperties.spells.length > 0;
        }
    }
    public addAbility(ability: Ability): void {
        if (this.abilities.some((currentAbility) => currentAbility.getName() === ability.getName())) {
            return;
        }
        this.unitProperties.stolen_abilities ??= [];
        if (this.unitProperties.stolen_abilities.includes(ability.getName())) {
            return;
        }
        this.registerAbility(ability, !this.unitProperties.abilities.includes(ability.getName()));
    }
    /** Force-installs a successfully stolen ability, including its exact remaining cast charges. */
    public grantStolenAbility(abilityName: string, spellEntries: string[] = []): void {
        this.grantAbility(abilityName, { restoreStolen: true, spellEntries });
    }
    /**
     * Permanently disables an ability without deleting its card data. This distinction lets the client draw
     * the native card with a STOLEN overlay while every mechanical lookup, aura and castable spell is removed.
     */
    public disableAbilityAsStolen(abilityName: string): Ability | undefined {
        const ability = this.abilities.find((candidate) => candidate.getName() === abilityName);
        if (!ability) {
            return undefined;
        }
        this.unitProperties.stolen_abilities ??= [];
        if (!this.unitProperties.stolen_abilities.includes(abilityName)) {
            this.unitProperties.stolen_abilities.push(abilityName);
        }
        const cardIndex = this.unitProperties.abilities.indexOf(abilityName);
        if (cardIndex >= 0 && ability.getAuraEffectName()) {
            this.unitProperties.aura_ranges[cardIndex] = 0;
            this.unitProperties.aura_is_buff[cardIndex] = true;
        }
        this.abilities = this.abilities.filter((candidate) => candidate.getName() !== abilityName);
        this.removeAbilityMechanics(ability);
        return ability;
    }
    public getStolenAbilityNames(): string[] {
        return structuredClone(this.unitProperties.stolen_abilities ?? []);
    }
    /** Removes and returns every remaining spell charge mechanically owned by one ability card. */
    public takeAbilitySpellEntries(abilityName: string): string[] {
        const ability = this.abilities.find((candidate) => candidate.getName() === abilityName);
        if (!ability) {
            return [];
        }
        const castableSpellName = ability.getSpell()?.getName();
        const isOwnedEntry = (entry: string): boolean =>
            ability.getPowerType() === AbilityPowerType.SPELLBOOK
                ? isSpellOwnedBySpellbook(entry, abilityName)
                : !!castableSpellName && isDirectAbilitySpellEntry(entry, castableSpellName);
        const transferred = this.unitProperties.spells.filter(isOwnedEntry);
        if (!transferred.length) {
            return [];
        }
        const retained = this.unitProperties.spells.filter((entry) => !isOwnedEntry(entry));
        this.unitProperties.spells.splice(0, this.unitProperties.spells.length, ...retained);
        this.parseSpells();
        this.unitProperties.can_cast_spells = this.unitProperties.spells.length > 0;
        return ability.getPowerType() === AbilityPowerType.SPELLBOOK
            ? transferred
            : transferred.map(() => `:${castableSpellName}`);
    }
    private registerAbility(ability: Ability, addCardData: boolean, addDefaultSpell = true): void {
        this.abilities.push(ability);
        const cardAuraEffect = ability.getAuraEffect();
        if (addCardData) {
            this.unitProperties.abilities.push(ability.getName());
            this.unitProperties.abilities_descriptions.push(this.getAbilityDescription(ability));
            this.unitProperties.abilities_stack_powered.push(ability.isStackPowered());
            this.unitProperties.abilities_auras.push(!!ability.getAuraEffectName());
            this.unitProperties.aura_ranges.push(cardAuraEffect?.getRange() ?? 0);
            this.unitProperties.aura_is_buff.push(cardAuraEffect?.getProperties().is_buff ?? true);
        } else {
            const cardIndex = this.unitProperties.abilities.indexOf(ability.getName());
            if (cardIndex >= 0) {
                this.unitProperties.aura_ranges[cardIndex] = cardAuraEffect?.getRange() ?? 0;
                this.unitProperties.aura_is_buff[cardIndex] = cardAuraEffect?.getProperties().is_buff ?? true;
            }
        }

        const auraEffect = cardAuraEffect;
        if (auraEffect && !this.unitProperties.aura_effects.includes(auraEffect.getName())) {
            this.unitProperties.aura_effects.push(auraEffect.getName());
            this.auraEffects.push(auraEffect);
        }

        const spell = ability.getSpell();
        const spellName = spell?.getName();
        const spellEntry = spellName ? `:${spellName}` : undefined;
        if (
            addDefaultSpell &&
            spellName &&
            spellEntry &&
            !this.unitProperties.spells.some((entry) => isDirectAbilitySpellEntry(entry, spellName))
        ) {
            this.unitProperties.spells.push(spellEntry);
        }
        this.unitProperties.can_cast_spells = this.unitProperties.spells.length > 0;
        if (spell) {
            this.parseSpells();
        }
    }
    private removeAbilityMechanics(ability: Ability): void {
        const auraEffectName = ability.getAuraEffectName();
        const auraStillProvided = auraEffectName
            ? this.abilities.some((candidate) => candidate.getAuraEffectName() === auraEffectName)
            : false;
        if (auraEffectName && !auraStillProvided) {
            for (let i = this.unitProperties.aura_effects.length - 1; i >= 0; i--) {
                if (this.unitProperties.aura_effects[i] === auraEffectName) {
                    this.unitProperties.aura_effects.splice(i, 1);
                }
            }
            for (let i = this.auraEffects.length - 1; i >= 0; i--) {
                if (this.auraEffects[i].getName() === auraEffectName) {
                    this.auraEffects.splice(i, 1);
                }
            }
        }

        const spellName = ability.getSpell()?.getName();
        if (spellName) {
            for (let spellIndex = this.unitProperties.spells.length - 1; spellIndex >= 0; spellIndex--) {
                if (isDirectAbilitySpellEntry(this.unitProperties.spells[spellIndex], spellName)) {
                    this.unitProperties.spells.splice(spellIndex, 1);
                }
            }
            this.parseSpells();
        }
        this.unitProperties.can_cast_spells = this.unitProperties.spells.length > 0;
    }
    private getAbilityDescription(ability: Ability): string {
        // Blind Fury's power is the share of the stack already lost, so it changes with every casualty.
        // Computed HERE, in common, rather than only in the client's refresh pass: this is the description
        // the server ships in a ranked snapshot, and without it the card kept the raw "{}" placeholder for
        // every player except the one running the sandbox. Same expression adjustBaseStats applies to
        // attack_mod, so the number on the card is the bonus actually being dealt.
        if (ability.getName() === BLIND_FURY_ABILITY_NAME) {
            return blindFuryDescription(
                ability.getDesc().join("\n"),
                this.unitProperties.amount_alive,
                this.unitProperties.amount_died,
            );
        }

        if (ability.getName() === "Chain Lightning") {
            const percentage = Number((this.calculateAbilityMultiplier(ability, 0) * 100).toFixed(2));
            const description = ability.getDesc().join("\n");
            return description
                .replace("{}", Number(percentage.toFixed()).toString())
                .replace("{}", Number(((percentage * 7) / 8).toFixed()).toString())
                .replace("{}", Number(((percentage * 6) / 8).toFixed()).toString())
                .replace("{}", Number(((percentage * 5) / 8).toFixed()).toString());
        }
        if (ability.getName() === "Paralysis") {
            const description = ability.getDesc().join("\n");
            const reduction = this.calculateAbilityApplyChance(ability, 0);
            const chance = Math.min(100, reduction * 2);
            return description
                .replace("{}", Number(chance.toFixed(2)).toString())
                .replace("{}", Number(reduction.toFixed(2)).toString());
        }
        if (ability.getName() === ABSOLVING_ARROW_NAME) {
            // Stack-and-luck scaled like the generic apply chance, but routed through the ability's own
            // helper so the printed figure is exactly the one the lift rolls against. Without this the
            // card fell through to the raw-power default below and always read 100%.
            return ability
                .getDesc()
                .join("\n")
                .replace(/\{\}/g, Number(absolvingArrowFirstLiftChance(this, 0).toFixed(2)).toString());
        }
        if (
            ability.getName() === "Warding Mane Aura" ||
            ability.getName() === "Arcane Ward Aura" ||
            ability.getName() === "Guiding Winds Aura" ||
            ability.getName() === "Sylvan Focus Aura"
        ) {
            // These aura cards print their owner's live projection. The first three scale with stack and luck;
            // Sylvan Focus is flat plus the Satyr's luck. Routing runtime-granted cards through the same owner
            // calculation keeps their text aligned with the value allies actually receive.
            const projectedAura = ability.getAuraEffect();
            if (projectedAura) {
                return ability
                    .getDesc()
                    .join("\n")
                    .replace(/\{\}/g, Number(this.calculateAuraPower(projectedAura, 0).toFixed(2)).toString());
            }
        }
        if (ability.getName() === "Magic Reflection") {
            // The Magic Dragon's passive: stack-scaled 15/30/45/60/75 at power 75, shifted by luck — the exact
            // figure getMagicMirrorAbilityChance rolls, so the card matches the rebound the engine performs.
            const stackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, this.getStackPower()));
            const chance = Math.max(
                0,
                Math.min(100, Math.floor((ability.getPower() / MAX_UNIT_STACK_POWER) * stackPower + this.getLuck())),
            );
            return ability.getDesc().join("\n").replace(/\{\}/g, chance.toString());
        }
        // Fire Breath / Fire Shield print a flat percentage off the ability config, so an Empowered team has to
        // see the RAISED figure or the card would promise 40% while the flames throw back 49.6%. Chain
        // Lightning needs no branch here: its percentages already come from calculateAbilityMultiplier above,
        // which applies Empower itself.
        if (EMPOWERED_MAGIC_ABILITIES.has(ability.getName()) && ability.getName() !== "Chain Lightning") {
            const empowered = ability.getPower() * empowerMultiplier(this.getEmpowerPercentage());
            return ability
                .getDesc()
                .join("\n")
                .replace(/\{\}/g, Number(empowered.toFixed(1)).toString());
        }
        if (ability.getName() === "Blacksmith Tools") {
            // Craft's per-ally outcome chances shift with the caster's luck (see getCraftChances).
            const { stun, nothing, double, frozen } = getCraftChances(this.getLuck());
            return ability
                .getDesc()
                .join("\n")
                .replace("{}", double.toString())
                .replace("{}", frozen.toString())
                .replace("{}", stun.toString())
                .replace("{}", nothing.toString());
        }
        return ability.getDesc().join("\n").replace(/\{\}/g, ability.getPower().toString());
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
    public getForbiddenTarget(): string {
        return this.unitProperties.forbidden_target;
    }
    public setForbiddenTarget(forbiddenTargetUnitId: string): void {
        this.unitProperties.forbidden_target = forbiddenTargetUnitId;
    }
    public resetForbiddenTarget(): void {
        this.unitProperties.forbidden_target = "";
    }
    /**
     * True when Terrifying Gaze bars this unit from touching `enemyUnitId` — both its own attacks and its
     * retaliation. Every attack/response gate and every AI target filter routes through here, so the rule
     * lives in exactly one place. The inverse of the `getTarget()` (Aggr) checks that sit beside it.
     */
    public cannotAttackUnitId(enemyUnitId: string): boolean {
        const forbidden = this.unitProperties.forbidden_target;
        return !!forbidden && forbidden === enemyUnitId;
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
            if (e.getName() === "Stun" || e.getName() === "Blindness" || e.getName() === "Freeze") {
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
            // Index-parallel to applied_effects; the sidebar draws it as a small count badge over the
            // effect icon. Not part of the length guards above so an older snapshot without it still loads.
            (this.unitProperties.applied_effects_stacks ??= []).push(effect.getStacks());
            this.unitProperties.applied_effects_descriptions.push(
                effect.getDesc().replace(/\{\}/g, effect.getPower().toString()),
            );
            return true;
        }

        return false;
    }
    public refreshPreTurnState(sceneLog: ISceneLog) {
        // Snapshot Web only at activation. The live aura can change while a flyer crosses or lands inside
        // it, but movement remains legal until that flyer's next turn starts.
        this.unitProperties.web_movement_locked = this.canFly() && this.hasDebuffActive("Web Aura");
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
                    this.unitProperties.applied_effects_stacks?.splice(i, 1);
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
                this.unitProperties.applied_effects_stacks?.splice(i, 1);
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
        // Round: %-based buffs can leave steps fractional, which breaks integer-only movement math.
        // A no-op for un-buffed integer steps.
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
        // Round: luck feeds HoCLib.getRandomInt (throws on non-safe-integer args). Artifact/augment buffs can
        // leave it fractional. A no-op for un-buffed integer luck.
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
    /**
     * True when this unit is a shooter AT ALL — natively ranged, or a melee unit that gained shooting
     * at runtime (a stolen Endless Quiver: endless ammo via range_shots_mod plus a granted
     * shot_distance in adjustBaseStats). Ammo, pin and debuff checks stay with the callers
     * (AttackHandler.canLandRangeAttack); this only answers "does the unit have a bow to draw".
     */
    public isRangeCapable(): boolean {
        return (
            this.unitProperties.attack_type === PBTypes.AttackVals.RANGE ||
            (this.getRangeShots() > 0 && this.getRangeShotDistance() > 0)
        );
    }
    /**
     * Spend the arrows ONE ranged volley costs against `target`, and report how many were spent.
     *
     * Owns two rules that used to live only in the single-target damage path, which is how a splash
     * shooter (Gargantuan's Area Throw, Cyclops' Large Caliber) came to ignore Dense Flesh entirely — its
     * shots route through the AOE tail, which just decremented once:
     *   - UNLIMITED_SUPPLIES spends nothing at all.
     *   - Dense Flesh makes a volley aimed at that unit cost its ability power instead of one.
     * Call this from EVERY path that consumes a volley so the two can never drift apart again.
     */
    public spendShotsAgainst(target?: Unit): number {
        for (const ability of this.getAbilities()) {
            if (ability.getPowerType() === AbilityPowerType.UNLIMITED_SUPPLIES) {
                return 0;
            }
        }
        const cost =
            target?.hasAbilityActive("Dense Flesh") === true
                ? Math.max(1, Math.floor(target.getAbility("Dense Flesh")?.getPower() ?? 1))
                : 1;
        for (let i = 0; i < cost; i++) {
            this.decreaseNumberOfShots();
        }
        return cost;
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
    // Whether lava is passable AND standable for this unit: either it is innately Made of Fire, or its
    // army carries the Lava Striders artifact ("may move over and stand in lava"). Used as the
    // isMadeOfFire argument to PathHelper.getMovePath and as the canOccupyLava argument everywhere a
    // destination is validated — asking hasAbilityActive("Made of Fire") instead would exclude the whole
    // Lava Striders half, which carries only the marker buff.
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
    /** Whether death cleanup may spend this stack's native or stolen Resurrection charge. */
    public canSelfResurrect(): boolean {
        return this.hasAbilityActive("Resurrection") && this.hasSpellRemaining("Resurrection");
    }
    /**
     * Raise members after the stack has died. This is intentionally distinct from increaseAmountAlive:
     * that legacy helper merges additional living summons, whereas a summoned Arachna Queen may now own
     * a real stolen Resurrection charge and must receive its mechanics as-is.
     */
    public reviveAfterDeath(amount: number): number {
        if (!this.isDead() || !Number.isFinite(amount) || amount <= 0) {
            return 0;
        }
        const revived = Math.min(this.unitProperties.amount_died, Math.floor(amount));
        if (revived <= 0) {
            return 0;
        }
        this.unitProperties.amount_alive += revived;
        this.unitProperties.amount_died -= revived;
        return revived;
    }
    public getLevel(): number {
        return this.unitProperties.level;
    }
    public isWebMovementLocked(): boolean {
        return this.unitProperties.web_movement_locked ?? false;
    }
    /** Restore the authoritative turn-start Web lock without recomputing the live aura mid-turn. */
    public setWebMovementLocked(locked: boolean): void {
        this.unitProperties.web_movement_locked = locked;
    }
    /**
     * Whether the unit may leave the cells it stands on. A unit that cannot move is NOT stunned: it still
     * takes its turn, still attacks whatever it can already reach, and still retaliates (see the
     * !canMove() branch of the attack-cell search) — it simply has nowhere to step.
     */
    public canMove(): boolean {
        return (
            !this.hasStatusApplied("Paralysis") && !this.hasStatusApplied("Whirlpool") && !this.isWebMovementLocked()
        );
    }
    /**
     * True when the named debuff or effect is on this unit — from the OBJECT arrays (sandbox owns the whole
     * derivation and fills them) OR from the authoritative DISPLAY list (ranked).
     *
     * A ranked client deliberately leaves `this.debuffs` / `this.effects` EMPTY: it seeds only the display
     * strings, because rebuilding the objects would make adjustBaseStats double-apply stats that already
     * arrive authoritative. The server folds applied_debuffs AND applied_effects into the snapshot's single
     * debuff list, so the display array is the one place both are visible on that side.
     *
     * Any RULE that must hold identically on both sides — "can this unit move", "may it shoot", "is this a
     * legal target" — has to ask this rather than hasEffectActive/hasDebuffActive, or it silently evaluates
     * to false in ranked and the client offers actions the server then rejects.
     */
    public hasStatusApplied(name: string): boolean {
        return (
            this.hasEffectActive(name) ||
            this.hasDebuffActive(name) ||
            (this.unitProperties.applied_debuffs ?? []).includes(name)
        );
    }
    /**
     * The BUFF twin of hasStatusApplied. Same contract, reading the buff display list — which is the only
     * place a ranked client sees a buff the server applied, since it leaves `this.buffs` empty on purpose.
     */
    public hasStatusBuffApplied(name: string): boolean {
        return this.hasBuffActive(name) || (this.unitProperties.applied_buffs ?? []).includes(name);
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
    public applyDamage(
        minusHp: number,
        chanceToBreak: number,
        sceneLog: ISceneLog,
        extendBreak = false,
        attacker?: Unit,
    ): number {
        if (minusHp <= 0) {
            return 0;
        }

        // Water Shield: once per battle, the first incoming damage instance is fully absorbed (0 damage taken)
        // and the shield breaks. Sits above the Break roll and the HP subtraction so an absorbed hit lands
        // nothing at all; `waterShieldSpent` stops the seeding refresh from re-granting the buff afterwards.
        // FIRE IGNORES IT: a Fire Element attacker (and the fire abilities they cast — Fire Breath, Fire
        // Shield) passes straight through, dealing full damage without absorbing OR consuming the shield.
        if (this.hasBuffActive("Water Shield") && !attacker?.hasAbilityActive("Fire Element")) {
            this.waterShieldSpent = true;
            this.deleteBuff("Water Shield");
            sceneLog.updateLog(`${this.getName()}'s Water Shield absorbs the hit and breaks`);
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

        const damage = projectStackDamage(
            {
                hp: this.unitProperties.hp,
                maxHp: this.unitProperties.max_hp,
                amountAlive: this.unitProperties.amount_alive,
                amountDied: this.unitProperties.amount_died,
            },
            minusHp,
        );
        this.unitProperties.hp = damage.state.hp;
        this.unitProperties.max_hp = damage.state.maxHp;
        this.unitProperties.amount_alive = damage.state.amountAlive;
        this.unitProperties.amount_died = damage.state.amountDied;
        this.handleDamageAnimation(damage.animationDeaths);

        // Apply "Bitter Experience" if available
        if (!damage.dead && damage.unitsDied > 0 && this.hasAbilityActive("Bitter Experience")) {
            this.unitProperties.base_armor += 1;
            this.initialUnitProperties.base_armor += 1;
            this.unitProperties.steps += 1;
            this.initialUnitProperties.steps += 1;
        }

        return damage.appliedDamage;
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
        // Made of Fire's central-lava boost (+10% all stats/abilities), earned by actually moving through
        // (or flying over) lava — hasLavaCell comes from the travelled route. canTraverseLava covers both
        // cohorts that may be in lava at all: innate Fire creatures and Lava Striders armies. A plain flyer
        // crossing lava is deliberately excluded — it can pass over the cell but is not made of fire.
        if (hasLavaCell && this.canTraverseLava() && !this.hasBuffActive("Made of Fire")) {
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

            this.unitProperties.max_hp = madeOfFireBoostedMaxHp(this.unitProperties.max_hp, spellProperties.power);
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
    /**
     * Water Shield seeding: grant this unit its one-per-battle absorb shield as a permanent buff, guarded so
     * it is applied at most once and never re-granted after it is consumed. Called for every unit by
     * UnitsHolder.refreshWaterShieldForAllUnits at fight start / on each stack-power refresh.
     */
    public trySeedWaterShield(): void {
        if (this.waterShieldSpent || !this.hasAbilityActive("Water Shield") || this.hasBuffActive("Water Shield")) {
            return;
        }
        this.applyBuff(new Spell({ spellProperties: getSpellConfig("System", "Water Shield"), amount: 1 }));
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

        // Poison Cloud is not stack-powered: the affected ally applies the flat base % (its own luck is
        // added at hit time in processPoisonAuraAbility), so the stored aura power is just the base value.
        if (auraEffect.getPowerType() === AbilityPowerType.POISON_ON_HIT) {
            return auraEffect.getPower();
        }

        // Rallying Volley (Zena) hands over a flat COUNT of shots, not a percentage and not stack-powered,
        // so the stored aura power is the raw configured value. Every power type missing from this function
        // falls through to the percentage tail at the end, which returns (1 * 100) - 100 = 0 — that is why
        // the aura applied to ranged allies but granted them nothing.
        if (auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_RANGE_SHOTS) {
            return auraEffect.getPower();
        }

        // Guiding Winds is STACK-POWERED plus the owner's luck: the configured power is what a full stack
        // projects (5/10/15/20/25 across the tiers at power 25), luck lifts it, and the whole thing is held
        // to 0..GUIDING_WINDS_MAX_PERCENT so a lucky full stack cannot push archers absurdly far. Computed
        // here, on the aura's OWNER, so the single stored power carries stack and luck to every ally that
        // receives it AND to both descriptions that read it back — exactly like Sylvan Focus below.
        if (auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_SHOT_DISTANCE_PERCENTAGE) {
            const stackPower = Math.max(0, Math.min(MAX_UNIT_STACK_POWER, this.getStackPower()));
            const scaled = (auraEffect.getPower() / MAX_UNIT_STACK_POWER) * stackPower + this.getLuck();
            return Math.max(0, Math.min(GUIDING_WINDS_MAX_PERCENT, scaled));
        }

        // Sylvan Focus (Satyr) is the configured percentage plus the SATYR's own luck — not stack-powered,
        // so its stack size never changes it, but a lucky Satyr focuses harder for everyone standing in the
        // aura. Computed here, on the aura's owner, so the single stored power carries the luck to every
        // ally that receives it AND to both descriptions that read it back.
        if (auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_MAGIC_DAMAGE_PERCENTAGE) {
            return Math.max(0, auraEffect.getPower() + this.getLuck());
        }

        const madeOfFireBuff = this.getBuff("Made of Fire");

        if (
            auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_MELEE_DAMAGE_PERCENTAGE ||
            auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_RANGE_ARMOR_PERCENTAGE ||
            auraEffect.getPowerType() === AbilityPowerType.ADDITIONAL_MAGIC_RESIST_PERCENTAGE ||
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
    // Total Deep Wounds a unit applies in one hit. The cards STACK — their base powers sum — but the flat
    // terms (luck, the team's synergy ability power) apply once to the UNIT, not once per card: a White Tiger
    // carrying the Wounding Charm's Level 1 on top of its native Level 2 adds its luck a single time. Floored
    // as a whole rather than per card, and identical to calculateAbilityCount for a unit holding one card.
    public calculateDeepWoundsCount(abilities: Ability[], synergyAbilityPowerIncrease: number): number {
        if (!abilities.length) {
            return 0;
        }

        const madeOfFireBuff = this.getBuff("Made of Fire");
        let stackedPower = 0;
        for (const ability of abilities) {
            stackedPower +=
                (ability.getPower() / MAX_UNIT_STACK_POWER) * this.getStackPower() +
                (madeOfFireBuff ? (ability.getPower() / 100) * madeOfFireBuff.getPower() : 0);
        }

        return Number(Math.max(0, stackedPower + this.getLuck() + synergyAbilityPowerIncrease).toFixed(1));
    }
    public calculateAbilityCount(ability: Ability, synergyAbilityPowerIncrease: number): number {
        if (
            ability.getPowerType() !== AbilityPowerType.GAIN_ATTACK_AND_ARMOR_EACH_STEP &&
            ability.getPowerType() !== AbilityPowerType.ADDITIONAL_STEPS &&
            ability.getPowerType() !== AbilityPowerType.STEAL_ARMOR_ON_HIT &&
            ability.getPowerType() !== AbilityPowerType.REDUCE_BASE_ATTACK_UPON_MELEE_ATTACK &&
            ability.getName() !== "Shatter Armor" &&
            ability.getName() !== "Deep Wounds Level 0" &&
            ability.getName() !== "Deep Wounds Level 1" &&
            ability.getName() !== "Deep Wounds Level 2" &&
            ability.getName() !== "Deep Wounds Level 3"
        ) {
            return 0;
        }

        const madeOfFireBuff = this.getBuff("Made of Fire");

        if (
            ability.getName() === "Deep Wounds Level 0" ||
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
    /**
     * The team's Empower Augment percentage (0 when unbought), read off the "Empower Augment" buff
     * UnitsHolder.applyAugments puts on every unit of the team. Damage sites and description builders both
     * come here rather than reaching for FightProperties, so the client (which has no authoritative fight
     * state in ranked) and the engine read the same number.
     */
    /**
     * The total percentage added to everything this unit deals as MAGIC damage, from every source there is.
     *
     * Assembled in ONE place on purpose: the engine's cast, the AI's damage estimate and the card in the
     * sidebar all reach the magic-damage bonus through here, so they cannot disagree about it. Sources are
     * additive rather than multiplicative, so two of them still read as a plain "+N%".
     */
    public getMagicDamageBonusPercentage(): number {
        let total = 0;

        const empowerBuff = this.getBuff("Empower Augment");
        if (empowerBuff) {
            const power = empowerBuff.getPower();
            if (Number.isFinite(power) && power > 0) {
                total += power;
            }
        }

        // Empower (Nightmare's scroll): a cast buff rather than an augment or an aura, but it feeds the same
        // total — so the engine's cast, the AI's estimate and the sidebar card all pick it up for free, and
        // it reads as a plain "+N%" stacked additively with the other sources.
        const empowerSpell = this.getBuff("Empower");
        if (empowerSpell) {
            const power = empowerSpell.getPower();
            if (Number.isFinite(power) && power > 0) {
                total += power;
            }
        }

        // Sylvan Focus (Satyr): allies standing within 2 cells of it deal more magic damage.
        const sylvanFocus = this.getAppliedAuraEffect("Sylvan Focus Aura");
        if (sylvanFocus) {
            const power = sylvanFocus.getPower();
            if (Number.isFinite(power) && power > 0) {
                total += power;
            }
        }

        return total;
    }
    /**
     * The magic-damage bonus, under the name every existing call site knows it by. The augment stopped being
     * the only source once Sylvan Focus arrived, and all of those sites want the combined number, so this
     * simply forwards. Prefer getMagicDamageBonusPercentage in new code.
     */
    public getEmpowerPercentage(): number {
        return this.getMagicDamageBonusPercentage();
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

        // Empower Augment: the three abilities that deal MAGIC damage scale with it, the rest do not. Applied
        // to the finished coefficient (not folded into combinedPower) so it reads as exactly "+X% damage",
        // and applied HERE so the engine's cast, the AI's damage estimate and the card in the sidebar all
        // pick it up from one place — every one of them calls this method.
        if (EMPOWERED_MAGIC_ABILITIES.has(ability.getName())) {
            calculatedCoeff *= empowerMultiplier(this.getEmpowerPercentage());
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
    /**
     * Water <-> Fire elemental affinity multiplier. The vulnerability lives on the DEFENDER's element ability
     * (Fire Element / Water Element, power 50 = "takes 50% more from the opposing element"): a Fire-Element
     * attacker vs a Water-Element target, and a Water-Element attacker vs a Fire-Element target, each deal
     * +power% more. Feeding this into calculateAttackDamage covers normal melee/ranged attacks AND Fire Breath
     * (whose per-target damage routes through calculateAttackDamage).
     */
    public getElementalDamageMultiplier(enemyUnit: Unit): number {
        if (this.hasAbilityActive("Fire Element") && enemyUnit.hasAbilityActive("Water Element")) {
            return 1 + (enemyUnit.getAbility("Water Element")?.getPower() ?? 0) / 100;
        }
        if (this.hasAbilityActive("Water Element") && enemyUnit.hasAbilityActive("Fire Element")) {
            return 1 + (enemyUnit.getAbility("Fire Element")?.getPower() ?? 0) / 100;
        }
        return 1;
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
            if (decreaseNumberOfShots) {
                // Unlimited-supplies and Dense Flesh both live in spendShotsAgainst, shared with the AOE tail.
                this.spendShotsAgainst(enemyUnit);
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
            (this.getAbility("Deep Wounds Level 0") ||
                this.getAbility("Deep Wounds Level 1") ||
                this.getAbility("Deep Wounds Level 2") ||
                this.getAbility("Deep Wounds Level 3"))
        ) {
            deepWoundsMultiplier = 1 + deepWoundsPower / 100;
        }

        return Math.floor(
            getRandomInt(min, max) *
                attackTypeMultiplier *
                abilityMultiplier *
                deepWoundsMultiplier *
                this.getElementalDamageMultiplier(enemyUnit),
        );
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
            if (e.getName() === "Stun" || e.getName() === "Blindness" || e.getName() === "Freeze") {
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

        // A natively-melee unit that gained shooting at runtime — a stolen Endless Quiver keeps
        // getRangeShots() > 0 through range_shots_mod, and adjustBaseStats grants it a shot_distance —
        // gets RANGE as a SECONDARY selectable attack type. It is pushed AFTER melee on purpose: the
        // unit's native melee remains the default selection (possibleAttackTypes[0]).
        if (
            !this.possibleAttackTypes.includes(PBTypes.AttackVals.RANGE) &&
            this.getAttackType() !== PBTypes.AttackVals.RANGE &&
            this.getRangeShots() > 0 &&
            this.getRangeShotDistance() > 0 &&
            canLandRangeAttack
        ) {
            this.possibleAttackTypes.push(PBTypes.AttackVals.RANGE);
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

        // No attack_type === RANGE requirement here: possibleAttackTypes is the authority (it only ever
        // contains RANGE for a legal shooter — natively ranged, or melee holding a stolen Endless Quiver).
        if (
            selectedAttackType === PBTypes.AttackVals.RANGE &&
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
        // AURA Rallying Volley (Zena): hand the ranged ally its extra shots HERE, as the aura lands. It cannot
        // be done in adjustBaseStats — that pass runs before the aura refresh, so it would never see one — and
        // the top-up must happen exactly once: rallying_volley_granted makes stepping out and back in, a
        // second Zena, or another refresh a no-op, so shots already FIRED stay spent. The quiver is topped up,
        // never refilled. Effect-helper scoping already guarantees only RANGED allies get here.
        if (isBuff && auraEffectName === "Rallying Volley Aura") {
            const bonus = Math.max(0, Math.floor(power));
            if (bonus > this.unitProperties.rallying_volley_granted) {
                this.unitProperties.range_shots += bonus - this.unitProperties.rallying_volley_granted;
                this.unitProperties.rallying_volley_granted = bonus;
            }
        }
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
        // Keep the wire/snapshot representation aligned with the AppliedSpell. This matters for buffs whose
        // cast-time power differs from configuration (for example, Tome-amplified castable buffs).
        this.unitProperties.applied_buffs_powers.push(buff.getPower());
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
    /**
     * The running total a stacking buff keeps in its FIRST spell property (Blacksmith's runes), read so it
     * survives a unit that carries the buff only as snapshot display state.
     *
     * A ranked client rebuilds every unit from the authoritative snapshot, which conveys buffs as the
     * `applied_buffs*` arrays alone — `this.buffs` stays empty there (RankedPlayScene's
     * getUnitPropertiesFromAuthoritativeState), so getBuff() returns undefined and reading the AppliedSpell
     * on its own scored every enchant as +0. The Blacksmith's whole contribution is that number, so in
     * ranked the runes looked completely dead: the log said "+2 armor" and the card never moved. applyBuff
     * writes the same total into the description as `desc;first;second`, and the server ships those
     * descriptions verbatim, so the display arrays are an equally authoritative source — fall back to them.
     *
     * A snapshot that carries the server's final armor_mod / attack_mod (armor_mod_authoritative) overwrites
     * the whole chain afterwards, so this can never double-count; it is what keeps the runes correct when
     * those fields are absent, and it stays the only source in sandbox.
     */
    private getBuffStacks(buffName: string): number {
        const applied = this.getBuff(buffName);
        if (applied) {
            return applied.getFirstSpellProperty() ?? 0;
        }
        // Absent buff -> ["", ""] -> 0. A malformed entry must not poison the stat with NaN.
        const stored = Number(this.getBuffProperties(buffName)[0]);
        return Number.isFinite(stored) ? stored : 0;
    }
    /**
     * Moves ONE applied buff off `from` and onto this unit, carrying its power, the laps it has LEFT and
     * its rendered description across. Borrowed Grace (Monk) takes a blessing rather than copying it, so
     * the entry has to survive the move intact — rebuilding it from configuration would hand back a full
     * duration and lose any cast-time power (a Tome-amplified buff, an artifact's `;primary;secondary`
     * suffix). An identically named buff already on the thief is replaced, never doubled.
     */
    public takeBuffFrom(from: Unit, buffName: string): boolean {
        const applied = from.getBuff(buffName);
        if (!applied) {
            return false;
        }
        if (
            from.unitProperties.applied_buffs.length !== from.unitProperties.applied_buffs_laps.length ||
            from.unitProperties.applied_buffs.length !== from.unitProperties.applied_buffs_descriptions.length ||
            from.unitProperties.applied_buffs.length !== from.unitProperties.applied_buffs_powers.length
        ) {
            return false;
        }
        const index = from.unitProperties.applied_buffs.indexOf(buffName);
        if (index < 0) {
            return false;
        }

        const laps = from.unitProperties.applied_buffs_laps[index];
        const description = from.unitProperties.applied_buffs_descriptions[index];
        const power = from.unitProperties.applied_buffs_powers[index];

        from.deleteBuff(buffName);
        this.deleteBuff(buffName);
        this.buffs.push(
            new AppliedSpell(
                buffName,
                applied.getPower(),
                applied.getLaps(),
                applied.getFirstSpellProperty(),
                applied.getSecondSpellProperty(),
            ),
        );
        this.unitProperties.applied_buffs.push(buffName);
        this.unitProperties.applied_buffs_laps.push(laps);
        this.unitProperties.applied_buffs_descriptions.push(description);
        this.unitProperties.applied_buffs_powers.push(power);

        return true;
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
            // Health left over after the whole members the budget paid for; it belongs to the last one
            // raised, which becomes the stack's wounded front member. A remainder of ZERO means the budget
            // covered that member exactly, so it comes back at FULL health — writing the bare remainder
            // here resurrected the stack with a 0 hp front member ("resurrection doesn't recover hp").
            const hpStillToHeal = resurrectionPower % this.unitProperties.max_hp;
            this.unitProperties.hp = hpStillToHeal === 0 ? this.unitProperties.max_hp : hpStillToHeal;
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
        // A ranked snapshot hands over the server's FINAL armor_mod / attack_mod. Capture them HERE, before
        // the derivation chains below overwrite them, and restore at the end of each chain. Captured from
        // the live properties rather than initialUnitProperties because that is where the snapshot lands,
        // and it stays correct across repeated calls (each run restores the same number it captured).
        const authoritativeArmorMod = this.unitProperties.armor_mod_authoritative
            ? this.unitProperties.armor_mod
            : undefined;
        const authoritativeAttackMod = this.unitProperties.attack_mod_authoritative
            ? this.unitProperties.attack_mod
            : undefined;
        const authoritativeSteps = this.unitProperties.steps_authoritative
            ? { steps: this.unitProperties.steps, mod: this.unitProperties.steps_mod }
            : undefined;

        // target
        if (!this.hasEffectActive("Aggr")) {
            this.resetTarget();
        }
        // ...and its inverse: the fright wears off with the effect that caused it.
        if (!this.hasEffectActive("Terrifying Gaze")) {
            this.resetForbiddenTarget();
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

        // ARTIFACTS: Pendant of Vitality adds % HP here. Tome of Amplification is intentionally absent from
        // base-stat recomputation: it applies only at the unit-cast buff boundary (spells/castable_buff.ts).
        const pendantOfVitalityBuff = this.getBuff("Pendant of Vitality");
        if (pendantOfVitalityBuff) {
            this.unitProperties.max_hp += roundUnitStat(
                (this.unitProperties.max_hp / 100) * pendantOfVitalityBuff.getPower(),
                2,
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
            // Misfortune is checked BEFORE the max-luck sentinel on purpose: a Luck Aura would otherwise
            // pin luck to +10 and the debuff would never be read at all.
            if (this.hasDebuffActive("Misfortune")) {
                // Misfortune bottoms luck out at -10 — UNLESS the target is actively luck-buffed, in which
                // case the two CANCEL to exactly 0 rather than stacking into a double penalty. Qualifying
                // sources are the Leprechaun's Luck Aura (it arrives as a "Luck Aura" buff, the same one
                // that raises the max-luck sentinel below) and the Clover of Fortune artifact. "Fortune" is
                // matched by name as well, so a future luck buff under that name is covered without another
                // edit here. luck_mod is zeroed either way, so the result cannot be lifted back by per-turn
                // rolls, synergy or artifact luck. See the Sadness block below for the morale equivalent.
                const luckBuffed =
                    baseStatsDiff.baseStats.luck === Number.MAX_SAFE_INTEGER ||
                    this.hasBuffActive("Luck Aura") ||
                    this.hasBuffActive("Clover of Fortune") ||
                    this.hasBuffActive("Fortune");
                this.unitProperties.luck = luckBuffed ? 0 : -LUCK_MAX_VALUE_TOTAL;
                this.unitProperties.luck_mod = 0;
            } else if (baseStatsDiff.baseStats.luck === Number.MAX_SAFE_INTEGER) {
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
                    artifactLuck += cursedWardLuckBuff.getPower();
                }
                const cloverOfFortuneBuff = this.getBuff("Clover of Fortune");
                if (cloverOfFortuneBuff) {
                    artifactLuck += cloverOfFortuneBuff.getPower();
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
        // Rebuild morale from the base only when we own the computation. A ranked snapshot already carries
        // the server's final morale, and the client seeds initialUnitProperties WITH it, so recomputing
        // here re-applied the artifact delta on every refreshUnits(). See morale_authoritative — the twin
        // of the luck_authoritative guard above. The locks below (Madness/Sadness/Courage/Morale/Dismorale)
        // stay live either way: they assign fixed values rather than accumulating, so they agree with the
        // server instead of drifting from it, and they also drive attack_multiplier.
        if (!this.unitProperties.morale_authoritative) {
            if (synergyMoraleIncrease > 0) {
                // this.initialUnitProperties.morale = synergyMoraleIncrease;
                this.unitProperties.morale = this.initialUnitProperties.morale + synergyMoraleIncrease;
            } else {
                this.unitProperties.morale = this.initialUnitProperties.morale;
            }
            // ARTIFACTS: Cursed Ward (-morale) and Crown of Command (+morale). Second buff property carries morale.
            const cursedWardMoraleBuff = this.getBuff("Cursed Ward");
            if (cursedWardMoraleBuff) {
                this.unitProperties.morale -= parseInt(this.getBuffProperties("Cursed Ward")[1] || "0", 10);
            }
            const crownOfCommandMoraleBuff = this.getBuff("Crown of Command");
            if (crownOfCommandMoraleBuff) {
                this.unitProperties.morale += parseInt(this.getBuffProperties("Crown of Command")[1] || "0", 10);
            }
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
            // hasStatus*Applied: morale itself arrives authoritative in ranked, but the MULTIPLIER is
            // derived here from the buff objects — which ranked leaves empty — so a high-morale unit still
            // multiplied its damage by 1 and every damage preview under-read it.
            if (this.hasStatusBuffApplied("Morale")) {
                this.unitProperties.attack_multiplier = 1.25;
                if (!lockedMorale) {
                    this.unitProperties.morale = MORALE_MAX_VALUE_TOTAL;
                }
            } else if (this.hasStatusApplied("Dismorale")) {
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
        this.unitProperties.base_armor = roundUnitStat(
            (madeOfFireBuff
                ? this.initialUnitProperties.base_armor + this.initialUnitProperties.base_armor / 10
                : this.initialUnitProperties.base_armor) + baseStatsDiff.baseStats.armor,
            2,
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
            this.unitProperties.base_armor += roundUnitStat(
                (this.unitProperties.base_armor / 100) * armorAugmentBuff.getPower(),
                2,
            );
        }

        // ARTIFACTS: armor / defense. NOTE: Veteran Helm is applied later as an ADDITIONAL stat (armor_mod),
        // not folded into base_armor — see the armor_mod section below.
        // Titan Plate: +% defense as an ADDITIONAL stat (armor_mod), not folded into base_armor — so it never
        // compounds with the armor multiplier or other % defense buffs, and (feeding armor_mod) it guards melee
        // AND ranged. Capture 15% of base here (pre-multiplier); apply into armor_mod at the Veteran Helm block.
        const titanPlateBuff = this.getBuff("Titan Plate");
        const titanPlateArmorBonus = titanPlateBuff
            ? roundUnitStat((this.unitProperties.base_armor / 100) * titanPlateBuff.getPower(), 2)
            : 0;
        const ironPlateBuff = this.getBuff("Iron Plate");
        if (ironPlateBuff) {
            this.unitProperties.base_armor += ironPlateBuff.getPower();
        }
        // ARTIFACT Winged Boots: flat armour for flyers, alongside the movement it grants below. Only
        // flying units ever carry the buff (applyArtifacts gates it), so its presence is sufficient here.
        // The armour is the SECOND stored value — the power is the steps, which the movement hook reads.
        const wingedBootsArmorBuff = this.getBuff("Winged Boots");
        if (wingedBootsArmorBuff) {
            this.unitProperties.base_armor += parseInt(this.getBuffProperties("Winged Boots")[1] || "0", 10);
        }
        const berserkersBondArmorBuff = this.getBuff("Berserkers Bond");
        if (berserkersBondArmorBuff) {
            this.unitProperties.base_armor = Math.max(
                1,
                this.unitProperties.base_armor - parseInt(this.getBuffProperties("Berserkers Bond")[1] || "0", 10),
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

        this.unitProperties.base_armor = roundUnitStat(this.unitProperties.base_armor * baseArmorMultiplier, 2);

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
        const spiritualArmorBuff = this.getBuff("Spiritual Armor");
        if (spiritualArmorBuff) {
            armorModMultiplier = (spiritualArmorBuff.getPower() / 100) * (1 + armorModMultiplier);
        }

        if (armorModMultiplier) {
            this.unitProperties.armor_mod = roundUnitStat(
                Math.max(this.unitProperties.base_armor - shatterArmorEffectPower, 1) * armorModMultiplier -
                    shatterArmorEffectPower,
                2,
            );
        }

        // Veteran Helm: +% defense as an ADDITIONAL stat (armor_mod), scaling from base_armor rather than
        // inflating it. Layered here (after the armor_mod reset/overwrites) so it always survives, and because
        // armor_mod feeds BOTH getArmor and getRangeArmor it now protects vs melee AND ranged — the "+defense
        // (all)" it was always described as (folding into base_armor only guarded melee). Additive off base, so
        // it never compounds with other % defense buffs.
        const veteranHelmArmorBuff = this.getBuff("Veteran Helm");
        if (veteranHelmArmorBuff) {
            this.unitProperties.armor_mod += roundUnitStat(
                (this.unitProperties.base_armor / 100) * veteranHelmArmorBuff.getPower(),
                2,
            );
        }

        // Titan Plate's +% defense (captured pre-multiplier above) lands here as an additional armor_mod, exactly
        // like Veteran Helm — additive off base, non-compounding, guarding melee + ranged.
        if (titanPlateArmorBonus) {
            this.unitProperties.armor_mod = roundUnitStat(this.unitProperties.armor_mod + titanPlateArmorBonus, 2);
        }

        const angelicHostBuff = this.getBuff("Angelic Host");
        if (angelicHostBuff) {
            this.unitProperties.armor_mod = roundUnitStat(
                this.unitProperties.armor_mod + angelicHostBuff.getPower(),
                2,
            );
        }

        // Armor Rune (Blacksmith): a stacking flat +N armor buff. The accumulated bonus lives in the buff's
        // first spell property (set in enchantCast), so a unit enchanted N times carries +N here and on its card.
        const enchantArmorStacks = this.getBuffStacks("Armor Rune");
        if (enchantArmorStacks) {
            this.unitProperties.armor_mod = roundUnitStat(this.unitProperties.armor_mod + enchantArmorStacks, 2);
        }

        // RANKED: everything above derives armor_mod from effect/buff OBJECT arrays the ranked client
        // deliberately leaves empty, so it would land on the base value while the server has (say) Shatter
        // Armor's -10 applied. The snapshot carries the server's final armor_mod and seeds it into
        // initialUnitProperties, so restore it here rather than guarding each step of the chain.
        if (authoritativeArmorMod !== undefined) {
            this.unitProperties.armor_mod = authoritativeArmorMod;
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
        // The Armor augment hardens MAGIC armor by adding its points STRAIGHT ONTO the base — a level 4
        // creature's 15 becomes 15 + 21 = 36 at augment level 3. Deliberately NOT a percentage of the unit's
        // own magic armor the way the physical half works: base magic armor is 0/5/10/15 by creature level,
        // so a percentage gave a level 1 unit 21% of nothing and a level 2 unit barely one point. Applied to
        // the base here, BEFORE the independent ability rolls below, so Magic Shield / Wardguard / Warding
        // Mane still compose on top of the raised figure.
        const armorAugmentMagicBuff = this.getBuff("Armor Augment");
        if (armorAugmentMagicBuff) {
            this.unitProperties.magic_resist = roundUnitStat(
                this.unitProperties.magic_resist + armorAugmentMagicBuff.getPower(),
                2,
            );
        }
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

            // AURA Warding Mane (Manticore): magic armor for every ally within 2 cells. Folded in as one more
            // INDEPENDENT resistance roll rather than added to magic_resist, so it composes with Magic Shield
            // and Wardguard the same way those compose with each other and can never push the unit to a flat
            // 100% immunity. calculateAuraPower already returned it stack-powered, as a percentage.
            const wardingManeAura = this.getAppliedAuraEffect("Warding Mane Aura");
            if (wardingManeAura) {
                magicResists.push(Math.max(0, wardingManeAura.getPower()) / 100);
            }

            // AURA Arcane Ward (Squire): magic defence for every ally within 2 cells, folded in as one more
            // INDEPENDENT resistance roll exactly like Warding Mane above (already stack-powered as a percentage).
            const arcaneWardAura = this.getAppliedAuraEffect("Arcane Ward Aura");
            if (arcaneWardAura) {
                magicResists.push(Math.max(0, arcaneWardAura.getPower()) / 100);
            }

            this.unitProperties.magic_resist = roundUnitStat(winningAtLeastOneEventProbability(magicResists) * 100, 2);
        }

        // NOTE: Helm of Focus is intentionally NOT folded into magic_resist (which is magic armor — flat % off
        // magic DAMAGE). It grants MIND resistance instead (see getMindResist), which lowers the chance a
        // MIND-type ability lands — read as a marker buff at the ability hooks, exactly like getStatusResist.

        // SHOTS
        if (this.hasAbilityActive("Limited Supply")) {
            const actualStackPowerCoeff = this.getStackPower() / MAX_UNIT_STACK_POWER;
            // Rallying Volley's arrows sit ON TOP of the supply cap rather than inside it. The ceiling is
            // derived from maxRangeShots — the unit's OWN quiver — so without this the aura handed an
            // Arbalester two arrows and this line immediately clamped them away again, while
            // rallying_volley_granted still recorded the grant as spent: the top-up is once-only, so the
            // bonus could never be handed over again. A Limited Supply archer standing in the aura simply
            // never got it, which is exactly what "Rallying Volley does nothing" looked like.
            this.unitProperties.range_shots = Math.min(
                this.unitProperties.range_shots,
                Math.floor(this.maxRangeShots * actualStackPowerCoeff) + this.unitProperties.rallying_volley_granted,
            );
        }

        const endlessQuiverAbility = this.getAbility("Endless Quiver");
        if (endlessQuiverAbility) {
            this.unitProperties.range_shots_mod = endlessQuiverAbility.getPower();
        } else if (this.unitProperties.range_shots_mod) {
            // The quiver is gone (e.g. re-assimilated by another thief) — drop the endless-ammo
            // override so a natively-melee holder stops reading as a shooter.
            this.unitProperties.range_shots_mod = 0;
        }

        // SPEED
        this.unitProperties.speed = madeOfFireBuff
            ? this.initialUnitProperties.speed + this.initialUnitProperties.speed / madeOfFireBuff.getPower()
            : this.initialUnitProperties.speed;

        // STEPS
        this.unitProperties.steps_mod =
            roundUnitStat(stepsMoraleMultiplier * this.getMorale(), 1) + synergyMovementStepsIncrease;
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
        // ARTIFACTS: movement. Swift Boots (melee) and Winged Boots (flyers) are only applied to eligible
        // units in applyArtifacts, so buff presence is sufficient. Crown of Command grants +steps to all.
        const swiftBootsBuff = this.getBuff("Swift Boots");
        if (swiftBootsBuff) {
            // Percent of base steps (power is a %), not a flat +1 — scales with the unit's own movement.
            this.unitProperties.steps += roundUnitStat(
                (this.unitProperties.steps / 100) * swiftBootsBuff.getPower(),
                2,
            );
        }
        const wingedBootsBuff = this.getBuff("Winged Boots");
        if (wingedBootsBuff) {
            this.unitProperties.steps += wingedBootsBuff.getPower();
        }
        const crownOfCommandStepsBuff = this.getBuff("Crown of Command");
        if (crownOfCommandStepsBuff) {
            this.unitProperties.steps += crownOfCommandStepsBuff.getPower();
        }
        const battleRoarBuff = this.getBuff("Battle Roar");
        if (battleRoarBuff) {
            this.unitProperties.steps_mod += battleRoarBuff.getPower();
        }
        if (windFlowBuff) {
            const newSteps = this.unitProperties.steps - windFlowBuff.getPower();
            this.unitProperties.steps = Math.max(1, newSteps);
        }
        // Vine Throw (Trent / Grove Spellbook): the struck creature is snared by the vine and loses a flat
        // slice of its movement. Flat like Wind Flow rather than a percentage like Quagmire, so it bites
        // hardest on the slow creatures the vine is meant to pin down.
        const vineThrowDebuff = this.getDebuff("Vine Throw");
        if (vineThrowDebuff) {
            this.unitProperties.steps = Math.max(1, this.unitProperties.steps - vineThrowDebuff.getPower());
        }

        const quagmireDebuff = this.getDebuff("Quagmire");
        const hamstrungDebuff = this.getDebuff("Hamstrung");
        let stepsMultiplier = 1;
        if (quagmireDebuff) {
            stepsMultiplier *= (100 - quagmireDebuff.getPower()) / 100;
        }
        if (hamstrungDebuff) {
            stepsMultiplier *= (100 - hamstrungDebuff.getPower()) / 100;
        }
        this.unitProperties.steps = roundUnitStat(this.unitProperties.steps * stepsMultiplier, 1);
        this.unitProperties.steps_mod = roundUnitStat(this.unitProperties.steps_mod * stepsMultiplier, 1);
        if (angelicHostBuff) {
            this.unitProperties.steps_mod = roundUnitStat(
                this.unitProperties.steps_mod + angelicHostBuff.getPower(),
                2,
            );
        }

        // RANKED: the chain above reads Quagmire / Hamstrung / Vine Throw / Battle Roar / the boots from
        // OBJECT arrays a ranked client does not carry, so it would hand back full base movement. Restore the
        // server's pair — the client draws its own reachable cells from getSteps(), so this is what stops it
        // offering moves the server rejects (and denying ones it would allow).
        if (authoritativeSteps !== undefined) {
            this.unitProperties.steps = authoritativeSteps.steps;
            this.unitProperties.steps_mod = authoritativeSteps.mod;
        }

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
        // A stolen Endless Quiver (Predatory Assimilation) makes a natively-melee unit a real shooter:
        // range_shots_mod above supplies the endless ammo, and this supplies the shot range — the
        // quiver's native owner's (Medusa's) distance. Natural shooters keep their own distance, and the
        // grant self-reverts because shot_distance is recomputed from initialUnitProperties every pass.
        if (endlessQuiverAbility && this.initialUnitProperties.shot_distance <= 0) {
            this.unitProperties.shot_distance = STOLEN_ENDLESS_QUIVER_SHOT_DISTANCE;
        }
        if (pegasusMightAura) {
            this.unitProperties.base_attack += pegasusMightAura.getPower();
        }

        const mightAugmentBuff = this.getBuff("Might Augment");

        if (this.getAttackTypeSelection() !== PBTypes.AttackVals.RANGE && mightAugmentBuff) {
            this.unitProperties.base_attack += roundUnitStat(
                (this.unitProperties.base_attack / 100) * mightAugmentBuff.getPower(),
                2,
            );
        }

        const sniperAugmentBuff = this.getBuff("Sniper Augment");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && sniperAugmentBuff) {
            const buffProperties = this.getBuffProperties(sniperAugmentBuff.getName());
            if (buffProperties?.length === 2) {
                this.unitProperties.base_attack += roundUnitStat(
                    (this.unitProperties.base_attack / 100) * parseInt(buffProperties[0]),
                    2,
                );
                // SHOT DISTANCE
                this.unitProperties.shot_distance += roundUnitStat(
                    (this.unitProperties.shot_distance / 100) * parseInt(buffProperties[1]),
                    2,
                );
            }
        }

        // ARTIFACT Farsight Quiver: extend an archer's BASIC shot range by +% as an ADDITIONAL modifier. Added
        // off the INITIAL shot_distance (not the Sniper-Augment-boosted value above), so it doesn't compound with
        // Sniper Augment. This pushes out the range-falloff threshold (attack_handler.getRangeAttackDivisor)
        // rather than removing falloff entirely (which is what it used to do).
        const farsightQuiverBuff = this.getBuff("Farsight Quiver");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && farsightQuiverBuff) {
            this.unitProperties.shot_distance += roundUnitStat(
                (this.initialUnitProperties.shot_distance / 100) * farsightQuiverBuff.getPower(),
                2,
            );
        }

        // AURA Guiding Winds (Dryad): ranged allies within 2 cells shoot +% further. Same shape as the
        // Farsight Quiver above — added off the INITIAL shot_distance so it neither compounds with Sniper
        // Augment nor with the quiver, and so it self-reverts the moment the archer leaves the aura
        // (shot_distance is rebuilt from initialUnitProperties on every pass).
        const guidingWindsAura = this.getAppliedAuraEffect("Guiding Winds Aura");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && guidingWindsAura) {
            this.unitProperties.shot_distance += roundUnitStat(
                (this.initialUnitProperties.shot_distance / 100) * guidingWindsAura.getPower(),
                2,
            );
        }

        // ARTIFACTS: attack. Flat bonuses first, then percentage bonuses off the running base_attack.
        const keenBladeBuff = this.getBuff("Keen Blade");
        if (keenBladeBuff) {
            this.unitProperties.base_attack += keenBladeBuff.getPower();
        }
        const berserkersBondAttackBuff = this.getBuff("Berserkers Bond");
        if (berserkersBondAttackBuff) {
            this.unitProperties.base_attack += berserkersBondAttackBuff.getPower();
        }
        // Veteran Helm grants NO attack — it is a DEFENSE-ONLY artifact (armor_mod block above).
        // Warlord's Edge: +% attack as an ADDITIONAL stat (attack_mod), not folded into base_attack — so it never
        // compounds with the Sharpened Weapons aura multiplier and isn't amplified by base_attack-derived effects
        // (Riot/Weakness). Capture 15% of base here (pre-aura); apply into attack_mod after those overwrites below.
        const warlordsEdgeBuff = this.getBuff("Warlords Edge");
        const warlordsEdgeAttackBonus = warlordsEdgeBuff
            ? roundUnitStat((this.unitProperties.base_attack / 100) * warlordsEdgeBuff.getPower(), 2)
            : 0;
        const huntersLongbowAttackBuff = this.getBuff("Hunters Longbow");
        if (this.getAttackTypeSelection() === PBTypes.AttackVals.RANGE && huntersLongbowAttackBuff) {
            // Flat additional attack (NOT a percent of base attack) for ranged units.
            const longbowAttackFlat = parseInt(this.getBuffProperties("Hunters Longbow")[0] || "0", 10);
            this.unitProperties.base_attack += longbowAttackFlat;
        }
        const pendantOfVitalityAttackBuff = this.getBuff("Pendant of Vitality");
        if (pendantOfVitalityAttackBuff) {
            // parseFloat (not parseInt) so a fractional penalty like 12.5% applies exactly rather than truncating to 12.
            const pendantAttackPenaltyPercent = parseFloat(this.getBuffProperties("Pendant of Vitality")[1] || "0");
            this.unitProperties.base_attack -= roundUnitStat(
                (this.unitProperties.base_attack / 100) * pendantAttackPenaltyPercent,
                2,
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

        const riotBuff = this.getBuff("Riot");
        const massRiotBuff = this.getBuff("Mass Riot");
        if (riotBuff) {
            this.unitProperties.attack_mod = (this.unitProperties.base_attack * riotBuff.getPower()) / 100;
        } else if (massRiotBuff) {
            this.unitProperties.attack_mod = (this.unitProperties.base_attack * massRiotBuff.getPower()) / 100;
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
        this.unitProperties.attack_mod = roundUnitStat(this.unitProperties.attack_mod + warlordsEdgeAttackBonus, 2);
        if (angelicHostBuff) {
            this.unitProperties.attack_mod = roundUnitStat(
                this.unitProperties.attack_mod + angelicHostBuff.getPower(),
                2,
            );
        }

        // Weapon Rune (Blacksmith): a stacking flat +N attack buff; accumulated bonus in the buff's first
        // spell property (set in enchantCast). getAttack() = base_attack + attack_mod, so this lands as flat +N.
        const enchantWeaponStacks = this.getBuffStacks("Weapon Rune");
        if (enchantWeaponStacks) {
            this.unitProperties.attack_mod = roundUnitStat(this.unitProperties.attack_mod + enchantWeaponStacks, 2);
        }

        // The attack twin of the armor_mod restore above — Riot / Mass Riot / Weakness / Warlord's Edge /
        // Angelic Host / Weapon Rune all read buff objects a ranked client does not carry.
        if (authoritativeAttackMod !== undefined) {
            this.unitProperties.attack_mod = authoritativeAttackMod;
        }
        this.unitProperties.base_attack = roundUnitStat(this.unitProperties.base_attack * baseAttackMultiplier, 2);
        this.unitProperties.shot_distance = roundUnitStat(this.unitProperties.shot_distance, 2);

        this.unitProperties.range_armor = roundUnitStat(this.unitProperties.base_armor * rangeArmorMultiplier, 2);

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

            // Immobilized (this branch runs only when !canMove(), i.e. Paralysis / Whirlpool): the unit cannot
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
    protected parseAbilities(addConfiguredAbilitySpells = true): boolean {
        let spellAdded = false;
        this.unitProperties.stolen_abilities ??= [];
        for (let i = 0; i < this.unitProperties.abilities.length; i++) {
            const abilityName = this.unitProperties.abilities[i];
            const ability = this.abilityFactory.makeAbility(abilityName);
            const auraEffect = ability.getAuraEffect();
            const wasStolen = this.unitProperties.stolen_abilities.includes(abilityName);
            this.unitProperties.aura_ranges[i] = wasStolen ? 0 : (auraEffect?.getRange() ?? 0);
            this.unitProperties.aura_is_buff[i] = wasStolen ? true : (auraEffect?.getProperties().is_buff ?? true);
            if (wasStolen) {
                const castableSpellName = ability.getSpell()?.getName();
                if (castableSpellName) {
                    for (let spellIndex = this.unitProperties.spells.length - 1; spellIndex >= 0; spellIndex--) {
                        if (isDirectAbilitySpellEntry(this.unitProperties.spells[spellIndex], castableSpellName)) {
                            this.unitProperties.spells.splice(spellIndex, 1);
                        }
                    }
                }
                if (ability.getPowerType() === AbilityPowerType.SPELLBOOK) {
                    const retained = this.unitProperties.spells.filter(
                        (entry) => !isSpellOwnedBySpellbook(entry, abilityName),
                    );
                    this.unitProperties.spells.splice(0, this.unitProperties.spells.length, ...retained);
                }
                continue;
            }
            if (this.abilities.some((activeAbility) => activeAbility.getName() === abilityName)) {
                continue;
            }
            this.abilities.push(ability);
            const auraEffectName = ability.getAuraEffectName();
            if (auraEffectName && !this.unitProperties.aura_effects.includes(auraEffectName)) {
                this.unitProperties.aura_effects.push(auraEffectName);
            }
            const spell = ability.getSpell();
            if (
                addConfiguredAbilitySpells &&
                spell &&
                !this.unitProperties.spells.some((entry) => isDirectAbilitySpellEntry(entry, spell.getName()))
            ) {
                this.unitProperties.spells.push(`:${spell.getName()}`);
                this.unitProperties.can_cast_spells = true;
                spellAdded = true;
            }
        }

        return spellAdded;
    }
    protected refreshAbilitiesDescriptions(_synergyAbilityPowerIncrease: number): void {
        // Blind Fury's card has to be refreshed HERE, in common, and not only in the client's override:
        // its power is the share of the stack already lost, so it changes with every casualty, and in a
        // ranked fight the card text a player reads is the one the SERVER put in the snapshot
        // (RankedPlayScene reads abilities_descriptions straight off the base properties). With the refresh
        // living only in RenderableUnit, the sandbox showed the live number while every ranked player kept
        // reading the seeded "0%" for the whole fight.
        this.refreshBlindFuryDescription();
    }
    /**
     * Rewrite Blind Fury's description with the bonus it is CURRENTLY granting.
     *
     * Same expression adjustBaseStats applies to attack_mod a few lines up — deliberately duplicated rather
     * than shared through a helper only so the two can never drift apart unnoticed: if the maths above
     * changes, this line sits close enough to change with it. The number on the card is the number in the
     * attack.
     */
    private refreshBlindFuryDescription(): void {
        const abilityName = BLIND_FURY_ABILITY_NAME;
        const index = this.unitProperties.abilities.indexOf(abilityName);
        if (index < 0 || index >= this.unitProperties.abilities_descriptions.length) {
            return;
        }
        const ability = this.abilities.find((a) => a.getName() === abilityName);
        if (!ability) {
            return;
        }
        this.unitProperties.abilities_descriptions[index] = blindFuryDescription(
            ability.getDesc().join("\n"),
            this.unitProperties.amount_alive,
            this.unitProperties.amount_died,
        );
    }
    protected parseSpellData(spellData: string[]): Map<string, number> {
        const spells: Map<string, number> = new Map();

        for (const rawSpellEntry of spellData) {
            // `:Spell` is the current direct-ability form; ranked/legacy payloads may use
            // `System:Spell`. They are the same charge source and must aggregate into one Spell amount.
            const spellEntry = normalizeSpellEntry(rawSpellEntry);
            if (!spells.has(spellEntry)) {
                spells.set(spellEntry, 1);
            } else {
                const amount = spells.get(spellEntry);
                spells.set(spellEntry, (amount || 0) + 1);
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
        const activeAuraEffectNames = new Set(
            this.abilities
                .map((ability) => ability.getAuraEffectName())
                .filter((auraEffectName): auraEffectName is string => !!auraEffectName),
        );
        const stolenAuraEffectNames = new Set(
            (this.unitProperties.stolen_abilities ?? [])
                .map((abilityName) => this.abilityFactory.makeAbility(abilityName).getAuraEffectName())
                .filter((auraEffectName): auraEffectName is string => !!auraEffectName),
        );
        // Preserve standalone/raw aura effects used by tests and non-card sources. Only remove an aura known
        // to belong to a stolen card, unless another still-active ability also provides that same aura.
        const retained = this.unitProperties.aura_effects.filter(
            (auraEffectName) => !stolenAuraEffectNames.has(auraEffectName) || activeAuraEffectNames.has(auraEffectName),
        );
        this.unitProperties.aura_effects.splice(0, this.unitProperties.aura_effects.length, ...retained);
        for (const auraEffectName of this.unitProperties.aura_effects) {
            if (this.auraEffects.some((auraEffect) => auraEffect.getName() === auraEffectName)) {
                continue;
            }
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
