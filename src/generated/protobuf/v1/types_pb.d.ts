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

