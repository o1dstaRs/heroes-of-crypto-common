// package: public
// file: pick_phase_action.proto

import * as jspb from "google-protobuf";

export class PickPhaseAction extends jspb.Message {
  getId(): string;
  setId(value: string): void;

  getConfirmed(): boolean;
  setConfirmed(value: boolean): void;

  getInitTime(): number;
  setInitTime(value: number): void;

  getAbandoned(): boolean;
  setAbandoned(value: boolean): void;

  getTeam(): number;
  setTeam(value: number): void;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): PickPhaseAction.AsObject;
  static toObject(includeInstance: boolean, msg: PickPhaseAction): PickPhaseAction.AsObject;
  static extensions: {[key: number]: jspb.ExtensionFieldInfo<jspb.Message>};
  static extensionsBinary: {[key: number]: jspb.ExtensionFieldBinaryInfo<jspb.Message>};
  static serializeBinaryToWriter(message: PickPhaseAction, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): PickPhaseAction;
  static deserializeBinaryFromReader(message: PickPhaseAction, reader: jspb.BinaryReader): PickPhaseAction;
}

export namespace PickPhaseAction {
  export type AsObject = {
    id: string,
    confirmed: boolean,
    initTime: number,
    abandoned: boolean,
    team: number,
  }
}

