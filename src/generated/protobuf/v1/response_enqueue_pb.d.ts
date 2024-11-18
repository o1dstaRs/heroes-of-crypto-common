// package: public
// file: response_enqueue.proto

import * as jspb from "google-protobuf";

export class ResponseEnqueue extends jspb.Message {
  getMatchMakingQueueAddedTime(): number;
  setMatchMakingQueueAddedTime(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ResponseEnqueue.AsObject;
  static toObject(includeInstance: boolean, msg: ResponseEnqueue): ResponseEnqueue.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ResponseEnqueue, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ResponseEnqueue;
  static deserializeBinaryFromReader(message: ResponseEnqueue, reader: jspb.BinaryReader): ResponseEnqueue;
}

export namespace ResponseEnqueue {
  export type AsObject = {
    matchMakingQueueAddedTime: number,
  }
}

