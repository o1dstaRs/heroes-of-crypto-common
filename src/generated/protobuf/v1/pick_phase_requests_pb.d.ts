// package: public
// file: pick_phase_requests.proto

import * as jspb from "google-protobuf";

export class PickPairRequest extends jspb.Message {
  getPairIndex(): number;
  setPairIndex(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): PickPairRequest.AsObject;
  static toObject(includeInstance: boolean, msg: PickPairRequest): PickPairRequest.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: PickPairRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): PickPairRequest;
  static deserializeBinaryFromReader(message: PickPairRequest, reader: jspb.BinaryReader): PickPairRequest;
}

export namespace PickPairRequest {
  export type AsObject = {
    pairIndex: number,
  }
}

export class PickBanRequest extends jspb.Message {
  getCreature(): number;
  setCreature(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): PickBanRequest.AsObject;
  static toObject(includeInstance: boolean, msg: PickBanRequest): PickBanRequest.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: PickBanRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): PickBanRequest;
  static deserializeBinaryFromReader(message: PickBanRequest, reader: jspb.BinaryReader): PickBanRequest;
}

export namespace PickBanRequest {
  export type AsObject = {
    creature: number,
  }
}

export class ArtifactRequest extends jspb.Message {
  getArtifact(): number;
  setArtifact(value: number): void;

  getLevel(): number;
  setLevel(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ArtifactRequest.AsObject;
  static toObject(includeInstance: boolean, msg: ArtifactRequest): ArtifactRequest.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: ArtifactRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ArtifactRequest;
  static deserializeBinaryFromReader(message: ArtifactRequest, reader: jspb.BinaryReader): ArtifactRequest;
}

export namespace ArtifactRequest {
  export type AsObject = {
    artifact: number,
    level: number,
  }
}

export class RevealRequest extends jspb.Message {
  getCreatureIndex(): number;
  setCreatureIndex(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RevealRequest.AsObject;
  static toObject(includeInstance: boolean, msg: RevealRequest): RevealRequest.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: RevealRequest, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RevealRequest;
  static deserializeBinaryFromReader(message: RevealRequest, reader: jspb.BinaryReader): RevealRequest;
}

export namespace RevealRequest {
  export type AsObject = {
    creatureIndex: number,
  }
}

