// package: public
// file: types.proto

import * as jspb from "google-protobuf";
import * as google_protobuf_descriptor_pb from "google-protobuf/google/protobuf/descriptor_pb";

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

  export const creatureLevel: jspb.ExtensionFieldInfo<UnitLevelValsMap>;

  export const creatureFaction: jspb.ExtensionFieldInfo<FactionValsMap>;

export interface FactionValsMap {
  NO_FACTION: 0;
  CHAOS: 1;
  MIGHT: 2;
  NATURE: 3;
  LIFE: 4;
  DEATH: 5;
  ORDER: 6;
}

export const FactionVals: FactionValsMap;

export interface TeamValsMap {
  NO_TEAM: 0;
  UPPER: 1;
  LOWER: 2;
}

export const TeamVals: TeamValsMap;

export interface AttackValsMap {
  NO_ATTACK: 0;
  MELEE: 1;
  RANGE: 2;
  MAGIC: 3;
  MELEE_MAGIC: 4;
}

export const AttackVals: AttackValsMap;

export interface UnitSizeValsMap {
  NO_SIZE: 0;
  SMALL: 1;
  LARGE: 2;
}

export const UnitSizeVals: UnitSizeValsMap;

export interface UnitLevelValsMap {
  NO_LEVEL: 0;
  FIRST: 1;
  SECOND: 2;
  THIRD: 3;
  FOURTH: 4;
}

export const UnitLevelVals: UnitLevelValsMap;

export interface GridValsMap {
  NO_TYPE: 0;
  NORMAL: 1;
  WATER_CENTER: 2;
  LAVA_CENTER: 3;
  BLOCK_CENTER: 4;
}

export const GridVals: GridValsMap;

export interface PickPhaseValsMap {
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

export const PickPhaseVals: PickPhaseValsMap;

export interface PickPhaseActionValsMap {
  NO_ACTION: 0;
  PICK_INITIAL_PAIR: 1;
  PICK_UNIT: 2;
  BAN_UNIT: 3;
  SELECT_ARTIFACT: 4;
  AUGMENT: 5;
  REVEAL: 6;
}

export const PickPhaseActionVals: PickPhaseActionValsMap;

export interface AugmentValsMap {
  NO_AUGMENT: 0;
  AUGMENTS_AND_MAP_SCOUT: 1;
  ALL_UNITS_SCOUT: 2;
}

export const AugmentVals: AugmentValsMap;

export interface AllUnitsScoutAugmentValsMap {
  NO_AUGMENTED_ALL_UNITS_SCOUT: 0;
  AUGMENTED_ALL_UNITS_SCOUT: 1;
}

export const AllUnitsScoutAugmentVals: AllUnitsScoutAugmentValsMap;

export interface AugmentsAndMapScoutAugmentValsMap {
  NO_AUGMENTED_AUGMENTS_AND_MAP_SCOUT: 0;
  AUGMENTED_AUGMENTS_AND_MAP_SCOUT: 1;
}

export const AugmentsAndMapScoutAugmentVals: AugmentsAndMapScoutAugmentValsMap;

export interface MovementValsMap {
  NO_MOVEMENT: 0;
  WALK: 1;
  FLY: 2;
  TELEPORT: 3;
}

export const MovementVals: MovementValsMap;

export interface UnitValsMap {
  NO_UNIT: 0;
  CREATURE: 1;
  HERO: 2;
}

export const UnitVals: UnitValsMap;

export interface CreatureValsMap {
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

export const CreatureVals: CreatureValsMap;
