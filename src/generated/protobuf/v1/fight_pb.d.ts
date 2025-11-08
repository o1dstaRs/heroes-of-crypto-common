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

  getGridType(): types_pb.GridValsMap[keyof types_pb.GridValsMap];
  setGridType(value: types_pb.GridValsMap[keyof types_pb.GridValsMap]): void;

  getFirstTurnMade(): boolean;
  setFirstTurnMade(value: boolean): void;

  getFightStarted(): boolean;
  setFightStarted(value: boolean): void;

  getFightFinished(): boolean;
  setFightFinished(value: boolean): void;

  getPreviousTurnTeam(): types_pb.TeamValsMap[keyof types_pb.TeamValsMap];
  setPreviousTurnTeam(value: types_pb.TeamValsMap[keyof types_pb.TeamValsMap]): void;

  getHighestSpeedThisTurn(): number;
  setHighestSpeedThisTurn(value: number): void;

  clearAlreadyMadeTurnList(): void;
  getAlreadyMadeTurnList(): Array<string>;
  setAlreadyMadeTurnList(value: Array<string>): void;
  addAlreadyMadeTurn(value: string, index?: number): string;

  getAlreadyMadeTurnByTeamMap(): jspb.Map<number, types_pb.StringList>;
  clearAlreadyMadeTurnByTeamMap(): void;
  clearAlreadyHourglassList(): void;
  getAlreadyHourglassList(): Array<string>;
  setAlreadyHourglassList(value: Array<string>): void;
  addAlreadyHourglass(value: string, index?: number): string;

  clearAlreadyRepliedAttackList(): void;
  getAlreadyRepliedAttackList(): Array<string>;
  setAlreadyRepliedAttackList(value: Array<string>): void;
  addAlreadyRepliedAttack(value: string, index?: number): string;

  getTeamUnitsAliveMap(): jspb.Map<number, number>;
  clearTeamUnitsAliveMap(): void;
  clearHourglassQueueList(): void;
  getHourglassQueueList(): Array<string>;
  setHourglassQueueList(value: Array<string>): void;
  addHourglassQueue(value: string, index?: number): string;

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
    gridType: types_pb.GridValsMap[keyof types_pb.GridValsMap],
    firstTurnMade: boolean,
    fightStarted: boolean,
    fightFinished: boolean,
    previousTurnTeam: types_pb.TeamValsMap[keyof types_pb.TeamValsMap],
    highestSpeedThisTurn: number,
    alreadyMadeTurnList: Array<string>,
    alreadyMadeTurnByTeamMap: Array<[number, types_pb.StringList.AsObject]>,
    alreadyHourglassList: Array<string>,
    alreadyRepliedAttackList: Array<string>,
    teamUnitsAliveMap: Array<[number, number]>,
    hourglassQueueList: Array<string>,
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

