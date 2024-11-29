// package: public
// file: game_public.proto

import * as jspb from "google-protobuf";

export class GamePublic extends jspb.Message {
  getId(): string;
  setId(value: string): void;

  getConfirmed(): boolean;
  setConfirmed(value: boolean): void;

  getInitTime(): number;
  setInitTime(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): GamePublic.AsObject;
  static toObject(includeInstance: boolean, msg: GamePublic): GamePublic.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: GamePublic, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): GamePublic;
  static deserializeBinaryFromReader(message: GamePublic, reader: jspb.BinaryReader): GamePublic;
}

export namespace GamePublic {
  export type AsObject = {
    id: string,
    confirmed: boolean,
    initTime: number,
  }
}

