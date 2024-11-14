// package: public
// file: reset_password.proto

import * as jspb from "google-protobuf";

export class ResetPassword extends jspb.Message {
  getEmail(): string;
  setEmail(value: string): void;

  getPassword(): string;
  setPassword(value: string): void;

  getToken(): Uint8Array | string;
  getToken_asU8(): Uint8Array;
  getToken_asB64(): string;
  setToken(value: Uint8Array | string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ResetPassword.AsObject;
  static toObject(includeInstance: boolean, msg: ResetPassword): ResetPassword.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ResetPassword, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ResetPassword;
  static deserializeBinaryFromReader(message: ResetPassword, reader: jspb.BinaryReader): ResetPassword;
}

export namespace ResetPassword {
  export type AsObject = {
    email: string,
    password: string,
    token: Uint8Array | string,
  }
}

