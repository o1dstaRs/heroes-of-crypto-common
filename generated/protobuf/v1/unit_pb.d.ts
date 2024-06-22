// package: battlefield
// file: unit.proto

import * as jspb from "google-protobuf";

export class Unit extends jspb.Message {
  getId(): Uint8Array | string;
  getId_asU8(): Uint8Array;
  getId_asB64(): string;
  setId(value: Uint8Array | string): void;

  getRace(): RaceMap[keyof RaceMap];
  setRace(value: RaceMap[keyof RaceMap]): void;

  getName(): string;
  setName(value: string): void;

  getTeam(): TeamMap[keyof TeamMap];
  setTeam(value: TeamMap[keyof TeamMap]): void;

  getMaxHp(): number;
  setMaxHp(value: number): void;

  getHp(): number;
  setHp(value: number): void;

  getSteps(): number;
  setSteps(value: number): void;

  getStepsMorale(): number;
  setStepsMorale(value: number): void;

  getMorale(): number;
  setMorale(value: number): void;

  getLuck(): number;
  setLuck(value: number): void;

  getSpeed(): number;
  setSpeed(value: number): void;

  getArmorMod(): number;
  setArmorMod(value: number): void;

  getBaseArmor(): number;
  setBaseArmor(value: number): void;

  getAttackType(): AttackTypeMap[keyof AttackTypeMap];
  setAttackType(value: AttackTypeMap[keyof AttackTypeMap]): void;

  getAttackTypeSelected(): AttackTypeMap[keyof AttackTypeMap];
  setAttackTypeSelected(value: AttackTypeMap[keyof AttackTypeMap]): void;

  getAttack(): number;
  setAttack(value: number): void;

  getAttackDamageMin(): number;
  setAttackDamageMin(value: number): void;

  getAttackDamageMax(): number;
  setAttackDamageMax(value: number): void;

  getAttackRange(): number;
  setAttackRange(value: number): void;

  getRangeShots(): number;
  setRangeShots(value: number): void;

  getRangeShotsMod(): number;
  setRangeShotsMod(value: number): void;

  getShotDistance(): number;
  setShotDistance(value: number): void;

  getMagicResist(): number;
  setMagicResist(value: number): void;

  getMagicResistMod(): number;
  setMagicResistMod(value: number): void;

  getCanCastSpells(): boolean;
  setCanCastSpells(value: boolean): void;

  getCanFly(): boolean;
  setCanFly(value: boolean): void;

  getExp(): number;
  setExp(value: number): void;

  getSize(): UnitSizeMap[keyof UnitSizeMap];
  setSize(value: UnitSizeMap[keyof UnitSizeMap]): void;

  getLevel(): UnitLevelMap[keyof UnitLevelMap];
  setLevel(value: UnitLevelMap[keyof UnitLevelMap]): void;

  clearSpellsList(): void;
  getSpellsList(): Array<string>;
  setSpellsList(value: Array<string>): void;
  addSpells(value: string, index?: number): string;

  clearAbilitiesList(): void;
  getAbilitiesList(): Array<string>;
  setAbilitiesList(value: Array<string>): void;
  addAbilities(value: string, index?: number): string;

  clearEffectsList(): void;
  getEffectsList(): Array<string>;
  setEffectsList(value: Array<string>): void;
  addEffects(value: string, index?: number): string;

  getAmountAlive(): number;
  setAmountAlive(value: number): void;

  getAmountDied(): number;
  setAmountDied(value: number): void;

  getLuckPerTurn(): number;
  setLuckPerTurn(value: number): void;

  getAttackMultiplier(): number;
  setAttackMultiplier(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Unit.AsObject;
  static toObject(includeInstance: boolean, msg: Unit): Unit.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Unit, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Unit;
  static deserializeBinaryFromReader(message: Unit, reader: jspb.BinaryReader): Unit;
}

export namespace Unit {
  export type AsObject = {
    id: Uint8Array | string,
    race: RaceMap[keyof RaceMap],
    name: string,
    team: TeamMap[keyof TeamMap],
    maxHp: number,
    hp: number,
    steps: number,
    stepsMorale: number,
    morale: number,
    luck: number,
    speed: number,
    armorMod: number,
    baseArmor: number,
    attackType: AttackTypeMap[keyof AttackTypeMap],
    attackTypeSelected: AttackTypeMap[keyof AttackTypeMap],
    attack: number,
    attackDamageMin: number,
    attackDamageMax: number,
    attackRange: number,
    rangeShots: number,
    rangeShotsMod: number,
    shotDistance: number,
    magicResist: number,
    magicResistMod: number,
    canCastSpells: boolean,
    canFly: boolean,
    exp: number,
    size: UnitSizeMap[keyof UnitSizeMap],
    level: UnitLevelMap[keyof UnitLevelMap],
    spellsList: Array<string>,
    abilitiesList: Array<string>,
    effectsList: Array<string>,
    amountAlive: number,
    amountDied: number,
    luckPerTurn: number,
    attackMultiplier: number,
  }
}

export interface RaceMap {
  CHAOS: 0;
  MIGHT: 1;
  NATURE: 2;
  LIFE: 3;
}

export const Race: RaceMap;

export interface TeamMap {
  NO_TEAM: 0;
  UPPER: 1;
  LOWER: 2;
}

export const Team: TeamMap;

export interface AttackTypeMap {
  MELEE: 0;
  RANGE: 1;
  MAGIC: 2;
}

export const AttackType: AttackTypeMap;

export interface UnitSizeMap {
  NO_SIZE: 0;
  SMALL: 1;
  LARGE: 2;
}

export const UnitSize: UnitSizeMap;

export interface UnitLevelMap {
  NO_LEVEL: 0;
  FIRST: 1;
  SECOND: 2;
  THIRD: 3;
  FOURTH: 4;
}

export const UnitLevel: UnitLevelMap;

