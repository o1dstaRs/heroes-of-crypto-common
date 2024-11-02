// package: public
// file: new_player.proto

import * as jspb from "google-protobuf";

export class NewPlayer extends jspb.Message {
  getUsername(): string;
  setUsername(value: string): void;

  getEmail(): string;
  setEmail(value: string): void;

  getPassword(): string;
  setPassword(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): NewPlayer.AsObject;
  static toObject(includeInstance: boolean, msg: NewPlayer): NewPlayer.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: NewPlayer, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): NewPlayer;
  static deserializeBinaryFromReader(message: NewPlayer, reader: jspb.BinaryReader): NewPlayer;
}

export namespace NewPlayer {
  export type AsObject = {
    username: string,
    email: string,
    password: string,
  }
}

