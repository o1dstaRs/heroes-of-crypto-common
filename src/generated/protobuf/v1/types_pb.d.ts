// package: public
// file: types.proto

import * as jspb from "google-protobuf";

export class StringList extends jspb.Message {
  clearValuesList(): void;
  getValuesList(): Array<string>;
  setValuesList(value: Array<string>): void;
  addValues(value: string, index?: number): string;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): StringList.AsObject;
  static toObject(includeInstance: boolean, msg: StringList): StringList.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: StringList, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): StringList;
  static deserializeBinaryFromReader(message: StringList, reader: jspb.BinaryReader): StringList;
}

export namespace StringList {
  export type AsObject = {
    valuesList: Array<string>,
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
  MELEE_MAGIC: 3;
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

export interface GridTypeMap {
  NO_TYPE: 0;
  NORMAL: 1;
  WATER_CENTER: 2;
  LAVA_CENTER: 3;
  BLOCK_CENTER: 4;
}

export const GridType: GridTypeMap;

export interface PickPhaseMap {
  INITIAL_PICK: 0;
  EXTENDED_PICK: 1;
  EXTENDED_BAN: 2;
  PICK: 3;
  BAN: 4;
  ARTIFACT_1: 5;
  ARTIFACT_2: 6;
  AUGMENTS: 7;
  AUGMENTS_SCOUT: 8;
}

export const PickPhase: PickPhaseMap;

export interface CreatureMap {
  NO_CREATURE: 0;
  ORC: 1;
  SCAVENGER: 2;
  TROGLODYTE: 3;
  TROLL: 4;
  MEDUSA: 5;
  BEHOLDER: 6;
  GOBLIN_KNIGHT: 7;
  EFREET: 8;
  BLACK_DRAGON: 9;
  HYDRA: 10;
  CENTAUR: 11;
  BERSERKER: 12;
  WOLF_RIDER: 13;
  HARPY: 14;
  NOMAD: 15;
  HYENA: 16;
  CYCLOPS: 17;
  OGRE_MAGE: 18;
  THUNDERBIRD: 19;
  BEHEMOTH: 20;
  WOLF: 21;
  FAIRY: 22;
  LEPRECHAUN: 23;
  ELF: 24;
  WHITE_TIGER: 25;
  SATYR: 26;
  MANTIS: 27;
  UNICORN: 28;
  GARGANTUAN: 29;
  PEGASUS: 30;
  PEASANT: 31;
  SQUIRE: 32;
  ARBALESTER: 33;
  VALKYRIE: 34;
  PIKEMAN: 35;
  HEALER: 36;
  GRIFFIN: 37;
  CRUSADER: 38;
  TSAR_CANNON: 39;
  ANGEL: 40;
}

export const Creature: CreatureMap;

