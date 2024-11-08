// package: public
// file: request_code.proto

import * as jspb from "google-protobuf";

export class RequestCode extends jspb.Message {
  getEmail(): string;
  setEmail(value: string): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RequestCode.AsObject;
  static toObject(includeInstance: boolean, msg: RequestCode): RequestCode.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: RequestCode, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RequestCode;
  static deserializeBinaryFromReader(message: RequestCode, reader: jspb.BinaryReader): RequestCode;
}

export namespace RequestCode {
  export type AsObject = {
    email: string,
  }
}

