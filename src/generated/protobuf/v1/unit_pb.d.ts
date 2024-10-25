// package: public
// file: unit.proto

import * as jspb from "google-protobuf";
import * as types_pb from "./types_pb";

export class Unit extends jspb.Message {
  getId(): Uint8Array | string;
  getId_asU8(): Uint8Array;
  getId_asB64(): string;
  setId(value: Uint8Array | string): void;

  getRace(): types_pb.RaceMap[keyof types_pb.RaceMap];
  setRace(value: types_pb.RaceMap[keyof types_pb.RaceMap]): void;

  getName(): string;
  setName(value: string): void;

  getTeam(): types_pb.TeamMap[keyof types_pb.TeamMap];
  setTeam(value: types_pb.TeamMap[keyof types_pb.TeamMap]): void;

  getMaxHp(): number;
  setMaxHp(value: number): void;

  getHp(): number;
  setHp(value: number): void;

  getSteps(): number;
  setSteps(value: number): void;

  getStepsMod(): number;
  setStepsMod(value: number): void;

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

  getAttackType(): types_pb.AttackTypeMap[keyof types_pb.AttackTypeMap];
  setAttackType(value: types_pb.AttackTypeMap[keyof types_pb.AttackTypeMap]): void;

  getAttackTypeSelected(): types_pb.AttackTypeMap[keyof types_pb.AttackTypeMap];
  setAttackTypeSelected(value: types_pb.AttackTypeMap[keyof types_pb.AttackTypeMap]): void;

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

  getSize(): types_pb.UnitSizeMap[keyof types_pb.UnitSizeMap];
  setSize(value: types_pb.UnitSizeMap[keyof types_pb.UnitSizeMap]): void;

  getLevel(): types_pb.UnitLevelMap[keyof types_pb.UnitLevelMap];
  setLevel(value: types_pb.UnitLevelMap[keyof types_pb.UnitLevelMap]): void;

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
    race: types_pb.RaceMap[keyof types_pb.RaceMap],
    name: string,
    team: types_pb.TeamMap[keyof types_pb.TeamMap],
    maxHp: number,
    hp: number,
    steps: number,
    stepsMod: number,
    morale: number,
    luck: number,
    speed: number,
    armorMod: number,
    baseArmor: number,
    attackType: types_pb.AttackTypeMap[keyof types_pb.AttackTypeMap],
    attackTypeSelected: types_pb.AttackTypeMap[keyof types_pb.AttackTypeMap],
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
    size: types_pb.UnitSizeMap[keyof types_pb.UnitSizeMap],
    level: types_pb.UnitLevelMap[keyof types_pb.UnitLevelMap],
    spellsList: Array<string>,
    abilitiesList: Array<string>,
    effectsList: Array<string>,
    amountAlive: number,
    amountDied: number,
    luckPerTurn: number,
    attackMultiplier: number,
  }
}

