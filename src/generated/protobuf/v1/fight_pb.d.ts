// package: public
// file: fight.proto

import * as jspb from "google-protobuf";
import * as types_pb from "./types_pb";

export class Fight extends jspb.Message {
  getId(): Uint8Array | string;
  getId_asU8(): Uint8Array;
  getId_asB64(): string;
  setId(value: Uint8Array | string): void;

  getCurrentLap(): number;
  setCurrentLap(value: number): void;

  getFirstTurnMade(): boolean;
  setFirstTurnMade(value: boolean): void;

  getFightFinished(): boolean;
  setFightFinished(value: boolean): void;

  getPreviousTurnTeam(): types_pb.TeamMap[keyof types_pb.TeamMap];
  setPreviousTurnTeam(value: types_pb.TeamMap[keyof types_pb.TeamMap]): void;

  getHighestSpeedThisTurn(): number;
  setHighestSpeedThisTurn(value: number): void;

  clearAlreadyMadeTurnList(): void;
  getAlreadyMadeTurnList(): Array<string>;
  setAlreadyMadeTurnList(value: Array<string>): void;
  addAlreadyMadeTurn(value: string, index?: number): string;

  getAlreadyMadeTurnByTeamMap(): jspb.Map<number, types_pb.StringList>;
  clearAlreadyMadeTurnByTeamMap(): void;
  clearAlreadyHourGlassList(): void;
  getAlreadyHourGlassList(): Array<string>;
  setAlreadyHourGlassList(value: Array<string>): void;
  addAlreadyHourGlass(value: string, index?: number): string;

  clearAlreadyRepliedAttackList(): void;
  getAlreadyRepliedAttackList(): Array<string>;
  setAlreadyRepliedAttackList(value: Array<string>): void;
  addAlreadyRepliedAttack(value: string, index?: number): string;

  getTeamUnitsAliveMap(): jspb.Map<number, number>;
  clearTeamUnitsAliveMap(): void;
  clearHourGlassQueueList(): void;
  getHourGlassQueueList(): Array<string>;
  setHourGlassQueueList(value: Array<string>): void;
  addHourGlassQueue(value: string, index?: number): string;

  clearMoralePlusQueueList(): void;
  getMoralePlusQueueList(): Array<string>;
  setMoralePlusQueueList(value: Array<string>): void;
  addMoralePlusQueue(value: string, index?: number): string;

  clearMoraleMinusQueueList(): void;
  getMoraleMinusQueueList(): Array<string>;
  setMoraleMinusQueueList(value: Array<string>): void;
  addMoraleMinusQueue(value: string, index?: number): string;

  getCurrentTurnStart(): number;
  setCurrentTurnStart(value: number): void;

  getCurrentTurnEnd(): number;
  setCurrentTurnEnd(value: number): void;

  getCurrentLapTotalTimePerTeamMap(): jspb.Map<number, number>;
  clearCurrentLapTotalTimePerTeamMap(): void;
  clearUpNextList(): void;
  getUpNextList(): Array<string>;
  setUpNextList(value: Array<string>): void;
  addUpNext(value: string, index?: number): string;

  getStepsMoraleMultiplier(): number;
  setStepsMoraleMultiplier(value: number): void;

  getHasAdditionalTimeRequestedPerTeamMap(): jspb.Map<number, boolean>;
  clearHasAdditionalTimeRequestedPerTeamMap(): void;
  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Fight.AsObject;
  static toObject(includeInstance: boolean, msg: Fight): Fight.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: Fight, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Fight;
  static deserializeBinaryFromReader(message: Fight, reader: jspb.BinaryReader): Fight;
}

export namespace Fight {
  export type AsObject = {
    id: Uint8Array | string,
    currentLap: number,
    firstTurnMade: boolean,
    fightFinished: boolean,
    previousTurnTeam: types_pb.TeamMap[keyof types_pb.TeamMap],
    highestSpeedThisTurn: number,
    alreadyMadeTurnList: Array<string>,
    alreadyMadeTurnByTeamMap: Array<[number, types_pb.StringList.AsObject]>,
    alreadyHourGlassList: Array<string>,
    alreadyRepliedAttackList: Array<string>,
    teamUnitsAliveMap: Array<[number, number]>,
    hourGlassQueueList: Array<string>,
    moralePlusQueueList: Array<string>,
    moraleMinusQueueList: Array<string>,
    currentTurnStart: number,
    currentTurnEnd: number,
    currentLapTotalTimePerTeamMap: Array<[number, number]>,
    upNextList: Array<string>,
    stepsMoraleMultiplier: number,
    hasAdditionalTimeRequestedPerTeamMap: Array<[number, boolean]>,
  }
}

StringList.prototype.toArray = function () {
    return this.getValuesList();
};
