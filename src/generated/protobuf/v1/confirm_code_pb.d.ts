// package: public
// file: confirm_code.proto

import * as jspb from "google-protobuf";

export class ConfirmCode extends jspb.Message {
  getUsername(): string;
  setUsername(value: string): void;

  getEmail(): string;
  setEmail(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ConfirmCode.AsObject;
  static toObject(includeInstance: boolean, msg: ConfirmCode): ConfirmCode.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ConfirmCode, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ConfirmCode;
  static deserializeBinaryFromReader(message: ConfirmCode, reader: jspb.BinaryReader): ConfirmCode;
}

export namespace ConfirmCode {
  export type AsObject = {
    username: string,
    email: string,
  }
}

