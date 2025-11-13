/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */
import type { FactionType } from "../generated/protobuf/v1/types_gen";
import { PBTypes } from "../generated/protobuf/v1/types";

export const AllFactions = [
    PBTypes.FactionVals.NO_FACTION,
    PBTypes.FactionVals.CHAOS,
    PBTypes.FactionVals.MIGHT,
    PBTypes.FactionVals.NATURE,
    PBTypes.FactionVals.LIFE,
    PBTypes.FactionVals.DEATH,
    PBTypes.FactionVals.ORDER,
];

export const ToFactionName: { [factionTypeValue: number]: string } = {
    [PBTypes.FactionVals.NO_FACTION]: "",
    [PBTypes.FactionVals.CHAOS]: "Chaos",
    [PBTypes.FactionVals.MIGHT]: "Might",
    [PBTypes.FactionVals.NATURE]: "Nature",
    [PBTypes.FactionVals.LIFE]: "Life",
    [PBTypes.FactionVals.DEATH]: "Death",
    [PBTypes.FactionVals.ORDER]: "Order",
};

export const ToFactionType: { [factionTypeValue: string]: FactionType } = {
    "": PBTypes.FactionVals.NO_FACTION,
    NO_FACTION: PBTypes.FactionVals.NO_FACTION,
    Chaos: PBTypes.FactionVals.CHAOS,
    Might: PBTypes.FactionVals.MIGHT,
    Nature: PBTypes.FactionVals.NATURE,
    Life: PBTypes.FactionVals.LIFE,
    Death: PBTypes.FactionVals.DEATH,
    Order: PBTypes.FactionVals.ORDER,
};
