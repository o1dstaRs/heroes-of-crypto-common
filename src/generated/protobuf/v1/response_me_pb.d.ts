// package: public
// file: response_me.proto

import * as jspb from "google-protobuf";

export class ResponseMe extends jspb.Message {
  getUsername(): string;
  setUsername(value: string): void;

  getEmail(): string;
  setEmail(value: string): void;

  getWins(): number;
  setWins(value: number): void;

  getLosses(): number;
  setLosses(value: number): void;

  getTotalGamesPlayed(): number;
  setTotalGamesPlayed(value: number): void;

  getIsActive(): boolean;
  setIsActive(value: boolean): void;

  getMatchMakingQueueAddedTime(): number;
  setMatchMakingQueueAddedTime(value: number): void;

  getMatchMakingCooldownTill(): number;
  setMatchMakingCooldownTill(value: number): void;

  getInGameId(): string;
  setInGameId(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ResponseMe.AsObject;
  static toObject(includeInstance: boolean, msg: ResponseMe): ResponseMe.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ResponseMe, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ResponseMe;
  static deserializeBinaryFromReader(message: ResponseMe, reader: jspb.BinaryReader): ResponseMe;
}

export namespace ResponseMe {
  export type AsObject = {
    username: string,
    email: string,
    wins: number,
    losses: number,
    totalGamesPlayed: number,
    isActive: boolean,
    matchMakingQueueAddedTime: number,
    matchMakingCooldownTill: number,
    inGameId: string,
  }
}

